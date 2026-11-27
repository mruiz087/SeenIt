const express = require('express');
const fs = require('fs');
const path = require('path');

try {
    const envPath = path.join(__dirname, '.env');
    if (typeof process.loadEnvFile === 'function' && fs.existsSync(envPath)) {
        process.loadEnvFile(envPath);
    }
} catch (err) {
    console.warn('[SeenIt] No se pudo cargar .env:', err.message);
}

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const ROOT_DIR = __dirname;
const TMDB_API_BASE = 'https://api.themoviedb.org/3';

const ALLOWED_TMDB_PATH_PATTERNS = [
    /^\/search\/(multi|movie|tv)$/,
    /^\/trending\/(all|movie|tv)\/(day|week)$/,
    /^\/movie\/\d+$/,
    /^\/movie\/\d+\/videos$/,
    /^\/movie\/\d+\/release_dates$/,
    /^\/movie\/\d+\/watch\/providers$/,
    /^\/collection\/\d+$/,
    /^\/tv\/\d+$/,
    /^\/tv\/\d+\/videos$/,
    /^\/tv\/\d+\/season\/\d+$/,
    /^\/tv\/\d+\/watch\/providers$/,
    /^\/person\/\d+$/,
    /^\/person\/\d+\/combined_credits$/,
    /^\/find\/[A-Za-z0-9._-]+$/,
    /^\/watch\/providers\/(movie|tv)$/,
];

const ALLOWED_TMDB_QUERY_PARAMS = new Set([
    'query',
    'page',
    'include_adult',
    'append_to_response',
    'external_source',
    'language',
    'include_video_language',
    'region',
]);

const ALLOWED_APPEND_TOKEN_RE = /^(credits|recommendations|videos|watch\/providers|release_dates|season\/\d{1,3})$/;
const TMDB_CACHE_MAX_ENTRIES = 600;
const TMDB_UPSTREAM_TIMEOUT_MS = 12000;
const tmdbResponseCache = new Map();
const tmdbInflightRequests = new Map();

function sanitizeAppendToResponse(rawValue) {
    if (!rawValue) return '';
    const tokens = String(rawValue)
        .split(',')
        .map(t => t.trim())
        .filter(Boolean);
    if (!tokens.length || tokens.length > 25) return null;
    for (const token of tokens) {
        if (!ALLOWED_APPEND_TOKEN_RE.test(token)) return null;
    }
    return [...new Set(tokens)].join(',');
}

function getTmdbCacheTtlMs(endpoint, status, hasSeasonAppend) {
    if (status === 404) return 5 * 60 * 1000;
    if (status !== 200) return 0;
    if (endpoint.startsWith('/search/')) return 5 * 60 * 1000;
    if (endpoint.includes('/season/') || hasSeasonAppend) return 30 * 60 * 1000;
    return 15 * 60 * 1000;
}

function getCachedTmdbResponse(cacheKey) {
    const entry = tmdbResponseCache.get(cacheKey);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        tmdbResponseCache.delete(cacheKey);
        return null;
    }
    tmdbResponseCache.delete(cacheKey);
    tmdbResponseCache.set(cacheKey, entry);
    return entry;
}

function setCachedTmdbResponse(cacheKey, entry) {
    if (tmdbResponseCache.has(cacheKey)) {
        tmdbResponseCache.delete(cacheKey);
    }
    tmdbResponseCache.set(cacheKey, entry);
    while (tmdbResponseCache.size > TMDB_CACHE_MAX_ENTRIES) {
        const oldestKey = tmdbResponseCache.keys().next().value;
        if (oldestKey === undefined) break;
        tmdbResponseCache.delete(oldestKey);
    }
}

function readLocalConfigFallbacks() {
    const localConfigPath = path.join(ROOT_DIR, 'config.js');
    if (!fs.existsSync(localConfigPath)) return {};
    try {
        const content = fs.readFileSync(localConfigPath, 'utf8');
        const extract = (name) => {
            const match = content.match(new RegExp(`const\\s+${name}\\s*=\\s*(['"\`])([^'"\`]*)\\1`));
            return match ? match[2].trim() : '';
        };
        return {
            tmdbKey: extract('CONFIG_TMDB_API_KEY'),
            googleClientId: extract('CONFIG_GOOGLE_CLIENT_ID'),
            adsClientId: extract('CONFIG_ADS_CLIENT_ID'),
            adsSlotId: extract('CONFIG_ADS_SLOT_ID'),
            amazonAffiliateTag: extract('CONFIG_AFFILIATE_AMAZON_TAG'),
        };
    } catch (_) {
        return {};
    }
}

function getServerConfig() {
    const fallback = readLocalConfigFallbacks();
    const rawTmdb = String(process.env.TMDB_API_KEY || fallback.tmdbKey || '').trim();
    const rawGoogleClientId = String(process.env.GOOGLE_CLIENT_ID || fallback.googleClientId || '').trim();
    const rawAdsClientId = String(process.env.ADS_CLIENT_ID || fallback.adsClientId || '').trim();
    const rawAdsSlotId = String(process.env.ADS_SLOT_ID || fallback.adsSlotId || '').trim();
    const rawAmazonTag = String(process.env.AFFILIATE_AMAZON_TAG || fallback.amazonAffiliateTag || '').trim();

    const tmdbKey = rawTmdb && !rawTmdb.includes('tu_api_key') ? rawTmdb : '';
    const googleClientId = rawGoogleClientId && !rawGoogleClientId.includes('tu_client_id') ? rawGoogleClientId : '';
    const adsClientId = rawAdsClientId && !rawAdsClientId.includes('pub-XXXX') ? rawAdsClientId : '';
    const adsSlotId = rawAdsSlotId;
    const amazonAffiliateTag = rawAmazonTag;

    return { tmdbKey, googleClientId, adsClientId, adsSlotId, amazonAffiliateTag };
}

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');

    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use((req, res, next) => {
    const reqPath = req.path.toLowerCase();
    if (
        reqPath === '/server.js' ||
        reqPath === '/package.json' ||
        reqPath === '/package-lock.json' ||
        reqPath === '/config.example.js' ||
        reqPath.startsWith('/.env') ||
        reqPath.startsWith('/node_modules')
    ) {
        return res.status(404).end();
    }
    next();
});

app.get('/config.js', (req, res) => {
    const { tmdbKey, googleClientId, adsClientId, adsSlotId, amazonAffiliateTag } = getServerConfig();
    res.type('application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    const payload = [
        'const CONFIG_TMDB_PROXY = true;',
        `const CONFIG_TMDB_CONFIGURED = ${JSON.stringify(Boolean(tmdbKey))};`,
        `const CONFIG_GOOGLE_CLIENT_ID = ${JSON.stringify(googleClientId)};`,
        `const CONFIG_ADS_CLIENT_ID = ${JSON.stringify(adsClientId)};`,
        `const CONFIG_ADS_SLOT_ID = ${JSON.stringify(adsSlotId)};`,
        `const CONFIG_AFFILIATE_AMAZON_TAG = ${JSON.stringify(amazonAffiliateTag)};`,
    ].join('\n');
    return res.send(payload);
});

app.get(/^\/api\/tmdb(\/.*)$/, async (req, res) => {
    const { tmdbKey } = getServerConfig();
    if (!tmdbKey) {
        return res.status(503).json({ error: 'CONFIG_TMDB_MISSING' });
    }

    const endpoint = req.params[0] || '';
    const isAllowed = ALLOWED_TMDB_PATH_PATTERNS.some((pattern) => pattern.test(endpoint));
    if (!isAllowed) {
        return res.status(400).json({ error: 'Endpoint TMDB no permitido' });
    }

    try {
        const cleanParams = new URLSearchParams();
        let hasSeasonAppend = false;

        for (const [key, value] of Object.entries(req.query || {})) {
            if (!ALLOWED_TMDB_QUERY_PARAMS.has(key)) continue;
            const rawVal = Array.isArray(value) ? value[0] : value;
            if (rawVal == null || rawVal === '') continue;

            if (key === 'append_to_response') {
                const sanitized = sanitizeAppendToResponse(rawVal);
                if (sanitized === null) {
                    return res.status(400).json({ error: 'append_to_response no permitido' });
                }
                if (sanitized) {
                    cleanParams.set(key, sanitized);
                    hasSeasonAppend = sanitized.includes('season/');
                }
            } else {
                cleanParams.set(key, String(rawVal));
            }
        }
        if (!cleanParams.has('language')) {
            cleanParams.set('language', 'es-ES');
        }
        cleanParams.sort();

        const cacheKey = `${endpoint}?${cleanParams.toString()}`;
        const cached = getCachedTmdbResponse(cacheKey);
        if (cached) {
            return res.status(cached.status).type(cached.contentType).send(cached.bodyText);
        }

        let inflight = tmdbInflightRequests.get(cacheKey);
        if (!inflight) {
            const upstreamUrl = new URL(`${TMDB_API_BASE}${endpoint}`);
            for (const [k, v] of cleanParams.entries()) {
                upstreamUrl.searchParams.set(k, v);
            }
            upstreamUrl.searchParams.set('api_key', tmdbKey);

            inflight = (async () => {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), TMDB_UPSTREAM_TIMEOUT_MS);
                try {
                    const upstreamRes = await fetch(upstreamUrl, { signal: controller.signal });
                    const contentType = upstreamRes.headers.get('content-type') || 'application/json; charset=utf-8';
                    const retryAfter = upstreamRes.headers.get('retry-after');
                    const bodyText = await upstreamRes.text();
                    const result = {
                        status: upstreamRes.status,
                        contentType,
                        retryAfter,
                        bodyText,
                    };
                    const ttlMs = getTmdbCacheTtlMs(endpoint, upstreamRes.status, hasSeasonAppend);
                    if (ttlMs > 0) {
                        setCachedTmdbResponse(cacheKey, {
                            status: upstreamRes.status,
                            contentType,
                            bodyText,
                            expiresAt: Date.now() + ttlMs,
                        });
                    }
                    return result;
                } finally {
                    clearTimeout(timer);
                }
            })().finally(() => {
                tmdbInflightRequests.delete(cacheKey);
            });
            tmdbInflightRequests.set(cacheKey, inflight);
        }

        const result = await inflight;
        if (result.retryAfter) {
            res.setHeader('Retry-After', result.retryAfter);
        }
        return res.status(result.status).type(result.contentType).send(result.bodyText);
    } catch (error) {
        console.error('[SeenIt] Error proxy TMDB:', error?.message || error);
        const status = error?.name === 'AbortError' ? 504 : 502;
        return res.status(status).json({ error: 'Error consultando TMDB' });
    }
});

const ALLOWED_TMDB_IMAGE_SIZES = new Set(['w500', 'w780', 'w1280', 'original']);
const SAFE_TMDB_IMAGE_PATH_RE = /^\/[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$/i;

app.get('/api/tmdb-image', async (req, res) => {
    const rawPath = String(req.query?.path || '').trim();
    const rawSize = String(req.query?.size || 'w1280').trim();
    const size = ALLOWED_TMDB_IMAGE_SIZES.has(rawSize) ? rawSize : 'w1280';

    if (!SAFE_TMDB_IMAGE_PATH_RE.test(rawPath)) {
        return res.status(400).json({ error: 'Ruta de imagen TMDB no válida' });
    }

    const upstreamUrl = `https://image.tmdb.org/t/p/${size}${rawPath}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
        const upstreamRes = await fetch(upstreamUrl, { signal: controller.signal });
        if (!upstreamRes.ok) {
            return res.status(upstreamRes.status).end();
        }
        const contentType = upstreamRes.headers.get('content-type') || 'image/jpeg';
        if (!contentType.startsWith('image/')) {
            return res.status(502).json({ error: 'Tipo de contenido no válido' });
        }
        const buffer = Buffer.from(await upstreamRes.arrayBuffer());
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.send(buffer);
    } catch (error) {
        const status = error?.name === 'AbortError' ? 504 : 502;
        return res.status(status).json({ error: 'No se pudo cargar la imagen' });
    } finally {
        clearTimeout(timer);
    }
});

app.use(express.static(ROOT_DIR, {
    dotfiles: 'ignore',
    index: 'index.html',
}));

if (require.main === module) {
    app.listen(PORT, HOST, () => {
        console.log(`[SeenIt] Servidor iniciado en http://${HOST}:${PORT}`);
    });
}

module.exports = app;

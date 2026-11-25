/**
 * TMDB Service - The Movie Database API Integration
 * 
 * Este servicio maneja todas las llamadas a la API de TMDB
 * para buscar películas, series y obtener detalles.
 * 
 * Requiere:
 * - API Key de TMDB (gratuita en https://www.themoviedb.org/settings/api)
 * 
 * Documentación: https://developers.themoviedb.org/3
 */

// ============================================
// CONFIGURACIÓN
// ============================================

function isTmdbProxyEnabled() {
    return typeof CONFIG_TMDB_PROXY !== 'undefined' && Boolean(CONFIG_TMDB_PROXY);
}

function getTmdbApiKey() {
    const key = typeof CONFIG_TMDB_API_KEY !== 'undefined' ? String(CONFIG_TMDB_API_KEY).trim() : '';
    if (!key || key.includes('tu_api_key')) return '';
    return key;
}

function hasTmdbConfig() {
    if (isTmdbProxyEnabled()) {
        return typeof CONFIG_TMDB_CONFIGURED === 'undefined' ? true : Boolean(CONFIG_TMDB_CONFIGURED);
    }
    return Boolean(getTmdbApiKey());
}

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p';

// ============================================
// ESTADO GLOBAL Y CACHÉS
// ============================================

let searchTimeout = null;
let currentSearchAbortController = null;

const seasonDetailsCache = new Map();
const seasonInflight = new Map();
const findExternalCache = new Map();
const tvMetaCache = new Map();
const movieDetailsCache = new Map();
const movieFilterMetaCache = new Map();
const tvDetailsCache = new Map();
const watchProvidersCache = new Map();
const videosCache = new Map();
const releaseDatesCache = new Map();
const personDetailsCache = new Map();
const personCreditsCache = new Map();
const searchMultiCache = new Map();
const trendingCache = new Map();
const inflightTmdbFetch = new Map();

const SEASON_CACHE_STORAGE_KEY = 'seenit_tmdb_seasons_v1';
const SEASON_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_DETAIL_TTL_MS = 15 * 60 * 1000;
const SESSION_SEARCH_TTL_MS = 3 * 60 * 1000;
const SESSION_TRENDING_TTL_MS = 15 * 60 * 1000;
const TMDB_IDB_NAME = 'seenit_tmdb_cache_db';
const TMDB_IDB_LEGACY_STORE = 'seasons';
const TMDB_IDB_ITEM_STORE = 'season_items';
const TMDB_IDB_VERSION = 2;
const TMDB_IDB_MAX_ITEMS = 1500;
const TMDB_MAX_CONCURRENT_REQUESTS = 6;
const TMDB_APPEND_SEASON_CHUNK_SIZE = 20;

let tmdbIdbPromise = null;
let seasonPruneScheduled = false;
let activeTmdbRequests = 0;
const tmdbRequestQueue = [];

function getTimedCache(map, key, ttlMs) {
    const entry = map.get(key);
    if (!entry) return null;
    if ((Date.now() - entry.savedAt) > ttlMs) {
        map.delete(key);
        return null;
    }
    return entry.value;
}

function setTimedCache(map, key, value, maxSize = 200) {
    if (map.has(key)) map.delete(key);
    map.set(key, { savedAt: Date.now(), value });
    while (map.size > maxSize) {
        const oldestKey = map.keys().next().value;
        if (oldestKey === undefined) break;
        map.delete(oldestKey);
    }
}

function enqueueTmdbRequest(task) {
    return new Promise((resolve, reject) => {
        const run = async () => {
            activeTmdbRequests += 1;
            try {
                resolve(await task());
            } catch (err) {
                reject(err);
            } finally {
                activeTmdbRequests -= 1;
                const next = tmdbRequestQueue.shift();
                if (next) next();
            }
        };

        if (activeTmdbRequests < TMDB_MAX_CONCURRENT_REQUESTS) {
            run();
        } else {
            tmdbRequestQueue.push(run);
        }
    });
}

function sleepMs(ms, signal = null) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

function openTmdbIdb() {
    if (tmdbIdbPromise) return tmdbIdbPromise;
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);
    tmdbIdbPromise = new Promise((resolve) => {
        try {
            const req = indexedDB.open(TMDB_IDB_NAME, TMDB_IDB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(TMDB_IDB_LEGACY_STORE)) {
                    db.createObjectStore(TMDB_IDB_LEGACY_STORE);
                }
                if (!db.objectStoreNames.contains(TMDB_IDB_ITEM_STORE)) {
                    db.createObjectStore(TMDB_IDB_ITEM_STORE);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        } catch (_) {
            resolve(null);
        }
    });
    return tmdbIdbPromise;
}

function slimSeasonPayload(details) {
    return {
        episodes: (details?.episodes || []).map(ep => ({
            episode_number: ep.episode_number,
            name: ep.name,
            overview: ep.overview || '',
            air_date: ep.air_date || null,
            still_path: ep.still_path || null,
        })),
    };
}

function schedulePruneSeasonItemsIdb() {
    if (seasonPruneScheduled) return;
    seasonPruneScheduled = true;
    setTimeout(async () => {
        seasonPruneScheduled = false;
        try {
            const db = await openTmdbIdb();
            if (!db || !db.objectStoreNames.contains(TMDB_IDB_ITEM_STORE)) return;
            const records = await new Promise((resolve) => {
                try {
                    const tx = db.transaction(TMDB_IDB_ITEM_STORE, 'readonly');
                    const store = tx.objectStore(TMDB_IDB_ITEM_STORE);
                    const keysReq = store.getAllKeys();
                    const valsReq = store.getAll();
                    tx.oncomplete = () => {
                        const keys = keysReq.result || [];
                        const vals = valsReq.result || [];
                        resolve(keys.map((key, idx) => ({ key, savedAt: Number(vals[idx]?.savedAt) || 0 })));
                    };
                    tx.onerror = () => resolve([]);
                } catch (_) {
                    resolve([]);
                }
            });
            const now = Date.now();
            const expiredKeys = records
                .filter(r => !r.savedAt || (now - r.savedAt) > SEASON_CACHE_TTL_MS)
                .map(r => r.key);
            const fresh = records
                .filter(r => r.savedAt && (now - r.savedAt) <= SEASON_CACHE_TTL_MS)
                .sort((a, b) => a.savedAt - b.savedAt);
            const overflowCount = Math.max(0, fresh.length - TMDB_IDB_MAX_ITEMS);
            const keysToDelete = [
                ...expiredKeys,
                ...fresh.slice(0, overflowCount).map(r => r.key),
            ];
            if (!keysToDelete.length) return;
            const tx = db.transaction(TMDB_IDB_ITEM_STORE, 'readwrite');
            const store = tx.objectStore(TMDB_IDB_ITEM_STORE);
            keysToDelete.forEach(k => store.delete(k));
        } catch (_) {
            /* ignore */
        }
    }, 5000);
}

async function putSeasonsToIdb(entries) {
    if (!entries.length) return;
    try {
        const db = await openTmdbIdb();
        if (!db || !db.objectStoreNames.contains(TMDB_IDB_ITEM_STORE)) return;
        const now = Date.now();
        await new Promise((resolve) => {
            try {
                const tx = db.transaction(TMDB_IDB_ITEM_STORE, 'readwrite');
                const store = tx.objectStore(TMDB_IDB_ITEM_STORE);
                for (const { key, data } of entries) {
                    if (data?.notFound) continue;
                    store.put({ savedAt: now, data: slimSeasonPayload(data) }, key);
                }
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
            } catch (_) {
                resolve();
            }
        });
        schedulePruneSeasonItemsIdb();
    } catch (error) {
        console.warn('[TMDB] No se pudo guardar caché de temporadas:', error);
    }
}

async function loadSeasonCacheFromStorage() {
    // Liberar localStorage legado para evitar QuotaExceededError en la biblioteca del usuario
    try {
        localStorage.removeItem(SEASON_CACHE_STORAGE_KEY);
    } catch (_) { /* ignore */ }

    try {
        const db = await openTmdbIdb();
        if (!db) return;

        const now = Date.now();
        if (db.objectStoreNames.contains(TMDB_IDB_ITEM_STORE)) {
            const loaded = await new Promise((resolve) => {
                try {
                    const tx = db.transaction(TMDB_IDB_ITEM_STORE, 'readonly');
                    const store = tx.objectStore(TMDB_IDB_ITEM_STORE);
                    const keysReq = store.getAllKeys();
                    const valsReq = store.getAll();
                    tx.oncomplete = () => resolve({ keys: keysReq.result || [], vals: valsReq.result || [] });
                    tx.onerror = () => resolve({ keys: [], vals: [] });
                } catch (_) {
                    resolve({ keys: [], vals: [] });
                }
            });
            for (let i = 0; i < loaded.keys.length; i += 1) {
                const key = String(loaded.keys[i]);
                const entry = loaded.vals[i];
                if (entry?.savedAt && (now - Number(entry.savedAt)) <= SEASON_CACHE_TTL_MS && Array.isArray(entry.data?.episodes)) {
                    if (!seasonDetailsCache.has(key)) {
                        seasonDetailsCache.set(key, entry.data);
                    }
                }
            }
        }

        // Migrar caché monolítica v1 si aún existe
        if (db.objectStoreNames.contains(TMDB_IDB_LEGACY_STORE)) {
            const legacy = await new Promise((resolve) => {
                try {
                    const tx = db.transaction(TMDB_IDB_LEGACY_STORE, 'readonly');
                    const req = tx.objectStore(TMDB_IDB_LEGACY_STORE).get(SEASON_CACHE_STORAGE_KEY);
                    req.onsuccess = () => resolve(req.result || null);
                    req.onerror = () => resolve(null);
                } catch (_) {
                    resolve(null);
                }
            });
            if (legacy?.savedAt && (now - Number(legacy.savedAt)) <= SEASON_CACHE_TTL_MS && legacy.entries) {
                const toMigrate = [];
                for (const [key, value] of Object.entries(legacy.entries)) {
                    if (value && Array.isArray(value.episodes) && !seasonDetailsCache.has(key)) {
                        seasonDetailsCache.set(key, value);
                        toMigrate.push({ key, data: value });
                    }
                }
                if (toMigrate.length) {
                    void putSeasonsToIdb(toMigrate);
                }
            }
            if (legacy) {
                try {
                    const tx = db.transaction(TMDB_IDB_LEGACY_STORE, 'readwrite');
                    tx.objectStore(TMDB_IDB_LEGACY_STORE).delete(SEASON_CACHE_STORAGE_KEY);
                } catch (_) { /* ignore */ }
            }
        }

        if (seasonDetailsCache.size) {
            console.log(`[TMDB] Caché de temporadas restaurada (${seasonDetailsCache.size})`);
        }
    } catch (error) {
        console.warn('[TMDB] No se pudo leer caché de temporadas:', error);
    }
}

const seasonCacheReadyPromise = loadSeasonCacheFromStorage();

// ============================================
// FUNCIONES AUXILIARES
// ============================================

/**
 * Construye la URL de la imagen
 * @param {string} path - Ruta de la imagen (ej: '/abc123.jpg')
 * @param {string} size - Tamaño de la imagen (w92, w154, w185, w342, w500, w780, original)
 * @returns {string} URL completa de la imagen
 */
function getImageUrl(path, size = 'w500') {
    if (!path) return null;
    return `${TMDB_IMAGE_BASE_URL}/${size}${path}`;
}

/**
 * Realiza una petición a la API de TMDB con control de concurrencia,
 * deduplicación en curso y reintento automático en 429/errores transitorios.
 * @param {string} endpoint - Endpoint de la API
 * @param {Object} params - Parámetros de la query
 * @param {Object} [options] - Opciones ({ signal })
 * @returns {Promise<Object>} Respuesta de la API
 */
async function fetchTMDB(endpoint, params = {}, options = {}) {
    if (!hasTmdbConfig()) {
        throw new Error('CONFIG_TMDB_MISSING');
    }

    const useProxy = isTmdbProxyEnabled();
    const url = useProxy
        ? new URL(`/api/tmdb${endpoint}`, window.location.origin)
        : new URL(`${TMDB_BASE_URL}${endpoint}`);

    const cleanEntries = Object.entries(params)
        .filter(([, value]) => value !== undefined && value !== null)
        .sort(([a], [b]) => a.localeCompare(b));

    if (!useProxy) {
        url.searchParams.append('api_key', getTmdbApiKey());
    }
    if (!Object.prototype.hasOwnProperty.call(params, 'language')) {
        url.searchParams.append('language', 'es-ES');
    }
    cleanEntries.forEach(([key, value]) => {
        url.searchParams.append(key, value);
    });

    const signal = options?.signal || null;
    const inflightKey = !signal ? `${endpoint}?${cleanEntries.map(([k, v]) => `${k}=${v}`).join('&')}` : null;
    if (inflightKey && inflightTmdbFetch.has(inflightKey)) {
        return inflightTmdbFetch.get(inflightKey);
    }

    const exec = async () => {
        const maxAttempts = 3;
        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }
            const response = await enqueueTmdbRequest(() => fetch(url, signal ? { signal } : undefined));

            if (response.ok) {
                return await response.json();
            }

            const status = response.status;
            const retryable = status === 429 || status === 502 || status === 503 || status === 504;
            if (retryable && attempt < maxAttempts - 1) {
                const retryHeader = Number(response.headers.get('retry-after'));
                const backoffMs = Number.isFinite(retryHeader) && retryHeader > 0
                    ? Math.min(4000, retryHeader * 1000)
                    : Math.min(3000, 350 * (2 ** attempt));
                await sleepMs(backoffMs, signal);
                continue;
            }

            const err = new Error(`Error TMDB: ${status} ${response.statusText}`);
            err.status = status;
            throw err;
        }
    };

    const promise = exec().catch((error) => {
        if (error?.name === 'AbortError') {
            throw error;
        }
        if (error?.status === 404) {
            console.warn('[TMDB] Recurso no encontrado (404):', endpoint);
        } else {
            console.error('[TMDB] Error en petición:', error);
        }
        throw error;
    }).finally(() => {
        if (inflightKey) {
            inflightTmdbFetch.delete(inflightKey);
        }
    });

    if (inflightKey) {
        inflightTmdbFetch.set(inflightKey, promise);
    }
    return promise;
}

/**
 * Resuelve un ID externo (imdb_id / tvdb_id) a IDs TMDB.
 * @param {string|number} externalId
 * @param {'imdb_id'|'tvdb_id'} externalSource
 * @returns {Promise<{movieId:number|null, tvId:number|null, raw:Object}>}
 */
async function findByExternalId(externalId, externalSource) {
    const key = `${externalSource}:${externalId}`;
    if (findExternalCache.has(key)) {
        return findExternalCache.get(key);
    }

    const raw = await fetchTMDB(`/find/${encodeURIComponent(String(externalId))}`, {
        external_source: externalSource,
    });

    const result = {
        movieId: raw.movie_results?.[0]?.id || null,
        tvId: raw.tv_results?.[0]?.id || null,
        raw,
    };
    findExternalCache.set(key, result);
    return result;
}

/**
 * Fallback por título + año (menos fiable que find externo).
 */
async function findMovieByTitleYear(title, year) {
    const response = await searchMovies(title, 1);
    const results = response.results || [];
    const yearStr = year ? String(year) : '';
    const exact = results.find(item => {
        const releaseYear = (item.release_date || '').slice(0, 4);
        const titleMatch = (item.title || '').toLowerCase() === String(title || '').toLowerCase()
            || (item.original_title || '').toLowerCase() === String(title || '').toLowerCase();
        return titleMatch && (!yearStr || releaseYear === yearStr);
    });
    if (exact) return exact.id;
    if (yearStr) {
        const byYear = results.find(item => (item.release_date || '').slice(0, 4) === yearStr);
        if (byYear) return byYear.id;
    }
    return results[0]?.id || null;
}

async function findTVByTitleYear(title, year) {
    const response = await searchTV(title, 1);
    const results = response.results || [];
    const yearStr = year ? String(year) : '';
    const exact = results.find(item => {
        const airYear = (item.first_air_date || '').slice(0, 4);
        const titleMatch = (item.name || '').toLowerCase() === String(title || '').toLowerCase()
            || (item.original_name || '').toLowerCase() === String(title || '').toLowerCase();
        return titleMatch && (!yearStr || airYear === yearStr);
    });
    if (exact) return exact.id;
    if (yearStr) {
        const byYear = results.find(item => (item.first_air_date || '').slice(0, 4) === yearStr);
        if (byYear) return byYear.id;
    }
    return results[0]?.id || null;
}

// ============================================
// BÚSQUEDA
// ============================================

/**
 * Busca películas y series
 * @param {string} query - Término de búsqueda
 * @param {number} page - Página de resultados (default: 1)
 * @param {Object} [options] - Opciones ({ signal })
 * @returns {Promise<Object>} Resultados con películas y series
 */
async function searchMulti(query, page = 1, options = {}) {
    const cacheKey = `${String(query || '').trim().toLowerCase()}|p=${page}`;
    const cached = getTimedCache(searchMultiCache, cacheKey, SESSION_SEARCH_TTL_MS);
    if (cached) return cached;

    try {
        const response = await fetchTMDB('/search/multi', {
            query: query,
            page: page,
            include_adult: false,
        }, options);

        // Filtrar solo películas y series
        const results = (response.results || []).filter(item =>
            item.media_type === 'movie' || item.media_type === 'tv',
        );

        const normalized = {
            ...response,
            results: results,
            total_results: results.length,
        };
        setTimedCache(searchMultiCache, cacheKey, normalized, 100);
        return normalized;
    } catch (error) {
        if (error?.name !== 'AbortError') {
            console.error('[TMDB] Error en búsqueda:', error);
        }
        throw error;
    }
}

/**
 * Busca solo películas
 * @param {string} query - Término de búsqueda
 * @param {number} page - Página de resultados (default: 1)
 * @returns {Promise<Object>} Resultados de películas
 */
async function searchMovies(query, page = 1) {
    try {
        return await fetchTMDB('/search/movie', {
            query: query,
            page: page,
            include_adult: false,
        });
    } catch (error) {
        console.error('[TMDB] Error buscando películas:', error);
        throw error;
    }
}

/**
 * Busca solo series
 * @param {string} query - Término de búsqueda
 * @param {number} page - Página de resultados (default: 1)
 * @returns {Promise<Object>} Resultados de series
 */
async function searchTV(query, page = 1) {
    try {
        return await fetchTMDB('/search/tv', {
            query: query,
            page: page,
            include_adult: false,
        });
    } catch (error) {
        console.error('[TMDB] Error buscando series:', error);
        throw error;
    }
}

// ============================================
// DETALLES
// ============================================

function getPreferredProviderCountryCode() {
    try {
        const raw = typeof window.getPreferredProviderCountry === 'function'
            ? window.getPreferredProviderCountry()
            : 'ES';
        const normalized = String(raw || 'ES').trim().toUpperCase();
        return normalized || 'ES';
    } catch (_) {
        return 'ES';
    }
}

function extractWatchProvidersFromResponse(response, countryCode = getPreferredProviderCountryCode()) {
    const countries = response?.results || {};
    const target = String(countryCode || 'ES').trim().toUpperCase();
    const countryKey = Object.keys(countries).find(key => key.toUpperCase() === target);
    const countryData = countryKey ? countries[countryKey] : {};

    const rawProviders = [
        ...(countryData.flatrate || []),
        ...(countryData.rent || []),
        ...(countryData.buy || []),
    ];

    const seen = new Set();
    const deduped = [];
    for (const provider of rawProviders) {
        const key = provider?.provider_id != null
            ? `id:${provider.provider_id}`
            : `name:${String(provider?.provider_name || '').trim().toLowerCase()}`;
        if (!provider?.provider_name || seen.has(key)) continue;
        seen.add(key);
        deduped.push({
            provider_id: provider.provider_id ?? null,
            provider_name: provider.provider_name,
            logo_path: provider.logo_path || null,
        });
    }
    return deduped;
}

/**
 * Obtiene detalles de una película (incluye créditos, recomendaciones y plataformas)
 * @param {number} id - ID de TMDB de la película
 * @returns {Promise<Object>} Detalles de la película
 */
async function getMovieDetails(id) {
    const country = getPreferredProviderCountryCode();
    const cacheKey = `${country}:${id}`;
    const cached = getTimedCache(movieDetailsCache, cacheKey, SESSION_DETAIL_TTL_MS);
    if (cached) return cached;

    try {
        const response = await fetchTMDB(`/movie/${id}`, {
            append_to_response: 'credits,recommendations,videos,watch/providers,release_dates',
            include_video_language: 'es,en,null',
        });

        const normalized = normalizeMovieData(response);
        setTimedCache(movieDetailsCache, cacheKey, normalized, 150);
        setTimedCache(movieFilterMetaCache, String(id), {
            id_tmdb: normalized.id_tmdb,
            generos: normalized.generos,
            runtime: normalized.runtime,
        }, 300);
        if (Array.isArray(normalized.watch_providers)) {
            setTimedCache(watchProvidersCache, `${country}:movie:${id}`, normalized.watch_providers, 300);
        }
        if (Array.isArray(normalized.videos)) {
            setTimedCache(videosCache, `movie:${id}`, normalized.videos, 300);
        }
        if (normalized.release_date_country) {
            setTimedCache(releaseDatesCache, `${country}:${id}`, {
                fecha_estreno: normalized.fecha_estreno || null,
                country,
            }, 300);
        }
        return normalized;
    } catch (error) {
        console.error('[TMDB] Error obteniendo detalles de película:', error);
        throw error;
    }
}

/**
 * Meta ligera de película (solo géneros y runtime, sin créditos ni recomendaciones).
 * @param {number} id - ID de TMDB de la película
 * @returns {Promise<{id_tmdb:number, generos:string[], runtime:number|null}>}
 */
async function getMovieFilterMeta(id) {
    const cacheKey = String(id);
    const fromFull = getTimedCache(movieDetailsCache, cacheKey, SESSION_DETAIL_TTL_MS);
    if (fromFull) {
        return {
            id_tmdb: fromFull.id_tmdb,
            generos: fromFull.generos || [],
            runtime: fromFull.runtime || null,
        };
    }
    const cached = getTimedCache(movieFilterMetaCache, cacheKey, SESSION_DETAIL_TTL_MS);
    if (cached) return cached;

    try {
        const response = await fetchTMDB(`/movie/${id}`);
        const meta = {
            id_tmdb: response.id,
            generos: response.genres?.map(g => g.name) || [],
            runtime: Number(response.runtime) || null,
        };
        setTimedCache(movieFilterMetaCache, cacheKey, meta, 300);
        return meta;
    } catch (error) {
        console.error('[TMDB] Error obteniendo meta de película:', error);
        throw error;
    }
}

function slimNextEpisode(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const seasonNum = Number(raw.season_number);
    const epNum = Number(raw.episode_number);
    if (!Number.isFinite(seasonNum) || !Number.isFinite(epNum)) return null;
    return {
        season_number: seasonNum,
        episode_number: epNum,
        air_date: raw.air_date || null,
        name: raw.name || '',
    };
}

/**
 * Obtiene detalles de una serie (incluye créditos, recomendaciones y plataformas)
 * @param {number} id - ID de TMDB de la serie
 * @returns {Promise<Object>} Detalles de la serie con temporadas y episodios
 */
async function getTVDetails(id) {
    const country = getPreferredProviderCountryCode();
    const cacheKey = `${country}:${id}`;
    const cached = getTimedCache(tvDetailsCache, cacheKey, SESSION_DETAIL_TTL_MS);
    if (cached) return cached;

    try {
        const response = await fetchTMDB(`/tv/${id}`, {
            append_to_response: 'credits,recommendations,videos,watch/providers',
            include_video_language: 'es,en,null',
        });

        const normalized = normalizeTVData(response);
        setTimedCache(tvDetailsCache, cacheKey, normalized, 150);
        tvMetaCache.set(String(id), {
            id_tmdb: normalized.id_tmdb,
            status: normalized.status,
            temporadas: normalized.temporadas,
            next_episode_to_air: normalized.next_episode_to_air ?? null,
        });
        if (Array.isArray(normalized.watch_providers)) {
            setTimedCache(watchProvidersCache, `${country}:tv:${id}`, normalized.watch_providers, 300);
        }
        if (Array.isArray(normalized.videos)) {
            setTimedCache(videosCache, `tv:${id}`, normalized.videos, 300);
        }
        return normalized;
    } catch (error) {
        console.error('[TMDB] Error obteniendo detalles de serie:', error);
        throw error;
    }
}

/**
 * Meta ligera de serie (status + temporadas + next_episode_to_air) sin credits/recomendaciones.
 * Usado por timelines para no pagar el coste del detalle completo.
 */
async function getTVShowMeta(id, options = {}) {
    const cacheKey = String(id);
    if (!options.force && tvMetaCache.has(cacheKey)) {
        return tvMetaCache.get(cacheKey);
    }

    try {
        const response = await fetchTMDB(`/tv/${id}`);
        const meta = {
            id_tmdb: response.id,
            status: response.status || 'Unknown',
            next_episode_to_air: slimNextEpisode(response.next_episode_to_air),
            temporadas: (response.seasons || []).map(s => ({
                numero: s.season_number,
                nombre: s.season_number === 0 ? 'Especiales' : (s.name || `Temporada ${s.season_number}`),
                episodio_count: s.episode_count,
                poster: getImageUrl(s.poster_path, 'w342'),
                especial: s.season_number === 0,
            })),
        };
        tvMetaCache.set(cacheKey, meta);
        return meta;
    } catch (error) {
        if (error?.status === 404) {
            console.warn('[TMDB] Serie no encontrada en TMDB (404):', id);
        } else {
            console.error('[TMDB] Error obteniendo meta de serie:', error);
        }
        throw error;
    }
}

async function fetchSingleSeasonFromNetwork(tvId, seasonNumber) {
    const cacheKey = `${tvId}:${seasonNumber}`;
    try {
        const details = await fetchTMDB(`/tv/${tvId}/season/${seasonNumber}`);
        const slim = slimSeasonPayload(details);
        seasonDetailsCache.set(cacheKey, slim);
        void putSeasonsToIdb([{ key: cacheKey, data: slim }]);
        return slim;
    } catch (error) {
        if (error?.status === 404) {
            console.warn(`[TMDB] Temporada no disponible (404): ${tvId} T${seasonNumber}`);
            const empty = { episodes: [], notFound: true };
            seasonDetailsCache.set(cacheKey, empty);
            return empty;
        }
        console.error('[TMDB] Error obteniendo detalles de temporada:', error);
        throw error;
    }
}

/**
 * Obtiene detalles de una temporada específica
 * @param {number} tvId - ID de TMDB de la serie
 * @param {number} seasonNumber - Número de temporada
 * @returns {Promise<Object>} Detalles de la temporada con episodios
 */
async function getSeasonDetails(tvId, seasonNumber) {
    await seasonCacheReadyPromise;
    const cacheKey = `${tvId}:${seasonNumber}`;
    if (seasonDetailsCache.has(cacheKey)) {
        return seasonDetailsCache.get(cacheKey);
    }
    if (seasonInflight.has(cacheKey)) {
        return seasonInflight.get(cacheKey);
    }

    const promise = fetchSingleSeasonFromNetwork(tvId, seasonNumber).finally(() => {
        seasonInflight.delete(cacheKey);
    });
    seasonInflight.set(cacheKey, promise);
    return promise;
}

/**
 * Obtiene múltiples temporadas de una serie agrupándolas en lotes de hasta 20
 * mediante append_to_response=season/X, reduciendo drásticamente el número de peticiones.
 * @param {number} tvId - ID de TMDB de la serie
 * @param {Array<number>} seasonNumbers - Números de temporada
 * @returns {Promise<Map<number, Object>>} Mapa numeroTemporada -> { episodes }
 */
async function getSeasonsBatch(tvId, seasonNumbers = []) {
    await seasonCacheReadyPromise;
    const uniqueNums = [...new Set(
        (seasonNumbers || []).map(Number).filter(n => Number.isFinite(n) && n >= 0),
    )].sort((a, b) => a - b);

    const results = new Map();
    if (!uniqueNums.length) return results;

    const toFetch = [];
    const pendingInflight = [];

    for (const num of uniqueNums) {
        const cacheKey = `${tvId}:${num}`;
        if (seasonDetailsCache.has(cacheKey)) {
            results.set(num, seasonDetailsCache.get(cacheKey));
        } else if (seasonInflight.has(cacheKey)) {
            pendingInflight.push(
                seasonInflight.get(cacheKey).then(data => results.set(num, data)),
            );
        } else {
            toFetch.push(num);
        }
    }

    const chunks = [];
    for (let i = 0; i < toFetch.length; i += TMDB_APPEND_SEASON_CHUNK_SIZE) {
        chunks.push(toFetch.slice(i, i + TMDB_APPEND_SEASON_CHUNK_SIZE));
    }

    const chunkPromises = chunks.map((chunk) => {
        if (chunk.length === 1) {
            const num = chunk[0];
            const cacheKey = `${tvId}:${num}`;
            const p = fetchSingleSeasonFromNetwork(tvId, num).finally(() => {
                seasonInflight.delete(cacheKey);
            });
            seasonInflight.set(cacheKey, p);
            return p.then(data => results.set(num, data));
        }

        const resolvers = new Map();
        chunk.forEach((num) => {
            let resolveFn;
            let rejectFn;
            const p = new Promise((res, rej) => {
                resolveFn = res;
                rejectFn = rej;
            });
            const cacheKey = `${tvId}:${num}`;
            seasonInflight.set(cacheKey, p);
            resolvers.set(num, { resolveFn, rejectFn });
        });

        const batchWork = (async () => {
            try {
                const appendStr = chunk.map(n => `season/${n}`).join(',');
                const response = await fetchTMDB(`/tv/${tvId}`, {
                    append_to_response: appendStr,
                });

                if (response?.id && Array.isArray(response.seasons)) {
                    tvMetaCache.set(String(tvId), {
                        id_tmdb: response.id,
                        status: response.status || 'Unknown',
                        next_episode_to_air: slimNextEpisode(response.next_episode_to_air),
                        temporadas: response.seasons.map(s => ({
                            numero: s.season_number,
                            nombre: s.season_number === 0 ? 'Especiales' : (s.name || `Temporada ${s.season_number}`),
                            episodio_count: s.episode_count,
                            poster: getImageUrl(s.poster_path, 'w342'),
                            especial: s.season_number === 0,
                        })),
                    });
                }

                const idbBatch = [];
                const missingFallback = [];
                for (const num of chunk) {
                    const seasonKey = `season/${num}`;
                    const rawSeason = response?.[seasonKey];
                    const cacheKey = `${tvId}:${num}`;
                    if (rawSeason && Array.isArray(rawSeason.episodes)) {
                        const slim = slimSeasonPayload(rawSeason);
                        seasonDetailsCache.set(cacheKey, slim);
                        idbBatch.push({ key: cacheKey, data: slim });
                        results.set(num, slim);
                        seasonInflight.delete(cacheKey);
                        resolvers.get(num)?.resolveFn(slim);
                    } else {
                        missingFallback.push(num);
                    }
                }

                if (idbBatch.length) {
                    void putSeasonsToIdb(idbBatch);
                }

                if (missingFallback.length) {
                    await Promise.all(missingFallback.map(async (num) => {
                        const cacheKey = `${tvId}:${num}`;
                        try {
                            const data = await fetchSingleSeasonFromNetwork(tvId, num);
                            results.set(num, data);
                            resolvers.get(num)?.resolveFn(data);
                        } catch (err) {
                            resolvers.get(num)?.rejectFn(err);
                        } finally {
                            seasonInflight.delete(cacheKey);
                        }
                    }));
                }
            } catch (batchErr) {
                // Fallback a peticiones individuales si el lote completo falla (p. ej. temporada ausente rompe append)
                await Promise.all(chunk.map(async (num) => {
                    const cacheKey = `${tvId}:${num}`;
                    try {
                        const data = await fetchSingleSeasonFromNetwork(tvId, num);
                        results.set(num, data);
                        resolvers.get(num)?.resolveFn(data);
                    } catch (err) {
                        resolvers.get(num)?.rejectFn(err || batchErr);
                    } finally {
                        seasonInflight.delete(cacheKey);
                    }
                }));
            }
        })();

        return batchWork;
    });

    await Promise.all([...pendingInflight, ...chunkPromises]);
    return results;
}

function clearSeasonDetailsCache(tvId = null) {
    if (tvId == null) {
        seasonDetailsCache.clear();
        seasonInflight.clear();
        tvMetaCache.clear();
        tvDetailsCache.clear();
        try { localStorage.removeItem(SEASON_CACHE_STORAGE_KEY); } catch (_) { /* ignore */ }
        openTmdbIdb().then((db) => {
            if (!db) return;
            try {
                if (db.objectStoreNames.contains(TMDB_IDB_LEGACY_STORE)) {
                    db.transaction(TMDB_IDB_LEGACY_STORE, 'readwrite')
                        .objectStore(TMDB_IDB_LEGACY_STORE)
                        .delete(SEASON_CACHE_STORAGE_KEY);
                }
                if (db.objectStoreNames.contains(TMDB_IDB_ITEM_STORE)) {
                    db.transaction(TMDB_IDB_ITEM_STORE, 'readwrite')
                        .objectStore(TMDB_IDB_ITEM_STORE)
                        .clear();
                }
            } catch (_) { /* ignore */ }
        });
        return;
    }
    const prefix = `${tvId}:`;
    const deletedKeys = [];
    for (const key of [...seasonDetailsCache.keys()]) {
        if (key.startsWith(prefix)) {
            seasonDetailsCache.delete(key);
            deletedKeys.push(key);
        }
    }
    for (const key of [...seasonInflight.keys()]) {
        if (key.startsWith(prefix)) seasonInflight.delete(key);
    }
    tvMetaCache.delete(String(tvId));
    tvDetailsCache.delete(String(tvId));

    openTmdbIdb().then((db) => {
        if (!db || !db.objectStoreNames.contains(TMDB_IDB_ITEM_STORE) || !deletedKeys.length) return;
        try {
            const tx = db.transaction(TMDB_IDB_ITEM_STORE, 'readwrite');
            const store = tx.objectStore(TMDB_IDB_ITEM_STORE);
            deletedKeys.forEach(k => store.delete(k));
        } catch (_) { /* ignore */ }
    });
}

// ============================================
// NORMALIZACIÓN DE DATOS
// ============================================

function extractRegionalReleaseDate(releaseDatesPayload, fallbackDate = null, countryCode = getPreferredProviderCountryCode()) {
    const normalizeDateStr = (val) => {
        const match = String(val || '').match(/^(\d{4}-\d{2}-\d{2})/);
        return match ? match[1] : null;
    };

    const target = String(countryCode || 'ES').trim().toUpperCase();
    const results = Array.isArray(releaseDatesPayload?.results) ? releaseDatesPayload.results : [];
    const countryBlock = results.find(r => String(r?.iso_3166_1 || '').trim().toUpperCase() === target);
    const entries = Array.isArray(countryBlock?.release_dates) ? countryBlock.release_dates : [];

    // Orden de prioridad alineado con TMDB: cines (3), limitada (2), digital (4), TV (6), premiere (1), físico (5)
    const typePriority = [3, 2, 4, 6, 1, 5];
    for (const type of typePriority) {
        const dates = entries
            .filter(entry => Number(entry?.type) === type)
            .map(entry => normalizeDateStr(entry?.release_date))
            .filter(Boolean)
            .sort();
        if (dates.length) {
            return dates[0];
        }
    }

    const anyDates = entries
        .map(entry => normalizeDateStr(entry?.release_date))
        .filter(Boolean)
        .sort();
    if (anyDates.length) {
        return anyDates[0];
    }

    return normalizeDateStr(fallbackDate);
}

/**
 * Normaliza los datos de una película al formato de la app
 * @param {Object} data - Datos crudos de TMDB
 * @returns {Object} Datos normalizados
 */
function normalizeMovieData(data) {
    const country = getPreferredProviderCountryCode();
    const fallbackDate = data.release_date ? String(data.release_date).slice(0, 10) : null;
    const regionalDate = data?.release_dates
        ? extractRegionalReleaseDate(data.release_dates, fallbackDate, country)
        : fallbackDate;

    const normalized = {
        id_tmdb: data.id,
        titulo: data.title,
        titulo_original: data.original_title,
        portada: getImageUrl(data.poster_path),
        backdrop: getImageUrl(data.backdrop_path, 'w780'),
        puntuacion: 0,
        estado: 'pending',
        tipo: 'movie',
        fecha_estreno: regionalDate,
        ...(data?.release_dates ? { release_date_country: country } : {}),
        generos: data.genres?.map(g => g.name) || [],
        overview: data.overview,
        vote_average: data.vote_average,
        runtime: data.runtime,
        credits: {
            cast: (data.credits?.cast || []).slice(0, 8).map(person => ({
                id: person.id,
                name: person.name,
                character: person.character,
                profile_path: getImageUrl(person.profile_path, 'w185'),
            })),
        },
        recommendations: (data.recommendations?.results || []).slice(0, 6).map(item => ({
            id_tmdb: item.id,
            titulo: item.title || item.name,
            portada: getImageUrl(item.poster_path, 'w342'),
            tipo: item.media_type === 'tv' ? 'tv' : 'movie',
        })),
    };
    if (data?.['watch/providers']) {
        normalized.watch_providers = extractWatchProvidersFromResponse(data['watch/providers']);
    }
    if (data?.videos) {
        normalized.videos = extractVideosFromResponse(data.videos);
    }
    return normalized;
}

/**
 * Normaliza los datos de una serie al formato de la app
 * @param {Object} data - Datos crudos de TMDB
 * @returns {Object} Datos normalizados
 */
function normalizeTVData(data) {
    const seasons = data.seasons || [];

    const normalized = {
        id_tmdb: data.id,
        titulo: data.name,
        titulo_original: data.original_name,
        portada: getImageUrl(data.poster_path),
        backdrop: getImageUrl(data.backdrop_path, 'w780'),
        puntuacion: 0,
        estado: 'pending',
        tipo: 'tv',
        fecha_estreno: data.first_air_date,
        generos: data.genres?.map(g => g.name) || [],
        overview: data.overview,
        vote_average: data.vote_average,
        numero_temporadas: data.number_of_seasons,
        episode_run_time: Array.isArray(data.episode_run_time) && data.episode_run_time.length
            ? Math.round(data.episode_run_time.reduce((a, b) => a + b, 0) / data.episode_run_time.length)
            : (data.episode_run_time?.[0] || 45),
        credits: {
            cast: (data.credits?.cast || []).slice(0, 8).map(person => ({
                id: person.id,
                name: person.name,
                character: person.character,
                profile_path: getImageUrl(person.profile_path, 'w185'),
            })),
        },
        recommendations: (data.recommendations?.results || []).slice(0, 6).map(item => ({
            id_tmdb: item.id,
            titulo: item.title || item.name,
            portada: getImageUrl(item.poster_path, 'w342'),
            tipo: item.media_type === 'tv' ? 'tv' : 'movie',
        })),
        temporadas: seasons.map(s => ({
            numero: s.season_number,
            nombre: s.season_number === 0 ? 'Especiales' : (s.name || `Temporada ${s.season_number}`),
            episodio_count: s.episode_count,
            poster: getImageUrl(s.poster_path, 'w342'),
            especial: s.season_number === 0,
        })),
        status: data.status || 'Unknown',
        next_episode_to_air: slimNextEpisode(data.next_episode_to_air),
        capitulos_vistos: [],
    };
    if (data?.['watch/providers']) {
        normalized.watch_providers = extractWatchProvidersFromResponse(data['watch/providers']);
    }
    if (data?.videos) {
        normalized.videos = extractVideosFromResponse(data.videos);
    }
    return normalized;
}

/**
 * Normaliza los resultados de búsqueda
 * @param {Object} item - Item de resultado de TMDB
 * @returns {Object} Datos normalizados
 */
function normalizeSearchResult(item) {
    const baseData = {
        id_tmdb: item.id,
        portada: getImageUrl(item.poster_path, 'w500'),
        backdrop: getImageUrl(item.backdrop_path, 'w780'),
        vote_average: item.vote_average,
        popularity: item.popularity,
        vote_count: item.vote_count,
        overview: item.overview,
    };

    if (item.media_type === 'movie' || (!item.media_type && item.title)) {
        return {
            ...baseData,
            titulo: item.title,
            titulo_original: item.original_title,
            tipo: 'movie',
            fecha_estreno: item.release_date,
        };
    } else if (item.media_type === 'tv' || (!item.media_type && item.name)) {
        return {
            ...baseData,
            titulo: item.name,
            titulo_original: item.original_name,
            tipo: 'tv',
            fecha_estreno: item.first_air_date,
        };
    }

    return baseData;
}

/**
 * Obtiene proveedores de visualización de una serie o película
 * @param {string} type - 'tv' o 'movie'
 * @param {number} id - ID de TMDB
 * @returns {Promise<Array>} Lista de proveedores normalizados
 */
async function getWatchProviders(type, id) {
    const country = getPreferredProviderCountryCode();
    const cacheKey = `${country}:${type}:${id}`;
    const cached = getTimedCache(watchProvidersCache, cacheKey, SESSION_DETAIL_TTL_MS);
    if (cached) return cached;

    try {
        const response = await fetchTMDB(`/${type}/${id}/watch/providers`);
        const deduped = extractWatchProvidersFromResponse(response, country);
        setTimedCache(watchProvidersCache, cacheKey, deduped, 300);
        return deduped;
    } catch (error) {
        if (error?.status === 404) {
            setTimedCache(watchProvidersCache, cacheKey, [], 300);
            return [];
        }
        console.error('[TMDB] Error obteniendo proveedores:', error);
        throw error;
    }
}

async function getMovieRegionalReleaseDate(id, countryCode = getPreferredProviderCountryCode()) {
    const country = String(countryCode || getPreferredProviderCountryCode() || 'ES').trim().toUpperCase();
    const safeId = Number(id);
    if (!Number.isFinite(safeId) || safeId <= 0) {
        return { fecha_estreno: null, country };
    }

    const detailCached = getTimedCache(movieDetailsCache, `${country}:${safeId}`, SESSION_DETAIL_TTL_MS);
    if (detailCached?.release_date_country === country) {
        return { fecha_estreno: detailCached.fecha_estreno || null, country };
    }

    const cacheKey = `${country}:${safeId}`;
    const cached = getTimedCache(releaseDatesCache, cacheKey, SESSION_DETAIL_TTL_MS);
    if (cached) return cached;

    try {
        const response = await fetchTMDB(`/movie/${safeId}/release_dates`);
        const fechaEstreno = extractRegionalReleaseDate(response, null, country);
        const result = { fecha_estreno: fechaEstreno, country };
        setTimedCache(releaseDatesCache, cacheKey, result, 300);
        return result;
    } catch (error) {
        if (error?.status === 404) {
            const empty = { fecha_estreno: null, country };
            setTimedCache(releaseDatesCache, cacheKey, empty, 300);
            return empty;
        }
        console.warn('[TMDB] Error obteniendo fechas de estreno regionales:', error);
        throw error;
    }
}

function clearWatchProvidersCache() {
    watchProvidersCache.clear();
    releaseDatesCache.clear();
    movieDetailsCache.clear();
    tvDetailsCache.clear();
}

const YOUTUBE_KEY_RE = /^[A-Za-z0-9_-]{6,20}$/;

function extractVideosFromResponse(videosPayload) {
    const rawList = Array.isArray(videosPayload?.results) ? videosPayload.results : [];
    const typeRank = { Trailer: 0, Teaser: 1, Clip: 2, Featurette: 3 };
    const langRank = (lang) => {
        const code = String(lang || '').toLowerCase();
        if (code === 'es') return 0;
        if (code === 'en') return 1;
        return 2;
    };

    const valid = rawList.filter(v =>
        String(v?.site || '').toLowerCase() === 'youtube'
        && YOUTUBE_KEY_RE.test(String(v?.key || ''))
        && Object.prototype.hasOwnProperty.call(typeRank, v?.type),
    );

    valid.sort((a, b) => {
        const typeDiff = (typeRank[a.type] ?? 9) - (typeRank[b.type] ?? 9);
        if (typeDiff !== 0) return typeDiff;
        const langDiff = langRank(a.iso_639_1) - langRank(b.iso_639_1);
        if (langDiff !== 0) return langDiff;
        const officialDiff = Number(Boolean(b.official)) - Number(Boolean(a.official));
        if (officialDiff !== 0) return officialDiff;
        return String(b.published_at || '').localeCompare(String(a.published_at || ''));
    });

    const seenKeys = new Set();
    const out = [];
    for (const v of valid) {
        const key = String(v.key);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        out.push({
            key,
            name: String(v.name || 'Tráiler').trim(),
            type: v.type,
            official: Boolean(v.official),
            lang: String(v.iso_639_1 || '').toUpperCase(),
        });
        if (out.length >= 4) break;
    }
    return out;
}

async function getTitleVideos(tipo, id) {
    const mediaType = tipo === 'movie' ? 'movie' : 'tv';
    const safeId = Number(id);
    if (!Number.isFinite(safeId) || safeId <= 0) return [];
    const cacheKey = `${mediaType}:${safeId}`;
    const cached = getTimedCache(videosCache, cacheKey, SESSION_DETAIL_TTL_MS);
    if (cached) return cached;

    try {
        const response = await fetchTMDB(`/${mediaType}/${safeId}/videos`, {
            include_video_language: 'es,en,null',
        });
        const videos = extractVideosFromResponse(response);
        setTimedCache(videosCache, cacheKey, videos, 300);
        return videos;
    } catch (error) {
        console.warn('[TMDB] Error obteniendo vídeos:', error);
        return [];
    }
}

/**
 * Detalles de una persona (actor / crew)
 * @param {number} id - ID TMDB de persona
 */
async function getPersonDetails(id) {
    const cacheKey = String(id);
    const cached = getTimedCache(personDetailsCache, cacheKey, SESSION_DETAIL_TTL_MS);
    if (cached) return cached;

    try {
        const data = await fetchTMDB(`/person/${id}`);
        const person = {
            id: data.id,
            name: data.name || '',
            biography: data.biography || '',
            birthday: data.birthday || '',
            place_of_birth: data.place_of_birth || '',
            known_for_department: data.known_for_department || '',
            profile_path: getImageUrl(data.profile_path, 'w500'),
        };
        setTimedCache(personDetailsCache, cacheKey, person, 100);
        return person;
    } catch (error) {
        console.error('[TMDB] Error obteniendo persona:', error);
        throw error;
    }
}

/**
 * Filmografía combinada (cast) de una persona
 * @param {number} id - ID TMDB de persona
 * @returns {Promise<Array>}
 */
async function getPersonCredits(id) {
    const cacheKey = String(id);
    const cached = getTimedCache(personCreditsCache, cacheKey, SESSION_DETAIL_TTL_MS);
    if (cached) return cached;

    try {
        const data = await fetchTMDB(`/person/${id}/combined_credits`);
        const cast = Array.isArray(data.cast) ? data.cast : [];
        const seen = new Set();
        const items = [];

        for (const credit of cast) {
            const mediaType = credit.media_type === 'tv' ? 'tv' : (credit.media_type === 'movie' ? 'movie' : null);
            if (!mediaType || !credit.id) continue;
            const key = `${mediaType}:${credit.id}`;
            if (seen.has(key)) continue;
            seen.add(key);

            const date = credit.release_date || credit.first_air_date || '';
            items.push({
                id_tmdb: credit.id,
                titulo: credit.title || credit.name || 'Sin título',
                portada: getImageUrl(credit.poster_path, 'w342'),
                tipo: mediaType,
                character: credit.character || '',
                year: date ? String(date).slice(0, 4) : '',
                popularity: Number(credit.popularity) || 0,
                date,
            });
        }

        items.sort((a, b) => {
            if (b.popularity !== a.popularity) return b.popularity - a.popularity;
            return String(b.date).localeCompare(String(a.date));
        });

        const topCredits = items.slice(0, 40).map(({ popularity, date, ...rest }) => rest);
        setTimedCache(personCreditsCache, cacheKey, topCredits, 100);
        return topCredits;
    } catch (error) {
        console.error('[TMDB] Error obteniendo credits de persona:', error);
        return [];
    }
}

// ============================================
// BÚSQUEDA CON DEBOUNCE
// ============================================

/**
 * Obtiene tendencias actuales (series, películas o mixtas) desde TMDB
 * @param {string|number} [typeOrLimit='all'] - 'tv', 'movie', 'all' o límite numérico heredado
 * @param {number|Object} [limitOrOptions=10] - Máximo de resultados (default: 10) u opciones
 * @param {Object} [maybeOptions] - Opciones ({ signal })
 * @returns {Promise<Array>} Lista normalizada de tendencias
 */
async function getTrendingSuggestions(typeOrLimit = 'all', limitOrOptions = 10, maybeOptions = {}) {
    let mediaType = 'all';
    let rawLimit = 10;
    let options = {};

    if (typeof typeOrLimit === 'number') {
        rawLimit = typeOrLimit;
        options = (limitOrOptions && typeof limitOrOptions === 'object') ? limitOrOptions : {};
    } else {
        const normalizedType = String(typeOrLimit || 'all').trim().toLowerCase();
        mediaType = (normalizedType === 'tv' || normalizedType === 'movie') ? normalizedType : 'all';
        rawLimit = typeof limitOrOptions === 'number' ? limitOrOptions : 10;
        options = (maybeOptions && typeof maybeOptions === 'object') ? maybeOptions : {};
    }

    const safeLimit = Math.max(1, Math.min(20, Number(rawLimit) || 10));
    const cacheKey = `${mediaType}:day:${safeLimit}`;
    const cached = getTimedCache(trendingCache, cacheKey, SESSION_TRENDING_TTL_MS);
    if (cached) return cached;

    const endpoint = mediaType === 'tv'
        ? '/trending/tv/day'
        : (mediaType === 'movie' ? '/trending/movie/day' : '/trending/all/day');

    try {
        const response = await fetchTMDB(endpoint, {
            page: 1,
        }, options);

        const items = (response.results || [])
            .map(item => ({
                ...item,
                media_type: item.media_type || (mediaType === 'tv' || mediaType === 'movie' ? mediaType : (item.title ? 'movie' : 'tv')),
            }))
            .filter(item => item.media_type === 'movie' || item.media_type === 'tv')
            .slice(0, safeLimit)
            .map(normalizeSearchResult);

        setTimedCache(trendingCache, cacheKey, items, 10);
        return items;
    } catch (error) {
        if (error?.name !== 'AbortError') {
            console.error('[TMDB] Error obteniendo tendencias:', error);
        }
        throw error;
    }
}

/**
 * Cancela cualquier búsqueda pendiente o en curso en Explorar.
 */
function cancelSearchDebounce() {
    if (searchTimeout) {
        clearTimeout(searchTimeout);
        searchTimeout = null;
    }
    if (currentSearchAbortController) {
        currentSearchAbortController.abort();
        currentSearchAbortController = null;
    }
}

/**
 * Realiza una búsqueda con debounce para evitar demasiadas peticiones
 * y cancela búsquedas anteriores en curso mediante AbortController.
 * @param {string} query - Término de búsqueda
 * @param {Function} callback - Función a ejecutar con los resultados
 * @param {number} delay - Retraso en ms (default: 300)
 */
function searchWithDebounce(query, callback, delay = 300) {
    cancelSearchDebounce();

    if (!query || query.length < 2) {
        callback([]);
        return;
    }

    searchTimeout = setTimeout(async () => {
        const controller = new AbortController();
        currentSearchAbortController = controller;
        try {
            const results = await searchMulti(query, 1, { signal: controller.signal });
            if (controller.signal.aborted) return;
            const normalized = results.results.map(normalizeSearchResult);
            callback(normalized);
        } catch (error) {
            if (error?.name === 'AbortError') return;
            console.error('[TMDB] Error en búsqueda con debounce:', error);
            callback([]);
        } finally {
            if (currentSearchAbortController === controller) {
                currentSearchAbortController = null;
            }
        }
    }, delay);
}

// ============================================
// EXPORTACIONES
// ============================================

// Hacer funciones disponibles globalmente
window.TMDBService = {
    searchMulti,
    searchMovies,
    searchTV,
    getTrendingSuggestions,
    getMovieDetails,
    getMovieFilterMeta,
    getTVDetails,
    getTVShowMeta,
    getSeasonDetails,
    getSeasonsBatch,
    clearSeasonDetailsCache,
    findByExternalId,
    findMovieByTitleYear,
    findTVByTitleYear,
    getImageUrl,
    normalizeMovieData,
    normalizeTVData,
    normalizeSearchResult,
    getWatchProviders,
    getMovieRegionalReleaseDate,
    extractRegionalReleaseDate,
    clearWatchProvidersCache,
    getTitleVideos,
    getPersonDetails,
    getPersonCredits,
    cancelSearchDebounce,
    searchWithDebounce,
};

window.searchMulti = searchMulti;
window.searchMovies = searchMovies;
window.searchTV = searchTV;
window.getTrendingSuggestions = getTrendingSuggestions;
window.hasTmdbConfig = hasTmdbConfig;
window.getMovieDetails = getMovieDetails;
window.getMovieFilterMeta = getMovieFilterMeta;
window.getTVDetails = getTVDetails;
window.getTVShowMeta = getTVShowMeta;
window.getSeasonDetails = getSeasonDetails;
window.getSeasonsBatch = getSeasonsBatch;
window.clearSeasonDetailsCache = clearSeasonDetailsCache;
window.findByExternalId = findByExternalId;
window.findMovieByTitleYear = findMovieByTitleYear;
window.findTVByTitleYear = findTVByTitleYear;
window.getImageUrl = getImageUrl;
window.normalizeMovieData = normalizeMovieData;
window.normalizeTVData = normalizeTVData;
window.normalizeSearchResult = normalizeSearchResult;
window.getWatchProviders = getWatchProviders;
window.getMovieRegionalReleaseDate = getMovieRegionalReleaseDate;
window.extractRegionalReleaseDate = extractRegionalReleaseDate;
window.clearWatchProvidersCache = clearWatchProvidersCache;
window.getTitleVideos = getTitleVideos;
window.getPersonDetails = getPersonDetails;
window.getPersonCredits = getPersonCredits;
window.cancelSearchDebounce = cancelSearchDebounce;
window.searchWithDebounce = searchWithDebounce;

console.log('[TMDB] tmdb-service.js cargado');

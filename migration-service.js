/**
 * SeenIt - Importador y Exportador Universal
 * Soporta: SeenIt (.json), Letterboxd (.csv), IMDb (.csv),
 * Trakt.tv (.json/.csv), TV Time (.csv/.json), Simkl y CSV/JSON personalizados.
 */

(function initSeenItMigrationService() {
    const MAX_IMPORT_FILE_BYTES = 25 * 1024 * 1024;
    const IMPORT_TMDB_CONCURRENCY = 4;

    const PLATFORM_DIRECTORY = [
        {
            id: 'seenit',
            name: 'SeenIt (JSON)',
            importLabel: 'Automático',
            exportLabel: 'Copia completa',
            details: 'Películas, series, episodios, listas, selector, ajustes y logros',
        },
        {
            id: 'letterboxd',
            name: 'Letterboxd (CSV)',
            importLabel: 'Automático',
            exportLabel: 'Plantilla CSV cine',
            details: 'Películas, año, valoración 0.5–5.0, fecha vista, crítica y tmdbID',
        },
        {
            id: 'trakt',
            name: 'Trakt.tv (JSON / CSV)',
            importLabel: 'Automático',
            exportLabel: 'Esquema Trakt JSON',
            details: 'Películas, series, episodios exactos, notas 1–10 e IDs TMDB/IMDb',
        },
        {
            id: 'imdb',
            name: 'IMDb (CSV)',
            importLabel: 'Automático',
            exportLabel: 'Vía CSV Universal',
            details: 'Películas y series por ID tt..., notas 1–10 y fecha de valoración',
        },
        {
            id: 'tvtime',
            name: 'TV Time (CSV / JSON)',
            importLabel: 'Automático',
            exportLabel: 'Vía CSV Universal',
            details: 'Series por tvdb_id, episodios exactos (S/E) y películas vistas',
        },
        {
            id: 'custom',
            name: 'Simkl / Excel / Otros CSV o JSON',
            importLabel: 'Mapeador de columnas',
            exportLabel: 'CSV Universal',
            details: 'Cualquier tabla con columnas asignables manualmente',
        },
    ];

    const SOURCE_LABELS = {
        seenit: 'Copia de seguridad SeenIt (JSON)',
        letterboxd: 'Letterboxd (CSV)',
        imdb: 'IMDb (CSV)',
        trakt_json: 'Trakt.tv (JSON)',
        trakt_csv: 'Trakt.tv / Simkl (CSV)',
        tvtime_csv: 'TV Time (CSV)',
        tvtime_json: 'TV Time (JSON)',
        universal_csv: 'CSV Universal SeenIt',
        custom_csv: 'CSV personalizado',
        custom_json: 'JSON personalizado',
    };

    const migrationState = {
        step: 'select', // 'select' | 'preview' | 'running' | 'summary'
        fileName: '',
        fileExt: '',
        sourceId: '',
        rawHeaders: [],
        rawRows: [],
        seenitPayload: null,
        seenitMode: 'merge', // 'merge' | 'replace'
        duplicateMode: 'merge', // 'merge' | 'skip_existing'
        mapping: {
            title: '',
            typeMode: 'auto', // 'auto' | 'column' | 'movie' | 'tv'
            typeCol: '',
            year: '',
            externalId: '',
            externalIdKind: 'auto', // 'auto' | 'tmdb' | 'imdb' | 'tvdb'
            statusMode: 'completed', // 'completed' | 'pending' | 'column'
            statusCol: '',
            rating: '',
            ratingScale: '10', // '10' | '5'
            review: '',
            season: '',
            episode: '',
            watchedAt: '',
        },
        records: [],
        cancelled: false,
        running: false,
        progress: {
            processed: 0,
            total: 0,
            addedMovies: 0,
            mergedMovies: 0,
            addedShows: 0,
            mergedShows: 0,
            episodesMarked: 0,
            skippedExisting: 0,
            currentTitle: '',
        },
        issues: [],
    };

    function resetMigrationState() {
        migrationState.step = 'select';
        migrationState.fileName = '';
        migrationState.fileExt = '';
        migrationState.sourceId = '';
        migrationState.rawHeaders = [];
        migrationState.rawRows = [];
        migrationState.seenitPayload = null;
        migrationState.seenitMode = 'merge';
        migrationState.duplicateMode = 'merge';
        migrationState.mapping = {
            title: '',
            typeMode: 'auto',
            typeCol: '',
            year: '',
            externalId: '',
            externalIdKind: 'auto',
            statusMode: 'completed',
            statusCol: '',
            rating: '',
            ratingScale: '10',
            review: '',
            season: '',
            episode: '',
            watchedAt: '',
        };
        migrationState.records = [];
        migrationState.cancelled = false;
        migrationState.running = false;
        migrationState.progress = {
            processed: 0,
            total: 0,
            addedMovies: 0,
            mergedMovies: 0,
            addedShows: 0,
            mergedShows: 0,
            episodesMarked: 0,
            skippedExisting: 0,
            currentTitle: '',
        };
        migrationState.issues = [];
    }

    function esc(str) {
        if (typeof escapeHtml === 'function') return escapeHtml(str);
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ============================================
    // PARSEO RFC 4180 CSV Y NORMALIZACIÓN TEXTUAL
    // ============================================

    function detectCsvDelimiter(text) {
        const firstLines = String(text || '').split(/\r?\n/).slice(0, 5).join('\n');
        const countChar = (ch) => {
            let count = 0;
            let inQuotes = false;
            for (let i = 0; i < firstLines.length; i += 1) {
                const c = firstLines[i];
                if (c === '"') inQuotes = !inQuotes;
                else if (!inQuotes && c === ch) count += 1;
            }
            return count;
        };
        const commas = countChar(',');
        const semis = countChar(';');
        const tabs = countChar('\t');
        if (tabs > commas && tabs > semis) return '\t';
        if (semis > commas) return ';';
        return ',';
    }

    function parseCsv(text) {
        const clean = String(text || '').replace(/^\uFEFF/, '');
        if (!clean.trim()) return { headers: [], rows: [] };

        const delimiter = detectCsvDelimiter(clean);
        const rows = [];
        let currentRow = [];
        let field = '';
        let inQuotes = false;

        for (let i = 0; i < clean.length; i += 1) {
            const ch = clean[i];
            if (inQuotes) {
                if (ch === '"') {
                    if (clean[i + 1] === '"') {
                        field += '"';
                        i += 1;
                    } else {
                        inQuotes = false;
                    }
                } else {
                    field += ch;
                }
            } else if (ch === '"') {
                inQuotes = true;
            } else if (ch === delimiter) {
                currentRow.push(field.trim());
                field = '';
            } else if (ch === '\r') {
                if (clean[i + 1] === '\n') i += 1;
                currentRow.push(field.trim());
                if (currentRow.some(cell => cell !== '')) rows.push(currentRow);
                currentRow = [];
                field = '';
            } else if (ch === '\n') {
                currentRow.push(field.trim());
                if (currentRow.some(cell => cell !== '')) rows.push(currentRow);
                currentRow = [];
                field = '';
            } else {
                field += ch;
            }
        }
        currentRow.push(field.trim());
        if (currentRow.some(cell => cell !== '')) rows.push(currentRow);

        if (rows.length === 0) return { headers: [], rows: [] };
        const headers = rows[0].map((h, idx) => h || `Columna ${idx + 1}`);
        const objects = rows.slice(1).map((cells) => {
            const obj = {};
            headers.forEach((h, idx) => {
                obj[h] = cells[idx] ?? '';
            });
            return obj;
        });
        return { headers, rows: objects };
    }

    function normalizeHeaderKey(h) {
        return String(h || '')
            .trim()
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_|_$/g, '');
    }

    function normalizeTitleForCompare(str) {
        return String(str || '')
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function parseYear(val) {
        const match = String(val ?? '').match(/\b(18\d{2}|19\d{2}|20\d{2}|21\d{2})\b/);
        return match ? Number(match[1]) : null;
    }

    function parsePositiveInt(val) {
        const n = Number(String(val ?? '').trim());
        return Number.isInteger(n) && n > 0 ? n : null;
    }

    function parseNonNegativeInt(val) {
        const raw = String(val ?? '').trim();
        if (!raw) return null;
        const n = Number(raw);
        return Number.isInteger(n) && n >= 0 ? n : null;
    }

    function parseImdbId(val) {
        const match = String(val ?? '').trim().match(/tt\d{5,10}/i);
        return match ? match[0].toLowerCase() : null;
    }

    function parseIsoDate(val) {
        const s = String(val ?? '').trim();
        if (!s) return null;
        const d = new Date(s.includes(' ') && !s.includes('T') ? s.replace(' ', 'T') : s);
        return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }

    function parseRating(val, scale = '10') {
        const s = String(val ?? '').replace(',', '.').trim();
        if (!s) return 0;
        const num = Number(s);
        if (!Number.isFinite(num) || num <= 0) return 0;
        if (scale === '5') {
            return Math.min(10, Math.max(0.5, Math.round(num * 2)));
        }
        return Math.min(10, Math.max(1, Math.round(num)));
    }

    function parseBooleanFlag(val) {
        const s = String(val ?? '').trim().toLowerCase();
        return s === 'true' || s === '1' || s === 'yes' || s === 'si' || s === 'sí';
    }

    function parseTypeValue(raw) {
        const s = String(raw ?? '').trim().toLowerCase();
        if (!s) return { tipo: 'unknown', unsupported: null };
        if (s === 'movie' || s === 'film' || s === 'pelicula' || s === 'película' || s === 'tvmovie' || s === 'tv special' || s === 'tvspecial' || s === 'short' || s === 'video') {
            return { tipo: 'movie', unsupported: null };
        }
        if (s === 'tv' || s === 'show' || s === 'series' || s === 'serie' || s === 'tvseries' || s === 'tvminiseries' || s === 'tv series' || s === 'tv mini series' || s === 'anime') {
            return { tipo: 'tv', unsupported: null };
        }
        if (s.includes('game') || s.includes('podcast') || s.includes('episode')) {
            return { tipo: 'unsupported', unsupported: String(raw) };
        }
        return { tipo: 'unknown', unsupported: null };
    }

    function parseStatusValue(raw, fallback = 'completed') {
        const s = String(raw ?? '').trim().toLowerCase();
        if (!s) return fallback;
        if (s === 'pending' || s === 'pendiente' || s === 'watchlist' || s === 'to_watch' || s === 'plan_to_watch' || s === 'planned' || s === 'not_started') {
            return 'pending';
        }
        if (s === 'watching' || s === 'viendo' || s === 'in_progress' || s === 'current' || s === 'standby' || s === 'en espera') {
            return 'watching';
        }
        if (s === 'completed' || s === 'vista' || s === 'visto' || s === 'watched' || s === 'finished' || s === 'done') {
            return 'completed';
        }
        return fallback;
    }

    // ============================================
    // DETECCIÓN DE PLATAFORMA Y CONSTRUCCIÓN DE REGISTROS
    // ============================================

    function findHeader(headers, candidates) {
        const normalizedMap = new Map(headers.map(h => [normalizeHeaderKey(h), h]));
        for (const cand of candidates) {
            const key = normalizeHeaderKey(cand);
            if (normalizedMap.has(key)) return normalizedMap.get(key);
        }
        return '';
    }

    function guessMappingFromHeaders(headers) {
        const title = findHeader(headers, ['title', 'titulo', 'name', 'nombre', 'show_name', 'series_name', 'movie_title', 'original_title']);
        const typeCol = findHeader(headers, ['type', 'tipo', 'title_type', 'media_type', 'kind', 'category']);
        const year = findHeader(headers, ['year', 'ano', 'release_year', 'first_air_year', 'release_date']);
        const tmdbCol = findHeader(headers, ['tmdbid', 'tmdb_id', 'tmdb', 'id_tmdb']);
        const imdbCol = findHeader(headers, ['imdbid', 'imdb_id', 'imdb', 'const']);
        const tvdbCol = findHeader(headers, ['tvdbid', 'tvdb_id', 'tvdb', 'series_id']);
        const externalId = tmdbCol || imdbCol || tvdbCol;
        const externalIdKind = tmdbCol ? 'tmdb' : (imdbCol ? 'imdb' : (tvdbCol ? 'tvdb' : 'auto'));
        const statusCol = findHeader(headers, ['status', 'estado', 'state', 'watch_status']);
        const rating10Col = findHeader(headers, ['rating10', 'your_rating', 'puntuacion', 'score', 'user_rating', 'rating']);
        const ratingCol = rating10Col || findHeader(headers, ['rating', 'stars']);
        const review = findHeader(headers, ['review', 'critica', 'notes', 'comment', 'resena']);
        const season = findHeader(headers, ['season', 'season_number', 'temporada', 's']);
        const episode = findHeader(headers, ['episode', 'episode_number', 'episodio', 'capitulo', 'e']);
        const watchedAt = findHeader(headers, ['watcheddate', 'watched_date', 'watched_at', 'date_rated', 'updated_at', 'updatedat', 'created_at', 'date']);

        return {
            title,
            typeMode: typeCol ? 'column' : 'auto',
            typeCol,
            year,
            externalId,
            externalIdKind,
            statusMode: statusCol ? 'column' : 'completed',
            statusCol,
            rating: ratingCol,
            ratingScale: normalizeHeaderKey(ratingCol) === 'rating' ? '5' : '10',
            review,
            season,
            episode,
            watchedAt,
        };
    }

    function detectCsvSource(headers, fileName) {
        const keySet = new Set(headers.map(normalizeHeaderKey));
        const lowerName = String(fileName || '').toLowerCase();

        if (keySet.has('title') && keySet.has('type') && keySet.has('tmdbid') && keySet.has('status') && keySet.has('rating10')) {
            return 'universal_csv';
        }
        if (keySet.has('const') && (keySet.has('title_type') || keySet.has('your_rating') || keySet.has('title'))) {
            return 'imdb';
        }
        if (
            keySet.has('letterboxd_uri')
            || ((keySet.has('name') || keySet.has('title')) && keySet.has('year') && (keySet.has('watcheddate') || keySet.has('rating') || keySet.has('rating10') || lowerName.includes('letterboxd') || lowerName.includes('watchlist') || lowerName.includes('ratings') || lowerName.includes('watched') || lowerName.includes('diary')))
        ) {
            if (!keySet.has('type') && !keySet.has('media_type') && !keySet.has('season') && !keySet.has('tvdb_id') && !keySet.has('const')) {
                return 'letterboxd';
            }
        }
        if (
            (keySet.has('tvdb_id') || keySet.has('series_id') || lowerName.includes('tracking-prod') || lowerName.includes('followed_tv_show') || lowerName.includes('tvtime'))
            && (keySet.has('season') || keySet.has('season_number') || keySet.has('episode') || keySet.has('episode_number') || keySet.has('series_name') || keySet.has('tvdb_id'))
        ) {
            return 'tvtime_csv';
        }
        if ((keySet.has('trakt') || keySet.has('tmdb') || keySet.has('imdb') || keySet.has('imdb_id')) && (keySet.has('title') || keySet.has('name')) && (keySet.has('type') || keySet.has('media_type') || keySet.has('watched_at'))) {
            return 'trakt_csv';
        }
        return 'custom_csv';
    }

    function createGroupKey(rec) {
        if (rec.tmdbId) return `${rec.tipo}:tmdb:${rec.tmdbId}`;
        if (rec.imdbId) return `${rec.tipo}:imdb:${rec.imdbId}`;
        if (rec.tvdbId) return `tv:tvdb:${rec.tvdbId}`;
        const normTitle = normalizeTitleForCompare(rec.title);
        if (normTitle) return `${rec.tipo}:title:${normTitle}:${rec.year || ''}`;
        return null;
    }

    function mergeRawRecords(records) {
        const grouped = new Map();
        const invalidIssues = [];

        for (const raw of records) {
            if (raw.unsupportedType) {
                invalidIssues.push({
                    title: raw.title || raw.imdbId || raw.tvdbId || 'Registro sin nombre',
                    year: raw.year || null,
                    tipo: 'unknown',
                    reason: `Tipo no compatible (${raw.unsupportedType})`,
                    searchableTitle: '',
                });
                continue;
            }

            const key = createGroupKey(raw);
            if (!key) {
                invalidIssues.push({
                    title: raw.title || 'Fila vacía o sin identificador',
                    year: raw.year || null,
                    tipo: raw.tipo || 'unknown',
                    reason: 'Falta título e identificador válido',
                    searchableTitle: '',
                });
                continue;
            }

            if (!grouped.has(key)) {
                grouped.set(key, {
                    tipo: raw.tipo || 'unknown',
                    tmdbId: raw.tmdbId || null,
                    imdbId: raw.imdbId || null,
                    tvdbId: raw.tvdbId || null,
                    title: raw.title || '',
                    year: raw.year || null,
                    status: raw.status || 'completed',
                    rating10: raw.rating10 || 0,
                    favorite: Boolean(raw.favorite),
                    review: raw.review || '',
                    watchedAt: raw.watchedAt || null,
                    episodes: [],
                    episodeSet: new Set(),
                });
            }

            const entry = grouped.get(key);
            if (!entry.tmdbId && raw.tmdbId) entry.tmdbId = raw.tmdbId;
            if (!entry.imdbId && raw.imdbId) entry.imdbId = raw.imdbId;
            if (!entry.tvdbId && raw.tvdbId) entry.tvdbId = raw.tvdbId;
            if (!entry.title && raw.title) entry.title = raw.title;
            if (!entry.year && raw.year) entry.year = raw.year;
            if (raw.rating10 > entry.rating10) entry.rating10 = raw.rating10;
            if (raw.favorite) entry.favorite = true;
            if (!entry.review && raw.review) entry.review = raw.review;
            if (!entry.watchedAt && raw.watchedAt) entry.watchedAt = raw.watchedAt;
            if (raw.status === 'completed' || (raw.status === 'watching' && entry.status === 'pending')) {
                entry.status = raw.status;
            }

            if (Array.isArray(raw.episodes)) {
                for (const ep of raw.episodes) {
                    const epKey = `${ep.season}:${ep.episode}`;
                    if (!entry.episodeSet.has(epKey)) {
                        entry.episodeSet.add(epKey);
                        entry.episodes.push(ep);
                    }
                }
            }
        }

        return {
            records: [...grouped.values()].map(({ episodeSet, ...rest }) => rest),
            invalidIssues,
        };
    }

    function parseEpisodeCodeList(rawList) {
        if (!rawList) return [];
        const eps = [];
        const matches = String(rawList).matchAll(/S(\d+)[\s_]*E(\d+)/gi);
        for (const m of matches) {
            const season = Number(m[1]);
            const episode = Number(m[2]);
            if (Number.isInteger(season) && season >= 0 && Number.isInteger(episode) && episode > 0) {
                eps.push({ season, episode, watchedAt: null });
            }
        }
        return eps;
    }

    function buildRecordsFromCsvRows(sourceId, headers, rows, customMapping = null) {
        const lowerName = String(migrationState.fileName || '').toLowerCase();
        const isWatchlistFile = lowerName.includes('watchlist');
        const map = customMapping || guessMappingFromHeaders(headers);

        const rawRecords = [];
        for (const row of rows) {
            if (sourceId === 'universal_csv') {
                const typeParsed = parseTypeValue(row[findHeader(headers, ['type'])]);
                const epList = parseEpisodeCodeList(row[findHeader(headers, ['watchedepisodes', 'watched_episodes'])]);
                rawRecords.push({
                    tipo: typeParsed.tipo,
                    unsupportedType: typeParsed.unsupported,
                    tmdbId: parsePositiveInt(row[findHeader(headers, ['tmdbid'])]),
                    imdbId: parseImdbId(row[findHeader(headers, ['imdbid'])]),
                    tvdbId: null,
                    title: row[findHeader(headers, ['title'])] || '',
                    year: parseYear(row[findHeader(headers, ['year'])]),
                    status: parseStatusValue(row[findHeader(headers, ['status'])], 'completed'),
                    rating10: parseRating(row[findHeader(headers, ['rating10'])], '10'),
                    favorite: parseBooleanFlag(row[findHeader(headers, ['favorite'])]),
                    review: row[findHeader(headers, ['review'])] || '',
                    watchedAt: parseIsoDate(row[findHeader(headers, ['updatedat', 'updated_at'])]),
                    episodes: epList,
                });
                continue;
            }

            if (sourceId === 'letterboxd') {
                const titleCol = findHeader(headers, ['name', 'title']);
                const yearCol = findHeader(headers, ['year']);
                const r10Col = findHeader(headers, ['rating10']);
                const r5Col = findHeader(headers, ['rating']);
                const reviewCol = findHeader(headers, ['review']);
                const tmdbCol = findHeader(headers, ['tmdbid', 'tmdb_id']);
                const imdbCol = findHeader(headers, ['imdbid', 'imdb_id']);
                const dateCol = findHeader(headers, ['watcheddate', 'watched_date', 'date']);
                rawRecords.push({
                    tipo: 'movie',
                    tmdbId: tmdbCol ? parsePositiveInt(row[tmdbCol]) : null,
                    imdbId: imdbCol ? parseImdbId(row[imdbCol]) : null,
                    tvdbId: null,
                    title: titleCol ? row[titleCol] : '',
                    year: yearCol ? parseYear(row[yearCol]) : null,
                    status: isWatchlistFile ? 'pending' : 'completed',
                    rating10: r10Col ? parseRating(row[r10Col], '10') : (r5Col ? parseRating(row[r5Col], '5') : 0),
                    favorite: false,
                    review: reviewCol ? row[reviewCol] : '',
                    watchedAt: dateCol ? parseIsoDate(row[dateCol]) : null,
                    episodes: [],
                });
                continue;
            }

            if (sourceId === 'imdb') {
                const constCol = findHeader(headers, ['const', 'imdbid', 'imdb_id']);
                const titleCol = findHeader(headers, ['title', 'name']);
                const typeCol = findHeader(headers, ['title_type', 'type']);
                const yearCol = findHeader(headers, ['year']);
                const ratingCol = findHeader(headers, ['your_rating', 'rating']);
                const dateCol = findHeader(headers, ['date_rated', 'created', 'modified']);
                const typeParsed = typeCol ? parseTypeValue(row[typeCol]) : { tipo: 'unknown', unsupported: null };
                const rating10 = ratingCol ? parseRating(row[ratingCol], '10') : 0;
                rawRecords.push({
                    tipo: typeParsed.tipo,
                    unsupportedType: typeParsed.unsupported,
                    tmdbId: null,
                    imdbId: constCol ? parseImdbId(row[constCol]) : null,
                    tvdbId: null,
                    title: titleCol ? row[titleCol] : '',
                    year: yearCol ? parseYear(row[yearCol]) : null,
                    status: isWatchlistFile && rating10 === 0 ? 'pending' : 'completed',
                    rating10,
                    favorite: false,
                    review: '',
                    watchedAt: dateCol ? parseIsoDate(row[dateCol]) : null,
                    episodes: [],
                });
                continue;
            }

            if (sourceId === 'tvtime_csv') {
                const tvdbCol = findHeader(headers, ['tvdb_id', 'series_id', 'show_id']);
                const tmdbCol = findHeader(headers, ['tmdb_id', 'tmdbid']);
                const imdbCol = findHeader(headers, ['imdb_id', 'imdbid']);
                const titleCol = findHeader(headers, ['series_name', 'show_name', 'title', 'name', 'movie_name']);
                const seasonCol = findHeader(headers, ['season', 'season_number']);
                const episodeCol = findHeader(headers, ['episode', 'episode_number']);
                const dateCol = findHeader(headers, ['updated_at', 'watched_at', 'created_at', 'date']);
                const ratingCol = findHeader(headers, ['rating', 'score']);
                const statusCol = findHeader(headers, ['status', 'state']);
                const typeCol = findHeader(headers, ['type', 'media_type']);

                const seasonNum = seasonCol ? parseNonNegativeInt(row[seasonCol]) : null;
                const epNum = episodeCol ? parsePositiveInt(row[episodeCol]) : null;
                const watchedAt = dateCol ? parseIsoDate(row[dateCol]) : null;
                const episodes = seasonNum != null && epNum != null
                    ? [{ season: seasonNum, episode: epNum, watchedAt }]
                    : [];

                let tipo = typeCol ? parseTypeValue(row[typeCol]).tipo : 'tv';
                if (lowerName.includes('movie') && !episodes.length && !tvdbCol) {
                    tipo = 'movie';
                }

                rawRecords.push({
                    tipo: tipo === 'unknown' ? 'tv' : tipo,
                    tmdbId: tmdbCol ? parsePositiveInt(row[tmdbCol]) : null,
                    imdbId: imdbCol ? parseImdbId(row[imdbCol]) : null,
                    tvdbId: tvdbCol ? parsePositiveInt(row[tvdbCol]) : null,
                    title: titleCol ? row[titleCol] : '',
                    year: null,
                    status: episodes.length
                        ? 'watching'
                        : parseStatusValue(statusCol ? row[statusCol] : '', isWatchlistFile ? 'pending' : 'watching'),
                    rating10: ratingCol ? parseRating(row[ratingCol], '10') : 0,
                    favorite: false,
                    review: '',
                    watchedAt,
                    episodes,
                });
                continue;
            }

            // Trakt CSV o CSV personalizado usando el mapeo del usuario
            const rawExt = map.externalId ? row[map.externalId] : '';
            let tmdbId = null;
            let imdbId = null;
            let tvdbId = null;
            if (rawExt) {
                if (map.externalIdKind === 'imdb' || /^tt\d+/i.test(String(rawExt).trim())) {
                    imdbId = parseImdbId(rawExt);
                } else if (map.externalIdKind === 'tvdb') {
                    tvdbId = parsePositiveInt(rawExt);
                } else {
                    tmdbId = parsePositiveInt(rawExt);
                }
            }
            if (!tmdbId) {
                const extraTmdb = findHeader(headers, ['tmdbid', 'tmdb_id', 'tmdb']);
                if (extraTmdb) tmdbId = parsePositiveInt(row[extraTmdb]);
            }
            if (!imdbId) {
                const extraImdb = findHeader(headers, ['imdbid', 'imdb_id', 'imdb', 'const']);
                if (extraImdb) imdbId = parseImdbId(row[extraImdb]);
            }
            if (!tvdbId) {
                const extraTvdb = findHeader(headers, ['tvdbid', 'tvdb_id', 'tvdb']);
                if (extraTvdb) tvdbId = parsePositiveInt(row[extraTvdb]);
            }

            let tipo = 'unknown';
            let unsupportedType = null;
            if (map.typeMode === 'movie') tipo = 'movie';
            else if (map.typeMode === 'tv') tipo = 'tv';
            else if (map.typeMode === 'column' && map.typeCol) {
                const parsed = parseTypeValue(row[map.typeCol]);
                tipo = parsed.tipo;
                unsupportedType = parsed.unsupported;
            }

            const seasonNum = map.season ? parseNonNegativeInt(row[map.season]) : null;
            const epNum = map.episode ? parsePositiveInt(row[map.episode]) : null;
            if (tipo === 'unknown' && seasonNum != null && epNum != null) {
                tipo = 'tv';
            }

            const watchedAt = map.watchedAt ? parseIsoDate(row[map.watchedAt]) : null;
            const episodes = seasonNum != null && epNum != null
                ? [{ season: seasonNum, episode: epNum, watchedAt }]
                : [];

            const statusFallback = isWatchlistFile ? 'pending' : (episodes.length ? 'watching' : 'completed');
            const status = map.statusMode === 'column' && map.statusCol
                ? parseStatusValue(row[map.statusCol], statusFallback)
                : (map.statusMode === 'pending' ? 'pending' : statusFallback);

            rawRecords.push({
                tipo,
                unsupportedType,
                tmdbId,
                imdbId,
                tvdbId,
                title: map.title ? (row[map.title] || '') : '',
                year: map.year ? parseYear(row[map.year]) : null,
                status,
                rating10: map.rating ? parseRating(row[map.rating], map.ratingScale || '10') : 0,
                favorite: false,
                review: map.review ? (row[map.review] || '') : '',
                watchedAt,
                episodes,
            });
        }

        return mergeRawRecords(rawRecords);
    }

    function extractTraktIds(idsObj) {
        if (!idsObj || typeof idsObj !== 'object') return { tmdbId: null, imdbId: null, tvdbId: null };
        return {
            tmdbId: parsePositiveInt(idsObj.tmdb),
            imdbId: parseImdbId(idsObj.imdb),
            tvdbId: parsePositiveInt(idsObj.tvdb),
        };
    }

    function parseTraktJsonPayload(parsed, fileName = '') {
        const lowerName = String(fileName || '').toLowerCase();
        const isWatchlist = lowerName.includes('watchlist');
        const entries = [];

        const pushItem = (item, forcedType = null, fallbackStatus = null) => {
            if (!item || typeof item !== 'object') return;
            const movieNode = item.movie || (forcedType === 'movie' && item.ids ? item : null);
            const showNode = item.show || (forcedType === 'tv' && item.ids ? item : null);

            if (movieNode) {
                const ids = extractTraktIds(movieNode.ids);
                const watchedAt = parseIsoDate(item.last_watched_at || item.watched_at || item.rated_at || item.listed_at);
                entries.push({
                    tipo: 'movie',
                    ...ids,
                    title: movieNode.title || '',
                    year: parseYear(movieNode.year),
                    status: fallbackStatus || (isWatchlist && !item.plays && !item.last_watched_at && !item.rating ? 'pending' : 'completed'),
                    rating10: parseRating(item.rating, '10'),
                    favorite: false,
                    review: '',
                    watchedAt,
                    episodes: [],
                });
                return;
            }

            if (showNode) {
                const ids = extractTraktIds(showNode.ids);
                const episodes = [];
                if (Array.isArray(item.seasons)) {
                    for (const s of item.seasons) {
                        const sNum = parseNonNegativeInt(s?.number);
                        if (sNum == null || !Array.isArray(s?.episodes)) continue;
                        for (const ep of s.episodes) {
                            const eNum = parsePositiveInt(ep?.number);
                            if (eNum == null) continue;
                            episodes.push({
                                season: sNum,
                                episode: eNum,
                                watchedAt: parseIsoDate(ep?.last_watched_at || ep?.watched_at),
                            });
                        }
                    }
                } else if (item.episode && typeof item.episode === 'object') {
                    const sNum = parseNonNegativeInt(item.episode.season);
                    const eNum = parsePositiveInt(item.episode.number);
                    if (sNum != null && eNum != null) {
                        episodes.push({
                            season: sNum,
                            episode: eNum,
                            watchedAt: parseIsoDate(item.watched_at || item.last_watched_at || item.rated_at),
                        });
                    }
                }

                const watchedAt = parseIsoDate(item.last_watched_at || item.watched_at || item.rated_at || item.listed_at);
                entries.push({
                    tipo: 'tv',
                    ...ids,
                    title: showNode.title || '',
                    year: parseYear(showNode.year),
                    status: fallbackStatus || (episodes.length ? 'watching' : (isWatchlist ? 'pending' : 'completed')),
                    rating10: parseRating(item.rating, '10'),
                    favorite: false,
                    review: '',
                    watchedAt,
                    episodes,
                });
            }
        };

        if (Array.isArray(parsed)) {
            parsed.forEach(item => pushItem(item));
        } else if (parsed && typeof parsed === 'object') {
            if (Array.isArray(parsed.movies)) parsed.movies.forEach(m => pushItem(m, 'movie'));
            if (Array.isArray(parsed.shows)) parsed.shows.forEach(s => pushItem(s, 'tv'));
            if (Array.isArray(parsed.watchlist)) parsed.watchlist.forEach(w => pushItem(w, null, 'pending'));
            if (Array.isArray(parsed.history)) parsed.history.forEach(h => pushItem(h));
        }

        return mergeRawRecords(entries);
    }

    function isTraktJsonShape(parsed) {
        if (Array.isArray(parsed)) {
            return parsed.some(item => item && typeof item === 'object' && (item.movie || item.show));
        }
        if (parsed && typeof parsed === 'object') {
            if (Array.isArray(parsed.movies) && parsed.movies.some(m => m?.ids || m?.movie)) return true;
            if (Array.isArray(parsed.shows) && parsed.shows.some(s => s?.ids || s?.show || Array.isArray(s?.seasons))) return true;
            if (Array.isArray(parsed.history) && parsed.history.some(h => h?.movie || h?.show)) return true;
        }
        return false;
    }

    function isSeenItBackupShape(parsed) {
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
        const hasSeenItArrays = Array.isArray(parsed.movies) || Array.isArray(parsed.shows) || Array.isArray(parsed.lists) || Array.isArray(parsed.selectorItems);
        const hasSeenItMeta = Boolean(parsed.exportDate || parsed.preferences || parsed.gamification || parsed.deletedIds);
        if (!hasSeenItArrays && !hasSeenItMeta) return false;
        if (isTraktJsonShape(parsed)) return false;
        const firstMovie = Array.isArray(parsed.movies) ? parsed.movies[0] : null;
        const firstShow = Array.isArray(parsed.shows) ? parsed.shows[0] : null;
        if (firstMovie && firstMovie.ids && !('id_tmdb' in firstMovie)) return false;
        if (firstShow && firstShow.ids && !('id_tmdb' in firstShow)) return false;
        return true;
    }

    function flattenJsonRows(parsed) {
        const list = Array.isArray(parsed)
            ? parsed
            : (Array.isArray(parsed?.items) ? parsed.items : (Array.isArray(parsed?.data) ? parsed.data : []));
        const headerSet = new Set();
        const rows = [];
        for (const item of list) {
            if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
            const flat = {};
            for (const [k, v] of Object.entries(item)) {
                if (v == null || typeof v === 'object') continue;
                headerSet.add(k);
                flat[k] = String(v);
            }
            if (Object.keys(flat).length) rows.push(flat);
        }
        return { headers: [...headerSet], rows };
    }

    // ============================================
    // RESOLUCIÓN TMDB CON ESTRATEGIA DE CONFIANZA
    // ============================================

    function scoreTitleMatch(queryTitle, candidateTitle, candidateOrigTitle, targetYear, candidateDate) {
        const q = normalizeTitleForCompare(queryTitle);
        const c1 = normalizeTitleForCompare(candidateTitle);
        const c2 = normalizeTitleForCompare(candidateOrigTitle);
        if (!q) return 0;

        let titleScore = 0;
        if (c1 === q || c2 === q) titleScore = 100;
        else if ((c1 && (c1.startsWith(q) || q.startsWith(c1))) || (c2 && (c2.startsWith(q) || q.startsWith(c2)))) titleScore = 76;
        else {
            const qWords = new Set(q.split(' ').filter(Boolean));
            const cWords = new Set((c1 || c2).split(' ').filter(Boolean));
            let overlap = 0;
            for (const w of qWords) if (cWords.has(w)) overlap += 1;
            const union = new Set([...qWords, ...cWords]).size || 1;
            titleScore = Math.round((overlap / union) * 70);
        }

        const cYear = parseYear(candidateDate);
        let yearBonus = 0;
        if (targetYear && cYear) {
            const diff = Math.abs(targetYear - cYear);
            if (diff === 0) yearBonus = 30;
            else if (diff === 1) yearBonus = 18;
            else if (diff <= 2) yearBonus = 4;
            else yearBonus = -45;
        }

        return titleScore + yearBonus;
    }

    async function resolveRecordToTmdb(rec) {
        // 0. Coincidencia rápida en la biblioteca local para evitar llamadas extra
        const normTitle = normalizeTitleForCompare(rec.title);
        if (!rec.tmdbId && normTitle && (rec.tipo === 'movie' || rec.tipo === 'unknown')) {
            const localMovie = (AppState.movies || []).find((m) => {
                const mTitle = normalizeTitleForCompare(m.titulo || m.title);
                const mOrig = normalizeTitleForCompare(m.titulo_original || m.original_title);
                const mYear = parseYear(m.fecha_estreno);
                const titleOk = mTitle === normTitle || (mOrig && mOrig === normTitle);
                return titleOk && (!rec.year || !mYear || Math.abs(rec.year - mYear) <= 1);
            });
            if (localMovie) return { tipo: 'movie', id_tmdb: localMovie.id_tmdb };
        }
        if (!rec.tmdbId && normTitle && (rec.tipo === 'tv' || rec.tipo === 'unknown')) {
            const localShow = (AppState.shows || []).find((s) => {
                const sTitle = normalizeTitleForCompare(s.titulo || s.name);
                const sOrig = normalizeTitleForCompare(s.titulo_original || s.original_name);
                const sYear = parseYear(s.fecha_estreno);
                const titleOk = sTitle === normTitle || (sOrig && sOrig === normTitle);
                return titleOk && (!rec.year || !sYear || Math.abs(rec.year - sYear) <= 1);
            });
            if (localShow) return { tipo: 'tv', id_tmdb: localShow.id_tmdb };
        }

        // 1. TMDB ID directo
        if (rec.tmdbId) {
            if (rec.tipo === 'movie' || rec.tipo === 'tv') {
                return { tipo: rec.tipo, id_tmdb: rec.tmdbId };
            }
            try {
                await getMovieDetails(rec.tmdbId);
                return { tipo: 'movie', id_tmdb: rec.tmdbId };
            } catch (_) {
                try {
                    await getTVDetails(rec.tmdbId);
                    return { tipo: 'tv', id_tmdb: rec.tmdbId };
                } catch (_) {
                    // Continúa por título o ID externo si el ID no coincide
                }
            }
        }

        // 2. IMDb ID (tt...)
        if (rec.imdbId) {
            const found = await findByExternalId(rec.imdbId, 'imdb_id');
            if (rec.tipo === 'movie' && found.movieId) return { tipo: 'movie', id_tmdb: found.movieId };
            if (rec.tipo === 'tv' && found.tvId) return { tipo: 'tv', id_tmdb: found.tvId };
            if (rec.tipo === 'unknown') {
                if (found.movieId) return { tipo: 'movie', id_tmdb: found.movieId };
                if (found.tvId) return { tipo: 'tv', id_tmdb: found.tvId };
            }
        }

        // 3. TVDB ID (TV Time / Trakt)
        if (rec.tvdbId) {
            const found = await findByExternalId(rec.tvdbId, 'tvdb_id');
            if (found.tvId) return { tipo: 'tv', id_tmdb: found.tvId };
            if (rec.tipo !== 'tv' && found.movieId) return { tipo: 'movie', id_tmdb: found.movieId };
        }

        // 4. Búsqueda estricta por Título + Año
        if (!rec.title) return null;

        if (rec.tipo === 'movie') {
            const res = await searchMovies(rec.title, 1);
            const candidates = (res?.results || []).slice(0, 10);
            let best = null;
            let bestScore = -999;
            for (const c of candidates) {
                const s = scoreTitleMatch(rec.title, c.title, c.original_title, rec.year, c.release_date);
                if (s > bestScore) {
                    bestScore = s;
                    best = c;
                }
            }
            if (best && bestScore >= 60) {
                return { tipo: 'movie', id_tmdb: best.id };
            }
            return null;
        }

        if (rec.tipo === 'tv') {
            const res = await searchTV(rec.title, 1);
            const candidates = (res?.results || []).slice(0, 10);
            let best = null;
            let bestScore = -999;
            for (const c of candidates) {
                const s = scoreTitleMatch(rec.title, c.name, c.original_name, rec.year, c.first_air_date);
                if (s > bestScore) {
                    bestScore = s;
                    best = c;
                }
            }
            if (best && bestScore >= 60) {
                return { tipo: 'tv', id_tmdb: best.id };
            }
            return null;
        }

        const multi = await searchMulti(rec.title, 1);
        const candidates = (multi?.results || []).filter(c => c.media_type === 'movie' || c.media_type === 'tv').slice(0, 12);
        let best = null;
        let bestScore = -999;
        for (const c of candidates) {
            const cTitle = c.media_type === 'movie' ? c.title : c.name;
            const cOrig = c.media_type === 'movie' ? c.original_title : c.original_name;
            const cDate = c.media_type === 'movie' ? c.release_date : c.first_air_date;
            const s = scoreTitleMatch(rec.title, cTitle, cOrig, rec.year, cDate);
            if (s > bestScore) {
                bestScore = s;
                best = c;
            }
        }
        if (best && bestScore >= 60) {
            return { tipo: best.media_type, id_tmdb: best.id };
        }
        return null;
    }

    // ============================================
    // FUSIÓN NO DESTRUCTIVA EN BIBLIOTECA
    // ============================================

    async function applyMovieRecord(idTmdb, rec, mode) {
        const existing = (AppState.movies || []).find(m => Number(m.id_tmdb) === Number(idTmdb));
        if (existing) {
            if (mode === 'skip_existing') {
                return { action: 'skipped_existing' };
            }
            if (normalizeStatus(existing.estado) === 'pending' && rec.status === 'completed') {
                existing.estado = 'completed';
                existing.fecha_visto = rec.watchedAt || existing.fecha_visto || nowIso();
            } else if (rec.status === 'completed' && rec.watchedAt && !existing.fecha_visto) {
                existing.fecha_visto = rec.watchedAt;
            }
            if ((!existing.puntuacion || Number(existing.puntuacion) <= 0) && rec.rating10 > 0) {
                existing.puntuacion = rec.rating10;
            }
            if ((!existing.critica || !existing.critica.trim()) && rec.review) {
                existing.critica = rec.review;
            }
            if (rec.favorite) {
                existing.favorito = true;
            }
            touchUpdatedAt(existing);
            return { action: 'merged' };
        }

        const details = await getMovieDetails(idTmdb);
        details.estado = rec.status === 'completed' ? 'completed' : 'pending';
        details.fecha_visto = details.estado === 'completed' ? (rec.watchedAt || nowIso()) : null;
        details.puntuacion = rec.rating10 > 0 ? rec.rating10 : 0;
        details.critica = rec.review || '';
        details.favorito = Boolean(rec.favorite);
        const normalized = touchUpdatedAt(normalizeStoredMovie(details));
        clearItemTombstone('movie', normalized.id_tmdb);
        AppState.movies.push(normalized);
        return { action: 'added' };
    }

    async function applyShowEpisodes(show, rec, unmatchedIssues) {
        const episodesList = Array.isArray(rec.episodes) ? rec.episodes : [];
        if (episodesList.length === 0) return 0;

        const ordered = await getOrderedEpisodes(show, { includeSpecials: true });
        const validSet = new Set(ordered.map(ep => ep.id));
        if (!Array.isArray(show.capitulos_vistos)) show.capitulos_vistos = [];
        if (!Array.isArray(show.capitulos_saltados)) show.capitulos_saltados = [];
        if (!show.capitulos_vistos_fecha || typeof show.capitulos_vistos_fecha !== 'object') {
            show.capitulos_vistos_fecha = {};
        }

        const watchedSet = new Set(show.capitulos_vistos);
        let newlyMarked = 0;

        for (const ep of episodesList) {
            const epId = `S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}`;
            if (validSet.size > 0 && !validSet.has(epId)) {
                unmatchedIssues.push({
                    title: `${show.titulo || rec.title || `TMDB ${show.id_tmdb}`} (${epId})`,
                    year: rec.year || parseYear(show.fecha_estreno) || null,
                    tipo: 'tv',
                    reason: 'Episodio no localizado en TMDB',
                    searchableTitle: show.titulo || rec.title || '',
                });
                continue;
            }
            if (!watchedSet.has(epId)) {
                watchedSet.add(epId);
                show.capitulos_vistos.push(epId);
                newlyMarked += 1;
            }
            const skipIdx = show.capitulos_saltados.indexOf(epId);
            if (skipIdx > -1) show.capitulos_saltados.splice(skipIdx, 1);

            if (ep.watchedAt && !show.capitulos_vistos_fecha[epId]) {
                show.capitulos_vistos_fecha[epId] = ep.watchedAt;
            } else if (!show.capitulos_vistos_fecha[epId]) {
                show.capitulos_vistos_fecha[epId] = nowIso();
            }
        }

        await refreshShowStatus(show);
        return newlyMarked;
    }

    async function applyShowRecord(idTmdb, rec, mode, unmatchedIssues) {
        const existing = (AppState.shows || []).find(s => Number(s.id_tmdb) === Number(idTmdb));
        if (existing) {
            if (mode === 'skip_existing') {
                return { action: 'skipped_existing', episodesMarked: 0 };
            }
            if ((!existing.puntuacion || Number(existing.puntuacion) <= 0) && rec.rating10 > 0) {
                existing.puntuacion = rec.rating10;
            }
            if ((!existing.critica || !existing.critica.trim()) && rec.review) {
                existing.critica = rec.review;
            }
            if (rec.favorite) {
                existing.favorito = true;
            }

            let episodesMarked = 0;
            if (rec.episodes && rec.episodes.length > 0) {
                episodesMarked = await applyShowEpisodes(existing, rec, unmatchedIssues);
            } else if (rec.status === 'completed' && (!existing.capitulos_vistos || existing.capitulos_vistos.length === 0)) {
                const episodes = await getOrderedEpisodes(existing, { includeSpecials: shouldIncludeSpecials() });
                const airedIds = episodes.filter(isEpisodeAired).map(ep => ep.id);
                existing.capitulos_vistos = [...new Set([...(existing.capitulos_vistos || []), ...airedIds])];
                episodesMarked = airedIds.length;
                if (airedIds.length) recordEpisodesWatched(existing, airedIds);
                await refreshShowStatus(existing);
            }

            touchUpdatedAt(existing);
            return { action: 'merged', episodesMarked };
        }

        const details = await getTVDetails(idTmdb);
        const showObj = normalizeStoredShow(details);
        showObj.puntuacion = rec.rating10 > 0 ? rec.rating10 : 0;
        showObj.critica = rec.review || '';
        showObj.favorito = Boolean(rec.favorite);

        let episodesMarked = 0;
        if (rec.episodes && rec.episodes.length > 0) {
            episodesMarked = await applyShowEpisodes(showObj, rec, unmatchedIssues);
        } else if (rec.status === 'completed') {
            const episodes = await getOrderedEpisodes(showObj, { includeSpecials: shouldIncludeSpecials() });
            const airedIds = episodes.filter(isEpisodeAired).map(ep => ep.id);
            showObj.capitulos_vistos = airedIds;
            episodesMarked = airedIds.length;
            if (airedIds.length) recordEpisodesWatched(showObj, airedIds);
            await refreshShowStatus(showObj);
        } else {
            showObj.estado = rec.status === 'watching' ? 'watching' : 'pending';
        }

        touchUpdatedAt(showObj);
        clearItemTombstone('tv', showObj.id_tmdb);
        AppState.shows.push(showObj);
        return { action: 'added', episodesMarked };
    }

    // ============================================
    // IMPORTACIÓN NATIVA SEENIT (FUSIÓN O RESTAURACIÓN)
    // ============================================

    async function executeSeenItImport(data, mode) {
        if (mode === 'replace') {
            AppState.movies = (data.movies || []).map(normalizeStoredMovie);
            AppState.shows = (data.shows || []).map(normalizeStoredShow);
            AppState.lists = (data.lists || []).map(normalizeStoredList);
            AppState.selectorItems = (data.selectorItems || []).map(normalizeStoredSelectorItem).filter(Boolean);
            AppState.deletedIds = normalizeDeletedIds(data.deletedIds);
            AppState.deletedListIds = normalizeDeletedListIds(data.deletedListIds);
            AppState.deletedSelectorKeys = normalizeDeletedSelectorKeys(data.deletedSelectorKeys);
            if (data.preferences) {
                AppState.preferences = normalizePreferences(data.preferences);
                if (typeof window.clearWatchProvidersCache === 'function') {
                    window.clearWatchProvidersCache();
                }
            }
            AppState.gamification = normalizeGamificationState(data.gamification);
            migrationState.progress.addedMovies = AppState.movies.length;
            migrationState.progress.addedShows = AppState.shows.length;
        } else {
            const prevMovieIds = new Set((AppState.movies || []).map(m => Number(m.id_tmdb)));
            const prevShowIds = new Set((AppState.shows || []).map(s => Number(s.id_tmdb)));
            const merged = mergeLibraries(
                {
                    movies: AppState.movies,
                    shows: AppState.shows,
                    lists: AppState.lists,
                    selectorItems: AppState.selectorItems,
                    deletedIds: AppState.deletedIds,
                    deletedListIds: AppState.deletedListIds,
                    deletedSelectorKeys: AppState.deletedSelectorKeys,
                    preferences: getPreferences(),
                    gamification: getGamificationState(),
                },
                {
                    movies: data.movies || [],
                    shows: data.shows || [],
                    lists: data.lists || [],
                    selectorItems: data.selectorItems || [],
                    deletedIds: data.deletedIds,
                    deletedListIds: data.deletedListIds,
                    deletedSelectorKeys: data.deletedSelectorKeys,
                    preferences: data.preferences,
                    gamification: data.gamification,
                },
            );
            AppState.movies = merged.movies;
            AppState.shows = merged.shows;
            AppState.lists = merged.lists;
            AppState.selectorItems = merged.selectorItems;
            AppState.deletedIds = merged.deletedIds;
            AppState.deletedListIds = merged.deletedListIds;
            AppState.deletedSelectorKeys = merged.deletedSelectorKeys;

            migrationState.progress.addedMovies = AppState.movies.filter(m => !prevMovieIds.has(Number(m.id_tmdb))).length;
            migrationState.progress.mergedMovies = (data.movies || []).filter(m => prevMovieIds.has(Number(m.id_tmdb))).length;
            migrationState.progress.addedShows = AppState.shows.filter(s => !prevShowIds.has(Number(s.id_tmdb))).length;
            migrationState.progress.mergedShows = (data.shows || []).filter(s => prevShowIds.has(Number(s.id_tmdb))).length;
        }

        evaluateGamification({ silent: true, skipSave: true });
        applyGamificationAppearance();
        invalidateTimelineCaches();
        flushSaveLocalData();
        saveLocalDataImmediate();
        await syncToDriveNow();
        await renderCurrentView();
        migrationState.step = 'summary';
        renderUniversalImportModalBody();
    }

    // ============================================
    // PROCESAMIENTO POR LOTES Y CANCELACIÓN
    // ============================================

    function rebuildRecordsFromCurrentMapping() {
        const result = buildRecordsFromCsvRows(
            migrationState.sourceId,
            migrationState.rawHeaders,
            migrationState.rawRows,
            migrationState.mapping,
        );
        migrationState.records = result.records;
        migrationState.issues = result.invalidIssues;
    }

    async function startUniversalImport() {
        if (migrationState.running) return;

        if (migrationState.sourceId === 'seenit' && migrationState.seenitPayload) {
            await executeSeenItImport(migrationState.seenitPayload, migrationState.seenitMode);
            return;
        }

        if (migrationState.sourceId === 'custom_csv' || migrationState.sourceId === 'custom_json' || migrationState.sourceId === 'trakt_csv') {
            rebuildRecordsFromCurrentMapping();
            if (!migrationState.mapping.title && !migrationState.mapping.externalId) {
                showToast('Selecciona al menos la columna de Título o de ID externo', 'info');
                return;
            }
        }

        const queue = [...migrationState.records];
        const total = queue.length;
        if (total === 0 && migrationState.issues.length === 0) {
            showToast('No hay registros válidos para importar', 'info');
            return;
        }

        migrationState.step = 'running';
        migrationState.running = true;
        migrationState.cancelled = false;
        migrationState.progress = {
            processed: 0,
            total,
            addedMovies: 0,
            mergedMovies: 0,
            addedShows: 0,
            mergedShows: 0,
            episodesMarked: 0,
            skippedExisting: 0,
            currentTitle: '',
        };
        const preIssues = [...migrationState.issues];
        migrationState.issues = preIssues;
        renderUniversalImportModalBody();

        let cursor = 0;

        async function worker() {
            while (cursor < queue.length && !migrationState.cancelled) {
                const idx = cursor;
                cursor += 1;
                const rec = queue[idx];
                const label = rec.title || (rec.imdbId ? `IMDb ${rec.imdbId}` : (rec.tvdbId ? `TVDB ${rec.tvdbId}` : `TMDB ${rec.tmdbId}`));
                migrationState.progress.currentTitle = label;
                updateImportProgressUi();

                try {
                    const resolved = await resolveRecordToTmdb(rec);
                    if (migrationState.cancelled) {
                        migrationState.issues.push({
                            title: label,
                            year: rec.year || null,
                            tipo: rec.tipo || 'unknown',
                            reason: 'Cancelado antes de completar',
                            searchableTitle: rec.title || '',
                        });
                        break;
                    }

                    if (!resolved) {
                        migrationState.issues.push({
                            title: label,
                            year: rec.year || null,
                            tipo: rec.tipo || 'unknown',
                            reason: 'No encontrado en TMDB',
                            searchableTitle: rec.title || '',
                        });
                    } else if (resolved.tipo === 'movie') {
                        const res = await applyMovieRecord(resolved.id_tmdb, rec, migrationState.duplicateMode);
                        if (res.action === 'added') migrationState.progress.addedMovies += 1;
                        else if (res.action === 'merged') migrationState.progress.mergedMovies += 1;
                        else if (res.action === 'skipped_existing') migrationState.progress.skippedExisting += 1;
                    } else if (resolved.tipo === 'tv') {
                        const res = await applyShowRecord(resolved.id_tmdb, rec, migrationState.duplicateMode, migrationState.issues);
                        if (res.action === 'added') migrationState.progress.addedShows += 1;
                        else if (res.action === 'merged') migrationState.progress.mergedShows += 1;
                        else if (res.action === 'skipped_existing') migrationState.progress.skippedExisting += 1;
                        migrationState.progress.episodesMarked += res.episodesMarked || 0;
                    }
                } catch (err) {
                    console.warn('[Migration] Error importando registro:', label, err);
                    const isConfigErr = String(err?.message || '').includes('CONFIG_TMDB_MISSING');
                    migrationState.issues.push({
                        title: label,
                        year: rec.year || null,
                        tipo: rec.tipo || 'unknown',
                        reason: isConfigErr ? 'TMDB no configurado' : 'Error de red o límite de TMDB',
                        searchableTitle: rec.title || '',
                    });
                } finally {
                    migrationState.progress.processed += 1;
                    updateImportProgressUi();
                }
            }
        }

        const workers = [];
        const concurrency = Math.min(IMPORT_TMDB_CONCURRENCY, Math.max(1, total));
        for (let i = 0; i < concurrency; i += 1) {
            workers.push(worker());
        }
        await Promise.all(workers);

        if (migrationState.cancelled && cursor < queue.length) {
            for (let i = cursor; i < queue.length; i += 1) {
                const rec = queue[i];
                const label = rec.title || rec.imdbId || (rec.tvdbId ? `TVDB ${rec.tvdbId}` : `TMDB ${rec.tmdbId}`);
                migrationState.issues.push({
                    title: label,
                    year: rec.year || null,
                    tipo: rec.tipo || 'unknown',
                    reason: 'Cancelado antes de procesarse',
                    searchableTitle: rec.title || '',
                });
            }
        }

        migrationState.running = false;
        evaluateGamification({ silent: true, skipSave: true });
        applyGamificationAppearance();
        invalidateTimelineCaches();
        flushSaveLocalData();
        saveLocalDataImmediate();
        try {
            await syncToDriveNow();
        } catch (_) {
            /* sync debounce fallback */
        }
        await renderCurrentView();

        migrationState.step = 'summary';
        renderUniversalImportModalBody();
    }

    function cancelUniversalImport() {
        if (!migrationState.running) {
            closeUniversalImportModal();
            return;
        }
        migrationState.cancelled = true;
        const btn = document.getElementById('univ-import-cancel-btn');
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Cancelando…';
        }
    }

    // ============================================
    // EXPORTADORES MULTIFORMATO (CON ANTI-FÓRMULA CSV)
    // ============================================

    function sanitizeCsvCell(value) {
        let str = String(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        if (/^[=+\-@\t]/.test(str)) {
            str = `'${str}`;
        }
        if (/[",\n;]/.test(str)) {
            return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
    }

    function downloadTextFile(filename, content, mimeType) {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    function exportUniversalCsv() {
        const headers = [
            'Title',
            'Type',
            'Year',
            'tmdbID',
            'Status',
            'Rating10',
            'Favorite',
            'Review',
            'WatchedEpisodes',
            'TotalEpisodes',
            'UpdatedAt',
        ];
        const lines = [headers.join(',')];

        for (const m of (AppState.movies || [])) {
            const year = parseYear(m.fecha_estreno) || '';
            const status = normalizeStatus(m.estado) === 'completed' ? 'completed' : 'pending';
            const row = [
                m.titulo || m.title || '',
                'movie',
                year,
                m.id_tmdb || '',
                status,
                Number(m.puntuacion) > 0 ? Number(m.puntuacion) : '',
                m.favorito ? 'true' : 'false',
                m.critica || '',
                '',
                '',
                m.updatedAt || '',
            ];
            lines.push(row.map(sanitizeCsvCell).join(','));
        }

        for (const s of (AppState.shows || [])) {
            const year = parseYear(s.fecha_estreno) || '';
            const status = normalizeStatus(s.estado);
            const watchedEps = Array.isArray(s.capitulos_vistos) ? s.capitulos_vistos.join(' ') : '';
            const row = [
                s.titulo || s.name || '',
                'tv',
                year,
                s.id_tmdb || '',
                status,
                Number(s.puntuacion) > 0 ? Number(s.puntuacion) : '',
                s.favorito ? 'true' : 'false',
                s.critica || '',
                watchedEps,
                Number(s.episodios_emitidos) || '',
                s.updatedAt || '',
            ];
            lines.push(row.map(sanitizeCsvCell).join(','));
        }

        const dateTag = new Date().toISOString().split('T')[0];
        downloadTextFile(`seenit_universal_${dateTag}.csv`, `\uFEFF${lines.join('\n')}`, 'text/csv;charset=utf-8');
        showToast('CSV Universal exportado', 'success');
    }

    async function exportLetterboxdCsv() {
        const movies = AppState.movies || [];
        const watched = movies.filter(m => normalizeStatus(m.estado) === 'completed' || Number(m.puntuacion) > 0 || Boolean((m.critica || '').trim()));
        const pending = movies.filter(m => normalizeStatus(m.estado) === 'pending' && !(Number(m.puntuacion) > 0));

        let exportMode = 'watched';
        if (pending.length > 0 && watched.length > 0) {
            const exportPendingOnly = await showConfirmDialog({
                title: 'Exportar para Letterboxd',
                message: `Tienes ${watched.length} películas vistas/puntuadas y ${pending.length} pendientes. Letterboxd importa vistas y watchlist en archivos separados: ¿qué quieres exportar ahora?`,
                confirmText: `Vistas y notas (${watched.length})`,
                cancelText: `Solo pendientes (${pending.length})`,
            });
            exportMode = exportPendingOnly ? 'watched' : 'watchlist';
        } else if (watched.length === 0 && pending.length > 0) {
            exportMode = 'watchlist';
        }

        const sourceList = exportMode === 'watchlist' ? pending : watched;
        if (sourceList.length === 0) {
            showToast('No hay películas para exportar a Letterboxd', 'info');
            return;
        }

        const headers = exportMode === 'watchlist'
            ? ['Title', 'Year', 'tmdbID']
            : ['Title', 'Year', 'Rating', 'tmdbID', 'WatchedDate', 'Review', 'Tags'];
        const lines = [headers.join(',')];

        for (const m of sourceList) {
            const year = parseYear(m.fecha_estreno) || '';
            if (exportMode === 'watchlist') {
                lines.push([m.titulo || '', year, m.id_tmdb || ''].map(sanitizeCsvCell).join(','));
            } else {
                const r10 = Number(m.puntuacion) || 0;
                const rating5 = r10 > 0 ? String(Math.round(r10) / 2) : '';
                const watchStamp = m.fecha_visto || m.updatedAt;
                const watchedDate = watchStamp ? String(watchStamp).slice(0, 10) : '';
                const tags = m.favorito ? 'favorite' : '';
                lines.push([
                    m.titulo || '',
                    year,
                    rating5,
                    m.id_tmdb || '',
                    watchedDate,
                    m.critica || '',
                    tags,
                ].map(sanitizeCsvCell).join(','));
            }
        }

        const dateTag = new Date().toISOString().split('T')[0];
        const suffix = exportMode === 'watchlist' ? 'watchlist' : 'watched';
        downloadTextFile(`seenit_letterboxd_${suffix}_${dateTag}.csv`, `\uFEFF${lines.join('\n')}`, 'text/csv;charset=utf-8');
        showToast(`CSV para Letterboxd (${suffix}) exportado`, 'success');
    }

    function exportTraktJson() {
        const movies = (AppState.movies || []).map((m) => {
            const year = parseYear(m.fecha_estreno) || undefined;
            const watched = normalizeStatus(m.estado) === 'completed';
            return {
                title: m.titulo || '',
                year,
                ids: { tmdb: Number(m.id_tmdb) },
                plays: watched ? 1 : 0,
                last_watched_at: watched ? (m.fecha_visto || m.updatedAt || nowIso()) : undefined,
                rating: Number(m.puntuacion) > 0 ? Number(m.puntuacion) : undefined,
                watchlist: !watched,
            };
        });

        const shows = (AppState.shows || []).map((s) => {
            const year = parseYear(s.fecha_estreno) || undefined;
            const bySeason = new Map();
            const datesMap = s.capitulos_vistos_fecha || {};

            for (const epId of (s.capitulos_vistos || [])) {
                const match = String(epId).match(/^S(\d+)E(\d+)$/i);
                if (!match) continue;
                const sNum = Number(match[1]);
                const eNum = Number(match[2]);
                if (!bySeason.has(sNum)) bySeason.set(sNum, []);
                bySeason.get(sNum).push({
                    number: eNum,
                    watched_at: datesMap[epId] || s.updatedAt || nowIso(),
                });
            }

            const seasons = [...bySeason.entries()]
                .sort((a, b) => a[0] - b[0])
                .map(([number, episodes]) => ({
                    number,
                    episodes: episodes.sort((a, b) => a.number - b.number),
                }));

            const watchedCount = Array.isArray(s.capitulos_vistos) ? s.capitulos_vistos.length : 0;
            return {
                title: s.titulo || '',
                year,
                ids: { tmdb: Number(s.id_tmdb) },
                last_watched_at: watchedCount > 0 ? (s.updatedAt || nowIso()) : undefined,
                rating: Number(s.puntuacion) > 0 ? Number(s.puntuacion) : undefined,
                watchlist: normalizeStatus(s.estado) === 'pending' && watchedCount === 0,
                seasons,
            };
        });

        const payload = {
            source: 'seenit',
            exported_at: new Date().toISOString(),
            movies,
            shows,
        };
        const dateTag = new Date().toISOString().split('T')[0];
        downloadTextFile(`seenit_trakt_${dateTag}.json`, JSON.stringify(payload, null, 2), 'application/json');
        showToast('Esquema Trakt JSON exportado', 'success');
    }

    function exportIssuesCsv() {
        if (!migrationState.issues.length) return;
        const headers = ['Title', 'Year', 'Type', 'Reason'];
        const lines = [headers.join(',')];
        for (const issue of migrationState.issues) {
            lines.push([
                issue.title || '',
                issue.year || '',
                issue.tipo === 'movie' ? 'movie' : (issue.tipo === 'tv' ? 'tv' : 'unknown'),
                issue.reason || '',
            ].map(sanitizeCsvCell).join(','));
        }
        const dateTag = new Date().toISOString().split('T')[0];
        downloadTextFile(`seenit_no_importados_${dateTag}.csv`, `\uFEFF${lines.join('\n')}`, 'text/csv;charset=utf-8');
        showToast('Informe de no importados descargado', 'success');
    }

    async function copyIssuesToClipboard() {
        if (!migrationState.issues.length) return;
        const text = migrationState.issues
            .map(i => `${i.title}${i.year ? ` (${i.year})` : ''} — ${i.reason}`)
            .join('\n');
        try {
            await navigator.clipboard.writeText(text);
            showToast('Listado copiado al portapapeles', 'success');
        } catch (_) {
            showToast('No se pudo copiar automáticamente; usa Descargar informe (.csv)', 'info');
        }
    }

    function searchIssueInExplore(encodedTitle) {
        let query = '';
        try {
            query = decodeURIComponent(encodedTitle || '').trim();
        } catch (_) {
            query = String(encodedTitle || '').trim();
        }
        if (!query) return;
        closeUniversalImportModal();
        switchTab('explore');
        requestAnimationFrame(() => {
            const input = document.getElementById('search-input');
            if (input) {
                input.value = query;
                input.focus();
                handleSearch({ target: input });
            }
        });
    }

    // ============================================
    // CARGA DE ARCHIVO Y RENDER DEL ASISTENTE MODAL
    // ============================================

    function handleUniversalFileSelected(file) {
        if (!file) return;
        const lowerName = String(file.name || '').toLowerCase();

        if (lowerName.endsWith('.zip')) {
            showToast('Descomprime el .zip primero y selecciona el archivo .csv o .json interior', 'info');
            return;
        }
        if (file.size > MAX_IMPORT_FILE_BYTES) {
            showToast('El archivo supera el límite de 25 MB', 'error');
            return;
        }

        const reader = new FileReader();
        reader.onload = (ev) => {
            const text = String(ev?.target?.result || '');
            if (!text.trim()) {
                showToast('El archivo está vacío', 'error');
                return;
            }

            migrationState.fileName = file.name;
            migrationState.fileExt = lowerName.endsWith('.json') ? 'json' : 'csv';
            migrationState.seenitPayload = null;
            migrationState.rawHeaders = [];
            migrationState.rawRows = [];
            migrationState.records = [];
            migrationState.issues = [];

            const looksJson = migrationState.fileExt === 'json' || /^\s*[\[{]/.test(text);
            if (looksJson) {
                try {
                    const parsed = JSON.parse(text);
                    if (isSeenItBackupShape(parsed)) {
                        migrationState.sourceId = 'seenit';
                        migrationState.seenitPayload = parsed;
                        migrationState.step = 'preview';
                        renderUniversalImportModalBody();
                        return;
                    }
                    if (isTraktJsonShape(parsed)) {
                        migrationState.sourceId = 'trakt_json';
                        const res = parseTraktJsonPayload(parsed, file.name);
                        migrationState.records = res.records;
                        migrationState.issues = res.invalidIssues;
                        migrationState.step = 'preview';
                        renderUniversalImportModalBody();
                        return;
                    }
                    const flattened = flattenJsonRows(parsed);
                    if (!flattened.rows.length) {
                        showToast('El JSON no contiene registros reconocibles', 'error');
                        return;
                    }
                    migrationState.sourceId = 'custom_json';
                    migrationState.rawHeaders = flattened.headers;
                    migrationState.rawRows = flattened.rows;
                    migrationState.mapping = guessMappingFromHeaders(flattened.headers);
                    rebuildRecordsFromCurrentMapping();
                    migrationState.step = 'preview';
                    renderUniversalImportModalBody();
                    return;
                } catch (err) {
                    if (migrationState.fileExt === 'json') {
                        showToast('El archivo JSON no es válido', 'error');
                        return;
                    }
                }
            }

            // Parseo CSV
            const { headers, rows } = parseCsv(text);
            if (!headers.length || !rows.length) {
                showToast('No se encontraron filas válidas en el CSV', 'error');
                return;
            }
            const detected = detectCsvSource(headers, file.name);
            migrationState.sourceId = detected;
            migrationState.rawHeaders = headers;
            migrationState.rawRows = rows;
            migrationState.mapping = guessMappingFromHeaders(headers);

            const built = buildRecordsFromCsvRows(detected, headers, rows, migrationState.mapping);
            migrationState.records = built.records;
            migrationState.issues = built.invalidIssues;
            migrationState.step = 'preview';
            renderUniversalImportModalBody();
        };
        reader.onerror = () => {
            showToast('No se pudo leer el archivo seleccionado', 'error');
        };
        reader.readAsText(file);
    }

    function onUniversalFileInputChange(event) {
        const file = event?.target?.files?.[0];
        if (file) handleUniversalFileSelected(file);
        if (event?.target) event.target.value = '';
    }

    function onUniversalMappingChange(field, value) {
        migrationState.mapping[field] = value;
        if (field === 'externalId') {
            const norm = normalizeHeaderKey(value);
            if (norm.includes('imdb') || norm === 'const') migrationState.mapping.externalIdKind = 'imdb';
            else if (norm.includes('tvdb')) migrationState.mapping.externalIdKind = 'tvdb';
            else migrationState.mapping.externalIdKind = 'tmdb';
        }
        rebuildRecordsFromCurrentMapping();
        renderUniversalImportModalBody();
    }

    function setUniversalDuplicateMode(mode) {
        migrationState.duplicateMode = mode === 'skip_existing' ? 'skip_existing' : 'merge';
        renderUniversalImportModalBody();
    }

    function setUniversalSeenItMode(mode) {
        migrationState.seenitMode = mode === 'replace' ? 'replace' : 'merge';
        renderUniversalImportModalBody();
    }

    function updateImportProgressUi() {
        const p = migrationState.progress;
        const pct = p.total > 0 ? Math.min(100, Math.round((p.processed / p.total) * 100)) : 100;
        const bar = document.getElementById('univ-import-bar-fill');
        const label = document.getElementById('univ-import-count-label');
        const current = document.getElementById('univ-import-current-title');
        const addedEl = document.getElementById('univ-stat-added');
        const mergedEl = document.getElementById('univ-stat-merged');
        const issuesEl = document.getElementById('univ-stat-issues');

        if (bar) bar.style.width = `${pct}%`;
        if (label) label.textContent = `${p.processed} / ${p.total} procesados (${pct}%)`;
        if (current) current.textContent = p.currentTitle ? `Procesando: ${p.currentTitle}` : 'Preparando…';
        if (addedEl) addedEl.textContent = String(p.addedMovies + p.addedShows);
        if (mergedEl) mergedEl.textContent = String(p.mergedMovies + p.mergedShows);
        if (issuesEl) issuesEl.textContent = String(migrationState.issues.length);
    }

    function renderUniversalImportModalBody() {
        const body = document.getElementById('universal-import-modal-body');
        if (!body) return;

        if (migrationState.step === 'select') {
            body.innerHTML = `
                <div class="tvst-import-step">
                    <label class="tvst-import-dropzone" id="univ-import-dropzone" for="univ-import-file">
                        <span class="tvst-import-drop-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg>
                        </span>
                        <strong class="tvst-import-drop-title">Selecciona o arrastra tu archivo (.csv o .json)</strong>
                        <span class="tvst-import-drop-sub">Si tu copia viene en .zip (Trakt o TV Time), extrae el archivo .csv o .json interior antes de subirlo.</span>
                        <input type="file" id="univ-import-file" accept=".csv,.json,text/csv,application/json" class="hidden" onchange="onUniversalFileInputChange(event)">
                    </label>

                    <div class="tvst-import-compat-box">
                        <h3 class="tvst-import-subhead">Plataformas y formatos compatibles</h3>
                        <ul class="tvst-compat-list is-compact">
                            ${PLATFORM_DIRECTORY.map(p => `
                                <li class="tvst-compat-row">
                                    <div class="tvst-compat-main">
                                        <span class="tvst-compat-name">${esc(p.name)}</span>
                                        <span class="tvst-compat-meta">${esc(p.importLabel)} · ${esc(p.details)}</span>
                                    </div>
                                </li>
                            `).join('')}
                        </ul>
                    </div>
                </div>
            `;
            bindDropzoneEvents();
            return;
        }

        if (migrationState.step === 'preview') {
            const sourceName = SOURCE_LABELS[migrationState.sourceId] || 'Archivo detectado';
            if (migrationState.sourceId === 'seenit' && migrationState.seenitPayload) {
                const d = migrationState.seenitPayload;
                const mCount = Array.isArray(d.movies) ? d.movies.length : 0;
                const sCount = Array.isArray(d.shows) ? d.shows.length : 0;
                const lCount = Array.isArray(d.lists) ? d.lists.length : 0;
                body.innerHTML = `
                    <div class="tvst-import-step">
                        <div class="tvst-import-detected">
                            <span class="tvst-import-kicker">Origen detectado</span>
                            <strong class="tvst-import-source">${esc(sourceName)}</strong>
                            <p class="tvst-import-meta-line">${esc(migrationState.fileName)} · ${mCount} películas · ${sCount} series · ${lCount} listas</p>
                        </div>

                        <div class="tvst-import-mode-group">
                            <span class="tvst-import-subhead">¿Cómo quieres aplicarlo?</span>
                            <div class="tvst-import-mode-options">
                                <button type="button" class="tvst-import-mode-btn${migrationState.seenitMode === 'merge' ? ' is-active' : ''}" onclick="setUniversalSeenItMode('merge')">
                                    <strong>Fusionar sin borrar mis datos actuales</strong>
                                    <span>Mantiene tu biblioteca y añade o combina lo que falte.</span>
                                </button>
                                <button type="button" class="tvst-import-mode-btn${migrationState.seenitMode === 'replace' ? ' is-active' : ''}" onclick="setUniversalSeenItMode('replace')">
                                    <strong>Restaurar copia completa</strong>
                                    <span>Reemplaza películas, series, listas y ajustes con este archivo.</span>
                                </button>
                            </div>
                        </div>

                        <div class="tvst-import-footer-actions">
                            <button type="button" class="tvst-settings-btn" onclick="resetUniversalImportWizard()">Elegir otro archivo</button>
                            <button type="button" class="tvst-settings-btn is-primary" onclick="startUniversalImport()">Aplicar copia</button>
                        </div>
                    </div>
                `;
                return;
            }

            const needsMapper = migrationState.sourceId === 'custom_csv' || migrationState.sourceId === 'custom_json' || migrationState.sourceId === 'trakt_csv';
            const totalRecords = migrationState.records.length;
            const movieRecords = migrationState.records.filter(r => r.tipo === 'movie').length;
            const tvRecords = migrationState.records.filter(r => r.tipo === 'tv').length;
            const epRecords = migrationState.records.reduce((acc, r) => acc + (r.episodes?.length || 0), 0);
            const previewItems = migrationState.records.slice(0, 4);

            const colOptions = (selected) => {
                const opts = ['<option value="">No usar</option>'];
                for (const h of migrationState.rawHeaders) {
                    opts.push(`<option value="${esc(h)}"${selected === h ? ' selected' : ''}>${esc(h)}</option>`);
                }
                return opts.join('');
            };

            body.innerHTML = `
                <div class="tvst-import-step">
                    <div class="tvst-import-detected">
                        <span class="tvst-import-kicker">Origen detectado</span>
                        <strong class="tvst-import-source">${esc(sourceName)}</strong>
                        <p class="tvst-import-meta-line">${esc(migrationState.fileName)} · ${totalRecords} títulos únicos (${movieRecords} pelis · ${tvRecords} series${epRecords ? ` · ${epRecords} episodios` : ''})</p>
                    </div>

                    ${needsMapper ? `
                        <div class="tvst-import-mapper">
                            <h3 class="tvst-import-subhead">Asignación de columnas</h3>
                            <div class="tvst-import-mapper-grid">
                                <label class="tvst-mapper-field">
                                    <span>Título</span>
                                    <select class="tvst-setting-select" onchange="onUniversalMappingChange('title', this.value)">${colOptions(migrationState.mapping.title)}</select>
                                </label>
                                <label class="tvst-mapper-field">
                                    <span>Año</span>
                                    <select class="tvst-setting-select" onchange="onUniversalMappingChange('year', this.value)">${colOptions(migrationState.mapping.year)}</select>
                                </label>
                                <label class="tvst-mapper-field">
                                    <span>Tipo de contenido</span>
                                    <select class="tvst-setting-select" onchange="onUniversalMappingChange('typeMode', this.value)">
                                        <option value="auto"${migrationState.mapping.typeMode === 'auto' ? ' selected' : ''}>Detectar automáticamente</option>
                                        <option value="column"${migrationState.mapping.typeMode === 'column' ? ' selected' : ''}>Usar columna del archivo</option>
                                        <option value="movie"${migrationState.mapping.typeMode === 'movie' ? ' selected' : ''}>Todo son Películas</option>
                                        <option value="tv"${migrationState.mapping.typeMode === 'tv' ? ' selected' : ''}>Todo son Series</option>
                                    </select>
                                </label>
                                ${migrationState.mapping.typeMode === 'column' ? `
                                    <label class="tvst-mapper-field">
                                        <span>Columna de Tipo</span>
                                        <select class="tvst-setting-select" onchange="onUniversalMappingChange('typeCol', this.value)">${colOptions(migrationState.mapping.typeCol)}</select>
                                    </label>
                                ` : ''}
                                <label class="tvst-mapper-field">
                                    <span>ID externo (TMDB / IMDb / TVDB)</span>
                                    <select class="tvst-setting-select" onchange="onUniversalMappingChange('externalId', this.value)">${colOptions(migrationState.mapping.externalId)}</select>
                                </label>
                                <label class="tvst-mapper-field">
                                    <span>Estado inicial</span>
                                    <select class="tvst-setting-select" onchange="onUniversalMappingChange('statusMode', this.value)">
                                        <option value="completed"${migrationState.mapping.statusMode === 'completed' ? ' selected' : ''}>Marcar como Vista</option>
                                        <option value="pending"${migrationState.mapping.statusMode === 'pending' ? ' selected' : ''}>Marcar como Pendiente</option>
                                        <option value="column"${migrationState.mapping.statusMode === 'column' ? ' selected' : ''}>Usar columna del archivo</option>
                                    </select>
                                </label>
                                ${migrationState.mapping.statusMode === 'column' ? `
                                    <label class="tvst-mapper-field">
                                        <span>Columna de Estado</span>
                                        <select class="tvst-setting-select" onchange="onUniversalMappingChange('statusCol', this.value)">${colOptions(migrationState.mapping.statusCol)}</select>
                                    </label>
                                ` : ''}
                                <label class="tvst-mapper-field">
                                    <span>Puntuación</span>
                                    <select class="tvst-setting-select" onchange="onUniversalMappingChange('rating', this.value)">${colOptions(migrationState.mapping.rating)}</select>
                                </label>
                                ${migrationState.mapping.rating ? `
                                    <label class="tvst-mapper-field">
                                        <span>Escala de nota</span>
                                        <select class="tvst-setting-select" onchange="onUniversalMappingChange('ratingScale', this.value)">
                                            <option value="10"${migrationState.mapping.ratingScale === '10' ? ' selected' : ''}>Sobre 10 (1–10)</option>
                                            <option value="5"${migrationState.mapping.ratingScale === '5' ? ' selected' : ''}>Estrellas (0.5–5)</option>
                                        </select>
                                    </label>
                                ` : ''}
                                <label class="tvst-mapper-field">
                                    <span>Crítica / Reseña</span>
                                    <select class="tvst-setting-select" onchange="onUniversalMappingChange('review', this.value)">${colOptions(migrationState.mapping.review)}</select>
                                </label>
                                <label class="tvst-mapper-field">
                                    <span>Temporada (opcional)</span>
                                    <select class="tvst-setting-select" onchange="onUniversalMappingChange('season', this.value)">${colOptions(migrationState.mapping.season)}</select>
                                </label>
                                <label class="tvst-mapper-field">
                                    <span>Episodio (opcional)</span>
                                    <select class="tvst-setting-select" onchange="onUniversalMappingChange('episode', this.value)">${colOptions(migrationState.mapping.episode)}</select>
                                </label>
                            </div>
                        </div>
                    ` : ''}

                    <div class="tvst-import-mode-group">
                        <span class="tvst-import-subhead">Gestión de duplicados</span>
                        <div class="tvst-import-mode-options">
                            <button type="button" class="tvst-import-mode-btn${migrationState.duplicateMode === 'merge' ? ' is-active' : ''}" onclick="setUniversalDuplicateMode('merge')">
                                <strong>Fusionar sin borrar mis datos actuales</strong>
                                <span>Conserva tus notas, críticas y capítulos ya vistos; completa vacíos y añade episodios nuevos.</span>
                            </button>
                            <button type="button" class="tvst-import-mode-btn${migrationState.duplicateMode === 'skip_existing' ? ' is-active' : ''}" onclick="setUniversalDuplicateMode('skip_existing')">
                                <strong>Solo añadir títulos nuevos</strong>
                                <span>Omite por completo películas o series que ya tengas guardadas.</span>
                            </button>
                        </div>
                    </div>

                    ${previewItems.length ? `
                        <div class="tvst-import-preview-box">
                            <h3 class="tvst-import-subhead">Vista previa</h3>
                            <ul class="tvst-import-preview-list">
                                ${previewItems.map(r => {
                                    const meta = [
                                        r.tipo === 'movie' ? 'Película' : (r.tipo === 'tv' ? 'Serie' : 'Auto'),
                                        r.year || null,
                                        r.imdbId || (r.tvdbId ? `TVDB ${r.tvdbId}` : (r.tmdbId ? `TMDB ${r.tmdbId}` : null)),
                                        r.rating10 > 0 ? `Nota ${r.rating10}/10` : null,
                                        r.episodes?.length ? `${r.episodes.length} eps` : null,
                                    ].filter(Boolean).join(' · ');
                                    return `
                                        <li class="tvst-import-preview-row">
                                            <strong>${esc(r.title || r.imdbId || `TVDB ${r.tvdbId}` || `TMDB ${r.tmdbId}`)}</strong>
                                            <span>${esc(meta)}</span>
                                        </li>
                                    `;
                                }).join('')}
                            </ul>
                        </div>
                    ` : ''}

                    ${migrationState.issues.length ? `
                        <p class="tvst-import-prewarn">${migrationState.issues.length} fila(s) del archivo tienen formato incompleto o tipo incompatible y se detallarán en el informe final.</p>
                    ` : ''}

                    <div class="tvst-import-footer-actions">
                        <button type="button" class="tvst-settings-btn" onclick="resetUniversalImportWizard()">Elegir otro archivo</button>
                        <button type="button" class="tvst-settings-btn is-primary" onclick="startUniversalImport()">Importar ${totalRecords} título(s)</button>
                    </div>
                </div>
            `;
            return;
        }

        if (migrationState.step === 'running') {
            const p = migrationState.progress;
            const pct = p.total > 0 ? Math.min(100, Math.round((p.processed / p.total) * 100)) : 0;
            body.innerHTML = `
                <div class="tvst-import-step">
                    <div class="tvst-import-progress-card">
                        <strong class="tvst-import-progress-title" id="univ-import-count-label">${p.processed} / ${p.total} procesados (${pct}%)</strong>
                        <p class="tvst-import-meta-line" id="univ-import-current-title">Iniciando búsqueda en TMDB…</p>
                        <div class="tvst-gamif-xp-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
                            <div id="univ-import-bar-fill" class="tvst-gamif-xp-fill" style="width:${pct}%"></div>
                        </div>
                        <div class="tvst-import-kpi-grid">
                            <div class="tvst-import-kpi">
                                <span>Añadidos</span>
                                <strong id="univ-stat-added">${p.addedMovies + p.addedShows}</strong>
                            </div>
                            <div class="tvst-import-kpi">
                                <span>Fusionados</span>
                                <strong id="univ-stat-merged">${p.mergedMovies + p.mergedShows}</strong>
                            </div>
                            <div class="tvst-import-kpi">
                                <span>No importados</span>
                                <strong id="univ-stat-issues">${migrationState.issues.length}</strong>
                            </div>
                        </div>
                    </div>
                    <div class="tvst-import-footer-actions">
                        <button type="button" id="univ-import-cancel-btn" class="tvst-settings-btn is-danger" onclick="cancelUniversalImport()">Cancelar importación</button>
                    </div>
                </div>
            `;
            return;
        }

        // step === 'summary'
        const p = migrationState.progress;
        const issues = migrationState.issues;
        const hasIssues = issues.length > 0;
        const totalImported = p.addedMovies + p.mergedMovies + p.addedShows + p.mergedShows;

        body.innerHTML = `
            <div class="tvst-import-step">
                <div class="tvst-import-summary-banner${hasIssues ? ' has-warnings' : ''}">
                    <strong>${migrationState.cancelled ? 'Importación cancelada' : 'Importación completada'}</strong>
                    <span>${totalImported} títulos aplicados${p.episodesMarked ? ` · ${p.episodesMarked} episodios marcados` : ''}${p.skippedExisting ? ` · ${p.skippedExisting} ya estaban en tu lista` : ''}.</span>
                </div>

                <div class="tvst-import-kpi-grid is-four">
                    <div class="tvst-import-kpi">
                        <span>Pelis añadidas</span>
                        <strong>${p.addedMovies}</strong>
                    </div>
                    <div class="tvst-import-kpi">
                        <span>Series añadidas</span>
                        <strong>${p.addedShows}</strong>
                    </div>
                    <div class="tvst-import-kpi">
                        <span>Fusionados</span>
                        <strong>${p.mergedMovies + p.mergedShows}</strong>
                    </div>
                    <div class="tvst-import-kpi${hasIssues ? ' is-warn' : ''}">
                        <span>No importados</span>
                        <strong>${issues.length}</strong>
                    </div>
                </div>

                ${hasIssues ? `
                    <div class="tvst-import-issues-box">
                        <div class="tvst-import-issues-head">
                            <h3 class="tvst-import-subhead is-warn">No se pudieron importar (${issues.length})</h3>
                            <div class="tvst-import-issues-tools">
                                <button type="button" class="tvst-settings-btn" onclick="copyIssuesToClipboard()">Copiar lista</button>
                                <button type="button" class="tvst-settings-btn" onclick="exportIssuesCsv()">Descargar informe (.csv)</button>
                            </div>
                        </div>
                        <p class="tvst-import-meta-line">Estos títulos o episodios no se encontraron en TMDB o no eran compatibles. Puedes buscarlos manualmente en Explorar o guardar el listado.</p>
                        <ul class="tvst-import-issues-list">
                            ${issues.map(item => `
                                <li class="tvst-import-issue-row">
                                    <div class="tvst-import-issue-copy">
                                        <strong>${esc(item.title)}${item.year ? ` (${item.year})` : ''}</strong>
                                        <span>${esc(item.reason)}</span>
                                    </div>
                                    ${item.searchableTitle ? `
                                        <button type="button" class="tvst-settings-btn tvst-issue-search-btn" onclick="searchIssueInExplore('${encodeURIComponent(item.searchableTitle)}')">Buscar en Explorar</button>
                                    ` : ''}
                                </li>
                            `).join('')}
                        </ul>
                    </div>
                ` : `
                    <p class="tvst-import-all-ok">Todos los títulos y episodios del archivo se importaron sin incidencias.</p>
                `}

                <div class="tvst-import-footer-actions">
                    <button type="button" class="tvst-settings-btn" onclick="resetUniversalImportWizard()">Importar otro archivo</button>
                    <button type="button" class="tvst-settings-btn is-primary" onclick="closeUniversalImportModal()">Listo</button>
                </div>
            </div>
        `;
    }

    function bindDropzoneEvents() {
        const dz = document.getElementById('univ-import-dropzone');
        if (!dz) return;
        dz.addEventListener('dragover', (e) => {
            e.preventDefault();
            dz.classList.add('is-dragover');
        });
        dz.addEventListener('dragleave', () => {
            dz.classList.remove('is-dragover');
        });
        dz.addEventListener('drop', (e) => {
            e.preventDefault();
            dz.classList.remove('is-dragover');
            const file = e.dataTransfer?.files?.[0];
            if (file) handleUniversalFileSelected(file);
        });
    }

    function openUniversalImportModal() {
        resetMigrationState();
        const modal = document.getElementById('universal-import-modal');
        if (!modal) return;
        modal.classList.remove('hidden');
        document.body.classList.add('modal-open');
        renderUniversalImportModalBody();
    }

    function closeUniversalImportModal() {
        if (migrationState.running) {
            cancelUniversalImport();
            return;
        }
        const modal = document.getElementById('universal-import-modal');
        if (modal) modal.classList.add('hidden');
        if (
            document.getElementById('detail-modal')?.classList.contains('hidden')
            && document.getElementById('list-modal')?.classList.contains('hidden')
            && document.getElementById('collectible-modal')?.classList.contains('hidden')
        ) {
            document.body.classList.remove('modal-open');
        }
    }

    function resetUniversalImportWizard() {
        if (migrationState.running) return;
        resetMigrationState();
        renderUniversalImportModalBody();
    }

    window.SeenItMigration = {
        PLATFORM_DIRECTORY,
        openUniversalImportModal,
        closeUniversalImportModal,
        exportUniversalCsv,
        exportLetterboxdCsv,
        exportTraktJson,
    };

    window.openUniversalImportModal = openUniversalImportModal;
    window.closeUniversalImportModal = closeUniversalImportModal;
    window.resetUniversalImportWizard = resetUniversalImportWizard;
    window.onUniversalFileInputChange = onUniversalFileInputChange;
    window.onUniversalMappingChange = onUniversalMappingChange;
    window.setUniversalDuplicateMode = setUniversalDuplicateMode;
    window.setUniversalSeenItMode = setUniversalSeenItMode;
    window.startUniversalImport = startUniversalImport;
    window.cancelUniversalImport = cancelUniversalImport;
    window.exportUniversalCsv = exportUniversalCsv;
    window.exportLetterboxdCsv = exportLetterboxdCsv;
    window.exportTraktJson = exportTraktJson;
    window.exportIssuesCsv = exportIssuesCsv;
    window.copyIssuesToClipboard = copyIssuesToClipboard;
    window.searchIssueInExplore = searchIssueInExplore;
})();

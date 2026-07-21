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

function getTmdbApiKey() {
    const key = typeof CONFIG_TMDB_API_KEY !== 'undefined' ? String(CONFIG_TMDB_API_KEY).trim() : '';
    if (!key || key.includes('tu_api_key')) return '';
    return key;
}

function hasTmdbConfig() {
    return Boolean(getTmdbApiKey());
}

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p';

// ============================================
// ESTADO GLOBAL
// ============================================

let searchTimeout = null;
const seasonDetailsCache = new Map();
const findExternalCache = new Map();
const tvMetaCache = new Map();

const SEASON_CACHE_STORAGE_KEY = 'seenit_tmdb_seasons_v1';
const SEASON_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
let seasonCachePersistTimer = null;

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

function loadSeasonCacheFromStorage() {
    try {
        const raw = localStorage.getItem(SEASON_CACHE_STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (!parsed?.savedAt || (Date.now() - Number(parsed.savedAt)) > SEASON_CACHE_TTL_MS) {
            localStorage.removeItem(SEASON_CACHE_STORAGE_KEY);
            return;
        }
        const entries = parsed.entries || {};
        for (const [key, value] of Object.entries(entries)) {
            if (value && Array.isArray(value.episodes)) {
                seasonDetailsCache.set(key, value);
            }
        }
        console.log(`[TMDB] Caché de temporadas restaurada (${seasonDetailsCache.size})`);
    } catch (error) {
        console.warn('[TMDB] No se pudo leer caché de temporadas:', error);
    }
}

function persistSeasonCacheToStorage() {
    try {
        const entries = {};
        let count = 0;
        for (const [key, value] of seasonDetailsCache.entries()) {
            entries[key] = slimSeasonPayload(value);
            count += 1;
            // Evitar saturar localStorage
            if (count >= 400) break;
        }
        localStorage.setItem(SEASON_CACHE_STORAGE_KEY, JSON.stringify({
            savedAt: Date.now(),
            entries,
        }));
    } catch (error) {
        console.warn('[TMDB] No se pudo guardar caché de temporadas:', error);
        try {
            // Si hay cuota, limpiar y reintentar con menos entradas
            const trimmed = {};
            let n = 0;
            for (const [key, value] of seasonDetailsCache.entries()) {
                trimmed[key] = slimSeasonPayload(value);
                if (++n >= 120) break;
            }
            localStorage.setItem(SEASON_CACHE_STORAGE_KEY, JSON.stringify({
                savedAt: Date.now(),
                entries: trimmed,
            }));
        } catch (_) { /* ignore */ }
    }
}

function schedulePersistSeasonCache() {
    if (seasonCachePersistTimer) clearTimeout(seasonCachePersistTimer);
    seasonCachePersistTimer = setTimeout(persistSeasonCacheToStorage, 400);
}

loadSeasonCacheFromStorage();

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
 * Realiza una petición a la API de TMDB
 * @param {string} endpoint - Endpoint de la API
 * @param {Object} params - Parámetros de la query
 * @returns {Promise<Object>} Respuesta de la API
 */
async function fetchTMDB(endpoint, params = {}) {
    if (!hasTmdbConfig()) {
        throw new Error('CONFIG_TMDB_MISSING');
    }
    try {
        const url = new URL(`${TMDB_BASE_URL}${endpoint}`);
        url.searchParams.append('api_key', getTmdbApiKey());
        url.searchParams.append('language', 'es-ES');

        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== null) {
                url.searchParams.append(key, value);
            }
        });

        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`Error TMDB: ${response.status} ${response.statusText}`);
        }

        return await response.json();
    } catch (error) {
        console.error('[TMDB] Error en petición:', error);
        throw error;
    }
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
 * @returns {Promise<Object>} Resultados con películas y series
 */
async function searchMulti(query, page = 1) {
    try {
        const response = await fetchTMDB('/search/multi', {
            query: query,
            page: page,
            include_adult: false,
        });
        
        // Filtrar solo películas y series
        const results = response.results.filter(item => 
            item.media_type === 'movie' || item.media_type === 'tv'
        );
        
        return {
            ...response,
            results: results,
            total_results: results.length,
        };
    } catch (error) {
        console.error('[TMDB] Error en búsqueda:', error);
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

/**
 * Obtiene detalles de una película
 * @param {number} id - ID de TMDB de la película
 * @returns {Promise<Object>} Detalles de la película
 */
async function getMovieDetails(id) {
    try {
        const response = await fetchTMDB(`/movie/${id}`, {
            append_to_response: 'credits,recommendations',
        });
        
        return normalizeMovieData(response);
    } catch (error) {
        console.error('[TMDB] Error obteniendo detalles de película:', error);
        throw error;
    }
}

/**
 * Obtiene detalles de una serie
 * @param {number} id - ID de TMDB de la serie
 * @returns {Promise<Object>} Detalles de la serie con temporadas y episodios
 */
async function getTVDetails(id) {
    try {
        const response = await fetchTMDB(`/tv/${id}`, {
            append_to_response: 'credits,recommendations',
        });
        
        return normalizeTVData(response);
    } catch (error) {
        console.error('[TMDB] Error obteniendo detalles de serie:', error);
        throw error;
    }
}

/**
 * Meta ligera de serie (status + temporadas) sin credits/recomendaciones.
 * Usado por timelines para no pagar el coste del detalle completo.
 */
async function getTVShowMeta(id) {
    const cacheKey = String(id);
    if (tvMetaCache.has(cacheKey)) {
        return tvMetaCache.get(cacheKey);
    }

    try {
        const response = await fetchTMDB(`/tv/${id}`);
        const meta = {
            id_tmdb: response.id,
            status: response.status || 'Unknown',
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
        console.error('[TMDB] Error obteniendo meta de serie:', error);
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
    const cacheKey = `${tvId}:${seasonNumber}`;
    if (seasonDetailsCache.has(cacheKey)) {
        return seasonDetailsCache.get(cacheKey);
    }

    try {
        const details = await fetchTMDB(`/tv/${tvId}/season/${seasonNumber}`);
        const slim = slimSeasonPayload(details);
        seasonDetailsCache.set(cacheKey, slim);
        schedulePersistSeasonCache();
        return slim;
    } catch (error) {
        console.error('[TMDB] Error obteniendo detalles de temporada:', error);
        throw error;
    }
}

function clearSeasonDetailsCache(tvId = null) {
    if (tvId == null) {
        seasonDetailsCache.clear();
        tvMetaCache.clear();
        try { localStorage.removeItem(SEASON_CACHE_STORAGE_KEY); } catch (_) { /* ignore */ }
        return;
    }
    const prefix = `${tvId}:`;
    for (const key of seasonDetailsCache.keys()) {
        if (key.startsWith(prefix)) seasonDetailsCache.delete(key);
    }
    tvMetaCache.delete(String(tvId));
    schedulePersistSeasonCache();
}

// ============================================
// NORMALIZACIÓN DE DATOS
// ============================================

/**
 * Normaliza los datos de una película al formato de la app
 * @param {Object} data - Datos crudos de TMDB
 * @returns {Object} Datos normalizados
 */
function normalizeMovieData(data) {
    return {
        id_tmdb: data.id,
        titulo: data.title,
        titulo_original: data.original_title,
        portada: getImageUrl(data.poster_path),
        backdrop: getImageUrl(data.backdrop_path, 'w780'),
        puntuacion: 0,
        estado: 'pending',
        tipo: 'movie',
        fecha_estreno: data.release_date,
        generos: data.genres?.map(g => g.name) || [],
        overview: data.overview,
        vote_average: data.vote_average,
        runtime: data.runtime,
        credits: {
            cast: (data.credits?.cast || []).slice(0, 8).map(person => ({
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
}

/**
 * Normaliza los datos de una serie al formato de la app
 * @param {Object} data - Datos crudos de TMDB
 * @returns {Object} Datos normalizados
 */
function normalizeTVData(data) {
    const seasons = data.seasons || [];
    
    return {
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
        capitulos_vistos: [],
    };
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
    
    if (item.media_type === 'movie' || !item.media_type && item.title) {
        return {
            ...baseData,
            titulo: item.title,
            titulo_original: item.original_title,
            tipo: 'movie',
            fecha_estreno: item.release_date,
        };
    } else if (item.media_type === 'tv' || !item.media_type && item.name) {
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
    try {
        const response = await fetchTMDB(`/${type}/${id}/watch/providers`);
        const countries = response.results || {};
        const countryKey = Object.keys(countries).find(key => key.toUpperCase() === 'ES') || Object.keys(countries)[0];
        const countryData = countryKey ? countries[countryKey] : {};

        const providers = [
            ...(countryData.flatrate || []),
            ...(countryData.rent || []),
            ...(countryData.buy || []),
        ];

        return providers.map(provider => ({
            provider_name: provider.provider_name,
            logo_path: provider.logo_path,
            link_type: provider.link_type,
        }));
    } catch (error) {
        console.error('[TMDB] Error obteniendo proveedores:', error);
        return [];
    }
}

// ============================================
// BÚSQUEDA CON DEBOUNCE
// ============================================

/**
 * Realiza una búsqueda con debounce para evitar demasiadas peticiones
 * @param {string} query - Término de búsqueda
 * @param {Function} callback - Función a ejecutar con los resultados
 * @param {number} delay - Retraso en ms (default: 300)
 */
function searchWithDebounce(query, callback, delay = 300) {
    if (searchTimeout) {
        clearTimeout(searchTimeout);
    }
    
    if (!query || query.length < 2) {
        callback([]);
        return;
    }
    
    searchTimeout = setTimeout(async () => {
        try {
            const results = await searchMulti(query);
            const normalized = results.results.map(normalizeSearchResult);
            callback(normalized);
        } catch (error) {
            console.error('[TMDB] Error en búsqueda con debounce:', error);
            callback([]);
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
    getMovieDetails,
    getTVDetails,
    getTVShowMeta,
    getSeasonDetails,
    clearSeasonDetailsCache,
    findByExternalId,
    findMovieByTitleYear,
    findTVByTitleYear,
    getImageUrl,
    normalizeMovieData,
    normalizeTVData,
    normalizeSearchResult,
    getWatchProviders,
    searchWithDebounce,
};

window.searchMulti = searchMulti;
window.searchMovies = searchMovies;
window.searchTV = searchTV;
window.hasTmdbConfig = hasTmdbConfig;
window.getMovieDetails = getMovieDetails;
window.getTVDetails = getTVDetails;
window.getTVShowMeta = getTVShowMeta;
window.getSeasonDetails = getSeasonDetails;
window.clearSeasonDetailsCache = clearSeasonDetailsCache;
window.findByExternalId = findByExternalId;
window.findMovieByTitleYear = findMovieByTitleYear;
window.findTVByTitleYear = findTVByTitleYear;
window.getImageUrl = getImageUrl;
window.normalizeMovieData = normalizeMovieData;
window.normalizeTVData = normalizeTVData;
window.normalizeSearchResult = normalizeSearchResult;
window.getWatchProviders = getWatchProviders;
window.searchWithDebounce = searchWithDebounce;

console.log('[TMDB] tmdb-service.js cargado');

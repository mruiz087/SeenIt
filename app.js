/**
 * App - Lógica Principal de SeenIt
 * 
 * Este archivo maneja toda la lógica de la aplicación:
 * - Gestión de estado local
 * - Conexión de eventos de la interfaz
 * - Renderizado de contenido
 * - Sincronización con Google Drive
 */

// ============================================
// ESTADO GLOBAL
// ============================================

const AppState = {
    movies: [],
    shows: [],
    lists: [],
    currentTab: 'series',
    currentSubTab: 'pending-list',
    currentMoviesSubTab: 'pending-list',
    currentProfileTab: 'series',
    currentFilter: 'all',
    profileSeriesFilter: 'all',
    profileMoviesFilter: 'all',
    profileExpanded: { series: false, movies: false },
    detailRecsExpanded: false,
    lastSearchResults: [],
    selectedItem: null,
    selectedEpisode: null,
    selectedListId: null,
    listCoverPickMode: false,
    isDriveConnected: false,
    isSyncing: false,
    expandedSeasons: {},
    timelineHistoryVisible: { 'pending-list': 12, upcoming: 4 },
    timelineHistoryCache: {},
    driveReady: false,
};

let appInitialized = false;
let syncToDriveTimeout = null;
let tvTimeSeriesJson = null;
let tvTimeMoviesJson = null;

// ============================================
// INICIALIZACIÓN
// ============================================

function setDriveGateVisible(visible, errorMessage = '') {
    const gate = document.getElementById('drive-gate');
    const app = document.getElementById('app');
    const err = document.getElementById('drive-gate-error');
    const originEl = document.getElementById('drive-gate-origin');
    if (!gate || !app) return;

    gate.classList.toggle('hidden', !visible);
    app.classList.toggle('hidden', visible);
    if (err) {
        err.textContent = errorMessage || '';
        err.classList.toggle('hidden', !errorMessage);
    }
    if (originEl) {
        originEl.textContent = `Origen: ${window.location.origin}`;
    }
}

function setDriveGateStatus(message = '') {
    const el = document.getElementById('drive-gate-status');
    if (!el) return;
    el.textContent = message || '';
    el.classList.toggle('hidden', !message);
}

function getConfigSetupError() {
    const missingGoogle = typeof hasGoogleConfig === 'function' ? !hasGoogleConfig() : true;
    const missingTmdb = typeof hasTmdbConfig === 'function' ? !hasTmdbConfig() : true;
    if (!missingGoogle && !missingTmdb) return '';
    const parts = [];
    if (missingTmdb) parts.push('TMDB');
    if (missingGoogle) parts.push('Google');
    return `Falta configuración (${parts.join(' + ')}). En local crea config.js; en GitHub Pages configura los Secrets y vuelve a desplegar.`;
}

/**
 * Inicializa la aplicación (Drive-first)
 */
async function initApp() {
    if (appInitialized) {
        console.log('[App] initApp ya ejecutado, omitiendo');
        return;
    }
    appInitialized = true;

    console.log('[App] Inicializando aplicación...');
    loadLocalData();
    setupEventListeners();
    setDriveGateVisible(true);
    setDriveGateStatus('Preparando…');

    const configError = getConfigSetupError();
    if (configError) {
        setDriveGateStatus('');
        setDriveGateVisible(true, configError);
        const btn = document.getElementById('btn-drive-gate-connect');
        if (btn) btn.disabled = true;
        console.warn('[App]', configError);
        return;
    }

    try {
        await initDriveService();
        console.log('[App] Drive service inicializado');
        setDriveGateStatus('');

        try {
            await ensureValidAccessToken({ interactive: false });
        } catch (_) {
            // Sin sesión previa: se queda en el gate
        }

        if (isAuthenticated()) {
            setDriveGateStatus('Cargando tu biblioteca…');
            await enterAppAfterDrive();
        } else {
            updateDriveStatus(false);
            setDriveGateStatus('');
            setDriveGateVisible(true);
        }
    } catch (error) {
        console.warn('[App] No se pudo inicializar Drive service:', error);
        updateDriveStatus(false);
        setDriveGateStatus('');
        const msg = String(error?.message || error || '');
        if (msg.includes('CONFIG_MISSING')) {
            setDriveGateVisible(true, getConfigSetupError() || 'Falta config.js con las claves de Google.');
        } else {
            setDriveGateVisible(true, 'No se pudo inicializar Google Drive. Revisa la conexión e inténtalo de nuevo.');
        }
    }

    console.log('[App] Aplicación inicializada');
}

async function enterAppAfterDrive() {
    updateDriveStatus(true);
    setDriveGateStatus('Cargando tu biblioteca…');
    try {
        await loadFromDrive({ silent: true });
    } catch (error) {
        console.warn('[App] Error cargando Drive al entrar:', error);
    }
    AppState.driveReady = true;
    setDriveGateStatus('');
    setDriveGateVisible(false);
    switchTab('series');
    await renderCurrentView();
}

async function connectDriveFromGate() {
    const btn = document.getElementById('btn-drive-gate-connect');
    if (btn) btn.disabled = true;
    setDriveGateVisible(true, '');
    setDriveGateStatus('Abriendo Google… Si no ves una ventana, permite popups para este sitio.');

    const configError = getConfigSetupError();
    if (configError) {
        setDriveGateStatus('');
        setDriveGateVisible(true, configError);
        if (btn) btn.disabled = false;
        return;
    }

    try {
        if (typeof hasGoogleConfig === 'function' && !hasGoogleConfig()) {
            throw new Error('CONFIG_MISSING');
        }
        if (!window.gisInited && typeof initDriveService === 'function') {
            // ensure services ready if previous init failed partially
        }
        await authenticate();
        setDriveGateStatus('Conectado. Cargando tu biblioteca…');
        await enterAppAfterDrive();
        showToast('Conectado a Google Drive', 'success');
    } catch (error) {
        console.error('[App] Error conectando Drive desde gate:', error);
        updateDriveStatus(false);
        setDriveGateStatus('');
        const msg = String(error?.error || error?.message || error || '');
        if (msg.includes('CONFIG_MISSING') || msg.includes('CONFIG_TMDB')) {
            setDriveGateVisible(true, getConfigSetupError() || 'Falta configuración de claves.');
        } else if (msg.includes('origin_mismatch')) {
            setDriveGateVisible(true, `Origen no autorizado en Google Cloud: ${window.location.origin}. Añádelo en Credenciales → Orígenes JavaScript autorizados.`);
        } else if (msg.includes('popup_closed') || msg.includes('access_denied')) {
            setDriveGateVisible(true, 'Cerraste la ventana de Google o denegaste el acceso. Pulsa de nuevo para intentarlo.');
        } else if (msg.includes('popup_failed') || msg.includes('Popup')) {
            setDriveGateVisible(true, 'El navegador bloqueó el popup. Permite ventanas emergentes para este sitio e inténtalo otra vez.');
        } else {
            setDriveGateVisible(true, 'No se pudo conectar. Revisa la ventana de Google o inténtalo de nuevo.');
        }
    } finally {
        if (btn) btn.disabled = false;
    }
}

/**
 * Carga datos desde localStorage
 */
function loadLocalData() {
    try {
        const savedData = localStorage.getItem('seenit_data');
        if (savedData) {
            const data = JSON.parse(savedData);
            AppState.movies = (data.movies || []).map(normalizeStoredMovie);
            AppState.shows = (data.shows || []).map(normalizeStoredShow);
            AppState.lists = (data.lists || []).map(normalizeStoredList);
            console.log('[App] Datos locales cargados');
        }
    } catch (error) {
        console.error('[App] Error cargando datos locales:', error);
    }
}

function normalizeStoredMovie(movie) {
    const normalized = { ...movie };
    normalized.tipo = 'movie';
    normalized.estado = normalizeStatus(normalized.estado);
    normalized.capitulos_vistos = Array.isArray(normalized.capitulos_vistos) ? normalized.capitulos_vistos : [];
    normalized.favorito = Boolean(normalized.favorito);
    return normalized;
}

function normalizeStoredShow(show) {
    const normalized = { ...show };
    normalized.tipo = 'tv';
    normalized.estado = normalizeStatus(normalized.estado);
    normalized.capitulos_vistos = Array.isArray(normalized.capitulos_vistos) ? normalized.capitulos_vistos : [];
    normalized.capitulos_vistos_fecha = normalized.capitulos_vistos_fecha && typeof normalized.capitulos_vistos_fecha === 'object'
        ? normalized.capitulos_vistos_fecha
        : {};
    normalized.temporadas = Array.isArray(normalized.temporadas) ? normalized.temporadas.map(season => ({
        ...season,
        especial: Boolean(season.especial || season.numero === 0),
    })) : [];
    normalized.status = normalized.status || 'Unknown';
    normalized.episodios_emitidos = Number(normalized.episodios_emitidos) || 0;
    normalized.episodios_vistos_count = Number(normalized.episodios_vistos_count) || normalized.capitulos_vistos.length;
    normalized.episode_run_time = Number(normalized.episode_run_time) || 45;
    normalized.favorito = Boolean(normalized.favorito);
    return normalized;
}

function normalizeStoredList(list) {
    const tipo = list?.tipo === 'movie' ? 'movie' : 'tv';
    const itemIds = Array.isArray(list?.itemIds)
        ? [...new Set(list.itemIds.map(Number).filter(n => Number.isFinite(n) && n > 0))]
        : [];
    return {
        id: String(list?.id || `lst_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
        name: String(list?.name || 'Lista').trim() || 'Lista',
        tipo,
        itemIds,
        coverId: Number(list?.coverId) || itemIds[0] || null,
    };
}

/**
 * Guarda datos en localStorage
 */
function saveLocalData() {
    try {
        const data = {
            movies: AppState.movies,
            shows: AppState.shows,
            lists: AppState.lists,
            lastModified: new Date().toISOString(),
        };
        localStorage.setItem('seenit_data', JSON.stringify(data));
    } catch (error) {
        console.error('[App] Error guardando datos locales:', error);
    }
}

// ============================================
// GESTIÓN DE ESTADO
// ============================================

/**
 * Añade una película a la lista
 * @param {Object} movie - Datos de la película
 */
async function addMovie(movie) {
    const exists = AppState.movies.find(m => m.id_tmdb === movie.id_tmdb);
    if (exists) {
        showToast('Esta película ya está en tu lista', 'info');
        return;
    }

    try {
        const details = await getMovieDetails(movie.id_tmdb);
        AppState.movies.push(details);
        saveLocalData();
        syncToDrive();
        renderCurrentView();
        showToast('Película añadida', 'success');
    } catch (error) {
        console.error('[App] Error añadiendo película:', error);
        showToast('Error al añadir película', 'error');
    }
}

/**
 * Añade una serie a la lista
 * @param {Object} show - Datos de la serie
 */
async function addShow(show) {
    const exists = AppState.shows.find(s => s.id_tmdb === show.id_tmdb);
    if (exists) {
        showToast('Esta serie ya está en tu lista', 'info');
        return;
    }

    try {
        const details = await getTVDetails(show.id_tmdb);
        AppState.shows.push(details);
        saveLocalData();
        syncToDrive();
        renderCurrentView();
        showToast('Serie añadida', 'success');
    } catch (error) {
        console.error('[App] Error añadiendo serie:', error);
        showToast('Error al añadir serie', 'error');
    }
}

/**
 * Elimina una película de la lista
 * @param {number} id_tmdb - ID de TMDB
 */
function removeMovie(id_tmdb) {
    AppState.movies = AppState.movies.filter(m => m.id_tmdb !== id_tmdb);
    removeItemFromAllLists('movie', id_tmdb);
    saveLocalData();
    syncToDrive();
    renderCurrentView();
    showToast('Película eliminada', 'success');
}

/**
 * Elimina una serie de la lista
 * @param {number} id_tmdb - ID de TMDB
 */
function removeShow(id_tmdb) {
    AppState.shows = AppState.shows.filter(s => s.id_tmdb !== id_tmdb);
    removeItemFromAllLists('tv', id_tmdb);
    saveLocalData();
    syncToDrive();
    renderCurrentView();
    showToast('Serie eliminada', 'success');
}

/**
 * Actualiza la puntuación de un item
 * @param {string} type - 'movie' o 'tv'
 * @param {number} id_tmdb - ID de TMDB
 * @param {number} rating - Puntuación (0-10)
 */
function updateRating(type, id_tmdb, rating) {
    if (type === 'movie') {
        const movie = AppState.movies.find(m => m.id_tmdb === id_tmdb);
        if (movie) {
            movie.puntuacion = rating;
        }
    } else if (type === 'tv') {
        const show = AppState.shows.find(s => s.id_tmdb === id_tmdb);
        if (show) {
            show.puntuacion = rating;
        }
    }
    saveLocalData();
    syncToDrive();
}

/**
 * Actualiza el estado de un item
 * @param {string} type - 'movie' o 'tv'
 * @param {number} id_tmdb - ID de TMDB
 * @param {string} status - Estado (pendiente, viendo, completado, etc.)
 */
async function updateStatus(type, id_tmdb, status) {
    const normalizedStatus = normalizeStatus(status);

    if (type === 'movie') {
        const movie = AppState.movies.find(m => m.id_tmdb === id_tmdb);
        if (movie) {
            movie.estado = normalizedStatus;
        }
    } else if (type === 'tv') {
        const show = AppState.shows.find(s => s.id_tmdb === id_tmdb);
        if (show) {
            show.estado = normalizedStatus;

            if (normalizedStatus === 'completed') {
                const episodes = await getOrderedEpisodes(show, { includeSpecials: false });
                const airedEpisodeIds = episodes.filter(isEpisodeAired).map(ep => ep.id);
                show.capitulos_vistos = [...new Set([...(show.capitulos_vistos || []), ...airedEpisodeIds])];
            }
        }
    }

    saveLocalData();
    syncToDrive();
    renderFollowing();
}

/**
 * Marca un episodio como visto
 * @param {number} id_tmdb - ID de TMDB de la serie
 * @param {string} episode - Formato "S01E01"
 */
function compareEpisodeOrder(a, b) {
    if (a.seasonNumber !== b.seasonNumber) return a.seasonNumber - b.seasonNumber;
    return a.episodeNumber - b.episodeNumber;
}

function shouldAskToMarkPreviousEpisodes(show, episodes, episodeId) {
    const targetEpisode = episodes.find(ep => ep.id === episodeId);
    if (!targetEpisode || !isEpisodeAired(targetEpisode)) return false;
    const airedEpisodes = episodes.filter(isEpisodeAired);
    const previousEpisodes = airedEpisodes.filter(ep => compareEpisodeOrder(ep, targetEpisode) < 0);
    return previousEpisodes.length > 0 && previousEpisodes.some(ep => !show.capitulos_vistos?.includes(ep.id));
}

async function toggleEpisode(id_tmdb, episode) {
    const show = AppState.shows.find(s => s.id_tmdb === id_tmdb);
    if (!show) return;

    const episodes = await getOrderedEpisodes(show, { includeSpecials: false });
    const targetEpisode = episodes.find(ep => ep.id === episode);

    if (targetEpisode && !isEpisodeAired(targetEpisode)) {
        showToast('No puedes marcar episodios con fecha posterior a la actual', 'info');
        return;
    }

    if (!show.capitulos_vistos) {
        show.capitulos_vistos = [];
    }

    const wasStandby = normalizeStatus(show.estado) === 'standby';
    const wasDropped = normalizeStatus(show.estado) === 'dropped';
    const index = show.capitulos_vistos.indexOf(episode);
    let markedWatched = false;
    const newlyWatchedIds = [];
    if (index > -1) {
        show.capitulos_vistos.splice(index, 1);
        clearEpisodeWatchedRecord(show, episode);
    } else {
        const previousEpisodes = episodes.filter(isEpisodeAired).filter(ep => compareEpisodeOrder(ep, targetEpisode) < 0 && !show.capitulos_vistos?.includes(ep.id));
        if (shouldAskToMarkPreviousEpisodes(show, episodes, episode) && confirm('¿Quieres marcar también los episodios anteriores como vistos?')) {
            previousEpisodes.forEach(ep => {
                if (!show.capitulos_vistos.includes(ep.id)) {
                    show.capitulos_vistos.push(ep.id);
                    newlyWatchedIds.push(ep.id);
                }
            });
        }
        show.capitulos_vistos.push(episode);
        newlyWatchedIds.push(episode);
        markedWatched = true;
        recordEpisodesWatched(show, newlyWatchedIds);
        bumpPendingHistoryAfterWatch();
    }

    if (wasStandby && markedWatched) {
        show.estado = 'watching';
    }
    if (wasDropped && markedWatched) {
        show.estado = 'watching';
    }

    await refreshShowStatus(show);
    saveLocalData();
    syncToDrive();
    if (AppState.selectedItem?.tipo === 'tv' && AppState.selectedItem.id_tmdb === id_tmdb) {
        AppState.selectedItem = { ...show, tipo: 'tv' };
        await renderEpisodes(AppState.selectedItem);
        updateDetailHero(AppState.selectedItem);
    }
    await renderCurrentView();
}



// ============================================
// SINCRONIZACIÓN CON DRIVE
// ============================================

/**
 * Sincroniza datos con Google Drive en segundo plano (con debounce)
 */
function syncToDrive() {
    if (!isAuthenticated()) {
        return;
    }

    clearTimeout(syncToDriveTimeout);
    syncToDriveTimeout = setTimeout(() => {
        syncToDriveNow();
    }, 2000);
}

async function syncToDriveNow() {
    if (!isAuthenticated() || AppState.isSyncing) {
        return;
    }

    AppState.isSyncing = true;

    try {
        try {
            await ensureValidAccessToken({ interactive: false });
        } catch (_) { /* syncToDrive will fail below if needed */ }

        const data = {
            movies: AppState.movies,
            shows: AppState.shows,
            lists: AppState.lists,
            lastModified: new Date().toISOString(),
        };
        await saveUserData(data);
        console.log('[App] Datos sincronizados con Drive');
    } catch (error) {
        console.error('[App] Error sincronizando con Drive:', error);
        if (!isAuthenticated()) {
            updateDriveStatus(false);
            setDriveGateVisible(true, 'Sesión de Drive caducada. Vuelve a conectar.');
        }
    } finally {
        AppState.isSyncing = false;
    }
}

/**
 * Carga datos desde Google Drive
 */
async function loadFromDrive(options = {}) {
    const silent = Boolean(options.silent);
    if (!isAuthenticated()) {
        if (!silent) showToast('Primero conecta Google Drive', 'info');
        return;
    }

    if (!silent) showLoading(true);

    try {
        try {
            await ensureValidAccessToken({ interactive: false });
        } catch (_) { /* continue; loadUserData will renew */ }

        const data = await loadUserData();
        AppState.movies = (data.movies || []).map(normalizeStoredMovie);
        AppState.shows = (data.shows || []).map(normalizeStoredShow);
        AppState.lists = (data.lists || []).map(normalizeStoredList);
        saveLocalData();
        if (AppState.driveReady) {
            renderCurrentView();
        }
        updateDriveStatus(true);
        if (!silent) showToast('Datos sincronizados desde Drive', 'success');
    } catch (error) {
        console.error('[App] Error cargando desde Drive:', error);
        if (!silent) showToast('Error al cargar datos desde Drive', 'error');
        throw error;
    } finally {
        if (!silent) showLoading(false);
    }
}

// ============================================
// NAVEGACIÓN
// ============================================

/**
 * Cambia entre pestañas
 * @param {string} tab - Nombre de la pestaña
 */
function switchTab(tab) {
    AppState.currentTab = tab;

    if (tab === 'series') {
        // Historial reciente ya encima; ancla a "Ver a continuación"
        AppState.timelineHistoryVisible['pending-list'] = Math.max(
            AppState.timelineHistoryVisible['pending-list'] || 0,
            12,
        );
        AppState.timelineHistoryVisible['upcoming'] = 4;
        window.__seenitHistoryLoadReady = false;
    }

    document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
    document.getElementById(`content-${tab}`)?.classList.remove('hidden');

    document.querySelectorAll('.tvst-bottom-nav-btn').forEach(btn => btn.classList.remove('is-active'));
    document.querySelector(`.tvst-bottom-nav-btn[data-tab="${tab}"]`)?.classList.add('is-active');

    Promise.resolve(renderCurrentView()).finally(() => {
        if (tab === 'profile') {
            window.scrollTo({ top: 0, behavior: 'auto' });
        }
    });
}

function switchSubTab(subTab) {
    AppState.currentSubTab = subTab;
    if (subTab === 'pending-list') {
        AppState.timelineHistoryVisible['pending-list'] = Math.max(
            AppState.timelineHistoryVisible['pending-list'] || 0,
            12,
        );
        window.__seenitHistoryLoadReady = false;
    } else {
        AppState.timelineHistoryVisible[subTab] = 4;
    }

    document.querySelectorAll('#content-series .tvst-subnav-tab').forEach(btn => btn.classList.remove('is-active'));
    document.getElementById(`series-subtab-${subTab}`)?.classList.add('is-active');

    document.querySelectorAll('#content-series .tvst-tab-panel').forEach(el => el.classList.add('hidden'));
    document.getElementById(`subtab-content-${subTab}`)?.classList.remove('hidden');

    const continueBar = document.getElementById('series-continue-bar');
    if (continueBar) {
        continueBar.classList.toggle('is-hidden', subTab === 'upcoming');
    }

    Promise.resolve(renderCurrentView()).finally(() => {
        if (subTab === 'upcoming') {
            window.scrollTo({ top: 0, behavior: 'auto' });
        }
    });
}

function switchMoviesSubTab(subTab) {
    AppState.currentMoviesSubTab = subTab;

    document.querySelectorAll('#content-movies .tvst-subnav-tab').forEach(btn => btn.classList.remove('is-active'));
    document.getElementById(`movies-subtab-${subTab}`)?.classList.add('is-active');

    document.querySelectorAll('#content-movies .tvst-tab-panel').forEach(el => el.classList.add('hidden'));
    document.getElementById(`movies-subtab-content-${subTab}`)?.classList.remove('hidden');

    Promise.resolve(renderCurrentView()).finally(() => {
        if (subTab === 'upcoming') {
            window.scrollTo({ top: 0, behavior: 'auto' });
        }
    });
}

function switchProfileTab(tab) {
    AppState.currentProfileTab = tab;

    document.querySelectorAll('.tvst-profile-tab').forEach(btn => btn.classList.remove('is-active'));
    document.getElementById(`profile-tab-${tab}`)?.classList.add('is-active');

    if (tab === 'series') {
        document.getElementById('profile-series-content')?.classList.remove('hidden');
        document.getElementById('profile-movies-content')?.classList.add('hidden');
    } else {
        document.getElementById('profile-series-content')?.classList.add('hidden');
        document.getElementById('profile-movies-content')?.classList.remove('hidden');
    }

    Promise.resolve(renderProfileView()).finally(() => {
        window.scrollTo({ top: 0, behavior: 'auto' });
    });
}

// ============================================
// RENDERIZADO
// ============================================

/**
 * Renderiza vistas según la pestaña activa
 */
async function renderCurrentView() {
    if (AppState.currentTab === 'series') {
        await renderSeriesView();
        return;
    }

    if (AppState.currentTab === 'movies') {
        await renderMoviesView();
        return;
    }

    if (AppState.currentTab === 'profile') {
        await renderProfileView();
        renderSettings();
        return;
    }

    renderExplore();
}

/**
 * Renderiza la pestaña de seguimiento legacy
 */
function renderFollowing() {
    renderCurrentView();
}

/**
 * Renderiza la vista de series
 */
async function renderSeriesView() {
    if (AppState.currentSubTab === 'pending-list') {
        await renderPendingList();
    } else {
        await renderUpcomingList();
    }
}

function parseReleaseDate(dateString) {
    if (!dateString) return null;
    const parsed = new Date(`${dateString}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isMovieReleased(movie) {
    const release = parseReleaseDate(movie.fecha_estreno);
    if (!release) return true;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return release <= today;
}

function getDaysUntilRelease(dateString) {
    const release = parseReleaseDate(dateString);
    if (!release) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((release - today) / 86400000);
}

function formatMovieCountdown(dateString) {
    const diffDays = getDaysUntilRelease(dateString);
    if (diffDays === null) return 'Próximamente';
    if (diffDays === 0) return 'HOY';
    if (diffDays === 1) return 'MAÑANA';
    if (diffDays > 1) return `${diffDays} DÍAS`;
    return formatUpcomingDateLabel(dateString).toUpperCase();
}

function renderMoviePosterGrid(movies, { showCountdown = false, showWatchToggle = false } = {}) {
    if (!movies.length) {
        return emptyState('film', 'No hay películas en esta categoría', { grid: true });
    }

    return movies.map(movie => {
        const countdown = showCountdown ? formatMovieCountdown(movie.fecha_estreno) : '';
        const isCompleted = normalizeStatus(movie.estado) === 'completed';
        return `
        <article class="tvst-poster-cell" onclick="openDetail('movie', ${movie.id_tmdb})">
            ${movie.portada
                ? `<img src="${movie.portada}" alt="${movie.titulo}">`
                : `<div class="w-full h-full flex items-center justify-center text-2xl">🎬</div>`}
            ${showCountdown && countdown ? `<div class="tvst-poster-countdown">${countdown}</div>` : ''}
            ${showWatchToggle ? `
                <button type="button"
                    class="tvst-movie-check${isCompleted ? ' is-watched' : ''}"
                    onclick="event.stopPropagation(); toggleMovieWatched(${movie.id_tmdb})"
                    aria-label="${isCompleted ? 'Marcar como no vista' : 'Marcar como vista'}">✓</button>
            ` : ''}
        </article>`;
    }).join('');
}

async function toggleMovieWatched(id_tmdb) {
    const movie = AppState.movies.find(m => m.id_tmdb === id_tmdb);
    if (!movie) return;

    const isCompleted = normalizeStatus(movie.estado) === 'completed';
    movie.estado = isCompleted ? 'pending' : 'completed';
    saveLocalData();
    syncToDrive();

    if (AppState.selectedItem?.tipo === 'movie' && AppState.selectedItem.id_tmdb === id_tmdb) {
        AppState.selectedItem = { ...movie, tipo: 'movie' };
        updateDetailHero(AppState.selectedItem);
    }

    await renderCurrentView();
    showToast(isCompleted ? 'Película marcada como pendiente' : 'Película marcada como vista', 'success');
}

async function renderMoviesView() {
    if (AppState.currentMoviesSubTab === 'pending-list') {
        renderMoviesPendingList();
    } else {
        renderMoviesUpcomingList();
    }
}

function renderMoviesPendingList() {
    const container = document.getElementById('movies-pending-list-container');
    if (!container) return;

    const pending = AppState.movies
        .filter(movie => normalizeStatus(movie.estado) !== 'completed')
        .filter(movie => isMovieReleased(movie))
        .sort((a, b) => (a.titulo || '').localeCompare(b.titulo || '', 'es', { sensitivity: 'base' }));

    container.className = 'tvst-poster-grid';
    container.innerHTML = renderMoviePosterGrid(pending, { showWatchToggle: true });
}

function renderMoviesUpcomingList() {
    const container = document.getElementById('movies-upcoming-list-container');
    if (!container) return;

    const upcoming = AppState.movies
        .filter(movie => normalizeStatus(movie.estado) !== 'completed')
        .filter(movie => {
            const days = getDaysUntilRelease(movie.fecha_estreno);
            return days !== null && days > 0;
        })
        .sort((a, b) => (a.fecha_estreno || '9999-12-31').localeCompare(b.fecha_estreno || '9999-12-31'));

    if (!upcoming.length) {
        container.innerHTML = emptyState(
            'calendar',
            'Sin estrenos próximos',
            { subtitle: 'Cuando añadas películas pendientes con fecha, aparecerán aquí.' },
        );
        return;
    }

    const grouped = upcoming.reduce((acc, movie) => {
        const label = formatUpcomingDateLabel(movie.fecha_estreno);
        if (!acc[label]) acc[label] = [];
        acc[label].push(movie);
        return acc;
    }, {});

    const labels = Object.keys(grouped).sort((a, b) => {
        const dateA = grouped[a][0].fecha_estreno || '9999-12-31';
        const dateB = grouped[b][0].fecha_estreno || '9999-12-31';
        return dateA.localeCompare(dateB);
    });

    container.innerHTML = labels.map(label => `
        <section class="mb-4">
            <div class="tvst-day-capsule-wrap"><span class="tvst-day-capsule">${label}</span></div>
            <div class="tvst-poster-grid">${renderMoviePosterGrid(grouped[label], { showCountdown: true })}</div>
        </section>
    `).join('');
}

function formatUpcomingDateLabel(dateString) {
    if (!dateString) return 'MÁS TARDE';

    const dateOnly = String(dateString).slice(0, 10);
    const target = new Date(`${dateOnly}T00:00:00`);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const diffDays = Math.round((target - today) / 86400000);
    if (diffDays === 0) return 'HOY';
    if (diffDays === 1) return 'MAÑANA';

    const weekdays = ['DOMINGO', 'LUNES', 'MARTES', 'MIÉRCOLES', 'JUEVES', 'VIERNES', 'SÁBADO'];
    if (diffDays > 1 && diffDays <= 7) return weekdays[target.getDay()];

    return 'MÁS TARDE';
}

function getDaysUntilAir(dateString) {
    if (!dateString) return null;
    const dateOnly = String(dateString).slice(0, 10);
    const target = new Date(`${dateOnly}T00:00:00`);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((target - today) / 86400000);
}

function formatAirDateShort(airDate) {
    if (!airDate) return '—';
    const dateOnly = String(airDate).slice(0, 10);
    const parsed = new Date(`${dateOnly}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return dateOnly;
    return parsed.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
}

function getAirTimeMeta(airDate, bucketLabel) {
    if (bucketLabel === 'MÁS TARDE') {
        const days = getDaysUntilAir(airDate);
        if (days == null) {
            return { text: formatAirDateShort(airDate), className: 'tvst-air-time is-date' };
        }
        const text = days === 1 ? 'En 1 día' : `En ${Math.max(1, days)} días`;
        return { text, className: 'tvst-air-time is-days', sub: formatAirDateShort(airDate) };
    }

    if (!airDate) return { text: '—', className: 'tvst-air-time' };

    // Hora real si TMDB la trae; si no, fecha de emisión
    if (String(airDate).length > 10) {
        try {
            const parsed = new Date(airDate);
            if (!Number.isNaN(parsed.getTime())) {
                return {
                    text: parsed.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }),
                    className: 'tvst-air-time is-clock',
                    sub: formatAirDateShort(airDate),
                };
            }
        } catch { /* fall through */ }
    }

    return { text: formatAirDateShort(airDate), className: 'tvst-air-time is-date' };
}

function getDaysSinceAir(airDate) {
    if (!airDate) return 0;
    const dateOnly = String(airDate).slice(0, 10);
    const aired = new Date(`${dateOnly}T00:00:00`);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((today - aired) / 86400000);
}

function getEpisodeWatchedAt(show, episodeId) {
    return show?.capitulos_vistos_fecha?.[episodeId] || null;
}

function recordEpisodesWatched(show, episodeIds) {
    if (!show) return;
    if (!show.capitulos_vistos_fecha || typeof show.capitulos_vistos_fecha !== 'object') {
        show.capitulos_vistos_fecha = {};
    }
    const now = new Date().toISOString();
    episodeIds.forEach(id => {
        if (id) show.capitulos_vistos_fecha[id] = now;
    });
}

function clearEpisodeWatchedRecord(show, episodeId) {
    if (show?.capitulos_vistos_fecha && episodeId) {
        delete show.capitulos_vistos_fecha[episodeId];
    }
}

function getShowLastWatchActivity(show) {
    const dates = show?.capitulos_vistos_fecha ? Object.values(show.capitulos_vistos_fecha) : [];
    if (!dates.length) return null;
    return dates.sort((a, b) => b.localeCompare(a))[0];
}

function getDaysSinceWatchActivity(isoDate) {
    if (!isoDate) return Infinity;
    const watched = new Date(isoDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    watched.setHours(0, 0, 0, 0);
    return Math.round((today - watched) / 86400000);
}

/** Serie en "Ver a continuación" si el próximo ep es reciente o hubo actividad de visionado reciente (retomada). */
function isShowInContinueSection(show, nextEpisode) {
    if (getDaysSinceAir(nextEpisode?.air_date) <= 14) return true;
    const lastActivity = getShowLastWatchActivity(show);
    return getDaysSinceWatchActivity(lastActivity) <= 14;
}

function bumpPendingHistoryAfterWatch() {
    if (AppState.currentTab !== 'series' || AppState.currentSubTab !== 'pending-list') return;
    // Mantener ancla en "Ver a continuación"; el episodio recién visto queda arriba en historial
    const current = AppState.timelineHistoryVisible['pending-list'] || 0;
    AppState.timelineHistoryVisible['pending-list'] = Math.max(current, 1);
}

function getEpisodeBadges(show, episode, allAiredEpisodes) {
    const badges = [];
    const isUnwatched = !show.capitulos_vistos?.includes(episode.id);
    const orderedAired = [...(allAiredEpisodes || [])].sort((a, b) => {
        if (a.seasonNumber !== b.seasonNumber) return a.seasonNumber - b.seasonNumber;
        return a.episodeNumber - b.episodeNumber;
    });
    const lastAiredSeries = orderedAired.length ? orderedAired[orderedAired.length - 1] : null;
    const isLastOfSeries = lastAiredSeries?.id === episode.id;

    if (episode.air_date) {
        const daysSince = getDaysSinceAir(episode.air_date);
        if (daysSince >= 0 && daysSince <= 7 && isUnwatched) {
            badges.push({ label: 'Nuevo', className: 'tvst-badge tvst-badge--new' });
        }
    }

    if (isLastOfSeries && isUnwatched) {
        badges.push({ label: 'Último', className: 'tvst-badge tvst-badge--last' });
    }

    return badges;
}

function createEpisodeCardMarkup({
    show,
    episode,
    variant = 'pending',
    allAiredEpisodes = [],
    remainingCount = 0,
    showAction = false,
    airMeta = '',
}) {
    const badges = (variant === 'pending' || variant === 'upcoming')
        ? getEpisodeBadges(show, episode, allAiredEpisodes)
        : [];
    const episodeCode = formatEpisodeLabel(episode.seasonNumber, episode.episodeNumber);
    const poster = show.portada
        ? `<img src="${show.portada}" alt="">`
        : '<span style="display:flex;align-items:center;justify-content:center;height:100%;font-size:1.1rem">TV</span>';

    let rightSide = '';
    if (showAction) {
        rightSide = `<button type="button" class="tvst-check-btn" onclick="event.stopPropagation(); toggleEpisode(${show.id_tmdb}, '${episode.id}')" aria-label="Marcar visto">✓</button>`;
    } else if (variant === 'history') {
        rightSide = `<span class="tvst-check-btn is-watched" aria-hidden="true">✓</span>`;
    } else if (airMeta) {
        const meta = typeof airMeta === 'object'
            ? airMeta
            : { text: airMeta, className: 'tvst-air-time' };
        rightSide = `<div class="tvst-row-meta">
            <span class="${meta.className || 'tvst-air-time'}">${meta.text}</span>
            ${meta.sub ? `<span class="tvst-air-sub">${meta.sub}</span>` : ''}
        </div>`;
    }

    return `
        <article class="tvst-episode-row${variant === 'history' ? ' is-history' : ''}${normalizeStatus(show.estado) === 'standby' ? ' is-standby' : ''}"
            onclick="openEpisodeDetail(${show.id_tmdb}, '${episode.id}')"
            role="button" tabindex="0">
            <div class="tvst-episode-poster">${poster}</div>
            <div class="tvst-episode-body">
                <a href="#" onclick="event.stopPropagation(); openDetail('tv', ${show.id_tmdb});return false;" class="tvst-show-pill">${show.titulo} ›</a>
                <div class="tvst-episode-code-row">
                    <span class="tvst-episode-code">${episodeCode}</span>
                    ${remainingCount > 0 ? `<span class="tvst-remaining">+${remainingCount}</span>` : ''}
                </div>
                ${episode.name ? `<p class="tvst-episode-title">${episode.name}</p>` : ''}
                ${badges.length ? `<div class="tvst-badges">${badges.map(b => `<span class="${b.className}">${b.label}</span>`).join('')}</div>` : ''}
            </div>
            ${rightSide}
        </article>`;
}

function getTimelineStickyOffset() {
    // Solo la subnav: la barra "Ver a continuación" queda arriba del viewport
    // para que la vista inicial coincida con VER A CONTINUACIÓN + lista + hueco
    const subnav = document.querySelector('#content-series .tvst-subnav');
    return subnav?.offsetHeight || 48;
}

function anchorTimelineToNow(tabKey, behavior = 'auto') {
    const anchor = document.querySelector(`[data-timeline-anchor="${tabKey}"]`);
    if (!anchor) return;

    const scroll = () => {
        const stickyOffset = getTimelineStickyOffset();
        const top = anchor.getBoundingClientRect().top + window.scrollY - stickyOffset;
        window.scrollTo({ top: Math.max(0, top), behavior });
    };

    // Varios intentos: layout / posters pueden desplazar el ancla
    requestAnimationFrame(() => {
        requestAnimationFrame(scroll);
    });
    setTimeout(scroll, 60);
    setTimeout(scroll, 200);
    setTimeout(() => {
        scroll();
        window.__seenitHistoryLoadReady = true;
        window.__seenitLastScrollY = window.scrollY;
    }, 350);
}

function scrollToNowAnchor() {
    if (AppState.currentTab === 'series' && AppState.currentSubTab === 'upcoming') {
        const upcoming = document.getElementById('upcoming-list-container');
        if (upcoming) upcoming.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
    }
    window.__seenitHistoryLoadReady = false;
    anchorTimelineToNow('pending-list', 'smooth');
}

function handleTimelineScroll() {
    if (AppState.currentTab !== 'series' || AppState.currentSubTab !== 'pending-list') return;
    if (!window.__seenitHistoryLoadReady) return;

    const y = window.scrollY;
    const lastY = window.__seenitLastScrollY ?? y;
    const scrollingUp = y < lastY - 2;
    window.__seenitLastScrollY = y;

    // Solo cargar historial al subir hacia el borde superior
    if (scrollingUp && y < 120) {
        loadMorePendingHistory();
    }
}

function loadMorePendingHistory() {
    const tabKey = 'pending-list';
    const cache = AppState.timelineHistoryCache[tabKey];
    if (!cache?.length || window.__seenitLoadingMoreHistory) return;

    const currentCount = AppState.timelineHistoryVisible[tabKey] || 0;
    if (currentCount >= cache.length) return;

    window.__seenitLoadingMoreHistory = true;
    const anchor = document.querySelector(`[data-timeline-anchor="${tabKey}"]`);
    const anchorOffset = anchor ? anchor.getBoundingClientRect().top : 0;
    // Primera carga: bastantes ítems para poder seguir subiendo; luego de 8 en 8
    const step = currentCount === 0 ? Math.min(10, cache.length) : 8;
    AppState.timelineHistoryVisible[tabKey] = Math.min(currentCount + step, cache.length);

    Promise.resolve(renderPendingList({ preserveAnchor: true, anchorOffset })).finally(() => {
        window.__seenitLoadingMoreHistory = false;
    });
}

function attachPendingHistoryObserver() {
    if (window.__seenitPendingHistoryObserver) {
        window.__seenitPendingHistoryObserver.disconnect();
        window.__seenitPendingHistoryObserver = null;
    }

    const sentinel = document.getElementById('pending-history-sentinel');
    if (!sentinel) return;

    window.__seenitPendingHistoryObserver = new IntersectionObserver((entries) => {
        if (!window.__seenitHistoryLoadReady) return;
        if (entries.some(e => e.isIntersecting)) {
            loadMorePendingHistory();
        }
    }, { root: null, rootMargin: '40px', threshold: 0 });

    window.__seenitPendingHistoryObserver.observe(sentinel);
}

function attachTimelineScrollPersistence() {
    if (window.__seenitTimelineListenerAttached) return;
    window.addEventListener('scroll', handleTimelineScroll, { passive: true });
    window.__seenitTimelineListenerAttached = true;
}

function preserveAnchorAfterHistoryLoad(tabKey, previousOffset) {
    const anchor = document.querySelector(`[data-timeline-anchor="${tabKey}"]`);
    if (!anchor || previousOffset === undefined) return;
    const newOffset = anchor.getBoundingClientRect().top;
    const delta = newOffset - previousOffset;
    if (Math.abs(delta) > 1) {
        window.scrollBy(0, delta);
    }
}

/**
 * Renderiza la lista pendiente
 */
async function renderPendingList(options = {}) {
    const container = document.getElementById('pending-list-container');
    if (!container) return;

    container.innerHTML = emptyState('episodes', 'Cargando episodios...', { loading: true });

    const allTvShows = AppState.shows;
    await Promise.all(allTvShows.map(show => refreshShowStatus(show)));
    const watchingShows = allTvShows.filter(show => normalizeStatus(show.estado) === 'watching');

    if (watchingShows.length === 0 && allTvShows.length === 0) {
        container.innerHTML = emptyState(
            'spark',
            'Tu lista está vacía',
            { subtitle: 'Pon series en estado «Viendo» para ver episodios aquí.' },
        );
        return;
    }

    const pendingEpisodes = [];
    const historyEpisodes = [];

    for (const show of allTvShows) {
        const episodes = await getOrderedEpisodes(show, { includeSpecials: false });
        const airedEpisodes = episodes.filter(isEpisodeAired);

        airedEpisodes.filter(ep => show.capitulos_vistos?.includes(ep.id)).forEach(episode => {
            historyEpisodes.push({ show, episode, airedEpisodes });
        });
    }

    for (const show of watchingShows) {
        const episodes = await getOrderedEpisodes(show, { includeSpecials: false });
        const airedEpisodes = episodes.filter(isEpisodeAired);
        const nextEpisode = airedEpisodes.find(ep => !show.capitulos_vistos?.includes(ep.id));

        if (nextEpisode) {
            const remainingCount = Math.max(0, airedEpisodes.filter(ep => !show.capitulos_vistos?.includes(ep.id)).length - 1);
            pendingEpisodes.push({ show, episode: nextEpisode, airedEpisodes, remainingCount });
        }
    }

    const sortPending = (a, b) => {
        const titleCompare = (a.show.titulo || '').localeCompare(b.show.titulo || '', 'es', { sensitivity: 'base' });
        if (titleCompare !== 0) return titleCompare;
        return (a.episode.air_date || '9999-12-31').localeCompare(b.episode.air_date || '9999-12-31');
    };

    const continueWatching = pendingEpisodes
        .filter(({ show, episode }) => isShowInContinueSection(show, episode))
        .sort(sortPending);
    const staleWatching = pendingEpisodes
        .filter(({ show, episode }) => !isShowInContinueSection(show, episode))
        .sort(sortPending);

    historyEpisodes.sort((a, b) => {
        const watchedAtA = getEpisodeWatchedAt(a.show, a.episode.id);
        const watchedAtB = getEpisodeWatchedAt(b.show, b.episode.id);
        if (watchedAtA && watchedAtB && watchedAtA !== watchedAtB) {
            return watchedAtA.localeCompare(watchedAtB);
        }
        if (watchedAtA && !watchedAtB) return 1;
        if (!watchedAtA && watchedAtB) return -1;
        const dateA = a.episode.air_date || '9999-12-31';
        const dateB = b.episode.air_date || '9999-12-31';
        if (dateA !== dateB) return dateA.localeCompare(dateB);
        return (a.episode.seasonNumber || 0) - (b.episode.seasonNumber || 0) || (a.episode.episodeNumber || 0) - (b.episode.episodeNumber || 0);
    });

    AppState.timelineHistoryCache['pending-list'] = historyEpisodes;

    // Historial reciente ya en el DOM encima del ancla (sin pull-zone)
    const defaultVisible = Math.min(12, historyEpisodes.length || 12);
    if (!options.preserveAnchor && !options.keepHistoryCount) {
        AppState.timelineHistoryVisible['pending-list'] = Math.max(
            AppState.timelineHistoryVisible['pending-list'] || 0,
            defaultVisible,
        );
    }
    AppState.timelineHistoryVisible['pending-list'] = Math.min(
        AppState.timelineHistoryVisible['pending-list'] || defaultVisible,
        historyEpisodes.length || AppState.timelineHistoryVisible['pending-list'] || defaultVisible,
    );
    const historyVisibleCount = AppState.timelineHistoryVisible['pending-list'];
    const visibleHistory = historyEpisodes.slice(-historyVisibleCount);
    const hasMoreHistory = historyEpisodes.length > historyVisibleCount;

    if (pendingEpisodes.length === 0 && historyEpisodes.length === 0) {
        container.innerHTML = emptyState(
            'check',
            'Todo al día',
            { subtitle: 'No hay episodios pendientes por ver.' },
        );
        return;
    }

    const renderPendingCards = (items) => items.map(({ show, episode, airedEpisodes, remainingCount }) => createEpisodeCardMarkup({
        show, episode, variant: 'pending', allAiredEpisodes: airedEpisodes, remainingCount, showAction: true,
    })).join('');

    container.className = 'tvst-episode-list';
    container.innerHTML = `
        ${hasMoreHistory ? `
            <div id="pending-history-sentinel" class="tvst-history-sentinel" aria-hidden="true">
                <span class="tvst-history-pull-label">Cargar más historial</span>
            </div>
        ` : ''}
        ${visibleHistory.map(({ show, episode, airedEpisodes }) => createEpisodeCardMarkup({
            show, episode, variant: 'history', allAiredEpisodes: airedEpisodes || [], showAction: false,
        })).join('')}
        <div data-timeline-anchor="pending-list" class="tvst-timeline-marker">Ver a continuación</div>
        ${continueWatching.length
            ? renderPendingCards(continueWatching)
            : emptyState('episodes', 'No hay episodios recientes por ver')}
        ${staleWatching.length ? `
            <div class="tvst-timeline-marker">Sin ver por un tiempo</div>
            ${renderPendingCards(staleWatching)}
        ` : ''}
        <div class="tvst-timeline-spacer" aria-hidden="true"></div>
    `;

    attachTimelineScrollPersistence();
    attachPendingHistoryObserver();

    if (options.preserveAnchor) {
        preserveAnchorAfterHistoryLoad('pending-list', options.anchorOffset);
    } else {
        window.__seenitHistoryLoadReady = false;
        anchorTimelineToNow('pending-list', 'auto');
    }
}

/**
 * Renderiza la lista de próximos episodios
 */
async function renderUpcomingList() {
    const container = document.getElementById('upcoming-list-container');
    if (!container) return;

    container.innerHTML = emptyState('calendar', 'Cargando próximos...', { loading: true });

    const allTvShows = AppState.shows;
    // Refrescar temporadas/air dates desde TMDB si faltan
    await Promise.all(allTvShows.map(async (show) => {
        try {
            if (!show.temporadas?.length || !show.status || show.status === 'Unknown') {
                const fresh = await getTVDetails(show.id_tmdb);
                if (fresh?.temporadas?.length) show.temporadas = fresh.temporadas;
                if (fresh?.status) show.status = fresh.status;
            }
            await refreshShowStatus(show);
        } catch (error) {
            console.warn('[App] No se pudo refrescar show para próximos:', show.titulo, error);
        }
    }));

    const watchingShows = allTvShows.filter(show => normalizeStatus(show.estado) === 'watching');

    if (watchingShows.length === 0) {
        container.innerHTML = emptyState(
            'spark',
            'Nada en próximamente',
            { subtitle: 'Pon series en «Viendo» para ver próximos episodios.' },
        );
        return;
    }

    const upcomingEpisodes = [];

    for (const show of watchingShows) {
        if (!show.temporadas?.length) {
            try {
                const fresh = await getTVDetails(show.id_tmdb);
                if (fresh?.temporadas?.length) show.temporadas = fresh.temporadas;
            } catch (_) { /* continue */ }
        }

        const episodes = await getOrderedEpisodes(show, { includeSpecials: false });
        const airedEpisodes = episodes.filter(isEpisodeAired);
        episodes.forEach(episode => {
            if (!episode.air_date) return;
            const daysUntil = getDaysUntilAir(episode.air_date);
            if (daysUntil != null && daysUntil > 0) {
                upcomingEpisodes.push({ show, episode, airedEpisodes });
            }
        });
    }

    upcomingEpisodes.sort((a, b) => (a.episode.air_date || '9999').localeCompare(b.episode.air_date || '9999'));

    if (upcomingEpisodes.length === 0) {
        container.innerHTML = emptyState(
            'calendar',
            'Sin episodios programados',
            { subtitle: 'No hay próximos estrenos de episodios en tus series.' },
        );
        return;
    }

    const groupedUpcoming = upcomingEpisodes.reduce((acc, item) => {
        const label = formatUpcomingDateLabel(item.episode.air_date);
        if (!acc[label]) acc[label] = [];
        acc[label].push(item);
        return acc;
    }, {});

    const bucketOrder = ['HOY', 'MAÑANA', 'LUNES', 'MARTES', 'MIÉRCOLES', 'JUEVES', 'VIERNES', 'SÁBADO', 'DOMINGO', 'MÁS TARDE'];
    const dayKeys = Object.keys(groupedUpcoming).sort((a, b) => {
        if (a === 'MÁS TARDE' && b !== 'MÁS TARDE') return 1;
        if (b === 'MÁS TARDE' && a !== 'MÁS TARDE') return -1;
        const aDate = groupedUpcoming[a][0].episode.air_date;
        const bDate = groupedUpcoming[b][0].episode.air_date;
        const byDate = (aDate || '9999').localeCompare(bDate || '9999');
        if (byDate !== 0) return byDate;
        return bucketOrder.indexOf(a) - bucketOrder.indexOf(b);
    });

    container.className = 'tvst-episode-list';
    container.innerHTML = dayKeys.map(label => `
        <div class="tvst-day-capsule-wrap"><span class="tvst-day-capsule">${label}</span></div>
        ${groupedUpcoming[label].map(({ show, episode, airedEpisodes }) => createEpisodeCardMarkup({
            show,
            episode,
            variant: 'upcoming',
            allAiredEpisodes: airedEpisodes || [],
            showAction: false,
            airMeta: getAirTimeMeta(episode.air_date, label),
        })).join('')}
    `).join('');

    requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'auto' }));
}

/**
 * Renderiza la vista de perfil
 */
async function renderProfileView() {
    AppState.profileSeriesFilter = document.getElementById('profile-series-filter')?.value || AppState.profileSeriesFilter;
    AppState.profileMoviesFilter = document.getElementById('profile-movies-filter')?.value || AppState.profileMoviesFilter;

    const seriesContainer = document.getElementById('profile-series-container');
    const moviesContainer = document.getElementById('profile-movies-container');

    if (!seriesContainer || !moviesContainer) return;

    if (AppState.currentProfileTab === 'series') {
        document.getElementById('profile-series-content')?.classList.remove('hidden');
        document.getElementById('profile-movies-content')?.classList.add('hidden');
    } else {
        document.getElementById('profile-series-content')?.classList.add('hidden');
        document.getElementById('profile-movies-content')?.classList.remove('hidden');
    }

    // Solo datos locales: no refrescar TMDB en cada cambio de filtro
    const filteredSeries = AppState.shows
        .filter(show => filterProfileSeries(show))
        .sort((a, b) => (a.titulo || '').localeCompare(b.titulo || '', 'es', { sensitivity: 'base' }));
    const filteredMovies = AppState.movies
        .filter(movie => filterProfileMovies(movie))
        .sort((a, b) => (a.titulo || '').localeCompare(b.titulo || '', 'es', { sensitivity: 'base' }));

    const seriesExpanded = Boolean(AppState.profileExpanded.series);
    const moviesExpanded = Boolean(AppState.profileExpanded.movies);

    seriesContainer.className = `tvst-profile-rail${seriesExpanded ? ' is-expanded' : ''}`;
    moviesContainer.className = `tvst-profile-rail${moviesExpanded ? ' is-expanded' : ''}`;

    const seriesMoreBtn = document.getElementById('profile-series-more');
    const moviesMoreBtn = document.getElementById('profile-movies-more');
    if (seriesMoreBtn) seriesMoreBtn.textContent = seriesExpanded ? 'Mostrar menos' : 'Mostrar más';
    if (moviesMoreBtn) moviesMoreBtn.textContent = moviesExpanded ? 'Mostrar menos' : 'Mostrar más';

    seriesContainer.innerHTML = renderProfileCards(filteredSeries, 'tv');
    moviesContainer.innerHTML = renderProfileCards(filteredMovies, 'movie');
    renderProfileFavorites();
    renderProfileLists();
    renderWatchStats();
}

// ============================================
// LISTAS PERSONALIZADAS
// ============================================

function getListsByTipo(tipo) {
    return (AppState.lists || []).filter(l => l.tipo === tipo);
}

function getLibraryItem(tipo, id_tmdb) {
    const id = Number(id_tmdb);
    return tipo === 'movie'
        ? AppState.movies.find(m => m.id_tmdb === id)
        : AppState.shows.find(s => s.id_tmdb === id);
}

function getListCoverUrl(list) {
    const coverId = Number(list.coverId) || Number(list.itemIds?.[0]) || null;
    if (!coverId) return null;
    const item = getLibraryItem(list.tipo, coverId);
    return item?.portada || item?.poster || null;
}

function createList(name, tipo) {
    const list = normalizeStoredList({
        id: `lst_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: String(name || '').trim() || 'Nueva lista',
        tipo: tipo === 'movie' ? 'movie' : 'tv',
        itemIds: [],
        coverId: null,
    });
    AppState.lists.push(list);
    saveLocalData();
    syncToDrive();
    return list;
}

function deleteList(listId) {
    AppState.lists = AppState.lists.filter(l => l.id !== listId);
    if (AppState.selectedListId === listId) {
        closeListModal();
    }
    saveLocalData();
    syncToDrive();
    renderProfileLists();
}

function renameList(listId, name) {
    const list = AppState.lists.find(l => l.id === listId);
    if (!list) return;
    const next = String(name || '').trim();
    if (!next) return;
    list.name = next;
    saveLocalData();
    syncToDrive();
    renderProfileLists();
    if (AppState.selectedListId === listId) {
        renderListModal();
    }
}

function addItemToList(listId, id_tmdb) {
    const list = AppState.lists.find(l => l.id === listId);
    if (!list) return false;
    const id = Number(id_tmdb);
    if (!Number.isFinite(id) || id <= 0) return false;
    if (!getLibraryItem(list.tipo, id)) return false;
    if (list.itemIds.includes(id)) return false;
    list.itemIds.push(id);
    if (!list.coverId) list.coverId = id;
    saveLocalData();
    syncToDrive();
    return true;
}

function removeItemFromList(listId, id_tmdb) {
    const list = AppState.lists.find(l => l.id === listId);
    if (!list) return;
    const id = Number(id_tmdb);
    list.itemIds = list.itemIds.filter(x => x !== id);
    if (Number(list.coverId) === id) {
        list.coverId = list.itemIds[0] || null;
    }
    saveLocalData();
    syncToDrive();
    renderProfileLists();
    if (AppState.selectedListId === listId) {
        renderListModal();
    }
}

function removeItemFromAllLists(tipo, id_tmdb) {
    const id = Number(id_tmdb);
    for (const list of AppState.lists) {
        if (list.tipo !== tipo) continue;
        list.itemIds = list.itemIds.filter(x => x !== id);
        if (Number(list.coverId) === id) {
            list.coverId = list.itemIds[0] || null;
        }
    }
}

function promptCreateList(tipo, { addSelectedItem = false } = {}) {
    const label = tipo === 'movie' ? 'películas' : 'series';
    const name = prompt(`Nombre de la lista de ${label}:`);
    if (name == null) return null;
    const trimmed = name.trim();
    if (!trimmed) {
        showToast('Nombre vacío', 'info');
        return null;
    }
    const list = createList(trimmed, tipo);
    if (addSelectedItem && AppState.selectedItem?.tipo === tipo) {
        addItemToList(list.id, AppState.selectedItem.id_tmdb);
    }
    renderProfileLists();
    showToast('Lista creada', 'success');
    return list;
}

function createProfileList() {
    const tipo = AppState.currentProfileTab === 'movies' ? 'movie' : 'tv';
    promptCreateList(tipo);
}

function renderProfileLists() {
    const seriesEl = document.getElementById('profile-series-lists');
    const moviesEl = document.getElementById('profile-movies-lists');
    if (!seriesEl || !moviesEl) return;

    const renderBanners = (tipo) => {
        const lists = getListsByTipo(tipo);
        if (!lists.length) {
            return `<p class="tvst-lists-empty">Aún no tienes listas de ${tipo === 'movie' ? 'películas' : 'series'}.</p>`;
        }
        return lists.map(list => {
            const cover = getListCoverUrl(list);
            const count = list.itemIds.length;
            const safeCover = cover ? String(cover).replace(/'/g, '%27') : '';
            const style = safeCover
                ? `style="background-image:url('${safeCover}')"`
                : '';
            return `
                <button type="button" class="tvst-list-banner${!cover ? ' is-empty' : ''}" ${style} onclick="openListModal('${list.id}')">
                    <span class="tvst-list-banner-overlay">
                        <span class="tvst-list-banner-name">${escapeHtml(list.name)}</span>
                        <span class="tvst-list-banner-meta">${count} ${count === 1 ? 'título' : 'títulos'}</span>
                    </span>
                </button>
            `;
        }).join('');
    };

    seriesEl.innerHTML = renderBanners('tv');
    moviesEl.innerHTML = renderBanners('movie');
}

function renderProfileFavorites() {
    const seriesEl = document.getElementById('profile-series-favorites');
    const moviesEl = document.getElementById('profile-movies-favorites');
    if (!seriesEl || !moviesEl) return;

    const renderFavs = (items, tipo) => {
        const favs = items
            .filter(item => Boolean(item.favorito))
            .sort((a, b) => (a.titulo || '').localeCompare(b.titulo || '', 'es', { sensitivity: 'base' }));
        if (!favs.length) {
            return `<p class="tvst-lists-empty">Sin favoritos todavía.</p>`;
        }
        return favs.map(item => {
            const img = item.portada || item.poster;
            return `
                <button type="button" class="tvst-fav-card" onclick="openDetail('${tipo}', ${item.id_tmdb})">
                    <div class="tvst-fav-card-poster">
                        ${img
                            ? `<img src="${img}" alt="${escapeHtml(item.titulo || '')}" loading="lazy">`
                            : `<div class="tvst-poster-fallback">${escapeHtml((item.titulo || '?').slice(0, 1))}</div>`}
                    </div>
                    <p class="tvst-fav-card-title">${escapeHtml(item.titulo || 'Sin título')}</p>
                </button>
            `;
        }).join('');
    };

    seriesEl.innerHTML = renderFavs(AppState.shows, 'tv');
    moviesEl.innerHTML = renderFavs(AppState.movies, 'movie');
}

function toggleFavorite(tipo, id_tmdb) {
    const item = getLibraryItem(tipo, id_tmdb);
    if (!item) {
        showToast('Añade el título primero', 'info');
        return;
    }
    item.favorito = !Boolean(item.favorito);
    if (AppState.selectedItem?.id_tmdb === id_tmdb && AppState.selectedItem?.tipo === tipo) {
        AppState.selectedItem = { ...AppState.selectedItem, favorito: item.favorito };
    }
    saveLocalData();
    syncToDrive();
    renderProfileFavorites();
    showToast(item.favorito ? 'Añadido a favoritos' : 'Quitado de favoritos', item.favorito ? 'success' : 'info');
}

function openListModal(listId) {
    const list = AppState.lists.find(l => l.id === listId);
    if (!list) return;
    AppState.selectedListId = listId;
    AppState.listCoverPickMode = false;
    renderListModal();
    document.getElementById('list-modal')?.classList.remove('hidden');
}

function closeListModal() {
    AppState.selectedListId = null;
    AppState.listCoverPickMode = false;
    document.getElementById('list-modal')?.classList.remove('is-cover-pick');
    document.getElementById('list-cover-hint')?.classList.add('hidden');
    document.getElementById('list-modal')?.classList.add('hidden');
}

function getListItemProgress(item, tipo) {
    if (tipo === 'tv') {
        return getShowProgressInfo(item);
    }
    const completed = normalizeStatus(item.estado) === 'completed';
    return {
        progress: completed ? 100 : 0,
        colorClass: completed ? 'tvst-progress-green' : 'tvst-progress-gray',
        label: completed ? '100%' : '0%',
    };
}

function renderListModal() {
    const list = AppState.lists.find(l => l.id === AppState.selectedListId);
    if (!list) return;

    const titleEl = document.getElementById('list-modal-title');
    const gridEl = document.getElementById('list-modal-grid');
    const modal = document.getElementById('list-modal');
    const hint = document.getElementById('list-cover-hint');
    const coverBtn = document.getElementById('list-cover-btn');

    if (titleEl) titleEl.textContent = list.name;
    if (!gridEl) return;

    modal?.classList.toggle('is-cover-pick', Boolean(AppState.listCoverPickMode));
    hint?.classList.toggle('hidden', !AppState.listCoverPickMode);
    if (coverBtn) {
        coverBtn.textContent = AppState.listCoverPickMode ? 'Cancelar portada' : 'Cambiar portada';
    }

    const items = list.itemIds
        .map(id => getLibraryItem(list.tipo, id))
        .filter(Boolean);

    if (!items.length) {
        gridEl.innerHTML = `<p class="tvst-lists-empty">Esta lista está vacía. Añade títulos desde el menú ⋯ del detalle.</p>`;
        return;
    }

    const coverId = Number(list.coverId) || null;

    gridEl.innerHTML = items.map(item => {
        const img = item.portada || item.poster;
        const prog = getListItemProgress(item, list.tipo);
        const isCover = coverId === Number(item.id_tmdb);
        return `
        <article class="tvst-list-item${isCover ? ' is-cover' : ''}">
            <div class="tvst-list-item-poster-wrap">
                <button type="button" class="tvst-list-item-poster" onclick="onListItemClick(${item.id_tmdb}, '${list.tipo}')">
                    ${img
                        ? `<img src="${img}" alt="${escapeHtml(item.titulo || '')}" loading="lazy">`
                        : `<div class="tvst-poster-fallback">${escapeHtml((item.titulo || '?').slice(0, 1))}</div>`}
                    <span class="tvst-list-item-overlay">
                        <span class="tvst-list-item-overlay-title">${escapeHtml(item.titulo || 'Sin título')}</span>
                    </span>
                </button>
                ${AppState.listCoverPickMode
                    ? ''
                    : `<button type="button" class="tvst-list-item-remove" onclick="removeItemFromList('${list.id}', ${item.id_tmdb})" title="Quitar de la lista">×</button>`}
            </div>
            <div class="tvst-list-item-progress">
                <div class="tvst-progress-track">
                    <div class="tvst-progress-fill ${prog.colorClass}" style="width:${prog.progress}%"></div>
                </div>
                <p class="tvst-list-item-pct">${prog.progress}%</p>
            </div>
        </article>
    `;
    }).join('');
}

function onListItemClick(id_tmdb, tipo) {
    if (AppState.listCoverPickMode && AppState.selectedListId) {
        setListCover(AppState.selectedListId, id_tmdb);
        return;
    }
    openDetailFromList(id_tmdb, tipo);
}

function setListCover(listId, id_tmdb) {
    const list = AppState.lists.find(l => l.id === listId);
    if (!list) return;
    const id = Number(id_tmdb);
    if (!list.itemIds.includes(id)) return;
    list.coverId = id;
    AppState.listCoverPickMode = false;
    saveLocalData();
    syncToDrive();
    renderProfileLists();
    renderListModal();
    showToast('Portada actualizada', 'success');
}

function toggleListCoverPickMode() {
    if (!AppState.selectedListId) return;
    AppState.listCoverPickMode = !AppState.listCoverPickMode;
    renderListModal();
}

function openDetailFromList(id_tmdb, tipo) {
    closeListModal();
    openDetail(tipo, id_tmdb);
}

function renameSelectedList() {
    const list = AppState.lists.find(l => l.id === AppState.selectedListId);
    if (!list) return;
    const name = prompt('Nuevo nombre de la lista:', list.name);
    if (name == null) return;
    renameList(list.id, name);
}

function deleteSelectedList() {
    const list = AppState.lists.find(l => l.id === AppState.selectedListId);
    if (!list) return;
    if (!confirm(`¿Eliminar la lista «${list.name}»? Los títulos no se borran de tu biblioteca.`)) return;
    deleteList(list.id);
    showToast('Lista eliminada', 'success');
}

function openListPicker() {
    const item = AppState.selectedItem;
    if (!item || !isItemAlreadyAdded(item.tipo, item.id_tmdb)) {
        showToast('Añade el título primero', 'info');
        return;
    }

    const modal = document.getElementById('list-picker-modal');
    const body = document.getElementById('list-picker-body');
    if (!modal || !body) return;

    const lists = getListsByTipo(item.tipo);
    const rows = lists.length
        ? lists.map(list => {
            const inList = list.itemIds.includes(Number(item.id_tmdb));
            return `
                <button type="button" class="tvst-list-picker-row${inList ? ' is-in' : ''}" onclick="toggleSelectedInList('${list.id}')">
                    <span>${escapeHtml(list.name)}</span>
                    <span class="tvst-list-picker-check">${inList ? '✓' : '+'}</span>
                </button>
            `;
        }).join('')
        : `<p class="tvst-lists-empty">No hay listas de ${item.tipo === 'movie' ? 'películas' : 'series'}.</p>`;

    body.innerHTML = `
        ${rows}
        <button type="button" class="tvst-list-picker-create" onclick="createListFromPicker()">+ Crear lista nueva</button>
    `;
    modal.classList.remove('hidden');
}

function closeListPicker() {
    document.getElementById('list-picker-modal')?.classList.add('hidden');
}

function toggleSelectedInList(listId) {
    const item = AppState.selectedItem;
    if (!item) return;
    const list = AppState.lists.find(l => l.id === listId);
    if (!list || list.tipo !== item.tipo) return;

    const id = Number(item.id_tmdb);
    if (list.itemIds.includes(id)) {
        removeItemFromList(listId, id);
        showToast('Quitado de la lista', 'info');
    } else {
        addItemToList(listId, id);
        showToast('Añadido a la lista', 'success');
    }
    openListPicker();
    renderProfileLists();
}

function createListFromPicker() {
    const item = AppState.selectedItem;
    if (!item) return;
    const list = promptCreateList(item.tipo, { addSelectedItem: true });
    if (list) openListPicker();
}

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatWatchDuration(totalMinutes) {
    const mins = Math.max(0, Math.round(Number(totalMinutes) || 0));
    const totalHours = Math.floor(mins / 60);
    const months = Math.floor(totalHours / (24 * 30));
    const days = Math.floor((totalHours % (24 * 30)) / 24);
    const hours = totalHours % 24;
    return `${months} meses · ${days} días · ${hours} h`;
}

function getShowEpisodeRuntimeMinutes(show) {
    const stored = Number(show?.episode_run_time);
    if (stored > 0) return stored;
    return 45;
}

function renderWatchStats() {
    const seriesEl = document.getElementById('stats-series-time');
    const moviesEl = document.getElementById('stats-movies-time');
    if (!seriesEl || !moviesEl) return;

    let seriesMinutes = 0;
    for (const show of AppState.shows) {
        const watched = Array.isArray(show.capitulos_vistos) ? show.capitulos_vistos.length : 0;
        seriesMinutes += watched * getShowEpisodeRuntimeMinutes(show);
    }

    let moviesMinutes = 0;
    for (const movie of AppState.movies) {
        if (normalizeStatus(movie.estado) !== 'completed') continue;
        const runtime = Number(movie.runtime);
        moviesMinutes += runtime > 0 ? runtime : 100;
    }

    seriesEl.textContent = formatWatchDuration(seriesMinutes);
    moviesEl.textContent = formatWatchDuration(moviesMinutes);
}

function toggleProfileExpanded(kind) {
    AppState.profileExpanded[kind] = !AppState.profileExpanded[kind];
    renderProfileView();
}

function getOfficialStatus(show) {
    return String(show?.status || show?.tmdb_status || show?.official_status || 'Unknown')
        .trim()
        .toLowerCase();
}

function getShowProgressInfo(show) {
    const watchedCount = Number(show.episodios_vistos_count || 0);
    const airedCount = Number(show.episodios_emitidos || 0);
    const progress = airedCount > 0 ? Math.min(100, Math.round((watchedCount / airedCount) * 100)) : 0;
    const normalizedStatus = normalizeStatus(show.estado);
    const officialStatus = getOfficialStatus(show);
    const isOfficialEnded = officialStatus === 'ended' || officialStatus === 'canceled';

    let colorClass = 'tvst-progress-gray';
    if (normalizedStatus === 'dropped') {
        colorClass = 'tvst-progress-red';
    } else if (normalizedStatus === 'standby') {
        colorClass = 'tvst-progress-amber';
    } else if (normalizedStatus === 'completed' && isOfficialEnded) {
        colorClass = 'tvst-progress-purple';
    } else if (normalizedStatus === 'watching' || normalizedStatus === 'completed') {
        colorClass = 'tvst-progress-green';
    } else if (normalizedStatus === 'pending') {
        colorClass = 'tvst-progress-gray';
    }

    return {
        progress,
        colorClass,
        label: `${progress}%`,
        airedCount,
        watchedCount,
    };
}

function filterProfileSeries(show) {
    const status = normalizeStatus(show.estado);
    if (AppState.profileSeriesFilter === 'all') return true;
    return status === AppState.profileSeriesFilter;
}

function filterProfileMovies(movie) {
    const status = normalizeStatus(movie.estado);
    if (AppState.profileMoviesFilter === 'all') return true;
    if (AppState.profileMoviesFilter === 'completed') return status === 'completed';
    return status !== 'completed';
}

function renderProfileCards(items, type) {
    if (items.length === 0) {
        return emptyState(type === 'tv' ? 'episodes' : 'film', 'No hay contenido en esta categoría', { grid: true });
    }

    return items.map(item => {
        const personalRating = item.puntuacion && item.puntuacion > 0 ? Number(item.puntuacion) : null;
        const tmdbRating = item.vote_average !== undefined && item.vote_average !== null
            ? Number(item.vote_average)
            : null;
        const progressData = type === 'tv' ? getShowProgressInfo(item) : null;
        const statusBadge = getStatusBadge(item.estado);

        return `
        <div class="profile-card cursor-pointer flex flex-col${normalizeStatus(item.estado) === 'standby' ? ' is-standby' : ''}" onclick="openDetail('${type}', ${item.id_tmdb})">
            <div class="relative aspect-[2/3] bg-zinc-900 rounded overflow-hidden mb-2 w-full">
                ${item.portada ? `<img src="${item.portada}" alt="${item.titulo}" class="w-full h-full object-cover">` : '<div class="w-full h-full flex items-center justify-center text-2xl">🎬</div>'}
                ${tmdbRating !== null ? `<div class="tvst-poster-score is-tmdb">${tmdbRating.toFixed(1)}</div>` : ''}
                ${personalRating !== null ? `<div class="tvst-poster-score is-user">★ ${personalRating.toFixed(1)}</div>` : ''}
            </div>
            <h3 class="font-semibold text-xs truncate text-white">${item.titulo}</h3>
            ${statusBadge}
            ${progressData ? `
                <div class="w-full">
                    <div class="tvst-progress-track">
                        <div class="tvst-progress-fill ${progressData.colorClass}" style="width: ${progressData.progress}%;"></div>
                    </div>
                    <p class="text-[10px] text-gray-500 mt-0.5">${progressData.progress}%</p>
                </div>
            ` : ''}
        </div>`;
    }).join('');
}

/**
 * Renderiza la pestaña Ajustes
 */
/**
 * Renderiza la pestaña Información del detalle
 */
function renderDetailInfo(item) {
    const container = document.getElementById('detail-info-panel');
    if (!container) return;

    const cast = item?.credits?.cast || [];
    const recommendations = item?.recommendations || [];
    const overview = item?.overview || 'Sin descripción disponible.';
    const voteAverage = item?.vote_average !== undefined && item?.vote_average !== null ? Number(item.vote_average).toFixed(1) : 'N/D';
    const personal = item?.puntuacion && item.puntuacion > 0 ? Number(item.puntuacion) : 0;
    const providers = item?.watch_providers || [];
    const inLibrary = isItemAlreadyAdded(item.tipo, item.id_tmdb);
    const personalLabel = personal > 0 ? personal.toFixed(1) : '—';

    const ratingControl = inLibrary ? `
        <div class="tvst-nota-modern">
            <div class="tvst-nota-score" id="detail-personal-score">${personalLabel}</div>
            <div class="tvst-nota-stars" role="group" aria-label="Tu puntuación">
                ${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => `
                    <button type="button"
                        class="tvst-nota-star${n <= Math.round(personal) ? ' is-on' : ''}"
                        onclick="setPersonalRating(${n})"
                        aria-label="${n}">${n <= Math.round(personal) ? '★' : '☆'}</button>
                `).join('')}
            </div>
            <p class="tvst-nota-hint">Tu nota · toca para cambiar</p>
        </div>
    ` : `
        <p class="tvst-info-overview">Añádela a tu lista para puntuarla.</p>
    `;

    container.innerHTML = `
        <div class="tvst-info-section">
            <h3>Nota</h3>
            ${ratingControl}
            <p class="tvst-info-overview tvst-nota-tmdb">TMDB: ${voteAverage}/10</p>
        </div>
        <div class="tvst-info-section">
            <h3>Descripción</h3>
            <p class="tvst-info-overview">${overview}</p>
            ${item?.generos?.length ? `<p class="tvst-info-overview" style="margin-top:0.5rem">${item.generos.slice(0, 4).join(' · ')}</p>` : ''}
        </div>
        ${providers.length ? `
            <div class="tvst-info-section">
                <h3>Dónde ver</h3>
                <div class="flex flex-wrap gap-2">
                    ${providers.map(provider => `
                        <span class="inline-flex items-center gap-2 rounded-full bg-zinc-900 px-3 py-1.5 text-sm">
                            ${provider.logo_path ? `<img src="${window.getImageUrl(provider.logo_path, 'w92')}" alt="" class="h-5 w-5 rounded-full object-cover">` : ''}
                            ${provider.provider_name}
                        </span>
                    `).join('')}
                </div>
            </div>
        ` : ''}
        <div class="tvst-info-section">
            <h3>Reparto</h3>
            <div class="tvst-cast-rail">
                ${cast.length ? cast.map(person => `
                    <article class="tvst-cast-card">
                        ${person.profile_path
                            ? `<img src="${person.profile_path}" alt="${person.name}" onerror="this.onerror=null;this.outerHTML='<div class=\\'tvst-cast-fallback\\'>🎭</div>'">`
                            : '<div class="tvst-cast-fallback">🎭</div>'}
                        <div class="min-w-0">
                            <p class="text-sm font-semibold truncate">${person.name}</p>
                            <p class="text-xs text-gray-500 truncate">${person.character || 'Actor'}</p>
                        </div>
                    </article>
                `).join('') : '<p class="text-sm text-gray-500">No hay reparto disponible.</p>'}
            </div>
        </div>
        <div class="tvst-info-section">
            <div class="flex items-center justify-between gap-3 mb-2">
                <h3 class="mb-0">También te gustará</h3>
                ${recommendations.length ? `
                    <button type="button" class="tvst-show-more-btn" onclick="toggleDetailRecsExpanded()">
                        ${AppState.detailRecsExpanded ? 'Mostrar menos' : 'Mostrar más'}
                    </button>
                ` : ''}
            </div>
            <div class="tvst-rec-rail${AppState.detailRecsExpanded ? ' is-expanded' : ''}">
                ${recommendations.length ? recommendations.map(rec => `
                    <article class="tvst-rec-card" onclick="openDetail('${rec.tipo}', ${rec.id_tmdb})">
                        ${rec.portada
                            ? `<img src="${rec.portada}" alt="${rec.titulo}">`
                            : '<div class="w-full aspect-[2/3] bg-zinc-900 flex items-center justify-center rounded">🎬</div>'}
                        <button type="button" onclick="event.stopPropagation(); addItem('${rec.tipo}', ${rec.id_tmdb});" class="tvst-add-btn">+</button>
                        <p class="text-xs mt-1 truncate">${rec.titulo}</p>
                    </article>
                `).join('') : '<p class="text-sm text-gray-500">No hay recomendaciones disponibles.</p>'}
            </div>
        </div>
    `;
}

function toggleDetailRecsExpanded() {
    AppState.detailRecsExpanded = !AppState.detailRecsExpanded;
    renderDetailInfo(AppState.selectedItem);
}

function setPersonalRating(rating) {
    const item = AppState.selectedItem;
    if (!item) return;
    if (!isItemAlreadyAdded(item.tipo, item.id_tmdb)) {
        showToast('Añádela a tu lista para puntuar', 'info');
        return;
    }

    const value = Math.max(0, Math.min(10, Number(rating) || 0));
    updateRating(item.tipo, item.id_tmdb, value);
    AppState.selectedItem = { ...item, puntuacion: value };
    const scoreEl = document.getElementById('detail-personal-score');
    if (scoreEl) scoreEl.textContent = value > 0 ? value.toFixed(1) : '—';
    document.querySelectorAll('.tvst-nota-star').forEach((btn, idx) => {
        const n = idx + 1;
        const on = n <= Math.round(value);
        btn.classList.toggle('is-on', on);
        btn.textContent = on ? '★' : '☆';
    });
    const hidden = document.getElementById('modal-rating-input');
    if (hidden) hidden.value = value;
}

function switchDetailTab(tab) {
    const infoTab = document.getElementById('detail-info-tab');
    const episodesTab = document.getElementById('detail-episodes-tab');
    const infoPanel = document.getElementById('detail-info-panel');
    const episodesPanel = document.getElementById('modal-episodes');

    if (!infoTab || !episodesTab || !infoPanel || !episodesPanel) return;

    if (tab === 'episodes') {
        infoTab.classList.remove('is-active');
        episodesTab.classList.add('is-active');
        infoPanel.classList.add('hidden');
        episodesPanel.classList.remove('hidden');
    } else {
        infoTab.classList.add('is-active');
        episodesTab.classList.remove('is-active');
        infoPanel.classList.remove('hidden');
        episodesPanel.classList.add('hidden');
    }
}

function renderSettings() {
    if (typeof window.isAuthenticated === 'function') {
        updateDriveStatus(window.isAuthenticated());
    }
}

function renderExplore() {
    const list = document.getElementById('search-results');
    const input = document.getElementById('search-input');
    if (!list) return;
    const query = (input?.value || '').trim();
    if (query.length < 2) {
        list.innerHTML = emptyState(
            'search',
            'Explora títulos',
            { subtitle: 'Escribe al menos 2 caracteres para buscar series o películas.' },
        );
    }
}

function isItemAlreadyAdded(type, id_tmdb) {
    if (type === 'movie') {
        return AppState.movies.some(movie => movie.id_tmdb === id_tmdb);
    }

    return AppState.shows.some(show => show.id_tmdb === id_tmdb);
}

function normalizeStatus(status) {
    const normalized = (status || 'pending').toLowerCase();
    if (normalized === 'siguiendo') return 'watching';
    if (normalized === 'terminada') return 'completed';
    if (normalized === 'pendiente') return 'pending';
    if (normalized === 'abandonado') return 'dropped';
    if (normalized === 'completado') return 'completed';
    if (normalized === 'vista') return 'completed';
    if (normalized === 'standby' || normalized === 'ver en otro momento') return 'standby';
    return normalized;
}

function getSeasonLabel(season) {
    if (season?.especial || season?.numero === 0) {
        return 'Especiales';
    }
    return season?.nombre || `Temporada ${season?.numero || 1}`;
}

function formatEpisodeLabel(seasonNumber, episodeNumber) {
    return `T${String(seasonNumber || 0).padStart(2, '0')} | E${String(episodeNumber || 0).padStart(2, '0')}`;
}

function isEpisodeAired(episode) {
    if (!episode?.air_date) {
        return true;
    }

    const releaseDate = new Date(`${episode.air_date}T00:00:00`);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return releaseDate <= today;
}

async function getOrderedEpisodes(show, options = {}) {
    const includeSpecials = options.includeSpecials !== false;
    const seasons = (show.temporadas || []).filter(season => includeSpecials || !season.especial);

    try {
        const seasonDetailsList = await Promise.all(seasons.map(async season => {
            const details = await getSeasonDetails(show.id_tmdb, season.numero);
            return (details?.episodes || []).map(episode => ({
                id: `S${String(season.numero).padStart(2, '0')}E${String(episode.episode_number).padStart(2, '0')}`,
                name: episode.name,
                overview: episode.overview,
                air_date: episode.air_date,
                seasonNumber: season.numero,
                episodeNumber: episode.episode_number,
                still_path: episode.still_path,
                especial: Boolean(season.especial || season.numero === 0),
            }));
        }));

        const allEpisodes = seasonDetailsList.flat();
        allEpisodes.sort((a, b) => {
            if (a.seasonNumber === b.seasonNumber) {
                return a.episodeNumber - b.episodeNumber;
            }
            return a.seasonNumber - b.seasonNumber;
        });

        return allEpisodes;
    } catch (error) {
        console.error('[App] Error obteniendo episodios:', error);
        return [];
    }
}

async function refreshShowStatus(show) {
    if (!show) return show;

    const previousState = normalizeStatus(show.estado);

    if (show.tipo !== 'tv') {
        show.estado = previousState;
        return show;
    }

    const needsFreshMeta = !show.status || show.status === 'Unknown' || show.status === 'unknown'
        || !show.temporadas?.length;

    if (needsFreshMeta) {
        try {
            const freshDetails = await getTVDetails(show.id_tmdb);
            if (freshDetails?.status) {
                show.status = freshDetails.status;
            }
            if (freshDetails?.temporadas?.length) {
                show.temporadas = freshDetails.temporadas;
            }
        } catch (error) {
            console.warn('[App] No se pudo refrescar el estado TMDB de la serie:', error);
        }
    }

    const regularSeasons = (show.temporadas || []).filter(season => !season.especial && season.numero !== 0);
    if (regularSeasons.length === 0) {
        show.estado = previousState;
        return show;
    }

    const episodes = await getOrderedEpisodes(show, { includeSpecials: false });
    const airedEpisodes = episodes.filter(isEpisodeAired);
    const watchedEpisodes = airedEpisodes.filter(ep => show.capitulos_vistos?.includes(ep.id));

    show.episodios_emitidos = airedEpisodes.length;
    show.episodios_vistos_count = watchedEpisodes.length;

    // dropped: permanece hasta marcar un episodio (vuelve a watching) o eliminar
    if (previousState === 'dropped') {
        show.estado = 'dropped';
        return show;
    }

    // Completado solo si hay emitidos y todos están vistos
    if (airedEpisodes.length > 0 && watchedEpisodes.length === airedEpisodes.length) {
        show.estado = 'completed';
        return show;
    }

    // standby: solo sale por menú → ver episodios (en toggle) o eliminar
    if (previousState === 'standby') {
        show.estado = 'standby';
        return show;
    }

    // pending / watching / completed (si no todos vistos)
    if (watchedEpisodes.length > 0) {
        show.estado = 'watching';
    } else {
        show.estado = 'pending';
    }

    return show;
}

/**
 * Renderiza los resultados de búsqueda
 * @param {Array} results - Resultados de búsqueda
 */
function formatPopularityLabel(count, tipo) {
    const n = Number(count) || 0;
    const noun = tipo === 'movie' ? 'película' : 'serie';
    let formatted;
    if (n >= 1000) {
        const mil = n / 1000;
        formatted = mil >= 100
            ? `${Math.round(mil)} mil`
            : `${mil.toLocaleString('es-ES', { maximumFractionDigits: 1 })} mil`;
    } else if (n > 0) {
        formatted = String(Math.round(n));
    } else {
        formatted = 'Pocos';
    }
    const verb = n === 1 ? 'ha añadido' : 'han añadido';
    return `${formatted} ${verb} esta ${noun}`;
}

function renderSearchResults(results) {
    AppState.lastSearchResults = results || [];
    const list = document.getElementById('search-results');

    if (!AppState.lastSearchResults.length) {
        list.className = 'tvst-search-list';
        list.innerHTML = emptyState('search', 'No se encontraron resultados');
        return;
    }

    const typeIcon = (tipo) => tipo === 'movie'
        ? '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M7 5l2-2h6l2 2"/></svg>'
        : '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="13" rx="1.5"/><path d="M8 3l4 3 4-3"/></svg>';

    list.className = 'tvst-search-list';
    list.innerHTML = AppState.lastSearchResults.map(item => {
        const added = isItemAlreadyAdded(item.tipo, item.id_tmdb);
        const popularitySource = item.vote_count || item.popularity || 0;
        return `
        <article class="tvst-search-row" onclick="openDetail('${item.tipo}', ${item.id_tmdb})">
            <div class="tvst-search-poster">
                ${item.portada
                    ? `<img src="${item.portada}" alt="">`
                    : `<div class="w-full h-full flex items-center justify-center text-lg">🎬</div>`}
            </div>
            <div class="tvst-search-body">
                <h3 class="tvst-search-title">${item.titulo || 'Sin título'}</h3>
                <div class="tvst-search-sub">
                    ${typeIcon(item.tipo)}
                    <span>${formatPopularityLabel(popularitySource, item.tipo)}</span>
                </div>
            </div>
            <button type="button"
                class="tvst-add-btn${added ? ' is-added' : ''}"
                ${added ? 'disabled' : ''}
                onclick="event.stopPropagation();${added ? '' : `addItem('${item.tipo}', ${item.id_tmdb})`}"
                aria-label="${added ? 'Ya añadido' : 'Añadir'}">${added ? '✓' : '+'}</button>
        </article>`;
    }).join('');
}

/**
 * Renderiza los episodios de una serie
 * @param {Object} show - Datos de la serie
 */
/**
 * Renderiza los episodios de una serie
 * @param {Object} show - Datos de la serie
 */
async function renderEpisodes(show) {
    const container = document.getElementById('episodes-list');
    const episodesSection = document.getElementById('modal-episodes');

    if (show.tipo !== 'tv') {
        episodesSection?.classList.add('hidden');
        return;
    }

    episodesSection?.classList.remove('hidden');
    container.innerHTML = emptyState('episodes', 'Cargando episodios...', { loading: true });

    try {
        const ordered = await getOrderedEpisodes(show, { includeSpecials: false });
        const airedOrdered = ordered.filter(isEpisodeAired);
        const nextUnwatched = airedOrdered.filter(ep => !show.capitulos_vistos?.includes(ep.id)).slice(0, 2);

        let continueHTML = '';
        if (nextUnwatched.length) {
            continueHTML = `
                <div class="tvst-ep-section-title">Continuar el seguimiento</div>
                <div class="tvst-continue-cards">
                    ${nextUnwatched.map(ep => {
                        const still = ep.still_path ? getImageUrl(ep.still_path, 'w185') : null;
                        const watched = show.capitulos_vistos?.includes(ep.id);
                        return `
                        <div class="tvst-continue-card" onclick="openEpisodeDetail(${show.id_tmdb}, '${ep.id}')" role="button" tabindex="0">
                            ${still
                                ? `<img class="tvst-continue-still" src="${still}" alt="">`
                                : '<div class="tvst-continue-still"></div>'}
                            <div class="tvst-continue-text">
                                <div class="tvst-continue-code">${formatEpisodeLabel(ep.seasonNumber, ep.episodeNumber)}</div>
                                <div class="tvst-continue-name">${ep.name || 'Episodio'}</div>
                            </div>
                            <button type="button"
                                class="tvst-circle-check${watched ? ' is-watched' : ''}"
                                onclick="event.stopPropagation(); toggleEpisodeAndUpdateSeason(${show.id_tmdb}, '${ep.id}', ${ep.seasonNumber}, 'season-${ep.seasonNumber}')">✓</button>
                        </div>`;
                    }).join('')}
                </div>`;
        }

        const sortedSeasons = [...(show.temporadas || [])]
            .filter(s => !s.especial && s.numero !== 0)
            .sort((a, b) => a.numero - b.numero);

        let seasonsHTML = '<div class="tvst-ep-section-title">Todos los episodios</div>';

        for (const season of sortedSeasons) {
            const seasonDetails = await getSeasonDetails(show.id_tmdb, season.numero);
            const seasonId = `season-${season.numero}`;
            const seasonKey = `${show.id_tmdb}-season-${season.numero}`;
            const seasonLabel = getSeasonLabel(season);

            const seasonEpisodeIds = (seasonDetails.episodes || [])
                .filter(isEpisodeAired)
                .map(ep => `S${String(season.numero).padStart(2, '0')}E${String(ep.episode_number).padStart(2, '0')}`);
            const watchedInSeason = seasonEpisodeIds.filter(id => show.capitulos_vistos?.includes(id)).length;
            const totalInSeason = seasonEpisodeIds.length;
            const allWatchedInSeason = watchedInSeason === totalInSeason && totalInSeason > 0;
            const pct = totalInSeason > 0 ? Math.round((watchedInSeason / totalInSeason) * 100) : 0;
            const isExpanded = AppState.expandedSeasons[seasonKey];

            seasonsHTML += `
                <div class="tvst-season-block">
                    <div class="tvst-season-header" role="button" tabindex="0" onclick="toggleSeasonAccordion('${seasonId}', '${seasonKey}')">
                        <div class="tvst-season-header-main">
                            <p class="tvst-season-name">${seasonLabel}</p>
                            <span class="tvst-season-chevron" id="chevron-${seasonId}">${isExpanded ? '▲' : '▼'}</span>
                        </div>
                        <span class="tvst-season-count">${watchedInSeason}/${totalInSeason}</span>
                        <button type="button"
                            class="tvst-circle-check${allWatchedInSeason ? ' is-watched' : ''}"
                            onclick="event.stopPropagation(); toggleSeasonWatched(${show.id_tmdb}, ${season.numero})"
                            aria-label="Marcar temporada">✓</button>
                        <div class="tvst-season-bar-track">
                            <div class="tvst-season-bar-fill${allWatchedInSeason ? ' is-complete' : ''}" style="width:${Math.max(0, Math.min(100, pct))}%"></div>
                        </div>
                    </div>
                    <div id="${seasonId}" class="${isExpanded ? '' : 'hidden'}">
                        ${(seasonDetails.episodes || []).map(episode => {
                            const episodeId = `S${String(season.numero).padStart(2, '0')}E${String(episode.episode_number).padStart(2, '0')}`;
                            const isWatched = show.capitulos_vistos?.includes(episodeId);
                            const episodeImage = episode.still_path ? getImageUrl(episode.still_path, 'w185') : null;
                            const aired = isEpisodeAired(episode);
                            return `
                            <div class="tvst-ep-row" onclick="openEpisodeDetail(${show.id_tmdb}, '${episodeId}')" role="button" tabindex="0">
                                ${episodeImage
                                    ? `<img class="tvst-ep-still" src="${episodeImage}" alt="" onerror="this.style.visibility='hidden'">`
                                    : '<div class="tvst-ep-still"></div>'}
                                <div class="tvst-ep-text">
                                    <div class="tvst-ep-code">${formatEpisodeLabel(season.numero, episode.episode_number)}</div>
                                    <div class="tvst-ep-name">${episode.name || 'Episodio'}</div>
                                </div>
                                <button type="button"
                                    class="tvst-circle-check${isWatched ? ' is-watched' : ''}"
                                    ${aired ? '' : 'disabled'}
                                    onclick="event.stopPropagation(); toggleEpisodeAndUpdateSeason(${show.id_tmdb}, '${episodeId}', ${season.numero}, '${seasonId}')">✓</button>
                            </div>`;
                        }).join('')}
                    </div>
                </div>`;
        }

        container.innerHTML = continueHTML + seasonsHTML;
    } catch (error) {
        console.error('[App] Error cargando episodios:', error);
        container.innerHTML = '<div class="text-center py-4 text-red-500">Error al cargar episodios</div>';
    }
}

/**
 * Alterna la visibilidad del acordeón de temporada y guarda el estado
 * @param {string} seasonId - ID de la temporada
 * @param {string} seasonKey - Clave para guardar el estado
 */
function toggleSeasonAccordion(seasonId, seasonKey) {
    const seasonElement = document.getElementById(seasonId);
    const chevron = document.getElementById(`chevron-${seasonId}`);
    if (!seasonElement) return;

    if (seasonElement.classList.contains('hidden')) {
        seasonElement.classList.remove('hidden');
        if (chevron) chevron.textContent = '▲';
        AppState.expandedSeasons[seasonKey] = true;
    } else {
        seasonElement.classList.add('hidden');
        if (chevron) chevron.textContent = '▼';
        AppState.expandedSeasons[seasonKey] = false;
    }
}

/**
 * Alterna episodio y actualiza checkbox de temporada sin colapsar
 * @param {number} id_tmdb - ID de TMDB de la serie
 * @param {string} episode - Formato "S01E01"
 * @param {number} seasonNumber - Número de temporada
 * @param {Array} seasonEpisodeIds - IDs de episodios de la temporada
 * @param {string} seasonId - ID del elemento de temporada
 */
async function toggleEpisodeAndUpdateSeason(id_tmdb, episode, seasonNumber, seasonId) {
    const show = AppState.shows.find(s => s.id_tmdb === id_tmdb);
    if (!show) return;

    const episodes = await getOrderedEpisodes(show, { includeSpecials: false });
    const targetEpisode = episodes.find(ep => ep.id === episode);

    if (targetEpisode && !isEpisodeAired(targetEpisode)) {
        showToast('No puedes marcar episodios con fecha posterior a la actual', 'info');
        return;
    }

    if (!show.capitulos_vistos) {
        show.capitulos_vistos = [];
    }

    const wasStandby = normalizeStatus(show.estado) === 'standby';
    const wasDropped = normalizeStatus(show.estado) === 'dropped';
    const index = show.capitulos_vistos.indexOf(episode);
    let markedWatched = false;
    const newlyWatchedIds = [];
    if (index > -1) {
        show.capitulos_vistos.splice(index, 1);
        clearEpisodeWatchedRecord(show, episode);
    } else {
        const previousEpisodes = episodes.filter(isEpisodeAired).filter(ep => compareEpisodeOrder(ep, targetEpisode) < 0 && !show.capitulos_vistos?.includes(ep.id));
        if (shouldAskToMarkPreviousEpisodes(show, episodes, episode) && confirm('¿Quieres marcar también los episodios anteriores como vistos?')) {
            previousEpisodes.forEach(ep => {
                if (!show.capitulos_vistos.includes(ep.id)) {
                    show.capitulos_vistos.push(ep.id);
                    newlyWatchedIds.push(ep.id);
                }
            });
        }
        show.capitulos_vistos.push(episode);
        newlyWatchedIds.push(episode);
        markedWatched = true;
        recordEpisodesWatched(show, newlyWatchedIds);
        bumpPendingHistoryAfterWatch();
    }

    if (wasStandby && markedWatched) {
        show.estado = 'watching';
    }
    if (wasDropped && markedWatched) {
        show.estado = 'watching';
    }

    await refreshShowStatus(show);
    saveLocalData();
    syncToDrive();

    if (AppState.selectedItem?.tipo === 'tv' && AppState.selectedItem.id_tmdb === id_tmdb) {
        AppState.selectedItem = { ...show, tipo: 'tv' };
        await renderEpisodes(AppState.selectedItem);
        updateDetailHero(AppState.selectedItem);
    }
    await renderCurrentView();
}

/**
 * Actualiza la UI de una temporada sin colapsarla
 * @param {number} id_tmdb - ID de TMDB de la serie
 * @param {number} seasonNumber - Número de temporada
 * @param {Array} seasonEpisodeIds - IDs de episodios de la temporada
 * @param {string} seasonId - ID del elemento de temporada
 */
function updateSeasonUI(id_tmdb, seasonNumber, seasonEpisodeIds, seasonId) {
    const show = AppState.shows.find(s => s.id_tmdb === id_tmdb);
    if (!show) return;
    
    const watchedInSeason = seasonEpisodeIds.filter(id => show.capitulos_vistos?.includes(id)).length;
    const totalInSeason = seasonEpisodeIds.length;
    const allWatchedInSeason = watchedInSeason === totalInSeason && totalInSeason > 0;
    
    // Encontrar el contenedor de la temporada
    const seasonContentDiv = document.getElementById(seasonId);
    if (!seasonContentDiv) {
        console.log('[App] No encontrado seasonContentDiv con id:', seasonId);
        return;
    }
    
    // El header es el elemento anterior (hermano previo)
    const seasonHeaderDiv = seasonContentDiv.previousElementSibling;
    if (!seasonHeaderDiv) {
        console.log('[App] No encontrado seasonHeaderDiv');
        return;
    }
    
    // Actualizar contador "X/Y" 
    // Buscar el párrafo que contiene el contador
    const counterParagraphs = seasonHeaderDiv.querySelectorAll('p');
    if (counterParagraphs.length > 0) {
        counterParagraphs[0].textContent = `${watchedInSeason}/${totalInSeason}`;
    }
    
    // Actualizar checkbox de temporada por su ID específico
    const seasonCheckbox = seasonHeaderDiv.querySelector(`input[id="season-check-${seasonId}"]`);
    if (seasonCheckbox) {
        seasonCheckbox.checked = allWatchedInSeason;
    }
    
    // Actualizar badge de progreso (es un span con rounded-full)
    const badges = seasonHeaderDiv.querySelectorAll('span.rounded-full');
    if (badges.length > 0) {
        const badge = badges[0];
        if (allWatchedInSeason) {
            badge.className = 'text-xs font-medium px-2 py-1 rounded-full bg-green-200 dark:bg-green-900 text-green-800 dark:text-green-200';
            badge.textContent = '✓';
        } else {
            badge.className = 'text-xs font-medium px-2 py-1 rounded-full bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300';
            badge.textContent = Math.round((watchedInSeason / totalInSeason) * 100) + '%';
        }
    }
}

// Handler externo para cambios en checkboxes de episodio
function episodeCheckboxHandler(e) {
    const cb = e.currentTarget;
    const showId = parseInt(cb.getAttribute('data-show'), 10);
    const episodeId = cb.getAttribute('data-episode');
    const seasonNumber = parseInt(cb.getAttribute('data-season'), 10);
    const seasonId = `season-${seasonNumber}`;
    // Llamar a la función que actualiza el estado y UI
    toggleEpisodeAndUpdateSeason(showId, episodeId, seasonNumber, seasonId);
}

// Handler externo para cambios en checkbox de temporada
function seasonCheckboxHandler(e) {
    const cb = e.currentTarget;
    // season-check-season-X -> extract seasonId
    const fullId = cb.id; // e.g. season-check-season-1
    const seasonId = fullId.replace(/^season-check-/, '');
    // seasonId is like season-1, extract season number
    const match = seasonId.match(/season-(\d+)/);
    const seasonNumber = match ? parseInt(match[1], 10) : null;
    // Find show id by walking DOM to header's sibling container
    const header = cb.closest('div');
    let showId = null;
    // showId is stored on episode inputs; find one nearby
    const seasonContent = document.getElementById(seasonId);
    if (seasonContent) {
        const anyEp = seasonContent.querySelector('input[id^="ep-"]');
        if (anyEp) showId = parseInt(anyEp.getAttribute('data-show'), 10);
    }
    if (!showId || seasonNumber === null) return;
    toggleSeasonWatched(showId, seasonNumber, seasonId, e);
}

/**
 * Marca todos los episodios de una temporada como visto o no visto
 * @param {number} id_tmdb - ID de TMDB de la serie
 * @param {number} seasonNumber - Número de temporada
 * @param {Array} episodeIds - IDs de los episodios en formato "S01E01"
 * @param {Event} event - Evento del checkbox
 */
async function toggleSeasonWatched(id_tmdb, seasonNumber) {
    const show = AppState.shows.find(s => s.id_tmdb === id_tmdb);
    if (!show) return;

    if (!show.capitulos_vistos) {
        show.capitulos_vistos = [];
    }

    const seasonDetails = await getSeasonDetails(id_tmdb, seasonNumber);
    const episodeIds = (seasonDetails.episodes || [])
        .filter(isEpisodeAired)
        .map(ep => `S${String(seasonNumber).padStart(2, '0')}E${String(ep.episode_number).padStart(2, '0')}`);

    if (episodeIds.length === 0) {
        showToast('No hay episodios disponibles para marcar en esta temporada', 'info');
        return;
    }

    const allWatched = episodeIds.every(id => show.capitulos_vistos.includes(id));
    const watched = !allWatched;
    const wasStandby = normalizeStatus(show.estado) === 'standby';
    const touchedIds = [];

    episodeIds.forEach(episodeId => {
        const index = show.capitulos_vistos.indexOf(episodeId);
        if (watched) {
            if (index === -1) {
                show.capitulos_vistos.push(episodeId);
                touchedIds.push(episodeId);
            }
        } else if (index > -1) {
            show.capitulos_vistos.splice(index, 1);
            clearEpisodeWatchedRecord(show, episodeId);
        }
    });

    if (watched && touchedIds.length) {
        recordEpisodesWatched(show, touchedIds);
        bumpPendingHistoryAfterWatch();
    }

    if (wasStandby && watched && touchedIds.length) {
        show.estado = 'watching';
    }

    await refreshShowStatus(show);
    saveLocalData();
    syncToDrive();

    if (AppState.selectedItem?.tipo === 'tv' && AppState.selectedItem.id_tmdb === id_tmdb) {
        AppState.selectedItem = { ...show, tipo: 'tv' };
        await renderEpisodes(AppState.selectedItem);
        updateDetailHero(AppState.selectedItem);
    }
    await renderCurrentView();
}

/**
 * Renderiza las estrellas de puntuación
 * @param {number} rating - Puntuación actual
 */
function renderStars(rating) {
    const container = document.getElementById('modal-rating');
    container.innerHTML = '';
    
    for (let i = 1; i <= 10; i++) {
        const star = document.createElement('span');
        star.className = `star text-2xl ${i <= rating ? 'text-yellow-400' : 'text-gray-400'}`;
        star.textContent = '★';
        star.onclick = () => setRating(i);
        container.appendChild(star);
    }
}

// ============================================
// MODAL
// ============================================

/**
 * Abre el modal de detalle
 * @param {string} type - 'movie' o 'tv'
 * @param {number} id_tmdb - ID de TMDB
 */
function mergeDetailItem(existingItem, freshDetails) {
    if (!existingItem) return freshDetails;
    return {
        ...existingItem,
        ...freshDetails,
        tipo: existingItem.tipo || freshDetails.tipo || 'tv',
        estado: existingItem.estado || freshDetails.estado || 'pending',
        puntuacion: existingItem.puntuacion ?? freshDetails.puntuacion ?? 0,
        capitulos_vistos: existingItem.capitulos_vistos || freshDetails.capitulos_vistos || [],
        capitulos_vistos_fecha: existingItem.capitulos_vistos_fecha || freshDetails.capitulos_vistos_fecha || {},
        credits: {
            ...(existingItem.credits || {}),
            ...(freshDetails.credits || {}),
        },
        recommendations: freshDetails.recommendations || existingItem.recommendations || [],
    };
}

function translateOfficialStatus(status) {
    const key = String(status || '').trim().toLowerCase();
    const map = {
        'returning series': 'En emisión',
        'ended': 'Finalizado',
        'canceled': 'Cancelada',
        'cancelled': 'Cancelada',
        'in production': 'En producción',
        'planned': 'Planificada',
        'pilot': 'Piloto',
    };
    return map[key] || (status && status !== 'Unknown' ? status : null);
}

function closeDetailMenu() {
    document.getElementById('detail-overflow-menu')?.classList.add('hidden');
}

function toggleDetailMenu(event) {
    event?.stopPropagation?.();
    const item = AppState.selectedItem;
    const menu = document.getElementById('detail-overflow-menu');
    if (!menu || !item) return;

    if (!isItemAlreadyAdded(item.tipo, item.id_tmdb)) {
        closeDetailMenu();
        showToast('Añade el título primero', 'info');
        return;
    }

    if (!menu.classList.contains('hidden')) {
        closeDetailMenu();
        return;
    }

    const watchedCount = item.tipo === 'tv'
        ? (item.capitulos_vistos?.length || item.episodios_vistos_count || 0)
        : 0;

    const libraryItem = getLibraryItem(item.tipo, item.id_tmdb);
    const isFavorite = Boolean(libraryItem?.favorito || item.favorito);

    const actions = [
        { id: 'toggle-favorite', label: isFavorite ? 'Quitar de favoritos' : 'Añadir a favoritos' },
        { id: 'add-to-list', label: 'Añadir a lista' },
        { id: 'standby', label: 'Ver en otro momento' },
        { id: 'remove', label: 'Eliminar', danger: true },
    ];

    if (item.tipo === 'movie') {
        const st = normalizeStatus(item.estado);
        actions.splice(3, 0, st === 'completed'
            ? { id: 'movie-unwatch', label: 'Marcar como no vista' }
            : { id: 'movie-watch', label: 'Marcar como vista' });
    }

    if (item.tipo === 'tv' && watchedCount > 0) {
        const st = normalizeStatus(item.estado);
        if (st === 'dropped') {
            actions.splice(3, 0, { id: 'resume', label: 'Seguir viendo' });
        } else {
            actions.splice(3, 0, { id: 'dropped', label: 'Dejar de ver' });
        }
    }

    menu.innerHTML = actions.map(a => `
        <button type="button" class="tvst-overflow-item${a.danger ? ' is-danger' : ''}" onclick="runDetailMenuAction('${a.id}')">${a.label}</button>
    `).join('');
    menu.classList.remove('hidden');
}

async function runDetailMenuAction(action) {
    const item = AppState.selectedItem;
    closeDetailMenu();
    if (!item) return;

    if (action === 'toggle-favorite') {
        toggleFavorite(item.tipo, item.id_tmdb);
        return;
    }

    if (action === 'add-to-list') {
        openListPicker();
        return;
    }

    if (action === 'remove') {
        removeContent();
        return;
    }

    if (action === 'standby') {
        await updateStatus(item.tipo, item.id_tmdb, 'standby');
        const updated = item.tipo === 'tv'
            ? AppState.shows.find(s => s.id_tmdb === item.id_tmdb)
            : AppState.movies.find(m => m.id_tmdb === item.id_tmdb);
        AppState.selectedItem = { ...(updated || item), tipo: item.tipo };
        showToast('Marcada como ver en otro momento', 'success');
        renderCurrentView();
        updateDetailHero(AppState.selectedItem);
        return;
    }

    if (action === 'dropped' && item.tipo === 'tv') {
        await updateStatus('tv', item.id_tmdb, 'dropped');
        const updated = AppState.shows.find(s => s.id_tmdb === item.id_tmdb);
        AppState.selectedItem = { ...(updated || item), tipo: 'tv', estado: 'dropped' };
        showToast('Marcada como abandonada', 'info');
        renderCurrentView();
        updateDetailHero(AppState.selectedItem);
        return;
    }

    if (action === 'resume' && item.tipo === 'tv') {
        await updateStatus('tv', item.id_tmdb, 'watching');
        const updated = AppState.shows.find(s => s.id_tmdb === item.id_tmdb);
        AppState.selectedItem = { ...(updated || item), tipo: 'tv', estado: 'watching' };
        showToast('De vuelta en viendo', 'success');
        renderCurrentView();
        updateDetailHero(AppState.selectedItem);
        return;
    }

    if ((action === 'movie-watch' || action === 'movie-unwatch') && item.tipo === 'movie') {
        await toggleMovieWatched(item.id_tmdb);
    }
}

function updateDetailAddBar(item) {
    const bar = document.getElementById('modal-add-bar');
    const btn = document.getElementById('modal-add-btn');
    const scroll = document.querySelector('.tvst-modal-scroll');
    if (!bar || !btn || !item) return;

    const added = isItemAlreadyAdded(item.tipo, item.id_tmdb);
    bar.classList.toggle('hidden', added);
    scroll?.classList.toggle('has-add-bar', !added);
    btn.textContent = item.tipo === 'movie' ? '+ Añadir película' : '+ Añadir serie';
}

function getHeroProgressStyle(item) {
    if (item.tipo === 'movie') {
        const st = normalizeStatus(item.estado);
        if (st === 'dropped') return { progress: 0, heroClass: 'is-red' };
        if (st === 'completed') return { progress: 100, heroClass: 'is-green' };
        return { progress: 0, heroClass: 'is-yellow' };
    }

    const st = normalizeStatus(item.estado);
    const prog = getShowProgressInfo(item);
    const official = getOfficialStatus(item);
    const isOfficialEnded = official === 'ended' || official === 'canceled' || official === 'cancelled';

    if (st === 'dropped') {
        return { progress: prog.progress, heroClass: 'is-red' };
    }
    if (st === 'completed' && isOfficialEnded) {
        return { progress: 100, heroClass: 'is-purple' };
    }
    if (st === 'completed') {
        return { progress: 100, heroClass: 'is-green' };
    }
    return { progress: prog.progress, heroClass: 'is-yellow' };
}

function updateDetailHero(item) {
    const hero = document.getElementById('modal-hero');
    const titleEl = document.getElementById('modal-title');
    const metaEl = document.getElementById('modal-hero-meta');
    const pctEl = document.getElementById('modal-hero-progress-label');
    const fillEl = document.getElementById('modal-hero-progress');
    const trackEl = document.querySelector('.tvst-hero-progress-track');

    if (titleEl) titleEl.textContent = item.titulo || 'Sin título';

    if (hero) {
        const bg = item.backdrop || item.portada || '';
        hero.style.backgroundImage = bg ? `url('${bg}')` : 'none';
    }

    const heroStyle = getHeroProgressStyle(item);

    if (item.tipo === 'tv') {
        const seasons = item.numero_temporadas || item.temporadas?.filter(s => !s.especial)?.length || 0;
        const official = translateOfficialStatus(item.status || item.tmdb_status);
        const provider = item.watch_providers?.[0]?.provider_name;
        const parts = [];
        if (seasons) parts.push(`${seasons} temporada${seasons === 1 ? '' : 's'}`);
        if (official) parts.push(official);
        if (provider) parts.push(provider);
        if (metaEl) metaEl.textContent = parts.join(' • ');
    } else {
        const year = item.fecha_estreno ? new Date(item.fecha_estreno).getFullYear() : null;
        const parts = ['Película'];
        if (year) parts.push(String(year));
        if (metaEl) metaEl.textContent = parts.join(' • ');
    }

    if (pctEl) {
        pctEl.textContent = `${heroStyle.progress}%`;
        pctEl.className = `tvst-hero-pct ${heroStyle.heroClass}`;
    }
    if (fillEl) {
        fillEl.style.width = `${heroStyle.progress}%`;
        fillEl.className = `tvst-hero-progress-fill ${heroStyle.heroClass}`;
    }
    if (trackEl) {
        trackEl.className = `tvst-hero-progress-track ${heroStyle.heroClass}`;
    }

    updateDetailAddBar(item);
}

async function openEpisodeDetail(id_tmdb, episodeId) {
    const show = AppState.shows.find(s => s.id_tmdb === id_tmdb);
    if (!show) {
        showToast('Serie no encontrada', 'error');
        return;
    }

    showLoading(true);
    try {
        const episodes = await getOrderedEpisodes(show, { includeSpecials: true });
        const episode = episodes.find(ep => ep.id === episodeId);
        if (!episode) {
            showToast('Episodio no encontrado', 'error');
            return;
        }

        AppState.selectedEpisode = { showId: id_tmdb, episodeId, episode, show };

        const modal = document.getElementById('episode-modal');
        const stillEl = document.getElementById('episode-still');
        const pill = document.getElementById('episode-show-pill');
        const codeEl = document.getElementById('episode-code');
        const titleEl = document.getElementById('episode-title');
        const airEl = document.getElementById('episode-air-date');
        const overviewEl = document.getElementById('episode-overview');
        const watchBtn = document.getElementById('episode-watch-btn');

        const stillUrl = episode.still_path
            ? (String(episode.still_path).startsWith('http') ? episode.still_path : getImageUrl(episode.still_path, 'w780'))
            : (show.backdrop || show.portada);

        if (stillEl) {
            stillEl.innerHTML = stillUrl
                ? `<img src="${stillUrl}" alt="">`
                : '<div class="tvst-episode-still-fallback">📺</div>';
        }

        if (pill) {
            pill.textContent = `${show.titulo} ›`;
            pill.onclick = (e) => {
                e.preventDefault();
                closeEpisodeModal();
                openDetail('tv', id_tmdb);
            };
        }

        if (codeEl) codeEl.textContent = formatEpisodeLabel(episode.seasonNumber, episode.episodeNumber);
        if (titleEl) titleEl.textContent = episode.name || 'Episodio';
        if (airEl) {
            airEl.textContent = episode.air_date
                ? `Emisión: ${formatAirDateShort(episode.air_date)}`
                : 'Fecha de emisión desconocida';
        }
        if (overviewEl) overviewEl.textContent = episode.overview || 'Sin descripción';

        const watched = show.capitulos_vistos?.includes(episodeId);
        if (watchBtn) {
            watchBtn.classList.toggle('is-watched', Boolean(watched));
            watchBtn.setAttribute('aria-label', watched ? 'Desmarcar visto' : 'Marcar visto');
        }

        modal?.classList.remove('hidden');
    } catch (error) {
        console.error('[App] Error abriendo episodio:', error);
        showToast('Error al cargar el episodio', 'error');
    } finally {
        showLoading(false);
    }
}

function closeEpisodeModal() {
    document.getElementById('episode-modal')?.classList.add('hidden');
    AppState.selectedEpisode = null;
}

function refreshEpisodeModalWatchState() {
    const ctx = AppState.selectedEpisode;
    if (!ctx) return;
    const show = AppState.shows.find(s => s.id_tmdb === ctx.showId);
    const watchBtn = document.getElementById('episode-watch-btn');
    if (!show || !watchBtn) return;
    const watched = show.capitulos_vistos?.includes(ctx.episodeId);
    watchBtn.classList.toggle('is-watched', Boolean(watched));
    watchBtn.setAttribute('aria-label', watched ? 'Desmarcar visto' : 'Marcar visto');
}

async function toggleEpisodeFromDetail() {
    const ctx = AppState.selectedEpisode;
    if (!ctx) return;
    await toggleEpisode(ctx.showId, ctx.episodeId);
    refreshEpisodeModalWatchState();
}

async function openDetail(type, id_tmdb) {
    const modal = document.getElementById('detail-modal');
    modal.classList.remove('hidden');
    document.getElementById('modal-actions')?.classList.add('hidden');
    AppState.detailRecsExpanded = false;

    showLoading(true);

    try {
        let item = type === 'movie'
            ? AppState.movies.find(m => m.id_tmdb === id_tmdb)
            : AppState.shows.find(s => s.id_tmdb === id_tmdb);

        const needsFreshDetails = !item?.overview || !item?.credits?.cast?.length || !item?.recommendations?.length || !item?.backdrop;

        if (needsFreshDetails) {
            item = type === 'movie'
                ? mergeDetailItem(item, await getMovieDetails(id_tmdb))
                : mergeDetailItem(item, await getTVDetails(id_tmdb));
        }

        if (type === 'tv') {
            await refreshShowStatus(item);
        }

        if (!item.watch_providers || item.watch_providers.length === 0) {
            const watchProviders = await window.getWatchProviders?.(type === 'movie' ? 'movie' : 'tv', item.id_tmdb);
            if (watchProviders?.length) {
                item.watch_providers = watchProviders;
            }
        }

        AppState.selectedItem = { ...item, tipo: type };
        closeDetailMenu();

        updateDetailHero(AppState.selectedItem);

        const overviewEl = document.getElementById('modal-overview');
        if (overviewEl) overviewEl.textContent = item.overview || 'Sin descripción';

        renderDetailInfo(AppState.selectedItem);

        const ratingInput = document.getElementById('modal-rating-input');
        if (ratingInput) ratingInput.value = item.puntuacion || '';
        const statusSelect = document.getElementById('modal-status');
        if (statusSelect) statusSelect.value = item.estado || 'pending';

        if (type === 'tv') {
            document.getElementById('detail-tabs').classList.remove('hidden');
            document.getElementById('detail-episodes-tab').classList.remove('hidden');
            await renderEpisodes(AppState.selectedItem);
            switchDetailTab('info');
        } else {
            document.getElementById('detail-tabs').classList.add('hidden');
            document.getElementById('detail-episodes-tab').classList.add('hidden');
            document.getElementById('modal-episodes').classList.add('hidden');
            switchDetailTab('info');
        }
    } catch (error) {
        console.error('[App] Error abriendo detalle:', error);
        showToast('Error al cargar detalles', 'error');
    } finally {
        showLoading(false);
    }
}

/**
 * Cierra el modal
 */
function closeModal() {
    document.getElementById('detail-modal').classList.add('hidden');
    document.getElementById('modal-add-bar')?.classList.add('hidden');
    document.querySelector('.tvst-modal-scroll')?.classList.remove('has-add-bar');
    closeDetailMenu();
    AppState.selectedItem = null;
}

/**
 * Guarda los cambios del modal
 */
async function saveContent() {
    if (!AppState.selectedItem) return;
    
    const item = AppState.selectedItem;
    const rating = parseFloat(document.getElementById('modal-rating-input').value) || 0;
    const status = document.getElementById('modal-status').value;
    
    updateRating(item.tipo, item.id_tmdb, rating);
    await updateStatus(item.tipo, item.id_tmdb, status);
    
    closeModal();
    renderFollowing();
    showToast('Cambios guardados', 'success');
}

/**
 * Elimina el contenido actual
 */
function removeContent() {
    if (!AppState.selectedItem) return;
    
    const item = AppState.selectedItem;
    
    if (confirm(`¿Estás seguro de eliminar "${item.titulo}"?`)) {
        if (item.tipo === 'movie') {
            removeMovie(item.id_tmdb);
        } else {
            removeShow(item.id_tmdb);
        }
        closeModal();
    }
}

/**
 * Establece la puntuación
 * @param {number} rating - Puntuación (1-10)
 */
function setRating(rating) {
    document.getElementById('modal-rating-input').value = rating;
    renderStars(rating);
}

/**
 * Establece el estado
 * @param {string} status - Estado
 */
function setStatus(status) {
    // El estado se guarda al hacer clic en "Guardar"
}

// ============================================
// BÚSQUEDA
// ============================================

/**
 * Maneja el evento de búsqueda
 * @param {Event} event - Evento del input
 */
function handleSearch(event) {
    const query = event.target.value;
    
    searchWithDebounce(query, (results) => {
        renderSearchResults(results);
    });
}

/**
 * Añade un item desde la búsqueda
 * @param {string} type - 'movie' o 'tv'
 * @param {number} id_tmdb - ID de TMDB
 */
async function addItem(type, id_tmdb) {
    const item = type === 'movie' 
        ? AppState.movies.find(m => m.id_tmdb === id_tmdb)
        : AppState.shows.find(s => s.id_tmdb === id_tmdb);

    if (item) {
        showToast('Ya está en tu lista', 'info');
        renderSearchResults(AppState.lastSearchResults);
        return false;
    }

    if (type === 'movie') {
        await addMovie({ id_tmdb, tipo: 'movie' });
    } else {
        await addShow({ id_tmdb, tipo: 'tv' });
    }

    renderSearchResults(AppState.lastSearchResults);
    return true;
}

async function addFromDetail() {
    const item = AppState.selectedItem;
    if (!item?.id_tmdb) return;

    const added = await addItem(item.tipo, item.id_tmdb);
    if (added) {
        await openDetail(item.tipo, item.id_tmdb);
    } else {
        updateDetailAddBar(item);
    }
}

// ============================================
// DRIVE
// ============================================

/**
 * Conecta a Google Drive
 */
async function connectDrive() {
    console.log('[App] === connectDrive iniciado ===');
    try {
        await authenticate();
        updateDriveStatus(true);
        showToast('Conectado a Google Drive', 'success');
        await enterAppAfterDrive();
    } catch (error) {
        console.error('[App] Error conectando Drive:', error);
        updateDriveStatus(false);
        const msg = String(error?.error || error?.message || error || '');
        if (msg.includes('origin_mismatch')) {
            showToast(`Error OAuth: origen no autorizado (${window.location.origin})`, 'error');
        } else {
            showToast('Error al conectar Google Drive', 'error');
        }
    }
}

/**
 * Desconecta de Google Drive
 */
function disconnectDrive() {
    signOut();
    AppState.driveReady = false;
    updateDriveStatus(false);
    setDriveGateVisible(true);
    showToast('Desconectado de Google Drive', 'info');
}

/**
 * Actualiza el estado de conexión a Drive en la UI
 * @param {boolean} connected - Estado de conexión
 */
function updateDriveStatus(connected) {
    AppState.isDriveConnected = !!connected;

    const statusDiv = document.getElementById('drive-status');
    const originHint = document.getElementById('drive-origin-hint');
    const connectBtn = document.getElementById('btn-connect-drive');
    const disconnectBtn = document.getElementById('btn-disconnect-drive');
    const syncBtn = document.getElementById('btn-sync-drive');

    if (!statusDiv || !connectBtn || !disconnectBtn) {
        console.warn('[App] No se encontraron elementos de UI de Drive');
        return;
    }

    const origin = window.location.origin;
    if (originHint) {
        originHint.textContent = `Origen actual: ${origin} — debe coincidir con un origen autorizado en Google Cloud Console.`;
    }

    if (connected) {
        statusDiv.innerHTML = `
            <div class="flex items-center gap-2 text-green-600 dark:text-green-400">
                <span>✓</span>
                <span>Conectado — los cambios se sincronizan automáticamente</span>
            </div>
        `;
        connectBtn.classList.add('hidden');
        disconnectBtn.classList.remove('hidden');
        syncBtn?.classList.remove('hidden');
    } else {
        statusDiv.innerHTML = `
            <div class="flex items-center gap-2 text-yellow-600 dark:text-yellow-400">
                <span>⚠️</span>
                <span>No conectado</span>
            </div>
        `;
        connectBtn.classList.remove('hidden');
        disconnectBtn.classList.add('hidden');
        syncBtn?.classList.add('hidden');
    }
}

// ============================================
// GESTIÓN DE DATOS
// ============================================

/**
 * Exporta los datos a un archivo JSON
 */
function exportData() {
    const data = {
        movies: AppState.movies,
        shows: AppState.shows,
        lists: AppState.lists,
        exportDate: new Date().toISOString(),
    };
    
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `seenit_backup_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    
    showToast('Datos exportados', 'success');
}

/**
 * Importa datos desde un archivo JSON
 */
function importData() {
    document.getElementById('import-file').click();
}

/**
 * Maneja la importación de datos
 * @param {Event} event - Evento del input file
 */
function handleImport(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result);
            
            if (data.movies || data.shows || data.lists) {
                AppState.movies = (data.movies || []).map(normalizeStoredMovie);
                AppState.shows = (data.shows || []).map(normalizeStoredShow);
                AppState.lists = (data.lists || []).map(normalizeStoredList);
                saveLocalData();
                syncToDriveNow();
                renderCurrentView();
                showToast('Datos importados correctamente', 'success');
            } else {
                showToast('Formato de archivo inválido', 'error');
            }
        } catch (error) {
            console.error('[App] Error importando datos:', error);
            showToast('Error al importar datos', 'error');
        }
    };
    reader.readAsText(file);
    
    // Limpiar input
    event.target.value = '';
}

/**
 * Borra todos los datos
 */
function clearAllData() {
    if (confirm('¿Estás seguro de borrar todos los datos? Esta acción no se puede deshacer.')) {
        AppState.movies = [];
        AppState.shows = [];
        AppState.lists = [];
        saveLocalData();
        syncToDriveNow();
        renderCurrentView();
        showToast('Todos los datos han sido borrados', 'success');
    }
}

function onTvTimeFileSelected() {
    const seriesInput = document.getElementById('tvtime-series-file');
    const moviesInput = document.getElementById('tvtime-movies-file');
    const listsInput = document.getElementById('tvtime-lists-file');
    const label = document.getElementById('tvtime-import-files');
    const btn = document.getElementById('btn-tvtime-import');

    const seriesFile = seriesInput?.files?.[0] || null;
    const moviesFile = moviesInput?.files?.[0] || null;
    const listsFile = listsInput?.files?.[0] || null;
    const parts = [];
    if (seriesFile) parts.push(`Series: ${seriesFile.name}`);
    if (moviesFile) parts.push(`Películas: ${moviesFile.name}`);
    if (listsFile) parts.push(`Listas: ${listsFile.name}`);
    if (label) label.textContent = parts.length ? parts.join(' · ') : 'Ningún archivo seleccionado';
    if (btn) btn.disabled = !(seriesFile || moviesFile || listsFile);
}

async function readJsonFile(file) {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!Array.isArray(data)) {
        throw new Error('El JSON debe ser un array');
    }
    return data;
}

async function startTvTimeImport() {
    const seriesInput = document.getElementById('tvtime-series-file');
    const moviesInput = document.getElementById('tvtime-movies-file');
    const listsInput = document.getElementById('tvtime-lists-file');
    const progressEl = document.getElementById('tvtime-import-progress');
    const reportEl = document.getElementById('tvtime-import-report');
    const btn = document.getElementById('btn-tvtime-import');
    const replace = Boolean(document.getElementById('tvtime-replace-library')?.checked);

    const seriesFile = seriesInput?.files?.[0];
    const moviesFile = moviesInput?.files?.[0];
    const listsFile = listsInput?.files?.[0];
    if (!seriesFile && !moviesFile && !listsFile) {
        showToast('Selecciona al menos un JSON', 'info');
        return;
    }

    if (btn) btn.disabled = true;
    if (progressEl) {
        progressEl.classList.remove('hidden');
        progressEl.textContent = 'Leyendo archivos...';
    }
    if (reportEl) {
        reportEl.classList.add('hidden');
        reportEl.textContent = '';
    }

    try {
        const series = seriesFile ? await readJsonFile(seriesFile) : [];
        const movies = moviesFile ? await readJsonFile(moviesFile) : [];
        const lists = listsFile ? await readJsonFile(listsFile) : [];

        let report = {
            seriesImported: 0,
            moviesImported: 0,
            seriesUpdated: 0,
            moviesUpdated: 0,
            listsImported: 0,
            listsUpdated: 0,
            listItemsAdded: 0,
            notFound: [],
            errors: [],
        };

        if (series.length || movies.length) {
            const libReport = await importTvTimeLibrary({
                series,
                movies,
                replace,
                onProgress: ({ current, total, title, phase }) => {
                    if (progressEl) {
                        progressEl.textContent = `${phase === 'series' ? 'Series' : 'Películas'}: ${current}/${total} — ${title}`;
                    }
                },
            });
            report = { ...report, ...libReport, listsImported: 0, listsUpdated: 0, listItemsAdded: 0 };
            report.notFound = [...(libReport.notFound || [])];
            report.errors = [...(libReport.errors || [])];
        } else if (replace) {
            AppState.movies = [];
            AppState.shows = [];
            AppState.lists = [];
        }

        if (lists.length) {
            const listReport = await importTvTimeLists({
                lists,
                onProgress: ({ current, total, title }) => {
                    if (progressEl) {
                        progressEl.textContent = `Listas: ${current}/${total} — ${title}`;
                    }
                },
            });
            report.listsImported = listReport.listsImported;
            report.listsUpdated = listReport.listsUpdated;
            report.listItemsAdded = listReport.listItemsAdded;
            report.notFound = [...report.notFound, ...(listReport.notFound || [])];
            report.errors = [...report.errors, ...(listReport.errors || [])];
        }

        await renderCurrentView();

        const lines = [
            `Importadas: ${report.seriesImported} series, ${report.moviesImported} películas`,
            `Actualizadas: ${report.seriesUpdated} series, ${report.moviesUpdated} películas`,
            `Listas: ${report.listsImported} nuevas, ${report.listsUpdated} actualizadas, ${report.listItemsAdded} ítems`,
            `No encontrados: ${report.notFound.length}`,
            `Errores: ${report.errors.length}`,
            '',
        ];

        if (report.notFound.length) {
            lines.push('--- No encontrados ---');
            report.notFound.forEach(item => {
                lines.push(
                    `[${item.tipo}] ${item.title}`
                    + (item.imdb ? ` | imdb ${item.imdb}` : '')
                    + (item.tvdb ? ` | tvdb ${item.tvdb}` : '')
                    + (item.year ? ` | ${item.year}` : '')
                    + (item.list ? ` | lista ${item.list}` : ''),
                );
            });
        }

        if (report.errors.length) {
            lines.push('', '--- Errores ---');
            report.errors.forEach(item => {
                lines.push(`[${item.tipo}] ${item.title}: ${item.error}`);
            });
        }

        if (reportEl) {
            reportEl.textContent = lines.join('\n');
            reportEl.classList.remove('hidden');
        }
        if (progressEl) {
            progressEl.textContent = `Listo. ${report.notFound.length} sin match TMDB.`;
        }
        showToast(report.notFound.length
            ? `Importación hecha (${report.notFound.length} no encontrados)`
            : 'Importación completada', report.notFound.length ? 'info' : 'success');
    } catch (error) {
        console.error('[App] Error importando TV Show Time:', error);
        showToast('Error al importar TV Show Time', 'error');
        if (progressEl) progressEl.textContent = String(error.message || error);
    } finally {
        onTvTimeFileSelected();
    }
}

// ============================================
// UTILIDADES
// ============================================

const EMPTY_ICONS = {
    episodes: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 9h8M8 13h5"/><path d="M10 2.5l2 2.5 2-2.5"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/><circle cx="12" cy="15" r="1.25" fill="currentColor" stroke="none"/></svg>',
    film: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/></svg>',
    search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16.5 16.5L21 21"/></svg>',
    spark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.2 5.2L18 9.5l-4.2 2.3L12 17l-1.8-5.2L6 9.5l4.8-1.3L12 3z"/><path d="M19 14l.6 2.4L22 17l-2.1 1.1L19 20.5l-.9-2.4L16 17l2.4-.6L19 14z"/></svg>',
};

/**
 * Empty / loading state markup with SVG icons.
 * @param {'episodes'|'calendar'|'film'|'check'|'search'|'spark'} icon
 * @param {string} title
 * @param {{ subtitle?: string, loading?: boolean, grid?: boolean }} [opts]
 */
function emptyState(icon, title, opts = {}) {
    const svg = EMPTY_ICONS[icon] || EMPTY_ICONS.spark;
    const loadingClass = opts.loading ? ' is-loading' : '';
    const gridStyle = opts.grid ? ' style="grid-column: 1 / -1;"' : '';
    const subtitle = opts.subtitle
        ? `<p class="tvst-empty-text">${opts.subtitle}</p>`
        : '';
    return `
        <div class="tvst-empty"${gridStyle}>
            <div class="tvst-empty-icon${loadingClass}">${svg}</div>
            <p class="tvst-empty-title">${title}</p>
            ${subtitle}
        </div>`;
}

/**
 * Muestra un toast notification vistoso
 * @param {string} message
 * @param {'success'|'error'|'info'} [type='info']
 */
function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    const msgEl = document.getElementById('toast-message');
    if (!toast || !msgEl) return;

    const resolved = type === 'success' || type === 'error' || type === 'info'
        ? type
        : 'info';

    msgEl.textContent = message;
    toast.classList.remove('hidden', 'is-success', 'is-error', 'is-info', 'is-leaving');
    toast.classList.add(`is-${resolved}`, 'is-visible');

    clearTimeout(window.__seenitToastTimer);
    window.__seenitToastTimer = setTimeout(() => {
        toast.classList.add('is-leaving');
        setTimeout(() => {
            toast.classList.add('hidden');
            toast.classList.remove('is-visible', 'is-leaving', 'is-success', 'is-error', 'is-info');
        }, 220);
    }, 3200);
}

/**
 * Muestra/oculta el loading overlay
 * @param {boolean} show - Mostrar u ocultar
 */
function showLoading(show) {
    const overlay = document.getElementById('loading-overlay');
    if (show) {
        overlay.classList.remove('hidden');
    } else {
        overlay.classList.add('hidden');
    }
}

/**
 * Obtiene el badge de estado
 * @param {string} status - Estado
 * @returns {string} HTML del badge
 */
function getStatusBadge(status) {
    const normalized = normalizeStatus(status);
    const badges = {
        'pending': '<span class="tvst-status-badge tvst-status-pending">Pendiente</span>',
        'watching': '<span class="tvst-status-badge tvst-status-watching">Viendo</span>',
        'completed': '<span class="tvst-status-badge tvst-status-completed">Completado</span>',
        'dropped': '<span class="tvst-status-badge tvst-status-dropped">Abandonado</span>',
        'standby': '<span class="tvst-status-badge tvst-status-standby">En espera</span>',
    };

    return badges[normalized] || badges['pending'];
}

/**
 * Configura los event listeners
 */
function setupEventListeners() {
    // Event listeners ya están configurados en el HTML con onclick
    console.log('[App] Event listeners configurados');
}

// ============================================
// EXPORTACIONES
// ============================================

// Hacer funciones disponibles globalmente
window.App = {
    initApp,
    addMovie,
    addShow,
    removeMovie,
    removeShow,
    updateRating,
    updateStatus,
    toggleEpisode,
    toggleSeasonWatched,
    toggleEpisodeAndUpdateSeason,
    updateSeasonUI,
    switchTab,
    switchSubTab,
    switchMoviesSubTab,
    switchProfileTab,
    scrollToNowAnchor,
    switchDetailTab,
    openDetail,
    closeModal,
    saveContent,
    removeContent,
    setRating,
    setStatus,
    handleSearch,
    addItem,
    connectDrive,
    disconnectDrive,
    exportData,
    importData,
    handleImport,
    clearAllData,
};

// También exportar individualmente
window.switchTab = switchTab;
window.switchSubTab = switchSubTab;
window.switchMoviesSubTab = switchMoviesSubTab;
window.switchProfileTab = switchProfileTab;
window.toggleProfileExpanded = toggleProfileExpanded;
window.renderProfileView = renderProfileView;
window.toggleDetailRecsExpanded = toggleDetailRecsExpanded;
window.loadFromDrive = loadFromDrive;
window.scrollToNowAnchor = scrollToNowAnchor;
window.switchDetailTab = switchDetailTab;
window.openDetail = openDetail;
window.openEpisodeDetail = openEpisodeDetail;
window.closeEpisodeModal = closeEpisodeModal;
window.toggleEpisodeFromDetail = toggleEpisodeFromDetail;
window.closeModal = closeModal;
window.saveContent = saveContent;
window.removeContent = removeContent;
window.setRating = setRating;
window.setStatus = setStatus;
window.setPersonalRating = setPersonalRating;
window.toggleDetailMenu = toggleDetailMenu;
window.runDetailMenuAction = runDetailMenuAction;
window.closeDetailMenu = closeDetailMenu;
window.handleSearch = handleSearch;
window.addItem = addItem;
window.addFromDetail = addFromDetail;
window.connectDrive = connectDrive;
window.connectDriveFromGate = connectDriveFromGate;
window.disconnectDrive = disconnectDrive;
window.exportData = exportData;
window.importData = importData;
window.handleImport = handleImport;
window.clearAllData = clearAllData;
window.onTvTimeFileSelected = onTvTimeFileSelected;
window.startTvTimeImport = startTvTimeImport;
window.createProfileList = createProfileList;
window.openListModal = openListModal;
window.closeListModal = closeListModal;
window.renameSelectedList = renameSelectedList;
window.deleteSelectedList = deleteSelectedList;
window.removeItemFromList = removeItemFromList;
window.openDetailFromList = openDetailFromList;
window.onListItemClick = onListItemClick;
window.toggleListCoverPickMode = toggleListCoverPickMode;
window.setListCover = setListCover;
window.toggleFavorite = toggleFavorite;
window.openListPicker = openListPicker;
window.closeListPicker = closeListPicker;
window.toggleSelectedInList = toggleSelectedInList;
window.createListFromPicker = createListFromPicker;
window.toggleEpisode = toggleEpisode;
window.toggleMovieWatched = toggleMovieWatched;
window.toggleSeasonWatched = toggleSeasonWatched;
window.toggleSeasonAccordion = toggleSeasonAccordion;
window.toggleEpisodeAndUpdateSeason = toggleEpisodeAndUpdateSeason;
window.updateSeasonUI = updateSeasonUI;

console.log('[App] app.js cargado');

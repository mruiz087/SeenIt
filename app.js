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
    profileSeriesSearch: '',
    profileMoviesSearch: '',
    profileSeriesPlatform: 'all',
    profileMoviesPlatform: 'all',
    profileExpanded: { series: false, movies: false, favoritesSeries: false, favoritesMovies: false },
    listSortMode: 'added',
    detailRecsExpanded: false,
    detailCriticaEditing: false,
    moviesPendingGenreFilter: 'all',
    moviesPendingPlatformFilter: 'all',
    moviesPendingMaxRuntime: null,
    moviesPendingFiltersOpen: false,
    lastSearchResults: [],
    selectedItem: null,
    selectedEpisode: null,
    selectedPerson: null,
    selectedListId: null,
    listCoverPickMode: false,
    isDriveConnected: false,
    isSyncing: false,
    syncDirty: false,
    driveReady: false,
    driveLoadOk: false,
    driveUserId: null,
    deletedIds: { movie: [], tv: [] },
    deletedListIds: [],
    expandedSeasons: {},
    timelineHistoryVisible: { 'pending-list': 0, upcoming: 4 },
    timelineHistoryCache: {},
    timelinePendingCache: { continueWatching: [], staleWatching: [], builtAt: 0 },
    timelineUpcomingCache: { html: '', builtAt: 0, items: [] },
    lastCompletedReopenAt: 0,
};

/** Cache en memoria de episodios ordenados (sesión). */
const orderedEpisodesCache = new Map();
const orderedEpisodesInflight = new Map();
const TIMELINE_FETCH_CONCURRENCY = 8;
const UPCOMING_FETCH_CONCURRENCY = 12;
const TIMELINE_CACHE_FRESH_MS = 3 * 60 * 1000;
const SHOW_META_TTL_MS = 12 * 60 * 60 * 1000;
const COMPLETED_REOPEN_THROTTLE_MS = 20 * 60 * 1000;
const SAVE_LOCAL_DEBOUNCE_MS = 400;
const CONTINUE_BOOST_DAYS = 14;
const DRIVE_USER_STORAGE_KEY = 'seenit_drive_user';
const LEGACY_DATA_KEY = 'seenit_data';

let appInitialized = false;
let syncToDriveTimeout = null;
let syncFlushBound = false;
let saveLocalDataTimeout = null;
let saveLocalFlushBound = false;
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
    const storedUser = getStoredDriveUser();
    if (storedUser?.id) {
        AppState.driveUserId = storedUser.id;
    }
    loadLocalData();
    setupEventListeners();
    bindSyncFlushListeners();
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
        const msg = typeof formatDriveError === 'function'
            ? formatDriveError(error)
            : String(error?.message || error || '');
        if (msg.includes('CONFIG_MISSING')) {
            setDriveGateVisible(true, getConfigSetupError() || 'Falta config.js con las claves de Google.');
            const btn = document.getElementById('btn-drive-gate-connect');
            if (btn) btn.disabled = true;
        } else {
            // Dejar el botón activo para reintentar al hacer clic
            setDriveGateVisible(true, msg
                ? `No se pudo preparar Google (${msg}). Pulsa Conectar para reintentar.`
                : 'No se pudo preparar Google. Pulsa Conectar para reintentar.');
        }
    }

    console.log('[App] Aplicación inicializada');
}

async function resolveDriveUser() {
    try {
        const info = await getUserInfo();
        const id = info?.permissionId || info?.emailAddress || info?.email || null;
        if (!id) return getStoredDriveUser();
        const user = {
            id: String(id),
            email: info?.emailAddress || info?.email || '',
            name: info?.displayName || info?.name || '',
        };
        setStoredDriveUser(user);
        return user;
    } catch (error) {
        console.warn('[App] No se pudo obtener usuario de Drive:', error);
        return getStoredDriveUser();
    }
}

async function enterAppAfterDrive() {
    setDriveGateStatus('Cargando tu biblioteca…');
    AppState.driveLoadOk = false;

    const prevUserId = AppState.driveUserId;
    // Pintar cuanto antes desde local conocido; Drive va en paralelo con resolve usuario
    if (prevUserId) {
        loadLocalData(prevUserId);
    }

    const localSnapshot = snapshotLibrary();
    const [user, driveOutcome] = await Promise.all([
        resolveDriveUser().catch((error) => {
            console.warn('[App] No se pudo obtener usuario de Drive:', error);
            return getStoredDriveUser();
        }),
        loadUserData()
            .then((data) => ({ ok: true, data }))
            .catch((error) => ({ ok: false, error })),
    ]);

    const userId = user?.id || null;
    AppState.driveUserId = userId;

    if (userId !== prevUserId && typeof resetDriveDataFileCache === 'function') {
        resetDriveDataFileCache();
    }

    let snapshotForMerge = localSnapshot;
    if (userId !== prevUserId) {
        if (userId) loadLocalData(userId);
        else clearLibraryState();
        snapshotForMerge = snapshotLibrary();
        // Cuenta distinta: reset de caché de fichero + recarga Drive
        try {
            const data = await loadUserData();
            driveOutcome.ok = true;
            driveOutcome.data = data;
            delete driveOutcome.error;
        } catch (error) {
            driveOutcome.ok = false;
            driveOutcome.error = error;
        }
    } else if (!prevUserId && userId) {
        loadLocalData(userId);
        snapshotForMerge = snapshotLibrary();
    }

    try {
        if (!driveOutcome.ok) throw driveOutcome.error || new Error('Drive load failed');
        const result = reconcileWithDriveData(driveOutcome.data, snapshotForMerge);
        flushSaveLocalData();
        saveLocalDataImmediate();
        AppState.driveLoadOk = true;
        updateDriveStatus(true);
        AppState.driveReady = true;
        if (result === 'local-upload' || result === 'merged') {
            await syncToDriveNow();
        }
        if (result === 'local-upload') {
            showToast('Biblioteca local subida a Drive', 'success');
        } else if (result === 'merged') {
            showToast('Biblioteca fusionada con Drive', 'info');
        }
        setDriveGateStatus('');
        setDriveGateVisible(false);
    } catch (error) {
        console.warn('[App] Error cargando Drive al entrar:', error);
        applyLibrary(snapshotForMerge);
        saveLocalDataImmediate();
        AppState.driveLoadOk = false;
        AppState.driveReady = true;
        updateDriveStatus(false);
        setDriveGateStatus('');
        setDriveGateVisible(false);
        showToast('No se pudo leer Drive; cambios no se subirán hasta reconectar', 'error');
    }

    switchTab('series');
    await renderCurrentView();
    scheduleSyncMobileChromeHeights();
    const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 800));
    idle(() => {
        prefetchTimelineSeasons().catch(() => {});
    });
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
        try {
            await initDriveService();
        } catch (initError) {
            console.warn('[App] Error initDriveService:', initError);
            const initMsg = typeof formatDriveError === 'function'
                ? formatDriveError(initError)
                : String(initError?.message || initError || '');
            if (initMsg.includes('CONFIG_MISSING')) {
                throw initError;
            }
            throw new Error(initMsg
                ? `No se pudo inicializar Google: ${initMsg}`
                : 'No se pudo inicializar Google. Revisa la conexión e inténtalo de nuevo.');
        }
        await authenticate();
        setDriveGateStatus('Conectado. Cargando tu biblioteca…');
        await enterAppAfterDrive();
        showToast('Conectado a Google Drive', 'success');
    } catch (error) {
        console.error('[App] Error conectando Drive desde gate:', error);
        updateDriveStatus(false);
        setDriveGateStatus('');
        const msg = typeof formatDriveError === 'function'
            ? formatDriveError(error)
            : String(error?.error || error?.message || error || '');
        if (msg.includes('CONFIG_MISSING') || msg.includes('CONFIG_TMDB')) {
            setDriveGateVisible(true, getConfigSetupError() || 'Falta configuración de claves.');
        } else if (msg.includes('origin_mismatch')) {
            setDriveGateVisible(true, `Origen no autorizado en Google Cloud: ${window.location.origin}. Añádelo en Credenciales → Orígenes JavaScript autorizados.`);
        } else if (msg.includes('popup_closed') || msg.includes('access_denied')) {
            setDriveGateVisible(true, 'Cerraste la ventana de Google o denegaste el acceso. Pulsa de nuevo para intentarlo.');
        } else if (msg.includes('popup_failed') || msg.toLowerCase().includes('popup')) {
            setDriveGateVisible(true, 'El navegador bloqueó el popup. Permite ventanas emergentes para este sitio e inténtalo otra vez.');
        } else {
            setDriveGateVisible(true, msg.startsWith('No se pudo inicializar')
                ? msg
                : (msg ? `No se pudo conectar: ${msg}` : 'No se pudo conectar. Revisa la ventana de Google o inténtalo de nuevo.'));
        }
    } finally {
        if (btn) btn.disabled = false;
    }
}

function nowIso() {
    return new Date().toISOString();
}

function touchUpdatedAt(item) {
    if (!item || typeof item !== 'object') return item;
    item.updatedAt = nowIso();
    return item;
}

function getStoredDriveUser() {
    try {
        const raw = localStorage.getItem(DRIVE_USER_STORAGE_KEY);
        if (!raw) return null;
        const data = JSON.parse(raw);
        if (!data?.id) return null;
        return { id: String(data.id), email: data.email || '', name: data.name || '' };
    } catch (_) {
        return null;
    }
}

function setStoredDriveUser(user) {
    if (!user?.id) {
        localStorage.removeItem(DRIVE_USER_STORAGE_KEY);
        AppState.driveUserId = null;
        return;
    }
    const payload = {
        id: String(user.id),
        email: user.email || '',
        name: user.name || '',
    };
    localStorage.setItem(DRIVE_USER_STORAGE_KEY, JSON.stringify(payload));
    AppState.driveUserId = payload.id;
}

function getDataStorageKey(userId = AppState.driveUserId) {
    if (userId) return `seenit_data__${userId}`;
    return LEGACY_DATA_KEY;
}

function migrateLegacyDataIfNeeded(userId) {
    if (!userId) return;
    const userKey = getDataStorageKey(userId);
    if (localStorage.getItem(userKey)) return;
    const legacy = localStorage.getItem(LEGACY_DATA_KEY);
    if (!legacy) return;
    try {
        localStorage.setItem(userKey, legacy);
        console.log('[App] Migrados datos legacy a', userKey);
    } catch (error) {
        console.warn('[App] No se pudo migrar seenit_data legacy:', error);
    }
}

function normalizeDeletedIds(raw) {
    const toEntries = (arr) => {
        if (!Array.isArray(arr)) return [];
        return arr.map((entry) => {
            if (entry && typeof entry === 'object' && entry.id != null) {
                const id = Number(entry.id);
                if (!Number.isFinite(id) || id <= 0) return null;
                return { id, deletedAt: entry.deletedAt || nowIso() };
            }
            const id = Number(entry);
            if (!Number.isFinite(id) || id <= 0) return null;
            return { id, deletedAt: nowIso() };
        }).filter(Boolean);
    };
    return {
        movie: toEntries(raw?.movie),
        tv: toEntries(raw?.tv),
    };
}

function normalizeDeletedListIds(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map((entry) => {
        if (entry && typeof entry === 'object' && entry.id != null) {
            return { id: String(entry.id), deletedAt: entry.deletedAt || nowIso() };
        }
        if (entry == null || entry === '') return null;
        return { id: String(entry), deletedAt: nowIso() };
    }).filter(Boolean);
}

function recordItemTombstone(tipo, id_tmdb) {
    const bucket = tipo === 'movie' ? 'movie' : 'tv';
    const id = Number(id_tmdb);
    if (!Number.isFinite(id) || id <= 0) return;
    const list = AppState.deletedIds[bucket] || [];
    const existing = list.find(e => e.id === id);
    if (existing) {
        existing.deletedAt = nowIso();
    } else {
        list.push({ id, deletedAt: nowIso() });
    }
    AppState.deletedIds[bucket] = list;
}

function clearItemTombstone(tipo, id_tmdb) {
    const bucket = tipo === 'movie' ? 'movie' : 'tv';
    const id = Number(id_tmdb);
    AppState.deletedIds[bucket] = (AppState.deletedIds[bucket] || []).filter(e => e.id !== id);
}

function recordListTombstone(listId) {
    const id = String(listId || '');
    if (!id) return;
    const existing = AppState.deletedListIds.find(e => e.id === id);
    if (existing) {
        existing.deletedAt = nowIso();
    } else {
        AppState.deletedListIds.push({ id, deletedAt: nowIso() });
    }
}

function clearListTombstone(listId) {
    const id = String(listId || '');
    AppState.deletedListIds = AppState.deletedListIds.filter(e => e.id !== id);
}

function clearLibraryState() {
    AppState.movies = [];
    AppState.shows = [];
    AppState.lists = [];
    AppState.deletedIds = { movie: [], tv: [] };
    AppState.deletedListIds = [];
    AppState.selectedItem = null;
    AppState.selectedListId = null;
    invalidateTimelineCaches();
}

/**
 * Carga datos desde localStorage (clave por cuenta Google si hay userId)
 */
function loadLocalData(userId = AppState.driveUserId) {
    try {
        if (userId) migrateLegacyDataIfNeeded(userId);
        const key = getDataStorageKey(userId);
        const savedData = localStorage.getItem(key);
        if (savedData) {
            const data = JSON.parse(savedData);
            AppState.movies = (data.movies || []).map(normalizeStoredMovie);
            AppState.shows = (data.shows || []).map(normalizeStoredShow);
            AppState.lists = (data.lists || []).map(normalizeStoredList);
            AppState.deletedIds = normalizeDeletedIds(data.deletedIds);
            AppState.deletedListIds = normalizeDeletedListIds(data.deletedListIds);
            console.log('[App] Datos locales cargados', key);
        } else {
            clearLibraryState();
            console.log('[App] Sin datos locales para', key);
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
    const score = Number(normalized.puntuacion);
    normalized.puntuacion = Number.isFinite(score) && score > 0 ? Math.min(10, score) : 0;
    normalized.critica = typeof normalized.critica === 'string' ? normalized.critica : '';
    normalized.updatedAt = normalized.updatedAt || normalized.lastModified || nowIso();
    return normalized;
}

function normalizeStoredShow(show) {
    const normalized = { ...show };
    normalized.tipo = 'tv';
    normalized.estado = normalizeStatus(normalized.estado);
    normalized.capitulos_vistos = Array.isArray(normalized.capitulos_vistos) ? normalized.capitulos_vistos : [];
    normalized.capitulos_saltados = Array.isArray(normalized.capitulos_saltados) ? normalized.capitulos_saltados : [];
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
    const score = Number(normalized.puntuacion);
    normalized.puntuacion = Number.isFinite(score) && score > 0 ? Math.min(10, score) : 0;
    normalized.critica = typeof normalized.critica === 'string' ? normalized.critica : '';
    normalized.continueBoostAt = typeof normalized.continueBoostAt === 'string' ? normalized.continueBoostAt : '';
    if (normalized.metaCheckedAt) {
        normalized.metaCheckedAt = String(normalized.metaCheckedAt);
    }
    normalized.updatedAt = normalized.updatedAt || normalized.lastModified || nowIso();
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
        updatedAt: list?.updatedAt || list?.lastModified || nowIso(),
    };
}

/**
 * Guarda datos en localStorage (debounce para no bloquear el hilo en builds).
 */
function saveLocalDataImmediate() {
    try {
        const data = {
            movies: AppState.movies,
            shows: AppState.shows,
            lists: AppState.lists,
            deletedIds: AppState.deletedIds,
            deletedListIds: AppState.deletedListIds,
            lastModified: nowIso(),
        };
        localStorage.setItem(getDataStorageKey(), JSON.stringify(data));
    } catch (error) {
        console.error('[App] Error guardando datos locales:', error);
    }
}

function flushSaveLocalData() {
    if (!saveLocalDataTimeout) return;
    clearTimeout(saveLocalDataTimeout);
    saveLocalDataTimeout = null;
    saveLocalDataImmediate();
}

function bindSaveLocalFlushListeners() {
    if (saveLocalFlushBound) return;
    saveLocalFlushBound = true;
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushSaveLocalData();
    });
    window.addEventListener('pagehide', flushSaveLocalData);
}

function saveLocalData() {
    bindSaveLocalFlushListeners();
    clearTimeout(saveLocalDataTimeout);
    saveLocalDataTimeout = setTimeout(() => {
        saveLocalDataTimeout = null;
        saveLocalDataImmediate();
    }, SAVE_LOCAL_DEBOUNCE_MS);
}

function getStoredLastModified(userId = AppState.driveUserId) {
    try {
        const raw = localStorage.getItem(getDataStorageKey(userId));
        if (!raw) return null;
        const data = JSON.parse(raw);
        return data?.lastModified || null;
    } catch (_) {
        return null;
    }
}

function snapshotLibrary() {
    return {
        movies: AppState.movies.map(m => ({ ...m })),
        shows: AppState.shows.map(s => ({ ...s })),
        lists: AppState.lists.map(l => ({
            ...l,
            itemIds: [...(l.itemIds || [])],
        })),
        deletedIds: {
            movie: (AppState.deletedIds.movie || []).map(e => ({ ...e })),
            tv: (AppState.deletedIds.tv || []).map(e => ({ ...e })),
        },
        deletedListIds: (AppState.deletedListIds || []).map(e => ({ ...e })),
        lastModified: getStoredLastModified() || nowIso(),
    };
}

function backupLibraryBeforeMerge(localSnapshot) {
    try {
        localStorage.setItem('seenit_data_backup', JSON.stringify({
            movies: localSnapshot?.movies || [],
            shows: localSnapshot?.shows || [],
            lists: localSnapshot?.lists || [],
            deletedIds: localSnapshot?.deletedIds || { movie: [], tv: [] },
            deletedListIds: localSnapshot?.deletedListIds || [],
            lastModified: localSnapshot?.lastModified || getStoredLastModified() || null,
            backedUpAt: nowIso(),
        }));
    } catch (error) {
        console.warn('[App] No se pudo guardar backup local antes del merge:', error);
    }
}

function libraryItemCount(lib) {
    return (lib?.movies?.length || 0) + (lib?.shows?.length || 0) + (lib?.lists?.length || 0);
}

function parseModifiedMs(value) {
    if (!value) return 0;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : 0;
}

function itemUpdatedMs(item) {
    return parseModifiedMs(item?.updatedAt || item?.lastModified);
}

function pickNewerByUpdatedAt(a, b) {
    const aMs = itemUpdatedMs(a);
    const bMs = itemUpdatedMs(b);
    if (bMs > aMs) return b;
    if (aMs > bMs) return a;
    const aWatched = Array.isArray(a?.capitulos_vistos) ? a.capitulos_vistos.length : 0;
    const bWatched = Array.isArray(b?.capitulos_vistos) ? b.capitulos_vistos.length : 0;
    if (bWatched > aWatched) return b;
    return a;
}

/**
 * LWW por updatedAt: gana el ítem más reciente (sin unión ciega de episodios/favoritos).
 */
function mergeMovieOrShow(localItem, remoteItem, kind) {
    const a = kind === 'movie' ? normalizeStoredMovie(localItem) : normalizeStoredShow(localItem);
    const b = kind === 'movie' ? normalizeStoredMovie(remoteItem) : normalizeStoredShow(remoteItem);
    const winner = pickNewerByUpdatedAt(a, b);
    return kind === 'movie' ? normalizeStoredMovie({ ...winner }) : normalizeStoredShow({ ...winner });
}

function mergeTombstoneLists(aList, bList) {
    const map = new Map();
    for (const entry of [...(aList || []), ...(bList || [])]) {
        if (!entry || entry.id == null) continue;
        const key = String(entry.id);
        const prev = map.get(key);
        if (!prev || parseModifiedMs(entry.deletedAt) >= parseModifiedMs(prev.deletedAt)) {
            map.set(key, { ...entry });
        }
    }
    return [...map.values()];
}

function mergeDeletedIds(localDel, remoteDel) {
    const local = normalizeDeletedIds(localDel);
    const remote = normalizeDeletedIds(remoteDel);
    return {
        movie: mergeTombstoneLists(local.movie, remote.movie).map(e => ({ id: Number(e.id), deletedAt: e.deletedAt })),
        tv: mergeTombstoneLists(local.tv, remote.tv).map(e => ({ id: Number(e.id), deletedAt: e.deletedAt })),
    };
}

function isItemTombstoned(id, tombstones, itemUpdatedAt) {
    const idNum = Number(id);
    const entry = (tombstones || []).find(e => Number(e.id) === idNum);
    if (!entry) return false;
    return parseModifiedMs(entry.deletedAt) >= itemUpdatedMs({ updatedAt: itemUpdatedAt });
}

function isListTombstoned(id, tombstones, listUpdatedAt) {
    const idStr = String(id);
    const entry = (tombstones || []).find(e => String(e.id) === idStr);
    if (!entry) return false;
    return parseModifiedMs(entry.deletedAt) >= itemUpdatedMs({ updatedAt: listUpdatedAt });
}

function mergeLibraries(localLib, remoteLib) {
    const deletedIds = mergeDeletedIds(localLib?.deletedIds, remoteLib?.deletedIds);
    const deletedListIds = mergeTombstoneLists(
        normalizeDeletedListIds(localLib?.deletedListIds),
        normalizeDeletedListIds(remoteLib?.deletedListIds),
    );

    const movieMap = new Map();
    for (const m of remoteLib.movies || []) movieMap.set(Number(m.id_tmdb), normalizeStoredMovie(m));
    for (const m of localLib.movies || []) {
        const id = Number(m.id_tmdb);
        movieMap.set(id, movieMap.has(id) ? mergeMovieOrShow(m, movieMap.get(id), 'movie') : normalizeStoredMovie(m));
    }
    const movies = [...movieMap.values()].filter(m => !isItemTombstoned(m.id_tmdb, deletedIds.movie, m.updatedAt));

    const showMap = new Map();
    for (const s of remoteLib.shows || []) showMap.set(Number(s.id_tmdb), normalizeStoredShow(s));
    for (const s of localLib.shows || []) {
        const id = Number(s.id_tmdb);
        showMap.set(id, showMap.has(id) ? mergeMovieOrShow(s, showMap.get(id), 'tv') : normalizeStoredShow(s));
    }
    const shows = [...showMap.values()].filter(s => !isItemTombstoned(s.id_tmdb, deletedIds.tv, s.updatedAt));

    const byId = new Map();
    const byNameKey = new Map();
    const listKey = (l) => `${l.tipo}::${String(l.name || '').toLowerCase()}`;

    const considerList = (raw) => {
        const normalized = normalizeStoredList(raw);
        if (isListTombstoned(normalized.id, deletedListIds, normalized.updatedAt)) return;

        if (byId.has(normalized.id)) {
            const prev = byId.get(normalized.id);
            const winner = itemUpdatedMs(normalized) >= itemUpdatedMs(prev) ? normalized : prev;
            byId.set(normalized.id, winner);
            return;
        }

        const key = listKey(normalized);
        if (byNameKey.has(key)) {
            const prevId = byNameKey.get(key);
            const prev = byId.get(prevId);
            if (prev) {
                const winner = itemUpdatedMs(normalized) >= itemUpdatedMs(prev) ? normalized : prev;
                byId.delete(prevId);
                byId.set(winner.id, winner);
                byNameKey.set(key, winner.id);
                return;
            }
        }

        byId.set(normalized.id, normalized);
        byNameKey.set(key, normalized.id);
    };

    for (const l of [...(remoteLib.lists || []), ...(localLib.lists || [])]) {
        considerList(l);
    }

    return {
        movies,
        shows,
        lists: [...byId.values()],
        deletedIds,
        deletedListIds,
    };
}

function applyLibrary(lib) {
    AppState.movies = (lib.movies || []).map(normalizeStoredMovie);
    AppState.shows = (lib.shows || []).map(normalizeStoredShow);
    AppState.lists = (lib.lists || []).map(normalizeStoredList);
    AppState.deletedIds = normalizeDeletedIds(lib.deletedIds);
    AppState.deletedListIds = normalizeDeletedListIds(lib.deletedListIds);
}

/**
 * Integra datos de Drive con lo local (backup + LWW + tombstones).
 * @returns {'remote'|'local-upload'|'merged'|'unchanged'}
 */
function reconcileWithDriveData(remoteData, localSnapshot) {
    backupLibraryBeforeMerge(localSnapshot);

    const remoteLib = {
        movies: (remoteData?.movies || []).map(normalizeStoredMovie),
        shows: (remoteData?.shows || []).map(normalizeStoredShow),
        lists: (remoteData?.lists || []).map(normalizeStoredList),
        deletedIds: normalizeDeletedIds(remoteData?.deletedIds),
        deletedListIds: normalizeDeletedListIds(remoteData?.deletedListIds),
        lastModified: remoteData?.lastModified || null,
    };
    const remoteCount = libraryItemCount(remoteLib);
    const localCount = libraryItemCount(localSnapshot);
    const remoteMs = parseModifiedMs(remoteLib.lastModified);
    const localMs = parseModifiedMs(localSnapshot?.lastModified);

    if (remoteCount === 0 && localCount > 0) {
        applyLibrary(localSnapshot);
        return 'local-upload';
    }

    if (remoteCount > 0 && localCount > 0) {
        applyLibrary(mergeLibraries(localSnapshot, remoteLib));
        return 'merged';
    }

    if (remoteCount > 0) {
        applyLibrary(remoteLib);
        return 'remote';
    }

    if (remoteCount === 0 && localCount === 0 && remoteMs > localMs && remoteMs > 0) {
        applyLibrary(remoteLib);
        return 'remote';
    }

    return 'unchanged';
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
        details.estado = 'pending';
        const normalized = touchUpdatedAt(normalizeStoredMovie(details));
        clearItemTombstone('movie', normalized.id_tmdb);
        AppState.movies.push(normalized);
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
        details.estado = 'pending';
        const normalized = touchUpdatedAt(normalizeStoredShow(details));
        clearItemTombstone('tv', normalized.id_tmdb);
        AppState.shows.push(normalized);
        invalidateTimelineCaches();
        saveLocalData();
        syncToDrive();
        renderCurrentView();
        showToast('Serie añadida (Pendiente)', 'success');
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
    recordItemTombstone('movie', id_tmdb);
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
    recordItemTombstone('tv', id_tmdb);
    removeItemFromAllLists('tv', id_tmdb);
    invalidateTimelineCaches();
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
    const value = Math.max(0, Math.min(10, Number(rating) || 0));
    if (type === 'movie') {
        const movie = AppState.movies.find(m => m.id_tmdb === id_tmdb);
        if (movie) {
            movie.puntuacion = value;
            touchUpdatedAt(movie);
        }
    } else if (type === 'tv') {
        const show = AppState.shows.find(s => s.id_tmdb === id_tmdb);
        if (show) {
            show.puntuacion = value;
            touchUpdatedAt(show);
        }
    }
    saveLocalData();
    // Persistencia inmediata en Drive (sin debounce) para no perder notas
    if (typeof isAuthenticated === 'function' && isAuthenticated()) {
        syncToDriveNow().catch((error) => {
            console.warn('[App] No se pudo sincronizar puntuación:', error);
            syncToDrive();
        });
    }
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
            touchUpdatedAt(movie);
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
            touchUpdatedAt(show);
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

function ensureSkippedList(show) {
    if (!Array.isArray(show.capitulos_saltados)) show.capitulos_saltados = [];
    return show.capitulos_saltados;
}

function isEpisodeSkipped(show, episodeId) {
    return Boolean(show?.capitulos_saltados?.includes(episodeId));
}

function isEpisodeWatched(show, episodeId) {
    return Boolean(show?.capitulos_vistos?.includes(episodeId));
}

/** Visto o saltado: ya no pendiente. */
function isEpisodeConsumed(show, episodeId) {
    return isEpisodeWatched(show, episodeId) || isEpisodeSkipped(show, episodeId);
}

function clearEpisodeSkipped(show, episodeId) {
    const list = ensureSkippedList(show);
    const idx = list.indexOf(episodeId);
    if (idx > -1) list.splice(idx, 1);
}

function markEpisodeSkipped(show, episodeId) {
    if (!show || !episodeId) return;
    if (!show.capitulos_vistos) show.capitulos_vistos = [];
    const wIdx = show.capitulos_vistos.indexOf(episodeId);
    if (wIdx > -1) {
        show.capitulos_vistos.splice(wIdx, 1);
        clearEpisodeWatchedRecord(show, episodeId);
    }
    const list = ensureSkippedList(show);
    if (!list.includes(episodeId)) list.push(episodeId);
}

function clearEpisodeFromSkippedWhenWatched(show, episodeId) {
    clearEpisodeSkipped(show, episodeId);
}

function shouldAskToMarkPreviousEpisodes(show, episodes, episodeId) {
    const targetEpisode = episodes.find(ep => ep.id === episodeId);
    if (!targetEpisode || !isEpisodeAired(targetEpisode)) return false;
    const airedEpisodes = episodes.filter(isEpisodeAired);
    const previousEpisodes = airedEpisodes.filter(ep => compareEpisodeOrder(ep, targetEpisode) < 0);
    return previousEpisodes.length > 0 && previousEpisodes.some(ep => !isEpisodeConsumed(show, ep.id));
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
    ensureSkippedList(show);

    const wasStandby = normalizeStatus(show.estado) === 'standby';
    const wasDropped = normalizeStatus(show.estado) === 'dropped';
    const wasPending = normalizeStatus(show.estado) === 'pending';
    const index = show.capitulos_vistos.indexOf(episode);
    let markedWatched = false;
    const newlyWatchedIds = [];
    if (index > -1) {
        show.capitulos_vistos.splice(index, 1);
        clearEpisodeWatchedRecord(show, episode);
    } else {
        const previousEpisodes = episodes.filter(isEpisodeAired).filter(ep => compareEpisodeOrder(ep, targetEpisode) < 0 && !isEpisodeConsumed(show, ep.id));
        if (shouldAskToMarkPreviousEpisodes(show, episodes, episode) && confirm('¿Quieres marcar también los episodios anteriores como vistos?')) {
            previousEpisodes.forEach(ep => {
                if (!show.capitulos_vistos.includes(ep.id)) {
                    show.capitulos_vistos.push(ep.id);
                    newlyWatchedIds.push(ep.id);
                }
                clearEpisodeSkipped(show, ep.id);
            });
        }
        show.capitulos_vistos.push(episode);
        newlyWatchedIds.push(episode);
        clearEpisodeSkipped(show, episode);
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
    if (wasPending && markedWatched) {
        show.estado = 'watching';
    }

    await refreshShowStatus(show);
    touchUpdatedAt(show);
    invalidateTimelineCaches();
    saveLocalData();
    syncToDrive();
    if (AppState.selectedItem?.tipo === 'tv' && AppState.selectedItem.id_tmdb === id_tmdb) {
        AppState.selectedItem = { ...show, tipo: 'tv' };
        await renderEpisodes(AppState.selectedItem);
        updateDetailHero(AppState.selectedItem);
    }
    await refreshPendingAfterLocalChange();
}



// ============================================
// SINCRONIZACIÓN CON DRIVE
// ============================================

/**
 * Sincroniza datos con Google Drive en segundo plano (con debounce)
 */
function syncToDrive() {
    if (!isAuthenticated() || !AppState.driveLoadOk) {
        return;
    }

    clearTimeout(syncToDriveTimeout);
    syncToDriveTimeout = setTimeout(() => {
        syncToDriveNow();
    }, 2000);
}

function buildDrivePayload() {
    return {
        movies: AppState.movies,
        shows: AppState.shows,
        lists: AppState.lists,
        deletedIds: AppState.deletedIds,
        deletedListIds: AppState.deletedListIds,
        lastModified: nowIso(),
    };
}

function bindSyncFlushListeners() {
    if (syncFlushBound) return;
    syncFlushBound = true;
    const flush = () => {
        if (!isAuthenticated() || !AppState.driveLoadOk) return;
        clearTimeout(syncToDriveTimeout);
        syncToDriveNow();
    };
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush();
    });
    window.addEventListener('pagehide', flush);
}

async function syncToDriveNow() {
    flushSaveLocalData();

    if (!AppState.driveLoadOk) {
        return;
    }

    if (!isAuthenticated()) {
        updateDriveStatus(false);
        setDriveGateVisible(true, 'Sesión de Drive caducada. Vuelve a conectar.');
        showToast('Sesión de Drive caducada. Vuelve a conectar.', 'error');
        return;
    }

    if (AppState.isSyncing) {
        AppState.syncDirty = true;
        return;
    }

    AppState.isSyncing = true;

    try {
        try {
            await ensureValidAccessToken({ interactive: false });
        } catch (_) { /* syncToDrive will fail below if needed */ }

        await saveUserData(buildDrivePayload());
        console.log('[App] Datos sincronizados con Drive');
    } catch (error) {
        console.error('[App] Error sincronizando con Drive:', error);
        if (!isAuthenticated()) {
            updateDriveStatus(false);
            setDriveGateVisible(true, 'Sesión de Drive caducada. Vuelve a conectar.');
            showToast('Sesión de Drive caducada. Vuelve a conectar.', 'error');
        }
    } finally {
        AppState.isSyncing = false;
        if (AppState.syncDirty) {
            AppState.syncDirty = false;
            syncToDriveNow();
        }
    }
}

/**
 * Carga / fusiona datos desde Google Drive
 */
async function loadFromDrive(options = {}) {
    const silent = Boolean(options.silent);
    if (!isAuthenticated()) {
        if (!silent) showToast('Primero conecta Google Drive', 'info');
        return;
    }

    if (!silent) showLoading(true);

    const localSnapshot = snapshotLibrary();

    try {
        try {
            await ensureValidAccessToken({ interactive: false });
        } catch (_) { /* continue; loadUserData will renew */ }

        const data = await loadUserData();
        const result = reconcileWithDriveData(data, localSnapshot);
        saveLocalData();
        AppState.driveLoadOk = true;
        if (result === 'local-upload' || result === 'merged') {
            await syncToDriveNow();
        }
        if (AppState.driveReady) {
            renderCurrentView();
        }
        updateDriveStatus(true);
        if (!silent) {
            if (result === 'local-upload') showToast('Local subido a Drive', 'success');
            else if (result === 'merged') showToast('Fusionado con Drive', 'success');
            else showToast('Datos sincronizados desde Drive', 'success');
        }
    } catch (error) {
        console.error('[App] Error cargando desde Drive:', error);
        AppState.driveLoadOk = false;
        if (!silent) showToast('Error al cargar datos desde Drive', 'error');
        throw error;
    } finally {
        if (!silent) showLoading(false);
    }
}

// ============================================
// NAVEGACIÓN
// ============================================

let chromeResizeTimer = null;
let pendingAnchorObserver = null;
let pendingAnchorScrollGeneration = 0;

function syncMobileChromeHeights() {
    const root = document.documentElement;
    const measure = (el, fallbackPx) => {
        if (!el) return fallbackPx;
        const hidden = el.classList.contains('hidden') || el.classList.contains('is-hidden');
        if (hidden) return fallbackPx;
        const parentHidden = el.closest('.tab-content.hidden, .hidden');
        if (parentHidden) return fallbackPx;
        const rect = el.getBoundingClientRect();
        return Math.round(rect.height) || el.offsetHeight || fallbackPx;
    };

    const subnavSeries = document.querySelector('#content-series .tvst-subnav');
    const subnavMovies = document.querySelector('#content-movies .tvst-subnav');
    const moviesVisible = !document.getElementById('content-movies')?.classList.contains('hidden');
    const seriesVisible = !document.getElementById('content-series')?.classList.contains('hidden');
    const activeSubnav = moviesVisible ? subnavMovies : (seriesVisible ? subnavSeries : (subnavSeries || subnavMovies));
    const profileTabs = document.querySelector('.tvst-profile-tabs');
    const bottomNav = document.querySelector('.tvst-bottom-nav');

    // Medir siempre (también en desktop) para evitar huecos sticky
    root.style.setProperty('--tvst-subnav-h', `${measure(activeSubnav, 48)}px`);
    root.style.setProperty('--tvst-profile-tabs-h', `${measure(profileTabs, 46)}px`);
    root.style.setProperty('--tvst-bottom-nav-h', `${measure(bottomNav, 56)}px`);
}

function scheduleSyncMobileChromeHeights() {
    requestAnimationFrame(() => {
        syncMobileChromeHeights();
        requestAnimationFrame(syncMobileChromeHeights);
    });
}

/**
 * Cambia entre pestañas
 * @param {string} tab - Nombre de la pestaña
 */
function switchTab(tab) {
    if (!document.getElementById('detail-modal')?.classList.contains('hidden')) {
        closeModal();
    }
    if (!document.getElementById('episode-modal')?.classList.contains('hidden')) {
        closeEpisodeModal();
    }
    if (!document.getElementById('person-modal')?.classList.contains('hidden')) {
        closePersonModal();
    }

    AppState.currentTab = tab;

    if (tab === 'series') {
        // Al entrar: historial oculto; la vista arranca en «Ver a continuación»
        AppState.timelineHistoryVisible['pending-list'] = 0;
        AppState.timelineHistoryVisible['upcoming'] = 4;
        window.__seenitHistoryLoadReady = false;
    }

    document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
    document.getElementById(`content-${tab}`)?.classList.remove('hidden');

    document.querySelectorAll('.tvst-bottom-nav-btn').forEach(btn => btn.classList.remove('is-active'));
    document.querySelector(`.tvst-bottom-nav-btn[data-tab="${tab}"]`)?.classList.add('is-active');

    Promise.resolve(renderCurrentView()).finally(() => {
        scheduleSyncMobileChromeHeights();
        if (tab === 'profile') {
            setScrollTop(0, 'auto');
        } else if (tab === 'series' && AppState.currentSubTab === 'pending-list') {
            resetPendingListScroll();
        }
    });
}

function switchSubTab(subTab) {
    AppState.currentSubTab = subTab;
    if (subTab === 'pending-list') {
        AppState.timelineHistoryVisible['pending-list'] = 0;
        window.__seenitHistoryLoadReady = false;
    } else {
        AppState.timelineHistoryVisible[subTab] = 4;
    }

    document.querySelectorAll('#content-series .tvst-subnav-tab').forEach(btn => btn.classList.remove('is-active'));
    document.getElementById(`series-subtab-${subTab}`)?.classList.add('is-active');

    document.querySelectorAll('#content-series .tvst-tab-panel').forEach(el => el.classList.add('hidden'));
    document.getElementById(`subtab-content-${subTab}`)?.classList.remove('hidden');

    Promise.resolve(renderCurrentView()).finally(() => {
        scheduleSyncMobileChromeHeights();
        if (subTab === 'upcoming') {
            setScrollTop(0, 'auto');
        } else if (subTab === 'pending-list') {
            resetPendingListScroll();
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
        scheduleSyncMobileChromeHeights();
        if (subTab === 'upcoming') {
            setScrollTop(0, 'auto');
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
        scheduleSyncMobileChromeHeights();
        setScrollTop(0, 'auto');
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
        return emptyState('film', 'No hay películas en esta categoría', {
            grid: true,
            subtitle: 'Busca títulos en Explorar y añádelos a tu lista.',
            actionLabel: 'Explorar',
            actionOnClick: "switchTab('explore')",
        });
    }

    return movies.map(movie => {
        const countdown = showCountdown ? formatMovieCountdown(movie.fecha_estreno) : '';
        const isCompleted = normalizeStatus(movie.estado) === 'completed';
        return `
        <article class="tvst-poster-cell" onclick="openDetail('movie', ${movie.id_tmdb})">
            ${movie.portada
                ? `<img src="${movie.portada}" alt="${escapeHtml(movie.titulo || '')}">`
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
    touchUpdatedAt(movie);
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

function getMoviesPendingBaseList() {
    return AppState.movies
        .filter(movie => normalizeStatus(movie.estado) !== 'completed')
        .filter(movie => isMovieReleased(movie))
        .sort((a, b) => (a.titulo || '').localeCompare(b.titulo || '', 'es', { sensitivity: 'base' }));
}

const FEATURED_PROVIDERS = [
    'Netflix',
    'Prime Video',
    'Disney+',
    'Max',
    'Movistar Plus+',
    'Apple TV',
    'SkyShowtime',
    'RTVE',
    'Atresplayer',
    'Filmin',
    'Rakuten',
];
const PROVIDER_OTHER = 'Otros';

function normalizeProviderName(raw) {
    const name = String(raw || '').trim();
    if (!name) return '';
    const lower = name.toLowerCase();

    if (/amazon|prime\s*video/.test(lower)) return 'Prime Video';
    if (/netflix/.test(lower)) return 'Netflix';
    if (/disney/.test(lower)) return 'Disney+';
    if (/\bhbo\b|hbo max|\bmax\b/.test(lower)) return 'Max';
    if (/movistar/.test(lower)) return 'Movistar Plus+';
    if (/apple\s*tv/.test(lower)) return 'Apple TV';
    if (/skyshowtime|sky showtime/.test(lower)) return 'SkyShowtime';
    if (/rtve/.test(lower)) return 'RTVE';
    if (/atresplayer|atresmedia|atres media/.test(lower)) return 'Atresplayer';
    if (/filmin/.test(lower)) return 'Filmin';
    if (/rakuten/.test(lower)) return 'Rakuten';

    return name;
}

function isFeaturedProvider(name) {
    return FEATURED_PROVIDERS.includes(name);
}

function getMovieProviderNames(movie) {
    return [...new Set((movie.watch_providers || [])
        .map(p => normalizeProviderName(p.provider_name))
        .filter(Boolean))];
}

function itemHasOtherProviders(item) {
    return getMovieProviderNames(item).some(name => !isFeaturedProvider(name));
}

function orderFilterChipValues(values, active) {
    const unique = [...new Set(values.filter(Boolean))];
    const rest = unique
        .filter(v => v !== active)
        .sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
    if (active && active !== 'all' && unique.includes(active)) {
        return [active, ...rest];
    }
    return rest;
}

function getPendingPlatformChipValues(pending) {
    const all = new Set(pending.flatMap(getMovieProviderNames));
    const featured = FEATURED_PROVIDERS.filter(name => all.has(name));
    const hasOtros = [...all].some(name => !isFeaturedProvider(name));
    const values = [...featured];
    if (hasOtros) values.push(PROVIDER_OTHER);
    return values;
}

function movieMatchesPendingFilters(movie) {
    const genre = AppState.moviesPendingGenreFilter;
    if (genre && genre !== 'all') {
        const genres = movie.generos || [];
        if (!genres.includes(genre)) return false;
    }

    const platform = AppState.moviesPendingPlatformFilter;
    if (platform && platform !== 'all') {
        if (platform === PROVIDER_OTHER) {
            if (!itemHasOtherProviders(movie)) return false;
        } else if (!getMovieProviderNames(movie).includes(platform)) {
            return false;
        }
    }

    const maxRuntime = AppState.moviesPendingMaxRuntime;
    if (maxRuntime != null) {
        const runtime = Number(movie.runtime);
        if (!(runtime > 0) || runtime > maxRuntime) return false;
    }

    return true;
}

function getMoviesPendingRuntimeBounds(pending) {
    const runtimes = pending.map(m => Number(m.runtime)).filter(n => n > 0);
    const dataMax = runtimes.length ? Math.max(...runtimes) : 180;
    const sliderMin = 60;
    const sliderMax = Math.max(sliderMin + 30, Math.ceil(dataMax / 15) * 15, 180);
    return { sliderMin, sliderMax };
}

function renderMoviesPendingFilters(pending) {
    const filtersEl = document.getElementById('movies-pending-filters');
    if (!filtersEl) return;

    // Migrar selección antigua (p.ej. "Amazon Prime Video") al canónico
    const rawPlatform = AppState.moviesPendingPlatformFilter || 'all';
    if (rawPlatform !== 'all' && rawPlatform !== PROVIDER_OTHER) {
        const normalized = normalizeProviderName(rawPlatform);
        AppState.moviesPendingPlatformFilter = isFeaturedProvider(normalized)
            ? normalized
            : (normalized ? PROVIDER_OTHER : 'all');
    }

    const genres = orderFilterChipValues(
        [...new Set(pending.flatMap(m => m.generos || []))].filter(Boolean),
        AppState.moviesPendingGenreFilter || 'all',
    );
    const platforms = orderFilterChipValues(
        getPendingPlatformChipValues(pending),
        AppState.moviesPendingPlatformFilter || 'all',
    );

    const { sliderMin, sliderMax } = getMoviesPendingRuntimeBounds(pending);
    const maxRuntime = AppState.moviesPendingMaxRuntime;
    const sliderValue = maxRuntime == null ? sliderMax : Math.min(sliderMax, Math.max(sliderMin, maxRuntime));
    const runtimeLabel = maxRuntime == null ? 'Sin límite' : `Hasta ${maxRuntime} min`;

    const genreActive = AppState.moviesPendingGenreFilter || 'all';
    const platformActive = AppState.moviesPendingPlatformFilter || 'all';
    const open = Boolean(AppState.moviesPendingFiltersOpen);
    const activeCount = [
        genreActive !== 'all',
        platformActive !== 'all',
        maxRuntime != null,
    ].filter(Boolean).length;

    const chip = (label, active, filterKey, value) => `
        <button type="button"
            class="tvst-filter-chip${active ? ' is-active' : ''}"
            data-filter-key="${escapeHtml(filterKey)}"
            data-filter-value="${escapeHtml(value)}">
            ${escapeHtml(label)}
        </button>
    `;

    filtersEl.className = `tvst-movies-filters${open ? ' is-open' : ''}`;
    filtersEl.innerHTML = `
        <button type="button" class="tvst-movies-filters-toggle" data-filter-toggle="1" aria-expanded="${open}">
            <span>Filtros${activeCount ? ` · ${activeCount}` : ''}</span>
            <svg class="tvst-movies-filters-chevron" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
        </button>
        <div class="tvst-movies-filters-panel${open ? '' : ' hidden'}" data-filter-panel="1">
            <div class="tvst-filter-row" aria-label="Género">
                <span class="tvst-filter-row-label">Género</span>
                <div class="tvst-filter-chips" data-filter-group="genre">
                    ${chip('Todas', genreActive === 'all', 'genre', 'all')}
                    ${genres.map(g => chip(g, genreActive === g, 'genre', g)).join('')}
                </div>
            </div>
            <div class="tvst-filter-row" aria-label="Plataforma">
                <span class="tvst-filter-row-label">Plataforma</span>
                <div class="tvst-filter-chips" data-filter-group="platform">
                    ${chip('Todas', platformActive === 'all', 'platform', 'all')}
                    ${platforms.map(p => chip(p, platformActive === p, 'platform', p)).join('')}
                </div>
            </div>
            <div class="tvst-filter-runtime">
                <div class="tvst-filter-runtime-head">
                    <span class="tvst-filter-row-label">Duración máx.</span>
                    <span class="tvst-filter-runtime-value" id="movies-pending-runtime-label">${escapeHtml(runtimeLabel)}</span>
                </div>
                <input
                    type="range"
                    class="tvst-filter-runtime-range"
                    id="movies-pending-runtime-range"
                    min="${sliderMin}"
                    max="${sliderMax}"
                    step="5"
                    value="${sliderValue}"
                    aria-label="Duración máxima en minutos"
                >
                <div class="tvst-filter-runtime-ends">
                    <span>${sliderMin} min</span>
                    <span>Sin límite</span>
                </div>
            </div>
        </div>
    `;

    const rangeEl = document.getElementById('movies-pending-runtime-range');
    if (rangeEl) {
        rangeEl.addEventListener('input', () => {
            setMoviesPendingMaxRuntime(rangeEl.value, { live: true });
        });
    }

    if (!filtersEl.dataset.chipBound) {
        filtersEl.dataset.chipBound = '1';
        filtersEl.addEventListener('click', (event) => {
            const toggle = event.target.closest('[data-filter-toggle]');
            if (toggle && filtersEl.contains(toggle)) {
                event.preventDefault();
                toggleMoviesPendingFilters();
                return;
            }
            const btn = event.target.closest('.tvst-filter-chip');
            if (!btn || !filtersEl.contains(btn)) return;
            const key = btn.dataset.filterKey;
            const value = btn.dataset.filterValue;
            if (key === 'genre') setMoviesPendingGenreFilter(value);
            else if (key === 'platform') setMoviesPendingPlatformFilter(value);
        });
    }
}

function toggleMoviesPendingFilters() {
    AppState.moviesPendingFiltersOpen = !AppState.moviesPendingFiltersOpen;
    const filtersEl = document.getElementById('movies-pending-filters');
    const panel = filtersEl?.querySelector('[data-filter-panel]');
    const toggle = filtersEl?.querySelector('[data-filter-toggle]');
    if (filtersEl && panel && toggle) {
        filtersEl.classList.toggle('is-open', AppState.moviesPendingFiltersOpen);
        panel.classList.toggle('hidden', !AppState.moviesPendingFiltersOpen);
        toggle.setAttribute('aria-expanded', String(AppState.moviesPendingFiltersOpen));
        return;
    }
    renderMoviesPendingList();
}

function setMoviesPendingGenreFilter(genre) {
    AppState.moviesPendingGenreFilter = genre || 'all';
    renderMoviesPendingList();
}

function setMoviesPendingPlatformFilter(platform) {
    AppState.moviesPendingPlatformFilter = platform || 'all';
    renderMoviesPendingList();
}

function setMoviesPendingMaxRuntime(rawValue, options = {}) {
    const pending = getMoviesPendingBaseList();
    const { sliderMin, sliderMax } = getMoviesPendingRuntimeBounds(pending);
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value >= sliderMax) {
        AppState.moviesPendingMaxRuntime = null;
    } else {
        AppState.moviesPendingMaxRuntime = Math.max(sliderMin, Math.round(value));
    }

    const labelEl = document.getElementById('movies-pending-runtime-label');
    if (labelEl) {
        labelEl.textContent = AppState.moviesPendingMaxRuntime == null
            ? 'Sin límite'
            : `Hasta ${AppState.moviesPendingMaxRuntime} min`;
    }

    // Actualizar contador del toggle sin recrear el slider
    const toggle = document.querySelector('#movies-pending-filters [data-filter-toggle] span');
    if (toggle) {
        const activeCount = [
            (AppState.moviesPendingGenreFilter || 'all') !== 'all',
            (AppState.moviesPendingPlatformFilter || 'all') !== 'all',
            AppState.moviesPendingMaxRuntime != null,
        ].filter(Boolean).length;
        toggle.textContent = activeCount ? `Filtros · ${activeCount}` : 'Filtros';
    }

    if (options.live) {
        applyMoviesPendingFilters();
        return;
    }
    renderMoviesPendingList();
}

function applyMoviesPendingFilters() {
    const container = document.getElementById('movies-pending-list-container');
    if (!container) return;

    const pending = getMoviesPendingBaseList();
    const filtered = pending.filter(movieMatchesPendingFilters);

    container.className = 'tvst-poster-grid';
    if (!pending.length) {
        container.innerHTML = emptyState(
            'film',
            'No hay películas pendientes',
            {
                subtitle: 'Añade películas desde Explorar.',
                actionLabel: 'Explorar',
                actionOnClick: "switchTab('explore')",
            },
        );
    } else if (!filtered.length) {
        container.innerHTML = emptyState('film', 'Ninguna película con estos filtros', {
            subtitle: 'Prueba a relajar género, plataforma o duración.',
        });
    } else {
        container.innerHTML = renderMoviePosterGrid(filtered, { showWatchToggle: true });
    }
}

async function ensureMovieFilterMeta(pending) {
    const missing = pending.filter(m => !Array.isArray(m.generos) || !m.generos.length || !(Number(m.runtime) > 0));
    if (!missing.length || typeof getMovieDetails !== 'function') return false;

    let changed = false;
    const batch = missing.slice(0, 12);
    await Promise.all(batch.map(async (movie) => {
        try {
            const details = await getMovieDetails(movie.id_tmdb);
            if (Array.isArray(details?.generos) && details.generos.length && !movie.generos?.length) {
                movie.generos = details.generos;
                changed = true;
            }
            if (Number(details?.runtime) > 0 && !(Number(movie.runtime) > 0)) {
                movie.runtime = Number(details.runtime);
                changed = true;
            }
            if (!Array.isArray(movie.generos)) movie.generos = [];
        } catch (error) {
            console.warn('[App] Meta filtro película:', movie.titulo, error);
            if (!Array.isArray(movie.generos)) movie.generos = [];
        }
    }));
    if (changed) saveLocalData();
    return changed;
}

function renderMoviesPendingList() {
    const container = document.getElementById('movies-pending-list-container');
    if (!container) return;

    const pending = getMoviesPendingBaseList();
    renderMoviesPendingFilters(pending);
    applyMoviesPendingFilters();

    // Hidratar géneros/runtime y plataformas en background
    if (!window.__seenitMoviesFilterMetaHydrating) {
        const needsMeta = pending.some(m => !Array.isArray(m.generos) || !m.generos.length || !(Number(m.runtime) > 0));
        const needsProviders = pending.some(m => !Array.isArray(m.watch_providers));
        if (needsMeta || needsProviders) {
            window.__seenitMoviesFilterMetaHydrating = true;
            void (async () => {
                try {
                    let shouldRerender = false;
                    if (needsMeta) {
                        shouldRerender = (await ensureMovieFilterMeta(pending)) || shouldRerender;
                    }
                    if (needsProviders) {
                        let guard = 0;
                        while (guard < 10 && AppState.movies.some(m => !Array.isArray(m.watch_providers))) {
                            const before = AppState.movies.filter(m => !Array.isArray(m.watch_providers)).length;
                            await ensureProvidersForLibrary('movie');
                            const after = AppState.movies.filter(m => !Array.isArray(m.watch_providers)).length;
                            shouldRerender = true;
                            if (after >= before) {
                                AppState.movies.forEach(m => {
                                    if (!Array.isArray(m.watch_providers)) m.watch_providers = [];
                                });
                                break;
                            }
                            guard += 1;
                        }
                    }
                    if (shouldRerender
                        && AppState.currentTab === 'movies'
                        && AppState.currentMoviesSubTab === 'pending-list') {
                        renderMoviesPendingList();
                    }
                } finally {
                    window.__seenitMoviesFilterMetaHydrating = false;
                }
            })();
        }
    }
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
            {
                subtitle: 'Cuando añadas películas pendientes con fecha, aparecerán aquí.',
                actionLabel: 'Explorar',
                actionOnClick: "switchTab('explore')",
            },
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

/** Serie en «continuar» si avanzó capítulos, tuvo boost, o el siguiente episodio se emitió hace ≤14 días. */
function isContinueBoostFresh(show) {
    return Boolean(show?.continueBoostAt && getDaysSinceWatchActivity(show.continueBoostAt) <= CONTINUE_BOOST_DAYS);
}

function isRecentlyAiredEpisode(episode) {
    if (!episode?.air_date) return false;
    const days = getDaysSinceAir(episode.air_date);
    return Number.isFinite(days) && days >= 0 && days <= CONTINUE_BOOST_DAYS;
}

function applyContinueBoost(show, reason = '') {
    if (!show || isContinueBoostFresh(show)) return false;
    show.continueBoostAt = nowIso();
    touchUpdatedAt(show);
    if (reason) console.log('[App] continueBoost:', show.titulo || show.id_tmdb, reason);
    return true;
}

function isShowInContinueSection(show, nextEpisode = null) {
    if (isContinueBoostFresh(show)) {
        return true;
    }
    if (isRecentlyAiredEpisode(nextEpisode)) {
        return true;
    }
    const lastActivity = getShowLastWatchActivity(show);
    if (!lastActivity) {
        const watched = show?.capitulos_vistos?.length || 0;
        return watched === 0;
    }
    return getDaysSinceWatchActivity(lastActivity) <= CONTINUE_BOOST_DAYS;
}

function bumpPendingHistoryAfterWatch() {
    if (AppState.currentTab !== 'series' || AppState.currentSubTab !== 'pending-list') return;
    // Mantener ancla en "Ver a continuación"; el episodio recién visto queda arriba en historial
    const current = AppState.timelineHistoryVisible['pending-list'] || 0;
    AppState.timelineHistoryVisible['pending-list'] = Math.max(current, 1);
}

function getEpisodeBadges(show, episode, allAiredEpisodes) {
    const badges = [];
    const isUnwatched = !isEpisodeConsumed(show, episode.id);
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
        rightSide = `<button type="button" class="tvst-check-btn" onclick="event.stopPropagation(); toggleEpisode(${show.id_tmdb}, '${escapeHtml(String(episode.id || ''))}')" aria-label="Marcar visto">✓</button>`;
    } else if (variant === 'history') {
        rightSide = `<span class="tvst-check-btn is-watched" aria-hidden="true">✓</span>`;
    } else if (airMeta) {
        const meta = typeof airMeta === 'object'
            ? airMeta
            : { text: airMeta, className: 'tvst-air-time' };
        rightSide = `<div class="tvst-row-meta">
            <span class="${escapeHtml(meta.className || 'tvst-air-time')}">${escapeHtml(meta.text || '')}</span>
            ${meta.sub ? `<span class="tvst-air-sub">${escapeHtml(meta.sub)}</span>` : ''}
        </div>`;
    }

    const epIdAttr = escapeHtml(String(episode.id || ''));
    return `
        <article class="tvst-episode-row${variant === 'history' ? ' is-history' : ''}${normalizeStatus(show.estado) === 'standby' ? ' is-standby' : ''}"
            data-show-id="${show.id_tmdb}"
            data-episode-id="${epIdAttr}"
            onclick="openEpisodeDetail(${show.id_tmdb}, '${epIdAttr}')"
            onkeydown="handleEpisodeRowKeydown(event, ${show.id_tmdb}, '${epIdAttr}')"
            role="button" tabindex="0">
            <div class="tvst-episode-poster">${poster}</div>
            <div class="tvst-episode-body">
                <a href="#" onclick="event.stopPropagation(); openDetail('tv', ${show.id_tmdb});return false;" class="tvst-show-pill">${escapeHtml(show.titulo || 'Sin título')} ›</a>
                <div class="tvst-episode-code-row">
                    <span class="tvst-episode-code">${escapeHtml(episodeCode)}</span>
                    ${remainingCount > 0 ? `<span class="tvst-remaining">+${remainingCount}</span>` : ''}
                </div>
                ${episode.name ? `<p class="tvst-episode-title">${escapeHtml(episode.name)}</p>` : ''}
                ${badges.length ? `<div class="tvst-badges">${badges.map(b => `<span class="${escapeHtml(b.className)}">${escapeHtml(b.label)}</span>`).join('')}</div>` : ''}
            </div>
            ${rightSide}
        </article>`;
}

function handleEpisodeRowKeydown(event, showId, episodeId) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openEpisodeDetail(showId, episodeId);
}

function getAppScrollEl() {
    return document.querySelector('.tvst-main');
}

function getScrollTop() {
    const el = getAppScrollEl();
    return el ? el.scrollTop : window.scrollY;
}

function setScrollTop(top, behavior = 'auto') {
    const el = getAppScrollEl();
    const scrollBehavior = behavior === 'smooth' ? 'smooth' : 'auto';
    if (el) {
        el.scrollTo({ top: Math.max(0, top), behavior: scrollBehavior });
    } else {
        window.scrollTo({ top: Math.max(0, top), behavior: scrollBehavior });
    }
}

function scrollByDelta(delta) {
    const el = getAppScrollEl();
    if (el) el.scrollBy(0, delta);
    else window.scrollBy(0, delta);
}

function scrollElementToStart(targetEl, behavior = 'auto') {
    const container = getAppScrollEl();
    if (!targetEl) return;
    if (container) {
        const top = targetEl.getBoundingClientRect().top
            - container.getBoundingClientRect().top
            + container.scrollTop;
        container.scrollTo({
            top: Math.max(0, top),
            behavior: behavior === 'smooth' ? 'smooth' : 'auto',
        });
    } else {
        targetEl.scrollIntoView({ behavior: behavior === 'smooth' ? 'smooth' : 'auto', block: 'start' });
    }
}

function scrollAnchorIntoView(anchorEl, stickyOffset, behavior = 'auto') {
    const container = getAppScrollEl();
    if (!anchorEl) return;
    const scrollBehavior = behavior === 'smooth' ? 'smooth' : 'auto';
    if (container) {
        const top = anchorEl.getBoundingClientRect().top
            - container.getBoundingClientRect().top
            + container.scrollTop
            - stickyOffset;
        container.scrollTo({ top: Math.max(0, top), behavior: scrollBehavior });
    } else {
        const top = anchorEl.getBoundingClientRect().top + window.scrollY - stickyOffset;
        window.scrollTo({ top: Math.max(0, top), behavior: scrollBehavior });
    }
}

function getTimelineStickyOffset() {
    const raw = getComputedStyle(document.documentElement)
        .getPropertyValue('--tvst-subnav-h')
        .trim();
    if (!raw) return 48;
    if (raw.endsWith('rem')) {
        const rem = parseFloat(raw);
        const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
        return (Number.isFinite(rem) ? rem : 3) * rootPx;
    }
    const px = parseFloat(raw);
    return Number.isFinite(px) ? px : 48;
}

function getPendingListContentAboveAnchor() {
    const list = document.getElementById('pending-list-container');
    const anchor = list?.querySelector('[data-timeline-anchor="pending-list"]');
    if (!list || !anchor) return 0;
    let above = 0;
    for (const child of list.children) {
        if (child === anchor) break;
        above += child.offsetHeight;
    }
    return above;
}

function clearTimelineAnchorTimers() {
    if (Array.isArray(window.__seenitAnchorTimers)) {
        window.__seenitAnchorTimers.forEach(id => clearTimeout(id));
    }
    window.__seenitAnchorTimers = [];
}

/**
 * Posiciona «Ver a continuación» bajo el subnav.
 * Mide el bloque encima del ancla y resta el offset sticky del subnav
 * para que el hint quede fuera del viewport hasta deslizar hacia arriba.
 */
function resetPendingListScroll() {
    clearTimelineAnchorTimers();
    if (pendingAnchorObserver) {
        pendingAnchorObserver.disconnect();
        pendingAnchorObserver = null;
    }
    window.__seenitHistoryLoadReady = false;
    pendingAnchorScrollGeneration += 1;
    const generation = pendingAnchorScrollGeneration;

    syncMobileChromeHeights();

    const apply = () => {
        if (generation !== pendingAnchorScrollGeneration) return;
        if (AppState.currentTab !== 'series' || AppState.currentSubTab !== 'pending-list') return;
        const above = getPendingListContentAboveAnchor();
        const stickyOffset = getTimelineStickyOffset();
        const top = Math.max(0, above - stickyOffset);
        setScrollTop(top, 'auto');
        window.__seenitLastScrollY = top;
    };

    apply();
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            apply();
            if (generation !== pendingAnchorScrollGeneration) return;
            window.__seenitHistoryLoadReady = true;
        });
    });
}

function anchorTimelineToNow(tabKey, behavior = 'auto') {
    const anchor = document.querySelector(`[data-timeline-anchor="${tabKey}"]`);
    if (!anchor) return;

    clearTimelineAnchorTimers();
    if (pendingAnchorObserver) {
        pendingAnchorObserver.disconnect();
        pendingAnchorObserver = null;
    }
    window.__seenitHistoryLoadReady = false;

    const generation = ++pendingAnchorScrollGeneration;

    const scroll = () => {
        if (AppState.currentTab !== 'series' || AppState.currentSubTab !== 'pending-list') return;
        if (generation !== pendingAnchorScrollGeneration) return;
        if (!document.querySelector(`[data-timeline-anchor="${tabKey}"]`)) return;
        syncMobileChromeHeights();
        const above = getPendingListContentAboveAnchor();
        const stickyOffset = getTimelineStickyOffset();
        const top = Math.max(0, above - stickyOffset);
        setScrollTop(top, behavior);
        window.__seenitLastScrollY = top;
    };

    scroll();
    requestAnimationFrame(() => {
        requestAnimationFrame(scroll);
    });
    window.__seenitAnchorTimers.push(setTimeout(() => {
        scroll();
        window.__seenitHistoryLoadReady = true;
        window.__seenitLastScrollY = getScrollTop();
    }, 100));
}

function attachPendingAnchorResizeObserver(tabKey, generation) {
    const container = document.getElementById('pending-list-container');
    if (!container || typeof ResizeObserver === 'undefined') return;

    let lastHeight = container.offsetHeight;
    let resizeScrollDone = false;

    pendingAnchorObserver = new ResizeObserver(() => {
        if (generation !== pendingAnchorScrollGeneration) {
            pendingAnchorObserver?.disconnect();
            pendingAnchorObserver = null;
            return;
        }
        if (AppState.currentTab !== 'series' || AppState.currentSubTab !== 'pending-list') return;
        const newHeight = container.offsetHeight;
        if (Math.abs(newHeight - lastHeight) < 2) return;
        lastHeight = newHeight;
        if (resizeScrollDone) return;
        resizeScrollDone = true;

        const el = document.querySelector(`[data-timeline-anchor="${tabKey}"]`);
        if (!el) return;
        const stickyOffset = getTimelineStickyOffset();
        scrollAnchorIntoView(el, stickyOffset, 'auto');
        window.__seenitHistoryLoadReady = true;
        window.__seenitLastScrollY = getScrollTop();
        pendingAnchorObserver?.disconnect();
        pendingAnchorObserver = null;
    });

    pendingAnchorObserver.observe(container);
}

function scrollToNowAnchor() {
    if (AppState.currentTab === 'series' && AppState.currentSubTab === 'upcoming') {
        const upcoming = document.getElementById('upcoming-list-container');
        if (upcoming) scrollElementToStart(upcoming, 'smooth');
        return;
    }
    window.__seenitHistoryLoadReady = false;
    anchorTimelineToNow('pending-list', 'smooth');
}

function handleTimelineScroll() {
    if (AppState.currentTab !== 'series' || AppState.currentSubTab !== 'pending-list') return;
    if (!window.__seenitHistoryLoadReady) return;

    const y = getScrollTop();
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
    const step = currentCount === 0 ? Math.min(10, cache.length) : 8;
    AppState.timelineHistoryVisible[tabKey] = Math.min(currentCount + step, cache.length);

    try {
        paintPendingTimeline({ preserveAnchor: true, anchorOffset });
    } finally {
        window.__seenitLoadingMoreHistory = false;
    }
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
    const scrollEl = getAppScrollEl();
    const target = scrollEl || window;
    target.addEventListener('scroll', handleTimelineScroll, { passive: true });
    window.__seenitTimelineListenerAttached = true;
}

function preserveAnchorAfterHistoryLoad(tabKey, previousOffset) {
    const anchor = document.querySelector(`[data-timeline-anchor="${tabKey}"]`);
    if (!anchor || previousOffset === undefined) return;
    const newOffset = anchor.getBoundingClientRect().top;
    const delta = newOffset - previousOffset;
    if (Math.abs(delta) > 1) {
        scrollByDelta(delta);
    }
}

function sortPendingEntries(a, b) {
    const titleCompare = (a.show.titulo || '').localeCompare(b.show.titulo || '', 'es', { sensitivity: 'base' });
    if (titleCompare !== 0) return titleCompare;
    return (a.episode.air_date || '9999-12-31').localeCompare(b.episode.air_date || '9999-12-31');
}

function sortHistoryEntries(a, b) {
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
    return (a.episode.seasonNumber || 0) - (b.episode.seasonNumber || 0)
        || (a.episode.episodeNumber || 0) - (b.episode.episodeNumber || 0);
}

function paintPendingTimeline(options = {}) {
    const container = document.getElementById('pending-list-container');
    if (!container) return;

    const pendingEpisodes = [
        ...(AppState.timelinePendingCache.continueWatching || []),
        ...(AppState.timelinePendingCache.staleWatching || []),
    ];
    const historyEpisodes = AppState.timelineHistoryCache['pending-list'] || [];
    const continueWatching = AppState.timelinePendingCache.continueWatching || [];
    const staleWatching = AppState.timelinePendingCache.staleWatching || [];

    // Historial solo al hacer scroll hacia arriba; al entrar visible = 0 → «Ver a continuación»
    const historyVisibleCount = Math.min(
        AppState.timelineHistoryVisible['pending-list'] || 0,
        historyEpisodes.length,
    );
    AppState.timelineHistoryVisible['pending-list'] = historyVisibleCount;
    const visibleHistory = historyVisibleCount > 0
        ? historyEpisodes.slice(-historyVisibleCount)
        : [];
    const hasMoreHistory = historyEpisodes.length > historyVisibleCount;

    if (pendingEpisodes.length === 0 && historyEpisodes.length === 0) {
        if (options.loadingHistory) {
            container.innerHTML = emptyState('episodes', 'Cargando episodios...', { loading: true });
            return;
        }
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

    const historyBlock = visibleHistory.length
        ? `
            ${hasMoreHistory ? `
                <div id="pending-history-sentinel" class="tvst-history-sentinel" aria-hidden="true">
                    <span class="tvst-history-pull-label">Cargar más historial</span>
                </div>
            ` : ''}
            ${visibleHistory.map(({ show, episode, airedEpisodes }) => createEpisodeCardMarkup({
                show, episode, variant: 'history', allAiredEpisodes: airedEpisodes || [], showAction: false,
            })).join('')}
        `
        : `
            <div class="tvst-history-pull is-empty" aria-hidden="true">
                ${hasMoreHistory ? '<span class="tvst-history-pull-label">Desliza hacia arriba para el historial</span>' : ''}
            </div>
        `;

    container.className = 'tvst-episode-list';
    container.innerHTML = `
        ${historyBlock}
        <div data-timeline-anchor="pending-list" class="tvst-timeline-marker">Ver a continuación</div>
        ${continueWatching.length
            ? renderPendingCards(continueWatching)
            : emptyState('episodes', options.loadingPending ? 'Cargando pendientes...' : 'No hay episodios recientes por ver')}
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
    } else if (!options.skipAnchor) {
        resetPendingListScroll();
    }
}

async function buildWatchingPendingEntries(watchingShows) {
    const results = await mapPool(watchingShows, TIMELINE_FETCH_CONCURRENCY, async (show) => {
        // Boost / reopen: forzar meta e invalidar caché de temporadas (puede estar vacía/vieja)
        if (isContinueBoostFresh(show)) {
            await ensureShowSeasonMeta(show, { force: true });
            invalidateOrderedEpisodesCache(show.id_tmdb);
        } else {
            await ensureShowSeasonMeta(show);
        }

        const watchedSeasons = getWatchedSeasonNumbers(show);
        const upcomingSeasons = getUpcomingSeasonNumbers(show);
        const latestSeason = getLatestRegularSeasonNumber(show);
        const seasonHint = [...new Set([
            ...watchedSeasons.slice(-2),
            ...upcomingSeasons,
            ...(latestSeason != null ? [latestSeason] : []),
            1,
        ])];

        let episodes = await getOrderedEpisodes(show, {
            includeSpecials: false,
            seasonNumbers: seasonHint,
        });
        let airedEpisodes = episodes.filter(isEpisodeAired);
        let nextEpisode = airedEpisodes.find(ep => !isEpisodeConsumed(show, ep.id));

        // Si no hay siguiente en el recorte, cargar todas las temporadas
        if (!nextEpisode) {
            episodes = await getOrderedEpisodes(show, { includeSpecials: false });
            airedEpisodes = episodes.filter(isEpisodeAired);
            nextEpisode = airedEpisodes.find(ep => !isEpisodeConsumed(show, ep.id));
        }

        // Sin pendiente: forzar meta + invalidar caché TMDB y reintentar (caso Futurama / season nueva)
        if (!nextEpisode) {
            await ensureShowSeasonMeta(show, { force: true });
            invalidateOrderedEpisodesCache(show.id_tmdb);
            const latest = getLatestRegularSeasonNumber(show);
            const retryHint = [...new Set([
                ...watchedSeasons.slice(-2),
                ...getUpcomingSeasonNumbers(show),
                ...(latest != null ? [latest] : []),
            ])];
            episodes = await getOrderedEpisodes(show, {
                includeSpecials: false,
                seasonNumbers: retryHint.length ? retryHint : undefined,
            });
            airedEpisodes = episodes.filter(isEpisodeAired);
            nextEpisode = airedEpisodes.find(ep => !isEpisodeConsumed(show, ep.id));
            if (!nextEpisode) {
                episodes = await getOrderedEpisodes(show, { includeSpecials: false });
                airedEpisodes = episodes.filter(isEpisodeAired);
                nextEpisode = airedEpisodes.find(ep => !isEpisodeConsumed(show, ep.id));
            }
        }

        if (!nextEpisode) return null;

        // remainingCount desde el set ya cargado (sin segundo full solo para el badge)
        const remainingCount = Math.max(
            0,
            airedEpisodes.filter(ep => !isEpisodeConsumed(show, ep.id)).length - 1,
        );
        return {
            show,
            episode: nextEpisode,
            airedEpisodes,
            remainingCount,
        };
    });

    return results.filter(Boolean);
}

async function buildHistoryEntries(shows) {
    const withWatched = shows.filter(show => (show.capitulos_vistos || []).length > 0);
    await mapPool(withWatched, TIMELINE_FETCH_CONCURRENCY, ensureShowSeasonMeta);

    const chunks = await mapPool(withWatched, TIMELINE_FETCH_CONCURRENCY, async (show) => {
        const seasonNumbers = getWatchedSeasonNumbers(show);
        if (!seasonNumbers.length) return [];
        const episodes = await getOrderedEpisodes(show, {
            includeSpecials: false,
            seasonNumbers,
        });
        const airedEpisodes = episodes.filter(isEpisodeAired);
        const watchedSet = new Set(show.capitulos_vistos || []);
        return airedEpisodes
            .filter(ep => watchedSet.has(ep.id))
            .map(episode => ({ show, episode, airedEpisodes }));
    });

    return chunks.flat();
}

/**
 * Renderiza la lista pendiente (rápido: watching primero, historial después)
 */
async function renderPendingList(options = {}) {
    const container = document.getElementById('pending-list-container');
    if (!container) return;

    // No reutilizar caché de pendiente: hay que reclasificar continue/stale y reopen completed
    if (options.preserveAnchor && AppState.timelinePendingCache?.continueWatching) {
        paintPendingTimeline(options);
        return;
    }

    const allTvShows = AppState.shows;
    const watchingShows = allTvShows.filter(show => normalizeStatus(show.estado) === 'watching');

    if (watchingShows.length === 0 && allTvShows.length === 0) {
        container.innerHTML = emptyState(
            'spark',
            'Tu lista está vacía',
            {
                subtitle: 'Añade series desde Explorar (quedan en Pendiente). Al marcar un episodio pasan a «Viendo» y aparecen aquí.',
                actionLabel: 'Explorar',
                actionOnClick: "switchTab('explore')",
            },
        );
        return;
    }

    const softRefresh = Boolean(options.softRefresh);
    // Soft: no vaciar la lista con spinner (marcar visto / saltar desde pendiente)
    if (!softRefresh) {
        container.innerHTML = emptyState('episodes', 'Cargando episodios...', { loading: true });
    }

    await rebuildPendingTimeline(allTvShows, watchingShows, softRefresh
        ? { resetScroll: false, skipCompletedReopen: true }
        : { showLoading: false });
}

/** Tras marcar/saltar episodio: refresco suave si ya estás en Lista pendiente. */
async function refreshPendingAfterLocalChange() {
    if (AppState.currentTab === 'series' && AppState.currentSubTab === 'pending-list') {
        await renderPendingList({ softRefresh: true });
        return;
    }
    await renderCurrentView();
}

async function rebuildPendingTimeline(allTvShows, watchingShows, options = {}) {
    // Pintar primero con watching actual; reopen completed va en background
    const watchingNow = AppState.shows.filter(s => normalizeStatus(s.estado) === 'watching');
    const pendingEpisodes = await buildWatchingPendingEntries(watchingNow);
    let boostDirty = false;
    for (const entry of pendingEpisodes) {
        if (isRecentlyAiredEpisode(entry.episode) && applyContinueBoost(entry.show, 'episodio reciente')) {
            boostDirty = true;
        }
    }
    if (boostDirty) {
        saveLocalData();
        syncToDrive();
    }

    const continueWatching = pendingEpisodes
        .filter(({ show, episode }) => isShowInContinueSection(show, episode))
        .sort(sortPendingEntries);
    const staleWatching = pendingEpisodes
        .filter(({ show, episode }) => !isShowInContinueSection(show, episode))
        .sort(sortPendingEntries);

    AppState.timelinePendingCache = {
        continueWatching,
        staleWatching,
        builtAt: Date.now(),
    };
    if (options.resetScroll !== false) {
        AppState.timelineHistoryVisible['pending-list'] = 0;
    }

    const anchorEl = document.querySelector('[data-timeline-anchor="pending-list"]');
    const preserveScroll = options.resetScroll === false;
    paintPendingTimeline({
        skipAnchor: true,
        preserveAnchor: preserveScroll,
        anchorOffset: preserveScroll ? anchorEl?.getBoundingClientRect().top : undefined,
    });
    if (!preserveScroll) {
        resetPendingListScroll();
    }

    // Historial en segundo plano (no bloquea la vista)
    void buildHistoryEntries(AppState.shows).then((historyEpisodes) => {
        AppState.timelineHistoryCache['pending-list'] = historyEpisodes.sort(sortHistoryEntries);
        if (AppState.currentTab === 'series' && AppState.currentSubTab === 'pending-list') {
            const anchorEl = document.querySelector('[data-timeline-anchor="pending-list"]');
            paintPendingTimeline({
                preserveAnchor: true,
                anchorOffset: anchorEl?.getBoundingClientRect().top,
                skipAnchor: true,
            });
        }
    }).catch((error) => {
        console.warn('[App] Historial pendiente en background:', error);
    });

    // Status post-paint solo para shows que lo necesitan (no toda la biblioteca watching)
    const statusTargets = watchingNow.filter(show =>
        isContinueBoostFresh(show)
        || show.episodios_emitidos == null
        || isShowMetaStale(show),
    );
    if (statusTargets.length) {
        mapPool(statusTargets, TIMELINE_FETCH_CONCURRENCY, refreshShowStatus).then(() => {
            saveLocalData();
        }).catch(() => {});
    }

    if (!options.skipCompletedReopen) {
        void (async () => {
            try {
                const reopen = await refreshCompletedShowsForNewSeasons();
                if (reopen?.skipped) return;
                if (!reopen?.changed) return;
                saveLocalData();
                syncToDrive();
                for (const show of reopen.reopened || []) {
                    showToast(`Nueva temporada: ${show.titulo || 'Serie'}`, 'info');
                }
                if (reopen.reopened?.length) {
                    invalidateTimelineCaches();
                    if (AppState.currentTab === 'series' && AppState.currentSubTab === 'pending-list') {
                        await rebuildPendingTimeline(
                            AppState.shows,
                            AppState.shows.filter(s => normalizeStatus(s.estado) === 'watching'),
                            { resetScroll: false, skipCompletedReopen: true },
                        );
                    }
                }
            } catch (error) {
                console.warn('[App] Refresco completed en background (pendiente):', error);
            }
        })();
    }
}

async function refreshPendingListInBackground(allTvShows, watchingShows) {
    try {
        await rebuildPendingTimeline(allTvShows, watchingShows, { resetScroll: false });
    } catch (error) {
        console.warn('[App] Refresco pendiente en background:', error);
    }
}

/**
 * Renderiza la lista de próximos episodios
 */
async function renderUpcomingList(options = {}) {
    const container = document.getElementById('upcoming-list-container');
    if (!container) return;

    const applyReopenResult = (result) => {
        if (result?.skipped) return false;
        if (!result?.changed) return false;
        saveLocalData();
        syncToDrive();
        for (const show of result.reopened || []) {
            showToast(`Nueva temporada: ${show.titulo || 'Serie'}`, 'info');
        }
        if (result.reopened?.length) {
            invalidateTimelineCaches();
            return true;
        }
        return false;
    };

    // Reopen en background: no bloquea el paint de Próximamente
    const reopenPromise = refreshCompletedShowsForNewSeasons()
        .then(applyReopenResult)
        .catch((error) => {
            console.warn('[App] Refresco completed en próximos:', error);
            return false;
        });

    const upcomingShows = AppState.shows.filter(show => normalizeStatus(show.estado) !== 'dropped');

    if (upcomingShows.length === 0) {
        container.innerHTML = emptyState(
            'spark',
            'Nada en próximamente',
            {
                subtitle: 'Añade series (excepto abandonadas) para ver estrenos de episodios.',
                actionLabel: 'Explorar',
                actionOnClick: "switchTab('explore')",
            },
        );
        void reopenPromise;
        return;
    }

    const cacheFresh = !options.forceRefresh
        && AppState.timelineUpcomingCache?.builtAt
        && (Date.now() - AppState.timelineUpcomingCache.builtAt) < TIMELINE_CACHE_FRESH_MS
        && AppState.timelineUpcomingCache.html;

    if (cacheFresh) {
        container.className = 'tvst-episode-list';
        container.innerHTML = AppState.timelineUpcomingCache.html;
        requestAnimationFrame(() => setScrollTop(0, 'auto'));
        void (async () => {
            await reopenPromise;
            const shows = AppState.shows.filter(show => normalizeStatus(show.estado) !== 'dropped');
            await rebuildUpcomingTimeline(shows, container);
        })().catch(() => {});
        return;
    }

    container.innerHTML = emptyState('calendar', 'Cargando próximos...', { loading: true });
    await rebuildUpcomingTimeline(upcomingShows, container);
    const didReopen = await reopenPromise;
    if (didReopen) {
        const shows = AppState.shows.filter(show => normalizeStatus(show.estado) !== 'dropped');
        await rebuildUpcomingTimeline(shows, container);
    }
}

async function rebuildUpcomingTimeline(upcomingShows, container) {
    const chunks = await mapPool(upcomingShows, UPCOMING_FETCH_CONCURRENCY, async (show) => {
        await ensureShowSeasonMeta(show);
        const seasonNumbers = getUpcomingSeasonNumbers(show);
        const regularCount = countRegularSeasons(show);
        let episodes = await getOrderedEpisodes(show, {
            includeSpecials: false,
            seasonNumbers: seasonNumbers.length ? seasonNumbers : undefined,
        });
        let future = episodes.filter(episode => {
            if (!episode.air_date) return false;
            const daysUntil = getDaysUntilAir(episode.air_date);
            return daysUntil != null && daysUntil >= 0;
        });

        // Solo re-escanear toda la serie si es corta; series largas confían en las 2 últimas
        if (!future.length && seasonNumbers.length && regularCount > 0 && regularCount <= 3) {
            episodes = await getOrderedEpisodes(show, { includeSpecials: false });
            future = episodes.filter(episode => {
                if (!episode.air_date) return false;
                const daysUntil = getDaysUntilAir(episode.air_date);
                return daysUntil != null && daysUntil >= 0;
            });
        }

        const airedEpisodes = episodes.filter(isEpisodeAired);
        return future.map(episode => ({ show, episode, airedEpisodes }));
    });

    const upcomingEpisodes = chunks.flat();
    upcomingEpisodes.sort((a, b) => (a.episode.air_date || '9999').localeCompare(b.episode.air_date || '9999'));

    if (upcomingEpisodes.length === 0) {
        const emptyHtml = emptyState(
            'calendar',
            'Sin episodios programados',
            { subtitle: 'No hay próximos estrenos de episodios en tus series.' },
        );
        container.innerHTML = emptyHtml;
        AppState.timelineUpcomingCache = { html: emptyHtml, builtAt: Date.now(), items: [] };
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
    const html = dayKeys.map(label => `
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
    container.innerHTML = html;
    AppState.timelineUpcomingCache = { html, builtAt: Date.now(), items: upcomingEpisodes };

    requestAnimationFrame(() => setScrollTop(0, 'auto'));
}

function invalidateTimelineCaches() {
    AppState.timelinePendingCache = { continueWatching: [], staleWatching: [], builtAt: 0 };
    AppState.timelineUpcomingCache = { html: '', builtAt: 0, items: [] };
}

async function prefetchTimelineSeasons() {
    const watching = AppState.shows.filter(s => normalizeStatus(s.estado) === 'watching');
    const completedStale = AppState.shows.filter(s =>
        normalizeStatus(s.estado) === 'completed' && isShowMetaStale(s)
    ).slice(0, 8);
    const upcoming = AppState.shows.filter(s => normalizeStatus(s.estado) !== 'dropped').slice(0, 12);
    const targets = [...new Map(
        [...watching, ...completedStale, ...upcoming].map(s => [s.id_tmdb, s]),
    ).values()];
    await mapPool(targets, TIMELINE_FETCH_CONCURRENCY, async (show) => {
        await ensureShowSeasonMeta(show);
        const seasons = [
            ...getWatchedSeasonNumbers(show).slice(-1),
            ...getUpcomingSeasonNumbers(show),
        ];
        if (!seasons.length) return;
        await getOrderedEpisodes(show, { includeSpecials: false, seasonNumbers: [...new Set(seasons)] });
    });

    // Tras prefetch, reabrir completadas si hay episodios nuevos (throttle compartido)
    const result = await refreshCompletedShowsForNewSeasons();
    if (result.skipped || !result.changed) return;
    saveLocalData();
    syncToDrive();
    for (const show of result.reopened || []) {
        showToast(`Nueva temporada: ${show.titulo || 'Serie'}`, 'info');
    }
    if (result.reopened?.length) {
        invalidateTimelineCaches();
        // Si el usuario ya está en Lista pendiente, repintar con watching actualizado
        if (AppState.currentTab === 'series' && AppState.currentSubTab === 'pending-list') {
            try {
                await rebuildPendingTimeline(
                    AppState.shows,
                    AppState.shows.filter(s => normalizeStatus(s.estado) === 'watching'),
                    { resetScroll: false, skipCompletedReopen: true },
                );
            } catch (error) {
                console.warn('[App] Repintado pendiente tras reopen:', error);
            }
        }
    }
}

/**
 * Renderiza la vista de perfil
 */
async function renderProfileView() {
    AppState.profileSeriesFilter = document.getElementById('profile-series-filter')?.value || AppState.profileSeriesFilter;
    AppState.profileMoviesFilter = document.getElementById('profile-movies-filter')?.value || AppState.profileMoviesFilter;
    AppState.profileSeriesSearch = document.getElementById('profile-series-search')?.value || '';
    AppState.profileMoviesSearch = document.getElementById('profile-movies-search')?.value || '';
    AppState.profileSeriesPlatform = document.getElementById('profile-series-platform')?.value || AppState.profileSeriesPlatform;
    AppState.profileMoviesPlatform = document.getElementById('profile-movies-platform')?.value || AppState.profileMoviesPlatform;

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

    populatePlatformFilters();

    paintProfileLibrary();
    void refreshProfileProgressInBackground();
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
    touchUpdatedAt(list);
    clearListTombstone(list.id);
    AppState.lists.push(list);
    saveLocalData();
    syncToDrive();
    return list;
}

function deleteList(listId) {
    AppState.lists = AppState.lists.filter(l => l.id !== listId);
    recordListTombstone(listId);
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
    touchUpdatedAt(list);
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
    touchUpdatedAt(list);
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
    touchUpdatedAt(list);
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
        const before = list.itemIds.length;
        list.itemIds = list.itemIds.filter(x => x !== id);
        if (Number(list.coverId) === id) {
            list.coverId = list.itemIds[0] || null;
        }
        if (list.itemIds.length !== before) {
            touchUpdatedAt(list);
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
            return `<p class="tvst-lists-empty">Aún no tienes listas de ${tipo === 'movie' ? 'películas' : 'series'}. Abre un título → menú ⋯ → Añadir a lista.</p>`;
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

    const collapsedLimit = window.matchMedia('(min-width: 768px)').matches ? 6 : 3;

    const renderFavs = (items, tipo, expandedKey, moreBtnId, railEl) => {
        const favs = items
            .filter(item => Boolean(item.favorito))
            .sort((a, b) => (a.titulo || '').localeCompare(b.titulo || '', 'es', { sensitivity: 'base' }));
        const moreBtn = document.getElementById(moreBtnId);
        const expanded = Boolean(AppState.profileExpanded[expandedKey]);

        if (!favs.length) {
            if (moreBtn) moreBtn.classList.add('hidden');
            railEl.classList.remove('is-expanded');
            return `<p class="tvst-lists-empty">Sin favoritos todavía. Abre un título → ★ o menú ⋯.</p>`;
        }

        if (moreBtn) {
            moreBtn.classList.toggle('hidden', favs.length <= collapsedLimit);
            moreBtn.textContent = expanded ? 'Mostrar menos' : 'Mostrar más';
        }
        railEl.classList.toggle('is-expanded', expanded);

        const visible = expanded ? favs : favs.slice(0, collapsedLimit);
        return visible.map(item => {
            const img = item.portada || item.poster;
            const score = Number(item.puntuacion) > 0 ? Number(item.puntuacion).toFixed(1) : null;
            return `
                <button type="button" class="tvst-fav-card" onclick="openDetail('${tipo}', ${item.id_tmdb})">
                    <div class="tvst-fav-card-poster">
                        ${img
                            ? `<img src="${img}" alt="${escapeHtml(item.titulo || '')}" loading="lazy">`
                            : `<div class="tvst-poster-fallback">${escapeHtml((item.titulo || '?').slice(0, 1))}</div>`}
                        ${score ? `<span class="tvst-fav-card-score">★ ${score}</span>` : ''}
                    </div>
                    <p class="tvst-fav-card-title">${escapeHtml(item.titulo || 'Sin título')}</p>
                </button>
            `;
        }).join('');
    };

    seriesEl.innerHTML = renderFavs(
        AppState.shows, 'tv', 'favoritesSeries', 'profile-series-fav-more', seriesEl,
    );
    moviesEl.innerHTML = renderFavs(
        AppState.movies, 'movie', 'favoritesMovies', 'profile-movies-fav-more', moviesEl,
    );
}

function toggleFavorite(tipo, id_tmdb) {
    const item = getLibraryItem(tipo, id_tmdb);
    if (!item) {
        showToast('Añade el título primero', 'info');
        return;
    }
    item.favorito = !Boolean(item.favorito);
    touchUpdatedAt(item);
    if (AppState.selectedItem?.id_tmdb === id_tmdb && AppState.selectedItem?.tipo === tipo) {
        AppState.selectedItem = { ...AppState.selectedItem, favorito: item.favorito, updatedAt: item.updatedAt };
        updateDetailHeroFavorite(AppState.selectedItem);
    }
    saveLocalData();
    syncToDrive();
    renderProfileFavorites();
    if (AppState.currentTab === 'profile') {
        renderProfileView();
    }
    showToast(item.favorito ? 'Añadido a favoritos' : 'Quitado de favoritos', item.favorito ? 'success' : 'info');
}

function toggleFavoriteFromHero(event) {
    event?.stopPropagation?.();
    if (!AppState.selectedItem) return;
    toggleFavorite(AppState.selectedItem.tipo, AppState.selectedItem.id_tmdb);
}

function toggleFavoriteFromCard(event, tipo, id_tmdb) {
    event?.stopPropagation?.();
    event?.preventDefault?.();
    toggleFavorite(tipo, id_tmdb);
}

function updateDetailHeroFavorite(item) {
    const favBtn = document.getElementById('modal-hero-fav');
    if (!favBtn) return;
    const inLibrary = Boolean(getLibraryItem(item.tipo, item.id_tmdb));
    favBtn.classList.toggle('hidden', !inLibrary);
    favBtn.classList.toggle('is-active', Boolean(item.favorito));
    favBtn.setAttribute('aria-pressed', item.favorito ? 'true' : 'false');
    favBtn.title = item.favorito ? 'Quitar de favoritos' : 'Añadir a favoritos';
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
    const sortSelect = document.getElementById('list-sort-select');

    if (titleEl) titleEl.textContent = list.name;
    if (!gridEl) return;

    if (sortSelect && sortSelect.value !== AppState.listSortMode) {
        sortSelect.value = AppState.listSortMode;
    }

    modal?.classList.toggle('is-cover-pick', Boolean(AppState.listCoverPickMode));
    hint?.classList.toggle('hidden', !AppState.listCoverPickMode);
    if (coverBtn) {
        coverBtn.textContent = AppState.listCoverPickMode ? 'Cancelar portada' : 'Cambiar portada';
    }

    const items = sortListItems(
        list.itemIds
            .map((id, index) => ({ item: getLibraryItem(list.tipo, id), addedIndex: index }))
            .filter(entry => entry.item),
        list.tipo,
        AppState.listSortMode,
    );

    if (!items.length) {
        gridEl.innerHTML = `<p class="tvst-lists-empty">Esta lista está vacía. Añade títulos desde el menú ⋯ del detalle.</p>`;
        return;
    }

    const coverId = Number(list.coverId) || null;

    gridEl.innerHTML = items.map(({ item }) => {
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

function sortListItems(entries, tipo, mode) {
    const sorted = [...entries];
    if (mode === 'name-asc') {
        sorted.sort((a, b) => (a.item.titulo || '').localeCompare(b.item.titulo || '', 'es', { sensitivity: 'base' }));
    } else if (mode === 'name-desc') {
        sorted.sort((a, b) => (b.item.titulo || '').localeCompare(a.item.titulo || '', 'es', { sensitivity: 'base' }));
    } else if (mode === 'progress') {
        sorted.sort((a, b) => {
            const pa = getListItemProgress(a.item, tipo).progress;
            const pb = getListItemProgress(b.item, tipo).progress;
            return pb - pa || (a.item.titulo || '').localeCompare(b.item.titulo || '', 'es', { sensitivity: 'base' });
        });
    } else {
        sorted.sort((a, b) => a.addedIndex - b.addedIndex);
    }
    return sorted;
}

function onListSortChange() {
    AppState.listSortMode = document.getElementById('list-sort-select')?.value || 'added';
    renderListModal();
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
    touchUpdatedAt(list);
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

/**
 * Exporta la lista abierta como JSON portable (solo lectura / compartir archivo).
 * No mezcla cuentas: es un fichero local descargable.
 */
function exportSelectedList() {
    const list = AppState.lists.find(l => l.id === AppState.selectedListId);
    if (!list) {
        showToast('Abre una lista primero', 'info');
        return;
    }

    const items = (list.itemIds || []).map((id) => {
        const item = getLibraryItem(list.tipo, id);
        if (!item) {
            return {
                id_tmdb: Number(id),
                tipo: list.tipo,
                missing: true,
            };
        }
        return {
            id_tmdb: item.id_tmdb,
            tipo: list.tipo,
            titulo: item.titulo || '',
            titulo_original: item.titulo_original || '',
            portada: item.portada || null,
            fecha_estreno: item.fecha_estreno || null,
            vote_average: item.vote_average ?? null,
            estado: item.estado || null,
            puntuacion: Number(item.puntuacion) > 0 ? Number(item.puntuacion) : 0,
            favorito: Boolean(item.favorito),
        };
    });

    const payload = {
        format: 'seenit-list-v1',
        exportedAt: new Date().toISOString(),
        list: {
            name: list.name,
            tipo: list.tipo,
            coverId: list.coverId || null,
            itemCount: items.length,
            items,
        },
    };

    const safeName = String(list.name || 'lista')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40) || 'lista';
    const date = new Date().toISOString().split('T')[0];
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `seenit_lista_${safeName}_${date}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Lista exportada', 'success');
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

    if (seriesEl) {
        let seriesMinutes = 0;
        for (const show of AppState.shows) {
            const watched = Array.isArray(show.capitulos_vistos) ? show.capitulos_vistos.length : 0;
            seriesMinutes += watched * getShowEpisodeRuntimeMinutes(show);
        }
        seriesEl.textContent = formatWatchDuration(seriesMinutes);
    }

    if (moviesEl) {
        let moviesMinutes = 0;
        for (const movie of AppState.movies) {
            if (normalizeStatus(movie.estado) !== 'completed') continue;
            const runtime = Number(movie.runtime);
            moviesMinutes += runtime > 0 ? runtime : 100;
        }
        moviesEl.textContent = formatWatchDuration(moviesMinutes);
    }
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
    const consumedCount = Number(show.episodios_consumidos_count);
    const progressBase = Number.isFinite(consumedCount) && consumedCount >= 0 && show.episodios_consumidos_count != null
        ? consumedCount
        : watchedCount;
    const progress = airedCount > 0 ? Math.min(100, Math.round((progressBase / airedCount) * 100)) : 0;
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

/**
 * Actualiza solo contadores de progreso (sin cambiar estado).
 */
async function refreshShowAiredCounts(show) {
    if (!show || show.tipo === 'movie') return false;
    // Skip si meta fresca y ya hay contadores (evita walk de todas las temporadas)
    if (
        !isShowMetaStale(show)
        && show.episodios_emitidos != null
        && Number(show.episodios_emitidos) >= 0
        && show.episodios_vistos_count != null
    ) {
        return false;
    }
    await ensureShowSeasonMeta(show);
    const episodes = await getOrderedEpisodes(show, { includeSpecials: false });
    const airedEpisodes = episodes.filter(isEpisodeAired);
    const watchedEpisodes = airedEpisodes.filter(ep => isEpisodeWatched(show, ep.id));
    const consumedEpisodes = airedEpisodes.filter(ep => isEpisodeConsumed(show, ep.id));
    const nextAired = airedEpisodes.length;
    const nextWatched = watchedEpisodes.length;
    const nextConsumed = consumedEpisodes.length;
    const changed = Number(show.episodios_emitidos || 0) !== nextAired
        || Number(show.episodios_vistos_count || 0) !== nextWatched
        || Number(show.episodios_consumidos_count || 0) !== nextConsumed;
    show.episodios_emitidos = nextAired;
    show.episodios_vistos_count = nextWatched;
    show.episodios_consumidos_count = nextConsumed;
    return changed;
}

/** Series con % coherente pero estado desfasado (p. ej. 100% y badge Pendiente). */
function needsProfileStatusReconcile(show) {
    if (!show || show.tipo === 'movie') return false;
    const st = normalizeStatus(show.estado);
    if (st === 'dropped' || st === 'standby') return false;

    const watchedLen = Array.isArray(show.capitulos_vistos) ? show.capitulos_vistos.length : 0;
    const skippedLen = Array.isArray(show.capitulos_saltados) ? show.capitulos_saltados.length : 0;
    if (st === 'pending' && (watchedLen > 0 || skippedLen > 0)) return true;

    const aired = Number(show.episodios_emitidos || 0);
    const consumed = show.episodios_consumidos_count != null
        ? Number(show.episodios_consumidos_count)
        : Number(show.episodios_vistos_count || 0);
    if (aired > 0 && consumed >= aired && st !== 'completed') return true;

    return false;
}

let profileProgressRefreshToken = 0;

async function refreshProfileProgressInBackground() {
    const token = ++profileProgressRefreshToken;
    const shows = AppState.shows.filter(show =>
        needsProfileStatusReconcile(show)
        || isShowMetaStale(show)
        || show.episodios_emitidos == null
        || show.episodios_vistos_count == null,
    );
    if (!shows.length) return;

    let changed = false;
    await mapPool(shows, 4, async (show) => {
        try {
            if (needsProfileStatusReconcile(show)) {
                const before = normalizeStatus(show.estado);
                const beforeAired = Number(show.episodios_emitidos || 0);
                const beforeWatched = Number(show.episodios_vistos_count || 0);
                const beforeConsumed = Number(show.episodios_consumidos_count || 0);
                await refreshShowStatus(show);
                if (
                    normalizeStatus(show.estado) !== before
                    || Number(show.episodios_emitidos || 0) !== beforeAired
                    || Number(show.episodios_vistos_count || 0) !== beforeWatched
                    || Number(show.episodios_consumidos_count || 0) !== beforeConsumed
                ) {
                    changed = true;
                    touchUpdatedAt(show);
                }
            } else if (await refreshShowAiredCounts(show)) {
                changed = true;
            }
        } catch (error) {
            console.warn('[App] Progress refresh falló para', show?.id_tmdb, error);
        }
    });

    if (token !== profileProgressRefreshToken) return;
    if (!changed) return;
    if (AppState.currentTab !== 'profile') return;

    saveLocalData();
    syncToDrive();
    // Re-pintar sin lanzar otro refresh en cascada
    paintProfileLibrary();
}

function paintProfileLibrary() {
    const seriesContainer = document.getElementById('profile-series-container');
    const moviesContainer = document.getElementById('profile-movies-container');
    if (!seriesContainer || !moviesContainer) return;

    const collapsedLimit = window.matchMedia('(min-width: 768px)').matches ? 6 : 3;

    const filteredSeries = AppState.shows
        .filter(show => filterProfileSeries(show))
        .filter(show => matchesProfileSearch(show, AppState.profileSeriesSearch))
        .filter(show => matchesProfilePlatform(show, AppState.profileSeriesPlatform))
        .sort((a, b) => (a.titulo || '').localeCompare(b.titulo || '', 'es', { sensitivity: 'base' }));
    const filteredMovies = AppState.movies
        .filter(movie => filterProfileMovies(movie))
        .filter(movie => matchesProfileSearch(movie, AppState.profileMoviesSearch))
        .filter(movie => matchesProfilePlatform(movie, AppState.profileMoviesPlatform))
        .sort((a, b) => (a.titulo || '').localeCompare(b.titulo || '', 'es', { sensitivity: 'base' }));

    const seriesExpanded = Boolean(AppState.profileExpanded.series);
    const moviesExpanded = Boolean(AppState.profileExpanded.movies);

    seriesContainer.className = `tvst-profile-rail${seriesExpanded ? ' is-expanded' : ''}`;
    moviesContainer.className = `tvst-profile-rail${moviesExpanded ? ' is-expanded' : ''}`;

    const seriesMoreBtn = document.getElementById('profile-series-more');
    const moviesMoreBtn = document.getElementById('profile-movies-more');
    if (seriesMoreBtn) {
        seriesMoreBtn.classList.toggle('hidden', filteredSeries.length <= collapsedLimit);
        seriesMoreBtn.textContent = seriesExpanded ? 'Mostrar menos' : 'Mostrar más';
    }
    if (moviesMoreBtn) {
        moviesMoreBtn.classList.toggle('hidden', filteredMovies.length <= collapsedLimit);
        moviesMoreBtn.textContent = moviesExpanded ? 'Mostrar menos' : 'Mostrar más';
    }

    seriesContainer.innerHTML = renderProfileCards(filteredSeries, 'tv');
    moviesContainer.innerHTML = renderProfileCards(filteredMovies, 'movie');
    renderProfileFavorites();
    renderProfileLists();
    renderWatchStats();
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

function matchesProfileSearch(item, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return true;
    return String(item.titulo || '').toLowerCase().includes(q);
}

function matchesProfilePlatform(item, platform) {
    if (!platform || platform === 'all') return true;
    const names = getMovieProviderNames(item);
    if (platform === PROVIDER_OTHER) {
        return names.some(name => !isFeaturedProvider(name));
    }
    return names.includes(platform);
}

function collectUniqueProviders(items) {
    const present = new Set();
    let hasOtros = false;
    for (const item of items || []) {
        for (const name of getMovieProviderNames(item)) {
            if (isFeaturedProvider(name)) present.add(name);
            else hasOtros = true;
        }
    }
    const list = FEATURED_PROVIDERS.filter(name => present.has(name));
    if (hasOtros) list.push(PROVIDER_OTHER);
    return list;
}

function populatePlatformSelect(selectId, items, selected) {
    const el = document.getElementById(selectId);
    if (!el) return;
    const providers = collectUniqueProviders(items);
    const current = selected || 'all';
    el.innerHTML = [
        '<option value="all">Todas las plataformas</option>',
        ...providers.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`),
    ].join('');
    el.value = providers.includes(current) || current === 'all' ? current : 'all';
}

function populatePlatformFilters() {
    // Migrar valores antiguos del perfil a canónicos
    if (AppState.profileSeriesPlatform && AppState.profileSeriesPlatform !== 'all' && AppState.profileSeriesPlatform !== PROVIDER_OTHER) {
        const n = normalizeProviderName(AppState.profileSeriesPlatform);
        AppState.profileSeriesPlatform = isFeaturedProvider(n) ? n : PROVIDER_OTHER;
    }
    if (AppState.profileMoviesPlatform && AppState.profileMoviesPlatform !== 'all' && AppState.profileMoviesPlatform !== PROVIDER_OTHER) {
        const n = normalizeProviderName(AppState.profileMoviesPlatform);
        AppState.profileMoviesPlatform = isFeaturedProvider(n) ? n : PROVIDER_OTHER;
    }
    populatePlatformSelect('profile-series-platform', AppState.shows, AppState.profileSeriesPlatform);
    populatePlatformSelect('profile-movies-platform', AppState.movies, AppState.profileMoviesPlatform);
    AppState.profileSeriesPlatform = document.getElementById('profile-series-platform')?.value || 'all';
    AppState.profileMoviesPlatform = document.getElementById('profile-movies-platform')?.value || 'all';
}

async function ensureProvidersForLibrary(tipo) {
    const items = tipo === 'movie' ? AppState.movies : AppState.shows;
    const missing = items.filter(item => !Array.isArray(item.watch_providers));
    if (!missing.length || typeof getWatchProviders !== 'function') return;

    const batch = missing.slice(0, 20);
    await Promise.all(batch.map(async (item) => {
        try {
            const providers = await getWatchProviders(tipo === 'movie' ? 'movie' : 'tv', item.id_tmdb);
            item.watch_providers = providers?.length ? providers : [];
        } catch (error) {
            console.warn('[App] No se pudieron cargar providers:', item.titulo, error);
            item.watch_providers = [];
        }
    }));
    saveLocalData();
}

async function onProfilePlatformChange(kind) {
    const selectId = kind === 'movies' ? 'profile-movies-platform' : 'profile-series-platform';
    const value = document.getElementById(selectId)?.value || 'all';
    if (kind === 'movies') {
        AppState.profileMoviesPlatform = value;
    } else {
        AppState.profileSeriesPlatform = value;
    }

    if (value !== 'all') {
        showLoading(true);
        try {
            await ensureProvidersForLibrary(kind === 'movies' ? 'movie' : 'tv');
            populatePlatformFilters();
            if (kind === 'movies') {
                const el = document.getElementById('profile-movies-platform');
                if (el) el.value = AppState.profileMoviesPlatform;
            } else {
                const el = document.getElementById('profile-series-platform');
                if (el) el.value = AppState.profileSeriesPlatform;
            }
        } finally {
            showLoading(false);
        }
    }
    await renderProfileView();
}

function renderProfileCards(items, type) {
    if (items.length === 0) {
        return emptyState(type === 'tv' ? 'episodes' : 'film', 'No hay contenido en esta categoría', {
            grid: true,
            subtitle: 'Busca títulos en Explorar y añádelos a tu biblioteca.',
            actionLabel: 'Explorar',
            actionOnClick: "switchTab('explore')",
        });
    }

    return items.map(item => {
        const personalRating = item.puntuacion && item.puntuacion > 0 ? Number(item.puntuacion) : null;
        const tmdbRating = item.vote_average !== undefined && item.vote_average !== null
            ? Number(item.vote_average)
            : null;
        const progressData = type === 'tv' ? getShowProgressInfo(item) : null;
        const statusBadge = getStatusBadge(item.estado);
        const isFav = Boolean(item.favorito);

        return `
        <div class="profile-card cursor-pointer flex flex-col${normalizeStatus(item.estado) === 'standby' ? ' is-standby' : ''}" onclick="openDetail('${type}', ${item.id_tmdb})">
            <div class="relative aspect-[2/3] bg-zinc-900 rounded overflow-hidden mb-2 w-full">
                ${item.portada ? `<img src="${item.portada}" alt="${escapeHtml(item.titulo || '')}" class="w-full h-full object-cover">` : '<div class="w-full h-full flex items-center justify-center text-2xl">🎬</div>'}
                ${tmdbRating !== null ? `<div class="tvst-poster-score is-tmdb">${tmdbRating.toFixed(1)}</div>` : ''}
                ${personalRating !== null ? `<div class="tvst-poster-score is-user">★ ${personalRating.toFixed(1)}</div>` : ''}
                <button type="button" class="tvst-card-fav${isFav ? ' is-active' : ''}" onclick="toggleFavoriteFromCard(event, '${type}', ${item.id_tmdb})" aria-label="Favorito" title="${isFav ? 'Quitar de favoritos' : 'Añadir a favoritos'}">★</button>
            </div>
            <h3 class="font-semibold text-xs truncate text-white">${escapeHtml(item.titulo || '')}</h3>
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
            ${personal > 0 ? `<button type="button" class="tvst-clear-rating" onclick="setPersonalRating(0)">Quitar nota</button>` : ''}
        </div>
    ` : `
        <p class="tvst-info-overview">Añádela a tu lista para puntuarla.</p>
    `;

    container.innerHTML = `
        <div class="tvst-info-section">
            <h3>Nota</h3>
            ${ratingControl}
            <p class="tvst-info-overview tvst-nota-tmdb">TMDB: ${escapeHtml(String(voteAverage))}/10</p>
        </div>
        ${renderCriticaSection(item, inLibrary)}
        <div class="tvst-info-section">
            <h3>Descripción</h3>
            <p class="tvst-info-overview">${escapeHtml(overview)}</p>
            ${item?.generos?.length ? `<p class="tvst-info-overview" style="margin-top:0.5rem">${escapeHtml(item.generos.slice(0, 4).join(' · '))}</p>` : ''}
        </div>
        ${providers.length ? `
            <div class="tvst-info-section">
                <h3>Dónde ver</h3>
                <div class="flex flex-wrap gap-2">
                    ${providers.map(provider => `
                        <span class="inline-flex items-center gap-2 rounded-full bg-zinc-900 px-3 py-1.5 text-sm">
                            ${provider.logo_path ? `<img src="${window.getImageUrl(provider.logo_path, 'w92')}" alt="" class="h-5 w-5 rounded-full object-cover">` : ''}
                            ${escapeHtml(provider.provider_name || '')}
                        </span>
                    `).join('')}
                </div>
            </div>
        ` : ''}
        <div class="tvst-info-section">
            <h3>Reparto</h3>
            <div class="tvst-cast-rail">
                ${cast.length ? cast.map(person => {
                    const pid = Number(person.id);
                    const clickable = Number.isFinite(pid) && pid > 0;
                    const attrs = clickable
                        ? `role="button" tabindex="0" onclick="openPersonDetail(${pid})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openPersonDetail(${pid})}"`
                        : '';
                    return `
                    <article class="tvst-cast-card${clickable ? ' is-clickable' : ''}" ${attrs}>
                        ${person.profile_path
                            ? `<img src="${person.profile_path}" alt="${escapeHtml(person.name || '')}" onerror="this.onerror=null;this.outerHTML='<div class=\\'tvst-cast-fallback\\'>🎭</div>'">`
                            : '<div class="tvst-cast-fallback">🎭</div>'}
                        <div class="min-w-0">
                            <p class="text-sm font-semibold truncate">${escapeHtml(person.name || '')}</p>
                            <p class="text-xs text-gray-500 truncate">${escapeHtml(person.character || 'Actor')}</p>
                        </div>
                    </article>`;
                }).join('') : '<p class="text-sm text-gray-500">No hay reparto disponible.</p>'}
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
                            ? `<img src="${rec.portada}" alt="${escapeHtml(rec.titulo || '')}">`
                            : '<div class="w-full aspect-[2/3] bg-zinc-900 flex items-center justify-center rounded">🎬</div>'}
                        <button type="button" onclick="event.stopPropagation(); addItem('${rec.tipo}', ${rec.id_tmdb});" class="tvst-add-btn">+</button>
                        <p class="text-xs mt-1 truncate">${escapeHtml(rec.titulo || '')}</p>
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

function renderCriticaSection(item, inLibrary) {
    if (!inLibrary) return '';

    const text = typeof item?.critica === 'string' ? item.critica : '';
    const trimmed = text.trim();
    const editing = Boolean(AppState.detailCriticaEditing);

    if (editing) {
        return `
            <div class="tvst-info-section tvst-critica-section">
                <h3>Crítica</h3>
                <textarea id="detail-critica-input" class="tvst-critica-input" rows="5" placeholder="Escribe tu crítica…">${escapeHtml(text)}</textarea>
                <button type="button" class="tvst-critica-save" onclick="saveItemCritica()">Guardar</button>
            </div>
        `;
    }

    if (trimmed) {
        return `
            <div class="tvst-info-section tvst-critica-section">
                <h3>Crítica</h3>
                <p class="tvst-critica-text">${escapeHtml(trimmed)}</p>
                <button type="button" class="tvst-critica-edit" onclick="startEditCritica()">Modificar crítica</button>
            </div>
        `;
    }

    return `
        <div class="tvst-info-section tvst-critica-section">
            <button type="button" class="tvst-critica-add" onclick="startEditCritica()">Añadir crítica</button>
        </div>
    `;
}

function startEditCritica() {
    const item = AppState.selectedItem;
    if (!item || !isItemAlreadyAdded(item.tipo, item.id_tmdb)) {
        showToast('Añádela a tu lista para escribir una crítica', 'info');
        return;
    }
    AppState.detailCriticaEditing = true;
    renderDetailInfo(AppState.selectedItem);
    requestAnimationFrame(() => {
        document.getElementById('detail-critica-input')?.focus();
    });
}

function updateCritica(type, id_tmdb, text) {
    const value = typeof text === 'string' ? text : '';
    if (type === 'movie') {
        const movie = AppState.movies.find(m => m.id_tmdb === id_tmdb);
        if (!movie) return;
        movie.critica = value;
        touchUpdatedAt(movie);
    } else {
        const show = AppState.shows.find(s => s.id_tmdb === id_tmdb);
        if (!show) return;
        show.critica = value;
        touchUpdatedAt(show);
    }
    saveLocalData();
    syncToDrive();
}

function saveItemCritica() {
    const item = AppState.selectedItem;
    if (!item) return;
    if (!isItemAlreadyAdded(item.tipo, item.id_tmdb)) {
        showToast('Añádela a tu lista para escribir una crítica', 'info');
        return;
    }
    const input = document.getElementById('detail-critica-input');
    const value = input ? input.value : '';
    updateCritica(item.tipo, item.id_tmdb, value);
    AppState.selectedItem = { ...item, critica: value };
    AppState.detailCriticaEditing = false;
    renderDetailInfo(AppState.selectedItem);
    showToast(value.trim() ? 'Crítica guardada' : 'Crítica eliminada', value.trim() ? 'success' : 'info');
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
    const hidden = document.getElementById('modal-rating-input');
    if (hidden) hidden.value = value;
    renderDetailInfo(AppState.selectedItem);
    showToast(value > 0 ? 'Nota actualizada' : 'Nota eliminada', value > 0 ? 'success' : 'info');
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
    // Sin fecha de emisión no cuenta como emitido (evita TBA en Lista pendiente)
    if (!episode?.air_date) {
        return false;
    }

    const releaseDate = new Date(`${episode.air_date}T00:00:00`);
    if (Number.isNaN(releaseDate.getTime())) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return releaseDate <= today;
}

async function mapPool(items, concurrency, mapper) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return [];
    const results = new Array(list.length);
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(concurrency, list.length) }, async () => {
        while (nextIndex < list.length) {
            const index = nextIndex++;
            results[index] = await mapper(list[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}

function isShowMetaStale(show) {
    if (!show?.metaCheckedAt) return true;
    const ms = Date.parse(show.metaCheckedAt);
    if (!Number.isFinite(ms)) return true;
    return (Date.now() - ms) > SHOW_META_TTL_MS;
}

function countRegularSeasons(show) {
    return (show?.temporadas || []).filter(season => !season.especial && season.numero !== 0).length;
}

/** episodio_count de la última temporada regular (0 si no hay meta). */
function getLatestRegularSeasonEpisodeCount(show) {
    const regular = (show?.temporadas || [])
        .filter(season => !season.especial && season.numero !== 0)
        .map(season => ({
            numero: Number(season.numero),
            episodio_count: Number(season.episodio_count) || 0,
        }))
        .filter(s => Number.isFinite(s.numero) && s.numero > 0)
        .sort((a, b) => a.numero - b.numero);
    if (!regular.length) return 0;
    return regular[regular.length - 1].episodio_count;
}

async function ensureShowSeasonMeta(show, options = {}) {
    if (!show) return show;

    const force = Boolean(options.force);
    const hasMeta = Boolean(
        show.temporadas?.length
        && show.status
        && show.status !== 'Unknown'
        && show.status !== 'unknown',
    );
    const stale = isShowMetaStale(show);

    if (hasMeta && !force && !stale) {
        return show;
    }

    try {
        const prevSeasons = countRegularSeasons(show);
        const prevLatestEpCount = getLatestRegularSeasonEpisodeCount(show);
        const fresh = typeof getTVShowMeta === 'function'
            ? await getTVShowMeta(show.id_tmdb, { force: force || stale })
            : await getTVDetails(show.id_tmdb);
        if (fresh?.temporadas?.length) show.temporadas = fresh.temporadas;
        if (fresh?.status) show.status = fresh.status;
        if (fresh?.numero_temporadas) show.numero_temporadas = fresh.numero_temporadas;
        show.metaCheckedAt = new Date().toISOString();

        const nextSeasons = countRegularSeasons(show);
        const nextLatestEpCount = getLatestRegularSeasonEpisodeCount(show);
        if (nextSeasons !== prevSeasons || nextLatestEpCount !== prevLatestEpCount) {
            invalidateOrderedEpisodesCache(show.id_tmdb);
        }
    } catch (error) {
        console.warn('[App] No se pudo cargar meta de temporadas:', show.titulo, error);
    }
    return show;
}

/**
 * Refresca series completadas: si TMDB trae temporada/episodios nuevos → watching.
 * Respeta TTL de meta; throttle por sesión para no martillar TMDB.
 * @returns {{ changed: boolean, reopened: Array, skipped?: boolean }}
 */
async function refreshCompletedShowsForNewSeasons(options = {}) {
    const forceRun = Boolean(options.force);
    const now = Date.now();
    if (
        !forceRun
        && AppState.lastCompletedReopenAt
        && (now - AppState.lastCompletedReopenAt) < COMPLETED_REOPEN_THROTTLE_MS
    ) {
        return { changed: false, reopened: [], skipped: true };
    }

    const completed = AppState.shows.filter(show => normalizeStatus(show.estado) === 'completed');
    if (!completed.length) {
        AppState.lastCompletedReopenAt = now;
        return { changed: false, reopened: [] };
    }

    const reopened = [];
    let changed = false;

    await mapPool(completed, TIMELINE_FETCH_CONCURRENCY, async (show) => {
        try {
            const beforeEstado = normalizeStatus(show.estado);
            const beforeMeta = show.metaCheckedAt || '';
            const beforeSeasons = countRegularSeasons(show);
            const beforeLatestEpCount = getLatestRegularSeasonEpisodeCount(show);

            // TTL 12h: sin force salvo meta ausente/stale (ensureShowSeasonMeta lo decide)
            await ensureShowSeasonMeta(show);

            const afterSeasons = countRegularSeasons(show);
            const afterLatestEpCount = getLatestRegularSeasonEpisodeCount(show);
            const seasonsGrew = afterSeasons > beforeSeasons;
            const episodeCountGrew = afterLatestEpCount > beforeLatestEpCount;

            // Invalidar episodios solo si la meta creció (no en cada visita)
            if (seasonsGrew || episodeCountGrew) {
                invalidateOrderedEpisodesCache(show.id_tmdb);
            }

            await refreshShowStatus(show);

            // Temporada nueva o más episodios anunciados (aunque aún no haya emitidos) → Viendo
            if (
                beforeEstado === 'completed'
                && (seasonsGrew || episodeCountGrew)
                && normalizeStatus(show.estado) === 'completed'
            ) {
                show.estado = 'watching';
            }

            const afterEstado = normalizeStatus(show.estado);
            if (beforeEstado === 'completed' && afterEstado === 'watching') {
                applyContinueBoost(show, 'reopen completed');
                invalidateOrderedEpisodesCache(show.id_tmdb);
                reopened.push(show);
                changed = true;
            }
            if (
                (show.metaCheckedAt || '') !== beforeMeta
                || afterSeasons !== beforeSeasons
                || afterLatestEpCount !== beforeLatestEpCount
                || afterEstado !== beforeEstado
            ) {
                changed = true;
            }
        } catch (error) {
            console.warn('[App] Reopen completed falló:', show?.titulo || show?.id_tmdb, error);
        }
    });

    AppState.lastCompletedReopenAt = Date.now();
    return { changed, reopened };
}

function parseEpisodeIdParts(episodeId) {
    const match = String(episodeId || '').match(/^S(\d+)E(\d+)$/i);
    if (!match) return null;
    return { season: Number(match[1]), episode: Number(match[2]) };
}

function getWatchedSeasonNumbers(show) {
    const seasons = new Set();
    for (const id of show?.capitulos_vistos || []) {
        const parts = parseEpisodeIdParts(id);
        if (parts) seasons.add(parts.season);
    }
    return [...seasons].sort((a, b) => a - b);
}

function getLatestRegularSeasonNumber(show) {
    const regular = (show?.temporadas || [])
        .filter(season => !season.especial && season.numero !== 0)
        .map(season => Number(season.numero))
        .filter(n => Number.isFinite(n) && n > 0)
        .sort((a, b) => a - b);
    return regular.length ? regular[regular.length - 1] : null;
}

function getUpcomingSeasonNumbers(show) {
    const regular = (show?.temporadas || [])
        .filter(season => !season.especial && season.numero !== 0)
        .map(season => Number(season.numero))
        .filter(n => Number.isFinite(n) && n > 0)
        .sort((a, b) => a - b);
    if (!regular.length) return [];
    return regular.slice(-2);
}

function invalidateOrderedEpisodesCache(tvId = null) {
    if (tvId == null) {
        orderedEpisodesCache.clear();
        orderedEpisodesInflight.clear();
        if (typeof clearSeasonDetailsCache === 'function') clearSeasonDetailsCache();
        return;
    }
    const prefix = `${tvId}:`;
    for (const key of [...orderedEpisodesCache.keys()]) {
        if (key.startsWith(prefix)) orderedEpisodesCache.delete(key);
    }
    for (const key of [...orderedEpisodesInflight.keys()]) {
        if (key.startsWith(prefix)) orderedEpisodesInflight.delete(key);
    }
    if (typeof clearSeasonDetailsCache === 'function') clearSeasonDetailsCache(tvId);
}

async function getOrderedEpisodes(show, options = {}) {
    const includeSpecials = options.includeSpecials !== false;
    const seasonNumbers = Array.isArray(options.seasonNumbers) && options.seasonNumbers.length
        ? [...new Set(options.seasonNumbers.map(Number).filter(n => Number.isFinite(n)))]
            .sort((a, b) => a - b)
        : null;
    const cacheKey = `${show.id_tmdb}:${includeSpecials ? 1 : 0}:${seasonNumbers ? seasonNumbers.join(',') : 'all'}`;

    if (orderedEpisodesCache.has(cacheKey)) {
        return orderedEpisodesCache.get(cacheKey);
    }
    if (orderedEpisodesInflight.has(cacheKey)) {
        return orderedEpisodesInflight.get(cacheKey);
    }

    const fetchPromise = (async () => {
        let seasons = (show.temporadas || []).filter(season => includeSpecials || !season.especial);
        if (seasonNumbers) {
            const wanted = new Set(seasonNumbers);
            seasons = seasons.filter(season => wanted.has(Number(season.numero)));
            if (!seasons.length) {
                seasons = seasonNumbers.map(numero => ({
                    numero,
                    especial: numero === 0,
                }));
            }
        }

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

            orderedEpisodesCache.set(cacheKey, allEpisodes);
            return allEpisodes;
        } catch (error) {
            console.error('[App] Error obteniendo episodios:', error);
            return [];
        } finally {
            orderedEpisodesInflight.delete(cacheKey);
        }
    })();

    orderedEpisodesInflight.set(cacheKey, fetchPromise);
    return fetchPromise;
}

async function refreshShowStatus(show) {
    if (!show) return show;

    const previousState = normalizeStatus(show.estado);

    if (show.tipo !== 'tv') {
        show.estado = previousState;
        return show;
    }

    await ensureShowSeasonMeta(show);

    const regularSeasons = (show.temporadas || []).filter(season => !season.especial && season.numero !== 0);
    if (regularSeasons.length === 0) {
        show.estado = previousState;
        return show;
    }

    const episodes = await getOrderedEpisodes(show, { includeSpecials: false });
    const airedEpisodes = episodes.filter(isEpisodeAired);
    const watchedEpisodes = airedEpisodes.filter(ep => isEpisodeWatched(show, ep.id));
    const consumedEpisodes = airedEpisodes.filter(ep => isEpisodeConsumed(show, ep.id));
    const hasFutureEpisodes = episodes.some(ep => {
        if (!ep.air_date) return false;
        const daysUntil = getDaysUntilAir(ep.air_date);
        return daysUntil != null && daysUntil >= 0;
    });

    show.episodios_emitidos = airedEpisodes.length;
    show.episodios_vistos_count = watchedEpisodes.length;
    show.episodios_consumidos_count = consumedEpisodes.length;

    if (previousState === 'dropped') {
        show.estado = 'dropped';
        return show;
    }

    if (airedEpisodes.length > 0 && consumedEpisodes.length === airedEpisodes.length) {
        // No marcar completed si hay boost, estrenos pendientes o temporada nueva aún abierta
        if (isContinueBoostFresh(show) || hasFutureEpisodes) {
            show.estado = previousState === 'standby' ? 'standby' : 'watching';
            return show;
        }
        const latestSeason = getLatestRegularSeasonNumber(show);
        if (latestSeason != null) {
            const latestMeta = regularSeasons.find(s => Number(s.numero) === latestSeason);
            const airedInLatest = airedEpisodes.filter(ep => ep.seasonNumber === latestSeason).length;
            const expected = Number(latestMeta?.episodio_count) || 0;
            if (expected > 0 && airedInLatest < expected) {
                show.estado = previousState === 'standby' ? 'standby' : 'watching';
                return show;
            }
            const consumedInLatest = airedEpisodes.filter(ep => ep.seasonNumber === latestSeason && isEpisodeConsumed(show, ep.id)).length;
            if (expected > 0 && consumedInLatest < expected) {
                show.estado = previousState === 'standby' ? 'standby' : 'watching';
                return show;
            }
        }
        show.estado = 'completed';
        return show;
    }

    if (previousState === 'standby') {
        show.estado = 'standby';
        return show;
    }

    if (watchedEpisodes.length > 0 || (show.capitulos_saltados || []).length > 0) {
        show.estado = 'watching';
        if (previousState === 'completed') {
            applyContinueBoost(show, 'nuevos episodios emitidos');
        }
    } else if (previousState === 'watching' || previousState === 'pending') {
        show.estado = previousState;
    } else {
        show.estado = 'pending';
    }

    return show;
}

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
                <h3 class="tvst-search-title">${escapeHtml(item.titulo || 'Sin título')}</h3>
                <div class="tvst-search-sub">
                    ${typeIcon(item.tipo)}
                    <span>${escapeHtml(formatPopularityLabel(popularitySource, item.tipo))}</span>
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
        const nextUnwatched = airedOrdered.filter(ep => !isEpisodeConsumed(show, ep.id)).slice(0, 2);

        const episodesBySeason = new Map();
        for (const ep of ordered) {
            const key = Number(ep.seasonNumber);
            if (!episodesBySeason.has(key)) episodesBySeason.set(key, []);
            episodesBySeason.get(key).push(ep);
        }

        let continueHTML = '';
        if (nextUnwatched.length) {
            continueHTML = `
                <div class="tvst-ep-section-title">Continuar el seguimiento</div>
                <div class="tvst-continue-cards">
                    ${nextUnwatched.map(ep => {
                        const still = ep.still_path ? getImageUrl(ep.still_path, 'w185') : null;
                        const watched = isEpisodeWatched(show, ep.id);
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
            const seasonEpisodes = episodesBySeason.get(Number(season.numero)) || [];
            const seasonId = `season-${season.numero}`;
            const seasonKey = `${show.id_tmdb}-season-${season.numero}`;
            const seasonLabel = getSeasonLabel(season);

            const seasonEpisodeIds = seasonEpisodes.filter(isEpisodeAired).map(ep => ep.id);
            const watchedInSeason = seasonEpisodeIds.filter(id => isEpisodeWatched(show, id)).length;
            const skippedInSeason = seasonEpisodeIds.filter(id => isEpisodeSkipped(show, id)).length;
            const consumedInSeason = seasonEpisodeIds.filter(id => isEpisodeConsumed(show, id)).length;
            const totalInSeason = seasonEpisodeIds.length;
            const allWatchedInSeason = watchedInSeason === totalInSeason && totalInSeason > 0;
            const allSkippedInSeason = skippedInSeason === totalInSeason && totalInSeason > 0;
            const allConsumedInSeason = consumedInSeason === totalInSeason && totalInSeason > 0;
            const pct = totalInSeason > 0 ? Math.round((consumedInSeason / totalInSeason) * 100) : 0;
            const isExpanded = AppState.expandedSeasons[seasonKey];
            const countLabel = skippedInSeason > 0
                ? `${watchedInSeason}✓ ${skippedInSeason}↷ / ${totalInSeason}`
                : `${watchedInSeason}/${totalInSeason}`;

            seasonsHTML += `
                <div class="tvst-season-block">
                    <div class="tvst-season-header" role="button" tabindex="0" onclick="toggleSeasonAccordion('${seasonId}', '${seasonKey}')">
                        <div class="tvst-season-header-row">
                            <div class="tvst-season-header-main">
                                <p class="tvst-season-name">${seasonLabel}</p>
                                <span class="tvst-season-chevron" id="chevron-${seasonId}">${isExpanded ? '▲' : '▼'}</span>
                            </div>
                            <span class="tvst-season-count">${countLabel}</span>
                            <button type="button"
                                class="tvst-skip-btn${allSkippedInSeason ? ' is-skipped' : ''}"
                                onclick="event.stopPropagation(); toggleSeasonSkipped(${show.id_tmdb}, ${season.numero})"
                                aria-label="${allSkippedInSeason ? 'Quitar salto de temporada' : 'Saltar temporada'}"
                                title="${allSkippedInSeason ? 'Quitar salto' : 'Saltar temporada'}">↷</button>
                            <button type="button"
                                class="tvst-circle-check${allWatchedInSeason ? ' is-watched' : ''}"
                                onclick="event.stopPropagation(); toggleSeasonWatched(${show.id_tmdb}, ${season.numero})"
                                aria-label="Marcar temporada">✓</button>
                        </div>
                        <div class="tvst-season-bar-track">
                            <div class="tvst-season-bar-fill${allConsumedInSeason ? ' is-complete' : ''}" style="width:${Math.max(0, Math.min(100, pct))}%"></div>
                        </div>
                    </div>
                    <div id="${seasonId}" class="${isExpanded ? '' : 'hidden'}">
                        ${seasonEpisodes.map(episode => {
                            const episodeId = episode.id;
                            const isWatched = isEpisodeWatched(show, episodeId);
                            const isSkipped = isEpisodeSkipped(show, episodeId);
                            const episodeImage = episode.still_path ? getImageUrl(episode.still_path, 'w185') : null;
                            const aired = isEpisodeAired(episode);
                            return `
                            <div class="tvst-ep-row${isSkipped ? ' is-skipped' : ''}" onclick="openEpisodeDetail(${show.id_tmdb}, '${episodeId}')" role="button" tabindex="0">
                                ${episodeImage
                                    ? `<img class="tvst-ep-still" src="${episodeImage}" alt="" onerror="this.style.visibility='hidden'">`
                                    : '<div class="tvst-ep-still"></div>'}
                                <div class="tvst-ep-text">
                                    <div class="tvst-ep-code">${formatEpisodeLabel(season.numero, episode.episodeNumber)}</div>
                                    <div class="tvst-ep-name">${episode.name || 'Episodio'}${isSkipped ? ' · Saltado' : ''}</div>
                                </div>
                                <button type="button"
                                    class="tvst-skip-btn${isSkipped ? ' is-skipped' : ''}"
                                    ${aired ? '' : 'disabled'}
                                    onclick="event.stopPropagation(); toggleEpisodeSkipped(${show.id_tmdb}, '${episodeId}')"
                                    aria-label="${isSkipped ? 'Quitar salto' : 'Saltar episodio'}"
                                    title="${isSkipped ? 'Quitar salto' : 'Saltar'}">↷</button>
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
    ensureSkippedList(show);

    const wasStandby = normalizeStatus(show.estado) === 'standby';
    const wasDropped = normalizeStatus(show.estado) === 'dropped';
    const wasPending = normalizeStatus(show.estado) === 'pending';
    const index = show.capitulos_vistos.indexOf(episode);
    let markedWatched = false;
    const newlyWatchedIds = [];
    if (index > -1) {
        show.capitulos_vistos.splice(index, 1);
        clearEpisodeWatchedRecord(show, episode);
    } else {
        const previousEpisodes = episodes.filter(isEpisodeAired).filter(ep => compareEpisodeOrder(ep, targetEpisode) < 0 && !isEpisodeConsumed(show, ep.id));
        if (shouldAskToMarkPreviousEpisodes(show, episodes, episode) && confirm('¿Quieres marcar también los episodios anteriores como vistos?')) {
            previousEpisodes.forEach(ep => {
                if (!show.capitulos_vistos.includes(ep.id)) {
                    show.capitulos_vistos.push(ep.id);
                    newlyWatchedIds.push(ep.id);
                }
                clearEpisodeSkipped(show, ep.id);
            });
        }
        show.capitulos_vistos.push(episode);
        newlyWatchedIds.push(episode);
        clearEpisodeSkipped(show, episode);
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
    if (wasPending && markedWatched) {
        show.estado = 'watching';
    }

    await refreshShowStatus(show);
    touchUpdatedAt(show);
    invalidateTimelineCaches();
    saveLocalData();
    syncToDrive();

    if (AppState.selectedItem?.tipo === 'tv' && AppState.selectedItem.id_tmdb === id_tmdb) {
        AppState.selectedItem = { ...show, tipo: 'tv' };
        await renderEpisodes(AppState.selectedItem);
        updateDetailHero(AppState.selectedItem);
    }
    await refreshPendingAfterLocalChange();
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
    const wasDropped = normalizeStatus(show.estado) === 'dropped';
    const wasPending = normalizeStatus(show.estado) === 'pending';
    const touchedIds = [];
    ensureSkippedList(show);

    episodeIds.forEach(episodeId => {
        const index = show.capitulos_vistos.indexOf(episodeId);
        if (watched) {
            if (index === -1) {
                show.capitulos_vistos.push(episodeId);
                touchedIds.push(episodeId);
            }
            clearEpisodeSkipped(show, episodeId);
        } else if (index > -1) {
            show.capitulos_vistos.splice(index, 1);
            clearEpisodeWatchedRecord(show, episodeId);
        }
    });

    if (watched && touchedIds.length) {
        recordEpisodesWatched(show, touchedIds);
        bumpPendingHistoryAfterWatch();
    }

    if ((wasStandby || wasDropped || wasPending) && watched && touchedIds.length) {
        show.estado = 'watching';
    }

    await refreshShowStatus(show);
    touchUpdatedAt(show);
    invalidateTimelineCaches();
    saveLocalData();
    syncToDrive();

    if (AppState.selectedItem?.tipo === 'tv' && AppState.selectedItem.id_tmdb === id_tmdb) {
        AppState.selectedItem = { ...show, tipo: 'tv' };
        await renderEpisodes(AppState.selectedItem);
        updateDetailHero(AppState.selectedItem);
    }
    await refreshPendingAfterLocalChange();
}

async function persistShowEpisodeChange(show) {
    await refreshShowStatus(show);
    touchUpdatedAt(show);
    invalidateTimelineCaches();
    saveLocalData();
    syncToDrive();
    if (AppState.selectedItem?.tipo === 'tv' && AppState.selectedItem.id_tmdb === show.id_tmdb) {
        AppState.selectedItem = { ...show, tipo: 'tv' };
        await renderEpisodes(AppState.selectedItem);
        updateDetailHero(AppState.selectedItem);
    }
    if (AppState.selectedEpisode?.showId === show.id_tmdb) {
        paintEpisodeModal();
    }
    await refreshPendingAfterLocalChange();
}

async function toggleEpisodeSkipped(id_tmdb, episodeId) {
    const show = AppState.shows.find(s => s.id_tmdb === id_tmdb);
    if (!show || !episodeId) return;

    const episodes = await getOrderedEpisodes(show, { includeSpecials: false });
    const target = episodes.find(ep => ep.id === episodeId);
    if (target && !isEpisodeAired(target)) {
        showToast('No puedes saltar episodios aún no emitidos', 'info');
        return;
    }

    ensureSkippedList(show);
    if (isEpisodeSkipped(show, episodeId)) {
        clearEpisodeSkipped(show, episodeId);
    } else {
        markEpisodeSkipped(show, episodeId);
        const wasStandby = normalizeStatus(show.estado) === 'standby';
        const wasDropped = normalizeStatus(show.estado) === 'dropped';
        const wasPending = normalizeStatus(show.estado) === 'pending';
        if (wasStandby || wasDropped || wasPending) {
            show.estado = 'watching';
        }
    }

    await persistShowEpisodeChange(show);
}

async function toggleSeasonSkipped(id_tmdb, seasonNumber) {
    const show = AppState.shows.find(s => s.id_tmdb === id_tmdb);
    if (!show) return;

    if (!show.capitulos_vistos) show.capitulos_vistos = [];
    ensureSkippedList(show);

    const seasonDetails = await getSeasonDetails(id_tmdb, seasonNumber);
    const episodeIds = (seasonDetails.episodes || [])
        .filter(isEpisodeAired)
        .map(ep => `S${String(seasonNumber).padStart(2, '0')}E${String(ep.episode_number).padStart(2, '0')}`);

    if (!episodeIds.length) {
        showToast('No hay episodios emitidos para saltar en esta temporada', 'info');
        return;
    }

    const allSkipped = episodeIds.every(id => isEpisodeSkipped(show, id));
    if (allSkipped) {
        episodeIds.forEach(id => clearEpisodeSkipped(show, id));
    } else {
        episodeIds.forEach(id => markEpisodeSkipped(show, id));
        const st = normalizeStatus(show.estado);
        if (st === 'standby' || st === 'dropped' || st === 'pending') {
            show.estado = 'watching';
        }
    }

    await persistShowEpisodeChange(show);
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
    if (!existingItem) {
        // No arrastrar puntuacion:0 por defecto de TMDB como nota personal
        return {
            ...freshDetails,
            puntuacion: Number(freshDetails?.puntuacion) > 0 ? Number(freshDetails.puntuacion) : 0,
            favorito: Boolean(freshDetails?.favorito),
            critica: typeof freshDetails?.critica === 'string' ? freshDetails.critica : '',
        };
    }
    const existingScore = Number(existingItem.puntuacion) || 0;
    const freshScore = Number(freshDetails?.puntuacion) || 0;
    return {
        ...existingItem,
        ...freshDetails,
        tipo: existingItem.tipo || freshDetails.tipo || 'tv',
        estado: existingItem.estado || freshDetails.estado || 'pending',
        puntuacion: Math.max(existingScore, freshScore),
        favorito: Boolean(existingItem.favorito || freshDetails?.favorito),
        critica: typeof existingItem.critica === 'string' ? existingItem.critica : '',
        capitulos_vistos: existingItem.capitulos_vistos || freshDetails.capitulos_vistos || [],
        capitulos_saltados: existingItem.capitulos_saltados || freshDetails.capitulos_saltados || [],
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
        { id: 'pending', label: 'Marcar como pendiente' },
        { id: 'standby', label: 'Ver en otro momento' },
        { id: 'remove', label: 'Eliminar', danger: true },
    ];

    const st = normalizeStatus(item.estado);
    if (st === 'pending') {
        actions.splice(actions.findIndex(a => a.id === 'pending'), 1);
    }
    if (st === 'standby') {
        actions.splice(actions.findIndex(a => a.id === 'standby'), 1);
    }

    if (item.tipo === 'movie') {
        if (st === 'completed') {
            actions.splice(3, 0, { id: 'movie-unwatch', label: 'Marcar como no vista' });
        } else {
            actions.splice(3, 0, { id: 'movie-watch', label: 'Marcar como vista' });
        }
    }

    if (item.tipo === 'tv' && watchedCount > 0) {
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

    if (action === 'pending') {
        await updateStatus(item.tipo, item.id_tmdb, 'pending');
        const updated = item.tipo === 'tv'
            ? AppState.shows.find(s => s.id_tmdb === item.id_tmdb)
            : AppState.movies.find(m => m.id_tmdb === item.id_tmdb);
        AppState.selectedItem = { ...(updated || item), tipo: item.tipo, estado: 'pending' };
        showToast('Marcada como pendiente', 'success');
        renderCurrentView();
        updateDetailHero(AppState.selectedItem);
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

function getHeroStatusInfo(item) {
    if (!item || !isItemAlreadyAdded(item.tipo, item.id_tmdb)) return null;
    const st = normalizeStatus(item.estado);
    const isMovie = item.tipo === 'movie';
    const labels = isMovie
        ? {
            pending: 'Pendiente',
            watching: 'Viendo',
            completed: 'Vista',
            dropped: 'Abandonada',
            standby: 'En espera',
        }
        : {
            pending: 'Pendiente',
            watching: 'Viendo',
            completed: 'Completada',
            dropped: 'Abandonada',
            standby: 'En espera',
        };
    const classMap = {
        pending: 'is-pending',
        watching: 'is-watching',
        completed: 'is-completed',
        dropped: 'is-dropped',
        standby: 'is-standby',
    };
    return {
        label: labels[st] || labels.pending,
        className: classMap[st] || classMap.pending,
    };
}

function updateDetailHero(item) {
    const hero = document.getElementById('modal-hero');
    const titleEl = document.getElementById('modal-title');
    const metaEl = document.getElementById('modal-hero-meta');
    const statusEl = document.getElementById('modal-hero-status');
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
        const provider = item.watch_providers?.[0]?.provider_name;
        const parts = ['Película'];
        if (year) parts.push(String(year));
        if (provider) parts.push(provider);
        if (metaEl) metaEl.textContent = parts.join(' • ');
    }

    if (statusEl) {
        const statusInfo = getHeroStatusInfo(item);
        if (statusInfo) {
            statusEl.textContent = statusInfo.label;
            statusEl.className = `tvst-hero-status-badge ${statusInfo.className}`;
            statusEl.classList.remove('hidden');
        } else {
            statusEl.textContent = '';
            statusEl.className = 'tvst-hero-status-badge hidden';
        }
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

    updateDetailHeroFavorite(item);
    updateDetailAddBar(item);
    updateDetailHeroActions(item);
}

const DETAIL_HERO_ACTION_ICONS = {
    'add-to-list': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h11M4 12h11M4 18h7"/><path d="M17 14v6M14 17h6"/></svg>',
    pending: '<svg viewBox="0 0 24 24" aria-hidden="true" data-fill="1"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
    standby: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    dropped: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    resume: '<svg viewBox="0 0 24 24" aria-hidden="true" data-fill="1"><path d="M8 5v14l11-7z"/></svg>',
    remove: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12"/><path d="M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>',
    'movie-watch': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>',
    'movie-unwatch': '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/></svg>',
};

function buildDetailHeroActionList(item) {
    if (!item || !isItemAlreadyAdded(item.tipo, item.id_tmdb)) return [];

    const st = normalizeStatus(item.estado);
    const watchedCount = item.tipo === 'tv'
        ? (item.capitulos_vistos?.length || item.episodios_vistos_count || 0)
        : 0;

    const actions = [
        { id: 'add-to-list', label: 'Añadir a lista' },
        { id: 'pending', label: 'Marcar como pendiente' },
        { id: 'standby', label: 'Ver en otro momento' },
        { id: 'remove', label: 'Eliminar', danger: true },
    ];

    if (st === 'pending') {
        actions.splice(actions.findIndex(a => a.id === 'pending'), 1);
    }
    if (st === 'standby') {
        actions.splice(actions.findIndex(a => a.id === 'standby'), 1);
    }

    if (item.tipo === 'movie') {
        if (st === 'completed') {
            actions.splice(3, 0, { id: 'movie-unwatch', label: 'Marcar como no vista' });
        } else {
            actions.splice(3, 0, { id: 'movie-watch', label: 'Marcar como vista' });
        }
    } else if (item.tipo === 'tv') {
        if (st === 'dropped') {
            if (watchedCount > 0) {
                actions.splice(3, 0, { id: 'resume', label: 'Seguir viendo' });
            }
        } else if (watchedCount > 0) {
            actions.splice(3, 0, { id: 'dropped', label: 'Dejar de ver' });
        }
    }

    return actions;
}

function updateDetailHeroActions(item) {
    const container = document.getElementById('modal-hero-actions');
    if (!container) return;

    const actions = buildDetailHeroActionList(item);
    if (!actions.length) {
        container.innerHTML = '';
        return;
    }

    container.innerHTML = actions.map((action) => `
        <button type="button"
            class="tvst-hero-action-btn${action.danger ? ' is-danger' : ''}"
            onclick="runDetailMenuAction('${action.id}')"
            aria-label="${action.label}"
            title="${action.label}">${DETAIL_HERO_ACTION_ICONS[action.id] || '•'}</button>
    `).join('');
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

        const seasonEpisodes = episodes
            .filter(ep => ep.seasonNumber === episode.seasonNumber)
            .sort((a, b) => a.episodeNumber - b.episodeNumber);

        AppState.selectedEpisode = {
            showId: id_tmdb,
            episodeId,
            episode,
            show,
            seasonEpisodes,
        };

        paintEpisodeModal();
        document.getElementById('episode-modal')?.classList.remove('hidden');
    } catch (error) {
        console.error('[App] Error abriendo episodio:', error);
        showToast('Error al cargar el episodio', 'error');
    } finally {
        showLoading(false);
    }
}

function paintEpisodeModal() {
    const ctx = AppState.selectedEpisode;
    if (!ctx?.episode || !ctx.show) return;

    const { show, episode, episodeId, seasonEpisodes = [] } = ctx;
    const stillEl = document.getElementById('episode-still');
    const pill = document.getElementById('episode-show-pill');
    const codeEl = document.getElementById('episode-code');
    const titleEl = document.getElementById('episode-title');
    const airEl = document.getElementById('episode-air-date');
    const overviewEl = document.getElementById('episode-overview');
    const watchBtn = document.getElementById('episode-watch-btn');
    const prevBtn = document.getElementById('episode-nav-prev');
    const nextBtn = document.getElementById('episode-nav-next');

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
            openDetail('tv', ctx.showId);
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

    const liveShow = AppState.shows.find(s => s.id_tmdb === ctx.showId) || show;
    const watched = isEpisodeWatched(liveShow, episodeId);
    const skipped = isEpisodeSkipped(liveShow, episodeId);
    if (watchBtn) {
        watchBtn.classList.toggle('is-watched', Boolean(watched));
        watchBtn.setAttribute('aria-label', watched ? 'Desmarcar visto' : 'Marcar visto');
    }
    const skipBtn = document.getElementById('episode-skip-btn');
    if (skipBtn) {
        skipBtn.classList.toggle('is-skipped', Boolean(skipped));
        skipBtn.textContent = skipped ? '↷ Quitar salto' : '↷ Saltar';
        skipBtn.setAttribute('aria-label', skipped ? 'Quitar salto' : 'Saltar episodio');
        const aired = isEpisodeAired(episode);
        skipBtn.disabled = !aired;
    }

    const idx = seasonEpisodes.findIndex(ep => ep.id === episodeId);
    if (prevBtn) prevBtn.disabled = idx <= 0;
    if (nextBtn) nextBtn.disabled = idx < 0 || idx >= seasonEpisodes.length - 1;
}

function navigateEpisode(delta) {
    const ctx = AppState.selectedEpisode;
    if (!ctx?.seasonEpisodes?.length) return;
    const idx = ctx.seasonEpisodes.findIndex(ep => ep.id === ctx.episodeId);
    const nextIdx = idx + Number(delta);
    if (idx < 0 || nextIdx < 0 || nextIdx >= ctx.seasonEpisodes.length) return;

    const episode = ctx.seasonEpisodes[nextIdx];
    AppState.selectedEpisode = {
        ...ctx,
        episodeId: episode.id,
        episode,
    };
    paintEpisodeModal();

    const scroll = document.querySelector('#episode-modal .tvst-modal-scroll');
    if (scroll) scroll.scrollTop = 0;
}

function closeEpisodeModal() {
    document.getElementById('episode-modal')?.classList.add('hidden');
    AppState.selectedEpisode = null;
}

function refreshEpisodeModalWatchState() {
    paintEpisodeModal();
}

async function toggleEpisodeFromDetail() {
    const ctx = AppState.selectedEpisode;
    if (!ctx) return;
    await toggleEpisode(ctx.showId, ctx.episodeId);
    paintEpisodeModal();
}

async function toggleEpisodeSkippedFromDetail() {
    const ctx = AppState.selectedEpisode;
    if (!ctx) return;
    await toggleEpisodeSkipped(ctx.showId, ctx.episodeId);
}

async function openPersonDetail(personId) {
    const id = Number(personId);
    if (!Number.isFinite(id) || id <= 0) return;
    if (typeof getPersonDetails !== 'function') {
        showToast('TMDB no disponible', 'error');
        return;
    }

    showLoading(true);
    try {
        const [details, credits] = await Promise.all([
            getPersonDetails(id),
            typeof getPersonCredits === 'function' ? getPersonCredits(id) : Promise.resolve([]),
        ]);

        AppState.selectedPerson = { ...details, credits };

        const modal = document.getElementById('person-modal');
        const photoEl = document.getElementById('person-photo');
        const nameEl = document.getElementById('person-name');
        const metaEl = document.getElementById('person-meta');
        const bioEl = document.getElementById('person-bio');
        const linkEl = document.getElementById('person-tmdb-link');
        const creditsEl = document.getElementById('person-credits');

        if (photoEl) {
            photoEl.innerHTML = details.profile_path
                ? `<img src="${details.profile_path}" alt="">`
                : '<div class="tvst-person-photo-fallback">🎭</div>';
        }
        if (nameEl) nameEl.textContent = details.name || 'Sin nombre';
        if (metaEl) {
            const bits = [
                details.known_for_department,
                details.birthday ? `Nac. ${details.birthday}` : '',
                details.place_of_birth,
            ].filter(Boolean);
            metaEl.textContent = bits.join(' · ');
        }
        if (bioEl) {
            const bio = String(details.biography || '').trim();
            bioEl.textContent = bio || 'Sin biografía disponible.';
        }
        if (linkEl) {
            linkEl.href = `https://www.themoviedb.org/person/${id}`;
        }
        if (creditsEl) {
            if (!credits.length) {
                creditsEl.innerHTML = '<p class="text-sm text-gray-500">No hay filmografía disponible.</p>';
            } else {
                creditsEl.innerHTML = credits.map(item => `
                    <article class="tvst-person-credit-card" onclick="openDetailFromPerson('${item.tipo}', ${item.id_tmdb})">
                        ${item.portada
                            ? `<img src="${item.portada}" alt="">`
                            : '<div class="tvst-person-credit-fallback">🎬</div>'}
                        <div class="tvst-person-credit-meta">
                            <p class="tvst-person-credit-title">${escapeHtml(item.titulo || '')}</p>
                            <p class="tvst-person-credit-sub">${escapeHtml([item.year, item.tipo === 'tv' ? 'Serie' : 'Película', item.character].filter(Boolean).join(' · '))}</p>
                        </div>
                    </article>
                `).join('');
            }
        }

        modal?.classList.remove('hidden');
        const scroll = modal?.querySelector('.tvst-modal-scroll');
        if (scroll) scroll.scrollTop = 0;
    } catch (error) {
        console.error('[App] Error abriendo persona:', error);
        showToast('Error al cargar el actor', 'error');
    } finally {
        showLoading(false);
    }
}

function closePersonModal() {
    document.getElementById('person-modal')?.classList.add('hidden');
    AppState.selectedPerson = null;
}

function openDetailFromPerson(tipo, id_tmdb) {
    closePersonModal();
    openDetail(tipo, id_tmdb);
}

async function openDetail(type, id_tmdb) {
    const modal = document.getElementById('detail-modal');
    modal.classList.remove('hidden');
    document.getElementById('modal-actions')?.classList.add('hidden');
    AppState.detailRecsExpanded = false;
    AppState.detailCriticaEditing = false;

    showLoading(true);

    try {
        const libraryItem = type === 'movie'
            ? AppState.movies.find(m => m.id_tmdb === id_tmdb)
            : AppState.shows.find(s => s.id_tmdb === id_tmdb);
        let item = libraryItem;

        const castMissingIds = Array.isArray(item?.credits?.cast)
            && item.credits.cast.length > 0
            && !item.credits.cast.some(p => Number(p.id) > 0);
        const needsFreshDetails = !item?.overview || !item?.credits?.cast?.length || castMissingIds || !item?.recommendations?.length || !item?.backdrop;
        const needsProviders = !item?.watch_providers?.length;

        const [fresh, watchProviders] = await Promise.all([
            needsFreshDetails
                ? (type === 'movie' ? getMovieDetails(id_tmdb) : getTVDetails(id_tmdb))
                : Promise.resolve(null),
            needsProviders && typeof window.getWatchProviders === 'function'
                ? window.getWatchProviders(type === 'movie' ? 'movie' : 'tv', id_tmdb)
                : Promise.resolve(null),
        ]);

        if (fresh) {
            const merged = mergeDetailItem(libraryItem, fresh);
            if (libraryItem) {
                Object.assign(libraryItem, merged);
                item = libraryItem;
            } else {
                item = merged;
            }
        }

        if (watchProviders?.length) {
            item.watch_providers = watchProviders;
            if (libraryItem) libraryItem.watch_providers = watchProviders;
        }

        if (type === 'tv' && libraryItem) {
            const beforeEstado = normalizeStatus(libraryItem.estado);
            await refreshShowStatus(libraryItem);
            const afterEstado = normalizeStatus(libraryItem.estado);
            if (beforeEstado === 'completed' && afterEstado === 'watching') {
                applyContinueBoost(libraryItem, 'detalle reopen');
                invalidateOrderedEpisodesCache(libraryItem.id_tmdb);
                invalidateTimelineCaches();
                saveLocalData();
                syncToDrive();
                showToast(`Nueva temporada: ${libraryItem.titulo || 'Serie'}`, 'info');
            } else if (beforeEstado !== afterEstado) {
                touchUpdatedAt(libraryItem);
                saveLocalData();
                syncToDrive();
            }
            item = libraryItem;
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
            switchDetailTab('info');
            // Info visible ya; episodios en background sin bloquear el modal
            void renderEpisodes(AppState.selectedItem);
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
    AppState.detailCriticaEditing = false;
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
 * Elimina el contenido actual y deja la ficha abierta con «Añadir»
 */
async function removeContent() {
    if (!AppState.selectedItem) return;

    const item = AppState.selectedItem;
    const tipo = item.tipo;
    const id_tmdb = item.id_tmdb;

    if (!confirm(`¿Estás seguro de eliminar "${item.titulo}"?`)) return;

    if (tipo === 'movie') {
        removeMovie(id_tmdb);
    } else {
        removeShow(id_tmdb);
    }

    // Mantener ficha abierta (fuera de biblioteca) → barra Añadir
    closeDetailMenu();
    await openDetail(tipo, id_tmdb);
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
    AppState.driveLoadOk = false;
    AppState.syncDirty = false;
    clearTimeout(syncToDriveTimeout);
    clearLibraryState();
    setStoredDriveUser(null);
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
        deletedIds: AppState.deletedIds,
        deletedListIds: AppState.deletedListIds,
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
                AppState.deletedIds = normalizeDeletedIds(data.deletedIds);
                AppState.deletedListIds = normalizeDeletedListIds(data.deletedListIds);
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
        clearLibraryState();
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
    const action = (opts.actionLabel && opts.actionOnClick)
        ? `<button type="button" class="tvst-empty-action" onclick="${opts.actionOnClick}">${opts.actionLabel}</button>`
        : '';
    return `
        <div class="tvst-empty"${gridStyle}>
            <div class="tvst-empty-icon${loadingClass}">${svg}</div>
            <p class="tvst-empty-title">${title}</p>
            ${subtitle}
            ${action}
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
    syncMobileChromeHeights();
    window.addEventListener('resize', () => {
        clearTimeout(chromeResizeTimer);
        chromeResizeTimer = setTimeout(syncMobileChromeHeights, 100);
    });
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', () => {
            clearTimeout(chromeResizeTimer);
            chromeResizeTimer = setTimeout(syncMobileChromeHeights, 100);
        });
    }
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
window.navigateEpisode = navigateEpisode;
window.toggleEpisodeFromDetail = toggleEpisodeFromDetail;
window.toggleEpisodeSkippedFromDetail = toggleEpisodeSkippedFromDetail;
window.openPersonDetail = openPersonDetail;
window.closePersonModal = closePersonModal;
window.openDetailFromPerson = openDetailFromPerson;
window.closeModal = closeModal;
window.saveContent = saveContent;
window.removeContent = removeContent;
window.setRating = setRating;
window.setStatus = setStatus;
window.setPersonalRating = setPersonalRating;
window.setMoviesPendingGenreFilter = setMoviesPendingGenreFilter;
window.setMoviesPendingPlatformFilter = setMoviesPendingPlatformFilter;
window.setMoviesPendingMaxRuntime = setMoviesPendingMaxRuntime;
window.toggleMoviesPendingFilters = toggleMoviesPendingFilters;
window.startEditCritica = startEditCritica;
window.saveItemCritica = saveItemCritica;
window.handleEpisodeRowKeydown = handleEpisodeRowKeydown;
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
window.exportSelectedList = exportSelectedList;
window.removeItemFromList = removeItemFromList;
window.openDetailFromList = openDetailFromList;
window.onListItemClick = onListItemClick;
window.toggleListCoverPickMode = toggleListCoverPickMode;
window.setListCover = setListCover;
window.toggleFavorite = toggleFavorite;
window.toggleFavoriteFromHero = toggleFavoriteFromHero;
window.toggleFavoriteFromCard = toggleFavoriteFromCard;
window.onListSortChange = onListSortChange;
window.onProfilePlatformChange = onProfilePlatformChange;
window.openListPicker = openListPicker;
window.closeListPicker = closeListPicker;
window.toggleSelectedInList = toggleSelectedInList;
window.createListFromPicker = createListFromPicker;
window.toggleEpisode = toggleEpisode;
window.toggleEpisodeSkipped = toggleEpisodeSkipped;
window.toggleSeasonSkipped = toggleSeasonSkipped;
window.toggleMovieWatched = toggleMovieWatched;
window.toggleSeasonWatched = toggleSeasonWatched;
window.toggleSeasonAccordion = toggleSeasonAccordion;
window.toggleEpisodeAndUpdateSeason = toggleEpisodeAndUpdateSeason;
window.updateSeasonUI = updateSeasonUI;

console.log('[App] app.js cargado');

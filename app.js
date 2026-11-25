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
    profileSeriesSort: 'name',
    profileMoviesSort: 'name',
    profileExpanded: { series: false, movies: false, favoritesSeries: false, favoritesMovies: false },
    listSortMode: 'added',
    detailCriticaEditing: false,
    moviesPendingSearch: '',
    moviesPendingSort: 'name',
    moviesPendingGenres: [],
    moviesPendingPlatforms: [],
    moviesPendingMaxRuntime: null,
    moviesPendingMySubsOnly: false,
    moviesPendingFiltersOpen: false,
    lastSearchResults: [],
    exploreTrendingTab: 'tv',
    trendingCache: { tv: [], movie: [] },
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
    revealedSpoilerEpisodeKeys: {},
    timelineHistoryVisible: { 'pending-list': 0, upcoming: 4 },
    timelineHistoryCache: {},
    timelinePendingCache: { continueWatching: [], staleWatching: [], builtAt: 0 },
    timelineUpcomingCache: { html: '', builtAt: 0, items: [] },
    upcomingSeriesCal: { weekOffset: 0, selectedDate: null },
    upcomingMoviesCal: { weekOffset: 0, selectedDate: null },
    activeTrailerKey: null,
    lastCompletedReopenAt: 0,
    preferences: null,
};

const VALID_START_TABS = new Set(['series', 'movies', 'explore', 'profile']);
const VALID_INACTIVITY_DAYS = new Set([7, 14, 30, 60]);
const VALID_PREV_EP_RULES = new Set(['ask', 'always', 'never']);
const PROVIDER_COUNTRIES = [
    { code: 'ES', label: 'España (ES)' },
    { code: 'MX', label: 'México (MX)' },
    { code: 'AR', label: 'Argentina (AR)' },
    { code: 'CO', label: 'Colombia (CO)' },
    { code: 'CL', label: 'Chile (CL)' },
    { code: 'US', label: 'EE. UU. (US)' },
];
const VALID_PROVIDER_COUNTRIES = new Set(PROVIDER_COUNTRIES.map(c => c.code));

const DEFAULT_PREFERENCES = {
    startTab: 'series',
    spoilerFree: false,
    includeSpecials: false,
    inactivityDays: 14,
    previousEpisodesRule: 'ask',
    showMoviePosterTitles: false,
    showMoviePosterRatings: false,
    providerCountry: 'ES',
    mySubscriptions: [],
    showTrailers: true,
    showUpcomingMiniCalendar: true,
    updatedAt: '',
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
let profileSearchDebounceTimer = null;
let moviesPendingSearchDebounceTimer = null;
const failedProviderFetchKeys = new Set();
const attemptedMovieFilterMetaIds = new Set();
const attemptedMovieReleaseSyncKeys = new Set();

function normalizePreferences(raw = null) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const startTab = VALID_START_TABS.has(src.startTab) ? src.startTab : DEFAULT_PREFERENCES.startTab;
    const inactivityNum = Number(src.inactivityDays);
    const inactivityDays = VALID_INACTIVITY_DAYS.has(inactivityNum) ? inactivityNum : DEFAULT_PREFERENCES.inactivityDays;
    const prevRule = VALID_PREV_EP_RULES.has(src.previousEpisodesRule) ? src.previousEpisodesRule : DEFAULT_PREFERENCES.previousEpisodesRule;
    const countryRaw = String(src.providerCountry || DEFAULT_PREFERENCES.providerCountry).trim().toUpperCase();
    const providerCountry = VALID_PROVIDER_COUNTRIES.has(countryRaw) ? countryRaw : DEFAULT_PREFERENCES.providerCountry;
    const subs = Array.isArray(src.mySubscriptions)
        ? [...new Set(src.mySubscriptions.map(s => String(s || '').trim()).filter(Boolean))]
        : [];
    return {
        startTab,
        spoilerFree: Boolean(src.spoilerFree),
        includeSpecials: Boolean(src.includeSpecials),
        inactivityDays,
        previousEpisodesRule: prevRule,
        showMoviePosterTitles: Boolean(src.showMoviePosterTitles),
        showMoviePosterRatings: Boolean(src.showMoviePosterRatings),
        providerCountry,
        mySubscriptions: subs,
        showTrailers: src.showTrailers === undefined ? DEFAULT_PREFERENCES.showTrailers : Boolean(src.showTrailers),
        showUpcomingMiniCalendar: src.showUpcomingMiniCalendar === undefined ? DEFAULT_PREFERENCES.showUpcomingMiniCalendar : Boolean(src.showUpcomingMiniCalendar),
        updatedAt: typeof src.updatedAt === 'string' ? src.updatedAt : '',
    };
}

AppState.preferences = normalizePreferences();

function getPreferences() {
    if (!AppState.preferences) {
        AppState.preferences = normalizePreferences();
    }
    return AppState.preferences;
}

function getValidStartTab() {
    const tab = getPreferences().startTab;
    return VALID_START_TABS.has(tab) ? tab : 'series';
}

function isSpoilerFreeEnabled() {
    return Boolean(getPreferences().spoilerFree);
}

function shouldMaskEpisodeSpoilers(show, episodeId) {
    if (!isSpoilerFreeEnabled() || !show || !episodeId) return false;
    return !isEpisodeConsumed(show, episodeId);
}

function shouldIncludeSpecials() {
    return Boolean(getPreferences().includeSpecials);
}

function areTrailersEnabled() {
    return getPreferences().showTrailers !== false;
}

function isUpcomingMiniCalendarEnabled() {
    return getPreferences().showUpcomingMiniCalendar !== false;
}

function getInactivityDays() {
    const days = Number(getPreferences().inactivityDays);
    return VALID_INACTIVITY_DAYS.has(days) ? days : CONTINUE_BOOST_DAYS;
}

function getPreviousEpisodesRule() {
    const rule = getPreferences().previousEpisodesRule;
    return VALID_PREV_EP_RULES.has(rule) ? rule : 'ask';
}

function getPreferredProviderCountry() {
    return getPreferences().providerCountry || 'ES';
}

function getMySubscriptions() {
    return getPreferences().mySubscriptions || [];
}

function isSubscribedProvider(rawName) {
    const normalized = typeof normalizeProviderName === 'function'
        ? normalizeProviderName(rawName)
        : String(rawName || '').trim();
    if (!normalized) return false;
    return getMySubscriptions().some(sub => sub.toLowerCase() === normalized.toLowerCase());
}

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
    return `Falta configuración (${parts.join(' + ')}). Configura las variables de entorno (TMDB_API_KEY / GOOGLE_CLIENT_ID) o config.js.`;
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
    await loadLocalDataAsync(AppState.driveUserId);
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

        if (!isAuthenticated() && storedUser?.id) {
            try {
                await ensureValidAccessToken({ interactive: false });
            } catch (_) {
                // Sin sesión previa válida: se queda en el gate
            }
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
        await loadLocalDataAsync(prevUserId);
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
        if (userId) {
            loadLocalData(userId);
            await loadLocalDataAsync(userId);
        } else {
            clearLibraryState();
        }
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
        await loadLocalDataAsync(userId);
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

    switchTab(getValidStartTab());
    await renderCurrentView();
    scheduleSyncMobileChromeHeights();
    const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 800));
    idle(() => {
        prefetchTimelineSeasons().catch(() => {});
    });
}

async function connectDriveFromGate() {
    const btn = document.getElementById('btn-drive-gate-connect');
    const newTabLink = document.getElementById('drive-gate-newtab');
    if (btn) btn.disabled = true;
    if (newTabLink) newTabLink.classList.add('hidden');
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
        // Si GIS ya está listo, llamar authenticate() sin await previo para mantener
        // el gesto de usuario (user activation) y evitar bloqueo de popups en iframe.
        if (typeof isDriveServiceReady === 'function' && isDriveServiceReady()) {
            await authenticate();
        } else {
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
        }
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
        const inIframe = (() => {
            try { return window.self !== window.top; } catch (_) { return true; }
        })();
        if (msg.includes('CONFIG_MISSING') || msg.includes('CONFIG_TMDB')) {
            setDriveGateVisible(true, getConfigSetupError() || 'Falta configuración de claves.');
        } else if (msg.includes('origin_mismatch')) {
            setDriveGateVisible(true, `Origen no autorizado en Google Cloud: ${window.location.origin}. Añádelo en Credenciales → Orígenes JavaScript autorizados.`);
        } else if (msg.includes('popup_closed') || msg.includes('access_denied')) {
            setDriveGateVisible(true, 'Cerraste la ventana de Google o denegaste el acceso. Pulsa de nuevo para intentarlo.');
        } else if (msg.includes('popup_failed') || msg.includes('popup_timeout') || msg.toLowerCase().includes('popup')) {
            if (inIframe && newTabLink) {
                newTabLink.href = window.location.href;
                newTabLink.classList.remove('hidden');
            }
            setDriveGateVisible(true, inIframe
                ? 'El navegador o el visor embebido bloqueó el popup de Google. Permite popups o abre la app en una pestaña nueva.'
                : 'El navegador bloqueó el popup. Permite ventanas emergentes para este sitio e inténtalo otra vez.');
        } else {
            if (inIframe && newTabLink) {
                newTabLink.href = window.location.href;
                newTabLink.classList.remove('hidden');
            }
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
    AppState.preferences = normalizePreferences();
    AppState.moviesPendingMySubsOnly = false;
    AppState.revealedSpoilerEpisodeKeys = {};
    AppState.selectedItem = null;
    AppState.selectedListId = null;
    invalidateTimelineCaches();
}

const LOCAL_IDB_NAME = 'seenit_local_db';
const LOCAL_IDB_STORE = 'kv';
let localIdbPromise = null;

function openLocalIdb() {
    if (localIdbPromise) return localIdbPromise;
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);
    localIdbPromise = new Promise((resolve) => {
        try {
            const req = indexedDB.open(LOCAL_IDB_NAME, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(LOCAL_IDB_STORE)) {
                    db.createObjectStore(LOCAL_IDB_STORE);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        } catch (_) {
            resolve(null);
        }
    });
    return localIdbPromise;
}

async function idbGet(key) {
    const db = await openLocalIdb();
    if (!db) return null;
    return new Promise((resolve) => {
        try {
            const tx = db.transaction(LOCAL_IDB_STORE, 'readonly');
            const req = tx.objectStore(LOCAL_IDB_STORE).get(key);
            req.onsuccess = () => resolve(req.result ?? null);
            req.onerror = () => resolve(null);
        } catch (_) {
            resolve(null);
        }
    });
}

function idbSet(key, value) {
    return openLocalIdb().then((db) => {
        if (!db) return false;
        return new Promise((resolve) => {
            try {
                const tx = db.transaction(LOCAL_IDB_STORE, 'readwrite');
                tx.objectStore(LOCAL_IDB_STORE).put(value, key);
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => resolve(false);
            } catch (_) {
                resolve(false);
            }
        });
    });
}

function applyParsedLocalData(data) {
    AppState.movies = (data.movies || []).map(normalizeStoredMovie);
    AppState.shows = (data.shows || []).map(normalizeStoredShow);
    AppState.lists = (data.lists || []).map(normalizeStoredList);
    AppState.deletedIds = normalizeDeletedIds(data.deletedIds);
    AppState.deletedListIds = normalizeDeletedListIds(data.deletedListIds);
    AppState.preferences = normalizePreferences(data.preferences);
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
            applyParsedLocalData(JSON.parse(savedData));
            console.log('[App] Datos locales cargados', key);
        } else {
            clearLibraryState();
            console.log('[App] Sin datos locales para', key);
        }
    } catch (error) {
        console.error('[App] Error cargando datos locales:', error);
    }
}

async function loadLocalDataAsync(userId = AppState.driveUserId) {
    try {
        const key = getDataStorageKey(userId);
        const idbData = await idbGet(key);
        if (!idbData || typeof idbData !== 'object') return;
        const lsLastModified = parseModifiedMs(getStoredLastModified(userId));
        const idbLastModified = parseModifiedMs(idbData.lastModified);
        if (!localStorage.getItem(key) || idbLastModified >= lsLastModified) {
            applyParsedLocalData(idbData);
            console.log('[App] Datos locales restaurados desde IndexedDB', key);
        }
    } catch (error) {
        console.warn('[App] Error cargando datos desde IndexedDB:', error);
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
    if (normalized.release_date_country) {
        normalized.release_date_country = String(normalized.release_date_country).trim().toUpperCase();
    }
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
    if ('next_episode_to_air' in show) {
        normalized.next_episode_to_air = show.next_episode_to_air && typeof show.next_episode_to_air === 'object'
            ? show.next_episode_to_air
            : null;
    }
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

function evictNonEssentialLocalStorage(currentKey) {
    try { localStorage.removeItem('seenit_tmdb_seasons_v1'); } catch (_) { /* ignore */ }
    try { localStorage.removeItem('seenit_data_backup'); } catch (_) { /* ignore */ }
    if (AppState.driveUserId && currentKey !== LEGACY_DATA_KEY) {
        try { localStorage.removeItem(LEGACY_DATA_KEY); } catch (_) { /* ignore */ }
    }
}

/**
 * Guarda datos localmente (IndexedDB sin límite de 5MB + localStorage cuando cabe).
 */
function saveLocalDataImmediate() {
    const key = getDataStorageKey();
    const data = {
        movies: AppState.movies,
        shows: AppState.shows,
        lists: AppState.lists,
        deletedIds: AppState.deletedIds,
        deletedListIds: AppState.deletedListIds,
        preferences: getPreferences(),
        lastModified: nowIso(),
    };

    // Persistir siempre en IndexedDB para bibliotecas grandes (>5MB)
    idbSet(key, data);

    const serialized = JSON.stringify(data);
    try {
        localStorage.setItem(key, serialized);
    } catch (error) {
        evictNonEssentialLocalStorage(key);
        try {
            localStorage.setItem(key, serialized);
        } catch (retryError) {
            // Si excede la cuota de 5MB de localStorage, eliminar copia vieja de localStorage
            // para que loadLocalDataAsync lea la versión más reciente desde IndexedDB.
            try { localStorage.removeItem(key); } catch (_) { /* ignore */ }
            console.warn('[App] Biblioteca demasiado grande para localStorage; guardada en IndexedDB:', retryError?.name || retryError);
        }
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
    const prefs = getPreferences();
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
        preferences: { ...prefs, mySubscriptions: [...(prefs.mySubscriptions || [])] },
        lastModified: getStoredLastModified() || nowIso(),
    };
}

function backupLibraryBeforeMerge(localSnapshot) {
    const payload = {
        movies: localSnapshot?.movies || [],
        shows: localSnapshot?.shows || [],
        lists: localSnapshot?.lists || [],
        deletedIds: localSnapshot?.deletedIds || { movie: [], tv: [] },
        deletedListIds: localSnapshot?.deletedListIds || [],
        lastModified: localSnapshot?.lastModified || getStoredLastModified() || null,
        backedUpAt: nowIso(),
    };
    idbSet('seenit_data_backup', payload);
    try {
        localStorage.removeItem('seenit_data_backup');
    } catch (_) { /* ignore */ }
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
        preferences: mergePreferencesLww(localLib?.preferences, remoteLib?.preferences),
    };
}

function mergePreferencesLww(localPrefsRaw, remotePrefsRaw) {
    const localPrefs = normalizePreferences(localPrefsRaw);
    const remotePrefs = normalizePreferences(remotePrefsRaw);
    const localMs = parseModifiedMs(localPrefs.updatedAt);
    const remoteMs = parseModifiedMs(remotePrefs.updatedAt);
    if (remoteMs > localMs) return remotePrefs;
    if (localMs > remoteMs) return localPrefs;
    if (remotePrefs.updatedAt && !localPrefs.updatedAt) return remotePrefs;
    return localPrefs;
}

function applyLibrary(lib) {
    AppState.movies = (lib.movies || []).map(normalizeStoredMovie);
    AppState.shows = (lib.shows || []).map(normalizeStoredShow);
    AppState.lists = (lib.lists || []).map(normalizeStoredList);
    AppState.deletedIds = normalizeDeletedIds(lib.deletedIds);
    AppState.deletedListIds = normalizeDeletedListIds(lib.deletedListIds);
    AppState.preferences = normalizePreferences(lib.preferences);
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
        preferences: normalizePreferences(remoteData?.preferences),
        lastModified: remoteData?.lastModified || null,
    };
    const remoteCount = libraryItemCount(remoteLib);
    const localCount = libraryItemCount(localSnapshot);
    const remoteMs = parseModifiedMs(remoteLib.lastModified);
    const localMs = parseModifiedMs(localSnapshot?.lastModified);

    if (remoteCount === 0 && localCount > 0) {
        applyLibrary({
            ...localSnapshot,
            preferences: mergePreferencesLww(localSnapshot?.preferences, remoteLib.preferences),
        });
        return 'local-upload';
    }

    if (remoteCount > 0 && localCount > 0) {
        applyLibrary(mergeLibraries(localSnapshot, remoteLib));
        return 'merged';
    }

    if (remoteCount > 0) {
        applyLibrary({
            ...remoteLib,
            preferences: mergePreferencesLww(localSnapshot?.preferences, remoteLib.preferences),
        });
        return 'remote';
    }

    if (remoteCount === 0 && localCount === 0) {
        const mergedPrefs = mergePreferencesLww(localSnapshot?.preferences, remoteLib.preferences);
        AppState.preferences = mergedPrefs;
        const localPrefsMs = parseModifiedMs(localSnapshot?.preferences?.updatedAt);
        const remotePrefsMs = parseModifiedMs(remoteLib.preferences?.updatedAt);
        if (localPrefsMs > remotePrefsMs) return 'local-upload';
        if (remoteMs > localMs && remoteMs > 0) {
            applyLibrary({ ...remoteLib, preferences: mergedPrefs });
            return 'remote';
        }
        return remotePrefsMs > localPrefsMs ? 'remote' : 'unchanged';
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
                const episodes = await getOrderedEpisodes(show, { includeSpecials: shouldIncludeSpecials() });
                const airedEpisodeIds = episodes.filter(isEpisodeAired).map(ep => ep.id);
                const prevWatched = new Set(show.capitulos_vistos || []);
                const newlyWatchedIds = airedEpisodeIds.filter(id => !prevWatched.has(id));
                show.capitulos_vistos = [...new Set([...(show.capitulos_vistos || []), ...airedEpisodeIds])];
                ensureSkippedList(show);
                airedEpisodeIds.forEach(epId => clearEpisodeSkipped(show, epId));
                if (newlyWatchedIds.length) {
                    recordEpisodesWatched(show, newlyWatchedIds);
                }
                show.episodios_emitidos = airedEpisodeIds.length;
                show.episodios_vistos_count = airedEpisodeIds.length;
                show.episodios_consumidos_count = airedEpisodeIds.length;
            }
            touchUpdatedAt(show);
        }
    }

    if (type === 'tv') {
        invalidateTimelineCaches();
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

async function resolveMarkPreviousEpisodes(show, episodes, episodeId, confirmText = 'Marcar todos') {
    if (!shouldAskToMarkPreviousEpisodes(show, episodes, episodeId)) return false;
    const rule = getPreviousEpisodesRule();
    if (rule === 'always') return true;
    if (rule === 'never') return false;
    return showConfirmDialog({
        title: 'Episodios anteriores',
        message: '¿Quieres marcar también los episodios anteriores como vistos?',
        confirmText,
        cancelText: 'Solo este',
    });
}

async function toggleEpisode(id_tmdb, episode) {
    const show = AppState.shows.find(s => s.id_tmdb === id_tmdb);
    if (!show) return;

    const episodes = await getOrderedEpisodes(show, { includeSpecials: shouldIncludeSpecials() });
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
        if (await resolveMarkPreviousEpisodes(show, episodes, episode, 'Marcar todos')) {
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
        preferences: getPreferences(),
        lastModified: nowIso(),
    };
}

function bindSyncFlushListeners() {
    if (syncFlushBound) return;
    syncFlushBound = true;
    const flush = (keepalive = false) => {
        if (!isAuthenticated() || !AppState.driveLoadOk) return;
        clearTimeout(syncToDriveTimeout);
        syncToDriveNow({ keepalive });
    };
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush(false);
    });
    window.addEventListener('pagehide', () => flush(true));
}

async function syncToDriveNow(options = {}) {
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
    const keepalive = Boolean(options.keepalive);

    try {
        try {
            await ensureValidAccessToken({ interactive: false });
        } catch (_) { /* syncToDrive will fail below if needed */ }

        await saveUserData(buildDrivePayload(), { keepalive });
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
        if (tab === 'profile' || tab === 'explore' || tab === 'movies' || tab === 'settings') {
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
        return;
    }

    if (AppState.currentTab === 'settings') {
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

    const prefs = getPreferences();
    const showTitles = Boolean(prefs.showMoviePosterTitles);
    const showRatings = Boolean(prefs.showMoviePosterRatings);

    return movies.map(movie => {
        const countdown = showCountdown ? formatMovieCountdown(movie.fecha_estreno) : '';
        const isCompleted = normalizeStatus(movie.estado) === 'completed';
        const poster = safeUrl(movie.portada);
        const tmdbScore = Number(movie.vote_average);
        const hasTmdbScore = showRatings && Number.isFinite(tmdbScore) && tmdbScore > 0;
        const innerPoster = `
            ${poster
                ? `<img src="${escapeHtml(poster)}" alt="${escapeHtml(movie.titulo || '')}">`
                : `<div class="tvst-poster-fallback">${UI_ICONS.film}</div>`}
            ${hasTmdbScore ? `<span class="tvst-poster-score is-tmdb">${UI_ICONS.starSm} ${tmdbScore.toFixed(1)}</span>` : ''}
            ${showCountdown && countdown ? `<div class="tvst-poster-countdown">${escapeHtml(countdown)}</div>` : ''}
            ${showWatchToggle ? `
                <button type="button"
                    class="tvst-movie-check${isCompleted ? ' is-watched' : ''}"
                    onclick="event.stopPropagation(); toggleMovieWatched(${Number(movie.id_tmdb)})"
                    aria-label="${isCompleted ? 'Marcar como no vista' : 'Marcar como vista'}">${UI_ICONS.check}</button>
            ` : ''}
        `;

        if (showTitles) {
            return `
            <article class="tvst-poster-cell has-title" data-tmdb-id="${Number(movie.id_tmdb)}" onclick="openDetail('movie', ${Number(movie.id_tmdb)})">
                <div class="tvst-poster-frame">${innerPoster}</div>
                <p class="tvst-poster-title">${escapeHtml(movie.titulo || 'Sin título')}</p>
            </article>`;
        }

        return `
        <article class="tvst-poster-cell" data-tmdb-id="${Number(movie.id_tmdb)}" onclick="openDetail('movie', ${Number(movie.id_tmdb)})">
            ${innerPoster}
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

function normalizeSearchText(str) {
    return String(str || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

function getItemYearString(item) {
    const raw = item?.fecha_estreno || item?.first_air_date || item?.release_date || '';
    const match = String(raw).match(/\d{4}/);
    return match ? match[0] : '';
}

function getMoviesPendingBaseList() {
    return AppState.movies
        .filter(movie => normalizeStatus(movie.estado) !== 'completed')
        .filter(movie => isMovieReleased(movie));
}

function sortMoviesPendingList(items, mode = AppState.moviesPendingSort || 'name') {
    const list = [...(items || [])];
    const byName = (a, b) => (a.titulo || '').localeCompare(b.titulo || '', 'es', { sensitivity: 'base' });
    if (mode === 'tmdb') {
        return list.sort((a, b) => {
            const aScore = Number(a.vote_average);
            const bScore = Number(b.vote_average);
            const aValid = Number.isFinite(aScore) && aScore > 0;
            const bValid = Number.isFinite(bScore) && bScore > 0;
            if (aValid && bValid && bScore !== aScore) return bScore - aScore;
            if (aValid && !bValid) return -1;
            if (!aValid && bValid) return 1;
            return byName(a, b);
        });
    }
    if (mode === 'runtime-asc') {
        return list.sort((a, b) => {
            const aRun = Number(a.runtime) > 0 ? Number(a.runtime) : Infinity;
            const bRun = Number(b.runtime) > 0 ? Number(b.runtime) : Infinity;
            if (aRun !== bRun) return aRun - bRun;
            return byName(a, b);
        });
    }
    if (mode === 'recent-release') {
        return list.sort((a, b) => {
            const aDate = String(a.fecha_estreno || a.release_date || '');
            const bDate = String(b.fecha_estreno || b.release_date || '');
            if (bDate !== aDate) return bDate.localeCompare(aDate);
            return byName(a, b);
        });
    }
    if (mode === 'recent-added') {
        return list.sort((a, b) => {
            const aMs = parseModifiedMs(a.updatedAt || a.addedAt);
            const bMs = parseModifiedMs(b.updatedAt || b.addedAt);
            if (bMs !== aMs) return bMs - aMs;
            return byName(a, b);
        });
    }
    return list.sort(byName);
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

function orderFilterChipValues(values, activeValues = []) {
    const activeList = Array.isArray(activeValues) ? activeValues : (activeValues && activeValues !== 'all' ? [activeValues] : []);
    const unique = [...new Set(values.filter(Boolean))];
    const activeSet = new Set(activeList);
    const activeSorted = unique
        .filter(v => activeSet.has(v))
        .sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
    const rest = unique
        .filter(v => !activeSet.has(v))
        .sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
    return [...activeSorted, ...rest];
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
    const search = AppState.moviesPendingSearch || '';
    if (search.trim() && !matchesProfileSearch(movie, search)) {
        return false;
    }

    const selectedGenres = AppState.moviesPendingGenres || [];
    if (selectedGenres.length) {
        const movieGenres = movie.generos || [];
        if (!selectedGenres.some(g => movieGenres.includes(g))) return false;
    }

    const selectedPlatforms = AppState.moviesPendingPlatforms || [];
    if (selectedPlatforms.length) {
        const movieProviders = getMovieProviderNames(movie);
        const matchesAny = selectedPlatforms.some(platform => (
            platform === PROVIDER_OTHER
                ? itemHasOtherProviders(movie)
                : movieProviders.includes(platform)
        ));
        if (!matchesAny) return false;
    }

    if (AppState.moviesPendingMySubsOnly && getMySubscriptions().length) {
        const movieProviders = getMovieProviderNames(movie);
        if (!movieProviders.some(p => isSubscribedProvider(p))) return false;
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

function getMoviesPendingSortLabel(mode) {
    const labels = {
        name: 'Nombre A–Z',
        tmdb: 'Nota TMDB',
        'runtime-asc': 'Más cortas',
        'recent-release': 'Estreno reciente',
        'recent-added': 'Añadidas',
    };
    return labels[mode] || 'Nombre A–Z';
}

function getMoviesPendingActiveCount() {
    let count = 0;
    if ((AppState.moviesPendingGenres || []).length) count += AppState.moviesPendingGenres.length;
    if ((AppState.moviesPendingPlatforms || []).length) count += AppState.moviesPendingPlatforms.length;
    if (AppState.moviesPendingMySubsOnly && getMySubscriptions().length) count += 1;
    if (AppState.moviesPendingMaxRuntime != null) count += 1;
    if ((AppState.moviesPendingSort || 'name') !== 'name') count += 1;
    return count;
}

function hasAnyMoviesPendingConstraint() {
    return getMoviesPendingActiveCount() > 0 || Boolean((AppState.moviesPendingSearch || '').trim());
}

function ensureMoviesPendingFilterShell(filtersEl) {
    if (filtersEl.dataset.shellReady === '1') return;
    filtersEl.dataset.shellReady = '1';
    filtersEl.innerHTML = `
        <div class="tvst-movies-filters-bar">
            <div class="tvst-profile-search-wrap tvst-movies-search-wrap">
                <svg class="tvst-profile-search-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
                <input type="text" inputmode="search" id="movies-pending-search" class="tvst-profile-search" placeholder="Buscar película, género o año…" autocomplete="off">
                <button type="button" id="movies-pending-search-clear" class="tvst-search-clear hidden" aria-label="Limpiar búsqueda">${UI_ICONS.closeSm}</button>
            </div>
            <button type="button" class="tvst-movies-filters-toggle" data-filter-toggle="1" aria-expanded="false">
                <span data-filter-toggle-label="1">Filtros</span>
                <svg class="tvst-movies-filters-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
            </button>
            <button type="button" class="tvst-movies-random-btn" data-random-movie="1" title="Elegir película al azar" aria-label="Elegir película al azar">
                ${UI_ICONS.dice}
                <span class="tvst-movies-random-label">Al azar</span>
            </button>
        </div>
        <div id="movies-pending-quick-bar" class="tvst-movies-quick-bar hidden"></div>
        <div id="movies-pending-active-bar" class="tvst-active-filters-bar hidden"></div>
        <div class="tvst-movies-filters-panel hidden" data-filter-panel="1"></div>
    `;

    const searchEl = filtersEl.querySelector('#movies-pending-search');
    const clearEl = filtersEl.querySelector('#movies-pending-search-clear');
    if (searchEl) {
        searchEl.addEventListener('input', () => {
            const val = searchEl.value || '';
            if (clearEl) clearEl.classList.toggle('hidden', !val.trim());
            clearTimeout(moviesPendingSearchDebounceTimer);
            moviesPendingSearchDebounceTimer = setTimeout(() => {
                AppState.moviesPendingSearch = val;
                const pending = getMoviesPendingBaseList();
                renderMoviesPendingActiveBar(pending);
                applyMoviesPendingFilters(pending);
            }, 130);
        });
    }
    if (clearEl) {
        clearEl.addEventListener('click', () => {
            clearTimeout(moviesPendingSearchDebounceTimer);
            AppState.moviesPendingSearch = '';
            if (searchEl) {
                searchEl.value = '';
                searchEl.focus();
            }
            clearEl.classList.add('hidden');
            const pending = getMoviesPendingBaseList();
            renderMoviesPendingActiveBar(pending);
            applyMoviesPendingFilters(pending);
        });
    }

    filtersEl.addEventListener('click', (event) => {
        const toggle = event.target.closest('[data-filter-toggle]');
        if (toggle && filtersEl.contains(toggle)) {
            event.preventDefault();
            toggleMoviesPendingFilters();
            return;
        }
        const randomBtn = event.target.closest('[data-random-movie]');
        if (randomBtn && filtersEl.contains(randomBtn)) {
            event.preventDefault();
            pickRandomPendingMovie();
            return;
        }
        const resetBtn = event.target.closest('[data-reset-pending-filters]');
        if (resetBtn && filtersEl.contains(resetBtn)) {
            event.preventDefault();
            resetMoviesPendingFilters();
            return;
        }
        const removeBtn = event.target.closest('[data-remove-active]');
        if (removeBtn && filtersEl.contains(removeBtn)) {
            event.preventDefault();
            removeActivePendingFilter(removeBtn.dataset.removeActive, removeBtn.dataset.removeValue || '');
            return;
        }
        const mySubsBtn = event.target.closest('[data-my-subs-toggle]');
        if (mySubsBtn && filtersEl.contains(mySubsBtn)) {
            event.preventDefault();
            toggleMoviesPendingMySubsOnly();
            return;
        }
        const btn = event.target.closest('.tvst-filter-chip');
        if (!btn || !filtersEl.contains(btn)) return;
        const key = btn.dataset.filterKey;
        const value = btn.dataset.filterValue;
        if (key === 'sort') setMoviesPendingSort(value);
        else if (key === 'genre') toggleMoviesPendingGenre(value);
        else if (key === 'platform') toggleMoviesPendingPlatform(value);
        else if (key === 'runtime-preset') {
            if (value === 'all') {
                const { sliderMax } = getMoviesPendingRuntimeBounds(getMoviesPendingBaseList());
                setMoviesPendingMaxRuntime(sliderMax);
            } else {
                setMoviesPendingMaxRuntime(Number(value));
            }
        }
    });
}

function toggleMoviesPendingMySubsOnly() {
    AppState.moviesPendingMySubsOnly = !AppState.moviesPendingMySubsOnly;
    renderMoviesPendingList();
}

function renderMoviesPendingActiveBar(pending) {
    const bar = document.getElementById('movies-pending-active-bar');
    if (!bar) return;
    const total = pending.length;
    const filteredCount = pending.filter(movieMatchesPendingFilters).length;
    const hasConstraints = hasAnyMoviesPendingConstraint();

    if (!total) {
        bar.classList.add('hidden');
        bar.innerHTML = '';
        return;
    }

    const pills = [];
    const search = (AppState.moviesPendingSearch || '').trim();
    if (search) {
        pills.push(`<button type="button" class="tvst-active-chip" data-remove-active="search">${escapeHtml(`“${search}”`)} ${UI_ICONS.closeSm}</button>`);
    }
    if ((AppState.moviesPendingSort || 'name') !== 'name') {
        pills.push(`<button type="button" class="tvst-active-chip" data-remove-active="sort">${escapeHtml(getMoviesPendingSortLabel(AppState.moviesPendingSort))} ${UI_ICONS.closeSm}</button>`);
    }
    if (AppState.moviesPendingMySubsOnly && getMySubscriptions().length) {
        pills.push(`<button type="button" class="tvst-active-chip" data-remove-active="mysubs">Mis plataformas ${UI_ICONS.closeSm}</button>`);
    }
    for (const g of (AppState.moviesPendingGenres || [])) {
        pills.push(`<button type="button" class="tvst-active-chip" data-remove-active="genre" data-remove-value="${escapeHtml(g)}">${escapeHtml(g)} ${UI_ICONS.closeSm}</button>`);
    }
    for (const p of (AppState.moviesPendingPlatforms || [])) {
        pills.push(`<button type="button" class="tvst-active-chip" data-remove-active="platform" data-remove-value="${escapeHtml(p)}">${escapeHtml(p)} ${UI_ICONS.closeSm}</button>`);
    }
    if (AppState.moviesPendingMaxRuntime != null) {
        pills.push(`<button type="button" class="tvst-active-chip" data-remove-active="runtime">≤ ${AppState.moviesPendingMaxRuntime} min ${UI_ICONS.closeSm}</button>`);
    }

    if (!hasConstraints) {
        bar.classList.remove('hidden');
        bar.innerHTML = `<span class="tvst-active-count">${total} ${total === 1 ? 'película pendiente' : 'películas pendientes'}</span>`;
        return;
    }

    bar.classList.remove('hidden');
    bar.innerHTML = `
        <span class="tvst-active-count">${filteredCount} de ${total}</span>
        <div class="tvst-active-chips-wrap">
            ${pills.join('')}
            <button type="button" class="tvst-active-clear" data-reset-pending-filters="1">Limpiar</button>
        </div>
    `;
}

function removeActivePendingFilter(kind, value) {
    if (kind === 'search') {
        AppState.moviesPendingSearch = '';
        const searchEl = document.getElementById('movies-pending-search');
        const clearEl = document.getElementById('movies-pending-search-clear');
        if (searchEl) searchEl.value = '';
        if (clearEl) clearEl.classList.add('hidden');
    } else if (kind === 'sort') {
        AppState.moviesPendingSort = 'name';
    } else if (kind === 'mysubs') {
        AppState.moviesPendingMySubsOnly = false;
    } else if (kind === 'genre') {
        AppState.moviesPendingGenres = (AppState.moviesPendingGenres || []).filter(g => g !== value);
    } else if (kind === 'platform') {
        AppState.moviesPendingPlatforms = (AppState.moviesPendingPlatforms || []).filter(p => p !== value);
    } else if (kind === 'runtime') {
        AppState.moviesPendingMaxRuntime = null;
    }
    renderMoviesPendingList();
}

function resetMoviesPendingFilters() {
    clearTimeout(moviesPendingSearchDebounceTimer);
    AppState.moviesPendingSearch = '';
    AppState.moviesPendingSort = 'name';
    AppState.moviesPendingGenres = [];
    AppState.moviesPendingPlatforms = [];
    AppState.moviesPendingMySubsOnly = false;
    AppState.moviesPendingMaxRuntime = null;
    const searchEl = document.getElementById('movies-pending-search');
    const clearEl = document.getElementById('movies-pending-search-clear');
    if (searchEl) searchEl.value = '';
    if (clearEl) clearEl.classList.add('hidden');
    renderMoviesPendingList();
}

function renderMoviesPendingFilters(pending) {
    const filtersEl = document.getElementById('movies-pending-filters');
    if (!filtersEl) return;

    if (!pending.length && !hasAnyMoviesPendingConstraint()) {
        filtersEl.classList.add('hidden');
        return;
    }
    filtersEl.classList.remove('hidden');

    ensureMoviesPendingFilterShell(filtersEl);

    const searchEl = filtersEl.querySelector('#movies-pending-search');
    const clearEl = filtersEl.querySelector('#movies-pending-search-clear');
    if (searchEl && document.activeElement !== searchEl) {
        searchEl.value = AppState.moviesPendingSearch || '';
    }
    if (clearEl) {
        clearEl.classList.toggle('hidden', !(AppState.moviesPendingSearch || '').trim());
    }

    const mySubs = getMySubscriptions();
    const quickBar = filtersEl.querySelector('#movies-pending-quick-bar');
    if (quickBar) {
        if (mySubs.length && pending.length) {
            quickBar.classList.remove('hidden');
            quickBar.innerHTML = `<button type="button" class="tvst-movies-quick-pill${AppState.moviesPendingMySubsOnly ? ' is-active' : ''}" data-my-subs-toggle="1">Solo mis plataformas (${mySubs.length})</button>`;
        } else {
            AppState.moviesPendingMySubsOnly = false;
            quickBar.classList.add('hidden');
            quickBar.innerHTML = '';
        }
    }

    const availableGenres = new Set(pending.flatMap(m => m.generos || []).filter(Boolean));
    AppState.moviesPendingGenres = (AppState.moviesPendingGenres || []).filter(g => availableGenres.has(g));
    const availablePlatforms = new Set(getPendingPlatformChipValues(pending));
    AppState.moviesPendingPlatforms = (AppState.moviesPendingPlatforms || [])
        .map(p => (p === PROVIDER_OTHER ? p : normalizeProviderName(p)))
        .filter(p => availablePlatforms.has(p));

    const genres = orderFilterChipValues([...availableGenres], AppState.moviesPendingGenres);
    const platforms = orderFilterChipValues([...availablePlatforms], AppState.moviesPendingPlatforms);

    const { sliderMin, sliderMax } = getMoviesPendingRuntimeBounds(pending);
    const maxRuntime = AppState.moviesPendingMaxRuntime;
    const sliderValue = maxRuntime == null ? sliderMax : Math.min(sliderMax, Math.max(sliderMin, maxRuntime));
    const runtimeLabel = maxRuntime == null ? 'Sin límite' : `Hasta ${maxRuntime} min`;

    const sortMode = AppState.moviesPendingSort || 'name';
    const open = Boolean(AppState.moviesPendingFiltersOpen);
    const activeCount = getMoviesPendingActiveCount();

    filtersEl.className = `tvst-movies-filters${open ? ' is-open' : ''}`;
    const toggleBtn = filtersEl.querySelector('[data-filter-toggle]');
    const toggleLabel = filtersEl.querySelector('[data-filter-toggle-label]');
    const panelEl = filtersEl.querySelector('[data-filter-panel]');
    if (toggleBtn) toggleBtn.setAttribute('aria-expanded', String(open));
    if (toggleLabel) toggleLabel.textContent = activeCount ? `Filtros · ${activeCount}` : 'Filtros';

    const chip = (label, active, filterKey, value) => `
        <button type="button"
            class="tvst-filter-chip${active ? ' is-active' : ''}"
            data-filter-key="${escapeHtml(filterKey)}"
            data-filter-value="${escapeHtml(value)}">
            ${escapeHtml(label)}
        </button>
    `;

    const sortOptions = [
        { id: 'name', label: 'Nombre A–Z' },
        { id: 'tmdb', label: 'Nota TMDB' },
        { id: 'runtime-asc', label: 'Más cortas' },
        { id: 'recent-release', label: 'Estreno reciente' },
        { id: 'recent-added', label: 'Añadidas' },
    ];

    const runtimePresets = [
        { value: 'all', label: 'Sin límite', active: maxRuntime == null },
        { value: '95', label: '≤ 95 min', active: maxRuntime === 95 },
        { value: '120', label: '≤ 120 min', active: maxRuntime === 120 },
        { value: '150', label: '≤ 150 min', active: maxRuntime === 150 },
    ];

    if (panelEl) {
        panelEl.classList.toggle('hidden', !open);
        panelEl.innerHTML = `
            <div class="tvst-filter-row" aria-label="Ordenar por">
                <span class="tvst-filter-row-label">Ordenar</span>
                <div class="tvst-filter-chips" data-filter-group="sort">
                    ${sortOptions.map(o => chip(o.label, sortMode === o.id, 'sort', o.id)).join('')}
                </div>
            </div>
            <div class="tvst-filter-row" aria-label="Género">
                <span class="tvst-filter-row-label">Género (multiselección)</span>
                <div class="tvst-filter-chips" data-filter-group="genre">
                    ${chip('Todas', !(AppState.moviesPendingGenres || []).length, 'genre', 'all')}
                    ${genres.map(g => chip(g, AppState.moviesPendingGenres.includes(g), 'genre', g)).join('')}
                </div>
            </div>
            <div class="tvst-filter-row" aria-label="Plataforma">
                <span class="tvst-filter-row-label">Plataforma (multiselección)</span>
                <div class="tvst-filter-chips" data-filter-group="platform">
                    ${chip('Todas', !(AppState.moviesPendingPlatforms || []).length, 'platform', 'all')}
                    ${platforms.map(p => chip(p, AppState.moviesPendingPlatforms.includes(p), 'platform', p)).join('')}
                </div>
            </div>
            <div class="tvst-filter-runtime">
                <div class="tvst-filter-runtime-head">
                    <span class="tvst-filter-row-label">Duración máx.</span>
                    <span class="tvst-filter-runtime-value" id="movies-pending-runtime-label">${escapeHtml(runtimeLabel)}</span>
                </div>
                <div class="tvst-filter-chips tvst-filter-presets" data-filter-group="runtime-preset">
                    ${runtimePresets.map(r => chip(r.label, r.active, 'runtime-preset', r.value)).join('')}
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
        `;

        const rangeEl = document.getElementById('movies-pending-runtime-range');
        if (rangeEl) {
            rangeEl.addEventListener('input', () => {
                setMoviesPendingMaxRuntime(rangeEl.value, { live: true });
            });
        }
    }

    renderMoviesPendingActiveBar(pending);
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

function setMoviesPendingSort(mode) {
    AppState.moviesPendingSort = mode || 'name';
    renderMoviesPendingList();
}

function toggleMoviesPendingGenre(genre) {
    if (!genre || genre === 'all') {
        AppState.moviesPendingGenres = [];
    } else {
        const current = AppState.moviesPendingGenres || [];
        AppState.moviesPendingGenres = current.includes(genre)
            ? current.filter(g => g !== genre)
            : [...current, genre];
    }
    renderMoviesPendingList();
}

function toggleMoviesPendingPlatform(platform) {
    if (!platform || platform === 'all') {
        AppState.moviesPendingPlatforms = [];
    } else {
        const current = AppState.moviesPendingPlatforms || [];
        AppState.moviesPendingPlatforms = current.includes(platform)
            ? current.filter(p => p !== platform)
            : [...current, platform];
    }
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

    document.querySelectorAll('#movies-pending-filters [data-filter-key="runtime-preset"]').forEach(btn => {
        const val = btn.dataset.filterValue;
        const active = val === 'all'
            ? AppState.moviesPendingMaxRuntime == null
            : AppState.moviesPendingMaxRuntime === Number(val);
        btn.classList.toggle('is-active', active);
    });

    const toggleLabel = document.querySelector('#movies-pending-filters [data-filter-toggle-label]');
    if (toggleLabel) {
        const activeCount = getMoviesPendingActiveCount();
        toggleLabel.textContent = activeCount ? `Filtros · ${activeCount}` : 'Filtros';
    }

    if (options.live) {
        renderMoviesPendingActiveBar(pending);
        applyMoviesPendingFilters(pending);
        return;
    }
    renderMoviesPendingList();
}

function pickRandomPendingMovie() {
    clearTimeout(moviesPendingSearchDebounceTimer);
    const searchEl = document.getElementById('movies-pending-search');
    if (searchEl && searchEl.value !== AppState.moviesPendingSearch) {
        AppState.moviesPendingSearch = searchEl.value;
        const pending = getMoviesPendingBaseList();
        renderMoviesPendingActiveBar(pending);
        applyMoviesPendingFilters(pending);
    }

    const container = document.getElementById('movies-pending-list-container');
    const visibleIds = container
        ? [...container.querySelectorAll('.tvst-poster-cell[data-tmdb-id]')]
            .map(el => Number(el.dataset.tmdbId))
            .filter(id => Number.isFinite(id) && id > 0)
        : [];
    const visibleSet = new Set(visibleIds);
    const candidates = visibleSet.size
        ? getMoviesPendingBaseList()
            .filter(movieMatchesPendingFilters)
            .filter(m => visibleSet.has(Number(m.id_tmdb)))
        : [];

    if (!candidates.length) {
        showToast('No hay películas visibles con los filtros actuales', 'info');
        return;
    }

    const pool = candidates.length > 1
        ? candidates.filter(m => Number(m.id_tmdb) !== Number(window.__lastRandomPendingMovieId))
        : candidates;
    const effectivePool = pool.length ? pool : candidates;
    const pick = effectivePool[Math.floor(Math.random() * effectivePool.length)];
    window.__lastRandomPendingMovieId = Number(pick.id_tmdb);

    showToast(`Al azar (${candidates.length} ${candidates.length === 1 ? 'visible' : 'visibles'}): ${pick.titulo || 'Película'}`, 'info');
    openDetail('movie', pick.id_tmdb);
}

function applyMoviesPendingFilters(basePending = null) {
    const container = document.getElementById('movies-pending-list-container');
    if (!container) return;

    const pending = basePending || getMoviesPendingBaseList();
    const filtered = sortMoviesPendingList(pending.filter(movieMatchesPendingFilters));

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
            subtitle: 'Prueba a cambiar búsqueda, género, plataforma o duración.',
            actionLabel: 'Limpiar filtros',
            actionOnClick: 'resetMoviesPendingFilters()',
        });
    } else {
        container.innerHTML = renderMoviePosterGrid(filtered, { showWatchToggle: true });
    }
}

async function ensureMovieFilterMeta(pending) {
    const missing = pending.filter(m => (
        !attemptedMovieFilterMetaIds.has(m.id_tmdb)
        && (!Array.isArray(m.generos) || !m.generos.length || !(Number(m.runtime) > 0))
    ));
    const fetchMeta = typeof getMovieFilterMeta === 'function'
        ? getMovieFilterMeta
        : (typeof getMovieDetails === 'function' ? getMovieDetails : null);
    if (!missing.length || !fetchMeta) return false;

    let changed = false;
    const batch = missing.slice(0, 12);
    await mapPool(batch, 4, async (movie) => {
        attemptedMovieFilterMetaIds.add(movie.id_tmdb);
        try {
            const details = await fetchMeta(movie.id_tmdb);
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
        }
    });
    if (changed) saveLocalData();
    return changed;
}

function getMoviesNeedingRegionalReleaseDate(country = getPreferredProviderCountry()) {
    return AppState.movies.filter((movie) => {
        if (normalizeStatus(movie.estado) === 'completed') return false;
        if (movie.release_date_country === country) return false;
        if (attemptedMovieReleaseSyncKeys.has(`${country}:${movie.id_tmdb}`)) return false;
        const days = getDaysUntilRelease(movie.fecha_estreno);
        return days === null || days >= -30;
    });
}

async function ensureUpcomingMovieReleaseDates() {
    if (window.__seenitMovieReleaseHydrating) return false;
    if (typeof window.getMovieRegionalReleaseDate !== 'function') return false;

    const country = getPreferredProviderCountry();
    const candidates = getMoviesNeedingRegionalReleaseDate(country);
    if (!candidates.length) return false;

    window.__seenitMovieReleaseHydrating = true;
    let dateChanged = false;
    let metaSaved = false;

    try {
        const batch = candidates.slice(0, 20);
        await mapPool(batch, 4, async (movie) => {
            const attemptKey = `${country}:${movie.id_tmdb}`;
            attemptedMovieReleaseSyncKeys.add(attemptKey);
            try {
                const res = await window.getMovieRegionalReleaseDate(movie.id_tmdb, country);
                if (res?.fecha_estreno && res.fecha_estreno !== movie.fecha_estreno) {
                    movie.fecha_estreno = res.fecha_estreno;
                    dateChanged = true;
                }
                if (movie.release_date_country !== country) {
                    movie.release_date_country = country;
                    metaSaved = true;
                }
            } catch (error) {
                console.warn('[App] Fecha estreno regional:', movie.titulo, error);
            }
        });

        if (dateChanged || metaSaved) {
            saveLocalData();
        }
        if (dateChanged) {
            if (AppState.selectedItem?.tipo === 'movie') {
                const updatedSelected = AppState.movies.find(m => m.id_tmdb === AppState.selectedItem.id_tmdb);
                if (updatedSelected) {
                    AppState.selectedItem = { ...updatedSelected, tipo: 'movie' };
                    updateDetailHero(AppState.selectedItem);
                    renderDetailInfo(AppState.selectedItem);
                }
            }
            if (AppState.currentTab === 'movies') {
                renderMoviesView();
            }
        }
        return dateChanged;
    } finally {
        window.__seenitMovieReleaseHydrating = false;
    }
}

function renderMoviesPendingList() {
    const container = document.getElementById('movies-pending-list-container');
    if (!container) return;

    const pending = getMoviesPendingBaseList();
    renderMoviesPendingFilters(pending);
    applyMoviesPendingFilters();

    const country = getPreferredProviderCountry();
    if (getMoviesNeedingRegionalReleaseDate(country).length) {
        void ensureUpcomingMovieReleaseDates();
    }

    // Hidratar géneros/runtime y plataformas en background
    if (!window.__seenitMoviesFilterMetaHydrating) {
        const needsMeta = pending.some(m => (
            !attemptedMovieFilterMetaIds.has(m.id_tmdb)
            && (!Array.isArray(m.generos) || !m.generos.length || !(Number(m.runtime) > 0))
        ));
        const needsProviders = pending.some(m => (
            !Array.isArray(m.watch_providers)
            && !failedProviderFetchKeys.has(`movie:${m.id_tmdb}`)
        ));
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
                        while (
                            guard < 10
                            && AppState.movies.some(m => !Array.isArray(m.watch_providers) && !failedProviderFetchKeys.has(`movie:${m.id_tmdb}`))
                        ) {
                            const { fetchedCount } = await ensureProvidersForLibrary('movie');
                            if (fetchedCount > 0) shouldRerender = true;
                            if (fetchedCount === 0) break;
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

function toLocalDateKey(dateObj) {
    if (!(dateObj instanceof Date) || Number.isNaN(dateObj.getTime())) return '';
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const d = String(dateObj.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function getUpcomingWeekDates(weekOffset = 0) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dow = today.getDay(); // 0=Dom..6=Sab
    const diffToMonday = dow === 0 ? -6 : 1 - dow;
    const monday = new Date(today);
    monday.setDate(today.getDate() + diffToMonday + (Number(weekOffset) || 0) * 7);
    const days = [];
    for (let i = 0; i < 7; i += 1) {
        const d = new Date(monday);
        d.setDate(monday.getDate() + i);
        days.push(d);
    }
    return days;
}

function getUpcomingCalendarState(kind) {
    return kind === 'movies' ? AppState.upcomingMoviesCal : AppState.upcomingSeriesCal;
}

function renderUpcomingMiniCalendarHtml(kind, countsByDate, calState) {
    const safeKind = kind === 'movies' ? 'movies' : 'series';
    const weekOffset = Math.max(0, Number(calState?.weekOffset) || 0);
    const selectedDate = calState?.selectedDate || null;
    const weekDates = getUpcomingWeekDates(weekOffset);
    const todayKey = toLocalDateKey(new Date());
    const dowLabels = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];

    const startLabel = weekDates[0].toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
    const endLabel = weekDates[6].toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });

    let weekTotal = 0;
    for (const d of weekDates) {
        weekTotal += countsByDate.get(toLocalDateKey(d)) || 0;
    }

    const sortedAllDates = [...countsByDate.keys()].filter(k => k >= todayKey).sort();
    const nextFutureDate = sortedAllDates.find(k => k > toLocalDateKey(weekDates[6])) || sortedAllDates[0] || null;

    const daysHtml = weekDates.map((d, idx) => {
        const dateKey = toLocalDateKey(d);
        const count = countsByDate.get(dateKey) || 0;
        const isToday = dateKey === todayKey;
        const isPast = dateKey < todayKey;
        const isSelected = selectedDate === dateKey;
        const classes = [
            'tvst-minical-day',
            isToday ? 'is-today' : '',
            isPast ? 'is-past' : '',
            count > 0 ? 'has-events' : '',
            isSelected ? 'is-selected' : '',
        ].filter(Boolean).join(' ');
        const fullLabel = d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'short' });
        const indicator = count > 1
            ? `<span class="tvst-minical-badge">${count}</span>`
            : `<span class="tvst-minical-dot"></span>`;
        return `
            <button type="button" class="${classes}" onclick="selectUpcomingCalendarDate('${safeKind}', '${dateKey}')" aria-label="${escapeHtml(fullLabel)}${count ? `, ${count} estreno(s)` : ''}">
                <span class="tvst-minical-dow">${dowLabels[idx]}</span>
                <span class="tvst-minical-num">${d.getDate()}</span>
                ${indicator}
            </button>
        `;
    }).join('');

    let footerHtml = '';
    if (selectedDate) {
        const parsed = new Date(`${selectedDate}T00:00:00`);
        const selLabel = Number.isNaN(parsed.getTime())
            ? selectedDate
            : parsed.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });
        const selCount = countsByDate.get(selectedDate) || 0;
        footerHtml = `
            <div class="tvst-minical-footer">
                <span>Mostrando <strong>${escapeHtml(selLabel)}</strong> · ${selCount} ${selCount === 1 ? 'estreno' : 'estrenos'}</span>
                <button type="button" class="tvst-minical-footer-btn" onclick="selectUpcomingCalendarDate('${safeKind}', null)">Ver todos</button>
            </div>
        `;
    } else if (weekTotal === 0 && nextFutureDate) {
        footerHtml = `
            <div class="tvst-minical-footer">
                <span>Sin estrenos esta semana · próximo el ${escapeHtml(formatAirDateShort(nextFutureDate))}</span>
                <button type="button" class="tvst-minical-footer-btn" onclick="jumpToUpcomingCalendarDate('${safeKind}', '${escapeHtml(nextFutureDate)}')">Ir</button>
            </div>
        `;
    }

    const weekCountLabel = weekTotal > 0
        ? `${weekTotal} ${weekTotal === 1 ? 'estreno esta semana' : 'estrenos esta semana'}`
        : 'Sin estrenos esta semana';

    return `
        <section class="tvst-minical" aria-label="Minicalendario de estrenos">
            <div class="tvst-minical-head">
                <div class="tvst-minical-title-wrap">
                    <span class="tvst-minical-range">${escapeHtml(startLabel)} – ${escapeHtml(endLabel)}</span>
                    <span class="tvst-minical-count">${escapeHtml(weekCountLabel)}</span>
                </div>
                <div class="tvst-minical-nav">
                    ${(weekOffset > 0 || selectedDate)
                        ? `<button type="button" class="tvst-minical-reset" onclick="resetUpcomingCalendar('${safeKind}')">Hoy</button>`
                        : ''}
                    <button type="button" class="tvst-minical-nav-btn" onclick="shiftUpcomingCalendarWeek('${safeKind}', -1)" ${weekOffset <= 0 ? 'disabled' : ''} aria-label="Semana anterior">
                        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M15 18l-6-6 6-6"/></svg>
                    </button>
                    <button type="button" class="tvst-minical-nav-btn" onclick="shiftUpcomingCalendarWeek('${safeKind}', 1)" aria-label="Semana siguiente">
                        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M9 18l6-6-6-6"/></svg>
                    </button>
                </div>
            </div>
            <div class="tvst-minical-grid">${daysHtml}</div>
            ${footerHtml}
        </section>
    `;
}

function rerenderUpcomingByKind(kind) {
    if (kind === 'movies') {
        renderMoviesUpcomingList();
        return;
    }
    const container = document.getElementById('upcoming-list-container');
    if (container && Array.isArray(AppState.timelineUpcomingCache?.items)) {
        paintUpcomingSeriesView(AppState.timelineUpcomingCache.items, container);
    } else {
        void renderUpcomingList();
    }
}

function shiftUpcomingCalendarWeek(kind, delta) {
    const cal = getUpcomingCalendarState(kind);
    cal.weekOffset = Math.max(0, (Number(cal.weekOffset) || 0) + (Number(delta) || 0));
    rerenderUpcomingByKind(kind);
}

function selectUpcomingCalendarDate(kind, dateKey) {
    const cal = getUpcomingCalendarState(kind);
    if (!dateKey || cal.selectedDate === dateKey) {
        cal.selectedDate = null;
    } else {
        cal.selectedDate = String(dateKey).slice(0, 10);
    }
    rerenderUpcomingByKind(kind);
}

function resetUpcomingCalendar(kind) {
    const cal = getUpcomingCalendarState(kind);
    cal.weekOffset = 0;
    cal.selectedDate = null;
    rerenderUpcomingByKind(kind);
}

function jumpToUpcomingCalendarDate(kind, dateKey) {
    const cal = getUpcomingCalendarState(kind);
    const target = new Date(`${String(dateKey).slice(0, 10)}T00:00:00`);
    if (Number.isNaN(target.getTime())) return;
    const baseMonday = getUpcomingWeekDates(0)[0];
    const targetDow = target.getDay();
    const targetMonday = new Date(target);
    targetMonday.setDate(target.getDate() + (targetDow === 0 ? -6 : 1 - targetDow));
    const diffWeeks = Math.max(0, Math.round((targetMonday - baseMonday) / (7 * 86400000)));
    cal.weekOffset = diffWeeks;
    cal.selectedDate = String(dateKey).slice(0, 10);
    rerenderUpcomingByKind(kind);
}

function renderMoviesUpcomingList() {
    const container = document.getElementById('movies-upcoming-list-container');
    if (!container) return;

    const country = getPreferredProviderCountry();
    if (getMoviesNeedingRegionalReleaseDate(country).length) {
        void ensureUpcomingMovieReleaseDates();
    }

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

    const countsByDate = new Map();
    for (const movie of upcoming) {
        const key = String(movie.fecha_estreno || '').slice(0, 10);
        if (key) countsByDate.set(key, (countsByDate.get(key) || 0) + 1);
    }

    const calEnabled = isUpcomingMiniCalendarEnabled();
    const calHtml = calEnabled ? renderUpcomingMiniCalendarHtml('movies', countsByDate, AppState.upcomingMoviesCal) : '';
    const selectedDate = calEnabled ? AppState.upcomingMoviesCal?.selectedDate : null;
    const visibleMovies = selectedDate
        ? upcoming.filter(m => String(m.fecha_estreno || '').slice(0, 10) === selectedDate)
        : upcoming;

    if (!visibleMovies.length) {
        container.innerHTML = calHtml + emptyState(
            'calendar',
            'Sin estrenos este día',
            {
                subtitle: 'No hay películas pendientes programadas para la fecha seleccionada.',
                actionLabel: 'Ver todos los estrenos',
                actionOnClick: "selectUpcomingCalendarDate('movies', null)",
            },
        );
        return;
    }

    const grouped = visibleMovies.reduce((acc, movie) => {
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

    container.innerHTML = calHtml + labels.map(label => `
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
    const days = getInactivityDays();
    return Boolean(show?.continueBoostAt && getDaysSinceWatchActivity(show.continueBoostAt) <= days);
}

function isRecentlyAiredEpisode(episode) {
    if (!episode?.air_date) return false;
    const days = getDaysSinceAir(episode.air_date);
    return Number.isFinite(days) && days >= 0 && days <= getInactivityDays();
}

function applyContinueBoost(show, reason = '') {
    if (!show || isContinueBoostFresh(show)) return false;
    show.continueBoostAt = nowIso();
    touchUpdatedAt(show);
    if (reason) console.log('[App] continueBoost:', show.titulo || show.id_tmdb, reason);
    return true;
}

function isShowInContinueSection(show, nextEpisode = null) {
    const lastActivity = getShowLastWatchActivity(show);
    if (!lastActivity) {
        const watched = show?.capitulos_vistos?.length || 0;
        return watched === 0;
    }
    return getDaysSinceWatchActivity(lastActivity) <= getInactivityDays();
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
        : `<div class="tvst-poster-fallback">${UI_ICONS.tv}</div>`;

    let rightSide = '';
    if (showAction) {
        rightSide = `<button type="button" class="tvst-check-btn" onclick="event.stopPropagation(); toggleEpisode(${show.id_tmdb}, '${escapeHtml(String(episode.id || ''))}')" aria-label="Marcar visto">${UI_ICONS.check}</button>`;
    } else if (variant === 'history') {
        rightSide = `<span class="tvst-check-btn is-watched" aria-hidden="true">${UI_ICONS.check}</span>`;
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
    const hideSpoiler = shouldMaskEpisodeSpoilers(show, episode.id);
    const epTitleMarkup = episode.name
        ? (hideSpoiler
            ? `<p class="tvst-episode-title tvst-spoiler-mask">Título oculto</p>`
            : `<p class="tvst-episode-title">${escapeHtml(episode.name)}</p>`)
        : '';
    return `
        <article class="tvst-episode-row${variant === 'history' ? ' is-history' : ''}${normalizeStatus(show.estado) === 'standby' ? ' is-standby' : ''}"
            data-show-id="${show.id_tmdb}"
            data-episode-id="${epIdAttr}"
            onclick="openEpisodeDetail(${show.id_tmdb}, '${epIdAttr}')"
            onkeydown="handleEpisodeRowKeydown(event, ${show.id_tmdb}, '${epIdAttr}')"
            role="button" tabindex="0">
            <div class="tvst-episode-poster">${poster}</div>
            <div class="tvst-episode-body">
                <a href="#" onclick="event.stopPropagation(); openDetail('tv', ${show.id_tmdb});return false;" class="tvst-show-pill"><span>${escapeHtml(show.titulo || 'Sin título')}</span>${UI_ICONS.chevronRight}</a>
                <div class="tvst-episode-code-row">
                    <span class="tvst-episode-code">${escapeHtml(episodeCode)}</span>
                    ${remainingCount > 0 ? `<span class="tvst-remaining">+${remainingCount}</span>` : ''}
                </div>
                ${epTitleMarkup}
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
            container.innerHTML = renderSkeletonList(4, 'episodes');
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
            includeSpecials: shouldIncludeSpecials(),
            seasonNumbers: seasonHint,
        });
        let airedEpisodes = episodes.filter(isEpisodeAired);
        let nextEpisode = airedEpisodes.find(ep => !isEpisodeConsumed(show, ep.id));

        // Si no hay siguiente en el recorte, cargar todas las temporadas
        if (!nextEpisode) {
            episodes = await getOrderedEpisodes(show, { includeSpecials: shouldIncludeSpecials() });
            airedEpisodes = episodes.filter(isEpisodeAired);
            nextEpisode = airedEpisodes.find(ep => !isEpisodeConsumed(show, ep.id));
        }

        // Sin pendiente tras cargar todas las temporadas: solo revalidar meta si ya caducó el TTL
        if (!nextEpisode && (isShowMetaStale(show) || isContinueBoostFresh(show))) {
            const prevSeasons = countRegularSeasons(show);
            const prevLatestEpCount = getLatestRegularSeasonEpisodeCount(show);
            await ensureShowSeasonMeta(show, { force: true });
            const metaChanged = countRegularSeasons(show) !== prevSeasons
                || getLatestRegularSeasonEpisodeCount(show) !== prevLatestEpCount;
            if (metaChanged) {
                invalidateOrderedEpisodesCache(show.id_tmdb);
                const latest = getLatestRegularSeasonNumber(show);
                const retryHint = [...new Set([
                    ...watchedSeasons.slice(-2),
                    ...getUpcomingSeasonNumbers(show),
                    ...(latest != null ? [latest] : []),
                ])];
                episodes = await getOrderedEpisodes(show, {
                    includeSpecials: shouldIncludeSpecials(),
                    seasonNumbers: retryHint.length ? retryHint : undefined,
                });
                airedEpisodes = episodes.filter(isEpisodeAired);
                nextEpisode = airedEpisodes.find(ep => !isEpisodeConsumed(show, ep.id));
                if (!nextEpisode) {
                    episodes = await getOrderedEpisodes(show, { includeSpecials: shouldIncludeSpecials() });
                    airedEpisodes = episodes.filter(isEpisodeAired);
                    nextEpisode = airedEpisodes.find(ep => !isEpisodeConsumed(show, ep.id));
                }
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
            includeSpecials: shouldIncludeSpecials(),
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
        container.innerHTML = renderSkeletonList(5, 'episodes');
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
        && Array.isArray(AppState.timelineUpcomingCache.items);

    if (cacheFresh) {
        paintUpcomingSeriesView(AppState.timelineUpcomingCache.items, container);
        requestAnimationFrame(() => setScrollTop(0, 'auto'));
        void (async () => {
            const didReopen = await reopenPromise;
            if (didReopen) {
                const shows = AppState.shows.filter(show => normalizeStatus(show.estado) !== 'dropped');
                await rebuildUpcomingTimeline(shows, container);
            }
        })().catch(() => {});
        return;
    }

    container.innerHTML = renderSkeletonList(5, 'upcoming');
    await rebuildUpcomingTimeline(upcomingShows, container);
    const didReopen = await reopenPromise;
    if (didReopen) {
        const shows = AppState.shows.filter(show => normalizeStatus(show.estado) !== 'dropped');
        await rebuildUpcomingTimeline(shows, container);
    }
}

function isShowOfficiallyEnded(show) {
    const st = String(show?.status || '').trim().toLowerCase();
    return st === 'ended' || st === 'canceled' || st === 'cancelled';
}

function getUpcomingTargetSeasonsForShow(show) {
    const nextEp = show?.next_episode_to_air;
    if (nextEp && Number.isFinite(Number(nextEp.season_number))) {
        const nextDays = getDaysUntilAir(nextEp.air_date);
        if (nextDays != null && nextDays >= 0 && Number(nextEp.season_number) > 0) {
            const latest = getLatestRegularSeasonNumber(show);
            return latest && latest !== Number(nextEp.season_number)
                ? [Number(nextEp.season_number), latest]
                : [Number(nextEp.season_number)];
        }
    }
    const latest = getLatestRegularSeasonNumber(show);
    return latest != null ? [latest] : getUpcomingSeasonNumbers(show);
}

async function rebuildUpcomingTimeline(upcomingShows, container) {
    let metaUpdated = false;
    const chunks = await mapPool(upcomingShows, UPCOMING_FETCH_CONCURRENCY, async (show) => {
        const nextEp = show?.next_episode_to_air;
        const nextEpExpired = Boolean(
            nextEp && nextEp.air_date && getDaysUntilAir(nextEp.air_date) < 0,
        );
        // Si TMDB marcó finalizada/cancelada y no tiene próximo episodio futuro, omitir sin llamadas de red
        if (
            isShowOfficiallyEnded(show)
            && show.temporadas?.length
            && (!nextEp || nextEpExpired)
        ) {
            return [];
        }

        const prevMetaCheckedAt = show.metaCheckedAt || '';
        await ensureShowSeasonMeta(show, { force: nextEpExpired });
        if ((show.metaCheckedAt || '') !== prevMetaCheckedAt) {
            metaUpdated = true;
        }

        const refreshedNext = show?.next_episode_to_air;
        const refreshedDays = refreshedNext?.air_date ? getDaysUntilAir(refreshedNext.air_date) : null;
        if (
            isShowOfficiallyEnded(show)
            && show.temporadas?.length
            && (!refreshedNext || (refreshedDays != null && refreshedDays < 0))
        ) {
            return [];
        }
        if (refreshedNext === null && !isShowMetaStale(show)) {
            return [];
        }

        const seasonNumbers = getUpcomingTargetSeasonsForShow(show);
        const regularCount = countRegularSeasons(show);
        let episodes = await getOrderedEpisodes(show, {
            includeSpecials: shouldIncludeSpecials(),
            seasonNumbers: seasonNumbers.length ? seasonNumbers : undefined,
        });
        let future = episodes.filter(episode => {
            if (!episode.air_date) return false;
            const daysUntil = getDaysUntilAir(episode.air_date);
            return daysUntil != null && daysUntil >= 0;
        });

        // Solo re-escanear toda la serie si es corta y no vino next_episode_to_air confirmado
        if (!future.length && refreshedNext !== null && seasonNumbers.length && regularCount > 0 && regularCount <= 3) {
            episodes = await getOrderedEpisodes(show, { includeSpecials: shouldIncludeSpecials() });
            future = episodes.filter(episode => {
                if (!episode.air_date) return false;
                const daysUntil = getDaysUntilAir(episode.air_date);
                return daysUntil != null && daysUntil >= 0;
            });
        }

        const airedEpisodes = episodes.filter(isEpisodeAired);
        return future.map(episode => ({ show, episode, airedEpisodes }));
    });

    if (metaUpdated) {
        saveLocalData();
    }

    const upcomingEpisodes = chunks.flat();
    upcomingEpisodes.sort((a, b) => (a.episode.air_date || '9999').localeCompare(b.episode.air_date || '9999'));

    const html = paintUpcomingSeriesView(upcomingEpisodes, container);
    AppState.timelineUpcomingCache = { html, builtAt: Date.now(), items: upcomingEpisodes };

    requestAnimationFrame(() => setScrollTop(0, 'auto'));
}

function paintUpcomingSeriesView(upcomingEpisodes, container) {
    if (!container) return '';
    if (!upcomingEpisodes || upcomingEpisodes.length === 0) {
        const emptyHtml = emptyState(
            'calendar',
            'Sin episodios programados',
            { subtitle: 'No hay próximos estrenos de episodios en tus series.' },
        );
        container.innerHTML = emptyHtml;
        return emptyHtml;
    }

    const countsByDate = new Map();
    for (const item of upcomingEpisodes) {
        const key = String(item?.episode?.air_date || '').slice(0, 10);
        if (key) countsByDate.set(key, (countsByDate.get(key) || 0) + 1);
    }

    const calEnabled = isUpcomingMiniCalendarEnabled();
    const calHtml = calEnabled ? renderUpcomingMiniCalendarHtml('series', countsByDate, AppState.upcomingSeriesCal) : '';
    const selectedDate = calEnabled ? AppState.upcomingSeriesCal?.selectedDate : null;
    const visibleEpisodes = selectedDate
        ? upcomingEpisodes.filter(item => String(item?.episode?.air_date || '').slice(0, 10) === selectedDate)
        : upcomingEpisodes;

    if (!visibleEpisodes.length) {
        const html = calHtml + emptyState(
            'calendar',
            'Sin episodios este día',
            {
                subtitle: 'No hay episodios programados para la fecha seleccionada.',
                actionLabel: 'Ver todos los estrenos',
                actionOnClick: "selectUpcomingCalendarDate('series', null)",
            },
        );
        container.className = 'tvst-episode-list';
        container.innerHTML = html;
        return html;
    }

    const groupedUpcoming = visibleEpisodes.reduce((acc, item) => {
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
    const html = calHtml + dayKeys.map(label => `
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
    return html;
}

function invalidateTimelineCaches() {
    AppState.timelinePendingCache = { continueWatching: [], staleWatching: [], builtAt: 0 };
    AppState.timelineUpcomingCache = { html: '', builtAt: 0, items: [] };
}

async function prefetchTimelineSeasons() {
    const watching = AppState.shows.filter(s => normalizeStatus(s.estado) === 'watching');
    const completedStale = AppState.shows.filter(s =>
        normalizeStatus(s.estado) === 'completed'
        && !isShowOfficiallyEnded(s)
        && isShowMetaStale(s)
    ).slice(0, 8);
    const upcoming = AppState.shows
        .filter(s => normalizeStatus(s.estado) !== 'dropped' && !isShowOfficiallyEnded(s))
        .slice(0, 12);
    const targets = [...new Map(
        [...watching, ...completedStale, ...upcoming].map(s => [s.id_tmdb, s]),
    ).values()];
    await mapPool(targets, TIMELINE_FETCH_CONCURRENCY, async (show) => {
        await ensureShowSeasonMeta(show);
        if (show.next_episode_to_air === null && normalizeStatus(show.estado) !== 'watching') {
            return;
        }
        const seasons = [
            ...getWatchedSeasonNumbers(show).slice(-1),
            ...getUpcomingTargetSeasonsForShow(show),
        ];
        if (!seasons.length) return;
        await getOrderedEpisodes(show, { includeSpecials: shouldIncludeSpecials(), seasonNumbers: [...new Set(seasons)] });
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
function syncProfileSearchClearButton(kind) {
    const isMovies = kind === 'movies';
    const inputEl = document.getElementById(isMovies ? 'profile-movies-search' : 'profile-series-search');
    const clearEl = document.getElementById(isMovies ? 'profile-movies-search-clear' : 'profile-series-search-clear');
    if (!inputEl || !clearEl) return;
    clearEl.classList.toggle('hidden', !String(inputEl.value || '').trim());
}

function onProfileSearchInput(kind) {
    const isMovies = kind === 'movies';
    const inputEl = document.getElementById(isMovies ? 'profile-movies-search' : 'profile-series-search');
    const value = inputEl?.value || '';
    syncProfileSearchClearButton(kind);
    clearTimeout(profileSearchDebounceTimer);
    profileSearchDebounceTimer = setTimeout(() => {
        if (isMovies) AppState.profileMoviesSearch = value;
        else AppState.profileSeriesSearch = value;
        paintProfileLibrary({ onlyLibrary: true });
    }, 140);
}

function clearProfileSearch(kind) {
    clearTimeout(profileSearchDebounceTimer);
    const isMovies = kind === 'movies';
    const inputEl = document.getElementById(isMovies ? 'profile-movies-search' : 'profile-series-search');
    if (inputEl) {
        inputEl.value = '';
        inputEl.focus();
    }
    if (isMovies) AppState.profileMoviesSearch = '';
    else AppState.profileSeriesSearch = '';
    syncProfileSearchClearButton(kind);
    paintProfileLibrary({ onlyLibrary: true });
}

function resetProfileFilters(kind) {
    clearTimeout(profileSearchDebounceTimer);
    const isMovies = kind === 'movies';
    const searchEl = document.getElementById(isMovies ? 'profile-movies-search' : 'profile-series-search');
    const filterEl = document.getElementById(isMovies ? 'profile-movies-filter' : 'profile-series-filter');
    const platformEl = document.getElementById(isMovies ? 'profile-movies-platform' : 'profile-series-platform');
    if (searchEl) searchEl.value = '';
    if (filterEl) filterEl.value = 'all';
    if (platformEl) platformEl.value = 'all';
    if (isMovies) {
        AppState.profileMoviesSearch = '';
        AppState.profileMoviesFilter = 'all';
        AppState.profileMoviesPlatform = 'all';
    } else {
        AppState.profileSeriesSearch = '';
        AppState.profileSeriesFilter = 'all';
        AppState.profileSeriesPlatform = 'all';
    }
    syncProfileSearchClearButton(kind);
    paintProfileLibrary({ onlyLibrary: true });
}

async function renderProfileView() {
    AppState.profileSeriesFilter = document.getElementById('profile-series-filter')?.value || AppState.profileSeriesFilter;
    AppState.profileMoviesFilter = document.getElementById('profile-movies-filter')?.value || AppState.profileMoviesFilter;
    AppState.profileSeriesSearch = document.getElementById('profile-series-search')?.value || '';
    AppState.profileMoviesSearch = document.getElementById('profile-movies-search')?.value || '';
    AppState.profileSeriesPlatform = document.getElementById('profile-series-platform')?.value || AppState.profileSeriesPlatform;
    AppState.profileMoviesPlatform = document.getElementById('profile-movies-platform')?.value || AppState.profileMoviesPlatform;
    AppState.profileSeriesSort = document.getElementById('profile-series-sort')?.value || AppState.profileSeriesSort || 'name';
    AppState.profileMoviesSort = document.getElementById('profile-movies-sort')?.value || AppState.profileMoviesSort || 'name';

    syncProfileSearchClearButton('series');
    syncProfileSearchClearButton('movies');

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

async function promptCreateList(tipo, { addSelectedItem = false } = {}) {
    const label = tipo === 'movie' ? 'películas' : 'series';
    const name = await showPromptDialog({
        title: `Nueva lista de ${label}`,
        placeholder: 'Nombre de la lista…',
        confirmText: 'Crear',
    });
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

async function createProfileList() {
    const tipo = AppState.currentProfileTab === 'movies' ? 'movie' : 'tv';
    await promptCreateList(tipo);
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
            const cover = safeUrl(getListCoverUrl(list));
            const count = list.itemIds.length;
            const cssCover = cover ? escapeCssUrl(cover) : '';
            const style = cssCover
                ? `style="background-image:url('${cssCover}')"`
                : '';
            return `
                <button type="button" class="tvst-list-banner${!cover ? ' is-empty' : ''}" ${style} onclick="openListModal('${escapeHtml(list.id)}')">
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

    const collapsedLimit = window.matchMedia('(min-width: 768px)').matches ? 5 : 3;

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
                        ${score ? `<span class="tvst-fav-card-score">${UI_ICONS.starSm}<span>${score}</span></span>` : ''}
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

    const safeListId = escapeHtml(list.id);
    const safeListTipo = escapeHtml(list.tipo);
    gridEl.innerHTML = items.map(({ item }) => {
        const img = safeUrl(item.portada || item.poster);
        const prog = getListItemProgress(item, list.tipo);
        const isCover = coverId === Number(item.id_tmdb);
        return `
        <article class="tvst-list-item${isCover ? ' is-cover' : ''}">
            <div class="tvst-list-item-poster-wrap">
                <button type="button" class="tvst-list-item-poster" onclick="onListItemClick(${Number(item.id_tmdb)}, '${safeListTipo}')">
                    ${img
                        ? `<img src="${escapeHtml(img)}" alt="${escapeHtml(item.titulo || '')}" loading="lazy">`
                        : `<div class="tvst-poster-fallback">${escapeHtml((item.titulo || '?').slice(0, 1))}</div>`}
                    <span class="tvst-list-item-overlay">
                        <span class="tvst-list-item-overlay-title">${escapeHtml(item.titulo || 'Sin título')}</span>
                    </span>
                </button>
                ${AppState.listCoverPickMode
                    ? ''
                    : `<button type="button" class="tvst-list-item-remove" onclick="removeItemFromList('${safeListId}', ${Number(item.id_tmdb)})" title="Quitar de la lista" aria-label="Quitar de la lista">${UI_ICONS.closeSm}</button>`}
            </div>
            <div class="tvst-list-item-progress">
                <div class="tvst-progress-track">
                    <div class="tvst-progress-fill ${escapeHtml(prog.colorClass)}" style="width:${Number(prog.progress) || 0}%"></div>
                </div>
                <p class="tvst-list-item-pct">${Number(prog.progress) || 0}%</p>
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

async function renameSelectedList() {
    const list = AppState.lists.find(l => l.id === AppState.selectedListId);
    if (!list) return;
    const name = await showPromptDialog({
        title: 'Renombrar lista',
        defaultValue: list.name,
        placeholder: 'Nombre de la lista…',
        confirmText: 'Guardar',
    });
    if (name == null) return;
    renameList(list.id, name);
}

async function deleteSelectedList() {
    const list = AppState.lists.find(l => l.id === AppState.selectedListId);
    if (!list) return;
    const confirmed = await showConfirmDialog({
        title: 'Eliminar lista',
        message: `¿Eliminar la lista «${list.name}»? Los títulos no se borran de tu biblioteca.`,
        confirmText: 'Eliminar',
        danger: true,
    });
    if (!confirmed) return;
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
                <button type="button" class="tvst-list-picker-row${inList ? ' is-in' : ''}" onclick="toggleSelectedInList('${escapeHtml(list.id)}')">
                    <span>${escapeHtml(list.name)}</span>
                    <span class="tvst-list-picker-check">${inList ? UI_ICONS.check : UI_ICONS.plus}</span>
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

async function createListFromPicker() {
    const item = AppState.selectedItem;
    if (!item) return;
    const list = await promptCreateList(item.tipo, { addSelectedItem: true });
    if (list) openListPicker();
}

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function safeUrl(url) {
    if (!url) return '';
    const trimmed = String(url).trim();
    if (!trimmed) return '';
    if (/^(https?:|\/|\.\/)/i.test(trimmed)) return trimmed;
    return '';
}

function escapeCssUrl(url) {
    const safe = safeUrl(url);
    if (!safe) return '';
    return safe.replace(/['"\\()\r\n]/g, (ch) => encodeURIComponent(ch));
}

let activeDialogResolve = null;

function resolveAppDialog(result) {
    const modal = document.getElementById('app-dialog-modal');
    const resolveFn = activeDialogResolve;
    activeDialogResolve = null;
    modal?.classList.add('hidden');
    if (resolveFn) resolveFn(result);
}

function openAppDialog({
    mode = 'confirm',
    title = 'Confirmar',
    message = '',
    defaultValue = '',
    placeholder = '',
    confirmText = 'Aceptar',
    cancelText = 'Cancelar',
    danger = false,
} = {}) {
    if (activeDialogResolve) {
        resolveAppDialog(mode === 'prompt' ? null : false);
    }

    const modal = document.getElementById('app-dialog-modal');
    const titleEl = document.getElementById('app-dialog-title');
    const msgEl = document.getElementById('app-dialog-message');
    const inputEl = document.getElementById('app-dialog-input');
    const cancelBtn = document.getElementById('app-dialog-cancel');
    const confirmBtn = document.getElementById('app-dialog-confirm');

    if (!modal || !titleEl || !msgEl || !inputEl || !cancelBtn || !confirmBtn) {
        return Promise.resolve(mode === 'prompt' ? null : false);
    }

    titleEl.textContent = title;
    msgEl.textContent = message;
    msgEl.classList.toggle('hidden', !message);

    const isPrompt = mode === 'prompt';
    inputEl.classList.toggle('hidden', !isPrompt);
    inputEl.value = isPrompt ? String(defaultValue ?? '') : '';
    inputEl.placeholder = placeholder || '';

    cancelBtn.textContent = cancelText;
    confirmBtn.textContent = confirmText;
    confirmBtn.classList.toggle('is-danger', Boolean(danger));

    return new Promise((resolve) => {
        activeDialogResolve = (raw) => {
            if (isPrompt) {
                resolve(typeof raw === 'string' ? raw : null);
            } else {
                resolve(Boolean(raw));
            }
        };

        cancelBtn.onclick = () => resolveAppDialog(isPrompt ? null : false);
        confirmBtn.onclick = () => resolveAppDialog(isPrompt ? inputEl.value : true);
        inputEl.onkeydown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                resolveAppDialog(inputEl.value);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                resolveAppDialog(null);
            }
        };
        modal.onkeydown = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                resolveAppDialog(isPrompt ? null : false);
            }
        };

        modal.classList.remove('hidden');
        requestAnimationFrame(() => {
            if (isPrompt) {
                inputEl.focus();
                inputEl.select();
            } else {
                confirmBtn.focus();
            }
        });
    });
}

function showConfirmDialog(options = {}) {
    return openAppDialog({ ...options, mode: 'confirm' });
}

function showPromptDialog(options = {}) {
    return openAppDialog({ ...options, mode: 'prompt' });
}

function formatWatchDuration(totalMinutes) {
    const mins = Math.max(0, Math.round(Number(totalMinutes) || 0));
    const totalHours = Math.floor(mins / 60);
    const months = Math.floor(totalHours / (24 * 30));
    const days = Math.floor((totalHours % (24 * 30)) / 24);
    const hours = totalHours % 24;
    if (months === 0 && days === 0 && hours === 0) {
        return `${mins} min`;
    }
    return `${months} meses · ${days} días · ${hours} h`;
}

function formatCompactDuration(totalMinutes, { ultraShort = false } = {}) {
    const mins = Math.max(0, Math.round(Number(totalMinutes) || 0));
    if (mins < 60) {
        return ultraShort ? `${mins}m` : `${mins} min`;
    }
    const totalHours = Math.floor(mins / 60);
    const remMins = mins % 60;
    if (totalHours < 24) {
        if (ultraShort) return remMins > 0 ? `${totalHours}h ${remMins}m` : `${totalHours}h`;
        return remMins > 0 ? `${totalHours} h ${remMins} min` : `${totalHours} h`;
    }
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    if (days < 30) {
        if (ultraShort) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
        return hours > 0
            ? `${days} ${days === 1 ? 'día' : 'días'} ${hours} h`
            : `${days} ${days === 1 ? 'día' : 'días'}`;
    }
    const months = Math.floor(days / 30);
    const remDays = days % 30;
    if (ultraShort) return remDays > 0 ? `${months}me ${remDays}d` : `${months}me`;
    return remDays > 0
        ? `${months} ${months === 1 ? 'mes' : 'meses'} ${remDays} ${remDays === 1 ? 'día' : 'días'}`
        : `${months} ${months === 1 ? 'mes' : 'meses'}`;
}

function getShowEpisodeRuntimeMinutes(show) {
    const stored = Number(show?.episode_run_time);
    if (stored > 0) return stored;
    return 45;
}

function getShowEstimatedTotalEpisodes(show) {
    if (!show || show.tipo === 'movie') return 0;
    if (show.episodios_emitidos != null && Number(show.episodios_emitidos) >= 0) {
        return Number(show.episodios_emitidos);
    }
    const includeSpecials = typeof shouldIncludeSpecials === 'function' ? shouldIncludeSpecials() : false;
    const seasons = Array.isArray(show.temporadas)
        ? show.temporadas.filter(s => includeSpecials || (!s.especial && Number(s.numero) !== 0))
        : [];
    const fromSeasons = seasons.reduce((acc, s) => acc + Math.max(0, Number(s.episodio_count ?? s.episode_count) || 0), 0);
    if (fromSeasons > 0) return fromSeasons;
    return Math.max(0, Number(show.numero_episodios) || 0);
}

function getShowRemainingTimeInfo(show, options = {}) {
    if (!show || show.tipo === 'movie') return null;
    if (!options.includeDropped && normalizeStatus(show.estado) === 'dropped') {
        return {
            remainingEpisodes: 0,
            remainingMinutes: 0,
            label: '0 min',
            shortLabel: '0m',
        };
    }

    const totalEpisodes = getShowEstimatedTotalEpisodes(show);
    const inLibrary = isItemAlreadyAdded('tv', show.id_tmdb);
    let consumedCount = 0;
    if (inLibrary) {
        if (show.episodios_consumidos_count != null && Number(show.episodios_consumidos_count) >= 0) {
            consumedCount = Number(show.episodios_consumidos_count);
        } else {
            const watchedSet = new Set(Array.isArray(show.capitulos_vistos) ? show.capitulos_vistos : []);
            const skippedList = Array.isArray(show.capitulos_saltados) ? show.capitulos_saltados : [];
            for (const id of skippedList) watchedSet.add(id);
            consumedCount = watchedSet.size;
        }
    }

    const remainingEpisodes = Math.max(0, totalEpisodes - consumedCount);
    const runtime = getShowEpisodeRuntimeMinutes(show);
    const remainingMinutes = remainingEpisodes * runtime;

    return {
        remainingEpisodes,
        remainingMinutes,
        label: formatCompactDuration(remainingMinutes),
        shortLabel: `~${formatCompactDuration(remainingMinutes, { ultraShort: true })}`,
    };
}

function getTopGenreStats(items, limit = 5) {
    const counts = new Map();
    for (const item of items || []) {
        const genres = Array.isArray(item?.generos) ? item.generos : [];
        const seenInItem = new Set();
        for (const raw of genres) {
            const name = String(raw || '').trim();
            if (!name || seenInItem.has(name)) continue;
            seenInItem.add(name);
            counts.set(name, (counts.get(name) || 0) + 1);
        }
    }
    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es'))
        .slice(0, limit);
}

function renderGenreBarsHtml(genreEntries, totalItems) {
    if (!genreEntries.length) {
        return '<p class="tvst-stats-caption">Sin géneros registrados todavía.</p>';
    }
    const maxCount = Math.max(1, genreEntries[0][1]);
    return `
        <div class="tvst-stats-bars">
            ${genreEntries.map(([name, count]) => {
                const widthPct = Math.max(8, Math.round((count / maxCount) * 100));
                const sharePct = totalItems > 0 ? Math.round((count / totalItems) * 100) : 0;
                return `
                    <div class="tvst-stats-bar-row">
                        <span class="tvst-stats-bar-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
                        <div class="tvst-stats-bar-track">
                            <div class="tvst-stats-bar-fill" style="width:${widthPct}%"></div>
                        </div>
                        <span class="tvst-stats-bar-count">${count} · ${sharePct}%</span>
                    </div>
                `;
            }).join('')}
        </div>
    `;
}

function renderWatchStats() {
    const seriesEl = document.getElementById('stats-series-time');
    const seriesCountEl = document.getElementById('stats-series-count');
    const seriesEpsEl = document.getElementById('stats-series-episodes');
    const seriesRatingEl = document.getElementById('stats-series-rating');
    const seriesRatingSubEl = document.getElementById('stats-series-rating-sub');
    const seriesCompletedEl = document.getElementById('stats-series-completed');
    const seriesCompletedSubEl = document.getElementById('stats-series-completed-sub');
    const seriesRemTimeEl = document.getElementById('stats-series-remaining-time');
    const seriesRemSubEl = document.getElementById('stats-series-remaining-sub');
    const seriesExtEl = document.getElementById('stats-series-extended');

    const moviesEl = document.getElementById('stats-movies-time');
    const moviesWatchedEl = document.getElementById('stats-movies-watched');
    const moviesPendingEl = document.getElementById('stats-movies-pending');
    const moviesRatingEl = document.getElementById('stats-movies-rating');
    const moviesRatingSubEl = document.getElementById('stats-movies-rating-sub');
    const moviesAvgRuntimeEl = document.getElementById('stats-movies-avg-runtime');
    const moviesAvgRuntimeSubEl = document.getElementById('stats-movies-avg-runtime-sub');
    const moviesPendingTimeEl = document.getElementById('stats-movies-pending-time');
    const moviesPendingSubEl = document.getElementById('stats-movies-pending-sub');
    const moviesExtEl = document.getElementById('stats-movies-extended');

    const now = new Date();
    const curYear = now.getFullYear();
    const curMonth = now.getMonth();

    let seriesMinutes = 0;
    let totalEpisodesWatched = 0;
    let totalEpisodesSkipped = 0;
    let seriesRemainingMinutes = 0;
    let seriesRemainingEpisodes = 0;
    let seriesScoreSum = 0;
    let seriesScoreCount = 0;
    let epsThisMonth = 0;
    let minsThisMonth = 0;
    let epsThisYear = 0;
    let minsThisYear = 0;
    let seriesFavCount = 0;

    const statusCounts = {
        watching: 0,
        completed: 0,
        pending: 0,
        standby: 0,
        dropped: 0,
    };

    for (const show of AppState.shows) {
        const runtime = getShowEpisodeRuntimeMinutes(show);
        const watchedIds = Array.isArray(show.capitulos_vistos) ? show.capitulos_vistos : [];
        const skippedIds = Array.isArray(show.capitulos_saltados) ? show.capitulos_saltados : [];
        const watched = watchedIds.length;
        totalEpisodesWatched += watched;
        totalEpisodesSkipped += skippedIds.length;
        seriesMinutes += watched * runtime;

        if (show.favorito) seriesFavCount += 1;

        const score = Number(show.puntuacion);
        if (Number.isFinite(score) && score > 0) {
            seriesScoreSum += score;
            seriesScoreCount += 1;
        }

        const st = normalizeStatus(show.estado);
        if (Object.prototype.hasOwnProperty.call(statusCounts, st)) {
            statusCounts[st] += 1;
        } else {
            statusCounts.pending += 1;
        }

        if (st !== 'dropped') {
            const rem = getShowRemainingTimeInfo(show);
            if (rem) {
                seriesRemainingEpisodes += rem.remainingEpisodes;
                seriesRemainingMinutes += rem.remainingMinutes;
            }
        }

        const dateMap = show.capitulos_vistos_fecha && typeof show.capitulos_vistos_fecha === 'object'
            ? show.capitulos_vistos_fecha
            : null;
        if (dateMap) {
            for (const epId of watchedIds) {
                const iso = dateMap[epId];
                if (!iso) continue;
                const d = new Date(iso);
                if (Number.isNaN(d.getTime())) continue;
                if (d.getFullYear() === curYear) {
                    epsThisYear += 1;
                    minsThisYear += runtime;
                    if (d.getMonth() === curMonth) {
                        epsThisMonth += 1;
                        minsThisMonth += runtime;
                    }
                }
            }
        }
    }

    const totalShows = AppState.shows.length;
    const completedSeriesPct = totalShows > 0 ? Math.round((statusCounts.completed / totalShows) * 100) : 0;

    if (seriesCountEl) seriesCountEl.textContent = String(totalShows);
    if (seriesEpsEl) seriesEpsEl.textContent = totalEpisodesWatched.toLocaleString('es-ES');
    if (seriesRatingEl) seriesRatingEl.textContent = seriesScoreCount > 0 ? (seriesScoreSum / seriesScoreCount).toFixed(1) : '—';
    if (seriesRatingSubEl) seriesRatingSubEl.textContent = seriesScoreCount > 0 ? `en ${seriesScoreCount} ${seriesScoreCount === 1 ? 'serie' : 'series'}` : 'Sin puntuar';
    if (seriesCompletedEl) seriesCompletedEl.textContent = String(statusCounts.completed);
    if (seriesCompletedSubEl) seriesCompletedSubEl.textContent = `${completedSeriesPct}% de tu lista`;
    if (seriesEl) seriesEl.textContent = formatWatchDuration(seriesMinutes);
    if (seriesRemTimeEl) seriesRemTimeEl.textContent = formatCompactDuration(seriesRemainingMinutes);
    if (seriesRemSubEl) {
        seriesRemSubEl.textContent = `${seriesRemainingEpisodes.toLocaleString('es-ES')} ${seriesRemainingEpisodes === 1 ? 'episodio pendiente' : 'episodios pendientes'}`;
    }

    if (seriesExtEl) {
        const statusItems = [
            { key: 'watching', label: 'Viendo', count: statusCounts.watching },
            { key: 'completed', label: 'Completadas', count: statusCounts.completed },
            { key: 'pending', label: 'Pendientes', count: statusCounts.pending },
            { key: 'standby', label: 'En espera', count: statusCounts.standby },
            { key: 'dropped', label: 'Abandonadas', count: statusCounts.dropped },
        ].filter(s => s.count > 0);

        const topSeriesGenres = getTopGenreStats(AppState.shows, 5);

        seriesExtEl.innerHTML = `
            <div class="tvst-stats-block">
                <h3 class="tvst-stats-label">Actividad de episodios</h3>
                <div class="tvst-stats-activity-row is-3">
                    <div class="tvst-stats-mini-card">
                        <span class="tvst-stats-mini-val">${epsThisMonth.toLocaleString('es-ES')} ep.</span>
                        <span class="tvst-stats-mini-lbl">Este mes · ${escapeHtml(formatCompactDuration(minsThisMonth))}</span>
                    </div>
                    <div class="tvst-stats-mini-card">
                        <span class="tvst-stats-mini-val">${epsThisYear.toLocaleString('es-ES')} ep.</span>
                        <span class="tvst-stats-mini-lbl">En ${curYear} · ${escapeHtml(formatCompactDuration(minsThisYear))}</span>
                    </div>
                    <div class="tvst-stats-mini-card">
                        <span class="tvst-stats-mini-val">${seriesFavCount} ★</span>
                        <span class="tvst-stats-mini-lbl">${totalEpisodesSkipped > 0 ? `${totalEpisodesSkipped} ep. saltados` : 'Series favoritas'}</span>
                    </div>
                </div>
            </div>
            <div class="tvst-stats-block">
                <h3 class="tvst-stats-label">Distribución por estado</h3>
                ${totalShows > 0 ? `
                    <div class="tvst-stats-status-bar" aria-label="Distribución de series por estado">
                        ${statusItems.map(s => `<span class="tvst-stats-seg is-${s.key}" style="width:${Math.max(3, (s.count / totalShows) * 100)}%" title="${escapeHtml(s.label)}: ${s.count}"></span>`).join('')}
                    </div>
                    <div class="tvst-stats-legend">
                        ${statusItems.map(s => `
                            <span class="tvst-stats-legend-item">
                                <span class="tvst-stats-dot is-${s.key}"></span>
                                <span>${escapeHtml(s.label)} (${s.count})</span>
                            </span>
                        `).join('')}
                    </div>
                ` : '<p class="tvst-stats-caption">Añade series para ver el desglose por estado.</p>'}
            </div>
            <div class="tvst-stats-block">
                <h3 class="tvst-stats-label">Géneros más vistos</h3>
                ${renderGenreBarsHtml(topSeriesGenres, totalShows)}
            </div>
        `;
    }

    let moviesMinutes = 0;
    let moviesPendingMinutes = 0;
    let moviesWatchedCount = 0;
    let moviesPendingCount = 0;
    let moviesScoreSum = 0;
    let moviesScoreCount = 0;
    let moviesRuntimeKnownSum = 0;
    let moviesRuntimeKnownCount = 0;
    let moviesFavCount = 0;
    const decadeCounts = new Map();

    for (const movie of AppState.movies) {
        const runtime = Number(movie.runtime);
        const safeRuntime = runtime > 0 ? runtime : 100;
        const score = Number(movie.puntuacion);
        if (Number.isFinite(score) && score > 0) {
            moviesScoreSum += score;
            moviesScoreCount += 1;
        }
        if (movie.favorito) moviesFavCount += 1;

        const yearStr = getItemYearString(movie);
        const yearNum = Number(yearStr);
        if (Number.isFinite(yearNum) && yearNum >= 1900) {
            const decade = Math.floor(yearNum / 10) * 10;
            decadeCounts.set(decade, (decadeCounts.get(decade) || 0) + 1);
        }

        if (normalizeStatus(movie.estado) === 'completed') {
            moviesWatchedCount += 1;
            moviesMinutes += safeRuntime;
            if (runtime > 0) {
                moviesRuntimeKnownSum += runtime;
                moviesRuntimeKnownCount += 1;
            }
        } else {
            moviesPendingCount += 1;
            moviesPendingMinutes += safeRuntime;
        }
    }

    const totalMovies = AppState.movies.length;
    const watchedPct = totalMovies > 0 ? Math.round((moviesWatchedCount / totalMovies) * 100) : 0;
    const avgMovieRuntime = moviesRuntimeKnownCount > 0
        ? Math.round(moviesRuntimeKnownSum / moviesRuntimeKnownCount)
        : (moviesWatchedCount > 0 ? Math.round(moviesMinutes / moviesWatchedCount) : 0);

    if (moviesWatchedEl) moviesWatchedEl.textContent = String(moviesWatchedCount);
    if (moviesPendingEl) moviesPendingEl.textContent = String(moviesPendingCount);
    if (moviesRatingEl) moviesRatingEl.textContent = moviesScoreCount > 0 ? (moviesScoreSum / moviesScoreCount).toFixed(1) : '—';
    if (moviesRatingSubEl) moviesRatingSubEl.textContent = moviesScoreCount > 0 ? `en ${moviesScoreCount} ${moviesScoreCount === 1 ? 'película' : 'películas'}` : 'Sin puntuar';
    if (moviesAvgRuntimeEl) moviesAvgRuntimeEl.textContent = avgMovieRuntime > 0 ? `${avgMovieRuntime} min` : '—';
    if (moviesAvgRuntimeSubEl) moviesAvgRuntimeSubEl.textContent = moviesWatchedCount > 0 ? 'Media por película' : 'Sin películas vistas';
    if (moviesEl) moviesEl.textContent = formatWatchDuration(moviesMinutes);
    if (moviesPendingTimeEl) moviesPendingTimeEl.textContent = formatCompactDuration(moviesPendingMinutes);
    if (moviesPendingSubEl) {
        moviesPendingSubEl.textContent = `${moviesPendingCount} ${moviesPendingCount === 1 ? 'película' : 'películas'}`;
    }

    if (moviesExtEl) {
        const watchedMovies = AppState.movies.filter(m => normalizeStatus(m.estado) === 'completed');
        const genrePool = watchedMovies.length ? watchedMovies : AppState.movies;
        const topMovieGenres = getTopGenreStats(genrePool, 5);
        const topDecades = [...decadeCounts.entries()]
            .sort((a, b) => b[1] - a[1] || b[0] - a[0])
            .slice(0, 5);

        moviesExtEl.innerHTML = `
            <div class="tvst-stats-block">
                <h3 class="tvst-stats-label">Progreso de tu videoteca</h3>
                ${totalMovies > 0 ? `
                    <div class="tvst-stats-status-bar" aria-label="Progreso de películas vistas">
                        ${moviesWatchedCount > 0 ? `<span class="tvst-stats-seg is-movie-watched" style="width:${(moviesWatchedCount / totalMovies) * 100}%"></span>` : ''}
                        ${moviesPendingCount > 0 ? `<span class="tvst-stats-seg is-movie-pending" style="width:${(moviesPendingCount / totalMovies) * 100}%"></span>` : ''}
                    </div>
                    <div class="tvst-stats-legend">
                        <span class="tvst-stats-legend-item"><span class="tvst-stats-dot is-movie-watched"></span><span>Vistas (${moviesWatchedCount} · ${watchedPct}%)</span></span>
                        <span class="tvst-stats-legend-item"><span class="tvst-stats-dot is-movie-pending"></span><span>Pendientes (${moviesPendingCount})</span></span>
                        <span class="tvst-stats-legend-item"><span>★ ${moviesFavCount} favoritas</span></span>
                    </div>
                ` : '<p class="tvst-stats-caption">Añade películas para ver tu progreso.</p>'}
            </div>
            <div class="tvst-stats-block">
                <h3 class="tvst-stats-label">Géneros favoritos</h3>
                ${renderGenreBarsHtml(topMovieGenres, genrePool.length)}
            </div>
            ${topDecades.length ? `
                <div class="tvst-stats-block">
                    <h3 class="tvst-stats-label">Décadas</h3>
                    <div class="tvst-stats-chips">
                        ${topDecades.map(([decade, count]) => `<span class="tvst-stats-chip"><span>${decade}s</span><strong>${count}</strong></span>`).join('')}
                    </div>
                </div>
            ` : ''}
        `;
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
    const episodes = await getOrderedEpisodes(show, { includeSpecials: shouldIncludeSpecials() });
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

function paintProfileLibrary(options = {}) {
    const seriesContainer = document.getElementById('profile-series-container');
    const moviesContainer = document.getElementById('profile-movies-container');
    if (!seriesContainer || !moviesContainer) return;

    const validSeriesSorts = ['name', 'tmdb', 'rating', 'progress', 'recent', 'year'];
    const validMoviesSorts = ['name', 'tmdb', 'rating', 'recent', 'year'];
    const seriesSortEl = document.getElementById('profile-series-sort');
    const moviesSortEl = document.getElementById('profile-movies-sort');
    if (seriesSortEl && seriesSortEl.value !== AppState.profileSeriesSort) {
        seriesSortEl.value = validSeriesSorts.includes(AppState.profileSeriesSort) ? AppState.profileSeriesSort : 'name';
    }
    if (moviesSortEl && moviesSortEl.value !== AppState.profileMoviesSort) {
        moviesSortEl.value = validMoviesSorts.includes(AppState.profileMoviesSort) ? AppState.profileMoviesSort : 'name';
    }

    const collapsedLimit = window.matchMedia('(min-width: 768px)').matches ? 5 : 3;

    const hasSeriesFilter = Boolean(AppState.profileSeriesSearch.trim())
        || AppState.profileSeriesFilter !== 'all'
        || AppState.profileSeriesPlatform !== 'all';
    const hasMoviesFilter = Boolean(AppState.profileMoviesSearch.trim())
        || AppState.profileMoviesFilter !== 'all'
        || AppState.profileMoviesPlatform !== 'all';

    const filteredSeries = sortProfileLibraryItems(
        AppState.shows
            .filter(show => filterProfileSeries(show))
            .filter(show => matchesProfileSearch(show, AppState.profileSeriesSearch))
            .filter(show => matchesProfilePlatform(show, AppState.profileSeriesPlatform)),
        AppState.profileSeriesSort,
        'tv',
    );
    const filteredMovies = sortProfileLibraryItems(
        AppState.movies
            .filter(movie => filterProfileMovies(movie))
            .filter(movie => matchesProfileSearch(movie, AppState.profileMoviesSearch))
            .filter(movie => matchesProfilePlatform(movie, AppState.profileMoviesPlatform)),
        AppState.profileMoviesSort,
        'movie',
    );

    const seriesExpanded = Boolean(AppState.profileExpanded.series) || hasSeriesFilter;
    const moviesExpanded = Boolean(AppState.profileExpanded.movies) || hasMoviesFilter;

    seriesContainer.className = `tvst-profile-rail${seriesExpanded ? ' is-expanded' : ''}`;
    moviesContainer.className = `tvst-profile-rail${moviesExpanded ? ' is-expanded' : ''}`;

    const seriesMoreBtn = document.getElementById('profile-series-more');
    const moviesMoreBtn = document.getElementById('profile-movies-more');
    if (seriesMoreBtn) {
        seriesMoreBtn.classList.toggle('hidden', hasSeriesFilter || filteredSeries.length <= collapsedLimit);
        seriesMoreBtn.textContent = AppState.profileExpanded.series ? 'Mostrar menos' : 'Mostrar más';
    }
    if (moviesMoreBtn) {
        moviesMoreBtn.classList.toggle('hidden', hasMoviesFilter || filteredMovies.length <= collapsedLimit);
        moviesMoreBtn.textContent = AppState.profileExpanded.movies ? 'Mostrar menos' : 'Mostrar más';
    }

    const updateMeta = (elId, filteredCount, totalCount, kind, hasFilter) => {
        const metaEl = document.getElementById(elId);
        if (!metaEl) return;
        if (!hasFilter) {
            metaEl.classList.add('hidden');
            metaEl.innerHTML = '';
            return;
        }
        const noun = kind === 'movies'
            ? (filteredCount === 1 ? 'película' : 'películas')
            : (filteredCount === 1 ? 'serie' : 'series');
        metaEl.classList.remove('hidden');
        metaEl.innerHTML = `
            <span>${filteredCount} de ${totalCount} ${noun}</span>
            <button type="button" class="tvst-profile-meta-reset" onclick="resetProfileFilters('${kind}')">Limpiar filtros</button>
        `;
    };

    updateMeta('profile-series-meta', filteredSeries.length, AppState.shows.length, 'series', hasSeriesFilter);
    updateMeta('profile-movies-meta', filteredMovies.length, AppState.movies.length, 'movies', hasMoviesFilter);

    seriesContainer.innerHTML = renderProfileCards(filteredSeries, 'tv', {
        filtered: hasSeriesFilter,
        hasLibraryItems: AppState.shows.length > 0,
    });
    moviesContainer.innerHTML = renderProfileCards(filteredMovies, 'movie', {
        filtered: hasMoviesFilter,
        hasLibraryItems: AppState.movies.length > 0,
    });

    if (!options.onlyLibrary) {
        renderProfileFavorites();
        renderProfileLists();
        renderWatchStats();
    }
}

function sortProfileLibraryItems(items, mode, type = 'tv') {
    const list = [...(items || [])];
    const byName = (a, b) => (a.titulo || '').localeCompare(b.titulo || '', 'es', { sensitivity: 'base' });
    if (mode === 'tmdb') {
        return list.sort((a, b) => {
            const aScore = Number(a.vote_average);
            const bScore = Number(b.vote_average);
            const aValid = Number.isFinite(aScore) && aScore > 0;
            const bValid = Number.isFinite(bScore) && bScore > 0;
            if (aValid && bValid && bScore !== aScore) return bScore - aScore;
            if (aValid && !bValid) return -1;
            if (!aValid && bValid) return 1;
            return byName(a, b);
        });
    }
    if (mode === 'rating') {
        return list.sort((a, b) => {
            const aScore = Number(a.puntuacion) || 0;
            const bScore = Number(b.puntuacion) || 0;
            if (bScore !== aScore) return bScore - aScore;
            return byName(a, b);
        });
    }
    if (mode === 'progress' && type === 'tv') {
        return list.sort((a, b) => {
            const aProg = getShowProgressInfo(a).progress;
            const bProg = getShowProgressInfo(b).progress;
            if (bProg !== aProg) return bProg - aProg;
            return byName(a, b);
        });
    }
    if (mode === 'recent') {
        return list.sort((a, b) => {
            const aMs = parseModifiedMs(a.updatedAt || a.addedAt);
            const bMs = parseModifiedMs(b.updatedAt || b.addedAt);
            if (bMs !== aMs) return bMs - aMs;
            return byName(a, b);
        });
    }
    if (mode === 'year') {
        return list.sort((a, b) => {
            const aYear = Number(getItemYearString(a)) || 0;
            const bYear = Number(getItemYearString(b)) || 0;
            if (bYear !== aYear) return bYear - aYear;
            return byName(a, b);
        });
    }
    return list.sort(byName);
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
    const q = normalizeSearchText(query);
    if (!q) return true;
    const tokens = q.split(/\s+/).filter(Boolean);
    if (!tokens.length) return true;
    const haystack = normalizeSearchText([
        item.titulo,
        item.titulo_original,
        item.original_title,
        item.original_name,
        Array.isArray(item.generos) ? item.generos.join(' ') : '',
        getItemYearString(item),
    ].filter(Boolean).join(' '));
    return tokens.every(token => haystack.includes(token));
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
    const prefix = tipo === 'movie' ? 'movie' : 'tv';
    const missing = items.filter(item => (
        !Array.isArray(item.watch_providers)
        && !failedProviderFetchKeys.has(`${prefix}:${item.id_tmdb}`)
    ));
    if (!missing.length || typeof getWatchProviders !== 'function') {
        return { fetchedCount: 0, failedCount: 0 };
    }

    const batch = missing.slice(0, 20);
    let fetchedCount = 0;
    let failedCount = 0;

    await mapPool(batch, 5, async (item) => {
        try {
            const providers = await getWatchProviders(prefix, item.id_tmdb);
            item.watch_providers = providers?.length ? providers : [];
            failedProviderFetchKeys.delete(`${prefix}:${item.id_tmdb}`);
            fetchedCount += 1;
        } catch (error) {
            console.warn('[App] No se pudieron cargar providers:', item.titulo, error);
            failedProviderFetchKeys.add(`${prefix}:${item.id_tmdb}`);
            failedCount += 1;
        }
    });

    if (fetchedCount > 0) {
        saveLocalData();
    }
    return { fetchedCount, failedCount };
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

function renderProfileCards(items, type, options = {}) {
    if (items.length === 0) {
        if (options.filtered && options.hasLibraryItems) {
            const kind = type === 'tv' ? 'series' : 'movies';
            return emptyState(type === 'tv' ? 'episodes' : 'film', 'Sin coincidencias', {
                grid: true,
                subtitle: 'Prueba con otro título, estado o plataforma.',
                actionLabel: 'Limpiar filtros',
                actionOnClick: `resetProfileFilters('${kind}')`,
            });
        }
        return emptyState(type === 'tv' ? 'episodes' : 'film', 'No hay contenido en esta categoría', {
            grid: true,
            subtitle: 'Busca títulos en Explorar y añádelos a tu biblioteca.',
            actionLabel: 'Explorar',
            actionOnClick: "switchTab('explore')",
        });
    }

    const safeType = escapeHtml(type);
    return items.map(item => {
        const personalRating = item.puntuacion && item.puntuacion > 0 ? Number(item.puntuacion) : null;
        const tmdbRating = item.vote_average !== undefined && item.vote_average !== null
            ? Number(item.vote_average)
            : null;
        const progressData = type === 'tv' ? getShowProgressInfo(item) : null;
        const remainingInfo = type === 'tv' && normalizeStatus(item.estado) !== 'dropped'
            ? getShowRemainingTimeInfo(item)
            : null;
        const statusBadge = getStatusBadge(item.estado);
        const isFav = Boolean(item.favorito);
        const poster = safeUrl(item.portada);

        return `
        <div class="profile-card cursor-pointer flex flex-col${normalizeStatus(item.estado) === 'standby' ? ' is-standby' : ''}" onclick="openDetail('${safeType}', ${Number(item.id_tmdb)})">
            <div class="tvst-profile-poster-wrap">
                ${poster ? `<img src="${escapeHtml(poster)}" alt="${escapeHtml(item.titulo || '')}" class="w-full h-full object-cover">` : `<div class="tvst-poster-fallback">${UI_ICONS.film}</div>`}
                ${tmdbRating !== null ? `<div class="tvst-poster-score is-tmdb">${tmdbRating.toFixed(1)}</div>` : ''}
                ${personalRating !== null ? `<div class="tvst-poster-score is-user">${UI_ICONS.starSm}<span>${personalRating.toFixed(1)}</span></div>` : ''}
                <button type="button" class="tvst-card-fav${isFav ? ' is-active' : ''}" onclick="toggleFavoriteFromCard(event, '${safeType}', ${Number(item.id_tmdb)})" aria-label="Favorito" title="${isFav ? 'Quitar de favoritos' : 'Añadir a favoritos'}">${UI_ICONS.star}</button>
            </div>
            <h3 class="tvst-profile-card-title">${escapeHtml(item.titulo || '')}</h3>
            ${statusBadge}
            ${progressData ? `
                <div class="w-full">
                    <div class="tvst-progress-track">
                        <div class="tvst-progress-fill ${progressData.colorClass}" style="width: ${progressData.progress}%;"></div>
                    </div>
                    ${remainingInfo && remainingInfo.remainingEpisodes > 0
                        ? `<div class="tvst-profile-card-meta-row"><span>${progressData.progress}%</span><span class="tvst-profile-card-rem">${escapeHtml(remainingInfo.shortLabel)}</span></div>`
                        : `<p class="tvst-profile-card-pct">${progressData.progress}%</p>`}
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
                        aria-label="${n}">${UI_ICONS.star}</button>
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
            ${item?.generos?.length ? `<p class="tvst-info-genres">${escapeHtml(item.generos.slice(0, 4).join(' · '))}</p>` : ''}
            ${item?.tipo === 'movie' && item?.fecha_estreno ? (() => {
                const parsedRelease = parseReleaseDate(String(item.fecha_estreno).slice(0, 10));
                const formattedRelease = parsedRelease
                    ? parsedRelease.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' })
                    : String(item.fecha_estreno).slice(0, 10);
                return `<p class="tvst-info-genres">Estreno (${escapeHtml(getPreferredProviderCountry())}): ${escapeHtml(formattedRelease)}</p>`;
            })() : ''}
        </div>
        ${renderDetailTrailerSection(item)}
        ${providers.length ? `
            <div class="tvst-info-section">
                <h3>Dónde ver (${escapeHtml(getPreferredProviderCountry())})</h3>
                <div class="tvst-providers-row">
                    ${[...providers].sort((a, b) => Number(isSubscribedProvider(b.provider_name)) - Number(isSubscribedProvider(a.provider_name))).map(provider => {
                        const logoUrl = provider.logo_path ? safeUrl(window.getImageUrl(provider.logo_path, 'w92')) : '';
                        const subscribed = isSubscribedProvider(provider.provider_name);
                        return `
                        <span class="tvst-provider-chip${subscribed ? ' is-subscribed' : ''}">
                            ${logoUrl ? `<img src="${escapeHtml(logoUrl)}" alt="">` : ''}
                            <span>${escapeHtml(provider.provider_name || '')}</span>
                            ${subscribed ? '<span class="tvst-provider-chip-badge">Tuya</span>' : ''}
                        </span>
                    `;
                    }).join('')}
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
                    const profileImg = safeUrl(person.profile_path);
                    return `
                    <article class="tvst-cast-card${clickable ? ' is-clickable' : ''}" ${attrs}>
                        ${profileImg
                            ? `<img src="${escapeHtml(profileImg)}" alt="${escapeHtml(person.name || '')}" loading="lazy" onerror="handleCastImgError(this)">`
                            : `<div class="tvst-cast-fallback">${UI_ICONS.person}</div>`}
                        <div class="min-w-0">
                            <p class="text-sm font-semibold truncate">${escapeHtml(person.name || '')}</p>
                            <p class="text-xs text-gray-500 truncate">${escapeHtml(person.character || 'Actor')}</p>
                        </div>
                    </article>`;
                }).join('') : '<p class="text-sm text-gray-500">No hay reparto disponible.</p>'}
            </div>
        </div>
        <div class="tvst-info-section">
            <h3>También te gustará</h3>
            <div class="tvst-rec-rail">
                ${recommendations.length ? recommendations.map(rec => {
                    const recType = rec.tipo === 'tv' ? 'tv' : 'movie';
                    const recPoster = safeUrl(rec.portada);
                    const recAdded = isItemAlreadyAdded(recType, rec.id_tmdb);
                    return `
                    <article class="tvst-rec-card" onclick="openDetail('${recType}', ${Number(rec.id_tmdb)})">
                        ${recPoster
                            ? `<img src="${escapeHtml(recPoster)}" alt="${escapeHtml(rec.titulo || '')}" loading="lazy">`
                            : `<div class="tvst-rec-fallback">${UI_ICONS.film}</div>`}
                        <button type="button"
                            onclick="event.stopPropagation();${recAdded ? '' : ` addItem('${recType}', ${Number(rec.id_tmdb)});`}"
                            class="tvst-add-btn${recAdded ? ' is-added' : ''}"
                            ${recAdded ? 'disabled' : ''}
                            aria-label="${recAdded ? 'Ya añadido' : 'Añadir'}">${recAdded ? UI_ICONS.check : UI_ICONS.plus}</button>
                        <p class="tvst-rec-title">${escapeHtml(rec.titulo || '')}</p>
                    </article>`;
                }).join('') : '<p class="text-sm text-gray-500">No hay recomendaciones disponibles.</p>'}
            </div>
        </div>
    `;
}

const SAFE_YOUTUBE_KEY_RE = /^[A-Za-z0-9_-]{6,20}$/;

function getValidItemVideos(item) {
    const raw = Array.isArray(item?.videos) ? item.videos : [];
    return raw.filter(v => v && SAFE_YOUTUBE_KEY_RE.test(String(v.key || '')));
}

function renderDetailTrailerSection(item) {
    if (!areTrailersEnabled()) return '';
    const videos = getValidItemVideos(item);
    if (!videos.length) return '';

    const activeKey = AppState.activeTrailerKey && videos.some(v => v.key === AppState.activeTrailerKey)
        ? AppState.activeTrailerKey
        : null;
    const displayVideo = activeKey
        ? videos.find(v => v.key === activeKey)
        : videos[0];

    const safeKey = displayVideo.key;
    const typeLabelMap = { Trailer: 'Tráiler', Teaser: 'Teaser', Clip: 'Clip', Featurette: 'Extra' };
    const typeLabel = typeLabelMap[displayVideo.type] || 'Vídeo';
    const badgeText = displayVideo.lang ? `${typeLabel} · ${displayVideo.lang}` : typeLabel;
    const thumbUrl = safeUrl(`https://i.ytimg.com/vi/${safeKey}/hqdefault.jpg`) || safeUrl(item.backdrop || item.portada);
    const youtubeWatchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(safeKey)}`;

    const playerHtml = activeKey ? `
        <div class="tvst-trailer-frame-wrap">
            <iframe
                src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(safeKey)}?autoplay=1&rel=0"
                title="${escapeHtml(displayVideo.name || 'Tráiler')}"
                allow="autoplay; encrypted-media; picture-in-picture"
                allowfullscreen
                loading="lazy"></iframe>
        </div>
        <div class="tvst-trailer-controls">
            <button type="button" class="tvst-trailer-btn-sec" onclick="stopDetailTrailer()">Cerrar reproductor</button>
            <a class="tvst-trailer-ext-link" href="${escapeHtml(youtubeWatchUrl)}" target="_blank" rel="noopener noreferrer">Abrir en YouTube ↗</a>
        </div>
    ` : `
        <button type="button" class="tvst-trailer-preview" onclick="playDetailTrailer('${escapeHtml(safeKey)}')" aria-label="Reproducir tráiler">
            ${thumbUrl ? `<img class="tvst-trailer-thumb" src="${escapeHtml(thumbUrl)}" alt="${escapeHtml(displayVideo.name || 'Tráiler')}" loading="lazy">` : ''}
            <div class="tvst-trailer-scrim"></div>
            <span class="tvst-trailer-play-circle" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            </span>
            <div class="tvst-trailer-caption">
                <span class="tvst-trailer-type">${escapeHtml(badgeText)}</span>
                <span class="tvst-trailer-name">${escapeHtml(displayVideo.name || 'Ver tráiler')}</span>
            </div>
        </button>
    `;

    const chipsHtml = videos.length > 1 ? `
        <div class="tvst-trailer-chips">
            ${videos.map(v => {
                const isSelected = activeKey === v.key || (!activeKey && v.key === safeKey);
                const label = v.lang ? `${v.type === 'Trailer' ? 'Tráiler' : v.type} (${v.lang})` : (v.name || v.type);
                return `<button type="button" class="tvst-trailer-chip${isSelected ? ' is-active' : ''}" onclick="playDetailTrailer('${escapeHtml(v.key)}')">${escapeHtml(label)}</button>`;
            }).join('')}
        </div>
    ` : '';

    return `
        <div id="detail-trailer-section" class="tvst-info-section">
            <h3>Tráiler</h3>
            ${playerHtml}
            ${chipsHtml}
        </div>
    `;
}

function playDetailTrailer(key) {
    const safeKey = String(key || '');
    if (!SAFE_YOUTUBE_KEY_RE.test(safeKey) || !AppState.selectedItem) return;
    AppState.activeTrailerKey = safeKey;
    renderDetailInfo(AppState.selectedItem);
}

function stopDetailTrailer() {
    AppState.activeTrailerKey = null;
    if (AppState.selectedItem) {
        renderDetailInfo(AppState.selectedItem);
    }
}

function jumpToDetailTrailer() {
    if (!areTrailersEnabled()) return;
    const item = AppState.selectedItem;
    if (!item) return;
    const videos = getValidItemVideos(item);
    if (!videos.length) return;
    switchDetailTab('info');
    AppState.activeTrailerKey = videos[0].key;
    renderDetailInfo(item);
    requestAnimationFrame(() => {
        document.getElementById('detail-trailer-section')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
}

function handleCastImgError(img) {
    if (!img) return;
    img.onerror = null;
    const fallback = document.createElement('div');
    fallback.className = 'tvst-cast-fallback';
    fallback.innerHTML = UI_ICONS.person;
    img.replaceWith(fallback);
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

function updatePreference(key, value) {
    const prev = getPreferences();
    const next = normalizePreferences({
        ...prev,
        [key]: value,
        updatedAt: nowIso(),
    });
    AppState.preferences = next;

    if (key === 'includeSpecials') {
        AppState.shows.forEach((s) => {
            s.episodios_emitidos = null;
            s.episodios_vistos_count = null;
            s.episodios_consumidos_count = null;
        });
        invalidateTimelineCaches();
    } else if (key === 'inactivityDays') {
        invalidateTimelineCaches();
    } else if (key === 'providerCountry') {
        if (typeof window.clearWatchProvidersCache === 'function') {
            window.clearWatchProvidersCache();
        }
        failedProviderFetchKeys.clear();
        attemptedMovieReleaseSyncKeys.clear();
        AppState.movies.forEach((m) => {
            delete m.watch_providers;
            delete m.release_date_country;
        });
        AppState.shows.forEach((s) => { delete s.watch_providers; });
        if (typeof refreshProvidersInBackground === 'function') {
            setTimeout(() => { void refreshProvidersInBackground(); }, 50);
        }
        setTimeout(() => { void ensureUpcomingMovieReleaseDates(); }, 60);
    } else if (key === 'showTrailers') {
        if (!next.showTrailers) {
            AppState.activeTrailerKey = null;
        }
        if (AppState.selectedItem) {
            updateDetailHero(AppState.selectedItem);
            renderDetailInfo(AppState.selectedItem);
        }
    } else if (key === 'showUpcomingMiniCalendar') {
        if (!next.showUpcomingMiniCalendar) {
            AppState.upcomingSeriesCal.selectedDate = null;
            AppState.upcomingMoviesCal.selectedDate = null;
        }
        rerenderUpcomingByKind('movies');
        if (AppState.timelineUpcomingCache?.builtAt > 0 || (AppState.currentTab === 'series' && AppState.seriesSubTab === 'upcoming')) {
            rerenderUpcomingByKind('series');
        }
    }

    saveLocalData();
    syncToDrive();
    renderSettings();
}

function toggleSubscriptionPreference(providerName) {
    const clean = String(providerName || '').trim();
    if (!clean) return;
    const current = getMySubscriptions();
    const exists = current.some(p => p.toLowerCase() === clean.toLowerCase());
    const nextSubs = exists
        ? current.filter(p => p.toLowerCase() !== clean.toLowerCase())
        : [...current, clean];
    updatePreference('mySubscriptions', nextSubs);
}

function clearTmdbCachesFromSettings() {
    invalidateOrderedEpisodesCache();
    invalidateTimelineCaches();
    if (typeof window.clearWatchProvidersCache === 'function') {
        window.clearWatchProvidersCache();
    }
    failedProviderFetchKeys.clear();
    attemptedMovieFilterMetaIds.clear();
    AppState.shows.forEach((s) => {
        s.metaCheckedAt = '';
        s.episodios_emitidos = null;
        s.episodios_vistos_count = null;
        s.episodios_consumidos_count = null;
    });
    saveLocalData();
    showToast('Caché de TMDB limpiada', 'success');
}

function renderSettings() {
    if (typeof window.isAuthenticated === 'function') {
        updateDriveStatus(window.isAuthenticated());
    }

    const container = document.getElementById('settings-preferences-container');
    if (!container) return;

    const prefs = getPreferences();
    const startTabOptions = [
        { value: 'series', label: 'Series' },
        { value: 'movies', label: 'Películas' },
        { value: 'explore', label: 'Explorar' },
        { value: 'profile', label: 'Perfil' },
    ];
    const inactivityOptions = [
        { value: 7, label: '7 días' },
        { value: 14, label: '14 días' },
        { value: 30, label: '30 días' },
        { value: 60, label: '60 días' },
    ];
    const prevRuleOptions = [
        { value: 'ask', label: 'Preguntar' },
        { value: 'always', label: 'Marcar todos' },
        { value: 'never', label: 'Solo ese' },
    ];

    const renderSwitch = (key, checked, label, hint) => `
        <div class="tvst-setting-row">
            <div class="tvst-setting-copy">
                <span class="tvst-setting-label">${escapeHtml(label)}</span>
                ${hint ? `<p class="tvst-setting-hint">${escapeHtml(hint)}</p>` : ''}
            </div>
            <button type="button"
                role="switch"
                aria-checked="${checked ? 'true' : 'false'}"
                aria-label="${escapeHtml(label)}"
                class="tvst-switch${checked ? ' is-on' : ''}"
                onclick="updatePreference('${escapeHtml(key)}', ${checked ? 'false' : 'true'})">
                <span class="tvst-switch-thumb"></span>
            </button>
        </div>
    `;

    const mySubs = new Set(getMySubscriptions().map(s => s.toLowerCase()));
    const providersList = typeof FEATURED_PROVIDERS !== 'undefined' ? FEATURED_PROVIDERS : [];

    container.innerHTML = `
        <div class="tvst-section-card">
            <h3 class="tvst-settings-card-title">Experiencia y seguimiento</h3>
            <div class="tvst-settings-group-list">
                <div class="tvst-setting-row">
                    <div class="tvst-setting-copy">
                        <label class="tvst-setting-label" for="pref-start-tab">Pestaña de inicio</label>
                        <p class="tvst-setting-hint">Vista que se abre automáticamente al iniciar la app.</p>
                    </div>
                    <select id="pref-start-tab" class="tvst-setting-select" onchange="updatePreference('startTab', this.value)">
                        ${startTabOptions.map(o => `<option value="${escapeHtml(o.value)}"${prefs.startTab === o.value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
                    </select>
                </div>
                <div class="tvst-setting-row">
                    <div class="tvst-setting-copy">
                        <label class="tvst-setting-label" for="pref-inactivity-days">Días para «En espera»</label>
                        <p class="tvst-setting-hint">Tiempo sin ver episodios antes de bajar a inactivas.</p>
                    </div>
                    <select id="pref-inactivity-days" class="tvst-setting-select" onchange="updatePreference('inactivityDays', Number(this.value))">
                        ${inactivityOptions.map(o => `<option value="${o.value}"${Number(prefs.inactivityDays) === o.value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
                    </select>
                </div>
                <div class="tvst-setting-row">
                    <div class="tvst-setting-copy">
                        <label class="tvst-setting-label" for="pref-prev-rule">Episodios anteriores</label>
                        <p class="tvst-setting-hint">Acción al marcar un capítulo con anteriores pendientes.</p>
                    </div>
                    <select id="pref-prev-rule" class="tvst-setting-select" onchange="updatePreference('previousEpisodesRule', this.value)">
                        ${prevRuleOptions.map(o => `<option value="${escapeHtml(o.value)}"${prefs.previousEpisodesRule === o.value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
                    </select>
                </div>
            </div>
        </div>

        <div class="tvst-section-card">
            <h3 class="tvst-settings-card-title">Visualización</h3>
            <div class="tvst-settings-group-list">
                ${renderSwitch(
                    'spoilerFree',
                    prefs.spoilerFree,
                    'Modo sin spoilers',
                    'Oculta títulos, imágenes y sinopsis de episodios aún no vistos.',
                )}
                ${renderSwitch(
                    'includeSpecials',
                    prefs.includeSpecials,
                    'Incluir especiales (T0)',
                    'Incluye los episodios especiales en listas y cálculo de progreso.',
                )}
                ${renderSwitch(
                    'showMoviePosterTitles',
                    prefs.showMoviePosterTitles,
                    'Títulos bajo pósters',
                    'Muestra el nombre debajo de cada carátula en Películas.',
                )}
                ${renderSwitch(
                    'showMoviePosterRatings',
                    prefs.showMoviePosterRatings,
                    'Nota TMDB en pósters',
                    'Muestra la puntuación de TMDB sobre cada póster en Películas.',
                )}
                ${renderSwitch(
                    'showTrailers',
                    prefs.showTrailers,
                    'Tráiler en la ficha',
                    'Muestra el botón y reproductor de tráiler dentro de cada ficha.',
                )}
                ${renderSwitch(
                    'showUpcomingMiniCalendar',
                    prefs.showUpcomingMiniCalendar,
                    'Minicalendario en Próximamente',
                    'Muestra la vista semanal interactiva en Series y Películas.',
                )}
            </div>
        </div>

        <div class="tvst-section-card">
            <h3 class="tvst-settings-card-title">Plataformas y región</h3>
            <div class="tvst-settings-group-list">
                <div class="tvst-setting-row">
                    <div class="tvst-setting-copy">
                        <label class="tvst-setting-label" for="pref-provider-country">País de catálogo</label>
                        <p class="tvst-setting-hint">Región usada para mostrar dónde ver cada título.</p>
                    </div>
                    <select id="pref-provider-country" class="tvst-setting-select" onchange="updatePreference('providerCountry', this.value)">
                        ${PROVIDER_COUNTRIES.map(c => `<option value="${escapeHtml(c.code)}"${prefs.providerCountry === c.code ? ' selected' : ''}>${escapeHtml(c.label)}</option>`).join('')}
                    </select>
                </div>
                <div class="tvst-setting-row is-stacked">
                    <div class="tvst-setting-copy">
                        <span class="tvst-setting-label">Mis plataformas</span>
                        <p class="tvst-setting-hint">Destaca tus servicios en las fichas y activa un filtro rápido en Películas.</p>
                    </div>
                    <div class="tvst-setting-chips">
                        ${providersList.map(name => {
                            const active = mySubs.has(name.toLowerCase());
                            const safeName = escapeHtml(name).replace(/'/g, '&#39;');
                            return `<button type="button" class="tvst-setting-chip${active ? ' is-active' : ''}" onclick="toggleSubscriptionPreference('${safeName}')">${escapeHtml(name)}</button>`;
                        }).join('')}
                    </div>
                </div>
            </div>
        </div>

        <div class="tvst-section-card">
            <h3 class="tvst-settings-card-title">Caché de TMDB</h3>
            <p class="tvst-settings-desc">Recarga metadatos de episodios, estrenos y plataformas si notas información desactualizada.</p>
            <div class="tvst-settings-actions">
                <button type="button" onclick="clearTmdbCachesFromSettings()" class="tvst-settings-btn">Limpiar caché TMDB</button>
            </div>
        </div>
    `;
}

const trendingFetchInflight = { tv: null, movie: null };

function syncExploreTrendingTabButtons(activeTab = AppState.exploreTrendingTab) {
    const tab = activeTab === 'movie' ? 'movie' : 'tv';
    document.getElementById('explore-trending-tab-tv')?.classList.toggle('is-active', tab === 'tv');
    document.getElementById('explore-trending-tab-movie')?.classList.toggle('is-active', tab === 'movie');
}

function setExploreTrendingTabsVisible(visible) {
    const nav = document.getElementById('explore-trending-tabs');
    if (nav) nav.classList.toggle('hidden', !visible);
}

function switchExploreTrendingTab(tab) {
    const normalized = tab === 'movie' ? 'movie' : 'tv';
    if (AppState.exploreTrendingTab === normalized) {
        syncExploreTrendingTabButtons(normalized);
        return;
    }
    AppState.exploreTrendingTab = normalized;
    syncExploreTrendingTabButtons(normalized);
    setScrollTop(0, 'auto');
    void renderExplore();
}

function syncExploreSearchClearButton() {
    const input = document.getElementById('search-input');
    const btn = document.getElementById('explore-search-clear');
    if (!btn) return;
    btn.classList.toggle('hidden', !String(input?.value || '').trim().length);
}

function clearExploreSearch() {
    const input = document.getElementById('search-input');
    if (input) {
        input.value = '';
        input.focus();
    }
    if (typeof cancelSearchDebounce === 'function') {
        cancelSearchDebounce();
    }
    AppState.lastSearchResults = [];
    syncExploreSearchClearButton();
    setScrollTop(0, 'auto');
    void renderExplore();
}

function renderTrendingShowcase(items, { mediaType = 'tv' } = {}) {
    const listItems = (items || []).slice(0, 10);
    if (!listItems.length) return '';

    const hero = listItems[0];
    const rest = listItems.slice(1);
    const isMovieTab = mediaType === 'movie';
    const sectionTitle = isMovieTab ? 'Tendencias hoy · Películas' : 'Tendencias hoy · Series';

    const heroType = hero.tipo === 'tv' ? 'tv' : 'movie';
    const heroId = Number(hero.id_tmdb) || 0;
    const heroAdded = isItemAlreadyAdded(heroType, heroId);
    const heroBg = safeUrl(hero.backdrop || hero.portada);
    const heroYear = getItemYearString(hero);
    const heroScore = Number(hero.vote_average);
    const heroScoreText = Number.isFinite(heroScore) && heroScore > 0 ? `★ ${heroScore.toFixed(1)}` : '';
    const heroTypeLabel = heroType === 'movie' ? 'Película' : 'Serie';

    const heroHtml = `
        <article class="tvst-trending-hero" onclick="openDetail('${heroType}', ${heroId})">
            ${heroBg ? `<img class="tvst-trending-hero-bg" src="${escapeHtml(heroBg)}" alt="">` : ''}
            <div class="tvst-trending-hero-scrim"></div>
            <div class="tvst-trending-hero-top">
                <span class="tvst-trending-hero-rank">#1 Tendencia</span>
                <button type="button"
                    class="tvst-trending-hero-add${heroAdded ? ' is-added' : ''}"
                    ${heroAdded ? 'disabled' : ''}
                    onclick="event.stopPropagation();${heroAdded ? '' : `addItem('${heroType}', ${heroId})`}"
                    aria-label="${heroAdded ? 'Ya añadido' : 'Añadir'}">
                    ${heroAdded ? UI_ICONS.check : UI_ICONS.plus}
                    <span>${heroAdded ? 'En tu lista' : 'Añadir'}</span>
                </button>
            </div>
            <div class="tvst-trending-hero-body">
                <p class="tvst-trending-hero-meta">
                    <span>${escapeHtml(heroTypeLabel)}</span>
                    ${heroYear ? `<span>· ${escapeHtml(heroYear)}</span>` : ''}
                    ${heroScoreText ? `<span class="tvst-trending-hero-score">· ${escapeHtml(heroScoreText)}</span>` : ''}
                </p>
                <h3 class="tvst-trending-hero-title">${escapeHtml(hero.titulo || 'Sin título')}</h3>
                ${hero.overview ? `<p class="tvst-trending-hero-overview">${escapeHtml(hero.overview)}</p>` : ''}
            </div>
        </article>
    `;

    const gridHtml = rest.length ? `
        <div class="tvst-trending-grid">
            ${rest.map((item, idx) => {
                const tipo = item.tipo === 'tv' ? 'tv' : 'movie';
                const idTmdb = Number(item.id_tmdb) || 0;
                const added = isItemAlreadyAdded(tipo, idTmdb);
                const posterUrl = safeUrl(item.portada || item.backdrop);
                const year = getItemYearString(item);
                const tmdbScore = Number(item.vote_average);
                const scoreText = Number.isFinite(tmdbScore) && tmdbScore > 0 ? `★ ${tmdbScore.toFixed(1)}` : '';
                const kindLabel = tipo === 'movie' ? 'Película' : 'Serie';
                return `
                <article class="tvst-trending-card" onclick="openDetail('${tipo}', ${idTmdb})">
                    <div class="tvst-trending-poster">
                        ${posterUrl
                            ? `<img src="${escapeHtml(posterUrl)}" alt="" loading="lazy">`
                            : `<div class="tvst-poster-fallback">${UI_ICONS.film}</div>`}
                        <span class="tvst-trending-rank">#${idx + 2}</span>
                        <button type="button"
                            class="tvst-add-btn${added ? ' is-added' : ''}"
                            ${added ? 'disabled' : ''}
                            onclick="event.stopPropagation();${added ? '' : `addItem('${tipo}', ${idTmdb})`}"
                            aria-label="${added ? 'Ya añadido' : 'Añadir'}">${added ? UI_ICONS.check : UI_ICONS.plus}</button>
                        <div class="tvst-trending-poster-meta">
                            <span>${escapeHtml(kindLabel)}</span>
                            ${scoreText ? `<span class="tvst-trending-poster-score">${escapeHtml(scoreText)}</span>` : ''}
                        </div>
                    </div>
                    <h3 class="tvst-trending-card-title">${escapeHtml(item.titulo || 'Sin título')}</h3>
                    ${year ? `<p class="tvst-trending-card-year">${escapeHtml(year)}</p>` : ''}
                </article>`;
            }).join('')}
        </div>
    ` : '';

    return `
        <div class="tvst-explore-section-head">
            <h2 class="tvst-explore-section-title">${escapeHtml(sectionTitle)}</h2>
            <span class="tvst-explore-section-badge">Top 10 · TMDB</span>
        </div>
        ${heroHtml}
        ${gridHtml}
    `;
}

async function renderExplore() {
    const list = document.getElementById('search-results');
    const input = document.getElementById('search-input');
    if (!list) return;
    syncExploreSearchClearButton();

    const query = (input?.value || '').trim();
    if (query.length >= 2) {
        setExploreTrendingTabsVisible(false);
        renderSearchResults(AppState.lastSearchResults);
        return;
    }

    if (query.length > 0) {
        setExploreTrendingTabsVisible(false);
        list.className = 'tvst-search-list';
        list.innerHTML = emptyState(
            'search',
            'Sigue escribiendo',
            { subtitle: 'Escribe al menos 2 caracteres para buscar series o películas.' },
        );
        return;
    }

    const mediaType = AppState.exploreTrendingTab === 'movie' ? 'movie' : 'tv';
    syncExploreTrendingTabButtons(mediaType);

    if (typeof window.getTrendingSuggestions !== 'function' || (typeof hasTmdbConfig === 'function' && !hasTmdbConfig())) {
        setExploreTrendingTabsVisible(false);
        list.className = 'tvst-search-list';
        list.innerHTML = emptyState(
            'search',
            'Explora títulos',
            { subtitle: 'Escribe al menos 2 caracteres para buscar series o películas.' },
        );
        return;
    }

    setExploreTrendingTabsVisible(true);

    const cachedList = AppState.trendingCache?.[mediaType] || [];
    if (cachedList.length) {
        list.className = 'tvst-trending-view';
        list.innerHTML = renderTrendingShowcase(cachedList, { mediaType });
        return;
    }

    const sectionTitle = mediaType === 'movie' ? 'Tendencias hoy · Películas' : 'Tendencias hoy · Series';
    list.className = 'tvst-trending-view';
    list.innerHTML = `
        <div class="tvst-explore-section-head">
            <h2 class="tvst-explore-section-title">${escapeHtml(sectionTitle)}</h2>
            <span class="tvst-explore-section-badge">Top 10 · TMDB</span>
        </div>
        ${renderSkeletonList(5, 'episodes')}
    `;

    try {
        if (!trendingFetchInflight[mediaType]) {
            trendingFetchInflight[mediaType] = window.getTrendingSuggestions(mediaType, 10).finally(() => {
                trendingFetchInflight[mediaType] = null;
            });
        }
        const trending = await trendingFetchInflight[mediaType];
        const normalized = Array.isArray(trending) ? trending.slice(0, 10) : [];
        if (!AppState.trendingCache || typeof AppState.trendingCache !== 'object') {
            AppState.trendingCache = { tv: [], movie: [] };
        }
        AppState.trendingCache[mediaType] = normalized;

        const liveQuery = (document.getElementById('search-input')?.value || '').trim();
        if (liveQuery.length > 0 || AppState.exploreTrendingTab !== mediaType) return;

        if (normalized.length) {
            list.className = 'tvst-trending-view';
            list.innerHTML = renderTrendingShowcase(normalized, { mediaType });
        } else {
            list.className = 'tvst-search-list';
            list.innerHTML = emptyState(
                'search',
                'Explora títulos',
                { subtitle: 'Escribe al menos 2 caracteres para buscar series o películas.' },
            );
        }
    } catch (error) {
        const liveQuery = (document.getElementById('search-input')?.value || '').trim();
        if (liveQuery.length > 0 || AppState.exploreTrendingTab !== mediaType) return;
        list.className = 'tvst-search-list';
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
    const endedTtlMs = 7 * 24 * 60 * 60 * 1000;
    const stale = isShowOfficiallyEnded(show) && show.metaCheckedAt
        ? (Date.now() - Date.parse(show.metaCheckedAt)) > endedTtlMs
        : isShowMetaStale(show);

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
        if (fresh && 'next_episode_to_air' in fresh) {
            show.next_episode_to_air = fresh.next_episode_to_air ?? null;
        }
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
            const official = String(show.status || '').trim().toLowerCase();
            if (!forceRun && (official === 'ended' || official === 'canceled' || official === 'cancelled') && show.temporadas?.length && !isShowMetaStale(show)) {
                return;
            }
            const beforeEstado = normalizeStatus(show.estado);
            const beforeMeta = show.metaCheckedAt || '';
            const beforeSeasons = countRegularSeasons(show);
            const beforeLatestEpCount = getLatestRegularSeasonEpisodeCount(show);

            // TTL 12h: sin force salvo forceRun explícito o meta ausente/stale
            await ensureShowSeasonMeta(show, { force: forceRun });

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
            let seasonDetailsMap = null;
            if (typeof getSeasonsBatch === 'function' && seasons.length > 1) {
                try {
                    seasonDetailsMap = await getSeasonsBatch(show.id_tmdb, seasons.map(s => s.numero));
                } catch (batchErr) {
                    console.warn(`[App] Batch temporadas falló en ${show.titulo || show.id_tmdb}, usando individual:`, batchErr);
                }
            }

            const seasonDetailsList = await Promise.all(seasons.map(async season => {
                try {
                    const details = seasonDetailsMap?.has(Number(season.numero))
                        ? seasonDetailsMap.get(Number(season.numero))
                        : await getSeasonDetails(show.id_tmdb, season.numero);
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
                } catch (seasonError) {
                    console.warn(`[App] Error cargando temporada ${season.numero} de ${show.titulo || show.id_tmdb}:`, seasonError);
                    return [];
                }
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
            console.warn('[App] Error obteniendo episodios:', error);
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

    const regularSeasons = (show.temporadas || []).filter(season => shouldIncludeSpecials() || (!season.especial && season.numero !== 0));
    if (regularSeasons.length === 0) {
        show.estado = previousState;
        return show;
    }

    const episodes = await getOrderedEpisodes(show, { includeSpecials: shouldIncludeSpecials() });
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

    const hasUnwatchedAiredEpisodes =
        airedEpisodes.some(ep => !isEpisodeConsumed(show, ep.id));
    
    if (hasUnwatchedAiredEpisodes) {
        show.estado = 'watching';
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

function renderExploreRowsMarkup(items, options = {}) {
    const { showRank = false } = options;
    const typeIcon = (tipo) => tipo === 'movie'
        ? '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M7 5l2-2h6l2 2"/></svg>'
        : '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="13" rx="1.5"/><path d="M8 3l4 3 4-3"/></svg>';

    return (items || []).map((item, idx) => {
        const tipo = item.tipo === 'tv' ? 'tv' : 'movie';
        const idTmdb = Number(item.id_tmdb) || 0;
        const added = isItemAlreadyAdded(tipo, idTmdb);
        const posterUrl = safeUrl(item.portada);
        let subLabel = '';
        if (showRank) {
            const kindLabel = tipo === 'movie' ? 'Película' : 'Serie';
            const year = getItemYearString(item);
            const tmdbScore = Number(item.vote_average);
            const scoreText = Number.isFinite(tmdbScore) && tmdbScore > 0 ? `★ ${tmdbScore.toFixed(1)}` : '';
            subLabel = [kindLabel, year, scoreText].filter(Boolean).join(' · ');
        } else {
            const popularitySource = item.vote_count || item.popularity || 0;
            subLabel = formatPopularityLabel(popularitySource, tipo);
        }

        return `
        <article class="tvst-search-row" onclick="openDetail('${tipo}', ${idTmdb})">
            <div class="tvst-search-poster">
                ${posterUrl
                    ? `<img src="${escapeHtml(posterUrl)}" alt="">`
                    : `<div class="tvst-poster-fallback">${UI_ICONS.film}</div>`}
                ${showRank ? `<span class="tvst-trending-rank">#${idx + 1}</span>` : ''}
            </div>
            <div class="tvst-search-body">
                <h3 class="tvst-search-title">${escapeHtml(item.titulo || 'Sin título')}</h3>
                <div class="tvst-search-sub">
                    ${typeIcon(tipo)}
                    <span>${escapeHtml(subLabel)}</span>
                </div>
            </div>
            <button type="button"
                class="tvst-add-btn${added ? ' is-added' : ''}"
                ${added ? 'disabled' : ''}
                onclick="event.stopPropagation();${added ? '' : `addItem('${tipo}', ${idTmdb})`}"
                aria-label="${added ? 'Ya añadido' : 'Añadir'}">${added ? UI_ICONS.check : UI_ICONS.plus}</button>
        </article>`;
    }).join('');
}

function renderSearchResults(results) {
    AppState.lastSearchResults = results || [];
    const list = document.getElementById('search-results');
    if (!list) return;

    if (!AppState.lastSearchResults.length) {
        list.className = 'tvst-search-list';
        list.innerHTML = emptyState('search', 'No se encontraron resultados');
        return;
    }

    list.className = 'tvst-search-list';
    list.innerHTML = renderExploreRowsMarkup(AppState.lastSearchResults, { showRank: false });
}

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

    const isEpisodesTabActive = document.getElementById('detail-episodes-tab')?.classList.contains('is-active');
    episodesSection?.classList.toggle('hidden', !isEpisodesTabActive);
    container.innerHTML = renderSkeletonList(4, 'episodes');

    try {
        const ordered = await getOrderedEpisodes(show, { includeSpecials: shouldIncludeSpecials() });
        const airedOrdered = ordered.filter(isEpisodeAired);
        const remainingOrdered = airedOrdered.filter(ep => !isEpisodeConsumed(show, ep.id));
        const nextUnwatched = remainingOrdered.slice(0, 2);
        const remainingMinutes = remainingOrdered.length * getShowEpisodeRuntimeMinutes(show);
        const remainingBannerHTML = remainingOrdered.length > 0 ? `
            <div class="tvst-ep-remaining-banner">
                <span>Tiempo restante en esta serie</span>
                <strong>~${escapeHtml(formatCompactDuration(remainingMinutes))} · ${remainingOrdered.length} ${remainingOrdered.length === 1 ? 'ep.' : 'ep.'}</strong>
            </div>` : '';

        const episodesBySeason = new Map();
        for (const ep of ordered) {
            const key = Number(ep.seasonNumber);
            if (!episodesBySeason.has(key)) episodesBySeason.set(key, []);
            episodesBySeason.get(key).push(ep);
        }

        let continueHTML = remainingBannerHTML;
        const showIdTmdb = Number(show.id_tmdb) || 0;
        if (nextUnwatched.length) {
            continueHTML += `
                <div class="tvst-ep-section-title">Continuar el seguimiento</div>
                <div class="tvst-continue-cards">
                    ${nextUnwatched.map(ep => {
                        const rawStill = ep.still_path ? getImageUrl(ep.still_path, 'w185') : null;
                        const still = safeUrl(rawStill);
                        const watched = isEpisodeWatched(show, ep.id);
                        const safeEpId = escapeHtml(ep.id);
                        const epSeasonNum = Number(ep.seasonNumber) || 0;
                        const hideSpoiler = shouldMaskEpisodeSpoilers(show, ep.id);
                        return `
                        <div class="tvst-continue-card" onclick="openEpisodeDetail(${showIdTmdb}, '${safeEpId}')" role="button" tabindex="0">
                            ${still
                                ? `<img class="tvst-continue-still${hideSpoiler ? ' is-spoiler-blur' : ''}" src="${escapeHtml(still)}" alt="">`
                                : '<div class="tvst-continue-still"></div>'}
                            <div class="tvst-continue-text">
                                <div class="tvst-continue-code">${escapeHtml(formatEpisodeLabel(epSeasonNum, ep.episodeNumber))}</div>
                                <div class="tvst-continue-name${hideSpoiler ? ' tvst-spoiler-mask' : ''}">${hideSpoiler ? 'Título oculto' : escapeHtml(ep.name || 'Episodio')}</div>
                            </div>
                            <button type="button"
                                class="tvst-circle-check${watched ? ' is-watched' : ''}"
                                onclick="event.stopPropagation(); toggleEpisodeAndUpdateSeason(${showIdTmdb}, '${safeEpId}', ${epSeasonNum}, 'season-${epSeasonNum}')"
                                aria-label="${watched ? 'Desmarcar visto' : 'Marcar visto'}">${UI_ICONS.check}</button>
                        </div>`;
                    }).join('')}
                </div>`;
        }

        const sortedSeasons = [...(show.temporadas || [])]
            .filter(s => shouldIncludeSpecials() || (!s.especial && s.numero !== 0))
            .sort((a, b) => a.numero - b.numero);

        let seasonsHTML = '<div class="tvst-ep-section-title">Todos los episodios</div>';

        for (const season of sortedSeasons) {
            const seasonNum = Number(season.numero) || 0;
            const seasonEpisodes = episodesBySeason.get(seasonNum) || [];
            const seasonId = `season-${seasonNum}`;
            const seasonKey = `${showIdTmdb}-season-${seasonNum}`;
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
                ? `${watchedInSeason} / ${totalInSeason} · ${skippedInSeason} salt.`
                : `${watchedInSeason}/${totalInSeason}`;

            seasonsHTML += `
                <div class="tvst-season-block">
                    <div class="tvst-season-header" role="button" tabindex="0" onclick="toggleSeasonAccordion('${escapeHtml(seasonId)}', '${escapeHtml(seasonKey)}')">
                        <div class="tvst-season-header-row">
                            <div class="tvst-season-header-main">
                                <p class="tvst-season-name">${escapeHtml(seasonLabel)}</p>
                                <span class="tvst-season-chevron${isExpanded ? ' is-open' : ''}" id="chevron-${escapeHtml(seasonId)}">${UI_ICONS.chevronDown}</span>
                            </div>
                            <span class="tvst-season-count">${escapeHtml(countLabel)}</span>
                            <button type="button"
                                class="tvst-skip-btn${allSkippedInSeason ? ' is-skipped' : ''}"
                                onclick="event.stopPropagation(); toggleSeasonSkipped(${showIdTmdb}, ${seasonNum})"
                                aria-label="${allSkippedInSeason ? 'Quitar salto de temporada' : 'Saltar temporada'}"
                                title="${allSkippedInSeason ? 'Quitar salto' : 'Saltar temporada'}">${UI_ICONS.skip}</button>
                            <button type="button"
                                class="tvst-circle-check${allWatchedInSeason ? ' is-watched' : ''}"
                                onclick="event.stopPropagation(); toggleSeasonWatched(${showIdTmdb}, ${seasonNum})"
                                aria-label="Marcar temporada">${UI_ICONS.check}</button>
                        </div>
                        <div class="tvst-season-bar-track">
                            <div class="tvst-season-bar-fill${allConsumedInSeason ? ' is-complete' : ''}" style="width:${Math.max(0, Math.min(100, pct))}%"></div>
                        </div>
                    </div>
                    <div id="${escapeHtml(seasonId)}" class="${isExpanded ? '' : 'hidden'}">
                        ${seasonEpisodes.map(episode => {
                            const episodeId = episode.id;
                            const safeEpisodeId = escapeHtml(episodeId);
                            const isWatched = isEpisodeWatched(show, episodeId);
                            const isSkipped = isEpisodeSkipped(show, episodeId);
                            const rawEpisodeImage = episode.still_path ? getImageUrl(episode.still_path, 'w185') : null;
                            const episodeImage = safeUrl(rawEpisodeImage);
                            const aired = isEpisodeAired(episode);
                            const hideSpoiler = shouldMaskEpisodeSpoilers(show, episodeId);
                            return `
                            <div class="tvst-ep-row${isSkipped ? ' is-skipped' : ''}" onclick="openEpisodeDetail(${showIdTmdb}, '${safeEpisodeId}')" role="button" tabindex="0">
                                ${episodeImage
                                    ? `<img class="tvst-ep-still${hideSpoiler ? ' is-spoiler-blur' : ''}" src="${escapeHtml(episodeImage)}" alt="" onerror="this.style.visibility='hidden'">`
                                    : '<div class="tvst-ep-still"></div>'}
                                <div class="tvst-ep-text">
                                    <div class="tvst-ep-code">${escapeHtml(formatEpisodeLabel(seasonNum, episode.episodeNumber))}</div>
                                    <div class="tvst-ep-name${hideSpoiler ? ' tvst-spoiler-mask' : ''}">${hideSpoiler ? 'Título oculto' : `${escapeHtml(episode.name || 'Episodio')}${isSkipped ? ' · Saltado' : ''}`}</div>
                                </div>
                                <button type="button"
                                    class="tvst-skip-btn${isSkipped ? ' is-skipped' : ''}"
                                    ${aired ? '' : 'disabled'}
                                    onclick="event.stopPropagation(); toggleEpisodeSkipped(${showIdTmdb}, '${safeEpisodeId}')"
                                    aria-label="${isSkipped ? 'Quitar salto' : 'Saltar episodio'}"
                                    title="${isSkipped ? 'Quitar salto' : 'Saltar'}">${UI_ICONS.skip}</button>
                                <button type="button"
                                    class="tvst-circle-check${isWatched ? ' is-watched' : ''}"
                                    ${aired ? '' : 'disabled'}
                                    onclick="event.stopPropagation(); toggleEpisodeAndUpdateSeason(${showIdTmdb}, '${safeEpisodeId}', ${seasonNum}, '${escapeHtml(seasonId)}')">${UI_ICONS.check}</button>
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
        if (chevron) chevron.classList.add('is-open');
        AppState.expandedSeasons[seasonKey] = true;
    } else {
        seasonElement.classList.add('hidden');
        if (chevron) chevron.classList.remove('is-open');
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

    const episodes = await getOrderedEpisodes(show, { includeSpecials: shouldIncludeSpecials() });
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
        if (await resolveMarkPreviousEpisodes(show, episodes, episode, 'Sí, marcar')) {
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

    const episodes = await getOrderedEpisodes(show, { includeSpecials: shouldIncludeSpecials() });
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
        videos: Array.isArray(freshDetails.videos) ? freshDetails.videos : (Array.isArray(existingItem.videos) ? existingItem.videos : []),
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
        <button type="button" class="tvst-overflow-item${a.danger ? ' is-danger' : ''}" onclick="runDetailMenuAction('${escapeHtml(a.id)}')">${escapeHtml(a.label)}</button>
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
        const safeBg = escapeCssUrl(item.backdrop || item.portada || '');
        hero.style.backgroundImage = safeBg ? `url('${safeBg}')` : 'none';
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
        const yearMatch = item.fecha_estreno ? String(item.fecha_estreno).match(/^(\d{4})/) : null;
        const year = yearMatch ? yearMatch[1] : null;
        const provider = item.watch_providers?.[0]?.provider_name;
        const parts = ['Película'];
        if (year) parts.push(year);
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

    const remainingEl = document.getElementById('modal-hero-remaining');
    if (remainingEl) {
        if (item.tipo === 'tv') {
            const inLibrary = isItemAlreadyAdded('tv', item.id_tmdb);
            const remaining = getShowRemainingTimeInfo(item, { includeDropped: true });
            if (remaining && remaining.remainingEpisodes > 0) {
                const epWord = remaining.remainingEpisodes === 1 ? 'episodio' : 'episodios';
                remainingEl.textContent = inLibrary
                    ? `Tiempo restante: ~${remaining.label} (${remaining.remainingEpisodes} ${epWord})`
                    : `Duración aprox.: ~${remaining.label} (${remaining.remainingEpisodes} ${epWord})`;
                remainingEl.classList.remove('hidden');
            } else {
                remainingEl.textContent = '';
                remainingEl.classList.add('hidden');
            }
        } else {
            remainingEl.textContent = '';
            remainingEl.classList.add('hidden');
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

    const heroTrailerBtn = document.getElementById('modal-hero-trailer-btn');
    if (heroTrailerBtn) {
        const hasVideos = areTrailersEnabled() && getValidItemVideos(item).length > 0;
        heroTrailerBtn.classList.toggle('hidden', !hasVideos);
    }
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
            onclick="runDetailMenuAction('${escapeHtml(action.id)}')"
            aria-label="${escapeHtml(action.label)}"
            title="${escapeHtml(action.label)}">${DETAIL_HERO_ACTION_ICONS[action.id] || '•'}</button>
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

    const rawStillUrl = episode.still_path
        ? (String(episode.still_path).startsWith('http') ? episode.still_path : getImageUrl(episode.still_path, 'w780'))
        : (show.backdrop || show.portada);
    const stillUrl = safeUrl(rawStillUrl);

    const liveShow = AppState.shows.find(s => s.id_tmdb === ctx.showId) || show;
    const revealKey = `${ctx.showId}:${episodeId}`;
    const hideSpoiler = shouldMaskEpisodeSpoilers(liveShow, episodeId) && !AppState.revealedSpoilerEpisodeKeys[revealKey];
    const spoilerBtn = document.getElementById('episode-spoiler-btn');

    if (stillEl) {
        stillEl.classList.toggle('is-spoiler-blur', hideSpoiler && Boolean(episode.still_path));
        stillEl.innerHTML = stillUrl
            ? `<img src="${escapeHtml(stillUrl)}" alt="">`
            : `<div class="tvst-episode-still-fallback">${UI_ICONS.tv}</div>`;
    }

    if (pill) {
        pill.innerHTML = `<span>${escapeHtml(show.titulo || 'Serie')}</span>${UI_ICONS.chevronRight}`;
        pill.onclick = (e) => {
            e.preventDefault();
            closeEpisodeModal();
            openDetail('tv', ctx.showId);
        };
    }

    if (codeEl) codeEl.textContent = formatEpisodeLabel(episode.seasonNumber, episode.episodeNumber);
    if (titleEl) {
        titleEl.textContent = hideSpoiler ? 'Episodio oculto' : (episode.name || 'Episodio');
        titleEl.classList.toggle('tvst-spoiler-mask', hideSpoiler);
    }
    if (airEl) {
        airEl.textContent = episode.air_date
            ? `Emisión: ${formatAirDateShort(episode.air_date)}`
            : 'Fecha de emisión desconocida';
    }
    if (overviewEl) {
        overviewEl.textContent = hideSpoiler
            ? 'Detalles ocultos por el modo sin spoilers.'
            : (episode.overview || 'Sin descripción');
        overviewEl.classList.toggle('tvst-spoiler-mask', hideSpoiler);
    }
    if (spoilerBtn) {
        spoilerBtn.classList.toggle('hidden', !hideSpoiler);
    }

    const watched = isEpisodeWatched(liveShow, episodeId);
    const skipped = isEpisodeSkipped(liveShow, episodeId);
    if (watchBtn) {
        watchBtn.classList.toggle('is-watched', Boolean(watched));
        watchBtn.setAttribute('aria-label', watched ? 'Desmarcar visto' : 'Marcar visto');
    }
    const skipBtn = document.getElementById('episode-skip-btn');
    if (skipBtn) {
        skipBtn.classList.toggle('is-skipped', Boolean(skipped));
        skipBtn.innerHTML = `${UI_ICONS.skip}<span>${skipped ? 'Quitar salto' : 'Saltar'}</span>`;
        skipBtn.setAttribute('aria-label', skipped ? 'Quitar salto' : 'Saltar episodio');
        const aired = isEpisodeAired(episode);
        skipBtn.disabled = !aired;
    }

    const idx = seasonEpisodes.findIndex(ep => ep.id === episodeId);
    if (prevBtn) prevBtn.disabled = idx <= 0;
    if (nextBtn) nextBtn.disabled = idx < 0 || idx >= seasonEpisodes.length - 1;
}

function revealCurrentEpisodeSpoilers() {
    const ctx = AppState.selectedEpisode;
    if (!ctx) return;
    AppState.revealedSpoilerEpisodeKeys[`${ctx.showId}:${ctx.episodeId}`] = true;
    paintEpisodeModal();
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

        const profileUrl = safeUrl(details.profile_path);
        if (photoEl) {
            photoEl.innerHTML = profileUrl
                ? `<img src="${escapeHtml(profileUrl)}" alt="">`
                : `<div class="tvst-person-photo-fallback">${UI_ICONS.person}</div>`;
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
                creditsEl.innerHTML = credits.map(item => {
                    const creditTipo = item.tipo === 'tv' ? 'tv' : 'movie';
                    const creditId = Number(item.id_tmdb) || 0;
                    const creditPoster = safeUrl(item.portada);
                    return `
                    <article class="tvst-person-credit-card" onclick="openDetailFromPerson('${creditTipo}', ${creditId})">
                        ${creditPoster
                            ? `<img src="${escapeHtml(creditPoster)}" alt="">`
                            : `<div class="tvst-person-credit-fallback">${UI_ICONS.film}</div>`}
                        <div class="tvst-person-credit-meta">
                            <p class="tvst-person-credit-title">${escapeHtml(item.titulo || '')}</p>
                            <p class="tvst-person-credit-sub">${escapeHtml([item.year, creditTipo === 'tv' ? 'Serie' : 'Película', item.character].filter(Boolean).join(' · '))}</p>
                        </div>
                    </article>`;
                }).join('');
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
    AppState.detailCriticaEditing = false;
    AppState.activeTrailerKey = null;

    showLoading(true);

    try {
        const libraryItem = type === 'movie'
            ? AppState.movies.find(m => m.id_tmdb === id_tmdb)
            : AppState.shows.find(s => s.id_tmdb === id_tmdb);
        let item = libraryItem;

        const castMissingIds = Array.isArray(item?.credits?.cast)
            && item.credits.cast.length > 0
            && !item.credits.cast.some(p => Number(p.id) > 0);
        const currentCountry = getPreferredProviderCountry();
        const needsFreshDetails = !item?.overview || !item?.credits?.cast?.length || castMissingIds || !item?.recommendations?.length || !item?.backdrop;
        const needsProviders = !item?.watch_providers?.length;
        const needsVideos = areTrailersEnabled() && !Array.isArray(item?.videos);
        const needsReleaseDate = type === 'movie' && Boolean(libraryItem) && libraryItem.release_date_country !== currentCountry;

        const [fresh, watchProviders, fetchedVideos, fetchedRelease] = await Promise.all([
            needsFreshDetails
                ? (type === 'movie' ? getMovieDetails(id_tmdb) : getTVDetails(id_tmdb))
                : Promise.resolve(null),
            !needsFreshDetails && needsProviders && typeof window.getWatchProviders === 'function'
                ? window.getWatchProviders(type === 'movie' ? 'movie' : 'tv', id_tmdb)
                : Promise.resolve(null),
            !needsFreshDetails && needsVideos && typeof window.getTitleVideos === 'function'
                ? window.getTitleVideos(type === 'movie' ? 'movie' : 'tv', id_tmdb)
                : Promise.resolve(null),
            !needsFreshDetails && needsReleaseDate && typeof window.getMovieRegionalReleaseDate === 'function'
                ? window.getMovieRegionalReleaseDate(id_tmdb, currentCountry)
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
        if (Array.isArray(fetchedVideos)) {
            item.videos = fetchedVideos;
            if (libraryItem) libraryItem.videos = fetchedVideos;
        }
        if (fetchedRelease && type === 'movie') {
            let releaseMetaChanged = false;
            if (fetchedRelease.fecha_estreno && fetchedRelease.fecha_estreno !== item.fecha_estreno) {
                item.fecha_estreno = fetchedRelease.fecha_estreno;
                if (libraryItem) libraryItem.fecha_estreno = fetchedRelease.fecha_estreno;
                releaseMetaChanged = true;
            }
            if (item.release_date_country !== currentCountry) {
                item.release_date_country = currentCountry;
                if (libraryItem) libraryItem.release_date_country = currentCountry;
                releaseMetaChanged = true;
            }
            if (releaseMetaChanged && libraryItem) {
                saveLocalData();
            }
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

        renderDetailInfo(AppState.selectedItem);

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
    AppState.activeTrailerKey = null;
    const activeTrailerFrame = document.querySelector('#detail-info-panel .tvst-trailer-frame-wrap');
    if (activeTrailerFrame) activeTrailerFrame.remove();
    AppState.selectedItem = null;
    if (AppState.currentTab === 'explore') {
        void renderExplore();
    }
}

/**
 * Elimina el contenido actual y deja la ficha abierta con «Añadir»
 */
async function removeContent() {
    if (!AppState.selectedItem) return;

    const item = AppState.selectedItem;
    const tipo = item.tipo;
    const id_tmdb = item.id_tmdb;

    const confirmed = await showConfirmDialog({
        title: 'Eliminar título',
        message: `¿Estás seguro de eliminar "${item.titulo || 'este título'}"?`,
        confirmText: 'Eliminar',
        danger: true,
    });
    if (!confirmed) return;

    if (tipo === 'movie') {
        removeMovie(id_tmdb);
    } else {
        removeShow(id_tmdb);
    }

    // Mantener ficha abierta (fuera de biblioteca) → barra Añadir
    closeDetailMenu();
    await openDetail(tipo, id_tmdb);
}

// ============================================
// BÚSQUEDA
// ============================================

/**
 * Maneja el evento de búsqueda
 * @param {Event} event - Evento del input
 */
function handleSearch(event) {
    syncExploreSearchClearButton();
    const rawValue = event?.target?.value ?? document.getElementById('search-input')?.value ?? '';
    const query = rawValue.trim();

    if (!query.length) {
        if (typeof cancelSearchDebounce === 'function') {
            cancelSearchDebounce();
        }
        AppState.lastSearchResults = [];
        void renderExplore();
        return;
    }

    if (query.length < 2) {
        if (typeof cancelSearchDebounce === 'function') {
            cancelSearchDebounce();
        }
        AppState.lastSearchResults = [];
        const list = document.getElementById('search-results');
        if (list) {
            list.className = 'tvst-search-list';
            list.innerHTML = emptyState(
                'search',
                'Sigue escribiendo',
                { subtitle: 'Escribe al menos 2 caracteres para buscar series o películas.' },
            );
        }
        return;
    }

    const list = document.getElementById('search-results');
    if (list) {
        list.className = 'tvst-search-list';
        list.innerHTML = renderSkeletonList(4, 'episodes');
    }

    searchWithDebounce(query, (results) => {
        const liveQuery = (document.getElementById('search-input')?.value || '').trim();
        if (liveQuery !== query || liveQuery.length < 2) return;
        renderSearchResults(results);
    });
}

function refreshExploreVisibleState() {
    const query = (document.getElementById('search-input')?.value || '').trim();
    if (!query.length) {
        void renderExplore();
    } else if (query.length >= 2) {
        renderSearchResults(AppState.lastSearchResults);
    }
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
        refreshExploreVisibleState();
        return false;
    }

    if (type === 'movie') {
        await addMovie({ id_tmdb, tipo: 'movie' });
    } else {
        await addShow({ id_tmdb, tipo: 'tv' });
    }

    refreshExploreVisibleState();
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
    const configError = getConfigSetupError();
    if (configError) {
        showToast(configError, 'error');
        return;
    }

    try {
        if (typeof hasGoogleConfig === 'function' && !hasGoogleConfig()) {
            throw new Error('CONFIG_MISSING');
        }
        if (typeof isDriveServiceReady === 'function' && isDriveServiceReady()) {
            await authenticate();
        } else {
            await initDriveService();
            await authenticate();
        }
        updateDriveStatus(true);
        showToast('Conectado a Google Drive', 'success');
        await enterAppAfterDrive();
    } catch (error) {
        console.error('[App] Error conectando Drive:', error);
        updateDriveStatus(false);
        const msg = typeof formatDriveError === 'function'
            ? formatDriveError(error)
            : String(error?.error || error?.message || error || '');
        if (msg.includes('CONFIG_MISSING') || msg.includes('CONFIG_TMDB')) {
            showToast(getConfigSetupError() || 'Falta configuración de Google Drive', 'error');
        } else if (msg.includes('origin_mismatch')) {
            showToast(`Error OAuth: origen no autorizado (${window.location.origin})`, 'error');
        } else if (msg.includes('popup_closed') || msg.includes('access_denied')) {
            showToast('Inicio de sesión cancelado', 'info');
        } else if (msg.includes('popup_failed') || msg.includes('popup_timeout') || msg.toLowerCase().includes('popup')) {
            showToast('El navegador bloqueó el popup de Google. Permite popups para este sitio.', 'error');
        } else {
            showToast(msg ? `Error al conectar Google Drive: ${msg}` : 'Error al conectar Google Drive', 'error');
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
            <span class="tvst-drive-badge is-connected">
                ${UI_ICONS.check}
                <span>Conectado — los cambios se sincronizan automáticamente</span>
            </span>
        `;
        connectBtn.classList.add('hidden');
        disconnectBtn.classList.remove('hidden');
        syncBtn?.classList.remove('hidden');
    } else {
        statusDiv.innerHTML = `
            <span class="tvst-drive-badge is-disconnected">
                ${UI_ICONS.alert}
                <span>No conectado</span>
            </span>
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
        preferences: getPreferences(),
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
    reader.onload = async (e) => {
        try {
            const data = JSON.parse(e.target.result);

            if (data.movies || data.shows || data.lists || data.preferences) {
                closeListPicker();
                closeListModal();
                closeEpisodeModal();
                closePersonModal();
                closeModal();
                AppState.selectedItem = null;
                AppState.selectedListId = null;
                AppState.selectedEpisode = null;
                AppState.selectedPerson = null;
                failedProviderFetchKeys.clear();
                attemptedMovieFilterMetaIds.clear();

                AppState.movies = (data.movies || []).map(normalizeStoredMovie);
                AppState.shows = (data.shows || []).map(normalizeStoredShow);
                AppState.lists = (data.lists || []).map(normalizeStoredList);
                AppState.deletedIds = normalizeDeletedIds(data.deletedIds);
                AppState.deletedListIds = normalizeDeletedListIds(data.deletedListIds);
                if (data.preferences) {
                    AppState.preferences = normalizePreferences(data.preferences);
                    if (typeof window.clearWatchProvidersCache === 'function') {
                        window.clearWatchProvidersCache();
                    }
                }
                invalidateTimelineCaches();
                flushSaveLocalData();
                saveLocalDataImmediate();
                await syncToDriveNow();
                await renderCurrentView();
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
async function clearAllData() {
    const confirmed = await showConfirmDialog({
        title: 'Borrar todos los datos',
        message: '¿Estás seguro de borrar todos los datos? Esta acción no se puede deshacer.',
        confirmText: 'Borrar todo',
        danger: true,
    });
    if (!confirmed) return;

    AppState.movies.forEach(m => recordItemTombstone('movie', m.id_tmdb));
    AppState.shows.forEach(s => recordItemTombstone('tv', s.id_tmdb));
    AppState.lists.forEach(l => recordListTombstone(l.id));

    closeListPicker();
    closeListModal();
    closeEpisodeModal();
    closePersonModal();
    closeModal();

    AppState.movies = [];
    AppState.shows = [];
    AppState.lists = [];
    AppState.selectedItem = null;
    AppState.selectedListId = null;
    AppState.selectedEpisode = null;
    AppState.selectedPerson = null;
    failedProviderFetchKeys.clear();
    attemptedMovieFilterMetaIds.clear();

    invalidateTimelineCaches();
    flushSaveLocalData();
    saveLocalDataImmediate();
    await syncToDriveNow();
    await renderCurrentView();
    showToast('Todos los datos han sido borrados', 'success');
}

// ============================================
// UTILIDADES
// ============================================

const UI_ICONS = {
    check: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    skip: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 6l8 6-8 6V6z"/><path d="M18 6v12"/></svg>',
    plus: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    closeSm: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    star: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.5l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.3l-5.8 3.1 1.1-6.5L2.6 9.3l6.5-.9L12 2.5z"/></svg>',
    starSm: '<svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden="true"><path d="M12 2.5l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.3l-5.8 3.1 1.1-6.5L2.6 9.3l6.5-.9L12 2.5z"/></svg>',
    film: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/></svg>',
    tv: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M8 3l4 3 4-3"/></svg>',
    person: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c1.6-3.4 4.1-5 7-5s5.4 1.6 7 5"/></svg>',
    chevronDown: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
    chevronRight: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
    alert: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v4.5M12 16h.01"/></svg>',
    dice: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="9" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="9" cy="15" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="15" r="1" fill="currentColor" stroke="none"/></svg>',
};

function renderSkeletonList(count = 4, variant = 'episodes') {
    const items = Array.from({ length: count }, (_, idx) => `
        <div class="tvst-skeleton-row" aria-hidden="true">
            <div class="tvst-skeleton-poster"></div>
            <div class="tvst-skeleton-lines">
                <span class="tvst-skeleton-line is-sm" style="width:${idx % 2 === 0 ? '42%' : '34%'}"></span>
                <span class="tvst-skeleton-line is-md" style="width:${idx % 2 === 0 ? '68%' : '56%'}"></span>
                <span class="tvst-skeleton-line is-xs" style="width:52%"></span>
            </div>
            ${variant === 'upcoming'
                ? '<div class="tvst-skeleton-pill"></div>'
                : '<div class="tvst-skeleton-circle"></div>'}
        </div>
    `).join('');
    return `<div class="tvst-skeleton-list" role="status" aria-label="Cargando">${items}</div>`;
}

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
        ? `<p class="tvst-empty-text">${escapeHtml(opts.subtitle)}</p>`
        : '';
    const action = (opts.actionLabel && opts.actionOnClick)
        ? `<button type="button" class="tvst-empty-action" onclick="${escapeHtml(opts.actionOnClick)}">${escapeHtml(opts.actionLabel)}</button>`
        : '';
    return `
        <div class="tvst-empty"${gridStyle}>
            <div class="tvst-empty-icon${loadingClass}">${svg}</div>
            <p class="tvst-empty-title">${escapeHtml(title)}</p>
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
    switchTab,
    switchSubTab,
    switchMoviesSubTab,
    switchProfileTab,
    scrollToNowAnchor,
    switchDetailTab,
    openDetail,
    closeModal,
    removeContent,
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
window.onProfileSearchInput = onProfileSearchInput;
window.clearProfileSearch = clearProfileSearch;
window.resetProfileFilters = resetProfileFilters;
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
window.handleCastImgError = handleCastImgError;
window.closeModal = closeModal;
window.removeContent = removeContent;
window.setPersonalRating = setPersonalRating;
window.setMoviesPendingSort = setMoviesPendingSort;
window.toggleMoviesPendingGenre = toggleMoviesPendingGenre;
window.toggleMoviesPendingPlatform = toggleMoviesPendingPlatform;
window.setMoviesPendingMaxRuntime = setMoviesPendingMaxRuntime;
window.toggleMoviesPendingFilters = toggleMoviesPendingFilters;
window.resetMoviesPendingFilters = resetMoviesPendingFilters;
window.pickRandomPendingMovie = pickRandomPendingMovie;
window.startEditCritica = startEditCritica;
window.saveItemCritica = saveItemCritica;
window.handleEpisodeRowKeydown = handleEpisodeRowKeydown;
window.toggleDetailMenu = toggleDetailMenu;
window.runDetailMenuAction = runDetailMenuAction;
window.closeDetailMenu = closeDetailMenu;
window.handleSearch = handleSearch;
window.clearExploreSearch = clearExploreSearch;
window.renderExplore = renderExplore;
window.addItem = addItem;
window.addFromDetail = addFromDetail;
window.connectDrive = connectDrive;
window.connectDriveFromGate = connectDriveFromGate;
window.disconnectDrive = disconnectDrive;
window.exportData = exportData;
window.importData = importData;
window.handleImport = handleImport;
window.clearAllData = clearAllData;
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
window.resolveAppDialog = resolveAppDialog;
window.updatePreference = updatePreference;
window.toggleSubscriptionPreference = toggleSubscriptionPreference;
window.clearTmdbCachesFromSettings = clearTmdbCachesFromSettings;
window.revealCurrentEpisodeSpoilers = revealCurrentEpisodeSpoilers;
window.getPreferredProviderCountry = getPreferredProviderCountry;
window.switchExploreTrendingTab = switchExploreTrendingTab;
window.playDetailTrailer = playDetailTrailer;
window.stopDetailTrailer = stopDetailTrailer;
window.jumpToDetailTrailer = jumpToDetailTrailer;
window.shiftUpcomingCalendarWeek = shiftUpcomingCalendarWeek;
window.selectUpcomingCalendarDate = selectUpcomingCalendarDate;
window.resetUpcomingCalendar = resetUpcomingCalendar;
window.jumpToUpcomingCalendarDate = jumpToUpcomingCalendarDate;

console.log('[App] app.js cargado');

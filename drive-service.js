/**
 * Drive Service - Google Drive Integration
 *
 * OAuth vía Google Identity Services (GIS) + llamadas Drive con fetch.
 * No usa gapi.client.init (falla a menudo con API keys restringidas).
 */

function getGoogleClientId() {
    const id = typeof CONFIG_GOOGLE_CLIENT_ID !== 'undefined' ? String(CONFIG_GOOGLE_CLIENT_ID).trim() : '';
    if (!id || id.includes('tu_client_id')) return '';
    return id;
}

function hasGoogleConfig() {
    return Boolean(getGoogleClientId());
}

function formatDriveError(error) {
    if (error == null) return 'Error desconocido';
    if (typeof error === 'string') return error;
    if (error instanceof Error && error.message) return error.message;

    const nested = error?.result?.error || error?.error || error;
    if (typeof nested === 'string') return nested;
    if (nested?.message) {
        const code = nested.code ? ` (${nested.code})` : '';
        return `${nested.message}${code}`;
    }
    if (nested?.status) return String(nested.status);
    try {
        return JSON.stringify(nested);
    } catch (_) {
        return 'Error de Google';
    }
}

const SCOPES = 'https://www.googleapis.com/auth/drive.file';
const DATA_FILE_NAME = 'tv_showtime_data.json';
const DRIVE_TOKEN_STORAGE_KEY = 'seenit_drive_token';
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const DRIVE_API = 'https://www.googleapis.com/drive/v3';

let tokenClient = null;
let gisInited = false;
let accessToken = null;
let tokenExpiresAt = 0;
let dataFileId = null;
let renewPromise = null;
let gisLoadPromise = null;

async function initDriveService() {
    console.log('[Drive] Inicializando servicio...');
    if (!hasGoogleConfig()) {
        throw new Error('CONFIG_MISSING');
    }
    if (gisInited && tokenClient) {
        await restoreAccessToken();
        console.log('[Drive] Servicio ya inicializado');
        return;
    }
    await loadGIS();
    await restoreAccessToken();
    console.log('[Drive] Servicio inicializado');
}

function persistDriveToken(token, expiresIn = 3600) {
    const expiresAt = Date.now() + ((expiresIn || 3600) * 1000);
    tokenExpiresAt = expiresAt;
    localStorage.setItem(DRIVE_TOKEN_STORAGE_KEY, JSON.stringify({
        accessToken: token,
        expiresAt,
    }));
}

function clearPersistedDriveToken() {
    localStorage.removeItem(DRIVE_TOKEN_STORAGE_KEY);
    tokenExpiresAt = 0;
}

function getPersistedDriveTokenRaw() {
    try {
        const raw = localStorage.getItem(DRIVE_TOKEN_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed?.accessToken || !parsed?.expiresAt) return null;
        return parsed;
    } catch (error) {
        console.warn('[Drive] Error leyendo token guardado:', error);
        clearPersistedDriveToken();
        return null;
    }
}

function isTokenFresh(marginMs = TOKEN_REFRESH_MARGIN_MS) {
    return Boolean(accessToken && tokenExpiresAt && Date.now() < (tokenExpiresAt - marginMs));
}

async function restoreAccessToken() {
    const persisted = getPersistedDriveTokenRaw();
    if (!persisted) {
        accessToken = null;
        tokenExpiresAt = 0;
        return;
    }

    accessToken = persisted.accessToken;
    tokenExpiresAt = persisted.expiresAt;

    if (!isTokenFresh()) {
        try {
            await ensureValidAccessToken({ interactive: false });
        } catch (error) {
            console.warn('[Drive] Renovación silenciosa al restaurar falló:', error);
            accessToken = null;
            tokenExpiresAt = 0;
            clearPersistedDriveToken();
        }
    } else {
        console.log('[Drive] Token restaurado desde localStorage');
    }
}

function loadGIS() {
    if (gisInited && tokenClient) {
        return Promise.resolve();
    }
    if (gisLoadPromise) {
        return gisLoadPromise;
    }

    gisLoadPromise = new Promise((resolve, reject) => {
        const initClient = () => {
            tokenClient = google.accounts.oauth2.initTokenClient({
                client_id: getGoogleClientId(),
                scope: SCOPES,
            });
            gisInited = true;
            resolve();
        };

        if (window.google?.accounts?.oauth2) {
            try {
                initClient();
            } catch (error) {
                reject(error);
            }
            return;
        }

        const existing = document.querySelector('script[data-seenit-gis]');
        if (existing) {
            existing.addEventListener('load', () => {
                try {
                    initClient();
                } catch (error) {
                    reject(error);
                }
            });
            existing.addEventListener('error', () => reject(new Error('No se pudo cargar Google Identity Services')));
            return;
        }

        const script = document.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client';
        script.async = true;
        script.defer = true;
        script.dataset.seenitGis = '1';
        script.onload = () => {
            try {
                initClient();
            } catch (error) {
                reject(error);
            }
        };
        script.onerror = () => reject(new Error('No se pudo cargar Google Identity Services'));
        document.head.appendChild(script);
    }).finally(() => {
        if (!gisInited) gisLoadPromise = null;
    });

    return gisLoadPromise;
}

function requestAccessToken(prompt) {
    return new Promise((resolve, reject) => {
        if (!gisInited || !tokenClient) {
            reject(new Error('Servicio no inicializado. Llama a initDriveService() primero.'));
            return;
        }

        tokenClient.callback = (response) => {
            if (response.error) {
                console.error('[Drive] Error de autenticación:', response);
                reject(response);
                return;
            }

            accessToken = response.access_token;
            persistDriveToken(accessToken, response.expires_in);
            console.log('[Drive] Token obtenido exitosamente');
            resolve(response);
        };

        try {
            tokenClient.requestAccessToken({ prompt: prompt || '' });
        } catch (error) {
            console.error('[Drive] Error iniciando autenticación:', error);
            reject(error);
        }
    });
}

async function ensureValidAccessToken(options = {}) {
    const interactive = Boolean(options.interactive);

    if (isTokenFresh()) {
        return { access_token: accessToken };
    }

    if (renewPromise) {
        return renewPromise;
    }

    renewPromise = (async () => {
        try {
            try {
                return await requestAccessToken('');
            } catch (silentError) {
                if (!interactive) throw silentError;
                return await requestAccessToken('consent');
            }
        } finally {
            renewPromise = null;
        }
    })();

    return renewPromise;
}

async function authenticate() {
    if (!gisInited || !tokenClient) {
        throw new Error('Servicio no inicializado. Llama a initDriveService() primero.');
    }
    return ensureValidAccessToken({ interactive: true });
}

function signOut() {
    if (accessToken) {
        try {
            google.accounts.oauth2.revoke(accessToken, () => {
                console.log('[Drive] Token revocado');
            });
        } catch (_) { /* ignore */ }
    }
    accessToken = null;
    dataFileId = null;
    clearPersistedDriveToken();
}

function isAuthenticated() {
    return Boolean(accessToken) && Date.now() < tokenExpiresAt;
}

async function driveFetch(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            ...(options.headers || {}),
            Authorization: `Bearer ${accessToken}`,
        },
    });

    if (!response.ok) {
        let detail = '';
        try {
            const body = await response.json();
            detail = formatDriveError(body);
        } catch (_) {
            detail = response.statusText || '';
        }
        const err = new Error(detail || `Drive HTTP ${response.status}`);
        err.status = response.status;
        throw err;
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        return response.json();
    }
    return response.text();
}

async function withDriveAuth(operation) {
    await ensureValidAccessToken({ interactive: false });
    try {
        return await operation();
    } catch (error) {
        const status = error?.status || error?.result?.error?.code || error?.code;
        if (status === 401 || status === 403) {
            await ensureValidAccessToken({ interactive: true });
            return operation();
        }
        throw error;
    }
}

async function findOrCreateDataFile() {
    return withDriveAuth(async () => {
        const q = encodeURIComponent(`name='${DATA_FILE_NAME}' and trashed=false`);
        const data = await driveFetch(
            `${DRIVE_API}/files?q=${q}&spaces=drive&fields=files(id,name)`,
        );

        const files = data.files || [];
        if (files.length > 0) {
            dataFileId = files[0].id;
            console.log('[Drive] Archivo encontrado:', dataFileId);
            return dataFileId;
        }

        return createDataFile();
    });
}

async function createDataFile() {
    const initialData = { movies: [], shows: [], lists: [] };
    const metadata = {
        name: DATA_FILE_NAME,
        mimeType: 'application/json',
    };

    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', new Blob([JSON.stringify(initialData)], { type: 'application/json' }));

    const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: form,
    });

    if (!response.ok) {
        throw new Error('Error creando archivo en Drive');
    }

    const result = await response.json();
    dataFileId = result.id;
    console.log('[Drive] Archivo creado:', dataFileId);
    return dataFileId;
}

async function loadUserData() {
    return withDriveAuth(async () => {
        if (!dataFileId) {
            await findOrCreateDataFile();
        }

        const raw = await driveFetch(`${DRIVE_API}/files/${dataFileId}?alt=media`);
        const data = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
        data.movies = data.movies || [];
        data.shows = data.shows || [];
        data.lists = data.lists || [];
        console.log('[Drive] Datos cargados');
        return data;
    });
}

async function saveUserData(data) {
    return withDriveAuth(async () => {
        if (!data.movies || !data.shows) {
            throw new Error('Estructura de datos inválida. Debe contener movies y shows.');
        }
        if (!Array.isArray(data.lists)) {
            data.lists = [];
        }

        if (!dataFileId) {
            await findOrCreateDataFile();
        }

        const metadata = {
            name: DATA_FILE_NAME,
            mimeType: 'application/json',
        };

        const form = new FormData();
        form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
        form.append('file', new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));

        const response = await fetch(
            `https://www.googleapis.com/upload/drive/v3/files/${dataFileId}?uploadType=multipart`,
            {
                method: 'PATCH',
                headers: { Authorization: `Bearer ${accessToken}` },
                body: form,
            },
        );

        if (!response.ok) {
            throw new Error('Error guardando archivo en Drive');
        }

        console.log('[Drive] Datos guardados exitosamente');
        return true;
    });
}

async function getUserInfo() {
    return withDriveAuth(async () => {
        const data = await driveFetch(`${DRIVE_API}/about?fields=user`);
        return data.user;
    });
}

window.DriveService = {
    initDriveService,
    authenticate,
    ensureValidAccessToken,
    signOut,
    isAuthenticated,
    loadUserData,
    saveUserData,
    getUserInfo,
    findOrCreateDataFile,
};

window.initDriveService = initDriveService;
window.authenticate = authenticate;
window.ensureValidAccessToken = ensureValidAccessToken;
window.signOut = signOut;
window.isAuthenticated = isAuthenticated;
window.hasGoogleConfig = hasGoogleConfig;
window.formatDriveError = formatDriveError;
window.loadUserData = loadUserData;
window.saveUserData = saveUserData;
window.getUserInfo = getUserInfo;
window.findOrCreateDataFile = findOrCreateDataFile;

console.log('[Drive] drive-service.js cargado');

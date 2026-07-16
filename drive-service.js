/**
 * Drive Service - Google Drive Integration
 *
 * Autenticación GIS + gapi. Token en localStorage con renovación silenciosa.
 */

function getGoogleClientId() {
    return typeof CONFIG_GOOGLE_CLIENT_ID !== 'undefined'
        ? CONFIG_GOOGLE_CLIENT_ID
        : '797642945177-qi6vaqh10ldb89p339snodostrbvfue8.apps.googleusercontent.com';
}

function getGoogleApiKey() {
    return typeof CONFIG_GOOGLE_API_KEY !== 'undefined'
        ? CONFIG_GOOGLE_API_KEY
        : 'AIzaSyD2XPrBEzt54z3hvNFT6YbHR9SS5IzmCbQ';
}

const SCOPES = 'https://www.googleapis.com/auth/drive.file';
const DISCOVERY_DOC = 'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest';
const DATA_FILE_NAME = 'tv_showtime_data.json';
const DRIVE_TOKEN_STORAGE_KEY = 'seenit_drive_token';
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

let tokenClient = null;
let gapiInited = false;
let gisInited = false;
let accessToken = null;
let tokenExpiresAt = 0;
let dataFileId = null;
let renewPromise = null;

async function initDriveService() {
    console.log('[Drive] Inicializando servicio...');
    await loadGIS();
    await loadGAPI();
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

function syncTokenToGapi() {
    if (!gapiInited || !accessToken) return;
    try {
        gapi.client.setToken({ access_token: accessToken });
    } catch (error) {
        console.warn('[Drive] No se pudo sincronizar el token con gapi:', error);
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
    syncTokenToGapi();

    if (!isTokenFresh()) {
        try {
            await ensureValidAccessToken({ interactive: false });
        } catch (error) {
            console.warn('[Drive] Renovación silenciosa al restaurar falló:', error);
        }
    } else {
        console.log('[Drive] Token restaurado desde localStorage');
    }
}

function loadGIS() {
    return new Promise((resolve, reject) => {
        if (window.google?.accounts?.oauth2) {
            tokenClient = google.accounts.oauth2.initTokenClient({
                client_id: getGoogleClientId(),
                scope: SCOPES,
            });
            gisInited = true;
            resolve();
            return;
        }

        const script = document.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client';
        script.async = true;
        script.defer = true;
        script.onload = () => {
            tokenClient = google.accounts.oauth2.initTokenClient({
                client_id: getGoogleClientId(),
                scope: SCOPES,
            });
            gisInited = true;
            resolve();
        };
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

function loadGAPI() {
    return new Promise((resolve, reject) => {
        const finish = async () => {
            try {
                await gapi.client.init({
                    apiKey: getGoogleApiKey(),
                    discoveryDocs: [DISCOVERY_DOC],
                });
                gapiInited = true;
                resolve();
            } catch (error) {
                console.error('[Drive] Error inicializando gapi.client:', error);
                reject(error);
            }
        };

        if (window.gapi?.load) {
            gapi.load('client', finish);
            return;
        }

        const script = document.createElement('script');
        script.src = 'https://apis.google.com/js/api.js';
        script.async = true;
        script.defer = true;
        script.onload = () => gapi.load('client', finish);
        script.onerror = reject;
        document.head.appendChild(script);
    });
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
            syncTokenToGapi();
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

/**
 * Garantiza un access token válido. Silencioso si ya hubo consentimiento.
 */
async function ensureValidAccessToken(options = {}) {
    const interactive = Boolean(options.interactive);

    if (isTokenFresh()) {
        syncTokenToGapi();
        return { access_token: accessToken };
    }

    if (renewPromise) {
        return renewPromise;
    }

    renewPromise = (async () => {
        try {
            // Primero intentar renovación silenciosa
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
    if (!gisInited || !gapiInited) {
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
        const response = await gapi.client.drive.files.list({
            q: `name='${DATA_FILE_NAME}' and trashed=false`,
            spaces: 'drive',
            fields: 'files(id, name)',
        });

        const files = response.result.files;

        if (files && files.length > 0) {
            dataFileId = files[0].id;
            console.log('[Drive] Archivo encontrado:', dataFileId);
            return dataFileId;
        }

        return createDataFile();
    });
}

async function createDataFile() {
    const initialData = { movies: [], shows: [] };
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

        const response = await gapi.client.drive.files.get({
            fileId: dataFileId,
            alt: 'media',
        });

        const data = response.result || {};
        data.movies = data.movies || [];
        data.shows = data.shows || [];
        console.log('[Drive] Datos cargados');
        return data;
    });
}

async function saveUserData(data) {
    return withDriveAuth(async () => {
        if (!data.movies || !data.shows) {
            throw new Error('Estructura de datos inválida. Debe contener movies y shows.');
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
        const response = await gapi.client.drive.about.get({ fields: 'user' });
        return response.result.user;
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
window.loadUserData = loadUserData;
window.saveUserData = saveUserData;
window.getUserInfo = getUserInfo;
window.findOrCreateDataFile = findOrCreateDataFile;

console.log('[Drive] drive-service.js cargado');

/**
 * Drive Service - Google Drive Integration
 * 
 * Este servicio maneja la autenticación y sincronización con Google Drive
 * para almacenar los datos de series y películas del usuario.
 * 
 * Requiere:
 * - Google API Client Library (gapi)
 * - Google Identity Services (gis)
 * 
 * Configuración necesaria:
 * - Crear un proyecto en Google Cloud Console
 * - Habilitar Google Drive API
 * - Configurar OAuth 2.0 con origen autorizado
 * - Reemplazar CLIENT_ID con tu propio Client ID
 */

// ============================================
// CONFIGURACIÓN
// ============================================

const CLIENT_ID = typeof CONFIG_GOOGLE_CLIENT_ID !== 'undefined'
    ? CONFIG_GOOGLE_CLIENT_ID
    : '797642945177-qi6vaqh10ldb89p339snodostrbvfue8.apps.googleusercontent.com'; // Reemplazar con tu Client ID real
const API_KEY = typeof CONFIG_GOOGLE_API_KEY !== 'undefined'
    ? CONFIG_GOOGLE_API_KEY
    : 'AIzaSyD2XPrBEzt54z3hvNFT6YbHR9SS5IzmCbQ'; // Reemplazar con tu API Key real
const SCOPES = 'https://www.googleapis.com/auth/drive.file';
const DISCOVERY_DOC = 'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest';

if (CLIENT_ID === '797642945177-qi6vaqh10ldb89p339snodostrbvfue8.apps.googleusercontent.com' ||
    API_KEY === 'AIzaSyD2XPrBEzt54z3hvNFT6YbHR9SSIzmCbQ') {
    console.warn('[Drive] ⚠️ Usando credenciales por defecto. Copia config.example.js → config.js con tus credenciales.');
}

const DATA_FILE_NAME = 'tv_showtime_data.json';
const DRIVE_TOKEN_STORAGE_KEY = 'seenit_drive_token';

// ============================================
// ESTADO GLOBAL
// ============================================

let tokenClient = null;
let gapiInited = false;
let gisInited = false;
let accessToken = null;
let dataFileId = null;

// ============================================
// INICIALIZACIÓN
// ============================================

/**
 * Inicializa el servicio de Google Drive
 * Debe llamarse al cargar la aplicación
 */
async function initDriveService() {
    console.log('[Drive] Inicializando servicio...');

    // Cargar Google Identity Services
    await loadGIS();

    // Cargar Google API Client
    await loadGAPI();

    await restoreAccessToken();

    console.log('[Drive] Servicio inicializado');
}

function persistDriveToken(token, expiresIn = 3600) {
    const expiresAt = Date.now() + ((expiresIn || 3600) * 1000);
    localStorage.setItem(DRIVE_TOKEN_STORAGE_KEY, JSON.stringify({
        accessToken: token,
        expiresAt,
    }));
}

function clearPersistedDriveToken() {
    localStorage.removeItem(DRIVE_TOKEN_STORAGE_KEY);
}

function getPersistedDriveToken() {
    try {
        const raw = localStorage.getItem(DRIVE_TOKEN_STORAGE_KEY);
        if (!raw) return null;

        const parsed = JSON.parse(raw);
        if (!parsed?.accessToken || !parsed?.expiresAt) return null;

        if (Date.now() >= parsed.expiresAt) {
            clearPersistedDriveToken();
            return null;
        }

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

async function restoreAccessToken() {
    const persisted = getPersistedDriveToken();

    if (!persisted) {
        accessToken = null;
        return;
    }

    accessToken = persisted.accessToken;
    syncTokenToGapi();
    console.log('[Drive] Token restaurado desde localStorage');
}

/**
 * Carga Google Identity Services (GIS)
 */
function loadGIS() {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client';
        script.async = true;
        script.defer = true;
        script.onload = () => {
            tokenClient = google.accounts.oauth2.initTokenClient({
                client_id: CLIENT_ID,
                scope: SCOPES,
            });
            gisInited = true;
            resolve();
        };
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

/**
 * Carga Google API Client (gapi)
 */
function loadGAPI() {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://apis.google.com/js/api.js';
        script.async = true;
        script.defer = true;
        script.onload = () => {
            gapi.load('client', async () => {
                try {
                    await gapi.client.init({
                        apiKey: API_KEY,
                        discoveryDocs: [DISCOVERY_DOC],
                    });
                    gapiInited = true;
                    resolve();
                } catch (error) {
                    console.error('[Drive] Error inicializando gapi.client:', error);
                    reject(error);
                }
            });
        };
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

// ============================================
// AUTENTICACIÓN
// ============================================

/**
 * Inicia el flujo de autenticación con Google
 */
function authenticate() {
    return new Promise((resolve, reject) => {
        if (!gisInited || !gapiInited) {
            reject(new Error('Servicio no inicializado. Llama a initDriveService() primero.'));
            return;
        }

        if (accessToken) {
            resolve({ access_token: accessToken });
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
            tokenClient.requestAccessToken({
                prompt: getPersistedDriveToken() ? '' : 'consent',
            });
        } catch (error) {
            console.error('[Drive] Error iniciando autenticación:', error);
            reject(error);
        }
    });
}

/**
 * Cierra la sesión y revoca el token
 */
function signOut() {
    if (accessToken) {
        google.accounts.oauth2.revoke(accessToken, () => {
            console.log('[Drive] Token revocado');
        });
        accessToken = null;
        dataFileId = null;
        clearPersistedDriveToken();
    }
}

/**
 * Verifica si el usuario está autenticado
 */
function isAuthenticated() {
    return accessToken !== null;
}

// ============================================
// GESTIÓN DE ARCHIVOS
// ============================================

/**
 * Busca el archivo tv_showtime_data.json en Google Drive
 * Si no existe, lo crea con estructura inicial
 */
async function findOrCreateDataFile() {
    try {
        // Buscar archivos con el nombre específico
        const response = await gapi.client.drive.files.list({
            q: `name='${DATA_FILE_NAME}' and trashed=false`,
            spaces: 'drive',
            fields: 'files(id, name)',
        });
        
        const files = response.result.files;
        
        if (files && files.length > 0) {
            // Archivo encontrado
            dataFileId = files[0].id;
            console.log('[Drive] Archivo encontrado:', dataFileId);
            return dataFileId;
        } else {
            // Crear archivo nuevo
            return await createDataFile();
        }
    } catch (error) {
        console.error('[Drive] Error buscando archivo:', error);
        throw error;
    }
}

/**
 * Crea el archivo tv_showtime_data.json con estructura inicial
 */
async function createDataFile() {
    try {
        const initialData = {
            movies: [],
            shows: []
        };
        
        const metadata = {
            name: DATA_FILE_NAME,
            mimeType: 'application/json',
        };
        
        const form = new FormData();
        form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
        form.append('file', new Blob([JSON.stringify(initialData)], { type: 'application/json' }));
        
        const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
            },
            body: form,
        });
        
        if (!response.ok) {
            throw new Error('Error creando archivo en Drive');
        }
        
        const result = await response.json();
        dataFileId = result.id;
        console.log('[Drive] Archivo creado:', dataFileId);
        return dataFileId;
    } catch (error) {
        console.error('[Drive] Error creando archivo:', error);
        throw error;
    }
}

// ============================================
// OPERACIONES DE DATOS
// ============================================

/**
 * Lee los datos del archivo tv_showtime_data.json
 * @returns {Object} Objeto con { movies: [], shows: [] }
 */
async function loadUserData() {
    try {
        if (!isAuthenticated()) {
            throw new Error('No autenticado. Llama a authenticate() primero.');
        }
        
        // Asegurar que el archivo existe
        if (!dataFileId) {
            await findOrCreateDataFile();
        }
        
        // Descargar el archivo
        const response = await gapi.client.drive.files.get({
            fileId: dataFileId,
            alt: 'media',
        });
        
        const data = response.result;
        
        // Validar estructura
        if (!data.movies || !data.shows) {
            console.warn('[Drive] Estructura inválida, corrigiendo...');
            data.movies = data.movies || [];
            data.shows = data.shows || [];
        }
        
        console.log('[Drive] Datos cargados:', data);
        return data;
    } catch (error) {
        console.error('[Drive] Error cargando datos:', error);
        throw error;
    }
}

/**
 * Guarda los datos en el archivo tv_showtime_data.json
 * @param {Object} data - Objeto con { movies: [], shows: [] }
 */
async function saveUserData(data) {
    try {
        if (!isAuthenticated()) {
            throw new Error('No autenticado. Llama a authenticate() primero.');
        }
        
        // Validar estructura
        if (!data.movies || !data.shows) {
            throw new Error('Estructura de datos inválida. Debe contener movies y shows.');
        }

        if (!dataFileId) {
            await findOrCreateDataFile();
        }
        
        // Actualizar el archivo
        const metadata = {
            name: DATA_FILE_NAME,
            mimeType: 'application/json',
        };
        
        const form = new FormData();
        form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
        form.append('file', new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
        
        const response = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${dataFileId}?uploadType=multipart`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
            },
            body: form,
        });
        
        if (!response.ok) {
            throw new Error('Error guardando archivo en Drive');
        }
        
        console.log('[Drive] Datos guardados exitosamente');
        return true;
    } catch (error) {
        console.error('[Drive] Error guardando datos:', error);
        throw error;
    }
}

// ============================================
// UTILIDADES
// ============================================

/**
 * Obtiene información del usuario autenticado
 */
async function getUserInfo() {
    try {
        if (!isAuthenticated()) {
            throw new Error('No autenticado');
        }
        
        const response = await gapi.client.drive.about.get({
            fields: 'user',
        });
        
        return response.result.user;
    } catch (error) {
        console.error('[Drive] Error obteniendo info de usuario:', error);
        throw error;
    }
}

// ============================================
// EXPORTACIONES
// ============================================

// Hacer funciones disponibles globalmente
window.DriveService = {
    initDriveService,
    authenticate,
    signOut,
    isAuthenticated,
    loadUserData,
    saveUserData,
    getUserInfo,
    findOrCreateDataFile,
};

// También exportar individualmente para facilitar el uso
window.initDriveService = initDriveService;
window.authenticate = authenticate;
window.signOut = signOut;
window.isAuthenticated = isAuthenticated;
window.loadUserData = loadUserData;
window.saveUserData = saveUserData;
window.getUserInfo = getUserInfo;
window.findOrCreateDataFile = findOrCreateDataFile;

console.log('[Drive] drive-service.js cargado');

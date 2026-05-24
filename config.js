/**
 * CONFIG.JS - Configuración de SeenIt
 * 
 * IMPORTANTE: Esta es tu configuración local. NUNCA la subas a Git.
 * Está en .gitignore para protegerla.
 */

// ============================================
// TMDB API Configuration
// ============================================
// Obtén tu API Key en: https://www.themoviedb.org/settings/api
const CONFIG_TMDB_API_KEY = 'd9780bb81bd17f41406769af97f0b5d1'; // REEMPLAZA CON TU CLAVE

// ============================================
// Google Drive OAuth Configuration
// ============================================
// Crea un proyecto en Google Cloud Console:
// 1. Ve a https://console.cloud.google.com/
// 2. Crea un nuevo proyecto
// 3. Habilita Google Drive API
// 4. Crea una credencial OAuth 2.0 (aplicación web)
// 5. Autoriza http://localhost:5500 en "Orígenes autorizados"
// 6. Copia el Client ID y API Key

const CONFIG_GOOGLE_CLIENT_ID = '797642945177-qi6vaqh10ldb89p339snodostrbvfue8.apps.googleusercontent.com'; // REEMPLAZA CON TU CLIENT ID
const CONFIG_GOOGLE_API_KEY = 'AIzaSyD2XPrBEzt54z3hvNFT6YbHR9SS5IzmCbQ'; // REEMPLAZA CON TU API KEY

// ============================================
// Aplicar configuración a los servicios
// ============================================

window.AppConfig = {
    TMDB_API_KEY: CONFIG_TMDB_API_KEY,
    GOOGLE_CLIENT_ID: CONFIG_GOOGLE_CLIENT_ID,
    GOOGLE_API_KEY: CONFIG_GOOGLE_API_KEY,
};

console.log('[Config] Configuración cargada');
if (CONFIG_TMDB_API_KEY === 'd9780bb81bd17f41406769af97f0b5d1') {
    console.warn('[Config] ⚠️ TMDB usando valor por defecto - configura tu propia API Key');
}
if (CONFIG_GOOGLE_CLIENT_ID === '797642945177-qi6vaqh10ldb89p339snodostrbvfue8.apps.googleusercontent.com') {
    console.warn('[Config] ⚠️ Google Drive usando valor por defecto - configura tus propias credenciales');
}

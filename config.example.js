/**
 * Copia este archivo como config.js y rellena tus claves (solo desarrollo local).
 * config.js está en .gitignore — no lo subas al repositorio.
 *
 * En GitHub Pages las claves se inyectan en el deploy desde Secrets:
 *   TMDB_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_API_KEY
 *
 * TMDB: https://www.themoviedb.org/settings/api
 * Google: https://console.cloud.google.com/ → APIs & Services → Credentials
 *   - OAuth 2.0 Client ID (Web application)
 *   - Orígenes JavaScript autorizados: http://localhost:5500 y tu URL de Pages
 *   - API key de Google: restricción HTTP referrer a tu dominio Pages
 */
const CONFIG_TMDB_API_KEY = 'tu_api_key_tmdb';
const CONFIG_GOOGLE_CLIENT_ID = 'tu_client_id.apps.googleusercontent.com';
const CONFIG_GOOGLE_API_KEY = 'tu_google_api_key';

# SeenIt

PWA para seguimiento de **series y películas**. Datos de catálogo vía [TMDB](https://www.themoviedb.org/); biblioteca personal en **Google Drive** del usuario. Sin backend propio: se puede publicar en **GitHub Pages**.

Cada persona inicia sesión con **su** cuenta de Google y guarda datos en **su** Drive. El enlace de la app no comparte bibliotecas entre cuentas.

---

## Características

### Series
- **Lista pendiente** — episodios por ver de series en estado *Viendo*
- **Próximamente** — estrenos futuros de todas las series salvo *Abandonada*
- Marcado de episodios, progreso por temporada, estados: pendiente, viendo, completada, standby, abandonada
- Series nuevas se añaden como *Viendo*

### Películas
- Lista pendiente y próximos estrenos
- Estado pendiente / vista

### Perfil
- Biblioteca de series y películas con filtros por estado
- Búsqueda por título y filtro por plataforma (dónde ver / TMDB watch providers)
- **Favoritos** (estrella en el detalle y en las cards)
- **Listas personalizadas** con banner, portada, orden (nombre / progreso / añadido)
- Estadísticas de tiempo visto
- Importación desde exportes de TV Time
- Backup local (exportar / importar JSON) y sincronización con Drive

### Técnica
- PWA instalable (Service Worker, iconos, manifest)
- Auth Google Identity Services (OAuth) + Drive API (`drive.file`)
- Merge seguro local ↔ Drive (backup previo, unión por `id_tmdb`, sync bidireccional)

---

## Stack

| Pieza | Uso |
|---|---|
| HTML / CSS / JS vanilla | UI y estado |
| TMDB API | Búsqueda, detalles, episodios, providers |
| Google Drive | Persistencia por usuario (`seenit-data.json`) |
| Service Worker | Caché del shell; `config.js` en network-first |
| GitHub Actions | Genera `config.js` y publica la carpeta `site/` |

---

## Qué debes hacer tú (checklist)

### A) Google Cloud (una vez)

1. Entra en [Google Cloud Console](https://console.cloud.google.com/).
2. Crea o elige un proyecto.
3. Activa **Google Drive API**.
4. **Credenciales** → crear **OAuth 2.0 Client ID** (tipo *Aplicación web*).
5. En el Client ID, **Orígenes JavaScript autorizados**, añade exactamente:
   - `http://localhost:5500` (desarrollo)
   - `https://TU_USUARIO.github.io` (origen de Pages; el path del repo no va en “origen”)
6. **Pantalla de consentimiento OAuth**:
   - Tipo **Externo**
   - Scope de Drive si te lo pide
   - **Publicar la app** (si queda en “Prueba”, solo los test users pueden entrar)
7. (Opcional) Una **API key** de Google; el cliente Drive actual no la requiere. Si la creas, restríngela por referrer a tu dominio Pages.

Copia:

- Client ID (`….apps.googleusercontent.com`)
- API key de [TMDB](https://www.themoviedb.org/settings/api)
- API key de Google (opcional; el workflow aún puede pedir el secret)

### B) GitHub Secrets + Pages

1. Sube el código al repo (**sin** `config.js`).
2. Repo → **Settings → Secrets and variables → Actions** → New repository secret:
   - `TMDB_API_KEY`
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_API_KEY` (puede ser un placeholder si no usas key de Google)
3. Repo → **Settings → Pages** → Source: **GitHub Actions**.
4. Push a `main` (o Actions → *Deploy GitHub Pages* → Run workflow).
5. Cuando el workflow termine, abre la URL de Pages y pulsa **Conectar con Google**.

El workflow genera `config.js` en CI y publica solo runtime en `site/` (HTML/JS/CSS/icons/manifest/config), sin capturas ni JSON de TV Time.

### C) Local (opcional)

```bash
cp config.example.js config.js
# edita config.js con tus claves
python server.py
# http://localhost:5500
```

---

## Limitación importante (sin servidor)

Las claves del deploy **acaban en el navegador** (cualquiera puede verlas en el JS).  
GitHub Secrets solo las ocultan del historial de git.

Mitigación:

- Client ID protegido por orígenes autorizados
- TMDB: key de uso público típico; si hay abuso, rotar
- No uses un **Client Secret** de OAuth en el frontend

---

## Login y sync

1. Gate inicial: conectar Google (popup OAuth).
2. Se carga / fusiona la biblioteca de Drive con lo local (backup en `localStorage` antes del merge).
3. **Sincronizar** (Perfil → Ajustes) hace el mismo flujo: snapshot → pull → merge → push.
4. Visitas siguientes pueden renovar el token en silencio si sigue válido.

---

## Estructura del repo

| Archivo / carpeta | Rol |
|---|---|
| `index.html` | Shell UI |
| `styles.css` | Estilos |
| `app.js` | Lógica, vistas, sync |
| `drive-service.js` | OAuth GIS + Drive |
| `tmdb-service.js` | Cliente TMDB |
| `tvtime-import.js` | Importación TV Time |
| `sw.js` | Service Worker |
| `manifest.json` / `icons/` | PWA |
| `config.example.js` | Plantilla de claves |
| `config.js` | Claves locales / CI (**no commitear**) |
| `server.py` | Servidor estático local |
| `.github/workflows/deploy-pages.yml` | Deploy Pages + inyección de secrets |

---

## Problemas frecuentes

| Síntoma | Qué revisar |
|---|---|
| “Falta configuración” | Secrets mal puestos o workflow sin generar `config.js` |
| `origin_mismatch` | Añade `window.location.origin` exacto en Orígenes JavaScript autorizados |
| Amigo no puede entrar | Consent screen en **Prueba** → **Publicar**; o origen Pages mal configurado |
| Popup no aparece | Permitir ventanas emergentes para el sitio |
| TMDB 401 | Secret `TMDB_API_KEY` incorrecto |
| App “vieja” tras un deploy | Recarga forzada; el SW avisa cuando hay nueva versión |

---

## Privacidad

Los datos de cada usuario viven en su Google Drive (scope `drive.file`). No hay servidor tuyo que almacene bibliotecas ajenas. Un backup local adicional se guarda en el navegador (`seenit_data` / `seenit_data_backup`) antes de reconciliar con Drive.

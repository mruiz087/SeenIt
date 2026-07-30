# SeenIt

PWA para seguimiento de **series y películas**. Catálogo vía [TMDB](https://www.themoviedb.org/); biblioteca personal en el **Google Drive** de cada usuario. Sin backend propio: se puede publicar en **GitHub Pages**.

Cada persona inicia sesión con **su** cuenta de Google y guarda datos en **su** Drive. El enlace de la app no comparte bibliotecas entre cuentas.

**Manual técnico completo:** [`docs/README.md`](docs/README.md) — arquitectura, modelo de datos, sync, UI, PWA y guía de mantenimiento (pensado para mantener la app sin IA y como material de formación).

---

## Características

### Series
- **Lista pendiente** — episodios por ver de series en estado *Viendo*
  - Sección **Ver a continuación** (actividad reciente o boost por temporada nueva)
  - Sección **Sin ver por un tiempo** (sin avance en ~14 días)
  - Historial de episodios vistos al deslizar hacia arriba desde el ancla
- **Próximamente** — estrenos futuros (todas salvo *Abandonada*)
- Marcado de episodios, progreso por temporada
- Estados: pendiente, viendo, completada, standby («ver en otro momento»), abandonada
- Series **nuevas se añaden como *Pendiente***; al marcar un episodio pasan a *Viendo*
- Si una serie *Completada* gana temporada nueva en TMDB: toast, vuelve a *Viendo* y entra en **Ver a continuación** (`continueBoostAt`)

### Películas
- Lista pendiente y próximos estrenos
- Estado pendiente / vista
- **Filtros** (panel colapsable bajo el subnav): género, plataforma y duración máxima (slider en vivo)
- Plataformas principales unificadas (Netflix, Prime Video, Disney+, Max, Movistar Plus+, Apple TV, SkyShowtime, RTVE, Atresplayer, Filmin, Rakuten) + **Otros**

### Ficha (detalle)
- Hero con progreso, meta TMDB y **badge de estado** de visionado
- Nota personal (1–10) + TMDB; botón **Quitar nota**
- **Crítica** personal (Añadir → Guardar → Modificar), solo si está en la biblioteca
- Episodios (series), providers, reparto, recomendaciones
- Acciones: listas, estados, favorito, eliminar

### Perfil
- Biblioteca con búsqueda, filtro por estado y plataforma (mismas unificaciones)
- **Favoritos**, **listas personalizadas**, estadísticas de tiempo visto
- Importación TV Time, export/import JSON, sincronizar con Drive
- Sticky de pestañas / toolbar / cabecera de favoritos alineados al chrome

### Técnica
- PWA instalable (Service Worker **v52**, manifest, iconos)
- Banner «Nueva versión disponible» por encima del menú inferior
- Auth Google Identity Services + Drive API (`drive.file`)
- Merge seguro local ↔ Drive (backup previo, LWW por `updatedAt`, tombstones)

---

## Stack

| Pieza | Uso |
|---|---|
| HTML / CSS / JS vanilla | UI y estado (`AppState`) |
| TMDB API | Búsqueda, detalles, episodios, watch providers |
| Google Drive | Persistencia por usuario (`tv_showtime_data.json`) |
| Service Worker | Shell cache-first; `config.js` network-first |
| GitHub Actions | Genera `config.js` y publica `site/` |

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
7. (Opcional) Una **API key** de Google; el cliente Drive actual no la requiere.

Copia:

- Client ID (`….apps.googleusercontent.com`)
- API key de [TMDB](https://www.themoviedb.org/settings/api)

### B) GitHub Secrets + Pages

1. Sube el código al repo (**sin** `config.js`).
2. Repo → **Settings → Secrets and variables → Actions**:
   - `TMDB_API_KEY`
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_API_KEY` (puede ser placeholder)
3. Repo → **Settings → Pages** → Source: **GitHub Actions**.
4. Push a `main` (o Actions → *Deploy GitHub Pages* → Run workflow).
5. Abre la URL de Pages y pulsa **Conectar con Google**.

El workflow genera `config.js` en CI y publica el runtime en `site/`.

### C) Local (opcional)

```bash
cp config.example.js config.js
# edita config.js con tus claves
python server.py
# http://localhost:5500
```

---

## Limitación importante (sin servidor)

Las claves del deploy **acaban en el navegador**. GitHub Secrets solo las ocultan del historial de git.

- Client ID protegido por orígenes autorizados
- TMDB: key de uso público típico; si hay abuso, rotar
- No uses un **Client Secret** de OAuth en el frontend

---

## Login y sync

1. Gate inicial: conectar Google (popup OAuth).
2. Carga / fusión de Drive con lo local (backup en `localStorage` antes del merge).
3. **Sincronizar** (Perfil → Ajustes): snapshot → pull → merge → push.
4. Visitas siguientes pueden renovar el token en silencio si sigue válido.
5. Tras un deploy, el banner **Nueva versión disponible** permite recargar el shell (SW).

Detalle: [`docs/03-persistencia-y-sync.md`](docs/03-persistencia-y-sync.md), [`docs/05-drive-oauth.md`](docs/05-drive-oauth.md).

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
| `docs/` | **Manual técnico** |
| `.github/workflows/deploy-pages.yml` | Deploy Pages + inyección de secrets |

---

## Novedades recientes (resumen)

- Timeline pendiente con ancla, historial y `continueBoostAt` por temporada nueva
- Filtros de películas (género / plataforma / duración) + providers unificados
- Crítica personal en ficha; badge de estado en el hero
- Sticky chrome sin huecos; banner SW sobre el bottom nav
- Documentación en `docs/`

Más contexto: [`docs/15-decisiones-y-historial.md`](docs/15-decisiones-y-historial.md).

---

## Problemas frecuentes

| Síntoma | Qué revisar |
|---|---|
| “Falta configuración” | Secrets o workflow sin `config.js` |
| `origin_mismatch` | `window.location.origin` en Orígenes JavaScript autorizados |
| Amigo no puede entrar | Consent screen **Publicar**; origen Pages |
| Popup bloqueado | Permitir popups |
| TMDB 401 | `TMDB_API_KEY` |
| App “vieja” | Banner de recarga / hard refresh; bump SW en `sw.js` |
| Hueco bajo pestañas sticky | Alturas medidas en `syncMobileChromeHeights` |

---

## Privacidad

Los datos viven en el Google Drive del usuario (scope `drive.file`). No hay servidor propio que almacene bibliotecas ajenas. Backup local en el navegador (`seenit_data__*`, `seenit_data_backup`) antes de reconciliar con Drive.

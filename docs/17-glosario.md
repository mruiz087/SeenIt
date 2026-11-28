# 17 — Glosario

← [16 Mantenimiento](16-guia-mantenimiento.md) · [Índice](README.md)

---

## Términos de SeenIt

| Término | Significado |
|---------|-------------|
| **AppState** | Objeto global en memoria con biblioteca, preferencias, selector, gamificación, filtros y cachés de UI |
| **Ancla / NOW** | Marcador `data-timeline-anchor` donde empieza *Ver a continuación*; el scroll de entrada lo alinea bajo el subnav |
| **Badge de estado** | Chip en el hero de ficha con el `estado` de visionado del usuario |
| **Bottom nav** | Barra fija inferior de 5 pestañas: Series / Películas / Explorar / Perfil / Ajustes |
| **Cache First** | Estrategia SW para `STATIC_FILES`: sirve caché y revalida en background |
| **capitulos_saltados** | Array de códigos `SxxExx` omitidos por el usuario para que no bloqueen el timeline ni completar la serie |
| **Chrome** | UI fija/sticky (subnav, filtros, tabs de perfil, bottom nav, banner SW) medida dinámicamente en JS |
| **Continue / Ver a continuación** | Sección del timeline para series `watching` con actividad dentro de `inactivityDays` o `continueBoostAt` reciente |
| **continueBoostAt** | Timestamp ISO que fuerza una serie a *Ver a continuación* (p. ej. al detectar temporada nueva) |
| **Crítica** | Texto libre privado del usuario (`critica`) en movie/show |
| **Drive gate** | Pantalla inicial opcional (`#drive-gate`) para conectar Google Drive o continuar en modo local (`continueWithoutDrive`) |
| **Entradas vintage** | Coleccionables desbloqueables al completar sagas/colecciones de películas de TMDB (`#collectible-modal`) |
| **Featured providers** | Lista canónica corta de plataformas para chips de filtro y suscripciones |
| **flatrate** | En TMDB watch providers: incluido en suscripción (vs rent/buy) |
| **Flush** | Subida inmediata a Drive cancelando el debounce (p. ej. al ocultar o cerrar pestaña) |
| **GIS** | Google Identity Services — OAuth token en el navegador |
| **inactivityDays** | Ventana configurable (7, 14, 30 o 60 días) que separa *Ver a continuación* de *Sin ver por un tiempo* |
| **LWW** | *Last-Write-Wins*: en el merge, gana el ítem completo con `updatedAt` más reciente |
| **Modo invitado / local** | Uso sin cuenta de Google Drive (`seenit_guest_mode`), persistido en `localStorage` + `IndexedDB` |
| **Notificaciones PWA** | Avisos locales y en segundo plano de estrenos gestionados entre `app.js`, `seenit_notifications_db` y `sw.js` |
| **Otros (`PROVIDER_OTHER`)** | Chip de filtro para plataformas fuera de `FEATURED_PROVIDERS` |
| **Payload Drive** | JSON `tv_showtime_data.json` con movies, shows, lists, selectorItems, preferences, gamification y tombstones |
| **periodicsync** | API del navegador usada por `sw.js` (`seenit-release-check`) para comprobar estrenos en segundo plano en PWA instalada |
| **Proxy TMDB** | Endpoints `/api/tmdb/*` y `/api/tmdb-image` en `server.js` que ocultan la API key y añaden caché/CORS |
| **PWA** | Progressive Web App — instalable, offline parcial del shell y notificaciones locales/segundo plano |
| **Reconcile** | Integrar remoto Drive + estado local (`reconcileWithDriveData`) |
| **Selector (“¿Qué vemos?”)** | Herramienta en Perfil → Selector para elegir al azar entre candidatas y mostrar el ganador en `#selector-winner-modal` |
| **SeriesGuide** | App externa cuyo formato oficial de 2 JSON (series y películas) es importable y exportable desde SeenIt |
| **Shell** | HTML/CSS/JS estáticos cacheados por `sw.js` (sin datos de usuario ni `/api/*`) |
| **Stale / Sin ver por un tiempo** | Series `watching` sin actividad reciente más allá de `inactivityDays` |
| **SW bump** | Incrementar `v0.112` → `v0.113` en nombres de caché de `sw.js` |
| **Tombstone** | Registro `{ id, deletedAt }` o `{ key, deletedAt }` para que un borrado gane al fusionar |
| **Wrapped Studio** | Generador Canvas 2D de tarjetas resumen en PNG (`#wrapped-modal`) |

---

## IDs y formatos

| Formato | Ejemplo | Uso |
|---------|---------|-----|
| `id_tmdb` | `1396` | PK TMDB |
| Episodio | `S01E05` | Clave en `capitulos_vistos` y `capitulos_saltados` |
| Lista | `lst_…` | `lists[].id` |
| Selector key | `movie:550` / `tv:1396` | Clave única en `selectorItems` y `deletedSelectorKeys` |
| Storage user | `seenit_data__123…` / `seenit_data__local` | Clave de biblioteca en `localStorage` e IndexedDB |

---

## Archivos clave (atajo)

| Archivo | Una frase |
|---------|-----------|
| `server.js` | Servidor Express (puerto 3000), `/config.js` dinámico, proxy `/api/tmdb/*` y `/api/tmdb-image` |
| `app.js` | Cerebro UI, timelines, calendarios, selector, gamificación, Wrapped, notificaciones y sync |
| `migration-service.js` | Importador y exportador universal (SeenIt, SeriesGuide, Trakt, Letterboxd, IMDb, TV Time, CSV) |
| `tmdb-service.js` | Cliente TMDB con caché en memoria + IndexedDB (`seenit_tmdb_cache_db`) |
| `drive-service.js` | OAuth GIS y lectura/escritura de `tv_showtime_data.json` en Google Drive |
| `sw.js` | Service Worker (`v0.112`): caché del shell, bypass de `/api/*`, `periodicsync` y notificaciones |
| `styles.css` | Sistema visual `tvst-*`, temas, estilos de póster y acordeones |
| `index.html` | Shell HTML, 5 vistas principales, 11 modales y registro del SW |

---

Fin del manual. Volver al [índice](README.md) o al [README del repo](../README.md).

# 17 — Glosario

← [16 Mantenimiento](16-guia-mantenimiento.md) · [Índice](README.md)

---

## Términos de SeenIt

| Término | Significado |
|---------|-------------|
| **AppState** | Objeto global en memoria con biblioteca, tabs, caches de UI |
| **Ancla / NOW** | Marcador `data-timeline-anchor` donde empieza “Ver a continuación”; el scroll de entrada lo alinea bajo el subnav |
| **Badge de estado** | Chip en el hero de ficha con el `estado` de visionado del usuario |
| **Bottom nav** | Barra fija inferior Series / Películas / Explorar / Perfil |
| **Chrome** | UI fija/sticky (subnav, filtros, nav, banner), no el contenido scrolleable |
| **Continue / Ver a continuación** | Sección del timeline para series `watching` con actividad o boost recientes |
| **continueBoostAt** | Timestamp ISO que fuerza continue ≤14 días (p.ej. temporada nueva) |
| **Crítica** | Texto libre del usuario (`critica`) en movie/show |
| **Drive gate** | Pantalla de login obligatoria antes de usar la app |
| **Featured providers** | Lista corta de plataformas unificadas para filtros |
| **flatrate** | En TMDB watch providers: suscripción (vs rent/buy) |
| **Flush** | Subida inmediata a Drive cancelando el debounce (p.ej. al ocultar pestaña) |
| **GIS** | Google Identity Services — OAuth token en el navegador |
| **LWW** | *Last-Write-Wins*: en merge, gana el ítem con `updatedAt` más reciente |
| **Lista pendiente (series)** | Timeline de próximos episodios de series en `watching` |
| **Network First** | Estrategia SW: intenta red; si falla, caché |
| **Cache First** | Estrategia SW: sirve caché; actualiza en background |
| **Otros** | Chip de filtro para providers no featured |
| **Payload Drive** | JSON `tv_showtime_data.json` con movies, shows, lists, tombstones |
| **pending (estado)** | Título en biblioteca aún no en “Viendo” / no vista |
| **PWA** | Progressive Web App — instalable, SW, manifest |
| **Reconcile** | Integrar remoto Drive + local (`reconcileWithDriveData`) |
| **Safe area** | Insets de notch / home indicator (`env(safe-area-inset-*)`) |
| **Shell** | HTML/CSS/JS de la app cacheados por el SW (sin datos de usuario) |
| **Stale / Sin ver por un tiempo** | Series `watching` sin actividad reciente (ni boost) |
| **Sticky offset** | Altura del chrome restada al calcular scroll al ancla |
| **Subnav** | Segunda fila de tabs (Lista pendiente / Próximamente) |
| **SW bump** | Incrementar `vN` en nombres de caché del Service Worker |
| **Timeline** | Lista cronológica/operativa de episodios (pending / upcoming / history) |
| **Tombstone** | Registro `{ id, deletedAt }` para que un borrado gane en el merge |
| **touchUpdatedAt** | Poner `updatedAt` a ahora en un ítem mutado |
| **TV Time** | App externa; SeenIt importa sus JSON de export |
| **Watch providers** | Dónde ver un título según TMDB (región ES preferida) |
| **watching** | Estado de serie activamente en seguimiento; alimenta lista pendiente |

---

## IDs y formatos

| Formato | Ejemplo | Uso |
|--------|---------|-----|
| `id_tmdb` | `1396` | PK TMDB |
| Episodio | `S01E05` | Progress keys |
| Lista | `lst_…` | `lists[].id` |
| Storage user | `seenit_data__123…` | localStorage por Google user id |

---

## Archivos clave (atajo)

| Archivo | Una frase |
|---------|-----------|
| `app.js` | Cerebro UI + sync orchestration |
| `tmdb-service.js` | Cliente TMDB |
| `drive-service.js` | OAuth + JSON Drive |
| `tvtime-import.js` | Import TV Time |
| `sw.js` | Caché PWA |
| `styles.css` | Diseño `tvst-*` |
| `index.html` | Shell + gate + registro SW |
| `config.js` | Secrets locales (no git) |

---

Fin del manual. Volver al [índice](README.md) o al [README del repo](../README.md).

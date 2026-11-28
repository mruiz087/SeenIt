# 13 — UI / CSS: convenciones

← [12 PWA](12-pwa-service-worker.md) · [Índice](README.md) · Siguiente: [14 window API](14-api-global-window.md)

---

## Propósito

Convenciones visuales en `styles.css` (prefijo **`tvst-`** = TV ShowTime / SeenIt). La app es dark-first (`#000`, acento amarillo `#facc15`).

Hay utilidades Tailwind v4 compiladas / enlazadas en `index.html` (`flex`, `hidden`, …), pero todo el sistema de diseño, componentes, temas y layouts específicos viven en `styles.css`.

---

## Variables (`:root`) y Temas

| Variable | Rol |
|----------|-----|
| `--tvst-bg` | Fondo principal (`#000`) |
| `--tvst-surface` / `--tvst-surface-2` | Superficies elevadas y tarjetas |
| `--tvst-border` | Bordes (`#2a2a2a`) |
| `--tvst-text` / `--tvst-muted` | Tipografía primaria y secundaria |
| `--tvst-accent` | Acento (`#facc15`, tabs activos, chips) |
| `--tvst-green` | Checks / progreso positivo |
| `--tvst-check-bg` / `--tvst-check-fg` | Botón ✓ |
| `--tvst-subnav-h` | Altura subnav (medida en JS) |
| `--tvst-profile-tabs-h` | Tabs de perfil |
| `--tvst-bottom-nav-h` | Barra de navegación inferior |
| `--tvst-safe-top` / `--tvst-safe-bottom` | Safe area iOS (`env(safe-area-inset-*)`) |

### Temas y estilos de póster desbloqueables

Aplicados sobre `<html>` desde gamificación (`app.js`):

- **Temas (`html[data-theme="..."]`):** `oled`, `cinema`, `neon`, `emerald`, `terracotta`, `crimson`, `royal`, `solaris`, `platinum`, `imperial` (sin atributo = tema por defecto).
- **Marcos/estilos de póster (`html[data-poster-style="..."]`):** `glass`, `cinema_glow`, `matte_film`, `collector`, `holo_foil`, `legend`, `archive_gold`.

No hardcodees alturas sticky en CSS fijo: usa siempre las variables `--tvst-*-h` que actualiza JS.

---

## Patrones sticky

1. **Subnav** `.tvst-subnav` — `position: sticky; top: 0` (con safe-top cuando aplica).
2. **Filtros / toolbars** — `top: calc(var(--tvst-subnav-h) - 2px)` + `box-shadow: 0 -2px 0 var(--tvst-bg)` para evitar huecos de 1px bajo el borde del subnav.
3. **Bottom nav** `.tvst-bottom-nav` — `position: fixed; bottom: 0`; `.tvst-main` reserva padding inferior con `--tvst-bottom-nav-h` + safe area.
4. **Banner SW** `.tvst-sw-banner` — `position: fixed`, `z-index: 90`, por encima de la navegación inferior.

Tras cambios de layout sticky, llama a `scheduleSyncMobileChromeHeights()`.

---

## Componentes frecuentes

| Clase | Uso |
|-------|-----|
| `.tvst-episode-list` / `.tvst-episode-row` | Timeline de series |
| `.tvst-upcoming-cal*` | Mini-calendario semanal de Próximamente |
| `.tvst-poster-grid` / `.tvst-poster-cell` | Grid de películas y explorar |
| `.tvst-check-btn` | Marcar episodio o película vista |
| `.tvst-badge--new` / `--last` | Badges de episodio |
| `.tvst-movies-filters` | Barra y panel colapsable de filtros de películas |
| `.profile-card` / `.tvst-fav-card` | Tarjetas de biblioteca y favoritos en Perfil |
| `.tvst-selector-*` / `#selector-winner-modal` | Selector “¿Qué vemos?” y modal de resultado aleatorio |
| `.tvst-ach-*` / `.tvst-ticket-*` / `.tvst-wrapped-*` | Logros, entradas vintage y estudio Wrapped |
| `.tvst-settings-*` / `.tvst-doc-accordion` | Tarjetas de Ajustes y acordeones `<details>` colapsables en Funcionamiento y Legal |
| `.tvst-univ-*` / `.tvst-export-card*` | Asistente universal de importación y tarjetas de exportación |
| `.tvst-modal` / `.tvst-modal-elevated` | Hojas/modales (`detail`, `episode`, `person`, `list`, `collectible`, `wrapped`, `import`, `export`, `selector-winner`) |

Estados estándar: `.is-active`, `.is-open`, `.hidden`, `.is-standby`, `.is-danger`, `.is-selected`.

---

## Acordeones de documentación en Ajustes (`.tvst-doc-accordion`)

En **Ajustes → Funcionamiento** y **Ajustes → Legal y datos**, cada bloque usa `<details class="tvst-section-card tvst-info-doc-card tvst-doc-accordion">` **sin** atributo `open` (colapsados por defecto). Al abrirse (`[open]`), rotan el icono `.tvst-doc-accordion-icon`, destacan el borde y animan `.tvst-doc-accordion-content`.

---

## Scroll y responsive

- `.tvst-main` es el único contenedor de scroll principal; evita `window.scrollTo`.
- Chips de filtros con scroll horizontal en móvil y `flex-wrap` en desktop.
- Modales full-bleed / bottom-sheet en pantallas pequeñas y centrados con `max-width` en desktop.

---

## Si quieres cambiar X, toca Y

| Cambio | Dónde |
|--------|--------|
| Paleta base o variables de tema | `:root` y bloques `html[data-theme="..."]` en `styles.css` |
| Acabados de póster | `html[data-poster-style="..."]` en `styles.css` |
| Acordeones de Ajustes | `.tvst-doc-accordion*` en `styles.css` + `<details>` en `index.html` |
| Huecos sticky | `top: calc(var(--tvst-subnav-h) - 2px)` + `syncMobileChromeHeights` |

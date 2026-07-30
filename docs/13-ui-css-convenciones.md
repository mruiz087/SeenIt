# 13 — UI / CSS: convenciones

← [12 PWA](12-pwa-service-worker.md) · [Índice](README.md) · Siguiente: [14 window API](14-api-global-window.md)

---

## Propósito

Convenciones visuales en `styles.css` (prefijo **`tvst-`** = TV ShowTime / SeenIt). La app es dark-first (`#000`, acento amarillo).

Hay utilidades tipo Tailwind en el HTML (`flex`, `hidden`, …) cargadas por CDN; el diseño propio vive en `styles.css`.

---

## Variables (`:root`)

| Variable | Rol |
|----------|-----|
| `--tvst-bg` | Fondo `#000` |
| `--tvst-border` | Bordes `#2a2a2a` |
| `--tvst-text` / `--tvst-muted` | Tipografía |
| `--tvst-accent` | Acento `#facc15` (tabs activos, chips) |
| `--tvst-green` | Checks / progreso positivo |
| `--tvst-check-bg` / `--tvst-check-fg` | Botón ✓ |
| `--tvst-subnav-h` | Altura subnav (medida en JS) |
| `--tvst-profile-tabs-h` | Tabs perfil |
| `--tvst-bottom-nav-h` | Nav inferior |
| `--tvst-safe-top` / `--tvst-safe-bottom` | Safe area iOS |

No hardcodes alturas sticky en CSS fijo si puedes usar estas vars: el JS las actualiza.

---

## Patrones sticky

1. **Subnav** `.tvst-subnav` — `position: sticky; top: 0` (o equivalente bajo safe-top).
2. **Filtros / toolbars** — `top: calc(var(--tvst-subnav-h) - 2px)` + `z-index` bajo el modal pero sobre el contenido; a menudo `box-shadow: 0 -2px 0 #000` para tapar el pixel del border.
3. **Bottom nav** — `position: fixed`; el main lleva padding-bottom con la var + safe.
4. **Banner SW** — fixed, `z-index: 90`, encima del nav.

Tras cambios de layout: llama `scheduleSyncMobileChromeHeights`.

---

## Componentes frecuentes

| Clase | Uso |
|-------|-----|
| `.tvst-episode-list` / filas episodio | Timeline series |
| `.tvst-poster-grid` / `.tvst-poster-cell` | Películas |
| `.tvst-check-btn` | Marcar visto |
| `.tvst-badge--new` / `--last` | Badges episodio |
| `.tvst-movies-filters` | Panel filtros |
| `.profile-card` | Biblioteca perfil |
| `.tvst-fav-card` | Favoritos |
| `.tvst-list-banner` | Cabecera lista |
| `.tvst-sw-banner` | Update SW |
| `.tvst-drive-gate*` | Login |
| Modal detail / episode | Sheets sobre contenido |

Estados: `.is-active`, `.is-open`, `.hidden`, `.is-standby`, `.is-danger`.

---

## Scroll

`.tvst-main` es el scroller. Evita `window.scrollTo` para timelines; usa helpers de `app.js`.

---

## Responsive

- Chips de filtros: overflow-x en móvil, wrap en desktop (`@media`).
- Bottom nav puede ajustar padding en breakpoints.
- Modales full-bleed en móvil.

---

## Si quieres cambiar X, toca Y

| Cambio | Dónde |
|--------|--------|
| Tema / acento | Variables `:root` |
| Hueco sticky | top calc −2px + medición JS ([06](06-navegacion-y-layout.md)) |
| Nuevo bloque UI | clase `tvst-*` + markup en `index.html` o string en `app.js` |
| Tipografía global | `body` / HTML; no hay design system aparte |

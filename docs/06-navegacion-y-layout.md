# 06 — Navegación y layout

← [05 Drive](05-drive-oauth.md) · [Índice](README.md) · Siguiente: [07 Timeline series](07-timeline-series.md)

---

## Propósito

Cómo se organizan las 5 pestañas principales, subnavegación, scroll y “chrome” sticky para que no queden huecos ni el contenido quede tapado bajo barras fijas.

---

## Estructura DOM (resumen)

```
#sw-update-banner            → encima del bottom nav (z-index alto)
#drive-gate                  → pantalla inicial (Drive o modo local)
#app
  .tvst-app-shell
    main.tvst-main           ← contenedor de SCROLL principal
      #content-series
      #content-movies
      #content-explore
      #content-profile
      #content-settings
    nav.tvst-bottom-nav      ← 5 tabs fijas abajo
  #detail-modal              ← ficha de serie/película
  #episode-modal             ← detalle de episodio
  #person-modal              ← ficha de actor/director
  #list-modal / #list-picker-modal
  #collectible-modal         ← entrada vintage de saga
  #wrapped-modal             ← generador de tarjeta PNG
  #universal-import-modal / #universal-export-modal
  #selector-winner-modal     ← modal del selector "¿Qué vemos?"
  #app-dialog-modal          ← confirmaciones/prompts integrados
```

**Regla de oro:** el scroll vertical de las vistas principales vive en **`.tvst-main`**, no en `window`. Helpers `getScrollTop` / `setScrollTop` operan sobre ese nodo.

---

## Tabs principales

`switchTab(tab)` con `tab ∈ { series, movies, explore, profile, settings }`:

1. Cierra modales de detalle, episodio, persona, listas, colección o selector si están abiertos.
2. Actualiza `AppState.currentTab`.
3. En `series`: resetea historial visible a 0 (ancla en «Ver a continuación»).
4. Muestra `#content-${tab}` y marca activo el botón en `.tvst-bottom-nav`.
5. `renderCurrentView` + `scheduleSyncMobileChromeHeights`.

---

## Subnavegación y Ajustes

| Zona | Estado | Valores | Función |
|------|--------|---------|---------|
| Series | `currentSubTab` | `pending-list` \| `upcoming` | `switchSubTab` |
| Películas | `currentMoviesSubTab` | `pending-list` \| `upcoming` | `switchMoviesSubTab` |
| Perfil | `currentProfileTab` | `series` \| `movies` \| `picker` \| `achievements` | `switchProfileTab` |
| Ajustes | `currentSettingsSubTab` | `general` \| `guide` \| `legal` | `switchSettingsSubTab` |

En Ajustes, las subpestañas **Funcionamiento** (`guide`) y **Legal y datos** (`legal`) se presentan como bloques `<details class="tvst-doc-accordion">` **colapsados por defecto** para facilitar la lectura en móvil y escritorio.

---

## Sticky chrome y medición

`syncMobileChromeHeights()` mide el subnav activo, tabs de perfil y bottom nav, escribiendo en `:root`:
- `--tvst-subnav-h`
- `--tvst-profile-tabs-h`
- `--tvst-bottom-nav-h`

Se ejecuta tras cada cambio de tab/render mediante `scheduleSyncMobileChromeHeights` (doble `rAF`).

---

## Safe areas y atajos

- `--tvst-safe-top` / `--tvst-safe-bottom` desde `env(safe-area-inset-*)` (`viewport-fit=cover`).
- Tecla `Escape` cierra el modal superior activo (`selector-winner-modal`, `universal-import-modal`, `universal-export-modal`, `wrapped-modal`, `collectible-modal`, `list-picker-modal`, `list-modal`, `episode-modal`, `person-modal`, `detail-modal`).

---

## Si quieres cambiar X, toca Y

| Cambio | Dónde |
|--------|--------|
| Nueva tab bottom | `index.html` + `switchTab` + `renderCurrentView` + `VALID_START_TABS` |
| Nuevo modal | `index.html` + `styles.css` + Escape handler + `switchTab` en `app.js` |
| Hueco bajo sticky | `syncMobileChromeHeights` + `top` del sticky + sombra anti-gap |

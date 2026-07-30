# 09 — Perfil, listas y favoritos

← [08 Películas](08-peliculas-y-filtros.md) · [Índice](README.md) · Siguiente: [10 Ficha](10-ficha-detalle.md)

---

## Propósito

La pestaña **Perfil** centraliza biblioteca, favoritos, listas custom, stats y ajustes (Drive, import/export).

---

## Subpestañas

`currentProfileTab` típico: series | movies | favorites | lists | settings (según markup en `index.html`).

`switchProfileTab` + `renderProfileView`. Sticky: `.tvst-profile-tabs` → `--tvst-profile-tabs-h`.

---

## Biblioteca (series / películas)

Filtros en estado:

- `profileSeriesFilter` / `profileMoviesFilter` — por `estado`
- `profileSeriesSearch` / `profileMoviesSearch` — título
- `profileSeriesPlatform` / `profileMoviesPlatform` — providers con `normalizeProviderName` + featured

Cards: `profile-card` con estrella `toggleFavoriteFromCard`. Standby tiene estilo `is-standby`.

Expansión “ver más”: `profileExpanded` + `toggleProfileExpanded`.

---

## Favoritos

- Campo `favorito` en movie/show.
- Toggle desde card o desde detalle.
- Vista dedicada agrupa series/películas favoritas (`tvst-fav-card`).
- Cabecera sticky alineada al chrome (mismo truco de gap que filtros/movies).

---

## Listas personalizadas

Modelo: [02](02-modelo-de-datos.md) (`id`, `name`, `tipo`, `itemIds`, `coverId`).

| Acción | Funciones típicas |
|--------|-------------------|
| Crear / renombrar / borrar | UI perfil + tombstone de lista |
| Añadir/quitar ítem | `toggleSelectedInList`, `removeItemFromList` |
| Portada | `listCoverPickMode` / click en banner |
| Orden | `listSortMode`: nombre / progreso / añadido |
| Abrir | `openListModal` |
| Exportar una lista | download JSON `seenit_lista_…` |

Picker desde detalle: `createListFromPicker`, filas `tvst-list-picker-row`.

Al borrar un título de la biblioteca: `removeItemFromAllLists`.

---

## Estadísticas

Cálculo de tiempo visto a partir de `episode_run_time` × episodios / `runtime` de películas vistas (funciones de stats en `app.js` cerca del render de perfil). Sirven como resumen motivacional, no contabilidad fiscal.

---

## Ajustes

En la zona de settings del perfil:

- Conectar / desconectar Drive
- **Sincronizar** → `loadFromDrive`
- Export / import JSON global
- Importación TV Time (ficheros) — [11](11-import-export-tvtime.md)
- Vaciar datos (`clearAllData`) — peligroso; respeta confirmaciones UI

---

## Si quieres cambiar X, toca Y

| Cambio | Dónde |
|--------|--------|
| Nuevo filtro de biblioteca | estado `profile*` + predicado en render |
| Orden de listas | `listSortMode` + comparadores |
| Stats distintas | función de agregación + markup perfil |
| Sticky toolbar perfil | CSS + `syncMobileChromeHeights` |

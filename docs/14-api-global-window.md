# 14 — API global `window`

← [13 CSS](13-ui-css-convenciones.md) · [Índice](README.md) · Siguiente: [15 Decisiones](15-decisiones-y-historial.md)

---

## Propósito

Sin bundler ni módulos ES en runtime: las funciones que el HTML llama con `onclick="..."` y las que se usan entre ficheros se cuelgan de **`window`**.

Si añades un handler en HTML y “no hace nada”, casi seguro falta el `window.foo = foo` al final de `app.js` (o del servicio).

---

## Servicios

### `window.TMDBService` (+ aliases)

`searchMulti`, `searchMovies`, `searchTV`, `getMovieDetails`, `getTVDetails`, `getTVShowMeta`, `getSeasonDetails`, `clearSeasonDetailsCache`, `findByExternalId`, `findMovieByTitleYear`, `findTVByTitleYear`, `getImageUrl`, `normalizeMovieData`, `normalizeTVData`, `normalizeSearchResult`, `getWatchProviders`, `searchWithDebounce`, `hasTmdbConfig`, …

### `window.DriveService` (+ aliases)

`initDriveService`, `authenticate`, `ensureValidAccessToken`, `signOut`, `isAuthenticated`, `hasGoogleConfig`, `formatDriveError`, `loadUserData`, `saveUserData`, `getUserInfo`, `findOrCreateDataFile`, `resetDriveDataFileCache`, …

### TV Time

- `window.importTvTimeLibrary`
- `window.importTvTimeLists`

---

## `window.App` (subconjunto)

Objeto con API “pública” reducida: `initApp`, `addMovie`, `addShow`, `removeMovie`, `removeShow`, `updateRating`, `updateStatus`, `toggleEpisode`, `switchTab`, `openDetail`, `connectDrive`, `exportData`, `importData`, …

Muchas funciones existen **además** como `window.nombreDirecto` porque el HTML las necesita sueltas.

---

## Handlers HTML frecuentes (`app.js` → `window.*`)

Navegación: `switchTab`, `switchSubTab`, `switchMoviesSubTab`, `switchProfileTab`, `scrollToNowAnchor`, `toggleProfileExpanded`.

Detalle: `openDetail`, `closeModal`, `openEpisodeDetail`, `closeEpisodeModal`, `setPersonalRating`, `startEditCritica`, `saveItemCritica`, `toggleDetailMenu`, `runDetailMenuAction`, `toggleFavorite*`, `addFromDetail`, `addItem`.

Películas: `setMoviesPendingGenreFilter`, `setMoviesPendingPlatformFilter`, `setMoviesPendingMaxRuntime`, `toggleMoviesPendingFilters`, `toggleMovieWatched`.

Series: `toggleEpisode`, `toggleSeasonWatched`, `toggleSeasonAccordion`, `toggleEpisodeAndUpdateSeason`.

Perfil / listas: `createProfileList`, `openListModal`, `closeListModal`, `renameSelectedList`, `deleteSelectedList`, `exportSelectedList`, `removeItemFromList`, `openListPicker`, `toggleSelectedInList`, `createListFromPicker`, `onListSortChange`, `onProfilePlatformChange`, `toggleListCoverPickMode`, `setListCover`.

Drive / datos: `connectDrive`, `connectDriveFromGate`, `disconnectDrive`, `loadFromDrive`, `exportData`, `importData`, `handleImport`, `clearAllData`, `onTvTimeFileSelected`, `startTvTimeImport`.

La lista exacta está al final de `app.js` (bloque “EXPORTACIONES”). **Al añadir UI nueva, exporta ahí.**

---

## Config global

Definidas en `config.js` (no documentar valores reales):

- `CONFIG_TMDB_API_KEY`
- `CONFIG_GOOGLE_CLIENT_ID`
- `CONFIG_GOOGLE_API_KEY`

---

## Flags / debug en `window`

Usados internamente (no API estable): `__seenitHistoryLoadReady`, `__seenitLastScrollY`, `__seenitAnchorTimers`, `__seenitMoviesFilterMetaHydrating`, …

No dependas de ellos fuera de `app.js`.

---

## Si quieres cambiar X, toca Y

| Cambio | Dónde |
|--------|--------|
| Nuevo `onclick` en HTML | Función + `window.fn = fn` |
| Llamar TMDB desde consola | `TMDBService.*` o aliases |
| Reducir superficie global | Migrar a módulos ES (fuera de alcance actual; rompería onclick) |

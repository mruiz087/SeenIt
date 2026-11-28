# 14 — API global `window`

← [13 CSS](13-ui-css-convenciones.md) · [Índice](README.md) · Siguiente: [15 Decisiones](15-decisiones-y-historial.md)

---

## Propósito

SeenIt no usa bundler ni módulos ES en runtime del navegador: las funciones invocadas desde atributos `onclick="..."` en `index.html` y las compartidas entre scripts se exponen explícitamente en **`window`**.

Si añades un botón con `onclick` en HTML y no responde, verifica que la función esté exportada al final de `app.js` o del servicio correspondiente.

---

## Servicios

### `window.TMDBService` (+ aliases directos)

`searchMulti`, `searchMovies`, `searchTV`, `getTrending`, `getMovieDetails`, `getTVDetails`, `getTVShowMeta`, `getSeasonDetails`, `getCollectionDetails`, `getPersonDetails`, `getMovieVideos`, `getTVVideos`, `clearSeasonDetailsCache`, `findByExternalId`, `findMovieByTitleYear`, `findTVByTitleYear`, `getImageUrl`, `normalizeMovieData`, `normalizeTVData`, `normalizeSearchResult`, `getWatchProviders`, `searchWithDebounce`, `hasTmdbConfig`, `clearPersistentTmdbCache`, etc.

### `window.DriveService` (+ aliases directos)

`initDriveService`, `isDriveServiceReady`, `authenticate`, `ensureValidAccessToken`, `signOut`, `isAuthenticated`, `hasGoogleConfig`, `formatDriveError`, `loadUserData`, `saveUserData`, `getUserInfo`, `findOrCreateDataFile`, `resetDriveDataFileCache`.

### `window.SeenItMigration` y `migration-service.js`

API unificada que sustituye al antiguo `tvtime-import.js`:

- Objeto `window.SeenItMigration` (`PLATFORM_DIRECTORY`, `EXPORT_TARGETS`, modales y exportadores).
- Modales y flujo: `openUniversalImportModal`, `closeUniversalImportModal`, `openUniversalExportModal`, `closeUniversalExportModal`, `triggerUniversalFileInput`, `triggerExportFromModal`, `resetUniversalImportWizard`, `onUniversalFileInputChange`, `onUniversalMappingChange`, `setUniversalDuplicateMode`, `setUniversalSeenItMode`, `startUniversalImport`, `cancelUniversalImport`.
- Exportadores: `exportUniversalCsv`, `exportLetterboxdCsv`, `exportTraktJson`, `exportSeriesGuideJson`.
- Incidencias: `exportIssuesCsv`, `copyIssuesToClipboard`, `searchIssueInExplore`.

---

## `window.App` (subconjunto público)

Objeto reducido en `app.js`: `initApp`, `addMovie`, `addShow`, `removeMovie`, `removeShow`, `updateRating`, `updateStatus`, `toggleEpisode`, `switchTab`, `scrollToNowAnchor`, `switchDetailTab`, `openDetail`, `closeModal`, `removeContent`, `handleSearch`, `addItem`, `connectDrive`, `disconnectDrive`, `exportData`, `importData`, `handleImport`, `clearAllData`.

---

## Handlers HTML principales (`app.js` → `window.*`)

- **Navegación:** `switchTab`, `switchSubTab`, `switchMoviesSubTab`, `switchProfileTab`, `switchSettingsSubTab`, `scrollToNowAnchor`, `toggleProfileExpanded`, `switchExploreTrendingTab`.
- **Calendarios de Próximamente:** `shiftUpcomingCalendarWeek`, `selectUpcomingCalendarDate`, `resetUpcomingCalendar`, `jumpToUpcomingCalendarDate`.
- **Detalle, episodios y personas:** `openDetail`, `closeModal`, `openEpisodeDetail`, `closeEpisodeModal`, `navigateEpisode`, `openPersonDetail`, `closePersonModal`, `openDetailFromPerson`, `setPersonalRating`, `startEditCritica`, `saveItemCritica`, `toggleDetailMenu`, `runDetailMenuAction`, `closeDetailMenu`, `toggleFavorite`, `toggleFavoriteFromHero`, `toggleFavoriteFromCard`, `addFromDetail`, `addItem`, `playDetailTrailer`, `stopDetailTrailer`, `jumpToDetailTrailer`, `revealCurrentEpisodeSpoilers`.
- **Series:** `toggleEpisode`, `toggleEpisodeSkipped`, `toggleSeasonWatched`, `toggleSeasonSkipped`, `toggleSeasonAccordion`, `toggleEpisodeAndUpdateSeason`, `toggleEpisodeFromDetail`, `toggleEpisodeSkippedFromDetail`.
- **Películas:** `setMoviesPendingSort`, `toggleMoviesPendingGenre`, `toggleMoviesPendingPlatform`, `setMoviesPendingMaxRuntime`, `toggleMoviesPendingFilters`, `resetMoviesPendingFilters`, `pickRandomPendingMovie`, `toggleMovieWatched`.
- **Perfil y listas:** `onProfileSearchInput`, `clearProfileSearch`, `resetProfileFilters`, `createProfileList`, `openListModal`, `closeListModal`, `renameSelectedList`, `deleteSelectedList`, `exportSelectedList`, `removeItemFromList`, `openDetailFromList`, `onListItemClick`, `toggleListCoverPickMode`, `setListCover`, `openListPicker`, `closeListPicker`, `toggleSelectedInList`, `createListFromPicker`, `onListSortChange`, `onProfilePlatformChange`.
- **Selector (“¿Qué vemos?”):** `setSelectorFilter`, `spinSelectorPicker`, `openSelectorWinnerModal`, `closeSelectorWinnerModal`, `openDetailFromSelectorModal`, `discardFromSelectorModal`, `toggleSelectorSuggestions`, `onSelectorSearchInput`, `clearSelectorSearch`, `addToSelectorFromSearch`, `removeFromSelector`, `clearSelectorItems`, `toggleItemInSelector`.
- **Logros, coleccionables y Wrapped:** `selectGamificationTheme`, `selectPosterStyle`, `setAchievementsFilter`, `setAchievementsCategory`, `toggleAchievementsExpanded`, `toggleRewardsExpanded`, `toggleTicketsExpanded`, `toggleWrappedExpanded`, `openWrappedSectionFromStats`, `openWrappedGenerator`, `openWrappedCardModal`, `closeWrappedModal`, `setWrappedStudioPeriod`, `setWrappedStudioFocus`, `setWrappedStudioStyle`, `setWrappedStudioPalette`, `selectWrappedBannerByKey`, `clearWrappedStudioBanner`, `pickRandomWrappedBanner`, `setWrappedBannerLayout`, `onWrappedBannerSearchInput`, `copyWrappedImage`, `downloadWrappedImage`, `shareWrappedImage`, `setTicketsGenreFilter`, `setTicketsStatusFilter`, `recheckVintageSagas`, `openVintageTicketModal`, `closeCollectibleModal`, `openCollectibleLibraryDetail`, `addSagaPartFromTicket`, `onGamificationToastClick`.
- **Drive, ajustes y notificaciones:** `connectDrive`, `connectDriveFromGate`, `continueWithoutDrive`, `disconnectDrive`, `loadFromDrive`, `exportData`, `importData`, `handleImport`, `clearAllData`, `resolveAppDialog`, `updatePreference`, `toggleSubscriptionPreference`, `clearTmdbCachesFromSettings`, `getPreferredProviderCountry`, `toggleNotificationsPreference`, `sendTestNotificationFromSettings`.

---

## Config global inyectada (`/config.js`)

Servida dinámicamente por `server.js` (no versionar claves reales en git):

- `CONFIG_TMDB_PROXY` (`true` cuando pasa por `/api/tmdb`)
- `CONFIG_TMDB_CONFIGURED` (`boolean`)
- `CONFIG_GOOGLE_CLIENT_ID` (`string`)
- `CONFIG_ADS_CLIENT_ID` / `CONFIG_ADS_SLOT_ID` / `CONFIG_AFFILIATE_AMAZON_TAG` (opcionales, actualmente sin uso activo en UI)

---

## Si quieres cambiar X, toca Y

| Cambio | Dónde |
|--------|--------|
| Nuevo `onclick` en HTML | Definir función y añadir `window.fn = fn` al final de `app.js` o `migration-service.js` |
| Nuevo servicio TMDB/Drive | Añadir al objeto `window.TMDBService` / `window.DriveService` + alias |

# 09 — Perfil, listas, selector y logros

← [08 Películas](08-peliculas-y-filtros.md) · [Índice](README.md) · Siguiente: [10 Ficha](10-ficha-detalle.md)

---

## Propósito

La pestaña **Perfil** centraliza el resumen de biblioteca, estadísticas de visionado, filtros de series/películas, listas personalizadas, el selector aleatorio **¿Qué vemos?** y el sistema de **Logros, niveles, recompensas y Wrapped**.

> Nota: **Ajustes** (Drive, preferencias, notificaciones, migración, guías y legal) tiene ahora su propia pestaña principal en la barra inferior (`switchTab('settings')`).

---

## Subpestañas de Perfil (`currentProfileTab`)

En `index.html` (`#profile-view`), hay **4 subpestañas**:

| Subtab | ID DOM | Contenido |
|--------|--------|-----------|
| `series` | `#profile-tab-series` | Biblioteca de series, estadísticas de tiempo/episodios, listas de series y favoritos |
| `movies` | `#profile-tab-movies` | Biblioteca de películas, estadísticas de cine, listas de películas y favoritos |
| `picker` | `#profile-tab-picker` | **Selector (“¿Qué vemos?”)** + modal de resultado `#selector-winner-modal` |
| `achievements` | `#profile-tab-achievements` | **Logros**, XP/nivel, temas y marcos desbloqueables, entradas vintage de sagas y **Wrapped PNG Studio** |

Controladas por `switchProfileTab` + `renderProfileView`. Sticky: `.tvst-profile-tabs` → `--tvst-profile-tabs-h`.

---

## Biblioteca (series / películas) y favoritos

Filtros en `AppState`:

- `profileSeriesFilter` / `profileMoviesFilter` — por `estado` (`all`, `watching`, `pending`, `completed`, `standby`, `abandoned`, `favorites`)
- `profileSeriesSearch` / `profileMoviesSearch` — búsqueda por título (`onProfileSearchInput`, `clearProfileSearch`)
- `profileSeriesPlatform` / `profileMoviesPlatform` — filtro por plataforma (`onProfilePlatformChange` con `normalizeProviderName`)
- `profileExpanded` (`toggleProfileExpanded`) — expandir secciones con muchos ítems

Cards (`profile-card`): botón estrella (`toggleFavoriteFromCard`) para alternar favorito directamente; estado standby usa estilo `.is-standby`.

---

## Listas personalizadas

Modelo en [02](02-modelo-de-datos.md) (`id`, `name`, `tipo`, `itemIds`, `coverId`).

| Acción | Funciones principales |
|--------|-----------------------|
| Crear / renombrar / borrar | `createProfileList`, `renameSelectedList`, `deleteSelectedList` (+ tombstone) |
| Añadir / quitar ítem | `openListPicker`, `toggleSelectedInList`, `createListFromPicker`, `removeItemFromList` |
| Portada | `toggleListCoverPickMode`, `setListCover` |
| Ordenación | `listSortMode` (`onListSortChange`: nombre / progreso / añadido) |
| Abrir detalle de lista | `openListModal` (`#list-modal`) |
| Exportar una lista | `exportSelectedList` → descarga JSON `seenit_lista_…` |

Al borrar un título de la biblioteca: `removeItemFromAllLists`.

---

## Selector (“¿Qué vemos?”)

Permite crear una lista corta de candidatas (`AppState.selectorItems`) para elegir al azar cuando no sabes qué ver:

1. **Arriba (configuración compacta):** filtros rápidos por tipo (`all` / `tv` / `movie`), búsqueda en biblioteca/TMDB (`onSelectorSearchInput`, `addToSelectorFromSearch`), sugerencias pendientes (`toggleSelectorSuggestions`) y chip-list de candidatas (`removeFromSelector`, `clearSelectorItems`).
2. **Acción:** botón **Elegir al azar** (`spinSelectorPicker`) selecciona un ítem aleatorio de las candidatas filtradas y abre el **modal `#selector-winner-modal`** (`openSelectorWinnerModal`).
3. **Modal ganador (`#selector-winner-modal`):** muestra póster, metadatos, botones para abrir la ficha (`openDetailFromSelectorModal`), volver a girar (`spinSelectorPicker`), descartar de la lista (`discardFromSelectorModal`) o cerrar (`closeSelectorWinnerModal`).

También se puede añadir/quitar cualquier título al selector desde el menú de acciones de su ficha (`toggleItemInSelector`).

---

## Logros, recompensas, entradas vintage y Wrapped

### XP y niveles

Calculados dinámicamente en base a la biblioteca (`recomputeGamification` en `app.js`):

- **+10 XP** por episodio visto
- **+20 XP** por película vista
- **+50 XP** por serie completada
- **+10 XP** por crítica escrita
- **+5 XP** por valoración personal
- **+15 XP** por lista personalizada creada
- **+XP de logros** desbloqueados por hitos (cantidad, variedad, sagas, géneros, rachas, etc.)

### Recompensas cosméticas

Al subir de nivel se desbloquean y pueden aplicarse desde Perfil → Logros:

- **Temas (`html[data-theme]`):** `default`, `oled`, `cinema`, `neon`, `emerald`, `terracotta`, `crimson`, `royal`, `solaris`, `platinum`, `imperial`.
- **Estilos de póster (`html[data-poster-style]`):** `default`, `glass`, `cinema_glow`, `matte_film`, `collector`, `holo_foil`, `legend`, `archive_gold`.
- **Wrapped Banner Studio** (desbloqueado en Nivel 70, aunque también accesible para configurar periodo/foco/paleta/fondo de tarjetas PNG).

### Entradas vintage de sagas (`#collectible-modal`)

- Verifica colecciones TMDB (`getCollectionDetails`) de las películas vistas (`recheckVintageSagas`, cacheado en `seenit_saga_collections_v1`).
- Cuando el usuario completa todas las películas de una saga, desbloquea una **entrada vintage coleccionable** visible en `#collectible-modal` (`openVintageTicketModal`, `addSagaPartFromTicket`).

### Wrapped Studio (`#wrapped-modal`)

- Genera tarjetas resumen visuales exportables en PNG mediante Canvas 2D (`openWrappedGenerator`, `openWrappedCardModal`, `downloadWrappedImage`, `copyWrappedImage`, `shareWrappedImage`).
- Permite elegir periodo (`all` / año), foco, estilo, paleta y póster/backdrop de fondo (usando `/api/tmdb-image` para evitar problemas CORS en Canvas).

---

## Si quieres cambiar X, toca Y

| Cambio | Dónde |
|--------|--------|
| Fórmula de XP o nuevos logros | Constantes y evaluadores de logros en `app.js` (~líneas 12700–13100) |
| Nuevos temas o estilos de póster | Tokens en `styles.css` (`[data-theme]`, `[data-poster-style]`) + catálogo en `app.js` |
| Flujo del Selector y modal | `spinSelectorPicker`, `openSelectorWinnerModal`, `#selector-winner-modal` |
| Diseño de tarjetas Wrapped | Canvas renderer (`renderWrappedCanvas`) en `app.js` + `#wrapped-modal` |

# 11 — Import / export y TV Time

← [10 Ficha](10-ficha-detalle.md) · [Índice](README.md) · Siguiente: [12 PWA](12-pwa-service-worker.md)

---

## Propósito

Dos caminos de intercambio de datos:

1. **Backup JSON nativo** de SeenIt (export/import del blob de biblioteca).
2. **Importación desde TV Time** (JSON de series, películas y opcionalmente listas).

---

## Export / import JSON (SeenIt)

| Acción | Comportamiento |
|--------|----------------|
| Exportar | Descarga `seenit_backup_YYYY-MM-DD.json` con movies, shows, lists, deleted*, etc. |
| Importar | Lee fichero; normaliza; aplica a `AppState`; save + sync |

Funciones: `exportData`, `importData` / `handleImport` (perfil). También existe export de **una lista** (`seenit_lista_…`).

Tras importar, conviene **Sincronizar** Drive para propagar a otros dispositivos.

---

## TV Time — `tvtime-import.js`

Entradas típicas (exportes del usuario):

- Series JSON
- Movies JSON
- Lists JSON (opcional)

API:

```js
await importTvTimeLibrary({ series, movies, replace, onProgress })
await importTvTimeLists({ lists, onProgress })
```

Expuestas en `window.importTvTimeLibrary` / `window.importTvTimeLists`. La UI del perfil enlaza file inputs y muestra progreso.

### Resolución TMDB

1. IDs externos (IMDB / TVDB) vía `findByExternalId`.
2. Fallback título + año (`findTVByTitleYear` / `findMovieByTitleYear`).
3. Si no hay match → `report.notFound`.

### Progreso de series

`extractWatchedProgress` + `formatEpisodeId` → `capitulos_vistos` en formato `S01E01`.

`mapTvTimeShowStatus` traduce estados TV Time → `pending` / `watching` / `completed` / …

Opción `replace: true` vacía movies/shows/lists antes (destructivo).

Hay `sleep` entre requests para no saturar TMDB.

---

## Buenas prácticas

1. Exporta backup SeenIt **antes** de un import TV Time masivo.
2. Revisa `notFound` / `errors` del report.
3. Tras import, `invalidateTimelineCaches` / reabrir series (la app suele refrescar vistas).
4. No subas los JSON de TV Time al repo (son datos personales); el workflow de Pages tampoco los publica en `site/`.

---

## Si quieres cambiar X, toca Y

| Cambio | Dónde |
|--------|--------|
| Nuevo campo en backup | `exportData` / parser de import + modelo [02](02-modelo-de-datos.md) |
| Mejor match TV Time | `resolveShowTmdbId` / `resolveMovieTmdbId` |
| Mapear más estados | `mapTvTimeShowStatus` |
| Rate limit import | `sleep` en el bucle |

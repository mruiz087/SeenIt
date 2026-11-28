# 11 — Importación y exportación universal (`migration-service.js`)

← [10 Ficha](10-ficha-detalle.md) · [Índice](README.md) · Siguiente: [12 PWA](12-pwa-service-worker.md)

---

## Propósito

El antiguo `tvtime-import.js` fue reemplazado por **`migration-service.js`**, un módulo unificado de importación y exportación accesible desde **Ajustes → Importar / Exportar datos** a través de dos modales dedicados:

- **`#universal-import-modal`** (`openUniversalImportModal`): asistente multipaso con detección automática de formato, mapeador de columnas, selección de duplicados, progreso en vivo y reporte de incidencias.
- **`#universal-export-modal`** (`openUniversalExportModal`): menú visual de tarjetas para elegir la plataforma o formato destino.

---

## Formatos soportados (`PLATFORM_DIRECTORY` y `EXPORT_TARGETS`)

| Plataforma / Formato | Importación | Exportación | Detalles |
|----------------------|-------------|-------------|----------|
| **SeenIt (`.json`)** | Automática (`merge` o `replace`) | Copia completa `.json` | Películas, series, episodios + fechas, saltados, listas, selector, preferencias y logros |
| **SeriesGuide (`.json`)** | Automática | **2 archivos `.json` oficiales** | `seriesguide-shows-YYYY-MM-DD.json` + `seriesguide-movies-YYYY-MM-DD.json` con episodios marcados, notas e IDs TMDB |
| **Trakt.tv (`.json` / `.csv`)** | Automática | Esquema Trakt `.json` | Películas, series, episodios exactos con timestamps, notas 1–10 e IDs TMDB/IMDb |
| **Letterboxd (`.csv`)** | Automática | Plantilla cine `.csv` | Películas vistas (rating `0.5–5.0`, fecha, crítica, `tmdbID`) o Watchlist |
| **CSV Universal (`.csv`)** | Automática | Tabla estándar `.csv` | Compatible con Excel, Google Sheets y Simkl (título, tipo, año, TMDB ID, estado, nota, episodios) |
| **IMDb (`.csv`)** | Automática | Vía CSV Universal | Películas y series por ID `tt...`, notas `1–10` y fecha |
| **TV Time (`.csv` / `.json`)** | Automática | Vía CSV Universal | Series por `tvdb_id`, episodios (`S/E`) y películas vistas |
| **CSV / JSON personalizado** | Mapeador manual de columnas | CSV Universal | Permite asignar título, tipo, año, ID externo, estado, nota, crítica, temporada y episodio |

---

## Flujo de importación (`#universal-import-modal`)

1. **Selección (`step: 'select'`):** drag & drop o selector de fichero (límite `MAX_IMPORT_FILE_BYTES = 25 MB`).
2. **Detección y previsualización (`step: 'preview'`):**
   - Si es backup nativo **SeenIt**: elige entre **Fusionar** (`seenitMode: 'merge'`) o **Reemplazar biblioteca** (`seenitMode: 'replace'`).
   - Si es externo (**SeriesGuide**, **Trakt**, **Letterboxd**, **IMDb**, **TV Time**, **CSV/JSON**): normaliza registros, permite ajustar el mapeo si hace falta y elegir qué hacer con títulos ya presentes (`duplicateMode`: `'merge'` o `'skip_existing'`).
3. **Ejecución (`step: 'running'`):**
   - Resolución TMDB concurrente (`IMPORT_TMDB_CONCURRENCY = 4`): primero por `tmdb_id` / `imdb_id` / `tvdb_id` (`findByExternalId`), con fallback por título + año (`findMovieByTitleYear` / `findTVByTitleYear`).
   - Soporta cancelación limpia (`cancelUniversalImport`).
4. **Resumen e incidencias (`step: 'summary'`):**
   - Muestra contadores (`addedMovies`, `mergedMovies`, `addedShows`, `mergedShows`, `episodesMarked`, `skippedExisting`).
   - Lista títulos no encontrados o ambiguos con opciones para copiar al portapapeles (`copyIssuesToClipboard`), descargar CSV de incidencias (`exportIssuesCsv`) o buscarlos directamente en **Explorar** (`searchIssueInExplore`).

---

## Exportación (`#universal-export-modal`)

Al abrir el modal de exportación se muestran tarjetas independientes para cada destino (`triggerExportFromModal(id)`):

- **`seenit`:** llama a `exportData()` en `app.js` y descarga `seenit_backup_YYYY-MM-DD.json`.
- **`universal_csv`:** `exportUniversalCsv()` genera tabla RFC 4180 UTF-8 (con BOM para Excel).
- **`letterboxd`:** `exportLetterboxdCsv()` ofrece exportar películas vistas (diario/valoraciones) o pendientes (watchlist).
- **`trakt`:** `exportTraktJson()` genera JSON estructurado con películas y series por temporadas/episodios.
- **`seriesguide`:** `exportSeriesGuideJson()` genera y descarga secuencialmente dos archivos JSON compatibles con la estructura oficial de SeriesGuide (`seriesguide-shows-*.json` y `seriesguide-movies-*.json`), incluyendo episodios vistos y saltados, notas personales e IDs TMDB.

También se mantiene la exportación individual de listas desde Perfil → Listas (`seenit_lista_*.json`).

---

## Buenas prácticas

1. Descarga una copia **SeenIt (`.json`)** antes de hacer un reemplazo o migración masiva.
2. En SeriesGuide al exportar, permite múltiples descargas en el navegador si pide confirmación para bajar los 2 JSON seguidos.
3. Si tras importar notas diferencias de estado en alguna serie, revisa la pestaña de incidencias del resumen final.

---

## Si quieres cambiar X, toca Y

| Cambio | Dónde |
|--------|--------|
| Añadir o editar plataforma soportada | `PLATFORM_DIRECTORY` y `EXPORT_TARGETS` en `migration-service.js` |
| Parser RFC 4180 o detección de fuente | `parseCsv`, `detectCsvDelimiter`, detectores de esquema en `migration-service.js` |
| Formato de salida SeriesGuide / Trakt / Letterboxd | `exportSeriesGuideJson`, `exportTraktJson`, `exportLetterboxdCsv` |
| Resolución de IDs externos TMDB | `resolveRecordTmdb` + `TMDBService.findByExternalId` |

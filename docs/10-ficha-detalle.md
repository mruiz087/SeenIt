# 10 — Ficha de detalle

← [09 Perfil](09-perfil-listas-favoritos.md) · [Índice](README.md) · Siguiente: [11 Import](11-import-export-tvtime.md)

---

## Propósito

Modal de ficha (`#detail-modal`) para serie o película: hero, estado, nota, crítica, providers, episodios (TV), recomendaciones y menú de acciones.

Entrada principal: `openDetail(type, id_tmdb)` / `openDetailFromList`.

---

## Apertura

1. Fetch fresco TMDB (`getMovieDetails` / `getTVDetails`) si hace falta.
2. `mergeDetailItem(existing, fresh)` — no pisa progreso/nota/crítica locales a ciegas.
3. `AppState.selectedItem` + render hero / tabs / cuerpo.
4. Si no está en biblioteca, CTAs para añadir (`addFromDetail`).

Cierre: `closeModal`. `switchTab` también cierra el modal.

---

## Hero

- Backdrop / póster, título, meta TMDB (año, duración, nota TMDB…).
- Barra o texto de **progreso** (series).
- Fila meta: info a la izquierda, **badge de estado de visionado** a la derecha (colores alineados con progreso / estado: pendiente, viendo, completada, standby, abandonada, vista…).

Actualización parcial: `updateDetailHero`.

---

## Nota personal

- `puntuacion` 0–10 (`setPersonalRating`).
- UI: botones 1–10; **Quitar nota** solo si `puntuacion > 0`.
- Persistencia: mutación + `touchUpdatedAt` + save + sync (a menudo flush más agresivo para no perder la nota).

No confundir con `vote_average` de TMDB.

---

## Crítica personal

Campo `critica` (string) en movie/show.

Flujo UI:

1. Sin texto → botón **Añadir crítica** (`startEditCritica`).
2. Editando → textarea + **Guardar** (`saveItemCritica`).
3. Con texto guardado → vista + **Modificar crítica**.

Solo tiene sentido si el ítem está en la biblioteca (si no, no hay dónde persistir el blob). Flag `detailCriticaEditing`.

---

## Episodios (series)

- Acordeones por temporada (`expandedSeasons`, `toggleSeasonAccordion`).
- Toggle episodio / temporada: `toggleEpisode`, `toggleSeasonWatched`, `toggleEpisodeAndUpdateSeason`.
- Modal episodio: `openEpisodeDetail` / `#episode-modal`.
- Al marcar desde pending/standby/abandoned → puede pasar a `watching` ([07](07-timeline-series.md)).

---

## Menú de acciones (overflow)

`toggleDetailMenu` / `runDetailMenuAction` / `closeDetailMenu`:

Acciones típicas: cambiar estado, favorito, gestionar listas, eliminar, etc. (lista construida según tipo y si está en biblioteca).

---

## Recomendaciones

Bloque colapsable (`detailRecsExpanded`, `toggleDetailRecsExpanded`) con cards que abren otra ficha o `addItem`.

---

## Si quieres cambiar X, toca Y

| Cambio | Dónde |
|--------|--------|
| Badge / colores de estado | render hero + CSS clases de estado |
| Campos del merge TMDB↔local | `mergeDetailItem` |
| Crítica / nota | `saveItemCritica`, `setPersonalRating`, normalizers |
| Nueva acción de menú | builder de actions + `runDetailMenuAction` |
| Sheet vs nav | CSS modal + [06](06-navegacion-y-layout.md) |

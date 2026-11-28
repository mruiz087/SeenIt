# 10 — Ficha de detalle

← [09 Perfil](09-perfil-listas-favoritos.md) · [Índice](README.md) · Siguiente: [11 Import/Export](11-import-export-tvtime.md)

---

## Propósito

Modales principales de detalle:

- **`#detail-modal`**: ficha completa de serie o película (hero, tráiler integrado, estado, nota, fecha de vista en cine, crítica, plataformas de streaming multi-país, episodios/temporadas, reparto, recomendaciones y menú de acciones).
- **`#episode-modal`**: detalle de un episodio individual con navegación anterior/siguiente y control de spoilers.
- **`#person-modal`**: biografía y filmografía de actores/directores (`openPersonDetail`).

Entrada principal: `openDetail(type, id_tmdb)` / `openDetailFromList`.

---

## Apertura y merge TMDB ↔ local

1. Fetch fresco TMDB (`getMovieDetails` / `getTVDetails`) usando caché híbrida (memoria + IndexedDB) si hace falta.
2. `mergeDetailItem(existing, fresh)` — actualiza metadatos TMDB sin sobrescribir progreso (`capitulos_vistos`, `capitulos_saltados`, `fecha_vista`), nota, crítica, estado ni listas locales.
3. Actualiza `AppState.selectedItem` y pinta hero, tabs y cuerpo.
4. Si no está en la biblioteca, muestra CTAs para añadir (`addFromDetail`).

Cierre: `closeModal`. Cambiar de pestaña principal (`switchTab`) también cierra modales abiertos.

---

## Hero y tráiler

- Backdrop / póster, título, metadatos TMDB (año, duración, nota TMDB, creadores/países/cadena).
- **Tráiler:** botón para reproducir vídeos de YouTube/TMDB dentro del hero o saltar a tráiler (`playDetailTrailer`, `stopDetailTrailer`, `jumpToDetailTrailer`).
- Barra de progreso (series) y badge de estado de visionado en colores semánticos.
- **Películas vistas:** permite visualizar y editar `fecha_vista`.
- Actualización parcial sin parpadeos: `updateDetailHero`.

---

## Nota personal y crítica

- **Nota personal (`puntuacion`):** escala `0–10` (`setPersonalRating`); muestra botones 1–10 y opción **Quitar nota** si `puntuacion > 0`. Dispara recálculo de XP y persistencia rápida.
- **Crítica personal (`critica`):** texto privado en biblioteca:
  1. Sin texto → **Añadir crítica** (`startEditCritica`).
  2. Editando → textarea + **Guardar** (`saveItemCritica`).
  3. Guardada → vista + **Modificar crítica**.

---

## Episodios, saltos y anti-spoilers (series)

- Acordeones por temporada (`expandedSeasons`, `toggleSeasonAccordion`).
- **Marcar vistos:** `toggleEpisode`, `toggleSeasonWatched`, `toggleEpisodeAndUpdateSeason` (respeta `preferences.previousEpisodesRule` para capítulos anteriores).
- **Saltar capítulos / temporadas (`capitulos_saltados`):** `toggleEpisodeSkipped`, `toggleSeasonSkipped` — marca episodios como omitidos para que no aparezcan como pendientes en el timeline ni bloqueen el estado `completed`.
- **Modo sin spoilers (`preferences.spoilerFree`):** oculta miniaturas, títulos/sinopsis de episodios aún no vistos; se puede revelar puntualmente con `revealCurrentEpisodeSpoilers`.
- **Modal de episodio (`#episode-modal`):** `openEpisodeDetail`, `navigateEpisode`, `toggleEpisodeFromDetail`, `toggleEpisodeSkippedFromDetail`.

---

## Menú de acciones (overflow)

`toggleDetailMenu` / `runDetailMenuAction` / `closeDetailMenu`:

- Cambiar estado (`pending`, `watching`, `completed`, `standby`, `abandoned`).
- Marcar/desmarcar favorito (`toggleFavoriteFromHero`).
- Gestionar listas personalizadas (`openListPicker`).
- Añadir o quitar del **Selector (“¿Qué vemos?”)** (`toggleItemInSelector`).
- Eliminar título de la biblioteca (`removeContent`).

---

## Plataformas, reparto y recomendaciones

- **Dónde ver (`watch_providers`):** consulta país preferido (`getPreferredProviderCountry()`) mostrando suscripción (`flatrate`), alquiler o compra.
- **Reparto:** cards clicables que abren `#person-modal` (`openPersonDetail` → `openDetailFromPerson`).
- **Recomendaciones:** bloque colapsable (`detailRecsExpanded`, `toggleDetailRecsExpanded`) con acceso directo a otras fichas o añadir a biblioteca.

---

## Si quieres cambiar X, toca Y

| Cambio | Dónde |
|--------|--------|
| Campos preservados en merge TMDB↔local | `mergeDetailItem` en `app.js` |
| Regla de episodios saltados / anteriores | `toggleEpisodeSkipped`, `toggleEpisodeAndUpdateSeason` |
| Ocultación de spoilers | `isEpisodeSpoilerHidden` / render de episodios en `app.js` |
| Acciones del menú overflow | Builder de acciones + `runDetailMenuAction` |

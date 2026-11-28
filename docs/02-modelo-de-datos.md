# 02 — Modelo de datos

← [01 Arquitectura](01-vision-y-arquitectura.md) · [Índice](README.md) · Siguiente: [03 Persistencia](03-persistencia-y-sync.md)

---

## Propósito

Definir la forma de la biblioteca que se guarda en **IndexedDB + localStorage** y en Drive (`tv_showtime_data.json`). Todo merge y toda UI parten de estos shapes.

La normalización al cargar/guardar está en:

- `normalizeStoredMovie`
- `normalizeStoredShow`
- `normalizeStoredList`
- `normalizeSelectorItem`
- `normalizePreferences`
- `normalizeGamificationState`
- `normalizeDeletedIds` / `normalizeDeletedListIds` / `normalizeDeletedSelectorKeys`

---

## Payload raíz (local / Drive)

```json
{
  "movies": [],
  "shows": [],
  "lists": [],
  "selectorItems": [],
  "deletedIds": { "movie": [], "tv": [] },
  "deletedListIds": [],
  "deletedSelectorKeys": [],
  "preferences": {},
  "gamification": {},
  "lastModified": "2026-11-28T10:00:00.000Z"
}
```

| Campo | Significado |
|-------|-------------|
| `movies` / `shows` | Ítems de biblioteca |
| `lists` | Listas personalizadas |
| `selectorItems` | Candidatos en el selector «¿Qué vemos?» |
| `deletedIds` | Tombstones de películas/series (`{ id, deletedAt }`) |
| `deletedListIds` | Tombstones de listas (`{ id, deletedAt }`) |
| `deletedSelectorKeys` | Tombstones de candidatos del selector (`{ key, deletedAt }`) |
| `preferences` | Ajustes del usuario (`DEFAULT_PREFERENCES`) |
| `gamification` | Estado de logros desbloqueados y rachas/eventos |
| `lastModified` | Marca del blob completo (útil para comparar snapshots) |

Cada ítem lleva además su propio `updatedAt` (LWW a nivel de entidad).

---

## Película (`tipo: 'movie'`)

| Campo | Origen | Notas |
|-------|--------|--------|
| `id_tmdb` | TMDB | Clave primaria |
| `imdb_id` | TMDB | Para migración (IMDb, Trakt, SeriesGuide) |
| `titulo`, `portada`, `backdrop`, `sinopsis` | TMDB | URLs / sinopsis |
| `fecha_estreno`, `runtime`, `generos` | TMDB | Filtros de duración/género/próximos estrenos/avisos |
| `vote_average`, `collection` | TMDB | Nota pública y saga coleccionable |
| `watch_providers` | TMDB | Cache por país de streaming |
| `estado` | Usuario | `pending` \| `completed` (acepta aliases legacy como `watched`) |
| `fecha_visto` | Usuario | ISO de cuándo se marcó vista (estadísticas y Wrapped) |
| `favorito` | Usuario | boolean |
| `puntuacion` | Usuario | 0–10; 0 = sin nota |
| `critica` | Usuario | string; crítica o nota privada |
| `updatedAt` | Sistema | ISO; LWW |

`normalizeStoredMovie` garantiza tipos seguros y `critica` string.

---

## Serie (`tipo: 'tv'`)

| Campo | Origen | Notas |
|-------|--------|--------|
| `id_tmdb` | TMDB | PK |
| `imdb_id`, `tvdb_id` | TMDB / migración | Para compatibilidad externa |
| `titulo`, `portada`, `backdrop`, `sinopsis`, `generos`, `paises`, `network` | TMDB | Metadatos base (y export SeriesGuide) |
| `status` | TMDB | Ej. Returning Series / Ended / Canceled |
| `estado` | Usuario | Ver estados abajo |
| `temporadas[]` | TMDB + cache | `{ numero, episodio_count, especial, ... }` |
| `capitulos_vistos` | Usuario | Array de IDs `S01E01` |
| `capitulos_saltados` | Usuario | Array de IDs `S01E01` marcados como saltados |
| `capitulos_vistos_fecha` | Usuario | Mapa `episodeId → ISO` (actividad / historial / Wrapped) |
| `next_episode_to_air` | TMDB | Próximo episodio emitido (usado en Próximamente y avisos PWA) |
| `episodios_emitidos`, `episodios_vistos_count`, `episodios_consumidos_count` | Derivados / meta | Progreso real |
| `episode_run_time` | TMDB | Duración media (stats y export SeriesGuide) |
| `favorito`, `puntuacion`, `critica` | Usuario | Igual que películas |
| `continueBoostAt` | Sistema | ISO; fuerza sección «Ver a continuación» ≤14 días |
| `metaCheckedAt` | Sistema | TTL de refresco de meta TMDB |
| `watch_providers` | TMDB | Perfil / fichas |
| `updatedAt` | Sistema | LWW |

### Estados de visionado (`estado`)

Normalizados por `normalizeStatus` (acepta aliases legacy):

| Valor | UI típica |
|-------|-----------|
| `pending` | Pendiente (default al **añadir** serie nueva) |
| `watching` | Viendo |
| `completed` | Completada |
| `standby` | Ver en otro momento |
| `dropped` | Abandonada (alias `abandoned`) |

**Importante:** al añadir desde búsqueda/detalle, la serie empieza en `pending` (no `watching`). Al marcar un episodio suele pasar a `watching`.

### IDs de episodio

Formato canónico: **`S01E01`** (temporada y episodio con padding de 2+ dígitos).

- Se usan en `capitulos_vistos`, `capitulos_saltados`, `capitulos_vistos_fecha`, toggles y timelines.
- Especiales: temporada `0` → `S00E…`.

---

## Lista personalizada, Selector y Preferencias

### Lista personalizada
```js
{
  id: 'lst_…',
  name: 'Nombre',
  tipo: 'tv' | 'movie',
  itemIds: [123, 456], // id_tmdb
  coverId: 123,        // póster de cabecera
  updatedAt: '…'
}
```

### Candidato del Selector (`selectorItems`)
```js
{
  tipo: 'tv' | 'movie',
  id_tmdb: 123,
  titulo: '…',
  portada: '…',
  fecha_estreno: '…',
  vote_average: 8.2,
  runtime: 120,
  sinopsis: '…',
  addedAt: '…',
  updatedAt: '…'
}
```

### Preferencias (`DEFAULT_PREFERENCES`)
Incluyen: `startTab`, `spoilerFree`, `includeSpecials`, `inactivityDays` (7/14/30/60), `previousEpisodesRule` (`ask`/`always`/`never`), `showMoviePosterTitles`, `showMoviePosterRatings`, `providerCountry` (`ES`/`MX`/`AR`/`CO`/`CL`/`US`), `mySubscriptions`, `showTrailers`, `showUpcomingMiniCalendar`, `notificationsEnabled`, `notifyEpisodeReleases`, `notifyMovieReleases`, `notifyHour`, `gamificationEnabled`, `gamificationTheme`, `posterStyle`, `celebrationEffects`, `updatedAt`.

---

## Tombstones

Borrar un ítem, lista o candidato del selector registra un tombstone para evitar que una copia antigua en Drive o en otro dispositivo lo resucite durante el merge:

```js
// deletedIds.movie / .tv
{ id: 1396, deletedAt: '2026-11-28T10:00:00.000Z' }

// deletedListIds
{ id: 'lst_abc', deletedAt: '…' }

// deletedSelectorKeys
{ key: 'movie:550', deletedAt: '…' }
```

Regla (`isItemTombstoned`): se oculta si `deletedAt >= updatedAt`. Si el usuario vuelve a añadir el ítem con un `updatedAt` más nuevo, revive.

---

## Backup previo al merge

Antes de reconciliar con Drive, `backupLibraryBeforeMerge` escribe `seenit_data_backup` en `localStorage`.

---

## Si quieres cambiar X, toca Y

| Cambio | Dónde |
|--------|--------|
| Nuevo estado de serie | `normalizeStatus` + selects UI detalle/perfil + filtros timeline + exportadores |
| Nueva preferencia | `DEFAULT_PREFERENCES` + `normalizePreferences` + `renderSettings` |
| Nuevo campo en ítem | `normalizeStoredMovie` / `normalizeStoredShow` + `touchUpdatedAt` + exportadores si aplica |

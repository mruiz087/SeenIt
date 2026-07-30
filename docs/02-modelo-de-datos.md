# 02 — Modelo de datos

← [01 Arquitectura](01-vision-y-arquitectura.md) · [Índice](README.md) · Siguiente: [03 Persistencia](03-persistencia-y-sync.md)

---

## Propósito

Definir la forma de la biblioteca que se guarda en **localStorage** y en Drive (`tv_showtime_data.json`). Todo merge y toda UI parten de estos shapes.

La normalización al cargar/guardar está en:

- `normalizeStoredMovie`
- `normalizeStoredShow`
- `normalizeStoredList`
- `normalizeDeletedIds` / `normalizeDeletedListIds`

---

## Payload raíz (local / Drive)

```json
{
  "movies": [],
  "shows": [],
  "lists": [],
  "deletedIds": { "movie": [], "tv": [] },
  "deletedListIds": [],
  "lastModified": "2026-07-29T12:00:00.000Z"
}
```

| Campo | Significado |
|-------|-------------|
| `movies` / `shows` | Ítems de biblioteca |
| `lists` | Listas personalizadas |
| `deletedIds` | Tombstones de películas/series (`{ id, deletedAt }`) |
| `deletedListIds` | Tombstones de listas (`{ id, deletedAt }`) |
| `lastModified` | Marca del blob completo (útil para comparar snapshots) |

Cada ítem lleva además su propio `updatedAt` (LWW a nivel de entidad).

---

## Película (`tipo: 'movie'`)

Campos habituales (mezcla TMDB + usuario):

| Campo | Origen | Notas |
|-------|--------|--------|
| `id_tmdb` | TMDB | Clave primaria |
| `titulo`, `poster_path`, `backdrop_path`, `overview` | TMDB | |
| `release_date`, `runtime`, `genres` / nombres | TMDB | Filtros de duración/género |
| `vote_average` | TMDB | Nota pública |
| `providers` / watch providers | TMDB (ES) | Filtro plataforma |
| `estado` | Usuario | `pending` \| `watched` (y normalizaciones legacy) |
| `favorito` | Usuario | boolean |
| `puntuacion` | Usuario | 0–10; 0 = sin nota |
| `critica` | Usuario | string; crítica personal |
| `updatedAt` | Sistema | ISO; LWW |
| `lastModified` | Legacy | Se usa como fallback de `updatedAt` |

`normalizeStoredMovie` garantiza tipos seguros y `critica` string.

---

## Serie (`tipo: 'tv'`)

| Campo | Origen | Notas |
|-------|--------|--------|
| `id_tmdb` | TMDB | PK |
| `titulo`, posters, `overview`, `genres` | TMDB | |
| `status` | TMDB | Ej. Returning Series / Ended (meta de emisión) |
| `estado` | Usuario | Ver estados abajo |
| `temporadas[]` | TMDB + cache | `{ numero, especial, ... }` |
| `capitulos_vistos` | Usuario | Array de IDs `S01E01` |
| `capitulos_vistos_fecha` | Usuario | Mapa `episodeId → ISO` (actividad / historial) |
| `episodios_emitidos`, `episodios_vistos_count` | Derivados / meta | |
| `episode_run_time` | TMDB | Stats de tiempo |
| `favorito`, `puntuacion`, `critica` | Usuario | Igual que películas |
| `continueBoostAt` | Sistema | ISO; fuerza sección «Ver a continuación» ≤14 días |
| `metaCheckedAt` | Sistema | TTL de refresco de meta TMDB |
| `providers` | TMDB | Perfil / filtros |
| `updatedAt` | Sistema | LWW |

### Estados de visionado (`estado`)

Normalizados por `normalizeStatus` (acepta aliases legacy):

| Valor | UI típica |
|-------|-----------|
| `pending` | Pendiente (default al **añadir** serie nueva) |
| `watching` | Viendo |
| `completed` | Completada |
| `standby` | Ver en otro momento |
| `abandoned` | Abandonada |

**Importante:** al añadir desde búsqueda/detalle, el código pone `details.estado = 'pending'` (no `watching`). Al marcar el primer episodio suele pasar a `watching`.

### IDs de episodio

Formato canónico: **`S01E01`** (temporada y episodio con padding).

- Se usan en `capitulos_vistos`, `capitulos_vistos_fecha`, toggles y timelines.
- Especiales: temporada `0` → `S00E…`.

Si importas datos externos, hay que convertir a este formato o el progreso no casará con TMDB.

---

## Lista personalizada

```js
{
  id: 'lst_…',       // string
  name: 'Nombre',
  tipo: 'tv' | 'movie',
  itemIds: [123, 456], // id_tmdb
  coverId: 123,        // póster de cabecera
  updatedAt: '…'
}
```

`normalizeStoredList` deduplica `itemIds` y genera `id` si falta.

---

## Tombstones

Borrar un ítem **no** es solo quitarlo del array: se registra un tombstone para que, en el siguiente merge, una copia antigua en otro dispositivo no “resucite” el ítem.

```js
// deletedIds.movie / .tv
{ id: 1396, deletedAt: '2026-07-29T10:00:00.000Z' }

// deletedListIds
{ id: 'lst_abc', deletedAt: '…' }
```

Regla (`isItemTombstoned`): el ítem se oculta si `deletedAt >= updatedAt` del ítem. Si el usuario **vuelve a añadir** el mismo `id_tmdb` con `updatedAt` más nuevo que el tombstone, el ítem revive.

Ver [03](03-persistencia-y-sync.md).

---

## Backup previo al merge

Antes de reconciliar, `backupLibraryBeforeMerge` escribe `seenit_data_backup` en localStorage (snapshot local + `backedUpAt`). No sustituye a export JSON manual, pero salva de merges malos.

---

## Campos “nuevos” a no olvidar en features

Al añadir persistencia de algo del usuario:

1. Incluirlo en `normalizeStoredMovie` / `normalizeStoredShow`.
2. Asegurarse de que mutaciones llaman a actualización de `updatedAt` (p.ej. `touchUpdatedAt`).
3. No hace falta schema migration formal: la normalización rellena defaults.

Ejemplos recientes: `critica`, `continueBoostAt`.

---

## Si quieres cambiar X, toca Y

| Cambio | Dónde |
|--------|--------|
| Nuevo estado de serie | `normalizeStatus` + selects UI detalle/perfil + filtros timeline |
| Cambiar ID de episodio | Toda la cadena TMDB ↔ `capitulos_vistos` ↔ import TV Time |
| Campo solo local (no Drive) | Evítalo: todo el blob se sube; usa otra key de localStorage |
| Renombrar fichero Drive | `DATA_FILE_NAME` + migración manual de usuarios |

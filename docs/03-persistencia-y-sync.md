# 03 — Persistencia y sync

← [02 Modelo](02-modelo-de-datos.md) · [Índice](README.md) · Siguiente: [04 TMDB](04-tmdb.md)

---

## Propósito

Explicar cómo la biblioteca sobrevive a recargas en el navegador (IndexedDB + `localStorage`), permite trabajar **con o sin Google Drive**, y se fusiona de forma segura entre dispositivos.

---

## Almacenamiento local (`localStorage` + IndexedDB)

### `localStorage`
| Clave | Contenido |
|-------|-----------|
| `seenit_data__${userId}` | Blob de biblioteca (`seenit_data__guest` en modo sin Drive) |
| `seenit_data` | Legacy; se migra una vez a la clave por usuario |
| `seenit_data_backup` | Snapshot local justo antes de un merge con Drive |
| `seenit_drive_user` | Info básica del usuario Google o modo invitado |
| `seenit_drive_token` | Access token + `expiresAt` (`drive-service.js`) |
| `seenit_tmdb_seasons_v1` | Caché legacy de temporadas TMDB |
| `seenit_notif_sent_v1` | Registro diario de notificaciones ya mostradas |
| `seenit_saga_collections_v1` | Caché de colecciones/sagas detectadas para entradas vintage |

### IndexedDB
| Base de datos | Uso |
|---------------|-----|
| `seenit_local_db` | Espejo principal de biblioteca por usuario (`app.js`) con mayor cuota que `localStorage` |
| `seenit_tmdb_cache_db` | Caché persistente de temporadas (`season_items`, hasta 1500 entradas, TTL 24 h) en `tmdb-service.js` |
| `seenit_notifications_db` | Programación de estrenos y `sentKeys` compartidos entre `app.js` y `sw.js` |

Funciones principales: `getDataStorageKey`, `loadLocalData`, `saveLocalData`, `saveLocalDataImmediate`, `migrateLegacyDataIfNeeded`.

---

## Ciclo local y modo invitado

1. El usuario puede iniciar sesión con Google Drive o pulsar **Continuar sin Drive** (`continueWithoutDrive()`).
2. Casi toda mutación relevante:
   - Actualiza el ítem / preferencia / tombstone.
   - Llama a `touchUpdatedAt(item)` (ISO actual).
   - Llama a `saveLocalData()` (debounce 400 ms en memoria → IndexedDB + `localStorage`, o `saveLocalDataImmediate()` en puntos críticos) y programa `scheduleNotifSyncToSw()`.
   - Si hay Drive conectado, llama a `syncToDrive()` (debounce 2 s).

---

## Debounce y flush

| Mecanismo | Comportamiento |
|-----------|----------------|
| `saveLocalData()` | Debounce de **400 ms**; flush en `visibilitychange` / `pagehide` |
| `syncToDrive()` | Programa `syncToDriveNow` en **2000 ms**; reinicia el timer si hay más cambios |
| `bindSyncFlushListeners` | Al ocultar pestaña (`visibilitychange` → `hidden`) o `pagehide`, cancela debounce y sube ya |
| `syncDirty` | Si llega un sync mientras `isSyncing`, al terminar se vuelve a llamar `syncToDriveNow` |

Condiciones para subir a Drive: `isAuthenticated()` y `AppState.driveLoadOk`.

---

## Pull / reconcile y Merge LWW (`mergeLibraries`)

`loadFromDrive` (botón **Sincronizar ahora** en Ajustes):

1. Snapshot local (`snapshotLibrary`).
2. `loadUserData()` desde Drive.
3. `reconcileWithDriveData(remote, localSnapshot)`.
4. `saveLocalDataImmediate` + según resultado (`local-upload`, `merged`, `remote`, `unchanged`), push o aplicación remota.

Siempre se ejecuta `backupLibraryBeforeMerge` antes.

**Last-Write-Wins (LWW)** por entidad:
1. Unir tombstones (`deletedIds`, `deletedListIds`, `deletedSelectorKeys`) quedándote con el `deletedAt` más reciente.
2. Movies/shows por `id_tmdb`: gana el documento con `updatedAt` más nuevo (desempate por `capitulos_vistos` + `capitulos_saltados`).
3. Filtrar ítems tombstoned (`deletedAt >= updatedAt`).
4. Listas por `id` (o nombre+tipo) y `selectorItems` por `tipo:id_tmdb`.
5. `preferences` y `gamification` se reconcilian por `updatedAt` / unión segura de logros desbloqueados.

---

## Debug rápido

1. DevTools → Application → **IndexedDB** (`seenit_local_db`, `seenit_notifications_db`) y **Local Storage** (`seenit_data__*`, `seenit_data_backup`).
2. Consola: logs `[App] Datos sincronizados`, `[Drive] …`.
3. Botón **Sincronizar ahora** = pull + merge + push si procede.

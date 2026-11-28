# 12 — PWA, Service Worker y Notificaciones

← [11 Import/Export](11-import-export-tvtime.md) · [Índice](README.md) · Siguiente: [13 CSS](13-ui-css-convenciones.md)

---

## Propósito

SeenIt es una PWA instalable (`manifest.json` + `icons/` + `sw.js`). El Service Worker cumple dos funciones:

1. **Caché del shell** para arranques instantáneos y uso offline parcial (la biblioteca sigue persistida en `localStorage` + `IndexedDB` + Drive opcional).
2. **Notificaciones PWA locales y en segundo plano** de estrenos de episodios y películas sin necesidad de servidor push externo (VAPID).

Versión actual de cachés: **`seenit-static-v0.112`** / **`seenit-dynamic-v0.112`**.

---

## Estrategias de caché (`sw.js`)

| Recurso | Estrategia |
|---------|------------|
| `STATIC_FILES` (`./`, `index.html`, `manifest.json`, `styles.css`, `app.js`, `migration-service.js`, `drive-service.js`, `tmdb-service.js`, `icons/*`) | **Cache First** con coincidencia exacta (`isExactStaticFile`) + revalidación en background (`fetchAndCache`) |
| `config.js` y `/api/*` (`isNetworkOnlyPath`) | **Solo red** (`cache: 'no-store'`, sin guardar en caché; devuelve `503 { error: 'Offline' }` si no hay red) |
| APIs externas (`api.themoviedb.org`, `image.tmdb.org`, `googleapis.com`, `accounts.google.com`, `cdn.tailwindcss.com`) | **Red directa** sin caché SW |
| Otros recursos same-origin | **Network First** en `DYNAMIC_CACHE` |

Al activarse una nueva versión: elimina cachés antiguas distintas de `STATIC_CACHE`/`DYNAMIC_CACHE` y ejecuta `self.clients.claim()`.

---

## Banner de actualización

En `index.html`:

1. Registra `navigator.serviceWorker.register('./sw.js')`.
2. Si existe `reg.waiting` (o `updatefound` → `installed` con controller previo), muestra `#sw-update-banner`.
3. Al pulsar **Recargar** → envía `postMessage({ type: 'SKIP_WAITING' })`.
4. Al dispararse `controllerchange` (o tras timeout de seguridad de 800 ms) → recarga la página.

CSS: `.tvst-sw-banner` (`z-index: 90`, por encima del bottom nav).

---

## Notificaciones PWA locales y en segundo plano

Al no existir base de datos central de usuarios ni servidor push VAPID, las notificaciones se gestionan localmente entre `app.js` y `sw.js`:

1. **Preferencias en Ajustes (`preferences`):**
   - `notificationsEnabled` (`boolean`) — solicita `Notification.requestPermission()` al activar.
   - `notifyEpisodeReleases` (`boolean`) — avisos de nuevos episodios en seguimiento.
   - `notifyMovieReleases` (`boolean`) — avisos de estreno de películas pendientes.
   - `notifyHour` (`'HH:MM'`, defecto `'10:00'`) — hora local a partir de la cual se disparan los avisos del día.
   - Botón de prueba en Ajustes (`sendTestNotificationFromSettings`) que envía `SEND_TEST_NOTIFICATION` al SW.
2. **Sincronización de agenda (`SYNC_NOTIF_SCHEDULE`):**
   - `app.js` calcula los estrenos próximos de series y películas y envía la agenda al SW (`postMessage`), que la persiste en la base IndexedDB compartida **`seenit_notifications_db`** (store `state`, clave `schedule`).
   - El historial de avisos ya mostrados (`sentKeys`, máximo 250) evita duplicados tanto en `localStorage` (`seenit_notif_sent_v1`) como en `seenit_notifications_db`.
3. **Disparo en segundo plano y al abrir:**
   - **`periodicsync`** (`tag: 'seenit-release-check'`): cuando el navegador/SO lo soporta en la PWA instalada (Android/Chromium desktop), comprueba `checkAndShowDueNotifications()` en segundo plano.
   - Al abrir/enfocar la app o sincronizar agenda (`CHECK_NOTIFICATIONS_NOW`), comprueba si hay estrenos pendientes para hoy cuya hora sea ≥ `notifyHour`.
   - Agrupa hasta **4 notificaciones individuales** por comprobación y una notificación resumen si hay más.
4. **Deep-link al pulsar (`notificationclick`):**
   - Enfoca una ventana abierta y envía `OPEN_DETAIL_FROM_NOTIFICATION`, o abre `./?open=<tipo>:<id_tmdb>` para abrir directamente la ficha del título.

### Limitaciones de plataforma (especialmente iOS/Safari)

- En **iPhone / iPad (iOS/iPadOS)** las notificaciones web solo están disponibles si el usuario **instala la PWA en la pantalla de inicio** (*Compartir → Añadir a pantalla de inicio*, iOS 16.4+).
- `Periodic Background Sync` no está soportado por todos los navegadores (p. ej. Safari); en esos casos las alertas pendientes del día se evalúan y muestran al abrir la PWA o cuando el navegador permite ejecución en primer/segundo plano.

---

## Cómo publicar un cambio de front (bump)

1. Edita HTML/CSS/JS.
2. En `sw.js`, incrementa el sufijo de versión (p. ej. `v0.112` → `v0.113`) en **ambas** constantes `STATIC_CACHE` y `DYNAMIC_CACHE`.
3. Si añades nuevos archivos al shell, agrégalos a `STATIC_FILES`.
4. Despliega y verifica que aparezca el banner de actualización al recargar una sesión instalada.

---

## Si quieres cambiar X, toca Y

| Cambio | Dónde |
|--------|--------|
| Versión de caché SW | `STATIC_CACHE` y `DYNAMIC_CACHE` en `sw.js` |
| Archivos cacheados offline | `STATIC_FILES` en `sw.js` |
| Texto, icono o límite de notificaciones | `checkAndShowDueNotifications` en `sw.js` |
| Construcción de agenda de estrenos | `syncNotificationScheduleWithSW` en `app.js` |
| Banner de update | `index.html` + `.tvst-sw-banner` en `styles.css` |

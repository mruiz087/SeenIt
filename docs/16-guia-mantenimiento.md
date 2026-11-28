# 16 — Guía de mantenimiento

← [15 Decisiones](15-decisiones-y-historial.md) · [Índice](README.md) · Siguiente: [17 Glosario](17-glosario.md)

---

## Propósito

Checklist práctico para evolucionar SeenIt sin romper sincronización, proxy TMDB, PWA ni timelines.

---

## Añadir una feature (plantilla)

1. **Datos:** ¿nuevo campo en movie/show/list/preferences? → añade normalización en `normalizeStored*` / `normalizePreferences` ([02](02-modelo-de-datos.md)).
2. **Mutación:** `touchUpdatedAt` → `saveLocalData` → `syncToDrive` (si conectado) y `syncNotificationScheduleWithSW` si afecta fechas de estreno.
3. **UI:** markup en `index.html` o render en `app.js` / `migration-service.js` + CSS `tvst-*`.
4. **Export `window.*`** si añades `onclick` en HTML ([14](14-api-global-window.md)).
5. **Invalidaciones:** timelines → `invalidateTimelineCaches`; temporadas → `clearSeasonDetailsCache` / `orderedEpisodesCache`.
6. **Chrome:** tras cambios de barras sticky → `scheduleSyncMobileChromeHeights`.
7. **SW bump** si cambias HTML/CSS/JS ([12](12-pwa-service-worker.md)).
8. **Docs y checks:** actualiza el doc correspondiente y ejecuta `npm run lint` y `npm run build`.

---

## Bump de Service Worker

```text
sw.js: seenit-static-v0.112  y  seenit-dynamic-v0.112  →  incrementar versión (p. ej. v0.113)
```

Incluye ficheros nuevos en `STATIC_FILES` si deben estar cacheados en el shell.

---

## Comandos locales y verificación

- **Arrancar servidor Node/Express (puerto 3000):**
  ```bash
  npm run dev   # o npm start (ejecuta node server.js en http://localhost:3000)
  ```
- **Validar sintaxis de todos los JS:**
  ```bash
  npm run lint  # node --check server.js app.js migration-service.js drive-service.js tmdb-service.js sw.js
  ```
- **Verificar build:**
  ```bash
  npm run build
  ```

Variables de entorno en `.env` (no commitear): `TMDB_API_KEY`, `GOOGLE_CLIENT_ID`, `PORT` (opcional, defecto `3000`).

---

## Debug sync y notificaciones

1. **Drive:** revisa en DevTools → Console logs `[Drive]` / `[App]` y en Application → Local Storage `seenit_drive_token`, `seenit_guest_mode`, `seenit_data__*`.
2. **IndexedDB:** revisa `seenit_local_db`, `seenit_tmdb_cache_db` y `seenit_notifications_db` (donde `sw.js` lee `schedule`).
3. **Merge raro:** compara `updatedAt` y `deleted*Ids` entre local y `tv_showtime_data.json` en Drive.
4. **Notificaciones:** usa el botón **Enviar notificación de prueba** en Ajustes y comprueba en DevTools → Application → Service Workers si el SW activo es `v0.112`+.

---

## Checklist de deploy (Node / Vercel)

- [ ] No hay `.env` ni `config.js` con secretos en git.
- [ ] `TMDB_API_KEY` y `GOOGLE_CLIENT_ID` configurados en las variables del entorno.
- [ ] Orígenes OAuth de Google Cloud incluyen el dominio desplegado (y `http://localhost:3000` en local).
- [ ] `vercel.json` enruta `/config.js`, `/api/tmdb/*` y `/api/tmdb-image` hacia `server.js`.
- [ ] `sw.js` bumpeado si cambió el shell (`seenit-static-v*`, `seenit-dynamic-v*`).
- [ ] `npm run lint` y `npm run build` sin errores.

---

## Traps frecuentes

| Trap | Qué hacer |
|------|-----------|
| Cambiar HTML/CSS/JS sin bump en `sw.js` | Usuarios instalados seguirán viendo la versión cacheada |
| Renombrar `DATA_FILE_NAME` (`tv_showtime_data.json`) | Las bibliotecas existentes en Drive dejarían de encontrarse |
| Añadir ruta TMDB sin actualizar `ALLOWED_TMDB_PATH_PATTERNS` | `server.js` devolverá `400 Endpoint TMDB no permitido` |
| `innerHTML` con `onclick` sin exportar a `window` | Botón muerto al hacer clic |
| Sticky sin medir alturas | Huecos o solapamiento bajo subnav/tabs |
| Cachear `/config.js` o `/api/*` en SW | Rompe rotación de config y respuestas proxy frescas |
| Usar `image.tmdb.org` directo en Canvas Wrapped | Bloqueo CORS (`tainted canvas`); usa `/api/tmdb-image` |

---

## Dónde mirar primero según síntoma

| Síntoma | Doc / archivo |
|---------|----------------|
| Login Google / Drive | [05](05-drive-oauth.md), `drive-service.js` |
| Persistencia local / merge | [03](03-persistencia-y-sync.md) |
| Proxy TMDB o imágenes | [04](04-tmdb.md), `server.js`, `tmdb-service.js` |
| Timeline / ancla / calendario | [07](07-timeline-series.md) |
| Import / Export / SeriesGuide | [11](11-import-export-tvtime.md), `migration-service.js` |
| SW / Caché / Notificaciones PWA | [12](12-pwa-service-worker.md), `sw.js` |
| Layout sticky / temas | [06](06-navegacion-y-layout.md), [13](13-ui-css-convenciones.md) |

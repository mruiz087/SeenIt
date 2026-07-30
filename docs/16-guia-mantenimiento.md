# 16 — Guía de mantenimiento

← [15 Decisiones](15-decisiones-y-historial.md) · [Índice](README.md) · Siguiente: [17 Glosario](17-glosario.md)

---

## Propósito

Checklist práctico para evolucionar SeenIt sin romper sync, PWA ni timelines.

---

## Añadir una feature (plantilla)

1. **Datos:** ¿nuevo campo en movie/show/list? → `normalizeStored*` + [02](02-modelo-de-datos.md). ¿Solo UI? no toques el blob.
2. **Mutación:** `touchUpdatedAt` → `saveLocalData` → `syncToDrive` (o flush).
3. **UI:** markup en `index.html` o string en `app.js` + CSS `tvst-*`.
4. **Export `window.*`** si hay `onclick` ([14](14-api-global-window.md)).
5. **Invalidaciones:** timelines → `invalidateTimelineCaches`; temporadas → `clearSeasonDetailsCache` / ordered cache.
6. **Chrome:** tras layout nuevo sticky → `scheduleSyncMobileChromeHeights`.
7. **SW bump** si cambias shell ([12](12-pwa-service-worker.md)).
8. **Docs:** actualiza el doc 07–13 correspondiente + una línea en [15](15-decisiones-y-historial.md) si hay decisión.

---

## Bump de Service Worker

```text
sw.js: seenit-static-vN  y  seenit-dynamic-vN  →  N+1
```

Incluye ficheros nuevos en `STATIC_FILES` si deben ir offline.

Prueba: deploy → abre app instalada → debe salir banner → Recargar → Network muestra JS nuevo.

---

## Debug sync

1. ¿Gate visible? Token / `origin_mismatch` / config ([05](05-drive-oauth.md)).
2. Consola: `[Drive]`, `[App] Datos sincronizados`.
3. Application → Local Storage: `seenit_data__*`, backup, token.
4. Drive web: ¿existe `tv_showtime_data.json`? ¿contenido JSON válido?
5. Merge raro: compara `updatedAt` y `deletedIds` local vs Drive.
6. Botón **Sincronizar** = pull+merge, no solo push.

---

## Checklist deploy (GitHub Pages)

- [ ] No hay `config.js` en git
- [ ] Secrets `TMDB_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_API_KEY` puestos
- [ ] Orígenes OAuth incluyen el origin de Pages
- [ ] Consent OAuth publicado (si usuarios externos)
- [ ] SW bumpeado si cambió el shell
- [ ] Workflow *Deploy GitHub Pages* OK; `site/` con `config.js` generado
- [ ] Prueba login + marcar episodio + recargar + otro dispositivo/perfil

Local: `config.example.js` → `config.js`, `python server.py`, `http://localhost:5500` en orígenes.

---

## Traps frecuentes

| Trap | Qué hacer |
|------|-----------|
| Cambiar HTML/JS sin bump SW | Usuarios ven versión vieja |
| Renombrar `DATA_FILE_NAME` | Bibliotecas “desaparecen” (fichero nuevo vacío) |
| Merge campo a campo sin tests | Progreso duplicado / perdido |
| `innerHTML` + onclick sin export | Click muerto |
| Sticky sin medir alturas | Hueco / contenido bajo barras |
| Asumir scroll en `window` | Timeline ancla mal |
| Cachear `config.js` cache-first | Keys viejas tras rotar secret |
| Serie “no aparece en pendiente” | Estado `pending` ≠ `watching` |
| Import TV Time sin backup | Difícil de deshacer; usa export JSON antes |
| Commitear capturas / JSON TV Time | Ruido y datos personales |

---

## Dónde mirar primero según síntoma

| Síntoma | Doc / archivo |
|---------|----------------|
| Login Google | [05](05-drive-oauth.md), `drive-service.js` |
| Datos que no persisten | [03](03-persistencia-y-sync.md) |
| Timeline / ancla | [07](07-timeline-series.md) |
| Filtros películas | [08](08-peliculas-y-filtros.md) |
| App vieja tras deploy | [12](12-pwa-service-worker.md) |
| Layout sticky | [06](06-navegacion-y-layout.md), [13](13-ui-css-convenciones.md) |
| TMDB 401 / vacío | [04](04-tmdb.md), secrets |

---

## Fuera de este repo (operación)

- Rotar TMDB key si hay abuso.
- Revisar cuotas Google Cloud.
- No pegar Client Secret en el frontend.

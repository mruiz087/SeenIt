# 12 — PWA y Service Worker

← [11 Import](11-import-export-tvtime.md) · [Índice](README.md) · Siguiente: [13 CSS](13-ui-css-convenciones.md)

---

## Propósito

SeenIt es instalable: `manifest.json` + iconos + `sw.js`. El SW cachea el **shell** para cargas rápidas y offline parcial; **no** sustituye Drive/localStorage para la biblioteca.

Versión actual de cachés: **`seenit-static-v52`** / **`seenit-dynamic-v52`**.

---

## Estrategias (`sw.js`)

| Recurso | Estrategia |
|---------|------------|
| Lista `STATIC_FILES` (html, css, app.js, servicios, iconos, manifest) | **Cache First** (+ revalidate en background vía `fetchAndCache`) |
| `config.js` | **Network First** (`NETWORK_FIRST_FILES`) — las claves deben poder rotar en deploy |
| TMDB, Google, Tailwind CDN | **Red directa** (sin cache SW) |
| Otros same-origin | Network First en dynamic cache |

Al activar una versión nueva: borra cachés que no sean las actuales + `clients.claim()`.

Mensaje `SKIP_WAITING` → `self.skipWaiting()` para activar el worker en espera.

---

## Banner de actualización

En `index.html` (script al final):

1. `navigator.serviceWorker.register('./sw.js')`.
2. Si hay `reg.waiting` (o `updatefound` → `installed` con controller previo) → muestra `#sw-update-banner`.
3. Botón **Recargar** → `postMessage({ type: 'SKIP_WAITING' })`.
4. `controllerchange` → `location.reload()`.
5. Timeout 800 ms: si no hubo controllerchange, `reload` igual.

CSS: `.tvst-sw-banner`, `z-index: 90`, por encima del bottom nav ([06](06-navegacion-y-layout.md)).

---

## Manifest e iconos

- `manifest.json` — name, `display`, `theme-color`, iconos 192/512 (+ maskable).
- Carpeta `icons/`.

Tras cambiar iconos, incluye los paths en `STATIC_FILES` y haz **bump de versión**.

---

## Cómo publicar un cambio de front (bump)

1. Edita HTML/CSS/JS.
2. En `sw.js`, sube el número: `v52` → `v53` en **ambas** constantes `STATIC_CACHE` y `DYNAMIC_CACHE`.
3. Deploy (Pages o local con hard refresh).
4. Los clientes con SW viejo verán el banner; al recargar cargan el shell nuevo.

Si **no** bumpeas, muchos usuarios seguirán con JS/CSS antiguos en cache-first.

---

## Qué no cachea el SW

- Biblioteca del usuario (localStorage / Drive).
- Respuestas TMDB (siempre red).
- Tokens OAuth (localStorage, no Cache API).

---

## Si quieres cambiar X, toca Y

| Cambio | Dónde |
|--------|--------|
| Añadir fichero al shell cacheado | `STATIC_FILES` + bump versión |
| Dejar de cachear un JS | Sacarlo de static / tratarlo como network-first |
| Texto/estilo del banner | `index.html` + `.tvst-sw-banner` |
| Forzar update en dev | DevTools → Application → Unregister SW / Bypass |

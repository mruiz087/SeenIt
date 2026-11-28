# 15 — Decisiones e historial

← [14 window API](14-api-global-window.md) · [Índice](README.md) · Siguiente: [16 Mantenimiento](16-guia-mantenimiento.md)

---

## Propósito

Registro del *por qué* de decisiones de producto y arquitectura, para no reintroducir problemas resueltos ni deshacer comportamientos intencionados.

---

## Producto

### Series nuevas en `pending`
Al añadir desde Explorar/detalle, la serie queda **Pendiente**, no Viendo. Solo entra en la lista pendiente cuando pasa a `watching` (p. ej. al marcar un episodio). Evita saturar el timeline con títulos guardados para más adelante.

### Continue vs stale (`inactivityDays`: 7 / 14 / 30 / 60)
Separa “lo que sigo activamente” de “lo que tengo aparcado”. Por defecto son 14 días, pero el usuario puede ajustarlo en Ajustes (`VALID_INACTIVITY_DAYS`). El campo `continueBoostAt` garantiza que una serie completada que recibe temporada nueva suba automáticamente a *Ver a continuación*.

### Episodios saltados (`capitulos_saltados`) y especiales
Permitir marcar episodios o temporadas como saltados resuelve series con especiales o capítulos que el usuario no quiere ver sin quedar atascado en la lista pendiente ni impedir el estado `completed`.

### Historial por scroll-up + ancla
En lugar de mezclar pasado y futuro en una sola lista descendente, el “ahora” es el ancla. Al entrar, el scroll se calcula por **contenido encima del ancla − offset sticky** para que el historial quede accesible arriba sin estorbar.

### Filtros multi-selección en películas + Mis suscripciones
Géneros y plataformas admiten selección múltiple, junto a búsqueda rápida, ordenación, slider de duración en modo *live* (no reconstruye el panel mientras se arrastra) y filtro por suscripciones configuradas.

### Ajustes como pestaña principal + subpestañas colapsables
Sacar **Ajustes** de Perfil a su propia pestaña en el nav inferior deja 4 subpestañas limpias en Perfil (`Series`, `Películas`, `Selector`, `Logros`). En **Funcionamiento** y **Legal y datos**, las secciones usan `<details>` colapsables cerrados por defecto para evitar muros de texto en móvil.

### Selector compacto con modal de resultado (`#selector-winner-modal`)
En **Perfil → Selector**, la configuración (filtros, buscador y candidatas) va arriba y al pulsar **Elegir al azar** se abre un modal dedicado (`#selector-winner-modal`) en lugar de un toast efímero o tarjeta gigante fija, permitiendo abrir ficha, volver a girar o descartar en un toque.

---

## Técnica

### Proxy TMDB en `server.js` + `/api/tmdb-image`
Mover las peticiones TMDB a `server.js` (`/api/tmdb/*`) evita exponer `TMDB_API_KEY` en el cliente, añade caché LRU en servidor (600 entradas) y deduplicación *in-flight*. `/api/tmdb-image` sirve imágenes TMDB con CORS abierto para que **Wrapped Studio** pueda dibujar pósters y backdrops en Canvas 2D sin *tainted canvas*.

### Drive opcional (`continueWithoutDrive`) + IndexedDB
Permitir entrar sin cuenta de Google reduce la fricción inicial (y evita bloqueos si falta configurar OAuth). `localStorage` mantiene el arranque síncrono y `IndexedDB` (`seenit_local_db` + `seenit_tmdb_cache_db`) evita alcanzar el límite de ~5 MB de `localStorage` en bibliotecas grandes.

### `migration-service.js` unificado + SeriesGuide (2 archivos)
Sustituye al antiguo `tvtime-import.js` con un único asistente de importación (SeenIt, SeriesGuide, Trakt, Letterboxd, IMDb, TV Time, CSV/JSON personalizado) y un modal de exportación dedicado. Para **SeriesGuide**, se generan 2 JSON compatibles (`seriesguide-shows-*.json` y `seriesguide-movies-*.json`) siguiendo el formato oficial de exportación de la app.

### Notificaciones PWA locales y en segundo plano (sin VAPID)
Como SeenIt no tiene base de datos central ni backend con tareas cron de usuarios, las notificaciones se programan en el dispositivo mediante `IndexedDB` (`seenit_notifications_db`) + `Service Worker` (`periodicsync` y comprobación al abrir). Esto mantiene coste 0, privacidad total y cero infraestructura push, asumiendo las limitaciones de ejecución en segundo plano de cada navegador/iOS.

### LWW de documento completo + tombstones
En sincronización con Drive (`tv_showtime_data.json`), gana el `updatedAt` más reciente de cada ítem completo y se usan tombstones (`deleted*Ids`) para propagar borrados entre dispositivos sin resucitar títulos.

### `config.js` y `/api/*` fuera de caché SW
El Service Worker nunca cachea `/config.js` ni `/api/*`, permitiendo rotar variables de entorno o proxy sin quedar atrapado en caché offline.

---

## Cosas que parecen bugs y no lo son

| Observación | Explicación |
|-------------|-------------|
| Serie añadida no sale en Lista pendiente | Entra en `pending`; marca un episodio o cámbiala a `watching` |
| Tras marcar visto, el ancla no “salta” al historial | Se mantiene el ancla en *Ver a continuación*; el historial suma filas arriba |
| Fichero Drive se llama `tv_showtime_data.json` | Nombre histórico mantenido para no romper bibliotecas existentes |
| En iPhone no llegan avisos sin instalar | iOS exige añadir la PWA a pantalla de inicio para habilitar Web Notifications |

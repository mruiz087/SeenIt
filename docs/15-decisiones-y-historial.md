# 15 — Decisiones e historial

← [14 window API](14-api-global-window.md) · [Índice](README.md) · Siguiente: [16 Mantenimiento](16-guia-mantenimiento.md)

---

## Propósito

Registro del *por qué* de decisiones de producto y técnicas recientes, para no reintroducir bugs ya cerrados ni “arreglar” comportamientos intencionados.

---

## Producto

### Series nuevas en `pending`
Al añadir desde Explorar/detalle, la serie queda **Pendiente**, no Viendo. Solo entra en la lista pendiente de episodios cuando pasa a `watching` (p.ej. al marcar un episodio). Evita ensuciar el timeline con títulos “para más adelante”.

### Continue vs stale (14 días)
Separa “lo que estoy viendo ahora” de “lo tengo a medias pero abandoné un tiempo”. El boost por temporada nueva evita que un estreno quede enterrado en stale.

### `continueBoostAt` (no solo actividad de visionado)
Una temporada nueva no implica episodio marcado. Sin boost, `isShowInContinueSection` la mandaría a stale. El campo ISO ≤14 días fuerza continue + toast al reabrir completed→watching.

### Historial por scroll-up + ancla
En lugar de una lista plana infinito-hacia-abajo, el “ahora” es el ancla. El historial se descubre tirando hacia arriba; al entrar, el scroll se calcula por **contenido encima del ancla − offset sticky**, no solo `scrollIntoView` ingenuo (fallaba con sticky).

### Filtros de películas colapsables
Género + plataforma + duración sin ocupar siempre viewport. Slider en modo **live** solo re-filtra el grid (si se re-renderiza el panel entero, el range input pierde el gesto).

### Providers featured + Otros
TMDB devuelve decenas de nombres casi duplicados. Canonicalizar a una lista corta mejora UX; **Otros** cubre el long-tail sin 40 chips.

### Crítica personal
Nota numérica no basta para recuerdo cualitativo. Flujo Añadir → Guardar → Modificar reduce edición accidental.

### Badge de estado en hero
El estado de *usuario* debe verse sin abrir menús; colores coherentes con progreso.

---

## Técnica

### Sin backend / Drive `drive.file`
Cada usuario es su propio backend. Scope mínimo. Fichero único `tv_showtime_data.json` (nombre histórico; no renombrar a la ligera).

### LWW de documento completo
Unir a ciegas `capitulos_vistos` de dos forks produce inconsistencias difíciles. Gana el `updatedAt` más nuevo del ítem entero + tombstones para borrados.

### Debounce 2 s + flush on hide
Equilibrio entre escrituras Drive y no perder datos al cerrar la pestaña.

### Medir chrome siempre (también desktop)
Sticky gaps no son solo un bug móvil; `syncMobileChromeHeights` escribe vars en todos los viewports.

### Sticky `top: calc(var − 2px)` + sombra
Compensa el borde de 1px del subnav que dejaba una línea de contenido “escapando”.

### SW cache-first + banner (coexiste con bottom nav)
Tras deploys, usuarios instalados no ven cambios sin bump + UI de recarga. El banner debe quedar **sobre** el nav (`z-index: 90`) y el reload forzar tras `SKIP_WAITING`.

### `config.js` network-first
Permite rotar secrets en CI sin quedar atrapado en cache del shell.

### Cerrar modales al `switchTab`
Evita detalle “fantasma” sobre otra sección y estados de scroll raros.

### Concurrencia limitada en timelines
`mapPool` / `TIMELINE_FETCH_CONCURRENCY` protege rate limits TMDB al abrir la lista pendiente.

---

## Cosas que parecen bugs y no lo son

| Observación | Explicación |
|-------------|-------------|
| Serie añadida no sale en Lista pendiente | Está en `pending`; marca un episodio o cambia a Viendo |
| Tras marcar visto, el ancla “no se mueve al historial” | Se mantiene ancla en continue a propósito; historial gana ≥1 fila |
| Slider de duración no “reinicia” chips | Live path intencional |
| Fichero Drive no se llama `seenit-data.json` | Nombre real `tv_showtime_data.json` |

---

## Si documentas una decisión nueva

Añade aquí: problema → alternativas → decisión → ficheros tocados. Enlaza desde el doc de feature.

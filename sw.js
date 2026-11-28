/**
 * Service Worker - SeenIt PWA
 *
 * - Shell estático: Cache First (match exacto)
 * - config.js y /api/*: siempre red directa sin persistir en caché
 * - APIs externas: red directa
 */

const STATIC_CACHE = 'seenit-static-v0.112';
const DYNAMIC_CACHE = 'seenit-dynamic-v0.112';

const STATIC_FILES = [
    './',
    './index.html',
    './manifest.json',
    './styles.css',
    './app.js',
    './migration-service.js',
    './drive-service.js',
    './tmdb-service.js',
    './icons/icon.svg',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/icon-maskable-192.png',
    './icons/icon-maskable-512.png',
];

const NETWORK_ONLY_FILES = new Set([
    'config.js',
]);

function normalizePathname(pathname) {
    return pathname.replace(/^\//, '').replace(/\/$/, '') || '';
}

function isExactStaticFile(pathname) {
    const path = normalizePathname(pathname);
    return STATIC_FILES.some((file) => {
        const normalizedFile = file.replace(/^\.\//, '').replace(/\/$/, '');
        if (normalizedFile === '') {
            return path === '' || path === 'index.html';
        }
        return normalizedFile === path;
    });
}

function isNetworkOnlyPath(pathname) {
    const normalized = normalizePathname(pathname);
    return NETWORK_ONLY_FILES.has(normalized) || normalized.startsWith('api/');
}

self.addEventListener('install', (event) => {
    console.log('[SW] Instalando Service Worker...');
    event.waitUntil(
        caches.open(STATIC_CACHE)
            .then(async (cache) => {
                await Promise.all(
                    STATIC_FILES.map(async (file) => {
                        try {
                            await cache.add(file);
                        } catch (error) {
                            console.warn('[SW] No se pudo cachear', file, error);
                        }
                    }),
                );
                return self.skipWaiting();
            })
            .catch((error) => {
                console.error('[SW] Error durante instalación:', error);
            }),
    );
});

self.addEventListener('activate', (event) => {
    console.log('[SW] Activando Service Worker...');
    event.waitUntil(
        Promise.all([
            caches.keys().then((cacheNames) => Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== STATIC_CACHE && cacheName !== DYNAMIC_CACHE) {
                        console.log('[SW] Eliminando caché antigua:', cacheName);
                        return caches.delete(cacheName);
                    }
                    return undefined;
                }),
            )),
            self.clients.claim(),
        ]),
    );
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    const pathname = url.pathname;

    if (event.request.method !== 'GET') {
        return;
    }

    if (url.origin.includes('api.themoviedb.org')
        || url.origin.includes('image.tmdb.org')
        || url.origin.includes('googleapis.com')
        || url.origin.includes('accounts.google.com')
        || url.origin.includes('cdn.tailwindcss.com')) {
        event.respondWith(fetch(event.request));
        return;
    }

    if (url.origin !== self.location.origin) {
        return;
    }

    if (isNetworkOnlyPath(pathname)) {
        event.respondWith(
            fetch(event.request, { cache: 'no-store' }).catch(() => (
                new Response(
                    JSON.stringify({ error: 'Offline' }),
                    { status: 503, statusText: 'Service Unavailable', headers: { 'Content-Type': 'application/json' } },
                )
            )),
        );
        return;
    }

    if (isExactStaticFile(pathname)) {
        event.respondWith(cacheFirstStrategy(event.request, STATIC_CACHE));
        return;
    }

    event.respondWith(networkFirstStrategy(event.request, DYNAMIC_CACHE));
});

async function cacheFirstStrategy(request, cacheName) {
    try {
        const cachedResponse = await caches.match(request);
        if (cachedResponse) {
            fetchAndCache(request, cacheName).catch(() => {});
            return cachedResponse;
        }
        return await fetchAndCache(request, cacheName);
    } catch (error) {
        console.error('[SW] Cache First error:', error);
        const cachedResponse = await caches.match(request);
        if (cachedResponse) return cachedResponse;
        return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
    }
}

async function networkFirstStrategy(request, cacheName) {
    try {
        const networkResponse = await fetch(request);
        if (networkResponse && networkResponse.ok) {
            const cache = await caches.open(cacheName);
            cache.put(request, networkResponse.clone());
        }
        return networkResponse;
    } catch (error) {
        const cachedResponse = await caches.match(request);
        if (cachedResponse) return cachedResponse;
        return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
    }
}

async function fetchAndCache(request, cacheName) {
    const response = await fetch(request);
    if (response && response.ok) {
        const cache = await caches.open(cacheName);
        cache.put(request, response.clone());
    }
    return response;
}

// ============================================
// NOTIFICACIONES PWA LOCALES Y SEGUNDO PLANO
// ============================================

const NOTIF_DB_NAME = 'seenit_notifications_db';
const NOTIF_DB_VERSION = 1;
const NOTIF_STORE = 'state';
const NOTIF_SCHEDULE_KEY = 'schedule';

function openNotifDb() {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('IndexedDB no disponible'));
            return;
        }
        const req = indexedDB.open(NOTIF_DB_NAME, NOTIF_DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(NOTIF_STORE)) {
                db.createObjectStore(NOTIF_STORE);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function readNotifSchedule() {
    try {
        const db = await openNotifDb();
        return await new Promise((resolve) => {
            const tx = db.transaction(NOTIF_STORE, 'readonly');
            const req = tx.objectStore(NOTIF_STORE).get(NOTIF_SCHEDULE_KEY);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        });
    } catch (_) {
        return null;
    }
}

async function writeNotifSchedule(schedule) {
    try {
        const db = await openNotifDb();
        await new Promise((resolve) => {
            const tx = db.transaction(NOTIF_STORE, 'readwrite');
            tx.objectStore(NOTIF_STORE).put(schedule, NOTIF_SCHEDULE_KEY);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
    } catch (_) {
        /* ignore */
    }
}

function getLocalDateKey(dateObj = new Date()) {
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const d = String(dateObj.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function getCurrentTimeHHMM(dateObj = new Date()) {
    const hh = String(dateObj.getHours()).padStart(2, '0');
    const mm = String(dateObj.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
}

async function checkAndShowDueNotifications({ forceIgnoreHour = false } = {}) {
    if (!self.registration || typeof self.registration.showNotification !== 'function') {
        return 0;
    }
    const schedule = await readNotifSchedule();
    if (!schedule || !schedule.enabled) return 0;

    const now = new Date();
    const todayKey = getLocalDateKey(now);
    const preferredHour = typeof schedule.notifyHour === 'string' && /^\d{2}:\d{2}$/.test(schedule.notifyHour)
        ? schedule.notifyHour
        : '10:00';

    if (!forceIgnoreHour && getCurrentTimeHHMM(now) < preferredHour) {
        return 0;
    }

    const items = Array.isArray(schedule.items) ? schedule.items : [];
    const sentSet = new Set(Array.isArray(schedule.sentKeys) ? schedule.sentKeys : []);

    const due = items.filter((item) => {
        if (!item || item.date !== todayKey || !item.key) return false;
        if (sentSet.has(item.key)) return false;
        if (item.kind === 'tv' && schedule.notifyEpisodeReleases === false) return false;
        if (item.kind === 'movie' && schedule.notifyMovieReleases === false) return false;
        return true;
    });

    if (!due.length) return 0;

    const maxIndividual = 4;
    const toDisplay = due.slice(0, maxIndividual);
    for (const item of toDisplay) {
        const isShow = item.kind === 'tv';
        const title = isShow
            ? `Nuevo episodio hoy · ${item.title}`
            : `Estreno hoy · ${item.title}`;
        const body = isShow
            ? (item.subtitle || 'Nuevo episodio disponible hoy.')
            : (item.subtitle || 'Tu película pendiente se estrena hoy.');
        await self.registration.showNotification(title, {
            body,
            icon: './icons/icon-192.png',
            badge: './icons/icon-192.png',
            tag: `seenit-${item.key}`,
            data: {
                tipo: isShow ? 'tv' : 'movie',
                id_tmdb: Number(item.id_tmdb) || 0,
                key: item.key,
            },
        });
    }

    if (due.length > maxIndividual) {
        const extra = due.length - maxIndividual;
        await self.registration.showNotification(`+${extra} estreno(s) más hoy en SeenIt`, {
            body: 'Abre SeenIt para consultar tu calendario de Próximamente.',
            icon: './icons/icon-192.png',
            badge: './icons/icon-192.png',
            tag: `seenit-summary-${todayKey}`,
            data: {
                tipo: due[maxIndividual]?.kind === 'tv' ? 'tv' : 'movie',
                id_tmdb: Number(due[maxIndividual]?.id_tmdb) || 0,
            },
        });
    }

    for (const item of due) {
        sentSet.add(item.key);
    }
    const trimmedSent = [...sentSet].slice(-250);
    await writeNotifSchedule({
        ...schedule,
        sentKeys: trimmedSent,
        lastCheckedAt: now.toISOString(),
    });

    const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    windowClients.forEach((client) => {
        client.postMessage({ type: 'NOTIF_SENT_KEYS_UPDATED', sentKeys: trimmedSent });
    });

    return due.length;
}

self.addEventListener('periodicsync', (event) => {
    if (event.tag === 'seenit-release-check') {
        event.waitUntil(checkAndShowDueNotifications({ forceIgnoreHour: false }));
    }
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const data = event.notification?.data || {};
    const tipo = data.tipo === 'movie' ? 'movie' : (data.tipo === 'tv' ? 'tv' : '');
    const idTmdb = Number(data.id_tmdb) || 0;
    const openParam = tipo && idTmdb ? `?open=${tipo}:${idTmdb}` : './';

    event.waitUntil((async () => {
        const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of windowClients) {
            if ('focus' in client) {
                await client.focus();
                if (tipo && idTmdb) {
                    client.postMessage({ type: 'OPEN_DETAIL_FROM_NOTIFICATION', tipo, id_tmdb: idTmdb });
                }
                return;
            }
        }
        if (self.clients.openWindow) {
            await self.clients.openWindow(tipo && idTmdb ? `./${openParam}` : './');
        }
    })());
});

self.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'SKIP_WAITING') {
        self.skipWaiting();
        return;
    }
    if (msg.type === 'SYNC_NOTIF_SCHEDULE' && msg.payload) {
        event.waitUntil((async () => {
            const existing = await readNotifSchedule();
            const mergedSent = [...new Set([
                ...(Array.isArray(existing?.sentKeys) ? existing.sentKeys : []),
                ...(Array.isArray(msg.payload.sentKeys) ? msg.payload.sentKeys : []),
            ])].slice(-250);
            await writeNotifSchedule({
                ...msg.payload,
                sentKeys: mergedSent,
            });
            if (msg.checkNow) {
                await checkAndShowDueNotifications({ forceIgnoreHour: Boolean(msg.forceIgnoreHour) });
            }
        })());
        return;
    }
    if (msg.type === 'CHECK_NOTIFICATIONS_NOW') {
        event.waitUntil(checkAndShowDueNotifications({ forceIgnoreHour: Boolean(msg.forceIgnoreHour) }));
        return;
    }
    if (msg.type === 'SEND_TEST_NOTIFICATION') {
        event.waitUntil(
            self.registration.showNotification('SeenIt · Avisos activos', {
                body: 'Tus notificaciones de estrenos de series y películas funcionan correctamente.',
                icon: './icons/icon-192.png',
                badge: './icons/icon-192.png',
                tag: 'seenit-test-notification',
                data: { tipo: '', id_tmdb: 0 },
            }),
        );
    }
});

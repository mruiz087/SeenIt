/**
 * Service Worker - SeenIt PWA
 *
 * - Shell estático: Cache First (match exacto)
 * - config.js: Network First (nunca cache-first)
 * - APIs externas: red directa
 */

const STATIC_CACHE = 'seenit-static-v30';
const DYNAMIC_CACHE = 'seenit-dynamic-v30';

const STATIC_FILES = [
    './',
    './index.html',
    './manifest.json',
    './styles.css',
    './app.js',
    './drive-service.js',
    './tmdb-service.js',
    './tvtime-import.js',
    './icons/icon.svg',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/icon-maskable-192.png',
    './icons/icon-maskable-512.png',
];

const NETWORK_FIRST_FILES = new Set([
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

function isNetworkFirstFile(pathname) {
    return NETWORK_FIRST_FILES.has(normalizePathname(pathname));
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

    if (isNetworkFirstFile(pathname)) {
        event.respondWith(networkFirstStrategy(event.request, DYNAMIC_CACHE));
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
            fetchAndCache(request, cacheName);
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

self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

/**
 * Service Worker - SeenIt PWA
 * 
 * Este Service Worker implementa una estrategia de caché para que la aplicación
 * funcione offline y cargue instantáneamente.
 * 
 * Estrategia:
 * - Archivos locales: Cache First (cargar desde caché, actualizar en background)
 * - Recursos externos (TMDB, Google APIs): Network First (intentar red, fallback a caché)
 * 
 * La app funcionará completamente offline excepto para:
 * - Búsqueda en TMDB
 * - Sincronización con Google Drive
 */

const STATIC_CACHE = 'seenit-static-v22';
const DYNAMIC_CACHE = 'seenit-dynamic-v22';

// Archivos estáticos que se cachearán al instalar
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

// ============================================
// INSTALACIÓN
// ============================================

self.addEventListener('install', (event) => {
    console.log('[SW] Instalando Service Worker...');
    
    event.waitUntil(
        caches.open(STATIC_CACHE)
            .then((cache) => {
                console.log('[SW] Caché abierta, añadiendo archivos estáticos');
                return cache.addAll(STATIC_FILES);
            })
            .then(() => {
                console.log('[SW] Archivos estáticos cacheados');
                // Forzar activación inmediata
                return self.skipWaiting();
            })
            .catch((error) => {
                console.error('[SW] Error durante instalación:', error);
            })
    );
});

// ============================================
// ACTIVACIÓN
// ============================================

self.addEventListener('activate', (event) => {
    console.log('[SW] Activando Service Worker...');
    
    event.waitUntil(
        Promise.all([
            // Limpiar cachés antiguos
            caches.keys().then((cacheNames) => {
                return Promise.all(
                    cacheNames.map((cacheName) => {
                        if (cacheName !== STATIC_CACHE && cacheName !== DYNAMIC_CACHE) {
                            console.log('[SW] Eliminando caché antigua:', cacheName);
                            return caches.delete(cacheName);
                        }
                    })
                );
            }),
            // Tomar control de todas las páginas
            self.clients.claim(),
        ])
    );
});

// ============================================
// FETCH - ESTRATEGIA DE CACHÉ
// ============================================

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    const pathname = url.pathname.replace(/^\//, ''); // Remover slash inicial
    
    // Ignorar peticiones no GET
    if (event.request.method !== 'GET') {
        return;
    }
    
    // Ignorar peticiones a otras APIs (TMDB, Google, etc.) y recursos de imagen externos
    if (url.origin.includes('api.themoviedb.org') || 
        url.origin.includes('image.tmdb.org') ||
        url.origin.includes('googleapis.com') ||
        url.origin.includes('accounts.google.com') ||
        url.origin.includes('cdn.tailwindcss.com')) {
        event.respondWith(fetch(event.request));
        return;
    }
    
    // Estrategia para archivos estáticos locales
    // Verificar si es una ruta estática o raíz
    const isStaticFile = STATIC_FILES.some(file => {
        const normalizedFile = file.replace(/^\.\//, '');
        return normalizedFile === '' || normalizedFile === pathname || 
               pathname === '' || pathname === 'index.html';
    });
    
    if (isStaticFile) {
        event.respondWith(
            cacheFirstStrategy(event.request, STATIC_CACHE)
        );
        return;
    }
    
    // Para cualquier otro recurso, usar Network First
    event.respondWith(
        networkFirstStrategy(event.request, DYNAMIC_CACHE)
    );
});

// ============================================
// ESTRATEGIAS DE CACHÉ
// ============================================

/**
 * Estrategia Cache First
 * Intenta obtener desde caché primero, si no existe va a la red
 * Ideal para archivos estáticos que no cambian frecuentemente
 */
async function cacheFirstStrategy(request, cacheName) {
    try {
        // Intentar obtener desde caché
        const cachedResponse = await caches.match(request);
        
        if (cachedResponse) {
            // Actualizar en background
            fetchAndCache(request, cacheName);
            return cachedResponse;
        }
        
        // Si no está en caché, ir a la red
        const networkResponse = await fetch(request);
        
        if (networkResponse && networkResponse.status === 200) {
            const cache = await caches.open(cacheName);
            cache.put(request, networkResponse.clone());
        }
        
        return networkResponse;
    } catch (error) {
        console.error('[SW] Error en Cache First:', error);
        throw error;
    }
}

/**
 * Estrategia Network First
 * Intenta obtener desde la red primero, si falla usa caché
 * Ideal para contenido dinámico y APIs
 */
async function networkFirstStrategy(request, cacheName) {
    try {
        // Intentar obtener desde la red
        const networkResponse = await fetch(request);
        
        if (networkResponse && networkResponse.status === 200) {
            // Guardar en caché para uso offline
            const cache = await caches.open(cacheName);
            cache.put(request, networkResponse.clone());
        }
        
        return networkResponse;
    } catch (error) {
        console.log('[SW] Red no disponible, usando caché');
        
        // Si la red falla, intentar desde caché
        try {
            const cachedResponse = await caches.match(request);
            if (cachedResponse) {
                return cachedResponse;
            }
        } catch (cacheError) {
            console.log('[SW] Error accediendo caché:', cacheError);
        }
        
        // Si no hay caché, devolver error pero NO generar respuesta 503
        // Dejar que el navegador maneje el error naturalmente
        console.log('[SW] Sin caché disponible para:', request.url);
        throw error;
    }
}

/**
 * Fetch y cache en background (no bloquea)
 */
function fetchAndCache(request, cacheName) {
    fetch(request)
        .then((response) => {
            if (response && response.status === 200) {
                caches.open(cacheName).then((cache) => {
                    cache.put(request, response);
                });
            }
        })
        .catch((error) => {
            console.log('[SW] Error actualizando caché en background:', error);
        });
}

// ============================================
// MENSAJES
// ============================================

self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
    
    if (event.data && event.data.type === 'CLEAR_CACHE') {
        event.waitUntil(
            caches.keys().then((cacheNames) => {
                return Promise.all(
                    cacheNames.map((cacheName) => caches.delete(cacheName))
                );
            })
        );
    }
});

// ============================================
// SYNC BACKGROUND (para futuras mejoras)
// ============================================

self.addEventListener('sync', (event) => {
    console.log('[SW] Background sync:', event.tag);
    
    if (event.tag === 'sync-drive') {
        event.waitUntil(
            // Aquí se implementaría la sincronización con Drive
            Promise.resolve()
        );
    }
});

// ============================================
// PUSH NOTIFICATIONS (para futuras mejoras)
// ============================================

self.addEventListener('push', (event) => {
    console.log('[SW] Push notification recibida');
    
    const options = {
        body: event.data ? event.data.text() : 'Nueva notificación',
        icon: '/data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="%236366f1"/><text y=".9em" font-size="60" text-anchor="middle" x="50">📺</text></svg>',
        badge: '/data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="%236366f1"/><text y=".9em" font-size="60" text-anchor="middle" x="50">📺</text></svg>',
    };
    
    event.waitUntil(
        self.registration.showNotification('SeenIt', options)
    );
});

console.log('[SW] Service Worker cargado');

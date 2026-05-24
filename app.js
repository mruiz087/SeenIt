/**
 * App - Lógica Principal de SeenIt
 * 
 * Este archivo maneja toda la lógica de la aplicación:
 * - Gestión de estado local
 * - Conexión de eventos de la interfaz
 * - Renderizado de contenido
 * - Sincronización con Google Drive
 */

// ============================================
// ESTADO GLOBAL
// ============================================

const AppState = {
    movies: [],
    shows: [],
    currentTab: 'following',
    currentFilter: 'all',
    selectedItem: null,
    isDriveConnected: false,
    isSyncing: false,
    expandedSeasons: {}, // Guardar qué temporadas están expandidas
};

// ============================================
// INICIALIZACIÓN
// ============================================

/**
 * Inicializa la aplicación
 */
async function initApp() {
    console.log('[App] Inicializando aplicación...');
    
    // Cargar datos locales
    loadLocalData();
    
    // Inicializar servicio de Drive
    try {
        await initDriveService();
        console.log('[App] Drive service inicializado');
    } catch (error) {
        console.warn('[App] No se pudo inicializar Drive service:', error);
    }
    
    // Renderizar contenido inicial
    renderFollowing();
    
    // Configurar eventos
    setupEventListeners();
    
    console.log('[App] Aplicación inicializada');
}

/**
 * Carga datos desde localStorage
 */
function loadLocalData() {
    try {
        const savedData = localStorage.getItem('seenit_data');
        if (savedData) {
            const data = JSON.parse(savedData);
            AppState.movies = data.movies || [];
            AppState.shows = data.shows || [];
            console.log('[App] Datos locales cargados');
        }
    } catch (error) {
        console.error('[App] Error cargando datos locales:', error);
    }
}

/**
 * Guarda datos en localStorage
 */
function saveLocalData() {
    try {
        const data = {
            movies: AppState.movies,
            shows: AppState.shows,
        };
        localStorage.setItem('seenit_data', JSON.stringify(data));
    } catch (error) {
        console.error('[App] Error guardando datos locales:', error);
    }
}

// ============================================
// GESTIÓN DE ESTADO
// ============================================

/**
 * Añade una película a la lista
 * @param {Object} movie - Datos de la película
 */
async function addMovie(movie) {
    // Verificar si ya existe
    const exists = AppState.movies.find(m => m.id_tmdb === movie.id_tmdb);
    if (exists) {
        showToast('Esta película ya está en tu lista');
        return;
    }
    
    // Obtener detalles completos
    try {
        const details = await getMovieDetails(movie.id_tmdb);
        AppState.movies.push(details);
        saveLocalData();
        syncToDrive();
        renderFollowing();
        showToast('Película añadida');
    } catch (error) {
        console.error('[App] Error añadiendo película:', error);
        showToast('Error al añadir película');
    }
}

/**
 * Añade una serie a la lista
 * @param {Object} show - Datos de la serie
 */
async function addShow(show) {
    // Verificar si ya existe
    const exists = AppState.shows.find(s => s.id_tmdb === show.id_tmdb);
    if (exists) {
        showToast('Esta serie ya está en tu lista');
        return;
    }
    
    // Obtener detalles completos
    try {
        const details = await getTVDetails(show.id_tmdb);
        AppState.shows.push(details);
        saveLocalData();
        syncToDrive();
        renderFollowing();
        showToast('Serie añadida');
    } catch (error) {
        console.error('[App] Error añadiendo serie:', error);
        showToast('Error al añadir serie');
    }
}

/**
 * Elimina una película de la lista
 * @param {number} id_tmdb - ID de TMDB
 */
function removeMovie(id_tmdb) {
    AppState.movies = AppState.movies.filter(m => m.id_tmdb !== id_tmdb);
    saveLocalData();
    syncToDrive();
    renderFollowing();
    showToast('Película eliminada');
}

/**
 * Elimina una serie de la lista
 * @param {number} id_tmdb - ID de TMDB
 */
function removeShow(id_tmdb) {
    AppState.shows = AppState.shows.filter(s => s.id_tmdb !== id_tmdb);
    saveLocalData();
    syncToDrive();
    renderFollowing();
    showToast('Serie eliminada');
}

/**
 * Actualiza la puntuación de un item
 * @param {string} type - 'movie' o 'tv'
 * @param {number} id_tmdb - ID de TMDB
 * @param {number} rating - Puntuación (0-10)
 */
function updateRating(type, id_tmdb, rating) {
    if (type === 'movie') {
        const movie = AppState.movies.find(m => m.id_tmdb === id_tmdb);
        if (movie) {
            movie.puntuacion = rating;
        }
    } else if (type === 'tv') {
        const show = AppState.shows.find(s => s.id_tmdb === id_tmdb);
        if (show) {
            show.puntuacion = rating;
        }
    }
    saveLocalData();
    syncToDrive();
}

/**
 * Actualiza el estado de un item
 * @param {string} type - 'movie' o 'tv'
 * @param {number} id_tmdb - ID de TMDB
 * @param {string} status - Estado (pendiente, viendo, completado, etc.)
 */
function updateStatus(type, id_tmdb, status) {
    if (type === 'movie') {
        const movie = AppState.movies.find(m => m.id_tmdb === id_tmdb);
        if (movie) {
            movie.estado = status;
        }
    } else if (type === 'tv') {
        const show = AppState.shows.find(s => s.id_tmdb === id_tmdb);
        if (show) {
            show.estado = status;
        }
    }
    saveLocalData();
    syncToDrive();
    renderFollowing();
}

/**
 * Marca un episodio como visto
 * @param {number} id_tmdb - ID de TMDB de la serie
 * @param {string} episode - Formato "S01E01"
 */
function toggleEpisode(id_tmdb, episode) {
    const show = AppState.shows.find(s => s.id_tmdb === id_tmdb);
    if (!show) return;
    
    if (!show.capitulos_vistos) {
        show.capitulos_vistos = [];
    }
    
    const index = show.capitulos_vistos.indexOf(episode);
    if (index > -1) {
        show.capitulos_vistos.splice(index, 1);
    } else {
        show.capitulos_vistos.push(episode);
    }
    
    saveLocalData();
    syncToDrive();
    renderEpisodes(show);
}



// ============================================
// SINCRONIZACIÓN CON DRIVE
// ============================================

/**
 * Sincroniza datos con Google Drive en segundo plano
 */
async function syncToDrive() {
    if (!isAuthenticated() || AppState.isSyncing) {
        return;
    }
    
    AppState.isSyncing = true;
    
    try {
        const data = {
            movies: AppState.movies,
            shows: AppState.shows,
        };
        await saveUserData(data);
        console.log('[App] Datos sincronizados con Drive');
    } catch (error) {
        console.error('[App] Error sincronizando con Drive:', error);
    } finally {
        AppState.isSyncing = false;
    }
}

/**
 * Carga datos desde Google Drive
 */
async function loadFromDrive() {
    if (!isAuthenticated()) {
        showToast('Primero conecta Google Drive');
        return;
    }
    
    showLoading(true);
    
    try {
        const data = await loadUserData();
        AppState.movies = data.movies || [];
        AppState.shows = data.shows || [];
        saveLocalData();
        renderFollowing();
        updateDriveStatus(true);
        showToast('Datos sincronizados desde Drive');
    } catch (error) {
        console.error('[App] Error cargando desde Drive:', error);
        showToast('Error al cargar datos desde Drive');
    } finally {
        showLoading(false);
    }
}

// ============================================
// NAVEGACIÓN
// ============================================

/**
 * Cambia entre pestañas
 * @param {string} tab - Nombre de la pestaña
 */
function switchTab(tab) {
    AppState.currentTab = tab;
    
    // Ocultar todo el contenido
    document.querySelectorAll('.tab-content').forEach(el => {
        el.classList.add('hidden');
    });
    
    // Mostrar contenido seleccionado
    document.getElementById(`content-${tab}`).classList.remove('hidden');
    
    // Actualizar estilos de pestañas desktop
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('border-primary', 'text-primary');
        btn.classList.add('border-transparent', 'text-gray-500', 'dark:text-gray-400');
    });
    document.getElementById(`tab-${tab}`).classList.remove('border-transparent', 'text-gray-500', 'dark:text-gray-400');
    document.getElementById(`tab-${tab}`).classList.add('border-primary', 'text-primary');
    
    // Actualizar estilos de pestañas móvil
    document.querySelectorAll('.mobile-tab-btn').forEach(btn => {
        btn.classList.remove('text-primary');
        btn.classList.add('text-gray-500');
    });
    document.querySelector(`.mobile-tab-btn[data-tab="${tab}"]`).classList.remove('text-gray-500');
    document.querySelector(`.mobile-tab-btn[data-tab="${tab}"]`).classList.add('text-primary');
    
    // Renderizar contenido si es necesario
    if (tab === 'following') {
        renderFollowing();
    }
}

// ============================================
// FILTROS
// ============================================

/**
 * Filtra el contenido según el criterio
 * @param {string} filter - Criterio de filtro
 */
function filterContent(filter) {
    AppState.currentFilter = filter;
    
    // Actualizar estilos de botones
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.remove('bg-primary', 'text-white');
        btn.classList.add('bg-dark-input', 'text-gray-300');
    });
    event.target.classList.remove('bg-dark-input', 'text-gray-300');
    event.target.classList.add('bg-primary', 'text-white');
    
    renderFollowing();
}

/**
 * Obtiene los items filtrados
 * @returns {Array} Items filtrados
 */
function getFilteredItems() {
    const allItems = [
        ...AppState.movies.map(m => ({ ...m, tipo: 'movie' })),
        ...AppState.shows.map(s => ({ ...s, tipo: 'tv' })),
    ];
    
    switch (AppState.currentFilter) {
        case 'series':
            return allItems.filter(item => item.tipo === 'tv');
        case 'movies':
            return allItems.filter(item => item.tipo === 'movie');
        case 'watching':
            return allItems.filter(item => item.estado === 'watching' || item.estado === 'siguiendo');
        case 'completed':
            return allItems.filter(item => item.estado === 'completed' || item.estado === 'terminada');
        case 'pending':
            return allItems.filter(item => item.estado === 'pending' || item.estado === 'pendiente');
        default:
            return allItems;
    }
}

// ============================================
// RENDERIZADO
// ============================================

/**
 * Renderiza la pestaña de seguimiento
 */
function renderFollowing() {
    const grid = document.getElementById('following-grid');
    const items = getFilteredItems();
    
    if (items.length === 0) {
        grid.innerHTML = `
            <div class="text-center col-span-full py-12 text-gray-500 dark:text-gray-400">
                <div class="text-4xl mb-4">📺</div>
                <p>No hay contenido en tu lista</p>
                <p class="text-sm mt-2">Usa la pestaña "Buscar" para añadir series y películas</p>
            </div>
        `;
        return;
    }
    
    grid.innerHTML = items.map(item => `
        <div class="bg-white dark:bg-dark-card rounded-xl overflow-hidden shadow-lg hover:shadow-xl transition cursor-pointer group" onclick="openDetail('${item.tipo}', ${item.id_tmdb})">
            <div class="aspect-[2/3] bg-gray-200 dark:bg-gray-700 relative">
                ${item.portada 
                    ? `<img src="${item.portada}" alt="${item.titulo}" class="w-full h-full object-cover group-hover:scale-105 transition duration-300" onerror="this.onerror=null;this.src='https://via.placeholder.com/500x750?text=Sin+imagen';">`
                    : `<div class="w-full h-full flex items-center justify-center text-4xl">🎬</div>`
                }
                <div class="absolute top-2 right-2 bg-black/70 text-white text-xs px-2 py-1 rounded">
                    ${item.puntuacion > 0 ? `⭐ ${item.puntuacion}` : '—'}
                </div>
                <div class="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-2">
                    <span class="text-white text-xs font-medium">${item.tipo === 'tv' ? '📺 Serie' : '🎬 Película'}</span>
                </div>
            </div>
            <div class="p-3">
                <h3 class="font-semibold text-sm truncate">${item.titulo}</h3>
                <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    ${getStatusBadge(item.estado)}
                </p>
            </div>
        </div>
    `).join('');
}

/**
 * Renderiza los resultados de búsqueda
 * @param {Array} results - Resultados de búsqueda
 */
function renderSearchResults(results) {
    const grid = document.getElementById('search-results');
    
    if (!results || results.length === 0) {
        grid.innerHTML = `
            <div class="text-center col-span-full py-12 text-gray-500 dark:text-gray-400">
                <div class="text-4xl mb-4">🔍</div>
                <p>No se encontraron resultados</p>
            </div>
        `;
        return;
    }
    
    grid.innerHTML = results.map(item => `
        <div class="bg-white dark:bg-dark-card rounded-xl overflow-hidden shadow-lg hover:shadow-xl transition group">
            <div class="aspect-[2/3] bg-gray-200 dark:bg-gray-700 relative">
                ${item.portada 
                    ? `<img src="${item.portada}" alt="${item.titulo}" class="w-full h-full object-cover group-hover:scale-105 transition duration-300" onerror="this.onerror=null;this.src='https://via.placeholder.com/500x750?text=Sin+imagen';">`
                    : `<div class="w-full h-full flex items-center justify-center text-4xl">🎬</div>`
                }
                <div class="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-2">
                    <span class="text-white text-xs font-medium">${item.tipo === 'tv' ? '📺 Serie' : '🎬 Película'}</span>
                </div>
            </div>
            <div class="p-3">
                <h3 class="font-semibold text-sm truncate">${item.titulo}</h3>
                <p class="text-xs text-gray-500 dark:text-gray-400 mt-1 mb-2">
                    ${item.fecha_estreno ? new Date(item.fecha_estreno).getFullYear() : 'Sin fecha'}
                </p>
                <button 
                    onclick="addItem('${item.tipo}', ${item.id_tmdb})"
                    class="w-full px-3 py-2 bg-primary text-white rounded-lg text-xs font-medium hover:bg-primary/90 transition"
                >
                    + Añadir
                </button>
            </div>
        </div>
    `).join('');
}

/**
 * Renderiza los episodios de una serie
 * @param {Object} show - Datos de la serie
 */
async function renderEpisodes(show) {
    const container = document.getElementById('episodes-list');
    const episodesSection = document.getElementById('modal-episodes');
    
    if (show.tipo !== 'tv') {
        episodesSection.classList.add('hidden');
        return;
    }
    
    episodesSection.classList.remove('hidden');
    container.innerHTML = '<div class="text-center py-4 text-gray-500">Cargando episodios...</div>';
    
    try {
        let episodesHTML = '';
        
        for (const season of show.temporadas || []) {
            const seasonDetails = await getSeasonDetails(show.id_tmdb, season.numero);
            const seasonId = `season-${season.numero}`;
            const seasonKey = `${show.id_tmdb}-season-${season.numero}`;
            
            // Contar episodios vistos en esta temporada
            const seasonEpisodeIds = seasonDetails.episodes.map(ep => 
                `S${String(season.numero).padStart(2, '0')}E${String(ep.episode_number).padStart(2, '0')}`
            );
            const watchedInSeason = seasonEpisodeIds.filter(id => show.capitulos_vistos?.includes(id)).length;
            const totalInSeason = seasonEpisodeIds.length;
            const allWatchedInSeason = watchedInSeason === totalInSeason && totalInSeason > 0;
            const isExpanded = AppState.expandedSeasons[seasonKey];
            
            episodesHTML += `
                <div class="mb-3 bg-gray-50 dark:bg-gray-800 rounded-lg overflow-hidden">
                    <!-- Season Header (Clickable) -->
                    <div class="flex items-center justify-between p-3 hover:bg-gray-100 dark:hover:bg-gray-700 transition">
                        <button 
                            type="button"
                            onclick="toggleSeasonAccordion('${seasonId}', '${seasonKey}')"
                            class="flex items-center gap-2 flex-1 text-left"
                        >
                            <span class="transition-transform duration-300 text-sm" id="chevron-${seasonId}">▶️</span>
                            <div>
                                <h4 class="font-semibold text-sm">${season.nombre}</h4>
                                <p class="text-xs text-gray-500 dark:text-gray-400">
                                    ${watchedInSeason}/${totalInSeason}
                                </p>
                            </div>
                        </button>
                        
                        <div class="flex items-center gap-2 flex-shrink-0">
                            <input 
                                type="checkbox" 
                                id="season-check-${seasonId}"
                                ${allWatchedInSeason ? 'checked' : ''}
                                class="w-4 h-4 rounded cursor-pointer season-checkbox"
                            >
                            <span class="text-xs font-medium px-2 py-1 rounded-full ${allWatchedInSeason ? 'bg-green-200 dark:bg-green-900 text-green-800 dark:text-green-200' : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300'}">
                                ${allWatchedInSeason ? '✓' : Math.round((watchedInSeason / totalInSeason) * 100) + '%'}
                            </span>
                        </div>
                    </div>
                    
                    <!-- Season Content (Hidden by default unless expanded) -->
                    <div id="${seasonId}" class="${isExpanded ? '' : 'hidden'}">
                        <!-- Episodes List -->
                        <div class="space-y-1 p-3 border-t border-gray-200 dark:border-gray-700">
            `;
            
            for (const episode of seasonDetails.episodes) {
                const episodeId = `S${String(season.numero).padStart(2, '0')}E${String(episode.episode_number).padStart(2, '0')}`;
                const isWatched = show.capitulos_vistos?.includes(episodeId);
                const episodeImage = episode.still_path ? getImageUrl(episode.still_path, 'w185') : null;
                const episodeOverview = episode.overview || 'Sin descripción';
                
                episodesHTML += `
                    <div class="flex items-start gap-2 p-2 bg-white dark:bg-gray-800 rounded hover:bg-gray-50 dark:hover:bg-gray-700 transition">
                        <input 
                            type="checkbox" 
                            id="ep-${episodeId}"
                            data-show="${show.id_tmdb}"
                            data-season="${season.numero}"
                            data-episode="${episodeId}"
                            ${isWatched ? 'checked' : ''}
                            class="w-4 h-4 rounded cursor-pointer mt-0.5 flex-shrink-0 ep-checkbox"
                        >
                        
                        <div class="flex gap-2 flex-1 min-w-0">
                            ${episodeImage ? `
                            <img 
                                src="${episodeImage}" 
                                alt="${episode.name}" 
                                class="w-16 h-9 rounded object-cover flex-shrink-0"
                                onerror="this.style.display='none';"
                            >
                            ` : ''}
                            
                            <div class="flex-1 min-w-0">
                                <div class="flex items-baseline gap-1 mb-0.5">
                                    <span class="text-xs font-semibold text-primary flex-shrink-0">•</span>
                                    <span class="font-medium text-xs">${episodeId}</span>
                                    <span class="text-gray-600 dark:text-gray-400 text-xs truncate">${episode.name}</span>
                                </div>
                                <p class="text-xs text-gray-500 dark:text-gray-400 line-clamp-1">
                                    ${episodeOverview}
                                </p>
                            </div>
                        </div>
                    </div>
                `;
            }
            
            episodesHTML += `
                        </div>
                    </div>
                </div>
            `;
        }
        
        container.innerHTML = episodesHTML;

        // Adjuntar listeners de episodio y temporada de forma segura
        // Episode checkboxes
        const episodeCheckboxes = container.querySelectorAll('input.ep-checkbox');
        episodeCheckboxes.forEach(cb => {
            cb.removeEventListener('change', episodeCheckboxHandler);
            cb.addEventListener('change', episodeCheckboxHandler);
        });

        // Season checkboxes
        const seasonCheckboxes = container.parentElement.querySelectorAll('input[id^="season-check-season-"]');
        seasonCheckboxes.forEach(cb => {
            cb.removeEventListener('change', seasonCheckboxHandler);
            cb.addEventListener('change', seasonCheckboxHandler);
        });
    } catch (error) {
        console.error('[App] Error cargando episodios:', error);
        container.innerHTML = '<div class="text-center py-4 text-red-500">Error al cargar episodios</div>';
    }
}

/**
 * Alterna la visibilidad del acordeón de temporada y guarda el estado
 * @param {string} seasonId - ID de la temporada
 * @param {string} seasonKey - Clave para guardar el estado
 */
function toggleSeasonAccordion(seasonId, seasonKey) {
    const seasonElement = document.getElementById(seasonId);
    const chevron = document.getElementById(`chevron-${seasonId}`);
    
    if (seasonElement.classList.contains('hidden')) {
        seasonElement.classList.remove('hidden');
        chevron.textContent = '🔽';
        AppState.expandedSeasons[seasonKey] = true;
    } else {
        seasonElement.classList.add('hidden');
        chevron.textContent = '▶️';
        AppState.expandedSeasons[seasonKey] = false;
    }
}

/**
 * Alterna episodio y actualiza checkbox de temporada sin colapsar
 * @param {number} id_tmdb - ID de TMDB de la serie
 * @param {string} episode - Formato "S01E01"
 * @param {number} seasonNumber - Número de temporada
 * @param {Array} seasonEpisodeIds - IDs de episodios de la temporada
 * @param {string} seasonId - ID del elemento de temporada
 */
function toggleEpisodeAndUpdateSeason(id_tmdb, episode, seasonNumber, seasonId) {
    const show = AppState.shows.find(s => s.id_tmdb === id_tmdb);
    if (!show) return;

    if (!show.capitulos_vistos) {
        show.capitulos_vistos = [];
    }

    const index = show.capitulos_vistos.indexOf(episode);
    if (index > -1) {
        show.capitulos_vistos.splice(index, 1);
    } else {
        show.capitulos_vistos.push(episode);
    }

    saveLocalData();
    syncToDrive();

    // Obtener episode IDs desde el DOM para evitar pasar arrays en el onclick
    const seasonContent = document.getElementById(seasonId);
    let seasonEpisodeIds = [];
    if (seasonContent) {
        const episodeCheckboxes = seasonContent.querySelectorAll('input[id^="ep-S"]');
        seasonEpisodeIds = Array.from(episodeCheckboxes).map(cb => cb.id.replace(/^ep-/, ''));
    }

    // Actualizar UI de la temporada
    updateSeasonUI(id_tmdb, seasonNumber, seasonEpisodeIds, seasonId);
}

/**
 * Actualiza la UI de una temporada sin colapsarla
 * @param {number} id_tmdb - ID de TMDB de la serie
 * @param {number} seasonNumber - Número de temporada
 * @param {Array} seasonEpisodeIds - IDs de episodios de la temporada
 * @param {string} seasonId - ID del elemento de temporada
 */
function updateSeasonUI(id_tmdb, seasonNumber, seasonEpisodeIds, seasonId) {
    const show = AppState.shows.find(s => s.id_tmdb === id_tmdb);
    if (!show) return;
    
    const watchedInSeason = seasonEpisodeIds.filter(id => show.capitulos_vistos?.includes(id)).length;
    const totalInSeason = seasonEpisodeIds.length;
    const allWatchedInSeason = watchedInSeason === totalInSeason && totalInSeason > 0;
    
    // Encontrar el contenedor de la temporada
    const seasonContentDiv = document.getElementById(seasonId);
    if (!seasonContentDiv) {
        console.log('[App] No encontrado seasonContentDiv con id:', seasonId);
        return;
    }
    
    // El header es el elemento anterior (hermano previo)
    const seasonHeaderDiv = seasonContentDiv.previousElementSibling;
    if (!seasonHeaderDiv) {
        console.log('[App] No encontrado seasonHeaderDiv');
        return;
    }
    
    // Actualizar contador "X/Y" 
    // Buscar el párrafo que contiene el contador
    const counterParagraphs = seasonHeaderDiv.querySelectorAll('p');
    if (counterParagraphs.length > 0) {
        counterParagraphs[0].textContent = `${watchedInSeason}/${totalInSeason}`;
    }
    
    // Actualizar checkbox de temporada por su ID específico
    const seasonCheckbox = seasonHeaderDiv.querySelector(`input[id="season-check-${seasonId}"]`);
    if (seasonCheckbox) {
        seasonCheckbox.checked = allWatchedInSeason;
    }
    
    // Actualizar badge de progreso (es un span con rounded-full)
    const badges = seasonHeaderDiv.querySelectorAll('span.rounded-full');
    if (badges.length > 0) {
        const badge = badges[0];
        if (allWatchedInSeason) {
            badge.className = 'text-xs font-medium px-2 py-1 rounded-full bg-green-200 dark:bg-green-900 text-green-800 dark:text-green-200';
            badge.textContent = '✓';
        } else {
            badge.className = 'text-xs font-medium px-2 py-1 rounded-full bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300';
            badge.textContent = Math.round((watchedInSeason / totalInSeason) * 100) + '%';
        }
    }
}

// Handler externo para cambios en checkboxes de episodio
function episodeCheckboxHandler(e) {
    const cb = e.currentTarget;
    const showId = parseInt(cb.getAttribute('data-show'), 10);
    const episodeId = cb.getAttribute('data-episode');
    const seasonNumber = parseInt(cb.getAttribute('data-season'), 10);
    const seasonId = `season-${seasonNumber}`;
    // Llamar a la función que actualiza el estado y UI
    toggleEpisodeAndUpdateSeason(showId, episodeId, seasonNumber, seasonId);
}

// Handler externo para cambios en checkbox de temporada
function seasonCheckboxHandler(e) {
    const cb = e.currentTarget;
    // season-check-season-X -> extract seasonId
    const fullId = cb.id; // e.g. season-check-season-1
    const seasonId = fullId.replace(/^season-check-/, '');
    // seasonId is like season-1, extract season number
    const match = seasonId.match(/season-(\d+)/);
    const seasonNumber = match ? parseInt(match[1], 10) : null;
    // Find show id by walking DOM to header's sibling container
    const header = cb.closest('div');
    let showId = null;
    // showId is stored on episode inputs; find one nearby
    const seasonContent = document.getElementById(seasonId);
    if (seasonContent) {
        const anyEp = seasonContent.querySelector('input[id^="ep-"]');
        if (anyEp) showId = parseInt(anyEp.getAttribute('data-show'), 10);
    }
    if (!showId || seasonNumber === null) return;
    toggleSeasonWatched(showId, seasonNumber, seasonId, e);
}

/**
 * Marca todos los episodios de una temporada como visto o no visto
 * @param {number} id_tmdb - ID de TMDB de la serie
 * @param {number} seasonNumber - Número de temporada
 * @param {Array} episodeIds - IDs de los episodios en formato "S01E01"
 * @param {Event} event - Evento del checkbox
 */
function toggleSeasonWatched(id_tmdb, seasonNumber, seasonId, event) {
    const show = AppState.shows.find(s => s.id_tmdb === id_tmdb);
    if (!show) return;

    if (!show.capitulos_vistos) {
        show.capitulos_vistos = [];
    }

    const watched = event.target.checked;

    // Obtener lista de episodios desde el DOM
    const seasonContent = document.getElementById(seasonId);
    let episodeIds = [];
    if (seasonContent) {
        const episodeCheckboxes = seasonContent.querySelectorAll('input[id^="ep-"]');
        episodeIds = Array.from(episodeCheckboxes).map(cb => cb.id.replace(/^ep-/, ''));
    }

    episodeIds.forEach(episodeId => {
        const index = show.capitulos_vistos.indexOf(episodeId);
        if (watched) {
            if (index === -1) show.capitulos_vistos.push(episodeId);
        } else {
            if (index > -1) show.capitulos_vistos.splice(index, 1);
        }
    });

    saveLocalData();
    syncToDrive();

    // Actualizar solo los checkboxes de episodios sin colapsar
    episodeIds.forEach(episodeId => {
        const checkbox = document.getElementById(`ep-${episodeId}`);
        if (checkbox) {
            checkbox.checked = watched;
        }
    });

    // Actualizar progreso de temporada
    updateSeasonUI(id_tmdb, seasonNumber, episodeIds, seasonId);
}

/**
 * Renderiza las estrellas de puntuación
 * @param {number} rating - Puntuación actual
 */
function renderStars(rating) {
    const container = document.getElementById('modal-rating');
    container.innerHTML = '';
    
    for (let i = 1; i <= 10; i++) {
        const star = document.createElement('span');
        star.className = `star text-2xl ${i <= rating ? 'text-yellow-400' : 'text-gray-400'}`;
        star.textContent = '★';
        star.onclick = () => setRating(i);
        container.appendChild(star);
    }
}

// ============================================
// MODAL
// ============================================

/**
 * Abre el modal de detalle
 * @param {string} type - 'movie' o 'tv'
 * @param {number} id_tmdb - ID de TMDB
 */
async function openDetail(type, id_tmdb) {
    const modal = document.getElementById('detail-modal');
    modal.classList.remove('hidden');
    
    showLoading(true);
    
    try {
        let item;
        if (type === 'movie') {
            item = AppState.movies.find(m => m.id_tmdb === id_tmdb) || await getMovieDetails(id_tmdb);
        } else {
            item = AppState.shows.find(s => s.id_tmdb === id_tmdb) || await getTVDetails(id_tmdb);
        }
        
        AppState.selectedItem = { ...item, tipo: type };
        
        // Actualizar modal
        document.getElementById('modal-title').textContent = item.titulo;
        document.getElementById('modal-overview').textContent = item.overview || 'Sin descripción';
        
        // Poster
        const posterContainer = document.getElementById('modal-poster');
        if (item.portada) {
            posterContainer.innerHTML = `<img src="${item.portada}" alt="${item.titulo}" class="w-full h-full object-cover rounded-lg">`;
        } else {
            posterContainer.innerHTML = '<span class="text-4xl">🎬</span>';
        }
        
        // Meta tags
        const metaContainer = document.getElementById('modal-meta');
        metaContainer.innerHTML = `
            <span class="px-2 py-1 bg-primary/20 text-primary text-xs rounded">${item.tipo === 'tv' ? 'Serie' : 'Película'}</span>
            ${item.fecha_estreno ? `<span class="px-2 py-1 bg-gray-200 dark:bg-gray-700 text-xs rounded">${new Date(item.fecha_estreno).getFullYear()}</span>` : ''}
            ${item.vote_average ? `<span class="px-2 py-1 bg-yellow-500/20 text-yellow-500 text-xs rounded">TMDB: ${item.vote_average.toFixed(1)}</span>` : ''}
        `;
        
        // Rating
        document.getElementById('modal-rating-input').value = item.puntuacion || '';
        renderStars(item.puntuacion || 0);
        
        // Status
        document.getElementById('modal-status').value = item.estado || 'pending';
        
        // Episodes (si es serie)
        if (type === 'tv') {
            await renderEpisodes(item);
        } else {
            document.getElementById('modal-episodes').classList.add('hidden');
        }
        
    } catch (error) {
        console.error('[App] Error abriendo detalle:', error);
        showToast('Error al cargar detalles');
    } finally {
        showLoading(false);
    }
}

/**
 * Cierra el modal
 */
function closeModal() {
    document.getElementById('detail-modal').classList.add('hidden');
    AppState.selectedItem = null;
}

/**
 * Guarda los cambios del modal
 */
function saveContent() {
    if (!AppState.selectedItem) return;
    
    const item = AppState.selectedItem;
    const rating = parseFloat(document.getElementById('modal-rating-input').value) || 0;
    const status = document.getElementById('modal-status').value;
    
    updateRating(item.tipo, item.id_tmdb, rating);
    updateStatus(item.tipo, item.id_tmdb, status);
    
    closeModal();
    renderFollowing();
    showToast('Cambios guardados');
}

/**
 * Elimina el contenido actual
 */
function removeContent() {
    if (!AppState.selectedItem) return;
    
    const item = AppState.selectedItem;
    
    if (confirm(`¿Estás seguro de eliminar "${item.titulo}"?`)) {
        if (item.tipo === 'movie') {
            removeMovie(item.id_tmdb);
        } else {
            removeShow(item.id_tmdb);
        }
        closeModal();
    }
}

/**
 * Establece la puntuación
 * @param {number} rating - Puntuación (1-10)
 */
function setRating(rating) {
    document.getElementById('modal-rating-input').value = rating;
    renderStars(rating);
}

/**
 * Establece el estado
 * @param {string} status - Estado
 */
function setStatus(status) {
    // El estado se guarda al hacer clic en "Guardar"
}

// ============================================
// BÚSQUEDA
// ============================================

/**
 * Maneja el evento de búsqueda
 * @param {Event} event - Evento del input
 */
function handleSearch(event) {
    const query = event.target.value;
    
    searchWithDebounce(query, (results) => {
        renderSearchResults(results);
    });
}

/**
 * Añade un item desde la búsqueda
 * @param {string} type - 'movie' o 'tv'
 * @param {number} id_tmdb - ID de TMDB
 */
async function addItem(type, id_tmdb) {
    const item = type === 'movie' 
        ? AppState.movies.find(m => m.id_tmdb === id_tmdb)
        : AppState.shows.find(s => s.id_tmdb === id_tmdb);
    
    if (item) {
        showToast('Ya está en tu lista');
        return;
    }
    
    if (type === 'movie') {
        await addMovie({ id_tmdb, tipo: 'movie' });
    } else {
        await addShow({ id_tmdb, tipo: 'tv' });
    }
}

// ============================================
// DRIVE
// ============================================

/**
 * Conecta a Google Drive
 */
async function connectDrive() {
    console.log('[App] === connectDrive iniciado ===');
    try {
        console.log('[App] Llamando a authenticate...');
        await authenticate();
        console.log('[App] authenticate completado, llamando a updateDriveStatus(true)');
        updateDriveStatus(true);
        showToast('Conectado a Google Drive');
        
        // Cargar datos desde Drive (no afecta el estado de conexión)
        try {
            await loadFromDrive();
        } catch (error) {
            console.error('[App] Error cargando datos desde Drive:', error);
            showToast('Conectado, pero error al cargar datos');
        }
    } catch (error) {
        console.error('[App] Error conectando Drive:', error);
        updateDriveStatus(false);
        showToast('Error al conectar Google Drive');
    }
}

/**
 * Desconecta de Google Drive
 */
function disconnectDrive() {
    signOut();
    updateDriveStatus(false);
    showToast('Desconectado de Google Drive');
}

/**
 * Actualiza el estado de conexión a Drive en la UI
 * @param {boolean} connected - Estado de conexión
 */
function updateDriveStatus(connected) {
    console.log('[App] updateDriveStatus llamado con:', connected);
    const statusDiv = document.getElementById('drive-status');
    const connectBtn = document.getElementById('btn-connect-drive');
    const disconnectBtn = document.getElementById('btn-disconnect-drive');
    
    console.log('[App] Elementos DOM:', { statusDiv, connectBtn, disconnectBtn });
    
    if (connected) {
        statusDiv.innerHTML = `
            <div class="flex items-center gap-2 text-green-600 dark:text-green-400">
                <span>✓</span>
                <span>Conectado</span>
            </div>
        `;
        connectBtn.classList.add('hidden');
        disconnectBtn.classList.remove('hidden');
    } else {
        statusDiv.innerHTML = `
            <div class="flex items-center gap-2 text-yellow-600 dark:text-yellow-400">
                <span>⚠️</span>
                <span>No conectado</span>
            </div>
        `;
        connectBtn.classList.remove('hidden');
        disconnectBtn.classList.add('hidden');
    }
}

// ============================================
// GESTIÓN DE DATOS
// ============================================

/**
 * Exporta los datos a un archivo JSON
 */
function exportData() {
    const data = {
        movies: AppState.movies,
        shows: AppState.shows,
        exportDate: new Date().toISOString(),
    };
    
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `seenit_backup_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    
    showToast('Datos exportados');
}

/**
 * Importa datos desde un archivo JSON
 */
function importData() {
    document.getElementById('import-file').click();
}

/**
 * Maneja la importación de datos
 * @param {Event} event - Evento del input file
 */
function handleImport(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result);
            
            if (data.movies || data.shows) {
                AppState.movies = data.movies || [];
                AppState.shows = data.shows || [];
                saveLocalData();
                syncToDrive();
                renderFollowing();
                showToast('Datos importados correctamente');
            } else {
                showToast('Formato de archivo inválido');
            }
        } catch (error) {
            console.error('[App] Error importando datos:', error);
            showToast('Error al importar datos');
        }
    };
    reader.readAsText(file);
    
    // Limpiar input
    event.target.value = '';
}

/**
 * Borra todos los datos
 */
function clearAllData() {
    if (confirm('¿Estás seguro de borrar todos los datos? Esta acción no se puede deshacer.')) {
        AppState.movies = [];
        AppState.shows = [];
        saveLocalData();
        syncToDrive();
        renderFollowing();
        showToast('Todos los datos han sido borrados');
    }
}

// ============================================
// UTILIDADES
// ============================================

/**
 * Muestra un toast notification
 * @param {string} message - Mensaje a mostrar
 */
function showToast(message) {
    const toast = document.getElementById('toast');
    document.getElementById('toast-message').textContent = message;
    toast.classList.remove('hidden');
    
    setTimeout(() => {
        toast.classList.add('hidden');
    }, 3000);
}

/**
 * Muestra/oculta el loading overlay
 * @param {boolean} show - Mostrar u ocultar
 */
function showLoading(show) {
    const overlay = document.getElementById('loading-overlay');
    if (show) {
        overlay.classList.remove('hidden');
    } else {
        overlay.classList.add('hidden');
    }
}

/**
 * Obtiene el badge de estado
 * @param {string} status - Estado
 * @returns {string} HTML del badge
 */
function getStatusBadge(status) {
    const badges = {
        'pending': '<span class="px-2 py-1 bg-gray-200 dark:bg-gray-700 text-xs rounded">Pendiente</span>',
        'pendiente': '<span class="px-2 py-1 bg-gray-200 dark:bg-gray-700 text-xs rounded">Pendiente</span>',
        'watching': '<span class="px-2 py-1 bg-blue-200 dark:bg-blue-900 text-blue-800 dark:text-blue-200 text-xs rounded">Viendo</span>',
        'siguiendo': '<span class="px-2 py-1 bg-blue-200 dark:bg-blue-900 text-blue-800 dark:text-blue-200 text-xs rounded">Siguiendo</span>',
        'completed': '<span class="px-2 py-1 bg-green-200 dark:bg-green-900 text-green-800 dark:text-green-200 text-xs rounded">Completado</span>',
        'terminada': '<span class="px-2 py-1 bg-green-200 dark:bg-green-900 text-green-800 dark:text-green-200 text-xs rounded">Terminada</span>',
        'dropped': '<span class="px-2 py-1 bg-red-200 dark:bg-red-900 text-red-800 dark:text-red-200 text-xs rounded">Abandonado</span>',
    };
    
    return badges[status] || badges['pending'];
}

/**
 * Configura los event listeners
 */
function setupEventListeners() {
    // Event listeners ya están configurados en el HTML con onclick
    console.log('[App] Event listeners configurados');
}

// ============================================
// INICIALIZACIÓN AL CARGAR
// ============================================

document.addEventListener('DOMContentLoaded', initApp);

// ============================================
// EXPORTACIONES
// ============================================

// Hacer funciones disponibles globalmente
window.App = {
    initApp,
    addMovie,
    addShow,
    removeMovie,
    removeShow,
    updateRating,
    updateStatus,
    toggleEpisode,
    toggleSeasonWatched,
    toggleEpisodeAndUpdateSeason,
    updateSeasonUI,
    switchTab,
    filterContent,
    openDetail,
    closeModal,
    saveContent,
    removeContent,
    setRating,
    setStatus,
    handleSearch,
    addItem,
    connectDrive,
    disconnectDrive,
    exportData,
    importData,
    handleImport,
    clearAllData,
};

// También exportar individualmente
window.switchTab = switchTab;
window.filterContent = filterContent;
window.openDetail = openDetail;
window.closeModal = closeModal;
window.saveContent = saveContent;
window.removeContent = removeContent;
window.setRating = setRating;
window.setStatus = setStatus;
window.handleSearch = handleSearch;
window.addItem = addItem;
window.connectDrive = connectDrive;
window.disconnectDrive = disconnectDrive;
window.exportData = exportData;
window.importData = importData;
window.handleImport = handleImport;
window.clearAllData = clearAllData;
window.toggleEpisode = toggleEpisode;
window.toggleSeasonWatched = toggleSeasonWatched;
window.toggleSeasonAccordion = toggleSeasonAccordion;
window.toggleEpisodeAndUpdateSeason = toggleEpisodeAndUpdateSeason;
window.updateSeasonUI = updateSeasonUI;

console.log('[App] app.js cargado');

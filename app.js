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
    currentTab: 'series',
    currentSubTab: 'pending-list',
    currentProfileTab: 'series',
    currentFilter: 'all',
    profileSeriesFilter: 'all',
    profileMoviesFilter: 'all',
    lastSearchResults: [],
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
        updateDriveStatus(isAuthenticated());
        console.log('[App] Drive service inicializado');

        if (isAuthenticated()) {
            await loadFromDrive();
        }
    } catch (error) {
        console.warn('[App] No se pudo inicializar Drive service:', error);
    }
    
    // Renderizar contenido inicial
    switchTab('series');
    renderCurrentView();
    
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
            AppState.movies = (data.movies || []).map(normalizeStoredMovie);
            AppState.shows = (data.shows || []).map(normalizeStoredShow);
            console.log('[App] Datos locales cargados');
        }
    } catch (error) {
        console.error('[App] Error cargando datos locales:', error);
    }
}

function normalizeStoredMovie(movie) {
    const normalized = { ...movie };
    normalized.estado = normalizeStatus(normalized.estado);
    normalized.capitulos_vistos = Array.isArray(normalized.capitulos_vistos) ? normalized.capitulos_vistos : [];
    return normalized;
}

function normalizeStoredShow(show) {
    const normalized = { ...show };
    normalized.estado = normalizeStatus(normalized.estado);
    normalized.capitulos_vistos = Array.isArray(normalized.capitulos_vistos) ? normalized.capitulos_vistos : [];
    normalized.temporadas = Array.isArray(normalized.temporadas) ? normalized.temporadas.map(season => ({
        ...season,
        especial: Boolean(season.especial || season.numero === 0),
    })) : [];
    return normalized;
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
    const exists = AppState.movies.find(m => m.id_tmdb === movie.id_tmdb);
    if (exists) {
        showToast('Esta película ya está en tu lista');
        return;
    }

    try {
        const details = await getMovieDetails(movie.id_tmdb);
        AppState.movies.push(details);
        saveLocalData();
        syncToDrive();
        renderCurrentView();
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
    const exists = AppState.shows.find(s => s.id_tmdb === show.id_tmdb);
    if (exists) {
        showToast('Esta serie ya está en tu lista');
        return;
    }

    try {
        const details = await getTVDetails(show.id_tmdb);
        AppState.shows.push(details);
        saveLocalData();
        syncToDrive();
        renderCurrentView();
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
async function updateStatus(type, id_tmdb, status) {
    const normalizedStatus = normalizeStatus(status);

    if (type === 'movie') {
        const movie = AppState.movies.find(m => m.id_tmdb === id_tmdb);
        if (movie) {
            movie.estado = normalizedStatus;
        }
    } else if (type === 'tv') {
        const show = AppState.shows.find(s => s.id_tmdb === id_tmdb);
        if (show) {
            show.estado = normalizedStatus;

            if (normalizedStatus === 'completed') {
                const episodes = await getOrderedEpisodes(show, { includeSpecials: false });
                const airedEpisodeIds = episodes.filter(isEpisodeAired).map(ep => ep.id);
                show.capitulos_vistos = [...new Set([...(show.capitulos_vistos || []), ...airedEpisodeIds])];
            }
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
async function toggleEpisode(id_tmdb, episode) {
    const show = AppState.shows.find(s => s.id_tmdb === id_tmdb);
    if (!show) return;

    const episodes = await getOrderedEpisodes(show, { includeSpecials: false });
    const targetEpisode = episodes.find(ep => ep.id === episode);

    if (targetEpisode && !isEpisodeAired(targetEpisode)) {
        showToast('No puedes marcar episodios con fecha posterior a la actual');
        return;
    }

    if (!show.capitulos_vistos) {
        show.capitulos_vistos = [];
    }

    const index = show.capitulos_vistos.indexOf(episode);
    if (index > -1) {
        show.capitulos_vistos.splice(index, 1);
    } else {
        show.capitulos_vistos.push(episode);
    }

    await refreshShowStatus(show);
    saveLocalData();
    syncToDrive();
    if (AppState.selectedItem?.tipo === 'tv' && AppState.selectedItem.id_tmdb === id_tmdb) {
        AppState.selectedItem = { ...show, tipo: 'tv' };
        await renderEpisodes(AppState.selectedItem);
    }
    renderCurrentView();
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
    
    document.querySelectorAll('.tab-content').forEach(el => {
        el.classList.add('hidden');
    });

    const content = document.getElementById(`content-${tab}`);
    if (content) {
        content.classList.remove('hidden');
    }

    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('border-primary', 'text-primary');
        btn.classList.add('border-transparent', 'text-gray-500', 'dark:text-gray-400');
    });

    const desktopTab = document.getElementById(`tab-${tab}`);
    if (desktopTab) {
        desktopTab.classList.remove('border-transparent', 'text-gray-500', 'dark:text-gray-400');
        desktopTab.classList.add('border-primary', 'text-primary');
    }

    document.querySelectorAll('.mobile-tab-btn').forEach(btn => {
        btn.classList.remove('text-primary');
        btn.classList.add('text-gray-500');
    });

    const mobileTab = document.querySelector(`.mobile-tab-btn[data-tab="${tab}"]`);
    if (mobileTab) {
        mobileTab.classList.remove('text-gray-500');
        mobileTab.classList.add('text-primary');
    }

    renderCurrentView();
}

/**
 * Cambia entre subtabs de la sección Series o Perfil
 */
function switchSubTab(subTab) {
    AppState.currentSubTab = subTab;

    document.querySelectorAll('[id^="subtab-"]').forEach(btn => {
        btn.classList.remove('bg-primary', 'text-white');
        btn.classList.add('bg-dark-input', 'text-gray-200');
    });

    const activeBtn = document.getElementById(`subtab-${subTab}`);
    if (activeBtn) {
        activeBtn.classList.remove('bg-dark-input', 'text-gray-200');
        activeBtn.classList.add('bg-primary', 'text-white');
    }

    document.querySelectorAll('[id^="subtab-content-"]').forEach(el => {
        el.classList.add('hidden');
    });

    const activeContent = document.getElementById(`subtab-content-${subTab}`);
    if (activeContent) {
        activeContent.classList.remove('hidden');
    }

    renderCurrentView();
}

function switchProfileTab(tab) {
    AppState.currentProfileTab = tab;

    document.getElementById('profile-tab-series')?.classList.remove('bg-primary', 'text-white');
    document.getElementById('profile-tab-series')?.classList.add('bg-dark-input', 'text-gray-200');
    document.getElementById('profile-tab-movies')?.classList.remove('bg-primary', 'text-white');
    document.getElementById('profile-tab-movies')?.classList.add('bg-dark-input', 'text-gray-200');

    if (tab === 'series') {
        document.getElementById('profile-tab-series')?.classList.remove('bg-dark-input', 'text-gray-200');
        document.getElementById('profile-tab-series')?.classList.add('bg-primary', 'text-white');
        document.getElementById('profile-series-content')?.classList.remove('hidden');
        document.getElementById('profile-movies-content')?.classList.add('hidden');
    } else {
        document.getElementById('profile-tab-movies')?.classList.remove('bg-dark-input', 'text-gray-200');
        document.getElementById('profile-tab-movies')?.classList.add('bg-primary', 'text-white');
        document.getElementById('profile-series-content')?.classList.add('hidden');
        document.getElementById('profile-movies-content')?.classList.remove('hidden');
    }

    renderProfileView();
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

    if (event?.target) {
        document.querySelectorAll('.filter-btn').forEach(btn => {
            btn.classList.remove('bg-primary', 'text-white');
            btn.classList.add('bg-dark-input', 'text-gray-300');
        });
        event.target.classList.remove('bg-dark-input', 'text-gray-300');
        event.target.classList.add('bg-primary', 'text-white');
    }

    renderCurrentView();
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
 * Renderiza vistas según la pestaña activa
 */
async function renderCurrentView() {
    if (AppState.currentTab === 'series') {
        await renderSeriesView();
        return;
    }

    if (AppState.currentTab === 'profile') {
        await renderProfileView();
        return;
    }

    if (AppState.currentTab === 'settings') {
        renderSettings();
        return;
    }

    renderExplore();
}

/**
 * Renderiza la pestaña de seguimiento legacy
 */
function renderFollowing() {
    renderCurrentView();
}

/**
 * Renderiza la vista de series
 */
async function renderSeriesView() {
    if (AppState.currentSubTab === 'pending-list') {
        await renderPendingList();
    } else {
        await renderUpcomingList();
    }
}

/**
 * Renderiza la lista pendiente
 */
async function renderPendingList() {
    const container = document.getElementById('pending-list-container');
    if (!container) return;

    const allTvShows = AppState.shows.filter(show => show.tipo === 'tv');
    await Promise.all(allTvShows.map(show => refreshShowStatus(show)));
    const watchingShows = allTvShows.filter(show => normalizeStatus(show.estado) === 'watching');

    if (watchingShows.length === 0) {
        container.innerHTML = `
            <div class="text-center py-12 text-gray-500 dark:text-gray-400">
                <div class="text-4xl mb-4">✨</div>
                <p>No tienes series en estado "Viendo"</p>
            </div>`;
        return;
    }

    const pendingEpisodes = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (const show of watchingShows) {
        const episodes = await getOrderedEpisodes(show, { includeSpecials: false });
        const nextEpisode = episodes.find(ep => {
            if (show.capitulos_vistos?.includes(ep.id)) {
                return false;
            }

            if (!ep.air_date) {
                return true;
            }

            const releaseDate = new Date(`${ep.air_date}T00:00:00`);
            return releaseDate <= today;
        });

        if (nextEpisode) {
            const unseenEpisodes = episodes.filter(ep => !show.capitulos_vistos?.includes(ep.id));
            const remainingCount = Math.max(0, unseenEpisodes.length - 1);
            pendingEpisodes.push({ show, episode: nextEpisode, remainingCount });
        }
    }

    pendingEpisodes.sort((a, b) => {
        const dateA = a.episode.air_date || '9999-12-31';
        const dateB = b.episode.air_date || '9999-12-31';
        return dateA.localeCompare(dateB);
    });

    if (pendingEpisodes.length === 0) {
        container.innerHTML = `
            <div class="text-center py-12 text-gray-500 dark:text-gray-400">
                <div class="text-4xl mb-4">✅</div>
                <p>Todo al día. No hay episodios pendientes.</p>
            </div>`;
        return;
    }

    container.innerHTML = pendingEpisodes.map(({ show, episode, remainingCount }) => `
        <div class="episode-card flex flex-row gap-4 items-center justify-between h-32 overflow-hidden">
            <div class="w-24 h-28 flex-shrink-0">
                ${show.portada ? `<img src="${show.portada}" alt="${show.titulo}" class="w-full h-full rounded-lg object-cover" onerror="this.onerror=null;this.style.display='none';">` : '<div class="w-full h-full rounded-lg bg-gray-700 flex items-center justify-center text-2xl">📺</div>'}
            </div>
            <div class="flex-1 min-w-0 flex flex-col justify-center gap-1">
                <p class="text-[11px] uppercase tracking-wide text-primary font-semibold">
                    <a href="#" onclick="openDetail('tv', ${show.id_tmdb});return false;" class="hover:underline">${show.titulo}</a>
                </p>
                <h3 class="font-semibold text-base leading-tight">
                    ${formatEpisodeLabel(episode.seasonNumber, episode.episodeNumber)}
                    <span class="text-sm font-normal text-gray-500 dark:text-gray-400">(${remainingCount} episodios restantes)</span>
                </h3>
                <p class="text-sm text-gray-500 dark:text-gray-400">${episode.air_date ? new Date(episode.air_date).toLocaleDateString('es-ES') : 'Fecha sin definir'}</p>
            </div>
            <label class="flex items-center justify-center w-10 h-10 rounded-lg bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-100 cursor-pointer shrink-0">
                <input type="checkbox" class="h-5 w-5 accent-green-600" onchange="toggleEpisode(${show.id_tmdb}, '${episode.id}')" ${show.capitulos_vistos?.includes(episode.id) ? 'checked' : ''}>
            </label>
        </div>
    `).join('');
}

/**
 * Renderiza la lista de próximos episodios
 */
async function renderUpcomingList() {
    const container = document.getElementById('upcoming-list-container');
    if (!container) return;

    const allTvShows = AppState.shows.filter(show => show.tipo === 'tv');
    await Promise.all(allTvShows.map(show => refreshShowStatus(show)));
    const watchingShows = allTvShows.filter(show => normalizeStatus(show.estado) === 'watching');

    if (watchingShows.length === 0) {
        container.innerHTML = `
            <div class="text-center py-12 text-gray-500 dark:text-gray-400">
                <div class="text-4xl mb-4">✨</div>
                <p>No tienes series en estado "Viendo"</p>
            </div>`;
        return;
    }

    const upcomingEpisodes = [];

    for (const show of watchingShows) {
        const episodes = await getOrderedEpisodes(show, { includeSpecials: false });
        const futureEpisodes = episodes.filter(ep => !show.capitulos_vistos?.includes(ep.id) && ep.air_date && new Date(ep.air_date) > new Date());
        futureEpisodes.forEach(episode => upcomingEpisodes.push({ show, episode }));
    }

    upcomingEpisodes.sort((a, b) => (a.episode.air_date || '9999-12-31').localeCompare(b.episode.air_date || '9999-12-31'));

    if (upcomingEpisodes.length === 0) {
        container.innerHTML = `
            <div class="text-center py-12 text-gray-500 dark:text-gray-400">
                <div class="text-4xl mb-4">🗓️</div>
                <p>No hay episodios futuros programados todavía.</p>
            </div>`;
        return;
    }

    const grouped = upcomingEpisodes.reduce((acc, item) => {
        const key = item.episode.air_date;
        if (!acc[key]) acc[key] = [];
        acc[key].push(item);
        return acc;
    }, {});

    const sortedDates = Object.keys(grouped).sort((a, b) => a.localeCompare(b));

    container.innerHTML = sortedDates.map(date => `
        <div>
            <h3 class="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">${new Date(date).toLocaleDateString('es-ES')}</h3>
            <div class="space-y-3">
                ${grouped[date].map(({ show, episode }) => `
                    <div class="episode-card flex flex-row gap-4 items-center h-32 overflow-hidden">
                        <div class="w-24 h-28 flex-shrink-0">
                            ${show.portada ? `<img src="${show.portada}" alt="${show.titulo}" class="w-full h-full rounded-lg object-cover" onerror="this.onerror=null;this.style.display='none';">` : '<div class="w-full h-full rounded-lg bg-gray-700 flex items-center justify-center text-2xl">📺</div>'}
                        </div>
                        <div class="flex-1 min-w-0 flex flex-col justify-center gap-1">
                            <p class="text-[11px] uppercase tracking-wide text-primary font-semibold">
                                <a href="#" onclick="openDetail('tv', ${show.id_tmdb});return false;" class="hover:underline">${show.titulo}</a>
                            </p>
                            <h4 class="font-semibold text-base leading-tight">${episode.id} — ${episode.name}</h4>
                            <p class="text-sm text-gray-500 dark:text-gray-400">${episode.air_date ? new Date(episode.air_date).toLocaleDateString('es-ES') : 'Fecha sin definir'}</p>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
    `).join('');
}

/**
 * Renderiza la vista de perfil
 */
async function renderProfileView() {
    AppState.profileSeriesFilter = document.getElementById('profile-series-filter')?.value || AppState.profileSeriesFilter;
    AppState.profileMoviesFilter = document.getElementById('profile-movies-filter')?.value || AppState.profileMoviesFilter;

    const seriesContainer = document.getElementById('profile-series-container');
    const moviesContainer = document.getElementById('profile-movies-container');

    if (!seriesContainer || !moviesContainer) return;

    if (AppState.currentProfileTab === 'series') {
        document.getElementById('profile-series-content')?.classList.remove('hidden');
        document.getElementById('profile-movies-content')?.classList.add('hidden');
    } else {
        document.getElementById('profile-series-content')?.classList.add('hidden');
        document.getElementById('profile-movies-content')?.classList.remove('hidden');
    }

    await Promise.all(AppState.shows.map(show => refreshShowStatus(show)));

    const filteredSeries = AppState.shows.filter(show => filterProfileSeries(show));
    const filteredMovies = AppState.movies.filter(movie => filterProfileMovies(movie));

    seriesContainer.innerHTML = renderProfileCards(filteredSeries, 'tv');
    moviesContainer.innerHTML = renderProfileCards(filteredMovies, 'movie');
}

function filterProfileSeries(show) {
    const status = normalizeStatus(show.estado);
    if (AppState.profileSeriesFilter === 'all') return true;
    return status === AppState.profileSeriesFilter;
}

function filterProfileMovies(movie) {
    const status = normalizeStatus(movie.estado);
    if (AppState.profileMoviesFilter === 'all') return true;
    if (AppState.profileMoviesFilter === 'completed') return status === 'completed';
    return status !== 'completed';
}

function renderProfileCards(items, type) {
    if (items.length === 0) {
        return `
            <div class="text-center col-span-full py-10 text-gray-500 dark:text-gray-400">
                <div class="text-3xl mb-3">${type === 'tv' ? '📺' : '🎬'}</div>
                <p>No hay contenido en esta categoría</p>
            </div>`;
    }

    return items.map(item => {
        const personalRating = item.puntuacion && item.puntuacion > 0 ? item.puntuacion : null;

        return `
        <div class="profile-card cursor-pointer hover:shadow-xl transition flex flex-col items-center w-full" onclick="openDetail('${type}', ${item.id_tmdb})">
            <div class="relative aspect-[2/3] bg-gray-200 dark:bg-gray-700 rounded-lg overflow-hidden mb-3 w-full max-w-[170px]">
                ${item.portada ? `<img src="${item.portada}" alt="${item.titulo}" class="w-full h-full object-cover">` : '<div class="w-full h-full flex items-center justify-center text-3xl">🎬</div>'}
                ${personalRating !== null ? `
                    <div class="absolute top-2 right-2 rounded-full bg-black/75 text-white px-2.5 py-1 text-xs font-bold shadow-lg backdrop-blur-sm">
                        ⭐ ${Number(personalRating).toFixed(1)}
                    </div>
                ` : ''}
            </div>
            <h3 class="font-semibold text-sm truncate w-full text-center">${item.titulo}</h3>
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">${getStatusBadge(item.estado)}</p>
        </div>
    `;
    }).join('');
}

/**
 * Renderiza la pestaña Ajustes
 */
function renderSettings() {
    if (typeof window.isAuthenticated === 'function') {
        updateDriveStatus(window.isAuthenticated());
    }
}

function renderExplore() {
    // No-op: la vista usa el input de búsqueda y renderSearchResults directamente.
}

function isItemAlreadyAdded(type, id_tmdb) {
    if (type === 'movie') {
        return AppState.movies.some(movie => movie.id_tmdb === id_tmdb);
    }

    return AppState.shows.some(show => show.id_tmdb === id_tmdb);
}

function normalizeStatus(status) {
    const normalized = (status || 'pending').toLowerCase();
    if (normalized === 'siguiendo') return 'watching';
    if (normalized === 'terminada') return 'completed';
    if (normalized === 'pendiente') return 'pending';
    if (normalized === 'abandonado') return 'dropped';
    if (normalized === 'completado') return 'completed';
    if (normalized === 'vista') return 'completed';
    return normalized;
}

function getSeasonLabel(season) {
    if (season?.especial || season?.numero === 0) {
        return 'Especiales';
    }
    return season?.nombre || `Temporada ${season?.numero || 1}`;
}

function formatEpisodeLabel(seasonNumber, episodeNumber) {
    return `T${String(seasonNumber || 0).padStart(2, '0')} | E${String(episodeNumber || 0).padStart(2, '0')}`;
}

function isEpisodeAired(episode) {
    if (!episode?.air_date) {
        return true;
    }

    const releaseDate = new Date(`${episode.air_date}T00:00:00`);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return releaseDate <= today;
}

async function getOrderedEpisodes(show, options = {}) {
    const includeSpecials = options.includeSpecials !== false;
    const seasons = (show.temporadas || []).filter(season => includeSpecials || !season.especial);

    try {
        const seasonDetailsList = await Promise.all(seasons.map(async season => {
            const details = await getSeasonDetails(show.id_tmdb, season.numero);
            return (details?.episodes || []).map(episode => ({
                id: `S${String(season.numero).padStart(2, '0')}E${String(episode.episode_number).padStart(2, '0')}`,
                name: episode.name,
                overview: episode.overview,
                air_date: episode.air_date,
                seasonNumber: season.numero,
                episodeNumber: episode.episode_number,
                still_path: episode.still_path,
                especial: Boolean(season.especial || season.numero === 0),
            }));
        }));

        const allEpisodes = seasonDetailsList.flat();
        allEpisodes.sort((a, b) => {
            if (a.seasonNumber === b.seasonNumber) {
                return a.episodeNumber - b.episodeNumber;
            }
            return a.seasonNumber - b.seasonNumber;
        });

        return allEpisodes;
    } catch (error) {
        console.error('[App] Error obteniendo episodios:', error);
        return [];
    }
}

async function refreshShowStatus(show) {
    if (!show) return show;

    const previousState = normalizeStatus(show.estado);

    if (show.tipo !== 'tv') {
        show.estado = previousState;
        return show;
    }

    const regularSeasons = (show.temporadas || []).filter(season => !season.especial && season.numero !== 0);
    if (regularSeasons.length === 0) {
        show.estado = previousState;
        return show;
    }

    const episodes = await getOrderedEpisodes(show, { includeSpecials: false });
    const airedEpisodes = episodes.filter(isEpisodeAired);
    const watchedEpisodes = airedEpisodes.filter(ep => show.capitulos_vistos?.includes(ep.id));

    if (previousState === 'dropped') {
        show.estado = 'dropped';
        return show;
    }

    if (previousState === 'completed') {
        show.estado = watchedEpisodes.length === airedEpisodes.length ? 'completed' : 'watching';
        if (show.estado !== previousState) {
            saveLocalData();
        }
        return show;
    }

    if (previousState === 'watching' || previousState === 'pending') {
        show.estado = previousState;
        return show;
    }

    if (airedEpisodes.length === 0) {
        show.estado = watchedEpisodes.length > 0 ? 'watching' : 'pending';
    } else if (watchedEpisodes.length === airedEpisodes.length) {
        show.estado = 'completed';
    } else if (watchedEpisodes.length > 0) {
        show.estado = 'watching';
    } else {
        show.estado = 'pending';
    }

    return show;
}

/**
 * Renderiza los resultados de búsqueda
 * @param {Array} results - Resultados de búsqueda
 */
function renderSearchResults(results) {
    AppState.lastSearchResults = results || [];
    const grid = document.getElementById('search-results');

    if (!AppState.lastSearchResults.length) {
        grid.innerHTML = `
            <div class="text-center col-span-full py-12 text-gray-500 dark:text-gray-400">
                <div class="text-4xl mb-4">🔍</div>
                <p>No se encontraron resultados</p>
            </div>
        `;
        return;
    }

    grid.innerHTML = AppState.lastSearchResults.map(item => {
        const added = isItemAlreadyAdded(item.tipo, item.id_tmdb);

        return `
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
                    onclick="${added ? '' : `addItem('${item.tipo}', ${item.id_tmdb})` }"
                    class="w-full px-3 py-2 rounded-lg text-xs font-medium transition ${added ? 'bg-gray-600 text-white cursor-not-allowed' : 'bg-primary text-white hover:bg-primary/90'}"
                    ${added ? 'disabled' : ''}
                >
                    ${added ? 'Añadida' : '+ Añadir'}
                </button>
            </div>
        </div>`;
    }).join('');
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
        const sortedSeasons = [...(show.temporadas || [])].sort((a, b) => {
            if (a.especial === b.especial) {
                return a.numero - b.numero;
            }
            return a.especial ? 1 : -1;
        });
        
        for (const season of sortedSeasons) {
            const seasonDetails = await getSeasonDetails(show.id_tmdb, season.numero);
            const seasonId = `season-${season.numero}`;
            const seasonKey = `${show.id_tmdb}-season-${season.numero}`;
            const seasonLabel = getSeasonLabel(season);
            
            // Contar episodios vistos en esta temporada (solo episodios emitidos)
            const seasonEpisodeIds = seasonDetails.episodes
                .filter(isEpisodeAired)
                .map(ep => `S${String(season.numero).padStart(2, '0')}E${String(ep.episode_number).padStart(2, '0')}`);
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
                                <h4 class="font-semibold text-sm">${seasonLabel}</h4>
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
                const episodeLabel = formatEpisodeLabel(season.numero, episode.episode_number);
                const isWatched = show.capitulos_vistos?.includes(episodeId);
                const episodeImage = episode.still_path ? getImageUrl(episode.still_path, 'w185') : null;
                const episodeOverview = episode.overview || 'Sin descripción';
                const aired = isEpisodeAired(episode);
                
                episodesHTML += `
                    <div class="flex items-start gap-2 p-2 bg-white dark:bg-gray-800 rounded hover:bg-gray-50 dark:hover:bg-gray-700 transition">
                        <input 
                            type="checkbox" 
                            id="ep-${episodeId}"
                            data-show="${show.id_tmdb}"
                            data-season="${season.numero}"
                            data-episode="${episodeId}"
                            data-aired="${aired}"
                            ${isWatched ? 'checked' : ''}
                            ${aired ? '' : 'disabled'}
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
                                    <span class="font-medium text-xs">${episodeLabel}</span>
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
async function toggleEpisodeAndUpdateSeason(id_tmdb, episode, seasonNumber, seasonId) {
    const show = AppState.shows.find(s => s.id_tmdb === id_tmdb);
    if (!show) return;

    const episodes = await getOrderedEpisodes(show, { includeSpecials: false });
    const targetEpisode = episodes.find(ep => ep.id === episode);

    if (targetEpisode && !isEpisodeAired(targetEpisode)) {
        showToast('No puedes marcar episodios con fecha posterior a la actual');
        return;
    }

    if (!show.capitulos_vistos) {
        show.capitulos_vistos = [];
    }

    const index = show.capitulos_vistos.indexOf(episode);
    if (index > -1) {
        show.capitulos_vistos.splice(index, 1);
    } else {
        show.capitulos_vistos.push(episode);
    }

    await refreshShowStatus(show);
    saveLocalData();
    syncToDrive();

    const seasonContent = document.getElementById(seasonId);
    let seasonEpisodeIds = [];
    if (seasonContent) {
        const episodeCheckboxes = seasonContent.querySelectorAll('input[id^="ep-"]');
        seasonEpisodeIds = Array.from(episodeCheckboxes)
            .filter(cb => cb.dataset.aired !== 'false')
            .map(cb => cb.id.replace(/^ep-/, ''));
    }

    updateSeasonUI(id_tmdb, seasonNumber, seasonEpisodeIds, seasonId);
    if (AppState.selectedItem?.tipo === 'tv' && AppState.selectedItem.id_tmdb === id_tmdb) {
        AppState.selectedItem = { ...show, tipo: 'tv' };
        await renderEpisodes(AppState.selectedItem);
    }
    renderCurrentView();
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
async function toggleSeasonWatched(id_tmdb, seasonNumber, seasonId, event) {
    const show = AppState.shows.find(s => s.id_tmdb === id_tmdb);
    if (!show) return;

    if (!show.capitulos_vistos) {
        show.capitulos_vistos = [];
    }

    const watched = event.target.checked;

    const seasonContent = document.getElementById(seasonId);
    let episodeIds = [];
    if (seasonContent) {
        const episodeCheckboxes = seasonContent.querySelectorAll('input[id^="ep-"]');
        episodeIds = Array.from(episodeCheckboxes)
            .filter(cb => cb.dataset.aired !== 'false')
            .map(cb => cb.id.replace(/^ep-/, ''));
    }

    if (watched && episodeIds.length === 0) {
        showToast('No hay episodios disponibles para marcar en esta temporada');
        return;
    }

    episodeIds.forEach(episodeId => {
        const index = show.capitulos_vistos.indexOf(episodeId);
        if (watched) {
            if (index === -1) show.capitulos_vistos.push(episodeId);
        } else {
            if (index > -1) show.capitulos_vistos.splice(index, 1);
        }
    });

    await refreshShowStatus(show);
    saveLocalData();
    syncToDrive();

    episodeIds.forEach(episodeId => {
        const checkbox = document.getElementById(`ep-${episodeId}`);
        if (checkbox) {
            checkbox.checked = watched;
        }
    });

    updateSeasonUI(id_tmdb, seasonNumber, episodeIds, seasonId);
    if (AppState.selectedItem?.tipo === 'tv' && AppState.selectedItem.id_tmdb === id_tmdb) {
        AppState.selectedItem = { ...show, tipo: 'tv' };
        await renderEpisodes(AppState.selectedItem);
    }
    renderCurrentView();
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
            posterContainer.innerHTML = `<img src="${item.portada}" alt="${item.titulo}" class="w-full h-full object-contain rounded-lg bg-black/5">`;
        } else {
            posterContainer.innerHTML = '<span class="text-4xl">🎬</span>';
        }

        if (type === 'tv') {
            if (!item.watch_providers || item.watch_providers.length === 0) {
                const watchProviders = await window.getWatchProviders?.('tv', item.id_tmdb);
                if (watchProviders?.length) {
                    item.watch_providers = watchProviders;
                }
            }

            const watchProvidersContainer = document.getElementById('modal-watch-providers');
            if (item.watch_providers?.length) {
                watchProvidersContainer.classList.remove('hidden');
                watchProvidersContainer.innerHTML = `
                    <div class="rounded-xl border border-gray-200 dark:border-gray-700 bg-white/60 dark:bg-dark-card/70 p-3">
                        <p class="text-sm font-semibold text-gray-900 dark:text-white mb-3">Dónde ver</p>
                        <div class="flex flex-wrap gap-2">
                            ${item.watch_providers.map(provider => `
                                <div class="inline-flex items-center gap-2 rounded-full bg-gray-100 dark:bg-dark-input px-3 py-1.5 text-sm">
                                    ${provider.logo_path ? `<img src="${window.getImageUrl(provider.logo_path, 'w92')}" alt="${provider.provider_name}" class="h-5 w-5 rounded-full object-cover">` : ''}
                                    <span class="text-gray-800 dark:text-gray-100">${provider.provider_name}</span>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                `;
            } else {
                watchProvidersContainer.classList.add('hidden');
                watchProvidersContainer.innerHTML = '';
            }
        } else {
            const watchProvidersContainer = document.getElementById('modal-watch-providers');
            watchProvidersContainer.classList.add('hidden');
            watchProvidersContainer.innerHTML = '';
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
async function saveContent() {
    if (!AppState.selectedItem) return;
    
    const item = AppState.selectedItem;
    const rating = parseFloat(document.getElementById('modal-rating-input').value) || 0;
    const status = document.getElementById('modal-status').value;
    
    updateRating(item.tipo, item.id_tmdb, rating);
    await updateStatus(item.tipo, item.id_tmdb, status);
    
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
        renderSearchResults(AppState.lastSearchResults);
        return;
    }

    if (type === 'movie') {
        await addMovie({ id_tmdb, tipo: 'movie' });
    } else {
        await addShow({ id_tmdb, tipo: 'tv' });
    }

    renderSearchResults(AppState.lastSearchResults);
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
    AppState.isDriveConnected = !!connected;

    const statusDiv = document.getElementById('drive-status');
    const connectBtn = document.getElementById('btn-connect-drive');
    const disconnectBtn = document.getElementById('btn-disconnect-drive');

    console.log('[App] Elementos DOM:', { statusDiv, connectBtn, disconnectBtn });

    if (!statusDiv || !connectBtn || !disconnectBtn) {
        console.warn('[App] No se encontraron elementos de UI de Drive');
        return;
    }

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

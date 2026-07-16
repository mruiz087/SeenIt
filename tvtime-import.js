/**
 * Importador TV Show Time → SeenIt (vía TMDB find por IMDB/TVDB)
 */

const TVTIME_STATUS_MAP = {
    continuing: 'watching',
    up_to_date: 'completed',
    not_started_yet: 'pending',
    watch_later: 'standby',
    stopped: 'dropped',
};

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function formatEpisodeId(seasonNumber, episodeNumber) {
    return `S${String(seasonNumber).padStart(2, '0')}E${String(episodeNumber).padStart(2, '0')}`;
}

function mapTvTimeShowStatus(status) {
    return TVTIME_STATUS_MAP[String(status || '').toLowerCase()] || 'pending';
}

function extractWatchedProgress(tvShow) {
    const capitulos_vistos = [];
    const capitulos_vistos_fecha = {};

    for (const season of tvShow.seasons || []) {
        if (season.is_specials || season.number === 0) continue;
        for (const episode of season.episodes || []) {
            if (!episode.is_watched) continue;
            const id = formatEpisodeId(season.number, episode.number);
            capitulos_vistos.push(id);
            if (episode.watched_at) {
                const iso = String(episode.watched_at).includes('T')
                    ? new Date(episode.watched_at).toISOString()
                    : new Date(String(episode.watched_at).replace(' ', 'T') + 'Z').toISOString();
                if (!Number.isNaN(Date.parse(iso))) {
                    capitulos_vistos_fecha[id] = iso;
                }
            }
        }
    }

    return { capitulos_vistos, capitulos_vistos_fecha };
}

async function resolveMovieTmdbId(tvMovie) {
    const imdb = tvMovie?.id?.imdb;
    const tvdb = tvMovie?.id?.tvdb;
    let method = null;
    let id_tmdb = null;

    if (imdb) {
        const found = await findByExternalId(imdb, 'imdb_id');
        if (found.movieId) {
            id_tmdb = found.movieId;
            method = 'imdb';
        }
    }

    if (!id_tmdb && tvdb) {
        const found = await findByExternalId(tvdb, 'tvdb_id');
        // TVDB movie find is not officially supported for movies on TMDB; ignore if empty
        if (found.movieId) {
            id_tmdb = found.movieId;
            method = 'tvdb';
        }
    }

    if (!id_tmdb && tvMovie.title) {
        id_tmdb = await findMovieByTitleYear(tvMovie.title, tvMovie.year);
        if (id_tmdb) method = 'title_year';
    }

    return { id_tmdb, method };
}

async function resolveShowTmdbId(tvShow) {
    const tvdb = tvShow?.id?.tvdb;
    const imdb = tvShow?.id?.imdb;
    let method = null;
    let id_tmdb = null;

    if (tvdb) {
        const found = await findByExternalId(tvdb, 'tvdb_id');
        if (found.tvId) {
            id_tmdb = found.tvId;
            method = 'tvdb';
        }
    }

    if (!id_tmdb && imdb) {
        const found = await findByExternalId(imdb, 'imdb_id');
        if (found.tvId) {
            id_tmdb = found.tvId;
            method = 'imdb';
        }
    }

    if (!id_tmdb && tvShow.title) {
        const year = (tvShow.created_at || '').slice(0, 4) || null;
        id_tmdb = await findTVByTitleYear(tvShow.title, year);
        if (id_tmdb) method = 'title_year';
    }

    return { id_tmdb, method };
}

/**
 * @param {Object} options
 * @param {Array} [options.series]
 * @param {Array} [options.movies]
 * @param {Function} [options.onProgress]
 * @param {boolean} [options.replace=false]
 */
async function importTvTimeLibrary(options = {}) {
    const series = Array.isArray(options.series) ? options.series : [];
    const movies = Array.isArray(options.movies) ? options.movies : [];
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    const replace = Boolean(options.replace);

    const report = {
        seriesImported: 0,
        moviesImported: 0,
        seriesUpdated: 0,
        moviesUpdated: 0,
        notFound: [],
        errors: [],
    };

    if (replace) {
        AppState.movies = [];
        AppState.shows = [];
        AppState.lists = [];
    }

    const total = series.length + movies.length;
    let done = 0;

    for (const tvShow of series) {
        done += 1;
        onProgress({
            phase: 'series',
            current: done,
            total,
            title: tvShow.title || 'Serie',
        });

        try {
            const { id_tmdb, method } = await resolveShowTmdbId(tvShow);
            if (!id_tmdb) {
                report.notFound.push({
                    tipo: 'tv',
                    title: tvShow.title || 'Sin título',
                    tvdb: tvShow.id?.tvdb || null,
                    imdb: tvShow.id?.imdb || null,
                    reason: 'Sin match TMDB',
                });
                await sleep(120);
                continue;
            }

            const details = await getTVDetails(id_tmdb);
            const progress = extractWatchedProgress(tvShow);
            const estado = mapTvTimeShowStatus(tvShow.status);
            const existing = AppState.shows.find(s => s.id_tmdb === id_tmdb);

            const merged = {
                ...details,
                ...(existing || {}),
                ...details,
                estado,
                capitulos_vistos: progress.capitulos_vistos,
                capitulos_vistos_fecha: {
                    ...(existing?.capitulos_vistos_fecha || {}),
                    ...progress.capitulos_vistos_fecha,
                },
                id_tvdb: tvShow.id?.tvdb || existing?.id_tvdb || null,
                id_imdb: tvShow.id?.imdb || existing?.id_imdb || null,
                episodios_vistos_count: progress.capitulos_vistos.length,
                import_method: method,
            };

            if (existing) {
                Object.assign(existing, merged);
                report.seriesUpdated += 1;
            } else {
                AppState.shows.push(normalizeStoredShow(merged));
                report.seriesImported += 1;
            }
        } catch (error) {
            console.error('[TVTimeImport] Serie:', tvShow.title, error);
            report.errors.push({ tipo: 'tv', title: tvShow.title, error: String(error.message || error) });
        }

        if (done % 10 === 0) {
            saveLocalData();
        }
        await sleep(150);
    }

    for (const tvMovie of movies) {
        done += 1;
        onProgress({
            phase: 'movies',
            current: done,
            total,
            title: tvMovie.title || 'Película',
        });

        try {
            const { id_tmdb, method } = await resolveMovieTmdbId(tvMovie);
            if (!id_tmdb) {
                report.notFound.push({
                    tipo: 'movie',
                    title: tvMovie.title || 'Sin título',
                    tvdb: tvMovie.id?.tvdb || null,
                    imdb: tvMovie.id?.imdb || null,
                    year: tvMovie.year || null,
                    reason: 'Sin match TMDB',
                });
                await sleep(120);
                continue;
            }

            const details = await getMovieDetails(id_tmdb);
            const estado = tvMovie.is_watched ? 'completed' : 'pending';
            const existing = AppState.movies.find(m => m.id_tmdb === id_tmdb);

            const merged = {
                ...details,
                ...(existing || {}),
                ...details,
                estado,
                id_tvdb: tvMovie.id?.tvdb || existing?.id_tvdb || null,
                id_imdb: tvMovie.id?.imdb || existing?.id_imdb || null,
                import_method: method,
                puntuacion: existing?.puntuacion || 0,
            };

            if (existing) {
                Object.assign(existing, merged);
                report.moviesUpdated += 1;
            } else {
                AppState.movies.push(normalizeStoredMovie(merged));
                report.moviesImported += 1;
            }
        } catch (error) {
            console.error('[TVTimeImport] Película:', tvMovie.title, error);
            report.errors.push({ tipo: 'movie', title: tvMovie.title, error: String(error.message || error) });
        }

        if (done % 10 === 0) {
            saveLocalData();
        }
        await sleep(150);
    }

    saveLocalData();
    syncToDrive();
    return report;
}

/**
 * Importa listas de TV Show Time.
 * Listas mixtas se parten en dos (series / películas).
 * Títulos no presentes en la biblioteca se añaden como pending.
 *
 * @param {Object} options
 * @param {Array} options.lists
 * @param {Function} [options.onProgress]
 */
async function importTvTimeLists(options = {}) {
    const lists = Array.isArray(options.lists) ? options.lists : [];
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};

    const report = {
        listsImported: 0,
        listsUpdated: 0,
        listItemsAdded: 0,
        notFound: [],
        errors: [],
    };

    const totalItems = lists.reduce((sum, list) => sum + (list.items?.length || 0), 0) || lists.length;
    let done = 0;

    for (const rawList of lists) {
        const listName = String(rawList?.name || 'Lista').trim() || 'Lista';
        const items = Array.isArray(rawList?.items) ? [...rawList.items] : [];
        items.sort((a, b) => (Number(a.custom_order) || 0) - (Number(b.custom_order) || 0));

        const buckets = { tv: [], movie: [] };

        for (const item of items) {
            done += 1;
            const title = item?.name || 'Sin título';
            onProgress({
                current: done,
                total: Math.max(totalItems, 1),
                title: `${listName}: ${title}`,
            });

            const rawType = String(item?.type || '').toLowerCase();
            const tipo = rawType === 'movie' || rawType === 'movies' ? 'movie' : 'tv';
            const tvdb = item?.tvdb_id || item?.id?.tvdb || null;
            const imdb = item?.imdb_id || item?.id?.imdb || null;

            try {
                let id_tmdb = null;

                if (tipo === 'tv') {
                    if (tvdb) {
                        const found = await findByExternalId(tvdb, 'tvdb_id');
                        id_tmdb = found.tvId || null;
                    }
                    if (!id_tmdb && imdb) {
                        const found = await findByExternalId(imdb, 'imdb_id');
                        id_tmdb = found.tvId || null;
                    }
                    if (!id_tmdb && title) {
                        id_tmdb = await findTVByTitleYear(title, null);
                    }
                } else {
                    if (imdb) {
                        const found = await findByExternalId(imdb, 'imdb_id');
                        id_tmdb = found.movieId || null;
                    }
                    if (!id_tmdb && title) {
                        id_tmdb = await findMovieByTitleYear(title, null);
                    }
                }

                if (!id_tmdb) {
                    report.notFound.push({
                        tipo,
                        title,
                        tvdb,
                        imdb,
                        list: listName,
                        reason: 'Sin match TMDB',
                    });
                    await sleep(120);
                    continue;
                }

                const existing = tipo === 'movie'
                    ? AppState.movies.find(m => m.id_tmdb === id_tmdb)
                    : AppState.shows.find(s => s.id_tmdb === id_tmdb);

                if (!existing) {
                    if (tipo === 'movie') {
                        const details = await getMovieDetails(id_tmdb);
                        details.estado = 'pending';
                        AppState.movies.push(normalizeStoredMovie(details));
                    } else {
                        const details = await getTVDetails(id_tmdb);
                        details.estado = 'pending';
                        AppState.shows.push(normalizeStoredShow(details));
                    }
                }

                buckets[tipo].push(id_tmdb);
            } catch (error) {
                console.error('[TVTimeImport] Lista item:', title, error);
                report.errors.push({
                    tipo,
                    title,
                    list: listName,
                    error: String(error.message || error),
                });
            }

            await sleep(120);
        }

        for (const tipo of ['tv', 'movie']) {
            const ids = [...new Set(buckets[tipo])];
            if (!ids.length) continue;

            const name = buckets.tv.length && buckets.movie.length
                ? `${listName} (${tipo === 'movie' ? 'Películas' : 'Series'})`
                : listName;

            let list = AppState.lists.find(l =>
                l.tipo === tipo && l.name.toLowerCase() === name.toLowerCase()
            );

            if (!list) {
                list = normalizeStoredList({
                    id: `lst_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                    name,
                    tipo,
                    itemIds: [],
                    coverId: null,
                });
                AppState.lists.push(list);
                report.listsImported += 1;
            } else {
                report.listsUpdated += 1;
            }

            for (const id of ids) {
                if (!list.itemIds.includes(id)) {
                    list.itemIds.push(id);
                    report.listItemsAdded += 1;
                }
            }
            if (!list.coverId && list.itemIds.length) {
                list.coverId = list.itemIds[0];
            }
        }

        saveLocalData();
    }

    saveLocalData();
    syncToDrive();
    return report;
}

window.importTvTimeLibrary = importTvTimeLibrary;
window.importTvTimeLists = importTvTimeLists;
console.log('[TVTimeImport] tvtime-import.js cargado');

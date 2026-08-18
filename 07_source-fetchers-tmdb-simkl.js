// --- Simkl trending charts --------------------------------------------------
//
// Unlike Trakt/TMDB charts, these aren't a real paginated API -- Simkl
// publishes pre-built static JSON files (today/week/month trending, split
// by movies/tv/anime) to a CDN, refreshed on their own schedule. So like
// mdblist, we fetch the whole file and slice it locally for paging, rather
// than translating `skip` into a page number.
const SIMKL_CHART_FILES = {
  today: "today_100",
  week: "week_100",
  month: "month_100",
};

// Simkl's items use the same { ids: { imdb, tmdb, ... } } shape Trakt's do.
// Anime entries more often lack an IMDB id than movies/TV do (per Simkl's
// own docs: "IMDB IDs where available") -- those just get filtered out,
// same as any other source's imdb-less items, since this add-on always
// keys catalog items by IMDB id.
function mapSimklItems(data, type) {
  const items = Array.isArray(data) ? data : [];
  return items
    .filter((it) => it && it.ids && it.ids.imdb)
    .map((it) => ({
      id: it.ids.imdb,
      type,
      name: it.title,
      poster: `https://images.metahub.space/poster/medium/${it.ids.imdb}/img`,
      releaseInfo: it.year ? String(it.year) : undefined,
    }));
}

// chartKey is either a plain time window ("today"/"week"/"month" -- movies
// or tv, chosen by entry.type same as every other chart source here) or
// "anime-<window>" for the dedicated Anime Trending row, which always
// pulls the anime category regardless of entry.type (anime trending mixes
// movies and series under one Simkl category, so there's no clean
// movie/series split to key off of -- see SIMKL_ANIME_LIST below).
async function fetchSimklChart(entry, skip, clientId, chartKey) {
  if (!clientId) {
    throw new Error(
      "Simkl charts aren't configured on this add-on yet — the Worker owner needs to set SIMKL_CLIENT_ID."
    );
  }
  const isAnime = chartKey.startsWith("anime-");
  const windowKey = isAnime ? chartKey.slice("anime-".length) : chartKey;
  const file = SIMKL_CHART_FILES[windowKey] || SIMKL_CHART_FILES.today;
  const category = isAnime ? "anime" : entry.type === "series" ? "tv" : "movies";

  const src =
    `https://data.simkl.in/discover/trending/${category}/${file}.json` +
    `?client_id=${encodeURIComponent(clientId)}&app-name=my-lists-addon&app-version=${encodeURIComponent(ADDON_VERSION)}`;
  const res = await fetch(src, {
    headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
    cf: { cacheTtl: 3600, cacheEverything: true },
  });
  if (!res.ok) {
    throw new Error(`Simkl chart request failed (HTTP ${res.status}).`);
  }

  const data = await res.json();
  const metas = mapSimklItems(data, entry.type);
  return enrichTrailers(metas.slice(skip, skip + PAGE_SIZE), entry.type, TMDB_API_KEY);
}

// Maps our own entry.type ("movie"/"series") to the right path for each of
// Trakt's official chart endpoints. box_office has no shows equivalent --
// weekly box-office gross is inherently a theatrical-movies concept.
const TRAKT_CHART_PATHS = {
  trending: { movie: "movies/trending", series: "shows/trending" },
  popular: { movie: "movies/popular", series: "shows/popular" },
  most_played: { movie: "movies/played/weekly", series: "shows/played/weekly" },
  most_watched: { movie: "movies/watched/weekly", series: "shows/watched/weekly" },
  most_collected: { movie: "movies/collected/weekly", series: "shows/collected/weekly" },
  most_favorited: { movie: "movies/favorited/weekly", series: "shows/favorited/weekly" },
  most_anticipated: { movie: "movies/anticipated", series: "shows/anticipated" },
  box_office: { movie: "movies/boxoffice" },
};

// Pulls one of Trakt's own official charts (trending/most-watched/most-
// collected/box-office), as opposed to fetchTrakt above which pulls a
// specific user's list. These endpoints all wrap each item as
// {movie: {...}} or {show: {...}} plus some stats fields (watchers,
// revenue, etc. depending on chart) -- the same shape fetchTrakt's user-list
// endpoint returns, so mapTraktItems handles both without changes.
async function fetchTraktChart(entry, skip, traktKey, chartKey) {
  if (!traktKey) {
    throw new Error(
      "Trakt charts aren't configured on this add-on yet — the Worker owner needs to set TRAKT_CLIENT_ID."
    );
  }
  const wantKind = entry.type === "series" ? "series" : "movie";
  const pathMap = TRAKT_CHART_PATHS[chartKey];
  const chartPath = pathMap && pathMap[wantKind];
  if (!chartPath) {
    throw new Error("Trakt doesn't publish a shows version of this chart.");
  }

  const page = Math.floor(skip / PAGE_SIZE) + 1;
  const src = `https://api.trakt.tv/${chartPath}?limit=${PAGE_SIZE}&page=${page}`;
  const res = await fetch(src, {
    headers: {
      "Content-Type": "application/json",
      "trakt-api-version": "2",
      "trakt-api-key": traktKey,
      "User-Agent": "my-list-addon/1.8",
    },
    cf: { cacheTtl: 900, cacheEverything: true },
  });
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? " Double-check the Trakt Client ID." : "";
    throw new Error(`Trakt chart request failed (HTTP ${res.status}).${hint}`);
  }

  const data = await res.json();
  return enrichTrailers(mapTraktItems(data, entry.type), entry.type, TMDB_API_KEY);
}

// Runs async `fn` over `items` with at most `limit` running at once, rather
// than firing them all in parallel. Used for TMDB's per-item external_ids
// lookups (see fetchTmdb below) so a single catalog page (up to PAGE_SIZE
// items) doesn't blow past TMDB's soft ~20-simultaneous-connections-per-IP
// limit and start drawing 429s.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// --- trailers -------------------------------------------------------------
//
// Stremio's meta object supports a trailerStreams field (YouTube-hosted
// trailer/teaser clips) that clients like wako show on the detail view.
// This add-on never implements a separate "meta" resource -- catalog items
// double as the full meta object -- so trailerStreams just needs to be
// attached to the same objects this file already builds.
//
// Picks the best YouTube trailer from a TMDB /videos-style results array:
// an official "Trailer" wins, a "Teaser" is the fallback, anything else
// (Clip, Featurette, Behind the Scenes) is ignored.
function pickTrailerKey(videosResults) {
  if (!Array.isArray(videosResults)) return null;
  const trailer =
    videosResults.find((v) => v.site === "YouTube" && v.type === "Trailer") ||
    videosResults.find((v) => v.site === "YouTube" && v.type === "Teaser");
  return trailer ? trailer.key : null;
}

function trailerStreamsFor(ytKey) {
  return ytKey ? [{ title: "Trailer", ytId: ytKey }] : undefined;
}

// For items that only carry an IMDB id (mdblist/Trakt sources never expose
// a TMDB id), resolving a trailer needs an extra round trip: TMDB's /find
// endpoint to translate imdb_id -> tmdb_id, then a /videos call on that id.
// Both legs are hard-cached at Cloudflare's edge (shared across every user
// of the add-on, same as fetchTmdbDetails below), so this only costs a real
// TMDB request the first time any list anywhere references a given title.
// Best-effort: any failure just means no trailer, never a broken catalog.
async function fetchTrailerForImdb(imdbId, type, apiKey) {
  if (!apiKey || !imdbId) return null;
  try {
    const findRes = await fetch(
      `https://api.themoviedb.org/3/find/${imdbId}?api_key=${encodeURIComponent(apiKey)}&external_source=imdb_id`,
      { headers: { "User-Agent": "my-list-addon/1.14" }, cf: { cacheTtl: 604800, cacheEverything: true } }
    );
    if (!findRes.ok) return null;
    const findData = await findRes.json();
    const kind = type === "series" ? "tv" : "movie";
    const resultsKey = kind === "tv" ? "tv_results" : "movie_results";
    const match = (findData[resultsKey] || [])[0];
    if (!match) return null;

    const videosRes = await fetch(
      `https://api.themoviedb.org/3/${kind}/${match.id}/videos?api_key=${encodeURIComponent(apiKey)}`,
      { headers: { "User-Agent": "my-list-addon/1.14" }, cf: { cacheTtl: 604800, cacheEverything: true } }
    );
    if (!videosRes.ok) return null;
    const videosData = await videosRes.json();
    return pickTrailerKey(videosData.results);
  } catch {
    return null;
  }
}

// Attaches trailerStreams to a batch of already-built metas (mdblist/Trakt
// sources only -- TMDB-sourced metas already get theirs for free via
// fetchTmdbDetails's append_to_response=videos, see below). Silently a
// no-op when no TMDB_API_KEY is configured on this Worker.
async function enrichTrailers(metas, type, apiKey) {
  if (!apiKey || !metas.length) return metas;
  await mapWithConcurrency(metas, 8, async (m) => {
    const ytKey = await fetchTrailerForImdb(m.id, type, apiKey);
    if (ytKey) m.trailerStreams = trailerStreamsFor(ytKey);
  });
  return metas;
}

// TMDB's list items only carry a TMDB id, not an IMDB id, so each item needs
// a follow-up call to resolve one. A title's external ids essentially never
// change once assigned, so this is cached hard (a week) at Cloudflare's
// edge — that cache is shared across every user of the add-on, so only the
// very first time *any* list anywhere references a given title does this
// cost a real TMDB request; every catalog load after that hits cache.
// Combines what used to be two separate needs -- resolving an IMDB id, and
// (now) fetching trailer videos -- into the single per-item TMDB request
// this add-on was already making, via append_to_response. Same hard-cached
// cost as before; trailers just ride along for free.
async function fetchTmdbDetails(tmdbId, kind, apiKey) {
  let cleanTmdbId = String(tmdbId || "").trim();
  while (cleanTmdbId.startsWith("tmdb:")) {
    cleanTmdbId = cleanTmdbId.slice(5).trim();
  }
  cleanTmdbId = cleanTmdbId.split(":")[0].trim();
  const src = `https://api.themoviedb.org/3/${kind}/${cleanTmdbId}?api_key=${encodeURIComponent(
    apiKey
  )}&append_to_response=external_ids,videos`;
  const res = await fetch(src, {
    headers: { "User-Agent": "my-list-addon/1.14" },
    cf: { cacheTtl: 604800, cacheEverything: true },
  });
  if (!res.ok) return { imdbId: null, videos: null };
  const data = await res.json();
  const imdbId = (data.external_ids && data.external_ids.imdb_id) || data.imdb_id || null;
  const videos = (data.videos && data.videos.results) || null;
  return { imdbId, videos };
}

// Pulls a public themoviedb.org list via TMDB's v4 List Details endpoint.
// NOTE: we deliberately use v4 here, not v3 — v3's /list/{id} endpoint does
// not reliably paginate (TMDB's own support has pointed people at v4 for
// exactly this "my list has more items than I'm getting back" problem), while
// v4 documents proper 20-items-per-page pagination with page/total_pages.
// v4's GET endpoints still accept the same plain api_key query param as v3
// (no separate bearer/read-access token needed), so this uses the same key
// as everything else in this add-on.
//
// v4 list items always carry a media_type ("movie" or "tv"), since v4 lists
// support mixing both — we filter to whichever this catalog row wants.
//
// Every item from a TMDB list only carries a TMDB id -- Stremio/wako
// protocol needs an IMDB id (or a "tmdb:<id>" fallback if none exists). We
// resolve each item's IMDB id in parallel using fetchTmdbDetails (which
// also pulls trailer videos for free), capped at TMDB_LIST_PAGE_SIZE items
// per page.
const TMDB_LIST_PAGE_SIZE = 20;

async function fetchTmdb(entry, skip = 0, apiKey = "") {
  if (!apiKey) {
    throw new Error(
      "TMDB lists aren't configured on this add-on yet — the Worker owner needs to set TMDB_API_KEY."
    );
  }

  const isAccountWatchlist = entry.url && entry.url.startsWith("tmdb:account:watchlist");
  const isAccountFavorites = entry.url && entry.url.startsWith("tmdb:account:favorites");
  const listId = !isAccountWatchlist && !isAccountFavorites ? tmdbListId(entry.url) : null;
  if (!listId && !isAccountWatchlist && !isAccountFavorites) {
    throw new Error(
      "Couldn't parse that as a themoviedb.org list URL (expected themoviedb.org/list/LIST_ID)."
    );
  }

  const wantKind = entry.type === "series" ? "tv" : "movie";
  const MAX_PAGES = 150; // 150 * 20 = 3000 items; a generous ceiling for personal lists
  const filtered = [];
  let tmdbPage = 1;
  let totalPages = 1;

  while (filtered.length < skip + PAGE_SIZE && tmdbPage <= Math.min(totalPages, MAX_PAGES)) {
    let src = "";
    if (isAccountWatchlist || isAccountFavorites) {
      const endpoint = isAccountWatchlist ? "watchlist" : "favorite";
      src = `https://api.themoviedb.org/3/account/{account_id}/${endpoint}/${wantKind}?api_key=${encodeURIComponent(apiKey)}&page=${tmdbPage}`;
    } else {
      src = `https://api.themoviedb.org/4/list/${listId}?api_key=${encodeURIComponent(
        apiKey
      )}&page=${tmdbPage}`;
    }
    const res = await fetch(src, {
      headers: { "User-Agent": "my-list-addon/1.6" },
      cf: { cacheTtl: 900, cacheEverything: true },
    });
    if (!res.ok) {
      if (tmdbPage === 1) {
        const hint =
          res.status === 404
            ? " Double-check the list exists and is public."
            : res.status === 401 || res.status === 403
            ? " Double-check the TMDB API key."
            : "";
        throw new Error(`TMDB request failed (HTTP ${res.status}).${hint}`);
      }
      break; // a later page failing shouldn't blank out items we already have
    }

    const data = await res.json();
    // Prefer v4's documented "results" array; fall back to "items" in case
    // a particular list still returns the legacy v3-style shape.
    const items = Array.isArray(data.results)
      ? data.results
      : Array.isArray(data.items)
      ? data.items
      : [];
    if (items.length === 0) break; // no more pages
    if (typeof data.total_pages === "number" && data.total_pages > 0) {
      totalPages = data.total_pages;
    }

    for (const it of items) {
      const kind = it.media_type === "tv" || it.media_type === "movie" ? it.media_type : wantKind;
      if (kind === wantKind) filtered.push(it);
    }
    tmdbPage++;
  }

  const page = filtered.slice(skip, skip + PAGE_SIZE);

  const resolved = await mapWithConcurrency(page, 12, async (it) => {
    const { imdbId, videos } = await fetchTmdbDetails(it.id, wantKind, apiKey);
    if (!imdbId) return null;
    return mapTmdbItem(it, imdbId, entry.type, videos);
  });

  return resolved.filter(Boolean);
}

async function fetchTmdbCollection(entry, skip = 0, apiKey = "") {
  if (!apiKey) {
    throw new Error(
      "TMDB collections aren't configured on this add-on yet — the Worker owner needs to set TMDB_API_KEY."
    );
  }

  const collectionId = typeof tmdbCollectionId === "function" ? tmdbCollectionId(entry.url) : null;
  if (!collectionId) {
    throw new Error("Couldn't parse that as a TMDB collection URL (expected themoviedb.org/collection/ID).");
  }

  const src = `https://api.themoviedb.org/3/collection/${encodeURIComponent(collectionId)}?api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(src, {
    headers: { "User-Agent": "my-list-addon/1.14" },
    cf: { cacheTtl: 86400, cacheEverything: true },
  });

  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(`TMDB collection ${collectionId} not found.`);
    }
    throw new Error(`TMDB request failed (HTTP ${res.status}).`);
  }

  const data = await res.json();
  const parts = Array.isArray(data.parts) ? data.parts : [];
  
  // Sort chronologically by release date
  parts.sort((a, b) => (a.release_date || "9999").localeCompare(b.release_date || "9999"));

  const windowItems = parts.slice(skip, skip + PAGE_SIZE);
  const resolved = await mapWithConcurrency(windowItems, 12, async (it) => {
    const { imdbId, videos } = await fetchTmdbDetails(it.id, "movie", apiKey);
    if (!imdbId) return null;
    return mapTmdbItem(it, imdbId, "movie", videos);
  });

  return resolved.filter(Boolean);
}

// Shared meta-shaping for any TMDB item (list, chart, wherever), once its
// IMDB id is known. TMDB's own poster_path/backdrop_path are already
// sitting right there in the response (zero extra requests), and cover
// obscure titles more reliably than metahub.space's IMDB-keyed poster
// database -- preferred over metahub, with metahub only as a fallback for
// the rare item missing a poster_path.
function mapTmdbItem(it, imdbId, type, videos) {
  return {
    id: imdbId,
    type,
    name: it.title || it.name,
    poster: it.poster_path
      ? `https://image.tmdb.org/t/p/w500${it.poster_path}`
      : `https://images.metahub.space/poster/medium/${imdbId}/img`,
    background: it.backdrop_path ? `https://image.tmdb.org/t/p/w1280${it.backdrop_path}` : undefined,
    releaseInfo: (it.release_date || it.first_air_date || "").slice(0, 4) || undefined,
    trailerStreams: trailerStreamsFor(pickTrailerKey(videos)),
  };
}

// Maps our own entry.type ("movie"/"series") to the right TMDB v3 endpoint
// for each official chart. now_playing/upcoming don't have exact TV
// equivalents on TMDB -- airing_today/on_the_air are the closest concepts,
// reused under the same display name for consistency with how the
// Trending/Popular quick-add panels already pair up a movie list and a
// show list under one shared catalog name.
//
// The provider-filtered entries below (netflix, disney, etc.) aren't
// official TMDB charts, but reuse the exact same pathMap[wantKind] shape
// (see fetchTmdbChart below) so they don't need their own fetcher --
// tmdbProviderChartPaths(id) builds a discover query with
// with_watch_providers=id, watch_region hardcoded to US (see the admin
// dashboard's Provider Preview tab for previewing other regions; making
// this region user-configurable per-entry is a separate, bigger change),
// and with_watch_monetization_types=flatrate so this only matches titles
// actually included with that service's subscription, not ones merely
// available to rent/buy through it. Provider ids were looked up and
// confirmed via that same Provider Preview tab -- TMDB is known to have
// more than one entry for some services (e.g. two separate "Disney Plus"
// ids), so these are NOT to be hand-edited from memory; re-verify through
// the lookup tool before changing any of them.
function tmdbProviderChartPaths(providerId) {
  const q = `with_watch_providers=${providerId}&watch_region=US&with_watch_monetization_types=flatrate&sort_by=popularity.desc`;
  return { movie: `discover/movie?${q}`, tv: `discover/tv?${q}` };
}

const TMDB_CHART_PATHS = {
  trending: { movie: "trending/movie/week", tv: "trending/tv/week" },
  popular: { movie: "movie/popular", tv: "tv/popular" },
  top_rated: { movie: "movie/top_rated", tv: "tv/top_rated" },
  now_playing: { movie: "movie/now_playing", tv: "tv/airing_today" },
  upcoming: { movie: "movie/upcoming", tv: "tv/on_the_air" },
  netflix: tmdbProviderChartPaths(8),
  netflixkids: tmdbProviderChartPaths(175),
  appletv: tmdbProviderChartPaths(350),
  disney: tmdbProviderChartPaths(337),
  hbomax: tmdbProviderChartPaths(1899),
  hulu: tmdbProviderChartPaths(15),
  discovery: tmdbProviderChartPaths(520),
  paramount: tmdbProviderChartPaths(2303),
  primevideo: tmdbProviderChartPaths(9),
  peacock: tmdbProviderChartPaths(387),
};

// Fetches a PAGE_SIZE window (starting at `skip`, optionally offset by an
// extra `pageOffset` pages -- used by Hidden Gems below for its daily
// reshuffle) from any standard, reliably-paginated TMDB v3 endpoint fixed
// at 20 items/page. Maps our own pagination onto exactly enough consecutive
// TMDB pages, fetched in parallel, and returns the raw TMDB result objects
// for that window (callers resolve IMDB ids / shape metas themselves).
// Shared by fetchTmdbChart and fetchTmdbHiddenGems so this math -- and its
// "skip may not land on a TMDB page boundary" edge case -- only lives once.
async function fetchTmdbPagedResults(pathAndQuery, apiKey, skip, pageOffset = 0) {
  const totalSkip = skip + pageOffset * 20;
  const firstTmdbPage = Math.floor(totalSkip / 20) + 1;
  const offsetWithinFirstPage = totalSkip % 20;
  // If the effective skip doesn't land on a clean TMDB page boundary, that
  // offset eats into the front of the fetched range -- fetch one extra
  // page's worth so trimming it still leaves a full PAGE_SIZE window
  // rather than coming up short at the tail.
  const pagesNeeded = Math.ceil((PAGE_SIZE + offsetWithinFirstPage) / 20);
  const pageNums = Array.from({ length: pagesNeeded }, (_, i) => firstTmdbPage + i);
  const sep = pathAndQuery.includes("?") ? "&" : "?";

  const pageResults = await Promise.all(
    pageNums.map(async (p) => {
      const src = `https://api.themoviedb.org/3/${pathAndQuery}${sep}api_key=${encodeURIComponent(
        apiKey
      )}&page=${p}`;
      const res = await fetch(src, {
        headers: { "User-Agent": "my-list-addon/1.9" },
        cf: { cacheTtl: 900, cacheEverything: true },
      });
      if (!res.ok) return { ok: false, status: res.status, items: [] };
      const data = await res.json();
      return { ok: true, items: Array.isArray(data.results) ? data.results : [] };
    })
  );

  if (!pageResults[0].ok) {
    const status = pageResults[0].status;
    const hint = status === 401 ? " Double-check the TMDB API key." : "";
    throw new Error(`TMDB request failed (HTTP ${status}).${hint}`);
  }

  const allItems = pageResults.flatMap((p) => p.items);
  return allItems.slice(offsetWithinFirstPage, offsetWithinFirstPage + PAGE_SIZE);
}

function getTmdbNewReleasesChartPath(wantKind) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (wantKind === "tv") {
    return `discover/tv?sort_by=popularity.desc&first_air_date.gte=${d30}&first_air_date.lte=${today}`;
  }
  return `discover/movie?sort_by=popularity.desc&primary_release_date.gte=${d30}&primary_release_date.lte=${today}`;
}

// Pulls one of TMDB's own official charts. Unlike fetchTmdb above (which
// fetches a specific user-curated list and has to walk pages defensively
// since v3's /list/{id} pagination is flaky), these are standard, reliably-
// paginated v3 endpoints -- see fetchTmdbPagedResults.
async function fetchTmdbChart(entry, skip, apiKey, chartKey) {
  if (!apiKey) {
    throw new Error(
      "TMDB charts aren't configured on this add-on yet — the Worker owner needs to set TMDB_API_KEY."
    );
  }
  const wantKind = entry.type === "series" ? "tv" : "movie";
  let chartPath;
  if (chartKey === "new_movies" || chartKey === "new_shows" || chartKey === "new_releases" || chartKey === "new") {
    chartPath = getTmdbNewReleasesChartPath(wantKind);
  } else {
    const pathMap = TMDB_CHART_PATHS[chartKey];
    chartPath = pathMap && pathMap[wantKind];
  }
  if (!chartPath) {
    throw new Error("This TMDB chart doesn't have a shows version.");
  }

  const windowItems = await fetchTmdbPagedResults(chartPath, apiKey, skip);

  const resolved = await mapWithConcurrency(windowItems, 12, async (it) => {
    const { imdbId, videos } = await fetchTmdbDetails(it.id, wantKind, apiKey);
    if (!imdbId) return null;
    return mapTmdbItem(it, imdbId, entry.type, videos);
  });

  return resolved.filter(Boolean);
}

// A hard-capped 10-item version of fetchTmdbChart, for the "Top 10" panel's
// provider rows (STREAMING_TOP10) -- fetchTmdbChart itself is unbounded and
// keeps paginating through the entire catalog as Stremio/wako scroll,
// which is correct for the full "Streaming Catalogs" panel but not for
// something labeled "Top 10". This exists specifically so pagination stops
// after 10, the same way the old hand-curated 10-item mdblist.com lists
// this replaced used to stop naturally once you'd scrolled through all of
// them -- TOP_N below is the only thing controlling that, not something
// TMDB itself expresses (their discover results are just popularity-
// sorted, uncapped).
async function fetchTmdbProviderTop10(entry, skip, apiKey, chartKey) {
  const TOP_N = 10;
  if (skip >= TOP_N) return []; // already gave everything -- tells the caller to stop paginating
  if (!apiKey) {
    throw new Error(
      "TMDB charts aren't configured on this add-on yet — the Worker owner needs to set TMDB_API_KEY."
    );
  }
  const wantKind = entry.type === "series" ? "tv" : "movie";
  const pathMap = TMDB_CHART_PATHS[chartKey];
  const chartPath = pathMap && pathMap[wantKind];
  if (!chartPath) {
    throw new Error("This TMDB chart doesn't have a shows version.");
  }
  // A single direct page-1 request -- TOP_N=10 always fits inside TMDB's
  // own 20-per-page results, so this deliberately skips
  // fetchTmdbPagedResults's own windowing (built for pulling up to
  // PAGE_SIZE=100 items across several concurrent TMDB pages, which here
  // would mean 5x more TMDB calls, and 5x more per-title detail lookups
  // below, than a top-10 list actually needs).
  const sep = chartPath.includes("?") ? "&" : "?";
  const src = `https://api.themoviedb.org/3/${chartPath}${sep}api_key=${encodeURIComponent(apiKey)}&page=1`;
  const res = await fetch(src, {
    headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
    cf: { cacheTtl: 900, cacheEverything: true },
  });
  if (!res.ok) {
    throw new Error(`TMDB request failed (HTTP ${res.status}).`);
  }
  const data = await res.json();
  const windowItems = (Array.isArray(data.results) ? data.results : []).slice(0, TOP_N);

  const resolved = await mapWithConcurrency(windowItems, 12, async (it) => {
    const { imdbId, videos } = await fetchTmdbDetails(it.id, wantKind, apiKey);
    if (!imdbId) return null;
    return mapTmdbItem(it, imdbId, entry.type, videos);
  });
  // Slicing our own already-capped (at most 10-item) result against the
  // caller's real skip/PAGE_SIZE window -- returns [] once skip walks past
  // the 10th item, without any further TMDB calls.
  return resolved.filter(Boolean).slice(skip, skip + PAGE_SIZE);
}

// --- Hidden Gems: a no-personalization discovery shelf ---------------------
//
// For the "I'm scrolling and don't know what to watch" moment: well-
// reviewed titles that haven't been seen by a blockbuster-sized audience,
// via TMDB's discover endpoint filtered to a rating floor and a vote-count
// band that excludes both obscure/unreliable ratings (too few votes) and
// the same overexposed hits the Trending/Popular panels already surface
// (too many votes). These thresholds are a judgment call, not a precise
// science -- tune them here if the shelf feels too broad or too empty.
const HIDDEN_GEMS_MIN_RATING = 7.5;
const HIDDEN_GEMS_MIN_VOTES = 100;
const HIDDEN_GEMS_MAX_VOTES = 3000;
// How many TMDB discover pages to rotate the daily reshuffle through.
const HIDDEN_GEMS_PAGE_POOL = 40;

// Days-since-epoch in UTC -- used as a simple, stateless daily seed (no KV
// or other storage needed): the shelf shows a different slice of matching
// titles each day, but stays stable (and paginates correctly as someone
// scrolls) within that same day.
function daysSinceEpochUTC(d) {
  return Math.floor(d.getTime() / 86400000);
}

async function fetchTmdbHiddenGems(entry, skip, apiKey) {
  if (!apiKey) {
    throw new Error(
      "Hidden Gems isn't configured on this add-on yet — the Worker owner needs to set TMDB_API_KEY."
    );
  }
  const wantKind = entry.type === "series" ? "tv" : "movie";
  const discoverPath =
    `discover/${wantKind}?sort_by=vote_average.desc` +
    `&vote_average.gte=${HIDDEN_GEMS_MIN_RATING}` +
    `&vote_count.gte=${HIDDEN_GEMS_MIN_VOTES}` +
    `&vote_count.lte=${HIDDEN_GEMS_MAX_VOTES}` +
    `&include_adult=false`;

  const pageOffset = daysSinceEpochUTC(new Date()) % HIDDEN_GEMS_PAGE_POOL;
  const windowItems = await fetchTmdbPagedResults(discoverPath, apiKey, skip, pageOffset);

  const resolved = await mapWithConcurrency(windowItems, 12, async (it) => {
    const { imdbId, videos } = await fetchTmdbDetails(it.id, wantKind, apiKey);
    if (!imdbId) return null;
    return mapTmdbItem(it, imdbId, entry.type, videos);
  });

  return resolved.filter(Boolean);
}


async function fetchTmdbKids(entry, skip, apiKey, ratingGroup) {
  if (!apiKey) {
    throw new Error(
      "Kids lists aren't configured on this add-on yet - the Worker owner needs to set TMDB_API_KEY."
    );
  }
  const wantKind = entry.type === "series" ? "tv" : "movie";
  
  let certification = "";
  if (wantKind === "movie") {
    if (ratingGroup === "g") certification = "G";
    else if (ratingGroup === "pg") certification = "G|PG";
    else if (ratingGroup === "pg13") certification = "G|PG|PG-13";
  } else {
    if (ratingGroup === "g") certification = "TV-Y|TV-Y7|TV-G";
    else if (ratingGroup === "pg") certification = "TV-Y|TV-Y7|TV-G|TV-PG";
    else if (ratingGroup === "pg13") certification = "TV-Y|TV-Y7|TV-G|TV-PG|TV-14";
  }
  
  const discoverPath =
    "discover/" + wantKind + "?sort_by=popularity.desc" +
    "&certification_country=US&certification=" + certification +
    "&include_adult=false";

  const windowItems = await fetchTmdbPagedResults(discoverPath, apiKey, skip, 0);

  const resolved = await mapWithConcurrency(windowItems, 12, async (it) => {
    const { imdbId, videos } = await fetchTmdbDetails(it.id, wantKind, apiKey);
    if (!imdbId) return null;
    return mapTmdbItem(it, imdbId, entry.type, videos);
  });

  return resolved.filter(Boolean);
}

async function fetchTmdbItemDetails(imdbId, apiKey, fallbackType) {
  if (!apiKey || !imdbId) return null;
  let rawStr = String(imdbId).trim();
  let tmdbId = null;
  let type = (fallbackType === "series" || fallbackType === "tv") ? "tv" : (fallbackType === "movie" ? "movie" : null);

  while (rawStr.startsWith("tmdb:")) {
    rawStr = rawStr.slice(5).trim();
  }

  if (/^\d+/.test(rawStr) && rawStr.includes(":")) {
    tmdbId = rawStr.split(":")[0];
  } else if (/^\d+$/.test(rawStr)) {
    tmdbId = rawStr;
  }

  if (!tmdbId) {
    const baseImdbId = rawStr.startsWith("tt") ? rawStr.split(":")[0] : rawStr;
    const findSrc = "https://api.themoviedb.org/3/find/" + encodeURIComponent(baseImdbId) + "?api_key=" + encodeURIComponent(apiKey) + "&external_source=imdb_id";
    const findRes = await fetch(findSrc, {
      headers: { "User-Agent": "my-list-addon/1.14" },
      cf: { cacheTtl: 604800, cacheEverything: true },
    });
    if (findRes.ok) {
      const findData = await findRes.json();
      if (findData.movie_results && findData.movie_results.length > 0) {
        tmdbId = findData.movie_results[0].id;
        type = "movie";
      } else if (findData.tv_results && findData.tv_results.length > 0) {
        tmdbId = findData.tv_results[0].id;
        type = "tv";
      }
    }
  }
  if (!tmdbId) return null;

  let match = null;
  let resolvedType = type;
  if (resolvedType) {
    const detailSrc = "https://api.themoviedb.org/3/" + resolvedType + "/" + tmdbId + "?api_key=" + encodeURIComponent(apiKey) + "&append_to_response=videos,release_dates,content_ratings,external_ids,credits";
    const detailRes = await fetch(detailSrc, {
      headers: { "User-Agent": "my-list-addon/1.14" },
      cf: { cacheTtl: 604800, cacheEverything: true },
    });
    if (detailRes.ok) {
      match = await detailRes.json();
    }
  }
  if (!match) {
    // Try movie first
    const mSrc = "https://api.themoviedb.org/3/movie/" + tmdbId + "?api_key=" + encodeURIComponent(apiKey) + "&append_to_response=videos,release_dates,content_ratings,external_ids,credits";
    const mRes = await fetch(mSrc, {
      headers: { "User-Agent": "my-list-addon/1.14" },
      cf: { cacheTtl: 604800, cacheEverything: true },
    });
    if (mRes.ok) {
      match = await mRes.json();
      resolvedType = "movie";
    } else {
      // Try tv
      const tvSrc = "https://api.themoviedb.org/3/tv/" + tmdbId + "?api_key=" + encodeURIComponent(apiKey) + "&append_to_response=videos,release_dates,content_ratings,external_ids,credits";
      const tvRes = await fetch(tvSrc, {
        headers: { "User-Agent": "my-list-addon/1.14" },
        cf: { cacheTtl: 604800, cacheEverything: true },
      });
      if (tvRes.ok) {
        match = await tvRes.json();
        resolvedType = "tv";
      }
    }
  }
  if (!match || !resolvedType) return null;
  type = resolvedType;
  
  // Extract content rating (US fallback)
  let contentRating = null;
  if (type === "movie" && match.release_dates && match.release_dates.results) {
    const us = match.release_dates.results.find(r => r.iso_3166_1 === "US");
    if (us && us.release_dates.length > 0) {
      contentRating = us.release_dates.find(r => r.certification)?.certification;
    }
  } else if (type === "tv" && match.content_ratings && match.content_ratings.results) {
    const us = match.content_ratings.results.find(r => r.iso_3166_1 === "US");
    if (us) contentRating = us.rating;
  }
  
  // Extract trailer
  let trailerKey = null;
  if (match.videos && match.videos.results) {
    const trailer = match.videos.results.find((v) => v.site === "YouTube" && v.type === "Trailer") || 
                    match.videos.results.find((v) => v.site === "YouTube" && v.type === "Teaser");
    if (trailer) trailerKey = trailer.key;
  }

  // Extract cast and director
  let cast = undefined;
  let director = undefined;
  if (match.credits) {
    if (Array.isArray(match.credits.cast) && match.credits.cast.length > 0) {
      cast = match.credits.cast.slice(0, 8).map((c) => c.name).filter(Boolean);
    }
    if (Array.isArray(match.credits.crew) && match.credits.crew.length > 0) {
      const dirs = match.credits.crew.filter((c) => c.job === "Director").map((c) => c.name).filter(Boolean);
      if (dirs.length > 0) director = dirs;
    }
  }

  // Resolves the REAL IMDb id -- if the caller already had a real one,
  // keep using exactly that (no reason to trust TMDB's own external_ids
  // echo of what was already known); if the caller only had a bare
  // tmdb:<id> (Search Movies & TV Shows), this is the ONLY place that ever
  // turns it into a real IMDb id. Every downstream watched-status check or
  // save (toggleWatchStatus, markShowWatched, Watch History) keys off this
  // id -- without this, a title opened from Search silently tracked
  // watched-state under a literal "tmdb:12345" placeholder that nothing
  // else in the app ever recognized: marking it watched from Search never
  // showed up anywhere else, and a title already marked watched via
  // Discover/a chart never showed as watched when reopened from Search,
  // since the two entry points were keying the exact same title under two
  // different, unrelated ids.
  const realImdbId = (match.external_ids && match.external_ids.imdb_id) || (String(imdbId).startsWith("tt") ? String(imdbId).split(":")[0] : ("tmdb:" + tmdbId));

  return {
    id: realImdbId,
    title: match.title || match.name,
    overview: match.overview || "",
    poster: match.poster_path ? "https://image.tmdb.org/t/p/w500" + match.poster_path : "",
    background: match.backdrop_path ? "https://image.tmdb.org/t/p/w1280" + match.backdrop_path : "",
    rating: match.vote_average ? match.vote_average.toFixed(1) : null,
    releaseYear: (match.release_date || match.first_air_date || "").slice(0, 4),
    releaseDate: match.release_date || match.first_air_date || null,
    seasonsData: type === "tv" && match.seasons ? match.seasons : null,
    tmdbId: tmdbId,
    runtime: match.runtime || (match.episode_run_time && match.episode_run_time[0]) || null,
    budget: match.budget || null,
    revenue: match.revenue || null,
    contentRating: contentRating || null,
    genres: (match.genres || []).map(g => g.name).join(', '),
    trailerKey: trailerKey,
    cast: cast,
    director: director
  };
}

async function fetchTmdbSeasonDetails(imdbId, seasonNum, apiKey, knownTmdbId) {
  if (!apiKey) return null;
  // Shows opened from title search (Search Movies & TV Shows) carry a
  // "tmdb:<id>" identifier instead of a real IMDb id -- skip the IMDb
  // lookup entirely for those and use the TMDB id directly, same as
  // fetchTmdbItemDetails already does above. Without this, TMDB's /find
  // endpoint (which only accepts real external ids) returns nothing for a
  // "tmdb:12345" string, every season fails to load ("Error loading
  // episodes."), and since no episodes ever render there's nothing left to
  // mark watched either.
  let tmdbId = knownTmdbId || null;
  if (!tmdbId) {
    if (imdbId.startsWith('tmdb:')) {
      tmdbId = imdbId.split(':')[1];
    } else {
      // First, find TMDB ID from IMDB ID
      const findSrc = "https://api.themoviedb.org/3/find/" + encodeURIComponent(imdbId) + "?api_key=" + encodeURIComponent(apiKey) + "&external_source=imdb_id";
      const findRes = await fetch(findSrc, {
        headers: { "User-Agent": "my-list-addon/1.14" },
        cf: { cacheTtl: 604800, cacheEverything: true },
      });
      if (!findRes.ok) return null;
      const findData = await findRes.json();

      if (!findData.tv_results || findData.tv_results.length === 0) return null;
      tmdbId = findData.tv_results[0].id;
    }
  }

  const src = "https://api.themoviedb.org/3/tv/" + tmdbId + "/season/" + seasonNum + "?api_key=" + encodeURIComponent(apiKey);
  const res = await fetch(src, {
    headers: { "User-Agent": "my-list-addon/1.14" },
    cf: { cacheTtl: 604800, cacheEverything: true },
  });
  if (!res.ok) return null;
  const data = await res.json();
  
  return {
    episodes: (data.episodes || []).map(ep => ({
      id: ep.id,
      episode_number: ep.episode_number,
      name: ep.name,
      overview: ep.overview,
      runtime: ep.runtime,
      air_date: ep.air_date,
      vote_average: ep.vote_average,
      still_path: ep.still_path ? "https://image.tmdb.org/t/p/w500" + ep.still_path : null
    }))
  };
}

// Builds standard Stremio/Nuvio metadata for any movie or series keyed by IMDb id.
// Provides full metadata (details, ratings, cast, genres, seasons, and episodes)
// so clients without a dedicated metadata addon (like Nuvio) render rich pages automatically.
async function fetchStandardItemMeta(imdbId, type, apiKey) {
  if (!apiKey || !imdbId) return null;
  const wantType = type === "series" ? "series" : "movie";
  const details = await fetchTmdbItemDetails(imdbId, apiKey, wantType);
  if (!details) return null;

  const meta = {
    id: details.id,
    type: wantType,
    name: details.title,
    genres: details.genres ? details.genres.split(", ").filter(Boolean) : [],
    poster: details.poster || undefined,
    background: details.background || undefined,
    description: details.overview || undefined,
    releaseInfo: details.releaseYear || undefined,
    imdbRating: details.rating ? String(details.rating) : undefined,
    runtime: details.runtime ? `${details.runtime} min` : undefined,
    cast: details.cast || undefined,
    director: details.director || undefined,
  };

  if (details.trailerKey) {
    meta.trailerStreams = [{ title: "Trailer", ytId: details.trailerKey }];
    meta.trailers = [{ source: details.trailerKey, type: "Trailer" }];
  }

  if (wantType === "movie") {
    meta.behaviorHints = { defaultVideoId: details.id };
    return meta;
  }

  if (wantType === "series" && details.seasonsData && Array.isArray(details.seasonsData)) {
    const regularSeasons = details.seasonsData.filter((s) => s && s.season_number > 0);
    const seasonResults = await Promise.all(
      regularSeasons.map((s) =>
        fetchTmdbSeasonDetails(details.id, s.season_number, apiKey, details.tmdbId).catch(() => null)
      )
    );

    const videos = [];
    seasonResults.forEach((sData, idx) => {
      if (!sData || !Array.isArray(sData.episodes)) return;
      const seasonNum = regularSeasons[idx].season_number;
      sData.episodes.forEach((ep) => {
        if (!ep || ep.episode_number === undefined) return;
        videos.push({
          id: `${details.id}:${seasonNum}:${ep.episode_number}`,
          title: ep.name || `Episode ${ep.episode_number}`,
          season: seasonNum,
          episode: ep.episode_number,
          released: ep.air_date ? new Date(ep.air_date).toISOString() : undefined,
          overview: ep.overview || undefined,
          thumbnail: ep.still_path || undefined,
        });
      });
    });

    if (videos.length > 0) {
      meta.videos = videos;
    }
  }

  return meta;
}

// Server-side "is this episode aired yet" check -- same rule the client's
// isEpisodeAired uses (19_client-search-and-likes.js), reimplemented here
// because nothing in the client-side files (09 onward) is real, callable
// code from the Worker's own perspective; they're embedded template-literal
// text that only becomes real JS once served to and run by a browser. Used
// by findNextAiredEpisodeForShow below, for the Continue Watching cron
// (checkForNewEpisodes, right below).
function isEpisodeAiredServer(ep) {
  if (!ep || !ep.air_date) return false;
  const airDate = new Date(ep.air_date);
  if (isNaN(airDate.getTime())) return false;
  return airDate.getTime() <= (Date.now() + 12 * 3600 * 1000);
}

// Given a show and the latest episode known to be watched, looks for the
// next unwatched, already-aired episode -- same season-then-next-season
// logic as the client's updateContinueWatching
// (21_client-custom-list-builder.js), reimplemented server-side for the
// same reason as isEpisodeAiredServer above. Returns { episode, seasonNum }
// or null if nothing new has aired since latestSeasonNum/latestEpisodeNum.
async function findNextAiredEpisodeForShow(imdbId, latestSeasonNum, latestEpisodeNum, apiKey) {
  const data = await fetchTmdbSeasonDetails(imdbId, latestSeasonNum, apiKey);
  if (data && data.episodes) {
    const nextInSeason = data.episodes
      .filter((ep) => isEpisodeAiredServer(ep))
      .find((ep) => ep.episode_number > latestEpisodeNum);
    if (nextInSeason) return { episode: nextInSeason, seasonNum: latestSeasonNum };
  }
  const nextSeasonNum = latestSeasonNum + 1;
  const data2 = await fetchTmdbSeasonDetails(imdbId, nextSeasonNum, apiKey);
  if (data2 && data2.episodes) {
    const aired = data2.episodes.filter((ep) => isEpisodeAiredServer(ep)).sort((a, b) => a.episode_number - b.episode_number);
    if (aired.length) return { episode: aired[0], seasonNum: nextSeasonNum };
  }
  return null;
}

// Continue Watching cron -- invoked from the scheduled() export at the
// bottom of 26_api-creator-and-admin-routes.js, which itself only fires if
// this Worker's owner has added a Cron Trigger in the Cloudflare dashboard
// (Worker -> Triggers -> Cron Triggers); nothing in this source code can
// turn that on by itself, since it's Worker configuration rather than
// something deployable in a paste-in file. See this repo's README for the
// one-time setup step.
//
// Scope: only accounts with a Creator Profile have anything to check here
// at all -- Watch History/Continue Watching for someone using just an
// install link lives solely in their own browser's localStorage, which a
// server-side job has no way to reach. Within an account, only shows
// already in fullyWatchedShowIds (as of the last time anything ran there,
// client-side or here) get checked -- a show with a known next-unwatched
// episode already sitting in continueWatching doesn't need TMDB re-checked
// on a timer; nothing about "what's next" changes there until the person
// actually watches it, which already updates things instantly client-side.
//
// Processes a bounded batch of accounts per run (ACCOUNT_BATCH_SIZE) and a
// bounded number of show lookups across that whole batch
// (SHOW_CHECK_BUDGET), resuming from a stored KV cursor next run rather
// than sweeping every account in one pass -- with enough self-hosted
// accounts, one pass could easily exceed a single invocation's time/TMDB-
// rate budget. The tradeoff: on a busy deployment, any one account's "how
// long since this was actually checked" drifts from a strict 6 hours to
// more like "gets covered every so often as the cursor cycles back
// around" -- there's no hard per-account freshness guarantee here, just
// steady, bounded progress.
async function checkForNewEpisodes(env) {
  if (!env || !env.CONFIGS || !env.TMDB_API_KEY) return;

  const ACCOUNT_BATCH_SIZE = 25;
  const SHOW_CHECK_BUDGET = 150;

  const cursorRaw = await env.CONFIGS.get('cron:continuewatching:cursor');
  const listOpts = { prefix: 'creator:', limit: ACCOUNT_BATCH_SIZE };
  if (cursorRaw) listOpts.cursor = cursorRaw;
  const listResult = await env.CONFIGS.list(listOpts);

  // Cycle back to the start once the full account list has been swept,
  // rather than stopping -- so the next run picks up fresh with account
  // #1 again instead of sitting idle.
  await env.CONFIGS.put('cron:continuewatching:cursor', listResult.list_complete ? '' : (listResult.cursor || ''));

  let showChecksUsed = 0;

  for (const key of listResult.keys) {
    if (showChecksUsed >= SHOW_CHECK_BUDGET) break;
    const username = key.name.slice('creator:'.length);
    await ensureTrackingMigrated(env, username);
    const syncRaw = await env.CONFIGS.get(`creatorsynctracking:${username}`);
    if (!syncRaw) continue;

    let blob;
    try {
      blob = JSON.parse(syncRaw);
    } catch (e) {
      continue;
    }

    const fullyWatched = Array.isArray(blob.fullyWatchedShowIds) ? blob.fullyWatchedShowIds : [];
    if (!fullyWatched.length) continue;

    const continueWatching = Array.isArray(blob.continueWatching) ? blob.continueWatching : [];
    const alreadyQueued = new Set(continueWatching.map((it) => it.showId));
    const watchHistory = Array.isArray(blob.watchHistory) ? blob.watchHistory : [];
    const dismissed = blob.dismissedContinueWatching && typeof blob.dismissedContinueWatching === 'object' ? blob.dismissedContinueWatching : {};

    let blobChanged = false;
    const stillFullyWatched = [];

    for (const showId of fullyWatched) {
      if (showChecksUsed >= SHOW_CHECK_BUDGET) {
        stillFullyWatched.push(showId); // ran out of budget -- leave it queued for next run rather than dropping it
        continue;
      }
      if (alreadyQueued.has(showId)) {
        stillFullyWatched.push(showId); // shouldn't normally happen (see comment above), but preserve rather than lose data if it does
        continue;
      }

      const watchedEps = watchHistory.filter((it) => it.type === 'episode' && it.showId === showId && it.seasonNum != null && it.episodeNum != null);
      if (!watchedEps.length) continue; // nothing watched at all -- stale entry, drop it
      const latest = watchedEps.reduce((best, ep) => {
        if (ep.seasonNum > best.seasonNum) return ep;
        if (ep.seasonNum === best.seasonNum && ep.episodeNum > best.episodeNum) return ep;
        return best;
      }, watchedEps[0]);

      showChecksUsed++;
      let next = null;
      try {
        next = await findNextAiredEpisodeForShow(showId, latest.seasonNum, latest.episodeNum, env.TMDB_API_KEY);
      } catch (e) {
        stillFullyWatched.push(showId); // network hiccup -- try again next run instead of assuming still fully watched
        continue;
      }
      if (!next) {
        stillFullyWatched.push(showId); // still nothing new -- stays in the check list for next time
        continue;
      }

      // Respect an explicit removal the same way updateContinueWatching
      // already does client-side -- see dismissContinueWatchingShow's own
      // comment (21_client-custom-list-builder.js) for why this compares
      // against the exact watched snapshot rather than just "was this
      // show ever dismissed."
      const stillDismissed = dismissed[showId] && dismissed[showId].seasonNum === latest.seasonNum && dismissed[showId].episodeNum === latest.episodeNum;
      if (stillDismissed) {
        stillFullyWatched.push(showId);
        continue;
      }

      continueWatching.unshift({
        id: String(next.episode.id),
        type: 'episode',
        name: next.episode.name,
        // Continue Watching cards show the series poster, not the episode
        // still -- matches updateContinueWatching's own client-side
        // behavior (21_client-custom-list-builder.js) and keeps the shelf
        // visually consistent with every other poster-based row.
        poster: latest.showPoster || '',
        showId: showId,
        showTitle: latest.showTitle || '',
        showPoster: latest.showPoster || '',
        seasonNum: next.seasonNum,
        episodeNum: next.episode.episode_number,
      });
      // No longer "fully watched" -- it has a known next episode now,
      // same as if updateContinueWatching had just found it client-side.
      blobChanged = true;
    }

    if (blobChanged || stillFullyWatched.length !== fullyWatched.length) {
      blob.continueWatching = continueWatching;
      blob.fullyWatchedShowIds = stillFullyWatched;
      blob.updatedAt = Date.now();
      await env.CONFIGS.put(`creatorsynctracking:${username}`, JSON.stringify(blob));
    }
  }
}





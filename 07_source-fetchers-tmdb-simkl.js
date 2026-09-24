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
      rating: it.ratings ? (it.ratings.imdb ? it.ratings.imdb.rating : (it.ratings.simkl ? it.ratings.simkl.rating : undefined)) : (it.rating || undefined),
      vote_average: it.ratings ? (it.ratings.imdb ? it.ratings.imdb.rating : (it.ratings.simkl ? it.ratings.simkl.rating : undefined)) : (it.rating || undefined),
    }));
}

// chartKey is either a plain time window ("today"/"week"/"month" -- movies
// or tv, chosen by entry.type same as every other chart source here) or
// "anime-<window>" for the dedicated Anime Trending row, which always
// pulls the anime category regardless of entry.type (anime trending mixes
// movies and series under one Simkl category, so there's no clean
// movie/series split to key off of -- see SIMKL_ANIME_LIST below).
async function fetchSimklChart(entry, skip, clientId, chartKey, env = null, ctx = null) {
  if (!clientId) {
    throw new Error(
      "Simkl charts aren't configured on this add-on yet — the Worker owner needs to set SIMKL_CLIENT_ID."
    );
  }
  const isAnime = chartKey.startsWith("anime-");
  const windowKey = isAnime ? chartKey.slice("anime-".length) : chartKey;
  const file = SIMKL_CHART_FILES[windowKey] || SIMKL_CHART_FILES.today;
  const category = isAnime ? "anime" : entry.type === "series" ? "tv" : "movies";

  const cacheKey = `user_cache:simkl:chart:${chartKey}:${entry.type}:${skip}`;
  const kvKey = `simkl:chart:${chartKey}:${entry.type}:${skip}`;

  return await fetchWithPerUserCacheAndCircuitBreaker({
    cacheKey,
    kvKey,
    env,
    ctx,
    freshTtlSec: 600,
    staleTtlSec: 86400,
    kvTtlSec: 86400,
    // A shared, provider-owned chart is never legitimately empty, so an
    // empty-but-successful reply is an upstream fault and must not be allowed
    // to erase the last good copy -- see refuseEmptyOverwrite in
    // fetchWithPerUserCacheUncoalesced (02_http-and-creator-utils.js).
    refuseEmptyOverwrite: true,
    providerLabel: "Simkl Chart",
    fetchFn: async () => {
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
    },
  });
}

async function fetchSimklUserList(entry, skip, token, clientId, spec, userTmdbKey, env = null, ctx = null) {
  if (!token) {
    throw new Error("Simkl user list requires connecting your Simkl account in Settings.");
  }
  const cid = clientId || SIMKL_CLIENT_ID;
  const tmdbApiKey = userTmdbKey || TMDB_API_KEY;
  const parts = (spec || "").split(":");
  const category = parts[0] || "movies"; // "movies", "shows", "anime"
  const status = parts[1] || "plantowatch"; // "plantowatch", "watching", "completed", "hold", "dropped"

  const userHash = safeUserHash(token);
  const cacheKey = `user_cache:simkl:all_items:${userHash}`;

  const data = await fetchWithPerUserCacheAndCircuitBreaker({
    cacheKey,
    kvKey: cacheKey,
    env,
    ctx,
    freshTtlSec: 60,
    staleTtlSec: 1800,
    kvTtlSec: 1800,
    providerLabel: "Simkl User Sync",
    fetchFn: async () => {
      const res = await fetch("https://api.simkl.com/sync/all-items/", {
        headers: {
          "Authorization": `Bearer ${token}`,
          "simkl-api-key": cid,
          "User-Agent": `my-lists-addon/${ADDON_VERSION}`,
          "Accept": "application/json",
        },
        cf: { cacheTtl: 0, cacheEverything: false },
      });
      if (!res.ok) {
        throw new Error(`Simkl user sync request failed (HTTP ${res.status}).`);
      }
      return await res.json();
    }
  });
  if (status === "airing-next" || category === "airing-next") {
    const rawShows = (category === "anime")
      ? (Array.isArray(data.anime) ? data.anime : [])
      : [
          ...(Array.isArray(data.shows) ? data.shows : []),
          ...(Array.isArray(data.anime) ? data.anime : []),
        ];
    const candidateShows = rawShows.filter((it) => (it.status === "watching" || it.status === "completed"));
    candidateShows.sort((a, b) => {
      const aTime = a.last_watched_at ? new Date(a.last_watched_at).getTime() : 0;
      const bTime = b.last_watched_at ? new Date(b.last_watched_at).getTime() : 0;
      if (a.status === "watching" && b.status !== "watching") return -1;
      if (b.status === "watching" && a.status !== "watching") return 1;
      return bTime - aTime;
    });
    const seen = new Set();
    const candidateMetas = [];
    candidateShows.forEach((it) => {
      const mediaObj = it.show || it.anime || it.movie;
      if (mediaObj && mediaObj.ids) {
        const imdbId = mediaObj.ids.imdb || "";
        const tmdbId = mediaObj.ids.tmdb || "";
        const id = imdbId || (tmdbId ? `tmdb:${tmdbId}` : "");
        if (id && !seen.has(id)) {
          seen.add(id);
          candidateMetas.push({
            id,
            imdbId,
            tmdbId,
            name: mediaObj.title || "",
            poster: mediaObj.ids.poster ? `https://simkl.in/posters/${mediaObj.ids.poster}_m.jpg` : (imdbId ? `https://images.metahub.space/poster/medium/${imdbId}/img` : ""),
            year: mediaObj.year ? String(mediaObj.year) : undefined,
          });
        }
      }
    });

    const airingMetas = [];
    await mapWithConcurrency(candidateMetas.slice(0, 90), 6, async (item) => {
      try {
        const details = await fetchTmdbItemDetails(item.id, tmdbApiKey, "series", "", false, env, ctx);
        if (details && details.nextEpisodeAirDate) {
          const isPremiere = details.nextEpisodeNumber === 1;
          const sNum = details.nextEpisodeSeasonNumber ? `S${String(details.nextEpisodeSeasonNumber).padStart(2, "0")}` : "";
          const eNum = details.nextEpisodeNumber ? `E${String(details.nextEpisodeNumber).padStart(2, "0")}` : "";
          const epLabel = sNum && eNum ? `${sNum}${eNum}` : "";
          const realId = (item.imdbId && item.imdbId.startsWith("tt")) ? item.imdbId : (details.imdbId && String(details.imdbId).startsWith("tt") ? details.imdbId : (item.id || item.imdbId));
          airingMetas.push({
            id: realId,
            type: "series",
            name: item.name || details.title || "",
            poster: item.poster || details.poster || "",
            background: details.background || undefined,
            // No releaseInfo (year) here on purpose -- for an Airing Next
            // row, the useful date is the upcoming episode's air date
            // (already surfaced in description below), not the show's
            // original release year, which is noise in this context.
            airDate: details.nextEpisodeAirDate,
            isSeasonPremiere: isPremiere,
            isSeasonFinale: !!details.isSeasonFinale,
            seasonFinaleAirDate: details.seasonFinaleAirDate || undefined,
            seasonFinaleEpisodeNumber: details.seasonFinaleEpisodeNumber || undefined,
            // "Airs 2026-09-27 at 8 PM ET" where TVmaze knows the slot, and
            // the date alone where it does not -- a Stremio row is the one
            // place this add-on shows an air date with no page behind it to
            // open for the rest.
            airTime: details.nextEpisodeAirTimeLabel || undefined,
            description: epLabel
              ? `Next Episode: ${epLabel} · Airs ${details.nextEpisodeAirDate}${details.nextEpisodeAirTimeLabel ? ` at ${details.nextEpisodeAirTimeLabel}` : ""}`
              : (details.overview || undefined),
            trailerStreams: details.trailerKey ? trailerStreamsFor(details.trailerKey) : undefined,
          });
        }
      } catch {}
    });

    airingMetas.sort((a, b) => (a.airDate || "").localeCompare(b.airDate || ""));
    return airingMetas.slice(skip, skip + PAGE_SIZE);
  }

  const arr = Array.isArray(data[category]) ? data[category] : [];
  const filtered = arr.filter((it) => (it.status || "plantowatch") === status);
  const metas = [];
  filtered.forEach((it) => {
    const mediaObj = it.movie || it.show || it.anime;
    if (mediaObj && mediaObj.ids) {
      const imdbId = mediaObj.ids.imdb || "";
      const tmdbId = mediaObj.ids.tmdb || "";
      const id = imdbId || (tmdbId ? `tmdb:${tmdbId}` : "");
      if (id) {
        metas.push({
          id,
          type: entry.type || (category === "movies" ? "movie" : "series"),
          name: mediaObj.title || "",
          poster: mediaObj.ids.poster ? `https://simkl.in/posters/${mediaObj.ids.poster}_m.jpg` : (imdbId ? `https://images.metahub.space/poster/medium/${imdbId}/img` : ""),
          releaseInfo: mediaObj.year ? String(mediaObj.year) : undefined,
        });
      }
    }
  });
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
async function fetchTraktChart(entry, skip, traktKey, chartKey, env = null, ctx = null) {
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
  const src = `https://api.trakt.tv/${chartPath}?limit=${PAGE_SIZE}&page=${page}&extended=full`;

  const headers = {
    "Content-Type": "application/json",
    "trakt-api-version": "2",
    "trakt-api-key": traktKey,
    "User-Agent": `my-list-addon/${ADDON_VERSION}`,
  };

  const cacheKey = `user_cache:trakt:chart:v2:${chartKey}:${wantKind}:${page}`;
  const kvKey = `trakt:chart:v2:${chartKey}:${wantKind}:${page}`;

  const data = await fetchWithPerUserCacheAndCircuitBreaker({
    cacheKey,
    kvKey,
    env,
    ctx,
    freshTtlSec: 600,
    staleTtlSec: 86400,
    kvTtlSec: 86400,
    // A shared, provider-owned chart is never legitimately empty, so an
    // empty-but-successful reply is an upstream fault and must not be allowed
    // to erase the last good copy -- see refuseEmptyOverwrite in
    // fetchWithPerUserCacheUncoalesced (02_http-and-creator-utils.js).
    refuseEmptyOverwrite: true,
    providerLabel: "Trakt Chart",
    fetchFn: async () => {
      const res = await fetchTraktWithRetry(src, {
        headers,
        cf: { cacheTtl: 900, cacheEverything: true },
      });
      if (!res.ok) {
        const hint =
          res.status === 401 || res.status === 403
            ? " Double-check the Trakt Client ID."
            : res.status === 429
            ? " Trakt is temporarily busy (rate limit). Please wait a few seconds and try again."
            : "";
        throw new Error(`Trakt chart request failed (HTTP ${res.status}).${hint}`);
      }
      return traktPayloadWithTotal(await res.json(), res);
    },
  });

  const metas = await enrichTrailers(mapTraktItems(traktPayloadItems(data), entry.type), entry.type, TMDB_API_KEY);
  return withTraktTotal(metas, traktPayloadTotal(data));
}

// Runs async `fn` over `items` with at most `limit` running at once, rather
// than firing them all in parallel. Used for TMDB's per-item external_ids
// lookups (see fetchTmdb below) so a single catalog page (up to PAGE_SIZE
// items) doesn't blow past TMDB's soft ~20-simultaneous-connections-per-IP
// limit and start drawing 429s.
//
// TMDB_DETAIL_RESOLVE_CONCURRENCY (below) governs every catalog/chart
// fetcher's per-item resolve fan-out. It used to be a bare 12 at every call
// site -- more than half of TMDB's own ~20-connection budget from a single
// page load, on its own. fetchTmdbDetails' results are already cached hard
// (7 days) and shared across every user regardless of personal API key
// (every TMDB catalog source always uses the one shared TMDB_API_KEY --
// see fetchCatalog's dispatch table in 05_catalog-core.js), so in steady
// state most of these resolve instantly from cache with no real TMDB
// connection at all. The number below only matters for the genuinely cold
// case -- a brand new chart, or a title nobody's looked at yet -- and
// that's exactly the case where two different people's catalog loads
// landing on the same Cloudflare edge IP at the same moment could stack up
// against TMDB's real limit. Lower value = more headroom for concurrent
// *users* before hitting that ceiling, at the cost of a slower cold-cache
// page load for any one of them.
const TMDB_DETAIL_RESOLVE_CONCURRENCY = 6;

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

// Attaches trailerStreams to a batch of already-built metas (mdblist/Trakt
// sources only -- TMDB-sourced metas already get theirs for free via
// fetchTmdbDetails's append_to_response=videos, see below).
// NOTE: Catalogs in Stremio/wako/Nuvio do not play trailers on home screen thumbnails;
// Stremio's title details page resolves official YouTube trailers directly via Cinemeta.
// Returning immediately eliminates ~100,000+ redundant TMDB subrequests per day and
// dramatically speeds up catalog response times.
async function enrichTrailers(metas, type, apiKey) {
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
async function fetchTmdbDetails(tmdbId, kind, apiKey, env = null) {
  let cleanTmdbId = String(tmdbId || "").trim();
  while (cleanTmdbId.startsWith("tmdb:")) {
    cleanTmdbId = cleanTmdbId.slice(5).trim();
  }
  cleanTmdbId = cleanTmdbId.split(":")[0].trim();
  if (!cleanTmdbId) return { imdbId: null, videos: null, hasDigitalRelease: null, runtime: null };

  if (cleanTmdbId.startsWith("tt")) {
    try {
      const findSrc = `https://api.themoviedb.org/3/find/${encodeURIComponent(cleanTmdbId)}?api_key=${encodeURIComponent(apiKey)}&external_source=imdb_id`;
      const findRes = await fetch(findSrc, {
        headers: { "User-Agent": `my-list-addon/${ADDON_VERSION}` },
        cf: { cacheTtl: 604800, cacheEverything: true },
      });
      if (findRes.ok) {
        const findData = await findRes.json();
        const match = (kind === "tv" ? (findData.tv_results && findData.tv_results[0]) : (findData.movie_results && findData.movie_results[0])) ||
                      (findData.movie_results && findData.movie_results[0]) ||
                      (findData.tv_results && findData.tv_results[0]);
        if (match && match.id) {
          cleanTmdbId = String(match.id);
        }
      }
    } catch {}
  }

  const cacheKey = `user_cache:tmdb_detail_v2:${kind}:${cleanTmdbId}`;
  const cached = getPerUserCache(cacheKey);
  if (cached && cached.data) return cached.data;

  // Check KV cache across all workers
  if (env && env.CONFIGS) {
    try {
      const kvRaw = await env.CONFIGS.get(`tmdbdetail_v2:${kind}:${cleanTmdbId}`);
      if (kvRaw) {
        const kvParsed = JSON.parse(kvRaw);
        setPerUserCache(cacheKey, kvParsed, 604800, 2592000);
        return kvParsed;
      }
    } catch {}
  }

  // release_dates is appended alongside external_ids/videos at no extra
  // request cost (same call, one more field) -- used by fetchTmdbChart
  // below to support the "hide items with no digital release" setting
  // without a second per-item fetch. Harmless for callers that don't need
  // it (TMDB list imports, etc.) since it's simply unused there.
  const src = `https://api.themoviedb.org/3/${kind}/${cleanTmdbId}?api_key=${encodeURIComponent(
    apiKey
  )}&append_to_response=external_ids,videos,release_dates`;
  const res = await fetch(src, {
    headers: { "User-Agent": `my-list-addon/${ADDON_VERSION}` },
    cf: { cacheTtl: 604800, cacheEverything: true },
  });
  if (!res.ok) return { imdbId: null, videos: null, hasDigitalRelease: null, runtime: null };
  const data = await res.json();
  const imdbId = (data.external_ids && data.external_ids.imdb_id) || data.imdb_id || null;
  const videos = (data.videos && data.videos.results) || null;
  // hasDigitalRelease stays null for TV (kind === "tv") -- TMDB's
  // release_dates/release type concept (theatrical/digital/physical) is
  // movie-only; there's no equivalent field on the /tv endpoint, so the
  // "hide items with no digital release" setting only ever applies to
  // movie charts (see fetchTmdbChart below), never TV ones.
  let hasDigitalRelease = null;
  if (kind === "movie" && data.release_dates && Array.isArray(data.release_dates.results)) {
    // Type 4 = Digital, 5 = Physical (TMDB's own release_type enum) --
    // physical is included too since a disc/rental release reliably
    // implies digital availability exists somewhere even when TMDB's own
    // digital entry for that title is missing or incomplete.
    hasDigitalRelease = data.release_dates.results.some((r) =>
      Array.isArray(r.release_dates) && r.release_dates.some((rd) => rd.type === 4 || rd.type === 5)
    );
  }
  const adult = data.adult === true || data.is_adult === true;
  const genres = Array.isArray(data.genres) ? data.genres.map((g) => (typeof g === "string" ? g : g.name || "")) : undefined;
  // Minutes. A movie has one; TMDB gives a SHOW an episode_run_time array
  // instead, whose first entry is the typical episode length -- which is the
  // fallback a channel uses for an episode TMDB has no per-episode runtime
  // for. Null when there is nothing to say, so nothing downstream may
  // require it.
  let runtime = null;
  if (Number.isInteger(data.runtime)) runtime = data.runtime;
  else if (Array.isArray(data.episode_run_time) && Number.isInteger(data.episode_run_time[0])) runtime = data.episode_run_time[0];
  const vote_average = (typeof data.vote_average === "number" && data.vote_average > 0) ? data.vote_average : undefined;
  const result = { imdbId, videos, hasDigitalRelease, adult, genres, runtime, vote_average };
  // Cache for 7 days (604800s)
  setPerUserCache(cacheKey, result, 604800, 2592000);

  // Persist to Cloudflare KV for 30 days so no other worker or edge ever re-queries this ID
  if (env && env.CONFIGS && imdbId) {
    try {
      env.CONFIGS.put(`tmdbdetail_v2:${kind}:${cleanTmdbId}`, JSON.stringify(result), { expirationTtl: 2592000 }).catch(() => {});
    } catch {}
  }
  return result;
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
  // How big the list actually is, so the browser can say "303 items" the
  // moment See All opens instead of counting the 100 it has loaded and
  // saying that until the rest has been scrolled in. /api/preview reads it
  // off the returned array as `totalItems` (25_api-catalog-routes.js);
  // every other TMDB fetcher in this file already reports one, this walk
  // was the only one that never did.
  //
  // Two of the three cases are exact, and the third is deliberately left
  // unanswered. If the walk below runs out of pages, `filtered` IS the
  // whole list for this type. The account watchlist/favourites endpoints
  // are per-kind (/account/{id}/watchlist/movie), so TMDB's own
  // total_results counts exactly what this catalog will show. What cannot
  // be known without walking every page is how a v4 list that MIXES movies
  // and shows splits between them -- total_results counts both. So that
  // number is only adopted while every item seen so far has been of the
  // wanted kind; a list that has actually shown both reports no total and
  // the header falls back to "100+", counting up as it pages, which is
  // what it did before this and is at least honest.
  let totalResults = null;
  let otherKindSeen = 0;
  let exhausted = false;

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
    if (items.length === 0) {
      exhausted = true;
      break; // no more pages
    }
    if (typeof data.total_pages === "number" && data.total_pages > 0) {
      totalPages = data.total_pages;
    }
    if (typeof data.total_results === "number" && data.total_results >= 0) {
      totalResults = data.total_results;
    }

    for (const it of items) {
      const kind = it.media_type === "tv" || it.media_type === "movie" ? it.media_type : wantKind;
      if (kind === wantKind) filtered.push(it);
      else otherKindSeen++;
    }
    tmdbPage++;
    if (tmdbPage > totalPages) exhausted = true;
  }

  const knownTotal = exhausted
    ? filtered.length
    : ((isAccountWatchlist || isAccountFavorites || otherKindSeen === 0) && totalResults != null
        ? totalResults
        : null);

  const page = filtered.slice(skip, skip + PAGE_SIZE);

  const resolved = await mapWithConcurrency(page, TMDB_DETAIL_RESOLVE_CONCURRENCY, async (it) => {
    const details = await fetchTmdbDetails(it.id, wantKind, apiKey);
    const effectiveId = details.imdbId || ("tmdb:" + it.id);
    return mapTmdbItem(it, effectiveId, entry.type, details.videos, details);
  });

  const out = resolved.filter(Boolean);
  if (knownTotal != null) out.totalItems = knownTotal;
  return out;
}

async function fetchTmdbCollection(entry, skip = 0, apiKey = "", env = null, ctx = null) {
  if (!apiKey) {
    throw new Error(
      "TMDB collections aren't configured on this add-on yet — the Worker owner needs to set TMDB_API_KEY."
    );
  }

  const collectionId = typeof tmdbCollectionId === "function" ? tmdbCollectionId(entry.url) : null;
  if (!collectionId) {
    throw new Error("Couldn't parse that as a TMDB collection URL (expected themoviedb.org/collection/ID).");
  }

  const cacheKey = `user_cache:tmdb:collection:${collectionId}:${skip}`;
  const kvKey = `tmdb:collection:${collectionId}:${skip}`;

  return await fetchWithPerUserCacheAndCircuitBreaker({
    cacheKey,
    kvKey,
    env,
    ctx,
    freshTtlSec: 604800, // 7 days
    staleTtlSec: 30 * 86400,
    kvTtlSec: 604800,
    // A shared, provider-owned chart is never legitimately empty, so an
    // empty-but-successful reply is an upstream fault and must not be allowed
    // to erase the last good copy -- see refuseEmptyOverwrite in
    // fetchWithPerUserCacheUncoalesced (02_http-and-creator-utils.js).
    refuseEmptyOverwrite: true,
    providerLabel: "TMDB Collection",
    fetchFn: async () => {
      const src = `https://api.themoviedb.org/3/collection/${encodeURIComponent(collectionId)}?api_key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(src, {
        headers: { "User-Agent": `my-list-addon/${ADDON_VERSION}` },
        cf: { cacheTtl: 604800, cacheEverything: true },
      });

      if (!res.ok) {
        if (res.status === 404) {
          throw new Error(`TMDB collection ${collectionId} not found.`);
        }
        throw new Error(`TMDB request failed (HTTP ${res.status}).`);
      }

      const data = await res.json();
      const parts = Array.isArray(data.parts) ? data.parts : [];
      const isCollectionAdult = data.adult === true || (typeof isAdultOrNsfw === "function" && isAdultOrNsfw({ name: data.name, title: data.name, franchise: data.name }));
      
      // Sort chronologically by release date
      parts.sort((a, b) => (a.release_date || "9999").localeCompare(b.release_date || "9999"));

      const windowItems = parts.slice(skip, skip + PAGE_SIZE);
      const resolved = await mapWithConcurrency(windowItems, TMDB_DETAIL_RESOLVE_CONCURRENCY, async (it) => {
        const details = await fetchTmdbDetails(it.id, "movie", apiKey);
        const effectiveId = details.imdbId || ("tmdb:" + it.id);
        if (isCollectionAdult && !it.adult) it.adult = true;
        return mapTmdbItem(it, effectiveId, "movie", details.videos, details);
      });

      // The whole collection came back in one response, so its size is
      // known exactly -- see /api/preview's totalItems.
      const mapped = resolved.filter(Boolean);
      mapped.totalItems = parts.length;
      return mapped;
    },
  });
}

// Shared meta-shaping for any TMDB item (list, chart, wherever), once its
// IMDB id is known. TMDB's own poster_path/backdrop_path are already
// sitting right there in the response (zero extra requests), and cover
// obscure titles more reliably than metahub.space's IMDB-keyed poster
// database -- preferred over metahub, with metahub only as a fallback for
// the rare item missing a poster_path.
function mapTmdbItem(it, imdbId, type, videos, extraDetails) {
  let poster = undefined;
  if (it.poster_path) {
    poster = `https://image.tmdb.org/t/p/w500${it.poster_path}`;
  } else if (it.backdrop_path) {
    poster = `https://image.tmdb.org/t/p/w780${it.backdrop_path}`;
  } else if (imdbId && String(imdbId).startsWith("tt")) {
    poster = `https://images.metahub.space/poster/medium/${imdbId}/img`;
  }
  const isAdult = it.adult === true || it.is_adult === true || it.isAdult === true || (extraDetails && (extraDetails.adult === true || extraDetails.isAdult === true)) || (typeof isAdultOrNsfw === "function" && (isAdultOrNsfw(it) || (extraDetails && isAdultOrNsfw(extraDetails))));
  return {
    id: imdbId,
    type,
    name: it.title || it.name,
    poster,
    background: it.backdrop_path ? `https://image.tmdb.org/t/p/w1280${it.backdrop_path}` : undefined,
    releaseInfo: (it.release_date || it.first_air_date || "").slice(0, 4) || undefined,
    trailerStreams: trailerStreamsFor(pickTrailerKey(videos)),
    adult: isAdult ? true : undefined,
    isAdult: isAdult ? true : undefined,
    genres: it.genres || (extraDetails && extraDetails.genres) || (Array.isArray(it.genre_ids) ? it.genre_ids : undefined),
    certification: it.certification || (extraDetails && extraDetails.certification) || undefined,
    vote_average: (typeof it.vote_average === "number" && it.vote_average > 0)
      ? it.vote_average
      : (extraDetails && typeof extraDetails.vote_average === "number" && extraDetails.vote_average > 0
          ? extraDetails.vote_average
          : (typeof it.vote_average === "number" ? it.vote_average : undefined)),
    rating: (typeof it.vote_average === "number" && it.vote_average > 0)
      ? it.vote_average
      : (extraDetails && typeof extraDetails.vote_average === "number" && extraDetails.vote_average > 0
          ? extraDetails.vote_average
          : (typeof it.vote_average === "number" ? it.vote_average : undefined)),
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

// Every provider/stream-releases path built above bakes in watch_region=US
// as a placeholder -- substituteWatchRegion swaps it for the caller's
// actual region at request time (see fetchTmdbChart/fetchTmdbProviderTop10/
// fetchTmdbGenre below). Done this way, rather than rebuilding the whole
// TMDB_CHART_PATHS/TMDB_GENRE_CONFIG maps to be region-aware from the
// start, since only these few entries are watch_region-sensitive at all --
// most chart/genre paths (trending, by-genre, etc.) have nothing to do
// with regional availability and shouldn't need touching.
function substituteWatchRegion(path, region) {
  if (!path || !path.includes("watch_region=")) return path;
  const effectiveRegion = (region || "US").toUpperCase().slice(0, 2) || "US";
  return path.replace(/watch_region=[A-Z]{2}/, `watch_region=${effectiveRegion}`);
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
      if (!res.ok) return { ok: false, status: res.status, items: [], totalResults: null };
      const data = await res.json();
      return { ok: true, items: Array.isArray(data.results) ? data.results : [], totalResults: (typeof data.total_results === 'number') ? data.total_results : null };
    })
  );

  if (!pageResults[0].ok) {
    const status = pageResults[0].status;
    const hint = status === 401 ? " Double-check the TMDB API key." : "";
    throw new Error(`TMDB request failed (HTTP ${status}).${hint}`);
  }

  const allItems = pageResults.flatMap((p) => p.items);
  const sliced = allItems.slice(offsetWithinFirstPage, offsetWithinFirstPage + PAGE_SIZE);
  sliced.totalItems = pageResults[0]?.totalResults != null ? pageResults[0].totalResults : null;
  return sliced;
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
async function fetchTmdbChart(entry, skip, apiKey, chartKey, region, hideNonDigitalReleases, env = null, ctx = null) {
  if (!apiKey) {
    throw new Error(
      "TMDB charts aren't configured on this add-on yet — the Worker owner needs to set TMDB_API_KEY."
    );
  }
  const wantKind = entry.type === "series" ? "tv" : "movie";
  const effectiveRegion = region || "US";
  const cacheKey = `user_cache:tmdb:chart:${chartKey}:${wantKind}:${skip}:${effectiveRegion}:${hideNonDigitalReleases ? "1" : "0"}`;
  const kvKey = `tmdb:chart:${chartKey}:${wantKind}:${skip}:${effectiveRegion}:${hideNonDigitalReleases ? "1" : "0"}`;

  return await fetchWithPerUserCacheAndCircuitBreaker({
    cacheKey,
    kvKey,
    env,
    ctx,
    freshTtlSec: 600,
    staleTtlSec: 86400,
    kvTtlSec: 86400,
    // A shared, provider-owned chart is never legitimately empty, so an
    // empty-but-successful reply is an upstream fault and must not be allowed
    // to erase the last good copy -- see refuseEmptyOverwrite in
    // fetchWithPerUserCacheUncoalesced (02_http-and-creator-utils.js).
    refuseEmptyOverwrite: true,
    providerLabel: "TMDB Chart",
    fetchFn: async () => {
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
      chartPath = substituteWatchRegion(chartPath, region);

      const windowItems = await fetchTmdbPagedResults(chartPath, apiKey, skip);
      const applyDigitalFilter = !!hideNonDigitalReleases && wantKind === "movie" && (chartKey === "trending" || chartKey === "popular");

      const resolved = await mapWithConcurrency(windowItems, TMDB_DETAIL_RESOLVE_CONCURRENCY, async (it) => {
        const details = await fetchTmdbDetails(it.id, wantKind, apiKey, env);
        if (!details.imdbId) return null;
        if (applyDigitalFilter && details.hasDigitalRelease === false) return null;
        return mapTmdbItem(it, details.imdbId, entry.type, details.videos, details);
      });

      const res = resolved.filter(Boolean);
      res.totalItems = windowItems.totalItems;
      return res;
    },
  });
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
async function fetchTmdbProviderTop10(entry, skip, apiKey, chartKey, region) {
  const TOP_N = 10;
  if (skip >= TOP_N) return []; // already gave everything -- tells the caller to stop paginating
  if (!apiKey) {
    throw new Error(
      "TMDB charts aren't configured on this add-on yet — the Worker owner needs to set TMDB_API_KEY."
    );
  }
  const wantKind = entry.type === "series" ? "tv" : "movie";
  const pathMap = TMDB_CHART_PATHS[chartKey];
  let chartPath = pathMap && pathMap[wantKind];
  if (!chartPath) {
    throw new Error("This TMDB chart doesn't have a shows version.");
  }
  chartPath = substituteWatchRegion(chartPath, region);
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

  const resolved = await mapWithConcurrency(windowItems, TMDB_DETAIL_RESOLVE_CONCURRENCY, async (it) => {
    const details = await fetchTmdbDetails(it.id, wantKind, apiKey);
    if (!details.imdbId) return null;
    return mapTmdbItem(it, details.imdbId, entry.type, details.videos, details);
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

  const resolved = await mapWithConcurrency(windowItems, TMDB_DETAIL_RESOLVE_CONCURRENCY, async (it) => {
    const details = await fetchTmdbDetails(it.id, wantKind, apiKey);
    if (!details.imdbId) return null;
    return mapTmdbItem(it, details.imdbId, entry.type, details.videos, details);
  });

  const res = resolved.filter(Boolean);
  res.totalItems = windowItems.totalItems;
  return res;
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

  const resolved = await mapWithConcurrency(windowItems, TMDB_DETAIL_RESOLVE_CONCURRENCY, async (it) => {
    const details = await fetchTmdbDetails(it.id, wantKind, apiKey);
    if (!details.imdbId) return null;
    return mapTmdbItem(it, details.imdbId, entry.type, details.videos, details);
  });

  const res = resolved.filter(Boolean);
  res.totalItems = windowItems.totalItems;
  return res;
}

const TMDB_HOLIDAY_CONFIG = {
  christmas: {
    keywords: "207317|6513|9799|236|157545",
    query: "Christmas",
  },
  easter: {
    keywords: "9937|229891|228968",
    query: "Easter",
  },
  july4: {
    keywords: "10084|6091|208453",
    query: "Fourth of July",
  },
  halloween: {
    keywords: "3335|10292|224636|12332",
    query: "Halloween",
  },
  newyear: {
    keywords: "613|228970",
    query: "New Year",
  },
  thanksgiving: {
    keywords: "10085|228969",
    query: "Thanksgiving",
  },
  valentine: {
    keywords: "9798|12377|208940",
    query: "Valentine",
  },
};

async function fetchTmdbHoliday(entry, skip, apiKey, holidayKey) {
  if (!apiKey) {
    throw new Error(
      "Holiday lists aren't configured on this add-on yet - the Worker owner needs to set TMDB_API_KEY."
    );
  }
  const wantKind = entry.type === "series" ? "tv" : "movie";
  const key = String(holidayKey || "").toLowerCase();
  const config = TMDB_HOLIDAY_CONFIG[key] || { keywords: "", query: key };

  const discoverPath =
    "discover/" + wantKind + "?sort_by=popularity.desc" +
    (config.keywords ? "&with_keywords=" + encodeURIComponent(config.keywords) : "") +
    "&include_adult=false";

  let windowItems = await fetchTmdbPagedResults(discoverPath, apiKey, skip, 0);

  if (windowItems.length < 15 && config.query) {
    try {
      const searchPath = "search/" + wantKind + "?query=" + encodeURIComponent(config.query) + "&include_adult=false";
      const searchItems = await fetchTmdbPagedResults(searchPath, apiKey, 0, 0);
      const seenIds = new Set(windowItems.map((it) => it.id));
      for (const item of searchItems) {
        if (!seenIds.has(item.id)) {
          seenIds.add(item.id);
          windowItems.push(item);
        }
      }
    } catch (e) {}
  }

  const resolved = await mapWithConcurrency(windowItems, TMDB_DETAIL_RESOLVE_CONCURRENCY, async (it) => {
    const details = await fetchTmdbDetails(it.id, wantKind, apiKey);
    if (!details.imdbId) return null;
    return mapTmdbItem(it, details.imdbId, entry.type, details.videos, details);
  });

  const res = resolved.filter(Boolean);
  res.totalItems = windowItems.totalItems;
  return res;
}

const TMDB_GENRE_CONFIG = {
  family: {
    movie: "with_genres=10751",
    tv: "with_genres=10751,10762",
  },
  fantasy: {
    movie: "with_genres=14",
    tv: "with_genres=10765",
  },
  history: {
    movie: "with_genres=36",
    tv: "with_genres=10768,99",
  },
  horror: {
    movie: "with_genres=27",
    tv: "with_genres=9648,10765",
  },
  mystery: {
    movie: "with_genres=9648",
    tv: "with_genres=9648",
  },
  romance: {
    movie: "with_genres=10749",
    tv: "with_genres=10749,10766,18",
  },
  "science-fiction": {
    movie: "with_genres=878",
    tv: "with_genres=10765",
  },
  scifi: {
    movie: "with_genres=878",
    tv: "with_genres=10765",
  },
  "stream-releases": {
    movie: "with_watch_monetization_types=flatrate|rent|buy&watch_region=US",
    tv: "with_watch_monetization_types=flatrate|rent|buy&watch_region=US",
  },
  thriller: {
    movie: "with_genres=53",
    tv: "with_genres=9648,80",
  },
  war: {
    movie: "with_genres=10752",
    tv: "with_genres=10768",
  },
  western: {
    movie: "with_genres=37",
    tv: "with_genres=37",
  },
};

async function fetchTmdbGenre(entry, skip, apiKey, genreKey, region) {
  if (!apiKey) {
    throw new Error(
      "Genre lists aren't configured on this add-on yet — the Worker owner needs to set TMDB_API_KEY."
    );
  }
  const wantKind = entry.type === "series" ? "tv" : "movie";
  const key = String(genreKey || "").toLowerCase().trim();
  const isStreamReleases = key === "stream-releases";
  const config = TMDB_GENRE_CONFIG[key] || { movie: "", tv: "" };
  const queryPart = substituteWatchRegion(config[wantKind] || "", region);
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  let discoverPath = "";
  if (isStreamReleases) {
    if (wantKind === "movie") {
      discoverPath = "discover/movie?sort_by=primary_release_date.desc&primary_release_date.lte=" + today +
        (queryPart ? "&" + queryPart : "") +
        "&include_adult=false";
    } else {
      discoverPath = "discover/tv?sort_by=first_air_date.desc&first_air_date.lte=" + today +
        (queryPart ? "&" + queryPart : "") +
        "&include_adult=false";
    }
  } else {
    const minVotes = wantKind === "movie" ? "10" : "5";
    discoverPath = `discover/${wantKind}?sort_by=popularity.desc&vote_count.gte=${minVotes}` +
      (queryPart ? "&" + queryPart : "") +
      "&include_adult=false";
  }

  const windowItems = await fetchTmdbPagedResults(discoverPath, apiKey, skip, 0);

  const resolved = await mapWithConcurrency(windowItems, TMDB_DETAIL_RESOLVE_CONCURRENCY, async (it) => {
    const details = await fetchTmdbDetails(it.id, wantKind, apiKey);
    const effectiveId = details.imdbId || ("tmdb:" + it.id);
    return mapTmdbItem(it, effectiveId, entry.type, details.videos, details);
  });

  const res = resolved.filter(Boolean);
  res.totalItems = windowItems.totalItems;
  return res;
}

// --- New on Streaming --------------------------------------------------------
//
// tmdb:new-on-streaming[:service1+service2] -- what actually arrived on a
// streaming service, newest first, with a show pushed back to the top when a
// new episode airs. See NEW_ON_STREAMING_PROVIDERS (00_constants.js) for why
// this cannot be a discover query and has to be observed on the cron tick
// instead, and migrations/0011_add_streaming_events.sql for the table.
//
// Two halves, and they never run in the same place:
//
//   sweepNewOnStreaming / bumpNewOnStreamingEpisodes  spend the outbound
//       fetches, on the cron tick, and write rows into D1.
//
//   fetchNewOnStreaming  serves the catalog, and makes NO outbound request at
//       all -- one indexed D1 read, with the poster and title denormalised
//       into the row precisely so that stays true. It is the only catalog in
//       this add-on that cannot be slowed down by a provider having a bad day.

// "netflix" -> the NEW_ON_STREAMING_PROVIDERS entry. Unknown keys return null
// rather than throwing, so a stale saved row naming a provider that has since
// been removed from that list degrades to "all services" instead of erroring.
function newOnStreamingProvider(key) {
  let k = String(key || "").toLowerCase().trim().split(".")[0].replace(/[^a-z0-9]/g, "");
  const direct = NEW_ON_STREAMING_PROVIDERS.find((p) => p.key === k || (p.rapidId && p.rapidId === k));
  if (direct) return direct;
  if (k === "prime" || k === "amazon" || k === "primevideo" || k === "amazonprime") {
    return NEW_ON_STREAMING_PROVIDERS.find((p) => p.key === "primevideo") || null;
  }
  if (k === "hbo" || k === "max" || k === "hbomax") {
    return NEW_ON_STREAMING_PROVIDERS.find((p) => p.key === "hbomax") || null;
  }
  if (k === "apple" || k === "appletv" || k === "appletvplus") {
    return NEW_ON_STREAMING_PROVIDERS.find((p) => p.key === "appletv") || null;
  }
  if (k === "disney" || k === "disneyplus") {
    return NEW_ON_STREAMING_PROVIDERS.find((p) => p.key === "disney") || null;
  }
  if (k === "paramount" || k === "paramountplus") {
    return NEW_ON_STREAMING_PROVIDERS.find((p) => p.key === "paramount") || null;
  }
  if (k === "hulu") {
    return NEW_ON_STREAMING_PROVIDERS.find((p) => p.key === "hulu") || null;
  }
  if (k === "peacock" || k === "peacocktv") {
    return NEW_ON_STREAMING_PROVIDERS.find((p) => p.key === "peacock") || null;
  }
  return null;
}

function normalizeNewOnStreamingServiceKey(raw) {
  const p = newOnStreamingProvider(raw);
  return p ? p.key : String(raw || "").toLowerCase().trim().split(".")[0].replace(/[^a-z0-9]/g, "");
}

// Parses the part after "tmdb:new-on-streaming" (or "rapidapi:new-on-streaming").
// Accepts nothing (every service), or ":" and a "+"-separated list of provider keys --
// "tmdb:new-on-streaming:netflix+hulu". Returns the resolved provider keys, or
// null meaning "all of them", which is what an empty or entirely unrecognised
// selection collapses to.
function parseNewOnStreamingServices(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const stripped = s.replace(/^(?:tmdb|rapidapi|streaming):new-on-streaming:?/i, "");
  if (!stripped) return null;
  const keys = stripped
    .split(/[+,]/)
    .map((part) => newOnStreamingProvider(part))
    .filter(Boolean)
    .map((p) => p.key);
  if (!keys.length) return null;
  return [...new Set(keys)];
}

// The region the sweep actually has rows for. A reader in a region nobody
// sweeps gets the first swept region's rows rather than an empty shelf -- the
// catalog says so in its own description, and NEW_ON_STREAMING_REGIONS carries
// the reason a second region is not free.
function newOnStreamingRegion(region) {
  const want = String(region || "US").toUpperCase().slice(0, 2);
  return NEW_ON_STREAMING_REGIONS.includes(want) ? want : NEW_ON_STREAMING_REGIONS[0];
}

// "2024-03-08" -> epoch seconds, UTC. Returns 0 for anything unparseable and
// clamps the future away: a provider catalog carries announced-but-unreleased
// titles, and one of those seeded at its future date would sit at the top of a
// list about what you can watch now.
function newOnStreamingDateToEpoch(dateStr, nowSec) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || "").trim());
  if (!m) return 0;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000;
  if (!Number.isFinite(t) || t <= 0) return 0;
  return Math.min(Math.floor(t), nowSec);
}

// --- RapidAPI Streaming Availability API (/changes) Quota & Sweep Engine ---
//
// Basic plan hard limit: 1,000 requests per month, 1,000 requests per hour.
// Safety cap: 950 requests per month to prevent any overages.
// Automated interval: every 4 hours via cron (~180 runs/month).

async function getRapidApiMonthlyUsage(env) {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const defaultUsage = {
    month: currentMonth,
    count: 0,
    lastAt: null,
    limit: RAPIDAPI_MONTHLY_LIMIT,
    safetyCap: RAPIDAPI_MONTHLY_SAFETY_CAP,
  };
  if (!env || !env.CONFIGS) return defaultUsage;
  try {
    const raw = await env.CONFIGS.get("cron:rapidapi:usage");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.month === currentMonth && Number.isFinite(parsed.count)) {
        return {
          month: currentMonth,
          count: Math.max(0, Math.floor(parsed.count)),
          lastAt: parsed.lastAt || null,
          limit: RAPIDAPI_MONTHLY_LIMIT,
          safetyCap: RAPIDAPI_MONTHLY_SAFETY_CAP,
        };
      }
    }
  } catch (e) {}
  return defaultUsage;
}

async function recordRapidApiUsage(env, addCount = 1) {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const usage = await getRapidApiMonthlyUsage(env);
  usage.count += Math.max(0, Math.floor(addCount));
  usage.lastAt = Math.floor(Date.now() / 1000);
  if (env && env.CONFIGS) {
    try {
      await env.CONFIGS.put("cron:rapidapi:usage", JSON.stringify(usage), { expirationTtl: 5184000 });
    } catch (e) {}
  }
  return usage;
}
//
// Uses the Streaming Availability API's GET /changes endpoint to pull the
// movies, shows, seasons and episodes added to streaming services.
//
// This is modelled on what mdblist.com/new-on-streaming actually shows. That
// page is built from JustWatch's "new" feed (mdblist's own changelog, Aug 20
// 2026), and JustWatch's feed has exactly two kinds of entry: a movie getting
// an offer on a service, and a SEASON getting one -- including when an existing
// season's offer gains new episodes (the entry carries newElementCount, e.g.
// "The Daily Show, season 31, 1 new episode", dated the day it landed). So:
//
//   - New movies and series enter the table dated by their arrival on that
//     service (item_type=show).
//   - A new season or new episode on a service moves last_event_at on that
//     service's row, pushing the show back to the top of the shelf
//     (item_type=season / item_type=episode). Daily shows included: JustWatch
//     and mdblist list Good Morning America and The Daily Show like anything
//     else.
//
// Pruning removes items older than 30 days, maintaining a strictly rolling
// 30-day window of recent arrivals and episode drops.

async function fetchRapidApiStreamingChanges({ apiKey, country = "us", changeType = "new", itemType = "show", showType = null, from, to, catalogs, cursor, orderDirection = "desc" }) {
  const params = new URLSearchParams();
  params.set("country", String(country || "us").toLowerCase());
  params.set("change_type", String(changeType || "new"));
  params.set("item_type", String(itemType || "show"));
  if (showType && itemType === "show") {
    params.set("show_type", String(showType));
  }
  params.set("order_direction", orderDirection === "asc" ? "asc" : "desc");
  params.set("output_language", "en");
  if (Number.isFinite(Number(from)) && Number(from) > 0) {
    params.set("from", String(Math.floor(Number(from))));
  }
  if (Number.isFinite(Number(to)) && Number(to) > 0) {
    params.set("to", String(Math.floor(Number(to))));
  }
  if (catalogs) {
    params.set("catalogs", String(catalogs));
  }
  if (cursor) {
    params.set("cursor", String(cursor));
  }

  const url = `${RAPIDAPI_CHANGES_URL}?${params.toString()}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "x-rapidapi-key": apiKey,
      "x-rapidapi-host": RAPIDAPI_HOST,
      "User-Agent": `my-lists-addon/${ADDON_VERSION}`,
    },
    cf: { cacheTtl: 300, cacheEverything: false },
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`RapidAPI Streaming Availability changes failed (HTTP ${res.status}): ${errText.slice(0, 100)}`);
  }
  return await res.json();
}

function extractRapidApiPoster(show) {
  const vp = show && show.imageSet && show.imageSet.verticalPoster;
  if (vp) {
    if (typeof vp === "string") return vp;
    return vp.w600 || vp.w720 || vp.w480 || vp.w360 || vp.w240 || Object.values(vp)[0] || null;
  }
  if (show && show.posterPath) {
    return `https://image.tmdb.org/t/p/w500${show.posterPath}`;
  }
  if (show && show.imdbId) {
    return `https://images.metahub.space/poster/medium/${show.imdbId}/img`;
  }
  return null;
}

function extractRapidApiBackdrop(show) {
  const hb = show && show.imageSet && show.imageSet.horizontalBackdrop;
  if (hb) {
    if (typeof hb === "string") return hb;
    return hb.w1080 || hb.w720 || hb.w1440 || hb.w480 || hb.w360 || Object.values(hb)[0] || null;
  }
  if (show && show.backdropPath) {
    return `https://image.tmdb.org/t/p/w1280${show.backdropPath}`;
  }
  return null;
}

function extractCleanTmdbId(val) {
  if (val == null) return null;
  const s = String(val).trim();
  const m = s.match(/(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

function extractRapidApiTmdbId(show) {
  if (!show || show.tmdbId == null) return null;
  return extractCleanTmdbId(show.tmdbId);
}

// Turns one /changes page into upserts on `writes`. Returns the newest change
// timestamp on the page (0 if none) -- filtered-out changes included, since
// what the stream reader needs to know is how far through the feed it got.
function processRapidApiStreamingChanges(data, { env, region, nowSec, writes, summary }) {
  if (!data) return 0;
  const changes = Array.isArray(data.changes) ? data.changes : [];
  summary.seen += changes.length;
  if (!changes.length) return 0;
  let newestTs = 0;
  for (const change of changes) {
    const ts = Number(change && change.timestamp);
    if (Number.isFinite(ts) && ts > newestTs) newestTs = Math.floor(ts);
  }

  const showsMap = new Map();
  const indexShow = (key, s) => {
    if (!key || !s) return;
    const strKey = String(key).trim();
    if (!strKey) return;
    showsMap.set(strKey, s);
    showsMap.set(strKey.toLowerCase(), s);
    const m = strKey.match(/(\d+)$/);
    if (m) {
      showsMap.set(m[1], s);
      showsMap.set(`series/${m[1]}`, s);
      showsMap.set(`tv/${m[1]}`, s);
      showsMap.set(`movie/${m[1]}`, s);
    }
  };

  if (Array.isArray(data.shows)) {
    for (const s of data.shows) {
      if (!s) continue;
      if (s.id) indexShow(s.id, s);
      if (s.imdbId) indexShow(s.imdbId, s);
      if (s.tmdbId) indexShow(s.tmdbId, s);
    }
  } else if (data.shows && typeof data.shows === "object") {
    for (const [id, s] of Object.entries(data.shows)) {
      if (!s) continue;
      indexShow(id, s);
      if (s.id) indexShow(s.id, s);
      if (s.imdbId) indexShow(s.imdbId, s);
      if (s.tmdbId) indexShow(s.tmdbId, s);
    }
  }

  for (const change of changes) {
    if (!change) continue;
    const showId = change.showId ? String(change.showId).trim() : "";
    const show = showsMap.get(showId) || showsMap.get(showId.toLowerCase()) || {};
    const cleanTmdbId = extractRapidApiTmdbId(show) || extractCleanTmdbId(showId);
    let rawImdbId = show.imdbId || (showId.startsWith("tt") ? showId : null);
    if (rawImdbId && !String(rawImdbId).startsWith("tt")) rawImdbId = null;
    const imdbId = rawImdbId || (cleanTmdbId ? `tmdb:${cleanTmdbId}` : null);
    if (!imdbId) continue;

    const rawService = (typeof change.service === "object" ? (change.service && (change.service.id || change.service.key || change.service.name)) : change.service) || "";
    const rawServiceStr = String(rawService).toLowerCase().trim();
    const streamingOptionType = String(change.streamingOptionType || (change.service && change.service.streamingOptionType) || "").toLowerCase();

    // Subscription and free only. Rent/buy is a store, not a streaming service,
    // and an addon is a different provider sold through this one (Starz via
    // Prime Video Channels, Max via Hulu) -- JustWatch, and so mdblist, list
    // those as providers of their own. The sweep asks for .subscription
    // catalogs already (NEW_ON_STREAMING_DEFAULT_CATALOGS); this is for an
    // admin-supplied catalogs override, and for a response that ignores it.
    if (streamingOptionType === "rent" || streamingOptionType === "buy" || streamingOptionType === "addon") {
      continue;
    }
    if (rawServiceStr.includes(".rent") || rawServiceStr.includes(".buy") || rawServiceStr.includes(".addon")) {
      continue;
    }
    // Apple TV's bare "apple" catalog represents iTunes Store digital rentals and purchases.
    // Apple TV+ subscription service is strictly "apple.subscription".
    if (rawServiceStr === "apple" && streamingOptionType !== "subscription") {
      continue;
    }

    const serviceKey = normalizeNewOnStreamingServiceKey(rawService);
    if (!serviceKey) continue;

    const eventAt = Number.isFinite(Number(change.timestamp)) && Number(change.timestamp) > 0
      ? Math.min(Math.floor(Number(change.timestamp)), nowSec)
      : nowSec;

    if (change.changeType === "removed") {
      summary.markedRemoved = (summary.markedRemoved || 0) + 1;
      writes.push(
        env.DB.prepare(
          `UPDATE streaming_events
              SET removed_at = ?
            WHERE region = ? AND service = ? AND imdb_id = ? AND removed_at IS NULL`
        ).bind(eventAt, region, serviceKey, imdbId)
      );
      continue;
    }

    const itemType = String(change.itemType || "show").toLowerCase();
    const isEpisode = itemType === "episode";
    const isSeason = itemType === "season";
    const kind = (isEpisode || isSeason || change.showType === "series" || show.showType === "series") ? "series" : "movie";
    const eventKind = isEpisode ? "episode" : (isSeason ? "season" : "added");
    const season = Number.isFinite(Number(change.season))
      ? Number(change.season)
      : (Number.isFinite(Number(change.seasonNumber)) ? Number(change.seasonNumber) : null);
    const episode = Number.isFinite(Number(change.episode))
      ? Number(change.episode)
      : (Number.isFinite(Number(change.episodeNumber)) ? Number(change.episodeNumber) : null);

    const tmdbId = cleanTmdbId;
    const name = show.title || show.name || show.originalTitle || "";
    const poster = extractRapidApiPoster(show);
    const background = extractRapidApiBackdrop(show);
    const year = show.releaseYear ? String(show.releaseYear) : (show.year ? String(show.year) : null);

    if (isEpisode || isSeason) {
      summary.bumped = (summary.bumped || 0) + 1;
    } else {
      summary.added = (summary.added || 0) + 1;
    }

    writes.push(
      env.DB.prepare(
        `INSERT INTO streaming_events
           (region, service, imdb_id, tmdb_id, kind, added_at, last_event_at, event_kind,
            season, episode, seeded, last_seen_walk, removed_at, name, poster, background, year)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, NULL, ?, ?, ?, ?)
         ON CONFLICT (region, service, imdb_id) DO UPDATE SET
           last_seen_walk = 1,
           tmdb_id        = COALESCE(excluded.tmdb_id, streaming_events.tmdb_id),
           name           = CASE WHEN excluded.name != '' THEN excluded.name ELSE streaming_events.name END,
           poster         = COALESCE(excluded.poster, streaming_events.poster),
           background     = COALESCE(excluded.background, streaming_events.background),
           year           = COALESCE(excluded.year, streaming_events.year),
           last_event_at  = CASE WHEN excluded.last_event_at >= streaming_events.last_event_at THEN excluded.last_event_at ELSE streaming_events.last_event_at END,
           event_kind     = CASE WHEN excluded.last_event_at >= streaming_events.last_event_at THEN excluded.event_kind ELSE streaming_events.event_kind END,
           season         = CASE WHEN excluded.last_event_at >= streaming_events.last_event_at THEN excluded.season ELSE streaming_events.season END,
           episode        = CASE WHEN excluded.last_event_at >= streaming_events.last_event_at THEN excluded.episode ELSE streaming_events.episode END,
           added_at       = CASE WHEN streaming_events.removed_at IS NOT NULL AND excluded.last_event_at > streaming_events.removed_at THEN excluded.added_at ELSE streaming_events.added_at END,
           removed_at     = CASE WHEN streaming_events.removed_at IS NOT NULL AND excluded.last_event_at <= streaming_events.removed_at THEN streaming_events.removed_at ELSE NULL END`
      ).bind(
        region,
        serviceKey,
        imdbId,
        tmdbId,
        kind,
        eventAt,
        eventAt,
        eventKind,
        season,
        episode,
        name,
        poster,
        background,
        year
      )
    );
  }
  return newestTs;
}

// Pages one automated tick may spend: what is left of the month's safety cap,
// spread evenly over the sweeps left in the month, clamped to
// NEW_ON_STREAMING_MIN/MAX_PAGES_PER_TICK and never past what is left.
function newOnStreamingTickBudget(usedThisMonth, nowSec) {
  const now = new Date(nowSec * 1000);
  const monthEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) / 1000;
  const ticksLeft = Math.max(1, Math.ceil((monthEnd - nowSec) / NEW_ON_STREAMING_SWEEP_INTERVAL_SECONDS));
  const remaining = Math.max(0, RAPIDAPI_MONTHLY_SAFETY_CAP - Math.max(0, Number(usedThisMonth) || 0));
  const even = Math.floor(remaining / ticksLeft);
  return Math.min(
    remaining,
    NEW_ON_STREAMING_MAX_PAGES_PER_TICK,
    Math.max(NEW_ON_STREAMING_MIN_PAGES_PER_TICK, even)
  );
}

function newOnStreamingStreamsKey(region) {
  return `cron:newonstreaming:streams:${region}`;
}

// Per-stream resume state: { hwm, pending: { from, to, cursor, reachedAt } | null, lastRunAt }.
//   hwm        every change up to this timestamp has been read
//   pending    a query in progress -- the same from/to must be re-sent with
//              its cursor, so they are stored with it
//   reachedAt  newest change timestamp read so far inside `pending`
async function readNewOnStreamingStreams(env, region) {
  const out = {};
  if (env && env.CONFIGS) {
    try {
      const raw = await env.CONFIGS.get(newOnStreamingStreamsKey(region));
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === "object") Object.assign(out, parsed);
    } catch (e) {}
  }
  for (const stream of NEW_ON_STREAMING_STREAMS) {
    const st = out[stream.id] && typeof out[stream.id] === "object" ? out[stream.id] : {};
    out[stream.id] = {
      hwm: Number.isFinite(st.hwm) ? st.hwm : 0,
      pending: st.pending && Number.isFinite(st.pending.from) && Number.isFinite(st.pending.to) ? st.pending : null,
      lastRunAt: Number.isFinite(st.lastRunAt) ? st.lastRunAt : 0,
    };
  }
  return out;
}

async function writeNewOnStreamingStreams(env, region, state) {
  if (!env || !env.CONFIGS) return;
  try {
    await env.CONFIGS.put(newOnStreamingStreamsKey(region), JSON.stringify(state), { expirationTtl: 5184000 });
  } catch (e) {}
}

// Reads up to `pageCap` pages of one stream, oldest first, picking up exactly
// where the last tick stopped. Returns the pages spent. Leaves `st.pending` set
// when the stream still has more to read, so the next tick continues the same
// query with RapidAPI's cursor instead of dropping the rest.
async function readNewOnStreamingStream(stream, st, pageCap, run) {
  const { env, rapidKey, country, catalogs, nowSec, windowStart, initialFrom, summary } = run;
  let pages = 0;
  if (pageCap <= 0) return 0;

  if (!st.pending) {
    const from = st.hwm > 0 ? st.hwm - NEW_ON_STREAMING_RESUME_OVERLAP_SECONDS : initialFrom;
    st.pending = { from: Math.max(windowStart, from), to: nowSec, cursor: null, reachedAt: 0 };
  }
  // The API refuses a `from` older than 31 days; a query that has aged past
  // the window restarts from its edge (the rows it would have written are
  // pruned anyway).
  if (st.pending.from < windowStart) {
    st.pending = { from: windowStart, to: Math.max(windowStart, st.pending.to), cursor: null, reachedAt: 0 };
  }
  const reached = Math.max(st.pending.from, st.pending.reachedAt || 0);
  if (stream.maxLagSeconds > 0 && reached < nowSec - stream.maxLagSeconds) {
    st.pending = { from: nowSec - stream.maxLagSeconds, to: nowSec, cursor: null, reachedAt: 0 };
    summary.skippedAhead = summary.skippedAhead || {};
    summary.skippedAhead[stream.id] = reached;
  }

  while (pages < pageCap) {
    let data = null;
    try {
      data = await fetchRapidApiStreamingChanges({
        apiKey: rapidKey,
        country,
        changeType: stream.changeType,
        itemType: stream.itemType,
        from: st.pending.from,
        to: st.pending.to,
        catalogs,
        cursor: st.pending.cursor,
        orderDirection: "asc",
      });
    } catch (err) {
      pages++;
      summary.units++;
      await recordRapidApiUsage(env, 1);
      summary.errors++;
      summary.lastError = err && err.message ? err.message : String(err);
      console.warn(`[Cron] RapidAPI changes fetch (${stream.id}) failed:`, summary.lastError);
      // A cursor RapidAPI no longer accepts would fail forever; restart the
      // query from the newest change already read (re-reading it is harmless,
      // every write is an idempotent upsert).
      if (st.pending.cursor) {
        st.pending = {
          from: Math.max(windowStart, st.pending.reachedAt || st.pending.from),
          to: st.pending.to,
          cursor: null,
          reachedAt: 0,
        };
      }
      return pages;
    }
    pages++;
    summary.units++;
    await recordRapidApiUsage(env, 1);
    summary.pages[stream.id] = (summary.pages[stream.id] || 0) + 1;

    await run.beforeFirstWrite();
    const newest = processRapidApiStreamingChanges(data, {
      env,
      region: run.region,
      nowSec,
      writes: run.writes,
      summary,
    });
    if (newest > (st.pending.reachedAt || 0)) st.pending.reachedAt = newest;
    if (run.writes.length >= 40) {
      await d1BatchInChunks(env, run.writes, "New on Streaming RapidAPI sweep");
      run.writes.length = 0;
    }

    if (data && data.hasMore && data.nextCursor) {
      st.pending.cursor = data.nextCursor;
      continue;
    }
    st.hwm = st.pending.to;
    st.pending = null;
    st.lastRunAt = nowSec;
    break;
  }
  return pages;
}

async function sweepRapidApiNewOnStreaming(env, ctx, fetchBudget, maxUnits, options = {}) {
  const summary = {
    ran: false, reason: "", units: 0, seen: 0, added: 0, bumped: 0, markedRemoved: 0,
    errors: 0, pruned: 0, source: "rapidapi", mode: "", pages: {},
  };
  if (!env || !env.CONFIGS) {
    summary.reason = "no KV binding";
    return summary;
  }
  if (!env.DB) {
    summary.reason = "no D1 database bound (this catalog is D1-only)";
    return summary;
  }

  const rapidKey = (env && (env.RAPIDAPI_KEY || env.STREAMING_AVAILABILITY_API_KEY)) || RAPIDAPI_KEY;
  if (!rapidKey) {
    summary.reason = "RAPIDAPI_KEY is not set (set with `npx wrangler secret put RAPIDAPI_KEY`)";
    console.warn(`[Cron] New on Streaming ${summary.reason}`);
    return summary;
  }

  const nowSec = Math.floor(Date.now() / 1000);

  // Hard safety limit check: 1,000 requests/month max on Basic plan.
  // Safety cap stops automated and manual sweeps at 950 to ensure no overage charges occur.
  const monthlyUsage = await getRapidApiMonthlyUsage(env);
  if (monthlyUsage.count >= RAPIDAPI_MONTHLY_SAFETY_CAP) {
    summary.reason = `RapidAPI monthly limit reached (${monthlyUsage.count}/${RAPIDAPI_MONTHLY_LIMIT} requests used this month); sweep halted to prevent overages`;
    console.warn(`[Cron] New on Streaming ${summary.reason}`);
    return summary;
  }

  // Automated sweep interval check (NEW_ON_STREAMING_SWEEP_INTERVAL_SECONDS).
  // Manual admin sweeps or full backfill bypass interval gating.
  const isManual = options.manual === true;
  const isReset = options.reset === true || options.clear === true;
  const isFull = options.full === true || isReset;
  let lastSweepAt = 0;
  try {
    const lastRaw = await env.CONFIGS.get("cron:newonstreaming:lastsweep");
    if (lastRaw) {
      const parsed = JSON.parse(lastRaw);
      if (parsed && Number.isFinite(parsed.at)) {
        lastSweepAt = parsed.at;
      }
    }
  } catch (e) {}

  if (!isManual && !isFull && lastSweepAt > 0) {
    const elapsed = nowSec - lastSweepAt;
    if (elapsed < NEW_ON_STREAMING_SWEEP_INTERVAL_SECONDS) {
      const remainingMinutes = Math.ceil((NEW_ON_STREAMING_SWEEP_INTERVAL_SECONDS - elapsed) / 60);
      const hours = Math.round(NEW_ON_STREAMING_SWEEP_INTERVAL_SECONDS / 3600);
      summary.reason = `Interval cooldown (${remainingMinutes}m until next ${hours}h run to preserve 1,000 req/mo quota)`;
      return summary;
    }
  }

  const region = newOnStreamingRegion(options.region);
  const country = region.toLowerCase();
  const catalogs = options.catalogs || NEW_ON_STREAMING_DEFAULT_CATALOGS;
  const windowStart = nowSec - (NEW_ON_STREAMING_WINDOW_DAYS * 86400);
  const remainingInQuota = Math.max(0, RAPIDAPI_MONTHLY_SAFETY_CAP - monthlyUsage.count);
  const budgetCap = Number.isFinite(fetchBudget) ? Math.max(0, fetchBudget) : Infinity;
  const writes = [];

  // "Clear & pull fresh data" deletes the region's rows, but only once the
  // first page has actually come back -- an API error must not leave an
  // empty table behind.
  let pendingReset = isReset;
  const beforeFirstWrite = async () => {
    if (!pendingReset) return;
    pendingReset = false;
    try {
      await env.DB.prepare("DELETE FROM streaming_events WHERE region = ?").bind(region).run();
      summary.cleared = true;
    } catch (e) {
      console.warn("[Cron] New on Streaming clear failed:", e && e.message ? e.message : e);
    }
  };

  const streams = await readNewOnStreamingStreams(env, region);

  if (isFull) {
    // Backfill: rebuild the last 30 days newest-first, so whatever the page
    // budget reaches is the part of the shelf people actually look at. It
    // then hands over to the incremental streams from "now" -- anything older
    // it did not reach stays unread, which is the right trade for a rebuild.
    summary.mode = isReset ? "reset" : "full";
    if (isReset) {
      try { await env.CONFIGS.delete("cron:newonstreaming:lastsweep"); } catch (e) {}
    }
    const limitUnits = Number.isFinite(maxUnits) && maxUnits > 0 ? Math.floor(maxUnits) : 30;
    const maxPages = Math.min(isReset ? Math.max(30, budgetCap) : budgetCap, limitUnits, remainingInQuota);
    const from = options.from && Number.isFinite(Number(options.from)) ? Math.max(windowStart, Number(options.from)) : windowStart;
    const to = options.to && Number.isFinite(Number(options.to)) ? Number(options.to) : nowSec;
    const itemTypeConfigs = [
      { type: "show", share: 0.70 },
      { type: "episode", share: 0.20 },
      { type: "season", share: 0.10 },
    ];
    let remainingBudget = maxPages;
    for (let i = 0; i < itemTypeConfigs.length; i++) {
      const { type: itemType, share } = itemTypeConfigs[i];
      if (remainingBudget <= 0 || summary.units >= maxPages) break;
      const remainingTypes = itemTypeConfigs.length - i;
      const targetForThisType = remainingTypes === 1
        ? remainingBudget
        : Math.max(1, Math.min(remainingBudget - (remainingTypes - 1), Math.round(maxPages * share)));
      let cursor = null;
      let pages = 0;
      while (pages < targetForThisType && summary.units < maxPages) {
        let pageData = null;
        try {
          pageData = await fetchRapidApiStreamingChanges({
            apiKey: rapidKey, country, changeType: "new", itemType, from, to, catalogs, cursor, orderDirection: "desc",
          });
        } catch (err) {
          summary.errors++;
          summary.lastError = err && err.message ? err.message : String(err);
          console.warn(`[Cron] RapidAPI changes fetch (${itemType}, page ${pages + 1}) failed:`, summary.lastError);
          break;
        } finally {
          summary.units++;
          pages++;
          remainingBudget--;
          await recordRapidApiUsage(env, 1);
        }
        summary.pages[itemType] = (summary.pages[itemType] || 0) + 1;
        await beforeFirstWrite();
        processRapidApiStreamingChanges(pageData, { env, region, nowSec, writes, summary });
        if (writes.length >= 40) {
          await d1BatchInChunks(env, writes, "New on Streaming RapidAPI sweep");
          writes.length = 0;
        }
        if (!pageData || !pageData.hasMore || !pageData.nextCursor) break;
        cursor = pageData.nextCursor;
      }
    }
    if (pendingReset && summary.errors === 0) await beforeFirstWrite();
    for (const stream of NEW_ON_STREAMING_STREAMS) {
      streams[stream.id] = { hwm: to, pending: null, lastRunAt: stream.changeType === "removed" ? 0 : nowSec };
    }
  } else {
    // Incremental: every due stream is asked once, then what is left of the
    // budget goes to whichever still has more to read, in priority order.
    summary.mode = isManual ? "manual" : "tick";
    const tickBudget = Number.isFinite(maxUnits) && maxUnits > 0
      ? Math.floor(maxUnits)
      : newOnStreamingTickBudget(monthlyUsage.count, nowSec);
    let budget = Math.min(tickBudget, budgetCap, remainingInQuota);

    // A first run after the switch to resumable streams starts where the old
    // newest-first sweep left off, not 30 days back.
    const initialFrom = lastSweepAt > 0 ? lastSweepAt - 3600 : nowSec - 86400;
    const run = { env, rapidKey, country, catalogs, region, nowSec, windowStart, initialFrom, writes, summary, beforeFirstWrite };

    const due = NEW_ON_STREAMING_STREAMS.filter((stream) => {
      const st = streams[stream.id];
      if (isManual || !stream.everySeconds || st.pending) return true;
      return !st.lastRunAt || nowSec - st.lastRunAt >= stream.everySeconds;
    });
    for (const stream of due) {
      if (budget <= 0) break;
      budget -= await readNewOnStreamingStream(stream, streams[stream.id], 1, run);
    }
    for (const stream of due) {
      if (budget <= 0) break;
      if (!streams[stream.id].pending) continue;
      budget -= await readNewOnStreamingStream(stream, streams[stream.id], budget, run);
    }
    summary.behind = {};
    for (const stream of NEW_ON_STREAMING_STREAMS) {
      const st = streams[stream.id];
      if (st.pending) summary.behind[stream.id] = Math.max(0, nowSec - Math.max(st.pending.from, st.pending.reachedAt || 0));
    }
  }

  if (writes.length > 0) {
    await d1BatchInChunks(env, writes, "New on Streaming RapidAPI sweep");
    writes.length = 0;
  }
  await writeNewOnStreamingStreams(env, region, streams);

  // Prune items older than 30 days
  try {
    const pruneRes = await env.DB.prepare(
      `DELETE FROM streaming_events WHERE region = ? AND last_event_at < ?`
    ).bind(region, windowStart).run();
    summary.pruned = (pruneRes && pruneRes.meta && pruneRes.meta.changes) || 0;
  } catch (e) {
    console.warn("[Cron] New on Streaming 30-day prune failed:", e && e.message ? e.message : e);
  }

  summary.ran = true;

  try {
    await env.CONFIGS.put(
      "cron:newonstreaming:lastsweep",
      JSON.stringify({ at: nowSec, ...summary }),
      { expirationTtl: 2592000 }
    );
  } catch (e) {}

  return summary;
}

// --- JustWatch "new" feed (the engine mdblist's New on Streaming uses) ------
//
// One GraphQL query per page: newTitles(country, date, filter: {packages,
// monetizationTypes: [FLATRATE]}). Every edge is a Movie or a Season getting
// a subscription offer on that date, and a Season edge comes back whenever
// the season gains episodes (newOffer.newElementCount) -- which is what
// "a show moves back to the top when a new episode lands" means on mdblist.

function newOnStreamingEngine(env) {
  const v = String((env && env.NEW_ON_STREAMING_ENGINE) || NEW_ON_STREAMING_ENGINE || "").toLowerCase().trim();
  return v === "rapidapi" ? "rapidapi" : "justwatch";
}

function newOnStreamingProviderByJwPackage(shortName) {
  const k = String(shortName || "").toLowerCase();
  return NEW_ON_STREAMING_PROVIDERS.find((p) => p.jwPackage === k) || null;
}

// "2026-09-22" for a day `offset` days before nowSec (UTC).
function newOnStreamingIsoDay(nowSec, offset) {
  return new Date((nowSec - offset * 86400) * 1000).toISOString().slice(0, 10);
}

const JUSTWATCH_NEW_TITLES_QUERY = `query NewTitles($country: Country!, $date: Date!, $filter: TitleFilter, $after: String, $first: Int!) {
  newTitles(country: $country, date: $date, filter: $filter, first: $first, after: $after, pageType: NEW, priceDrops: false) {
    totalCount
    pageInfo { hasNextPage endCursor }
    edges {
      newOffer(platform: WEB) { monetizationType newElementCount dateCreated package { shortName } }
      node {
        __typename
        objectId
        ... on Movie { content(country: $country, language: "en") { title originalReleaseYear posterUrl externalIds { imdbId tmdbId } } }
        ... on Season {
          content(country: $country, language: "en") { seasonNumber }
          show { objectId content(country: $country, language: "en") { title originalReleaseYear posterUrl externalIds { imdbId tmdbId } } }
        }
      }
    }
  }
}`;

async function fetchJustWatchNewTitles({ country, date, packages, after, slice }) {
  const filter = { packages: slice && slice.p ? slice.p : packages, monetizationTypes: ["FLATRATE"] };
  if (slice && slice.o) filter.objectTypes = [slice.o];
  if (slice && slice.y) filter.releaseYear = { min: slice.y[0], max: slice.y[1] };
  const res = await fetch(JUSTWATCH_GRAPHQL_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
    body: JSON.stringify({
      operationName: "NewTitles",
      query: JUSTWATCH_NEW_TITLES_QUERY,
      variables: {
        country,
        date,
        after: after || "",
        first: NEW_ON_STREAMING_JW_PAGE_SIZE,
        filter,
      },
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`JustWatch newTitles failed (HTTP ${res.status}): ${errText.slice(0, 100)}`);
  }
  const body = await res.json();
  if (body && Array.isArray(body.errors) && body.errors.length) {
    throw new Error(`JustWatch newTitles error: ${String(body.errors[0] && body.errors[0].message).slice(0, 120)}`);
  }
  const nt = body && body.data && body.data.newTitles;
  if (!nt) throw new Error("JustWatch newTitles returned no data");
  return nt;
}

function justWatchPosterUrl(path) {
  const p = String(path || "");
  if (!p.startsWith("/poster/")) return null;
  return `https://images.justwatch.com${p.replace("{profile}", "s592").replace("{format}", "jpg")}`;
}

// JustWatch's IMDb id is sometimes wrong -- stale, or an IMDb duplicate record
// (WWE Raw came through as tt2932286, which IMDb has merged into tt0185103 and
// Cinemeta lists as "#DUPE#"). A wrong id means no poster, a "Not found" on
// click and no streams in Stremio. Its TMDB id is reliable, so the IMDb id is
// taken from TMDB instead: /{movie|tv}/{id}?append_to_response=external_ids,
// which also yields a poster for the titles JustWatch has none for.
//
// Each title is looked up once. A row written from a TMDB answer is stamped
// last_seen_walk = NOS_ID_CHECKED (a column left over from the old TMDB-walk
// engine and unused by both current ones), and the next sweep that meets the
// same TMDB id reuses that row's id instead of asking again -- so the three
// days re-read every sweep cost no lookups once they have been read once.
const NOS_ID_CHECKED = 2;

function justWatchEdgeTmdbKey(edge) {
  const node = edge && edge.node;
  if (!node) return null;
  const isSeason = node.__typename === "Season";
  const content = isSeason ? (node.show && node.show.content) : node.content;
  const tmdbId = extractCleanTmdbId(content && content.externalIds && content.externalIds.tmdbId);
  return tmdbId ? { kind: isSeason ? "series" : "movie", tmdbId, key: `${isSeason ? "series" : "movie"}:${tmdbId}` } : null;
}

async function fetchTmdbIdsForJustWatch(kind, tmdbId, tmdbKey) {
  const type = kind === "series" ? "tv" : "movie";
  const res = await fetch(
    `https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${encodeURIComponent(tmdbKey)}&append_to_response=external_ids`,
    { headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` }, cf: { cacheTtl: 604800, cacheEverything: true } }
  );
  if (res.status === 404) return { imdbId: null, poster: null };
  if (!res.ok) throw new Error(`TMDB ${type}/${tmdbId} failed (HTTP ${res.status})`);
  const d = await res.json();
  const imdb = (d && d.external_ids && d.external_ids.imdb_id) || (d && d.imdb_id) || null;
  return {
    imdbId: imdb && /^tt\d+$/.test(imdb) ? imdb : null,
    poster: d && d.poster_path ? `https://image.tmdb.org/t/p/w500${d.poster_path}` : null,
  };
}

// Resolves every TMDB id on a page to { id, poster }. Returns null when the
// lookups this page still needs exceed what the sweep has left (`lookups`
// counts down), so the caller can stop the day here and resume next sweep.
async function resolveJustWatchIds(env, region, edges, lookups, cache, summary) {
  const wanted = new Map();
  for (const e of edges || []) {
    const k = justWatchEdgeTmdbKey(e);
    if (k && !cache.has(k.key)) wanted.set(k.key, k);
  }
  if (!wanted.size) return cache;

  // Already checked on an earlier sweep?
  const byKind = { movie: [], series: [] };
  for (const k of wanted.values()) byKind[k.kind].push(k.tmdbId);
  for (const kind of ["movie", "series"]) {
    const ids = byKind[kind];
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      try {
        const { results } = await env.DB.prepare(
          `SELECT tmdb_id, imdb_id, MAX(poster) AS poster FROM streaming_events
            WHERE region = ? AND kind = ? AND last_seen_walk = ? AND tmdb_id IN (${chunk.map(() => "?").join(",")})
            GROUP BY tmdb_id, imdb_id`
        ).bind(region, kind, NOS_ID_CHECKED, ...chunk).all();
        for (const r of results || []) {
          const key = `${kind}:${r.tmdb_id}`;
          cache.set(key, { id: r.imdb_id, poster: r.poster || null });
          wanted.delete(key);
        }
      } catch (e) {}
    }
  }
  if (!wanted.size) return cache;

  const tmdbKey = (env && env.TMDB_API_KEY) || TMDB_API_KEY;
  if (!tmdbKey) return cache; // No key: fall back to JustWatch's ids (processJustWatchNewTitles).
  if (wanted.size > lookups.left) return null;
  for (const k of wanted.values()) {
    lookups.left--;
    summary.idLookups = (summary.idLookups || 0) + 1;
    try {
      const r = await fetchTmdbIdsForJustWatch(k.kind, k.tmdbId, tmdbKey);
      cache.set(k.key, { id: r.imdbId || `tmdb:${k.tmdbId}`, poster: r.poster, fresh: true });
    } catch (e) {
      // Left unresolved: this edge falls back to JustWatch's id, unstamped,
      // and is checked again on a later sweep.
      summary.idLookupErrors = (summary.idLookupErrors || 0) + 1;
    }
  }
  return cache;
}

// One page of edges -> upserts. `position` is the edge's index within the
// whole day; it orders titles inside a day the way JustWatch lists them (the
// date is all JustWatch gives, so the time of day is synthetic: midnight UTC
// plus a few seconds per place, earlier = higher). Deliberately NOT clamped to
// now: in the first ~2.8 hours of a UTC day every entry of that day would
// clamp to the same second and lose its order. It never leaves the day.
function processJustWatchNewTitles(edges, { env, region, dayEpoch, startPosition, nowSec, writes, summary, idCache }) {
  let position = startPosition;
  for (const edge of edges || []) {
    const idx = position++;
    const node = edge && edge.node;
    const offer = (edge && edge.newOffer) || {};
    if (!node) continue;
    summary.seen++;
    const provider = newOnStreamingProviderByJwPackage(offer.package && offer.package.shortName);
    if (!provider) continue;
    if (offer.monetizationType && offer.monetizationType !== "FLATRATE") continue;

    const isSeason = node.__typename === "Season";
    const content = isSeason ? (node.show && node.show.content) : node.content;
    if (!content) continue;
    const ext = content.externalIds || {};
    const jwImdbId = ext.imdbId && /^tt\d+$/.test(ext.imdbId) ? ext.imdbId : null;
    const tmdbId = extractCleanTmdbId(ext.tmdbId);
    // TMDB's answer for this title when there is one (resolveJustWatchIds),
    // JustWatch's own ids only when there is not.
    const checked = tmdbId && idCache ? idCache.get(`${isSeason ? "series" : "movie"}:${tmdbId}`) : null;
    const id = checked ? checked.id : (jwImdbId || (tmdbId ? `tmdb:${tmdbId}` : null));
    const walkMark = checked ? NOS_ID_CHECKED : 1;
    const poster = justWatchPosterUrl(content.posterUrl) || (checked && checked.poster) || null;
    if (!id) {
      summary.noId = (summary.noId || 0) + 1;
      continue;
    }
    const eventAt = dayEpoch + Math.max(0, 9999 - idx);
    const kind = isSeason ? "series" : "movie";
    const eventKind = isSeason ? "season" : "added";
    const season = isSeason && node.content && Number.isFinite(Number(node.content.seasonNumber)) ? Number(node.content.seasonNumber) : null;
    const newEpisodes = isSeason && Number.isFinite(Number(offer.newElementCount)) ? Number(offer.newElementCount) : null;
    const year = content.originalReleaseYear ? String(content.originalReleaseYear) : null;
    if (isSeason) summary.bumped++; else summary.added++;

    writes.push(
      env.DB.prepare(
        `INSERT INTO streaming_events
           (region, service, imdb_id, tmdb_id, kind, added_at, last_event_at, event_kind,
            season, episode, seeded, last_seen_walk, removed_at, name, poster, background, year)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?, NULL, ?)
         ON CONFLICT (region, service, imdb_id) DO UPDATE SET
           last_seen_walk = MAX(streaming_events.last_seen_walk, excluded.last_seen_walk),
           tmdb_id        = COALESCE(excluded.tmdb_id, streaming_events.tmdb_id),
           name           = CASE WHEN excluded.name != '' THEN excluded.name ELSE streaming_events.name END,
           poster         = COALESCE(excluded.poster, streaming_events.poster),
           year           = COALESCE(excluded.year, streaming_events.year),
           added_at       = MIN(streaming_events.added_at, excluded.added_at),
           last_event_at  = MAX(streaming_events.last_event_at, excluded.last_event_at),
           event_kind     = CASE WHEN excluded.last_event_at >= streaming_events.last_event_at THEN excluded.event_kind ELSE streaming_events.event_kind END,
           season         = CASE WHEN excluded.last_event_at >= streaming_events.last_event_at THEN excluded.season ELSE streaming_events.season END,
           episode        = CASE WHEN excluded.last_event_at >= streaming_events.last_event_at THEN excluded.episode ELSE streaming_events.episode END,
           removed_at     = NULL`
      ).bind(
        region, provider.key, id, tmdbId, kind, eventAt, eventAt, eventKind,
        season, newEpisodes, walkMark, content.title || "", poster, year
      )
    );
    // A title first written under JustWatch's wrong id: drop that row, now
    // that the right one exists. Once per title per sweep.
    if (checked && checked.fresh && !checked.cleaned) {
      checked.cleaned = true;
      writes.push(
        env.DB.prepare(
          `DELETE FROM streaming_events WHERE region = ? AND kind = ? AND tmdb_id = ? AND imdb_id != ?`
        ).bind(region, kind, tmdbId, id)
      );
    }
  }
  return position;
}

// JustWatch stops a newTitles query at 600 entries (JUSTWATCH_NEW_TITLES_CAP):
// the 1st of a month, or a day Prime Video dumps a catalogue (Sep 12 2026:
// 600+ Prime movies alone), silently loses the rest. A query that reports a
// capped totalCount is split into narrower ones that partition it -- by
// service, then movies vs seasons, then by halving the release-year range --
// until each fits. (A title with no release year cannot be reached once the
// year split starts; on a capped day that is the trade.)
function splitJustWatchSlice(slice, packages) {
  if (!slice.p) return packages.map((pkg) => ({ p: [pkg] }));
  if (!slice.o) return [{ ...slice, o: "MOVIE" }, { ...slice, o: "SHOW_SEASON" }];
  const [min, max] = slice.y || [1870, new Date().getUTCFullYear() + 2];
  if (min >= max) return null;
  const mid = Math.floor((min + max) / 2);
  return [{ ...slice, y: [min, mid] }, { ...slice, y: [mid + 1, max] }];
}

function newOnStreamingJwDaysKey(region) {
  return `cron:newonstreaming:jwdays:${region}`;
}

// Reads JustWatch's feed day by day across the 30-day window. The last
// NEW_ON_STREAMING_JW_REFRESH_DAYS days are re-read every sweep; older days
// are read once (resuming mid-day from a saved cursor if the page budget ran
// out) and marked done in KV (cron:newonstreaming:jwdays:<region>).
async function sweepJustWatchNewOnStreaming(env, ctx, fetchBudget, maxUnits, options = {}) {
  const summary = {
    ran: false, reason: "", units: 0, seen: 0, added: 0, bumped: 0, errors: 0, pruned: 0,
    source: "justwatch", mode: "", days: [],
  };
  if (!env || !env.CONFIGS) {
    summary.reason = "no KV binding";
    return summary;
  }
  if (!env.DB) {
    summary.reason = "no D1 database bound (this catalog is D1-only)";
    return summary;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const isManual = options.manual === true;
  const isReset = options.reset === true || options.clear === true;
  const isFull = options.full === true || isReset;

  let lastSweepAt = 0;
  try {
    const lastRaw = await env.CONFIGS.get("cron:newonstreaming:lastsweep");
    const parsed = lastRaw ? JSON.parse(lastRaw) : null;
    if (parsed && Number.isFinite(parsed.at) && parsed.source === "justwatch") lastSweepAt = parsed.at;
  } catch (e) {}
  if (!isManual && !isFull && lastSweepAt > 0 && nowSec - lastSweepAt < NEW_ON_STREAMING_JW_INTERVAL_SECONDS) {
    const remainingMinutes = Math.ceil((NEW_ON_STREAMING_JW_INTERVAL_SECONDS - (nowSec - lastSweepAt)) / 60);
    summary.reason = `Interval cooldown (${remainingMinutes}m until the next JustWatch sweep)`;
    return summary;
  }
  summary.mode = isReset ? "reset" : (isFull ? "full" : (isManual ? "manual" : "tick"));

  const region = newOnStreamingRegion(options.region);
  const country = region;
  const packages = NEW_ON_STREAMING_PROVIDERS.map((p) => p.jwPackage).filter(Boolean);
  const windowStart = nowSec - (NEW_ON_STREAMING_WINDOW_DAYS * 86400);
  const cap = Number.isFinite(maxUnits) && maxUnits > 0 ? Math.floor(maxUnits) : NEW_ON_STREAMING_JW_MAX_PAGES_PER_SWEEP;
  let budget = Math.min(cap, Number.isFinite(fetchBudget) ? Math.max(0, fetchBudget) : Infinity);

  let days = {};
  if (!isFull) {
    try {
      const raw = await env.CONFIGS.get(newOnStreamingJwDaysKey(region));
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === "object") days = parsed;
    } catch (e) {}
  }

  const writes = [];
  // TMDB id checks this sweep may spend (see resolveJustWatchIds), and what
  // they have found so far. On the cron tick they come out of the same
  // outbound-fetch share as the pages (whatever the pages leave); an admin
  // sweep runs in its own request and gets the full allowance.
  const lookups = {
    left: isManual || isFull || !Number.isFinite(fetchBudget)
      ? NEW_ON_STREAMING_JW_MAX_ID_LOOKUPS
      : Math.max(0, Math.min(NEW_ON_STREAMING_JW_MAX_ID_LOOKUPS, Math.floor(fetchBudget) - budget)),
  };
  const idCache = new Map();
  let pendingReset = isReset;
  const clearOnce = async () => {
    if (!pendingReset) return;
    pendingReset = false;
    try {
      await env.DB.prepare("DELETE FROM streaming_events WHERE region = ?").bind(region).run();
      summary.cleared = true;
    } catch (e) {
      console.warn("[Cron] New on Streaming clear failed:", e && e.message ? e.message : e);
    }
  };

  // Newest day first, so a limited budget fills the top of the shelf first.
  const order = [];
  for (let offset = 0; offset < NEW_ON_STREAMING_WINDOW_DAYS; offset++) order.push(offset);
  for (const offset of order) {
    if (budget <= 0) break;
    const date = newOnStreamingIsoDay(nowSec, offset);
    const refresh = offset < NEW_ON_STREAMING_JW_REFRESH_DAYS;
    const st = days[date] || {};
    if (!refresh && st.done) continue;
    // A day's work is a queue of query slices (see splitJustWatchSlice);
    // an unfinished day resumes from its queue and cursor. A finished recent
    // day starts over so late additions are picked up.
    const resume = !st.done && Array.isArray(st.queue) && st.queue.length;
    let queue = resume ? st.queue.slice() : [{}];
    let after = resume ? (st.after || "") : "";
    let position = resume ? (Number(st.position) || 0) : 0;
    const dayEpoch = Math.floor(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 1000);
    let failed = false;
    let outOfLookups = false;
    while (budget > 0 && queue.length) {
      const slice = queue[0];
      let page;
      try {
        page = await fetchJustWatchNewTitles({ country, date, packages, after, slice });
      } catch (err) {
        summary.errors++;
        summary.lastError = err && err.message ? err.message : String(err);
        console.warn(`[Cron] New on Streaming JustWatch ${date} failed:`, summary.lastError);
        budget--;
        summary.units++;
        failed = true;
        break;
      }
      budget--;
      summary.units++;
      await clearOnce();
      if (!after && Number(page.totalCount) >= JUSTWATCH_NEW_TITLES_CAP) {
        const parts = splitJustWatchSlice(slice, packages);
        if (parts) {
          queue = parts.concat(queue.slice(1));
          summary.split = (summary.split || 0) + 1;
          continue;
        }
      }
      const resolved = await resolveJustWatchIds(env, region, page.edges, lookups, idCache, summary);
      if (!resolved) {
        // Not enough TMDB lookups left for this page: stop the day here, on
        // this page's own cursor, and pick it up next sweep.
        outOfLookups = true;
        break;
      }
      position = processJustWatchNewTitles(page.edges, { env, region, dayEpoch, startPosition: position, nowSec, writes, summary, idCache });
      if (writes.length >= 40) {
        await d1BatchInChunks(env, writes, "New on Streaming JustWatch sweep");
        writes.length = 0;
      }
      const info = page.pageInfo || {};
      if (!info.hasNextPage || !info.endCursor) {
        queue = queue.slice(1);
        after = "";
      } else {
        after = info.endCursor;
      }
    }
    const done = !failed && !outOfLookups && queue.length === 0;
    days[date] = done ? { done: true, at: nowSec } : { done: false, queue, after, position, at: nowSec };
    summary.days.push({ date, done, entries: position });
    if (failed || outOfLookups) break;
  }

  if (writes.length > 0) {
    await d1BatchInChunks(env, writes, "New on Streaming JustWatch sweep");
    writes.length = 0;
  }
  const minDay = newOnStreamingIsoDay(nowSec, NEW_ON_STREAMING_WINDOW_DAYS);
  for (const date of Object.keys(days)) {
    if (date < minDay) delete days[date];
  }
  try {
    await env.CONFIGS.put(newOnStreamingJwDaysKey(region), JSON.stringify(days), { expirationTtl: 5184000 });
  } catch (e) {}

  try {
    const pruneRes = await env.DB.prepare(
      `DELETE FROM streaming_events WHERE region = ? AND last_event_at < ?`
    ).bind(region, windowStart).run();
    summary.pruned = (pruneRes && pruneRes.meta && pruneRes.meta.changes) || 0;
  } catch (e) {
    console.warn("[Cron] New on Streaming 30-day prune failed:", e && e.message ? e.message : e);
  }

  summary.ran = true;
  try {
    await env.CONFIGS.put("cron:newonstreaming:lastsweep", JSON.stringify({ at: nowSec, ...summary }), { expirationTtl: 2592000 });
  } catch (e) {}
  return summary;
}

// Sweep entrypoint: JustWatch by default, RapidAPI when
// NEW_ON_STREAMING_ENGINE (or the Worker var of that name) says so.
async function sweepNewOnStreaming(env, ctx, fetchBudget, maxUnits, options = {}) {
  if (newOnStreamingEngine(env) === "justwatch") {
    return sweepJustWatchNewOnStreaming(env, ctx, fetchBudget, maxUnits, options);
  }
  const rapidKey = (env && (env.RAPIDAPI_KEY || env.STREAMING_AVAILABILITY_API_KEY)) || RAPIDAPI_KEY;
  if (!rapidKey) {
    const summary = {
      ran: false,
      reason: "RAPIDAPI_KEY is not set (set with `npx wrangler secret put RAPIDAPI_KEY`)",
      units: 0, seen: 0, added: 0, bumped: 0, errors: 0,
    };
    console.warn(`[Cron] New on Streaming ${summary.reason}`);
    return summary;
  }
  return sweepRapidApiNewOnStreaming(env, ctx, fetchBudget, maxUnits, options);
}

// D1 caps how much one batch may carry, and a sweep tick can produce statements.
async function d1BatchInChunks(env, statements, label) {
  if (!env || !env.DB || !statements.length) return;
  const CHUNK = 20;
  for (let i = 0; i < statements.length; i += CHUNK) {
    try {
      await env.DB.batch(statements.slice(i, i + CHUNK));
    } catch (e) {
      console.warn(`[Cron] ${label}: a batch of writes failed:`, e && e.message ? e.message : e);
    }
  }
}

// Episode bumps check active streaming series against TMDB for recent air dates.
//
// A fallback, and deliberately a narrow one: it only moves the row of a
// service the show is an ORIGINAL of (NEW_ON_STREAMING_ORIGINAL_NETWORKS),
// where the air date and the streaming date are the same day. RapidAPI's
// episode stream is the real source for everything else.
//
// Which 50 shows get checked on a given tick used to be `ORDER BY
// last_event_at DESC LIMIT 50` -- the shows that were bumped most recently.
// That is self-reinforcing: a show that has not had an event lately is, by
// definition, never in that top 50, so it can never be checked, so it can
// never be bumped, so it never re-enters the top 50 -- permanently frozen
// the moment more than 50 other series are more recently active than it.
// With cron ticking every 6 minutes (wrangler.toml), that ceiling is
// crossed almost immediately, which is why a real new episode (e.g. a show
// dozens of spots back) never got picked up here at all. A rotating OFFSET
// cursor, persisted in KV like the sweep's own `cron:newonstreaming:lastsweep`,
// walks the whole active-series table a batch at a time instead, so every
// series gets checked in turn.
async function bumpNewOnStreamingEpisodes(env, ctx, fetchBudget) {
  const summary = { ran: false, reason: "", checked: 0, bumped: 0, errors: 0 };
  if (!env || !env.DB) {
    summary.reason = "needs a bound D1 database";
    return summary;
  }
  // JustWatch's feed already carries every new episode as a dated Season
  // entry; a TMDB air date could only add days mdblist does not have.
  if (newOnStreamingEngine(env) === "justwatch") {
    summary.reason = "not needed: the JustWatch feed carries new episodes itself";
    return summary;
  }
  const tmdbKey = (env && env.TMDB_API_KEY) || TMDB_API_KEY;
  if (!tmdbKey) {
    summary.reason = "TMDB_API_KEY is not set";
    return summary;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const sevenDaysAgo = nowSec - (7 * 86400);
  const region = NEW_ON_STREAMING_REGIONS[0];
  const batchSize = 50;

  let totalActive = 0;
  try {
    const { results } = await env.DB.prepare(
      `SELECT COUNT(DISTINCT imdb_id) AS n FROM streaming_events
        WHERE region = ? AND kind = 'series' AND removed_at IS NULL`
    ).bind(region).all();
    totalActive = Number((results && results[0] && results[0].n) || 0);
  } catch (e) {
    summary.reason = `Database query failed: ${e && e.message ? e.message : e}`;
    return summary;
  }

  if (!totalActive) {
    summary.ran = true;
    summary.reason = "No active series in database to bump";
    return summary;
  }

  const cursorKey = `cron:newonstreaming:bumpcursor:${region}`;
  let cursor = 0;
  if (env.CONFIGS) {
    try {
      const raw = await env.CONFIGS.get(cursorKey);
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 0) cursor = n;
    } catch (e) {}
  }
  const offset = cursor % totalActive;

  let shows = [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT imdb_id, MAX(tmdb_id) AS tmdb_id, MAX(name) AS name,
              GROUP_CONCAT(service || ':' || last_event_at) AS services
         FROM streaming_events
        WHERE region = ? AND kind = 'series' AND removed_at IS NULL
        GROUP BY imdb_id
        ORDER BY imdb_id
        LIMIT ? OFFSET ?`
    ).bind(region, batchSize, offset).all();
    shows = results || [];
  } catch (e) {
    summary.reason = `Database query failed: ${e && e.message ? e.message : e}`;
    return summary;
  }

  if (!shows.length) {
    summary.ran = true;
    summary.reason = "No active series in database to bump";
    return summary;
  }

  // Advance the cursor by exactly how many rows this tick actually spends a
  // TMDB fetch on (maxChecks), never by the wider fetched batch -- a small
  // fetchBudget (the admin dashboard's manual "sweep now" passes just 4)
  // must not walk the cursor past rows it never checked, or those rows are
  // silently skipped every rotation rather than merely deferred to the next one.
  const maxChecks = Math.min(shows.length, Number.isFinite(fetchBudget) ? Math.max(5, fetchBudget) : 25);
  if (env.CONFIGS) {
    try {
      await env.CONFIGS.put(cursorKey, String(offset + maxChecks), { expirationTtl: 2592000 });
    } catch (e) {}
  }

  const writes = [];

  for (let i = 0; i < maxChecks; i++) {
    const row = shows[i];
    summary.checked++;
    let tmdbId = row.tmdb_id;
    if (!tmdbId && row.imdb_id && row.imdb_id.startsWith("tmdb:")) {
      tmdbId = extractCleanTmdbId(row.imdb_id);
    }
    if (!tmdbId && row.imdb_id && row.imdb_id.startsWith("tt")) {
      try {
        const findRes = await fetch(
          `https://api.themoviedb.org/3/find/${encodeURIComponent(row.imdb_id)}?api_key=${encodeURIComponent(tmdbKey)}&external_source=imdb_id`,
          { headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` }, cf: { cacheTtl: 86400, cacheEverything: true } }
        );
        if (findRes.ok) {
          const findData = await findRes.json();
          if (findData.tv_results && findData.tv_results[0]) {
            tmdbId = findData.tv_results[0].id;
          }
        }
      } catch (e) {}
    }
    if (!tmdbId) continue;

    try {
      const tvRes = await fetch(`https://api.themoviedb.org/3/tv/${encodeURIComponent(tmdbId)}?api_key=${encodeURIComponent(tmdbKey)}`, {
        headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
        cf: { cacheTtl: 14400, cacheEverything: true },
      });
      if (!tvRes.ok) continue;
      const tvData = await tvRes.json();
      const lastAir = tvData && tvData.last_episode_to_air;
      if (lastAir && lastAir.air_date) {
        const epEpoch = newOnStreamingDateToEpoch(lastAir.air_date, nowSec);
        if (epEpoch >= sevenDaysAgo) {
          // Only the rows of services this show is an original of: an air
          // date is when the episode reached ITS network, which says nothing
          // about a service that merely licenses older seasons. Bumping every
          // row put library titles (Live PD, Dance Moms on Netflix) at the
          // top of the shelf for episodes Netflix never got -- rows
          // mdblist.com/new-on-streaming, correctly, never shows. Everything
          // else is left to RapidAPI's episode stream, which sees the
          // episode land on the service itself.
          const networkIds = new Set(
            (Array.isArray(tvData.networks) ? tvData.networks : []).map((n) => Number(n && n.id)).filter(Number.isFinite)
          );
          const serviceRows = String(row.services || "").split(",").filter(Boolean).map((part) => {
            const at = part.lastIndexOf(":");
            return { service: part.slice(0, at), lastEventAt: Number(part.slice(at + 1)) || 0 };
          });
          const originals = serviceRows.filter((r) =>
            (NEW_ON_STREAMING_ORIGINAL_NETWORKS[r.service] || []).some((id) => networkIds.has(id))
          );
          if (!originals.length) {
            summary.notOriginal = (summary.notOriginal || 0) + 1;
            continue;
          }
          const services = originals.filter((r) => epEpoch > r.lastEventAt).map((r) => r.service);
          if (!services.length) continue;
          const placeholders = services.map(() => "?").join(",");
          writes.push(
            env.DB.prepare(
              `UPDATE streaming_events
                  SET last_event_at = ?,
                      event_kind = 'episode',
                      season = ?,
                      episode = ?,
                      tmdb_id = COALESCE(streaming_events.tmdb_id, ?)
                WHERE region = ? AND imdb_id = ? AND service IN (${placeholders}) AND ? > last_event_at`
            ).bind(epEpoch, lastAir.season_number || null, lastAir.episode_number || null, tmdbId, region, row.imdb_id, ...services, epEpoch)
          );
          summary.bumped++;
        }
      }
    } catch (e) {
      summary.errors++;
    }
  }

  if (writes.length > 0) {
    await d1BatchInChunks(env, writes, "New on Streaming episode bump");
  }

  summary.ran = true;
  return summary;
}

// --- Quick Add network channel presets ---------------------------------------
//
// Builds the episode pool for one "Quick Add Popular Networks" channel (up
// to CHANNEL_PRESET_DISCOVER_PAGES pages of candidate shows on that TMDB
// network, up to 3 seasons each, capped at CHANNEL_POOL_MAX_ITEMS episodes
// total) and caches it in KV under channel:preset:v2:<networkId>
// for 24h. Shared by the /api/channel-preset route (25_api-catalog-routes.js,
// which a Quick Add click reads on the way to adding the channel) and
// prewarmChannelPresets below (the cron sweep that keeps that cache from
// ever being cold when a click reads it) -- one implementation, so the two
// can never build a different lineup for the same network.
//
// options.env/ctx: env is required for caching; ctx, when given, lets a KV
// write ride ctx.waitUntil instead of blocking the caller (used by the live
// route; the cron sweep has nothing waiting on it, so it just awaits).
// options.forceRebuild skips the cache read (the cron sweep always rebuilds,
// since its entire job is refreshing that cache before it goes stale).
async function buildNetworkChannelPreset(networkId, name, origin, options = {}) {
  const { env, ctx, forceRebuild } = options;
  const cacheKey = `channel:preset:v2:${networkId}`;

  if (!forceRebuild && env && env.CONFIGS) {
    try {
      const cached = await env.CONFIGS.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && Array.isArray(parsed.items) && parsed.items.length) {
          return { ok: true, channel: parsed };
        }
      }
    } catch (e) {}
  }

  try {
    // Up to CHANNEL_PRESET_DISCOVER_PAGES pages (20 shows/page) of candidate
    // shows -- the same up-to-200-show pool /api/quick-channel-shows already
    // offers the client-built path, needed so a popular network actually has
    // enough material to approach CHANNEL_POOL_MAX_ITEMS episodes. Safe to
    // fetch in full: assembleFromShows below stops issuing new show/season
    // requests the moment the pool is full, so a network that fills up in
    // its first page or two never pays for the rest of this discovery.
    const discoverResults = [];
    for (let page = 1; page <= CHANNEL_PRESET_DISCOVER_PAGES; page++) {
      const discoverRes = await fetch(
        `https://api.themoviedb.org/3/discover/tv?api_key=${encodeURIComponent(TMDB_API_KEY)}` +
          `&with_networks=${encodeURIComponent(networkId)}&sort_by=popularity.desc&page=${page}&include_adult=false`,
        { headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` }, cf: { cacheTtl: 86400, cacheEverything: true } }
      );
      if (!discoverRes.ok) {
        if (page === 1) return { ok: false, error: "TMDB network request failed.", status: 502 };
        break;
      }
      const discoverData = await discoverRes.json();
      discoverResults.push(...(discoverData.results || []));
      if (page >= (discoverData.total_pages || 1)) break;
    }
    let topShows = discoverResults;
    const nameLower = String(name || "").toLowerCase();
    // TMDB's own with_networks discover comes back empty for a handful of
    // networks it otherwise carries shows for (a TMDB data gap, not
    // something this add-on can fix) -- these hand-picked lineups are the
    // fallback for exactly those, tried again below if the discover-sourced
    // shows also failed to yield a single episode.
    const namedFallbackShows = () => {
      if (nameLower.includes("metv")) return [{ id: 4607 }, { id: 735 }, { id: 1403 }, { id: 2098 }, { id: 2287 }, { id: 873 }, { id: 253 }, { id: 914 }, { id: 2101 }, { id: 2289 }, { id: 2099 }, { id: 2100 }, { id: 2344 }, { id: 2103 }];
      if (nameLower.includes("food")) return [{ id: 2382 }, { id: 17855 }, { id: 62326 }, { id: 2383 }, { id: 63278 }, { id: 44006 }, { id: 11822 }, { id: 67070 }];
      if (nameLower.includes("ion")) return [{ id: 62741 }, { id: 1408 }, { id: 1418 }, { id: 4614 }, { id: 62688 }, { id: 2734 }];
      return [];
    };
    if (!topShows.length) topShows = namedFallbackShows();
    if (!topShows.length) return { ok: false, error: "No shows found for that network." };

    let networkLogo = null;
    try {
      const networkRes = await fetch(
        `https://api.themoviedb.org/3/network/${encodeURIComponent(networkId)}?api_key=${encodeURIComponent(TMDB_API_KEY)}`,
        { headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` }, cf: { cacheTtl: 604800, cacheEverything: true } }
      );
      if (networkRes.ok) {
        const networkData = await networkRes.json();
        if (networkData.logo_path) networkLogo = `${origin}/api/channel-logo?path=${encodeURIComponent(networkData.logo_path)}`;
      }
    } catch (e) {}

    const allEpisodes = [];
    let poster = networkLogo;
    let backdrop = null;

    const assembleFromShows = async (showsList) => {
      await mapWithConcurrency(showsList, 4, async (show) => {
        if (allEpisodes.length >= CHANNEL_POOL_MAX_ITEMS) return;
        try {
          const showRes = await fetch(
            `https://api.themoviedb.org/3/tv/${encodeURIComponent(show.id)}?api_key=${encodeURIComponent(TMDB_API_KEY)}&append_to_response=external_ids`,
            { headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` }, cf: { cacheTtl: 86400, cacheEverything: true } }
          );
          if (!showRes.ok) return;
          const fullShow = await showRes.json();
          const imdbId = (fullShow.external_ids && fullShow.external_ids.imdb_id) || fullShow.imdb_id || (`tmdb:${show.id}`);

          if (!poster && fullShow.poster_path) poster = `https://image.tmdb.org/t/p/w500${fullShow.poster_path}`;
          if (!backdrop && fullShow.backdrop_path) backdrop = `https://image.tmdb.org/t/p/w780${fullShow.backdrop_path}`;

          const showPosterUrl = fullShow.poster_path ? `https://image.tmdb.org/t/p/w500${fullShow.poster_path}` : "";
          const validSeasons = (fullShow.seasons || []).filter((s) => s.season_number > 0).slice(0, 3);

          for (const s of validSeasons) {
            if (allEpisodes.length >= CHANNEL_POOL_MAX_ITEMS) break;
            const sRes = await fetch(
              `https://api.themoviedb.org/3/tv/${encodeURIComponent(show.id)}/season/${s.season_number}?api_key=${encodeURIComponent(TMDB_API_KEY)}`,
              { headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` }, cf: { cacheTtl: 86400, cacheEverything: true } }
            );
            if (!sRes.ok) continue;
            const sData = await sRes.json();
            for (const ep of (sData.episodes || [])) {
              if (allEpisodes.length >= CHANNEL_POOL_MAX_ITEMS) break;
              const stillUrl = ep.still_path ? `https://image.tmdb.org/t/p/w500${ep.still_path}` : "";
              allEpisodes.push({
                kind: "episode",
                imdbId: imdbId,
                season: s.season_number,
                episode: ep.episode_number,
                showName: fullShow.name || show.name || "",
                epName: ep.name || (`Episode ${ep.episode_number}`),
                title: `${fullShow.name || show.name} S${s.season_number}E${ep.episode_number} — ${ep.name || (`Episode ${ep.episode_number}`)}`,
                released: ep.air_date || "",
                thumbnail: stillUrl || showPosterUrl,
                poster: showPosterUrl || stillUrl,
                showPoster: showPosterUrl,
              });
            }
          }
        } catch (e) {}
      });
    };

    await assembleFromShows(topShows);

    if (!allEpisodes.length) {
      const fallbackShows = namedFallbackShows();
      if (fallbackShows.length) await assembleFromShows(fallbackShows);
    }

    if (!allEpisodes.length) return { ok: false, error: "Could not assemble episodes for this network." };

    const channelPayload = {
      name: name,
      poster: poster || (origin + "/icon.png"),
      backdrop: backdrop || poster || (origin + "/icon.png"),
      items: allEpisodes,
      shuffle: false,
      dailyRotate: true,
      // When this build actually ran, not when a cache hit last served it --
      // read by the admin dashboard's Channel Presets tab so "is this the
      // old 200-item cache or the new one" is a real answer instead of a
      // guess. Every consumer of this payload (channelSourceItems,
      // fetchChannelCatalog, ...) reads only the fields above; this one
      // rides along unused by any of them.
      builtAt: Date.now(),
    };

    if (env && env.CONFIGS) {
      const put = env.CONFIGS.put(cacheKey, JSON.stringify(channelPayload), { expirationTtl: 86400 }).catch(() => {});
      if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(put); else await put;
    }
    return { ok: true, channel: channelPayload };
  } catch (err) {
    return { ok: false, error: (err && err.message) || "Failed to build network channel preset.", status: 500 };
  }
}

// A rotating cursor (KV, one entry advanced per cron tick) refreshes one
// Quick Add network's channel preset per tick -- all ~28 networks
// (CHANNEL_PRESET_NETWORKS, 00_constants.js) cycle through in a few hours at
// the default 6-minute cron, comfortably inside the 24h TTL those presets
// are cached under. That keeps /api/channel-preset always serving a warm
// cache instead of a user's Quick Add click being the one that pays for a
// live build of up to CHANNEL_POOL_MAX_ITEMS (5,000) episodes.
//
// This pool is never embedded whole into a saved config -- a Quick Add
// catalog row only ever carries a tiny {presetNetworkId, channelId, ...}
// pointer (see quickAddChannel, 20_client-channel-builder.js), resolved
// back to this cache by channelSourceItems (05_catalog-core.js) at the
// moment a channel's actual episode list is needed. That split is what lets
// the pool be this big without reviving the "too large to save" bug several
// Quick Add channels in one config used to hit when the whole pool rode in
// the install URL.
async function prewarmChannelPresets(env, ctx) {
  const summary = { ran: false, refreshed: "", error: "" };
  if (!env || !env.CONFIGS) return summary;
  const networks = CHANNEL_PRESET_NETWORKS;
  if (!networks.length) return summary;

  let cursor = 0;
  try {
    const raw = await env.CONFIGS.get("cron:channelpresets:cursor");
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) cursor = n;
  } catch (e) {}

  const net = networks[cursor % networks.length];
  try {
    await env.CONFIGS.put("cron:channelpresets:cursor", String(cursor + 1), { expirationTtl: 2592000 });
  } catch (e) {}

  const result = await buildNetworkChannelPreset(net.id, net.name, CHANNEL_PRESET_PREWARM_ORIGIN, { env, forceRebuild: true });
  summary.ran = true;
  summary.refreshed = net.name;
  if (!result.ok) summary.error = result.error || "";
  return summary;
}

// Allows adding or syncing any movie or show directly into streaming_events by IMDb ID, TMDB ID, or title search
async function addOrSyncStreamingEvent(env, { input, service, kind = "series", date }) {
  if (!env || !env.DB) throw new Error("Database binding DB is missing.");
  const tmdbKey = (env && env.TMDB_API_KEY) || TMDB_API_KEY;
  if (!tmdbKey) throw new Error("TMDB_API_KEY is not set.");
  const sInput = String(input || "").trim();
  if (!sInput) throw new Error("Input title or ID is required.");

  const region = NEW_ON_STREAMING_REGIONS[0];
  const serviceKey = normalizeNewOnStreamingServiceKey(service) || "netflix";
  const nowSec = Math.floor(Date.now() / 1000);

  let tmdbData = null;
  let resolvedKind = kind === "movie" ? "movie" : "series";

  if (sInput.startsWith("tt")) {
    const findRes = await fetch(
      `https://api.themoviedb.org/3/find/${encodeURIComponent(sInput)}?api_key=${encodeURIComponent(tmdbKey)}&external_source=imdb_id`,
      { headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` }, cf: { cacheTtl: 86400, cacheEverything: true } }
    );
    if (findRes.ok) {
      const f = await findRes.json();
      if (f.tv_results && f.tv_results.length > 0) {
        resolvedKind = "series";
        tmdbData = f.tv_results[0];
      } else if (f.movie_results && f.movie_results.length > 0) {
        resolvedKind = "movie";
        tmdbData = f.movie_results[0];
      }
    }
  } else if (/^\d+$/.test(sInput) || sInput.startsWith("tmdb:")) {
    const rawId = sInput.replace("tmdb:", "");
    const type = resolvedKind === "movie" ? "movie" : "tv";
    const detRes = await fetch(
      `https://api.themoviedb.org/3/${type}/${encodeURIComponent(rawId)}?api_key=${encodeURIComponent(tmdbKey)}&append_to_response=external_ids`,
      { headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` }, cf: { cacheTtl: 86400, cacheEverything: true } }
    );
    if (detRes.ok) {
      tmdbData = await detRes.json();
    }
  }

  if (!tmdbData) {
    const searchType = resolvedKind === "movie" ? "movie" : "tv";
    const sRes = await fetch(
      `https://api.themoviedb.org/3/search/${searchType}?api_key=${encodeURIComponent(tmdbKey)}&query=${encodeURIComponent(sInput)}&page=1`,
      { headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` }, cf: { cacheTtl: 86400, cacheEverything: true } }
    );
    if (sRes.ok) {
      const sJson = await sRes.json();
      if (sJson.results && sJson.results.length > 0) {
        tmdbData = sJson.results[0];
      }
    }
  }

  if (!tmdbData || !tmdbData.id) {
    throw new Error(`Could not find title or ID "${sInput}" on TMDB.`);
  }

  const tmdbId = tmdbData.id;
  const tmdbType = resolvedKind === "movie" ? "movie" : "tv";
  const fullRes = await fetch(
    `https://api.themoviedb.org/3/${tmdbType}/${encodeURIComponent(tmdbId)}?api_key=${encodeURIComponent(tmdbKey)}&append_to_response=external_ids`,
    { headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` }, cf: { cacheTtl: 86400, cacheEverything: true } }
  );
  const fullData = fullRes.ok ? await fullRes.json() : tmdbData;

  const ext = (fullData && fullData.external_ids) || {};
  const imdbId = ext.imdb_id || (sInput.startsWith("tt") ? sInput : `tmdb:${tmdbId}`);
  const name = fullData.title || fullData.name || fullData.original_title || fullData.original_name || sInput;
  const poster = fullData.poster_path ? `https://image.tmdb.org/t/p/w500${fullData.poster_path}` : null;
  const background = fullData.backdrop_path ? `https://image.tmdb.org/t/p/w1280${fullData.backdrop_path}` : null;
  const dateStr = fullData.release_date || fullData.first_air_date || "";
  const year = dateStr ? dateStr.slice(0, 4) : null;

  let eventAt = nowSec;
  let season = null;
  let episode = null;
  let eventKind = "added";

  if (date) {
    eventAt = newOnStreamingDateToEpoch(date, nowSec) || nowSec;
  } else if (resolvedKind === "series" && fullData.last_episode_to_air && fullData.last_episode_to_air.air_date) {
    const epAir = fullData.last_episode_to_air;
    eventAt = newOnStreamingDateToEpoch(epAir.air_date, nowSec) || nowSec;
    eventKind = "episode";
    season = epAir.season_number || null;
    episode = epAir.episode_number || null;
  }

  await env.DB.prepare(
    `INSERT INTO streaming_events
       (region, service, imdb_id, tmdb_id, kind, added_at, last_event_at, event_kind,
        season, episode, seeded, last_seen_walk, removed_at, name, poster, background, year)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, NULL, ?, ?, ?, ?)
     ON CONFLICT (region, service, imdb_id) DO UPDATE SET
       last_seen_walk = 1,
       tmdb_id        = COALESCE(excluded.tmdb_id, streaming_events.tmdb_id),
       name           = CASE WHEN excluded.name != '' THEN excluded.name ELSE streaming_events.name END,
       poster         = COALESCE(excluded.poster, streaming_events.poster),
       background     = COALESCE(excluded.background, streaming_events.background),
       year           = COALESCE(excluded.year, streaming_events.year),
       last_event_at  = excluded.last_event_at,
       event_kind     = excluded.event_kind,
       season         = excluded.season,
       episode        = excluded.episode,
       removed_at     = NULL`
  ).bind(
    region,
    serviceKey,
    imdbId,
    tmdbId,
    resolvedKind,
    eventAt,
    eventAt,
    eventKind,
    season,
    episode,
    name,
    poster,
    background,
    year
  ).run();

  return {
    imdbId,
    tmdbId,
    name,
    kind: resolvedKind,
    service: serviceKey,
    eventAt,
    eventKind,
    season,
    episode,
    year,
    poster,
  };
}

// Serves the catalog. One indexed D1 read, no outbound fetch.
async function fetchNewOnStreaming(entry, skip = 0, keys = {}) {
  const env = keys && keys.env;
  if (!env || !env.DB) {
    throw new Error(
      "New on Streaming needs a D1 database. The Worker owner has to bind one as DB and run migrations/0011_add_streaming_events.sql."
    );
  }
  const isAll = entry && (entry.type === "all" || entry.type === "mixed");
  const kind = entry && entry.type === "series" ? "series" : (isAll ? "all" : "movie");
  const region = newOnStreamingRegion(keys.region);
  const rawUrl = String((entry && entry.url) || "").trim();
  const suffix = rawUrl.replace(/^(?:tmdb|rapidapi|streaming):new-on-streaming:?/i, "");
  const services = parseNewOnStreamingServices(suffix);
  const selected = services || NEW_ON_STREAMING_PROVIDERS.map((p) => p.key);
  const placeholders = selected.map(() => "?").join(",");
  // Not capped: the whole 30-day window pages like any other catalog.
  const pageSize = Number.isFinite(keys.limit) && keys.limit > 0 ? Math.min(100, Math.floor(keys.limit)) : PAGE_SIZE;
  const qStr = entry && typeof entry.q === "string" ? entry.q.trim().toLowerCase() : "";
  const searchFilter = qStr ? "AND (LOWER(name) LIKE ? OR LOWER(imdb_id) LIKE ?) " : "";
  const searchParams = qStr ? [`%${qStr}%`, `%${qStr}%`] : [];

  let results = [];
  let total = null;
  try {
    const wantTotal = keys.wantTotal === true || Math.max(0, skip) === 0;
    const kindFilter = isAll ? "" : "AND kind = ? ";
    const queryParams = isAll
      ? [region, ...selected, ...searchParams, pageSize, Math.max(0, skip)]
      : [region, kind, ...selected, ...searchParams, pageSize, Math.max(0, skip)];
    const countParams = isAll
      ? [region, ...selected, ...searchParams]
      : [region, kind, ...selected, ...searchParams];

    const [page, count] = await Promise.all([
      env.DB.prepare(
        `SELECT imdb_id, kind, name, poster, background, year, service, MAX(last_event_at) AS ev,
                GROUP_CONCAT(DISTINCT service) AS services
           FROM streaming_events
          WHERE region = ? ${kindFilter}AND removed_at IS NULL AND service IN (${placeholders}) ${searchFilter}
          GROUP BY imdb_id
          ORDER BY ev DESC
          LIMIT ? OFFSET ?`
      ).bind(...queryParams).all(),
      wantTotal
        ? env.DB.prepare(
            `SELECT COUNT(DISTINCT imdb_id) AS n
               FROM streaming_events
              WHERE region = ? ${kindFilter}AND removed_at IS NULL AND service IN (${placeholders}) ${searchFilter}`
          ).bind(...countParams).all()
        : null,
    ]);
    results = (page && page.results) || [];
    const countRow = ((count && count.results) || [])[0];
    if (countRow && Number.isFinite(Number(countRow.n))) total = Number(countRow.n);
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/no such table/i.test(msg)) {
      throw new Error(
        "New on Streaming has no table to read. Run migrations/0011_add_streaming_events.sql against this Worker's D1 database."
      );
    }
    throw new Error("New on Streaming could not be read from the database.");
  }

  const metas = results.map((row) => ({
    id: row.imdb_id,
    type: row.kind || (entry && entry.type !== "all" && entry.type !== "mixed" ? entry.type : "movie"),
    name: row.name || "",
    poster: row.poster || `https://images.metahub.space/poster/medium/${row.imdb_id}/img`,
    background: row.background || undefined,
    releaseInfo: row.year || undefined,
    service: row.service || "",
    services: row.services ? row.services.split(",") : (row.service ? [row.service] : []),
    addedAt: row.ev || undefined,
  }));
  metas.totalItems = total;
  metas.limit = pageSize;
  metas.skip = Math.max(0, skip);
  return metas;
}

// What the admin dashboard reads: RapidAPI quota usage, 30-day window metrics and sweep status.
async function newOnStreamingStatus(env) {
  const hasRapidKey = !!((env && (env.RAPIDAPI_KEY || env.STREAMING_AVAILABILITY_API_KEY)) || RAPIDAPI_KEY);
  const usage = await getRapidApiMonthlyUsage(env);
  const out = {
    d1Bound: !!(env && env.DB),
    tableReady: false,
    rapidKeyConfigured: hasRapidKey,
    engine: newOnStreamingEngine(env),
    region: NEW_ON_STREAMING_REGIONS[0],
    providers: NEW_ON_STREAMING_PROVIDERS.map((p) => ({ key: p.key, name: p.name, rapidId: p.rapidId })),
    monthlyUsage: {
      month: usage.month,
      count: usage.count,
      limit: usage.limit,
      safetyCap: usage.safetyCap,
      remaining: Math.max(0, usage.limit - usage.count),
      lastAt: usage.lastAt,
    },
    intervalSeconds: NEW_ON_STREAMING_SWEEP_INTERVAL_SECONDS,
    windowDays: NEW_ON_STREAMING_WINDOW_DAYS,
    lastSweep: null,
    byService: [],
    totals: { movie: 0, series: 0, removed: 0 },
    error: "",
  };
  if (env && env.CONFIGS) {
    try {
      const raw = await env.CONFIGS.get("cron:newonstreaming:lastsweep");
      if (raw) out.lastSweep = JSON.parse(raw);
    } catch (e) {}
  }
  // How far each /changes stream has read. `readUpTo` is the newest change
  // timestamp every earlier change is known to be in the table for; a stream
  // with `catchingUp` set is still paging through a busy stretch.
  const nowSec = Math.floor(Date.now() / 1000);
  const streamState = await readNewOnStreamingStreams(env, out.region);
  out.nextTickPages = newOnStreamingTickBudget(usage.count, nowSec);
  out.streams = NEW_ON_STREAMING_STREAMS.map((stream) => {
    const st = streamState[stream.id];
    const readUpTo = st.pending ? Math.max(st.pending.from, st.pending.reachedAt || 0) : st.hwm;
    return {
      id: stream.id,
      changeType: stream.changeType,
      itemType: stream.itemType,
      readUpTo: readUpTo || 0,
      catchingUp: !!st.pending,
      lastRunAt: st.lastRunAt || 0,
    };
  });
  if (env && env.CONFIGS) {
    try {
      const raw = await env.CONFIGS.get(newOnStreamingJwDaysKey(out.region));
      const days = raw ? JSON.parse(raw) : {};
      out.jwDaysDone = Object.values(days || {}).filter((d) => d && d.done).length;
    } catch (e) {}
  }
  if (!out.d1Bound) return out;
  try {
    const { results } = await env.DB.prepare(
      `SELECT service, kind,
              SUM(CASE WHEN removed_at IS NULL THEN 1 ELSE 0 END) AS live,
              SUM(CASE WHEN removed_at IS NOT NULL THEN 1 ELSE 0 END) AS removed,
              MAX(CASE WHEN removed_at IS NULL THEN last_event_at ELSE 0 END) AS newest
         FROM streaming_events
        WHERE region = ?
        GROUP BY service, kind`
    ).bind(out.region).all();
    out.tableReady = true;
    for (const row of (results || [])) {
      const n = Number(row.live) || 0;
      const removed = Number(row.removed) || 0;
      out.byService.push({
        service: String(row.service || ""),
        kind: String(row.kind || ""),
        count: n,
        removed,
        newest: Number(row.newest) || 0,
      });
      if (row.kind === "series") out.totals.series += n; else out.totals.movie += n;
      out.totals.removed += removed;
    }
    out.byService.sort((a, b) => a.service.localeCompare(b.service) || a.kind.localeCompare(b.kind));
  } catch (e) {
    out.error = /no such table/i.test(String((e && e.message) || e))
      ? "streaming_events does not exist yet -- run migrations/0011_add_streaming_events.sql."
      : safeErrorMessage(e);
  }
  return out;
}

// --- My Lists Addon Most Watched ---------------------------------------------
//
// mylists:most-watched:today|7|30 -- the add-on's own chart of what people
// using it watched, from the admin Trending Data "Most Watched" counts. See
// MOST_WATCHED_* (00_constants.js) for the refresh rules.

function parseMostWatchedWindow(url) {
  const m = /^mylists:most-watched:([a-z0-9]+)$/i.exec(String(url || "").trim());
  const w = m ? m[1].toLowerCase() : "";
  return MOST_WATCHED_WINDOWS.includes(w) ? w : null;
}

// v2: v1 snapshots could hold the "null" entry and up to 100 titles; bumping
// the version rebuilds every live chart on its next request instead of
// waiting out the day.
function mostWatchedSnapshotKey(window, type) {
  return `mylists:mostwatched:v2:${window}:${type}`;
}

// Is a stored snapshot still the current one?
function mostWatchedSnapshotFresh(snap, window, nowMs) {
  if (!snap || !Array.isArray(snap.metas) || !Number.isFinite(snap.builtAt)) return false;
  if (window === "today") {
    return snap.day === easternDateKey(new Date(nowMs)) && nowMs - snap.builtAt < MOST_WATCHED_TODAY_REFRESH_SECONDS * 1000;
  }
  return snap.day === easternDateKey(new Date(nowMs));
}

async function buildMostWatchedMetas(env, ctx, window, type) {
  const entries = await computeLeaderboard(env, "watched", window, type);
  // Counts are per show already (the website sends showId, the scrobbler the
  // show's IMDb id), but an episode id ("tt123:1:2") that slipped through is
  // folded into its show rather than charting on its own.
  const byId = new Map();
  for (const e of entries || []) {
    if (!e || !e.id) continue;
    // Only a real title id charts: an IMDb id, or tmdb:<n>. A bare number is
    // ambiguous -- the Trakt importer falls back to an episode's TMDB id when
    // the show has no IMDb id -- and anything else ("null") is not a title.
    const m = /^(tt\d+|tmdb:\d+)(?::\d+:\d+)?$/.exec(String(e.id).trim());
    if (!m) continue;
    const id = m[1];
    const prev = byId.get(id);
    if (prev) prev.count += Number(e.count) || 0;
    else byId.set(id, { ...e, id, count: Number(e.count) || 0 });
  }
  const ranked = [...byId.values()]
    .filter((e) => e.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, MOST_WATCHED_MAX_ITEMS);

  const tmdbKey = (env && env.TMDB_API_KEY) || TMDB_API_KEY;
  let lookups = 0;
  const metas = [];
  for (const e of ranked) {
    const isImdb = /^tt\d+$/.test(e.id);
    let name = e.title && e.title !== e.id ? e.title : "";
    let poster = isImdb ? `https://images.metahub.space/poster/medium/${e.id}/img` : "";
    let releaseInfo;
    if ((!poster || !name) && tmdbKey && lookups < MOST_WATCHED_MAX_LOOKUPS) {
      lookups++;
      const det = await fetchTmdbItemDetails(e.id, tmdbKey, type, "", false, env, ctx).catch(() => null);
      if (det) {
        name = name || det.title || "";
        poster = poster || det.poster || "";
        if (det.releaseYear) releaseInfo = String(det.releaseYear);
      }
    }
    // A row Stremio cannot draw or name is worse than a shorter chart.
    if (!name || !poster) continue;
    metas.push({ id: e.id, type, name, poster, releaseInfo, watchCount: e.count });
  }
  return metas;
}

async function fetchMostWatchedCatalog(entry, skip = 0, keys = {}) {
  const env = keys && keys.env;
  const window = parseMostWatchedWindow(entry && entry.url);
  if (!window) throw new Error("Unknown Most Watched window.");
  const type = entry && entry.type === "series" ? "series" : "movie";
  const pageSize = Number.isFinite(keys.limit) && keys.limit > 0 ? Math.min(100, Math.floor(keys.limit)) : PAGE_SIZE;
  const nowMs = Date.now();
  const key = mostWatchedSnapshotKey(window, type);

  let snap = null;
  if (env && env.CONFIGS) {
    try {
      const raw = await env.CONFIGS.get(key);
      snap = raw ? JSON.parse(raw) : null;
    } catch (e) {
      snap = null;
    }
  }
  if (!mostWatchedSnapshotFresh(snap, window, nowMs)) {
    try {
      const metas = await buildMostWatchedMetas(env, keys.ctx, window, type);
      snap = { builtAt: nowMs, day: easternDateKey(new Date(nowMs)), metas };
      if (env && env.CONFIGS) {
        const put = env.CONFIGS.put(key, JSON.stringify(snap), { expirationTtl: 3 * 86400 }).catch(() => {});
        if (keys.ctx && typeof keys.ctx.waitUntil === "function") keys.ctx.waitUntil(put);
        else await put;
      }
    } catch (e) {
      // A failed rebuild serves the last snapshot rather than nothing.
      if (!snap || !Array.isArray(snap.metas)) throw e;
    }
  }

  const all = snap && Array.isArray(snap.metas) ? snap.metas : [];
  const start = Math.max(0, skip);
  const page = all.slice(start, start + pageSize).map((m) => ({
    id: m.id,
    type: m.type || type,
    name: m.name,
    poster: m.poster,
    releaseInfo: m.releaseInfo || undefined,
  }));
  page.totalItems = all.length;
  page.limit = pageSize;
  page.skip = start;
  return page;
}

// --- Anime Unpacking & Multi-Season Parts Resolution -------------------------
// Fixes TMDB cataloging that compresses multi-season anime (e.g. MASHLE 24 eps,
// Re:ZERO 85 eps, Jujutsu Kaisen 59 eps) into a single monolithic season.
// Restores true seasonal divisions using TMDB Episode Groups with seamless
// Cinemeta fallback for Stremio stream compatibility.

const ANIME_UNPACK_EXCLUDE_RE = /edit|re-?cut|director'?s|deleted|alternat|chronolog|dvd|broadcast|air.?date|absolut|special|trailer|extra|\bova\b|\boad\b|production/i;
const ANIME_UNPACK_ORIGINAL_RE = /original/i;
const ANIME_UNPACK_PART_RE = /part/i;
const ANIME_UNPACK_SEASON_RE = /seasons?/i;

function pickDefaultEpisodeGroupId(groups, standardSeasonCount, standardEpisodeCount, totalEpisodeCountWithSpecials) {
  if (!groups || !Array.isArray(groups) || groups.length === 0) return null;
  if (!(standardSeasonCount > 0) || !(standardEpisodeCount > 0)) return null;
  let best = null;
  for (const g of groups) {
    if (!g || !g.id) continue;
    const gc = typeof g.group_count === "number" ? g.group_count : 0;
    const ec = typeof g.episode_count === "number" ? g.episode_count : 0;
    if (gc <= 1 || ec <= 0) continue;
    if (gc === standardSeasonCount) continue;
    const matchRegular = ec === standardEpisodeCount;
    const matchWithSpecials =
      typeof totalEpisodeCountWithSpecials === "number" &&
      totalEpisodeCountWithSpecials > standardEpisodeCount &&
      (ec === totalEpisodeCountWithSpecials ||
        (ec > standardEpisodeCount && Math.abs(ec - totalEpisodeCountWithSpecials) <= 15));
    if (!matchRegular && !matchWithSpecials) continue;
    const text = `${g.name || ""} ${g.description || ""}`;
    if (ANIME_UNPACK_EXCLUDE_RE.test(g.name || "")) continue;
    if (standardSeasonCount > 1 && /volum/i.test(g.name || "")) continue;
    let score = 0;
    if (g.type === 1) score += 3;
    if (standardSeasonCount > 1) {
      if (ANIME_UNPACK_PART_RE.test(text)) {
        score += 2;
        if (ANIME_UNPACK_ORIGINAL_RE.test(text)) score += 3;
      }
    } else {
      if (ANIME_UNPACK_ORIGINAL_RE.test(text)) score += 3;
      if (ANIME_UNPACK_PART_RE.test(text)) score += 2;
      if (ANIME_UNPACK_SEASON_RE.test(text)) score += 3;
    }
    if (score === 0) continue;
    if (!best || score > best.score) best = { id: g.id, score };
  }
  return best ? best.id : null;
}

function resolveGroupSeasonNumber(grp, idx, sorted, hasZero, hasSpecials) {
  if (typeof grp.order === "number") {
    if (hasSpecials && (grp.name || "").toLowerCase().includes("special") && grp.order === 0) return 0;
    if (hasZero) return hasSpecials ? grp.order : grp.order + 1;
    return grp.order;
  }
  return idx + 1;
}

function unpackEpisodeGroupDetails(groupDetails) {
  if (!groupDetails || !Array.isArray(groupDetails.groups) || groupDetails.groups.length === 0) return null;
  const groups = groupDetails.groups;
  const sorted = [...groups].sort((a, b) => (typeof a.order === "number" ? a.order : 0) - (typeof b.order === "number" ? b.order : 0));
  const hasZero = sorted.some((g) => g.order === 0);
  const hasSpecials = sorted.some((g) => (g.name || "").toLowerCase().includes("special"));

  const seasons = [];
  const episodesBySeason = {};

  for (let gIdx = 0; gIdx < sorted.length; gIdx++) {
    const grp = sorted[gIdx];
    const sNum = resolveGroupSeasonNumber(grp, gIdx, sorted, hasZero, hasSpecials);
    const rawEps = Array.isArray(grp.episodes) ? grp.episodes : [];
    const sortedEps = [...rawEps].sort((a, b) => (typeof a.order === "number" ? a.order : 0) - (typeof b.order === "number" ? b.order : 0));
    
    const epList = [];
    for (let epIdx = 0; epIdx < sortedEps.length; epIdx++) {
      const ep = sortedEps[epIdx];
      const epNum = typeof ep.order === "number" ? ep.order + 1 : epIdx + 1;
      epList.push({
        id: ep.id || (sNum * 1000 + epNum),
        episode_number: epNum,
        name: ep.name || `Episode ${epNum}`,
        overview: ep.overview || "",
        runtime: ep.runtime || null,
        air_date: ep.air_date || null,
        vote_average: typeof ep.vote_average === "number" ? ep.vote_average : null,
        still_path: ep.still_path ? (ep.still_path.startsWith("http") ? ep.still_path : ("https://image.tmdb.org/t/p/w500" + ep.still_path)) : null,
      });
    }

    episodesBySeason[sNum] = epList;
    if (sNum > 0) {
      seasons.push({
        season_number: sNum,
        season: sNum,
        name: grp.name || `Season ${sNum}`,
        episode_count: epList.length,
        episodeCount: epList.length,
      });
    }
  }

  if (seasons.length <= 1) return null;
  return { seasons, episodesBySeason, groupId: groupDetails.id };
}

async function fetchCinemetaSeriesUnpacked(imdbId) {
  const cleanId = String(imdbId || "").split(":")[0].trim();
  if (!cleanId.startsWith("tt")) return null;
  try {
    const res = await fetch(`https://v3-cinemeta.strem.io/meta/series/${encodeURIComponent(cleanId)}.json`, {
      headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
      cf: { cacheTtl: 604800, cacheEverything: true },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const videos = (data && data.meta && Array.isArray(data.meta.videos)) ? data.meta.videos : [];
    if (videos.length === 0) return null;

    const seasonMap = {};
    for (const v of videos) {
      if (typeof v.season !== "number" || typeof v.episode !== "number") continue;
      if (!seasonMap[v.season]) seasonMap[v.season] = [];
      seasonMap[v.season].push(v);
    }

    const regSeasons = Object.keys(seasonMap).map(Number).filter((s) => s > 0).sort((a, b) => a - b);
    if (regSeasons.length <= 1) return null;

    const seasons = [];
    const episodesBySeason = {};

    for (const sNum of regSeasons) {
      const vList = seasonMap[sNum].sort((a, b) => a.episode - b.episode);
      // Skip placeholder / dummy unreleased seasons (e.g. Cinemeta stub season with no air date and <= 1 episode)
      const hasAnyAired = vList.some((v) => v.released || v.firstAired);
      if (!hasAnyAired && sNum > 1 && vList.length <= 1) continue;

      const epList = vList.map((v) => ({
        id: v.tvdb_id || (sNum * 1000 + v.episode),
        episode_number: v.episode,
        name: v.title || v.name || `Episode ${v.episode}`,
        overview: v.overview || v.description || "",
        runtime: null,
        air_date: v.released ? v.released.slice(0, 10) : (v.firstAired ? v.firstAired.slice(0, 10) : null),
        vote_average: null,
        still_path: v.thumbnail || null,
      }));
      episodesBySeason[sNum] = epList;
      seasons.push({
        season_number: sNum,
        season: sNum,
        name: `Season ${sNum}`,
        episode_count: epList.length,
        episodeCount: epList.length,
      });
    }

    if (seasons.length <= 1) return null;

    return { seasons, episodesBySeason, source: "cinemeta" };
  } catch {
    return null;
  }
}

const UNPACKED_SHOW_CACHE = new Map();
const UNPACKED_SHOW_TTL_MS = 6 * 60 * 60 * 1000;
const UNPACKED_SHOW_MAX = 500;

function getUnpackedCache(key) {
  const e = UNPACKED_SHOW_CACHE.get(key);
  if (!e || Date.now() > e.expiry) {
    if (e) UNPACKED_SHOW_CACHE.delete(key);
    return null;
  }
  return e.data;
}

function setUnpackedCache(key, data) {
  if (UNPACKED_SHOW_CACHE.size >= UNPACKED_SHOW_MAX) {
    const oldest = UNPACKED_SHOW_CACHE.keys().next().value;
    if (oldest !== undefined) UNPACKED_SHOW_CACHE.delete(oldest);
  }
  UNPACKED_SHOW_CACHE.set(key, { data, expiry: Date.now() + UNPACKED_SHOW_TTL_MS });
}

async function resolveUnpackedShowData(tmdbId, imdbId, standardSeasons, apiKey, env = null, ctx = null, preloadedGroups = null, meter = null) {
  const spend = () => { if (meter && typeof meter.spent === "number") meter.spent++; };
  const cleanTmdbId = tmdbId ? String(tmdbId).replace(/^tmdb:/, "").trim() : "";
  const cleanImdbId = imdbId ? String(imdbId).split(":")[0].trim() : "";
  const cacheKey = cleanTmdbId || cleanImdbId;
  if (!cacheKey) return null;

  const mem = getUnpackedCache(cacheKey);
  if (mem) return mem;

  if (env && env.CONFIGS) {
    try {
      const kv = await env.CONFIGS.get(`unpacked_show:${cacheKey}`);
      if (kv) {
        const parsed = JSON.parse(kv);
        setUnpackedCache(cacheKey, parsed);
        return parsed;
      }
    } catch {}
  }

  let effectiveSeasons = standardSeasons;
  let groups = preloadedGroups;

  // If standardSeasons not passed and we have TMDB ID + key, load show info
  if (!effectiveSeasons && cleanTmdbId && apiKey) {
    try {
      spend();
      const sRes = await fetch(`https://api.themoviedb.org/3/tv/${cleanTmdbId}?api_key=${encodeURIComponent(apiKey)}&append_to_response=episode_groups`, {
        headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
        cf: { cacheTtl: 604800, cacheEverything: true },
      });
      if (sRes.ok) {
        const sData = await sRes.json();
        effectiveSeasons = sData.seasons;
        if (!groups && sData.episode_groups && Array.isArray(sData.episode_groups.results)) {
          groups = sData.episode_groups.results;
        }
      }
    } catch {}
  }

  const regSeasons = Array.isArray(effectiveSeasons) ? effectiveSeasons.filter((s) => s && s.season_number > 0) : [];
  const standardSeasonCount = regSeasons.length;
  const standardEpisodeCount = regSeasons.reduce((sum, s) => sum + (s.episode_count || 0), 0);
  const totalEpisodeCountWithSpecials = Array.isArray(effectiveSeasons)
    ? effectiveSeasons.reduce((sum, s) => sum + (s.episode_count || 0), 0)
    : standardEpisodeCount;

  // Only unpack if the show has exactly 1 regular season with multiple episodes
  if (standardSeasonCount !== 1 || standardEpisodeCount <= 1) {
    return null;
  }

  let unpacked = null;

  // 1. Try TMDB Episode Groups
  if (cleanTmdbId && apiKey) {
    try {
      if (!groups || (Array.isArray(groups) && groups.length === 0)) {
        spend();
        const egRes = await fetch(`https://api.themoviedb.org/3/tv/${cleanTmdbId}/episode_groups?api_key=${encodeURIComponent(apiKey)}`, {
          headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
          cf: { cacheTtl: 604800, cacheEverything: true },
        });
        if (egRes.ok) {
          const egData = await egRes.json();
          groups = egData.results;
        }
      }

      if (groups && Array.isArray(groups) && groups.length > 0) {
        const bestGroupId = pickDefaultEpisodeGroupId(groups, standardSeasonCount, standardEpisodeCount, totalEpisodeCountWithSpecials);
        if (bestGroupId) {
          spend();
          const gRes = await fetch(`https://api.themoviedb.org/3/episode_group/${bestGroupId}?api_key=${encodeURIComponent(apiKey)}`, {
            headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
            cf: { cacheTtl: 604800, cacheEverything: true },
          });
          if (gRes.ok) {
            const gData = await gRes.json();
            unpacked = unpackEpisodeGroupDetails(gData);
          }
        }
      }
    } catch {}
  }

  // 2. Cinemeta fallback
  if (!unpacked && cleanImdbId.startsWith("tt")) {
    spend();
    unpacked = await fetchCinemetaSeriesUnpacked(cleanImdbId);
  }

  if (unpacked) {
    setUnpackedCache(cacheKey, unpacked);
    if (cleanTmdbId && cleanImdbId) {
      setUnpackedCache(cleanImdbId, unpacked);
      setUnpackedCache(cleanTmdbId, unpacked);
    }
    if (env && env.CONFIGS) {
      const kvStr = JSON.stringify(unpacked);
      const p1 = env.CONFIGS.put(`unpacked_show:${cacheKey}`, kvStr, { expirationTtl: 2592000 }).catch(() => {});
      if (ctx && ctx.waitUntil) ctx.waitUntil(p1);
    }
    return unpacked;
  }

  return null;
}

// Wraps the real resolution logic (fetchTmdbItemDetailsUncached below) in
// the same shared, canonical-key cache Trakt already uses
// (fetchWithPerUserCacheAndCircuitBreaker) -- unlike the catalog/chart
// fetchers above, this function IS reachable with a personal TMDB key
// --- Episode air times (TVmaze) ---------------------------------------------
//
// TMDB dates an episode and stops: there is no air time anywhere in its TV
// payloads, which is why every "Airs Tuesday" in this add-on has been a day
// with no hour behind it. TVmaze carries both -- a show's regular slot
// (schedule.time, in its network country's IANA timezone) and each episode's
// own airtime -- and it needs no API key, so a self-hosted Worker gets this
// with nothing to configure and nothing to pay for.
//
// It is only ever asked about a show with an episode still to come (see the
// call in fetchTmdbItemDetailsUncached), which is the only case anything
// displays, and the answer is cached for twelve hours: a broadcast slot is a
// fact about a season, not about a day.
const TVMAZE_API_BASE = "https://api.tvmaze.com";

async function fetchShowAirTimeUncached(imdbId, meter) {
  const spend = () => { if (meter) meter.spent++; };
  // A shape rather than null, so a show TVmaze has never heard of caches as
  // "asked, nothing there" instead of being looked up again on every hit.
  const nothing = { time: null, timezone: null, label: "", days: [], next: null };
  const baseImdb = String(imdbId || "").split(":")[0].trim();
  if (!baseImdb.startsWith("tt")) return nothing;

  try {
    spend();
    const res = await fetch(TVMAZE_API_BASE + "/lookup/shows?imdb=" + encodeURIComponent(baseImdb), {
      headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
      cf: { cacheTtl: 43200, cacheEverything: true },
    });
    if (!res.ok) return nothing;
    const show = await res.json();
    if (!show || typeof show !== "object") return nothing;

    // A broadcast network carries the country its schedule is quoted in; a
    // streaming service usually does not, and usually has no time at all --
    // which is the honest answer for something that drops at midnight in
    // whatever zone you happen to be in.
    const timezone =
      (show.network && show.network.country && show.network.country.timezone) ||
      (show.webChannel && show.webChannel.country && show.webChannel.country.timezone) ||
      "";
    const time = (show.schedule && show.schedule.time) || "";
    const out = {
      time: time || null,
      timezone: timezone || null,
      label: formatAirTimeLabel(time, timezone),
      days: (show.schedule && Array.isArray(show.schedule.days)) ? show.schedule.days : [],
      next: null,
    };

    // The next episode is the one every "Airs Tomorrow" badge is about, and
    // the one most likely to sit outside the regular slot -- a feature-length
    // premiere, a finale moved an hour later. One more small fetch buys the
    // exact answer for it; every other upcoming episode keeps the show's
    // regular slot, which is what a listing would print for them anyway.
    const nextHref = show._links && show._links.nextepisode && show._links.nextepisode.href;
    if (nextHref && String(nextHref).startsWith(TVMAZE_API_BASE + "/")) {
      try {
        spend();
        const epRes = await fetch(String(nextHref), {
          headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
          cf: { cacheTtl: 43200, cacheEverything: true },
        });
        if (epRes.ok) {
          const ep = await epRes.json();
          if (ep && typeof ep.season === "number" && typeof ep.number === "number") {
            let epTime = ep.airtime || time;
            let epTz = timezone;
            if (!epTime && (show.webChannel || (!show.network && ep.airstamp))) {
              epTime = "03:00";
              if (!epTz) epTz = "America/New_York";
            }
            out.next = {
              season: ep.season,
              number: ep.number,
              airdate: ep.airdate || null,
              time: epTime || null,
              label: formatAirTimeLabel(epTime, epTz),
            };
          }
        }
      } catch {}
    }
    return out;
  } catch {
    return nothing;
  }
}

// Which of the two labels an upcoming episode gets: its own, when TVmaze
// dates that exact episode apart from the show's regular slot, and the regular
// slot otherwise. One rule, so the Worker's Stremio description and the page
// cannot print different times for the same episode.
function airTimeLabelForNextEpisode(airTime, nextEpInfo) {
  if (!airTime) return null;
  const next = airTime.next;
  if (next && next.label &&
      nextEpInfo && Number(nextEpInfo.nextEpisodeSeasonNumber) === Number(next.season) &&
      Number(nextEpInfo.nextEpisodeNumber) === Number(next.number)) {
    return next.label;
  }
  if (airTime.label) return airTime.label;
  if (next && next.label) return next.label;
  return null;
}

async function fetchShowAirTime(imdbId, env, ctx, meter) {
  const baseImdb = String(imdbId || "").split(":")[0].trim();
  if (!baseImdb.startsWith("tt")) return null;
  const cacheKey = `tvmaze:airtime:v3:${baseImdb}`;
  return await fetchWithPerUserCacheAndCircuitBreaker({
    cacheKey,
    freshTtlSec: 43200,
    staleTtlSec: 604800,
    providerLabel: "TVmaze Air Times",
    env: env,
    ctx: ctx,
    kvKey: cacheKey,
    kvTtlSec: 604800,
    fetchFn: () => fetchShowAirTimeUncached(baseImdb, meter),
  });
}

// (see /api/details in 25_api-catalog-routes.js, and handleSubtitlesTrack
// in 26_api-creator-and-admin-routes.js, both of which pass
// `tmdbKey || TMDB_API_KEY`). Every one of its internal fetch() calls
// bakes that key straight into the URL, so Cloudflare's own URL-keyed edge
// cache would otherwise give every personal-key user their own private,
// permanently-cold cache for titles that are already warm under the
// shared key -- the response itself (title, cast, rating, trailer...)
// doesn't depend on whose key asked for it, so there's no reason for it
// not to be shared. Keyed on the resolved identity (imdbId + fallbackType)
// rather than the internally-resolved tmdbId, since that's the only thing
// known before the resolution work runs.
// `meter` is optional and exists for /api/details/batch: an object with a
// numeric `spent` field, incremented once per outbound fetch this resolution
// actually makes. A cache hit -- memory, KV or edge -- never reaches fetchFn
// and so never touches it, which is what lets the batch route keep spending
// one invocation on a whole warm refresh while still fitting a free Worker's
// 50-fetch budget when the ids are cold. Every other caller passes nothing.
// The SHAPE of what this function returns, as a cache key segment. Bump it
// whenever a field is added to or removed from the details payload.
//
// Entries live for two hours fresh in isolate memory and a week in KV, keyed
// only by id/type/region, so a deploy that adds a field kept serving payloads
// written WITHOUT it -- correct-looking, just missing the new thing, for up to
// two hours after the code that fills it went live. That is exactly how air
// times shipped and then did not appear: the stored copy of a show someone had
// just opened had no airTime in it, and nothing about the key said the shape
// had moved on. Changing the key retires every old entry at once, at the cost
// of one cold lookup per title.
//
// v2: airTime / nextEpisodeAirTimeLabel (episode air times).
// v3: air dates with timezone offset and streaming webChannel default times.
const ITEM_DETAILS_SHAPE = "v3";

async function fetchTmdbItemDetails(imdbId, apiKey, fallbackType, region, bypassCache, env, ctx, meter) {
  if (!apiKey || !imdbId) return null;
  const effectiveRegion = (region || "US").toUpperCase().slice(0, 2) || "US";
  const cacheKey = `tmdb:itemdetails:${ITEM_DETAILS_SHAPE}:${String(imdbId).trim()}:${fallbackType || ""}:${effectiveRegion}`;

  const upgradeIfUnpacked = async (d) => {
    if (!d || !Array.isArray(d.seasonsData)) return d;
    const reg = d.seasonsData.filter((s) => s && s.season_number > 0);
    const epCount = reg.reduce((sum, s) => sum + (s.episode_count || 0), 0);
    if (reg.length === 1 && epCount > 1) {
      const unpacked = await resolveUnpackedShowData(d.tmdbId, d.id, d.seasonsData, apiKey, env, ctx, null, meter);
      if (unpacked && Array.isArray(unpacked.seasons) && unpacked.seasons.length > 1) {
        const upgraded = { ...d, seasonsData: unpacked.seasons, seasons: unpacked.seasons };
        setPerUserCache(cacheKey, upgraded);
        if (env && env.CONFIGS && apiKey) {
          const p = env.CONFIGS.put(cacheKey, JSON.stringify(upgraded), { expirationTtl: 604800 }).catch(() => {});
          if (ctx && ctx.waitUntil) ctx.waitUntil(p);
        }
        return upgraded;
      }
    }
    return d;
  };

  if (!bypassCache) {
    const cached = getPerUserCache(cacheKey);
    if (cached && cached.isFresh && cached.data) {
      if (cached.data.nextEpisodeAirDate && isEpisodeAiredServer(cached.data.nextEpisodeAirDate)) {
        // Scheduled episode has already aired; refresh to resolve the new upcoming episode
      } else {
        return await upgradeIfUnpacked(cached.data);
      }
    }
  }
  const details = await fetchWithPerUserCacheAndCircuitBreaker({
    cacheKey,
    freshTtlSec: (fallbackType === "series" || fallbackType === "tv") ? 7200 : 604800,
    staleTtlSec: 2592000,
    providerLabel: "TMDB Item Details",
    env: env,
    ctx: ctx,
    kvKey: apiKey ? cacheKey : "",
    kvTtlSec: 604800,
    fetchFn: () => fetchTmdbItemDetailsUncached(imdbId, apiKey, fallbackType, effectiveRegion, meter, env, ctx),
  });
  return await upgradeIfUnpacked(details);
}

async function fetchTmdbItemDetailsUncached(imdbId, apiKey, fallbackType, region, meter, env = null, ctx = null) {
  // One call per outbound fetch below. Counted here rather than by wrapping
  // fetch() globally, so nothing else in the Worker changes behaviour.
  const spend = () => { if (meter) meter.spent++; };
  if (!apiKey || !imdbId) return null;
  const effectiveRegion = (region || "US").toUpperCase().slice(0, 2) || "US";
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
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
    if (baseImdbId.startsWith("tt")) {
      const findSrc = "https://api.themoviedb.org/3/find/" + encodeURIComponent(baseImdbId) + "?api_key=" + encodeURIComponent(apiKey) + "&external_source=imdb_id";
      spend();
      const findRes = await fetch(findSrc, {
        headers: { "User-Agent": "my-list-addon/1.14" },
        cf: { cacheTtl: 604800, cacheEverything: true },
      });
      if (findRes.ok) {
        // TMDB answering 200 with a body that is not JSON (a proxy error
        // page, a truncated response) used to throw straight out of the
        // Worker, because nothing above this catches. Treated as "no match"
        // instead, which is what an unusable answer means here.
        let findData = null;
        try { findData = await findRes.json(); } catch { findData = null; }
        if (findData && findData.movie_results && findData.movie_results.length > 0) {
          tmdbId = findData.movie_results[0].id;
          type = "movie";
        } else if (findData && findData.tv_results && findData.tv_results.length > 0) {
          tmdbId = findData.tv_results[0].id;
          type = "tv";
        } else if (findData && findData.tv_episode_results && findData.tv_episode_results.length > 0) {
          tmdbId = findData.tv_episode_results[0].show_id;
          type = "tv";
        }
      }
    } else if (baseImdbId) {
      // Query fallback for title strings
      const searchType = (type === "tv" || type === "series" || fallbackType === "series" || fallbackType === "tv") ? "tv" : (type === "movie" || fallbackType === "movie" ? "movie" : "multi");
      const cleanTitle = String(baseImdbId)
        .replace(/[\s._-]+[sS]\d+[\s._-]*[eE]\d+.*$/i, "")
        .replace(/[\s._-]+\d+x\d+.*$/i, "")
        .replace(/[\s._-]+season[\s._-]*\d+.*$/i, "")
        .replace(/[\s._-]+episode[\s._-]*\d+.*$/i, "")
        .replace(/\s*\(\d{4}\).*$/, "")
        .trim();
      try {
        spend();
        const searchRes = await fetch("https://api.themoviedb.org/3/search/" + searchType + "?api_key=" + encodeURIComponent(apiKey) + "&query=" + encodeURIComponent(cleanTitle || baseImdbId) + "&page=1", {
          headers: { "User-Agent": "my-list-addon/1.14" },
          cf: { cacheTtl: 604800, cacheEverything: true },
        });
        if (searchRes.ok) {
          const sd = await searchRes.json();
          if (sd.results && sd.results.length > 0) {
            const first = sd.results[0];
            tmdbId = first.id;
            if (!type) {
              type = first.media_type === "tv" ? "tv" : (first.media_type === "movie" ? "movie" : (fallbackType === "series" || fallbackType === "tv" ? "tv" : "movie"));
            }
          }
        }
      } catch {}
    }
  }
  if (!tmdbId) return null;

  let match = null;
  let resolvedType = type;
  if (resolvedType) {
    const detailSrc = "https://api.themoviedb.org/3/" + resolvedType + "/" + tmdbId + "?api_key=" + encodeURIComponent(apiKey) + "&append_to_response=videos,release_dates,content_ratings,external_ids,credits" + (resolvedType === "tv" ? ",episode_groups" : "");
    spend();
    const detailRes = await fetch(detailSrc, {
      headers: { "User-Agent": "my-list-addon/1.14" },
      cf: { cacheTtl: resolvedType === "tv" ? 3600 : 604800, cacheEverything: true },
    });
    if (detailRes.ok) {
      match = await detailRes.json();
    }
  }
  if (!match) {
    // Try movie first
    const mSrc = "https://api.themoviedb.org/3/movie/" + tmdbId + "?api_key=" + encodeURIComponent(apiKey) + "&append_to_response=videos,release_dates,content_ratings,external_ids,credits";
    spend();
    const mRes = await fetch(mSrc, {
      headers: { "User-Agent": "my-list-addon/1.14" },
      cf: { cacheTtl: 604800, cacheEverything: true },
    });
    if (mRes.ok) {
      match = await mRes.json();
      resolvedType = "movie";
    } else {
      // Try tv
      const tvSrc = "https://api.themoviedb.org/3/tv/" + tmdbId + "?api_key=" + encodeURIComponent(apiKey) + "&append_to_response=videos,release_dates,content_ratings,external_ids,credits,episode_groups";
      spend();
      const tvRes = await fetch(tvSrc, {
        headers: { "User-Agent": "my-list-addon/1.14" },
        cf: { cacheTtl: 3600, cacheEverything: true },
      });
      if (tvRes.ok) {
        match = await tvRes.json();
        resolvedType = "tv";
      }
    }
  }
  if (!match || !resolvedType) return null;
  type = resolvedType;
  
  // Extract content rating -- prefer the requested region's own
  // certification, falling back to US if that region has no entry for
  // this title (common outside a handful of major markets; US almost
  // always has one, and an approximate rating beats showing none at all).
  let contentRating = null;
  if (type === "movie" && match.release_dates && match.release_dates.results) {
    const regional = match.release_dates.results.find(r => r.iso_3166_1 === effectiveRegion) ||
                      match.release_dates.results.find(r => r.iso_3166_1 === "US");
    if (regional && regional.release_dates.length > 0) {
      contentRating = regional.release_dates.find(r => r.certification)?.certification;
    }
  } else if (type === "tv" && match.content_ratings && match.content_ratings.results) {
    const regional = match.content_ratings.results.find(r => r.iso_3166_1 === effectiveRegion) ||
                      match.content_ratings.results.find(r => r.iso_3166_1 === "US");
    if (regional) contentRating = regional.rating;
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

  // Resolves the REAL IMDb id
  const realImdbId = (match.external_ids && match.external_ids.imdb_id) || (String(imdbId).startsWith("tt") ? String(imdbId).split(":")[0] : ("tmdb:" + tmdbId));

  let poster = match.poster_path ? ("https://image.tmdb.org/t/p/w500" + match.poster_path) : (match.backdrop_path ? ("https://image.tmdb.org/t/p/w780" + match.backdrop_path) : "");
  let background = match.backdrop_path ? ("https://image.tmdb.org/t/p/w1280" + match.backdrop_path) : "";
  let overview = match.overview || "";
  let genres = (match.genres || []).map(g => g.name).join(', ');

  if ((!poster || !overview || !genres) && realImdbId.startsWith("tt")) {
    try {
      const cinemetaKind = type === "tv" ? "series" : "movie";
      spend();
      const cmRes = await fetch("https://v3-cinemeta.strem.io/meta/" + cinemetaKind + "/" + encodeURIComponent(realImdbId) + ".json", {
        headers: { "User-Agent": "my-list-addon/1.14" },
        cf: { cacheTtl: 604800, cacheEverything: true },
      });
      if (cmRes.ok) {
        const cmData = await cmRes.json();
        if (cmData && cmData.meta) {
          const m = cmData.meta;
          if (!poster && m.poster) poster = m.poster;
          if (!background && m.background) background = m.background;
          if (!overview && m.description) overview = m.description;
          if (!genres && Array.isArray(m.genres)) genres = m.genres.join(', ');
          if (!cast && Array.isArray(m.cast)) cast = m.cast;
          if (!director && (m.director || Array.isArray(m.director))) director = Array.isArray(m.director) ? m.director : [m.director];
        }
      }
    } catch {}
    if (!poster && realImdbId.startsWith("tt")) {
      poster = "https://images.metahub.space/poster/medium/" + realImdbId + "/img";
    }
  }

  if (type === "tv" && Array.isArray(match.seasons)) {
    const regSeasons = match.seasons.filter((s) => s && s.season_number > 0);
    const standardEpisodeCount = regSeasons.reduce((sum, s) => sum + (s.episode_count || 0), 0);
    if (regSeasons.length === 1 && standardEpisodeCount > 1) {
      const groups = match.episode_groups && Array.isArray(match.episode_groups.results) ? match.episode_groups.results : [];
      const unpacked = await resolveUnpackedShowData(tmdbId, realImdbId, match.seasons, apiKey, env, ctx, groups, meter);
      if (unpacked && Array.isArray(unpacked.seasons) && unpacked.seasons.length > 1) {
        match.seasons = unpacked.seasons;
      }
    }
  }

  const nextEpInfo = await (async () => {
    if (type !== "tv") return { nextEpisodeAirDate: null, nextEpisodeNumber: null, nextEpisodeSeasonNumber: null, nextEpisodeName: null };
    if (match.next_episode_to_air) {
      const nextAir = match.next_episode_to_air.air_date || null;
      if (nextAir && nextAir >= yesterday) {
        return {
          nextEpisodeAirDate: nextAir,
          nextEpisodeNumber: typeof match.next_episode_to_air.episode_number === "number" ? match.next_episode_to_air.episode_number : null,
          nextEpisodeSeasonNumber: typeof match.next_episode_to_air.season_number === "number" ? match.next_episode_to_air.season_number : null,
          nextEpisodeName: match.next_episode_to_air.name || null,
        };
      }
    }

    // If next_episode_to_air is missing or points to an already-aired episode,
    // inspect the season's episode list to find the actual next future episode
    const seasonToSearch = (match.next_episode_to_air && match.next_episode_to_air.season_number) || (match.last_episode_to_air && match.last_episode_to_air.season_number);
    if (seasonToSearch && tmdbId) {
      try {
        spend();
        const sRes = await fetch("https://api.themoviedb.org/3/tv/" + tmdbId + "/season/" + seasonToSearch + "?api_key=" + encodeURIComponent(apiKey), {
          headers: { "User-Agent": "my-list-addon/1.14" },
          cf: { cacheTtl: 3600, cacheEverything: true },
        });
        if (sRes.ok) {
          const sData = await sRes.json();
          if (Array.isArray(sData.episodes)) {
            const futureEp = sData.episodes.find((ep) => ep && ep.air_date && ep.air_date >= yesterday);
            if (futureEp) {
              return {
                nextEpisodeAirDate: futureEp.air_date,
                nextEpisodeNumber: typeof futureEp.episode_number === "number" ? futureEp.episode_number : null,
                nextEpisodeSeasonNumber: typeof futureEp.season_number === "number" ? futureEp.season_number : seasonToSearch,
                nextEpisodeName: futureEp.name || null,
              };
            }
          }
        }
      } catch {}
    }

    // Fallback: check upcoming future seasons in match.seasons
    const upcomingSeasons = Array.isArray(match.seasons)
      ? match.seasons.filter((s) => s && s.season_number > 0 && s.air_date && s.air_date >= yesterday)
      : [];
    upcomingSeasons.sort((a, b) => a.air_date.localeCompare(b.air_date));
    const nextSeason = upcomingSeasons[0];
    if (nextSeason) {
      return {
        nextEpisodeAirDate: nextSeason.air_date,
        nextEpisodeNumber: 1,
        nextEpisodeSeasonNumber: nextSeason.season_number,
        nextEpisodeName: nextSeason.name || null,
      };
    }
    return { nextEpisodeAirDate: null, nextEpisodeNumber: null, nextEpisodeSeasonNumber: null, nextEpisodeName: null };
  })();

  let isSeasonPremiere = false;
  let isSeasonFinale = false;
  let seasonFinaleAirDate = null;
  let seasonFinaleEpisodeNumber = null;
  let totalEpisodesInSeason = null;

  const isUnairedFuture = !!(nextEpInfo && nextEpInfo.nextEpisodeAirDate && nextEpInfo.nextEpisodeAirDate >= yesterday);

  // The hour behind the date, for a show that still has one to come. Gated on
  // next_episode_to_air as well as isUnairedFuture because that flag is
  // strictly future -- an episode airing TODAY does not set it, and today is
  // exactly when someone wants to know what time it is on. A finished show is
  // never looked up: its air time is a fact about the past, and nothing
  // displays a time against an episode that has already gone out.
  const airTime = (type === "tv" && (match.next_episode_to_air || isUnairedFuture))
    ? await fetchShowAirTime(realImdbId, env, ctx, meter)
    : null;

  if (type === "tv" && isUnairedFuture && nextEpInfo.nextEpisodeSeasonNumber) {
    const targetSeason = Array.isArray(match.seasons)
      ? match.seasons.find((s) => s && s.season_number === nextEpInfo.nextEpisodeSeasonNumber)
      : null;
    if (targetSeason && typeof targetSeason.episode_count === "number") {
      totalEpisodesInSeason = targetSeason.episode_count;
      seasonFinaleEpisodeNumber = targetSeason.episode_count;
    }

    if (nextEpInfo.nextEpisodeNumber === 1) {
      isSeasonPremiere = true;
    } else if (totalEpisodesInSeason && nextEpInfo.nextEpisodeNumber === totalEpisodesInSeason && nextEpInfo.nextEpisodeNumber > 1) {
      isSeasonFinale = true;
    }

    // If mid-season (episodes 2..N-1), resolve the finale episode's air date
    if (!isSeasonPremiere && !isSeasonFinale && tmdbId && nextEpInfo.nextEpisodeSeasonNumber) {
      try {
        spend();
        const sRes = await fetch("https://api.themoviedb.org/3/tv/" + tmdbId + "/season/" + nextEpInfo.nextEpisodeSeasonNumber + "?api_key=" + encodeURIComponent(apiKey), {
          headers: { "User-Agent": "my-list-addon/1.14" },
          cf: { cacheTtl: 3600, cacheEverything: true },
        });
        if (sRes.ok) {
          const sData = await sRes.json();
          if (Array.isArray(sData.episodes) && sData.episodes.length > 0) {
            const lastEp = sData.episodes[sData.episodes.length - 1];
            if (lastEp) {
              if (lastEp.air_date) seasonFinaleAirDate = lastEp.air_date;
              if (typeof lastEp.episode_number === "number") seasonFinaleEpisodeNumber = lastEp.episode_number;
            }
          }
        }
      } catch {}
    }
  }

  return {
    id: realImdbId,
    title: match.title || match.name,
    overview: overview,
    poster: poster,
    background: background,
    rating: match.vote_average ? match.vote_average.toFixed(1) : null,
    releaseYear: (match.release_date || match.first_air_date || "").slice(0, 4),
    releaseDate: match.release_date || match.first_air_date || null,
    seasonsData: type === "tv" && match.seasons ? match.seasons : null,
    tmdbId: tmdbId,
    runtime: match.runtime || (match.episode_run_time && match.episode_run_time[0]) || null,
    budget: match.budget || null,
    revenue: match.revenue || null,
    contentRating: contentRating || null,
    genres: genres,
    trailerKey: trailerKey,
    cast: cast,
    director: director,
    ...nextEpInfo,
    // The show's regular slot, for every upcoming episode, and the exact slot
    // of the next one where TVmaze dates it separately. Both are finished
    // strings ("9 PM ET"): the page never has to carry a timezone database to
    // print one.
    airTime: airTime || null,
    nextEpisodeAirTimeLabel: airTimeLabelForNextEpisode(airTime, nextEpInfo),
    isSeasonPremiere: isSeasonPremiere,
    isSeasonFinale: isSeasonFinale,
    seasonFinaleAirDate: seasonFinaleAirDate,
    seasonFinaleEpisodeNumber: seasonFinaleEpisodeNumber,
    totalEpisodesInSeason: totalEpisodesInSeason,
    lastEpisodeNumber: (type === "tv" && match.last_episode_to_air) ? (typeof match.last_episode_to_air.episode_number === "number" ? match.last_episode_to_air.episode_number : null) : null,
  };
}

// Same shared-cache wrapper as fetchTmdbItemDetails above, and for the same
// reason -- this is the season/episode-list lookup behind Mark Whole Show
// Watched and the episode grid, reachable with a personal key via the same
// call sites. Keyed on whichever identity the caller actually has
// (knownTmdbId when supplied, else the raw imdbId) plus the season number,
// since a season's episode list is public, static-ish data no different
// per requester.
async function fetchTmdbSeasonDetails(imdbId, seasonNum, apiKey, knownTmdbId, env, ctx) {
  if (!apiKey) return null;
  const cacheKey = `tmdb:season:${knownTmdbId || imdbId}:${seasonNum}`;
  return fetchWithPerUserCacheAndCircuitBreaker({
    cacheKey,
    freshTtlSec: 604800,
    staleTtlSec: 2592000,
    providerLabel: "TMDB Season Details",
    env: env,
    ctx: ctx,
    kvKey: apiKey ? cacheKey : "",
    kvTtlSec: 604800,
    fetchFn: () => fetchTmdbSeasonDetailsUncached(imdbId, seasonNum, apiKey, knownTmdbId, env, ctx),
  });
}

async function fetchTmdbSeasonDetailsUncached(imdbId, seasonNum, apiKey, knownTmdbId, env = null, ctx = null) {
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
    const raw = String(imdbId || '').trim();
    if (raw.startsWith('tmdb:')) {
      tmdbId = raw.split(':')[1];
    } else if (/^\d+$/.test(raw)) {
      tmdbId = raw;
    } else if (raw.startsWith('tt')) {
      const baseImdbId = raw.split(':')[0];
      const findSrc = "https://api.themoviedb.org/3/find/" + encodeURIComponent(baseImdbId) + "?api_key=" + encodeURIComponent(apiKey) + "&external_source=imdb_id";
      const findRes = await fetch(findSrc, {
        headers: { "User-Agent": "my-list-addon/1.14" },
        cf: { cacheTtl: 604800, cacheEverything: true },
      });
      if (findRes.ok) {
        // Same guard as the movie path above.
        let findData = null;
        try { findData = await findRes.json(); } catch { findData = null; }
        if (findData && findData.tv_results && findData.tv_results.length > 0) {
          tmdbId = findData.tv_results[0].id;
        } else if (findData && findData.tv_episode_results && findData.tv_episode_results.length > 0) {
          tmdbId = findData.tv_episode_results[0].show_id;
        }
      }
    } else if (raw) {
      // Query fallback for title strings, e.g. "Ted Lasso"
      const cleanTitle = raw.replace(/\s+S\d+E\d+.*$/i, '').trim();
      try {
        const searchRes = await fetch("https://api.themoviedb.org/3/search/tv?api_key=" + encodeURIComponent(apiKey) + "&query=" + encodeURIComponent(cleanTitle || raw) + "&page=1", {
          headers: { "User-Agent": "my-list-addon/1.14" },
          cf: { cacheTtl: 604800, cacheEverything: true },
        });
        if (searchRes.ok) {
          const sd = await searchRes.json();
          if (sd.results && sd.results.length > 0) {
            tmdbId = sd.results[0].id;
          }
        }
      } catch {}
    }
  }
  if (!tmdbId && !String(imdbId || "").startsWith("tt")) return null;

  const numericSeason = parseInt(seasonNum, 10);
  const unpacked = await resolveUnpackedShowData(tmdbId, imdbId, null, apiKey, env, ctx);
  if (unpacked && unpacked.episodesBySeason && unpacked.episodesBySeason[numericSeason]) {
    return { episodes: unpacked.episodesBySeason[numericSeason] };
  }

  if (!tmdbId) return null;

  const src = "https://api.themoviedb.org/3/tv/" + tmdbId + "/season/" + seasonNum + "?api_key=" + encodeURIComponent(apiKey);
  const res = await fetch(src, {
    headers: { "User-Agent": "my-list-addon/1.14" },
    cf: { cacheTtl: 604800, cacheEverything: true },
  });
  if (!res.ok) {
    if (String(imdbId).startsWith("tt")) {
      const cinUnpacked = await fetchCinemetaSeriesUnpacked(imdbId);
      if (cinUnpacked && cinUnpacked.episodesBySeason && cinUnpacked.episodesBySeason[numericSeason]) {
        return { episodes: cinUnpacked.episodesBySeason[numericSeason] };
      }
    }
    return null;
  }
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
async function fetchStandardItemMeta(imdbId, type, apiKey, env = null, ctx = null) {
  if (!apiKey || !imdbId) return null;
  const wantType = type === "series" ? "series" : "movie";
  const details = await fetchTmdbItemDetails(imdbId, apiKey, wantType, "", false, env, ctx);
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
        fetchTmdbSeasonDetails(details.id, s.season_number, apiKey, details.tmdbId, env, ctx).catch(() => null)
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

// --- catalog search for Stremio / Nuvio ---------------------------------
//
// When My Lists is the sole metadata source (or when Cinemeta is uninstalled),
// Stremio and Nuvio rely on catalog search resources declared in the manifest.
// This executes TMDB search queries with pagination, resolves IMDb IDs with KV caching,
// and falls back to Cinemeta fuzzy search when needed.
async function searchCatalogMetas(query, type, skip, apiKey, env, ctx, origin) {
  if (!query || typeof query !== "string") return [];
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return [];

  const wantType = type === "series" ? "series" : "movie";
  const kind = wantType === "series" ? "tv" : "movie";
  const effectiveKey = apiKey || TMDB_API_KEY;
  const page = Math.floor((skip || 0) / 20) + 1;

  if (ctx && typeof bumpStat === "function" && env) {
    ctx.waitUntil(bumpStat(env, "apiuse:tmdb"));
  }

  let rawItems = [];
  try {
    const tmdbUrl = `https://api.themoviedb.org/3/search/${kind}?api_key=${encodeURIComponent(effectiveKey)}&query=${encodeURIComponent(trimmedQuery)}&page=${page}&include_adult=false`;
    const res = await fetch(tmdbUrl, {
      headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.results)) {
        rawItems = data.results;
      }
    }
  } catch {}

  // Fallback to Cinemeta fuzzy search if TMDB returned no results on page 1
  if (rawItems.length === 0 && page === 1) {
    try {
      const cinemetaType = wantType === "series" ? "series" : "movie";
      const cUrl = `https://v3-cinemeta.strem.io/catalog/${cinemetaType}/top/search=${encodeURIComponent(trimmedQuery)}.json`;
      const cRes = await fetch(cUrl, {
        headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
        cf: { cacheTtl: 86400, cacheEverything: true },
      });
      if (cRes.ok) {
        const cData = await cRes.json();
        if (Array.isArray(cData.metas) && cData.metas.length > 0) {
          return cData.metas.slice(0, 20).map((m) => ({
            id: m.id,
            type: wantType,
            name: m.name || "Untitled",
            poster: m.poster || (origin ? `${origin}/unavailable-poster.svg` : undefined),
            background: m.background || undefined,
            description: m.description || undefined,
            releaseInfo: m.releaseInfo || m.year || undefined,
            imdbRating: m.imdbRating || undefined,
            behaviorHints: wantType === "movie" ? { defaultVideoId: m.id } : undefined,
          }));
        }
      }
    } catch {}
  }

  if (rawItems.length === 0) return [];

  // Resolve IMDb IDs for TMDB results (up to 20 items)
  const candidates = rawItems.slice(0, 20);
  const resolved = await mapWithConcurrency(candidates, 8, async (item) => {
    let imdbId = null;
    try {
      const details = await fetchTmdbDetails(item.id, kind, effectiveKey, env);
      if (details && details.imdbId) imdbId = details.imdbId;
    } catch {}

    const finalId = imdbId || `tmdb:${item.id}`;
    const releaseDate = kind === "tv" ? item.first_air_date : item.release_date;
    const year = (releaseDate || "").slice(0, 4);

    return {
      id: finalId,
      type: wantType,
      name: item.title || item.name || "Untitled",
      poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : (origin ? `${origin}/unavailable-poster.svg` : undefined),
      background: item.backdrop_path ? `https://image.tmdb.org/t/p/w1280${item.backdrop_path}` : undefined,
      description: item.overview || undefined,
      releaseInfo: year || undefined,
      imdbRating: typeof item.vote_average === "number" && item.vote_average > 0 ? String(Math.round(item.vote_average * 10) / 10) : undefined,
      behaviorHints: wantType === "movie" ? { defaultVideoId: finalId } : undefined,
    };
  });

  return resolved.filter(Boolean);
}

// Server-side "is this episode aired yet" check -- same rule the client's
// isEpisodeAired uses (19_client-search-and-likes.js), reimplemented here
// because nothing in the client-side files (09 onward) is real, callable
// code from the Worker's own perspective; they're embedded template-literal
// text that only becomes real JS once served to and run by a browser. Used
// by findNextAiredEpisodeForShow below, for the Continue Watching cron
// (checkForNewEpisodes, right below).
function isEpisodeAiredServer(ep) {
  if (!ep) return false;
  const dateStr = (typeof ep === 'string') ? ep : (ep.air_date || ep.airDate || '');
  if (!dateStr) return false;
  const parts = String(dateStr).split(/[-T\s]/);
  if (parts.length < 3) return false;
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1;
  const day = parseInt(parts[2], 10);
  if (isNaN(year) || isNaN(month) || isNaN(day)) return false;
  const airDate = new Date(year, month, day);
  if (isNaN(airDate.getTime())) return false;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return airDate.getTime() <= today.getTime();
}

// Given a show and the latest episode known to be watched, looks for the
// next unwatched, already-aired episode -- same season-then-next-season
// logic as the client's updateContinueWatching
// (21_client-custom-list-builder.js), reimplemented server-side for the
// same reason as isEpisodeAiredServer above. Returns { episode, seasonNum }
// or null if nothing new has aired since latestSeasonNum/latestEpisodeNum.
async function findNextAiredEpisodeForShow(imdbId, latestSeasonNum, latestEpisodeNum, apiKey, env, ctx) {
  const sNum = Number(latestSeasonNum);
  const eNum = Number(latestEpisodeNum);
  const data = await fetchTmdbSeasonDetails(imdbId, sNum, apiKey, null, env, ctx);
  if (data && data.episodes) {
    const nextInSeason = data.episodes.find((ep) => ep.episode_number > eNum);
    if (nextInSeason) return { episode: nextInSeason, seasonNum: sNum, isUnaired: !isEpisodeAiredServer(nextInSeason) };
  }
  const nextSeasonNum = sNum + 1;
  const data2 = await fetchTmdbSeasonDetails(imdbId, nextSeasonNum, apiKey, null, env, ctx);
  if (data2 && data2.episodes && data2.episodes.length) {
    const sorted = [...data2.episodes].sort((a, b) => a.episode_number - b.episode_number);
    if (sorted.length) return { episode: sorted[0], seasonNum: nextSeasonNum, isUnaired: !isEpisodeAiredServer(sorted[0]) };
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
// --- Airing Next, rebuilt without the website ----------------------------------
//
// Airing Next is built by the website (refreshAiringNext, 21_client-custom-
// list-builder.js) and pushed up as a snapshot, and nothing else ever rebuilt
// it -- so someone who used only Stremio or Nuvio for a while saw episodes
// that had aired days ago, never saw newly announced ones, and never saw
// shows they had started watching since. The functions below are the
// website's rules run over the account's tracking record instead of this
// browser's localStorage, so the two build the same shelf.

// The furthest-along watched episode of one show -- latestWatchedEpisodeFor-
// ShowIds on the website.
function latestWatchedEpisodeInHistory(watchHistory, showId) {
  let best = null;
  for (const it of watchHistory) {
    if (!it || it.type !== 'episode' || String(it.showId || '') !== showId) continue;
    if (it.seasonNum == null || it.episodeNum == null) continue;
    const s = Number(it.seasonNum);
    const e = Number(it.episodeNum);
    if (!best || s > best.seasonNum || (s === best.seasonNum && e > best.episodeNum)) best = { seasonNum: s, episodeNum: e };
  }
  return best;
}

// Whether a removal from Airing Next still stands -- isAiringNextRemoved: it
// lasts until an episode newer than the one it was made at is watched.
function airingNextRemovalStands(record, showId) {
  const marks = record.removedAiringNext && typeof record.removedAiringNext === 'object' ? record.removedAiringNext : {};
  const mark = marks[showId];
  if (!mark) return false;
  const latest = latestWatchedEpisodeInHistory(Array.isArray(record.watchHistory) ? record.watchHistory : [], showId);
  if (!latest) return true;
  const atSeason = Number(mark.seasonNum) || 0;
  const atEpisode = Number(mark.episodeNum) || 0;
  if (latest.seasonNum > atSeason) return false;
  if (latest.seasonNum === atSeason && latest.episodeNum > atEpisode) return false;
  return true;
}

// The shows to look up -- collectAiringNextCandidateShowIds: every show with
// a watched episode, plus any known to be fully watched, less the removed ones
// that are not in Continue Watching.
function airingNextCandidatesFromRecord(record) {
  const ids = new Set();
  for (const it of (Array.isArray(record.watchHistory) ? record.watchHistory : [])) {
    if (it && it.type === 'episode' && it.showId) ids.add(String(it.showId));
  }
  for (const id of (Array.isArray(record.fullyWatchedShowIds) ? record.fullyWatchedShowIds : [])) ids.add(String(id));
  const cw = new Set();
  for (const it of (Array.isArray(record.continueWatching) ? record.continueWatching : [])) {
    if (it && it.showId) cw.add(String(it.showId));
    if (it && it.id) cw.add(String(it.id));
  }
  for (const id of [...ids]) {
    if (airingNextRemovalStands(record, id) && !cw.has(id)) ids.delete(id);
  }
  return [...ids].slice(0, AIRING_NEXT_SERVER_MAX_SHOWS);
}

// One details payload -> one Airing Next entry, or null when nothing is
// coming. airingEntryFrom on the website, field for field.
function airingNextEntryFromDetails(showId, d, known) {
  if (!d || !d.nextEpisodeAirDate) return null;
  if (isEpisodeAired(d.nextEpisodeAirDate)) return null;
  const epName = d.nextEpisodeName || (d.nextEpisodeNumber === 1 ? 'Season Premiere' : (d.nextEpisodeNumber != null ? ('Episode ' + d.nextEpisodeNumber) : ''));
  const isFinale = !!(d.isSeasonFinale || (d.totalEpisodesInSeason != null && d.nextEpisodeNumber === d.totalEpisodesInSeason && d.nextEpisodeNumber > 1));
  return {
    id: showId,
    type: 'series',
    showId: showId,
    canonicalTmdbId: d.tmdbId ? String(d.tmdbId) : null,
    showTitle: (known && known.title) || d.title || '',
    showPoster: (known && known.poster) || d.poster || '',
    name: epName,
    episodeTitle: epName,
    airDate: d.nextEpisodeAirDate,
    seasonNum: d.nextEpisodeSeasonNumber,
    episodeNum: d.nextEpisodeNumber,
    isSeasonPremiere: d.nextEpisodeNumber === 1,
    isSeasonFinale: isFinale,
    seasonFinaleAirDate: d.seasonFinaleAirDate || null,
    seasonFinaleEpisodeNumber: d.seasonFinaleEpisodeNumber || null,
    airTime: d.nextEpisodeAirTimeLabel || (d.airTime && d.airTime.label) || null,
    isUnaired: true,
  };
}

// Rebuilds one account's Airing Next from its tracking record. `pool` is the
// tick's shared outbound-fetch budget ({ budget, reserved }), reserved per
// lookup at TMDB_ITEM_DETAILS_MAX_FETCHES and refunded down to what the
// lookup really spent -- the /api/details/batch route's accounting, since a
// cached lookup spends nothing.
//
// Returns { items, complete }. A show the budget did not reach keeps the entry
// it already had (if that has not aired), so running out part-way leaves the
// shelf as it was for those shows rather than dropping them.
async function rebuildAiringNextForRecord(env, ctx, record, pool) {
  const candidates = airingNextCandidatesFromRecord(record);
  const known = new Map();
  for (const it of (Array.isArray(record.watchHistory) ? record.watchHistory : [])) {
    if (it && it.showId && it.showTitle && !known.has(String(it.showId))) {
      known.set(String(it.showId), { title: it.showTitle, poster: it.showPoster });
    }
  }
  const resolved = new Map();
  let cursor = 0;
  let complete = true;
  async function worker() {
    while (cursor < candidates.length) {
      if (pool.reserved + TMDB_ITEM_DETAILS_MAX_FETCHES > pool.budget) {
        complete = false;
        return;
      }
      const showId = candidates[cursor++];
      pool.reserved += TMDB_ITEM_DETAILS_MAX_FETCHES;
      const meter = { spent: 0 };
      try {
        const d = await fetchTmdbItemDetails(showId, TMDB_API_KEY, 'series', '', false, env, ctx, meter);
        // No details at all is a lookup that failed (TMDB down, nothing
        // cached), not a show with nothing coming -- left unresolved so it
        // keeps its entry. Only real details decide a show is off the shelf,
        // or an outage would empty everyone's Airing Next and save it.
        if (d) resolved.set(showId, airingNextEntryFromDetails(showId, d, known.get(showId)));
      } catch {
        // Unresolved rather than "nothing coming": keeps its current entry.
      }
      pool.reserved -= TMDB_ITEM_DETAILS_MAX_FETCHES - Math.min(meter.spent, TMDB_ITEM_DETAILS_MAX_FETCHES);
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, worker));
  if (cursor < candidates.length) complete = false;

  const existing = new Map();
  for (const it of (Array.isArray(record.airingNext) ? record.airingNext : [])) {
    if (it && it.showId && !(it.airDate && isEpisodeAired(it.airDate))) existing.set(String(it.showId), it);
  }
  const results = [];
  for (const showId of candidates) {
    if (resolved.has(showId)) {
      const entry = resolved.get(showId);
      if (entry) results.push(entry);
    } else if (existing.has(showId)) {
      results.push(existing.get(showId));
    }
  }

  // The website's dedupe and order: one entry per show whichever id Watch
  // History recorded it under, soonest first, removed shows left off.
  const seen = new Set();
  const items = results.filter((it) => {
    const normalized = String(it.showId).startsWith('tmdb:') ? String(it.showId).slice(5) : String(it.showId);
    const key = it.canonicalTmdbId ? 'tmdb:' + it.canonicalTmdbId : 'id:' + normalized;
    if (seen.has(key) || seen.has('id:' + normalized)) return false;
    seen.add(key);
    seen.add('id:' + normalized);
    return true;
  }).filter((it) => !airingNextRemovalStands(record, String(it.showId)));
  items.sort((a, b) => String(a.airDate || '').localeCompare(String(b.airDate || '')));
  return { items, complete };
}

// The cron's half of Airing Next: a few accounts per tick, each at most every
// AIRING_NEXT_SERVER_REFRESH_MS. Walks accounts with the same page-cursor-
// plus-offset position checkForNewEpisodes keeps (below), for the same
// reasons, under its own key.
async function refreshAiringNextSweep(env, ctx, fetchBudget) {
  if (!env || !env.CONFIGS || !TMDB_API_KEY) return;
  if (!(Number.isFinite(fetchBudget) && fetchBudget >= TMDB_ITEM_DETAILS_MAX_FETCHES)) return;
  const CURSOR_KEY = 'cron:airingnext:cursor';
  let sweep = { c: '', o: 0 };
  try {
    const raw = await env.CONFIGS.get(CURSOR_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.c === 'string') sweep = { c: parsed.c, o: Number(parsed.o) || 0 };
    }
  } catch {}

  const listOpts = { prefix: 'creator:', limit: 25 };
  if (sweep.c) listOpts.cursor = sweep.c;
  let listResult;
  try {
    listResult = await env.CONFIGS.list(listOpts);
  } catch (e) {
    console.error('[Cron] Airing Next: account listing failed, restarting from the beginning:', e);
    if (sweep.c) {
      try { await env.CONFIGS.put(CURSOR_KEY, ''); } catch {}
    }
    return;
  }

  const pool = { budget: fetchBudget, reserved: 0 };
  const pageKeys = listResult.keys || [];
  let nextOffset = Math.min(Math.max(sweep.o, 0), pageKeys.length);
  let rebuilt = 0;
  for (let i = nextOffset; i < pageKeys.length; i++) {
    if (rebuilt >= AIRING_NEXT_SWEEP_ACCOUNTS_PER_TICK || pool.reserved + TMDB_ITEM_DETAILS_MAX_FETCHES > pool.budget) break;
    nextOffset = i + 1;
    const username = pageKeys[i].name.slice('creator:'.length);
    // One account must not be able to stop the sweep -- see checkForNewEpisodes.
    try {
      const checkedKey = airingNextCheckedKey(username);
      if (await env.CONFIGS.get(checkedKey)) continue;
      const trackingKey = `creatorsynctracking:${username}`;
      const raw = await env.CONFIGS.get(trackingKey);
      if (!raw) continue;
      const record = JSON.parse(raw);
      if (!airingNextCandidatesFromRecord(record).length) continue;
      rebuilt++;
      const { items, complete } = await rebuildAiringNextForRecord(env, ctx, record, pool);

      // Written against a fresh read, owning only the one field it computed:
      // the lookups above took real time, and anything the account's browser
      // or a playback scrobble saved meanwhile must survive. The same rule
      // checkForNewEpisodes follows for Continue Watching.
      let target = record;
      try {
        const freshRaw = await env.CONFIGS.get(trackingKey);
        if (freshRaw) target = JSON.parse(freshRaw);
      } catch {}
      const before = JSON.stringify(Array.isArray(target.airingNext) ? target.airingNext : []);
      if (JSON.stringify(items) !== before) {
        const previousStamp = Number(target.updatedAt) || 0;
        target.airingNext = items;
        target.updatedAt = Math.max(Date.now(), previousStamp + 1);
        await env.CONFIGS.put(trackingKey, JSON.stringify(target));
        if (env.DB) await saveAiringNextD1(env, username, items, target.updatedAt, previousStamp);
      }
      // A rebuild the budget cut short is due again in half an hour rather
      // than six, by which time the lookups it did make have warmed the cache
      // for the ones it did not.
      const ttlSec = complete ? Math.round(AIRING_NEXT_SERVER_REFRESH_MS / 1000) : 1800;
      await env.CONFIGS.put(checkedKey, '1', { expirationTtl: ttlSec });
    } catch (accountErr) {
      console.error(`[Cron] Airing Next: skipping ${username} this cycle:`, accountErr);
    }
  }

  // Past the end of this page: move to the next one, or start over.
  let next;
  if (nextOffset >= pageKeys.length) {
    next = listResult.list_complete ? { c: '', o: 0 } : { c: listResult.cursor || '', o: 0 };
  } else {
    next = { c: sweep.c, o: nextOffset };
  }
  if (next.c !== sweep.c || next.o !== sweep.o) {
    try { await env.CONFIGS.put(CURSOR_KEY, JSON.stringify(next)); } catch {}
  }
}

async function checkForNewEpisodes(env, fetchBudget) {
  if (!env || !env.CONFIGS || !env.TMDB_API_KEY) return;

  const ACCOUNT_BATCH_SIZE = 25;
  // How many shows this tick may look up, derived from the outbound-fetch
  // budget it was handed rather than fixed at 150.
  //
  // Each check is two season lookups at worst (findNextAiredEpisodeForShow),
  // so 150 shows is up to 300 fetches -- six times the free plan's 50, which
  // is why the tick was terminated and Continue Watching never ran there at
  // all. The sweep already resumes from a KV cursor, so a smaller slice costs
  // nothing but ticks, and there are 240 of those a day.
  //
  // A caller that passes nothing gets the ceiling this sweep has always used.
  // See CRON_SUBREQUEST_BUDGET (00_constants.js).
  const SHOW_CHECK_BUDGET = Number.isFinite(fetchBudget) && fetchBudget > 0
    ? Math.max(1, Math.min(CRON_EPISODE_CHECK_MAX, Math.floor(fetchBudget / CRON_EPISODE_CHECK_FETCHES)))
    : CRON_EPISODE_CHECK_MAX;

  // Sweep position is a page cursor PLUS an offset into that page.
  //
  // It used to be the cursor alone, and the show-check budget is spent across
  // a whole page of accounts -- so when one heavy account exhausted it, the
  // loop broke out of a page it had not finished and the cursor still jumped
  // to the end of that page. KV pages are deterministic for a stable key set,
  // so the same accounts sat behind the same heavy account on every cycle:
  // measured, 24 of 30 accounts were never swept at all across six full ticks,
  // silently and permanently.
  //
  // Holding the cursor instead would be worse -- an account with more shows
  // than the budget would wedge its page forever and starve everything after
  // it. Recording how far into the page we got fixes both: the next tick
  // re-lists the same page and resumes exactly where this one stopped.
  //
  // Older deployments have a bare cursor string stored here; that is read as
  // { c: <string>, o: 0 } so an upgrade resumes rather than restarting.
  let sweep = { c: '', o: 0 };
  try {
    const raw = await env.CONFIGS.get('cron:continuewatching:cursor');
    if (raw) {
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { parsed = null; }
      if (parsed && typeof parsed === 'object' && typeof parsed.c === 'string') {
        sweep = { c: parsed.c, o: Number(parsed.o) || 0 };
      } else {
        sweep = { c: raw, o: 0 };
      }
    }
  } catch (e) {
    console.error('[Cron] could not read the Continue Watching cursor:', e);
  }

  const listOpts = { prefix: 'creator:', limit: ACCOUNT_BATCH_SIZE };
  if (sweep.c) listOpts.cursor = sweep.c;
  let listResult;
  try {
    listResult = await env.CONFIGS.list(listOpts);
  } catch (e) {
    // A stored cursor KV will not accept -- an expired one, or one left over
    // from a rebound namespace -- used to end the sweep here on every single
    // tick, forever: nothing caught the throw and nothing cleared the cursor,
    // so Continue Watching simply stopped for the whole deployment with only
    // a log line to show for it. Drop the position and let the next tick start
    // from the beginning; the work is idempotent, so restarting costs a
    // repeat rather than a gap.
    console.error('[Cron] account listing failed, restarting the sweep from the beginning:', e);
    if (sweep.c) {
      try { await env.CONFIGS.put('cron:continuewatching:cursor', ''); } catch (e2) {}
    }
    return;
  }

  let showChecksUsed = 0;
  const pageKeys = listResult.keys || [];
  // An offset past the end (the page shrank since last tick) means this page
  // is done; fall through to the cursor advance below rather than looping.
  let nextOffset = Math.min(Math.max(sweep.o, 0), pageKeys.length);

  for (let i = nextOffset; i < pageKeys.length; i++) {
    const key = pageKeys[i];
    if (showChecksUsed >= SHOW_CHECK_BUDGET) {
      // Out of budget BEFORE this account got its turn, so it is the one to
      // resume at. An account that exhausted the budget from inside its own
      // loop has already had its turn and i has moved past it -- which is what
      // stops an account with more shows than the whole budget from being
      // retried forever while everything behind it starves.
      break;
    }
    nextOffset = i + 1;
    const username = key.name.slice('creator:'.length);
    // One account must never be able to stop the sweep.
    //
    // There was no try/catch anywhere in this function, and the cursor is only
    // written at the end -- so a single account whose tracking key would not
    // read, or whose blob tripped anything below, aborted the whole tick
    // before the cursor advanced. The next tick restarted and died at the same
    // account, and every account behind it was never swept again. Measured:
    // one unreadable key stopped Continue Watching for everyone after it,
    // permanently.
    //
    // Isolating each account means a bad one costs itself and nothing else.
    // It is skipped rather than retried because the next full cycle will come
    // back to it anyway.
    try {
    await ensureTrackingMigrated(env, username);
    let blob = null;
    if (env.DB) {
      blob = await readCreatorTrackingD1(env, username);
    }
    if (!blob) {
      const syncRaw = await env.CONFIGS.get(`creatorsynctracking:${username}`);
      if (!syncRaw) continue;

      try {
        blob = JSON.parse(syncRaw);
      } catch (e) {
        continue;
      }
    }

    const fullyWatched = Array.isArray(blob.fullyWatchedShowIds) ? blob.fullyWatchedShowIds : [];
    if (!fullyWatched.length) continue;

    const continueWatching = Array.isArray(blob.continueWatching) ? blob.continueWatching : [];
    // What THIS sweep works out, kept apart from the snapshot it was computed
    // against -- see the write-back at the bottom of this account's turn for
    // why the two must not be conflated.
    const additions = [];
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
        next = await findNextAiredEpisodeForShow(showId, latest.seasonNum, latest.episodeNum, env.TMDB_API_KEY, env);
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

      additions.push({
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
        airDate: next.episode.air_date || null,
        isUnaired: !!next.isUnaired,
      });
      // No longer "fully watched" -- it has a known next episode now,
      // same as if updateContinueWatching had just found it client-side.
      blobChanged = true;
    }

    if (blobChanged || stillFullyWatched.length !== fullyWatched.length) {
      // Re-read before writing, and write only the two fields this sweep
      // actually computes.
      //
      // `blob` was read at the top of this account's turn, and everything
      // since has been TMDB network I/O -- seconds, not milliseconds. The
      // old code wrote that whole snapshot back, so anything the account's
      // own browser saved in the meantime (a newly watched episode, a
      // refreshed Airing Next, recomputed recommendations) was silently
      // reverted, with the save and the cron both reporting success.
      //
      // /api/creator/sync/save-tracking already guards the mirror image of
      // this -- a stale CLIENT push wiping a server-side scrobble -- with
      // a rescue-merge. This is the same hazard in the other direction,
      // and the same reasoning applies: the writer must only own the
      // fields it computed.
      const targetKey = `creatorsynctracking:${username}`;
      let target = blob;
      try {
        const freshRaw = await env.CONFIGS.get(targetKey);
        if (freshRaw) target = JSON.parse(freshRaw);
      } catch {
        // Unreadable/unparseable right now -- fall back to the snapshot we
        // already have rather than dropping a real Continue Watching update.
        target = blob;
      }
      // Apply what this sweep DECIDED, not the snapshot it decided against.
      //
      // Re-reading the record and then assigning `continueWatching` -- an array
      // built from the copy read at the top of this account's turn, before
      // several seconds of TMDB network I/O -- put that stale snapshot back over
      // whatever the account's own browser saved in the meantime. The re-read
      // was doing nothing. Worse, `blob` is read from D1 first, so a KV record
      // that was ahead of D1 got rolled back to it by the next tick.
      //
      // This sweep only ever does two things: it appends a newly-aired episode
      // to Continue Watching, and it takes that show out of fullyWatchedShowIds.
      // Those are the only two edits that belong to it, so those are the only
      // two it makes.
      const freshCw = Array.isArray(target.continueWatching) ? target.continueWatching : [];
      const freshShows = new Set(
        freshCw.map((it) => it && trackingShowKey(it.showId || it.id)).filter(Boolean)
      );
      for (const added of additions) {
        const k = trackingShowKey(added.showId || added.id);
        if (k && freshShows.has(k)) continue;
        if (k) freshShows.add(k);
        freshCw.unshift(added);
      }
      target.continueWatching = freshCw;

      const noLongerFullyWatched = new Set(
        fullyWatched.map(String).filter((id) => !stillFullyWatched.includes(id))
      );
      const freshFullyWatched = Array.isArray(target.fullyWatchedShowIds)
        ? target.fullyWatchedShowIds
        : stillFullyWatched;
      target.fullyWatchedShowIds = freshFullyWatched.filter((id) => !noLongerFullyWatched.has(String(id)));
      target.updatedAt = Date.now();
      await env.CONFIGS.put(targetKey, JSON.stringify(target));
      if (env.DB) {
        await saveCreatorTrackingD1(env, username, target, false);
      }
    }
    } catch (accountErr) {
      // See the per-account try above: this account is skipped, the sweep
      // carries on, and the next full cycle will come back to it.
      console.error('[Cron] Continue Watching sweep skipped an account:', username, accountErr);
    }
  }

  // The position advances only over accounts that were actually processed.
  //
  // Finished the page -> move to the next page (or back to the start, so the
  // next run picks up with account #1 again instead of sitting idle). Stopped
  // partway -> stay on this page and record where to resume, which is what
  // stops the budget silently skipping everyone behind a heavy account.
  //
  // Written after the loop, not before it: a tick that throws or runs out of
  // CPU must not have already committed a move it did not earn.
  const nextSweep = nextOffset >= pageKeys.length
    ? { c: listResult.list_complete ? '' : (listResult.cursor || ''), o: 0 }
    : { c: sweep.c, o: nextOffset };
  try {
    await env.CONFIGS.put('cron:continuewatching:cursor', JSON.stringify(nextSweep));
  } catch (e) {
    console.error('[Cron] could not advance the Continue Watching cursor:', e);
  }
}

// Pre-warms official Trakt, TMDB, Simkl, and MDBList charts in the background on a scheduled cron trigger (e.g. every 6 mins).
// Populates KV and in-memory cache so visitors always experience instant cache hits with zero API rate limits across all providers.
//
// `fetchBudget` is how many outbound fetches this tick may spend here. One
// chart is ~105 of them (fetchTmdbPagedResults asks for 5 pages and then
// resolves details for every item on them), so this is the half of the tick
// that cannot be divided down to fit a free Worker's 50: below one chart's
// worth of budget it does nothing at all and says so, rather than issuing
// fetches the runtime will terminate the invocation on -- which is what used
// to take Continue Watching down with it every tick. See
// CRON_SUBREQUEST_BUDGET (00_constants.js).
//
// Above that, the charts are warmed a slice at a time from a rotating cursor,
// so a budget that fits only a few per tick still covers all of them over the
// following ticks instead of re-warming the first few forever. A budget that
// fits the whole list warms the whole list, exactly as this always did.
async function prewarmSharedCatalogs(env, ctx, fetchBudget) {
  if (!env || !env.CONFIGS) return;

  const traktKey = (env && env.TRAKT_CLIENT_ID) || TRAKT_CLIENT_ID;
  const tmdbKey = (env && env.TMDB_API_KEY) || TMDB_API_KEY;
  const simklKey = (env && env.SIMKL_CLIENT_ID) || SIMKL_CLIENT_ID;
  const mdblistKey = (env && env.MDBLIST_API_KEY) || MDBLIST_API_KEY;
  const mdblistPopularKey = (env && env.MDBLIST_POPULAR_KEY) || MDBLIST_POPULAR_KEY;

  const budget = Number.isFinite(fetchBudget) && fetchBudget > 0 ? fetchBudget : Infinity;
  const maxWarms = budget === Infinity
    ? Infinity
    : Math.floor(budget / CRON_CHART_WARM_FETCHES);
  if (maxWarms < 1) {
    // Deliberately one line, not a throw: this is the documented free-plan
    // limitation (README, "Which Cloudflare plan do I need?"), and the rest of
    // the tick -- the episode sweep that has already run by the time this is
    // reached -- is worth more than a chart that cannot fit either way.
    console.warn(
      `[Cron] chart pre-warming skipped: one chart costs about ${CRON_CHART_WARM_FETCHES} outbound fetches and this tick's budget is ${budget}. ` +
      "Set CRON_SUBREQUEST_BUDGET in wrangler.toml (10000 on a Workers Paid plan) to turn it back on."
    );
    return;
  }

  // One flat list, in the order the four blocks used to run in, so a rotating
  // cursor can walk it. Each entry warms exactly one chart.
  const warmTasks = [];

  // 1. Trakt Official Charts
  if (traktKey) {
    const traktCharts = [
      { chartKey: "trending", type: "movie" },
      { chartKey: "trending", type: "series" },
      { chartKey: "popular", type: "movie" },
      { chartKey: "popular", type: "series" },
      { chartKey: "most_watched", type: "movie" },
      { chartKey: "most_watched", type: "series" },
      { chartKey: "most_anticipated", type: "movie" },
      { chartKey: "most_anticipated", type: "series" },
      { chartKey: "box_office", type: "movie" },
    ];
    for (const item of traktCharts) {
      warmTasks.push({
        label: `Trakt chart (${item.chartKey} ${item.type})`,
        pauseMs: 200,
        run: () => fetchTraktChart({ type: item.type }, 0, traktKey, item.chartKey, env, ctx),
      });
    }
  }

  // 2. TMDB Official Charts & Streaming Services
  if (tmdbKey) {
    const tmdbCharts = [
      { chartKey: "trending", type: "movie" },
      { chartKey: "trending", type: "series" },
      { chartKey: "popular", type: "movie" },
      { chartKey: "popular", type: "series" },
      { chartKey: "top_rated", type: "movie" },
      { chartKey: "top_rated", type: "series" },
      { chartKey: "now_playing", type: "movie" },
      { chartKey: "upcoming", type: "movie" },
      { chartKey: "new_movies", type: "movie" },
      { chartKey: "new_shows", type: "series" },
      { chartKey: "netflix", type: "movie" },
      { chartKey: "netflix", type: "series" },
      { chartKey: "disney", type: "movie" },
      { chartKey: "disney", type: "series" },
      { chartKey: "appletv", type: "movie" },
      { chartKey: "appletv", type: "series" },
      { chartKey: "primevideo", type: "movie" },
      { chartKey: "primevideo", type: "series" },
      { chartKey: "hbomax", type: "movie" },
      { chartKey: "hbomax", type: "series" },
      { chartKey: "hulu", type: "movie" },
      { chartKey: "hulu", type: "series" },
      { chartKey: "paramount", type: "movie" },
      { chartKey: "paramount", type: "series" },
    ];
    for (const item of tmdbCharts) {
      warmTasks.push({
        label: `TMDB chart (${item.chartKey} ${item.type})`,
        pauseMs: 150,
        run: () => fetchTmdbChart({ type: item.type }, 0, tmdbKey, item.chartKey, "US", false, env, ctx),
      });
    }
  }

  // 3. Simkl Trending Charts
  if (simklKey) {
    const simklCharts = [
      { chartKey: "today", type: "movie" },
      { chartKey: "today", type: "series" },
      { chartKey: "week", type: "movie" },
      { chartKey: "week", type: "series" },
      { chartKey: "month", type: "movie" },
      { chartKey: "month", type: "series" },
      { chartKey: "anime-week", type: "series" },
    ];
    for (const item of simklCharts) {
      warmTasks.push({
        label: `Simkl chart (${item.chartKey} ${item.type})`,
        pauseMs: 150,
        run: () => fetchSimklChart({ type: item.type }, 0, simklKey, item.chartKey, env, ctx),
      });
    }
  }

  if (warmTasks.length) {
    // Where the last tick stopped. A cursor past the end (the list shrank
    // because a provider key was removed) restarts at the beginning rather
    // than warming nothing.
    let warmCursor = 0;
    try {
      const raw = await env.CONFIGS.get("cron:prewarm:cursor");
      const parsed = parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed > 0) warmCursor = parsed % warmTasks.length;
    } catch (e) {
      console.warn("[Cron] could not read the pre-warm cursor:", e && e.message ? e.message : e);
    }

    const take = Math.min(warmTasks.length, maxWarms);
    for (let n = 0; n < take; n++) {
      const item = warmTasks[(warmCursor + n) % warmTasks.length];
      try {
        await item.run();
        await new Promise((resolve) => setTimeout(resolve, item.pauseMs));
      } catch (e) {
        console.warn(`[Cron] Prewarm ${item.label} failed:`, e && e.message ? e.message : e);
      }
    }

    // Advanced after the slice, not before it: a tick terminated part-way
    // through must not have already committed a move it did not make. The
    // cost of repeating a chart is a cache hit.
    if (take < warmTasks.length) {
      try {
        await env.CONFIGS.put("cron:prewarm:cursor", String((warmCursor + take) % warmTasks.length));
      } catch (e) {
        console.warn("[Cron] could not advance the pre-warm cursor:", e && e.message ? e.message : e);
      }
    }
  }

  // 4. MDBList Official Charts & Toplists (Throttled to once every 1 hour to preserve 1,000 req/day quota)
  //
  // Left as one all-or-nothing block rather than folded into the rotation
  // above, because its hourly gate is a single flag for the whole group:
  // warming a slice of it would set the flag and the rest would wait an hour.
  // So it runs only when the budget still has room for the whole group.
  const mdblistWarmCount = 7;
  if (maxWarms !== Infinity && maxWarms < mdblistWarmCount) return;
  try {
    const lastMdblistWarmRaw = await env.CONFIGS.get("cron:last_warmed:mdblist");
    const lastMdblistWarm = lastMdblistWarmRaw ? parseInt(lastMdblistWarmRaw, 10) : 0;
    const shouldWarmMdblist = !lastMdblistWarm || Date.now() - lastMdblistWarm >= 3600 * 1000;

    if (shouldWarmMdblist) {
      await env.CONFIGS.put("cron:last_warmed:mdblist", String(Date.now()));

      if (mdblistPopularKey) {
        try {
          await fetchTopLists(mdblistPopularKey, env, ctx);
        } catch (e) {
          console.warn("[Cron] Prewarm MDBList toplists failed:", e && e.message ? e.message : e);
        }
      }

      const mdblistCharts = [
        { url: "https://mdblist.com/lists/official/movies/popular", type: "movie" },
        { url: "https://mdblist.com/lists/official/shows/popular", type: "series" },
        { url: "https://mdblist.com/lists/official/movies/justwatch-streaming-charts", type: "movie" },
        { url: "https://mdblist.com/lists/official/shows/justwatch-streaming-charts", type: "series" },
        { url: "https://mdblist.com/lists/official/movies/moviemeter", type: "movie" },
        { url: "https://mdblist.com/lists/official/shows/moviemeter", type: "series" },
      ];
      for (const item of mdblistCharts) {
        try {
          await fetchMdblist({ url: item.url, type: item.type }, 0, mdblistKey, env, ctx);
          await new Promise((resolve) => setTimeout(resolve, 200));
        } catch (e) {
          console.warn(`[Cron] Prewarm MDBList chart failed (${item.url} ${item.type}):`, e && e.message ? e.message : e);
        }
      }
    }
  } catch (e) {
    console.warn("[Cron] MDBList warm error:", e && e.message ? e.message : e);
  }

}

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
            description: epLabel ? `Next Episode: ${epLabel} · Airs ${details.nextEpisodeAirDate}` : (details.overview || undefined),
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
  const src = `https://api.trakt.tv/${chartPath}?limit=${PAGE_SIZE}&page=${page}`;

  const headers = {
    "Content-Type": "application/json",
    "trakt-api-version": "2",
    "trakt-api-key": traktKey,
    "User-Agent": `my-list-addon/${ADDON_VERSION}`,
  };

  const cacheKey = `user_cache:trakt:chart:${chartKey}:${wantKind}:${page}`;
  const kvKey = `trakt:chart:${chartKey}:${wantKind}:${page}`;

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
      return await res.json();
    },
  });

  return enrichTrailers(mapTraktItems(data, entry.type), entry.type, TMDB_API_KEY);
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
  if (!cleanTmdbId) return { imdbId: null, videos: null, hasDigitalRelease: null };

  const cacheKey = `user_cache:tmdb_detail:${kind}:${cleanTmdbId}`;
  const cached = getPerUserCache(cacheKey);
  if (cached && cached.data) return cached.data;

  // Check KV cache across all workers
  if (env && env.CONFIGS) {
    try {
      const kvRaw = await env.CONFIGS.get(`tmdbdetail:${kind}:${cleanTmdbId}`);
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
  if (!res.ok) return { imdbId: null, videos: null, hasDigitalRelease: null };
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
  const result = { imdbId, videos, hasDigitalRelease };
  // Cache for 7 days (604800s)
  setPerUserCache(cacheKey, result, 604800, 2592000);

  // Persist to Cloudflare KV for 30 days so no other worker or edge ever re-queries this ID
  if (env && env.CONFIGS && imdbId) {
    try {
      env.CONFIGS.put(`tmdbdetail:${kind}:${cleanTmdbId}`, JSON.stringify(result), { expirationTtl: 2592000 }).catch(() => {});
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

  const resolved = await mapWithConcurrency(page, TMDB_DETAIL_RESOLVE_CONCURRENCY, async (it) => {
    const { imdbId, videos } = await fetchTmdbDetails(it.id, wantKind, apiKey);
    if (!imdbId) return null;
    return mapTmdbItem(it, imdbId, entry.type, videos);
  });

  return resolved.filter(Boolean);
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
      
      // Sort chronologically by release date
      parts.sort((a, b) => (a.release_date || "9999").localeCompare(b.release_date || "9999"));

      const windowItems = parts.slice(skip, skip + PAGE_SIZE);
      const resolved = await mapWithConcurrency(windowItems, TMDB_DETAIL_RESOLVE_CONCURRENCY, async (it) => {
        const { imdbId, videos } = await fetchTmdbDetails(it.id, "movie", apiKey);
        if (!imdbId) return null;
        return mapTmdbItem(it, imdbId, "movie", videos);
      });

      return resolved.filter(Boolean);
    },
  });
}

// Shared meta-shaping for any TMDB item (list, chart, wherever), once its
// IMDB id is known. TMDB's own poster_path/backdrop_path are already
// sitting right there in the response (zero extra requests), and cover
// obscure titles more reliably than metahub.space's IMDB-keyed poster
// database -- preferred over metahub, with metahub only as a fallback for
// the rare item missing a poster_path.
function mapTmdbItem(it, imdbId, type, videos) {
  let poster = undefined;
  if (it.poster_path) {
    poster = `https://image.tmdb.org/t/p/w500${it.poster_path}`;
  } else if (it.backdrop_path) {
    poster = `https://image.tmdb.org/t/p/w780${it.backdrop_path}`;
  } else if (imdbId && String(imdbId).startsWith("tt")) {
    poster = `https://images.metahub.space/poster/medium/${imdbId}/img`;
  }
  return {
    id: imdbId,
    type,
    name: it.title || it.name,
    poster,
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
        const { imdbId, videos, hasDigitalRelease } = await fetchTmdbDetails(it.id, wantKind, apiKey, env);
        if (!imdbId) return null;
        if (applyDigitalFilter && hasDigitalRelease === false) return null;
        return mapTmdbItem(it, imdbId, entry.type, videos);
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

  const resolved = await mapWithConcurrency(windowItems, TMDB_DETAIL_RESOLVE_CONCURRENCY, async (it) => {
    const { imdbId, videos } = await fetchTmdbDetails(it.id, wantKind, apiKey);
    if (!imdbId) return null;
    return mapTmdbItem(it, imdbId, entry.type, videos);
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
    const { imdbId, videos } = await fetchTmdbDetails(it.id, wantKind, apiKey);
    if (!imdbId) return null;
    return mapTmdbItem(it, imdbId, entry.type, videos);
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
    const { imdbId, videos } = await fetchTmdbDetails(it.id, wantKind, apiKey);
    if (!imdbId) return null;
    return mapTmdbItem(it, imdbId, entry.type, videos);
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
  const config = TMDB_GENRE_CONFIG[key] || { movie: "", tv: "" };
  const queryPart = substituteWatchRegion(config[wantKind] || "", region);
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  let discoverPath = "";
  if (wantKind === "movie") {
    discoverPath = "discover/movie?sort_by=primary_release_date.desc&primary_release_date.lte=" + today +
      (queryPart ? "&" + queryPart : "") +
      "&include_adult=false";
  } else {
    discoverPath = "discover/tv?sort_by=first_air_date.desc&first_air_date.lte=" + today +
      (queryPart ? "&" + queryPart : "") +
      "&include_adult=false";
  }

  const windowItems = await fetchTmdbPagedResults(discoverPath, apiKey, skip, 0);

  const resolved = await mapWithConcurrency(windowItems, TMDB_DETAIL_RESOLVE_CONCURRENCY, async (it) => {
    const { imdbId, videos } = await fetchTmdbDetails(it.id, wantKind, apiKey);
    const effectiveId = imdbId || ("tmdb:" + it.id);
    return mapTmdbItem(it, effectiveId, entry.type, videos);
  });

  const res = resolved.filter(Boolean);
  res.totalItems = windowItems.totalItems;
  return res;
}

// Wraps the real resolution logic (fetchTmdbItemDetailsUncached below) in
// the same shared, canonical-key cache Trakt already uses
// (fetchWithPerUserCacheAndCircuitBreaker) -- unlike the catalog/chart
// fetchers above, this function IS reachable with a personal TMDB key
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
async function fetchTmdbItemDetails(imdbId, apiKey, fallbackType, region, bypassCache, env, ctx) {
  if (!apiKey || !imdbId) return null;
  const effectiveRegion = (region || "US").toUpperCase().slice(0, 2) || "US";
  const cacheKey = `tmdb:itemdetails:${String(imdbId).trim()}:${fallbackType || ""}:${effectiveRegion}`;
  if (!bypassCache) {
    const cached = getPerUserCache(cacheKey);
    if (cached && cached.isFresh && cached.data) {
      if (cached.data.nextEpisodeAirDate && isEpisodeAiredServer(cached.data.nextEpisodeAirDate)) {
        // Scheduled episode has already aired; refresh to resolve the new upcoming episode
      } else {
        return cached.data;
      }
    }
  }
  return fetchWithPerUserCacheAndCircuitBreaker({
    cacheKey,
    freshTtlSec: (fallbackType === "series" || fallbackType === "tv") ? 7200 : 604800,
    staleTtlSec: 2592000,
    providerLabel: "TMDB Item Details",
    env: env,
    ctx: ctx,
    kvKey: apiKey ? cacheKey : "",
    kvTtlSec: 604800,
    fetchFn: () => fetchTmdbItemDetailsUncached(imdbId, apiKey, fallbackType, effectiveRegion),
  });
}

async function fetchTmdbItemDetailsUncached(imdbId, apiKey, fallbackType, region) {
  if (!apiKey || !imdbId) return null;
  const effectiveRegion = (region || "US").toUpperCase().slice(0, 2) || "US";
  const today = new Date().toISOString().slice(0, 10);
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
    const detailSrc = "https://api.themoviedb.org/3/" + resolvedType + "/" + tmdbId + "?api_key=" + encodeURIComponent(apiKey) + "&append_to_response=videos,release_dates,content_ratings,external_ids,credits";
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

  const nextEpInfo = await (async () => {
    if (type !== "tv") return { nextEpisodeAirDate: null, nextEpisodeNumber: null, nextEpisodeSeasonNumber: null, nextEpisodeName: null };
    if (match.next_episode_to_air) {
      const nextAir = match.next_episode_to_air.air_date || null;
      if (nextAir && nextAir > today) {
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
        const sRes = await fetch("https://api.themoviedb.org/3/tv/" + tmdbId + "/season/" + seasonToSearch + "?api_key=" + encodeURIComponent(apiKey), {
          headers: { "User-Agent": "my-list-addon/1.14" },
          cf: { cacheTtl: 3600, cacheEverything: true },
        });
        if (sRes.ok) {
          const sData = await sRes.json();
          if (Array.isArray(sData.episodes)) {
            const futureEp = sData.episodes.find((ep) => ep && ep.air_date && ep.air_date > today);
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
      ? match.seasons.filter((s) => s && s.season_number > 0 && s.air_date && s.air_date > today)
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

  const isUnairedFuture = !!(nextEpInfo && nextEpInfo.nextEpisodeAirDate && nextEpInfo.nextEpisodeAirDate > today);

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
    fetchFn: () => fetchTmdbSeasonDetailsUncached(imdbId, seasonNum, apiKey, knownTmdbId),
  });
}

async function fetchTmdbSeasonDetailsUncached(imdbId, seasonNum, apiKey, knownTmdbId) {
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
  if (!tmdbId) return null;

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
async function checkForNewEpisodes(env) {
  if (!env || !env.CONFIGS || !env.TMDB_API_KEY) return;

  const ACCOUNT_BATCH_SIZE = 25;
  const SHOW_CHECK_BUDGET = 150;

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
      target.continueWatching = continueWatching;
      target.fullyWatchedShowIds = stillFullyWatched;
      target.updatedAt = Date.now();
      await env.CONFIGS.put(targetKey, JSON.stringify(target));
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
async function prewarmSharedCatalogs(env, ctx) {
  if (!env || !env.CONFIGS) return;

  const traktKey = (env && env.TRAKT_CLIENT_ID) || TRAKT_CLIENT_ID;
  const tmdbKey = (env && env.TMDB_API_KEY) || TMDB_API_KEY;
  const simklKey = (env && env.SIMKL_CLIENT_ID) || SIMKL_CLIENT_ID;
  const mdblistKey = (env && env.MDBLIST_API_KEY) || MDBLIST_API_KEY;
  const mdblistPopularKey = (env && env.MDBLIST_POPULAR_KEY) || MDBLIST_POPULAR_KEY;

  // 1. Trakt Official Charts (every 6 mins)
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
      try {
        await fetchTraktChart({ type: item.type }, 0, traktKey, item.chartKey, env, ctx);
        await new Promise((resolve) => setTimeout(resolve, 200));
      } catch (e) {
        console.warn(`[Cron] Prewarm Trakt chart failed (${item.chartKey} ${item.type}):`, e && e.message ? e.message : e);
      }
    }
  }

  // 2. TMDB Official Charts & Streaming Services (every 6 mins)
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
      try {
        await fetchTmdbChart({ type: item.type }, 0, tmdbKey, item.chartKey, "US", false, env, ctx);
        await new Promise((resolve) => setTimeout(resolve, 150));
      } catch (e) {
        console.warn(`[Cron] Prewarm TMDB chart failed (${item.chartKey} ${item.type}):`, e && e.message ? e.message : e);
      }
    }
  }

  // 3. Simkl Trending Charts (every 6 mins)
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
      try {
        await fetchSimklChart({ type: item.type }, 0, simklKey, item.chartKey, env, ctx);
        await new Promise((resolve) => setTimeout(resolve, 150));
      } catch (e) {
        console.warn(`[Cron] Prewarm Simkl chart failed (${item.chartKey} ${item.type}):`, e && e.message ? e.message : e);
      }
    }
  }

  // 4. MDBList Official Charts & Toplists (Throttled to once every 1 hour to preserve 1,000 req/day quota)
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

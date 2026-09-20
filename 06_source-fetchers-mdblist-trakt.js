function extractMdblistItem(it) {
  if (!it) return null;
  // MDBList sync/watched item shapes:
  // Episodes: { watched_at, episode: { season, number, name, ids, show: { title, year, ids: { imdb, tmdb } } } }
  // Shows:    { watched_at, show: { title, year, ids: { imdb, tmdb }, poster } }
  // Movies:   { watched_at, movie: { title, year, ids: { imdb, tmdb }, poster } }
  // Direct:   { id, title, mediatype, imdb_id, poster, ... }
  const ep = it.episode || null;
  const epShow = ep && ep.show ? ep.show : null;
  const inner = it.show || it.movie || epShow || it;

  let rawImdb = inner.imdb_id || inner.imdbid || inner.imdb || (inner.ids && (inner.ids.imdb || inner.ids.imdb_id)) || (typeof inner.id === 'string' && inner.id.startsWith('tt') ? inner.id : '');
  let rawTmdb = inner.tmdb_id || inner.tmdbid || inner.tmdb || (inner.ids && (inner.ids.tmdb || inner.ids.tmdb_id)) || '';
  if (!rawTmdb && typeof inner.id === 'number') rawTmdb = String(inner.id);
  else if (!rawTmdb && typeof inner.id === 'string' && /^\d+$/.test(inner.id)) rawTmdb = inner.id;
  else if (!rawTmdb && typeof inner.id === 'string' && inner.id.startsWith('tmdb:')) rawTmdb = inner.id.slice(5);

  const rawId = rawImdb || (rawTmdb ? ('tmdb:' + rawTmdb) : (inner.id ? String(inner.id) : ''));
  if (!rawId) return null;

  const isEpisode = !!ep || !!epShow;
  const isShow = isEpisode || !!it.show || inner.mediatype === 'show' || inner.mediatype === 'series' || inner.mediatype === 'tv' || inner.type === 'show' || inner.type === 'series' || inner.type === 'tv' || !!inner.seasons;
  const mt = isShow ? 'series' : (it.movie || inner.mediatype === 'movie' || inner.type === 'movie' ? 'movie' : (inner.mediatype || inner.type || it.mediatype || it.type || 'movie')).toLowerCase();

  let name = inner.title || inner.name || it.title || it.name || 'Untitled';
  const showTitle = (epShow && epShow.title) || (it.show && it.show.title) || inner.title || inner.name || it.title || '';
  if (ep && (ep.season || ep.number)) {
    const s = ep.season || 1;
    const e = ep.number || ep.episode || 1;
    const epName = ep.name || ep.title ? ' \u2014 ' + (ep.name || ep.title) : '';
    name = (showTitle || 'Show') + ' S' + s + 'E' + e + epName;
  }
  let showPoster = inner.poster || it.poster || (rawImdb ? `https://images.metahub.space/poster/medium/${rawImdb}/img` : undefined);
  if (showPoster && typeof showPoster === 'string' && showPoster.startsWith('/')) {
    showPoster = 'https://image.tmdb.org/t/p/w500' + showPoster;
  }
  let poster = isEpisode ? (ep && (ep.poster || ep.still) || showPoster) : showPoster;
  if (poster && typeof poster === 'string' && poster.startsWith('/')) {
    poster = 'https://image.tmdb.org/t/p/w500' + poster;
  }
  const isItemAdult = it.adult === true || inner.adult === true || it.is_adult === true || inner.is_adult === true;
  const itemGenres = it.genres || inner.genres || undefined;
  const itemCert = it.certification || inner.certification || it.age_rating || inner.age_rating || undefined;
  const releaseYear = inner.release_year || inner.year || it.release_year || it.year || undefined;
  let tmdbScore = null;
  const ratingsArr = Array.isArray(it.ratings) ? it.ratings : (Array.isArray(inner.ratings) ? inner.ratings : null);
  if (ratingsArr) {
    const tmdbObj = ratingsArr.find((r) => r && (r.source === 'tmdb' || r.name === 'tmdb'));
    if (tmdbObj) {
      if (typeof tmdbObj.value === 'number') tmdbScore = tmdbObj.value;
      else if (typeof tmdbObj.score === 'number') tmdbScore = tmdbObj.score > 10 ? tmdbObj.score / 10 : tmdbObj.score;
      else if (tmdbObj.value) tmdbScore = parseFloat(tmdbObj.value);
    }
    if (tmdbScore == null) {
      const anyObj = ratingsArr.find((r) => r && (r.value != null || r.score != null));
      if (anyObj) {
        if (typeof anyObj.value === 'number') tmdbScore = anyObj.value;
        else if (typeof anyObj.score === 'number') tmdbScore = anyObj.score > 10 ? anyObj.score / 10 : anyObj.score;
        else if (anyObj.value) tmdbScore = parseFloat(anyObj.value);
      }
    }
  }
  const rawScore = tmdbScore != null ? tmdbScore : (
    it.score_average || inner.score_average ||
    it.rating || inner.rating ||
    it.score || inner.score ||
    (it.ratings && (it.ratings.tmdb || it.ratings.imdb || it.ratings.score)) ||
    (inner.ratings && (inner.ratings.tmdb || inner.ratings.imdb || inner.ratings.score))
  );
  let numScore = undefined;
  if (typeof rawScore === 'number' && rawScore > 0) {
    numScore = rawScore > 10 ? Math.round(rawScore) / 10 : rawScore;
  } else if (typeof rawScore === 'string' && rawScore) {
    const p = parseFloat(rawScore);
    if (!isNaN(p) && p > 0) numScore = p > 10 ? Math.round(p) / 10 : p;
  }
  const nextEp = it.next_episode || inner.next_episode || null;
  return {
    id: rawId,
    imdbId: rawImdb || undefined,
    tmdbId: rawTmdb ? String(rawTmdb) : undefined,
    mediatype: mt,
    name,
    showTitle,
    poster,
    releaseInfo: releaseYear ? String(releaseYear) : undefined,
    season: ep ? (ep.season || 1) : (nextEp && nextEp.season != null ? nextEp.season : undefined),
    episode: ep ? (ep.number || ep.episode || 1) : (nextEp && (nextEp.episode != null || nextEp.number != null) ? (nextEp.episode || nextEp.number) : undefined),
    nextEpisode: nextEp ? {
      season: nextEp.season,
      episode: nextEp.episode != null ? nextEp.episode : nextEp.number,
      title: nextEp.title || nextEp.name || '',
      air_date: nextEp.air_date || nextEp.air_date_utc || '',
    } : undefined,
    adult: isItemAdult ? true : undefined,
    isAdult: isItemAdult ? true : undefined,
    genres: itemGenres,
    certification: itemCert,
    vote_average: numScore,
    rating: numScore,
  };
}

function mapMdblistItems(data, type) {
  if (!data) return [];
  let rawList = [];
  if (Array.isArray(data)) {
    rawList = data;
  } else if (data && typeof data === 'object') {
    const d = data.watchlist || data.data || data;
    if (Array.isArray(d)) {
      rawList = d;
    } else if (type === 'series') {
      rawList = [
        ...(Array.isArray(d.shows) ? d.shows : []),
        ...(Array.isArray(d.series) ? d.series : []),
        ...(Array.isArray(d.tv) ? d.tv : []),
        ...(Array.isArray(d.episodes) ? d.episodes : []),
        ...(Array.isArray(d.seasons) ? d.seasons : []),
      ];
    } else if (type === 'movie') {
      rawList = Array.isArray(d.movies) ? d.movies : [];
    } else {
      rawList = [
        ...(Array.isArray(d.movies) ? d.movies : []),
        ...(Array.isArray(d.shows) ? d.shows : []),
        ...(Array.isArray(d.series) ? d.series : []),
        ...(Array.isArray(d.tv) ? d.tv : []),
        ...(Array.isArray(d.episodes) ? d.episodes : []),
        ...(Array.isArray(d.seasons) ? d.seasons : []),
        ...(Array.isArray(d.results) ? d.results : []),
        ...(Array.isArray(d.items) ? d.items : []),
      ];
    }
    if (!rawList.length) {
      if (Array.isArray(d.results)) rawList = d.results;
      else if (Array.isArray(d.items)) rawList = d.items;
      else if (Array.isArray(d.movies) || Array.isArray(d.shows)) {
        rawList = [
          ...(Array.isArray(d.movies) ? d.movies : []),
          ...(Array.isArray(d.shows) ? d.shows : []),
          ...(Array.isArray(d.series) ? d.series : []),
          ...(Array.isArray(d.tv) ? d.tv : []),
          ...(Array.isArray(d.episodes) ? d.episodes : []),
          ...(Array.isArray(d.seasons) ? d.seasons : []),
        ];
      }
    }
  }

  const isMixed = !type || type === 'mixed' || type === 'unknown' || type === 'all';

  return rawList
    .map(extractMdblistItem)
    .filter(Boolean)
    .filter((it) => {
      if (isMixed) return true;
      const mt = it.mediatype;
      if (type === 'series') return mt === 'show' || mt === 'series' || mt === 'tv';
      return mt === 'movie' || mt === '' || mt === 'unknown';
    })
    .map((it) => {
      const posterFallbackId = (it.imdbId && it.imdbId.startsWith('tt')) ? it.imdbId : (it.id && it.id.startsWith('tt') ? it.id : '');
      const actualType = (it.mediatype === 'show' || it.mediatype === 'series' || it.mediatype === 'tv') ? 'series' : (it.mediatype === 'episode' ? 'episode' : 'movie');
      return {
        id: it.id,
        imdbId: it.imdbId,
        tmdbId: it.tmdbId,
        type: isMixed ? actualType : type,
        name: it.name,
        showTitle: it.showTitle,
        poster: it.poster || (posterFallbackId ? `https://images.metahub.space/poster/medium/${posterFallbackId}/img` : undefined),
        releaseInfo: it.releaseInfo,
        season: it.season,
        episode: it.episode,
        adult: it.adult === true || it.isAdult === true ? true : undefined,
        isAdult: it.adult === true || it.isAdult === true ? true : undefined,
        genres: it.genres,
        certification: it.certification,
        vote_average: it.vote_average,
        rating: it.rating,
      };
    });
}

// --- how big is this list, really? ------------------------------------------
//
// Trakt answers that in a header on every paginated endpoint
// (X-Pagination-Item-Count), and every fetcher below threw it away: fetchFn
// returned res.json() and the Response, headers and all, went out of scope. A
// chart of 303 titles therefore looked like exactly the 100 its first page
// carried, and every count built from that said 100 -- the Discover card's
// badge, the See All header -- until enough scrolling had paged the rest in,
// if it corrected at all.
//
// The count has to travel WITH the data rather than beside it. These replies
// are cached across three tiers (isolate memory, KV, the edge cache) and the
// two durable ones store JSON.stringify(payload), which silently drops a
// property hung on an array -- so the total would survive a memory hit and
// vanish on a KV hit, which is worse than not having it. The cached value is
// therefore { items, totalItems }, and every reader goes through the two
// accessors below, which still understand a bare array: that is what every
// entry cached before this shipped still holds.
const TRAKT_TOTAL_HEADER = "x-pagination-item-count";

function traktPayloadWithTotal(json, res) {
  let totalItems = null;
  try {
    const raw = res && res.headers ? res.headers.get(TRAKT_TOTAL_HEADER) : null;
    const n = raw == null ? NaN : Number(raw);
    if (Number.isFinite(n) && n >= 0) totalItems = n;
  } catch {
    // An endpoint that does not paginate (movies/boxoffice) sends no such
    // header, and neither does a cached copy written before this existed.
    // No total is the state this code was always in; it is not an error.
    totalItems = null;
  }
  return { items: json, totalItems };
}

// Both accessors take the payload as it comes back from the cache, which may
// be the wrapper above or the bare JSON an older entry holds.
function traktPayloadItems(payload) {
  if (payload && !Array.isArray(payload) && typeof payload === "object" &&
      "items" in payload && "totalItems" in payload) {
    return payload.items;
  }
  return payload;
}

function traktPayloadTotal(payload) {
  if (payload && !Array.isArray(payload) && typeof payload === "object") {
    const n = Number(payload.totalItems);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

// Hangs the collection's real size on a page of metas, the same way
// fetchMdblist and the TMDB fetchers already do -- /api/preview reads
// metas.totalItems and hands it to the browser as the list's size (see
// 25_api-catalog-routes.js). In-process only, so unlike the cached payload
// above there is no serialization to lose it.
function withTraktTotal(metas, totalItems) {
  if (totalItems != null && Array.isArray(metas)) metas.totalItems = totalItems;
  return metas;
}

async function fetchMdblist(entry, skip = 0, mdblistKey = "", env = null, ctx = null) {
  const src = mdblistJsonUrl(entry.url, mdblistKey, entry.type);
  if (!src) {
    throw new Error(
      "Couldn't parse that as an mdblist.com list URL (expected .../lists/user/listname)."
    );
  }

  const listId = await hashStringForKey(entry.url);
  const cacheKey = `user_cache:mdblist:list:v3:${listId}:${entry.type}:${skip}`;
  const kvKey = `mdblist:list:v3:${listId}:${entry.type}:${skip}`;

  return await fetchWithPerUserCacheAndCircuitBreaker({
    cacheKey,
    kvKey,
    env,
    ctx,
    freshTtlSec: 3600,
    staleTtlSec: 86400,
    kvTtlSec: 86400,
    providerLabel: "MDBList",
    fetchFn: async () => {
      let res = await fetch(src, {
        headers: { "User-Agent": `my-list-addon/${ADDON_VERSION}` },
        cf: { cacheTtl: 600, cacheEverything: true },
      });

      if (!res.ok) {
        if (res.status === 404) {
          throw new Error(
            "MDBList returned 404. Check that the user and list names match the URL on mdblist.com, and that the list is set to Public."
          );
        }
        const hint = res.status === 401 || res.status === 403 ? " Double-check your MDBList API key or connection." : "";
        throw new Error(`MDBList request failed (HTTP ${res.status}).${hint}`);
      }

      let data = await res.json();

      const metas = mapMdblistItems(data, entry.type);
      const total = metas.length;
      const enriched = await enrichTrailers(metas.slice(skip, skip + PAGE_SIZE), entry.type, TMDB_API_KEY);
      enriched.totalItems = total;
      return enriched;
    },
  });
}

// Pulls the user's watchlist from MDBList
async function fetchMdblistWatchlist(entry, skip = 0, mdblistKey = "", mdblistAccessToken = "") {
  const token = mdblistAccessToken || mdblistKey;
  if (!token) {
    throw new Error(
      "Your MDBList watchlist needs your connected MDBList account or API key."
    );
  }

  const headers = {
    "User-Agent": `my-list-addon/${ADDON_VERSION}`,
    "Accept": "application/json",
  };
  if (mdblistAccessToken) {
    headers["Authorization"] = `Bearer ${mdblistAccessToken}`;
  }
  if (mdblistKey) {
    headers["x-api-key"] = mdblistKey;
  }

  const authQuery = `?apikey=${encodeURIComponent(token)}`;
  const endpoints = [
    `https://api.mdblist.com/watchlist${authQuery}`,
    `https://api.mdblist.com/watchlist/items${authQuery}`,
    `https://api.mdblist.com/sync/watchlist${authQuery}`,
    `https://api.mdblist.com/lists/user${authQuery}`,
  ];

  let rawData = null;
  for (const ep of endpoints) {
    try {
      const res = await fetch(ep, {
        headers,
        cf: { cacheTtl: 120, cacheEverything: false },
      });
      if (res.ok) {
        const d = await res.json().catch(() => null);
        if (d) {
          if (ep.includes('/lists/user')) {
            const userLists = Array.isArray(d) ? d : (Array.isArray(d.lists) ? d.lists : []);
            const wlList = userLists.find(l => l && (l.slug === 'watchlist' || (l.name && l.name.toLowerCase() === 'watchlist') || l.is_watchlist || l.watchlist));
            if (wlList && wlList.id) {
              const itemsRes = await fetch(`https://api.mdblist.com/lists/${encodeURIComponent(wlList.id)}/items${authQuery}`, { headers }).catch(() => null);
              if (itemsRes && itemsRes.ok) {
                rawData = await itemsRes.json().catch(() => null);
                if (rawData) break;
              }
            }
          } else {
            const hasItems = Array.isArray(d) ? d.length > 0 : (d.movies?.length > 0 || d.shows?.length > 0 || d.results?.length > 0 || d.items?.length > 0 || d.watchlist);
            if (hasItems) {
              rawData = d;
              break;
            } else if (!rawData) {
              rawData = d;
            }
          }
        }
      }
    } catch (e) {}
  }

  const metas = mapMdblistItems(rawData, entry.type);
  const total = metas.length;
  const enriched = await enrichTrailers(metas.slice(skip, skip + PAGE_SIZE), entry.type, TMDB_API_KEY);
  enriched.totalItems = total;
  return enriched;
}

// Pulls the user's watched history from MDBList, paginated.
async function fetchMdblistHistory(entry, skip = 0, mdblistKey = "", mdblistAccessToken = "") {
  const token = mdblistAccessToken || mdblistKey;
  if (!token) {
    throw new Error(
      "Your MDBList watch history needs your connected MDBList account or API key."
    );
  }

  const headers = { "User-Agent": `my-list-addon/${ADDON_VERSION}`, "Accept": "application/json" };
  const authQuery = mdblistAccessToken ? "" : `?apikey=${encodeURIComponent(mdblistKey)}`;
  if (mdblistAccessToken) {
    headers["Authorization"] = `Bearer ${mdblistAccessToken}`;
  }

  const sep = authQuery ? "&" : "?";
  let allItems = [];

  // MDBList /sync/watched with mediatype query: movie, show, episode
  const mediatypesToTry = entry.type === 'series' ? ['show', 'episode'] : ['movie'];

  for (const mt of mediatypesToTry) {
    const url = `https://api.mdblist.com/sync/watched${authQuery}${sep}mediatype=${mt}&offset=${skip}&limit=${PAGE_SIZE}&append_to_response=poster`;
    try {
      const res = await fetch(url, {
        headers,
        cf: { cacheTtl: 60, cacheEverything: false },
      });
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data === 'object') {
          if (Array.isArray(data.movies) && data.movies.length) allItems.push(...data.movies);
          if (Array.isArray(data.shows) && data.shows.length) allItems.push(...data.shows);
          if (Array.isArray(data.episodes) && data.episodes.length) allItems.push(...data.episodes);
          if (Array.isArray(data.results) && data.results.length) allItems.push(...data.results);
          if (Array.isArray(data.items) && data.items.length) allItems.push(...data.items);
          if (Array.isArray(data) && data.length) allItems.push(...data);
        } else if (Array.isArray(data)) {
          allItems.push(...data);
        }
      }
    } catch {}
    if (allItems.length) break;
  }

  // Fallback to unfiltered sync/watched if mediatype query returned nothing
  if (!allItems.length) {
    try {
      const url = `https://api.mdblist.com/sync/watched${authQuery}${sep}offset=${skip}&limit=${PAGE_SIZE}&append_to_response=poster`;
      const res = await fetch(url, {
        headers,
        cf: { cacheTtl: 60, cacheEverything: false },
      });
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data === 'object') {
          if (entry.type === 'series') {
            if (Array.isArray(data.shows)) allItems.push(...data.shows);
            if (Array.isArray(data.episodes)) allItems.push(...data.episodes);
          } else {
            if (Array.isArray(data.movies)) allItems.push(...data.movies);
          }
          if (!allItems.length) {
            if (Array.isArray(data.results)) allItems.push(...data.results);
            else if (Array.isArray(data.items)) allItems.push(...data.items);
            else if (Array.isArray(data)) allItems.push(...data);
          }
        } else if (Array.isArray(data)) {
          allItems.push(...data);
        }
      }
    } catch {}
  }

  const metas = mapMdblistItems(allItems, entry.type);
  return enrichTrailers(metas.slice(0, PAGE_SIZE), entry.type, TMDB_API_KEY);
}

// Trakt's list-items endpoint returns an array of wrapper objects, each
// holding either a `movie` or a `show` object (depending on `type`) with
// its own `ids` block. We only care about entries that carry an IMDB id,
// since that's what wako/Stremio catalogs key off of.
//
// NOTE: unlike mdblist and TMDB, this doesn't get its own poster/backdrop
// preference -- Trakt's `images` extended data is gated behind a paid VIP
// account, which this add-on's fixed Client ID doesn't have. Metahub.space
// remains the only poster source for Trakt-sourced items.
// Trakt's list-items and most chart endpoints return an array of wrapper
// objects, each holding either a `movie` or a `show` object (depending on
// `type`) with its own `ids` block. A few endpoints (confirmed so far:
// /movies/popular and /shows/popular) instead return the movie/show fields
// directly at the top level with no wrapper at all -- `it.movie || it.show
// || it` handles both shapes: if neither wrapper key is present, it falls
// back to treating the item itself as the movie/show object.
function mapTraktItems(data, type) {
  const items = Array.isArray(data) ? data : [];
  const seen = new Set();
  const res = [];
  for (const it of items) {
    const obj = it.movie || it.show || it;
    if (!obj || !obj.ids) continue;
    const effectiveId = obj.ids.imdb || (obj.ids.tmdb ? `tmdb:${obj.ids.tmdb}` : "");
    if (!effectiveId || seen.has(effectiveId)) continue;
    seen.add(effectiveId);
    const isItemAdult = it.adult === true || obj.adult === true;
    const rawScore = typeof obj.rating === "number" ? obj.rating : (typeof it.rating === "number" ? it.rating : undefined);
    const traktScore = typeof rawScore === "number" && rawScore > 0 ? Math.round(rawScore * 10) / 10 : undefined;
    res.push({
      id: effectiveId,
      type: it.movie ? "movie" : (it.show ? "series" : type),
      name: obj.title,
      poster: effectiveId.startsWith("tt") ? `https://images.metahub.space/poster/medium/${effectiveId}/img` : undefined,
      releaseInfo: obj.year ? String(obj.year) : undefined,
      adult: isItemAdult ? true : undefined,
      isAdult: isItemAdult ? true : undefined,
      genres: it.genres || obj.genres || undefined,
      certification: it.certification || obj.certification || undefined,
      vote_average: traktScore,
      rating: traktScore,
      tmdbId: (obj.ids && obj.ids.tmdb) ? String(obj.ids.tmdb) : undefined,
      imdbId: (obj.ids && obj.ids.imdb) ? String(obj.ids.imdb) : (effectiveId.startsWith("tt") ? effectiveId : undefined),
    });
  }
  return res;
}

// Pulls a public trakt.tv list via the official REST API. Trakt paginates
// server-side (unlike mdblist, which we fetch in full and slice locally),
// so `skip` is translated into a page number using our fixed PAGE_SIZE as
// the page length — this only lines up cleanly if skip always arrives as a
// multiple of PAGE_SIZE, which is how wako/Stremio drive the `skip` extra.
// Every request — public or private — needs a Client ID; there's no
// Dispatches to the right backend based on what kind of URL was pasted in.
// `keys` is { mdblistKey, traktKey } — per-user keys decoded from their
// install link, if any. A key the user didn't supply falls back to the
// Worker-wide MDBLIST_API_KEY/TRAKT_CLIENT_ID constants at the top of the
// file.
async function fetchTrakt(entry, skip = 0, traktKey = "", accessToken = "", env = null, ctx = null) {
  if (!traktKey) {
    throw new Error(
      "Trakt lists aren't configured on this add-on yet — the Worker owner needs to set TRAKT_CLIENT_ID."
    );
  }

  const parsed = traktListPath(entry.url);
  if (!parsed) {
    throw new Error(
      "Couldn't parse that as a trakt.tv list URL (expected trakt.tv/users/USER/lists/LIST)."
    );
  }

  const itemKind = entry.type === "series" ? "shows,seasons,episodes" : (entry.type === "mixed" ? "" : "movies");
  const kindPath = itemKind ? `/${itemKind}` : "";
  const page = Math.floor(skip / PAGE_SIZE) + 1;
  const src = `https://api.trakt.tv/users/${encodeURIComponent(
    parsed.user
  )}/lists/${encodeURIComponent(parsed.list)}/items${kindPath}?limit=${PAGE_SIZE}&page=${page}&extended=full`;

  const headers = {
    "Content-Type": "application/json",
    "trakt-api-version": "2",
    "trakt-api-key": traktKey,
    "User-Agent": `my-list-addon/${ADDON_VERSION}`,
  };
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

  const userHash = accessToken ? safeUserHash(accessToken, parsed.user) : "public";
  const cacheKey = `user_cache:trakt:list:v2:${parsed.user}:${parsed.list}:${itemKind || "all"}:${skip}:${userHash}`;
  const kvKey = !accessToken ? `trakt:list:v2:${parsed.user}:${parsed.list}:${itemKind || "all"}:${page}` : "";

  const data = await fetchWithPerUserCacheAndCircuitBreaker({
    cacheKey,
    kvKey,
    env,
    ctx,
    freshTtlSec: accessToken ? 60 : 600,
    staleTtlSec: 86400,
    kvTtlSec: 86400,
    providerLabel: "Trakt List",
    fetchFn: async () => {
      let res = await fetchTraktWithRetry(src, {
        headers,
        cf: accessToken ? { cacheTtl: 0, cacheEverything: false } : { cacheTtl: 1200, cacheEverything: true },
      });
      if (!res.ok && accessToken && (res.status === 401 || res.status === 403)) {
        const pubHeaders = Object.assign({}, headers);
        delete pubHeaders["Authorization"];
        const pubRes = await fetchTraktWithRetry(src, {
          headers: pubHeaders,
          cf: { cacheTtl: 1200, cacheEverything: true },
        });
        if (pubRes.ok) {
          res = pubRes;
        }
      }
      if (!res.ok) {
        const hint =
          res.status === 404
            ? accessToken
              ? " If this is a private list, make sure you're connected as its owner (see Connect Trakt in Settings)."
              : " Double-check the list URL and that the list is public."
            : res.status === 401 || res.status === 403
            ? accessToken
              ? " Your Trakt connection may have expired (they last about 3 months) -- try reconnecting in Settings."
              : " Double-check your Trakt Client ID."
            : res.status === 429
            ? " Trakt is temporarily busy (rate limit). Please wait a few seconds and try again."
            : "";
        throw new Error(`Trakt request failed (HTTP ${res.status}).${hint}`);
      }
      return traktPayloadWithTotal(await res.json(), res);
    }
  });

  const metas = await enrichTrailers(mapTraktItems(traktPayloadItems(data), entry.type), entry.type, TMDB_API_KEY);
  return withTraktTotal(metas, traktPayloadTotal(data));
}

// Pulls the connected account's Trakt watchlist
async function fetchTraktWatchlist(entry, skip = 0, traktKey = "", accessToken = "", env = null, ctx = null) {
  if (!accessToken) {
    throw new Error(
      "Connect Trakt in Settings first — your watchlist needs your own Trakt sign-in, there's no public version of it."
    );
  }
  if (!traktKey) {
    throw new Error(
      "Trakt lists aren't configured on this add-on yet — the Worker owner needs to set TRAKT_CLIENT_ID."
    );
  }
  const itemKind = entry.type === "series" ? "shows" : "movies";
  const page = Math.floor(skip / PAGE_SIZE) + 1;
  const src = `https://api.trakt.tv/users/me/watchlist/${itemKind}?limit=${PAGE_SIZE}&page=${page}&extended=full`;

  const userHash = safeUserHash(accessToken);
  const cacheKey = `user_cache:trakt:watchlist:v2:${itemKind}:${skip}:${userHash}`;

  const data = await fetchWithPerUserCacheAndCircuitBreaker({
    cacheKey,
    kvKey: cacheKey,
    env,
    ctx,
    freshTtlSec: 60,
    staleTtlSec: 1800,
    kvTtlSec: 1800,
    providerLabel: "Trakt Watchlist",
    fetchFn: async () => {
      const res = await fetchTraktWithRetry(src, {
        headers: {
          "Content-Type": "application/json",
          "trakt-api-version": "2",
          "trakt-api-key": traktKey,
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": `my-list-addon/${ADDON_VERSION}`,
        },
        cf: { cacheTtl: 0, cacheEverything: false },
      });
      if (!res.ok) {
        const hint =
          res.status === 401 || res.status === 403
            ? " Your Trakt connection may have expired (they last about 3 months) -- try reconnecting in Settings."
            : res.status === 429
            ? " Trakt is temporarily busy (rate limit). Please wait a few seconds and try again."
            : "";
        throw new Error(`Trakt watchlist request failed (HTTP ${res.status}).${hint}`);
      }
      return traktPayloadWithTotal(await res.json(), res);
    }
  });

  const metas = await enrichTrailers(mapTraktItems(traktPayloadItems(data), entry.type), entry.type, TMDB_API_KEY);
  return withTraktTotal(metas, traktPayloadTotal(data));
}

// History's shape is different from a plain list/watchlist -- each row is
// { watched_at, action, movie } or { watched_at, action, episode, show }
// instead of the { movie } / { show } wrapper mapTraktItems expects.
function mapTraktHistoryItems(data, type) {
  const items = Array.isArray(data) ? data : [];
  const watchedLabel = (watchedAt) => {
    if (!watchedAt) return undefined;
    const d = new Date(watchedAt);
    return isNaN(d) ? undefined : d.toISOString().slice(0, 10);
  };
  if (type === "series") {
    return items
      .map((it) => {
        if (!it) return null;
        const show = it.show || (it.episode && it.episode.show) || it;
        const ep = it.episode || it;
        const ids = (show && show.ids) || (ep && ep.ids) || it.ids || {};
        const imdbId = ids.imdb || (ids.tmdb ? `tmdb:${ids.tmdb}` : null);
        if (!imdbId) return null;
        const s = ep.season;
        const e = ep.number;
        const epTitle = ep.title ? ` \u2014 ${ep.title}` : "";
        const showTitle = show.title || it.title || "Show";
        const seasonEpStr = (s != null && e != null) ? ` S${s}E${e}` : "";
        return {
          id: imdbId,
          type: "series",
          name: `${showTitle}${seasonEpStr}${epTitle}`,
          showTitle: showTitle,
          poster: String(imdbId).startsWith("tt") ? `https://images.metahub.space/poster/medium/${imdbId}/img` : undefined,
          releaseInfo: watchedLabel(it.watched_at),
        };
      })
      .filter(Boolean);
  }
  if (type === "mixed") {
    return items
      .map((it) => {
        if (!it) return null;
        const isEpisode = !!(it.episode || it.type === "episode" || (it.show && !it.movie));
        if (isEpisode) {
          const show = it.show || (it.episode && it.episode.show) || it;
          const ep = it.episode || it;
          const ids = (show && show.ids) || (ep && ep.ids) || it.ids || {};
          const imdbId = ids.imdb || (ids.tmdb ? `tmdb:${ids.tmdb}` : null);
          if (!imdbId) return null;
          const s = ep.season;
          const e = ep.number;
          const epTitle = ep.title ? ` \u2014 ${ep.title}` : "";
          const showTitle = show.title || it.title || "Show";
          const seasonEpStr = (s != null && e != null) ? ` S${s}E${e}` : "";
          return {
            id: imdbId,
            type: "series",
            name: `${showTitle}${seasonEpStr}${epTitle}`,
            showTitle: showTitle,
            poster: String(imdbId).startsWith("tt") ? `https://images.metahub.space/poster/medium/${imdbId}/img` : undefined,
            releaseInfo: watchedLabel(it.watched_at),
          };
        }
        const movie = it.movie || it;
        const ids = (movie && movie.ids) || it.ids || {};
        const imdbId = ids.imdb || (ids.tmdb ? `tmdb:${ids.tmdb}` : null);
        if (!imdbId) return null;
        return {
          id: imdbId,
          type: "movie",
          name: movie.title || it.title || "Movie",
          poster: String(imdbId).startsWith("tt") ? `https://images.metahub.space/poster/medium/${imdbId}/img` : undefined,
          releaseInfo: watchedLabel(it.watched_at) || (movie.year ? String(movie.year) : undefined),
        };
      })
      .filter(Boolean);
  }
  return items
    .map((it) => {
      if (!it) return null;
      const movie = it.movie || it;
      const ids = (movie && movie.ids) || it.ids || {};
      const imdbId = ids.imdb || (ids.tmdb ? `tmdb:${ids.tmdb}` : null);
      if (!imdbId) return null;
      return {
        id: imdbId,
        type: "movie",
        name: movie.title || it.title || "Movie",
        poster: String(imdbId).startsWith("tt") ? `https://images.metahub.space/poster/medium/${imdbId}/img` : undefined,
        releaseInfo: watchedLabel(it.watched_at) || (movie.year ? String(movie.year) : undefined),
      };
    })
    .filter(Boolean);
}

// Pulls the connected account's Trakt watch history
async function fetchTraktHistory(entry, skip = 0, traktKey = "", accessToken = "", env = null, ctx = null) {
  if (!accessToken) {
    throw new Error(
      "Connect Trakt in Settings first — your watch history needs your own Trakt sign-in, there's no public version of it."
    );
  }
  if (!traktKey) {
    throw new Error(
      "Trakt lists aren't configured on this add-on yet — the Worker owner needs to set TRAKT_CLIENT_ID."
    );
  }
  const itemKind = entry.type === "series" ? "episodes" : (entry.type === "mixed" ? "" : "movies");
  const pathKind = itemKind ? `/${itemKind}` : "";
  const page = Math.floor(skip / PAGE_SIZE) + 1;
  const src = `https://api.trakt.tv/users/me/history${pathKind}?limit=${PAGE_SIZE}&page=${page}&extended=full`;

  const userHash = safeUserHash(accessToken);
  const cacheKey = `user_cache:trakt:history:v2:${itemKind || "mixed"}:${skip}:${userHash}`;

  const data = await fetchWithPerUserCacheAndCircuitBreaker({
    cacheKey,
    kvKey: cacheKey,
    env,
    ctx,
    freshTtlSec: 60,
    staleTtlSec: 1800,
    kvTtlSec: 1800,
    providerLabel: "Trakt History",
    fetchFn: async () => {
      const res = await fetchTraktWithRetry(src, {
        headers: {
          "Content-Type": "application/json",
          "trakt-api-version": "2",
          "trakt-api-key": traktKey,
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": `my-list-addon/${ADDON_VERSION}`,
        },
        cf: { cacheTtl: 0, cacheEverything: false },
      });
      if (!res.ok) {
        const hint =
          res.status === 401 || res.status === 403
            ? " Your Trakt connection may have expired (they last about 3 months) -- try reconnecting in Settings."
            : res.status === 429
            ? " Trakt is temporarily busy (rate limit). Please wait a few seconds and try again."
            : "";
        throw new Error(`Trakt history request failed (HTTP ${res.status}).${hint}`);
      }
      return traktPayloadWithTotal(await res.json(), res);
    }
  });

  const metas = await enrichTrailers(mapTraktHistoryItems(traktPayloadItems(data), entry.type), entry.type, TMDB_API_KEY);
  return withTraktTotal(metas, traktPayloadTotal(data));
}

// Pulls the connected account's Trakt Airing Next shows
async function fetchTraktAiringNext(entry, skip = 0, traktKey = "", accessToken = "", tmdbApiKey = "", env = null, ctx = null) {
  if (!accessToken) {
    throw new Error(
      "Connect Trakt in Settings first — your Airing Next shelf needs your Trakt sign-in."
    );
  }
  if (!traktKey) {
    throw new Error(
      "Trakt isn't configured on this add-on yet — the Worker owner needs to set TRAKT_CLIENT_ID."
    );
  }

  const tmdbKey = tmdbApiKey || TMDB_API_KEY;
  const userHash = safeUserHash(accessToken);
  const cacheKey = `user_cache:trakt:airing_next:${skip}:${userHash}`;

  return await fetchWithPerUserCacheAndCircuitBreaker({
    cacheKey,
    kvKey: cacheKey,
    env,
    ctx,
    freshTtlSec: 300,
    staleTtlSec: 3600,
    kvTtlSec: 3600,
    providerLabel: "Trakt Airing Next",
    fetchFn: async () => {
      const headers = {
        "Content-Type": "application/json",
        "trakt-api-version": "2",
        "trakt-api-key": traktKey,
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": `my-list-addon/${ADDON_VERSION}`,
      };

      const d0 = new Date();
      const today = d0.toISOString().slice(0, 10);
      const d1 = new Date(d0.getTime() + 33 * 86400000).toISOString().slice(0, 10);
      const d2 = new Date(d0.getTime() + 66 * 86400000).toISOString().slice(0, 10);
      const d3 = new Date(d0.getTime() + 99 * 86400000).toISOString().slice(0, 10);
      try {
        const calResults = await Promise.all([
          fetchTraktWithRetry(`https://api.trakt.tv/calendars/my/shows/${today}/33`, {
            headers,
            cf: { cacheTtl: 300, cacheEverything: false },
          }).catch(() => null),
          fetchTraktWithRetry(`https://api.trakt.tv/calendars/my/shows/${d1}/33`, {
            headers,
            cf: { cacheTtl: 300, cacheEverything: false },
          }).catch(() => null),
          fetchTraktWithRetry(`https://api.trakt.tv/calendars/my/shows/${d2}/33`, {
            headers,
            cf: { cacheTtl: 300, cacheEverything: false },
          }).catch(() => null),
          fetchTraktWithRetry(`https://api.trakt.tv/calendars/my/shows/${d3}/33`, {
            headers,
            cf: { cacheTtl: 300, cacheEverything: false },
          }).catch(() => null),
        ]);

        const seen = new Set();
        const calMetas = [];
        for (const calRes of calResults) {
          if (!calRes || !calRes.ok) continue;
          const calData = await calRes.json().catch(() => []);
          if (Array.isArray(calData) && calData.length > 0) {
            for (const item of calData) {
              if (!item) continue;
              const show = item.show || {};
              const ep = item.episode || {};
              const ids = show.ids || {};
              const imdbId = ids.imdb || "";
              const tmdbId = ids.tmdb || "";
              const bestId = (imdbId && imdbId.startsWith("tt")) ? imdbId : (tmdbId ? `tmdb:${tmdbId}` : (ids.trakt ? String(ids.trakt) : ""));
              if (!bestId || seen.has(bestId)) continue;
              seen.add(bestId);

              const rawAir = item.first_aired || ep.first_aired || "";
              const airDate = rawAir ? rawAir.slice(0, 10) : "";
              const isPremiere = ep.number === 1;
              const sNum = ep.season != null ? `S${String(ep.season).padStart(2, "0")}` : "";
              const eNum = ep.number != null ? `E${String(ep.number).padStart(2, "0")}` : "";
              const epLabel = sNum && eNum ? `${sNum}${eNum}` : "";
              const poster = (imdbId && imdbId.startsWith("tt")) ? `https://images.metahub.space/poster/medium/${imdbId}/img` : (tmdbId ? `https://image.tmdb.org/t/p/w500${tmdbId}` : "");

              calMetas.push({
                id: bestId,
                type: "series",
                name: show.title || "Show",
                poster: poster || undefined,
                airDate: airDate || undefined,
                isSeasonPremiere: isPremiere,
                season: ep.season != null ? ep.season : undefined,
                episode: ep.number != null ? ep.number : undefined,
                seasonNum: ep.season != null ? ep.season : undefined,
                episodeNum: ep.number != null ? ep.number : undefined,
                description: epLabel ? `Next Episode: ${epLabel}${ep.title ? ` — ${ep.title}` : ""} · Airs ${airDate}` : undefined,
              });
            }
          }
        }

        if (calMetas.length > 0) {
          calMetas.sort((a, b) => (a.airDate || "").localeCompare(b.airDate || ""));
          const enriched = await enrichTrailers(calMetas.slice(skip, skip + PAGE_SIZE), "series", tmdbKey);
          return withTraktTotal(enriched, calMetas.length);
        }
      } catch {}

      const [watchedRes, watchlistRes] = await Promise.all([
        fetchTraktWithRetry("https://api.trakt.tv/users/me/watched/shows?extended=noseasons", {
          headers,
          cf: { cacheTtl: 60, cacheEverything: false },
        }).catch(() => null),
        fetchTraktWithRetry("https://api.trakt.tv/users/me/watchlist/shows?limit=50", {
          headers,
          cf: { cacheTtl: 60, cacheEverything: false },
        }).catch(() => null),
      ]);

      const candidateShows = [];
      if (watchedRes && watchedRes.ok) {
        try {
          const wData = await watchedRes.json();
          if (Array.isArray(wData)) candidateShows.push(...wData);
        } catch {}
      }
      if (watchlistRes && watchlistRes.ok) {
        try {
          const wlData = await watchlistRes.json();
          if (Array.isArray(wlData)) candidateShows.push(...wlData);
        } catch {}
      }

      candidateShows.sort((a, b) => {
        const aTime = a.last_watched_at ? new Date(a.last_watched_at).getTime() : 0;
        const bTime = b.last_watched_at ? new Date(b.last_watched_at).getTime() : 0;
        return bTime - aTime;
      });

      const seen = new Set();
      const candidateMetas = [];
      candidateShows.forEach((it) => {
        const show = it.show || it;
        if (show && show.ids) {
          const imdbId = show.ids.imdb || "";
          const tmdbId = show.ids.tmdb || "";
          const id = imdbId || (tmdbId ? `tmdb:${tmdbId}` : "");
          if (id && !seen.has(id)) {
            seen.add(id);
            candidateMetas.push({
              id,
              imdbId,
              tmdbId,
              name: show.title || "",
              poster: imdbId ? `https://images.metahub.space/poster/medium/${imdbId}/img` : "",
              year: show.year ? String(show.year) : undefined,
            });
          }
        }
      });

      const airingMetas = [];
      await mapWithConcurrency(candidateMetas.slice(0, 12), 4, async (item) => {
        try {
          const details = await fetchTmdbItemDetails(item.id, tmdbKey, "series", "", false, env, ctx);
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
    },
  });
}

// Pulls the connected account's MDBList Airing Next shows
async function fetchMdblistAiringNext(entry, skip = 0, mdblistKey = "", mdblistAccessToken = "", tmdbApiKey = "", env = null, ctx = null) {
  const token = mdblistAccessToken || mdblistKey;
  if (!token) {
    throw new Error(
      "Your MDBList Airing Next needs your connected MDBList account or API key."
    );
  }

  const tmdbKey = tmdbApiKey || TMDB_API_KEY;
  const authQuery = mdblistAccessToken ? "" : `?apikey=${encodeURIComponent(mdblistKey)}`;
  const headers = { "User-Agent": `my-list-addon/${ADDON_VERSION}`, "Accept": "application/json" };
  if (mdblistAccessToken) headers["Authorization"] = `Bearer ${mdblistAccessToken}`;

  const cacheKey = `user_cache:mdblist:airing_next:${skip}:${safeUserHash(token)}`;

  return await fetchWithPerUserCacheAndCircuitBreaker({
    cacheKey,
    kvKey: cacheKey,
    env,
    ctx,
    freshTtlSec: 300,
    staleTtlSec: 3600,
    kvTtlSec: 3600,
    providerLabel: "MDBList Airing Next",
    fetchFn: async () => {
      const sep = authQuery ? "&" : "?";
      const [showsRes, episodesRes, watchlistRes] = await Promise.all([
        fetch(`https://api.mdblist.com/sync/watched${authQuery}${sep}mediatype=show&limit=50&append_to_response=poster`, {
          headers,
          cf: { cacheTtl: 60, cacheEverything: false },
        }).catch(() => null),
        fetch(`https://api.mdblist.com/sync/watched${authQuery}${sep}mediatype=episode&limit=50&append_to_response=poster`, {
          headers,
          cf: { cacheTtl: 60, cacheEverything: false },
        }).catch(() => null),
        fetch(`https://api.mdblist.com/watchlist${authQuery}`, {
          headers,
          cf: { cacheTtl: 300, cacheEverything: true },
        }).catch(() => null),
      ]);

      const rawItems = [];
      if (showsRes && showsRes.ok) {
        try {
          const d = await showsRes.json();
          if (Array.isArray(d)) rawItems.push(...d);
          else if (d && Array.isArray(d.shows)) rawItems.push(...d.shows);
          else if (d && Array.isArray(d.results)) rawItems.push(...d.results);
        } catch {}
      }
      if (episodesRes && episodesRes.ok) {
        try {
          const d = await episodesRes.json();
          if (Array.isArray(d)) rawItems.push(...d);
          else if (d && Array.isArray(d.episodes)) rawItems.push(...d.episodes);
          else if (d && Array.isArray(d.results)) rawItems.push(...d.results);
        } catch {}
      }
      if (watchlistRes && watchlistRes.ok) {
        try {
          const d = await watchlistRes.json();
          if (Array.isArray(d)) rawItems.push(...d);
          else if (d && Array.isArray(d.shows)) rawItems.push(...d.shows);
          else if (d && Array.isArray(d.results)) rawItems.push(...d.results);
        } catch {}
      }

      const seen = new Set();
      const candidateMetas = [];
      rawItems.forEach((it) => {
        const extracted = extractMdblistItem(it);
        if (extracted && extracted.mediatype === "series") {
          const id = extracted.id;
          if (id && !seen.has(id)) {
            seen.add(id);
            candidateMetas.push({
              id,
              imdbId: extracted.imdbId || "",
              tmdbId: extracted.tmdbId || "",
              name: extracted.showTitle || extracted.name || "",
              poster: extracted.poster || (extracted.imdbId ? `https://images.metahub.space/poster/medium/${extracted.imdbId}/img` : ""),
              year: extracted.releaseInfo,
            });
          }
        }
      });

      const airingMetas = [];
      await mapWithConcurrency(candidateMetas.slice(0, 90), 6, async (item) => {
        try {
          const details = await fetchTmdbItemDetails(item.id, tmdbKey, "series", "", false, env, ctx);
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
    },
  });
}

// Pulls the connected account's MDBList Up Next shows
async function fetchMdblistUpNext(entry, skip = 0, mdblistKey = "", mdblistAccessToken = "", tmdbApiKey = "", env = null, ctx = null) {
  const token = mdblistAccessToken || mdblistKey;
  if (!token) {
    throw new Error(
      "Your MDBList Up Next needs your connected MDBList account or API key."
    );
  }

  const authQuery = mdblistAccessToken ? "" : `?apikey=${encodeURIComponent(mdblistKey)}`;
  const headers = { "User-Agent": `my-list-addon/${ADDON_VERSION}`, "Accept": "application/json" };
  if (mdblistAccessToken) headers["Authorization"] = `Bearer ${mdblistAccessToken}`;

  const cacheKey = `user_cache:mdblist:upnext:${skip}:${safeUserHash(token)}`;

  return await fetchWithPerUserCacheAndCircuitBreaker({
    cacheKey,
    kvKey: cacheKey,
    env,
    ctx,
    freshTtlSec: 60,
    staleTtlSec: 1800,
    kvTtlSec: 1800,
    providerLabel: "MDBList Up Next",
    fetchFn: async () => {
      const sep = authQuery ? "&" : "?";
      const res = await fetch(`https://api.mdblist.com/upnext${authQuery}${sep}limit=50&hide_unreleased=true&append_to_response=poster`, {
        headers,
        cf: { cacheTtl: 0, cacheEverything: false },
      }).catch(() => null);

      if (!res || !res.ok) {
        const hint = res && (res.status === 401 || res.status === 403)
          ? " Double-check your MDBList API key or connection in Settings."
          : (res && res.status === 429 ? " MDBList is temporarily busy (rate limit). Please wait a few seconds and try again." : "");
        throw new Error(`MDBList Up Next request failed (${res ? 'HTTP ' + res.status : 'network error'}).${hint}`);
      }

      const d = await res.json().catch(() => null);
      const rawItems = Array.isArray(d) ? d : (d && Array.isArray(d.items) ? d.items : (d && Array.isArray(d.results) ? d.results : []));

      const metas = [];
      for (const it of rawItems) {
        if (!it) continue;
        const extracted = extractMdblistItem(it);
        const nextEp = it.next_episode || (extracted && extracted.nextEpisode) || null;
        const imdbId = it.imdb_id || (extracted && extracted.imdbId) || (typeof it.id === "string" && it.id.startsWith("tt") ? it.id : null);
        const tmdbId = it.tmdb_id || (extracted && extracted.tmdbId) || null;
        const bestId = (imdbId && imdbId.startsWith("tt")) ? imdbId : ((extracted && extracted.id) || (tmdbId ? `tmdb:${tmdbId}` : String(it.id)));
        if (!bestId) continue;

        const showTitle = it.title || it.name || (extracted && (extracted.showTitle || extracted.name)) || "Show";
        const sNum = nextEp ? (nextEp.season != null ? nextEp.season : 1) : null;
        const eNum = nextEp ? (nextEp.episode != null ? nextEp.episode : (nextEp.number != null ? nextEp.number : 1)) : null;
        const epTitle = nextEp ? (nextEp.title || nextEp.name ? ` \u2014 ${nextEp.title || nextEp.name}` : "") : "";
        const sEpStr = (sNum != null && eNum != null) ? ` S${sNum}E${eNum}` : "";
        const fullName = `${showTitle}${sEpStr}${epTitle}`;
        let p = it.poster || (extracted && extracted.poster) || '';
        if (typeof p === 'string' && p.startsWith('/')) {
          p = 'https://image.tmdb.org/t/p/w500' + p;
        }
        if (!p && imdbId && String(imdbId).startsWith('tt')) {
          p = `https://images.metahub.space/poster/medium/${imdbId}/img`;
        }
        const poster = p || undefined;

        metas.push({
          id: bestId,
          type: "series",
          name: fullName,
          showTitle: showTitle,
          poster: poster,
          releaseInfo: it.year ? String(it.year) : (extracted && extracted.releaseInfo ? String(extracted.releaseInfo) : undefined),
          season: sNum || undefined,
          episode: eNum || undefined,
          description: nextEp && nextEp.air_date ? `Next Episode: S${sNum}E${eNum}${epTitle} · Airs ${nextEp.air_date}` : undefined,
        });
      }

      const enriched = await enrichTrailers(metas.slice(skip, skip + PAGE_SIZE), "series", TMDB_API_KEY);
      enriched.totalItems = metas.length;
      return enriched;
    },
  });
}

// Pulls the connected account's Trakt Continue Watching / Playback sessions
async function fetchTraktContinueWatching(entry, skip = 0, traktKey = "", accessToken = "", env = null, ctx = null) {
  if (!accessToken) {
    throw new Error(
      "Connect Trakt in Settings first — your continue watching shelf needs your own Trakt sign-in, there's no public version of it."
    );
  }
  if (!traktKey) {
    throw new Error(
      "Trakt lists aren't configured on this add-on yet — the Worker owner needs to set TRAKT_CLIENT_ID."
    );
  }

  const userHash = safeUserHash(accessToken);
  const typeFilter = entry.type === "series" ? "episodes" : (entry.type === "movie" ? "movies" : "");
  const typePath = typeFilter ? `/${typeFilter}` : "";
  const cacheKey = `user_cache:trakt:continue_watching:${entry.type || "mixed"}:${skip}:${userHash}`;

  const data = await fetchWithPerUserCacheAndCircuitBreaker({
    cacheKey,
    kvKey: cacheKey,
    env,
    ctx,
    freshTtlSec: 30,
    staleTtlSec: 600,
    kvTtlSec: 600,
    providerLabel: "Trakt Continue Watching",
    fetchFn: async () => {
      const headers = {
        "Content-Type": "application/json",
        "trakt-api-version": "2",
        "trakt-api-key": traktKey,
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": `my-list-addon/${ADDON_VERSION}`,
      };
      const [pbRes, watchedRes, hProgRes, hDroppedRes, hResetRes] = await Promise.all([
        fetchTraktWithRetry(`https://api.trakt.tv/sync/playback${typePath}?limit=50`, {
          headers,
          cf: { cacheTtl: 0, cacheEverything: false },
        }).catch(() => null),
        entry.type !== "movie"
          ? fetchTraktWithRetry("https://api.trakt.tv/users/me/watched/shows?extended=noseasons", {
              headers,
              cf: { cacheTtl: 60, cacheEverything: false },
            }).catch(() => null)
          : Promise.resolve(null),
        fetchTraktWithRetry("https://api.trakt.tv/users/hidden/progress_watched?type=show&limit=100", {
          headers,
          cf: { cacheTtl: 300, cacheEverything: false },
        }).catch(() => null),
        fetchTraktWithRetry("https://api.trakt.tv/users/hidden/dropped?type=show&limit=100", {
          headers,
          cf: { cacheTtl: 300, cacheEverything: false },
        }).catch(() => null),
        fetchTraktWithRetry("https://api.trakt.tv/users/hidden/progress_watched_reset?type=show&limit=100", {
          headers,
          cf: { cacheTtl: 300, cacheEverything: false },
        }).catch(() => null),
      ]);
      if (pbRes && (pbRes.status === 401 || pbRes.status === 403)) {
        throw new Error("Your Trakt connection may have expired (they last about 3 months) -- try reconnecting in Settings.");
      }
      if (pbRes && pbRes.status === 429) {
        throw new Error("Trakt is temporarily busy (rate limit). Please wait a few seconds and try again.");
      }

      const hiddenShowKeys = new Set();
      for (const hRes of [hProgRes, hDroppedRes, hResetRes]) {
        if (hRes && hRes.ok) {
          const hData = await hRes.json().catch(() => []);
          if (Array.isArray(hData)) {
            for (const item of hData) {
              if (!item) continue;
              const s = item.show || item.movie || item;
              const ids = s.ids || item.ids || {};
              if (ids.trakt) hiddenShowKeys.add(String(ids.trakt));
              if (ids.imdb) hiddenShowKeys.add(String(ids.imdb).toLowerCase());
              if (ids.tmdb) hiddenShowKeys.add(String(ids.tmdb));
              if (ids.slug) hiddenShowKeys.add(String(ids.slug).toLowerCase());
              if (s.title) hiddenShowKeys.add(String(s.title).toLowerCase().trim());
            }
          }
        }
      }

      function isHiddenShow(sObj, idObj) {
        if (!sObj && !idObj) return false;
        const ids = idObj || (sObj && sObj.ids) || {};
        if (ids.trakt && hiddenShowKeys.has(String(ids.trakt))) return true;
        if (ids.imdb && hiddenShowKeys.has(String(ids.imdb).toLowerCase())) return true;
        if (ids.tmdb && hiddenShowKeys.has(String(ids.tmdb))) return true;
        if (ids.slug && hiddenShowKeys.has(String(ids.slug).toLowerCase())) return true;
        if (sObj && sObj.title && hiddenShowKeys.has(String(sObj.title).toLowerCase().trim())) return true;
        return false;
      }

      const rawPb = (pbRes && pbRes.ok) ? await pbRes.json().catch(() => []) : [];
      const playbackItems = (Array.isArray(rawPb) ? rawPb : []).filter((it) => {
        if (!it) return false;
        const isEp = it.type === "episode" || !!it.episode;
        const show = it.show || (it.episode && it.episode.show) || {};
        const mov = it.movie || {};
        const inner = isEp ? show : mov;
        const ids = (isEp ? (show.ids || it.episode?.ids) : mov.ids) || {};
        return !isHiddenShow(inner, ids);
      });

      const seenShowIds = new Set();
      for (const it of playbackItems) {
        if (!it) continue;
        const show = it.show || (it.episode && it.episode.show) || {};
        const sIds = show.ids || (it.episode && it.episode.ids) || {};
        if (sIds.trakt) seenShowIds.add(String(sIds.trakt));
        if (sIds.imdb) seenShowIds.add(String(sIds.imdb).toLowerCase());
        if (sIds.tmdb) seenShowIds.add(String(sIds.tmdb));
        if (sIds.slug) seenShowIds.add(String(sIds.slug).toLowerCase());
      }

      let upNextItems = [];
      if (watchedRes && watchedRes.ok) {
        const wData = await watchedRes.json().catch(() => []);
        const rawWatched = Array.isArray(wData) ? wData : [];
        const sorted = rawWatched
          .filter((it) => it && it.show && it.show.ids)
          .sort((a, b) => new Date(b.last_watched_at || 0) - new Date(a.last_watched_at || 0));

        const candidates = sorted
          .filter((it) => {
            const ids = (it.show && it.show.ids) || {};
            if (isHiddenShow(it.show, ids)) return false;
            const hasPb = (ids.trakt && seenShowIds.has(String(ids.trakt))) ||
                          (ids.imdb && seenShowIds.has(String(ids.imdb).toLowerCase())) ||
                          (ids.tmdb && seenShowIds.has(String(ids.tmdb))) ||
                          (ids.slug && seenShowIds.has(String(ids.slug).toLowerCase()));
            return !hasPb;
          })
          .slice(0, 15);

        const progResults = [];
        await mapWithConcurrency(candidates, 5, async (c) => {
          const show = c.show;
          const showKey = show.ids.trakt || show.ids.imdb || show.ids.slug;
          if (!showKey) return;
          try {
            const pRes = await fetchTraktWithRetry(`https://api.trakt.tv/shows/${encodeURIComponent(showKey)}/progress/watched?last_activity=watched&hidden=false&specials=false&count_specials=false`, {
              headers,
              cf: { cacheTtl: 60, cacheEverything: false },
            });
            if (!pRes.ok) return;
            const prog = await pRes.json();
            if (!prog) return;

            const aired = typeof prog.aired === "number" ? prog.aired : 0;
            const completed = typeof prog.completed === "number" ? prog.completed : 0;
            const now = new Date();

            let nextEp = prog.next_episode || null;
            const isNextEpUnaired = nextEp && nextEp.first_aired && new Date(nextEp.first_aired) > now;

            // If nextEp points to a future unaired episode or is missing, but user hasn't finished all aired episodes:
            // search prog.seasons for the earliest uncompleted aired episode (handles FBI S01E02!)
            if ((!nextEp || isNextEpUnaired) && completed < aired && Array.isArray(prog.seasons)) {
              for (const s of prog.seasons) {
                if (s.number > 0 && s.completed < s.aired && Array.isArray(s.episodes)) {
                  const unwatched = s.episodes.find((ep) => !ep.completed);
                  if (unwatched) {
                    nextEp = {
                      season: s.number,
                      number: unwatched.number,
                      title: unwatched.title || "",
                      first_aired: unwatched.first_aired || null,
                    };
                    break;
                  }
                }
              }
            }

            // An episode belongs in Continue Watching ONLY if it has already aired AND user hasn't completed all aired episodes:
            const hasAiredUnwatched = nextEp && (!nextEp.first_aired || new Date(nextEp.first_aired) <= now) && (completed < aired || !prog.aired);

            if (hasAiredUnwatched) {
              progResults.push({
                type: "episode",
                show: show,
                episode: nextEp,
                progress: 0,
                last_watched_at: prog.last_watched_at || c.last_watched_at || null,
              });
            }
          } catch {}
        });
        upNextItems = progResults;
      }

      const combined = [...playbackItems, ...upNextItems];
      return traktPayloadWithTotal(combined, pbRes);
    }
  });

  const rawItems = traktPayloadItems(data);
  const items = Array.isArray(rawItems) ? rawItems : [];
  const metas = items
    .map((it) => {
      if (!it) return null;
      const isEp = it.type === "episode" || !!it.episode;
      const isMovie = it.type === "movie" || !!it.movie;
      if (entry.type === "series" && !isEp && it.type !== "show" && !it.show) return null;
      if (entry.type === "movie" && (!isMovie || isEp)) return null;

      const progressPct = typeof it.progress === "number" ? Math.round(it.progress) : 0;
      if (isEp) {
        const show = it.show || (it.episode && it.episode.show) || {};
        const ep = it.episode || {};
        const ids = show.ids || ep.ids || it.ids || {};
        const imdbId = ids.imdb || (ids.tmdb ? `tmdb:${ids.tmdb}` : null);
        if (!imdbId) return null;
        const s = ep.season;
        const e = ep.number;
        const epTitle = ep.title ? ` \u2014 ${ep.title}` : "";
        const showTitle = show.title || "Show";
        const seasonEpStr = (s != null && e != null) ? ` S${s}E${e}` : "";
        return {
          id: imdbId,
          type: "series",
          name: `${showTitle}${seasonEpStr}${epTitle}`,
          showTitle: showTitle,
          poster: String(imdbId).startsWith("tt") ? `https://images.metahub.space/poster/medium/${imdbId}/img` : (ids.tmdb ? `https://image.tmdb.org/t/p/w500${ids.tmdb}` : undefined),
          releaseInfo: progressPct > 0 ? `${progressPct}%` : undefined,
          season: s != null ? s : undefined,
          episode: e != null ? e : undefined,
          seasonNum: s != null ? s : undefined,
          episodeNum: e != null ? e : undefined,
          progress: progressPct,
          description: progressPct > 0 ? `${progressPct}% completed` : undefined,
        };
      }
      const movie = it.movie || it;
      const ids = movie.ids || it.ids || {};
      const imdbId = ids.imdb || (ids.tmdb ? `tmdb:${ids.tmdb}` : null);
      if (!imdbId) return null;
      return {
        id: imdbId,
        type: "movie",
        name: movie.title || "Movie",
        poster: String(imdbId).startsWith("tt") ? `https://images.metahub.space/poster/medium/${imdbId}/img` : (ids.tmdb ? `https://image.tmdb.org/t/p/w500${ids.tmdb}` : undefined),
        releaseInfo: progressPct > 0 ? `${progressPct}%` : (movie.year ? String(movie.year) : undefined),
        progress: progressPct,
        description: progressPct > 0 ? `${progressPct}% completed` : undefined,
      };
    })
    .filter(Boolean);

  const sliced = metas.slice(skip, skip + PAGE_SIZE);
  const enriched = await enrichTrailers(sliced, entry.type || "mixed", TMDB_API_KEY);
  return withTraktTotal(enriched, metas.length);
}



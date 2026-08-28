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
  const showPoster = inner.poster || it.poster || (rawImdb ? `https://images.metahub.space/poster/medium/${rawImdb}/img` : undefined);
  const poster = isEpisode ? (ep && (ep.poster || ep.still) || showPoster) : showPoster;
  const releaseYear = inner.release_year || inner.year || it.release_year || it.year || undefined;
  return {
    id: rawId,
    imdbId: rawImdb || undefined,
    tmdbId: rawTmdb ? String(rawTmdb) : undefined,
    mediatype: mt,
    name,
    showTitle,
    poster,
    releaseInfo: releaseYear ? String(releaseYear) : undefined,
    season: ep ? (ep.season || 1) : undefined,
    episode: ep ? (ep.number || ep.episode || 1) : undefined,
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
        type: isMixed ? actualType : type,
        name: it.name,
        showTitle: it.showTitle,
        poster: it.poster || (posterFallbackId ? `https://images.metahub.space/poster/medium/${posterFallbackId}/img` : undefined),
        releaseInfo: it.releaseInfo,
        season: it.season,
        episode: it.episode,
      };
    });
}

async function fetchMdblist(entry, skip = 0, mdblistKey = "", env = null, ctx = null) {
  const src = mdblistJsonUrl(entry.url, mdblistKey);
  if (!src) {
    throw new Error(
      "Couldn't parse that as an mdblist.com list URL (expected .../lists/user/listname)."
    );
  }

  const listId = await hashStringForKey(entry.url);
  const cacheKey = `user_cache:mdblist:list:${listId}:${entry.type}:${skip}`;
  const kvKey = `mdblist:list:${listId}:${entry.type}:${skip}`;

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
      const res = await fetch(src, {
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

      const data = await res.json();
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
  return items
    .map((it) => it.movie || it.show || it)
    .filter((it) => it && it.ids && it.ids.imdb)
    .map((it) => ({
      id: it.ids.imdb,
      type,
      name: it.title,
      poster: `https://images.metahub.space/poster/medium/${it.ids.imdb}/img`,
      releaseInfo: it.year ? String(it.year) : undefined,
    }));
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

  const itemKind = entry.type === "series" ? "shows" : "movies";
  const page = Math.floor(skip / PAGE_SIZE) + 1;
  const src = `https://api.trakt.tv/users/${encodeURIComponent(
    parsed.user
  )}/lists/${encodeURIComponent(parsed.list)}/items/${itemKind}?limit=${PAGE_SIZE}&page=${page}`;

  const headers = {
    "Content-Type": "application/json",
    "trakt-api-version": "2",
    "trakt-api-key": traktKey,
    "User-Agent": `my-list-addon/${ADDON_VERSION}`,
  };
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

  const userHash = accessToken ? safeUserHash(accessToken, parsed.user) : "public";
  const cacheKey = `user_cache:trakt:list:${parsed.user}:${parsed.list}:${itemKind}:${skip}:${userHash}`;
  const kvKey = !accessToken ? `trakt:list:${parsed.user}:${parsed.list}:${itemKind}:${page}` : "";

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
      const res = await fetchTraktWithRetry(src, {
        headers,
        cf: accessToken ? { cacheTtl: 0, cacheEverything: false } : { cacheTtl: 1200, cacheEverything: true },
      });
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
      return await res.json();
    }
  });

  return enrichTrailers(mapTraktItems(data, entry.type), entry.type, TMDB_API_KEY);
}

// Pulls the connected account's Trakt watchlist
async function fetchTraktWatchlist(entry, skip = 0, traktKey = "", accessToken = "") {
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
  const src = `https://api.trakt.tv/users/me/watchlist/${itemKind}?limit=${PAGE_SIZE}&page=${page}`;

  const userHash = safeUserHash(accessToken);
  const cacheKey = `user_cache:trakt:watchlist:${itemKind}:${skip}:${userHash}`;

  const data = await fetchWithPerUserCacheAndCircuitBreaker({
    cacheKey,
    freshTtlSec: 60,
    staleTtlSec: 1800,
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
      return await res.json();
    }
  });

  return enrichTrailers(mapTraktItems(data, entry.type), entry.type, TMDB_API_KEY);
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
      .filter((it) => it && it.episode && it.show && it.show.ids && it.show.ids.imdb)
      .map((it) => {
        const imdbId = it.show.ids.imdb;
        const s = it.episode.season;
        const e = it.episode.number;
        const epTitle = it.episode.title ? ` \u2014 ${it.episode.title}` : "";
        return {
          id: imdbId,
          type,
          name: `${it.show.title} S${s}E${e}${epTitle}`,
          showTitle: it.show.title,
          poster: `https://images.metahub.space/poster/medium/${imdbId}/img`,
          releaseInfo: watchedLabel(it.watched_at),
        };
      });
  }
  return items
    .filter((it) => it && it.movie && it.movie.ids && it.movie.ids.imdb)
    .map((it) => ({
      id: it.movie.ids.imdb,
      type,
      name: it.movie.title,
      poster: `https://images.metahub.space/poster/medium/${it.movie.ids.imdb}/img`,
      releaseInfo: watchedLabel(it.watched_at) || (it.movie.year ? String(it.movie.year) : undefined),
    }));
}

// Pulls the connected account's Trakt watch history
async function fetchTraktHistory(entry, skip = 0, traktKey = "", accessToken = "") {
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
  const itemKind = entry.type === "series" ? "episodes" : "movies";
  const page = Math.floor(skip / PAGE_SIZE) + 1;
  const src = `https://api.trakt.tv/users/me/history/${itemKind}?limit=${PAGE_SIZE}&page=${page}`;

  const userHash = safeUserHash(accessToken);
  const cacheKey = `user_cache:trakt:history:${itemKind}:${skip}:${userHash}`;

  const data = await fetchWithPerUserCacheAndCircuitBreaker({
    cacheKey,
    freshTtlSec: 60,
    staleTtlSec: 1800,
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
      return await res.json();
    }
  });

  return enrichTrailers(mapTraktHistoryItems(data, entry.type), entry.type, TMDB_API_KEY);
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
    freshTtlSec: 300,
    staleTtlSec: 3600,
    providerLabel: "Trakt Airing Next",
    fetchFn: async () => {
      const headers = {
        "Content-Type": "application/json",
        "trakt-api-version": "2",
        "trakt-api-key": traktKey,
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": `my-list-addon/${ADDON_VERSION}`,
      };

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
      await mapWithConcurrency(candidateMetas.slice(0, 40), 6, async (item) => {
        try {
          const details = await fetchTmdbItemDetails(item.id, tmdbKey, "series");
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
    freshTtlSec: 300,
    staleTtlSec: 3600,
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
      await mapWithConcurrency(candidateMetas.slice(0, 40), 6, async (item) => {
        try {
          const details = await fetchTmdbItemDetails(item.id, tmdbKey, "series");
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


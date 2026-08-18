// --- manifest ----------------------------------------------------------

function buildManifest(entries, origin, track, shuffleShelves, configSeed) {
  let active = entries.filter((e) => e.enabled !== false);
  if (shuffleShelves && active.length > 1) {
    active = deterministicDailyShuffle(active, `shelves:${configSeed || ''}`);
  }
  const resources = ["catalog", { name: "meta", types: ["movie", "series"], idPrefixes: ["tt", "channel_"] }];
  const idPrefixes = ["tt", "channel_"];
  // Stremio/wako call every installed addon's subtitles resource the
  // instant ANY video starts playing (checking for subtitle tracks) --
  // regardless of which addon's catalog the video came from, or whether
  // this addon has any subtitles to offer (it doesn't; see the
  // /:config/subtitles/... route in 25_api-catalog-routes.js). That's a
  // real, reliable "this just started playing" signal to hang automatic
  // watch-tracking off of -- just not a *completion* one, since it's one
  // request at the very start of playback, no ongoing position data. Only
  // declared when the person has turned on "Auto-track playback" in
  // Settings, since otherwise every video played anywhere would ping this
  // addon for no reason.
  if (track) {
    resources.push({ name: "subtitles", types: ["movie", "series"], idPrefixes: ["tt"] });
  }
  return {
    id: ADDON_ID,
    version: ADDON_VERSION,
    name: ADDON_NAME,
    description:
      "Browse your own mdblist.com, trakt.tv, and themoviedb.org lists (and your MDBList watchlist) as catalogs on the home screen.",
    logo: `${origin}/icon.png`,
    resources,
    types: ["movie", "series"],
    idPrefixes,
    catalogs: active.map((e) => ({
      type: e.type,
      id: e.id,
      name: e.name,
      // Lets wako/Stremio page through lists longer than one screen by
      // re-requesting the catalog with an increasing `skip`.
      extra: [{ name: "skip", isRequired: false }],
    })),
    behaviorHints: {
      configurable: true,
      configurationRequired: active.length === 0,
    },
    stremioAddonsConfig: {
      issuer: "https://stremio-addons.net",
      signature: "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..03spiD2axLxuJ_5ELBKq0g.SyhPc0VygCk1q_6JaM2YlfBPXxtlBVdwV5c8Y1MLcuo4q7zXyf36akYD54YPYCoOFvZgAxSZxhxo0-HMsbc1AhtKhbOsCUtWLCgYcbxhA6h861dBPzOhjgxmN-z6e2De.b0_UZrNPtaDqDglgwvES-w"
    },
  };
}

// --- catalog fetch -------------------------------------------------------

const PAGE_SIZE = 100; // items returned per catalog request, for sources we fetch in full up front

// Dispatches to the right backend based on what kind of URL was pasted in.
// `keys` is { mdblistKey, traktKey } — per-user keys decoded from their
// install link, if any. A key the user didn't supply falls back to the
// Worker-wide MDBLIST_API_KEY/TRAKT_CLIENT_ID constants at the top of the
// file. TRAKT_CLIENT_ID had previously started getting rejected with a 403
// ("invalid or unapproved app"), which made Trakt search/list-import/
// charts fail for anyone not supplying their own Client ID -- it's since
// been replaced with a new one, but if it starts happening again, the
// Worker owner needs a fresh app from https://trakt.tv/oauth/applications,
// or a person can supply their own Client ID in the meantime (see the
// error message a 403 produces below).
// Errors are intentionally allowed to propagate (not swallowed here) so the
// catalog route and the preview endpoint can both report *why* a list came
// back empty instead of guessing.
//
// A "merged" entry — multiple source URLs feeding one catalog row — stores
// its sources newline-separated in entry.url (see collectEntries in the
// builder page). Everything downstream of this function only ever sees one
// URL at a time; the fan-out/merge happens right here.
// Fires a best-effort +1 into the same day-bucketed stats system bumpStat
// uses elsewhere (03_admin.js) -- but only when isSharedKey is true, i.e.
// this specific request is about to use this Worker's own shared key
// rather than a visitor's personal one. Feeds the admin dashboard's API
// Usage tab, which is meant to catch a shared key creeping toward its
// provider's rate limit before catalogs start failing for everyone who
// doesn't have their own key configured. keys.ctx (when the caller has
// one) gets waitUntil'd so this can't add latency to the actual catalog
// response it's riding along on; without one it's just an unawaited
// fire-and-forget, same tradeoff bumpStat itself already documents.
function trackSharedApiUse(keys, isSharedKey, name) {
  if (!isSharedKey || !keys || !keys.env) return;
  const p = bumpStat(keys.env, `apiuse:${name}`);
  if (keys.ctx && typeof keys.ctx.waitUntil === "function") keys.ctx.waitUntil(p);
}

async function fetchCatalog(entry, skip = 0, keys = {}) {
  const urls = String(entry.url || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  
  let result;
  if (urls.length > 1) {
    result = await fetchMergedCatalog(urls, entry.type, skip, keys);
  } else {
    const mdblistKey = keys.mdblistAccessToken || keys.mdblistKey || MDBLIST_API_KEY;
    const traktKey = keys.traktKey || TRAKT_CLIENT_ID;
    const source = detectSource(entry.url);
    if (source === "mdblist-watchlist") { trackSharedApiUse(keys, !(keys.mdblistKey || keys.mdblistAccessToken), "mdblist"); result = await fetchMdblistWatchlist(entry, skip, mdblistKey, keys.mdblistAccessToken || ""); }
    else if (source === "mdblist-history") { trackSharedApiUse(keys, !(keys.mdblistKey || keys.mdblistAccessToken), "mdblist"); result = await fetchMdblistHistory(entry, skip, mdblistKey, keys.mdblistAccessToken || ""); }
    else if (source === "trakt") { trackSharedApiUse(keys, !keys.traktKey, "trakt"); result = await fetchTrakt(entry, skip, traktKey, keys.traktAccessToken || ""); }
    else if (source === "trakt-watchlist") { trackSharedApiUse(keys, !keys.traktKey, "trakt"); result = await fetchTraktWatchlist(entry, skip, traktKey, keys.traktAccessToken || ""); }
    else if (source === "trakt-history") { trackSharedApiUse(keys, !keys.traktKey, "trakt"); result = await fetchTraktHistory(entry, skip, traktKey, keys.traktAccessToken || ""); }
    else if (source === "tmdb") { trackSharedApiUse(keys, true, "tmdb"); result = await fetchTmdb(entry, skip, TMDB_API_KEY); }
    else if (source === "tmdb-chart") {
      trackSharedApiUse(keys, true, "tmdb");
      const webChart = typeof parseTmdbWebChartUrl === "function" ? parseTmdbWebChartUrl(entry.url) : null;
      const chartKey = webChart ? webChart.chartKey : entry.url.trim().slice("tmdb:chart:".length);
      result = await fetchTmdbChart(entry, skip, TMDB_API_KEY, chartKey);
    }
    else if (source === "tmdb-collection") { trackSharedApiUse(keys, true, "tmdb"); result = await fetchTmdbCollection(entry, skip, TMDB_API_KEY); }
    else if (source === "tmdb-top10") { trackSharedApiUse(keys, true, "tmdb"); result = await fetchTmdbProviderTop10(entry, skip, TMDB_API_KEY, entry.url.trim().slice("tmdb:top10:".length)); }
    else if (source === "tmdb-hidden-gems") { trackSharedApiUse(keys, true, "tmdb"); result = await fetchTmdbHiddenGems(entry, skip, TMDB_API_KEY); }
    else if (source === "tmdb-kids") { trackSharedApiUse(keys, true, "tmdb"); result = await fetchTmdbKids(entry, skip, TMDB_API_KEY, entry.url.trim().slice("tmdb:kids:".length)); }
    else if (source === "trakt-chart") { trackSharedApiUse(keys, !keys.traktKey, "trakt"); result = await fetchTraktChart(entry, skip, traktKey, entry.url.trim().slice("trakt:chart:".length)); }
    else if (source === "simkl-chart") { trackSharedApiUse(keys, true, "simkl"); result = await fetchSimklChart(entry, skip, SIMKL_CLIENT_ID, entry.url.trim().slice("simkl:chart:".length)); }
    else if (source === "channel") result = fetchChannelCatalog(entry, keys.origin);
    else if (source === "custom-list") result = await fetchCustomListCatalog(entry, skip, keys);
    else if (source === "autotrack") result = await fetchAutoTrackedCatalog(entry, keys.env);
    else if (source === "curated") { trackSharedApiUse(keys, true, "tmdb"); result = await fetchCuratedCatalog(entry, skip, keys); }
    else if (source === "published-list") result = await fetchPublishedListCatalog(entry, keys.env);
    else {
      trackSharedApiUse(keys, !(keys.mdblistKey || keys.mdblistAccessToken), "mdblist");
      result = await fetchMdblist(entry, skip, mdblistKey);
    }
  }

  if (keys.shuffleItems && Array.isArray(result) && result.length > 1) {
    result = deterministicDailyShuffle(result, `items:${entry.id || entry.name}:${keys.configParam || ''}`);
  }
  return result || [];
}

// Fans a merged catalog row out to each source at the same skip/page
// window, then concatenates (in source order) and dedupes by IMDB id —
// first occurrence wins, so a title appearing in an earlier-listed source
// takes priority over a later one.
//
// KNOWN LIMITATION: each source paginates independently, so this only
// dedupes *within* the current page window. A title that's duplicated
// across two sources but happens to fall in different skip windows as a
// catalog is scrolled deeper won't always get caught — this is exact for
// the common case (small/medium lists, and always exact on the first page)
// and only imperfect deep into large multi-source merges. Getting this
// perfectly exact would require fetching and holding each entire source in
// memory rather than paging them, which doesn't fit this add-on's
// stateless, one-request-per-page design.
async function fetchMergedCatalog(urls, type, skip, keys) {
  const perSource = await Promise.all(
    urls.map((u) => fetchCatalog({ url: u, type }, skip, keys).catch(() => []))
  );
  const seen = new Set();
  const merged = [];
  for (const list of perSource) {
    for (const m of list) {
      if (!m || seen.has(m.id)) continue;
      seen.add(m.id);
      merged.push(m);
    }
  }
  return merged.slice(0, PAGE_SIZE);
}

// --- Channels (synthetic series stitched from hand-picked episodes/movies) -
//
// A Channel entry stores its whole payload directly in entry.url as
// "channel:v1:<JSON>" -- built entirely client-side by the Channel builder
// panel (search a show, pick episodes; search a movie, add it whole), so
// once saved it's fully self-contained: no further TMDB lookups needed to
// serve it. Two things read this payload:
//  - fetchChannelCatalog (below) -- the catalog-row listing, which is just
//    ONE tile (the channel itself, poster + name) like any other meta item.
//  - buildChannelMeta (below) -- the full detail response with the actual
//    episode list, served from the new /meta route since Cinemeta (or
//    whatever meta add-on the person has) has never heard of these
//    synthetic ids.
// Every item's id embeds enough to resolve real streams: an episode's id is
// "<real show's imdb id>:<real season>:<real episode>" (its real show/
// season/episode, not the channel's own numbering), and a movie's id is
// just its own plain imdb id. season/episode on the *video* object itself
// are always sequential (1, 1..N) regardless of source, purely so the
// channel displays as one clean ordered list -- same as the reference
// implementation this feature is modeled on.
function parseChannelPayload(rawUrl) {
  try {
    const raw = String(rawUrl || "").trim();
    if (!raw.startsWith("channel:v1:")) return null;
    const data = JSON.parse(raw.slice("channel:v1:".length));
    return data && Array.isArray(data.items) ? data : null;
  } catch (e) {
    return null;
  }
}

function getPaddedChannelLogo(rawPoster, origin) {
  if (!rawPoster) return origin ? `${origin}/icon.png` : undefined;
  const m = rawPoster.match(/https:\/\/image\.tmdb\.org\/t\/p\/(?:w\d+|original)\/(.+)/);
  if (m && origin) {
    return `${origin}/api/channel-logo?path=${encodeURIComponent('/' + m[1])}`;
  }
  return rawPoster;
}

function fetchChannelCatalog(entry, origin) {
  const payload = parseChannelPayload(entry.url);
  if (!payload || !payload.items.length) return [];
  const channelId = payload.channelId || entry.id;
  const name = payload.name || entry.name;
  return [
    {
      id: "channel_" + channelId,
      type: "series",
      name: name,
      poster: getPaddedChannelLogo(payload.poster, origin),
      posterShape: "landscape",
    },
  ];
}

// --- Custom Lists --------------------------------------------------------------
//
// A hand-picked list of movies, shows, or mixed items built by search-and-pick
// in the builder. When served in a catalog shelf, items are automatically filtered
// to match the shelf type (entry.type).
function parseCustomListPayload(rawUrl) {
  try {
    const raw = String(rawUrl || "").trim();
    if (!raw.startsWith("customlist:v1:")) return null;
    const data = JSON.parse(raw.slice("customlist:v1:".length));
    if (!data || !Array.isArray(data.items)) return null;
    return data;
  } catch (e) {
    return null;
  }
}

function fetchCustomListCatalog(entry, skip = 0, keys = {}) {
  const payload = parseCustomListPayload(entry.url);
  if (!payload || !payload.items || !payload.items.length) {
    if (payload && (
      (payload.listSlug && (payload.listSlug.startsWith('custom:curated:') || payload.listSlug.startsWith('curated:'))) ||
      (payload.name && (payload.name.toLowerCase().includes('recommended movies') || payload.name.toLowerCase().includes('recommended shows')))
    )) {
      return fetchCuratedCatalog({ url: payload.listSlug || (entry.type === 'series' ? 'custom:curated:recommended-shows' : 'custom:curated:recommended-movies'), type: entry.type }, skip, keys);
    }
    return [];
  }
  const items = payload.shuffle
    ? seededShuffle(payload.items, daysSinceEpochUTC(new Date()) + hashStringToInt(payload.listId || entry.id))
    : payload.items;
  return items
    .filter((it) => {
      if (!it || !it.imdbId) return false;
      const itType = it.kind || it.type;
      if (entry.type === 'movie') {
        if (itType === 'series' || itType === 'tv') return false;
      } else if (entry.type === 'series') {
        if (itType === 'movie') return false;
      }
      return true;
    })
    .map((it) => ({
      id: it.imdbId,
      type: entry.type || (it.kind === 'series' || it.type === 'series' || it.type === 'tv' ? 'series' : 'movie'),
      name: it.title,
      poster: it.poster || undefined,
      releaseInfo: it.year || undefined,
    }));
}

async function fetchCuratedCatalog(entry, skip = 0, keys = {}) {
  const isSeries = entry.type === 'series' || (entry.url && entry.url.includes('shows'));
  const tmdbKey = keys.tmdbKey || TMDB_API_KEY;
  let sampleIds = [];

  if (keys.env && keys.env.CONFIGS) {
    let username = keys.username || keys.creatorName || '';
    if (!username && keys.configParam) {
      try {
        const resolved = await resolveConfig(keys.configParam, keys.env);
        if (resolved && resolved.trackCreatorName) username = resolved.trackCreatorName;
      } catch {}
    }
    if (username) {
      try {
        const trackingRaw = await keys.env.CONFIGS.get(`creatorsynctracking:${username}`);
        if (trackingRaw) {
          const tracking = JSON.parse(trackingRaw);
          if (isSeries) {
            const list = Array.isArray(tracking.continueWatching) && tracking.continueWatching.length
              ? tracking.continueWatching
              : (Array.isArray(tracking.watchHistory) ? tracking.watchHistory : []);
            sampleIds = list.map(it => it.showId || it.id).filter(Boolean).slice(0, 10);
          } else {
            const list = Array.isArray(tracking.watchHistory) ? tracking.watchHistory : [];
            sampleIds = list.filter(it => it.type === 'movie' || !it.seasonNum).map(it => it.id || it.imdbId).filter(Boolean).slice(0, 10);
          }
        }
      } catch {}
    }
  }

  if (sampleIds.length > 0) {
    try {
      const recs = await Promise.all(sampleIds.map(async (rawId) => {
        try {
          let tmdbId = '';
          if (String(rawId).startsWith('tmdb:')) {
            tmdbId = String(rawId).slice(5);
          } else {
            const findRes = await fetch(`https://api.themoviedb.org/3/find/${encodeURIComponent(rawId)}?api_key=${encodeURIComponent(tmdbKey)}&external_source=imdb_id`, {
              cf: { cacheTtl: 86400, cacheEverything: true }
            });
            const findData = await findRes.json();
            const resKey = isSeries ? 'tv_results' : 'movie_results';
            if (findData[resKey] && findData[resKey][0]) {
              tmdbId = findData[resKey][0].id;
            }
          }
          if (!tmdbId) return [];
          const endpoint = isSeries ? 'tv' : 'movie';
          const recRes = await fetch(`https://api.themoviedb.org/3/${endpoint}/${encodeURIComponent(tmdbId)}/recommendations?api_key=${encodeURIComponent(tmdbKey)}&page=1`, {
            cf: { cacheTtl: 86400, cacheEverything: true }
          });
          const recData = await recRes.json();
          let list = recData.results || [];
          if (!list.length) {
            const simRes = await fetch(`https://api.themoviedb.org/3/${endpoint}/${encodeURIComponent(tmdbId)}/similar?api_key=${encodeURIComponent(tmdbKey)}&page=1`, {
              cf: { cacheTtl: 86400, cacheEverything: true }
            });
            const simData = await simRes.json();
            list = simData.results || [];
          }
          return list;
        } catch {
          return [];
        }
      }));

      const seenTmdb = new Set();
      const combined = [];
      recs.forEach(list => {
        (list || []).forEach(item => {
          if (item && item.id && !seenTmdb.has(item.id)) {
            seenTmdb.add(item.id);
            combined.push(item);
          }
        });
      });

      if (combined.length > 0) {
        const mapped = await Promise.all(combined.slice(skip, skip + PAGE_SIZE).map(async (it) => {
          try {
            let imdbId = '';
            const detailRes = await fetch(`https://api.themoviedb.org/3/${isSeries ? 'tv' : 'movie'}/${it.id}/external_ids?api_key=${encodeURIComponent(tmdbKey)}`, {
              cf: { cacheTtl: 86400, cacheEverything: true }
            });
            const detailData = await detailRes.json();
            imdbId = detailData.imdb_id;
            if (!imdbId) imdbId = `tmdb:${it.id}`;
            const releaseYear = (it.release_date || it.first_air_date || '').slice(0, 4);
            return {
              id: imdbId,
              type: isSeries ? 'series' : 'movie',
              name: it.title || it.name || 'Untitled',
              poster: it.poster_path ? `https://image.tmdb.org/t/p/w500${it.poster_path}` : undefined,
              releaseInfo: releaseYear || undefined,
            };
          } catch {
            return null;
          }
        }));
        const validMapped = mapped.filter(Boolean);
        if (validMapped.length > 0) return validMapped;
      }
    } catch {}
  }

  // Fallback: TMDB Popular items so recommendations shelf is never empty
  return fetchTmdbChart(entry, skip, tmdbKey, 'popular');
}

// Copies forward tracking fields (watchHistory/continueWatching/
// fullyWatchedShowIds/dismissedContinueWatching/trackPlayback) from the
// old embedded location in creatorsync:{username} into the new dedicated
// creatorsynctracking:{username} key, exactly once. Called defensively
// from every write path that touches tracking data -- the client's own
// save-tracking endpoint, the Continue Watching cron (checkForNewEpisodes
// below), and the Auto-Track Playback subtitle ping (handleSubtitlesTrack,
// further down this file) -- since any of the three could be the first to
// run after this split shipped, and whichever runs first must not
// silently lose whatever was already saved the old way.
async function ensureTrackingMigrated(env, username) {
  const existing = await env.CONFIGS.get(`creatorsynctracking:${username}`);
  if (existing !== null) return; // already migrated (or already using the new key)
  const oldRaw = await env.CONFIGS.get(`creatorsync:${username}`);
  if (!oldRaw) return;
  try {
    const oldBlob = JSON.parse(oldRaw);
    const hasTrackingData = (Array.isArray(oldBlob.watchHistory) && oldBlob.watchHistory.length) ||
      (Array.isArray(oldBlob.continueWatching) && oldBlob.continueWatching.length) ||
      (Array.isArray(oldBlob.watchlist) && oldBlob.watchlist.length) ||
      (Array.isArray(oldBlob.fullyWatchedShowIds) && oldBlob.fullyWatchedShowIds.length) ||
      (oldBlob.dismissedContinueWatching && Object.keys(oldBlob.dismissedContinueWatching).length) ||
      typeof oldBlob.trackPlayback === "boolean";
    if (!hasTrackingData) return;
    await env.CONFIGS.put(`creatorsynctracking:${username}`, JSON.stringify({
      watchHistory: Array.isArray(oldBlob.watchHistory) ? oldBlob.watchHistory : [],
      continueWatching: Array.isArray(oldBlob.continueWatching) ? oldBlob.continueWatching : [],
      watchlist: Array.isArray(oldBlob.watchlist) ? oldBlob.watchlist : [],
      fullyWatchedShowIds: Array.isArray(oldBlob.fullyWatchedShowIds) ? oldBlob.fullyWatchedShowIds : [],
      dismissedContinueWatching: oldBlob.dismissedContinueWatching && typeof oldBlob.dismissedContinueWatching === "object" ? oldBlob.dismissedContinueWatching : {},
      trackPlayback: typeof oldBlob.trackPlayback === "boolean" ? oldBlob.trackPlayback : false,
      updatedAt: Date.now(),
    }));
  } catch {
    // old blob unreadable -- nothing to migrate
  }
}

async function fetchAutoTrackedCatalog(entry, env) {
  if (!env || !env.CONFIGS) return [];
  
  // url format: autotrack:[slug]:[type]:[username]
  // e.g. autotrack:watch-history:movie:brock25
  const parts = String(entry.url || "").split(":");
  if (parts.length < 4) return [];
  
  const slug = parts[1]; // watch-history, continue-watching, or watchlist
  const targetType = parts[2]; // movie or series
  const username = parts[3];
  
  try {
    let items;
    const trackingRaw = await env.CONFIGS.get('creatorsynctracking:' + username);
    if (trackingRaw) {
      const trackingBlob = JSON.parse(trackingRaw);
      items = slug === 'watch-history' ? trackingBlob.watchHistory : (slug === 'continue-watching' ? trackingBlob.continueWatching : (trackingBlob.watchlist || []));
    } else {
      const blobStr = await env.CONFIGS.get('creatorsync:' + username);
      if (!blobStr) return [];
      const blob = JSON.parse(blobStr);
      items = slug === 'watch-history' ? blob.watchHistory : (slug === 'continue-watching' ? blob.continueWatching : (blob.watchlist || []));
    }
    if (!items || !items.length) return [];
    
    const mappedItems = [];
    
    items.forEach(it => {
      const isMovie = it.kind === 'movie' || it.type === 'movie';
      
      // Filter out types we don't want in this catalog
      if (targetType === 'movie' && !isMovie) return;
      if (targetType === 'series' && isMovie) return;
      
      const showId = isMovie ? null : (it.showId || it.imdbId || it.id);
      const showPoster = isMovie
        ? it.poster
        : (it.showPoster ||
           (showId && showId.startsWith('tt') ? 'https://images.metahub.space/poster/medium/' + showId + '/img' : '') ||
           it.poster);
      const mapped = {
        id: isMovie ? (it.imdbId || it.id) : (showId || it.id),
        type: targetType,
        name: isMovie ? (it.title || it.name) : (it.showTitle || it.title || it.name),
        poster: showPoster,
        releaseInfo: it.year || undefined
      };
      
      if (!mapped.id) return;
      
      if (targetType === 'series') {
        if (!mappedItems.some(s => s.id === mapped.id)) {
          mappedItems.push(mapped);
        }
      } else {
        mappedItems.push(mapped);
      }
    });
    
    return mappedItems;
  } catch (e) {
    return [];
  }
}

// A Custom List someone published (see /api/publish-list, or a Creator
// Profile's /api/creator/lists/save, and the public /lists/:username/
// :listname route) can be pointed at as a source the same way an
// mdblist.com URL is -- this resolves it straight from this Worker's own
// KV rather than an HTTP round-trip to itself. Needs the CONFIGS KV
// namespace bound; without one, publishing itself never succeeds in the
// first place, so there's nothing for this to find.
async function fetchPublishedListCatalog(entry, env) {
  if (!env || !env.CONFIGS) return [];
  const parsed = parsePublishedListUrl(entry.url);
  if (!parsed) return [];

  // Same lookup order and private-list handling as the public GET route
  // above: a Creator-owned list that's private is treated exactly like it
  // doesn't exist (not just "can't be added") -- someone pointing another
  // config at a guessed/leaked private-list URL gets nothing, the same
  // outcome as any other broken/nonexistent source.
  let payload = null;
  const creatorRaw = await env.CONFIGS.get(`creatorlist:${parsed.username}:${parsed.listName}`);
  if (creatorRaw) {
    try {
      const data = JSON.parse(creatorRaw);
      if (data.visibility !== "private") payload = data;
    } catch {
      // fall through to anonymous lookup below
    }
  }
  if (!payload) {
    const anonRaw = await env.CONFIGS.get(`publishedlist:${parsed.username}:${parsed.listName}`);
    if (anonRaw) {
      try {
        payload = JSON.parse(anonRaw);
      } catch {
        return [];
      }
    }
  }
  if (!payload || !Array.isArray(payload.items)) return [];
  return payload.items
    .filter((it) => {
      if (!it || !it.imdbId) return false;
      const itType = it.kind || it.type;
      if (entry.type === 'movie') {
        if (itType === 'series' || itType === 'tv') return false;
      } else if (entry.type === 'series') {
        if (itType === 'movie') return false;
      }
      return true;
    })
    .map((it) => ({
      id: it.imdbId,
      type: entry.type || (it.kind === 'series' || it.type === 'series' || it.type === 'tv' ? 'series' : 'movie'),
      name: it.title,
      poster: it.poster || undefined,
      releaseInfo: it.year || undefined,
    }));
}

// NOTE: mixing movies into a channel is a known soft spot -- when someone
// taps a movie "episode", wako/Stremio requests its stream as
// /stream/series/<movie's plain imdb id>.json (type "series", since that's
// the parent meta's type, Stremio doesn't re-derive per-video type). Most
// stream add-ons branch their whole handler on that type param before even
// looking at the id, so a movie embedded this way may not return streams on
// every stream add-on -- Torrentio-style ones tend to be fairly lenient
// about id shape, but this isn't guaranteed across the board. Worth testing
// directly against whichever stream add-on the person actually uses.
//
// A stable string->int hash (not cryptographic, just needs to be a decent
// spread) so each channel's shuffle looks independent of every other
// channel's, rather than every shuffled channel moving in lockstep on the
// same day (see the shuffle seed below).
function hashStringToInt(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}

// mulberry32 -- a small, fast, deterministic PRNG. Good enough for shuffling
// a hand-picked list of a few dozen items into a different-but-reproducible
// order; not intended for anything security-sensitive.
function seededShuffle(arr, seed) {
  const out = arr.slice();
  let s = seed >>> 0;
  function nextRandom() {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(nextRandom() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

// A day's rotation is sized like an actual evening of linear TV, not a
// flat slice of the pool -- with 24 hours in a day and most shows running
// 30-60 minutes, nobody's watching anywhere near 2000 episodes in a day.
// 24 shows x 3 episodes = 72 gives a full day's variety with slack built
// in for skipping around, while still drawing from a much bigger stored
// pool over time (see CHANNEL_POOL_MAX_ITEMS client-side) so the rotation
// itself changes which shows/episodes appear from one day to the next.
const CHANNEL_ROTATION_SHOWS_PER_DAY = 24;
const CHANNEL_ROTATION_EPISODES_PER_SHOW = 3;

function buildChannelMeta(entry, origin) {
  const payload = parseChannelPayload(entry.url);
  if (!payload || !payload.items.length) return null;
  // payload.channelId/payload.name (not entry.id/entry.name) are the real
  // identity -- see the same note in fetchChannelCatalog above.
  const channelId = payload.channelId || entry.id;
  const name = payload.name || entry.name;
  // "Randomize play order" (set once in the Channel builder, stored on the
  // payload) reshuffles once a day rather than on every single request --
  // same reasoning as Hidden Gems' daily reshuffle (see daysSinceEpochUTC
  // below): the order stays put if someone reopens the channel later the
  // same day (mid-binge), but looks freshly shuffled again tomorrow.
  //
  // dailyRotate is a step further, set by Quick Add Channel: the payload
  // stores a much bigger pool than what's ever actually shown, and this
  // picks a fresh, structured day's lineup from that pool -- a handful of
  // different shows with a few episodes each (see the constants above),
  // not a flat random slice that could easily skew to dozens of episodes
  // of one show and none of many others. Stable within a day, different
  // the next.
  const seed = daysSinceEpochUTC(new Date()) + hashStringToInt(channelId);
  let items;
  if (payload.dailyRotate) {
    const byShow = new Map();
    payload.items.forEach((it) => {
      const key = it.imdbId || it.kind + ":" + it.title;
      if (!byShow.has(key)) byShow.set(key, []);
      byShow.get(key).push(it);
    });
    const showKeys = seededShuffle([...byShow.keys()], seed).slice(0, CHANNEL_ROTATION_SHOWS_PER_DAY);
    items = [];
    showKeys.forEach((key, i) => {
      const showEpisodes = byShow.get(key);
      const perShow = Math.min(CHANNEL_ROTATION_EPISODES_PER_SHOW, showEpisodes.length);
      // A contiguous block (not scattered episodes) feels like an actual
      // evening's run of a show -- seeded per-show so different shows
      // don't all land on the same relative starting point.
      const maxStart = showEpisodes.length - perShow;
      const starts = seededShuffle(
        Array.from({ length: maxStart + 1 }, (_, n) => n),
        seed + i + 1
      );
      const start = starts.length ? starts[0] : 0;
      items.push(...showEpisodes.slice(start, start + perShow));
    });
  } else if (payload.shuffle) {
    items = seededShuffle(payload.items, seed);
  } else {
    items = payload.items;
  }
  const videos = items.map((it, i) => {
    // TMDB's air_date/release_date (and our own year-only fallback for
    // movies) are bare "YYYY-MM-DD" dates. Stremio Web's core is compiled
    // from Rust (see the stremio-core-web/*.wasm console errors this
    // surfaced during debugging) -- its deserializer likely expects a full
    // ISO 8601 *datetime* here and can silently fail to parse the whole
    // meta object on a bare date, unlike a loose JS parser that wouldn't
    // care. Pinning to midnight UTC costs nothing (we only ever had a date
    // to begin with) and matches the shape a known-working reference
    // implementation's meta responses use.
    const releaseDate = it.released || (it.year ? `${it.year}-01-01` : undefined);
    return {
      id: it.kind === "movie" ? it.imdbId : `${it.imdbId}:${it.season}:${it.episode}`,
      title: it.title,
      season: 1,
      episode: i + 1,
      released: releaseDate ? `${releaseDate}T00:00:00.000Z` : undefined,
      thumbnail: it.thumbnail || it.poster || payload.poster || undefined,
    };
  });
  return {
    id: "channel_" + channelId,
    type: "series",
    name: name,
    poster: getPaddedChannelLogo(payload.poster, origin),
    posterShape: "landscape",
    background: getPaddedChannelLogo(payload.poster, origin),
    videos,
  };
}

// mdblist's json feeds (public list feed and the REST API) are both either a
// flat array of items, or an object with `movies` / `shows` arrays depending
// on list contents. This normalizes + filters + maps either shape to metas.

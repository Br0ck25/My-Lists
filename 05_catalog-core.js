// --- manifest ----------------------------------------------------------

function buildManifest(entries, origin, track, shuffleShelves, configSeed) {
  let active = entries.filter((e) => e.enabled !== false);
  if (shuffleShelves && active.length > 1) {
    active = deterministicDailyShuffle(active, `shelves:${configSeed || ''}`);
  }
  // "tmdb:" belongs here because this add-on actually serves those ids.
  //
  // A Watch History or Continue Watching entry for a title with no IMDb id is
  // stored and returned as "tmdb:<id>" (see fetchAutoTrackedCatalog below), and
  // the /meta route has always resolved them -- `id.startsWith("tt") ||
  // id.startsWith("tmdb:")`. The manifest did not say so, and idPrefixes is how
  // a Stremio-protocol client decides which add-on owns an id: undeclared, those
  // tiles get filtered out of the row by strict clients and their detail pages
  // are never routed back here by any client. This file's own placeholder tile
  // already cites that behaviour ("some clients filter out anything else").
  const resources = ["catalog", { name: "meta", types: ["movie", "series"], idPrefixes: ["tt", "tmdb:", "channel_"] }];
  const idPrefixes = ["tt", "tmdb:", "channel_"];
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
    resources.push({ name: "subtitles", types: ["movie", "series"], idPrefixes: ["tt", "tmdb", "kitsu"] });
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
    catalogs: [
      ...active.map((e) => ({
        type: e.type,
        id: e.id,
        name: e.name,
        // Lets wako/Stremio page through lists longer than one screen by
        // re-requesting the catalog with an increasing `skip`.
        extra: [{ name: "skip", isRequired: false }],
      })),
      // Dedicated search catalogs for movies and series.
      // With isRequired: true / extraRequired: ["search"], Stremio and Nuvio
      // recognize that this add-on provides catalog search resources (fixing the
      // "Missing search interface" error when this is the sole metadata source),
      // while preventing these catalogs from cluttering the home or discover shelves.
      {
        type: "movie",
        id: "search_movies",
        name: "Movies",
        extra: [
          { name: "search", isRequired: true },
          { name: "skip", isRequired: false },
        ],
        extraSupported: ["search", "skip"],
        extraRequired: ["search"],
      },
      {
        type: "series",
        id: "search_series",
        name: "Series",
        extra: [
          { name: "search", isRequired: true },
          { name: "skip", isRequired: false },
        ],
        extraSupported: ["search", "skip"],
        extraRequired: ["search"],
      },
    ],
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
    else if (source === "mdblist-airing-next") { trackSharedApiUse(keys, !(keys.mdblistKey || keys.mdblistAccessToken), "mdblist"); result = await fetchMdblistAiringNext(entry, skip, mdblistKey, keys.mdblistAccessToken || "", keys.tmdbKey || TMDB_API_KEY, keys.env, keys.ctx); }
    else if (source === "mdblist-upnext") { trackSharedApiUse(keys, !(keys.mdblistKey || keys.mdblistAccessToken), "mdblist"); result = await fetchMdblistUpNext(entry, skip, mdblistKey, keys.mdblistAccessToken || "", keys.tmdbKey || TMDB_API_KEY, keys.env, keys.ctx); }
    else if (source === "trakt") { trackSharedApiUse(keys, !keys.traktKey, "trakt"); result = await fetchTrakt(entry, skip, traktKey, keys.traktAccessToken || "", keys.env, keys.ctx); }
    else if (source === "trakt-watchlist") { trackSharedApiUse(keys, !keys.traktKey, "trakt"); result = await fetchTraktWatchlist(entry, skip, traktKey, keys.traktAccessToken || "", keys.env, keys.ctx); }
    else if (source === "trakt-history") { trackSharedApiUse(keys, !keys.traktKey, "trakt"); result = await fetchTraktHistory(entry, skip, traktKey, keys.traktAccessToken || "", keys.env, keys.ctx); }
    else if (source === "trakt-airing-next") { trackSharedApiUse(keys, !keys.traktKey, "trakt"); result = await fetchTraktAiringNext(entry, skip, traktKey, keys.traktAccessToken || "", keys.tmdbKey || TMDB_API_KEY, keys.env, keys.ctx); }
    else if (source === "trakt-continue-watching") { trackSharedApiUse(keys, !keys.traktKey, "trakt"); result = await fetchTraktContinueWatching(entry, skip, traktKey, keys.traktAccessToken || "", keys.env, keys.ctx); }
    else if (source === "tmdb") { trackSharedApiUse(keys, true, "tmdb"); result = await fetchTmdb(entry, skip, TMDB_API_KEY); }
    else if (source === "tmdb-chart") {
      trackSharedApiUse(keys, true, "tmdb");
      const webChart = typeof parseTmdbWebChartUrl === "function" ? parseTmdbWebChartUrl(entry.url) : null;
      const chartKey = webChart ? webChart.chartKey : entry.url.trim().slice("tmdb:chart:".length);
      result = await fetchTmdbChart(entry, skip, TMDB_API_KEY, chartKey, keys.region, keys.hideNonDigitalReleases, keys.env, keys.ctx);
    }
    else if (source === "tmdb-collection") { trackSharedApiUse(keys, true, "tmdb"); result = await fetchTmdbCollection(entry, skip, TMDB_API_KEY, keys.env, keys.ctx); }
    else if (source === "tmdb-top10") { trackSharedApiUse(keys, true, "tmdb"); result = await fetchTmdbProviderTop10(entry, skip, TMDB_API_KEY, entry.url.trim().slice("tmdb:top10:".length), keys.region); }
    else if (source === "tmdb-hidden-gems") { trackSharedApiUse(keys, true, "tmdb"); result = await fetchTmdbHiddenGems(entry, skip, TMDB_API_KEY); }
    else if (source === "tmdb-kids") { trackSharedApiUse(keys, true, "tmdb"); result = await fetchTmdbKids(entry, skip, TMDB_API_KEY, entry.url.trim().slice("tmdb:kids:".length)); }
    else if (source === "tmdb-holiday") { trackSharedApiUse(keys, true, "tmdb"); result = await fetchTmdbHoliday(entry, skip, TMDB_API_KEY, entry.url.trim().slice("tmdb:holiday:".length)); }
    else if (source === "tmdb-genre") { trackSharedApiUse(keys, true, "tmdb"); result = await fetchTmdbGenre(entry, skip, TMDB_API_KEY, entry.url.trim().slice("tmdb:genre:".length), keys.region); }
    // No trackSharedApiUse: this one reads D1 and makes no provider call at
    // all. Its TMDB spend happens on the cron tick (sweepNewOnStreaming),
    // where it is already counted against the sweep's own budget rather than
    // against whoever happened to open the shelf.
    else if (source === "tmdb-new-on-streaming") { result = await fetchNewOnStreaming(entry, skip, keys); }
    // Reads this add-on's own watch counts (a KV snapshot, rebuilt at most
    // hourly/daily); see fetchMostWatchedCatalog.
    else if (source === "mylists-most-watched") { result = await fetchMostWatchedCatalog(entry, skip, keys); }
    else if (source === "trakt-chart") { trackSharedApiUse(keys, !keys.traktKey, "trakt"); result = await fetchTraktChart(entry, skip, traktKey, entry.url.trim().slice("trakt:chart:".length), keys.env, keys.ctx); }
    else if (source === "simkl-chart") { trackSharedApiUse(keys, true, "simkl"); result = await fetchSimklChart(entry, skip, SIMKL_CLIENT_ID, entry.url.trim().slice("simkl:chart:".length), keys.env, keys.ctx); }
    else if (source === "simkl-user") { trackSharedApiUse(keys, true, "simkl"); result = await fetchSimklUserList(entry, skip, keys.simklAccessToken, SIMKL_CLIENT_ID, entry.url.trim().slice("simkl:user:".length), keys.tmdbKey, keys.env, keys.ctx); }
    else if (source === "channel") result = fetchChannelCatalog(entry, keys.origin);
    else if (source === "custom-list") result = await fetchCustomListCatalog(entry, skip, keys);
    else if (source === "autotrack") result = await fetchAutoTrackedCatalog(entry, keys.env, keys);
    else if (source === "curated") { trackSharedApiUse(keys, true, "tmdb"); result = await fetchCuratedCatalog(entry, skip, keys); }
    else if (source === "published-list") result = await fetchPublishedListCatalog(entry, keys.env);
    else {
      trackSharedApiUse(keys, !(keys.mdblistKey || keys.mdblistAccessToken), "mdblist");
      result = await fetchMdblist(entry, skip, mdblistKey, keys.env, keys.ctx);
    }
  }

  if (keys.shuffleItems && Array.isArray(result) && result.length > 1) {
    const tot = result.totalItems;
    result = deterministicDailyShuffle(result, `items:${entry.id || entry.name}:${keys.configParam || ''}`);
    result.totalItems = tot;
  }

  // Before the badge pass below, never after: a badge wraps whatever poster
  // URL it finds into /api/poster-badge?poster=..., so running this second
  // would throw the badged poster away. Running it first means a badged
  // poster is a badge drawn over BetterPosters artwork, which is the point.
  // The adult-content filter still runs after both and still wins.
  if (keys.betterPosters && Array.isArray(result) && result.length > 0) {
    result = applyBetterPostersToMetas(result, keys.betterPostersOptions || {});
  }

  if (keys.isStremioCatalog === true && keys.origin && Array.isArray(result) && result.length > 0) {
    const entryUrl = String(entry.url || '');
    const entryName = String(entry.name || '').toLowerCase();
    const isAiringNext = entryUrl.includes('airing-next') || entryUrl.includes('airing_next') || entry.statusKey === 'airing-next' || entry.slug === 'airing-next' || entry.id === 'airing-next' || entryName.includes('airing next');
    const isContinueWatching = entryUrl.includes('continue-watching') || entryUrl.includes('continue_watching') || entry.statusKey === 'continue-watching' || entry.slug === 'continue-watching' || entry.id === 'continue-watching' || entryName.includes('continue watching');
    // Matched the same way as the two above. "upnext" is deliberately absent:
    // that is MDBList's own Up Next shelf, which is a progress list rather
    // than a watchlist and already lands on the catalogs toggle.
    const isWatchlist = entryUrl.includes('watchlist') || entry.statusKey === 'watchlist' || entry.slug === 'watchlist' || entry.id === 'watchlist' || entryName.includes('watchlist');

    let allowBadges = false;
    if (isAiringNext) {
      allowBadges = keys.showBadgesStremioAiringNext !== false && keys.showBadgesStremio !== false;
    } else if (isContinueWatching) {
      allowBadges = keys.showBadgesStremioContinueWatching !== false && keys.showBadgesStremio !== false;
    } else if (isWatchlist) {
      allowBadges = keys.showBadgesStremioWatchlist !== false && keys.showBadgesStremio !== false;
    } else {
      allowBadges = keys.showBadgesStremioCatalogs !== false && keys.showBadgesStremio !== false;
    }

    if (allowBadges) {
      result = applyBadgedPostersToMetas(result, keys.origin);
    }
  }

  if (keys.adultContentFilter && Array.isArray(result) && result.length > 0) {
    result = applyAdultContentFilterToMetas(result, keys.origin, entry);
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
  let totalSum = 0;
  for (const list of perSource) {
    if (typeof list.totalItems === 'number') totalSum += list.totalItems;
    for (const m of list) {
      if (!m || seen.has(m.id)) continue;
      seen.add(m.id);
      merged.push(m);
    }
  }
  const sliced = merged.slice(0, PAGE_SIZE);
  sliced.totalItems = totalSum > 0 ? totalSum : null;
  return sliced;
}

// Cross-LIST duplicate removal for Stremio/Nuvio catalogs -- "Remove
// duplicate items across lists" in Settings (dedupeAcrossListsCheckbox).
// Keeps a config's FIRST list of a given type exactly as fetchCatalog
// already built it, and for every list after it (in the same order the
// builder's Catalogs/Live Preview shows them, i.e. entries' own order)
// strips whatever id already showed up in an earlier same-type list.
// renderLivePreview (23_client-list-management.js) applies the identical
// rule client-side over its already-fetched shelves, so what the builder
// shows is what this ends up serving.
//
// Same "same skip/page window" limitation fetchMergedCatalog above already
// accepts for a merged row's own sources: an earlier entry is re-fetched at
// the SAME skip as the one being served rather than pulled in full, so this
// is exact for the common case (the home screen's first page of every row)
// and only approximate once someone pages deep into more than one row at
// once. Getting it exact deeper would mean holding every earlier list in
// full, which does not fit this add-on's stateless, one-request-per-page
// design -- see fetchMergedCatalog's own comment for the same tradeoff.
//
// keys deliberately omits isStremioCatalog/showBadgesStremio*/
// adultContentFilter/origin: those only ever change a poster URL or add a
// field, never which ids come back (applyBadgedPostersToMetas and
// applyAdultContentFilterToMetas are both 1:1 maps), so skipping them here
// just saves the work rather than changing the answer.
async function dedupeAcrossListEntries(entries, entryIndex, skip, metas, keys) {
  if (!Array.isArray(metas) || !metas.length) return metas;
  const entry = entries[entryIndex];
  if (!entry) return metas;
  // A personal shelf sits outside this feature entirely, in both directions:
  // it is never stripped, and it never strips anything else. Continue
  // Watching exists to show what you are part-way through -- losing a show
  // from it because Trending happened to list the same title higher up is
  // not de-duplication, it is the shelf failing at its one job. And the
  // reverse would be just as surprising: a title vanishing from Trending
  // because it is in your Watchlist. See isPersonalShelfUrl (00_constants.js).
  if (isPersonalShelfUrl(entry.url)) return metas;
  const priorEntries = entries.slice(0, entryIndex).filter((e) =>
    e && e.enabled !== false && e.type === entry.type && !isPersonalShelfUrl(e.url));
  if (!priorEntries.length) return metas;

  const priorResults = await Promise.all(
    priorEntries.map((e) => fetchCatalog(e, skip, keys).catch(() => []))
  );
  const seen = new Set();
  for (const list of priorResults) {
    for (const m of list) {
      if (m && m.id) seen.add(m.id);
    }
  }
  if (!seen.size) return metas;
  const tot = metas.totalItems;
  const before = metas.length;
  const filtered = metas.filter((m) => !m || !seen.has(m.id));
  // Approximate, same reasoning as the page-window limitation above: this
  // page lost `before - filtered.length` items to dedup, so the running
  // total is adjusted by the same amount rather than left claiming a count
  // this page can no longer back up.
  if (typeof tot === 'number') filtered.totalItems = Math.max(filtered.length, tot - (before - filtered.length));
  return filtered;
}

// --- Channels (synthetic series stitched from hand-picked episodes/movies) -
//
// A Channel entry stores its payload directly in entry.url as
// "channel:v1:<JSON>" -- built entirely client-side by the Channel builder
// panel (search a show, pick episodes; search a movie, add it whole), so a
// hand-built channel is fully self-contained: no further TMDB lookups
// needed to serve it. Two things read this payload:
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
//
// A Quick Add network channel is the one exception to "fully
// self-contained": its payload carries `presetNetworkId` -- a pointer at
// the shared, cron-prewarmed pool cached under
// channel:preset:v2:<presetNetworkId> (buildNetworkChannelPreset,
// 07_source-fetchers-tmdb-simkl.js) -- alongside a small
// CHANNEL_POINTER_SAMPLE_ITEMS-item `items` sample of its own rather than
// the full pool (up to CHANNEL_POOL_MAX_ITEMS, 5,000). That sample is not
// an optimization to skip: a long list of places across this codebase read
// a channel row's own `.items` directly as a local shortcut (the "My
// Channels" list, "See All"'s local-preview path, and others), and a
// pointer shipped with NO items at all left every one of those rendering a
// broken 0-episode channel instead of falling back to something real.
// channelSourceItems always prefers the full pool when it can reach the
// cache, and falls back to this sample only if that lookup itself fails.
function parseChannelPayload(rawUrl) {
  try {
    const raw = String(rawUrl || "").trim();
    if (!raw.startsWith("channel:v1:")) return null;
    const data = JSON.parse(raw.slice("channel:v1:".length));
    if (!data) return null;
    if (Array.isArray(data.items)) return data;
    // Defensive only: a well-formed pointer always carries its own sample
    // (see quickAddChannel, 20_client-channel-builder.js) -- this covers a
    // hand-edited or older-shaped row that has presetNetworkId but no items.
    if (data.presetNetworkId) return data;
    return null;
  } catch (e) {
    return null;
  }
}

function escapeXml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function wrapSvgText(text, maxCharsPerLine = 15, maxLines = 3) {
  const words = String(text || "").trim().split(/\s+/);
  const lines = [];
  let currentLine = "";

  for (const word of words) {
    if (!currentLine) {
      currentLine = word;
    } else if ((currentLine + " " + word).length <= maxCharsPerLine) {
      currentLine += " " + word;
    } else {
      lines.push(currentLine);
      currentLine = word;
      if (lines.length === maxLines - 1) break;
    }
  }
  if (currentLine && lines.length < maxLines) {
    lines.push(currentLine);
  }
  return lines.length ? lines : ["TV Channel"];
}

function generateChannelPosterSvg(name, backdropUrl = "") {
  const cleanName = (name || "TV Channel").trim();
  const lines = wrapSvgText(cleanName, 10, 3);
  
  const maxLen = Math.max(...lines.map((l) => l.length));
  let fontSize = 54;
  if (maxLen > 6 || lines.length >= 2) fontSize = 42;
  if (maxLen > 9 || lines.length >= 3) fontSize = 34;
  if (maxLen > 13) fontSize = 28;
  const lineHeight = fontSize * 1.18;

  // TV Screen Center is (0, 0) inside <g transform="translate(300, 440)">
  const startY = -((lines.length - 1) * lineHeight) / 2 + (fontSize * 0.35);

  const bgImageSvg = backdropUrl && backdropUrl.startsWith("http")
    ? `<image href="${escapeXml(backdropUrl)}" width="600" height="900" preserveAspectRatio="xMidYMid slice" opacity="0.25" filter="url(#blur)" />`
    : "";

  const textSpans = lines.map((line, idx) => {
    return `<tspan x="0" y="${startY + (idx * lineHeight)}">${escapeXml(line.toUpperCase())}</tspan>`;
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 900" width="600" height="900">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0b0d14" />
      <stop offset="50%" stop-color="#131726" />
      <stop offset="100%" stop-color="#06070a" />
    </linearGradient>
    <linearGradient id="accentGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#007AFF" />
      <stop offset="50%" stop-color="#5856D6" />
      <stop offset="100%" stop-color="#AF52DE" />
    </linearGradient>
    <linearGradient id="tvBezel" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#1f2438" />
      <stop offset="100%" stop-color="#0d0f17" />
    </linearGradient>
    <linearGradient id="tvScreen" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#141829" />
      <stop offset="50%" stop-color="#0e111d" />
      <stop offset="100%" stop-color="#080a11" />
    </linearGradient>
    <linearGradient id="overlayGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#06070a" stop-opacity="0.85" />
      <stop offset="50%" stop-color="#06070a" stop-opacity="0.45" />
      <stop offset="100%" stop-color="#06070a" stop-opacity="0.9" />
    </linearGradient>
    <filter id="blur" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="16" />
    </filter>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="16" result="blur" />
      <feComposite in="SourceGraphic" in2="blur" operator="over" />
    </filter>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="6" stdDeviation="8" flood-color="#000000" flood-opacity="1" />
    </filter>
  </defs>

  <!-- Background -->
  <rect width="600" height="900" fill="url(#bgGrad)" />
  ${bgImageSvg}
  <rect width="600" height="900" fill="url(#overlayGrad)" />

  <!-- Outer Poster Border -->
  <rect x="20" y="20" width="560" height="860" rx="32" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="3" />

  <!-- Centered Retro-Modern TV Set with Channel Name INSIDE the Screen -->
  <g transform="translate(300, 440)">
    <!-- Antenna -->
    <path d="M-60,-240 L0,-185 L60,-240" fill="none" stroke="rgba(255,255,255,0.7)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" />
    <circle cx="-60" cy="-240" r="8" fill="#007AFF" filter="url(#glow)" />
    <circle cx="60" cy="-240" r="8" fill="#AF52DE" filter="url(#glow)" />

    <!-- Ambient Glow Behind Bezel -->
    <rect x="-240" y="-185" width="480" height="370" rx="32" fill="url(#accentGrad)" opacity="0.3" filter="url(#glow)" />

    <!-- TV Outer Cabinet Bezel -->
    <rect x="-230" y="-175" width="460" height="350" rx="28" fill="url(#tvBezel)" stroke="rgba(255,255,255,0.3)" stroke-width="3.5" />

    <!-- TV Inner Screen Glass -->
    <rect x="-205" y="-150" width="410" height="300" rx="20" fill="url(#tvScreen)" stroke="rgba(0,122,255,0.5)" stroke-width="2.5" />

    <!-- Screen Broadcast Waves inside TV -->
    <path d="M-90,-105 Q-45,-130 0,-105 T90,-105" fill="none" stroke="url(#accentGrad)" stroke-width="4.5" stroke-linecap="round" opacity="0.85" />

    <!-- Channel Name Rendered STRICTLY Inside the TV Screen -->
    <text x="0" y="0" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="bold" fill="#000000" fill-opacity="0.7" letter-spacing="1" transform="translate(0, 5)">
      ${textSpans}
    </text>
    <text x="0" y="0" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="bold" fill="#FFFFFF" letter-spacing="1">
      ${textSpans}
    </text>

    <!-- TV Control Knobs / Accent Dots -->
    <circle cx="170" cy="115" r="6" fill="#007AFF" opacity="0.8" />
    <circle cx="148" cy="115" r="6" fill="#AF52DE" opacity="0.8" />
  </g>

  <!-- Bottom TV Channel Pill Badge -->
  <g transform="translate(300, 780)">
    <rect x="-120" y="-20" width="240" height="40" rx="20" fill="url(#accentGrad)" />
    <text x="0" y="6" font-family="Arial, Helvetica, sans-serif" font-size="15" font-weight="bold" fill="#FFFFFF" text-anchor="middle" letter-spacing="2.5">TV CHANNEL</text>
  </g>
</svg>`;
}

// Landscape 16:9 Backdrop / Banner (600 x 338) - 25% smaller TV set & no LIVE TV badge
function generateChannelBackdropSvg(name, backdropUrl = "") {
  const cleanName = (name || "TV Channel").trim();
  const lines = wrapSvgText(cleanName, 12, 2);
  
  const maxLen = Math.max(...lines.map((l) => l.length));
  let fontSize = 21;
  if (maxLen > 7 || lines.length >= 2) fontSize = 16;
  if (maxLen > 11) fontSize = 13;
  const lineHeight = fontSize * 1.18;

  // TV Screen Center is (0, 0) inside <g transform="translate(300, 169)">
  const startY = -((lines.length - 1) * lineHeight) / 2 + (fontSize * 0.35);

  const bgImageSvg = backdropUrl && backdropUrl.startsWith("http")
    ? `<image href="${escapeXml(backdropUrl)}" width="600" height="338" preserveAspectRatio="xMidYMid slice" opacity="0.25" filter="url(#blur)" />`
    : "";

  const textSpans = lines.map((line, idx) => {
    return `<tspan x="0" y="${startY + (idx * lineHeight)}">${escapeXml(line.toUpperCase())}</tspan>`;
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 338" width="600" height="338">
  <defs>
    <linearGradient id="bgGradL" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0b0d14" />
      <stop offset="50%" stop-color="#131726" />
      <stop offset="100%" stop-color="#06070a" />
    </linearGradient>
    <linearGradient id="accentGradL" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#007AFF" />
      <stop offset="50%" stop-color="#5856D6" />
      <stop offset="100%" stop-color="#AF52DE" />
    </linearGradient>
    <linearGradient id="tvBezelL" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#1f2438" />
      <stop offset="100%" stop-color="#0d0f17" />
    </linearGradient>
    <linearGradient id="tvScreenL" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#141829" />
      <stop offset="50%" stop-color="#0e111d" />
      <stop offset="100%" stop-color="#080a11" />
    </linearGradient>
    <linearGradient id="overlayGradL" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#06070a" stop-opacity="0.85" />
      <stop offset="50%" stop-color="#06070a" stop-opacity="0.45" />
      <stop offset="100%" stop-color="#06070a" stop-opacity="0.9" />
    </linearGradient>
    <filter id="blur" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="16" />
    </filter>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="16" result="blur" />
      <feComposite in="SourceGraphic" in2="blur" operator="over" />
    </filter>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#000000" flood-opacity="1" />
    </filter>
  </defs>

  <!-- Background -->
  <rect width="600" height="338" fill="url(#bgGradL)" />
  ${bgImageSvg}
  <rect width="600" height="338" fill="url(#overlayGradL)" />

  <!-- Outer Frame Border -->
  <rect x="12" y="12" width="576" height="314" rx="20" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="2" />

  <!-- Centered TV Set (25% smaller, with Channel Name INSIDE) -->
  <g transform="translate(300, 169)">
    <!-- Antenna -->
    <path d="M-20,-72 L0,-54 L20,-72" fill="none" stroke="rgba(255,255,255,0.7)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    <circle cx="-20" cy="-72" r="2.8" fill="#007AFF" filter="url(#glow)" />
    <circle cx="20" cy="-72" r="2.8" fill="#AF52DE" filter="url(#glow)" />

    <!-- Ambient Glow -->
    <rect x="-118.5" y="-48" width="237" height="96" rx="12" fill="url(#accentGradL)" opacity="0.25" filter="url(#glow)" />

    <!-- TV Bezel -->
    <rect x="-112.5" y="-45" width="225" height="90" rx="11" fill="url(#tvBezelL)" stroke="rgba(255,255,255,0.3)" stroke-width="1.8" />

    <!-- TV Screen Glass -->
    <rect x="-101" y="-37" width="202" height="74" rx="8" fill="url(#tvScreenL)" stroke="rgba(0,122,255,0.5)" stroke-width="1.2" />

    <!-- Broadcast Wave inside TV -->
    <path d="M-34,-24 Q-17,-32 0,-24 T34,-24" fill="none" stroke="url(#accentGradL)" stroke-width="1.5" stroke-linecap="round" opacity="0.8" />

    <!-- Channel Name Rendered STRICTLY Inside TV Screen -->
    <text x="0" y="0" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="bold" fill="#000000" fill-opacity="0.7" letter-spacing="1" transform="translate(0, 5)">
      ${textSpans}
    </text>
    <text x="0" y="0" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="bold" fill="#FFFFFF" letter-spacing="1">
      ${textSpans}
    </text>

    <!-- TV Control Knobs / Accent Dots -->
    <circle cx="86" cy="25" r="2.5" fill="#007AFF" opacity="0.8" />
    <circle cx="76" cy="25" r="2.5" fill="#AF52DE" opacity="0.8" />
  </g>
</svg>`;
}

function getChannelBackdropUrl(payload) {
  if (payload.backdrop && payload.backdrop.startsWith("http") && !payload.backdrop.includes("/api/channel-")) {
    return payload.backdrop;
  }
  if (payload.items && payload.items.length) {
    for (const it of payload.items) {
      if (it.backdrop && it.backdrop.startsWith("http") && !it.backdrop.includes("/api/channel-")) return it.backdrop;
      if (it.showBackdrop && it.showBackdrop.startsWith("http") && !it.showBackdrop.includes("/api/channel-")) return it.showBackdrop;
      if (it.thumbnail && it.thumbnail.startsWith("http") && !it.thumbnail.includes("/api/channel-")) return it.thumbnail;
    }
  }
  // If a custom URL poster was set but no separate backdrop was saved, use the poster URL as the backdrop too
  if (payload.poster && payload.poster.startsWith("http") && !payload.poster.includes("/api/channel-")) {
    return payload.poster;
  }
  return "";
}

function getChannelPoster(payload, origin) {
  const name = payload.name || "TV Channel";
  const backdrop = getChannelBackdropUrl(payload);
  const params = new URLSearchParams();
  params.set("name", name);
  params.set("v", "6");
  if (backdrop) params.set("bg", backdrop);
  if (origin) {
    return `${origin}/api/channel-poster?${params.toString()}`;
  }
  return `/api/channel-poster?${params.toString()}`;
}

function getChannelBackdrop(payload, origin) {
  const name = payload.name || "TV Channel";
  const backdrop = getChannelBackdropUrl(payload);
  const params = new URLSearchParams();
  params.set("name", name);
  params.set("format", "landscape");
  params.set("v", "6");
  if (backdrop) params.set("bg", backdrop);
  if (origin) {
    return `${origin}/api/channel-poster?${params.toString()}`;
  }
  return `/api/channel-poster?${params.toString()}`;
}

function extractLogoPath(rawPoster) {
  if (!rawPoster) return "";
  const s = String(rawPoster).trim();
  if (s.includes("path=")) {
    try {
      const u = new URL(s, "http://localhost");
      return u.searchParams.get("path") || "";
    } catch (e) {
      const match = s.match(/path=([^&]+)/);
      return match ? decodeURIComponent(match[1]) : "";
    }
  }
  if (s.includes("image.tmdb.org/t/p/")) {
    const parts = s.split("image.tmdb.org/t/p/");
    if (parts[1]) {
      return parts[1].replace(/^[^/]+/, "");
    }
  }
  if (s.startsWith("/")) return s;
  return "";
}

function getPremadeChannelLogo(payload, origin, isLandscape = false) {
  const logoPath = extractLogoPath(payload.poster || payload.logo || "");
  if (!logoPath) {
    return isLandscape ? getChannelBackdrop(payload, origin) : getChannelPoster(payload, origin);
  }
  const params = new URLSearchParams();
  params.set("path", logoPath);
  params.set("v", "7");
  if (isLandscape) params.set("format", "landscape");
  if (origin) return `${origin}/api/channel-logo?${params.toString()}`;
  return `/api/channel-logo?${params.toString()}`;
}

function generateBadgedPosterSvg({ posterUrl, airDateText, bottomText, bottomBg, bottomBorder, bottomColor }) {
  const safePoster = escapeXml(posterUrl || '');
  const safeAirDate = escapeXml(airDateText || '');
  const safeBottom = escapeXml(bottomText || '');

  // Top Air Date pill: Extra-large 36px font, 72px height, generous padding
  const topPillWidth = Math.max(160, (safeAirDate.length * 26) + 56);

  // Bottom Badge pill: Extra-large 38px font, 84px height, centered
  const bottomPillWidth = Math.max(380, (safeBottom.length * 24) + 64);

  const topBadgeSvg = safeAirDate ? `
    <g transform="translate(24, 24)">
      <rect x="0" y="0" width="${topPillWidth}" height="72" rx="16" ry="16" fill="#007aff" fill-opacity="0.95" stroke="#66b8ff" stroke-width="3.5" filter="drop-shadow(0px 6px 12px rgba(0,0,0,0.8))"/>
      <text x="${topPillWidth / 2}" y="49" font-family="Arial, Helvetica, sans-serif" font-size="36" font-weight="bold" fill="#ffffff" text-anchor="middle" letter-spacing="1.2">${safeAirDate}</text>
    </g>` : '';

  const bottomBadgeSvg = safeBottom ? `
    <g transform="translate(250, 715)">
      <rect x="${-bottomPillWidth / 2}" y="-84" width="${bottomPillWidth}" height="84" rx="20" ry="20" fill="${bottomBg || '#ff9f0a'}" fill-opacity="0.95" stroke="${bottomBorder || 'rgba(255,159,10,0.7)'}" stroke-width="4.5" filter="drop-shadow(0px 8px 16px rgba(0,0,0,0.85))"/>
      <text x="0" y="-30" font-family="Arial, Helvetica, sans-serif" font-size="38" font-weight="bold" fill="${bottomColor || '#ffffff'}" text-anchor="middle" letter-spacing="1.5">${safeBottom}</text>
    </g>` : '';

  const topGradient = safeAirDate ? `
    <rect x="0" y="0" width="500" height="220" fill="url(#topScrim)" opacity="0.85"/>` : '';

  const bottomGradient = safeBottom ? `
    <rect x="0" y="420" width="500" height="330" fill="url(#bottomScrim)" opacity="0.95"/>` : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="500" height="750" viewBox="0 0 500 750">
  <defs>
    <linearGradient id="topScrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="bottomScrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.98"/>
    </linearGradient>
  </defs>
  <rect width="500" height="750" fill="#151722"/>
  ${safePoster ? `<image href="${safePoster}" xlink:href="${safePoster}" x="0" y="0" width="500" height="750" preserveAspectRatio="xMidYMid slice"/>` : ''}
  ${topGradient}
  ${bottomGradient}
  ${topBadgeSvg}
  ${bottomBadgeSvg}
</svg>`;
}

function isAdultOrNsfw(item) {
  if (!item) return false;
  if (item.adult === true || item.isAdult === true) return true;
  const cert = String(item.certification || item.ageRating || item.contentRating || '').toUpperCase().trim();
  if (['NC-17', 'X', 'XXX', 'R18+', '18+', 'RX', 'TV-MA (ADULT)', 'TV-MA-S', 'ADULT'].includes(cert)) return true;
  const genres = Array.isArray(item.genres)
    ? item.genres.map((g) => (typeof g === 'string' ? g : g?.name || '').toLowerCase().trim())
    : (typeof item.genres === 'string' ? item.genres.toLowerCase().split(',').map((g) => g.trim()) : []);
  const nsfwTerms = ['adult', 'erotic', 'erotica', 'hentai', 'ecchi', 'porn', 'pornography', 'xxx', 'softcore', 'hardcore'];
  if (genres.some((g) => nsfwTerms.some((t) => g === t || g.includes(t)))) return true;
  const text = [item.name, item.title, item.showTitle, item.listName, item.franchise, item.user]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (text) {
    const explicitPattern = /\b(hentai|porn|pornography|erotica|erotic|blowjob|creampie|gangbang|milf|dildo|masturbation|fetish|bdsm|softcore|hardcore|top wet girls|evil angel|brazzers|naughty america|wicked pictures|reality kings|jules jordan|sweet sinner)\b/i;
    if (explicitPattern.test(text)) return true;
  }
  return false;
}

function generateSafePosterSvg({ title, year, type, certification }) {
  const safeTitle = escapeXml(title || 'Untitled');
  const safeYear = escapeXml(year ? String(year).slice(0, 4) : '');
  const safeType = escapeXml(type ? (type.toLowerCase() === 'movie' ? 'MOVIE' : 'SERIES') : 'TITLE');
  const safeCert = escapeXml(certification || 'AGE-FILTERED');
  
  const words = safeTitle.split(/\s+/);
  const lines = [];
  let currentLine = '';
  for (const w of words) {
    if ((currentLine + ' ' + w).trim().length <= 18) {
      currentLine = (currentLine + ' ' + w).trim();
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = w;
    }
  }
  if (currentLine) lines.push(currentLine);
  const displayLines = lines.slice(0, 4);
  if (lines.length > 4) displayLines[3] += '...';
  
  const titleTextSpans = displayLines.map((l, i) => `<tspan x="250" dy="${i === 0 ? 0 : 44}">${l}</tspan>`).join('');
  const titleStartY = 370 - ((displayLines.length - 1) * 22);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="750" viewBox="0 0 500 750">
  <defs>
    <linearGradient id="safeBgGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#141824"/>
      <stop offset="50%" stop-color="#0f111a"/>
      <stop offset="100%" stop-color="#07090e"/>
    </linearGradient>
    <linearGradient id="shieldGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#10b981"/>
      <stop offset="100%" stop-color="#059669"/>
    </linearGradient>
    <filter id="safeShadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="#000000" flood-opacity="0.6"/>
    </filter>
  </defs>
  <rect width="500" height="750" fill="url(#safeBgGrad)"/>
  <rect x="15" y="15" width="470" height="720" rx="16" ry="16" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="2"/>
  
  <!-- Safe Badge Pill at top -->
  <g transform="translate(250, 60)" filter="url(#safeShadow)">
    <rect x="-140" y="0" width="280" height="42" rx="21" ry="21" fill="url(#shieldGrad)"/>
    <text x="0" y="27" font-family="Arial, Helvetica, sans-serif" font-size="16" font-weight="bold" fill="#ffffff" text-anchor="middle" letter-spacing="1.5">SAFE POSTER</text>
  </g>

  <!-- Central Shield / Film Icon -->
  <g transform="translate(250, 200)" filter="url(#safeShadow)">
    <circle cx="0" cy="0" r="54" fill="rgba(16,185,129,0.12)" stroke="#10b981" stroke-width="3"/>
    <!-- Lock / Shield Vector -->
    <path d="M-18,-10 C-18,-20 18,-20 18,-10 L18,8 C18,22 0,32 0,32 C0,32 -18,22 -18,8 Z" fill="#10b981"/>
    <circle cx="0" cy="3" r="4" fill="#0f111a"/>
    <path d="M-2,3 L2,3 L1,11 L-1,11 Z" fill="#0f111a"/>
  </g>

  <!-- Title -->
  <text x="250" y="${titleStartY}" font-family="Arial, Helvetica, sans-serif" font-size="34" font-weight="bold" fill="#f3f4f6" text-anchor="middle" letter-spacing="0.5" filter="url(#safeShadow)">
    ${titleTextSpans}
  </text>

  <!-- Metadata: Type & Year -->
  <g transform="translate(250, 560)">
    <rect x="-90" y="-18" width="180" height="36" rx="8" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.12)" stroke-width="1.5"/>
    <text x="0" y="6" font-family="Arial, Helvetica, sans-serif" font-size="16" font-weight="bold" fill="#9ca3af" text-anchor="middle" letter-spacing="1">
      ${safeType}${safeYear ? ' • ' + safeYear : ''}
    </text>
  </g>

  <!-- Certification / Footer -->
  <g transform="translate(250, 680)">
    <text x="0" y="0" font-family="Arial, Helvetica, sans-serif" font-size="14" font-weight="600" fill="#6b7280" text-anchor="middle" letter-spacing="0.8">
      ${safeCert ? safeCert + ' • ' : ''}AGE-APPROPRIATE FILTER ACTIVE
    </text>
  </g>
</svg>`;
}

function getSafePosterUrl(origin, { title, year, type, certification }) {
  const params = new URLSearchParams();
  if (title) params.set("title", title);
  if (year) params.set("year", year);
  if (type) params.set("type", type);
  if (certification) params.set("cert", certification);
  if (origin) {
    return `${origin.replace(/\/+$/, "")}/api/safe-poster?${params.toString()}`;
  }
  return `/api/safe-poster?${params.toString()}`;
}

function applyAdultContentFilterToMetas(metas, origin, parentEntry) {
  if (!Array.isArray(metas) || !metas.length) return metas;
  const isParentAdult = parentEntry && isAdultOrNsfw(parentEntry);
  const tot = metas.totalItems;
  const mapped = metas.map((m) => {
    if (!m) return m;
    const isAdult = isParentAdult || isAdultOrNsfw(m);
    if (!isAdult) return m;
    const safeUrl = getSafePosterUrl(origin, {
      title: m.name || m.title || '',
      year: m.releaseInfo || (m.year ? String(m.year) : ''),
      type: m.type || m.mediatype || '',
      certification: m.certification || m.ageRating || m.contentRating || ''
    });
    return {
      ...m,
      adult: true,
      isAdult: true,
      poster: safeUrl,
      isAdultPosterFiltered: true,
    };
  });
  mapped.totalItems = tot;
  return mapped;
}

// --- BetterPosters (https://btttr.cc) -------------------------------------
// Replacement artwork with the metadata burned into the image itself. See the
// contract note on BETTER_POSTERS_ORIGIN (00_constants.js) for the URL shape
// and why the "poster-default" segment is a fixed literal rather than a style.

const BETTER_POSTERS_IMDB_RE = /(?:^|[^a-z0-9])(tt\d{5,12})(?=$|[^0-9])/i;

// tt0000000 is this add-on's own "temporarily unavailable" placeholder (see
// the catalog route's catch in 25), not a title BetterPosters could render.
const BETTER_POSTERS_PLACEHOLDER_ID = "tt0000000";

// Deliberately reads the id fields only, never meta.poster. Several posters
// this add-on builds itself carry an id in their query string
// (/api/poster-badge?...&id=tt123...), so scraping the poster URL -- which is
// what the nuvio-better-posters-addon project does -- would make an
// already-processed poster look like a plain IMDB title and send it back
// through BetterPosters a second time.
function betterPostersImdbId(meta) {
  if (!meta || typeof meta !== "object") return null;
  for (const candidate of [meta.imdb_id, meta.imdbId, meta.imdb, meta.id]) {
    if (typeof candidate !== "string") continue;
    const hit = candidate.match(BETTER_POSTERS_IMDB_RE);
    if (!hit) continue;
    const id = hit[1].toLowerCase();
    if (id !== BETTER_POSTERS_PLACEHOLDER_ID) return id;
  }
  return null;
}

// Mirrors updateAioUrl() in btttr.cc's own configurator: the bottom-row choice
// picks the stem, then the quality/age flags are appended to it -- with a "-"
// only when the stem does not already carry one. So genre+rating+quality is
// "poster-q", genre-only+quality is "poster-gq".
function betterPostersBase(opts) {
  const genre = opts.genre !== false;
  const rating = opts.rating !== false;
  let base;
  if (genre && rating) base = "poster";
  else if (genre) base = "poster-g";
  else if (rating) base = "poster-r";
  else base = "poster-n";
  const suffix = (opts.quality ? "q" : "") + (opts.age ? "a" : "");
  if (suffix) base += base.includes("-") ? suffix : "-" + suffix;
  return base;
}

function buildBetterPosterUrl(imdbId, opts) {
  const o = opts || {};
  const params = [];
  // Every one of these is omitted at its btttr.cc default, so a default
  // config produces the exact URL its configurator would hand out.
  if (o.trendTags === false) params.push("tag=none");
  if (o.lang && o.lang !== "en" && BETTER_POSTERS_LANGS.some((l) => l.value === o.lang)) {
    params.push("lang=" + encodeURIComponent(o.lang));
  }
  if (o.ratingSource && o.ratingSource !== "avg" && BETTER_POSTERS_RATING_SOURCES.some((r) => r.value === o.ratingSource)) {
    params.push("rs=" + encodeURIComponent(o.ratingSource));
  }
  const qs = params.length ? "?" + params.join("&") : "";
  // Served through this Worker's own copy whenever the caller knows where
  // this Worker lives -- see serveBetterPoster below for why.
  if (o.origin) return `${o.origin}/bp/${betterPostersBase(o)}/${imdbId}.jpg${qs}`;
  return `${BETTER_POSTERS_ORIGIN}/${betterPostersBase(o)}/imdb/poster-default/${imdbId}.jpg${qs}`;
}

// --- The Worker's own copy of BetterPosters artwork ------------------------
//
// btttr.cc serves artwork it has already drawn from Cloudflare's cache in a
// fraction of a second, and draws anything else on request at its origin --
// which, measured, took 40-50 seconds or answered a 504, even for titles as
// common as Ted Lasso (its own homepage 504'd after 30s at the same time). A
// tile waited on it with no error to fall back on: the blank posters all over
// the site that appeared the moment Better Posters was switched off.
//
// So every BetterPosters image the website and the Stremio/Nuvio rows show is
// served from here: /bp/<style>/<imdb id>.jpg[?tag=none&lang=..&rs=..], the
// same style/options btttr.cc's own URL carries. Each one is fetched from
// btttr.cc once, kept in KV (global, so a poster fetched anywhere is instant
// everywhere), fronted by the edge cache, and quietly re-fetched once it is a
// day old so ratings and trend tags move with btttr.cc's. A copy is kept for
// BETTER_POSTER_KEEP_SECONDS past that, so when btttr.cc's origin is having a
// bad day the site does not notice.
//
// A title btttr.cc has never drawn is the one thing a copy cannot cover, and
// measured on 2026-09-24 its origin was answering nothing at all for those: a
// 504 after 30 seconds, or no answer in 90. Nothing waits on that any more.
// A request gives btttr.cc BETTER_POSTER_PAGE_WAIT_MS, then answers without
// it (serveBetterPoster says with what) while the fetch carries on in the
// background; a failure is remembered for BETTER_POSTER_MISS_SECONDS so the
// next tile does not wait on the same dead end, and is put on a list the cron
// retries (prewarmBetterPosters, 07) until btttr.cc draws it.

// Every style betterPostersBase can produce -- the only ones this route
// fetches, so it can never be pointed at anything else on btttr.cc.
const BETTER_POSTER_STYLES = (() => {
  const out = new Set();
  for (const genre of [true, false]) for (const rating of [true, false]) {
    for (const quality of [true, false]) for (const age of [true, false]) {
      out.add(betterPostersBase({ genre, rating, quality, age }));
    }
  }
  return out;
})();
// Re-fetched once a day. More often buys nothing: btttr.cc's CDN itself was
// serving copies 3-7 days old (its Age header) when this was measured, so an
// hourly fetch would bring back the same picture 23 times out of 24.
const BETTER_POSTER_REFRESH_MS = 86400 * 1000;
const BETTER_POSTER_KEEP_SECONDS = 60 * 86400;
// For work nothing is waiting on: the cron and /api/bp/warm.
const BETTER_POSTER_UPSTREAM_TIMEOUT_MS = 55000;
// For a fetch a tile started, which carries on after the tile is answered --
// under waitUntil, which the runtime stops 30 seconds after the response.
const BETTER_POSTER_BACKGROUND_TIMEOUT_MS = 25000;
// How long a tile waits on btttr.cc. Anything it has drawn comes back well
// inside this (0.2-1.2s measured); anything it has not takes 30s or more.
const BETTER_POSTER_PAGE_WAIT_MS = 6000;
const BETTER_POSTER_MISS_SECONDS = 600;
const BETTER_POSTER_MAX_BYTES = 5 * 1024 * 1024;

// /bp/... -> the one poster it names, or null for anything that is not a
// style/id/option combination buildBetterPosterUrl could have produced.
function parseBetterPosterPath(pathname, searchParams) {
  const m = /^\/bp\/([a-z-]+)\/(tt\d{5,12})\.jpg$/.exec(String(pathname || ""));
  if (!m || !BETTER_POSTER_STYLES.has(m[1])) return null;
  const tag = searchParams.get("tag") === "none" ? "none" : "";
  const langRaw = searchParams.get("lang") || "";
  const lang = BETTER_POSTERS_LANGS.some((l) => l.value === langRaw && l.value !== "en") ? langRaw : "";
  const rsRaw = searchParams.get("rs") || "";
  const rs = BETTER_POSTERS_RATING_SOURCES.some((r) => r.value === rsRaw && r.value !== "avg") ? rsRaw : "";
  const params = [];
  if (tag) params.push("tag=none");
  if (lang) params.push("lang=" + encodeURIComponent(lang));
  if (rs) params.push("rs=" + encodeURIComponent(rs));
  const qs = params.length ? "?" + params.join("&") : "";
  return {
    style: m[1],
    imdbId: m[2],
    tag,
    lang,
    rs,
    path: `/bp/${m[1]}/${m[2]}.jpg${qs}`,
    upstream: `${BETTER_POSTERS_ORIGIN}/${m[1]}/imdb/poster-default/${m[2]}.jpg${qs}`,
    kvKey: `bpimg:v1:${m[1]}:${m[2]}:${tag}:${lang}:${rs}`,
  };
}

function betterPosterImageResponse(bytes, contentType) {
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": contentType || "image/jpeg",
      // Six hours in the browser and at the edge -- btttr.cc's own lifetime
      // for the same image -- and a day more while a newer copy is fetched.
      "Cache-Control": "public, max-age=21600, stale-while-revalidate=86400",
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// One upstream fetch per poster per isolate at a time: the warm request and
// the tile's own request for the same poster share it.
const BETTER_POSTER_IN_FLIGHT = new Map();

async function fetchBetterPosterUpstream(env, bp, timeoutMs) {
  if (BETTER_POSTER_IN_FLIGHT.has(bp.kvKey)) return BETTER_POSTER_IN_FLIGHT.get(bp.kvKey);
  const p = (async () => {
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs || BETTER_POSTER_UPSTREAM_TIMEOUT_MS) : null;
    try {
      const res = await fetch(bp.upstream, {
        headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
        signal: ctl ? ctl.signal : undefined,
      });
      const contentType = res.headers.get("content-type") || "";
      if (!res.ok || !contentType.startsWith("image/")) return null;
      const bytes = await res.arrayBuffer();
      if (!bytes.byteLength || bytes.byteLength > BETTER_POSTER_MAX_BYTES) return null;
      if (env && env.CONFIGS) {
        await env.CONFIGS.put(bp.kvKey, bytes, {
          expirationTtl: BETTER_POSTER_KEEP_SECONDS,
          metadata: { ct: contentType, at: Date.now() },
        }).catch(() => {});
      }
      BETTER_POSTER_MISSES.delete(bp.kvKey);
      return { bytes, contentType };
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
      BETTER_POSTER_IN_FLIGHT.delete(bp.kvKey);
    }
  })();
  BETTER_POSTER_IN_FLIGHT.set(bp.kvKey, p);
  return p;
}

// The stored copy, if there is one -- and a background refresh when it is
// more than a day old.
async function readStoredBetterPoster(env, ctx, bp) {
  if (!env || !env.CONFIGS) return null;
  try {
    const got = await env.CONFIGS.getWithMetadata(bp.kvKey, { type: "arrayBuffer" });
    if (!got || !got.value) return null;
    const meta = got.metadata || {};
    const at = Number(meta.at) || 0;
    if (Date.now() - at > BETTER_POSTER_REFRESH_MS && ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(fetchBetterPosterUpstream(env, bp, BETTER_POSTER_BACKGROUND_TIMEOUT_MS));
    }
    return { bytes: got.value, contentType: meta.ct || "image/jpeg", at };
  } catch {
    return null;
  }
}

// --- Posters btttr.cc just failed to supply -----------------------------------
//
// Remembered here (this isolate) and in the edge cache (every isolate in this
// data centre) for BETTER_POSTER_MISS_SECONDS, so a page of tiles for titles
// btttr.cc cannot draw right now is answered at once instead of each one
// waiting on a fetch that failed a minute ago. The cron's retries (and
// /api/bp/warm's) ignore it; they are the ones meant to try again.
const BETTER_POSTER_MISSES = new Map();

function betterPosterMissRequest(origin, bp) {
  const cache = typeof caches !== "undefined" && caches.default ? caches.default : null;
  return cache && origin ? { cache, req: new Request(origin + "/bp-miss" + bp.path) } : null;
}

async function betterPosterRecentlyMissed(origin, bp) {
  const until = BETTER_POSTER_MISSES.get(bp.kvKey);
  if (until && until > Date.now()) return true;
  const edge = betterPosterMissRequest(origin, bp);
  if (!edge) return false;
  try {
    return !!(await edge.cache.match(edge.req));
  } catch {
    return false;
  }
}

async function noteBetterPosterMiss(origin, bp) {
  BETTER_POSTER_MISSES.set(bp.kvKey, Date.now() + BETTER_POSTER_MISS_SECONDS * 1000);
  if (BETTER_POSTER_MISSES.size > 5000) {
    const now = Date.now();
    for (const [k, until] of BETTER_POSTER_MISSES) if (until <= now) BETTER_POSTER_MISSES.delete(k);
  }
  const edge = betterPosterMissRequest(origin, bp);
  if (!edge) return;
  try {
    await edge.cache.put(edge.req, new Response("", { headers: { "Cache-Control": `max-age=${BETTER_POSTER_MISS_SECONDS}` } }));
  } catch {}
}

// --- ...and the list the cron retries them from ------------------------------
//
// { "/bp/<style>/<id>.jpg?...": { at: first failed } }. Misses
// are collected per isolate and written at most once a minute -- one KV write
// for a page full of them, not one each -- and /api/bp/warm writes its whole
// batch's worth when it finishes.
const BETTER_POSTER_RETRY_KEY = "bp:retry:v1";
const BETTER_POSTER_RETRY_MAX = 500;
const BETTER_POSTER_RETRY_KEEP_MS = 3 * 86400 * 1000;
const _betterPosterRetryPending = new Map();
let _betterPosterRetryFlushedAt = 0;

function queueBetterPosterRetry(bp) {
  if (!_betterPosterRetryPending.has(bp.path)) _betterPosterRetryPending.set(bp.path, Date.now());
}

async function flushBetterPosterRetries(env, force) {
  if (!env || !env.CONFIGS || !_betterPosterRetryPending.size) return;
  const now = Date.now();
  if (!force && now - _betterPosterRetryFlushedAt < 60000) return;
  _betterPosterRetryFlushedAt = now;
  const add = [..._betterPosterRetryPending];
  _betterPosterRetryPending.clear();
  try {
    const raw = await env.CONFIGS.get(BETTER_POSTER_RETRY_KEY);
    const list = readBetterPosterRetries(raw);
    let changed = false;
    for (const [path, at] of add) {
      if (!list[path]) { list[path] = { at }; changed = true; }
    }
    if (changed) await env.CONFIGS.put(BETTER_POSTER_RETRY_KEY, JSON.stringify(trimBetterPosterRetries(list, now)));
  } catch {}
}

function readBetterPosterRetries(raw) {
  try {
    const list = raw ? JSON.parse(raw) : {};
    return list && typeof list === "object" && !Array.isArray(list) ? list : {};
  } catch {
    return {};
  }
}

// Drops what has been failing for BETTER_POSTER_RETRY_KEEP_MS (the next
// visitor to see it puts it back), then keeps the newest if still over.
function trimBetterPosterRetries(list, now) {
  const kept = Object.entries(list)
    .filter(([, e]) => e && now - (Number(e.at) || 0) <= BETTER_POSTER_RETRY_KEEP_MS)
    .sort((a, b) => (Number(b[1].at) || 0) - (Number(a[1].at) || 0))
    .slice(0, BETTER_POSTER_RETRY_MAX);
  return Object.fromEntries(kept);
}

// Fetches one poster from btttr.cc on behalf of a page, and records the
// outcome: into the edge cache when it worked, as a miss (and a retry) when
// it did not.
async function fetchBetterPosterForPage(env, ctx, bp, origin, timeoutMs) {
  const found = await fetchBetterPosterUpstream(env, bp, timeoutMs);
  const cache = typeof caches !== "undefined" && caches.default ? caches.default : null;
  if (found && cache && origin) {
    try {
      await cache.put(new Request(origin + bp.path), betterPosterImageResponse(found.bytes, found.contentType));
    } catch {}
  } else if (!found) {
    await noteBetterPosterMiss(origin, bp);
    queueBetterPosterRetry(bp);
  }
  return found;
}

// The bytes for one poster from wherever they are nearest: the edge cache,
// the stored copy, or btttr.cc. btttr.cc gets opts.waitMs when given -- after
// that this returns null and the fetch finishes in the background, so the
// next request finds it stored -- and is not asked at all about a poster it
// failed to supply in the last BETTER_POSTER_MISS_SECONDS.
async function getBetterPoster(env, ctx, bp, origin, opts) {
  const waitMs = opts && opts.waitMs;
  const cache = typeof caches !== "undefined" && caches.default ? caches.default : null;
  const cacheReq = cache && origin ? new Request(origin + bp.path) : null;
  const background = (p) => { if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p); };
  if (cacheReq) {
    try {
      const hit = await cache.match(cacheReq);
      if (hit) {
        return { bytes: await hit.arrayBuffer(), contentType: hit.headers.get("content-type") || "image/jpeg", fromEdge: true };
      }
    } catch {}
  }
  const stored = await readStoredBetterPoster(env, ctx, bp);
  if (stored) {
    if (cacheReq) background(cache.put(cacheReq, betterPosterImageResponse(stored.bytes, stored.contentType)).catch(() => {}));
    return stored;
  }
  if (await betterPosterRecentlyMissed(origin, bp)) return null;
  const pending = fetchBetterPosterForPage(env, ctx, bp, origin, waitMs ? BETTER_POSTER_BACKGROUND_TIMEOUT_MS : BETTER_POSTER_UPSTREAM_TIMEOUT_MS)
    .then(async (found) => {
      if (!found) await flushBetterPosterRetries(env, false);
      return found;
    });
  if (!waitMs) return await pending;
  let timer = null;
  const outcome = await Promise.race([
    pending,
    new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), waitMs); }),
  ]);
  if (timer) clearTimeout(timer);
  if (outcome === undefined) {
    background(pending);
    return null;
  }
  return outcome;
}

// Whether a /bp/ request comes from this Worker's own website, which has its
// own way of standing in for a poster (handlePosterImgError, 23) -- and a way
// to swap the real one in when it arrives, which an app does not.
function isOwnSiteRequest(request, origin) {
  if (!request || !request.headers || !origin) return false;
  const site = request.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const ref = request.headers.get("referer") || "";
  return ref === origin || ref.startsWith(origin + "/");
}

// The title's ordinary poster, for an app to show while its Better Poster is
// unavailable. Never cached anywhere, so the app asks again next time and gets
// the Better Poster as soon as there is one.
async function betterPosterStandIn(bp) {
  try {
    const res = await fetch(`https://images.metahub.space/poster/medium/${bp.imdbId}/img`, {
      cf: { cacheTtl: 86400, cacheEverything: true },
    });
    const contentType = res.headers.get("content-type") || "";
    if (!res.ok || !contentType.startsWith("image/")) return null;
    const bytes = await res.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength > BETTER_POSTER_MAX_BYTES) return null;
    return { bytes, contentType };
  } catch {
    return null;
  }
}

// --- Which styles are in use, for the cron's pre-fetch -----------------------
//
// Every combination of style options is its own image, so the cron can only
// fetch ahead for combinations someone actually uses. Recorded as posters are
// served, at most once per style per isolate every few hours, and written only
// when the stored record is missing it or a day stale -- a handful of KV
// writes a day, not one per poster.
const BETTER_POSTER_VARIANTS_KEY = "bp:variants:v1";
const BETTER_POSTER_VARIANT_TTL_MS = 14 * 86400 * 1000;
const _betterPosterVariantNoted = new Map();

function betterPosterVariantKey(bp) {
  return `${bp.style}|${bp.tag}|${bp.lang}|${bp.rs}`;
}

async function noteBetterPosterVariant(env, bp) {
  if (!env || !env.CONFIGS || !bp) return;
  const key = betterPosterVariantKey(bp);
  const now = Date.now();
  if (now - (_betterPosterVariantNoted.get(key) || 0) < 6 * 3600 * 1000) return;
  _betterPosterVariantNoted.set(key, now);
  try {
    const raw = await env.CONFIGS.get(BETTER_POSTER_VARIANTS_KEY);
    const seen = raw ? JSON.parse(raw) : {};
    if (now - (Number(seen[key]) || 0) < 86400 * 1000) return;
    seen[key] = now;
    for (const k of Object.keys(seen)) if (now - Number(seen[k]) > BETTER_POSTER_VARIANT_TTL_MS) delete seen[k];
    await env.CONFIGS.put(BETTER_POSTER_VARIANTS_KEY, JSON.stringify(seen));
  } catch {}
}

// The styles used within BETTER_POSTER_VARIANT_TTL_MS, as posters for one
// title: variant -> the parsed /bp/ path for that title in that style.
async function betterPosterVariantsInUse(env) {
  if (!env || !env.CONFIGS) return [];
  try {
    const raw = await env.CONFIGS.get(BETTER_POSTER_VARIANTS_KEY);
    const seen = raw ? JSON.parse(raw) : {};
    const now = Date.now();
    return Object.keys(seen).filter((k) => now - Number(seen[k]) <= BETTER_POSTER_VARIANT_TTL_MS).map((k) => {
      const [style, tag, lang, rs] = k.split("|");
      return { style, tag, lang, rs };
    });
  } catch {
    return [];
  }
}

function betterPosterForVariant(imdbId, v) {
  const params = new URLSearchParams();
  if (v.tag) params.set("tag", v.tag);
  if (v.lang) params.set("lang", v.lang);
  if (v.rs) params.set("rs", v.rs);
  return parseBetterPosterPath(`/bp/${v.style}/${imdbId}.jpg`, params);
}

async function serveBetterPoster(env, ctx, bp, origin, request) {
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(noteBetterPosterVariant(env, bp));
  const found = await getBetterPoster(env, ctx, bp, origin, { waitMs: BETTER_POSTER_PAGE_WAIT_MS });
  if (found) return betterPosterImageResponse(found.bytes, found.contentType);
  const unavailable = { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" };
  // The website shows the title's ordinary poster itself, and swaps this one
  // in when /api/bp/warm reports it fetched.
  if (isOwnSiteRequest(request, origin)) {
    return new Response(null, { status: 503, headers: { ...unavailable, "Retry-After": "30" } });
  }
  // An app has no such fallback: an error is a blank tile. So it gets the
  // ordinary poster from this same URL, uncached, until the Better one exists.
  const standIn = await betterPosterStandIn(bp);
  if (standIn) {
    return new Response(standIn.bytes, {
      status: 200,
      headers: { ...unavailable, "Content-Type": standIn.contentType, "X-Content-Type-Options": "nosniff", "X-Better-Poster": "pending" },
    });
  }
  return new Response(null, { status: 502, headers: unavailable });
}

// Packs a resolved config's betterPosters* keys into the shape
// buildBetterPosterUrl reads. Each default matches btttr.cc's own default for
// that option, so an install that never touched the style controls gets the
// same artwork its configurator hands out.
function betterPostersOptionsFrom(cfg, origin) {
  const c = cfg || {};
  return {
    // This Worker's own origin, so posters are served from its copy (see
    // serveBetterPoster). Left off, the URL points at btttr.cc directly.
    ...(origin ? { origin } : {}),
    genre: c.betterPostersGenre !== false,
    rating: c.betterPostersRating !== false,
    quality: !!c.betterPostersQuality,
    age: !!c.betterPostersAge,
    trendTags: c.betterPostersTrendTags !== false,
    lang: c.betterPostersLang || "en",
    ratingSource: c.betterPostersRatingSource || "avg",
  };
}

// Single-meta form, for the /meta/ detail route.
function applyBetterPosterToMeta(meta, opts) {
  if (!meta || typeof meta !== "object") return meta;
  return applyBetterPostersToMetas([meta], opts)[0];
}

// 1:1 map, same shape as applyBadgedPostersToMetas/applyAdultContentFilterToMetas
// below -- it only ever swaps a poster URL, never which ids come back.
function applyBetterPostersToMetas(metas, opts) {
  if (!Array.isArray(metas) || !metas.length) return metas;
  const tot = metas.totalItems;
  const mapped = metas.map((m) => {
    if (!m) return m;
    // BetterPosters only renders 2:3 artwork, so a landscape shelf (a TV
    // channel's 16:9 banner) keeps whatever it already had rather than
    // getting a portrait poster squeezed into a widescreen tile.
    if (m.posterShape === "landscape") return m;
    const imdbId = betterPostersImdbId(m);
    if (!imdbId) return m;
    return { ...m, poster: buildBetterPosterUrl(imdbId, opts) };
  });
  mapped.totalItems = tot;
  return mapped;
}

function applyBadgedPostersToMetas(metas, origin) {
  if (!Array.isArray(metas) || !metas.length || !origin) return metas;
  const tot = metas.totalItems;
  const mapped = metas.map((m) => {
    if (!m || !m.poster || m.poster.startsWith("data:image/svg") || m.poster.includes("/api/poster-badge") || m.poster.includes("/api/safe-poster")) return m;
    const isPremiereEp = m.episodeNumber === 1 || m.episodeNum === 1 || (m.episodeNum == null && m.episodeNumber == null);
    const hasAired = m.airDate && typeof isEpisodeAired === "function" ? isEpisodeAired(m.airDate) : false;
    const hasPremiere = !!(m.isSeasonPremiere && isPremiereEp && !hasAired);
    const hasFinale = !!(m.isSeasonFinale && !hasAired);
    const finaleAired = m.seasonFinaleAirDate && typeof isEpisodeAired === "function" ? isEpisodeAired(m.seasonFinaleAirDate) : false;
    const hasFinaleDate = !!(m.seasonFinaleAirDate && !finaleAired);
    const hasAirDate = !!(m.airDate && !m.hideDateBadge && !hasAired);
    const hasCompanion = !!(m.isCompanion);
    if (!hasPremiere && !hasFinale && !hasFinaleDate && !hasAirDate && !hasCompanion) return m;

    const params = new URLSearchParams();
    params.set("poster", m.poster);
    params.set("v", "5");
    if (m.id) params.set("id", m.id);
    if (hasAirDate) params.set("airDate", m.airDate);
    if (hasPremiere) params.set("premiere", "1");
    if (hasFinale) params.set("finale", "1");
    if (hasFinaleDate) params.set("finaleDate", m.seasonFinaleAirDate);
    if (hasCompanion) {
      const compLabel = m.companionType === 'bridge_movie' ? 'Bridge Movie' : (m.companionType === 'sequel_movie' ? 'Sequel Film' : 'Storyline');
      params.set("companion", compLabel);
    }

    const badgedUrl = `${origin.replace(/\/+$/, "")}/api/poster-badge?${params.toString()}`;
    return {
      ...m,
      poster: badgedUrl,
    };
  });
  mapped.totalItems = tot;
  return mapped;
}

function fetchChannelCatalog(entry, origin) {
  const rawUrls = String(entry.url || "").split(/[\r\n]+/).map((u) => u.trim()).filter(Boolean);
  const metas = [];
  const isLandscapeShelf = entry.posterShape === "landscape";
  for (const rawUrl of rawUrls) {
    const payload = parseChannelPayload(rawUrl);
    // A dynamic channel (Next Up) deliberately stores no picks of its own --
    // its lineup is derived per request in buildChannelMeta -- so "no items"
    // is not the same as "nothing to show" for one of those. A Quick Add
    // network channel (presetNetworkId set) is the same story for a
    // different reason: its items live in the shared preset cache, not on
    // this payload -- see parseChannelPayload's own comment. The shelf tile
    // here carries no episodes either way, only the channel's name and art.
    if (!payload) continue;
    if (!payload.dynamic && !payload.presetNetworkId && (!payload.items || !payload.items.length)) continue;
    const channelId = payload.channelId || entry.id;
    const name = payload.name || entry.name;
    
    const isPremadeLogo = Boolean(payload.poster && (payload.poster.includes("/api/channel-logo") || payload.isPreset || payload.networkId));
    const isShowPoster = Boolean(payload.poster && payload.poster.startsWith("http") && !payload.poster.includes("/api/channel-"));
    
    let matchedBackdrop = (payload.backdrop && payload.backdrop.startsWith("http") && !payload.backdrop.includes("/api/channel-")) ? payload.backdrop : null;
    if (isShowPoster && !matchedBackdrop && Array.isArray(payload.items)) {
      const match = payload.items.find((it) => it && (it.showPoster === payload.poster || it.poster === payload.poster));
      if (match) {
        matchedBackdrop = match.backdrop || match.showBackdrop || match.thumbnail || null;
      }
    }

    const channelPoster = isPremadeLogo
      ? getPremadeChannelLogo(payload, origin, isLandscapeShelf)
      : isShowPoster
        ? (isLandscapeShelf ? (matchedBackdrop || payload.poster) : payload.poster)
        : (isLandscapeShelf ? getChannelBackdrop(payload, origin) : getChannelPoster(payload, origin));

    const channelBackdrop = isPremadeLogo
      ? getPremadeChannelLogo(payload, origin, true)
      : (matchedBackdrop || getChannelBackdrop(payload, origin));

    metas.push({
      id: "channel_" + channelId,
      type: "series",
      name: name,
      poster: channelPoster,
      posterShape: isLandscapeShelf ? "landscape" : "poster",
      background: channelBackdrop,
      thumbnail: channelBackdrop,
    });
  }
  return metas;
}

// --- Custom Lists --------------------------------------------------------------
//
// A hand-picked list of movies, shows, or mixed items built by search-and-pick
// in the builder. When served in a catalog shelf, items are automatically filtered
// to match the shelf type (entry.type).
//
// A Custom List someone built lives one of two places: purely in this
// browser's localStorage (no Creator Profile), or on this Worker's own KV
// under creatorlist:{username}:{slug} (signed in, saved via
// /api/creator/lists/save -- see 26_api-creator-and-admin-routes.js). Either
// way, adding it to Catalogs used to bake a one-time snapshot of `items`
// straight into this URL, so an edit made afterward (add/remove/reorder a
// pick) never reached a catalog shelf that already existed -- the shelf,
// and the Live Preview reading the same source, both kept serving whatever
// was true at the moment "+ Add to Catalogs" was clicked. For a
// Creator-hosted list this function now re-reads creatorlist:{owner}:{slug}
// fresh on every catalog request instead, the same live-by-identity
// approach fetchPublishedListCatalog already uses for the separate
// publishedlist: URL scheme just above. A local-only list has no
// server-reachable copy to re-read (localStorage never leaves the browser),
// so those stay snapshot-based -- there's no way around that without also
// giving local lists a KV-backed presence, a much bigger change than this.
// The embedded snapshot is kept as a fallback in all cases: if this isn't a
// creatorSlug row at all, or the owner can't be determined (see liveOwner
// below -- an older saved row's payload may only have creatorSlug, from
// before creatorOwner started getting stamped in; keys.trackCreatorName/
// keys.creatorName cover that using the request's own signed-in account),
// or the KV lookup comes back empty (list since deleted, KV hiccup, made
// private -- fetchLiveCreatorListItems only returns public lists' items),
// this drops straight back to the old behavior rather than serving an
// empty shelf.
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

// Re-reads a Creator-hosted list's current items straight from this
// Worker's own KV, the same key shape /api/creator/lists/save writes to
// and the /lists/:username/:slug viewer route already reads from. Returns
// null (never []) on anything short of a confirmed, parseable, public hit,
// so callers can tell "list has zero items right now" apart from "couldn't
// resolve this live, fall back to the snapshot".
async function fetchLiveCreatorListItems(owner, slug, env) {
  if (!owner || !slug || !env || !env.CONFIGS) return null;
  const ownerLower = String(owner).toLowerCase();
  const slugLower = String(slug).toLowerCase();
  const keysToTry = [
    `creatorlist:${ownerLower}:${slugLower}`,
    `creatorlist:${owner}:${slug}`,
  ];
  for (const k of keysToTry) {
    const raw = await env.CONFIGS.get(k);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.items)) {
        await stampListVisibilityIfNeeded(env, k, parsed);
        if (isPublicListVisibility(parsed.visibility)) {
          return parsed.items;
        }
      }
    } catch {}
  }
  return null;
}

async function fetchCustomListCatalog(entry, skip = 0, keys = {}) {
  const payload = parseCustomListPayload(entry.url);
  if (!payload) return [];

  let sourceItems = payload.items;
  const liveOwner = payload.creatorOwner || (payload.creatorSlug ? (keys.trackCreatorName || keys.creatorName || '') : '');
  if (payload.creatorSlug && liveOwner) {
    const liveItems = await fetchLiveCreatorListItems(liveOwner, payload.creatorSlug, keys.env);
    if (liveItems) sourceItems = liveItems;
  }

  if (!sourceItems || !sourceItems.length) {
    if (payload && (
      (payload.listSlug && (payload.listSlug.startsWith('custom:curated:') || payload.listSlug.startsWith('curated:'))) ||
      (payload.name && (payload.name.toLowerCase().includes('recommended movies') || payload.name.toLowerCase().includes('recommended shows') || payload.name.toLowerCase().trim() === 'recommended'))
    )) {
      return fetchCuratedCatalog({ url: payload.listSlug || (entry.type === 'series' ? 'custom:curated:recommended-shows' : 'custom:curated:recommended-movies'), type: entry.type }, skip, keys);
    }
    return [];
  }
  const items = payload.shuffle
    ? seededShuffle(sourceItems, daysSinceEpochUTC(new Date()) + hashStringToInt(payload.listId || entry.id))
    : sourceItems;
  const mapped = items
    .filter((it) => {
      if (!it || (!it.imdbId && !it.id && !it.showId)) return false;
      const itType = it.kind || it.type;
      if (entry.type === 'movie') {
        if (itType === 'series' || itType === 'tv') return false;
      } else if (entry.type === 'series') {
        if (itType === 'movie') return false;
      }
      return true;
    })
    .map((it) => ({
      id: it.imdbId || it.id || it.showId,
      showId: it.showId || (!it.isMovie && (it.imdbId || it.id)),
      type: entry.type || (it.kind === 'series' || it.type === 'series' || it.type === 'tv' ? 'series' : 'movie'),
      name: it.title || it.name || it.showTitle,
      poster: it.poster || it.showPoster || undefined,
      releaseInfo: it.year || undefined,
      seasonNum: it.seasonNum != null ? it.seasonNum : (it.season != null ? it.season : undefined),
      episodeNum: it.episodeNum != null ? it.episodeNum : (it.episode != null ? it.episode : undefined),
      airDate: it.airDate || undefined,
      airTime: it.airTime || undefined,
      isUnaired: it.isUnaired || undefined,
      isSeasonPremiere: it.isSeasonPremiere || undefined,
      isSeasonFinale: it.isSeasonFinale || undefined,
      seasonFinaleAirDate: it.seasonFinaleAirDate || undefined,
      seasonFinaleEpisodeNumber: it.seasonFinaleEpisodeNumber != null ? it.seasonFinaleEpisodeNumber : undefined,
      isCompanion: it.isCompanion || undefined,
      companionType: it.companionType || undefined,
      companionNote: it.companionNote || undefined,
      companionStoryline: it.companionStoryline || undefined,
    }));
  // Paginate like every other in-memory source (see fetchCuratedCatalog
  // just above for the same slice(skip, skip+PAGE_SIZE) + totalItems
  // shape). This used to ignore skip and return the whole list on every
  // call. /api/preview and the real Stremio catalog route both call this
  // with an advancing skip and trust the result to actually advance --
  // Live Preview & Editor's "See All" pages a Custom List through
  // /api/preview (unlike Your Custom Lists' own See All, which embeds the
  // full array up front and never re-fetches), so returning the same
  // page-0 items again under a "page 2" label made it re-append them and
  // then stop, capping any imported list over PAGE_SIZE at 2 x PAGE_SIZE
  // items with half of them duplicates.
  if (skip >= mapped.length) return [];
  const sliced = mapped.slice(skip, skip + PAGE_SIZE);
  sliced.totalItems = mapped.length;
  return sliced;
}

// Turns one stored recommendation entry (the exact shape the Discover
// card renders -- see /api/recommendations, 25_api-catalog-routes.js, and
// the snapshot the client pushes with its tracking data) into a catalog
// meta. The only thing that has to be looked up is the IMDb id: the card
// only ever needs TMDB's own id, but a Stremio/wako catalog row has to
// carry an id stream add-ons can resolve, so each entry costs one
// external_ids call. Those are edge-cached for a day, and the list is
// capped at CURATED_RECOMMENDATION_LIMIT, so this is a bounded, mostly
// cache-served fan-out rather than the up-to-PAGE_SIZE one this replaced.
// TMDB's recommendations (or, where it has none, its "similar" titles) for a
// set of seed titles, merged and de-duplicated -- the Discover tab's
// Recommended Movies/Shows. One implementation for both callers: the
// /api/recommendations route the website calls, and fetchCuratedCatalog when
// the website's snapshot has gone stale. Two copies of this would drift, and
// the whole point of the catalog row is that it shows what the card showed.
//
// Either side may be empty; a side with fewer than ten results is topped up
// from that week's trending titles, exactly as the route always did.
async function buildTmdbRecommendations(movieIds, showIds, tmdbKey) {
  const listFor = (kind) => async (rawId) => {
    try {
      let tmdbId = "";
      let strId = String(rawId || "").trim();
      if (strId.startsWith("tmdb:")) strId = strId.slice(5);
      const baseId = strId.split(":")[0];
      if (/^\d+$/.test(baseId)) {
        tmdbId = baseId;
      } else {
        const findRes = await fetch(`https://api.themoviedb.org/3/find/${encodeURIComponent(baseId)}?api_key=${encodeURIComponent(tmdbKey)}&external_source=imdb_id`, {
          cf: { cacheTtl: 86400, cacheEverything: true }
        });
        const findData = await findRes.json();
        const results = kind === "movie" ? findData.movie_results : findData.tv_results;
        if (results && results[0]) tmdbId = results[0].id;
      }
      if (!tmdbId) return [];
      const recRes = await fetch(`https://api.themoviedb.org/3/${kind}/${encodeURIComponent(tmdbId)}/recommendations?api_key=${encodeURIComponent(tmdbKey)}&page=1`, {
        cf: { cacheTtl: 86400, cacheEverything: true }
      });
      const recData = await recRes.json();
      let list = recData.results || [];
      if (!list.length) {
        const simRes = await fetch(`https://api.themoviedb.org/3/${kind}/${encodeURIComponent(tmdbId)}/similar?api_key=${encodeURIComponent(tmdbKey)}&page=1`, {
          cf: { cacheTtl: 86400, cacheEverything: true }
        });
        const simData = await simRes.json();
        list = simData.results || [];
      }
      return list;
    } catch {
      return [];
    }
  };

  const toItem = (kind, m) => kind === "movie"
    ? {
        id: "tmdb:" + m.id,
        tmdbId: String(m.id),
        name: m.title || "Movie",
        poster: "https://image.tmdb.org/t/p/w500" + m.poster_path,
        year: (m.release_date || "").slice(0, 4),
        type: "movie",
        rating: m.vote_average ? m.vote_average.toFixed(1) : null
      }
    : {
        id: "tmdb:" + m.id,
        tmdbId: String(m.id),
        name: m.name || "Show",
        poster: "https://image.tmdb.org/t/p/w500" + m.poster_path,
        year: (m.first_air_date || "").slice(0, 4),
        type: "series",
        rating: m.vote_average ? m.vote_average.toFixed(1) : null
      };

  const side = async (kind, ids) => {
    const lists = await Promise.all((ids || []).map(listFor(kind)));
    const seen = new Set();
    const out = [];
    for (const list of lists) {
      for (const m of list) {
        if (m && m.id && !seen.has(m.id) && m.poster_path) {
          seen.add(m.id);
          out.push(toItem(kind, m));
        }
      }
    }
    if (out.length < 10) {
      try {
        const popRes = await fetch(`https://api.themoviedb.org/3/trending/${kind}/week?api_key=${encodeURIComponent(tmdbKey)}`, {
          cf: { cacheTtl: 86400, cacheEverything: true }
        });
        const popData = await popRes.json();
        for (const m of (popData.results || [])) {
          if (m && m.id && !seen.has(m.id) && m.poster_path) {
            seen.add(m.id);
            out.push(toItem(kind, m));
          }
        }
      } catch {}
    }
    return out.slice(0, CURATED_RECOMMENDATION_LIMIT);
  };

  const [movies, shows] = await Promise.all([
    movieIds ? side("movie", movieIds) : Promise.resolve([]),
    showIds ? side("tv", showIds) : Promise.resolve([]),
  ]);
  return { movies, shows };
}

// The seed titles the website would send /api/recommendations for this
// account, from what the server can see of it: Continue Watching, Watch
// History and the Watchlist, in that order -- the order the Discover tab
// gathers them in (19_client-search-and-likes.js). The website also reads
// the account's other custom lists; those only ever add seeds after these,
// and with twelve a side the first three almost always fill it.
//
// Classified the way the website classifies them: anything with a showId, or
// typed/shaped as a series, seeds shows; everything else seeds movies.
function recommendationSeedsFrom(items) {
  const movieIds = [];
  const showIds = [];
  const seenShows = new Set();
  const seenMovies = new Set();
  for (const it of items) {
    if (!it) continue;
    const rawShowId = it.showId || (it.type === "series" || it.type === "tv" || it.kind === "series" || it.kind === "tv" || it.showTitle ? (it.id || it.imdbId) : null);
    if (rawShowId) {
      const clean = String(rawShowId).replace(/^tmdb:/, "").split(":")[0].trim();
      if (clean && !seenShows.has(clean)) {
        seenShows.add(clean);
        showIds.push(clean);
      }
    } else {
      const rawMovieId = it.imdbId || it.id;
      if (!rawMovieId) continue;
      const clean = String(rawMovieId).replace(/^tmdb:/, "").split(":")[0].trim();
      if (clean && !seenMovies.has(clean)) {
        seenMovies.add(clean);
        movieIds.push(clean);
      }
    }
  }
  return {
    movieIds: movieIds.slice(0, RECOMMENDATION_SEEDS_PER_SIDE),
    showIds: showIds.slice(0, RECOMMENDATION_SEEDS_PER_SIDE),
  };
}

async function mapStoredRecommendationToMeta(it, isSeries, tmdbKey) {
  if (!it) return null;
  const tmdbId = String(it.tmdbId || String(it.id || '').replace(/^tmdb:/, '') || '').trim();
  const name = it.name || it.title || 'Untitled';
  const poster = it.poster || undefined;
  const releaseInfo = it.year || it.releaseInfo || undefined;
  let resolvedId = '';
  if (tmdbId) {
    try {
      const detailRes = await fetch(`https://api.themoviedb.org/3/${isSeries ? 'tv' : 'movie'}/${encodeURIComponent(tmdbId)}/external_ids?api_key=${encodeURIComponent(tmdbKey)}`, {
        cf: { cacheTtl: 86400, cacheEverything: true }
      });
      const detailData = await detailRes.json();
      if (detailData && detailData.imdb_id) resolvedId = detailData.imdb_id;
    } catch {}
    if (!resolvedId) resolvedId = `tmdb:${tmdbId}`;
  }
  if (!resolvedId) return null;
  return {
    id: resolvedId,
    type: isSeries ? 'series' : 'movie',
    name: name,
    poster: poster,
    releaseInfo: releaseInfo,
  };
}

async function fetchCuratedCatalog(entry, skip = 0, keys = {}) {
  const isSeries = entry.type === 'series' || (entry.url && entry.url.includes('shows'));
  const tmdbKey = keys.tmdbKey || TMDB_API_KEY;
  let storedRecs = null;

  if (keys.env && keys.env.CONFIGS) {
    let username = keys.username || keys.creatorName || '';
    if (!username && keys.configParam) {
      try {
        const resolved = await resolveConfig(keys.configParam, keys.env);
        if (resolved && resolved.trackCreatorName) username = resolved.trackCreatorName;
      } catch {}
    }
    let tracking = null;
    if (username) {
      try {
        const trackingRaw = await keys.env.CONFIGS.get(`creatorsynctracking:${username}`);
        if (trackingRaw) tracking = JSON.parse(trackingRaw);
      } catch {}
    }
    if (tracking) {
      // The Discover card's own list, while the website is still the one
      // keeping it current. Preferred over building one here because only the
      // browser sees the account's whole picture (every custom list, not just
      // tracking data), so only its list matches the card item for item.
      const recBlob = tracking.curatedRecommendations;
      const snapshot = recBlob && typeof recBlob === 'object' ? (isSeries ? recBlob.shows : recBlob.movies) : null;
      const snapshotAge = Date.now() - ((recBlob && Number(recBlob.updatedAt)) || 0);
      if (Array.isArray(snapshot) && snapshot.length && snapshotAge < CURATED_SNAPSHOT_MAX_AGE_MS) {
        storedRecs = snapshot;
      } else {
        // No snapshot, or one the website has not refreshed in days --
        // someone watching only in Stremio or Nuvio, whose row used to stay
        // frozen at whatever Discover last showed. Built the way the website
        // builds it (buildTmdbRecommendations), from the account's current
        // Continue Watching, Watch History and Watchlist, so what has been
        // watched since shapes it. The stale snapshot is the fallback only if
        // that produces nothing (no viewing to seed from, TMDB down).
        try {
          const wl = await readAccountWatchlist(keys.env, username, tracking);
          const seeds = recommendationSeedsFrom([
            ...(Array.isArray(tracking.continueWatching) ? tracking.continueWatching : []),
            ...(Array.isArray(tracking.watchHistory) ? tracking.watchHistory : []),
            ...(wl ? wl.items : []),
          ]);
          const sideSeeds = isSeries ? seeds.showIds : seeds.movieIds;
          if (sideSeeds.length) {
            const built = await buildTmdbRecommendations(isSeries ? null : sideSeeds, isSeries ? sideSeeds : null, tmdbKey);
            const side = isSeries ? built.shows : built.movies;
            if (side.length) storedRecs = side;
          }
        } catch {}
        if (!storedRecs && Array.isArray(snapshot) && snapshot.length) storedRecs = snapshot;
      }
    }
  }

  // Serves the list chosen above -- the Discover snapshot, or the one built
  // in its place -- in its own order, cut to the card's length, so "40
  // items" on the card and 40 items in the shelf are the same 40.
  if (storedRecs) {
    const capped = storedRecs.slice(0, CURATED_RECOMMENDATION_LIMIT);
    if (skip >= capped.length) return [];
    const mapped = await Promise.all(
      capped.slice(skip, skip + PAGE_SIZE).map((it) => mapStoredRecommendationToMeta(it, isSeries, tmdbKey).catch(() => null))
    );
    const out = mapped.filter(Boolean);
    // Only trust the list if it actually resolved to something. An empty
    // result here (every external_ids call failed, say) falls through to
    // the popular chart below rather than serving an empty shelf, the same
    // fallback shape fetchCustomListCatalog already uses.
    if (out.length) {
      out.totalItems = capped.length;
      return out;
    }
  }

  if (skip === 0) {
    return fetchTmdbChart(entry, 0, tmdbKey, 'popular');
  }
  return [];
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

async function fetchAutoTrackedCatalog(entry, env, keys = {}) {
  if (!env || !env.CONFIGS) return [];
  
  // url format: autotrack:[slug]:[type]:[username] or autotrack:[slug] or custom:[slug]
  // e.g. autotrack:watch-history:movie:brock25
  const rawUrl = String(entry.url || "").trim();
  const parts = rawUrl.split(":");
  let slug = parts[1] || "";
  let targetType = parts[2] || entry.type || "movie";
  let username = parts[3] || (keys && (keys.trackCreatorName || keys.username || keys.creatorName)) || "";

  if (rawUrl.startsWith("custom:")) {
    slug = rawUrl.slice(7);
  } else if (!slug) {
    slug = (entry.id || "watch-history").toLowerCase().replace(/_/g, "-");
  }

  let verifiedOwner = String((keys && keys.verifiedOwner) || "");
  if ((!username || !verifiedOwner) && keys && keys.configParam) {
    try {
      const resolved = await resolveConfig(keys.configParam, env);
      if (resolved) {
        if (!username && resolved.trackCreatorName) username = resolved.trackCreatorName;
        if (!verifiedOwner && resolved.trackOwner) verifiedOwner = resolved.trackOwner;
      }
    } catch {}
  }

  if (!username) return [];
  username = String(username).toLowerCase();

  // Whose shelf is this, and is the caller allowed to read it?
  //
  // `username` above came out of the entry URL -- a string anyone can write --
  // so up to this point nothing has established that the caller has any claim
  // to the account it names. Every way into this function funnels through
  // fetchCatalog: the Stremio catalog route, /api/preview, and a merged row.
  // Gating here rather than at each of those is the point, the same way
  // authenticateCreator is the one place every creator route goes through: a
  // caller added later inherits the check instead of having to remember it.
  //
  // See mayReadTrackedShelf (02_http-and-creator-utils.js) for what counts as
  // proof and why this returns an empty shelf rather than an error -- a catalog
  // row has no way to show a message, and "empty" is what an unauthorised
  // reader should see either way.
  if (!(await mayReadTrackedShelf(env, username, slug, { verifiedOwner }))) return [];

  try {
    let items;
    let airingItems;
    // D1 is the cheap read, but only while it is current: a tracking write
    // that failed leaves the rows as they were, and these rows used to keep
    // serving them regardless. The KV record below is the newer copy then.
    // See isTrackingD1Behind.
    const d1Current = !!(env && env.DB) && slug !== 'watchlist' && !(await isTrackingD1Behind(env, username));
    if (d1Current) {
      if (slug === 'watch-history') {
        const rows = await env.DB.prepare(
          "SELECT * FROM watch_history WHERE username = ? ORDER BY watched_at DESC LIMIT 100"
        ).bind(username).all().then(r => r.results || []).catch(() => null);
        if (rows && rows.length) {
          items = rows.map(r => ({
            id: r.item_id,
            type: r.item_type,
            name: r.title || undefined,
            title: r.title || undefined,
            poster: r.poster || undefined,
            showId: r.show_id || undefined,
            showTitle: r.show_title || undefined,
            showPoster: r.show_poster || undefined,
            seasonNum: r.season_num != null ? r.season_num : undefined,
            episodeNum: r.episode_num != null ? r.episode_num : undefined,
            year: r.year || undefined,
            airDate: r.air_date || undefined,
            watchedAt: r.watched_at,
          }));
        }
      } else if (slug === 'continue-watching') {
        const [rows, airingRows, fwRows] = await Promise.all([
          env.DB.prepare(
            "SELECT * FROM continue_watching WHERE username = ? ORDER BY updated_at DESC LIMIT 100"
          ).bind(username).all().then(r => r.results || []).catch(() => null),
          env.DB.prepare(
            "SELECT * FROM airing_next WHERE username = ? ORDER BY air_date ASC LIMIT 100"
          ).bind(username).all().then(r => r.results || []).catch(() => null),
          env.DB.prepare(
            "SELECT show_id FROM creator_show_states WHERE username = ? AND is_fully_watched = 1"
          ).bind(username).all().then(r => r.results || []).catch(() => null),
        ]);
        const fullyWatchedSet = new Set((fwRows || []).map(r => String(r.show_id)));
        const airingShowSet = new Set((airingRows || []).map(r => String(r.show_id || '')).filter(Boolean));
        if (rows && rows.length) {
          items = rows.filter(r => {
            if (!r) return false;
            const sid = String(r.show_id || '');
            const base = trackingShowKey(sid);
            const isComp = r.show_title && r.show_title.startsWith('COMPANION:');
            if (isComp) return true;
            if (airingShowSet.has(sid) || (base && airingShowSet.has(base))) return true;
            if (r.is_unaired || r.isUnaired || (r.airDate && typeof isEpisodeAired === 'function' && !isEpisodeAired(r.airDate)) || (r.air_date && typeof isEpisodeAired === 'function' && !isEpisodeAired(r.air_date))) return true;
            if (fullyWatchedSet.has(sid) || (base && fullyWatchedSet.has(base))) return false;
            return true;
          }).map(r => {
            let isCompanion = undefined;
            let companionType = undefined;
            let companionNote = undefined;
            let companionStoryline = undefined;
            let precedingShowId = undefined;
            let showTitle = r.show_title || undefined;
            let kind = undefined;
            let type = (r.season_num == null && r.episode_num == null && !r.show_title) ? "movie" : "episode";
            if (r.show_title && r.show_title.startsWith("COMPANION:")) {
              try {
                const compMeta = JSON.parse(r.show_title.slice(10));
                isCompanion = true;
                companionType = compMeta.companionType;
                companionNote = compMeta.companionNote;
                companionStoryline = compMeta.companionStoryline;
                precedingShowId = compMeta.precedingShowId;
                showTitle = compMeta.showTitle || undefined;
                kind = compMeta.kind || (compMeta.type === 'movie' ? 'movie' : undefined);
                type = compMeta.type || (kind === 'movie' ? 'movie' : 'episode');
              } catch {}
            } else if (type === "movie") {
              kind = "movie";
            }
            return {
              id: r.item_id,
              showId: (type === 'movie' && !r.season_num && !r.episode_num && !showTitle) ? undefined : r.show_id,
              type: type,
              kind: kind,
              name: r.name || undefined,
              poster: r.poster || undefined,
              showTitle: showTitle,
              showPoster: r.show_poster || undefined,
              seasonNum: r.season_num != null ? r.season_num : undefined,
              episodeNum: r.episode_num != null ? r.episode_num : undefined,
              updatedAt: r.updated_at,
              isCompanion: isCompanion,
              companionType: companionType,
              companionNote: companionNote,
              companionStoryline: companionStoryline,
              precedingShowId: precedingShowId,
            };
          });
          if (airingRows && airingRows.length) {
            airingItems = airingRows.map(r => ({
              id: r.item_id,
              showId: r.show_id,
              type: "episode",
              name: r.name || undefined,
              poster: r.poster || undefined,
              showTitle: r.show_title || undefined,
              showPoster: r.show_poster || undefined,
              seasonNum: r.season_num != null ? r.season_num : undefined,
              episodeNum: r.episode_num != null ? r.episode_num : undefined,
              airDate: r.air_date || undefined,
              isSeasonPremiere: r.is_season_premiere ? true : undefined,
              isSeasonFinale: r.is_season_finale ? true : undefined,
              seasonFinaleAirDate: r.season_finale_air_date || undefined,
              seasonFinaleEpisodeNumber: r.season_finale_episode_number != null ? r.season_finale_episode_number : undefined,
              updatedAt: r.updated_at,
            }));
          }
        }
      } else if (slug === 'airing-next') {
        const rows = await env.DB.prepare(
          "SELECT * FROM airing_next WHERE username = ? ORDER BY air_date ASC LIMIT 100"
        ).bind(username).all().then(r => r.results || []).catch(() => null);
        if (rows && rows.length) {
          items = rows.map(r => ({
            id: r.item_id,
            showId: r.show_id,
            type: "episode",
            name: r.name || undefined,
            poster: r.poster || undefined,
            showTitle: r.show_title || undefined,
            showPoster: r.show_poster || undefined,
            seasonNum: r.season_num != null ? r.season_num : undefined,
            episodeNum: r.episode_num != null ? r.episode_num : undefined,
            airDate: r.air_date || undefined,
            isSeasonPremiere: r.is_season_premiere ? true : undefined,
            isSeasonFinale: r.is_season_finale ? true : undefined,
            seasonFinaleAirDate: r.season_finale_air_date || undefined,
            seasonFinaleEpisodeNumber: r.season_finale_episode_number != null ? r.season_finale_episode_number : undefined,
            updatedAt: r.updated_at,
          }));
        }
      }
    }
    if (!items) {
      let trackingRaw = await env.CONFIGS.get('creatorsynctracking:' + username);
      if (!trackingRaw) {
        await ensureTrackingMigrated(env, username);
        trackingRaw = await env.CONFIGS.get('creatorsynctracking:' + username);
      }
      if (trackingRaw) {
        const trackingBlob = JSON.parse(trackingRaw);
        items = slug === 'watch-history' ? trackingBlob.watchHistory : (slug === 'continue-watching' ? trackingBlob.continueWatching : (slug === 'airing-next' ? trackingBlob.airingNext : (trackingBlob.watchlist || [])));
        // The Watchlist has three copies and this record's is the one a
        // playback scrobble used to empty -- serve the newest of them, which
        // is also what the website shows. See readAccountWatchlist.
        if (slug === 'watchlist') {
          const wl = await readAccountWatchlist(env, username, trackingBlob);
          items = wl ? wl.items : [];
        }
        // Loaded for the watchlist as well as continue-watching: it is the
        // only source of "this show has an episode coming", and a watchlist
        // entry wants that chip exactly as much as an in-progress one does.
        // The fully-watched filtering below stays continue-watching only --
        // a watchlist is what you mean to watch, not a progress shelf, so
        // dropping finished shows from it would be wrong.
        if (slug === 'continue-watching' || slug === 'watchlist') {
          airingItems = trackingBlob.airingNext || [];
        }
        if (slug === 'continue-watching') {
          const fwList = Array.isArray(trackingBlob.fullyWatchedShowIds) ? trackingBlob.fullyWatchedShowIds.map(String) : [];
          if (fwList.length && Array.isArray(items)) {
            const fwSet = new Set(fwList);
            const airingShowSet = new Set((airingItems || []).map(r => String((r && (r.showId || r.id)) || '')).filter(Boolean));
            items = items.filter(it => {
              if (!it) return false;
              if (it.isCompanion) return true;
              const sid = String(it.showId || it.id || '');
              const base = trackingShowKey(sid);
              if (airingShowSet.has(sid) || (base && airingShowSet.has(base))) return true;
              if (it.isUnaired || (it.airDate && typeof isEpisodeAired === 'function' && !isEpisodeAired(it.airDate))) return true;
              if (fwSet.has(sid) || (base && fwSet.has(base))) return false;
              return true;
            });
          }
        }
      } else {
        const blobStr = await env.CONFIGS.get('creatorsync:' + username);
        if (!blobStr) return [];
        const blob = JSON.parse(blobStr);
        items = slug === 'watch-history' ? blob.watchHistory : (slug === 'continue-watching' ? blob.continueWatching : (slug === 'airing-next' ? blob.airingNext : (blob.watchlist || [])));
        if (slug === 'watchlist') {
          const wl = await readAccountWatchlist(env, username, blob);
          items = wl ? wl.items : [];
        }
        // Loaded for the watchlist as well as continue-watching: it is the
        // only source of "this show has an episode coming", and a watchlist
        // entry wants that chip exactly as much as an in-progress one does.
        // The fully-watched filtering below stays continue-watching only --
        // a watchlist is what you mean to watch, not a progress shelf, so
        // dropping finished shows from it would be wrong.
        if (slug === 'continue-watching' || slug === 'watchlist') {
          airingItems = blob.airingNext || [];
        }
        if (slug === 'continue-watching') {
          const fwList = Array.isArray(blob.fullyWatchedShowIds) ? blob.fullyWatchedShowIds.map(String) : [];
          if (fwList.length && Array.isArray(items)) {
            const fwSet = new Set(fwList);
            const airingShowSet = new Set((airingItems || []).map(r => String((r && (r.showId || r.id)) || '')).filter(Boolean));
            items = items.filter(it => {
              if (!it) return false;
              if (it.isCompanion) return true;
              const sid = String(it.showId || it.id || '');
              const base = trackingShowKey(sid);
              if (airingShowSet.has(sid) || (base && airingShowSet.has(base))) return true;
              if (it.isUnaired || (it.airDate && typeof isEpisodeAired === 'function' && !isEpisodeAired(it.airDate))) return true;
              if (fwSet.has(sid) || (base && fwSet.has(base))) return false;
              return true;
            });
          }
        }
      }
    }
    // Airing Next lists what is still to come, and it is a snapshot: rebuilt
    // by the website when it is open and by the cron (refreshAiringNextSweep,
    // 07_source-fetchers-tmdb-simkl.js) every few hours. In between, an
    // episode can air -- and it used to sit on the shelf with its old date
    // for as long as nobody rebuilt it. The website's own copy drops those
    // (refreshAiringNext treats an aired entry as expired); so does this.
    // "Aired" is isEpisodeAired's: before today, so today's episode stays.
    if (slug === 'airing-next' && Array.isArray(items) && typeof isEpisodeAired === 'function') {
      items = items.filter((it) => !(it && it.airDate && isEpisodeAired(it.airDate)));
    }
    if (!items || !items.length) return [];

    const airingByShowId = new Map();
    const airingByBaseId = new Map();
    const airingByTitle = new Map();
    if ((slug === 'continue-watching' || slug === 'watchlist') && Array.isArray(airingItems) && airingItems.length) {
      airingItems.forEach(an => {
        if (!an) return;
        const sid = String(an.showId || an.id || '');
        if (sid && !airingByShowId.has(sid)) airingByShowId.set(sid, an);
        const base = trackingShowKey(sid);
        if (base && !airingByBaseId.has(base)) airingByBaseId.set(base, an);
        const title = String(an.showTitle || an.title || an.name || '').toLowerCase().trim();
        if (title && !airingByTitle.has(title)) airingByTitle.set(title, an);
      });
    }

    const mappedItems = [];
    
    items.forEach(it => {
      // Structure wins over the type string. An entry carrying showId /
      // showTitle / seasonNum / episodeNum is a TV episode whatever its
      // "type" field happens to say -- and it can say the wrong thing:
      // these lists are written by the browser and persist in
      // localStorage across releases, so an entry built by an older
      // version of the client outlives the code that produced it.
      // Trusting a stale type string over the fields three lines below
      // (which read showId/showTitle to build the series meta) meant this
      // function could simultaneously decide an item was a movie and then
      // map it as a show. The client's own list renderers already resolve
      // this the same way -- see the isShow checks in the dashboard and
      // list-details mappers -- so this makes the two sides agree.
      //
      // A real movie entry has none of these fields, so it still falls
      // through to the type/kind check exactly as before.
      const isCompanionMovie = !!(it.isCompanion && (it.kind === 'movie' || it.type === 'movie' || it.companionType === 'bridge_movie' || it.companionType === 'sequel_movie'));
      const hasSeriesShape = !isCompanionMovie && !!(it.showId || it.showTitle || it.seasonNum != null || it.episodeNum != null);
      const isMovie = isCompanionMovie || (!hasSeriesShape && (it.kind === 'movie' || it.type === 'movie'));
      
      // Filter out types we don't want in this catalog
      if (targetType === 'movie' && !isMovie) return;
      if (targetType === 'series' && isMovie) return;
      
      const showId = isMovie ? null : (it.showId || it.imdbId || it.id);
      const showPoster = isMovie
        ? it.poster
        : (it.showPoster ||
           (showId && showId.startsWith('tt') ? 'https://images.metahub.space/poster/medium/' + showId + '/img' : '') ||
           it.poster);

      let effectiveAirDate = it.airDate || undefined;
      let isSeasonPremiere = it.isSeasonPremiere ? true : undefined;
      let isSeasonFinale = it.isSeasonFinale ? true : undefined;
      let seasonFinaleAirDate = it.seasonFinaleAirDate || undefined;
      let seasonFinaleEpisodeNumber = it.seasonFinaleEpisodeNumber != null ? it.seasonFinaleEpisodeNumber : undefined;
      let airingMatch = null;

      if ((slug === 'continue-watching' || slug === 'watchlist') && (airingByShowId.size || airingByBaseId.size || airingByTitle.size)) {
        if (it.showId && airingByShowId.has(String(it.showId))) airingMatch = airingByShowId.get(String(it.showId));
        else if (it.id && airingByShowId.has(String(it.id))) airingMatch = airingByShowId.get(String(it.id));
        else {
          const base = trackingShowKey(String(it.showId || it.id || ''));
          if (base && airingByBaseId.has(base)) airingMatch = airingByBaseId.get(base);
          else {
            const title = String(it.showTitle || it.title || it.name || '').toLowerCase().trim();
            if (title && airingByTitle.has(title)) airingMatch = airingByTitle.get(title);
          }
        }

        if (airingMatch) {
          const isOlderSeason = !!(airingMatch.seasonNum != null && it.seasonNum != null && it.seasonNum < airingMatch.seasonNum);
          if (!isOlderSeason) {
            const isSameSeason = !!(airingMatch.seasonNum != null && it.seasonNum != null && it.seasonNum === airingMatch.seasonNum);
            const isSameEpisode = (!it.seasonNum || !airingMatch.seasonNum || it.seasonNum === airingMatch.seasonNum) &&
              (!it.episodeNum || !airingMatch.episodeNum || it.episodeNum === airingMatch.episodeNum);
            if (!effectiveAirDate && isSameEpisode && airingMatch.airDate) {
              effectiveAirDate = airingMatch.airDate;
            }
            const currentEpNum = it.episodeNum != null ? it.episodeNum : (isSameEpisode ? airingMatch.episodeNum : null);
            const hasLaterAiringEp = !!(isSameSeason && airingMatch.episodeNum != null && currentEpNum != null && currentEpNum < airingMatch.episodeNum);
            const epHasAired = (effectiveAirDate && typeof isEpisodeAired === 'function') ? isEpisodeAired(effectiveAirDate) : hasLaterAiringEp;
            if (isSeasonPremiere == null) {
              const isPremiere = !epHasAired && (currentEpNum === 1 || (currentEpNum == null && (it.isSeasonPremiere || (isSameEpisode && airingMatch.isSeasonPremiere))));
              if (isPremiere) isSeasonPremiere = true;
            } else if (epHasAired) {
              isSeasonPremiere = undefined;
            }
            if (isSeasonFinale == null) {
              const isFinale = !!(it.isSeasonFinale || (isSameEpisode && airingMatch.isSeasonFinale) || (airingMatch.seasonFinaleEpisodeNumber && currentEpNum != null && currentEpNum === airingMatch.seasonFinaleEpisodeNumber));
              if (isFinale) isSeasonFinale = true;
            }
            if (!seasonFinaleAirDate) {
              seasonFinaleAirDate = it.seasonFinaleAirDate || (airingMatch.seasonFinaleAirDate || (airingMatch.isSeasonFinale ? airingMatch.airDate : undefined));
            }
            if (seasonFinaleEpisodeNumber == null) {
              seasonFinaleEpisodeNumber = airingMatch.seasonFinaleEpisodeNumber;
            }
          } else {
            effectiveAirDate = undefined;
            isSeasonPremiere = undefined;
            isSeasonFinale = undefined;
            seasonFinaleAirDate = undefined;
            seasonFinaleEpisodeNumber = undefined;
          }
        }
      }

      const mapped = {
        id: isMovie ? (it.imdbId || it.id) : (showId || it.id),
        showId: showId || undefined,
        showTitle: isMovie ? undefined : (it.showTitle || it.title || it.name),
        seasonNum: it.seasonNum != null ? it.seasonNum : undefined,
        episodeNum: it.episodeNum != null ? it.episodeNum : undefined,
        type: targetType,
        name: isMovie ? (it.title || it.name) : (it.showTitle || it.title || it.name),
        poster: showPoster,
        releaseInfo: it.year || undefined,
        airDate: effectiveAirDate,
        airTime: it.airTime || (airingMatch && airingMatch.airTime) || undefined,
        isUnaired: it.isUnaired ? true : undefined,
        isSeasonPremiere: isSeasonPremiere,
        isSeasonFinale: isSeasonFinale,
        seasonFinaleAirDate: seasonFinaleAirDate,
        seasonFinaleEpisodeNumber: seasonFinaleEpisodeNumber,
        isCompanion: it.isCompanion ? true : undefined,
        companionType: it.companionType || undefined,
        companionNote: it.companionNote || undefined,
        companionStoryline: it.companionStoryline || undefined,
        precedingShowId: it.precedingShowId || undefined,
        adult: it.adult,
        isAdult: it.isAdult,
        certification: it.certification || it.ageRating || it.contentRating,
        genres: it.genres,
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
    
    if (keys && keys.adultContentFilter && Array.isArray(mappedItems) && mappedItems.length > 0) {
      return applyAdultContentFilterToMetas(mappedItems, keys.origin, entry);
    }
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

  let payload = null;
  const keysToTry = [
    `creatorlist:${parsed.username}:${parsed.listName}`,
    `creatorlist:${parsed.rawUsername}:${parsed.rawListName}`,
    `publishedlist:${parsed.username}:${parsed.listName}`,
    `publishedlist:${parsed.rawUsername}:${parsed.rawListName}`,
  ];

  for (const k of keysToTry) {
    if (payload) break;
    const raw = await env.CONFIGS.get(k);
    if (raw) {
      try {
        const data = JSON.parse(raw);
        if (data) {
          await stampListVisibilityIfNeeded(env, k, data);
          if (isPublicListVisibility(data.visibility)) payload = data;
        }
      } catch {}
    }
  }

  if (!payload || !Array.isArray(payload.items)) return [];
  return payload.items
    .filter((it) => {
      const itId = it && (it.imdbId || it.id || it.tmdbId);
      if (!itId) return false;
      const itType = it.kind || it.type;
      if (entry.type === 'movie') {
        if (itType === 'series' || itType === 'tv') return false;
      } else if (entry.type === 'series') {
        if (itType === 'movie') return false;
      }
      return true;
    })
    .map((it) => {
      const itId = it.imdbId || (String(it.id || '').startsWith('tt') ? it.id : (it.id ? `tt${it.id}` : ''));
      const itName = it.title || it.name || it.showTitle || '';
      let poster = it.poster || it.showPoster || undefined;
      if (!poster && itId && itId.startsWith('tt')) {
        poster = `https://images.metahub.space/poster/medium/${itId}/img`;
      }
      return {
        id: itId || String(it.id || ''),
        type: entry.type || (it.kind === 'series' || it.type === 'series' || it.type === 'tv' ? 'series' : 'movie'),
        name: itName,
        poster: poster,
        releaseInfo: it.year || it.releaseInfo || undefined,
      };
    });
}

// --- a movie inside a channel: a known limit ---------------------------
//
// A channel's meta is a SERIES, and Stremio does not re-derive a type per
// video: tapping a movie in one asks every stream add-on for
// /stream/series/<the movie's own imdb id>.json. Most stream add-ons branch
// their whole handler on that type param before they ever look at the id, so
// the request is answered with nothing. Reported from the field as "Stremio
// cannot find the movie, PenguPlay finds no stream", while Nuvio, which
// resolves the id itself, plays it fine; Torrentio-style add-ons are lenient
// about id shape, which is why this works for some people and not others.
//
// Nothing here can change that. The type comes from the parent meta, and no
// id shape gets around it: tt123:1:1 points at a season 1 episode 1 that does
// not exist, and a bare number or a private prefix matches no idPrefixes
// anywhere so no add-on is even asked. Attaching metadata to the video does
// not change what a third-party add-on is asked for either.
//
// Tried and removed: answering that request here with a stream whose
// externalUrl deep-linked to the movie's own page. Stremio Web treats an
// externalUrl as leaving the app -- it routes through a stremio.com/warning
// interstitial and then hands the stremio:// scheme to the OS -- so it was a
// dead end where it was tested, and looked like a working option while not
// being one.
//
// What does work is left to the person: play the movie from its own page, or
// use a client that resolves the id itself. The two ways to fix this properly
// both cost something the add-on should not spend on its own -- proxying the
// person's own stream add-on (which means holding their debrid key) or
// splitting a channel's movies into a separate movie-typed row (which takes
// them out of the channel's play order).
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

// Where a Story Lock saved before locks carried their own start date
// (storyLockedSince) counts its walk from. Any fixed day would keep such a
// lock walking in order; a recent one keeps the count small, and a small
// count is what lets a run grow without moving the walk (see
// rotateChannelDayLineup). Ticking the lock off and on again stamps a real
// date and starts the show over from its first episode.
const CHANNEL_STORY_LOCK_LEGACY_START = Date.UTC(2026, 8, 24);

// How far a custom channel's own broadcast-schedule dials may be turned
// (see channelRotationPlan below). The ceilings are not arbitrary: 48 shows
// x 12 episodes is 576 videos in one day's meta response, already well past
// anything watchable, and a client has to parse the whole thing before it
// can render the channel at all.
const CHANNEL_ROTATION_MAX_SHOWS_PER_DAY = 48;
const CHANNEL_ROTATION_MAX_EPISODES_PER_SHOW = 12;

// How many episodes one multi-part story may glue together (see
// glueMultiPartEpisodes). Two- and three-parters are the norm and a
// five-network crossover is the outer edge of the real world; a cap stops a
// mis-detection -- a show whose every episode is titled "Chapter One",
// "Chapter Two" -- from gluing a whole season into one unbreakable block.
const CHANNEL_PART_GROUP_MAX = 6;

// --- channel video ids -------------------------------------------------
//
// A channel video's `id` IS the stream request: Stremio asks every stream
// add-on for /stream/<type>/<video.id>.json, and that id is the only thing
// it sends. The `season`/`episode` fields set below are the channel's own
// running order for display and never reach a stream add-on at all.
//
// So a malformed id here is not a dead link that someone notices -- it is a
// silently WRONG episode. The three helpers below exist to make that
// impossible to emit.

// The show half of a channel item's stream id. "tt..." is the form every
// add-on understands; a TMDB fallback has to carry the "tmdb:" prefix this
// add-on's manifest declares (see buildManifest's idPrefixes), because a
// BARE number matches no idPrefix anywhere and no add-on is ever even asked
// for it. Anything else is unusable and the item it belongs to gets dropped.
function channelItemShowId(rawId) {
  const id = String(rawId == null ? "" : rawId).trim();
  if (/^tt[0-9]+$/.test(id)) return id;
  if (/^tmdb:[0-9]+$/.test(id)) return id;
  if (/^[0-9]+$/.test(id)) return `tmdb:${id}`;
  return "";
}

// A season or episode number exactly as stored, or null when the item does
// not carry a real one. `parseInt(x, 10) || 1` used to stand in for this and
// could not tell "no season at all" from season 0 -- both came out as 1. An
// item missing either number therefore resolved to `<show>:1:1`, so a stream
// add-on was pointed at that show's S01E01 while the video still displayed
// the title of the episode we meant. Dropping the item instead turns a wrong
// episode (which nobody can report, because it looks like it played) into a
// missing one (which they can).
function channelItemNumber(value) {
  const n = typeof value === "number" ? value : parseInt(value, 10);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// The date one channel item first aired, as a sortable "YYYY-MM-DD" string,
// or "" when the item carries none.
//
// Nothing has to be looked up for this: every pick already stores it. An
// episode's `released` is TMDB's own `air_date` for that exact episode --
// /api/show-episodes hands it to the Channel builder, and
// compactChannelItemForStorage keeps it on the saved item -- and a movie's
// is its release date, falling back to the year the builder stored when
// that was all TMDB gave. That is the same fallback the video's own
// `released` below uses, so the running order matches the dates a client
// displays next to each item.
//
// Zero-padded ISO dates sort correctly as plain strings, so no Date parsing
// (and therefore no timezone) is involved.
function channelItemAiredDate(it) {
  if (!it) return "";
  const raw = String(it.released == null ? "" : it.released).trim();
  const m = raw.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/);
  if (m) return `${m[1]}-${m[2] || "01"}-${m[3] || "01"}`;
  const year = parseInt(it.year, 10);
  if (Number.isInteger(year) && year > 0) return `${String(year).padStart(4, "0")}-01-01`;
  return "";
}

// "Sort by air date", the other half of the Channel builder's one-or-the-
// other play-order choice (see buildChannelMeta): oldest first, across every
// show in the channel, so a multi-show channel plays in the order the
// episodes actually went out rather than show by show.
//
// An item with no date it can be placed by goes to the end rather than to
// the front (where an empty string would sort), keeping the order it was
// saved in -- being unable to date something is not a reason to open the
// channel with it. Ties keep their saved order too, which is what puts a
// double-header of two episodes aired the same night back in broadcast
// order.
function sortChannelItemsByAired(items) {
  return items
    .map((it, i) => ({ it, i, aired: channelItemAiredDate(it) }))
    .sort((a, b) => {
      if (a.aired === b.aired) return a.i - b.i;
      if (!a.aired) return 1;
      if (!b.aired) return -1;
      return a.aired < b.aired ? -1 : 1;
    })
    .map((w) => w.it);
}

// --- sharing a channel --------------------------------------------------
//
// A channel someone shares, or publishes to the Explore Channels directory,
// is stored server-side under a short code rather than packed into the link
// itself: a full channel is thousands of episodes and megabytes of JSON, and
// no URL survives that. What travels is the code.
//
// Everything that comes back out of that store is rebuilt field by field
// here rather than round-tripped whole. A shared channel is a stranger's
// JSON that this add-on then renders, saves into another person's browser
// and serves back as a catalog, so the shape it is allowed to have is
// spelled out in one place -- and a field this version does not know about
// is dropped rather than carried.
const SHARED_CHANNEL_ITEMS_MAX = 5000;
const SHARED_CHANNEL_NAME_MAX = 200;
const SHARED_CHANNEL_DESCRIPTION_MAX = 400;
// Hand-made pairings a shared channel may carry. Generous next to the number
// of multi-parters in any real channel, and small enough that the field
// cannot be used to inflate a share.
const SHARED_CHANNEL_PAIRS_MAX = 200;

function sharedChannelString(value, max) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

// Only http(s) art is kept. A shared channel's poster is rendered straight
// into an <img>, so a "javascript:" or "data:" URL from a stranger has no
// business surviving the trip.
function sharedChannelImageUrl(value) {
  const url = sharedChannelString(value, 600);
  return /^https?:\/\//i.test(url) ? url : "";
}

function sanitizeSharedChannelItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const kind = raw.kind === "movie" ? "movie" : "episode";
  const item = {
    kind: kind,
    imdbId: sharedChannelString(raw.imdbId, 40),
    season: channelItemNumber(raw.season),
    episode: channelItemNumber(raw.episode),
    showName: sharedChannelString(raw.showName, 200),
    epName: sharedChannelString(raw.epName, 200),
    title: sharedChannelString(raw.title, 300),
  };
  if (kind === "movie") {
    item.season = item.season === null ? 1 : item.season;
    item.episode = item.episode === null ? 1 : item.episode;
  }
  if (!channelItemStreamId(item)) return null;
  const released = sharedChannelString(raw.released, 10);
  if (released) item.released = released;
  const runtime = typeof raw.runtime === "number" ? raw.runtime : parseInt(raw.runtime, 10);
  if (Number.isInteger(runtime) && runtime > 0 && runtime < 1000) item.runtime = runtime;
  const poster = sharedChannelImageUrl(raw.poster);
  const thumbnail = sharedChannelImageUrl(raw.thumbnail);
  const showPoster = sharedChannelImageUrl(raw.showPoster);
  const backdrop = sharedChannelImageUrl(raw.backdrop);
  if (poster) item.poster = poster;
  if (thumbnail) item.thumbnail = thumbnail;
  if (showPoster) item.showPoster = showPoster;
  if (backdrop) item.backdrop = backdrop;
  return item;
}

// A channel as it is safe to store and hand back out. Returns null when
// there is nothing playable left, which is what the routes answer 400 on.
// Pairs survive a share only where both halves do: every key is checked
// against the picks that actually came through, and a group left with fewer
// than two members is dropped rather than travelling as a rule about one
// episode.
function sanitizeSharedPairedGroups(raw, items) {
  const keys = new Set();
  for (const it of items) {
    const key = channelItemStreamId(it);
    if (key) keys.add(key);
  }
  const out = [];
  for (const group of (Array.isArray(raw) ? raw : []).slice(0, SHARED_CHANNEL_PAIRS_MAX)) {
    if (!Array.isArray(group)) continue;
    const kept = [];
    for (const k of group) {
      const key = sharedChannelString(k, 60);
      if (key && keys.has(key) && kept.indexOf(key) === -1) kept.push(key);
      if (kept.length >= CHANNEL_PART_GROUP_MAX) break;
    }
    if (kept.length > 1) out.push(kept);
  }
  return out;
}

function sanitizeSharedChannel(raw) {
  if (!raw || typeof raw !== "object") return null;
  const items = (Array.isArray(raw.items) ? raw.items : [])
    .slice(0, SHARED_CHANNEL_ITEMS_MAX)
    .map(sanitizeSharedChannelItem)
    .filter(Boolean);
  const dynamic = raw.dynamic === "next-up" ? "next-up" : "";
  // A dynamic channel is the one shape allowed to arrive with no picks --
  // it has none by design. Everything else with nothing playable in it is
  // not a channel.
  if (!items.length && !dynamic) return null;
  const plan = channelRotationPlan(raw);
  const itemKeys = new Set(items.map(channelItemShowKey));
  // Locks for shows the shared picks no longer contain are dropped, so a
  // shared channel never arrives carrying rules about titles it has not
  // got.
  const storyLocked = (Array.isArray(raw.storyLocked) ? raw.storyLocked : [])
    .map((k) => sharedChannelString(k, 120))
    .filter((k) => k && itemKeys.has(k));
  const out = {
    name: sharedChannelString(raw.name, SHARED_CHANNEL_NAME_MAX) || "Shared Channel",
    // The channel's own description, not the directory listing's. They used
    // to be the same string, stored only on the listing -- so unpublishing a
    // channel deleted the sentence describing it, and a channel shared by
    // link had nowhere to carry one at all.
    description: sharedChannelString(raw.description, SHARED_CHANNEL_DESCRIPTION_MAX),
    poster: sharedChannelImageUrl(raw.poster) || null,
    backdrop: sharedChannelImageUrl(raw.backdrop) || null,
    items: items,
    shuffle: !!raw.shuffle,
    autoSort: sharedChannelString(raw.autoSort, 32),
    sortByAired: !!raw.sortByAired,
    dailyRotate: !!raw.dailyRotate,
    hideWatched: !!raw.hideWatched,
    storyLocked: storyLocked,
    // When each of those locks was turned on -- the day its walk starts
    // from. It travels with the channel, so a copy airs the same episode on
    // the same night as the channel it was copied from.
    storyLockedSince: channelStoryLockSince(raw.storyLockedSince, storyLocked),
    pairParts: !!raw.pairParts,
    // A channel that keeps up with its shows keeps doing so for whoever
    // takes a copy -- it is the whole point of the flag, and it costs the
    // receiving side nothing until they actually open the channel.
    autoNewEpisodes: !!raw.autoNewEpisodes,
    newEpisodesAtTop: !!raw.newEpisodesAtTop,
    // Hand-made pairs, kept only for episodes the shared picks actually
    // contain -- the same rule Story Lock follows above, for the same
    // reason: a shared channel should never arrive carrying rules about
    // titles it has not got.
    pairedGroups: sanitizeSharedPairedGroups(raw.pairedGroups, items),
    dynamic: dynamic,
  };
  if (out.dailyRotate) {
    out.rotateShows = plan.shows;
    out.rotateEpisodes = plan.episodes;
    out.rotateTurnover = plan.turnover;
    out.rotateTurnoverTime = sharedChannelString(raw.rotateTurnoverTime, 5);
    out.rotateTurnoverZone = raw.rotateTurnoverZone === "local" ? "local" : "utc";
  }
  // Live Cloud Sync travels only when there is a real list URL behind it --
  // the receiving end rebuilds the pool from that URL, so an unusable one
  // would just leave the flag on with nothing to sync.
  const sourceUrl = sharedChannelString(raw.sourceUrl, 600);
  if (raw.liveSync && /^https?:\/\//i.test(sourceUrl)) {
    out.liveSync = true;
    out.sourceUrl = sourceUrl;
  }
  return out;
}

// The one-line record the Explore Channels directory lists. Deliberately
// tiny: the directory is a single index that has to stay cheap to read, and
// the full channel is one code lookup away.
function sharedChannelSummary(code, record) {
  const channel = record.channel || {};
  const showKeys = new Set((channel.items || []).map(channelItemShowKey));
  const sampleItems = (channel.items || []).slice(0, 9);
  return {
    code: code,
    slug: typeof slugifyServer === 'function' ? slugifyServer(channel.name || "channel") : "channel",
    name: channel.name || "Shared Channel",
    // The listing's own line when it has one, and the channel's otherwise --
    // so a channel that describes itself needs nothing typed again to be
    // published, and keeps that sentence when it is unpublished.
    description: record.description || channel.description || "",
    likes: Number(record.likes) || 0,
    adds: Number(record.adds) || 0,
    poster: channel.poster || null,
    backdrop: channel.backdrop || null,
    itemCount: (channel.items || []).length,
    showCount: showKeys.size,
    dailyRotate: !!channel.dailyRotate,
    shuffle: !!channel.shuffle,
    autoSort: channel.autoSort || "",
    dynamic: channel.dynamic || "",
    owner: record.owner || "",
    publishedAt: record.publishedAt || 0,
    sample: sampleItems.map((it) => ({
      name: it.showName || it.title || '',
      subtitle: it.epName || (it.season != null && it.episode != null ? ('S' + it.season + 'E' + it.episode) : ''),
      poster: it.thumbnail || it.poster || it.showPoster || it.backdrop || '',
      id: it.imdbId || it.id || '',
      kind: it.kind || it.type || 'series',
    })),
  };
}

// --- how a channel's day is put together -------------------------------
//
// Five payload flags shape a channel's lineup, and they are deliberately
// separate from the picks themselves so none of them rewrites what someone
// saved:
//
//   dailyRotate  a pool bigger than a day, cut into a fresh day's lineup
//                (Quick Add's networks, and now any custom channel that
//                asks for a broadcast schedule)
//   autoSort     a static arrangement, applied to the lineup after it is
//                picked -- "interleave" is the one the Worker acts on
//   storyLocked  shows that must advance in sequence through a shuffle or
//                a rotation instead of jumping around (storyLockedSince:
//                when each was locked -- the night a rotation starts it)
//   hideWatched  drop picks the account has already seen, until it has
//                seen them all
//   dynamic      a channel with no stored picks at all, re-derived per
//                request from the account's own tracking
//
// Everything below is the machinery for those. A payload carrying none of
// them plays exactly as it did before any of this existed.

// The show one channel item belongs to, as a stable grouping key. The daily
// rotation has always grouped by this expression; it is pulled out here so
// Story Lock, the interleaver and "Hide watched" group a channel the SAME
// way -- an item that rotates as part of "The Simpsons" has to lock and
// interleave as part of it too.
function channelItemShowKey(it) {
  if (!it) return "";
  return it.imdbId || `${it.kind || "episode"}:${it.title || ""}`;
}

// Broadcast order within one show. Only ever applied to a show that is
// story-locked, and only to that show's own run -- it never reorders one
// show against another.
function sortChannelItemsSequential(list) {
  return list.slice().sort((a, b) => {
    const sa = channelItemNumber(a.season);
    const sb = channelItemNumber(b.season);
    if (sa !== sb) return (sa === null ? 0 : sa) - (sb === null ? 0 : sb);
    const ea = channelItemNumber(a.episode);
    const eb = channelItemNumber(b.episode);
    return (ea === null ? 0 : ea) - (eb === null ? 0 : eb);
  });
}

// Round-robin across shows: one pick from each show in turn, then round
// again -- Simpsons S1E1, King of the Hill S1E1, Malcolm S1E1, Simpsons
// S1E2, and so on. What a 90s prime-time block actually felt like, and the
// opposite of playing fifty episodes of one show before the next one starts.
//
// Shows keep the order they first appear in and each show's own run keeps
// the order it arrived in, so this only changes WHEN each pick plays. It
// never reorders a show against itself, which is what makes it safe to run
// over a story-locked show, and it is idempotent -- interleaving an already
// interleaved lineup is a no-op, so the builder applying it to the saved
// order and the Worker applying it again here cannot fight.
function interleaveChannelItems(items) {
  const list = Array.isArray(items) ? items : [];
  if (list.length < 2) return list;
  const runs = new Map();
  for (const it of list) {
    const key = channelItemShowKey(it);
    if (!runs.has(key)) runs.set(key, []);
    runs.get(key).push(it);
  }
  if (runs.size < 2) return list;
  const lists = [...runs.values()];
  const longest = lists.reduce((n, l) => Math.max(n, l.length), 0);
  const out = [];
  for (let round = 0; round < longest; round++) {
    for (const run of lists) {
      if (round < run.length) out.push(run[round]);
    }
  }
  return out;
}

// The shows a channel marks as serialized. Stored as the same show keys
// channelItemShowKey produces, so a lock survives a show being re-added.
function channelStoryLockedKeys(payload) {
  const raw = Array.isArray(payload && payload.storyLocked) ? payload.storyLocked : [];
  return new Set(raw.map((k) => String(k || "").trim()).filter(Boolean));
}

// When each lock was turned on, as { showKey: epoch ms } -- stamped by the
// builder the moment a show is ticked. Kept only for shows that are actually
// locked, and only as a real timestamp.
function channelStoryLockSince(raw, lockedKeys) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const key of lockedKeys) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const ts = Number(raw[key]);
    if (Number.isFinite(ts) && ts > 0) out[key] = ts;
  }
  return out;
}

// The rotation day each locked show's walk starts from: the day it was
// locked, counted on the channel's own turnover so "locked this evening"
// means tonight's lineup, not whichever day midnight UTC says. A stamp from
// a clock running ahead is held to today rather than starting the walk
// somewhere past its first block. A lock with no stamp (saved before locks
// carried one) counts from CHANNEL_STORY_LOCK_LEGACY_START.
function channelStoryLockStartDays(payload, lockedKeys, turnoverMinutes, today) {
  const since = channelStoryLockSince(payload && payload.storyLockedSince, lockedKeys);
  const legacy = channelRotationDay(new Date(CHANNEL_STORY_LOCK_LEGACY_START), turnoverMinutes);
  const out = new Map();
  for (const key of lockedKeys) {
    out.set(key, Object.prototype.hasOwnProperty.call(since, key)
      ? Math.min(today, channelRotationDay(new Date(since[key]), turnoverMinutes))
      : legacy);
  }
  return out;
}

// Puts story-locked shows back into sequence after a shuffle.
//
// The POSITIONS a locked show occupies stay shuffled -- so it is still
// spread through the day rather than stuck in one block -- but the episodes
// that land in them are dealt out in broadcast order, so the show still
// advances E1, E2, E3 wherever it turns up. That is the whole point of the
// lock: daily variety without walking into the back half of a season.
function resequenceLockedShows(shuffled, sourceOrder, lockedKeys) {
  if (!lockedKeys || !lockedKeys.size) return shuffled;
  const queues = new Map();
  for (const it of sourceOrder) {
    const key = channelItemShowKey(it);
    if (!lockedKeys.has(key)) continue;
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key).push(it);
  }
  if (!queues.size) return shuffled;
  for (const [key, queue] of queues) queues.set(key, sortChannelItemsSequential(queue));
  const cursors = new Map();
  return shuffled.map((it) => {
    const key = channelItemShowKey(it);
    const queue = queues.get(key);
    if (!queue) return it;
    const at = cursors.get(key) || 0;
    cursors.set(key, at + 1);
    return queue[at] || it;
  });
}

function shuffleChannelItems(items, seed, lockedKeys) {
  return resequenceLockedShows(seededShuffle(items, seed), items, lockedKeys);
}

// --- pairing glue: multi-part episodes stay together ---------------------
//
// A rotation deals a contiguous block out of a show's run and a shuffle
// scatters it, and neither knows that "The Best of Both Worlds, Part I" is
// half a story. Part II landing tomorrow -- or three hours later, after four
// other shows -- is the one ordering result nobody wants.
//
// "Keep multi-part episodes together" turns on the detection below; a pair
// made by hand in the builder always applies, toggle or not, because it was
// asked for explicitly. Either way the rule is the same: the first part of a
// story to be drawn brings the rest of it along, immediately after, in part
// order.

// Roman numerals up to the group cap. Deliberately not a general parser:
// this only ever reads the "II" in "Part II", and a show with a Part XLII is
// not a show this needs to get right.
const CHANNEL_PART_ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };

// Splits an episode title into the story it belongs to and which part of it
// this is: "The Best of Both Worlds, Part II" -> { base: "the best of both
// worlds", part: 2 }. Returns null for a title that names no part, which is
// almost every episode ever made.
function channelPartTitleSplit(rawName) {
  const name = String(rawName == null ? "" : rawName).trim();
  if (!name) return null;
  // "... Part 2", "... Pt. II", "... part two" is not matched on purpose:
  // a spelled-out number is rare and the words are common enough in a
  // title ("Part of the Family") to be worth leaving alone.
  const worded = name.match(/^(.*?)[\s,:;–—-]*\(?\s*(?:part|pt\.?)\s*([0-9]{1,2}|[ivxIVX]{1,4})\s*\)?[\s.]*$/i);
  if (worded) {
    const raw = worded[2].toLowerCase();
    const part = /^[0-9]+$/.test(raw) ? parseInt(raw, 10) : (CHANNEL_PART_ROMAN[raw] || 0);
    if (part > 0 && worded[1].trim()) return { base: channelPartBaseKey(worded[1]), part: part };
    return null;
  }
  // The other form TMDB carries: a bare "(1)" / "(2)" suffix.
  const bracketed = name.match(/^(.*?)[\s,:;–—-]*\(([0-9]{1,2})\)[\s.]*$/);
  if (bracketed) {
    const part = parseInt(bracketed[2], 10);
    if (part > 0 && bracketed[1].trim()) return { base: channelPartBaseKey(bracketed[1]), part: part };
  }
  return null;
}

// Two halves of one story have to agree on their name to be recognized as
// halves, and they routinely differ in punctuation alone ("Worlds, Part I"
// vs "Worlds Part II"), so the comparison is made on letters and digits.
function channelPartBaseKey(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// The key a pairing is stored and looked up under: the item's stream id, so
// a pair made in the builder survives the channel being re-sorted, re-saved
// or shared, none of which keep array positions.
function channelItemPairKey(it) {
  return channelItemStreamId(it);
}

// Pairs the builder stored by hand, as arrays of stream ids.
function channelManualPairGroups(payload) {
  const raw = Array.isArray(payload && payload.pairedGroups) ? payload.pairedGroups : [];
  const out = [];
  for (const group of raw) {
    if (!Array.isArray(group)) continue;
    const keys = [];
    for (const k of group) {
      const key = String(k || "").trim();
      if (key && keys.indexOf(key) === -1) keys.push(key);
      if (keys.length >= CHANNEL_PART_GROUP_MAX) break;
    }
    if (keys.length > 1) out.push(keys);
  }
  return out;
}

// Every multi-part story in a pool, as a lookup from each member's key to
// the whole story in part order.
//
// A manual pair wins over a detected one for the same episode: it was asked
// for by hand, against a title the detection can only guess at.
function channelPartGroups(payload, poolItems) {
  const byKey = new Map();
  for (const it of poolItems) {
    const key = channelItemPairKey(it);
    if (key && !byKey.has(key)) byKey.set(key, it);
  }
  const lookup = new Map();
  const claim = (members) => {
    if (members.length < 2) return;
    const capped = members.slice(0, CHANNEL_PART_GROUP_MAX);
    if (capped.some((it) => lookup.has(channelItemPairKey(it)))) return;
    for (const it of capped) lookup.set(channelItemPairKey(it), capped);
  };
  for (const keys of channelManualPairGroups(payload)) {
    const members = keys.map((k) => byKey.get(k)).filter(Boolean);
    claim(members);
  }
  if (!payload.pairParts) return lookup;
  // Detected pairs: same show, same season, same story name, different part
  // numbers. Season matters -- a remake's "Part 1" ten seasons later is a
  // different story with the same name.
  const stories = new Map();
  for (const it of poolItems) {
    if (!it || it.kind === "movie") continue;
    const key = channelItemPairKey(it);
    if (!key) continue;
    const split = channelPartTitleSplit(it.epName);
    if (!split) continue;
    const season = channelItemNumber(it.season);
    const storyKey = `${channelItemShowKey(it)}|${season === null ? "" : season}|${split.base}`;
    if (!stories.has(storyKey)) stories.set(storyKey, []);
    stories.get(storyKey).push({ item: it, part: split.part });
  }
  for (const entries of stories.values()) {
    const seenParts = new Set();
    const members = [];
    for (const e of entries.slice().sort((a, b) => a.part - b.part)) {
      if (seenParts.has(e.part)) continue;
      seenParts.add(e.part);
      members.push(e.item);
    }
    claim(members);
  }
  return lookup;
}

// Applies those groups to a finished lineup.
//
// Wherever the first-drawn member of a story appears, the WHOLE story is
// played there, in part order, and its other members are dropped from
// wherever else they landed. A part that was not drawn at all is pulled in
// from the pool: a channel that gave you Part 1 and made you wait a day for
// Part 2 is the exact complaint this answers. A part that is not in the pool
// (never added, or filtered out by "Hide watched") simply is not there, and
// the rest still play together.
//
// Drawing Part 2 first plays the story from Part 1, for the same reason:
// the back half of a story on its own is worse than a minute of extra
// runtime.
function glueMultiPartEpisodes(items, poolItems, payload) {
  const groups = channelPartGroups(payload, poolItems);
  if (!groups.size) return items;
  const played = new Set();
  const out = [];
  for (const it of items) {
    const members = groups.get(channelItemPairKey(it));
    if (!members) {
      out.push(it);
      continue;
    }
    const storyId = channelItemPairKey(members[0]);
    if (played.has(storyId)) continue;
    played.add(storyId);
    for (const member of members) out.push(member);
  }
  return out;
}

// The dials behind a daily broadcast schedule. Quick Add's network channels
// have always rotated 24 shows x 3 episodes off midnight UTC; a custom
// channel can now say how many shows a day it runs, how many back-to-back
// episodes make up one show's block, and what time of day the lineup turns
// over. A payload that sets none of them keeps the network numbers, so every
// channel saved before this reads exactly as it did.
function channelRotationPlan(payload) {
  const dial = (raw, lo, hi, fallback) => {
    const n = typeof raw === "number" ? raw : parseInt(raw, 10);
    if (!Number.isInteger(n)) return fallback;
    return Math.min(hi, Math.max(lo, n));
  };
  // A saved channel stores 0 for a dial it never set -- the builder writes 0
  // for both counts whenever the schedule panel is closed, and an older
  // payload has no dials at all. 0 means "use the network numbers", not "run
  // one show a day", so it falls through to the fallback instead of being
  // clamped up to the floor of 1.
  const count = (raw, hi, fallback) => {
    const n = typeof raw === "number" ? raw : parseInt(raw, 10);
    if (!Number.isInteger(n) || n <= 0) return fallback;
    return Math.min(hi, n);
  };
  return {
    shows: count(payload.rotateShows, CHANNEL_ROTATION_MAX_SHOWS_PER_DAY, CHANNEL_ROTATION_SHOWS_PER_DAY),
    episodes: count(payload.rotateEpisodes, CHANNEL_ROTATION_MAX_EPISODES_PER_SHOW, CHANNEL_ROTATION_EPISODES_PER_SHOW),
    // Minutes past midnight UTC at which today's lineup becomes tomorrow's.
    // 0 is midnight UTC, which is what every rotating channel did before
    // this existed; a viewer in UTC-5 stores 300 so the channel turns over
    // at their own midnight rather than at 7pm the evening before.
    turnover: ((dial(payload.rotateTurnover, -1439, 1439, 0) % 1440) + 1440) % 1440,
  };
}

// Which day's lineup to serve -- days counted from the channel's own
// turnover time rather than from midnight UTC.
function channelRotationDay(now, turnoverMinutes) {
  return daysSinceEpochUTC(new Date(now.getTime() - turnoverMinutes * 60000));
}

// One day's lineup out of a pool: a handful of different shows with a few
// episodes each, rather than a flat random slice that could easily skew to
// dozens of episodes of one show and none of many others. Stable within a
// day, different the next.
//
// lockStartDays maps each story-locked show to the rotation day its walk
// starts from (see channelStoryLockStartDays). followWatched is set when
// "Hide watched" has trimmed the pool against a real watch history: a locked
// show then follows the viewer instead of the calendar (see below).
function rotateChannelDayLineup(playableItems, plan, seed, day, lockedKeys, lockStartDays, followWatched) {
  const byShow = new Map();
  for (const it of playableItems) {
    const key = channelItemShowKey(it);
    if (!byShow.has(key)) byShow.set(key, []);
    byShow.get(key).push(it);
  }
  // A story-locked show never sits out a night. Its whole promise is that it
  // ADVANCES, and a day without an airing is a day the walk would skip: the
  // seeded draw below used to drop it at will, so a show that missed a night
  // came back two blocks on -- one gap day meant landing in a different
  // season. Locked shows are kept unconditionally (they count against the
  // shows-per-day dial, and only the remaining slots go to the draw), so
  // "yesterday's block" is always yesterday.
  const order = seededShuffle([...byShow.keys()], seed);
  let unlockedLeft = plan.shows;
  for (const key of order) if (lockedKeys.has(key)) unlockedLeft -= 1;
  if (unlockedLeft < 0) unlockedLeft = 0;
  const showKeys = order.filter((key) => {
    if (lockedKeys.has(key)) return true;
    if (unlockedLeft <= 0) return false;
    unlockedLeft -= 1;
    return true;
  });
  const items = [];
  showKeys.forEach((key, i) => {
    const isLocked = lockedKeys.has(key);
    const showEpisodes = isLocked ? sortChannelItemsSequential(byShow.get(key)) : byShow.get(key);
    const perShow = Math.min(plan.episodes, showEpisodes.length);
    let start;
    if (isLocked && followWatched) {
      // Hiding watched, with a history to hide against: the pool is already
      // just what this viewer has not seen, so tonight is simply the next
      // episodes of it in broadcast order. The history is the bookmark --
      // watch S1E1-3 and S1E4-6 is next; miss a night and S1E1-3 waits for
      // you; binge to E9 and E10 is next. A calendar walk here would skip
      // what a missed night left unseen, and air nothing at all on the
      // nights it spent catching up with a binge.
      start = 0;
    } else if (isLocked) {
      // Otherwise the show walks its run one block a night from the day it
      // was locked: E1-3 that night, E4-6 the next, E7-9 the one after,
      // wrapping back to the beginning once it reaches the end.
      //
      // Counting nights from the lock, not from 1970, is what keeps the walk
      // where it is when the run changes length. It used to be `day % blocks`
      // with `day` in the tens of thousands, so one episode more or less --
      // "Automatically add new episodes", a Live Cloud Sync rebuild, an edit
      // in the builder -- could change `blocks` and throw the show to an
      // unrelated block, often another season. From the lock, on the first pass
      // through the run the count is below `blocks` and does not depend on
      // it at all: new episodes at the end just extend the walk. Once the run
      // has looped, a change in its block count moves the walk by about one
      // block per loop so far -- back when the run grew, forward when it
      // shrank. Still in order: a replay or a skip, never a scramble.
      // (Changing the episodes-a-night dial re-cuts the blocks the same
      // way.) Surviving even that would need a stored cursor, and a
      // lineup is resolved statelessly from the payload and the clock.
      //
      // The last block of a loop may be SHORT when the run is not a
      // multiple of the block size (eight episodes at three a night end on
      // E7-8) rather than clamping the start back to fill it, which replayed
      // the episode before it -- "in order" means no episode twice.
      const blocks = Math.max(1, Math.ceil(showEpisodes.length / perShow));
      const walked = day - ((lockStartDays && lockStartDays.get(key)) || 0);
      start = (((walked % blocks) + blocks) % blocks) * perShow;
    } else {
      // A contiguous block (not scattered episodes) feels like an actual
      // evening's run of a show -- seeded per-show so different shows
      // don't all land on the same relative starting point.
      const maxStart = showEpisodes.length - perShow;
      const starts = seededShuffle(
        Array.from({ length: maxStart + 1 }, (_, n) => n),
        seed + i + 1
      );
      start = starts.length ? starts[0] : 0;
    }
    items.push(...showEpisodes.slice(start, start + perShow));
  });
  return items;
}

// --- hide watched -------------------------------------------------------
//
// A channel item stores the show's IMDB id plus the season and episode
// numbers and never the episode's own TMDB id, so the numbers are the only
// thing a channel pick and a watch-history entry share. Movies match on the
// title id alone.
function channelWatchedKey(showId, season, episode) {
  const s = channelItemNumber(season);
  const e = channelItemNumber(episode);
  if (!showId || s === null || e === null) return "";
  return `${showId}:${s}:${e}`;
}

function channelWatchedKeySet(watchHistory) {
  const set = new Set();
  if (!Array.isArray(watchHistory)) return set;
  for (const w of watchHistory) {
    if (!w) continue;
    if (w.type === "movie" || (w.seasonNum == null && w.episodeNum == null)) {
      const id = String(w.id || w.imdbId || "").trim();
      if (id) set.add(id);
      continue;
    }
    const key = channelWatchedKey(String(w.showId || w.imdbId || "").trim(), w.seasonNum, w.episodeNum);
    if (key) set.add(key);
  }
  return set;
}

function channelItemIsWatched(it, watchedKeys) {
  if (!it || !watchedKeys.size) return false;
  const showId = String(it.imdbId || "").trim();
  if (!showId) return false;
  if (it.kind === "movie") return watchedKeys.has(showId);
  const key = channelWatchedKey(showId, it.season, it.episode);
  return !!key && watchedKeys.has(key);
}

// --- the Next Up channel ------------------------------------------------
//
// The next unwatched episode of every show the account has in progress.
//
// Continue Watching is already exactly that list -- the Auto-Track Playback
// scrobble and the new-episode cron both maintain it (see
// 26_api-creator-and-admin-routes.js and checkForNewEpisodes) -- so there is
// nothing to recompute here and not one TMDB call to make. A channel built
// this way stores no picks of its own: it is re-derived on every request, so
// it follows what the account is actually watching instead of freezing
// whatever happened to be true the day it was saved.
function channelNextUpItems(continueWatching) {
  if (!Array.isArray(continueWatching)) return [];
  const out = [];
  const seen = new Set();
  for (const cw of continueWatching) {
    if (!cw) continue;
    const showId = String(cw.showId || cw.imdbId || "").trim();
    const season = channelItemNumber(cw.seasonNum);
    const episode = channelItemNumber(cw.episodeNum);
    if (!showId || season === null || episode === null) continue;
    const key = `${showId}:${season}:${episode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const showName = String(cw.showTitle || "").trim();
    const epName = String(cw.name || "").trim() || `Episode ${episode}`;
    const poster = cw.showPoster || cw.poster || "";
    out.push({
      kind: "episode",
      imdbId: showId,
      season: season,
      episode: episode,
      showName: showName,
      epName: epName,
      title: showName ? `${showName} S${season}E${episode} — ${epName}` : epName,
      released: cw.released || "",
      poster: poster,
      thumbnail: cw.thumbnail || poster,
      showPoster: cw.showPoster || poster,
    });
  }
  return out;
}

// --- live cloud sync ----------------------------------------------------
//
// Importing a Trakt/MDBList/Simkl/TMDB list used to take a one-time snapshot:
// the episodes that existed the moment "Import channel" was pressed, frozen
// for good. A channel with `liveSync` keeps the source URL instead, and the
// Worker rebuilds its pool from that list in the background whenever the
// stored pool goes stale -- so a public list gaining a title gains it here
// too, with nothing to rebuild by hand.
//
// The rebuild never happens on the request's own critical path. A request
// serves whatever pool is stored (falling back to the channel's original
// snapshot when there is none yet) and schedules the refresh with
// ctx.waitUntil, so the first request after a list changes is no slower than
// any other and the next one sees the new titles.
const CHANNEL_LIVE_POOL_TTL_MS = 6 * 60 * 60 * 1000;
const CHANNEL_LIVE_POOL_MAX_SHOWS = 24;
const CHANNEL_LIVE_POOL_MAX_SEASONS = 3;
const CHANNEL_LIVE_POOL_MAX_ITEMS = 1200;

function channelLivePoolKey(channelId) {
  return `channelpool:${channelId}`;
}

// Channels whose pool this isolate is already rebuilding.
//
// A stale pool schedules a refresh on every request that sees it, and the
// pool only stops being stale once the first rebuild finishes -- which is
// dozens of TMDB calls later. Without this, a channel opened three times in
// that window runs the whole rebuild three times. Per-isolate, so it bounds
// the common case (one viewer, one colo, several requests) rather than
// pretending to be a distributed lock.
const CHANNEL_LIVE_POOL_IN_FLIGHT = new Set();

// Resolves a list URL to a channel-shaped pool of episodes. Deliberately
// capped: this runs on a background task with no one waiting on it, but it
// is still one TMDB season call per season per show.
async function buildChannelPoolFromListUrl(sourceUrl, keys) {
  let metas = [];
  try {
    metas = await fetchCatalog({ url: sourceUrl, type: "series" }, 0, keys);
  } catch {
    return [];
  }
  const shows = (metas || []).filter((m) => m && m.id).slice(0, CHANNEL_LIVE_POOL_MAX_SHOWS);
  if (!shows.length) return [];
  const tmdbKey = (keys && keys.tmdbKey) || TMDB_API_KEY;
  const perShow = await mapWithConcurrency(shows, 4, async (m) => {
    try {
      const findRes = await fetch(
        `https://api.themoviedb.org/3/find/${encodeURIComponent(m.id)}?api_key=${encodeURIComponent(tmdbKey)}&external_source=imdb_id`,
        { headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` }, cf: { cacheTtl: 604800, cacheEverything: true } }
      );
      if (!findRes.ok) return [];
      const findData = await findRes.json();
      const match = (findData.tv_results || [])[0];
      if (!match) return [];
      const showPoster = match.poster_path ? `https://image.tmdb.org/t/p/w500${match.poster_path}` : (m.poster || "");
      const showRes = await fetch(
        `https://api.themoviedb.org/3/tv/${encodeURIComponent(match.id)}?api_key=${encodeURIComponent(tmdbKey)}`,
        { headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` }, cf: { cacheTtl: 86400, cacheEverything: true } }
      );
      if (!showRes.ok) return [];
      const fullShow = await showRes.json();
      const seasons = (fullShow.seasons || [])
        .filter((s) => s && s.season_number > 0)
        .slice(0, CHANNEL_LIVE_POOL_MAX_SEASONS);
      const out = [];
      for (const s of seasons) {
        const sRes = await fetch(
          `https://api.themoviedb.org/3/tv/${encodeURIComponent(match.id)}/season/${s.season_number}?api_key=${encodeURIComponent(tmdbKey)}`,
          { headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` }, cf: { cacheTtl: 86400, cacheEverything: true } }
        );
        if (!sRes.ok) continue;
        const sData = await sRes.json();
        for (const ep of (sData.episodes || [])) {
          const stillUrl = ep.still_path ? `https://image.tmdb.org/t/p/w500${ep.still_path}` : "";
          const epName = ep.name || `Episode ${ep.episode_number}`;
          out.push({
            kind: "episode",
            imdbId: m.id,
            season: s.season_number,
            episode: ep.episode_number,
            showName: fullShow.name || m.name || "",
            epName: epName,
            title: `${fullShow.name || m.name || ""} S${s.season_number}E${ep.episode_number} — ${epName}`,
            released: ep.air_date || "",
            thumbnail: stillUrl || showPoster,
            poster: showPoster || stillUrl,
            showPoster: showPoster,
          });
        }
      }
      return out;
    } catch {
      return [];
    }
  });
  const items = [];
  for (const run of perShow) {
    for (const it of run) {
      if (items.length >= CHANNEL_LIVE_POOL_MAX_ITEMS) return items;
      items.push(it);
    }
  }
  return items;
}

async function refreshChannelLivePool(payload, opts) {
  const env = opts && opts.env;
  if (!env || !env.CONFIGS || !payload.sourceUrl || !payload.channelId) return null;
  if (CHANNEL_LIVE_POOL_IN_FLIGHT.has(payload.channelId)) return null;
  CHANNEL_LIVE_POOL_IN_FLIGHT.add(payload.channelId);
  try {
    return await refreshChannelLivePoolUncoordinated(payload, opts);
  } finally {
    CHANNEL_LIVE_POOL_IN_FLIGHT.delete(payload.channelId);
  }
}

async function refreshChannelLivePoolUncoordinated(payload, opts) {
  const env = opts.env;
  const items = await buildChannelPoolFromListUrl(payload.sourceUrl, {
    env: env,
    ctx: opts.ctx,
    origin: opts.origin || "",
    tmdbKey: opts.tmdbKey || "",
    mdblistKey: opts.mdblistKey || "",
    traktKey: opts.traktKey || "",
    traktAccessToken: opts.traktAccessToken || "",
  });
  if (!items.length) return null;
  await env.CONFIGS.put(
    channelLivePoolKey(payload.channelId),
    JSON.stringify({ sourceUrl: payload.sourceUrl, items: items, updatedAt: Date.now() }),
    { expirationTtl: 2592000 }
  );
  return items;
}

async function readChannelLivePool(payload, opts) {
  const env = opts && opts.env;
  if (!env || !env.CONFIGS || !payload.channelId) return null;
  let cached = null;
  try {
    const raw = await env.CONFIGS.get(channelLivePoolKey(payload.channelId));
    if (raw) cached = JSON.parse(raw);
  } catch {
    cached = null;
  }
  const usable = cached && Array.isArray(cached.items) && cached.items.length &&
    cached.sourceUrl === payload.sourceUrl;
  const stale = !usable || (Date.now() - (cached.updatedAt || 0)) > CHANNEL_LIVE_POOL_TTL_MS;
  if (stale && opts.ctx && typeof opts.ctx.waitUntil === "function") {
    opts.ctx.waitUntil(refreshChannelLivePool(payload, opts).catch(() => {}));
  }
  return usable ? cached.items : null;
}

// --- self-maintaining channels: new episodes arrive on their own ---------
//
// A channel is a snapshot: add The Last of Us today and the channel still
// carries exactly those episodes a year later, while the show has moved on
// without it. "Automatically add new episodes" closes that gap -- the Worker
// re-checks each show the channel carries and folds in whatever has aired
// since, at the top of the channel or at the end, as the channel says.
//
// Same shape as Live Cloud Sync above, and for the same reasons: the work is
// dozens of TMDB calls, so it happens on a background task with nobody
// waiting on it, the result is cached in KV, and a request serves what is
// stored and schedules the refresh rather than paying for it.
const CHANNEL_NEW_EPISODE_TTL_MS = 12 * 60 * 60 * 1000;
const CHANNEL_NEW_EPISODE_MAX_SHOWS = 30;
const CHANNEL_NEW_EPISODE_MAX_SEASONS = 2;
const CHANNEL_NEW_EPISODE_MAX_ITEMS = 300;
const CHANNEL_NEW_EPISODE_IN_FLIGHT = new Set();

function channelNewEpisodeKey(channelId) {
  return `channelnew:${channelId}`;
}

// What the channel already has, per show: the highest season it carries and
// every season:episode in it. The high-water mark is what makes the check
// cheap -- only seasons at or past it can hold anything new, so a channel of
// ten-season shows still costs one or two season calls each.
function channelShowWatermarks(items) {
  const marks = new Map();
  for (const it of items || []) {
    if (!it || it.kind === "movie") continue;
    const showId = channelItemShowId(it.imdbId);
    const season = channelItemNumber(it.season);
    const episode = channelItemNumber(it.episode);
    if (!showId || season === null || episode === null) continue;
    if (!marks.has(showId)) {
      marks.set(showId, {
        showId: showId,
        showName: it.showName || "",
        showPoster: it.showPoster || it.poster || "",
        maxSeason: season,
        have: new Set(),
      });
    }
    const mark = marks.get(showId);
    if (season > mark.maxSeason) mark.maxSeason = season;
    if (!mark.showName && it.showName) mark.showName = it.showName;
    if (!mark.showPoster && (it.showPoster || it.poster)) mark.showPoster = it.showPoster || it.poster;
    mark.have.add(`${season}:${episode}`);
  }
  return marks;
}

// Whether a cached answer still belongs to the channel that asked for it.
// Editing the channel -- adding a show, adding a season by hand -- changes
// the marks, and an answer computed against the old ones would re-add
// episodes the channel now carries itself.
function channelNewEpisodeSignature(marks) {
  const parts = [];
  for (const mark of marks.values()) parts.push(`${mark.showId}:${mark.maxSeason}:${mark.have.size}`);
  return String(hashStringToInt(parts.sort().join("|")));
}

// Everything one show has aired that this channel does not already carry.
// Unaired episodes are left alone: TMDB lists next month's episode the day
// it is announced, and a channel slot that plays nothing is worse than a
// channel that is a week behind.
async function fetchShowEpisodesAfter(mark, tmdbKey, today) {
  const idForTmdb = mark.showId.startsWith("tmdb:") ? mark.showId.slice(5) : "";
  let tmdbId = idForTmdb;
  if (!tmdbId) {
    const findRes = await fetch(
      `https://api.themoviedb.org/3/find/${encodeURIComponent(mark.showId)}?api_key=${encodeURIComponent(tmdbKey)}&external_source=imdb_id`,
      { headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` }, cf: { cacheTtl: 604800, cacheEverything: true } }
    );
    if (!findRes.ok) return [];
    const findData = await findRes.json();
    const match = (findData.tv_results || [])[0];
    if (!match) return [];
    tmdbId = String(match.id);
  }
  const showRes = await fetch(
    `https://api.themoviedb.org/3/tv/${encodeURIComponent(tmdbId)}?api_key=${encodeURIComponent(tmdbKey)}`,
    { headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` }, cf: { cacheTtl: 21600, cacheEverything: true } }
  );
  if (!showRes.ok) return [];
  const fullShow = await showRes.json();
  const showName = mark.showName || fullShow.name || "";
  const showPoster = mark.showPoster ||
    (fullShow.poster_path ? `https://image.tmdb.org/t/p/w500${fullShow.poster_path}` : "");
  const seasons = (fullShow.seasons || [])
    .filter((s) => s && s.season_number >= mark.maxSeason)
    .sort((a, b) => a.season_number - b.season_number)
    .slice(0, CHANNEL_NEW_EPISODE_MAX_SEASONS);
  const out = [];
  for (const s of seasons) {
    const sRes = await fetch(
      `https://api.themoviedb.org/3/tv/${encodeURIComponent(tmdbId)}/season/${s.season_number}?api_key=${encodeURIComponent(tmdbKey)}`,
      { headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` }, cf: { cacheTtl: 21600, cacheEverything: true } }
    );
    if (!sRes.ok) continue;
    const sData = await sRes.json();
    for (const ep of (sData.episodes || [])) {
      const season = channelItemNumber(s.season_number);
      const episode = channelItemNumber(ep && ep.episode_number);
      if (season === null || episode === null) continue;
      if (mark.have.has(`${season}:${episode}`)) continue;
      const aired = String(ep.air_date || "");
      if (!aired || aired > today) continue;
      const stillUrl = ep.still_path ? `https://image.tmdb.org/t/p/w500${ep.still_path}` : "";
      const epName = ep.name || `Episode ${episode}`;
      out.push({
        kind: "episode",
        imdbId: mark.showId,
        season: season,
        episode: episode,
        showName: showName,
        epName: epName,
        title: `${showName} S${season}E${episode} — ${epName}`,
        released: aired,
        thumbnail: stillUrl || showPoster,
        poster: showPoster || stillUrl,
        showPoster: showPoster,
      });
    }
  }
  return out;
}

// Newest first, so "put new episodes at top" puts the newest one at the very
// top rather than the oldest of the new ones.
function sortChannelNewEpisodes(items) {
  return items.slice().sort((a, b) => {
    const da = String(a.released || "");
    const db = String(b.released || "");
    if (da !== db) return db < da ? -1 : 1;
    const sa = channelItemNumber(a.season) || 0;
    const sb = channelItemNumber(b.season) || 0;
    if (sa !== sb) return sb - sa;
    return (channelItemNumber(b.episode) || 0) - (channelItemNumber(a.episode) || 0);
  });
}

async function buildChannelNewEpisodes(marks, keys) {
  const tmdbKey = (keys && keys.tmdbKey) || TMDB_API_KEY;
  const today = new Date().toISOString().slice(0, 10);
  const shortlist = [...marks.values()].slice(0, CHANNEL_NEW_EPISODE_MAX_SHOWS);
  const perShow = await mapWithConcurrency(shortlist, 4, async (mark) => {
    try {
      return await fetchShowEpisodesAfter(mark, tmdbKey, today);
    } catch {
      return [];
    }
  });
  const found = [];
  for (const run of perShow) {
    for (const it of run) found.push(it);
  }
  return sortChannelNewEpisodes(found).slice(0, CHANNEL_NEW_EPISODE_MAX_ITEMS);
}

async function refreshChannelNewEpisodes(payload, opts) {
  const env = opts && opts.env;
  if (!env || !env.CONFIGS || !payload.channelId) return null;
  if (CHANNEL_NEW_EPISODE_IN_FLIGHT.has(payload.channelId)) return null;
  CHANNEL_NEW_EPISODE_IN_FLIGHT.add(payload.channelId);
  try {
    const marks = channelShowWatermarks(Array.isArray(payload.items) ? payload.items : []);
    if (!marks.size) return null;
    const items = await buildChannelNewEpisodes(marks, {
      tmdbKey: opts.tmdbKey || "",
    });
    await env.CONFIGS.put(
      channelNewEpisodeKey(payload.channelId),
      JSON.stringify({
        signature: channelNewEpisodeSignature(marks),
        items: items,
        updatedAt: Date.now(),
      }),
      { expirationTtl: 2592000 }
    );
    return items;
  } finally {
    CHANNEL_NEW_EPISODE_IN_FLIGHT.delete(payload.channelId);
  }
}

// An empty answer is cached like any other -- a channel whose shows are all
// finished would otherwise re-check every single request forever.
async function readChannelNewEpisodes(payload, opts) {
  const env = opts && opts.env;
  if (!env || !env.CONFIGS || !payload.channelId) return null;
  let cached = null;
  try {
    const raw = await env.CONFIGS.get(channelNewEpisodeKey(payload.channelId));
    if (raw) cached = JSON.parse(raw);
  } catch {
    cached = null;
  }
  const marks = channelShowWatermarks(Array.isArray(payload.items) ? payload.items : []);
  const usable = !!(cached && Array.isArray(cached.items) &&
    cached.signature === channelNewEpisodeSignature(marks));
  const stale = !usable || (Date.now() - (cached.updatedAt || 0)) > CHANNEL_NEW_EPISODE_TTL_MS;
  if (stale && opts.ctx && typeof opts.ctx.waitUntil === "function") {
    opts.ctx.waitUntil(refreshChannelNewEpisodes(payload, opts).catch(() => {}));
  }
  return usable ? cached.items : null;
}

// Folds the newly-aired episodes into the channel's own picks. Anything the
// channel already carries is dropped from the new side rather than played
// twice -- the cached answer can be a few hours older than an edit that
// added the same episode by hand.
function mergeChannelNewEpisodes(stored, fresh, atTop) {
  if (!Array.isArray(fresh) || !fresh.length) return stored;
  const have = new Set();
  for (const it of stored) {
    const key = channelItemStreamId(it);
    if (key) have.add(key);
  }
  const added = [];
  for (const it of fresh) {
    const key = channelItemStreamId(it);
    if (!key || have.has(key)) continue;
    have.add(key);
    added.push(it);
  }
  if (!added.length) return stored;
  return atTop ? added.concat(stored) : stored.concat(added);
}

// The pool a channel draws today's lineup from, before any ordering.
//
// Four shapes: a normal channel plays the picks stored on it; a dynamic
// channel (Next Up) has none and is re-derived per request from the
// account's own tracking; a Live Cloud Sync channel prefers the pool the
// Worker last rebuilt from the list it was imported from, keeping its
// stored picks as the fallback for before that first rebuild lands; and a
// Quick Add network channel carries a presetNetworkId pointer alongside a
// small (CHANNEL_POINTER_SAMPLE_ITEMS) sample of its own -- see
// parseChannelPayload's own comment for why that sample exists at all. The
// real pool always wins when it is reachable: resolved from the shared,
// cron-prewarmed cache right here, before any of the other three shapes get
// a chance to run, with the small sample as the fallback for the rare case
// the cache lookup itself fails (env not wired through, or a genuine outage).
async function channelSourceItems(payload, opts) {
  let stored = Array.isArray(payload.items) ? payload.items : [];
  if (payload.presetNetworkId && opts && opts.env) {
    try {
      const preset = await buildNetworkChannelPreset(
        String(payload.presetNetworkId),
        payload.name || "TV Channel",
        opts.origin || CHANNEL_PRESET_PREWARM_ORIGIN,
        { env: opts.env, ctx: opts.ctx }
      );
      if (preset && preset.ok && preset.channel && Array.isArray(preset.channel.items) && preset.channel.items.length) {
        stored = preset.channel.items;
      }
    } catch (e) {}
  }
  if (payload.dynamic === "next-up") {
    // The live answer when there is one, and the seed the builder stored
    // otherwise.
    //
    // The fallback is not belt-and-braces: resolveConfig only hands over
    // continueWatching for a config that PROVED whose it is, and a config
    // with no personal shelf in it never does -- so for those the live
    // derivation is empty every time and the seed is the only lineup the
    // channel will ever have. Returning nothing there is what made this
    // channel come back blank.
    const live = channelNextUpItems(opts.continueWatching);
    return live.length ? live : stored;
  }
  let base = stored;
  if (payload.liveSync && payload.sourceUrl) {
    const live = await readChannelLivePool(payload, opts).catch(() => null);
    if (live && live.length) base = live;
  }
  // "Automatically add new episodes" folds in whatever has aired since the
  // channel was built. It sits after Live Cloud Sync rather than instead of
  // it: one keeps up with the LIST a channel came from, the other with the
  // SHOWS in it, and a channel can reasonably want both.
  if (payload.autoNewEpisodes) {
    const fresh = await readChannelNewEpisodes(payload, opts).catch(() => null);
    if (fresh && fresh.length) base = mergeChannelNewEpisodes(base, fresh, !!payload.newEpisodesAtTop);
  }
  return base;
}

// The full stream id for one channel item, or "" if it cannot be formed.
function channelItemStreamId(it) {
  if (!it) return "";
  const showId = channelItemShowId(it.imdbId);
  if (!showId) return "";
  if (it.kind === "movie") return showId;
  const season = channelItemNumber(it.season);
  const episode = channelItemNumber(it.episode);
  if (season === null || episode === null) return "";
  return `${showId}:${season}:${episode}`;
}

// Today's lineup for one channel payload: the picks, in the order they will
// actually play, after the pool, the rules and the arrangement have all been
// applied.
//
// Split out of buildChannelMeta so the builder page can show what a rotating
// channel is running right now (see /api/channel-lineup). The alternative --
// a second copy of the seeded shuffle on the client -- is the kind of thing
// that drifts by one episode after some later edit and is never noticed.
async function resolveChannelLineup(payload, opts = {}) {
  const sourceItems = await channelSourceItems(payload, opts);

  // "Randomize play order" (set once in the Channel builder, stored on the
  // payload) reshuffles once a day rather than on every single request --
  // same reasoning as Hidden Gems' daily reshuffle (see daysSinceEpochUTC
  // below): the order stays put if someone reopens the channel later the
  // same day (mid-binge), but looks freshly shuffled again tomorrow.
  //
  // "Sort by air date" is the alternative to it (one or the other, never
  // both) and is applied further down, after the rotation below: it needs
  // no seed because it is the same order every day.
  //
  // dailyRotate is a step further -- set by Quick Add Channel, and now by
  // any custom channel that turns on a Daily Broadcast Schedule: the
  // payload stores a much bigger pool than what's ever actually shown, and
  // this picks a fresh, structured day's lineup from that pool -- a handful
  // of different shows with a few episodes each (see channelRotationPlan),
  // not a flat random slice that could easily skew to dozens of episodes of
  // one show and none of many others. Stable within a day, different the
  // next.
  const plan = channelRotationPlan(payload);
  // Duck-typed rather than `instanceof Date`: the tests evaluate this file
  // in a vm realm of their own, where a Date built outside it is not an
  // instanceof the Date inside it, and the injected clock would silently be
  // ignored. A timestamp is accepted for the same reason -- there is no
  // realm it can be wrong in.
  const now = typeof opts.now === "number"
    ? new Date(opts.now)
    : (opts.now && typeof opts.now.getTime === "function" ? opts.now : new Date());
  const day = channelRotationDay(now, plan.turnover);
  const seed = day + hashStringToInt(String(payload.channelId || payload.name || ""));
  const lockedKeys = channelStoryLockedKeys(payload);
  // Anything that cannot produce a real stream id (see channelItemStreamId
  // above) is dropped HERE, before the rotation or the shuffle runs, so a
  // dropped item costs the channel one slot rather than leaving a hole in
  // the middle of a day's lineup -- and so the running order below stays
  // 1..N with no gaps.
  let playableItems = sourceItems.filter((it) => channelItemStreamId(it));
  // "Hide watched" comes before the rotation for the same reason: an
  // already-seen episode should cost the channel nothing, not a slot in
  // today's lineup. When the whole pool has been seen the channel resets to
  // the full pool rather than going dark -- an empty channel reads as
  // broken, and there is nothing else left to offer.
  //
  // followWatched tells the rotation the trim happened against a real
  // history, which is when a story-locked show follows the viewer rather
  // than the calendar (see rotateChannelDayLineup). An empty history does
  // not count: resolveConfig hands over [] for an account with no tracking
  // at all, and following THAT would hold a locked show on its first three
  // episodes forever. Nor does the all-seen reset, where the channel has
  // chosen to forget what was seen.
  let followWatched = false;
  if (payload.hideWatched) {
    const watchedKeys = channelWatchedKeySet(opts.watchHistory);
    const unwatched = playableItems.filter((it) => !channelItemIsWatched(it, watchedKeys));
    if (unwatched.length) {
      playableItems = unwatched;
      followWatched = watchedKeys.size > 0;
    }
  }
  if (!playableItems.length) return null;
  let items;
  if (payload.dailyRotate) {
    const lockStartDays = channelStoryLockStartDays(payload, lockedKeys, plan.turnover, day);
    items = rotateChannelDayLineup(playableItems, plan, seed, day, lockedKeys, lockStartDays, followWatched);
  } else if (payload.shuffle && !payload.sortByAired) {
    items = shuffleChannelItems(playableItems, seed, lockedKeys);
  } else {
    items = playableItems;
  }
  // "Sort by air date" is the other half of the same choice: the builder
  // offers it and "Randomize play order" as one-or-the-other (checking
  // either clears the other), so a payload should never arrive with both
  // set. An older payload still can -- shuffle was the only flag that
  // existed -- so the explicit sort wins here as well, rather than leaving
  // the outcome to whichever branch happened to be tested first.
  //
  // It is applied last so it also orders a rotated day's lineup: a rotating
  // channel picks WHICH shows and episodes play today (above), and this
  // decides the order they play in. Interleaving sits in the same slot for
  // the same reason -- it is what turns a rotated day's handful of shows
  // into an actual prime-time block instead of five blocks back to back.
  if (payload.sortByAired) items = sortChannelItemsByAired(items);
  else if (payload.autoSort === "interleave") items = interleaveChannelItems(items);
  // Last of all, because every step above can separate two halves of one
  // story: the rotation deals a block that ends between them, the shuffle
  // scatters them, the interleaver puts four other shows in between. Gluing
  // here is the only place that cannot be undone by a later step.
  items = glueMultiPartEpisodes(items, playableItems, payload);
  return { items, sourceItems, plan, day, seed };
}

async function buildChannelMeta(entry, origin, opts = {}) {
  const payload = parseChannelPayload(entry.url);
  if (!payload) return null;
  // payload.channelId/payload.name (not entry.id/entry.name) are the real
  // identity -- see the same note in fetchChannelCatalog above.
  const channelId = payload.channelId || entry.id;
  const name = payload.name || entry.name;
  // channelSourceItems needs origin (to resolve a Quick Add channel's
  // presetNetworkId pointer) but only ever sees `opts`, not this function's
  // own separate `origin` param -- normalized here once rather than trusting
  // every caller to duplicate it into opts.origin themselves.
  if (!opts.origin) opts = Object.assign({}, opts, { origin });
  const lineup = await resolveChannelLineup(payload, opts);
  if (!lineup) return null;
  const items = lineup.items;
  const sourceItems = lineup.sourceItems;
  const videos = items.map((it, i) => {
    // TMDB's air_date/release_date (and our own year-only fallback for
    // movies) are bare "YYYY-MM-DD" dates. Stremio Web's core is compiled
    // from Rust (see the stremio-core-web/*.wasm console errors this
    // surfaced during debugging) -- its deserializer likely expects a full
    // ISO 8601 *datetime* here and can silently fail to parse the whole
    // meta object on a bare date, unlike a loose JS parser that wouldn't
    // care. Giving it a datetime costs nothing, since we only ever had a
    // date to begin with.
    //
    // 11:00 UTC, not midnight: a client renders this in the VIEWER's
    // timezone, and midnight UTC is the previous evening everywhere west of
    // Greenwich -- which is why a 1996 movie in a channel read "Dec 31,
    // 1995" across the Americas.
    //
    // An instant at hour H shows as the date we meant in every zone whose
    // offset is in [-H, 24-H). World offsets span UTC-12 to UTC+14, 26 hours,
    // so no single instant covers all of them and two hours' worth are always
    // wrong. H=11 covers UTC-11 to UTC+12:59 -- every inhabited zone except
    // UTC+13/+14 (NZ daylight, Samoa, Tonga, Kiribati) -- and is one better
    // than midday, which also slips in New Zealand.
    const releaseDate = it.released || (it.year ? `${it.year}-01-01` : undefined);
    return {
      id: channelItemStreamId(it),
      title: it.title,
      season: 1,
      episode: i + 1,
      released: releaseDate ? `${releaseDate}T11:00:00.000Z` : undefined,
      thumbnail: it.thumbnail || it.poster || payload.poster || undefined,
    };
  });
  // Premade network channels with an official logo
  const isPremadeLogo = Boolean(payload.poster && (payload.poster.includes("/api/channel-logo") || payload.isPreset || payload.networkId));
  const isShowPoster = Boolean(payload.poster && payload.poster.startsWith("http") && !payload.poster.includes("/api/channel-"));

  let matchedBackdrop = (payload.backdrop && payload.backdrop.startsWith("http") && !payload.backdrop.includes("/api/channel-")) ? payload.backdrop : null;
  if (isShowPoster && !matchedBackdrop && sourceItems.length) {
    const match = sourceItems.find((it) => it && (it.showPoster === payload.poster || it.poster === payload.poster));
    if (match) {
      matchedBackdrop = match.backdrop || match.showBackdrop || match.thumbnail || null;
    }
  }

  const channelPoster = isPremadeLogo
    ? getPremadeChannelLogo(payload, origin, false)
    : isShowPoster
      ? payload.poster
      : getChannelPoster(payload, origin);
  const channelBackdrop = isPremadeLogo
    ? getPremadeChannelLogo(payload, origin, true)
    : (matchedBackdrop || getChannelBackdrop(payload, origin));

  return {
    id: "channel_" + channelId,
    type: "series",
    name: name,
    poster: channelPoster,
    background: channelBackdrop,
    thumbnail: channelBackdrop,
    posterShape: isShowPoster ? "poster" : "landscape",
    videos,
  };
}

// mdblist's json feeds (public list feed and the REST API) are both either a
// flat array of items, or an object with `movies` / `shows` arrays depending
// on list contents. This normalizes + filters + maps either shape to metas.

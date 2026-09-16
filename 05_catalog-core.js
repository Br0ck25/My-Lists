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
    else if (source === "mdblist-airing-next") { trackSharedApiUse(keys, !(keys.mdblistKey || keys.mdblistAccessToken), "mdblist"); result = await fetchMdblistAiringNext(entry, skip, mdblistKey, keys.mdblistAccessToken || "", keys.tmdbKey || TMDB_API_KEY, keys.env, keys.ctx); }
    else if (source === "trakt") { trackSharedApiUse(keys, !keys.traktKey, "trakt"); result = await fetchTrakt(entry, skip, traktKey, keys.traktAccessToken || "", keys.env, keys.ctx); }
    else if (source === "trakt-watchlist") { trackSharedApiUse(keys, !keys.traktKey, "trakt"); result = await fetchTraktWatchlist(entry, skip, traktKey, keys.traktAccessToken || "", keys.env, keys.ctx); }
    else if (source === "trakt-history") { trackSharedApiUse(keys, !keys.traktKey, "trakt"); result = await fetchTraktHistory(entry, skip, traktKey, keys.traktAccessToken || "", keys.env, keys.ctx); }
    else if (source === "trakt-airing-next") { trackSharedApiUse(keys, !keys.traktKey, "trakt"); result = await fetchTraktAiringNext(entry, skip, traktKey, keys.traktAccessToken || "", keys.tmdbKey || TMDB_API_KEY, keys.env, keys.ctx); }
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

  if (keys.isStremioCatalog === true && keys.origin && Array.isArray(result) && result.length > 0) {
    const entryUrl = String(entry.url || '');
    const entryName = String(entry.name || '').toLowerCase();
    const isAiringNext = entryUrl.includes('airing-next') || entryUrl.includes('airing_next') || entry.statusKey === 'airing-next' || entry.slug === 'airing-next' || entry.id === 'airing-next' || entryName.includes('airing next');
    const isContinueWatching = entryUrl.includes('continue-watching') || entryUrl.includes('continue_watching') || entry.statusKey === 'continue-watching' || entry.slug === 'continue-watching' || entry.id === 'continue-watching' || entryName.includes('continue watching');

    let allowBadges = false;
    if (isAiringNext) {
      allowBadges = keys.showBadgesStremioAiringNext !== false && keys.showBadgesStremio !== false;
    } else if (isContinueWatching) {
      allowBadges = keys.showBadgesStremioContinueWatching !== false && keys.showBadgesStremio !== false;
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
    <g filter="url(#shadow)">
      <text text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="900" fill="#FFFFFF" letter-spacing="1">
        ${textSpans}
      </text>
    </g>

    <!-- TV Control Knobs / Accent Dots -->
    <circle cx="170" cy="115" r="6" fill="#007AFF" opacity="0.8" />
    <circle cx="148" cy="115" r="6" fill="#AF52DE" opacity="0.8" />
  </g>

  <!-- Bottom TV Channel Pill Badge -->
  <g transform="translate(300, 780)">
    <rect x="-120" y="-20" width="240" height="40" rx="20" fill="url(#accentGrad)" />
    <text x="0" y="6" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="15" font-weight="900" fill="#FFFFFF" text-anchor="middle" letter-spacing="2.5">TV CHANNEL</text>
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
    <g filter="url(#shadow)">
      <text text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="900" fill="#FFFFFF" letter-spacing="1">
        ${textSpans}
      </text>
    </g>

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
      <text x="${topPillWidth / 2}" y="49" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" font-size="36" font-weight="900" fill="#ffffff" text-anchor="middle" letter-spacing="1.2">${safeAirDate}</text>
    </g>` : '';

  const bottomBadgeSvg = safeBottom ? `
    <g transform="translate(250, 715)">
      <rect x="${-bottomPillWidth / 2}" y="-84" width="${bottomPillWidth}" height="84" rx="20" ry="20" fill="${bottomBg || '#ff9f0a'}" fill-opacity="0.95" stroke="${bottomBorder || 'rgba(255,159,10,0.7)'}" stroke-width="4.5" filter="drop-shadow(0px 8px 16px rgba(0,0,0,0.85))"/>
      <text x="0" y="-30" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" font-size="38" font-weight="900" fill="${bottomColor || '#ffffff'}" text-anchor="middle" letter-spacing="1.5">${safeBottom}</text>
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
    <text x="0" y="27" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="16" font-weight="800" fill="#ffffff" text-anchor="middle" letter-spacing="1.5">SAFE POSTER</text>
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
  <text x="250" y="${titleStartY}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="34" font-weight="800" fill="#f3f4f6" text-anchor="middle" letter-spacing="0.5" filter="url(#safeShadow)">
    ${titleTextSpans}
  </text>

  <!-- Metadata: Type & Year -->
  <g transform="translate(250, 560)">
    <rect x="-90" y="-18" width="180" height="36" rx="8" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.12)" stroke-width="1.5"/>
    <text x="0" y="6" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="16" font-weight="700" fill="#9ca3af" text-anchor="middle" letter-spacing="1">
      ${safeType}${safeYear ? ' • ' + safeYear : ''}
    </text>
  </g>

  <!-- Certification / Footer -->
  <g transform="translate(250, 680)">
    <text x="0" y="0" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="14" font-weight="600" fill="#6b7280" text-anchor="middle" letter-spacing="0.8">
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
    if (!payload || !payload.items || !payload.items.length) continue;
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
  let sampleIds = [];
  // The exact list the Discover tab last showed for this account, pushed
  // up alongside Watch History/Continue Watching/Airing Next by
  // pushTrackingSync (22_client-creator-profile.js). Preferred over
  // re-deriving below because re-deriving cannot reproduce it: the card's
  // seeds come from the browser's full picture (Continue Watching + Watch
  // History + Watchlist + every other custom list), while this function
  // can only see what tracking data made it to the server. Same reason
  // Airing Next is served from a pushed snapshot rather than recomputed.
  let storedRecs = null;

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
          const recBlob = tracking.curatedRecommendations;
          if (recBlob && typeof recBlob === 'object') {
            const candidate = isSeries ? recBlob.shows : recBlob.movies;
            if (Array.isArray(candidate) && candidate.length) storedRecs = candidate;
          }
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

  // The snapshot path. Serves exactly the items the Discover card last
  // showed, in exactly that order, cut to exactly the same length -- so
  // "40 items" on the card and 40 items in the shelf are the same 40.
  if (storedRecs) {
    const capped = storedRecs.slice(0, CURATED_RECOMMENDATION_LIMIT);
    if (skip >= capped.length) return [];
    const mapped = await Promise.all(
      capped.slice(skip, skip + PAGE_SIZE).map((it) => mapStoredRecommendationToMeta(it, isSeries, tmdbKey).catch(() => null))
    );
    const out = mapped.filter(Boolean);
    // Only trust the snapshot if it actually resolved to something. An
    // empty result here (every external_ids call failed, say) falls
    // through to the live derivation below rather than serving an empty
    // shelf, the same fallback shape fetchCustomListCatalog already uses.
    if (out.length) {
      out.totalItems = capped.length;
      return out;
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
        // CURATED_RECOMMENDATION_LIMIT, not PAGE_SIZE: this list is the
        // same list the Discover card shows, and that card is built from
        // a response cut to exactly this many items. Cutting the pool
        // first (rather than the page) also means paging stops where the
        // card says the list ends instead of running on to 100.
        const capped = combined.slice(0, CURATED_RECOMMENDATION_LIMIT);
        if (skip >= capped.length) {
          return [];
        }
        const mapped = await Promise.all(capped.slice(skip, skip + PAGE_SIZE).map(async (it) => {
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
        const derived = mapped.filter(Boolean);
        derived.totalItems = capped.length;
        return derived;
      }
    } catch {}
  }

  // Fallback: If user has no personalized history, return only the first page of TMDB Popular
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
    if (env && env.DB) {
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
        if (rows && rows.length) {
          items = rows.filter(r => {
            if (!r) return false;
            const sid = String(r.show_id || '');
            const base = trackingShowKey(sid);
            const isComp = r.show_title && r.show_title.startsWith('COMPANION:');
            if (!isComp && (fullyWatchedSet.has(sid) || (base && fullyWatchedSet.has(base)))) return false;
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
        if (slug === 'continue-watching') {
          airingItems = trackingBlob.airingNext || [];
          const fwList = Array.isArray(trackingBlob.fullyWatchedShowIds) ? trackingBlob.fullyWatchedShowIds.map(String) : [];
          if (fwList.length && Array.isArray(items)) {
            const fwSet = new Set(fwList);
            items = items.filter(it => {
              if (!it) return false;
              if (it.isCompanion) return true;
              const sid = String(it.showId || it.id || '');
              const base = trackingShowKey(sid);
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
        if (slug === 'continue-watching') {
          airingItems = blob.airingNext || [];
          const fwList = Array.isArray(blob.fullyWatchedShowIds) ? blob.fullyWatchedShowIds.map(String) : [];
          if (fwList.length && Array.isArray(items)) {
            const fwSet = new Set(fwList);
            items = items.filter(it => {
              if (!it) return false;
              if (it.isCompanion) return true;
              const sid = String(it.showId || it.id || '');
              const base = trackingShowKey(sid);
              if (fwSet.has(sid) || (base && fwSet.has(base))) return false;
              return true;
            });
          }
        }
      }
    }
    if (!items || !items.length) return [];
    
    const airingByShowId = new Map();
    const airingByBaseId = new Map();
    const airingByTitle = new Map();
    if (slug === 'continue-watching' && Array.isArray(airingItems) && airingItems.length) {
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

      if (slug === 'continue-watching' && (airingByShowId.size || airingByBaseId.size || airingByTitle.size)) {
        let airingMatch = null;
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
            const epHasAired = hasLaterAiringEp || (effectiveAirDate && typeof isEpisodeAired === 'function' && isEpisodeAired(effectiveAirDate));
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
  // "Sort by air date" is the alternative to it (one or the other, never
  // both) and is applied further down, after the rotation below: it needs
  // no seed because it is the same order every day.
  //
  // dailyRotate is a step further, set by Quick Add Channel: the payload
  // stores a much bigger pool than what's ever actually shown, and this
  // picks a fresh, structured day's lineup from that pool -- a handful of
  // different shows with a few episodes each (see the constants above),
  // not a flat random slice that could easily skew to dozens of episodes
  // of one show and none of many others. Stable within a day, different
  // the next.
  const seed = daysSinceEpochUTC(new Date()) + hashStringToInt(channelId);
  // Anything that cannot produce a real stream id (see channelItemStreamId
  // above) is dropped HERE, before the rotation or the shuffle runs, so a
  // dropped item costs the channel one slot rather than leaving a hole in
  // the middle of a day's lineup -- and so the running order below stays
  // 1..N with no gaps.
  const playableItems = payload.items.filter((it) => channelItemStreamId(it));
  let items;
  if (payload.dailyRotate) {
    const byShow = new Map();
    playableItems.forEach((it) => {
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
  } else if (payload.shuffle && !payload.sortByAired) {
    items = seededShuffle(playableItems, seed);
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
  // It is applied last so it also orders a rotated day's lineup: a Quick Add
  // channel picks WHICH shows and episodes play today (above), and this
  // decides the order they play in.
  if (payload.sortByAired) items = sortChannelItemsByAired(items);
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
  if (isShowPoster && !matchedBackdrop && Array.isArray(payload.items)) {
    const match = payload.items.find((it) => it && (it.showPoster === payload.poster || it.poster === payload.poster));
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

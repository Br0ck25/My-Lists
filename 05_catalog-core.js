// --- manifest ----------------------------------------------------------

function buildManifest(entries, origin, track) {
  const active = entries.filter((e) => e.enabled !== false);
  const resources = ["catalog", { name: "meta", types: ["series"], idPrefixes: ["channel_"] }];
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
async function fetchCatalog(entry, skip = 0, keys = {}) {
  const urls = String(entry.url || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (urls.length > 1) {
    return fetchMergedCatalog(urls, entry.type, skip, keys);
  }

  const mdblistKey = keys.mdblistKey || MDBLIST_API_KEY;
  const traktKey = keys.traktKey || TRAKT_CLIENT_ID;
  const source = detectSource(entry.url);
  if (source === "mdblist-watchlist") return fetchMdblistWatchlist(entry, skip, mdblistKey);
  if (source === "trakt") return fetchTrakt(entry, skip, traktKey, keys.traktAccessToken || "");
  if (source === "trakt-watchlist") return fetchTraktWatchlist(entry, skip, traktKey, keys.traktAccessToken || "");
  if (source === "trakt-history") return fetchTraktHistory(entry, skip, traktKey, keys.traktAccessToken || "");
  if (source === "tmdb") return fetchTmdb(entry, skip, TMDB_API_KEY);
  if (source === "tmdb-chart") return fetchTmdbChart(entry, skip, TMDB_API_KEY, entry.url.trim().slice("tmdb:chart:".length));
  if (source === "tmdb-hidden-gems") return fetchTmdbHiddenGems(entry, skip, TMDB_API_KEY);
  if (source === "tmdb-kids") return fetchTmdbKids(entry, skip, TMDB_API_KEY, entry.url.trim().slice("tmdb:kids:".length));
  if (source === "trakt-chart") return fetchTraktChart(entry, skip, traktKey, entry.url.trim().slice("trakt:chart:".length));
  if (source === "simkl-chart") return fetchSimklChart(entry, skip, SIMKL_CLIENT_ID, entry.url.trim().slice("simkl:chart:".length));
  if (source === "channel") return fetchChannelCatalog(entry);
  if (source === "custom-list") return fetchCustomListCatalog(entry);
  if (source === "autotrack") return fetchAutoTrackedCatalog(entry, keys.env);
  if (source === "published-list") return fetchPublishedListCatalog(entry, keys.env);
  return fetchMdblist(entry, skip, mdblistKey);
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

function fetchChannelCatalog(entry) {
  const payload = parseChannelPayload(entry.url);
  if (!payload || !payload.items.length) return [];
  // payload.channelId/payload.name (not entry.id/entry.name) are the real
  // identity here -- when multiple channels are merged into one row (see
  // mergeChannelsIntoRow client-side), each is fetched independently via
  // fetchMergedCatalog with a synthetic { url, type } that has no entry.id
  // or entry.name at all. Falls back to the row's own for channels saved
  // before these fields existed.
  const channelId = payload.channelId || entry.id;
  const name = payload.name || entry.name;
  return [
    {
      id: "channel_" + channelId,
      type: "series",
      name: name,
      poster: payload.poster || undefined,
      // "square" (1:1) cropped the sides off any wide logo (most network
      // logos are much wider than tall) -- "landscape" (16:9) is the
      // widest shape Stremio/wako support, so it crops far less. Not a
      // perfect fit for every logo's exact proportions, but the closest
      // available.
      posterShape: "landscape",
    },
  ];
}

// --- Custom Lists --------------------------------------------------------------
//
// A hand-picked list of movies OR shows (not mixed -- see payload.type),
// built by search-and-pick in the builder. Unlike a (TV) Channel this
// isn't a single synthetic tile -- each pick is returned as its own
// ordinary, independently-typed catalog item, same as any other list here.
// This also used to be split into "Movie Channels" (movies only) with its
// own merge feature; folded into one generic feature since a movie or show
// picked this way was never actually a "channel" in any meaningful sense
// -- there's no synthetic wrapper to give it one, so it's just a list, and
// simpler to treat it as exactly that (including reusing the same merge-
// into-one-shelf mechanism every other list type already has, rather than
// a bespoke one).
function parseCustomListPayload(rawUrl) {
  try {
    const raw = String(rawUrl || "").trim();
    if (!raw.startsWith("customlist:v1:")) return null;
    const data = JSON.parse(raw.slice("customlist:v1:".length));
    if (!data || !Array.isArray(data.items)) return null;
    if (data.type !== "movie" && data.type !== "series") return null;
    return data;
  } catch (e) {
    return null;
  }
}

function fetchCustomListCatalog(entry) {
  const payload = parseCustomListPayload(entry.url);
  if (!payload || !payload.items.length) return [];
  // "Randomize order" reshuffles once a day rather than on every single
  // request -- same reasoning as a Channel's "Randomize play order" (see
  // buildChannelMeta): the order stays put if someone reopens the shelf
  // later the same day, but looks freshly shuffled again tomorrow.
  // payload.listId (not entry.id) is the seed source since this list could
  // be merged with others into one row via the ordinary merge mechanism,
  // where there's no outer entry.id for any individual list to use.
  const items = payload.shuffle
    ? seededShuffle(payload.items, daysSinceEpochUTC(new Date()) + hashStringToInt(payload.listId || entry.id))
    : payload.items;
  return items
    .filter((it) => it && it.imdbId)
    .map((it) => ({
      id: it.imdbId,
      type: payload.type,
      name: it.title,
      poster: it.poster || undefined,
      releaseInfo: it.year || undefined,
    }));
}

async function fetchAutoTrackedCatalog(entry, env) {
  if (!env || !env.CONFIGS) return [];
  
  // url format: autotrack:[slug]:[type]:[username]
  // e.g. autotrack:watch-history:movie:brock25
  const parts = String(entry.url || "").split(":");
  if (parts.length < 4) return [];
  
  const slug = parts[1]; // watch-history or continue-watching
  const targetType = parts[2]; // movie or series
  const username = parts[3];
  
  try {
    const blobStr = await env.CONFIGS.get('creatorsync:' + username);
    if (!blobStr) return [];
    const blob = JSON.parse(blobStr);
    const items = slug === 'watch-history' ? blob.watchHistory : blob.continueWatching;
    if (!items || !items.length) return [];
    
    const mappedItems = [];
    
    items.forEach(it => {
      const isMovie = it.kind === 'movie' || it.type === 'movie';
      
      // Filter out types we don't want in this catalog
      if (targetType === 'movie' && !isMovie) return;
      if (targetType === 'series' && isMovie) return;
      
      const mapped = {
        id: isMovie ? (it.imdbId || it.id) : (it.showId || it.imdbId || it.id),
        type: targetType,
        name: isMovie ? (it.title || it.name) : (it.showTitle || it.title || it.name),
        poster: isMovie ? it.poster : (it.showPoster || it.poster),
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
    .filter((it) => it && it.imdbId)
    .map((it) => ({
      id: it.imdbId,
      type: payload.type,
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
    poster: payload.poster || `${origin}/icon.png`,
    // Same reasoning as fetchChannelCatalog above -- landscape crops far
    // less of a wide logo than square did.
    posterShape: "landscape",
    background: payload.poster || undefined,
    videos,
  };
}

// mdblist's json feeds (public list feed and the REST API) are both either a
// flat array of items, or an object with `movies` / `shows` arrays depending
// on list contents. This normalizes + filters + maps either shape to metas.

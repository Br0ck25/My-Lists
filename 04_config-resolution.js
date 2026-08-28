const SHORT_ID_LENGTH = 12;

async function resolveConfig(configParam, env) {
  if (configParam.length <= SHORT_ID_LENGTH && env && env.CONFIGS) {
    const stored = await env.CONFIGS.get(configParam);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        return {
          entries: Array.isArray(parsed.entries) ? parsed.entries : [],
          tmdbKey: parsed.tmdbKey || "",
          mdblistKey: parsed.mdblistKey || "",
          mdblistAccessToken: parsed.mdblistAccessToken || "",
          traktKey: parsed.traktKey || "",
          traktUsername: parsed.traktUsername || "",
          traktAccessToken: parsed.traktAccessToken || "",
          simklKey: parsed.simklKey || "",
          simklAccessToken: parsed.simklAccessToken || "",
          track: !!parsed.track,
          trackCreatorName: parsed.trackCreatorName || "",
          trackCreatorKey: parsed.trackCreatorKey || "",
          shuffleShelves: !!parsed.shuffleShelves,
          shuffleItems: !!parsed.shuffleItems,
          region: parsed.region || "US",
          hideNonDigitalReleases: !!parsed.hideNonDigitalReleases,
        };
      } catch {
        // fall through to legacy decode below
      }
    }
  }
  return decodeConfig(configParam);
}

// Accepts a full mdblist URL (https://mdblist.com/lists/user/listname[/...])
// or a bare "user/listname" and returns the public JSON feed URL. Pass an
// apikey to also reach a private/personal list you own (mdblist honors the
// key on this endpoint the same way its own site does when you're signed
// in) — public lists work fine with no key.
function mdblistJsonUrl(input, apikey) {
  let s = input.trim();
  s = s.replace(/^https?:\/\/(www\.)?mdblist\.com\/lists\//i, "");
  s = s.replace(/\/(json\/?)?$/i, "");
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  // Normal user lists are /lists/{username}/{slug} (2 segments), but
  // mdblist's own "Official Lists" (mdblist.com/lists/official) are one
  // level deeper -- /lists/official/{movies|shows}/{slug} (3 segments).
  // mdblist's JSON-feed convention is simply "whatever the display page's
  // own path is, plus /json/", so preserving however many segments there
  // are (rather than assuming exactly 2) handles both shapes correctly.
  const encodedPath = parts.map((p) => encodeURIComponent(p)).join("/");
  const base = `https://mdblist.com/lists/${encodedPath}/json/`;
  // append_to_response=poster is documented for mdblist's api.mdblist.com
  // REST endpoint; this add-on actually uses their simpler public JSON feed
  // (this URL), which isn't confirmed to support the same param. Requesting
  // it anyway is a safe bet either way: if unsupported, mdblist just ignores
  // the unknown query param and responds exactly as before (mapMdblistItems
  // below falls back to the metahub poster whenever `poster` isn't present).
  const params = new URLSearchParams({ append_to_response: "poster" });
  if (apikey) params.set("apikey", apikey);
  return `${base}?${params.toString()}`;
}

// --- list-site detection -----------------------------------------------

// Looks at a pasted URL (or the special "mdblist:watchlist" sentinel) and
// figures out which backend should handle it.
// Matches the shareable "/lists/{username}/{listname}" path a published
// Custom List gets, regardless of domain -- this is deliberately domain-
// agnostic (checked structurally, not against a hardcoded hostname) so it
// keeps working whether someone's on the raw *.workers.dev subdomain or a
// custom domain, and so one deployment can resolve a link shared from
// another. Reading this always goes straight to this Worker's OWN KV (see
// fetchPublishedListCatalog) rather than an HTTP fetch of the URL itself.
//
// Critical exception: mdblist.com's own list URLs use this *exact* same
// shape (mdblist.com/lists/{user}/{list}) -- without excluding it here,
// every ordinary mdblist list URL already in use throughout this add-on
// would get misdetected as one of our own published lists and resolved
// against our (empty, for that key) KV instead of mdblist's real data.
function parsePublishedListUrl(rawUrl) {
  const s = String(rawUrl || "").trim();
  if (/^https?:\/\/(www\.)?mdblist\.com\//i.test(s)) return null;
  const m = s.match(/\/lists\/([^/?#]+)\/([^/?#]+)(?:\.json)?\/?(?:[?#].*)?$/i);
  if (!m) return null;
  let username = m[1];
  let listName = m[2];
  try {
    username = decodeURIComponent(username);
    listName = decodeURIComponent(listName);
  } catch {}
  return {
    username: username.toLowerCase(),
    listName: listName.toLowerCase(),
    rawUsername: m[1],
    rawListName: m[2],
  };
}

function parseTmdbWebChartUrl(rawUrl) {
  const s = String(rawUrl || "").trim();
  const m = s.match(/^https?:\/\/(?:www\.)?themoviedb\.org\/(movie|tv|trending)(?:\/([a-z0-9_-]+))?/i);
  if (!m) return null;
  const section = m[1].toLowerCase();
  const sub = (m[2] || "").toLowerCase();
  
  if (section === "movie") {
    if (!sub || sub === "popular") return { chartKey: "popular", type: "movie", name: "TMDB Popular Movies" };
    if (sub === "top-rated" || sub === "top_rated") return { chartKey: "top_rated", type: "movie", name: "TMDB Top Rated Movies" };
    if (sub === "now-playing" || sub === "now_playing") return { chartKey: "now_playing", type: "movie", name: "TMDB Now Playing" };
    if (sub === "upcoming") return { chartKey: "upcoming", type: "movie", name: "TMDB Upcoming Movies" };
  } else if (section === "tv") {
    if (!sub || sub === "popular") return { chartKey: "popular", type: "series", name: "TMDB Popular Shows" };
    if (sub === "top-rated" || sub === "top_rated") return { chartKey: "top_rated", type: "series", name: "TMDB Top Rated Shows" };
    if (sub === "airing-today" || sub === "airing_today") return { chartKey: "now_playing", type: "series", name: "TMDB Airing Today" };
    if (sub === "on-the-air" || sub === "on_the_air") return { chartKey: "upcoming", type: "series", name: "TMDB On The Air" };
  } else if (section === "trending") {
    if (sub === "movie" || sub === "movies") return { chartKey: "trending", type: "movie", name: "TMDB Trending Movies" };
    if (sub === "tv" || sub === "shows") return { chartKey: "trending", type: "series", name: "TMDB Trending Shows" };
    return { chartKey: "trending", type: "movie", name: "TMDB Trending" };
  }
  return null;
}

function detectSource(input) {
  const s = (input || "").trim();
  if (s === "mdblist:watchlist" || s.startsWith("mdblist:watchlist:")) return "mdblist-watchlist";
  if (s === "mdblist:history" || s.startsWith("mdblist:history:") || /^https?:\/\/(www\.)?mdblist\.com\/history\//i.test(s)) return "mdblist-history";
  if (s === "mdblist:airing-next" || s.startsWith("mdblist:airing-next:") || s === "mdblist:user:shows:airing-next") return "mdblist-airing-next";
  if (s === "trakt:watchlist") return "trakt-watchlist";
  if (s === "trakt:history") return "trakt-history";
  if (s === "trakt:airing-next" || s.startsWith("trakt:airing-next:") || s === "trakt:user:shows:airing-next") return "trakt-airing-next";
  if (s.startsWith("tmdb:chart:") || parseTmdbWebChartUrl(s)) return "tmdb-chart";
  if (s.startsWith("tmdb:top10:")) return "tmdb-top10";
  if (s === "tmdb:hidden-gems") return "tmdb-hidden-gems";
  if (s.startsWith("tmdb:kids:")) return "tmdb-kids";
  if (s.startsWith("tmdb:holiday:")) return "tmdb-holiday";
  if (s.startsWith("tmdb:genre:")) return "tmdb-genre";
  if (s.startsWith("trakt:chart:")) return "trakt-chart";
  if (s.startsWith("simkl:chart:")) return "simkl-chart";
  if (s.startsWith("simkl:user:")) return "simkl-user";
  if (s.startsWith("channel:v1:")) return "channel";
  if (s.startsWith("customlist:v1:")) return "custom-list";
  if (s.startsWith("autotrack:") || s === "custom:watch-history" || s === "custom:continue-watching" || s === "custom:watchlist" || s.startsWith("custom:watch-history:") || s.startsWith("custom:continue-watching:")) return "autotrack";
  if (s.startsWith("custom:curated:") || s.startsWith("curated:")) return "curated";
  if (s.startsWith("tmdb:collection:") || /^https?:\/\/(?:www\.)?themoviedb\.org\/collection\//i.test(s)) return "tmdb-collection";
  if (parsePublishedListUrl(s)) return "published-list";
  if (/^https?:\/\/(www\.|app\.)?trakt\.tv\//i.test(s)) return "trakt";
  if (/^https?:\/\/(www\.)?themoviedb\.org\/list\//i.test(s)) return "tmdb";
  return "mdblist"; // default / backwards-compatible with existing configs
}

// Parses a pasted trakt.tv list URL into the { user, list } pair the Trakt
// API needs. Accepts the standard public-list URL shape:
//   https://trakt.tv/users/USERNAME/lists/LIST-SLUG-OR-ID
// (also tolerates a trailing slash or extra path segments like /items).
// `list` can be either the list's slug or its numeric id — Trakt's API
// accepts both interchangeably in this position.
function traktListPath(input) {
  const s = (input || "").trim().replace(/^https?:\/\/(www\.|app\.)?trakt\.tv\//i, "");
  const m = s.match(/^users\/([^/]+)\/lists\/([^/?#]+)/i);
  if (!m) return null;
  return { user: m[1], list: m[2] };
}

// Parses a pasted themoviedb.org list URL into its numeric list id.
// TMDB lists are global (not scoped under a username the way Trakt's are),
// referenced as either https://www.themoviedb.org/list/8290920 or with a
// trailing display slug like .../list/8290920-my-favorites.
function tmdbListId(input) {
  const s = (input || "").trim();
  const m = s.match(/themoviedb\.org\/list\/(\d+)/i);
  return m ? m[1] : null;
}

// Parses a TMDB collection URL or sentinel (e.g. tmdb:collection:86311 or
// https://www.themoviedb.org/collection/86311) into its numeric collection id.
function tmdbCollectionId(input) {
  const s = (input || "").trim();
  if (s.startsWith("tmdb:collection:")) {
    const id = s.slice("tmdb:collection:".length).split(/[^0-9]/)[0];
    return id || null;
  }
  const m = s.match(/themoviedb\.org\/collection\/(\d+)/i);
  return m ? m[1] : null;
}

// --- popular lists (mdblist.com/toplists) -------------------------------

// Pulls mdblist.com's own "Popular Lists" page (https://mdblist.com/toplists/)
// via their REST API and normalizes each entry into something the builder
// page can turn into an entry with one click. Requires an MDBList API key —
// same one used for private lists / the watchlist quick-add.
async function fetchTopLists(apikey, env = null, ctx = null) {
  if (!apikey) {
    throw new Error(
      "Popular Lists isn't configured on this add-on yet — the Worker owner needs to set MDBLIST_POPULAR_KEY."
    );
  }

  const cacheKey = "user_cache:mdblist:toplists";
  const kvKey = "mdblist:toplists";

  return await fetchWithPerUserCacheAndCircuitBreaker({
    cacheKey,
    kvKey,
    env,
    ctx,
    freshTtlSec: 3600,
    staleTtlSec: 86400,
    kvTtlSec: 86400,
    providerLabel: "MDBList Toplists",
    fetchFn: async () => {
      const res = await fetch(
        `https://api.mdblist.com/lists/top?apikey=${encodeURIComponent(apikey)}`,
        {
          headers: { "User-Agent": `my-list-addon/${ADDON_VERSION}` },
          cf: { cacheTtl: 3600, cacheEverything: true },
        }
      );
      if (!res.ok) {
        const hint =
          res.status === 401 || res.status === 403 ? " Double-check your MDBList API key." : "";
        throw new Error(`MDBList top-lists request failed (HTTP ${res.status}).${hint}`);
      }

      const data = await res.json();
      return (Array.isArray(data) ? data : []).map((l) => ({
        name: l.name,
        user: l.user_name,
        slug: l.slug,
        type: l.mediatype === "show" ? "series" : "movie",
        items: l.items,
        likes: l.likes,
        url: `https://mdblist.com/lists/${encodeURIComponent(l.user_name)}/${encodeURIComponent(l.slug)}`,
      }));
    },
  });
}

// Searches trakt.tv's public lists by name via their official search API.
// Only needs the fixed TRAKT_CLIENT_ID (same key used for fetching list
// items) — no user auth required for public list search.
// Peeks at a small sample of a Trakt list's items (unfiltered by type) to
// determine whether it's a movies list, a shows list, or genuinely mixed --
// used so the "Search Lists" results can offer just one relevant Add
// button instead of always defensively offering both. A shallow sample
// (not the whole list) is a deliberate trade-off: correct for the
// overwhelmingly common case of a single-type list, and falls back to
// "unknown" (both buttons, the previous always-safe behavior) for anything
// ambiguous or genuinely mixed.
async function classifyTraktListContentType(user, slug, traktKey, accessToken) {
  const src = `https://api.trakt.tv/users/${encodeURIComponent(user)}/lists/${encodeURIComponent(
    slug
  )}/items?limit=20`;
  try {
    const headers = {
      "Content-Type": "application/json",
      "trakt-api-version": "2",
      "trakt-api-key": traktKey || TRAKT_CLIENT_ID,
      "User-Agent": `my-list-addon/${ADDON_VERSION}`,
    };
    if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
    const res = await fetchTraktWithRetry(src, {
      headers,
      cf: accessToken ? { cacheTtl: 0, cacheEverything: false } : { cacheTtl: 86400, cacheEverything: true },
    });
    if (!res.ok) return "unknown";
    const data = await res.json();
    const items = Array.isArray(data) ? data : [];
    const hasMovie = items.some((it) => it.movie);
    const hasShow = items.some((it) => it.show);
    if (hasMovie && hasShow) return "mixed";
    if (hasMovie) return "movie";
    if (hasShow) return "series";
    return "unknown";
  } catch {
    return "unknown";
  }
}

async function searchTraktLists(query, traktKeyOverride) {
  const q = (query || "").trim();
  if (!q) return [];
  const traktKey = traktKeyOverride || TRAKT_CLIENT_ID;
  if (!traktKey) {
    throw new Error("Trakt lists aren't configured on this add-on yet — the Worker owner needs to set TRAKT_CLIENT_ID.");
  }

  const src = `https://api.trakt.tv/search/list?query=${encodeURIComponent(q)}&limit=20`;
  const res = await fetchTraktWithRetry(src, {
    headers: {
      "Content-Type": "application/json",
      "trakt-api-version": "2",
      "trakt-api-key": traktKey,
      "User-Agent": `my-list-addon/${ADDON_VERSION}`,
    },
    cf: { cacheTtl: 900, cacheEverything: true },
  });
  if (!res.ok) {
    if (res.status === 403) {
      throw new Error(
        traktKeyOverride
          ? "Trakt rejected the Client ID you entered (HTTP 403 = invalid or unapproved app). Double check it against https://trakt.tv/oauth/applications."
          : "Trakt rejected this add-on's API key (HTTP 403 = invalid or unapproved app, per Trakt's own error docs). " +
            "This isn't fixable from a search query -- either the Worker owner needs to check the app behind TRAKT_CLIENT_ID at https://trakt.tv/oauth/applications, or you can enter your own Trakt Client ID in the box above to bypass it."
      );
    }
    if (res.status === 429) {
      throw new Error("Trakt is temporarily busy (rate limit). Please wait a few seconds and try again.");
    }
    throw new Error(`Trakt list search failed (HTTP ${res.status}).`);
  }

  const data = await res.json();
  const lists = (Array.isArray(data) ? data : [])
    .map((r) => r.list)
    .filter((l) => l && l.ids && l.ids.slug && l.user && l.user.ids && l.user.ids.slug)
    .map((l) => {
      const name = l.name || "";
      const isMovie = /\bmovie(s)?\b/i.test(name);
      const isSeries = /\b(show|shows|series|anime|tv|season(s)?)\b/i.test(name);
      const contentType = isMovie && !isSeries ? "movie" : (isSeries && !isMovie ? "series" : "unknown");
      return {
        name: l.name,
        user: l.user.username || l.user.ids.slug,
        slug: l.ids.slug,
        items: l.item_count || 0,
        likes: l.likes || 0,
        contentType,
        url: `https://trakt.tv/users/${encodeURIComponent(l.user.ids.slug)}/lists/${encodeURIComponent(
          l.ids.slug
        )}`,
      };
    });

  return lists;
}

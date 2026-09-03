const SHORT_ID_LENGTH = 12;

async function resolveConfig(configParam, env) {
  if (configParam.length <= SHORT_ID_LENGTH && env && env.CONFIGS) {
    const stored = await env.CONFIGS.get(configParam);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        let watchHistory = Array.isArray(parsed.watchHistory) ? parsed.watchHistory : [];
        let continueWatching = Array.isArray(parsed.continueWatching) ? parsed.continueWatching : [];
        let watchlist = Array.isArray(parsed.watchlist) ? parsed.watchlist : [];
        let airingNext = Array.isArray(parsed.airingNext) ? parsed.airingNext : [];

        let creatorName = parsed.trackCreatorName || parsed.creatorName || "";
        if (!creatorName && Array.isArray(parsed.entries)) {
          for (const e of parsed.entries) {
            if (e && e.url && typeof e.url === 'string' && e.url.startsWith("autotrack:")) {
              const parts = e.url.split(":");
              if (parts.length >= 4 && parts[3]) {
                creatorName = parts[3];
                break;
              }
            }
          }
        }
        if (creatorName && env.CONFIGS) {
          const trackingRaw = await env.CONFIGS.get(`creatorsynctracking:${creatorName}`);
          if (trackingRaw) {
            try {
              const tracking = JSON.parse(trackingRaw);
              if (Array.isArray(tracking.watchHistory) && tracking.watchHistory.length && !watchHistory.length) {
                watchHistory = tracking.watchHistory;
              }
              if (Array.isArray(tracking.continueWatching) && tracking.continueWatching.length && !continueWatching.length) {
                continueWatching = tracking.continueWatching;
              }
              if (Array.isArray(tracking.watchlist) && tracking.watchlist.length && !watchlist.length) {
                watchlist = tracking.watchlist;
              }
              if (Array.isArray(tracking.airingNext) && tracking.airingNext.length && !airingNext.length) {
                airingNext = tracking.airingNext;
              }
            } catch {}
          }
        }

        return {
          entries: Array.isArray(parsed.entries) ? parsed.entries : [],
          watchHistory,
          continueWatching,
          watchlist,
          airingNext,
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
          showBadgesAiringNext: parsed.showBadgesAiringNext !== false,
          showBadgesContinueWatching: parsed.showBadgesContinueWatching !== false,
          showBadgesCatalogs: parsed.showBadgesCatalogs !== false,
          showBadgesStremioAiringNext: parsed.showBadgesStremioAiringNext !== false,
          showBadgesStremioContinueWatching: parsed.showBadgesStremioContinueWatching !== false,
          showBadgesStremioCatalogs: parsed.showBadgesStremioCatalogs !== false,
          showBadgesStremio: parsed.showBadgesStremio !== false,
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
  if (s === "mdblist:watchlist" || s.startsWith("mdblist:watchlist:") || /^https?:\/\/(www\.)?mdblist\.com\/(?:lists\/[^/]+\/)?watchlist\/?/i.test(s)) return "mdblist-watchlist";
  if (s === "mdblist:history" || s.startsWith("mdblist:history:") || /^https?:\/\/(www\.)?mdblist\.com\/(?:lists\/[^/]+\/)?history\/?/i.test(s)) return "mdblist-history";
  if (s === "mdblist:airing-next" || s.startsWith("mdblist:airing-next:") || s === "mdblist:user:shows:airing-next") return "mdblist-airing-next";
  if (s === "trakt:watchlist" || s.startsWith("trakt:watchlist:") || /^https?:\/\/(www\.)?trakt\.tv\/users\/[^/]+\/watchlist\/?$/i.test(s)) return "trakt-watchlist";
  if (s === "trakt:history" || s.startsWith("trakt:history:") || /^https?:\/\/(www\.)?trakt\.tv\/users\/[^/]+\/history\/?$/i.test(s)) return "trakt-history";
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
  const rawQ = (query || "").trim();
  if (!rawQ) return [];
  const q = rawQ.replace(/^@/, "").trim();
  const traktKey = traktKeyOverride || TRAKT_CLIENT_ID;
  if (!traktKey) {
    throw new Error("Trakt lists aren't configured on this add-on yet — the Worker owner needs to set TRAKT_CLIENT_ID.");
  }

  const headers = {
    "Content-Type": "application/json",
    "trakt-api-version": "2",
    "trakt-api-key": traktKey,
    "User-Agent": `my-list-addon/${ADDON_VERSION}`,
  };

  const requests = [
    fetchTraktWithRetry(`https://api.trakt.tv/search/list?query=${encodeURIComponent(q)}&limit=30`, {
      headers,
      cf: { cacheTtl: 900, cacheEverything: true },
    }).then(async (r) => (r.ok ? await r.json() : [])).catch(() => [])
  ];

  // If query looks like a possible username (single token without spaces), also query user lists directly
  const isPossibleUsername = /^[a-zA-Z0-9_-]{2,32}$/.test(q);
  if (isPossibleUsername) {
    requests.push(
      fetchTraktWithRetry(`https://api.trakt.tv/users/${encodeURIComponent(q)}/lists`, {
        headers,
        cf: { cacheTtl: 900, cacheEverything: true },
      }).then(async (r) => {
        if (!r.ok) return [];
        const userLists = await r.json();
        if (!Array.isArray(userLists)) return [];
        return userLists.map((l) => ({ list: { ...l, user: l.user || { ids: { slug: q }, username: q } } }));
      }).catch(() => [])
    );
  }

  const [searchData, userData] = await Promise.all(requests);
  const combinedRaw = [...(Array.isArray(searchData) ? searchData : []), ...(Array.isArray(userData) ? userData : [])];

  const seenUrls = new Set();
  const lists = [];

  for (const r of combinedRaw) {
    const l = r && r.list ? r.list : r;
    if (!l || !l.ids || !l.ids.slug) continue;
    const userSlug = (l.user && l.user.ids && l.user.ids.slug) || (l.user && l.user.username) || (isPossibleUsername ? q : '');
    if (!userSlug) continue;
    const url = `https://trakt.tv/users/${encodeURIComponent(userSlug)}/lists/${encodeURIComponent(l.ids.slug)}`;
    if (seenUrls.has(url.toLowerCase())) continue;
    seenUrls.add(url.toLowerCase());

    const name = l.name || "";
    const isMovie = /\bmovie(s)?\b/i.test(name);
    const isSeries = /\b(show|shows|series|anime|tv|season(s)?)\b/i.test(name);
    const contentType = isMovie && !isSeries ? "movie" : (isSeries && !isMovie ? "series" : "unknown");

    lists.push({
      name: l.name || l.ids.slug,
      user: (l.user && l.user.username) || userSlug,
      slug: l.ids.slug,
      items: l.item_count || 0,
      likes: l.likes || 0,
      contentType,
      url,
      source: "Trakt",
    });
  }

  return lists;
}

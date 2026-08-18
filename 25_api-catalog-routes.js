// --- router ---------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    // Populate the env-backed API key globals declared in 00_constants.js
    // for this request. Every helper function elsewhere in this add-on
    // already references these five by name (TMDB_API_KEY, TRAKT_CLIENT_ID,
    // etc.) -- this is the one place, run first, that actually connects
    // them to whatever this Worker owner configured (or left unset, which
    // is fine: every feature gated on one of these degrades to a clear
    // in-app error message rather than a crash -- see each one's usage for
    // that message). `|| ""` guards against `env` not having the property
    // at all, same as a missing Worker secret/var normally reads as
    // undefined rather than an empty string.
    TMDB_API_KEY = env.TMDB_API_KEY || "5e183700244552be60b9a44cf5d7e7b9";
    TRAKT_CLIENT_ID = env.TRAKT_CLIENT_ID || "";
    SIMKL_CLIENT_ID = env.SIMKL_CLIENT_ID || "b331c5917e9f5b4e2f92fbfdf62de9b62e99c4c6fe743ff281e6c63be159e3b4";
    MDBLIST_API_KEY = env.MDBLIST_API_KEY || "";
    MDBLIST_POPULAR_KEY = env.MDBLIST_POPULAR_KEY || "";
    MDBLIST_CLIENT_ID = env.MDBLIST_CLIENT_ID || "";

    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (path === "/" || path === "") {
      ctx.waitUntil(bumpStat(env, "pageviews"));
      return new Response(renderBuilder(url.origin), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // add-on icon, served straight from this Worker
    if (path === "/icon.png") {
      const bin = atob(ICON_BASE64 );
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Response(bytes, {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400",
          ...corsHeaders(),
        },
      });
    }

    // Poster-shaped placeholder shown in place of a real catalog when a
    // source fails and there's no stale last-known-good data to fall back
    // on (see the catalog route below). Generated on the fly rather than
    // stored as an asset -- it's just text on a flat background.
    if (path === "/unavailable-poster.svg") {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450">
        <rect width="300" height="450" fill="#161a2e"/>
        <rect x="0.5" y="0.5" width="299" height="449" fill="none" stroke="#2a2f4a"/>
        <text x="150" y="205" text-anchor="middle" font-family="sans-serif" font-size="42" fill="#5865a8">\u26a0</text>
        <text x="150" y="250" text-anchor="middle" font-family="sans-serif" font-size="17" fill="#c7cde6">Temporarily</text>
        <text x="150" y="274" text-anchor="middle" font-family="sans-serif" font-size="17" fill="#c7cde6">unavailable</text>
      </svg>`;
      return new Response(svg, {
        headers: {
          "Content-Type": "image/svg+xml",
          "Cache-Control": "public, max-age=86400",
          ...corsHeaders(),
        },
      });
    }

    // /:config/configure  -> opened by wako itself when the user taps
    // "Configure" on the already-installed add-on
    let m = path.match(/^\/([^/]+)\/configure$/);
    if (m) {
      ctx.waitUntil(bumpStat(env, "pageviews"));
      const { entries, tmdbKey, mdblistKey, mdblistAccessToken, traktKey, traktUsername, traktAccessToken, shuffleShelves, shuffleItems } = await resolveConfig(m[1], env);
      return new Response(
        renderBuilder(url.origin, {
          initialEntries: entries,
          initialKeys: { tmdbKey, mdblistKey, mdblistAccessToken, traktKey, traktUsername, traktAccessToken, shuffleShelves, shuffleItems },
          isConfigureMode: true,
        }),
        { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
      );
    }

    // bare /configure (no config yet) -> same builder, empty/default state
    if (path === "/configure") {
      ctx.waitUntil(bumpStat(env, "pageviews"));
      return new Response(
        renderBuilder(url.origin, { isConfigureMode: true }),
        { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
      );
    }

    // /lists/<slug>  (single segment, no second "/") -> a clean, shareable
    // url for one of the native/official charts (see CHART_SLUG_ENTRIES,
    // 08_quickadd-chart-data.js) -- resolves the slug and serves the same
    // builder page, but with that chart pre-opened in the list-details view
    // (see SERVER_DEEP_LINK_LIST, 09_page-shell.js, and
    // handleInitialDeepLink, 24_client-backup-restore-presets.js). This is
    // distinct from /lists/:username/:listname below (always two segments,
    // a person's own published Custom List) -- an unrecognized slug here
    // just lands on the normal default builder page rather than a hard
    // 404, since a stale or mistyped link shouldn't dead-end someone.
    m = path.match(/^\/lists\/curated\/([A-Za-z0-9-]+)$/);
    if (m) {
      ctx.waitUntil(bumpStat(env, "pageviews"));
      const slug = m[1];
      const isShow = slug.includes("show") || slug.includes("tv") || slug.includes("series");
      const title = isShow ? "Recommended Shows" : "Recommended Movies";
      return new Response(
        renderBuilder(url.origin, { deepLinkList: { name: title, type: isShow ? "series" : "movie", url: "custom:curated:" + slug } }),
        { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
      );
    }

    m = path.match(/^\/lists\/([A-Za-z0-9-]+)$/);
    if (m) {
      ctx.waitUntil(bumpStat(env, "pageviews"));
      let chart = resolveChartSlug(m[1]);
      if (!chart) {
        const slugLower = m[1].toLowerCase();
        if (slugLower === "continue-watching" || slugLower === "continue_watching") chart = { name: "Continue Watching", movieUrl: "autotrack:continue-watching", showUrl: "autotrack:continue-watching" };
        if (slugLower === "watch-history" || slugLower === "watch_history") chart = { name: "Watch History", movieUrl: "autotrack:watch-history", showUrl: "autotrack:watch-history" };
        if (slugLower === "watchlist") chart = { name: "Watchlist", movieUrl: "autotrack:watchlist", showUrl: "autotrack:watchlist" };
        if (slugLower === "new-movies") chart = { name: "New Movies", movieUrl: "tmdb:chart:new_movies", showUrl: "tmdb:chart:new_movies" };
        if (slugLower === "new-shows") chart = { name: "New Shows", movieUrl: "tmdb:chart:new_shows", showUrl: "tmdb:chart:new_shows" };
      }
      return new Response(
        renderBuilder(url.origin, chart ? { deepLinkList: { name: chart.name, type: (chart.showUrl && chart.showUrl.includes('shows')) ? "series" : "movie", url: chart.movieUrl } } : {}),
        { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
      );
    }

    // /:config/manifest.json
    m = path.match(/^\/([^/]+)\/manifest\.json$/);
    if (m) {
      // If this looks like a browser page-load (e.g. wako sent you here for
      // "Configure") rather than a JSON fetch by the app, send the user to
      // the actual editable configure page instead of showing raw JSON.
      if (isBrowserNavigation(request)) {
        return Response.redirect(`${url.origin}/${m[1]}/configure`, 302);
      }
      const { entries, track, shuffleShelves } = await resolveConfig(m[1], env);
      return json(buildManifest(entries, url.origin, track, shuffleShelves, m[1]));
    }

    // bare manifest.json with no config
    if (path === "/manifest.json") {
      if (isBrowserNavigation(request)) {
        return Response.redirect(`${url.origin}/configure`, 302);
      }
      return json(buildManifest([], url.origin));
    }

    // /:config/subtitles/:type/:id.json -- see buildManifest's comment
    // above on why wako/Stremio calls this even though the addon has no
    // real subtitles to offer. type is "movie" or "series"; id is a plain
    // "tt1234567" for a movie, or "tt1234567:5:10" (imdbId:season:episode)
    // for an episode -- Stremio's own id convention for TV, nothing
    // specific to this addon. The trailing (?:\/[^/]+)? tolerates the extra
    // videoHash=...&videoSize=...&filename=... path segment real Stremio
    // (as opposed to hand-built test requests) appends before .json when a
    // stream actually has that metadata -- without it, every genuine
    // Stremio playback ping 404'd here and never reached
    // handleSubtitlesTrack below, so Auto-track Playback looked broken
    // specifically on Stremio even though it worked fine against a bare
    // .../subtitles/movie/tt1234567.json test call.
    m = path.match(/^\/([^/]+)\/subtitles\/(movie|series)\/([^/]+?)(?:\/[^/]+)?\.json$/);
    if (m) {
      const [, configParam, stremioType, rawId] = m;
      // Answer immediately with an empty subtitle list regardless of what
      // happens below -- there's nothing to show wako/Stremio either way,
      // and the actual tracking write (a TMDB lookup plus a KV read/write)
      // shouldn't hold up how fast this responds. ctx.waitUntil lets it
      // keep running after the response is already on its way.
      ctx.waitUntil(handleSubtitlesTrack(configParam, stremioType, decodeURIComponent(rawId), env));
      return json({ subtitles: [] });
    }

    if (path === "/app.webmanifest") {
      const manifest = {
        name: "My Lists",
        short_name: "My Lists",
        start_url: "/",
        display: "standalone",
        background_color: "#1C1C1E",
        theme_color: "#007AFF",
        icons: [
          { src: "/icon.png", sizes: "192x192", type: "image/png" },
          { src: "/icon.png", sizes: "512x512", type: "image/png" }
        ]
      };
      return new Response(JSON.stringify(manifest), {
        headers: { "Content-Type": "application/manifest+json; charset=utf-8" }
      });
    }

    if (path === "/sw.js") {
      const sw = `
self.addEventListener('install', e => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  // simple pass-through cache, nothing fancy
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
      `;
      return new Response(sw.trim(), {
        headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache" }
      });
    }

    // /:config/catalog/:type/:id.json  (optionally /:config/catalog/:type/:id/skip=N.json)
    m = path.match(/^\/([^/]+)\/catalog\/([^/]+)\/(.+)\.json$/);
    if (m) {
      const [, config, type, idWithExtra] = m;
      const [id, extraStr] = idWithExtra.split("/");
      const extra = Object.fromEntries(new URLSearchParams(extraStr || ""));
      const skip = parseInt(extra.skip, 10) || 0;

      const { entries, tmdbKey, mdblistKey, mdblistAccessToken, traktKey, traktAccessToken, shuffleItems } = await resolveConfig(config, env);
      const entry = entries.find((e) => e.id === id && e.type === type);
      if (!entry || entry.enabled === false) return json({ metas: [] });

      // Graceful degradation only applies to the first page (skip === 0):
      // that's the case that makes a whole shelf silently vanish from the
      // home screen, whereas a failure deeper into pagination (scrolling
      // for "load more") is far less disruptive to just show as empty, like
      // before. Only active when a CONFIGS KV namespace is bound (optional,
      // same as the short-link feature) -- without one this behaves exactly
      // as it did previously.
      const staleKey = env && env.CONFIGS ? `lastgood:${config}:${type}:${id}` : null;

      try {
        const metas = await fetchCatalog(entry, skip, { tmdbKey, mdblistKey, mdblistAccessToken, traktKey, traktAccessToken, shuffleItems, configParam: config, env, ctx, origin: url.origin });
        if (staleKey && skip === 0 && metas.length > 0) {
          // Fire-and-forget -- the response doesn't wait on this write.
          ctx.waitUntil(
            env.CONFIGS.put(staleKey, JSON.stringify(metas), { expirationTtl: 2592000 })
          );
        }
        return json({ metas });
      } catch (err) {
        const errMsg = String(err.message || err);

        if (skip === 0 && staleKey) {
          try {
            const stale = await env.CONFIGS.get(staleKey);
            if (stale) {
              // Genuine last-known-good data -- real "tt" ids, renders
              // exactly like a normal successful load. `stale` is
              // informational only (visible when debugging via curl), not
              // read by wako/Stremio itself.
              return json({ metas: JSON.parse(stale), stale: true, error: errMsg });
            }
          } catch {
            // KV read/parse failed -- fall through to the placeholder below.
          }
          // No last-known-good data to fall back on (this list has never
          // successfully loaded, or KV isn't bound) -- show one placeholder
          // tile so the row still appears instead of silently disappearing.
          // Uses a dummy "tt"-prefixed id since the manifest declares
          // idPrefixes: ["tt", ...] and some clients filter out anything else.
          return json({
            metas: [
              {
                id: "tt0000000",
                type: entry.type,
                name: (entry.name || "This list") + " \u2014 temporarily unavailable",
                poster: `${url.origin}/unavailable-poster.svg`,
              },
            ],
            error: errMsg,
          });
        }

        // Metas stays empty so wako/Stremio just shows an empty row instead
        // of erroring out, but the reason is still visible if you curl this
        // URL directly while debugging.
        return json({ metas: [], error: errMsg }, 200);
      }
    }

    // /api/track-install  (POST)  { groups?: { [groupName]: count } } -> { ok: true }
    // Fire-and-forget beacon the builder page calls right when "Generate
    // install link"/"Update" produces a link -- that action is otherwise
    // entirely client-side (it's just base64-encoding the current config
    // into a URL, no server round trip), so this is the one place a count
    // of "an install link was generated" can be recorded at all. No
    // identifying info sent or stored, just a counter bump for the
    // admin-only dashboard below. The optional groups breakdown feeds the
    // same dashboard's "sources people actually use" table -- see
    // bumpStatBy/sanitizeStatGroupName above.
    if (path === "/api/track-install" && request.method === "POST") {
      ctx.waitUntil(bumpStat(env, "installs"));
      try {
        const body = await request.json();
        if (body && body.groups && typeof body.groups === "object") {
          const entries = Object.entries(body.groups).slice(0, 30);
          for (const [rawGroup, rawCount] of entries) {
            const group = sanitizeStatGroupName(rawGroup);
            const count = Math.max(0, Math.min(1000, parseInt(rawCount, 10) || 0));
            if (group && count) ctx.waitUntil(bumpStatBy(env, `sourcegroup:${group}`, count));
          }
        }
      } catch {
        // no body, or not JSON -- the plain install counter above still
        // recorded either way, this part is just best-effort extra detail
      }
      return json({ ok: true });
    }

    // /api/preview -> GET with ?url=...&type=movie|series[&tmdbKey=...&mdblistKey=...&sample=N&skip=N],
    // or POST with the same fields as a JSON body. Used by the "Test"
    // button in the builder page to check a list (or the watchlist quick-
    // add), by Live Preview to render a row's actual shelf and its "See
    // All" infinite-scroll view, and by the search results' "View list"
    // button. Always uncached (unlike the shared json() helper's default
    // hour-long cache) since all of those should reflect the current live
    // state, not a stale result from before some earlier fix. sample
    // defaults to 5 (the original/Test-button size); Live Preview and View
    // List ask for more (100, a full catalog page) and page through with
    // skip for infinite scroll -- the same skip fetchCatalog already
    // supports for the real /:config/catalog/:type/:id/skip=N.json route
    // below, reused as-is.
    //
    // POST exists because a Channel's own url can be enormous (hundreds of
    // episodes' worth of embedded JSON) -- passed as a GET query string
    // that routinely exceeded URL length limits and failed outright before
    // ever reaching this handler, which is exactly what surfaced as "no
    // streams"-style network errors previewing a Channel. GET is kept for
    // callers with a normal-sized url (a plain mdblist/trakt/tmdb list
    // link is never going to hit that limit).
    if (path === "/api/preview") {
      let testUrl, type, tmdbKey, mdblistKey, mdblistAccessToken, traktKey, traktAccessToken, sampleSize, skip, creatorName;
      if (request.method === "POST") {
        let reqBody;
        try {
          reqBody = await request.json();
        } catch {
          reqBody = {};
        }
        testUrl = reqBody.url || "";
        type = reqBody.type === "series" ? "series" : "movie";
        tmdbKey = reqBody.tmdbKey || "";
        mdblistKey = reqBody.mdblistKey || "";
        mdblistAccessToken = reqBody.mdblistAccessToken || "";
        traktKey = reqBody.traktKey || "";
        traktAccessToken = reqBody.traktAccessToken || "";
        creatorName = reqBody.creatorName || "";
        sampleSize = Math.max(1, Math.min(PAGE_SIZE, parseInt(reqBody.sample, 10) || 5));
        skip = Math.max(0, parseInt(reqBody.skip, 10) || 0);
      } else {
        testUrl = url.searchParams.get("url") || "";
        type = url.searchParams.get("type") === "series" ? "series" : "movie";
        tmdbKey = url.searchParams.get("tmdbKey") || "";
        mdblistKey = url.searchParams.get("mdblistKey") || "";
        mdblistAccessToken = url.searchParams.get("mdblistAccessToken") || "";
        traktKey = url.searchParams.get("traktKey") || "";
        traktAccessToken = url.searchParams.get("traktAccessToken") || "";
        creatorName = url.searchParams.get("creatorName") || "";
        sampleSize = Math.max(1, Math.min(PAGE_SIZE, parseInt(url.searchParams.get("sample"), 10) || 5));
        skip = Math.max(0, parseInt(url.searchParams.get("skip"), 10) || 0);
      }
      let body;
      try {
        const metas = await fetchCatalog({ url: testUrl, type }, skip, { tmdbKey, mdblistKey, mdblistAccessToken, traktKey, traktAccessToken, creatorName, env, ctx });
        body = {
          ok: true,
          count: metas.length,
          maybeMore: metas.length >= PAGE_SIZE,
          // id+poster (not just name) so the builder can show small poster
          // thumbnails as a more satisfying "yes, this is the right list"
          // confirmation than a plain name list. posterShape carries a
          // Channel's "landscape" hint through too -- without it, Live
          // Preview/View List had no way to know a logo shouldn't be forced
          // into the same portrait 2:3 box every other poster uses, and
          // cropped it down to almost nothing. season/episode (only ever
          // present on Trakt history's per-episode rows -- see
          // mapTraktHistoryItems) let "Mark as Watched" on the live Trakt
          // Connect panel look up each episode's real TMDB id without
          // parsing them back out of the folded "Show S1E5" display name.
          sample: metas.slice(0, sampleSize).map((m) => ({ id: m.id, type: type, name: m.name, poster: m.poster, year: m.releaseInfo, showTitle: m.showTitle, posterShape: m.posterShape, season: m.season, episode: m.episode })),
        };
      } catch (err) {
        body = { ok: false, error: String(err.message || err) };
      }
      return new Response(JSON.stringify(body), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          ...corsHeaders(),
        },
      });
    }

    // /:config/meta/:type/:id.json (or /meta/:type/:id.json)
    // Resolves metadata for Channels (channel_*) and standard IMDb titles (tt*).
    // Provides full metadata (posters, backgrounds, overviews, ratings, cast, and
    // full episode lists) so clients without dedicated metadata addons (like Nuvio)
    // automatically render complete detail and playback pages.
    m = path.match(/^(?:\/([^/]+))?\/meta\/([^/]+)\/(.+)\.json$/);
    if (m) {
      const [, config, metaType, idRaw] = m;
      const id = decodeURIComponent(idRaw);

      // 1. Synthetic meta for Channels
      if (id.startsWith("channel_")) {
        if (metaType !== "series") return json({ meta: null });
        const wantedChannelId = id.slice("channel_".length);
        try {
          const { entries } = await resolveConfig(config, env);
          let matchedEntry = null;
          for (const e of entries) {
            if (e.enabled === false) continue;
            const subUrls = String(e.url || "").split("\n").map((s) => s.trim()).filter(Boolean);
            for (const subUrl of subUrls) {
              const payload = parseChannelPayload(subUrl);
              if (!payload) continue;
              if ((payload.channelId || e.id) === wantedChannelId) {
                matchedEntry = { ...e, url: subUrl };
                break;
              }
            }
            if (matchedEntry) break;
          }
          if (!matchedEntry) return json({ meta: null });
          const meta = buildChannelMeta(matchedEntry, url.origin);
          return json({ meta: meta || null });
        } catch (err) {
          return json({ meta: null, error: String(err.message || err) });
        }
      }

      // 2. Standard title metadata for IMDb ids ("tt...") or TMDB ids ("tmdb:...")
      if (id.startsWith("tt") || id.startsWith("tmdb:")) {
        try {
          const { tmdbKey } = config ? await resolveConfig(config, env) : { tmdbKey: null };
          const effectiveKey = tmdbKey || TMDB_API_KEY;
          const meta = await fetchStandardItemMeta(id, metaType, effectiveKey);
          if (!meta) return json({ meta: null });
          return json(
            { meta },
            200,
            { "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800" }
          );
        } catch (err) {
          return json({ meta: null, error: String(err.message || err) });
        }
      }

      return json({ meta: null });
    }

    // /api/channel-logo?path=...
    // Generates a self-contained 16:9 landscape channel poster with the network
    // logo scaled down by 50% and centered on a sleek dark canvas. Uses embedded base64
    // so it renders reliably across Stremio, Nuvio, wako, and web clients without CORS issues.
    if (path === "/api/channel-logo") {
      const logoPath = url.searchParams.get("path");
      if (!logoPath) return new Response("Missing path", { status: 400 });
      try {
        const tmdbUrl = `https://image.tmdb.org/t/p/w500${logoPath.startsWith("/") ? logoPath : "/" + logoPath}`;
        const tmdbRes = await fetch(tmdbUrl, {
          headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
          cf: { cacheTtl: 604800, cacheEverything: true },
        });
        if (!tmdbRes.ok) return new Response("Image not found", { status: 404 });
        const arrayBuffer = await tmdbRes.arrayBuffer();
        const contentType = tmdbRes.headers.get("content-type") || "image/png";
        const bytes = new Uint8Array(arrayBuffer);
        let binary = "";
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);
        const dataUri = `data:${contentType};base64,${base64}`;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="338" viewBox="0 0 600 338">
  <rect width="100%" height="100%" fill="#12151f"/>
  <image x="150" y="84.5" width="300" height="169" preserveAspectRatio="xMidYMid meet" href="${dataUri}"/>
</svg>`;
        return new Response(svg, {
          headers: {
            "Content-Type": "image/svg+xml",
            "Cache-Control": "public, max-age=604800, immutable",
            ...corsHeaders(),
          },
        });
      } catch (err) {
        return new Response("Error generating logo", { status: 500 });
      }
    }

    // /api/toplists
    // -> powers the "Popular Lists" browser in the builder page. Proxies
    // mdblist.com's own top-lists endpoint so people can add lists from
    // https://mdblist.com/toplists/ with a click instead of copy-pasting URLs.
    // Uses the fixed MDBLIST_POPULAR_KEY (see top of file) — no per-user key
    // needed for this, since it's the same public data for everyone.
    if (path === "/api/toplists") {
      try {
        // Always the shared key here -- no per-user override exists for
        // this endpoint (see the comment above).
        ctx.waitUntil(bumpStat(env, "apiuse:mdblistpopular"));
        const lists = await fetchTopLists(MDBLIST_POPULAR_KEY);
        return json({ ok: true, lists });
      } catch (err) {
        return json({ ok: false, error: String(err.message || err) });
      }
    }

      // /api/season (GET) -> { ok: true, season: { episodes: [...] } }
      if (path === "/api/season") {
        const q = url.searchParams;
        const imdbId = q.get("imdbId");
        const seasonNum = q.get("seasonNum");
        const tmdbKeyParam = q.get("tmdbKey") || "";
        const tmdbKey = tmdbKeyParam || TMDB_API_KEY;
        if (!tmdbKeyParam) ctx.waitUntil(bumpStat(env, "apiuse:tmdb"));
        // Optional -- when the caller already resolved this show's tmdbId
        // (e.g. from the same /api/details response that gave it
        // imdbId/seasonsData in the first place), passing it straight
        // through skips a redundant imdbId -> tmdbId /find lookup here.
        // Matters most when several seasons of the same show are being
        // fetched concurrently (see markShowWatched's own comment): without
        // this, each one redundantly re-resolves the same show, and those
        // concurrent /find calls racing to fill a cold cache entry for a
        // show TMDB hasn't been asked about yet can come back empty under
        // that burst, silently dropping that season's episodes.
        const knownTmdbId = q.get("tmdbId") || null;
        
        if (!imdbId || !seasonNum) return json({ ok: false, error: "Missing imdbId or seasonNum" }, 400);
        
        const seasonData = await fetchTmdbSeasonDetails(imdbId, seasonNum, tmdbKey, knownTmdbId);
        if (!seasonData) return json({ ok: false, error: "Not found or TMDB error" }, 404);
        
        // A short max-age (not json()'s 3600s default) -- this response's
        // shape has changed before (the tmdbId passthrough above is a
        // recent example) and a stale hour-old browser cache of the old
        // shape is exactly the kind of thing that looks like "the fix
        // didn't work" for anyone re-testing a show/season they'd already
        // opened recently. The actual TMDB calls are still cached for a
        // full week at Cloudflare's edge (see fetchTmdbSeasonDetails's own
        // cf.cacheTtl) regardless of this -- this only governs how long
        // the browser reuses its own copy of this specific JSON reply.
        return json({ ok: true, season: seasonData }, 200, { "Cache-Control": "max-age=60" });
      }

    // /api/title-search?q=...&type=movie|tv
    // -> powers the "Search a show/movie" box in the Channel builder.
    // Straight TMDB title search, trimmed to what the picker UI needs.
    if (path === "/api/title-search") {
      const q = (url.searchParams.get("q") || "").trim();
      const kind = url.searchParams.get("type") === "movie" ? "movie" : "tv";
      if (!q) return json({ ok: false, error: "Missing search query." }, 400);
      try {
        // Always the shared key -- no per-user override for this endpoint.
        ctx.waitUntil(bumpStat(env, "apiuse:tmdb"));
        if (env && env.CONFIGS && typeof recordSearchQuery === "function") {
          ctx.waitUntil(recordSearchQuery(env, q));
        }
        const src = `https://api.themoviedb.org/3/search/${kind}?api_key=${encodeURIComponent(
          TMDB_API_KEY
        )}&query=${encodeURIComponent(q)}&include_adult=false`;
        const res = await fetch(src, {
          headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
          cf: { cacheTtl: 3600, cacheEverything: true },
        });
        if (!res.ok) return json({ ok: false, error: `TMDB search failed (HTTP ${res.status}).` });
        const data = await res.json();
        const results = (data.results || []).slice(0, 20).map((it) => ({
          tmdbId: it.id,
          title: it.title || it.name,
          year: (it.release_date || it.first_air_date || "").slice(0, 4),
          poster: it.poster_path ? `https://image.tmdb.org/t/p/w200${it.poster_path}` : null,
          type: kind,
        }));
        return json({ ok: true, results });
      } catch (err) {
        return json({ ok: false, error: String(err.message || err) });
      }
    }

    // /api/show-seasons?tmdbId=...
    // -> once a show is picked in the Channel builder, lists its seasons so
    // the person can drill into one. Also resolves the show's IMDB id up
    // front (reusing fetchTmdbDetails -- same combined external_ids+videos
    // call every other TMDB path here already makes) since every episode
    // picked from this show will need it to build a resolvable stream id.
    if (path === "/api/show-seasons") {
      const tmdbId = url.searchParams.get("tmdbId") || "";
      if (!tmdbId) return json({ ok: false, error: "Missing tmdbId." }, 400);
      try {
        // Always the shared key -- 2 outbound TMDB calls per request.
        ctx.waitUntil(bumpStatBy(env, "apiuse:tmdb", 2));
        const [details, showRes] = await Promise.all([
          fetchTmdbDetails(tmdbId, "tv", TMDB_API_KEY),
          fetch(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${encodeURIComponent(TMDB_API_KEY)}`, {
            headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
            cf: { cacheTtl: 3600, cacheEverything: true },
          }),
        ]);
        if (!details.imdbId) {
          return json({ ok: false, error: "Couldn't resolve an IMDB id for this show, so streams likely won't work for any episode picked from it." });
        }
        if (!showRes.ok) return json({ ok: false, error: `TMDB show lookup failed (HTTP ${showRes.status}).` });
        const data = await showRes.json();
        const seasons = (data.seasons || [])
          .filter((s) => s.season_number > 0) // skip "Specials" (season 0)
          .map((s) => ({ season: s.season_number, name: s.name, episodeCount: s.episode_count }));
        return json({
          ok: true,
          imdbId: details.imdbId,
          name: data.name,
          poster: data.poster_path ? `https://image.tmdb.org/t/p/w300${data.poster_path}` : null,
          seasons,
        });
      } catch (err) {
        return json({ ok: false, error: String(err.message || err) });
      }
    }

    // /api/show-episodes?tmdbId=...&season=...
    // -> the actual episode checklist for one season, once picked in the
    // Channel builder.
    if (path === "/api/show-episodes") {
      const tmdbId = url.searchParams.get("tmdbId") || "";
      const season = url.searchParams.get("season") || "";
      if (!tmdbId || !season) return json({ ok: false, error: "Missing tmdbId or season." }, 400);
      try {
        // Always the shared key.
        ctx.waitUntil(bumpStat(env, "apiuse:tmdb"));
        const src = `https://api.themoviedb.org/3/tv/${tmdbId}/season/${encodeURIComponent(
          season
        )}?api_key=${encodeURIComponent(TMDB_API_KEY)}`;
        const res = await fetch(src, {
          headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
          cf: { cacheTtl: 3600, cacheEverything: true },
        });
        if (!res.ok) return json({ ok: false, error: `TMDB season lookup failed (HTTP ${res.status}).` });
        const data = await res.json();
        const episodes = (data.episodes || []).map((e) => ({
          episode: e.episode_number,
          name: e.name,
          released: e.air_date || null,
          thumbnail: e.still_path ? `https://image.tmdb.org/t/p/w300${e.still_path}` : null,
        }));
        return json({ ok: true, episodes });
      } catch (err) {
        return json({ ok: false, error: String(err.message || err) });
      }
    }

    // /api/quick-channel-shows?url=<any supported list url>  OR  ?networkId=<TMDB network id>
    // -> powers the Channels panel's "Quick Add Channel" buttons (CBS, NBC,
    // ABC, FOX, The CW, HBO, etc.) and "Import from link": resolves a source
    // of shows to TMDB ids, so the client can then loop them through the
    // same /api/show-seasons + /api/show-episodes endpoints the manual
    // picker already uses. Deliberately split from that per-show/per-season
    // fetching (rather than one giant server-side request that builds the
    // whole channel) -- a full network lineup could mean dozens of shows
    // and hundreds of TMDB calls, comfortably over what a single Worker
    // request should be doing; spreading that across many small
    // client-driven requests keeps each one fast and avoids leaning on
    // Cloudflare's per-request subrequest ceiling.
    //
    // Three sources feed this: any mdblist.com/trakt.tv/themoviedb.org list
    // link (someone else's hand-picked lineup, or "Import from link"'s own
    // pasted URL), a TMDB network id directly (TMDB's own current/popular
    // shows for that network, e.g. FOX/The CW/HBO -- doesn't depend on any
    // third party's list existing or staying maintained), or -- implicitly,
    // via the url branch -- a mixed movies+shows list, since requesting
    // type "series" from the generic catalog fetch below silently drops any
    // movies rather than erroring out (Channels are shows-only).
    if (path === "/api/quick-channel-shows") {
      const listUrl = url.searchParams.get("url") || "";
      const networkId = url.searchParams.get("networkId") || "";
      const mdblistKey = url.searchParams.get("mdblistKey") || "";
      const traktKey = url.searchParams.get("traktKey") || "";
      const traktAccessToken = url.searchParams.get("traktAccessToken") || "";
      if (!listUrl && !networkId) return json({ ok: false, error: "Missing url or networkId." }, 400);
      try {
        let showRefs; // [{ id: <imdb id>, name, poster }]
        if (networkId) {
          const discoverResults = [];
          // Up to 10 pages (200 shows) -- a much bigger candidate pool to
          // shuffle from than before, but safe to raise: CHANNEL_MAX_TOTAL_ITEMS
          // below already bounds how much actually gets processed regardless
          // of pool size, and this loop still stops early via total_pages
          // for any network with genuinely fewer than 10 pages of results.
          let discoverPagesFetched = 0;
          for (let page = 1; page <= 10; page++) {
            discoverPagesFetched++;
            const discoverRes = await fetch(
              `https://api.themoviedb.org/3/discover/tv?api_key=${encodeURIComponent(TMDB_API_KEY)}` +
                `&with_networks=${encodeURIComponent(networkId)}&sort_by=popularity.desc&page=${page}&include_adult=false`,
              { headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` }, cf: { cacheTtl: 3600, cacheEverything: true } }
            );
            if (!discoverRes.ok) break;
            const discoverData = await discoverRes.json();
            discoverResults.push(...(discoverData.results || []));
            if (page >= (discoverData.total_pages || 1)) break;
          }
          if (!discoverResults.length) return json({ ok: false, error: "No shows found for that network." });
          // The network's own logo (e.g. the CBS eye) -- a much more
          // fitting default poster for a channel built to represent that
          // whole network than an arbitrary single show's poster, which is
          // what this fell back to before. Best-effort: if TMDB doesn't
          // have a logo for this network id, the client already has its
          // own fallback (the first show's poster) for that case.
          let networkLogo = null;
          try {
            const networkRes = await fetch(
              `https://api.themoviedb.org/3/network/${encodeURIComponent(networkId)}?api_key=${encodeURIComponent(TMDB_API_KEY)}`,
              { headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` }, cf: { cacheTtl: 604800, cacheEverything: true } }
            );
            if (networkRes.ok) {
              const networkData = await networkRes.json();
              // A specific size (not "original") is required here --
              // TMDB serves the network's raw uploaded logo file at
              // "original", which for many networks is an .svg, and
              // Stremio/wako can't render an SVG as a poster (this was the
              // actual cause of the logo silently never showing and
              // falling back to a show's poster instead). Any fixed pixel
              // size forces TMDB to rasterize it to PNG first.
              if (networkData.logo_path) networkLogo = `${url.origin}/api/channel-logo?path=${encodeURIComponent(networkData.logo_path)}`;
            }
          } catch {
            // best-effort -- fall through with networkLogo left null
          }
          const shows = await mapWithConcurrency(discoverResults, 8, async (show) => {
            const details = await fetchTmdbDetails(show.id, "tv", TMDB_API_KEY);
            if (!details.imdbId) return null;
            return {
              imdbId: details.imdbId,
              tmdbId: show.id,
              name: show.name,
              poster: show.poster_path ? `https://image.tmdb.org/t/p/w300${show.poster_path}` : null,
            };
          });
          // Always the shared key -- the discover page loop
          // (discoverPagesFetched), the network logo lookup (1), and one
          // fetchTmdbDetails call per discovered show all landed above.
          ctx.waitUntil(bumpStatBy(env, "apiuse:tmdb", discoverPagesFetched + 1 + discoverResults.length));
          const resolved = shows.filter(Boolean);
          if (!resolved.length) return json({ ok: false, error: "Couldn't resolve any shows for that network to IMDB." });
          return json({ ok: true, shows: resolved, networkLogo });
        }

        // A pasted list link can be any of this add-on's supported sources
        // (mdblist/trakt/tmdb) and can be mixed movies+shows -- requesting
        // type "series" specifically both narrows to just the shows
        // (silently dropping any movies in the same list) and reuses the
        // exact same fetchCatalog dispatch every other list source already
        // goes through, instead of this route only ever understanding
        // mdblist's own JSON shape like it used to.
        let metas;
        try {
          metas = await fetchCatalog({ url: listUrl, type: "series" }, 0, { mdblistKey, traktKey, traktAccessToken, env, ctx, origin: url.origin });
        } catch (err) {
          return json({ ok: false, error: `Could not read that list: ${err.message || err}` });
        }
        if (!metas.length) {
          return json({ ok: false, error: "That list has no shows in it (Channels are shows-only -- any movies are skipped)." });
        }

        const shows = await mapWithConcurrency(metas, 8, async (m) => {
          try {
            const findRes = await fetch(
              `https://api.themoviedb.org/3/find/${m.id}?api_key=${encodeURIComponent(TMDB_API_KEY)}&external_source=imdb_id`,
              { headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` }, cf: { cacheTtl: 604800, cacheEverything: true } }
            );
            if (!findRes.ok) return null;
            const findData = await findRes.json();
            const match = (findData.tv_results || [])[0];
            if (!match) return null;
            return { imdbId: m.id, tmdbId: match.id, name: m.name, poster: m.poster };
          } catch {
            return null;
          }
        });
        // Always the shared key -- one TMDB find call per item in the list.
        ctx.waitUntil(bumpStatBy(env, "apiuse:tmdb", metas.length));
        const resolved = shows.filter(Boolean);
        if (!resolved.length) return json({ ok: false, error: "Couldn't resolve any shows in that list to TMDB." });
        return json({ ok: true, shows: resolved });
      } catch (err) {
        return json({ ok: false, error: String(err.message || err) });
      }
    }

    // /api/resolve-movie?tmdbId=...
    // -> resolves a movie's IMDB id when it's added to a Custom List.
    if (path === "/api/resolve-movie") {
      const tmdbId = url.searchParams.get("tmdbId") || "";
      if (!tmdbId) return json({ ok: false, error: "Missing tmdbId." }, 400);
      try {
        ctx.waitUntil(bumpStat(env, "apiuse:tmdb"));
        const details = await fetchTmdbDetails(tmdbId, "movie", TMDB_API_KEY);
        if (!details.imdbId) return json({ ok: false, error: "Couldn't resolve an IMDB id for this movie." });
        return json({ ok: true, imdbId: details.imdbId });
      } catch (err) {
        return json({ ok: false, error: String(err.message || err) });
      }
    }

    // /api/resolve-show?tmdbId=...
    // -> resolves a show's IMDB id when it's added to a Custom List (a
    // whole-show pick, not per-episode -- that's the Channels panel).
    if (path === "/api/resolve-show") {
      const tmdbId = url.searchParams.get("tmdbId") || "";
      if (!tmdbId) return json({ ok: false, error: "Missing tmdbId." }, 400);
      try {
        ctx.waitUntil(bumpStat(env, "apiuse:tmdb"));
        const details = await fetchTmdbDetails(tmdbId, "tv", TMDB_API_KEY);
        if (!details.imdbId) return json({ ok: false, error: "Couldn't resolve an IMDB id for this show." });
        return json({ ok: true, imdbId: details.imdbId });
      } catch (err) {
        return json({ ok: false, error: String(err.message || err) });
      }
    }

    // /api/recommendations  (POST)  { movieIds: [...], showIds: [...] } -> { ok, movies: [...], shows: [...] }
    // Generates personalized movie and show recommendations from TMDB based on user watch history.
    if (path === "/api/recommendations" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const movieIds = Array.isArray(body.movieIds) ? body.movieIds.slice(0, 12) : [];
      const showIds = Array.isArray(body.showIds) ? body.showIds.slice(0, 12) : [];
      const tmdbKey = body.tmdbKey || TMDB_API_KEY;

      const [movieLists, showLists] = await Promise.all([
        Promise.all(movieIds.map(async (rawId) => {
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
              if (findData.movie_results && findData.movie_results[0]) {
                tmdbId = findData.movie_results[0].id;
              }
            }
            if (!tmdbId) return [];
            const recRes = await fetch(`https://api.themoviedb.org/3/movie/${encodeURIComponent(tmdbId)}/recommendations?api_key=${encodeURIComponent(tmdbKey)}&page=1`, {
              cf: { cacheTtl: 86400, cacheEverything: true }
            });
            const recData = await recRes.json();
            let list = recData.results || [];
            if (!list.length) {
              const simRes = await fetch(`https://api.themoviedb.org/3/movie/${encodeURIComponent(tmdbId)}/similar?api_key=${encodeURIComponent(tmdbKey)}&page=1`, {
                cf: { cacheTtl: 86400, cacheEverything: true }
              });
              const simData = await simRes.json();
              list = simData.results || [];
            }
            return list;
          } catch {
            return [];
          }
        })),
        Promise.all(showIds.map(async (rawId) => {
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
              if (findData.tv_results && findData.tv_results[0]) {
                tmdbId = findData.tv_results[0].id;
              }
            }
            if (!tmdbId) return [];
            const recRes = await fetch(`https://api.themoviedb.org/3/tv/${encodeURIComponent(tmdbId)}/recommendations?api_key=${encodeURIComponent(tmdbKey)}&page=1`, {
              cf: { cacheTtl: 86400, cacheEverything: true }
            });
            const recData = await recRes.json();
            let list = recData.results || [];
            if (!list.length) {
              const simRes = await fetch(`https://api.themoviedb.org/3/tv/${encodeURIComponent(tmdbId)}/similar?api_key=${encodeURIComponent(tmdbKey)}&page=1`, {
                cf: { cacheTtl: 86400, cacheEverything: true }
              });
              const simData = await simRes.json();
              list = simData.results || [];
            }
            return list;
          } catch {
            return [];
          }
        }))
      ]);

      const seenMovieIds = new Set();
      const recMovies = [];
      for (const list of movieLists) {
        for (const m of list) {
          if (m && m.id && !seenMovieIds.has(m.id) && m.poster_path) {
            seenMovieIds.add(m.id);
            recMovies.push({
              id: "tmdb:" + m.id,
              name: m.title || "Movie",
              poster: "https://image.tmdb.org/t/p/w500" + m.poster_path,
              year: (m.release_date || "").slice(0, 4),
              type: "movie",
              rating: m.vote_average ? m.vote_average.toFixed(1) : null
            });
          }
        }
      }

      if (recMovies.length < 10) {
        try {
          const popRes = await fetch(`https://api.themoviedb.org/3/trending/movie/week?api_key=${encodeURIComponent(tmdbKey)}`, {
            cf: { cacheTtl: 86400, cacheEverything: true }
          });
          const popData = await popRes.json();
          for (const m of (popData.results || [])) {
            if (m && m.id && !seenMovieIds.has(m.id) && m.poster_path) {
              seenMovieIds.add(m.id);
              recMovies.push({
                id: "tmdb:" + m.id,
                name: m.title || "Movie",
                poster: "https://image.tmdb.org/t/p/w500" + m.poster_path,
                year: (m.release_date || "").slice(0, 4),
                type: "movie",
                rating: m.vote_average ? m.vote_average.toFixed(1) : null
              });
            }
          }
        } catch {}
      }

      const seenShowIds = new Set();
      const recShows = [];
      for (const list of showLists) {
        for (const s of list) {
          if (s && s.id && !seenShowIds.has(s.id) && s.poster_path) {
            seenShowIds.add(s.id);
            recShows.push({
              id: "tmdb:" + s.id,
              name: s.name || "Show",
              poster: "https://image.tmdb.org/t/p/w500" + s.poster_path,
              year: (s.first_air_date || "").slice(0, 4),
              type: "series",
              rating: s.vote_average ? s.vote_average.toFixed(1) : null
            });
          }
        }
      }

      if (recShows.length < 10) {
        try {
          const popRes = await fetch(`https://api.themoviedb.org/3/trending/tv/week?api_key=${encodeURIComponent(tmdbKey)}`, {
            cf: { cacheTtl: 86400, cacheEverything: true }
          });
          const popData = await popRes.json();
          for (const s of (popData.results || [])) {
            if (s && s.id && !seenShowIds.has(s.id) && s.poster_path) {
              seenShowIds.add(s.id);
              recShows.push({
                id: "tmdb:" + s.id,
                name: s.name || "Show",
                poster: "https://image.tmdb.org/t/p/w500" + s.poster_path,
                year: (s.first_air_date || "").slice(0, 4),
                type: "series",
                rating: s.vote_average ? s.vote_average.toFixed(1) : null
              });
            }
          }
        } catch {}
      }

      return json({ ok: true, movies: recMovies.slice(0, 40), shows: recShows.slice(0, 40) });
    }

    // /api/tmdb-search-lists?q=...[&tmdbKey=...]
    // -> searches TMDB for Franchise Collections (e.g. Marvel, Harry Potter, Star Wars)
    // and matching TMDB Official Charts (Popular, Top Rated, Streaming Channels, etc.)
    if (path === "/api/tmdb-search-lists") {
      const q = (url.searchParams.get("q") || "").trim();
      const tmdbKeyParam = url.searchParams.get("tmdbKey") || "";
      const tmdbKey = tmdbKeyParam || TMDB_API_KEY;
      if (!q || !tmdbKey) {
        return json({ ok: true, lists: [] });
      }
      try {
        if (!tmdbKeyParam) ctx.waitUntil(bumpStat(env, "apiuse:tmdb"));
        const qLower = q.toLowerCase();
        const results = [];

        // 1. Search TMDB Collections
        const collRes = await fetch(
          `https://api.themoviedb.org/3/search/collection?api_key=${encodeURIComponent(tmdbKey)}&query=${encodeURIComponent(q)}`,
          {
            headers: { "User-Agent": "my-list-addon/1.14" },
            cf: { cacheTtl: 86400, cacheEverything: true },
          }
        );

        if (collRes.ok) {
          const collData = await collRes.json();
          const collections = Array.isArray(collData.results) ? collData.results : [];
          for (const c of collections.slice(0, 15)) {
            if (!c || !c.id) continue;
            results.push({
              name: c.name || "Unnamed Collection",
              user: "TMDB Franchise",
              url: `https://www.themoviedb.org/collection/${c.id}`,
              type: "movie",
              items: "Franchise",
              poster: c.poster_path ? `https://image.tmdb.org/t/p/w500${c.poster_path}` : undefined,
              likes: 0,
              isCollection: true,
            });
          }
        }

        // 2. Check TMDB Official Charts matching query
        const builtinTmdbCharts = [
          { name: "TMDB Trending Movies", url: "tmdb:chart:trending", type: "movie", tags: ["trending", "popular", "top", "tmdb"] },
          { name: "TMDB Trending Shows", url: "tmdb:chart:trending", type: "series", tags: ["trending", "popular", "top", "tv", "shows", "tmdb"] },
          { name: "TMDB Popular Movies", url: "tmdb:chart:popular", type: "movie", tags: ["popular", "top", "movies", "tmdb"] },
          { name: "TMDB Popular Shows", url: "tmdb:chart:popular", type: "series", tags: ["popular", "top", "shows", "tv", "tmdb"] },
          { name: "TMDB Top Rated Movies", url: "tmdb:chart:top_rated", type: "movie", tags: ["top rated", "best", "movies", "tmdb"] },
          { name: "TMDB Top Rated Shows", url: "tmdb:chart:top_rated", type: "series", tags: ["top rated", "best", "shows", "tv", "tmdb"] },
          { name: "TMDB Now Playing", url: "tmdb:chart:now_playing", type: "movie", tags: ["now playing", "theater", "cinema", "new", "tmdb"] },
          { name: "TMDB Upcoming Movies", url: "tmdb:chart:upcoming", type: "movie", tags: ["upcoming", "coming soon", "future", "tmdb"] },
          { name: "Netflix Movies", url: "tmdb:chart:netflix", type: "movie", tags: ["netflix", "streaming"] },
          { name: "Netflix Shows", url: "tmdb:chart:netflix", type: "series", tags: ["netflix", "streaming", "shows"] },
          { name: "Apple TV+ Movies", url: "tmdb:chart:appletv", type: "movie", tags: ["apple", "apple tv", "streaming"] },
          { name: "Apple TV+ Shows", url: "tmdb:chart:appletv", type: "series", tags: ["apple", "apple tv", "streaming", "shows"] },
          { name: "Disney+ Movies", url: "tmdb:chart:disney", type: "movie", tags: ["disney", "disney plus", "streaming", "marvel", "star wars"] },
          { name: "Disney+ Shows", url: "tmdb:chart:disney", type: "series", tags: ["disney", "disney plus", "streaming", "shows"] },
          { name: "HBO Max Movies", url: "tmdb:chart:hbomax", type: "movie", tags: ["hbo", "hbo max", "max", "warner"] },
          { name: "HBO Max Shows", url: "tmdb:chart:hbomax", type: "series", tags: ["hbo", "hbo max", "max", "warner", "shows"] },
          { name: "Hulu Movies", url: "tmdb:chart:hulu", type: "movie", tags: ["hulu", "streaming"] },
          { name: "Hulu Shows", url: "tmdb:chart:hulu", type: "series", tags: ["hulu", "streaming", "shows"] },
          { name: "Prime Video Movies", url: "tmdb:chart:primevideo", type: "movie", tags: ["amazon", "prime", "prime video"] },
          { name: "Prime Video Shows", url: "tmdb:chart:primevideo", type: "series", tags: ["amazon", "prime", "prime video", "shows"] },
          { name: "Paramount+ Movies", url: "tmdb:chart:paramount", type: "movie", tags: ["paramount", "paramount plus"] },
          { name: "Paramount+ Shows", url: "tmdb:chart:paramount", type: "series", tags: ["paramount", "paramount plus", "shows"] },
          { name: "Peacock Movies", url: "tmdb:chart:peacock", type: "movie", tags: ["peacock", "nbc"] },
          { name: "Peacock Shows", url: "tmdb:chart:peacock", type: "series", tags: ["peacock", "nbc", "shows"] },
          { name: "Hidden Gems", url: "tmdb:hidden-gems", type: "movie", tags: ["hidden gems", "underrated", "gems", "cult"] },
          { name: "Kids Movies", url: "tmdb:kids:movie", type: "movie", tags: ["kids", "children", "family", "animation", "disney"] },
          { name: "Kids Shows", url: "tmdb:kids:tv", type: "series", tags: ["kids", "children", "family", "animation", "cartoons"] },
        ];

        for (const chart of builtinTmdbCharts) {
          const matchName = chart.name.toLowerCase().includes(qLower);
          const matchTag = chart.tags.some((t) => t.includes(qLower) || qLower.includes(t));
          if (matchName || matchTag) {
            results.push({
              name: chart.name,
              user: "TMDB Official",
              url: chart.url,
              type: chart.type,
              items: "Chart",
              likes: 0,
            });
          }
        }

        return json({ ok: true, lists: results.slice(0, 30) });
      } catch (err) {
        return json({ ok: false, error: String(err.message || err), lists: [] });
      }
    }

    // /api/trakt-search?q=...
    // -> powers the "Search Trakt Lists" box in the builder page. Proxies
    // trakt.tv's public list-search endpoint so people can find and add
    // public trakt.tv lists with a click instead of copy-pasting URLs.
    if (path === "/api/trakt-search") {
      const q = url.searchParams.get("q") || "";
      const traktKey = url.searchParams.get("traktKey") || "";
      try {
        const lists = await searchTraktLists(q, traktKey);
        // Always the shared key when traktKey wasn't supplied -- 1 search
        // call plus 1 classify call per result (searchTraktLists's own
        // internal mapWithConcurrency over the results it just got back).
        if (!traktKey) ctx.waitUntil(bumpStatBy(env, "apiuse:trakt", 1 + lists.length));
        return json({ ok: true, lists });
      } catch (err) {
        return json({ ok: false, error: String(err.message || err) });
      }
    }

    // /api/trakt-popular-lists?traktKey=...
    // -> returns popular public community lists directly from Trakt's API
    if (path === "/api/trakt-popular-lists") {
      const traktKeyParam = url.searchParams.get("traktKey") || "";
      const traktKey = traktKeyParam || TRAKT_CLIENT_ID;
      if (!traktKey) {
        return json({ ok: false, lists: [] });
      }
      try {
        const src = "https://api.trakt.tv/lists/popular?limit=30";
        const res = await fetch(src, {
          headers: {
            "Content-Type": "application/json",
            "trakt-api-version": "2",
            "trakt-api-key": traktKey,
            "User-Agent": "my-list-addon/1.6",
          },
          cf: { cacheTtl: 3600, cacheEverything: true },
        });
        if (!res.ok) {
          return json({ ok: false, lists: [] });
        }
        const data = await res.json();
        const lists = (Array.isArray(data) ? data : [])
          .map((r) => r.list || r)
          .filter((l) => l && l.ids && l.ids.slug && l.user && (l.user.username || (l.user.ids && l.user.ids.slug)))
          .map((l) => {
            const username = l.user.username || l.user.ids.slug;
            const slug = l.ids.slug;
            return {
              name: l.name,
              user: username,
              slug: slug,
              items: l.item_count || 0,
              likes: l.likes || 0,
              url: `https://trakt.tv/users/${encodeURIComponent(username)}/lists/${encodeURIComponent(slug)}`,
              type: "movie",
            };
          });
        return json({ ok: true, lists });
      } catch (err) {
        return json({ ok: false, lists: [] });
      }
    }

    // /api/trakt-my-lists?username=...&traktKey=...
    // -> powers the "Your Trakt Lists" section in the builder: once someone
    // fills in a Trakt username, this lists everything they've made public
    // at trakt.tv/users/:username/lists (public data -- no OAuth/user-level
    // token needed, just the usual app-level Trakt-Api-Key, same as every
    // other Trakt call here). traktKey overrides the shared TRAKT_CLIENT_ID
    // the same way it does everywhere else.
    if (path === "/api/trakt-my-lists") {
      const username = (url.searchParams.get("username") || "").trim();
      const traktKeyParam = url.searchParams.get("traktKey") || "";
      if (!username) return json({ ok: false, error: "Missing username." }, 400);
      const traktKey = traktKeyParam || TRAKT_CLIENT_ID;
      if (!traktKey) {
        return json({ ok: false, error: "Trakt lists aren't configured on this add-on yet — enter a Trakt Client ID above, or ask the Worker owner to set TRAKT_CLIENT_ID." });
      }
      try {
        const src = `https://api.trakt.tv/users/${encodeURIComponent(username)}/lists`;
        const res = await fetch(src, {
          headers: {
            "Content-Type": "application/json",
            "trakt-api-version": "2",
            "trakt-api-key": traktKey,
            "User-Agent": `my-list-addon/${ADDON_VERSION}`,
          },
          cf: { cacheTtl: 300, cacheEverything: true },
        });
        if (!res.ok) {
          if (res.status === 404) {
            return json({ ok: false, error: `No Trakt user found with the username "${username}".` });
          }
          if (res.status === 403) {
            return json({
              ok: false,
              error: traktKeyParam
                ? "Trakt rejected the Client ID you entered (HTTP 403 = invalid or unapproved app). Double check it against https://trakt.tv/oauth/applications."
                : "Trakt rejected this add-on's API key (HTTP 403 = invalid or unapproved app). Enter your own Trakt Client ID above to bypass this, or ask the Worker owner to fix TRAKT_CLIENT_ID.",
            });
          }
          return json({ ok: false, error: `Trakt request failed (HTTP ${res.status}).` });
        }
        const data = await res.json();
        const lists = (Array.isArray(data) ? data : [])
          .filter((l) => l && l.ids && l.ids.slug)
          .map((l) => ({
            name: l.name,
            slug: l.ids.slug,
            items: l.item_count || 0,
            likes: l.likes || 0,
            url: `https://trakt.tv/users/${encodeURIComponent(username)}/lists/${encodeURIComponent(l.ids.slug)}`,
          }));
        const classified = await mapWithConcurrency(lists, 8, async (l) => ({
          ...l,
          contentType: await classifyTraktListContentType(username, l.slug, traktKey),
        }));
        // Always the shared key when traktKeyParam wasn't supplied -- 1
        // call for the lists index above, plus 1 classify call per list.
        if (!traktKeyParam) ctx.waitUntil(bumpStatBy(env, "apiuse:trakt", 1 + classified.length));
        return json({ ok: true, lists: classified });
      } catch (err) {
        return json({ ok: false, error: String(err.message || err) });
      }
    }

    // --- Trakt OAuth (private lists) ----------------------------------------
    //
    // Everything above this point only ever needed TRAKT_CLIENT_ID (an
    // app-level key, same for every visitor) since it's all public data.
    // A private list is only visible to its own owner, which Trakt only
    // recognizes via a real user-level OAuth token -- this is that flow.
    // TRAKT_CLIENT_SECRET is a genuine secret (unlike TRAKT_CLIENT_ID,
    // which is already public-facing in every request this Worker makes)
    // and must be set via `wrangler secret put TRAKT_CLIENT_SECRET`, never
    // hardcoded here.
    //
    // No server-side token storage: the resulting access token is handed
    // straight back to the browser and saved into the person's own config,
    // the same way their MDBList key or Trakt Client ID already are (see
    // traktAccessToken throughout). That keeps this consistent with how
    // every other credential in this add-on works -- nothing here is tied
    // to an account on this Worker -- at the cost of no silent background
    // refresh: Trakt access tokens last about 3 months, and reconnecting
    // after that is a deliberate manual step, not automatic.

    // /api/trakt/oauth/start -> redirects to Trakt's own login/approve page.
    // A short-lived, HttpOnly state cookie (scoped to just this OAuth path)
    // guards against CSRF -- the callback below refuses to proceed unless
    // the state Trakt hands back matches what was stored here.
    if (path === "/api/trakt/oauth/start") {
      if (!TRAKT_CLIENT_ID) {
        return new Response("Trakt isn't configured on this Worker (missing TRAKT_CLIENT_ID).", { status: 500 });
      }
      const state = generateShortId();
      const redirectUri = `${url.origin}/api/trakt/oauth/callback`;
      const authorizeUrl =
        `https://trakt.tv/oauth/authorize?response_type=code&client_id=${encodeURIComponent(TRAKT_CLIENT_ID)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`;
      // ?debug=1 -> shows the exact values as plain text instead of
      // redirecting, so a redirect_uri mismatch against what's registered
      // at trakt.tv/oauth/applications can be spotted directly (copy/paste
      // comparison) instead of needing to catch a fleeting 302 in devtools.
      // Not a security concern to expose -- everything shown here (origin,
      // Client ID, computed callback URL) is either already public or
      // derived from the request itself; no secret ever appears.
      if (url.searchParams.get("debug") === "1") {
        return new Response(
          `Worker sees this request's origin as:\n  ${url.origin}\n\n` +
            `It will send Trakt exactly this redirect_uri:\n  ${redirectUri}\n\n` +
            `That needs to appear byte-for-byte in your Trakt app's Redirect URI list at\n  https://trakt.tv/oauth/applications\n\n` +
            `Full authorize URL it would redirect to:\n  ${authorizeUrl}\n`,
          { headers: { "Content-Type": "text/plain; charset=utf-8" } }
        );
      }
      return new Response(null, {
        status: 302,
        headers: {
          Location: authorizeUrl,
          // SameSite=Lax (not Strict) -- this cookie has to survive the
          // top-level cross-site redirect Trakt sends the browser back
          // through to reach the callback below; Strict cookies aren't
          // sent on that kind of navigation.
          "Set-Cookie": `mla_trakt_state=${state}; Path=/api/trakt/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
        },
      });
    }

    // /api/trakt/oauth/callback -> exchanges the code Trakt sends back for
    // an access token, then redirects to the builder page with that token
    // in a URL *fragment* (#trakt_token=...) rather than a query string --
    // fragments are never sent to any server on subsequent requests or
    // typically written to server access logs, unlike a query param would
    // be. The builder page's own init script reads it from
    // location.hash, saves it, and strips it from the address bar
    // immediately (see the client-side pickUpTraktTokenFromUrl below).
    if (path === "/api/trakt/oauth/callback") {
      const cookies = parseCookies(request);
      const expectedState = cookies.mla_trakt_state || "";
      const clearStateCookie = "mla_trakt_state=; Path=/api/trakt/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
      const failWith = (reason, detail) => {
        const params = new URLSearchParams({ trakt_error: reason });
        if (detail) params.set("trakt_error_detail", detail);
        return new Response(null, {
          status: 302,
          headers: { Location: `${url.origin}/?${params.toString()}`, "Set-Cookie": clearStateCookie },
        });
      };

      if (url.searchParams.get("error")) return failWith(url.searchParams.get("error"));
      const code = url.searchParams.get("code") || "";
      const state = url.searchParams.get("state") || "";
      if (!code || !state || !expectedState || !timingSafeEqualHex(state, expectedState)) {
        return failWith("state_mismatch");
      }
      if (!env || !env.TRAKT_CLIENT_SECRET) return failWith("not_configured");

      try {
        const redirectUri = `${url.origin}/api/trakt/oauth/callback`;
        const tokenRes = await fetch("https://api.trakt.tv/oauth/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": `my-list-addon/${ADDON_VERSION}`,
          },
          body: JSON.stringify({
            code,
            client_id: TRAKT_CLIENT_ID,
            client_secret: env.TRAKT_CLIENT_SECRET,
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
          }),
        });
        if (!tokenRes.ok) {
          // Trakt's token endpoint returns a standard OAuth2-shaped error
          // body ({error, error_description}) on failure -- surface that
          // verbatim rather than a generic message, since the actual cause
          // (bad client_secret, expired/already-used code, redirect_uri
          // mismatch specifically on this step, etc.) is otherwise
          // invisible and turns every failure into a guessing game.
          let detail = `HTTP ${tokenRes.status}`;
          try {
            const text = await tokenRes.text();
            try {
              const errBody = JSON.parse(text);
              if (errBody && (errBody.error || errBody.error_description)) {
                detail = [errBody.error, errBody.error_description].filter(Boolean).join(": ");
              } else if (text) {
                detail = text.slice(0, 200);
              }
            } catch {
              if (text) detail = text.slice(0, 200);
            }
          } catch {
            // keep the HTTP-status-only detail
          }
          return failWith("exchange_failed", detail);
        }
        const tokenData = await tokenRes.json();
        if (!tokenData.access_token) return failWith("no_token");
        let traktUsername = "";
        try {
          const meRes = await fetch("https://api.trakt.tv/users/me", {
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${tokenData.access_token}`,
              "trakt-api-version": "2",
              "trakt-api-key": clientId || TRAKT_CLIENT_ID,
              "User-Agent": `my-list-addon/${ADDON_VERSION}`,
            },
          });
          if (meRes.ok) {
            const meData = await meRes.json();
            if (meData && meData.username) traktUsername = meData.username;
          }
        } catch {}
        return new Response(null, {
          status: 302,
          headers: {
            Location: `${url.origin}/#trakt_token=${encodeURIComponent(tokenData.access_token)}${traktUsername ? `&trakt_username=${encodeURIComponent(traktUsername)}` : ""}`,
            "Set-Cookie": clearStateCookie,
          },
        });
      } catch {
        return failWith("network");
      }
    }

    // /api/mdblist/oauth/start -> redirects to MDBList login/authorization
    if (path === "/api/mdblist/oauth/start") {
      const clientId = MDBLIST_CLIENT_ID || (env && env.MDBLIST_CLIENT_ID) || "";
      if (!clientId) {
        return new Response("MDBList OAuth isn't configured on this Worker (missing MDBLIST_CLIENT_ID in Cloudflare Secrets).", { status: 500 });
      }
      const state = generateShortId();
      const { verifier, challenge } = await generatePkcePair();
      const redirectUri = url.hostname.includes("mylistsaddon.com")
        ? "https://mylistsaddon.com/api/mdblist/oauth/callback"
        : `${url.origin}/api/mdblist/oauth/callback`;
      const authorizeUrl =
        `https://mdblist.com/oauth/authorize/?response_type=code&client_id=${encodeURIComponent(clientId)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}` +
        `&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256`;
      if (url.searchParams.get("debug") === "1") {
        return new Response(
          `Worker sees this request's origin as:\n  ${url.origin}\n\n` +
            `It will send MDBList exactly this redirect_uri:\n  ${redirectUri}\n\n` +
            `That needs to appear byte-for-byte in your MDBList app's Redirect URI list at\n  https://mdblist.com/developer/\n\n` +
            `Full authorize URL it would redirect to:\n  ${authorizeUrl}\n`,
          { headers: { "Content-Type": "text/plain; charset=utf-8" } }
        );
      }
      return new Response(null, {
        status: 302,
        headers: {
          Location: authorizeUrl,
          "Set-Cookie": `mla_mdblist_state=${state}:${verifier}; Path=/api/mdblist/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
        },
      });
    }

    // /api/mdblist/oauth/callback -> exchanges the code for an MDBList token
    if (path === "/api/mdblist/oauth/callback") {
      const cookies = parseCookies(request);
      const rawState = cookies.mla_mdblist_state || "";
      const [expectedState, verifier] = rawState.split(":");
      const clearStateCookie = "mla_mdblist_state=; Path=/api/mdblist/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
      const failWith = (reason, detail) => {
        const params = new URLSearchParams({ mdblist_error: reason });
        if (detail) params.set("mdblist_error_detail", detail);
        return new Response(null, {
          status: 302,
          headers: { Location: `${url.origin}/?${params.toString()}`, "Set-Cookie": clearStateCookie },
        });
      };

      if (url.searchParams.get("error")) return failWith(url.searchParams.get("error"));
      const code = url.searchParams.get("code") || "";
      const state = url.searchParams.get("state") || "";
      if (!code || !state || !expectedState || !timingSafeEqualHex(state, expectedState)) {
        return failWith("state_mismatch");
      }
      const clientId = MDBLIST_CLIENT_ID || (env && env.MDBLIST_CLIENT_ID) || "";
      const clientSecret = (env && env.MDBLIST_CLIENT_SECRET) || "";
      if (!clientId || !clientSecret) return failWith("not_configured");

      try {
        const redirectUri = url.hostname.includes("mylistsaddon.com")
          ? "https://mylistsaddon.com/api/mdblist/oauth/callback"
          : `${url.origin}/api/mdblist/oauth/callback`;

        const formParams = new URLSearchParams();
        formParams.set("grant_type", "authorization_code");
        formParams.set("code", code);
        formParams.set("client_id", clientId);
        formParams.set("client_secret", clientSecret);
        formParams.set("redirect_uri", redirectUri);
        if (verifier) formParams.set("code_verifier", verifier);

        const basicAuth = btoa(`${clientId}:${clientSecret}`);

        let tokenRes = await fetch("https://api.mdblist.com/oauth/token/", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            "Authorization": `Basic ${basicAuth}`,
            "User-Agent": `my-list-addon/${ADDON_VERSION}`,
            "Accept": "application/json",
          },
          body: formParams.toString(),
        });

        if (!tokenRes.ok) {
          // Fallback: try without Authorization header (credentials in form body only)
          const fallbackRes = await fetch("https://api.mdblist.com/oauth/token/", {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
              "User-Agent": `my-list-addon/${ADDON_VERSION}`,
              "Accept": "application/json",
            },
            body: formParams.toString(),
          });
          if (fallbackRes.ok) {
            tokenRes = fallbackRes;
          }
        }

        if (!tokenRes.ok) {
          let detail = `HTTP ${tokenRes.status}`;
          try {
            const text = await tokenRes.text();
            try {
              const errBody = JSON.parse(text);
              if (errBody && (errBody.error || errBody.error_description || errBody.message)) {
                detail = [errBody.error, errBody.error_description, errBody.message].filter(Boolean).join(": ");
              } else if (text) {
                detail = text.slice(0, 200);
              }
            } catch {
              if (text) detail = text.slice(0, 200);
            }
          } catch {}
          return failWith("exchange_failed", detail);
        }
        const tokenData = await tokenRes.json();
        const token = tokenData.access_token || tokenData.apikey || tokenData.token;
        if (!token) return failWith("no_token");
        let mdblistUsername = tokenData.username || tokenData.user || "";
        if (!mdblistUsername) {
          try {
            const uRes = await fetch(`https://api.mdblist.com/user?apikey=${encodeURIComponent(token)}`, {
              headers: { "User-Agent": `my-list-addon/${ADDON_VERSION}` }
            });
            if (uRes.ok) {
              const uData = await uRes.json();
              if (uData && (uData.username || uData.user_name || uData.name)) {
                mdblistUsername = uData.username || uData.user_name || uData.name;
              }
            }
          } catch {}
        }
        return new Response(null, {
          status: 302,
          headers: {
            Location: `${url.origin}/#mdblist_token=${encodeURIComponent(token)}${mdblistUsername ? `&mdblist_username=${encodeURIComponent(mdblistUsername)}` : ""}`,
            "Set-Cookie": clearStateCookie,
          },
        });
      } catch (err) {
        return failWith("network", String(err.message || err));
      }
    }

    // /api/tmdb/oauth/start -> requests temporary request token from TMDB & redirects to authenticate page
    if (path === "/api/tmdb/oauth/start") {
      const apiKey = TMDB_API_KEY || (env && env.TMDB_API_KEY) || "";
      if (!apiKey) {
        return new Response("TMDB isn't configured on this Worker (missing TMDB_API_KEY).", { status: 500 });
      }
      try {
        const tokenRes = await fetch(`https://api.themoviedb.org/3/authentication/token/new?api_key=${encodeURIComponent(apiKey)}`, {
          headers: { "User-Agent": `my-list-addon/${ADDON_VERSION}` },
        });
        const tokenData = await tokenRes.json();
        if (!tokenData.success || !tokenData.request_token) {
          return new Response("Could not create TMDB request token: " + (tokenData.status_message || "unknown error"), { status: 500 });
        }
        const requestToken = tokenData.request_token;
        const redirectUri = `${url.origin}/api/tmdb/oauth/callback`;
        const authorizeUrl = `https://www.themoviedb.org/authenticate/${encodeURIComponent(requestToken)}?redirect_to=${encodeURIComponent(redirectUri)}`;
        return new Response(null, {
          status: 302,
          headers: {
            Location: authorizeUrl,
            "Set-Cookie": `mla_tmdb_token=${encodeURIComponent(requestToken)}; Path=/api/tmdb/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
          },
        });
      } catch (err) {
        return new Response("Network error contacting TMDB: " + err.message, { status: 500 });
      }
    }

    // /api/tmdb/oauth/callback -> exchanges request token for session ID & account details
    if (path === "/api/tmdb/oauth/callback") {
      const cookies = parseCookies(request);
      const cookieToken = cookies.mla_tmdb_token || "";
      const clearCookie = "mla_tmdb_token=; Path=/api/tmdb/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
      const failWith = (reason, detail) => {
        const params = new URLSearchParams({ tmdb_error: reason });
        if (detail) params.set("tmdb_error_detail", detail);
        return new Response(null, {
          status: 302,
          headers: { Location: `${url.origin}/?${params.toString()}`, "Set-Cookie": clearCookie },
        });
      };

      const approved = url.searchParams.get("approved") === "true";
      const denied = url.searchParams.get("denied") === "true";
      if (denied) return failWith("access_denied");
      const requestToken = url.searchParams.get("request_token") || cookieToken;
      if (!requestToken) return failWith("no_token");

      const apiKey = TMDB_API_KEY || (env && env.TMDB_API_KEY) || "";
      if (!apiKey) return failWith("not_configured");

      try {
        // Exchange request token for session_id
        const sessionRes = await fetch(`https://api.themoviedb.org/3/authentication/session/new?api_key=${encodeURIComponent(apiKey)}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": `my-list-addon/${ADDON_VERSION}`,
          },
          body: JSON.stringify({ request_token: requestToken }),
        });
        const sessionData = await sessionRes.json();
        if (!sessionData.success || !sessionData.session_id) {
          return failWith("session_failed", sessionData.status_message || "");
        }
        const sessionId = sessionData.session_id;

        // Fetch account profile
        const accountRes = await fetch(`https://api.themoviedb.org/3/account?api_key=${encodeURIComponent(apiKey)}&session_id=${encodeURIComponent(sessionId)}`, {
          headers: { "User-Agent": `my-list-addon/${ADDON_VERSION}` },
        });
        const accountData = await accountRes.json();
        const accountId = accountData.id ? String(accountData.id) : "";
        const username = accountData.username || "";

        return new Response(null, {
          status: 302,
          headers: {
            Location: `${url.origin}/#tmdb_session=${encodeURIComponent(sessionId)}&tmdb_account=${encodeURIComponent(accountId)}&tmdb_user=${encodeURIComponent(username)}`,
            "Set-Cookie": clearCookie,
          },
        });
      } catch (err) {
        return failWith("network", err.message || String(err));
      }
    }

    // /api/tmdb-my-lists (GET or POST) -> returns user created lists, watchlist, and favorites
    if (path === "/api/tmdb-my-lists") {
      let sessionId = url.searchParams.get("sessionId") || "";
      let accountId = url.searchParams.get("accountId") || "";
      let manualKey = url.searchParams.get("tmdbKey") || "";

      if (request.method === "POST") {
        try {
          const body = await request.json();
          if (body.sessionId) sessionId = body.sessionId;
          if (body.accountId) accountId = body.accountId;
          if (body.tmdbKey) manualKey = body.tmdbKey;
        } catch {}
      }

      const apiKey = manualKey || TMDB_API_KEY || (env && env.TMDB_API_KEY) || "";
      if (!apiKey) {
        return json({ ok: false, error: "TMDB API key is missing." }, 400);
      }

      const isV4 = apiKey.startsWith("ey");
      const makeHeaders = () => {
        const h = { "User-Agent": `my-list-addon/${ADDON_VERSION}`, "Accept": "application/json" };
        if (isV4) h["Authorization"] = `Bearer ${apiKey}`;
        return h;
      };
      const makeUrl = (endpoint, params = {}) => {
        const u = new URL(`https://api.themoviedb.org/3${endpoint}`);
        if (!isV4) u.searchParams.set("api_key", apiKey);
        if (sessionId) u.searchParams.set("session_id", sessionId);
        for (const [k, v] of Object.entries(params)) {
          if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, v);
        }
        return u.toString();
      };

      // If we don't have accountId but have sessionId, query account details
      if (!accountId && sessionId) {
        try {
          const accRes = await fetch(makeUrl("/account"), { headers: makeHeaders() });
          const acc = await accRes.json();
          if (acc && acc.id) accountId = String(acc.id);
        } catch {}
      }

      if (!accountId && !sessionId) {
        return json({ ok: false, error: "Please connect your TMDB account first." }, 400);
      }

      const lists = [];

      try {
        // 1. Fetch user's custom lists
        if (accountId) {
          const listsRes = await fetch(makeUrl(`/account/${encodeURIComponent(accountId)}/lists`, { page: "1" }), {
            headers: makeHeaders()
          });
          const listsData = await listsRes.json();
          const rawLists = Array.isArray(listsData.results) ? listsData.results : [];
          
          const customListsWithItems = await Promise.all(
            rawLists.map(async (l) => {
              let previewItems = [];
              try {
                const listDetailRes = await fetch(makeUrl(`/list/${l.id}`), { headers: makeHeaders() });
                const listDetail = await listDetailRes.json();
                const rawItems = Array.isArray(listDetail.items) ? listDetail.items : (Array.isArray(listDetail.results) ? listDetail.results : []);
                previewItems = rawItems.slice(0, 9).map((it) => ({
                  id: it.id,
                  title: it.title || it.name || "Untitled",
                  year: (it.release_date || it.first_air_date || "").slice(0, 4),
                  poster: it.poster_path ? `https://image.tmdb.org/t/p/w300${it.poster_path}` : (it.poster || ""),
                  type: it.media_type || (it.title ? "movie" : "series"),
                }));
              } catch {}
              return {
                id: l.id,
                name: l.name || "Untitled List",
                url: `https://www.themoviedb.org/list/${l.id}`,
                contentType: l.list_type || "mixed",
                items: l.item_count || previewItems.length || 0,
                likes: l.favorite_count || 0,
                description: l.description || "",
                private: false,
                previewItems: previewItems,
              };
            })
          );
          lists.push(...customListsWithItems);
        }

        // 2. Fetch user's Watchlist (movies & tv) if session is available
        if (accountId && sessionId) {
          const [wlMoviesRes, wlTvRes, favMoviesRes, favTvRes] = await Promise.all([
            fetch(makeUrl(`/account/${encodeURIComponent(accountId)}/watchlist/movies`, { page: "1" }), { headers: makeHeaders() }).catch(() => null),
            fetch(makeUrl(`/account/${encodeURIComponent(accountId)}/watchlist/tv`, { page: "1" }), { headers: makeHeaders() }).catch(() => null),
            fetch(makeUrl(`/account/${encodeURIComponent(accountId)}/favorite/movies`, { page: "1" }), { headers: makeHeaders() }).catch(() => null),
            fetch(makeUrl(`/account/${encodeURIComponent(accountId)}/favorite/tv`, { page: "1" }), { headers: makeHeaders() }).catch(() => null),
          ]);

          if (wlMoviesRes && wlMoviesRes.ok) {
            const wlMovData = await wlMoviesRes.json();
            const rawItems = Array.isArray(wlMovData.results) ? wlMovData.results : [];
            const total = wlMovData.total_results || rawItems.length;
            if (total > 0) {
              const previewItems = rawItems.slice(0, 9).map((it) => ({
                id: it.id,
                title: it.title || it.name || "Untitled",
                year: (it.release_date || it.first_air_date || "").slice(0, 4),
                poster: it.poster_path ? `https://image.tmdb.org/t/p/w300${it.poster_path}` : "",
                type: "movie",
              }));
              lists.unshift({
                id: "watchlist_movies",
                name: "TMDB Watchlist (Movies)",
                url: `tmdb:account:watchlist:movies`,
                contentType: "movie",
                items: total,
                likes: 0,
                description: "Your TMDB Movie Watchlist",
                private: true,
                previewItems: previewItems,
              });
            }
          }

          if (wlTvRes && wlTvRes.ok) {
            const wlTvData = await wlTvRes.json();
            const rawItems = Array.isArray(wlTvData.results) ? wlTvData.results : [];
            const total = wlTvData.total_results || rawItems.length;
            if (total > 0) {
              const previewItems = rawItems.slice(0, 9).map((it) => ({
                id: it.id,
                title: it.name || it.title || "Untitled",
                year: (it.first_air_date || it.release_date || "").slice(0, 4),
                poster: it.poster_path ? `https://image.tmdb.org/t/p/w300${it.poster_path}` : "",
                type: "series",
              }));
              lists.unshift({
                id: "watchlist_tv",
                name: "TMDB Watchlist (Shows)",
                url: `tmdb:account:watchlist:tv`,
                contentType: "series",
                items: total,
                likes: 0,
                description: "Your TMDB TV Show Watchlist",
                private: true,
                previewItems: previewItems,
              });
            }
          }

          if (favMoviesRes && favMoviesRes.ok) {
            const favMovData = await favMoviesRes.json();
            const rawItems = Array.isArray(favMovData.results) ? favMovData.results : [];
            const total = favMovData.total_results || rawItems.length;
            if (total > 0) {
              const previewItems = rawItems.slice(0, 9).map((it) => ({
                id: it.id,
                title: it.title || it.name || "Untitled",
                year: (it.release_date || it.first_air_date || "").slice(0, 4),
                poster: it.poster_path ? `https://image.tmdb.org/t/p/w300${it.poster_path}` : "",
                type: "movie",
              }));
              lists.push({
                id: "favorites_movies",
                name: "TMDB Favorites (Movies)",
                url: `tmdb:account:favorites:movies`,
                contentType: "movie",
                items: total,
                likes: 0,
                description: "Your TMDB Favorite Movies",
                private: true,
                previewItems: previewItems,
              });
            }
          }

          if (favTvRes && favTvRes.ok) {
            const favTvData = await favTvRes.json();
            const rawItems = Array.isArray(favTvData.results) ? favTvData.results : [];
            const total = favTvData.total_results || rawItems.length;
            if (total > 0) {
              const previewItems = rawItems.slice(0, 9).map((it) => ({
                id: it.id,
                title: it.name || it.title || "Untitled",
                year: (it.first_air_date || it.release_date || "").slice(0, 4),
                poster: it.poster_path ? `https://image.tmdb.org/t/p/w300${it.poster_path}` : "",
                type: "series",
              }));
              lists.push({
                id: "favorites_tv",
                name: "TMDB Favorites (Shows)",
                url: `tmdb:account:favorites:tv`,
                contentType: "series",
                items: total,
                likes: 0,
                description: "Your TMDB Favorite TV Shows",
                private: true,
                previewItems: previewItems,
              });
            }
          }
        }

        return json({ ok: true, lists });
      } catch (err) {
        return json({ ok: false, error: "Failed to load TMDB lists: " + (err.message || String(err)) }, 500);
      }
    }


    // /api/trakt-my-private-lists  (POST)  { accessToken } -> { ok, lists }
    // Same shape as /api/trakt-my-lists above, but hits /users/me/lists
    // with the OAuth token as a Bearer header instead of a plain username
    // lookup -- "me" resolves to whichever account approved the
    // connection, and includes their private lists (which the public,
    // username-based endpoint above can never see). POST, not GET, so the
    // token travels in the body rather than sitting in a URL/query string
    // that could end up in logs.
    if (path === "/api/trakt-my-private-lists" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const accessToken = String(body.accessToken || "").trim();
      if (!accessToken) return json({ ok: false, error: "Not connected to Trakt." }, 400);
      try {
        const res = await fetch("https://api.trakt.tv/users/me/lists", {
          headers: {
            "Content-Type": "application/json",
            "trakt-api-version": "2",
            "trakt-api-key": TRAKT_CLIENT_ID,
            Authorization: `Bearer ${accessToken}`,
            "User-Agent": `my-list-addon/${ADDON_VERSION}`,
          },
          // Never cache an authenticated, per-person response -- see the
          // same caching note on fetchTrakt above.
          cf: { cacheTtl: 0, cacheEverything: false },
        });
        if (res.status === 401) {
          return json({ ok: false, error: "Your Trakt connection has expired or was revoked -- reconnect in Settings." });
        }
        if (!res.ok) return json({ ok: false, error: `Trakt request failed (HTTP ${res.status}).` });
        const data = await res.json();
        const meRes = await fetch("https://api.trakt.tv/users/me", {
          headers: {
            "Content-Type": "application/json",
            "trakt-api-version": "2",
            "trakt-api-key": TRAKT_CLIENT_ID,
            Authorization: `Bearer ${accessToken}`,
            "User-Agent": `my-list-addon/${ADDON_VERSION}`,
          },
          cf: { cacheTtl: 0, cacheEverything: false },
        });
        const me = meRes.ok ? await meRes.json() : null;
        const meSlug = me && me.ids && me.ids.slug ? me.ids.slug : "me";
        const lists = (Array.isArray(data) ? data : [])
          .filter((l) => l && l.ids && l.ids.slug)
          .map((l) => ({
            name: l.name,
            slug: l.ids.slug,
            items: l.item_count || 0,
            likes: l.likes || 0,
            private: l.privacy !== "public",
            url: `https://trakt.tv/users/${encodeURIComponent(meSlug)}/lists/${encodeURIComponent(l.ids.slug)}`,
          }));
        const classified = await mapWithConcurrency(lists, 8, async (l) => ({
          ...l,
          contentType: await classifyTraktListContentType(meSlug, l.slug, TRAKT_CLIENT_ID, accessToken),
        }));

        // The watchlist is a genuinely different endpoint from a list --
        // Trakt never includes it in /users/me/lists above, so it has to
        // be fetched and prepended separately to actually show up here at
        // all. A cheap limit=1 request is enough to read the true total
        // count off Trakt's own pagination header without pulling any
        // real item data. contentType is left as "unknown" deliberately
        // (rather than trying to classify it): a watchlist is almost
        // always a mix of movies and shows for most people, and "unknown"
        // is exactly the signal the client already uses to offer both
        // +Movies/+Shows buttons and to auto-split into two Custom Lists
        // when copying.
        let watchlistCount = 0;
        try {
          const watchlistRes = await fetch("https://api.trakt.tv/users/me/watchlist?limit=1&page=1", {
            headers: {
              "Content-Type": "application/json",
              "trakt-api-version": "2",
              "trakt-api-key": TRAKT_CLIENT_ID,
              Authorization: `Bearer ${accessToken}`,
              "User-Agent": `my-list-addon/${ADDON_VERSION}`,
            },
            cf: { cacheTtl: 0, cacheEverything: false },
          });
          if (watchlistRes.ok) {
            watchlistCount = parseInt(watchlistRes.headers.get("X-Pagination-Item-Count") || "0", 10) || 0;
          }
        } catch {
          // best-effort -- the watchlist entry still shows below, just
          // without a count, rather than failing the whole request over it
        }
        const watchlistEntry = {
          name: "Watchlist",
          slug: "watchlist",
          items: watchlistCount,
          likes: 0,
          private: true,
          url: "trakt:watchlist",
          contentType: "unknown",
        };

        // Same idea as the watchlist above -- History is yet another
        // endpoint Trakt keeps separate from /users/me/lists, so it's
        // fetched and prepended the same way. contentType stays "unknown"
        // since a watch history is basically always a mix of movies and
        // shows, same reasoning as the watchlist.
        let historyCount = 0;
        try {
          const historyRes = await fetch("https://api.trakt.tv/users/me/history?limit=1&page=1", {
            headers: {
              "Content-Type": "application/json",
              "trakt-api-version": "2",
              "trakt-api-key": TRAKT_CLIENT_ID,
              Authorization: `Bearer ${accessToken}`,
              "User-Agent": `my-list-addon/${ADDON_VERSION}`,
            },
            cf: { cacheTtl: 0, cacheEverything: false },
          });
          if (historyRes.ok) {
            historyCount = parseInt(historyRes.headers.get("X-Pagination-Item-Count") || "0", 10) || 0;
          }
        } catch {
          // best-effort -- the history entry still shows below, just
          // without a count, rather than failing the whole request over it
        }
        const historyEntry = {
          name: "Watch History",
          slug: "history",
          items: historyCount,
          likes: 0,
          private: true,
          url: "trakt:history",
          contentType: "unknown",
        };

        // Always the shared TRAKT_CLIENT_ID (OAuth calls always identify
        // via this add-on's own app, never a per-user override) -- lists,
        // me, watchlist, and history are 4 fixed calls, plus 1 classify
        // call per list.
        ctx.waitUntil(bumpStatBy(env, "apiuse:trakt", 4 + classified.length));
        return json({ ok: true, lists: [watchlistEntry, historyEntry, ...classified] });
      } catch (err) {
        return json({ ok: false, error: String(err.message || err) });
      }
    }

    // /api/trakt-history-raw  (POST)  { accessToken, type: 'movies'|'episodes', page, limit }
    // -> { ok, items: [...raw Trakt history rows...], hasMore }
    // Deliberately returns Trakt's raw, unmapped rows rather than going
    // through mapTraktHistoryItems (used everywhere else this add-on reads
    // history) -- that mapping folds each row into a display-ready catalog
    // meta and throws away the real per-episode TMDB id and season/episode
    // numbers along the way, which is exactly what the client's "Mark all
    // as Watched" needs to build proper Watch History/Continue Watching
    // entries. This is the same raw shape a Trakt Export JSON file already
    // uses (Trakt's export is generated from this same API), so the client
    // reuses mapTraktExportEntryToWatchHistoryItem unchanged for both.
    if (path === "/api/trakt-history-raw" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const accessToken = String(body.accessToken || "").trim();
      if (!accessToken) return json({ ok: false, error: "Not connected to Trakt." }, 400);
      const itemKind = body.type === "episodes" ? "episodes" : "movies";
      const page = Math.max(1, parseInt(body.page, 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(body.limit, 10) || 100));
      try {
        ctx.waitUntil(bumpStat(env, "apiuse:trakt"));
        const res = await fetch(`https://api.trakt.tv/users/me/history/${itemKind}?limit=${limit}&page=${page}`, {
          headers: {
            "Content-Type": "application/json",
            "trakt-api-version": "2",
            "trakt-api-key": TRAKT_CLIENT_ID,
            Authorization: `Bearer ${accessToken}`,
            "User-Agent": `my-list-addon/${ADDON_VERSION}`,
          },
          // Never cache an authenticated, per-person response -- see the
          // same caching note on fetchTrakt above.
          cf: { cacheTtl: 0, cacheEverything: false },
        });
        if (res.status === 401) {
          return json({ ok: false, error: "Your Trakt connection has expired or was revoked -- reconnect in Settings." });
        }
        if (!res.ok) return json({ ok: false, error: `Trakt history request failed (HTTP ${res.status}).` });
        const items = await res.json();
        const totalPages = parseInt(res.headers.get("x-pagination-page-count") || "1", 10) || 1;
        return json({ ok: true, items: Array.isArray(items) ? items : [], hasMore: page < totalPages });
      } catch (err) {
        return json({ ok: false, error: String(err.message || err) });
      }
    }

    // /api/feedback  (POST)  { category, message, contact?, creatorName? } -> { ok }
    // Settings > Feedback. No auth required -- anyone should be able to
    // report a bug or suggest something without needing a Creator Profile
    // first; creatorName is attached only if the person happens to be
    // signed in, purely so it's visible in the admin dashboard, not
    // verified against anything. Stored under a key that sorts
    // chronologically as a plain string (zero-padded millisecond epoch),
    // so the admin dashboard can list newest-first without needing to
    // parse and sort every value first.
    if (path === "/api/feedback" && request.method === "POST") {
      if (!env || !env.CONFIGS) return json({ ok: false, error: "Feedback storage isn't configured on this deployment." });
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const message = String(body.message || "").trim();
      if (!message) return json({ ok: false, error: "Message can't be empty." }, 400);
      if (message.length > 4000) return json({ ok: false, error: "That's a bit long -- please keep it under 4000 characters." }, 400);
      const allowedCategories = new Set(["bug", "improvement", "idea", "other"]);
      const category = allowedCategories.has(body.category) ? body.category : "other";
      const contact = String(body.contact || "").trim().slice(0, 200);
      const creatorName = body.creatorName ? String(body.creatorName).trim().slice(0, 100) : null;

      // Simple per-IP rate limit (5/hour) -- KV's read-then-write isn't
      // atomic (see bumpStat's own comment on the same tradeoff elsewhere
      // in this file), so this is a deterrent against casual spam/abuse,
      // not a hard guarantee against a determined actor. Skipped entirely
      // for the admin dashboard's own "Log something yourself" form (an
      // authenticated admin, not an anonymous IP, submitting it) -- the
      // admin session cookie already rides along on that fetch() call
      // since it's same-origin, so isAdminRequest can tell the two apart
      // without any extra plumbing on the client side.
      const isAdmin = await isAdminRequest(request, env);
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const rateLimitKey = `feedbackrate:${ip}:${statsToday()}`;
      const rateCountRaw = isAdmin ? null : await env.CONFIGS.get(rateLimitKey);
      const rateCount = parseInt(rateCountRaw, 10) || 0;
      if (!isAdmin && rateCount >= 5) {
        return json({ ok: false, error: "You've sent a few of these already today -- try again tomorrow, or reach out another way if it's urgent." });
      }

      const id = `${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      const entry = {
        id, category, message, contact: contact || null, creatorName,
        createdAt: Date.now(),
        completed: false,
        // Recorded for basic spam triage in the admin dashboard, not
        // shown to anyone else and never used for anything beyond that.
        userAgent: (request.headers.get("User-Agent") || "").slice(0, 300),
      };
      try {
        await env.CONFIGS.put(`feedback:${id}`, JSON.stringify(entry));
        if (!isAdmin) await env.CONFIGS.put(rateLimitKey, String(rateCount + 1), { expirationTtl: 86400 });
      } catch (e) {
        return json({ ok: false, error: "Could not save your feedback right now. Please try again in a moment." }, 500);
      }
      // entry is echoed back so the admin dashboard's "Log something
      // yourself" form can show the new card instantly (optimistic, using
      // its own locally-built entry) and then swap in the server's real
      // id/createdAt once this resolves -- needed because a later Mark
      // Completed click has to send an id the server actually recognizes.
      return json({ ok: true, entry });
    }

    // /api/track-search  (POST)  { query } -> { ok }
    // Fire-and-forget anonymous search query telemetry
    if (path === "/api/track-search" && request.method === "POST") {
      if (!env || !env.CONFIGS) return json({ ok: true });
      let body;
      try { body = await request.json(); } catch { return json({ ok: true }); }
      if (body && typeof body.query === "string" && body.query.trim()) {
        ctx.waitUntil(recordSearchQuery(env, body.query.trim()));
      }
      return json({ ok: true });
    }

    // /api/track-event  (POST)  { events: [{ eventType, id, title, mediaType }, ...] } -> { ok }
    // Fire-and-forget analytics beacon feeding recordTrackedEvent above --
    // "watched" for anything marked watched, "list-add" for anything added
    // to a Custom List, "list-copy" for imported lists, "catalog-add" for installed catalogs.
    if (path === "/api/track-event" && request.method === "POST") {
      if (!env || !env.CONFIGS) return json({ ok: true });
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: true });
      }
      const events = Array.isArray(body.events) ? body.events.slice(0, 50) : [];
      const allowedTypes = new Set(["watched", "list-add", "list-copy", "catalog-add"]);
      await Promise.all(
        events.map((e) => {
          if (!e || !allowedTypes.has(e.eventType)) return Promise.resolve();
          if (e.eventType === "catalog-add") {
            const name = sanitizeStatGroupName(e.title || e.id);
            if (name) return bumpStat(env, `catalog_add:${name}`);
            return Promise.resolve();
          }
          if (e.eventType === "list-copy") {
            const slug = String(e.id || "").trim().slice(0, 100);
            if (slug) return bumpStat(env, `list_copy:${slug}`);
            return Promise.resolve();
          }
          if (!e.id) return Promise.resolve();
          return recordTrackedEvent(
            env,
            e.eventType,
            String(e.id).slice(0, 100),
            String(e.title || "").slice(0, 200),
            e.mediaType === "series" ? "series" : "movie"
          );
        })
      );
      return json({ ok: true });
    }

    // /api/mdblist-my-lists?apikey=... OR ?accessToken=...
    // -> powers the "Your MDBList Lists" section in the builder: includes
    // your Watchlist, Watch History, and all created public & private lists.
    if (path === "/api/mdblist-my-lists") {
      const apikey = (url.searchParams.get("apikey") || "").trim();
      const accessToken = (url.searchParams.get("accessToken") || "").trim();
      if (!apikey && !accessToken) return json({ ok: false, error: "Missing apikey or accessToken." }, 400);
      try {
        const headers = { "User-Agent": `my-list-addon/${ADDON_VERSION}` };
        let targetUrl = `https://api.mdblist.com/lists/user`;
        if (accessToken) {
          headers["Authorization"] = `Bearer ${accessToken}`;
        } else {
          targetUrl += `?apikey=${encodeURIComponent(apikey)}`;
        }
        const res = await fetch(targetUrl, {
          headers,
          cf: { cacheTtl: 60, cacheEverything: false },
        });
        if (!res.ok) {
          return json({ ok: false, error: `MDBList request failed (HTTP ${res.status}). Double check the API key or connection.` });
        }
        const data = await res.json();
        const rawLists = Array.isArray(data) ? data : Array.isArray(data.lists) ? data.lists : [];
        const lists = rawLists
          .filter((l) => l && l.slug && l.user_name)
          .map((l) => ({
            name: l.name || l.slug,
            slug: l.slug,
            mediatype: l.mediatype || "",
            contentType: l.mediatype === "show" ? "series" : (l.mediatype === "movie" ? "movie" : "unknown"),
            items: l.items || 0,
            likes: l.likes || 0,
            private: l.public === false || l.private === true,
            url: `https://mdblist.com/lists/${encodeURIComponent(l.user_name)}/${encodeURIComponent(l.slug)}`,
          }));

        const username = (rawLists.find((l) => l && l.user_name) || {}).user_name || "";
        const watchlistCard = {
          name: "My Watchlist",
          slug: "watchlist",
          items: 0,
          likes: 0,
          private: true,
          url: "mdblist:watchlist",
          contentType: "unknown",
        };

        const historyCard = {
          name: "Watch History",
          slug: "history",
          items: 0,
          likes: 0,
          private: true,
          url: username ? `https://mdblist.com/history/${encodeURIComponent(username)}` : "mdblist:history",
          contentType: "unknown",
        };

        return json({ ok: true, lists: [watchlistCard, historyCard, ...lists] });
      } catch (err) {
        return json({ ok: false, error: String(err.message || err) });
      }
    }

    // /api/mdblist-history-raw (POST) { apikey, accessToken, username? } -> { ok, items }
    if (path === "/api/mdblist-history-raw" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON body." }, 400); }
      const apikey = String(body.apikey || "").trim();
      const accessToken = String(body.accessToken || "").trim();
      let username = String(body.username || "").trim();
      const pageArg = parseInt(body.page || 1, 10);
      const token = accessToken || apikey;
      if (!token && !username) return json({ ok: false, error: "Not connected to MDBList." }, 400);
      try {
        const headers = { "User-Agent": `my-list-addon/${ADDON_VERSION}`, "Accept": "application/json" };
        const authQuery = accessToken ? "" : `?apikey=${encodeURIComponent(apikey)}`;
        if (accessToken) {
          headers["Authorization"] = `Bearer ${accessToken}`;
        }

        if (!username) {
          try {
            const userListsRes = await fetch(`https://api.mdblist.com/lists/user${authQuery}`, { headers });
            if (userListsRes.ok) {
              const udata = await userListsRes.json();
              const raw = Array.isArray(udata) ? udata : (Array.isArray(udata.lists) ? udata.lists : []);
              const found = raw.find((l) => l && l.user_name);
              if (found) username = found.user_name;
            }
          } catch {}
        }

        // Fetch all history from MDBList /sync/watched across mediatypes (movie, show, episode)
        let allItems = [];
        const logs = [];
        const LIMIT = 1000;
        const MAX_PAGES = 10;

        const mediatypes = ["movie", "show", "episode"];
        for (const mt of mediatypes) {
          let cursor = null;
          let offset = 0;
          let hasMore = true;
          let pageCount = 0;

          while (hasMore && pageCount < MAX_PAGES) {
            pageCount++;
            const sep = authQuery ? "&" : "?";
            const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : `&offset=${offset}`;
            const pageUrl = `https://api.mdblist.com/sync/watched${authQuery}${sep}mediatype=${mt}&limit=${LIMIT}${cursorParam}&append_to_response=poster`;
            try {
              const res = await fetch(pageUrl, {
                headers,
                cf: { cacheTtl: 0, cacheEverything: false },
              });
              const text = await res.text();
              let parsed = null;
              try { parsed = JSON.parse(text); } catch {}
              logs.push({ url: pageUrl.replace(apikey, "***").replace(accessToken, "***"), status: res.status, preview: text.slice(0, 120) });
              if (!res.ok || !parsed) break;

              const movies = Array.isArray(parsed.movies) ? parsed.movies : [];
              const shows = Array.isArray(parsed.shows) ? parsed.shows : [];
              const episodes = Array.isArray(parsed.episodes) ? parsed.episodes : [];
              const seasons = Array.isArray(parsed.seasons) ? parsed.seasons : [];
              const results = Array.isArray(parsed.results) ? parsed.results : [];
              const items = Array.isArray(parsed.items) ? parsed.items : [];
              const rawArray = Array.isArray(parsed) ? parsed : [];
              const batch = [...movies, ...shows, ...episodes, ...seasons, ...results, ...items, ...rawArray];
              allItems.push(...batch);

              if (parsed.next_cursor) {
                cursor = parsed.next_cursor;
                hasMore = true;
              } else if (batch.length >= LIMIT) {
                offset += batch.length;
                hasMore = true;
              } else {
                hasMore = false;
              }
            } catch (e) {
              logs.push({ url: pageUrl.replace(apikey, "***").replace(accessToken, "***"), error: String(e.message || e) });
              break;
            }
          }
        }

        // If mediatype queries returned nothing, fallback to unfiltered /sync/watched
        if (!allItems.length) {
          let cursor = null;
          let offset = 0;
          let hasMore = true;
          let pageCount = 0;
          while (hasMore && pageCount < MAX_PAGES) {
            pageCount++;
            const sep = authQuery ? "&" : "?";
            const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : `&offset=${offset}`;
            const pageUrl = `https://api.mdblist.com/sync/watched${authQuery}${sep}limit=${LIMIT}${cursorParam}&append_to_response=poster`;
            try {
              const res = await fetch(pageUrl, {
                headers,
                cf: { cacheTtl: 0, cacheEverything: false },
              });
              const text = await res.text();
              let parsed = null;
              try { parsed = JSON.parse(text); } catch {}
              logs.push({ url: pageUrl.replace(apikey, "***").replace(accessToken, "***"), status: res.status, preview: text.slice(0, 120) });
              if (!res.ok || !parsed) break;

              const movies = Array.isArray(parsed.movies) ? parsed.movies : [];
              const shows = Array.isArray(parsed.shows) ? parsed.shows : [];
              const episodes = Array.isArray(parsed.episodes) ? parsed.episodes : [];
              const seasons = Array.isArray(parsed.seasons) ? parsed.seasons : [];
              const results = Array.isArray(parsed.results) ? parsed.results : [];
              const items = Array.isArray(parsed.items) ? parsed.items : [];
              const rawArray = Array.isArray(parsed) ? parsed : [];
              const batch = [...movies, ...shows, ...episodes, ...seasons, ...results, ...items, ...rawArray];
              allItems.push(...batch);

              if (parsed.next_cursor) {
                cursor = parsed.next_cursor;
                hasMore = true;
              } else if (batch.length >= LIMIT) {
                offset += batch.length;
                hasMore = true;
              } else {
                hasMore = false;
              }
            } catch (e) {
              logs.push({ url: pageUrl.replace(apikey, "***").replace(accessToken, "***"), error: String(e.message || e) });
              break;
            }
          }
        }

        return json({ ok: true, items: allItems, debug: logs });
      } catch (err) {
        return json({ ok: false, error: String(err.message || err) });
      }
    }

    // /api/resolve?config=...
    // -> powers "Import from a link" in the builder page. Reuses the same
    // resolveConfig() the manifest/configure routes already use (handles
    // both a short KV id and a legacy self-contained base64 blob), just
    // returned as plain JSON instead of a manifest or an HTML page -- so
    // pasting an existing install/configure link can rebuild the same rows
    // client-side via addRow(), the same way importing a config JSON blob
    // does.
    if (path === "/api/resolve") {
      const config = url.searchParams.get("config") || "";
      if (!config) return json({ ok: false, error: "Missing config." }, 400);
      try {
        const { entries, mdblistKey, mdblistAccessToken, traktKey, traktUsername, traktAccessToken } = await resolveConfig(config, env);
        if (!entries.length) return json({ ok: false, error: "That link has no lists in it." });
        return json({ ok: true, entries, mdblistKey, mdblistAccessToken, traktKey, traktUsername, traktAccessToken });
      } catch (err) {
        return json({ ok: false, error: String(err.message || err) });
      }
    }

    // POST /api/save  { entries, mdblistKey, traktKey, traktUsername } -> { ok, id }
    // Stores the config server-side (when a CONFIGS KV namespace is bound)
    // and returns a short id to use in the install URL instead of a long
    // base64 blob. Returns { ok: false, error: "no-kv" } when no KV
    // namespace is bound, so the builder page can fall back to the old
    // client-side base64 link instead.
    if (path === "/api/save" && request.method === "POST") {
      if (!env || !env.CONFIGS) {
        return json({ ok: false, error: "no-kv" });
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const entries = Array.isArray(body.entries) ? body.entries : [];
      if (!entries.length) {
        return json({ ok: false, error: "No lists provided." }, 400);
      }
      const payload = { entries };
      if (body.mdblistKey) payload.mdblistKey = body.mdblistKey;
      if (body.mdblistAccessToken) payload.mdblistAccessToken = body.mdblistAccessToken;
      if (body.traktKey) payload.traktKey = body.traktKey;
      if (body.traktUsername) payload.traktUsername = body.traktUsername;
      if (body.traktAccessToken) payload.traktAccessToken = body.traktAccessToken;
      if (body.track) {
        payload.track = true;
        payload.trackCreatorName = body.trackCreatorName || "";
        payload.trackCreatorKey = body.trackCreatorKey || "";
      }
      if (body.shuffleShelves) payload.shuffleShelves = true;
      if (body.shuffleItems) payload.shuffleItems = true;

      let id;
      for (let attempt = 0; attempt < 5; attempt++) {
        id = generateShortId();
        const existing = await env.CONFIGS.get(id);
        if (!existing) break;
      }
      await env.CONFIGS.put(id, JSON.stringify(payload));
      return json({ ok: true, id });
    }

    if (path === "/api/publish-list" && request.method === "POST") {
      if (!env || !env.CONFIGS) return json({ ok: false, error: "no-kv" });
      let plBody;
      try { plBody = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON body." }, 400); }
      const baseSlug = slugifyServer(plBody.name || "");
      const plType = (plBody.type === "series" || plBody.type === "mixed") ? plBody.type : (plBody.type === "movie" ? "movie" : null);
      const plItems = Array.isArray(plBody.items) ? plBody.items : [];
      if (!baseSlug) return json({ ok: false, error: "Missing a list name." }, 400);
      if (!plType) return json({ ok: false, error: "Missing or invalid list type." }, 400);
      let listSlug = baseSlug;
      let plKey = "publishedlist:user:" + listSlug;
      for (let attempt = 2; attempt <= 500; attempt++) {
        const existing = await env.CONFIGS.get(plKey);
        if (!existing) break;
        listSlug = baseSlug + "-" + attempt;
        plKey = "publishedlist:user:" + listSlug;
      }
      const plVisibility = plBody.visibility === "private" ? "private" : "public";
      await env.CONFIGS.put(plKey, JSON.stringify({ name: plBody.name || baseSlug, type: plType, items: plItems, visibility: plVisibility, likes: 0, publishedAt: Date.now() }));
      return json({ ok: true, listName: listSlug, url: url.origin + "/lists/user/" + listSlug });
    }

    if (path === "/api/lists/like" && request.method === "POST") {
      if (!env || !env.CONFIGS) return json({ ok: false, error: "no-kv" });
      let likeBody;
      try { likeBody = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON body." }, 400); }
      const likeUser = String(likeBody.username || "").toLowerCase().trim();
      const likeSlug = String(likeBody.slug || "").toLowerCase().trim();
      const likeUnlike = likeBody.action === "unlike";
      if (!likeUser || !likeSlug) return json({ ok: false, error: "Missing list reference." }, 400);
      const likeCreatorKey = "creatorlist:" + likeUser + ":" + likeSlug;
      const likeAnonKey = "publishedlist:" + likeUser + ":" + likeSlug;
      let likeKey = null;
      let likeRaw = await env.CONFIGS.get(likeCreatorKey);
      if (likeRaw) { likeKey = likeCreatorKey; } else { likeRaw = await env.CONFIGS.get(likeAnonKey); if (likeRaw) likeKey = likeAnonKey; }
      if (!likeKey) return json({ ok: false, error: "List not found." }, 404);
      let likeData;
      try { likeData = JSON.parse(likeRaw); } catch { return json({ ok: false, error: "Corrupted." }, 500); }
      likeData.likes = Math.max(0, (likeData.likes || 0) + (likeUnlike ? -1 : 1));
      await env.CONFIGS.put(likeKey, JSON.stringify(likeData));
      return json({ ok: true, likes: likeData.likes });
    }

    if (path === "/api/lists/like-external" && request.method === "POST") {
      if (!env || !env.CONFIGS) return json({ ok: false, error: "no-kv" });
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const rawUrl = String(body.url || "").trim();
      if (!rawUrl) return json({ ok: false, error: "Missing list URL." }, 400);
      const unlike = body.action === "unlike";
      const hash = await hashStringForKey(rawUrl.toLowerCase());
      const key = `externallike:${hash}`;
      const raw = await env.CONFIGS.get(key);
      let data = { url: rawUrl, likes: 0 };
      if (raw) {
        try {
          data = JSON.parse(raw);
        } catch {
          data = { url: rawUrl, likes: 0 };
        }
      }
      data.likes = Math.max(0, (data.likes || 0) + (unlike ? -1 : 1));
      data.url = rawUrl;
      data.updatedAt = Date.now();
      await env.CONFIGS.put(key, JSON.stringify(data));
      return json({ ok: true, likes: data.likes });
    }


    // /api/details (GET or POST) -> { ok: true, details: { title, overview, rating, releaseYear, poster, background } }
    if (path === "/api/details") {
      let reqBody;
      if (request.method === "POST") {
        try {
          reqBody = await request.json();
        } catch {
          reqBody = {};
        }
      } else {
        const q = url.searchParams;
        reqBody = { imdbId: q.get("imdbId") || "", tmdbKey: q.get("tmdbKey") || "", type: q.get("type") || "" };
      }
      
      const imdbId = reqBody.imdbId;
      const tmdbKey = reqBody.tmdbKey || TMDB_API_KEY;
      if (!imdbId) return json({ ok: false, error: "Missing imdbId" }, 400);
      if (!reqBody.tmdbKey) ctx.waitUntil(bumpStat(env, "apiuse:tmdb"));
      
      const details = await fetchTmdbItemDetails(imdbId, tmdbKey, reqBody.type);
      if (!details) return json({ ok: false, error: "Not found or TMDB error" }, 404);
      
      // Short max-age -- same reasoning as /api/season's own comment: this
      // response's shape changes occasionally (tmdbId is a recent
      // addition), and json()'s 3600s default would leave anyone who'd
      // opened this exact show recently stuck looking at an hour-old,
      // pre-fix cached copy.
      return json({ ok: true, details }, 200, { "Cache-Control": "max-age=60" });
    }


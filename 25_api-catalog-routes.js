
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
    TMDB_API_KEY = env.TMDB_API_KEY || "";
    TRAKT_CLIENT_ID = env.TRAKT_CLIENT_ID || "";
    SIMKL_CLIENT_ID = env.SIMKL_CLIENT_ID || "";
    MDBLIST_API_KEY = env.MDBLIST_API_KEY || "";
    MDBLIST_POPULAR_KEY = env.MDBLIST_POPULAR_KEY || "";

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
      const { entries, tmdbKey, mdblistKey, traktKey, traktUsername, traktAccessToken } = await resolveConfig(m[1], env);
      return new Response(
        renderBuilder(url.origin, {
          initialEntries: entries,
          initialKeys: { tmdbKey, mdblistKey, traktKey, traktUsername, traktAccessToken },
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

    // /:config/manifest.json
    m = path.match(/^\/([^/]+)\/manifest\.json$/);
    if (m) {
      // If this looks like a browser page-load (e.g. wako sent you here for
      // "Configure") rather than a JSON fetch by the app, send the user to
      // the actual editable configure page instead of showing raw JSON.
      if (isBrowserNavigation(request)) {
        return Response.redirect(`${url.origin}/${m[1]}/configure`, 302);
      }
      const { entries, track } = await resolveConfig(m[1], env);
      return json(buildManifest(entries, url.origin, track));
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

      const { entries, tmdbKey, mdblistKey, traktKey, traktAccessToken } = await resolveConfig(config, env);
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
        const metas = await fetchCatalog(entry, skip, { tmdbKey, mdblistKey, traktKey, traktAccessToken, env });
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
      let testUrl, type, tmdbKey, mdblistKey, traktKey, traktAccessToken, sampleSize, skip;
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
        traktKey = reqBody.traktKey || "";
        traktAccessToken = reqBody.traktAccessToken || "";
        sampleSize = Math.max(1, Math.min(PAGE_SIZE, parseInt(reqBody.sample, 10) || 5));
        skip = Math.max(0, parseInt(reqBody.skip, 10) || 0);
      } else {
        testUrl = url.searchParams.get("url") || "";
        type = url.searchParams.get("type") === "series" ? "series" : "movie";
        tmdbKey = url.searchParams.get("tmdbKey") || "";
        mdblistKey = url.searchParams.get("mdblistKey") || "";
        traktKey = url.searchParams.get("traktKey") || "";
        traktAccessToken = url.searchParams.get("traktAccessToken") || "";
        sampleSize = Math.max(1, Math.min(PAGE_SIZE, parseInt(url.searchParams.get("sample"), 10) || 5));
        skip = Math.max(0, parseInt(url.searchParams.get("skip"), 10) || 0);
      }
      let body;
      try {
        const metas = await fetchCatalog({ url: testUrl, type }, skip, { tmdbKey, mdblistKey, traktKey, traktAccessToken, env });
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

    // /:config/meta/:type/:id.json
    // -> synthetic meta for Channel entries (id "channel_<channelId>") --
    // the full hand-picked episode list, assembled into one series-shaped
    // response. Nothing else on this add-on needs a "meta" resource (every
    // other catalog item is resolved by whatever meta add-on -- usually
    // Cinemeta -- the person already has installed); the manifest scopes
    // this resource with idPrefixes so wako/Stremio only ever asks us for
    // our own synthetic ids, never a normal "tt..." one.
    m = path.match(/^\/([^/]+)\/meta\/([^/]+)\/(.+)\.json$/);
    if (m) {
      const [, config, metaType, idRaw] = m;
      const id = decodeURIComponent(idRaw);
      if (metaType !== "series" || !id.startsWith("channel_")) {
        return json({ meta: null });
      }
      const wantedChannelId = id.slice("channel_".length);
      try {
        const { entries } = await resolveConfig(config, env);
        // A row can merge several channels into one shelf (newline-joined
        // urls, same mechanism as merging any other source) -- each
        // sub-payload carries its own channelId, so every entry needs its
        // url split and checked individually rather than matching on the
        // *row's* own id, which only ever identifies the row as a whole.
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

    // /api/toplists
    // -> powers the "Popular Lists" browser in the builder page. Proxies
    // mdblist.com's own top-lists endpoint so people can add lists from
    // https://mdblist.com/toplists/ with a click instead of copy-pasting URLs.
    // Uses the fixed MDBLIST_POPULAR_KEY (see top of file) — no per-user key
    // needed for this, since it's the same public data for everyone.
    if (path === "/api/toplists") {
      try {
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
        const tmdbKey = q.get("tmdbKey") || TMDB_API_KEY;
        
        if (!imdbId || !seasonNum) return json({ ok: false, error: "Missing imdbId or seasonNum" }, 400);
        
        const seasonData = await fetchTmdbSeasonDetails(imdbId, seasonNum, tmdbKey);
        if (!seasonData) return json({ ok: false, error: "Not found or TMDB error" }, 404);
        
        return json({ ok: true, season: seasonData });
      }

    // /api/title-search?q=...&type=movie|tv
    // -> powers the "Search a show/movie" box in the Channel builder.
    // Straight TMDB title search, trimmed to what the picker UI needs.
    if (path === "/api/title-search") {
      const q = (url.searchParams.get("q") || "").trim();
      const kind = url.searchParams.get("type") === "movie" ? "movie" : "tv";
      if (!q) return json({ ok: false, error: "Missing search query." }, 400);
      try {
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
          for (let page = 1; page <= 10; page++) {
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
              if (networkData.logo_path) networkLogo = `https://image.tmdb.org/t/p/w500${networkData.logo_path}`;
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
          metas = await fetchCatalog({ url: listUrl, type: "series" }, 0, { mdblistKey, traktKey, traktAccessToken, env });
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
        const details = await fetchTmdbDetails(tmdbId, "tv", TMDB_API_KEY);
        if (!details.imdbId) return json({ ok: false, error: "Couldn't resolve an IMDB id for this show." });
        return json({ ok: true, imdbId: details.imdbId });
      } catch (err) {
        return json({ ok: false, error: String(err.message || err) });
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
        return json({ ok: true, lists });
      } catch (err) {
        return json({ ok: false, error: String(err.message || err) });
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
        return new Response(null, {
          status: 302,
          headers: {
            Location: `${url.origin}/#trakt_token=${encodeURIComponent(tokenData.access_token)}`,
            "Set-Cookie": clearStateCookie,
          },
        });
      } catch {
        return failWith("network");
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

    // /api/mdblist-my-lists?apikey=...
    // -> powers the "Your MDBList Lists" section in the builder: every list
    // the API key's own account has created (not just the built-in
    // watchlist mdblist:watchlist already covers). Same simple ?apikey=
    // auth every other mdblist call here already uses.
    if (path === "/api/mdblist-my-lists") {
      const apikey = (url.searchParams.get("apikey") || "").trim();
      if (!apikey) return json({ ok: false, error: "Missing apikey." }, 400);
      try {
        const res = await fetch(`https://api.mdblist.com/lists/user?apikey=${encodeURIComponent(apikey)}`, {
          headers: { "User-Agent": `my-list-addon/${ADDON_VERSION}` },
          cf: { cacheTtl: 60, cacheEverything: false },
        });
        if (!res.ok) {
          return json({ ok: false, error: `MDBList request failed (HTTP ${res.status}). Double check the API key.` });
        }
        const data = await res.json();
        const rawLists = Array.isArray(data) ? data : Array.isArray(data.lists) ? data.lists : [];
        const lists = rawLists
          .filter((l) => l && l.slug && l.user_name)
          .map((l) => ({
            name: l.name || l.slug,
            slug: l.slug,
            mediatype: l.mediatype || "",
            items: l.items || 0,
            url: `https://mdblist.com/lists/${encodeURIComponent(l.user_name)}/${encodeURIComponent(l.slug)}`,
          }));
        return json({ ok: true, lists });
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
        const { entries, mdblistKey, traktKey, traktUsername, traktAccessToken } = await resolveConfig(config, env);
        if (!entries.length) return json({ ok: false, error: "That link has no lists in it." });
        return json({ ok: true, entries, mdblistKey, traktKey, traktUsername, traktAccessToken });
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
      if (body.traktKey) payload.traktKey = body.traktKey;
      if (body.traktUsername) payload.traktUsername = body.traktUsername;
      if (body.traktAccessToken) payload.traktAccessToken = body.traktAccessToken;
      if (body.track) {
        payload.track = true;
        payload.trackCreatorName = body.trackCreatorName || "";
        payload.trackCreatorKey = body.trackCreatorKey || "";
      }

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
      const plType = plBody.type === "series" ? "series" : plBody.type === "movie" ? "movie" : null;
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
      
      const details = await fetchTmdbItemDetails(imdbId, tmdbKey, reqBody.type);
      if (!details) return json({ ok: false, error: "Not found or TMDB error" }, 404);
      
      return json({ ok: true, details });
    }


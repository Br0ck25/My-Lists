    // --- Creator Profile system --------------------------------------------
    //
    // No accounts, no email, no passwords -- a Creator Profile is just a
    // chosen name plus a randomly generated Creator Key (see
    // generateCreatorKey), with only a salted hash of that key ever stored
    // (see hashCreatorKey/verifyCreatorKey above). There's no session or
    // token issued on "login" either: every authenticated request below
    // re-sends the creatorName + creatorKey and gets re-verified against
    // the stored hash each time, which is what "no authentication system"
    // means here in practice -- simple, stateless, and nothing to expire
    // or revoke separately from the key itself.
    async function authenticateCreator(creatorNameRaw, creatorKey) {
      if (!env || !env.CONFIGS) return { ok: false, error: "no-kv" };
      const v = validateCreatorUsername(creatorNameRaw);
      if (!v.ok) return { ok: false, error: "Username or Key is incorrect." };
      const raw = await env.CONFIGS.get(`creator:${v.normalized}`);
      if (!raw) return { ok: false, error: "Username or Key is incorrect." };
      let profile;
      try {
        profile = JSON.parse(raw);
      } catch {
        return { ok: false, error: "Username or Key is incorrect." };
      }
      const valid = await verifyCreatorKey(creatorKey || "", profile.keyHash);
      if (!valid) return { ok: false, error: "Username or Key is incorrect." };
      // Fire-and-forget, not awaited -- see touchCreatorLastSeen's own
      // comment for why this is throttled and safe to never wait on.
      touchCreatorLastSeen(env, v.normalized);
      return { ok: true, username: v.normalized, displayName: profile.displayName };
    }

    // Every failure path above returns the exact same generic message
    // deliberately -- "that name doesn't exist" vs "that key is wrong"
    // would let someone enumerate which creator names are already taken
    // just by trying to restore them.

    // Handles a single "this just started playing" ping from the
    // /:config/subtitles/... route (25_api-catalog-routes.js) -- see
    // buildManifest's comment for the full mechanism. Never throws back
    // to the caller (that route already responded before this runs, via
    // ctx.waitUntil), so every failure path below just records a
    // diagnostic and returns quietly instead.
    //
    // An episode gets marked watched outright: if you're playing it,
    // you're caught up to it -- a discrete, already-aired unit with
    // nothing ambiguous about it. A movie ping gets treated the same way
    // here, marked watched immediately, which is a deliberate
    // simplification versus where this idea started (a similar reference
    // implementation treats a movie ping as merely "in progress," since
    // one ping at the start doesn't prove you finished a 2-hour movie the
    // way starting an episode implies you're caught up to that episode).
    // This addon's Watch History has no in-progress state to put a movie
    // into, only watched/not-watched, so there isn't a cleanly analogous
    // middle ground to preserve that distinction with.
    function detectClientApp(request) {
      if (!request) return "Streaming App";
      const ua = (request.headers.get("user-agent") || "").toLowerCase();
      const referer = (request.headers.get("referer") || "").toLowerCase();
      const origin = (request.headers.get("origin") || "").toLowerCase();
      const appHeader = (request.headers.get("x-app-name") || request.headers.get("x-client-name") || request.headers.get("x-application") || "").toLowerCase();

      if (appHeader.includes("nuvio") || ua.includes("nuvio") || referer.includes("nuvio") || origin.includes("nuvio")) {
        return "Nuvio";
      }
      if (appHeader.includes("stremio") || ua.includes("stremio") || referer.includes("stremio") || origin.includes("stremio") || ua.includes("smarttv") || ua.includes("stremio-streaming-server")) {
        return "Stremio";
      }
      if (appHeader.includes("wako") || ua.includes("wako") || referer.includes("wako") || origin.includes("wako")) {
        return "Wako";
      }
      if (ua.includes("dart") || ua.includes("flutter")) {
        return "Nuvio";
      }
      if (ua.includes("cfnetwork") || (ua.includes("darwin") && !ua.includes("stremio"))) {
        return "Wako / iOS Player";
      }
      if (ua.includes("okhttp") && !ua.includes("stremio")) {
        return "Nuvio";
      }
      return "Streaming App";
    }

    async function handleSubtitlesTrack(configParam, stremioType, id, env, request) {
      if (!env || !env.CONFIGS) return;

      let track, trackCreatorName, trackCreatorKey, tmdbKey;
      try {
        ({ track, trackCreatorName, trackCreatorKey, tmdbKey } = await resolveConfig(configParam, env));
      } catch {
        return;
      }
      if (!track || !trackCreatorName || !trackCreatorKey) return;

      const auth = await authenticateCreator(trackCreatorName, trackCreatorKey);
      const diagnosticsKey = `creatortrack:${auth.ok ? auth.username : String(trackCreatorName).toLowerCase()}`;
      const pingId = `${stremioType}:${id}`;

      if (!auth.ok) {
        await env.CONFIGS.put(diagnosticsKey, JSON.stringify({
          lastPingAt: Date.now(),
          lastPingId: pingId,
          matched: "error: this install's Creator Profile credentials no longer authenticate -- re-generate the install link from Settings.",
        }));
        return;
      }

      const effectiveTmdbKey = tmdbKey || TMDB_API_KEY;
      // Already running inside the caller's ctx.waitUntil (see
      // handleSubtitlesTrack's own call site), so no extra waitUntil
      // needed here -- see trackSharedApiUse in 05_catalog-core.js for
      // the same pattern elsewhere.
      if (!tmdbKey) bumpStat(env, "apiuse:tmdb");
      const parts = id.split(":");
      const imdbId = parts[0];
      let matched = "no";

      try {
        await ensureTrackingMigrated(env, auth.username);
        const syncKey = `creatorsynctracking:${auth.username}`;
        const raw = await env.CONFIGS.get(syncKey);
        let blob = null;
        if (raw) {
          try {
            blob = JSON.parse(raw);
          } catch {
            blob = null;
          }
        }
        if (!blob || typeof blob !== "object") {
          blob = { watchHistory: [], continueWatching: [], fullyWatchedShowIds: [], dismissedContinueWatching: {}, trackPlayback: false };
        }
        blob.watchHistory = Array.isArray(blob.watchHistory) ? blob.watchHistory : [];
        blob.continueWatching = Array.isArray(blob.continueWatching) ? blob.continueWatching : [];
        blob.fullyWatchedShowIds = Array.isArray(blob.fullyWatchedShowIds) ? blob.fullyWatchedShowIds : [];
        blob.dismissedContinueWatching = blob.dismissedContinueWatching && typeof blob.dismissedContinueWatching === "object" ? blob.dismissedContinueWatching : {};

        if (stremioType === "series" && parts.length >= 3) {
          const season = Number(parts[1]);
          const episode = Number(parts[2]);
          if (!Number.isFinite(season) || !Number.isFinite(episode)) {
            matched = "no (unrecognized episode id format)";
          } else {
            const seasonData = await fetchTmdbSeasonDetails(imdbId, season, effectiveTmdbKey);
            const ep = seasonData && seasonData.episodes ? seasonData.episodes.find((e) => e.episode_number === episode) : null;
            if (!ep) {
              matched = "no (could not look up this episode on TMDB)";
            } else {
              const showDetails = await fetchTmdbItemDetails(imdbId, effectiveTmdbKey, "series").catch(() => null);
              const showGenres = (showDetails && showDetails.genres) || [];
              const showYear = (showDetails && (showDetails.releaseYear || showDetails.year || (showDetails.releaseDate && showDetails.releaseDate.slice(0, 4)))) || null;
              ctx.waitUntil(recordPlaybackTelemetry(env, "episode", showGenres, showYear));
              if (showDetails && showDetails.title) {
                ctx.waitUntil(recordTrackedEvent(env, "watched", imdbId, showDetails.title, "series"));
              }
              const alreadyWatched = blob.watchHistory.some((it) => String(it.id) === String(ep.id));
              if (!alreadyWatched) {
                blob.watchHistory.unshift({
                  id: String(ep.id),
                  type: "episode",
                  name: ep.name,
                  poster: ep.still_path || (showDetails && showDetails.poster) || "",
                  showId: imdbId,
                  showTitle: (showDetails && showDetails.title) || "",
                  showPoster: (showDetails && showDetails.poster) || "",
                  seasonNum: season,
                  episodeNum: episode,
                });
              }
              // Recompute this show's Continue Watching the same way the
              // cron does (checkForNewEpisodes, 07_source-fetchers-tmdb-
              // simkl.js) -- if this ping's episode happens to be the
              // latest watched one, this naturally finds and queues
              // whatever airs next.
              blob.continueWatching = blob.continueWatching.filter((it) => it.showId !== imdbId);
              const watchedEps = blob.watchHistory.filter((it) => it.type === "episode" && it.showId === imdbId && it.seasonNum != null && it.episodeNum != null);
              if (watchedEps.length) {
                const latest = watchedEps.reduce((best, e) => {
                  if (e.seasonNum > best.seasonNum) return e;
                  if (e.seasonNum === best.seasonNum && e.episodeNum > best.episodeNum) return e;
                  return best;
                }, watchedEps[0]);
                const dismissed = blob.dismissedContinueWatching[imdbId];
                const stillDismissed = !!(dismissed && dismissed.seasonNum === latest.seasonNum && dismissed.episodeNum === latest.episodeNum);
                if (!stillDismissed) {
                  const next = await findNextAiredEpisodeForShow(imdbId, latest.seasonNum, latest.episodeNum, effectiveTmdbKey).catch(() => null);
                  if (next) {
                    blob.continueWatching.unshift({
                      id: String(next.episode.id),
                      type: "episode",
                      name: next.episode.name,
                      // Show poster, not episode still -- see the matching
                      // comment on the cron's own continueWatching.unshift.
                      poster: latest.showPoster || "",
                      showId: imdbId,
                      showTitle: latest.showTitle || "",
                      showPoster: latest.showPoster || "",
                      seasonNum: next.seasonNum,
                      episodeNum: next.episode.episode_number,
                    });
                    blob.fullyWatchedShowIds = blob.fullyWatchedShowIds.filter((s) => s !== imdbId);
                  } else if (!blob.fullyWatchedShowIds.includes(imdbId)) {
                    blob.fullyWatchedShowIds.push(imdbId);
                  }
                }
              }
              matched = alreadyWatched ? "yes (already watched)" : "yes";
            }
          }
        } else if (stremioType === "movie") {
          const details = await fetchTmdbItemDetails(imdbId, effectiveTmdbKey, "movie").catch(() => null);
          const movieGenres = (details && details.genres) || [];
          const movieYear = (details && (details.releaseYear || details.year || (details.releaseDate && details.releaseDate.slice(0, 4)))) || null;
          ctx.waitUntil(recordPlaybackTelemetry(env, "movie", movieGenres, movieYear));
          if (details && details.title) {
            ctx.waitUntil(recordTrackedEvent(env, "watched", imdbId, details.title, "movie"));
          }
          const alreadyWatched = blob.watchHistory.some((it) => String(it.id) === imdbId);
          if (!alreadyWatched) {
            blob.watchHistory.unshift({
              id: imdbId,
              type: "movie",
              name: (details && details.title) || imdbId,
              poster: (details && details.poster) || "",
            });
          }
        } else {
          matched = "no (unrecognized id format)";
        }

        blob.watchlist = Array.isArray(blob.watchlist) ? blob.watchlist : [];
        if (blob.watchlist.length) {
          const initLen = blob.watchlist.length;
          blob.watchlist = blob.watchlist.filter((it) => it && String(it.id || it.imdbId) !== imdbId && String(it.showId || '') !== imdbId);
        }

        blob.updatedAt = Date.now();
        await env.CONFIGS.put(syncKey, JSON.stringify(blob));

        // Auto-remove watched item from user's Creator Watchlist if present
        try {
          const listKeys = await env.CONFIGS.list({ prefix: `creatorlist:${auth.username}:` });
          for (const k of (listKeys.keys || [])) {
            const rawList = await env.CONFIGS.get(k.name);
            if (!rawList) continue;
            const l = JSON.parse(rawList);
            const isWatchlist = l.slug === 'watchlist' || (l.name && l.name.toLowerCase() === 'watchlist') || l.isWatchlist;
            if (isWatchlist && Array.isArray(l.items) && l.items.length) {
              const initLen = l.items.length;
              l.items = l.items.filter((it) => it && String(it.id || it.imdbId) !== imdbId && String(it.showId || '') !== imdbId);
              if (l.items.length !== initLen) {
                l.updatedAt = Date.now();
                await env.CONFIGS.put(k.name, JSON.stringify(l));
              }
            }
          }
        } catch {}
      } catch (err) {
        matched = "error: " + (err && err.message ? err.message : String(err));
      }

      const clientApp = detectClientApp(request);
      await env.CONFIGS.put(diagnosticsKey, JSON.stringify({
        lastPingAt: Date.now(),
        lastPingId: pingId,
        lastServer: clientApp,
        matched: matched,
      }));
    }

    // Handles incoming webhooks from Plex, Jellyfin, and Emby media servers
    // Automatically marks watched episodes/movies and advances Continue Watching
    async function handleMediaServerScrobble(request, url, env, ctx) {
      if (!env || !env.CONFIGS) {
        return json({ ok: false, error: "Cloudflare KV storage (CONFIGS) not configured." }, 500);
      }

      // 1. Identify user / config
      const configParam = url.searchParams.get("config") || url.searchParams.get("token") || "";
      const queryCreator = url.searchParams.get("creator") || url.searchParams.get("user") || "";
      const queryKey = url.searchParams.get("key") || "";

      let authUser = null;
      let effectiveTmdbKey = TMDB_API_KEY;

      if (configParam) {
        try {
          const resolved = await resolveConfig(configParam, env);
          if (resolved && resolved.trackCreatorName && resolved.trackCreatorKey) {
            const auth = await authenticateCreator(resolved.trackCreatorName, resolved.trackCreatorKey);
            if (auth.ok) {
              authUser = auth.username;
              if (resolved.tmdbKey) effectiveTmdbKey = resolved.tmdbKey;
            }
          }
        } catch {}
      }

      if (!authUser && queryCreator && queryKey) {
        const auth = await authenticateCreator(queryCreator, queryKey);
        if (auth.ok) authUser = auth.username;
      }

      if (!authUser) {
        return json({ ok: false, error: "Unauthorized: Invalid or missing user credentials / config parameter." }, 401);
      }

      // 2. Parse payload from Plex, Jellyfin, or Emby
      const contentType = request.headers.get("content-type") || "";
      let payload = null;

      if (contentType.includes("multipart/form-data")) {
        try {
          const formData = await request.formData();
          const rawPayload = formData.get("payload");
          if (rawPayload && typeof rawPayload === "string") {
            payload = JSON.parse(rawPayload);
          }
        } catch {}
      } else {
        try {
          payload = await request.json();
        } catch {
          try {
            const text = await request.text();
            payload = JSON.parse(text);
          } catch {}
        }
      }

      if (!payload || typeof payload !== "object") {
        return json({ ok: false, error: "Invalid payload format. Expected JSON or multipart form." }, 400);
      }

      // 3. Detect Media Server Type & Event
      let server = "Media Server";
      let eventType = "";
      let mediaType = "movie"; // "movie" or "series"
      let imdbId = "";
      let tmdbId = "";
      let title = "";
      let showTitle = "";
      let season = null;
      let episode = null;
      let year = null;
      let isPlayed = false;

      // A. Plex Webhook format
      if (payload.Metadata || payload.event) {
        server = "Plex";
        eventType = String(payload.event || "").toLowerCase();
        isPlayed = eventType === "media.scrobble" || eventType === "media.play" || eventType === "media.stop" || eventType === "media.resume";
        
        const meta = payload.Metadata || {};
        mediaType = meta.type === "episode" ? "series" : "movie";
        title = meta.title || "";
        showTitle = meta.grandparentTitle || meta.parentTitle || "";
        season = meta.parentIndex != null ? Number(meta.parentIndex) : null;
        episode = meta.index != null ? Number(meta.index) : null;
        year = meta.year || null;

        const guids = Array.isArray(meta.Guid) ? meta.Guid : (meta.guid ? [{ id: meta.guid }] : []);
        for (const g of guids) {
          const gid = String(g.id || "");
          if (gid.includes("imdb://tt")) {
            const m = gid.match(/tt\d+/);
            if (m) imdbId = m[0];
          } else if (gid.includes("tmdb://")) {
            const m = gid.match(/tmdb:\/\/(\d+)/);
            if (m) tmdbId = m[1];
          }
        }
      }
      // B. Jellyfin Webhook format
      else if (payload.NotificationType || payload.ItemType || payload.ServerId) {
        server = "Jellyfin";
        eventType = String(payload.NotificationType || payload.Event || "").toLowerCase();
        isPlayed = eventType.includes("playback") || eventType.includes("userdata") || eventType.includes("scrobble") || payload.Played === true;
        
        mediaType = (payload.ItemType === "Episode" || payload.SeriesName) ? "series" : "movie";
        title = payload.Name || payload.ItemName || "";
        showTitle = payload.SeriesName || "";
        season = payload.SeasonNumber != null ? Number(payload.SeasonNumber) : null;
        episode = payload.EpisodeNumber != null ? Number(payload.EpisodeNumber) : null;
        year = payload.Year || null;

        const pIds = payload.ProviderIds || {};
        imdbId = pIds.Imdb || pIds.imdb || payload.Provider_imdb || "";
        tmdbId = pIds.Tmdb || pIds.tmdb || payload.Provider_tmdb || "";
      }
      // C. Emby Webhook format
      else if (payload.Item || (payload.Event && String(payload.Event).startsWith("playback."))) {
        server = "Emby";
        eventType = String(payload.Event || "").toLowerCase();
        isPlayed = eventType.includes("scrobble") || eventType.includes("playback.start") || eventType.includes("playback.stop") || eventType.includes("markplayed");

        const item = payload.Item || payload;
        mediaType = (item.Type === "Episode" || item.SeriesName) ? "series" : "movie";
        title = item.Name || "";
        showTitle = item.SeriesName || "";
        season = item.ParentIndexNumber != null ? Number(item.ParentIndexNumber) : null;
        episode = item.IndexNumber != null ? Number(item.IndexNumber) : null;

        const pIds = item.ProviderIds || {};
        imdbId = pIds.Imdb || pIds.imdb || "";
        tmdbId = pIds.Tmdb || pIds.tmdb || "";
      }

      if (!isPlayed) {
        return json({ ok: true, ignored: `Event '${eventType}' is not a scrobble/play event.` });
      }

      // 4. Resolve IDs via TMDB if needed
      if (!imdbId && tmdbId) {
        try {
          const tmdbType = mediaType === "series" ? "tv" : "movie";
          const tmdbRes = await fetch(`https://api.themoviedb.org/3/${tmdbType}/${tmdbId}?api_key=${effectiveTmdbKey}&append_to_response=external_ids`);
          if (tmdbRes.ok) {
            const d = await tmdbRes.json();
            imdbId = (d.external_ids && d.external_ids.imdb_id) || d.imdb_id || "";
          }
        } catch {}
      }

      if (!imdbId && (showTitle || title)) {
        try {
          const q = showTitle || title;
          const searchType = mediaType === "series" ? "tv" : "movie";
          const searchRes = await fetch(`https://api.themoviedb.org/3/search/${searchType}?api_key=${effectiveTmdbKey}&query=${encodeURIComponent(q)}&page=1`);
          if (searchRes.ok) {
            const sd = await searchRes.json();
            if (sd.results && sd.results.length) {
              const first = sd.results[0];
              tmdbId = String(first.id);
              const extRes = await fetch(`https://api.themoviedb.org/3/${searchType}/${first.id}?api_key=${effectiveTmdbKey}&append_to_response=external_ids`);
              if (extRes.ok) {
                const ed = await extRes.json();
                imdbId = (ed.external_ids && ed.external_ids.imdb_id) || ed.imdb_id || "";
              }
            }
          }
        } catch {}
      }

      const pingId = mediaType === "series" ? `${imdbId || tmdbId}:${season || 1}:${episode || 1}` : (imdbId || tmdbId || title);

      // 5. Execute Watch Record
      let matched = "no";
      try {
        await ensureTrackingMigrated(env, authUser);
        const syncKey = `creatorsynctracking:${authUser}`;
        const raw = await env.CONFIGS.get(syncKey);
        let blob = null;
        if (raw) {
          try { blob = JSON.parse(raw); } catch {}
        }
        if (!blob || typeof blob !== "object") {
          blob = { watchHistory: [], continueWatching: [], fullyWatchedShowIds: [], dismissedContinueWatching: {}, trackPlayback: true };
        }
        blob.watchHistory = Array.isArray(blob.watchHistory) ? blob.watchHistory : [];
        blob.continueWatching = Array.isArray(blob.continueWatching) ? blob.continueWatching : [];
        blob.fullyWatchedShowIds = Array.isArray(blob.fullyWatchedShowIds) ? blob.fullyWatchedShowIds : [];
        blob.dismissedContinueWatching = blob.dismissedContinueWatching && typeof blob.dismissedContinueWatching === "object" ? blob.dismissedContinueWatching : {};

        if (mediaType === "series") {
          const seasonNum = season != null ? season : 1;
          const episodeNum = episode != null ? episode : 1;
          
          let epName = title;
          let epPoster = "";
          let sTitle = showTitle || title;
          let sPoster = "";

          if (imdbId) {
            const seasonData = await fetchTmdbSeasonDetails(imdbId, seasonNum, effectiveTmdbKey).catch(() => null);
            const ep = seasonData && seasonData.episodes ? seasonData.episodes.find((e) => e.episode_number === episodeNum) : null;
            if (ep) {
              epName = ep.name || title;
              epPoster = ep.still_path || "";
            }
            const showDetails = await fetchTmdbItemDetails(imdbId, effectiveTmdbKey, "series").catch(() => null);
            if (showDetails) {
              sTitle = showDetails.title || sTitle;
              sPoster = showDetails.poster || "";
            }
          }

          const itemKey = `${imdbId || sTitle}:${seasonNum}:${episodeNum}`;
          const alreadyWatched = blob.watchHistory.some((it) => (it.showId === imdbId || it.showTitle === sTitle) && it.seasonNum === seasonNum && it.episodeNum === episodeNum);
          if (!alreadyWatched) {
            blob.watchHistory.unshift({
              id: itemKey,
              type: "episode",
              name: epName,
              poster: epPoster || sPoster,
              showId: imdbId || sTitle,
              showTitle: sTitle,
              showPoster: sPoster,
              seasonNum: seasonNum,
              episodeNum: episodeNum,
            });
          }

          // Recompute Continue Watching for this show
          blob.continueWatching = blob.continueWatching.filter((it) => it.showId !== (imdbId || sTitle));
          if (imdbId) {
            const next = await findNextAiredEpisodeForShow(imdbId, seasonNum, episodeNum, effectiveTmdbKey).catch(() => null);
            if (next) {
              blob.continueWatching.unshift({
                id: String(next.episode.id),
                type: "episode",
                name: next.episode.name,
                poster: sPoster || "",
                showId: imdbId,
                showTitle: sTitle,
                showPoster: sPoster,
                seasonNum: next.seasonNum,
                episodeNum: next.episode.episode_number,
              });
              blob.fullyWatchedShowIds = blob.fullyWatchedShowIds.filter((s) => s !== imdbId);
            } else if (!blob.fullyWatchedShowIds.includes(imdbId)) {
              blob.fullyWatchedShowIds.push(imdbId);
            }
          }
          matched = `yes (${server}: ${sTitle} S${seasonNum}E${episodeNum})`;
        } else {
          // Movie
          let movieTitle = title;
          let moviePoster = "";
          if (imdbId) {
            const details = await fetchTmdbItemDetails(imdbId, effectiveTmdbKey, "movie").catch(() => null);
            if (details) {
              movieTitle = details.title || movieTitle;
              moviePoster = details.poster || "";
            }
          }
          const alreadyWatched = blob.watchHistory.some((it) => String(it.id) === imdbId || it.name === movieTitle);
          if (!alreadyWatched) {
            blob.watchHistory.unshift({
              id: imdbId || movieTitle,
              type: "movie",
              name: movieTitle,
              poster: moviePoster,
            });
          }
          matched = `yes (${server}: ${movieTitle})`;
        }

        // Clean from watchlist if present
        if (Array.isArray(blob.watchlist)) {
          blob.watchlist = blob.watchlist.filter((it) => it && String(it.id || it.imdbId) !== imdbId && String(it.showId || "") !== imdbId);
        }

        blob.updatedAt = Date.now();
        await env.CONFIGS.put(syncKey, JSON.stringify(blob));
      } catch (err) {
        matched = `error (${server}): ` + (err && err.message ? err.message : String(err));
      }

      // Update diagnostics
      const diagnosticsKey = `creatortrack:${authUser}`;
      await env.CONFIGS.put(diagnosticsKey, JSON.stringify({
        lastPingAt: Date.now(),
        lastPingId: pingId,
        lastServer: server,
        matched: matched,
      }));

      return json({
        ok: true,
        server: server,
        event: eventType,
        matched: matched,
      });
    }

    // /api/creator/track-status  (POST)  { creatorName, creatorKey } ->
    // { ok, lastPingAt, lastPingId, matched } -- powers the "last ping"
    // status line on the Settings page's Auto-track playback panel, same
    // idea as the reference implementation's ping diagnostics. Kept in its
    // own creatortrack:{username} KV key rather than folded into the
    // creatorsync:{username} blob, since that blob gets wholesale-
    // overwritten by the browser's own background sync (pushCreatorSync)
    // on a timer -- storing this there would mean it kept getting quietly
    // wiped out by the very next sync from any signed-in device.
    if (path === "/api/creator/track-status" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const auth = await authenticateCreator(body.creatorName, body.creatorKey);
      if (!auth.ok) return json({ ok: false, error: auth.error === "no-kv" ? "no-kv" : "Username or Key is incorrect." });
      const raw = await env.CONFIGS.get(`creatortrack:${auth.username}`);
      let status = { lastPingAt: null, lastPingId: null, matched: null };
      if (raw) {
        try {
          status = JSON.parse(raw);
        } catch {
          // leave status as the empty default
        }
      }
      return json({ ok: true, ...status });
    }

    // /api/creator/create  (POST)  { creatorName } -> { ok, creatorName, displayName, creatorKey }
    // Rate limited to one new profile per minute per IP, tracked via a
    // short-lived KV key rather than anything more elaborate -- this add-on
    // has no user-identity system to rate-limit against besides the
    // requester's own IP.
    if (path === "/api/creator/create" && request.method === "POST") {
      if (!env || !env.CONFIGS) return json({ ok: false, error: "no-kv" });
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const rateLimitKey = `ratelimit:creatorcreate:${ip}`;
      if (await env.CONFIGS.get(rateLimitKey)) {
        return json({ ok: false, error: "Please wait a moment before creating another Creator Profile." }, 429);
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const v = validateCreatorUsername(body.creatorName);
      if (!v.ok) return json({ ok: false, error: v.error });
      const displayName = String(body.creatorName || "").trim();
      // Reserve the rate-limit slot before the uniqueness check, not after
      // -- otherwise two requests landing at nearly the same instant could
      // both pass the "is it taken" check before either has written
      // anything, and both succeed.
      await env.CONFIGS.put(rateLimitKey, "1", { expirationTtl: 60 });
      const existing = await env.CONFIGS.get(`creator:${v.normalized}`);
      if (existing) {
        return json({ ok: false, error: "That username is already taken." });
      }
      const creatorKey = generateCreatorKey();
      const keyHash = await hashCreatorKey(creatorKey);
      await env.CONFIGS.put(
        `creator:${v.normalized}`,
        JSON.stringify({ displayName, keyHash, createdAt: Date.now() })
      );
      // The Creator Key is returned exactly once, right here -- it's never
      // stored anywhere (only its hash is), so this is the only moment it
      // will ever exist outside whoever's holding onto it themselves.
      return json({ ok: true, creatorName: v.normalized, displayName, creatorKey });
    }

    // /api/creator/restore  (POST)  { creatorName, creatorKey } -> { ok, creatorName, displayName }
    if (path === "/api/creator/restore" && request.method === "POST") {
      if (!env || !env.CONFIGS) return json({ ok: false, error: "no-kv" });
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const rateLimitKey = `ratelimit:creatorrestore:${ip}`;
      const attempts = parseInt((await env.CONFIGS.get(rateLimitKey)) || "0", 10);
      // More generous than profile creation (this is a normal, repeatable
      // action -- someone restoring on a new device isn't abuse), but still
      // capped well below what's useful for guessing a ~60-bit key.
      if (attempts >= 20) {
        return json({ ok: false, error: "Too many attempts. Please wait a minute and try again." }, 429);
      }
      await env.CONFIGS.put(rateLimitKey, String(attempts + 1), { expirationTtl: 60 });
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const auth = await authenticateCreator(body.creatorName, body.creatorKey);
      if (!auth.ok) return json({ ok: false, error: auth.error === "no-kv" ? "no-kv" : "Username or Key is incorrect." });
      return json({ ok: true, creatorName: auth.username, displayName: auth.displayName });
    }

    // /api/creator/lists  (POST)  { creatorName, creatorKey } -> { ok, displayName, lists }
    // The Dashboard's data source -- every list this creator owns (public
    // AND private, since this is an authenticated request only the owner
    // can make), in their own persisted order.
    if (path === "/api/creator/lists" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const auth = await authenticateCreator(body.creatorName, body.creatorKey);
      if (!auth.ok) return json({ ok: false, error: auth.error === "no-kv" ? "no-kv" : "Username or Key is incorrect." });
      const orderRaw = await env.CONFIGS.get(`creatorlistorder:${auth.username}`);
      let order = [];
      try {
        order = orderRaw ? JSON.parse(orderRaw).order || [] : [];
      } catch {
        order = [];
      }
      const lists = (
        await Promise.all(
          order.map(async (slug) => {
            const raw = await env.CONFIGS.get(`creatorlist:${auth.username}:${slug}`);
            if (!raw) return null;
            try {
              const data = JSON.parse(raw);
              return {
                slug,
                name: data.name,
                type: data.type,
                items: data.items || [],
                itemCount: (data.items || []).length,
                likes: data.likes || 0,
                visibility: data.visibility === "private" ? "private" : "public",
                url: `${url.origin}/lists/${auth.username}/${slug}`,
              };
            } catch {
              return null;
            }
          })
        )
      ).filter(Boolean);
      return json({ ok: true, displayName: auth.displayName, lists, order });
    }

    // /api/creator/lists/save  (POST)
    // { creatorName, creatorKey, slug (optional -- present means "update
    //   this existing list", absent means "create a new one"), name, type,
    //   items, visibility } -> { ok, slug, url }
    if (path === "/api/creator/lists/save" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const auth = await authenticateCreator(body.creatorName, body.creatorKey);
      if (!auth.ok) return json({ ok: false, error: auth.error === "no-kv" ? "no-kv" : "Username or Key is incorrect." });

      const type = (body.type === "series" || body.type === "mixed") ? body.type : (body.type === "movie" ? "movie" : null);
      const items = Array.isArray(body.items) ? body.items : [];
      const visibility = body.visibility === "private" ? "private" : "public";
      const name = String(body.name || "").trim();
      if (!name) return json({ ok: false, error: "Missing a list name." }, 400);
      if (!type) return json({ ok: false, error: "Missing or invalid list type." }, 400);

      const orderRaw = await env.CONFIGS.get(`creatorlistorder:${auth.username}`);
      let order = [];
      try {
        order = orderRaw ? JSON.parse(orderRaw).order || [] : [];
      } catch {
        order = [];
      }

      const editingSlug = body.slug && order.includes(body.slug) ? body.slug : null;
      let slug;
      if (editingSlug) {
        // Editing keeps its existing URL even if the name changed --
        // re-slugging on every rename would break links people already
        // have to it.
        slug = editingSlug;
      } else {
        // New list -- slug uniqueness only needs to hold within this
        // creator's own namespace (see the spec: jack/top-10 and
        // someone-else/top-10 are unrelated), so the collision check and
        // auto-increment only look at this creator's own list keys.
        const baseSlug = slugifyServer(name) || "list";
        slug = baseSlug;
        for (let attempt = 2; attempt <= 500; attempt++) {
          if (!order.includes(slug)) break;
          slug = `${baseSlug}-${attempt}`;
        }
      }

      const now = Date.now();
      const existingRaw = editingSlug ? await env.CONFIGS.get(`creatorlist:${auth.username}:${slug}`) : null;
      let createdAt = now;
      let likes = 0;
      if (existingRaw) {
        try {
          const existing = JSON.parse(existingRaw);
          createdAt = existing.createdAt || now;
          likes = existing.likes || 0;
        } catch {
          createdAt = now;
        }
      }
      await env.CONFIGS.put(
        `creatorlist:${auth.username}:${slug}`,
        JSON.stringify({ name, slug, type, items, visibility, likes, createdAt, updatedAt: now })
      );
      if (!order.includes(slug)) {
        order.push(slug);
        await env.CONFIGS.put(`creatorlistorder:${auth.username}`, JSON.stringify({ order }));
      }
      return json({ ok: true, slug, url: `${url.origin}/lists/${auth.username}/${slug}` });
    }

    // /api/creator/lists/delete  (POST)  { creatorName, creatorKey, slug }
    if (path === "/api/creator/lists/delete" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const auth = await authenticateCreator(body.creatorName, body.creatorKey);
      if (!auth.ok) return json({ ok: false, error: auth.error === "no-kv" ? "no-kv" : "Username or Key is incorrect." });
      const slug = String(body.slug || "");
      if (!slug) return json({ ok: false, error: "Missing slug." }, 400);
      await env.CONFIGS.delete(`creatorlist:${auth.username}:${slug}`);
      const orderRaw = await env.CONFIGS.get(`creatorlistorder:${auth.username}`);
      let order = [];
      try {
        order = orderRaw ? JSON.parse(orderRaw).order || [] : [];
      } catch {
        order = [];
      }
      order = order.filter((s) => s !== slug);
      await env.CONFIGS.put(`creatorlistorder:${auth.username}`, JSON.stringify({ order }));
      return json({ ok: true });
    }

    // /api/creator/lists/reorder  (POST)  { creatorName, creatorKey, order: [slug, ...] }
    if (path === "/api/creator/lists/reorder" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const auth = await authenticateCreator(body.creatorName, body.creatorKey);
      if (!auth.ok) return json({ ok: false, error: auth.error === "no-kv" ? "no-kv" : "Username or Key is incorrect." });
      const newOrder = Array.isArray(body.order) ? body.order.map(String).filter(s => /^[a-zA-Z0-9_.:-]+$/.test(s)) : [];
      await env.CONFIGS.put(`creatorlistorder:${auth.username}`, JSON.stringify({ order: newOrder }));
      return json({ ok: true, order: newOrder });
    }

    // /api/creator/delete-account  (POST)  { creatorName, creatorKey } -> { ok }
    // Permanently removes the creator profile, their published lists, order, and sync data
    if (path === "/api/creator/delete-account" && request.method === "POST") {
      if (!env || !env.CONFIGS) return json({ ok: false, error: "Database not configured." }, 500);
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const auth = await authenticateCreator(body.creatorName, body.creatorKey);
      if (!auth.ok) return json({ ok: false, error: auth.error === "no-kv" ? "no-kv" : "Username or Key is incorrect." }, 401);
      const u = auth.username;
      try {
        const listKeys = await env.CONFIGS.list({ prefix: `creatorlist:${u}:` });
        for (const k of listKeys.keys) {
          await env.CONFIGS.delete(k.name);
        }
      } catch {}
      try {
        await env.CONFIGS.delete(`creatorprofile:${u}`);
        await env.CONFIGS.delete(`creatorlistorder:${u}`);
        await env.CONFIGS.delete(`creatortrack:${u}`);
        await env.CONFIGS.delete(`creatorpresets:${u}`);
        await env.CONFIGS.delete(`creatorlikes:${u}`);
        await env.CONFIGS.delete(`creatorchannels:${u}`);
      } catch {}
      return json({ ok: true });
    }

    // --- Site-wide account sync ---------------------------------------------
    //
    // A Creator Profile started out scoped to just publishing/managing
    // Custom Lists (the block above). This extends the same account to the
    // rest of the builder page too: the person's full list of source rows
    // and their order, their saved presets, which panels they'd left
    // collapsed, and which lists they'd liked -- so signing in on another
    // device or browser picks up where they left off instead of starting
    // from a blank page. Still no email/password: the same Creator Name +
    // Creator Key from above is all that's needed.
    //
    // Deliberately a single wholesale blob rather than four separate
    // endpoints -- the client always has the complete current picture of
    // all four in memory already (collectEntries(), the presets map, the
    // collapsed-panel state, and the liked-lists set), so there's no
    // partial-update case that actually needs a smaller request, and one
    // key is simpler to reason about than keeping four in sync with each
    // other.
    if (path === "/api/creator/sync/save" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const auth = await authenticateCreator(body.creatorName, body.creatorKey);
      if (!auth.ok) return json({ ok: false, error: auth.error === "no-kv" ? "no-kv" : "Username or Key is incorrect." });

      // Same one-time forward migration, this time for tracking data
      // (watchHistory/continueWatching/fullyWatchedShowIds/
      // dismissedContinueWatching/trackPlayback) -- see
      // ensureTrackingMigrated's own comment. Critical to run here
      // specifically: this endpoint is the most frequent write to
      // creatorsync:{username} of any of them (any routine autosave), and
      // the blob built below no longer includes tracking fields at all --
      // without migrating first, the very next autosave after this
      // shipped would silently erase anyone's tracking data before
      // save-tracking ever got a chance to run for them.
      await ensureTrackingMigrated(env, auth.username);

      // One-time forward migration: presets used to live embedded in this
      // same blob, but as of this endpoint no longer accepts them here at
      // all (see /api/creator/sync/save-presets below) -- an updated client
      // never sends body.presets/presetsB64 anymore. Without this check,
      // the very first autosave after updating would overwrite this blob
      // with no presets embedded, and since nothing would have copied the
      // old embedded presets into the dedicated key yet either, they'd be
      // gone. Only runs once per account: after the dedicated key exists
      // (whether from this migration or a real preset save), this block is
      // skipped on every subsequent save.
      const existingPresetsKey = await env.CONFIGS.get(`creatorsyncpresets:${auth.username}`);
      if (existingPresetsKey === null) {
        const oldRaw = await env.CONFIGS.get(`creatorsync:${auth.username}`);
        if (oldRaw) {
          try {
            const oldBlob = JSON.parse(oldRaw);
            if (oldBlob.presetsB64 || (oldBlob.presets && Object.keys(oldBlob.presets).length)) {
              await env.CONFIGS.put(`creatorsyncpresets:${auth.username}`, JSON.stringify({
                presets: (oldBlob.presets && typeof oldBlob.presets === "object") ? oldBlob.presets : {},
                presetsB64: oldBlob.presetsB64 || null,
              }));
            }
          } catch {
            // Old blob was unreadable -- nothing to migrate; whatever's
            // already in the dedicated key (or lack of one) stands as-is.
          }
        }
      }

      const blob = {
        config: Array.isArray(body.config) ? body.config : [],
        keys: body.keys && typeof body.keys === "object" ? body.keys : {},
        collapsedPanels: body.collapsedPanels && typeof body.collapsedPanels === "object" ? body.collapsedPanels : {},
        likedLists: Array.isArray(body.likedLists) ? body.likedLists.map(String) : [],
        updatedAt: Date.now(),
      };
      const serialized = JSON.stringify(blob);
      // Workers KV hard-caps a value at 25MB. Presets/Channels and tracking
      // data (watchHistory/continueWatching/etc) no longer live in this
      // blob at all (see above), so this is now just a defensive backstop
      // rather than the main thing it used to guard against.
      if (serialized.length > 24 * 1024 * 1024) {
        return json({ ok: false, error: "This account's saved data is too large to store (over the 25MB limit)." });
      }
      try {
        await env.CONFIGS.put(`creatorsync:${auth.username}`, serialized);
      } catch (e) {
        // A real KV failure (rate limit, transient error, etc.) previously
        // surfaced to the client as nothing more than a failed fetch --
        // this at least tells the person something specific went wrong
        // server-side rather than leaving "check your connection" as the
        // only explanation, which is misleading when the connection was
        // never the problem.
        return json({ ok: false, error: "Could not save to storage right now. Please try again in a moment." }, 500);
      }
      return json({ ok: true });
    }

    // /api/creator/sync/save-tracking  (POST)  { creatorName, creatorKey,
    // watchHistory, continueWatching, fullyWatchedShowIds,
    // dismissedContinueWatching, trackPlayback } -> { ok }
    // The dedicated, lightweight sibling of /api/creator/sync/save for
    // Watch History / Continue Watching tracking data -- split out for the
    // same reason presets were (see save-presets' own comment just below):
    // watchHistory in particular can grow into the thousands of items for
    // an active account (e.g. a bulk "mark as watched" import), and it used
    // to ride along in the same blob as config/collapsedPanels/likedLists,
    // making EVERY routine autosave -- and every single Auto-Track Playback
    // ping (handleSubtitlesTrack, further down this file), which fires on
    // every video play -- re-send and re-process the whole thing. Also read
    // by the Continue Watching cron (checkForNewEpisodes) and
    // fetchAutoTrackedCatalog (what Stremio/wako actually see for the
    // Watch History/Continue Watching catalog rows) -- if this never
    // successfully saves (e.g. it silently failed under the old combined
    // blob's size), those rows show "No items found" even though the
    // browser's own local copy looks complete.
    if (path === "/api/creator/sync/save-tracking" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const auth = await authenticateCreator(body.creatorName, body.creatorKey);
      if (!auth.ok) return json({ ok: false, error: auth.error === "no-kv" ? "no-kv" : "Username or Key is incorrect." });
      const watchlistUpdatedAt = Number(body.watchlistUpdatedAt) || Date.now();
      const blob = {
        watchHistory: Array.isArray(body.watchHistory) ? body.watchHistory : [],
        continueWatching: Array.isArray(body.continueWatching) ? body.continueWatching : [],
        watchlist: Array.isArray(body.watchlist) ? body.watchlist : [],
        watchlistUpdatedAt: watchlistUpdatedAt,
        fullyWatchedShowIds: Array.isArray(body.fullyWatchedShowIds) ? body.fullyWatchedShowIds.map(String) : [],
        dismissedContinueWatching: body.dismissedContinueWatching && typeof body.dismissedContinueWatching === "object" ? body.dismissedContinueWatching : {},
        trackPlayback: typeof body.trackPlayback === "boolean" ? body.trackPlayback : false,
        removeWatchedFromWatchlist: typeof body.removeWatchedFromWatchlist === "boolean" ? body.removeWatchedFromWatchlist : true,
        updatedAt: Date.now(),
      };
      const serialized = JSON.stringify(blob);
      if (serialized.length > 24 * 1024 * 1024) {
        return json({ ok: false, error: "Your Watch History is too large to store (over the 25MB limit)." });
      }
      try {
        await env.CONFIGS.put(`creatorsynctracking:${auth.username}`, serialized);
        if (Array.isArray(body.watchlist)) {
          const wlRaw = await env.CONFIGS.get(`creatorlist:${auth.username}:watchlist`);
          if (wlRaw) {
            try {
              const wlObj = JSON.parse(wlRaw);
              wlObj.items = body.watchlist;
              wlObj.updatedAt = watchlistUpdatedAt;
              await env.CONFIGS.put(`creatorlist:${auth.username}:watchlist`, JSON.stringify(wlObj));
            } catch {}
          }
        }
      } catch (e) {
        return json({ ok: false, error: "Could not save to storage right now. Please try again in a moment." }, 500);
      }
      return json({ ok: true });
    }

    // /api/creator/sync/save-presets  (POST)  { creatorName, creatorKey,
    // presets?, presetsB64? } -> { ok }
    // The dedicated, lightweight sibling of /api/creator/sync/save just for
    // presets -- split out because presets are the one piece of synced
    // state that can genuinely grow large (a TV Channel's "url" is its
    // entire episode list, see collectEntries' comment,
    // 21_client-custom-list-builder.js, and a preset stores a full copy of
    // everything in it), while everything else in the main blob
    // (config/watchHistory/collapsedPanels/etc) changes far more often but
    // stays small. Before this split, EVERY autosave -- not just an
    // explicit "save preset" -- re-sent and re-processed the entire,
    // ever-growing presets payload alongside that small, frequent state,
    // which is what could tip a request over Cloudflare's free-plan 10ms
    // CPU budget (PBKDF2 verification below plus a large JSON parse/
    // stringify) and fail with no useful error. This endpoint only gets
    // called when presets actually change (see schedulePresetsSync,
    // 24_client-backup-restore-presets.js), and does no deep JSON work of
    // its own -- presetsB64 is already gzip-compressed client-side into an
    // opaque string, so storing it here is close to a raw pass-through.
    if (path === "/api/creator/sync/save-presets" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const auth = await authenticateCreator(body.creatorName, body.creatorKey);
      if (!auth.ok) return json({ ok: false, error: auth.error === "no-kv" ? "no-kv" : "Username or Key is incorrect." });
      const presetsBlob = {
        presets: body.presets && typeof body.presets === "object" ? body.presets : {},
        presetsB64: body.presetsB64 || null,
      };
      const serialized = JSON.stringify(presetsBlob);
      if (serialized.length > 24 * 1024 * 1024) {
        return json({ ok: false, error: "Your saved presets are too large to store (over the 25MB limit) \u2014 likely from several TV Channels with a lot of episodes. Try removing an older preset or a large Channel." });
      }
      try {
        await env.CONFIGS.put(`creatorsyncpresets:${auth.username}`, serialized);
      } catch (e) {
        return json({ ok: false, error: "Could not save to storage right now. Please try again in a moment." }, 500);
      }
      return json({ ok: true });
    }

    // /api/creator/sync/save-channels (POST) { creatorName, creatorKey, channels, mergedChannels }
    if (path === "/api/creator/sync/save-channels" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const auth = await authenticateCreator(body.creatorName, body.creatorKey);
      if (!auth.ok) return json({ ok: false, error: auth.error === "no-kv" ? "no-kv" : "Username or Key is incorrect." });
      const channelsBlob = {
        channels: body.channels && typeof body.channels === "object" ? body.channels : {},
        mergedChannels: body.mergedChannels && typeof body.mergedChannels === "object" ? body.mergedChannels : {},
        updatedAt: Date.now(),
      };
      const serialized = JSON.stringify(channelsBlob);
      if (serialized.length > 24 * 1024 * 1024) {
        return json({ ok: false, error: "Your saved channels are too large to store (over the 25MB limit)." });
      }
      try {
        await env.CONFIGS.put(`creatorsyncchannels:${auth.username}`, serialized);
      } catch (e) {
        return json({ ok: false, error: "Could not save to storage right now. Please try again in a moment." }, 500);
      }
      return json({ ok: true });
    }

    // /api/creator/sync/load -> { ok, data: blob | null }
    // null specifically (rather than an empty blob) distinguishes "this
    // account has never synced from any device" from "this account synced
    // an empty state" -- the client uses that to decide whether to adopt
    // what's already on this browser and push it up as this account's
    // first save, versus overwriting this browser with what the account
    // already has.
    if (path === "/api/creator/sync/load" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const auth = await authenticateCreator(body.creatorName, body.creatorKey);
      if (!auth.ok) return json({ ok: false, error: auth.error === "no-kv" ? "no-kv" : "Username or Key is incorrect." });
      await ensureTrackingMigrated(env, auth.username);
      const raw = await env.CONFIGS.get(`creatorsync:${auth.username}`);
      let data = null;
      if (raw) {
        try {
          data = JSON.parse(raw);
        } catch {
          data = null;
        }
      }
      // Presets live in their own key now (see save-presets above) -- merge
      // them back in here so the client's loadCreatorSync doesn't need to
      // know or care that this is two KV reads instead of one; it still
      // just reads data.presets/data.presetsB64 exactly like before.
      const presetsRaw = await env.CONFIGS.get(`creatorsyncpresets:${auth.username}`);
      if (presetsRaw) {
        let presetsBlob = null;
        try {
          presetsBlob = JSON.parse(presetsRaw);
        } catch {
          presetsBlob = null;
        }
        if (presetsBlob) {
          if (!data) {
            // Presets exist but nothing else has ever synced for this
            // account -- construct a minimal blob so the client still
            // receives them, rather than treating "no main blob" as "no
            // data at all" and having loadCreatorSync skip straight to
            // pushCreatorSync (which would try to push this browser's
            // state up and never even look at what's already saved).
            data = { config: [], collapsedPanels: {}, likedLists: [], updatedAt: Date.now() };
          }
          data.presets = presetsBlob.presets || {};
          data.presetsB64 = presetsBlob.presetsB64 || null;
        }
      }
      // Channels & merged channels live in their own key -- merge them back in for signed-in sync across browsers.
      const channelsRaw = await env.CONFIGS.get(`creatorsyncchannels:${auth.username}`);
      if (channelsRaw) {
        let channelsBlob = null;
        try {
          channelsBlob = JSON.parse(channelsRaw);
        } catch {
          channelsBlob = null;
        }
        if (channelsBlob) {
          if (!data) {
            data = { config: [], collapsedPanels: {}, likedLists: [], updatedAt: Date.now() };
          }
          data.channels = channelsBlob.channels || {};
          data.mergedChannels = channelsBlob.mergedChannels || {};
        }
      }
      // Tracking data (Watch History/Continue Watching/etc) also lives in
      // its own key now -- see save-tracking's own comment above for why.
      // Same merge pattern as presets: the client's loadCreatorSync still
      // just reads data.watchHistory/data.continueWatching/etc exactly
      // like before, unaware this is a third KV read.
      const trackingRaw = await env.CONFIGS.get(`creatorsynctracking:${auth.username}`);
      if (trackingRaw) {
        let trackingBlob = null;
        try {
          trackingBlob = JSON.parse(trackingRaw);
        } catch {
          trackingBlob = null;
        }
        if (trackingBlob) {
          if (!data) {
            data = { config: [], collapsedPanels: {}, likedLists: [], updatedAt: Date.now() };
          }
          data.watchHistory = Array.isArray(trackingBlob.watchHistory) ? trackingBlob.watchHistory : [];
          data.continueWatching = Array.isArray(trackingBlob.continueWatching) ? trackingBlob.continueWatching : [];
          data.watchlist = Array.isArray(trackingBlob.watchlist) ? trackingBlob.watchlist : [];
          data.watchlistUpdatedAt = Number(trackingBlob.watchlistUpdatedAt) || 0;
          data.fullyWatchedShowIds = Array.isArray(trackingBlob.fullyWatchedShowIds) ? trackingBlob.fullyWatchedShowIds : [];
          data.dismissedContinueWatching = trackingBlob.dismissedContinueWatching && typeof trackingBlob.dismissedContinueWatching === "object" ? trackingBlob.dismissedContinueWatching : {};
          data.trackPlayback = typeof trackingBlob.trackPlayback === "boolean" ? trackingBlob.trackPlayback : false;
          data.removeWatchedFromWatchlist = typeof trackingBlob.removeWatchedFromWatchlist === "boolean" ? trackingBlob.removeWatchedFromWatchlist : true;
        }
      }
      const orderRaw = await env.CONFIGS.get(`creatorlistorder:${auth.username}`);
      if (orderRaw) {
        try {
          const orderBlob = JSON.parse(orderRaw);
          if (Array.isArray(orderBlob.order)) {
            if (!data) data = { config: [], collapsedPanels: {}, likedLists: [], updatedAt: Date.now() };
            data.dashboardListOrder = orderBlob.order;
          }
        } catch {}
      }
      return json({ ok: true, data });
    }

    // /api/creator/sync/like  (POST)  { creatorName, creatorKey, usernameSlug, liked } -> { ok }
    // A narrower sibling of sync/save above, just for the likedLists piece
    // of the blob -- exists because the standalone public list page
    // (/lists/:username/:listname below) has its own tiny like button but
    // no access to the rest of a signed-in creator's state (their current
    // list config, presets, panel layout aren't loaded there, and
    // shouldn't need to be just to record a like). It reads the same
    // Creator Name/Key straight out of localStorage as the builder page
    // does, since both live on the same origin -- if this browser was
    // signed in on the builder, that list page can tell, without any
    // separate login of its own. Read-modify-write against whatever's
    // already saved (or a fresh blob if this account has never synced)
    // rather than requiring the caller to send the full state, unlike
    // sync/save.
    if (path === "/api/creator/sync/like" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const auth = await authenticateCreator(body.creatorName, body.creatorKey);
      if (!auth.ok) return json({ ok: false, error: auth.error === "no-kv" ? "no-kv" : "Username or Key is incorrect." });
      const usernameSlug = String(body.usernameSlug || "").trim();
      if (!usernameSlug) return json({ ok: false, error: "Missing list reference." }, 400);
      const key = `creatorsync:${auth.username}`;
      const raw = await env.CONFIGS.get(key);
      let blob = { config: [], presets: {}, collapsedPanels: {}, likedLists: [], watchHistory: [], continueWatching: [], fullyWatchedShowIds: [], dismissedContinueWatching: {} };
      if (raw) {
        try {
          blob = JSON.parse(raw);
        } catch {
          blob = { config: [], presets: {}, collapsedPanels: {}, likedLists: [], watchHistory: [], continueWatching: [], fullyWatchedShowIds: [], dismissedContinueWatching: {} };
        }
      }
      const set = new Set(Array.isArray(blob.likedLists) ? blob.likedLists : []);
      if (body.liked) set.add(usernameSlug);
      else set.delete(usernameSlug);
      blob.likedLists = [...set];
      blob.updatedAt = Date.now();
      await env.CONFIGS.put(key, JSON.stringify(blob));
      return json({ ok: true });
    }

    // /api/search-published-lists?q=...
    // -> powers the "Search Lists" panel including this Worker's own
    // published Custom Lists -- both anonymously published ones (see
    // /api/publish-list) and public Creator-owned ones (see
    // /api/creator/lists/save) -- alongside the existing mdblist.com/Trakt
    // results. Private Creator lists are filtered out entirely here, per
    // the spec ("Not appear in search or browse pages"). KV's list() only
    // returns keys, not values, so this fetches each candidate's stored
    // data to filter/display by name -- capped at 50 keys per prefix per
    // search to keep this fast even once a lot of lists have been
    // published.
    if (path === "/api/search-published-lists") {
      if (!env || !env.CONFIGS) return json({ ok: true, lists: [] });
      const rawQ = url.searchParams.get("q") || "";
      const q = rawQ.toLowerCase().trim();
      
      // Check if query is targeting My Lists platform lists and extract any username/term
      const isMyListsSentinel = (q === "my lists" || q === "mylists" || q === "my list" || q === "mylist" || q.includes("my list") || q.includes("mylist"));
      const userTerm = q
        .replace(/\bmy\s+lists\b/gi, "")
        .replace(/\bmylists\b/gi, "")
        .replace(/\bmy\s+list\b/gi, "")
        .replace(/\bmylist\b/gi, "")
        .replace(/@+/g, "")
        .trim();

      const isMyListsSearch = isMyListsSentinel || !userTerm;

      try {
        const fetchLimit = isMyListsSearch ? 250 : 80;
        const [anonResult, creatorResult] = await Promise.all([
          env.CONFIGS.list({ prefix: "publishedlist:user:", limit: fetchLimit }),
          env.CONFIGS.list({ prefix: "creatorlist:", limit: fetchLimit }),
        ]);
        const anonCandidates = await Promise.all(
          anonResult.keys.map(async (k) => {
            const raw = await env.CONFIGS.get(k.name);
            if (!raw) return null;
            try {
              const data = JSON.parse(raw);
              if (data.visibility === "private") return null;
              const listSlug = k.name.slice("publishedlist:user:".length);
              const itemCount = (data.items || []).length;
              if (itemCount === 0) return null; // Never display lists with 0 items
              return {
                name: data.name,
                type: data.type,
                items: itemCount,
                likes: data.likes || 0,
                creatorName: "Anonymous",
                username: "user",
                url: `${url.origin}/lists/user/${listSlug}`,
              };
            } catch {
              return null;
            }
          })
        );
        const creatorCandidates = await Promise.all(
          creatorResult.keys.map(async (k) => {
            const raw = await env.CONFIGS.get(k.name);
            if (!raw) return null;
            try {
              const data = JSON.parse(raw);
              if (data.visibility === "private") return null;
              const itemCount = (data.items || []).length;
              if (itemCount === 0) return null; // Never display lists with 0 items
              // key shape is creatorlist:{username}:{slug}
              const rest = k.name.slice("creatorlist:".length);
              const sep = rest.indexOf(":");
              if (sep === -1) return null;
              const username = rest.slice(0, sep);
              const listSlug = rest.slice(sep + 1);
              let creatorName = username;
              try {
                const profileRaw = await env.CONFIGS.get(`creator:${username}`);
                if (profileRaw) creatorName = JSON.parse(profileRaw).displayName || username;
              } catch {
                // fall back to the raw username slug
              }
              return {
                name: data.name,
                type: data.type,
                items: itemCount,
                likes: data.likes || 0,
                creatorName,
                username,
                url: `${url.origin}/lists/${username}/${listSlug}`,
              };
            } catch {
              return null;
            }
          })
        );
        const targetFilter = (userTerm || (isMyListsSentinel ? "" : q)).replace(/@+/g, "").trim();
        const matches = [...anonCandidates, ...creatorCandidates]
          .filter(Boolean)
          .filter((l) => (l.items || 0) > 0)
          .filter((l) => {
            if (!targetFilter) return true;
            const nameMatch = l.name && l.name.toLowerCase().includes(targetFilter);
            const creatorMatch = l.creatorName && l.creatorName.toLowerCase().includes(targetFilter);
            const usernameMatch = l.username && l.username.toLowerCase().includes(targetFilter);
            const urlMatch = l.url && l.url.toLowerCase().includes(targetFilter);
            return nameMatch || creatorMatch || usernameMatch || urlMatch;
          })
          .sort((a, b) => (b.likes || 0) - (a.likes || 0));
        return json({ ok: true, lists: isMyListsSearch ? matches : matches.slice(0, 50) });
      } catch (err) {
        return json({ ok: false, error: String(err.message || err) });
      }
    }

    // /lists/:username/:listname[.json]  (GET)
    // -> the public, shareable page/feed for a Custom List -- either
    // published anonymously (/api/publish-list, always under the literal
    // "user" namespace) or owned by a Creator Profile (/api/creator/lists/
    // save, under that creator's own username). A browser gets a small
    // landing page; the .json variant (or anything that isn't a browser
    // navigation -- see isBrowserNavigation) gets the raw list data.
    // Either way this reads straight from KV; it never round-trips through
    // fetchCatalog itself (that's only for *other* configs pointing at
    // Clean external list paths: /lists/mdblist/:user/:slug, /lists/trakt/:user/:slug, /lists/tmdb/:id
    m = path.match(/^\/lists\/mdblist\/([^/]+)\/([^/]+)(?:\.json)?$/i);
    if (m) {
      const mdblistUser = m[1];
      const mdblistSlug = m[2];
      const targetUrl = `https://mdblist.com/lists/${mdblistUser}/${mdblistSlug}`;
      ctx.waitUntil(bumpStat(env, "pageviews"));
      return new Response(
        renderBuilder(url.origin, {
          deepLinkList: {
            name: deslugifyServer(mdblistSlug),
            type: "movie",
            url: targetUrl,
            creatorName: mdblistUser,
            maybeMore: true,
          },
        }),
        {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            ...corsHeaders(),
          },
        }
      );
    }

    m = path.match(/^\/lists\/trakt\/([^/]+)\/([^/]+)(?:\.json)?$/i);
    if (m) {
      const traktUser = m[1];
      const traktSlug = m[2];
      const targetUrl = `https://trakt.tv/users/${traktUser}/lists/${traktSlug}`;
      ctx.waitUntil(bumpStat(env, "pageviews"));
      return new Response(
        renderBuilder(url.origin, {
          deepLinkList: {
            name: deslugifyServer(traktSlug),
            type: "movie",
            url: targetUrl,
            creatorName: traktUser,
            maybeMore: true,
          },
        }),
        {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            ...corsHeaders(),
          },
        }
      );
    }

    m = path.match(/^\/lists\/tmdb\/collection\/([0-9]+)(?:-([a-z0-9_-]+))?(?:\.json)?$/i);
    if (m) {
      const tmdbId = m[1];
      const targetUrl = `https://www.themoviedb.org/collection/${tmdbId}`;
      const name = m[2] ? deslugifyServer(m[2]) : `TMDB Collection ${tmdbId}`;
      ctx.waitUntil(bumpStat(env, "pageviews"));
      return new Response(
        renderBuilder(url.origin, {
          deepLinkList: {
            name,
            type: "movie",
            url: targetUrl,
            creatorName: "TMDB",
            maybeMore: true,
          },
        }),
        {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            ...corsHeaders(),
          },
        }
      );
    }

    m = path.match(/^\/lists\/tmdb\/([0-9]+)(?:-([a-z0-9_-]+))?(?:\.json)?$/i);
    if (m) {
      const tmdbId = m[1];
      const targetUrl = `https://www.themoviedb.org/list/${tmdbId}`;
      const name = m[2] ? deslugifyServer(m[2]) : `TMDB List ${tmdbId}`;
      ctx.waitUntil(bumpStat(env, "pageviews"));
      return new Response(
        renderBuilder(url.origin, {
          deepLinkList: {
            name,
            type: "movie",
            url: targetUrl,
            creatorName: "TMDB",
            maybeMore: true,
          },
        }),
        {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            ...corsHeaders(),
          },
        }
      );
    }

    m = path.match(/^\/lists\/([^/]+)\/([^/]+?)(?:\.json)?$/i);
    if (m) {
      let rawUser = m[1];
      let rawList = m[2];
      let decodedUser = rawUser;
      let decodedList = rawList;
      try {
        decodedUser = decodeURIComponent(rawUser);
        decodedList = decodeURIComponent(rawList);
      } catch {}
      const username = decodedUser.toLowerCase();
      const listName = decodedList.toLowerCase();
      if (!env || !env.CONFIGS) {
        return json({ ok: false, error: "This Worker has no CONFIGS KV namespace bound, so nothing is published here." }, 404);
      }
      let listData = null;
      let isCreatorList = false;
      const keysToTry = [
        `creatorlist:${username}:${listName}`,
        `creatorlist:${rawUser}:${rawList}`,
        `publishedlist:${username}:${listName}`,
        `publishedlist:${rawUser}:${rawList}`,
      ];
      for (const k of keysToTry) {
        if (listData) break;
        const raw = await env.CONFIGS.get(k);
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.visibility !== "private") {
              listData = parsed;
              isCreatorList = k.startsWith("creatorlist:");
            }
          } catch {}
        }
      }
      if (listName === "watchlist" || listName === "watch-history" || listName === "continue-watching") {
        const trackingRaw = await env.CONFIGS.get(`creatorsynctracking:${username}`);
        if (trackingRaw) {
          try {
            const tracking = JSON.parse(trackingRaw);
            const items = tracking[listName === "watch-history" ? "watchHistory" : (listName === "continue-watching" ? "continueWatching" : "watchlist")] || [];
            if (Array.isArray(items)) {
              if (!listData && items.length > 0) {
                listData = {
                  name: listName === "watch-history" ? "Watch History" : (listName === "continue-watching" ? "Continue Watching" : "Watchlist"),
                  slug: listName,
                  type: "mixed",
                  visibility: "public",
                  items: items,
                  updatedAt: tracking.updatedAt || Date.now()
                };
                isCreatorList = true;
              } else if (listData && Array.isArray(items) && items.length > 0 && (!listData.items || listData.items.length === 0)) {
                listData.items = items;
              }
            }
          } catch {}
        }
      }
      if (!listData) {
        return json({ ok: false, error: "No list found at that address." }, 404);
      }
      let creatorDisplayName = "Anonymous";
      if (isCreatorList) {
        creatorDisplayName = username;
        try {
          const profileRaw = await env.CONFIGS.get(`creator:${username}`);
          if (profileRaw) creatorDisplayName = JSON.parse(profileRaw).displayName || username;
        } catch {
          // fall back to the raw username slug
        }
      }
      const likes = listData.likes || 0;
      const wantsJson = path.endsWith(".json") || (request.headers.get("Accept") || "").includes("application/json") || !isBrowserNavigation(request);
      if (wantsJson) {
        const cleanItems = (listData.items || []).map((it) => {
          const itId = it.imdbId || (String(it.id || '').startsWith('tt') ? it.id : (it.id ? ('tt' + it.id) : ''));
          let poster = it.poster || it.showPoster || "";
          if (!poster && itId && itId.startsWith("tt")) {
            poster = `https://images.metahub.space/poster/medium/${itId}/img`;
          }
          const itemTitle = it.name || it.title || '';
          const itemType = it.type || (it.showId ? 'series' : (listData.type === 'mixed' ? 'movie' : (listData.type || 'movie')));
          return {
            id: itId || it.id,
            imdb_id: it.imdbId || (String(it.id || '').startsWith('tt') ? it.id : null),
            imdbId: it.imdbId || (String(it.id || '').startsWith('tt') ? it.id : null),
            tmdb_id: it.tmdbId || it.tmdb_id || null,
            tmdbId: it.tmdbId || it.tmdb_id || null,
            title: itemTitle,
            name: itemTitle,
            year: it.year || null,
            type: itemType,
            poster: poster || null,
            overview: it.overview || null,
            genres: it.genres || null,
            rating: it.rating || null
          };
        });

        // If client specifically requests format=object or format=meta
        if (url.searchParams.get("format") === "object" || url.searchParams.get("meta") === "1") {
          return json({
            ok: true,
            name: listData.name,
            slug: listName,
            creator: creatorDisplayName,
            type: listData.type,
            visibility: "public",
            itemCount: cleanItems.length,
            likes: likes,
            updatedAt: listData.updatedAt || listData.createdAt || null,
            url: `${url.origin}/lists/${username}/${listName}`,
            jsonUrl: `${url.origin}/lists/${username}/${listName}.json`,
            items: cleanItems
          }, 200, { "Cache-Control": "public, max-age=300", ...corsHeaders() });
        }

        // Standard JSON Array for Cinephage, Kometa, Jellyfin, and external list scrapers
        return json(cleanItems, 200, { "Cache-Control": "public, max-age=300", ...corsHeaders() });
      }
      ctx.waitUntil(bumpStat(env, "pageviews"));
      const shareUrl = `${url.origin}/lists/${username}/${listName}`;
      return new Response(
        renderBuilder(url.origin, {
          deepLinkList: {
            name: listData.name,
            type: listData.type,
            url: shareUrl,
            creatorName: creatorDisplayName,
            likes: likes,
            sample: (listData.items || []).map((it) => {
              const itId = it.imdbId || (String(it.id || '').startsWith('tt') ? it.id : (it.id ? `tt${it.id}` : ''));
              let poster = it.poster || it.showPoster || "";
              if (!poster && itId && itId.startsWith("tt")) {
                poster = `https://images.metahub.space/poster/medium/${itId}/img`;
              }
              return {
                id: itId || (it.tmdb_id ? String(it.tmdb_id) : String(it.id || "")),
                name: it.title || it.name || "Item",
                poster: poster,
                year: it.year || it.releaseInfo || "",
                type: it.type || listData.type || "movie",
              };
            }),
            maybeMore: false,
          },
        }),
        {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            ...corsHeaders(),
          },
        }
      );
    }

    // --- Admin dashboard (page views / install links generated) -----------
    //
    // Locked behind ADMIN_KEY, a secret set via `wrangler secret put
    // ADMIN_KEY` (or the Cloudflare dashboard) -- never lives in this file.
    // A correct key gets a signed, HttpOnly, Secure, SameSite=Strict cookie
    // scoped to /admin (see makeAdminCookieValue/isValidAdminCookie above),
    // not a bare ?key=... in the URL that would sit around in browser
    // history/logs.
    if (path === "/admin" && request.method === "GET") {

      const authed = await isAdminRequest(request, env);
      if (!authed) {
        return new Response(renderAdminLoginPage(), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
      }
      const html = await renderAdminDashboard(env);
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    }

    // /admin/api/leaderboard?type=watched|list-add&window=today|7|30|90|alltime&mediaType=movie|series
    // -> { ok, entries } -- backs the Trending Data tab's dropdown, computed
    // on demand rather than eagerly for every window/type combo on every
    // page load (see computeLeaderboard's own comment on why this can fan
    // out to a meaningful number of KV reads). mediaType is optional --
    // omitted or anything else means both movies and shows together.
    if (path === "/admin/api/leaderboard" && request.method === "GET") {
      const authed = await isAdminRequest(request, env);
      if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
      const eventType = url.searchParams.get("type") === "list-add" ? "list-add" : "watched";
      const allowedWindows = new Set(["today", "7", "30", "90", "alltime"]);
      const window = allowedWindows.has(url.searchParams.get("window")) ? url.searchParams.get("window") : "7";
      const mediaTypeParam = url.searchParams.get("mediaType");
      const mediaType = mediaTypeParam === "movie" || mediaTypeParam === "series" ? mediaTypeParam : null;
      const entries = await computeLeaderboard(env, eventType, window, mediaType);
      // no-store -- json()'s own default (max-age=3600) would otherwise
      // have the browser silently reuse an hour-old leaderboard on the
      // next tab switch/refresh instead of hitting the network again (see
      // /admin/api/feedback's own comment, which is where this was first
      // caught).
      return json({ ok: true, entries }, 200, { "Cache-Control": "no-store" });
    }

    // /admin/api/backfill-trending  (POST) -> { ok, done, accountsThisCall, titlesThisCall }
    // Seeds the All Time trending leaderboards (see backfillTitleCount's
    // own comment on why all-time-only) from data that already existed
    // before trending tracking shipped -- each creator account's Watch
    // History (aggregated to distinct shows/movies, dedupe-by-showId same
    // as the live tracking does) and their own Custom Lists' current
    // items. Processes exactly one account per call, capped to a handful
    // of titles from each source, to stay comfortably under Cloudflare's
    // per-request subrequest limit -- the admin dashboard's "Backfill
    // Existing Data" button calls this repeatedly until it reports
    // done:true, so this only needs to make forward progress each call,
    // not finish everything at once. Resumes via a cursor stored at
    // backfilltrending:cursor (same list()-cursor pattern
    // checkForNewEpisodes already uses for its own account sweep);
    // starting the sweep over from the top once every account has been
    // visited is intentional, so an account created after the last full
    // pass eventually gets covered too, and running this again later
    // picks up anyone whose history grew since the first pass -- entries
    // just accumulate (each backfill run adds its own snapshot on top of
    // whatever's already there, same as any other watch/list-add event
    // would), it doesn't overwrite.
    if (path === "/admin/api/backfill-trending" && request.method === "POST") {
      const authed = await isAdminRequest(request, env);
      if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
      if (!env || !env.CONFIGS) return json({ ok: true, done: true, accountsThisCall: 0, titlesThisCall: 0 });

      const WATCHED_TITLE_CAP = 6;
      const LIST_ITEM_CAP = 6;

      const cursorRaw = await env.CONFIGS.get("backfilltrending:cursor");
      const listOpts = { prefix: "creator:", limit: 1 };
      if (cursorRaw) listOpts.cursor = cursorRaw;
      const listResult = await env.CONFIGS.list(listOpts);

      if (!listResult.keys.length) {
        // Reached the end of the account list (or there are no accounts
        // at all) -- reset to the top so a later run starts fresh rather
        // than permanently reporting "done" against a stale cursor.
        await env.CONFIGS.put("backfilltrending:cursor", "");
        return json({ ok: true, done: true, accountsThisCall: 0, titlesThisCall: 0 });
      }
      await env.CONFIGS.put("backfilltrending:cursor", listResult.list_complete ? "" : (listResult.cursor || ""));

      const username = listResult.keys[0].name.slice("creator:".length);
      let titlesThisCall = 0;

      // Watch History -> "watched", aggregated to distinct shows/movies
      // (episodes collapse to their show, same as live tracking).
      try {
        const trackingRaw = await env.CONFIGS.get(`creatorsynctracking:${username}`);
        if (trackingRaw) {
          const tracking = JSON.parse(trackingRaw);
          const watchHistory = Array.isArray(tracking.watchHistory) ? tracking.watchHistory : [];
          const counts = new Map(); // id -> { title, mediaType, count }
          watchHistory.forEach((it) => {
            const id = it.showId || it.id;
            if (!id) return;
            const title = it.showTitle || it.name || "";
            const mediaType = it.type === "movie" ? "movie" : "series";
            const existing = counts.get(id);
            if (existing) existing.count++;
            else counts.set(id, { title, mediaType, count: 1 });
          });
          const topTitles = [...counts.entries()].slice(0, WATCHED_TITLE_CAP);
          for (const [id, info] of topTitles) {
            const ok = await backfillTitleCount(env, "watched", id, info.title, info.mediaType, info.count);
            if (ok) titlesThisCall++;
          }
        }
      } catch (e) {
        // Skip this account's Watch History on any read/parse error --
        // still worth trying its Custom Lists below, and the account
        // will simply be revisited on a future full pass.
      }

      // Custom Lists -> "list-add", using each list's current items
      // (there's no historical "added at" timestamp to work from, only
      // present membership -- see this endpoint's own comment on why
      // that's fine for an all-time-only count). Lists directly, by this
      // account's own creatorlist: prefix, rather than going through
      // creatorlistorder:{username} (which tracks display order for
      // reordering specifically, not guaranteed to be a complete
      // inventory of every list the account has).
      try {
        const listsResult = await env.CONFIGS.list({ prefix: `creatorlist:${username}:`, limit: 20 });
        let itemsSeen = 0;
        for (const listKey of listsResult.keys) {
          if (itemsSeen >= LIST_ITEM_CAP) break;
          const listRaw = await env.CONFIGS.get(listKey.name);
          if (!listRaw) continue;
          const list = JSON.parse(listRaw);
          const items = Array.isArray(list.items) ? list.items : [];
          for (const it of items) {
            if (itemsSeen >= LIST_ITEM_CAP) break;
            const id = it.imdbId || it.id;
            if (!id) continue;
            const ok = await backfillTitleCount(env, "list-add", id, it.title || it.name || "", list.type === "series" ? "series" : "movie", 1);
            if (ok) titlesThisCall++;
            itemsSeen++;
          }
        }
      } catch (e) {
        // Skip this account's Custom Lists on any read/parse error.
      }

      return json({ ok: true, done: false, accountsThisCall: 1, titlesThisCall, username });
    }

    // /admin/api/feedback -> { ok, entries } -- backs the Feedback tab,
    // newest first. Reads up to 300 entries; feedback keys already sort
    // chronologically as plain strings (see /api/feedback's own comment),
    // so list() naturally returns oldest-first and this just reverses it.
    if (path === "/admin/api/feedback" && request.method === "GET") {
      const authed = await isAdminRequest(request, env);
      if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
      if (!env || !env.CONFIGS) return json({ ok: true, entries: [] }, 200, { "Cache-Control": "no-store" });
      let allKeys = [];
      let cursor = undefined;
      let listComplete = false;
      while (!listComplete) {
        const listResult = await env.CONFIGS.list({ prefix: "feedback:", limit: 1000, cursor });
        allKeys.push(...listResult.keys);
        if (listResult.list_complete || !listResult.cursor) {
          listComplete = true;
        } else {
          cursor = listResult.cursor;
        }
      }
      const keys = allKeys.slice().reverse();
      const entries = await Promise.all(
        keys.map(async (k) => {
          try {
            const raw = await env.CONFIGS.get(k.name);
            return raw ? JSON.parse(raw) : null;
          } catch {
            return null;
          }
        })
      );
      return json({ ok: true, entries: entries.filter(Boolean), truncated: false }, 200, { "Cache-Control": "no-store" });
    }

    // /admin/api/feedback/status  (POST)  { id, completed } -> { ok }
    // Toggles the "completed" flag on one feedback entry -- id here is the
    // entry's own id field (the part of the KV key after "feedback:"), not
    // the full key name, so the client never needs to know the storage
    // layout to mark something done.
    if (path === "/admin/api/feedback/status" && request.method === "POST") {
      const authed = await isAdminRequest(request, env);
      if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
      if (!env || !env.CONFIGS) return json({ ok: false, error: "Feedback storage isn't configured on this deployment." });
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const id = String(body.id || "").trim();
      if (!id) return json({ ok: false, error: "Missing id." }, 400);
      const key = `feedback:${id}`;
      const raw = await env.CONFIGS.get(key);
      if (!raw) return json({ ok: false, error: "That feedback entry no longer exists." }, 404);
      let entry;
      try {
        entry = JSON.parse(raw);
      } catch {
        return json({ ok: false, error: "Could not read that feedback entry." }, 500);
      }
      entry.completed = !!body.completed;
      try {
        await env.CONFIGS.put(key, JSON.stringify(entry));
      } catch (e) {
        return json({ ok: false, error: "Could not save that change. Please try again." }, 500);
      }
      return json({ ok: true }, 200, { "Cache-Control": "no-store" });
    }

    // /admin/api/feedback/edit  (POST)  { id, message, category } -> { ok, entry }
    // Allows the admin to edit the message or category of any feedback entry.
    if (path === "/admin/api/feedback/edit" && request.method === "POST") {
      const authed = await isAdminRequest(request, env);
      if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
      if (!env || !env.CONFIGS) return json({ ok: false, error: "Feedback storage isn't configured on this deployment." });
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const id = String(body.id || "").trim();
      if (!id) return json({ ok: false, error: "Missing id." }, 400);
      const key = `feedback:${id}`;
      const raw = await env.CONFIGS.get(key);
      if (!raw) return json({ ok: false, error: "That feedback entry no longer exists." }, 404);
      let entry;
      try {
        entry = JSON.parse(raw);
      } catch {
        return json({ ok: false, error: "Could not read that feedback entry." }, 500);
      }
      if (typeof body.message === "string" && body.message.trim()) {
        entry.message = body.message.trim().slice(0, 4000);
      }
      if (typeof body.category === "string" && ["bug", "improvement", "idea", "other"].includes(body.category.trim())) {
        entry.category = body.category.trim();
      }
      entry.updatedAt = Date.now();
      try {
        await env.CONFIGS.put(key, JSON.stringify(entry));
        return json({ ok: true, entry }, 200, { "Cache-Control": "no-store" });
      } catch (e) {
        return json({ ok: false, error: "Could not save edits. Please try again." }, 500);
      }
    }

    // /admin/api/feedback/delete (POST) { id } -> { ok }
    // Allows the admin to permanently delete a feedback entry from KV storage.
    if (path === "/admin/api/feedback/delete" && request.method === "POST") {
      const authed = await isAdminRequest(request, env);
      if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
      if (!env || !env.CONFIGS) return json({ ok: false, error: "Feedback storage isn't configured on this deployment." });
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const id = String(body.id || "").trim();
      if (!id) return json({ ok: false, error: "Missing id." }, 400);
      const key = `feedback:${id}`;
      try {
        await env.CONFIGS.delete(key);
        return json({ ok: true }, 200, { "Cache-Control": "no-store" });
      } catch (e) {
        return json({ ok: false, error: "Could not delete feedback entry. Please try again." }, 500);
      }
    }

    // /admin/api/analytics?section=search|catalogs_lists|audience&window=...
    // Backs the Search, Catalogs & Lists, and Playback & Audience tabs in the admin dashboard.
    if (path === "/admin/api/analytics" && request.method === "GET") {
      const authed = await isAdminRequest(request, env);
      if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
      const section = url.searchParams.get("section") || "search";
      if (section === "search") {
        const windowParam = url.searchParams.get("window") || "7";
        const searches = await computeSearchLeaderboard(env, windowParam);
        return json({ ok: true, searches }, 200, { "Cache-Control": "no-store" });
      }
      if (section === "catalogs_lists") {
        const data = await computeCatalogAndCommunityLeaderboards(env);
        return json({ ok: true, ...data }, 200, { "Cache-Control": "no-store" });
      }
      if (section === "audience") {
        const data = await computeAudienceAnalytics(env);
        return json({ ok: true, ...data }, 200, { "Cache-Control": "no-store" });
      }
      return json({ ok: false, error: "Invalid section." }, 400);
    }

    // /admin/api/apiusage -> { ok, keys: [{ name, label, configured, last24h,
    // last7d, last30d, limit }] } -- backs the API Usage tab. Only counts
    // requests that used one of this Worker's own shared keys (the
    // fallback used when a visitor hasn't supplied a personal one, see
    // trackSharedApiUse in 05_catalog-core.js and its call sites) -- a
    // visitor's own key is never counted here since only they can exhaust
    // its rate limit. Day-bucketed the same way as every other stat in
    // this file (see bumpStat/loadStatsByDay), so "last 24h" really means
    // "today's Eastern-calendar-day bucket", same as the Trending tab's
    // "Today" window.
    if (path === "/admin/api/apiusage" && request.method === "GET") {
      const authed = await isAdminRequest(request, env);
      if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
      const defs = [
        { name: "tmdb", label: "TMDB (TMDB_API_KEY)", envVar: "TMDB_API_KEY", limit: "~40 req/sec per IP -- no published daily cap" },
        { name: "trakt", label: "Trakt (TRAKT_CLIENT_ID)", envVar: "TRAKT_CLIENT_ID", limit: "1,000 GET calls / 5 min" },
        { name: "simkl", label: "Simkl (SIMKL_CLIENT_ID)", envVar: "SIMKL_CLIENT_ID", limit: "10 req/sec (GET)" },
        { name: "mdblist", label: "MDBList (MDBLIST_API_KEY)", envVar: "MDBLIST_API_KEY", limit: "1,000/day (free tier -- higher on paid plans)" },
        { name: "mdblistpopular", label: "MDBList Popular Lists (MDBLIST_POPULAR_KEY)", envVar: "MDBLIST_POPULAR_KEY", limit: "1,000/day (free tier -- higher on paid plans)" },
      ];
      const nowMs = Date.now();
      const keys = await Promise.all(defs.map(async (d) => {
        const byDay = await loadStatsByDay(env, `apiuse:${d.name}`);
        let last24h = 0, last7d = 0, last30d = 0;
        for (let i = 0; i < 30; i++) {
          const count = byDay[easternDateKey(new Date(nowMs - i * 86400000))] || 0;
          if (i < 1) last24h += count;
          if (i < 7) last7d += count;
          last30d += count;
        }
        return { name: d.name, label: d.label, configured: !!(env && env[d.envVar]), last24h, last7d, last30d, limit: d.limit };
      }));
      // no-store -- see /admin/api/feedback's own comment on why every
      // admin JSON endpoint needs this (json()'s default lets the browser
      // silently reuse an hour-old response instead of refetching).
      return json({ ok: true, keys }, 200, { "Cache-Control": "no-store" });
    }

    // /admin/api/netflix-preview?region=US&providerId=8 -> { ok, region,
    // providerId, movies: { total, items }, shows: { total, items } } --
    // lets the admin see roughly how big a TMDB-discover-based shelf for
    // ANY watch provider would be, and what it'd actually contain, before
    // wiring a tmdb:chart:X entry into Quick Add for real. providerId
    // defaults to 8 (Netflix) but accepts any TMDB provider id -- pair
    // this with /admin/api/provider-lookup below to find the right id for
    // a given service by name first, since TMDB is known to have more
    // than one entry for some providers (e.g. two separate "Disney Plus"
    // ids) and guessing wrong fails silently -- it just quietly shows the
    // wrong catalog under the right label. Deliberately NOT the same code
    // path as a real catalog fetch (fetchTmdbChart/fetchTmdbPagedResults)
    // -- this only needs TMDB's own title/poster/total_results for a
    // quick look, not a resolved IMDb id per item (that's a separate TMDB
    // call per title, and this is meant to be a cheap one-shot preview,
    // not something that has to walk the whole list).
    async function fetchNetflixPreviewTmdb(kind, region, apiKey, providerId) {
      const src = `https://api.themoviedb.org/3/discover/${kind}?api_key=${encodeURIComponent(apiKey)}` +
        `&with_watch_providers=${encodeURIComponent(providerId)}&watch_region=${encodeURIComponent(region)}` +
        `&with_watch_monetization_types=flatrate&sort_by=popularity.desc&page=1`;
      const res = await fetch(src, {
        headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
        cf: { cacheTtl: 3600, cacheEverything: true },
      });
      if (!res.ok) throw new Error(`TMDB request failed (HTTP ${res.status}).`);
      const data = await res.json();
      const items = (data.results || []).slice(0, 24).map((it) => ({
        id: it.id,
        title: it.title || it.name || "Untitled",
        poster: it.poster_path ? `https://image.tmdb.org/t/p/w300${it.poster_path}` : null,
        date: (it.release_date || it.first_air_date || "").slice(0, 4),
      }));
      return { total: data.total_results || 0, items };
    }

    if (path === "/admin/api/netflix-preview" && request.method === "GET") {
      const authed = await isAdminRequest(request, env);
      if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
      if (!TMDB_API_KEY) return json({ ok: false, error: "TMDB_API_KEY isn't configured on this Worker." });
      // Same normalization TMDB itself expects -- just the two-letter
      // country code, not a locale like "en-US".
      const region = (url.searchParams.get("region") || "US").trim().toUpperCase().slice(0, 2) || "US";
      const providerIdParam = (url.searchParams.get("providerId") || "8").trim();
      const providerId = /^\d+$/.test(providerIdParam) ? providerIdParam : "8";
      try {
        const [movies, shows] = await Promise.all([
          fetchNetflixPreviewTmdb("movie", region, TMDB_API_KEY, providerId),
          fetchNetflixPreviewTmdb("tv", region, TMDB_API_KEY, providerId),
        ]);
        // Always the shared key -- 2 TMDB calls per preview load.
        ctx.waitUntil(bumpStatBy(env, "apiuse:tmdb", 2));
        return json({ ok: true, region, providerId, movies, shows }, 200, { "Cache-Control": "no-store" });
      } catch (err) {
        return json({ ok: false, error: String(err.message || err) });
      }
    }

    // /admin/api/provider-lookup?query=disney&region=US -> { ok, results:
    // [{ id, name }] } -- pulls TMDB's own official watch-provider list
    // (the actual source of truth /admin/api/netflix-preview's providerId
    // gets checked against) so a provider's real numeric id can be
    // confirmed by name before it's wired into anything. Queries both the
    // movie and tv provider lists and merges them, since a given service's
    // presence can differ slightly between the two; de-duplicated by id
    // and, when a region is given, ordered by that region's own
    // display_priority (TMDB's closest thing to "which of these is the
    // one people actually mean" -- relevant since some providers, like
    // Disney Plus, have more than one id and only one is the one that
    // actually turns up in region-filtered discover results).
    if (path === "/admin/api/provider-lookup" && request.method === "GET") {
      const authed = await isAdminRequest(request, env);
      if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
      if (!TMDB_API_KEY) return json({ ok: false, error: "TMDB_API_KEY isn't configured on this Worker." });
      const region = (url.searchParams.get("region") || "US").trim().toUpperCase().slice(0, 2) || "US";
      const query = (url.searchParams.get("query") || "").trim().toLowerCase();
      try {
        const [movieRes, tvRes] = await Promise.all([
          fetch(`https://api.themoviedb.org/3/watch/providers/movie?api_key=${encodeURIComponent(TMDB_API_KEY)}&watch_region=${encodeURIComponent(region)}`, {
            headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
            cf: { cacheTtl: 86400, cacheEverything: true },
          }),
          fetch(`https://api.themoviedb.org/3/watch/providers/tv?api_key=${encodeURIComponent(TMDB_API_KEY)}&watch_region=${encodeURIComponent(region)}`, {
            headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
            cf: { cacheTtl: 86400, cacheEverything: true },
          }),
        ]);
        if (!movieRes.ok || !tvRes.ok) throw new Error("TMDB request failed.");
        const [movieData, tvData] = await Promise.all([movieRes.json(), tvRes.json()]);
        ctx.waitUntil(bumpStatBy(env, "apiuse:tmdb", 2));

        const byId = new Map();
        [...(movieData.results || []), ...(tvData.results || [])].forEach((p) => {
          if (byId.has(p.provider_id)) return;
          const priorities = p.display_priorities || {};
          const priority = priorities[region] != null ? priorities[region] : (p.display_priority != null ? p.display_priority : 9999);
          byId.set(p.provider_id, { id: p.provider_id, name: p.provider_name, priority });
        });
        let results = [...byId.values()];
        if (query) results = results.filter((p) => p.name.toLowerCase().includes(query));
        results.sort((a, b) => a.priority - b.priority);
        results = results.slice(0, 40).map((p) => ({ id: p.id, name: p.name }));
        return json({ ok: true, results }, 200, { "Cache-Control": "no-store" });
      } catch (err) {
        return json({ ok: false, error: String(err.message || err) });
      }
    }

    if (path === "/admin/login" && request.method === "POST") {
      if (!env || !env.ADMIN_KEY) {
        return new Response(
          renderAdminLoginPage("This Worker has no ADMIN_KEY secret set -- run `wrangler secret put ADMIN_KEY` (or set it in the Cloudflare dashboard) first."),
          { status: 500, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
        );
      }
      let submittedKey = "";
      try {
        const form = await request.formData();
        submittedKey = String(form.get("key") || "");
      } catch {
        // falls through with an empty key, which will fail the compare below
      }
      if (!timingSafeEqualHex(submittedKey, env.ADMIN_KEY)) {
        return new Response(renderAdminLoginPage("Incorrect key."), {
          status: 401,
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
      const cookieValue = await makeAdminCookieValue(env);
      return new Response(null, {
        status: 302,
        headers: {
          "Location": "/admin",
          // Path=/ (not /admin) -- this cookie needs to ride along on
          // fetch() calls the admin dashboard makes to endpoints outside
          // /admin too, e.g. /api/feedback for "Log something yourself"
          // (see isAdminRequest's call there). A browser withholds a
          // cookie entirely from any request whose path doesn't fall
          // under Path, silently, with no error surfaced anywhere --
          // isAdminRequest just always saw no cookie and treated every
          // one of those requests as anonymous, which is what made the
          // public rate limit apply to admin submissions too.
          "Set-Cookie": `${ADMIN_COOKIE_NAME}=${cookieValue}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(ADMIN_SESSION_MS / 1000)}`,
        },
      });
    }

    if (path === "/admin/logout") {
      return new Response(null, {
        status: 302,
        headers: {
          "Location": "/admin",
          // Path must match the cookie's own Path exactly for this to
          // actually clear it -- a Set-Cookie with a different Path is
          // treated as a distinct cookie, not an overwrite of the
          // original.
          "Set-Cookie": `${ADMIN_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
        },
      });
    }

    // /api/bulk-resolve
    // Resolves an array of {title, year} objects to TMDB/IMDB IDs
    // Used by the Letterboxd CSV import
    if (path === "/api/bulk-resolve" && request.method === "POST") {
      try {
        const body = await request.json();
        const items = body.items || [];
        const resolved = [];
        // Always the shared TMDB_API_KEY -- no per-user override on this
        // endpoint. Counted precisely (not just items.length) since a
        // search miss skips the second (external-ids) call.
        let tmdbCallCount = 0;
        // Process in small batches (e.g., 10 at a time) to stay within subrequest limits
        const BATCH_SIZE = 10;
        for (let i = 0; i < items.length; i += BATCH_SIZE) {
          const batch = items.slice(i, i + BATCH_SIZE);
          const promises = batch.map(async (item) => {
            const q = (item.title || "").trim();
            const y = item.year ? parseInt(item.year, 10) : null;
            if (!q) return null;
            
            // Step 1: Search TMDB
            const searchSrc = `https://api.themoviedb.org/3/search/movie?api_key=${encodeURIComponent(TMDB_API_KEY)}&query=${encodeURIComponent(q)}&include_adult=false${y ? '&primary_release_year=' + y : ''}`;
            tmdbCallCount++;
            const searchRes = await fetch(searchSrc, {
              headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
              cf: { cacheTtl: 86400, cacheEverything: true },
            });
            if (!searchRes.ok) return null;
            const searchData = await searchRes.json();
            const match = (searchData.results || [])[0];
            if (!match) return null;
            
            // Step 2: Get External IDs to find IMDB id
            const extSrc = `https://api.themoviedb.org/3/movie/${match.id}/external_ids?api_key=${encodeURIComponent(TMDB_API_KEY)}`;
            tmdbCallCount++;
            const extRes = await fetch(extSrc, {
              headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
              cf: { cacheTtl: 86400, cacheEverything: true },
            });
            if (!extRes.ok) return null;
            const extData = await extRes.json();
            
            if (extData.imdb_id) {
              return {
                title: match.title || match.original_title || item.title,
                year: match.release_date ? match.release_date.substring(0, 4) : item.year,
                imdbId: extData.imdb_id,
              };
            }
            return null;
          });
          
          const results = await Promise.all(promises);
          for (const res of results) {
            if (res) resolved.push(res);
          }
        }
        if (tmdbCallCount) ctx.waitUntil(bumpStatBy(env, "apiuse:tmdb", tmdbCallCount));
        return json({ ok: true, resolved });
      } catch (e) {
        return json({ ok: false, error: String(e) }, 500);
      }
    }

    return new Response("Not found", { status: 404, headers: corsHeaders() });
}

// The actual Worker export. Delegates to handleFetch (25_api-catalog-
// routes.js) for everything, then runs the response back through
// withSecurityHeaders (02_http-and-creator-utils.js) before it goes out --
// see handleFetch's own opening comment for why it's split this way.
export default {
  async fetch(request, env, ctx) {
    const response = await handleFetch(request, env, ctx);
    return withSecurityHeaders(response);
  },

  // Runs on whatever schedule this Worker's owner configured under
  // Triggers -> Cron Triggers in the Cloudflare dashboard (recommended:
  // every 6 hours) -- see checkForNewEpisodes (07_source-fetchers-tmdb-
  // simkl.js) for what it actually does and why it's scoped and batched
  // the way it is. ctx.waitUntil keeps the invocation alive until that
  // finishes, the same way a fetch handler would keep a response pending,
  // since a scheduled trigger has no incoming request to hold it open on
  // its own.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkForNewEpisodes(env));
  },
};

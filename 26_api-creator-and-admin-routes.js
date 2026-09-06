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
      // A username being deleted right now stops authenticating, whatever the
      // record says. Two things this catches that the record cannot: a request
      // arriving mid-purge, which would otherwise write its key back after the
      // sweep had passed; and a colo still serving the pre-deletion
      // `creator:{u}` out of KV's read cache, where the record claims the
      // account is alive because that copy is stale. See the tombstone comment
      // in 02_http-and-creator-utils.js.
      //
      // Issued alongside the profile read rather than before it: this is the
      // hottest authenticated path in the Worker (every autosave, every
      // playback ping), and one extra round trip on it is worth avoiding even
      // though the extra read is not.
      const [tombstoned, raw] = await Promise.all([
        isCreatorTombstoned(env, v.normalized),
        getCreator(env, v.normalized),
      ]);
      if (tombstoned) return { ok: false, error: "Username or Key is incorrect." };
      if (!raw) return { ok: false, error: "Username or Key is incorrect." };
      let profile;
      try {
        profile = JSON.parse(raw);
      } catch {
        return { ok: false, error: "Username or Key is incorrect." };
      }
      // Verify against the store that can answer immediately -- see
      // authoritativeKeyHash (02_http-and-creator-utils.js). No-op unless D1
      // is bound.
      const keyHash = await authoritativeKeyHash(env, v.normalized, profile.keyHash);
      // Every verification below runs PBKDF2 at 100,000 iterations, which is
      // ~15ms of CPU, and it runs BEFORE the caller has proved anything at
      // all. /api/creator/restore had a per-IP bucket and a daily failure
      // budget; the fifteen other routes that verify a Creator Key --
      // /api/creator/sync/load, /api/creator/lists/save,
      // /api/scrobble?creator=&key=, all of them -- had neither, so an
      // unauthenticated caller could drive unbounded Worker CPU through any
      // of them, and route around restore's protection for guessing.
      //
      // Gating it HERE rather than at each route is the point: this is the one
      // function every one of them goes through, so a route added later
      // inherits the bound instead of having to remember it. The cap is
      // deliberately generous -- a signed-in dashboard polls, autosaves and
      // pings while simply open, and a shared IP behind CGNAT is several
      // people -- because the aim is to bound abuse, not to shape normal use.
      //
      // Charged only when the memo will NOT answer, so the thing being bounded
      // is the PBKDF2 run itself. A warm, signed-in client polling and
      // autosaving never touches the bucket; a caller sending a different
      // wrong key every time touches it on every request, which is the case
      // that matters. `ip` absent (running outside Cloudflare) means there is
      // no bucket to charge and the request is let through -- this is a cost
      // control, and failing closed here would break every self-hoster off
      // Cloudflare, exactly as the README already says of the other limiters.
      const authIp = clientIpKey(request);
      if (authIp && !(await isCreatorAuthMemoized(creatorKey || "", keyHash, v.normalized))) {
        if (await consumeRateLimit(env, ctx, "creatorauth", authIp, CREATOR_AUTH_VERIFY_PER_MINUTE)) {
          return { ok: false, error: "Too many attempts. Please wait a minute and try again.", throttled: true };
        }
      }
      // Memoized only after a successful PBKDF2 verification, in this
      // isolate's memory, for a few minutes -- see
      // verifyCreatorKeyMemoized (02_http-and-creator-utils.js) for why
      // that is not a weakening of the check. A wrong key still costs a
      // full PBKDF2 run every single time.
      const valid = await verifyCreatorKeyMemoized(creatorKey || "", keyHash, v.normalized);
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
    //
    // The one failure that is NOT generic is a throttle. Eighteen routes had
    // this ternary written out inline, and every one of them replaced
    // auth.error with the generic string -- so when the verification throttle
    // started refusing requests, a person who had simply been polling too hard
    // (or was sharing a CGNAT address with other users) was told their key was
    // wrong. That is a misleading answer to a question they got right. One
    // helper so the three cases stay distinguishable and cannot drift apart
    // again: storage missing, throttled, or genuinely not authenticated.
    function authFailureResponse(auth) {
      if (auth.error === "no-kv") return json({ ok: false, error: "no-kv" }, 500);
      if (auth.throttled) return json({ ok: false, error: auth.error }, 429);
      return json({ ok: false, error: "Username or Key is incorrect." }, 401);
    }

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
      if (!trackCreatorName || !trackCreatorKey) return;
      if (!track) {
        // Auto-track Playback resolved to off for this install link. This
        // can happen even when the user sees the toggle on in Settings, if
        // their install link is stale (see the config staleness note on
        // resolveConfig / Configure -> Update) -- write a diagnostic so
        // "nothing showed up" is visible and traceable instead of silent.
        const diagnosticsKey = `creatortrack:${trackCreatorName.toLowerCase()}`;
        await env.CONFIGS.put(diagnosticsKey, JSON.stringify({
          lastPingAt: Date.now(),
          lastPingId: `${stremioType}:${id}`,
          matched: "no (Auto-track Playback is off for this install link -- go to Configure, re-enable it, then Update your install link)",
        }));
        return;
      }

      const auth = await authenticateCreator(trackCreatorName, trackCreatorKey);
      const diagnosticsKey = `creatortrack:${auth.ok ? auth.username : String(trackCreatorName).toLowerCase()}`;
      const pingId = `${stremioType}:${id}`;

      if (!auth.ok) {
        await env.CONFIGS.put(diagnosticsKey, JSON.stringify({
          lastPingAt: Date.now(),
          lastPingId: pingId,
          matched: "error: this install's Profile credentials no longer authenticate -- re-generate the install link from Settings.",
        }));
        return;
      }

      const effectiveTmdbKey = tmdbKey || TMDB_API_KEY;
      // Already running inside the caller's ctx.waitUntil (see
      // handleSubtitlesTrack's own call site), so no extra waitUntil
      // needed here -- see trackSharedApiUse in 05_catalog-core.js for
      // the same pattern elsewhere.
      if (!tmdbKey) bumpStat(env, "apiuse:tmdb");
      let cleanId = String(id || "").trim();
      let imdbId = "";
      let season = null;
      let episode = null;

      if (cleanId.startsWith("tmdb:")) {
        const rest = cleanId.slice("tmdb:".length);
        const tmdbParts = rest.split(":");
        imdbId = "tmdb:" + tmdbParts[0];
        if (tmdbParts.length >= 3) {
          season = Number(tmdbParts[1]);
          episode = Number(tmdbParts[2]);
        } else if (tmdbParts.length === 2) {
          season = Number(tmdbParts[0]);
          episode = Number(tmdbParts[1]);
        }
      } else if (cleanId.startsWith("kitsu:")) {
        const rest = cleanId.slice("kitsu:".length);
        const kParts = rest.split(":");
        imdbId = "kitsu:" + kParts[0];
        if (kParts.length >= 2) {
          season = 1;
          episode = Number(kParts[1]);
        }
      } else {
        const parts = cleanId.split(":");
        imdbId = parts[0];
        if (parts.length >= 3) {
          season = Number(parts[1]);
          episode = Number(parts[2]);
        } else if (parts.length === 2) {
          season = 1;
          episode = Number(parts[1]);
        }
      }
      let matched = "no";

      try {
        await ensureTrackingMigrated(env, auth.username);
        const syncKey = `creatorsynctracking:${auth.username}`;

        // Resolve what we're actually recording (TMDB lookups) exactly
        // once, before touching KV at all -- these are the slow, expensive
        // part and don't need to be repeated if the KV write below has to
        // retry.
        let recordEpisode = null; // { epIdStr, episodeEntry, showTitle }
        let recordMovie = null; // { movieId, movieEntry, movieTitle }

        if (stremioType === "series" || (season != null && episode != null)) {
          if (season == null || episode == null || !Number.isFinite(season) || !Number.isFinite(episode)) {
            matched = "no (unrecognized episode id format)";
          } else {
            const seasonData = await fetchTmdbSeasonDetails(imdbId, season, effectiveTmdbKey, null, env, ctx);
            let ep = seasonData && seasonData.episodes ? seasonData.episodes.find((e) => e.episode_number === episode) : null;
            if (!ep && seasonData && Array.isArray(seasonData.episodes) && seasonData.episodes.length > 0) {
              ep = seasonData.episodes[episode - 1] || seasonData.episodes[0];
            }
            if (!ep) {
              matched = "no (could not look up this episode on TMDB)";
            } else {
              const showDetails = await fetchTmdbItemDetails(imdbId, effectiveTmdbKey, "series", "", false, env, ctx).catch(() => null);
              const showGenres = (showDetails && showDetails.genres) || [];
              const showYear = (showDetails && (showDetails.releaseYear || showDetails.year || (showDetails.releaseDate && showDetails.releaseDate.slice(0, 4)))) || null;
              ctx.waitUntil(recordPlaybackTelemetry(env, "episode", showGenres, showYear));
              if (showDetails && showDetails.title) {
                ctx.waitUntil(recordTrackedEvent(env, "watched", imdbId, showDetails.title, "series"));
              }
              const epIdStr = String(ep.id || `${imdbId}:${season}:${episode}`);
              recordEpisode = {
                epIdStr,
                showTitle: (showDetails && showDetails.title) || imdbId,
                episodeEntry: {
                  id: epIdStr,
                  type: "episode",
                  name: ep.name || ("Episode " + episode),
                  poster: ep.still_path ? (ep.still_path.startsWith("http") ? ep.still_path : "https://image.tmdb.org/t/p/w500" + ep.still_path) : ((showDetails && showDetails.poster) || ""),
                  showId: imdbId,
                  showTitle: (showDetails && showDetails.title) || "",
                  showPoster: (showDetails && showDetails.poster) || "",
                  seasonNum: season,
                  episodeNum: episode,
                },
              };
            }
          }
        } else if (stremioType === "movie") {
          const details = await fetchTmdbItemDetails(imdbId, effectiveTmdbKey, "movie", "", false, env, ctx).catch(() => null);
          const movieGenres = (details && details.genres) || [];
          const movieYear = (details && (details.releaseYear || details.year || (details.releaseDate && details.releaseDate.slice(0, 4)))) || null;
          ctx.waitUntil(recordPlaybackTelemetry(env, "movie", movieGenres, movieYear));
          if (details && details.title) {
            ctx.waitUntil(recordTrackedEvent(env, "watched", imdbId, details.title, "movie"));
          }
          const movieTitle = (details && details.title) || imdbId;
          recordMovie = {
            movieId: imdbId,
            movieTitle,
            movieEntry: {
              id: imdbId,
              type: "movie",
              name: movieTitle,
              poster: (details && details.poster) || "",
            },
          };
        } else {
          matched = "no (unrecognized id format)";
        }

        // Read-modify-write the shared per-account blob, with a bounded
        // retry: two scrobble pings for the same account (e.g. Nuvio
        // auto-advancing to the next episode and firing another ping
        // moments later, or a player re-probing subtitles mid-playback)
        // both run as independent ctx.waitUntil invocations with no
        // coordination between them, and Cloudflare KV has no
        // compare-and-swap -- if both read the blob before either writes,
        // whichever writes second silently discards whatever the first
        // one added. Re-reading fresh on each attempt and re-checking
        // alreadyWatched against that fresh copy (rather than reusing the
        // blob read at the top of this function) is what makes a retry
        // actually fix the collision instead of just moving it later.
        if (recordEpisode || recordMovie) {
          const MAX_ATTEMPTS = 3;
          let alreadyWatched = false;
          for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
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
            blob.watchlist = Array.isArray(blob.watchlist) ? blob.watchlist : [];

            const beforeWrite = raw || "";

            if (recordEpisode) {
              const { epIdStr, episodeEntry } = recordEpisode;
              blob.watchHistory = blob.watchHistory.filter((it) => !(String(it.id) === epIdStr || (it.showId === imdbId && it.seasonNum === season && it.episodeNum === episode)));
              blob.watchHistory.unshift({ ...episodeEntry, watchedAt: Date.now() });
              // Recompute this show's Continue Watching the same way the
              // cron does (checkForNewEpisodes, 07_source-fetchers-tmdb-
              // simkl.js) -- if this ping's episode happens to be the
              // latest watched one, this naturally finds and queues
              // whatever airs next.
              const oldCwItems = blob.continueWatching.filter((it) => it.showId === imdbId);
              blob.continueWatching = blob.continueWatching.filter((it) => it.showId !== imdbId);
              const watchedEps = blob.watchHistory.filter((it) => it.type === "episode" && it.showId === imdbId && it.seasonNum != null && it.episodeNum != null);
              if (watchedEps.length) {
                const latest = watchedEps.reduce((best, e) => {
                  const eS = Number(e.seasonNum);
                  const eE = Number(e.episodeNum);
                  const bS = Number(best.seasonNum);
                  const bE = Number(best.episodeNum);
                  if (eS > bS) return e;
                  if (eS === bS && eE > bE) return e;
                  return best;
                }, watchedEps[0]);
                const dismissed = blob.dismissedContinueWatching[imdbId];
                const stillDismissed = !!(dismissed && dismissed.seasonNum === latest.seasonNum && dismissed.episodeNum === latest.episodeNum);
                if (!stillDismissed) {
                  const next = await findNextAiredEpisodeForShow(imdbId, latest.seasonNum, latest.episodeNum, effectiveTmdbKey, env).catch(() => null);
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
                    // TMDB either had no next episode (show is finished) OR the fetch failed (rate limit/timeout).
                    // If it was a network failure, we don't want to completely lose the show from Continue Watching,
                    // so we restore the old state just in case. If it truly is finished, it will stay in the old state
                    // (which is fine, the user can manually dismiss it) or they will naturally fall off.
                    if (oldCwItems && oldCwItems.length > 0) {
                      blob.continueWatching = [...oldCwItems, ...blob.continueWatching];
                    } else {
                      blob.fullyWatchedShowIds.push(imdbId);
                    }
                  }
                }
              }
            } else if (recordMovie) {
              const { movieId, movieEntry } = recordMovie;
              blob.watchHistory = blob.watchHistory.filter((it) => String(it.id) !== movieId);
              blob.watchHistory.unshift({ ...movieEntry, watchedAt: Date.now() });
            }

            if (blob.watchlist.length) {
              blob.watchlist = blob.watchlist.filter((it) => it && String(it.id || it.imdbId) !== imdbId && String(it.showId || '') !== imdbId);
            }

            blob.updatedAt = Date.now();
            const serializedBlob = JSON.stringify(blob);

            // Verify nothing else wrote to this key between our read and
            // now before committing -- if it changed, another ping (or
            // the client's own autosave) won the race for this attempt,
            // so retry against a fresh read rather than clobber it.
            const stillCurrent = await env.CONFIGS.get(syncKey);
            if ((stillCurrent || "") !== beforeWrite && attempt < MAX_ATTEMPTS - 1) {
              continue;
            }
            await env.CONFIGS.put(syncKey, serializedBlob);

            // Also write a tiny dedicated scrobble-queue key.
            // Cloudflare KV is eventually consistent -- a write from one edge
            // location (where Nuvio's request lands) can take up to 60 seconds
            // to be readable from another edge (where the browser's save-tracking
            // or load request lands). By writing the just-scrobbled items to a
            // second, separate small key, save-tracking and load can always merge
            // from it as an independent read that's unaffected by the big blob's
            // propagation lag. Keep only the most recent 20 items to stay tiny.
            try {
              const queueKey = `creatorscrobblequeue:${auth.username}`;
              const queueRaw = await env.CONFIGS.get(queueKey);
              let qObj = { watchHistory: [], continueWatching: [] };
              if (queueRaw) {
                try {
                  const parsed = JSON.parse(queueRaw);
                  if (Array.isArray(parsed)) {
                    qObj.watchHistory = parsed;
                  } else if (parsed && typeof parsed === "object") {
                    qObj.watchHistory = Array.isArray(parsed.watchHistory) ? parsed.watchHistory : [];
                    qObj.continueWatching = Array.isArray(parsed.continueWatching) ? parsed.continueWatching : [];
                  }
                } catch {}
              }
              if (recordEpisode) {
                const { epIdStr, episodeEntry } = recordEpisode;
                qObj.watchHistory = qObj.watchHistory.filter((it) => it && String(it.id) !== epIdStr);
                qObj.watchHistory.unshift({ ...episodeEntry, watchedAt: Date.now() });
              } else if (recordMovie) {
                const { movieId, movieEntry } = recordMovie;
                qObj.watchHistory = qObj.watchHistory.filter((it) => it && String(it.id) !== movieId);
                qObj.watchHistory.unshift({ ...movieEntry, watchedAt: Date.now() });
              }
              if (blob.continueWatching && blob.continueWatching.length > 0) {
                const latestCw = blob.continueWatching[0];
                qObj.continueWatching = qObj.continueWatching.filter((it) => it && String(it.showId || it.id) !== String(latestCw.showId || latestCw.id));
                qObj.continueWatching.unshift(latestCw);
              }
              qObj.watchHistory = qObj.watchHistory.slice(0, 20);
              qObj.continueWatching = qObj.continueWatching.slice(0, 20);
              await env.CONFIGS.put(queueKey, JSON.stringify(qObj));
            } catch {}

            break;
          }

          if (recordEpisode) {
            const epLabel = recordEpisode.showTitle;
            matched = alreadyWatched
              ? `yes (already watched: ${epLabel} S${season}E${episode})`
              : `yes (${epLabel} S${season}E${episode})`;
          } else if (recordMovie) {
            matched = alreadyWatched ? `yes (already watched: ${recordMovie.movieTitle})` : `yes (${recordMovie.movieTitle})`;
          }
        }

        // Auto-remove watched item from user's Creator Watchlist if present.
        //
        // This used to enumerate the account's whole creatorlist: prefix and
        // then GET every single list, on EVERY playback ping, just to find
        // the one named "Watchlist" -- so the cost of a ping scaled with how
        // many lists the person owns. The enumeration also had no cursor, so
        // past a thousand lists it silently stopped looking.
        //
        // The watchlist has a canonical key: /api/creator/sync/save-tracking
        // writes creatorlist:{user}:watchlist directly, and slugifyServer
        // turns any list actually named "Watchlist" into that same slug. So
        // the common path is one GET. The scan survives only as a fallback
        // for the shapes the old loop also accepted (an isWatchlist flag, or
        // a name that slugified differently), and is now paged and bounded
        // rather than silently truncating.
        try {
          const removeWatchedFrom = async (key, rawList) => {
            if (!rawList) return;
            const l = JSON.parse(rawList);
            if (!Array.isArray(l.items) || !l.items.length) return;
            const initLen = l.items.length;
            l.items = l.items.filter((it) => it && String(it.id || it.imdbId) !== imdbId && String(it.showId || '') !== imdbId);
            if (l.items.length !== initLen) {
              l.updatedAt = Date.now();
              await env.CONFIGS.put(key, JSON.stringify(l));
            }
          };

          const canonicalKey = `creatorlist:${auth.username}:watchlist`;
          const canonicalRaw = await env.CONFIGS.get(canonicalKey);
          if (canonicalRaw) {
            await removeWatchedFrom(canonicalKey, canonicalRaw);
          } else {
            const listKeys = await listAllKeys(env.CONFIGS, `creatorlist:${auth.username}:`, 200);
            for (const k of (listKeys.keys || [])) {
              const rawList = await env.CONFIGS.get(k.name);
              if (!rawList) continue;
              const l = JSON.parse(rawList);
              const isWatchlist = l.slug === 'watchlist' || (l.name && l.name.toLowerCase() === 'watchlist') || l.isWatchlist;
              if (isWatchlist) await removeWatchedFrom(k.name, rawList);
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
      // The preferred credential for this endpoint: a revocable token that
      // authorises recording playback for one account and nothing else. A
      // webhook URL necessarily carries its credential in the query string
      // (Plex/Jellyfin/Emby accept a URL and nothing else), where it lands in
      // the media server's config and logs -- so what it carries should not
      // be the Creator Key. See getOrCreateScrobbleToken.
      const scrobbleToken = url.searchParams.get("st") || "";

      let authUser = null;
      let effectiveTmdbKey = TMDB_API_KEY;

      if (scrobbleToken) {
        const tokenUser = await usernameForScrobbleToken(env, scrobbleToken);
        if (tokenUser) authUser = tokenUser;
      }

      if (!authUser && configParam) {
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

      let authThrottled = false;
      if (!authUser && queryCreator && queryKey) {
        const auth = await authenticateCreator(queryCreator, queryKey);
        if (auth.ok) authUser = auth.username;
        else if (auth.throttled) authThrottled = true;
      }

      if (!authUser) {
        // A throttle is not a bad credential, and a media server retrying a
        // webhook should be told to back off rather than that its key is
        // wrong -- this endpoint is the one that gets hit on every play, and
        // it was also the easiest way to drive unbounded PBKDF2 runs.
        if (authThrottled) {
          return json({ ok: false, error: "Too many attempts. Please wait a minute and try again." }, 429);
        }
        return json({ ok: false, error: "Unauthorized: Invalid or missing user credentials / config parameter." }, 401);
      }
      // creator+key still works: webhook URLs handed out before scrobble
      // tokens existed are sitting in people's media servers, and breaking
      // them would silently stop their history syncing with no error anyone
      // would see. The dashboard only ever shows the token form now, so
      // these age out as people re-copy the URL.
      await ensureTrackingMigrated(env, authUser);

      if (!effectiveTmdbKey && authUser && env && env.CONFIGS) {
        try {
          const rawSync = await env.CONFIGS.get(`creatorsync:${authUser}`);
          if (rawSync) {
            const syncObj = JSON.parse(rawSync);
            if (syncObj && syncObj.keys && syncObj.keys.tmdbKey) {
              effectiveTmdbKey = String(syncObj.keys.tmdbKey).trim();
            }
          }
        } catch {}
      }
      if (!effectiveTmdbKey) {
        effectiveTmdbKey = (env && env.TMDB_API_KEY) || TMDB_API_KEY || "";
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
      let mediaServerUser = ""; // username who triggered the event
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
        
        let pUser = (payload.Account && (payload.Account.title || payload.Account.name || payload.Account.id)) ||
                    (payload.User && (payload.User.title || payload.User.name || payload.User.Name)) ||
                    payload.username || payload.user_name || payload.account || "";
        if (typeof pUser !== "string" && typeof pUser !== "number") pUser = "";
        pUser = String(pUser).trim();
        if (pUser === "true" || pUser === "false" || pUser === "null" || pUser === "undefined") pUser = "";
        mediaServerUser = pUser;

        const meta = payload.Metadata || {};
        mediaType = meta.type === "episode" ? "series" : "movie";
        title = meta.title || "";
        showTitle = meta.grandparentTitle || meta.parentTitle || "";
        season = meta.parentIndex != null ? Number(meta.parentIndex) : null;
        episode = meta.index != null ? Number(meta.index) : null;
        year = meta.year || null;

        const guids = [
          ...(meta.grandparentGuid ? [{ id: meta.grandparentGuid }] : []),
          ...(meta.parentGuid ? [{ id: meta.parentGuid }] : []),
          ...(Array.isArray(meta.Guid) ? meta.Guid : (meta.guid ? [{ id: meta.guid }] : []))
        ];
        for (const g of guids) {
          const gid = String(g.id || "");
          if (gid.includes("imdb://tt")) {
            const m = gid.match(/tt\d+/);
            if (m && !imdbId) imdbId = m[0];
          } else if (gid.includes("tmdb://")) {
            const m = gid.match(/tmdb:\/\/(\d+)/);
            if (m && !tmdbId) tmdbId = m[1];
          } else if (gid.startsWith("tt") && !imdbId) {
            imdbId = gid;
          }
        }
      }
      // B. Jellyfin Webhook format
      else if (payload.NotificationType || payload.ItemType || payload.ServerId) {
        server = "Jellyfin";
        eventType = String(payload.NotificationType || payload.Event || "").toLowerCase();
        isPlayed = eventType.includes("playback") || eventType.includes("userdata") || eventType.includes("scrobble") || payload.Played === true;
        
        let jUser = payload.NotificationUsername || payload.UserName || payload.Username || (payload.User && (payload.User.Name || payload.User.name)) || payload.user || "";
        if (typeof jUser !== "string" && typeof jUser !== "number") jUser = "";
        jUser = String(jUser).trim();
        if (jUser === "true" || jUser === "false" || jUser === "null" || jUser === "undefined") jUser = "";
        mediaServerUser = jUser;
        
        mediaType = (payload.ItemType === "Episode" || payload.SeriesName) ? "series" : "movie";
        title = payload.Name || payload.ItemName || "";
        showTitle = payload.SeriesName || "";
        season = payload.SeasonNumber != null ? Number(payload.SeasonNumber) : null;
        episode = payload.EpisodeNumber != null ? Number(payload.EpisodeNumber) : null;
        year = payload.Year || null;

        const sPIds = payload.SeriesProviderIds || (payload.Item && payload.Item.SeriesProviderIds) || {};
        const pIds = payload.ProviderIds || (payload.Item && payload.Item.ProviderIds) || {};
        imdbId = sPIds.Imdb || sPIds.imdb || payload.SeriesImdbId || pIds.Imdb || pIds.imdb || payload.Provider_imdb || "";
        tmdbId = sPIds.Tmdb || sPIds.tmdb || payload.SeriesTmdbId || pIds.Tmdb || pIds.tmdb || payload.Provider_tmdb || "";
      }
      // C. Emby Webhook format
      else if (payload.Item || (payload.Event && String(payload.Event).startsWith("playback."))) {
        server = "Emby";
        eventType = String(payload.Event || "").toLowerCase();
        isPlayed = eventType.includes("scrobble") || eventType.includes("playback.start") || eventType.includes("playback.stop") || eventType.includes("markplayed");
        
        let eUser = (payload.User && (payload.User.Name || payload.User.name || payload.User.Id || payload.User.id)) || payload.UserName || payload.Username || payload.user || "";
        if (typeof eUser !== "string" && typeof eUser !== "number") eUser = "";
        eUser = String(eUser).trim();
        if (eUser === "true" || eUser === "false" || eUser === "null" || eUser === "undefined") eUser = "";
        mediaServerUser = eUser;

        const item = payload.Item || payload;
        mediaType = (item.Type === "Episode" || item.SeriesName) ? "series" : "movie";
        title = item.Name || "";
        showTitle = item.SeriesName || "";
        season = item.ParentIndexNumber != null ? Number(item.ParentIndexNumber) : null;
        episode = item.IndexNumber != null ? Number(item.IndexNumber) : null;

        const sPIds = item.SeriesProviderIds || {};
        const pIds = item.ProviderIds || {};
        imdbId = sPIds.Imdb || sPIds.imdb || pIds.Imdb || pIds.imdb || "";
        tmdbId = sPIds.Tmdb || sPIds.tmdb || pIds.Tmdb || pIds.tmdb || "";
      }

      // 4a. Record this username in the seen-users list
      if (mediaServerUser) {
        const recordUserTask = async () => {
          try {
            const seenKey = `scrobbleseenusers:${authUser}`;
            const raw = await env.CONFIGS.get(seenKey);
            const seen = raw ? JSON.parse(raw) : {};
            seen[mediaServerUser] = { server, lastSeen: Date.now() };
            // 90-day TTL — stale accounts from old servers quietly expire
            await env.CONFIGS.put(seenKey, JSON.stringify(seen), { expirationTtl: 60 * 60 * 24 * 90 });
          } catch {}
        };
        if (ctx && typeof ctx.waitUntil === "function") {
          ctx.waitUntil(recordUserTask());
        } else {
          await recordUserTask();
        }
      }

      // 4b. Apply user filter (URL param first, fallback to user's saved account settings in KV)
      let filterEnabled = false;
      let allowedUsersParam = (url.searchParams.get("allowedUsers") || "").trim();
      let blockAnon = url.searchParams.get("blockAnon") === "1";

      if (url.searchParams.has("filterUsers")) {
        filterEnabled = url.searchParams.get("filterUsers") === "1";
      } else if (allowedUsersParam) {
        filterEnabled = true;
      }

      if (authUser) {
        try {
          let trackingRaw = await env.CONFIGS.get(`creatorsynctracking:${authUser}`);
          if (!trackingRaw) {
            trackingRaw = await env.CONFIGS.get(`creatorsync:${authUser}`);
          }
          if (trackingRaw) {
            const trackingObj = JSON.parse(trackingRaw);
            if (trackingObj.scrobbleFilterUsers === true || trackingObj.scrobbleFilterUsers === "1" || trackingObj.scrobbleFilterUsers === 1) {
              filterEnabled = true;
            } else if (trackingObj.scrobbleFilterUsers === false || trackingObj.scrobbleFilterUsers === "0" || trackingObj.scrobbleFilterUsers === 0) {
              filterEnabled = false;
            } else if (trackingObj.scrobbleAllowedUsers) {
              filterEnabled = true;
            }
            if (trackingObj.scrobbleAllowedUsers !== undefined && !url.searchParams.has("allowedUsers")) {
              allowedUsersParam = String(trackingObj.scrobbleAllowedUsers || "").trim();
            }
            if (trackingObj.scrobbleBlockAnonymous && !url.searchParams.has("blockAnon")) {
              blockAnon = true;
            }
          }
        } catch {}
      }

      if (filterEnabled) {
        const allowed = allowedUsersParam.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
        if (!mediaServerUser) {
          if (blockAnon || allowed.length > 0) {
            const ignoredMsg = "No username in payload and user filtering is active.";
            const diagnosticsKey = `creatortrack:${authUser}`;
            await env.CONFIGS.put(diagnosticsKey, JSON.stringify({
              lastPingAt: Date.now(),
              lastPingId: pingId || "unknown",
              lastServer: server,
              lastUser: null,
              matched: `ignored (${ignoredMsg})`,
            }));
            return json({ ok: true, ignored: ignoredMsg });
          }
        } else if (!allowed.includes(mediaServerUser.toLowerCase())) {
          const ignoredMsg = `User '${mediaServerUser}' is not in the allowed list.`;
          const diagnosticsKey = `creatortrack:${authUser}`;
          await env.CONFIGS.put(diagnosticsKey, JSON.stringify({
            lastPingAt: Date.now(),
            lastPingId: pingId || mediaServerUser,
            lastServer: server,
            lastUser: mediaServerUser,
            matched: `ignored (${ignoredMsg})`,
          }));
          return json({ ok: true, ignored: ignoredMsg });
        }
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

      let searchFoundPoster = "";
      if (!imdbId && (showTitle || title)) {
        try {
          let q = showTitle || title;
          if (mediaType === "series") {
            q = String(q)
              .replace(/[\s._-]+[sS]\d+[\s._-]*[eE]\d+.*$/i, "")
              .replace(/[\s._-]+\d+x\d+.*$/i, "")
              .replace(/[\s._-]+season[\s._-]*\d+.*$/i, "")
              .replace(/[\s._-]+episode[\s._-]*\d+.*$/i, "")
              .replace(/\s*\(\d{4}\).*$/, "")
              .trim();
          }
          const searchType = mediaType === "series" ? "tv" : "movie";
          const searchRes = await fetch(`https://api.themoviedb.org/3/search/${searchType}?api_key=${effectiveTmdbKey}&query=${encodeURIComponent(q)}&page=1`);
          if (searchRes.ok) {
            const sd = await searchRes.json();
            if (sd.results && sd.results.length) {
              const first = sd.results[0];
              tmdbId = String(first.id);
              if (first.poster_path) {
                searchFoundPoster = `https://image.tmdb.org/t/p/w500${first.poster_path}`;
              }
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

          const cleanShowName = String(showTitle || title)
            .replace(/[\s._-]+[sS]\d+[\s._-]*[eE]\d+.*$/i, "")
            .replace(/[\s._-]+\d+x\d+.*$/i, "")
            .replace(/[\s._-]+season[\s._-]*\d+.*$/i, "")
            .replace(/[\s._-]+episode[\s._-]*\d+.*$/i, "")
            .replace(/\s*\(\d{4}\).*$/, "")
            .trim();

          const lookupShowId = imdbId || (tmdbId ? `tmdb:${tmdbId}` : "") || cleanShowName || showTitle || title;

          let epIdStr = "";
          if (lookupShowId) {
            const seasonData = await fetchTmdbSeasonDetails(lookupShowId, seasonNum, effectiveTmdbKey, tmdbId, env, ctx).catch(() => null);
            const ep = seasonData && seasonData.episodes ? seasonData.episodes.find((e) => e.episode_number === episodeNum) : null;
            if (ep) {
              epName = ep.name || title;
              epPoster = ep.still_path ? (ep.still_path.startsWith("http") ? ep.still_path : `https://image.tmdb.org/t/p/w500${ep.still_path}`) : "";
              if (ep.id) epIdStr = String(ep.id);
            }
            const showDetails = await fetchTmdbItemDetails(lookupShowId, effectiveTmdbKey, "series", "", false, env, ctx).catch(() => null);
            if (showDetails) {
              sTitle = showDetails.title || sTitle;
              sPoster = showDetails.poster || searchFoundPoster || "";
              if (!imdbId && showDetails.id && showDetails.id.startsWith("tt")) {
                imdbId = showDetails.id;
              }
              if (!tmdbId && showDetails.tmdbId) {
                tmdbId = String(showDetails.tmdbId);
              }
            }
            if (!sPoster && imdbId && imdbId.startsWith("tt")) {
              sPoster = `https://images.metahub.space/poster/medium/${imdbId}/img`;
            }
          }

          const resolvedShowId = imdbId || (tmdbId ? `tmdb:${tmdbId}` : "") || sTitle;
          const itemKey = epIdStr || `${resolvedShowId}:${seasonNum}:${episodeNum}`;
          const finalEpisodePoster = epPoster || sPoster || (imdbId && imdbId.startsWith("tt") ? `https://images.metahub.space/poster/medium/${imdbId}/img` : "");
          const finalShowPoster = sPoster || (imdbId && imdbId.startsWith("tt") ? `https://images.metahub.space/poster/medium/${imdbId}/img` : "") || epPoster;
          
          // Re-watching or newly watching an episode always brings it to the top of Watch History
          blob.watchHistory = blob.watchHistory.filter((it) => !((it.showId === resolvedShowId || it.showTitle === sTitle) && it.seasonNum === seasonNum && it.episodeNum === episodeNum));
          blob.watchHistory.unshift({
            id: itemKey,
            type: "episode",
            name: epName,
            poster: finalEpisodePoster,
            showId: resolvedShowId,
            showTitle: sTitle,
            showPoster: finalShowPoster,
            seasonNum: seasonNum,
            episodeNum: episodeNum,
            watchedAt: Date.now(),
          });

          // Recompute Continue Watching for this show
          const oldCwItems = blob.continueWatching.filter((it) => it.showId === resolvedShowId || (imdbId && it.showId === imdbId) || (sTitle && it.showId === sTitle));
          blob.continueWatching = blob.continueWatching.filter((it) => it.showId !== resolvedShowId && it.showId !== (imdbId || sTitle));
          if (resolvedShowId) {
            const watchedEps = blob.watchHistory.filter((it) => it.type === "episode" && (it.showId === resolvedShowId || (sTitle && it.showTitle === sTitle)) && it.seasonNum != null && it.episodeNum != null);
            let latestSeason = seasonNum;
            let latestEpisode = episodeNum;
            if (watchedEps.length) {
              const latest = watchedEps.reduce((best, e) => {
                const eS = Number(e.seasonNum);
                const eE = Number(e.episodeNum);
                const bS = Number(best.seasonNum);
                const bE = Number(best.episodeNum);
                if (eS > bS) return e;
                if (eS === bS && eE > bE) return e;
                return best;
              }, watchedEps[0]);
              latestSeason = Number(latest.seasonNum);
              latestEpisode = Number(latest.episodeNum);
            }
            const next = await findNextAiredEpisodeForShow(resolvedShowId, latestSeason, latestEpisode, effectiveTmdbKey, env, ctx).catch(() => null);
            if (next) {
              blob.continueWatching.unshift({
                id: next.episode.id ? String(next.episode.id) : `${resolvedShowId}:${next.seasonNum}:${next.episode.episode_number}`,
                type: "episode",
                name: next.episode.name,
                poster: finalShowPoster,
                showId: resolvedShowId,
                showTitle: sTitle,
                showPoster: finalShowPoster,
                seasonNum: next.seasonNum,
                episodeNum: next.episode.episode_number,
              });
              blob.fullyWatchedShowIds = blob.fullyWatchedShowIds.filter((s) => s !== resolvedShowId && s !== imdbId);
            } else if (!blob.fullyWatchedShowIds.includes(resolvedShowId)) {
              if (oldCwItems && oldCwItems.length > 0) {
                blob.continueWatching = [...oldCwItems, ...blob.continueWatching];
              } else {
                blob.fullyWatchedShowIds.push(resolvedShowId);
              }
            }
          }
          matched = `yes (${server}: ${sTitle} S${seasonNum}E${episodeNum})`;
        } else {
          // Movie
          let movieTitle = title;
          let moviePoster = "";
          const lookupMovieId = imdbId || (tmdbId ? `tmdb:${tmdbId}` : "") || title;
          if (lookupMovieId) {
            const details = await fetchTmdbItemDetails(lookupMovieId, effectiveTmdbKey, "movie", "", false, env, ctx).catch(() => null);
            if (details) {
              movieTitle = details.title || movieTitle;
              moviePoster = details.poster || searchFoundPoster || "";
              if (!imdbId && details.id && details.id.startsWith("tt")) {
                imdbId = details.id;
              }
              if (!tmdbId && details.tmdbId) {
                tmdbId = String(details.tmdbId);
              }
            }
            if (!moviePoster && imdbId && imdbId.startsWith("tt")) {
              moviePoster = `https://images.metahub.space/poster/medium/${imdbId}/img`;
            }
          }
          const resolvedMovieId = imdbId || (tmdbId ? `tmdb:${tmdbId}` : "") || movieTitle;
          const finalMoviePoster = moviePoster || (imdbId && imdbId.startsWith("tt") ? `https://images.metahub.space/poster/medium/${imdbId}/img` : "");
          
          blob.watchHistory = blob.watchHistory.filter((it) => !(String(it.id) === resolvedMovieId || String(it.id) === imdbId || it.name === movieTitle));
          blob.watchHistory.unshift({
            id: resolvedMovieId,
            type: "movie",
            name: movieTitle,
            poster: finalMoviePoster,
            watchedAt: Date.now(),
          });
          matched = `yes (${server}: ${movieTitle})`;
        }

        // Clean from watchlist if present
        if (Array.isArray(blob.watchlist)) {
          blob.watchlist = blob.watchlist.filter((it) => it && String(it.id || it.imdbId) !== imdbId && String(it.showId || "") !== imdbId);
        }

        blob.updatedAt = Date.now();
        await env.CONFIGS.put(syncKey, JSON.stringify(blob));

        // Also write to creatorscrobblequeue to protect against KV propagation lag
        try {
          const queueKey = `creatorscrobblequeue:${authUser}`;
          const queueRaw = await env.CONFIGS.get(queueKey);
          let qObj = { watchHistory: [], continueWatching: [] };
          if (queueRaw) {
            try {
              const parsed = JSON.parse(queueRaw);
              if (Array.isArray(parsed)) {
                qObj.watchHistory = parsed;
              } else if (parsed && typeof parsed === "object") {
                qObj.watchHistory = Array.isArray(parsed.watchHistory) ? parsed.watchHistory : [];
                qObj.continueWatching = Array.isArray(parsed.continueWatching) ? parsed.continueWatching : [];
              }
            } catch {}
          }
          if (blob.watchHistory.length > 0) {
            const latestItem = blob.watchHistory[0];
            qObj.watchHistory = qObj.watchHistory.filter((it) => it && String(it.id) !== String(latestItem.id));
            qObj.watchHistory.unshift({ ...latestItem });
          }
          if (blob.continueWatching.length > 0) {
            const latestCw = blob.continueWatching[0];
            qObj.continueWatching = qObj.continueWatching.filter((it) => it && String(it.showId || it.id) !== String(latestCw.showId || latestCw.id));
            qObj.continueWatching.unshift(latestCw);
          }
          qObj.watchHistory = qObj.watchHistory.slice(0, 20);
          qObj.continueWatching = qObj.continueWatching.slice(0, 20);
          await env.CONFIGS.put(queueKey, JSON.stringify(qObj));
        } catch {}
      } catch (err) {
        matched = `error (${server}): ` + (err && err.message ? err.message : String(err));
      }

      // Update diagnostics
      const diagnosticsKey = `creatortrack:${authUser}`;
      await env.CONFIGS.put(diagnosticsKey, JSON.stringify({
        lastPingAt: Date.now(),
        lastPingId: pingId,
        lastServer: server,
        lastUser: mediaServerUser || null,
        matched: matched,
      }));

      return json({
        ok: true,
        server: server,
        user: mediaServerUser || null,
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
      if (!auth.ok) return authFailureResponse(auth);
      const raw = await env.CONFIGS.get(`creatortrack:${auth.username}`);
      let status = { lastPingAt: null, lastPingId: null, lastServer: null, lastUser: null, matched: null };
      if (raw) {
        try {
          status = JSON.parse(raw);
        } catch {
          // leave status as the empty default
        }
      }
      return jsonPrivate({ ok: true, ...status });
    }

    // /api/creator/scrobble-seen-users  (POST)  { creatorName, creatorKey } ->
    // { ok, users: { "James": { server: "Plex", lastSeen: 1234567890 }, ... } }
    // Returns all media server usernames ever seen in webhook events for this account.
    // Populated automatically by handleMediaServerScrobble whenever a username is
    // present in the incoming payload. Used by the settings page to show checkboxes
    // for user filtering without requiring manual name entry.
    if (path === "/api/creator/scrobble-seen-users" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const auth = await authenticateCreator(body.creatorName, body.creatorKey);
      if (!auth.ok) return authFailureResponse(auth);
      const raw = await env.CONFIGS.get(`scrobbleseenusers:${auth.username}`);
      let users = {};
      if (raw) {
        try { users = JSON.parse(raw); } catch {}
      }
      // If scrobbleseenusers is empty, check if creatortrack diagnostics has a lastUser
      if (!Object.keys(users).length) {
        try {
          const diagRaw = await env.CONFIGS.get(`creatortrack:${auth.username}`);
          if (diagRaw) {
            const diag = JSON.parse(diagRaw);
            if (diag && diag.lastUser) {
              users[diag.lastUser] = { server: diag.lastServer || "Media Server", lastSeen: diag.lastPingAt || Date.now() };
            }
          }
        } catch {}
      }
      return jsonPrivate({ ok: true, users });
    }

    // /api/creator/create  (POST)  { creatorName, displayName?, recoveryAnswer? }
    //   -> { ok, creatorName, displayName, creatorKey }
    // Rate limited to one new profile per minute per IP, tracked via a
    // short-lived KV key rather than anything more elaborate -- this add-on
    // has no user-identity system to rate-limit against besides the
    // requester's own IP.
    if (path === "/api/creator/create" && request.method === "POST") {
      if (!env || !env.CONFIGS) return json({ ok: false, error: "no-kv" });
      const ip = clientIpKey(request);
      if (!ip) return json({ ok: false, error: "Could not process this request." }, 400);
      const rateLimitKey = `ratelimit:creatorcreate:${ip}`;
      if (await env.CONFIGS.get(rateLimitKey)) {
        return json({ ok: false, error: "Please wait a moment before creating another Profile." }, 429);
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const v = validateCreatorUsername(body.creatorName);
      if (!v.ok) return json({ ok: false, error: v.error });
      const dn = normalizeCreatorDisplayName(body.displayName, v.normalized);
      if (!dn.ok) return json({ ok: false, error: dn.error }, 400);
      const displayName = dn.displayName;
      // Reserve the rate-limit slot before the uniqueness check, not after
      // -- otherwise two requests landing at nearly the same instant could
      // both pass the "is it taken" check before either has written
      // anything, and both succeed.
      await env.CONFIGS.put(rateLimitKey, "1", { expirationTtl: 60 });
      const existing = await getCreator(env, v.normalized);
      if (existing) {
        return json({ ok: false, error: "That username is already taken." });
      }
      // A username that was deleted moments ago is not available yet.
      //
      // This is the half of the tombstone that actually prevents disclosure.
      // A purge is a sweep, so a request already in flight when it ran can put
      // a key back after it finished -- and `creatorsync:{u}` holds the
      // account's own provider API keys. Holding the name for a few minutes
      // means the straggler has finished, and the second sweep has run, long
      // before anyone else can claim it. Same message as a name that is simply
      // taken, which is what it is for now.
      if (await isCreatorTombstoned(env, v.normalized)) {
        return json({ ok: false, error: "That username is already taken." });
      }
      const creatorKey = generateCreatorKey();
      const keyHash = await hashCreatorKey(creatorKey);
      // Recovery answer is optional and, unlike the Creator Key itself,
      // chosen by the person rather than generated -- normalized
      // (trimmed + lowercased) before hashing so a small casing slip
      // months later at reset time doesn't lock them out over nothing.
      // Same PBKDF2 hash-only storage as the key: this value is never
      // recoverable, only checkable, and it's never shown to an admin --
      // self-service reset (/api/creator/reset-key) is the only thing
      // that ever reads it.
      const recoveryAnswerRaw = String(body.recoveryAnswer || "").trim();
      // Optional -- but if one is given it has to be long enough to be worth
      // hashing. It is lowercased before hashing and it can replace the
      // Creator Key outright via /api/creator/reset-key, so a three-character
      // answer is a three-character password on the whole account. Rejected
      // rather than silently accepted, since the person setting it is the
      // only one who can pick a better one. Existing short answers are
      // untouched; the per-account failure budget on reset-key is what
      // protects those.
      if (recoveryAnswerRaw && recoveryAnswerRaw.length < RECOVERY_ANSWER_MIN_LENGTH) {
        return json({
          ok: false,
          error: `Recovery Answer must be at least ${RECOVERY_ANSWER_MIN_LENGTH} characters -- it can reset your key, so treat it like a password.`,
        }, 400);
      }
      const recoveryAnswerHash = recoveryAnswerRaw ? await hashCreatorKey(recoveryAnswerRaw.toLowerCase()) : null;
      const nowMs = Date.now();
      const profileObj = { displayName, keyHash, recoveryAnswerHash, createdAt: nowMs };

      // A new account starts empty BY CONSTRUCTION, not because whatever
      // happened to this username previously is assumed to have finished
      // cleanly.
      //
      // The tombstone above holds a just-deleted name long enough for any
      // in-flight write to land and for the post-deletion sweep to run, but
      // "long enough" is a judgement about request duration, and inheriting a
      // previous owner's synced config -- which carries their TMDB/Trakt API
      // keys -- is too sharp an outcome to leave resting on one. Sweeping here
      // as well means it does not matter how a stray key got there, or how
      // long ago: nothing under this username survives into the new account.
      //
      // Cheap and safe: for a name that was never used this is one list() that
      // returns nothing plus a handful of deletes against absent keys, on an
      // endpoint already rate-limited to one call per IP per minute. It cannot
      // touch a live account either, because the uniqueness check above has
      // already established there is none.
      const preCreatePurge = await purgeCreatorData(env, v.normalized, { deleteIdentity: false });
      if (!preCreatePurge.ok) {
        return json({
          ok: false,
          error: "Couldn't set that Profile up just now. Please try again in a moment.",
        }, 503);
      }
      
      // KV is written ALWAYS, D1 only additionally. This used to write to
      // D1 *instead of* KV whenever DB was bound, which made the single
      // D1 row the only copy of the account in existence -- if that row
      // was ever lost, or the D1 binding was removed, or a query failed
      // after creation, the account was unrecoverable: the key hash lived
      // nowhere else. It also meant KV and D1 disagreed about which
      // accounts exist, which is what the read-side fallbacks in
      // getCreator/getCreatorList have to cope with.
      //
      // KV is the store every other creator key path already writes
      // unconditionally, so making creation match keeps one consistent
      // source of truth and lets D1 stay a pure accelerator that can be
      // added, removed, or rebuilt at any time without data loss.
      await env.CONFIGS.put(`creator:${v.normalized}`, JSON.stringify(profileObj));
      if (env.DB) {
        try {
          await env.DB.prepare(
            "INSERT INTO creators (username, display_name, key_hash, recovery_answer_hash, created_at) VALUES (?, ?, ?, ?, ?)"
          ).bind(v.normalized, displayName, keyHash, recoveryAnswerHash, nowMs).run();
        } catch (dbErr) {
          // Non-fatal: KV above already holds the authoritative record, so
          // the account is fully usable. D1 will pick it up on the next
          // /admin/api/migrate-d1 run.
          console.error("D1 write error (creator create), KV holds the record:", dbErr);
        }
      }
      
      try {
        const countRaw = await env.CONFIGS.get("stats:creator_count");
        const count = parseInt(countRaw || "0", 10) + 1;
        await env.CONFIGS.put("stats:creator_count", String(count));
      } catch (err) {}

      // The Creator Key is returned exactly once, right here -- it's never
      // stored anywhere (only its hash is), so this is the only moment it
      // will ever exist outside whoever's holding onto it themselves.
      // no-store: this is the one and only moment the plaintext Creator Key
      // exists outside whoever is holding it. Same reasoning
      // /api/creator/scrobble-token already applied to its own token.
      return json({ ok: true, creatorName: v.normalized, displayName, creatorKey }, 200, { "Cache-Control": "no-store" });
    }

    // /api/creator/reset-key  (POST)  { username, recoveryAnswer } -> { ok, creatorKey }
    // Public, self-service. This is the reason recoveryAnswerHash exists
    // at all: someone who's lost their Creator Key but still knows the
    // recovery answer they set at signup can get a working key back
    // without ever filing a Feedback ticket or needing an admin. Same
    // reset-not-recovery shape as /admin/api/reset-creator-key -- a new
    // key is generated and the old one stops working immediately -- the
    // only difference is what proves the requester is allowed to do this
    // (a matching recovery answer here, an authenticated admin there).
    // The recovery answer itself is intentionally NOT rotated on a
    // successful reset: unlike a single-use recovery code, this is a
    // chosen, memorized answer meant to keep working for next time too,
    // the same way a security question's answer would.
    if (path === "/api/creator/reset-key" && request.method === "POST") {
      if (!env || !env.CONFIGS) return json({ ok: false, error: "no-kv" });
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const ip = clientIpKey(request);
      if (!ip) return json({ ok: false, error: "Could not process this request." }, 400);
      const rateLimitKey = `resetkeyrate:${ip}:${statsToday()}`;
      const rateCountRaw = await env.CONFIGS.get(rateLimitKey);
      const rateCount = parseInt(rateCountRaw, 10) || 0;
      if (rateCount >= 10) {
        return json({ ok: false, error: "Too many attempts today -- please try again tomorrow, or reach out via Feedback & Support." });
      }
      await env.CONFIGS.put(rateLimitKey, String(rateCount + 1), { expirationTtl: 86400 });

      const v = validateCreatorUsername(body.username);
      const answer = String(body.recoveryAnswer || "").trim();
      // Generic error for every failure case below (unknown username, no
      // recovery answer on file, wrong answer) -- distinguishing them
      // would let this endpoint be used to enumerate which usernames
      // exist and which have a recovery answer set at all.
      const genericError = "That username and recovery answer don't match, or no recovery answer is set for this account.";
      if (!v.ok || !answer) return json({ ok: false, error: genericError });
      const raw = await getCreator(env, v.normalized);
      if (!raw) return json({ ok: false, error: genericError });
      let profile;
      try {
        profile = JSON.parse(raw);
      } catch {
        return json({ ok: false, error: genericError });
      }
      if (!profile.recoveryAnswerHash) return json({ ok: false, error: genericError });

      // Per-ACCOUNT failure budget, on top of the per-IP one above. The IP
      // counter alone did not defend this endpoint at all: rotating source
      // addresses is free, so it bought an attacker unlimited guesses at one
      // account's recovery answer -- a secret weak enough to fall in a
      // handful of tries, in exchange for a working Creator Key. See
      // RESET_KEY_ACCOUNT_MAX_FAILURES (00_constants.js).
      //
      // Checked here, after the profile is known to exist and to have a
      // recovery answer set, so a wrong or unknown username can never spend
      // (or create a counter for) an account budget. Still before the
      // PBKDF2 verification below, so a throttled attempt costs nothing.
      const resetDay = statsToday();
      const resetScope = `reset:${v.normalized}`;
      if (await readAuthFailureCount(env, resetScope, resetDay) >= RESET_KEY_ACCOUNT_MAX_FAILURES) {
        // Same generic message as every other failure path here, so this
        // does not become a way to ask whether an account exists.
        return json({ ok: false, error: genericError });
      }

      const matches = await verifyCreatorKey(answer.toLowerCase(), profile.recoveryAnswerHash);
      if (!matches) {
        // Failures only: answering correctly must never consume the budget
        // that protects you.
        await noteAuthFailure(env, resetScope, resetDay);
        return json({ ok: false, error: genericError });
      }

      const creatorKey = generateCreatorKey();
      const keyHash = await hashCreatorKey(creatorKey);

      // D1 first, and its outcome decides whether this rotation happens at
      // all -- see rotateCreatorKeyHashInD1 (02_http-and-creator-utils.js).
      // Nothing is written to KV until D1 is known to be either updated or
      // unable to answer with the old hash.
      const d1Rotation = await rotateCreatorKeyHashInD1(env, v.normalized, keyHash);
      if (!d1Rotation.ok) {
        return json({
          ok: false,
          error: "Couldn't reset that key right now. Please try again in a moment -- your existing key still works.",
        }, 503);
      }

      // The previous key must stop working on a warm isolate the instant
      // it is rotated -- see invalidateCreatorAuthMemo's own comment.
      invalidateCreatorAuthMemo();

      // Written unconditionally, not only when D1 missed. getCreator()
      // falls back to D1, so leaving KV holding an older key_hash than D1
      // means two different valid passwords for one account depending on
      // which store answers. Both stores always get the same hash.
      await env.CONFIGS.put(
        `creator:${v.normalized}`,
        JSON.stringify({ ...profile, keyHash })
      );
      return json({ ok: true, creatorName: v.normalized, displayName: profile.displayName, creatorKey }, 200, { "Cache-Control": "no-store" });
    }

    // /admin/api/reset-creator-key  (POST)  { username } -> { ok, creatorKey }
    // Admin-only. There's no email or password on a Creator Profile (see
    // authenticateCreator's own comment above), so a lost key can never be
    // recovered -- only a hash of it is ever stored. This is a reset, not
    // a recovery: it generates a brand-new key the same way signup does,
    // overwrites the stored hash, and hands the plaintext key back exactly
    // once, same as /api/creator/create does. The old key stops working
    // the instant this runs -- anywhere it was in use (other devices,
    // scrobble webhook URLs that embed it) breaks until updated with the
    // new one. This endpoint has no way to confirm the requester actually
    // is the creator in question; that verification is left entirely to
    // the admin using it, out of band, before calling it.
    if (path === "/admin/api/reset-creator-key" && request.method === "POST") {
      const authed = await isAdminRequest(request, env);
      if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
      if (!env || !env.CONFIGS) return json({ ok: false, error: "no-kv" });
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const v = validateCreatorUsername(body.username);
      if (!v.ok) return json({ ok: false, error: "Unknown creator." });
      const raw = await getCreator(env, v.normalized);
      if (!raw) return json({ ok: false, error: "Unknown creator." });
      let profile;
      try {
        profile = JSON.parse(raw);
      } catch {
        return json({ ok: false, error: "Could not read that creator's profile." });
      }
      const creatorKey = generateCreatorKey();
      const keyHash = await hashCreatorKey(creatorKey);

      // Same contract as /api/creator/reset-key above: D1 has to be either
      // updated or unable to answer with the old hash before KV is touched.
      // See rotateCreatorKeyHashInD1 (02_http-and-creator-utils.js).
      const d1Rotation = await rotateCreatorKeyHashInD1(env, v.normalized, keyHash);
      if (!d1Rotation.ok) {
        return json({
          ok: false,
          error: "Couldn't reset that key right now. Please try again in a moment -- the creator's existing key still works.",
        }, 503);
      }

      // The previous key must stop working on a warm isolate the instant
      // it is rotated -- see invalidateCreatorAuthMemo's own comment.
      invalidateCreatorAuthMemo();

      // Written unconditionally, not only when D1 missed. getCreator()
      // falls back to D1, so leaving KV holding an older key_hash than D1
      // means two different valid passwords for one account depending on
      // which store answers. Both stores always get the same hash.
      await env.CONFIGS.put(
        `creator:${v.normalized}`,
        JSON.stringify({ ...profile, keyHash })
      );
      return json({ ok: true, creatorKey }, 200, { "Cache-Control": "no-store" });
    }

    // /api/creator/scrobble-token  (POST)  { creatorName, creatorKey, rotate? }
    //   -> { ok, token }
    // Returns this account's media-server scrobble token, minting one on
    // first use. `rotate: true` issues a fresh one and revokes the previous,
    // which is what "regenerate" in the dashboard does when a webhook URL
    // has been shared or logged somewhere it should not have been.
    //
    // Authenticated with the Creator Key, like every other account
    // operation -- the token is what the WEBHOOK carries, not what this
    // endpoint accepts.
    if (path === "/api/creator/scrobble-token" && request.method === "POST") {
      if (!env || !env.CONFIGS) return json({ ok: false, error: "no-kv" });
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const auth = await authenticateCreator(body.creatorName, body.creatorKey);
      if (!auth.ok) {
        return authFailureResponse(auth);
      }
      const token = await getOrCreateScrobbleToken(env, auth.username, body.rotate === true);
      if (!token) return json({ ok: false, error: "Could not issue a webhook token." }, 500);
      return json({ ok: true, token }, 200, { "Cache-Control": "no-store" });
    }

    // /api/creator/restore  (POST)  { creatorName, creatorKey } -> { ok, creatorName, displayName }
    if (path === "/api/creator/restore" && request.method === "POST") {
      if (!env || !env.CONFIGS) return json({ ok: false, error: "no-kv" });
      const ip = clientIpKey(request);
      if (!ip) return json({ ok: false, error: "Could not process this request." }, 400);
      const rateLimitKey = `ratelimit:creatorrestore:${ip}`;
      const attempts = parseInt((await env.CONFIGS.get(rateLimitKey)) || "0", 10);
      // More generous than profile creation (this is a normal, repeatable
      // action -- someone restoring on a new device isn't abuse), but still
      // capped well below what's useful for guessing a ~60-bit key.
      if (attempts >= 20) {
        return json({ ok: false, error: "Too many attempts. Please wait a minute and try again." }, 429);
      }
      await env.CONFIGS.put(rateLimitKey, String(attempts + 1), { expirationTtl: 60 });

      // Same reasoning as /admin/login: the 60s bucket shapes a burst, this
      // daily budget is what actually bounds guessing at a Creator Key over
      // time. Spent on failures only, so restoring on a run of new devices
      // costs nothing.
      const restoreFailScope = `restore:${ip}`;
      const restoreFailDay = statsToday();
      if (await readAuthFailureCount(env, restoreFailScope, restoreFailDay) >= CREATOR_RESTORE_MAX_FAILURES_PER_DAY) {
        return json({ ok: false, error: "Too many failed attempts today. Please try again tomorrow." }, 429);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const auth = await authenticateCreator(body.creatorName, body.creatorKey);
      if (!auth.ok) {
        if (auth.error !== "no-kv") await noteAuthFailure(env, restoreFailScope, restoreFailDay);
        return authFailureResponse(auth);
      }
      return jsonPrivate({ ok: true, creatorName: auth.username, displayName: auth.displayName });
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
      if (!auth.ok) return authFailureResponse(auth);
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
            const raw = await getCreatorList(env, auth.username, slug);
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
                visibility: effectiveListVisibility(data.visibility),
                url: `${url.origin}/lists/${auth.username}/${slug}`,
              };
            } catch {
              return null;
            }
          })
        )
      ).filter(Boolean);

      // Anything the account owns that creatorlistorder: has lost.
      //
      // order is one KV key rewritten read-modify-write by every save, with
      // no compare-and-swap, so concurrent saves drop each other's entries.
      // Building the dashboard from order alone meant a list whose entry was
      // lost became invisible even though its record was sitting right there
      // in KV -- and the client, seeing it missing, uploaded it again. That
      // feedback loop is what produced 129 list records for 22 real lists on
      // one account.
      //
      // So order now decides DISPLAY ORDER, not existence: a record with no
      // order entry is appended rather than dropped, and order is repaired in
      // the same breath so it converges instead of drifting further. Costs
      // one KV list() on a healthy account, where the recovered set is empty.
      const orderedSlugs = new Set(lists.map((l) => l.slug));
      const recovered = [];
      try {
        let listCursor;
        for (let page = 0; page < 5; page++) {
          const res = await env.CONFIGS.list({ prefix: `creatorlist:${auth.username}:`, cursor: listCursor });
          for (const k of res.keys) {
            const s = k.name.slice(`creatorlist:${auth.username}:`.length);
            if (s && !orderedSlugs.has(s)) recovered.push(s);
          }
          if (res.list_complete || !res.cursor) break;
          listCursor = res.cursor;
        }
      } catch (e) {
        // Best-effort: without it the dashboard is exactly as complete as it
        // was before, never less.
        console.error("creator lists: orphan sweep failed", e);
      }
      if (recovered.length) {
        const restored = (
          await Promise.all(
            recovered.map(async (slug) => {
              const raw = await getCreatorList(env, auth.username, slug);
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
                  visibility: effectiveListVisibility(data.visibility),
                  url: `${url.origin}/lists/${auth.username}/${slug}`,
                };
              } catch {
                return null;
              }
            })
          )
        ).filter(Boolean);
        for (const l of restored) {
          lists.push(l);
          order.push(l.slug);
        }
        if (restored.length) {
          ctx.waitUntil(
            env.CONFIGS.put(`creatorlistorder:${auth.username}`, JSON.stringify({ order })).catch(() => {})
          );
        }
      }

      const hasWatchlistInLists = lists.some(l => l && l.slug === "watchlist");
      if (!hasWatchlistInLists) {
        const wlRaw = await getCreatorList(env, auth.username, "watchlist");
        if (wlRaw) {
          try {
            const data = JSON.parse(wlRaw);
            lists.unshift({
              slug: "watchlist",
              name: data.name || "Watchlist",
              type: data.type || "mixed",
              items: data.items || [],
              itemCount: (data.items || []).length,
              likes: data.likes || 0,
              visibility: effectiveListVisibility(data.visibility),
              url: `${url.origin}/lists/${auth.username}/watchlist`,
            });
          } catch {}
        } else {
          const trackingRaw = await env.CONFIGS.get(`creatorsynctracking:${auth.username}`);
          if (trackingRaw) {
            try {
              const tb = JSON.parse(trackingRaw);
              if (Array.isArray(tb.watchlist) && tb.watchlist.length > 0) {
                lists.unshift({
                  slug: "watchlist",
                  name: "Watchlist",
                  type: "mixed",
                  items: tb.watchlist,
                  itemCount: tb.watchlist.length,
                  likes: 0,
                  visibility: "private",
                  url: `${url.origin}/lists/${auth.username}/watchlist`,
                });
              }
            } catch {}
          }
        }
      }

      // Content version + conditional response.
      //
      // This endpoint returns the FULL items array for every list the
      // account owns, and renderCreatorDashboard calls it on every render --
      // after a save, after a delete, on a tab switch, after a background
      // sync adopts server state. For anyone with large Custom Lists that
      // was megabytes down the wire and a megabytes-sized JSON.parse on the
      // main thread, over and over, almost always producing exactly the
      // data the browser already had.
      //
      // So the browser now sends back the version it last received, and
      // when nothing has changed it gets a few dozen bytes instead of the
      // whole payload and keeps using the copy it already holds.
      //
      // The version is a hash of the actual response body rather than a
      // separately-maintained counter. That costs a hash of a string this
      // endpoint had to build anyway, and in exchange it cannot drift: there
      // is no bump-on-write to forget in some future list-mutating route,
      // and any change to any list, its order, or the display name changes
      // the version by construction. Note it deliberately does NOT save the
      // KV reads above -- the lists still have to be read to know whether
      // they changed. What it removes is the transfer and the parse, which
      // is where the stall the person actually feels comes from.
      const listsPayload = { ok: true, displayName: auth.displayName, lists, order };
      let listsVersion = "";
      try {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(listsPayload)));
        listsVersion = [...new Uint8Array(digest)].slice(0, 10).map((b) => b.toString(16).padStart(2, "0")).join("");
      } catch {
        // No digest available -- fall through with an empty version, which
        // can never match what a client sends, so it always gets the full
        // response. Degrades to the previous behaviour rather than to a
        // browser that stops seeing its own list changes.
      }
      if (listsVersion && body.knownVersion && body.knownVersion === listsVersion) {
        return jsonPrivate({ ok: true, unchanged: true, version: listsVersion });
      }
      return jsonPrivate({ ...listsPayload, version: listsVersion });
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
      if (!auth.ok) return authFailureResponse(auth);

      const type = (body.type === "series" || body.type === "mixed") ? body.type : (body.type === "movie" ? "movie" : null);
      const items = Array.isArray(body.items) ? body.items : [];
      const visibility = normalizeListVisibility(body.visibility);
      const name = String(body.name || "").trim();
      if (!name) return json({ ok: false, error: "Missing a list name." }, 400);
      if (!type) return json({ ok: false, error: "Missing or invalid list type." }, 400);
      // The same bounds /api/publish-list has always had, which this
      // authenticated sibling never picked up -- see CREATOR_LIST_BYTES_MAX
      // (00_constants.js). Rejected rather than truncated, for the reason
      // that file already spells out: quietly storing a shortened list is a
      // worse bug than refusing an oversized one.
      if (name.length > PUBLISHED_LIST_NAME_MAX) {
        return json({ ok: false, error: "That list name is too long." }, 400);
      }
      if (items.length > PUBLISHED_LIST_ITEMS_MAX) {
        return json({ ok: false, error: `That list is too large to save (limit ${PUBLISHED_LIST_ITEMS_MAX} items).` }, 413);
      }

      const orderRaw = await env.CONFIGS.get(`creatorlistorder:${auth.username}`);
      let order = [];
      try {
        order = orderRaw ? JSON.parse(orderRaw).order || [] : [];
      } catch {
        order = [];
      }

      // A caller that names a slug gets that slug.
      //
      // This used to be `order.includes(body.slug) ? body.slug : null`, so a
      // request to save AS a particular slug was honoured only if that slug
      // already appeared in creatorlistorder:{user} -- and silently discarded
      // otherwise, with a brand-new slug minted from the name and ok:true
      // returned as though the request had been carried out. That is the
      // whole duplicate-list bug:
      //
      //   creatorlistorder: is one KV key, rewritten read-modify-write by
      //   every save, and KV has no compare-and-swap. renderCreatorDashboard
      //   fires one save per local list missing from the account, all at
      //   once, so a browser holding 22 lists fired 22 concurrent saves and
      //   21 of the resulting order entries were lost. The records existed;
      //   order (and therefore the dashboard) could not see them; so the next
      //   render fired them again. Each round the client asked for its own
      //   slug and was given a different one it never learned about. One
      //   account reached 129 list records for 22 real lists -- 44 copies of
      //   the same 462-item list, coming-of-age-3 through coming-of-age-53.
      //
      // The slug namespace is per-creator and this request is authenticated
      // as its owner, so there is no one else's list to collide with: an
      // explicit slug is theirs to claim whether or not order has caught up.
      // Honouring it makes the save idempotent -- ask twice, get one list --
      // which is what stops the loop. Only a request that names NO slug goes
      // on to allocate a fresh one.
      //
      // Run through slugifyServer because it now reaches a KV key name and a
      // URL path from an arbitrary body field; previously it could only be a
      // value this Worker had itself written into order.
      const editingSlug = slugifyServer(body.slug) || null;
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
        // Checked against an in-memory array rather than KV, so this one was
        // never a subrequest problem -- but it had the same fall-through:
        // past the bound it kept a slug that WAS taken and saved over that
        // list. Scoped to this creator's own namespace, so only their own
        // list was ever at risk, but silently replacing it is still the
        // wrong answer.
        // Checked against KV as well as order, not order alone: order is a
        // single key that concurrent saves clobber (see the note above), so
        // a slug absent from it may still have a live record behind it, and
        // allocating it would write straight over that list.
        slug = await pickFreeSlug(baseSlug, async (candidate) =>
          order.includes(candidate) || !!(await env.CONFIGS.get(`creatorlist:${auth.username}:${candidate}`))
        );
        if (!slug) {
          return json(
            { ok: false, error: "Couldn't find a free URL for that list name. Please try a slightly different name." },
            409
          );
        }
      }

      // Item count alone is not a size bound -- items carry titles,
      // overviews and poster URLs -- so this is checked on the exact bytes
      // about to be stored, before a slug is allocated or anything is
      // written.
      const itemsJson = JSON.stringify(items || []);
      if (itemsJson.length > CREATOR_LIST_BYTES_MAX) {
        return json({
          ok: false,
          error: "That list is too large to save. Try splitting it into more than one list.",
        }, 413);
      }

      const now = Date.now();
      const existingRaw = editingSlug ? await getCreatorList(env, auth.username, slug) : null;
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
      if (env.DB) {
        try {
          const listId = `${auth.username}:${slug}`;
          // `likes` is bound on the INSERT and deliberately absent from the
          // DO UPDATE.
          //
          // It used to be absent from both, so a row created here took the
          // column's DEFAULT 0 even though the true count was sitting in the
          // KV record this same handler was about to write. Combined with
          // getCreatorList preferring D1, one save made the count read 0 and
          // the next save wrote that 0 into KV -- a rename silently
          // destroying a real like count in every store and in the public
          // directory. Same shape /admin/api/migrate-d1 has always used.
          //
          // Still out of the DO UPDATE, because there `likes` is not ours to
          // write: /api/lists/like owns it, derives it from the voter ledger,
          // and may well have moved it since this request read the record.
          await env.DB.prepare(
            "INSERT INTO creator_lists (id, username, name, type, visibility, items_json, likes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, type=excluded.type, visibility=excluded.visibility, items_json=excluded.items_json, updated_at=excluded.updated_at"
          ).bind(listId, auth.username, name, type, visibility, itemsJson, likes || 0, createdAt, now).run();
        } catch (dbErr) {
          // The commonest cause is the foreign key: D1 enforces
          // creator_lists.username -> creators.username, and an account that
          // predates the D1 binding has no creators row yet, which is exactly
          // the lazy-migration state getCreator is written to tolerate. The
          // list is safe either way -- KV is authoritative and reads prefer
          // it -- but leaving the mirror empty hides the list from the admin
          // Community Lists panel until someone runs migrate-d1.
          //
          // So backfill the account row from KV and retry once. Costs nothing
          // on the happy path (this only runs after a failure) and self-heals
          // instead of waiting for a manual sweep.
          const backfilled = await backfillCreatorRowInD1(env, auth.username);
          if (backfilled) {
            try {
              await env.DB.prepare(
                "INSERT INTO creator_lists (id, username, name, type, visibility, items_json, likes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, type=excluded.type, visibility=excluded.visibility, items_json=excluded.items_json, updated_at=excluded.updated_at"
              ).bind(`${auth.username}:${slug}`, auth.username, name, type, visibility, itemsJson, likes || 0, createdAt, now).run();
            } catch (retryErr) {
              console.error("D1 write error (creatorlist put, after creator backfill):", retryErr);
            }
          } else {
            console.error("D1 write error (creatorlist put):", dbErr);
          }
        }
      }
      
      // Unconditional -- KV must not be allowed to hold a stale copy of a
      // list that D1 has since updated, because the public read paths
      // (/lists/:user/:slug, the directory, search) all read KV.
      await env.CONFIGS.put(
        `creatorlist:${auth.username}:${slug}`,
        JSON.stringify({ name, slug, type, items, visibility, likes, createdAt, updatedAt: now })
      );
      if (!order.includes(slug)) {
        order.push(slug);
        await env.CONFIGS.put(`creatorlistorder:${auth.username}`, JSON.stringify({ order }));
      }

      // Keep the directory index in step with this save. A list turned
      // private is removed rather than updated, otherwise unpublishing would
      // leave it listed publicly.
      //
      // The two directions get different treatment on purpose. Adding stays
      // on ctx.waitUntil: a list that takes a moment to appear in the
      // directory is cosmetic, and the daily rebuild repairs it. REMOVING is
      // awaited and its result is reported, because it is the mechanism by
      // which "make this private" stops the list being advertised -- and it
      // used to be a fire-and-forget task whose failure was swallowed, so
      // unpublishing answered ok:true while the list stayed in the directory
      // AND in search until the next rebuild, up to a day later.
      const indexEntry = isPublicListVisibility(visibility) ? {
        isCreator: true,
        username: auth.username,
        creatorName: auth.displayName || auth.username,
        slug,
        name,
        type: type || "mixed",
        itemCount: Array.isArray(items) ? items.length : 0,
        likes: likes || 0,
        updatedAt: now,
      } : null;
      if (indexEntry) {
        ctx.waitUntil(updatePublicListIndex(env, `c:${auth.username}:${slug}`, indexEntry));
      } else {
        const removed = await updatePublicListIndex(env, `c:${auth.username}:${slug}`, null);
        if (!removed) {
          // The record IS private now -- the save above is unconditional and
          // already landed, so /lists/:user/:slug already 404s. What failed is
          // the directory listing, so say so rather than claiming the list is
          // fully unpublished.
          return json({
            ok: false,
            slug,
            error: "Saved as private, but the public directory could not be updated just yet. It may keep listing this for a few minutes -- please try again.",
          }, 500);
        }
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
      if (!auth.ok) return authFailureResponse(auth);
      const slug = String(body.slug || "");
      if (!slug) return json({ ok: false, error: "Missing slug." }, 400);
      // Shared with /admin/api/delete-creator-list so the two cannot drift --
      // the same lesson purgeCreatorData records about itself. It also drops
      // the like ledger, which this route used to leave behind for whoever
      // next created a list at the same slug to inherit.
      //
      // `ok` is checked rather than assumed. This route used to return
      // { ok: true } unconditionally, so a KV outage on the delete -- or a
      // directory removal that failed -- answered "deleted" while the list
      // stayed live at its public URL and in the directory, with nothing to
      // retry it. See deleteCreatorLists' own comment.
      const removal = await deleteCreatorLists(env, auth.username, [slug]);
      if (!removal.ok) {
        return json({
          ok: false,
          error: "Couldn't finish deleting that list. It may still be visible -- please try again in a moment.",
        }, 500);
      }
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
      if (!auth.ok) return authFailureResponse(auth);
      // Bounded, and no ":" -- that is the KV key separator, and slugifyServer
      // (which produces every slug this app writes) can only emit
      // [a-z0-9-] within 60 characters anyway. The array itself had no cap
      // at all, so an authenticated caller could park an arbitrarily large
      // value under one key; 5,000 is far above any real account, where the
      // worst case ever observed was 129 records.
      const newOrder = Array.isArray(body.order)
        ? body.order
            .map(String)
            .filter((s) => s.length <= 60 && /^[a-zA-Z0-9._-]+$/.test(s))
            .slice(0, CREATOR_LIST_ORDER_MAX)
        : [];
      await env.CONFIGS.put(`creatorlistorder:${auth.username}`, JSON.stringify({ order: newOrder }));
      return json({ ok: true, order: newOrder });
    }

    // /api/creator/account/reset  (POST)  { creatorName, creatorKey, confirm }
    //   -> { ok, cleared: { lists, keys } }
    // Empties an account back to how it looked the moment it was created,
    // WITHOUT deleting the account itself: the creator record, its key hash
    // and its recovery answer are all left alone, so the same Creator Name
    // and Key keep working and the person stays signed in.
    //
    // Distinct from /api/creator/delete-account below, which removes the
    // profile outright. Worth noting while looking at the two together: that
    // one deletes `creatorprofile:`, `creatortrack:`, `creatorpresets:` and
    // `creatorchannels:`, which are old key names this codebase no longer
    // writes -- the live data is under `creator:`, `creatorsynctracking:`,
    // `creatorsyncpresets:` and `creatorsyncchannels:`. So it currently
    // leaves most of an account's data behind. Not changed here because
    // deleting more on that path deserves its own decision, but this reset
    // uses the names actually in use, plus the legacy ones for good measure.
    if (path === "/api/creator/account/reset" && request.method === "POST") {
      if (!env || !env.CONFIGS) return json({ ok: false, error: "Database not configured." }, 500);
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const auth = await authenticateCreator(body.creatorName, body.creatorKey);
      if (!auth.ok) return authFailureResponse(auth);

      // A second, explicit confirmation carried in the request itself. The
      // key alone is enough to authenticate, but this is irreversible and
      // there is no undo, so it should not be reachable by a stray request.
      if (String(body.confirm || "") !== "RESET") {
        return json({ ok: false, error: "Missing confirmation." }, 400);
      }

      // Same sweep as delete-account, minus the identity -- see
      // purgeCreatorData (02_http-and-creator-utils.js). Keeping both
      // callers on one function is what stops the two from drifting apart
      // again the way they had.
      const purged = await purgeCreatorData(env, auth.username, { deleteIdentity: false });
      // A sweep that threw is not a reset. Saying ok:true here would tell
      // someone their account is empty while their lists are still live and
      // still in the public directory.
      if (!purged.ok) {
        return json({
          ok: false,
          error: "Couldn't finish clearing this account. Nothing has been lost -- please try again in a moment.",
          cleared: { lists: purged.listsCleared, keys: purged.keysCleared },
        }, 500);
      }

      return json({ ok: true, cleared: { lists: purged.listsCleared, keys: purged.keysCleared } });
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
      if (!auth.ok) return authFailureResponse(auth);

      // A second, explicit confirmation carried in the request itself,
      // matching /api/creator/account/reset. The key alone authenticates,
      // but this is irreversible and there is no undo, so it must not be
      // reachable by a stray or replayed request.
      if (String(body.confirm || "") !== "DELETE") {
        return json({ ok: false, error: "Missing confirmation." }, 400);
      }

      // deleteIdentity: true is the whole difference from account/reset --
      // the profile, the D1 row, and the last-seen marker go too, so the
      // key stops authenticating and the username becomes reclaimable.
      const purged = await purgeCreatorData(env, auth.username, { deleteIdentity: true });
      // Only a purge that actually removed everything, identity included, is
      // a deletion. Anything else leaves the account signed-in-able so its
      // owner can retry, and must say so rather than reporting success --
      // this endpoint used to return ok:true while leaving every list live,
      // public, and attached to a username anyone could then re-register.
      if (!purged.ok) {
        return json({
          ok: false,
          error: "Couldn't finish deleting this account. Nothing has been removed -- please try again in a moment.",
          cleared: { lists: purged.listsCleared, keys: purged.keysCleared },
        }, 500);
      }
      return json({ ok: true, cleared: { lists: purged.listsCleared, keys: purged.keysCleared } });
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
      if (!auth.ok) return authFailureResponse(auth);

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

      // Conflict guard -- this endpoint used to always blindly overwrite
      // creatorsync:{username} with whatever this request's snapshot was,
      // no matter how stale. Two tabs/devices autosaving around the same
      // time meant whichever PUT landed last in KV won completely, silently
      // discarding the other one's edits with no error anywhere.
      //
      // An updated client now sends expectedUpdatedAt: the updatedAt it
      // last actually saw (from a prior /sync/load or /sync/save response)
      // -- i.e. the version its current edits are built on top of. If the
      // record in KV has moved past that, another device saved in between;
      // rather than clobber that write, this responds 409 and leaves KV
      // untouched. The client's own pending edits aren't lost either: they
      // stay in its DOM/localStorage and go up on the very next autosave,
      // now against the correct baseline. An older client that doesn't
      // send expectedUpdatedAt at all gets exactly its previous behavior
      // (last-write-wins) -- this is purely additive, not a breaking
      // change to the request shape.
      // Present-but-malformed is a client error, not a reason to drop the
      // guard -- see parseExpectedUpdatedAt (02_http-and-creator-utils.js).
      const expected = parseExpectedUpdatedAt(body.expectedUpdatedAt);
      if (!expected.ok) {
        return json({ ok: false, error: "expectedUpdatedAt must be a number." }, 400);
      }
      const expectedUpdatedAt = expected.value;
      // Read unconditionally now, because the stamp below has to be strictly
      // newer than whatever is stored, not merely Date.now() -- see
      // nextSyncVersion.
      const currentRaw = await env.CONFIGS.get(`creatorsync:${auth.username}`);
      let currentUpdatedAt = 0;
      if (currentRaw) {
        try {
          const current = JSON.parse(currentRaw);
          currentUpdatedAt = Number(current.updatedAt) || 0;
          if (expectedUpdatedAt !== null && currentUpdatedAt > expectedUpdatedAt) {
            // Purely for visibility -- this was previously invisible even
            // to us; now it's at least countable on the admin dashboard.
            ctx.waitUntil(bumpStat(env, "sync_conflict"));
            return json({ ok: false, error: "conflict", conflict: true, updatedAt: current.updatedAt }, 409);
          }
        } catch {
          // Existing blob unreadable -- nothing coherent to protect
          // against; fall through and write normally.
        }
      }

      const blob = {
        config: Array.isArray(body.config) ? body.config : [],
        keys: body.keys && typeof body.keys === "object" ? body.keys : {},
        collapsedPanels: body.collapsedPanels && typeof body.collapsedPanels === "object" ? body.collapsedPanels : {},
        likedLists: Array.isArray(body.likedLists) ? body.likedLists.map(String) : [],
        hiddenLists: Array.isArray(body.hiddenLists) ? body.hiddenLists.map(String) : [],
        hiddenMyListsSections: Array.isArray(body.hiddenMyListsSections) ? body.hiddenMyListsSections.map(String) : [],
        updatedAt: nextSyncVersion(currentUpdatedAt),
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
      // updatedAt lets the client advance its own baseline without a
      // separate /sync/meta round trip -- see expectedUpdatedAt above.
      return json({ ok: true, updatedAt: blob.updatedAt });
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
      if (!auth.ok) return authFailureResponse(auth);
      const watchlistUpdatedAt = Number(body.watchlistUpdatedAt) || Date.now();

      // Guard against a narrow but real race: handleSubtitlesTrack and
      // handleMediaServerScrobble both read-modify-write this same KV key
      // directly and outside of any request this browser initiated, so a
      // scrobble can land *between* this browser's last load and this
      // push. Since this endpoint's whole design is "always the full
      // current list" (see pushTrackingSync's own comment -- deliberate,
      // so Clear Watch History and per-item removal both work by just
      // sending a shorter array), a stale client push would otherwise
      // silently erase whatever a scrobble just added.
      //
      // Rather than merging the *entire* history (which would make Clear
      // Watch History and per-item removal impossible to ever fully commit
      // -- the deleted item would just come back on the next autosave),
      // only rescue items added by a scrobble ping inside a short recency
      // window right before this push, and skip the rescue entirely when
      // the client flags this push as an intentional removal (Clear Watch
      // History, deleting a single item) -- see pushTrackingSync's
      // intentionalRemoval comment. That's the one case a stale client
      // snapshot can plausibly be missing something real; anything older
      // than that the client's own load would already have picked up.
      // Always merge server KV state with incoming client state to preserve
      // any scrobbles written by handleSubtitlesTrack or handleMediaServerScrobble
      // that landed between this browser's last load and this push.
      //
      // We cannot gate this on the diagnostic timestamp because handleSubtitlesTrack
      // runs inside ctx.waitUntil (async after the response is sent), so the
      // diagnostic write may arrive AFTER save-tracking has already run -- which
      // was silently wiping every scrobble.
      //
      // Strategy: read KV directly, find any watchHistory items with a watchedAt
      // timestamp newer than body.watchHistory's newest item (i.e. added by the
      // server after the client's last load) and prepend them. Same for
      // continueWatching: show IDs in KV but not in the incoming body are
      // preserved at the front. Skip the merge only for intentionalRemoval.
      let rescuedCount = 0;
      if (!body.intentionalRemoval) {
        try {
          const existingRaw = await env.CONFIGS.get(`creatorsynctracking:${auth.username}`);
          if (existingRaw) {
            const existingBlob = JSON.parse(existingRaw);

            // Watch History: find server items not present in the incoming payload
            const incomingIds = new Set(
              (Array.isArray(body.watchHistory) ? body.watchHistory : []).map((it) => String(it && it.id))
            );
            const serverOnlyItems = (Array.isArray(existingBlob.watchHistory) ? existingBlob.watchHistory : [])
              .filter((it) => it && it.id && !incomingIds.has(String(it.id)));
            if (serverOnlyItems.length) {
              // Sort server-only items newest-first and prepend them
              serverOnlyItems.sort((a, b) => (b.watchedAt || 0) - (a.watchedAt || 0));
              body.watchHistory = [...serverOnlyItems, ...(Array.isArray(body.watchHistory) ? body.watchHistory : [])];
              rescuedCount = serverOnlyItems.length;
            }

            // Continue Watching: when scrobbles occur on the server (Nuvio / Plex),
            // the server computes the next episode and updates existingBlob.continueWatching.
            // If the server has a show in continueWatching, its version must take precedence
            // over the client's stale incoming item for that same show!
            const serverCwList = Array.isArray(existingBlob.continueWatching) ? existingBlob.continueWatching : [];
            if (serverCwList.length) {
              const incomingCwList = Array.isArray(body.continueWatching) ? body.continueWatching : [];
              const mergedCw = [];
              const handledShows = new Set();
              
              // Server's updated Continue Watching items come first
              for (const sItem of serverCwList) {
                if (sItem && (sItem.showId || sItem.id)) {
                  const sKey = String(sItem.showId || sItem.id);
                  mergedCw.push(sItem);
                  handledShows.add(sKey);
                }
              }
              // Add any client-only Continue Watching shows that aren't on the server
              for (const cItem of incomingCwList) {
                if (cItem && (cItem.showId || cItem.id)) {
                  const cKey = String(cItem.showId || cItem.id);
                  if (!handledShows.has(cKey)) {
                    mergedCw.push(cItem);
                    handledShows.add(cKey);
                  }
                }
              }
              body.continueWatching = mergedCw;
            }

            // Airing Next and the Discover recommendations are DERIVED
            // lists: a browser only has them once it has computed them
            // (refreshAiringNext, and opening the Discover tab). A browser
            // that has not done that yet still pushes the full tracking
            // payload on its first autosave, with those two fields empty
            // -- and since this endpoint is "always the full current
            // list", that empty array used to overwrite a perfectly good
            // one another browser had already computed. The catalog row
            // reading it (fetchAutoTrackedCatalog / fetchCuratedCatalog)
            // then served nothing, which is what "No items found" in the
            // Live Preview actually was.
            //
            // So: an empty incoming derived list never replaces a
            // non-empty stored one. Deliberately shrinking one still
            // works -- a real change sends a non-empty array, and an
            // intentional clear (Clear Watch History) sets
            // intentionalRemoval and skips this whole block.
            if ((!Array.isArray(body.airingNext) || !body.airingNext.length) &&
                Array.isArray(existingBlob.airingNext) && existingBlob.airingNext.length) {
              body.airingNext = existingBlob.airingNext;
            }
            const incomingRecs = body.curatedRecommendations;
            const incomingRecsEmpty = !incomingRecs || typeof incomingRecs !== "object" ||
              ((!Array.isArray(incomingRecs.movies) || !incomingRecs.movies.length) &&
               (!Array.isArray(incomingRecs.shows) || !incomingRecs.shows.length));
            const storedRecs = existingBlob.curatedRecommendations;
            const storedRecsPresent = storedRecs && typeof storedRecs === "object" &&
              ((Array.isArray(storedRecs.movies) && storedRecs.movies.length) ||
               (Array.isArray(storedRecs.shows) && storedRecs.shows.length));
            if (incomingRecsEmpty && storedRecsPresent) {
              body.curatedRecommendations = storedRecs;
            }

            // The watchlist is the one array in this payload that had
            // neither a merge nor an empty-guard, and it overwrites two
            // records: the tracking blob AND creatorlist:{user}:watchlist
            // (in KV and D1). pushTrackingSync always sends the browser's
            // full local copy, so a second device that has not finished
            // loading -- or one whose localStorage was cleared -- pushed an
            // empty array and the account's Watchlist was gone from
            // everywhere at once.
            //
            // Same rule the derived lists just above already use: an empty
            // incoming array never replaces a non-empty stored one. A real
            // change still sends a non-empty array, and a deliberate clear
            // sets intentionalRemoval and skips this whole block -- which is
            // exactly the distinction that field exists to draw.
            if ((!Array.isArray(body.watchlist) || !body.watchlist.length) &&
                Array.isArray(existingBlob.watchlist) && existingBlob.watchlist.length) {
              body.watchlist = existingBlob.watchlist;
              // Keep the stamp with the data it belongs to, or the record
              // would claim this browser's clock for someone else's items.
              if (Number(existingBlob.watchlistUpdatedAt)) {
                body.watchlistUpdatedAt = Number(existingBlob.watchlistUpdatedAt);
              }
            }

            // fullyWatchedShowIds: union
            if (Array.isArray(existingBlob.fullyWatchedShowIds) && existingBlob.fullyWatchedShowIds.length) {
              const incomingFW = new Set(Array.isArray(body.fullyWatchedShowIds) ? body.fullyWatchedShowIds.map(String) : []);
              for (const sid of existingBlob.fullyWatchedShowIds) {
                if (!incomingFW.has(String(sid))) {
                  body.fullyWatchedShowIds = body.fullyWatchedShowIds || [];
                  body.fullyWatchedShowIds.push(sid);
                }
              }
            }
          }
        } catch {
          // Merge is best-effort -- never block the save over it.
        }

        // SECONDARY MERGE: always read the dedicated scrobble-queue key.
        // This is written by handleSubtitlesTrack immediately after each
        // scrobble and is tiny (≤20 items), so it propagates faster and
        // independently from the large tracking blob. This catches the case
        // where the large blob hasn't propagated across Cloudflare edges yet.
        try {
          const queueRaw = await env.CONFIGS.get(`creatorscrobblequeue:${auth.username}`);
          if (queueRaw) {
            const queue = JSON.parse(queueRaw);
            let queueWh = [];
            let queueCw = [];
            if (Array.isArray(queue)) {
              queueWh = queue;
            } else if (queue && typeof queue === "object") {
              queueWh = Array.isArray(queue.watchHistory) ? queue.watchHistory : [];
              queueCw = Array.isArray(queue.continueWatching) ? queue.continueWatching : [];
            }
            if (queueWh.length) {
              const currentIds = new Set(
                (Array.isArray(body.watchHistory) ? body.watchHistory : []).map((it) => String(it && it.id))
              );
              const queueOnly = queueWh.filter((it) => it && it.id && !currentIds.has(String(it.id)));
              if (queueOnly.length) {
                queueOnly.sort((a, b) => (b.watchedAt || 0) - (a.watchedAt || 0));
                body.watchHistory = [...queueOnly, ...(Array.isArray(body.watchHistory) ? body.watchHistory : [])];
                rescuedCount += queueOnly.length;
              }
            }
            if (queueCw.length) {
              const mergedCw = [];
              const handledShows = new Set();
              for (const qItem of queueCw) {
                if (qItem && (qItem.showId || qItem.id)) {
                  mergedCw.push(qItem);
                  handledShows.add(String(qItem.showId || qItem.id));
                }
              }
              for (const bItem of (Array.isArray(body.continueWatching) ? body.continueWatching : [])) {
                if (bItem && (bItem.showId || bItem.id)) {
                  const bKey = String(bItem.showId || bItem.id);
                  if (!handledShows.has(bKey)) {
                    mergedCw.push(bItem);
                    handledShows.add(bKey);
                  }
                }
              }
              body.continueWatching = mergedCw;
            }
          }
        } catch {
          // Best-effort
        }
      }

      const blob = {
        watchHistory: Array.isArray(body.watchHistory) ? body.watchHistory : [],
        continueWatching: Array.isArray(body.continueWatching) ? body.continueWatching : [],
        watchlist: Array.isArray(body.watchlist) ? body.watchlist : [],
        watchlistUpdatedAt: watchlistUpdatedAt,
        // Airing Next -- unlike watchHistory/continueWatching, this is
        // purely derived (recomputed client-side against TMDB on a timer,
        // see refreshAiringNext, 21_client-custom-list-builder.js), so
        // there's nothing to migrate from an older creatorsync: blob the
        // way ensureTrackingMigrated handles the other tracking fields --
        // it just starts empty on an account that hasn't pushed one yet,
        // same as a brand new field always would.
        airingNext: Array.isArray(body.airingNext) ? body.airingNext : [],
        // The Discover tab's Recommended Movies/Shows lists, exactly as
        // that tab rendered them. Pushed rather than recomputed for the
        // same reason airingNext is: fetchCuratedCatalog
        // (05_catalog-core.js) cannot see the browser-side inputs the
        // card is built from, so the only way the catalog row and the
        // card can hold the same items is for the browser to hand the
        // server the list it actually showed.
        curatedRecommendations: (body.curatedRecommendations && typeof body.curatedRecommendations === "object")
          ? {
              movies: Array.isArray(body.curatedRecommendations.movies) ? body.curatedRecommendations.movies : [],
              shows: Array.isArray(body.curatedRecommendations.shows) ? body.curatedRecommendations.shows : [],
              updatedAt: Number(body.curatedRecommendations.updatedAt) || Date.now(),
            }
          : null,
        fullyWatchedShowIds: Array.isArray(body.fullyWatchedShowIds) ? body.fullyWatchedShowIds.map(String) : [],
        dismissedContinueWatching: body.dismissedContinueWatching && typeof body.dismissedContinueWatching === "object" ? body.dismissedContinueWatching : {},
        trackPlayback: typeof body.trackPlayback === "boolean" ? body.trackPlayback : false,
        removeWatchedFromWatchlist: typeof body.removeWatchedFromWatchlist === "boolean" ? body.removeWatchedFromWatchlist : true,
        scrobbleFilterUsers: typeof body.scrobbleFilterUsers === "boolean" ? body.scrobbleFilterUsers : false,
        scrobbleAllowedUsers: typeof body.scrobbleAllowedUsers === "string" ? body.scrobbleAllowedUsers : "",
        scrobbleBlockAnonymous: typeof body.scrobbleBlockAnonymous === "boolean" ? body.scrobbleBlockAnonymous : false,
        updatedAt: Date.now(),
      };
      const serialized = JSON.stringify(blob);
      if (serialized.length > 24 * 1024 * 1024) {
        return json({ ok: false, error: "Your Watch History is too large to store (over the 25MB limit)." });
      }
      try {
        await env.CONFIGS.put(`creatorsynctracking:${auth.username}`, serialized);
        if (Array.isArray(body.watchlist)) {
          const wlRaw = await getCreatorList(env, auth.username, "watchlist");
          let wlObj = null;
          if (wlRaw) {
            try {
              wlObj = JSON.parse(wlRaw);
            } catch {}
          }
          if (!wlObj) {
            wlObj = {
              name: "Watchlist",
              slug: "watchlist",
              type: "mixed",
              isWatchlist: true,
              visibility: "private",
              createdAt: Date.now(),
            };
          }
          wlObj.items = body.watchlist;
          wlObj.updatedAt = watchlistUpdatedAt;
          // Same D1 row-size reasoning as /api/creator/lists/save: a
          // watchlist over the ceiling cannot be mirrored, and a mirror that
          // silently stops is how a missing D1 row comes about.
          if (JSON.stringify(wlObj.items || []).length > CREATOR_LIST_BYTES_MAX) {
            return json({ ok: false, error: "Your Watchlist is too large to store. Try removing some items." }, 413);
          }
          
          if (env.DB) {
            try {
              const listId = `${auth.username}:watchlist`;
              const itemsJson = JSON.stringify(wlObj.items || []);
              // Carries `likes` on the INSERT for the same reason the
              // creator-list save above does -- a Watchlist is private by
              // default but nothing stops one being shared and liked.
              await env.DB.prepare(
                "INSERT INTO creator_lists (id, username, name, type, visibility, items_json, likes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, type=excluded.type, visibility=excluded.visibility, items_json=excluded.items_json, updated_at=excluded.updated_at"
              ).bind(listId, auth.username, wlObj.name, wlObj.type, wlObj.visibility, itemsJson, wlObj.likes || 0, wlObj.createdAt, wlObj.updatedAt).run();
            } catch (dbErr) {
              console.error("D1 write error (creatorlist watchlist):", dbErr);
            }
          }
          
          // Unconditional -- see the creatorlist put above.
          await env.CONFIGS.put(`creatorlist:${auth.username}:watchlist`, JSON.stringify(wlObj));

          const orderRaw = await env.CONFIGS.get(`creatorlistorder:${auth.username}`);
          let order = [];
          try { order = orderRaw ? JSON.parse(orderRaw).order || [] : []; } catch {}
          if (!order.includes("watchlist")) {
            order.unshift("watchlist");
            await env.CONFIGS.put(`creatorlistorder:${auth.username}`, JSON.stringify({ order }));
          }
        }
      } catch (e) {
        return json({ ok: false, error: "Could not save to storage right now. Please try again in a moment." }, 500);
      }
      return json({ ok: true, rescuedFromScrobble: rescuedCount });
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
      if (!auth.ok) return authFailureResponse(auth);
      // Same conflict guard as /api/creator/sync/save. Presets are the blob
      // this codebase itself calls "the one piece of synced state that can
      // genuinely grow large" -- a TV Channel's url is its entire episode
      // list -- and it had no guard at all, so a second device autosaving a
      // stale snapshot silently replaced the whole set. Additive: a client
      // that sends no expectedUpdatedAt keeps the previous behaviour.
      const presetsExpected = parseExpectedUpdatedAt(body.expectedUpdatedAt);
      if (!presetsExpected.ok) {
        return json({ ok: false, error: "expectedUpdatedAt must be a number." }, 400);
      }
      const presetsCurrentRaw = await env.CONFIGS.get(`creatorsyncpresets:${auth.username}`);
      let presetsCurrentUpdatedAt = 0;
      if (presetsCurrentRaw) {
        try {
          const cur = JSON.parse(presetsCurrentRaw);
          presetsCurrentUpdatedAt = Number(cur.updatedAt) || 0;
          if (presetsExpected.value !== null && presetsCurrentUpdatedAt > presetsExpected.value) {
            ctx.waitUntil(bumpStat(env, "sync_conflict"));
            return json({ ok: false, error: "conflict", conflict: true, updatedAt: cur.updatedAt }, 409);
          }
        } catch {
          // Unreadable -- nothing coherent to protect; write normally.
        }
      }
      const presetsBlob = {
        presets: body.presets && typeof body.presets === "object" ? body.presets : {},
        presetsB64: body.presetsB64 || null,
        updatedAt: nextSyncVersion(presetsCurrentUpdatedAt),
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
      // Handed back so the client can advance its baseline without a
      // separate /sync/meta round trip, exactly as /sync/save does.
      return json({ ok: true, updatedAt: presetsBlob.updatedAt });
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
      if (!auth.ok) return authFailureResponse(auth);
      // Same conflict guard and the same reasoning as save-presets above.
      const channelsExpected = parseExpectedUpdatedAt(body.expectedUpdatedAt);
      if (!channelsExpected.ok) {
        return json({ ok: false, error: "expectedUpdatedAt must be a number." }, 400);
      }
      const channelsCurrentRaw = await env.CONFIGS.get(`creatorsyncchannels:${auth.username}`);
      let channelsCurrentUpdatedAt = 0;
      if (channelsCurrentRaw) {
        try {
          const cur = JSON.parse(channelsCurrentRaw);
          channelsCurrentUpdatedAt = Number(cur.updatedAt) || 0;
          if (channelsExpected.value !== null && channelsCurrentUpdatedAt > channelsExpected.value) {
            ctx.waitUntil(bumpStat(env, "sync_conflict"));
            return json({ ok: false, error: "conflict", conflict: true, updatedAt: cur.updatedAt }, 409);
          }
        } catch {
          // Unreadable -- nothing coherent to protect; write normally.
        }
      }
      const channelsBlob = {
        channels: body.channels && typeof body.channels === "object" ? body.channels : {},
        mergedChannels: body.mergedChannels && typeof body.mergedChannels === "object" ? body.mergedChannels : {},
        updatedAt: nextSyncVersion(channelsCurrentUpdatedAt),
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
      return json({ ok: true, updatedAt: channelsBlob.updatedAt });
    }

    // /api/creator/sync/meta  (POST)  { creatorName, creatorKey }
    //   -> { ok, config, tracking, presets, channels }
    // A deliberately tiny sibling of /api/creator/sync/load below, holding
    // nothing but the four updatedAt stamps that tell a browser whether
    // anything it cares about has actually changed.
    //
    // It exists because the dashboard polls for multi-device changes on a
    // timer while it is simply open (see handleForegroundResumeSync,
    // 22_client-creator-profile.js), and that poll used to call sync/load
    // itself -- which reads six KV keys, JSON-parses a watchHistory that
    // can run to thousands of items, re-serializes all of it, and ships
    // the whole thing back down the wire. For an active account that was
    // megabytes of response, several times a minute, almost always to
    // conclude that nothing had changed at all.
    //
    // Two things keep this cheap. The four reads run concurrently rather
    // than one after another, and each updatedAt is pulled straight out of
    // the raw stored string (see readUpdatedAtFromRaw) instead of parsing
    // the blob -- so a 4MB tracking record costs a substring scan here,
    // not a full parse. The response is a few dozen bytes either way.
    //
    // Deliberately derived from the same keys sync/load reads rather than
    // from a separate "last changed" record: a dedicated key would have to
    // be updated by every write path that touches any of these blobs, and
    // a single missed write there would silently stop a device from ever
    // syncing again. Reading the real thing cannot drift.
    if (path === "/api/creator/sync/meta" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const auth = await authenticateCreator(body.creatorName, body.creatorKey);
      if (!auth.ok) return authFailureResponse(auth);

      // Pulls "updatedAt": <number> out of a stored blob without parsing
      // it. Every blob these keys hold writes updatedAt as a plain number
      // at the top level, and lastIndexOf finds the last (top-level) one
      // rather than any nested occurrence inside an item. A miss returns 0,
      // which reads as "older than anything the client has" and simply
      // causes a normal full load -- never a skipped one.
      function readUpdatedAtFromRaw(raw) {
        if (!raw) return 0;
        const marker = '"updatedAt":';
        const at = raw.lastIndexOf(marker);
        if (at === -1) return 0;
        const num = parseInt(raw.slice(at + marker.length, at + marker.length + 20).replace(/[^0-9].*$/, ""), 10);
        return Number.isFinite(num) ? num : 0;
      }

      let configRaw = null, trackingRaw = null, presetsRaw = null, channelsRaw = null;
      try {
        [configRaw, trackingRaw, presetsRaw, channelsRaw] = await Promise.all([
          env.CONFIGS.get(`creatorsync:${auth.username}`),
          env.CONFIGS.get(`creatorsynctracking:${auth.username}`),
          env.CONFIGS.get(`creatorsyncpresets:${auth.username}`),
          env.CONFIGS.get(`creatorsyncchannels:${auth.username}`),
        ]);
      } catch {
        // A read failure must not look like "nothing changed" -- returning
        // ok:false makes the client fall back to a full sync/load.
        return json({ ok: false, error: "Could not read sync state right now." }, 500);
      }

      return jsonPrivate({
        ok: true,
        exists: configRaw !== null || trackingRaw !== null,
        config: readUpdatedAtFromRaw(configRaw),
        tracking: readUpdatedAtFromRaw(trackingRaw),
        presets: readUpdatedAtFromRaw(presetsRaw),
        channels: readUpdatedAtFromRaw(channelsRaw),
      });
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
      if (!auth.ok) return authFailureResponse(auth);
      await ensureTrackingMigrated(env, auth.username);
      // These five reads are independent of one another, and were awaited
      // one after the next -- so this endpoint paid five sequential KV
      // round trips before it could start assembling anything. Issuing them
      // together turns that into one. (ensureTrackingMigrated above still
      // runs first on purpose: it can WRITE the tracking key, so reading it
      // concurrently with that would be a race.)
      const [raw, presetsRawInit, channelsRawInit, trackingRawInit, orderRawInit] = await Promise.all([
        env.CONFIGS.get(`creatorsync:${auth.username}`),
        env.CONFIGS.get(`creatorsyncpresets:${auth.username}`),
        env.CONFIGS.get(`creatorsyncchannels:${auth.username}`),
        env.CONFIGS.get(`creatorsynctracking:${auth.username}`),
        env.CONFIGS.get(`creatorlistorder:${auth.username}`),
      ]);
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
      let presetsRaw = presetsRawInit;
      let presetsBlob = null;
      if (presetsRaw) {
        try {
          presetsBlob = JSON.parse(presetsRaw);
        } catch {
          presetsBlob = null;
        }
      }

      // Extract presets safely regardless of storage format
      let dedicatedPresets = {};
      let dedicatedPresetsB64 = null;
      let dedicatedUpdatedAt = 0;

      if (presetsBlob) {
        if (presetsBlob.presetsB64 && typeof presetsBlob.presetsB64 === "string") {
          dedicatedPresetsB64 = presetsBlob.presetsB64;
        }
        if (presetsBlob.presets && typeof presetsBlob.presets === "object" && !Array.isArray(presetsBlob.presets)) {
          dedicatedPresets = { ...presetsBlob.presets };
        } else if (typeof presetsBlob === "object" && !Array.isArray(presetsBlob)) {
          Object.keys(presetsBlob).forEach((k) => {
            if (k !== "presets" && k !== "presetsB64" && k !== "updatedAt" && presetsBlob[k] && typeof presetsBlob[k] === "object") {
              dedicatedPresets[k] = presetsBlob[k];
            }
          });
        } else if (Array.isArray(presetsBlob)) {
          presetsBlob.forEach((p) => {
            if (p && p.name) dedicatedPresets[p.name] = p;
          });
        }
        if (presetsBlob.updatedAt) dedicatedUpdatedAt = presetsBlob.updatedAt;
      }

      const dedicatedHasPresets = !!(dedicatedPresetsB64 || Object.keys(dedicatedPresets).length > 0);
      const mainHasPresets = !!(data && (data.presetsB64 || (data.presets && typeof data.presets === 'object' && Object.keys(data.presets).length > 0)));

      if (!dedicatedHasPresets && mainHasPresets) {
        let adoptedMap = {};
        if (data.presets && typeof data.presets === "object" && !Array.isArray(data.presets)) {
          adoptedMap = { ...data.presets };
        } else if (Array.isArray(data.presets)) {
          data.presets.forEach((p) => { if (p && p.name) adoptedMap[p.name] = p; });
        }
        dedicatedPresets = adoptedMap;
        dedicatedPresetsB64 = data.presetsB64 || null;
        dedicatedUpdatedAt = Date.now();
        try {
          await env.CONFIGS.put(`creatorsyncpresets:${auth.username}`, JSON.stringify({
            presets: dedicatedPresets,
            presetsB64: dedicatedPresetsB64,
            updatedAt: dedicatedUpdatedAt,
          }));
        } catch {}
      }

      if (!data) {
        data = { config: [], collapsedPanels: {}, likedLists: [], updatedAt: Date.now() };
      }
      data.presets = dedicatedPresets;
      data.presetsB64 = dedicatedPresetsB64;
      data.presetsUpdatedAt = dedicatedUpdatedAt;
      // Channels & merged channels live in their own key -- merge them back in for signed-in sync across browsers.
      const channelsRaw = channelsRawInit;
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
          data.channelsUpdatedAt = channelsBlob.updatedAt || 0;
        }
      }
      // Tracking data (Watch History/Continue Watching/etc) also lives in
      // its own key now -- see save-tracking's own comment above for why.
      // Same merge pattern as presets: the client's loadCreatorSync still
      // just reads data.watchHistory/data.continueWatching/etc exactly
      // like before, unaware this is a third KV read.
      const trackingRaw = trackingRawInit;
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
          // Airing Next and the Discover recommendations were stored by
          // save-tracking but never handed back here, so loadCreatorSync's
          // own restore branches for them (22_client-creator-profile.js)
          // could never fire. A browser that signed in fresh therefore had
          // no copy of either, and its first autosave pushed empty arrays
          // straight back over the account's real ones -- see
          // save-tracking's derived-list guard above for the other half of
          // this fix.
          data.airingNext = Array.isArray(trackingBlob.airingNext) ? trackingBlob.airingNext : [];
          data.curatedRecommendations = (trackingBlob.curatedRecommendations && typeof trackingBlob.curatedRecommendations === "object")
            ? trackingBlob.curatedRecommendations
            : null;
          data.trackingUpdatedAt = trackingBlob.updatedAt || 0;
          data.fullyWatchedShowIds = Array.isArray(trackingBlob.fullyWatchedShowIds) ? trackingBlob.fullyWatchedShowIds : [];
          data.dismissedContinueWatching = trackingBlob.dismissedContinueWatching && typeof trackingBlob.dismissedContinueWatching === "object" ? trackingBlob.dismissedContinueWatching : {};
          data.trackPlayback = typeof trackingBlob.trackPlayback === "boolean" ? trackingBlob.trackPlayback : false;
          data.removeWatchedFromWatchlist = typeof trackingBlob.removeWatchedFromWatchlist === "boolean" ? trackingBlob.removeWatchedFromWatchlist : true;
          data.scrobbleFilterUsers = typeof trackingBlob.scrobbleFilterUsers === "boolean" ? trackingBlob.scrobbleFilterUsers : false;
          data.scrobbleAllowedUsers = typeof trackingBlob.scrobbleAllowedUsers === "string" ? trackingBlob.scrobbleAllowedUsers : "";
          data.scrobbleBlockAnonymous = typeof trackingBlob.scrobbleBlockAnonymous === "boolean" ? trackingBlob.scrobbleBlockAnonymous : false;
        }
      }
      // Merge dedicated scrobble-queue key into watchHistory so that recent
      // scrobbles are always visible even if the large tracking blob hasn't
      // propagated across Cloudflare edges yet (KV eventual consistency).
      try {
        const sqRaw = await env.CONFIGS.get(`creatorscrobblequeue:${auth.username}`);
        if (sqRaw) {
          const sq = JSON.parse(sqRaw);
          let queueWh = [];
          let queueCw = [];
          if (Array.isArray(sq)) {
            queueWh = sq;
          } else if (sq && typeof sq === "object") {
            queueWh = Array.isArray(sq.watchHistory) ? sq.watchHistory : [];
            queueCw = Array.isArray(sq.continueWatching) ? sq.continueWatching : [];
          }
          if (queueWh.length || queueCw.length) {
            if (!data) data = { config: [], collapsedPanels: {}, likedLists: [], updatedAt: Date.now() };
            if (queueWh.length) {
              const existingWhIds = new Set((Array.isArray(data.watchHistory) ? data.watchHistory : []).map((it) => String(it && it.id)));
              const queueWhOnly = queueWh.filter((it) => it && it.id && !existingWhIds.has(String(it.id)));
              if (queueWhOnly.length) {
                queueWhOnly.sort((a, b) => (b.watchedAt || 0) - (a.watchedAt || 0));
                data.watchHistory = [...queueWhOnly, ...(Array.isArray(data.watchHistory) ? data.watchHistory : [])];
              }
            }
            if (queueCw.length) {
              const mergedCw = [];
              const handledShows = new Set();
              for (const qItem of queueCw) {
                if (qItem && (qItem.showId || qItem.id)) {
                  mergedCw.push(qItem);
                  handledShows.add(String(qItem.showId || qItem.id));
                }
              }
              for (const dItem of (Array.isArray(data.continueWatching) ? data.continueWatching : [])) {
                if (dItem && (dItem.showId || dItem.id)) {
                  const dKey = String(dItem.showId || dItem.id);
                  if (!handledShows.has(dKey)) {
                    mergedCw.push(dItem);
                    handledShows.add(dKey);
                  }
                }
              }
              data.continueWatching = mergedCw;
            }
          }
        }
      } catch {}
      const orderRaw = orderRawInit;
      if (orderRaw) {
        try {
          const orderBlob = JSON.parse(orderRaw);
          if (Array.isArray(orderBlob.order)) {
            if (!data) data = { config: [], collapsedPanels: {}, likedLists: [], updatedAt: Date.now() };
            data.dashboardListOrder = orderBlob.order;
          }
        } catch {}
      }
      return jsonPrivate({ ok: true, data });
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
      if (!auth.ok) return authFailureResponse(auth);
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

    // /api/creator/sync/share-tracking  (POST)
    //   { creatorName, creatorKey, slug, shared } -> { ok, shared: {...} }
    //   { creatorName, creatorKey } (no slug)     -> { ok, shared: {...} }  (read current state)
    //
    // Owner-controlled opt-in for exposing Watchlist / Watch History /
    // Continue Watching at the public /lists/:username/:slug address.
    // Those three come out of the private `creatorsynctracking:` blob,
    // so they are NOT public by default and there is no way to make them
    // public except by an authenticated call here (see the gate in the
    // /lists/:username/:listname handler). Stored as its own small key
    // rather than inside the tracking blob itself, so that the frequent,
    // high-churn tracking writes (playback pings, scrobbles, the cron)
    // can never accidentally clobber a privacy setting in a
    // read-modify-write race.
    if (path === "/api/creator/sync/share-tracking" && request.method === "POST") {
      if (!env || !env.CONFIGS) return json({ ok: false, error: "no-kv" }, 500);
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const auth = await authenticateCreator(body.creatorName, body.creatorKey);
      if (!auth.ok) return authFailureResponse(auth);

      const shareKey = `creatorshare:${auth.username}`;
      let shared = {};
      try {
        const raw = await env.CONFIGS.get(shareKey);
        if (raw) shared = JSON.parse(raw) || {};
      } catch {
        shared = {};
      }

      // No slug -> read-only query of the current settings.
      const slug = String(body.slug || "").trim().toLowerCase();
      if (!slug) {
        return json({
          ok: true,
          shared: {
            "watchlist": shared["watchlist"] === true,
            "watch-history": shared["watch-history"] === true,
            "continue-watching": shared["continue-watching"] === true,
          },
        }, 200, { "Cache-Control": "no-store" });
      }

      const ALLOWED_SHARE_SLUGS = new Set(["watchlist", "watch-history", "continue-watching"]);
      if (!ALLOWED_SHARE_SLUGS.has(slug)) {
        return json({ ok: false, error: "That list cannot be shared this way." }, 400);
      }

      // Coerced to a real boolean -- the read side checks === true, so
      // anything else stored here would silently mean "not shared".
      shared[slug] = body.shared === true;
      await env.CONFIGS.put(shareKey, JSON.stringify(shared));

      return json({
        ok: true,
        shared: {
          "watchlist": shared["watchlist"] === true,
          "watch-history": shared["watch-history"] === true,
          "continue-watching": shared["continue-watching"] === true,
        },
      }, 200, { "Cache-Control": "no-store" });
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
        // Same index as /lists/public.json: searching used to scan at most
        // 80-250 keys, so lists outside that lexicographic window were
        // unfindable no matter what the user typed. The index also carries
        // the display fields, which removes the per-list getCreator lookup
        // that made this route's subrequest count scale with result size.
        const searchIndex = await getPublicListIndex(env, ctx);
        if (searchIndex) {
          const targetFilterIdx = (userTerm || (isMyListsSentinel ? "" : q)).replace(/@+/g, "").trim();
          const tokensIdx = targetFilterIdx.split(/\s+/).filter(Boolean);
          const matchesIdx = searchIndex
            .filter((e) => (e.itemCount || 0) > 0)
            .filter((e) => {
              if (!targetFilterIdx || !tokensIdx.length) return true;
              const fullText = `${e.name || ""} ${e.creatorName || ""} ${e.username || ""}`.toLowerCase();
              if (fullText.includes(targetFilterIdx)) return true;
              return tokensIdx.every((tok) => fullText.includes(tok));
            })
            .map((e) => ({
              name: e.name,
              type: e.type,
              items: e.itemCount || 0,
              likes: e.likes || 0,
              creatorName: e.isCreator ? (e.creatorName || e.username) : "Anonymous",
              username: e.isCreator ? e.username : "user",
              url: `${url.origin}/lists/${e.isCreator ? e.username : "user"}/${e.slug}`,
              source: "My Lists Addon",
            }))
            .sort((a, b) => {
              const likesDiff = (b.likes || 0) - (a.likes || 0);
              if (likesDiff !== 0) return likesDiff;
              return (b.items || 0) - (a.items || 0);
            });
          // Response shape is identical to the scan path below: key is
          // `lists`, entries carry `source`, and only the non-"my lists"
          // search is capped at 50.
          // A GET, so unlike the account endpoints this one really is stored
          // by browser and shared caches. At the inherited max-age=3600 a list
          // its owner had just made private stayed findable by search for an
          // hour after the API itself had stopped returning it. Matched to
          // /lists/public.json's own 120s, which is the same data.
          return json({ ok: true, lists: isMyListsSearch ? matchesIdx : matchesIdx.slice(0, 50) },
            200, { "Cache-Control": "public, max-age=60" });
        }

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
              await stampListVisibilityIfNeeded(env, k.name, data);
              if (!isPublicListVisibility(data.visibility)) return null;
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
              await stampListVisibilityIfNeeded(env, k.name, data);
              if (!isPublicListVisibility(data.visibility)) return null;
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
                const profileRaw = await getCreator(env, username);
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
        const tokens = targetFilter.split(/\s+/).filter(Boolean);
        const matches = [...anonCandidates, ...creatorCandidates]
          .filter(Boolean)
          .filter((l) => (l.items || 0) > 0)
          .filter((l) => {
            if (!targetFilter || !tokens.length) return true;
            const fullText = `${l.name || ""} ${l.creatorName || ""} ${l.username || ""} ${l.url || ""}`.toLowerCase();
            if (fullText.includes(targetFilter)) return true;
            return tokens.every((tok) => fullText.includes(tok));
          })
          .map((l) => ({ ...l, source: "My Lists Addon" }))
          .sort((a, b) => {
            const likesDiff = (b.likes || 0) - (a.likes || 0);
            if (likesDiff !== 0) return likesDiff;
            return (b.items || 0) - (a.items || 0);
          });
        return json({ ok: true, lists: isMyListsSearch ? matches : matches.slice(0, 50) },
          200, { "Cache-Control": "public, max-age=60" });
      } catch (err) {
        return json({ ok: false, error: safeErrorMessage(err) });
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
      // Validator-based caching instead of no-store -- see
      // htmlPageResponse (02_http-and-creator-utils.js). These shared list
      // pages are the ones people follow links to and press back from, and
      // each was resending ~1.6MB every time with nothing for the browser to
      // revalidate against. The ETag hashes the exact bytes returned, so a
      // 304 can only happen when the browser already holds this list.
      return await htmlPageResponse(
        request,
        renderBuilder(url.origin, {
          deepLinkList: {
            name: deslugifyServer(mdblistSlug),
            type: "movie",
            url: targetUrl,
            creatorName: mdblistUser,
            maybeMore: true,
          },
        }),
        { ...corsHeaders() }
      );
    }

    m = path.match(/^\/lists\/trakt\/([^/]+)\/([^/]+)(?:\.json)?$/i);
    if (m) {
      const traktUser = m[1];
      const traktSlug = m[2];
      const targetUrl = `https://trakt.tv/users/${traktUser}/lists/${traktSlug}`;
      ctx.waitUntil(bumpStat(env, "pageviews"));
      // Validator-based caching instead of no-store -- see
      // htmlPageResponse (02_http-and-creator-utils.js). These shared list
      // pages are the ones people follow links to and press back from, and
      // each was resending ~1.6MB every time with nothing for the browser to
      // revalidate against. The ETag hashes the exact bytes returned, so a
      // 304 can only happen when the browser already holds this list.
      return await htmlPageResponse(
        request,
        renderBuilder(url.origin, {
          deepLinkList: {
            name: deslugifyServer(traktSlug),
            type: "movie",
            url: targetUrl,
            creatorName: traktUser,
            maybeMore: true,
          },
        }),
        { ...corsHeaders() }
      );
    }

    m = path.match(/^\/lists\/tmdb\/collection\/([0-9]+)(?:-([a-z0-9_-]+))?(?:\.json)?$/i);
    if (m) {
      const tmdbId = m[1];
      const targetUrl = `https://www.themoviedb.org/collection/${tmdbId}`;
      const name = m[2] ? deslugifyServer(m[2]) : `TMDB Collection ${tmdbId}`;
      ctx.waitUntil(bumpStat(env, "pageviews"));
      // Validator-based caching instead of no-store -- see
      // htmlPageResponse (02_http-and-creator-utils.js). These shared list
      // pages are the ones people follow links to and press back from, and
      // each was resending ~1.6MB every time with nothing for the browser to
      // revalidate against. The ETag hashes the exact bytes returned, so a
      // 304 can only happen when the browser already holds this list.
      return await htmlPageResponse(
        request,
        renderBuilder(url.origin, {
          deepLinkList: {
            name,
            type: "movie",
            url: targetUrl,
            creatorName: "TMDB",
            maybeMore: true,
          },
        }),
        { ...corsHeaders() }
      );
    }

    m = path.match(/^\/lists\/tmdb\/([0-9]+)(?:-([a-z0-9_-]+))?(?:\.json)?$/i);
    if (m) {
      const tmdbId = m[1];
      const targetUrl = `https://www.themoviedb.org/list/${tmdbId}`;
      const name = m[2] ? deslugifyServer(m[2]) : `TMDB List ${tmdbId}`;
      ctx.waitUntil(bumpStat(env, "pageviews"));
      // Validator-based caching instead of no-store -- see
      // htmlPageResponse (02_http-and-creator-utils.js). These shared list
      // pages are the ones people follow links to and press back from, and
      // each was resending ~1.6MB every time with nothing for the browser to
      // revalidate against. The ETag hashes the exact bytes returned, so a
      // 304 can only happen when the browser already holds this list.
      return await htmlPageResponse(
        request,
        renderBuilder(url.origin, {
          deepLinkList: {
            name,
            type: "movie",
            url: targetUrl,
            creatorName: "TMDB",
            maybeMore: true,
          },
        }),
        { ...corsHeaders() }
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
            if (parsed) {
              await stampListVisibilityIfNeeded(env, k, parsed);
              if (isPublicListVisibility(parsed.visibility)) {
                listData = parsed;
                isCreatorList = k.startsWith("creatorlist:");
              }
            }
          } catch {}
        }
      }
      // Watchlist / Watch History / Continue Watching are NOT ordinary
      // published lists -- they live in `creatorsynctracking:{username}`,
      // which is the account's PRIVATE sync blob, written only by the
      // authenticated /api/creator/sync/save-tracking. This route has no
      // authentication at all (it's the public share-a-list page), so
      // reading that blob here used to hand any anonymous caller the
      // complete viewing history of any account whose username they knew
      // -- and usernames are published by /lists/public.json for every
      // shared list, so they didn't even need guessing.
      //
      // The blob has no `visibility` field to check (it isn't a list), so
      // there is nothing here that could have failed closed on its own.
      // Sharing is now strictly opt-in per slug, recorded in
      // `creatorshare:{username}` by the owner via
      // /api/creator/sync/share-tracking. Absent key, unparseable key, or
      // a slug not explicitly set to boolean true => not shared, and this
      // block does nothing at all (the request then 404s below exactly as
      // it does for any other unknown list).
      if (listName === "watchlist" || listName === "watch-history" || listName === "continue-watching") {
        let sharedSlugs = {};
        try {
          const shareRaw = await env.CONFIGS.get(`creatorshare:${username}`);
          if (shareRaw) sharedSlugs = JSON.parse(shareRaw) || {};
        } catch {
          sharedSlugs = {};
        }
        // Strict === true: a truthy string/number from a hand-edited or
        // legacy value must not be enough to expose someone's history.
        if (sharedSlugs[listName] === true) {
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
                  // A genuine published Custom List that happens to be
                  // named "Watchlist" and is currently empty gets its
                  // items filled in from tracking. Also gated -- this
                  // path copies the same private data into a public
                  // response, so it cannot be allowed without opt-in
                  // either.
                  listData.items = items;
                }
              }
            } catch {}
          }
        }
      }
      if (!listData) {
        return json({ ok: false, error: "No list found at that address." }, 404);
      }
      let creatorDisplayName = "Anonymous";
      if (isCreatorList) {
        creatorDisplayName = username;
        try {
          const profileRaw = await getCreator(env, username);
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
      // Validator-based caching instead of no-store -- see
      // htmlPageResponse (02_http-and-creator-utils.js). These shared list
      // pages are the ones people follow links to and press back from, and
      // each was resending ~1.6MB every time with nothing for the browser to
      // revalidate against. The ETag hashes the exact bytes returned, so a
      // 304 can only happen when the browser already holds this list.
      return await htmlPageResponse(
        request,
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
        { ...corsHeaders() }
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

    // /admin/api/migrate-d1 (POST) -> { ok, done, results, thisCall, scanned }
    // Backfills creators, creator_lists, published-list visibility stamps,
    // source_groups and the stats counters from KV to D1.
    //
    // ONE BOUNDED CHUNK PER CALL, not the whole sweep: a KV read plus a D1
    // write per key both count against Cloudflare's 1,000-subrequest limit,
    // and the previous single-pass version simply aborted partway through on
    // any site large enough to actually need migrating -- backfilling a
    // prefix of the data and reporting ok. See MIGRATE_D1_* (00_constants.js)
    // for why that particular half-finished state is dangerous rather than
    // merely incomplete.
    //
    // Keep calling until `done` is true; runMigrateD1 (03_admin.js) does that
    // loop. `results` is cumulative across the whole run, `thisCall` is just
    // this chunk. Still safe to run repeatedly from scratch: every write here
    // is idempotent.
    if (path === "/admin/api/migrate-d1" && request.method === "POST") {
      const authed = await isAdminRequest(request, env);
      if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
      if (!env || !env.DB || !env.CONFIGS) return json({ ok: false, error: "No D1 or KV binding." }, 500);

      // Every KV read/write and every D1 statement goes through these, so the
      // budget reflects what was actually spent rather than a guess.
      let ops = 0;
      const spent = () => ops >= MIGRATE_D1_OPS_PER_RUN;
      const countedKv = {
        get: (...a) => { ops++; return env.CONFIGS.get(...a); },
        put: (...a) => { ops++; return env.CONFIGS.put(...a); },
        delete: (...a) => { ops++; return env.CONFIGS.delete(...a); },
        list: (...a) => { ops++; return env.CONFIGS.list(...a); },
      };
      // stampListVisibilityIfNeeded writes through env.CONFIGS itself.
      const countedEnv = { ...env, CONFIGS: countedKv };
      const d1Run = (stmt) => { ops++; return stmt.run(); };

      ops++;
      const stateRaw = await env.CONFIGS.get(MIGRATE_D1_STATE_KEY);
      let state = null;
      try {
        state = stateRaw ? JSON.parse(stateRaw) : null;
      } catch {
        state = null;
      }
      // Anything unparseable or from an older shape restarts the sweep rather
      // than resuming into the middle of it. Restarting is cheap here because
      // every write is idempotent.
      if (!state || state.v !== 1 || typeof state.phase !== "number" || !Array.isArray(state.pending) || !state.results) {
        state = {
          v: 1,
          phase: 0,
          cursor: "",
          pending: [],
          scanned: 0,
          results: { creators: 0, lists: 0, published: 0, sourcegroups: 0, stats: 0, skipped: 0, errors: [] },
        };
      }
      const results = state.results;
      if (typeof results.skipped !== "number") results.skipped = 0;
      const thisCall = { creators: 0, lists: 0, published: 0, sourcegroups: 0, stats: 0, skipped: 0 };
      // A key this sweep looked at and deliberately did not migrate. These
      // used to vanish: `if (!raw) return;`, a key that failed its shape
      // check, a counter whose value was not a number -- each returned with
      // no counter touched and no error recorded, so the endpoint answered
      // ok:true with an empty errors array whether or not records had been
      // dropped on the floor.
      const noteSkipped = () => { results.skipped++; thisCall.skipped++; };
      // meta.changes, not "we got here". Every counter below used to
      // increment once per key PROCESSED, including the ones that hit a
      // DO NOTHING conflict and wrote nothing, so `{"creators": 60}` did not
      // mean sixty rows had been written.
      const wrote = (res) => !!(res && res.meta && res.meta.changes > 0);
      const noteError = (msg) => {
        if (results.errors.length < MIGRATE_D1_ERROR_CAP) results.errors.push(msg);
      };

      async function migrateKey(phase, keyName) {
        // 0. Creators
        if (phase === 0) {
          const username = keyName.slice("creator:".length);
          const raw = await countedKv.get(keyName);
          if (!raw) { noteSkipped(); return; }
          try {
            const data = JSON.parse(raw);
            // DO UPDATE, not DO NOTHING. This endpoint's stated job is to
            // reconcile KV into D1, and DO NOTHING meant it could create a
            // row but never correct one -- so a D1 `creators` row whose
            // key_hash had drifted from KV stayed wrong forever, and since
            // getCreator falls back to D1 the only tool for repairing that
            // state could not repair it. Every column written here is
            // derived purely from KV, which is authoritative for all three,
            // so re-running remains idempotent.
            //
            // created_at is deliberately left out of the update: KV's
            // createdAt may be missing on a legacy record, and `|| 0` would
            // then overwrite a good creation date with zero. last_active is
            // not written here at all, so it survives too.
            const d1Res = await d1Run(env.DB.prepare(
              "INSERT INTO creators (username, display_name, key_hash, recovery_answer_hash, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(username) DO UPDATE SET display_name=excluded.display_name, key_hash=excluded.key_hash, recovery_answer_hash=excluded.recovery_answer_hash"
            ).bind(username, data.displayName || username, data.keyHash || "", data.recoveryAnswerHash || null, data.createdAt || 0));
            if (wrote(d1Res)) { results.creators++; thisCall.creators++; } else { noteSkipped(); }
          } catch (e) {
            noteError(`Creator ${username}: ` + e.message);
          }
          return;
        }

        // 1. Creator Lists
        if (phase === 1) {
          // Two capture groups, so they are match[1] and match[2]. The old
          // `[, , u, slug]` skipped one element too many: slug came out
          // undefined, the `if (u && slug)` guard below rejected every key,
          // and the migration silently reported "lists: 0" while claiming ok.
          const [, u, slug] = keyName.match(/^creatorlist:([^:]+):(.+)$/) || [];
          if (!u || !slug) { noteSkipped(); return; }
          const raw = await countedKv.get(keyName);
          if (!raw) { noteSkipped(); return; }
          try {
            const data = JSON.parse(raw);
            await stampListVisibilityIfNeeded(countedEnv, keyName, data);
            const listId = `${u}:${slug}`;
            const itemsJson = JSON.stringify(data.items || []);
            const vis = isPublicListVisibility(data.visibility) ? "public" : "private";
            // Every column this endpoint can derive from KV is rewritten on
            // conflict, not just two of them.
            //
            // `likes` and `visibility` were always here -- omitting `likes`
            // would reset every count to zero in D1, and rewriting
            // `visibility` is what stops the fail-closed public index hiding
            // legacy lists that had no enum value. `name`, `type`,
            // `items_json` and `updated_at` were not, and that was the same
            // DO NOTHING disease this endpoint's creators branch was fixed
            // for, one branch further down: an existing row could be created
            // but never corrected.
            //
            // It is reachable in ordinary operation. /api/creator/lists/save
            // writes D1 inside a catch that logs and carries on, so one D1
            // blip during an edit leaves the mirror holding the pre-edit name
            // and items forever -- shown in the admin Community Lists panel
            // and the leaderboard, and served by getCreatorList's fallback if
            // the KV record is ever missing. The documented repair tool could
            // not repair it.
            //
            // All six are derived purely from KV, which is authoritative for
            // every one of them, so re-running is still idempotent.
            // `created_at` stays out for the reason the creators branch gives:
            // a legacy record with no createdAt would overwrite a good
            // creation date with zero.
            const listRes = await d1Run(env.DB.prepare(
              "INSERT INTO creator_lists (id, username, name, type, visibility, items_json, likes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, type=excluded.type, visibility=excluded.visibility, items_json=excluded.items_json, likes=excluded.likes, updated_at=excluded.updated_at"
            ).bind(listId, u, data.name || "List", data.type || "mixed", vis, itemsJson, Math.max(0, Number(data.likes) || 0), data.createdAt || 0, data.updatedAt || 0));
            if (wrote(listRes)) { results.lists++; thisCall.lists++; } else { noteSkipped(); }
          } catch (e) {
            noteError(`List ${u}:${slug}: ` + e.message);
          }
          return;
        }

        // 2. Anonymous published lists live only in KV. Stamp missing /
        // garbage visibility the same way as creator lists so the inverted
        // public-read checks don't hide currently-served lists.
        if (phase === 2) {
          const raw = await countedKv.get(keyName);
          if (!raw) { noteSkipped(); return; }
          try {
            const data = JSON.parse(raw);
            await stampListVisibilityIfNeeded(countedEnv, keyName, data);
            results.published++; thisCall.published++;
          } catch (e) {
            noteError(`Published ${keyName}: ` + e.message);
          }
          return;
        }

        // 3. Source Groups
        if (phase === 3) {
          if (!keyName.endsWith(":total")) return;
          const groupName = keyName.slice("stats:sourcegroup:".length, -":total".length);
          const raw = await countedKv.get(keyName);
          const count = parseInt(raw || "0", 10);
          try {
            const sgRes = await d1Run(env.DB.prepare(
              "INSERT INTO source_groups (id, name, install_count) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET install_count = excluded.install_count"
            ).bind(groupName, groupName, count));
            if (wrote(sgRes)) { results.sourcegroups++; thisCall.sourcegroups++; } else { noteSkipped(); }
          } catch (e) {
            noteError(`Sourcegroup ${groupName}: ` + e.message);
          }
          return;
        }

        // 4. Counters (stats:{kind}:{total|YYYY-MM-DD} -> the stats table)
        //
        // Until these are copied across, each counter falls back to its KV
        // value rather than reporting zero (see readStatCount, 03_admin.js),
        // so a dashboard's history never visibly vanishes just because D1 got
        // bound. After this runs, D1 is authoritative and the KV copies are
        // inert.
        //
        // DO NOTHING on conflict, not "n = n + excluded.n": this endpoint is
        // safe to run more than once (the admin button can be pressed again,
        // and every other section is idempotent too), and an additive upsert
        // here would double every counter on the second run. sourcegroup: is
        // skipped -- phase 3 above already migrated it into its own table,
        // and copying it here too would count it twice in the Installed
        // Catalogs panel, which sums both.
        const rest = keyName.slice("stats:".length);
        const sep = rest.lastIndexOf(":");
        if (sep === -1) return;
        const kind = rest.slice(0, sep);
        const bucket = rest.slice(sep + 1);
        if (!kind || !bucket) return;
        // Not "skipped": phase 3 has already migrated these into their own
        // table, and counting them here would report them twice.
        if (kind.startsWith("sourcegroup:") || kind === "sourcegroup") return;
        // Only the numeric counters. stats:genres:alltime and
        // stats:decades:alltime are JSON blobs, and
        // stats:genredecade:migrated is a sentinel -- none of them belong
        // in an integer column.
        if (bucket !== "total" && !/^\d{4}-\d{2}-\d{2}$/.test(bucket)) return;
        const raw = await countedKv.get(keyName);
        const n = parseInt(raw, 10);
        if (!Number.isFinite(n)) { noteSkipped(); return; }
        try {
          const statRes = await d1Run(env.DB.prepare(
            "INSERT INTO stats (kind, day, n) VALUES (?, ?, ?) ON CONFLICT(kind, day) DO NOTHING"
          ).bind(kind, bucket, n));
          // DO NOTHING on conflict, so a second run legitimately writes
          // nothing -- that is "already migrated", not "skipped".
          if (wrote(statRes)) { results.stats++; thisCall.stats++; }
        } catch (e) {
          noteError(`Stat ${keyName}: ` + e.message);
        }
      }

      let scannedThisCall = 0;
      while (state.phase < MIGRATE_D1_PREFIXES.length && !spent()) {
        if (!state.pending.length) {
          if (state.cursor === null) {
            state.phase++;
            state.cursor = "";
            continue;
          }
          const listOpts = { prefix: MIGRATE_D1_PREFIXES[state.phase], limit: MIGRATE_D1_PAGE };
          if (state.cursor) listOpts.cursor = state.cursor;
          const listRes = await countedKv.list(listOpts);
          state.pending = (listRes.keys || []).map((k) => k.name);
          state.cursor = (listRes.list_complete || !listRes.cursor) ? null : listRes.cursor;
          if (!state.pending.length) continue;
        }
        // shift() as we go, so whatever is left in `pending` when the budget
        // runs out is exactly what this run still owes.
        while (state.pending.length && !spent()) {
          const keyName = state.pending.shift();
          await migrateKey(state.phase, keyName);
          scannedThisCall++;
        }
      }

      state.scanned = (state.scanned || 0) + scannedThisCall;
      const done = state.phase >= MIGRATE_D1_PREFIXES.length;
      if (done) {
        try {
          await env.CONFIGS.delete(MIGRATE_D1_STATE_KEY);
        } catch {
          // A stranded state key only costs the next run a restart, and
          // every write in the sweep is idempotent.
        }
      } else {
        await env.CONFIGS.put(MIGRATE_D1_STATE_KEY, JSON.stringify(state));
      }

      return json({ ok: true, done, results, thisCall, scanned: state.scanned });
    }

    // /admin/api/rebuild-public-index  (POST) -> { ok, done, count, scanned, ms }
    // Drives a rebuild of index:publiclists (see getPublicListIndex/
    // rebuildPublicListIndex, 02_http-and-creator-utils.js) on demand
    // instead of waiting for it to happen lazily. Without this, a fresh
    // deployment -- or the index key being lost some other way -- serves
    // every visitor of /lists/public.json and list search a truncated,
    // lexicographically-biased result (capped at 150/250/80 keys) until
    // the build finishes. scheduled() below drives the same build
    // automatically whenever the index is found missing (self-healing
    // without any admin action), so this endpoint is for an immediate,
    // verifiable seed right after a fresh deploy rather than the only way
    // it happens.
    //
    // ONE CHUNK PER CALL, not a full rebuild: the scan is bounded by
    // Cloudflare's 1,000-subrequest limit and a large deployment needs
    // several passes. Keep calling until `done` is true -- exactly like
    // /admin/api/migrate-day-counts, and runRebuildPublicIndex (03_admin.js)
    // does that loop for you. A chunk here gets a bigger op budget than the
    // cron's, since this request has the invocation to itself. Safe to run
    // any time, repeatedly: progress is idempotent and the live index is
    // only replaced once the final chunk lands.
    if (path === "/admin/api/rebuild-public-index" && request.method === "POST") {
      const authed = await isAdminRequest(request, env);
      if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
      if (!env || !env.CONFIGS) return json({ ok: false, error: "no-kv" });
      const started = Date.now();
      try {
        const res = await rebuildPublicListIndex(env, { opBudget: PUBLIC_INDEX_BUILD_OPS_ADMIN });
        return json({
          ok: true,
          done: !!res.done,
          count: res.entriesSoFar,
          scanned: res.scanned,
          ms: Date.now() - started,
        });
      } catch (e) {
        return json({ ok: false, error: "Rebuild failed: " + (e && e.message ? e.message : String(e)) }, 500);
      }
    }

    // /admin/api/migrate-day-counts  (POST) -> { ok, done, keysMigratedThisCall }
    // One-time migration for the switch (see recordTrackedEvent's own
    // comment) from one KV key per (eventType/query, id, day) to one JSON
    // blob per (eventType/query, id) holding every day's count. Old
    // per-day keys are still sitting in KV from before that switch --
    // this reads them, folds each into the corresponding new blob (merging
    // with whatever's already there from live tracking since the switch,
    // never overwriting), and deletes the old key once it's safely folded
    // in. Deleting as it goes is what makes this safe to run repeatedly:
    // a second run finds nothing left to migrate and reports done
    // immediately, the same idempotent shape backfill-trending above has.
    // Same paginated-cursor pattern as that endpoint too, for the same
    // reason -- covers three prefixes in sequence (evtcount:watched:,
    // evtcount:list-add:, searchquery:), storing which prefix and how far
    // into its key list this run has reached in migratedaycounts:state so
    // repeated calls make forward progress without redoing work.
    // /admin/api/delete-creator-list  (POST)  { username, slugs: [...] }
    //   -> { ok, deleted: [...], missing: [...], remaining }
    // Admin-only removal of one creator's lists, for cleaning up content the
    // owner cannot or will not remove themselves -- and, in particular, for
    // clearing PHANTOM directory entries: a list whose index entry survived
    // but whose record is gone advertises an item count and then 404s when
    // opened, and until now there was no way to get rid of one at all. Slugs
    // whose record has already vanished still come out of the index, and are
    // reported back under `missing` rather than treated as an error.
    //
    // Deliberately per-list rather than per-creator: "delete this account's
    // lists" is what /api/creator/delete-account already does, with the
    // account's own key. This is a scalpel, and it is irreversible -- there is
    // no undo and no backup of a deleted list.
    //
    // Goes through the same deleteCreatorLists the creator's own delete route
    // uses, so an admin deletion cannot clean up differently (or less
    // thoroughly) than the owner's does.
    if (path === "/admin/api/delete-creator-list" && request.method === "POST") {
      const authed = await isAdminRequest(request, env);
      if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
      if (!env || !env.CONFIGS) return json({ ok: false, error: "no-kv" });
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const v = validateCreatorUsername(body.username);
      if (!v.ok) return json({ ok: false, error: "Invalid username." }, 400);

      // Accepts one slug or many; both shapes end up as a bounded list.
      const rawSlugs = Array.isArray(body.slugs)
        ? body.slugs
        : (body.slug ? [body.slug] : []);
      const slugs = [...new Set(
        rawSlugs.map((x) => String(x || "").trim().toLowerCase()).filter(Boolean)
      )];
      if (!slugs.length) return json({ ok: false, error: "No slugs given." }, 400);
      if (slugs.length > ADMIN_LIST_DELETE_MAX) {
        return json({
          ok: false,
          error: `Too many lists in one request (limit ${ADMIN_LIST_DELETE_MAX}). Send them in batches.`,
        }, 413);
      }

      const result = await deleteCreatorLists(env, v.normalized, slugs);
      // How many that creator has left, so the caller can tell when a
      // multi-batch cleanup is finished without guessing.
      let remaining = null;
      try {
        const listed = await listAllKeys(env.CONFIGS, `creatorlist:${v.normalized}:`, 1000);
        remaining = listed.keys.length;
      } catch (e) {
        remaining = null;
      }
      // Same rule as the creator-facing sibling: a sweep that left the record
      // or the directory entry behind is not a deletion, and an admin
      // clearing something up is the last person who should be told it
      // worked when it did not. `deleted` is still reported so a partial
      // batch is legible.
      if (!result.ok) {
        return json({
          ok: false,
          error: "Couldn't finish deleting those lists. Some may still be visible -- please try again in a moment.",
          username: v.normalized,
          deleted: result.deleted,
          missing: result.missing,
          remaining,
        }, 500, { "Cache-Control": "no-store" });
      }
      return json({
        ok: true,
        username: v.normalized,
        deleted: result.deleted,
        missing: result.missing,
        remaining,
      }, 200, { "Cache-Control": "no-store" });
    }

    if (path === "/admin/api/migrate-day-counts" && request.method === "POST") {
      const authed = await isAdminRequest(request, env);
      if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
      if (!env || !env.CONFIGS) return json({ ok: true, done: true, keysMigratedThisCall: 0 });

      const PREFIXES = ["evtcount:watched:", "evtcount:list-add:", "searchquery:"];
      const BATCH_LIMIT = 100;

      let state;
      try {
        const stateRaw = await env.CONFIGS.get("migratedaycounts:state");
        state = stateRaw ? JSON.parse(stateRaw) : { prefixIndex: 0, cursor: null };
      } catch {
        state = { prefixIndex: 0, cursor: null };
      }

      if (state.prefixIndex >= PREFIXES.length) {
        return json({ ok: true, done: true, keysMigratedThisCall: 0 });
      }

      const prefix = PREFIXES[state.prefixIndex];
      const listOpts = { prefix, limit: BATCH_LIMIT };
      if (state.cursor) listOpts.cursor = state.cursor;
      const listResult = await env.CONFIGS.list(listOpts);

      // Old per-day keys only -- the running total (:alltime) and the
      // new blob format itself (:days) share this same prefix and would
      // otherwise get misread as if "alltime" or "days" were date strings.
      const dayKeyPattern = /^\d{4}-\d{2}-\d{2}$/;
      const oldDayKeys = listResult.keys.filter((k) => {
        const rest = k.name.slice(prefix.length);
        const lastColon = rest.lastIndexOf(":");
        if (lastColon === -1) return false;
        return dayKeyPattern.test(rest.slice(lastColon + 1));
      });

      // Group by id first so a title/query with many old day-keys in this
      // batch costs one blob read-modify-write, not one per day.
      const byId = new Map(); // id -> { day: count, ... } (partial, this batch only)
      oldDayKeys.forEach((k) => {
        const rest = k.name.slice(prefix.length);
        const lastColon = rest.lastIndexOf(":");
        const id = rest.slice(0, lastColon);
        const day = rest.slice(lastColon + 1);
        if (!byId.has(id)) byId.set(id, {});
        byId.get(id)[day] = k.name; // stash the real key name for the read pass below
      });

      let keysMigratedThisCall = 0;
      await Promise.all(
        [...byId.entries()].map(async ([id, dayKeyNames]) => {
          const days = Object.keys(dayKeyNames);
          const [oldValues, existingBlobRaw] = await Promise.all([
            Promise.all(days.map((d) => env.CONFIGS.get(dayKeyNames[d]))),
            env.CONFIGS.get(`${prefix}${id}:days`),
          ]);
          let blob;
          try {
            blob = existingBlobRaw ? JSON.parse(existingBlobRaw) : {};
          } catch {
            blob = {};
          }
          days.forEach((d, i) => {
            const oldCount = parseInt(oldValues[i], 10) || 0;
            if (oldCount <= 0) return;
            // Additive, not overwrite -- if live tracking already wrote
            // something for this exact id+day since the format switch,
            // that count is just as real as the migrated one.
            blob[d] = (blob[d] || 0) + oldCount;
          });
          const dayKeysSorted = Object.keys(blob).sort();
          if (dayKeysSorted.length > 95) {
            dayKeysSorted.slice(0, dayKeysSorted.length - 95).forEach((k) => delete blob[k]);
          }
          await env.CONFIGS.put(`${prefix}${id}:days`, JSON.stringify(blob), { expirationTtl: TELEMETRY_DAY_TTL_SEC });
          await Promise.all(days.map((d) => env.CONFIGS.delete(dayKeyNames[d])));
          keysMigratedThisCall += days.length;
        })
      );

      const prefixDone = listResult.list_complete || !listResult.cursor;
      const nextState = prefixDone
        ? { prefixIndex: state.prefixIndex + 1, cursor: null }
        : { prefixIndex: state.prefixIndex, cursor: listResult.cursor };
      await env.CONFIGS.put("migratedaycounts:state", JSON.stringify(nextState));

      const done = nextState.prefixIndex >= PREFIXES.length;
      return json({ ok: true, done, keysMigratedThisCall, prefix, prefixDone });
    }

    // /admin/api/feedback -> { ok, entries } -- backs the Feedback tab,
    // newest first. Keys sort chronologically (see /api/feedback), so
    // list() is oldest-first: walk pages keeping a rolling tail, then
    // GET only the newest FEEDBACK_ADMIN_GET_CAP. Getting every thread
    // used to grow without bound (no TTL, no prune).
    if (path === "/admin/api/feedback" && request.method === "GET") {
      const authed = await isAdminRequest(request, env);
      if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
      if (!env || !env.CONFIGS) return json({ ok: true, entries: [] }, 200, { "Cache-Control": "no-store" });
      let newestKeys = [];
      let cursor = undefined;
      let listComplete = false;
      let pages = 0;
      let sawMore = false;
      while (!listComplete && pages < 30) {
        const listResult = await env.CONFIGS.list({ prefix: "feedback:", limit: 1000, cursor });
        newestKeys.push(...(listResult.keys || []));
        if (newestKeys.length > FEEDBACK_ADMIN_GET_CAP) {
          newestKeys = newestKeys.slice(-FEEDBACK_ADMIN_GET_CAP);
          sawMore = true;
        }
        pages++;
        if (listResult.list_complete || !listResult.cursor) {
          listComplete = true;
        } else {
          cursor = listResult.cursor;
        }
      }
      const truncated = !listComplete || sawMore;
      const keys = newestKeys.slice().reverse();
      const entries = await Promise.all(
        keys.map(async (k) => {
          try {
            const raw = await env.CONFIGS.get(k.name);
            if (!raw) return null;
            const entry = JSON.parse(raw);
            if (!Array.isArray(entry.messages) || !entry.messages.length) {
              entry.messages = [{
                id: `msg_init`,
                sender: "user",
                senderName: entry.creatorName || "User",
                text: entry.message || "(Initial message)",
                timestamp: entry.createdAt || Date.now()
              }];
            }
            return entry;
          } catch {
            return null;
          }
        })
      );
      return json({ ok: true, entries: entries.filter(Boolean), truncated: !!truncated }, 200, { "Cache-Control": "no-store" });
    }

    // /admin/api/feedback/reply  (POST)  { id, message } -> { ok, entry }
    // Allows admin to send a threaded reply back to the user.
    if (path === "/admin/api/feedback/reply" && request.method === "POST") {
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
      const message = String(body.message || "").trim();
      if (!id) return json({ ok: false, error: "Missing thread id." }, 400);
      if (!message) return json({ ok: false, error: "Reply message can't be empty." }, 400);

      const key = `feedback:${id}`;
      const raw = await env.CONFIGS.get(key);
      if (!raw) return json({ ok: false, error: "Feedback thread not found." }, 404);
      let entry;
      try {
        entry = JSON.parse(raw);
      } catch {
        return json({ ok: false, error: "Could not parse feedback thread." }, 500);
      }

      if (!Array.isArray(entry.messages) || !entry.messages.length) {
        // sender here mirrors renderFeedbackList's own fallback logic
        // (isSelfLogged ? 'admin' : 'user') -- this used to be hardcoded
        // to "user" unconditionally, which meant a self-logged "Log
        // something yourself" entry's original message would flip to
        // showing as if a user had written it the moment it got its
        // first reply, instead of staying attributed to the admin.
        entry.messages = [{
          id: `msg_init`,
          sender: entry.creatorName === "admin" ? "admin" : "user",
          senderName: entry.creatorName === "admin" ? "Admin" : (entry.creatorName || "User"),
          text: entry.message || "(Initial message)",
          timestamp: entry.createdAt || Date.now()
        }];
      }

      const replyMsg = {
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        sender: "admin",
        senderName: "Developer",
        text: message,
        timestamp: Date.now()
      };
      entry.messages.push(replyMsg);
      entry.updatedAt = Date.now();
      entry.status = "replied";
      entry.completed = false;

      try {
        await putFeedbackThread(env, key, entry);
      } catch (e) {
        return json({ ok: false, error: "Could not save reply." }, 500);
      }
      return json({ ok: true, entry }, 200, { "Cache-Control": "no-store" });
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
        await putFeedbackThread(env, key, entry);
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
        const trimmedMessage = body.message.trim().slice(0, 4000);
        entry.message = trimmedMessage;
        // Once a reply has landed on this entry (self-logged or not), the
        // dashboard list renders from entry.messages[...] instead of the
        // top-level entry.message that this edit form actually posts (see
        // renderFeedbackList's own fallback: it only synthesizes a single
        // message from entry.message when entry.messages is empty).
        // Editing only entry.message left it invisible on any entry that
        // already had a thread -- the save genuinely succeeded, nothing
        // in the list ever reflected it. Keeping the first message in the
        // thread (the original log/report) in sync fixes that regardless
        // of which shape a given entry happens to be in.
        if (Array.isArray(entry.messages) && entry.messages.length && entry.messages[0]) {
          entry.messages[0].text = trimmedMessage;
        }
      }
      if (typeof body.category === "string" && ["bug", "improvement", "idea", "other"].includes(body.category.trim())) {
        entry.category = body.category.trim();
      }
      entry.updatedAt = Date.now();
      try {
        await putFeedbackThread(env, key, entry);
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
        const data = await computeCatalogAndCommunityLeaderboards(env, ctx);
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
        return json({ ok: false, error: safeErrorMessage(err) });
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
        return json({ ok: false, error: safeErrorMessage(err) });
      }
    }

    if (path === "/admin/login" && request.method === "POST") {
      if (!env || !env.ADMIN_KEY) {
        return new Response(
          renderAdminLoginPage("This Worker has no ADMIN_KEY secret set -- run `wrangler secret put ADMIN_KEY` (or set it in the Cloudflare dashboard) first."),
          { status: 500, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
        );
      }
      // Every other credential-bearing endpoint in this app (creator
      // create/restore/reset-key) rate-limits guesses by IP -- this one
      // never did, despite guarding the one secret that can rotate any
      // creator's key via /admin/api/reset-creator-key with no other
      // verification. Same pattern as /api/creator/restore: a per-IP
      // counter with a 60s window. Skipped entirely (not failed closed)
      // when CONFIGS isn't bound, matching every other KV-optional
      // feature in this app -- login by ADMIN_KEY alone still works.
      // Failed closed when CONFIGS IS bound but CF-Connecting-IP is
      // missing, same as restore, because there is no other safe
      // per-client identity to key a shared bucket on.
      // Set inside the KV branch below and read again after the compare, so
      // only a genuine wrong key spends the daily budget.
      let adminLoginFailScope = "";
      let adminLoginFailDay = "";
      if (env.CONFIGS) {
        const ip = clientIpKey(request);
        if (!ip) {
          return new Response(renderAdminLoginPage("Could not process this request."), {
            status: 400,
            headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
          });
        }
        const rateLimitKey = `ratelimit:adminlogin:${ip}`;
        const attempts = parseInt((await env.CONFIGS.get(rateLimitKey)) || "0", 10);
        if (attempts >= 10) {
          return new Response(renderAdminLoginPage("Too many attempts. Please wait a minute and try again."), {
            status: 429,
            headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
          });
        }
        await env.CONFIGS.put(rateLimitKey, String(attempts + 1), { expirationTtl: 60 });

        // The 60s bucket above shapes a burst but leans on a KV counter that
        // is edge-cached and non-atomic, so it is not the only thing that
        // should stand in front of ADMIN_KEY. This daily budget is spent on
        // failures only and is atomic wherever D1 is bound.
        adminLoginFailScope = `adminlogin:${ip}`;
        adminLoginFailDay = statsToday();
        if (await readAuthFailureCount(env, adminLoginFailScope, adminLoginFailDay) >= ADMIN_LOGIN_MAX_FAILURES_PER_DAY) {
          return new Response(renderAdminLoginPage("Too many failed attempts today. Please try again tomorrow."), {
            status: 429,
            headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
          });
        }
      }
      let submittedKey = "";
      try {
        const form = await request.formData();
        submittedKey = String(form.get("key") || "");
      } catch {
        // falls through with an empty key, which will fail the compare below
      }
      if (!timingSafeEqualHex(submittedKey, env.ADMIN_KEY)) {
        // Failures only -- a correct key must never spend the budget that
        // protects it, or an admin who logs in often would lock themselves
        // out.
        if (adminLoginFailScope) await noteAuthFailure(env, adminLoginFailScope, adminLoginFailDay);
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
      // Parsed separately from the work below so a malformed body returns
      // the same 400 + generic message every other route uses, instead of
      // falling into the catch and echoing the raw SyntaxError (which
      // included the caller's own payload) back at HTTP 500.
      let bulkBody;
      try {
        bulkBody = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      if (!bulkBody || !Array.isArray(bulkBody.items)) {
        return json({ ok: false, error: "Expected an `items` array." }, 400);
      }
      // Unauthenticated, and unlike every other TMDB route here this one
      // has no per-user key override at all -- it ALWAYS spends the Worker
      // owner's shared TMDB_API_KEY (see the comment on tmdbCallCount
      // below). Two things were missing:
      //
      // 1. A bound on `items`. The loop below issues up to two TMDB calls
      //    per item, so a single request with a few thousand items blew
      //    straight past Cloudflare's per-invocation subrequest limit --
      //    which meant large Letterboxd imports were already failing here
      //    -- while spending the owner's TMDB quota on the way.
      // 2. A rate limit, so the same request cannot simply be repeated.
      //
      // The cap rejects rather than truncates: silently resolving the
      // first N films of an import and dropping the rest is exactly the
      // kind of quiet data loss this audit was about. The client chunks
      // its own requests to this size (see resolveViaBulkResolve,
      // 18_client-copy-and-trakt-export.js), so a real import of any size
      // still completes -- it just arrives as several bounded calls.
      const bulkIp = clientIpKey(request);
      if (!bulkIp) return json({ ok: false, error: "Could not resolve those titles." }, 400);
      if (bulkBody.items.length > BULK_RESOLVE_ITEMS_MAX) {
        return json({ ok: false, error: `Too many titles in one request (limit ${BULK_RESOLVE_ITEMS_MAX}).` }, 413);
      }
      if (await consumeRateLimit(env, ctx, "bulkresolve", bulkIp, 20)) {
        return json({ ok: false, error: "Too many lookups just now. Please wait a minute and try again." }, 429);
      }
      try {
        const body = bulkBody;
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
        // Logged, not returned -- the message can carry upstream URLs and
        // internal detail that the caller has no business seeing.
        console.error("bulk-resolve failed:", e);
        return json({ ok: false, error: "Could not resolve those titles." }, 500);
      }
    }

    return new Response("Not found", { status: 404 });
}

// The actual Worker export. Delegates to handleFetch (25_api-catalog-
// routes.js) for everything, then runs the response back through
// withSecurityHeaders (02_http-and-creator-utils.js) before it goes out --
// see handleFetch's own opening comment for why it's split this way.
export default {
  async fetch(request, env, ctx) {
    let response;
    try {
      response = await handleFetch(request, env, ctx);
    } catch (err) {
      // The boundary this file did not have. handleFetch has no top-level
      // try, so any uncaught throw -- a KV put hitting its 1-write-per-second
      // limit, an upstream answering 200 with a truncated body, a bug in a
      // route -- escaped the Worker entirely, and Cloudflare answered with
      // its own 1101 error page: not JSON, no CORS, none of the security
      // headers below. A fetch() in the builder page saw an unparseable
      // response and could only report "check your connection".
      //
      // /api/creator/sync/save already wrapped its own KV write and returned
      // a clean 500; its sibling /api/creator/lists/save did not. One
      // boundary here is worth more than remembering to do that at every
      // future call site.
      //
      // safeErrorMessage logs the original and strips URLs, labelled secrets
      // and long opaque tokens from what goes back.
      response = json({ ok: false, error: safeErrorMessage(err) }, 500);
    }
    return withSecurityHeaders(response);
  },

  // Runs on whatever schedule this Worker's owner configured under
  // Triggers -> Cron Triggers in the Cloudflare dashboard (recommended:
  // every 6 minutes with "*/6 * * * *") -- refreshes and pre-warms shared
  // Trakt, TMDB, Simkl, and MDBList charts into KV storage and sweeps newly-aired episodes for Continue Watching.
  async scheduled(event, env, ctx) {
    // The boundary the fetch handler above has, which this did not.
    //
    // `ctx.waitUntil(Promise.all([...]))` rejects the moment any one task
    // does, and there was no try -- so a failure in one task escaped the
    // handler and Cloudflare recorded the whole invocation as failed, hiding
    // which task actually broke. The tasks are independent, so each one gets
    // its own catch and the tick is judged on whether it ran, not on whether
    // everything inside it succeeded. Same argument as the fetch handler's:
    // one boundary here is worth more than remembering to do this at every
    // future call site.
    const guard = (label, p) => Promise.resolve(p).catch((err) => {
      console.error(`[Cron] ${label} failed:`, err);
    });
    try {
    // Same as the fetch handler above: nothing that runs below may see an
    // empty API key just because this isolate's first event happened to be a
    // cron tick rather than a request. See applyEnvApiKeys.
    applyEnvApiKeys(env);
    ctx.waitUntil(
      Promise.all([
        guard("checkForNewEpisodes", checkForNewEpisodes(env)),
        guard("prewarmSharedCatalogs", prewarmSharedCatalogs(env, ctx)),
        // Cheap when index:publiclists already exists (one KV get, no-op).
        // When it doesn't -- a fresh deployment, or the index key lost
        // some other way -- this is what keeps a self-hoster who never
        // visits /admin from serving every visitor a truncated,
        // lexicographically-biased directory/search result indefinitely,
        // instead of relying on whichever live request happens to hit the
        // cold index first.
        //
        // One bounded chunk per tick, not a whole rebuild (see
        // rebuildPublicListIndex): a small deployment is done on the first
        // tick, a large one converges over the following few hours. That is
        // the point -- the previous single-pass version simply threw and
        // rebuilt nothing at all once there were more than ~500 lists.
        // /admin/api/rebuild-public-index drives the same chunks back to
        // back for an immediate seed right after a fresh deploy.
        //
        // This also re-derives the index once a day even when one already
        // exists. The index is maintained incrementally by a read-modify-write
        // on a single key, so rapid updates lose each other -- and nothing
        // used to repair that, because a rebuild only ever ran when the index
        // was MISSING, never when it was merely wrong. See
        // refreshPublicListIndexIfStale.
        guard("refreshPublicListIndexIfStale", refreshPublicListIndexIfStale(env, ctx)),
      ])
    );
    } catch (err) {
      // Anything thrown synchronously before waitUntil was even reached --
      // applyEnvApiKeys, or a task that threw rather than rejecting.
      console.error("[Cron] scheduled() failed before its tasks were queued:", err);
    }
  },
};

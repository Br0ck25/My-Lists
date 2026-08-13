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
    async function handleSubtitlesTrack(configParam, stremioType, id, env) {
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
          const alreadyWatched = blob.watchHistory.some((it) => String(it.id) === imdbId);
          if (!alreadyWatched) {
            const details = await fetchTmdbItemDetails(imdbId, effectiveTmdbKey, "movie").catch(() => null);
            blob.watchHistory.unshift({
              id: imdbId,
              type: "movie",
              name: (details && details.title) || imdbId,
              poster: (details && details.poster) || "",
            });
          }
          matched = alreadyWatched ? "yes (already watched)" : "yes";
        } else {
          matched = "no (unrecognized id format)";
        }

        blob.updatedAt = Date.now();
        await env.CONFIGS.put(syncKey, JSON.stringify(blob));
      } catch (err) {
        matched = "error: " + (err && err.message ? err.message : String(err));
      }

      await env.CONFIGS.put(diagnosticsKey, JSON.stringify({ lastPingAt: Date.now(), lastPingId: pingId, matched }));
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
      return json({ ok: true, displayName: auth.displayName, lists });
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

      const type = body.type === "series" ? "series" : body.type === "movie" ? "movie" : null;
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
      const newOrder = Array.isArray(body.order) ? body.order.map(String) : [];
      // Only accept slugs that already belong to this creator -- silently
      // dropping anything else rather than trusting the client's list
      // wholesale (never trust client-side validation).
      const orderRaw = await env.CONFIGS.get(`creatorlistorder:${auth.username}`);
      let currentOrder = [];
      try {
        currentOrder = orderRaw ? JSON.parse(orderRaw).order || [] : [];
      } catch {
        currentOrder = [];
      }
      const currentSet = new Set(currentOrder);
      const filteredNewOrder = newOrder.filter((s) => currentSet.has(s));
      // Anything the creator owns that somehow didn't appear in the
      // submitted order (shouldn't normally happen) is appended at the end
      // rather than silently dropped.
      currentOrder.forEach((s) => {
        if (!filteredNewOrder.includes(s)) filteredNewOrder.push(s);
      });
      await env.CONFIGS.put(`creatorlistorder:${auth.username}`, JSON.stringify({ order: filteredNewOrder }));
      return json({ ok: true, order: filteredNewOrder });
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
      const blob = {
        watchHistory: Array.isArray(body.watchHistory) ? body.watchHistory : [],
        continueWatching: Array.isArray(body.continueWatching) ? body.continueWatching : [],
        fullyWatchedShowIds: Array.isArray(body.fullyWatchedShowIds) ? body.fullyWatchedShowIds.map(String) : [],
        dismissedContinueWatching: body.dismissedContinueWatching && typeof body.dismissedContinueWatching === "object" ? body.dismissedContinueWatching : {},
        trackPlayback: typeof body.trackPlayback === "boolean" ? body.trackPlayback : false,
        updatedAt: Date.now(),
      };
      const serialized = JSON.stringify(blob);
      if (serialized.length > 24 * 1024 * 1024) {
        return json({ ok: false, error: "Your Watch History is too large to store (over the 25MB limit)." });
      }
      try {
        await env.CONFIGS.put(`creatorsynctracking:${auth.username}`, serialized);
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
          data.fullyWatchedShowIds = Array.isArray(trackingBlob.fullyWatchedShowIds) ? trackingBlob.fullyWatchedShowIds : [];
          data.dismissedContinueWatching = trackingBlob.dismissedContinueWatching && typeof trackingBlob.dismissedContinueWatching === "object" ? trackingBlob.dismissedContinueWatching : {};
          data.trackPlayback = typeof trackingBlob.trackPlayback === "boolean" ? trackingBlob.trackPlayback : false;
        }
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
      const q = (url.searchParams.get("q") || "").toLowerCase();
      try {
        const [anonResult, creatorResult] = await Promise.all([
          env.CONFIGS.list({ prefix: "publishedlist:user:", limit: 50 }),
          env.CONFIGS.list({ prefix: "creatorlist:", limit: 50 }),
        ]);
        const anonCandidates = await Promise.all(
          anonResult.keys.map(async (k) => {
            const raw = await env.CONFIGS.get(k.name);
            if (!raw) return null;
            try {
              const data = JSON.parse(raw);
              // "Private" on an anonymous list only ever means "hidden from
              // search" (see /api/publish-list) -- there's no owner login to
              // gate direct access by, so unlike a private Creator list this
              // doesn't affect the GET /lists/... route at all, just this
              // listing. (The client-side flow that used to create these no
              // longer exists -- saving a list now always requires a Creator
              // Profile -- but existing anonymous lists saved before that
              // change still need to keep working.)
              if (data.visibility === "private") return null;
              const listSlug = k.name.slice("publishedlist:user:".length);
              return {
                name: data.name,
                type: data.type,
                items: (data.items || []).length,
                likes: data.likes || 0,
                creatorName: "Anonymous",
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
                items: (data.items || []).length,
                likes: data.likes || 0,
                creatorName,
                url: `${url.origin}/lists/${username}/${listSlug}`,
              };
            } catch {
              return null;
            }
          })
        );
        const matches = [...anonCandidates, ...creatorCandidates]
          .filter(Boolean)
          .filter((l) => !q || l.name.toLowerCase().includes(q))
          .slice(0, 30);
        return json({ ok: true, lists: matches });
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
    // this URL as a source -- see fetchPublishedListCatalog, which
    // mirrors this same lookup order and private-list handling).
    m = path.match(/^\/lists\/([a-z0-9-]+)\/([a-z0-9-]+)(?:\.json)?$/i);
    if (m) {
      const username = m[1].toLowerCase();
      const listName = m[2].toLowerCase();
      if (!env || !env.CONFIGS) {
        return json({ ok: false, error: "This Worker has no CONFIGS KV namespace bound, so nothing is published here." }, 404);
      }
      let listData = null;
      let isCreatorList = false;
      const creatorRaw = await env.CONFIGS.get(`creatorlist:${username}:${listName}`);
      if (creatorRaw) {
        try {
          const parsed = JSON.parse(creatorRaw);
          // A private list returns exactly the same 404 as a list that
          // doesn't exist at all -- anyone probing a guessed/leaked URL
          // for a private list gets no signal either way that they've
          // found something real, per the spec (404, never a distinct
          // "access denied").
          if (parsed.visibility !== "private") {
            listData = parsed;
            isCreatorList = true;
          }
        } catch {
          // fall through to anonymous lookup below
        }
      }
      if (!listData) {
        const anonRaw = await env.CONFIGS.get(`publishedlist:${username}:${listName}`);
        if (anonRaw) {
          try {
            listData = JSON.parse(anonRaw);
          } catch {
            return json({ ok: false, error: "That list's stored data is corrupted." }, 500);
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
          const profileRaw = await env.CONFIGS.get(`creator:${username}`);
          if (profileRaw) creatorDisplayName = JSON.parse(profileRaw).displayName || username;
        } catch {
          // fall back to the raw username slug
        }
      }
      const likes = listData.likes || 0;
      const wantsJson = path.endsWith(".json") || !isBrowserNavigation(request);
      if (wantsJson) {
        return json({ ok: true, name: listData.name, type: listData.type, items: listData.items, creatorName: creatorDisplayName, likes });
      }
      const itemsHtml = listData.items
        .map(
          (it) =>
            `<a href="/${it.type || 'movie'}/${it.tmdb_id || ''}" style="display:flex; flex-direction:column; gap:6px; width:100%; min-width:0; text-decoration:none;">` +
            `<div style="aspect-ratio:2/3; border-radius:8px; overflow:hidden; background:var(--panel-strong); box-shadow:var(--shadow-sm); width:100%;">` +
            (it.poster ? `<img src="${escapeHtmlServer(it.poster)}" style="width:100%; height:100%; object-fit:cover; display:block;" loading="lazy">` : ``) +
            `</div>` +
            `<div style="font-size:0.85rem; font-weight:600; color:var(--text); text-align:center; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtmlServer(it.title || it.name || "Item")}</div>` +
            `</a>`
        )
        .join("");
      const shareUrl = `${url.origin}/lists/${username}/${listName}`;
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtmlServer(listData.name)} \u2014 My Lists</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<script>
  if (localStorage.getItem('theme') === 'dark' || (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark-theme');
  }
</script>
<style>
  :root {
    --bg: #F2F2F7;
    --surface: #FFFFFF;
    --panel-strong: #E5E5EA;
    --border: rgba(0,0,0,0.08);
    --border-strong: rgba(0,0,0,0.15);
    --text: #000000;
    --text-2: #3A3A3C;
    --muted: #8E8E93;
    --accent: #007AFF;
    --shadow-sm: 0 1px 3px rgba(0,0,0,0.06);
    --radius-pill: 999px;
    --font-body: 'Inter', -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #000000;
      --surface: #1C1C1E;
      --panel-strong: #2C2C2E;
      --border: rgba(255,255,255,0.15);
      --border-strong: rgba(255,255,255,0.25);
      --text: #FFFFFF;
      --text-2: #EBEBF5;
    }
  }
  html.dark-theme {
    --bg: #000000; --surface: #1C1C1E; --panel-strong: #2C2C2E;
    --border: rgba(255,255,255,0.15); --border-strong: rgba(255,255,255,0.25);
    --text: #FFFFFF; --text-2: #EBEBF5;
  }
  * { box-sizing: border-box; }
  html { touch-action: manipulation; width: 100%; max-width: 100%; overflow-x: hidden; }
  body {
    font-family: var(--font-body);
    margin: 0;
    min-height: 100vh;
    width: 100%;
    max-width: 100%;
    overflow-x: hidden;
    padding: 16px 12px calc(80px + env(safe-area-inset-bottom));
    background: var(--bg);
    color: var(--text);
    font-size: 15px;
    -webkit-font-smoothing: antialiased;
  }
  .page {
    max-width: 1200px;
    width: 100%;
    margin: 0 auto;
    display: grid;
    gap: 12px;
    overflow-x: hidden;
  }
  @media (min-width: 641px) {
    body { padding: 32px 20px 52px; }
    .page { gap: 16px; }
  }
  .app-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 10px;
    padding: 6px 4px 8px;
  }
  .app-header-left {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: 1 1 auto;
    min-width: 0;
  }
  .app-header-avatar {
    width: 40px;
    height: 40px;
    border-radius: 12px;
    box-shadow: var(--shadow-sm);
    object-fit: cover;
  }
  .app-header-title-group {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .app-header-title {
    font-size: 1.35rem;
    font-weight: 800;
    letter-spacing: -0.025em;
    color: var(--text);
    margin: 0;
    line-height: 1.15;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .header-actions { display: flex; gap: 8px; margin-left: auto; align-items:center; }
  
  .tab-bar {
    display: flex; gap: 8px; overflow-x: auto; padding: 2px 0 6px;
    margin-bottom: 4px; scrollbar-width: none;
  }
  .tab-btn {
    flex: none; background: var(--surface); color: var(--text-2);
    border: 1.5px solid var(--border-strong); border-radius: 999px; padding: 8px 16px;
    font-size: 0.875rem; font-weight: 600; cursor: pointer; text-decoration: none;
    box-shadow: var(--shadow-sm); transition: all 0.15s;
  }
  .tab-btn.active {
    background: var(--accent); color: #fff; border-color: var(--accent);
    box-shadow: 0 2px 10px rgba(0,122,255,0.30);
  }
  .tab-btn:hover:not(.active) { border-color: var(--accent); color: var(--accent); }

    .lc-btn {
    padding: 6px 12px; min-height: unset;
    font-size: 0.8rem; font-weight: 600;
    border-radius: var(--radius-pill);
    border: 1.5px solid var(--border-strong);
    background: var(--bg); color: var(--text-2);
    cursor: pointer; display: inline-flex; align-items: center; gap: 4px;
    font-family: inherit; white-space: nowrap; text-decoration: none;
    transition: background 0.12s, color 0.12s, border-color 0.12s;
  }
  .lc-btn.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
  
  .detail-back-btn {
    display: flex; align-items: center; gap: 6px;
    background: none; border: none; font-size: 1.1rem;
    font-weight: 700; color: var(--accent); cursor: pointer; padding: 4px 0; text-decoration: none;
  }
  
  .subnav-pill {
    flex: none; padding: 7px 16px; border-radius: var(--radius-pill); border: 1.5px solid var(--border-strong);
    background: var(--surface); color: var(--text-2); font-size: 0.86rem; font-weight: 600; cursor: pointer;
    white-space: nowrap; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    transition: background 0.12s, color 0.12s, border-color 0.12s, box-shadow 0.12s;
    box-shadow: var(--shadow-sm); font-family: inherit; margin: 0; text-decoration: none;
  }
  .subnav-pill.active {
    background: var(--accent); color: #ffffff; border-color: var(--accent); box-shadow: 0 2px 8px rgba(0,122,255,0.28);
  }

  .poster-grid-3 {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px 8px; width: 100%;
  }
  @media (min-width: 641px) {
    .poster-grid-3 {
      grid-template-columns: repeat(9, 1fr); gap: 12px 8px;
    }
  }

  code { background: var(--panel-strong); padding: 4px 8px; border-radius: 6px; word-break: break-all; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
  <div class="page">
    <!-- Top App Bar -->
    <header class="app-header">
      <div class="app-header-left">
        <img class="app-header-avatar" src="/icon.png" alt="App Icon">
        <div class="app-header-title-group">
          <div style="display:flex; align-items:center; gap:8px;">
            <h1 class="app-header-title">My Lists Addon</h1>
            <button class="dark-mode-toggle" onclick="document.documentElement.classList.toggle('dark-theme'); localStorage.setItem('theme', document.documentElement.classList.contains('dark-theme') ? 'dark' : 'light');" style="background:transparent; border:none; color:var(--text); font-size:1.2rem; cursor:pointer; padding:0; margin-top:2px;" title="Toggle Dark Mode">🌓</button>
          </div>
        </div>
      </div>
      <div class="header-actions" id="authActions">
        <div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px;">
          <div style="display:flex; align-items:center; gap:6px;">
            <button type="button" class="lc-btn primary" onclick="location.href='/'" style="padding:6px 12px; font-size:0.82rem; font-weight:700;">+ Create Account</button>
            <button type="button" class="lc-btn" onclick="location.href='/'" style="padding:6px 12px; font-size:0.82rem;">Restore</button>
          </div>
          <a href="https://buymeacoffee.com/brock25" target="_blank" rel="noopener" style="font-size:0.8rem; color:var(--muted); text-decoration:none; font-weight:500; white-space:nowrap;">&#x2615; Buy me a coffee</a>
        </div>
      </div>
    </header>

    <!-- Top Tab Bar -->
    <div class="tab-bar">
      <a href="/" class="tab-btn">My Catalogs</a>
      <a href="/" class="tab-btn active">Lists</a>
      <a href="/" class="tab-btn">Discover</a>
      <a href="/" class="tab-btn">Search</a>
      <a href="/" class="tab-btn">Settings</a>
    </div>

    <div style="margin-bottom: 32px;">
      <a href="/" class="tab-btn" style="text-decoration:none;">&larr; Back</a>
    </div>

    <div style="margin-bottom:32px;">
      <h2 style="font-size:2.5rem; font-weight:700; margin:0 0 16px; letter-spacing:-0.02em;">${escapeHtmlServer(listData.name)}</h2>
      <div style="color:var(--text-2); font-size:1.05rem; margin-bottom:16px;">by ${escapeHtmlServer(creatorDisplayName)} \u2022 ${listData.type === "movie" ? "Movies" : "Shows"} \u2022 ${listData.items.length} item${listData.items.length === 1 ? "" : "s"} \u2022 <span id="likeCountDisplay">\u2665 ${likes}</span></div>
      <button type="button" class="lc-btn primary" id="likeListBtn">\u2661 Like</button>
    </div>



    <div class="poster-grid-3">
      ${itemsHtml}
    </div>
  </div>

  <script>
  (function () {
    var USERNAME = ${JSON.stringify(username)};
    var SLUG = ${JSON.stringify(listName)};
    var KEY = USERNAME + '/' + SLUG;
    
    // Auth header
    try {
      var cname = localStorage.getItem('myListAddon:creatorName');
      if (cname) {
        cname = cname.replace(/NaN/gi, '').replace(/undefined/gi, '').replace(/null/gi, ''); // Fix corrupted local storage
        if (!cname || cname.trim() === '') cname = "Account";
        cname = cname.charAt(0).toUpperCase() + cname.slice(1);
        var actions = document.getElementById('authActions');
        actions.innerHTML = '<div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px;">' +
          '<div style="display:flex; align-items:center; gap:8px;">' +
          '<span class="subnav-pill active" style="margin:0; font-size:0.82rem; padding:6px 12px; cursor:pointer;" onclick="location.href=\'/\'">&#x1F464; ' + cname.replace(/</g, '&lt;') + '</span>' +
          '<button type="button" class="lc-btn" style="padding:5px 9px; font-size:0.78rem;" onclick="location.href=\'/\'" title="Sign Out / Switch">Sign Out</button>' +
          '</div>' +
          '<a href="https://buymeacoffee.com/brock25" target="_blank" rel="noopener" style="font-size:0.8rem; color:var(--muted); text-decoration:none; font-weight:500; white-space:nowrap;">&#x2615; Buy me a coffee</a>' +
          '</div>';
      }
    } catch(e) {}

    var btn = document.getElementById('likeListBtn');
    function getLiked() {
      try { return new Set(JSON.parse(localStorage.getItem('myListAddon:likedLists') || '[]')); } catch (e) { return new Set(); }
    }
    function rememberLiked(k) {
      var set = getLiked();
      set.add(k);
      try { localStorage.setItem('myListAddon:likedLists', JSON.stringify(Array.from(set))); } catch (e) {}
    }
    function forgetLiked(k) {
      var set = getLiked();
      set.delete(k);
      try { localStorage.setItem('myListAddon:likedLists', JSON.stringify(Array.from(set))); } catch (e) {}
    }
    var isLiked = getLiked().has(KEY);
    if (isLiked) {
      btn.textContent = '\\u2665 Unlike';
    }
    btn.addEventListener('click', function () {
      btn.disabled = true;
      fetch('/api/lists/like', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: USERNAME, slug: SLUG, action: isLiked ? 'unlike' : 'like' }),
      }).then(function (r) { return r.json(); }).then(function (data) {
        if (!data.ok) {
          alert('Could not update this like: ' + (data.error || 'unknown error'));
          return;
        }
        if (isLiked) {
          forgetLiked(KEY);
          isLiked = false;
          btn.textContent = '\\u2661 Like';
        } else {
          rememberLiked(KEY);
          isLiked = true;
          btn.textContent = '\\u2665 Unlike';
        }
        document.getElementById('likeCountDisplay').textContent = '\\u2665 ' + data.likes;
        try {
          var creatorName = localStorage.getItem('myListAddon:creatorName');
          var creatorKey = localStorage.getItem('myListAddon:creatorKey');
          if (creatorName && creatorKey) {
            fetch('/api/creator/sync/like', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ creatorName: creatorName, creatorKey: creatorKey, usernameSlug: KEY, liked: isLiked }),
            }).catch(function () {});
          }
        } catch (e) {}
      }).catch(function () {
        alert('Network error while updating this like.');
      }).finally(function () {
        btn.disabled = false;
      });
    });
  })();
  </script>
</body>
</html>`;
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store, no-cache, must-revalidate", ...corsHeaders() } });
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
      return json({ ok: true, entries });
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
      if (!env || !env.CONFIGS) return json({ ok: true, entries: [] });
      const listResult = await env.CONFIGS.list({ prefix: "feedback:", limit: 300 });
      const keys = listResult.keys.slice().reverse();
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
      return json({ ok: true, entries: entries.filter(Boolean), truncated: listResult.list_complete === false });
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
      return json({ ok: true });
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
          "Set-Cookie": `${ADMIN_COOKIE_NAME}=${cookieValue}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(ADMIN_SESSION_MS / 1000)}`,
        },
      });
    }

    if (path === "/admin/logout") {
      return new Response(null, {
        status: 302,
        headers: {
          "Location": "/admin",
          "Set-Cookie": `${ADMIN_COOKIE_NAME}=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
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
        return json({ ok: true, resolved });
      } catch (e) {
        return json({ ok: false, error: String(e) }, 500);
      }
    }

    return new Response("Not found", { status: 404, headers: corsHeaders() });
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

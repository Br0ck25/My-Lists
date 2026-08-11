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
        const syncKey = `creatorsync:${auth.username}`;
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
          blob = { config: [], presets: {}, collapsedPanels: {}, likedLists: [], watchHistory: [], continueWatching: [], fullyWatchedShowIds: [], dismissedContinueWatching: {} };
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
        // Watch History / Continue Watching -- unlike a named Custom List
        // (see /api/creator/lists/save above), these are per-browser
        // tracking data with mixed movie+episode items, not a single
        // publishable movie-or-series list, so they ride along in this
        // same private per-account blob rather than the creatorlist:*
        // namespace. Always private by nature; there's no visibility
        // toggle for either of these anywhere in the client.
        watchHistory: Array.isArray(body.watchHistory) ? body.watchHistory : [],
        continueWatching: Array.isArray(body.continueWatching) ? body.continueWatching : [],
        // Shows fully caught up as of the last check, and shows dismissed
        // from Continue Watching (each mapped to the latest-watched
        // episode at the moment of dismissal) -- both ride along here for
        // the same reason watchHistory/continueWatching do above, and both
        // are read by the Continue Watching cron (checkForNewEpisodes,
        // further down this file): fullyWatchedShowIds tells it which
        // shows are even worth checking TMDB for (no point re-checking a
        // show with a known next episode already waiting to be watched),
        // and dismissedContinueWatching stops it from re-adding a card
        // someone explicitly removed, the same way updateContinueWatching
        // already respects a dismissal client-side.
        fullyWatchedShowIds: Array.isArray(body.fullyWatchedShowIds) ? body.fullyWatchedShowIds.map(String) : [],
        dismissedContinueWatching: body.dismissedContinueWatching && typeof body.dismissedContinueWatching === "object" ? body.dismissedContinueWatching : {},
        trackPlayback: typeof body.trackPlayback === "boolean" ? body.trackPlayback : false,
        updatedAt: Date.now(),
      };
      const serialized = JSON.stringify(blob);
      // Workers KV hard-caps a value at 25MB. Presets/Channels no longer
      // live in this blob at all (see above), so this is now just a
      // defensive backstop rather than the main thing it used to guard
      // against.
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
            data = {
              config: [], collapsedPanels: {}, likedLists: [], watchHistory: [],
              continueWatching: [], fullyWatchedShowIds: [], dismissedContinueWatching: {},
              trackPlayback: false, updatedAt: Date.now(),
            };
          }
          data.presets = presetsBlob.presets || {};
          data.presetsB64 = presetsBlob.presetsB64 || null;
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
            `<div style="display:flex;gap:12px;align-items:center;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.08);">` +
            (it.poster ? `<img src="${escapeHtmlServer(it.poster)}" style="width:40px;height:60px;object-fit:cover;border-radius:4px;flex:none;">` : "") +
            `<span>${escapeHtmlServer(it.title || "Untitled")}${it.year ? " (" + escapeHtmlServer(it.year) + ")" : ""}</span></div>`
        )
        .join("");
      const shareUrl = `${url.origin}/lists/${username}/${listName}`;
      const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtmlServer(listData.name)} \u2014 My Lists</title>
<style>
  body { background:#060b16; color:#f1f2f5; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; max-width:640px; margin:0 auto; padding:24px 16px; }
  a { color:#4d9fff; }
  .card { background:rgba(255,255,255,0.045); border:1px solid rgba(255,255,255,0.1); border-radius:14px; padding:20px; margin-top:16px; }
  code { background:rgba(255,255,255,0.08); padding:2px 6px; border-radius:6px; word-break:break-all; }
  button { background:rgba(255,255,255,0.08); color:#f1f2f5; border:1px solid rgba(255,255,255,0.15); border-radius:10px; padding:10px 16px; font-size:0.95rem; cursor:pointer; }
  button:disabled { opacity:0.6; cursor:default; }
</style></head>
<body>
  <h1 style="margin-bottom:4px;">${escapeHtmlServer(listData.name)}</h1>
  <p style="color:#8d9099; margin-top:0;">by ${escapeHtmlServer(creatorDisplayName)} \u2022 ${listData.type === "movie" ? "Movies" : "Shows"} \u2022 ${listData.items.length} item${listData.items.length === 1 ? "" : "s"} \u2022 <span id="likeCountDisplay">\u2665 ${likes}</span></p>
  <button type="button" id="likeListBtn" style="margin-top:10px;">\u2661 Like</button>
  <div class="card">
    <p><strong>Add this to your own My Lists Addon:</strong> paste this URL in as a list source --</p>
    <p><code>${shareUrl}</code></p>
    <p><small><a href="${shareUrl}.json">View as JSON</a></small></p>
  </div>
  <div class="card">${itemsHtml}</div>
  <script>
  (function () {
    var USERNAME = ${JSON.stringify(username)};
    var SLUG = ${JSON.stringify(listName)};
    var KEY = USERNAME + '/' + SLUG;
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
        // If this browser was signed into a Creator Profile on the builder
        // page, persist the like to that account too -- fire-and-forget,
        // same as the rest of this add-on's account sync.
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
</body></html>`;
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders() } });
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
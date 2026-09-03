// --- Admin stats (page views, install links generated) -----------------
//
// Deliberately simple counters -- KV has no atomic increment (each bump is
// a read-then-write), so under truly simultaneous requests a bump can very
// occasionally get lost. That's an acceptable tradeoff for a personal
// project's traffic; this isn't meant to be exact to the request, just a
// reasonable running total and day-by-day trend for the admin-only
// dashboard below. No cookies, no per-visitor identity involved -- just a
// running count of events.
// Calendar date (YYYY-MM-DD) for a given moment, in Eastern time -- this
// admin dashboard is for a single owner in a fixed timezone, and using
// UTC's day boundary meant "today" started rolling over into "tomorrow"
// as early as ~7-8pm Eastern, well before the day was actually over
// locally. en-CA formats as YYYY-MM-DD directly; America/New_York's IANA
// data handles the EST/EDT switch automatically, unlike a fixed offset
// would.
function easternDateKey(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function statsToday() {
  return easternDateKey(new Date());
}

async function bumpStat(env, kind) {
  if (!env || !env.CONFIGS) return;
  try {
    const totalKey = `stats:${kind}:total`;
    const dayKey = `stats:${kind}:${statsToday()}`;
    const [totalRaw, dayRaw] = await Promise.all([env.CONFIGS.get(totalKey), env.CONFIGS.get(dayKey)]);
    const total = (parseInt(totalRaw, 10) || 0) + 1;
    const day = (parseInt(dayRaw, 10) || 0) + 1;
    await Promise.all([env.CONFIGS.put(totalKey, String(total)), env.CONFIGS.put(dayKey, String(day))]);
  } catch (e) {
    // best-effort -- a failed stat bump should never break the actual
    // request it's riding along on (see the ctx.waitUntil call sites,
    // which don't await this at all for exactly that reason).
  }
}

// Like bumpStat above, but by a caller-supplied amount in one write
// instead of always +1 -- used for the per-source-group counters (a
// single "generate install link" beacon can represent several rows of the
// same group at once, e.g. five Custom Lists in one install). Total only,
// no daily breakdown -- "which sources people use" reads more like a
// standing preference than a day-to-day trend, and this keeps the write
// count reasonable for a request that can touch several groups at once.
async function bumpStatBy(env, kind, amount) {
  if (!env || !env.CONFIGS || !amount) return;
  try {
    const totalKey = `stats:${kind}:total`;
    
    if (env.DB && kind.startsWith("sourcegroup:")) {
      const groupName = kind.slice("sourcegroup:".length);
      await env.DB.prepare(
        "INSERT INTO source_groups (id, name, install_count) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET install_count = source_groups.install_count + excluded.install_count"
      ).bind(groupName, groupName, amount).run();
    } else {
      const totalRaw = await env.CONFIGS.get(totalKey);
      const total = (parseInt(totalRaw, 10) || 0) + amount;
      await env.CONFIGS.put(totalKey, String(total));
    }
  } catch (e) {
    // best-effort, see bumpStat above
  }
}

// Bumps one or more named counters that all live inside a single JSON blob
// at `key`, in one read + one write total -- rather than a separate KV key
// (and separate bumpStat total+day pair) per counter. Used for genre/decade
// playback telemetry (see recordPlaybackTelemetry below): a single ping
// with up to 5 genres used to cost 10 writes just for the genre piece
// (bumpStat's total+day pair x5); this costs 1, regardless of how many
// fields are bumped in the same call.
//
// The tradeoff, on purpose: every field sharing one key means any two
// concurrent playback pings -- even on completely different genres --
// now race on the same read-modify-write, where before only two pings on
// the *same* genre could collide. KV has no atomic increment either way
// (see bumpStat's own comment), so this trades a wider collision surface
// for a large write-count cut. Worth it here specifically because this
// data was already "a reasonable running total, not an exact ledger" (see
// computeAudienceAnalytics, which only ever reads the all-time snapshot --
// there's no day-by-day genre/decade view for a dropped increment to be
// conspicuously missing from), not because undercounting is free in
// general.
async function bumpJsonCounterBlob(env, key, fields) {
  if (!env || !env.CONFIGS || !fields || !fields.length) return;
  try {
    const raw = await env.CONFIGS.get(key);
    let counts = {};
    if (raw) {
      try {
        counts = JSON.parse(raw) || {};
      } catch {
        counts = {};
      }
    }
    for (const f of fields) {
      if (!f) continue;
      counts[f] = (parseInt(counts[f], 10) || 0) + 1;
    }
    await env.CONFIGS.put(key, JSON.stringify(counts));
  } catch (e) {
    // best-effort, see bumpStat above
  }
}

// One-time migration: folds the old per-genre/per-decade
// "stats:genre:X:total" / "stats:decade:X:total" keys (written by the
// bumpStat-per-genre approach recordPlaybackTelemetry used before it
// switched to bumpJsonCounterBlob above) into the new single-blob keys
// (stats:genres:alltime / stats:decades:alltime), adding their values into
// those all-time totals so switching formats didn't reset the Trending
// Data tab's existing genre/decade counts back to zero.
//
// Guarded by its own sentinel key so the list()+N-gets below -- exactly
// the expensive read pattern the new blob format exists to get away from
// -- only ever runs once, no matter how many times the dashboard's
// Audience tab gets loaded afterward. Old counts are added to (not
// overwritten over) whatever the new blob already has, so any plays that
// already landed in the new blob in the window before this migration ran
// aren't double-counted away.
async function migrateGenreDecadeStatsIfNeeded(env) {
  if (!env || !env.CONFIGS) return;
  const sentinelKey = "stats:genredecade:migrated";
  try {
    const already = await env.CONFIGS.get(sentinelKey);
    if (already) return;

    const [genreBlobRaw, decadeBlobRaw, genreList, decadeList] = await Promise.all([
      env.CONFIGS.get("stats:genres:alltime"),
      env.CONFIGS.get("stats:decades:alltime"),
      listAllKeys(env.CONFIGS, "stats:genre:"),
      listAllKeys(env.CONFIGS, "stats:decade:"),
    ]);

    let genreCounts = {};
    try {
      genreCounts = genreBlobRaw ? JSON.parse(genreBlobRaw) || {} : {};
    } catch {
      genreCounts = {};
    }
    let decadeCounts = {};
    try {
      decadeCounts = decadeBlobRaw ? JSON.parse(decadeBlobRaw) || {} : {};
    } catch {
      decadeCounts = {};
    }

    const genreTotalKeys = (genreList.keys || []).filter((k) => k.name.endsWith(":total"));
    await Promise.all(
      genreTotalKeys.map(async (k) => {
        const name = k.name.slice("stats:genre:".length, -":total".length);
        const raw = await env.CONFIGS.get(k.name);
        const count = parseInt(raw, 10) || 0;
        if (name && count > 0) genreCounts[name] = (parseInt(genreCounts[name], 10) || 0) + count;
      })
    );

    const decadeTotalKeys = (decadeList.keys || []).filter((k) => k.name.endsWith(":total"));
    await Promise.all(
      decadeTotalKeys.map(async (k) => {
        const name = k.name.slice("stats:decade:".length, -":total".length);
        const raw = await env.CONFIGS.get(k.name);
        const count = parseInt(raw, 10) || 0;
        if (name && count > 0) decadeCounts[name] = (parseInt(decadeCounts[name], 10) || 0) + count;
      })
    );

    await Promise.all([
      env.CONFIGS.put("stats:genres:alltime", JSON.stringify(genreCounts)),
      env.CONFIGS.put("stats:decades:alltime", JSON.stringify(decadeCounts)),
      // Written last and only after both blobs above succeed -- if this
      // whole function throws partway through, the sentinel never gets
      // set, so the next Audience tab load just retries the migration
      // from scratch rather than a partial migration looking "done".
      env.CONFIGS.put(sentinelKey, "1"),
    ]);
  } catch (e) {
    // best-effort -- if this fails, the sentinel key was never written,
    // so this just retries next time computeAudienceAnalytics runs. Old
    // per-key data is untouched either way (this only ever adds to the
    // new blob, never deletes the old keys), so nothing is lost by a
    // failed attempt.
  }
}

// Records roughly how recently a creator account was last active -- feeds
// the "Last Active" column in the admin dashboard's Creator Accounts tab.
// Throttled to at most once per 30 minutes per account (one extra read to
// check, skipped write if already recent) so a burst of debounced
// autosaves during a single active session doesn't turn into a KV write
// on every one of them -- called from authenticateCreator on every
// successful auth, fire-and-forget (never awaited there), so this can
// never add latency or a failure mode to the actual authenticated action
// it's riding along with.
//
// The timestamp is mirrored into D1's creators.last_active on the same
// throttle. That column existed for a long time but nothing ever wrote to
// it, which forced the dashboard to do one KV `get` per account just to
// render the "Last Active" column -- linear in the account count, and
// over Cloudflare's 1,000-subrequest/invocation cap past roughly a
// thousand creators (the admin dashboard then stopped loading entirely in
// production; Miniflare doesn't enforce that limit, so it rendered fine
// locally). Writing it here lets the dashboard read last-active straight
// out of the creators SELECT it already runs. Accounts that predate this
// have NULL in D1 and are repaired lazily by backfillCreatorLastActive.
async function touchCreatorLastSeen(env, username) {
  if (!env || !env.CONFIGS || !username) return;
  try {
    const key = `creatorlastseen:${username}`;
    const raw = await env.CONFIGS.get(key);
    const last = parseInt(raw, 10) || 0;
    if (Date.now() - last < 30 * 60 * 1000) return; // updated recently enough
    const now = Date.now();
    await env.CONFIGS.put(key, String(now));
    if (env.DB) {
      // Mirrored, never authoritative: KV above is written unconditionally
      // and remains the source of truth. An UPDATE that matches no row
      // (account not yet migrated into D1) is harmless -- the dashboard's
      // backfill fills it once the row exists. Best-effort so a D1 hiccup
      // can never fail the auth this is riding along on.
      try {
        await env.DB.prepare("UPDATE creators SET last_active = ? WHERE username = ?")
          .bind(now, username)
          .run();
      } catch (dbErr) {
        // KV write above already happened; cosmetic value only.
      }
    }
  } catch (e) {
    // best-effort -- a missing/stale "Last Active" value is cosmetic only
  }
}

// How many NULL last_active rows one dashboard load repairs. Kept well
// under the subrequest cap: at most this many KV reads plus a single D1
// batch write per call, so the backfill itself can never be the thing
// that tips a dashboard load over the limit even mid-migration.
const LAST_ACTIVE_BACKFILL_BATCH = 100;

// Lazily fills creators.last_active in D1 from the KV creatorlastseen:
// marker for accounts that still have NULL there -- every account created
// before touchCreatorLastSeen started mirroring into D1. Runs only on an
// admin dashboard load, repairs a bounded batch each time, and then has
// nothing left to do: once a row is set, touchCreatorLastSeen keeps it
// current going forward. Converges over a handful of loads (1,200 accounts
// -> ~12 loads) and then costs zero KV reads. Each repaired value is also
// written onto the in-memory account object so it shows the right "Last
// Active" on the load that repairs it, not one load later.
async function backfillCreatorLastActive(env, accounts) {
  if (!env || !env.DB || !env.CONFIGS || !Array.isArray(accounts)) return;
  const missing = accounts.filter((c) => c && c.username && !c.lastActive).slice(0, LAST_ACTIVE_BACKFILL_BATCH);
  if (!missing.length) return;
  const stmts = [];
  await Promise.all(
    missing.map(async (c) => {
      try {
        const raw = await env.CONFIGS.get(`creatorlastseen:${c.username}`);
        const ts = raw ? parseInt(raw, 10) || 0 : 0;
        if (ts) {
          c.lastActive = ts;
          // `AND last_active IS NULL` guards against clobbering a value a
          // concurrent touch already wrote.
          stmts.push(
            env.DB.prepare("UPDATE creators SET last_active = ? WHERE username = ? AND last_active IS NULL").bind(ts, c.username)
          );
        }
      } catch {
        // best-effort per account; retried on a later load
      }
    })
  );
  if (stmts.length) {
    try {
      // One batched D1 call for the whole batch rather than one per row.
      await env.DB.batch(stmts);
    } catch (e) {
      // Non-fatal: the same rows are picked up again on the next load.
    }
  }
}

// Records one "marked as watched" or "added to a list" event for a given
// title -- feeds the admin dashboard's Trending Data tab, which is meant
// to eventually seed this add-on's own trending/popular catalogs once
// there's enough data. Bucketed by Eastern calendar day (see
// easternDateKey) rather than a raw event log, so an arbitrary rolling
// window (7/30/90 days) can be summed later without needing a real
// time-series database -- evtdayindex tracks which title ids had any
// activity on a given day, so the dashboard only has to sum counts for
// titles that were actually active in the requested window instead of
// checking every title that's ever been tracked. KV has no atomic
// increment (same tradeoff as bumpStat above), so this is a reasonable
// running total, not an exact ledger.
async function recordTrackedEvent(env, eventType, id, title, mediaType) {
  if (!env || !env.CONFIGS || !id) return;
  try {
    const day = statsToday();
    const daysKey = `evtcount:${eventType}:${id}:days`;
    const totalKey = `evtcount:${eventType}:${id}:alltime`;
    const metaKey = `evtmeta:${eventType}:${id}`;
    const indexKey = `evtdayindex:${eventType}:${day}`;

    const [daysRaw, totalRaw, indexRaw] = await Promise.all([
      env.CONFIGS.get(daysKey),
      env.CONFIGS.get(totalKey),
      env.CONFIGS.get(indexKey),
    ]);
    // One JSON blob per (eventType, id) holding every day's count, rather
    // than one KV key per (eventType, id, day) -- summing a 90-day window
    // used to mean 90 separate reads per candidate title (see
    // computeLeaderboard below), which multiplied against even a modest
    // candidate list blew past a safe per-invocation KV read budget and
    // was quietly capping the leaderboard to far fewer than 100 entries
    // for every window wider than a day or two. One read per candidate
    // here, regardless of window width, fixes that at the root instead of
    // just raising a cap number. Trimmed to the most recent 95 days on
    // write (a few days' buffer past the widest window this dashboard
    // ever queries, 90) so this blob can't grow without bound for a title
    // that's been tracked for years.
    let dayCounts = {};
    try {
      dayCounts = daysRaw ? JSON.parse(daysRaw) : {};
    } catch {
      dayCounts = {};
    }
    dayCounts[day] = (dayCounts[day] || 0) + 1;
    const dayKeys = Object.keys(dayCounts).sort();
    if (dayKeys.length > 95) {
      dayKeys.slice(0, dayKeys.length - 95).forEach((k) => delete dayCounts[k]);
    }
    const totalCount = (parseInt(totalRaw, 10) || 0) + 1;

    let index = [];
    try {
      index = indexRaw ? JSON.parse(indexRaw) : [];
    } catch {
      index = [];
    }
    if (!index.includes(id)) index.push(id);

    await Promise.all([
      env.CONFIGS.put(daysKey, JSON.stringify(dayCounts)),
      env.CONFIGS.put(totalKey, String(totalCount)),
      env.CONFIGS.put(indexKey, JSON.stringify(index)),
      // Overwritten every time rather than only on first sight -- keeps
      // title/mediaType current if either ever changes upstream, and
      // lastSeen doubles as a cheap staleness signal in the dashboard.
      env.CONFIGS.put(metaKey, JSON.stringify({ title: title || "", mediaType: mediaType || "", lastSeen: Date.now() })),
    ]);
  } catch (e) {
    // best-effort -- never breaks the actual watch/list action riding along
  }
}

// Computes a top-100 leaderboard of the most tracked titles for a given
// event type ("watched" or "list-add") and time window -- powers the
// admin dashboard's Trending Data tab. See recordTrackedEvent's own
// comment for the underlying data model. "today"/"7"/"30"/"90" sum via
// each day's index (bounded to titles that were actually active
// somewhere in that window, not every title ever tracked); "alltime"
// reads each title's running total directly instead, since there's no
// day-index for it that would need summing. mediaTypeFilter ("movie" /
// "series" / falsy for both) is applied before the top-100 cut, not
// after, so filtering to just movies still returns up to 100 movies
// instead of whatever happened to survive filtering an already-mixed
// top 100.
async function computeLeaderboard(env, eventType, window, mediaTypeFilter) {
  if (!env || !env.CONFIGS) return [];
  const prefix = `evtcount:${eventType}:`;
  const wantType = mediaTypeFilter === "movie" || mediaTypeFilter === "series" ? mediaTypeFilter : null;

  if (window === "alltime") {
    const listResult = await listAllKeys(env.CONFIGS, prefix);
    // Cap the candidate pool. This branch reads the running-total key AND
    // metadata for EVERY title ever tracked before cutting to 100 -- 2 KV
    // reads each, which is ~2,000 reads at 1,000 titles and crosses
    // Cloudflare's 1,000-subrequest/invocation cap around 500 titles,
    // killing the whole Trending tab. We surface only 100, so a fixed
    // candidate ceiling bounds the cost regardless of corpus size; the
    // day-index windows below are capped the same way.
    const ALLTIME_CANDIDATE_CAP = 400;
    const alltimeKeys = listResult.keys
      .filter((k) => k.name.endsWith(":alltime"))
      .slice(0, ALLTIME_CANDIDATE_CAP);
    const entries = await Promise.all(
      alltimeKeys.map(async (k) => {
        const id = k.name.slice(prefix.length, -":alltime".length);
        const [countRaw, metaRaw] = await Promise.all([
          env.CONFIGS.get(k.name),
          env.CONFIGS.get(`evtmeta:${eventType}:${id}`),
        ]);
        let title = id;
        let mediaType = "";
        try {
          if (metaRaw) {
            const meta = JSON.parse(metaRaw);
            title = meta.title || id;
            mediaType = meta.mediaType || "";
          }
        } catch {
          // fall back to raw id as the title
        }
        return { id, title, mediaType, count: parseInt(countRaw, 10) || 0 };
      })
    );
    const filtered = wantType ? entries.filter((e) => e.mediaType === wantType) : entries;
    filtered.sort((a, b) => b.count - a.count);
    const topEntries = filtered.slice(0, 100);

    // Auto-resolve raw tt... or tmdb:... IDs to real titles if missing
    await Promise.all(
      topEntries.map(async (e) => {
        if (!e.title || e.title === e.id || /^tt\d+$/i.test(e.title) || /^tmdb:\d+$/i.test(e.title)) {
          try {
            if (typeof fetchTmdbItemDetails === "function") {
              const det = await fetchTmdbItemDetails(e.id, TMDB_API_KEY, e.mediaType, "", false, env, null).catch(() => null);
              if (det && det.title) {
                e.title = det.title;
                if (!e.mediaType && det.type) e.mediaType = (det.type === "tv" || det.type === "series") ? "series" : "movie";
                if (env && env.CONFIGS) {
                  env.CONFIGS.put(`evtmeta:${eventType}:${e.id}`, JSON.stringify({ title: det.title, mediaType: e.mediaType || "", lastSeen: Date.now() })).catch(() => {});
                }
              }
            }
          } catch {}
        }
      })
    );

    return topEntries;
  }

  const days = window === "today" ? 1 : parseInt(window, 10) || 7;
  const nowMs = Date.now();
  const dateKeys = [];
  for (let i = 0; i < days; i++) {
    dateKeys.push(easternDateKey(new Date(nowMs - i * 86400000)));
  }

  // Union of every title id that had any activity anywhere in this window.
  const indexResults = await Promise.all(dateKeys.map((d) => env.CONFIGS.get(`evtdayindex:${eventType}:${d}`)));
  const idSet = new Set();
  indexResults.forEach((raw) => {
    if (!raw) return;
    try {
      JSON.parse(raw).forEach((id) => idSet.add(id));
    } catch {
      // skip an unparseable day index rather than failing the whole window
    }
  });
  // Flat top-100 cap regardless of window width: each candidate now costs
  // exactly 2 KV reads below (one evtcount days-blob, one evtmeta) since
  // recordTrackedEvent stores every day's count for a title in a single
  // JSON blob rather than one key per day -- summing a 90-day window no
  // longer means 90 reads per candidate, just one. See
  // recordTrackedEvent's own comment for why that changed.
  const ids = [...idSet].slice(0, 100);

  const entries = await Promise.all(
    ids.map(async (id) => {
      const daysRaw = await env.CONFIGS.get(`evtcount:${eventType}:${id}:days`);
      let dayCounts = {};
      try {
        dayCounts = daysRaw ? JSON.parse(daysRaw) : {};
      } catch {
        dayCounts = {};
      }
      const count = dateKeys.reduce((sum, d) => sum + (parseInt(dayCounts[d], 10) || 0), 0);
      const metaRaw = await env.CONFIGS.get(`evtmeta:${eventType}:${id}`);
      let title = id;
      let mediaType = "";
      try {
        if (metaRaw) {
          const meta = JSON.parse(metaRaw);
          title = meta.title || id;
          mediaType = meta.mediaType || "";
        }
      } catch {
        // fall back to raw id as the title
      }
      return { id, title, mediaType, count };
    })
  );
  const filtered = wantType ? entries.filter((e) => e.mediaType === wantType) : entries;
  // count > 0 filter: without it, an id that's in today's/this window's
  // day-index (written unconditionally on every tracked event, regardless
  // of counter format) but has no data in the current evtcount:...:days
  // blob -- e.g. an id only ever tracked before this blob-based format
  // shipped, whose history lives solely under the old per-day-per-id keys
  // this branch no longer reads -- would show up as a real-looking
  // leaderboard row stuck at 0 forever. Matches the filter
  // computeSearchLeaderboard's equivalent branch already has; the alltime
  // branch above doesn't need one since it only ever lists ids that
  // already have a nonzero running total by construction.
  const nonZero = filtered.filter((e) => e.count > 0);
  nonZero.sort((a, b) => b.count - a.count);
  const topEntries = nonZero.slice(0, 100);

  // Auto-resolve raw tt... or tmdb:... IDs to real titles if missing
  await Promise.all(
    topEntries.map(async (e) => {
      if (!e.title || e.title === e.id || /^tt\d+$/i.test(e.title) || /^tmdb:\d+$/i.test(e.title)) {
        try {
          if (typeof fetchTmdbItemDetails === "function") {
            const det = await fetchTmdbItemDetails(e.id, TMDB_API_KEY, e.mediaType, "", false, env, null).catch(() => null);
            if (det && det.title) {
              e.title = det.title;
              if (!e.mediaType && det.type) e.mediaType = (det.type === "tv" || det.type === "series") ? "series" : "movie";
              if (env && env.CONFIGS) {
                env.CONFIGS.put(`evtmeta:${eventType}:${e.id}`, JSON.stringify({ title: det.title, mediaType: e.mediaType || "", lastSeen: Date.now() })).catch(() => {});
              }
            }
          }
        } catch {}
      }
    })
  );

  return topEntries;
}

// Lean sibling of recordTrackedEvent used only by the trending-data
// backfill (26_api-creator-and-admin-routes.js) -- updates just the
// all-time counter and metadata for a title, skipping the day-bucket and
// day-index writes recordTrackedEvent also does. Backfilling from
// existing Watch History/Custom List data has no natural "today" to
// bucket it under, and walking real historical per-day data would
// multiply KV operations well past a single Worker invocation's practical
// budget (Cloudflare's free-plan subrequest limit in particular) for any
// account with meaningful history. All-time-only is also the
// semantically correct home for this anyway: a rolling "last 7 days"
// window showing something watched two years ago wouldn't make sense
// even if it were cheap to compute. Returns true/false so the caller can
// track how many titles it actually got through this call.
async function backfillTitleCount(env, eventType, id, title, mediaType, incrementBy) {
  if (!env || !env.CONFIGS || !id || !incrementBy) return false;
  try {
    const totalKey = `evtcount:${eventType}:${id}:alltime`;
    const metaKey = `evtmeta:${eventType}:${id}`;
    const totalRaw = await env.CONFIGS.get(totalKey);
    const total = (parseInt(totalRaw, 10) || 0) + incrementBy;
    await Promise.all([
      env.CONFIGS.put(totalKey, String(total)),
      env.CONFIGS.put(metaKey, JSON.stringify({ title: title || "", mediaType: mediaType || "", lastSeen: Date.now() })),
    ]);
    return true;
  } catch (e) {
    return false;
  }
}

// Anonymous search query tracking
async function recordSearchQuery(env, query) {
  if (!env || !env.CONFIGS) return;
  const q = String(query || "").trim().toLowerCase().slice(0, 60);
  if (q.length < 2) return;
  try {
    const day = statsToday();
    const daysKey = `searchquery:${q}:days`;
    const totalKey = `searchquery:${q}:alltime`;
    const indexKey = `searchquerydayindex:${day}`;

    const [daysRaw, totalRaw, indexRaw] = await Promise.all([
      env.CONFIGS.get(daysKey),
      env.CONFIGS.get(totalKey),
      env.CONFIGS.get(indexKey),
    ]);
    // Same consolidated-blob shape as recordTrackedEvent above, and the
    // same reason: one JSON blob per query holding every day's count,
    // instead of one KV key per (query, day), so summing a wide window
    // costs one read per candidate query instead of one read per
    // candidate per day. See recordTrackedEvent's own comment for the
    // full story -- this is the same fix applied to the same bug in the
    // Search & Queries leaderboard.
    let dayCounts = {};
    try {
      dayCounts = daysRaw ? JSON.parse(daysRaw) : {};
    } catch {
      dayCounts = {};
    }
    dayCounts[day] = (dayCounts[day] || 0) + 1;
    const dayKeys = Object.keys(dayCounts).sort();
    if (dayKeys.length > 95) {
      dayKeys.slice(0, dayKeys.length - 95).forEach((k) => delete dayCounts[k]);
    }
    const totalCount = (parseInt(totalRaw, 10) || 0) + 1;

    let index = [];
    try {
      index = indexRaw ? JSON.parse(indexRaw) : [];
    } catch {
      index = [];
    }
    if (!index.includes(q)) index.push(q);

    await Promise.all([
      env.CONFIGS.put(daysKey, JSON.stringify(dayCounts)),
      env.CONFIGS.put(totalKey, String(totalCount)),
      env.CONFIGS.put(indexKey, JSON.stringify(index)),
    ]);
  } catch (e) {}
}

async function computeSearchLeaderboard(env, window) {
  if (!env || !env.CONFIGS) return [];
  const prefix = "searchquery:";
  if (window === "alltime") {
    const listResult = await listAllKeys(env.CONFIGS, prefix);
    // Same fan-out bound as computeLeaderboard's alltime branch: one read
    // per query ever recorded, so cap the candidates before the reads.
    const SEARCH_ALLTIME_CANDIDATE_CAP = 1000;
    const alltimeKeys = listResult.keys
      .filter((k) => k.name.endsWith(":alltime"))
      .slice(0, SEARCH_ALLTIME_CANDIDATE_CAP);
    const entries = await Promise.all(
      alltimeKeys.map(async (k) => {
        const query = k.name.slice(prefix.length, -":alltime".length);
        const countRaw = await env.CONFIGS.get(k.name);
        return { query, count: parseInt(countRaw, 10) || 0 };
      })
    );
    const valid = entries.filter((e) => e.count > 0);
    valid.sort((a, b) => b.count - a.count);
    return valid.slice(0, 100);
  }

  const days = window === "today" ? 1 : parseInt(window, 10) || 7;
  const nowMs = Date.now();
  const dateKeys = [];
  for (let i = 0; i < days; i++) {
    dateKeys.push(easternDateKey(new Date(nowMs - i * 86400000)));
  }

  // Union of every query that had any activity anywhere in this window,
  // from the day-index only -- same pattern as computeLeaderboard above.
  // This used to also list()-scan the entire "searchquery:" prefix (up to
  // 1000 keys) unconditionally on every call, which pulled in every query
  // ever recorded on any day, not just this window -- defeating the
  // day-index's entire purpose and inflating the candidate set (and the
  // KV reads below) regardless of how narrow a window was actually asked
  // for. Removed rather than kept "just in case": the day-index is
  // written every time recordSearchQuery runs, so there's nothing a raw
  // prefix scan would catch that the index doesn't already have.
  const indexResults = await Promise.all(dateKeys.map((d) => env.CONFIGS.get(`searchquerydayindex:${d}`)));
  const querySet = new Set();
  indexResults.forEach((raw) => {
    if (!raw) return;
    try {
      JSON.parse(raw).forEach((q) => querySet.add(q));
    } catch {}
  });

  // Flat top-100 cap regardless of window width -- see recordSearchQuery's
  // own comment: summing a window now costs one read per candidate query
  // (the days-blob), not one per candidate per day.
  const queries = [...querySet].slice(0, 100);

  const entries = await Promise.all(
    queries.map(async (q) => {
      const daysRaw = await env.CONFIGS.get(`searchquery:${q}:days`);
      let dayCounts = {};
      try {
        dayCounts = daysRaw ? JSON.parse(daysRaw) : {};
      } catch {
        dayCounts = {};
      }
      const count = dateKeys.reduce((sum, d) => sum + (parseInt(dayCounts[d], 10) || 0), 0);
      return { query: q, count };
    })
  );
  const valid = entries.filter((e) => e.count > 0);
  valid.sort((a, b) => b.count - a.count);
  return valid.slice(0, 100);
}

// Telemetry for Stremio playback tracking. Genre and decade counters are
// batched into one JSON blob write each (bumpJsonCounterBlob above)
// instead of a separate KV key per genre -- see that function's own
// comment for the write-count math and the tradeoff it makes.
// playback_pings and watch_type stay on bumpStat as-is: playback_pings is
// the one kind here that actually has a day-by-day reader (loadStatsByDay,
// used for the dashboard's 30-day trend table), so it needs its daily key.
async function recordPlaybackTelemetry(env, mediaType, genres, releaseYear) {
  if (!env || !env.CONFIGS) return;
  try {
    const promises = [bumpStat(env, "playback_pings")];
    const mt = mediaType === "episode" ? "episode" : mediaType === "series" ? "series" : "movie";
    promises.push(bumpStat(env, `watch_type:${mt}`));

    const genreList = Array.isArray(genres)
      ? genres
      : typeof genres === "string"
      ? genres.split(",").map((s) => s.trim()).filter(Boolean)
      : [];

    const cleanGenres = genreList.slice(0, 5).map((g) => String(g || "").trim()).filter(Boolean);
    if (cleanGenres.length) {
      promises.push(bumpJsonCounterBlob(env, "stats:genres:alltime", cleanGenres));
    }

    const yearNum = parseInt(releaseYear, 10);
    if (yearNum && yearNum > 1900 && yearNum < 2100) {
      let decade = "Classic (<1970)";
      if (yearNum >= 2020) decade = "2020s";
      else if (yearNum >= 2010) decade = "2010s";
      else if (yearNum >= 2000) decade = "2000s";
      else if (yearNum >= 1990) decade = "1990s";
      else if (yearNum >= 1980) decade = "1980s";
      else if (yearNum >= 1970) decade = "1970s";
      promises.push(bumpJsonCounterBlob(env, "stats:decades:alltime", [decade]));
    }
    await Promise.all(promises);
  } catch (e) {}
}

async function computeCatalogAndCommunityLeaderboards(env) {
  if (!env || !env.CONFIGS) return { catalogs: [], communityLists: [] };
  
  // 1. Installed Catalogs (combining catalog_add events and sourcegroup install counts)
  const [catalogList, sourceGroupList] = await Promise.all([
    listAllKeys(env.CONFIGS, "stats:catalog_add:"),
    listAllKeys(env.CONFIGS, "stats:sourcegroup:"),
  ]);

  const catalogMap = new Map();
  const totalCatalogKeys = (catalogList.keys || []).filter((k) => k.name.endsWith(":total"));
  const totalSourceGroupKeys = (sourceGroupList.keys || []).filter((k) => k.name.endsWith(":total"));

  await Promise.all([
    ...totalCatalogKeys.map(async (k) => {
      const name = k.name.slice("stats:catalog_add:".length, -":total".length);
      const raw = await env.CONFIGS.get(k.name);
      const count = parseInt(raw, 10) || 0;
      if (count > 0 && name) catalogMap.set(name, (catalogMap.get(name) || 0) + count);
    }),
    ...totalSourceGroupKeys.map(async (k) => {
      const name = k.name.slice("stats:sourcegroup:".length, -":total".length);
      const raw = await env.CONFIGS.get(k.name);
      const count = parseInt(raw, 10) || 0;
      if (count > 0 && name) catalogMap.set(name, (catalogMap.get(name) || 0) + count);
    }),
  ]);

  const catalogEntries = Array.from(catalogMap.entries()).map(([name, count]) => ({ name, count }));
  catalogEntries.sort((a, b) => b.count - a.count);

  // 2. Community / Creator Lists
  //
  // Copy counts live under stats:list_copy:{slug}:total, one key per slug
  // that has EVER been copied. Enumerate that short prefix ONCE (it's
  // bounded by real copy activity, not by list count, and lists that have
  // never been copied have no key) rather than doing one get per list --
  // that per-list fan-out (plus the reads below) is what made this panel
  // cost ~2 subrequests per list and eventually cross the 1,000 cap.
  const copiesBySlug = new Map();
  try {
    const copyList = await listAllKeys(env.CONFIGS, "stats:list_copy:");
    const copyTotalKeys = (copyList.keys || []).filter((k) => k.name.endsWith(":total"));
    await Promise.all(
      copyTotalKeys.map(async (k) => {
        const raw = await env.CONFIGS.get(k.name);
        const count = parseInt(raw, 10) || 0;
        if (count > 0) {
          const slug = k.name.slice("stats:list_copy:".length, -":total".length);
          copiesBySlug.set(slug, count);
        }
      })
    );
  } catch (e) {
    // best-effort: copy counts are a ranking tiebreak, not load-bearing
  }

  // Bounded candidate set regardless of store: the panel shows 100 lists,
  // so there is no reason to read every list in the system to get there.
  const COMMUNITY_CAP = 100;
  let communityListsRaw = [];
  if (env.DB) {
    // Project only what's needed and compute the item count in SQL. This
    // used to SELECT * (pulling every list's full items_json over the wire
    // just to call .length on it) with no limit. Likes come straight from
    // the likes column (kept current by the like route), which replaces
    // the old read of `creatorlistlikes:{slug}` -- a key no code path
    // writes, so the column used to show 0 for every list.
    const { results } = await env.DB.prepare(
      "SELECT id, username, name, type, visibility, likes, created_at, updated_at, json_array_length(items_json) AS item_count FROM creator_lists WHERE visibility = 'public' ORDER BY likes DESC, updated_at DESC LIMIT ?"
    ).bind(COMMUNITY_CAP).all();
    communityListsRaw = (results || []).map((row) => ({
      slug: row.id.split(':')[1] || row.id,
      name: row.name,
      creatorName: row.username,
      type: row.type || 'mixed',
      likes: Number(row.likes) || 0,
      itemCount: Number(row.item_count) || 0,
      updatedAt: row.updated_at || row.created_at || 0,
    }));
  } else {
    // KV-only fallback, bounded: enumerate at most the cap of keys instead
    // of every list in the system, then one get per bounded candidate.
    const listResult = await env.CONFIGS.list({ prefix: "creatorlist:", limit: COMMUNITY_CAP });
    communityListsRaw = (await Promise.all(
      (listResult.keys || []).map(async (k) => {
        const raw = await env.CONFIGS.get(k.name);
        if (!raw) return null;
        let data;
        try { data = JSON.parse(raw); } catch { return null; }
        if (!data || !isPublicListVisibility(data.visibility)) return null;
        if (!data.slug || !data.creatorName) return null;
        return {
          slug: data.slug,
          name: data.name || data.slug,
          creatorName: data.creatorName,
          type: data.type || 'mixed',
          likes: Number(data.likes) || 0,
          itemCount: Array.isArray(data.items) ? data.items.length : 0,
          updatedAt: data.updatedAt || data.createdAt || 0,
        };
      })
    )).filter(Boolean);
  }

  // No per-list KV reads remain: likes and itemCount already came from the
  // row/record above, copies come from the one prefix scan.
  const communityLists = communityListsRaw.map((data) => ({
    slug: data.slug,
    name: data.name || data.slug,
    creator: data.creatorName,
    type: data.type || 'mixed',
    itemCount: data.itemCount || 0,
    likes: data.likes || 0,
    copies: copiesBySlug.get(data.slug) || 0,
    updatedAt: data.updatedAt || 0,
  }));
  const validLists = communityLists.filter(Boolean);
  validLists.sort((a, b) => (b.likes + b.copies * 2) - (a.likes + a.copies * 2));

  return { catalogs: catalogEntries.slice(0, 100), communityLists: validLists.slice(0, 100) };
}

async function computeAudienceAnalytics(env) {
  if (!env || !env.CONFIGS) return { watchTypes: {}, genres: [], decades: [] };

  // Self-healing, same pattern as ensureTrackingMigrated elsewhere in this
  // add-on: runs the old-keys-into-new-blob migration once (see its own
  // comment), a no-op single read on every call after that.
  await migrateGenreDecadeStatsIfNeeded(env);

  const [movieRaw, seriesRaw, episodeRaw, genreBlobRaw, decadeBlobRaw] = await Promise.all([
    env.CONFIGS.get("stats:watch_type:movie:total"),
    env.CONFIGS.get("stats:watch_type:series:total"),
    env.CONFIGS.get("stats:watch_type:episode:total"),
    env.CONFIGS.get("stats:genres:alltime"),
    env.CONFIGS.get("stats:decades:alltime"),
  ]);

  const movies = parseInt(movieRaw, 10) || 0;
  const series = parseInt(seriesRaw, 10) || 0;
  const episodes = parseInt(episodeRaw, 10) || 0;
  const totalWatch = movies + series + episodes;

  let genreCounts = {};
  try {
    genreCounts = genreBlobRaw ? JSON.parse(genreBlobRaw) || {} : {};
  } catch {
    genreCounts = {};
  }
  const validGenres = Object.entries(genreCounts)
    .map(([name, count]) => ({ name, count: parseInt(count, 10) || 0 }))
    .filter((g) => g.count > 0 && g.name);
  validGenres.sort((a, b) => b.count - a.count);

  let decadeCounts = {};
  try {
    decadeCounts = decadeBlobRaw ? JSON.parse(decadeBlobRaw) || {} : {};
  } catch {
    decadeCounts = {};
  }
  const validDecades = Object.entries(decadeCounts)
    .map(([name, count]) => ({ name, count: parseInt(count, 10) || 0 }))
    .filter((d) => d.count > 0 && d.name);
  validDecades.sort((a, b) => b.count - a.count);

  return {
    watchTypes: { movies, series, episodes, total: totalWatch },
    genres: validGenres.slice(0, 50),
    decades: validDecades.slice(0, 50),
  };
}

// The group names bumpStatBy above gets called with ultimately come from
// the client's own collectEntries() -- not attacker-controlled in the
// normal case, but /api/track-install has no auth on it (same as the
// plain pageview/install counters), so a malicious request could send
// arbitrary junk trying to spam garbage keys into KV. This caps length and
// character set rather than trusting it outright; doesn't need to be
// exhaustive, just enough that a genuine group name always passes through
// untouched and abuse can't create unbounded distinct keys.
function sanitizeStatGroupName(raw) {
  const s = String(raw || "").trim().slice(0, 40);
  return /^[A-Za-z0-9 &().'-]+$/.test(s) ? s : null;
}

// Reads every stats:{kind}:YYYY-MM-DD entry via a prefix list (there's no
// KV range-query, so this is the only way to enumerate them) and returns a
// { "YYYY-MM-DD": count } map, skipping the :total key itself.
async function loadStatsByDay(env, kind) {
  if (!env || !env.CONFIGS) return {};
  const prefix = `stats:${kind}:`;
  const result = await listAllKeys(env.CONFIGS, prefix);
  const byDay = {};
  await Promise.all(
    result.keys.map(async (k) => {
      const day = k.name.slice(prefix.length);
      if (day === "total") return;
      const raw = await env.CONFIGS.get(k.name);
      byDay[day] = parseInt(raw, 10) || 0;
    })
  );
  return byDay;
}

// HMAC-SHA256 via the Workers runtime's native Web Crypto API, same
// approach as hashStringForKey above -- used to sign the admin session
// cookie so it can't be forged without knowing ADMIN_KEY, without needing
// any server-side session storage (the cookie IS the session: an
// expiry timestamp plus a signature over that timestamp).
async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const ADMIN_COOKIE_NAME = "mla_admin";
const ADMIN_SESSION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

async function makeAdminCookieValue(env) {
  const expiresAt = Date.now() + ADMIN_SESSION_MS;
  const sig = await hmacHex(env.ADMIN_KEY, String(expiresAt));
  return `${expiresAt}.${sig}`;
}

async function isValidAdminCookie(env, value) {
  if (!value || !env || !env.ADMIN_KEY) return false;
  const dot = value.indexOf(".");
  if (dot === -1) return false;
  const expiresAtStr = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expiresAt = parseInt(expiresAtStr, 10);
  if (!expiresAt || Date.now() > expiresAt) return false;
  const expectedSig = await hmacHex(env.ADMIN_KEY, expiresAtStr);
  return timingSafeEqualHex(sig, expectedSig);
}

function parseCookies(request) {
  const header = request.headers.get("Cookie") || "";
  const map = {};
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) {
      try {
        map[k] = decodeURIComponent(v);
      } catch {
        map[k] = v;
      }
    }
  });
  return map;
}

async function isAdminRequest(request, env) {
  const cookies = parseCookies(request);
  return isValidAdminCookie(env, cookies[ADMIN_COOKIE_NAME]);
}

function renderAdminLoginPage(errorMsg) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#F2F2F7">
<title>Admin \u2014 ${ADDON_NAME}</title>
<link rel="icon" type="image/png" href="/icon.png">
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
    --danger: #FF3B30;
    --shadow-sm: 0 1px 3px rgba(0,0,0,0.06);
    --shadow: 0 2px 10px rgba(0,0,0,0.08);
    --radius: 14px;
    --radius-sm: 10px;
    --radius-pill: 999px;
    --font-body: 'Inter', -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
  }
  html.dark-theme {
    --bg: #000000; --surface: #1C1C1E; --panel-strong: #2C2C2E;
    --border: rgba(255,255,255,0.15); --border-strong: rgba(255,255,255,0.25);
    --text: #FFFFFF; --text-2: #EBEBF5;
  }
  * { box-sizing: border-box; }
  body {
    font-family: var(--font-body);
    margin: 0;
    min-height: 100vh;
    background: var(--bg);
    color: var(--text);
    font-size: 15px;
    -webkit-font-smoothing: antialiased;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px 16px;
  }
  .login-wrap { width: 100%; max-width: 380px; }
  .login-header {
    display: flex; align-items: center; justify-content: center; gap: 10px;
    margin-bottom: 20px;
  }
  .login-header img { width: 36px; height: 36px; border-radius: 10px; box-shadow: var(--shadow-sm); }
  .login-header span { font-size: 1.2rem; font-weight: 800; letter-spacing: -0.02em; color: var(--text); }
  .panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-sm);
    padding: 20px;
    width: 100%;
  }
  .panel-title { font-size: 1.1rem; font-weight: 700; margin: 0 0 14px; letter-spacing: -0.01em; color: var(--text); }
  .row { display: flex; flex-direction: column; align-items: stretch; gap: 10px; margin-bottom: 0; width: 100%; }
  input {
    width: 100%;
    padding: 11px 14px;
    border-radius: var(--radius-sm);
    border: 1.5px solid var(--border-strong);
    background: var(--surface);
    color: var(--text);
    outline: none;
    font-size: 16px;
    font-family: inherit;
    min-height: 44px;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(0,122,255,0.15); }
  button {
    width: 100%;
    margin-top: 14px;
    padding: 11px 18px;
    min-height: 44px;
    border-radius: var(--radius-pill);
    border: none;
    background: var(--accent);
    color: #fff;
    cursor: pointer;
    font-weight: 600;
    font-size: 0.925rem;
    font-family: inherit;
    transition: opacity 0.12s;
  }
  button:hover { opacity: 0.85; }
  .err { color: var(--danger); margin: 14px 0 0; font-size: 0.85rem; }
</style></head>
<body>
  <div class="login-wrap">
    <div class="login-header">
      <img src="/icon.png" alt="${ADDON_NAME}">
      <span>${ADDON_NAME}</span>
    </div>
    <div class="panel">
      <h2 class="panel-title">Admin sign in</h2>
      <form method="POST" action="/admin/login">
        <div class="row">
          <input type="password" name="key" placeholder="Admin key" autofocus>
        </div>
        <button type="submit">Sign in</button>
      </form>
      ${errorMsg ? `<p class="err">${escapeHtmlServer(errorMsg)}</p>` : ""}
    </div>
  </div>
</body></html>`;
}

async function renderAdminDashboard(env) {
  if (!env || !env.CONFIGS) {
    return `<!DOCTYPE html><html><body style="background:#F2F2F7;color:#1C1C1E;font-family:sans-serif;padding:40px;">This Worker has no CONFIGS KV namespace bound, so there's no stats to show.</body></html>`;
  }
  const today = statsToday();
  const [
    totalPV, todayPV, totalIN, todayIN, totalPP, todayPP,
    pvByDay, inByDay, ppByDay,
    creatorResult, sourceGroupResult
  ] = await Promise.all([
    env.CONFIGS.get("stats:pageviews:total"),
    env.CONFIGS.get(`stats:pageviews:${today}`),
    env.CONFIGS.get("stats:installs:total"),
    env.CONFIGS.get(`stats:installs:${today}`),
    env.CONFIGS.get("stats:playback_pings:total"),
    env.CONFIGS.get(`stats:playback_pings:${today}`),
    loadStatsByDay(env, "pageviews"),
    loadStatsByDay(env, "installs"),
    loadStatsByDay(env, "playback_pings"),
    // "creator:" (with the colon) is deliberately narrow -- creatorlist:,
    // creatorsync:, etc. all start with "creator" too but not "creator:",
    // so this can't accidentally sweep those in as if they were accounts.
    listAllKeys(env.CONFIGS, "creator:"),
    listAllKeys(env.CONFIGS, "stats:sourcegroup:"),
  ]);

  // Walks the last 30 calendar days explicitly (rather than just listing
  // whatever KV happens to have) so days with zero activity still show up
  // as a 0 row instead of silently vanishing from the table. Same Eastern-
  // time day boundary as statsToday()/bumpStat() above, so these labels
  // actually match the keys being looked up.
  const rows = [];
  const nowMs = Date.now();
  for (let i = 0; i < 30; i++) {
    const key = easternDateKey(new Date(nowMs - i * 86400000));
    rows.push(`<tr><td>${key}</td><td>${pvByDay[key] || 0}</td><td>${inByDay[key] || 0}</td><td>${ppByDay[key] || 0}</td></tr>`);
  }

  // Creator accounts. The total is counted separately from the rows we
  // render because creators can outnumber a single request's safe read
  // budget: the stat card must report the true number of accounts rather
  // than silently displaying the capped number as if it were the total.
  let creatorAccounts = [];
  let totalCreatorCount = 0;
  // Hard ceiling on how many accounts one dashboard load will render. The
  // page is for a human eyeballing the newest/most-recent accounts, not
  // paging through thousands, and this keeps a load bounded regardless of
  // how large the site grows (the real cap is Cloudflare's 1,000
  // subrequests/invocation; D1 rows are cheap, so this sits just under it
  // to leave headroom for everything else the page does).
  const CREATOR_RENDER_CAP = 1000;
  if (env.DB) {
    // One query for the count, one bounded query for the rows -- no
    // per-account reads. last_active now comes straight from the row (kept
    // current by touchCreatorLastSeen), which is what removed the old
    // one-KV-get-per-creator fan-out.
    let count = 0;
    try {
      const countRes = await env.DB.prepare("SELECT COUNT(*) AS n FROM creators").all();
      count = countRes.results && countRes.results[0] ? Number(countRes.results[0].n) || 0 : 0;
    } catch (e) {
      console.error("D1 creator count failed:", e);
    }
    totalCreatorCount = count;
    const { results } = await env.DB.prepare(
      "SELECT username, display_name, created_at, last_active FROM creators ORDER BY last_active DESC, created_at DESC LIMIT ?"
    ).bind(CREATOR_RENDER_CAP).all();
    creatorAccounts = (results || []).map((row) => ({
      username: row.username,
      displayName: row.display_name,
      createdAt: row.created_at || null,
      lastActive: row.last_active || null,
    }));
    // Historical accounts have NULL last_active in D1; repair a bounded
    // batch from KV each load (see backfillCreatorLastActive).
    await backfillCreatorLastActive(env, creatorAccounts);
  } else {
    // KV-only fallback. listAllKeys is a full cursor sweep (fine for
    // enumerating, no per-key reads), then bound the fan-out: a KV get per
    // account over more than this many would blow the subrequest cap, so
    // cap the renders and report the real total.
    totalCreatorCount = (creatorResult.keys || []).length;
    const keys = (creatorResult.keys || []).slice(0, CREATOR_RENDER_CAP);
    creatorAccounts = await Promise.all(
      keys.map(async (k) => {
        const username = k.name.slice("creator:".length);
        let displayName = username;
        let createdAt = null;
        try {
          const raw = await env.CONFIGS.get(k.name);
          if (raw) {
            const data = JSON.parse(raw);
            displayName = data.displayName || username;
            createdAt = typeof data.createdAt === "number" ? data.createdAt : null;
          }
        } catch {}
        let lastActive = null;
        try {
          const lastRaw = await env.CONFIGS.get(`creatorlastseen:${username}`);
          lastActive = lastRaw ? parseInt(lastRaw, 10) || null : null;
        } catch {}
        return { username, displayName, createdAt, lastActive };
      })
    );
  }

  creatorAccounts.sort((a, b) => (b.lastActive || b.createdAt || 0) - (a.lastActive || a.createdAt || 0));
  const shownCreatorCount = creatorAccounts.length;
  const accountRows = creatorAccounts
    .map(
      (c) =>
        `<tr><td>${escapeHtmlServer(c.displayName)}</td><td>${escapeHtmlServer(c.username)}</td>` +
        `<td>${c.createdAt ? easternDateKey(new Date(c.createdAt)) : "\u2014"}</td>` +
        `<td>${c.lastActive ? easternDateKey(new Date(c.lastActive)) : "\u2014"}</td>` +
        // data-* attributes here rather than passing c.displayName inline into
        // the onclick string -- displayName is arbitrary creator-chosen text
        // (only .trim()'d server-side, not restricted to safe characters the
        // way the normalized username is), so splicing it directly into an
        // onclick="..." attribute would both break on a display name
        // containing a quote and, worse, let a crafted display name inject
        // script into this admin page. escapeHtmlServer handles the HTML-
        // attribute escaping here the same way it already does for the two
        // <td> values above; resetCreatorKey reads the values back off the
        // element at click time instead of receiving them as literals.
        `<td><button type="button" class="lc-btn secondary" style="padding:4px 10px; font-size:0.8rem;" data-username="${escapeHtmlServer(c.username)}" data-displayname="${escapeHtmlServer(c.displayName)}" onclick="resetCreatorKey(this)">Reset Key</button></td></tr>`
    )
    .join("");
  const creatorTruncatedNote = shownCreatorCount < totalCreatorCount
    ? `, showing ${shownCreatorCount} of ${totalCreatorCount}`
    : "";

  // Each key is stats:sourcegroup:{group}:total -- strip both ends to get
  // the group name back. ":total" is a fixed suffix here (see bumpStatBy's
  // total-only design above), so a plain slice is enough, no need to guard
  // against a stray per-day key existing alongside it the way
  // loadStatsByDay has to for pageviews/installs.
  let sourceGroups = [];
  if (env.DB) {
    const { results } = await env.DB.prepare("SELECT * FROM source_groups").all();
    sourceGroups = results.map(row => ({ group: row.name, count: row.install_count }));
  } else {
    const sourceGroupPrefix = "stats:sourcegroup:";
    sourceGroups = await Promise.all(
      sourceGroupResult.keys.map(async (k) => {
        const group = k.name.slice(sourceGroupPrefix.length, -":total".length);
        const raw = await env.CONFIGS.get(k.name);
        return { group, count: parseInt(raw, 10) || 0 };
      })
    );
  }
  sourceGroups.sort((a, b) => b.count - a.count);
  const sourceGroupTotal = sourceGroups.reduce((sum, g) => sum + g.count, 0);
  const sourceGroupRows = sourceGroups
    .map((g) => {
      const pct = sourceGroupTotal ? Math.round((g.count / sourceGroupTotal) * 100) : 0;
      return `<tr><td>${escapeHtmlServer(g.group)}</td><td>${g.count}</td><td>${pct}%</td></tr>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin \u2014 My Lists Addon</title>
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
    --danger: #FF3B30;
    --success: #34C759;
    --shadow-sm: 0 1px 3px rgba(0,0,0,0.06);
    --shadow: 0 2px 10px rgba(0,0,0,0.08);
    --shadow-md: 0 8px 30px rgba(0,0,0,0.18);
    --radius: 14px;
    --radius-sm: 10px;
    --radius-pill: 999px;
  }
  html.dark-theme {
    --bg: #000000; --surface: #1C1C1E; --panel-strong: #2C2C2E;
    --border: rgba(255,255,255,0.15); --border-strong: rgba(255,255,255,0.25);
    --text: #FFFFFF; --text-2: #EBEBF5;
  }
  * { box-sizing: border-box; }
  body { background:var(--bg); color:var(--text); font-family:'Inter',-apple-system,BlinkMacSystemFont,'SF Pro Text',system-ui,sans-serif; max-width:900px; margin:0 auto; padding:20px 14px; }
  h1 { margin-bottom:4px; font-size:1.6rem; color:var(--text); }
  h2 { font-size:1.1rem; color:var(--text); }
  .stat-cards { display:grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap:12px; margin:16px 0; }
  .stat-card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:14px; box-shadow:var(--shadow-sm); }
  .stat-value { font-size:1.6rem; font-weight:700; color:var(--text); }
  .stat-label { color:var(--muted); font-size:0.82rem; margin-top:4px; }
  .table-wrap { width:100%; overflow-x:auto; -webkit-overflow-scrolling:touch; margin-top:10px; background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); box-shadow:var(--shadow-sm); }
  table { width:100%; border-collapse:collapse; background:var(--surface); border:none; margin:0; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--border); font-size:0.85rem; white-space:nowrap; color:var(--text); }
  th { color:var(--muted); font-weight:600; background:var(--panel-strong); }
  a { color:var(--accent); }
  .admin-main-tab-bar { display:flex; gap:16px; border-bottom:1px solid var(--border); margin-top:20px; flex-wrap:wrap; }
  .admin-main-tab-btn {
    background:none; border:none; color:var(--muted); font-size:0.95rem; font-weight:700; cursor:pointer;
    padding:10px 4px; margin-bottom:-1px; border-bottom:2px solid transparent; transition:color 0.15s ease;
  }
  .admin-main-tab-btn:hover { color:var(--text); }
  .admin-main-tab-btn.active { color:var(--text); border-bottom-color:var(--accent); }
  .admin-subnav-bar { display:flex; gap:8px; margin:14px 0 16px; flex-wrap:wrap; }
  .subnav-pill {
    background:var(--surface); border:1px solid var(--border); border-radius:20px; padding:6px 14px;
    font-size:0.85rem; font-weight:600; color:var(--muted); cursor:pointer; transition:all 0.15s ease;
  }
  .subnav-pill:hover { border-color:var(--border-strong); color:var(--text); }
  .subnav-pill.active { background:var(--accent); color:#FFFFFF; border-color:var(--accent); }
  .admin-tab-panel { display:none; }
  .admin-tab-panel.active { display:block; }
  .admin-select { padding:6px 10px; border-radius:var(--radius-sm); border:1px solid var(--border-strong); background:var(--surface); color:var(--text); font-size:0.85rem; margin-right:6px; outline:none; }
  .admin-badge { display:inline-block; padding:2px 8px; border-radius:6px; font-size:0.75rem; font-weight:700; text-transform:uppercase; }
  .admin-badge.bug { background:rgba(255,59,48,0.12); color:var(--danger); }
  .admin-badge.improvement { background:rgba(0,122,255,0.12); color:var(--accent); }
  .admin-badge.idea { background:rgba(255,149,0,0.12); color:#FF9500; }
  .admin-badge.other { background:rgba(142,142,147,0.15); color:var(--muted); }
  .feedback-card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:14px 16px; margin-top:10px; box-shadow:var(--shadow-sm); }
  .feedback-card.completed { opacity:0.55; }
  .feedback-card-header { display:flex; justify-content:space-between; align-items:flex-start; gap:10px; flex-wrap:wrap; }
  .feedback-actions { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
  .feedback-meta { color:var(--muted); font-size:0.8rem; margin-top:6px; }
  .feedback-message { margin-top:8px; white-space:pre-wrap; font-size:0.92rem; word-break:break-word; color:var(--text); }
  .netflix-preview-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap:10px; margin-top:10px; }
  .netflix-preview-poster { width:100%; aspect-ratio:2/3; object-fit:cover; border-radius:8px; background:var(--panel-strong); box-shadow:var(--shadow-sm); }
  .netflix-preview-poster-placeholder { width:100%; aspect-ratio:2/3; border-radius:8px; background:var(--panel-strong); display:flex; align-items:center; justify-content:center; color:var(--muted); font-size:0.75rem; text-align:center; padding:6px; }
  .netflix-preview-title { font-size:0.8rem; margin-top:4px; line-height:1.25; color:var(--text); }
  .netflix-preview-year { color:var(--muted); font-size:0.75rem; }

  /* Standard Modals & Buttons */
  .modal-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.5);
    display: flex; align-items: center; justify-content: center;
    padding: 16px; z-index: 1000;
  }
  .modal-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 20px; padding: 22px; max-width: 440px; width: 100%;
    max-height: 90vh; overflow-y: auto; box-shadow: var(--shadow-md);
    color: var(--text);
  }
  .modal-close-x {
    float: right; background: var(--bg); border: 1px solid var(--border-strong);
    color: var(--muted); font-size: 1rem; cursor: pointer;
    padding: 4px 10px; border-radius: 8px;
  }
  .modal-close-x:hover { color: var(--text); border-color: var(--text-2); }
  .lc-btn {
    padding: 10px 18px; min-height: 38px; border-radius: var(--radius-pill);
    border: none; background: var(--accent); color: #fff; cursor: pointer;
    font-weight: 600; font-size: 0.925rem; font-family: inherit;
    display: inline-flex; align-items: center; justify-content: center;
    transition: opacity 0.12s; text-decoration: none;
  }
  .lc-btn.secondary {
    background: var(--surface); color: var(--text);
    border: 1.5px solid var(--border-strong);
  }
  .lc-btn.danger {
    background: var(--danger); color: #fff; border: none;
  }
  .lc-btn:hover:not(:disabled) { opacity: 0.85; }
  .lc-btn:disabled { opacity: 0.4; cursor: default; }

  @media (max-width: 600px) {
    body { padding: 14px 10px; }
    .stat-cards { grid-template-columns: repeat(2, 1fr); gap: 8px; }
    .feedback-card { padding: 12px; }
    .feedback-card-header { flex-direction: column; align-items: flex-start !important; }
    .feedback-actions { width: 100%; }
    .feedback-actions button { flex-grow: 1; text-align: center; }
  }
</style></head>
<body>
  <h1>Admin Dashboard</h1>
  <p style="color:#8E8E93; margin-top:0;">My Lists Addon usage stats.</p>

  <div class="admin-main-tab-bar" role="tablist">
    <button type="button" class="admin-main-tab-btn active" data-main-tab="overview" onclick="switchAdminMainTab('overview')">Overview &amp; Traffic</button>
    <button type="button" class="admin-main-tab-btn" data-main-tab="discovery" onclick="switchAdminMainTab('discovery')">Analytics &amp; Discovery</button>
    <button type="button" class="admin-main-tab-btn" data-main-tab="management" onclick="switchAdminMainTab('management')">Management &amp; Tools</button>
  </div>

  <div class="admin-subnav-bar" id="adminSubnavOverview">
    <button type="button" class="subnav-pill active" data-sub-tab="last30" onclick="switchAdminSubTab('last30')">Last 30 Days</button>
    <button type="button" class="subnav-pill" data-sub-tab="sources" onclick="switchAdminSubTab('sources')">Sources people use</button>
    <button type="button" class="subnav-pill" data-sub-tab="apiusage" onclick="switchAdminSubTab('apiusage')">API Usage</button>
  </div>
  <div class="admin-subnav-bar" id="adminSubnavDiscovery" style="display:none;">
    <button type="button" class="subnav-pill" data-sub-tab="trending" onclick="switchAdminSubTab('trending')">Trending Data</button>
    <button type="button" class="subnav-pill" data-sub-tab="search" onclick="switchAdminSubTab('search')">Search &amp; Queries</button>
    <button type="button" class="subnav-pill" data-sub-tab="catalogs_lists" onclick="switchAdminSubTab('catalogs_lists')">Catalogs &amp; Lists</button>
    <button type="button" class="subnav-pill" data-sub-tab="audience" onclick="switchAdminSubTab('audience')">Playback &amp; Audience</button>
  </div>
  <div class="admin-subnav-bar" id="adminSubnavManagement" style="display:none;">
    <button type="button" class="subnav-pill" data-sub-tab="creators" onclick="switchAdminSubTab('creators')">Creator Accounts</button>
    <button type="button" class="subnav-pill" data-sub-tab="feedback" onclick="switchAdminSubTab('feedback')">Feedback</button>
    <button type="button" class="subnav-pill" data-sub-tab="netflixpreview" onclick="switchAdminSubTab('netflixpreview')">Provider Preview</button>
  </div>

  <div class="admin-tab-panel active" data-admin-panel="last30">
    <div class="stat-cards">
      <div class="stat-card"><div class="stat-value">${parseInt(totalPV, 10) || 0}</div><div class="stat-label">Total page views</div></div>
      <div class="stat-card"><div class="stat-value">${parseInt(todayPV, 10) || 0}</div><div class="stat-label">Page views today</div></div>
      <div class="stat-card"><div class="stat-value">${parseInt(totalIN, 10) || 0}</div><div class="stat-label">Total install links</div></div>
      <div class="stat-card"><div class="stat-value">${parseInt(todayIN, 10) || 0}</div><div class="stat-label">Install links today</div></div>
      <div class="stat-card"><div class="stat-value">${parseInt(totalPP, 10) || 0}</div><div class="stat-label">Total playback streams</div></div>
      <div class="stat-card"><div class="stat-value">${parseInt(todayPP, 10) || 0}</div><div class="stat-label">Streams today</div></div>
    </div>
    <div class="table-wrap">
      <table>
        <tr><th>Date</th><th>Page views</th><th>Install links</th><th>Playback pings</th></tr>
        ${rows.join("")}
      </table>
    </div>
  </div>

  <div class="admin-tab-panel" data-admin-panel="creators">
    <div class="stat-cards">
      <div class="stat-card"><div class="stat-value">${totalCreatorCount}</div><div class="stat-label">Creator accounts${creatorTruncatedNote}</div></div>
    </div>
    <div class="table-wrap">
      <table>
        <tr><th>Display name</th><th>Username</th><th>Created</th><th>Last Active</th><th>Key</th></tr>
        ${accountRows || '<tr><td colspan="5">No accounts yet.</td></tr>'}
      </table>
    </div>
  </div>

  <div class="admin-tab-panel" data-admin-panel="sources">
    <p style="color:#8E8E93; margin-top:0; font-size:0.9rem;">Counted from each row's group at the moment an install link is generated -- one Custom List and one Channel in the same install still count as one of each, five MDBList Charts rows count as five.</p>
    <div class="table-wrap">
      <table>
        <tr><th>Source</th><th>Count</th><th>Share</th></tr>
        ${sourceGroupRows || '<tr><td colspan="3">No data yet.</td></tr>'}
      </table>
    </div>
  </div>

  <div class="admin-tab-panel" data-admin-panel="trending">
    <p style="color:#8E8E93; margin-top:0; font-size:0.9rem;">How many times each title has been marked watched or added to a list, across everyone using this add-on. Meant to eventually seed this add-on's own trending/popular catalogs once there's enough data.</p>
    <div style="margin:12px 0;">
      <select class="admin-select" id="trendingTypeSelect" onchange="loadTrendingData()">
        <option value="watched">Most Watched</option>
        <option value="list-add">Most Added to Lists</option>
      </select>
      <select class="admin-select" id="trendingWindowSelect" onchange="loadTrendingData()">
        <option value="today">Today</option>
        <option value="7" selected>Last 7 Days</option>
        <option value="30">Last 30 Days</option>
        <option value="90">Last 90 Days</option>
        <option value="alltime">All Time</option>
      </select>
      <select class="admin-select" id="trendingMediaTypeSelect" onchange="loadTrendingData()">
        <option value="">Movies + Shows</option>
        <option value="movie">Movies Only</option>
        <option value="series">Shows Only</option>
      </select>
      <button type="button" class="admin-select" style="cursor:pointer;" id="backfillTrendingBtn" onclick="runBackfillTrending()">Backfill Existing Data</button>
      <span id="backfillTrendingStatus" style="color:#8E8E93; font-size:0.85rem; margin-left:6px;"></span>
    </div>
    <p style="color:#8E8E93; margin:0 0 12px; font-size:0.8rem;">Backfill only adds to the <strong>All Time</strong> window (there's no historical date to bucket existing data into 7/30/90-day windows) -- it seeds counts from Watch History and Custom Lists that already existed before this feature shipped. Safe to run more than once; it only adds, never resets anything. Processes accounts a few at a time, so it may take a minute for larger sites.</p>
    <div style="margin:0 0 12px;">
      <button type="button" class="admin-select" style="cursor:pointer;" id="migrateDayCountsBtn" onclick="runMigrateDayCounts()">Migrate Historical Day Counts</button>
      <span id="migrateDayCountsStatus" style="color:#8E8E93; font-size:0.85rem; margin-left:6px;"></span>
      <p style="color:#8E8E93; margin:6px 0 0; font-size:0.8rem;">One-time migration for the switch from one KV key per day to one JSON blob per title -- reads every old per-day count still sitting in KV and folds it into the new format, so 7/30/90-day windows reflect activity from before that switch instead of only counting forward from it. Safe to run more than once (adds, never subtracts); old keys are deleted once folded in, so re-running just confirms there's nothing left. Also covers the Search &amp; Queries leaderboard.</p>
    </div>
    <div class="table-wrap">
      <table>
        <tr><th>#</th><th>Title</th><th>Type</th><th>Count</th></tr>
        <tbody id="trendingTableBody"><tr><td colspan="4">Loading\u2026</td></tr></tbody>
      </table>
    </div>
  </div>

  <div class="admin-tab-panel" data-admin-panel="search">
    <p style="color:#8E8E93; margin-top:0; font-size:0.9rem;">Anonymous queries and search terms users have entered in the Discover and Search tabs.</p>
    <div style="margin:12px 0;">
      <select class="admin-select" id="searchWindowSelect" onchange="loadSearchData()">
        <option value="today">Today</option>
        <option value="7" selected>Last 7 Days</option>
        <option value="30">Last 30 Days</option>
        <option value="90">Last 90 Days</option>
        <option value="alltime">All Time</option>
      </select>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Search Query</th><th>Count</th></tr></thead>
        <tbody id="searchTableBody"><tr><td colspan="3">Loading\u2026</td></tr></tbody>
      </table>
    </div>
  </div>

  <div class="admin-tab-panel" data-admin-panel="catalogs_lists">
    <h2 style="margin-top:0;">Most Installed Curated &amp; Provider Catalogs</h2>
    <p style="color:#8E8E93; margin-top:0; font-size:0.9rem;">Which built-in charts and provider catalogs users add to their Stremio configuration.</p>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Catalog / Chart Name</th><th>Times Installed</th></tr></thead>
        <tbody id="installedCatalogsTableBody"><tr><td colspan="3">Loading\u2026</td></tr></tbody>
      </table>
    </div>

    <h2 style="margin-top:28px;">Top Community &amp; Creator Lists</h2>
    <p style="color:#8E8E93; margin-top:0; font-size:0.9rem;">Ranked by community engagement (likes and list copies/imports).</p>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>List Name</th><th>Creator</th><th>Type</th><th>Items</th><th>Likes</th><th>Copies</th></tr></thead>
        <tbody id="topCommunityListsTableBody"><tr><td colspan="7">Loading\u2026</td></tr></tbody>
      </table>
    </div>
  </div>

  <div class="admin-tab-panel" data-admin-panel="audience">
    <p style="color:#8E8E93; margin-top:0; font-size:0.9rem;">Audience viewing breakdown derived from Stremio stream playback pings.</p>
    
    <div class="stat-cards">
      <div class="stat-card"><div class="stat-value" id="audienceTotalPlays">0</div><div class="stat-label">Total streams tracked</div></div>
      <div class="stat-card"><div class="stat-value" id="audienceMoviePlays">0</div><div class="stat-label">Movie plays</div></div>
      <div class="stat-card"><div class="stat-value" id="audienceSeriesPlays">0</div><div class="stat-label">Show plays</div></div>
      <div class="stat-card"><div class="stat-value" id="audienceEpisodePlays">0</div><div class="stat-label">Episode plays</div></div>
    </div>

    <h2 style="margin-top:20px;">Top Watched Genres</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Genre</th><th>Stream Count</th></tr></thead>
        <tbody id="topGenresTableBody"><tr><td colspan="3">Loading\u2026</td></tr></tbody>
      </table>
    </div>

    <h2 style="margin-top:28px;">Release Era / Decades</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Release Era</th><th>Stream Count</th></tr></thead>
        <tbody id="topDecadesTableBody"><tr><td colspan="3">Loading\u2026</td></tr></tbody>
      </table>
    </div>
  </div>

  <div class="admin-tab-panel" data-admin-panel="feedback">
    <p style="color:#8E8E93; margin-top:0; font-size:0.9rem;">Bug reports, improvement requests, and ideas submitted from Settings &gt; Feedback, newest first.</p>
    <div class="feedback-card">
      <div style="font-weight:600; margin-bottom:8px;">Log something yourself</div>
      <select class="admin-select" id="newFeedbackCategory" style="margin-bottom:8px;">
        <option value="bug" selected>Bug</option>
        <option value="improvement">Improvement</option>
        <option value="idea">Idea</option>
        <option value="other">Other</option>
      </select>
      <textarea id="newFeedbackMessage" placeholder="What did you find?" style="width:100%; min-height:70px; box-sizing:border-box; padding:10px 12px; border-radius:8px; border:1px solid rgba(0,0,0,0.15); font-family:inherit; font-size:0.9rem; resize:vertical;"></textarea>
      <div style="margin-top:8px; display:flex; align-items:center; gap:10px;">
        <button type="button" class="admin-select" style="cursor:pointer;" id="newFeedbackSubmitBtn" onclick="submitAdminFeedback()">Add to list</button>
        <span id="newFeedbackStatus" style="color:#8E8E93; font-size:0.85rem;"></span>
      </div>
    </div>
    <div id="feedbackList">Loading\u2026</div>
  </div>

  <!-- Edit Feedback Modal -->
  <div id="editFeedbackModal" class="modal-overlay" style="display:none;">
    <div class="modal-card" style="max-width:500px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <h3 style="margin:0; font-size:1.15rem; font-weight:700; color:var(--text);">Edit Feedback</h3>
        <button type="button" class="modal-close-x" onclick="closeEditFeedbackModal()">&#x2715;</button>
      </div>
      <input type="hidden" id="editFeedbackId">
      <label style="display:block; font-size:0.82rem; font-weight:600; color:var(--muted); margin-bottom:6px;">Category</label>
      <select class="admin-select" id="editFeedbackCategory" style="margin-bottom:14px; width:100%; padding:10px 12px; border-radius:var(--radius-sm); border:1.5px solid var(--border-strong); background:var(--surface); color:var(--text);">
        <option value="bug">bug</option>
        <option value="improvement">improvement</option>
        <option value="idea">idea</option>
        <option value="other">other</option>
      </select>
      <label style="display:block; font-size:0.82rem; font-weight:600; color:var(--muted); margin-bottom:6px;">Message</label>
      <textarea id="editFeedbackMessage" style="width:100%; min-height:120px; box-sizing:border-box; padding:10px 12px; border-radius:var(--radius-sm); border:1.5px solid var(--border-strong); background:var(--surface); color:var(--text); font-family:inherit; font-size:0.92rem; resize:vertical; margin-bottom:16px; outline:none;"></textarea>
      <div style="display:flex; justify-content:flex-end; gap:10px;">
        <button type="button" class="lc-btn secondary" onclick="closeEditFeedbackModal()">Cancel</button>
        <button type="button" class="lc-btn primary" id="editFeedbackSaveBtn" onclick="saveEditFeedback()">Save Changes</button>
      </div>
    </div>
  </div>

  <div class="admin-tab-panel" data-admin-panel="apiusage">
    <p style="color:#8E8E93; margin-top:0; font-size:0.9rem;">Requests made using this Worker's own shared API keys (the fallback used whenever a visitor hasn't supplied their own) -- not counting anyone's personal keys, which only they can rate-limit. Watch these against each provider's limit if catalogs start coming back empty or slow.</p>
    <div class="table-wrap">
      <table>
        <tr><th>Key</th><th>Last 24h</th><th>Last 7 days</th><th>Last 30 days</th><th>Provider limit</th></tr>
        <tbody id="apiUsageTableBody"><tr><td colspan="5">Loading\u2026</td></tr></tbody>
      </table>
    </div>
  </div>
  </div>

  <div class="admin-tab-panel" data-admin-panel="netflixpreview">
    <p style="color:#8E8E93; margin-top:0; font-size:0.9rem;">A look at what a TMDB-discover-based shelf would actually contain for any streaming provider, before wiring it into Quick Add for real -- pulled live from TMDB, not a saved list. Counts are TMDB/JustWatch's own tracking, not the provider's real numbers, and typically run a bit under what trackers like FlixPatrol report.</p>

    <div class="panel" style="margin:0 0 18px; padding:14px 16px;">
      <div style="font-weight:600; font-size:0.9rem; margin-bottom:8px;">Find a provider's id</div>
      <p style="color:#8E8E93; margin:0 0 10px; font-size:0.82rem;">TMDB sometimes has more than one entry for the same service (e.g. two separate "Disney Plus" ids) -- look the name up here rather than guessing, since a wrong id fails silently: it just quietly shows the wrong catalog under the right label.</p>
      <div style="display:flex; gap:8px; align-items:center;">
        <input type="text" id="providerLookupQueryInput" class="admin-select" style="margin-right:0; flex:1; max-width:220px;" placeholder="e.g. disney, max, hulu" onkeydown="if(event.key==='Enter'){event.preventDefault();lookupProviderIds();}">
        <button type="button" class="secondary lc-btn" onclick="lookupProviderIds()">Search</button>
        <span id="providerLookupStatus" style="color:#8E8E93; font-size:0.85rem;"></span>
      </div>
      <div id="providerLookupResults" style="margin-top:10px;"></div>
    </div>

    <div style="display:flex; gap:8px; align-items:center; margin-bottom:16px; flex-wrap:wrap;">
      <label style="font-size:0.85rem; color:#8E8E93;">Provider id
        <input type="text" id="netflixPreviewProviderIdInput" class="admin-select" style="margin-right:0; width:60px;" value="8" placeholder="8">
      </label>
      <label style="font-size:0.85rem; color:#8E8E93;">Region
        <input type="text" id="netflixPreviewRegionInput" class="admin-select" style="margin-right:0; width:70px; text-transform:uppercase;" value="US" maxlength="2" placeholder="US">
      </label>
      <button type="button" class="secondary lc-btn" onclick="loadNetflixPreview()">Load Preview</button>
      <span id="netflixPreviewStatus" style="color:#8E8E93; font-size:0.85rem;"></span>
    </div>
    <div id="netflixPreviewMovies"></div>
    <div id="netflixPreviewShows" style="margin-top:28px;"></div>
  </div>

  <p style="margin-top:24px;"><a href="/admin/logout">Log out</a></p>
  <script>
    const categoryDefaults = {
      overview: 'last30',
      discovery: 'trending',
      management: 'creators',
    };
    const tabToCategory = {
      last30: 'overview',
      sources: 'overview',
      apiusage: 'overview',
      trending: 'discovery',
      search: 'discovery',
      catalogs_lists: 'discovery',
      audience: 'discovery',
      creators: 'management',
      feedback: 'management',
      netflixpreview: 'management',
    };

    function switchAdminMainTab(catId) {
      document.querySelectorAll('.admin-main-tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.mainTab === catId));
      document.querySelectorAll('.admin-subnav-bar').forEach((bar) => {
        bar.style.display = bar.id === ('adminSubnav' + catId.charAt(0).toUpperCase() + catId.slice(1)) ? 'flex' : 'none';
      });
      let targetSubTab = categoryDefaults[catId] || 'last30';
      try {
        const savedTab = localStorage.getItem('myListAddon:adminActiveTab');
        if (savedTab && tabToCategory[savedTab] === catId) {
          targetSubTab = savedTab;
        }
      } catch (e) {}
      switchAdminSubTab(targetSubTab);
    }

    function switchAdminSubTab(tabId, updateUrl = true) {
      const cat = tabToCategory[tabId] || 'overview';
      try {
        localStorage.setItem('myListAddon:adminActiveTab', tabId);
      } catch (e) {}
      if (updateUrl && history.replaceState) {
        history.replaceState(null, '', '#' + tabId);
      }
      document.querySelectorAll('.admin-main-tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.mainTab === cat));
      document.querySelectorAll('.admin-subnav-bar').forEach((bar) => {
        bar.style.display = bar.id === ('adminSubnav' + cat.charAt(0).toUpperCase() + cat.slice(1)) ? 'flex' : 'none';
      });
      document.querySelectorAll('.subnav-pill').forEach((p) => p.classList.toggle('active', p.dataset.subTab === tabId));
      document.querySelectorAll('.admin-tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.adminPanel === tabId));

      if (tabId === 'trending' && !window._trendingLoadedOnce) { window._trendingLoadedOnce = true; loadTrendingData(); }
      if (tabId === 'search' && !window._searchLoadedOnce) { window._searchLoadedOnce = true; loadSearchData(); }
      if (tabId === 'catalogs_lists' && !window._catalogsListsLoadedOnce) { window._catalogsListsLoadedOnce = true; loadCatalogsAndListsData(); }
      if (tabId === 'audience' && !window._audienceLoadedOnce) { window._audienceLoadedOnce = true; loadAudienceData(); }
      if (tabId === 'feedback' && !window._feedbackLoadedOnce) { window._feedbackLoadedOnce = true; loadFeedback(); }
      if (tabId === 'apiusage' && !window._apiUsageLoadedOnce) { window._apiUsageLoadedOnce = true; loadApiUsage(); }
      if (tabId === 'netflixpreview' && !window._netflixPreviewLoadedOnce) { window._netflixPreviewLoadedOnce = true; loadNetflixPreview(); }
    }

    // Alias for compatibility
    function switchAdminTab(tabId) {
      switchAdminSubTab(tabId);
    }

    function restoreAdminActiveTab() {
      let targetTab = '';
      const hashTab = (window.location.hash || '').replace(/^#/, '').trim();
      if (hashTab && tabToCategory[hashTab]) {
        targetTab = hashTab;
      } else {
        try {
          const savedTab = localStorage.getItem('myListAddon:adminActiveTab');
          if (savedTab && tabToCategory[savedTab]) {
            targetTab = savedTab;
          }
        } catch (e) {}
      }
      if (!targetTab) targetTab = 'last30';
      switchAdminSubTab(targetTab, false);
    }

    window.addEventListener('hashchange', () => {
      const hashTab = (window.location.hash || '').replace(/^#/, '').trim();
      if (hashTab && tabToCategory[hashTab]) {
        switchAdminSubTab(hashTab, false);
      }
    });

    restoreAdminActiveTab();

    // Resets a creator's login key server-side (see /admin/api/reset-creator-key
    // -- it can only invalidate + replace, never recover the original,
    // since only a salted hash of it is ever stored). Two-step confirm
    // matching this dashboard's other destructive actions: a plain
    // confirm() naming exactly what's about to happen and to whom, then
    // the new key is shown once in a copyable box -- there is no second
    // chance to see it, same as the reveal shown at signup.
    async function resetCreatorKey(btn) {
      const username = btn.dataset.username;
      const displayName = btn.dataset.displayname;
      const sure = confirm(
        'Reset the login key for "' + displayName + '" (' + username + ')?\\n\\n' +
        'Their current key will stop working immediately. You will need to ' +
        'send them the new key yourself -- there is no email on file to send it to.'
      );
      if (!sure) return;
      try {
        const res = await fetch('/admin/api/reset-creator-key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: username }),
        });
        const data = await res.json();
        if (!data.ok) {
          alert('Could not reset key: ' + (data.error || 'unknown error'));
          return;
        }
        showResetKeyModal(displayName, data.creatorKey);
      } catch (e) {
        alert('Network error -- could not reset key. Try again.');
      }
    }

    function showResetKeyModal(displayName, creatorKey) {
      const overlay = document.createElement('div');
      overlay.id = 'resetKeyOverlay';
      overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:9999;';
      overlay.innerHTML =
        '<div style="background:#fff; border-radius:12px; padding:24px; max-width:380px; width:90%;">' +
          '<h3 style="margin-top:0;">New key for ' + escapeHtmlAdmin(displayName) + '</h3>' +
          '<p style="color:#8E8E93; font-size:0.9rem;">This is shown once. Copy it now and send it to the creator yourself -- their old key no longer works.</p>' +
          '<div id="resetKeyDisplay" style="font-family:monospace; font-size:1.1rem; background:#F2F2F7; border-radius:8px; padding:10px; text-align:center; margin:12px 0; user-select:all;">' + escapeHtmlAdmin(creatorKey) + '</div>' +
          '<div style="display:flex; gap:8px;">' +
            '<button type="button" class="lc-btn secondary" style="flex:1;" onclick="navigator.clipboard.writeText(\\'' + creatorKey + '\\'); this.textContent=\\'Copied!\\';">Copy Key</button>' +
            '<button type="button" class="lc-btn" style="flex:1;" onclick="document.getElementById(\\'resetKeyOverlay\\').remove();">Done</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);
    }

    async function loadSearchData() {
      const body = document.getElementById('searchTableBody');
      body.innerHTML = '<tr><td colspan="3">Loading\u2026</td></tr>';
      const win = document.getElementById('searchWindowSelect').value;
      try {
        const res = await fetch('/admin/api/analytics?section=search&window=' + encodeURIComponent(win));
        const data = await res.json();
        if (!data.ok || !data.searches || !data.searches.length) {
          body.innerHTML = '<tr><td colspan="3">No searches recorded yet for this window.</td></tr>';
          return;
        }
        body.innerHTML = data.searches.map((s, i) =>
          '<tr><td>' + (i + 1) + '</td><td><strong>' + escapeHtmlAdmin(s.query) + '</strong></td><td>' + s.count + '</td></tr>'
        ).join('');
      } catch (e) {
        body.innerHTML = '<tr><td colspan="3">Could not load search data -- try again.</td></tr>';
      }
    }

    async function loadCatalogsAndListsData() {
      const catBody = document.getElementById('installedCatalogsTableBody');
      const listBody = document.getElementById('topCommunityListsTableBody');
      catBody.innerHTML = '<tr><td colspan="3">Loading\u2026</td></tr>';
      listBody.innerHTML = '<tr><td colspan="7">Loading\u2026</td></tr>';
      try {
        const res = await fetch('/admin/api/analytics?section=catalogs_lists');
        const data = await res.json();
        if (!data.ok) {
          catBody.innerHTML = '<tr><td colspan="3">Could not load.</td></tr>';
          listBody.innerHTML = '<tr><td colspan="7">Could not load.</td></tr>';
          return;
        }
        if (!data.catalogs || !data.catalogs.length) {
          catBody.innerHTML = '<tr><td colspan="3">No catalog installations recorded yet.</td></tr>';
        } else {
          catBody.innerHTML = data.catalogs.map((c, i) =>
            '<tr><td>' + (i + 1) + '</td><td>' + escapeHtmlAdmin(c.name) + '</td><td>' + c.count + '</td></tr>'
          ).join('');
        }

        if (!data.communityLists || !data.communityLists.length) {
          listBody.innerHTML = '<tr><td colspan="7">No community lists found.</td></tr>';
        } else {
          listBody.innerHTML = data.communityLists.map((l, i) =>
            '<tr><td>' + (i + 1) + '</td><td><strong>' + escapeHtmlAdmin(l.name) + '</strong></td><td>' + escapeHtmlAdmin(l.creator) + '</td><td>' + escapeHtmlAdmin(l.type) + '</td><td>' + l.itemCount + '</td><td>&#x2764; ' + l.likes + '</td><td>' + l.copies + '</td></tr>'
          ).join('');
        }
      } catch (e) {
        catBody.innerHTML = '<tr><td colspan="3">Could not load -- try again.</td></tr>';
        listBody.innerHTML = '<tr><td colspan="7">Could not load -- try again.</td></tr>';
      }
    }

    async function loadAudienceData() {
      const genresBody = document.getElementById('topGenresTableBody');
      const decadesBody = document.getElementById('topDecadesTableBody');
      genresBody.innerHTML = '<tr><td colspan="3">Loading\u2026</td></tr>';
      decadesBody.innerHTML = '<tr><td colspan="3">Loading\u2026</td></tr>';
      try {
        const res = await fetch('/admin/api/analytics?section=audience');
        const data = await res.json();
        if (!data.ok) {
          genresBody.innerHTML = '<tr><td colspan="3">Could not load.</td></tr>';
          decadesBody.innerHTML = '<tr><td colspan="3">Could not load.</td></tr>';
          return;
        }

        const wt = data.watchTypes || {};
        document.getElementById('audienceTotalPlays').textContent = (wt.total || 0).toLocaleString();
        document.getElementById('audienceMoviePlays').textContent = (wt.movies || 0).toLocaleString();
        document.getElementById('audienceSeriesPlays').textContent = (wt.series || 0).toLocaleString();
        document.getElementById('audienceEpisodePlays').textContent = (wt.episodes || 0).toLocaleString();

        if (!data.genres || !data.genres.length) {
          genresBody.innerHTML = '<tr><td colspan="3">No genre playback data yet.</td></tr>';
        } else {
          genresBody.innerHTML = data.genres.map((g, i) =>
            '<tr><td>' + (i + 1) + '</td><td>' + escapeHtmlAdmin(g.name) + '</td><td>' + g.count + '</td></tr>'
          ).join('');
        }

        if (!data.decades || !data.decades.length) {
          decadesBody.innerHTML = '<tr><td colspan="3">No decade playback data yet.</td></tr>';
        } else {
          decadesBody.innerHTML = data.decades.map((d, i) =>
            '<tr><td>' + (i + 1) + '</td><td>' + escapeHtmlAdmin(d.name) + '</td><td>' + d.count + '</td></tr>'
          ).join('');
        }
      } catch (e) {
        genresBody.innerHTML = '<tr><td colspan="3">Could not load -- try again.</td></tr>';
        decadesBody.innerHTML = '<tr><td colspan="3">Could not load -- try again.</td></tr>';
      }
    }

    function escapeHtmlAdmin(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    async function loadTrendingData() {
      const body = document.getElementById('trendingTableBody');
      body.innerHTML = '<tr><td colspan="4">Loading\u2026</td></tr>';
      const type = document.getElementById('trendingTypeSelect').value;
      const win = document.getElementById('trendingWindowSelect').value;
      const mediaType = document.getElementById('trendingMediaTypeSelect').value;
      try {
        const res = await fetch('/admin/api/leaderboard?type=' + encodeURIComponent(type) + '&window=' + encodeURIComponent(win) + (mediaType ? '&mediaType=' + encodeURIComponent(mediaType) : ''));
        const data = await res.json();
        if (!data.ok || !data.entries || !data.entries.length) {
          body.innerHTML = '<tr><td colspan="4">No data yet for this window.</td></tr>';
          return;
        }
        body.innerHTML = data.entries.map((e, i) =>
          '<tr><td>' + (i + 1) + '</td><td>' + escapeHtmlAdmin(e.title || e.id) + '</td><td>' + escapeHtmlAdmin(e.mediaType === 'series' ? 'Show' : 'Movie') + '</td><td>' + e.count + '</td></tr>'
        ).join('');
      } catch (e) {
        body.innerHTML = '<tr><td colspan="4">Could not load -- try again.</td></tr>';
      }
    }

    async function runBackfillTrending() {
      const btn = document.getElementById('backfillTrendingBtn');
      const status = document.getElementById('backfillTrendingStatus');
      btn.disabled = true;
      let accountsDone = 0;
      let titlesDone = 0;
      let safetyCounter = 0;
      // safetyCounter guards against an unexpected infinite loop (e.g. a
      // bug that never returns done:true) -- 500 calls is comfortably
      // past what any realistic account count needs right now, and this
      // is a manual, admin-triggered action, not something that runs
      // unattended.
      try {
        while (safetyCounter < 500) {
          safetyCounter++;
          const res = await fetch('/admin/api/backfill-trending', { method: 'POST' });
          const data = await res.json();
          if (!data.ok) {
            status.textContent = 'Stopped: ' + (data.error || 'unknown error') + ' (processed ' + accountsDone + ' account' + (accountsDone === 1 ? '' : 's') + ')';
            break;
          }
          if (data.done) {
            status.textContent = 'Done \u2014 processed ' + accountsDone + ' account' + (accountsDone === 1 ? '' : 's') + ', ' + titlesDone + ' title update' + (titlesDone === 1 ? '' : 's') + '.';
            break;
          }
          accountsDone += data.accountsThisCall || 0;
          titlesDone += data.titlesThisCall || 0;
          status.textContent = 'Working\u2026 ' + accountsDone + ' account' + (accountsDone === 1 ? '' : 's') + ' processed so far.';
        }
      } catch (e) {
        status.textContent = 'Stopped: network error (processed ' + accountsDone + ' accounts).';
      }
      btn.disabled = false;
      loadTrendingData();
    }

    // Same shape as runBackfillTrending just above -- see
    // /admin/api/migrate-day-counts's own comment for what this is
    // actually migrating and why.
    async function runMigrateDayCounts() {
      const btn = document.getElementById('migrateDayCountsBtn');
      const status = document.getElementById('migrateDayCountsStatus');
      btn.disabled = true;
      let keysMigrated = 0;
      let safetyCounter = 0;
      try {
        while (safetyCounter < 1000) {
          safetyCounter++;
          const res = await fetch('/admin/api/migrate-day-counts', { method: 'POST' });
          const data = await res.json();
          if (!data.ok) {
            status.textContent = 'Stopped: ' + (data.error || 'unknown error') + ' (migrated ' + keysMigrated + ' day-count' + (keysMigrated === 1 ? '' : 's') + ')';
            break;
          }
          if (data.done) {
            status.textContent = 'Done \u2014 migrated ' + keysMigrated + ' old day-count' + (keysMigrated === 1 ? '' : 's') + ' into the new format.';
            break;
          }
          keysMigrated += data.keysMigratedThisCall || 0;
          status.textContent = 'Working\u2026 ' + keysMigrated + ' day-count' + (keysMigrated === 1 ? '' : 's') + ' migrated so far.';
        }
      } catch (e) {
        status.textContent = 'Stopped: network error (migrated ' + keysMigrated + ' day-counts).';
      }
      btn.disabled = false;
      loadTrendingData();
      if (typeof loadSearchData === 'function') loadSearchData();
    }

    async function loadApiUsage() {
      const body = document.getElementById('apiUsageTableBody');
      body.innerHTML = '<tr><td colspan="5">Loading\u2026</td></tr>';
      try {
        const res = await fetch('/admin/api/apiusage');
        const data = await res.json();
        if (!data.ok || !data.keys || !data.keys.length) {
          body.innerHTML = '<tr><td colspan="5">No data yet.</td></tr>';
          return;
        }
        body.innerHTML = data.keys.map((k) =>
          '<tr>' +
            '<td>' + escapeHtmlAdmin(k.label) + (k.configured ? '' : ' <span style="color:#FF9500;">(not set)</span>') + '</td>' +
            '<td>' + k.last24h + '</td>' +
            '<td>' + k.last7d + '</td>' +
            '<td>' + k.last30d + '</td>' +
            '<td style="color:#8E8E93;">' + escapeHtmlAdmin(k.limit) + '</td>' +
          '</tr>'
        ).join('');
      } catch (e) {
        body.innerHTML = '<tr><td colspan="5">Could not load -- try again.</td></tr>';
      }
    }

    function netflixPreviewSectionHtml(label, section) {
      if (!section) return '';
      const posters = section.items.map((it) =>
        '<div>' +
          (it.poster
            ? '<img class="netflix-preview-poster" src="' + escapeHtmlAdmin(it.poster) + '" alt="" loading="lazy">'
            : '<div class="netflix-preview-poster-placeholder">No poster</div>') +
          '<div class="netflix-preview-title">' + escapeHtmlAdmin(it.title) + '</div>' +
          (it.date ? '<div class="netflix-preview-year">' + escapeHtmlAdmin(it.date) + '</div>' : '') +
        '</div>'
      ).join('');
      return '<h3 style="margin:0 0 4px; font-size:1.05rem;">' + label + ' <span style="color:#8E8E93; font-weight:400; font-size:0.85rem;">(~' + section.total.toLocaleString() + ' total on TMDB/JustWatch, showing first ' + section.items.length + ')</span></h3>' +
        '<div class="netflix-preview-grid">' + posters + '</div>';
    }

    async function loadNetflixPreview() {
      const statusEl = document.getElementById('netflixPreviewStatus');
      const moviesEl = document.getElementById('netflixPreviewMovies');
      const showsEl = document.getElementById('netflixPreviewShows');
      const regionInput = document.getElementById('netflixPreviewRegionInput');
      const providerIdInput = document.getElementById('netflixPreviewProviderIdInput');
      const region = (regionInput.value || 'US').trim().toUpperCase().slice(0, 2) || 'US';
      const providerId = (providerIdInput.value || '8').trim() || '8';
      statusEl.textContent = 'Loading\u2026';
      moviesEl.innerHTML = '';
      showsEl.innerHTML = '';
      try {
        const res = await fetch('/admin/api/netflix-preview?region=' + encodeURIComponent(region) + '&providerId=' + encodeURIComponent(providerId));
        const data = await res.json();
        if (!data.ok) {
          statusEl.textContent = data.error || 'Could not load preview.';
          return;
        }
        statusEl.textContent = '';
        moviesEl.innerHTML = netflixPreviewSectionHtml('Movies', data.movies);
        showsEl.innerHTML = netflixPreviewSectionHtml('Shows', data.shows);
      } catch (e) {
        statusEl.textContent = 'Could not load -- check your connection.';
      }
    }

    // Fills the Provider id field from a lookup result and immediately
    // reloads the preview with it -- clicking a name found this way should
    // just show that provider's shelf, not require a second manual click.
    function pickProviderId(id) {
      document.getElementById('netflixPreviewProviderIdInput').value = id;
      loadNetflixPreview();
    }

    async function lookupProviderIds() {
      const statusEl = document.getElementById('providerLookupStatus');
      const resultsEl = document.getElementById('providerLookupResults');
      const queryInput = document.getElementById('providerLookupQueryInput');
      const regionInput = document.getElementById('netflixPreviewRegionInput');
      const query = (queryInput.value || '').trim();
      const region = (regionInput.value || 'US').trim().toUpperCase().slice(0, 2) || 'US';
      statusEl.textContent = 'Searching\u2026';
      resultsEl.innerHTML = '';
      try {
        const res = await fetch('/admin/api/provider-lookup?region=' + encodeURIComponent(region) + (query ? '&query=' + encodeURIComponent(query) : ''));
        const data = await res.json();
        if (!data.ok) {
          statusEl.textContent = data.error || 'Could not search.';
          return;
        }
        statusEl.textContent = '';
        if (!data.results.length) {
          resultsEl.innerHTML = '<p style="color:#8E8E93; font-size:0.85rem;">No matches.</p>';
          return;
        }
        resultsEl.innerHTML = data.results.map((p) =>
          '<button type="button" class="admin-select" style="cursor:pointer; margin:0 6px 6px 0;" onclick="pickProviderId(' + p.id + ')">' +
            escapeHtmlAdmin(p.name) + ' <span style="color:#8E8E93;">(' + p.id + ')</span>' +
          '</button>'
        ).join('');
      } catch (e) {
        statusEl.textContent = 'Could not search -- check your connection.';
      }
    }

    // feedbackEntries is the client's local copy of the list, kept in sync
    // with the server -- submitAdminFeedback and toggleFeedbackStatus both
    // mutate this array and re-render immediately (optimistic), then send
    // the real change to the server in the background, only reaching back
    // into the DOM again if that background call fails and the local
    // change needs to be rolled back.
    let feedbackEntries = [];
    let feedbackTruncated = false;

    async function loadFeedback() {
      const box = document.getElementById('feedbackList');
      box.textContent = 'Loading\u2026';
      try {
        const res = await fetch('/admin/api/feedback');
        const data = await res.json();
        if (!data.ok) {
          box.innerHTML = '<p style="color:#FF3B30;">Could not load feedback -- try again.</p>';
          return;
        }
        feedbackEntries = data.entries || [];
        feedbackTruncated = !!data.truncated;
        renderFeedbackList();
      } catch (e) {
        box.innerHTML = '<p style="color:#FF3B30;">Could not load feedback -- try again.</p>';
      }
    }

    // Pure render of whatever's currently in feedbackEntries -- called
    // after the initial load, and again (instantly, no fetch) any time
    // submitAdminFeedback/toggleFeedbackStatus change that array so the
    // list reflects the change right away instead of waiting on a round
    // trip back to the server.
    function renderFeedbackList() {
      const box = document.getElementById('feedbackList');
      if (!box) return;
      if (!feedbackEntries.length) {
        box.innerHTML = '<p style="color:#8E8E93;">No feedback yet.</p>';
        return;
      }
      const open = feedbackEntries.filter((f) => !f.completed);
      const done = feedbackEntries.filter((f) => f.completed);
      box.innerHTML = open.map(feedbackCardHtml).join('') +
        (done.length ? '<h3 style="margin:20px 0 4px; font-size:0.95rem; color:#8E8E93;">Completed</h3>' + done.map(feedbackCardHtml).join('') : '') +
        (feedbackTruncated ? '<p style="color:#8E8E93; font-size:0.85rem;">Showing the most recent 300.</p>' : '');
      initFeedbackListEvents();
    }

    function feedbackCardHtml(f) {
      const cat = ['bug', 'improvement', 'idea', 'other'].includes(f.category) ? f.category : 'other';
      const when = f.createdAt ? new Date(f.createdAt).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }) : '';
      const isSelfLogged = f.creatorName === 'admin';
      const who = isSelfLogged ? 'admin (self-logged)' : (f.creatorName ? escapeHtmlAdmin(f.creatorName) : 'anonymous');
      const contact = f.contact ? ' \u2014 ' + escapeHtmlAdmin(f.contact) : '';
      const completed = !!f.completed;
      const statusLabel = (!isSelfLogged && f.status === 'replied')
        ? '<span class="admin-badge improvement" style="margin-left:6px;">Replied</span>'
        : (completed ? '<span class="admin-badge other" style="margin-left:6px;">Resolved</span>' : '<span class="admin-badge bug" style="margin-left:6px;">Open</span>');

      const messages = Array.isArray(f.messages) && f.messages.length
        ? f.messages
        : [{
            id: 'msg_init',
            sender: isSelfLogged ? 'admin' : 'user',
            senderName: isSelfLogged ? 'Admin' : (f.creatorName || 'User'),
            text: f.message || '',
            timestamp: f.createdAt || Date.now()
          }];

      const messagesHtml = messages.map((m) => {
        const isAdmin = m.sender === 'admin';
        const sender = isAdmin ? '\uD83D\uDC68\u200D\uD83D\uDCBB Developer (Admin)' : (m.senderName || who);
        const mTime = m.timestamp ? new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        const bg = isAdmin ? 'rgba(0,122,255,0.08)' : 'rgba(255,255,255,0.04)';
        const border = isAdmin ? 'rgba(0,122,255,0.25)' : 'var(--border)';
        return '<div style="margin-top:6px; padding:8px 12px; border-radius:8px; background:' + bg + '; border:1px solid ' + border + ';">' +
          '<div style="display:flex; justify-content:space-between; font-size:0.75rem; font-weight:700; color:' + (isAdmin ? 'var(--accent)' : 'var(--text)') + ';">' +
            '<span>' + escapeHtmlAdmin(sender) + '</span>' +
            '<span style="color:var(--muted); font-weight:normal;">' + escapeHtmlAdmin(mTime) + '</span>' +
          '</div>' +
          '<div style="margin-top:4px; font-size:0.88rem; white-space:pre-wrap; word-break:break-word; color:var(--text);">' + escapeHtmlAdmin(m.text || '') + '</div>' +
        '</div>';
      }).join('');

      return '<div class="feedback-card' + (completed ? ' completed' : '') + '" id="feedbackCard_' + escapeHtmlAdmin(f.id) + '">' +
        '<div class="feedback-card-header">' +
          '<div>' +
            '<span class="admin-badge ' + cat + '">' + cat + '</span>' +
            statusLabel +
          '</div>' +
          '<div class="feedback-actions">' +
            '<button type="button" class="admin-select fb-copy-btn" data-id="' + escapeHtmlAdmin(f.id) + '" style="margin:0; cursor:pointer;">&#x2398; Copy</button>' +
            '<button type="button" class="admin-select fb-edit-btn" data-id="' + escapeHtmlAdmin(f.id) + '" style="margin:0; cursor:pointer;">&#x270E; Edit</button>' +
            '<button type="button" class="admin-select fb-status-btn" data-id="' + escapeHtmlAdmin(f.id) + '" data-completed="' + (!completed) + '" style="margin:0; cursor:pointer;">' +
              (completed ? '\u21a9 Reopen' : '\u2713 Mark done') +
            '</button>' +
            '<button type="button" class="admin-select fb-delete-btn" data-id="' + escapeHtmlAdmin(f.id) + '" style="margin:0; cursor:pointer; color:#FF3B30; border-color:rgba(255,59,48,0.3);">&#x2715; Delete</button>' +
          '</div>' +
        '</div>' +
        '<div style="margin-top:10px;">' + messagesHtml + '</div>' +
        '<div class="feedback-meta" style="margin-top:8px;">' + when + ' \u2014 ' + who + contact + '</div>' +
        (!isSelfLogged ?
          '<div style="margin-top:10px; display:flex; gap:8px; align-items:center;">' +
            '<input type="text" id="adminReplyInput_' + escapeHtmlAdmin(f.id) + '" class="admin-select fb-reply-input" data-id="' + escapeHtmlAdmin(f.id) + '" style="flex:1; margin-right:0; padding:8px 10px;" placeholder="Type reply to ' + escapeHtmlAdmin(who) + '...">' +
            '<button type="button" class="secondary lc-btn fb-reply-btn" data-id="' + escapeHtmlAdmin(f.id) + '" style="padding:6px 14px; font-size:0.82rem;">Reply</button>' +
          '</div>' : ''
        ) +
      '</div>';
    }

    function initFeedbackListEvents() {
      const listEl = document.getElementById('feedbackList');
      if (!listEl || listEl._eventsBound) return;
      listEl._eventsBound = true;

      listEl.addEventListener('click', (e) => {
        const replyBtn = e.target.closest('.fb-reply-btn');
        if (replyBtn) {
          sendAdminFeedbackReply(replyBtn.dataset.id);
          return;
        }
        const copyBtn = e.target.closest('.fb-copy-btn');
        if (copyBtn) {
          copyFeedbackMessage(copyBtn, copyBtn.dataset.id);
          return;
        }
        const editBtn = e.target.closest('.fb-edit-btn');
        if (editBtn) {
          openEditFeedbackModal(editBtn.dataset.id);
          return;
        }
        const statusBtn = e.target.closest('.fb-status-btn');
        if (statusBtn) {
          toggleFeedbackStatus(statusBtn.dataset.id, statusBtn.dataset.completed === 'true');
          return;
        }
        const deleteBtn = e.target.closest('.fb-delete-btn');
        if (deleteBtn) {
          deleteFeedbackEntry(deleteBtn.dataset.id);
          return;
        }
      });

      listEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const input = e.target.closest('.fb-reply-input');
          if (input) {
            e.preventDefault();
            sendAdminFeedbackReply(input.dataset.id);
          }
        }
      });
    }

    async function sendAdminFeedbackReply(id) {
      const input = document.getElementById('adminReplyInput_' + id);
      const text = (input ? input.value : '').trim();
      if (!text) return;
      input.disabled = true;

      try {
        const res = await fetch('/admin/api/feedback/reply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: id, message: text }),
        });
        const data = await res.json().catch(() => null);
        if (data && data.ok && data.entry) {
          const idx = feedbackEntries.findIndex((f) => f.id === id);
          if (idx !== -1) {
            feedbackEntries[idx] = data.entry;
          }
          renderFeedbackList();
        } else {
          showAdminAlert('Reply Failed', (data && data.error) || 'Could not send reply.', false);
          if (input) input.disabled = false;
        }
      } catch (e) {
        showAdminAlert('Connection Error', 'Could not send reply -- check your connection.', false);
        if (input) input.disabled = false;
      }
    }

    // Lets the admin log an issue directly from the dashboard, without
    // going through Settings > Feedback -- posts to the same /api/feedback
    // endpoint real users hit, just tagged so it's obviously self-logged
    // in the list below. Optimistic: the card appears the instant this
    // function runs, built from a temporary client-side id, and is
    // swapped for the server's real entry once the save actually
    // completes (or removed again if it fails).
    async function submitAdminFeedback() {
      const category = document.getElementById('newFeedbackCategory').value;
      const messageBox = document.getElementById('newFeedbackMessage');
      const message = messageBox.value.trim();
      const status = document.getElementById('newFeedbackStatus');
      const btn = document.getElementById('newFeedbackSubmitBtn');
      if (!message) {
        status.textContent = 'Type something first.';
        return;
      }
      btn.disabled = true;

      const tempId = 'temp:' + Date.now() + ':' + Math.random().toString(36).slice(2, 8);
      const optimisticEntry = {
        id: tempId,
        category: category,
        message: message,
        contact: null,
        creatorName: 'admin',
        createdAt: Date.now(),
        completed: false,
      };
      feedbackEntries.unshift(optimisticEntry);
      renderFeedbackList();
      messageBox.value = '';
      status.textContent = 'Saving\u2026';

      try {
        const res = await fetch('/api/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // fromAdminPanel: true is the deliberate signal that this
          // request really is the admin dashboard's own "Log something
          // yourself" feature, not just any page that happens to load in
          // a browser that also has a valid admin cookie. /api/feedback
          // is the same public endpoint the regular addon's Settings page
          // posts to -- without this flag, isAdmin there was based on
          // cookie presence alone, so testing the public feedback UI
          // (e.g. under a different Creator Profile/persona) in the same
          // browser as an active admin session got every message
          // mislabeled as sent by "Developer" instead of that persona.
          body: JSON.stringify({ category: category, message: message, creatorName: 'admin', fromAdminPanel: true }),
        });
        const data = await res.json().catch(() => null);
        if (!data || !data.ok) {
          feedbackEntries = feedbackEntries.filter((f) => f.id !== tempId);
          renderFeedbackList();
          messageBox.value = message;
          status.textContent = (data && data.error) || 'Could not save -- try again.';
          btn.disabled = false;
          return;
        }
        // Swap the temp id for the server's real one -- otherwise a Mark
        // Completed click on this card would send an id the server has
        // never heard of.
        if (data.entry && data.entry.id) {
          const idx = feedbackEntries.findIndex((f) => f.id === tempId);
          if (idx !== -1) {
            feedbackEntries[idx] = data.entry;
            renderFeedbackList();
          }
        }
        status.textContent = 'Added.';
      } catch (e) {
        feedbackEntries = feedbackEntries.filter((f) => f.id !== tempId);
        renderFeedbackList();
        messageBox.value = message;
        status.textContent = 'Could not save -- check your connection.';
      }
      btn.disabled = false;
    }

    function closeAdminModal() {
      const existing = document.getElementById('activeAdminModalOverlay');
      if (existing) existing.remove();
    }

    function showAdminModal(innerHtml) {
      closeAdminModal();
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.id = 'activeAdminModalOverlay';
      overlay.innerHTML = '<div class="modal-card"><div class="modal-body">' + innerHtml + '</div></div>';
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeAdminModal();
      });
      document.body.appendChild(overlay);
    }

    function showAdminAlert(title, message, isSuccess = false) {
      const icon = isSuccess ? '\u2713' : '\u2715';
      const iconColor = isSuccess ? 'var(--success, #34C759)' : 'var(--danger, #FF3B30)';
      const html =
        '<div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px;">' +
          '<h3 style="margin:0; font-size:1.15rem; font-weight:700; display:flex; align-items:center; gap:8px; color:var(--text);">' +
            '<span style="color:' + iconColor + '; font-weight:bold; font-size:1.2rem;">' + icon + '</span> ' +
            escapeHtmlAdmin(title) +
          '</h3>' +
          '<button type="button" class="modal-close-x" onclick="closeAdminModal()">\u2715</button>' +
        '</div>' +
        '<p style="margin:0 0 18px; color:var(--muted); font-size:0.92rem; line-height:1.45; white-space:pre-wrap;">' + escapeHtmlAdmin(message) + '</p>' +
        '<div style="display:flex; justify-content:flex-end; gap:8px;">' +
          '<button type="button" class="lc-btn primary" onclick="closeAdminModal()" style="min-width:80px;">OK</button>' +
        '</div>';
      showAdminModal(html);
    }

    function showAdminConfirm(title, message, confirmBtnText, onConfirm, isDanger = true) {
      const icon = isDanger ? '\u26A0' : '?';
      const iconColor = isDanger ? 'var(--danger, #FF3B30)' : 'var(--accent, #007AFF)';
      const btnClass = isDanger ? 'lc-btn danger' : 'lc-btn primary';
      const html =
        '<div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px;">' +
          '<h3 style="margin:0; font-size:1.15rem; font-weight:700; display:flex; align-items:center; gap:8px; color:var(--text);">' +
            '<span style="color:' + iconColor + '; font-weight:bold; font-size:1.2rem;">' + icon + '</span> ' +
            escapeHtmlAdmin(title) +
          '</h3>' +
          '<button type="button" class="modal-close-x" onclick="closeAdminModal()">\u2715</button>' +
        '</div>' +
        '<p style="margin:0 0 18px; color:var(--muted); font-size:0.92rem; line-height:1.45; white-space:pre-wrap;">' + escapeHtmlAdmin(message) + '</p>' +
        '<div style="display:flex; justify-content:flex-end; gap:10px;">' +
          '<button type="button" class="lc-btn secondary" onclick="closeAdminModal()">Cancel</button>' +
          '<button type="button" class="' + btnClass + '" id="adminConfirmOkBtn">' + escapeHtmlAdmin(confirmBtnText || 'Confirm') + '</button>' +
        '</div>';
      showAdminModal(html);
      document.getElementById('adminConfirmOkBtn')?.addEventListener('click', () => {
        closeAdminModal();
        if (typeof onConfirm === 'function') onConfirm();
      });
    }

    // Optimistic: flips the entry's completed flag (and re-renders,
    // moving the card between the Open/Completed groups) the instant
    // it's clicked, then sends the real change to the server in the
    // background. Rolled back to whatever the server still actually has
    // if that background call fails.
    async function toggleFeedbackStatus(id, completed) {
      const idx = feedbackEntries.findIndex((f) => f.id === id);
      if (idx === -1) return;
      const previousCompleted = feedbackEntries[idx].completed;
      feedbackEntries[idx] = Object.assign({}, feedbackEntries[idx], { completed: completed });
      renderFeedbackList();
      try {
        const res = await fetch('/admin/api/feedback/status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: id, completed: completed }),
        });
        const data = await res.json().catch(() => null);
        if (!data || !data.ok) {
          const stillIdx = feedbackEntries.findIndex((f) => f.id === id);
          if (stillIdx !== -1) {
            feedbackEntries[stillIdx] = Object.assign({}, feedbackEntries[stillIdx], { completed: previousCompleted });
            renderFeedbackList();
          }
          const err = (data && data.error) || 'Could not update -- try again.';
          showAdminAlert(err === 'Not authorized.' ? 'Not Authorized' : 'Update Failed', err, false);
          return;
        }
      } catch (e) {
        const stillIdx = feedbackEntries.findIndex((f) => f.id === id);
        if (stillIdx !== -1) {
          feedbackEntries[stillIdx] = Object.assign({}, feedbackEntries[stillIdx], { completed: previousCompleted });
          renderFeedbackList();
        }
        showAdminAlert('Connection Error', 'Could not update -- check your connection.', false);
      }
    }

    function openEditFeedbackModal(id) {
      const entry = feedbackEntries.find((f) => f.id === id);
      if (!entry) return;
      document.getElementById('editFeedbackId').value = entry.id;
      document.getElementById('editFeedbackCategory').value = entry.category || 'other';
      document.getElementById('editFeedbackMessage').value = entry.message || '';
      document.getElementById('editFeedbackSaveBtn').disabled = false;
      document.getElementById('editFeedbackSaveBtn').textContent = 'Save Changes';
      document.getElementById('editFeedbackModal').style.display = 'flex';
    }

    function closeEditFeedbackModal() {
      document.getElementById('editFeedbackModal').style.display = 'none';
    }

    async function saveEditFeedback() {
      const id = document.getElementById('editFeedbackId').value;
      const category = document.getElementById('editFeedbackCategory').value;
      const message = document.getElementById('editFeedbackMessage').value.trim();
      const saveBtn = document.getElementById('editFeedbackSaveBtn');
      if (!message) {
        showAdminAlert('Missing Message', 'Please enter a message.', false);
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving\u2026';
      try {
        const res = await fetch('/admin/api/feedback/edit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, category, message }),
        });
        const data = await res.json().catch(() => null);
        if (!data || !data.ok) {
          const err = (data && data.error) || 'Could not save feedback edits.';
          showAdminAlert(err === 'Not authorized.' ? 'Not Authorized' : 'Save Error', err, false);
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save Changes';
          return;
        }
        const idx = feedbackEntries.findIndex((f) => f.id === id);
        if (idx !== -1 && data.entry) {
          feedbackEntries[idx] = data.entry;
          renderFeedbackList();
        }
        closeEditFeedbackModal();
      } catch (err) {
        showAdminAlert('Network Error', 'Network error while saving feedback edits.', false);
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Changes';
      }
    }

    async function copyFeedbackMessage(btn, id) {
      const entry = feedbackEntries.find((f) => f.id === id);
      let text = '';
      if (entry) {
        if (Array.isArray(entry.messages) && entry.messages.length) {
          text = entry.messages.map((m) => m.text).join('\\n\\n');
        } else {
          text = entry.message || '';
        }
      }
      try {
        await navigator.clipboard.writeText(text);
        const prevText = btn.innerHTML;
        btn.innerHTML = '&#x2713; Copied!';
        btn.style.color = '#34C759';
        setTimeout(() => {
          btn.innerHTML = prevText;
          btn.style.color = '';
        }, 1800);
      } catch (e) {
        showAdminAlert('Copy Failed', 'Could not copy message to clipboard.', false);
      }
    }

    async function deleteFeedbackEntry(id) {
      showAdminConfirm('Delete Feedback', 'Permanently delete this feedback entry?', 'Delete', async () => {
        const idx = feedbackEntries.findIndex((f) => f.id === id);
        if (idx === -1) return;
        const removedEntry = feedbackEntries[idx];
        feedbackEntries.splice(idx, 1);
        renderFeedbackList();

        try {
          const res = await fetch('/admin/api/feedback/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: id }),
          });
          const data = await res.json().catch(() => null);
          if (!data || !data.ok) {
            feedbackEntries.splice(idx, 0, removedEntry);
            renderFeedbackList();
            const err = (data && data.error) || 'Could not delete feedback entry.';
            showAdminAlert(err === 'Not authorized.' ? 'Not Authorized' : 'Delete Failed', err, false);
          }
        } catch (err) {
          feedbackEntries.splice(idx, 0, removedEntry);
          renderFeedbackList();
          showAdminAlert('Network Error', 'Network error while deleting feedback entry.', false);
        }
      }, true);
    }
  </script>
</body></html>`;
}

// generateShortId() always produces a 12-character id; legacy base64
// configs are virtually always much longer than that (even a single list's
// JSON encodes to well over 100 characters), so length alone reliably
// tells the two apart without needing a prefix.

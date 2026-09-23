import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Same extraction trick as helpers-unit.test.mjs: these live as concatenation
// fragments rather than exports, so the functions under test are sliced out of
// their source file and evaluated with the constants they close over.
function loadNewOnStreamingHelpers() {
  const src00 = readFileSync(new URL("../00_constants.js", import.meta.url), "utf8");
  const src07 = readFileSync(new URL("../07_source-fetchers-tmdb-simkl.js", import.meta.url), "utf8");

  const names = [
    "newOnStreamingProvider",
    "parseNewOnStreamingServices",
    "newOnStreamingRegion",
    "newOnStreamingDateToEpoch",
    "newOnStreamingTickBudget",
  ];
  const chunks = [];
  for (const name of names) {
    const start = src07.indexOf(`function ${name}`);
    if (start < 0) throw new Error(`missing ${name}`);
    let i = src07.indexOf("{", start);
    let depth = 0;
    for (; i < src07.length; i++) {
      if (src07[i] === "{") depth++;
      else if (src07[i] === "}") {
        depth--;
        if (depth === 0) { i++; break; }
      }
    }
    chunks.push(src07.slice(start, i));
  }

  const consts = [];
  for (const name of [
    "NEW_ON_STREAMING_PROVIDERS",
    "NEW_ON_STREAMING_REGIONS",
    "RAPIDAPI_MONTHLY_SAFETY_CAP",
    "NEW_ON_STREAMING_SWEEP_INTERVAL_SECONDS",
    "NEW_ON_STREAMING_MIN_PAGES_PER_TICK",
    "NEW_ON_STREAMING_MAX_PAGES_PER_TICK",
  ]) {
    const m = src00.match(new RegExp(`const ${name}[\\s\\S]*?;`));
    if (!m) throw new Error(`missing const ${name}`);
    consts.push(m[0]);
  }

  const fn = new Function(`${consts.join("\n")}\n${chunks.join("\n")}\nreturn { ${names.join(", ")}, NEW_ON_STREAMING_PROVIDERS };`);
  return fn();
}

const H = loadNewOnStreamingHelpers();

describe("parseNewOnStreamingServices", () => {
  it("treats an empty selection as every service", () => {
    assert.equal(H.parseNewOnStreamingServices(""), null);
    assert.equal(H.parseNewOnStreamingServices(null), null);
  });

  it("resolves a +-separated selection, case-insensitively", () => {
    assert.deepEqual(H.parseNewOnStreamingServices("netflix+hulu"), ["netflix", "hulu"]);
    assert.deepEqual(H.parseNewOnStreamingServices("NETFLIX"), ["netflix"]);
    assert.deepEqual(H.parseNewOnStreamingServices("netflix,hulu"), ["netflix", "hulu"]);
  });

  it("de-duplicates a repeated service", () => {
    assert.deepEqual(H.parseNewOnStreamingServices("hulu+hulu"), ["hulu"]);
  });

  // A saved row naming a service that has since been dropped from
  // NEW_ON_STREAMING_PROVIDERS must degrade to the everything row rather than
  // building an SQL IN () with nothing in it.
  it("falls back to every service when nothing in the selection is known", () => {
    assert.equal(H.parseNewOnStreamingServices("bogus"), null);
    assert.deepEqual(H.parseNewOnStreamingServices("bogus+netflix"), ["netflix"]);
  });

  it("resolves RapidAPI provider aliases and subscription variants like prime.subscription, apple.subscription", () => {
    assert.deepEqual(H.parseNewOnStreamingServices("prime+hbo+apple"), ["primevideo", "hbomax", "appletv"]);
    assert.deepEqual(H.parseNewOnStreamingServices("prime.subscription+apple.subscription+max.subscription"), ["primevideo", "appletv", "hbomax"]);
    assert.deepEqual(H.parseNewOnStreamingServices("rapidapi:new-on-streaming:netflix+prime.subscription"), ["netflix", "primevideo"]);
    assert.deepEqual(H.parseNewOnStreamingServices("tmdb:new-on-streaming:disney.subscription+hulu.subscription"), ["disney", "hulu"]);
    assert.equal(H.newOnStreamingProvider("prime.subscription")?.key, "primevideo");
    assert.equal(H.newOnStreamingProvider("apple.subscription")?.key, "appletv");
    assert.equal(H.newOnStreamingProvider("hbo.subscription")?.key, "hbomax");
    assert.equal(H.newOnStreamingProvider("paramount.subscription")?.key, "paramount");
    assert.equal(H.newOnStreamingProvider("peacock.subscription")?.key, "peacock");
  });
});

describe("newOnStreamingDateToEpoch", () => {
  const now = Math.floor(Date.UTC(2026, 0, 15) / 1000);

  it("reads a YYYY-MM-DD date as UTC midnight", () => {
    assert.equal(H.newOnStreamingDateToEpoch("2024-03-08", now), Math.floor(Date.UTC(2024, 2, 8) / 1000));
  });

  it("returns 0 for anything it cannot parse, rather than today", () => {
    assert.equal(H.newOnStreamingDateToEpoch("", now), 0);
    assert.equal(H.newOnStreamingDateToEpoch("soon", now), 0);
    assert.equal(H.newOnStreamingDateToEpoch(null, now), 0);
  });

  it("clamps a future date to now", () => {
    assert.equal(H.newOnStreamingDateToEpoch("2030-01-01", now), now);
  });
});

describe("newOnStreamingTickBudget", () => {
  // 2026-09-01 00:00 UTC: 30 days = 120 six-hour ticks left in the month.
  const monthStart = Math.floor(Date.UTC(2026, 8, 1) / 1000);

  it("spreads what is left of the month's cap over the ticks left", () => {
    assert.equal(H.newOnStreamingTickBudget(0, monthStart), Math.floor(950 / 120));
    // Half the cap already gone halfway through: same even share.
    assert.equal(H.newOnStreamingTickBudget(475, monthStart + 15 * 86400), Math.floor(475 / 60));
  });

  it("lets a quiet month catch up, but never past the per-tick ceiling", () => {
    // One day left, nothing spent: 950 / 4 would be 237 -- clamped.
    assert.equal(H.newOnStreamingTickBudget(0, monthStart + 29 * 86400), 16);
  });

  it("keeps a floor for polling, and never spends past the cap", () => {
    assert.equal(H.newOnStreamingTickBudget(900, monthStart), 4);
    assert.equal(H.newOnStreamingTickBudget(948, monthStart), 2);
    assert.equal(H.newOnStreamingTickBudget(950, monthStart), 0);
  });
});

describe("newOnStreamingRegion", () => {
  it("keeps a swept region and falls back to the first one otherwise", () => {
    assert.equal(H.newOnStreamingRegion("US"), "US");
    assert.equal(H.newOnStreamingRegion("us"), "US");
    assert.equal(H.newOnStreamingRegion("DE"), "US");
    assert.equal(H.newOnStreamingRegion(""), "US");
  });
});

// --- The catalog itself, through the real Worker and a real SQLite database --
//
// The helper tests above cover the sweep's inputs. These cover the only thing
// a user ever sees: the order the shelf comes back in, and that it comes back
// without touching the network at all.

const { makeEnv, makeD1, call } = await import("./harness.mjs");

function seedStreamingEvent(db, row) {
  db._db.prepare(
    `INSERT INTO streaming_events
       (region, service, imdb_id, tmdb_id, kind, added_at, last_event_at, event_kind,
        seeded, last_seen_walk, name, poster, background, year)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, NULL, ?)`
  ).run(
    row.region || "US",
    row.service,
    row.imdbId,
    row.tmdbId || null,
    row.kind || "movie",
    row.at,
    row.at,
    row.eventKind || "added",
    row.name || row.imdbId,
    row.poster || "https://image.tmdb.org/t/p/w500/x.jpg",
    row.year || "2024"
  );
}

async function previewNewOnStreaming(env, url, type = "movie") {
  return call(env, "/api/preview", {
    method: "POST",
    json: { url, type, sample: 50 },
  });
}

describe("New on Streaming catalog", () => {
  it("returns titles newest arrival first, whatever order they were written in", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db });
    seedStreamingEvent(db, { service: "netflix", imdbId: "tt0000001", at: 1000, name: "Oldest" });
    seedStreamingEvent(db, { service: "netflix", imdbId: "tt0000003", at: 3000, name: "Newest" });
    seedStreamingEvent(db, { service: "netflix", imdbId: "tt0000002", at: 2000, name: "Middle" });

    const res = await previewNewOnStreaming(env, "tmdb:new-on-streaming");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true, res.body.error);
    assert.deepEqual(res.body.sample.map((m) => m.name), ["Newest", "Middle", "Oldest"]);
    assert.equal(res.body.totalItems, 3);
  });

  // A show that has been on a service for years is new again the day an
  // episode drops -- that is the behaviour the whole event_kind column exists
  // for, and the reason the shelf sorts on last_event_at rather than added_at.
  it("puts a show back on top when a newer episode event is recorded", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db });
    seedStreamingEvent(db, { service: "hulu", imdbId: "tt2000001", at: 5000, kind: "series", name: "Just Added" });
    seedStreamingEvent(db, { service: "hulu", imdbId: "tt2000002", at: 100, kind: "series", name: "Old Show" });
    db._db.prepare(
      "UPDATE streaming_events SET last_event_at = ?, event_kind = 'episode', season = 4, episode = 2 WHERE imdb_id = ?"
    ).run(9000, "tt2000002");

    const res = await previewNewOnStreaming(env, "tmdb:new-on-streaming", "series");
    assert.equal(res.body.ok, true, res.body.error);
    assert.deepEqual(res.body.sample.map((m) => m.name), ["Old Show", "Just Added"]);
  });

  it("filters to one service, and keeps the movie and show sides apart", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db });
    seedStreamingEvent(db, { service: "netflix", imdbId: "tt3000001", at: 900, name: "On Netflix" });
    seedStreamingEvent(db, { service: "hulu", imdbId: "tt3000002", at: 800, name: "On Hulu" });
    seedStreamingEvent(db, { service: "hulu", imdbId: "tt3000003", at: 700, kind: "series", name: "Hulu Show" });

    const netflix = await previewNewOnStreaming(env, "tmdb:new-on-streaming:netflix");
    assert.deepEqual(netflix.body.sample.map((m) => m.name), ["On Netflix"]);

    const hulu = await previewNewOnStreaming(env, "tmdb:new-on-streaming:hulu");
    assert.deepEqual(hulu.body.sample.map((m) => m.name), ["On Hulu"]);

    const huluShows = await previewNewOnStreaming(env, "tmdb:new-on-streaming:hulu", "series");
    assert.deepEqual(huluShows.body.sample.map((m) => m.name), ["Hulu Show"]);
  });

  // A title on three services must not be three rows in the shelf, and the
  // date it sorts under is the most recent of the three arrivals -- landing on
  // a second service today IS news today.
  it("shows a title carried by several services once, dated by its latest arrival", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db });
    seedStreamingEvent(db, { service: "netflix", imdbId: "tt4000001", at: 1000, name: "Everywhere" });
    seedStreamingEvent(db, { service: "hulu", imdbId: "tt4000001", at: 7000, name: "Everywhere" });
    seedStreamingEvent(db, { service: "peacock", imdbId: "tt4000002", at: 4000, name: "Only Peacock" });

    const res = await previewNewOnStreaming(env, "tmdb:new-on-streaming");
    assert.deepEqual(res.body.sample.map((m) => m.name), ["Everywhere", "Only Peacock"]);
    assert.equal(res.body.totalItems, 2, "a title on two services is still one row");
  });

  it("hides a title once the sweep has marked it removed", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db });
    seedStreamingEvent(db, { service: "netflix", imdbId: "tt5000001", at: 1000, name: "Still Here" });
    seedStreamingEvent(db, { service: "netflix", imdbId: "tt5000002", at: 2000, name: "Gone" });
    db._db.prepare("UPDATE streaming_events SET removed_at = 3000 WHERE imdb_id = ?").run("tt5000002");

    const res = await previewNewOnStreaming(env, "tmdb:new-on-streaming");
    assert.deepEqual(res.body.sample.map((m) => m.name), ["Still Here"]);
  });

  // The one property that makes this catalog different from every other row in
  // the add-on: serving it is a database read, so a provider outage or a
  // missing API key cannot slow it down or empty it.
  it("serves without making a single outbound request", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db });
    seedStreamingEvent(db, { service: "netflix", imdbId: "tt6000001", at: 1000, name: "Cached Nowhere" });

    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (...args) => {
      calls++;
      return realFetch(...args);
    };
    try {
      const res = await previewNewOnStreaming(env, "tmdb:new-on-streaming");
      assert.equal(res.body.ok, true, res.body.error);
      assert.equal(res.body.sample.length, 1);
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(calls, 0, "the New on Streaming shelf must not call a provider to render");
  });

  it("says what to do when the database is not bound at all", async () => {
    const env = makeEnv({});
    const res = await previewNewOnStreaming(env, "tmdb:new-on-streaming");
    assert.equal(res.body.ok, false);
  });

  it("returns both movies and shows interleaved chronologically with service metadata when previewed with type=all", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db });
    seedStreamingEvent(db, { service: "netflix", imdbId: "tt100", kind: "movie", at: 1000, name: "Movie Old" });
    seedStreamingEvent(db, { service: "hulu", imdbId: "tt200", kind: "series", at: 3000, name: "Show Newest" });
    seedStreamingEvent(db, { service: "primevideo", imdbId: "tt300", kind: "movie", at: 2000, name: "Movie Middle" });

    const cookie = await adminCookie(env);
    const res = await call(env, "/admin/api/new-on-streaming/preview?type=all", {
      headers: { cookie },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.deepEqual(res.body.items.map((m) => m.name), ["Show Newest", "Movie Middle", "Movie Old"]);
    assert.equal(res.body.items[0].type, "series");
    assert.equal(res.body.items[0].service, "hulu");
    assert.deepEqual(res.body.items[0].services, ["hulu"]);
    assert.equal(res.body.items[0].addedAt, 3000);
    assert.equal(res.body.items[1].type, "movie");
    assert.equal(res.body.items[1].service, "primevideo");
  });
});

// --- The sweep itself, driven against RapidAPI Streaming Availability API ----

async function adminCookie(env) {
  const r = await call(env, "/admin/login", { method: "POST", form: { key: env.ADMIN_KEY } });
  const m = (r.headers.get("set-cookie") || "").match(/^([^=]+=[^;]+)/);
  return m ? m[1] : "";
}

async function sweep(env, cookie, units = 64, options = {}) {
  const r = await call(env, "/admin/api/new-on-streaming/sweep", {
    method: "POST", cookie, json: { units, bump: false, ...options },
  });
  assert.equal(r.body.ok, true, r.body.error);
  return r.body.sweep;
}

function liveTitles(db) {
  return db.q("SELECT imdb_id, name, seeded, last_event_at, removed_at FROM streaming_events WHERE removed_at IS NULL ORDER BY imdb_id");
}

// --- RapidAPI Streaming Availability API Integration Tests ------------------

function stubRapidApi(handler) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("streaming-availability.p.rapidapi.com")) {
      calls.push({ url: u, opts });
      const resData = typeof handler === "function" ? handler(u, opts) : handler;
      return new Response(JSON.stringify(resData), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(url, opts);
  };
  return { restore: () => { globalThis.fetch = realFetch; }, calls };
}

describe("RapidAPI Streaming Availability sweep", () => {
  it("pulls newest movies and shows with exact arrival dates, newest first", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db, RAPIDAPI_KEY: "test-rapidapi-key", NEW_ON_STREAMING_ENGINE: "rapidapi" });
    const now = Math.floor(Date.now() / 1000);

    const net = stubRapidApi((url) => {
      if (url.includes("change_type=new") && url.includes("item_type=show")) {
        return {
          changes: [
            { changeType: "new", itemType: "show", showId: "movie_1", timestamp: now - 100, service: { id: "netflix" } },
            { changeType: "new", itemType: "show", showId: "movie_2", timestamp: now - 200, service: { id: "prime" } },
            { changeType: "new", itemType: "show", showId: "movie_3", timestamp: now - 50, service: { id: "disney" } },
          ],
          shows: {
            movie_1: { id: "movie_1", imdbId: "tt9000001", title: "Middle Arrival", showType: "movie", releaseYear: 2020 },
            movie_2: { id: "movie_2", imdbId: "tt9000002", title: "Oldest Arrival", showType: "movie", releaseYear: 2024 },
            movie_3: { id: "movie_3", imdbId: "tt9000003", title: "Newest Arrival", showType: "movie", releaseYear: 2015 },
          },
          hasMore: false,
        };
      }
      return { changes: [], shows: {}, hasMore: false };
    });

    try {
      const cookie = await adminCookie(env);
      const sweepRes = await sweep(env, cookie);
      assert.equal(sweepRes.ran, true);
      assert.equal(sweepRes.source, "rapidapi");
      assert.equal(sweepRes.added, 3);

      const preview = await previewNewOnStreaming(env, "tmdb:new-on-streaming");
      assert.equal(preview.status, 200);
      assert.equal(preview.body.ok, true);
      // Order must be by arrival timestamp (not releaseYear): movie_3 (now - 50), movie_1 (now - 100), movie_2 (now - 200)
      assert.deepEqual(preview.body.sample.map((m) => m.name), [
        "Newest Arrival",
        "Middle Arrival",
        "Oldest Arrival",
      ]);
    } finally {
      net.restore();
    }
  });

  it("pushes a show back to first in the list when a new episode is added", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db, RAPIDAPI_KEY: "test-rapidapi-key", NEW_ON_STREAMING_ENGINE: "rapidapi" });
    const now = Math.floor(Date.now() / 1000);

    const net = stubRapidApi((url) => {
      if (url.includes("item_type=show")) {
        return {
          changes: [
            { changeType: "new", itemType: "show", showId: "show_recent", timestamp: now - 100, service: { id: "netflix" } },
            { changeType: "new", itemType: "show", showId: "show_older", timestamp: now - 500, service: { id: "hulu" } },
          ],
          shows: {
            show_recent: { id: "show_recent", imdbId: "tt8000001", title: "Just Added Show", showType: "series", releaseYear: 2024 },
            show_older: { id: "show_older", imdbId: "tt8000002", title: "Classic Show", showType: "series", releaseYear: 2010 },
          },
          hasMore: false,
        };
      }
      if (url.includes("item_type=episode")) {
        return {
          changes: [
            // Classic Show drops a brand new episode right now (now - 10), which is newer than Just Added Show
            { changeType: "new", itemType: "episode", showId: "show_older", season: 5, episode: 12, timestamp: now - 10, service: { id: "hulu" } },
          ],
          shows: {
            show_older: { id: "show_older", imdbId: "tt8000002", title: "Classic Show", showType: "series", releaseYear: 2010 },
          },
          hasMore: false,
        };
      }
      return { changes: [], shows: {}, hasMore: false };
    });

    try {
      const cookie = await adminCookie(env);
      const sweepRes = await sweep(env, cookie);
      assert.equal(sweepRes.ran, true);
      assert.equal(sweepRes.bumped, 1);

      const preview = await previewNewOnStreaming(env, "tmdb:new-on-streaming", "series");
      assert.equal(preview.body.ok, true);
      // Classic Show was originally added at now - 500, but the new episode at now - 10 pushed it to index 0!
      assert.deepEqual(preview.body.sample.map((m) => m.name), [
        "Classic Show",
        "Just Added Show",
      ]);
    } finally {
      net.restore();
    }
  });

  it("marks a title removed when RapidAPI reports a removal change", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db, RAPIDAPI_KEY: "test-rapidapi-key", NEW_ON_STREAMING_ENGINE: "rapidapi" });
    const now = Math.floor(Date.now() / 1000);

    let reportRemoval = false;
    const net = stubRapidApi((url) => {
      if (url.includes("change_type=removed") && reportRemoval) {
        return {
          changes: [
            { changeType: "removed", itemType: "show", showId: "movie_leaving", timestamp: now, service: { id: "netflix" } },
          ],
          shows: {
            movie_leaving: { id: "movie_leaving", imdbId: "tt7000001", title: "Leaving Today", showType: "movie" },
          },
          hasMore: false,
        };
      }
      if (url.includes("item_type=show")) {
        return {
          changes: [
            { changeType: "new", itemType: "show", showId: "movie_staying", timestamp: now - 50, service: { id: "netflix" } },
            { changeType: "new", itemType: "show", showId: "movie_leaving", timestamp: now - 100, service: { id: "netflix" } },
          ],
          shows: {
            movie_staying: { id: "movie_staying", imdbId: "tt7000002", title: "Staying", showType: "movie" },
            movie_leaving: { id: "movie_leaving", imdbId: "tt7000001", title: "Leaving Today", showType: "movie" },
          },
          hasMore: false,
        };
      }
      return { changes: [], shows: {}, hasMore: false };
    });

    try {
      const cookie = await adminCookie(env);
      await sweep(env, cookie);

      const before = await previewNewOnStreaming(env, "tmdb:new-on-streaming");
      assert.deepEqual(before.body.sample.map((m) => m.name), ["Staying", "Leaving Today"]);

      // Now report removal
      reportRemoval = true;
      await sweep(env, cookie);

      const after = await previewNewOnStreaming(env, "tmdb:new-on-streaming");
      assert.deepEqual(after.body.sample.map((m) => m.name), ["Staying"]);

      // The next sweep re-reads the arrival (streams overlap where they
      // resume). A "new" change older than the removal must not bring the
      // title back.
      reportRemoval = false;
      await sweep(env, cookie);
      const later = await previewNewOnStreaming(env, "tmdb:new-on-streaming");
      assert.deepEqual(later.body.sample.map((m) => m.name), ["Staying"]);
    } finally {
      net.restore();
    }
  });

  it("prunes items older than 30 days during the sweep", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db, RAPIDAPI_KEY: "test-rapidapi-key", NEW_ON_STREAMING_ENGINE: "rapidapi" });
    const now = Math.floor(Date.now() / 1000);

    // Seed an event older than 30 days (35 days old) and one within 30 days (5 days old)
    seedStreamingEvent(db, { service: "netflix", imdbId: "tt6000001", at: now - 35 * 86400, name: "Too Old" });
    seedStreamingEvent(db, { service: "netflix", imdbId: "tt6000002", at: now - 5 * 86400, name: "Recent" });

    const net = stubRapidApi(() => ({ changes: [], shows: {}, hasMore: false }));
    try {
      const cookie = await adminCookie(env);
      await sweep(env, cookie);

      const rows = liveTitles(db);
      assert.equal(rows.some((r) => r.name === "Too Old"), false, "items older than 30 days must be pruned");
      assert.equal(rows.some((r) => r.name === "Recent"), true, "recent items must remain");
    } finally {
      net.restore();
    }
  });

  it("halts sweep when monthly usage reaches the 950 safety cap", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db, RAPIDAPI_KEY: "test-rapidapi-key", NEW_ON_STREAMING_ENGINE: "rapidapi" });
    const currentMonth = new Date().toISOString().slice(0, 7);
    await env.CONFIGS.put(
      "cron:rapidapi:usage",
      JSON.stringify({ month: currentMonth, count: 950, lastAt: Math.floor(Date.now() / 1000) })
    );

    const net = stubRapidApi(() => ({ changes: [], shows: {}, hasMore: false }));
    try {
      const cookie = await adminCookie(env);
      const sweepRes = await sweep(env, cookie);
      assert.equal(sweepRes.ran, false);
      assert.match(sweepRes.reason, /RapidAPI monthly limit reached/);
      assert.equal(net.calls.length, 0, "must not make outbound requests when capped");
    } finally {
      net.restore();
    }
  });

  it("skips automated sweep when within 4-hour interval cooldown, and runs when manual: true", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db, RAPIDAPI_KEY: "test-rapidapi-key", NEW_ON_STREAMING_ENGINE: "rapidapi" });
    const now = Math.floor(Date.now() / 1000);
    // Pretend a sweep ran 30 minutes ago (1800s ago)
    await env.CONFIGS.put(
      "cron:newonstreaming:lastsweep",
      JSON.stringify({ at: now - 1800, ran: true })
    );

    const net = stubRapidApi(() => ({ changes: [], shows: {}, hasMore: false }));
    try {
      const cookie = await adminCookie(env);

      // Automated run (manual: false) within 4 hours: must skip
      const automatedRes = await sweep(env, cookie, 3, { manual: false });
      assert.equal(automatedRes.ran, false);
      assert.match(automatedRes.reason, /Interval cooldown/);
      assert.equal(net.calls.length, 0);

      // Manual run (manual: true, default in admin sweep): must proceed
      const manualRes = await sweep(env, cookie, 3, { manual: true });
      assert.equal(manualRes.ran, true);
      assert.ok(net.calls.length > 0);
    } finally {
      net.restore();
    }
  });

  it("fails with clear error and does not fall back to TMDB when RAPIDAPI_KEY is missing", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db, RAPIDAPI_KEY: "", NEW_ON_STREAMING_ENGINE: "rapidapi" });
    const cookie = await adminCookie(env);
    const sweepRes = await sweep(env, cookie);
    assert.equal(sweepRes.ran, false);
    assert.match(sweepRes.reason, /RAPIDAPI_KEY is not set/);
  });

  it("increments monthly request count in KV on each RapidAPI page fetched", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db, RAPIDAPI_KEY: "test-rapidapi-key", NEW_ON_STREAMING_ENGINE: "rapidapi" });
    const currentMonth = new Date().toISOString().slice(0, 7);

    const net = stubRapidApi(() => ({
      changes: [],
      shows: {},
      hasMore: false,
    }));

    try {
      const cookie = await adminCookie(env);
      await sweep(env, cookie);

      const usageRaw = await env.CONFIGS.get("cron:rapidapi:usage");
      assert.ok(usageRaw, "usage must be recorded in KV");
      const usage = JSON.parse(usageRaw);
      assert.equal(usage.month, currentMonth);
      assert.ok(usage.count >= 1, "count must be incremented");
      assert.ok(usage.lastAt > 0);
    } finally {
      net.restore();
    }
  });

  it("clears existing items and pulls fresh data from RapidAPI when reset: true", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db, RAPIDAPI_KEY: "test-rapidapi-key", NEW_ON_STREAMING_ENGINE: "rapidapi" });
    const now = Math.floor(Date.now() / 1000);

    // Seed existing old items into DB
    seedStreamingEvent(db, { service: "netflix", imdbId: "tt9999001", at: now - 500, name: "Old Junk 1" });
    seedStreamingEvent(db, { service: "netflix", imdbId: "tt9999002", at: now - 600, name: "Old Junk 2" });
    assert.equal(liveTitles(db).length, 2);

    const net = stubRapidApi((url) => {
      if (url.includes("item_type=show")) {
        return {
          changes: [
            { changeType: "new", itemType: "show", showId: "new_1", timestamp: now - 50, service: { id: "netflix" } },
          ],
          shows: {
            new_1: { id: "new_1", imdbId: "tt1111111", title: "Brand New Fresh Title", showType: "movie", releaseYear: 2026 },
          },
          hasMore: false,
        };
      }
      return { changes: [], shows: {}, hasMore: false };
    });

    try {
      const cookie = await adminCookie(env);
      const sweepRes = await sweep(env, cookie, 3, { reset: true, full: true });
      assert.equal(sweepRes.ran, true);
      assert.equal(sweepRes.cleared, true);

      const titles = liveTitles(db);
      assert.equal(titles.length, 1);
      assert.equal(titles[0].name, "Brand New Fresh Title");
      assert.equal(titles.some((t) => t.name.startsWith("Old Junk")), false, "old items must have been removed");
    } finally {
      net.restore();
    }
  });

  it("normalizes prime.subscription and apple.subscription and serves them under primevideo and appletv", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db, RAPIDAPI_KEY: "test-rapidapi-key", NEW_ON_STREAMING_ENGINE: "rapidapi" });
    const now = Math.floor(Date.now() / 1000);

    const net = stubRapidApi((url) => {
      if (url.includes("item_type=show")) {
        return {
          changes: [
            { changeType: "new", itemType: "show", showId: "show_prime", timestamp: now - 100, service: { id: "prime.subscription" } },
            { changeType: "new", itemType: "show", showId: "show_apple", timestamp: now - 200, service: { id: "apple.subscription" } },
          ],
          shows: {
            show_prime: { id: "show_prime", imdbId: "tt9100001", title: "Prime Exclusive", showType: "movie" },
            show_apple: { id: "show_apple", imdbId: "tt9100002", title: "Apple TV Plus Original", showType: "movie" },
          },
          hasMore: false,
        };
      }
      return { changes: [], shows: {}, hasMore: false };
    });

    try {
      const cookie = await adminCookie(env);
      await sweep(env, cookie, 3, { reset: true });

      // Must be queryable by primevideo and appletv provider keys
      const primePreview = await previewNewOnStreaming(env, "tmdb:new-on-streaming:primevideo");
      assert.equal(primePreview.body.ok, true);
      assert.deepEqual(primePreview.body.sample.map((m) => m.name), ["Prime Exclusive"]);

      const applePreview = await previewNewOnStreaming(env, "tmdb:new-on-streaming:appletv");
      assert.equal(applePreview.body.ok, true);
      assert.deepEqual(applePreview.body.sample.map((m) => m.name), ["Apple TV Plus Original"]);

      // And present in overall New on Streaming
      const allPreview = await previewNewOnStreaming(env, "tmdb:new-on-streaming");
      assert.equal(allPreview.body.ok, true);
      assert.deepEqual(allPreview.body.sample.map((m) => m.name), ["Prime Exclusive", "Apple TV Plus Original"]);
    } finally {
      net.restore();
    }
  });

  it("pushes a show back to first in the list when a new season drop is added", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db, RAPIDAPI_KEY: "test-rapidapi-key", NEW_ON_STREAMING_ENGINE: "rapidapi" });
    const now = Math.floor(Date.now() / 1000);

    const net = stubRapidApi((url) => {
      if (url.includes("item_type=show")) {
        return {
          changes: [
            { changeType: "new", itemType: "show", showId: "show_new", timestamp: now - 50, service: { id: "netflix" } },
            { changeType: "new", itemType: "show", showId: "show_older", timestamp: now - 300, service: { id: "netflix" } },
          ],
          shows: {
            show_new: { id: "show_new", imdbId: "tt9200001", title: "Brand New Show", showType: "series" },
            show_older: { id: "show_older", imdbId: "tt9200002", title: "Existing Show", showType: "series" },
          },
          hasMore: false,
        };
      }
      if (url.includes("item_type=season")) {
        return {
          changes: [
            // Existing Show gets Season 2 dropped at now - 10, pushing it above Brand New Show
            { changeType: "new", itemType: "season", showId: "show_older", season: 2, timestamp: now - 10, service: { id: "netflix" } },
          ],
          shows: {
            show_older: { id: "show_older", imdbId: "tt9200002", title: "Existing Show", showType: "series" },
          },
          hasMore: false,
        };
      }
      return { changes: [], shows: {}, hasMore: false };
    });

    try {
      const cookie = await adminCookie(env);
      const sweepRes = await sweep(env, cookie);
      assert.equal(sweepRes.ran, true);
      assert.equal(sweepRes.bumped, 1);

      const preview = await previewNewOnStreaming(env, "tmdb:new-on-streaming", "series");
      assert.equal(preview.body.ok, true);
      assert.deepEqual(preview.body.sample.map((m) => m.name), [
        "Existing Show",
        "Brand New Show",
      ]);
    } finally {
      net.restore();
    }
  });

  it("allocates page budget across show, season, and episode without starvation", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db, RAPIDAPI_KEY: "test-rapidapi-key", NEW_ON_STREAMING_ENGINE: "rapidapi" });

    const queriedTypes = [];
    const net = stubRapidApi((url) => {
      const u = new URL(url);
      const itemType = u.searchParams.get("item_type");
      queriedTypes.push(itemType);
      return { changes: [], shows: {}, hasMore: false };
    });

    try {
      const cookie = await adminCookie(env);
      const sweepRes = await sweep(env, cookie, 3, { reset: false });
      assert.equal(sweepRes.ran, true);
      assert.ok(queriedTypes.includes("show"), "must query shows");
      assert.ok(queriedTypes.includes("season"), "must query seasons");
      assert.ok(queriedTypes.includes("episode"), "must query episodes");
    } finally {
      net.restore();
    }
  });

  // The bug behind most of the gap with mdblist: a regular sweep read each
  // type NEWEST-first with a fixed page count and then moved its window
  // forward, so on any day with more than a page of changes everything past
  // that page was never read. Streams are now read oldest-first and a busy one
  // continues from RapidAPI's cursor on the next sweep.
  it("reads a busy stream oldest-first and finishes it from its cursor on the next sweep", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db, RAPIDAPI_KEY: "test-rapidapi-key", NEW_ON_STREAMING_ENGINE: "rapidapi" });
    const now = Math.floor(Date.now() / 1000);

    const net = stubRapidApi((url) => {
      const u = new URL(url);
      if (u.searchParams.get("item_type") !== "show" || u.searchParams.get("change_type") !== "new") {
        return { changes: [], shows: {}, hasMore: false };
      }
      if (u.searchParams.get("cursor") === "page-2") {
        return {
          changes: [{ changeType: "new", itemType: "show", showId: "b", timestamp: now - 400, service: { id: "netflix" } }],
          shows: { b: { id: "b", imdbId: "tt9400002", title: "Second Page Arrival", showType: "movie" } },
          hasMore: false,
        };
      }
      return {
        changes: [{ changeType: "new", itemType: "show", showId: "a", timestamp: now - 500, service: { id: "netflix" } }],
        shows: { a: { id: "a", imdbId: "tt9400001", title: "First Page Arrival", showType: "movie" } },
        hasMore: true,
        nextCursor: "page-2",
      };
    });

    try {
      const cookie = await adminCookie(env);
      // 4 pages: one poll for each of the four streams, nothing left over.
      await sweep(env, cookie, 4);
      const first = net.calls.map((c) => new URL(c.url)).filter((u) => u.searchParams.get("item_type") === "show" && u.searchParams.get("change_type") === "new");
      assert.equal(first.length, 1);
      assert.equal(first[0].searchParams.get("order_direction"), "asc");
      assert.deepEqual(liveTitles(db).map((r) => r.name), ["First Page Arrival"]);

      net.calls.length = 0;
      await sweep(env, cookie, 4);
      const second = net.calls.map((c) => new URL(c.url)).filter((u) => u.searchParams.get("item_type") === "show" && u.searchParams.get("change_type") === "new");
      assert.equal(second[0].searchParams.get("cursor"), "page-2", "must continue the same query, not start a new window");
      assert.equal(second[0].searchParams.get("from"), first[0].searchParams.get("from"));
      assert.equal(second[0].searchParams.get("to"), first[0].searchParams.get("to"));
      assert.deepEqual(liveTitles(db).map((r) => r.name).sort(), ["First Page Arrival", "Second Page Arrival"]);
    } finally {
      net.restore();
    }
  });

  it("polls every stream once, then gives leftover pages to new titles before episodes", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db, RAPIDAPI_KEY: "test-rapidapi-key", NEW_ON_STREAMING_ENGINE: "rapidapi" });
    const counts = {};
    const net = stubRapidApi((url) => {
      const u = new URL(url);
      const key = u.searchParams.get("change_type") === "removed" ? "removed" : u.searchParams.get("item_type");
      counts[key] = (counts[key] || 0) + 1;
      // New titles and episodes both have far more than this sweep can read.
      const more = key === "show" || key === "episode";
      return { changes: [], shows: {}, hasMore: more, nextCursor: more ? `${key}-${counts[key]}` : undefined };
    });
    try {
      const cookie = await adminCookie(env);
      const res = await sweep(env, cookie, 7);
      assert.equal(res.ran, true);
      assert.deepEqual(counts, { show: 4, season: 1, episode: 1, removed: 1 });
      assert.ok(res.behind && res.behind.show >= 0 && res.behind.episode >= 0, "unfinished streams are reported");
    } finally {
      net.restore();
    }
  });

  it("asks RapidAPI only for subscription catalogs, never a whole store", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db, RAPIDAPI_KEY: "test-rapidapi-key", NEW_ON_STREAMING_ENGINE: "rapidapi" });
    const net = stubRapidApi(() => ({ changes: [], shows: {}, hasMore: false }));
    try {
      const cookie = await adminCookie(env);
      await sweep(env, cookie, 4);
      assert.ok(net.calls.length > 0);
      for (const c of net.calls) {
        const catalogs = new URL(c.url).searchParams.get("catalogs").split(",");
        assert.ok(catalogs.includes("prime.subscription") && catalogs.includes("apple.subscription"));
        assert.equal(catalogs.includes("prime"), false, "bare prime is Prime Video Channels and the Amazon store too");
        assert.equal(catalogs.includes("apple"), false, "bare apple is the iTunes Store");
      }
    } finally {
      net.restore();
    }
  });

  it("throttles the removals stream to once a day on automated sweeps", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db, RAPIDAPI_KEY: "test-rapidapi-key", NEW_ON_STREAMING_ENGINE: "rapidapi" });
    const now = Math.floor(Date.now() / 1000);
    const net = stubRapidApi(() => ({ changes: [], shows: {}, hasMore: false }));
    const removedCalls = () => net.calls.filter((c) => new URL(c.url).searchParams.get("change_type") === "removed").length;
    try {
      const cookie = await adminCookie(env);
      await env.CONFIGS.put("cron:newonstreaming:lastsweep", JSON.stringify({ at: now - 7 * 3600 }));
      await sweep(env, cookie, 8, { manual: false });
      assert.equal(removedCalls(), 1);

      await env.CONFIGS.put("cron:newonstreaming:lastsweep", JSON.stringify({ at: now - 7 * 3600 }));
      await sweep(env, cookie, 8, { manual: false });
      assert.equal(removedCalls(), 1, "removals were read under a day ago");
    } finally {
      net.restore();
    }
  });

  it("keeps a backfill (Clear & pull fresh data) show-heavy and newest-first", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db, RAPIDAPI_KEY: "test-rapidapi-key", NEW_ON_STREAMING_ENGINE: "rapidapi" });
    const counts = {};
    const directions = new Set();
    const net = stubRapidApi((url) => {
      const u = new URL(url);
      const itemType = u.searchParams.get("item_type");
      directions.add(u.searchParams.get("order_direction"));
      counts[itemType] = (counts[itemType] || 0) + 1;
      const more = counts[itemType] < 20;
      return { changes: [], shows: {}, hasMore: more, nextCursor: more ? `cursor-${counts[itemType]}` : undefined };
    });
    try {
      const cookie = await adminCookie(env);
      const backfill = await sweep(env, cookie, 10, { reset: true, full: true });
      assert.equal(backfill.ran, true);
      assert.ok(counts.show >= counts.episode, "a backfill must stay show-heavy, not episode-heavy");
      assert.ok(counts.show >= counts.season, "a backfill must stay show-heavy, not episode-heavy");
      assert.deepEqual([...directions], ["desc"]);
    } finally {
      net.restore();
    }
  });

  it("skips add-on channels sold through a service (Starz via Prime Video Channels)", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db, RAPIDAPI_KEY: "test-rapidapi-key", NEW_ON_STREAMING_ENGINE: "rapidapi" });
    const now = Math.floor(Date.now() / 1000);
    const net = stubRapidApi((url) => {
      if (url.includes("item_type=show") && url.includes("change_type=new")) {
        return {
          changes: [
            { changeType: "new", itemType: "show", showId: "chan", timestamp: now - 100, service: { id: "prime" }, streamingOptionType: "addon", addon: { id: "starz" } },
            { changeType: "new", itemType: "show", showId: "sub", timestamp: now - 200, service: { id: "prime" }, streamingOptionType: "subscription" },
          ],
          shows: {
            chan: { id: "chan", imdbId: "tt9500001", title: "Starz Channel Movie", showType: "movie" },
            sub: { id: "sub", imdbId: "tt9500002", title: "Included With Prime", showType: "movie" },
          },
          hasMore: false,
        };
      }
      return { changes: [], shows: {}, hasMore: false };
    });
    try {
      const cookie = await adminCookie(env);
      await sweep(env, cookie, 4);
      assert.deepEqual(liveTitles(db).map((r) => r.name), ["Included With Prime"]);
    } finally {
      net.restore();
    }
  });

  it("filters out digital store buy/rent releases and preserves true subscription premiere date", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db, RAPIDAPI_KEY: "test-rapidapi-key", NEW_ON_STREAMING_ENGINE: "rapidapi" });
    const now = Math.floor(Date.now() / 1000);
    const sep16 = now - 259200; // 3 days ago
    const sep18 = now - 86400;  // 1 day ago

    const net = stubRapidApi((url) => {
      if (url.includes("item_type=show")) {
        return {
          changes: [
            // Golden Axe premieres on Paramount+ on Sep 16 (subscription)
            { changeType: "new", itemType: "show", showId: "golden_axe", timestamp: sep16, service: { id: "paramount.subscription" }, streamingOptionType: "subscription" },
            // Golden Axe added to Apple TV iTunes Store to BUY on Sep 18 (digital purchase)
            { changeType: "new", itemType: "show", showId: "golden_axe", timestamp: sep18, service: { id: "apple" }, streamingOptionType: "buy" },
            // Random iTunes movie purchase (e.g. Body of Sin)
            { changeType: "new", itemType: "show", showId: "body_of_sin", timestamp: sep18, service: { id: "apple" }, streamingOptionType: "rent" },
          ],
          shows: {
            golden_axe: { id: "golden_axe", imdbId: "tt9300001", title: "Golden Axe", showType: "series", releaseYear: 2026 },
            body_of_sin: { id: "body_of_sin", imdbId: "tt9300002", title: "Body of Sin", showType: "movie", releaseYear: 2018 },
          },
          hasMore: false,
        };
      }
      return { changes: [], shows: {}, hasMore: false };
    });

    try {
      const cookie = await adminCookie(env);
      const sweepRes = await sweep(env, cookie, 3, { reset: true });
      assert.equal(sweepRes.ran, true);

      // Body of Sin (iTunes rent) must be completely filtered out
      const moviePreview = await previewNewOnStreaming(env, "tmdb:new-on-streaming", "movie");
      assert.equal(moviePreview.body.ok, true);
      assert.equal(moviePreview.body.sample.some((m) => m.name === "Body of Sin"), false, "digital rentals must not appear");

      // Golden Axe must be present under Paramount+, dated Sep 16 (NOT Apple TV+ on Sep 18)
      const adminPreview = await call(env, "/admin/api/new-on-streaming/preview?type=all", {
        headers: { cookie },
      });
      assert.equal(adminPreview.status, 200);
      assert.equal(adminPreview.body.ok, true);
      const goldenAxeItem = adminPreview.body.items.find((m) => m.name === "Golden Axe");
      assert.ok(goldenAxeItem, "Golden Axe must be present");
      assert.equal(goldenAxeItem.service, "paramount", "must be attributed to Paramount+");
      assert.equal(goldenAxeItem.addedAt, sep16, "must keep its true subscription premiere date");
    } finally {
      net.restore();
    }
  });

  // mdblist.com/new-on-streaming lists them (Good Morning America sits in its
  // Sep 21, 2026 row) because JustWatch's feed does: a daily show's season
  // gaining an episode is an entry like any other. Filtering them out was
  // the opposite of matching it.
  it("keeps daily shows (talk, news, game shows) the way mdblist does", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db, RAPIDAPI_KEY: "test-rapidapi-key", NEW_ON_STREAMING_ENGINE: "rapidapi" });
    const now = Math.floor(Date.now() / 1000);

    const net = stubRapidApi((url) => {
      if (url.includes("item_type=episode")) {
        return {
          changes: [
            // Daily talk show episode (e.g. Jimmy Fallon on Peacock)
            { changeType: "new", itemType: "episode", showId: "fallon", timestamp: now - 100, service: { id: "peacock" }, season: 12, episode: 210 },
            // Daily news broadcast episode (e.g. World News Tonight on Hulu)
            { changeType: "new", itemType: "episode", showId: "news", timestamp: now - 120, service: { id: "hulu" }, season: 2026, episode: 260 },
            // Daily game show episode (e.g. Jeopardy! on Peacock)
            { changeType: "new", itemType: "episode", showId: "jeopardy", timestamp: now - 140, service: { id: "peacock" }, season: 41, episode: 10 },
            // Scripted series episode (e.g. A Parasite's Heart on Netflix)
            { changeType: "new", itemType: "episode", showId: "parasite", timestamp: now - 500, service: { id: "netflix" }, season: 1, episode: 5 },
          ],
          shows: {
            fallon: { id: "fallon", imdbId: "tt3444938", title: "The Tonight Show Starring Jimmy Fallon", showType: "series", genres: [{ id: "talk-show", name: "Talk Show" }] },
            news: { id: "news", imdbId: "tt0184095", title: "World News Tonight with David Muir", showType: "series", genres: [{ id: "news", name: "News" }] },
            jeopardy: { id: "jeopardy", imdbId: "tt0159881", title: "Jeopardy!", showType: "series", genres: [{ id: "game-show", name: "Game Show" }] },
            parasite: { id: "parasite", imdbId: "tt45851964", title: "A Parasite's Heart", showType: "series", genres: [{ id: "drama", name: "Drama" }, { id: "romance", name: "Romance" }] },
          },
          hasMore: false,
        };
      }
      return { changes: [], shows: {}, hasMore: false };
    });

    try {
      const cookie = await adminCookie(env);
      const sweepRes = await sweep(env, cookie, 3, { reset: true });
      assert.equal(sweepRes.ran, true);

      const preview = await previewNewOnStreaming(env, "tmdb:new-on-streaming", "series");
      assert.equal(preview.body.ok, true);

      assert.deepEqual(preview.body.sample.map((m) => m.name), [
        "The Tonight Show Starring Jimmy Fallon",
        "World News Tonight with David Muir",
        "Jeopardy!",
        "A Parasite's Heart",
      ]);
    } finally {
      net.restore();
    }
  });

  it("normalizes prefixed tmdbId like series/324931 to clean tmdb:324931 when imdbId is missing", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db, RAPIDAPI_KEY: "test-rapidapi-key", NEW_ON_STREAMING_ENGINE: "rapidapi" });
    const now = Math.floor(Date.now() / 1000);

    const net = stubRapidApi((url) => {
      if (url.includes("item_type=show")) {
        return {
          changes: [
            { changeType: "new", itemType: "show", showId: "series/324931", timestamp: now, service: { id: "netflix" } },
          ],
          shows: {
            "series/324931": {
              id: "series/324931",
              tmdbId: "series/324931",
              imdbId: null,
              title: "A Parasite's Heart",
              originalTitle: "Hua Jai Ka Fak",
              showType: "series",
            },
          },
          hasMore: false,
        };
      }
      return { changes: [], shows: {}, hasMore: false };
    });

    try {
      const cookie = await adminCookie(env);
      const sweepRes = await sweep(env, cookie, 3, { reset: true });
      assert.equal(sweepRes.ran, true);

      const preview = await previewNewOnStreaming(env, "tmdb:new-on-streaming", "series");
      assert.equal(preview.body.ok, true);
      const item = preview.body.sample.find((m) => m.name === "A Parasite's Heart");
      assert.ok(item, "show must be present");
      assert.equal(item.id, "tmdb:324931", "must normalize to clean integer tmdb:324931 without series/ prefix");
    } finally {
      net.restore();
    }
  });

  it("supports search filtering and pagination in /admin/api/new-on-streaming/preview", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db });
    seedStreamingEvent(db, { service: "netflix", imdbId: "tt45851964", at: 5000, kind: "series", name: "A Parasite's Heart" });
    seedStreamingEvent(db, { service: "netflix", imdbId: "tt9990001", at: 4000, kind: "movie", name: "Hypnotic" });
    seedStreamingEvent(db, { service: "netflix", imdbId: "tt9990002", at: 3000, kind: "series", name: "The Crow Club" });

    const cookie = await adminCookie(env);

    // Search by title "Parasite"
    const searchRes = await call(env, "/admin/api/new-on-streaming/preview?type=all&q=parasite", {
      headers: { cookie },
    });
    assert.equal(searchRes.status, 200);
    assert.equal(searchRes.body.ok, true);
    assert.equal(searchRes.body.items.length, 1);
    assert.equal(searchRes.body.items[0].name, "A Parasite's Heart");

    // Search by IMDb ID
    const idSearch = await call(env, "/admin/api/new-on-streaming/preview?type=all&q=tt45851964", {
      headers: { cookie },
    });
    assert.equal(idSearch.status, 200);
    assert.equal(idSearch.body.items.length, 1);
    assert.equal(idSearch.body.items[0].name, "A Parasite's Heart");

    // Pagination: limit=1, skip=1
    const paged = await call(env, "/admin/api/new-on-streaming/preview?type=all&limit=1&skip=1", {
      headers: { cookie },
    });
    assert.equal(paged.status, 200);
    assert.equal(paged.body.items.length, 1);
    assert.equal(paged.body.items[0].name, "Hypnotic");
    assert.equal(paged.body.totalItems, 3);
  });

  it("adds and syncs a title directly into streaming_events via /admin/api/new-on-streaming/add", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db, TMDB_API_KEY: "test-tmdb-key", NEW_ON_STREAMING_ENGINE: "rapidapi" });
    const cookie = await adminCookie(env);

    // Stub TMDB fetch
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      const urlStr = String(url);
      if (urlStr.includes("/3/find/tt45851964")) {
        return new Response(JSON.stringify({
          tv_results: [{ id: 324931, name: "A Parasite's Heart", first_air_date: "2026-09-14" }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (urlStr.includes("/3/tv/324931")) {
        return new Response(JSON.stringify({
          id: 324931,
          name: "A Parasite's Heart",
          first_air_date: "2026-09-14",
          external_ids: { imdb_id: "tt45851964" },
          last_episode_to_air: { air_date: "2026-09-18", season_number: 1, episode_number: 5 },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return origFetch(url, opts);
    };

    try {
      const addRes = await call(env, "/admin/api/new-on-streaming/add", {
        method: "POST",
        headers: { cookie },
        json: { input: "tt45851964", service: "netflix", kind: "series" },
      });
      assert.equal(addRes.status, 200);
      assert.equal(addRes.body.ok, true);
      assert.equal(addRes.body.result.name, "A Parasite's Heart");
      assert.equal(addRes.body.result.imdbId, "tt45851964");
      assert.equal(addRes.body.result.tmdbId, 324931);
      assert.equal(addRes.body.result.season, 1);
      assert.equal(addRes.body.result.episode, 5);

      // Verify it is in preview and dated 2026-09-18
      const preview = await call(env, "/admin/api/new-on-streaming/preview?type=series", {
        headers: { cookie },
      });
      assert.equal(preview.body.items.length, 1);
      assert.equal(preview.body.items[0].name, "A Parasite's Heart");
      assert.equal(preview.body.items[0].service, "netflix");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("bumps active series when TMDB reports a newer episode air date", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db, TMDB_API_KEY: "test-tmdb-key", RAPIDAPI_KEY: "test-key", NEW_ON_STREAMING_ENGINE: "rapidapi" });
    const cookie = await adminCookie(env);
    const now = Math.floor(Date.now() / 1000);
    const sep14 = now - 432000; // 5 days ago
    const sep18 = now - 86400;  // 1 day ago
    const sep18Iso = new Date(sep18 * 1000).toISOString().slice(0, 10);

    seedStreamingEvent(db, {
      service: "netflix",
      imdbId: "tt45851964",
      tmdbId: 324931,
      at: sep14,
      kind: "series",
      name: "A Parasite's Heart",
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      const urlStr = String(url);
      if (urlStr.includes("streaming-availability.p.rapidapi.com")) {
        return new Response(JSON.stringify({ changes: [], shows: {}, hasMore: false }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (urlStr.includes("/3/tv/324931")) {
        return new Response(JSON.stringify({
          id: 324931,
          name: "A Parasite's Heart",
          networks: [{ id: 213, name: "Netflix" }],
          last_episode_to_air: { air_date: sep18Iso, season_number: 1, episode_number: 5 },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return origFetch(url, opts);
    };

    try {
      const sweepRes = await call(env, "/admin/api/new-on-streaming/sweep", {
        method: "POST",
        headers: { cookie },
        json: { units: 1, manual: true, bump: true },
      });
      assert.equal(sweepRes.status, 200);
      assert.equal(sweepRes.body.ok, true);
      assert.ok(sweepRes.body.bump);
      assert.equal(sweepRes.body.bump.bumped, 1);

      // Verify row in database is updated to sep18
      const row = db._db.prepare("SELECT * FROM streaming_events WHERE imdb_id = 'tt45851964'").get();
      assert.equal(row.last_event_at, Math.floor(Date.UTC(Number(sep18Iso.slice(0, 4)), Number(sep18Iso.slice(5, 7)) - 1, Number(sep18Iso.slice(8, 10))) / 1000));
      assert.equal(row.event_kind, "episode");
      assert.equal(row.season, 1);
      assert.equal(row.episode, 5);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  // Regression test for the "A Love Other Than Yours" report: a show that
  // fell behind 50 other, more-recently-active series must still get its
  // episode bump. Under the old `ORDER BY last_event_at DESC LIMIT 50`
  // selection, the 50 fresher fillers below would occupy every slot forever
  // and the target would never once be selected for a TMDB check, however
  // many ticks ran -- it would sit at its original arrival date permanently
  // while MDBList (which does not have this ceiling) correctly showed it
  // bumped to the new episode's air date.
  it("still checks and bumps a series buried past the old top-50-by-recency window", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db, TMDB_API_KEY: "test-tmdb-key", NEW_ON_STREAMING_ENGINE: "rapidapi" });
    const cookie = await adminCookie(env);
    const now = Math.floor(Date.now() / 1000);

    for (let i = 1; i <= 50; i++) {
      seedStreamingEvent(db, {
        service: "netflix",
        imdbId: `tt1000${String(i).padStart(3, "0")}`,
        kind: "series",
        at: now - i,
        name: `Filler ${i}`,
      });
    }

    const staleAt = now - 20 * 86400; // 20 days ago: stale, but inside the 30-day prune window
    seedStreamingEvent(db, {
      service: "primevideo",
      imdbId: "tt9999999",
      tmdbId: 500001,
      kind: "series",
      at: staleAt,
      name: "A Love Other Than Yours",
    });

    const newEpisodeIso = new Date((now - 86400) * 1000).toISOString().slice(0, 10); // aired yesterday

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      const urlStr = String(url);
      if (urlStr.includes("/3/tv/500001")) {
        return new Response(JSON.stringify({
          id: 500001,
          name: "A Love Other Than Yours",
          networks: [{ id: 1024, name: "Prime Video" }],
          last_episode_to_air: { air_date: newEpisodeIso, season_number: 1, episode_number: 6 },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return origFetch(url, opts);
    };

    // Simulate the rotating cursor having already walked past the 50 fresher
    // shows on earlier ticks, exactly as it would after enough real
    // 6-minute cron ticks -- this is the state the fix is meant to reach.
    await env.CONFIGS.put("cron:newonstreaming:bumpcursor:US", "50");

    try {
      const res = await call(env, "/admin/api/new-on-streaming/sweep", {
        method: "POST",
        headers: { cookie },
        json: { units: 1, manual: true, bump: true },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true, res.body.error);
      assert.ok(res.body.bump);
      assert.equal(res.body.bump.bumped, 1, "the buried show must still get checked and bumped");

      const row = db._db.prepare("SELECT * FROM streaming_events WHERE imdb_id = 'tt9999999'").get();
      assert.ok(row.last_event_at > staleAt, "last_event_at must move forward to the new episode");
      assert.equal(row.event_kind, "episode");
      assert.equal(row.season, 1);
      assert.equal(row.episode, 6);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  // The false positives that did not match mdblist: a library service's row
  // bumped by an episode airing on the show's broadcast network.
  it("does not bump a service's row from TMDB when the show is not that service's original", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db, TMDB_API_KEY: "test-tmdb-key", NEW_ON_STREAMING_ENGINE: "rapidapi" });
    const cookie = await adminCookie(env);
    const now = Math.floor(Date.now() / 1000);
    const staleAt = now - 10 * 86400;
    seedStreamingEvent(db, { service: "netflix", imdbId: "tt4209256", tmdbId: 600001, kind: "series", at: staleAt, name: "Live PD: Police Patrol" });
    const airedIso = new Date((now - 86400) * 1000).toISOString().slice(0, 10);

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      const urlStr = String(url);
      if (urlStr.includes("streaming-availability.p.rapidapi.com")) {
        return new Response(JSON.stringify({ changes: [], shows: {}, hasMore: false }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (urlStr.includes("/3/tv/600001")) {
        return new Response(JSON.stringify({
          id: 600001,
          networks: [{ id: 129, name: "A&E" }],
          last_episode_to_air: { air_date: airedIso, season_number: 4, episode_number: 30 },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return origFetch(url, opts);
    };
    try {
      const res = await call(env, "/admin/api/new-on-streaming/sweep", {
        method: "POST",
        headers: { cookie },
        json: { units: 1, manual: true, bump: true },
      });
      assert.equal(res.body.ok, true, res.body.error);
      assert.equal(res.body.bump.bumped, 0);
      assert.equal(res.body.bump.notOriginal, 1);
      const row = db._db.prepare("SELECT * FROM streaming_events WHERE imdb_id = 'tt4209256'").get();
      assert.equal(row.last_event_at, staleAt);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// --- JustWatch engine (the default; what mdblist.com/new-on-streaming uses) --

function jwEdge({ type = "Movie", title, imdbId, tmdbId = null, year = 2024, pkg = "nfx", season = null, newEps = null, monetization = "FLATRATE" }) {
  const content = { title, originalReleaseYear: year, posterUrl: "/poster/1/{profile}/x.{format}", externalIds: { imdbId, tmdbId } };
  return {
    newOffer: { monetizationType: monetization, newElementCount: newEps, dateCreated: "", package: { shortName: pkg } },
    node: type === "Season"
      ? { __typename: "Season", objectId: 1, content: { seasonNumber: season }, show: { objectId: 2, content } }
      : { __typename: "Movie", objectId: 3, content },
  };
}

function stubJustWatch(byDate) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("apis.justwatch.com")) {
      const body = JSON.parse(opts.body);
      calls.push(body.variables);
      const pages = byDate[body.variables.date] || [[]];
      const i = body.variables.after ? Number(body.variables.after) : 0;
      const edges = pages[i] || [];
      const more = i + 1 < pages.length;
      return new Response(JSON.stringify({ data: { newTitles: { totalCount: 0, edges, pageInfo: { hasNextPage: more, endCursor: more ? String(i + 1) : null } } } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("streaming-availability.p.rapidapi.com")) throw new Error("RapidAPI must not be called on the JustWatch engine");
    return realFetch(url, opts);
  };
  return { restore: () => { globalThis.fetch = realFetch; }, calls };
}

describe("JustWatch New on Streaming sweep", () => {
  const day = (offset) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);

  it("files each title under the day JustWatch dated it, and a new episode moves a show to that day", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db });
    const net = stubJustWatch({
      [day(0)]: [[
        jwEdge({ type: "Season", title: "Old Show", imdbId: "tt1000001", pkg: "hlu", season: 5, newEps: 1 }),
        jwEdge({ title: "Today Movie", imdbId: "tt1000002", pkg: "amp" }),
      ]],
      [day(1)]: [[jwEdge({ title: "Yesterday Movie", imdbId: "tt1000003", pkg: "nfx" })]],
      [day(5)]: [[jwEdge({ type: "Season", title: "Old Show", imdbId: "tt1000001", pkg: "hlu", season: 5, newEps: 8 })]],
    });
    try {
      const cookie = await adminCookie(env);
      const res = await sweep(env, cookie, 40);
      assert.equal(res.source, "justwatch");
      const preview = await call(env, "/admin/api/new-on-streaming/preview?type=all", { headers: { cookie } });
      const items = preview.body.items;
      assert.deepEqual(items.map((m) => m.name), ["Old Show", "Today Movie", "Yesterday Movie"]);
      assert.equal(new Date(items[0].addedAt * 1000).toISOString().slice(0, 10), day(0));
      assert.equal(new Date(items[2].addedAt * 1000).toISOString().slice(0, 10), day(1));
      assert.deepEqual(items[0].services, ["hulu"]);
      assert.equal(items[1].service, "primevideo");
      assert.equal(items[0].type, "series");
      assert.match(items[1].poster, /^https:\/\/images\.justwatch\.com\/poster\/1\/s592\/x\.jpg$/);
    } finally {
      net.restore();
    }
  });

  it("asks for exactly mdblist's eight services, subscription only", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db });
    const net = stubJustWatch({});
    try {
      const cookie = await adminCookie(env);
      await sweep(env, cookie, 3);
      assert.equal(net.calls.length, 3);
      for (const v of net.calls) {
        assert.deepEqual(v.filter.packages.sort(), ["amp", "atp", "dnp", "hlu", "mxx", "nfx", "pct", "ppp"]);
        assert.deepEqual(v.filter.monetizationTypes, ["FLATRATE"]);
      }
      assert.deepEqual(net.calls.map((v) => v.date), [day(0), day(1), day(2)], "newest day first");
    } finally {
      net.restore();
    }
  });

  it("skips services it does not track and titles with no usable id", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db });
    const net = stubJustWatch({
      [day(0)]: [[
        jwEdge({ title: "On Crunchyroll", imdbId: "tt2000001", pkg: "cru" }),
        jwEdge({ title: "No Ids", imdbId: null }),
        jwEdge({ title: "Tmdb Only", imdbId: null, tmdbId: "555" }),
      ]],
    });
    try {
      const cookie = await adminCookie(env);
      await sweep(env, cookie, 1);
      assert.deepEqual(liveTitles(db).map((r) => r.imdb_id), ["tmdb:555"]);
    } finally {
      net.restore();
    }
  });

  it("reads older days once, resuming a day from its cursor, while re-reading the last three days every sweep", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db });
    const net = stubJustWatch({
      [day(3)]: [[jwEdge({ title: "Day3 A", imdbId: "tt3000001" })], [jwEdge({ title: "Day3 B", imdbId: "tt3000002" })]],
    });
    try {
      const cookie = await adminCookie(env);
      // 4 pages: days 0,1,2 (one empty page each) + page 1 of day 3.
      await sweep(env, cookie, 4);
      assert.deepEqual(liveTitles(db).map((r) => r.name), ["Day3 A"]);
      net.calls.length = 0;
      await sweep(env, cookie, 5);
      assert.deepEqual(net.calls.slice(0, 4).map((v) => [v.date, v.after]), [[day(0), ""], [day(1), ""], [day(2), ""], [day(3), "1"]]);
      assert.deepEqual(liveTitles(db).map((r) => r.name).sort(), ["Day3 A", "Day3 B"]);
      net.calls.length = 0;
      await sweep(env, cookie, 4);
      assert.equal(net.calls.some((v) => v.date === day(3)), false, "a finished older day is not read again");
    } finally {
      net.restore();
    }
  });

  // JustWatch stops a query at 600 entries (Sep 12 2026: 600+ Prime movies
  // in one day). A capped query is split until every slice fits.
  it("splits a day that hits JustWatch's 600-entry cap by service, then type, then release year", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db });
    const realFetch = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (url, opts) => {
      if (!String(url).includes("apis.justwatch.com")) return realFetch(url, opts);
      const v = JSON.parse(opts.body).variables;
      const f = v.filter;
      seen.push(f);
      const today = v.date === day(0);
      let total = 0;
      let edges = [];
      if (today) {
        const onlyAmp = f.packages.length === 1 && f.packages[0] === "amp";
        if (f.packages.length > 1) total = 600;
        else if (onlyAmp && !f.objectTypes) total = 600;
        else if (onlyAmp && f.objectTypes[0] === "MOVIE" && !f.releaseYear) total = 600;
        else if (onlyAmp && f.objectTypes[0] === "MOVIE") {
          const y = f.releaseYear.min <= 1990 && f.releaseYear.max >= 1990 ? 1990 : null;
          edges = y ? [jwEdge({ title: `Old Movie ${f.releaseYear.min}`, imdbId: "tt7000001", pkg: "amp", year: y })] : [];
          total = edges.length;
        } else if (f.packages[0] === "nfx") {
          edges = [jwEdge({ title: "Netflix Movie", imdbId: "tt7000002", pkg: "nfx" })];
          total = 1;
        }
      }
      return new Response(JSON.stringify({ data: { newTitles: { totalCount: total, edges: total >= 600 ? [] : edges, pageInfo: { hasNextPage: false, endCursor: null } } } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };
    try {
      const cookie = await adminCookie(env);
      const res = await sweep(env, cookie, 40);
      assert.ok(res.split >= 3);
      assert.deepEqual(liveTitles(db).map((r) => r.imdb_id), ["tt7000001", "tt7000002"]);
      assert.ok(seen.some((f) => f.releaseYear), "must fall back to release-year slices");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  // JustWatch's IMDb id is sometimes wrong (WWE Raw arrived as tt2932286, an
  // IMDb duplicate record), which showed as "No poster" and "Not found" on the
  // website. Its TMDB id is right, so the IMDb id comes from TMDB.
  function stubJustWatchAndTmdb(byDate, tmdb) {
    const net = stubJustWatch(byDate);
    const inner = globalThis.fetch;
    const tmdbCalls = [];
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      const m = u.match(/api\.themoviedb\.org\/3\/(tv|movie)\/(\d+)\?/);
      if (m) {
        tmdbCalls.push(`${m[1]}/${m[2]}`);
        const body = tmdb[`${m[1]}/${m[2]}`];
        if (!body) return new Response("{}", { status: 404 });
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }
      return inner(url, opts);
    };
    return { restore: () => { globalThis.fetch = inner; net.restore(); }, calls: net.calls, tmdbCalls };
  }

  it("takes the IMDb id from TMDB rather than JustWatch, once per title", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db, TMDB_API_KEY: "test-tmdb" });
    const net = stubJustWatchAndTmdb(
      {
        [day(0)]: [[
          jwEdge({ type: "Season", title: "WWE Raw", imdbId: "tt2932286", tmdbId: "4656", pkg: "nfx", season: 34, newEps: 1 }),
          jwEdge({ title: "No IMDb On TMDB", imdbId: "tt0000404", tmdbId: "777", pkg: "amp" }),
        ]],
      },
      {
        "tv/4656": { id: 4656, poster_path: "/raw.jpg", external_ids: { imdb_id: "tt0185103" } },
        "movie/777": { id: 777, poster_path: null, external_ids: { imdb_id: null } },
      }
    );
    try {
      const cookie = await adminCookie(env);
      await sweep(env, cookie, 3);
      const rows = db.q("SELECT imdb_id, tmdb_id, last_seen_walk FROM streaming_events ORDER BY imdb_id");
      assert.deepEqual(rows.map((r) => r.imdb_id), ["tmdb:777", "tt0185103"]);
      assert.ok(rows.every((r) => r.last_seen_walk === 2), "rows written from a TMDB answer are marked checked");
      assert.deepEqual(net.tmdbCalls.sort(), ["movie/777", "tv/4656"]);

      // The next sweep re-reads the same days and asks TMDB nothing.
      net.tmdbCalls.length = 0;
      await sweep(env, cookie, 3);
      assert.deepEqual(net.tmdbCalls, []);
      assert.equal(db.q("SELECT COUNT(*) AS n FROM streaming_events")[0].n, 2);
    } finally {
      net.restore();
    }
  });

  it("drops a row an earlier sweep wrote under JustWatch's wrong id", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db, TMDB_API_KEY: "test-tmdb" });
    const now = Math.floor(Date.now() / 1000);
    db._db.prepare(
      `INSERT INTO streaming_events (region, service, imdb_id, tmdb_id, kind, added_at, last_event_at, event_kind, name)
       VALUES ('US', 'netflix', 'tt2932286', 4656, 'series', ?, ?, 'season', 'WWE Raw')`
    ).run(now - 86400, now - 86400);
    const net = stubJustWatchAndTmdb(
      { [day(0)]: [[jwEdge({ type: "Season", title: "WWE Raw", imdbId: "tt2932286", tmdbId: "4656", pkg: "nfx", season: 34, newEps: 1 })]] },
      { "tv/4656": { id: 4656, poster_path: "/raw.jpg", external_ids: { imdb_id: "tt0185103" } } }
    );
    try {
      const cookie = await adminCookie(env);
      await sweep(env, cookie, 3);
      assert.deepEqual(liveTitles(db).map((r) => r.imdb_id), ["tt0185103"]);
    } finally {
      net.restore();
    }
  });

  it("stops a day when this sweep is out of TMDB lookups, and finishes it on the next", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db, TMDB_API_KEY: "test-tmdb" });
    const pages = [];
    const tmdb = {};
    for (let p = 0; p < 4; p++) {
      const page = [];
      for (let i = 0; i < 100; i++) {
        const n = p * 100 + i + 1;
        page.push(jwEdge({ title: `Movie ${n}`, imdbId: `tt9${String(n).padStart(6, "0")}`, tmdbId: String(n), pkg: "nfx" }));
        tmdb[`movie/${n}`] = { id: n, poster_path: "/p.jpg", external_ids: { imdb_id: `tt9${String(n).padStart(6, "0")}` } };
      }
      pages.push(page);
    }
    const net = stubJustWatchAndTmdb({ [day(0)]: pages }, tmdb);
    try {
      const cookie = await adminCookie(env);
      const first = await sweep(env, cookie, 10);
      assert.equal(first.idLookups, 300);
      assert.equal(db.q("SELECT COUNT(*) AS n FROM streaming_events")[0].n, 300);
      const second = await sweep(env, cookie, 10);
      assert.equal(second.idLookups, 100);
      assert.equal(db.q("SELECT COUNT(*) AS n FROM streaming_events")[0].n, 400);
    } finally {
      net.restore();
    }
  });

  it("does not run the TMDB episode bump (the feed already carries episodes)", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db, TMDB_API_KEY: "k" });
    const net = stubJustWatch({});
    try {
      const cookie = await adminCookie(env);
      const r = await call(env, "/admin/api/new-on-streaming/sweep", { method: "POST", cookie, json: { units: 1, bump: true } });
      assert.equal(r.body.bump.ran, false);
      assert.equal(r.body.bump.checked, 0);
    } finally {
      net.restore();
    }
  });
});

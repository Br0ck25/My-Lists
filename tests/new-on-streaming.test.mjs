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
    "newOnStreamingWalkPath",
    "newOnStreamingCombos",
    "newOnStreamingDepthOf",
    "newOnStreamingMaxPage",
    "newOnStreamingPassPages",
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
  for (const name of ["NEW_ON_STREAMING_PROVIDERS", "NEW_ON_STREAMING_REGIONS", "NEW_ON_STREAMING_MAX_PAGES_PER_CATALOG", "NEW_ON_STREAMING_PAGES_PER_TICK"]) {
    const m = src00.match(new RegExp(`const ${name}[\\s\\S]*?;`));
    if (!m) throw new Error(`missing const ${name}`);
    consts.push(m[0]);
  }

  const fn = new Function(`${consts.join("\n")}\n${chunks.join("\n")}\nreturn { ${names.join(", ")}, NEW_ON_STREAMING_PROVIDERS, NEW_ON_STREAMING_MAX_PAGES_PER_CATALOG, NEW_ON_STREAMING_PAGES_PER_TICK };`);
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
});

describe("newOnStreamingDateToEpoch", () => {
  const now = Math.floor(Date.UTC(2026, 0, 15) / 1000);

  it("reads a TMDB YYYY-MM-DD date as UTC midnight", () => {
    assert.equal(H.newOnStreamingDateToEpoch("2024-03-08", now), Math.floor(Date.UTC(2024, 2, 8) / 1000));
  });

  it("returns 0 for anything it cannot parse, rather than today", () => {
    assert.equal(H.newOnStreamingDateToEpoch("", now), 0);
    assert.equal(H.newOnStreamingDateToEpoch("soon", now), 0);
    assert.equal(H.newOnStreamingDateToEpoch(null, now), 0);
  });

  // Provider catalogs carry announced-but-unreleased titles. One seeded at its
  // own future date would sit above everything that actually arrived.
  it("clamps a future date to now", () => {
    assert.equal(H.newOnStreamingDateToEpoch("2030-01-01", now), now);
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

describe("newOnStreamingWalkPath", () => {
  // The walk is only coherent if its ordering is stable between the ticks that
  // read successive pages. Popularity is not: it reorders under the walk, so
  // titles slide across page boundaries and arrivals are both missed and
  // invented. This is the assertion that stops that being "fixed" by someone
  // who notices the shelf would look livelier sorted by popularity.
  it("sorts by release date, never popularity", () => {
    const moviePath = H.newOnStreamingWalkPath("movie", 8, "US", 1, "2026-01-15");
    const tvPath = H.newOnStreamingWalkPath("tv", 8, "US", 1, "2026-01-15");
    assert.match(moviePath, /sort_by=primary_release_date\.desc/);
    assert.match(tvPath, /sort_by=first_air_date\.desc/);
    assert.doesNotMatch(moviePath, /popularity/);
    assert.doesNotMatch(tvPath, /popularity/);
  });

  it("filters to the subscription catalog of one provider in one region", () => {
    const p = H.newOnStreamingWalkPath("movie", 337, "GB", 3, "2026-01-15");
    assert.match(p, /with_watch_providers=337/);
    assert.match(p, /watch_region=GB/);
    assert.match(p, /with_watch_monetization_types=flatrate/);
    assert.match(p, /page=3/);
  });

  it("never asks for titles that have not come out yet", () => {
    assert.match(H.newOnStreamingWalkPath("movie", 8, "US", 1, "2026-01-15"), /primary_release_date\.lte=2026-01-15/);
    assert.match(H.newOnStreamingWalkPath("tv", 8, "US", 1, "2026-01-15"), /first_air_date\.lte=2026-01-15/);
  });
});

describe("newOnStreamingCombos", () => {
  const combos = H.newOnStreamingCombos();

  it("is one entry per provider per kind, and its length does not depend on catalogue size", () => {
    assert.equal(combos.length, H.NEW_ON_STREAMING_PROVIDERS.length * 2);
    assert.equal(new Set(combos.map((c) => c.key)).size, combos.length, "keys must be unique");
  });

  // The cursor stores a position in this list, so a list built in a different
  // order by a later tick would resume somewhere else entirely.
  it("is built in a stable order", () => {
    assert.deepEqual(combos.map((c) => c.key), H.newOnStreamingCombos().map((c) => c.key));
  });

  // The ordering bug this pins, found from the admin panel on a real first
  // walk: nested provider-first, the sweep drained every page of Netflix
  // movies before it touched Netflix shows, and all of those before the second
  // provider -- so for hours the shelf was Netflix films and nothing else. The
  // walk is page-major over this list, so one lap of it is page 1 everywhere.
  it("covers every provider and both kinds in a single lap", () => {
    assert.equal(
      new Set(combos.map((c) => `${c.provider.key}/${c.kind}`)).size,
      H.NEW_ON_STREAMING_PROVIDERS.length * 2
    );
    assert.ok(H.NEW_ON_STREAMING_PAGES_PER_TICK >= combos.length,
      "a tick should cover at least one full lap, so the top of the shelf fills everywhere at once");
  });
});

describe("learned catalogue depth", () => {
  const combos = H.newOnStreamingCombos();

  // The bug this pins is the one that made the whole feature miss the case it
  // was built for. A fixed 40-page horizon on a release-date-descending walk
  // is the ~800 most recently RELEASED titles, so a 2010 film added to Netflix
  // today was never fetched at all -- the list could only report new releases
  // arriving. Depth has to come from TMDB's own total_pages.
  it("defaults an unmeasured catalogue to page 1 only, so the first read measures it", () => {
    assert.equal(H.newOnStreamingDepthOf({}, "US:netflix:movie"), 1);
    assert.equal(H.newOnStreamingMaxPage(combos, {}), 1);
    assert.equal(H.newOnStreamingPassPages(combos, {}), combos.length);
  });

  it("uses the measured depth once TMDB has reported it", () => {
    const depths = { "US:netflix:movie": 180, "US:hulu:tv": 42 };
    assert.equal(H.newOnStreamingDepthOf(depths, "US:netflix:movie"), 180);
    assert.equal(H.newOnStreamingMaxPage(combos, depths), 180);
    assert.equal(H.newOnStreamingPassPages(combos, depths), 180 + 42 + (combos.length - 2));
  });

  // TMDB's discover stops paginating at 500; asking beyond it wastes a fetch
  // per catalogue per pass, forever.
  it("never walks past TMDB's own pagination limit", () => {
    assert.equal(
      H.newOnStreamingDepthOf({ "US:netflix:movie": 99999 }, "US:netflix:movie"),
      H.NEW_ON_STREAMING_MAX_PAGES_PER_CATALOG
    );
  });

  it("ignores a nonsense depth rather than skipping the catalogue", () => {
    for (const bad of [0, -5, null, "many", undefined, NaN]) {
      assert.equal(H.newOnStreamingDepthOf({ k: bad }, "k"), 1, `depth ${String(bad)} must fall back to 1`);
    }
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
});

// --- The sweep itself, driven against a stubbed TMDB ------------------------
//
// Everything above tests inputs and outputs. These drive the real
// sweepNewOnStreaming through the admin route, with TMDB replaced by a
// controllable catalogue, so the parts that only happen over TIME -- learning
// how deep a catalogue is, completing a pass, concluding a title has gone, and
// a title coming back -- are exercised rather than reasoned about.

async function adminCookie(env) {
  const r = await call(env, "/admin/login", { method: "POST", form: { key: env.ADMIN_KEY } });
  const m = (r.headers.get("set-cookie") || "").match(/^([^=]+=[^;]+)/);
  return m ? m[1] : "";
}

// A fake TMDB holding one catalogue per provider+kind. `catalogue` maps a
// provider id to the array of titles it currently carries; mutate it between
// sweeps to make a title arrive or leave.
function stubTmdb(catalogue) {
  const realFetch = globalThis.fetch;
  const state = { discoverCalls: 0, fail: null };
  globalThis.fetch = async (url) => {
    const u = String(url);
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
    if (u.includes("/discover/")) {
      state.discoverCalls++;
      if (state.fail) return new Response("nope", { status: 500 });
      const provider = Number((/with_watch_providers=(\d+)/.exec(u) || [])[1]);
      const page = Number((/[?&]page=(\d+)/.exec(u) || [])[1] || 1);
      const isTv = u.includes("/discover/tv");
      const all = (catalogue[provider] || []).filter((t) => !!t.tv === isTv);
      const perPage = 20;
      const slice = all.slice((page - 1) * perPage, page * perPage);
      return json({
        page,
        total_pages: Math.max(1, Math.ceil(all.length / perPage)),
        total_results: all.length,
        results: slice.map((t) => ({
          id: t.id,
          [isTv ? "name" : "title"]: t.name,
          [isTv ? "first_air_date" : "release_date"]: t.date || "2024-01-01",
          poster_path: "/p.jpg",
        })),
      });
    }
    // Detail lookup -> an IMDb id derived from the TMDB id, so assertions can
    // name a title by either.
    const id = (/\/3\/(?:movie|tv)\/(\d+)/.exec(u) || [])[1];
    if (id) return json({ id: Number(id), external_ids: { imdb_id: "tt" + String(id).padStart(7, "0") } });
    return json({ results: [] });
  };
  return { restore: () => { globalThis.fetch = realFetch; }, state };
}

// One provider only, so a pass is short enough to complete inside a test.
function soloProviderEnv(catalogue) {
  const db = makeD1();
  const env = makeEnv({ DB: db, TMDB_API_KEY: "test-key" });
  return { db, env };
}

async function sweep(env, cookie, units = 64) {
  const r = await call(env, "/admin/api/new-on-streaming/sweep", {
    method: "POST", cookie, json: { units, bump: false },
  });
  assert.equal(r.body.ok, true, r.body.error);
  return r.body.sweep;
}

function liveTitles(db) {
  return db.q("SELECT imdb_id, name, seeded, last_event_at, removed_at FROM streaming_events WHERE removed_at IS NULL ORDER BY imdb_id");
}

describe("the sweep over a whole catalogue", () => {
  it("measures how deep a catalogue is instead of stopping at a fixed page", async () => {
    // 130 titles = 7 pages. A fixed 40-page horizon would have hidden nothing
    // here, but a fixed 3-page one would -- the point is that the depth comes
    // from TMDB's total_pages, so a catalogue of any size is read to its end.
    const titles = Array.from({ length: 130 }, (_, i) => ({ id: 1000 + i, name: `Movie ${i}`, date: "2015-06-01" }));
    const { db, env } = soloProviderEnv();
    const net = stubTmdb({ 8: titles });
    try {
      const cookie = await adminCookie(env);
      for (let i = 0; i < 12; i++) await sweep(env, cookie);
      assert.equal(liveTitles(db).length, 130,
        "every page of the catalogue must be collected, not just the first N");
    } finally {
      net.restore();
    }
  });

  // The question that exposed the fixed-horizon bug: a 2010 film added today.
  // Sorted by release date it is nowhere near page 1, so the only way it is
  // ever seen is if the walk reads the catalogue to its end.
  it("picks up an old film added to a service today", async () => {
    const recent = Array.from({ length: 100 }, (_, i) => ({ id: 2000 + i, name: `New ${i}`, date: "2025-01-01" }));
    const catalogue = { 8: [...recent] };
    const { db, env } = soloProviderEnv();
    const net = stubTmdb(catalogue);
    try {
      const cookie = await adminCookie(env);
      for (let i = 0; i < 12; i++) await sweep(env, cookie);
      const before = liveTitles(db).length;

      // A 2010 title appears, sorted to the very back of the catalogue.
      catalogue[8].push({ id: 9999, name: "Old Film From 2010", date: "2010-03-04" });
      for (let i = 0; i < 12; i++) await sweep(env, cookie);

      const rows = liveTitles(db);
      assert.equal(rows.length, before + 1, "the 2010 title must be collected");
      const old = rows.find((r) => r.name === "Old Film From 2010");
      assert.ok(old, "the 2010 title must be on the shelf");
      assert.equal(old.seeded, 0,
        "found after the seeding pass, so it is a real observed arrival and dated today");
    } finally {
      net.restore();
    }
  });
});

describe("marking a title as gone", () => {
  it("removes a title the catalogue no longer carries, after the grace passes", async () => {
    // Forty titles, one of which leaves. Deliberately not two-and-one: the
    // per-catalogue guard refuses to believe that a quarter of a service
    // vanished at once, so a tiny fixture could never remove anything -- and a
    // test that only passes on a fixture the guard would reject in production
    // is not testing the production path.
    const catalogue = { 8: [
      ...Array.from({ length: 39 }, (_, i) => ({ id: 3100 + i, name: `Stays ${i}` })),
      { id: 3002, name: "Leaves" },
    ] };
    const { db, env } = soloProviderEnv();
    const net = stubTmdb(catalogue);
    try {
      const cookie = await adminCookie(env);
      for (let i = 0; i < 4; i++) await sweep(env, cookie);
      assert.equal(liveTitles(db).length, 40);

      catalogue[8] = catalogue[8].filter((t) => t.name !== "Leaves");
      // One completed pass is not enough -- the grace is deliberate, so a
      // single bad read from TMDB cannot empty the shelf.
      let names = [];
      for (let i = 0; i < 12; i++) {
        await sweep(env, cookie);
        names = liveTitles(db).map((r) => r.name);
        if (!names.includes("Leaves")) break;
      }
      assert.equal(names.length, 39, "the departed title must eventually be marked gone");
      assert.ok(!names.includes("Leaves"));
      const gone = db.q("SELECT name, removed_at FROM streaming_events WHERE removed_at IS NOT NULL");
      assert.equal(gone.length, 1);
      assert.equal(gone[0].name, "Leaves");
      assert.ok(gone[0].removed_at > 0, "removal is recorded with a date, not a delete");
    } finally {
      net.restore();
    }
  });

  it("does not mark anything gone on a pass that could not be read", async () => {
    const catalogue = { 8: Array.from({ length: 30 }, (_, i) => ({ id: 4100 + i, name: `Present ${i}` })) };
    const { db, env } = soloProviderEnv();
    const net = stubTmdb(catalogue);
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...a) => warnings.push(a.join(" "));
    try {
      const cookie = await adminCookie(env);
      for (let i = 0; i < 4; i++) await sweep(env, cookie);
      assert.equal(liveTitles(db).length, 30);

      // TMDB falls over for several passes. Nothing is on the shelf's own
      // evidence absent -- it simply was not looked at.
      net.state.fail = true;
      for (let i = 0; i < 10; i++) await sweep(env, cookie);
      assert.equal(liveTitles(db).length, 30,
        "an unreadable pass must not empty the shelf");
      assert.ok(warnings.some((w) => w.includes("New on Streaming removals skipped")),
        "and it must say why rather than silently doing nothing");
    } finally {
      console.warn = realWarn;
      net.restore();
    }
  });

  it("treats a title that comes back as a new arrival", async () => {
    const catalogue = { 8: [
      ...Array.from({ length: 39 }, (_, i) => ({ id: 5100 + i, name: `Anchor ${i}` })),
      { id: 5002, name: "Returns" },
    ] };
    const { db, env } = soloProviderEnv();
    const net = stubTmdb(catalogue);
    try {
      const cookie = await adminCookie(env);
      for (let i = 0; i < 4; i++) await sweep(env, cookie);

      catalogue[8] = catalogue[8].filter((t) => t.name !== "Returns");
      for (let i = 0; i < 12; i++) {
        await sweep(env, cookie);
        if (!liveTitles(db).some((r) => r.name === "Returns")) break;
      }
      const removedAt = db.q("SELECT removed_at FROM streaming_events WHERE name = 'Returns'")[0].removed_at;
      assert.ok(removedAt, "precondition: it was marked gone");
      const anchorBefore = db.q("SELECT last_event_at FROM streaming_events WHERE name = 'Anchor 0'")[0].last_event_at;

      catalogue[8].push({ id: 5002, name: "Returns" });
      for (let i = 0; i < 4; i++) await sweep(env, cookie);

      const back = db.q("SELECT name, removed_at, last_event_at, seeded FROM streaming_events WHERE name = 'Returns'")[0];
      assert.equal(back.removed_at, null, "coming back clears the removal");
      assert.equal(back.seeded, 0);
      assert.ok(back.last_event_at >= anchorBefore,
        "it is on the service today and was not yesterday, so it sorts as an arrival");
    } finally {
      net.restore();
    }
  });

  it("keeps a still-present title's original arrival date across passes", async () => {
    const catalogue = { 8: [{ id: 6001, name: "Constant" }] };
    const { db, env } = soloProviderEnv();
    const net = stubTmdb(catalogue);
    try {
      const cookie = await adminCookie(env);
      await sweep(env, cookie);
      const first = db.q("SELECT added_at, last_event_at FROM streaming_events WHERE name = 'Constant'")[0];
      for (let i = 0; i < 8; i++) await sweep(env, cookie);
      const later = db.q("SELECT added_at, last_event_at FROM streaming_events WHERE name = 'Constant'")[0];
      assert.equal(later.added_at, first.added_at, "a first sighting is permanent");
      assert.equal(later.last_event_at, first.last_event_at,
        "re-seeing a title must not re-date it, or the shelf would reshuffle every pass");
    } finally {
      net.restore();
    }
  });
});

describe("one provider going dark", () => {
  // The failure a table-wide guard waves through, and the reason the guard is
  // per catalogue. TMDB answering 200 with an empty result set for one service
  // is not an error, so no error count catches it -- and one service is only
  // an eighth of the table, so "every Netflix title left overnight" reads as a
  // perfectly ordinary 12% until you measure it against Netflix's own rows.
  it("does not empty a service that TMDB has simply stopped listing", async () => {
    const catalogue = {
      8: Array.from({ length: 30 }, (_, i) => ({ id: 7100 + i, name: `Netflix ${i}` })),
      15: Array.from({ length: 30 }, (_, i) => ({ id: 7200 + i, name: `Hulu ${i}` })),
    };
    const { db, env } = soloProviderEnv();
    const net = stubTmdb(catalogue);
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...a) => warnings.push(a.join(" "));
    try {
      const cookie = await adminCookie(env);
      for (let i = 0; i < 4; i++) await sweep(env, cookie);
      assert.equal(liveTitles(db).length, 60);

      // Netflix returns nothing at all -- with a 200, not an error. At the
      // same time one Hulu title genuinely leaves, which must still be
      // noticed: holding back a catalogue that has obviously broken is not a
      // reason to stop believing the ones that are fine.
      catalogue[8] = [];
      catalogue[15] = catalogue[15].filter((t) => t.name !== "Hulu 0");
      for (let i = 0; i < 12; i++) await sweep(env, cookie);

      const live = liveTitles(db).map((r) => r.name);
      assert.equal(live.filter((n) => n.startsWith("Netflix")).length, 30,
        "a service that went quiet must not be wiped off the shelf");
      assert.ok(!live.includes("Hulu 0"),
        "a real departure on a healthy service must still be marked, per catalogue");
      assert.equal(live.filter((n) => n.startsWith("Hulu")).length, 29);
      assert.ok(warnings.some((w) => w.includes("whole catalogues had emptied")),
        "and the held-back catalogue must be logged, not swallowed");
    } finally {
      console.warn = realWarn;
      net.restore();
    }
  });
});

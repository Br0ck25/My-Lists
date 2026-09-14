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
    "newOnStreamingUnits",
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
  for (const name of ["NEW_ON_STREAMING_PROVIDERS", "NEW_ON_STREAMING_REGIONS", "NEW_ON_STREAMING_WALK_DEPTH_PAGES", "NEW_ON_STREAMING_PAGES_PER_TICK"]) {
    const m = src00.match(new RegExp(`const ${name}[\\s\\S]*?;`));
    if (!m) throw new Error(`missing const ${name}`);
    consts.push(m[0]);
  }

  const fn = new Function(`${consts.join("\n")}\n${chunks.join("\n")}\nreturn { ${names.join(", ")}, NEW_ON_STREAMING_PROVIDERS, NEW_ON_STREAMING_WALK_DEPTH_PAGES, NEW_ON_STREAMING_PAGES_PER_TICK };`);
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

describe("newOnStreamingUnits", () => {
  const units = H.newOnStreamingUnits();

  it("covers every provider, both kinds, to the full walk depth", () => {
    assert.equal(units.length, H.NEW_ON_STREAMING_PROVIDERS.length * 2 * H.NEW_ON_STREAMING_WALK_DEPTH_PAGES);
  });

  // The cursor stores an index into this list, so a list built in a different
  // order by a later tick would resume somewhere else entirely.
  it("is built in a stable order", () => {
    const again = H.newOnStreamingUnits();
    assert.deepEqual(
      units.map((u) => `${u.region}/${u.provider.key}/${u.kind}/${u.page}`),
      again.map((u) => `${u.region}/${u.provider.key}/${u.kind}/${u.page}`)
    );
  });

  it("starts every provider at page 1 and never asks TMDB for page 0", () => {
    assert.ok(units.every((u) => u.page >= 1));
    assert.equal(units[0].page, 1);
  });

  // The ordering bug this pins, found from the admin panel on a real first
  // walk: nested provider-first, the sweep drained all 40 pages of Netflix
  // movies before it touched Netflix shows, and all 80 of those before the
  // second provider -- so for over four hours the shelf was Netflix films and
  // nothing else, having collected Netflix's 800th-newest title before Hulu's
  // newest. Page-major fixes it, and a "newest first" list is worth nothing if
  // this is ever nested back the other way.
  it("walks page 1 of EVERY provider and kind before page 2 of any", () => {
    const combos = H.NEW_ON_STREAMING_PROVIDERS.length * 2;
    const firstPass = units.slice(0, combos);
    assert.ok(firstPass.every((u) => u.page === 1),
      "the first units of the walk must all be page 1");
    assert.equal(new Set(firstPass.map((u) => `${u.provider.key}/${u.kind}`)).size, combos,
      "and between them must cover every provider and both kinds");
    assert.equal(units[combos].page, 2, "only then does page 2 begin");
  });

  it("reaches every provider and kind within the first couple of ticks", () => {
    const perTick = H.NEW_ON_STREAMING_PAGES_PER_TICK;
    const seen = new Set();
    for (let i = 0; i < perTick * 2 && i < units.length; i++) {
      seen.add(`${units[i].provider.key}/${units[i].kind}`);
    }
    assert.equal(seen.size, H.NEW_ON_STREAMING_PROVIDERS.length * 2,
      "two ticks must have touched every provider and both kinds");
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

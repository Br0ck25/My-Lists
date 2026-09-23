import { describe, it } from "node:test";
import assert from "node:assert/strict";

// My Lists Addon Charts: New on Streaming plus this add-on's own Most Watched
// charts (mylists:most-watched:today|7|30), in Quick Add and Discover.

const { makeEnv, makeD1, call } = await import("./harness.mjs");

async function watch(env, events) {
  const r = await call(env, "/api/track-event", {
    method: "POST",
    json: { events: events.map((e) => ({ eventType: "watched", ...e })) },
  });
  assert.equal(r.body.ok, true);
}

// The page's markup is served at "/", its client script at /app.js.
async function pageAndScript(env) {
  const html = (await call(env, "/")).text;
  const src = (html.match(/<script src="(\/app\.js[^"]*)"/) || [])[1];
  assert.ok(src, "app.js script tag missing");
  const js = (await call(env, src)).text;
  return { html, js };
}

async function preview(env, url, type) {
  const r = await call(env, "/api/preview", { method: "POST", json: { url, type, sample: 50 } });
  assert.equal(r.body.ok, true, r.body.error);
  return r.body;
}

function easternDay(ms = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

describe("My Lists Addon Most Watched catalog", () => {
  it("ranks titles by how often they were watched, split into movies and shows", async () => {
    const env = makeEnv({ DB: makeD1() });
    await watch(env, [
      { id: "tt0000001", title: "Popular Movie", mediaType: "movie" },
      { id: "tt0000002", title: "Quiet Movie", mediaType: "movie" },
      { id: "tt0000009", title: "A Show", mediaType: "series" },
    ]);
    await watch(env, [{ id: "tt0000001", title: "Popular Movie", mediaType: "movie" }]);
    await watch(env, [{ id: "tt0000001", title: "Popular Movie", mediaType: "movie" }]);
    await watch(env, [{ id: "tt0000002", title: "Quiet Movie", mediaType: "movie" }]);

    const movies = await preview(env, "mylists:most-watched:7", "movie");
    assert.deepEqual(movies.sample.map((m) => m.name), ["Popular Movie", "Quiet Movie"]);
    assert.equal(movies.sample[0].poster, "https://images.metahub.space/poster/medium/tt0000001/img");

    const shows = await preview(env, "mylists:most-watched:today", "series");
    assert.deepEqual(shows.sample.map((m) => m.name), ["A Show"]);
  });

  it("folds a stray episode id into its show", async () => {
    const env = makeEnv({ DB: makeD1() });
    await watch(env, [{ id: "tt5000001", title: "Big Show", mediaType: "series" }]);
    await watch(env, [{ id: "tt5000001:1:2", title: "Big Show", mediaType: "series" }]);
    await watch(env, [{ id: "tt5000001:1:3", title: "Big Show", mediaType: "series" }]);
    await watch(env, [{ id: "tt5000002", title: "Other Show", mediaType: "series" }]);
    await watch(env, [{ id: "tt5000002", title: "Other Show", mediaType: "series" }]);

    const shows = await preview(env, "mylists:most-watched:30", "series");
    assert.deepEqual(shows.sample.map((m) => m.name), ["Big Show", "Other Show"]);
    assert.equal(shows.sample[0].id, "tt5000001");
  });

  it("serves the 7-day chart from one snapshot per day, and rebuilds \"today\" once it is an hour old", async () => {
    const env = makeEnv({ DB: makeD1() });
    await watch(env, [{ id: "tt6000001", title: "First", mediaType: "movie" }]);
    assert.deepEqual((await preview(env, "mylists:most-watched:7", "movie")).sample.map((m) => m.name), ["First"]);
    assert.deepEqual((await preview(env, "mylists:most-watched:today", "movie")).sample.map((m) => m.name), ["First"]);

    await watch(env, [{ id: "tt6000002", title: "Second", mediaType: "movie" }]);
    await watch(env, [{ id: "tt6000002", title: "Second", mediaType: "movie" }]);

    // Same Eastern day: the 7-day chart is the morning's snapshot.
    assert.deepEqual((await preview(env, "mylists:most-watched:7", "movie")).sample.map((m) => m.name), ["First"]);

    // "today" is still inside its hour, then isn't.
    assert.deepEqual((await preview(env, "mylists:most-watched:today", "movie")).sample.map((m) => m.name), ["First"]);
    const key = "mylists:mostwatched:v2:today:movie";
    const snap = JSON.parse(await env.CONFIGS.get(key));
    snap.builtAt -= 3601 * 1000;
    await env.CONFIGS.put(key, JSON.stringify(snap));
    assert.deepEqual((await preview(env, "mylists:most-watched:today", "movie")).sample.map((m) => m.name), ["Second", "First"]);

    // A snapshot from yesterday is rebuilt for the 7-day chart too.
    const key7 = "mylists:mostwatched:v2:7:movie";
    const snap7 = JSON.parse(await env.CONFIGS.get(key7));
    assert.equal(snap7.day, easternDay());
    snap7.day = "2000-01-01";
    await env.CONFIGS.put(key7, JSON.stringify(snap7));
    assert.deepEqual((await preview(env, "mylists:most-watched:7", "movie")).sample.map((m) => m.name), ["Second", "First"]);
  });

  // The "null iv" entry: watches whose id had been through String(null)
  // piled up under one fake title "null" and topped the chart.
  it("never counts or charts an id like \"null\" or a bare number", async () => {
    const env = makeEnv({ DB: makeD1() });
    for (let i = 0; i < 5; i++) {
      await watch(env, [
        { id: "null", title: "null iv", mediaType: "movie" },
        { id: "undefined", title: "", mediaType: "movie" },
      ]);
    }
    await watch(env, [{ id: "tt8000001", title: "Real Movie", mediaType: "movie" }]);
    const movies = await preview(env, "mylists:most-watched:30", "movie");
    assert.deepEqual(movies.sample.map((m) => m.name), ["Real Movie"]);
    const kinds = env.DB.q("SELECT kind FROM stats WHERE kind LIKE 'evt:watched:%'").map((r) => r.kind);
    assert.equal(kinds.some((k) => /null|undefined/.test(k)), false, "junk ids must not be recorded at all");
  });

  it("hides counts already recorded under a junk id, in the chart and the admin Trending table", async () => {
    const env = makeEnv({ DB: makeD1() });
    // What the live data looks like: rows written before the guard existed.
    const today = easternDay();
    env.DB._db.prepare("INSERT INTO stats (kind, day, n) VALUES (?, ?, ?)").run("evt:watched:null", today, 9);
    env.DB._db.prepare("INSERT INTO stats (kind, day, n) VALUES (?, ?, ?)").run("evt:watched:null", "total", 9);
    env.DB._db.prepare("INSERT INTO event_meta (event_type, item_id, title, media_type, last_seen) VALUES (?, ?, ?, ?, ?)").run("watched", "null", "null iv", "movie", Date.now());
    await watch(env, [{ id: "tt8000002", title: "Honest Movie", mediaType: "movie" }]);

    const movies = await preview(env, "mylists:most-watched:7", "movie");
    assert.deepEqual(movies.sample.map((m) => m.name), ["Honest Movie"]);

    const login = await call(env, "/admin/login", { method: "POST", form: { key: env.ADMIN_KEY } });
    const cookie = (login.headers.get("set-cookie") || "").match(/^([^=]+=[^;]+)/)[1];
    const board = await call(env, "/admin/api/leaderboard?type=watched&window=7&mediaType=movie", { cookie });
    assert.equal(board.body.ok, true);
    assert.deepEqual(board.body.entries.map((e) => e.id), ["tt8000002"]);
  });

  it("caps each Most Watched chart at 25 titles", async () => {
    const env = makeEnv({ DB: makeD1() });
    const events = [];
    for (let i = 0; i < 40; i++) events.push({ id: `tt90000${String(i).padStart(2, "0")}`, title: `Movie ${i}`, mediaType: "movie" });
    await watch(env, events);
    const movies = await preview(env, "mylists:most-watched:30", "movie");
    assert.equal(movies.sample.length, 25);
    assert.equal(movies.totalItems, 25);
  });

  it("works on a KV-only deployment too", async () => {
    const env = makeEnv({});
    await watch(env, [{ id: "tt7000001", title: "KV Movie", mediaType: "movie" }]);
    const movies = await preview(env, "mylists:most-watched:7", "movie");
    assert.deepEqual(movies.sample.map((m) => m.name), ["KV Movie"]);
  });

  it("is an empty row, not an error, before anyone has watched anything", async () => {
    const env = makeEnv({ DB: makeD1() });
    const movies = await preview(env, "mylists:most-watched:30", "movie");
    assert.deepEqual(movies.sample, []);
  });
});

describe("New on Streaming as a My Lists Addon chart", () => {
  it("is not capped: the whole window pages through, on the website and in the admin preview", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db });
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 30; i++) {
      db._db.prepare(
        `INSERT INTO streaming_events (region, service, imdb_id, kind, added_at, last_event_at, event_kind, name, poster)
         VALUES ('US', 'netflix', ?, 'movie', ?, ?, 'added', ?, 'https://example.test/p.jpg')`
      ).run(`tt40000${String(i).padStart(2, "0")}`, now - i, now - i, `Arrival ${i}`);
    }
    const pub = await preview(env, "tmdb:new-on-streaming", "movie");
    assert.equal(pub.sample.length, 30);
    assert.equal(pub.totalItems, 30);
    assert.equal(pub.sample[0].name, "Arrival 0");

    const login = await call(env, "/admin/login", { method: "POST", form: { key: env.ADMIN_KEY } });
    const cookie = (login.headers.get("set-cookie") || "").match(/^([^=]+=[^;]+)/)[1];
    const admin = await call(env, "/admin/api/new-on-streaming/preview?type=movie&limit=100", { cookie });
    assert.equal(admin.body.totalItems, 30);
    assert.equal(admin.body.items.length, 30);
  });
});

describe("My Lists Addon Charts on the website", () => {
  it("has its own Quick Add section with all four charts and an Add all button", async () => {
    const env = makeEnv({});
    const { html, js } = await pageAndScript(env);
    assert.match(html, /<h2 class="shelf-title">My Lists Addon Charts<\/h2>/);
    assert.match(html, /data-add-all-action="mylists-charts"/);
    for (const url of ["tmdb:new-on-streaming", "mylists:most-watched:today", "mylists:most-watched:7", "mylists:most-watched:30"]) {
      assert.ok(html.includes(`'${url}', 'movie'`) && html.includes(`'${url}', 'series'`), `missing movie/show buttons for ${url}`);
    }
    assert.match(js, /function addAllMyListsAddonCharts\(\) \{\n  addRow\("New on Streaming", "tmdb:new-on-streaming", 'movie'/);
    assert.match(js, /action === 'mylists-charts'\) addAllMyListsAddonCharts\(\)/);
  });

  it("feeds Discover's All / Movies / Shows with the same charts, credited to My Lists Addon", async () => {
    const env = makeEnv({});
    const { html, js } = await pageAndScript(env);
    const m = html.match(/window\._CHARTS_MY_LISTS_ADDON = (\[.*?\]);/);
    assert.ok(m, "Discover chart table missing");
    const charts = JSON.parse(m[1]);
    assert.deepEqual(charts.map((c) => c.name), [
      "New on Streaming",
      "Most Watched Today",
      "Most Watched 7 Days",
      "Most Watched 30 Days",
    ]);
    assert.match(js, /window\._CHARTS_MY_LISTS_ADDON\.forEach\(function\(p\) \{ pushPair\(p\.name, p\.movieUrl, p\.showUrl, 'My Lists Addon'\); \}\)/);
    assert.equal(js.includes("_CHARTS_NEW_ON_STREAMING"), false);
  });

  it("gives each chart a shareable /lists/<slug> page", async () => {
    const env = makeEnv({});
    for (const [slug, url] of [
      ["New-on-Streaming", "tmdb:new-on-streaming"],
      ["Most-Watched-Today", "mylists:most-watched:today"],
      ["Most-Watched-7-Days", "mylists:most-watched:7"],
      ["Most-Watched-30-Days", "mylists:most-watched:30"],
      // The names these first shipped under keep working.
      ["My-Lists-Addon-Most-Watched-Today", "mylists:most-watched:today"],
      ["My-Lists-Addon-Most-Watched-7-Days", "mylists:most-watched:7"],
      ["My-Lists-Addon-Most-Watched-30-Days", "mylists:most-watched:30"],
    ]) {
      const r = await call(env, `/lists/${slug}`);
      assert.equal(r.status, 200);
      assert.ok(r.text.includes(url), `${slug} should deep-link ${url}`);
    }
  });
});

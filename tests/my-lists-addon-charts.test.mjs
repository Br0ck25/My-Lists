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
    const key = "mylists:mostwatched:v1:today:movie";
    const snap = JSON.parse(await env.CONFIGS.get(key));
    snap.builtAt -= 3601 * 1000;
    await env.CONFIGS.put(key, JSON.stringify(snap));
    assert.deepEqual((await preview(env, "mylists:most-watched:today", "movie")).sample.map((m) => m.name), ["Second", "First"]);

    // A snapshot from yesterday is rebuilt for the 7-day chart too.
    const key7 = "mylists:mostwatched:v1:7:movie";
    const snap7 = JSON.parse(await env.CONFIGS.get(key7));
    assert.equal(snap7.day, easternDay());
    snap7.day = "2000-01-01";
    await env.CONFIGS.put(key7, JSON.stringify(snap7));
    assert.deepEqual((await preview(env, "mylists:most-watched:7", "movie")).sample.map((m) => m.name), ["Second", "First"]);
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
      "My Lists Addon Most Watched Today",
      "My Lists Addon Most Watched (7 Days)",
      "My Lists Addon Most Watched (30 Days)",
    ]);
    assert.match(js, /window\._CHARTS_MY_LISTS_ADDON\.forEach\(function\(p\) \{ pushPair\(p\.name, p\.movieUrl, p\.showUrl, 'My Lists Addon'\); \}\)/);
    assert.equal(js.includes("_CHARTS_NEW_ON_STREAMING"), false);
  });

  it("gives each chart a shareable /lists/<slug> page", async () => {
    const env = makeEnv({});
    for (const [slug, url] of [
      ["New-on-Streaming", "tmdb:new-on-streaming"],
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

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeKv, makeEnv, call } from "./harness.mjs";

// BetterPosters is keyed by IMDB id and nothing else -- there is no
// /poster/tmdb/... route. The Curated For You / Recommended cards hold
// TMDB-id-only items, so their tiles need the id translated before any
// BetterPosters URL can be built for them.

const realFetch = globalThis.fetch;
let calls = [];

before(() => {
  globalThis.fetch = async (input) => {
    const url = String(input && input.url ? input.url : input);
    calls.push(url);
    const m = url.match(/\/3\/(movie|tv)\/(\d+)\/external_ids/);
    if (!m) return new Response("{}", { status: 404 });
    // 999 stands for a title TMDB has no IMDB id for.
    const body = m[2] === "999" ? { imdb_id: null } : { imdb_id: "tt" + m[2].padStart(7, "0") };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
});
after(() => { globalThis.fetch = realFetch; });

const post = (env, items) => call(env, "/api/imdb-ids", { method: "POST", json: { items } });

describe("/api/imdb-ids", () => {
  it("translates TMDB ids to IMDB ids", async () => {
    calls = [];
    const env = makeEnv({ CONFIGS: makeKv() });
    const r = await post(env, [
      { id: "tmdb:278", type: "movie" },
      { id: "tmdb:1396", type: "series" },
    ]);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.map["tmdb:278"], "tt0000278");
    assert.equal(r.body.map["tmdb:1396"], "tt0001396");
    assert.ok(calls.some((u) => u.includes("/3/movie/278/external_ids")), "movie goes to the movie endpoint");
    assert.ok(calls.some((u) => u.includes("/3/tv/1396/external_ids")), "series goes to the tv endpoint");
  });

  it("omits a title TMDB has no IMDB id for, rather than inventing one", async () => {
    const env = makeEnv({ CONFIGS: makeKv() });
    const r = await post(env, [{ id: "tmdb:999", type: "movie" }]);
    assert.equal(r.body.ok, true);
    assert.ok(!("tmdb:999" in r.body.map));
  });

  it("resolves an episode id to its show", async () => {
    const env = makeEnv({ CONFIGS: makeKv() });
    const r = await post(env, [{ id: "tmdb:1396:2:5", type: "series" }]);
    assert.equal(r.body.map["tmdb:1396:2:5"], "tt0001396");
  });

  it("ignores anything that is not a TMDB id", async () => {
    calls = [];
    const env = makeEnv({ CONFIGS: makeKv() });
    const r = await post(env, [
      { id: "tt0111161", type: "movie" },
      { id: "../../evil", type: "movie" },
      { id: "tmdb:not-a-number", type: "movie" },
      { id: "", type: "movie" },
    ]);
    assert.deepEqual(r.body.map, {});
    assert.equal(calls.length, 0, "and makes no outbound call for any of them");
  });

  // The ceiling is what keeps this off the free plan's 50-subrequest limit.
  it("caps how many it will look up in one request", async () => {
    calls = [];
    const env = makeEnv({ CONFIGS: makeKv() });
    const many = Array.from({ length: 60 }, (_, i) => ({ id: "tmdb:" + (1000 + i), type: "movie" }));
    const r = await post(env, many);
    assert.equal(r.body.ok, true);
    assert.ok(calls.length <= 24, "at most 24 outbound calls, got " + calls.length);
    assert.ok(Object.keys(r.body.map).length <= 24);
  });

  it("answers an empty request without calling out", async () => {
    calls = [];
    const env = makeEnv({ CONFIGS: makeKv() });
    const r = await post(env, []);
    assert.deepEqual(r.body, { ok: true, map: {} });
    assert.equal(calls.length, 0);
  });
});

// --- the client pass that uses it -----------------------------------------

const { loadClient } = await import("./client-harness.mjs");

function tileClient(storage, mapResponse) {
  const seen = [];
  const c = loadClient({
    storage,
    routes: {
      "/api/imdb-ids": (req) => { seen.push(req.body); return { json: { ok: true, map: mapResponse || {} } }; },
    },
  });
  c.__seen = seen;
  return c;
}

// A stand-in for the poster-tile markup: the wrapper carries data-id/data-type
// and holds the <img>, which is what the pass keys off.
function makeTile(id, type) {
  const img = { getAttribute: () => null, src: "tmdb-poster.jpg" };
  return {
    dataset: { id, type, poster: "tmdb-poster.jpg" },
    querySelector: (sel) => (sel === "img" ? img : null),
    _img: img,
  };
}

function rootWith(tiles) {
  return { querySelectorAll: () => tiles };
}

describe("applyBetterPostersToTmdbTiles", () => {
  const ON = { "myListAddon:betterPosters": "1" };

  it("does nothing while Better Posters is off", async () => {
    const c = tileClient({}, { "tmdb:278": "tt0068646" });
    const tile = makeTile("tmdb:278", "movie");
    await c.call("applyBetterPostersToTmdbTiles", rootWith([tile]));
    assert.equal(c.__seen.length, 0, "must not call out when the setting is off");
    assert.equal(tile._img.src, "tmdb-poster.jpg");
  });

  it("swaps a TMDB tile for BetterPosters artwork when it is on", async () => {
    const c = tileClient(ON, { "tmdb:278": "tt0068646" });
    const tile = makeTile("tmdb:278", "movie");
    await c.call("applyBetterPostersToTmdbTiles", rootWith([tile]));
    assert.equal(c.__seen.length, 1);
    assert.deepEqual(c.__seen[0].items, [{ id: "tmdb:278", type: "movie" }]);
    assert.equal(tile._img.src, "https://btttr.cc/poster/imdb/poster-default/tt0068646.jpg");
    // The poster modal reads this back, so it has to match what is shown.
    assert.equal(tile.dataset.poster, "https://btttr.cc/poster/imdb/poster-default/tt0068646.jpg");
  });

  it("leaves a tile alone when TMDB has no IMDB id for it", async () => {
    const c = tileClient(ON, {});
    const tile = makeTile("tmdb:999", "movie");
    await c.call("applyBetterPostersToTmdbTiles", rootWith([tile]));
    assert.equal(tile._img.src, "tmdb-poster.jpg");
  });

  it("does not ask about the same id twice", async () => {
    const c = tileClient(ON, { "tmdb:278": "tt0068646" });
    await c.call("applyBetterPostersToTmdbTiles", rootWith([makeTile("tmdb:278", "movie")]));
    await c.call("applyBetterPostersToTmdbTiles", rootWith([makeTile("tmdb:278", "movie")]));
    assert.equal(c.__seen.length, 1, "the second render should reuse the cached id");
  });

  it("carries the type through, so a show is not looked up as a film", async () => {
    const c = tileClient(ON, {});
    await c.call("applyBetterPostersToTmdbTiles", rootWith([makeTile("tmdb:1396", "series")]));
    assert.deepEqual(c.__seen[0].items, [{ id: "tmdb:1396", type: "series" }]);
  });
});

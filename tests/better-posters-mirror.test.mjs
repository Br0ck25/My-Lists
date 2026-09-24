import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeKv, makeD1, makeEnv, call, runScheduledTick } from "./harness.mjs";

// The Worker's own copy of BetterPosters artwork (serveBetterPoster,
// 05_catalog-core.js). btttr.cc answers from its CDN in a fraction of a second
// for anything drawn lately, and from an origin that took 40-50s (or 504'd)
// for anything else -- so the site now fetches each poster from btttr.cc once
// and serves it from here after that.

const realFetch = globalThis.fetch;
let upstream = [];            // every btttr.cc URL fetched
let btttr = () => null;       // url -> { bytes, type } | null (fail) | Promise of either (slow)
let metahub = () => null;     // url -> { bytes, type } | null
globalThis.fetch = async (input) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.startsWith("https://btttr.cc/")) {
    upstream.push(url);
    const r = await btttr(url);
    if (!r) return new Response("gateway timeout", { status: 504 });
    return new Response(r.bytes, { status: 200, headers: { "Content-Type": r.type || "image/webp" } });
  }
  if (url.startsWith("https://images.metahub.space/")) {
    const r = metahub(url);
    if (!r) return new Response("not found", { status: 404 });
    return new Response(r.bytes, { status: 200, headers: { "Content-Type": r.type || "image/jpeg" } });
  }
  throw new TypeError("offline in tests: " + url);
};
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => { upstream = []; btttr = () => null; metahub = () => null; });

// What the website's own <img> requests carry, and an app's do not.
const SITE = { headers: { "Sec-Fetch-Site": "same-origin" } };
const later = (ms, value) => new Promise((r) => setTimeout(() => r(value), ms));

const IMG = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4, 5, 6, 7, 8]);   // stand-in image bytes

async function getBytes(env, path) {
  const res = await call(env, path);
  return { status: res.status, type: res.headers.get("content-type"), cache: res.headers.get("cache-control"), text: res.text };
}

describe("/bp/ serves BetterPosters artwork from the Worker's own copy", () => {
  it("fetches a poster from btttr.cc once and serves the stored copy after", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    btttr = () => ({ bytes: IMG });
    const first = await getBytes(env, "/bp/poster/tt1745960.jpg");
    assert.equal(first.status, 200);
    assert.equal(first.type, "image/webp");
    assert.match(first.cache, /max-age=21600/);
    assert.deepEqual(upstream, ["https://btttr.cc/poster/imdb/poster-default/tt1745960.jpg"]);

    // btttr.cc now failing: the stored copy is served regardless.
    btttr = () => null;
    const second = await getBytes(env, "/bp/poster/tt1745960.jpg");
    assert.equal(second.status, 200);
    assert.equal(second.text, first.text);
    assert.equal(upstream.length, 1, "no second trip to btttr.cc");
  });

  it("keeps each style and option combination as its own poster", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    btttr = () => ({ bytes: IMG });
    await getBytes(env, "/bp/poster-rq/tt0903747.jpg?tag=none&lang=de&rs=IM");
    assert.deepEqual(upstream, ["https://btttr.cc/poster-rq/imdb/poster-default/tt0903747.jpg?tag=none&lang=de&rs=IM"]);
    await getBytes(env, "/bp/poster/tt0903747.jpg");
    assert.equal(upstream.length, 2, "a different style is a different image");
  });

  it("only ever fetches what buildBetterPosterUrl could have produced", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    btttr = () => ({ bytes: IMG });
    for (const bad of [
      "/bp/evil/tt1745960.jpg",
      "/bp/poster/tt12.jpg",
      "/bp/poster/nm0000001.jpg",
      "/bp/poster/..%2Fadmin/tt1745960.jpg",
      "/bp/poster/tt1745960.png",
    ]) {
      assert.equal((await call(env, bad)).status, 404, bad);
    }
    // Unknown option values are dropped, not forwarded.
    await getBytes(env, "/bp/poster/tt1745960.jpg?lang=../../x&rs=ZZ&tag=maybe&extra=1");
    assert.deepEqual(upstream, ["https://btttr.cc/poster/imdb/poster-default/tt1745960.jpg"]);
  });

  it("answers 502, uncached, when neither btttr.cc nor a stand-in can supply a poster", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    const res = await call(env, "/bp/poster/tt0000123.jpg");
    assert.equal(res.status, 502);
    assert.equal(res.headers.get("cache-control"), "no-store");
  });
});

// Measured on 2026-09-24: btttr.cc answered anything it had drawn in under a
// second and anything else with a 504 after 30s, or nothing in 90. Every tile
// for such a title waited up to 55s on it and then failed.
describe("/bp/ does not keep a tile waiting on btttr.cc", () => {
  it("answers the website 503 after 6s, and stores the poster when the fetch finishes", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    btttr = () => later(6500, { bytes: IMG });
    const started = Date.now();
    const res = await call(env, "/bp/poster/tt0000301.jpg", SITE);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("cache-control"), "no-store");
    // call() waits for the background work too, so the fetch did finish --
    // after the answer, not before it.
    assert.ok(Date.now() - started >= 6500);
    btttr = () => null;
    const next = await call(env, "/bp/poster/tt0000301.jpg", SITE);
    assert.equal(next.status, 200, "the fetch carried on and was kept");
    assert.equal(upstream.length, 1);
  });

  it("gives an app the title's ordinary poster, uncached, instead of an error", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    metahub = (url) => (url === "https://images.metahub.space/poster/medium/tt0000302/img" ? { bytes: new Uint8Array([1, 2, 3]) } : null);
    const res = await call(env, "/bp/poster/tt0000302.jpg");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/jpeg");
    assert.equal(res.headers.get("cache-control"), "no-store", "so the app asks again and gets the Better Poster later");
    assert.equal(res.headers.get("x-better-poster"), "pending");
  });

  it("does not ask btttr.cc again, for a while, about a poster it just failed to supply", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    assert.equal((await call(env, "/bp/poster/tt0000303.jpg", SITE)).status, 503);
    assert.equal(upstream.length, 1);
    assert.equal((await call(env, "/bp/poster/tt0000303.jpg", SITE)).status, 503);
    assert.equal(upstream.length, 1, "answered from the miss, not another 30s wait");
    // Another style of the same title is a different image, so it is asked for.
    await call(env, "/bp/poster-n/tt0000303.jpg", SITE);
    assert.equal(upstream.length, 2);
  });

  it("re-fetches a stored copy once it is a day old, serving the old one meanwhile", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    btttr = () => ({ bytes: IMG });
    await call(env, "/bp/poster/tt0000304.jpg");
    const key = "bpimg:v1:poster:tt0000304:::";
    const meta = env.CONFIGS._metadata.get(key);
    assert.ok(meta, "stored with its fetch time");

    // Twelve hours old: left alone.
    env.CONFIGS._metadata.set(key, { ...meta, at: Date.now() - 12 * 3600e3 });
    upstream = [];
    assert.equal((await call(env, "/bp/poster/tt0000304.jpg")).status, 200);
    assert.equal(upstream.length, 0);

    // A day and a bit: served, and fetched again behind it.
    env.CONFIGS._metadata.set(key, { ...meta, at: Date.now() - 25 * 3600e3 });
    const NEW = new Uint8Array([9, 9, 9]);
    btttr = () => ({ bytes: NEW });
    const stale = await call(env, "/bp/poster/tt0000304.jpg");
    assert.equal(stale.status, 200);
    assert.equal(upstream.length, 1, "refreshed in the background");
    assert.ok(Date.now() - env.CONFIGS._metadata.get(key).at < 60e3, "and the new copy stamped now");
  });
});

describe("/api/bp/warm fetches a page's posters before they are scrolled to", () => {
  it("fetches what is missing, skips what is stored, and ignores anything not ours", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    btttr = () => ({ bytes: IMG });
    await getBytes(env, "/bp/poster/tt0000001.jpg");
    upstream = [];
    const res = await call(env, "/api/bp/warm", { method: "POST", json: { urls: [
      "/bp/poster/tt0000001.jpg",
      "/bp/poster/tt0000002.jpg",
      "https://example.test/bp/poster/tt0000003.jpg",
      "https://elsewhere.example/bp/poster/tt0000004.jpg",
      "/bp/poster/tt0000002.jpg",
    ] } });
    assert.deepEqual(res.body, {
      ok: true, stored: 1, fetched: 2,
      ready: ["/bp/poster/tt0000001.jpg", "/bp/poster/tt0000002.jpg", "https://example.test/bp/poster/tt0000003.jpg"],
    });
    assert.deepEqual(upstream.sort(), [
      "https://btttr.cc/poster/imdb/poster-default/tt0000002.jpg",
      "https://btttr.cc/poster/imdb/poster-default/tt0000003.jpg",
    ]);
    // Now instant, with btttr.cc down.
    btttr = () => null;
    assert.equal((await getBytes(env, "/bp/poster/tt0000003.jpg")).status, 200);
  });
});

describe("posters btttr.cc could not supply are retried by the cron", () => {
  it("lists a failed poster, leaves it out of `ready`, and fetches it on a later tick", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    const res = await call(env, "/api/bp/warm", { method: "POST", json: { urls: ["/bp/poster-g/tt0000401.jpg?tag=none"] } });
    assert.deepEqual(res.body, { ok: true, stored: 0, fetched: 0, ready: [] });
    const listed = JSON.parse(await env.CONFIGS.get("bp:retry:v1"));
    assert.deepEqual(Object.keys(listed), ["/bp/poster-g/tt0000401.jpg?tag=none"]);

    // btttr.cc still down: tried, and kept on the list.
    upstream = [];
    await runScheduledTick(env);
    assert.ok(upstream.includes("https://btttr.cc/poster-g/imdb/poster-default/tt0000401.jpg?tag=none"));
    assert.ok(JSON.parse(await env.CONFIGS.get("bp:retry:v1"))["/bp/poster-g/tt0000401.jpg?tag=none"]);

    // Back up: fetched, stored, and off the list.
    btttr = () => ({ bytes: IMG });
    await runScheduledTick(env);
    assert.deepEqual(JSON.parse(await env.CONFIGS.get("bp:retry:v1")), {});
    btttr = () => null;
    assert.equal((await call(env, "/bp/poster-g/tt0000401.jpg?tag=none", SITE)).status, 200);
  });
});

describe("a badge drawn over a Better Poster reads the Worker's copy", () => {
  it("embeds the stored image without fetching this Worker's own hostname", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    btttr = () => ({ bytes: IMG });
    await getBytes(env, "/bp/poster/tt0903747.jpg");
    btttr = () => null;
    const future = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
    const res = await call(env, "/api/poster-badge?poster=" + encodeURIComponent("https://example.test/bp/poster/tt0903747.jpg") + "&airDate=" + future);
    assert.equal(res.status, 200);
    assert.match(res.text, /data:image\/webp;base64,/, "the stored poster is inlined under the badge");
  });

  it("does not let another host's /bp/ past the poster allowlist", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    const res = await call(env, "/api/poster-badge?poster=" + encodeURIComponent("https://evil.example/bp/poster/tt0903747.jpg") + "&airDate=2099-01-01");
    assert.equal(res.status, 404);
  });
});

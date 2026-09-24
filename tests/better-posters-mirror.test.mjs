import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeKv, makeD1, makeEnv, call } from "./harness.mjs";

// The Worker's own copy of BetterPosters artwork (serveBetterPoster,
// 05_catalog-core.js). btttr.cc answers from its CDN in a fraction of a second
// for anything drawn lately, and from an origin that took 40-50s (or 504'd)
// for anything else -- so the site now fetches each poster from btttr.cc once
// and serves it from here after that.

const realFetch = globalThis.fetch;
let upstream = [];            // every btttr.cc URL fetched
let btttr = () => null;       // url -> { bytes, type } | null (fail)
globalThis.fetch = async (input) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.startsWith("https://btttr.cc/")) {
    upstream.push(url);
    const r = btttr(url);
    if (!r) return new Response("gateway timeout", { status: 504 });
    return new Response(r.bytes, { status: 200, headers: { "Content-Type": r.type || "image/webp" } });
  }
  throw new TypeError("offline in tests: " + url);
};
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => { upstream = []; btttr = () => null; });

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
    assert.match(first.cache, /max-age=86400/);
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

  it("answers 502, uncached, when btttr.cc cannot supply a poster it has never had", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    const res = await call(env, "/bp/poster/tt0000123.jpg");
    assert.equal(res.status, 502);
    assert.equal(res.headers.get("cache-control"), "no-store");
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
    assert.deepEqual(res.body, { ok: true, stored: 1, fetched: 2 });
    assert.deepEqual(upstream.sort(), [
      "https://btttr.cc/poster/imdb/poster-default/tt0000002.jpg",
      "https://btttr.cc/poster/imdb/poster-default/tt0000003.jpg",
    ]);
    // Now instant, with btttr.cc down.
    btttr = () => null;
    assert.equal((await getBytes(env, "/bp/poster/tt0000003.jpg")).status, 200);
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

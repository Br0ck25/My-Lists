import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadClient, requestsTo } from "./client-harness.mjs";

// A poster that fails to load is looked up again by the title it belongs to
// (handlePosterImgError, 23_client-list-management.js). The mini tiles on
// Discover, My Lists, creator profiles and the Curated cards all sit inside a
// .list-card whose data-name is the LIST's name -- and the handler used to
// take that card before the tile's own data. Seen on the site: The Simpsons
// and American Dad! in the "Hulu" card both showing Paradise, Lioness in
// "Prime Video Top 10" showing Video & Arcade Top 10.

// Just enough DOM for a walk up from an <img>.
function el(className, data = {}, parent = null) {
  const classes = new Set(String(className || "").split(/\s+/).filter(Boolean));
  const attrs = {};
  const node = {
    className,
    dataset: { ...data },
    style: {},
    parentElement: parent,
    isConnected: true,
    classList: { contains: (c) => classes.has(c) },
    getAttribute: (k) => (k === "src" ? (node.src || null) : (k in attrs ? attrs[k] : null)),
    setAttribute: (k, v) => { attrs[k] = String(v); },
    nextElementSibling: null,
    querySelector: () => null,
    appendChild: (c) => c,
  };
  return node;
}

function loadWithFallback(answer) {
  return loadClient({
    routes: { "/api/poster-fallback": () => ({ json: answer }) },
  });
}

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

function fallbackQuery(client) {
  const reqs = requestsTo(client, "/api/poster-fallback");
  assert.equal(reqs.length, 1);
  return new URL(reqs[0].url).searchParams;
}

describe("a failed poster is looked up by its own title, not its list's", () => {
  it("Discover's list cards: the tile's show, not the card's name", async () => {
    const client = loadWithFallback({ ok: true, poster: "https://images.metahub.space/poster/medium/tt0096697/img" });
    // loadPosterSlot's markup (19_client-search-and-likes.js).
    const card = el("list-card", { name: "Hulu", type: "series", listType: "series", url: "tmdb:chart:hulu" });
    const slot = el("list-card-posters", {}, card);
    const tile = el("list-card-mini-poster-tile", { name: "Hulu", url: "tmdb:chart:hulu", type: "series" }, slot);
    const wrap = el("list-card-mini-poster-img-wrap clickable-poster", { id: "tt0096697", type: "series", title: "The Simpsons" }, tile);
    const img = el("", {}, wrap);
    img.src = "https://example.com/some-poster.jpg";

    client.call("handlePosterImgError", img);
    await settle();
    const q = fallbackQuery(client);
    assert.equal(q.get("title"), "The Simpsons");
    assert.equal(q.get("imdbId"), "tt0096697");
    assert.equal(q.get("type"), "series");
    assert.equal(img.src, "https://images.metahub.space/poster/medium/tt0096697/img");
  });

  it("the Curated cards: the list's title on the tile wrapper is skipped", async () => {
    const client = loadWithFallback({ ok: false });
    // buildCuratedRecommendationCard's markup: the outer tile carries the
    // LIST's title in data-title, alongside data-url.
    const card = el("list-card", { name: "Recommended Shows", type: "series", url: "custom:curated:shows" });
    const tile = el("list-card-mini-poster-tile", { title: "Recommended Shows", type: "series", url: "custom:curated:shows" }, card);
    const wrap = el("list-card-mini-poster-img-wrap clickable-poster", { id: "tmdb:456", type: "series", title: "The Simpsons" }, tile);
    const img = el("", {}, wrap);
    img.src = "https://image.tmdb.org/t/p/w500/x.jpg";

    client.call("handlePosterImgError", img);
    await settle();
    const q = fallbackQuery(client);
    assert.equal(q.get("title"), "The Simpsons");
    assert.equal(q.get("tmdbId"), "456");
  });

  it("a My Lists / creator tile: the ids on the img itself", async () => {
    const client = loadWithFallback({ ok: false });
    const card = el("list-card", { name: "Watchlist", type: "mixed" });
    const tile = el("list-card-mini-poster-tile", { id: "tt13111078", type: "series", title: "Lioness" }, card);
    const wrap = el("list-card-mini-poster-img-wrap", {}, tile);
    const img = el("clickable-poster", { id: "tt13111078", type: "series", title: "Lioness" }, wrap);
    img.src = "https://example.com/p.jpg";

    client.call("handlePosterImgError", img);
    await settle();
    const q = fallbackQuery(client);
    assert.equal(q.get("title"), "Lioness");
    assert.equal(q.get("imdbId"), "tt13111078");
  });

  it("with nothing about the title anywhere, it does not guess from the list's name", async () => {
    const client = loadWithFallback({ ok: true, poster: "https://wrong.example/paradise.jpg" });
    const card = el("list-card", { name: "Hulu", type: "series" });
    const tile = el("list-card-mini-poster-tile", { name: "Hulu", url: "tmdb:chart:hulu", type: "series" }, card);
    const img = el("", {}, tile);
    img.src = "https://example.com/p.jpg";

    client.call("handlePosterImgError", img);
    await settle();
    assert.equal(requestsTo(client, "/api/poster-fallback").length, 0);
    assert.notEqual(img.src, "https://wrong.example/paradise.jpg");
  });

  it("resolveMissingPostersInDom reads the tile too", async () => {
    const client = loadWithFallback({ ok: false });
    const card = el("list-card", { name: "Prime Video Top 10", type: "series" });
    const tile = el("list-card-mini-poster-tile", { id: "tt13111078", type: "series", title: "Lioness" }, card);
    const ph = el("live-preview-poster live-preview-poster-placeholder", { needsFallback: "1" }, tile);
    client.call("resolveMissingPostersInDom", { querySelectorAll: () => [ph] });
    await settle();
    const q = fallbackQuery(client);
    assert.equal(q.get("title"), "Lioness");
    assert.equal(q.get("imdbId"), "tt13111078");
  });
});

describe("a Better Poster btttr.cc has not drawn yet", () => {
  it("stands in the title's ordinary poster, found by the id in its own URL", async () => {
    const client = loadWithFallback({ ok: true, poster: "https://images.metahub.space/poster/medium/tt13111078/img" });
    // A Custom List Builder pick: nothing on it names the title.
    const pick = el("live-preview-poster-card custom-list-pick", { idx: "3" });
    const img = el("live-preview-poster", {}, pick);
    const bp = "https://example.com/bp/poster/tt13111078.jpg?tag=none";
    img.src = bp;

    client.call("handlePosterImgError", img);
    await settle();
    const q = fallbackQuery(client);
    assert.equal(q.get("imdbId"), "tt13111078");
    assert.equal(img.src, "https://images.metahub.space/poster/medium/tt13111078/img");
    assert.equal(img.dataset.posterStandIn, img.src);
  });

  it("switches to the Better Poster once the warm call reports it, after it has loaded", async () => {
    const client = loadWithFallback({ ok: true, poster: "https://images.metahub.space/poster/medium/tt0096697/img" });
    const probes = [];
    client.Image = function () { const p = { src: "", onload: null }; probes.push(p); return p; };
    const wrap = el("list-card-mini-poster-img-wrap", { id: "tt0096697", title: "The Simpsons", type: "series" });
    const img = el("", {}, wrap);
    const bp = "https://example.com/bp/poster/tt0096697.jpg";
    img.src = bp;

    client.call("handlePosterImgError", img);
    await settle();
    assert.equal(img.src, "https://images.metahub.space/poster/medium/tt0096697/img");

    client.call("betterPostersReady", ["/bp/poster/tt0096697.jpg"]);
    assert.equal(probes.length, 1);
    assert.equal(probes[0].src, bp);
    assert.equal(img.src, "https://images.metahub.space/poster/medium/tt0096697/img", "not before it has loaded");
    probes[0].onload();
    assert.equal(img.src, bp);

    // And if it fails after all, back to the stand-in rather than "No poster".
    client.call("handlePosterImgError", img);
    assert.equal(img.src, "https://images.metahub.space/poster/medium/tt0096697/img");
  });

  it("reads the IMDb id from either Better Poster URL shape, and nothing else", () => {
    const client = loadClient();
    const idOf = (u) => client.call("betterPosterImdbFromUrl", u);
    assert.equal(idOf("https://example.com/bp/poster-rq/tt0903747.jpg?tag=none&lang=de"), "tt0903747");
    assert.equal(idOf("https://btttr.cc/poster/imdb/poster-default/tt7772588.jpg"), "tt7772588");
    assert.equal(idOf("https://images.metahub.space/poster/medium/tt7772588/img"), "");
    assert.equal(idOf("https://example.com/bp/poster/nm0000001.jpg"), "");
  });
});

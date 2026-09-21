import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// BetterPosters (btttr.cc) helpers live as concatenation fragments, so this
// pulls them out of the source files and evals just those, the same way
// helpers-unit.test.mjs does.

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`missing function ${name}`);
  let i = src.indexOf("{", start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  return src.slice(start, i);
}

function extractConst(src, name) {
  const m = src.match(new RegExp(`const ${name}[\\s\\S]*?;`));
  if (!m) throw new Error(`missing const ${name}`);
  return m[0];
}

function load() {
  const src00 = readFileSync(new URL("../00_constants.js", import.meta.url), "utf8");
  const src05 = readFileSync(new URL("../05_catalog-core.js", import.meta.url), "utf8");

  const consts = [
    extractConst(src00, "BETTER_POSTERS_ORIGIN"),
    extractConst(src00, "BETTER_POSTERS_RATING_SOURCES"),
    extractConst(src00, "BETTER_POSTERS_LANGS"),
    extractConst(src05, "BETTER_POSTERS_IMDB_RE"),
    extractConst(src05, "BETTER_POSTERS_PLACEHOLDER_ID"),
  ];
  const names = [
    "betterPostersImdbId",
    "betterPostersBase",
    "buildBetterPosterUrl",
    "betterPostersOptionsFrom",
    "applyBetterPostersToMetas",
    "applyBetterPosterToMeta",
  ];
  const fns = names.map((n) => extractFunction(src05, n));
  return new Function(`${consts.join("\n")}\n${fns.join("\n")}\nreturn { ${names.join(", ")} };`)();
}

const BP = load();
const ORIGIN = "https://btttr.cc";

describe("BetterPosters URL contract", () => {
  // These nine are the exact strings btttr.cc's own configurator emits from
  // updateAioUrl(), and each one was confirmed against the live service to
  // return a DIFFERENT image. Getting the "-" placement wrong (poster-gq vs
  // poster-g-q) silently falls back to default artwork.
  it("assembles every style base the way btttr.cc's configurator does", () => {
    const base = (o) => BP.betterPostersBase(o);
    assert.equal(base({ genre: true, rating: true }), "poster");
    assert.equal(base({ genre: true, rating: false }), "poster-g");
    assert.equal(base({ genre: false, rating: true }), "poster-r");
    assert.equal(base({ genre: false, rating: false }), "poster-n");
    // Flags append to an existing stem without a second dash.
    assert.equal(base({ genre: true, rating: true, quality: true }), "poster-q");
    assert.equal(base({ genre: true, rating: true, age: true }), "poster-a");
    assert.equal(base({ genre: true, rating: true, quality: true, age: true }), "poster-qa");
    assert.equal(base({ genre: true, rating: false, quality: true }), "poster-gq");
    assert.equal(base({ genre: false, rating: true, quality: true, age: true }), "poster-rqa");
  });

  it("defaults to genre+rating when the flags are absent entirely", () => {
    assert.equal(BP.betterPostersBase({}), "poster");
  });

  it("emits the canonical default URL with no query string", () => {
    assert.equal(
      BP.buildBetterPosterUrl("tt0111161", BP.betterPostersOptionsFrom({})),
      `${ORIGIN}/poster/imdb/poster-default/tt0111161.jpg`
    );
  });

  it("adds tag=none only when trend tags are switched off", () => {
    assert.equal(
      BP.buildBetterPosterUrl("tt0111161", { trendTags: false }),
      `${ORIGIN}/poster/imdb/poster-default/tt0111161.jpg?tag=none`
    );
    assert.ok(!BP.buildBetterPosterUrl("tt0111161", { trendTags: true }).includes("tag="));
  });

  it("passes through a known language and rating source, in that order", () => {
    assert.equal(
      BP.buildBetterPosterUrl("tt0111161", { lang: "pt-BR", ratingSource: "RT" }),
      `${ORIGIN}/poster/imdb/poster-default/tt0111161.jpg?lang=pt-BR&rs=RT`
    );
  });

  it("omits lang/rs at their btttr.cc defaults", () => {
    const url = BP.buildBetterPosterUrl("tt0111161", { lang: "en", ratingSource: "avg" });
    assert.ok(!url.includes("lang="));
    assert.ok(!url.includes("rs="));
  });

  it("drops a language or rating source btttr.cc does not accept", () => {
    // zh-CN and zh-TW look plausible but are not on btttr.cc's list ("zh" is),
    // and an unknown value there means no artwork rather than a fallback.
    const url = BP.buildBetterPosterUrl("tt0111161", { lang: "zh-CN", ratingSource: "XX" });
    assert.equal(url, `${ORIGIN}/poster/imdb/poster-default/tt0111161.jpg`);
    assert.ok(BP.buildBetterPosterUrl("tt0111161", { lang: "zh" }).includes("lang=zh"));
  });
});

describe("BetterPosters IMDb id resolution", () => {
  it("reads the plain id and the dedicated imdb fields", () => {
    assert.equal(BP.betterPostersImdbId({ id: "tt0111161" }), "tt0111161");
    assert.equal(BP.betterPostersImdbId({ id: "tmdb:278", imdb_id: "TT0111161" }), "tt0111161");
    assert.equal(BP.betterPostersImdbId({ id: "x", imdbId: "tt0068646" }), "tt0068646");
  });

  it("resolves a Stremio episode id to its show", () => {
    assert.equal(BP.betterPostersImdbId({ id: "tt0903747:5:16" }), "tt0903747");
  });

  it("returns null for ids BetterPosters cannot serve", () => {
    assert.equal(BP.betterPostersImdbId({ id: "tmdb:550" }), null);
    assert.equal(BP.betterPostersImdbId({ id: "channel_abc123" }), null);
    assert.equal(BP.betterPostersImdbId(null), null);
  });

  it("ignores the placeholder id used for an unavailable list", () => {
    assert.equal(BP.betterPostersImdbId({ id: "tt0000000" }), null);
  });

  // The divergence from nuvio-better-posters-addon, which DOES scrape
  // meta.poster for an id. This add-on's own badge posters carry the id in a
  // query string, so scraping would send an already-processed poster back
  // through BetterPosters and lose the badge.
  it("never scrapes an id out of the poster URL", () => {
    assert.equal(
      BP.betterPostersImdbId({ id: "tmdb:550", poster: "https://x/api/poster-badge?poster=y&id=tt0111161" }),
      null
    );
  });
});

describe("applyBetterPostersToMetas", () => {
  it("rewrites IMDb-backed posters and leaves the rest alone", () => {
    const metas = [
      { id: "tt0111161", type: "movie", name: "Shawshank", poster: "old.jpg" },
      { id: "tmdb:550", type: "movie", name: "Fight Club", poster: "keep.jpg" },
      { id: "channel_x", type: "series", name: "Channel", poster: "chan.svg" },
    ];
    const out = BP.applyBetterPostersToMetas(metas, BP.betterPostersOptionsFrom({}));
    assert.equal(out[0].poster, `${ORIGIN}/poster/imdb/poster-default/tt0111161.jpg`);
    assert.equal(out[1].poster, "keep.jpg");
    assert.equal(out[2].poster, "chan.svg");
    // Input untouched -- callers reuse the array (dedupe, stale-cache writes).
    assert.equal(metas[0].poster, "old.jpg");
  });

  it("leaves a landscape tile alone (BetterPosters only renders 2:3)", () => {
    const out = BP.applyBetterPostersToMetas(
      [{ id: "tt0111161", poster: "wide.jpg", posterShape: "landscape" }],
      {}
    );
    assert.equal(out[0].poster, "wide.jpg");
  });

  it("preserves totalItems, which pagination depends on", () => {
    const metas = [{ id: "tt0111161", poster: "a.jpg" }];
    metas.totalItems = 250;
    assert.equal(BP.applyBetterPostersToMetas(metas, {}).totalItems, 250);
  });

  it("keeps every other field on the meta", () => {
    const out = BP.applyBetterPostersToMetas(
      [{ id: "tt0111161", type: "movie", name: "Shawshank", description: "d", releaseInfo: "1994" }],
      {}
    );
    assert.equal(out[0].name, "Shawshank");
    assert.equal(out[0].description, "d");
    assert.equal(out[0].releaseInfo, "1994");
  });

  it("handles empty and non-array input", () => {
    assert.deepEqual(BP.applyBetterPostersToMetas([], {}), []);
    assert.equal(BP.applyBetterPostersToMetas(null, {}), null);
  });

  it("applies to a single meta for the detail route", () => {
    const meta = BP.applyBetterPosterToMeta({ id: "tt0903747", poster: "old.jpg" }, {});
    assert.equal(meta.poster, `${ORIGIN}/poster/imdb/poster-default/tt0903747.jpg`);
    assert.equal(BP.applyBetterPosterToMeta(null, {}), null);
  });
});

describe("betterPostersOptionsFrom", () => {
  it("maps an empty config onto btttr.cc's own defaults", () => {
    assert.deepEqual(BP.betterPostersOptionsFrom({}), {
      genre: true, rating: true, quality: false, age: false,
      trendTags: true, lang: "en", ratingSource: "avg",
    });
  });

  it("carries a fully customised config through", () => {
    const o = BP.betterPostersOptionsFrom({
      betterPostersGenre: false, betterPostersRating: false,
      betterPostersQuality: true, betterPostersAge: true,
      betterPostersTrendTags: false, betterPostersLang: "de",
      betterPostersRatingSource: "IM",
    });
    assert.equal(BP.buildBetterPosterUrl("tt0111161", o),
      `${ORIGIN}/poster-nqa/imdb/poster-default/tt0111161.jpg?tag=none&lang=de&rs=IM`);
  });
});

// --- end-to-end through the real Worker -----------------------------------
// The unit tests above prove the URL builder. These prove the wiring: that a
// stored config's betterPosters flag actually reaches fetchCatalog, and that
// it lands on the correct side of the badge pass.

const { makeKv, makeD1, makeEnv, call } = await import("./harness.mjs");

function seedShow(db, username, showId) {
  db.q(
    `INSERT INTO continue_watching (username, show_id, item_id, name, show_title, season_num, episode_num, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    username, showId, `${showId}:2:1`, "Season 2 Premiere", "BP Show", 2, 1, 9050
  );
}

function bpConfig(username, extra) {
  return JSON.stringify({
    trackCreatorName: username,
    entries: [
      { id: "continue-watching", type: "series", name: "Continue Watching", url: `autotrack:continue-watching:series:${username}` },
    ],
    ...extra,
  });
}

describe("BetterPosters end-to-end via the catalog route", () => {
  const SHOW = "tt0903747";

  it("serves btttr.cc artwork once the setting is on, and does not before", async () => {
    const kv = makeKv();
    const db = makeD1();
    const env = makeEnv({ CONFIGS: kv, DB: db });
    const u = "bpuser1";
    seedShow(db, u, SHOW);

    await kv.put("bpcfgoff", bpConfig(u, { showBadgesStremio: false }));
    const off = await call(env, "/bpcfgoff/catalog/series/continue-watching.json");
    assert.equal(off.status, 200);
    assert.equal(off.body.metas.length, 1);
    assert.ok(!String(off.body.metas[0].poster || "").includes("btttr.cc"));

    await kv.put("bpcfgon", bpConfig(u, { betterPosters: true, showBadgesStremio: false }));
    const on = await call(env, "/bpcfgon/catalog/series/continue-watching.json");
    assert.equal(on.status, 200);
    assert.equal(on.body.metas.length, 1);
    assert.equal(
      on.body.metas[0].poster,
      `https://btttr.cc/poster/imdb/poster-default/${SHOW}.jpg`
    );
  });

  it("passes the style options through to the URL", async () => {
    const kv = makeKv();
    const db = makeD1();
    const env = makeEnv({ CONFIGS: kv, DB: db });
    const u = "bpuser2";
    seedShow(db, u, SHOW);

    await kv.put("bpcfgstyle", bpConfig(u, {
      betterPosters: true,
      betterPostersGenre: false,
      betterPostersQuality: true,
      betterPostersTrendTags: false,
      betterPostersRatingSource: "IM",
      showBadgesStremio: false,
    }));
    const res = await call(env, "/bpcfgstyle/catalog/series/continue-watching.json");
    assert.equal(res.status, 200);
    assert.equal(
      res.body.metas[0].poster,
      `https://btttr.cc/poster-rq/imdb/poster-default/${SHOW}.jpg?tag=none&rs=IM`
    );
  });

  // The ordering that matters: a badge must be drawn OVER BetterPosters
  // artwork, not instead of it. If the two passes were swapped, the badge URL
  // would wrap the original poster and the BetterPosters art would vanish.
  it("lets a badge wrap the BetterPosters artwork rather than replace it", async () => {
    const kv = makeKv();
    const db = makeD1();
    const env = makeEnv({ CONFIGS: kv, DB: db });
    const u = "bpuser3";
    seedShow(db, u, SHOW);
    db.q(
      `INSERT INTO airing_next (username, show_id, item_id, name, show_title, season_num, episode_num, air_date, is_season_premiere, is_season_finale, season_finale_air_date, season_finale_episode_number, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      u, SHOW, `${SHOW}:2:1`, "Season 2 Premiere", "BP Show", 2, 1, "2027-02-15", 1, 0, "2027-05-10", 10, 9100
    );

    await kv.put("bpcfgboth", bpConfig(u, {
      betterPosters: true,
      showBadgesStremio: true,
      showBadgesStremioContinueWatching: true,
    }));
    const res = await call(env, "/bpcfgboth/catalog/series/continue-watching.json");
    assert.equal(res.status, 200);
    const poster = res.body.metas[0].poster;
    assert.ok(poster.includes("/api/poster-badge?"), "badge pass must still run");
    assert.ok(
      decodeURIComponent(poster).includes("btttr.cc/poster/imdb/poster-default/" + SHOW),
      "the badge must be layered over the BetterPosters URL"
    );
  });
});

// --- the website's own surfaces -------------------------------------------
// The Worker rewrites posters for Stremio/Nuvio; resolveClientPoster (19) does
// the same for every poster the website itself renders. These run the real
// client bundle -- see tests/client-harness.mjs.

const { loadClient } = await import("./client-harness.mjs");

const ON = { "myListAddon:betterPosters": "1" };
const movie = (extra = {}) => ({ id: "tt0111161", type: "movie", name: "Shawshank", poster: "orig.jpg", ...extra });

describe("Better Posters on the website", () => {
  it("leaves posters alone while the setting is off", () => {
    const c = loadClient();
    assert.equal(c.call("resolveClientPoster", movie(), "orig.jpg"), "orig.jpg");
  });

  it("swaps an IMDb-backed poster once the setting is on", () => {
    const c = loadClient({ storage: ON });
    assert.equal(
      c.call("resolveClientPoster", movie(), "orig.jpg"),
      "https://btttr.cc/poster/imdb/poster-default/tt0111161.jpg"
    );
  });

  it("builds the same URL the Worker does, including the style options", () => {
    const c = loadClient({ storage: {
      ...ON,
      "myListAddon:betterPostersGenre": "0",
      "myListAddon:betterPostersQuality": "1",
      "myListAddon:betterPostersTrendTags": "0",
      "myListAddon:betterPostersRatingSource": "IM",
    } });
    assert.equal(
      c.call("resolveClientPoster", movie(), "orig.jpg"),
      "https://btttr.cc/poster-rq/imdb/poster-default/tt0111161.jpg?tag=none&rs=IM"
    );
  });

  it("resolves a show from an episode id, and skips a TMDB-only item", () => {
    const c = loadClient({ storage: ON });
    assert.equal(
      c.call("resolveClientPoster", { id: "tt0903747:5:16", poster: "still.jpg" }, "still.jpg"),
      "https://btttr.cc/poster/imdb/poster-default/tt0903747.jpg"
    );
    assert.equal(c.call("resolveClientPoster", { id: "tmdb:550", poster: "keep.jpg" }, "keep.jpg"), "keep.jpg");
  });

  // Precedence has to match the Worker's: the filter runs first and returns.
  it("lets the Adult Content Filter override it", () => {
    const c = loadClient({ storage: { ...ON, "myListAddon:adultContentFilter": "1" } });
    const out = c.call("resolveClientPoster", movie({ isAdult: true }), "orig.jpg");
    assert.ok(out.includes("/api/safe-poster"), out);
    assert.ok(!out.includes("btttr.cc"), out);
  });

  it("never touches artwork the add-on generates itself", () => {
    const c = loadClient({ storage: ON });
    const keep = [
      "https://example.com/api/channel-poster?name=X",
      "https://example.com/api/channel-logo?path=/a.png",
      "https://example.com/api/poster-badge?poster=y&id=tt0111161",
    ];
    for (const p of keep) {
      assert.equal(c.call("resolveClientPoster", movie({ poster: p }), p), p);
    }
  });

  it("leaves a landscape tile and an episode still alone", () => {
    const c = loadClient({ storage: ON });
    assert.equal(
      c.call("resolveClientPoster", movie({ posterShape: "landscape" }), "wide.jpg"),
      "wide.jpg"
    );
    assert.equal(
      c.call("resolveClientPoster", { id: "tt0903747:1:2", thumbnail: "still.jpg" }, "still.jpg"),
      "still.jpg"
    );
  });

  it("rebuilds rather than stacking when handed its own URL back", () => {
    const c = loadClient({ storage: { ...ON, "myListAddon:betterPostersRating": "0" } });
    const once = c.call("resolveClientPoster", movie(), "orig.jpg");
    const twice = c.call("resolveClientPoster", movie(), once);
    assert.equal(once, "https://btttr.cc/poster-g/imdb/poster-default/tt0111161.jpg");
    assert.equal(twice, once);
  });
});

describe("Better Posters reaches the shared renderers", () => {
  it("renders through the Live Preview grid without mutating the item", () => {
    const c = loadClient({ storage: ON });
    const m = movie();
    const html = c.call("livePreviewPosterHtml", m);
    assert.ok(html.includes("https://btttr.cc/poster/imdb/poster-default/tt0111161.jpg"), html.slice(0, 300));
    // The original has to survive, or switching the setting back off would
    // have nothing to restore.
    assert.equal(m.poster, "orig.jpg");
  });

  it("renders through renderMediaCard, which used to short-circuit", () => {
    const c = loadClient({ storage: ON });
    const html = c.call("renderMediaCard", movie(), {});
    assert.ok(html.includes("https://btttr.cc/poster/imdb/poster-default/tt0111161.jpg"), html.slice(0, 300));
  });

  it("renderMediaCard still honours the Adult Content Filter", () => {
    const c = loadClient({ storage: { "myListAddon:adultContentFilter": "1" } });
    const html = c.call("renderMediaCard", movie({ isAdult: true }), {});
    assert.ok(html.includes("/api/safe-poster"), html.slice(0, 300));
  });
});

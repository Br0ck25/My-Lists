import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeKv, makeD1, makeEnv, call } from "./harness.mjs";

// A Watchlist entry wants the same premiere / finale / air-date chips a
// Continue Watching one gets: "this is on Tuesday" is exactly as useful for
// something you mean to start as for something you are part-way through.
//
// Three separate gates used to keep it out: the Airing Next data was only
// loaded for continue-watching, the lookup maps were only built for it, and
// the enrichment only ran for it.

const SHOW = "tt0903747";
const FUTURE = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);

function tracking(username, extra) {
  return JSON.stringify({
    watchlist: [{ id: SHOW, showId: SHOW, showTitle: "WL Show", name: "WL Show", type: "series", seasonNum: 4, episodeNum: 1 }],
    continueWatching: [],
    watchHistory: [],
    airingNext: [{
      id: SHOW, showId: SHOW, showTitle: "WL Show", name: "Premiere",
      type: "series", airDate: FUTURE, seasonNum: 4, episodeNum: 1, isSeasonPremiere: true,
    }],
    ...extra,
  });
}

async function serveWatchlist(cfg) {
  const kv = makeKv();
  const env = makeEnv({ CONFIGS: kv, DB: makeD1() });
  const u = "wluser";
  await kv.put("creatorsynctracking:" + u, tracking(u));
  await kv.put("wlcfg", JSON.stringify({
    trackCreatorName: u,
    entries: [{ id: "watchlist", type: "series", name: "Watchlist", url: `autotrack:watchlist:series:${u}` }],
    ...cfg,
  }));
  const res = await call(env, "/wlcfg/catalog/series/watchlist.json");
  assert.equal(res.status, 200);
  return res.body.metas || [];
}

describe("Watchlist carries the same badge data as Continue Watching", () => {
  it("enriches a watchlist entry with its upcoming air date and premiere flag", async () => {
    // Badges off so the raw enriched fields are visible rather than baked
    // into a /api/poster-badge URL.
    const metas = await serveWatchlist({ showBadgesStremio: false });
    assert.equal(metas.length, 1);
    assert.equal(metas[0].airDate, FUTURE, "the upcoming air date must reach the watchlist meta");
    assert.equal(metas[0].isSeasonPremiere, true, "and so must the season-premiere flag");
  });

  it("draws those chips onto the poster by default", async () => {
    const metas = await serveWatchlist({});
    const poster = metas[0].poster || "";
    assert.ok(poster.includes("/api/poster-badge?"), "the watchlist poster should be badged");
    assert.ok(poster.includes("airDate=" + FUTURE), poster);
    assert.ok(poster.includes("premiere=1"), poster);
  });

  it("respects the new Watchlist toggle", async () => {
    const metas = await serveWatchlist({ showBadgesStremioWatchlist: false });
    assert.ok(!(metas[0].poster || "").includes("/api/poster-badge?"),
      "turning the Watchlist overlay off must stop the badge");
  });

  it("still respects the master Stremio toggle", async () => {
    const metas = await serveWatchlist({ showBadgesStremio: false });
    assert.ok(!(metas[0].poster || "").includes("/api/poster-badge?"));
  });

  // The Watchlist toggle must not be the catalogs one in disguise.
  it("is independent of the catalogs toggle", async () => {
    const metas = await serveWatchlist({ showBadgesStremioCatalogs: false });
    assert.ok((metas[0].poster || "").includes("/api/poster-badge?"),
      "switching off other catalogs must leave the watchlist badged");
  });
});

// These toggles were absent from /api/save's allowlist on both sides, so
// turning any of them off never reached the install link: the setting looked
// saved and the badges kept appearing.
describe("badge toggles survive the /api/save install round trip", () => {
  const CUSTOM = "customlist:v1:" + JSON.stringify({
    listSlug: "wl", items: [{ id: SHOW, title: "T", year: "2008", type: "series" }],
  });

  async function saveAndRead(extra) {
    const kv = makeKv();
    const env = makeEnv({ CONFIGS: kv, DB: makeD1() });
    const saved = await call(env, "/api/save", { method: "POST", json: {
      entries: [{ id: "wl", type: "series", name: "L", url: CUSTOM }],
      ...extra,
    } });
    assert.equal(saved.body.ok, true, JSON.stringify(saved.body));
    return JSON.parse(await env.CONFIGS.get("cfg:" + saved.body.id));
  }

  it("stores each one when switched off", async () => {
    const stored = await saveAndRead({
      showBadgesStremio: false,
      showBadgesStremioAiringNext: false,
      showBadgesStremioContinueWatching: false,
      showBadgesStremioWatchlist: false,
      showBadgesStremioCatalogs: false,
    });
    for (const k of ["showBadgesStremio", "showBadgesStremioAiringNext", "showBadgesStremioContinueWatching",
                     "showBadgesStremioWatchlist", "showBadgesStremioCatalogs"]) {
      assert.equal(stored[k], false, k + " must survive the save");
    }
  });

  // Absent reads as ON, so an all-on config should not grow at all.
  it("stores nothing when they are all on", async () => {
    const stored = await saveAndRead({
      showBadgesStremio: true,
      showBadgesStremioWatchlist: true,
      showBadgesStremioCatalogs: true,
    });
    assert.ok(!("showBadgesStremio" in stored));
    assert.ok(!("showBadgesStremioWatchlist" in stored));
    assert.ok(!("showBadgesStremioCatalogs" in stored));
  });
});

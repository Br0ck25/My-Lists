import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeKv, makeD1, makeEnv, call } from "./harness.mjs";

// Airing Next is built from shows being WATCHED -- its candidate set comes out
// of Watch History -- so a show that has only ever been put on the Watchlist
// has never passed through it. That is exactly the show most likely to be
// premiering: added because it is coming, not because an episode has been
// seen. So the watchlist entries get their own upcoming-episode pass, stamped
// onto the entries themselves (refreshWatchlistAiring), which is what carries
// the chips to Live Preview, Stremio and Nuvio alike.

const SHOW = "tt9999001";
const MOVIE = "tt9999002";
const FUTURE = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
const PAST = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);

const { loadClient, requestsTo } = await import("./client-harness.mjs");

function seedLists(watchlistItems) {
  return {
    "myListAddon:localCustomLists": JSON.stringify({
      watchlist: { slug: "watchlist", name: "Watchlist", type: "mixed", items: watchlistItems, updatedAt: 1 },
    }),
  };
}

// The details payload /api/details(/batch) answers with for an upcoming
// season premiere, shaped as the real route shapes it.
function premiereDetails(extra = {}) {
  return {
    tmdbId: "4242",
    title: "WL Premiere Show",
    nextEpisodeAirDate: FUTURE,
    nextEpisodeSeasonNumber: 1,
    nextEpisodeNumber: 1,
    nextEpisodeName: "Pilot",
    nextEpisodeAirTimeLabel: "9 PM ET",
    ...extra,
  };
}

function batchRoute(results) {
  return { "/api/details/batch": () => ({ json: { ok: true, results, done: true } }) };
}

describe("Watchlist shows get their own upcoming-episode pass", () => {
  it("stamps the premiere, date and time onto a watchlist series entry", async () => {
    const c = loadClient({
      storage: seedLists([
        { id: SHOW, imdbId: SHOW, type: "series", name: "WL Premiere Show" },
      ]),
      routes: batchRoute({ [SHOW]: premiereDetails() }),
    });

    await c.call("refreshWatchlistAiring", true);

    const item = c.call("loadLocalCustomLists").watchlist.items[0];
    assert.equal(item.airDate, FUTURE, "the upcoming air date must land on the entry");
    assert.equal(item.isSeasonPremiere, true, "episode 1 is a season premiere");
    assert.equal(item.isUnaired, true);
    assert.equal(item.airTime, "9 PM ET", "the air time is what makes it a date AND time chip");
    assert.equal(item.seasonNum, 1);
    assert.equal(item.episodeNum, 1);
  });

  it("asks only about the series, never the movies on the list", async () => {
    const c = loadClient({
      storage: seedLists([
        { id: MOVIE, imdbId: MOVIE, type: "movie", name: "A Film" },
        { id: SHOW, imdbId: SHOW, type: "series", name: "WL Premiere Show" },
      ]),
      routes: batchRoute({ [SHOW]: premiereDetails() }),
    });

    await c.call("refreshWatchlistAiring", true);

    const sent = requestsTo(c, "/api/details/batch");
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].body.ids, [SHOW], "a movie has no next episode to ask about");
    assert.equal(sent[0].body.type, "series");
    const movie = c.call("loadLocalCustomLists").watchlist.items[0];
    assert.equal(movie.airDate, undefined, "and nothing should be stamped onto it");
  });

  it("does not request anything when the watchlist holds no series", async () => {
    const c = loadClient({
      storage: seedLists([{ id: MOVIE, imdbId: MOVIE, type: "movie", name: "A Film" }]),
      routes: {},
    });
    await c.call("refreshWatchlistAiring", true);
    assert.equal(c.requests.length, 0);
  });

  it("clears a stamp of its own once that episode has aired", async () => {
    const c = loadClient({
      storage: seedLists([{
        id: SHOW, imdbId: SHOW, type: "series", name: "WL Premiere Show",
        airDate: PAST, isSeasonPremiere: true, isUnaired: true, seasonNum: 1, episodeNum: 1,
      }]),
      // The show has nothing upcoming any more.
      routes: batchRoute({ [SHOW]: { tmdbId: "4242", title: "WL Premiere Show" } }),
    });

    await c.call("refreshWatchlistAiring", true);

    const item = c.call("loadLocalCustomLists").watchlist.items[0];
    assert.equal(item.airDate, undefined, "a premiere chip must not outlive the premiere");
    assert.equal(item.isSeasonPremiere, undefined);
    assert.equal(item.isUnaired, undefined);
  });

  it("leaves an entry it never stamped alone", async () => {
    // isUnaired is the marker refreshWatchlistAiring sets; without it the
    // entry's dates came in with an import and are not this function's to
    // delete.
    const c = loadClient({
      storage: seedLists([{
        id: SHOW, imdbId: SHOW, type: "series", name: "Imported Show", airDate: PAST,
      }]),
      routes: batchRoute({ [SHOW]: { tmdbId: "4242", title: "Imported Show" } }),
    });

    await c.call("refreshWatchlistAiring", true);

    const item = c.call("loadLocalCustomLists").watchlist.items[0];
    assert.equal(item.airDate, PAST, "an imported air date is not ours to remove");
  });

  it("makes the tracking signature change, so the account actually gets it", async () => {
    // The stamped fields move nothing listSig looks at -- not the length, not
    // the first or last id, not a watchedAt. Without watchlistAiringSig the
    // enriched copy would sit in the browser behind the unchanged-signature
    // guard until the ten-minute heartbeat, and the catalog the apps read
    // would keep serving chip-less tiles for that whole time.
    const c = loadClient({
      storage: seedLists([{ id: SHOW, imdbId: SHOW, type: "series", name: "WL Premiere Show" }]),
      routes: batchRoute({ [SHOW]: premiereDetails() }),
    });

    const before = c.call("trackingSyncSignature", c.call("loadLocalCustomLists"));
    await c.call("refreshWatchlistAiring", true);
    const after = c.call("trackingSyncSignature", c.call("loadLocalCustomLists"));

    assert.notEqual(before, after, "enriching the watchlist has to be visible to the sync guard");
  });

  it("keeps the air time and finale episode through storage compaction", async () => {
    // Both are stamped onto an entry deliberately, for a cold start that has
    // no per-show air-time store yet -- and both used to be dropped on the
    // way into localStorage, so the cold start never had them.
    const c = loadClient();
    const clean = c.call("compactCustomListItem", {
      id: SHOW, type: "series", name: "WL Premiere Show",
      airDate: FUTURE, airTime: "9 PM ET", seasonFinaleEpisodeNumber: 10,
    });
    assert.equal(clean.airTime, "9 PM ET");
    assert.equal(clean.seasonFinaleEpisodeNumber, 10);
  });
});

describe("Watchlist tiles render those chips in Live Preview", () => {
  const TILE = {
    id: SHOW, showId: SHOW, type: "series", name: "WL Premiere Show",
    listSlug: "watchlist", listName: "Watchlist", listUrl: "autotrack:watchlist:series:u",
    airDate: FUTURE, airTime: "9 PM ET", isSeasonPremiere: true, isUnaired: true,
    seasonNum: 1, episodeNum: 1, isLivePreviewShelf: true,
  };

  it("draws the season premiere and the air date", () => {
    const c = loadClient();
    const html = c.call("livePreviewPosterHtml", { ...TILE });
    assert.match(html, /Season Premiere/, html.slice(0, 400));
    assert.match(html, /cw-date-badge/, html.slice(0, 400));
  });

  it("drops them when the Watchlist badge setting is off", () => {
    const c = loadClient({ storage: { "myListAddon:showBadgesWatchlist": "0" } });
    const html = c.call("livePreviewPosterHtml", { ...TILE });
    assert.doesNotMatch(html, /Season Premiere/);
  });

  it("keeps them when only the Catalogs setting is off", () => {
    // The Watchlist shelf has a toggle of its own now; the catalogs one must
    // stop claiming it, the same way it already steps around the other two
    // tracked shelves.
    const c = loadClient({ storage: { "myListAddon:showBadgesCatalogs": "0" } });
    const html = c.call("livePreviewPosterHtml", { ...TILE });
    assert.match(html, /Season Premiere/);
  });
});

describe("Watchlist badge data reaches the apps from the entry itself", () => {
  it("badges a watchlist poster with nothing in Airing Next to match against", async () => {
    // The case that started this: a brand-new show, on the Watchlist only, so
    // Airing Next has never heard of it. Before refreshWatchlistAiring there
    // was no next-episode data for it anywhere.
    const kv = makeKv();
    const env = makeEnv({ CONFIGS: kv, DB: makeD1() });
    const u = "wlairing";
    await kv.put("creatorsynctracking:" + u, JSON.stringify({
      watchlist: [{
        id: SHOW, showId: SHOW, showTitle: "WL Premiere Show", name: "WL Premiere Show",
        type: "series", airDate: FUTURE, seasonNum: 1, episodeNum: 1,
        isSeasonPremiere: true, isUnaired: true,
      }],
      continueWatching: [], watchHistory: [], airingNext: [],
    }));
    await kv.put("wlairingcfg", JSON.stringify({
      trackCreatorName: u,
      entries: [{ id: "watchlist", type: "series", name: "Watchlist", url: `autotrack:watchlist:series:${u}` }],
    }));

    const res = await call(env, "/wlairingcfg/catalog/series/watchlist.json");
    assert.equal(res.status, 200);
    const poster = (res.body.metas || [])[0].poster || "";
    assert.ok(poster.includes("/api/poster-badge?"), poster);
    assert.ok(poster.includes("airDate=" + FUTURE), poster);
    assert.ok(poster.includes("premiere=1"), poster);
  });
});

describe("The badge settings panel", () => {
  it("offers a Watchlist toggle beside the other Website & Dashboard shelves", () => {
    const c = loadClient({ storage: { "myListAddon:showBadgesWatchlist": "0" } });
    // Wired by id, so the panel and initBadgeSettingsUI have to agree on it --
    // the checkbox existing in the HTML is not enough on its own.
    c.call("initBadgeSettingsUI");
    const el = c.__byId.get("badgeWatchlistCheckbox");
    assert.ok(el, "initBadgeSettingsUI must know the checkbox id");
    assert.equal(el.checked, false, "and must reflect the stored setting");
  });

  it("names Nuvio in every artwork-overlay label, not just Stremio", async () => {
    const { renderPage } = await import("./client-harness.mjs");
    const html = renderPage();
    for (const label of ["Airing Next Catalogs", "Continue Watching Catalogs", "Watchlist Catalogs"]) {
      assert.ok(html.includes(label + " in Stremio &amp; Nuvio"), label + " still says Stremio alone");
    }
    assert.ok(!html.includes("Airing Next (Dashboard &amp; My Lists)"), "the Airing Next label should no longer claim My Lists");
    assert.ok(html.includes("Airing Next (Dashboard)"));
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { loadClient } = await import("./client-harness.mjs");

const FUTURE = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
const PAST = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);

function withWatchlist(items) {
  return {
    "myListAddon:localCustomLists": JSON.stringify({
      watchlist: { slug: "watchlist", name: "Watchlist", type: "mixed", items, updatedAt: 1 },
    }),
  };
}

// What the card's remove button actually passes -- see buildLocalListCardHtml,
// which renders removeWatchlistItemDirect(imdbId || id).
const buttonArg = (it) => String(it.imdbId || it.id);

describe("Removing a watchlist item", () => {
  it("removes an entry whose id and imdbId disagree", () => {
    // The reported case. The button passes imdbId, the filter compared id, so
    // neither test matched: the tile animated away, nothing was written, the
    // count stayed at 1, and the next load brought it back.
    const item = { id: "tmdb:555", imdbId: "tt222", type: "series", name: "Split ids" };
    const c = loadClient({ storage: withWatchlist([item]) });
    c.call("removeWatchlistItemDirect", buttonArg(item), null);
    assert.deepEqual(c.call("loadLocalCustomLists").watchlist.items, []);
  });

  it("still removes the ordinary shapes", () => {
    for (const item of [
      { id: "tt111", imdbId: "tt111", type: "series", name: "Same" },
      { id: "tmdb:555", type: "series", name: "TMDB only" },
      { id: "tt333", tmdbId: "555", type: "series", name: "IMDb plus tmdbId" },
    ]) {
      const c = loadClient({ storage: withWatchlist([item]) });
      c.call("removeWatchlistItemDirect", buttonArg(item), null);
      assert.deepEqual(c.call("loadLocalCustomLists").watchlist.items, [], item.name);
    }
  });

  it("removes by showId too, which is how a series tile addresses itself", () => {
    const item = { id: "tt444:1:1", showId: "tt444", type: "series", name: "Episode-shaped" };
    const c = loadClient({ storage: withWatchlist([item]) });
    c.call("removeWatchlistItemDirect", "tt444", null);
    assert.deepEqual(c.call("loadLocalCustomLists").watchlist.items, []);
  });

  it("leaves every other entry where it is", () => {
    const target = { id: "tmdb:555", imdbId: "tt222", type: "series", name: "Going" };
    const keep = { id: "tt777", imdbId: "tt777", type: "movie", name: "Staying" };
    const c = loadClient({ storage: withWatchlist([target, keep]) });
    c.call("removeWatchlistItemDirect", buttonArg(target), null);
    const left = c.call("loadLocalCustomLists").watchlist.items;
    assert.equal(left.length, 1);
    assert.equal(left[0].name, "Staying");
  });
});

describe("Signing in does not strip the chips off a tracked entry", () => {
  // The account's copy is whatever was last pushed, so it is routinely
  // thinner than what this browser has already resolved. Both merges let the
  // server entry win wholesale, which is why the chips rendered and then
  // vanished a moment after sign-in, and stayed put while signed out.
  // The real function, called directly -- it was a closure inside
  // loadCreatorSync, which would have left this suite asserting against a
  // copy of the rules rather than the shipped ones.
  function carry(merged, local, keyOf) {
    const c = loadClient();
    const keyFn = c.get(keyOf === "show" ? "airingKeysForShow" : "airingKeysForItem");
    const carried = c.call("carryLocalAiringFields", merged, local, keyFn);
    return { merged, carried };
  }

  it("keeps season and episode out of the carried set", () => {
    // On Continue Watching those two say where the person is up to, which is
    // the account's to state, not this device's.
    const c = loadClient();
    const fields = c.get("TRACKING_AIRING_FIELDS");
    assert.ok(!fields.includes("seasonNum"), fields.join(","));
    assert.ok(!fields.includes("episodeNum"), fields.join(","));
    assert.ok(fields.includes("airDate") && fields.includes("airTime") && fields.includes("isSeasonPremiere"));
  });

  it("puts the upcoming date back onto a bare server entry", () => {
    const server = [{ id: "tt555", showId: "tt555", type: "series", name: "Show" }];
    const local = [{
      id: "tt555", showId: "tt555", type: "series", name: "Show",
      airDate: FUTURE, airTime: "9 PM ET", isSeasonPremiere: true, isUnaired: true,
    }];
    const { merged, carried } = carry(server, local, "show");
    assert.equal(carried, true);
    assert.equal(merged[0].airDate, FUTURE);
    assert.equal(merged[0].airTime, "9 PM ET");
    assert.equal(merged[0].isSeasonPremiere, true);
  });

  it("never resurrects a chip for an episode that has already aired", () => {
    const server = [{ id: "tt555", showId: "tt555", type: "series", name: "Show" }];
    const local = [{ id: "tt555", showId: "tt555", airDate: PAST, isSeasonPremiere: true, isUnaired: true }];
    const { merged, carried } = carry(server, local, "show");
    assert.equal(carried, false);
    assert.equal(merged[0].airDate, undefined);
  });

  it("leaves the account's own answer alone where it has one", () => {
    const server = [{ id: "tt555", showId: "tt555", airDate: FUTURE, airTime: "8 PM ET" }];
    const local = [{ id: "tt555", showId: "tt555", airDate: FUTURE, airTime: "MIDNIGHT" }];
    const { merged, carried } = carry(server, local, "show");
    assert.equal(carried, false);
    assert.equal(merged[0].airTime, "8 PM ET");
  });

  it("does not overwrite the episode the account says you are up to", () => {
    const server = [{ id: "tt555", showId: "tt555", seasonNum: 2, episodeNum: 4 }];
    const local = [{ id: "tt555", showId: "tt555", airDate: FUTURE, seasonNum: 9, episodeNum: 9, isUnaired: true }];
    const { merged } = carry(server, local, "show");
    assert.equal(merged[0].seasonNum, 2);
    assert.equal(merged[0].episodeNum, 4);
    assert.equal(merged[0].airDate, FUTURE, "but the date still arrives");
  });

  it("matches a watchlist entry by imdbId when the ids disagree", () => {
    const server = [{ id: "tmdb:555", imdbId: "tt222", type: "series", name: "Split ids" }];
    const local = [{ id: "tt222", imdbId: "tt222", airDate: FUTURE, isSeasonPremiere: true, isUnaired: true }];
    const { merged, carried } = carry(server, local, "item");
    assert.equal(carried, true);
    assert.equal(merged[0].airDate, FUTURE);
  });
});

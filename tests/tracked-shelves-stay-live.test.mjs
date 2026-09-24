import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeKv, makeD1, makeEnv, call, createUser } from "./harness.mjs";

// What Stremio and Nuvio show for an account's own shelves -- Watchlist,
// Continue Watching, Watch History, Airing Next, Recommended -- has to be what
// the account holds NOW. These are the ways it was not.

async function setup(name) {
  const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
  const user = await createUser(env, name);
  // A STORED config, the shape an install link points at: a base64 config is
  // caller-authored and never trusted to read a private shelf.
  const config = "cfg" + name.slice(0, 6);
  await env.CONFIGS.put(`cfg:${config}`, JSON.stringify({
    track: true,
    trackCreatorName: user.creatorName,
    trackCreatorKey: user.creatorKey,
    showBadgesStremio: false,
    entries: [
      { id: "wl", type: "movie", name: "Watchlist", url: `autotrack:watchlist:movie:${user.creatorName}` },
      { id: "wh", type: "movie", name: "Watch History", url: `autotrack:watch-history:movie:${user.creatorName}` },
    ],
  }));
  return { env, user, config };
}

const saveTracking = (env, user, body) => call(env, "/api/creator/sync/save-tracking", {
  method: "POST",
  json: { creatorName: user.creatorName, creatorKey: user.creatorKey, ...body },
});

const shelf = async (env, config, id, type = "movie") =>
  ((await call(env, `/${config}/catalog/${type}/${id}.json`)).body.metas || []).map((m) => m.id);

describe("the Watchlist row survives playback", () => {
  it("still lists the watchlist after something ELSE is played in Stremio", async () => {
    const { env, user, config } = await setup("wlplay");
    const saved = await saveTracking(env, user, {
      watchlist: [{ id: "tt0000500", type: "movie", name: "Five Hundred" }, { id: "tt0000600", type: "movie", name: "Six Hundred" }],
      watchlistUpdatedAt: Date.now(),
    });
    assert.equal(saved.body.ok, true);
    assert.deepEqual((await shelf(env, config, "wl")).sort(), ["tt0000500", "tt0000600"]);

    // A playback ping for a movie that is NOT on the watchlist.
    await call(env, `/${config}/subtitles/movie/tt0000111.json`);

    assert.deepEqual((await shelf(env, config, "wl")).sort(), ["tt0000500", "tt0000600"],
      "playing an unrelated title must not empty the Watchlist row");
  });

  it("drops only the title that was played", async () => {
    const { env, user, config } = await setup("wlplay2");
    await saveTracking(env, user, {
      watchlist: [{ id: "tt0000500", type: "movie", name: "Five Hundred" }, { id: "tt0000600", type: "movie", name: "Six Hundred" }],
      watchlistUpdatedAt: Date.now(),
    });
    await call(env, `/${config}/subtitles/movie/tt0000500.json`);
    assert.deepEqual(await shelf(env, config, "wl"), ["tt0000600"]);
  });
});

describe("a Watchlist that an earlier play already emptied comes back", () => {
  // Accounts that played something before this fix are carrying a tracking
  // record whose Watchlist is empty and unstamped. The saved list record never
  // lost it, and is what both the apps and the website now read.
  async function emptiedAccount(name) {
    const ctx = await setup(name);
    await saveTracking(ctx.env, ctx.user, {
      watchlist: [{ id: "tt0000500", type: "movie", name: "Five Hundred" }],
      watchlistUpdatedAt: Date.now(),
    });
    const key = `creatorsynctracking:${ctx.user.creatorName}`;
    const blob = JSON.parse(await ctx.env.CONFIGS.get(key));
    blob.watchlist = [];
    delete blob.watchlistUpdatedAt;
    await ctx.env.CONFIGS.put(key, JSON.stringify(blob));
    return ctx;
  }

  it("in the Stremio/Nuvio row", async () => {
    const { env, config } = await emptiedAccount("wlheal1");
    assert.deepEqual(await shelf(env, config, "wl"), ["tt0000500"]);
  });

  it("on the website", async () => {
    const { env, user } = await emptiedAccount("wlheal2");
    const loaded = await call(env, "/api/creator/sync/load", {
      method: "POST", json: { creatorName: user.creatorName, creatorKey: user.creatorKey },
    });
    assert.equal(loaded.body.ok, true);
    assert.deepEqual(loaded.body.data.watchlist.map((it) => it.id), ["tt0000500"]);
  });

  it("and the next play writes it back instead of an empty one", async () => {
    const { env, user, config } = await emptiedAccount("wlheal3");
    await call(env, `/${config}/subtitles/movie/tt0000111.json`);
    const blob = JSON.parse(await env.CONFIGS.get(`creatorsynctracking:${user.creatorName}`));
    assert.deepEqual(blob.watchlist.map((it) => it.id), ["tt0000500"]);
  });
});

describe("the apps never serve D1 rows that a failed write left behind", () => {
  const movie = (id, at) => ({ id, type: "movie", name: "Movie " + id, watchedAt: at });

  it("serves the saved Watch History while D1 is behind, and D1 again once it catches up", async () => {
    const { env, user, config } = await setup("d1behind");
    const first = await saveTracking(env, user, { watchHistory: [movie("tt0000701", 1000)] });
    assert.equal(first.body.ok, true);
    assert.deepEqual(await shelf(env, config, "wh"), ["tt0000701"]);

    // The next save lands in KV but its D1 rows do not.
    env.DB.failWhen((sql) => /INSERT INTO watch_history/.test(sql));
    const second = await saveTracking(env, user, {
      watchHistory: [movie("tt0000702", 2000), movie("tt0000701", 1000)],
      expectedClientVersion: first.body.clientVersion,
    });
    assert.equal(second.body.ok, false, "the failed D1 write is reported");
    assert.deepEqual(await shelf(env, config, "wh"), ["tt0000702", "tt0000701"],
      "the row shows the save that reached KV, not the rows D1 was left with");

    // And the stamp D1 compares against was not advanced by the half-write.
    const meta = env.DB._db.prepare("SELECT updated_at FROM creator_tracking_meta WHERE username = ?").get(user.creatorName);
    const kvStamp = JSON.parse(await env.CONFIGS.get(`creatorsynctracking:${user.creatorName}`)).updatedAt;
    assert.ok(Number(meta.updated_at) < kvStamp, "D1 must read as behind after a write that did not finish");

    env.DB.failWhen(null);
    // No version: the failed save still moved it in KV, and a browser would
    // reload before retrying -- which is not what this test is about.
    const third = await saveTracking(env, user, {
      watchHistory: [movie("tt0000702", 2000), movie("tt0000701", 1000)],
    });
    assert.equal(third.body.ok, true);
    assert.equal(await env.CONFIGS.get(`trackingd1behind:${user.creatorName}`), null, "a good write clears the marker");
    assert.deepEqual(await shelf(env, config, "wh"), ["tt0000702", "tt0000701"]);
  });
});

describe("rows that are one account's live state are never cached", () => {
  it("sends Recommended, and a merged row with a personal shelf in it, no-store", async () => {
    const { env, user } = await setup("nocache");
    await env.CONFIGS.put("cfg:nocache1", JSON.stringify({
      trackCreatorName: user.creatorName, trackCreatorKey: user.creatorKey, showBadgesStremio: false,
      entries: [
        { id: "recs", type: "movie", name: "Recommended Movies", url: "custom:curated:movies" },
        { id: "mix", type: "movie", name: "Mix", url: `tmdb:chart:popular:movie\nautotrack:watchlist:movie:${user.creatorName}` },
      ],
    }));
    for (const id of ["recs", "mix"]) {
      const res = await call(env, `/nocache1/catalog/movie/${id}.json`);
      assert.match(res.headers.get("Cache-Control") || "", /no-store/, `${id} must not be cached`);
    }
  });
});

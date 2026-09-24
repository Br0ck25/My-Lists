import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { makeKv, makeD1, makeEnv, call, createUser, runScheduledTick } from "./harness.mjs";

// Airing Next and Recommended are built by the website and pushed up as
// snapshots. Someone who used only Stremio or Nuvio for a while kept seeing
// the last snapshot indefinitely -- aired episodes still listed as coming,
// Recommended frozen at whatever Discover last showed. These cover the server
// keeping both current on its own.

const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

// Nothing here may reach the network: the cron's other tasks (chart pre-warm,
// New on Streaming) fail fast instead of hanging, and a test that wants TMDB
// installs its own answers.
const realFetch = globalThis.fetch;
let tmdb = null;
globalThis.fetch = async (input) => {
  const url = typeof input === "string" ? input : input.url;
  if (tmdb) {
    const body = tmdb(url);
    if (body && body.__status) return new Response("{}", { status: body.__status, headers: { "Content-Type": "application/json" } });
    if (body !== undefined) return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  }
  throw new TypeError("offline in tests: " + url);
};
after(() => { globalThis.fetch = realFetch; });

async function setup(name) {
  const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1(), TMDB_API_KEY: "test-tmdb-key" });
  const user = await createUser(env, name);
  const config = "cfg" + name.slice(0, 7);
  await env.CONFIGS.put(`cfg:${config}`, JSON.stringify({
    track: true,
    trackCreatorName: user.creatorName,
    trackCreatorKey: user.creatorKey,
    showBadgesStremio: false,
    entries: [
      { id: "an", type: "series", name: "Airing Next", url: `autotrack:airing-next:series:${user.creatorName}` },
      { id: "recm", type: "movie", name: "Recommended Movies", url: "custom:curated:recommended-movies" },
    ],
  }));
  return { env, user, config };
}

const saveTracking = (env, user, body) => call(env, "/api/creator/sync/save-tracking", {
  method: "POST",
  json: { creatorName: user.creatorName, creatorKey: user.creatorKey, ...body },
});

const shelf = async (env, config, id, type) =>
  ((await call(env, `/${config}/catalog/${type}/${id}.json`)).body.metas || []).map((m) => m.id);

const record = async (env, user) => JSON.parse(await env.CONFIGS.get(`creatorsynctracking:${user.creatorName}`));

const watchedEp = (showId, s, e, title) => ({
  id: `${showId}:${s}:${e}`, type: "episode", showId, showTitle: title, seasonNum: s, episodeNum: e, watchedAt: Date.now() - 864e5,
});

// What the details lookup would return for a show with an episode coming,
// primed into its cache so the sweep needs no network.
function primeNextEpisode(env, showId, { airDate, season, episode, name, tmdbId }) {
  return env.CONFIGS.put(`cache:tmdb:itemdetails:v3:${showId}:series:US`, JSON.stringify({
    data: {
      id: showId, tmdbId, title: "Show " + showId, poster: "",
      nextEpisodeAirDate: airDate, nextEpisodeSeasonNumber: season, nextEpisodeNumber: episode, nextEpisodeName: name,
    },
    freshUntil: Date.now() + 3600e3,
  }));
}

describe("Airing Next stays current without the website", () => {
  it("drops an episode that has already aired from the row, even before anything rebuilds it", async () => {
    const { env, user, config } = await setup("anread");
    await saveTracking(env, user, {
      airingNext: [
        { id: "tt0901101", showId: "tt0901101", type: "series", showTitle: "Aired", airDate: day(-4), seasonNum: 1, episodeNum: 2 },
        { id: "tt0901102", showId: "tt0901102", type: "series", showTitle: "Coming", airDate: day(3), seasonNum: 1, episodeNum: 5 },
      ],
    });
    assert.deepEqual(await shelf(env, config, "an", "series"), ["tt0901102"]);
  });

  it("is rebuilt by the cron from what the account has watched", async () => {
    const { env, user, config } = await setup("answeep");
    // The last snapshot the website pushed: one show, an episode that aired
    // days ago. A second show has been watched since (in Stremio, say) and
    // never made it onto the shelf.
    await saveTracking(env, user, {
      watchHistory: [watchedEp("tt0901201", 1, 1, "Show A"), watchedEp("tt0901202", 2, 3, "Show B")],
      airingNext: [{ id: "tt0901201", showId: "tt0901201", type: "series", showTitle: "Show A", airDate: day(-5), seasonNum: 1, episodeNum: 2 }],
    });
    await primeNextEpisode(env, "tt0901201", { airDate: day(10), season: 1, episode: 3, name: "Three", tmdbId: 7201 });
    await primeNextEpisode(env, "tt0901202", { airDate: day(2), season: 2, episode: 4, name: "Four", tmdbId: 7202 });

    await runScheduledTick(env);

    const an = (await record(env, user)).airingNext;
    assert.deepEqual(an.map((it) => [it.showId, it.airDate, it.seasonNum, it.episodeNum]), [
      ["tt0901202", day(2), 2, 4],
      ["tt0901201", day(10), 1, 3],
    ], "both shows, their real next episodes, soonest first");
    assert.equal(an[1].showTitle, "Show A", "the title Watch History knows wins, as on the website");
    assert.deepEqual(await shelf(env, config, "an", "series"), ["tt0901202", "tt0901201"],
      "and the row serves it -- D1 included");
    assert.ok(await env.CONFIGS.get(`airingnextchecked:${user.creatorName}`), "not due again for a while");
  });

  it("leaves off a show taken off Airing Next, as the website does", async () => {
    const { env, user } = await setup("anremoved");
    await saveTracking(env, user, {
      watchHistory: [watchedEp("tt0901301", 1, 4, "Kept"), watchedEp("tt0901302", 1, 1, "Removed")],
      removedAiringNext: { tt0901302: { seasonNum: 1, episodeNum: 1 } },
    });
    await primeNextEpisode(env, "tt0901301", { airDate: day(4), season: 1, episode: 5, name: "Five", tmdbId: 7301 });
    await primeNextEpisode(env, "tt0901302", { airDate: day(4), season: 1, episode: 2, name: "Two", tmdbId: 7302 });
    await runScheduledTick(env);
    assert.deepEqual((await record(env, user)).airingNext.map((it) => it.showId), ["tt0901301"]);
  });

  it("keeps everything else on the record exactly as it was", async () => {
    const { env, user } = await setup("ankeep");
    await saveTracking(env, user, {
      watchHistory: [watchedEp("tt0901401", 1, 1, "Only")],
      watchlist: [{ id: "tt0000777", type: "movie", name: "Keep me" }],
      watchlistUpdatedAt: Date.now(),
    });
    await primeNextEpisode(env, "tt0901401", { airDate: day(6), season: 1, episode: 2, name: "Two", tmdbId: 7401 });
    const before = await record(env, user);
    await runScheduledTick(env);
    const afterRec = await record(env, user);
    assert.deepEqual(afterRec.watchlist, before.watchlist);
    assert.deepEqual(afterRec.watchHistory, before.watchHistory);
    assert.equal(afterRec.clientVersion, before.clientVersion, "a cron write is not a browser save -- no conflict for the next one");
    assert.equal(afterRec.airingNext.length, 1);
  });
});

describe("an outage does not empty Airing Next", () => {
  it("keeps a show's entry when its lookup fails, instead of reading that as nothing coming", async () => {
    const { env, user } = await setup("anoutage");
    await saveTracking(env, user, {
      watchHistory: [watchedEp("tt0901501", 1, 1, "Unreachable")],
      airingNext: [{ id: "tt0901501", showId: "tt0901501", type: "series", showTitle: "Unreachable", airDate: day(5), seasonNum: 1, episodeNum: 2 }],
    });
    // Nothing primed, and TMDB answering with errors -- a rate limit, an
    // outage. The lookup comes back empty-handed rather than throwing.
    tmdb = (url) => (url.includes("api.themoviedb.org") ? { __status: 503 } : undefined);
    try {
      await runScheduledTick(env);
    } finally { tmdb = null; }
    assert.deepEqual((await record(env, user)).airingNext.map((it) => [it.showId, it.airDate]), [["tt0901501", day(5)]]);
  });
});

describe("Recommended stays current without the website", () => {
  // TMDB for a movie watched since Discover was last opened.
  const tmdbForSeed = (url) => {
    if (url.includes("/3/find/tt0000900")) return { movie_results: [{ id: 900 }] };
    if (url.includes("/3/movie/900/recommendations")) {
      return { results: Array.from({ length: 12 }, (_, i) => ({ id: 8000 + i, title: "Rec " + i, poster_path: "/p.jpg", release_date: "2020-01-01" })) };
    }
    if (url.includes("/external_ids")) return {};
    if (url.includes("/trending/")) return { results: [] };
    return undefined;
  };

  async function withSnapshot(name, ageMs) {
    const ctx = await setup(name);
    await saveTracking(ctx.env, ctx.user, {
      watchHistory: [{ id: "tt0000900", type: "movie", name: "Seed", watchedAt: Date.now() }],
      curatedRecommendations: {
        movies: [{ id: "tmdb:5555", tmdbId: "5555", name: "From Discover" }],
        shows: [],
        updatedAt: Date.now() - ageMs,
      },
    });
    return ctx;
  }

  it("serves the Discover snapshot while the website keeps it current", async () => {
    const { env, config } = await withSnapshot("recfresh", 3600e3);
    tmdb = tmdbForSeed;
    try {
      assert.deepEqual(await shelf(env, config, "recm", "movie"), ["tmdb:5555"]);
    } finally { tmdb = null; }
  });

  it("builds its own from the account's viewing once the snapshot is days old", async () => {
    const { env, config } = await withSnapshot("recstale", 5 * 864e5);
    tmdb = tmdbForSeed;
    try {
      const ids = await shelf(env, config, "recm", "movie");
      assert.ok(ids.includes("tmdb:8000"), "recommendations for what has been watched");
      assert.ok(!ids.includes("tmdb:5555"), "not the abandoned snapshot");
    } finally { tmdb = null; }
  });

  it("falls back to the old snapshot rather than nothing when there is nothing to build from", async () => {
    const { env, config } = await withSnapshot("recnothing", 5 * 864e5);
    tmdb = (url) => (url.includes("/external_ids") ? {} : undefined);   // TMDB down otherwise
    try {
      assert.deepEqual(await shelf(env, config, "recm", "movie"), ["tmdb:5555"]);
    } finally { tmdb = null; }
  });

  it("builds the same list /api/recommendations gives the website", async () => {
    const { env } = await setup("recroute");
    tmdb = tmdbForSeed;
    try {
      const r = await call(env, "/api/recommendations", { method: "POST", json: { movieIds: ["tt0000900"], showIds: [] } });
      assert.equal(r.body.ok, true);
      assert.deepEqual(r.body.movies.slice(0, 2).map((m) => m.id), ["tmdb:8000", "tmdb:8001"]);
      assert.deepEqual(r.body.shows, []);
    } finally { tmdb = null; }
  });
});

describe("the website re-stamps an unchanged Discover snapshot", async () => {
  const { loadClient } = await import("./client-harness.mjs");
  const KEY = "myListAddon:curatedRecommendations";
  const movies = [{ id: "tmdb:1", tmdbId: "1", name: "One" }];
  const stored = (c) => JSON.parse(c.get("localStorage").getItem(KEY));

  it("leaves a recently stamped, unchanged list alone", () => {
    const at = Date.now() - 3600e3;
    const c = loadClient({ storage: { [KEY]: JSON.stringify({ movies, shows: [], updatedAt: at }) } });
    c.call("persistCuratedRecommendations", movies, []);
    assert.equal(stored(c).updatedAt, at, "no write, no push, for a list shown an hour ago");
  });

  it("re-stamps an unchanged list once it is half a day old, so the row does not judge it abandoned", () => {
    const at = Date.now() - 13 * 3600e3;
    const c = loadClient({ storage: { [KEY]: JSON.stringify({ movies, shows: [], updatedAt: at }) } });
    c.call("persistCuratedRecommendations", movies, []);
    assert.ok(stored(c).updatedAt > at);
  });
});

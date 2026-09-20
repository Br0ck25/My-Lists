import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeEnv, makeKv, call, runScheduledTick } from "./harness.mjs";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// A Quick Add network channel used to have no real cap: quickAddChannel's
// preset check compared the server's (capped-at-200) preset against
// CHANNEL_POOL_MAX_ITEMS (5000), which a preset can never reach, so every
// click fell through to a client-built pool with no cap of its own -- see
// CHANGELOG "New on Streaming" sibling entry and 20_client-channel-builder.js
// for the full story. These tests cover the server half of the fix: the
// shared preset builder (buildNetworkChannelPreset,
// 07_source-fetchers-tmdb-simkl.js), its KV cache, and the daily cron
// prewarm that is meant to keep a Quick Add click from ever paying for a
// live TMDB build.

// Blocks every OTHER outbound host instead of passing it through to a real
// fetch: a full cron tick (runScheduledTick) also touches Trakt/Simkl/MDBList
// pre-warming, and letting those go out for real turns each test into a
// multi-second wait on network I/O nothing here is testing. Every fetcher in
// this codebase already treats a failed/rejected fetch as "nothing to warm
// this tick" (see sweepNewOnStreaming's own try/catch around each page), so
// rejecting instantly is both faster and a closer match to "not configured"
// than a real timeout would be.
function stubTmdb(handler) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("api.themoviedb.org")) {
      calls.push(u);
      const resData = handler(u);
      if (resData === null) return new Response("Not Found", { status: 404 });
      return new Response(JSON.stringify(resData), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error("network disabled in test: " + u);
  };
  return { restore: () => { globalThis.fetch = realFetch; }, calls };
}

// Two shows, one season each, two episodes each -- enough to prove a real
// build happened (name, season/episode numbers, imdb id) without a large
// fixture. Works for any networkId/showId, since the cron sweep exercises
// several different ones and none of this depends on which was asked for.
function smallNetworkHandler(u) {
  if (u.includes("/discover/tv")) {
    return { results: [{ id: 501 }, { id: 502 }] };
  }
  if (u.includes("/network/")) {
    return { logo_path: "/logo.png" };
  }
  const showMatch = u.match(/\/tv\/(\d+)\?/);
  if (showMatch && !u.includes("/season/")) {
    const id = showMatch[1];
    return {
      id: Number(id),
      name: "Show " + id,
      poster_path: "/poster" + id + ".jpg",
      backdrop_path: "/backdrop" + id + ".jpg",
      external_ids: { imdb_id: "tt" + id },
      seasons: [{ season_number: 1 }],
    };
  }
  const seasonMatch = u.match(/\/tv\/(\d+)\/season\/(\d+)\?/);
  if (seasonMatch) {
    const id = seasonMatch[1];
    return {
      episodes: [
        { episode_number: 1, name: "Pilot", air_date: "2024-01-01", still_path: "/s1e1.jpg" },
        { episode_number: 2, name: "Episode 2", air_date: "2024-01-08", still_path: "/s1e2.jpg" },
      ],
    };
  }
  return { results: [] };
}

describe("/api/channel-preset", () => {
  it("serves a warm cache with no TMDB fetch at all", async () => {
    const kv = makeKv();
    const env = makeEnv({ CONFIGS: kv, TMDB_API_KEY: "test-tmdb-key" });
    const seeded = {
      name: "A&E",
      poster: null,
      backdrop: null,
      items: [{ kind: "episode", imdbId: "tt129", season: 1, episode: 1, showName: "Seeded Show", epName: "Ep", title: "t", released: "2024-01-01", thumbnail: "", poster: "", showPoster: "" }],
      shuffle: false,
      dailyRotate: true,
    };
    await kv.put("channel:preset:v2:129", JSON.stringify(seeded));

    const stub = stubTmdb(() => {
      throw new Error("must not hit TMDB when the cache is warm");
    });
    try {
      const res = await call(env, "/api/channel-preset?networkId=129&name=" + encodeURIComponent("A&E"));
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true, res.body.error);
      assert.deepEqual(res.body.channel.items.map((it) => it.showName), ["Seeded Show"]);
      assert.equal(stub.calls.length, 0, "a warm cache must not touch TMDB");
    } finally {
      stub.restore();
    }
  });

  it("builds and caches a preset on a cold cache, capped well under a config's size limit", async () => {
    const kv = makeKv();
    const env = makeEnv({ CONFIGS: kv, TMDB_API_KEY: "test-tmdb-key" });
    const stub = stubTmdb(smallNetworkHandler);
    try {
      const res = await call(env, "/api/channel-preset?networkId=16&name=" + encodeURIComponent("CBS"));
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true, res.body.error);
      // 2 shows x 1 season x 2 episodes from the stub above.
      assert.equal(res.body.channel.items.length, 4);
      assert.ok(res.body.channel.items.every((it) => it.showName && it.imdbId), "each item must carry real show identity");

      const cachedRaw = await kv.get("channel:preset:v2:16");
      assert.ok(cachedRaw, "a cold build must populate the cache for next time");
      const cached = JSON.parse(cachedRaw);
      assert.equal(cached.items.length, 4);
    } finally {
      stub.restore();
    }
  });

  it("keeps building instead of failing when TMDB's own network discover comes back empty for a known fallback network", async () => {
    const kv = makeKv();
    const env = makeEnv({ CONFIGS: kv, TMDB_API_KEY: "test-tmdb-key" });
    const stub = stubTmdb((u) => {
      if (u.includes("/discover/tv")) return { results: [] };
      return smallNetworkHandler(u);
    });
    try {
      const res = await call(env, "/api/channel-preset?networkId=738&name=" + encodeURIComponent("MeTV"));
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true, res.body.error);
      assert.ok(res.body.channel.items.length > 0, "MeTV's hand-picked fallback shows must still produce episodes");
    } finally {
      stub.restore();
    }
  });
});

describe("daily channel preset prewarm (cron)", () => {
  it("refreshes one network per tick and advances the rotation cursor", async () => {
    const kv = makeKv();
    const env = makeEnv({ CONFIGS: kv, TMDB_API_KEY: "test-tmdb-key" });
    const stub = stubTmdb(smallNetworkHandler);
    try {
      await runScheduledTick(env);
      // Cursor starts at 0 -> CHANNEL_PRESET_NETWORKS[0] is A&E, networkId "129"
      // (00_constants.js) -- first in the same order as the Quick Add buttons.
      const cached = await kv.get("channel:preset:v2:129");
      assert.ok(cached, "the first tick must warm the first network in the list");
      assert.equal(JSON.parse(cached).items.length, 4);

      const cursor = await kv.get("cron:channelpresets:cursor");
      assert.equal(cursor, "1", "the cursor must advance so the next tick warms a different network");
    } finally {
      stub.restore();
    }
  });

  it("walks a different network on each successive tick", async () => {
    const kv = makeKv();
    const env = makeEnv({ CONFIGS: kv, TMDB_API_KEY: "test-tmdb-key" });
    const stub = stubTmdb(smallNetworkHandler);
    try {
      await runScheduledTick(env);
      await runScheduledTick(env);
      await runScheduledTick(env);
      // A&E (129), ABC (2), Adult Swim (80) -- the first three entries in
      // CHANNEL_PRESET_NETWORKS (00_constants.js), in order.
      assert.ok(await kv.get("channel:preset:v2:129"), "network 1 must be warm");
      assert.ok(await kv.get("channel:preset:v2:2"), "network 2 must be warm");
      assert.ok(await kv.get("channel:preset:v2:80"), "network 3 must be warm");
      assert.equal(await kv.get("cron:channelpresets:cursor"), "3");
    } finally {
      stub.restore();
    }
  });

  it("a Quick Add click after the prewarm ran is served from cache, making no live TMDB requests", async () => {
    const kv = makeKv();
    const env = makeEnv({ CONFIGS: kv, TMDB_API_KEY: "test-tmdb-key" });
    const warmStub = stubTmdb(smallNetworkHandler);
    try {
      await runScheduledTick(env);
    } finally {
      warmStub.restore();
    }

    const clickStub = stubTmdb(() => {
      throw new Error("Quick Add must not need a live TMDB build once the daily prewarm has run");
    });
    try {
      const res = await call(env, "/api/channel-preset?networkId=129&name=" + encodeURIComponent("A&E"));
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true, res.body.error);
      assert.equal(res.body.channel.items.length, 4);
      assert.equal(clickStub.calls.length, 0);
    } finally {
      clickStub.restore();
    }
  });
});

describe("quickAddChannel's cached-preset gate (client)", () => {
  // The bug itself, guarded directly against the source: quickAddChannel
  // used to require the server's preset to have >= CHANNEL_POOL_MAX_ITEMS
  // (5000) items before using it, which a preset (capped at 200 on the
  // server, on purpose) could never satisfy -- so this comparison was
  // always false and every Quick Add click fell through to building a
  // channel live in the browser with no cap of its own. A regression here
  // would silently reopen the exact "10 quick-add channels -> config too
  // large to save" bug this whole file is about, without the cron/route
  // tests above ever seeing it, since they exercise the server side only.
  it("no longer requires an impossible 5000 items before using the cached preset", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, "20_client-channel-builder.js"), "utf8");
    assert.match(
      src,
      /data\.channel\.items\.length >= CHANNEL_PRESET_MIN_ITEMS/,
      "quickAddChannel must gate on CHANNEL_PRESET_MIN_ITEMS, not the old unreachable threshold"
    );
    assert.doesNotMatch(
      src,
      /data\.channel\.items\.length >= CHANNEL_POOL_MAX_ITEMS/,
      "the old unreachable gate (>= CHANNEL_POOL_MAX_ITEMS, 5000) must not come back"
    );
  });
});

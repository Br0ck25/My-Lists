import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { makeEnv, makeKv, call, runScheduledTick } from "./harness.mjs";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Same technique as worker.test.mjs's own loadSourceFunctions: the files
// share one sandbox so a function in 05_ that calls one declared in 07_ (as
// channelSourceItems now calls buildNetworkChannelPreset) can see it, the
// same way it does once all sources are concatenated into the real Worker.
// No `fetch` in this sandbox on purpose -- these tests pre-seed the KV cache
// so a correct resolution never needs one, and an accidental live TMDB call
// fails loudly (ReferenceError) instead of silently reaching the network.
function loadSourceFunctions(...relFiles) {
  const sandbox = {
    console, URL, URLSearchParams, atob, btoa, Uint8Array, TextDecoder, TextEncoder,
    crypto: globalThis.crypto,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const relFile of relFiles) {
    const src = fs.readFileSync(path.join(REPO_ROOT, relFile), "utf8");
    vm.runInContext(src, sandbox, { filename: relFile });
  }
  return sandbox;
}

function makeFakeConfigs(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, val) { store.set(key, typeof val === "string" ? val : JSON.stringify(val)); },
    _store: store,
  };
}

// The real network ids don't matter for the size-regression test below --
// only that there are ten distinct pointer rows and none of them carry a pool.
const CHANNEL_PRESET_NETWORK_IDS_FOR_TEST = ["129", "2", "80", "174", "4", "56", "16", "47", "64", "54"];

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

  it("pulls from multiple discover pages and is no longer capped at 200 episodes", async () => {
    const kv = makeKv();
    const env = makeEnv({ CONFIGS: kv, TMDB_API_KEY: "test-tmdb-key" });
    const discoverPages = new Set();
    // 3 discover pages x 20 shows x 1 season x 10 episodes = 600 possible
    // episodes -- well past the old 200 cap, but under CHANNEL_POOL_MAX_ITEMS
    // (5,000), so a correct build pulls every last one of them rather than
    // stopping early at either boundary.
    const stub = stubTmdb((u) => {
      if (u.includes("/discover/tv")) {
        const pageMatch = u.match(/[?&]page=(\d+)/);
        const page = pageMatch ? Number(pageMatch[1]) : 1;
        discoverPages.add(page);
        if (page > 3) return { results: [], total_pages: 3 };
        const results = Array.from({ length: 20 }, (_, i) => ({ id: (page - 1) * 20 + i + 1 }));
        return { results, total_pages: 3 };
      }
      if (u.includes("/network/")) return { logo_path: "/logo.png" };
      const showMatch = u.match(/\/tv\/(\d+)\?/);
      if (showMatch && !u.includes("/season/")) {
        const id = showMatch[1];
        return {
          id: Number(id),
          name: "Show " + id,
          poster_path: "/p" + id + ".jpg",
          backdrop_path: "/b" + id + ".jpg",
          external_ids: { imdb_id: "tt" + id },
          seasons: [{ season_number: 1 }],
        };
      }
      const seasonMatch = u.match(/\/tv\/(\d+)\/season\/(\d+)\?/);
      if (seasonMatch) {
        const id = seasonMatch[1];
        return {
          episodes: Array.from({ length: 10 }, (_, i) => ({
            episode_number: i + 1,
            name: "Ep " + (i + 1),
            air_date: "2024-01-01",
            still_path: "/s" + id + "e" + (i + 1) + ".jpg",
          })),
        };
      }
      return { results: [] };
    });

    try {
      const res = await call(env, "/api/channel-preset?networkId=6&name=" + encodeURIComponent("NBC"));
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true, res.body.error);
      assert.equal(res.body.channel.items.length, 600, "must pull the full pool, not stop at the old 200-item cap");
      assert.ok(discoverPages.has(2) && discoverPages.has(3), "must walk more than a single discover page");
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
  // (5000) items before using it. Back when the server capped a preset at
  // 200 that comparison could never be satisfied; now that the server's own
  // pool can genuinely reach 5000, the two numbers could coincidentally
  // match again by accident -- so this still has to compare against a real,
  // reachable bar (CHANNEL_PRESET_MIN_ITEMS), not the pool ceiling itself.
  it("still gates on a real bar, not the (now reachable) 5000-item pool ceiling", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, "20_client-channel-builder.js"), "utf8");
    assert.match(
      src,
      /data\.channel\.items\.length >= CHANNEL_PRESET_MIN_ITEMS/,
      "quickAddChannel must gate on CHANNEL_PRESET_MIN_ITEMS, not the pool ceiling"
    );
    assert.doesNotMatch(
      src,
      /data\.channel\.items\.length >= CHANNEL_POOL_MAX_ITEMS/,
      "the old unreachable gate (>= CHANNEL_POOL_MAX_ITEMS) must not come back"
    );
  });

  // The other half of the fix: a Quick Add network channel's saved catalog
  // row must be a small pointer, not the pool itself -- otherwise raising
  // the pool to 5,000 would silently reopen the "too large to save" bug
  // rather than actually fix it as the smaller 200-item pool happened to.
  it("saves a small presetNetworkId pointer for the catalog row, not the pool", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, "20_client-channel-builder.js"), "utf8");
    assert.match(
      src,
      /presetNetworkId:\s*networkId/,
      "quickAddChannel's saved row must point at the shared preset by networkId"
    );
  });
});

describe("Quick Add network channels stay resolvable and small end to end", () => {
  it("channelSourceItems resolves a presetNetworkId pointer to the full cached pool", async () => {
    const sb = loadSourceFunctions("00_constants.js", "05_catalog-core.js", "07_source-fetchers-tmdb-simkl.js");
    const items600 = Array.from({ length: 600 }, (_, i) => ({
      kind: "episode", imdbId: "tt" + (i % 30), season: 1, episode: i, showName: "Show " + (i % 30), epName: "Ep " + i, title: "t", released: "2024-01-01",
    }));
    const cachedPreset = { name: "CBS", poster: "https://x/api/channel-logo?path=/x.png", backdrop: null, items: items600, shuffle: false, dailyRotate: true };
    const env = { CONFIGS: makeFakeConfigs({ "channel:preset:v2:16": JSON.stringify(cachedPreset) }) };

    // The exact slim shape quickAddChannel now saves into the catalog row --
    // no `items` at all, just enough to find the shared preset and this
    // user's own identity/settings for it.
    const pointerPayload = { channelId: "user-ch-1", name: "CBS", presetNetworkId: "16", shuffle: false, dailyRotate: true };

    const resolved = await sb.channelSourceItems(pointerPayload, { env, origin: "https://example.com" });
    assert.equal(resolved.length, 600, "must resolve to the full cached pool, not an empty/partial one");
    assert.equal(resolved[0].showName, "Show 0");
  });

  it("buildChannelMeta serves a real episode list for a presetNetworkId channel with zero TMDB calls", async () => {
    const sb = loadSourceFunctions("00_constants.js", "05_catalog-core.js", "07_source-fetchers-tmdb-simkl.js");
    const items = Array.from({ length: 50 }, (_, i) => ({
      kind: "episode", imdbId: "tt900" + (i % 5), season: 1, episode: (i % 10) + 1, showName: "Show " + (i % 5), epName: "Ep " + i, title: "t", released: "2024-01-01",
    }));
    const cachedPreset = { name: "ABC", poster: "https://x/api/channel-logo?path=/x.png", backdrop: null, items, shuffle: false, dailyRotate: true };
    const env = { CONFIGS: makeFakeConfigs({ "channel:preset:v2:2": JSON.stringify(cachedPreset) }) };

    const pointerPayload = { channelId: "user-ch-2", name: "ABC", presetNetworkId: "2", shuffle: false, dailyRotate: true };
    const entry = { id: "user-ch-2", type: "series", name: "ABC", url: "channel:v1:" + JSON.stringify(pointerPayload) };

    // No `fetch` exists in this sandbox at all (see loadSourceFunctions) --
    // if resolution fell through to a live TMDB build instead of the cache,
    // this would throw ReferenceError rather than silently going out.
    const meta = await sb.buildChannelMeta(entry, "https://example.com", { env });
    assert.ok(meta, "a warm-cache pointer channel must resolve to real meta");
    assert.ok(meta.videos.length > 0, "must actually carry playable episodes");
  });

  it("fetchChannelCatalog renders a pointer channel's tile with no env/KV at all", () => {
    const sb = loadSourceFunctions("00_constants.js", "05_catalog-core.js", "07_source-fetchers-tmdb-simkl.js");
    const pointerPayload = {
      channelId: "user-ch-3", name: "NBC", presetNetworkId: "6", shuffle: false, dailyRotate: true,
      poster: "https://example.com/api/channel-logo?path=/nbc.png", backdrop: "https://example.com/api/channel-logo?path=/nbc.png",
    };
    const entry = { id: "user-ch-3", type: "series", name: "NBC", url: "channel:v1:" + JSON.stringify(pointerPayload) };

    // fetchChannelCatalog is not async and takes no env -- the tile must
    // render from the pointer's own poster/backdrop alone, never touching
    // the shared preset cache.
    const metas = sb.fetchChannelCatalog(entry, "https://example.com");
    assert.equal(metas.length, 1);
    assert.equal(metas[0].id, "channel_user-ch-3");
    assert.equal(metas[0].name, "NBC");
    assert.match(metas[0].poster, /\/api\/channel-logo\?path=/);
  });

  // The actual regression test for the reported bug, now that the pool is
  // back to 5,000: ten Quick Add channels' worth of pointer rows must stay
  // tiny, because none of them carry a pool of their own.
  it("ten Quick Add channels' worth of pointer rows stay far under the config size limit", async () => {
    const env = makeEnv({ CONFIGS: makeKv() });
    const entries = CHANNEL_PRESET_NETWORK_IDS_FOR_TEST.map((id, i) => {
      const pointerPayload = {
        channelId: "ch-" + i,
        name: "Network " + i,
        presetNetworkId: id,
        poster: "https://example.com/api/channel-logo?path=/n" + i + ".png",
        backdrop: "https://example.com/api/channel-logo?path=/n" + i + ".png",
        shuffle: false,
        dailyRotate: true,
      };
      return { name: "Network " + i, url: "channel:v1:" + JSON.stringify(pointerPayload), type: "series", group: "Channels" };
    });

    const res = await call(env, "/api/save", { method: "POST", json: { entries } });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true, res.body.error);
    assert.ok(res.body.id, "must save under a short id, not fall back to a giant URL");
  });
});

// --- Admin: /admin/api/channel-presets (status, clear, rebuild) -------------
//
// The point-and-click way to see whether a network's shared preset cache is
// still what an older build produced, and to force it fresh without waiting
// for the cron rotation to come back around to it.

async function adminCookie(env) {
  const r = await call(env, "/admin/login", { method: "POST", form: { key: env.ADMIN_KEY } });
  const m = (r.headers.get("set-cookie") || "").match(/^([^=]+=[^;]+)/);
  return m ? m[1] : "";
}

describe("admin: Channel Presets tab", () => {
  it("requires admin auth on all three routes", async () => {
    const env = makeEnv({ CONFIGS: makeKv() });
    const statusRes = await call(env, "/admin/api/channel-presets");
    assert.equal(statusRes.status, 401);
    const clearRes = await call(env, "/admin/api/channel-presets/clear", { method: "POST", json: { all: true } });
    assert.equal(clearRes.status, 401);
    const rebuildRes = await call(env, "/admin/api/channel-presets/rebuild", { method: "POST", json: { networkId: "129" } });
    assert.equal(rebuildRes.status, 401);
  });

  it("reports cached state, item count and build time for every network", async () => {
    const kv = makeKv();
    const env = makeEnv({ CONFIGS: kv });
    const cookie = await adminCookie(env);
    const builtAt = Date.now() - 60000;
    await kv.put("channel:preset:v2:16", JSON.stringify({
      name: "CBS", items: Array.from({ length: 250 }, () => ({ kind: "episode" })), builtAt,
    }));

    const res = await call(env, "/admin/api/channel-presets", { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true, res.body.error);
    assert.equal(res.body.networks.length, 28, "must list every CHANNEL_PRESET_NETWORKS entry");

    const cbs = res.body.networks.find((n) => n.id === "16");
    assert.equal(cbs.name, "CBS");
    assert.equal(cbs.cached, true);
    assert.equal(cbs.itemCount, 250);
    assert.equal(cbs.builtAt, builtAt);

    const notCached = res.body.networks.find((n) => n.id === "2"); // ABC
    assert.equal(notCached.cached, false);
    assert.equal(notCached.itemCount, 0);
    assert.equal(notCached.builtAt, null);
  });

  it("clears one network's cache without touching any other", async () => {
    const kv = makeKv();
    const env = makeEnv({ CONFIGS: kv });
    const cookie = await adminCookie(env);
    await kv.put("channel:preset:v2:16", JSON.stringify({ name: "CBS", items: [{ kind: "episode" }] }));
    await kv.put("channel:preset:v2:2", JSON.stringify({ name: "ABC", items: [{ kind: "episode" }] }));

    const res = await call(env, "/admin/api/channel-presets/clear", {
      method: "POST", headers: { cookie }, json: { networkId: "16" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true, res.body.error);
    assert.deepEqual(res.body.cleared, ["16"]);

    assert.equal(await kv.get("channel:preset:v2:16"), null);
    assert.ok(await kv.get("channel:preset:v2:2"), "an unrelated network's cache must survive");
  });

  it("clears every network's cache when all: true", async () => {
    const kv = makeKv();
    const env = makeEnv({ CONFIGS: kv });
    const cookie = await adminCookie(env);
    await kv.put("channel:preset:v2:16", JSON.stringify({ name: "CBS", items: [{ kind: "episode" }] }));
    await kv.put("channel:preset:v2:2", JSON.stringify({ name: "ABC", items: [{ kind: "episode" }] }));

    const res = await call(env, "/admin/api/channel-presets/clear", {
      method: "POST", headers: { cookie }, json: { all: true },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true, res.body.error);
    assert.equal(res.body.cleared.length, 28);

    assert.equal(await kv.get("channel:preset:v2:16"), null);
    assert.equal(await kv.get("channel:preset:v2:2"), null);
  });

  it("rebuilds one network right now, bypassing whatever was cached before", async () => {
    const kv = makeKv();
    const env = makeEnv({ CONFIGS: kv, TMDB_API_KEY: "test-tmdb-key" });
    const cookie = await adminCookie(env);
    // A stale cache shaped like the OLD 200-item build (no builtAt at all) --
    // exactly what an admin would be looking at after deploying this fix.
    await kv.put("channel:preset:v2:16", JSON.stringify({
      name: "CBS", items: Array.from({ length: 200 }, () => ({ kind: "episode" })),
    }));

    const stub = stubTmdb(smallNetworkHandler);
    try {
      const res = await call(env, "/admin/api/channel-presets/rebuild", {
        method: "POST", headers: { cookie }, json: { networkId: "16" },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true, res.body.error);
      assert.equal(res.body.network.id, "16");
      // smallNetworkHandler produces 4 episodes (2 shows x 1 season x 2 episodes).
      assert.equal(res.body.network.itemCount, 4);
      assert.ok(res.body.network.builtAt > Date.now() - 5000, "builtAt must be from this rebuild, not the stale cache");
    } finally {
      stub.restore();
    }

    const cached = JSON.parse(await kv.get("channel:preset:v2:16"));
    assert.equal(cached.items.length, 4, "the cache itself must now hold the rebuilt pool, not the stale 200-item one");
  });

  it("rejects an unknown networkId on both clear and rebuild", async () => {
    const env = makeEnv({ CONFIGS: makeKv() });
    const cookie = await adminCookie(env);
    const clearRes = await call(env, "/admin/api/channel-presets/clear", {
      method: "POST", headers: { cookie }, json: { networkId: "not-a-real-network" },
    });
    assert.equal(clearRes.body.ok, false);
    const rebuildRes = await call(env, "/admin/api/channel-presets/rebuild", {
      method: "POST", headers: { cookie }, json: { networkId: "not-a-real-network" },
    });
    assert.equal(rebuildRes.body.ok, false);
  });
});

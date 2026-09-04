import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { call, createUser, makeD1, makeEnv, makeKv, nextIp } from "./harness.mjs";

const CREATOR_POSTS = [
  "/api/creator/lists",
  "/api/creator/lists/save",
  "/api/creator/lists/delete",
  "/api/creator/lists/reorder",
  "/api/creator/account/reset",
  "/api/creator/delete-account",
  "/api/creator/sync/save",
  "/api/creator/sync/save-tracking",
  "/api/creator/sync/save-presets",
  "/api/creator/sync/save-channels",
  "/api/creator/sync/meta",
  "/api/creator/sync/load",
  "/api/creator/sync/like",
  "/api/creator/sync/share-tracking",
  "/api/creator/track-status",
  "/api/creator/scrobble-seen-users",
];

const ADMIN_GETS = [
  "/admin/api/leaderboard",
  "/admin/api/feedback",
  "/admin/api/analytics",
  "/admin/api/apiusage",
  "/admin/api/netflix-preview",
  "/admin/api/provider-lookup",
];

const ADMIN_POSTS = [
  "/admin/api/reset-creator-key",
  "/admin/api/backfill-trending",
  "/admin/api/migrate-d1",
  "/admin/api/migrate-day-counts",
  "/admin/api/feedback/reply",
  "/admin/api/feedback/status",
  "/admin/api/feedback/edit",
  "/admin/api/feedback/delete",
];

describe("authorization matrix", () => {
  it("creator POSTs reject missing credentials with 401", async () => {
    const env = makeEnv();
    for (const path of CREATOR_POSTS) {
      const r = await call(env, path, { method: "POST", json: {} });
      assert.equal(r.status, 401, `${path} expected 401, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.body.ok, false);
    }
  });

  it("creator POSTs reject the wrong key with 401", async () => {
    const env = makeEnv();
    const alice = await createUser(env, "aliceauth");
    for (const path of CREATOR_POSTS) {
      const r = await call(env, path, {
        method: "POST",
        json: { creatorName: alice.creatorName, creatorKey: "MYL-AAAA-AAAA-AAAA" },
      });
      assert.equal(r.status, 401, `${path} wrong key expected 401, got ${r.status}`);
    }
  });

  it("sync/save wrong key is 401 not 200", async () => {
    const env = makeEnv();
    const alice = await createUser(env, "alicesync");
    const r = await call(env, "/api/creator/sync/save", {
      method: "POST",
      json: { creatorName: alice.creatorName, creatorKey: "MYL-WRONG-KEY1-KEY2", config: [] },
    });
    assert.equal(r.status, 401);
    assert.equal(r.body.ok, false);
  });

  it("admin API routes reject missing cookie with 401", async () => {
    const env = makeEnv();
    for (const path of ADMIN_GETS) {
      const r = await call(env, path, { method: "GET" });
      assert.equal(r.status, 401, `${path} expected 401, got ${r.status}`);
    }
    for (const path of ADMIN_POSTS) {
      const r = await call(env, path, { method: "POST", json: {} });
      assert.equal(r.status, 401, `${path} expected 401, got ${r.status}`);
    }
  });

  it("feedback/threads by name without a key is 401", async () => {
    const env = makeEnv();
    const r = await call(env, "/api/feedback/threads?creatorName=victim", { method: "GET" });
    assert.equal(r.status, 401);
    assert.equal(r.body.ok, false);
  });

  it("create/restore/reset-key/feedback reject a missing CF-Connecting-IP", async () => {
    const env = makeEnv();
    const missing = { ip: "" };
    const create = await call(env, "/api/creator/create", { method: "POST", json: { creatorName: "noipuser" }, ...missing });
    assert.equal(create.status, 400);
    const restore = await call(env, "/api/creator/restore", { method: "POST", json: { creatorName: "x", creatorKey: "y" }, ...missing });
    assert.equal(restore.status, 400);
    const reset = await call(env, "/api/creator/reset-key", { method: "POST", json: { username: "x", recoveryAnswer: "y" }, ...missing });
    assert.equal(reset.status, 400);
    const fb = await call(env, "/api/feedback", { method: "POST", json: { message: "hello" }, ...missing });
    assert.equal(fb.status, 400);
  });
});

describe("private tracking IDOR", () => {
  it("watch-history / watchlist / continue-watching 404 until the owner opts in", async () => {
    const env = makeEnv();
    const alice = await createUser(env, "alicehist");
    const save = await call(env, "/api/creator/sync/save-tracking", {
      method: "POST",
      json: {
        creatorName: alice.creatorName,
        creatorKey: alice.creatorKey,
        watchHistory: [{ id: "tt0111161", name: "Shawshank PRIVATE", type: "movie" }],
        watchlist: [{ id: "tt0068646", name: "Godfather SECRET", type: "movie" }],
        continueWatching: [{ id: "tt0944947", name: "Thrones SECRET", type: "series", showId: "tt0944947" }],
      },
    });
    assert.equal(save.status, 200);
    assert.equal(save.body.ok, true);

    for (const slug of ["watch-history", "watchlist", "continue-watching"]) {
      const closed = await call(env, `/lists/${alice.creatorName}/${slug}.json`);
      assert.equal(closed.status, 404, `${slug} should be private by default`);
    }

    for (const slug of ["watch-history", "watchlist", "continue-watching"]) {
      const share = await call(env, "/api/creator/sync/share-tracking", {
        method: "POST",
        json: { creatorName: alice.creatorName, creatorKey: alice.creatorKey, slug, shared: true },
      });
      assert.equal(share.body.ok, true, `share ${slug}`);
      const open = await call(env, `/lists/${alice.creatorName}/${slug}.json`);
      assert.equal(open.status, 200, `${slug} after opt-in`);
      assert.ok(Array.isArray(open.body) && open.body.length >= 1, `${slug} should return items`);
    }
  });
});

describe("feedback threads", () => {
  it("name lookup needs the key; anonymous threadIds still work", async () => {
    const env = makeEnv();
    const alice = await createUser(env, "alicefb");
    const posted = await call(env, "/api/feedback", {
      method: "POST",
      json: { message: "secret report", creatorName: alice.creatorName, contact: "me@example.com" },
    });
    assert.equal(posted.body.ok, true);
    const threadId = posted.body.entry.id;

    const noKey = await call(env, "/api/feedback/threads", {
      method: "POST",
      json: { creatorName: alice.creatorName },
    });
    assert.equal(noKey.status, 401);

    const wrong = await call(env, "/api/feedback/threads", {
      method: "POST",
      json: { creatorName: alice.creatorName, creatorKey: "MYL-NOPE-NOPE-NOPE" },
    });
    assert.equal(wrong.status, 401);

    const ok = await call(env, "/api/feedback/threads", {
      method: "POST",
      json: { creatorName: alice.creatorName, creatorKey: alice.creatorKey },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    assert.ok(ok.body.threads.some((t) => t.id === threadId));

    const anon = await call(env, "/api/feedback/threads", {
      method: "POST",
      json: { threadIds: [threadId] },
    });
    assert.equal(anon.status, 200);
    assert.ok(anon.body.threads.some((t) => t.id === threadId));
  });
});

describe("data isolation", () => {
  it("one creator cannot read or delete another creator's lists", async () => {
    const env = makeEnv();
    const alice = await createUser(env, "aliceiso");
    const bob = await createUser(env, "bobiso");
    const saved = await call(env, "/api/creator/lists/save", {
      method: "POST",
      json: {
        creatorName: alice.creatorName,
        creatorKey: alice.creatorKey,
        name: "Alice Private",
        type: "movie",
        visibility: "private",
        items: [{ id: "tt0111161", name: "Secret" }],
      },
    });
    assert.equal(saved.body.ok, true);
    const slug = saved.body.slug;

    const bobLists = await call(env, "/api/creator/lists", {
      method: "POST",
      json: { creatorName: bob.creatorName, creatorKey: bob.creatorKey },
    });
    assert.equal(bobLists.status, 200);
    assert.ok(!(bobLists.body.lists || []).some((l) => l.slug === slug && l.name === "Alice Private"));

    const steal = await call(env, "/api/creator/lists/delete", {
      method: "POST",
      json: { creatorName: alice.creatorName, creatorKey: bob.creatorKey, slug },
    });
    assert.equal(steal.status, 401);

    const publicGet = await call(env, `/lists/${alice.creatorName}/${slug}.json`);
    assert.equal(publicGet.status, 404);
  });
});

describe("account lifecycle", () => {
  it("delete-account purges identity so the old key dies and the name can be reused", async () => {
    const env = makeEnv();
    const alice = await createUser(env, "alicedel", { recoveryAnswer: "blue terrier" });
    await call(env, "/api/creator/sync/save-tracking", {
      method: "POST",
      json: {
        creatorName: alice.creatorName,
        creatorKey: alice.creatorKey,
        watchHistory: [{ id: "tt1", name: "Gone" }],
      },
    });
    const missingConfirm = await call(env, "/api/creator/delete-account", {
      method: "POST",
      json: { creatorName: alice.creatorName, creatorKey: alice.creatorKey },
    });
    assert.equal(missingConfirm.status, 400);

    const del = await call(env, "/api/creator/delete-account", {
      method: "POST",
      json: { creatorName: alice.creatorName, creatorKey: alice.creatorKey, confirm: "DELETE" },
    });
    assert.equal(del.status, 200);
    assert.equal(del.body.ok, true);

    const lists = await call(env, "/api/creator/lists", {
      method: "POST",
      json: { creatorName: alice.creatorName, creatorKey: alice.creatorKey },
    });
    assert.equal(lists.status, 401);

    const hist = await call(env, `/lists/${alice.creatorName}/watch-history.json`);
    assert.equal(hist.status, 404);

    const again = await createUser(env, "alicedel");
    assert.equal(again.ok, true);
    assert.notEqual(again.creatorKey, alice.creatorKey);
  });
});

describe("key rotation", () => {
  it("rotates KV even when D1 is bound and has no row", async () => {
    const kv = makeKv();
    const envNoDb = makeEnv({ CONFIGS: kv, DB: undefined });
    const alice = await createUser(envNoDb, "alicerot", { recoveryAnswer: "green lantern" });

    const db = makeD1();
    const envDb = makeEnv({ CONFIGS: kv, DB: db });
    assert.equal(db._creators.size, 0);

    const rotated = await call(envDb, "/api/creator/reset-key", {
      method: "POST",
      json: { username: alice.creatorName, recoveryAnswer: "green lantern" },
    });
    assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
    assert.equal(rotated.body.ok, true);
    assert.ok(rotated.body.creatorKey);
    assert.notEqual(rotated.body.creatorKey, alice.creatorKey);

    const oldKey = await call(envDb, "/api/creator/restore", {
      method: "POST",
      json: { creatorName: alice.creatorName, creatorKey: alice.creatorKey },
    });
    assert.equal(oldKey.status, 401);

    const newKey = await call(envDb, "/api/creator/restore", {
      method: "POST",
      json: { creatorName: alice.creatorName, creatorKey: rotated.body.creatorKey },
    });
    assert.equal(newKey.status, 200);
    assert.equal(newKey.body.ok, true);
  });

  it("rotates both stores when the D1 row exists", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db });
    const alice = await createUser(env, "aliced1", { recoveryAnswer: "red balloon" });
    assert.ok(db._creators.has("aliced1"));
    const rotated = await call(env, "/api/creator/reset-key", {
      method: "POST",
      json: { username: alice.creatorName, recoveryAnswer: "red balloon" },
    });
    assert.equal(rotated.body.ok, true);
    const oldKey = await call(env, "/api/creator/restore", {
      method: "POST",
      json: { creatorName: alice.creatorName, creatorKey: alice.creatorKey },
    });
    assert.equal(oldKey.status, 401);
    const newKey = await call(env, "/api/creator/restore", {
      method: "POST",
      json: { creatorName: alice.creatorName, creatorKey: rotated.body.creatorKey },
    });
    assert.equal(newKey.status, 200);
  });
});

describe("directory pagination", () => {
  it("public.json reports every seeded list after the index rebuilds", async () => {
    const kv = makeKv();
    const env = makeEnv({ CONFIGS: kv });
    const n = 180;
    for (let i = 0; i < n; i++) {
      const slug = `list-${String(i).padStart(4, "0")}`;
      const username = `user${String(i % 20).padStart(2, "0")}`;
      await kv.put(`creatorlist:${username}:${slug}`, JSON.stringify({
        name: `List ${i}`,
        slug,
        type: "movie",
        visibility: "public",
        items: [{ id: "tt0111161", name: "Item" }],
        likes: 0,
        createdAt: 1,
        updatedAt: 1,
      }));
    }
    const first = await call(env, "/lists/public.json?limit=500");
    assert.equal(first.status, 200);
    const second = await call(env, "/lists/public.json?limit=500");
    assert.equal(second.body.ok, true);
    assert.equal(second.body.total, n, `expected total ${n}, got ${second.body.total}`);
    assert.equal(second.body.lists.length, n);
  });
});

describe("likes and preview guards", () => {
  it("rejects like-external URLs off the provider allowlist", async () => {
    const env = makeEnv();
    const r = await call(env, "/api/lists/like-external", {
      method: "POST",
      json: { url: "https://evil.example/x" },
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.ok, false);
  });

  it("double-like is idempotent", async () => {
    const env = makeEnv();
    const alice = await createUser(env, "alicelike");
    const saved = await call(env, "/api/creator/lists/save", {
      method: "POST",
      json: {
        creatorName: alice.creatorName,
        creatorKey: alice.creatorKey,
        name: "Likeable",
        type: "movie",
        visibility: "public",
        items: [{ id: "tt0111161", name: "Item" }],
      },
    });
    const slug = saved.body.slug;
    const ip = nextIp();
    const first = await call(env, "/api/lists/like", {
      method: "POST",
      ip,
      json: { username: alice.creatorName, slug },
    });
    assert.equal(first.body.ok, true);
    assert.equal(first.body.likes, 1);
    const second = await call(env, "/api/lists/like", {
      method: "POST",
      ip,
      json: { username: alice.creatorName, slug },
    });
    assert.equal(second.body.likes, 1);
  });

  it("preview rejects a non-allowlisted URL without fetching it", async () => {
    const env = makeEnv();
    const r = await call(env, "/api/preview", {
      method: "POST",
      json: { url: "http://127.0.0.1/secret", type: "movie" },
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.ok, false);
  });
});

describe("displayName", () => {
  it("stores the submitted display name when it is valid", async () => {
    const env = makeEnv();
    const r = await createUser(env, "alicecap", { displayName: "Alice Cap" });
    assert.equal(r.displayName, "Alice Cap");
    const long = await call(env, "/api/creator/create", {
      method: "POST",
      json: { creatorName: "toolongnameok", displayName: "A".repeat(41) },
    });
    assert.equal(long.status, 400);
  });
});

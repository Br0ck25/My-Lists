import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { call, createUser, makeD1, makeEnv, makeKv, nextIp, worker } from "./harness.mjs";

async function adminCookie(env) {
  const r = await call(env, "/admin/login", { method: "POST", form: { key: env.ADMIN_KEY } });
  const setCookie = r.headers.get("set-cookie") || "";
  const match = setCookie.match(/^([^=]+=[^;]+)/);
  return match ? match[1] : "";
}

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
  "/admin/api/rebuild-public-index",
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

  // KV list() on "feedback:" returns oldest-first. The by-name scan used to
  // be one unpaginated list({limit:200}) -- once total feedback volume grew
  // past 200, that window only ever covered the 200 OLDEST entries
  // system-wide, so a real creator's own recent thread would silently stop
  // being found no matter how many times they asked. Seed past that old
  // fixed window and assert the newest entry -- created last, so it sorts
  // last -- is still returned.
  it("by-name lookup still finds a creator's newest thread once feedback volume passes the old 200-key window", async () => {
    const env = makeEnv();
    const alice = await createUser(env, "alicefbvol");
    for (let i = 0; i < 250; i++) {
      const id = `${1000000000000 + i}:filler${i}`;
      await env.CONFIGS.put(`feedback:${id}`, JSON.stringify({
        id, category: "other", message: `filler ${i}`, contact: null,
        creatorName: "someoneelse", createdAt: 1000000000000 + i, updatedAt: 1000000000000 + i,
        completed: false, status: "open", messages: [], userAgent: "",
      }));
    }
    // Sorts after all 250 filler keys (larger timestamp), i.e. newest.
    const newest = await call(env, "/api/feedback", {
      method: "POST",
      json: { creatorName: alice.creatorName, message: "my recent report" },
    });
    assert.equal(newest.body.ok, true);
    const threadId = newest.body.entry.id;

    const found = await call(env, "/api/feedback/threads", {
      method: "POST",
      json: { creatorName: alice.creatorName, creatorKey: alice.creatorKey },
    });
    assert.equal(found.status, 200);
    assert.ok(found.body.threads.some((t) => t.id === threadId), "newest thread should still be found past the old 200-key window");
  });

  // The server correctly requires creatorKey once creatorName is present
  // (that's the fix for the IDOR where anyone could read any user's
  // support threads by name alone) -- but the client's own caller was
  // never updated to send it, so every signed-in visitor's own request
  // 401'd and silently came back with zero threads, including their
  // anonymous threadIds ones, since the creatorName check runs first and
  // returns before threadIds are even looked up. Guard against sending
  // creatorName without creatorKey creeping back into the shipped bundle.
  it("served bundle sends creatorKey alongside creatorName when loading feedback threads", async () => {
    const env = makeEnv();
    const bundle = await call(env, "/app.js");
    assert.equal(bundle.status, 200);
    const start = bundle.text.indexOf("function loadUserFeedbackThreads");
    assert.notEqual(start, -1, "loadUserFeedbackThreads should be present in the served bundle");
    const body = bundle.text.slice(start, start + 1200);
    assert.ok(/creatorKey\s*:\s*creatorKey/.test(body), "loadUserFeedbackThreads must send creatorKey, not just creatorName");
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

  it("/admin/api/rebuild-public-index seeds a cold index synchronously", async () => {
    const kv = makeKv();
    const env = makeEnv({ CONFIGS: kv });
    // Seeded directly into KV (bypassing the save endpoint, so the
    // incremental index update never ran) to simulate a genuinely cold
    // index -- a fresh deploy, or the index key lost some other way.
    const n = 12;
    for (let i = 0; i < n; i++) {
      await kv.put(`creatorlist:idxuser:list-${i}`, JSON.stringify({
        name: `List ${i}`, slug: `list-${i}`, type: "movie", visibility: "public",
        items: [{ id: "tt0111161", name: "Item" }], likes: 0, createdAt: 1, updatedAt: 1,
      }));
    }
    assert.equal(await kv.get("index:publiclists"), null);

    const cookie = await adminCookie(env);
    const r = await call(env, "/admin/api/rebuild-public-index", { method: "POST", cookie });
    assert.equal(r.body.ok, true);
    assert.equal(r.body.count, n);
    assert.notEqual(await kv.get("index:publiclists"), null);

    // Now served straight from the index, no bounded-scan fallback needed.
    const listing = await call(env, "/lists/public.json?limit=500");
    assert.equal(listing.body.total, n);
  });

  it("scheduled() self-heals a missing index without any admin action", async () => {
    const kv = makeKv();
    const env = makeEnv({ CONFIGS: kv });
    const n = 7;
    for (let i = 0; i < n; i++) {
      await kv.put(`creatorlist:cronuser:list-${i}`, JSON.stringify({
        name: `List ${i}`, slug: `list-${i}`, type: "movie", visibility: "public",
        items: [{ id: "tt0111161", name: "Item" }], likes: 0, createdAt: 1, updatedAt: 1,
      }));
    }
    assert.equal(await kv.get("index:publiclists"), null);

    const pending = [];
    const ctx = { waitUntil(p) { pending.push(Promise.resolve(p).catch(() => {})); } };
    await worker.scheduled({}, env, ctx);
    await Promise.all(pending);

    assert.notEqual(await kv.get("index:publiclists"), null);
    const listing = await call(env, "/lists/public.json?limit=500");
    assert.equal(listing.body.total, n);
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

  it("poster-badge rejects a non-allowlisted poster host (was an open redirect / SSRF)", async () => {
    const env = makeEnv();
    // No badge params: used to be Response.redirect(posterUrl) -- an open
    // redirect off this domain to whatever host the caller named.
    const redirectCase = await call(env, "/api/poster-badge?poster=" + encodeURIComponent("https://evil.example/phish"));
    assert.equal(redirectCase.status, 404);
    // A badge param present: used to fetch(posterUrl) server-side and
    // embed the response in the SVG returned -- an SSRF/open image proxy.
    const fetchCase = await call(env, "/api/poster-badge?poster=" + encodeURIComponent("https://evil.example/x") + "&airDate=2099-01-01");
    assert.equal(fetchCase.status, 404);
  });

  it("a vote survives a concurrent write racing its own PUT (applyLikeVote retry)", async () => {
    const env = makeEnv();
    const alice = await createUser(env, "alicerace");
    const saved = await call(env, "/api/creator/lists/save", {
      method: "POST",
      json: {
        creatorName: alice.creatorName,
        creatorKey: alice.creatorKey,
        name: "RaceList",
        type: "movie",
        visibility: "public",
        items: [{ id: "tt0111161", name: "Item" }],
      },
    });
    const slug = saved.body.slug;
    const ledgerKey = `listlikevoters:${alice.creatorName}:${slug}`;

    // Simulate another request's write landing between this vote's PUT and
    // its verification read: the very first time applyLikeVote writes to
    // this ledger key, immediately clobber it with a snapshot that does
    // NOT include this voter -- exactly the lost-update race a plain
    // read-modify-write would silently lose to.
    let injected = false;
    const realPut = env.CONFIGS.put.bind(env.CONFIGS);
    env.CONFIGS.put = async (key, value) => {
      await realPut(key, value);
      if (key === ledgerKey && !injected) {
        injected = true;
        await realPut(key, JSON.stringify(["a:racing-voter"]));
      }
    };

    const r = await call(env, "/api/lists/like", {
      method: "POST",
      json: { username: alice.creatorName, slug },
    });
    assert.equal(injected, true);
    assert.equal(r.body.ok, true);
    // Both this vote and the "racing" one must be reflected -- not just
    // whichever write happened to land last.
    assert.equal(r.body.likes, 2);
    const finalVoters = JSON.parse(await env.CONFIGS.get(ledgerKey));
    assert.equal(finalVoters.length, 2);
    assert.ok(finalVoters.includes("a:racing-voter"));
  });
});

describe("admin login", () => {
  it("rate-limits repeated wrong-key attempts from the same IP", async () => {
    const env = makeEnv();
    const ip = nextIp();
    let last;
    for (let i = 0; i < 11; i++) {
      last = await call(env, "/admin/login", { method: "POST", ip, form: { key: "wrong-key" } });
    }
    assert.equal(last.status, 429);
  });

  it("does not share the rate-limit bucket across different IPs", async () => {
    const env = makeEnv();
    const r = await call(env, "/admin/login", { method: "POST", ip: nextIp(), form: { key: "wrong-key" } });
    assert.equal(r.status, 401);
  });

  it("renders the Maintenance tab with dashboard-clickable D1/index tools", async () => {
    const env = makeEnv();
    const cookie = await adminCookie(env);
    const r = await call(env, "/admin", { method: "GET", cookie });
    assert.equal(r.status, 200);
    assert.match(r.text, /id="migrateD1Btn"/);
    assert.match(r.text, /id="rebuildIndexBtn"/);
    // No env.DB bound in this test env -- the D1 action should render
    // visibly disabled rather than silently doing nothing if clicked.
    assert.match(r.text, /id="migrateD1Btn"[^>]*disabled/);
  });

  it("enables the D1 migration button once a D1 database is actually bound", async () => {
    const env = makeEnv({ DB: makeD1() });
    const cookie = await adminCookie(env);
    const r = await call(env, "/admin", { method: "GET", cookie });
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.text, /id="migrateD1Btn"[^>]*disabled/);
  });
});

describe("sync conflict guard", () => {
  it("rejects a stale expectedUpdatedAt instead of silently overwriting a newer save", async () => {
    const env = makeEnv();
    const bob = await createUser(env, "bobsync");

    const first = await call(env, "/api/creator/sync/save", {
      method: "POST",
      json: { creatorName: bob.creatorName, creatorKey: bob.creatorKey, config: [{ id: "a", name: "A", url: "https://x" }] },
    });
    assert.equal(first.body.ok, true);
    assert.equal(typeof first.body.updatedAt, "number");
    const firstUpdatedAt = first.body.updatedAt;

    // Force the clock forward a tick so the "second device" gets a
    // strictly later updatedAt than the first save.
    await new Promise((r) => setTimeout(r, 2));

    // "Device B" saves, built on top of the same baseline as device A.
    const second = await call(env, "/api/creator/sync/save", {
      method: "POST",
      json: {
        creatorName: bob.creatorName,
        creatorKey: bob.creatorKey,
        config: [{ id: "b", name: "B", url: "https://y" }],
        expectedUpdatedAt: firstUpdatedAt,
      },
    });
    assert.equal(second.body.ok, true);
    const secondUpdatedAt = second.body.updatedAt;
    assert.ok(secondUpdatedAt > firstUpdatedAt);

    // "Device A", still holding the stale baseline, tries to save next --
    // must not clobber device B's newer write.
    const staleAttempt = await call(env, "/api/creator/sync/save", {
      method: "POST",
      json: {
        creatorName: bob.creatorName,
        creatorKey: bob.creatorKey,
        config: [{ id: "a-edited", name: "A edited", url: "https://x" }],
        expectedUpdatedAt: firstUpdatedAt,
      },
    });
    assert.equal(staleAttempt.status, 409);
    assert.equal(staleAttempt.body.ok, false);
    assert.equal(staleAttempt.body.conflict, true);

    const loaded = await call(env, "/api/creator/sync/load", {
      method: "POST",
      json: { creatorName: bob.creatorName, creatorKey: bob.creatorKey },
    });
    assert.equal(loaded.body.data.config[0].id, "b");
    assert.equal(loaded.body.data.updatedAt, secondUpdatedAt);
  });

  it("a save with no expectedUpdatedAt (older client) keeps the previous last-write-wins behavior", async () => {
    const env = makeEnv();
    const carol = await createUser(env, "carolsync");
    await call(env, "/api/creator/sync/save", {
      method: "POST",
      json: { creatorName: carol.creatorName, creatorKey: carol.creatorKey, config: [{ id: "x", name: "X", url: "https://x" }] },
    });
    const overwrite = await call(env, "/api/creator/sync/save", {
      method: "POST",
      json: { creatorName: carol.creatorName, creatorKey: carol.creatorKey, config: [{ id: "y", name: "Y", url: "https://y" }] },
    });
    assert.equal(overwrite.body.ok, true);
    const loaded = await call(env, "/api/creator/sync/load", {
      method: "POST",
      json: { creatorName: carol.creatorName, creatorKey: carol.creatorKey },
    });
    assert.equal(loaded.body.data.config[0].id, "y");
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

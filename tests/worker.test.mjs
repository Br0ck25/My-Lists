import { describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { call, createUser, makeD1, makeEnv, makeKv, nextIp, worker } from "./harness.mjs";

async function adminCookie(env) {
  const r = await call(env, "/admin/login", { method: "POST", form: { key: env.ADMIN_KEY } });
  const setCookie = r.headers.get("set-cookie") || "";
  const match = setCookie.match(/^([^=]+=[^;]+)/);
  return match ? match[1] : "";
}

// Evaluates one numbered source file on its own, in an isolated vm
// context, and returns its top-level declarations -- for testing a pure
// helper function directly without needing the whole Worker/KV/D1
// environment. Only works for a file whose top-level code is real,
// standalone JS (00-08, 25-26); files 09-24 are raw string content
// embedded inside 09_page-shell.js's own giant template literal (the
// served page's inline <script>) and reference client-only globals
// (window, document, ...) at their own top level, so they throw here --
// see loadOneClientFunction below for those instead, and render_check.js
// for how 09-24 actually get syntax-checked (as the rendered page's
// inline script, not as standalone files).
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
function loadSourceFunctions(relFile) {
  const src = fs.readFileSync(path.join(REPO_ROOT, relFile), "utf8");
  const sandbox = { console, URL, URLSearchParams };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: relFile });
  return sandbox;
}

// Extracts and evaluates exactly one top-level `function name(...) {...}`
// declaration out of a 09-24 client file, brace-balanced so it works
// regardless of nested blocks inside the function body -- for a
// self-contained (no calls to other not-yet-defined helpers) pure
// function, without needing to stand up the whole client bundle's
// window/document/DOM environment just to reach it.
// `extraGlobals` seeds anything the extracted function references as a
// free variable (other client globals, DOM stand-ins, a fetch mock, ...)
// -- it becomes part of the same sandbox object the function runs in, so
// a mock passed in here can still be inspected/asserted on after calling
// the returned function (they share the live object, not a copy).
function loadOneClientFunction(relFile, fnName, extraGlobals = {}) {
  const src = fs.readFileSync(path.join(REPO_ROOT, relFile), "utf8");
  const start = src.search(new RegExp(`(?:async\\s+)?function\\s+${fnName}\\s*\\([^)]*\\)\\s*\\{`));
  if (start === -1) throw new Error(`${fnName} not found in ${relFile}`);
  let depth = 0, end = -1;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end === -1) throw new Error(`could not find end of ${fnName} in ${relFile}`);
  const sandbox = { console, ...extraGlobals };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src.slice(start, end), sandbox, { filename: `${relFile}#${fnName}` });
  return sandbox[fnName];
}

// Extracts one `it => {...}` item-mapper body that isn't a named top-level
// function -- it's inline inside a much larger click-delegate handler (the
// "View"/"See All" buttons for a Custom List), so loadOneClientFunction
// above can't grab it by name. `mapOpenSnippet` must be an exact substring
// ending in the arrow's opening "{" (e.g. "...map((it) => {"); `occurrence`
// picks which match when the same snippet appears more than once in the
// file. Brace-balanced from there, same technique as loadOneClientFunction.
// `extraGlobals` supplies whatever free variables (isCw, formatWatchItemLabel,
// ...) the surrounding function would normally have closed over.
function loadInlineItemMapper(relFile, mapOpenSnippet, occurrence, extraGlobals = {}) {
  const src = fs.readFileSync(path.join(REPO_ROOT, relFile), "utf8");
  let searchFrom = 0, mapStart = -1;
  for (let n = 0; n <= occurrence; n++) {
    mapStart = src.indexOf(mapOpenSnippet, searchFrom);
    if (mapStart === -1) throw new Error(`occurrence ${n} of "${mapOpenSnippet}" not found in ${relFile}`);
    searchFrom = mapStart + 1;
  }
  const braceStart = mapStart + mapOpenSnippet.length - 1;
  let depth = 0, end = -1;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end === -1) throw new Error(`could not find end of mapper body in ${relFile}`);
  const body = src.slice(braceStart, end);
  const sandbox = { console, ...extraGlobals };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return vm.runInContext(`(function(it) ${body})`, sandbox, { filename: `${relFile}#mapper@${mapStart}` });
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

  it("accepts one of this add-on's own shared chart sentinels (Discover page \"See All\" like)", async () => {
    const env = makeEnv();
    // Before the fix, every one of this add-on's own built-in Discover
    // charts (which use a sentinel like "tmdb:chart:popular" instead of a
    // real URL) 400'd here with "That URL can't be liked" -- the one
    // thing this feature could never actually be used on.
    const r = await call(env, "/api/lists/like-external", {
      method: "POST",
      json: { url: "tmdb:chart:popular" },
    });
    assert.equal(r.body.ok, true, `expected ok, got ${JSON.stringify(r.body)}`);
    assert.equal(r.body.likes, 1);
    // Session/account-relative sentinels stay rejected -- there's no one
    // shared list a like against "my watchlist" could mean.
    const rejected = await call(env, "/api/lists/like-external", {
      method: "POST",
      json: { url: "trakt:watchlist" },
    });
    assert.equal(rejected.status, 400);
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

describe("list URL query-string handling", () => {
  // detectSource, mdblistJsonUrl, and guessNameFromUrl are pure functions
  // with no dependency on the Worker's KV/D1/fetch environment, so they're
  // evaluated directly out of the real source file in an isolated vm
  // context rather than routed through the HTTP harness -- a route-level
  // test can't tell "correctly detected, then failed for an unrelated
  // reason" apart from "misdetected", since /api/preview collapses every
  // failure to one generic error message before it reaches the client.
  const configFns = loadSourceFunctions("04_config-resolution.js");
  const guessNameFromUrl = loadOneClientFunction("19_client-search-and-likes.js", "guessNameFromUrl");

  it("guessNameFromUrl strips a trailing query string instead of using it as the guessed name", () => {
    // The exact reported bug: a trailing slash before the "?" put the
    // query string in its own "/"-separated segment, so it became the
    // *entire* guessed name.
    assert.equal(guessNameFromUrl("https://mdblist.com/lists/someone/my-list/?Mode=Show"), "My List");
    assert.equal(guessNameFromUrl("https://mdblist.com/lists/someone/my-list?Mode=Show"), "My List");
    assert.equal(guessNameFromUrl("https://trakt.tv/users/someone/lists/best-of-2024"), "Best Of 2024");
  });

  it("guessNameFromUrl uppercases known acronyms instead of just their first letter", () => {
    // The exact reported bug: plain per-word title-casing turns "imdb" into
    // "Imdb", not the "IMDB" a person would actually type by hand.
    assert.equal(
      guessNameFromUrl("https://app.trakt.tv/users/justin/lists/imdb-top-rated-movies"),
      "IMDB Top Rated Movies"
    );
    assert.equal(
      guessNameFromUrl("https://mdblist.com/lists/garycrawfordgc/latest-tv-shows"),
      "Latest TV Shows"
    );
    // Not so aggressive that it mangles a word that just happens to start
    // the same way as an acronym.
    assert.equal(guessNameFromUrl("https://mdblist.com/lists/someone/television-classics"), "Television Classics");
  });

  it("detectSource recognizes Trakt watchlist/history URLs even with a trailing query string", () => {
    assert.equal(configFns.detectSource("https://trakt.tv/users/someone/watchlist?Mode=Show"), "trakt-watchlist");
    assert.equal(configFns.detectSource("https://trakt.tv/users/someone/history?Mode=Show"), "trakt-history");
    // Also covers the separate pre-existing gap this fix closed alongside
    // it: app.trakt.tv was an allowed host (isAllowedCatalogSourceUrl)
    // but wasn't in this regex's own subdomain match.
    assert.equal(configFns.detectSource("https://app.trakt.tv/users/someone/watchlist"), "trakt-watchlist");
    // Still falls through to the generic "trakt" case for an ordinary
    // list URL -- this fix must not widen the watchlist/history match.
    assert.equal(configFns.detectSource("https://trakt.tv/users/someone/lists/best-of-2024"), "trakt");
  });

  it("mdblistJsonUrl strips a trailing query string instead of folding it into the list slug", () => {
    assert.equal(
      configFns.mdblistJsonUrl("https://mdblist.com/lists/someone/my-list/?Mode=Show", ""),
      "https://mdblist.com/lists/someone/my-list/json/?append_to_response=poster"
    );
    assert.equal(
      configFns.mdblistJsonUrl("https://mdblist.com/lists/someone/my-list?Mode=Show", ""),
      "https://mdblist.com/lists/someone/my-list/json/?append_to_response=poster"
    );
  });

  it("mdblistJsonUrl's fix holds end-to-end through /api/preview (HTTP level)", async () => {
    const env = makeEnv();
    const realFetch = globalThis.fetch;
    let requestedUrl = null;
    globalThis.fetch = async (input) => {
      requestedUrl = typeof input === "string" ? input : input && input.url;
      return {
        ok: true,
        status: 200,
        json: async () => ({ movies: [{ title: "A Movie", year: 2020, ids: { imdb: "tt0000001" } }] }),
      };
    };
    try {
      const r = await call(env, "/api/preview", {
        method: "POST",
        json: { url: "https://mdblist.com/lists/someone/my-list/?Mode=Show", type: "movie", skip: 0, sample: 10 },
      });
      assert.equal(r.body.ok, true, `expected ok, got ${JSON.stringify(r.body)}`);
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.ok(requestedUrl, "expected a fetch to have been made");
    assert.ok(!requestedUrl.includes("Mode"), `fetch URL leaked the query string into the slug: ${requestedUrl}`);
    assert.equal(requestedUrl, "https://mdblist.com/lists/someone/my-list/json/?append_to_response=poster");
  });
});

describe("custom list catalog pagination (imported list See All)", () => {
  // The reported bug: importing a 250-item list via "Import list from a
  // link" and adding it to Live Preview & Editor's Catalogs, then clicking
  // See All, only ever showed 200 items (100 real ones, duplicated) --
  // because fetchCustomListCatalog ignored `skip` entirely and returned the
  // whole list on every page request. Live Preview's See All (unlike Your
  // Custom Lists' own See All, which embeds the full array up front) pages
  // a Custom List through /api/preview with an advancing skip, so this is
  // a plain server-side pagination bug, testable directly against the real
  // source file (00-08 is real standalone JS, see loadSourceFunctions).
  const catalogFns = loadSourceFunctions("05_catalog-core.js");

  function makeMovieItems(n) {
    const items = [];
    for (let i = 0; i < n; i++) {
      items.push({ imdbId: "tt" + String(1000000 + i), title: "Movie " + i, type: "movie", year: 2000 + (i % 20) });
    }
    return items;
  }

  it("fetchCustomListCatalog advances with skip instead of returning the same page every time", async () => {
    const entry = { url: "customlist:v1:" + JSON.stringify({ items: makeMovieItems(250), listId: "x" }), type: "movie" };
    const page0 = await catalogFns.fetchCustomListCatalog(entry, 0, {});
    const page1 = await catalogFns.fetchCustomListCatalog(entry, 100, {});
    const page2 = await catalogFns.fetchCustomListCatalog(entry, 200, {});

    assert.equal(page0.length, 100);
    assert.equal(page1.length, 100);
    assert.equal(page2.length, 50);
    assert.notEqual(page1[0].id, page0[0].id, "the page at skip=100 must not repeat page 0's first item");

    const allIds = [...page0, ...page1, ...page2].map((m) => m.id);
    assert.equal(new Set(allIds).size, 250, "all 250 items across pages must be unique -- no duplicates, none missing");
  });

  it("fetchCustomListCatalog reports totalItems/maybeMore so /api/preview's pagination actually stops at the end", async () => {
    const entry = { url: "customlist:v1:" + JSON.stringify({ items: makeMovieItems(250), listId: "x" }), type: "movie" };
    const lastPage = await catalogFns.fetchCustomListCatalog(entry, 200, {});
    assert.equal(lastPage.totalItems, 250);
    const pastEnd = await catalogFns.fetchCustomListCatalog(entry, 250, {});
    assert.equal(pastEnd.length, 0);
  });

  it("end-to-end through /api/preview: three successive pages cover all 250 items with no duplicates (HTTP level)", async () => {
    const env = makeEnv();
    const url = "customlist:v1:" + JSON.stringify({ items: makeMovieItems(250), listId: "x" });
    const seen = new Set();
    let skip = 0;
    let maybeMore = true;
    let pages = 0;
    while (maybeMore && pages < 5) {
      const r = await call(env, "/api/preview", { method: "POST", json: { url, type: "movie", skip, sample: 100 } });
      assert.equal(r.body.ok, true, `expected ok, got ${JSON.stringify(r.body)}`);
      r.body.sample.forEach((it) => seen.add(it.id));
      skip += r.body.sample.length;
      maybeMore = r.body.maybeMore;
      pages++;
    }
    assert.equal(seen.size, 250, `expected all 250 unique items across pages, got ${seen.size}`);
    assert.equal(pages, 3, `expected exactly 3 pages (100+100+50), got ${pages}`);
  });
});

describe("custom list Movies/Shows tab filtering (imported list See All)", () => {
  // The reported bug: a plain movie item's mapped `showId` fell all the way
  // back to its own imdbId (the fallback chain's last resort, since a movie
  // has no real showId), so it came out truthy just like a genuine show's
  // would -- and the Shows tab's filter (!!it.showId) then matched every
  // movie right alongside actual shows, making Movies/Shows/All all show
  // the same items. Three call sites shared this exact fallback; this
  // covers the two most user-reachable ones (Your Custom Lists' own View
  // button, and the internal customlist:v1: preloaded-item derivation).
  const movieItem = { imdbId: "tt1000000", title: "Some Movie", type: "movie", year: 2020 };
  const formatWatchItemLabel = (it) => ({ title: it.title, subtitle: "" });

  it("Your Custom Lists' View button: a plain movie gets no showId (22_client-creator-profile.js)", () => {
    const mapper = loadInlineItemMapper(
      "22_client-creator-profile.js",
      "const sample = rawListItems.map((it) => {",
      0,
      {
        formatWatchItemLabel,
        isCw: false,
        isWatchlist: false,
        isHistory: false,
        list: { slug: "imdb-top-rated-movies", type: "movie" },
        viewBtn: { dataset: { type: "movie" } },
      }
    );
    const mapped = mapper(movieItem);
    assert.equal(mapped.type, "movie");
    assert.equal(mapped.showId, null, "a plain movie must not get a truthy showId");
  });

  it("openListDetailsPage's customlist:v1: derivation: a plain movie gets no showId (23_client-list-management.js)", () => {
    const mapper = loadInlineItemMapper(
      "23_client-list-management.js",
      "const itemsToProcess = isCw ? (typeof dedupeContinueWatchingItems === 'function' ? dedupeContinueWatchingItems(rawItems) : rawItems) : rawItems;\n          const sample = itemsToProcess.map((it) => {",
      0,
      {
        formatWatchItemLabel,
        isCw: false,
        isWatchlist: false,
        isHistory: false,
        match: { slug: "imdb-top-rated-movies", type: "movie" },
        type: "movie",
      }
    );
    const mapped = mapper(movieItem);
    assert.equal(mapped.type, "movie");
    assert.equal(mapped.showId, null, "a plain movie must not get a truthy showId");
  });

  it("a genuine show item still keeps its showId (both call sites)", () => {
    const showItem = { showId: "tt2000000", showTitle: "Some Show", type: "series", id: "tt2000000:1:1" };
    const creatorMapper = loadInlineItemMapper(
      "22_client-creator-profile.js",
      "const sample = rawListItems.map((it) => {",
      0,
      {
        formatWatchItemLabel,
        isCw: false,
        isWatchlist: false,
        isHistory: false,
        list: { slug: "some-shows", type: "series" },
        viewBtn: { dataset: { type: "series" } },
      }
    );
    const mapped = creatorMapper(showItem);
    assert.equal(mapped.type, "series");
    assert.equal(mapped.showId, "tt2000000");
  });
});

describe("list-details grid never renders a duplicate page (defense in depth)", () => {
  // Second layer for the same 200-vs-250 bug: even with fetchCustomListCatalog
  // now paginating correctly, appendItems should never let a page that
  // repeats already-seen ids double up the rendered grid -- the dedup
  // check right above it already knew those items weren't new (newCount),
  // it just didn't act on that before concatenating them in.
  it("a page that repeats already-seen ids is not concatenated into the grid a second time", () => {
    const seenItemIds = new Set();
    const winState = { _currentListDetailsAllItems: [] };
    const appendItems = loadOneClientFunction("23_client-list-management.js", "appendItems", {
      seenItemIds,
      window: winState,
      annotatePersonalItem: (it) => it,
      listUrl: "customlist:v1:...",
      name: "Test List",
      renderPosterGridChunked: () => {},
      gridEl: {},
    });
    const page1 = [{ id: "tt1" }, { id: "tt2" }];
    const newCount1 = appendItems(page1);
    // A source that doesn't actually honor skip repeats the same page.
    const newCount2 = appendItems(page1);

    assert.equal(newCount1, 2);
    assert.equal(newCount2, 0, "the repeated page must be detected as contributing nothing new");
    assert.equal(
      winState._currentListDetailsAllItems.length,
      2,
      "the repeated page's items must not be rendered a second time"
    );
  });
});

describe("liked lists feed: this add-on's own lists", () => {
  it("fetches real name/creator/type/count/likes for an own-platform liked list, and gives it a real fetchable URL for posters (unit)", async () => {
    let renderedLists = null;
    const fetchedUrls = [];
    const makeContainer = () => ({ innerHTML: "", dataset: {}, children: [], innerText: "" });
    const renderLikedListsFeed = loadOneClientFunction("19_client-search-and-likes.js", "renderLikedListsFeed", {
      ORIGIN: "https://example.test",
      document: { getElementById: (id) => (id === "likedListsFeed" ? makeContainer() : null) },
      getLikedListsSet: () => new Set(["alice/my-list"]),
      ensureMdblistPopularLoaded: async () => [],
      guessNameFromUrl: (u) => "Guessed " + u,
      render5PosterListsFeed: (_container, lists) => { renderedLists = lists; },
      fetch: async (url) => {
        fetchedUrls.push(url);
        return {
          json: async () => ({ ok: true, name: "Alice's Real List", creator: "alice", type: "movie", itemCount: 42, likes: 7 }),
        };
      },
    });
    await renderLikedListsFeed();

    assert.ok(fetchedUrls.some((u) => u === "https://example.test/lists/alice/my-list.json?format=object"), `expected the real list-detail endpoint to be fetched, got: ${JSON.stringify(fetchedUrls)}`);
    assert.ok(renderedLists, "expected render5PosterListsFeed to have been called");
    const own = renderedLists.find((l) => l.kind === "own");
    assert.ok(own, "expected an own-platform entry");
    assert.equal(own.usernameSlug, "alice/my-list");
    // The bug: this used to always be a generic "Community" placeholder
    // with a hardcoded item/like count and no poster field at all.
    assert.equal(own.name, "Alice's Real List");
    assert.equal(own.user, "alice");
    assert.equal(own.items, 42);
    assert.equal(own.likes, 7);
    // A real, fetchable URL -- what lets the existing poster-preview
    // mechanism (populateSearchResultPosters, keyed off .url) show real
    // posters instead of none.
    assert.equal(own.url, "https://example.test/lists/alice/my-list");
  });

  it("falls back gracefully when the liked list was deleted/unpublished since (unit)", async () => {
    let renderedLists = null;
    const makeContainer = () => ({ innerHTML: "", dataset: {}, children: [], innerText: "" });
    const renderLikedListsFeed = loadOneClientFunction("19_client-search-and-likes.js", "renderLikedListsFeed", {
      ORIGIN: "https://example.test",
      document: { getElementById: (id) => (id === "likedListsFeed" ? makeContainer() : null) },
      getLikedListsSet: () => new Set(["alice/gone-list"]),
      ensureMdblistPopularLoaded: async () => [],
      guessNameFromUrl: (u) => "Guessed " + u,
      render5PosterListsFeed: (_container, lists) => { renderedLists = lists; },
      fetch: async () => ({ json: async () => ({ ok: false, error: "No list found at that address." }) }),
    });
    await renderLikedListsFeed();
    const own = renderedLists.find((l) => l.kind === "own");
    assert.ok(own, "expected an own-platform entry even when the real fetch fails");
    assert.equal(own.usernameSlug, "alice/gone-list");
    assert.equal(own.url, "");
  });
});

describe("delete-account confirmation", () => {
  it("client sends the confirm:'DELETE' the server requires (unit)", async () => {
    let capturedBody = null;
    const handleDeleteAccount = loadOneClientFunction("22_client-creator-profile.js", "handleDeleteAccount", {
      ORIGIN: "https://example.test",
      activeCreator: { creatorName: "alicedelete", displayName: "Alice" },
      document: { getElementById: () => null },
      localStorage: { getItem: () => "MYL-TEST-KEY1-KEY2" },
      fetch: async (_url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return { json: async () => ({ ok: true }) };
      },
      clearLocalAccountData: () => {},
      closeModal: () => {},
      showAddedToast: () => {},
    });
    await handleDeleteAccount();
    assert.ok(capturedBody, "expected handleDeleteAccount to have called fetch");
    // The actual bug: this call never sent `confirm` at all, so the
    // server's own check (see the next test) rejected every real delete
    // attempt with "Missing confirmation." no matter how the person
    // confirmed in the modal.
    assert.equal(capturedBody.confirm, "DELETE");
    assert.equal(capturedBody.creatorName, "alicedelete");
  });

  it("server rejects a delete-account request with no confirm field (HTTP level)", async () => {
    const env = makeEnv();
    const alice = await createUser(env, "alicedelnoconfirm");
    const r = await call(env, "/api/creator/delete-account", {
      method: "POST",
      json: { creatorName: alice.creatorName, creatorKey: alice.creatorKey },
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error || "", /confirmation/i);
  });

  it("server accepts and completes a delete-account request with confirm:'DELETE' (HTTP level)", async () => {
    const env = makeEnv();
    const alice = await createUser(env, "alicedelconfirm");
    const r = await call(env, "/api/creator/delete-account", {
      method: "POST",
      json: { creatorName: alice.creatorName, creatorKey: alice.creatorKey, confirm: "DELETE" },
    });
    assert.equal(r.body.ok, true, `expected ok, got ${JSON.stringify(r.body)}`);
    // The identity itself is gone -- the same key no longer authenticates.
    const restore = await call(env, "/api/creator/restore", {
      method: "POST",
      json: { creatorName: alice.creatorName, creatorKey: alice.creatorKey },
    });
    assert.equal(restore.status, 401);
  });
});

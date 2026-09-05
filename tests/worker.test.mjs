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

// Files 09-24's own text is embedded as STRING CONTENT inside
// 09_page-shell.js's outer template literal (renderBuilder's giant
// backtick string -- see that file's own build-time concatenation
// comment), so by the time a real browser parses any of this code, it
// has already passed through one round of template-literal string-escape
// cooking: \\ -> \, \n/\t/\r/\b/\f/\v/\0/`/$ -> their real characters,
// \xHH and \uHHHH/\u{H...} -> the character they encode, and a backslash
// before anything else is simply dropped (\d -> d, \s -> s, \. -> .,
// \b\w -> a real word-boundary + word-char only if written \\b\\w in the
// source, since a single \b is ITS OWN recognized escape -- a backspace
// character -- eating that backslash a layer early). A regex literal
// that needs a real backslash-escape to survive into the browser has to
// be double-escaped in these files' own source for exactly that reason.
// loadOneClientFunction/loadInlineItemMapper below read the raw source
// file directly and hand it straight to vm, skipping that cooking pass
// entirely -- so without reproducing it here, a correctly double-escaped
// regex (the one that actually works in production) would test as its
// naive, uncooked, WRONG meaning instead (e.g. \\b\\w as vm sees it
// literally matches the 4-character text "\b\w", not a word boundary).
function cookTemplateLiteralEscapes(text) {
  return text.replace(/\\(?:x([0-9a-fA-F]{2})|u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|(\r\n|[\s\S]))/g, (_m, hex2, hexBrace, hex4, other) => {
    if (hex2 !== undefined) return String.fromCharCode(parseInt(hex2, 16));
    if (hexBrace !== undefined) return String.fromCodePoint(parseInt(hexBrace, 16));
    if (hex4 !== undefined) return String.fromCharCode(parseInt(hex4, 16));
    switch (other) {
      case "\\": return "\\";
      case "n": return "\n";
      case "t": return "\t";
      case "r": return "\r";
      case "b": return "\b";
      case "f": return "\f";
      case "v": return "\v";
      case "0": return "\0";
      case "`": return "`";
      case "$": return "$";
      case "\n": return "";
      case "\r\n": return "";
      default: return other;
    }
  });
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
  vm.runInContext(cookTemplateLiteralEscapes(src.slice(start, end)), sandbox, { filename: `${relFile}#${fnName}` });
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
  const body = cookTemplateLiteralEscapes(src.slice(braceStart, end));
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
    // The key is required to ATTRIBUTE a thread to an account: /api/feedback
    // proves any claimed creatorName before storing it, and silently drops a
    // claim it cannot verify (an unverifiable claim must not close the
    // support channel -- see that endpoint's own comment). Without the key
    // here the thread would be filed anonymously and the by-name lookup
    // below would correctly not find it.
    const posted = await call(env, "/api/feedback", {
      method: "POST",
      json: {
        message: "secret report",
        creatorName: alice.creatorName,
        creatorKey: alice.creatorKey,
        contact: "me@example.com",
      },
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
      json: { creatorName: alice.creatorName, creatorKey: alice.creatorKey, message: "my recent report" },
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

// A support thread holds free-text messages plus the contact address the
// feedback form asks for, and /api/feedback/threads hands the whole thing to
// anyone presenting the thread id -- deliberately, so anonymous reporters can
// follow up. That makes the id a capability, and it was minted with
// Math.random(): ~31 bits from a PRNG whose state is recoverable from a few
// outputs. Worse, the id alone let a stranger APPEND to any thread, choosing
// the display name the admin panel renders as the sender.
describe("audit fix: support threads are capabilities, not open mailboxes", () => {
  it("mints thread ids from the CSPRNG, not Math.random", async () => {
    const env = makeEnv();
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const r = await call(env, "/api/feedback", { method: "POST", json: { message: `report ${i}` } });
      ids.push(r.body.entry.id);
    }
    for (const id of ids) {
      const random = id.split(":")[1] || "";
      // generateShortId is 9 random bytes base64url-encoded -> 12 chars.
      // Math.random().toString(36).slice(2, 8) was 6.
      assert.equal(random.length, 12, `thread id "${id}" does not carry a 12-char random part`);
      assert.match(random, /^[A-Za-z0-9_-]{12}$/);
    }
    assert.equal(new Set(ids).size, ids.length, "thread ids collided");
    // The timestamp prefix has to stay: /admin/api/feedback relies on these
    // keys sorting chronologically.
    assert.match(ids[0], /^\d{10,}:/);
  });

  it("will not let a stranger append to a thread that belongs to an account", async () => {
    const env = makeEnv();
    const alice = await createUser(env, "alicethread");
    const posted = await call(env, "/api/feedback", {
      method: "POST",
      json: {
        message: "my private bug report",
        contact: "victim@example.com",
        creatorName: alice.creatorName,
        creatorKey: alice.creatorKey,
      },
    });
    const threadId = posted.body.entry.id;
    assert.equal(posted.body.entry.creatorName, alice.creatorName);

    const stranger = await call(env, "/api/feedback", {
      method: "POST", ip: nextIp(),
      json: { threadId, message: "injected by stranger", creatorName: "Developer" },
    });
    assert.equal(stranger.status, 403, "a stranger holding the id could still write into an owned thread");
    assert.equal(stranger.body.ok, false);

    // The owner themselves is of course still fine.
    const owner = await call(env, "/api/feedback", {
      method: "POST",
      json: { threadId, message: "following up", creatorName: alice.creatorName, creatorKey: alice.creatorKey },
    });
    assert.equal(owner.body.ok, true, owner.body.error);
    assert.equal(owner.body.entry.messages.length, 2);
  });

  it("keeps anonymous threads reachable by id, but not the sender name", async () => {
    // The id-as-capability model is the point for someone with no account,
    // so this must keep working -- what must not is choosing who the message
    // appears to be from.
    const env = makeEnv();
    const anon = await call(env, "/api/feedback", { method: "POST", json: { message: "anonymous report" } });
    const threadId = anon.body.entry.id;

    const reply = await call(env, "/api/feedback", {
      method: "POST", ip: nextIp(),
      json: { threadId, message: "a follow-up", creatorName: "Developer" },
    });
    assert.equal(reply.body.ok, true, "anonymous follow-up by thread id must still work");
    const names = reply.body.entry.messages.map((m) => m.senderName);
    assert.ok(!names.includes("Developer"), `sender name was taken from the request body: ${names.join(", ")}`);
    assert.ok(reply.body.entry.messages.every((m) => m.sender === "user"));
  });

  it("drops an identity claim it cannot prove instead of storing it", async () => {
    const env = makeEnv();
    const alice = await createUser(env, "alicevictim");
    const impersonation = await call(env, "/api/feedback", {
      method: "POST",
      json: { message: "impersonation attempt", creatorName: alice.creatorName },
    });
    // The message still goes through -- this is the support channel, and
    // someone whose key has stopped working is exactly who needs it -- but
    // the unproven name is not recorded.
    assert.equal(impersonation.body.ok, true, "an unverifiable claim must not close the support channel");
    assert.equal(impersonation.body.entry.creatorName, null, "an unproven creatorName was stored");
    assert.equal(impersonation.body.entry.messages[0].senderName, "User");

    // ...and it must not show up in the real account's thread list.
    const mine = await call(env, "/api/feedback/threads", {
      method: "POST",
      json: { creatorName: alice.creatorName, creatorKey: alice.creatorKey },
    });
    assert.equal(mine.body.threads.some((t) => t.id === impersonation.body.entry.id), false);
  });

  it("leaves the admin panel's own self-logging and replies working", async () => {
    // submitAdminFeedback posts creatorName:"admin" with fromAdminPanel:true
    // and no key -- "admin" is a marker feedbackCardHtml keys off, not a
    // Creator Profile, so it must not be run through creator auth.
    const env = makeEnv();
    const alice = await createUser(env, "aliceadminfb");
    const owned = await call(env, "/api/feedback", {
      method: "POST",
      json: { message: "user report", creatorName: alice.creatorName, creatorKey: alice.creatorKey },
    });
    const cookie = await adminCookie(env);

    const selfLog = await call(env, "/api/feedback", {
      method: "POST", cookie,
      json: { category: "bug", message: "logged by admin", creatorName: "admin", fromAdminPanel: true },
    });
    assert.equal(selfLog.body.ok, true, selfLog.body.error);
    assert.equal(selfLog.body.entry.creatorName, "admin", "the admin self-log marker was stripped");

    // And the admin must still be able to answer a thread they do not own.
    const reply = await call(env, "/api/feedback", {
      method: "POST", cookie,
      json: { threadId: owned.body.entry.id, message: "admin here", fromAdminPanel: true },
    });
    assert.equal(reply.body.ok, true, reply.body.error);
    assert.equal(reply.body.entry.messages.slice(-1)[0].senderName, "Developer");
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

// Cloudflare aborts a Worker invocation after 1,000 subrequests, and KV
// reads count. The index rebuild used to be a single unbounded pass at
// roughly two reads per list, so past ~500 public lists it threw partway,
// the throw was swallowed by the ctx.waitUntil(...).catch(...) at its only
// call sites, the index was never written, and /lists/public.json fell back
// to the legacy bounded scan -- the alphabetically-first 100 creators,
// permanently, with nothing logged that a user or operator would ever see.
//
// These tests run the rebuild against a KV that enforces the real limit, so
// a regression to any single-pass scan fails here instead of silently in
// production.
describe("audit fix: the public list index rebuilds at any scale", () => {
  // Throws exactly the way the runtime does once an invocation has spent
  // its subrequest budget. Reset between invocations, never within one.
  function cappedKv(initial = {}, cap = 1000) {
    const inner = makeKv(initial);
    let n = 0;
    let peak = 0;
    const charge = () => {
      n += 1;
      if (n > peak) peak = n;
      if (n > cap) throw new Error("Too many subrequests.");
    };
    return {
      _store: inner._store,
      _resetInvocation: () => { n = 0; },
      _peak: () => peak,
      async get(...a) { charge(); return inner.get(...a); },
      async put(...a) { charge(); return inner.put(...a); },
      async delete(...a) { charge(); return inner.delete(...a); },
      async list(...a) { charge(); return inner.list(...a); },
    };
  }

  function seedPublicLists(store, count) {
    for (let i = 0; i < count; i++) {
      const username = `user${String(i).padStart(5, "0")}`;
      store.set(`creator:${username}`, JSON.stringify({
        displayName: `Real ${username}`, keyHash: "pbkdf2:1:00:00", createdAt: 1,
      }));
      store.set(`creatorlist:${username}:list-${i}`, JSON.stringify({
        name: `List ${i}`, slug: `list-${i}`, type: "movie", visibility: "public",
        items: [{ id: "tt0111161", name: "Item" }], likes: i % 7, createdAt: 1, updatedAt: 1,
      }));
    }
  }

  // Drives cron-shaped ticks until the index lands. Each tick is a separate
  // invocation, so each gets a fresh subrequest budget -- which is the whole
  // point of chunking the rebuild.
  async function driveToCompletion(env, kv, maxTicks = 200) {
    for (let tick = 1; tick <= maxTicks; tick++) {
      kv._resetInvocation();
      kv._store.delete("lock:publiclistindex");
      await call(env, "/lists/public.json");
      if (kv._store.has("index:publiclists")) return tick;
    }
    return -1;
  }

  it("indexes every list past the point a single-pass scan died", async () => {
    const n = 1000;
    const kv = cappedKv({}, 1000);
    seedPublicLists(kv._store, n);
    const env = makeEnv({ CONFIGS: kv });

    const ticks = await driveToCompletion(env, kv);
    assert.notEqual(ticks, -1, "index never completed");
    assert.ok(kv._peak() <= 1000, `one invocation spent ${kv._peak()} subrequests, over the limit`);

    kv._resetInvocation();
    const listing = await call(env, "/lists/public.json?limit=500");
    assert.equal(listing.body.total, n, `directory reports ${listing.body.total} of ${n} lists`);
  });

  it("survives invisible records that cost a read but never reach the directory", async () => {
    // rebuildPublicListIndex must read a record before it can test
    // visibility, so a private list costs the same as a public one.
    // /api/publish-list is unauthenticated and its records default to
    // private, which made this a way to break the directory on purpose:
    // ~900 of them took a 20-list deployment past the limit for good.
    const kv = cappedKv({}, 1000);
    seedPublicLists(kv._store, 20);
    for (let i = 0; i < 900; i++) {
      kv._store.set(`publishedlist:user:junk-${i}`, JSON.stringify({
        name: "junk", visibility: "private", items: [{ id: "tt0111161" }],
      }));
    }
    const env = makeEnv({ CONFIGS: kv });

    assert.notEqual(await driveToCompletion(env, kv), -1, "index never completed");
    assert.ok(kv._peak() <= 1000, `one invocation spent ${kv._peak()} subrequests, over the limit`);

    kv._resetInvocation();
    const listing = await call(env, "/lists/public.json?limit=500");
    assert.equal(listing.body.total, 20, "the 20 real lists must still all be listed");
  });

  it("publishes the index only once, and cleans up after itself", async () => {
    const kv = cappedKv({}, 1000);
    seedPublicLists(kv._store, 700);
    const env = makeEnv({ CONFIGS: kv });

    await driveToCompletion(env, kv);
    // A partial scan must never be published as though it were complete,
    // and the resume state must not outlive the build that used it.
    assert.equal(kv._store.has("index:publiclists:build"), false, "build state leaked");
    const settled = kv._store.get("index:publiclists");
    for (let i = 0; i < 3; i++) {
      kv._resetInvocation();
      await call(env, "/lists/public.json");
    }
    assert.equal(kv._store.get("index:publiclists"), settled, "a completed index was rebuilt needlessly");
  });

  it("restarts cleanly from unparseable or stale resume state", async () => {
    for (const bad of ["{not json", JSON.stringify({ v: 0, phase: 99 })]) {
      const kv = cappedKv({}, 1000);
      seedPublicLists(kv._store, 200);
      kv._store.set("index:publiclists:build", bad);
      const env = makeEnv({ CONFIGS: kv });
      assert.notEqual(await driveToCompletion(env, kv), -1, "index never completed");
      kv._resetInvocation();
      const listing = await call(env, "/lists/public.json?limit=500");
      assert.equal(listing.body.total, 200, `stale state ${bad.slice(0, 12)} lost lists`);
    }
  });

  it("loses nothing and duplicates nothing under concurrent rebuild attempts", async () => {
    const n = 900;
    // Deliberately NOT the capped KV here: five concurrent requests are five
    // separate Worker invocations with five separate subrequest budgets, and
    // a single shared counter would model that wrongly. The budget is
    // covered by the tests above; this one is about the lock and the resume
    // state holding up when chunks race.
    const kv = makeKv();
    seedPublicLists(kv._store, n);
    const env = makeEnv({ CONFIGS: kv });

    for (let round = 0; round < 60 && !kv._store.has("index:publiclists"); round++) {
      kv._store.delete("lock:publiclistindex");
      await Promise.all([0, 1, 2, 3, 4].map(() => call(env, "/lists/public.json")));
    }
    const entries = JSON.parse(kv._store.get("index:publiclists") || '{"entries":[]}').entries;
    assert.equal(entries.length, n);
    assert.equal(new Set(entries.map((e) => e.id)).size, n, "duplicate entries in the index");
  });

  it("/admin/api/rebuild-public-index reports progress and finishes across calls", async () => {
    const n = 1500;
    const kv = cappedKv({}, 1000);
    seedPublicLists(kv._store, n);
    const env = makeEnv({ CONFIGS: kv });
    const cookie = await adminCookie(env);

    let calls = 0;
    let scanned = 0;
    let last;
    do {
      calls += 1;
      kv._resetInvocation();
      last = await call(env, "/admin/api/rebuild-public-index", { method: "POST", cookie });
      assert.equal(last.body.ok, true);
      scanned += last.body.scanned || 0;
    } while (!last.body.done && calls < 100);

    assert.equal(last.body.done, true, "rebuild never reported done");
    assert.equal(last.body.count, n);
    assert.ok(scanned >= n, `scanned ${scanned}, expected at least ${n}`);
    assert.ok(kv._peak() <= 1000, `one invocation spent ${kv._peak()} subrequests, over the limit`);
  });
});

// /api/creator/reset-key hands back a brand-new working Creator Key on a
// correct recovery answer, so that answer is a second credential for full
// account takeover -- and unlike the ~60-bit key it is free text a human
// picked, lowercased before hashing. It was throttled per IP only, which
// throttles the wrong dimension entirely: rotating source addresses is free,
// the account being attacked cannot be swapped out. Rotating IPs took over a
// test account in five guesses.
describe("audit fix: recovery answers are throttled per account, not just per IP", () => {
  // The attack verbatim: a new source IP on every single guess.
  async function guessWithRotatingIps(env, username, answers) {
    for (let i = 0; i < answers.length; i++) {
      const r = await call(env, "/api/creator/reset-key", {
        method: "POST",
        ip: nextIp(),
        json: { username, recoveryAnswer: answers[i] },
      });
      if (r.body && r.body.ok) return { tookOver: true, atGuess: i + 1 };
    }
    return { tookOver: false };
  }
  const wrongThenRight = (correct, wrongCount) =>
    Array.from({ length: wrongCount }, (_, i) => `wrong-answer-${i}`).concat([correct]);

  // Run against both stores. The D1 path is not redundant: it takes a
  // different code path (an atomic upsert instead of a KV read-modify-write),
  // and the first version of this throttle counted nothing at all there
  // while passing on KV, because its hand-written INSERT used a statement
  // shape d1BumpStat does not.
  for (const [label, makeStores] of [
    ["KV only", () => ({ CONFIGS: makeKv() })],
    ["D1 bound", () => ({ CONFIGS: makeKv(), DB: makeD1() })],
  ]) {
    it(`blocks a rotating-IP takeover (${label})`, async () => {
      const env = makeEnv(makeStores());
      await createUser(env, "victimacct", { recoveryAnswer: "fluffy-the-cat" });
      const res = await guessWithRotatingIps(env, "victimacct", wrongThenRight("fluffy-the-cat", 20));
      assert.equal(res.tookOver, false, `account taken over on guess #${res.atGuess} despite the per-account budget`);
    });

    it(`still lets the real owner in, before and after honest typos (${label})`, async () => {
      const env = makeEnv(makeStores());
      await createUser(env, "goodacct", { recoveryAnswer: "correct-horse-battery" });
      const first = await call(env, "/api/creator/reset-key", {
        method: "POST", ip: nextIp(),
        json: { username: "goodacct", recoveryAnswer: "correct-horse-battery" },
      });
      assert.equal(first.body.ok, true, "a correct answer must work first time");

      // A few genuine typos must not lock the owner out, and succeeding must
      // not spend the budget that protects them.
      const env2 = makeEnv(makeStores());
      await createUser(env2, "typoacct", { recoveryAnswer: "correct-horse-battery" });
      await guessWithRotatingIps(env2, "typoacct", ["nope-one", "nope-two", "nope-three"]);
      const late = await call(env2, "/api/creator/reset-key", {
        method: "POST", ip: nextIp(),
        json: { username: "typoacct", recoveryAnswer: "correct-horse-battery" },
      });
      assert.equal(late.body.ok, true, `locked out after honest typos: ${late.body.error}`);
    });
  }

  it("one account's budget cannot be spent by guesses at another", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    await createUser(env, "targetacct", { recoveryAnswer: "correct-horse-battery" });
    await createUser(env, "bystanderacct", { recoveryAnswer: "different-answer-here" });
    await guessWithRotatingIps(env, "targetacct", wrongThenRight("nope", 12));
    // Exhausting one account must leave every other account untouched...
    const other = await call(env, "/api/creator/reset-key", {
      method: "POST", ip: nextIp(),
      json: { username: "bystanderacct", recoveryAnswer: "different-answer-here" },
    });
    assert.equal(other.body.ok, true, "an unrelated account was locked out too");
  });

  it("guesses at a username that does not exist never mint a budget", async () => {
    // Unknown names must not create per-account counters -- otherwise anyone
    // can grow that keyspace for free by guessing at names at random.
    const kv = makeKv();
    const env = makeEnv({ CONFIGS: kv });
    for (let i = 0; i < 8; i++) {
      const r = await call(env, "/api/creator/reset-key", {
        method: "POST", ip: nextIp(),
        json: { username: `ghostacct${i}`, recoveryAnswer: "whatever-here" },
      });
      assert.equal(r.body.ok, false);
    }
    const minted = [...kv._store.keys()].filter((k) => k.startsWith("authfail:"));
    assert.deepEqual(minted, [], `unknown usernames minted counters: ${minted.join(", ")}`);
  });

  it("requires a recovery answer long enough to be worth having", async () => {
    const env = makeEnv();
    const short = await call(env, "/api/creator/create", {
      method: "POST", ip: nextIp(),
      json: { creatorName: "shortanswer", recoveryAnswer: "cat" },
    });
    assert.equal(short.body.ok, false, "a 3-character recovery answer was accepted");
    assert.equal(short.status, 400);

    const long = await call(env, "/api/creator/create", {
      method: "POST", ip: nextIp(),
      json: { creatorName: "longanswer", recoveryAnswer: "my-first-pet-was-rex" },
    });
    assert.equal(long.body.ok, true, long.body.error);

    // It stays optional -- this must not become a required field.
    const none = await call(env, "/api/creator/create", {
      method: "POST", ip: nextIp(),
      json: { creatorName: "noanswer" },
    });
    assert.equal(none.body.ok, true, none.body.error);
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

  it("guessNameFromUrl's title-case regex must stay double-escaped (\\\\b\\\\w) to survive being embedded in 09_page-shell.js's own template literal", () => {
    // This is the actual reported bug behind "it names it like this imdb
    // top rated movies" resurfacing later as "HD documentary movies 1980
    // to today" (only the acronym step ran; every other word stayed
    // lowercase). A PAST fix here ("Previously /\\b\\w/g... this never
    // actually matched anything") swapped a correctly *double*-escaped
    // regex for a single-escaped one, believing the double escaping was
    // the bug. It wasn't: this file's own text is embedded as string
    // content inside 09_page-shell.js's outer template literal, so it
    // passes through one round of backslash escape-cooking (see
    // cookTemplateLiteralEscapes's own comment above) before a browser
    // ever parses it as code. A single \b\w survives that pass as a
    // regex matching a literal backspace byte + "w" (matches nothing,
    // silently no-ops, exactly the bug this reintroduced); \\b\\w
    // survives it as the real word-boundary + word-character regex this
    // is supposed to be. (Proven directly against a git checkout of the
    // single-escaped version during development -- see this fix's PR --
    // rather than re-deriving that here on every run.)
    assert.equal(
      guessNameFromUrl("https://mdblist.com/lists/hdlists/hd-documentary-movies-1980-to-today"),
      "HD Documentary Movies 1980 To Today"
    );
  });

  it("parseListSearchIntent's source-prefix detection needs the same double-escaping (found while fixing the above)", () => {
    // Same root cause, same file, a few lines up: \b\s escapes here were
    // also single-escaped, so every one of these regexes matched nothing
    // at all -- typing "mdblist trending movies" in Lists > Search never
    // detected MDBList as the source or stripped it from the search term.
    // Compared field-by-field rather than via deepEqual on the whole
    // object -- it's built inside a separate vm realm, whose Object
    // prototype differs from this test file's own, which trips
    // deepStrictEqual's own-realm check even when every field matches.
    const parseListSearchIntent = loadOneClientFunction("19_client-search-and-likes.js", "parseListSearchIntent");
    const mdb = parseListSearchIntent("mdblist trending movies");
    assert.equal(mdb.term, "trending movies");
    assert.equal(mdb.source, "MDBList");
    assert.equal(mdb.isSourceOnly, false);
    const trakt = parseListSearchIntent("trakt top picks");
    assert.equal(trakt.term, "top picks");
    assert.equal(trakt.source, "Trakt");
    assert.equal(parseListSearchIntent("just a plain search").source, null);
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

describe("a catalog row never keeps a raw URL as its own name", () => {
  // Reported bug: a row added with the pasted URL also sitting in the
  // "name" field (however that happened) showed that raw URL as both the
  // Live Preview shelf's title and its See All page's title -- and on
  // mobile, a long unbroken URL forced the See All header's like/+Add
  // buttons off the edge of the screen, since they share a flex row with
  // the title (see #detailTitle's own min-width: 0 fix in
  // 09_page-shell.js). addRow now falls back to guessNameFromUrl for a
  // URL-shaped name so a raw URL never reaches the DOM as a "name" at all.
  function makeMockDiv() {
    return { className: "", dataset: {}, classList: { add: () => {} }, innerHTML: "", querySelector: () => null };
  }

  it("addRow substitutes a humanized name when the given name is itself a URL", () => {
    const guessNameFromUrl = loadOneClientFunction("19_client-search-and-likes.js", "guessNameFromUrl");
    let createdDiv = null;
    const addRow = loadOneClientFunction("16_client-row-core.js", "addRow", {
      guessNameFromUrl,
      escapeHtml: (s) => String(s == null ? "" : s),
      escapeAttr: (s) => String(s == null ? "" : s),
      entryAvatarColor: () => "#000",
      sourceRowHtml: () => "<div></div>",
      updateSourceRemoveButtons: () => {},
      relocateAddSourceBtn: () => {},
      initTouchDrag: () => {},
      checkAllDuplicateUrls: () => {},
      renumber: () => {},
      showAddedToast: () => {},
      suppressSave: false,
      document: {
        getElementById: () => ({ appendChild: () => {} }),
        createElement: () => { createdDiv = makeMockDiv(); return createdDiv; },
      },
    });

    const rawUrl = "https://mdblist.com/lists/hdlists/hd-documentary-movies-1980-to-today";
    addRow(rawUrl, rawUrl, "movie", true, "Custom");

    assert.ok(createdDiv, "expected addRow to create the row element");
    assert.ok(!createdDiv.innerHTML.includes(rawUrl), "the raw URL must not end up anywhere in the row's own markup");
    assert.ok(
      createdDiv.innerHTML.includes('value="HD Documentary Movies 1980 To Today"'),
      `expected the .name input to carry the humanized name, got: ${createdDiv.innerHTML.slice(0, 400)}`
    );
    assert.ok(
      createdDiv.innerHTML.includes("HD Documentary Movies 1980 To Today - Movies"),
      "expected the Live Preview shelf title to carry the humanized name too"
    );
  });

  it("addRow leaves an already-real name untouched", () => {
    const guessNameFromUrl = loadOneClientFunction("19_client-search-and-likes.js", "guessNameFromUrl");
    let createdDiv = null;
    const addRow = loadOneClientFunction("16_client-row-core.js", "addRow", {
      guessNameFromUrl,
      escapeHtml: (s) => String(s == null ? "" : s),
      escapeAttr: (s) => String(s == null ? "" : s),
      entryAvatarColor: () => "#000",
      sourceRowHtml: () => "<div></div>",
      updateSourceRemoveButtons: () => {},
      relocateAddSourceBtn: () => {},
      initTouchDrag: () => {},
      checkAllDuplicateUrls: () => {},
      renumber: () => {},
      showAddedToast: () => {},
      suppressSave: false,
      document: {
        getElementById: () => ({ appendChild: () => {} }),
        createElement: () => { createdDiv = makeMockDiv(); return createdDiv; },
      },
    });

    addRow("My Favorite Movies", "https://mdblist.com/lists/hdlists/hd-documentary-movies-1980-to-today", "movie", true, "Custom");
    assert.ok(createdDiv.innerHTML.includes('value="My Favorite Movies"'));
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
      appendPosterGridItems: () => {},
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

describe("list-details See All scrolls smoothly through a large multi-page list", () => {
  // The reported bug: scrolling through a large (100-200+ item) list's See
  // All from Live Preview & Editor was janky/jumpy, unlike Your Custom
  // Lists' own See All (which embeds the whole list up front and never
  // re-renders). Root cause: every new page appendItems received got
  // rendered by handing the WHOLE accumulated item list to
  // renderPosterGridChunked, which clears the grid (innerHTML = '') and
  // rebuilds it from scratch -- tearing down and re-inserting every
  // already-loaded poster card (discarding its already-decoded image)
  // on every single page as the user scrolled. Fixed by only ever
  // appending each new page's own items via appendPosterGridItems, which
  // never clears the grid.
  it("appendItems appends only each new page's own items, and never rebuilds the whole grid", () => {
    const renderCalls = [];
    const appendCalls = [];
    const winState = {};
    const appendItems = loadOneClientFunction("23_client-list-management.js", "appendItems", {
      seenItemIds: new Set(),
      window: winState,
      annotatePersonalItem: (it) => it,
      listUrl: "https://trakt.tv/users/someone/lists/big-list",
      name: "Big List",
      gridEl: { isConnected: true },
      renderPosterGridChunked: (_grid, items) => { renderCalls.push(items.length); },
      appendPosterGridItems: (_grid, items) => { appendCalls.push(items.length); },
    });

    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: "tt" + i, type: "movie" }));
    const page2 = Array.from({ length: 100 }, (_, i) => ({ id: "tt" + (100 + i), type: "movie" }));
    const page3 = Array.from({ length: 50 }, (_, i) => ({ id: "tt" + (200 + i), type: "movie" }));
    appendItems(page1);
    appendItems(page2);
    appendItems(page3);

    assert.deepEqual(renderCalls, [], "appendItems must never call the full-rebuild renderer (that stays reserved for switching Movies/Shows/All tabs)");
    assert.deepEqual(appendCalls, [100, 100, 50], "each page must append only its own new items, not the whole accumulated list");
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

// ---------------------------------------------------------------------------
// Audit 2026-09-05 -- regression tests for the four production blockers.
// Each test fails against the code as it was before the corresponding fix.
// ---------------------------------------------------------------------------

describe("audit fix 1: /api/track-event cannot mint unbounded KV keys", () => {
  it("ignores list-copy ids that are not one of this add-on's own list URLs", async () => {
    const env = makeEnv();
    const events = [];
    for (let i = 0; i < 40; i++) {
      events.push({ eventType: "list-copy", id: "SPAM-<img src=x onerror=alert(1)>-" + i });
    }
    // External provider URLs are legitimate input but are not lists this
    // dashboard can show a copy count for -- they must not mint keys either.
    events.push({ eventType: "list-copy", id: "https://mdblist.com/lists/someone/their-list" });
    const r = await call(env, "/api/track-event", { method: "POST", json: { events } });
    assert.equal(r.status, 200);
    const minted = [...env.CONFIGS._store.keys()].filter((k) => k.startsWith("stats:list_copy:"));
    assert.deepEqual(minted, [], `expected no keys, got ${JSON.stringify(minted.slice(0, 3))}`);
  });

  it("still records a copy of one of this add-on's own lists, keyed by its slug", async () => {
    const env = makeEnv();
    const r = await call(env, "/api/track-event", {
      method: "POST",
      json: { events: [{ eventType: "list-copy", id: "https://example.test/lists/alice/top-ten" }] },
    });
    assert.equal(r.status, 200);
    // Keyed by slug alone -- which is what computeCatalogAndCommunityLeaderboards
    // looks up (copiesBySlug.get(data.slug)), so the count is now actually readable.
    assert.equal(env.CONFIGS._store.get("stats:list_copy:top-ten:total"), "1");
  });

  it("rejects watched/list-add ids that are not real title-id shapes", async () => {
    const env = makeEnv();
    await call(env, "/api/track-event", {
      method: "POST",
      json: { events: [{ eventType: "watched", id: "<script>alert(1)</script>", title: "x" }] },
    });
    const minted = [...env.CONFIGS._store.keys()].filter((k) => k.startsWith("evtcount:") || k.startsWith("evtmeta:"));
    assert.deepEqual(minted, []);

    // A genuine id still works.
    await call(env, "/api/track-event", {
      method: "POST",
      json: { events: [{ eventType: "watched", id: "tt1234567", title: "Real Movie" }] },
    });
    assert.ok([...env.CONFIGS._store.keys()].some((k) => k.startsWith("evtcount:watched:tt1234567:")));
  });

  it("rate-limits repeated anonymous beacons from one IP", async () => {
    const env = makeEnv();
    const ip = nextIp();
    for (let i = 0; i < 40; i++) {
      await call(env, "/api/track-event", {
        method: "POST",
        ip,
        json: { events: [{ eventType: "watched", id: "tt" + i }] },
      });
    }
    const minted = [...env.CONFIGS._store.keys()].filter((k) => k.startsWith("evtmeta:watched:"));
    assert.ok(minted.length <= 30, `expected the per-IP cap to stop this at 30, got ${minted.length}`);
  });

  it("admin catalogs/lists panel stays within a bounded subrequest budget", async () => {
    const env = makeEnv();
    // Far more keys than any real deployment, as an attacker would have left behind.
    for (let i = 0; i < 3000; i++) await env.CONFIGS.put(`stats:list_copy:spam-${i}:total`, "1");
    const login = await call(env, "/admin/login", { method: "POST", form: { key: "test-admin-secret" } });
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];

    let ops = 0;
    const origGet = env.CONFIGS.get.bind(env.CONFIGS);
    const origList = env.CONFIGS.list.bind(env.CONFIGS);
    env.CONFIGS.get = async (...a) => { ops++; return origGet(...a); };
    env.CONFIGS.list = async (...a) => { ops++; return origList(...a); };

    const r = await call(env, "/admin/api/analytics?section=catalogs_lists", { cookie });
    assert.equal(r.status, 200, "panel must still render, not throw");
    // Cloudflare allows 1,000 subrequests per invocation. Before the caps this
    // was 1:1 with the key count (3,000 here) and the panel broke permanently.
    assert.ok(ops < 1000, `expected a bounded subrequest count, got ${ops}`);
  });
});

describe("audit fix 2: a like cannot revert a concurrent list save", () => {
  it("keeps the creator's newer items when a like lands mid-save", async () => {
    const env = makeEnv();
    const alice = await createUser(env, "alicelikerace");
    await call(env, "/api/creator/lists/save", {
      method: "POST",
      json: {
        creatorName: alice.creatorName, creatorKey: alice.creatorKey,
        name: "Race List", type: "movie", visibility: "public",
        items: [{ id: "tt1" }, { id: "tt2" }],
      },
    });
    const listKey = [...env.CONFIGS._store.keys()].find((k) => k.startsWith("creatorlist:alicelikerace:"));

    // Park the like immediately after it reads the list record, which is
    // the exact window applyLikeVote's KV round-trips used to leave open.
    let release;
    const gate = new Promise((r) => { release = r; });
    let reads = 0;
    const origGet = env.CONFIGS.get.bind(env.CONFIGS);
    env.CONFIGS.get = async (k, t) => {
      const v = await origGet(k, t);
      if (k === listKey && ++reads === 1) await gate;
      return v;
    };

    const likeP = call(env, "/api/lists/like", {
      method: "POST",
      json: { username: "alicelikerace", slug: "race-list", action: "like" },
    });
    await new Promise((r) => setTimeout(r, 20));
    await call(env, "/api/creator/lists/save", {
      method: "POST",
      json: {
        creatorName: alice.creatorName, creatorKey: alice.creatorKey, slug: "race-list",
        name: "Race List", type: "movie", visibility: "public",
        items: [{ id: "tt1" }, { id: "tt2" }, { id: "tt3" }, { id: "tt4" }, { id: "tt5" }],
      },
    });
    release();
    await likeP;

    const stored = JSON.parse(env.CONFIGS._store.get(listKey));
    assert.equal(stored.items.length, 5, "the like must not write back its pre-vote snapshot");
    assert.equal(stored.likes, 1, "and the like itself must still be recorded");
  });
});

describe("audit fix 4: unauthenticated permanent writes are bounded", () => {
  it("rejects an oversized published list instead of storing it", async () => {
    const env = makeEnv();
    const items = Array.from({ length: 20000 }, (_, i) => ({ id: "tt" + i, title: "X".repeat(200) }));
    const r = await call(env, "/api/publish-list", {
      method: "POST",
      json: { name: "spam list", type: "movie", items },
    });
    assert.equal(r.status, 413);
    assert.equal([...env.CONFIGS._store.keys()].filter((k) => k.startsWith("publishedlist:")).length, 0);
  });

  it("still publishes a realistically large list", async () => {
    const env = makeEnv();
    // Larger than the biggest real account list observed (~1,200 items).
    const items = Array.from({ length: 2000 }, (_, i) => ({ id: "tt" + i }));
    const r = await call(env, "/api/publish-list", {
      method: "POST",
      json: { name: "Big But Real", type: "movie", items },
    });
    assert.equal(r.body.ok, true, `expected a normal publish to succeed, got ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.equal(JSON.parse(env.CONFIGS._store.get("publishedlist:user:big-but-real")).items.length, 2000,
      "and it must be stored in full, not silently truncated");
  });

  it("rate-limits repeated anonymous publishes from one IP", async () => {
    const env = makeEnv();
    const ip = nextIp();
    let limited = 0;
    for (let i = 0; i < 15; i++) {
      const r = await call(env, "/api/publish-list", {
        method: "POST", ip,
        json: { name: "list " + i, type: "movie", items: [{ id: "tt1" }] },
      });
      if (r.status === 429) limited++;
    }
    assert.ok(limited > 0, "expected the per-IP bucket to reject some of 15 rapid publishes");
  });

  it("rejects an oversized install config instead of storing it", async () => {
    const env = makeEnv();
    const entries = Array.from({ length: 900 }, (_, i) => ({ name: "row " + i, url: "https://mdblist.com/lists/x/y" }));
    const r = await call(env, "/api/save", { method: "POST", json: { entries } });
    assert.equal(r.status, 413);
  });

  it("still saves a normal install config", async () => {
    const env = makeEnv();
    const entries = Array.from({ length: 30 }, (_, i) => ({ name: "row " + i, url: "https://mdblist.com/lists/x/y" }));
    const r = await call(env, "/api/save", { method: "POST", json: { entries } });
    assert.equal(r.body.ok, true);
    assert.ok(r.body.id);
  });
});

describe("audit fix 3: the Continue Watching cron cannot revert a concurrent save", () => {
  it("keeps watch history a user saved while the cron sweep was mid-flight", async () => {
    const env = makeEnv();
    env.TMDB_API_KEY = "test-tmdb-key";
    const bob = await createUser(env, "bobcronrace");
    const TKEY = "creatorsynctracking:bobcronrace";
    await env.CONFIGS.put(TKEY, JSON.stringify({
      watchHistory: [{ id: "tt9:1:2", type: "episode", showId: "tt9", seasonNum: 1, episodeNum: 2, showTitle: "Show", watchedAt: 1000 }],
      continueWatching: [], fullyWatchedShowIds: ["tt9"], updatedAt: 1000,
    }));

    // Minimal TMDB stub: resolve tt9 -> 55, and report an unwatched S1E3 so
    // the sweep actually has a Continue Watching update to write.
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (u) => {
      const url = String(u);
      const J = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
      if (url.includes("/find/")) return J({ tv_results: [{ id: 55 }] });
      if (/\/tv\/55\/season\/1\b/.test(url)) {
        return J({ episodes: [
          { id: 990, episode_number: 2, name: "Ep2", air_date: "2020-01-01" },
          { id: 991, episode_number: 3, name: "Brand New Ep", air_date: "2020-01-08" },
        ]});
      }
      return J({ episodes: [] });
    };

    // Park the cron right after ITS OWN read of the tracking blob (the
    // second read of that key -- the first belongs to ensureTrackingMigrated),
    // which stands in for the TMDB round-trips that make this window seconds wide.
    let release;
    const gate = new Promise((r) => { release = r; });
    let reads = 0;
    let cronPhase = true;
    const origGet = env.CONFIGS.get.bind(env.CONFIGS);
    env.CONFIGS.get = async (k, t) => {
      const v = await origGet(k, t);
      if (k === TKEY && cronPhase && ++reads === 2) await gate;
      return v;
    };

    try {
      const pending = [];
      worker.scheduled({}, env, { waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => {})) });
      await new Promise((r) => setTimeout(r, 40));

      cronPhase = false;
      await call(env, "/api/creator/sync/save-tracking", {
        method: "POST",
        json: {
          creatorName: bob.creatorName, creatorKey: bob.creatorKey,
          fullyWatchedShowIds: ["tt9"], continueWatching: [],
          watchHistory: [
            { id: "tt9:1:2", type: "episode", showId: "tt9", seasonNum: 1, episodeNum: 2, showTitle: "Show", watchedAt: 1000 },
            { id: "tt7", type: "movie", title: "Just Watched This", watchedAt: Date.now() },
          ],
        },
      });

      release();
      await Promise.all(pending);
      await new Promise((r) => setTimeout(r, 50));

      const stored = JSON.parse(env.CONFIGS._store.get(TKEY));
      assert.ok(
        stored.watchHistory.some((i) => i.id === "tt7"),
        "the cron must not write its stale snapshot over what the user just saved"
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("audit fix 8: handlePosterImgError works for every call site's markup", () => {
  // Minimal DOM stand-ins -- enough for the placeholder logic, no jsdom.
  function makeEl(tag, className = "") {
    const el = {
      tagName: tag.toUpperCase(),
      className,
      style: {},
      dataset: {},
      children: [],
      parentElement: null,
      innerHTML: "",
      get classList() {
        const self = this;
        return { contains: (c) => String(self.className).split(/\s+/).includes(c) };
      },
      get nextElementSibling() {
        if (!this.parentElement) return null;
        const sibs = this.parentElement.children;
        return sibs[sibs.indexOf(this) + 1] || null;
      },
      appendChild(child) { child.parentElement = this; this.children.push(child); return child; },
      closest() { return null; },
      querySelector(sel) {
        const want = sel.replace(":scope > ", "").replace(".", "");
        return this.children.find((c) => String(c.className).split(/\s+/).includes(want)) || null;
      },
    };
    return el;
  }
  function load() {
    const doc = { createElement: (t) => makeEl(t) };
    return loadOneClientFunction("23_client-list-management.js", "handlePosterImgError", {
      document: doc,
      ORIGIN: "https://example.test",
      fetch: () => Promise.reject(new Error("no network")),
      showPosterPlaceholderFor: loadOneClientFunction(
        "23_client-list-management.js", "showPosterPlaceholderFor", { document: doc }
      ),
    });
  }

  it("reveals the existing placeholder when the markup provides one as the next sibling", () => {
    const handle = load();
    const wrap = makeEl("div");
    const img = wrap.appendChild(makeEl("img", "live-preview-poster"));
    const ph = wrap.appendChild(makeEl("div", "live-preview-poster live-preview-poster-placeholder"));
    ph.style.display = "none";
    img.dataset.hasFailedFallback = "1";

    handle(img);
    assert.equal(img.style.display, "none");
    assert.equal(ph.style.display, "flex", "the provided placeholder should be shown");
    assert.equal(wrap.children.length, 2, "and no second placeholder should be created");
  });

  it("creates a placeholder when the markup has no placeholder sibling", () => {
    const handle = load();
    // The list-card mini tile shape: img, then a remove button, then a
    // breakpoint-scoped count badge. Neither is a placeholder.
    const wrap = makeEl("div", "list-card-mini-poster-img-wrap");
    const img = wrap.appendChild(makeEl("img"));
    const removeBtn = wrap.appendChild(makeEl("button", "cw-remove-btn"));
    const countBadge = wrap.appendChild(makeEl("div", "list-card-count-overlay desktop-only"));
    img.dataset.hasFailedFallback = "1";

    handle(img);
    assert.equal(img.style.display, "none");
    // The actual regression: the old code set display:flex on whatever sat
    // next to the img. On the count badge that overrode the media query
    // that hides it at the other breakpoint, and no placeholder ever
    // appeared -- just an empty gap.
    assert.equal(removeBtn.style.display, undefined, "must not touch the remove button");
    assert.equal(countBadge.style.display, undefined, "must not override the badge's breakpoint CSS");
    const created = wrap.children.find((c) => String(c.className).includes("live-preview-poster-placeholder"));
    assert.ok(created, "a 'No poster' placeholder should have been created");
    assert.equal(created.style.display, "flex");
    assert.match(created.innerHTML, /No poster/);
  });

  it("does not stack placeholders when called twice", () => {
    const handle = load();
    const wrap = makeEl("div");
    const img = wrap.appendChild(makeEl("img"));
    img.dataset.hasFailedFallback = "1";
    handle(img);
    handle(img);
    const phs = wrap.children.filter((c) => String(c.className).includes("live-preview-poster-placeholder"));
    assert.equal(phs.length, 1);
  });

  it("handles an img with no sibling at all (the swapped-in fallback image)", () => {
    const handle = load();
    const wrap = makeEl("div");
    const img = wrap.appendChild(makeEl("img", "live-preview-poster"));
    img.dataset.hasFailedFallback = "1";
    handle(img);
    assert.ok(wrap.children.some((c) => String(c.className).includes("live-preview-poster-placeholder")));
  });
});

describe("audit fix 5: shared-key fan-out endpoints are bounded", () => {
  it("rejects a bulk-resolve request larger than the server's fan-out cap", async () => {
    const env = makeEnv();
    const items = Array.from({ length: 500 }, (_, i) => ({ title: "Film " + i, year: 2000 }));
    const r = await call(env, "/api/bulk-resolve", { method: "POST", json: { items } });
    // Two TMDB calls per item: 500 items would have been ~1,000 subrequests,
    // past Cloudflare's per-invocation limit, on the owner's shared key.
    assert.equal(r.status, 413);
  });

  it("rate-limits repeated bulk-resolve calls from one IP", async () => {
    const env = makeEnv();
    const ip = nextIp();
    let limited = 0;
    for (let i = 0; i < 25; i++) {
      const r = await call(env, "/api/bulk-resolve", {
        method: "POST", ip, json: { items: [{ title: "X", year: 2000 }] },
      });
      if (r.status === 429) limited++;
    }
    assert.ok(limited > 0, "expected the per-IP bucket to reject some of 25 rapid calls");
  });

  // This test used to assert that a caller supplying their own tmdbKey "must
  // never be rate-limited". That was the wrong property, and it was the
  // vulnerability: bringing your own key means you are spending your own
  // TMDB quota, but it never meant you were spending your own subrequests,
  // and the field was never validated. Any non-empty string therefore
  // unlocked an unlimited 60-id fan-out against this Worker's budget.
  // The correct property is a HIGHER ceiling, not the absence of one.
  it("gives bring-your-own-key callers more headroom on /api/details/batch, not an exemption", async () => {
    const env = makeEnv();
    const ip = nextIp();
    let sharedLimited = 0;
    for (let i = 0; i < 70; i++) {
      const r = await call(env, "/api/details/batch", { method: "POST", ip, json: { ids: ["tt1"] } });
      if (r.status === 429) sharedLimited++;
    }
    assert.ok(sharedLimited > 0, "shared-key callers should hit the limit");

    // The headroom the exemption existed to give is preserved: a caller with
    // their own key sails past the shared-key ceiling.
    const ownKeyIp = nextIp();
    let ownKeyLimited = 0;
    for (let i = 0; i < 70; i++) {
      const r = await call(env, "/api/details/batch", {
        method: "POST", ip: ownKeyIp, json: { ids: ["tt1"], tmdbKey: "user-own-key" },
      });
      if (r.status === 429) ownKeyLimited++;
    }
    assert.equal(ownKeyLimited, 0, "a caller with their own key should still clear the shared-key ceiling");

    // ...but it is a ceiling, not an exemption.
    const floodIp = nextIp();
    let floodLimited = 0;
    for (let i = 0; i < 260; i++) {
      const r = await call(env, "/api/details/batch", {
        method: "POST", ip: floodIp, json: { ids: ["tt1"], tmdbKey: "anything-at-all" },
      });
      if (r.status === 429) floodLimited++;
    }
    assert.ok(floodLimited > 0, "any non-empty tmdbKey still bought unlimited fan-out");
  });

  it("gives bring-your-own-key callers more headroom on /api/recommendations, not an exemption", async () => {
    // Up to ~72 outbound subrequests per call, so this is the bigger
    // amplifier of the two.
    const env = makeEnv();
    const sharedIp = nextIp();
    let sharedLimited = 0;
    for (let i = 0; i < 40; i++) {
      const r = await call(env, "/api/recommendations", {
        method: "POST", ip: sharedIp, json: { movieIds: [], showIds: [] },
      });
      if (r.status === 429) sharedLimited++;
    }
    assert.ok(sharedLimited > 0, "shared-key callers should hit the limit");

    const ownKeyIp = nextIp();
    let ownKeyLimited = 0;
    for (let i = 0; i < 40; i++) {
      const r = await call(env, "/api/recommendations", {
        method: "POST", ip: ownKeyIp, json: { movieIds: [], showIds: [], tmdbKey: "user-own-key" },
      });
      if (r.status === 429) ownKeyLimited++;
    }
    assert.equal(ownKeyLimited, 0, "a caller with their own key should still clear the shared-key ceiling");

    const floodIp = nextIp();
    let floodLimited = 0;
    for (let i = 0; i < 140; i++) {
      const r = await call(env, "/api/recommendations", {
        method: "POST", ip: floodIp, json: { movieIds: [], showIds: [], tmdbKey: "x" },
      });
      if (r.status === 429) floodLimited++;
    }
    assert.ok(floodLimited > 0, "any non-empty tmdbKey still bought unlimited fan-out");
  });

  it("rate-limits /api/recommendations only when it falls back to the shared TMDB key", async () => {
    const env = makeEnv();
    const ip = nextIp();
    let limited = 0;
    for (let i = 0; i < 40; i++) {
      const r = await call(env, "/api/recommendations", { method: "POST", ip, json: { movieIds: [] } });
      if (r.status === 429) limited++;
    }
    assert.ok(limited > 0, "shared-key callers should hit the limit");

    const ownKeyIp = nextIp();
    let ownKeyLimited = 0;
    for (let i = 0; i < 40; i++) {
      const r = await call(env, "/api/recommendations", {
        method: "POST", ip: ownKeyIp, json: { movieIds: [], tmdbKey: "user-own-key" },
      });
      if (r.status === 429) ownKeyLimited++;
    }
    assert.equal(ownKeyLimited, 0);
  });

  it("client chunks bulk-resolve to exactly the size the server accepts", () => {
    // The chunk size is interpolated from the same server constant the
    // route validates against, so the two cannot drift apart.
    const src = fs.readFileSync(path.join(REPO_ROOT, "18_client-copy-and-trakt-export.js"), "utf8");
    assert.match(src, /const CHUNK = \$\{BULK_RESOLVE_ITEMS_MAX\};/,
      "the client chunk size must come from BULK_RESOLVE_ITEMS_MAX, not a hardcoded number");
    const constants = fs.readFileSync(path.join(REPO_ROOT, "00_constants.js"), "utf8");
    const m = constants.match(/const BULK_RESOLVE_ITEMS_MAX = (\d+);/);
    assert.ok(m, "BULK_RESOLVE_ITEMS_MAX should be defined in 00_constants.js");
    // ~2 TMDB calls per item must stay well inside Cloudflare's 1,000
    // subrequests per invocation.
    assert.ok(Number(m[1]) * 2 < 900, "the cap must leave subrequest headroom");
  });

  it("leaves caller-credentialed provider endpoints unthrottled", async () => {
    // These spend the CALLER's provider quota (they 400 without a token),
    // so a limit here would only break large legitimate history syncs.
    const env = makeEnv();
    const ip = nextIp();
    let limited = 0;
    for (let i = 0; i < 30; i++) {
      const r = await call(env, "/api/trakt-history-raw", {
        method: "POST", ip, json: { accessToken: "" },
      });
      if (r.status === 429) limited++;
    }
    assert.equal(limited, 0);
  });
});

describe("audit fix 10: admin Community Lists ranks by likes, not by key order", () => {
  async function seed(env, count) {
    const alice = await createUser(env, "rankuser");
    for (let i = 0; i < count; i++) {
      await call(env, "/api/creator/lists/save", { method: "POST", json: {
        creatorName: alice.creatorName, creatorKey: alice.creatorKey,
        name: "List " + String(i).padStart(3, "0"), type: "movie",
        visibility: "public", items: [{ id: "tt1" }],
      }});
    }
    // The genuinely most-liked list sorts LAST alphabetically.
    await call(env, "/api/creator/lists/save", { method: "POST", json: {
      creatorName: alice.creatorName, creatorKey: alice.creatorKey,
      name: "ZZZ Most Liked", type: "movie", visibility: "public", items: [{ id: "tt1" }],
    }});
    for (let i = 0; i < 5; i++) {
      await call(env, "/api/lists/like", { method: "POST", json: { username: "rankuser", slug: "zzz-most-liked", action: "like" } });
    }
    const login = await call(env, "/admin/login", { method: "POST", form: { key: "test-admin-secret" } });
    return (login.headers.get("set-cookie") || "").split(";")[0];
  }

  it("shows lists at all (the record has no creatorName field to filter on)", async () => {
    const env = makeEnv();
    const cookie = await seed(env, 2);
    const r = await call(env, "/admin/api/analytics?section=catalogs_lists", { cookie });
    // /api/creator/lists/save writes { name, slug, type, items, visibility,
    // likes, createdAt, updatedAt } -- no creatorName; the creator is in the
    // KEY. The old code required data.creatorName and so dropped every
    // single list, leaving this panel permanently empty without D1.
    assert.ok((r.body.communityLists || []).length > 0, "the panel must not be empty");
    assert.ok(r.body.communityLists.every((l) => l.creator), "every row needs a creator");
  });

  it("ranks the genuinely most-liked list first, past the 100-row cap", async () => {
    const env = makeEnv();
    const cookie = await seed(env, 119);
    // First load warms the index (rebuilt in the background), same as
    // /api/search-published-lists.
    await call(env, "/admin/api/analytics?section=catalogs_lists", { cookie });
    const r = await call(env, "/admin/api/analytics?section=catalogs_lists", { cookie });
    const lists = r.body.communityLists || [];
    assert.equal(lists[0].name, "ZZZ Most Liked", "top row must be the most-liked list");
    assert.equal(lists[0].likes, 5);
  });

  it("reads the panel from one KV get instead of one per candidate", async () => {
    const env = makeEnv();
    const cookie = await seed(env, 119);
    await call(env, "/admin/api/analytics?section=catalogs_lists", { cookie });
    let gets = 0;
    const og = env.CONFIGS.get.bind(env.CONFIGS);
    env.CONFIGS.get = async (...a) => { gets++; return og(...a); };
    await call(env, "/admin/api/analytics?section=catalogs_lists", { cookie });
    assert.ok(gets < 20, `expected a handful of KV reads, got ${gets}`);
  });
});

describe("audit fix 14: every env var the code requires is documented", () => {
  it("names MDBLIST_CLIENT_SECRET in both README.md and wrangler.toml", () => {
    const readme = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
    const wrangler = fs.readFileSync(path.join(REPO_ROOT, "wrangler.toml"), "utf8");
    assert.match(readme, /MDBLIST_CLIENT_SECRET/);
    assert.match(wrangler, /MDBLIST_CLIENT_SECRET/);
  });

  it("documents every env var the Worker actually reads", () => {
    // Guards the whole class: an operator following the setup docs exactly
    // should never hit a feature that reports itself "not configured".
    const readme = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
    const wrangler = fs.readFileSync(path.join(REPO_ROOT, "wrangler.toml"), "utf8");
    const docs = readme + "\n" + wrangler;
    const used = new Set();
    for (const f of fs.readdirSync(REPO_ROOT).filter((n) => /^\d\d_.*\.js$/.test(n))) {
      const src = fs.readFileSync(path.join(REPO_ROOT, f), "utf8");
      for (const m of src.matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)) used.add(m[1]);
    }
    const undocumented = [...used].filter((name) => !docs.includes(name)).sort();
    assert.deepEqual(undocumented, [], `undocumented env vars: ${undocumented.join(", ")}`);
  });
});


describe("audit fix 9: stat counters are atomic when D1 is bound", () => {
  it("records every one of 20 concurrent page views (the KV path records ~1)", async () => {
    const kvOnly = makeEnv();
    await Promise.all(Array.from({ length: 20 }, () => call(kvOnly, "/")));
    const kvCount = parseInt(kvOnly.CONFIGS._store.get("stats:pageviews:total") || "0", 10);

    const withD1 = makeEnv({ DB: makeD1() });
    await Promise.all(Array.from({ length: 20 }, () => call(withD1, "/")));
    const d1Count = withD1.DB._stat("pageviews", "total") || 0;

    // The KV read-modify-write loses almost all of them: every concurrent
    // request reads the same value and writes the same value+1.
    assert.ok(kvCount < 20, `KV path is expected to lose updates, got ${kvCount}`);
    // The D1 upsert increments inside the statement, so none are lost.
    assert.equal(d1Count, 20, `D1 path must record all 20, got ${d1Count}`);
  });

  it("writes both the all-time and the per-day bucket", async () => {
    const env = makeEnv({ DB: makeD1() });
    await call(env, "/");
    const buckets = env.DB._statBuckets("pageviews");
    assert.equal(buckets.length, 2);
    assert.ok(buckets.includes("total"));
    assert.ok(buckets.some((b) => /^\d{4}-\d{2}-\d{2}$/.test(b)), "expected a YYYY-MM-DD day bucket");
  });

  it("the admin dashboard treats D1 as authoritative over a stale KV copy", async () => {
    const env = makeEnv({ DB: makeD1() });
    for (let i = 0; i < 7; i++) await call(env, "/");
    // A leftover KV value from before D1 was bound must NOT win: it is the
    // undercounted one, and reading it is what this fix exists to stop.
    await env.CONFIGS.put("stats:pageviews:total", "3");
    const login = await call(env, "/admin/login", { method: "POST", form: { key: "test-admin-secret" } });
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    const r = await call(env, "/admin", { cookie });
    assert.match(r.text, /<div class="stat-value">7<\/div>/, "expected the D1 count (7), not the stale KV copy (3)");
    assert.doesNotMatch(r.text, /<div class="stat-value">3<\/div>\s*<div class="stat-label">Total page views<\/div>/);
  });

  it("falls back to the KV count when D1 has no row yet (not migrated)", async () => {
    // Binding D1 must not make an existing dashboard's history vanish
    // before the operator presses "Migrate KV -> D1".
    const env = makeEnv({ DB: makeD1() });
    await env.CONFIGS.put("stats:pageviews:total", "4242");
    const login = await call(env, "/admin/login", { method: "POST", form: { key: "test-admin-secret" } });
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    const r = await call(env, "/admin", { cookie });
    assert.match(r.text, /<div class="stat-value">4242<\/div>/);
  });

  it("migrate-d1 copies KV counters across, and is safe to run twice", async () => {
    const env = makeEnv({ DB: makeD1() });
    await env.CONFIGS.put("stats:pageviews:total", "100");
    await env.CONFIGS.put("stats:pageviews:2026-09-01", "40");
    // Non-counter stats keys must not be dragged into an integer column.
    await env.CONFIGS.put("stats:genres:alltime", JSON.stringify({ Drama: 3 }));
    await env.CONFIGS.put("stats:genredecade:migrated", "1");

    const login = await call(env, "/admin/login", { method: "POST", form: { key: "test-admin-secret" } });
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];

    const first = await call(env, "/admin/api/migrate-d1", { method: "POST", cookie });
    assert.equal(first.body.ok, true);
    assert.equal(env.DB._stat("pageviews", "total"), 100);
    assert.equal(env.DB._stat("pageviews", "2026-09-01"), 40);
    assert.equal(env.DB._stat("genres", "alltime"), undefined, "JSON blobs must not be migrated as counters");

    // Re-running must not double the counts (DO NOTHING, not n = n + ...).
    await call(env, "/admin/api/migrate-d1", { method: "POST", cookie });
    assert.equal(env.DB._stat("pageviews", "total"), 100, "a second migration must not double counts");
  });

  // migrate-d1 spends a KV read plus a D1 statement per key, both of which
  // count against Cloudflare's 1,000-subrequest cap. As a single unbounded
  // pass it therefore aborted partway through on exactly the sites big
  // enough to need it, backfilling a prefix of the accounts and reporting
  // ok -- and an account left in KV but missing from D1 is the case the
  // key-rotation endpoints get wrong, because a D1 UPDATE matching zero
  // rows still reports success.
  it("migrate-d1 backfills every account at a scale that used to abort it", async () => {
    const n = 900;
    // A KV that enforces the real per-invocation limit, and a D1 whose
    // statements are charged against the same budget, as they really are.
    const inner = makeKv();
    let spentThisInvocation = 0;
    let peak = 0;
    const charge = () => {
      spentThisInvocation += 1;
      if (spentThisInvocation > peak) peak = spentThisInvocation;
      if (spentThisInvocation > 1000) throw new Error("Too many subrequests.");
    };
    const kv = {
      _store: inner._store,
      async get(...a) { charge(); return inner.get(...a); },
      async put(...a) { charge(); return inner.put(...a); },
      async delete(...a) { charge(); return inner.delete(...a); },
      async list(...a) { charge(); return inner.list(...a); },
    };
    const realDb = makeD1();
    const db = {
      _creators: realDb._creators,
      _lists: realDb._lists,
      _stat: realDb._stat,
      prepare(sql) {
        const st = realDb.prepare(sql);
        const chargedRun = (target) => async () => { charge(); return target.run(); };
        const chargedAll = (target) => async () => { charge(); return target.all(); };
        return {
          bind(...a) {
            const b = st.bind(...a);
            return { run: chargedRun(b), all: chargedAll(b) };
          },
          run: chargedRun(st),
          all: chargedAll(st),
        };
      },
      batch: realDb.batch,
    };

    const env = makeEnv({ CONFIGS: kv, DB: db });
    for (let i = 0; i < n; i++) {
      const username = `user${String(i).padStart(5, "0")}`;
      inner._store.set(`creator:${username}`, JSON.stringify({
        displayName: `Real ${username}`, keyHash: `hash-${i}`, createdAt: 1,
      }));
      inner._store.set(`creatorlist:${username}:list-${i}`, JSON.stringify({
        name: `List ${i}`, slug: `list-${i}`, type: "movie", visibility: "public",
        items: [{ id: "tt0111161", name: "Item" }], likes: i % 5, createdAt: 1, updatedAt: 1,
      }));
    }

    const cookie = await adminCookie(env);
    let calls = 0;
    let last;
    do {
      calls += 1;
      spentThisInvocation = 0; // a new call is a new invocation, with a new budget
      last = await call(env, "/admin/api/migrate-d1", { method: "POST", cookie });
      assert.equal(last.body.ok, true, `call ${calls} failed: ${last.body.error}`);
    } while (!last.body.done && calls < 200);

    assert.equal(last.body.done, true, "migration never reported done");
    assert.ok(peak <= 1000, `one invocation spent ${peak} subrequests, over the limit`);
    // The point of the whole endpoint: no account may be left behind.
    assert.equal(db._creators.size, n, `only ${db._creators.size} of ${n} creators reached D1`);
    assert.equal(db._lists.size, n, `only ${db._lists.size} of ${n} lists reached D1`);
    assert.equal(last.body.results.creators, n);
  });

  it("migrate-d1 restarts cleanly from unparseable resume state", async () => {
    const env = makeEnv({ DB: makeD1() });
    await env.CONFIGS.put("stats:pageviews:total", "77");
    await env.CONFIGS.put("migrated1:state", "{not json");
    const cookie = await adminCookie(env);
    let calls = 0;
    let last;
    do {
      calls += 1;
      last = await call(env, "/admin/api/migrate-d1", { method: "POST", cookie });
    } while (!last.body.done && calls < 50);
    assert.equal(last.body.done, true);
    assert.equal(env.DB._stat("pageviews", "total"), 77);
    // Resume state must not outlive the run that used it.
    assert.equal(await env.CONFIGS.get("migrated1:state"), null, "resume state leaked");
  });

  it("keeps counting correctly in KV-only deployments", async () => {
    // D1 is optional here; nothing above may break the no-DB path.
    const env = makeEnv();
    await call(env, "/");
    assert.equal(env.CONFIGS._store.get("stats:pageviews:total"), "1");
    const login = await call(env, "/admin/login", { method: "POST", form: { key: "test-admin-secret" } });
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    const r = await call(env, "/admin", { cookie });
    assert.match(r.text, /<div class="stat-value">1<\/div>/);
  });
});


describe("audit fix 13: outbound requests are bounded by a timeout", () => {
  it("wires a timeout signal into the shared fetch helper", async () => {
    const sandbox = loadSourceFunctions("02_http-and-creator-utils.js");
    let sawSignal = false;
    sandbox.fetch = async (_url, opts) => { sawSignal = !!(opts && opts.signal); return { status: 200 }; };
    sandbox.AbortSignal = { timeout: (ms) => ({ __timeoutMs: ms }) };
    await sandbox.fetchTraktWithRetry("https://api.trakt.tv/x", {});
    assert.equal(sawSignal, true, "fetchTraktWithRetry must pass an abort signal");
  });

  it("leaves a caller's own signal alone", async () => {
    const sandbox = loadSourceFunctions("02_http-and-creator-utils.js");
    const mine = { mine: true };
    let seen = null;
    sandbox.fetch = async (_url, opts) => { seen = opts.signal; return { status: 200 }; };
    sandbox.AbortSignal = { timeout: () => ({ __timeout: true }) };
    await sandbox.fetchWithTimeout("https://x/", { signal: mine });
    assert.equal(seen, mine);
  });

  it("still works where AbortSignal.timeout is unavailable", async () => {
    const sandbox = loadSourceFunctions("02_http-and-creator-utils.js");
    let called = false;
    sandbox.fetch = async () => { called = true; return { status: 200 }; };
    // No AbortSignal in this sandbox at all -- the capability is probed,
    // not assumed (render_check.js's sandbox omits it).
    await sandbox.fetchWithTimeout("https://x/", {});
    assert.equal(called, true);
  });

  it("turns a hung upstream into a rejection so the stale fallback can serve", async () => {
    const sandbox = loadSourceFunctions("02_http-and-creator-utils.js");
    // loadSourceFunctions' sandbox is deliberately minimal; the Workers
    // runtime provides these.
    sandbox.setTimeout = setTimeout;
    sandbox.clearTimeout = clearTimeout;
    const hang = new Promise(() => {});          // never settles
    await assert.rejects(
      () => sandbox.withTimeout(hang, 20, "TMDB"),
      /TMDB did not respond within 20ms/
    );
  });

  it("passes a value straight through when it settles in time", async () => {
    const sandbox = loadSourceFunctions("02_http-and-creator-utils.js");
    sandbox.setTimeout = setTimeout;
    sandbox.clearTimeout = clearTimeout;
    assert.equal(await sandbox.withTimeout(Promise.resolve("ok"), 1000, "TMDB"), "ok");
  });
});

describe("audit fix 11: a playback ping does not read every list the creator owns", () => {
  it("reads the watchlist directly instead of scanning", async () => {
    const env = makeEnv();
    const alice = await createUser(env, "pinguser");
    // One watchlist plus a pile of unrelated lists.
    await env.CONFIGS.put("creatorlist:pinguser:watchlist", JSON.stringify({
      slug: "watchlist", name: "Watchlist", type: "movie", visibility: "private",
      items: [{ id: "tt111" }, { id: "tt222" }],
    }));
    for (let i = 0; i < 40; i++) {
      await env.CONFIGS.put(`creatorlist:pinguser:other-${i}`, JSON.stringify({
        slug: `other-${i}`, name: "Other " + i, type: "movie", visibility: "private", items: [{ id: "tt999" }],
      }));
    }

    let gets = 0;
    const og = env.CONFIGS.get.bind(env.CONFIGS);
    env.CONFIGS.get = async (...a) => { gets++; return og(...a); };

    const config = Buffer.from(JSON.stringify({
      entries: [], track: true, trackCreatorName: alice.creatorName, trackCreatorKey: alice.creatorKey,
    })).toString("base64url");
    await call(env, `/${config}/subtitles/movie/tt111.json`);

    // Before: one list() plus one get() per list (41 here) on every ping.
    assert.ok(gets < 15, `expected a handful of KV reads per ping, got ${gets}`);
    const wl = JSON.parse(env.CONFIGS._store.get("creatorlist:pinguser:watchlist"));
    assert.deepEqual(wl.items.map((i) => i.id), ["tt222"], "the watched item should still be removed");
  });
});

describe("audit fix 12: deleting an account leaves nothing behind", () => {
  it("removes the like ledger and the scrobble seen-user set", async () => {
    const env = makeEnv();
    const alice = await createUser(env, "purgeuser");
    await call(env, "/api/creator/lists/save", { method: "POST", json: {
      creatorName: alice.creatorName, creatorKey: alice.creatorKey,
      name: "Fav Films", type: "movie", visibility: "public", items: [{ id: "tt1" }],
    }});
    await call(env, "/api/lists/like", { method: "POST", json: { username: "purgeuser", slug: "fav-films", action: "like" } });
    await env.CONFIGS.put("scrobbleseenusers:purgeuser", JSON.stringify(["someone"]));
    await env.CONFIGS.put("creatortrack:purgeuser", JSON.stringify({ lastPingAt: 1 }));
    assert.ok(env.CONFIGS._store.has("listlikevoters:purgeuser:fav-films"), "precondition: ledger exists");

    const r = await call(env, "/api/creator/delete-account", { method: "POST", json: {
      creatorName: alice.creatorName, creatorKey: alice.creatorKey, confirm: "DELETE",
    }});
    assert.equal(r.body.ok, true);

    const leftovers = [...env.CONFIGS._store.keys()].filter((k) => k.includes("purgeuser"));
    assert.deepEqual(leftovers, [], `nothing should reference the deleted account, found: ${leftovers.join(", ")}`);
  });

  it("does not let a recycled username inherit the old like count", async () => {
    const env = makeEnv();
    const alice = await createUser(env, "recycled");
    await call(env, "/api/creator/lists/save", { method: "POST", json: {
      creatorName: alice.creatorName, creatorKey: alice.creatorKey,
      name: "Shared Slug", type: "movie", visibility: "public", items: [{ id: "tt1" }],
    }});
    for (let i = 0; i < 3; i++) {
      await call(env, "/api/lists/like", { method: "POST", json: { username: "recycled", slug: "shared-slug", action: "like" } });
    }
    await call(env, "/api/creator/delete-account", { method: "POST", json: {
      creatorName: alice.creatorName, creatorKey: alice.creatorKey, confirm: "DELETE",
    }});

    // Someone else claims the freed username and happens to pick the same slug.
    const bob = await createUser(env, "recycled");
    await call(env, "/api/creator/lists/save", { method: "POST", json: {
      creatorName: bob.creatorName, creatorKey: bob.creatorKey,
      name: "Shared Slug", type: "movie", visibility: "public", items: [{ id: "tt9" }],
    }});
    const like = await call(env, "/api/lists/like", { method: "POST", json: { username: "recycled", slug: "shared-slug", action: "like" } });
    assert.equal(like.body.likes, 1, "a brand-new list must start from zero, not inherit the old ledger");
  });
});


describe("audit fix 7: error messages are useful but cannot carry a secret", () => {
  const load = () => loadSourceFunctions("02_http-and-creator-utils.js").safeErrorMessage;

  it("keeps the genuinely useful upstream message", () => {
    const safeErrorMessage = load();
    // This is how someone learns their own API key is wrong -- blanking it
    // would be a product regression, not a security win.
    assert.equal(safeErrorMessage(new Error("Trakt request failed (HTTP 401).")),
      "Trakt request failed (HTTP 401).");
  });

  it("strips a URL that a future careless throw might include", () => {
    const safeErrorMessage = load();
    const msg = safeErrorMessage(new Error("fetch failed for https://api.themoviedb.org/3/movie/1?api_key=abcdef123456"));
    assert.doesNotMatch(msg, /themoviedb\.org/);
    assert.doesNotMatch(msg, /abcdef123456/);
    assert.match(msg, /\[url\]/);
  });

  it("redacts a labelled key or token even without a URL", () => {
    const safeErrorMessage = load();
    for (const raw of [
      "bad request: api_key=sk_live_9f8e7d6c5b4a3210",
      "auth failed, access_token: ya29.aVeryLongOpaqueTokenValue",
      "client_secret=hunter2hunter2hunter2",
    ]) {
      const msg = safeErrorMessage(new Error(raw));
      assert.match(msg, /\[redacted\]/, `expected redaction in: ${msg}`);
      assert.doesNotMatch(msg, /sk_live|ya29\.|hunter2/);
    }
  });

  it("redacts a long unlabelled opaque token", () => {
    const safeErrorMessage = load();
    const token = "A".repeat(40);
    assert.doesNotMatch(safeErrorMessage(new Error("upstream said " + token)), /AAAA/);
  });

  it("falls back to a generic message when there is nothing safe to say", () => {
    const safeErrorMessage = load();
    assert.match(safeErrorMessage(null), /Something went wrong/);
    assert.match(safeErrorMessage(new Error("")), /Something went wrong/);
  });

  it("bounds the length so a huge message cannot be echoed back", () => {
    const safeErrorMessage = load();
    assert.ok(safeErrorMessage(new Error("x".repeat(5000))).length <= 201);
  });

  it("no route still returns a raw exception message", () => {
    for (const f of ["25_api-catalog-routes.js", "26_api-creator-and-admin-routes.js"]) {
      const src = fs.readFileSync(path.join(REPO_ROOT, f), "utf8");
      assert.doesNotMatch(src, /String\((?:err|e)\.message \|\| (?:err|e)\)/,
        `${f} still returns a raw exception message; use safeErrorMessage()`);
    }
  });
});

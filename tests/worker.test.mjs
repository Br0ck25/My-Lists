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

// /api/channel-logo fetches a TMDB image and base64-encodes it into an SVG.
// It is unauthenticated, took any path at all, buffered whatever the upstream
// returned, and answered no-store -- so every request repeated the whole
// fetch-and-encode for output that cannot change.
describe("audit fix: the channel image endpoints are bounded and cacheable", () => {
  function stubUpstream(sizes = {}) {
    const seen = [];
    globalThis.fetch = async (u) => {
      const href = typeof u === "string" ? u : u.url;
      seen.push(href);
      for (const [marker, size] of Object.entries(sizes)) {
        if (href.includes(marker)) {
          const headers = { "content-type": "image/png" };
          if (size.declare !== false) headers["content-length"] = String(size.bytes);
          return new Response(new Uint8Array(size.bytes), { status: 200, headers });
        }
      }
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200, headers: { "content-type": "image/png" },
      });
    };
    return seen;
  }

  it("serves real TMDB logo paths, cached rather than no-store", async () => {
    const realFetch = globalThis.fetch;
    try {
      stubUpstream();
      const env = makeEnv();
      for (const p of ["/wLqRr0YLAqmWKAHYFhkQBQFCDLL.jpg", "wLqRr0YLAqmWKAHYFhkQBQFCDLL.png", "/abc123.webp"]) {
        const r = await call(env, "/api/channel-logo?path=" + encodeURIComponent(p));
        assert.equal(r.status, 200, `real path rejected: ${p}`);
        assert.match(r.headers.get("cache-control") || "", /max-age=\d{4,}/, "output is deterministic and must be cacheable");
      }
    } finally { globalThis.fetch = realFetch; }
  });

  it("rejects anything not shaped like a TMDB image path, without calling upstream", async () => {
    const realFetch = globalThis.fetch;
    try {
      const seen = stubUpstream();
      const env = makeEnv();
      for (const p of ["/../../etc/passwd", "/t/p/original/anything", "/justsomepath", "/a.png?x=1"]) {
        const before = seen.length;
        const r = await call(env, "/api/channel-logo?path=" + encodeURIComponent(p));
        assert.equal(r.status, 400, `should have been rejected: ${p}`);
        assert.equal(seen.length, before, `rejected path still hit the upstream: ${p}`);
      }
    } finally { globalThis.fetch = realFetch; }
  });

  it("refuses an oversized image, with or without a content-length header", async () => {
    const realFetch = globalThis.fetch;
    try {
      stubUpstream({
        huge: { bytes: 3 * 1024 * 1024 },
        nolen: { bytes: 3 * 1024 * 1024, declare: false },
      });
      const env = makeEnv();
      const declared = await call(env, "/api/channel-logo?path=" + encodeURIComponent("/huge0000000.png"));
      assert.equal(declared.status, 413);
      // A missing or dishonest content-length must not get past the cap.
      const undeclared = await call(env, "/api/channel-logo?path=" + encodeURIComponent("/nolen000000.png"));
      assert.equal(undeclared.status, 413);
    } finally { globalThis.fetch = realFetch; }
  });

  it("bounds and escapes the channel-poster name, and caches the result", async () => {
    const env = makeEnv();
    const huge = await call(env, "/api/channel-poster?name=" + encodeURIComponent("A".repeat(5000)));
    assert.equal(huge.status, 200);
    assert.ok(huge.text.length < 10000, `a 5000-char name produced ${huge.text.length} bytes of SVG`);
    assert.match(huge.headers.get("cache-control") || "", /max-age=\d{4,}/);

    const injected = await call(env, "/api/channel-poster?name=" +
      encodeURIComponent("</text><script>alert(1)</script>"));
    assert.equal(injected.status, 200);
    // Served as image/svg+xml from this origin, so raw markup here would run.
    assert.ok(!injected.text.includes("<script>"), "channel name was not escaped into the SVG");
  });
});

// The 60-second per-IP buckets on /admin/login and /api/creator/restore bound
// a burst, but they are KV counters -- edge-cached reads, no atomic increment
// -- and they reset every minute, so across rolling windows they placed no
// bound at all on how many guesses one address could make in a day. Both now
// also carry a daily failure budget, spent only on failures and atomic
// wherever D1 is bound.
describe("audit fix: credential endpoints bound guesses across rolling windows", () => {
  // Deleting the 60s key is what a real attacker gets for free by waiting:
  // the short window rolls over, and only the daily budget accumulates.
  async function rollWindow(env, key) { await env.CONFIGS.delete(key); }

  for (const [label, makeStores] of [
    ["KV only", () => ({ CONFIGS: makeKv() })],
    ["D1 bound", () => ({ CONFIGS: makeKv(), DB: makeD1() })],
  ]) {
    it(`bounds admin-login guessing across rolling 60s windows (${label})`, async () => {
      const env = makeEnv(makeStores());
      const ip = nextIp();
      let attempted = 0;
      let blocked = false;
      for (let round = 0; round < 15 && !blocked; round++) {
        await rollWindow(env, `ratelimit:adminlogin:${ip}`);
        for (let i = 0; i < 9; i++) {
          const r = await call(env, "/admin/login", { method: "POST", ip, form: { key: "wrong-key" } });
          attempted++;
          if (r.status === 429) { blocked = true; break; }
        }
      }
      assert.equal(blocked, true, `made ${attempted} wrong-key attempts from one IP without ever being blocked`);
    });

    it(`never spends the admin budget on a correct key (${label})`, async () => {
      // A budget that successes consume would lock out the one person who
      // can fix it.
      const env = makeEnv(makeStores());
      const ip = nextIp();
      for (let i = 0; i < 60; i++) {
        await rollWindow(env, `ratelimit:adminlogin:${ip}`);
        const r = await call(env, "/admin/login", { method: "POST", ip, form: { key: env.ADMIN_KEY } });
        assert.equal(r.status, 302, `login ${i + 1} was refused -- successes are spending the budget`);
      }
    });
  }

  it("bounds creator-restore guessing, and leaves the real key working", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    const alice = await createUser(env, "alicerestorecap");
    const ip = nextIp();
    let attempted = 0;
    let blocked = false;
    for (let round = 0; round < 20 && !blocked; round++) {
      await rollWindow(env, `ratelimit:creatorrestore:${ip}`);
      for (let i = 0; i < 19; i++) {
        const r = await call(env, "/api/creator/restore", {
          method: "POST", ip,
          json: { creatorName: alice.creatorName, creatorKey: "MYL-BAD0-BAD0-BAD0" },
        });
        attempted++;
        if (r.status === 429) { blocked = true; break; }
      }
    }
    assert.equal(blocked, true, `made ${attempted} wrong-key attempts from one IP without ever being blocked`);

    const good = await call(env, "/api/creator/restore", {
      method: "POST", ip: nextIp(),
      json: { creatorName: alice.creatorName, creatorKey: alice.creatorKey },
    });
    assert.equal(good.body.ok, true, `the real key stopped working: ${good.body.error}`);
  });
});

// Both list-saving endpoints allocated a slug by trying baseSlug, then
// baseSlug-2, -3 ... up to 500, and then USING WHATEVER THE LOOP EXITED ON.
// Past the bound that is a slug which is taken, and the write went straight
// over the existing list.
describe("audit fix: slug allocation never lands on a taken slug", () => {
  it("does not overwrite an existing published list once the numbered range fills", async () => {
    const kv = makeKv();
    kv._store.set("publishedlist:user:movies", JSON.stringify({ name: "Movies", items: [] }));
    for (let i = 2; i <= 500; i++) {
      kv._store.set(`publishedlist:user:movies-${i}`, JSON.stringify({
        name: "Movies", type: "movie", visibility: "public",
        items: [{ id: `tt-EXISTING-${i}`, name: `someone else's list ${i}` }],
      }));
    }
    const env = makeEnv({ CONFIGS: kv });
    const before = kv._store.get("publishedlist:user:movies-500");

    const r = await call(env, "/api/publish-list", {
      method: "POST",
      json: { name: "Movies", type: "movie", items: [{ id: "tt-MINE" }], visibility: "public" },
    });
    assert.equal(r.body.ok, true, r.body.error);
    assert.equal(kv._store.get("publishedlist:user:movies-500"), before,
      "publishing over a full numbered range destroyed an existing list");
    // Whatever slug it did hand back must be free and must be where the new
    // list actually landed.
    const mine = JSON.parse(kv._store.get(`publishedlist:user:${r.body.listName}`));
    assert.equal(mine.items[0].id, "tt-MINE");
    assert.match(r.body.url, new RegExp(`/lists/user/${r.body.listName}$`));
  });

  it("allocates a slug in constant KV reads however crowded the name is", async () => {
    // Each numbered attempt used to be its own KV read, so one publish of a
    // heavily-collided name cost ~501 subrequests -- half the per-invocation
    // budget, on an unauthenticated endpoint, in a state anyone could
    // manufacture by publishing the same name repeatedly.
    async function readsForPublish(existing) {
      const kv = makeKv();
      kv._store.set("publishedlist:user:movies", "{}");
      for (let i = 2; i <= existing; i++) kv._store.set(`publishedlist:user:movies-${i}`, "{}");
      let reads = 0;
      const realGet = kv.get.bind(kv);
      kv.get = async (...a) => { reads++; return realGet(...a); };
      const env = makeEnv({ CONFIGS: kv });
      const r = await call(env, "/api/publish-list", {
        method: "POST",
        json: { name: "Movies", type: "movie", items: [{ id: "tt1" }], visibility: "public" },
      });
      assert.equal(r.body.ok, true, r.body.error);
      return reads;
    }
    const few = await readsForPublish(1);
    const many = await readsForPublish(499);
    assert.ok(many <= few + 20, `499 collisions cost ${many} KV reads vs ${few} for one -- the scan is still linear`);
    assert.ok(many < 100, `one publish spent ${many} KV reads`);
  });

  it("keeps tidy numbered slugs for the ordinary case", async () => {
    // The random suffix is the fallback, not the default: a second list of
    // the same name should still get "-2", not a token.
    const env = makeEnv();
    const first = await call(env, "/api/publish-list", {
      method: "POST", json: { name: "Movies", type: "movie", items: [{ id: "tt1" }], visibility: "public" },
    });
    const second = await call(env, "/api/publish-list", {
      method: "POST", ip: nextIp(),
      json: { name: "Movies", type: "movie", items: [{ id: "tt2" }], visibility: "public" },
    });
    assert.equal(first.body.listName, "movies");
    assert.equal(second.body.listName, "movies-2");
  });

  it("does not overwrite a creator's own list once their numbered range fills", async () => {
    const env = makeEnv();
    const alice = await createUser(env, "aliceslug");
    // 500 lists all called "Movies" in this creator's own namespace.
    const order = ["movies"];
    for (let i = 2; i <= 500; i++) order.push(`movies-${i}`);
    await env.CONFIGS.put(`creatorlistorder:${alice.creatorName}`, JSON.stringify({ order }));
    await env.CONFIGS.put(`creatorlist:${alice.creatorName}:movies-500`, JSON.stringify({
      name: "Movies", slug: "movies-500", type: "movie", visibility: "public",
      items: [{ id: "tt-EXISTING" }], likes: 3, createdAt: 1, updatedAt: 1,
    }));
    const before = await env.CONFIGS.get(`creatorlist:${alice.creatorName}:movies-500`);

    const r = await call(env, "/api/creator/lists/save", {
      method: "POST",
      json: {
        creatorName: alice.creatorName, creatorKey: alice.creatorKey,
        name: "Movies", type: "movie", visibility: "public", items: [{ id: "tt-MINE" }],
      },
    });
    assert.equal(r.body.ok, true, r.body.error);
    assert.equal(await env.CONFIGS.get(`creatorlist:${alice.creatorName}:movies-500`), before,
      "saving over a full numbered range destroyed the creator's own list");
  });
});

// A media-server webhook URL has to carry its credential in the query string
// -- Plex, Jellyfin and Emby accept a URL and nothing else -- so it ends up in
// their configuration and their logs. It used to carry the Creator Key: the
// credential for the whole account, with no expiry, whose only remedy on
// exposure was a rotation that signs the owner out everywhere.
describe("audit fix: the scrobble webhook carries a revocable token, not the Creator Key", () => {
  const scrobblePayload = { event: "media.scrobble", Metadata: { type: "movie", title: "X", year: 2000 } };
  const scrobble = (env, qs) => call(env, "/api/scrobble?" + qs, { method: "POST", ip: nextIp(), json: scrobblePayload });
  const mint = async (env, auth, rotate) => (await call(env, "/api/creator/scrobble-token", {
    method: "POST", ip: nextIp(), json: { ...auth, rotate },
  })).body;

  it("issues one stable token per account, and only to the key holder", async () => {
    const env = makeEnv();
    const alice = await createUser(env, "alicetok");
    const auth = { creatorName: alice.creatorName, creatorKey: alice.creatorKey };

    const first = await mint(env, auth, false);
    assert.equal(first.ok, true, first.error);
    assert.ok(first.token && first.token.length >= 16, "token is too short to be a credential");
    // Re-asking must not mint a second one, or every dashboard load would
    // orphan a live credential.
    const again = await mint(env, auth, false);
    assert.equal(again.token, first.token);

    const wrongKey = await call(env, "/api/creator/scrobble-token", {
      method: "POST", json: { creatorName: alice.creatorName, creatorKey: "MYL-BAD0-BAD0-BAD0" },
    });
    assert.equal(wrongKey.status, 401);
  });

  it("accepts the token on the webhook, and rejects a junk or missing one", async () => {
    const env = makeEnv();
    const alice = await createUser(env, "alicetokuse");
    const { token } = await mint(env, { creatorName: alice.creatorName, creatorKey: alice.creatorKey }, false);

    assert.equal((await scrobble(env, "st=" + token)).status, 200);
    assert.equal((await scrobble(env, "st=deadbeefdeadbeef")).status, 401);
    assert.equal((await scrobble(env, "")).status, 401);
  });

  it("regenerating revokes the previous webhook URL", async () => {
    const env = makeEnv();
    const alice = await createUser(env, "alicetokrot");
    const auth = { creatorName: alice.creatorName, creatorKey: alice.creatorKey };
    const before = (await mint(env, auth, false)).token;
    const after = (await mint(env, auth, true)).token;

    assert.notEqual(after, before, "rotate returned the same token");
    assert.equal((await scrobble(env, "st=" + before)).status, 401, "the old webhook URL still works");
    assert.equal((await scrobble(env, "st=" + after)).status, 200);
  });

  it("keeps pre-existing creator+key webhook URLs working", async () => {
    // Those URLs are sitting in people's media servers. Breaking them would
    // silently stop their history syncing with no error anyone would see.
    const env = makeEnv();
    const alice = await createUser(env, "alicetoklegacy");
    const legacy = `creator=${encodeURIComponent(alice.creatorName)}&key=${encodeURIComponent(alice.creatorKey)}`;
    assert.equal((await scrobble(env, legacy)).status, 200);
  });

  it("revokes the token when the account is deleted", async () => {
    // The token is keyed BY TOKEN, so it cannot be reached from a username
    // prefix sweep -- miss it and a deleted account leaves behind a live
    // credential that still authorises writes for it.
    const env = makeEnv();
    const alice = await createUser(env, "alicetokdel");
    const auth = { creatorName: alice.creatorName, creatorKey: alice.creatorKey };
    const { token } = await mint(env, auth, false);
    assert.equal((await scrobble(env, "st=" + token)).status, 200);

    const del = await call(env, "/api/creator/delete-account", {
      method: "POST", json: { ...auth, confirm: "DELETE" },
    });
    assert.equal(del.body.ok, true, del.body.error);

    assert.equal(await env.CONFIGS.get(`scrobbletoken:${token}`), null, "the token key outlived the account");
    assert.equal(await env.CONFIGS.get(`creatorscrobbletoken:${alice.creatorName}`), null, "the reverse index outlived the account");
    assert.equal((await scrobble(env, "st=" + token)).status, 401, "a deleted account's webhook still authorises writes");
  });

  it("no longer builds a webhook URL out of the Creator Key", async () => {
    // The panel's markup is assembled client-side, and the client bundle is
    // served from /app.js rather than inlined into the shell at "/" -- so
    // this checks the shipped bundle. The URL builder must take a token, and
    // the old key-bearing construction must be gone entirely.
    const env = makeEnv();
    const bundle = await call(env, "/app.js");
    assert.equal(bundle.status, 200);
    assert.match(bundle.text, /\/api\/scrobble\?st=/, "the webhook URL builder should use the token parameter");
    assert.ok(
      !/scrobble\?creator=['"]\s*\+\s*encodeURIComponent/.test(bundle.text),
      "the client still builds a webhook URL containing creator+key"
    );
    assert.ok(
      !/buildScrobbleWebhookUrl\(\s*activeCreator\.creatorName/.test(bundle.text),
      "buildScrobbleWebhookUrl is still being called with a creator name and key"
    );
  });
});

// The env-backed API key globals (TMDB_API_KEY and friends) are the names
// ~36 call sites across 03_, 05_, 06_ and 07_ reference directly. Only the
// fetch handler used to point them at env, so on an isolate whose first
// event was a cron tick they were all "". Nothing was broken in practice --
// both cron functions happen to read env.X and thread it down -- but the
// first cron-reachable helper that used a bare global would have run with an
// empty key: no crash, no error, a provider quietly returning nothing.
describe("audit fix: the cron connects the API key globals too", () => {
  it("populates them on an isolate whose first event is a cron tick", async () => {
    // A real fresh isolate: the built Worker evaluated in its own vm context,
    // with scheduled() as the only thing that ever runs.
    const src = fs.readFileSync(path.join(REPO_ROOT, "worker_entry_combined.js"), "utf8");
    const cut = src.lastIndexOf("export default");
    assert.notEqual(cut, -1);

    const sandbox = {
      console, Date, Math, JSON, TextEncoder, TextDecoder, URL, URLSearchParams,
      Response, Request, Headers, AbortController, AbortSignal, Promise, Map, Set,
      Array, Object, String, Number, Error, RegExp, structuredClone,
      crypto: globalThis.crypto,
      atob: (v) => Buffer.from(v, "base64").toString("binary"),
      btoa: (v) => Buffer.from(v, "binary").toString("base64"),
      setTimeout, clearTimeout, setInterval, clearInterval,
      caches: { default: { match: async () => null, put: async () => {} } },
      fetch: async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    // `let` at the top level of a vm script is script-scoped rather than a
    // property of the sandbox, so the readout has to be defined in the SAME
    // script to close over those bindings.
    vm.runInContext(
      src.slice(0, cut) +
      "\nglobalThis.__exp = " + src.slice(cut).replace(/^export default/, "") +
      "\nglobalThis.__keys = () => ({ TMDB_API_KEY, TRAKT_CLIENT_ID, SIMKL_CLIENT_ID, MDBLIST_API_KEY });",
      sandbox, { filename: "worker_entry_combined.js" }
    );

    assert.equal(sandbox.__keys().TMDB_API_KEY, "", "globals should start empty");

    const env = {
      CONFIGS: {
        get: async () => null, put: async () => {}, delete: async () => {},
        list: async () => ({ keys: [], list_complete: true }),
      },
      TMDB_API_KEY: "REAL_TMDB", TRAKT_CLIENT_ID: "REAL_TRAKT",
      SIMKL_CLIENT_ID: "REAL_SIMKL", MDBLIST_API_KEY: "REAL_MDBLIST",
    };
    await sandbox.__exp.scheduled({}, env, { waitUntil: () => {} });

    const keys = sandbox.__keys();
    assert.equal(keys.TMDB_API_KEY, "REAL_TMDB");
    assert.equal(keys.TRAKT_CLIENT_ID, "REAL_TRAKT");
    assert.equal(keys.SIMKL_CLIENT_ID, "REAL_SIMKL");
    assert.equal(keys.MDBLIST_API_KEY, "REAL_MDBLIST");
  });
});

// A 24/7 channel is a flat list of EPISODES, but every episode carries the
// imdbId/showId of the show it came from. Both places that built a channel's
// "See All" items used that show id as the item id, and the list-details grid
// dedupes by id (appendItems -- there to stop a provider that ignores its skip
// parameter from rendering the same page twice). So a channel collapsed to one
// poster per distinct show, and adding episodes changed nothing.
describe("bug: My Channels See All showed one item per show, not per episode", () => {
  const channelItemId = loadOneClientFunction("20_client-channel-builder.js", "channelItemId");

  // Exactly how appendItems (23_client-list-management.js) dedupes.
  function afterGridDedupe(items) {
    const seen = new Set();
    const kept = [];
    items.forEach((it) => {
      const key = it && (it.id != null ? String(it.id) : null);
      if (key === null || !seen.has(key)) {
        if (key !== null) seen.add(key);
        kept.push(it);
      }
    });
    return kept;
  }

  function buildChannel(shows, seasons, episodes) {
    const items = [];
    shows.forEach((show) => {
      for (let s = 1; s <= seasons; s++) {
        for (let e = 1; e <= episodes; e++) {
          items.push({ imdbId: show.imdbId, showName: show.name, season: s, episode: e, kind: "series" });
        }
      }
    });
    return items;
  }

  it("keeps every episode of a multi-show channel", () => {
    const shows = [
      { name: "The Office", imdbId: "tt0386676" },
      { name: "Parks and Rec", imdbId: "tt1266020" },
      { name: "Brooklyn Nine-Nine", imdbId: "tt2467372" },
    ];
    const channelItems = buildChannel(shows, 4, 10); // 120 episodes, 3 shows
    const sample = channelItems.map((it, idx) => ({ id: channelItemId(it, idx) }));

    assert.equal(sample.length, 120);
    assert.equal(new Set(sample.map((x) => x.id)).size, 120, "episode ids are not unique");
    // The actual regression: this used to be 3.
    assert.equal(afterGridDedupe(sample).length, 120, "the grid still collapses episodes to one per show");
  });

  it("uses the show:season:episode shape every other consumer already expects", () => {
    const id = channelItemId({ imdbId: "tt0386676", showName: "The Office", season: 2, episode: 7 }, 0);
    assert.equal(id, "tt0386676:2:7");
    // The poster click handler (19_client-search-and-likes.js) and
    // openItemDetailsModal (23_) both recover the show by splitting on the
    // first colon -- for tt-prefixed and numeric TMDB ids alike.
    assert.equal(id.split(":")[0], "tt0386676");
    const numeric = channelItemId({ showId: "1418", showName: "Big Bang", season: 3, episode: 1 }, 0);
    assert.equal(numeric, "1418:3:1");
    assert.equal(numeric.split(":")[0], "1418");
  });

  it("leaves items that carry no episode numbering alone", () => {
    // A movie-saga channel (MCU, Star Wars): each item is a distinct film and
    // its own id is already unique, so it must not gain a suffix.
    const films = [
      { imdbId: "tt0371746", showName: "Iron Man" },
      { imdbId: "tt0800080", showName: "The Incredible Hulk" },
      { imdbId: "tt1228705", showName: "Iron Man 2" },
    ];
    const sample = films.map((it, idx) => ({ id: channelItemId(it, idx) }));
    assert.deepEqual(sample.map((x) => x.id), ["tt0371746", "tt0800080", "tt1228705"]);
    assert.equal(afterGridDedupe(sample).length, 3);
  });

  it("still yields distinct ids when an item has no id at all", () => {
    const nameless = [{ showName: "Mystery" }, { showName: "Mystery" }];
    const sample = nameless.map((it, idx) => ({ id: channelItemId(it, idx) }));
    assert.equal(new Set(sample.map((x) => x.id)).size, 2, "id-less items collapsed together");
  });
});

// Discover's popular-lists feed types each entry, and that type is what the
// poster preview and See All are fetched with. /api/trakt-popular-lists used
// to answer "movie" for every single list, and to build the list URL from
// Trakt's DISPLAY username rather than the API-addressable slug.
describe("bug: Trakt popular lists were all typed movie, with display-name URLs", () => {
  // Trakt's /lists/popular payload, shaped the way their API really returns it.
  const traktPopularPayload = [
    { list: { name: "IMDB: Top Rated TV Shows", ids: { slug: "imdb-top-rated-tv-shows" }, item_count: 245, likes: 4350,
              user: { username: "justin", ids: { slug: "justin" } } } },
    { list: { name: "Shut Up, And Watch", ids: { slug: "shut-up-and-watch" }, item_count: 132, likes: 1538,
              user: { username: "CanConfirm", ids: { slug: "canconfirm" } } } },
    { list: { name: "A24", ids: { slug: "a24" }, item_count: 216, likes: 1420,
              user: { username: "Fidel.cb", ids: { slug: "fidel-cb" } } } },
    { list: { name: "Great Popular Shows", ids: { slug: "great-popular-shows" }, item_count: 534, likes: 1221,
              user: { username: "Spell3ound", ids: { slug: "spell3ound" } } } },
    { list: { name: "Best Movies of 2024", ids: { slug: "best-movies-2024" }, item_count: 50, likes: 900,
              user: { username: "someone", ids: { slug: "someone" } } } },
  ];

  async function popularLists() {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (u) => {
      if (String(typeof u === "string" ? u : u.url).includes("/lists/popular")) {
        return new Response(JSON.stringify(traktPopularPayload), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      // makeEnv only carries CONFIGS/ADMIN_KEY/DB through, so the provider key
      // has to be set on the env object itself or the route short-circuits to
      // { ok: false } before it ever calls Trakt.
      const env = { ...makeEnv(), TRAKT_CLIENT_ID: "test-trakt-key" };
      const r = await call(env, "/api/trakt-popular-lists");
      assert.equal(r.body.ok, true, "route returned no lists -- is the Trakt key set on env?");
      return r.body.lists;
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  it("does not report every popular list as movies", async () => {
    const lists = await popularLists();
    const byName = Object.fromEntries(lists.map((l) => [l.name, l]));
    // A shows-only list previewed as movies returns zero items, which is why
    // these rendered with no posters and a "No items found" See All.
    assert.equal(byName["IMDB: Top Rated TV Shows"].type, "series");
    assert.equal(byName["Great Popular Shows"].type, "series");
    assert.equal(byName["Best Movies of 2024"].type, "movie");
    // Ambiguous names must not be guessed at: "mixed" makes the client fetch
    // movies AND series and merge them, the same thing it already does for an
    // ambiguous search result.
    assert.equal(byName["Shut Up, And Watch"].type, "mixed");
    assert.equal(byName["A24"].type, "mixed");
    assert.ok(!lists.every((l) => l.type === "movie"), "every list is still typed movie");
  });

  it("addresses users by their API slug, not their display name", async () => {
    const lists = await popularLists();
    const a24 = lists.find((l) => l.name === "A24");
    // "Fidel.cb" is the display name; Trakt's API needs "fidel-cb". Building
    // the URL from the display name made this list fail to load entirely.
    assert.equal(a24.url, "https://trakt.tv/users/fidel-cb/lists/a24");
    assert.equal(a24.user, "Fidel.cb", "the display name should still be shown to the reader");

    for (const l of lists) {
      const userPart = l.url.split("/users/")[1].split("/")[0];
      assert.ok(!userPart.includes("."), `list URL still carries a display name: ${l.url}`);
    }
  });

  it("carries contentType so the search path agrees with the feed", async () => {
    // renderListSearchResults reads contentType first; without it a popular
    // list fell back to the same hardcoded type the feed had.
    const lists = await popularLists();
    assert.equal(lists.find((l) => l.name === "Great Popular Shows").contentType, "series");
    assert.equal(lists.find((l) => l.name === "Best Movies of 2024").contentType, "movie");
    assert.equal(lists.find((l) => l.name === "A24").contentType, "unknown");
  });
});

// The public index is a derived cache maintained by a read-modify-write on a
// single key, so a burst of updates loses some of them. Nothing used to repair
// that: a rebuild only ever ran when the index was MISSING, never when it was
// merely wrong. A live bulk delete left 76 entries advertising item counts for
// records that no longer existed, and they stayed there indefinitely.
describe("bug: a stale public index never repaired itself", () => {
  function seedWithPhantoms(phantomCount) {
    const kv = makeKv();
    kv._store.set("creator:someone", JSON.stringify({ displayName: "someone", keyHash: "pbkdf2:1:00:00" }));
    const entries = [];
    const order = [];
    for (const [slug, n] of [["hgtv", 79], ["travel", 47]]) {
      kv._store.set(`creatorlist:someone:${slug}`, JSON.stringify({
        name: slug, slug, type: "series", visibility: "public",
        items: Array.from({ length: n }, (_, i) => ({ id: "tt" + i })), likes: 0, updatedAt: 1,
      }));
      entries.push({ id: `c:someone:${slug}`, isCreator: true, username: "someone", creatorName: "someone",
                     slug, name: slug, type: "series", itemCount: n, likes: 0, updatedAt: 1 });
      order.push(slug);
    }
    // Entries whose record is gone: the directory shows a count, opening 404s.
    for (let i = 0; i < phantomCount; i++) {
      const slug = `ghost-${i}`;
      entries.push({ id: `c:someone:${slug}`, isCreator: true, username: "someone", creatorName: "someone",
                     slug, name: slug, type: "movie", itemCount: 462, likes: 0, updatedAt: 1 });
      order.push(slug);
    }
    kv._store.set("creatorlistorder:someone", JSON.stringify({ order }));
    return { kv, entries };
  }

  async function runCron(env, kv, maxTicks = 40) {
    for (let t = 1; t <= maxTicks; t++) {
      kv._store.delete("lock:publiclistindex");
      const pending = [];
      await worker.scheduled({}, env, { waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => {})) });
      await Promise.all(pending);
      if (!kv._store.has("index:publiclists:build")) return t;
    }
    return -1;
  }

  it("re-derives a stale index and drops entries whose record is gone", async () => {
    const { kv, entries } = seedWithPhantoms(76);
    kv._store.set("index:publiclists", JSON.stringify({ updatedAt: Date.now() - 25 * 3600 * 1000, entries }));
    const env = makeEnv({ CONFIGS: kv });

    const before = await call(env, "/lists/public.json?limit=500");
    assert.equal(before.body.total, 78, "expected the phantom entries to start out visible");

    assert.notEqual(await runCron(env, kv), -1, "the refresh never completed");

    const after = await call(env, "/lists/public.json?limit=500");
    assert.equal(after.body.total, 2, "phantom entries survived the refresh");
    assert.deepEqual((after.body.lists || []).map((l) => l.slug).sort(), ["hgtv", "travel"]);
    // The real lists must come through intact, not merely survive.
    assert.equal(after.body.lists.find((l) => l.slug === "hgtv").itemCount, 79);
  });

  it("leaves a fresh index alone", async () => {
    // Re-deriving on every tick would be a full scan of every list, forever.
    const { kv, entries } = seedWithPhantoms(3);
    kv._store.set("index:publiclists", JSON.stringify({ updatedAt: Date.now(), entries }));
    const env = makeEnv({ CONFIGS: kv });
    const snapshot = kv._store.get("index:publiclists");

    const pending = [];
    await worker.scheduled({}, env, { waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => {})) });
    await Promise.all(pending);

    assert.equal(kv._store.get("index:publiclists"), snapshot, "a fresh index was rebuilt needlessly");
  });

  it("keeps serving the old index while a multi-chunk refresh is in flight", async () => {
    // A partial scan must never be published as though it were the whole
    // directory, or the listing would shrink and grow while it runs.
    const { kv, entries } = seedWithPhantoms(400);
    kv._store.set("index:publiclists", JSON.stringify({ updatedAt: Date.now() - 25 * 3600 * 1000, entries }));
    const env = makeEnv({ CONFIGS: kv });

    kv._store.delete("lock:publiclistindex");
    const pending = [];
    await worker.scheduled({}, env, { waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => {})) });
    await Promise.all(pending);

    if (kv._store.has("index:publiclists:build")) {
      const mid = await call(env, "/lists/public.json?limit=500");
      assert.equal(mid.body.total, 402, "the directory changed mid-refresh");
    }
    assert.notEqual(await runCron(env, kv), -1);
    const after = await call(env, "/lists/public.json?limit=500");
    assert.equal(after.body.total, 2);
  });
});

describe("admin: deleting a creator's lists", () => {
  async function setup(phantoms = 2) {
    const kv = makeKv();
    kv._store.set("creator:someone", JSON.stringify({ displayName: "someone", keyHash: "pbkdf2:1:00:00" }));
    const entries = [];
    const order = [];
    for (const slug of ["keepme", "deleteme"]) {
      kv._store.set(`creatorlist:someone:${slug}`, JSON.stringify({
        name: slug, slug, type: "series", visibility: "public",
        items: [{ id: "tt1" }], likes: 2, updatedAt: 1,
      }));
      kv._store.set(`listlikevoters:someone:${slug}`, JSON.stringify(["a:one", "a:two"]));
      entries.push({ id: `c:someone:${slug}`, isCreator: true, username: "someone", creatorName: "someone",
                     slug, name: slug, type: "series", itemCount: 1, likes: 2, updatedAt: 1 });
      order.push(slug);
    }
    for (let i = 0; i < phantoms; i++) {
      const slug = `ghost-${i}`;
      entries.push({ id: `c:someone:${slug}`, isCreator: true, username: "someone", creatorName: "someone",
                     slug, name: slug, type: "movie", itemCount: 462, likes: 0, updatedAt: 1 });
      order.push(slug);
    }
    kv._store.set("creatorlistorder:someone", JSON.stringify({ order }));
    kv._store.set("index:publiclists", JSON.stringify({ updatedAt: Date.now(), entries }));
    const env = makeEnv({ CONFIGS: kv });
    return { kv, env, cookie: await adminCookie(env) };
  }

  it("requires admin auth", async () => {
    const { env } = await setup();
    const r = await call(env, "/admin/api/delete-creator-list", {
      method: "POST", json: { username: "someone", slugs: ["deleteme"] },
    });
    assert.equal(r.status, 401);
    assert.notEqual(await env.CONFIGS.get("creatorlist:someone:deleteme"), null, "the list was deleted anyway");
  });

  it("removes the list, its likes, its order entry and its directory entry", async () => {
    const { kv, env, cookie } = await setup();
    const r = await call(env, "/admin/api/delete-creator-list", {
      method: "POST", cookie, json: { username: "someone", slugs: ["deleteme"] },
    });
    assert.equal(r.body.ok, true, r.body.error);
    assert.deepEqual(r.body.deleted, ["deleteme"]);

    assert.equal(await env.CONFIGS.get("creatorlist:someone:deleteme"), null, "record left behind");
    // A stranded ledger means whoever next takes that slug inherits its likes.
    assert.equal(await env.CONFIGS.get("listlikevoters:someone:deleteme"), null, "like ledger left behind");
    assert.equal(JSON.parse(kv._store.get("creatorlistorder:someone")).order.includes("deleteme"), false);

    const dir = await call(env, "/lists/public.json?limit=500");
    assert.equal((dir.body.lists || []).some((l) => l.slug === "deleteme"), false, "still in the directory");
    // ...and the untouched list is untouched.
    assert.notEqual(await env.CONFIGS.get("creatorlist:someone:keepme"), null);
    assert.notEqual(await env.CONFIGS.get("listlikevoters:someone:keepme"), null);
  });

  it("clears a phantom entry whose record is already gone", async () => {
    // The whole reason an admin reaches for this: an entry that advertises an
    // item count and then opens empty. It is reported as missing, not failed.
    const { env, cookie } = await setup();
    const r = await call(env, "/admin/api/delete-creator-list", {
      method: "POST", cookie, json: { username: "someone", slugs: ["ghost-0", "ghost-1"] },
    });
    assert.equal(r.body.ok, true, r.body.error);
    assert.deepEqual(r.body.deleted, []);
    assert.deepEqual(r.body.missing.sort(), ["ghost-0", "ghost-1"]);
    const dir = await call(env, "/lists/public.json?limit=500");
    assert.equal((dir.body.lists || []).some((l) => String(l.slug).startsWith("ghost-")), false);
  });

  it("bounds how many lists one call may delete", async () => {
    const { env, cookie } = await setup();
    const r = await call(env, "/admin/api/delete-creator-list", {
      method: "POST", cookie,
      json: { username: "someone", slugs: Array.from({ length: 60 }, (_, i) => "x" + i) },
    });
    assert.equal(r.status, 413);
    assert.equal(r.body.ok, false);
  });

  it("rejects a bad username or an empty slug list", async () => {
    const { env, cookie } = await setup();
    assert.equal((await call(env, "/admin/api/delete-creator-list", {
      method: "POST", cookie, json: { username: "", slugs: ["x"] } })).status, 400);
    assert.equal((await call(env, "/admin/api/delete-creator-list", {
      method: "POST", cookie, json: { username: "someone", slugs: [] } })).status, 400);
  });

  it("the creator's own delete route cleans up the same way", async () => {
    // Both go through deleteCreatorLists so an admin deletion and an owner
    // deletion cannot clean up differently -- the like ledger in particular
    // used to survive the owner's own delete.
    const env = makeEnv();
    const alice = await createUser(env, "alicedel2");
    const saved = await call(env, "/api/creator/lists/save", {
      method: "POST",
      json: { creatorName: alice.creatorName, creatorKey: alice.creatorKey,
              name: "Temp", type: "movie", visibility: "public", items: [{ id: "tt1" }] },
    });
    const slug = saved.body.slug;
    await env.CONFIGS.put(`listlikevoters:${alice.creatorName}:${slug}`, JSON.stringify(["a:one"]));

    const del = await call(env, "/api/creator/lists/delete", {
      method: "POST",
      json: { creatorName: alice.creatorName, creatorKey: alice.creatorKey, slug },
    });
    assert.equal(del.body.ok, true);
    assert.equal(await env.CONFIGS.get(`creatorlist:${alice.creatorName}:${slug}`), null);
    assert.equal(await env.CONFIGS.get(`listlikevoters:${alice.creatorName}:${slug}`), null,
      "the owner's own delete still leaves the like ledger behind");
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

// The page loads fflate from a CDN that the CSP's script-src allows, so
// whatever that URL returns runs with full page privileges -- and this page
// keeps myListAddon:creatorKey, the MDBList/Simkl access tokens and the
// provider API keys in localStorage, all readable by any script in it.
// Pinning the version is not integrity checking.
describe("audit fix: the CDN script is integrity-pinned", () => {
  it("carries an SRI hash and crossorigin on every external script", async () => {
    const env = makeEnv();
    const page = await call(env, "/");
    const externals = [...page.text.matchAll(/<script\b[^>]*\bsrc="(https?:[^"]+)"[^>]*>/g)];
    assert.ok(externals.length > 0, "expected at least one external script tag");
    for (const [tag, src] of externals) {
      assert.match(tag, /\bintegrity="sha(256|384|512)-[A-Za-z0-9+/=]+"/, `no SRI hash on ${src}`);
      // Required for SRI to be enforced on a cross-origin script.
      assert.match(tag, /\bcrossorigin="anonymous"/, `no crossorigin on ${src}`);
      // A hash only means anything against a pinned version.
      assert.match(src, /@\d+\.\d+\.\d+\//, `unpinned version in ${src}`);
    }
  });

  it("pins a hash that matches the bytes the CDN actually serves", { skip: !process.env.NETWORK_TESTS }, async () => {
    // Opt-in (NETWORK_TESTS=1): the rest of the suite is hermetic, and CI
    // should not fail because a CDN is briefly unreachable. Run this when
    // changing the script URL or bumping its version.
    const env = makeEnv();
    const page = await call(env, "/");
    const m = page.text.match(/<script\b[^>]*\bsrc="(https:[^"]+)"[^>]*\bintegrity="sha384-([A-Za-z0-9+/=]+)"/);
    assert.ok(m, "no integrity-pinned external script found");
    const [, src, pinned] = m;
    const res = await fetch(src);
    assert.equal(res.status, 200);
    const digest = await crypto.subtle.digest("SHA-384", await res.arrayBuffer());
    const actual = Buffer.from(digest).toString("base64");
    assert.equal(actual, pinned, `SRI hash does not match what ${src} serves -- regenerate it`);
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

  // The companion to the race test below. Retrying whenever a vote is not
  // visible in the read-back treats every stale read as contention, and KV
  // reads are edge-cached, so on an otherwise idle list that spent a second
  // write against a key KV limits to one write per second. The retry is now
  // gated on evidence of another writer -- an id present that was not in our
  // own pre-write snapshot -- which a stale read cannot produce.
  it("does not re-write the ledger when KV merely serves a stale read", async () => {
    const env = makeEnv();
    const alice = await createUser(env, "alicestale");
    const saved = await call(env, "/api/creator/lists/save", {
      method: "POST",
      json: {
        creatorName: alice.creatorName, creatorKey: alice.creatorKey,
        name: "StaleList", type: "movie", visibility: "public",
        items: [{ id: "tt0111161", name: "Item" }],
      },
    });
    const ledgerKey = `listlikevoters:${alice.creatorName}:${saved.body.slug}`;

    const realPut = env.CONFIGS.put.bind(env.CONFIGS);
    const realGet = env.CONFIGS.get.bind(env.CONFIGS);
    let ledgerWrites = 0;
    let previous = null;
    let havePrevious = false; // a first write's previous value is legitimately null
    let servedStale = 0;
    env.CONFIGS.put = async (key, value) => {
      if (key === ledgerKey) { previous = await realGet(key); havePrevious = true; ledgerWrites++; }
      return realPut(key, value);
    };
    // Edge caching does not clear within one request, so serve the pre-write
    // value for several reads rather than just one.
    env.CONFIGS.get = async (key, type) => {
      if (key === ledgerKey && havePrevious && servedStale < 6) { servedStale++; return previous; }
      return realGet(key, type);
    };

    const r = await call(env, "/api/lists/like", {
      method: "POST",
      json: { username: alice.creatorName, slug: saved.body.slug },
    });
    assert.equal(r.body.ok, true);
    assert.ok(servedStale > 0, "the stale-read condition never triggered");
    assert.equal(ledgerWrites, 1, `a stale read caused ${ledgerWrites} writes to a 1-write/sec key`);

    const stored = JSON.parse(await realGet(ledgerKey));
    assert.equal(stored.length, 1);
    assert.equal(r.body.likes, stored.length, "reported count does not match storage");
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

// The duplicate-list bug: an account reached 129 list records for 22 real
// lists -- 44 copies of the same 462-item list, coming-of-age-3 through
// coming-of-age-53, every copy with an identical item count. Three defects
// compounded; each of these covers one, plus one covering the whole loop.
describe("duplicate lists: a save asked for a slug gets that slug", () => {
  it("honours an explicit slug instead of silently minting a different one", async () => {
    const env = makeEnv();
    const u = await createUser(env, "slugowner");
    // Occupy the slug this list's NAME would produce, so the old code had a
    // collision to route around.
    await call(env, "/api/creator/lists/save", { method: "POST", json: {
      creatorName: u.creatorName, creatorKey: u.creatorKey,
      name: "Coming of Age", type: "movie", items: [{ id: "other" }], visibility: "public",
    }});
    const r = await call(env, "/api/creator/lists/save", { method: "POST", json: {
      creatorName: u.creatorName, creatorKey: u.creatorKey,
      slug: "my-own-slug", name: "Coming of Age", type: "movie",
      items: [{ id: "tt1" }], visibility: "public",
    }});
    assert.equal(r.body.ok, true);
    assert.equal(r.body.slug, "my-own-slug",
      "a save that names a slug must store it under that slug, not report ok:true for a different one");
  });

  it("is idempotent: asking for the same slug six times yields one list, not six", async () => {
    const env = makeEnv();
    const u = await createUser(env, "idem");
    // The precondition the runaway needs: the slug this list's NAME produces
    // belongs to a different list, so the old code had to route around it and
    // routed somewhere new every single time.
    await call(env, "/api/creator/lists/save", { method: "POST", json: {
      creatorName: u.creatorName, creatorKey: u.creatorKey,
      name: "Coming of Age", type: "movie", items: [{ id: "someone-elses" }], visibility: "public",
    }});
    const save = () => call(env, "/api/creator/lists/save", { method: "POST", json: {
      creatorName: u.creatorName, creatorKey: u.creatorKey,
      slug: "coming-of-age-mine", name: "Coming of Age", type: "movie",
      items: [{ id: "tt1" }], visibility: "public",
    }});
    for (let i = 0; i < 6; i++) {
      const r = await save();
      assert.equal(r.body.slug, "coming-of-age-mine", `save ${i + 1} drifted to ${r.body.slug}`);
    }
    const keys = (await env.CONFIGS.list({ prefix: "creatorlist:idem:" })).keys;
    assert.equal(keys.length, 2,
      `six identical saves of one list left ${keys.length} records: ${keys.map((k) => k.name).join(", ")}`);
  });

  it("sanitises the slug it is handed -- it now reaches a KV key and a URL", async () => {
    const env = makeEnv();
    const u = await createUser(env, "sanitise");
    const r = await call(env, "/api/creator/lists/save", { method: "POST", json: {
      creatorName: u.creatorName, creatorKey: u.creatorKey,
      slug: "../../creator:someone-else", name: "Nice List", type: "movie",
      items: [], visibility: "public",
    }});
    assert.equal(r.body.ok, true);
    assert.match(r.body.slug, /^[a-z0-9-]+$/, `unsanitised slug stored: ${r.body.slug}`);
    const keys = (await env.CONFIGS.list({ prefix: "creatorlist:" })).keys.map((k) => k.name);
    assert.ok(keys.every((k) => k.startsWith("creatorlist:sanitise:")),
      `a slug escaped its own namespace: ${keys.join(", ")}`);
  });
});

describe("duplicate lists: creatorlistorder: is not the last word on what exists", () => {
  it("a list whose order entry was lost still appears on the dashboard", async () => {
    const env = makeEnv();
    const u = await createUser(env, "lostorder");
    for (const name of ["Coming of Age", "Food Network", "HGTV"]) {
      await call(env, "/api/creator/lists/save", { method: "POST", json: {
        creatorName: u.creatorName, creatorKey: u.creatorKey,
        name, type: "movie", items: [{ id: "tt1" }], visibility: "public",
      }});
    }
    // What a clobbered read-modify-write leaves behind: the records are all
    // there, the order key remembers one of them.
    await env.CONFIGS.put("creatorlistorder:lostorder", JSON.stringify({ order: ["coming-of-age"] }));

    const r = await call(env, "/api/creator/lists", { method: "POST", json: {
      creatorName: u.creatorName, creatorKey: u.creatorKey,
    }});
    const slugs = (r.body.lists || []).map((l) => l.slug).sort();
    assert.deepEqual(slugs, ["coming-of-age", "food-network", "hgtv"],
      "records with no order entry were dropped from the dashboard, which is what made the client re-upload them");
    const items = (r.body.lists || []).find((l) => l.slug === "hgtv");
    assert.equal(items.items.length, 1, "a recovered list must come back with its items, not as an empty shell");
  });

  it("repairs the order key so the drift does not persist", async () => {
    const env = makeEnv();
    const u = await createUser(env, "repairorder");
    for (const name of ["One", "Two"]) {
      await call(env, "/api/creator/lists/save", { method: "POST", json: {
        creatorName: u.creatorName, creatorKey: u.creatorKey,
        name, type: "movie", items: [], visibility: "public",
      }});
    }
    await env.CONFIGS.put("creatorlistorder:repairorder", JSON.stringify({ order: [] }));
    await call(env, "/api/creator/lists", { method: "POST", json: {
      creatorName: u.creatorName, creatorKey: u.creatorKey,
    }});
    const order = JSON.parse(await env.CONFIGS.get("creatorlistorder:repairorder")).order.sort();
    assert.deepEqual(order, ["one", "two"], "order was left broken after the read path had already found the records");
  });

  it("allocating a new slug checks KV, not just order, so it cannot land on a live record", async () => {
    const env = makeEnv();
    const u = await createUser(env, "noclobber");
    await call(env, "/api/creator/lists/save", { method: "POST", json: {
      creatorName: u.creatorName, creatorKey: u.creatorKey,
      name: "Coming of Age", type: "movie", items: [{ id: "original" }], visibility: "public",
    }});
    // Order forgets it; the record is still live.
    await env.CONFIGS.put("creatorlistorder:noclobber", JSON.stringify({ order: [] }));
    const r = await call(env, "/api/creator/lists/save", { method: "POST", json: {
      creatorName: u.creatorName, creatorKey: u.creatorKey,
      name: "Coming of Age", type: "movie", items: [{ id: "different" }], visibility: "public",
    }});
    assert.notEqual(r.body.slug, "coming-of-age",
      "a new list was allocated a slug whose record already existed, writing over it");
    const original = JSON.parse(await env.CONFIGS.get("creatorlist:noclobber:coming-of-age"));
    assert.equal(original.items[0].id, "original", "the existing list was overwritten");
  });
});

describe("duplicate lists: the dashboard upload loop terminates", () => {
  // Drives the shape of renderCreatorDashboard's "merge any local list not
  // yet on the server" block against the real routes: read the account, save
  // whatever the local store has that the account does not, repeat. Before
  // the fix this gained one visible list per round and a duplicate record for
  // every other one; it must now settle after a single round.
  it("22 local lists converge to 22 records and stay there", async () => {
    const env = makeEnv();
    const u = await createUser(env, "converge");
    // Give KV a real await boundary between read and write. The mock is
    // otherwise fast enough to serialise every handler, which hides the whole
    // problem: nothing about the read-modify-write on creatorlistorder: is
    // atomic, and on a real edge these saves overlap.
    const rawGet = env.CONFIGS.get.bind(env.CONFIGS);
    const rawPut = env.CONFIGS.put.bind(env.CONFIGS);
    const tick = () => new Promise((r) => setTimeout(r, 1));
    env.CONFIGS.get = async (...a) => { await tick(); return rawGet(...a); };
    env.CONFIGS.put = async (...a) => { await tick(); return rawPut(...a); };
    const names = ["Coming of Age", "Food Network", "HGTV", "Oxygen", "Acorn TV", "Britbox",
      "Travel", "Christmas", "Miniseries", "Discovery ID", "Animal Planet", "Nordic Noir",
      "Chick Flicks", "TV", "Currently Watching", "Movies Watchlist", "National Geographic",
      "Music Docs", "Mystery Documentary", "Documentary Reality TV", "TV Shows Horror",
      "Hallmark Movies"];
    const local = names.map((n) => ({ slug: n.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name: n }));

    for (let round = 0; round < 4; round++) {
      const listsRes = await call(env, "/api/creator/lists", { method: "POST", json: {
        creatorName: u.creatorName, creatorKey: u.creatorKey,
      }});
      const have = new Set((listsRes.body.lists || []).map((l) => l.slug));
      const missing = local.filter((l) => !have.has(l.creatorSlug || l.slug));
      if (round > 0) {
        assert.equal(missing.length, 0,
          `round ${round + 1} still thought ${missing.length} lists were missing -- the loop does not terminate`);
      }
      // Deliberately the OLD client shape: all at once, replies discarded.
      // The server side has to survive this on its own, because a browser
      // running a cached copy of the page will keep doing exactly this.
      await Promise.all(missing.map((l) => call(env, "/api/creator/lists/save", { method: "POST", json: {
        creatorName: u.creatorName, creatorKey: u.creatorKey,
        slug: l.creatorSlug || l.slug, name: l.name, type: "movie",
        items: [{ id: "tt1" }], visibility: "public",
      }})));
    }
    const keys = (await env.CONFIGS.list({ prefix: "creatorlist:converge:" })).keys;
    assert.equal(keys.length, 22, `4 dashboard rounds left ${keys.length} records for 22 lists`);
    assert.equal(keys.filter((k) => /-\d+$/.test(k.name)).length, 0,
      "numbered duplicate slugs were minted: " + keys.map((k) => k.name).join(", "));
  });
});

// Removing one item from Watch History's See All page used to call
// renderWatchHistoryGrid(), which starts with gridEl.innerHTML = '' and
// rebuilds every tile -- so deleting one thing blanked the grid, re-requested
// every poster and scrolled back to the top. It now updates in place.
describe("watch history See All: removing an item does not rebuild the grid", () => {
  function makeCard(removeId) {
    const card = { style: {}, parentNode: null };
    const btn = {
      dataset: { removeType: "history", removeId: String(removeId) },
      closest: (sel) => (sel.includes("live-preview-poster-card") ? card : null),
    };
    card.btn = btn;
    return card;
  }
  function makeDom(cards, opts = {}) {
    const grid = {
      innerHTML: "<!-- rendered once -->",
      cards: cards.slice(),
      querySelectorAll() { return this.cards.map((c) => c.btn); },
    };
    grid.cards.forEach((c) => {
      c.parentNode = { removeChild: (x) => { grid.cards = grid.cards.filter((k) => k !== x); x.parentNode = null; } };
    });
    const sub = { textContent: "" };
    const status = { innerHTML: "" };
    const tab = { hasAttribute: (a) => (a === "hidden" ? !!opts.hidden : false) };
    return {
      grid, sub, status,
      document: { getElementById: (id) => ({
        detailGrid: grid, detailSubtitle: sub, detailStatus: status, "content-list-details": tab,
      }[id] || null) },
    };
  }
  function load(dom, win, grouped) {
    return loadOneClientFunction("23_client-list-management.js", "updateWatchHistoryGridAfterRemoval", {
      document: dom.document,
      window: win,
      localStorage: { getItem: (k) => (k === "myListAddon:watchHistoryGroupShows" ? (grouped ? "true" : "false") : null) },
      watchHistoryTileCount: loadOneClientFunction("23_client-list-management.js", "watchHistoryTileCount", {
        watchHistoryPassesFilter: loadOneClientFunction("23_client-list-management.js", "watchHistoryPassesFilter", {
          watchHistoryGridType: loadOneClientFunction("23_client-list-management.js", "watchHistoryGridType"),
        }),
      }),
    });
  }

  it("leaves the surviving tiles and the grid markup untouched", () => {
    const cards = [makeCard("tt1"), makeCard("tt2"), makeCard("tt3")];
    const dom = makeDom(cards);
    const before = dom.grid.innerHTML;
    // The person removed tt2; the raw list has already dropped it and its own
    // handler is fading its tile out.
    cards[1].style.opacity = "0";
    const win = {
      _currentListDetailsParams: { listUrl: "watch-history", name: "Watch History" },
      _rawWatchHistoryItems: [{ id: "tt1" }, { id: "tt3" }],
      _watchHistoryFilter: "all",
    };
    assert.equal(load(dom, win)(), true, "should report that it handled the update itself");
    assert.equal(dom.grid.innerHTML, before, "the grid was rebuilt -- that is the reload the person sees");
    assert.equal(dom.grid.cards.length, 3, "the fading tile must be left to its own animation, not yanked");
    assert.equal(dom.sub.textContent, "2 items");
  });

  it("drops any other tile the removal took with it, without a rebuild", () => {
    const cards = [makeCard("tt1"), makeCard("s1:1:1"), makeCard("s1:1:2")];
    const dom = makeDom(cards);
    const before = dom.grid.innerHTML;
    cards[1].style.opacity = "0";
    // Removing a show clears every episode of it from the raw list.
    const win = {
      _currentListDetailsParams: { listUrl: "watch-history", name: "Watch History" },
      _rawWatchHistoryItems: [{ id: "tt1" }],
      _watchHistoryFilter: "all",
    };
    assert.equal(load(dom, win)(), true);
    assert.equal(dom.grid.innerHTML, before, "the grid must not be rebuilt to drop a stale tile");
    assert.deepEqual(dom.grid.cards.map((c) => c.btn.dataset.removeId), ["tt1", "s1:1:1"],
      "the stale episode tile should be gone; the fading one left alone");
    assert.equal(dom.sub.textContent, "1 item");
  });

  it("counts against the active filter pill, not the whole history", () => {
    const dom = makeDom([makeCard("tt1"), makeCard("s1:1:1")]);
    const win = {
      _currentListDetailsParams: { listUrl: "watch-history", name: "Watch History" },
      _rawWatchHistoryItems: [{ id: "tt1", type: "movie" }, { id: "s1:1:1", showId: "s1" }],
      _watchHistoryFilter: "movie",
    };
    assert.equal(load(dom, win)(), true);
    assert.equal(dom.sub.textContent, "1 item");
    assert.equal(dom.status.innerHTML, "");
  });

  it("says so, rather than guessing, when the last item goes", () => {
    const cards = [makeCard("tt1")];
    const dom = makeDom(cards);
    cards[0].style.opacity = "0";
    const win = {
      _currentListDetailsParams: { listUrl: "watch-history", name: "Watch History" },
      _rawWatchHistoryItems: [],
      _watchHistoryFilter: "all",
    };
    assert.equal(load(dom, win)(), true);
    assert.equal(dom.sub.textContent, "0 items");
    assert.match(dom.status.innerHTML, /No matching items/);
  });

  it("keeps a grouped show tile while any episode of it remains", () => {
    const cards = [makeCard("s1"), makeCard("s2")];
    const dom = makeDom(cards);
    const before = dom.grid.innerHTML;
    const win = {
      // s1 still has an episode; every episode of s2 has gone.
      _currentListDetailsParams: { listUrl: "watch-history", name: "Watch History" },
      _rawWatchHistoryItems: [{ id: "s1:1:2", showId: "s1" }],
      _watchHistoryFilter: "all",
    };
    assert.equal(load(dom, win, true)(), true);
    assert.equal(dom.grid.innerHTML, before, "grouped mode must not rebuild either");
    assert.deepEqual(dom.grid.cards.map((c) => c.btn.dataset.removeId), ["s1"]);
    assert.equal(dom.sub.textContent, "1 item", "grouped counts tiles, not raw items");
  });

  it("counts grouped tiles, not the episodes behind them", () => {
    const dom = makeDom([makeCard("s1"), makeCard("tt9")]);
    const win = {
      _currentListDetailsParams: { listUrl: "watch-history", name: "Watch History" },
      _rawWatchHistoryItems: [
        { id: "s1:1:1", showId: "s1" }, { id: "s1:1:2", showId: "s1" }, { id: "s1:2:1", showId: "s1" },
        { id: "tt9", type: "movie" },
      ],
      _watchHistoryFilter: "all",
    };
    assert.equal(load(dom, win, true)(), true);
    assert.equal(dom.sub.textContent, "2 items", "3 episodes of one show plus a movie is 2 tiles");
  });

  it("falls back to the full render when there is no item list to reconcile against", () => {
    const dom = makeDom([makeCard("tt1")]);
    const win = {
      _currentListDetailsParams: { listUrl: "watch-history", name: "Watch History" },
      _watchHistoryFilter: "all",
    };
    assert.equal(load(dom, win)(), false);
  });

  it("does nothing to a See All page showing some other list", () => {
    const cards = [makeCard("tt1"), makeCard("tt2")];
    const dom = makeDom(cards);
    const win = {
      _currentListDetailsParams: { listUrl: "trakt:history", name: "Trakt History" },
      _rawWatchHistoryItems: [{ id: "tt1" }],
      _watchHistoryFilter: "all",
    };
    assert.equal(load(dom, win)(), true);
    assert.equal(dom.grid.cards.length, 2, "another list's tiles must not be touched");
    assert.equal(dom.sub.textContent, "", "nor its subtitle rewritten");
  });
});

describe("watch history See All: the remove handler stops rebuilding the grid", () => {
  // The one that reproduces the reported behaviour rather than covering the
  // new helper: removeWatchHistoryItemDirect used to call renderWatchHistoryGrid
  // unconditionally whenever the See All page was open.
  function run({ grouped = false } = {}) {
    const calls = { fullRender: 0, inPlace: 0 };
    const map = { "watch-history": { items: [{ id: "tt1" }, { id: "tt2" }] } };
    const win = {};
    const detailTab = { hidden: false };
    const remove = loadOneClientFunction("22_client-creator-profile.js", "removeWatchHistoryItemDirect", {
      window: win,
      document: { getElementById: (id) => (id === "content-list-details" ? detailTab : null) },
      loadLocalCustomLists: () => map,
      saveLocalCustomListsMap: () => true,
      scheduleCreatorSyncSave: () => {},
      renderCreatorDashboard: () => {},
      showAddedToast: () => {},
      syncAiringNextWatchState: () => {},
      renderWatchHistoryGrid: () => { calls.fullRender++; },
      updateWatchHistoryGridAfterRemoval: () => { calls.inPlace++; return !grouped; },
    });
    win._rawWatchHistoryItems = [{ id: "tt1" }, { id: "tt2" }];
    remove("tt2", null);
    return { calls, win, map };
  }

  it("updates in place instead of re-rendering every tile", () => {
    const { calls, win, map } = run();
    assert.equal(calls.inPlace, 1, "the in-place update should be attempted");
    assert.equal(calls.fullRender, 0,
      "the grid was rebuilt from scratch -- that is the whole list reloading on a single removal");
    assert.deepEqual(win._rawWatchHistoryItems.map((i) => i.id), ["tt1"], "the item must still actually be removed");
    assert.deepEqual(map["watch-history"].items.map((i) => i.id), ["tt1"]);
  });

  it("still falls back to the full render when the in-place update cannot cope", () => {
    const { calls } = run({ grouped: true });
    assert.equal(calls.inPlace, 1);
    assert.equal(calls.fullRender, 1, "grouped-by-show needs the layout recomputing and must not be left stale");
  });
});

// In grouped-by-show mode the grid built its show tiles with removeShowId.
// livePreviewPosterHtml reads that field as "this is a Continue Watching
// tile" -- it tests for it before removeHistoryId, and isCwItem keys off it
// too -- so the x on a grouped Watch History show was labelled "Remove from
// Continue Watching", dispatched to dismissContinueWatchingShow, left the
// watch history untouched, and picked up Continue Watching's poster badges.
describe("watch history: grouped show tiles remove from Watch History", () => {
  function renderGrouped(rawItems, opts = {}) {
    let captured = null;
    const sub = { textContent: "" };
    const status = { innerHTML: "" };
    const els = {
      detailGrid: { innerHTML: "" },
      detailSubtitle: sub,
      detailStatus: status,
      "content-list-details": { hasAttribute: () => false },
    };
    const win = {
      _currentListDetailsParams: { listUrl: "watch-history", name: "Watch History" },
      _rawWatchHistoryItems: rawItems,
      _watchHistoryFilter: opts.filter || "all",
      _watchHistorySort: "recent",
    };
    const render = loadOneClientFunction("23_client-list-management.js", "renderWatchHistoryGrid", {
      document: { getElementById: (id) => els[id] || null },
      window: win,
      localStorage: { getItem: (k) => (k === "myListAddon:watchHistoryGroupShows" ? (opts.grouped ? "true" : "false") : null) },
      formatWatchItemLabel: (it) => ({ title: it.title || it.name || "", subtitle: "" }),
      watchHistoryGridType: loadOneClientFunction("23_client-list-management.js", "watchHistoryGridType"),
      renderPosterGridChunked: (_grid, items) => { captured = items; },
    });
    render();
    return { tiles: captured, sub, status };
  }

  const HISTORY = [
    { id: "s1:1:1", showId: "s1", showTitle: "A Show", type: "episode", watchedAt: 3 },
    { id: "s1:1:2", showId: "s1", showTitle: "A Show", type: "episode", watchedAt: 2 },
    { id: "tt9", title: "A Movie", type: "movie", watchedAt: 1 },
  ];

  it("builds the show tile with a history remove target, not a Continue Watching one", () => {
    const { tiles } = renderGrouped(HISTORY, { grouped: true });
    const show = tiles.find((t) => t.type === "series");
    assert.ok(show, "expected a grouped show tile");
    assert.equal(show.removeShowId, undefined,
      "removeShowId makes livePreviewPosterHtml render a Continue Watching button and treat the tile as a CW item");
    assert.equal(show.removeHistoryId, "s1", "the tile should remove the show from Watch History");
  });

  it("removing that tile clears every watched episode of the show", () => {
    const map = { "watch-history": { items: HISTORY.slice() } };
    const win = {};
    const remove = loadOneClientFunction("22_client-creator-profile.js", "removeWatchHistoryItemDirect", {
      window: win,
      document: { getElementById: () => null },
      loadLocalCustomLists: () => map,
      saveLocalCustomListsMap: () => true,
      scheduleCreatorSyncSave: () => {},
      renderCreatorDashboard: () => {},
      showAddedToast: () => {},
      syncAiringNextWatchState: () => {},
      renderWatchHistoryGrid: () => {},
      updateWatchHistoryGridAfterRemoval: () => true,
    });
    const { tiles } = renderGrouped(HISTORY, { grouped: true });
    remove(tiles.find((t) => t.type === "series").removeHistoryId, null);
    assert.deepEqual(map["watch-history"].items.map((i) => i.id), ["tt9"],
      "both episodes of the show should be gone, the movie untouched");
  });

  it("leaves the ungrouped tiles removing one item each", () => {
    const { tiles } = renderGrouped(HISTORY, { grouped: false });
    assert.deepEqual(tiles.map((t) => t.removeHistoryId).sort(), ["s1:1:1", "s1:1:2", "tt9"]);
    assert.ok(tiles.every((t) => t.removeShowId === undefined));
  });

  it("agrees with watchHistoryTileCount about how many tiles there are", () => {
    const count = loadOneClientFunction("23_client-list-management.js", "watchHistoryTileCount", {
      watchHistoryPassesFilter: loadOneClientFunction("23_client-list-management.js", "watchHistoryPassesFilter", {
        watchHistoryGridType: loadOneClientFunction("23_client-list-management.js", "watchHistoryGridType"),
      }),
    });
    for (const grouped of [false, true]) {
      for (const filter of ["all", "movie", "series"]) {
        const { tiles } = renderGrouped(HISTORY, { grouped, filter });
        assert.equal(count(HISTORY, filter, grouped), tiles.length,
          `helper and renderer disagree (grouped=${grouped}, filter=${filter})`);
      }
    }
  });
});

// --- Adversarial audit 2026-09-06 ------------------------------------------
//
// One describe block per finding, each named for its finding id. Every one of
// these was confirmed to FAIL against the code as it stood before its fix.

describe("A1: an account purge must only ever touch its own lists", () => {
  // validateCreatorUsername allows [a-z0-9_-], and `_` is SQL LIKE's
  // single-character wildcard. The purge built its DELETE pattern by
  // interpolating the username straight into `id LIKE '{u}:%'`, so a username
  // containing `_` matched every other account whose name fit the pattern.
  it("does not delete another creator's rows when the username contains _", async () => {
    const db = makeD1();
    const env = makeEnv({ CONFIGS: makeKv(), DB: db });
    const victim = await createUser(env, "abc-films");
    const other = await createUser(env, "a_c-films");

    for (const u of [victim, other]) {
      const r = await call(env, "/api/creator/lists/save", {
        method: "POST",
        json: {
          creatorName: u.creatorName, creatorKey: u.creatorKey,
          name: "Top Ten", type: "movie", visibility: "public", items: [{ id: "tt0111161" }],
        },
      });
      assert.equal(r.body.ok, true, JSON.stringify(r.body));
    }
    await call(env, "/api/lists/like", {
      method: "POST", ip: "203.0.113.9",
      json: { username: "abc-films", slug: "top-ten" },
    });
    assert.equal(db._lists.size, 2);
    assert.equal(db._lists.get("abc-films:top-ten").likes, 1);

    const del = await call(env, "/api/creator/delete-account", {
      method: "POST",
      json: { creatorName: other.creatorName, creatorKey: other.creatorKey, confirm: "DELETE" },
    });
    assert.equal(del.body.ok, true);

    assert.equal(db._lists.has("a_c-films:top-ten"), false, "the deleted account's own row must go");
    assert.equal(db._lists.has("abc-films:top-ten"), true,
      "a_c-films deleting their own account must not delete abc-films' list");
    assert.equal(db._lists.get("abc-films:top-ten").likes, 1,
      "and must not destroy its like count");
  });

  // The scaled form: usernames are 3-25 characters and `___` is legal, so one
  // all-underscore name per length is a wildcard for every account on the
  // deployment. Registering them is public and self-service.
  it("survives an attacker registering all-underscore usernames and resetting them", async () => {
    const db = makeD1();
    const env = makeEnv({ CONFIGS: makeKv(), DB: db });
    const victims = ["alice", "bobby", "carl", "dee-jay", "eve1", "frankie-films"];
    for (const name of victims) {
      const u = await createUser(env, name);
      await call(env, "/api/creator/lists/save", {
        method: "POST",
        json: {
          creatorName: name, creatorKey: u.creatorKey,
          name: "My List", type: "movie", visibility: "public", items: [{ id: "tt0111161" }],
        },
      });
    }
    assert.equal(db._lists.size, victims.length);

    for (let len = 3; len <= 25; len++) {
      const name = "_".repeat(len);
      const u = await createUser(env, name);
      // account/reset runs the same purge and, unlike delete-account, can be
      // repeated forever on the same account.
      const r = await call(env, "/api/creator/account/reset", {
        method: "POST",
        json: { creatorName: name, creatorKey: u.creatorKey, confirm: "RESET" },
      });
      assert.equal(r.body.ok, true);
    }

    assert.equal(db._lists.size, victims.length,
      "23 self-service resets by a stranger must not empty creator_lists");
    for (const name of victims) {
      assert.equal(db._lists.has(`${name}:my-list`), true, `${name} lost their D1 row`);
    }
  });
});

describe("A5: a key rotation must never report success without rotating", () => {
  const rotationPaths = [
    ["/api/creator/reset-key", (u) => ({ username: u.creatorName, recoveryAnswer: "purple mountains" })],
    ["/admin/api/reset-creator-key", (u) => ({ username: u.creatorName })],
  ];

  for (const [path, body] of rotationPaths) {
    it(`${path}: a failed D1 update must not leave the old key working`, async () => {
      const db = makeD1();
      const env = makeEnv({ CONFIGS: makeKv(), DB: db });
      const alice = await createUser(env, "alicerot5", { recoveryAnswer: "purple mountains" });
      const cookie = await adminCookie(env);
      assert.ok(db._creators.has("alicerot5"));

      // D1 is having a bad minute exactly while the rotation runs.
      db.failWhen((sql) => /UPDATE creators SET key_hash/i.test(sql));
      const rot = await call(env, path, { method: "POST", cookie, json: body(alice) });
      db.failWhen(null);

      assert.equal(rot.body.ok, true, "the row can be dropped, so the rotation can still complete");
      assert.ok(rot.body.creatorKey);

      const oldKey = await call(env, "/api/creator/restore", {
        method: "POST",
        json: { creatorName: "alicerot5", creatorKey: alice.creatorKey },
      });
      assert.equal(oldKey.status, 401, "the rotated-away key must stop working immediately");

      const newKey = await call(env, "/api/creator/restore", {
        method: "POST",
        json: { creatorName: "alicerot5", creatorKey: rot.body.creatorKey },
      });
      assert.equal(newKey.status, 200, "the key the caller was handed must actually work");
    });

    it(`${path}: reports failure rather than half-rotating when D1 is unreachable`, async () => {
      const db = makeD1();
      const env = makeEnv({ CONFIGS: makeKv(), DB: db });
      const alice = await createUser(env, "aliceoff5", { recoveryAnswer: "purple mountains" });
      const cookie = await adminCookie(env);

      // Neither the update nor the compensating delete can land.
      db.failWhen((sql) => /creators/i.test(sql) && !/SELECT/i.test(sql));
      const rot = await call(env, path, { method: "POST", cookie, json: body(alice) });
      db.failWhen(null);

      assert.notEqual(rot.body.ok, true, "must not claim success");
      assert.equal(rot.body.creatorKey, undefined, "must not hand back a key it did not install");

      const oldKey = await call(env, "/api/creator/restore", {
        method: "POST",
        json: { creatorName: "aliceoff5", creatorKey: alice.creatorKey },
      });
      assert.equal(oldKey.status, 200,
        "nothing rotated, so the existing key must keep working rather than locking the owner out");
    });
  }

  it("migrate-d1 repairs a D1 row whose hash has drifted from KV", async () => {
    const db = makeD1();
    const env = makeEnv({ CONFIGS: makeKv(), DB: db });
    const alice = await createUser(env, "alicedrift", { recoveryAnswer: "purple mountains" });
    const cookie = await adminCookie(env);

    // However it got there, D1 now holds a hash KV does not agree with.
    await db.prepare("UPDATE creators SET key_hash = ?, display_name = ? WHERE username = ?")
      .bind("pbkdf2:100000:dead:beef", "Stale Name", "alicedrift").run();
    assert.equal(db._creators.get("alicedrift").key_hash, "pbkdf2:100000:dead:beef");

    let done = false;
    for (let i = 0; i < 20 && !done; i++) {
      done = (await call(env, "/admin/api/migrate-d1", { method: "POST", cookie })).body.done;
    }
    assert.equal(done, true);

    const kvHash = JSON.parse(env.CONFIGS._store.get("creator:alicedrift")).keyHash;
    assert.equal(db._creators.get("alicedrift").key_hash, kvHash,
      "the endpoint whose job is to reconcile KV into D1 must actually reconcile it");
    assert.equal(db._creators.get("alicedrift").display_name, "alicedrift");

    const ok = await call(env, "/api/creator/restore", {
      method: "POST",
      json: { creatorName: "alicedrift", creatorKey: alice.creatorKey },
    });
    assert.equal(ok.status, 200);
  });
});

describe("A3/A4: a purge that failed must not report success", () => {
  const setup = async (name) => {
    const db = makeD1();
    const env = makeEnv({ CONFIGS: makeKv(), DB: db });
    const u = await createUser(env, name);
    const K = { creatorName: name, creatorKey: u.creatorKey };
    await call(env, "/api/creator/lists/save", {
      method: "POST",
      json: { ...K, name: "Holiday Photos", type: "movie", visibility: "public", items: [{ id: "tt0111161" }] },
    });
    await call(env, "/api/creator/lists/save", {
      method: "POST",
      json: { ...K, name: "Private Notes", type: "movie", visibility: "private", items: [{ id: "tt0068646" }] },
    });
    return { db, env, u, K };
  };

  // A3 -- the D1 identity DELETE used to be best-effort, and getCreator
  // reads D1, so a swallowed failure left a "deleted" account authenticating.
  it("delete-account fails loudly when the D1 identity row cannot be removed", async () => {
    const { db, env, u, K } = await setup("delme3");
    db.failWhen((sql) => /DELETE FROM creators/i.test(sql));
    const del = await call(env, "/api/creator/delete-account", {
      method: "POST", json: { ...K, confirm: "DELETE" },
    });
    db.failWhen(null);

    assert.notEqual(del.body.ok, true, "must not claim the account was deleted");
    assert.ok(env.CONFIGS._store.get("creator:delme3"),
      "the identity must survive so the owner can sign in and retry");
    assert.equal(db._creators.has("delme3"), true);

    const restore = await call(env, "/api/creator/restore", {
      method: "POST", json: { creatorName: "delme3", creatorKey: u.creatorKey },
    });
    assert.equal(restore.status, 200, "a delete that failed leaves a working account, not a limbo one");
  });

  // A4 -- the list sweep was wrapped in a catch that logged and fell straight
  // through to deleting the identity, which frees the username.
  it("delete-account does not free the username when the list sweep failed", async () => {
    const { env, u, K } = await setup("delme4");
    env.CONFIGS._hooks.beforeList = async (prefix) => {
      if (String(prefix).startsWith("creatorlist:delme4:")) throw new Error("KV list failed");
    };
    const del = await call(env, "/api/creator/delete-account", {
      method: "POST", json: { ...K, confirm: "DELETE" },
    });
    env.CONFIGS._hooks.beforeList = null;

    assert.notEqual(del.body.ok, true, "must not claim the account was deleted");
    assert.ok(env.CONFIGS._store.get("creatorlist:delme4:holiday-photos"), "the data is still there");
    assert.ok(env.CONFIGS._store.get("creator:delme4"), "so the identity must still be there too");

    const reclaim = await call(env, "/api/creator/create", {
      method: "POST", json: { creatorName: "delme4", displayName: "Somebody Else" },
    });
    assert.notEqual(reclaim.body.ok, true,
      "a stranger must not be able to claim a username whose data was never removed");

    const stillMine = await call(env, "/api/creator/lists", {
      method: "POST", json: { creatorName: "delme4", creatorKey: u.creatorKey },
    });
    assert.equal(stillMine.body.lists.length, 2, "the owner still owns their lists");
  });

  it("account/reset reports failure when it could not empty the account", async () => {
    const { env, K } = await setup("delme4b");
    env.CONFIGS._hooks.beforeList = async (prefix) => {
      if (String(prefix).startsWith("creatorlist:delme4b:")) throw new Error("KV list failed");
    };
    const reset = await call(env, "/api/creator/account/reset", {
      method: "POST", json: { ...K, confirm: "RESET" },
    });
    env.CONFIGS._hooks.beforeList = null;
    assert.notEqual(reset.body.ok, true, "the account is not empty, so this did not succeed");
    assert.ok(env.CONFIGS._store.get("creatorlist:delme4b:holiday-photos"));
    assert.ok(env.CONFIGS._store.get("creator:delme4b"), "reset never removes the identity");
  });

  // The inverse, so the fix cannot be 'always fail': a healthy delete must
  // still hand a reclaiming owner a completely empty account.
  it("a healthy delete still frees the username, and the next owner inherits nothing", async () => {
    const { db, env, K } = await setup("delme4c");
    const del = await call(env, "/api/creator/delete-account", {
      method: "POST", json: { ...K, confirm: "DELETE" },
    });
    assert.equal(del.body.ok, true, JSON.stringify(del.body));
    assert.equal(db._creators.has("delme4c"), false);
    assert.equal(db._lists.size, 0);
    assert.equal([...env.CONFIGS._store.keys()].filter((k) => k.includes("delme4c")).length, 0);

    const fresh = await createUser(env, "delme4c", { displayName: "Somebody Else" });
    const dash = await call(env, "/api/creator/lists", {
      method: "POST", json: { creatorName: "delme4c", creatorKey: fresh.creatorKey },
    });
    assert.deepEqual(dash.body.lists, []);
  });
});

describe("A2/A6: D1 is an accelerator, so it must never overrule the store that is authoritative", () => {
  // The precondition is ordinary: D1 knows the account but not this list yet.
  // migrate-d1 always does `creator:` before `creatorlist:`, so every
  // deployment large enough to need more than one chunk spends time in
  // exactly this state, and a dropped D1 write produces it at any size.
  const seedKvOnlyList = (env, user, likes) => {
    env.CONFIGS._store.set(`creatorlist:${user}:top-ten`, JSON.stringify({
      name: "Top Ten", slug: "top-ten", type: "movie", items: [{ id: "tt0111161" }],
      visibility: "public", likes, createdAt: 1, updatedAt: 2,
    }));
    env.CONFIGS._store.set(`creatorlistorder:${user}`, JSON.stringify({ order: ["top-ten"] }));
    env.CONFIGS._store.set(`listlikevoters:${user}:top-ten`, JSON.stringify(
      Array.from({ length: likes }, (_, i) => `a:voter${i}`)
    ));
  };

  it("an ordinary edit does not zero a like count that only KV knows about", async () => {
    const db = makeD1();
    const env = makeEnv({ CONFIGS: makeKv(), DB: db });
    const u = await createUser(env, "dana2");
    seedKvOnlyList(env, "dana2", 5);
    assert.equal(db._lists.has("dana2:top-ten"), false, "precondition: D1 has no row for this list");

    const dash = async () => {
      const r = await call(env, "/api/creator/lists", {
        method: "POST", json: { creatorName: "dana2", creatorKey: u.creatorKey },
      });
      return r.body.lists.find((l) => l.slug === "top-ten");
    };
    const kvLikes = () => JSON.parse(env.CONFIGS._store.get("creatorlist:dana2:top-ten")).likes;
    assert.equal((await dash()).likes, 5);

    for (let n = 1; n <= 2; n++) {
      const save = await call(env, "/api/creator/lists/save", {
        method: "POST",
        json: {
          creatorName: "dana2", creatorKey: u.creatorKey, slug: "top-ten",
          name: `Top Ten v${n}`, type: "movie", visibility: "public", items: [{ id: "tt0111161" }],
        },
      });
      assert.equal(save.body.ok, true);
      assert.equal(kvLikes(), 5, `edit ${n} destroyed the like count in KV`);
      assert.equal(db._lists.get("dana2:top-ten").likes, 5, `edit ${n} wrote 0 likes into D1`);
      assert.equal((await dash()).likes, 5, `edit ${n} made the dashboard report 0 likes`);
    }

    const dir = await call(env, "/lists/public.json");
    assert.equal(dir.body.lists.find((l) => l.slug === "top-ten").likes, 5);
  });

  it("a like whose D1 write failed does not get written back as zero by the next edit", async () => {
    const db = makeD1();
    const env = makeEnv({ CONFIGS: makeKv(), DB: db });
    const u = await createUser(env, "dana6");
    const K = { creatorName: "dana6", creatorKey: u.creatorKey };
    await call(env, "/api/creator/lists/save", {
      method: "POST",
      json: { ...K, name: "Best Of", type: "movie", visibility: "public", items: [{ id: "tt0111161" }] },
    });

    db.failWhen((sql) => /UPDATE creator_lists SET likes/i.test(sql));
    for (let i = 0; i < 4; i++) {
      await call(env, "/api/lists/like", {
        method: "POST", ip: `203.0.113.${20 + i}`,
        json: { username: "dana6", slug: "best-of" },
      });
    }
    db.failWhen(null);

    await call(env, "/api/creator/lists/save", {
      method: "POST",
      json: { ...K, slug: "best-of", name: "Best Of 2026", type: "movie", visibility: "public", items: [{ id: "tt0111161" }] },
    });
    assert.equal(JSON.parse(env.CONFIGS._store.get("creatorlist:dana6:best-of")).likes, 4,
      "four real likes must survive an edit that followed a failed D1 like-write");

    const dash = await call(env, "/api/creator/lists", { method: "POST", json: K });
    assert.equal(dash.body.lists.find((l) => l.slug === "best-of").likes, 4);
  });

  it("a dropped D1 write does not make the dashboard disagree with what is actually served", async () => {
    const db = makeD1();
    const env = makeEnv({ CONFIGS: makeKv(), DB: db });
    const u = await createUser(env, "dana6b");
    const K = { creatorName: "dana6b", creatorKey: u.creatorKey };
    await call(env, "/api/creator/lists/save", {
      method: "POST",
      json: { ...K, name: "Doc", type: "movie", visibility: "private", items: [{ id: "tt0111161" }] },
    });

    // The owner makes it public; the D1 mirror of that change is lost.
    db.failWhen((sql) => /INSERT INTO creator_lists/i.test(sql));
    const pub = await call(env, "/api/creator/lists/save", {
      method: "POST",
      json: { ...K, slug: "doc", name: "Doc", type: "movie", visibility: "public", items: [{ id: "tt0111161" }] },
    });
    db.failWhen(null);
    assert.equal(pub.body.ok, true);

    const dash = await call(env, "/api/creator/lists", { method: "POST", json: K });
    const shown = dash.body.lists.find((l) => l.slug === "doc").visibility;
    const served = (await call(env, "/lists/dana6b/doc.json")).status === 200;
    assert.equal(shown, "public",
      "the owner's dashboard must not report a list private while the world can read it");
    assert.equal(served, true);
    assert.equal(shown === "public", served, "dashboard and public path must agree");
  });
});

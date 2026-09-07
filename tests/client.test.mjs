// Behavioural tests for the client bundle (09_..24_).
//
// The first tests in this suite that run the browser-side code rather than
// only parsing it. See tests/client-harness.mjs for how and why.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadClient, requestsTo } from "./client-harness.mjs";

const SAVE = "/api/creator/lists/save";
const LISTS = "/api/creator/lists";

// Puts the client in the state a signed-in creator is in after the dashboard
// has loaded: an active profile, a key in localStorage, and one server-hosted
// list in memory with the version the server reported for it.
//
// Through client.set, not by assigning a property: lastCreatorListsData is a
// top-level `let`, so it lives in the bundle's script scope and a plain
// `client.lastCreatorListsData = ...` would set an unrelated global that the
// bundle never reads. (activeCreator is a `var` and would work either way,
// which is exactly what makes the distinction easy to get wrong.)
function signedIn(client, list) {
  client.set("activeCreator", { creatorName: "alice" });
  client.set("lastCreatorListsData", [list]);
  return client;
}

const listWith = (items, updatedAt) => ({
  slug: "faves", name: "Faves", type: "movie", visibility: "private",
  items, ...(updatedAt === undefined ? {} : { updatedAt }),
});

describe("client: a list edit cites the version it was built on", () => {
  it("sends expectedUpdatedAt from what the server reported", async () => {
    const saves = [];
    const client = loadClient({
      storage: { "myListAddon:creatorKey": "KEY-123" },
      routes: {
        [SAVE]: (req) => { saves.push(req.body); return { json: { ok: true, slug: "faves", updatedAt: 2000 } }; },
      },
    });
    signedIn(client, listWith([{ id: "tt1" }, { id: "tt2" }], 1000));

    client.call("removeCustomListItemDirect", "tt1", "faves", null);
    await new Promise((r) => setImmediate(r));

    assert.equal(saves.length, 1, "the removal should have been saved");
    // Before: no client sent this field, so the server-side conflict guard
    // could never fire and two devices editing one list was still
    // last-write-wins in the product, whatever the Worker could do.
    assert.equal(saves[0].expectedUpdatedAt, 1000,
      "the save must cite the version the edit was built on");
    assert.deepEqual(saves[0].items, [{ id: "tt2" }], "and carry the edited list");
  });

  it("advances its baseline from the save, so the next edit is not stale", async () => {
    const saves = [];
    const client = loadClient({
      storage: { "myListAddon:creatorKey": "KEY-123" },
      routes: {
        [SAVE]: (req) => { saves.push(req.body); return { json: { ok: true, slug: "faves", updatedAt: 5000 } }; },
      },
    });
    const list = listWith([{ id: "tt1" }, { id: "tt2" }, { id: "tt3" }], 1000);
    signedIn(client, list);

    client.call("removeCustomListItemDirect", "tt1", "faves", null);
    await new Promise((r) => setImmediate(r));
    client.call("removeCustomListItemDirect", "tt2", "faves", null);
    await new Promise((r) => setImmediate(r));

    assert.equal(saves.length, 2);
    // Without this the second edit cites 1000, which the server has since
    // moved past -- so a browser would 409 against its own previous write.
    assert.equal(saves[1].expectedUpdatedAt, 5000,
      "the second save must cite the version the first one produced");
  });

  it("cites nothing for a legacy list the server gave no version for", async () => {
    const saves = [];
    const client = loadClient({
      storage: { "myListAddon:creatorKey": "KEY-123" },
      routes: { [SAVE]: (req) => { saves.push(req.body); return { json: { ok: true } }; } },
    });
    signedIn(client, listWith([{ id: "tt1" }, { id: "tt2" }]));

    client.call("removeCustomListItemDirect", "tt1", "faves", null);
    await new Promise((r) => setImmediate(r));

    assert.equal(saves.length, 1);
    // A record written before updatedAt existed has no version to cite.
    // Inventing one would either reject every save or assert a version this
    // browser never saw; the server reads absent as "no opinion" and keeps
    // the old behaviour, which is what additive means.
    assert.ok(!("expectedUpdatedAt" in saves[0]),
      "must not invent a baseline the server never issued");
  });
});

describe("client: a conflict re-applies the edit instead of losing one side", () => {
  it("merges the removal into what the other device saved", async () => {
    const saves = [];
    let conflicts = 1;
    const client = loadClient({
      storage: { "myListAddon:creatorKey": "KEY-123" },
      routes: {
        [SAVE]: (req) => {
          saves.push(req.body);
          if (conflicts-- > 0) return { status: 409, json: { ok: false, conflict: true, updatedAt: 9000 } };
          return { json: { ok: true, slug: "faves", updatedAt: 9500 } };
        },
        // What the other device actually saved: it ADDED tt9 while this
        // browser was removing tt1.
        [LISTS]: () => ({ json: { ok: true, lists: [
          { slug: "faves", name: "Faves", type: "movie", visibility: "private",
            items: [{ id: "tt1" }, { id: "tt2" }, { id: "tt9" }], updatedAt: 9000 },
        ] } }),
      },
    });
    const list = listWith([{ id: "tt1" }, { id: "tt2" }], 1000);
    signedIn(client, list);

    client.call("removeCustomListItemDirect", "tt1", "faves", null);
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));

    assert.equal(saves.length, 2, "a conflict should be retried exactly once");
    assert.equal(saves[1].expectedUpdatedAt, 9000, "the retry must cite the fresh version");
    // The point of the whole exercise. Re-sending the array computed from the
    // stale copy would have silently deleted tt9; re-applying the removal to
    // the fresh copy keeps both changes.
    assert.deepEqual(saves[1].items, [{ id: "tt2" }, { id: "tt9" }],
      "the retry must keep the other device's addition and still drop the removed item");
    assert.deepEqual(list.items, [{ id: "tt2" }, { id: "tt9" }],
      "and the in-memory copy must match what was saved");
  });

  it("gives up after one retry rather than looping", async () => {
    const client = loadClient({
      storage: { "myListAddon:creatorKey": "KEY-123" },
      routes: {
        [SAVE]: () => ({ status: 409, json: { ok: false, conflict: true, updatedAt: 9000 } }),
        [LISTS]: () => ({ json: { ok: true, lists: [
          { slug: "faves", name: "Faves", type: "movie", items: [{ id: "tt1" }], updatedAt: 9000 },
        ] } }),
      },
    });
    signedIn(client, listWith([{ id: "tt1" }, { id: "tt2" }], 1000));

    client.call("removeCustomListItemDirect", "tt1", "faves", null);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    assert.equal(requestsTo(client, SAVE).length, 2,
      "a permanently-conflicting list must not be retried forever");
  });

  it("does not drop the edit when the refetch itself fails", async () => {
    const client = loadClient({
      storage: { "myListAddon:creatorKey": "KEY-123" },
      routes: {
        [SAVE]: () => ({ status: 409, json: { ok: false, conflict: true } }),
        [LISTS]: () => { throw new Error("network down"); },
      },
    });
    signedIn(client, listWith([{ id: "tt1" }, { id: "tt2" }], 1000));

    // The assertion is that this does not throw or hang: the edit is still in
    // the local map and the DOM, and the next dashboard load reconciles it.
    client.call("removeCustomListItemDirect", "tt1", "faves", null);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    assert.equal(requestsTo(client, SAVE).length, 1);
  });
});

describe("client: the watchlist removal path uses the same guard", () => {
  it("cites the version and merges on conflict", async () => {
    const saves = [];
    let conflicts = 1;
    const client = loadClient({
      storage: { "myListAddon:creatorKey": "KEY-123" },
      routes: {
        [SAVE]: (req) => {
          saves.push(req.body);
          if (conflicts-- > 0) return { status: 409, json: { ok: false, conflict: true } };
          return { json: { ok: true, slug: "watchlist", updatedAt: 7000 } };
        },
        [LISTS]: () => ({ json: { ok: true, lists: [
          { slug: "watchlist", name: "Watchlist", type: "mixed", visibility: "private",
            items: [{ id: "tt1" }, { id: "tt5" }], updatedAt: 6000 },
        ] } }),
      },
    });
    client.set("activeCreator", { creatorName: "alice" });
    client.set("lastCreatorListsData", [{
      slug: "watchlist", name: "Watchlist", type: "mixed", visibility: "private",
      items: [{ id: "tt1" }, { id: "tt2" }], updatedAt: 1000,
    }]);

    client.call("removeWatchlistItemDirect", "tt1", null);
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));

    assert.equal(saves.length, 2);
    assert.equal(saves[0].expectedUpdatedAt, 1000);
    assert.deepEqual(saves[1].items, [{ id: "tt5" }],
      "the retry keeps the other device's item and still removes tt1");
  });
});

// ---------------------------------------------------------------------------
// Account boundaries. The client-side half of N4: whatever the server does
// about one person's data reaching another, the browser is the other place it
// can happen -- one machine, two accounts, one localStorage.
// ---------------------------------------------------------------------------
const CREATE = "/api/creator/create";
const SECRET = "tt-ALICE-SECRET";

const anonRoutes = (saves) => ({
  [SAVE]: (req) => { saves.push(req.body); return { json: { ok: true, slug: req.body.slug || "s", updatedAt: 1 } }; },
  [CREATE]: () => ({ json: { ok: true, creatorName: "bob", displayName: "Bob", creatorKey: "MYL-BBBB" } }),
  [LISTS]: () => ({ json: { ok: true, lists: [] } }),
  "/api/creator/sync/load": () => ({ json: { ok: true, data: {} } }),
  "/api/creator/sync/save": () => ({ json: { ok: true } }),
  "/api/creator/sync/meta": () => ({ json: { ok: true } }),
  "/api/creator/sync/save-tracking": () => ({ json: { ok: true } }),
});

function fillCreateForm(client, name) {
  const d = client.get("document");
  d.getElementById("createProfileNameInput").value = name;
  d.getElementById("createProfileDisplayInput").value = name;
  d.getElementById("createProfileRecoveryInput").value = "correcthorsebattery";
}

const settle = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

describe("client: one browser, two accounts", () => {
  it("signing out leaves nothing of the previous account behind", async () => {
    const client = loadClient({
      storage: {
        "myListAddon:creatorName": "alice",
        "myListAddon:creatorDisplayName": "Alice",
        "myListAddon:creatorKey": "MYL-AAAA",
        "myListAddon:localCustomLists": JSON.stringify({
          "alices-picks": { name: "Alice's Picks", type: "movie", slug: "alices-picks", items: [{ id: SECRET }] },
        }),
        "myListAddon:state": JSON.stringify({ entries: [{ name: "Alice's row", url: "https://x/" + SECRET }] }),
      },
      routes: anonRoutes([]),
    });
    client.set("activeCreator", { creatorName: "alice", displayName: "Alice" });

    client.call("switchCreatorProfile");

    const remaining = [...client.localStorage._store.entries()]
      .filter(([k, v]) => String(v).includes(SECRET) || /alice/i.test(String(v)) || /alice/i.test(k))
      .map(([k]) => k);
    assert.deepEqual(remaining, [], "the next person on this browser must not find the last one's data");
    assert.equal(client.get("activeCreator"), null);
  });

  it("creating a second account does not carry the first one's lists into it", async () => {
    const saves = [];
    const client = loadClient({
      storage: {
        "myListAddon:creatorName": "alice",
        "myListAddon:creatorKey": "MYL-AAAA",
        "myListAddon:localCustomLists": JSON.stringify({
          "alices-private-picks": {
            name: "Alice's Private Picks", type: "movie", slug: "alices-private-picks",
            items: [{ id: SECRET }],
          },
        }),
      },
      routes: anonRoutes(saves),
    });
    client.set("activeCreator", { creatorName: "alice", displayName: "Alice" });

    fillCreateForm(client, "bob");
    await client.call("submitCreateProfile");
    await settle();

    // Before: migrateLocalCustomListsToAccount ran against alice's local map
    // and put "Alice's Private Picks" into bob's account -- as a PUBLIC list.
    // Every button that opens this modal is inside an `if (!activeCreator)`
    // branch, so a correctly-rendered page does not offer it; that is
    // protection by rendering, and this is the same thing in code.
    const leaked = saves.filter((s) => JSON.stringify(s.items || []).includes(SECRET));
    assert.deepEqual(leaked, [],
      "one account's list must not be uploaded into another account");
  });
});

describe("client: what an anonymous user's first account publishes", () => {
  const anonStorage = () => ({
    "myListAddon:localCustomLists": JSON.stringify({
      "watchlist": { name: "Watchlist", type: "mixed", slug: "watchlist",
        items: [{ id: "tt-PERSONAL-1" }, { id: "tt-PERSONAL-2" }] },
      "watch-history": { name: "Watch History", type: "mixed", slug: "watch-history",
        items: [{ id: "tt-PRIVATE-HISTORY" }] },
      "continue-watching": { name: "Continue Watching", type: "mixed", slug: "continue-watching", items: [] },
      "my-favourites": { name: "My Favourites", type: "movie", slug: "my-favourites",
        items: [{ id: "tt-SHAREABLE" }] },
    }),
  });

  it("migrates the watchlist privately, not publicly", async () => {
    const saves = [];
    const client = loadClient({ storage: anonStorage(), routes: anonRoutes(saves) });
    fillCreateForm(client, "newbie");
    await client.call("submitCreateProfile");
    await settle();

    const watchlist = saves.find((s) => s.name === "Watchlist");
    assert.ok(watchlist, "the watchlist should still migrate to the account");
    // Before: it went up as visibility 'public'. A watchlist is a personal
    // queue, filled by an add button the same way Watch History is -- and
    // every other write of this list in the codebase already defaults it to
    // private. Measured: two films published under a brand-new username
    // without the person being asked.
    assert.equal(watchlist.visibility, "private",
      "a personal watchlist must not be published publicly by signing up");
  });

  it("still publishes a list the person actually built", async () => {
    const saves = [];
    const client = loadClient({ storage: anonStorage(), routes: anonRoutes(saves) });
    fillCreateForm(client, "newbie");
    await client.call("submitCreateProfile");
    await settle();

    // The other half of the fix: this is a sharing feature, and narrowing the
    // watchlist must not quietly turn the migration private for everything.
    const built = saves.find((s) => s.name === "My Favourites");
    assert.ok(built, "a hand-built list should still migrate");
    assert.equal(built.visibility, "public");
  });

  it("never sends the auto-tracked lists through the publish endpoint at all", async () => {
    const saves = [];
    const client = loadClient({ storage: anonStorage(), routes: anonRoutes(saves) });
    fillCreateForm(client, "newbie");
    await client.call("submitCreateProfile");
    await settle();

    const names = saves.map((s) => s.name);
    assert.ok(!names.includes("Watch History"), "watch history must not become a server list here");
    assert.ok(!names.includes("Continue Watching"), "nor continue watching");
  });
});

// --- FE-02: data that arrived from someone else must not become code -------
//
// 37 handler sites build a JavaScript string inside an HTML attribute and
// delimit it with &quot;. escapeAttr is escapeHtml, which EMITS &quot; -- and
// the HTML parser decodes attribute entities before the JS parser runs, so the
// escaping re-formed the delimiter it was meant to neutralise. A channel id
// carrying ");… arrived through a restored backup or a pasted install link and
// executed, with the victim's Creator Key in reach.
//
// Two tests, because there are two layers and each has to hold on its own:
// the escaper (what stops it executing) and the import check (what stops it
// being stored at all).

// Mirrors what a browser does with an attribute value before running it.
function decodeEntities(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

describe("client: an imported id cannot break out of an inline handler", () => {
  const BREAKOUT = '"); window.__pwned = 1; //';

  it("escapes so the handler stays one call with one argument", () => {
    const client = loadClient();
    const attr = 'fn(&quot;' + client.call("escapeJsAttr", BREAKOUT) + '&quot;)';
    const code = decodeEntities(attr);

    // The whole payload has to survive as ONE argument. Before the fix this
    // parsed as fn("") followed by the payload as live statements.
    const seen = [];
    // eslint-disable-next-line no-new-func
    new Function("fn", code)((...args) => seen.push(args));
    assert.deepEqual(seen, [[BREAKOUT]],
      "the id must arrive as a single string argument, not as executed code");
  });

  it("leaves an ordinary id byte-identical", () => {
    const client = loadClient();
    for (const id of ["ch_1700000000_ab12", "tt0944947", "tmdb:1399", "my-list-slug"]) {
      assert.equal(client.call("escapeJsAttr", id), id, id + " must pass through untouched");
    }
  });

  it("survives a name that merely contains quotes, which used to be a syntax error", () => {
    const client = loadClient();
    const name = 'O\'Brien & Sons "Best"';
    const code = decodeEntities('fn(&quot;' + client.call("escapeJsAttr", name) + '&quot;)');
    const seen = [];
    // eslint-disable-next-line no-new-func
    new Function("fn", code)((...args) => seen.push(args));
    assert.deepEqual(seen, [[name]]);
  });

  it("drops such an id at import rather than storing it", () => {
    const client = loadClient();
    const data = {
      version: "3.0",
      entries: [],
      channels: {
        ch_good_1: { channelId: "ch_good_1", name: "Keep Me", type: "series", items: [] },
        [BREAKOUT]: { channelId: BREAKOUT, name: "Drop Me", type: "series", items: [] },
      },
      customLists: { "good-list": { slug: "good-list", name: "Good", type: "movie", items: [] } },
    };
    const dropped = client.call("dropUnsafeImportedIds", data);

    assert.deepEqual(Object.keys(data.channels), ["ch_good_1"],
      "the hostile channel must be gone");
    assert.deepEqual(Object.keys(data.customLists), ["good-list"],
      "and the rest of the file must be untouched -- dropping one entry, not rejecting the import");
    assert.equal(dropped.length, 1, "and the caller must be told, so it can be reported");
  });
});

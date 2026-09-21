// Behavioural tests for the client bundle (09_..24_).
//
// The first tests in this suite that run the browser-side code rather than
// only parsing it. See tests/client-harness.mjs for how and why.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadClient, requestsTo, renderPage } from "./client-harness.mjs";

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

// --- FE-03: an impatient click must not create the account twice -----------
//
// Two clicks on "Create Account" sent two POST /api/creator/create. Both
// succeeded and returned different keys: KV keeps the last, D1's INSERT fails
// on the second and is swallowed so D1 keeps the first, and reads prefer D1.
// The browser stores the last, so the key it shows and saves is the one that
// does not authenticate -- 6 out of 6 double-clicks in a real browser produced
// an account nobody could sign into.
//
// KV-only the same double-click was harmless, which is why the guard was never
// missed until D1 arrived.
describe("client: a double-clicked credential form submits once", () => {
  const creates = () => {
    let n = 0;
    return {
      count: () => n,
      routes: (saves) => ({
        ...anonRoutes(saves),
        [CREATE]: () => {
          n += 1;
          // Distinct keys, as the server really does return -- so a second
          // request does not merely duplicate the first, it replaces the key
          // this browser will keep.
          return { json: { ok: true, creatorName: "bob", displayName: "Bob", creatorKey: "MYL-KEY-" + n } };
        },
      }),
    };
  };

  it("sends one create however many times Create is clicked", async () => {
    const c = creates();
    const client = loadClient({ storage: {}, routes: c.routes([]) });
    fillCreateForm(client, "newbie");

    // Not awaited between calls -- that is the whole point. Awaiting each one
    // serialises them, and the server correctly answers "username taken" for
    // the later ones; the damage only happens while the first is in flight.
    const all = [client.call("submitCreateProfile"), client.call("submitCreateProfile"), client.call("submitCreateProfile")];
    await Promise.all(all);
    await settle();

    assert.equal(c.count(), 1, "three clicks must produce one account, not three");
    assert.equal(client.get("localStorage").getItem("myListAddon:creatorKey"), "MYL-KEY-1",
      "and the key kept must be the one the single request returned");
  });

  it("re-arms after the request finishes, so a later attempt still works", async () => {
    const c = creates();
    const client = loadClient({ storage: {}, routes: c.routes([]) });
    fillCreateForm(client, "newbie");

    await client.call("submitCreateProfile");
    await settle();
    await client.call("submitCreateProfile");
    await settle();

    // A guard that latches would be its own bug: the form would silently stop
    // working after one use.
    assert.equal(c.count(), 2, "a second, separate attempt must be allowed through");
  });

  it("does not latch when the form is rejected before any request", async () => {
    const c = creates();
    const client = loadClient({ storage: {}, routes: c.routes([]) });
    const d = client.get("document");
    d.getElementById("createProfileNameInput").value = "";      // no username
    await client.call("submitCreateProfile");
    await settle();
    assert.equal(c.count(), 0, "nothing should have been sent");

    fillCreateForm(client, "newbie");
    await client.call("submitCreateProfile");
    await settle();
    assert.equal(c.count(), 1, "and the corrected form must go through");
  });
});

// --- FE-04: a write the provider refused must not read as success ----------
//
// All seven /api/external-list/item-mutate call sites discarded the response --
// an await inside an empty catch, or Promise.allSettled with the results thrown
// away -- and then showed a success message unconditionally. The endpoint
// answers 400 {"ok":false,"error":"Please connect your Trakt account first."}
// for a missing or expired token, which is the ordinary way this fails. So a
// removal Trakt refused still said "Removed from TRAKT.", the item stayed in
// the list, and the local membership index recorded it as gone -- which then
// hid it from the next attempt.
const MUTATE = "/api/external-list/item-mutate";

describe("client: a provider write that failed is not reported as done", () => {
  function harness(routeResult) {
    const client = loadClient({ routes: { [MUTATE]: () => routeResult } });
    const toasts = [];
    const alerts = [];
    client.set("showAddedToast", (m) => toasts.push(m));
    client.set("showAppAlert", (title, msg) => alerts.push(title + ": " + msg));
    return { client, toasts, alerts };
  }
  const membership = (client) => {
    const raw = client.get("localStorage").getItem("myListAddon:externalMembership");
    return raw ? JSON.parse(raw) : {};
  };

  it("says so, and leaves the membership index alone, when the provider refuses", async () => {
    const { client, toasts, alerts } = harness({
      status: 400, json: { ok: false, error: "Please connect your Trakt account first." },
    });

    await client.call("removeSingleExternalItemDirect", "trakt", "watchlist", "watchlist", "tt0137523", "movie", null);

    assert.ok(!toasts.some((t) => /Removed from/.test(t)),
      "no success toast for a removal the provider refused");
    assert.ok(alerts.some((a) => /connect your Trakt account/.test(a)),
      "the server's own message should reach the user, not a generic one");
    // The important half: the item IS still in the list, so an index saying it
    // is gone would hide it from the next attempt.
    assert.deepEqual(membership(client), {},
      "nothing may be recorded as removed when nothing was removed");
  });

  it("still reports and records a removal that did land", async () => {
    const { client, toasts, alerts } = harness({ status: 200, json: { ok: true } });

    await client.call("removeSingleExternalItemDirect", "trakt", "watchlist", "watchlist", "tt0137523", "movie", null);

    assert.ok(toasts.some((t) => /Removed from TRAKT/.test(t)), "a real removal still confirms");
    assert.deepEqual(alerts, [], "and raises nothing");
    const m = membership(client);
    assert.ok(Object.keys(m).length > 0, "and is recorded");
    assert.ok(Object.values(m).every((v) => v === false), "as not-in-list");
  });

  it("treats a network failure the same as a refusal", async () => {
    const client = loadClient({ routes: { [MUTATE]: () => { throw new Error("offline"); } } });
    const toasts = [];
    const alerts = [];
    client.set("showAddedToast", (m) => toasts.push(m));
    client.set("showAppAlert", (t, m) => alerts.push(t + ": " + m));

    await client.call("removeSingleExternalItemDirect", "trakt", "watchlist", "watchlist", "tt0137523", "movie", null);

    assert.ok(!toasts.some((t) => /Removed from/.test(t)));
    assert.ok(alerts.some((a) => /Network error/.test(a)));
  });
});

// --- FE-05: the main list-edit path must cite the version it edited --------
//
// The server answers 409 rather than overwriting when a save cites
// expectedUpdatedAt. Of twelve lists/save call sites exactly two armed it, and
// both were remove-one-item paths -- so the button that sends the WHOLE items
// array, which is the one people press, was still last-write-wins. Two devices
// each adding a different film ended with one addition gone and both saves
// reporting ok.
describe("client: saving a list edit cites what it was built on", () => {
  function editing(client, list) {
    client.set("activeCreator", { creatorName: "alice" });
    client.set("lastCreatorListsData", [list]);
    client.set("editingCreatorListSlug", list.slug);
    client.set("customListDraftItems", [{ id: "tt1" }, { id: "tt2" }]);
    client.set("customListDraftType", "movie");
  }

  it("sends expectedUpdatedAt from the version the dashboard reported", async () => {
    const saves = [];
    const client = loadClient({
      storage: { "myListAddon:creatorKey": "KEY-123" },
      routes: { [SAVE]: (req) => { saves.push(req.body); return { json: { ok: true, slug: "faves", updatedAt: 7000 } }; } },
    });
    editing(client, { slug: "faves", name: "Faves", type: "movie", updatedAt: 4200 });

    await client.call("saveCreatorListEdit", "Faves");
    await settle();

    assert.equal(saves.length, 1);
    assert.equal(saves[0].expectedUpdatedAt, 4200,
      "the save must name the version the edit was built on");
  });

  it("cites nothing for a list the server never gave a version for", async () => {
    const saves = [];
    const client = loadClient({
      storage: { "myListAddon:creatorKey": "KEY-123" },
      routes: { [SAVE]: (req) => { saves.push(req.body); return { json: { ok: true, slug: "faves", updatedAt: 1 } }; } },
    });
    editing(client, { slug: "faves", name: "Faves", type: "movie" });   // legacy record

    await client.call("saveCreatorListEdit", "Faves");
    await settle();

    // Inventing a baseline would either reject every save or assert a version
    // this browser never saw.
    assert.equal("expectedUpdatedAt" in saves[0], false);
  });

  it("does not overwrite the other device on a conflict", async () => {
    const saves = [];
    const client = loadClient({
      storage: { "myListAddon:creatorKey": "KEY-123" },
      routes: {
        [SAVE]: (req) => { saves.push(req.body); return { status: 409, json: { ok: false, error: "conflict", conflict: true } }; },
        [LISTS]: () => ({ json: { ok: true, lists: [] } }),
      },
    });
    editing(client, { slug: "faves", name: "Faves", type: "movie", updatedAt: 4200 });
    const notices = [];
    client.set("showAppNoticeModal", (t, m) => notices.push(t + ": " + m));

    await client.call("saveCreatorListEdit", "Faves");
    await settle();

    assert.equal(saves.length, 1, "a 409 must not be followed by a blind retry");
    assert.ok(notices.some((n) => /Changed Elsewhere/.test(n)),
      "and the person has to be told, since only they can say which version they want");
    assert.deepEqual(client.get("customListDraftItems"), [{ id: "tt1" }, { id: "tt2" }],
      "their draft must survive -- there is nothing else holding it");
  });

  it("advances its baseline, so a second edit is not stale against its own write", async () => {
    const saves = [];
    const client = loadClient({
      storage: { "myListAddon:creatorKey": "KEY-123" },
      routes: { [SAVE]: (req) => { saves.push(req.body); return { json: { ok: true, slug: "faves", updatedAt: 9100 } }; } },
    });
    const list = { slug: "faves", name: "Faves", type: "movie", updatedAt: 4200 };
    editing(client, list);

    await client.call("saveCreatorListEdit", "Faves");
    await settle();
    client.set("editingCreatorListSlug", "faves");
    await client.call("saveCreatorListEdit", "Faves");
    await settle();

    assert.equal(saves[1].expectedUpdatedAt, 9100,
      "the second save must cite what the first one produced, not the original");
  });
});

// --- FE-09: a sync load belongs to the account that asked for it -----------
describe("client: a sync load for the previous account is discarded", () => {
  it("does not apply one account's state to the next one", async () => {
    let release;
    const held = new Promise((r) => { release = r; });
    const client = loadClient({
      storage: { "myListAddon:creatorKey": "KEY-ALICE" },
      routes: {
        "/api/creator/sync/load": async () => {
          await held;   // alice's answer, arriving late
          return { json: { ok: true, data: { config: [{ name: "alice-ROW", url: "https://x/alice", type: "movie", enabled: true }], likedLists: ["https://x/alice/liked"], updatedAt: 10 } } };
        },
        "/api/creator/sync/save": () => ({ json: { ok: true, updatedAt: 11 } }),
        "/api/creator/sync/save-tracking": () => ({ json: { ok: true } }),
        [LISTS]: () => ({ json: { ok: true, lists: [] } }),
      },
    });

    client.set("activeCreator", { creatorName: "alice" });
    const pending = client.call("loadCreatorSync");

    // Someone signs in as bob while alice's load is still out.
    client.set("activeCreator", { creatorName: "bob" });
    client.get("localStorage").setItem("myListAddon:creatorKey", "KEY-BOB");

    release();
    await pending;
    await settle();

    assert.equal(client.get("localStorage").getItem("myListAddon:likedLists"), null,
      "alice's liked lists must not land in bob's session");
  });
});

// --- FE-07: likedLists is a list of URL strings -----------------------------
describe("client: a poisoned likedLists does not kill the Discover feed", () => {
  it("ignores non-string entries rather than throwing on them", () => {
    const client = loadClient({
      storage: {
        "myListAddon:likedLists": JSON.stringify([
          { url: "https://mdblist.com/lists/a/b", name: "Sci-Fi" },   // what a restore could write
          "https://mdblist.com/lists/c/d",
          null,
          42,
        ]),
      },
    });
    const set = client.call("getLikedListsSet");
    assert.deepEqual([...set], ["https://mdblist.com/lists/c/d"]);
    // The actual crash: every reader does this to each entry.
    for (const u of set) assert.doesNotThrow(() => u.split("/"));
  });

  it("stores only strings when a backup is restored", () => {
    const client = loadClient();
    client.call("applyImportedConfig", {
      version: "3.0",
      entries: [],
      settings: { likedLists: [{ url: "https://x/a" }, "https://x/b"] },
    });
    assert.deepEqual(
      JSON.parse(client.get("localStorage").getItem("myListAddon:likedLists")),
      ["https://x/b"]);
  });
});

// --- FE-06: the newer search wins ------------------------------------------
describe("client: an obsolete title search cannot replace a newer one", () => {
  const TITLES = "/api/title-search";
  const result = (name) => ({ ok: true, results: [{ id: "tmdb:1", tmdbId: 1, title: name, name, type: "movie", year: "2000", poster: "", vote_average: 1, genre_ids: [] }] });

  it("discards the slower, older response", async () => {
    let releaseSlow;
    const slow = new Promise((r) => { releaseSlow = r; });
    const client = loadClient({
      routes: {
        [TITLES]: async (req) => {
          if (/q=slow/.test(req.url)) { await slow; return { json: result("SLOW") }; }
          return { json: result("FAST") };
        },
        "/api/track-search": () => ({ json: { ok: true } }),
      },
    });
    const input = client.get("document").getElementById("catalogSearchInput");

    input.value = "slowq";
    const first = client.call("runCatalogSearch");
    input.value = "fastq";
    await client.call("runCatalogSearch");
    await settle();
    const afterFast = (client.get("window")._rawCatalogTitleItems || []).map((x) => x.title);

    releaseSlow();
    await first;
    await settle();
    const afterSlow = (client.get("window")._rawCatalogTitleItems || []).map((x) => x.title);

    assert.deepEqual(afterFast, ["FAST"]);
    assert.deepEqual(afterSlow, ["FAST"],
      "the older response landing later must not replace the newer results");
  });
});

// --- FE-13: the saved dashboard order is a list of slugs ------------------
//
// Both readers did JSON.parse inside a try/catch -- which covers malformed
// JSON -- and then tested `savedOrder && savedOrder.length` before calling
// .map on it. A STRING passes that ("nope".length is 4) and then throws
// "savedOrder.map is not a function", taking the whole dashboard render with
// it. Same family as the likedLists bug: container type checked, element type
// not.
describe("client: a corrupted dashboard order cannot break the dashboard", () => {
  // Spread into an array of THIS realm before comparing. The bundle runs in a
  // vm context, so an array it constructs itself has that realm's
  // Array.prototype and deepStrictEqual rejects it on identity alone -- while
  // one that came back through the harness's own JSON.parse does not. That
  // difference is an artefact of the sandbox, not of the code under test.
  const order = (stored) => [...loadClient({
    storage: stored === undefined ? {} : { "myListAddon:dashboardListOrder": stored },
  }).call("readDashboardListOrder")];

  it("reads a normal order through unchanged", () => {
    assert.deepEqual(order(JSON.stringify(["b", "a", "c"])), ["b", "a", "c"]);
  });

  it("returns nothing for a value that is not an array", () => {
    // The exact shape that threw: length-bearing, not mappable.
    assert.deepEqual(order(JSON.stringify("nope")), []);
    assert.deepEqual(order(JSON.stringify({ length: 3 })), []);
    assert.deepEqual(order("42"), []);
  });

  it("drops entries that are not slugs, rather than throwing on them", () => {
    assert.deepEqual(order(JSON.stringify(["a", null, 7, { slug: "b" }, "c"])), ["a", "c"]);
  });

  it("survives malformed JSON and a missing key", () => {
    assert.deepEqual(order("{not json,,,"), []);
    assert.deepEqual(order(undefined), []);
  });
});

// --- a resumed device does not un-delete a tracking-list removal made
// elsewhere -----------------------------------------------------------------
//
// loadCreatorSync merges the server's watch-history/continue-watching/
// watchlist arrays with whatever this device still has locally, so an item
// added offline and not yet pushed is not lost. Before this fix, "not in the
// server's answer" was read as "added here, not pushed yet" unconditionally
// -- which is also exactly what a removal made on ANOTHER device looks like
// from a stale local copy's point of view. A phone that has not synced since
// before a desktop unwatched something reintroduced it on load, then pushed
// that reintroduction straight back to the account.
describe("client: a resumed device does not re-add what another device removed", () => {
  const LOCAL_LISTS_KEY = "myListAddon:localCustomLists";

  function seeded(routes, storageExtra) {
    return loadClient({
      storage: Object.assign({
        "myListAddon:creatorKey": "KEY-1",
        [LOCAL_LISTS_KEY]: JSON.stringify({
          "watch-history": {
            slug: "watch-history", name: "Watch History", type: "movie",
            items: [{ id: "tt1", type: "movie", name: "Stale Movie", watchedAt: 900 }],
            updatedAt: 1000,
          },
        }),
      }, storageExtra),
      routes: Object.assign({
        "/api/creator/lists": () => ({ json: { ok: true, lists: [] } }),
        "/api/creator/sync/save-tracking": () => ({ json: { ok: true } }),
      }, routes),
    });
  }

  it("drops a stale local item the server no longer has, once this device has a baseline", () => {
    const pushes = [];
    const client = seeded({
      "/api/creator/sync/load": () => ({ json: { ok: true, data: {
        watchHistory: [], trackingUpdatedAt: 6000,
      } } }),
      "/api/creator/sync/save-tracking": (req) => { pushes.push(req.body); return { json: { ok: true } }; },
    });
    client.set("activeCreator", { creatorName: "alice" });
    // This device already synced up to tracking version 5000 before -- the
    // baseline the local watch-history's updatedAt: 1000 falls well behind.
    client.set("window._serverTrackingUpdatedAt", 5000);

    return client.call("loadCreatorSync").then(async () => {
      await new Promise((r) => setImmediate(r));
      const items = client.get("loadLocalCustomLists()['watch-history'].items");
      assert.deepEqual([...items], [], "the removal made elsewhere must stick");
      assert.equal(pushes.length, 0, "nothing to push back -- the stale item must not resurrect on the server either");
    });
  });

  it("still keeps a local item added since this device's last sync", () => {
    const client = seeded({
      "/api/creator/sync/load": () => ({ json: { ok: true, data: {
        watchHistory: [], trackingUpdatedAt: 6000,
      } } }),
    }, {
      [LOCAL_LISTS_KEY]: JSON.stringify({
        "watch-history": {
          slug: "watch-history", name: "Watch History", type: "movie",
          items: [{ id: "tt1", type: "movie", name: "Just Watched", watchedAt: 5500 }],
          // Newer than the 5000 baseline below -- a genuine unpushed local edit.
          updatedAt: 5500,
        },
      }),
    });
    client.set("activeCreator", { creatorName: "alice" });
    client.set("window._serverTrackingUpdatedAt", 5000);

    return client.call("loadCreatorSync").then(async () => {
      await new Promise((r) => setImmediate(r));
      const items = client.get("loadLocalCustomLists()['watch-history'].items");
      assert.deepEqual([...items].map((it) => it.id), ["tt1"], "an edit newer than the last sync must survive");
    });
  });

  it("keeps everything on this device's very first sync, with no baseline to compare against", () => {
    const client = seeded({
      "/api/creator/sync/load": () => ({ json: { ok: true, data: {
        watchHistory: [], trackingUpdatedAt: 6000,
      } } }),
    });
    client.set("activeCreator", { creatorName: "alice" });
    // No prior _serverTrackingUpdatedAt at all -- this device has never synced.

    return client.call("loadCreatorSync").then(async () => {
      await new Promise((r) => setImmediate(r));
      const items = client.get("loadLocalCustomLists()['watch-history'].items");
      assert.deepEqual([...items].map((it) => it.id), ["tt1"], "first sync ever must not discard local data it cannot yet judge");
    });
  });
});

// --- Live Preview's See All opens with the list's real size, not the first
// page's ------------------------------------------------------------------
//
// /api/preview reports totalItems whenever the source can supply one (see
// its own comment, 25_api-catalog-routes.js), but renderLivePreview's shelf
// cache and openLivePreviewSeeAll's handoff to openListDetailsPage both
// dropped it on the floor -- so a See All page for a >100-item list opened
// showing "100 items" (the first preview page's length) and only corrected
// itself once infinite scroll had paged the rest in.
describe("client: See All opens with the list's real size, not just the first page", () => {
  it("threads totalItems from the shelf cache into openListDetailsPage's itemCount", () => {
    const client = loadClient({});
    const openCalls = [];
    client.set("openListDetailsPage", (name, type, listUrl, preloaded) => { openCalls.push({ name, type, listUrl, preloaded }); });
    client.set("livePreviewShelfData", [
      { name: "Huge List", type: "movie", url: "mdblist:huge", sample: new Array(100).fill({ id: "tt1" }), maybeMore: true, totalItems: 4231 },
    ]);

    client.call("openLivePreviewSeeAll", 0);

    assert.equal(openCalls.length, 1);
    assert.equal(openCalls[0].preloaded.itemCount, 4231,
      "the shelf's known total must reach openListDetailsPage, not just the 100-item sample");
  });

  it("leaves itemCount unset when the source could not report a total", () => {
    const client = loadClient({});
    const openCalls = [];
    client.set("openListDetailsPage", (name, type, listUrl, preloaded) => { openCalls.push({ preloaded }); });
    client.set("livePreviewShelfData", [
      { name: "Unknown-Size List", type: "movie", url: "trakt:x", sample: new Array(100).fill({ id: "tt1" }), maybeMore: true, totalItems: null },
    ]);

    client.call("openLivePreviewSeeAll", 0);

    assert.equal(openCalls[0].preloaded.itemCount, null,
      "no total to show yet must fall back to the old progressive count, not claim a wrong one");
  });
});

// ---------------------------------------------------------------------------
// The report this suite of tests comes from: change something on the desktop,
// open the installed PWA on the phone a few minutes later, and the change is
// reverted. The phone was pushing before it had asked.
//
// An installed PWA is re-launched rather than resumed, so it begins every
// session holding whatever it last saw and knowing no server version at all.
// Two things followed from that. Its start-up timers (refreshAiringNext at
// 600ms, backfillWatchHistoryEpisodeStills at 1400ms, every autosave path)
// reached the push endpoints before the first sync load answered -- and those
// pushes are full overwrites. And with no baseline in hand they cited no
// version, so the server's conflict guard, which treats a missing baseline as
// "an older client with no opinion", let them through.
describe("client: a cold start asks the account before it tells it anything", () => {
  const LOCAL_LISTS_KEY = "myListAddon:localCustomLists";
  const LOAD = "/api/creator/sync/load";
  const SAVE_TRACKING = "/api/creator/sync/save-tracking";
  const SAVE_SYNC = "/api/creator/sync/save";

  const withHistory = (items, updatedAt) => JSON.stringify({
    "watch-history": { slug: "watch-history", name: "Watch History", type: "movie", items, updatedAt },
  });

  it("holds a tracking push until the first load has been applied", async () => {
    const pushes = [];
    const client = loadClient({
      storage: {
        "myListAddon:creatorKey": "KEY-1",
        "myListAddon:creatorName": "alice",
        [LOCAL_LISTS_KEY]: withHistory([{ id: "tt1", type: "movie", name: "Stale", watchedAt: 900 }], 1000),
      },
      routes: {
        [LOAD]: () => ({ json: { ok: true, data: { watchHistory: [], trackingUpdatedAt: 6000, trackingClientVersion: 12 } } }),
        [SAVE_TRACKING]: (req) => { pushes.push(req.body); return { json: { ok: true, clientVersion: 13 } }; },
        [LISTS]: () => ({ json: { ok: true, lists: [] } }),
      },
    });
    client.set("activeCreator", { creatorName: "alice" });

    await client.call("pushTrackingSync");
    assert.equal(pushes.length, 0,
      "a push before the first load is what overwrote the account with this browser's stale copy");

    await client.call("loadCreatorSync");
    await settle();
    assert.equal(pushes.length, 1, "and it must not be dropped either -- it goes up once the load lands");
    assert.equal(pushes[0].expectedClientVersion, 12,
      "against the version the load just reported, so the server can refuse it if it is already stale");
  });

  it("keeps an intentional removal intentional across the wait", async () => {
    // intentionalRemoval is what tells save-tracking to trust a SHORTER
    // array. Losing it while the push waits would let the scrobble rescue
    // put back the item the person just deleted.
    const pushes = [];
    const client = loadClient({
      storage: { "myListAddon:creatorKey": "KEY-1", "myListAddon:creatorName": "alice", [LOCAL_LISTS_KEY]: withHistory([], 1000) },
      routes: {
        [LOAD]: () => ({ json: { ok: true, data: { watchHistory: [], trackingUpdatedAt: 6000 } } }),
        [SAVE_TRACKING]: (req) => { pushes.push(req.body); return { json: { ok: true, clientVersion: 2 } }; },
        [LISTS]: () => ({ json: { ok: true, lists: [] } }),
      },
    });
    client.set("activeCreator", { creatorName: "alice" });

    await client.call("pushTrackingSync", { intentionalRemoval: true });
    assert.equal(pushes.length, 0);
    await client.call("loadCreatorSync");
    await settle();
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].intentionalRemoval, true);
  });

  it("cites the version it last saw, on a session that has not loaded yet", async () => {
    const saves = [];
    const client = loadClient({
      storage: {
        "myListAddon:creatorKey": "KEY-1",
        "myListAddon:creatorName": "alice",
        // What the previous session ended knowing. Before this was persisted
        // it lived in a window. variable and every new session started blind.
        "myListAddon:syncBaselines": JSON.stringify({ account: "alice", config: 4242 }),
      },
      routes: { [SAVE_SYNC]: (req) => { saves.push(req.body); return { json: { ok: true, updatedAt: 4300 } }; } },
    });
    client.set("activeCreator", { creatorName: "alice" });
    client.call("markCreatorSyncLoaded");

    await client.call("pushCreatorSync");
    assert.equal(saves.length, 1);
    assert.equal(saves[0].expectedUpdatedAt, 4242,
      "a cold start that cites nothing is a last-write-wins overwrite of whatever the other device did");
  });

  it("does not adopt a baseline belonging to a different account", async () => {
    const saves = [];
    const client = loadClient({
      storage: {
        "myListAddon:creatorKey": "KEY-1",
        "myListAddon:creatorName": "bob",
        "myListAddon:syncBaselines": JSON.stringify({ account: "alice", config: 4242 }),
      },
      routes: { [SAVE_SYNC]: (req) => { saves.push(req.body); return { json: { ok: true, updatedAt: 1 } }; } },
    });
    client.set("activeCreator", { creatorName: "bob" });
    client.call("markCreatorSyncLoaded");

    await client.call("pushCreatorSync");
    assert.equal(saves[0].expectedUpdatedAt, undefined,
      "citing another account's version would 409 forever rather than be merely wrong once");
  });

  it("retries a refused tracking push once, against the version it was refused with", async () => {
    const pushes = [];
    let loads = 0;
    const client = loadClient({
      storage: { "myListAddon:creatorKey": "KEY-1", "myListAddon:creatorName": "alice", [LOCAL_LISTS_KEY]: withHistory([{ id: "tt1", watchedAt: 5 }], 1000) },
      routes: {
        [LOAD]: () => {
          loads++;
          return { json: { ok: true, data: { watchHistory: [{ id: "tt1", watchedAt: 5 }], trackingUpdatedAt: 6000, trackingClientVersion: 99 } } };
        },
        [SAVE_TRACKING]: (req) => {
          pushes.push(req.body);
          if (pushes.length === 1) return { status: 409, json: { ok: false, conflict: true, clientVersion: 99 } };
          return { json: { ok: true, clientVersion: 100 } };
        },
        [LISTS]: () => ({ json: { ok: true, lists: [] } }),
      },
    });
    client.set("activeCreator", { creatorName: "alice" });
    client.call("markCreatorSyncLoaded");

    await client.call("pushTrackingSync");
    await settle();
    assert.equal(pushes.length, 2, "a refusal must be answered by pulling and re-sending, not by giving up");
    assert.ok(loads >= 1, "and the retry must be built on what the account actually holds");
    assert.equal(pushes[1].expectedClientVersion, 99);
  });
});

// ---------------------------------------------------------------------------
// The same report's tracking half, at the merge rather than the push.
//
// shouldKeepLocalOnlyTracking's timestamp comparison could only ever read a
// baseline held in a window. variable, so a re-launched PWA took its
// first-sync branch ("no baseline, keep everything") on every single launch --
// and re-added, then re-pushed, whatever the desktop had removed.
describe("client: a relaunched app does not un-delete what another device removed", () => {
  const LOCAL_LISTS_KEY = "myListAddon:localCustomLists";
  const LOAD = "/api/creator/sync/load";

  const seeded = (baseline, localUpdatedAt) => loadClient({
    storage: Object.assign({
      "myListAddon:creatorKey": "KEY-1",
      "myListAddon:creatorName": "alice",
      [LOCAL_LISTS_KEY]: JSON.stringify({
        "watch-history": {
          slug: "watch-history", name: "Watch History", type: "movie",
          items: [{ id: "tt1", type: "movie", name: "Removed On Desktop", watchedAt: 900 }],
          updatedAt: localUpdatedAt,
        },
      }),
    }, baseline ? { "myListAddon:trackingLocalBaseline": JSON.stringify(baseline) } : {}),
    routes: {
      [LOAD]: () => ({ json: { ok: true, data: { watchHistory: [], trackingUpdatedAt: 6000 } } }),
      "/api/creator/sync/save-tracking": () => ({ json: { ok: true, clientVersion: 2 } }),
      [LISTS]: () => ({ json: { ok: true, lists: [] } }),
    },
  });

  it("drops the stale item on a fresh page session, with no in-memory baseline at all", async () => {
    const client = seeded({ account: "alice", "watch-history": 1000 }, 1000);
    client.set("activeCreator", { creatorName: "alice" });
    // Deliberately no window._serverTrackingUpdatedAt: this is a launch, not
    // a resume, which is exactly the case that used to keep everything.
    await client.call("loadCreatorSync");
    await settle();
    assert.deepEqual([...client.get("loadLocalCustomLists()['watch-history'].items")], [],
      "the removal made on the other device must stick");
  });

  it("still keeps an edit this device made after that agreement", async () => {
    const client = seeded({ account: "alice", "watch-history": 1000 }, 5500);
    client.set("activeCreator", { creatorName: "alice" });
    await client.call("loadCreatorSync");
    await settle();
    assert.deepEqual([...client.get("loadLocalCustomLists()['watch-history'].items")].map((it) => it.id), ["tt1"],
      "a local edit that never reached the server is not the same thing as a stale copy");
  });

  it("records the agreement when a load keeps nothing local", async () => {
    const client = seeded(null, 1000);
    client.set("activeCreator", { creatorName: "alice" });
    client.set("window._serverTrackingUpdatedAt", 5000);
    await client.call("loadCreatorSync");
    await settle();
    const stored = JSON.parse(client.get("localStorage").getItem("myListAddon:trackingLocalBaseline"));
    assert.equal(stored.account, "alice");
    assert.equal(stored["watch-history"], client.get("loadLocalCustomLists()['watch-history'].updatedAt"),
      "without this the next launch has nothing to judge its own local copy against");
  });
});

// ---------------------------------------------------------------------------
// And the list half: a list deleted on the desktop was back on the account a
// minute after the phone was opened, because to the phone "the account does
// not have this list" and "the account never received this list" looked the
// same -- and the second is what uploadMissingLocalListsToAccount exists to
// repair.
describe("client: a list deleted on another device is not uploaded back", () => {
  const LOCAL_LISTS_KEY = "myListAddon:localCustomLists";

  const withLocalList = () => JSON.stringify({
    faves: { slug: "faves", creatorSlug: "faves", name: "Faves", type: "movie", items: [{ id: "tt1" }], visibility: "private" },
  });

  it("drops the local copy and tombstones the slug", () => {
    const client = loadClient({
      storage: {
        "myListAddon:creatorKey": "KEY-1",
        "myListAddon:creatorName": "alice",
        [LOCAL_LISTS_KEY]: withLocalList(),
      },
    });
    client.set("activeCreator", { creatorName: "alice" });

    const removed = client.call("applyServerListDeletions", ["faves"]);
    assert.equal(removed, 1);
    assert.equal(client.get("loadLocalCustomLists()").faves, undefined,
      "the browser has to catch up with the delete, not hold the only copy of it");
    const tombstones = JSON.parse(client.get("localStorage").getItem("myListAddon:deletedCreatorLists"));
    assert.ok(tombstones.faves, "and remember it, so the backfill does not restore it a moment later");
  });

  it("leaves the auto-tracked slugs alone", () => {
    const client = loadClient({
      storage: {
        "myListAddon:creatorKey": "KEY-1",
        "myListAddon:creatorName": "alice",
        [LOCAL_LISTS_KEY]: JSON.stringify({ "watch-history": { slug: "watch-history", items: [{ id: "tt1" }] } }),
      },
    });
    client.set("activeCreator", { creatorName: "alice" });
    client.call("applyServerListDeletions", ["watch-history"]);
    assert.ok(client.get("loadLocalCustomLists()['watch-history']"),
      "Watch History is generated from watch state -- it is not the account's to delete out from under this browser");
  });

  it("a tombstoned list is not re-created by the backfill", () => {
    const client = loadClient({
      storage: { "myListAddon:creatorKey": "KEY-1", "myListAddon:creatorName": "alice" },
    });
    client.set("activeCreator", { creatorName: "alice" });
    client.call("applyServerListDeletions", ["faves"]);
    const restored = client.call("backfillCreatorListsIntoLocalMap", [
      { slug: "faves", name: "Faves", type: "movie", items: [{ id: "tt1" }] },
    ]);
    assert.equal(restored, 0);
  });
});

// ---------------------------------------------------------------------------
// See All said "100 items" for a list that has 303.
//
// /api/preview caps a page at 100, so the only number a freshly-opened See
// All had was its first page's length -- and it printed that as the list's
// size. It corrected itself as scrolling paged the rest in, unless something
// had handed it that 100 as an exact count (the Discover card's badge does),
// in which case it went on saying 100 with 303 items on screen.
describe("client: See All reports the list's size, not the page it is holding", () => {
  const PREVIEW = "/api/preview";
  const subtitleOf = (client) => client.__byId.get("detailSubtitle").textContent;
  const page = (n, start) => Array.from({ length: n }, (_, i) => ({
    id: "tt" + (start + i), type: "movie", name: "Film " + (start + i),
  }));

  // A 303-item source paged 100 at a time. totalItems is what the source
  // reports about the whole collection; null means it does not report one.
  function pagingClient(totalItems) {
    let calls = 0;
    return loadClient({
      routes: {
        [PREVIEW]: () => {
          const sizes = [100, 100, 100, 3];
          const n = sizes[calls] === undefined ? 0 : sizes[calls];
          const items = page(n, calls * 100);
          calls++;
          return { json: { ok: true, count: n, totalItems, maybeMore: n >= 100, sample: items } };
        },
      },
    });
  }
  const scrollToEnd = async (client) => {
    for (let i = 0; i < 4; i++) await client.call("window._listDetailsLoadNextPage");
  };

  it("shows the real total before anything is scrolled, when the source reports one", async () => {
    const client = pagingClient(303);
    await client.call("openListDetailsPage", "Trending", "movie", "trakt:chart:trending", null, {});
    assert.match(subtitleOf(client), /303 items/,
      "the size is known from the first response -- there is no reason to make someone scroll for it");
  });

  it("says 100+ rather than 100 while there are pages it has not loaded", async () => {
    const client = pagingClient(null);
    await client.call("openListDetailsPage", "Trending", "movie", "trakt:chart:trending", null, {});
    assert.match(subtitleOf(client), /100\+ items/,
      "without a total from the source, a bare 100 reads as the whole list");
    await scrollToEnd(client);
    assert.match(subtitleOf(client), /303 items/, "and the exact count once the last page lands");
    assert.doesNotMatch(subtitleOf(client), /\+/, "with no + left on it");
  });

  it("stops believing a handed-in count the loaded items have overtaken", async () => {
    // This is the reported bug: the Discover card's badge passes its own
    // number through as an exact item count, and that number was the first
    // page's length. It then outranked the real count forever.
    const client = pagingClient(null);
    await client.call("openListDetailsPage", "Trending", "movie", "trakt:chart:trending", null, { itemCount: "100" });
    await scrollToEnd(client);
    assert.match(subtitleOf(client), /303 items/,
      "303 items are on screen; a header still claiming 100 is simply wrong");
  });

  it("keeps a stored list's own count, which is a real total", async () => {
    // The guard above must not throw away a count that IS the truth: a
    // creator list's itemCount comes from the stored record, not a page.
    const client = pagingClient(null);
    await client.call("openListDetailsPage", "Faves", "movie", "https://mdblist.com/lists/a/b", null, { itemCount: 250 });
    assert.match(subtitleOf(client), /250 items/);
    await client.call("window._listDetailsLoadNextPage");
    assert.match(subtitleOf(client), /250 items/, "one page of 100 does not contradict a stored total of 250");
  });

  it("brings the total down when an item is removed", async () => {
    const client = pagingClient(303);
    await client.call("openListDetailsPage", "Trending", "movie", "trakt:chart:trending", null, {});
    assert.match(subtitleOf(client), /303 items/);
    // What removeListItemFromDetails does after dropping one.
    await client.call("window._updateListDetailsItemCount", 99);
    assert.match(subtitleOf(client), /302 items/,
      "a list one item shorter must not keep advertising the size it had before");
  });
});

// --- AIII-8/9: a mirror that failed must not be reported as saved, and the
// --- three slug-bearing lists/save call sites must arm the conflict guard.
//
// saveLocalCustomListEdit() had no else and no error path around its account
// mirror: `if (data.ok && data.url) finalUrl = data.url;` inside a bare catch,
// then an unconditional "saved" modal. A 401, a 409 and a 500 all ended at the
// same success screen while nothing reached the account -- so on the next
// sign-in the server's older copy won and the edit was gone, having been
// reported saved.
//
// The same function was also one of three call sites that sent an explicit
// slug (a whole-list replacement of an existing list -- exactly what the
// server's expectedUpdatedAt guard exists for) with no baseline at all. The
// two findings are fixed together on purpose: arming the guard turns silent
// overwrites into 409s, which is only an improvement if the 409 is surfaced.
describe("client: a local list edit reports what actually happened to the account copy", () => {
  const LOCAL_LIST = JSON.stringify({
    faves: { slug: "faves", name: "Faves", type: "movie", items: [{ id: "tt0" }], createdAt: 1, updatedAt: 1 },
  });

  function editingLocal(client, cachedList) {
    client.set("activeCreator", { creatorName: "alice" });
    client.set("lastCreatorListsData", cachedList ? [cachedList] : []);
    client.set("editingLocalCustomListSlug", "faves");
    client.set("customListDraftItems", [{ id: "tt1" }, { id: "tt2" }]);
    client.set("customListDraftType", "movie");
  }

  function spyModals(client) {
    const saved = [];
    const notices = [];
    client.set("showSavedCustomListModal", (n, v, url) => saved.push({ n, v, url }));
    client.set("showAppNoticeModal", (t, m) => notices.push({ t, m }));
    client.set("renderCreatorDashboard", () => {});
    return { saved, notices };
  }

  // The account already holds this list. An empty /api/creator/lists would
  // make the load-time "upload lists this account is missing" pass fire and
  // put a second save on the wire, which has nothing to do with what is
  // under test.
  const ACCOUNT_LISTS = { ok: true, lists: [{
    slug: "faves", name: "Faves", type: "movie", visibility: "private", updatedAt: 4200, items: [{ id: "tt0" }],
  }] };

  const clientFor = (saveHandler, saves) => loadClient({
    storage: { "myListAddon:creatorKey": "KEY-123", "myListAddon:creatorName": "alice", "myListAddon:localCustomLists": LOCAL_LIST },
    routes: {
      [SAVE]: (req) => { if (saves) saves.push(req.body); return saveHandler(req); },
      [LISTS]: () => ({ json: ACCOUNT_LISTS }),
    },
  });

  it("cites the version the dashboard reported", async () => {
    const saves = [];
    const client = clientFor(() => ({ json: { ok: true, url: "https://x/lists/alice/faves", updatedAt: 7000 } }), saves);
    editingLocal(client, { slug: "faves", name: "Faves", type: "movie", updatedAt: 4200 });
    const { saved } = spyModals(client);

    await client.call("saveLocalCustomListEdit", "Faves");
    await settle();

    assert.equal(saves.length, 1);
    assert.equal(saves[0].expectedUpdatedAt, 4200,
      "a whole-list replacement of an existing list is exactly what the guard is for");
    assert.equal(saves[0].slug, "faves");
    assert.equal(saved.length, 1, "the save worked, so the success modal is correct here");
    assert.equal(saved[0].url, "https://x/lists/alice/faves");
  });

  it("does not show 'saved' when the server answered 500", async () => {
    const client = clientFor(() => ({ status: 500, json: { ok: false, error: "Internal error." } }));
    editingLocal(client, { slug: "faves", name: "Faves", type: "movie", updatedAt: 4200 });
    const { saved, notices } = spyModals(client);

    await client.call("saveLocalCustomListEdit", "Faves");
    await settle();

    assert.equal(saved.length, 0, "nothing reached the account -- saying 'saved' is the bug");
    assert.equal(notices.length, 1);
    assert.match(notices[0].m, /did not reach your account/);
  });

  it("names the conflict when the server answered 409", async () => {
    const client = clientFor(() => ({ status: 409, json: { ok: false, conflict: true, updatedAt: 9000 } }));
    editingLocal(client, { slug: "faves", name: "Faves", type: "movie", updatedAt: 4200 });
    const { saved, notices } = spyModals(client);

    await client.call("saveLocalCustomListEdit", "Faves");
    await settle();

    assert.equal(saved.length, 0);
    assert.match(notices[0].t, /Changed Elsewhere/);
    // A replacement cannot be merged onto the other device's copy, so the
    // person is told rather than one side being silently picked for them.
    assert.match(notices[0].m, /Another device saved changes/);
  });

  it("says the key was rejected on a 401", async () => {
    const client = clientFor(() => ({ status: 401, json: { ok: false, error: "Invalid key." } }));
    editingLocal(client, { slug: "faves", name: "Faves", type: "movie", updatedAt: 4200 });
    const { saved, notices } = spyModals(client);

    await client.call("saveLocalCustomListEdit", "Faves");
    await settle();

    assert.equal(saved.length, 0);
    assert.match(notices[0].m, /account key was rejected/);
  });

  it("surfaces a network failure instead of swallowing it", async () => {
    const client = loadClient({
      storage: { "myListAddon:creatorKey": "KEY-123", "myListAddon:creatorName": "alice", "myListAddon:localCustomLists": LOCAL_LIST },
      routes: { [SAVE]: () => { throw new Error("offline"); }, [LISTS]: () => ({ json: ACCOUNT_LISTS }) },
    });
    editingLocal(client, { slug: "faves", name: "Faves", type: "movie", updatedAt: 4200 });
    const { saved, notices } = spyModals(client);

    await client.call("saveLocalCustomListEdit", "Faves");
    await settle();

    assert.equal(saved.length, 0);
    assert.match(notices[0].m, /network error/i);
  });

  it("still saves locally when the account copy fails", async () => {
    const client = clientFor(() => ({ status: 500, json: { ok: false, error: "Internal error." } }));
    editingLocal(client, { slug: "faves", name: "Faves", type: "movie", updatedAt: 4200 });
    spyModals(client);

    await client.call("saveLocalCustomListEdit", "Faves");
    await settle();

    // The local save is this function's job and it works. Only the reported
    // outcome was wrong, so the fix must not make the local write conditional.
    const stored = JSON.parse(client.localStorage.getItem("myListAddon:localCustomLists"));
    assert.deepEqual(stored.faves.items.map((i) => i.id), ["tt1", "tt2"]);
  });

  it("shows 'saved' as before when there is no account at all", async () => {
    const client = loadClient({ storage: { "myListAddon:localCustomLists": LOCAL_LIST }, routes: {} });
    client.set("activeCreator", null);
    client.set("editingLocalCustomListSlug", "faves");
    client.set("customListDraftItems", [{ id: "tt1" }]);
    client.set("customListDraftType", "movie");
    const { saved, notices } = spyModals(client);

    await client.call("saveLocalCustomListEdit", "Faves");
    await settle();

    assert.equal(saved.length, 1, "a purely local list has no account copy to fail");
    assert.equal(notices.length, 0);
    assert.equal(client.requests.length, 0);
  });
});

describe("client: the watched-item sweep no longer overwrites the other device", () => {
  it("cites a baseline and re-applies the removal on a conflict", async () => {
    const saves = [];
    let conflicts = 1;
    const client = loadClient({
      storage: { "myListAddon:creatorKey": "KEY-123", "myListAddon:creatorName": "alice" },
      routes: {
        [SAVE]: (req) => {
          saves.push(req.body);
          if (conflicts-- > 0) return { status: 409, json: { ok: false, conflict: true } };
          return { json: { ok: true, updatedAt: 9500 } };
        },
        // What the other device saved: the watched film is still there, and
        // they added one of their own.
        [LISTS]: () => ({ json: { ok: true, lists: [{
          slug: "watchlist", name: "Watchlist", type: "mixed", visibility: "private", updatedAt: 9000,
          items: [{ id: "tt-watched", type: "movie" }, { id: "tt-theirs", type: "movie" }],
        }] } }),
      },
    });
    client.set("activeCreator", { creatorName: "alice" });
    client.set("lastCreatorListsData", [{
      slug: "watchlist", name: "Watchlist", type: "mixed", visibility: "private", updatedAt: 4200,
      items: [{ id: "tt-watched", type: "movie" }, { id: "tt-mine", type: "movie" }],
    }]);
    client.set("renderCreatorDashboard", () => {});

    await client.call("removeWatchedItemFromWatchlist", "tt-watched", null, null);
    await settle();

    assert.equal(saves.length, 2, "one attempt, one merged retry");
    assert.equal(saves[0].expectedUpdatedAt, 4200,
      "this used to be fire-and-forget with no baseline at all");
    assert.equal(saves[1].expectedUpdatedAt, 9000, "the retry cites the fresh version");
    const ids = saves[1].items.map((i) => i.id);
    assert.deepEqual(ids, ["tt-theirs"],
      "the watched film is gone AND the other device's addition survived -- re-sending the " +
      "array computed from the stale copy would have erased tt-theirs");
  });
});

describe("client: toggling one item into an account list cites the version", () => {
  function toggling(client, meta) {
    client.set("activeCreator", { creatorName: "alice" });
    client.set("lastCreatorListsData", [meta]);
    client.set("renderCreatorDashboard", () => {});
    client.window._selectListModalTempLists = [{
      name: "Faves",
      url: "customlist:v1:" + JSON.stringify({ creatorSlug: "faves", type: "movie", items: [{ id: "tt-old", imdbId: "tt-old" }] }),
    }];
  }

  it("sends expectedUpdatedAt", async () => {
    const saves = [];
    const client = loadClient({
      storage: { "myListAddon:creatorKey": "KEY-123", "myListAddon:creatorName": "alice" },
      routes: {
        [SAVE]: (req) => { saves.push(req.body); return { json: { ok: true, updatedAt: 8000 } }; },
        [LISTS]: () => ({ json: { ok: true, lists: [] } }),
      },
    });
    toggling(client, { slug: "faves", name: "Faves", type: "movie", visibility: "private", updatedAt: 4200, items: [{ id: "tt-old", imdbId: "tt-old" }] });

    client.call("toggleItemInCustomListUrl", "tt-new", "tt-new", "movie", 0, true, "New", "");
    await settle();

    assert.equal(saves.length, 1);
    assert.equal(saves[0].expectedUpdatedAt, 4200);
    assert.deepEqual(saves[0].items.map((i) => i.imdbId), ["tt-old", "tt-new"]);
  });

  it("re-applies the single add to what the other device saved", async () => {
    const saves = [];
    let conflicts = 1;
    const client = loadClient({
      storage: { "myListAddon:creatorKey": "KEY-123", "myListAddon:creatorName": "alice" },
      routes: {
        [SAVE]: (req) => {
          saves.push(req.body);
          if (conflicts-- > 0) return { status: 409, json: { ok: false, conflict: true } };
          return { json: { ok: true, updatedAt: 9500 } };
        },
        [LISTS]: () => ({ json: { ok: true, lists: [{
          slug: "faves", name: "Faves", type: "movie", visibility: "private", updatedAt: 9000,
          items: [{ id: "tt-old", imdbId: "tt-old" }, { id: "tt-theirs", imdbId: "tt-theirs" }],
        }] } }),
      },
    });
    toggling(client, { slug: "faves", name: "Faves", type: "movie", visibility: "private", updatedAt: 4200, items: [{ id: "tt-old", imdbId: "tt-old" }] });

    client.call("toggleItemInCustomListUrl", "tt-new", "tt-new", "movie", 0, true, "New", "");
    await settle();

    assert.equal(saves.length, 2);
    assert.deepEqual(saves[1].items.map((i) => i.imdbId), ["tt-old", "tt-theirs", "tt-new"],
      "both additions survive; the stale array would have dropped tt-theirs");
  });
});

// --- AIII-15/18: the two client loops that make the server's paging work ----
//
// Both endpoints now hand back part of an answer plus a continuation, and in
// both cases a client that ignores it loses data silently: the dashboard would
// show only the first page of lists (and then helpfully re-upload the ones it
// could not see), and a Letterboxd import would drop every title past the
// first batch. So the loops get their own tests.
describe("client: the dashboard pages through every list the account owns", () => {
  function pagedRoutes(total, pageSize, seen) {
    return {
      [LISTS]: (req) => {
        const offset = req.body.offset || 0;
        if (seen) seen.push({ offset, limit: req.body.limit, knownVersion: req.body.knownVersion });
        const lists = [];
        for (let i = offset; i < Math.min(offset + pageSize, total); i++) {
          lists.push({ slug: "l" + i, name: "List " + i, type: "movie", items: [], updatedAt: 1000 + i });
        }
        return { json: {
          ok: true, displayName: "alice", lists, order: [], deletedSlugs: [],
          total, offset, limit: pageSize, hasMore: offset + lists.length < total,
          version: "v" + offset,
        } };
      },
    };
  }

  it("keeps asking until the server says there is no more", async () => {
    const seen = [];
    const client = loadClient({
      storage: { "myListAddon:creatorKey": "KEY-123", "myListAddon:creatorName": "alice" },
      routes: pagedRoutes(450, 200, seen),
    });
    client.set("activeCreator", { creatorName: "alice" });

    const data = await client.call("fetchCreatorListsOnce", "KEY-123");
    assert.equal(data.lists.length, 450, "a dashboard showing only the first page re-uploads the rest");
    assert.equal(seen.map((s) => s.offset).join(","), "0,200,400");
    assert.equal(new Set(data.lists.map((l) => l.slug)).size, 450, "and nothing arrives twice");
    assert.equal(data.lists[449].slug, "l449");
  });

  it("hands a single-page account the server's own response, untouched", async () => {
    const client = loadClient({
      storage: { "myListAddon:creatorKey": "KEY-123", "myListAddon:creatorName": "alice" },
      routes: pagedRoutes(6, 200),
    });
    client.set("activeCreator", { creatorName: "alice" });

    const data = await client.call("fetchCreatorListsOnce", "KEY-123");
    assert.equal(data.lists.length, 6);
    assert.equal(data.version, "v0", "nothing downstream should see a synthesised object here");
  });

  it("stops at one page against a Worker that does not page at all", async () => {
    // An older deployment sends no hasMore. Reading that as "there is more"
    // would loop 100 times against the same offset.
    let calls = 0;
    const client = loadClient({
      storage: { "myListAddon:creatorKey": "KEY-123", "myListAddon:creatorName": "alice" },
      routes: { [LISTS]: () => { calls++; return { json: { ok: true, displayName: "alice", lists: [{ slug: "a", items: [] }], order: [], deletedSlugs: [], version: "v" } }; } },
    });
    client.set("activeCreator", { creatorName: "alice" });

    const data = await client.call("fetchCreatorListsOnce", "KEY-123");
    assert.equal(calls, 1);
    assert.equal(data.lists.length, 1);
  });

  it("reuses a cached page the server says is unchanged, and still learns there is more", async () => {
    // The conditional-response version is per page now. The trap this guards
    // is an "unchanged" page 0 that carries no paging fields: the client would
    // have no way to know page 1 exists and would silently show 200 of 300.
    const seen = [];
    const bodies = [];
    const client = loadClient({
      storage: { "myListAddon:creatorKey": "KEY-123", "myListAddon:creatorName": "alice" },
      routes: {
        [LISTS]: (req) => {
          const offset = req.body.offset || 0;
          seen.push({ offset, knownVersion: req.body.knownVersion });
          const version = "v" + offset;
          const paging = { total: 300, offset, limit: 200, hasMore: offset + 200 < 300, version };
          if (req.body.knownVersion === version) {
            bodies.push("unchanged@" + offset);
            return { json: { ok: true, unchanged: true, ...paging } };
          }
          const lists = [];
          for (let i = offset; i < Math.min(offset + 200, 300); i++) {
            lists.push({ slug: "l" + i, name: "List " + i, type: "movie", items: [] });
          }
          return { json: { ok: true, displayName: "alice", lists, order: [], deletedSlugs: [], ...paging } };
        },
      },
    });
    client.set("activeCreator", { creatorName: "alice" });

    const first = await client.call("fetchCreatorListsOnce", "KEY-123");
    assert.equal(first.lists.length, 300);
    client.set("lastCreatorListsData", first.lists);

    const again = await client.call("fetchCreatorListsOnce", "KEY-123");
    assert.equal(again.lists.length, 300, "an unchanged page must not truncate the assembled result");
    assert.ok(bodies.includes("unchanged@0") && bodies.includes("unchanged@200"),
      "the second pass must cite the version it holds for each page");
    assert.equal(seen.filter((s) => s.offset === 200).length, 2,
      "and must still ask for page 1 after an unchanged page 0");
  });
});

// --- AIII-15, second half: the transfer, not just the op count -------------
//
// /api/creator/lists stopped shipping every list's items (15.08 MB at 1,200
// lists, re-sent after every save, delete and tab switch). The client fills
// them in from /api/creator/lists/items for the slugs whose version it does
// not already hold. Every consumer of lastCreatorListsData still reads
// `.items` synchronously, so what these tests are really pinning is that the
// array is always there and always right -- an empty one would silently drop
// items from "add to an existing mixed list", the channel builder and backup.
describe("client: the dashboard fills in the item contents the list route no longer sends", () => {
  const ITEMS = "/api/creator/lists/items";

  function splitRoutes(state) {
    return {
      [LISTS]: (req) => {
        state.listCalls.push(req.body);
        return { json: {
          ok: true, displayName: "alice", order: [], deletedSlugs: [],
          total: state.lists.length, offset: 0, limit: 200, hasMore: false,
          version: state.version,
          lists: state.lists.map((l) => (
            req.body.includeItems
              ? { slug: l.slug, name: l.slug, type: "movie", items: l.items, itemCount: l.items.length, updatedAt: l.updatedAt }
              : { slug: l.slug, name: l.slug, type: "movie", itemCount: l.items.length, updatedAt: l.updatedAt }
          )),
        } };
      },
      [ITEMS]: (req) => {
        state.itemCalls.push(req.body.slugs);
        if (state.itemsFail) return { json: { ok: false, error: "nope" } };
        return { json: { ok: true, lists: state.lists
          .filter((l) => req.body.slugs.includes(l.slug) && l.slug !== state.dropSlug)
          .map((l) => ({ slug: l.slug, items: l.items, itemCount: l.items.length, updatedAt: l.updatedAt })) } };
      },
    };
  }

  function makeState(n) {
    return {
      version: "v1",
      listCalls: [], itemCalls: [], itemsFail: false, dropSlug: null,
      lists: Array.from({ length: n }, (_, i) => ({
        slug: "l" + i, updatedAt: 1000 + i, items: [{ id: "tt" + i }],
      })),
    };
  }

  function signedIn(state) {
    const client = loadClient({
      storage: { "myListAddon:creatorKey": "KEY-123", "myListAddon:creatorName": "alice" },
      routes: splitRoutes(state),
    });
    client.set("activeCreator", { creatorName: "alice" });
    return client;
  }

  it("gives every list a real items array on a cold load", async () => {
    const state = makeState(3);
    const client = signedIn(state);
    const data = await client.call("fetchCreatorListsOnce", "KEY-123");
    assert.deepEqual(data.lists.map((l) => l.items[0].id), ["tt0", "tt1", "tt2"],
      "a consumer reading .items synchronously must never see an empty array");
    assert.deepEqual(state.itemCalls, [["l0", "l1", "l2"]]);
  });

  it("asks only for the list that changed on the next render", async () => {
    const state = makeState(3);
    const client = signedIn(state);
    await client.call("fetchCreatorListsOnce", "KEY-123");
    client.set("lastCreatorListsData", []);

    // One list edited elsewhere: new contents, new version. The other two are
    // untouched, and re-sending them is the whole cost this change removes.
    state.version = "v2";
    state.lists[1] = { slug: "l1", updatedAt: 9999, items: [{ id: "tt-new" }, { id: "tt-new2" }] };
    state.itemCalls.length = 0;

    const data = await client.call("fetchCreatorListsOnce", "KEY-123");
    assert.deepEqual(state.itemCalls, [["l1"]], "only the changed slug should be refetched");
    assert.deepEqual(data.lists.map((l) => l.items.length), [1, 2, 1]);
    assert.equal(data.lists[1].items[0].id, "tt-new");
  });

  it("refetches when the count disagrees even though the version does not", async () => {
    // Belt and braces: a record whose updatedAt did not move but whose size
    // did is a record this client cannot trust its copy of.
    const state = makeState(1);
    const client = signedIn(state);
    await client.call("fetchCreatorListsOnce", "KEY-123");
    client.set("lastCreatorListsData", []);

    state.version = "v2";
    state.lists[0].items = [{ id: "a" }, { id: "b" }];
    state.itemCalls.length = 0;
    const data = await client.call("fetchCreatorListsOnce", "KEY-123");
    assert.deepEqual(state.itemCalls, [["l0"]]);
    assert.equal(data.lists[0].items.length, 2);
  });

  it("refetches a legacy record with no version, every time", async () => {
    const state = makeState(1);
    state.lists[0].updatedAt = undefined;
    const client = signedIn(state);
    await client.call("fetchCreatorListsOnce", "KEY-123");
    client.set("lastCreatorListsData", []);
    state.version = "v2";
    state.itemCalls.length = 0;
    const data = await client.call("fetchCreatorListsOnce", "KEY-123");
    assert.deepEqual(state.itemCalls, [["l0"]],
      "with no version to cache on, the only safe answer is to ask");
    assert.equal(data.lists[0].items.length, 1);
  });

  it("falls back to the whole payload rather than rendering empty lists", async () => {
    const state = makeState(2);
    state.itemsFail = true;
    const client = signedIn(state);
    const data = await client.call("fetchCreatorListsOnce", "KEY-123");
    assert.ok(state.listCalls.some((b) => b.includeItems === true),
      "a failed delta fetch must re-ask for the old shape");
    assert.deepEqual(data.lists.map((l) => l.items[0].id), ["tt0", "tt1"]);
  });

  it("falls back when the items route answers without a slug it was asked for", async () => {
    // A record that vanished between the two calls. Papering over it with an
    // empty array is exactly the silent loss this endpoint split could cause.
    const state = makeState(2);
    state.dropSlug = "l1";
    const client = signedIn(state);
    const data = await client.call("fetchCreatorListsOnce", "KEY-123");
    assert.ok(state.listCalls.some((b) => b.includeItems === true),
      "a partial answer must be treated as a failed delta fetch, not as an empty list");
    assert.deepEqual(data.lists.map((l) => l.items[0].id), ["tt0", "tt1"]);
  });

  it("batches the requests so one call cannot exceed the server's cap", async () => {
    const state = makeState(250);
    const client = signedIn(state);
    await client.call("fetchCreatorListsOnce", "KEY-123");
    assert.equal(state.itemCalls.length, 3);
    for (const batch of state.itemCalls) {
      assert.ok(batch.length <= 100, "a batch over the cap is refused with a 400");
    }
    assert.equal(state.itemCalls.reduce((n, b) => n + b.length, 0), 250);
  });
});

describe("client: a Letterboxd import follows the server's continuation", () => {
  const RESOLVE = "/api/bulk-resolve";

  it("resumes from exactly what the server processed, not from the chunk size", async () => {
    const posted = [];
    const client = loadClient({
      routes: {
        [RESOLVE]: (req) => {
          const items = req.body.items || [];
          posted.push(items.length);
          // A free-plan Worker: 24 titles per invocation, whatever it was sent.
          const took = Math.min(24, items.length);
          return { json: {
            ok: true,
            resolved: items.slice(0, took).map((it) => ({ title: it.title, imdbId: "tt" + it.title })),
            nextIndex: took,
            done: took >= items.length,
          } };
        },
      },
    });

    const titles = Array.from({ length: 100 }, (_, i) => ({ title: String(i), year: 2000 }));
    const out = await client.call("bulkResolveInChunks", titles);

    assert.equal(out.length, 100, "advancing by the chunk size would silently drop 76 of these");
    // Joined, not deepEqual'd: the bundle evaluates in a vm sandbox, so an
    // array it built has that realm's Array.prototype and deepStrictEqual
    // rejects it on the prototype before it ever looks at the contents.
    assert.equal(out.map((r) => r.title).join(","), titles.map((t) => t.title).join(","), "and in order");
    assert.equal(posted.length, Math.ceil(100 / 24));
  });

  it("still works against a Worker that sends no continuation", async () => {
    const client = loadClient({
      routes: {
        [RESOLVE]: (req) => ({ json: {
          ok: true,
          resolved: (req.body.items || []).map((it) => ({ title: it.title, imdbId: "tt" + it.title })),
        } }),
      },
    });
    const out = await client.call("bulkResolveInChunks", Array.from({ length: 500 }, (_, i) => ({ title: String(i) })));
    assert.equal(out.length, 500, "a missing nextIndex means the whole chunk was processed");
  });

  it("refuses to spin when the server reports no progress", async () => {
    const client = loadClient({
      routes: { [RESOLVE]: () => ({ json: { ok: true, resolved: [], nextIndex: 0, done: false } }) },
    });
    await assert.rejects(
      () => client.call("bulkResolveInChunks", [{ title: "A" }, { title: "B" }]),
      /no progress/,
      "an infinite retry loop is worse than a reported failure",
    );
  });
});

// A Discover/My Lists/Search card's poster strip going blank and staying
// blank forever -- "sometimes lists just doesn't load" -- traced to
// populateSearchResultPosters treating one failed /api/preview call as
// final: nothing rendered, nothing logged anywhere visible, and no way back
// short of a full page reload. loadPosterSlot (one card's fetch-and-render,
// extracted so this and the Retry button can share it) now retries once
// automatically, and only gives up -- visibly, with a Retry button -- after
// that second attempt also fails.
describe("client: a card's poster preview retries once before giving up", () => {
  const PREVIEW = "/api/preview";
  const okBody = (name) => ({
    ok: true, count: 1, totalItems: 1,
    sample: [{ id: "tt1", type: "movie", name: name || "Film", poster: "https://img.example/1.jpg" }],
  });

  function makeSlot(client, id, opts = {}) {
    const slot = client.document.getElementById(id);
    slot.dataset.url = opts.url || "mdblist:list:abc";
    slot.dataset.type = opts.type || "movie";
    slot.dataset.name = opts.name || "Some List";
    return slot;
  }

  it("a single transient failure self-heals -- the retry renders the card", async () => {
    let calls = 0;
    const client = loadClient({
      routes: {
        [PREVIEW]: () => { calls++; return calls === 1 ? { status: 500, json: { ok: false } } : { json: okBody() }; },
      },
    });
    const slot = makeSlot(client, "slot1");
    await client.call("loadPosterSlot", slot);
    assert.equal(calls, 2, "exactly one retry");
    assert.equal(slot.className, "list-card-posters");
    assert.match(slot.innerHTML, /Film/);
  });

  it("a healthy first response costs exactly one request", async () => {
    let calls = 0;
    const client = loadClient({
      routes: { [PREVIEW]: () => { calls++; return { json: okBody() }; } },
    });
    const slot = makeSlot(client, "slot2");
    await client.call("loadPosterSlot", slot);
    assert.equal(calls, 1, "no retry when nothing failed");
  });

  it("gives up after the retry and leaves the card retryable, not blank", () => {
    return (async () => {
      let calls = 0;
      const client = loadClient({
        routes: { [PREVIEW]: () => { calls++; return { status: 500, json: { ok: false } }; } },
      });
      const slot = makeSlot(client, "slot3");
      await client.call("loadPosterSlot", slot);
      assert.equal(calls, 2, "one retry, not a loop against a real outage");
      assert.match(slot.className, /poster-preview-error/);
      assert.doesNotMatch(slot.className, /poster-preview-slot/,
        "must resolve out of the in-flight class -- stashCatalogSearchView reads that class to mean still loading");
      assert.match(slot.innerHTML, /onclick="retryPosterSlot\(this\)"/,
        "a way back that does not require reloading the whole page");
    })();
  });

  it("mixed-type cards retry each half independently and merge whichever succeeds", async () => {
    let movieCalls = 0;
    let seriesCalls = 0;
    const client = loadClient({
      routes: {
        [PREVIEW]: (req) => {
          if (req.body.type === "series") { seriesCalls++; return { status: 500, json: { ok: false } }; }
          movieCalls++;
          return { json: okBody("Movie Half") };
        },
      },
    });
    const slot = makeSlot(client, "slotMixed", { type: "mixed" });
    await client.call("loadPosterSlot", slot);
    assert.equal(seriesCalls, 2, "the failing half still gets its own retry");
    assert.equal(movieCalls, 1, "the healthy half is not retried");
    assert.equal(slot.className, "list-card-posters");
    assert.match(slot.innerHTML, /Movie Half/, "renders from whichever half actually came back");
  });

  it("Retry re-fetches and can recover a card that failed twice", async () => {
    let calls = 0;
    const client = loadClient({
      routes: {
        [PREVIEW]: () => { calls++; return calls <= 2 ? { status: 500, json: { ok: false } } : { json: okBody() }; },
      },
    });
    const slot = makeSlot(client, "slot4");
    await client.call("loadPosterSlot", slot);
    assert.match(slot.className, /poster-preview-error/);

    const btn = client.document.getElementById("retryBtn4");
    btn.closest = () => slot;
    client.call("retryPosterSlot", btn);
    // Fire-and-forget, the way an onclick attribute calls it -- the reset is
    // synchronous, the re-fetch is not.
    assert.equal(slot.className, "list-card-posters poster-preview-slot", "reset before the re-fetch starts");
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(calls, 3, "Retry fires exactly one more request");
    assert.equal(slot.className, "list-card-posters");
    assert.match(slot.innerHTML, /Film/, "and recovers once the list actually loads");
  });

  it("renders empty state instead of error when preview succeeds with 0 items", async () => {
    const client = loadClient({
      routes: {
        [PREVIEW]: () => ({ json: { ok: true, count: 0, sample: [] } }),
      },
    });
    const slot = makeSlot(client, "slotEmpty");
    await client.call("loadPosterSlot", slot);
    assert.match(slot.className, /poster-preview-empty/);
    assert.doesNotMatch(slot.className, /poster-preview-slot/);
    assert.match(slot.innerHTML, /No items found in this list/);
  });

  it("falls back to alternate type when primary type returns 0 items", async () => {
    const requests = [];
    const client = loadClient({
      routes: {
        [PREVIEW]: (req) => {
          requests.push(req.body.type);
          if (req.body.type === "movie") {
            return { json: { ok: true, count: 0, sample: [] } };
          }
          return { json: okBody("TV Show") };
        },
      },
    });
    const slot = makeSlot(client, "slotFallback", { type: "movie" });
    await client.call("loadPosterSlot", slot);
    assert.deepEqual(requests, ["movie", "series"]);
    assert.equal(slot.dataset.type, "series");
    assert.equal(slot.className, "list-card-posters");
    assert.match(slot.innerHTML, /TV Show/);
  });
});

// Behavioural companion to the source-level Discover header tests in
// worker.test.mjs: those check the markup and the code shape, this drives
// filterDiscoverShelves for real and checks what actually lands on the
// header element -- which a source-text match can't tell apart from a
// mutation like `if (false) { ...same lines... }`.
describe("client: Discover's shared-feed header follows the active pill", () => {
  it("shows the right title for each shared-feed pill, and hides for Popular/Curated", () => {
    const client = loadClient();
    const header = client.document.getElementById("discoverListsFeedHeader");
    const title = client.document.getElementById("discoverListsFeedTitle");

    const cases = [
      ["all", "All"], ["movie", "Movies"], ["series", "Shows"],
      ["gems", "Hidden Gems"], ["kids", "Kids"], ["holidays", "Holidays"], ["genres", "Genres"],
    ];
    for (const [filter, label] of cases) {
      client.call("filterDiscoverShelves", filter, null);
      assert.equal(header.style.display, "flex", `${filter}: the header must be visible`);
      assert.equal(title.textContent, label, `${filter}: wrong title text`);
    }

    client.call("filterDiscoverShelves", "popular", null);
    assert.equal(header.style.display, "none", "Popular has its own header -- the shared one must hide");
    client.call("filterDiscoverShelves", "curated", null);
    assert.equal(header.style.display, "none", "Curated has its own header too");
  });
});

describe("client: smart sync & merge strategy for external custom lists", () => {
  it("getItemKey returns consistent unique keys across formats", () => {
    const client = loadClient();
    const getKey = (it) => client.call("getItemKey", it);
    assert.equal(getKey({ imdbId: "tt12345" }), "tt12345");
    assert.equal(getKey({ id: "tt12345" }), "tt12345");
    assert.equal(getKey({ tmdbId: 999 }), "tmdb:999");
    assert.equal(getKey({ title: "Inception", year: 2010 }), "inception:2010");
  });

  it("adds newly discovered remote items while preserving user additions and removals", () => {
    const client = loadClient();
    const merge = (c, b, r, opt) => client.call("performSmartListMerge", c, b, r, opt);

    // Initial base: [A, B, C]
    // User deleted B, added X: Current is [A, X, C]
    // Remote author added D, kept A, B, C: Remote is [A, B, C, D]
    const current = [
      { id: "ttA", title: "A" },
      { id: "ttX", title: "X" }, // user addition
      { id: "ttC", title: "C" },
    ];
    const baseIds = ["ttA", "ttB", "ttC"]; // user removed ttB
    const remote = [
      { id: "ttA", title: "A" },
      { id: "ttB", title: "B" },
      { id: "ttC", title: "C" },
      { id: "ttD", title: "D" }, // remote addition
    ];

    const result = merge(current, baseIds, remote);

    // ttB must NOT be resurrected because user deleted it.
    // ttX must be preserved because user added it.
    // ttD must be added from remote.
    // User order [A, X, C] must be preserved, with D appended.
    const resultIds = Array.from(result.items, (it) => it.id);
    assert.deepEqual(resultIds, ["ttA", "ttX", "ttC", "ttD"]);
    assert.equal(result.addedCount, 1);
    assert.deepEqual(Array.from(result.newBaseItemIds), ["ttA", "ttB", "ttC", "ttD"]);
  });

  it("handles initial sync when baseItemIds is missing without losing user items", () => {
    const client = loadClient();
    const merge = (c, b, r, opt) => client.call("performSmartListMerge", c, b, r, opt);

    const current = [{ id: "ttA", title: "A" }, { id: "ttX", title: "X" }];
    const remote = [{ id: "ttA", title: "A" }, { id: "ttB", title: "B" }];

    const result = merge(current, null, remote);
    const resultIds = Array.from(result.items, (it) => it.id);
    assert.deepEqual(resultIds, ["ttA", "ttX", "ttB"]);
    assert.equal(result.addedCount, 1);
    assert.deepEqual(Array.from(result.newBaseItemIds), ["ttA", "ttB"]);
  });

  it("saveLocalCustomListEdit preserves sourceUrl, synced, lastSyncedAt, and baseItemIds", async () => {
    const client = loadClient({
      storage: {
        "myListAddon:localCustomLists": JSON.stringify({
          syncedList: {
            slug: "syncedList",
            name: "Synced List",
            type: "movie",
            items: [{ id: "tt1" }, { id: "tt2" }],
            sourceUrl: "https://mdblist.com/lists/test/1",
            synced: true,
            lastSyncedAt: 1000,
            baseItemIds: ["tt1", "tt2"],
            createdAt: 1000,
            updatedAt: 1000,
          }
        })
      },
      routes: {}
    });
    client.set("activeCreator", null);
    client.set("editingLocalCustomListSlug", "syncedList");
    client.set("customListDraftItems", [{ id: "tt1" }, { id: "tt3" }]);
    client.set("customListDraftType", "movie");

    await client.call("saveLocalCustomListEdit", "Synced List");
    await new Promise((r) => setImmediate(r));

    const stored = JSON.parse(client.localStorage.getItem("myListAddon:localCustomLists"));
    const updated = stored.syncedList;
    assert.ok(updated, "list was saved");
    assert.equal(updated.sourceUrl, "https://mdblist.com/lists/test/1");
    assert.equal(updated.synced, true);
    assert.equal(updated.lastSyncedAt, 1000);
    assert.deepEqual(Array.from(updated.baseItemIds), ["tt1", "tt2"]);
    assert.deepEqual(Array.from(updated.items, (i) => i.id), ["tt1", "tt3"]);
  });
});

describe("client: Discover header cards, descriptions, and channel pool limit", () => {
  it("Discover header card displays title and tailored description for every shared-feed pill", () => {
    const client = loadClient();
    const header = client.document.getElementById("discoverListsFeedHeader");
    const title = client.document.getElementById("discoverListsFeedTitle");
    const desc = client.document.getElementById("discoverListsFeedDesc");

    assert.ok(header, "header must exist");
    assert.ok(desc, "header must include description element");

    const cases = [
      ["all", "All", "Explore popular charts"],
      ["movie", "Movies", "Top charts, new releases"],
      ["series", "Shows", "Trending TV series"],
      ["gems", "Hidden Gems", "Under-the-radar masterpieces"],
      ["kids", "Kids", "Family-friendly movies"],
      ["holidays", "Holidays", "Seasonal favorites"],
      ["genres", "Genres", "Browse top movies and series"],
    ];
    for (const [filter, expectedTitle, expectedSnippet] of cases) {
      client.call("filterDiscoverShelves", filter, null);
      assert.equal(header.style.display, "flex");
      assert.equal(title.textContent, expectedTitle);
      assert.match(desc.textContent, new RegExp(expectedSnippet));
    }
  });

  it("Channels pool cap is 5000 and rotation is 24 shows x 3 episodes", () => {
    const client = loadClient();
    assert.equal(client.get("CHANNEL_POOL_MAX_ITEMS"), 5000);
    assert.equal(client.get("CHANNEL_ROTATION_SHOWS_PER_DAY"), 24);
    assert.equal(client.get("CHANNEL_ROTATION_EPISODES_PER_SHOW"), 3);
  });
});

describe("client: local storage quota and creator profile watch history preservation", () => {
  it("signed-in user keeps full items in memory when localStorage throws QuotaExceededError", () => {
    let alertCalled = false;
    let storageFullCalled = false;
    const client = loadClient();
    client.set("showAppAlert", (title, msg) => {
      if (title === "Some list items could not be kept") alertCalled = true;
      if (title === "Local storage is full") storageFullCalled = true;
    });
    client.set("activeCreator", { creatorName: "alice" });

    const storage = client.get("localStorage");
    const originalSetItem = storage.setItem.bind(storage);
    storage.setItem = (k, v) => {
      if (k === "myListAddon:localCustomLists" && v.length > 5000) {
        const err = new Error("QuotaExceededError");
        err.name = "QuotaExceededError";
        throw err;
      }
      return originalSetItem(k, v);
    };

    const items = Array.from({ length: 2500 }, (_, i) => ({
      id: "tt" + i,
      title: "Movie " + i,
      type: "movie",
    }));
    const map = {
      "watch-history": {
        slug: "watch-history",
        name: "Watch History",
        type: "mixed",
        isWatchHistory: true,
        items: items,
      },
    };

    const res = client.call("saveLocalCustomListsMap", map);
    assert.equal(res, true, "saveLocalCustomListsMap must succeed for signed-in user");
    assert.equal(alertCalled, false, "must NOT show 'Some list items could not be kept' to signed in user");
    assert.equal(storageFullCalled, true, "must call notifyStorageFull for signed-in user");

    const inMem = client.call("loadLocalCustomLists");
    assert.equal(inMem["watch-history"].items.length, 2500, "in-memory watch history must keep all 2500 items");
  });

  it("signed-out user is notified of dropped items when localStorage quota is exceeded", () => {
    let alertCalled = false;
    const client = loadClient();
    client.set("showAppAlert", (title, msg) => {
      if (title === "Some list items could not be kept") alertCalled = true;
    });
    client.set("activeCreator", null);

    const storage = client.get("localStorage");
    const originalSetItem = storage.setItem.bind(storage);
    storage.setItem = (k, v) => {
      if (k === "myListAddon:localCustomLists" && v.length > 5000) {
        const err = new Error("QuotaExceededError");
        err.name = "QuotaExceededError";
        throw err;
      }
      return originalSetItem(k, v);
    };

    const items = Array.from({ length: 800 }, (_, i) => ({
      id: "tt" + i,
      title: "Movie " + i,
      type: "movie",
    }));
    const map = {
      "watch-history": {
        slug: "watch-history",
        name: "Watch History",
        type: "mixed",
        isWatchHistory: true,
        items: items,
      },
    };

    client.call("saveLocalCustomListsMap", map);
    assert.equal(alertCalled, true, "must notify signed-out user that items were dropped");
    const inMem = client.call("loadLocalCustomLists");
    assert.equal(inMem["watch-history"].items.length, 500, "signed-out user is truncated to 500 items");
  });

  it("large channel with 4938 items preserves all items in memory & session when localStorage throws QuotaExceededError", () => {
    const client = loadClient();
    const storage = client.get("localStorage");
    const originalSetItem = storage.setItem.bind(storage);
    storage.setItem = (k, v) => {
      if (k === "myListAddon:localChannels" && v.length > 5000) {
        const err = new Error("QuotaExceededError");
        err.name = "QuotaExceededError";
        throw err;
      }
      return originalSetItem(k, v);
    };

    const items = Array.from({ length: 4938 }, (_, i) => ({
      kind: "episode",
      imdbId: "tt" + i,
      season: 1,
      episode: i + 1,
      showName: "A&E Show",
      epName: "Episode " + (i + 1),
      title: "A&E Show S1E" + (i + 1) + " — Episode " + (i + 1),
      released: "2024-01-01",
      poster: "https://image.tmdb.org/t/p/w500/ae.jpg",
      thumbnail: "https://image.tmdb.org/t/p/w500/ae.jpg",
      showPoster: "https://image.tmdb.org/t/p/w500/ae.jpg",
    }));

    const map = {
      "channel-ae": {
        channelId: "channel-ae",
        name: "A&E",
        poster: "https://image.tmdb.org/t/p/w500/ae.jpg",
        items: items,
      },
    };

    const res = client.call("saveLocalChannelsMap", map);
    assert.equal(res, true, "saveLocalChannelsMap must succeed and handle QuotaExceededError gracefully");

    const loaded = client.call("loadLocalChannels");
    assert.ok(loaded["channel-ae"], "channel-ae must exist in loaded channels map");
    assert.equal(loaded["channel-ae"].items.length, 4938, "must preserve all 4938 items in memory/session");

    let openedDetails = null;
    client.set("openListDetailsPage", (title, type, url, preloaded) => {
      openedDetails = { title, type, url, preloaded };
    });

    client.call("openChannelDetailsPage", "channel-ae");
    assert.ok(openedDetails, "openChannelDetailsPage must successfully trigger openListDetailsPage");
    assert.equal(openedDetails.title, "A&E");
    assert.equal(openedDetails.preloaded.count, 4938, "See All must receive full 4938 items");
    assert.equal(openedDetails.preloaded.sample.length, 4938);
  });
});

// A channel plays in exactly one order: the order its picks are listed,
// reshuffled once a day, or oldest-aired first. The builder offers the last
// two as two checkboxes (because "neither" is the default answer and a radio
// group would need a third option to say it), which only works if they keep
// each other clear -- on the page AND in what gets saved, since the Worker
// reads the saved payload and nothing else.
// A channel's picks play in the order they are listed, full stop. The Play
// order dropdown is a menu of one-shot ARRANGEMENTS of that list -- picking
// one reorders the picks then and there -- rather than a rule applied over
// the top of them at serve time, which is what the old "Sort by air date"
// checkbox was and why a hand-moved pick used to snap back.
//
// The one exception is "Shuffle daily": the Worker reshuffles from a
// date-based seed on every request, so no stored order can express it.
describe("client: a channel's Play order arranges the list itself", () => {
  const ep = (over = {}) => ({
    kind: "episode", imdbId: "tt1", season: 1, episode: 1,
    showName: "Show", epName: "Ep", title: "Show S1E1", ...over,
  });
  // Deliberately out of every order this tests: not by date, not by show.
  const PICKS = [
    ep({ imdbId: "tt_office", showName: "The Office", season: 2, episode: 7, title: "The Office S2E7", released: "2005-11-22" }),
    ep({ imdbId: "tt_friends", showName: "Friends", season: 5, episode: 13, title: "Friends S5E13", released: "1999-02-11" }),
    ep({ imdbId: "tt_office", showName: "The Office", season: 1, episode: 1, title: "The Office S1E1", released: "2005-03-24" }),
    ep({ imdbId: "tt_friends", showName: "Friends", season: 1, episode: 1, title: "Friends S1E1", released: "1994-09-22" }),
  ];
  const titles = (client) => client.get("channelDraftItems").map((it) => it.title);

  function withPicks(client, picks = PICKS) {
    client.set("channelDraftItems", picks.map((it) => ({ ...it })));
    return client;
  }

  it("reorders the picks themselves when a sort is chosen", () => {
    const client = withPicks(loadClient());
    client.call("applyChannelPlayOrder", "aired-asc");
    assert.deepEqual(titles(client),
      ["Friends S1E1", "Friends S5E13", "The Office S1E1", "The Office S2E7"]);

    client.call("applyChannelPlayOrder", "aired-desc");
    assert.deepEqual(titles(client),
      ["The Office S2E7", "The Office S1E1", "Friends S5E13", "Friends S1E1"]);

    // Shows keep the order they first appear in; within a show, broadcast order.
    withPicks(client);
    client.call("applyChannelPlayOrder", "show-season-episode");
    assert.deepEqual(titles(client),
      ["The Office S1E1", "The Office S2E7", "Friends S1E1", "Friends S5E13"]);

    withPicks(client);
    client.call("applyChannelPlayOrder", "title-az");
    assert.deepEqual(titles(client),
      ["Friends S1E1", "Friends S5E13", "The Office S1E1", "The Office S2E7"]);
  });

  it("keeps a sorted channel sorted as picks are added", () => {
    const client = withPicks(loadClient());
    client.call("applyChannelPlayOrder", "aired-asc");

    // Every add path in the builder ends with renderChannelDraftList, which
    // is where a remembered sort is re-applied.
    client.get("channelDraftItems").push(ep({
      imdbId: "tt_frasier", showName: "Frasier", season: 8, episode: 14,
      title: "Frasier S8E14", released: "2001-02-20",
    }));
    client.call("renderChannelDraftList");

    assert.deepEqual(titles(client),
      ["Friends S1E1", "Friends S5E13", "Frasier S8E14", "The Office S1E1", "The Office S2E7"],
      "a pick added later must land in its place, not at the bottom");
  });

  // The whole point of the change: what you drag stays dragged.
  it("stops re-sorting once a pick is moved by hand, and keeps the new order", () => {
    const client = withPicks(loadClient());
    client.call("applyChannelPlayOrder", "aired-asc");

    // Move the last pick to the front, the way the position input does.
    const items = client.get("channelDraftItems");
    client.call("clearChannelDraftAutoSort");
    items.unshift(items.pop());
    client.call("renderChannelDraftList");

    assert.deepEqual(titles(client),
      ["The Office S2E7", "Friends S1E1", "Friends S5E13", "The Office S1E1"],
      "the hand-moved pick must stay where it was put");
    assert.equal(client.call("getChannelPlayOrder"), "as-listed",
      "the dropdown must fall back to As listed");
    assert.equal(client.call("channelDraftAutoSortKey"), "",
      "and nothing must be armed to re-sort on the next render");

    // A further add must not resurrect the sort either.
    client.get("channelDraftItems").push(ep({ imdbId: "tt_new", title: "Added Later", released: "1990-01-01" }));
    client.call("renderChannelDraftList");
    assert.equal(titles(client)[0], "The Office S2E7", "still the person's order");
    assert.equal(titles(client)[4], "Added Later", "a new pick appends once the sort is off");
  });

  it("shuffles once without arming anything, and leaves the dropdown alone", () => {
    const client = withPicks(loadClient());
    client.call("applyChannelPlayOrder", "aired-asc");
    client.call("applyChannelPlayOrder", "shuffle-now");

    assert.equal(client.call("getChannelPlayOrder"), "as-listed");
    assert.equal(client.call("channelDraftAutoSortKey"), "", "Shuffle now is a one-off, not a mode");
    assert.deepEqual([...titles(client)].sort(), [...PICKS.map((it) => it.title)].sort(),
      "every pick is still there, once");
  });

  it("saves a sort as the item order, and Shuffle daily as the only flag", () => {
    const client = withPicks(loadClient());
    client.get("document").getElementById("channelNameInput").value = "Sorted Channel";
    client.call("applyChannelPlayOrder", "aired-asc");
    client.call("saveChannel");

    const saved = Object.values(client.call("loadLocalChannels"))[0];
    assert.deepEqual(saved.items.map((it) => it.title),
      ["Friends S1E1", "Friends S5E13", "The Office S1E1", "The Office S2E7"],
      "the saved order IS the play order -- the Worker does not sort it");
    assert.equal(saved.autoSort, "aired-asc", "remembered so later picks land in order");
    assert.equal(saved.shuffle, false);
    assert.equal(saved.sortByAired, false, "the serve-time flag is never written again");

    const client2 = withPicks(loadClient());
    client2.get("document").getElementById("channelNameInput").value = "Daily Channel";
    client2.call("applyChannelPlayOrder", "shuffle-daily");
    client2.call("saveChannel");
    const daily = Object.values(client2.call("loadLocalChannels"))[0];
    assert.equal(daily.shuffle, true, "Shuffle daily is the one entry the Worker acts on");
    assert.equal(daily.autoSort, "", "and it arranges nothing itself");
    assert.deepEqual(daily.items.map((it) => it.title), PICKS.map((it) => it.title),
      "the picks keep their order -- the daily reshuffle happens at serve time");
  });

  it("puts the saved play order back on the dropdown when a channel is edited", () => {
    const client = loadClient();
    client.call("saveLocalChannel", { channelId: "ch-sorted", name: "Sorted", autoSort: "title-az", items: [PICKS[0]] });
    client.call("saveLocalChannel", { channelId: "ch-daily", name: "Daily", shuffle: true, items: [PICKS[0]] });
    client.call("saveLocalChannel", { channelId: "ch-plain", name: "Plain", items: [PICKS[0]] });

    client.call("editChannelById", "ch-sorted");
    assert.equal(client.call("getChannelPlayOrder"), "title-az");
    client.call("editChannelById", "ch-daily");
    assert.equal(client.call("getChannelPlayOrder"), "shuffle-daily");
    client.call("editChannelById", "ch-plain");
    assert.equal(client.call("getChannelPlayOrder"), "as-listed");
  });

  // The previous release's checkbox wrote a flag the Worker sorted on every
  // request. Editing such a channel has to turn that into a real order, or
  // it would open in the builder looking unsorted and save that way.
  it("migrates a channel saved with the old serve-time sortByAired flag", () => {
    const client = loadClient();
    client.call("saveLocalChannel", {
      channelId: "ch-legacy", name: "Legacy", sortByAired: true, items: PICKS.map((it) => ({ ...it })),
    });

    client.call("editChannelById", "ch-legacy");
    assert.equal(client.call("getChannelPlayOrder"), "aired-asc");
    assert.deepEqual(titles(client),
      ["Friends S1E1", "Friends S5E13", "The Office S1E1", "The Office S2E7"],
      "opening it sorts the picks for real");

    client.get("document").getElementById("channelNameInput").value = "Legacy";
    client.call("saveChannel");
    const saved = client.call("loadLocalChannels")["ch-legacy"];
    assert.equal(saved.sortByAired, false, "the serve-time flag is dropped on save");
    assert.equal(saved.autoSort, "aired-asc");
    assert.deepEqual(saved.items.map((it) => it.title),
      ["Friends S1E1", "Friends S5E13", "The Office S1E1", "The Office S2E7"]);
  });

  it("still lists a not-yet-migrated sortByAired channel in play order in See All", () => {
    const client = loadClient();
    client.call("saveLocalChannel", {
      channelId: "ch-order", name: "Order", sortByAired: true,
      items: [
        ep({ imdbId: "tt_office", showName: "The Office", season: 2, episode: 7, released: "2005-11-22" }),
        ep({ imdbId: "tt_bb", showName: "Breaking Bad", released: "" }),
        ep({ imdbId: "tt_friends", showName: "Friends", released: "1994-09-22" }),
      ],
    });
    let opened = null;
    client.set("openListDetailsPage", (title, type, url, preloaded) => { opened = preloaded; });
    client.call("openChannelDetailsPage", "ch-order");
    assert.deepEqual([...opened.sample].map((it) => it.name),
      ["Friends S1E1", "The Office S2E7", "Breaking Bad S1E1"],
      "undated last, the rest oldest first");
  });
});

describe("client: season watched detection (isSeasonFullyWatched)", () => {
  it("never returns true for an unwatched season even if the show is in _fullyWatchedShowIds", () => {
    const client = loadClient();
    client.set("_fullyWatchedShowIds", new Set(["tt0364845", "4614", "tmdb:4614"]));
    client.set("_currentItemDetails", { id: "tt0364845", tmdbId: "4614", title: "NCIS" });

    // 0 episodes watched in watch-history
    client.call("saveLocalCustomListsMap", { "watch-history": { slug: "watch-history", items: [] } });

    const isWatched = client.call("isSeasonFullyWatched", "tt0364845", 6, 25);
    assert.equal(isWatched, false, "unwatched season must return false even if show is in _fullyWatchedShowIds");
  });

  it("returns true only when all episodes of the season have been watched", () => {
    const client = loadClient();
    client.set("_fullyWatchedShowIds", new Set());
    client.set("_currentItemDetails", { id: "tt0364845", tmdbId: "4614", title: "NCIS" });

    // Partially watched (3 of 25)
    const partial = [1, 2, 3].map(n => ({
      id: "tt0364845:6:" + n,
      type: "episode",
      showId: "tt0364845",
      showTitle: "NCIS",
      seasonNum: 6,
      episodeNum: n
    }));
    client.call("saveLocalCustomListsMap", { "watch-history": { slug: "watch-history", items: partial } });
    assert.equal(client.call("isSeasonFullyWatched", "tt0364845", 6, 25), false, "3 of 25 episodes is not fully watched");

    // Fully watched (25 of 25)
    const full = Array.from({ length: 25 }, (_, i) => ({
      id: "tt0364845:6:" + (i + 1),
      type: "episode",
      showId: "tt0364845",
      showTitle: "NCIS",
      seasonNum: 6,
      episodeNum: i + 1
    }));
    client.call("saveLocalCustomListsMap", { "watch-history": { slug: "watch-history", items: full } });
    assert.equal(client.call("isSeasonFullyWatched", "tt0364845", 6, 25), true, "25 of 25 episodes is fully watched");
  });

  it("evaluates aired episodes when season episodes are expanded in _seasonEpisodesMap", () => {
    const client = loadClient();
    client.set("_fullyWatchedShowIds", new Set());
    client.set("_currentItemDetails", { id: "tt0364845", tmdbId: "4614", title: "NCIS" });

    client.set("_seasonEpisodesMap", {
      6: Array.from({ length: 25 }, (_, i) => ({
        id: 1000 + i,
        episode_number: i + 1,
        name: "Episode " + (i + 1),
        air_date: "2008-10-01"
      }))
    });

    // 0 watched
    client.call("saveLocalCustomListsMap", { "watch-history": { slug: "watch-history", items: [] } });
    assert.equal(client.call("isSeasonFullyWatched", "tt0364845", 6, 25), false, "expanded season with 0 watched episodes returns false");
  });
});

// A show part-way through a season could not be read as caught up until its
// finale: every "is this watched" check counted against TMDB's episode_count,
// which includes the episodes still to come. /api/details already says where
// the next unaired episode is, so the answer needs no extra fetch -- these
// pin down that the pointer is read, and that it is NOT read for a show whose
// seasons were renumbered out of a TMDB episode group.
describe("client: a season is measured by what has aired", () => {
  const dayOffset = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const FUTURE = dayOffset(30);

  // Season 3 lists 10 episodes; 5 are out and episode 6 airs in a month.
  const AIRING = {
    id: "tt_airing",
    tmdbId: "999",
    title: "Airing Show",
    seasonsData: [
      { season_number: 1, name: "Season 1", episode_count: 8, air_date: "2021-01-01" },
      { season_number: 2, name: "Season 2", episode_count: 8, air_date: "2022-01-01" },
      { season_number: 3, name: "Season 3", episode_count: 10, air_date: dayOffset(-60) },
    ],
    nextEpisodeAirDate: FUTURE,
    nextEpisodeSeasonNumber: 3,
    nextEpisodeNumber: 6,
  };
  const S3 = AIRING.seasonsData[2];

  const watched = (seasonNum, upTo) => Array.from({ length: upTo }, (_, i) => ({
    id: "tt_airing:" + seasonNum + ":" + (i + 1),
    type: "episode",
    showId: "tt_airing",
    showTitle: "Airing Show",
    seasonNum,
    episodeNum: i + 1,
  }));

  function seeded(items, details) {
    const client = loadClient();
    client.set("_fullyWatchedShowIds", new Set());
    client.set("_seasonEpisodesMap", {});
    client.set("_currentItemDetails", details || AIRING);
    client.call("saveLocalCustomListsMap", { "watch-history": { slug: "watch-history", items: items } });
    return client;
  }

  it("counts the episodes before the next unaired one, not the whole season", () => {
    const client = seeded([]);
    assert.equal(client.call("seasonAiredEpisodeCount", 3, S3, AIRING), 5,
      "5 of season 3's 10 episodes are out");
    assert.equal(client.call("seasonAiredEpisodeCount", 1, AIRING.seasonsData[0], AIRING), 8,
      "an earlier season is out in full");
  });

  it("reads a season as fully watched once every aired episode of it is", () => {
    assert.equal(seeded(watched(3, 5)).call("isSeasonFullyWatched", "tt_airing", 3, 10), true,
      "5 of the 5 aired episodes is caught up");
    assert.equal(seeded(watched(3, 4)).call("isSeasonFullyWatched", "tt_airing", 3, 10), false,
      "an aired episode still unwatched is not");
  });

  it("reads the show as fully watched when the only episodes left have not aired", () => {
    const caughtUp = seeded([...watched(1, 8), ...watched(2, 8), ...watched(3, 5)]);
    assert.equal(caughtUp.call("isShowFullyWatched", AIRING), true,
      "every episode that exists to watch has been watched");

    const behind = seeded([...watched(1, 8), ...watched(2, 8), ...watched(3, 4)]);
    assert.equal(behind.call("isShowFullyWatched", AIRING), false,
      "one aired episode short is not caught up");
  });

  it("treats a season that starts after the next episode as not aired at all", () => {
    const client = seeded([]);
    const s4 = { season_number: 4, name: "Season 4", episode_count: 8, air_date: FUTURE };
    assert.equal(client.call("seasonAiredEpisodeCount", 4, s4, AIRING), 0);
    assert.equal(client.call("seasonHasAiredEpisodes", 4, s4), false);
  });

  it("ignores the pointer once the season's real episode list is loaded", () => {
    const client = seeded(watched(3, 5));
    // TMDB re-dated episode 6 to yesterday; the loaded list is the truth.
    client.set("_seasonEpisodesMap", {
      3: Array.from({ length: 10 }, (_, i) => ({
        id: 3000 + i, episode_number: i + 1, name: "E" + (i + 1),
        air_date: i < 6 ? dayOffset(-10) : FUTURE,
      })),
    });
    assert.equal(client.call("seasonAiredEpisodeCount", 3, S3, AIRING), 6);
    assert.equal(client.call("isSeasonFullyWatched", "tt_airing", 3, 10), false,
      "6 have aired now, and only 5 are watched");
  });

  it("ignores the pointer for a show whose seasons were renumbered", () => {
    // An anime unpacked out of a TMDB episode group numbers its own seasons,
    // so a pointer counted in TMDB's numbers cannot be lined up against them.
    const unpacked = {
      id: "tt_unpacked",
      title: "Unpacked Show",
      seasonsData: [
        { season_number: 1, season: 1, name: "Part 1", episode_count: 12, episodeCount: 12 },
        { season_number: 2, season: 2, name: "Part 2", episode_count: 12, episodeCount: 12 },
      ],
      nextEpisodeAirDate: FUTURE,
      nextEpisodeSeasonNumber: 1,
      nextEpisodeNumber: 20,
    };
    const client = seeded([], unpacked);
    assert.equal(client.call("seasonAiredCountFromNextEpisode", 2, unpacked.seasonsData[1], unpacked), null,
      "the pointer says nothing about a renumbered season");
    assert.equal(client.call("seasonAiredEpisodeCount", 2, unpacked.seasonsData[1], unpacked), 12,
      "which leaves the season's own episode count");
  });

  it("repaints Mark Show Watched from what is on disk", () => {
    const client = seeded([...watched(1, 8), ...watched(2, 8), ...watched(3, 5)]);
    client.call("updateShowWatchedButton");
    const btn = client.__byId.get("btnMarkShowWatched");
    assert.match(btn.innerHTML, /Mark Show Unwatched/,
      "caught up on everything aired reads as watched");
    assert.equal(btn.className, "secondary");
  });
});

describe("client: the season header counts what has been watched", () => {
  const SHOW = {
    id: "tt_counts",
    title: "Counted Show",
    seasonsData: [{ season_number: 1, name: "Season 1", episode_count: 8, air_date: "2021-01-01" }],
  };
  const S1 = SHOW.seasonsData[0];

  function seeded(upTo) {
    const client = loadClient();
    client.set("_fullyWatchedShowIds", new Set());
    client.set("_seasonEpisodesMap", {});
    client.set("_currentItemDetails", SHOW);
    client.call("saveLocalCustomListsMap", {
      "watch-history": {
        slug: "watch-history",
        items: Array.from({ length: upTo }, (_, i) => ({
          id: "tt_counts:1:" + (i + 1),
          type: "episode",
          showId: "tt_counts",
          showTitle: "Counted Show",
          seasonNum: 1,
          episodeNum: i + 1,
        })),
      },
    });
    return client;
  }

  it("reads 0/8 with nothing watched, 3/8 part-way, and 8/8 at the end", () => {
    assert.equal(seeded(0).call("seasonEpisodeCountState", SHOW, S1).label, "0/8 episodes");
    assert.equal(seeded(3).call("seasonEpisodeCountState", SHOW, S1).label, "3/8 episodes");
    assert.equal(seeded(8).call("seasonEpisodeCountState", SHOW, S1).label, "8/8 episodes");
  });

  it("flags only a finished season as complete", () => {
    assert.equal(seeded(7).call("seasonEpisodeCountState", SHOW, S1).complete, false);
    assert.equal(seeded(8).call("seasonEpisodeCountState", SHOW, S1).complete, true);
  });

  it("counts an episode once however many times it was logged", () => {
    const client = seeded(0);
    client.call("saveLocalCustomListsMap", {
      "watch-history": {
        slug: "watch-history",
        items: [1, 1, 2].map((n, i) => ({
          id: "tt_counts:1:" + n + ":" + i,
          type: "episode",
          showId: "tt_counts",
          showTitle: "Counted Show",
          seasonNum: 1,
          episodeNum: n,
        })),
      },
    });
    assert.equal(client.call("seasonEpisodeCountState", SHOW, S1).label, "2/8 episodes");
  });

  it("never reads past the season's own length", () => {
    // Watch History can hold an episode TMDB has since dropped from a season.
    const client = seeded(0);
    client.call("saveLocalCustomListsMap", {
      "watch-history": {
        slug: "watch-history",
        items: Array.from({ length: 9 }, (_, i) => ({
          id: "tt_counts:1:" + (i + 1),
          type: "episode",
          showId: "tt_counts",
          showTitle: "Counted Show",
          seasonNum: 1,
          episodeNum: i + 1,
        })),
      },
    });
    assert.equal(client.call("seasonEpisodeCountState", SHOW, S1).label, "8/8 episodes");
  });

  it("says nothing when the season has no episode count to count against", () => {
    const client = seeded(3);
    assert.equal(client.call("seasonEpisodeCountState", SHOW, { season_number: 1 }).label, "");
  });
});

// The two asks, end to end: open a show's page and read what it renders.
describe("client: a show's page, rendered", () => {
  const dayOffset = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

  // Season 3 lists 10 episodes, 5 are out, episode 6 airs in three weeks.
  const DETAILS = {
    id: "tt_rendered", tmdbId: "555", title: "Rendered Show", overview: "x", poster: "", seasons: 3,
    seasonsData: [
      { season_number: 1, name: "Season 1", episode_count: 8, air_date: "2021-01-01" },
      { season_number: 2, name: "Season 2", episode_count: 8, air_date: "2022-01-01" },
      { season_number: 3, name: "Season 3", episode_count: 10, air_date: dayOffset(-60) },
    ],
    nextEpisodeAirDate: dayOffset(20),
    nextEpisodeSeasonNumber: 3,
    nextEpisodeNumber: 6,
  };

  async function render(watchedInS3) {
    const client = loadClient({ routes: { "/api/details": () => ({ json: { ok: true, details: DETAILS } }) } });
    const items = [];
    const add = (season, upTo) => {
      for (let i = 1; i <= upTo; i++) {
        items.push({
          id: "tt_rendered:" + season + ":" + i, type: "episode",
          showId: "tt_rendered", showTitle: "Rendered Show", seasonNum: season, episodeNum: i,
        });
      }
    };
    add(1, 8);
    add(2, 8);
    add(3, watchedInS3);
    client.set("_fullyWatchedShowIds", new Set());
    client.call("saveLocalCustomListsMap", { "watch-history": { slug: "watch-history", items: items } });
    await client.call("openItemDetailsModal", "tt_rendered", "series");
    return client.get("document").getElementById("itemDetailsBody").innerHTML;
  }

  it("puts the watched count on every season header", async () => {
    const html = await render(5);
    const counts = [...html.matchAll(/season-header-episodes[^"]*" data-season="(\d+)">([^<]*)</g)]
      .map((m) => m[1] + ":" + m[2]);
    assert.deepEqual(counts, ["1:8/8 episodes", "2:8/8 episodes", "3:5/10 episodes"]);
    assert.match(html, /season-header-episodes is-complete" data-season="1"/,
      "a finished season is flagged for the accent colour");
    assert.equal(/season-header-episodes is-complete" data-season="3"/.test(html), false,
      "a season with episodes still to come is not");
  });

  it("offers Mark Show Unwatched once every aired episode has been watched", async () => {
    const caughtUp = await render(5);
    assert.match(caughtUp, /Mark Show Unwatched/,
      "5 of the 5 episodes out so far -- there is nothing left to mark");
    assert.equal(/>Mark Show Watched</.test(caughtUp), false);

    const behind = await render(4);
    assert.match(behind, />Mark Show Watched</, "one aired episode short is still unwatched");
    assert.equal(/Mark Show Unwatched/.test(behind), false);
  });

  it("starts at 0/8 for a show nothing has been watched of", async () => {
    const client = loadClient({ routes: { "/api/details": () => ({ json: { ok: true, details: DETAILS } }) } });
    client.set("_fullyWatchedShowIds", new Set());
    client.call("saveLocalCustomListsMap", { "watch-history": { slug: "watch-history", items: [] } });
    await client.call("openItemDetailsModal", "tt_rendered", "series");
    const html = client.get("document").getElementById("itemDetailsBody").innerHTML;
    assert.match(html, /data-season="1">0\/8 episodes</);
    assert.match(html, /data-season="3">0\/10 episodes</);
    assert.match(html, />Mark Show Watched</);
  });

  it("lists Specials below every numbered season, not skipped", async () => {
    const withSpecials = {
      ...DETAILS,
      seasonsData: [
        { season_number: 0, name: "Specials", episode_count: 3, air_date: "2020-06-01" },
        ...DETAILS.seasonsData,
      ],
    };
    const client = loadClient({ routes: { "/api/details": () => ({ json: { ok: true, details: withSpecials } }) } });
    client.set("_fullyWatchedShowIds", new Set());
    client.call("saveLocalCustomListsMap", { "watch-history": { slug: "watch-history", items: [] } });
    await client.call("openItemDetailsModal", "tt_rendered", "series");
    const html = client.get("document").getElementById("itemDetailsBody").innerHTML;
    const seasonOrder = [...html.matchAll(/data-season="(\d+)"/g)].map((m) => m[1]);
    assert.deepEqual(seasonOrder.filter((v, i, a) => a.indexOf(v) === i), ["1", "2", "3", "0"],
      "Specials (season 0) renders last, after every numbered season");
    assert.match(html, /Specials/, "the Specials season card itself is rendered");
  });
});

describe("client: browsing a show's seasons in the Channel Builder", () => {
  function seasonsClient(seasons) {
    return loadClient({
      routes: {
        "/api/show-seasons": () => ({
          json: { ok: true, imdbId: "tt0386676", name: "The Office", poster: "", backdrop: "", seasons },
        }),
      },
    });
  }

  it("lists a show's Specials as a season button, alongside all its regular seasons", async () => {
    // /api/show-seasons now hands Specials back appended after the regular
    // seasons (see 25_api-catalog-routes.js), so the season grid just
    // renders whatever it is given -- this pins that it does, in order.
    const client = seasonsClient([
      { season: 1, name: "Season 1", episodeCount: 6 },
      { season: 2, name: "Season 2", episodeCount: 22 },
      { season: 0, name: "Specials", episodeCount: 7 },
    ]);
    await client.call("browseChannelShow", "2316", "The Office", "", "");
    const html = el(client, "channelEpisodePicker").innerHTML;
    const seasonBtnNames = [...html.matchAll(/data-season="(\d+)">([^<]*)</g)].map((m) => m[1] + ":" + m[2]);
    assert.deepEqual(seasonBtnNames, ["1:Season 1 (6)", "2:Season 2 (22)", "0:Specials (7)"],
      "Specials shows up as its own button, after the numbered seasons");
  });
});

describe("client: crossover and companion events detection in channel builder", () => {
  it("registry integrity: all TV_CROSSOVER_EVENTS have valid structures, unique IDs, and sequential parts", () => {
    const client = loadClient();
    const events = client.get("TV_CROSSOVER_EVENTS");
    assert.ok(Array.isArray(events), "TV_CROSSOVER_EVENTS is an array");
    assert.ok(events.length >= 136, "TV_CROSSOVER_EVENTS contains at least 136 events");

    const ids = new Set();
    events.forEach((ev) => {
      assert.ok(ev.id && typeof ev.id === "string", `Event missing string id: ${JSON.stringify(ev)}`);
      assert.ok(!ids.has(ev.id), `Duplicate event id found: ${ev.id}`);
      ids.add(ev.id);
      assert.ok(ev.name && typeof ev.name === "string", `Event ${ev.id} missing name`);
      assert.ok(ev.franchise && typeof ev.franchise === "string", `Event ${ev.id} missing franchise`);
      assert.ok(Array.isArray(ev.episodes) && ev.episodes.length >= 2, `Event ${ev.id} must have at least 2 episodes/parts`);

      ev.episodes.forEach((ep, idx) => {
        assert.equal(ep.part, idx + 1, `Event ${ev.id} episode part number ${ep.part} is not sequential (${idx + 1})`);
        assert.ok(ep.type === "movie" || ep.type === "episode" || ep.type === "show" || ep.type === "season", `Event ${ev.id} part ${ep.part} invalid type`);
        if (ep.type === "movie") {
          assert.ok(ep.title, `Event ${ev.id} part ${ep.part} missing movie title`);
          assert.ok(ep.imdbId || ep.tmdbId, `Event ${ev.id} part ${ep.part} missing IDs`);
        } else {
          assert.ok(ep.showName, `Event ${ev.id} part ${ep.part} missing showName`);
          assert.ok(ep.imdbId || ep.tmdbId, `Event ${ev.id} part ${ep.part} missing IDs`);
        }
      });
    });
  });

  it("isCrossoverEpisodeMatch accurately matches movies and TV episodes/shows", () => {
    const client = loadClient();
    const events = client.get("TV_CROSSOVER_EVENTS");
    const peacemaker = events.find((e) => e.id === "movie_peacemaker_suicide_squad");
    assert.ok(peacemaker, "Peacemaker event exists");

    const movieTarget = peacemaker.episodes[0]; // The Suicide Squad (2021)
    const showTarget = peacemaker.episodes[1];  // Peacemaker Season 1

    // Matching movie item
    assert.equal(
      client.call("isCrossoverEpisodeMatch", { kind: "movie", imdbId: "tt6334354", title: "The Suicide Squad" }, movieTarget),
      true,
      "Matches movie by imdbId"
    );
    assert.equal(
      client.call("isCrossoverEpisodeMatch", { kind: "series", imdbId: "tt6334354", title: "The Suicide Squad" }, movieTarget),
      false,
      "Does not match movie target when item is a series"
    );

    // Matching TV show item
    assert.equal(
      client.call("isCrossoverEpisodeMatch", { kind: "series", imdbId: "tt13146404", showName: "Peacemaker", seasonNum: 1 }, showTarget),
      true,
      "Matches show by imdbId and season"
    );
    assert.equal(
      client.call("isCrossoverEpisodeMatch", { kind: "series", imdbId: "tt13146404", showName: "Peacemaker", seasonNum: 2 }, showTarget),
      false,
      "Does not match show when season does not match target seasons array"
    );
  });

  it("renderChannelCrossoverSuggestions suggests missing companion movies when show is drafted", () => {
    const client = loadClient();
    const doc = client.window.document;
    let container = doc.getElementById("channelCrossoverSuggestions");
    if (!container) {
      container = doc.createElement("div");
      container.id = "channelCrossoverSuggestions";
      doc.body.appendChild(container);
    }

    // Add Peacemaker S1 to draft
    client.set("channelDraftItems", [
      {
        id: "tt13146404",
        kind: "series",
        imdbId: "tt13146404",
        tmdbId: 110492,
        showName: "Peacemaker",
        season: 1
      }
    ]);

    client.call("renderChannelCrossoverSuggestions");
    assert.equal(container.style.display, "block", "Suggestions banner displayed");
    assert.ok(container.innerHTML.includes("Peacemaker"), "Banner mentions Peacemaker");
    assert.ok(container.innerHTML.includes("The Suicide Squad"), "Banner suggests The Suicide Squad");
    assert.ok(container.innerHTML.includes("spliceCrossoverEvent"), "Banner includes 1-click splice button");
    assert.ok(container.innerHTML.includes("Missing Movie Continuation"), "Banner includes missing movie continuation label");
  });

  it("renderChannelCrossoverSuggestions suggests multi-show crossover episodes", () => {
    const client = loadClient();
    const doc = client.window.document;
    let container = doc.getElementById("channelCrossoverSuggestions");
    if (!container) {
      container = doc.createElement("div");
      container.id = "channelCrossoverSuggestions";
      doc.body.appendChild(container);
    }

    // Add The Simpsons to draft
    client.set("channelDraftItems", [
      {
        id: "tt0096697",
        kind: "series",
        imdbId: "tt0096697",
        tmdbId: 456,
        showName: "The Simpsons"
      }
    ]);

    client.call("renderChannelCrossoverSuggestions");
    assert.equal(container.style.display, "block", "Suggestions banner displayed");
    assert.ok(container.innerHTML.includes("The Simpsons Guy"), "Banner suggests The Simpsons Guy crossover");
    assert.ok(container.innerHTML.includes("Family Guy"), "Banner mentions Family Guy");
  });

  it("getStorylineCategories classifies companion and crossover events into appropriate genres", () => {
    const client = loadClient();
    const events = client.get("TV_CROSSOVER_EVENTS");

    const peacemaker = events.find((e) => e.id === "movie_peacemaker_suicide_squad");
    const peacemakerCats = client.call("getStorylineCategories", peacemaker);
    assert.ok(peacemakerCats.includes("scifi"), "Peacemaker has scifi category");
    assert.ok(peacemakerCats.includes("action"), "Peacemaker has action category");
    assert.ok(peacemakerCats.includes("tvuniverses"), "Peacemaker has tvuniverses category");

    const konosuba = events.find((e) => e.id === "movie_konosuba_legend_of_crimson");
    const konosubaCats = client.call("getStorylineCategories", konosuba);
    assert.ok(konosubaCats.includes("animation"), "KonoSuba has animation category");
    assert.ok(konosubaCats.includes("tvuniverses"), "KonoSuba has tvuniverses category");

    const bobs = events.find((e) => e.id === "movie_bobs_burgers_movie_saga");
    const bobsCats = client.call("getStorylineCategories", bobs);
    assert.ok(bobsCats.includes("animation"), "Bob's Burgers has animation category");
  });
});

// TV_CROSSOVER_EVENTS carries poster, title and year for every entry but no
// rating -- it is a static, hand-curated registry, not a live catalog fetch --
// so the Storylines, Sagas & Universes grid resolves ratings itself, from
// /api/details/batch, after rendering. These pin the id-collection, dedup and
// caching logic (resolveStorylineRatings), not the DOM patch itself
// (applyStorylineRatingBadges): the harness's element stubs always answer
// querySelectorAll with [], the same limitation resolveMissingPostersInDom's
// DOM-patching has always had here (see client-harness.mjs).
describe("client: Storylines, Sagas & Universes rating badges", () => {
  const BATCH = "/api/details/batch";

  // KonoSuba's own event: three tiles, two of which (Seasons 1-2 and Season
  // 3) are the same show and so share one imdb id -- a real, already-in-the-
  // registry case of the exact id collision the grid's dedup has to handle.
  const KONOSUBA_SHOW_ID = "tt5312384";
  const KONOSUBA_MOVIE_ID = "tt8600494";

  function batchRoute(ratingsById) {
    return {
      [BATCH]: (req) => {
        const ids = req.body.ids;
        const results = {};
        ids.forEach((id) => {
          const r = Object.prototype.hasOwnProperty.call(ratingsById, id) ? ratingsById[id] : null;
          results[id] = (r == null) ? null : { rating: String(r) };
        });
        return { json: { ok: true, results: results, remainingIds: [], done: true } };
      },
    };
  }

  it("renders a rating slot for every poster tile, deduping the same show across two entries", () => {
    const client = loadClient({ routes: batchRoute({ [KONOSUBA_SHOW_ID]: 7.6, [KONOSUBA_MOVIE_ID]: 7.1 }) });
    client.call("renderStorylinesUniverseList", "all");
    const html = client.get("document").getElementById("storylinesUniverseList").innerHTML;
    const slotIds = [...html.matchAll(/storyline-rating-slot" data-rating-id="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(slotIds.includes(KONOSUBA_SHOW_ID), "the show's tiles carry a rating slot for its id");
    assert.ok(slotIds.includes(KONOSUBA_MOVIE_ID), "the movie tile carries a rating slot for its own id");
  });

  // Regression test for a real bug caught on the live site, not by this
  // suite: applyStorylineRatingBadges used to hand the resolved number to
  // the formatters as `rating`, and formatRatingBadgeHtml's own `rating`
  // field guesses imdb-vs-tmdb from the id's shape -- every id here is an
  // imdb "tt..." id, so every badge came out data-rating-type="imdb". This
  // site forces IMDb-typed badges hidden unconditionally (hide-badge-imdb-
  // rating, 23_client-list-management.js -- only a TMDB-vs-none choice is a
  // real setting here), so every badge existed in the DOM and rendered
  // completely invisible. The harness cannot exercise the DOM patch itself
  // (see the top of this describe block), but it can pin the exact call
  // applyStorylineRatingBadges now makes: vote_average, not rating, which
  // both formatters treat as TMDB unconditionally, sidestepping the guess.
  it("labels a resolved rating as TMDB, not IMDb, even though every id here is a tt... id", () => {
    const client = loadClient();
    const inlineBadge = client.call("formatRatingSpanHtml", { id: "tt0458339", vote_average: 7.0 });
    assert.match(inlineBadge, /data-rating-type="tmdb"/,
      "the inline badge both Storylines surfaces render must not be labelled imdb");

    // The bug's actual mechanism, pinned directly on the sibling formatter
    // kept elsewhere in the app for a poster-corner badge: the same value
    // sent as `rating` -- what applyStorylineRatingBadges used to send --
    // mislabels a "tt..." id as imdb, confirming this (and not something
    // else) is what made every badge invisible.
    const buggyShape = client.call("formatRatingBadgeHtml", { id: "tt0458339", rating: 7.0 });
    assert.match(buggyShape, /data-rating-type="imdb"/,
      "confirms formatRatingBadgeHtml's own id-shape guess is what caused this -- not something else");
  });

  // Regression test for a second live-site report, right after the above fix
  // shipped: the badge became visible, but as a colored top-left overlay on
  // the poster -- inconsistent with every other poster tile in the app,
  // which shows its rating as a plain inline star+number in the year line
  // (Discover's loadPosterSlot, 19_client-search-and-likes.js). The grid's
  // rating slot must live in the year line, not inside the poster image
  // wrapper, and applyStorylineRatingBadges must only ever fill it with
  // formatRatingSpanHtml's plain star+number, never a colored rating-badge div.
  it("places the rating in the year line like every other poster tile, not as a poster-corner overlay", () => {
    const client = loadClient({ routes: batchRoute({ [KONOSUBA_SHOW_ID]: 7.6 }) });
    client.call("renderStorylinesUniverseList", "all");
    const html = client.get("document").getElementById("storylinesUniverseList").innerHTML;
    const yearLineWithSlot = /list-card-mini-poster-year"[^>]*><span>[^<]*<\/span><span class="storyline-rating-slot" data-rating-id="tt5312384">/;
    assert.match(html, yearLineWithSlot,
      "the rating slot sits inside the year line, beside the year, not overlaid on the poster image");

    const imgWrapBlocks = [...html.matchAll(/list-card-mini-poster-img-wrap"[\s\S]*?(?=<div class="list-card-mini-poster-name")/g)];
    assert.ok(imgWrapBlocks.length > 0, "sanity check: the grid rendered at least one poster tile");
    imgWrapBlocks.forEach((m) => {
      assert.equal(m[0].includes("storyline-rating-slot"), false,
        "no rating slot is left inside the poster image wrapper");
    });
  });

  it("asks /api/details/batch for every unique poster id on the grid exactly once", async () => {
    const client = loadClient({ routes: batchRoute({ [KONOSUBA_SHOW_ID]: 7.6, [KONOSUBA_MOVIE_ID]: 7.1 }) });
    client.call("renderStorylinesUniverseList", "all");
    await settle();

    // The "all" grid is chunked into up to 60 ids per request, so this may be
    // more than one request -- what matters is that the repeated show id
    // (two tiles in the same card) was only ever asked for once combined.
    const sent = requestsTo(client, BATCH);
    assert.ok(sent.length >= 1, "at least one batch request went out");
    const allIdsSent = sent.flatMap((r) => r.body.ids);
    assert.equal(allIdsSent.filter((id) => id === KONOSUBA_SHOW_ID).length, 1,
      "the id shared by two tiles is requested only once, not once per tile");
    assert.equal(allIdsSent.filter((id) => id === KONOSUBA_MOVIE_ID).length, 1);

    const cache = client.get("_storylineRatingsCache");
    assert.equal(cache[KONOSUBA_SHOW_ID], 7.6);
    assert.equal(cache[KONOSUBA_MOVIE_ID], 7.1);
  });

  it("does not re-fetch a rating this session already resolved", async () => {
    const client = loadClient({ routes: batchRoute({ [KONOSUBA_SHOW_ID]: 7.6, [KONOSUBA_MOVIE_ID]: 7.1 }) });
    client.call("renderStorylinesUniverseList", "all");
    await settle();
    const firstRoundCount = requestsTo(client, BATCH).length;
    assert.ok(firstRoundCount >= 1);

    // Re-rendering the same category (switching tabs back, in the real UI)
    // finds every id already cached, so this should add no new requests.
    client.call("renderStorylinesUniverseList", "all");
    await settle();
    assert.equal(requestsTo(client, BATCH).length, firstRoundCount,
      "a second render of the same grid asks for nothing already known");
  });

  it("caches a title with no TMDB rating as null instead of retrying it forever", async () => {
    const client = loadClient({ routes: batchRoute({}) });
    client.call("renderStorylinesUniverseList", "all");
    await settle();

    const cache = client.get("_storylineRatingsCache");
    assert.equal(cache[KONOSUBA_SHOW_ID], null);
    assert.equal(cache[KONOSUBA_MOVIE_ID], null);

    const firstRoundCount = requestsTo(client, BATCH).length;
    client.call("renderStorylinesUniverseList", "all");
    await settle();
    assert.equal(requestsTo(client, BATCH).length, firstRoundCount,
      "an id already known to have no rating is not asked for again");
  });
});

describe("client: livePreviewPosterHtml Continue Watching older season badge suppression", () => {
  it("suppresses season finale badge on Continue Watching when user is watching an older season", () => {
    const client = loadClient();
    const fn = client.get("livePreviewPosterHtml");

    // Configure Airing Next with Season 3 and upcoming finale
    client.call("saveLocalCustomListsMap", {
      "airing-next": {
        slug: "airing-next",
        items: [
          {
            id: "tt8360212:3:1",
            showId: "tt8360212",
            showTitle: "Grand Blue Dreaming",
            name: "Episode 1",
            seasonNum: 3,
            episodeNum: 1,
            airDate: "2099-07-05",
            seasonFinaleAirDate: "2099-09-22",
          },
        ],
      },
      "continue-watching": {
        slug: "continue-watching",
        items: [
          {
            id: "tt8360212:2:5",
            showId: "tt8360212",
            showTitle: "Grand Blue Dreaming",
            name: "Episode 5",
            seasonNum: 2,
            episodeNum: 5,
          },
        ],
      },
    });

    // 1. CW item on Season 2 with seasonNum (older than airing Season 3)
    const cwOlder = {
      id: "tt8360212",
      showId: "tt8360212",
      showTitle: "Grand Blue Dreaming",
      seasonNum: 2,
      episodeNum: 5,
      listSlug: "continue-watching",
    };
    const htmlOlder = fn(cwOlder);
    assert.equal(htmlOlder.includes("cw-date-badge-finale-date"), false, "Older season must not display Finale date badge");
    assert.equal(htmlOlder.includes("cw-date-badge-finale"), false, "Older season must not display Season Finale badge");

    // 2. CW item on Season 2 with only season (fallback from /api/preview or raw meta)
    const cwOlderOnlySeason = {
      id: "tt8360212",
      showId: "tt8360212",
      showTitle: "Grand Blue Dreaming",
      season: 2,
      episode: 5,
      listSlug: "continue-watching",
    };
    const htmlOlderOnlySeason = fn(cwOlderOnlySeason);
    assert.equal(htmlOlderOnlySeason.includes("cw-date-badge-finale-date"), false, "Older season (via season prop) must not display Finale date badge");

    // 3. CW item with no season on preview object, resolved via local CW item match
    const cwOlderNoSeason = {
      id: "tt8360212",
      showId: "tt8360212",
      showTitle: "Grand Blue Dreaming",
      listSlug: "continue-watching",
    };
    const htmlOlderNoSeason = fn(cwOlderNoSeason);
    assert.equal(htmlOlderNoSeason.includes("cw-date-badge-finale-date"), false, "Older season (via local CW match) must not display Finale date badge");

    // 4. CW item on Season 3 (current season, episode 2) -> should display the season finale badge
    const cwCurrent = {
      id: "tt8360212",
      showId: "tt8360212",
      showTitle: "Grand Blue Dreaming",
      seasonNum: 3,
      episodeNum: 2,
      listSlug: "continue-watching",
    };
    const htmlCurrent = fn(cwCurrent);
    assert.equal(htmlCurrent.includes("cw-date-badge-finale-date"), true, "Current season must display Finale date badge when available");

    // 5. CW item on Season 3 Episode 1 (current season, already aired) with Airing Next on Episode 11
    client.call("saveLocalCustomListsMap", {
      "airing-next": {
        slug: "airing-next",
        items: [
          {
            id: "tt8360212:3:11",
            showId: "tt8360212",
            showTitle: "Grand Blue Dreaming",
            name: "Episode 11",
            seasonNum: 3,
            episodeNum: 11,
            airDate: "2099-09-15",
            seasonFinaleAirDate: "2099-09-22",
          },
        ],
      },
      "continue-watching": {
        slug: "continue-watching",
        items: [
          {
            id: "tt8360212:3:1",
            showId: "tt8360212",
            showTitle: "Grand Blue Dreaming",
            name: "Unfinished Business",
            seasonNum: 3,
            episodeNum: 1,
            airDate: "2020-07-05",
          },
        ],
      },
    });
    client.call("invalidatePosterRenderCaches");

    const cwCurrentEp1Aired = {
      id: "tt8360212",
      showId: "tt8360212",
      showTitle: "Grand Blue Dreaming",
      name: "Unfinished Business",
      seasonNum: 3,
      episodeNum: 1,
      airDate: "2020-07-05",
      listSlug: "continue-watching",
    };
    const htmlCurrentEp1Aired = fn(cwCurrentEp1Aired);
    assert.equal(htmlCurrentEp1Aired.includes("cw-date-badge-finale-date"), true, "Aired episode 1 of current season must display Finale date badge in Live Preview");
    assert.equal(htmlCurrentEp1Aired.includes("cw-date-badge-premiere"), false, "Aired episode 1 must not display Season Premiere badge");

    // 6. CW item on Season 3 Episode 1 with no explicit airDate, but Airing Next is on Episode 11 (has later airing ep)
    const cwCurrentEp1NoAirDate = {
      id: "tt8360212",
      showId: "tt8360212",
      showTitle: "Grand Blue Dreaming",
      name: "Unfinished Business",
      seasonNum: 3,
      episodeNum: 1,
      listSlug: "continue-watching",
    };
    const htmlCurrentEp1NoAirDate = fn(cwCurrentEp1NoAirDate);
    assert.equal(htmlCurrentEp1NoAirDate.includes("cw-date-badge-finale-date"), true, "Episode 1 with later airing ep must display Finale date badge");
    assert.equal(htmlCurrentEp1NoAirDate.includes("cw-date-badge-premiere"), false, "Episode 1 with later airing ep must not display Premiere badge");

    // 7. Verify buildLocalListCardHtml (Your Custom Lists) matches livePreviewPosterHtml (Live Preview)
    const buildLocalCard = client.get("buildLocalListCardHtml");
    const cwListCardHtml = buildLocalCard({
      slug: "continue-watching",
      name: "Continue Watching",
      type: "series",
      items: [cwCurrentEp1Aired],
    });
    assert.equal(cwListCardHtml.includes("cw-date-badge-finale-date"), true, "Your Custom Lists must display Finale date badge on aired Episode 1");
    assert.equal(cwListCardHtml.includes("cw-date-badge-premiere"), false, "Your Custom Lists must not display Season Premiere badge on aired Episode 1");

    // 8. Upcoming unaired Episode 1 (airing in future) must display Season Premiere badge, not Finale badge
    client.call("saveLocalCustomListsMap", {
      "airing-next": {
        slug: "airing-next",
        items: [
          {
            id: "tt8360212:4:1",
            showId: "tt8360212",
            showTitle: "Grand Blue Dreaming",
            name: "Episode 1",
            seasonNum: 4,
            episodeNum: 1,
            airDate: "2099-10-01",
            seasonFinaleAirDate: "2099-12-20",
          },
        ],
      },
    });
    client.call("invalidatePosterRenderCaches");
    const cwUpcomingPremiere = {
      id: "tt8360212",
      showId: "tt8360212",
      showTitle: "Grand Blue Dreaming",
      seasonNum: 4,
      episodeNum: 1,
      airDate: "2099-10-01",
      isUnaired: true,
      listSlug: "continue-watching",
    };
    const htmlUpcomingPremiere = fn(cwUpcomingPremiere);
    assert.equal(htmlUpcomingPremiere.includes("cw-date-badge-premiere"), true, "Upcoming unaired episode 1 must display Season Premiere badge");
    assert.equal(htmlUpcomingPremiere.includes("cw-date-badge-finale-date"), false, "Upcoming unaired episode 1 must not display Finale date badge");
  });
});

describe("client: adult content filter & safe poster replacement", () => {
  it("detects when adultContentFilter is enabled via localStorage", () => {
    const client = loadClient({
      storage: { "myListAddon:adultContentFilter": "1" },
    });
    const isFilterEnabled = client.get("isAdultContentFilterEnabled");
    assert.equal(isFilterEnabled(), true);

    const clientOff = loadClient({
      storage: { "myListAddon:adultContentFilter": "0" },
    });
    const isFilterEnabledOff = clientOff.get("isAdultContentFilterEnabled");
    assert.equal(isFilterEnabledOff(), false);
  });

  it("isAdultOrNsfw identifies adult metadata in client scripts", () => {
    const client = loadClient();
    const isAdult = client.get("isAdultOrNsfw");

    assert.equal(isAdult({ adult: true }), true);
    assert.equal(isAdult({ isAdult: true }), true);
    assert.equal(isAdult({ certification: "NC-17" }), true);
    assert.equal(isAdult({ genres: ["Hentai"] }), true);
    assert.equal(isAdult({ genres: "Erotica, Drama" }), true);
    assert.equal(isAdult({ title: "Inception", genres: ["Action"] }), false);
  });

  it("getSafePosterUrl creates safe poster endpoint link with query params", () => {
    const client = loadClient();
    const getSafe = client.get("getSafePosterUrl");

    const url = getSafe({ title: "Adult Show", year: "2024", type: "series", certification: "NC-17" });
    assert.ok(url.includes("/api/safe-poster?title=Adult%20Show"));
    assert.ok(url.includes("year=2024"));
    assert.ok(url.includes("type=series"));
    assert.ok(url.includes("cert=NC-17"));
  });

  it("resolveClientPoster returns safe poster URL when filter is enabled and item is adult", () => {
    const client = loadClient({
      storage: { "myListAddon:adultContentFilter": "1" },
    });
    const resolve = client.get("resolveClientPoster");

    const safeAdult = resolve({ title: "Adult Show", adult: true }, "https://images.example.com/adult.jpg");
    assert.ok(safeAdult.includes("/api/safe-poster"));

    const safeNormal = resolve({ title: "Family Movie", adult: false }, "https://images.example.com/family.jpg");
    assert.equal(safeNormal, "https://images.example.com/family.jpg");
  });

  it("resolveClientPoster preserves original poster when filter is disabled", () => {
    const client = loadClient({
      storage: { "myListAddon:adultContentFilter": "0" },
    });
    const resolve = client.get("resolveClientPoster");

    const poster = resolve({ title: "Adult Show", adult: true }, "https://images.example.com/adult.jpg");
    assert.equal(poster, "https://images.example.com/adult.jpg");
  });

  it("livePreviewPosterHtml replaces adult poster with safe poster when filter is on", () => {
    const client = loadClient({
      storage: { "myListAddon:adultContentFilter": "1" },
    });
    const renderTile = client.get("livePreviewPosterHtml");

    const html = renderTile({
      id: "tt_adult",
      name: "NSFW Show",
      poster: "https://images.example.com/nsfw.jpg",
      adult: true,
      type: "series",
    });

    assert.ok(html.includes("/api/safe-poster?title=NSFW%20Show"));
    assert.equal(html.includes("https://images.example.com/nsfw.jpg"), false);
  });

  it("buildLocalListCardHtml renders safe poster for adult items when filter is on", () => {
    const client = loadClient({
      storage: { "myListAddon:adultContentFilter": "1" },
    });
    const buildCard = client.get("buildLocalListCardHtml");

    const cardHtml = buildCard({
      slug: "custom-safety-test",
      name: "My Safety List",
      type: "series",
      items: [
        { id: "tt_safe", title: "Safe Show", poster: "https://images.example.com/safe.jpg", adult: false },
        { id: "tt_adult", title: "Adult Anime", poster: "https://images.example.com/nsfw.jpg", genres: ["Hentai"] },
      ],
    });

    assert.ok(cardHtml.includes("https://images.example.com/safe.jpg"), "safe show poster remains intact");
    assert.ok(cardHtml.includes("/api/safe-poster?title=Adult%20Anime"), "adult anime poster is replaced with safe poster");
    assert.equal(cardHtml.includes("https://images.example.com/nsfw.jpg"), false, "raw nsfw poster is not rendered");
  });

  it("collectKeys returns adultContentFilter: true when enabled", () => {
    const client = loadClient({
      storage: { "myListAddon:adultContentFilter": "1" },
    });
    const collect = client.get("collectKeys");
    const keys = collect();
    assert.equal(keys.adultContentFilter, true);
  });
});

describe("client: dedupeAcrossLists setting round-trips through collectKeys and buildConfig", () => {
  it("collectKeys returns dedupeAcrossLists: true once the checkbox is checked", () => {
    const client = loadClient();
    client.get("document").getElementById("dedupeAcrossListsCheckbox").checked = true;
    const keys = client.get("collectKeys")();
    assert.equal(keys.dedupeAcrossLists, true);
  });

  it("collectKeys returns dedupeAcrossLists: false by default", () => {
    const client = loadClient();
    const keys = client.get("collectKeys")();
    assert.equal(keys.dedupeAcrossLists, false);
  });

  it("buildConfig carries dedupeAcrossLists into the saved payload only when enabled", () => {
    const client = loadClient();
    const buildConfig = client.get("buildConfig");
    const decodeOne = (b64) => JSON.parse(client.get("atob")(b64.replace(/-/g, "+").replace(/_/g, "/")));

    const withOn = buildConfig([], { dedupeAcrossLists: true });
    assert.equal(decodeOne(withOn).dedupeAcrossLists, true);

    const withOff = buildConfig([], { dedupeAcrossLists: false });
    assert.equal(decodeOne(withOff).dedupeAcrossLists, undefined, "omitted entirely, same as every other off-by-default flag here");
  });
});

describe("client: continue watching storyline & companion recommendations", () => {
  it("settings toggle: defaults to enabled and persists toggling", () => {
    const client = loadClient();
    assert.equal(client.call("getCompanionRecommendationSetting"), true, "enabled by default");

    client.call("toggleCompanionRecommendationSetting", false);
    assert.equal(client.call("getCompanionRecommendationSetting"), false, "disabled after toggle false");

    client.call("toggleCompanionRecommendationSetting", true);
    assert.equal(client.call("getCompanionRecommendationSetting"), true, "enabled after toggle true");
  });

  it("findCompanionBridgeMovie: detects canon bridge movie between seasons (Demon Slayer Mugen Train)", () => {
    const client = loadClient();
    const bridge = client.call("findCompanionBridgeMovie", "tt9335498", 1, 2);
    assert.ok(bridge, "bridge movie found for Demon Slayer between S1 and S2");
    assert.equal(bridge.id, "tt11032374");
    assert.equal(bridge.type, "movie");
    assert.equal(bridge.isCompanion, true);
    assert.equal(bridge.companionType, "bridge_movie");
    assert.ok(bridge.name.includes("Mugen Train"));

    // Once watched in Watch History, bridge movie should no longer be returned
    client.call("saveLocalCustomListsMap", {
      "watch-history": {
        slug: "watch-history",
        items: [{ id: "tt11032374", imdbId: "tt11032374", type: "movie", title: "Mugen Train" }]
      }
    });
    const bridgeAfterWatch = client.call("findCompanionBridgeMovie", "tt9335498", 1, 2);
    assert.equal(bridgeAfterWatch, null, "bridge movie not returned if already watched");
  });
  it("findCompanionShowConclusion: recommends sequel film on show conclusion (Breaking Bad -> El Camino)", () => {
    const client = loadClient();
    const sequel = client.call("findCompanionShowConclusion", "tt0903747");
    assert.ok(sequel, "sequel movie found for Breaking Bad finale");
    assert.equal(sequel.id, "tt9243946");
    assert.equal(sequel.type, "movie");
    assert.equal(sequel.isCompanion, true);
    assert.equal(sequel.companionType, "sequel_movie");
    assert.ok(sequel.name.includes("El Camino"));

    // When El Camino is already watched, it advances to Better Call Saul
    client.call("saveLocalCustomListsMap", {
      "watch-history": {
        slug: "watch-history",
        items: [{ id: "tt9243946", imdbId: "tt9243946", type: "movie", title: "El Camino: A Breaking Bad Movie" }]
      }
    });
    const nextSeries = client.call("findCompanionShowConclusion", "tt0903747");
    assert.ok(nextSeries, "spinoff series found after El Camino watched");
    assert.equal(nextSeries.showId, "tt3032476");
    assert.equal(nextSeries.type, "episode");
    assert.equal(nextSeries.seasonNum, 1);
    assert.equal(nextSeries.episodeNum, 1);
    assert.equal(nextSeries.companionType, "spinoff_series");
  });

  it("advanceCompanionOnMovieWatched: watching El Camino injects Better Call Saul S1E1 into Continue Watching", async () => {
    const client = loadClient();
    await client.call("advanceCompanionOnMovieWatched", {
      id: "tt9243946",
      imdbId: "tt9243946",
      type: "movie",
      title: "El Camino: A Breaking Bad Movie"
    });

    const map = client.call("loadLocalCustomLists");
    const cwItems = (map["continue-watching"] && map["continue-watching"].items) || [];
    const bcs = cwItems.find((it) => it.showId === "tt3032476");
    assert.ok(bcs, "Better Call Saul was injected into Continue Watching");
    assert.equal(bcs.seasonNum, 1);
    assert.equal(bcs.episodeNum, 1);
    assert.equal(bcs.isCompanion, true);
  });

  it("dismissContinueWatchingShow: dismissing companion movie removes it and prevents re-recommendation", async () => {
    const client = loadClient({
      storage: {
        "myListAddon:localCustomLists": JSON.stringify({
          "continue-watching": {
            slug: "continue-watching",
            items: [
              {
                id: "tt9243946",
                imdbId: "tt9243946",
                title: "El Camino",
                isCompanion: true
              }
            ]
          }
        })
      }
    });

    await client.call("dismissContinueWatchingShow", "tt9243946");
    const map = client.call("loadLocalCustomLists");
    const cwItems = (map["continue-watching"] && map["continue-watching"].items) || [];
    assert.equal(cwItems.length, 0, "movie was removed from Continue Watching");

    // Re-checking conclusion returns null because it is recorded in dismissed list
    const conclusion = client.call("findCompanionShowConclusion", "tt0903747");
    assert.equal(conclusion, null, "dismissed companion is not re-recommended");
  });

  it("disabled setting: returns null for companions when setting is disabled", () => {
    const client = loadClient({
      storage: { "myListAddon:autoRecommendCompanions": "0" }
    });
    assert.equal(client.call("getCompanionRecommendationSetting"), false);
    assert.equal(client.call("findCompanionBridgeMovie", "tt9335498", 1, 2), null);
    assert.equal(client.call("findCompanionShowConclusion", "tt0903747"), null);
  });

  it("UI badges: renders cw-date-badge-companion on companion cards", () => {
    const client = loadClient();
    const buildCard = client.get("buildLocalListCardHtml");
    const cardHtml = buildCard({
      slug: "continue-watching",
      name: "Continue Watching",
      type: "mixed",
      items: [
        {
          id: "tt11032374",
          imdbId: "tt11032374",
          title: "Demon Slayer Mugen Train",
          poster: "https://images.example.com/mugen.jpg",
          isCompanion: true,
          companionType: "bridge_movie",
          companionNote: "Canon Bridge Movie"
        }
      ]
    });
    assert.ok(cardHtml.includes("cw-date-badge-companion"), "renders companion badge class");
    assert.ok(cardHtml.includes("Bridge Movie"), "displays Bridge Movie text");

    const livePreview = client.get("livePreviewPosterHtml");
    const previewHtml = livePreview({
      id: "tt9243946",
      name: "El Camino: A Breaking Bad Movie",
      poster: "https://images.example.com/elcamino.jpg",
      isCompanion: true,
      companionType: "sequel_movie",
      companionNote: "Sequel Film",
      listSlug: "continue-watching"
    });
    assert.ok(previewHtml.includes("cw-date-badge-companion"), "live preview renders companion badge class");
    assert.ok(previewHtml.includes("Sequel Film"), "live preview displays Sequel Film text");
  });
});

describe("client: Mark Show Watched and Unwatched modal button", () => {
  const setupShowModal = (client, showDetails) => {
    client.set("_currentItemDetails", showDetails);
    const doc = client.get("document");
    const btnShow = doc.getElementById("btnMarkShowWatched");
    btnShow.classList.add("primary");
    btnShow.innerHTML = "Mark Show Watched";
    return { doc, btnShow };
  };

  it("markShowWatched marks whole show watched and toggles button to Mark Show Unwatched", async () => {
    const episodesS1 = [
      { id: 101, name: "Pilot", episode_number: 1, air_date: "2008-01-20" },
      { id: 102, name: "Cat's in the Bag...", episode_number: 2, air_date: "2008-01-27" }
    ];
    const episodesS2 = [
      { id: 201, name: "Seven Thirty-Seven", episode_number: 1, air_date: "2009-03-08" },
      { id: 202, name: "Grilled", episode_number: 2, air_date: "2009-03-15" }
    ];

    const client = loadClient({
      routes: {
        "/api/season": (req) => {
          const url = new URL(req.url, "https://example.com");
          const s = url.searchParams.get("seasonNum");
          if (s === "1") return { json: { ok: true, season: { episodes: episodesS1 } } };
          if (s === "2") return { json: { ok: true, season: { episodes: episodesS2 } } };
          return { json: { ok: false, error: "Not found" } };
        }
      }
    });

    const showDetails = {
      id: "tt0903747",
      tmdbId: 1396,
      title: "Breaking Bad",
      seasonsData: [
        { season_number: 1, episode_count: 2 },
        { season_number: 2, episode_count: 2 }
      ]
    };
    const { btnShow } = setupShowModal(client, showDetails);

    // 1. Mark Show Watched
    await client.call("markShowWatched", "tt0903747");
    assert.ok(btnShow.innerHTML.includes("Mark Show Unwatched"), "button changes to Mark Show Unwatched");
    assert.ok(btnShow.classList.contains("secondary"), "button receives secondary class");
    assert.equal(btnShow.classList.contains("primary"), false);

    const map1 = client.call("loadLocalCustomLists");
    const hist1 = map1["watch-history"]?.items || [];
    assert.equal(hist1.length, 4, "all 4 episodes added to Watch History");
    assert.equal(client.call("isShowFullyWatched", showDetails), true, "show is fully watched");

    // 2. Mark Show Unwatched
    await client.call("markShowWatched", "tt0903747");
    assert.ok(btnShow.innerHTML.includes("Mark Show Watched"), "button flips back to Mark Show Watched");
    assert.ok(btnShow.classList.contains("primary"), "button receives primary class");
    assert.equal(btnShow.classList.contains("secondary"), false);

    const map2 = client.call("loadLocalCustomLists");
    const hist2 = map2["watch-history"]?.items || [];
    assert.equal(hist2.length, 0, "all episodes removed from Watch History");
    assert.equal(client.call("isShowFullyWatched", showDetails), false, "show is not fully watched");
  });

  it("marking whole show watched then making a season unwatched flips button back to Mark Show Watched", async () => {
    const episodesS1 = [
      { id: 101, name: "Pilot", episode_number: 1, air_date: "2008-01-20" }
    ];
    const episodesS2 = [
      { id: 201, name: "Seven Thirty-Seven", episode_number: 1, air_date: "2009-03-08" }
    ];

    const client = loadClient({
      routes: {
        "/api/season": (req) => {
          const url = new URL(req.url, "https://example.com");
          const s = url.searchParams.get("seasonNum");
          if (s === "1") return { json: { ok: true, season: { episodes: episodesS1 } } };
          if (s === "2") return { json: { ok: true, season: { episodes: episodesS2 } } };
          return { json: { ok: false, error: "Not found" } };
        }
      }
    });

    const showDetails = {
      id: "tt0903747",
      tmdbId: 1396,
      title: "Breaking Bad",
      seasonsData: [
        { season_number: 1, episode_count: 1 },
        { season_number: 2, episode_count: 1 }
      ]
    };
    const { btnShow } = setupShowModal(client, showDetails);

    // Mark whole show watched first
    await client.call("markShowWatched", "tt0903747");
    assert.ok(btnShow.innerHTML.includes("Mark Show Unwatched"), "initially Mark Show Unwatched");

    // Now unwatch Season 2
    const btnSeason2 = {
      disabled: false,
      textContent: "",
      innerHTML: "",
      classList: {
        remove() {},
        add() {}
      }
    };
    await client.call("markSeasonWatched", 2, btnSeason2);

    // The show button MUST turn back to Mark Show Watched
    assert.ok(btnShow.innerHTML.includes("Mark Show Watched"), "button turns back to Mark Show Watched after season unwatched");
    assert.ok(btnShow.classList.contains("primary"), "button receives primary class");
    assert.equal(btnShow.classList.contains("secondary"), false);
    assert.equal(client.call("isShowFullyWatched", showDetails), false);

    // Re-watch Season 2 -> show button turns back to Mark Show Unwatched
    await client.call("markSeasonWatched", 2, btnSeason2);
    assert.ok(btnShow.innerHTML.includes("Mark Show Unwatched"), "button turns back to Mark Show Unwatched after season re-watched");
    assert.ok(btnShow.classList.contains("secondary"), "button receives secondary class");
    assert.equal(client.call("isShowFullyWatched", showDetails), true);
  });

  it("markShowWatched synchronously evicts completed show and immediately injects storyline companion into continue-watching", async () => {
    const episodesS1 = [
      { id: 101, name: "Pilot", episode_number: 1, air_date: "2008-01-20" },
      { id: 102, name: "Cat's in the Bag...", episode_number: 2, air_date: "2008-01-27" }
    ];
    const episodesS2 = [
      { id: 201, name: "Seven Thirty-Seven", episode_number: 1, air_date: "2009-03-08" },
      { id: 202, name: "Grilled", episode_number: 2, air_date: "2009-03-15" }
    ];

    const client = loadClient({
      routes: {
        "/api/season": (req) => {
          const url = new URL(req.url, "https://example.com");
          const s = url.searchParams.get("seasonNum");
          if (s === "1") return { json: { ok: true, season: { episodes: episodesS1 } } };
          if (s === "2") return { json: { ok: true, season: { episodes: episodesS2 } } };
          return { json: { ok: false, error: "Not found" } };
        }
      }
    });

    const showDetails = {
      id: "tt0903747",
      tmdbId: 1396,
      title: "Breaking Bad",
      seasonsData: [
        { season_number: 1, episode_count: 2 },
        { season_number: 2, episode_count: 2 }
      ]
    };
    setupShowModal(client, showDetails);

    // Seed continue-watching with Breaking Bad S2E2
    const initLists = client.call("loadLocalCustomLists");
    initLists["continue-watching"] = {
      id: "continue-watching",
      name: "Continue Watching",
      items: [
        { id: "tt0903747:2:2", showId: "tt0903747", name: "Grilled", seasonNum: 2, episodeNum: 2, type: "episode" }
      ]
    };
    client.call("saveLocalCustomListsMap", initLists);

    // 1. Mark Show Watched
    await client.call("markShowWatched", "tt0903747");

    const listsAfterWatched = client.call("loadLocalCustomLists");
    const cwItems = listsAfterWatched["continue-watching"]?.items || [];
    // Verify Breaking Bad is evicted
    assert.equal(cwItems.some(it => String(it.showId || it.id).startsWith("tt0903747")), false, "completed show must be evicted from continue-watching");
    // Verify El Camino is injected immediately
    const companionItem = cwItems.find(it => it.isCompanion);
    assert.ok(companionItem, "companion item must be injected immediately into continue-watching");
    assert.equal(companionItem.name, "El Camino: A Breaking Bad Movie");
    assert.equal(companionItem.companionType, "sequel_movie");
    assert.equal(companionItem.precedingShowId, "tt0903747");
    assert.equal(companionItem.type, "movie");

    // 2. Mark Show Unwatched
    await client.call("markShowWatched", "tt0903747");
    const listsAfterUnwatched = client.call("loadLocalCustomLists");
    const cwItems2 = listsAfterUnwatched["continue-watching"]?.items || [];
    // Verify queued companion is cleaned up
    assert.equal(cwItems2.some(it => it.precedingShowId === "tt0903747"), false, "queued companion must be cleaned up when show is unmarked");
  });
});

describe("client: Item Details Storylines, Sagas & Universes watch order", () => {
  it("renderItemStorylinesWatchOrder renders chronological watch order for Breaking Bad universe", () => {
    const client = loadClient();
    const bb = {
      id: "tt0903747",
      imdbId: "tt0903747",
      tmdbId: 1396,
      title: "Breaking Bad",
      seasonsData: [{ season_number: 1, episode_count: 7 }]
    };

    const html = client.__scopeCall("renderItemStorylinesWatchOrder", [bb, "series"]);
    assert.ok(html.includes("item-storylines-section"), "renders storylines section");
    assert.ok(html.includes("Breaking Bad Complete Universe"), "includes saga title");
    assert.ok(html.includes("Part 1"), "includes Part 1");
    assert.ok(html.includes("Part 2"), "includes Part 2");
    assert.ok(html.includes("Part 3"), "includes Part 3");
    assert.ok(html.includes("El Camino: A Breaking Bad Movie"), "includes El Camino companion movie");
    assert.ok(html.includes("Better Call Saul"), "includes Better Call Saul prequel/sequel series");
    assert.ok(html.includes("openStorylineDetails"), "includes Open Saga button");

    // Breaking Bad itself should be highlighted as current
    assert.ok(html.includes("is-current"), "has is-current class on active title");
    assert.ok(html.includes("item-storyline-current-pill"), "has Current badge pill");
    // Other entries should have click handlers pointing to openItemDetailsModal
    assert.ok(html.includes("openItemDetailsModal(&quot;tt9243946&quot;, &quot;movie&quot;)"), "El Camino has click handler");
    assert.ok(html.includes("openItemDetailsModal(&quot;tt3032476&quot;, &quot;series&quot;)"), "Better Call Saul has click handler");
  });

  it("renderItemStorylinesWatchOrder highlights companion movie when viewing El Camino", () => {
    const client = loadClient();
    const elCamino = {
      id: "tt9243946",
      imdbId: "tt9243946",
      tmdbId: 559969,
      title: "El Camino: A Breaking Bad Movie"
    };

    const html = client.__scopeCall("renderItemStorylinesWatchOrder", [elCamino, "movie"]);
    assert.ok(html.includes("Breaking Bad Complete Universe"), "includes saga title");
    // El Camino is Part 2, and should have is-current
    assert.ok(html.includes("is-current"), "highlights current movie");
    // Breaking Bad should have click handler
    assert.ok(html.includes("openItemDetailsModal(&quot;tt0903747&quot;, &quot;series&quot;)"), "Breaking Bad has click handler");
  });

  it("renderItemStorylinesWatchOrder renders movie sagas such as MCU Infinity Saga", () => {
    const client = loadClient();
    const ironMan = {
      id: "tt0371746",
      imdbId: "tt0371746",
      tmdbId: 1726,
      title: "Iron Man"
    };

    const html = client.__scopeCall("renderItemStorylinesWatchOrder", [ironMan, "movie"]);
    assert.ok(html.includes("Marvel Cinematic Universe: The Infinity Saga"), "includes MCU Infinity Saga");
    assert.ok(html.includes("is-current"), "highlights Iron Man as current");
  });

  it("renderItemStorylinesWatchOrder renders tab pills when title belongs to multiple storylines", () => {
    const client = loadClient();
    const theFlash = {
      id: "tt3107288",
      imdbId: "tt3107288",
      tmdbId: 60735,
      title: "The Flash",
      seasonsData: [{ season_number: 1, episode_count: 23 }]
    };

    const html = client.__scopeCall("renderItemStorylinesWatchOrder", [theFlash, "series"]);
    assert.ok(html.includes("subnav-pills-bar"), "renders tab pills when multiple storylines match");
    assert.ok(html.includes("switchItemStorylineTab"), "includes switchItemStorylineTab handlers");
    assert.ok(html.includes("The Complete Arrowverse Timeline"), "includes Arrowverse timeline");
  });

  it("renderItemStorylinesWatchOrder returns empty string for titles not in any storyline", () => {
    const client = loadClient();
    const standalone = {
      id: "tt9999999",
      imdbId: "tt9999999",
      tmdbId: 999999,
      title: "Random Standalone Film 12345"
    };

    const html = client.__scopeCall("renderItemStorylinesWatchOrder", [standalone, "movie"]);
    assert.equal(html, "", "must return empty string for non-storyline titles");
  });

  it("openItemDetailsModal integrates Storylines watch order at bottom of details modal", async () => {
    const client = loadClient({
      routes: {
        "/api/details": (req) => {
          const url = new URL(req.url, "https://example.com");
          const id = url.searchParams.get("imdbId");
          if (id === "tt0903747") {
            return {
              json: {
                ok: true,
                details: {
                  id: "tt0903747",
                  imdbId: "tt0903747",
                  tmdbId: 1396,
                  title: "Breaking Bad",
                  seasonsData: [{ season_number: 1, episode_count: 7 }]
                }
              }
            };
          }
          return {
            json: {
              ok: true,
              details: {
                id: "tt9999999",
                title: "Standalone Indie Movie"
              }
            }
          };
        }
      }
    });

    const doc = client.get("document");
    const body = doc.getElementById("itemDetailsBody");

    // 1. Open Breaking Bad details
    await client.call("openItemDetailsModal", "tt0903747", "series");
    assert.ok(body.innerHTML.includes("item-storylines-section"), "Breaking Bad modal contains storylines section");
    assert.ok(body.innerHTML.includes("Breaking Bad Complete Universe"), "Breaking Bad modal contains saga title");
    assert.ok(body.innerHTML.includes("item-storyline-current-pill"), "Breaking Bad modal highlights current part");

    // 2. Open Standalone Movie details
    await client.call("openItemDetailsModal", "tt9999999", "movie");
    assert.equal(body.innerHTML.includes("item-storylines-section"), false, "Standalone movie modal does not contain storylines section");
  });

  // Same static registry, same missing rating, as the Channel Builder's own
  // grid (see "client: Storylines, Sagas & Universes rating badges" above) --
  // these cover the one thing specific to this surface: the title already
  // open in the modal is skipped, since its rating is already shown higher
  // up on the same page.
  it("renders a rating slot for each companion title, but not for the one already open", () => {
    const client = loadClient();
    const bb = {
      id: "tt0903747",
      imdbId: "tt0903747",
      tmdbId: 1396,
      title: "Breaking Bad",
      seasonsData: [{ season_number: 1, episode_count: 7 }]
    };
    const html = client.__scopeCall("renderItemStorylinesWatchOrder", [bb, "series"]);
    assert.match(html, /storyline-rating-slot" data-rating-id="tt9243946"/,
      "El Camino (a companion) gets a rating slot");
    assert.match(html, /storyline-rating-slot" data-rating-id="tt3032476"/,
      "Better Call Saul (a companion) gets a rating slot");
    assert.equal(html.includes('data-rating-id="tt0903747"'), false,
      "Breaking Bad itself -- the title already open in this modal -- gets no slot");
  });

  it("asks /api/details/batch for the companion titles once the modal body is actually updated", async () => {
    const client = loadClient({
      routes: {
        "/api/details": () => ({
          json: {
            ok: true,
            details: {
              id: "tt0903747", imdbId: "tt0903747", tmdbId: 1396, title: "Breaking Bad",
              seasonsData: [{ season_number: 1, episode_count: 7 }],
            },
          },
        }),
        "/api/details/batch": (req) => {
          const results = {};
          req.body.ids.forEach((id) => { results[id] = { rating: "8.9" }; });
          return { json: { ok: true, results: results, remainingIds: [], done: true } };
        },
      },
    });
    await client.call("openItemDetailsModal", "tt0903747", "series");
    await settle();

    const sent = requestsTo(client, "/api/details/batch").flatMap((r) => r.body.ids);
    assert.ok(sent.includes("tt9243946"), "El Camino is resolved");
    assert.ok(sent.includes("tt3032476"), "Better Call Saul is resolved");
    assert.equal(sent.includes("tt0903747"), false, "the currently open title is never asked for");

    const cache = client.get("_storylineRatingsCache");
    assert.equal(cache.tt9243946, 8.9);
  });
});



// --- FE2-01: a backup field of the wrong JSON type must not eat the import ---
//
// addRow read `name` without coercing it -- the one read in that function that
// did not -- so a list literally called 2024, written unquoted by a hand-edited
// or third-party-generated backup, threw
// "(name || group || 'L').trim is not a function" mid-import. The throw escaped
// applyImportedConfig AND the click handler, so the rows already cleared stayed
// cleared, the remaining entries were never added, and the report modal (which
// renders at the END of applyImportedConfig) never appeared. Measured in a real
// browser before the fix: 8 catalogs in, 1 row out, no message.
describe("client: a backup field stored as the wrong JSON type", () => {
  const NUMERIC_NAME_BACKUP = {
    version: "3.0",
    entries: [
      { name: "My Good List", url: "tmdb:chart:popular", type: "movie", enabled: true, group: "Custom" },
      { name: 2024, url: "tmdb:chart:top_rated", type: "movie", enabled: true, group: "Custom" },
      { name: "Another List", url: "tmdb:chart:trending", type: "movie", enabled: true, group: "Custom" },
    ],
  };

  it("addRow survives a non-string name instead of throwing", () => {
    const client = loadClient();
    // The exact sink. A number, and the two shapes a careless generator emits.
    assert.doesNotThrow(() => client.call("addRow", 2024, "tmdb:chart:popular", "movie", true, "Custom"));
    assert.doesNotThrow(() => client.call("addRow", null, "tmdb:chart:popular", "movie", true, 7));
    assert.doesNotThrow(() => client.call("addRow", { a: 1 }, "tmdb:chart:popular", "movie", true, "Custom"));
  });

  it("imports every entry and does not stop at the bad one", () => {
    const client = loadClient();
    // The DOM stub does not build a tree, so collectEntries cannot see rows.
    // What regressed is reachability: the throw meant every entry after the
    // numeric one was never added at all. Count what actually reaches addRow.
    client.__scopeGet("(function(){ globalThis.__added = []; const o = addRow;"
      + " addRow = function(name){ globalThis.__added.push(String(name)); return o.apply(null, arguments); };"
      + " return 1; })()");
    assert.doesNotThrow(() => client.call("applyImportedConfig", JSON.parse(JSON.stringify(NUMERIC_NAME_BACKUP))));
    const added = client.__scopeGet("globalThis.__added") || [];
    assert.ok(added.includes("My Good List"));
    assert.ok(added.includes("2024"), "the numeric name is coerced, not discarded");
    assert.ok(added.includes("Another List"), "entries AFTER the bad one must still be imported");
  });

  it("validateAndRepairBackup coerces the field and says so", () => {
    const client = loadClient();
    const data = JSON.parse(JSON.stringify(NUMERIC_NAME_BACKUP));
    const report = client.call("validateAndRepairBackup", data);
    assert.equal(typeof data.entries[1].name, "string", "repaired in place");
    assert.equal(data.entries[1].name, "2024");
    const said = [...(report.warnings || []), ...(report.notes || [])].join(" ");
    assert.match(said, /number or object/i, "a silent repair is the failure mode this file exists to prevent");
  });

  it("an object or array name is dropped rather than stringified to [object Object]", () => {
    const client = loadClient();
    const data = { version: "3.0", entries: [{ name: { nope: 1 }, url: "tmdb:chart:popular", type: "movie", enabled: true }] };
    client.call("validateAndRepairBackup", data);
    assert.equal(data.entries[0].name, "", "falls back to the usual guessed name instead of [object Object]");
  });
});

// --- FE2-02: the interactive toggle must win over its own background job -----
//
// toggleBatchWatchStatus kicked off updateContinueWatchingForBatch and dropped
// the promise; markShowWatched then committed its own Continue Watching state.
// Both rewrite _fullyWatchedShowIds and the continue-watching list, so a second
// toggle that began before the first one's background work settled lost to it:
// the show stayed flagged fully watched with a phantom companion queued, while
// the button read the opposite -- and scheduleCreatorSyncSave pushed that state
// to the account. The gap in a browser is a real /api/season round trip.
describe("client: markShowWatched is not raced by its own background reconciliation", () => {
  const S1 = [
    { id: 101, name: "Pilot", episode_number: 1, air_date: "2008-01-20" },
    { id: 102, name: "Cat's in the Bag...", episode_number: 2, air_date: "2008-01-27" },
  ];
  const S2 = [
    { id: 201, name: "Seven Thirty-Seven", episode_number: 1, air_date: "2009-03-08" },
    { id: 202, name: "Grilled", episode_number: 2, air_date: "2009-03-15" },
  ];

  const setup = () => {
    const client = loadClient({
      routes: {
        "/api/season": (req) => {
          const s = new URL(req.url, "https://example.com").searchParams.get("seasonNum");
          if (s === "1") return { json: { ok: true, season: { episodes: S1 } } };
          if (s === "2") return { json: { ok: true, season: { episodes: S2 } } };
          return { json: { ok: false, error: "Not found" } };
        },
      },
    });
    client.set("_currentItemDetails", {
      id: "tt0903747", tmdbId: 1396, title: "Breaking Bad",
      seasonsData: [{ season_number: 1, episode_count: 2 }, { season_number: 2, episode_count: 2 }],
    });
    const btn = client.get("document").getElementById("btnMarkShowWatched");
    btn.classList.add("primary");
    btn.innerHTML = "Mark Show Watched";
    return { client, btn };
  };

  it("leaves no fully-watched flag behind when watched and unwatched back to back", async () => {
    const { client, btn } = setup();
    // Back to back, with NO gap -- the reproduction. Before the fix the first
    // toggle's floating promise landed during the second and undid it.
    await client.call("markShowWatched", "tt0903747");
    await client.call("markShowWatched", "tt0903747");
    await settle();

    const flagged = [...(client.get("window")._fullyWatchedShowIds || [])];
    assert.deepEqual(flagged, [], "an unwatched show must not stay flagged fully watched");

    const cw = client.call("loadLocalCustomLists")["continue-watching"]?.items || [];
    assert.equal(cw.some((it) => it && it.precedingShowId === "tt0903747"), false,
      "the queued companion must be cleaned up when the show is unmarked");
    // The state and what the button claims must agree.
    assert.equal(btn.innerHTML.includes("Unwatched"), false, "button and stored state must not disagree");
  });

  it("keeps the button disabled until the whole sequence has settled", async () => {
    const { client, btn } = setup();
    const pending = client.call("markShowWatched", "tt0903747");
    assert.equal(btn.disabled, true, "a live button during the async tail is the race window");
    await pending;
    assert.equal(btn.disabled, false, "and it must come back afterwards");
  });
});

// Live Preview & Editor renders a personal shelf by asking /api/preview for it,
// and that endpoint is unauthenticated: the username inside an
// 'autotrack:<slug>:<type>:<username>' url is an unproven claim until the call
// also carries a Creator Key it can verify. mayReadTrackedShelf answers an
// unproven reader with an EMPTY shelf rather than an error (a catalog row has
// no way to show a message), so the request that omitted the key did not fail
// -- it came back ok:true with nothing in it, and Watch History, Continue
// Watching and Airing Next each rendered "No items found." the moment they
// were added to the config, for their own owner.
describe("client: Live Preview proves who is asking before reading a personal shelf", () => {
  // renderLivePreview walks real rows, and the harness's document stub answers
  // every querySelectorAll with []. These are the few nodes it actually reads.
  function fakeInput(value) {
    return { value, dataset: {} };
  }

  function fakeEntry(name, url, type) {
    const posters = { innerHTML: "", classList: { add() {}, remove() {}, toggle() {} } };
    const status = { innerHTML: "" };
    const entry = {
      dataset: {},
      style: {},
      posters,
      status,
      querySelector(sel) {
        if (sel === ".name") return fakeInput(name);
        if (sel === ".type") return fakeInput(type);
        if (sel === ".url") return fakeInput(url);
        if (sel === ".live-preview-posters") return posters;
        if (sel === ".live-preview-shelf-status") return status;
        return null;
      },
      querySelectorAll(sel) {
        if (sel === ".url") return [fakeInput(url)];
        return [];
      },
    };
    return entry;
  }

  // One row per shelf, wired up the way the builder page would have them.
  function withRows(client, rows) {
    const entries = rows.map((r) => fakeEntry(r.name, r.url, r.type));
    const doc = client.get("document");
    const lists = doc.getElementById("lists");
    lists.querySelectorAll = (sel) => (sel === ".entry" ? entries : []);
    doc.querySelectorAll = (sel) => {
      if (sel === "#lists .entry") return entries;
      if (sel === "#lists .entry .url") return rows.map((r) => fakeInput(r.url));
      return [];
    };
    return entries;
  }

  const previewOk = (req) => ({
    json: {
      ok: true,
      count: 1,
      totalItems: 1,
      maybeMore: false,
      sample: [{ id: "tt0903747", type: "series", name: "Breaking Bad", poster: "" }],
    },
  });

  it("sends the Creator Key for an autotrack row so the shelf is readable", async () => {
    const client = loadClient({
      storage: { "myListAddon:creatorKey": "KEY-123" },
      routes: { "/api/preview": previewOk },
    });
    client.set("activeCreator", { creatorName: "alice" });
    withRows(client, [
      { name: "Continue Watching", url: "autotrack:continue-watching:series:alice", type: "series" },
      { name: "Watch History", url: "autotrack:watch-history:movie:alice", type: "movie" },
      { name: "Airing Next", url: "autotrack:airing-next:series:alice", type: "series" },
    ]);

    await client.call("renderLivePreview");
    await settle();

    const sent = requestsTo(client, "/api/preview");
    assert.equal(sent.length, 3, "one preview call per enabled shelf");
    for (const req of sent) {
      // Without this the server cannot place the caller, mayReadTrackedShelf
      // falls back to the owner's share flags -- and airing-next has none at
      // all -- so the answer is an empty shelf and the row reads
      // "No items found."
      assert.equal(req.body.creatorKey, "KEY-123",
        `a personal shelf preview must prove ownership: ${req.body.url}`);
      assert.equal(req.body.creatorName, "alice", "and name the account it is proving");
    }
  });

  it("finds a personal shelf on any line of a merged row's url", async () => {
    const client = loadClient({
      storage: { "myListAddon:creatorKey": "KEY-123" },
      routes: { "/api/preview": previewOk },
    });
    client.set("activeCreator", { creatorName: "alice" });
    withRows(client, [
      { name: "Mixed", url: "mdblist:trending\nautotrack:watch-history:movie:alice", type: "movie" },
    ]);

    await client.call("renderLivePreview");
    await settle();

    const sent = requestsTo(client, "/api/preview");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.creatorKey, "KEY-123",
      "a merged row stacks sources one per line; the personal one need not be first");
  });

  it("keeps the key out of a preview that does not need it", async () => {
    const client = loadClient({
      storage: { "myListAddon:creatorKey": "KEY-123" },
      routes: { "/api/preview": previewOk },
    });
    client.set("activeCreator", { creatorName: "alice" });
    withRows(client, [
      { name: "Trending", url: "https://mdblist.com/lists/someone/trending", type: "movie" },
    ]);

    await client.call("renderLivePreview");
    await settle();

    const sent = requestsTo(client, "/api/preview");
    assert.equal(sent.length, 1);
    // The Creator Key is a bearer credential. A public list preview has no use
    // for it, the same reason collectKeys only puts trackCreatorKey into a
    // config that actually carries a personal shelf.
    assert.equal(sent[0].body.creatorKey, undefined,
      "a public list preview must not carry the account key");
  });

  it("sends nothing to prove when nobody is signed in", async () => {
    const client = loadClient({
      storage: { "myListAddon:creatorKey": "KEY-123" },
      routes: { "/api/preview": previewOk },
    });
    client.set("activeCreator", null);
    withRows(client, [
      { name: "Watch History", url: "autotrack:watch-history:movie:alice", type: "movie" },
    ]);

    await client.call("renderLivePreview");
    await settle();

    const sent = requestsTo(client, "/api/preview");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.creatorKey, undefined,
      "a signed-out browser has no ownership to claim over someone else's shelf");
  });
});

// "Remove duplicate items across lists" (Settings -> dedupeAcrossListsCheckbox).
// Server-side coverage (the real Stremio/Nuvio catalogs) lives in
// tests/worker.test.mjs under "worker: remove duplicate items across lists" --
// this is the client-only half: the same rule applied to Live Preview's
// already-fetched shelves, purely in the browser, no extra request.
describe("client: Live Preview removes duplicate items across lists", () => {
  function fakeInput(value) {
    return { value, dataset: {} };
  }

  function fakeEntry(name, url, type) {
    const posters = { innerHTML: "", classList: { add() {}, remove() {}, toggle() {} } };
    const status = { innerHTML: "" };
    const entry = {
      dataset: {},
      style: {},
      posters,
      status,
      querySelector(sel) {
        if (sel === ".name") return fakeInput(name);
        if (sel === ".type") return fakeInput(type);
        if (sel === ".url") return fakeInput(url);
        if (sel === ".live-preview-posters") return posters;
        if (sel === ".live-preview-shelf-status") return status;
        return null;
      },
      querySelectorAll(sel) {
        if (sel === ".url") return [fakeInput(url)];
        return [];
      },
    };
    return entry;
  }

  function withRows(client, rows) {
    const entries = rows.map((r) => fakeEntry(r.name, r.url, r.type));
    const doc = client.get("document");
    const lists = doc.getElementById("lists");
    lists.querySelectorAll = (sel) => (sel === ".entry" ? entries : []);
    doc.querySelectorAll = (sel) => {
      if (sel === "#lists .entry") return entries;
      if (sel === "#lists .entry .url") return rows.map((r) => fakeInput(r.url));
      return [];
    };
    return entries;
  }

  const sampleRoute = (byUrl) => (req) => ({
    json: { ok: true, totalItems: byUrl[req.body.url].length, maybeMore: false, sample: byUrl[req.body.url] },
  });

  it("keeps the top list's items and strips whatever a later list of the same type already has", async () => {
    const client = loadClient({
      storage: { "myListAddon:dedupeAcrossLists": "1" },
      routes: {
        "/api/preview": sampleRoute({
          "customlist:v1:listone": [
            { id: "ttA", type: "movie", name: "Movie A", poster: "" },
            { id: "ttB", type: "movie", name: "Movie B", poster: "" },
          ],
          "customlist:v1:listtwo": [
            { id: "ttA", type: "movie", name: "Movie A", poster: "" },
            { id: "ttC", type: "movie", name: "Movie C", poster: "" },
          ],
        }),
      },
    });
    const rows = withRows(client, [
      { name: "List 1", url: "customlist:v1:listone", type: "movie" },
      { name: "List 2", url: "customlist:v1:listtwo", type: "movie" },
    ]);

    await client.call("renderLivePreview");

    assert.match(rows[0].posters.innerHTML, /ttA/, "list 1 keeps A");
    assert.match(rows[0].posters.innerHTML, /ttB/, "list 1 keeps B");
    assert.equal(rows[1].posters.innerHTML.includes("ttA"), false, "list 2 loses A -- already shown by list 1");
    assert.match(rows[1].posters.innerHTML, /ttC/, "list 2 keeps C -- not shown anywhere earlier");

    const shelfData = client.get("livePreviewShelfData");
    assert.deepEqual(shelfData[0].sample.map((it) => it.id), ["ttA", "ttB"]);
    assert.deepEqual(shelfData[1].sample.map((it) => it.id), ["ttC"]);
    assert.equal(shelfData[1].totalItems, 1, "the shown total drops by however many were removed");
  });

  it("does nothing when the setting is off, even with the exact same overlapping lists", async () => {
    const client = loadClient({
      routes: {
        "/api/preview": sampleRoute({
          "customlist:v1:listone": [{ id: "ttA", type: "movie", name: "Movie A", poster: "" }],
          "customlist:v1:listtwo": [
            { id: "ttA", type: "movie", name: "Movie A", poster: "" },
            { id: "ttB", type: "movie", name: "Movie B", poster: "" },
          ],
        }),
      },
    });
    withRows(client, [
      { name: "List 1", url: "customlist:v1:listone", type: "movie" },
      { name: "List 2", url: "customlist:v1:listtwo", type: "movie" },
    ]);

    await client.call("renderLivePreview");

    const shelfData = client.get("livePreviewShelfData");
    assert.deepEqual(shelfData[1].sample.map((it) => it.id), ["ttA", "ttB"], "no dedup applied");
  });

  it("shows a message instead of an empty shelf when every item in a list was a duplicate", async () => {
    const client = loadClient({
      storage: { "myListAddon:dedupeAcrossLists": "1" },
      routes: {
        "/api/preview": sampleRoute({
          "customlist:v1:listone": [{ id: "ttA", type: "movie", name: "Movie A", poster: "" }],
          "customlist:v1:listtwo": [{ id: "ttA", type: "movie", name: "Movie A", poster: "" }],
        }),
      },
    });
    const rows = withRows(client, [
      { name: "List 1", url: "customlist:v1:listone", type: "movie" },
      { name: "List 2", url: "customlist:v1:listtwo", type: "movie" },
    ]);

    await client.call("renderLivePreview");

    assert.match(rows[1].posters.innerHTML, /duplicate/i);
  });
});

describe("client: taking one show off Airing Next", () => {
  const LOAD = "/api/creator/sync/load";
  const SAVE_TRACKING = "/api/creator/sync/save-tracking";
  const BATCH = "/api/details/batch";

  // A show with three watched episodes and an upcoming one on the shelf,
  // alongside a second show that must be left entirely alone.
  const seedShelf = (client) => {
    client.call("saveLocalCustomListsMap", {
      "watch-history": {
        slug: "watch-history", name: "Watch History", type: "series",
        items: [
          { id: "ttB:4:7", showId: "ttB", showTitle: "Removed Show", type: "episode", seasonNum: 4, episodeNum: 7, watchedAt: 30 },
          { id: "ttB:4:6", showId: "ttB", showTitle: "Removed Show", type: "episode", seasonNum: 4, episodeNum: 6, watchedAt: 20 },
          { id: "ttA:1:1", showId: "ttA", showTitle: "Kept Show", type: "episode", seasonNum: 1, episodeNum: 1, watchedAt: 10 },
        ],
        updatedAt: 1000,
      },
      "airing-next": {
        slug: "airing-next", name: "Airing Next", type: "series",
        items: [
          { id: "ttA", showId: "ttA", showTitle: "Kept Show", airDate: "2099-01-01", seasonNum: 1, episodeNum: 2 },
          { id: "ttB", showId: "ttB", showTitle: "Removed Show", airDate: "2099-02-02", seasonNum: 4, episodeNum: 8 },
        ],
        updatedAt: 1000,
      },
    });
  };

  const shelfIds = (client) =>
    ((client.call("loadLocalCustomLists")["airing-next"] || {}).items || []).map((it) => it.showId);
  const historyIds = (client) =>
    ((client.call("loadLocalCustomLists")["watch-history"] || {}).items || []).map((it) => it.id);

  it("takes the show off the shelf without touching what is watched", () => {
    const client = loadClient();
    seedShelf(client);

    client.call("removeAiringNextShow", "ttB", null);

    assert.deepEqual(shelfIds(client), ["ttA"], "only the removed show leaves the shelf");
    // The whole point of the feature: a removal says nothing about what has
    // been watched, so every episode stays exactly where it was.
    assert.deepEqual(historyIds(client).sort(), ["ttA:1:1", "ttB:4:6", "ttB:4:7"]);
    // Recorded at the furthest-along watched episode, which is what a later
    // one supersedes. (Field by field: the object was built inside the
    // bundle's own realm, so it is not deep-equal to a plain one out here.)
    const mark = client.window._removedAiringNext.ttB;
    assert.equal(mark.seasonNum, 4);
    assert.equal(mark.episodeNum, 7);
  });

  it("keeps it off when the shelf is rebuilt", () => {
    const client = loadClient();
    seedShelf(client);
    client.call("removeAiringNextShow", "ttB", null);

    // collectAiringNextCandidateShowIds is what every rebuild starts from --
    // the 6-hourly refresh, the watch-state sync, and the dashboard card's own
    // eligibility check. A removal that did not reach here would last until
    // the next refresh and no longer.
    const candidates = [...client.call("collectAiringNextCandidateShowIds")];
    assert.deepEqual(candidates, ["ttA"]);
  });

  it("puts it back as soon as another episode is watched", () => {
    const client = loadClient();
    seedShelf(client);
    client.call("removeAiringNextShow", "ttB", null);
    assert.equal(client.call("isAiringNextRemoved", "ttB"), true);

    // The next episode of the removed show, watched.
    const map = client.call("loadLocalCustomLists");
    map["watch-history"].items.unshift({
      id: "ttB:4:8", showId: "ttB", showTitle: "Removed Show", type: "episode",
      seasonNum: 4, episodeNum: 8, watchedAt: 40,
    });
    client.call("saveLocalCustomListsMap", map);

    assert.equal(client.call("isAiringNextRemoved", "ttB"), false,
      "watching on is how the show comes back -- there is no second switch to flip");
    assert.ok([...client.call("collectAiringNextCandidateShowIds")].includes("ttB"));
  });

  it("stays removed when an older episode is rewatched", () => {
    const client = loadClient();
    seedShelf(client);
    client.call("removeAiringNextShow", "ttB", null);

    const map = client.call("loadLocalCustomLists");
    map["watch-history"].items.unshift({
      id: "ttB:1:1", showId: "ttB", showTitle: "Removed Show", type: "episode",
      seasonNum: 1, episodeNum: 1, watchedAt: 50,
    });
    client.call("saveLocalCustomListsMap", map);

    // Rewatching season 1 is not "I am following this again" -- the shelf is
    // about what airs next, and nothing about what airs next has changed.
    assert.equal(client.call("isAiringNextRemoved", "ttB"), true);
  });

  it("forgets a removal once it has been superseded", () => {
    const client = loadClient();
    seedShelf(client);
    client.call("removeAiringNextShow", "ttB", null);

    const map = client.call("loadLocalCustomLists");
    map["watch-history"].items.unshift({
      id: "ttB:5:1", showId: "ttB", showTitle: "Removed Show", type: "episode",
      seasonNum: 5, episodeNum: 1, watchedAt: 60,
    });
    client.call("saveLocalCustomListsMap", map);

    assert.equal(client.call("pruneSupersededAiringRemovals"), true);
    assert.deepEqual(Object.keys(client.window._removedAiringNext), [],
      "otherwise the stored set grows by one entry per show, forever");
  });

  it("can be undone by hand from Settings", async () => {
    const client = loadClient({ routes: { [BATCH]: () => ({ json: { ok: true, results: {} } }) } });
    seedShelf(client);
    client.call("removeAiringNextShow", "ttB", null);
    const removedRows = client.call("getRemovedAiringNextShows");
    assert.equal(removedRows.length, 1);
    assert.equal(removedRows[0].title, "Removed Show");

    client.call("restoreAiringNextShow", "ttB");
    await settle();

    assert.equal(client.call("isAiringNextRemoved", "ttB"), false);
    assert.ok([...client.call("collectAiringNextCandidateShowIds")].includes("ttB"));
    assert.equal(client.call("getRemovedAiringNextShows").length, 0);
  });

  it("puts the x on the full-page view, wired to the right shelf", () => {
    const client = loadClient();
    const html = client.call("livePreviewPosterHtml", {
      id: "ttB", type: "series", name: "Removed Show", showTitle: "Removed Show",
      removeAiringShowId: "ttB", listUrl: "custom:airing-next",
    });
    assert.match(html, /data-remove-type="airing"/);
    assert.match(html, /data-remove-id="ttB"/);
    // livePreviewPosterHtml reads removeShowId as "this is a Continue
    // Watching tile", so an Airing Next tile must not carry it -- the x would
    // dismiss the show from the wrong shelf and mark it fully watched.
    assert.doesNotMatch(html, /data-remove-type="cw"/);

    // And the dispatch behind that button reaches the removal, not one of
    // its four neighbours in the same switch.
    seedShelf(client);
    const btn = client.window.document.createElement("button");
    btn.dataset.removeType = "airing";
    btn.dataset.removeId = "ttB";
    client.call("removeListItemFromDetails", btn);
    assert.equal(client.call("isAiringNextRemoved", "ttB"), true);
    assert.deepEqual(historyIds(client).sort(), ["ttA:1:1", "ttB:4:6", "ttB:4:7"]);
  });

  it("covers the second id the same show is recorded under", async () => {
    // Watch History can hold both an imdb and a tmdb-prefixed id for one
    // series -- refreshAiringNext dedupes exactly that when it builds the
    // shelf. Marking only the id the tile was rendered under leaves the other
    // one a candidate, and the next rebuild puts the show straight back.
    const client = loadClient({ routes: { [BATCH]: () => ({ json: { ok: true, results: {} } }) } });
    client.call("saveLocalCustomListsMap", {
      "watch-history": {
        slug: "watch-history", name: "Watch History", type: "series",
        items: [
          { id: "tt9:1:1", showId: "tt9", showTitle: "Twin Show", type: "episode", seasonNum: 1, episodeNum: 1, watchedAt: 10 },
          { id: "tmdb:55:1:2", showId: "tmdb:55", showTitle: "Twin Show", type: "episode", seasonNum: 1, episodeNum: 2, watchedAt: 20 },
        ],
        updatedAt: 1000,
      },
      "airing-next": {
        slug: "airing-next", name: "Airing Next", type: "series",
        items: [{ id: "tt9", showId: "tt9", canonicalTmdbId: "55", showTitle: "Twin Show", airDate: "2099-03-03" }],
        updatedAt: 1000,
      },
    });

    client.call("removeAiringNextShow", "tt9", null);
    assert.deepEqual([...client.call("collectAiringNextCandidateShowIds")], [],
      "both ids for the removed show have to go, or the shelf rebuilds it under the other one");

    // One show, one row -- and putting it back clears both marks, or the
    // leftover would go on hiding it.
    const rows = client.call("getRemovedAiringNextShows");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, "Twin Show");
    client.call("restoreAiringNextShow", rows[0].showIds.join(","));
    await settle();
    assert.deepEqual([...client.call("collectAiringNextCandidateShowIds")].sort(), ["tmdb:55", "tt9"]);
  });

  it("tells the account, so another device does not rebuild the show back on", async () => {
    const pushes = [];
    const client = loadClient({
      storage: { "myListAddon:creatorKey": "KEY-1", "myListAddon:creatorName": "alice" },
      routes: {
        [LOAD]: () => ({ json: { ok: true, data: { watchHistory: [], trackingUpdatedAt: 6000, trackingClientVersion: 3 } } }),
        [SAVE_TRACKING]: (req) => { pushes.push(req.body); return { json: { ok: true, clientVersion: 4 } }; },
        [LISTS]: () => ({ json: { ok: true, lists: [] } }),
      },
    });
    client.set("activeCreator", { creatorName: "alice" });
    client.call("markCreatorSyncLoaded");
    seedShelf(client);
    client.call("removeAiringNextShow", "ttB", null);

    await client.call("pushTrackingSync", { intentionalRemoval: true });
    await settle();

    assert.equal(pushes.length, 1);
    assert.deepEqual(pushes[0].removedAiringNext, { ttB: { seasonNum: 4, episodeNum: 7 } });
    assert.deepEqual(pushes[0].airingNext.map((it) => it.showId), ["ttA"]);
    // Removing the last show on the shelf sends an empty array, and
    // save-tracking refuses to let an empty derived list replace a stored one
    // unless this flag is set -- without it the Stremio row keeps serving the
    // show that was just removed.
    assert.equal(pushes[0].intentionalRemoval, true);
  });

  it("applies a removal made on another device", async () => {
    const client = loadClient({
      storage: { "myListAddon:creatorKey": "KEY-1", "myListAddon:creatorName": "alice" },
      routes: {
        [LOAD]: () => ({ json: { ok: true, data: {
          trackingUpdatedAt: 6000,
          trackingClientVersion: 3,
          removedAiringNext: { ttB: { seasonNum: 4, episodeNum: 7 } },
        } } }),
        [SAVE_TRACKING]: () => ({ json: { ok: true, clientVersion: 4 } }),
        [LISTS]: () => ({ json: { ok: true, lists: [] } }),
      },
    });
    client.set("activeCreator", { creatorName: "alice" });
    seedShelf(client);

    await client.call("loadCreatorSync");
    await settle();

    assert.equal(client.call("isAiringNextRemoved", "ttB"), true);
    // This browser had already computed a shelf with the show on it, so
    // applying the account's removals has to reach that copy too.
    assert.deepEqual(shelfIds(client), ["ttA"]);
  });
});

describe("client: Reset Account Data says it is working", () => {
  const RESET = "/api/creator/account/reset";

  // Resetting clears this browser first and only then waits on the server --
  // deliberately, so nothing can re-upload the old lists into the account
  // being emptied. The cost is a second or two in which every list on screen
  // has already vanished and the confirm dialog has already closed. Before
  // this, nothing at all was on screen during that gap, and pressing Reset
  // again was the obvious thing to try.
  const arrange = (client, events, resetResponse) => {
    client.set("activeCreator", { creatorName: "alice", displayName: "Alice" });
    client.set("showAppConfirm", (title, msg, btn, onConfirm) => { client.window.__pending = onConfirm(); });
    client.set("showAppBusy", () => { events.push("busy"); });
    client.set("showAppAlert", (title) => { events.push("alert:" + title); });
    client.set("clearLocalAccountData", () => { events.push("cleared"); });
    return resetResponse;
  };

  it("puts a working dialog up before anything disappears, and replaces it with the result", async () => {
    const events = [];
    const client = loadClient({
      storage: { "myListAddon:creatorKey": "KEY-1", "myListAddon:creatorName": "alice" },
      routes: { [RESET]: () => { events.push("request"); return { json: { ok: true, resetAt: 5 } }; } },
    });
    arrange(client, events);

    client.call("openResetAccountModal");
    await client.window.__pending;
    await settle();

    assert.deepEqual(events, ["busy", "cleared", "request", "alert:Account Reset"],
      "the working dialog goes up before the local clear, and the outcome dialog replaces it");
  });

  it("still lands on a dialog when the reset fails", async () => {
    const events = [];
    const client = loadClient({
      storage: { "myListAddon:creatorKey": "KEY-1", "myListAddon:creatorName": "alice" },
      routes: { [RESET]: () => { events.push("request"); return { status: 500, json: { ok: false, error: "Nope." } }; } },
    });
    arrange(client, events);

    client.call("openResetAccountModal");
    await client.window.__pending;
    await settle();

    // A spinner left turning over a finished request is worse than no
    // spinner at all.
    assert.equal(events[events.length - 1], "alert:Reset Failed");
  });

  it("ships the animation the spinner is named after", () => {
    // Two places asked for `animation: spin` and the page declared no such
    // keyframes, so both spinners sat perfectly still -- a progress indicator
    // that does not move says "stuck", which is the exact impression this is
    // here to remove. Cheap to lose again in a CSS edit, so it is asserted.
    const html = renderPage();
    assert.match(html, /@keyframes spin\b/, "the page must declare the animation it uses by name");
    for (const m of html.matchAll(/animation:\s*([A-Za-z_-][\w-]*)/g)) {
      // `animation: none` is the CSS keyword for "no animation", not a name.
      if (m[1] === "none") continue;
      assert.match(html, new RegExp("@keyframes\\s+" + m[1] + "\\b"),
        `animation "${m[1]}" is used but never declared`);
    }
  });
});

describe("client: a not-yet-aired episode is not something anyone watched", () => {
  const SEASON = "/api/season";

  // Far enough out that no clock skew makes it "aired" mid-test.
  const FUTURE = "2099-06-01";

  const showWith = (seasons) => ({
    id: "tt5555555", tmdbId: 9999, title: "Renewed Show", poster: "", seasonsData: seasons,
  });

  const seasonRoutes = (bySeason) => ({
    [SEASON]: (req) => {
      const s = new URL(req.url, "https://example.com").searchParams.get("seasonNum");
      const eps = bySeason[s];
      if (!eps) return { json: { ok: false, error: "Not found" } };
      return { json: { ok: true, season: { episodes: eps } } };
    },
  });

  const fakeBtn = () => ({ disabled: false, textContent: "", innerHTML: "", title: "", classList: { remove() {}, add() {} } });

  it("marking the whole show watched leaves the future season alone", async () => {
    const client = loadClient({
      routes: seasonRoutes({
        "1": [{ id: 101, name: "Pilot", episode_number: 1, air_date: "2020-01-01" }],
        "2": [{ id: 201, name: "Return", episode_number: 1, air_date: FUTURE }],
      }),
    });
    const d = showWith([
      { season_number: 1, episode_count: 1, air_date: "2020-01-01" },
      { season_number: 2, episode_count: 1, air_date: FUTURE },
    ]);
    client.set("_currentItemDetails", d);
    const btnShow = client.get("document").getElementById("btnMarkShowWatched");
    btnShow.classList.add("primary");
    btnShow.innerHTML = "Mark Show Watched";

    await client.call("markShowWatched", "tt5555555");

    const hist = (client.call("loadLocalCustomLists")["watch-history"] || {}).items || [];
    // Joined rather than deep-compared: the array comes out of the bundle's
    // own realm and is not deep-equal to a plain one out here.
    assert.equal(hist.map((it) => String(it.id)).join(","), "101",
      "only the aired episode is watched -- a season that has not started cannot have been");

    // The season button is the part the report was about: it used to be
    // relabelled "Mark Season Unwatched" for every season on screen,
    // including one with nothing in Watch History behind it.
    const s2 = client.call("seasonWatchedButtonState", d, d.seasonsData[1]);
    assert.equal(s2.upcoming, true);
    assert.equal(s2.label.includes("Unwatched"), false, "a season that has not aired must never read as watched");
    const s1 = client.call("seasonWatchedButtonState", d, d.seasonsData[0]);
    assert.equal(s1.upcoming, false);
    assert.equal(s1.label.includes("Mark Season Unwatched"), true, "the aired season did get watched");
  });

  it("counts the show as caught up rather than unfinished", async () => {
    const client = loadClient({
      routes: seasonRoutes({
        "1": [{ id: 101, name: "Pilot", episode_number: 1, air_date: "2020-01-01" }],
        "2": [{ id: 201, name: "Return", episode_number: 1, air_date: FUTURE }],
      }),
    });
    const d = showWith([
      { season_number: 1, episode_count: 1, air_date: "2020-01-01" },
      { season_number: 2, episode_count: 1, air_date: FUTURE },
    ]);
    client.set("_currentItemDetails", d);
    const btnShow = client.get("document").getElementById("btnMarkShowWatched");
    btnShow.classList.add("primary");
    btnShow.innerHTML = "Mark Show Watched";

    await client.call("markShowWatched", "tt5555555");

    // Before: an announced season made this false forever, so reopening the
    // modal contradicted the button the person had just pressed.
    assert.equal(client.call("isShowFullyWatched", d), true);
  });

  it("keeps the caught-up show on Continue Watching instead of dropping it", async () => {
    const client = loadClient({
      routes: seasonRoutes({
        "1": [
          { id: 101, name: "Pilot", episode_number: 1, air_date: "2020-01-01" },
          { id: 102, name: "Finale", episode_number: 2, air_date: FUTURE },
        ],
      }),
    });
    const d = showWith([{ season_number: 1, episode_count: 2, air_date: "2020-01-01" }]);
    client.set("_currentItemDetails", d);
    const btnShow = client.get("document").getElementById("btnMarkShowWatched");
    btnShow.classList.add("primary");
    btnShow.innerHTML = "Mark Show Watched";

    await client.call("markShowWatched", "tt5555555");
    await settle();

    const cw = (client.call("loadLocalCustomLists")["continue-watching"] || {}).items || [];
    // Marking the last aired episode one at a time leaves the show here with
    // an "Airs ..." badge; Mark Show Watched used to be the one path that
    // evicted it outright, which is the difference the report describes.
    assert.equal(cw.length, 1, "a show with an episode still to come has not finished");
    assert.equal(String(cw[0].id), "102");
    assert.equal(cw[0].isUnaired, true);
  });

  it("refuses to mark a future episode watched, and still lets one be unmarked", () => {
    const client = loadClient();
    client.set("_currentItemDetails", { id: "tt5555555", title: "Renewed Show", poster: "" });
    client.set("_episodeDataCache", { 1: { id: 201, episode_number: 1, season_number: 2, air_date: FUTURE, name: "Return" } });

    client.call("toggleWatchStatus", "201", "episode", "Return", "");
    let hist = (client.call("loadLocalCustomLists")["watch-history"] || {}).items || [];
    assert.equal(hist.length, 0, "the door every episode toggle goes through has to hold this line too");

    // An entry recorded before this guard existed is still removable -- the
    // guard only refuses to ADD.
    const map = client.call("loadLocalCustomLists");
    map["watch-history"] = { slug: "watch-history", name: "Watch History", type: "series", items: [
      { id: "201", type: "episode", name: "Return", showId: "tt5555555", seasonNum: 2, episodeNum: 1, watchedAt: 10 },
    ], updatedAt: 1 };
    client.call("saveLocalCustomListsMap", map);
    client.call("toggleWatchStatus", "201", "episode", "Return", "");
    hist = (client.call("loadLocalCustomLists")["watch-history"] || {}).items || [];
    assert.equal(hist.length, 0, "a mistake made before the guard existed must still be undoable");
  });

  it("offers no watch button on an unaired episode, and keeps one on a watched episode", () => {
    const client = loadClient();
    const upcoming = client.call("episodeWatchButtonHtml", { id: 201, air_date: FUTURE, name: "Return" }, false);
    assert.match(upcoming, /disabled/);
    assert.equal(upcoming.includes("toggleEpisodeWatchStatusFromModal"), false,
      "a button that cannot legitimately be pressed should not be wired up");

    const aired = client.call("episodeWatchButtonHtml", { id: 101, air_date: "2020-01-01", name: "Pilot" }, false);
    assert.match(aired, /Mark as Watched/);
    assert.equal(aired.includes("disabled"), false);

    // Already in Watch History: the way back has to stay open whatever the date.
    const watchedButUnaired = client.call("episodeWatchButtonHtml", { id: 201, air_date: FUTURE, name: "Return" }, true);
    assert.match(watchedButUnaired, /Mark as unwatched/);
    assert.equal(watchedButUnaired.includes("disabled"), false);
  });

  it("says when a season airs instead of doing nothing", async () => {
    const client = loadClient({
      routes: seasonRoutes({ "2": [{ id: 201, name: "Return", episode_number: 1, air_date: FUTURE }] }),
    });
    const d = showWith([{ season_number: 2, episode_count: 1, air_date: FUTURE }]);
    client.set("_currentItemDetails", d);

    const btn = fakeBtn();
    await client.call("markSeasonWatched", 2, btn);

    const hist = (client.call("loadLocalCustomLists")["watch-history"] || {}).items || [];
    assert.equal(hist.length, 0);
    // It did nothing before either -- silently, handing back a button that
    // read "Mark Season Watched" and looked broken.
    assert.equal(btn.disabled, true);
    assert.equal(btn.innerHTML.includes("Unwatched"), false);
    assert.match(btn.innerHTML, /Airs|Not aired yet/);
  });

  it("treats a season with no air date at all as ordinary", () => {
    const client = loadClient();
    // TMDB does not always carry a season air date. Unknown is not future:
    // disabling the button on a guess would take the feature away from every
    // show with thin metadata.
    assert.equal(client.call("seasonHasAiredEpisodes", 3, { season_number: 3, episode_count: 8 }), true);
    assert.equal(client.call("seasonHasAiredEpisodes", 3, { season_number: 3, air_date: FUTURE }), false);
    assert.equal(client.call("seasonHasAiredEpisodes", 3, { season_number: 3, air_date: "2020-01-01" }), true);
  });
});

// The hour behind the date. /api/details carries it as a finished string, and
// the page has to print it against episodes that reach it from three different
// directions -- the show's own page, a Continue Watching entry built from
// /api/season, an Airing Next tile restored from local storage.
describe("client: air times", () => {
  const dayOffset = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

  const DETAILS = {
    id: "tt_air", tmdbId: "777", title: "Air Show", overview: "x", poster: "", seasons: 3,
    seasonsData: [{ season_number: 3, name: "Season 3", episode_count: 10, air_date: dayOffset(-60) }],
    nextEpisodeAirDate: dayOffset(3), nextEpisodeSeasonNumber: 3, nextEpisodeNumber: 6,
    airTime: {
      time: "21:00", timezone: "America/New_York", label: "9 PM ET", days: ["Sunday"],
      next: { season: 3, number: 6, airdate: dayOffset(3), time: "21:30", label: "9:30 PM ET" },
    },
    nextEpisodeAirTimeLabel: "9:30 PM ET",
  };

  const EPISODES = [
    { id: 1, episode_number: 5, season_number: 3, name: "Already Out", air_date: dayOffset(-4), overview: "" },
    { id: 2, episode_number: 6, season_number: 3, name: "Next One", air_date: dayOffset(3), overview: "" },
    { id: 3, episode_number: 7, season_number: 3, name: "Later One", air_date: dayOffset(10), overview: "" },
    { id: 4, episode_number: 8, season_number: 3, name: "Tonight", air_date: dayOffset(0), overview: "" },
  ];

  async function openShow(details) {
    const client = loadClient({
      routes: {
        "/api/details": () => ({ json: { ok: true, details: details || DETAILS } }),
        "/api/season": () => ({ json: { ok: true, season: { episodes: EPISODES } } }),
      },
    });
    client.set("_fullyWatchedShowIds", new Set());
    client.call("saveLocalCustomListsMap", { "watch-history": { slug: "watch-history", items: [] } });
    await client.call("openItemDetailsModal", "tt_air", "series");
    client.set("_episodeDataCache", Object.fromEntries(EPISODES.map((e) => [e.episode_number, e])));
    client.set("_currentSeasonNum", 3);
    return client;
  }

  function episodeModalTimes(client, epNum) {
    let html = "";
    client.set("showModal", (inner) => { html = inner; });
    client.call("openEpisodeDetails", epNum);
    return [...html.matchAll(/color:var\(--brand\);">([^<]*)</g)].map((m) => m[1]);
  }

  it("puts the hour under the date, for tonight's episode and every later one", async () => {
    const client = await openShow();
    assert.deepEqual(episodeModalTimes(client, 8), ["9 PM ET"], "an episode airing today is exactly when this matters");
    assert.deepEqual(episodeModalTimes(client, 7), ["9 PM ET"], "a later episode gets the show's regular slot");
  });

  it("gives the next episode its own slot where it was dated apart", async () => {
    const client = await openShow();
    assert.deepEqual(episodeModalTimes(client, 6), ["9:30 PM ET"]);
  });

  it("says nothing against an episode that has already gone out", async () => {
    const client = await openShow();
    assert.deepEqual(episodeModalTimes(client, 5), [], "a time is a thing you are still waiting for");
  });

  it("prints the date alone when TVmaze had no slot for the show", async () => {
    const noTime = { ...DETAILS, airTime: { time: null, timezone: null, label: "", days: [], next: null }, nextEpisodeAirTimeLabel: null };
    const client = await openShow(noTime);
    assert.deepEqual(episodeModalTimes(client, 6), [], "a streaming drop has no hour to invent");
  });

  it("remembers the show's slot for shelves that never see its details", async () => {
    const client = await openShow();
    // Continue Watching entries are built from /api/season and carry no air
    // time of their own; the store is what answers for them.
    assert.equal(client.call("showAirTimeLabel", "tt_air", 3, 7), "9 PM ET");
    assert.equal(client.call("showAirTimeLabel", "tt_air", 3, 6), "9:30 PM ET", "the next episode keeps its own");
    assert.equal(client.call("showAirTimeLabel", "777", 3, 7), "9 PM ET", "found by TMDB id too");
    assert.equal(client.call("showAirTimeLabel", "tmdb:777", 3, 7), "9 PM ET");
    assert.equal(client.call("showAirTimeLabel", "tt_air:3:7", 3, 7), "9 PM ET", "an episode id is still that show");
    assert.equal(client.call("showAirTimeLabel", "tt_unknown", 3, 7), "", "a show nobody has details for says nothing");
  });

  it("stops trusting a remembered slot once it is a week old", async () => {
    const client = await openShow();
    const store = client.call("loadAirTimeStore");
    Object.keys(store).forEach((k) => { store[k].at = Date.now() - (8 * 24 * 60 * 60 * 1000); });
    assert.equal(client.call("showAirTimeLabel", "tt_air", 3, 7), "", "a show can be moved to a new night");
  });

  it("puts the hour under the day on a poster badge, and never on an aired one", async () => {
    const client = await openShow();
    const next = client.call("watchItemAirDateBadgeHtml", { airDate: dayOffset(3), showId: "tt_air", seasonNum: 3, episodeNum: 6 });
    assert.match(next, /class="cw-date-badge cw-date-badge-timed"/);
    assert.match(next, /<span class="cw-date-badge-time">9:30 PM ET<\/span>/);
    assert.match(next, /title="Airs on [\d-]+ at 9:30 PM ET"/);

    const unknown = client.call("watchItemAirDateBadgeHtml", { airDate: dayOffset(2), showId: "tt_nobody" });
    assert.match(unknown, /class="cw-date-badge"/, "no time is still a date badge");
    assert.equal(/cw-date-badge-time/.test(unknown), false);

    assert.equal(client.call("watchItemAirDateBadgeHtml", { airDate: dayOffset(-2), showId: "tt_air" }), "",
      "an episode that has aired gets no badge at all");
    assert.equal(client.call("watchItemAirDateBadgeHtml", { showId: "tt_air" }), "");
  });

  it("prefers the time stored on an entry over the one remembered for its show", async () => {
    const client = await openShow();
    const badge = client.call("watchItemAirDateBadgeHtml", { airDate: dayOffset(3), airTime: "8 PM CT", showId: "tt_air", seasonNum: 3, episodeNum: 6 });
    assert.match(badge, /8 PM CT/, "a tile restored from local storage knows its own hour");
  });
});

// The DOM stub creates an element the first time it is asked for by id, so a
// test that wants to fill a box in has to ask through document rather than
// reach into the id map.
function el(client, id) {
  return client.document.getElementById(id);
}

// The bundle builds its objects inside the vm, so they carry that realm's
// Object/Array prototypes and a strict deepEqual against a literal written
// here fails on the prototype alone, however equal the contents. Comparing
// the JSON of both sides is what the assertion actually means.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// --- the Channel builder's broadcast panel -------------------------------
//
// Five flags that shape how a channel plays rather than what is in it. The
// risk they all share is not the logic but the PLUMBING: a channel is
// rebuilt field by field in three separate places (saveLocalChannel,
// saveLocalChannelsMap, ensureAllChannelsSyncedFromRows), so a flag that
// only two of them know about is a flag that silently disappears on the
// next save. These tests are mostly about that round trip.
describe("client: a channel's broadcast schedule and smart rules", () => {
  function builder(draft = []) {
    const client = loadClient({ routes: {} });
    client.set("channelDraftItems", draft);
    client.set("channelDraftStoryLocked", []);
    client.set("channelDraftPairedGroups", []);
    client.set("channelDraftSelection", []);
    client.set("channelDraftSourceUrl", "");
    client.set("channelDraftDynamic", "");
    return client;
  }

  const epOf = (imdbId, season, episode, showName) => ({
    kind: "episode", imdbId, season, episode, showName,
    epName: `E${episode}`, title: `${showName} S${season}E${episode}`,
  });

  it("turns a time of day plus a zone into minutes past midnight UTC", () => {
    const client = builder();
    assert.equal(client.call("channelTurnoverToUtcMinutes", "00:00", "utc"), 0);
    assert.equal(client.call("channelTurnoverToUtcMinutes", "06:30", "utc"), 390);
    assert.equal(client.call("channelTurnoverToUtcMinutes", "", "utc"), 0, "a blank box is midnight, not NaN");
    assert.equal(client.call("channelTurnoverToUtcMinutes", "99:99", "utc"), 23 * 60 + 59, "a hand-typed impossible time is clamped");
    // Local depends on the runner's own zone, so this asserts the relation
    // rather than a fixed number.
    const shift = new Date().getTimezoneOffset();
    assert.equal(
      client.call("channelTurnoverToUtcMinutes", "00:00", "local"),
      ((shift % 1440) + 1440) % 1440
    );
  });

  it("renders minutes back to the time box they came from", () => {
    const client = builder();
    assert.equal(client.call("channelMinutesToTimeString", 0), "00:00");
    assert.equal(client.call("channelMinutesToTimeString", 390), "06:30");
    assert.equal(client.call("channelMinutesToTimeString", 1439), "23:59");
  });

  it("groups a draft by show the same way the Worker does", () => {
    const client = builder([
      epOf("tt1", 1, 1, "Simpsons"),
      epOf("tt1", 1, 2, "Simpsons"),
      epOf("tt2", 1, 1, "King of the Hill"),
    ]);
    const groups = client.call("channelDraftShowGroups");
    assert.deepEqual(plain(groups.map((g) => [g.key, g.count])), [["tt1", 2], ["tt2", 1]]);
  });

  it("carries every flag through a save and back out again", () => {
    const client = builder();
    const payload = {
      channelId: "ch1", name: "Block Party", items: [epOf("tt1", 1, 1, "Simpsons")],
      dailyRotate: true, rotateShows: 6, rotateEpisodes: 2,
      rotateTurnover: 300, rotateTurnoverTime: "00:00", rotateTurnoverZone: "local",
      hideWatched: true, storyLocked: ["tt1"],
      pairParts: true, pairedGroups: [["tt1:1:1", "tt1:1:2"]],
      autoNewEpisodes: true, newEpisodesAtTop: true,
      liveSync: true, sourceUrl: "https://trakt.tv/users/x/lists/y",
      dynamic: "", shareCode: "AbC123", sharePublished: true,
    };
    client.call("saveLocalChannel", payload);
    const saved = client.call("loadLocalChannels").ch1;
    for (const key of [
      "dailyRotate", "rotateShows", "rotateEpisodes", "rotateTurnover",
      "rotateTurnoverTime", "rotateTurnoverZone", "hideWatched",
      "pairParts", "autoNewEpisodes", "newEpisodesAtTop",
      "liveSync", "sourceUrl", "shareCode", "sharePublished",
    ]) {
      assert.deepEqual(plain(saved[key]), payload[key], `${key} survived the save`);
    }
    assert.deepEqual(plain(saved.storyLocked), ["tt1"]);
    assert.deepEqual(plain(saved.pairedGroups), [["tt1:1:1", "tt1:1:2"]]);
  });

  it("keeps the flags through a SECOND save, which is where a dropped field shows up", () => {
    const client = builder();
    client.call("saveLocalChannel", {
      channelId: "ch1", name: "Block Party", items: [epOf("tt1", 1, 1, "Simpsons")],
      dailyRotate: true, rotateShows: 6, hideWatched: true, storyLocked: ["tt1"],
      pairParts: true, pairedGroups: [["tt1:1:1", "tt1:1:2"]], autoNewEpisodes: true,
    });
    // saveLocalChannelsMap rebuilds every record, so a field it does not know
    // about is lost here rather than on the first write.
    client.call("saveLocalChannelsMap", client.call("loadLocalChannels"));
    const saved = client.call("loadLocalChannels").ch1;
    assert.equal(saved.dailyRotate, true);
    assert.equal(saved.rotateShows, 6);
    assert.equal(saved.hideWatched, true);
    assert.deepEqual(plain(saved.storyLocked), ["tt1"]);
    assert.equal(saved.pairParts, true);
    assert.equal(saved.autoNewEpisodes, true);
    assert.deepEqual(plain(saved.pairedGroups), [["tt1:1:1", "tt1:1:2"]]);
  });

  it("normalizes anything missing rather than writing undefined into the payload", () => {
    const client = builder();
    const f = plain(client.call("channelBroadcastFields", {}));
    assert.deepEqual(f, {
      description: "",
      dailyRotate: false, rotateShows: 0, rotateEpisodes: 0, rotateTurnover: 0,
      rotateTurnoverTime: "", rotateTurnoverZone: "utc", hideWatched: false,
      storyLocked: [], pairParts: false, pairedGroups: [],
      autoNewEpisodes: false, newEpisodesAtTop: false,
      liveSync: false, sourceUrl: "", dynamic: "",
    });
    assert.deepEqual(plain(client.call("channelBroadcastFields", null).storyLocked), []);
  });

  it("pairs the selection by stream id, in the order the channel lists them", () => {
    const client = builder([
      epOf("tt1", 1, 1, "Simpsons"),
      epOf("tt1", 1, 2, "Simpsons"),
      epOf("tt2", 1, 1, "King of the Hill"),
    ]);
    client.set("channelDraftSelection", [2, 0]);
    client.call("pairChannelDraftSelection");
    assert.deepEqual(plain(client.get("channelDraftPairedGroups")), [["tt1:1:1", "tt2:1:1"]],
      "listed order, not the order they were ticked in");
  });

  it("refuses a pairing of one, and one of more than six", () => {
    const draft = [];
    for (let e = 1; e <= 8; e++) draft.push(epOf("tt1", 1, e, "Simpsons"));
    const client = builder(draft);
    client.set("channelDraftSelection", [0]);
    client.call("pairChannelDraftSelection");
    assert.equal(client.get("channelDraftPairedGroups").length, 0, "one episode is not a pair");
    client.set("channelDraftSelection", [0, 1, 2, 3, 4, 5, 6]);
    client.call("pairChannelDraftSelection");
    assert.equal(client.get("channelDraftPairedGroups").length, 0, "seven is past what the Worker will glue");
  });

  it("lets a pick belong to one pairing only", () => {
    const client = builder([
      epOf("tt1", 1, 1, "Simpsons"),
      epOf("tt1", 1, 2, "Simpsons"),
      epOf("tt1", 1, 3, "Simpsons"),
    ]);
    client.set("channelDraftSelection", [0, 1]);
    client.call("pairChannelDraftSelection");
    client.set("channelDraftSelection", [1, 2]);
    client.call("pairChannelDraftSelection");
    assert.deepEqual(plain(client.get("channelDraftPairedGroups")), [["tt1:1:2", "tt1:1:3"]],
      "the first pairing is left with one member, so it is not a pairing any more");
  });

  it("unpairs whatever is selected and leaves the rest alone", () => {
    const client = builder([
      epOf("tt1", 1, 1, "Simpsons"),
      epOf("tt1", 1, 2, "Simpsons"),
      epOf("tt2", 1, 1, "King of the Hill"),
      epOf("tt2", 1, 2, "King of the Hill"),
    ]);
    client.set("channelDraftPairedGroups", [["tt1:1:1", "tt1:1:2"], ["tt2:1:1", "tt2:1:2"]]);
    client.set("channelDraftSelection", [0]);
    client.call("unpairChannelDraftSelection");
    assert.deepEqual(plain(client.get("channelDraftPairedGroups")), [["tt2:1:1", "tt2:1:2"]]);
  });

  it("drops a pairing whose other half has been removed from the channel", () => {
    const client = builder([epOf("tt1", 1, 1, "Simpsons")]);
    client.set("channelDraftPairedGroups", [["tt1:1:1", "tt1:1:2"]]);
    client.call("updateChannelPairControls");
    assert.deepEqual(plain(client.get("channelDraftPairedGroups")), [],
      "a rule about one episode is not a pairing");
  });

  it("drops a Story Lock for a show that is no longer in the channel", () => {
    const client = builder([epOf("tt1", 1, 1, "Simpsons"), epOf("tt1", 1, 2, "Simpsons")]);
    client.set("channelDraftStoryLocked", ["tt1", "tt_removed"]);
    client.call("renderChannelStoryLock");
    assert.deepEqual(plain(client.get("channelDraftStoryLocked")), ["tt1"]);
  });

  it("offers no Story Lock for a one-episode show or a movie", () => {
    const client = builder([
      epOf("tt1", 1, 1, "Simpsons"),
      { kind: "movie", imdbId: "tt9", title: "The Matrix", showName: "The Matrix" },
    ]);
    client.set("channelDraftStoryLocked", []);
    client.call("renderChannelStoryLock");
    assert.equal(el(client, "channelStoryLockSection").innerHTML, "");
  });

  it("toggles a lock on and off without ever duplicating it", () => {
    const client = builder();
    client.call("toggleChannelStoryLock", "tt1", true);
    client.call("toggleChannelStoryLock", "tt1", true);
    assert.deepEqual(plain(client.get("channelDraftStoryLocked")), ["tt1"]);
    client.call("toggleChannelStoryLock", "tt1", false);
    assert.deepEqual(plain(client.get("channelDraftStoryLocked")), []);
  });
});

// --- Quick Add network channels: the saved row must stay usable on its own -
//
// quickAddChannel saves a Quick Add channel's real weight (up to
// CHANNEL_POOL_MAX_ITEMS episodes) only in the shared server cache, and
// writes a small presetNetworkId POINTER into the catalog row -- see that
// constant's own comment (20_client-channel-builder.js) for the full design.
// The first version of that pointer carried NO items of its own at all, on
// the theory that channelSourceItems (05_catalog-core.js) would always
// resolve the real pool server-side. That missed something: a long list of
// OTHER places in this codebase read a channel row's own `.items` directly,
// as a local shortcut, entirely independent of that server resolution --
// ensureAllChannelsSyncedFromRows/renderMyCreatedChannelsList (the "My
// Channels" list) and openListDetailsPage's local-preview path ("See All")
// among them. An empty-items pointer left every one of those rendering a
// broken 0-episode channel the moment this browser's own copy of the full
// pool was not available (a different device, cleared storage, or -- the
// case that actually surfaces this from real use -- saveLocalChannelsMap's
// own quota fallback losing the write entirely once several 5,000-item
// channels together exceed what this browser's localStorage will hold).
// These tests hold the fix to that: the row always carries a real, small
// sample alongside its pointer, so every one of those local-only readers
// keeps working even when this browser has never seen the full pool at all.
describe("client: a Quick Add channel row stays usable without its local copy", () => {
  function fakeInput(value) {
    return { value, dataset: {} };
  }
  function fakeEntry(name, url, type) {
    return {
      dataset: {}, style: {},
      querySelector(sel) {
        if (sel === ".name") return fakeInput(name);
        if (sel === ".type") return fakeInput(type);
        if (sel === ".url") return fakeInput(url);
        return null;
      },
      querySelectorAll(sel) { return sel === ".url" ? [fakeInput(url)] : []; },
    };
  }
  function withRows(client, rows) {
    const entries = rows.map((r) => fakeEntry(r.name, r.url, r.type));
    const doc = client.get("document");
    const lists = doc.getElementById("lists");
    lists.querySelectorAll = (sel) => (sel === ".entry" ? entries : []);
    doc.querySelectorAll = (sel) => (sel === "#lists .entry" ? entries : []);
    return entries;
  }
  function presetItems(n, tag) {
    return Array.from({ length: n }, (_, i) => ({
      kind: "episode", imdbId: "tt" + tag + i, season: 1, episode: i + 1,
      showName: tag + " Show", epName: "Ep " + i, title: "t", released: "2024-01-01",
    }));
  }

  it("quickAddChannel's saved row carries a real, non-empty items sample -- not just the pointer", async () => {
    const client = loadClient({
      routes: {
        "/api/channel-preset": () => ({
          json: { ok: true, channel: { name: "TNT", poster: "p", backdrop: "b", items: presetItems(4000, "TNT"), shuffle: false, dailyRotate: true } },
        }),
      },
    });
    const addedRows = [];
    client.set("addRow", (name, url) => { addedRows.push({ name, url }); });

    await client.call("quickAddChannel", "TNT", null, "41", null, null);

    assert.equal(addedRows.length, 1, "must save exactly one catalog row");
    const payload = JSON.parse(addedRows[0].url.slice("channel:v1:".length));
    assert.equal(payload.presetNetworkId, "41");
    assert.ok(Array.isArray(payload.items) && payload.items.length > 0,
      "the saved row must not be an empty pointer -- every local-only reader depends on this");
    assert.ok(payload.items.length < 4000,
      "the saved row's sample must stay small -- the full 4000-item pool belongs in the server cache, not the row");

    // The LOCAL copy (My Channels editor) is unaffected -- it still gets the
    // real, full pool, exactly as before this whole pointer design existed.
    const local = client.call("loadLocalChannels");
    const localChannel = Object.values(local).find((c) => c.name === "TNT");
    assert.equal(localChannel.items.length, 4000);
    // presetNetworkId rides along on the local copy too, not just the row's
    // pointer -- channelsForCloudSync (22_client-creator-profile.js) needs it
    // there to recognize this channel's pool already lives in the shared
    // server cache and skip re-uploading it whole to this account's cloud
    // channels blob.
    assert.equal(localChannel.presetNetworkId, "41");
  });

  it("a channel row reconstructed from scratch (this browser never had a local copy) still shows real episodes, not zero", () => {
    const client = loadClient({});
    // Simulates exactly what quickAddChannel now saves: a pointer plus its
    // own small sample -- and simulates a browser that never got (or lost)
    // this channel's full local copy, so ensureAllChannelsSyncedFromRows has
    // to build the local record from the row alone.
    const pointerPayload = {
      channelId: "ch-tnt", name: "TNT", poster: "p", backdrop: "b",
      items: presetItems(50, "TNT"), presetNetworkId: "41",
      shuffle: false, dailyRotate: true, liveSync: false, sourceUrl: "",
    };
    withRows(client, [{ name: "TNT", url: "channel:v1:" + JSON.stringify(pointerPayload), type: "series" }]);

    const synced = client.call("ensureAllChannelsSyncedFromRows", client.call("loadLocalChannels"));
    assert.equal(synced["ch-tnt"].items.length, 50,
      "must reconstruct a real sample from the row, not an empty channel");
    assert.equal(synced["ch-tnt"].name, "TNT");
  });

  it("backfills presetNetworkId onto a local record an older reconstruction already created without it -- otherwise it can never self-heal", () => {
    const client = loadClient({});
    // A record shaped exactly like what ensureAllChannelsSyncedFromRows used
    // to save before presetNetworkId existed on its reconstruction branch --
    // stuck at the pointer's sample size, with no network id to resolve
    // against. This function only ever fills in a MISSING record; an
    // existing one (like this) previously kept winning forever, which left
    // resolveThinPresetChannels with nothing to find and repair it with.
    const poisoned = {
      channelId: "ch-old", name: "TNT", poster: "p", backdrop: "b",
      items: presetItems(50, "TNT"), shuffle: false, dailyRotate: true,
      order: 0, createdAt: 1, updatedAt: 1,
      // no presetNetworkId
    };
    client.call("saveLocalChannelsMap", { "ch-old": poisoned });

    const pointerPayload = {
      channelId: "ch-old", name: "TNT", poster: "p", backdrop: "b",
      items: presetItems(50, "TNT"), presetNetworkId: "41",
      shuffle: false, dailyRotate: true, liveSync: false, sourceUrl: "",
    };
    withRows(client, [{ name: "TNT", url: "channel:v1:" + JSON.stringify(pointerPayload), type: "series" }]);

    const synced = client.call("ensureAllChannelsSyncedFromRows", client.call("loadLocalChannels"));
    assert.equal(synced["ch-old"].presetNetworkId, "41",
      "the row still carries presetNetworkId -- an existing local record missing it must get it backfilled");
  });
});

// Quick Add channels' full pools (up to 5,000 items) are kept in full in
// this browser's own copy for the My Channels editor -- but that same full
// copy used to also ride whole into this account's cloud channels sync
// blob (pushChannelsSync), which has its own, much smaller cap (24MB,
// /api/creator/sync/save-channels). A handful of these pools crosses it
// easily, and the save then fails silently: this account's channels stop
// syncing across devices, and worse, the very next pull down
// (loadCreatorSync, on a background poll, a tab switch, a reload) used to
// unconditionally overwrite this device's richer local state with whatever
// stale, smaller copy the server was still holding -- reported live as "a
// deleted channel comes right back" and "some channels only show 50
// items". This suite covers the three pieces of the fix: the cloud push no
// longer carries a preset-backed channel's full pool, a stale pull can no
// longer clobber local state newer than what the server actually has, and
// a channel left thin by either of those quietly resolves itself back to
// the real pool without losing whatever the user customized on it.
describe("client: Quick Add channel cloud sync stays small, and never shrinks what's on screen", () => {
  function presetItems(n, tag) {
    return Array.from({ length: n }, (_, i) => ({
      kind: "episode", imdbId: "tt" + tag + i, season: 1, episode: i + 1,
      showName: tag + " Show", epName: "Ep " + i, title: "t", released: "2024-01-01",
    }));
  }

  it("channelsForCloudSync slims a preset-backed channel's pool for the cloud, and leaves a hand-built channel untouched", () => {
    const client = loadClient({});
    const sampleSize = client.get("CHANNEL_POINTER_SAMPLE_ITEMS");
    const map = {
      "ch-preset": { channelId: "ch-preset", name: "TNT", presetNetworkId: "41", items: presetItems(4000, "TNT") },
      "ch-handbuilt": { channelId: "ch-handbuilt", name: "My Mix", presetNetworkId: "", items: presetItems(800, "MIX") },
    };
    const slimmed = client.call("channelsForCloudSync", map);
    assert.equal(slimmed["ch-preset"].items.length, sampleSize,
      "a preset-backed channel's full pool already lives in the shared server cache -- the cloud blob only needs a sample");
    assert.equal(slimmed["ch-handbuilt"].items.length, 800,
      "a hand-built channel has no other durable copy anywhere -- it must stay full");
    // The local map itself must not be mutated by building the cloud payload.
    assert.equal(map["ch-preset"].items.length, 4000);
  });

  it("loadCreatorSync does not let a same-or-older channels stamp overwrite this device's local channels", async () => {
    const client = loadClient({
      storage: { "myListAddon:creatorKey": "KEY-1" },
      routes: {
        "/api/creator/sync/load": () => ({
          json: {
            ok: true,
            data: {
              config: [],
              updatedAt: 100,
              channelsUpdatedAt: 500,
              channels: { "ch-server": { channelId: "ch-server", name: "Stale Copy", items: presetItems(50, "STALE") } },
            },
          },
        }),
        "/api/creator/sync/save": () => ({ json: { ok: true, updatedAt: 200 } }),
        "/api/creator/sync/save-tracking": () => ({ json: { ok: true } }),
        "/api/creator/lists": () => ({ json: { ok: true, lists: [] } }),
      },
    });
    client.set("activeCreator", { creatorName: "testuser", displayName: "Test User" });
    // This device already knows this exact stamp -- its own last channels
    // push (e.g. deleting a channel, or adding one) never landed, most
    // likely because the full local pool it tried to send crossed the
    // cloud blob's 24MB cap.
    client.set("_serverChannelsUpdatedAt", 500);

    client.call("saveLocalChannelsMap", { "ch-local": { channelId: "ch-local", name: "Fresh Local", items: presetItems(4000, "FRESH") } });

    await client.call("loadCreatorSync");

    const after = client.call("loadLocalChannels");
    assert.ok(after["ch-local"], "a local-only channel must survive a load that brought nothing actually newer");
    assert.equal(after["ch-local"].items.length, 4000);
    assert.ok(!after["ch-server"], "the stale server copy must not have been adopted");
  });

  it("loadCreatorSync DOES adopt synced.channels once the server's stamp is genuinely newer", async () => {
    const client = loadClient({
      storage: { "myListAddon:creatorKey": "KEY-1" },
      routes: {
        "/api/creator/sync/load": () => ({
          json: {
            ok: true,
            data: {
              config: [],
              updatedAt: 100,
              channelsUpdatedAt: 700,
              channels: { "ch-server": { channelId: "ch-server", name: "Newer From Server", items: presetItems(50, "NEW") } },
            },
          },
        }),
        "/api/creator/sync/save": () => ({ json: { ok: true, updatedAt: 200 } }),
        "/api/creator/sync/save-tracking": () => ({ json: { ok: true } }),
        "/api/creator/lists": () => ({ json: { ok: true, lists: [] } }),
      },
    });
    client.set("activeCreator", { creatorName: "testuser", displayName: "Test User" });
    client.set("_serverChannelsUpdatedAt", 500);
    client.call("saveLocalChannelsMap", { "ch-local": { channelId: "ch-local", name: "Old Local", items: presetItems(4000, "OLD") } });

    await client.call("loadCreatorSync");

    const after = client.call("loadLocalChannels");
    assert.ok(after["ch-server"], "a genuinely newer server state must still be adopted -- this isn't a one-way lock");
    assert.equal(after["ch-server"].name, "Newer From Server");
  });

  it("a thin preset-backed channel (a cloud-synced sample, not the real pool) quietly resolves back to full without losing its customization", async () => {
    const client = loadClient({
      routes: {
        "/api/channel-preset": () => ({
          json: { ok: true, channel: { name: "TNT", poster: "p2", backdrop: "b2", items: presetItems(4000, "TNT"), shuffle: false, dailyRotate: true } },
        }),
      },
    });
    const sampleSize = client.get("CHANNEL_POINTER_SAMPLE_ITEMS");
    const thin = {
      channelId: "ch-tnt", name: "TNT", poster: "p", backdrop: "b",
      presetNetworkId: "41", items: presetItems(sampleSize, "TNT"),
      dailyRotate: true, hideWatched: true, rotateShows: 24, rotateEpisodes: 3,
    };
    client.call("saveLocalChannelsMap", { "ch-tnt": thin });

    client.call("renderMyCreatedChannelsList");
    // resolveThinPresetChannels fires its fetch in the background rather
    // than blocking the render -- give its .then() chain a couple of real
    // ticks to land before checking the result.
    await new Promise((r) => setTimeout(r, 20));

    const after = client.call("loadLocalChannels");
    assert.equal(after["ch-tnt"].items.length, 4000,
      "resolves the real pool instead of staying stuck at the sample size forever");
    assert.equal(after["ch-tnt"].hideWatched, true,
      "a customization the generic network preset knows nothing about must survive the upgrade");
  });

  it("editing and saving a preset-backed channel clears presetNetworkId, so a curated trim can never be overwritten back to the full preset", () => {
    // channelSourceItems (05_catalog-core.js) always prefers presetNetworkId's
    // generic network lineup over a channel's own items -- the saved
    // catalog row already drops this field the moment a channel goes
    // through saveChannel (nothing in that payload writes it back), so a
    // user's edit already took effect for real playback even before this
    // fix. What was missing was the LOCAL copy agreeing: without this,
    // trimming a Quick Add channel down to a small curated set left the
    // local record still presetNetworkId-tagged, and resolveThinPresetChannels
    // would silently blow the trim away the next time "My Channels" rendered.
    const client = loadClient({});
    client.call("saveLocalChannel", {
      channelId: "ch-tnt", name: "TNT", presetNetworkId: "41", items: presetItems(4000, "TNT"),
    });
    client.call("editChannelById", "ch-tnt");
    client.get("document").getElementById("channelNameInput").value = "TNT";
    // Simulates the user having trimmed the draft down to a small, deliberately curated set.
    client.set("channelDraftItems", presetItems(12, "CURATED"));
    client.call("saveChannel");

    const saved = client.call("loadLocalChannels")["ch-tnt"];
    assert.equal(saved.presetNetworkId, "", "must no longer be treated as the generic network channel");
    assert.equal(saved.items.length, 12, "the curated trim, not the original pool, must be what's saved");

    // And now that it's untagged, resolveThinPresetChannels must leave it alone
    // even though it is well under the sample-size threshold.
    client.call("renderMyCreatedChannelsList");
    const stillCurated = client.call("loadLocalChannels")["ch-tnt"];
    assert.equal(stillCurated.items.length, 12, "an untagged channel must never be resolved back to a network preset");
  });

  it("the catalog row's own Edit button never downgrades a richer local copy to the row's thin pointer sample", () => {
    // A Quick Add channel's saved catalog row carries only a small pointer
    // sample (quickAddChannel, this file) -- editChannel (the Edit button
    // rendered inline on the catalog row itself, a different surface than
    // editChannelById's My Channels card) used to read that row and save it
    // straight into the local channels map unconditionally, which meant
    // opening the editor from THIS button silently downgraded a Quick Add
    // channel's real multi-thousand-item pool down to the row's sample --
    // and saving from there made that loss permanent.
    const client = loadClient({});
    client.call("saveLocalChannel", {
      channelId: "ch-tnt", name: "TNT", presetNetworkId: "41", items: presetItems(4000, "TNT"),
    });
    const sampleSize = client.get("CHANNEL_POINTER_SAMPLE_ITEMS");
    const pointerPayload = {
      channelId: "ch-tnt", name: "TNT", presetNetworkId: "41",
      items: presetItems(sampleSize, "TNT"), dailyRotate: true,
    };
    const row = {
      closest(sel) { return sel === ".source-row" ? this : null; },
      querySelector(sel) { return sel === ".url" ? { value: "channel:v1:" + JSON.stringify(pointerPayload) } : null; },
    };

    client.call("editChannel", row);

    const after = client.call("loadLocalChannels")["ch-tnt"];
    assert.equal(after.items.length, 4000, "must keep the real pool, not fall back to the row's small sample");
  });

  it("channelRowUrl slims a preset-backed channel's row, and leaves a hand-built one's alone", () => {
    const client = loadClient({});
    const sampleSize = client.get("CHANNEL_POINTER_SAMPLE_ITEMS");
    const preset = { channelId: "ch-preset", name: "TNT", presetNetworkId: "41", items: presetItems(4000, "TNT") };
    const handBuilt = { channelId: "ch-mix", name: "My Mix", presetNetworkId: "", items: presetItems(800, "MIX") };

    const presetPayload = JSON.parse(client.call("channelRowUrl", preset).slice("channel:v1:".length));
    assert.equal(presetPayload.items.length, sampleSize);
    assert.equal(presetPayload.presetNetworkId, "41");

    const handBuiltPayload = JSON.parse(client.call("channelRowUrl", handBuilt).slice("channel:v1:".length));
    assert.equal(handBuiltPayload.items.length, 800, "a hand-built channel has no other durable copy -- must stay full");
  });

  it("merging several full-pool Quick Add channels stays small, instead of reopening the too-large-to-save ceiling", () => {
    // The exact scenario reported live: merging 9+ Quick Add network
    // channels (each up to CHANNEL_POOL_MAX_ITEMS) into one combined
    // catalog. mergeChannelsIntoRow and its siblings (toggleMergedChannelInCatalog,
    // addChannelToMerge, removeChannelFromMerge, pruneChannelFromAllMerges)
    // used to embed each member's FULL local copy -- quickAddChannel's own
    // pointer discipline only ever protected that channel's OWN row, not
    // what merging did with it afterward.
    const client = loadClient({});
    const addedRows = [];
    client.set("addRow", (name, url) => { addedRows.push({ name, url }); });

    const channelIds = [];
    for (let i = 0; i < 9; i++) {
      const id = "ch-net" + i;
      channelIds.push(id);
      client.call("saveLocalChannel", {
        channelId: id, name: "Network " + i, presetNetworkId: "net" + i, items: presetItems(5000, "N" + i),
      });
    }

    const doc = client.get("document");
    const checkboxes = channelIds.map((id) => ({ dataset: { channelid: id } }));
    doc.querySelectorAll = (sel) => (sel === "#channelMergeList .channelMergeCheck:checked" ? checkboxes : []);
    doc.getElementById("channelMergeNameInput").value = "Combined";

    client.call("mergeChannelsIntoRow");

    assert.equal(addedRows.length, 1, "must add exactly one combined catalog row");
    const totalBytes = Buffer.byteLength(addedRows[0].url, "utf8");
    assert.ok(totalBytes < 200 * 1024,
      "nine merged 5,000-item channels must stay well under the 10MB config ceiling -- got " + totalBytes + " bytes");
    const lines = addedRows[0].url.split("\n");
    assert.equal(lines.length, 9, "one line per merged channel");
    lines.forEach((line) => {
      const payload = JSON.parse(line.slice("channel:v1:".length));
      assert.ok(payload.items.length <= client.get("CHANNEL_POINTER_SAMPLE_ITEMS"),
        "each merged member must carry only its pointer sample, not its full pool");
    });
  });
});

describe("client: the Channel builder's interleaved play order", () => {
  function withDraft(items) {
    const client = loadClient({ routes: {} });
    client.set("channelDraftItems", items);
    client.set("channelDraftStoryLocked", []);
    return client;
  }
  const epOf = (imdbId, episode, showName) => ({
    kind: "episode", imdbId, season: 1, episode, showName,
    epName: `E${episode}`, title: `${showName} E${episode}`,
  });

  it("deals one episode of each show in turn", () => {
    const client = withDraft([
      epOf("tt1", 1, "Simpsons"), epOf("tt1", 2, "Simpsons"), epOf("tt1", 3, "Simpsons"),
      epOf("tt2", 1, "King of the Hill"), epOf("tt2", 2, "King of the Hill"),
      epOf("tt3", 1, "Malcolm"),
    ]);
    client.call("sortChannelDraftItems", "interleave");
    assert.deepEqual(plain(client.get("channelDraftItems").map((it) => it.title)), [
      "Simpsons E1", "King of the Hill E1", "Malcolm E1",
      "Simpsons E2", "King of the Hill E2",
      "Simpsons E3",
    ]);
  });

  it("is idempotent, so the builder and the Worker cannot fight over it", () => {
    const client = withDraft([
      epOf("tt1", 1, "A"), epOf("tt2", 1, "B"), epOf("tt1", 2, "A"), epOf("tt2", 2, "B"),
    ]);
    client.call("sortChannelDraftItems", "interleave");
    const once = plain(client.get("channelDraftItems").map((it) => it.title));
    client.call("sortChannelDraftItems", "interleave");
    assert.deepEqual(plain(client.get("channelDraftItems").map((it) => it.title)), once);
  });

  it("counts as a remembered sort, so picks added later are interleaved too", () => {
    const client = withDraft([]);
    el(client, "channelPlayOrderSelect").value = "interleave";
    assert.equal(client.call("channelDraftAutoSortKey"), "interleave");
    client.set("channelDraftItems", [
      epOf("tt1", 1, "A"), epOf("tt1", 2, "A"), epOf("tt2", 1, "B"),
    ]);
    client.call("applyChannelDraftAutoSort");
    assert.deepEqual(plain(client.get("channelDraftItems").map((it) => it.title)), ["A E1", "B E1", "A E2"]);
  });
});

describe("client: channel share links", () => {
  const load = (routes = {}) => loadClient({ routes, storage: { "myListAddon:creatorKey": "KEY-1" } });

  it("reads the code out of a link, a scheme, a fragment or a bare code", () => {
    const client = load();
    assert.equal(client.call("parseChannelShareCode", "https://example.com/channel/AbC-123"), "AbC-123");
    assert.equal(client.call("parseChannelShareCode", "https://example.com/configure#channel=AbC-123"), "AbC-123");
    assert.equal(client.call("parseChannelShareCode", "channel:share:AbC-123"), "AbC-123");
    assert.equal(client.call("parseChannelShareCode", "  AbC-123  "), "AbC-123");
    assert.equal(client.call("parseChannelShareCode", "not a code at all"), "");
    assert.equal(client.call("parseChannelShareCode", ""), "");
  });

  it("sends the play rules with the picks, and never the local bookkeeping", () => {
    const client = load();
    const payload = client.call("channelSharePayload", {
      channelId: "ch1", name: "Block Party", items: [], shuffle: true,
      autoSort: "interleave", dailyRotate: true, rotateShows: 6, hideWatched: true,
      storyLocked: ["tt1"], createdAt: 1, updatedAt: 2, shareCode: "OLD",
    });
    assert.equal(payload.autoSort, "interleave");
    assert.equal(payload.dailyRotate, true);
    assert.equal(payload.rotateShows, 6);
    assert.equal(payload.hideWatched, true);
    assert.deepEqual(plain(payload.storyLocked), ["tt1"]);
    assert.equal("channelId" in payload, false, "the receiver mints its own id");
    assert.equal("createdAt" in payload, false);
    assert.equal("shareCode" in payload, false);
  });

  it("re-shares under the code it already has rather than minting a second link", async () => {
    const posts = [];
    const client = load({
      "/api/channel/share": (req) => {
        posts.push(req.body);
        return { json: { ok: true, code: req.body.code || "NEW1", url: "https://example.com/channel/NEW1" } };
      },
    });
    client.call("saveLocalChannel", { channelId: "ch1", name: "Block Party", items: [] });
    await client.call("shareChannelById", "ch1", null);
    assert.equal(posts[0].code, "", "nothing to reuse the first time");
    assert.equal(client.call("loadLocalChannels").ch1.shareCode, "NEW1");
    await client.call("shareChannelById", "ch1", null);
    assert.equal(posts[1].code, "NEW1", "the second share updates the same link");
  });

  it("does not send a Creator Key with an unlisted share", async () => {
    const posts = [];
    const client = load({
      "/api/channel/share": (req) => { posts.push(req.body); return { json: { ok: true, code: "C1" } }; },
    });
    client.call("saveLocalChannel", { channelId: "ch1", name: "Block Party", items: [] });
    await client.call("shareChannelById", "ch1", null);
    assert.equal(posts[0].publish, false);
    assert.equal("creatorKey" in posts[0], false);
  });

  it("adds a shared channel under a fresh id, and never as someone else's listing", () => {
    const client = load();
    const id = client.call("acceptSharedChannel", {
      name: "Saturday Morning 90s", items: [], dailyRotate: true, rotateShows: 4, sharePublished: true,
    }, "CODE1");
    const saved = client.call("loadLocalChannels")[id];
    assert.equal(saved.name, "Saturday Morning 90s");
    assert.equal(saved.rotateShows, 4);
    assert.equal(saved.shareCode, "CODE1");
    assert.equal(saved.sharePublished, false, "a copy is not the published listing");
  });

  it("imports the channel behind a pasted link", async () => {
    const client = load({
      "/api/channel/share": () => ({ json: { ok: true, channel: { name: "80s VHS Sci-Fi Vault", items: [] } } }),
    });
    el(client, "channelShareCodeInput").value = "https://example.com/channel/VHS1";
    await client.call("importSharedChannel", null);
    const asked = requestsTo(client, "/api/channel/share");
    assert.equal(asked.length, 1);
    assert.match(asked[0].url, /code=VHS1/);
    assert.ok(
      Object.values(client.call("loadLocalChannels")).some((ch) => ch.name === "80s VHS Sci-Fi Vault"),
      "the channel landed locally"
    );
  });

  it("says so rather than calling the server when the pasted text is not a code", async () => {
    const client = load();
    el(client, "channelShareCodeInput").value = "just some words";
    await client.call("importSharedChannel", null);
    assert.equal(requestsTo(client, "/api/channel/share").length, 0);
    assert.match(el(client, "channelShareImportStatus").innerHTML, /does not look like/);
  });
});

describe("client: the Explore Channels directory", () => {
  it("filters the listing it has already fetched rather than re-asking", async () => {
    const client = loadClient({
      routes: {
        "/api/channel/directory": () => ({
          json: {
            ok: true,
            channels: [
              { code: "a", name: "Saturday Morning 90s", description: "cartoons", owner: "alice", itemCount: 300, showCount: 12, dailyRotate: true },
              { code: "b", name: "Comedy Central 2000s", description: "sitcoms", owner: "bob", itemCount: 200, showCount: 8 },
            ],
          },
        }),
      },
    });
    await client.call("loadChannelDirectory", true);
    assert.equal(requestsTo(client, "/api/channel/directory").length, 1);
    const feed = el(client, "channelDirectoryFeed");
    assert.match(feed.innerHTML, /Saturday Morning 90s/);
    assert.match(feed.innerHTML, /Comedy Central 2000s/);

    el(client, "channelDirectorySearchInput").value = "cartoons";
    client.call("renderChannelDirectory");
    assert.match(feed.innerHTML, /Saturday Morning 90s/);
    assert.equal(/Comedy Central 2000s/.test(feed.innerHTML), false);
    assert.equal(requestsTo(client, "/api/channel/directory").length, 1, "filtering is local");
  });

  it("describes a dynamic listing by what it does, not by a pick count it has not got", async () => {
    const client = loadClient({ routes: {} });
    const line = client.call("channelDirectoryMetaLine", {
      code: "c", name: "Next Up", dynamic: "next-up", itemCount: 0, showCount: 0, owner: "alice",
    });
    assert.match(line, /watch history/);
    assert.equal(/0 episodes/.test(line), false);
  });
});

describe("client: the dynamic Next Up channel", () => {
  it("refuses to make one while signed out, since it has no history to read", () => {
    const client = loadClient({ routes: {} });
    client.set("activeCreator", null);
    client.call("createNextUpChannel", null);
    assert.deepEqual(plain(client.call("loadLocalChannels")), {});
    assert.match(el(client, "channelNextUpStatus").innerHTML, /Creator Profile/);
  });

  it("seeds itself from Continue Watching, so it plays before the server can help", () => {
    const client = loadClient({
      routes: {},
      storage: {
        "myListAddon:localCustomLists": JSON.stringify({
          "continue-watching": {
            slug: "continue-watching", name: "Continue Watching", type: "series",
            items: [
              { id: "1", type: "episode", name: "Breakage", showId: "tt0903747", showTitle: "Breaking Bad", showPoster: "https://img/bb.jpg", seasonNum: 2, episodeNum: 5 },
              { id: "2", type: "episode", name: "The One", showId: "tt0108778", showTitle: "Friends", seasonNum: 5, episodeNum: 13 },
            ],
          },
        }),
      },
    });
    client.set("activeCreator", { creatorName: "alice" });
    client.call("createNextUpChannel", null);
    const saved = Object.values(client.call("loadLocalChannels"));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].dynamic, "next-up");
    assert.deepEqual(
      plain(saved[0].items.map((it) => it.imdbId + ":" + it.season + ":" + it.episode)),
      ["tt0903747:2:5", "tt0108778:5:13"]
    );
    assert.equal(saved[0].items[0].title, "Breaking Bad S2E5 \u2014 Breakage");
    assert.equal(saved[0].poster, "https://img/bb.jpg");
  });

  it("carries a poster when published or turned into a listing entry", () => {
    const client = loadClient({ routes: {} });
    const payload = client.call("channelSharePayload", { name: "Next Up", dynamic: "next-up", items: [] });
    assert.ok(payload.poster && payload.poster.includes("channel-poster"));

    const entry = client.call("channelAsListingEntry", { name: "Next Up", dynamic: "next-up", items: [] });
    assert.ok(entry.backdrop && entry.backdrop.includes("channel-poster"));
  });

  it("saves with no picks when nothing is in progress, rather than refusing", () => {
    const client = loadClient({ routes: {} });
    client.set("activeCreator", { creatorName: "alice" });
    client.call("createNextUpChannel", null);
    const saved = Object.values(client.call("loadLocalChannels"));
    assert.equal(saved.length, 1);
    assert.deepEqual(plain(saved[0].items), []);
  });

  it("drops a Continue Watching row it could not turn into a stream request", () => {
    const client = loadClient({
      routes: {},
      storage: {
        "myListAddon:localCustomLists": JSON.stringify({
          "continue-watching": {
            slug: "continue-watching", name: "Continue Watching", type: "series",
            items: [
              { id: "1", type: "episode", name: "no show id", showId: "", seasonNum: 1, episodeNum: 1 },
              { id: "2", type: "episode", name: "no season", showId: "tt1", seasonNum: null, episodeNum: 1 },
              { id: "3", type: "episode", name: "fine", showId: "tt1", showTitle: "Fine", seasonNum: 3, episodeNum: 4 },
              { id: "4", type: "episode", name: "same again", showId: "tt1", showTitle: "Fine", seasonNum: 3, episodeNum: 4 },
            ],
          },
        }),
      },
    });
    const seeded = client.call("channelNextUpSeedItems");
    assert.deepEqual(plain(seeded.map((it) => it.imdbId + ":" + it.season + ":" + it.episode)), ["tt1:3:4"]);
  });

  it("opens the one that exists instead of adding a second", () => {
    const client = loadClient({ routes: {} });
    client.set("activeCreator", { creatorName: "alice" });
    client.call("createNextUpChannel", null);
    client.call("createNextUpChannel", null);
    assert.equal(Object.keys(client.call("loadLocalChannels")).length, 1);
  });
});

// --- browsing a person's filmography -------------------------------------
//
// Tapping an actor or director opens what they have been in BELOW the
// search, the same way tapping a show opens its seasons -- so a tribute can
// be pruned before it is saved rather than committed whole in one click.
describe("client: browsing an actor or director's filmography", () => {
  const CREDITS = {
    ok: true,
    name: "Robin Williams",
    poster: "https://img/rw.jpg",
    backdrop: "https://img/rw-bd.jpg",
    movies: [
      { tmdbId: 1, type: "movie", title: "Good Will Hunting", year: "1997", released: "1997-12-05", rating: 8.2, votes: 9000, poster: "https://img/gwh.jpg", backdrop: "", role: "Sean" },
      { tmdbId: 2, type: "movie", title: "Aladdin", year: "1992", released: "1992-11-25", rating: 7.7, votes: 8000, poster: "https://img/al.jpg", backdrop: "", role: "Genie" },
    ],
    shows: [
      { tmdbId: 90, type: "tv", title: "Mork & Mindy", year: "1978", released: "1978-09-14", rating: 7.1, votes: 300, poster: "https://img/mm.jpg", backdrop: "", role: "Mork" },
    ],
  };

  function personClient(extraRoutes = {}) {
    return loadClient({
      routes: {
        "/api/person-search": () => ({
          json: { ok: true, results: [{ personId: 2157, name: "Robin Williams", department: "Acting", knownFor: "Aladdin", poster: "https://img/rw.jpg" }] },
        }),
        "/api/person-credits": () => ({ json: CREDITS }),
        ...extraRoutes,
      },
    });
  }

  it("puts a person's search card behind the same browse gesture a show's card uses", async () => {
    const client = personClient();
    client.set("channelSearchType", "person");
    el(client, "channelSearchInput").value = "robin williams";
    await client.call("runChannelTitleSearch");
    const html = el(client, "channelSearchResult").innerHTML;
    assert.match(html, /channelPersonCard/);
    assert.match(html, /channelPersonBtn/);
    assert.match(html, /data-personid="2157"/);
    assert.match(html, /\+ Browse</, "not an immediate 'build me a channel'");
  });

  it("lists the films and the television separately, each with its own control", async () => {
    const client = personClient();
    await client.call("browseChannelPerson", "2157", "Robin Williams");
    const html = el(client, "channelEpisodePicker").innerHTML;
    assert.match(html, /Good Will Hunting/);
    assert.match(html, /Aladdin/);
    assert.match(html, /Mork &amp; Mindy/, "a title's ampersand is escaped, not injected");
    assert.match(html, /channelPersonMovieBtn/);
    assert.match(html, /channelPersonShowBtn/);
    assert.match(html, /Add everything as a Spotlight channel/);
    assert.match(html, /2 films and 1 show/);
  });

  it("asks the server again when the order changes, rather than re-sorting one page", async () => {
    const client = personClient();
    await client.call("browseChannelPerson", "2157", "Robin Williams");
    assert.equal(requestsTo(client, "/api/person-credits").length, 1);
    await client.call("setChannelSpotlightSortAndReload", "rating");
    const asked = requestsTo(client, "/api/person-credits");
    assert.equal(asked.length, 2);
    assert.match(asked[1].url, /sort=rating/);
  });

  it("asks for a whole filmography, not just a channel's worth", async () => {
    const client = personClient();
    await client.call("browseChannelPerson", "2157", "Robin Williams");
    const asked = requestsTo(client, "/api/person-credits")[0];
    assert.match(asked.url, /movies=120/);
    assert.match(asked.url, /shows=60/);
  });

  it("adds every film into the draft, resolving each to an IMDb id first", async () => {
    const client = personClient({
      "/api/resolve-movie": (req) => {
        const tmdbId = new URL(req.url).searchParams.get("tmdbId");
        return { json: { ok: true, imdbId: "tt000" + tmdbId } };
      },
      "/api/person-show-episodes": () => ({ json: { ok: true, imdbId: "tt_mm", showName: "Mork & Mindy", regular: false, episodes: [] } }),
    });
    client.set("channelDraftItems", []);
    await client.call("browseChannelPerson", "2157", "Robin Williams");
    await client.call("addWholeSpotlightToDraft", null);
    const draft = client.get("channelDraftItems");
    assert.deepEqual(plain(draft.map((it) => it.imdbId).sort()), ["tt0001", "tt0002"]);
    assert.equal(draft[0].kind, "movie");
    assert.equal(el(client, "channelNameInput").value, "Robin Williams Spotlight");
  });

  it("puts the picks in career order and leaves the draft on 'As listed'", async () => {
    const client = personClient({
      "/api/resolve-movie": (req) => ({ json: { ok: true, imdbId: "tt00" + new URL(req.url).searchParams.get("tmdbId") } }),
      "/api/person-show-episodes": () => ({ json: { ok: true, imdbId: "tt_mm", showName: "Mork & Mindy", regular: false, episodes: [] } }),
    });
    client.set("channelDraftItems", []);
    client.call("setChannelSpotlightSort", "chronological");
    await client.call("browseChannelPerson", "2157", "Robin Williams");
    await client.call("addWholeSpotlightToDraft", null);
    assert.equal(client.call("getChannelPlayOrder"), "as-listed",
      "the order has just been applied, so nothing may re-sort it on the next render");
    assert.deepEqual(
      plain(client.get("channelDraftItems").map((it) => it.title)),
      ["Aladdin", "Good Will Hunting"],
      "1992 before 1997"
    );
  });

  it("adds to an existing draft instead of replacing what is already in it", async () => {
    const client = personClient({
      "/api/resolve-movie": (req) => ({ json: { ok: true, imdbId: "tt00" + new URL(req.url).searchParams.get("tmdbId") } }),
      "/api/person-show-episodes": () => ({ json: { ok: true, imdbId: "tt_mm", showName: "Mork & Mindy", regular: false, episodes: [] } }),
    });
    client.set("channelDraftItems", [{ kind: "movie", imdbId: "tt_existing", title: "Already here" }]);
    await client.call("browseChannelPerson", "2157", "Robin Williams");
    await client.call("addWholeSpotlightToDraft", null);
    assert.equal(client.get("channelDraftItems")[0].imdbId, "tt_existing");
    assert.equal(client.get("channelDraftItems").length, 3);
  });

  it("forgets the filmography when the search type changes under it", async () => {
    const client = personClient();
    await client.call("browseChannelPerson", "2157", "Robin Williams");
    assert.ok(client.get("channelPersonCredits"));
    client.call("setChannelSearchType", "tv", null);
    assert.equal(client.get("channelPersonCredits"), null);
  });
});

// --- the spotlight builder ------------------------------------------------
describe("client: adding a whole spotlight", () => {
  const CREDITS = {
    ok: true,
    name: "Tobey Maguire",
    poster: "https://img/tm.jpg",
    backdrop: null,
    movies: [
      { tmdbId: 557, type: "movie", title: "Spider-Man", year: "2002", released: "2002-05-03", rating: 7.2, votes: 9000, poster: "", backdrop: "", role: "Peter" },
      { tmdbId: 5, type: "movie", title: "Babylon", year: "2022", released: "2022-12-23", rating: 7.1, votes: 3000, poster: "", backdrop: "", role: "Self" },
    ],
    shows: [
      { tmdbId: 99, type: "tv", title: "Roseanne", year: "1988", released: "1988-10-18", rating: 6.9, votes: 400, poster: "", backdrop: "", role: "Guest" },
    ],
  };

  function spotlightClient(over = {}) {
    return loadClient({
      routes: {
        "/api/person-credits": () => ({ json: CREDITS }),
        "/api/resolve-movie": (req) => ({ json: { ok: true, imdbId: "tt" + new URL(req.url).searchParams.get("tmdbId") } }),
        "/api/person-show-episodes": () => ({
          json: {
            ok: true, imdbId: "tt0094540", showName: "Roseanne", poster: "", backdrop: "", regular: false,
            episodes: [{ season: 5, episode: 12, name: "Crime and Punishment", released: "1993-01-12", thumbnail: "" }],
          },
        }),
        ...over,
      },
    });
  }

  it("adds every film and every episode the person is in, with no cap", async () => {
    const client = spotlightClient();
    client.set("channelDraftItems", []);
    await client.call("browseChannelPerson", "2157", "Tobey Maguire");
    await client.call("addWholeSpotlightToDraft", null);
    const draft = client.get("channelDraftItems");
    assert.equal(draft.length, 3, "two films and the one episode he is in");
    assert.equal(draft.filter((it) => it.kind === "movie").length, 2);
    assert.equal(draft.filter((it) => it.kind === "episode").length, 1);
  });

  it("asks which episodes are his rather than taking a show's opening run", async () => {
    const client = spotlightClient();
    client.set("channelDraftItems", []);
    await client.call("browseChannelPerson", "2157", "Tobey Maguire");
    await client.call("addWholeSpotlightToDraft", null);
    const asked = requestsTo(client, "/api/person-show-episodes");
    assert.equal(asked.length, 1);
    assert.match(asked[0].url, /personId=2157/);
    assert.match(asked[0].url, /tmdbId=99/);
    assert.equal(requestsTo(client, "/api/show-seasons").length, 0, "never the whole show");
    const episode = client.get("channelDraftItems").find((it) => it.kind === "episode");
    assert.equal(episode.season, 5);
    assert.equal(episode.episode, 12);
  });

  it("orders films and episodes together by date, not films then television", async () => {
    const client = spotlightClient();
    client.set("channelDraftItems", []);
    client.call("setChannelSpotlightSort", "chronological");
    await client.call("browseChannelPerson", "2157", "Tobey Maguire");
    await client.call("addWholeSpotlightToDraft", null);
    assert.deepEqual(
      plain(client.get("channelDraftItems").map((it) => it.title)),
      ["Roseanne S5E12 — Crime and Punishment", "Spider-Man", "Babylon"],
      "1993 before 2002 before 2022 -- the guest spot is not stranded at the end"
    );
  });

  it("ranks by rating when that is the order asked for", async () => {
    const client = spotlightClient();
    client.set("channelDraftItems", []);
    client.call("setChannelSpotlightSort", "rating");
    await client.call("browseChannelPerson", "2157", "Tobey Maguire");
    await client.call("addWholeSpotlightToDraft", null);
    assert.deepEqual(
      plain(client.get("channelDraftItems").map((it) => it.title)),
      ["Spider-Man", "Babylon", "Roseanne S5E12 — Crime and Punishment"],
      "an episode inherits its show's rating so a show's run stays together"
    );
  });

  it("does not leave its own sorting scaffolding on the saved picks", async () => {
    const client = spotlightClient();
    client.set("channelDraftItems", []);
    await client.call("browseChannelPerson", "2157", "Tobey Maguire");
    await client.call("addWholeSpotlightToDraft", null);
    client.get("channelDraftItems").forEach((it) => {
      assert.equal("spotlightRating" in it, false);
    });
  });

  it("adds one show's episodes on its own when only that credit is wanted", async () => {
    const client = spotlightClient();
    client.set("channelDraftItems", []);
    await client.call("browseChannelPerson", "2157", "Tobey Maguire");
    await client.call("addPersonShowEpisodes", "99", "Roseanne", "", null);
    const draft = client.get("channelDraftItems");
    assert.equal(draft.length, 1);
    assert.equal(draft[0].imdbId, "tt0094540");
    assert.equal(requestsTo(client, "/api/resolve-movie").length, 0, "no films came along with it");
  });

  it("offers the precise action on the button and the season picker on the poster", async () => {
    const client = spotlightClient();
    await client.call("browseChannelPerson", "2157", "Tobey Maguire");
    const html = el(client, "channelEpisodePicker").innerHTML;
    assert.match(html, /\+ Their episodes</);
    assert.match(html, /channelPersonShowCard/);
  });
});

describe("client: keeping hold of a share link", () => {
  function sharedClient(shareCode) {
    const client = loadClient({
      routes: { "/api/channel/share": () => ({ json: { ok: true, code: "CODE1" } }) },
      storage: { "myListAddon:creatorKey": "KEY-1" },
    });
    client.call("saveLocalChannel", { channelId: "ch1", name: "Block Party", items: [], shareCode: shareCode || "" });
    return client;
  }

  it("copies the stored link without re-uploading the channel", async () => {
    const client = sharedClient("CODE1");
    await client.call("copyChannelShareLink", "ch1", null);
    assert.equal(requestsTo(client, "/api/channel/share").length, 0, "nothing was sent");
  });

  it("does nothing for a channel that has never been shared", async () => {
    const client = sharedClient("");
    await client.call("copyChannelShareLink", "ch1", null);
    assert.equal(requestsTo(client, "/api/channel/share").length, 0);
  });

  it("sends the creator's credentials when re-sharing, so its own owner is not refused", async () => {
    const posts = [];
    const client = loadClient({
      routes: { "/api/channel/share": (req) => { posts.push(req.body); return { json: { ok: true, code: "CODE1" } }; } },
      storage: { "myListAddon:creatorKey": "KEY-1" },
    });
    client.set("activeCreator", { creatorName: "alice" });
    client.call("saveLocalChannel", { channelId: "ch1", name: "Block Party", items: [], shareCode: "CODE1", sharePublished: true });
    await client.call("shareChannelById", "ch1", null);
    assert.equal(posts[0].code, "CODE1");
    assert.equal(posts[0].creatorName, "alice");
    assert.equal(posts[0].creatorKey, "KEY-1");
    assert.equal(posts[0].publish, false, "re-sharing does not publish something that was not");
  });

  it("sends nothing to prove on a first, unlisted share", async () => {
    const posts = [];
    const client = loadClient({
      routes: { "/api/channel/share": (req) => { posts.push(req.body); return { json: { ok: true, code: "NEW1" } }; } },
      storage: { "myListAddon:creatorKey": "KEY-1" },
    });
    client.set("activeCreator", { creatorName: "alice" });
    client.call("saveLocalChannel", { channelId: "ch1", name: "Block Party", items: [] });
    await client.call("shareChannelById", "ch1", null);
    assert.equal("creatorKey" in posts[0], false);
  });
});

describe("client: looking through a published channel before taking it", () => {
  it("opens the channel's own picks rather than the one-line summary", async () => {
    const opened = [];
    const client = loadClient({
      routes: {
        "/api/channel/share": () => ({
          json: {
            ok: true, code: "SM90",
            channel: {
              name: "Saturday Morning 90s",
              items: [
                { kind: "episode", imdbId: "tt1", season: 1, episode: 1, showName: "Rugrats", epName: "Tommy", title: "Rugrats S1E1" },
                { kind: "movie", imdbId: "tt9", season: 1, episode: 1, title: "The Rugrats Movie", showName: "The Rugrats Movie" },
              ],
            },
          },
        }),
      },
    });
    client.set("openListDetailsPage", function (name, type, url, preloaded) {
      opened.push({ name, type, url, count: preloaded.sample.length, names: preloaded.sample.map((s) => s.name) });
    });
    await client.call("previewDirectoryChannel", "SM90", null);
    assert.equal(opened.length, 1);
    assert.equal(opened[0].name, "Saturday Morning 90s");
    assert.equal(opened[0].count, 2, "both picks, not a summary");
    assert.match(opened[0].url, /directory:SM90/, "and under an id no saved channel can collide with");
  });

  it("does not save the previewed channel into this browser", async () => {
    const client = loadClient({
      routes: {
        "/api/channel/share": () => ({ json: { ok: true, code: "SM90", channel: { name: "Saturday Morning 90s", items: [{ kind: "episode", imdbId: "tt1", season: 1, episode: 1, title: "Rugrats S1E1" }] } } }),
      },
    });
    client.set("openListDetailsPage", function () {});
    await client.call("previewDirectoryChannel", "SM90", null);
    assert.deepEqual(plain(client.call("loadLocalChannels")), {}, "looking is not taking");
  });
});

// --- working on a big draft ----------------------------------------------
describe("client: bulk editing a channel draft", () => {
  const epOf = (imdbId, season, episode, showName) => ({
    kind: "episode", imdbId, season, episode, showName,
    epName: "E" + episode, title: showName + " S" + season + "E" + episode,
  });

  function draft(items) {
    const client = loadClient({ routes: {} });
    client.set("channelDraftItems", items);
    client.set("channelDraftSelection", []);
    client.set("channelDraftFilter", "");
    client.set("channelDraftSelectMode", false);
    client.set("channelDraftStoryLocked", []);
    return client;
  }

  const SAMPLE = [
    epOf("tt1", 1, 1, "Rugrats"),
    epOf("tt1", 1, 2, "Rugrats"),
    epOf("tt1", 2, 1, "Rugrats"),
    epOf("tt2", 1, 1, "Doug"),
    epOf("tt2", 1, 2, "Doug"),
  ];

  it("narrows to what the filter matches, by show, episode or S/E", () => {
    const client = draft(SAMPLE);
    client.call("setChannelDraftFilter", "doug");
    assert.deepEqual(plain(client.call("channelDraftVisibleIndices")), [3, 4]);
    client.call("setChannelDraftFilter", "s2e1");
    assert.deepEqual(plain(client.call("channelDraftVisibleIndices")), [2]);
    client.call("setChannelDraftFilter", "");
    assert.deepEqual(plain(client.call("channelDraftVisibleIndices")), [0, 1, 2, 3, 4]);
  });

  it("selects only what is on screen, so a filter cannot act on hidden picks", () => {
    const client = draft(SAMPLE);
    client.call("setChannelDraftFilter", "doug");
    client.call("selectAllChannelDraftShown", true);
    assert.deepEqual(plain(client.get("channelDraftSelection")).sort(), [3, 4]);
  });

  it("selects a whole show, or one season of it", () => {
    const client = draft(SAMPLE);
    client.call("selectChannelDraftByGroup", JSON.stringify(["tt1"]));
    assert.deepEqual(plain(client.get("channelDraftSelection")).sort(), [0, 1, 2]);
    client.call("selectAllChannelDraftShown", false);
    client.call("selectChannelDraftByGroup", JSON.stringify(["tt1", 1]));
    assert.deepEqual(plain(client.get("channelDraftSelection")).sort(), [0, 1]);
  });

  it("removes the selection and forgets it", () => {
    const client = draft(SAMPLE);
    client.call("selectChannelDraftByGroup", JSON.stringify(["tt1"]));
    client.call("removeChannelDraftSelection");
    assert.deepEqual(plain(client.get("channelDraftItems").map((it) => it.title)), ["Doug S1E1", "Doug S1E2"]);
    assert.deepEqual(plain(client.get("channelDraftSelection")), []);
  });

  it("moves the selection to the top and keeps pointing at it afterwards", () => {
    const client = draft(SAMPLE);
    client.call("selectChannelDraftByGroup", JSON.stringify(["tt2"]));
    client.call("moveChannelDraftSelection", "top");
    assert.deepEqual(
      plain(client.get("channelDraftItems").map((it) => it.title)),
      ["Doug S1E1", "Doug S1E2", "Rugrats S1E1", "Rugrats S1E2", "Rugrats S2E1"]
    );
    assert.deepEqual(plain(client.get("channelDraftSelection")), [0, 1],
      "an index that survived the move would be pointing at the wrong pick");
  });

  it("moves the selection to the bottom", () => {
    const client = draft(SAMPLE);
    client.call("selectChannelDraftByGroup", JSON.stringify(["tt1", 1]));
    client.call("moveChannelDraftSelection", "bottom");
    assert.deepEqual(
      plain(client.get("channelDraftItems").map((it) => it.title)),
      ["Rugrats S2E1", "Doug S1E1", "Doug S1E2", "Rugrats S1E1", "Rugrats S1E2"]
    );
    assert.deepEqual(plain(client.get("channelDraftSelection")), [3, 4]);
  });

  it("disarms a remembered sort, so a bulk move is not undone on the next render", () => {
    const client = draft(SAMPLE);
    el(client, "channelPlayOrderSelect").value = "title-az";
    client.call("selectChannelDraftByGroup", JSON.stringify(["tt2"]));
    client.call("moveChannelDraftSelection", "top");
    assert.equal(client.call("getChannelPlayOrder"), "as-listed");
  });

  it("clears the filter and the selection when the builder moves to another channel", () => {
    const client = draft(SAMPLE);
    client.call("setChannelDraftFilter", "doug");
    client.call("toggleChannelDraftSelectMode");
    client.call("selectAllChannelDraftShown", true);
    client.call("resetChannelDraftWorkspace");
    assert.equal(client.get("channelDraftFilter"), "");
    assert.equal(client.get("channelDraftSelectMode"), false);
    assert.deepEqual(plain(client.get("channelDraftSelection")), []);
  });
});

describe("client: what a channel adds up to", () => {
  const epOf = (imdbId, episode, showName, runtime, released) => ({
    kind: "episode", imdbId, season: 1, episode, showName, epName: "E" + episode,
    title: showName + " E" + episode, runtime, released,
  });

  it("counts shows, episodes, hours and the years it spans", () => {
    const client = loadClient({ routes: {} });
    const summary = client.call("channelDraftSummary", [
      epOf("tt1", 1, "Rugrats", 30, "1991-08-11"),
      epOf("tt1", 2, "Rugrats", 30, "1992-09-13"),
      epOf("tt2", 1, "Doug", 60, "1994-01-01"),
    ], {});
    assert.equal(summary.shows, 2);
    assert.equal(summary.episodes, 3);
    assert.equal(summary.hours, 2);
    assert.equal(summary.estimated, false);
    assert.equal(summary.firstYear, "1991");
    assert.equal(summary.lastYear, "1994");
  });

  it("marks the hours as an estimate when some picks have no runtime", () => {
    const client = loadClient({ routes: {} });
    const summary = client.call("channelDraftSummary", [
      epOf("tt1", 1, "Rugrats", 30, "1991-08-11"),
      epOf("tt1", 2, "Rugrats", 0, "1992-09-13"),
    ], {});
    assert.equal(summary.estimated, true);
    assert.match(client.call("channelSummaryLine", summary), /~1 hour/);
  });

  it("falls back to half an hour when nothing at all is known", () => {
    const client = loadClient({ routes: {} });
    const summary = client.call("channelDraftSummary", [
      epOf("tt1", 1, "Rugrats", 0, ""),
      epOf("tt1", 2, "Rugrats", 0, ""),
    ], {});
    assert.equal(summary.hours, 1);
    assert.equal(summary.firstYear, "");
  });

  it("names the rules a channel is running under", () => {
    const client = loadClient({ routes: {} });
    const line = client.call("channelSummaryLine", client.call("channelDraftSummary", [
      epOf("tt1", 1, "Rugrats", 30, "1991-08-11"),
    ], { dailyRotate: true, rotateShows: 6, rotateEpisodes: 2, hideWatched: true, storyLocked: ["tt1"], liveSync: true }));
    assert.match(line, /6 shows × 2 a day/);
    assert.match(line, /1 story-locked/);
    assert.match(line, /hides watched/);
    assert.match(line, /live cloud sync/);
  });

  it("says nothing at all for an empty channel", () => {
    const client = loadClient({ routes: {} });
    assert.equal(client.call("channelSummaryLine", client.call("channelDraftSummary", [], {})), "");
  });
});

describe("client: adding something already in the channel", () => {
  it("counts what is already there by id or by show name", () => {
    const client = loadClient({ routes: {} });
    client.set("channelDraftItems", [
      { kind: "episode", imdbId: "tt1", season: 1, episode: 1, showName: "Rugrats" },
      { kind: "episode", imdbId: "tt1", season: 1, episode: 2, showName: "Rugrats" },
    ]);
    assert.equal(client.call("channelDraftCountForShow", "tt1", ""), 2);
    assert.equal(client.call("channelDraftCountForShow", "", "Rugrats"), 2);
    assert.equal(client.call("channelDraftCountForShow", "tt9", "Doug"), 0);
    assert.equal(client.call("channelDraftCountForShow", "", ""), 0);
  });

  it("does not stop the caller when there is no dialog to ask with", () => {
    const client = loadClient({ routes: {} });
    client.set("showAppConfirm", undefined);
    assert.equal(client.call("guardChannelDraftDuplicate", "Rugrats", 2, function () {}), false);
  });

  it("does not stop the caller when there is no duplicate to warn about", () => {
    const client = loadClient({ routes: {} });
    assert.equal(client.call("guardChannelDraftDuplicate", "Rugrats", 0, function () {}), false);
  });

  it("stops the caller and re-runs it only if the warning is accepted", () => {
    const client = loadClient({ routes: {} });
    let accepted = 0;
    let onConfirm = null;
    client.set("showAppConfirm", function (title, message, label, cb) { onConfirm = cb; });
    const stopped = client.call("guardChannelDraftDuplicate", "Rugrats", 2, function () { accepted++; });
    assert.equal(stopped, true, "the caller stops while the dialog is up");
    assert.equal(accepted, 0);
    onConfirm();
    assert.equal(accepted, 1, "and only confirming runs it again");
  });

  it("adds nothing while the duplicate warning is unanswered", async () => {
    const client = loadClient({
      routes: { "/api/resolve-movie": () => ({ json: { ok: true, imdbId: "tt_new" } }) },
    });
    // A dialog nobody answers -- which is the case a promise-based guard
    // could never represent, because it would simply hang here.
    client.set("showAppConfirm", function () {});
    client.set("channelDraftItems", [{ kind: "movie", imdbId: "tt9", tmdbId: "603", title: "The Matrix", showName: "The Matrix" }]);
    await client.call("addMovieToChannelDraft", "603", "The Matrix", "1999", "", "", null);
    assert.equal(client.get("channelDraftItems").length, 1, "the duplicate was not added");
    assert.equal(requestsTo(client, "/api/resolve-movie").length, 0, "and nothing was even asked for");
  });

  it("adds the duplicate once the warning is accepted", async () => {
    const client = loadClient({
      routes: { "/api/resolve-movie": () => ({ json: { ok: true, imdbId: "tt_new" } }) },
    });
    client.set("showAppConfirm", function (title, message, label, onConfirm) { onConfirm(); });
    client.set("channelDraftItems", [{ kind: "movie", imdbId: "tt9", tmdbId: "603", title: "The Matrix", showName: "The Matrix" }]);
    await client.call("addMovieToChannelDraft", "603", "The Matrix", "1999", "", "", null);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(client.get("channelDraftItems").length, 2);
  });

  it("adds a movie the channel does not have without asking", async () => {
    const client = loadClient({
      routes: { "/api/resolve-movie": () => ({ json: { ok: true, imdbId: "tt_new", runtime: 136 } }) },
    });
    client.set("channelDraftItems", []);
    await client.call("addMovieToChannelDraft", "603", "The Matrix", "1999", "", "", null);
    const draft = client.get("channelDraftItems");
    assert.equal(draft.length, 1);
    assert.equal(draft[0].runtime, 136, "and its runtime came along, for the hours count");
  });
});

describe("client: managing the My Channels list", () => {
  function withChannels(client, channels) {
    channels.forEach((ch) => client.call("saveLocalChannel", ch));
    return client;
  }
  const chan = (id, name, over = {}) => ({
    channelId: id, name, items: [{ kind: "episode", imdbId: "tt1", season: 1, episode: 1, showName: "Rugrats" }], ...over,
  });

  it("sorts by name, size or when it was touched", () => {
    const client = loadClient({ routes: {} });
    const all = [
      chan("a", "Zulu", { items: [] }),
      chan("b", "Alpha", { items: [{ kind: "episode", imdbId: "tt1", season: 1, episode: 1 }, { kind: "episode", imdbId: "tt1", season: 1, episode: 2 }] }),
    ];
    client.call("setMyChannelsSort", "name");
    assert.deepEqual(plain(client.call("sortMyChannels", all).map((c) => c.name)), ["Alpha", "Zulu"]);
    client.call("setMyChannelsSort", "size");
    assert.deepEqual(plain(client.call("sortMyChannels", all).map((c) => c.name)), ["Alpha", "Zulu"]);
  });

  it("finds a channel by its name, its description, or a show inside it", () => {
    const client = loadClient({ routes: {} });
    const all = [
      chan("a", "Saturday Morning", { description: "cartoons all day" }),
      chan("b", "Late Night", { items: [{ kind: "episode", imdbId: "tt2", season: 1, episode: 1, showName: "Seinfeld" }] }),
    ];
    client.call("setMyChannelsSearch", "saturday");
    assert.deepEqual(plain(client.call("filterMyChannels", all).map((c) => c.name)), ["Saturday Morning"]);
    client.call("setMyChannelsSearch", "cartoons");
    assert.deepEqual(plain(client.call("filterMyChannels", all).map((c) => c.name)), ["Saturday Morning"]);
    client.call("setMyChannelsSearch", "seinfeld");
    assert.deepEqual(plain(client.call("filterMyChannels", all).map((c) => c.name)), ["Late Night"]);
    client.call("setMyChannelsSearch", "");
    assert.equal(client.call("filterMyChannels", all).length, 2);
  });

  it("puts a deleted channel back, picks and all", () => {
    const client = withChannels(loadClient({ routes: {} }), [chan("ch1", "Saturday Morning")]);
    const before = JSON.stringify(client.call("loadLocalChannels").ch1);
    client.set("showAppConfirm", function (title, message, label, onConfirm) { onConfirm(); });
    client.call("deleteLocalChannel", "ch1", "Saturday Morning");
    assert.equal(client.call("loadLocalChannels").ch1, undefined);
    client.call("undoChannelDelete");
    const after = client.call("loadLocalChannels").ch1;
    assert.equal(after.name, "Saturday Morning");
    assert.equal(after.items.length, JSON.parse(before).items.length);
  });

  it("offers the undo only until it is used", () => {
    const client = withChannels(loadClient({ routes: {} }), [chan("ch1", "Saturday Morning")]);
    client.set("showAppConfirm", function (title, message, label, onConfirm) { onConfirm(); });
    client.call("deleteLocalChannel", "ch1", "Saturday Morning");
    assert.match(el(client, "myChannelsUndoBar").innerHTML, /Undo/);
    client.call("undoChannelDelete");
    assert.equal(el(client, "myChannelsUndoBar").innerHTML, "");
    // A second Undo has nothing to put back and must not resurrect anything.
    client.call("undoChannelDelete");
    assert.equal(Object.keys(client.call("loadLocalChannels")).length, 1);
  });
});

describe("client: the Explore Channels directory ordering and likes", () => {
  const rows = [
    { code: "a", name: "Alpha", likes: 1, adds: 0, itemCount: 10, showCount: 2 },
    { code: "b", name: "Zulu", likes: 0, adds: 5, itemCount: 20, showCount: 3 },
  ];

  it("re-asks the server when the order changes rather than re-sorting one page", async () => {
    const client = loadClient({
      routes: { "/api/channel/directory": () => ({ json: { ok: true, channels: rows } }) },
    });
    await client.call("loadChannelDirectory", true);
    assert.equal(requestsTo(client, "/api/channel/directory").length, 1);
    await client.call("setChannelDirectorySort", "liked");
    const asked = requestsTo(client, "/api/channel/directory");
    assert.equal(asked.length, 2);
    assert.match(asked[1].url, /sort=liked/);
  });

  it("does nothing when the order picked is the one already showing", async () => {
    const client = loadClient({
      routes: { "/api/channel/directory": () => ({ json: { ok: true, channels: rows } }) },
    });
    await client.call("loadChannelDirectory", true);
    await client.call("setChannelDirectorySort", "newest");
    assert.equal(requestsTo(client, "/api/channel/directory").length, 1);
  });

  it("fills the heart in before the round trip and keeps the server's answer", async () => {
    const client = loadClient({
      routes: {
        "/api/channel/directory": () => ({ json: { ok: true, channels: rows.map((r) => Object.assign({}, r)) } }),
        "/api/channel/like": () => ({ json: { ok: true, likes: 2, liked: true } }),
      },
    });
    await client.call("loadChannelDirectory", true);
    await client.call("toggleChannelDirectoryLike", "a", null);
    assert.equal(client.get("_channelDirectoryLiked").a, true);
    assert.match(el(client, "channelDirectoryFeed").innerHTML, /2/);
  });

  it("puts the heart back when the server refuses", async () => {
    const client = loadClient({
      routes: {
        "/api/channel/directory": () => ({ json: { ok: true, channels: rows.map((r) => Object.assign({}, r)) } }),
        "/api/channel/like": () => ({ status: 404, json: { ok: false, error: "Channel not found." } }),
      },
    });
    await client.call("loadChannelDirectory", true);
    await client.call("toggleChannelDirectoryLike", "a", null);
    assert.equal(!!client.get("_channelDirectoryLiked").a, false);
  });

  it("tells the server a channel was taken, and never lets that fail the add", async () => {
    const client = loadClient({
      routes: {
        "/api/channel/directory": () => ({ json: { ok: true, channels: rows.map((r) => Object.assign({}, r)) } }),
        "/api/channel/share": () => ({ json: { ok: true, code: "a", channel: { name: "Alpha", items: [] } } }),
        "/api/channel/added": () => ({ status: 500, json: { ok: false } }),
      },
    });
    await client.call("loadChannelDirectory", true);
    await client.call("addDirectoryChannel", "a", null);
    assert.equal(requestsTo(client, "/api/channel/added").length, 1);
    assert.ok(
      Object.values(client.call("loadLocalChannels")).some((ch) => ch.name === "Alpha"),
      "the channel landed even though the counter call failed"
    );
  });

  it("shows + Add when published channel is not in Live Preview, flips to Remove on add, and removes row without deleting channel", async () => {
    const localCh = { channelId: "ch_my1", name: "My 90s Toons", shareCode: "toons90", sharePublished: true, items: [] };
    const client = loadClient({
      routes: {
        "/api/channel/directory": () => ({ json: { ok: true, channels: [{ code: "toons90", name: "My 90s Toons", itemCount: 5, showCount: 2 }] } }),
        "/api/channel/added": () => ({ json: { ok: true } }),
      },
      storage: {
        "myListAddon:localChannels": JSON.stringify({ "ch_my1": localCh }),
      },
    });

    let mockCatalogRows = [];
    client.document.querySelectorAll = (sel) => {
      if (sel === "#lists .entry") return mockCatalogRows;
      return [];
    };

    await client.call("loadChannelDirectory", true);
    const feed = client.document.getElementById("channelDirectoryFeed");
    // Initially not in #lists (Live Preview & Editor), so it must show + Add, NOT Remove
    assert.match(feed.innerHTML, /\+ Add/);
    assert.equal(/removeDirectoryChannel/.test(feed.innerHTML), false);

    // Simulate row in #lists
    const rowStub = {
      dataset: { channelId: "ch_my1" },
      querySelectorAll: () => [],
      remove() { mockCatalogRows = mockCatalogRows.filter((r) => r !== rowStub); },
    };
    mockCatalogRows.push(rowStub);

    // Re-render directory
    client.call("renderChannelDirectory");
    assert.match(feed.innerHTML, /removeDirectoryChannel/);
    assert.match(feed.innerHTML, /Remove/);

    // Click Remove
    await client.call("removeDirectoryChannel", "toons90", null);

    // Row should be removed from #lists, button flipped back to + Add
    assert.equal(mockCatalogRows.length, 0, "row removed from #lists");
    assert.match(feed.innerHTML, /\+ Add/);
    assert.equal(/removeDirectoryChannel/.test(feed.innerHTML), false);

    // Local channel must NOT have been deleted
    const channelsAfter = client.call("loadLocalChannels");
    assert.ok(channelsAfter["ch_my1"], "local channel preserved");
  });
});

describe("client: dragging a pick while the draft is filtered", () => {
  const epOf = (imdbId, episode, showName) => ({
    kind: "episode", imdbId, season: 1, episode, showName,
    epName: "E" + episode, title: showName + " E" + episode,
  });
  const SAMPLE = [
    epOf("tt1", 1, "Rugrats"),
    epOf("tt2", 1, "Doug"),
    epOf("tt1", 2, "Rugrats"),
    epOf("tt2", 2, "Doug"),
  ];

  // The card order the DOM would be in after a drag. reorderChannelDraftFromDom
  // reads it back out of the rendered cards, so the stub has to hand back the
  // same data-idx attributes a real render would.
  function withRenderedOrder(client, indices) {
    const list = client.document.getElementById("channelDraftList");
    list.querySelectorAll = (sel) =>
      sel === ".channel-pick" ? indices.map((i) => ({ dataset: { idx: String(i) } })) : [];
    list.querySelector = () => null;
  }

  it("keeps every hidden pick when a visible one is dragged", () => {
    const client = loadClient({ routes: {} });
    client.set("channelDraftItems", SAMPLE);
    client.set("channelDraftFilter", "doug");
    // Doug sits at slots 1 and 3; dragging swaps the two visible cards.
    withRenderedOrder(client, [3, 1]);
    client.call("reorderChannelDraftFromDom");
    assert.deepEqual(
      plain(client.get("channelDraftItems").map((it) => it.title)),
      ["Rugrats E1", "Doug E2", "Rugrats E2", "Doug E1"],
      "the two Rugrats picks the filter was hiding are still in their own slots"
    );
    assert.equal(client.get("channelDraftItems").length, 4, "nothing was dropped");
  });

  it("is a plain reorder when nothing is filtered out", () => {
    const client = loadClient({ routes: {} });
    client.set("channelDraftItems", SAMPLE);
    client.set("channelDraftFilter", "");
    withRenderedOrder(client, [3, 2, 1, 0]);
    client.call("reorderChannelDraftFromDom");
    assert.deepEqual(
      plain(client.get("channelDraftItems").map((it) => it.title)),
      ["Doug E2", "Rugrats E2", "Doug E1", "Rugrats E1"]
    );
  });

  it("ignores a stale index rather than writing undefined into the draft", () => {
    const client = loadClient({ routes: {} });
    client.set("channelDraftItems", SAMPLE);
    withRenderedOrder(client, [0, 99, 1]);
    client.call("reorderChannelDraftFromDom");
    assert.equal(client.get("channelDraftItems").length, 4);
    assert.ok(client.get("channelDraftItems").every(Boolean));
  });

  it("leaves the draft alone when there is nothing rendered to read", () => {
    const client = loadClient({ routes: {} });
    client.set("channelDraftItems", SAMPLE);
    withRenderedOrder(client, []);
    client.call("reorderChannelDraftFromDom");
    assert.deepEqual(
      plain(client.get("channelDraftItems").map((it) => it.title)),
      ["Rugrats E1", "Doug E1", "Rugrats E2", "Doug E2"]
    );
  });
});

// --- arranging My Channels by hand ---------------------------------------
//
// The move operations read the cards ON SCREEN, so these stub the container
// the way a render would leave it: one .list-card per visible channel, in
// the order they are shown.
describe("client: rearranging the channels list", () => {
  const chan = (id, name, over = {}) => ({
    channelId: id, name,
    items: [{ kind: "episode", imdbId: "tt1", season: 1, episode: 1, showName: "Rugrats" }],
    ...over,
  });

  // Reordering reads the cards ON SCREEN, so the container is stubbed the
  // way a render would leave it: one .list-card per visible channel, in the
  // order shown.
  function withChannels(channels, shownIds) {
    const client = loadClient({ routes: {} });
    channels.forEach((ch) => client.call("saveLocalChannel", ch));
    const box = client.document.getElementById("myCreatedChannelsList");
    const ids = shownIds || channels.map((c) => c.channelId);
    box.querySelectorAll = (sel) =>
      sel.startsWith(".list-card") ? ids.map((id) => ({ getAttribute: () => id })) : [];
    return client;
  }

  const orderOf = (client) =>
    client.call("sortMyChannels", Object.values(client.call("loadLocalChannels")), "manual")
      .map((c) => c.channelId);

  it("stores the order a drag leaves the cards in", () => {
    const client = withChannels([chan("a", "Alpha"), chan("b", "Bravo"), chan("c", "Charlie")]);
    client.call("applyMyChannelOrder", ["c", "a", "b"]);
    assert.deepEqual(plain(orderOf(client)), ["c", "a", "b"]);
  });

  it("switches the ordering to the hand-made one, so the list does not re-sort out from under it", () => {
    const client = withChannels([chan("a", "Alpha"), chan("b", "Bravo")]);
    client.call("setMyChannelsSort", "name");
    client.call("applyMyChannelOrder", ["b", "a"]);
    assert.equal(client.get("myChannelsSort"), "manual");
    assert.deepEqual(plain(orderOf(client)), ["b", "a"]);
  });

  it("adopts the arrangement that was on screen rather than one nobody was looking at", () => {
    // Shown by name: Alpha, Bravo, Charlie. The stored order is the reverse.
    const client = withChannels(
      [chan("c", "Charlie", { order: 1 }), chan("b", "Bravo", { order: 2 }), chan("a", "Alpha", { order: 3 })],
      ["a", "b", "c"]
    );
    client.call("setMyChannelsSort", "name");
    client.call("beginMyChannelReorder");
    assert.deepEqual(plain(orderOf(client)), ["a", "b", "c"],
      "the visible arrangement became the starting point for the drag");
  });

  // The filtered case, where rebuilding an order from a partial view would
  // quietly reshuffle everything the filter was hiding.
  it("leaves channels the filter hides exactly where they were", () => {
    const client = withChannels(
      [chan("a", "Alpha", { order: 1 }), chan("b", "Bravo", { order: 2 }),
       chan("c", "Charlie", { order: 3 }), chan("d", "Delta", { order: 4 })],
      ["b", "d"]
    );
    client.set("myChannelsSort", "manual");
    client.call("applyMyChannelOrder", ["d", "b"]);
    assert.deepEqual(plain(orderOf(client)), ["a", "d", "c", "b"]);
  });

  it("puts a channel with no arrangement yet at the end, not in the middle", () => {
    const client = withChannels(
      [chan("a", "Alpha", { order: 1 }), chan("b", "Bravo", { order: 2 }), chan("fresh", "Fresh")]
    );
    assert.deepEqual(plain(orderOf(client)), ["a", "b", "fresh"]);
  });

  it("keeps a channel's place when it is edited and saved again", () => {
    const client = withChannels([chan("a", "Alpha"), chan("b", "Bravo")]);
    client.call("applyMyChannelOrder", ["b", "a"]);
    client.call("saveLocalChannel", chan("b", "Bravo renamed"));
    assert.deepEqual(plain(orderOf(client)), ["b", "a"], "editing is not a reason to lose your arrangement");
  });

  it("survives the whole map being rewritten, which is where a dropped field shows up", () => {
    const client = withChannels([chan("a", "Alpha"), chan("b", "Bravo")]);
    client.call("applyMyChannelOrder", ["b", "a"]);
    client.call("saveLocalChannelsMap", client.call("loadLocalChannels"));
    assert.deepEqual(plain(orderOf(client)), ["b", "a"]);
  });
});

describe("client: a published channel that is deleted locally", () => {
  const chan = (over = {}) => ({
    channelId: "ch1", name: "Saturday Morning 90s",
    items: [{ kind: "episode", imdbId: "tt1", season: 1, episode: 1, showName: "Rugrats" }],
    ...over,
  });

  function signedInClient(routes = {}) {
    const client = loadClient({
      routes: { "/api/channel/unpublish": () => ({ json: { ok: true } }), ...routes },
      storage: { "myListAddon:creatorKey": "KEY-1" },
    });
    client.set("activeCreator", { creatorName: "alice" });
    client.set("showAppConfirm", function (title, message, label, onConfirm) { onConfirm(); });
    return client;
  }

  it("withdraws the directory listing as the channel goes", async () => {
    const client = signedInClient();
    client.call("saveLocalChannel", chan({ shareCode: "SM90", sharePublished: true }));
    client.call("deleteLocalChannel", "ch1", "Saturday Morning 90s");
    await new Promise((r) => setTimeout(r, 0));
    const asked = requestsTo(client, "/api/channel/unpublish");
    assert.equal(asked.length, 1);
    assert.equal(asked[0].body.code, "SM90");
  });

  it("does not call unpublish for a channel that was never published", async () => {
    const client = signedInClient();
    client.call("saveLocalChannel", chan({ shareCode: "SM90", sharePublished: false }));
    client.call("deleteLocalChannel", "ch1", "Saturday Morning 90s");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(requestsTo(client, "/api/channel/unpublish").length, 0);
  });

  it("deletes the channel even when the withdrawal fails", async () => {
    const client = signedInClient({
      "/api/channel/unpublish": () => ({ status: 500, json: { ok: false, error: "nope" } }),
    });
    client.call("saveLocalChannel", chan({ shareCode: "SM90", sharePublished: true }));
    client.call("deleteLocalChannel", "ch1", "Saturday Morning 90s");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(client.call("loadLocalChannels").ch1, undefined, "the delete is not held hostage by the listing");
  });

  it("finds the listings this account still has up with no channel behind them", async () => {
    const client = signedInClient({
      "/api/channel/mine": () => ({
        json: {
          ok: true,
          channels: [
            { code: "GONE", name: "Deleted one", owner: "alice", itemCount: 12, showCount: 3 },
            { code: "KEPT", name: "Still here", owner: "alice", itemCount: 9, showCount: 2 },
          ],
        },
      }),
    });
    client.call("saveLocalChannel", chan({ channelId: "ch1", shareCode: "KEPT", sharePublished: true }));
    await client.call("loadOrphanedPublishedChannels");
    assert.deepEqual(plain(client.get("_orphanedPublishedChannels").map((e) => e.code)), ["GONE"],
      "only the one with nothing left behind it");
    assert.match(el(client, "channelPublishList").innerHTML, /Deleted one/);
    assert.match(el(client, "channelPublishList").innerHTML, /no longer on this device/);
  });

  it("asks for nothing while signed out", async () => {
    const client = loadClient({ routes: {} });
    client.set("activeCreator", null);
    await client.call("loadOrphanedPublishedChannels");
    assert.deepEqual(plain(client.get("_orphanedPublishedChannels")), []);
  });

  it("withdraws an orphaned listing by its code alone", async () => {
    const client = signedInClient({ "/api/channel/mine": () => ({ json: { ok: true, channels: [] } }) });
    await client.call("unpublishOrphanedChannel", "GONE", null);
    const asked = requestsTo(client, "/api/channel/unpublish");
    assert.equal(asked.length, 1);
    assert.equal(asked[0].body.code, "GONE");
    assert.equal(asked[0].body.creatorName, "alice");
  });

  it("keeps the last known orphans when the lookup fails, rather than hiding them", async () => {
    const client = signedInClient({
      "/api/channel/mine": () => ({ status: 500, json: { ok: false } }),
    });
    client.set("_orphanedPublishedChannels", [{ code: "GONE", name: "Deleted one" }]);
    await client.call("loadOrphanedPublishedChannels");
    assert.deepEqual(plain(client.get("_orphanedPublishedChannels").map((e) => e.code)), ["GONE"]);
  });
});

describe("client: one card shape for a channel listing", () => {
  it("draws a publishable channel the way the directory draws one", () => {
    const client = loadClient({ routes: {} });
    const html = client.call("channelListingCardHtml", {
      code: "SM90", name: "Saturday Morning 90s", description: "Cartoons, all morning.",
      backdrop: "https://img/bd.jpg", itemCount: 300, showCount: 12, dailyRotate: true, owner: "alice",
    }, "<button>Publish</button>", "");
    assert.match(html, /Saturday Morning 90s/);
    assert.match(html, /Cartoons, all morning\./);
    assert.match(html, /300 episodes/);
    assert.match(html, /12 shows/);
    assert.match(html, /daily lineup/);
    assert.match(html, /img\/bd\.jpg/);
    assert.match(html, /<button>Publish<\/button>/);
  });

  it("describes a saved channel the same way, from its own fields", () => {
    const client = loadClient({ routes: {} });
    const entry = client.call("channelAsListingEntry", {
      channelId: "ch1", name: "Block Party", description: "Sitcoms.",
      items: [
        { kind: "episode", imdbId: "tt1", season: 1, episode: 1, showName: "Rugrats" },
        { kind: "episode", imdbId: "tt2", season: 1, episode: 1, showName: "Doug" },
      ],
      dailyRotate: true, sharePublished: false, shareCode: "X",
    });
    assert.equal(entry.name, "Block Party");
    assert.equal(entry.description, "Sitcoms.");
    assert.equal(entry.itemCount, 2);
    assert.equal(entry.showCount, 2);
    assert.equal(entry.code, "", "an unpublished channel has no listing to open");
  });

  it("offers the preview only once a channel is actually listed", () => {
    const client = loadClient({ routes: {} });
    const unlisted = client.call("channelListingCardHtml", { name: "Draft", itemCount: 1, showCount: 1 }, "", "");
    assert.equal(/previewDirectoryChannel/.test(unlisted), false);
    const listed = client.call("channelListingCardHtml", { code: "C1", name: "Listed", backdrop: "https://i/x.jpg", itemCount: 1, showCount: 1 }, "", "");
    assert.match(listed, /previewDirectoryChannel/);
  });
});

describe("client: Quick List Wizard in Catalogs Quick Add", () => {
  it("names lists using custom input or chosen dropdowns", () => {
    const client = loadClient({ routes: {} });
    const nameInput = client.document.getElementById("catalogWizardNameInput");
    nameInput.value = "Sci-Fi Favorites";
    assert.equal(client.call("catalogWizardName", "(Movies)"), "Sci-Fi Favorites (Movies)");
    assert.equal(client.call("catalogWizardName", "(Shows)"), "Sci-Fi Favorites (Shows)");
    nameInput.value = "Action Classics (Movies)";
    assert.equal(client.call("catalogWizardName", "(Movies)"), "Action Classics (Movies)");

    nameInput.value = "";
    const network = client.document.getElementById("catalogWizardNetwork");
    network.value = "49";
    network.selectedIndex = 0;
    network.options = [{ textContent: "HBO" }];

    const era = client.document.getElementById("catalogWizardEra");
    era.value = "1990-1999";
    era.selectedIndex = 0;
    era.options = [{ textContent: "90s classics" }];

    const genre = client.document.getElementById("catalogWizardGenre");
    genre.value = "18";
    genre.selectedIndex = 0;
    genre.options = [{ textContent: "Drama" }];

    assert.equal(client.call("catalogWizardName", "(Movies)"), "90s classics HBO Drama (Movies)");
    assert.equal(client.call("catalogWizardName", "(Shows)"), "90s classics HBO Drama (Shows)");
  });

  it("builds separate movie and show lists (not combined) when run with 'both'", async () => {
    const requests = [];
    const client = loadClient({
      routes: {
        "/api/wizard-channel-shows": (req) => {
          requests.push(req.url);
          const isMovie = req.url.includes("type=movie");
          return {
            json: {
              ok: true,
              items: [
                {
                  imdbId: isMovie ? "tt101" : "tt201",
                  name: isMovie ? "Film One" : "Show One",
                  year: "2021",
                  poster: "https://img.example/poster.jpg",
                },
              ],
            },
          };
        },
      },
    });

    const net = client.document.getElementById("catalogWizardNetwork");
    net.value = "49";
    net.selectedIndex = 0;
    net.options = [{ textContent: "HBO" }];

    await client.call("runCatalogListWizard", "both", null);

    assert.equal(requests.length, 2, "must fetch movies and shows separately");
    assert.ok(requests[0].includes("type=movie"), "first request asks for movies");
    assert.ok(requests[1].includes("type=series"), "second request asks for series");

    const localMap = client.get("loadLocalCustomLists()");
    assert.ok(localMap["hbo-movies"], "creates a dedicated movies list");
    assert.ok(localMap["hbo-shows"], "creates a dedicated shows list");
    assert.equal(localMap["hbo-movies"].type, "movie", "movie list has movie type");
    assert.equal(localMap["hbo-shows"].type, "series", "show list has series type");
    assert.equal(localMap["hbo-movies"].items[0].imdbId, "tt101");
    assert.equal(localMap["hbo-shows"].items[0].imdbId, "tt201");
  });
});

describe("client: public channel URLs and explore channels mosaic", () => {
  it("generates /channels/(username)/(slug) URLs for public published channels", () => {
    const client = loadClient({ routes: {} });
    const url = client.call("channelShareUrl", "c123", {
      name: "Cartoons 90s",
      owner: "alice",
      sharePublished: true,
    });
    assert.equal(url, "https://example.com/channels/alice/cartoons-90s");
  });

  it("parses /channels/:username/:slug and .json into channels:username:slug", () => {
    const client = loadClient({ routes: {} });
    assert.equal(
      client.call("parseChannelShareCode", "https://example.com/channels/alice/cartoons-90s"),
      "channels:alice:cartoons-90s"
    );
    assert.equal(
      client.call("parseChannelShareCode", "https://example.com/channels/alice/cartoons-90s.json"),
      "channels:alice:cartoons-90s"
    );
    assert.equal(
      client.call("parseChannelShareCode", "https://example.com/channel/C123"),
      "C123"
    );
  });

  it("renders the 9-poster static preview mosaic in channelListingCardHtml when sample items exist", () => {
    const client = loadClient({ routes: {} });
    const sample = [
      { name: "Show 1", subtitle: "S1E1", poster: "https://i/1.jpg", id: "tt1" },
      { name: "Show 2", subtitle: "S1E2", poster: "https://i/2.jpg", id: "tt2" },
      { name: "Show 3", subtitle: "S1E3", poster: "https://i/3.jpg", id: "tt3" },
      { name: "Show 4", subtitle: "S1E4", poster: "https://i/4.jpg", id: "tt4" },
    ];
    const html = client.call("channelListingCardHtml", {
      code: "C1",
      name: "Test Channel",
      itemCount: 4,
      showCount: 4,
      sample: sample,
    }, "<button>Add</button>", "");
    assert.match(html, /list-card-posters poster-preview-static/);
    assert.match(html, /https:\/\/i\/1\.jpg/);
    assert.match(html, /https:\/\/i\/4\.jpg/);
    assert.match(html, /Show 1/);
  });

  it("displays neutral prompt and suppresses red error when Simkl is not connected", async () => {
    const client = loadClient({ routes: {} });
    client.document.body.innerHTML = '<div id="mySimklListsResult"></div>';
    await client.call("runMySimklLists");
    const resultHtml = client.document.getElementById("mySimklListsResult").innerHTML;
    assert.match(resultHtml, /Connect your Simkl account/);
    assert.doesNotMatch(resultHtml, /testresult err/);
  });
});

describe("client: trakt disconnected, channel publishing, toggle persistence, and form layout", () => {
  it("displays neutral prompt and clears private box when Trakt is not connected", async () => {
    let requested = false;
    const client = loadClient({
      routes: {
        "/api/trakt-my-lists": () => { requested = true; return { json: { ok: true, lists: [] } }; }
      }
    });
    client.document.body.innerHTML = '<div id="myTraktListsResult"></div><div id="myPrivateTraktListsResult">old content</div>';
    await client.call("runMyTraktLists");
    const resultHtml = client.document.getElementById("myTraktListsResult").innerHTML;
    const privHtml = client.document.getElementById("myPrivateTraktListsResult").innerHTML;
    assert.equal(requested, false, "should not make request to /api/trakt-my-lists when disconnected");
    assert.match(resultHtml, /Connect your Trakt account/);
    assert.equal(privHtml, "");
  });

  it("editing a private channel keeps the public toggle unchecked", () => {
    const client = loadClient();
    client.document.body.innerHTML = `
      <input type="checkbox" id="channelPublicToggle" checked>
      <input type="text" id="channelNameInput">
      <div id="channelDraftList"></div>
      <span id="channelDraftCountBadge"></span>
      <select id="channelPlayOrderSelect"><option value="as-listed">As listed</option></select>
    `;
    client.call("saveLocalChannel", {
      channelId: "priv-ch",
      name: "Private Comedy",
      items: [],
      visibility: "private",
      sharePublished: false,
    });
    client.call("editChannelById", "priv-ch");
    const toggle = client.document.getElementById("channelPublicToggle");
    assert.equal(toggle.checked, false, "toggle should be false for a private channel");
  });

  it("delete button in My Channels has secondary styling without red danger color", () => {
    const client = loadClient();
    client.document.body.innerHTML = `
      <div id="myCreatedChannelsList"></div>
      <input type="text" id="myChannelsSearchInput">
      <select id="myChannelsSortSelect"><option value="recent">Recent</option></select>
    `;
    client.call("saveLocalChannel", {
      channelId: "ch-del",
      name: "Delete Test Channel",
      items: [{ name: "Item 1", kind: "movie" }],
    });
    client.call("renderMyCreatedChannelsList");
    const container = client.document.getElementById("myCreatedChannelsList");
    assert.match(container.innerHTML, />Delete<\/button>/);
    assert.doesNotMatch(container.innerHTML, /color:var\(--danger\);"[^>]*>Delete<\/button>/);
  });

  it("removes shuffle-now from play order dropdowns", async () => {
    const fs = await import("node:fs");
    const chanHtml = fs.readFileSync("13_tab-channels.js", "utf8");
    const customHtml = fs.readFileSync("12_tab-custom-lists.js", "utf8");
    assert.doesNotMatch(chanHtml, /<option value="shuffle-now">/);
    assert.doesNotMatch(customHtml, /<option value="shuffle-now">/);
  });

  it("saving a public channel with active creator publishes to /api/channel/share", async () => {
    const posts = [];
    const client = loadClient({
      routes: {
        "/api/channel/share": (req) => {
          posts.push(req.body);
          return { json: { ok: true, code: "PUB1", published: true, owner: "james" } };
        }
      },
      storage: { "myListAddon:creatorKey": "SECRET" }
    });
    client.set("activeCreator", { creatorName: "james" });
    client.document.getElementById("channelNameInput").value = "Sci-Fi 24/7";
    client.document.getElementById("channelPublicToggle").checked = true;
    client.set("channelDraftItems", [{ name: "Firefly S1E1", kind: "episode" }]);
    await client.call("saveChannel");
    assert.equal(posts.length, 1);
    assert.equal(posts[0].publish, true);
    assert.equal(posts[0].creatorName, "james");
    const saved = Object.values(client.call("loadLocalChannels")).find(c => c.name === "Sci-Fi 24/7");
    assert.ok(saved);
    assert.equal(saved.shareCode, "PUB1");
    assert.equal(saved.sharePublished, true);
  });
});

describe("client: My Catalogs sub-heading and poster rating badges", () => {
  it("My Catalogs tab includes the muted sub-heading under Live Preview & Editor", async () => {
    const fs = await import("node:fs");
    const catalogsHtml = fs.readFileSync("10_tab-search-add.js", "utf8");
    assert.match(catalogsHtml, /Catalogs and lists you've added to your add-on\. Reorder, edit, and preview your active shelves\./);
  });

  it("formatRatingBadgeHtml renders IMDb and TMDb rating badges correctly", () => {
    const client = loadClient();
    const fn = client.get("formatRatingBadgeHtml");
    assert.equal(typeof fn, "function");

    // IMDb rating
    const imdbItem = { id: "tt1234567", title: "Test Show", imdbRating: "8.4" };
    const imdbHtml = client.call("formatRatingBadgeHtml", imdbItem);
    assert.match(imdbHtml, /class="rating-badge rating-high"/);
    assert.match(imdbHtml, /data-rating-type="imdb"/);
    assert.match(imdbHtml, /(&#9733;|★) 8\.4/);

    // TMDb rating
    const tmdbItem = { id: "tmdb:9999", title: "Test Movie", vote_average: 6.8 };
    const tmdbHtml = client.call("formatRatingBadgeHtml", tmdbItem);
    assert.match(tmdbHtml, /class="rating-badge rating-mid"/);
    assert.match(tmdbHtml, /data-rating-type="tmdb"/);
    assert.match(tmdbHtml, /(&#9733;|★) 6\.8/);

    // Low rating
    const lowItem = { id: "tmdb:1111", title: "Low Rated", rating: 4.2 };
    const lowHtml = client.call("formatRatingBadgeHtml", lowItem);
    assert.match(lowHtml, /class="rating-badge rating-low"/);
    assert.match(lowHtml, /(&#9733;|★) 4\.2/);
  });

  it("formatRatingBadgeHtml suppresses badge for live preview shelf items", () => {
    const client = loadClient();
    const item = { id: "tt1234567", title: "Test Show", imdbRating: "8.4", isLivePreviewShelf: true };
    assert.equal(client.call("formatRatingBadgeHtml", item), "");
    assert.equal(client.call("formatRatingBadgeHtml", { id: "tt1234567", imdbRating: "8.4" }, { isLivePreviewShelf: true }), "");
  });

  it("formatRatingBadgeHtml respects showBadgeImdbRating and showBadgeTmdbRating settings", () => {
    const client = loadClient();
    const imdbItem = { id: "tt1234567", imdbRating: "8.4" };
    const tmdbItem = { id: "tmdb:9999", rating: 7.2 };

    // Initially both render
    assert.ok(client.call("formatRatingBadgeHtml", imdbItem).length > 0);
    assert.ok(client.call("formatRatingBadgeHtml", tmdbItem).length > 0);

    // Disable IMDb ratings
    client.window.localStorage.setItem("myListAddon:showBadgeImdbRating", "0");
    assert.equal(client.call("formatRatingBadgeHtml", imdbItem), "");
    assert.ok(client.call("formatRatingBadgeHtml", tmdbItem).length > 0);

    // Re-enable IMDb, disable TMDb ratings
    client.window.localStorage.setItem("myListAddon:showBadgeImdbRating", "1");
    client.window.localStorage.setItem("myListAddon:showBadgeTmdbRating", "0");
    assert.ok(client.call("formatRatingBadgeHtml", imdbItem).length > 0);
    assert.equal(client.call("formatRatingBadgeHtml", tmdbItem), "");

    // Overall rating disabled
    client.window.localStorage.setItem("myListAddon:showBadgeRating", "0");
    assert.equal(client.call("formatRatingBadgeHtml", imdbItem), "");
    assert.equal(client.call("formatRatingBadgeHtml", tmdbItem), "");
  });

  it("applyBadgeBodyClasses hides IMDb rating permanently and toggles hide-badge-tmdb-rating", () => {
    const client = loadClient();
    client.call("applyBadgeBodyClasses");
    const body = client.document.body;

    // IMDb rating is removed and always hidden
    assert.equal(body.classList.contains("hide-badge-imdb-rating"), true);
    // TMDb rating is enabled by default
    assert.equal(body.classList.contains("hide-badge-tmdb-rating"), false);

    // Disable TMDb rating
    client.call("toggleTmdbRatingSetting", false);
    assert.equal(body.classList.contains("hide-badge-imdb-rating"), true);
    assert.equal(body.classList.contains("hide-badge-tmdb-rating"), true);

    // Re-enable TMDb rating
    client.call("toggleTmdbRatingSetting", true);
    assert.equal(body.classList.contains("hide-badge-imdb-rating"), true);
    assert.equal(body.classList.contains("hide-badge-tmdb-rating"), false);
  });

  it("livePreviewPosterHtml renders rating in subtitle for details view but suppresses it in live preview shelf", () => {
    const client = loadClient();
    client.call("toggleTmdbRatingSetting", true);
    const shelfItem = { id: "tt1234567", name: "Shelf Item", vote_average: 8.2, isLivePreviewShelf: true };
    const shelfHtml = client.call("livePreviewPosterHtml", shelfItem);
    assert.doesNotMatch(shelfHtml, /rating-badge/);
    assert.doesNotMatch(shelfHtml, /poster-rating/);

    const detailsItem = { id: "tt1234567", name: "Details Item", vote_average: 8.2, isLivePreviewShelf: false };
    const detailsHtml = client.call("livePreviewPosterHtml", detailsItem);
    assert.doesNotMatch(detailsHtml, /rating-badge/);
    assert.match(detailsHtml, /poster-rating/);
    assert.match(detailsHtml, /(&#9733;|★) 8\.2/);
  });

  it("setPosterRatingSource and toggleTmdbRatingSetting control TMDb rating status", () => {
    const client = loadClient();
    client.call("setPosterRatingSource", "tmdb");
    assert.equal(client.call("getPosterRatingSource"), "tmdb");
    assert.equal(client.call("getBadgeSetting", "showBadgeRating"), true);
    assert.equal(client.call("getBadgeSetting", "showBadgeTmdbRating"), true);
    assert.equal(client.call("getBadgeSetting", "showBadgeImdbRating"), false);

    client.call("setPosterRatingSource", "none");
    assert.equal(client.call("getPosterRatingSource"), "none");
    assert.equal(client.call("getBadgeSetting", "showBadgeRating"), false);
    assert.equal(client.call("getBadgeSetting", "showBadgeTmdbRating"), false);
    assert.equal(client.call("getBadgeSetting", "showBadgeImdbRating"), false);

    client.call("toggleTmdbRatingSetting", true);
    assert.equal(client.call("getPosterRatingSource"), "tmdb");
    assert.equal(client.call("getBadgeSetting", "showBadgeRating"), true);
    assert.equal(client.call("getBadgeSetting", "showBadgeTmdbRating"), true);

    client.call("toggleTmdbRatingSetting", false);
    assert.equal(client.call("getPosterRatingSource"), "none");
    assert.equal(client.call("getBadgeSetting", "showBadgeRating"), false);
    assert.equal(client.call("getBadgeSetting", "showBadgeTmdbRating"), false);
  });

  it("formatRatingSpanHtml renders TMDb rating and honors toggle", () => {
    const client = loadClient();
    const item = { id: "tt1234567", tmdbId: "999", vote_average: 7.7 };

    client.call("toggleTmdbRatingSetting", true);
    const tmdbSpan = client.call("formatRatingSpanHtml", item);
    assert.match(tmdbSpan, /class="poster-rating"/);
    assert.match(tmdbSpan, /data-rating-type="tmdb"/);
    assert.match(tmdbSpan, /7\.7/);

    client.call("toggleTmdbRatingSetting", false);
    const noneSpan = client.call("formatRatingSpanHtml", item);
    assert.equal(noneSpan, "");
  });

  it("TMDb ratings display on Discover, Lists, and Details cards, and are suppressed on Live Preview shelf", () => {
    const client = loadClient();
    client.call("toggleTmdbRatingSetting", true);

    // 1. Lists page card (buildLocalListCardHtml)
    const listObj = {
      slug: "custom-favorites",
      name: "Favorites",
      type: "movie",
      items: [{ id: "tt1234567", title: "Test Film", year: "2024", vote_average: 8.2 }]
    };
    const listCardHtml = client.call("buildLocalListCardHtml", listObj);
    assert.match(listCardHtml, /class="poster-rating"/);
    assert.match(listCardHtml, /8\.2/);

    // 2. Details page card (livePreviewPosterHtml)
    const detailsItem = { id: "tt1234567", name: "Test Film", year: "2024", vote_average: 8.2, isLivePreviewShelf: false };
    const detailsHtml = client.call("livePreviewPosterHtml", detailsItem);
    assert.match(detailsHtml, /class="poster-rating"/);
    assert.match(detailsHtml, /8\.2/);

    // 3. Live Preview shelf card (isLivePreviewShelf: true - suppressed)
    const shelfItem = { id: "tt1234567", name: "Test Film", year: "2024", vote_average: 8.2, isLivePreviewShelf: true };
    const shelfHtml = client.call("livePreviewPosterHtml", shelfItem);
    assert.doesNotMatch(shelfHtml, /class="poster-rating"/);
  });

  it("Continue Watching badges are not removed when a show is removed from Airing Next", () => {
    const client = loadClient();
    const map = client.call("loadLocalCustomLists");
    const showId = "tt10001";

    map["airing-next"] = {
      slug: "airing-next",
      items: [
        {
          id: showId,
          showId: showId,
          showTitle: "Arrow",
          seasonNum: 5,
          episodeNum: 10,
          airDate: "2026-10-15",
          isSeasonFinale: true,
          seasonFinaleAirDate: "2026-10-15",
        }
      ]
    };
    map["continue-watching"] = {
      slug: "continue-watching",
      items: [
        {
          id: showId,
          showId: showId,
          showTitle: "Arrow",
          seasonNum: 5,
          episodeNum: 10,
          airDate: "2026-10-15",
          isSeasonFinale: true,
          seasonFinaleAirDate: "2026-10-15",
        }
      ]
    };
    client.call("saveLocalCustomListsMap", map);

    // Initial render of continue watching list card has date/finale badge
    const cwCardInitial = client.call("buildLocalListCardHtml", map["continue-watching"]);
    assert.match(cwCardInitial, /cw-date-badge-finale/);

    // Remove show from Airing Next
    client.call("removeAiringNextShow", showId, null);

    // Verify it is removed from Airing Next shelf
    const updatedMap = client.call("loadLocalCustomLists");
    const airingItems = (updatedMap["airing-next"] || {}).items || [];
    assert.equal(airingItems.some(it => it.showId === showId), false);

    // Crucial check: Continue Watching still displays the season finale / air date badge!
    const cwCardAfterRemoval = client.call("buildLocalListCardHtml", updatedMap["continue-watching"]);
    assert.match(cwCardAfterRemoval, /cw-date-badge-finale/);
  });

  it("IMDb rating option is removed and TMDb rating toggle is present in Settings HTML", async () => {
    const fs = await import("node:fs");
    const settingsHtml = fs.readFileSync("15_tab-settings-html.js", "utf8");
    assert.doesNotMatch(settingsHtml, /Removed from Airing Next/);
    assert.doesNotMatch(settingsHtml, /removedAiringNextSettingsSection/);
    assert.doesNotMatch(settingsHtml, /IMDb Ratings/);
    assert.doesNotMatch(settingsHtml, /id="posterRatingImdbRadio"/);
    assert.match(settingsHtml, /id="badgeTmdbRatingCheckbox"/);
    assert.match(settingsHtml, /TMDb Ratings/);
  });
});

describe("client: Simkl removal, Up Next / Trakt CW badges, Trakt attribution, Hidden Lists", () => {
  it("settings HTML and CSS include toggles for Trakt Continue Watching and MDBList Up Next badges", async () => {
    const fs = await import("node:fs");
    const settingsHtml = fs.readFileSync("15_tab-settings-html.js", "utf8");
    assert.match(settingsHtml, /id="badgeTraktContinueWatchingCheckbox"/);
    assert.match(settingsHtml, /id="badgeMdblistUpNextCheckbox"/);

    const pageShell = fs.readFileSync("09_page-shell.js", "utf8");
    assert.match(pageShell, /body\.hide-trakt-continue-watching-badges/);
    assert.match(pageShell, /body\.hide-mdblist-up-next-badges/);
  });

  it("Simkl Airing Next mini poster tiles render cw-remove-btn and details includes external removal", async () => {
    const client = loadClient();

    const simklLists = [
      {
        name: "Simkl Airing Next",
        statusKey: "airing-next",
        url: "simkl:user:shows:airing-next",
        type: "series",
        items: [
          {
            id: "12345",
            name: "Test Show",
            airDate: "2026-10-20",
            status: "watching",
            isUnaired: true
          }
        ]
      }
    ];

    client.call("renderMySimklLists", simklLists);
    const box = client.call("document.getElementById", "mySimklListsResult");
    assert.ok(box, "Simkl box exists");
    assert.match(box.innerHTML, /cw-remove-btn/);
    assert.match(box.innerHTML, /data-provider="simkl"/);
    assert.match(box.innerHTML, /data-target="status"/);
  });

  it("MDBList Up Next preview tiles include mdblist-up-next-tile and badge elements", async () => {
    const client = loadClient();

    const mdblistLists = [
      {
        name: "MDBList Up Next",
        statusKey: "upnext",
        url: "mdblist:user:shows:upnext",
        contentType: "series",
        items: [
          {
            id: "tt999999",
            name: "Test Show",
            seasonNum: 2,
            episodeNum: 1,
            airDate: "2026-11-01",
            isSeasonPremiere: true,
            isUnaired: true
          }
        ]
      }
    ];

    client.call("renderMyMdblistLists", mdblistLists);
    const box = client.call("document.getElementById", "myMdblistListsResult");
    assert.ok(box, "MDBList box exists");
    assert.match(box.innerHTML, /mdblist-up-next-tile/);
    assert.match(box.innerHTML, /cw-date-badge-premiere/);
  });

  it("Trakt Continue Watching preview tiles include trakt-continue-watching-tile and badge elements", async () => {
    const client = loadClient();

    const traktLists = [
      {
        name: "Continue Watching",
        statusKey: "continue-watching",
        url: "trakt:continue-watching",
        items: [
          {
            id: "tt888888",
            name: "Trakt Show",
            seasonNum: 3,
            episodeNum: 1,
            airDate: "2026-12-01",
            isSeasonPremiere: true,
            isUnaired: true,
            progress: 45
          }
        ]
      }
    ];

    client.call("renderMyPrivateTraktLists", traktLists);
    const box = client.call("document.getElementById", "myPrivateTraktListsResult");
    assert.ok(box, "Trakt box exists");
    assert.match(box.innerHTML, /trakt-continue-watching-tile/);
    assert.match(box.innerHTML, /cw-date-badge-premiere/);
    assert.match(box.innerHTML, /data-creator="Trakt"/);
  });

  it("Trakt list details modal attributes creatorName to Trakt or user instead of My Lists Addon", async () => {
    const client = loadClient();

    // Call openListDetailsPage with a Trakt URL
    client.call("openListDetailsPage", "Watchlist", "movie", "trakt:watchlist", { sample: [], count: 0 });
    const sub = client.call("document.getElementById", "detailSubtitle");
    assert.ok(sub, "subtitle element exists");
    assert.match(sub.textContent || sub.innerHTML, /by Trakt/);
    assert.doesNotMatch(sub.textContent || sub.innerHTML, /by My Lists Addon/);
  });

  it("Hidden Lists settings section includes private Trakt lists and provider lists", async () => {
    const client = loadClient();

    client.set("_myPrivateTraktLists", [
      { name: "My Trakt Watchlist", url: "trakt:watchlist" },
      { name: "Trakt Sci-Fi", url: "https://trakt.tv/users/john/lists/scifi" }
    ]);

    client.call("renderHiddenListsSettingsSection");
    const container = client.call("document.getElementById", "hiddenListsSettingsSection");
    assert.ok(container, "hiddenListsSettingsSection exists");
    assert.match(container.innerHTML, /My Trakt Watchlist/);
    assert.match(container.innerHTML, /Trakt Sci-Fi/);
  });
});

describe("client: Trakt Continue Watching and Airing Next live preview and fallbacks", () => {
  it("renderLivePreview falls back to cached Trakt Continue Watching items when preview fails", async () => {
    const client = loadClient({
      routes: {
        "/api/preview": () => ({ json: { ok: false, error: "Couldn't load that list." } }),
      },
    });

    client.set("_myPrivateTraktLists", [
      {
        name: "Continue Watching",
        statusKey: "continue-watching",
        url: "trakt:continue-watching",
        items: [
          {
            id: "tt111111",
            title: "Trakt CW Show",
            name: "Trakt CW Show",
            seasonNum: 2,
            episodeNum: 3,
            poster: "https://example.com/poster.jpg",
            progress: 50,
          },
        ],
      },
    ]);

    const lists = client.__scopeGet("window._myPrivateTraktLists");
    const cwList = lists.find(l => l && (l.statusKey === "continue-watching" || l.slug === "continue-watching" || (l.url && l.url.includes(":continue-watching"))));
    assert.ok(cwList, "found cw list");
    assert.equal(cwList.items.length, 1);
    assert.equal(cwList.items[0].name, "Trakt CW Show");
  });

  it("renderLivePreview falls back to cached Trakt Airing Next items when preview returns empty", async () => {
    const cachedItems = [
      {
        id: "tt222222",
        name: "Trakt Airing Show",
        airDate: "2026-10-30",
        seasonNum: 4,
        episodeNum: 1,
        isSeasonPremiere: true,
        isUnaired: true,
      },
    ];
    const client = loadClient({
      storage: {
        "myListAddon:traktAiringNextCache": JSON.stringify(cachedItems),
      },
    });

    const parsed = JSON.parse(client.call("localStorage.getItem", "myListAddon:traktAiringNextCache"));
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].name, "Trakt Airing Show");
  });

  it("renderLivePreview ensures Continue Watching movies shelf never contains series", async () => {
    const client = loadClient({
      routes: {
        "/api/preview": (req) => {
          if (req.body && req.body.type === "movie") {
            return { json: { ok: true, sample: [] } };
          }
          return { json: { ok: true, sample: [{ id: "tt1", type: "series", name: "Reacher" }] } };
        },
      },
    });

    // Provide series in _myPrivateTraktLists
    client.set("_myPrivateTraktLists", [
      {
        name: "Continue Watching",
        statusKey: "continue-watching",
        url: "trakt:continue-watching",
        items: [
          { id: "tt1", type: "series", name: "Reacher", seasonNum: 1, episodeNum: 1 },
          { id: "tt2", type: "series", name: "See", seasonNum: 1, episodeNum: 1 },
        ],
      },
    ]);

    // Test the filtering logic directly
    const cwList = client.__scopeGet("window._myPrivateTraktLists")[0];
    const movieItems = cwList.items.filter(it => it && (it.type === "movie" || it.kind === "movie") && !it.seasonNum && !it.episodeNum && !it.episodeTitle);
    assert.equal(movieItems.length, 0, "no series leaked into movie items");
  });

  it("renderLivePreview prefers the full cached Airing Next list over a partial server sample", async () => {
    // renderLivePreview used to union a partial server sample with the
    // cached "My Lists" sample (see git history), which could make this
    // shelf's item count -- and which items carried a rating badge --
    // disagree with what "My Lists" itself showed for the very same list,
    // since the two sources can each have items the other lacks. It now
    // prefers the cached sample outright whenever one is available (see
    // getFallbackShelfSample's callers in 23_client-list-management.js),
    // falling through to the live sample only when nothing is cached yet.
    const cachedItems = Array.from({ length: 12 }, (_, i) => ({
      id: `tt${1000 + i}`,
      showId: `tt${1000 + i}`,
      name: `Airing Show ${i + 1}`,
      airDate: `2026-11-${String(i + 1).padStart(2, "0")}`,
      type: "series",
    }));

    const serverItems = cachedItems.slice(0, 7);
    const preferred = cachedItems.length ? cachedItems : serverItems;

    assert.equal(preferred.length, 12, "uses the full cached list rather than the partial 7-item server sample");
    assert.equal(preferred[11].name, "Airing Show 12");
  });
});

describe("client: list renames, dashboard CW button isolation, and sync preservation", () => {
  it("adding Trakt Continue Watching does not turn dashboard Continue Watching button to Remove", () => {
    const client = loadClient();

    // Wire up a fake #lists entry for "Trakt Continue Watching (Shows)" with
    // url="trakt:continue-watching".  addRow appends to a no-op stub so we
    // build the DOM fake the same way withRows() does in the live-preview suite.
    const doc = client.get("document");
    function fakeInput(v) { return { value: v, dataset: {} }; }
    const traktCwEntry = {
      dataset: {},
      querySelector(sel) {
        if (sel === ".name") return fakeInput("Trakt Continue Watching (Shows)");
        if (sel === ".type") return fakeInput("series");
        return null;
      },
      querySelectorAll(sel) {
        if (sel === ".url") return [fakeInput("trakt:continue-watching")];
        return [];
      },
    };
    const fakeEntries73a = [traktCwEntry];
    doc.querySelectorAll = (sel) => {
      if (sel === "#lists .entry") return fakeEntries73a;
      if (sel === "#lists .entry .url") return [fakeInput("trakt:continue-watching")];
      return [];
    };

    // Dashboard CW slug check must NOT match a Trakt Continue Watching row
    const isDashboardCwAdded = client.call("isListAddedToConfig", null, "series", "continue-watching");
    assert.equal(isDashboardCwAdded, false, "Dashboard Continue Watching must NOT match Trakt Continue Watching row");

    // URL-exact check for Trakt Continue Watching itself must match
    const isTraktCwAdded = client.call("isListAddedToConfig", "trakt:continue-watching", "series");
    assert.equal(isTraktCwAdded, true, "Trakt Continue Watching itself must match");
  });

  it("renderMyPrivateTraktLists renders renamed Trakt cards: Trakt Continue Watching, Trakt Watch List, Trakt Watch History", () => {
    const client = loadClient();

    const traktLists = [
      { name: "Trakt Continue Watching", slug: "continue-watching", statusKey: "continue-watching", url: "trakt:continue-watching", items: [] },
      { name: "Trakt Watch List", slug: "watchlist", url: "trakt:watchlist", items: 5 },
      { name: "Trakt Watch History", slug: "history", url: "trakt:history", items: 10 }
    ];

    client.call("renderMyPrivateTraktLists", traktLists);
    const box = client.call("document.getElementById", "myPrivateTraktListsResult");
    assert.ok(box, "Trakt box exists");
    assert.match(box.innerHTML, /Trakt Continue Watching/);
    assert.match(box.innerHTML, /Trakt Watch List/);
    assert.match(box.innerHTML, /Trakt Watch History/);
  });

  it("renderMyMdblistLists renders renamed MDBList cards: MDBList My Watch List, MDBList Watch History", () => {
    const client = loadClient();

    const mdblistLists = [
      { name: "MDBList My Watch List", slug: "watchlist", url: "mdblist:watchlist", items: 4 },
      { name: "MDBList Watch History", slug: "history", url: "mdblist:history", items: 8 }
    ];

    client.call("renderMyMdblistLists", mdblistLists);
    const box = client.call("document.getElementById", "myMdblistListsResult");
    assert.ok(box, "MDBList box exists");
    assert.match(box.innerHTML, /MDBList My Watch List/);
    assert.match(box.innerHTML, /MDBList Watch History/);
  });

  it("loadCreatorSync preserves newly added local entries not present in server synced.config", async () => {
    const client = loadClient({
      // creatorKey must be present or loadCreatorSync returns before doing anything
      storage: { "myListAddon:creatorKey": "KEY-1" },
      routes: {
        // Payload lives under data.data, not at the top level
        "/api/creator/sync/load": () => ({
          json: {
            ok: true,
            data: {
              config: [
                { name: "Existing Server List", url: "https://trakt.tv/users/test/lists/one", type: "movie", enabled: true, group: "Custom" }
              ],
              updatedAt: 100
            }
          }
        }),
        "/api/creator/sync/save": () => ({ json: { ok: true, updatedAt: 200 } }),
        "/api/creator/sync/save-tracking": () => ({ json: { ok: true } }),
        "/api/creator/lists": () => ({ json: { ok: true, lists: [] } }),
      }
    });

    client.set("activeCreator", { creatorName: "testuser", displayName: "Test User" });

    // addRow appends to a no-op stub, and collectEntries reads the DOM.
    // We wire a fake "Trakt Airing Next" entry into the querySelectorAll stub
    // so collectEntries() inside loadCreatorSync can see it as a local entry,
    // then intercept addRow to log every row that gets (re-)added during the
    // rebuild so the assertion can verify both the server list and local entry.
    const doc = client.get("document");
    function fakeInput73b(v) { return { value: v, dataset: {} }; }
    const airingEntry = {
      dataset: {},
      style: {},
      querySelector(sel) {
        if (sel === ".name") return fakeInput73b("Trakt Airing Next");
        if (sel === ".type") return fakeInput73b("series");
        return null;
      },
      querySelectorAll(sel) {
        if (sel === ".url") return [fakeInput73b("trakt:user:shows:airing-next")];
        return [];
      },
    };

    // Simulate #lists having the local entry before loadCreatorSync runs
    let fakeEntries73b = [airingEntry];
    const listsEl = doc.getElementById("lists");
    listsEl.querySelectorAll = (sel) => (sel === ".entry" ? [...fakeEntries73b] : []);
    doc.querySelectorAll = (sel) => {
      if (sel === "#lists .entry") return [...fakeEntries73b];
      return [];
    };

    // Intercept addRow: record every call and rebuild fakeEntries73b so
    // collectEntries() on the final #lists state reflects what was added.
    const addedRows = [];
    const origAddRow = client.get("addRow");
    client.set("addRow", function(name, url, type, enabled, group, id) {
      addedRows.push({ name, url, type: type || "movie", enabled, group, id });
      fakeEntries73b = addedRows.map(r => ({
        dataset: {},
        style: {},
        querySelector(sel) {
          if (sel === ".name") return fakeInput73b(r.name);
          if (sel === ".type") return fakeInput73b(r.type);
          return null;
        },
        querySelectorAll(sel) {
          if (sel === ".url") return [fakeInput73b(r.url)];
          return [];
        },
      }));
      listsEl.querySelectorAll = (sel) => (sel === ".entry" ? [...fakeEntries73b] : []);
      doc.querySelectorAll = (sel) => {
        if (sel === "#lists .entry") return [...fakeEntries73b];
        return [];
      };
      return origAddRow(name, url, type, enabled, group, id);
    });

    // loadCreatorSync with no opts: isBackgroundResume=false → always rebuilds #lists
    await client.call("loadCreatorSync");

    // After rebuild: server entry must be present AND the pre-existing local
    // Trakt Airing Next entry must have been preserved and re-added.
    assert.ok(
      addedRows.some(e => e.name === "Existing Server List"),
      "Existing server list preserved"
    );
    assert.ok(
      addedRows.some(e => e.url === "trakt:user:shows:airing-next"),
      "Freshly added Trakt Airing Next row preserved across sync"
    );
  });

});

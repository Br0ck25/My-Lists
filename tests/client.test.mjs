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
      liveSync: true, sourceUrl: "https://trakt.tv/users/x/lists/y",
      dynamic: "", shareCode: "AbC123", sharePublished: true,
    };
    client.call("saveLocalChannel", payload);
    const saved = client.call("loadLocalChannels").ch1;
    for (const key of [
      "dailyRotate", "rotateShows", "rotateEpisodes", "rotateTurnover",
      "rotateTurnoverTime", "rotateTurnoverZone", "hideWatched",
      "liveSync", "sourceUrl", "shareCode", "sharePublished",
    ]) {
      assert.deepEqual(plain(saved[key]), payload[key], `${key} survived the save`);
    }
    assert.deepEqual(plain(saved.storyLocked), ["tt1"]);
  });

  it("keeps the flags through a SECOND save, which is where a dropped field shows up", () => {
    const client = builder();
    client.call("saveLocalChannel", {
      channelId: "ch1", name: "Block Party", items: [epOf("tt1", 1, 1, "Simpsons")],
      dailyRotate: true, rotateShows: 6, hideWatched: true, storyLocked: ["tt1"],
    });
    // saveLocalChannelsMap rebuilds every record, so a field it does not know
    // about is lost here rather than on the first write.
    client.call("saveLocalChannelsMap", client.call("loadLocalChannels"));
    const saved = client.call("loadLocalChannels").ch1;
    assert.equal(saved.dailyRotate, true);
    assert.equal(saved.rotateShows, 6);
    assert.equal(saved.hideWatched, true);
    assert.deepEqual(plain(saved.storyLocked), ["tt1"]);
  });

  it("normalizes anything missing rather than writing undefined into the payload", () => {
    const client = builder();
    const f = plain(client.call("channelBroadcastFields", {}));
    assert.deepEqual(f, {
      dailyRotate: false, rotateShows: 0, rotateEpisodes: 0, rotateTurnover: 0,
      rotateTurnoverTime: "", rotateTurnoverZone: "utc", hideWatched: false,
      storyLocked: [], liveSync: false, sourceUrl: "", dynamic: "",
    });
    assert.deepEqual(plain(client.call("channelBroadcastFields", null).storyLocked), []);
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

  it("saves a channel with no picks of its own", () => {
    const client = loadClient({ routes: {} });
    client.set("activeCreator", { creatorName: "alice" });
    client.call("createNextUpChannel", null);
    const saved = Object.values(client.call("loadLocalChannels"));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].dynamic, "next-up");
    assert.deepEqual(plain(saved[0].items), [], "the Worker fills this in per request");
  });

  it("opens the one that exists instead of adding a second", () => {
    const client = loadClient({ routes: {} });
    client.set("activeCreator", { creatorName: "alice" });
    client.call("createNextUpChannel", null);
    client.call("createNextUpChannel", null);
    assert.equal(Object.keys(client.call("loadLocalChannels")).length, 1);
  });
});

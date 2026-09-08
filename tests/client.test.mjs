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

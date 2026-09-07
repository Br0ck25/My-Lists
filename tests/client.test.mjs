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

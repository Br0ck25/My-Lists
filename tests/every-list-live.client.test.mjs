// The client half of "every list is live": a custom list with no Creator
// Profile behind it gets a server-side copy addressed by a token, so an item
// added or removed on the website reaches Stremio instead of the row serving
// the snapshot baked into the install link. The server half is covered by
// tests/every-list-live.test.mjs.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadClient, requestsTo } from "./client-harness.mjs";

const LIVE_SAVE = "/api/list-live/save";

const localRow = (slug, items) =>
  "customlist:v1:" + JSON.stringify({ listId: "L1", localSlug: slug, listSlug: slug, type: "movie", items, shuffle: false });

const creatorRow = (slug, items, owner) =>
  "customlist:v1:" + JSON.stringify({
    listId: "L2", creatorSlug: slug, listSlug: slug, creatorOwner: owner,
    type: "movie", items, shuffle: false,
  });

const item = (n) => ({ id: `tt000000${n}`, imdbId: `tt000000${n}`, type: "movie", title: `Title ${n}` });

// Wires #lists the way the builder page has it: one .entry per row, each with
// a single .url input, so collectEntries/collectKeys see them.
function withRows(client, rows) {
  const input = (value) => ({ value, dataset: {} });
  const entries = rows.map((r) => ({
    dataset: {},
    querySelector(sel) {
      if (sel === ".name") return input(r.name);
      if (sel === ".type") return input(r.type);
      if (sel === ".url") return input(r.url);
      return null;
    },
    querySelectorAll(sel) { return sel === ".url" ? [input(r.url)] : []; },
  }));
  const doc = client.get("document");
  const lists = doc.getElementById("lists");
  lists.querySelectorAll = (sel) => (sel === ".entry" ? entries : []);
  doc.querySelectorAll = (sel) => {
    if (sel === "#lists .entry") return entries;
    if (sel === "#lists .entry .url") return rows.map((r) => input(r.url));
    return [];
  };
  return entries;
}

describe("client: a local custom list gets a live server-side copy", () => {
  it("stamps a stable token onto the row and pushes the list under it", async () => {
    const client = loadClient({ routes: { [LIVE_SAVE]: () => ({ json: { ok: true } }) } });
    const stamped = client.call("withLiveListToken", localRow("faves", [item(1)]));
    const payload = JSON.parse(stamped.slice("customlist:v1:".length));
    assert.match(payload.liveToken, /^[A-Za-z0-9_-]{22}$/, "the token is the shape the server mints and accepts");

    await client.call("flushLiveLists");
    const posts = requestsTo(client, LIVE_SAVE);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].method, "POST");
    assert.equal(posts[0].body.token, payload.liveToken);
    assert.deepEqual(posts[0].body.items.map((i) => i.id), ["tt0000001"]);
  });

  it("reuses the same token for the same list, so the record does not orphan", () => {
    const client = loadClient({ routes: { [LIVE_SAVE]: () => ({ json: { ok: true } }) } });
    const first = JSON.parse(client.call("withLiveListToken", localRow("faves", [item(1)])).slice("customlist:v1:".length));
    const second = JSON.parse(client.call("withLiveListToken", localRow("faves", [item(1), item(2)])).slice("customlist:v1:".length));
    assert.equal(second.liveToken, first.liveToken);
  });

  it("gives different lists different tokens", () => {
    const client = loadClient({ routes: { [LIVE_SAVE]: () => ({ json: { ok: true } }) } });
    const a = JSON.parse(client.call("withLiveListToken", localRow("faves", [item(1)])).slice("customlist:v1:".length));
    const b = JSON.parse(client.call("withLiveListToken", localRow("watch-later", [item(1)])).slice("customlist:v1:".length));
    assert.notEqual(a.liveToken, b.liveToken);
  });

  it("leaves a row that is already live alone", () => {
    const client = loadClient({ routes: { [LIVE_SAVE]: () => ({ json: { ok: true } }) } });
    // A Creator list: its live copy is the account's and the row names it.
    const creator = creatorRow("faves", [item(1)], "alice");
    assert.equal(client.call("withLiveListToken", creator), creator);
    // Already stamped.
    const stamped = client.call("withLiveListToken", localRow("faves", [item(1)]));
    assert.equal(client.call("withLiveListToken", stamped), stamped);
  });

  it("pushes the list's full items, not one row's half of a mixed list", async () => {
    const client = loadClient({
      storage: {
        "myListAddon:localCustomLists": JSON.stringify({
          faves: { slug: "faves", name: "Faves", type: "mixed", items: [item(1), item(2)] },
        }),
      },
      routes: { [LIVE_SAVE]: () => ({ json: { ok: true } }) } },
    );
    // The movies half of a mixed list, as its own row carries it.
    const stamped = client.call("withLiveListToken", localRow("faves", [item(1)]));
    assert.ok(stamped.includes("liveToken"));
    await client.call("flushLiveLists");
    const body = requestsTo(client, LIVE_SAVE)[0].body;
    assert.deepEqual(body.items.map((i) => i.id), ["tt0000001", "tt0000002"],
      "the record holds both halves or the other row filters itself to nothing");
    assert.equal(body.name, "Faves");
    assert.equal(body.type, "mixed");
  });

  it("stamps the token onto a row as it is added", async () => {
    const client = loadClient({ routes: { [LIVE_SAVE]: () => ({ json: { ok: true } }) } });
    // The DOM stub's querySelectorAll answers [], so give the created row an
    // element that can actually find the .url inputs addRow renders into it.
    const doc = client.get("document");
    const origCreate = doc.createElement;
    doc.createElement = () => {
      const node = origCreate();
      node.querySelectorAll = (sel) => {
        if (sel !== ".sources .url") return [];
        const m = String(node.innerHTML).match(/class="url" value="([\s\S]*?)"/);
        if (!m) return [];
        const value = m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
        return [{ value }];
      };
      return node;
    };
    client.call("addRow", "Mine", localRow("mine", [item(1)]), "movie", true, "Custom Lists");
    await client.call("flushLiveLists");
    const posts = requestsTo(client, LIVE_SAVE);
    assert.equal(posts.length, 1, "the row the builder just added is live from the moment it exists");
    assert.deepEqual(posts[0].body.items.map((i) => i.id), ["tt0000001"]);
    assert.match(posts[0].body.token, /^[A-Za-z0-9_-]{22}$/);
  });

  it("leaves a snapshot of an auto-tracked shelf alone", () => {
    const client = loadClient({ routes: { [LIVE_SAVE]: () => ({ json: { ok: true } }) } });
    // Watch History / Continue Watching / Watchlist / Airing Next live as
    // autotrack: rows, and the server does not read a token record for them.
    const snapshot = localRow("continue-watching", [item(1)]);
    assert.equal(client.call("withLiveListToken", snapshot), snapshot);
    const mine = localRow("mine", [item(1)]);
    assert.notEqual(client.call("withLiveListToken", mine), mine);
  });

  it("stores the list's own name and type, not the row's half of it", async () => {
    const client = loadClient({
      storage: {
        "myListAddon:localCustomLists": JSON.stringify({
          faves: { slug: "faves", name: "Faves", type: "mixed", items: [item(1), item(2)] },
        }),
      },
      routes: { [LIVE_SAVE]: () => ({ json: { ok: true } }) } },
    );
    // A signed-in edit re-pushes an already-stamped row (the path
    // syncCustomListToCatalogRows takes); the record still has to describe the
    // whole list rather than whichever row fired the push.
    const stamped = JSON.parse(client.call("withLiveListToken", localRow("faves", [item(1)])).slice("customlist:v1:".length));
    await client.call("flushLiveLists");
    const body = requestsTo(client, LIVE_SAVE)[0].body;
    assert.equal(body.name, "Faves");
    assert.equal(body.type, "mixed");
    assert.deepEqual(body.items.map((i) => i.id), ["tt0000001", "tt0000002"]);
    assert.equal(body.token, stamped.liveToken);
  });

  it("does not stamp a token onto a row naming another creator's list", async () => {
    const client = loadClient({ routes: { [LIVE_SAVE]: () => ({ json: { ok: true } }) } });
    client.call("addRow", "Theirs", creatorRow("faves", [item(1)], "bob"), "movie", true, "Custom Lists");
    await client.call("flushLiveLists");
    assert.equal(requestsTo(client, LIVE_SAVE).length, 0);
  });
});

// Renaming a list from the Custom List panel reaches the builder row through
// syncCustomListToCatalogRows, which writes rowNameInput.value directly -- and
// a programmatic .value write fires no input event, so the delegated listener
// that keeps ".shelf-title-text" current (updateShelfTitleText) never ran. The
// Live Preview shelf and its See All page kept the OLD name until the whole
// preview was rebuilt.
describe("client: renaming a list retitles its Live Preview shelf", () => {
  it("writes the new name into the field AND the shelf title", async () => {
    const client = loadClient({
      storage: {
        // saveLocalCustomListEdit updates the local record first, then syncs --
        // so by the time the row is touched the store already holds the new name.
        "myListAddon:localCustomLists": JSON.stringify({
          mine: { slug: "mine", name: "New Name", type: "movie", items: [item(1)] },
        }),
      },
      routes: { [LIVE_SAVE]: () => ({ json: { ok: true } }) } },
    );
    // renderLivePreview would reach for /api/preview, which no test stubs.
    client.set("renderLivePreview", async () => {});

    const stamped = client.call("withLiveListToken", localRow("mine", [item(1)]));
    const urlInput = { value: stamped };
    const nameInput = { value: "Old Name" };
    const titleEl = { textContent: "Old Name - Movies" };
    const typeSelect = { value: "movie" };
    const sourceRow = {
      querySelector: (sel) => (sel === ".url" ? urlInput : null),
      replaceWith() {},
    };
    const entry = {
      dataset: {},
      querySelector(sel) {
        if (sel === ".name") return nameInput;
        if (sel === ".type") return typeSelect;
        if (sel === ".shelf-title-text") return titleEl;
        if (sel === ".url") return urlInput;
        return null;
      },
      querySelectorAll(sel) {
        if (sel === ".url") return [urlInput];
        if (sel === ".source-row") return [sourceRow];
        return [];
      },
    };
    client.get("document").querySelectorAll = (sel) => (sel === "#lists .entry" ? [entry] : []);

    client.call("syncCustomListToCatalogRows", "mine", [item(1)], "New Name", "movie");

    assert.equal(nameInput.value, "New Name");
    assert.equal(titleEl.textContent, "New Name - Movies",
      "the shelf the person is looking at has to be called what the list is called now");
    // ...and the live copy the apps read carries the new name too.
    await client.call("flushLiveLists");
    assert.equal(requestsTo(client, LIVE_SAVE)[0].body.name, "New Name");
  });
});

// The See All page titles itself from whatever openLivePreviewSeeAll hands
// it, and that used to be the name the last preview render captured -- so a
// rename from the Custom List panel (which happens after that render) left the
// page showing the old name while the shelf above it showed the new one.
describe("client: See All is titled with the row's current name", () => {
  it("reads the Name field rather than the captured shelf name", () => {
    const client = loadClient();
    const seen = [];
    client.set("openListDetailsPage", (name, type, url, preloaded) => {
      seen.push({ name, type, url, itemCount: preloaded && preloaded.itemCount });
    });

    const nameInput = { value: "New Name" };
    const entryDOM = { querySelector: (sel) => (sel === ".name" ? nameInput : null) };
    client.set("livePreviewShelfData", [{
      name: "Old Name", type: "movie", url: "tmdb:chart:popular",
      sample: [{ id: "tt1" }], maybeMore: false, totalItems: 1, entryDOM,
    }]);

    client.call("openLivePreviewSeeAll", 0);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].name, "New Name");
    assert.equal(seen[0].type, "movie");
    assert.equal(seen[0].url, "tmdb:chart:popular");
    // The page's own count still comes from the captured sample, which is
    // unrelated to the name.
    assert.equal(seen[0].itemCount, 1);
  });

  it("falls back to the captured name when the row is gone", () => {
    const client = loadClient();
    const seen = [];
    client.set("openListDetailsPage", (name) => seen.push(name));
    client.set("livePreviewShelfData", [{
      name: "Old Name", type: "movie", url: "tmdb:chart:popular",
      sample: [], maybeMore: false, totalItems: 0, entryDOM: null,
    }]);
    client.call("openLivePreviewSeeAll", 0);
    assert.deepEqual(seen, ["Old Name"]);
  });
});

describe("client: an install link for a local list proves whose account it is", () => {
  it("carries the Creator identity when the config holds a local custom-list row", () => {
    const client = loadClient({ storage: { "myListAddon:creatorKey": "KEY-1" } });
    client.set("activeCreator", { creatorName: "alice" });
    withRows(client, [{ name: "Mine", url: localRow("faves", [item(1)]), type: "movie" }]);
    const keys = client.get("collectKeys")();
    assert.equal(keys.trackCreatorName, "alice",
      "the server resolves the row against the account the link belongs to, so the link has to name it");
    assert.equal(keys.trackCreatorKey, "KEY-1");
  });

  it("carries it for a Creator-list row too", () => {
    const client = loadClient({ storage: { "myListAddon:creatorKey": "KEY-1" } });
    client.set("activeCreator", { creatorName: "alice" });
    withRows(client, [{ name: "Faves", url: creatorRow("faves", [item(1)], "alice"), type: "movie" }]);
    assert.equal(client.get("collectKeys")().trackCreatorName, "alice");
  });

  it("leaves a row naming someone else's list out of it", () => {
    const client = loadClient({ storage: { "myListAddon:creatorKey": "KEY-1" } });
    client.set("activeCreator", { creatorName: "alice" });
    withRows(client, [{ name: "Theirs", url: creatorRow("faves", [item(1)], "bob"), type: "movie" }]);
    const keys = client.get("collectKeys")();
    assert.equal(keys.trackCreatorName, undefined,
      "the key is a bearer credential and does not belong in a link for someone else's shelf");
  });

  it("carries nothing when nobody is signed in", () => {
    const client = loadClient();
    withRows(client, [{ name: "Mine", url: localRow("faves", [item(1)]), type: "movie" }]);
    assert.equal(client.get("collectKeys")().trackCreatorName, undefined);
  });
});

describe("client: the fallback link carries the identity collectKeys found", () => {
  const build = (client, keys) => {
    const b64 = client.get("buildConfig")([], keys);
    return JSON.parse(client.get("atob")(b64.replace(/-/g, "+").replace(/_/g, "/")));
  };

  it("keeps the account name with tracking off, the way /api/save already does", () => {
    const client = loadClient();
    const payload = build(client, { trackCreatorName: "alice", trackCreatorKey: "KEY-1", track: false });
    assert.equal(payload.trackCreatorName, "alice",
      "a Worker without KV falls back to this link, and it resolves the row the same way");
    assert.equal(payload.trackCreatorKey, "KEY-1");
    assert.equal(payload.track, undefined, "still not tracking playback -- only the identity travels");
  });

  it("keeps it for a config holding nothing of this account's out of the link", () => {
    const client = loadClient();
    const payload = build(client, {});
    assert.equal(payload.trackCreatorName, undefined);
    assert.equal(payload.trackCreatorKey, undefined);
  });

  it("still marks tracking when tracking is on", () => {
    const client = loadClient();
    const payload = build(client, { track: true, trackCreatorName: "alice", trackCreatorKey: "KEY-1" });
    assert.equal(payload.track, true);
    assert.equal(payload.trackCreatorName, "alice");
  });
});

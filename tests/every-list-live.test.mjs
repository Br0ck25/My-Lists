import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeKv, makeD1, makeEnv, call, createUser } from "./harness.mjs";

// Every list on the website has to behave like Continue Watching and Airing
// Next in the apps: an item added on the site shows up in Stremio, and an item
// removed on the site disappears, without the install link being regenerated.
//
// The rows that did not:
//
//   1. A local Custom List (or a Letterboxd import, which is one) baked a
//      one-time customlist:v1: snapshot into the row and carried no live
//      identity, so the server had nothing to re-read -- the row was frozen at
//      whatever it held when "+ Add" was clicked. Adds and removes alike never
//      reached the apps.
//   2. A row whose list lived on the signed-in account but whose payload had
//      lost its creatorSlug (single-type lists saved before it was stamped)
//      was frozen the same way.
//
// Both now resolve live against the account's own server copy, gated exactly
// as fetchLiveCreatorListItems already gates it: a public list to anyone, a
// private one only to a reader that proved it owns the account.

function localRow(slug, items) {
  return "customlist:v1:" + JSON.stringify({
    listId: "L1",
    localSlug: slug,
    listSlug: slug,
    type: "movie",
    items,
    shuffle: false,
  });
}

const catalogIds = async (env, config) =>
  ((await call(env, `/${config}/catalog/movie/faves.json`)).body.metas || []).map((m) => m.id);

async function signedInConfig(env, id, user, rowUrl) {
  await env.CONFIGS.put(`cfg:${id}`, JSON.stringify({
    trackCreatorName: user.creatorName,
    trackCreatorKey: user.creatorKey,
    trackOwner: user.creatorName,
    entries: [{ id: "faves", type: "movie", name: "Faves", url: rowUrl, enabled: true }],
  }));
  return id;
}

async function accountList(env, user, items, visibility) {
  const r = await call(env, "/api/creator/lists/save", {
    method: "POST",
    json: {
      creatorName: user.creatorName, creatorKey: user.creatorKey,
      slug: "faves", name: "Faves", type: "movie", items, visibility,
    },
  });
  assert.equal(r.body.ok, true, r.body.error);
  return r.body.slug;
}

const item = (n) => ({ id: `tt000000${n}`, imdbId: `tt000000${n}`, type: "movie", title: `Title ${n}` });

describe("a local Custom List row is live in the apps", () => {
  it("serves a later server-side edit, both an add and a remove", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    const user = await createUser(env, "livelocal1");
    const config = await signedInConfig(env, "livelocal1", user, localRow("faves", [item(1)]));
    await accountList(env, user, [item(1)], "public");

    assert.deepEqual(await catalogIds(env, config), ["tt0000001"]);

    // An add on the website (which mirrors the list to the account).
    await accountList(env, user, [item(1), item(2)], "public");
    assert.deepEqual((await catalogIds(env, config)).sort(), ["tt0000001", "tt0000002"],
      "an added item must reach the apps with no link regeneration");

    // A remove on the website.
    await accountList(env, user, [item(2)], "public");
    assert.deepEqual(await catalogIds(env, config), ["tt0000002"],
      "a removed item must leave the apps with no link regeneration");
  });

  it("keeps serving the snapshot when the account has no such list", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    const user = await createUser(env, "livelocal2");
    const config = await signedInConfig(env, "livelocal2", user, localRow("faves", [item(1), item(2)]));
    assert.deepEqual((await catalogIds(env, config)).sort(), ["tt0000001", "tt0000002"],
      "a row with no server-side list behind it must not go empty");
  });

  it("is served no-store, like the other live rows", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    const user = await createUser(env, "livelocal3");
    const config = await signedInConfig(env, "livelocal3", user, localRow("faves", [item(1)]));
    await accountList(env, user, [item(1)], "public");
    const res = await call(env, `/${config}/catalog/movie/faves.json`);
    assert.equal(res.headers.get("cache-control"), "no-cache, no-store, must-revalidate, max-age=0");
  });
});

describe("a private list resolves live only for its owner", () => {
  it("gives an unproven reader the snapshot, never the live private items", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    const user = await createUser(env, "livepriv1");
    await accountList(env, user, [item(1), item(2)], "private");
    // Same row, but the install link carries the wrong key -- the name inside
    // it is a claim, not proof.
    await env.CONFIGS.put("cfg:livepriv1", JSON.stringify({
      trackCreatorName: user.creatorName,
      trackCreatorKey: "wrong-key",
      entries: [{ id: "faves", type: "movie", name: "Faves", url: localRow("faves", [item(1)]), enabled: true }],
    }));
    assert.deepEqual(await catalogIds(env, "livepriv1"), ["tt0000001"]);
  });

  it("gives the proven owner the live private items", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    const user = await createUser(env, "livepriv2");
    const config = await signedInConfig(env, "livepriv2", user, localRow("faves", [item(1)]));
    await accountList(env, user, [item(1), item(2)], "private");
    assert.deepEqual((await catalogIds(env, config)).sort(), ["tt0000001", "tt0000002"]);
  });
});

describe("the four auto-tracked shelves are left to their own live rows", () => {
  it("does not silently resolve a watchlist snapshot to the account list", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    const user = await createUser(env, "liveauto1");
    const config = await signedInConfig(env, "liveauto1", user, localRow("watchlist", [item(1)]));
    await accountList(env, user, [item(1), item(2)], "public");
    assert.deepEqual(await catalogIds(env, config), ["tt0000001"],
      "an autotrack: row is the live form of these shelves; a snapshot of one is left alone");
  });
});

describe("a live list addressed by token, for a browser with no account", () => {
  const tokenRow = (token, items) => "customlist:v1:" + JSON.stringify({
    listId: "L2", localSlug: "mine", listSlug: "mine", type: "movie",
    liveToken: token, items, shuffle: false,
  });

  it("re-reads the token record, so an add and a remove both land", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    await env.CONFIGS.put("cfg:tokenlive1", JSON.stringify({
      entries: [{ id: "faves", type: "movie", name: "Mine", url: tokenRow("abcdefghijklmnopqrstuv", [item(1)]), enabled: true }],
    }));
    await env.CONFIGS.put("listlive:abcdefghijklmnopqrstuv", JSON.stringify({
      name: "Mine", type: "movie", items: [item(1)], updatedAt: 1,
    }));
    assert.deepEqual(await catalogIds(env, "tokenlive1"), ["tt0000001"]);

    await env.CONFIGS.put("listlive:abcdefghijklmnopqrstuv", JSON.stringify({
      name: "Mine", type: "movie", items: [item(1), item(2)], updatedAt: 2,
    }));
    assert.deepEqual((await catalogIds(env, "tokenlive1")).sort(), ["tt0000001", "tt0000002"]);

    await env.CONFIGS.put("listlive:abcdefghijklmnopqrstuv", JSON.stringify({
      name: "Mine", type: "movie", items: [], updatedAt: 3,
    }));
    assert.deepEqual(await catalogIds(env, "tokenlive1"), [],
      "removing the last item must empty the row, not freeze it at the snapshot");
  });

  it("falls back to the snapshot for a token with no record", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    await env.CONFIGS.put("cfg:tokenlive2", JSON.stringify({
      entries: [{ id: "faves", type: "movie", name: "Mine", url: tokenRow("abcdefghijklmnopqrstuv", [item(1)]), enabled: true }],
    }));
    assert.deepEqual(await catalogIds(env, "tokenlive2"), ["tt0000001"]);
  });

  // The whole loop the browser drives: it POSTs the list under its token on
  // every edit, and the row -- which carries that token and no items of its
  // own worth serving -- is read from the record. Written through the route
  // rather than planted in KV, so the route's own coercion and caps are what
  // the row ends up being served from.
  it("serves what the browser POSTed, add and remove alike", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    await env.CONFIGS.put("cfg:tokenlive4", JSON.stringify({
      entries: [{ id: "faves", type: "movie", name: "Mine", url: tokenRow("abcdefghijklmnopqrstuv", [item(1)]), enabled: true }],
    }));

    const post = (items) => call(env, "/api/list-live/save", {
      method: "POST",
      json: { token: "abcdefghijklmnopqrstuv", name: "Mine", type: "mixed", items },
    });
    let r = await post([item(1), item(2)]);
    assert.equal(r.body.ok, true, r.body.error);
    assert.deepEqual((await catalogIds(env, "tokenlive4")).sort(), ["tt0000001", "tt0000002"]);

    // The remove. The row's own snapshot still holds both items, so this only
    // passes if the row is being read from the record rather than the URL.
    r = await post([item(2)]);
    assert.equal(r.body.ok, true, r.body.error);
    assert.deepEqual(await catalogIds(env, "tokenlive4"), ["tt0000002"]);

    r = await post([]);
    assert.equal(r.body.ok, true, r.body.error);
    assert.deepEqual(await catalogIds(env, "tokenlive4"), []);
  });

  it("ignores a token that is not the shape this Worker mints", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    await env.CONFIGS.put("cfg:tokenlive3", JSON.stringify({
      entries: [{ id: "faves", type: "movie", name: "Mine", url: tokenRow("nope", [item(1)]), enabled: true }],
    }));
    // A record planted at the malformed key must never be read through it.
    await env.CONFIGS.put("listlive:nope", JSON.stringify({ items: [item(9)] }));
    assert.deepEqual(await catalogIds(env, "tokenlive3"), ["tt0000001"]);
  });
});

describe("POST /api/list-live/save", () => {
  const save = (env, json, opts = {}) => call(env, "/api/list-live/save", { method: "POST", json, ...opts });

  it("stores the list under its token", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    const r = await save(env, { token: "abcdefghijklmnopqrstuv", name: "Mine", type: "movie", items: [item(1)] });
    assert.equal(r.body.ok, true, r.body.error);
    const stored = JSON.parse(await env.CONFIGS.get("listlive:abcdefghijklmnopqrstuv"));
    assert.deepEqual(stored.items.map((i) => i.id), ["tt0000001"]);
    assert.equal(stored.name, "Mine");
  });

  it("overwrites the same token, so a later edit replaces the earlier one", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    await save(env, { token: "abcdefghijklmnopqrstuv", name: "Mine", type: "movie", items: [item(1), item(2)] });
    const r = await save(env, { token: "abcdefghijklmnopqrstuv", name: "Mine", type: "movie", items: [item(2)] });
    assert.equal(r.body.ok, true, r.body.error);
    const stored = JSON.parse(await env.CONFIGS.get("listlive:abcdefghijklmnopqrstuv"));
    assert.deepEqual(stored.items.map((i) => i.id), ["tt0000002"]);
  });

  it("refuses a malformed token", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    for (const token of ["", "short", "has spacesxxxxxxxxxxxxxx", "../etc/passwd::::::::::", "x".repeat(200)]) {
      const r = await save(env, { token, name: "Mine", type: "movie", items: [item(1)] });
      assert.equal(r.body.ok, false, `token ${JSON.stringify(token)} must be refused`);
      assert.ok(r.status >= 400);
    }
  });

  it("refuses a list too large to store", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    const items = Array.from({ length: 10001 }, (_, i) => ({ id: `tt${i}`, type: "movie", title: `T${i}` }));
    const r = await save(env, { token: "abcdefghijklmnopqrstuv", name: "Mine", type: "movie", items });
    assert.equal(r.body.ok, false);
    assert.equal(r.status, 413);
  });

  it("rate-limits a burst from one client", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    let last = null;
    for (let i = 0; i < 65; i++) {
      last = await save(env, { token: "abcdefghijklmnopqrstuv", name: "Mine", type: "movie", items: [] }, { ip: "10.9.9.9" });
    }
    assert.equal(last.status, 429);
  });
});

// A shelf's TITLE in Stremio/Nuvio comes from the manifest, and the
// manifest's name for a Custom List used to be whatever the install link's
// config said the day it was generated -- so renaming a list on the website
// changed it everywhere except in the apps, where the shelf kept the old
// name for as long as the link existed. The manifest now reads the name from
// the same live copy the shelf reads its items from.
describe("renaming a list reaches the shelf title in the apps", () => {
  const manifest = async (env, config) => {
    const res = await call(env, `/${config}/manifest.json`);
    assert.equal(res.status, 200);
    return res.body;
  };
  const shelfName = (m, id) => (m.catalogs || []).find((c) => c.id === id).name;

  it("titles a Creator list row with the list's current name", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    const user = await createUser(env, "rename1");
    const slug = await accountList(env, user, [item(1)], "private");
    const config = await signedInConfig(env, "renamecfg1", user, localRow("faves", [item(1)]));
    assert.equal(shelfName(await manifest(env, config), "faves"), "Faves");

    // The rename on the website (the Custom List panel saves it to the server).
    const r = await call(env, "/api/creator/lists/save", {
      method: "POST",
      json: {
        creatorName: user.creatorName, creatorKey: user.creatorKey,
        slug, name: "Saturday Night Picks", type: "movie", items: [item(1)], visibility: "private",
      },
    });
    assert.equal(r.body.ok, true, r.body.error);
    assert.equal(shelfName(await manifest(env, config), "faves"), "Saturday Night Picks",
      "the shelf in the apps has to be called what the list is called now");
    // ...and the items still come from the same live copy.
    assert.deepEqual(await catalogIds(env, config), ["tt0000001"]);
  });

  it("titles a token-addressed row with the list's current name", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    const row = "customlist:v1:" + JSON.stringify({
      listId: "L9", localSlug: "mine", listSlug: "mine", type: "movie",
      liveToken: "abcdefghijklmnopqrstuv", items: [item(1)], shuffle: false,
    });
    await env.CONFIGS.put("cfg:renamecfg2", JSON.stringify({
      entries: [{ id: "mine", type: "movie", name: "My List", url: row, enabled: true }],
    }));
    const save = (name) => call(env, "/api/list-live/save", {
      method: "POST",
      json: { token: "abcdefghijklmnopqrstuv", name, type: "movie", items: [item(1)] },
    });
    assert.equal(shelfName(await manifest(env, "renamecfg2"), "mine"), "My List");
    await save("Renamed In The Browser");
    assert.equal(shelfName(await manifest(env, "renamecfg2"), "mine"), "Renamed In The Browser");
  });

  it("keeps the config's name when nothing live has a newer one", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    await env.CONFIGS.put("cfg:renamecfg3", JSON.stringify({
      entries: [{ id: "mine", type: "movie", name: "My List", url: localRow("mine", [item(1)]), enabled: true }],
    }));
    // No token, no account: the row is still a snapshot, so the config's name
    // is the only name there is.
    assert.equal(shelfName(await manifest(env, "renamecfg3"), "mine"), "My List");
  });

  it("leaves a mixed list's two split rows with their own labels", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    await env.CONFIGS.put("listlive:abcdefghijklmnopqrstuv", JSON.stringify({
      name: "Faves", type: "mixed", items: [item(1)], updatedAt: 1,
    }));
    const half = (type) => "customlist:v1:" + JSON.stringify({
      listId: "L10", localSlug: "faves", listSlug: "faves", type,
      liveToken: "abcdefghijklmnopqrstuv", items: [item(1)], shuffle: false,
    });
    await env.CONFIGS.put("cfg:renamecfg4", JSON.stringify({
      entries: [
        { id: "faves", type: "movie", name: "Faves (Movies)", url: half("movie"), enabled: true },
        { id: "faves-2", type: "series", name: "Faves (Shows)", url: half("series"), enabled: true },
      ],
    }));
    const m = await manifest(env, "renamecfg4");
    // One list, two shelves: handing both the list's name would put two
    // shelves with the same title on the board.
    assert.equal(shelfName(m, "faves"), "Faves (Movies)");
    assert.equal(shelfName(m, "faves-2"), "Faves (Shows)");
  });

  it("is sent no-store, so the app's next manifest read sees the new name", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    const user = await createUser(env, "rename2");
    const config = await signedInConfig(env, "renamecfg5", user, localRow("faves", [item(1)]));
    await accountList(env, user, [item(1)], "public");
    const res = await call(env, `/${config}/manifest.json`);
    assert.equal(res.headers.get("cache-control"), "no-cache, no-store, must-revalidate, max-age=0");
  });

  it("keeps the ordinary cache for a manifest with nothing live in it", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    await env.CONFIGS.put("cfg:renamechart6", JSON.stringify({
      entries: [{ id: "chart", type: "movie", name: "Popular", url: "tmdb:chart:popular", enabled: true }],
    }));
    const res = await call(env, `/renamechart6/manifest.json`);
    // The manifest resolved (not an empty one) and keeps its ordinary cache:
    // nothing in it can change server-side, so caching it costs nothing.
    assert.equal(shelfName(res.body, "chart"), "Popular");
    assert.equal(res.headers.get("cache-control"), "max-age=3600");
  });
});

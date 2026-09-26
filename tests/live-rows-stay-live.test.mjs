import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeKv, makeD1, makeEnv, call, createUser } from "./harness.mjs";

// Everything Stremio/Nuvio shows has to be live: a website-side edit must
// reach the apps without regenerating the install link. These are the ways
// it did not.
//
// 1. A Creator list added to Catalogs baked a one-time customlist:v1:
//    snapshot into the row. Public lists were re-read live, but private ones
//    always fell back to the snapshot -- so a private list's row froze at
//    whatever it held when "+ Add" was clicked.
// 2. Every non-personal catalog was served with a day-long max-age, so even
//    rows the server re-read live (charts, New on Streaming, Most Watched)
//    could sit stale in the apps for 24 hours.

function customRow(owner, slug, items) {
  return "customlist:v1:" + JSON.stringify({
    listId: "test1", creatorSlug: slug, listSlug: slug, creatorOwner: owner,
    type: "movie", items, shuffle: false,
  });
}

async function setupPrivateList(name) {
  const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
  const user = await createUser(env, name);
  const first = await call(env, "/api/creator/lists/save", {
    method: "POST",
    json: {
      creatorName: user.creatorName, creatorKey: user.creatorKey,
      name: "Faves", type: "movie",
      items: [{ id: "tt0000001", imdbId: "tt0000001", type: "movie", title: "One" }],
      visibility: "private",
    },
  });
  assert.equal(first.body.ok, true, first.body.error);
  return { env, user, slug: first.body.slug };
}

async function storeConfig(env, id, user, { withKey }) {
  const row = customRow(user.creatorName, "faves", [
    { id: "tt0000001", imdbId: "tt0000001", type: "movie", title: "One" },
  ]);
  const payload = {
    trackCreatorName: user.creatorName,
    entries: [{ id: "faves", type: "movie", name: "Faves", url: row, enabled: true }],
  };
  if (withKey) payload.trackCreatorKey = user.creatorKey;
  else payload.trackCreatorKey = "wrong-key";
  await env.CONFIGS.put(`cfg:${id}`, JSON.stringify(payload));
  return id;
}

const catalogIds = async (env, config) =>
  ((await call(env, `/${config}/catalog/movie/faves.json`)).body.metas || []).map((m) => m.id);

describe("a private Creator list stays live in the apps", () => {
  it("serves a later server-side edit without the link changing", async () => {
    const { env, user } = await setupPrivateList("liverow1");
    const config = await storeConfig(env, "cfglive1", user, { withKey: true });
    assert.deepEqual(await catalogIds(env, config), ["tt0000001"]);

    const edit = await call(env, "/api/creator/lists/save", {
      method: "POST",
      json: {
        creatorName: user.creatorName, creatorKey: user.creatorKey, slug: "faves",
        name: "Faves", type: "movie",
        items: [
          { id: "tt0000001", imdbId: "tt0000001", type: "movie", title: "One" },
          { id: "tt0000002", imdbId: "tt0000002", type: "movie", title: "Two" },
        ],
        visibility: "private",
      },
    });
    assert.equal(edit.body.ok, true, edit.body.error);

    assert.deepEqual((await catalogIds(env, config)).sort(), ["tt0000001", "tt0000002"],
      "the apps must see the edit on the next fetch, with no link regen");
  });

  it("still falls back to the snapshot for a link that cannot prove ownership", async () => {
    const { env, user } = await setupPrivateList("liverow2");
    // Same row, but the install link carries the wrong key -- the
    // trackCreatorName inside is a claim, not proof.
    const config = await storeConfig(env, "cfglive2", user, { withKey: false });
    assert.deepEqual(await catalogIds(env, config), ["tt0000001"]);

    await call(env, "/api/creator/lists/save", {
      method: "POST",
      json: {
        creatorName: user.creatorName, creatorKey: user.creatorKey, slug: "faves",
        name: "Faves", type: "movie",
        items: [
          { id: "tt0000001", imdbId: "tt0000001", type: "movie", title: "One" },
          { id: "tt0000002", imdbId: "tt0000002", type: "movie", title: "Two" },
        ],
        visibility: "private",
      },
    });

    assert.deepEqual(await catalogIds(env, config), ["tt0000001"],
      "an unproven reader must keep getting the snapshot, never live private items");
  });
});

describe("catalog cache lifetimes", () => {
  async function setup() {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    const user = await createUser(env, "cachelife");
    await env.CONFIGS.put("cfg:cache1", JSON.stringify({
      trackCreatorName: user.creatorName,
      trackCreatorKey: user.creatorKey,
      entries: [
        // The account's own list: re-read from creatorlist:{user}:{slug} on
        // every request, so it is live state and is never cached.
        { id: "snap", type: "movie", name: "Snap", enabled: true, url: customRow(user.creatorName, "faves", [{ id: "tt1", imdbId: "tt1", type: "movie", title: "T" }]) },
        // Someone else's published list: shared content, five minutes.
        { id: "shared", type: "movie", name: "Shared", enabled: true, url: "https://example.test/lists/someone/some-list" },
        { id: "wl", type: "movie", name: "Watchlist", enabled: true, url: `autotrack:watchlist:movie:${user.creatorName}` },
      ],
    }));
    return { env, config: "cache1" };
  }

  it("shared rows revalidate within minutes, not a day", async () => {
    const { env, config } = await setup();
    const res = await call(env, `/${config}/catalog/movie/shared.json`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "public, max-age=300, s-maxage=300");
  });

  it("a Creator list row is live state, so it is never cached", async () => {
    const { env, config } = await setup();
    const res = await call(env, `/${config}/catalog/movie/snap.json`);
    assert.equal(res.status, 200);
    // The server re-reads this list on every request (fetchCustomListCatalog),
    // so a cached copy is a copy that can disagree with what the account just
    // did -- the same reason the autotrack shelves below are no-store.
    assert.equal(res.headers.get("cache-control"), "no-cache, no-store, must-revalidate, max-age=0");
  });

  it("personal shelves are still never cached", async () => {
    const { env, config } = await setup();
    const res = await call(env, `/${config}/catalog/movie/wl.json`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-cache, no-store, must-revalidate, max-age=0");
  });
});

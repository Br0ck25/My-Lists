import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeKv, makeD1, makeEnv, call } from "./harness.mjs";

// Continue Watching, Airing Next, Watch History and Watchlist are live views
// of one account, not lists. Two things follow, and both are tested here:
// "Remove duplicate items across lists" must leave them alone, and a preset
// must never carry their contents.

const SHOW = "tt0903747";
const OTHER = "tt0111161";

function customUrl(slug, ids) {
  return "customlist:v1:" + JSON.stringify({
    listSlug: slug,
    items: ids.map((id) => ({ id, title: "T " + id, year: "2008", type: "series" })),
  });
}

function seedCw(db, username, showId) {
  db.q(
    `INSERT INTO continue_watching (username, show_id, item_id, name, show_title, season_num, episode_num, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    username, showId, `${showId}:1:1`, "Ep", "CW Show", 1, 1, 9050
  );
}

async function serve(env, cfgId, catalogId) {
  const res = await call(env, `/${cfgId}/catalog/series/${catalogId}.json`);
  assert.equal(res.status, 200);
  return (res.body.metas || []).map((m) => m.id);
}

describe("Remove duplicate items across lists leaves personal shelves alone", () => {
  // The shelf exists to show what you are part-way through. Losing a show
  // from it because Trending listed the same title higher up is the shelf
  // failing at its one job.
  it("does not strip a Continue Watching shelf that follows an ordinary list", async () => {
    const u = "dedupe1";
    const kv = makeKv();
    const db = makeD1();
    const env = makeEnv({ CONFIGS: kv, DB: db });
    seedCw(db, u, SHOW);
    await kv.put("cfgA", JSON.stringify({
      trackCreatorName: u,
      dedupeAcrossLists: true,
      showBadgesStremio: false,
      entries: [
        { id: "first", type: "series", name: "First", url: customUrl("first", [SHOW, OTHER]) },
        { id: "cw", type: "series", name: "Continue Watching", url: `autotrack:continue-watching:series:${u}` },
      ],
    }));
    assert.ok((await serve(env, "cfgA", "cw")).includes(SHOW),
      "the show must stay in Continue Watching even though an earlier list has it");
  });

  // And the reverse would be just as surprising: a title vanishing from
  // Trending because it is in your Watchlist.
  it("does not let a Continue Watching shelf strip a list below it", async () => {
    const u = "dedupe2";
    const kv = makeKv();
    const db = makeD1();
    const env = makeEnv({ CONFIGS: kv, DB: db });
    seedCw(db, u, SHOW);
    await kv.put("cfgB", JSON.stringify({
      trackCreatorName: u,
      dedupeAcrossLists: true,
      showBadgesStremio: false,
      entries: [
        { id: "cw", type: "series", name: "Continue Watching", url: `autotrack:continue-watching:series:${u}` },
        { id: "second", type: "series", name: "Second", url: customUrl("second", [SHOW, OTHER]) },
      ],
    }));
    const ids = await serve(env, "cfgB", "second");
    assert.ok(ids.includes(SHOW), "an ordinary list must not lose a title just because it is in Continue Watching");
    assert.ok(ids.includes(OTHER));
  });

  // The feature itself still has to work between two ordinary lists.
  it("still dedupes two ordinary lists", async () => {
    const kv = makeKv();
    const env = makeEnv({ CONFIGS: kv, DB: makeD1() });
    await kv.put("cfgC", JSON.stringify({
      dedupeAcrossLists: true,
      showBadgesStremio: false,
      entries: [
        { id: "one", type: "series", name: "One", url: customUrl("one", [SHOW, OTHER]) },
        { id: "two", type: "series", name: "Two", url: customUrl("two", [SHOW]) },
      ],
    }));
    assert.deepEqual(await serve(env, "cfgC", "two"), [],
      "an ordinary list should still lose what an earlier ordinary list already showed");
  });
});

// The Worker matches a personal shelf by catalog URL; the page has its own
// copy of the same rule. Two copies of one rule drift, so this pins them.
describe("the personal-shelf rule is the same on both sides", () => {
  function loadWorkerFn() {
    const src = readFileSync(new URL("../00_constants.js", import.meta.url), "utf8");
    const consts = src.match(/const PERSONAL_SHELF_URL_PREFIXES[\s\S]*?\];/)[0];
    const start = src.indexOf("function isPersonalShelfUrl");
    let i = src.indexOf("{", start), depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") { depth--; if (depth === 0) { i++; break; } }
    }
    return new Function(`${consts}\n${src.slice(start, i)}\nreturn isPersonalShelfUrl;`)();
  }

  // The page's copy lives inside a template literal, so one level of
  // backslash escaping is stripped before a browser ever sees it.
  function loadClientFn() {
    const src = readFileSync(new URL("../23_client-list-management.js", import.meta.url), "utf8");
    const start = src.indexOf("function isPersonalShelfUrlClient");
    let i = src.indexOf("{", start), depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") { depth--; if (depth === 0) { i++; break; } }
    }
    const body = src.slice(start, i).replace(/\\\\/g, "\\");
    return new Function(`${body}\nreturn isPersonalShelfUrlClient;`)();
  }

  const isPersonalShelfUrl = loadWorkerFn();
  const isPersonalShelfUrlClient = loadClientFn();

  const personal = [
    "autotrack:continue-watching:series:james",
    "autotrack:airing-next:series:james",
    "autotrack:watch-history:mixed:james",
    "autotrack:watchlist:movie:james",
    "trakt:watchlist", "trakt:history", "trakt:continue-watching", "trakt:airing-next", "trakt:user:bob",
    "mdblist:watchlist", "mdblist:history", "mdblist:airing-next", "mdblist:upnext", "mdblist:user:bob",
    "simkl:watchlist", "simkl:history", "simkl:airing-next", "simkl:user:bob",
  ];
  const ordinary = [
    "https://mdblist.com/lists/someone/faves",
    "tmdb:chart:trending",
    "trakt:chart:popular",
    "simkl:chart:trending",
    "custom:curated:recommended-movies",
    "channel:v1:{}",
    "",
  ];

  it("both say yes to every personal shelf", () => {
    for (const u of personal) {
      assert.equal(isPersonalShelfUrl(u), true, "worker: " + u);
      assert.equal(isPersonalShelfUrlClient(u), true, "client: " + u);
    }
  });

  it("both say no to an ordinary list", () => {
    for (const u of ordinary) {
      assert.equal(isPersonalShelfUrl(u), false, "worker: " + u);
      assert.equal(isPersonalShelfUrlClient(u), false, "client: " + u);
    }
  });

  // A merged row carrying one is still reading somebody's account.
  it("both catch a personal shelf inside a merged row", () => {
    const merged = "tmdb:chart:trending\nautotrack:continue-watching:series:james";
    assert.equal(isPersonalShelfUrl(merged), true);
    assert.equal(isPersonalShelfUrlClient(merged), true);
  });
});

// --- presets ---------------------------------------------------------------
// A preset records WHICH shelves you had, not what was on them. For a tracked
// shelf those are different things, and merging the preset's copy in was
// additive with nothing marking which items came from it -- so a preset built
// months ago put months-old shows back into Continue Watching permanently,
// and pushed that mixture up to the account on top.

const { loadClient } = await import("./client-harness.mjs");

const PRESETS_KEY = "myListAddon:presets";
const LISTS_KEY = "myListAddon:localCustomLists";

const stale = (id) => ({ id, title: "Stale " + id, type: "series" });

function clientWithPreset(localLists) {
  return loadClient({ storage: {
    [PRESETS_KEY]: JSON.stringify({
      "old setup": {
        entries: [{ id: "x", name: "X", type: "series", url: "tmdb:chart:trending" }],
        customLists: {
          "continue-watching": { slug: "continue-watching", name: "Continue Watching", type: "series", items: [stale("tt1111111")] },
          "airing-next": { slug: "airing-next", name: "Airing Next", type: "series", items: [stale("tt2222222")] },
          "watch-history": { slug: "watch-history", name: "Watch History", type: "mixed", items: [stale("tt3333333")] },
          "watchlist": { slug: "watchlist", name: "Watchlist", type: "movie", items: [stale("tt4444444")] },
          "faves": { slug: "faves", name: "Faves", type: "movie", items: [stale("tt5555555")] },
        },
      },
    }),
    [LISTS_KEY]: JSON.stringify(localLists || {}),
  } });
}

describe("loading a preset never touches a tracked shelf", () => {
  const liveCw = { slug: "continue-watching", name: "Continue Watching", type: "series", items: [{ id: "tt0903747", title: "Live", type: "series" }] };

  it("leaves an existing Continue Watching exactly as it was", () => {
    const c = clientWithPreset({ "continue-watching": liveCw });
    c.call("rebuildCustomListsFromPreset", "old setup", true);
    const after = JSON.parse(c.localStorage.getItem(LISTS_KEY))["continue-watching"];
    assert.deepEqual(after.items.map((i) => i.id), ["tt0903747"],
      "the preset's old show must not be merged into the live shelf");
  });

  // Watchlist is auto-created empty by loadLocalCustomLists regardless of any
  // preset, so what matters is not whether the shelf exists but whether the
  // preset's items ever land in one.
  it("puts none of the preset's tracked items into any tracked shelf", () => {
    const c = clientWithPreset({});
    c.call("rebuildCustomListsFromPreset", "old setup", true);
    const map = JSON.parse(c.localStorage.getItem(LISTS_KEY) || "{}");
    const presetItemIds = ["tt1111111", "tt2222222", "tt3333333", "tt4444444"];
    for (const slug of ["continue-watching", "airing-next", "watch-history", "watchlist"]) {
      const items = (map[slug] && map[slug].items) || [];
      for (const id of presetItemIds) {
        assert.ok(!items.some((it) => it.id === id), slug + " must not receive " + id + " from a preset");
      }
    }
  });

  it("still restores an ordinary custom list", () => {
    const c = clientWithPreset({});
    const res = c.call("rebuildCustomListsFromPreset", "old setup", true);
    const map = JSON.parse(c.localStorage.getItem(LISTS_KEY) || "{}");
    assert.ok(map["faves"], "an ordinary list is still the preset's to restore");
    assert.equal(res.restoredLists, 1);
    assert.deepEqual(res.skippedTrackedSlugs.sort(),
      ["airing-next", "continue-watching", "watch-history", "watchlist"]);
  });
});

describe("Rebuild button on a tracked shelf", () => {
  it("renders on each shelf that goes through the shared card renderer", () => {
    const c = loadClient();
    for (const slug of ["continue-watching", "watch-history", "watchlist"]) {
      const html = c.call("buildLocalListCardHtml", { slug, name: slug, type: "series", items: [] });
      assert.ok(html.includes("trackedShelfRebuildBtn"), slug + " should offer Rebuild");
      assert.ok(html.includes('data-slug="' + slug + '"'), slug);
    }
  });

  // Airing Next is the one tracked shelf with its OWN card renderer -- the
  // dashboard calls buildAiringNextCardHtml for it and buildLocalListCardHtml
  // for everything else. Asserting the shared renderer for all four passed
  // while the real Airing Next card had no button at all, so this exercises
  // the renderer the app actually uses.
  it("renders on Airing Next, which has its own card renderer", () => {
    const c = loadClient();
    const html = c.call("buildAiringNextCardHtml");
    assert.ok(html.includes("trackedShelfRebuildBtn"), "Airing Next should offer Rebuild");
    assert.ok(html.includes('data-slug="airing-next"'));
  });

  it("does not render on an ordinary list", () => {
    const c = loadClient();
    const html = c.call("buildLocalListCardHtml", { slug: "faves", name: "Faves", type: "movie", items: [] });
    assert.ok(!html.includes("trackedShelfRebuildBtn"), "an ordinary list has no account copy to rebuild");
  });
});

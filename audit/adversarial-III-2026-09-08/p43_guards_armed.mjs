// The optimistic-concurrency guard, on the three call sites that sent an
// explicit slug and no baseline.
//
// The server answers 409 + conflict:true when a save cites an
// expectedUpdatedAt older than the stored version, and it is deliberately
// additive: a client that omits the field keeps last-write-wins. Of twelve
// lists/save call sites exactly two armed it. The eight that create a list are
// genuinely fine unguarded -- there is no prior version to clobber. The three
// that pass a slug are whole-list replacements of an existing list, which is
// precisely the case the guard exists for.
//
// All three now go through saveCreatorListWithBaseline(). Where the edit is a
// delta (a removal, a single add/remove toggle) a conflict re-applies it to
// the copy the other device saved. Where it is a replacement built in the
// builder it cannot be, so the conflict is reported instead of one side being
// silently picked -- see p42.
import { loadClient, requestsTo } from "../../tests/client-harness.mjs";

const SAVE = "/api/creator/lists/save";
const LISTS = "/api/creator/lists";

function conflictOnce(saves) {
  let first = true;
  return (req) => {
    saves.push(req.body);
    if (first) { first = false; return { status: 409, json: { ok: false, conflict: true } }; }
    return { json: { ok: true, updatedAt: 9500 } };
  };
}

// --- 21_:1320  removeWatchedItemFromWatchlist ------------------------------
{
  const saves = [];
  const client = loadClient({
    storage: { "myListAddon:creatorKey": "K", "myListAddon:creatorName": "u" },
    routes: {
      [SAVE]: conflictOnce(saves),
      // What the other device saved while this browser held its stale copy.
      [LISTS]: () => ({ json: { ok: true, lists: [{
        slug: "watchlist", name: "Watchlist", type: "mixed", visibility: "private", updatedAt: 9000,
        items: [{ id: "tt-watched", type: "movie" }, { id: "tt-THEIRS", type: "movie" }],
      }] } }),
    },
  });
  client.set("activeCreator", { creatorName: "u" });
  client.set("lastCreatorListsData", [{
    slug: "watchlist", name: "Watchlist", type: "mixed", visibility: "private", updatedAt: 4200,
    items: [{ id: "tt-watched", type: "movie" }, { id: "tt-mine", type: "movie" }],
  }]);
  client.set("renderCreatorDashboard", () => {});
  await client.call("removeWatchedItemFromWatchlist", "tt-watched", null, null);
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  console.log("21_:1320 removeWatchedItemFromWatchlist");
  console.log(`  saves: ${saves.length}   expectedUpdatedAt: ${saves.map((s) => s.expectedUpdatedAt).join(" -> ")}   (was: fire-and-forget, no baseline)`);
  console.log(`  final items: ${JSON.stringify(saves[saves.length - 1].items.map((i) => i.id))}   <- tt-THEIRS survived the conflict\n`);
}

// --- 19_:3109  syncCustomListPayload, via toggleItemInCustomListUrl --------
{
  const saves = [];
  const client = loadClient({
    storage: { "myListAddon:creatorKey": "K", "myListAddon:creatorName": "u" },
    routes: {
      [SAVE]: conflictOnce(saves),
      [LISTS]: () => ({ json: { ok: true, lists: [{
        slug: "faves", name: "Faves", type: "movie", visibility: "private", updatedAt: 9000,
        items: [{ id: "tt-old", imdbId: "tt-old" }, { id: "tt-THEIRS", imdbId: "tt-THEIRS" }],
      }] } }),
    },
  });
  client.set("activeCreator", { creatorName: "u" });
  client.set("lastCreatorListsData", [{
    slug: "faves", name: "Faves", type: "movie", visibility: "private", updatedAt: 4200,
    items: [{ id: "tt-old", imdbId: "tt-old" }],
  }]);
  client.set("renderCreatorDashboard", () => {});
  client.window._selectListModalTempLists = [{
    name: "Faves",
    url: "customlist:v1:" + JSON.stringify({ creatorSlug: "faves", type: "movie", items: [{ id: "tt-old", imdbId: "tt-old" }] }),
  }];
  client.call("toggleItemInCustomListUrl", "tt-new", "tt-new", "movie", 0, true, "New", "");
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  console.log("19_:3109 syncCustomListPayload");
  console.log(`  saves: ${saves.length}   expectedUpdatedAt: ${saves.map((s) => s.expectedUpdatedAt).join(" -> ")}   (was: no baseline)`);
  console.log(`  final items: ${JSON.stringify(saves[saves.length - 1].items.map((i) => i.imdbId))}   <- both additions survived\n`);
}

// --- 21_:663  saveLocalCustomListEdit -------------------------------------
{
  const saves = [];
  const LOCAL = JSON.stringify({ faves: { slug: "faves", name: "Faves", type: "movie", items: [{ id: "tt0" }], createdAt: 1, updatedAt: 1 } });
  const client = loadClient({
    storage: { "myListAddon:creatorKey": "K", "myListAddon:creatorName": "u", "myListAddon:localCustomLists": LOCAL },
    routes: {
      [SAVE]: (req) => { saves.push(req.body); return { json: { ok: true, url: "https://x/l", updatedAt: 7000 } }; },
      [LISTS]: () => ({ json: { ok: true, lists: [{ slug: "faves", name: "Faves", type: "movie", visibility: "private", updatedAt: 4200, items: [{ id: "tt0" }] }] } }),
    },
  });
  client.set("activeCreator", { creatorName: "u" });
  client.set("lastCreatorListsData", [{ slug: "faves", name: "Faves", type: "movie", updatedAt: 4200 }]);
  client.set("editingLocalCustomListSlug", "faves");
  client.set("customListDraftItems", [{ id: "tt1" }]);
  client.set("customListDraftType", "movie");
  client.set("showSavedCustomListModal", () => {});
  client.set("showAppNoticeModal", () => {});
  client.set("cancelEditCustomList", () => {});
  client.set("renderCreatorDashboard", () => {});
  await client.call("saveLocalCustomListEdit", "Faves");
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  console.log("21_:663  saveLocalCustomListEdit");
  console.log(`  saves: ${requestsTo(client, SAVE).length}   expectedUpdatedAt: ${saves[0].expectedUpdatedAt}   (was: no baseline)`);
  console.log("  a replacement is not a delta, so a 409 here is reported, not merged -- see p42");
}

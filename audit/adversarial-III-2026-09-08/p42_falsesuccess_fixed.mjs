// Re-run of p33 against the fix.
//
// saveLocalCustomListEdit() discarded the account mirror's outcome entirely --
// no else, no error path, `catch (e) {}` -- and then showed the "saved" modal
// unconditionally. A 401, a 409 and a 500 all ended on the same success
// screen while nothing reached the account, so on the next sign-in the
// server's older copy won and the edit was gone.
//
// The local save is deliberately still unconditional: it is what this function
// is for, and it worked. Only the reported outcome was wrong.
import { loadClient, requestsTo } from "../../tests/client-harness.mjs";

const SAVE = "/api/creator/lists/save";
const LISTS = "/api/creator/lists";
const LOCAL = JSON.stringify({
  "my-list": { slug: "my-list", name: "My List", type: "movie", items: [{ id: "tt0" }], createdAt: 1, updatedAt: 1 },
});
const ACCOUNT = { ok: true, lists: [{ slug: "my-list", name: "My List", type: "movie", visibility: "private", updatedAt: 4200, items: [{ id: "tt0" }] }] };

for (const [label, reply] of [
  ["500 ok:false", () => ({ status: 500, json: { ok: false, error: "boom" } })],
  ["409 conflict", () => ({ status: 409, json: { ok: false, error: "conflict", conflict: true, updatedAt: 9000 } })],
  ["401 bad key",  () => ({ status: 401, json: { ok: false, error: "Username or Key is incorrect." } })],
  ["200 ok:true",  () => ({ json: { ok: true, url: "https://x/lists/u/my-list", updatedAt: 7000 } })],
]) {
  const shown = [];
  const client = loadClient({
    routes: { [SAVE]: reply, [LISTS]: () => ({ json: ACCOUNT }) },
    storage: {
      "myListAddon:creatorKey": "MYL-AAAA-BBBB-CCCC",
      "myListAddon:creatorName": "u",
      "myListAddon:localCustomLists": LOCAL,
    },
  });
  client.set("activeCreator", { creatorName: "u", creatorKey: "MYL-AAAA-BBBB-CCCC" });
  client.set("lastCreatorListsData", [{ slug: "my-list", name: "My List", type: "movie", updatedAt: 4200 }]);
  client.set("showSavedCustomListModal", (n, v, u) => shown.push(`SUCCESS modal "${n}" -> ${u}`));
  client.set("showAppNoticeModal", (t, m) => shown.push(`notice "${t}": ${String(m).slice(0, 58)}...`));
  client.set("showAddedToast", (m) => shown.push("toast " + m));
  client.set("cancelEditCustomList", () => {});
  client.set("renderCreatorDashboard", () => {});
  client.set("editingLocalCustomListSlug", "my-list");
  client.set("customListDraftItems", [{ id: "tt1", title: "x" }]);
  client.set("customListDraftType", "movie");

  try { await client.call("saveLocalCustomListEdit", "My List"); }
  catch (e) { shown.push("threw " + e.message.slice(0, 70)); }
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));

  const saves = requestsTo(client, SAVE);
  const stored = JSON.parse(client.localStorage.getItem("myListAddon:localCustomLists"))["my-list"];
  console.log(`server ${label.padEnd(13)} -> saves=${saves.length} expectedUpdatedAt=${saves[0] && saves[0].body.expectedUpdatedAt}  local items kept: ${JSON.stringify(stored.items.map((i) => i.id))}`);
  console.log(`   UI: ${JSON.stringify(shown)}`);
}

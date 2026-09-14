import { loadClient, requestsTo } from "../../tests/client-harness.mjs";

for (const [label, reply] of [
  ["500 ok:false", () => ({ status: 500, json: { ok: false, error: "boom" } })],
  ["409 conflict", () => ({ status: 409, json: { ok: false, error: "conflict", conflict: true } })],
  ["401 bad key",  () => ({ status: 401, json: { ok: false, error: "Username or Key is incorrect." } })],
]) {
  const shown = [];
  const client = loadClient({
    routes: { "/api/creator/lists/save": reply },
    storage: { "myListAddon:creatorKey": "MYL-AAAA-BBBB-CCCC" },
  });
  client.set("activeCreator", { creatorName: "u", creatorKey: "MYL-AAAA-BBBB-CCCC" });
  client.set("showSavedCustomListModal", (n, v, u) => shown.push(`modal "${n}" saved -> ${u}`));
  client.set("showAddedToast", (m) => shown.push("toast " + m));
  client.set("showAppAlert", (t, m) => shown.push("alert " + t + ": " + String(m).slice(0, 60)));
  client.set("cancelEditCustomList", () => {});
  client.set("renderCreatorDashboard", () => {});
  client.set("customListDraftItems", [{ id: "tt1", title: "x" }]);
  client.set("customListDraftType", "movie");
  client.set("editingCustomListSlug", "my-list");
  // Drive the edit-save path directly.
  try { await client.call("saveLocalCustomListEdit", "my-list", "My List", "private"); }
  catch (e) { shown.push("threw " + e.message.slice(0, 70)); }
  console.log(`server ${label.padEnd(14)} -> requests=${requestsTo(client, "/api/creator/lists/save").length}  UI: ${JSON.stringify(shown)}`);
}

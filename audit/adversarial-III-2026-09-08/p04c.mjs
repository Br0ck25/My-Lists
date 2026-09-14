// Control: with a `listName` binding in scope, the same call DOES report.
import { loadClient, requestsTo } from "../../tests/client-harness.mjs";
const client = loadClient({ routes: { "/api/track-event": () => ({ json: { ok: true } }) } });
client.set("fetchAllItemsForList", async (u, t) => t === "movie" ? [{ id: "tt0111161", title: "S", year: 1994 }] : []);
client.set("showAppAlert", () => {});
client.set("renderCreatorDashboard", () => {});
client.set("listName", "injected");        // the only difference from p04b
await client.call("copyListToCustomList", "My Test List", "https://trakt.tv/users/x/lists/y", "movie", null, false, {});
console.log("/api/track-event requests:", requestsTo(client, "/api/track-event").length);
console.log(JSON.stringify(requestsTo(client, "/api/track-event").map(r => r.body), null, 1));

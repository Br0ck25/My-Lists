// End-to-end: drive copyListToCustomList and show no /api/track-event fires.
import { loadClient, requestsTo } from "../../tests/client-harness.mjs";

const client = loadClient({
  routes: { "/api/track-event": () => ({ json: { ok: true } }) },
  storage: {},
});

// Stub the item fetch so the copy path runs with two movies.
client.set("fetchAllItemsForList", async (url, type) =>
  type === "movie" ? [{ id: "tt0111161", title: "Shawshank", year: 1994 }] : []);
// Keep the alert path quiet and observable.
const alerts = [];
client.set("showAppAlert", (t, m) => { alerts.push(t + ": " + m); });
// Dashboard render is irrelevant here.
client.set("renderCreatorDashboard", () => {});

await client.call("copyListToCustomList", "My Test List", "https://trakt.tv/users/x/lists/y", "movie", null, false, {});

console.log("alerts:", alerts);
console.log("/api/track-event requests:", requestsTo(client, "/api/track-event").length);
console.log("all requests:", client.requests.map(r => r.method + " " + r.pathname));

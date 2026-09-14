// Every creator route: unauthenticated, wrong-key, cross-account.
import { makeEnv, makeKv, makeD1, call, createUser } from "../../tests/harness.mjs";

const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
const A = await createUser(env, "alicetester");
const B = await createUser(env, "bobtester");

// Alice owns one list.
await call(env, "/api/creator/lists/save", { method: "POST", json: {
  creatorName: A.creatorName, creatorKey: A.creatorKey,
  name: "Alice Private", type: "movie", visibility: "private",
  items: [{ id: "tt1", title: "Secret" }],
}});
await call(env, "/api/creator/sync/save", { method: "POST", json: {
  creatorName: A.creatorName, creatorKey: A.creatorKey, entries: [{ name: "s" }], keys: { tmdbKey: "ALICE-TMDB-KEY" },
}});
await call(env, "/api/creator/sync/save-tracking", { method: "POST", json: {
  creatorName: A.creatorName, creatorKey: A.creatorKey,
  watchHistory: [{ id: "tt1", title: "Secret Watch" }],
}});

const routes = [
  ["/api/creator/track-status", {}],
  ["/api/creator/scrobble-seen-users", {}],
  ["/api/creator/scrobble-token", {}],
  ["/api/creator/restore", {}],
  ["/api/creator/lists", {}],
  ["/api/creator/lists/save", { name: "X", type: "movie", items: [] }],
  ["/api/creator/lists/delete", { slug: "alice-private" }],
  ["/api/creator/lists/reorder", { order: ["alice-private"] }],
  ["/api/creator/account/reset", { confirm: "RESET" }],
  ["/api/creator/delete-account", { confirm: "DELETE" }],
  ["/api/creator/sync/save", { entries: [] }],
  ["/api/creator/sync/save-tracking", { watchHistory: [] }],
  ["/api/creator/sync/save-presets", { presets: [] }],
  ["/api/creator/sync/save-channels", { channels: [] }],
  ["/api/creator/sync/meta", {}],
  ["/api/creator/sync/load", {}],
  ["/api/creator/sync/like", { listId: "x", liked: true }],
  ["/api/creator/sync/share-tracking", { slug: "watch-history", shared: true }],
  ["/api/creator/reset-key", {}],
];

const rows = [];
for (const [p, extra] of routes) {
  const none = await call(env, p, { method: "POST", json: { ...extra } });
  const wrong = await call(env, p, { method: "POST", json: { creatorName: A.creatorName, creatorKey: "MYL-XXXX-XXXX-XXXX", ...extra } });
  const cross = await call(env, p, { method: "POST", json: { creatorName: A.creatorName, creatorKey: B.creatorKey, ...extra } });
  rows.push([p, none.status, wrong.status, cross.status,
    JSON.stringify(cross.body).slice(0, 70)]);
}
console.log("route".padEnd(40), "noAuth wrongKey crossKey  crossBody");
for (const r of rows) console.log(r[0].padEnd(40), String(r[1]).padEnd(6), String(r[2]).padEnd(8), String(r[3]).padEnd(8), r[4]);

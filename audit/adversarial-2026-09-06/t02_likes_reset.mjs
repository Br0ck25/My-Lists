import { makeKv, makeRealD1, makeEnv, call, createUser } from "./kit.mjs";

// Scenario: D1 is bound. An account that predates D1 (or whose row was never
// migrated) has a list with real likes in KV. What happens to the count?
const DB = makeRealD1();
const env = makeEnv({ CONFIGS: makeKv(), DB });
const u = await createUser(env, "dana");

// Simulate "account exists in KV but not in D1" -- exactly the lazy-migration
// state getCreator/getCreatorList are written to tolerate.
DB.q("DELETE FROM creators");
// Create the list purely in KV, the way a pre-D1 deployment would have.
env.CONFIGS._store.set("creatorlist:dana:top-ten", JSON.stringify({
  name: "Top Ten", slug: "top-ten", type: "movie", items: [{ id: "tt1" }],
  visibility: "public", likes: 5, createdAt: 1, updatedAt: 2,
}));
env.CONFIGS._store.set("creatorlistorder:dana", JSON.stringify({ order: ["top-ten"] }));
env.CONFIGS._store.set("listlikevoters:dana:top-ten", JSON.stringify({ voters: ["v1","v2","v3","v4","v5"] }));

const show = async (label) => {
  const r = await call(env, "/api/creator/lists", { method: "POST", json: { creatorName: "dana", creatorKey: u.creatorKey } });
  const kv = JSON.parse(env.CONFIGS._store.get("creatorlist:dana:top-ten"));
  const d1 = DB.q("SELECT id, likes FROM creator_lists");
  console.log(`${label}\n  dashboard likes: ${r.body.lists && r.body.lists[0] && r.body.lists[0].likes}   KV likes: ${kv.likes}   D1: ${JSON.stringify(d1)}`);
};
await show("BEFORE (KV-only record, D1 has no row)");

// The owner renames the list -- an ordinary edit, nothing to do with likes.
const s1 = await call(env, "/api/creator/lists/save", { method: "POST", json: {
  creatorName: "dana", creatorKey: u.creatorKey, slug: "top-ten",
  name: "Top Ten (2026)", type: "movie", visibility: "public", items: [{ id: "tt1" }],
}});
console.log("save #1:", s1.status, s1.body);
await show("AFTER edit #1 (D1 row now exists, created by the save)");

// A second, equally ordinary edit.
const s2 = await call(env, "/api/creator/lists/save", { method: "POST", json: {
  creatorName: "dana", creatorKey: u.creatorKey, slug: "top-ten",
  name: "Top Ten (final)", type: "movie", visibility: "public", items: [{ id: "tt1" }, { id: "tt2" }],
}});
console.log("save #2:", s2.status, s2.body);
await show("AFTER edit #2");
console.log("\nlike ledger still holds:", env.CONFIGS._store.get("listlikevoters:dana:top-ten"));
const pub = await call(env, "/lists/public.json");
console.log("directory says likes =", (pub.body.lists||[]).map(l=>l.likes));

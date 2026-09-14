import { makeKv, makeRealD1, makeEnv, call, createUser } from "./kit.mjs";

// D1 bound, creator row PRESENT in D1 (migrated), but this particular list's
// row is not in D1 yet -- e.g. it predates the list-mirroring code, or
// migrate-d1 stopped before reaching it, or its row was removed.
const DB = makeRealD1();
const env = makeEnv({ CONFIGS: makeKv(), DB });
const u = await createUser(env, "dana");
console.log("D1 creators:", DB.q("SELECT username FROM creators"));

env.CONFIGS._store.set("creatorlist:dana:top-ten", JSON.stringify({
  name: "Top Ten", slug: "top-ten", type: "movie", items: [{ id: "tt1" }],
  visibility: "public", likes: 5, createdAt: 1, updatedAt: 2,
}));
env.CONFIGS._store.set("creatorlistorder:dana", JSON.stringify({ order: ["top-ten"] }));
env.CONFIGS._store.set("listlikevoters:dana:top-ten", JSON.stringify({ voters: ["v1","v2","v3","v4","v5"] }));

const show = async (label) => {
  const r = await call(env, "/api/creator/lists", { method: "POST", json: { creatorName: "dana", creatorKey: u.creatorKey } });
  const kv = JSON.parse(env.CONFIGS._store.get("creatorlist:dana:top-ten"));
  console.log(`${label}\n  dashboard: ${r.body.lists[0].likes}   KV: ${kv.likes}   D1: ${JSON.stringify(DB.q("SELECT id,likes FROM creator_lists"))}`);
};
await show("BEFORE");
for (let i = 1; i <= 2; i++) {
  await call(env, "/api/creator/lists/save", { method: "POST", json: {
    creatorName: "dana", creatorKey: u.creatorKey, slug: "top-ten",
    name: "Top Ten v" + i, type: "movie", visibility: "public", items: [{ id: "tt1" }],
  }});
  await show("AFTER ordinary edit #" + i);
}
const pub = await call(env, "/lists/public.json");
console.log("directory likes:", (pub.body.lists||[]).map(l => `${l.slug}=${l.likes}`));
console.log("ledger untouched:", env.CONFIGS._store.get("listlikevoters:dana:top-ten"));

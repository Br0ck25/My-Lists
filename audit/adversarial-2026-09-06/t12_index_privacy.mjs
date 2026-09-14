// PHASE 23/15/14 -- the public directory's removal of an unpublished list is
// a fire-and-forget ctx.waitUntil whose failure is swallowed.
import { makeKv, makeRealD1, makeEnv, call, createUser, adminCookie } from "./kit.mjs";
const env = makeEnv({ CONFIGS: makeKv() });
const A = await createUser(env, "alice");
await call(env, "/api/creator/lists/save", { method: "POST", json: { creatorName: "alice", creatorKey: A.creatorKey, name: "Family Photos", type: "movie", visibility: "public", items: [{ id: "tt1" }, { id: "tt2" }] } });
// seed the index (a real deployment has one; the cron/rebuild creates it)
const cookie = await adminCookie(env);
await call(env, "/admin/api/rebuild-public-index", { method: "POST", cookie });
console.log("directory before:", JSON.stringify((await call(env, "/lists/public.json")).body.lists));

// The owner unpublishes. The index write happens in waitUntil and fails.
env.CONFIGS._hooks.beforePut = async (key) => { if (key === "index:publiclists") throw new Error("KV put failed"); };
const r = await call(env, "/api/creator/lists/save", { method: "POST", json: { creatorName: "alice", creatorKey: A.creatorKey, slug: "family-photos", name: "Family Photos", type: "movie", visibility: "private", items: [{ id: "tt1" }, { id: "tt2" }] } });
env.CONFIGS._hooks.beforePut = null;
console.log("unpublish response:", r.status, r.body);
console.log("record visibility in KV:", JSON.parse(env.CONFIGS._store.get("creatorlist:alice:family-photos")).visibility);
console.log("the list page itself:", (await call(env, "/lists/alice/family-photos.json")).status);
console.log("directory AFTER unpublishing:", JSON.stringify((await call(env, "/lists/public.json")).body.lists));
console.log("search AFTER unpublishing:", JSON.stringify((await call(env, "/api/search-published-lists?q=family")).body));

// PHASE 12 -- two concurrent index updates
console.log("\n=== concurrent index updates (read-modify-write on one key) ===");
const env2 = makeEnv({ CONFIGS: makeKv() });
const B = await createUser(env2, "bobby");
await call(env2, "/api/creator/lists/save", { method: "POST", json: { creatorName: "bobby", creatorKey: B.creatorKey, name: "Keeper", type: "movie", visibility: "public", items: [{ id: "x" }] } });
const ck2 = await adminCookie(env2);
await call(env2, "/admin/api/rebuild-public-index", { method: "POST", ck2 });
await call(env2, "/admin/api/rebuild-public-index", { method: "POST", cookie: ck2 });
const before = (await call(env2, "/lists/public.json")).body.lists.map(l => l.slug);
console.log("index holds:", before);
await Promise.all([
  call(env2, "/api/creator/lists/save", { method: "POST", json: { creatorName: "bobby", creatorKey: B.creatorKey, name: "Alpha", type: "movie", visibility: "public", items: [{ id: "a" }] } }),
  call(env2, "/api/creator/lists/save", { method: "POST", json: { creatorName: "bobby", creatorKey: B.creatorKey, name: "Beta", type: "movie", visibility: "public", items: [{ id: "b" }] } }),
  call(env2, "/api/creator/lists/save", { method: "POST", json: { creatorName: "bobby", creatorKey: B.creatorKey, name: "Gamma", type: "movie", visibility: "public", items: [{ id: "g" }] } }),
]);
console.log("after 3 concurrent publishes, directory holds:", (await call(env2, "/lists/public.json")).body.lists.map(l => l.slug));
console.log("KV really holds:", [...env2.CONFIGS._store.keys()].filter(k => k.startsWith("creatorlist:bobby:")));
console.log("order key:", env2.CONFIGS._store.get("creatorlistorder:bobby"));

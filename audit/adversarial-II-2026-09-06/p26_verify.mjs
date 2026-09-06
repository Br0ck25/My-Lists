// Precision checks for claims going into the report.
import { makeKv, makeD1, makeEnv, call, createUser } from "../../tests/harness.mjs";
const kv = makeKv(), db = makeD1(), env = makeEnv({ CONFIGS: kv, DB: db });
const u = await createUser(env, "verify1");
const K = { creatorName: "verify1", creatorKey: u.creatorKey };

// 1. Does /api/creator/sync/load really return the user's provider API keys, under max-age=3600?
await call(env, "/api/creator/sync/save", { method: "POST", json: { ...K, config: [{ a: 1 }], keys: { tmdbKey: "TMDB-SECRET-123", traktToken: "TRAKT-SECRET-456" } } });
const load = await call(env, "/api/creator/sync/load", { method: "POST", json: K });
console.log("1) sync/load Cache-Control:", load.headers.get("cache-control"));
console.log("   returns provider keys  :", JSON.stringify(load.body.data.keys));

// 2. Does an anonymous like on a PRIVATE list also update the D1 mirror?
await call(env, "/api/creator/lists/save", { method: "POST", json: { ...K, name: "Secret", type: "movie", visibility: "private", items: [] } });
const before = db._lists.get("verify1:secret");
const like = await call(env, "/api/lists/like", { method: "POST", ip: "203.0.113.44", json: { username: "verify1", slug: "secret" } });
const after = db._lists.get("verify1:secret");
console.log("\n2) anonymous like on a PRIVATE list ->", like.status, JSON.stringify(like.body));
console.log("   KV likes:", JSON.parse(kv._store.get("creatorlist:verify1:secret")).likes,
  " D1 likes:", before.likes, "->", after.likes);
console.log("   ledger key created:", kv._store.has("listlikevoters:verify1:secret"));
// and the vote survives into the directory when it is later published
await call(env, "/api/creator/lists/save", { method: "POST", json: { ...K, slug: "secret", name: "Secret", type: "movie", visibility: "public", items: [] } });
const dir = await call(env, "/lists/public.json");
console.log("   after publishing, directory shows likes:",
  (dir.body.lists || []).filter(l => l.slug === "secret").map(l => l.likes));

// 3. /api/creator/lists/delete: what does it report when the KV delete fails?
const kv2 = makeKv(), env2 = makeEnv({ CONFIGS: kv2, DB: makeD1() });
const v = await createUser(env2, "verify2");
await call(env2, "/api/creator/lists/save", { method: "POST", json: { creatorName: "verify2", creatorKey: v.creatorKey, name: "Live", type: "movie", visibility: "public", items: [{ id: "x" }] } });
kv2._hooks.beforeDelete = async k => { if (k.startsWith("creatorlist:")) throw new Error("KV unavailable"); };
const del = await call(env2, "/api/creator/lists/delete", { method: "POST", json: { creatorName: "verify2", creatorKey: v.creatorKey, slug: "live" } });
kv2._hooks.beforeDelete = null;
const page = await call(env2, "/lists/verify2/live.json");
console.log("\n3) lists/delete with a failing KV delete ->", del.status, JSON.stringify(del.body));
console.log("   record still in KV:", kv2._store.has("creatorlist:verify2:live"));
console.log("   public page still serves it:", page.status, JSON.stringify(page.body).slice(0, 90));
console.log("   D1 row deleted (stores now disagree):", !makeD1 || !env2.DB._lists.has("verify2:live"));

// 4. Can an anonymously published list be deleted by anything?
const kv3 = makeKv(), env3 = makeEnv({ CONFIGS: kv3 });
await call(env3, "/api/publish-list", { method: "POST", json: { name: "Anon List", type: "movie", items: [{ id: "a" }], visibility: "public" } });
const login = await call(env3, "/admin/login", { method: "POST", form: { key: "test-admin-secret" } });
const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
const tryDel = await call(env3, "/admin/api/delete-creator-list", { method: "POST", cookie, json: { username: "user", slug: "anon-list" } });
console.log("\n4) admin delete of an anonymous published list ->", tryDel.status, JSON.stringify(tryDel.body));
console.log("   publishedlist key still present:", kv3._store.has("publishedlist:user:anon-list"));

// After deletion, can a straggling write leave the deleted account's list
// PUBLICLY readable and advertised, with no owner able to remove it?
import { makeKv, makeD1, makeEnv, call, createUser } from "../../tests/harness.mjs";

const kv = makeKv(), db = makeD1(), env = makeEnv({ CONFIGS: kv, DB: db });
const name = "ghostpub";
const u = await createUser(env, name);
const K = { creatorName: name, creatorKey: u.creatorKey };

// Hold one public list save open across the deletion (a slow KV write --
// exactly what a real KV put under load looks like).
let release; const gate = new Promise(r => (release = r));
let armed = true;
kv._hooks.beforePut = async (k) => {
  if (armed && k === `creatorlist:${name}:secret-favourites`) { armed = false; await gate; }
};
const inflight = call(env, "/api/creator/lists/save", { method: "POST", json: {
  ...K, name: "Secret Favourites", slug: "secret-favourites", type: "movie",
  visibility: "public", items: [{ id: "tt0111161", title: "Private Pick" }] } });
await new Promise(r => setTimeout(r, 40));
const del = await call(env, "/api/creator/delete-account", { method: "POST", json: { ...K, confirm: "DELETE" } });
release(); const saved = await inflight; kv._hooks.beforePut = null;

console.log("delete-account  ->", del.status, JSON.stringify(del.body));
console.log("in-flight save  ->", saved.status, JSON.stringify(saved.body).slice(0, 90));
console.log("account record gone:", !kv._store.has(`creator:${name}`));
console.log("stray keys:", [...kv._store.keys()].filter(k => k.includes(name) && !k.startsWith("ratelimit:")));

const pub = await call(env, `/lists/${name}/secret-favourites.json`);
console.log("\nGET /lists/ghostpub/secret-favourites.json ->", pub.status, JSON.stringify(pub.body).slice(0, 140));
const dir = await call(env, "/lists/public.json");
console.log("public directory ->", JSON.stringify(dir.body).slice(0, 260));
const search = await call(env, "/api/search-published-lists?q=secret");
console.log("search           ->", JSON.stringify(search.body).slice(0, 220));
console.log("\nOwner can no longer authenticate to delete it:",
  (await call(env, "/api/creator/lists/delete", { method: "POST", json: { ...K, slug: "secret-favourites" } })).status);

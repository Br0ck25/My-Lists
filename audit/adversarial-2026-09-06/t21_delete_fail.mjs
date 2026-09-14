// PHASE 29 -- "returns ok:true after an internal failure" on the two paths
// where the consequence is authentication, not cosmetics.
import { makeKv, makeRealD1, makeEnv, call, createUser } from "./kit.mjs";

console.log("=== A. delete-account while the D1 identity DELETE fails ===");
{
  const DB = makeRealD1();
  const env = makeEnv({ CONFIGS: makeKv(), DB });
  const u = await createUser(env, "alice");
  const K = { creatorName: "alice", creatorKey: u.creatorKey, confirm: "DELETE" };
  DB.failWhen((sql) => /DELETE FROM creators/i.test(sql));
  const del = await call(env, "/api/creator/delete-account", { method: "POST", json: K });
  DB.failWhen(null);
  console.log("  delete-account ->", del.status, JSON.stringify(del.body));
  console.log("  KV identity gone:", !env.CONFIGS._store.get("creator:alice"));
  console.log("  D1 row left behind:", JSON.stringify(DB.q("SELECT username FROM creators")));
  const restore = await call(env, "/api/creator/restore", { method: "POST", json: { creatorName: "alice", creatorKey: u.creatorKey } });
  console.log("  the DELETED account's key still authenticates:", restore.status, JSON.stringify(restore.body));
  const lists = await call(env, "/api/creator/lists/save", { method: "POST", json: { creatorName: "alice", creatorKey: u.creatorKey, name: "Back", type: "movie", visibility: "public", items: [] } });
  console.log("  and can still write:", lists.status, JSON.stringify(lists.body));
}

console.log("");
console.log("=== B. the username is then reclaimed by someone else ===");
{
  const DB = makeRealD1();
  const env = makeEnv({ CONFIGS: makeKv(), DB });
  const victim = await createUser(env, "alice");
  DB.failWhen((sql) => /DELETE FROM creators/i.test(sql));
  await call(env, "/api/creator/delete-account", { method: "POST", json: { creatorName: "alice", creatorKey: victim.creatorKey, confirm: "DELETE" } });
  DB.failWhen(null);
  // a different person now registers the freed username
  const newOwner = await call(env, "/api/creator/create", { method: "POST", json: { creatorName: "alice", displayName: "Alice Two" } });
  console.log("  registration ->", newOwner.status, JSON.stringify(newOwner.body).slice(0, 120));
  console.log("  D1 creators:", JSON.stringify(DB.q("SELECT username, display_name FROM creators")));
  const asNew = await call(env, "/api/creator/restore", { method: "POST", json: { creatorName: "alice", creatorKey: newOwner.body.creatorKey } });
  console.log("  NEW owner's key works:", asNew.status, asNew.body.ok === true);
  const asOld = await call(env, "/api/creator/restore", { method: "POST", json: { creatorName: "alice", creatorKey: victim.creatorKey } });
  console.log("  PREVIOUS owner's key works:", asOld.status, asOld.body.ok === true);
  if (asOld.body.ok) {
    const w = await call(env, "/api/creator/sync/load", { method: "POST", json: { creatorName: "alice", creatorKey: victim.creatorKey } });
    console.log("  ...and can read the new owner's account:", w.status, JSON.stringify(w.body).slice(0, 140));
  }
}

console.log("");
console.log("=== C. account purge when the KV list() enumeration fails ===");
{
  const env = makeEnv({ CONFIGS: makeKv() });
  const u = await createUser(env, "alice");
  const K = { creatorName: "alice", creatorKey: u.creatorKey };
  await call(env, "/api/creator/lists/save", { method: "POST", json: { ...K, name: "Kept", type: "movie", visibility: "public", items: [{ id: "tt1" }] } });
  env.CONFIGS._hooks.beforeList = async (prefix) => { if (String(prefix).startsWith("creatorlist:alice:")) throw new Error("KV list failed"); };
  const del = await call(env, "/api/creator/delete-account", { method: "POST", json: { ...K, confirm: "DELETE" } });
  env.CONFIGS._hooks.beforeList = null;
  console.log("  delete-account ->", del.status, JSON.stringify(del.body));
  console.log("  lists left in KV:", [...env.CONFIGS._store.keys()].filter(k => k.startsWith("creatorlist:alice:")));
  console.log("  still in the public directory:", JSON.stringify((await call(env, "/lists/public.json")).body.lists.map(l => l.slug)));
  console.log("  still publicly readable:", (await call(env, "/lists/alice/kept.json")).status);
  console.log("  ...and the username is now free to reclaim, with those lists attached.");
}

console.log("");
console.log("=== D. no global exception boundary ===");
{
  const env = makeEnv({ CONFIGS: makeKv() });
  const u = await createUser(env, "alice");
  env.CONFIGS._hooks.beforePut = async (k) => { if (k.startsWith("creatorlist:")) throw new Error("KV 429 rate limited"); };
  try {
    const r = await call(env, "/api/creator/lists/save", { method: "POST", json: { creatorName: "alice", creatorKey: u.creatorKey, name: "X", type: "movie", visibility: "public", items: [] } });
    console.log("  lists/save ->", r.status, JSON.stringify(r.body));
  } catch (e) {
    console.log("  lists/save: the exception escaped worker.fetch entirely ->", e.message);
    console.log("  (Cloudflare answers that with its own 1101 error page: no JSON, no CORS, no security headers)");
  }
  try {
    const r = await call(env, "/api/creator/sync/save", { method: "POST", json: { creatorName: "alice", creatorKey: u.creatorKey, config: [] } });
    console.log("  sync/save (same failure, but wrapped) ->", r.status, JSON.stringify(r.body));
  } catch (e) { console.log("  sync/save also escaped:", e.message); }
  env.CONFIGS._hooks.beforePut = null;
}

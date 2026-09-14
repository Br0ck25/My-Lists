import { makeKv, makeRealD1, makeEnv, call, createUser } from "./kit.mjs";

const DB = makeRealD1();
const env = makeEnv({ CONFIGS: makeKv(), DB });

const u = await createUser(env, "alice");
await call(env, "/api/creator/lists/save", { method: "POST", json: {
  creatorName: "alice", creatorKey: u.creatorKey, name: "Best Of", type: "movie",
  visibility: "public", items: [{ id: "tt1" }],
}});
// 4 genuine likes from 4 different visitors
for (let i = 0; i < 4; i++) {
  await call(env, "/api/lists/like", { method: "POST", ip: `203.0.113.${i + 1}`, json: { username: "alice", slug: "best-of" } });
}
const report = async (label) => {
  const dash = await call(env, "/api/creator/lists", { method: "POST", json: { creatorName: "alice", creatorKey: u.creatorKey } });
  const dir = await call(env, "/lists/public.json");
  const kv = JSON.parse(env.CONFIGS._store.get("creatorlist:alice:best-of"));
  console.log(`${label}\n   dashboard=${dash.body.lists[0].likes}  directory=${(dir.body.lists||[]).map(l=>l.likes)}  KV=${kv.likes}  D1=${JSON.stringify(DB.q("SELECT likes FROM creator_lists WHERE id='alice:best-of'"))}`);
};
await report("1. four real likes");

// ---- unauthenticated actor: register `_____` (5 chars, matches "alice") and reset it
const atk = await createUser(env, "_____");
await call(env, "/api/creator/account/reset", { method: "POST", json: { creatorName: "_____", creatorKey: atk.creatorKey, confirm: "RESET" } });
await report("2. after a stranger reset their own `_____` account");

// ---- alice, knowing nothing about any of this, edits her list
await call(env, "/api/creator/lists/save", { method: "POST", json: {
  creatorName: "alice", creatorKey: u.creatorKey, slug: "best-of", name: "Best Of 2026",
  type: "movie", visibility: "public", items: [{ id: "tt1" }, { id: "tt2" }],
}});
await report("3. after alice renames her list");
await call(env, "/api/creator/lists/save", { method: "POST", json: {
  creatorName: "alice", creatorKey: u.creatorKey, slug: "best-of", name: "Best Of 2026",
  type: "movie", visibility: "public", items: [{ id: "tt1" }],
}});
await report("4. after one more edit -- KV, the authoritative store, is now wrong too");
console.log("\nlike ledger (the real record) still has:", JSON.parse(env.CONFIGS._store.get("listlikevoters:alice:best-of")).voters.length, "voters");

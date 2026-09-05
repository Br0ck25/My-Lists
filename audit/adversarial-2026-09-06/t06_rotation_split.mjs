import { makeKv, makeRealD1, makeEnv, call, createUser, adminCookie } from "./kit.mjs";

const DB = makeRealD1();
const env = makeEnv({ CONFIGS: makeKv(), DB });
const u = await createUser(env, "alice", { recoveryAnswer: "purple-mountain" });
console.log("D1 row present:", DB.q("SELECT username, key_hash FROM creators").map(r => r.username));

const auth = async (key, label) => {
  const r = await call(env, "/api/creator/restore", { method: "POST", json: { creatorName: "alice", creatorKey: key } });
  console.log(`   ${label}: ${r.status} ${r.body.ok ? "AUTHENTICATES" : "rejected"}`);
  return !!r.body.ok;
};

// --- The rotation happens while D1 is having a bad minute -------------------
DB.failWhen((sql) => /UPDATE creators SET key_hash/i.test(sql));
const rot = await call(env, "/api/creator/reset-key", { method: "POST", json: { username: "alice", recoveryAnswer: "purple-mountain" } });
console.log("reset-key response:", rot.status, { ok: rot.body.ok, gotNewKey: !!rot.body.creatorKey });
DB.failWhen(null);   // D1 is healthy again

console.log("\nAfter a rotation the caller was told succeeded:");
await auth(u.creatorKey, "the OLD key (must be dead)");
await auth(rot.body.creatorKey, "the NEW key (must work)");

console.log("\nKV hash:", JSON.parse(env.CONFIGS._store.get("creator:alice")).keyHash.slice(0, 24), "...");
console.log("D1 hash:", DB.q("SELECT key_hash FROM creators")[0].key_hash.slice(0, 24), "...");

// --- Can the documented repair tool fix it? --------------------------------
const cookie = await adminCookie(env);
let done = false, guard = 0;
while (!done && guard++ < 20) {
  const m = await call(env, "/admin/api/migrate-d1", { method: "POST", cookie });
  done = m.body.done;
  if (guard === 1) console.log("\nmigrate-d1 first call:", JSON.stringify(m.body.results), "done=", m.body.done);
}
console.log("migrate-d1 finished after", guard, "calls");
console.log("D1 hash after migrate-d1:", DB.q("SELECT key_hash FROM creators")[0].key_hash.slice(0, 24), "...");
console.log("\nAfter running the documented KV->D1 repair:");
await auth(u.creatorKey, "the OLD key");
await auth(rot.body.creatorKey, "the NEW key");

// --- and an admin reset? ---------------------------------------------------
const ar = await call(env, "/admin/api/reset-creator-key", { method: "POST", cookie, json: { username: "alice" } });
console.log("\nadmin reset-creator-key:", ar.status, { ok: ar.body.ok });
await auth(ar.body.creatorKey, "the key the admin was just handed");
await auth(u.creatorKey, "the original leaked key");

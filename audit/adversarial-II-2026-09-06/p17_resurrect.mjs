// N4 (Phase 5/13/33): a write in flight during account deletion must not
// hand the previous owner's data to whoever reclaims the username.
//
// The fix has three parts and this exercises all of them:
//   1. a tombstone written BEFORE the sweep, so a request that starts from
//      then on cannot authenticate at all;
//   2. a second sweep after the identity is removed, catching anything that
//      landed during the first one;
//   3. a purge on account creation, so a new account starts empty by
//      construction however a stray key got there.
import { makeKv, makeD1, makeEnv, call, createUser } from "../../tests/harness.mjs";
const R = []; const rec = (n, ok, d) => { R.push({ n, ok }); console.log(ok ? "PASS" : "FAIL", "-", n, d ? "\n    " + d : ""); };

// ---- A. a request that authenticates DURING the purge is refused ----
{
  const kv = makeKv(), db = makeD1(), env = makeEnv({ CONFIGS: kv, DB: db });
  const u = await createUser(env, "ghosta");
  const K = { creatorName: "ghosta", creatorKey: u.creatorKey };
  // Stall the purge midway, then try to authenticate while it runs.
  let release; const gate = new Promise(r => release = r);
  let armed = true;
  kv._hooks.beforeDelete = async (k) => { if (armed && k === "creatorsync:ghosta") { armed = false; await gate; } };
  const del = call(env, "/api/creator/delete-account", { method: "POST", json: { ...K, confirm: "DELETE" } });
  // Wait for the purge to actually begin. delete-account runs a full PBKDF2
  // verification first, so a fixed sleep would race it and prove nothing --
  // the tombstone appearing is the signal that the sweep has started.
  for (let i = 0; i < 200 && !kv._store.has("creatordeleted:ghosta"); i++) await new Promise(r => setTimeout(r, 5));
  const midPurge = await call(env, "/api/creator/sync/save", { method: "POST", json: { ...K, config: [{ midPurge: true }] } });
  release(); await del;
  kv._hooks.beforeDelete = null;
  rec("a write that authenticates mid-purge is refused",
    midPurge.status === 401,
    `sync/save during the purge -> ${midPurge.status} ${JSON.stringify(midPurge.body)}`);
}

// ---- B. the worst case: a write held open across the whole deletion ----
{
  const kv = makeKv(), db = makeD1(), env = makeEnv({ CONFIGS: kv, DB: db });
  const u = await createUser(env, "ghostb");
  const K = { creatorName: "ghostb", creatorKey: u.creatorKey };
  await call(env, "/api/creator/sync/save", { method: "POST", json: { ...K, config: [{ original: true }], keys: { tmdbKey: "VICTIM-TMDB-KEY" } } });

  let release; const gate = new Promise(r => release = r);
  kv._hooks.beforePut = async (k) => { if (k === "creatorsync:ghostb") { kv._hooks.beforePut = null; await gate; } };
  const inflight = call(env, "/api/creator/sync/save", { method: "POST", json: { ...K, config: [{ inflight: true }], keys: { tmdbKey: "VICTIM-TMDB-KEY" } } });
  await new Promise(r => setTimeout(r, 20));
  const del = await call(env, "/api/creator/delete-account", { method: "POST", json: { ...K, confirm: "DELETE" } });
  release();
  await inflight;

  rec("delete-account reported success", del.body.ok === true, JSON.stringify(del.body));
  rec("the username is held while a straggler could still be writing",
    kv._store.has("creatordeleted:ghostb"), "");
  const reclaim = await call(env, "/api/creator/create", { method: "POST", json: { creatorName: "ghostb" } });
  rec("the username cannot be reclaimed while it is held",
    reclaim.body.ok !== true, JSON.stringify(reclaim.body));

  // Once the hold lapses, creation must still not hand over anything the
  // straggler left behind -- that is what the purge-on-create is for.
  kv._store.delete("creatordeleted:ghostb");
  const b = await call(env, "/api/creator/create", { method: "POST", json: { creatorName: "ghostb" } });
  const load = await call(env, "/api/creator/sync/load", { method: "POST", json: { creatorName: "ghostb", creatorKey: b.body.creatorKey } });
  const inherited = JSON.stringify(load.body.data.config) !== "[]" || Object.keys(load.body.data.keys || {}).length > 0;
  rec("a reclaimed username inherits nothing a straggler left behind",
    !inherited,
    `new owner's config = ${JSON.stringify(load.body.data.config)}, keys = ${JSON.stringify(load.body.data.keys)}`);
  const leftovers = [...kv._store.keys()].filter(k => k.includes("ghostb") && !k.startsWith("creator:") && !k.startsWith("creatorlastseen:"));
  rec("no orphaned account keys survive the reclaim", leftovers.length === 0, JSON.stringify(leftovers));
}

// ---- C. a failed delete must NOT hold the username hostage ----
{
  const kv = makeKv(), db = makeD1(), env = makeEnv({ CONFIGS: kv, DB: db });
  const u = await createUser(env, "ghostc");
  const K = { creatorName: "ghostc", creatorKey: u.creatorKey };
  db.failWhen(s => /DELETE FROM creators/i.test(s));
  const del = await call(env, "/api/creator/delete-account", { method: "POST", json: { ...K, confirm: "DELETE" } });
  db.failWhen(null);
  rec("a failed delete reports failure", del.body.ok !== true, JSON.stringify(del.body));
  rec("a failed delete leaves the account usable, not tombstoned",
    !kv._store.has("creatordeleted:ghostc") &&
    (await call(env, "/api/creator/restore", { method: "POST", json: K })).body.ok === true,
    `tombstoned=${kv._store.has("creatordeleted:ghostc")}`);
}

console.log("\n" + R.filter(x => !x.ok).length + " FAILURES of " + R.length);

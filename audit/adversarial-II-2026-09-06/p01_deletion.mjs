// Phase 33 + 13: account deletion proof, username reclaim, inheritance.
import { makeKv, makeD1, makeEnv, call, createUser, nextIp } from "../../tests/harness.mjs";
import assert from "node:assert";

const results = [];
function rec(name, ok, detail) { results.push({ name, ok, detail }); console.log(ok ? "PASS" : "FAIL", "-", name, detail ? "\n    " + detail : ""); }

async function populate(env, u, key) {
  await call(env, "/api/creator/lists/save", { method: "POST", json: { creatorName: u, creatorKey: key, name: "Pub List", type: "movie", visibility: "public", items: [{ id: "tt1" }] } });
  await call(env, "/api/creator/lists/save", { method: "POST", json: { creatorName: u, creatorKey: key, name: "Priv List", type: "movie", visibility: "private", items: [{ id: "tt2" }] } });
  await call(env, "/api/creator/sync/save", { method: "POST", json: { creatorName: u, creatorKey: key, config: [{ a: 1 }] } });
  await call(env, "/api/creator/sync/save-tracking", { method: "POST", json: { creatorName: u, creatorKey: key, watchHistory: [{ id: "tt9" }] } });
  await call(env, "/api/creator/sync/save-presets", { method: "POST", json: { creatorName: u, creatorKey: key, presets: { p1: { name: "p1" } } } });
  await call(env, "/api/creator/sync/save-channels", { method: "POST", json: { creatorName: u, creatorKey: key, channels: { c1: {} } } });
  await call(env, "/api/creator/scrobble-token", { method: "POST", json: { creatorName: u, creatorKey: key } });
  await call(env, "/api/creator/sync/share-tracking", { method: "POST", json: { creatorName: u, creatorKey: key, slug: "watch-history", shared: true } });
  await call(env, "/api/lists/like", { method: "POST", json: { username: u, slug: "pub-list", liked: true } });
}

// ---------- 1. delete-account leaves nothing ----------
{
  const kv = makeKv();
  const db = makeD1();
  const env = makeEnv({ CONFIGS: kv, DB: db });
  const a = await createUser(env, "alpha1");
  await populate(env, "alpha1", a.creatorKey);
  const before = [...kv._store.keys()].filter(k => k.includes("alpha1"));
  const del = await call(env, "/api/creator/delete-account", { method: "POST", json: { creatorName: "alpha1", creatorKey: a.creatorKey, confirm: "DELETE" } });
  const left = [...kv._store.keys()].filter(k => k.includes("alpha1"));
  rec("delete-account returns ok", del.body && del.body.ok === true, JSON.stringify(del.body));
  rec("no KV keys mention the deleted user", left.length === 0, `before=${before.length} left=${JSON.stringify(left)}`);
  rec("D1 creators row gone", !db._creators.has("alpha1"), "");
  rec("D1 creator_lists gone", db.q("SELECT * FROM creator_lists WHERE username='alpha1'").length === 0, "");
  const idxRaw = kv._store.get("index:publiclists");
  const idxHas = idxRaw ? JSON.parse(idxRaw).entries.some(e => e.id.includes("alpha1")) : false;
  rec("public index has no deleted-user entries", !idxHas, idxRaw || "(no index)");
  // scrobble token reverse lookup
  const scrobKeys = [...kv._store.keys()].filter(k => k.startsWith("scrobbletoken:"));
  rec("no orphan scrobble token key", scrobKeys.length === 0, JSON.stringify(scrobKeys));
}

// ---------- 2. username reclaim inherits nothing ----------
{
  const kv = makeKv();
  const db = makeD1();
  const env = makeEnv({ CONFIGS: kv, DB: db });
  const a = await createUser(env, "reclaim1");
  await populate(env, "reclaim1", a.creatorKey);
  await call(env, "/api/creator/delete-account", { method: "POST", json: { creatorName: "reclaim1", creatorKey: a.creatorKey, confirm: "DELETE" } });
  const b = await createUser(env, "reclaim1");
  const lists = await call(env, "/api/creator/lists", { method: "POST", json: { creatorName: "reclaim1", creatorKey: b.creatorKey } });
  rec("reclaimed account has no inherited lists", Array.isArray(lists.body.lists) && lists.body.lists.length === 0, JSON.stringify(lists.body.lists));
  const load = await call(env, "/api/creator/sync/load", { method: "POST", json: { creatorName: "reclaim1", creatorKey: b.creatorKey } });
  const d = load.body.data || {};
  rec("reclaimed account has no inherited watch history", !(d.watchHistory && d.watchHistory.length), JSON.stringify(d.watchHistory));
  rec("reclaimed account has no inherited presets", !(d.presets && Object.keys(d.presets).length), JSON.stringify(d.presets));
  rec("reclaimed account has no inherited channels", !(d.channels && Object.keys(d.channels).length), JSON.stringify(d.channels));
  rec("old key no longer authenticates", (await call(env, "/api/creator/restore", { method: "POST", json: { creatorName: "reclaim1", creatorKey: a.creatorKey, confirm: "DELETE" } })).status === 401, "");
}

// ---------- 3. delete-account with a failing public-index write ----------
{
  const kv = makeKv();
  const db = makeD1();
  const env = makeEnv({ CONFIGS: kv, DB: db });
  const a = await createUser(env, "idxfail1");
  await populate(env, "idxfail1", a.creatorKey);
  // force an index to exist
  await call(env, "/lists/public.json");
  const idxBefore = kv._store.get("index:publiclists");
  kv._hooks.beforePut = async (k) => { if (k === "index:publiclists") throw new Error("KV down for index"); };
  const del = await call(env, "/api/creator/delete-account", { method: "POST", json: { creatorName: "idxfail1", creatorKey: a.creatorKey, confirm: "DELETE" } });
  kv._hooks.beforePut = null;
  const idxAfter = kv._store.get("index:publiclists");
  const stillListed = idxAfter ? JSON.parse(idxAfter).entries.some(e => String(e.id).includes("idxfail1")) : false;
  const identityGone = !kv._store.has("creator:idxfail1");
  rec("index-write failure during delete: NOT reported as ok",
      !(del.body && del.body.ok === true && stillListed),
      `ok=${JSON.stringify(del.body)} stillListedInDirectory=${stillListed} identityDeleted=${identityGone}\n    idxBefore=${idxBefore}\n    idxAfter=${idxAfter}`);
}

console.log("\n" + results.filter(r => !r.ok).length + " FAILURES of " + results.length);

// N4, every authenticated write path. The question is not "did a stray key
// survive" -- a straggler held open indefinitely will always land somewhere --
// but "can the next owner of this username see any of it".
import { makeKv, makeD1, makeEnv, call, createUser } from "../../tests/harness.mjs";

const paths = [
  ["/api/creator/sync/save", b => ({ ...b, config: [{ x: 1 }], keys: { tmdbKey: "VICTIM-TMDB-KEY" } }), "creatorsync:"],
  ["/api/creator/sync/save-tracking", b => ({ ...b, watchHistory: [{ id: "tt-private" }] }), "creatorsynctracking:"],
  ["/api/creator/sync/save-presets", b => ({ ...b, presets: { p: { name: "p" } } }), "creatorsyncpresets:"],
  ["/api/creator/sync/save-channels", b => ({ ...b, channels: { c: {} } }), "creatorsyncchannels:"],
  ["/api/creator/lists/save", b => ({ ...b, name: "Ghost List", type: "movie", visibility: "public", items: [] }), "creatorlist:"],
  ["/api/creator/sync/share-tracking", b => ({ ...b, slug: "watchlist", shared: true }), "creatorshare:"],
  ["/api/creator/scrobble-token", b => ({ ...b }), "creatorscrobbletoken:"],
];

let bad = 0;
for (const [route, mk, prefix] of paths) {
  const kv = makeKv(), db = makeD1(), env = makeEnv({ CONFIGS: kv, DB: db });
  const name = "res" + prefix.replace(/[^a-z]/g, "").slice(0, 12);
  const u = await createUser(env, name);
  const K = { creatorName: name, creatorKey: u.creatorKey };

  // Hold this route's write open right across the deletion.
  let release; const gate = new Promise(r => release = r); let armed = true;
  kv._hooks.beforePut = async (k) => { if (armed && k.startsWith(prefix) && k.includes(name)) { armed = false; await gate; } };
  const inflight = call(env, route, { method: "POST", json: mk(K) });
  await new Promise(r => setTimeout(r, 25));
  const del = await call(env, "/api/creator/delete-account", { method: "POST", json: { ...K, confirm: "DELETE" } });
  release(); await inflight; kv._hooks.beforePut = null;

  const held = kv._store.has(`creatordeleted:${name}`);
  const reclaimBlocked = (await call(env, "/api/creator/create", { method: "POST", json: { creatorName: name } })).body.ok !== true;

  // Now let the hold lapse and see what a new owner actually gets.
  kv._store.delete(`creatordeleted:${name}`);
  const fresh = await call(env, "/api/creator/create", { method: "POST", json: { creatorName: name } });
  const NK = { creatorName: name, creatorKey: fresh.body.creatorKey };
  const load = await call(env, "/api/creator/sync/load", { method: "POST", json: NK });
  const lists = await call(env, "/api/creator/lists", { method: "POST", json: NK });
  const token = await call(env, "/api/creator/scrobble-token", { method: "POST", json: NK });
  const d = load.body.data || {};
  const inherited = [];
  if ((d.config || []).length) inherited.push("config");
  if (Object.keys(d.keys || {}).length) inherited.push("provider keys");
  if ((d.watchHistory || []).length) inherited.push("watchHistory");
  if (Object.keys(d.presets || {}).length) inherited.push("presets");
  if (Object.keys(d.channels || {}).length) inherited.push("channels");
  if ((lists.body.lists || []).length) inherited.push("lists");
  const leftoverKeys = [...kv._store.keys()].filter(k => k.includes(name)
    && !k.startsWith("creator:") && !k.startsWith("creatorlastseen:") && !k.startsWith("ratelimit:"));

  const ok = held && reclaimBlocked && inherited.length === 0;
  if (!ok) bad++;
  console.log(`${ok ? "clean     " : "INHERITED "} ${route.padEnd(36)} held=${held} reclaimBlocked=${reclaimBlocked} inherited=${JSON.stringify(inherited)} strayKeys=${JSON.stringify(leftoverKeys)} newToken!=old=${token.body.token !== undefined}`);
}
console.log(bad ? `\n${bad} path(s) still leak into a reclaimed username` : "\nno path leaks into a reclaimed username");

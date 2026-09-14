// PHASE 12 -- optimistic concurrency attack.
import { makeKv, makeEnv, call, createUser } from "./kit.mjs";
const env = makeEnv({ CONFIGS: makeKv() });
const u = await createUser(env, "alice");
const K = { creatorName: "alice", creatorKey: u.creatorKey };

console.log("=== 1. /sync/save guard works for the blob it covers ===");
let r = await call(env, "/api/creator/sync/save", { method: "POST", json: { ...K, config: [{ url: "A" }] } });
const v0 = r.body.updatedAt;
r = await call(env, "/api/creator/sync/save", { method: "POST", json: { ...K, config: [{ url: "B" }], expectedUpdatedAt: v0 } });
console.log("  device A saves on top of v0 ->", r.status, r.body.ok ? "accepted" : r.body.error);
const stale = await call(env, "/api/creator/sync/save", { method: "POST", json: { ...K, config: [{ url: "STALE" }], expectedUpdatedAt: v0 } });
console.log("  device B saves the SAME stale baseline ->", stale.status, stale.body.conflict ? "409 conflict (correct)" : "ACCEPTED (data lost)");

console.log("\n=== 2. the guard is silently disabled by a non-number ===");
for (const val of [String(v0), null, undefined, "", 0, NaN, v0 + 0.5]) {
  const e2 = makeEnv({ CONFIGS: makeKv() });
  const u2 = await createUser(e2, "alice");
  const K2 = { creatorName: "alice", creatorKey: u2.creatorKey };
  const a = await call(e2, "/api/creator/sync/save", { method: "POST", json: { ...K2, config: [{ url: "ORIGINAL" }] } });
  await call(e2, "/api/creator/sync/save", { method: "POST", json: { ...K2, config: [{ url: "NEWER" }] } });
  const b = await call(e2, "/api/creator/sync/save", { method: "POST", json: { ...K2, config: [{ url: "STALE" }], expectedUpdatedAt: typeof val === "string" ? val : val } });
  const stored = JSON.parse(e2.CONFIGS._store.get("creatorsync:alice")).config[0].url;
  console.log(`  expectedUpdatedAt=${JSON.stringify(val)} (${typeof val}) -> ${b.status} ${b.body.conflict ? "conflict" : "accepted"}; stored=${stored}`);
}

console.log("\n=== 3. same-millisecond collision (Date.now() as a version number) ===");
{
  const e3 = makeEnv({ CONFIGS: makeKv() });
  const u3 = await createUser(e3, "alice");
  const K3 = { creatorName: "alice", creatorKey: u3.creatorKey };
  const realNow = Date.now;
  Date.now = () => 1_700_000_000_000;      // clock frozen: every save is "the same millisecond"
  const a = await call(e3, "/api/creator/sync/save", { method: "POST", json: { ...K3, config: [{ url: "A" }] } });
  await call(e3, "/api/creator/sync/save", { method: "POST", json: { ...K3, config: [{ url: "B-newer" }], expectedUpdatedAt: a.body.updatedAt } });
  const c = await call(e3, "/api/creator/sync/save", { method: "POST", json: { ...K3, config: [{ url: "C-stale" }], expectedUpdatedAt: a.body.updatedAt } });
  Date.now = realNow;
  console.log(`  stale save -> ${c.status} ${c.body.conflict ? "conflict" : "ACCEPTED"}; stored=${JSON.parse(e3.CONFIGS._store.get("creatorsync:alice")).config[0].url}`);
}

console.log("\n=== 4. the three sibling blobs have no guard at all ===");
for (const [route, payloadA, payloadB, key, probe] of [
  ["/api/creator/sync/save-presets", { presets: { keep: { a: 1 } } }, { presets: { other: { b: 2 } } }, "creatorsyncpresets:alice", (o) => Object.keys(o.presets)],
  ["/api/creator/sync/save-channels", { channels: { keep: { a: 1 } } }, { channels: { other: { b: 2 } } }, "creatorsyncchannels:alice", (o) => Object.keys(o.channels)],
]) {
  const e4 = makeEnv({ CONFIGS: makeKv() });
  const u4 = await createUser(e4, "alice");
  const K4 = { creatorName: "alice", creatorKey: u4.creatorKey };
  await call(e4, route, { method: "POST", json: { ...K4, ...payloadA } });         // device A adds "keep"
  const before = probe(JSON.parse(e4.CONFIGS._store.get(key)));
  await call(e4, route, { method: "POST", json: { ...K4, ...payloadB } });         // device B, stale, autosaves
  const after = probe(JSON.parse(e4.CONFIGS._store.get(key)));
  console.log(`  ${route}: before=${JSON.stringify(before)} after a stale autosave=${JSON.stringify(after)}`);
}
{
  const e5 = makeEnv({ CONFIGS: makeKv() });
  const u5 = await createUser(e5, "alice");
  const K5 = { creatorName: "alice", creatorKey: u5.creatorKey };
  await call(e5, "/api/creator/sync/save-tracking", { method: "POST", json: { ...K5, watchlist: [{ id: "tt1" }, { id: "tt2" }], watchHistory: [] } });
  await call(e5, "/api/creator/sync/save-tracking", { method: "POST", json: { ...K5, watchlist: [], watchHistory: [] } });  // stale device with an empty watchlist
  console.log("  watchlist after a stale device pushes an empty one:", JSON.parse(e5.CONFIGS._store.get("creatorsynctracking:alice")).watchlist);
  console.log("  the Watchlist custom list:", JSON.parse(e5.CONFIGS._store.get("creatorlist:alice:watchlist")).items);
}

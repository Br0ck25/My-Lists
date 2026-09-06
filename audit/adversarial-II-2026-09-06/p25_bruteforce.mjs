// Phase 17 + 31: unthrottled credential-verification surface.
// /api/creator/restore is protected by a per-IP bucket AND a per-IP daily
// failure budget. Are there other routes that verify a Creator Key with
// neither?
import { makeKv, makeD1, makeEnv, call, createUser } from "../../tests/harness.mjs";
const kv = makeKv(), db = makeD1(), env = makeEnv({ CONFIGS: kv, DB: db });
const u = await createUser(env, "brute1");

async function hammer(label, fn, n = 60) {
  let accepted = 0, throttled = 0, rejected = 0;
  for (let i = 0; i < n; i++) {
    const r = await fn(i);
    const s = r.status;
    if (s === 429) throttled++;
    else if (r.body && r.body.ok === true) accepted++;
    else rejected++;
  }
  console.log(`${label.padEnd(46)} attempts=${n} rejected=${rejected} throttled=${throttled} accepted=${accepted}` +
    (throttled === 0 ? "   <-- NO THROTTLE" : ""));
  return throttled;
}

const badKey = i => "MYL-AAAA-BBBB-" + String(i).padStart(4, "0");
const ip = "203.0.113.200";

await hammer("/api/creator/restore (same IP)", i =>
  call(env, "/api/creator/restore", { method: "POST", ip, json: { creatorName: "brute1", creatorKey: badKey(i) } }));

await hammer("/api/creator/restore (rotating IPs)", i =>
  call(env, "/api/creator/restore", { method: "POST", ip: `198.51.100.${i % 250}`, json: { creatorName: "brute1", creatorKey: badKey(i) } }));

await hammer("/api/scrobble?creator=&key= (same IP)", i =>
  call(env, `/api/scrobble?creator=brute1&key=${badKey(i)}`, { method: "POST", ip, json: { event: "media.scrobble" } }));

await hammer("/api/creator/lists/save (same IP)", i =>
  call(env, "/api/creator/lists/save", { method: "POST", ip, json: { creatorName: "brute1", creatorKey: badKey(i), name: "x", type: "movie", items: [] } }));

await hammer("/api/creator/sync/load (same IP)", i =>
  call(env, "/api/creator/sync/load", { method: "POST", ip, json: { creatorName: "brute1", creatorKey: badKey(i) } }));

await hammer("/api/creator/reset-key (same IP)", i =>
  call(env, "/api/creator/reset-key", { method: "POST", ip, json: { username: "brute1", recoveryAnswer: "guess" + i } }));

console.log("\nEvery row above with NO THROTTLE runs a full PBKDF2-100k verification per request,");
console.log("unauthenticated and uncounted.");

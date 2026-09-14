// The two smaller scale/abuse findings, after the fix.
//
// 1. index:publiclists is ONE global key holding the whole directory, and
//    every like/unlike did a read-modify-write of it -- 4.45 MB parsed,
//    sorted and re-serialised at the entry cap, for a one-number change,
//    against KV's one-write-per-second-per-key limit. Likes are the frequent
//    write, so past roughly one like per second across the whole deployment
//    the index was being written faster than KV accepts it, and the failure
//    mode there is "the directory is hours stale for everyone".
//
// 2. /api/publish-list is unauthenticated, writes a permanent KV key with no
//    TTL, and has no caller in the shipped bundle. At the old 10/minute and
//    2 MB apiece that was 20 MB a minute of unowned storage from one address.
import { makeKv, makeEnv, call, createUser, nextIp } from "../../tests/harness.mjs";

console.log("1. a burst of likes on one public list\n");
{
  const kv = makeKv();
  const env = makeEnv({ CONFIGS: kv });
  const u = await createUser(env, "hotkey");
  await call(env, "/api/creator/lists/save", {
    method: "POST",
    json: { creatorName: u.creatorName, creatorKey: u.creatorKey, name: "Faves", type: "movie", visibility: "public", items: [{ id: "tt1" }] },
  });
  await call(env, "/lists/public.json");

  let indexWrites = 0;
  let indexBytes = 0;
  const realPut = kv.put.bind(kv);
  kv.put = async (k, v, ...rest) => {
    if (k === "index:publiclists") { indexWrites++; indexBytes += String(v).length; }
    return realPut(k, v, ...rest);
  };

  const VOTES = 25;
  for (let i = 0; i < VOTES; i++) {
    await call(env, "/api/lists/like", { method: "POST", ip: nextIp(), json: { username: "hotkey", slug: "faves" } });
  }
  const rec = JSON.parse(kv._store.get("creatorlist:hotkey:faves"));
  console.log(`   votes cast                         ${VOTES}`);
  console.log(`   whole-directory rewrites           ${indexWrites}      (was: one per vote)`);
  console.log(`   bytes re-serialised                ${indexBytes.toLocaleString()}`);
  console.log(`   likes recorded on the record       ${rec.likes}     <- no vote is dropped\n`);
}

console.log("2. what one address can publish anonymously in a minute\n");
{
  const env = makeEnv();
  const ip = nextIp();
  let accepted = 0;
  let bytes = 0;
  // The largest payload the ceiling now allows, repeated until throttled.
  const items = Array.from({ length: 3000 }, (_, i) => ({ id: "tt" + i, title: "X".repeat(120) }));
  for (let i = 0; i < 15; i++) {
    const r = await call(env, "/api/publish-list", {
      method: "POST", ip, json: { name: "List " + i, type: "movie", items, visibility: "public" },
    });
    if (r.body.ok) accepted++;
  }
  for (const [k, v] of env.CONFIGS._store) {
    if (k.startsWith("publishedlist:")) bytes += String(v).length;
  }
  console.log(`   publishes accepted from one IP     ${accepted}       (was: 10)`);
  console.log(`   permanent bytes stored             ${(bytes / 1048576).toFixed(2)} MB   (was: up to 20 MB)`);

  const env2 = makeEnv();
  const junk = [
    ["a bare string", ["just a string"]],
    ["a null entry", [null]],
    ["a nested array", [[1, 2]]],
    ["no id at all", [{ title: "no id" }]],
    ["a 200-char id", [{ id: "x".repeat(200) }]],
  ];
  console.log("\n   entries that are not list items:");
  for (const [label, list] of junk) {
    const r = await call(env2, "/api/publish-list", {
      method: "POST", ip: nextIp(), json: { name: "Junk", type: "movie", items: list, visibility: "public" },
    });
    console.log(`     ${label.padEnd(18)} -> ${r.status}`);
  }
  const stored = [...env2.CONFIGS._store.keys()].filter((k) => k.startsWith("publishedlist:")).length;
  console.log(`   records they managed to create     ${stored}`);
}

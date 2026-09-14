// Concurrency: do parallel writes to the same account lose data?
import { makeEnv, makeKv, makeD1, call, createUser } from "../../tests/harness.mjs";

async function scenario(label, fn) { console.log("\n### " + label); await fn(); }

await scenario("20 concurrent list saves (distinct names)", async () => {
  const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
  const U = await createUser(env, "raceuser");
  const rs = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    call(env, "/api/creator/lists/save", { method: "POST", ip: "203.0.113.7", json: {
      creatorName: U.creatorName, creatorKey: U.creatorKey, name: "List " + i, type: "movie",
      visibility: "private", items: [{ id: "tt" + i }] } })));
  console.log("  statuses:", rs.map(r => r.status).join(","));
  const keys = [...env.CONFIGS._store.keys()].filter(k => k.startsWith("creatorlist:raceuser:"));
  const order = JSON.parse(env.CONFIGS._store.get("creatorlistorder:raceuser") || "{}").order || [];
  console.log("  records written:", keys.length, " order entries:", order.length);
  const listed = await call(env, "/api/creator/lists", { method: "POST", json: { creatorName: U.creatorName, creatorKey: U.creatorKey } });
  console.log("  /api/creator/lists returns:", (listed.body.lists || []).length);
  console.log("  D1 rows:", env.DB._lists.size);
});

await scenario("20 concurrent likes on one list from 20 identities", async () => {
  const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
  const U = await createUser(env, "raceowner");
  const sv = await call(env, "/api/creator/lists/save", { method: "POST", json: {
    creatorName: U.creatorName, creatorKey: U.creatorKey, name: "Popular", type: "movie", visibility: "public", items: [{id:"tt1"}] } });
  const rs = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    call(env, "/api/lists/like", { method: "POST", ip: "198.18.0." + i, json: { username: "raceowner", slug: sv.body.slug, liked: true } })));
  console.log("  statuses:", [...new Set(rs.map(r => r.status))].join(","));
  console.log("  reported likes:", rs.map(r => r.body && r.body.likes).join(","));
  const rec = JSON.parse(env.CONFIGS._store.get(`creatorlist:raceowner:${sv.body.slug}`));
  console.log("  stored likes on the record:", rec.likes);
  const ledger = env.CONFIGS._store.get(`listlikevoters:raceowner:${sv.body.slug}`);
  console.log("  ledger voters:", ledger ? (JSON.parse(ledger).voters || JSON.parse(ledger)).length : "none");
});

await scenario("10 concurrent sync/save-tracking pushes", async () => {
  const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
  const U = await createUser(env, "racetrack");
  const rs = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    call(env, "/api/creator/sync/save-tracking", { method: "POST", ip: "203.0.113.8", json: {
      creatorName: U.creatorName, creatorKey: U.creatorKey,
      watchHistory: [{ id: "tt" + i, title: "T" + i, watchedAt: 1780000000000 + i }] } })));
  console.log("  statuses:", rs.map(r => r.status).join(","));
  const blob = JSON.parse(env.CONFIGS._store.get("creatorsynctracking:racetrack"));
  console.log("  watchHistory ids kept:", blob.watchHistory.map(x => x.id).sort().join(","));
});

await scenario("concurrent delete-account + list save", async () => {
  const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
  const U = await createUser(env, "racedelete");
  await call(env, "/api/creator/lists/save", { method: "POST", json: { creatorName: U.creatorName, creatorKey: U.creatorKey, name: "L", type: "movie", items: [{id:"tt1"}] } });
  const [del, save] = await Promise.all([
    call(env, "/api/creator/delete-account", { method: "POST", json: { creatorName: U.creatorName, creatorKey: U.creatorKey, confirm: "DELETE" } }),
    call(env, "/api/creator/lists/save", { method: "POST", json: { creatorName: U.creatorName, creatorKey: U.creatorKey, name: "L2", type: "movie", items: [{id:"tt2"}] } }),
  ]);
  console.log("  delete:", del.status, JSON.stringify(del.body).slice(0,80), " save:", save.status);
  const left = [...env.CONFIGS._store.keys()].filter(k => k.includes("racedelete"));
  console.log("  KV keys left mentioning the account:", left);
});

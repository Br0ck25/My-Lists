import { makeEnv, makeKv, makeD1, call, createUser } from "../../tests/harness.mjs";
const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
const U = await createUser(env, "cputester");
async function t(label, fn, reps = 5) {
  await fn(); // warm
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < reps; i++) await fn();
  console.log(label.padEnd(46), (Number(process.hrtime.bigint() - t0) / 1e6 / reps).toFixed(1) + " ms/req");
}
await t("GET / (memoized page)", () => call(env, "/"));
await t("GET /app.js", () => call(env, "/app.js"));
await t("POST sync/save (memoized auth)", () => call(env, "/api/creator/sync/save", { method: "POST", ip: "203.0.113.1", json: { creatorName: U.creatorName, creatorKey: U.creatorKey, entries: [] } }));
let i = 0;
await t("POST sync/save (WRONG key -> full PBKDF2)", () => call(env, "/api/creator/sync/save", { method: "POST", ip: "203.0.113." + (2 + (i++ % 200)), json: { creatorName: U.creatorName, creatorKey: "MYL-AAAA-BBBB-CCC" + (i % 10), entries: [] } }));

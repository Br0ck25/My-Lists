import { makeEnv, makeKv, makeD1, call, createUser } from "../../tests/harness.mjs";
const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
await createUser(env, "alicetester");

const admin = [
  ["GET",  "/admin"],
  ["GET",  "/admin/api/leaderboard"],
  ["POST", "/admin/api/backfill-trending"],
  ["POST", "/admin/api/migrate-d1"],
  ["POST", "/admin/api/rebuild-public-index"],
  ["GET",  "/admin/api/creator-lists"],
  ["POST", "/admin/api/delete-creator-list"],
  ["GET",  "/admin/api/schema-status"],
  ["GET",  "/admin/api/published-lists"],
  ["POST", "/admin/api/delete-published-list"],
  ["POST", "/admin/api/migrate-day-counts"],
  ["GET",  "/admin/api/feedback"],
  ["POST", "/admin/api/feedback/reply"],
  ["POST", "/admin/api/feedback/status"],
  ["POST", "/admin/api/feedback/edit"],
  ["POST", "/admin/api/feedback/delete"],
  ["GET",  "/admin/api/analytics"],
  ["GET",  "/admin/api/apiusage"],
  ["GET",  "/admin/api/netflix-preview"],
  ["GET",  "/admin/api/provider-lookup"],
  ["POST", "/admin/api/reset-creator-key"],
  ["GET",  "/admin/logout"],
];
console.log("method path".padEnd(46), "noCookie  forgedCookie  expiredCookie");
for (const [method, p] of admin) {
  const none = await call(env, p, { method, json: method === "POST" ? {} : undefined });
  const forged = await call(env, p, { method, json: method === "POST" ? {} : undefined,
    cookie: `mla_admin=${Date.now() + 999999}.` + "0".repeat(64) });
  const expired = await call(env, p, { method, json: method === "POST" ? {} : undefined,
    cookie: `mla_admin=1.` + "0".repeat(64) });
  console.log(`${method} ${p}`.padEnd(46), String(none.status).padEnd(9), String(forged.status).padEnd(13), expired.status);
}

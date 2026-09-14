// PHASE 31/32 -- what the missing bound on /api/creator/lists/save costs.
import { makeKv, makeRealD1, makeEnv, call, createUser, adminCookie } from "./kit.mjs";
const DB = makeRealD1();
const env = makeEnv({ CONFIGS: makeKv(), DB });
const u = await createUser(env, "alice");
const K = { creatorName: "alice", creatorKey: u.creatorKey };
const item = (i) => ({ id: "tt" + i, title: "Title ".repeat(6) + i, overview: "o".repeat(400), poster: "https://image.tmdb.org/t/p/w500/" + i + ".jpg", year: 2000 + (i % 25), genres: ["Drama", "Action"] });

let total = 0;
for (let n = 0; n < 8; n++) {
  const items = Array.from({ length: 5000 }, (_, i) => item(i));
  const t0 = Date.now();
  const r = await call(env, "/api/creator/lists/save", { method: "POST", json: { ...K, name: "Mega " + n, type: "movie", visibility: "private", items } });
  const bytes = (env.CONFIGS._store.get("creatorlist:alice:mega-" + n) || "").length;
  total += bytes;
  console.log(`save #${n}: ${r.status} ${r.body.ok ? "accepted" : r.body.error}  stored ${(bytes / 1048576).toFixed(2)} MB  (${Date.now() - t0} ms)`);
}
console.log("total KV bytes parked by one account:", (total / 1048576).toFixed(1), "MB across 8 lists");
console.log("D1 items_json bytes:", (DB.q("SELECT SUM(LENGTH(items_json)) AS n FROM creator_lists")[0].n / 1048576).toFixed(1), "MB");

const t1 = Date.now();
const dash = await call(env, "/api/creator/lists", { method: "POST", json: K });
console.log(`GET the dashboard: ${dash.status}, response ${(dash.text.length / 1048576).toFixed(1)} MB, ${Date.now() - t1} ms`);
console.log("  (this endpoint returns every list's FULL items array and is called on every dashboard render)");

// admin bulk delete cap
const cookie = await adminCookie(env);
const many = Array.from({ length: 60 }, (_, i) => "mega-" + i);
const d = await call(env, "/admin/api/delete-creator-list", { method: "POST", cookie, json: { username: "alice", slugs: many } });
console.log("");
console.log("admin bulk delete of 60 slugs (cap is 50):", d.status, JSON.stringify(d.body).slice(0, 200));

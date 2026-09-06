// PHASE 16 -- response cache-header + CORS table for every reachable route.
import { makeKv, makeRealD1, makeEnv, call, createUser, adminCookie } from "./kit.mjs";
const DB = makeRealD1();
const env = makeEnv({ CONFIGS: makeKv(), DB, extra: { TMDB_API_KEY: "", TRAKT_CLIENT_ID: "" } });
const u = await createUser(env, "alice", { recoveryAnswer: "purple-mountains" });
await call(env, "/api/creator/lists/save", { method: "POST", json: { creatorName: "alice", creatorKey: u.creatorKey, name: "Top", type: "movie", visibility: "public", items: [{ id: "tt1" }] } });
const cookie = await adminCookie(env);

const routes = [
  ["GET", "/lists/public.json", null, null],
  ["GET", "/api/public-lists.json", null, null],
  ["GET", "/lists/alice/top.json", null, null],
  ["GET", "/api/search-published-lists?q=top", null, null],
  ["GET", "/manifest.json", null, null],
  ["GET", "/robots.txt", null, null],
  ["GET", "/sitemap.xml", null, null],
  ["GET", "/sw.js", null, null],
  ["GET", "/app.js", null, null],
  ["GET", "/app.css", null, null],
  ["GET", "/api/trakt-my-lists?token=SECRETTOKEN&username=alice", null, null],
  ["GET", "/api/tmdb-my-lists?session_id=SECRETSESSION&account_id=1", null, null],
  ["GET", "/api/mdblist-my-lists?apikey=SECRETKEY", null, null],
  ["GET", "/api/simkl/my-lists?token=SECRETTOKEN", null, null],
  ["GET", "/api/trakt-popular-lists", null, null],
  ["GET", "/api/toplists", null, null],
  ["GET", "/api/details?id=tt0111161", null, null],
  ["GET", "/admin/api/leaderboard", null, cookie],
  ["GET", "/admin/api/feedback", null, cookie],
  ["GET", "/admin/api/analytics", null, cookie],
  ["GET", "/admin/api/apiusage", null, cookie],
  ["GET", "/admin/api/provider-lookup?q=x", null, cookie],
  ["GET", "/admin", null, cookie],
  ["POST", "/api/creator/lists", { creatorName: "alice", creatorKey: u.creatorKey }, null],
  ["POST", "/api/creator/sync/load", { creatorName: "alice", creatorKey: u.creatorKey }, null],
  ["POST", "/api/creator/sync/meta", { creatorName: "alice", creatorKey: u.creatorKey }, null],
  ["POST", "/api/creator/scrobble-token", { creatorName: "alice", creatorKey: u.creatorKey }, null],
  ["POST", "/api/creator/restore", { creatorName: "alice", creatorKey: u.creatorKey }, null],
  ["POST", "/api/creator/create", { creatorName: "zzztest1" }, null],
  ["POST", "/api/creator/reset-key", { username: "alice", recoveryAnswer: "purple-mountains" }, null],
  ["POST", "/api/lists/like", { username: "alice", slug: "top" }, null],
];
const rows = [];
for (const [method, p, body, ck] of routes) {
  const r = await call(env, p, { method, json: body === null ? undefined : body, cookie: ck || undefined });
  rows.push({
    route: `${method} ${p.split("?")[0]}`,
    status: r.status,
    cacheControl: r.headers.get("cache-control") || "(none)",
    cors: r.headers.get("access-control-allow-origin") || "-",
    vary: r.headers.get("vary") || "-",
    len: r.text.length,
  });
}
const w = (s, n) => String(s).padEnd(n).slice(0, n);
console.log(w("ROUTE", 46) + w("ST", 5) + w("CACHE-CONTROL", 34) + w("CORS", 5) + "BYTES");
for (const r of rows) console.log(w(r.route, 46) + w(r.status, 5) + w(r.cacheControl, 34) + w(r.cors, 5) + r.len);

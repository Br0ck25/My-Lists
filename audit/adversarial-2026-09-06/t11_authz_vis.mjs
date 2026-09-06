import { makeKv, makeRealD1, makeEnv, call, createUser, adminCookie } from "./kit.mjs";
const DB = makeRealD1();
const env = makeEnv({ CONFIGS: makeKv(), DB });
const A = await createUser(env, "alice", { recoveryAnswer: "purple-mountains" });
const B = await createUser(env, "bobby", { recoveryAnswer: "orange-valleys" });
await call(env, "/api/creator/lists/save", { method: "POST", json: { creatorName: "alice", creatorKey: A.creatorKey, name: "Secret", type: "movie", visibility: "private", items: [{ id: "tt_private" }] } });
await call(env, "/api/creator/lists/save", { method: "POST", json: { creatorName: "alice", creatorKey: A.creatorKey, name: "Public One", type: "movie", visibility: "public", items: [{ id: "tt_public" }] } });
const cookie = await adminCookie(env);

console.log("=== PHASE 17: authorization matrix (mutating routes) ===");
const muts = [
  ["/api/creator/lists/save", { slug: "secret", name: "Hijacked", type: "movie", items: [], visibility: "public" }],
  ["/api/creator/lists/delete", { slug: "secret" }],
  ["/api/creator/lists/reorder", { order: ["secret"] }],
  ["/api/creator/sync/save", { config: [] }],
  ["/api/creator/sync/save-tracking", { watchHistory: [] }],
  ["/api/creator/sync/save-presets", { presets: {} }],
  ["/api/creator/sync/save-channels", { channels: {} }],
  ["/api/creator/sync/share-tracking", { slug: "watchlist", shared: true }],
  ["/api/creator/account/reset", { confirm: "RESET" }],
  ["/api/creator/delete-account", { confirm: "DELETE" }],
  ["/api/creator/scrobble-token", {}],
  ["/api/creator/sync/load", {}],
  ["/api/creator/lists", {}],
  ["/api/creator/sync/meta", {}],
  ["/api/creator/track-status", {}],
  ["/api/creator/scrobble-seen-users", {}],
];
const roles = [
  ["anonymous", {}],
  ["A->A(self)", { creatorName: "alice", creatorKey: A.creatorKey }],
  ["B->A(other)", { creatorName: "alice", creatorKey: B.creatorKey }],
  ["B->B(self)", { creatorName: "bobby", creatorKey: B.creatorKey }],
];
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
console.log(pad("ROUTE", 40) + roles.map(r => pad(r[0], 14)).join(""));
for (const [route, extra] of muts) {
  const cells = [];
  for (const [, creds] of roles) {
    const fresh = makeEnv({ CONFIGS: makeKv(), DB: makeRealD1() });
    const a2 = await createUser(fresh, "alice");
    const b2 = await createUser(fresh, "bobby");
    const c = creds.creatorName ? { creatorName: creds.creatorName, creatorKey: creds.creatorName === "alice" ? a2.creatorKey : b2.creatorKey } : {};
    // cross-account attempt: B's key with alice's name must fail
    const c2 = (creds.creatorName === "alice" && creds.creatorKey === B.creatorKey) ? { creatorName: "alice", creatorKey: b2.creatorKey } : c;
    const r = await call(fresh, route, { method: "POST", json: { ...c2, ...extra } });
    cells.push(pad(`${r.status}${r.body && r.body.ok ? " ok" : ""}`, 14));
  }
  console.log(pad(route, 40) + cells.join(""));
}

console.log("\n=== admin routes with no admin cookie ===");
for (const [m, p, b] of [["POST","/admin/api/migrate-d1",{}],["POST","/admin/api/rebuild-public-index",{}],["POST","/admin/api/delete-creator-list",{username:"alice",slugs:["public-one"]}],["POST","/admin/api/reset-creator-key",{username:"alice"}],["POST","/admin/api/backfill-trending",{}],["POST","/admin/api/migrate-day-counts",{}],["GET","/admin/api/analytics",null],["GET","/admin/api/feedback",null],["POST","/admin/api/feedback/delete",{id:"x"}],["POST","/admin/api/feedback/reply",{id:"x",message:"y"}],["POST","/admin/api/feedback/status",{id:"x",status:"open"}],["POST","/admin/api/feedback/edit",{id:"x"}],["GET","/admin/api/leaderboard",null],["GET","/admin/api/apiusage",null],["GET","/admin/api/netflix-preview",null],["GET","/admin/api/provider-lookup",null],["GET","/admin",null]]) {
  const r = await call(env, p, { method: m, json: b === null ? undefined : b });
  console.log(pad(`${m} ${p}`, 44) + `-> ${r.status} ${typeof r.body === "object" ? JSON.stringify(r.body).slice(0, 60) : "(html " + r.text.length + "b)"}  CC=${r.headers.get("cache-control")}`);
}

console.log("\n=== PHASE 14: private list leak surface ===");
const paths = [
  "/lists/alice/secret", "/lists/alice/secret.json", "/lists/alice/secret.json?format=object",
  "/lists/public.json", "/api/public-lists.json", "/api/search-published-lists?q=secret",
];
for (const p of paths) {
  const r = await call(env, p, { headers: { Accept: "application/json" } });
  const leaks = r.text.includes("tt_private") || r.text.toLowerCase().includes("secret");
  console.log(pad(p, 46) + `-> ${r.status}  leaks=${leaks}  ${r.text.slice(0, 120).replace(/\s+/g, " ")}`);
}

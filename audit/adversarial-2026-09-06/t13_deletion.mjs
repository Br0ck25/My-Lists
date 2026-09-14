// PHASE 33 -- account deletion proof, then username reclaim.
import { makeKv, makeRealD1, makeEnv, call, createUser } from "./kit.mjs";
const DB = makeRealD1();
const env = makeEnv({ CONFIGS: makeKv(), DB });
const U = "deleteme";
const u = await createUser(env, U, { recoveryAnswer: "purple-mountains" });
const K = { creatorName: U, creatorKey: u.creatorKey };

await call(env, "/api/creator/lists/save", { method: "POST", json: { ...K, name: "Public List", type: "movie", visibility: "public", items: [{ id: "tt1" }] } });
await call(env, "/api/creator/lists/save", { method: "POST", json: { ...K, name: "Private List", type: "movie", visibility: "private", items: [{ id: "tt2" }] } });
await call(env, "/api/creator/sync/save", { method: "POST", json: { ...K, config: [{ url: "x" }], keys: { tmdbKey: "abc" }, likedLists: ["l1"] } });
await call(env, "/api/creator/sync/save-tracking", { method: "POST", json: { ...K, watchHistory: [{ id: "tt9", watchedAt: 1 }], continueWatching: [], watchlist: [{ id: "tt8" }], trackPlayback: true } });
await call(env, "/api/creator/sync/save-presets", { method: "POST", json: { ...K, presets: { p1: { a: 1 } } } });
await call(env, "/api/creator/sync/save-channels", { method: "POST", json: { ...K, channels: { c1: { a: 1 } } } });
await call(env, "/api/creator/sync/share-tracking", { method: "POST", json: { ...K, slug: "watchlist", shared: true } });
const tok = await call(env, "/api/creator/scrobble-token", { method: "POST", json: { ...K } });
await call(env, "/api/creator/sync/like", { method: "POST", json: { ...K, url: "https://trakt.tv/users/a/lists/b", liked: true } });
await call(env, "/api/lists/like", { method: "POST", ip: "203.0.113.7", json: { username: U, slug: "public-list" } });
await call(env, "/api/creator/track-status", { method: "POST", json: { ...K } });
await call(env, "/api/feedback", { method: "POST", json: { message: "hello from deleteme", creatorName: U, email: "a@b.c" } });
// a failed recovery attempt, to create the per-account failure budget key
await call(env, "/api/creator/reset-key", { method: "POST", json: { username: U, recoveryAnswer: "wrong-answer-here" } });

const mine = () => [...env.CONFIGS._store.keys()].filter(k => k.includes(U) || (tok.body.token && k.includes(tok.body.token)));
console.log("keys owned by the account BEFORE delete:\n  " + mine().join("\n  "));
console.log("D1 rows:", DB.q("SELECT username FROM creators"), DB.q("SELECT id FROM creator_lists"));

const del = await call(env, "/api/creator/delete-account", { method: "POST", json: { ...K, confirm: "DELETE" } });
console.log("\ndelete ->", del.status, JSON.stringify(del.body));
console.log("\nKEYS LEFT BEHIND:\n  " + (mine().length ? mine().map(k => `${k}  =  ${String(env.CONFIGS._store.get(k)).slice(0, 120)}`).join("\n  ") : "(none)"));
console.log("\nD1 after:", DB.q("SELECT username FROM creators"), DB.q("SELECT id FROM creator_lists"));
console.log("scrobble token still resolves:", !!env.CONFIGS._store.get("scrobbletoken:" + tok.body.token));
console.log("directory:", JSON.stringify((await call(env, "/lists/public.json")).body.lists));
console.log("old key authenticates:", (await call(env, "/api/creator/restore", { method: "POST", json: K })).status);

// --- reclaim the username --------------------------------------------------
const u2 = await createUser(env, U);
console.log("\nreclaimed by a NEW owner. What did they inherit?");
const lists = await call(env, "/api/creator/lists", { method: "POST", json: { creatorName: U, creatorKey: u2.creatorKey } });
console.log("  dashboard:", JSON.stringify(lists.body));
const share = await call(env, "/lists/" + U + "/watchlist.json");
console.log("  /lists/deleteme/watchlist.json ->", share.status, share.text.slice(0, 120));
const sync = await call(env, "/api/creator/sync/load", { method: "POST", json: { creatorName: U, creatorKey: u2.creatorKey } });
console.log("  sync/load:", JSON.stringify(sync.body).slice(0, 300));
console.log("  reset-key failure budget inherited:", [...env.CONFIGS._store.keys()].filter(k => k.startsWith("authfail:")).map(k => k + "=" + env.CONFIGS._store.get(k)));

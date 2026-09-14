// Probe: the Continue Watching merge in /api/creator/sync/save-tracking keys
// "already handled" on sKey.split(':')[0]. For a tmdb-prefixed show id that
// base key is the literal string "tmdb", so ONE server-side tmdb: entry marks
// EVERY client tmdb: entry as already handled and drops it.
import { makeEnv, makeKv, makeD1, call, createUser } from "../../tests/harness.mjs";
const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
const u = await createUser(env, "basekey");
const cred = { creatorName: "basekey", creatorKey: u.creatorKey };

// Seed a server-side Continue Watching entry for a tmdb-prefixed show
// (exactly the shape findCompanionBridgeMovie / a tmdb-only show produces).
await call(env, "/api/creator/sync/save-tracking", { method: "POST", json: {
  ...cred, intentionalRemoval: true,
  continueWatching: [{ id: "tmdb:111:1:1", showId: "tmdb:111", name: "Show One S1E1", seasonNum: 1, episodeNum: 1 }],
}});
console.log("seeded server CW:", env.DB.q("SELECT show_id,name FROM continue_watching"));

// Now a NORMAL autosave from the browser: it still has show 111 AND two other
// tmdb-prefixed shows it is watching.
const r = await call(env, "/api/creator/sync/save-tracking", { method: "POST", json: {
  ...cred,
  continueWatching: [
    { id: "tmdb:111:1:1", showId: "tmdb:111", name: "Show One S1E1", seasonNum: 1, episodeNum: 1 },
    { id: "tmdb:222:3:4", showId: "tmdb:222", name: "Show Two S3E4", seasonNum: 3, episodeNum: 4 },
    { id: "tmdb:333:2:9", showId: "tmdb:333", name: "Show Three S2E9", seasonNum: 2, episodeNum: 9 },
    { id: "tt444:1:1",    showId: "tt444",    name: "Show Four S1E1", seasonNum: 1, episodeNum: 1 },
  ],
}});
console.log("save:", r.status, JSON.stringify(r.body));
console.log("stored CW (D1):", env.DB.q("SELECT show_id,name FROM continue_watching"));
console.log("stored CW (KV):", JSON.parse(env.CONFIGS._store.get("creatorsynctracking:basekey")).continueWatching.map(x => x.showId));

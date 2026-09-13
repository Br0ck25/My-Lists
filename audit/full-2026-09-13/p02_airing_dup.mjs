import { makeEnv, makeKv, makeD1, call, createUser } from "../../tests/harness.mjs";
const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
const u = await createUser(env, "dupan");
const cred = { creatorName: "dupan", creatorKey: u.creatorKey };
let r = await call(env, "/api/creator/sync/save-tracking", { method: "POST", json: {
  ...cred, intentionalRemoval: true,
  watchHistory: [{ id: "ttA:1:1", showId: "ttA", seasonNum:1, episodeNum:1, watchedAt: 5 }],
  airingNext: [
    { id: "ttZ:2:1", showId: "ttZ", name: "S2E1", seasonNum: 2, episodeNum: 1, airDate: "2026-10-01" },
    { id: "ttZ:2:2", showId: "ttZ", name: "S2E2", seasonNum: 2, episodeNum: 2, airDate: "2026-10-08" },
  ],
}});
console.log("save:", r.status, JSON.stringify(r.body));
console.log("D1 airing_next:", env.DB.q("SELECT show_id,item_id FROM airing_next"));
console.log("D1 watch_history:", env.DB.q("SELECT item_id FROM watch_history"));
console.log("D1 meta:", env.DB.q("SELECT username,client_version FROM creator_tracking_meta"));

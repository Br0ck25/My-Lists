// Probe: duplicate showId in continueWatching -> D1 tracking write fails,
// route still answers {ok:true}, and /sync/load (which prefers D1) serves
// the stale D1 copy while KV holds the truth.
import { makeEnv, makeKv, makeD1, call, createUser } from "../../tests/harness.mjs";

const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
const u = await createUser(env, "dupcw");
const cred = { creatorName: "dupcw", creatorKey: u.creatorKey };

// 1. a clean save first, so D1 has a good row
let r = await call(env, "/api/creator/sync/save-tracking", { method: "POST", json: {
  ...cred,
  watchHistory: [{ id: "tt1:1:1", showId: "tt1", seasonNum: 1, episodeNum: 1, watchedAt: 1000 }],
  continueWatching: [{ id: "tt1:1:2", showId: "tt1", name: "Ep2", seasonNum: 1, episodeNum: 2 }],
}});
console.log("save#1:", r.status, JSON.stringify(r.body));
console.log("  D1 continue_watching rows:", env.DB.q("SELECT show_id,item_id FROM continue_watching"));

// 2. now a save whose continueWatching has two entries for the SAME showId
r = await call(env, "/api/creator/sync/save-tracking", { method: "POST", json: {
  ...cred,
  intentionalRemoval: true,           // skip the merge so the payload passes through verbatim
  watchHistory: [{ id: "tt1:1:1", showId: "tt1", seasonNum: 1, episodeNum: 1, watchedAt: 1000 },
                 { id: "tt9:1:1", showId: "tt9", seasonNum: 1, episodeNum: 1, watchedAt: 2000 }],
  continueWatching: [
    { id: "tt2:1:1", showId: "tt2", name: "A", seasonNum: 1, episodeNum: 1 },
    { id: "tt2:1:2", showId: "tt2", name: "B", seasonNum: 1, episodeNum: 2 },
  ],
}});
console.log("save#2:", r.status, JSON.stringify(r.body));
console.log("  D1 continue_watching rows:", env.DB.q("SELECT show_id,item_id,name FROM continue_watching"));
console.log("  D1 watch_history rows:", env.DB.q("SELECT item_id FROM watch_history"));
console.log("  KV blob continueWatching:", JSON.parse(env.CONFIGS._store.get("creatorsynctracking:dupcw")).continueWatching.map(x=>x.id));

// 3. what does the user see on the next load?
r = await call(env, "/api/creator/sync/load", { method: "POST", json: cred });
console.log("load:", r.status, "continueWatching=", JSON.stringify(r.body.data && r.body.data.continueWatching),
            "watchHistory=", JSON.stringify((r.body.data && r.body.data.watchHistory || []).map(x=>x.id)));

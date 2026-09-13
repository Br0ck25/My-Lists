import { makeEnv, makeKv, makeD1, call, createUser } from "../../tests/harness.mjs";
const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
const u = await createUser(env, "prefixuser");
await call(env, "/api/creator/sync/save-tracking", { method: "POST", json: {
  creatorName: "prefixuser", creatorKey: u.creatorKey,
  watchHistory: [
    { id: "tmdb:999:1:1", showId: "tmdb:999", showTitle: "TMDB Only Show", seasonNum: 1, episodeNum: 1, watchedAt: 5 },
    { id: "tt1:1:1", showId: "tt1", showTitle: "IMDb Show", seasonNum: 1, episodeNum: 1, watchedAt: 6 },
  ],
  continueWatching: [{ id: "tmdb:999:1:2", showId: "tmdb:999", showTitle: "TMDB Only Show", seasonNum: 1, episodeNum: 2 }],
}});
const b64 = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64").replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const cfg = b64({ entries: [
  { id: "wh", name: "History", type: "series", url: "autotrack:watch-history:series:prefixuser" },
  { id: "cw", name: "Continue", type: "series", url: "autotrack:continue-watching:series:prefixuser" },
]});
let r = await call(env, "/" + cfg + "/manifest.json");
console.log("manifest idPrefixes:", JSON.stringify(r.body.idPrefixes),
            " meta resource:", JSON.stringify(r.body.resources.find(x=>x && x.name==="meta")));
for (const id of ["wh","cw"]) {
  r = await call(env, "/" + cfg + "/catalog/series/" + id + ".json");
  console.log(id, "->", JSON.stringify((r.body.metas||[]).map(m => m.id)));
}
// and does /meta resolve a tmdb: id?
r = await call(env, "/" + cfg + "/meta/series/" + encodeURIComponent("tmdb:999") + ".json");
console.log("meta tmdb:999 ->", r.status, JSON.stringify(r.body).slice(0,160));

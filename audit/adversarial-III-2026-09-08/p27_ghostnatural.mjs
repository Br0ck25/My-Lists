// Same ghost, with NO artificial stall -- just two requests issued together,
// which is what an autosave landing as someone confirms deletion looks like.
import { makeKv, makeD1, makeEnv, call, createUser } from "../../tests/harness.mjs";
let ghosts = 0, trials = 10;
for (let t = 0; t < trials; t++) {
  const name = "nat" + t;
  const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
  const u = await createUser(env, name);
  const K = { creatorName: name, creatorKey: u.creatorKey };
  const [del, save] = await Promise.all([
    call(env, "/api/creator/delete-account", { method: "POST", json: { ...K, confirm: "DELETE" } }),
    call(env, "/api/creator/lists/save", { method: "POST", json: { ...K, name: "Autosaved", type: "movie", visibility: "public", items: [{ id: "tt1", title: "x" }] } }),
  ]);
  const page = await call(env, `/lists/${name}/autosaved.json`);
  const stray = [...env.CONFIGS._store.keys()].filter(k => k.startsWith(`creatorlist:${name}:`));
  if (page.status === 200 || stray.length) {
    ghosts++;
    if (ghosts === 1) console.log(`  trial ${t}: delete=${del.status} save=${save.status} publicPage=${page.status} stray=${JSON.stringify(stray)} cleared=${JSON.stringify(del.body.cleared)}`);
  }
}
console.log(`ghost public list left behind in ${ghosts}/${trials} plain concurrent delete+save runs`);

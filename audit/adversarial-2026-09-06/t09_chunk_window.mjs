// Seed KV directly with a realistically-sized KV-only deployment, then run
// ONE chunk of /admin/api/migrate-d1 and look at the intermediate state.
import { makeKv, makeRealD1, makeEnv, call, adminCookie } from "./kit.mjs";
const kv = makeKv();
const N = 400;
for (let i = 0; i < N; i++) {
  const u = `creator${String(i).padStart(3, "0")}`;
  kv._store.set(`creator:${u}`, JSON.stringify({ displayName: u, keyHash: "pbkdf2:100000:aa:bb", recoveryAnswerHash: null, createdAt: 1 }));
  kv._store.set(`creatorlist:${u}:favourites`, JSON.stringify({ name: "Favourites", slug: "favourites", type: "movie", items: [{ id: "tt1" }], visibility: "public", likes: 7, createdAt: 1, updatedAt: 2 }));
  kv._store.set(`creatorlistorder:${u}`, JSON.stringify({ order: ["favourites"] }));
}
const DB = makeRealD1();
const env = makeEnv({ CONFIGS: kv, DB });
const cookie = await adminCookie(env);
let call_n = 0, done = false;
while (!done && call_n < 30) {
  const m = await call(env, "/admin/api/migrate-d1", { method: "POST", cookie });
  call_n++;
  done = m.body.done;
  const c = DB.q("SELECT COUNT(*) n FROM creators")[0].n;
  const l = DB.q("SELECT COUNT(*) n FROM creator_lists")[0].n;
  console.log(`chunk ${call_n}: done=${done} creators=${c} lists=${l}  (accounts whose lists D1 does NOT yet know: ${Math.max(0, c - l)})`);
  if (call_n >= 4 && !done) break;
}

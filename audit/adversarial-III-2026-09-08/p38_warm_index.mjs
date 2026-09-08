// Same 400-account profile, but with index:publiclists already built --
// which is the steady state, not the cold path p37 happened to measure.
import { makeKv, makeD1, makeEnv, call, createUser } from "../../tests/harness.mjs";

const CREATORS = 400, LISTS_EACH = 6;
const kv = makeKv(), db = makeD1(), env = makeEnv({ CONFIGS: kv, DB: db });
for (let u = 0; u < CREATORS; u++) {
  const name = "user" + String(u).padStart(4, "0");
  kv._store.set(`creator:${name}`, JSON.stringify({ displayName: "Display " + name, keyHash: "pbkdf2:1:aa:bb", createdAt: 1 }));
  const order = [];
  for (let l = 0; l < LISTS_EACH; l++) {
    const slug = "list-" + l; order.push(slug);
    kv._store.set(`creatorlist:${name}:${slug}`, JSON.stringify({
      name: "A Reasonably Named List " + l, slug, type: "movie",
      visibility: l % 2 ? "public" : "private",
      items: Array.from({ length: 60 }, (_, i) => ({ id: "tt" + i, title: "A Movie Title " + i })),
      likes: (u + l) % 9, createdAt: 1, updatedAt: 1000 + l }));
  }
  kv._store.set(`creatorlistorder:${name}`, JSON.stringify({ order }));
}
const login = await call(env, "/admin/login", { method: "POST", form: { key: "test-admin-secret" } });
const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
let done = false, chunks = 0;
while (!done && chunks < 100) { done = (await call(env, "/admin/api/rebuild-public-index", { method: "POST", cookie })).body.done; chunks++; }
const idx = kv._store.get("index:publiclists");
const entries = JSON.parse(idx).entries.length;
console.log(`built in ${chunks} chunks · ${entries} public lists · index blob ${(idx.length / 1024).toFixed(0)} KB\n`);

function meter() {
  const c = { kv: 0, d1: 0 };
  for (const m of ["get", "put", "delete", "list"]) { const o = kv[m].bind(kv); kv[m] = async (...a) => { c.kv++; return o(...a); }; }
  const p = db.prepare.bind(db);
  db.prepare = (sql) => { const w = (s) => ({ ...s, async run(){c.d1++; return s.run();}, async all(){c.d1++; return s.all();}, async first(x){c.d1++; return s.first(x);}, bind:(...a)=>w(s.bind(...a)) }); return w(p(sql)); };
  return c;
}
const SAVER = await createUser(env, "saveruser");
console.log("route".padEnd(42) + "KV".padStart(6) + "D1".padStart(5) + "  total");
for (const [label, fn] of [
  ["GET /lists/public.json", () => call(env, "/lists/public.json")],
  ["GET /api/search-published-lists?q=list", () => call(env, "/api/search-published-lists?q=list")],
  ["GET /admin (dashboard)", () => call(env, "/admin", { cookie })],
  ["POST /api/lists/like (anonymous vote)", () =>
      call(env, "/api/lists/like", { method: "POST", ip: "203.0.113.44", json: { username: "user0000", slug: "list-1", liked: true } })],
  ["POST /api/creator/lists/save (public)", () =>
      call(env, "/api/creator/lists/save", { method: "POST", json: { creatorName: SAVER.creatorName, creatorKey: SAVER.creatorKey, name: "New Public List", type: "movie", visibility: "public", items: [{ id: "tt1", title: "x" }] } })],
]) {
  const c = meter();
  await fn();
  console.log(label.padEnd(42) + String(c.kv).padStart(6) + String(c.d1).padStart(5) + "  " + (c.kv + c.d1));
}

// The production profile: D1 BOUND, ~400 creator accounts. Counts KV ops and
// D1 queries per invocation, both of which are subrequests.
//   Workers Paid: 10,000 subrequests/invocation, KV 1,000 ops, D1 1,000 queries
//   Workers Free:     50 subrequests/invocation, KV 1,000 ops, D1    50 queries
import { makeKv, makeD1, makeEnv, call, createUser, worker } from "../../tests/harness.mjs";

function seed(kv, db, creators, listsEach) {
  for (let u = 0; u < creators; u++) {
    const name = "user" + String(u).padStart(4, "0");
    kv._store.set(`creator:${name}`, JSON.stringify({ displayName: name, keyHash: "pbkdf2:1:aa:bb", createdAt: 1 }));
    try { db._db.exec(`INSERT INTO creators (username, display_name, key_hash, created_at) VALUES ('${name}','${name}','x',1)`); } catch {}
    const order = [];
    for (let l = 0; l < listsEach; l++) {
      const slug = "list-" + l;
      order.push(slug);
      kv._store.set(`creatorlist:${name}:${slug}`, JSON.stringify({
        name: "List " + l, slug, type: "movie", visibility: l % 2 ? "public" : "private",
        items: Array.from({ length: 60 }, (_, i) => ({ id: "tt" + i, title: "A Movie Title " + i })),
        likes: (u + l) % 9, createdAt: 1, updatedAt: 1000 + l }));
      try { db._db.exec(`INSERT INTO creator_lists (id, username, name, type, visibility, items_json, likes, created_at, updated_at) VALUES ('${name}:${slug}','${name}','L','movie','${l % 2 ? "public" : "private"}','[]',${(u + l) % 9},1,1)`); } catch {}
    }
    kv._store.set(`creatorlistorder:${name}`, JSON.stringify({ order }));
  }
}

function meter(kv, db) {
  const c = { kv: 0, d1: 0 };
  for (const m of ["get", "put", "delete", "list"]) { const o = kv[m].bind(kv); kv[m] = async (...a) => { c.kv++; return o(...a); }; }
  const p = db.prepare.bind(db), b = db.batch.bind(db);
  db.prepare = (sql) => { const st = p(sql); const wrap = (s) => ({ ...s, async run(){c.d1++; return s.run();}, async all(){c.d1++; return s.all();}, async first(x){c.d1++; return s.first(x);}, bind:(...a)=>wrap(s.bind(...a)) }); return wrap(st); };
  db.batch = async (stmts) => { c.d1++; return b(stmts); };
  return c;
}

const CREATORS = 400, LISTS_EACH = 6;
console.log(`profile: ${CREATORS} creator accounts x ${LISTS_EACH} lists, D1 bound\n`);
console.log("route".padEnd(40) + "KV ops".padStart(8) + "D1 q".padStart(7) + "  subreq total   vs Free(50) / Paid(10k)");

async function one(label, fn, setup) {
  const kv = makeKv(), db = makeD1(), env = makeEnv({ CONFIGS: kv, DB: db });
  seed(kv, db, CREATORS, LISTS_EACH);
  const extra = setup ? await setup(env) : null;
  const c = meter(kv, db);
  await fn(env, extra);
  const total = c.kv + c.d1;
  console.log(label.padEnd(40) + String(c.kv).padStart(8) + String(c.d1).padStart(7) +
    "  " + String(total).padStart(6) + "        " + (total > 50 ? "OVER free " : "ok free   ") + (total > 10000 ? "OVER paid" : "ok paid"));
}

await one("GET /  (page view)", (env) => call(env, "/"));
await one("GET /lists/public.json", (env) => call(env, "/lists/public.json"));
await one("GET /api/search-published-lists?q=list", (env) => call(env, "/api/search-published-lists?q=list"));
await one("POST /api/creator/lists  (6 lists)",
  (env, U) => call(env, "/api/creator/lists", { method: "POST", json: { creatorName: U.creatorName, creatorKey: U.creatorKey } }),
  (env) => createUser(env, "dashuser"));
await one("POST /api/creator/lists/save (public)",
  (env, U) => call(env, "/api/creator/lists/save", { method: "POST", json: { creatorName: U.creatorName, creatorKey: U.creatorKey, name: "N", type: "movie", visibility: "public", items: [{ id: "tt1" }] } }),
  (env) => createUser(env, "saveuser"));
await one("POST /api/creator/sync/load",
  (env, U) => call(env, "/api/creator/sync/load", { method: "POST", json: { creatorName: U.creatorName, creatorKey: U.creatorKey } }),
  (env) => createUser(env, "loaduser"));
await one("GET /admin (dashboard)", async (env) => {
  const login = await call(env, "/admin/login", { method: "POST", form: { key: "test-admin-secret" } });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  return call(env, "/admin", { cookie });
});
await one("POST /admin/api/migrate-d1 (one chunk)", async (env) => {
  const login = await call(env, "/admin/login", { method: "POST", form: { key: "test-admin-secret" } });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  return call(env, "/admin/api/migrate-d1", { method: "POST", cookie });
});
await one("POST /admin/api/rebuild-public-index", async (env) => {
  const login = await call(env, "/admin/login", { method: "POST", form: { key: "test-admin-secret" } });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  return call(env, "/admin/api/rebuild-public-index", { method: "POST", cookie });
});

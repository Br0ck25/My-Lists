// Realistic version of t16's mutation test: change visibility THROUGH THE API
// during a multi-chunk rebuild, then see what the finished index advertises.
import { makeKv, makeD1, makeEnv, call, createUser } from "../../tests/harness.mjs";

const kv = makeKv();
const env = makeEnv({ CONFIGS: kv, DB: makeD1() });
const U = await createUser(env, "rebuilder");
// 1,200 public lists, written the way the app writes them.
for (let i = 0; i < 1200; i++) {
  const slug = "list" + String(i).padStart(5, "0");
  kv._store.set(`creatorlist:rebuilder:${slug}`, JSON.stringify({
    name: "L" + i, slug, type: "movie", items: [{ id: "tt" + i }], visibility: "public", likes: 0, createdAt: 1, updatedAt: 1 }));
}
kv._store.set("creatorlistorder:rebuilder", JSON.stringify({ order: Array.from({length:1200},(_,i)=>"list"+String(i).padStart(5,"0")) }));

const login = await call(env, "/admin/login", { method: "POST", form: { key: "test-admin-secret" } });
const cookie = (login.headers.get("set-cookie") || "").split(";")[0];

let done = false, chunks = 0, flipped = false;
while (!done && chunks < 200) {
  done = (await call(env, "/admin/api/rebuild-public-index", { method: "POST", cookie })).body.done;
  chunks++;
  if (chunks === 1 && !flipped) {
    flipped = true;
    // The owner makes an already-scanned list private, through the real route.
    const r = await call(env, "/api/creator/lists/save", { method: "POST", json: {
      creatorName: "rebuilder", creatorKey: U.creatorKey, slug: "list00000",
      name: "L0", type: "movie", visibility: "private", items: [{ id: "tt0" }] } });
    console.log("  make-private ->", r.status, JSON.stringify(r.body).slice(0, 80));
    // And deletes another one.
    const d = await call(env, "/api/creator/lists/delete", { method: "POST", json: {
      creatorName: "rebuilder", creatorKey: U.creatorKey, slug: "list00002" } });
    console.log("  delete       ->", d.status, JSON.stringify(d.body).slice(0, 80));
  }
}
const idx = JSON.parse(kv._store.get("index:publiclists"));
const ids = new Set(idx.entries.map(e => e.id));
console.log("chunks:", chunks, "index size:", ids.size);
console.log("  now-PRIVATE list still advertised:", ids.has("c:rebuilder:list00000"));
console.log("  DELETED list still advertised    :", ids.has("c:rebuilder:list00002"));
const dir = await call(env, "/api/public-lists.json?limit=500");
const slugs = new Set((dir.body.lists||[]).map(l => l.slug));
console.log("  directory page1 contains list00000:", slugs.has("list00000"), " list00002:", slugs.has("list00002"));
console.log("  GET /lists/rebuilder/list00000.json ->", (await call(env, "/lists/rebuilder/list00000.json")).status);
console.log("  GET /lists/rebuilder/list00002.json ->", (await call(env, "/lists/rebuilder/list00002.json")).status);

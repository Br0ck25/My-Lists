// Phase 21 + 32: cap boundaries (CAP-1 / CAP / CAP+1) and large-value handling.
import { makeKv, makeD1, makeEnv, call, createUser } from "../../tests/harness.mjs";
const R = []; const rec = (n, ok, d) => { R.push({ n, ok }); console.log(ok ? "PASS" : "FAIL", "-", n, d ? "\n    " + d : ""); };
const kv = makeKv(), db = makeD1(), env = makeEnv({ CONFIGS: kv, DB: db });
const u = await createUser(env, "capuser");
const K = { creatorName: "capuser", creatorKey: u.creatorKey };

const items = n => Array.from({ length: n }, (_, i) => ({ id: "tt" + i }));

// PUBLISHED_LIST_ITEMS_MAX = 10000 on lists/save
for (const [label, n] of [["CAP-1", 9999], ["CAP", 10000], ["CAP+1", 10001]]) {
  const r = await call(env, "/api/creator/lists/save", { method: "POST", json: { ...K, name: `Items ${label}`, type: "movie", visibility: "private", items: items(n) } });
  console.log(`lists/save items=${n} (${label}) -> ${r.status} ${JSON.stringify(r.body).slice(0, 110)}`);
}
// PUBLISHED_LIST_NAME_MAX = 200
for (const [label, n] of [["CAP-1", 199], ["CAP", 200], ["CAP+1", 201]]) {
  const r = await call(env, "/api/creator/lists/save", { method: "POST", json: { ...K, name: "N".repeat(n), type: "movie", visibility: "private", items: [] } });
  console.log(`lists/save nameLen=${n} (${label}) -> ${r.status} ${JSON.stringify(r.body).slice(0, 110)}`);
}
// CREATOR_LIST_BYTES_MAX = 1_800_000 - build items whose JSON straddles the bound
// Few items, each large, so the BYTE cap is what trips and not the 10,000
// item cap -- the original fixture here used ~18,000 small items and so only
// ever tested the item cap twice.
function itemsOfBytes(target) {
  const out = [];
  while (JSON.stringify(out).length < target) out.push({ id: "tt" + out.length, t: "x".repeat(4000) });
  return out;
}
{
  const big = itemsOfBytes(1_800_000);
  const under = big.slice(0, big.length - 2);
  console.log(`bytes over  = ${JSON.stringify(big).length}, under = ${JSON.stringify(under).length}`);
  const r1 = await call(env, "/api/creator/lists/save", { method: "POST", json: { ...K, name: "Bytes under", type: "movie", visibility: "private", items: under } });
  const r2 = await call(env, "/api/creator/lists/save", { method: "POST", json: { ...K, name: "Bytes over", type: "movie", visibility: "private", items: big } });
  rec("byte cap accepts just-under and rejects just-over",
    (r1.body && r1.body.ok === true) && r2.status === 413,
    `under -> ${r1.status} ${JSON.stringify(r1.body).slice(0, 80)}; over -> ${r2.status} ${JSON.stringify(r2.body).slice(0, 80)}`);
  // and nothing partial was stored for the rejected one
  rec("an over-cap list leaves no partial record", !kv._store.has("creatorlist:capuser:bytes-over"), "");
  rec("an over-cap list leaves no D1 row", !db._lists.has("capuser:bytes-over"), "");
}
// CREATOR_LIST_ORDER_MAX = 5000
for (const [label, n] of [["CAP-1", 4999], ["CAP", 5000], ["CAP+1", 5001]]) {
  const order = Array.from({ length: n }, (_, i) => "s" + i);
  const r = await call(env, "/api/creator/lists/reorder", { method: "POST", json: { ...K, order } });
  const stored = JSON.parse(kv._store.get("creatorlistorder:capuser")).order.length;
  console.log(`reorder n=${n} (${label}) -> ${r.status} storedEntries=${stored}${stored !== Math.min(n, 5000) ? "  <-- unexpected" : ""}`);
}
// ADMIN_LIST_DELETE_MAX = 50
{
  const login = await call(env, "/admin/login", { method: "POST", form: { key: "test-admin-secret" } });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  for (const [label, n] of [["CAP-1", 49], ["CAP", 50], ["CAP+1", 51]]) {
    const slugs = Array.from({ length: n }, (_, i) => "z" + i);
    const r = await call(env, "/admin/api/delete-creator-list", { method: "POST", cookie, json: { username: "capuser", slugs } });
    console.log(`admin delete n=${n} (${label}) -> ${r.status} ok=${r.body && r.body.ok}`);
  }
}
// LIKE_VOTER_CAP = 5000
{
  await call(env, "/api/creator/lists/save", { method: "POST", json: { ...K, slug: "likecap", name: "Like Cap", type: "movie", visibility: "public", items: [] } });
  const voters = Array.from({ length: 5000 }, (_, i) => "a:filler" + i);
  kv._store.set("listlikevoters:capuser:likecap", JSON.stringify(voters));
  const r = await call(env, "/api/lists/like", { method: "POST", ip: "203.0.113.77", json: { username: "capuser", slug: "likecap" } });
  const after = JSON.parse(kv._store.get("listlikevoters:capuser:likecap")).length;
  rec("like ledger at cap refuses to grow and says so",
    r.body && r.body.capped === true && after === 5000,
    `resp=${JSON.stringify(r.body)} ledgerSize=${after}`);
  // one voter below cap must still be accepted
  kv._store.set("listlikevoters:capuser:likecap", JSON.stringify(voters.slice(0, 4999)));
  const r2 = await call(env, "/api/lists/like", { method: "POST", ip: "203.0.113.78", json: { username: "capuser", slug: "likecap" } });
  const after2 = JSON.parse(kv._store.get("listlikevoters:capuser:likecap")).length;
  rec("like ledger one below cap still accepts a vote",
    r2.body && r2.body.ok === true && after2 === 5000,
    `resp=${JSON.stringify(r2.body)} ledgerSize=${after2}`);
}
console.log("\n" + R.filter(x => !x.ok).length + " FAILURES of " + R.length);

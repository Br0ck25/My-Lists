// Phase 18 + 21 + 32: route contract fuzzing and boundary testing.
// Target: can malformed-but-valid input produce corrupt persistent state?
import { makeKv, makeD1, makeEnv, call, createUser } from "../../tests/harness.mjs";
const problems = [];
const kv = makeKv(), db = makeD1(), env = makeEnv({ CONFIGS: kv, DB: db });
const u = await createUser(env, "fuzzuser");
const K = { creatorName: "fuzzuser", creatorKey: u.creatorKey };

const NUL = String.fromCharCode(0);
const bodies = [
  undefined, null, {}, [], "string", 42, true,
  { name: null, type: null, items: null },
  { name: "", type: "movie", items: [] },
  { name: "   ", type: "movie", items: [] },
  { name: "A".repeat(5000), type: "movie", items: [] },
  { name: "ok", type: "MOVIE", items: [] },
  { name: "ok", type: "movie", items: "not an array" },
  { name: "ok", type: "movie", items: [[[["deep"]]]] },
  { name: "ok", type: "movie", items: [{ id: NUL + "nullbyte" }] },
  { name: "ok", type: "movie", items: [{ id: "tt1" }, { id: "tt1" }, { id: "tt1" }] },
  { name: "ok", type: "movie", items: [], visibility: "PUBLIC" },
  { name: "ok", type: "movie", items: [], visibility: 1 },
  { name: "ok", type: "movie", items: [], slug: "../../etc/passwd" },
  { name: "ok", type: "movie", items: [], slug: "a:b:c" },
  { name: "ok", type: "movie", items: [], slug: " " },
  { name: "ok", type: "movie", items: [], slug: "A".repeat(400) },
  { name: "日本語のリスト", type: "movie", items: [] },
  { name: "ok", type: "movie", items: [], expectedUpdatedAt: "NaN" },
  { name: "ok", type: "movie", items: [], expectedUpdatedAt: -1 },
  { name: "ok", type: "movie", items: [], slug: "s" + NUL + "x" },
];
const routes = ["/api/creator/lists/save", "/api/creator/lists/delete", "/api/creator/lists/reorder",
  "/api/creator/sync/save", "/api/creator/sync/save-tracking", "/api/creator/sync/save-presets",
  "/api/creator/sync/save-channels", "/api/creator/sync/like", "/api/creator/sync/share-tracking",
  "/api/publish-list", "/api/lists/like"];
let calls = 0, throws = 0;
for (const route of routes) {
  for (const b of bodies) {
    calls++;
    const payload = (b && typeof b === "object" && !Array.isArray(b)) ? { ...K, ...b } : b;
    let r;
    try { r = await call(env, route, { method: "POST", json: payload }); }
    catch (e) { throws++; problems.push(`${route} threw on ${JSON.stringify(b).slice(0, 60)}: ${e.message}`); continue; }
    if (r.status >= 500 && !(r.body && typeof r.body === "object" && "ok" in r.body))
      problems.push(`${route} ${JSON.stringify(b).slice(0, 50)} -> ${r.status} non-JSON`);
  }
}
// Audit the persisted state for anything corrupt.
for (const [k, v] of kv._store) {
  if (k.startsWith("creatorlist:") || k.startsWith("publishedlist:")) {
    let d; try { d = JSON.parse(v); } catch { problems.push(`unparseable record at ${k}`); continue; }
    if (!["public", "private"].includes(d.visibility)) problems.push(`bad visibility ${JSON.stringify(d.visibility)} at ${k}`);
    if (!Array.isArray(d.items)) problems.push(`items is not an array at ${k}: ${typeof d.items}`);
    if (typeof d.likes !== "number") problems.push(`likes is not a number at ${k}: ${JSON.stringify(d.likes)}`);
    const seg = k.split(":");
    if (k.startsWith("creatorlist:") && seg.length !== 3) problems.push(`key shape violated: ${k}`);
    if (/[^a-z0-9:_-]/.test(k)) problems.push(`unexpected characters in KV key: ${JSON.stringify(k)}`);
  }
  if (k.startsWith("creatorlistorder:")) {
    let d; try { d = JSON.parse(v); } catch { problems.push(`unparseable order at ${k}`); continue; }
    if (!Array.isArray(d.order)) problems.push(`order not an array at ${k}`);
  }
}
for (const row of db.q("SELECT * FROM creator_lists")) {
  if (!["public", "private"].includes(row.visibility)) problems.push(`D1 bad visibility ${row.visibility} on ${row.id}`);
  try { if (!Array.isArray(JSON.parse(row.items_json))) problems.push(`D1 items_json not an array on ${row.id}`); }
  catch { problems.push(`D1 items_json unparseable on ${row.id}`); }
  if (!kv._store.has(`creatorlist:${row.id}`)) problems.push(`D1 row with no KV record: ${row.id}`);
}
console.log(`${calls} fuzz calls, ${throws} uncaught throws`);
console.log("KV list records:", [...kv._store.keys()].filter(k => k.startsWith("creatorlist:")).length,
  " D1 rows:", db.q("SELECT COUNT(*) n FROM creator_lists")[0].n);
console.log("KV list keys created:", JSON.stringify([...kv._store.keys()].filter(k => k.startsWith("creatorlist:") || k.startsWith("publishedlist:")).slice(0, 30)));
console.log("\nPROBLEMS:\n" + (problems.length ? problems.map(p => "  " + p).join("\n") : "  none"));

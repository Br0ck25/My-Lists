// PHASE 18/32 -- route contract fuzzing focused on CORRUPT PERSISTENT STATE.
import { makeKv, makeRealD1, makeEnv, call, createUser } from "./kit.mjs";
const DB = makeRealD1();
const env = makeEnv({ CONFIGS: makeKv(), DB });
const u = await createUser(env, "alice");
const K = { creatorName: "alice", creatorKey: u.creatorKey };
const kvKeys = () => [...env.CONFIGS._store.keys()];

const NL = String.fromCharCode(10);
const NUL = String.fromCharCode(0);

const bodies = [
  ["empty object", {}],
  ["name is a number", { name: 12345, type: "movie", items: [] }],
  ["items is a string", { name: "x1", type: "movie", items: "not-an-array" }],
  ["items is an object", { name: "x2", type: "movie", items: { a: 1 } }],
  ["type garbage", { name: "x3", type: "<script>", items: [] }],
  ["visibility PUBLIC", { name: "casey", type: "movie", visibility: "PUBLIC", items: [] }],
  ["visibility 1", { name: "casey2", type: "movie", visibility: 1, items: [] }],
  ["visibility true", { name: "casey3", type: "movie", visibility: true, items: [] }],
  ["slug path traversal", { slug: "../../evil", name: "x4", type: "movie", items: [] }],
  ["slug with colon", { slug: "a:b", name: "x5", type: "movie", items: [] }],
  ["slug newline+nul", { slug: "a" + NL + "b" + NUL + "c", name: "x6", type: "movie", items: [] }],
  ["slug unicode", { slug: "éà中文", name: "x7", type: "movie", items: [] }],
  ["slug 500 chars", { slug: "z".repeat(500), name: "x8", type: "movie", items: [] }],
  ["name 5000 chars", { name: "n".repeat(5000), type: "movie", items: [] }],
  ["name only whitespace", { name: "    ", type: "movie", items: [] }],
  ["name only punctuation", { name: "!!!???", type: "movie", items: [] }],
  ["nested array items", { name: "nest", type: "movie", items: [[[[1]]]] }],
  ["items with proto key", { name: "proto", type: "movie", items: [JSON.parse('{"__proto__":{"polluted":true}}')] }],
  ["huge items (20000)", { name: "huge", type: "movie", items: Array.from({ length: 20000 }, (_, i) => ({ id: "tt" + i, overview: "o".repeat(200) })) }],
];
console.log("=== POST /api/creator/lists/save ===");
for (const [label, extra] of bodies) {
  const before = kvKeys().length;
  let r;
  try { r = await call(env, "/api/creator/lists/save", { method: "POST", json: { ...K, ...extra } }); }
  catch (e) { console.log(label.padEnd(24) + " THREW " + e.message); continue; }
  const newKeys = kvKeys().slice(before);
  console.log(label.padEnd(24) + " " + String(r.status).padEnd(4) + " " + JSON.stringify(r.body).slice(0, 80).padEnd(82) + " new: " + JSON.stringify(newKeys));
}
console.log("");
console.log("prototype polluted:", ({}).polluted);
const huge = env.CONFIGS._store.get("creatorlist:alice:huge");
console.log("stored 'huge' list bytes:", huge ? huge.length : "(not stored)");
const nameList = kvKeys().filter(k => /^creatorlist:alice:n{20,}/.test(k))[0];
if (nameList) console.log("5000-char name -> key length " + nameList.length + ", stored name length " + JSON.parse(env.CONFIGS._store.get(nameList)).name.length);

console.log("");
console.log("=== visibility values that reached storage ===");
for (const k of kvKeys().filter(k => k.startsWith("creatorlist:alice:"))) {
  const v = JSON.parse(env.CONFIGS._store.get(k));
  console.log("  " + k.slice(0, 60).padEnd(62) + JSON.stringify(v.visibility));
}
console.log("public directory now:", JSON.stringify((await call(env, "/lists/public.json")).body.lists.map(l => l.slug)));

console.log("");
console.log("=== POST /api/creator/lists/reorder fuzzing ===");
for (const [label, order] of [
  ["not an array", "abc"],
  ["10000 entries", Array.from({ length: 10000 }, (_, i) => "slug" + i)],
  ["foreign + 300 chars", ["bobby-secret", "x".repeat(300)]],
  ["duplicates", ["a", "a", "a"]],
  ["numbers", [1, 2, 3]],
]) {
  const r = await call(env, "/api/creator/lists/reorder", { method: "POST", json: { ...K, order } });
  const rawStored = env.CONFIGS._store.get("creatorlistorder:alice") || "{}";
  const stored = JSON.parse(rawStored).order || [];
  console.log(label.padEnd(22) + " " + r.status + " stored " + stored.length + " entries, " + rawStored.length + " bytes");
}

console.log("");
console.log("=== /api/publish-list (unauthenticated) size + slug bounds ===");
for (const [label, body] of [
  ["10001 items", { name: "big", type: "movie", items: Array.from({ length: 10001 }, (_, i) => ({ id: i })) }],
  ["10000 fat items", { name: "fat", type: "movie", items: Array.from({ length: 10000 }, (_, i) => ({ id: i, overview: "o".repeat(300) })) }],
  ["name 201 chars", { name: "N".repeat(201), type: "movie", items: [] }],
  ["name emoji only", { name: "\u{1F600}\u{1F600}", type: "movie", items: [] }],
]) {
  const r = await call(env, "/api/publish-list", { method: "POST", ip: "198.51.200." + Math.floor(Math.random() * 200), json: body });
  console.log(label.padEnd(20) + " " + r.status + " " + JSON.stringify(r.body).slice(0, 110));
}

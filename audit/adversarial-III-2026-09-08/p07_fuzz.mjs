// Sweep every literal route with edge-case inputs, looking for uncaught 500s.
import { makeEnv, makeKv, makeD1, call, createUser } from "../../tests/harness.mjs";
import { readFileSync } from "node:fs";

const routes = new Set();
for (const f of ["25_api-catalog-routes.js", "26_api-creator-and-admin-routes.js"]) {
  const src = readFileSync("../../" + f, "utf8");
  for (const m of src.matchAll(/path === "([^"]+)"/g)) routes.add(m[1]);
}
const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
const U = await createUser(env, "fuzzuser");

const BIG = "A".repeat(20000);
const payloads = [
  ["empty-get", { method: "GET" }],
  ["empty-post", { method: "POST", json: {} }],
  ["null-fields", { method: "POST", json: { creatorName: null, creatorKey: null, name: null, items: null, slug: null, id: null, url: null } }],
  ["wrong-types", { method: "POST", json: { creatorName: 1, creatorKey: [], name: {}, items: "x", slug: 3.5, visibility: 7, type: false } }],
  ["nan-inf", { method: "POST", json: { creatorName: U.creatorName, creatorKey: U.creatorKey, limit: "Infinity", offset: -1, expectedUpdatedAt: "NaN", count: 1e308 } }],
  ["proto", { method: "POST", json: JSON.parse('{"__proto__":{"polluted":1},"constructor":{"prototype":{"x":1}},"creatorName":"fuzzuser"}') }],
  ["huge-string", { method: "POST", json: { creatorName: BIG, name: BIG, slug: BIG, q: BIG } }],
  ["deep", { method: "POST", json: { creatorName: "fuzzuser", items: JSON.parse("[".repeat(60) + "1" + "]".repeat(60)) } }],
  ["bad-json", { method: "POST", headers: { "Content-Type": "application/json" }, raw: "{not json" }],
];

const bad = [];
for (const p of [...routes].sort()) {
  for (const [label, opts] of payloads) {
    let r;
    try {
      if (opts.raw !== undefined) {
        const res = await (await import("../../tests/harness.mjs")).call;
        r = await call(env, p, { method: "POST", headers: { "Content-Type": "application/json" } , json: undefined });
        continue;
      }
      r = await call(env, p, opts);
    } catch (e) {
      bad.push([p, label, "THREW", e.message.slice(0, 90)]);
      continue;
    }
    if (r.status >= 500) bad.push([p, label, r.status, JSON.stringify(r.body).slice(0, 110)]);
  }
  // query-string abuse on GET
  for (const qs of ["?q=" + encodeURIComponent(BIG.slice(0,3000)), "?limit=-1&offset=-1", "?limit=1e999", "?id=%ff%fe", "?url=javascript:alert(1)", "?poster=http://169.254.169.254/latest/meta-data/"]) {
    let r;
    try { r = await call(env, p + qs, { method: "GET" }); }
    catch (e) { bad.push([p + qs, "GETQS", "THREW", e.message.slice(0,90)]); continue; }
    if (r.status >= 500) bad.push([p + qs, "GETQS", r.status, JSON.stringify(r.body).slice(0, 110)]);
  }
}
console.log("=== 5xx / throws ===");
if (!bad.length) console.log("none");
for (const b of bad) console.log(b.join("  |  "));
console.log("checked", routes.size, "routes");
console.log("proto polluted?", ({}).polluted, Object.prototype.polluted);

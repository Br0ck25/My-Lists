// /api/resolve after the fix: the legitimate cross-deployment path still
// works, the SSRF path does not, and the outbound branch is rate limited.
import { makeEnv, makeKv, makeD1, call } from "../../tests/harness.mjs";

const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
const emptyCfg = Buffer.from(JSON.stringify({ entries: [] })).toString("base64")
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const attempted = [];
const real = globalThis.fetch;
globalThis.fetch = async (u) => {
  const s = typeof u === "string" ? u : u.url;
  attempted.push(s);
  return new Response(JSON.stringify({
    ok: true, entries: [{ id: "r1", name: "From the sibling deployment", url: "tmdb:chart:popular", type: "movie", enabled: true }],
    traktAccessToken: "SIBLING-TOKEN",
  }), { status: 200, headers: { "Content-Type": "application/json" } });
};

console.log("=== 1. the legitimate case: a link from a sibling deployment ===");
attempted.length = 0;
const good = await call(env, `/api/resolve?config=${emptyCfg}&url=${encodeURIComponent("https://someone-else.workers.dev/abc/manifest.json")}`, { ip: "203.0.113.10" });
console.log("   status", good.status, "| entries:", (good.body.entries || []).length, "| name:", (good.body.entries || [{}])[0].name);
console.log("   outbound:", attempted);
console.log("   Cache-Control:", good.headers.get("cache-control"), " <- must be no-store (it carries the sibling's token)");

console.log("\n=== 2. the SSRF cases: no outbound request at all ===");
for (const t of ["http://127.0.0.1:9/", "https://127.0.0.1/", "http://localhost/", "https://2130706433/",
                 "https://10.0.0.5/", "https://[::1]/", "https://box.local/", "https://api.internal/",
                 "https://example.com:8080/", "file:///etc/passwd", "http://evil.com/"]) {
  attempted.length = 0;
  const r = await call(env, `/api/resolve?config=${emptyCfg}&url=${encodeURIComponent(t)}`, { ip: "203.0.113.11" });
  console.log(`   ${t.padEnd(28)} outbound=${attempted.length}  ${attempted.length === 0 ? "blocked" : "LEAKED -> " + attempted[0]}`);
}

console.log("\n=== 3. rate limit on the outbound branch ===");
let ok = 0, throttled = 0;
for (let i = 0; i < 30; i++) {
  const r = await call(env, `/api/resolve?config=${emptyCfg}&url=${encodeURIComponent("https://sibling" + i + ".workers.dev/x/manifest.json")}`, { ip: "203.0.113.12" });
  if (r.status === 429) throttled++; else ok++;
}
console.log(`   30 outbound-branch calls from one IP -> ${ok} allowed, ${throttled} throttled (429)`);

console.log("\n=== 4. an ordinary import never touches the bucket ===");
const localCfg = Buffer.from(JSON.stringify({ entries: [{ id: "a", name: "Popular", url: "tmdb:chart:popular", type: "movie", enabled: true }] })).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
let local200 = 0;
for (let i = 0; i < 40; i++) {
  const r = await call(env, `/api/resolve?config=${localCfg}`, { ip: "203.0.113.12" });
  if (r.status === 200 && r.body.ok) local200++;
}
console.log(`   40 local resolves from the SAME (already throttled) IP -> ${local200} succeeded`);
globalThis.fetch = real;

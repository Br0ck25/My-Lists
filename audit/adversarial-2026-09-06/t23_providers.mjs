// PHASE 24 -- external provider contract mutation. Does bad upstream data
// corrupt persistent state or escape as an unhandled exception?
import { makeKv, makeEnv, call, createUser } from "./kit.mjs";

const realFetch = globalThis.fetch;
let mode = "ok";
globalThis.fetch = async (input, init) => {
  const u = String(input && input.url ? input.url : input);
  if (!/themoviedb|trakt|mdblist|simkl|api\./.test(u)) return realFetch(input, init);
  const H = { "Content-Type": "application/json" };
  switch (mode) {
    case "malformed": return new Response("{not json", { status: 200, headers: H });
    case "empty": return new Response("{}", { status: 200, headers: H });
    case "array": return new Response("[1,2,3]", { status: 200, headers: H });
    case "nulls": return new Response(JSON.stringify({ results: [{ id: null, title: null, name: null }] }), { status: 200, headers: H });
    case "dupes": return new Response(JSON.stringify({ results: [{ id: 1, title: "A" }, { id: 1, title: "A" }] }), { status: 200, headers: H });
    case "204": return new Response(null, { status: 204 });
    case "301": return new Response("", { status: 301, headers: { Location: "https://evil.example/" } });
    case "401": return new Response(JSON.stringify({ status_message: "bad key" }), { status: 401, headers: H });
    case "429": return new Response("rate limited", { status: 429 });
    case "500": return new Response("boom", { status: 500 });
    case "huge": return new Response(JSON.stringify({ results: Array.from({ length: 5000 }, (_, i) => ({ id: i, title: "T".repeat(500) })) }), { status: 200, headers: H });
    case "timeout": return new Promise(() => {});
    default: return new Response(JSON.stringify({ results: [] }), { status: 200, headers: H });
  }
};

const env = makeEnv({ CONFIGS: makeKv(), extra: { TMDB_API_KEY: "k", TRAKT_CLIENT_ID: "k", SIMKL_CLIENT_ID: "k", MDBLIST_API_KEY: "k" } });
const u = await createUser(env, "alice");
const K = { creatorName: "alice", creatorKey: u.creatorKey };
await call(env, "/api/creator/lists/save", { method: "POST", json: { ...K, name: "Baseline", type: "movie", visibility: "public", items: [{ id: "tt1" }] } });
const snapshot = () => JSON.stringify([...env.CONFIGS._store.entries()].filter(([k]) => k.startsWith("creator")).sort());
const before = snapshot();

const routes = [
  ["GET", "/api/title-search?q=matrix&type=movie"],
  ["GET", "/api/show-seasons?id=tt0111161"],
  ["GET", "/api/details?id=tt0111161"],
  ["GET", "/api/trakt-popular-lists"],
  ["POST", "/api/preview", { url: "https://mdblist.com/lists/someone/my-list", type: "movie", sample: 5 }],
  ["POST", "/api/recommendations", { items: [{ id: "tt1" }] }],
  ["POST", "/api/bulk-resolve", { items: [{ title: "The Matrix", year: 1999 }] }],
];
const modes = ["malformed", "empty", "array", "nulls", "dupes", "204", "301", "401", "429", "500", "huge"];
console.log("mode".padEnd(12) + routes.map(r => r[1].split("?")[0].replace("/api/", "").slice(0, 14).padEnd(16)).join(""));
for (const m of modes) {
  mode = m;
  const cells = [];
  for (const [method, p, body] of routes) {
    try {
      const r = await call(env, p, { method, json: body });
      cells.push(String(r.status).padEnd(16));
    } catch (e) { cells.push("THREW".padEnd(16)); }
  }
  console.log(m.padEnd(12) + cells.join(""));
}
mode = "ok";
console.log("");
console.log("persistent account state unchanged after every mutation:", snapshot() === before);
globalThis.fetch = realFetch;

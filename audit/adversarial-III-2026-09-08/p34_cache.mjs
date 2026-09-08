// Cache-Control on GET endpoints whose response body is per-account.
import { makeKv, makeD1, makeEnv, call, createUser } from "../../tests/harness.mjs";
const real = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify([{ ids: { slug: "s" }, name: "n" }]), { status: 200, headers: { "Content-Type": "application/json" } });
const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
const U = await createUser(env, "cacheuser");
const saved = await call(env, "/api/save", { method: "POST", json: { entries: [{id:"a",url:"tmdb:chart:popular",type:"movie"}], traktAccessToken: "SECRET-TOKEN", mdblistKey: "SECRET-KEY" } });
const paths = [
  `/api/resolve?config=${saved.body.id}`,
  "/api/trakt-my-lists?username=someone&traktKey=SECRET",
  "/api/mdblist-my-lists?apikey=SECRET-MDBLIST-KEY",
  "/api/tmdb-my-lists?accessToken=SECRET-TMDB",
  "/api/simkl/my-lists?accessToken=SECRET-SIMKL",
  "/api/feedback/threads?threadIds=abc",
  "/api/trakt-popular-lists",
  "/api/toplists",
];
for (const p of paths) {
  const r = await call(env, p);
  console.log(String(r.status).padStart(3), (r.headers.get("cache-control")||"(none)").padEnd(14), p);
}
globalThis.fetch = real;

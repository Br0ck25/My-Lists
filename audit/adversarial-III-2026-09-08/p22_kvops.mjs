// KV operation counts per request (KV ops count against BOTH the 1000
// ops/invocation cap and, on the free plan, 1000 writes/day).
import { makeEnv, makeKv, makeD1, call, createUser } from "../../tests/harness.mjs";

function instrument(kv) {
  const c = { get: 0, put: 0, del: 0, list: 0, putKeys: [] };
  const g = kv.get.bind(kv), p = kv.put.bind(kv), d = kv.delete.bind(kv), l = kv.list.bind(kv);
  kv.get = async (...a) => { c.get++; return g(...a); };
  kv.put = async (...a) => { c.put++; c.putKeys.push(a[0]); return p(...a); };
  kv.delete = async (...a) => { c.del++; return d(...a); };
  kv.list = async (...a) => { c.list++; return l(...a); };
  return c;
}

async function measure(label, fn, withD1) {
  const kv = makeKv();
  const env = makeEnv({ CONFIGS: kv, DB: withD1 ? makeD1() : undefined });
  const seed = await fn.setup ? await (fn.setup ? fn.setup(env) : null) : null;
  const c = instrument(kv);
  await fn.run(env, seed);
  console.log(`${label.padEnd(42)} get=${String(c.get).padStart(4)} put=${String(c.put).padStart(4)} del=${String(c.del).padStart(3)} list=${String(c.list).padStart(3)}   writes:[${[...new Set(c.putKeys)].slice(0,6).join(", ")}]`);
}

await measure("GET /  (page view, no D1)", { run: (env) => call(env, "/") }, false);
await measure("GET /  (page view, with D1)", { run: (env) => call(env, "/") }, true);
await measure("GET /lists/trending (page view)", { run: (env) => call(env, "/lists/trending") }, false);
await measure("POST /api/track-install", { run: (env) => call(env, "/api/track-install", { method: "POST", json: { groups: { A: 2, B: 1 } } }) }, false);
await measure("POST /api/creator/create", { run: (env) => call(env, "/api/creator/create", { method: "POST", json: { creatorName: "kvopsuser" } }) }, false);
await measure("POST /api/creator/sync/save", {
  setup: (env) => createUser(env, "kvopsuser"),
  run: (env, U) => call(env, "/api/creator/sync/save", { method: "POST", json: { creatorName: U.creatorName, creatorKey: U.creatorKey, entries: [] } }),
}, false);
await measure("POST /api/creator/lists/save (public)", {
  setup: (env) => createUser(env, "kvopsuser"),
  run: (env, U) => call(env, "/api/creator/lists/save", { method: "POST", json: { creatorName: U.creatorName, creatorKey: U.creatorKey, name: "L", type: "movie", visibility: "public", items: [{id:"tt1"}] } }),
}, false);
await measure("POST /api/track-event (watched)", { run: (env) => call(env, "/api/track-event", { method: "POST", json: { events: [{ eventType: "watched", id: "tt1", title: "X", mediaType: "movie" }] } }) }, false);
await measure("POST /api/feedback", { run: (env) => call(env, "/api/feedback", { method: "POST", json: { message: "hello there this is feedback" } }) }, false);

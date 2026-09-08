import { makeEnv, makeKv, makeD1, call } from "../../tests/harness.mjs";
const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
const pub = await call(env, "/api/publish-list", { method: "POST", json: { name: "Anon Test List", type: "movie", visibility: "public", items: [{id:"tt1"}] }});
console.log("published:", pub.body.listName);

// Force the legacy fallback: remove the index and its build state so getPublicListIndex returns null.
const drop = [...env.CONFIGS._store.keys()].filter(k => k.startsWith("index:") || k.startsWith("publicindex"));
console.log("index keys present:", drop);
for (const k of drop) env.CONFIGS._store.delete(k);
// Also take the rebuild lock so the cold path serves the legacy scan.
env.CONFIGS._store.set("index:publiclists:lock", "1");

const dir = await call(env, "/lists/public.json");
console.log("directory (fallback):", JSON.stringify(dir.body).slice(0, 400));
const u = dir.body.lists && dir.body.lists[0] && dir.body.lists[0].url;
if (u) {
  const p = new URL(u).pathname;
  const r = await call(env, p);
  console.log("GET", p, "->", r.status, JSON.stringify(r.body).slice(0, 80));
  const r2 = await call(env, "/lists/user/" + dir.body.lists[0].slug);
  console.log("GET /lists/user/<slug> ->", r2.status);
}
const sr = await call(env, "/api/search-published-lists?q=anon");
console.log("search:", JSON.stringify(sr.body).slice(0, 400));

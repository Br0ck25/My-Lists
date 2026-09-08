import { makeKv, makeD1, makeEnv, call, createUser } from "../../tests/harness.mjs";
for (const n of [980, 990, 995, 1000]) {
  const kv = makeKv(); const env = makeEnv({ CONFIGS: kv, DB: makeD1() });
  const U = await createUser(env, "bpuser");
  const order = [];
  for (let i = 0; i < n; i++) { const s = "l" + i; order.push(s);
    kv._store.set(`creatorlist:bpuser:${s}`, JSON.stringify({ name: s, slug: s, type: "movie", visibility: "private", items: [{id:"tt1"}], updatedAt: 1 })); }
  kv._store.set("creatorlistorder:bpuser", JSON.stringify({ order }));
  let ops = 0; const g = kv.get.bind(kv), l = kv.list.bind(kv), p = kv.put.bind(kv), d = kv.delete.bind(kv);
  kv.get = async (...a) => { ops++; return g(...a); }; kv.list = async (...a) => { ops++; return l(...a); };
  kv.put = async (...a) => { ops++; return p(...a); }; kv.delete = async (...a) => { ops++; return d(...a); };
  const r = await call(env, "/api/creator/lists", { method: "POST", json: { creatorName: U.creatorName, creatorKey: U.creatorKey } });
  console.log(`lists=${n}  kvOps=${ops}  ${ops > 1000 ? "OVER the 1,000 KV-ops-per-invocation limit" : "under"}`);
}

// Cost and size of one dashboard load (/api/creator/lists) as a creator's
// list count grows. KV ops count as subrequests (1,000 per invocation).
import { makeKv, makeD1, makeEnv, call, createUser } from "../../tests/harness.mjs";

for (const n of [10, 100, 500, 1200]) {
  const kv = makeKv();
  const env = makeEnv({ CONFIGS: kv, DB: makeD1() });
  const U = await createUser(env, "dashuser");
  const order = [];
  for (let i = 0; i < n; i++) {
    const slug = "list" + String(i).padStart(5, "0");
    order.push(slug);
    kv._store.set(`creatorlist:dashuser:${slug}`, JSON.stringify({
      name: "List " + i, slug, type: "movie", visibility: "private",
      items: Array.from({ length: 100 }, (_, j) => ({ id: "tt" + j, title: "A Fairly Normal Movie Title " + j, poster: "https://image.tmdb.org/t/p/w500/abcdefghijklmno.jpg", year: 2015 })),
      likes: 0, createdAt: 1, updatedAt: 1 }));
  }
  kv._store.set("creatorlistorder:dashuser", JSON.stringify({ order }));
  let ops = 0;
  const g = kv.get.bind(kv), l = kv.list.bind(kv);
  kv.get = async (...a) => { ops++; return g(...a); };
  kv.list = async (...a) => { ops++; return l(...a); };
  const t0 = process.hrtime.bigint();
  const r = await call(env, "/api/creator/lists", { method: "POST", json: { creatorName: U.creatorName, creatorKey: U.creatorKey } });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`lists=${String(n).padStart(5)}  status=${r.status}  kvOps=${String(ops).padStart(5)}  respBytes=${(r.text.length/1048576).toFixed(2)}MB  wall=${ms.toFixed(0)}ms  returned=${(r.body.lists||[]).length}`);
}

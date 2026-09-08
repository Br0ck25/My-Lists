// Measure the cost of one public-list save at index sizes 100..20000.
import { makeEnv, makeKv, makeD1, call, createUser } from "../../tests/harness.mjs";

function makeIndex(n) {
  const entries = [];
  for (let i = 0; i < n; i++) {
    entries.push({
      id: `c:user${i}:list-${i}`, isCreator: true, username: `user${i}`,
      creatorName: `Display Name ${i}`, slug: `list-${i}`, name: `A Reasonably Long List Name ${i}`,
      type: "movie", itemCount: 40, likes: (i * 7) % 100, updatedAt: 1780000000000 + i,
    });
  }
  return JSON.stringify({ updatedAt: Date.now(), entries });
}

for (const n of [100, 1000, 5000, 20000]) {
  const kv = makeKv();
  const env = makeEnv({ CONFIGS: kv, DB: makeD1() });
  const U = await createUser(env, "scaleuser");
  const blob = makeIndex(n);
  kv._store.set("index:publiclists", blob);
  let reads = 0, writes = 0, bytesRead = 0, bytesWritten = 0;
  const origGet = kv.get.bind(kv), origPut = kv.put.bind(kv);
  kv.get = async (k, t) => { const v = await origGet(k, t); if (k === "index:publiclists") { reads++; bytesRead += (v||"").length; } return v; };
  kv.put = async (k, v, o) => { if (k === "index:publiclists") { writes++; bytesWritten += String(v).length; } return origPut(k, v, o); };

  const t0 = process.hrtime.bigint();
  const r = await call(env, "/api/creator/lists/save", { method: "POST", json: {
    creatorName: U.creatorName, creatorKey: U.creatorKey, name: "My New Public List",
    type: "movie", visibility: "public", items: [{ id: "tt1", title: "x" }] }});
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`index=${String(n).padStart(6)} blob=${(blob.length/1048576).toFixed(2)}MB  save=${r.status}  wall=${ms.toFixed(1)}ms  indexReads=${reads} (${(bytesRead/1048576).toFixed(2)}MB) indexWrites=${writes} (${(bytesWritten/1048576).toFixed(2)}MB)`);
}

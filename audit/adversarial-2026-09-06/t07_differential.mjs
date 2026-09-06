// PHASE 10 -- differential: the identical request sequence in KV-only mode
// and in KV+D1 mode. Any externally observable difference is a finding.
import { makeKv, makeRealD1, makeEnv, call, createUser, adminCookie } from "./kit.mjs";

async function run(mode) {
  const DB = mode === "d1" ? makeRealD1() : undefined;
  const env = makeEnv({ CONFIGS: makeKv(), DB });
  const out = [];
  const rec = (label, r) => out.push([label, r.status, JSON.stringify(r.body)]);

  const u = await createUser(env, "alice", { recoveryAnswer: "purple-mountains" });
  const v = await createUser(env, "bobby");
  const key = u.creatorKey;

  rec("create dup", await call(env, "/api/creator/create", { method: "POST", json: { creatorName: "alice" } }));
  rec("restore", await call(env, "/api/creator/restore", { method: "POST", json: { creatorName: "alice", creatorKey: key } }));

  const s1 = await call(env, "/api/creator/lists/save", { method: "POST", json: { creatorName: "alice", creatorKey: key, name: "Top Ten", type: "movie", visibility: "public", items: [{ id: "tt1" }] } });
  rec("save new", s1);
  for (let i = 0; i < 3; i++) await call(env, "/api/lists/like", { method: "POST", ip: `203.0.113.${10 + i}`, json: { username: "alice", slug: "top-ten" } });
  rec("lists (after 3 likes)", await call(env, "/api/creator/lists", { method: "POST", json: { creatorName: "alice", creatorKey: key } }));
  rec("edit", await call(env, "/api/creator/lists/save", { method: "POST", json: { creatorName: "alice", creatorKey: key, slug: "top-ten", name: "Top Ten v2", type: "movie", visibility: "public", items: [{ id: "tt1" }, { id: "tt2" }] } }));
  rec("lists (after edit)", await call(env, "/api/creator/lists", { method: "POST", json: { creatorName: "alice", creatorKey: key } }));
  rec("public.json", await call(env, "/lists/public.json"));
  rec("search", await call(env, "/api/search-published-lists?q=top"));
  rec("make private", await call(env, "/api/creator/lists/save", { method: "POST", json: { creatorName: "alice", creatorKey: key, slug: "top-ten", name: "Top Ten v2", type: "movie", visibility: "private", items: [{ id: "tt1" }] } }));
  rec("public.json after private", await call(env, "/lists/public.json"));
  rec("like a private list", await call(env, "/api/lists/like", { method: "POST", ip: "203.0.113.90", json: { username: "alice", slug: "top-ten" } }));
  rec("cross-account delete", await call(env, "/api/creator/lists/delete", { method: "POST", json: { creatorName: "bobby", creatorKey: v.creatorKey, slug: "top-ten" } }));
  rec("alice list survives", await call(env, "/api/creator/lists", { method: "POST", json: { creatorName: "alice", creatorKey: key } }));
  rec("rotate", await call(env, "/api/creator/reset-key", { method: "POST", json: { username: "alice", recoveryAnswer: "purple-mountains" } }));
  rec("old key after rotate", await call(env, "/api/creator/restore", { method: "POST", json: { creatorName: "alice", creatorKey: key } }));
  rec("delete account", await call(env, "/api/creator/delete-account", { method: "POST", json: { creatorName: "bobby", creatorKey: v.creatorKey, confirm: "DELETE" } }));
  rec("bobby after delete", await call(env, "/api/creator/restore", { method: "POST", json: { creatorName: "bobby", creatorKey: v.creatorKey } }));
  rec("reclaim bobby", await call(env, "/api/creator/create", { method: "POST", json: { creatorName: "bobby" } }));
  return out;
}
const a = await run("kv");
const b = await run("d1");
let diffs = 0;
for (let i = 0; i < Math.max(a.length, b.length); i++) {
  const [la, sa, ba] = a[i] || [];
  const [lb, sb, bb] = b[i] || [];
  // Normalise the values that legitimately differ run-to-run.
  const norm = (s) => String(s).replace(/"creatorKey":"[^"]+"/g, '"creatorKey":"K"')
    .replace(/\d{13}/g, "T").replace(/"version":"[0-9a-f]+"/g, '"version":"V"')
    .replace(/"createdAt":\d+/g, '"createdAt":T').replace(/"updatedAt":\d+/g, '"updatedAt":T');
  if (sa !== sb || norm(ba) !== norm(bb)) {
    diffs++;
    console.log(`\nDIFF @ "${la}"\n  KV-only : ${sa} ${norm(ba).slice(0, 500)}\n  KV+D1   : ${sb} ${norm(bb).slice(0, 500)}`);
  }
}
console.log(`\n${diffs} behavioural difference(s) between KV-only and KV+D1 across ${a.length} operations.`);

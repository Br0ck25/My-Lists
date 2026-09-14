// A list unpublished (or deleted) WHILE a multi-chunk index rebuild is in
// flight is re-published by that rebuild, because the rebuild carries a
// pre-change snapshot and overwrites the live index when it finishes.
import { makeKv, makeEnv, call, createUser, adminCookie } from "./kit.mjs";

const kv = makeKv();
const env = makeEnv({ CONFIGS: kv });
const alice = await createUser(env, "alice");
const K = { creatorName: "alice", creatorKey: alice.creatorKey };

// enough public lists that a rebuild needs more than one chunk
for (let i = 0; i < 900; i++) {
  const slug = "filler" + String(i).padStart(4, "0");
  kv._store.set(`creatorlist:alice:${slug}`, JSON.stringify({ name: "F" + i, slug, type: "movie", items: [], visibility: "public", likes: 0, createdAt: 1, updatedAt: 1 }));
}
await call(env, "/api/creator/lists/save", { method: "POST", json: { ...K, name: "Family Photos", type: "movie", visibility: "public", items: [{ id: "tt1" }] } });

const cookie = await adminCookie(env);
const inIndex = () => {
  const raw = kv._store.get("index:publiclists");
  if (!raw) return "(no index)";
  return JSON.parse(raw).entries.some(e => e.id === "c:alice:family-photos");
};

// 1. seed a complete index
let done = false, n = 0;
while (!done && n < 50) { done = (await call(env, "/admin/api/rebuild-public-index", { method: "POST", cookie })).body.done; n++; }
console.log("seeded index in", n, "chunks; family-photos indexed:", inIndex());

// 2. start a fresh rebuild and stop after the first chunk
kv._store.delete("index:publiclists:build");
const c1 = await call(env, "/admin/api/rebuild-public-index", { method: "POST", cookie });
console.log("rebuild chunk 1 -> done =", c1.body.done, "| build state parked:", !!kv._store.get("index:publiclists:build"));

// 3. mid-rebuild, the owner unpublishes through the real route
const r = await call(env, "/api/creator/lists/save", { method: "POST", json: { ...K, slug: "family-photos", name: "Family Photos", type: "movie", visibility: "private", items: [{ id: "tt1" }] } });
console.log("unpublish ->", r.status, r.body.ok, "| record visibility:", JSON.parse(kv._store.get("creatorlist:alice:family-photos")).visibility);
console.log("   directory right after unpublishing, indexed:", inIndex());
console.log("   /lists/alice/family-photos.json ->", (await call(env, "/lists/alice/family-photos.json")).status);

// 4. the in-flight rebuild finishes
done = c1.body.done; n = 0;
while (!done && n < 50) { done = (await call(env, "/admin/api/rebuild-public-index", { method: "POST", cookie })).body.done; n++; }
console.log("rebuild finished after", n, "more chunks");
console.log("   indexed again:", inIndex());
const dir = await call(env, "/lists/public.json?limit=500");
console.log("   /lists/public.json advertises it:", (dir.body.lists || []).some(l => l.slug === "family-photos"));
const search = await call(env, "/api/search-published-lists?q=family");
console.log("   search returns it:", JSON.stringify(search.body).slice(0, 200));

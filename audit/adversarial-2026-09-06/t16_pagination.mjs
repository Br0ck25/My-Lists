// PHASE 20/21 -- pagination + cap boundaries on the public index and directory.
import { makeKv, makeEnv, call, adminCookie } from "./kit.mjs";

async function build(n) {
  const kv = makeKv();
  for (let i = 0; i < n; i++) {
    const slug = "list" + String(i).padStart(5, "0");
    kv._store.set(`creatorlist:alice:${slug}`, JSON.stringify({
      name: "L" + i, slug, type: "movie", items: [{ id: "tt" + i }],
      visibility: "public", likes: i % 7, createdAt: 1, updatedAt: 1000 + i,
    }));
  }
  kv._store.set("creator:alice", JSON.stringify({ displayName: "Alice", keyHash: "pbkdf2:1:aa:bb", createdAt: 1 }));
  const env = makeEnv({ CONFIGS: kv });
  const cookie = await adminCookie(env);
  let done = false, chunks = 0;
  while (!done && chunks < 200) { done = (await call(env, "/admin/api/rebuild-public-index", { method: "POST", cookie })).body.done; chunks++; }
  return { env, chunks };
}

for (const n of [1, 399, 400, 401, 799, 800, 801, 1200]) {
  const { env, chunks } = await build(n);
  const idx = JSON.parse(env.CONFIGS._store.get("index:publiclists") || '{"entries":[]}');
  const ids = idx.entries.map(e => e.id);
  const uniq = new Set(ids);
  // page through the public API and check nothing is skipped or duplicated
  const seen = [];
  for (let off = 0; ; off += 500) {
    const r = await call(env, `/api/public-lists.json?offset=${off}&limit=500`);
    const page = r.body.lists || [];
    seen.push(...page.map(l => l.slug));
    if (page.length === 0 || off > n + 1000) break;
  }
  const seenUniq = new Set(seen);
  console.log(`n=${String(n).padEnd(5)} chunks=${String(chunks).padEnd(3)} index=${String(ids.length).padEnd(5)} dupes=${ids.length - uniq.size}  paged=${String(seen.length).padEnd(5)} pagedUnique=${String(seenUniq.size).padEnd(5)} complete=${seenUniq.size === n}`);
}

// records added and deleted DURING a multi-chunk traversal
console.log("");
console.log("=== mutation during a multi-chunk rebuild ===");
{
  const kv = makeKv();
  for (let i = 0; i < 1200; i++) {
    const slug = "list" + String(i).padStart(5, "0");
    kv._store.set(`creatorlist:alice:${slug}`, JSON.stringify({ name: "L" + i, slug, type: "movie", items: [], visibility: "public", likes: 0, createdAt: 1, updatedAt: 1 }));
  }
  kv._store.set("creator:alice", JSON.stringify({ displayName: "Alice", keyHash: "pbkdf2:1:aa:bb", createdAt: 1 }));
  const env = makeEnv({ CONFIGS: kv });
  const cookie = await adminCookie(env);
  let done = false, chunks = 0;
  while (!done && chunks < 200) {
    done = (await call(env, "/admin/api/rebuild-public-index", { method: "POST", cookie })).body.done;
    chunks++;
    if (chunks === 1) {
      // delete something already scanned and add something behind the cursor
      kv._store.delete("creatorlist:alice:list00000");
      kv._store.set("creatorlist:alice:list00001", JSON.stringify({ name: "MUTATED", slug: "list00001", type: "movie", items: [], visibility: "private", likes: 0, createdAt: 1, updatedAt: 1 }));
      kv._store.set("creatorlist:alice:aaa-new", JSON.stringify({ name: "ADDED-BEHIND-CURSOR", slug: "aaa-new", type: "movie", items: [], visibility: "public", likes: 0, createdAt: 1, updatedAt: 1 }));
    }
  }
  const idx = JSON.parse(kv._store.get("index:publiclists"));
  const ids = new Set(idx.entries.map(e => e.id));
  console.log("  chunks:", chunks, "index size:", ids.size);
  console.log("  deleted record still indexed:", ids.has("c:alice:list00000"));
  console.log("  now-private record still indexed:", ids.has("c:alice:list00001"));
  console.log("  record added behind the cursor indexed:", ids.has("c:alice:aaa-new"));
}

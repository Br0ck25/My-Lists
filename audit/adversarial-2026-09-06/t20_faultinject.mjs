// PHASE 5 -- partial-write fault injection. KV stays healthy and
// authoritative; D1 fails intermittently. KV must remain correct and the
// public API must never contradict it.
import { makeKv, makeRealD1, makeEnv, call, createUser } from "./kit.mjs";
function rng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }

async function run(seed, failRate, ops = 120) {
  const rand = rng(seed);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const DB = makeRealD1();
  DB.failWhen(() => rand() < failRate);
  const env = makeEnv({ CONFIGS: makeKv(), DB });
  const u = await createUser(env, "alice");
  const K = { creatorName: "alice", creatorKey: u.creatorKey };
  const model = new Map();
  const problems = [];
  let voterSeq = 0;

  const check = async (tag) => {
    for (const [slug, m] of model) {
      const raw = env.CONFIGS._store.get(`creatorlist:alice:${slug}`);
      if (!raw) { problems.push(`${tag}: KV record for ${slug} vanished`); continue; }
      const rec = JSON.parse(raw);
      if (rec.visibility !== m.visibility) problems.push(`${tag}: KV visibility ${slug} model=${m.visibility} kv=${rec.visibility}`);
      if ((rec.likes || 0) !== m.likes) problems.push(`${tag}: KV likes ${slug} model=${m.likes} kv=${rec.likes}`);
      const page = await call(env, `/lists/alice/${slug}.json?format=object`);
      if (m.visibility === "public" && page.status !== 200) problems.push(`${tag}: public ${slug} -> ${page.status}`);
      if (m.visibility === "private" && page.status === 200) problems.push(`${tag}: PRIVATE ${slug} served publicly`);
    }
    const dash = await call(env, "/api/creator/lists", { method: "POST", json: K });
    for (const l of dash.body.lists || []) {
      const m = model.get(l.slug);
      if (m && l.likes !== m.likes) problems.push(`${tag}: dashboard likes ${l.slug} model=${m.likes} api=${l.likes}`);
      if (m && l.visibility !== m.visibility) problems.push(`${tag}: dashboard visibility ${l.slug} model=${m.visibility} api=${l.visibility}`);
    }
  };

  for (let i = 0; i < ops && problems.length < 5; i++) {
    const op = pick(["create", "create", "edit", "visibility", "like", "delete"]);
    const slugs = [...model.keys()];
    if (op === "create") {
      const vis = rand() < 0.5 ? "public" : "private";
      const r = await call(env, "/api/creator/lists/save", { method: "POST", json: { ...K, name: pick(["Top Ten", "Weekend", "Classics"]), type: "movie", visibility: vis, items: [{ id: "tt1" }] } });
      if (r.body.ok) model.set(r.body.slug, { visibility: vis, likes: 0 });
    } else if (op === "edit" && slugs.length) {
      const slug = pick(slugs), m = model.get(slug);
      await call(env, "/api/creator/lists/save", { method: "POST", json: { ...K, slug, name: "N", type: "movie", visibility: m.visibility, items: [{ id: "tt1" }] } });
    } else if (op === "visibility" && slugs.length) {
      const slug = pick(slugs), m = model.get(slug);
      const vis = m.visibility === "public" ? "private" : "public";
      const r = await call(env, "/api/creator/lists/save", { method: "POST", json: { ...K, slug, name: "N", type: "movie", visibility: vis, items: [{ id: "tt1" }] } });
      if (r.body.ok) m.visibility = vis;
    } else if (op === "like" && slugs.length) {
      const slug = pick(slugs), m = model.get(slug);
      const r = await call(env, "/api/lists/like", { method: "POST", ip: `203.0.${(voterSeq >> 8) & 255}.${(voterSeq++ % 254) + 1}`, json: { username: "alice", slug } });
      if (r.body.ok) m.likes = r.body.likes;
    } else if (op === "delete" && slugs.length) {
      const slug = pick(slugs);
      const r = await call(env, "/api/creator/lists/delete", { method: "POST", json: { ...K, slug } });
      if (r.body.ok) model.delete(slug);
    }
    await check(`op#${i} ${op}`);
  }
  return problems;
}

for (const failRate of [0.15, 0.4]) {
  for (const seed of [3, 11, 2024]) {
    const p = await run(seed, failRate);
    console.log(`D1 failure rate ${failRate}  seed=${String(seed).padEnd(5)} ${p.length ? "DIVERGED" : "consistent"}  ${p.slice(0, 3).join(" | ")}`);
  }
}

// Targeted: D1 succeeds, the KV write that follows it fails.
console.log("");
console.log("=== KV put fails AFTER the D1 upsert succeeded (lists/save) ===");
{
  const DB = makeRealD1();
  const env = makeEnv({ CONFIGS: makeKv(), DB });
  const u = await createUser(env, "alice");
  const K = { creatorName: "alice", creatorKey: u.creatorKey };
  await call(env, "/api/creator/lists/save", { method: "POST", json: { ...K, name: "Doc", type: "movie", visibility: "private", items: [{ id: "tt1" }] } });
  env.CONFIGS._hooks.beforePut = async (k) => { if (k === "creatorlist:alice:doc") throw new Error("KV write failed"); };
  let status = "no throw";
  try {
    const r = await call(env, "/api/creator/lists/save", { method: "POST", json: { ...K, slug: "doc", name: "Doc", type: "movie", visibility: "public", items: [{ id: "tt1" }, { id: "tt2" }] } });
    status = `${r.status} ${JSON.stringify(r.body)}`;
  } catch (e) { status = "threw: " + e.message; }
  env.CONFIGS._hooks.beforePut = null;
  console.log("  response:", status);
  console.log("  KV says :", env.CONFIGS._store.get("creatorlist:alice:doc"));
  console.log("  D1 says :", JSON.stringify(DB.q("SELECT visibility, items_json FROM creator_lists WHERE id='alice:doc'")));
  console.log("  /lists/alice/doc.json ->", (await call(env, "/lists/alice/doc.json")).status, "(KV is what this reads)");
  const dash = await call(env, "/api/creator/lists", { method: "POST", json: K });
  console.log("  dashboard (reads D1 first) ->", JSON.stringify((dash.body.lists || []).map(l => ({ slug: l.slug, vis: l.visibility, n: l.itemCount }))));
}

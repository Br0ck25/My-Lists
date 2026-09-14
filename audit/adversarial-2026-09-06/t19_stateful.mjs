// PHASE 35 -- randomized stateful test against an independent expected model.
// Each seed runs a few hundred operations and, after every one, compares the
// model against KV, D1 and the public API.
import { makeKv, makeRealD1, makeEnv, call, createUser } from "./kit.mjs";

function rng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }

async function runSeed(seed, ops = 250, withD1 = true) {
  const rand = rng(seed);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const DB = withD1 ? makeRealD1() : undefined;
  const env = makeEnv({ CONFIGS: makeKv(), DB });
  const u = await createUser(env, "alice");
  let key = u.creatorKey;
  const K = () => ({ creatorName: "alice", creatorKey: key });

  // model: slug -> { name, type, visibility, itemCount, likes:Set(voter) }
  const model = new Map();
  const problems = [];
  let voterSeq = 0;

  const check = async (afterOp) => {
    // 1. every model list must be readable with the right visibility
    for (const [slug, m] of model) {
      const raw = env.CONFIGS._store.get(`creatorlist:alice:${slug}`);
      if (!raw) { problems.push(`${afterOp}: KV record missing for ${slug}`); continue; }
      const rec = JSON.parse(raw);
      if (rec.visibility !== m.visibility) problems.push(`${afterOp}: ${slug} visibility model=${m.visibility} kv=${rec.visibility}`);
      if ((rec.items || []).length !== m.itemCount) problems.push(`${afterOp}: ${slug} itemCount model=${m.itemCount} kv=${(rec.items || []).length}`);
      if ((rec.likes || 0) !== m.likes.size) problems.push(`${afterOp}: ${slug} likes model=${m.likes.size} kv=${rec.likes || 0}`);
      const page = await call(env, `/lists/alice/${slug}.json?format=object`);
      const shouldBeVisible = m.visibility === "public";
      if (shouldBeVisible && page.status !== 200) problems.push(`${afterOp}: public ${slug} returned ${page.status}`);
      if (!shouldBeVisible && page.status === 200) problems.push(`${afterOp}: PRIVATE ${slug} was served publicly`);
    }
    // 2. nothing outside the model may be publicly reachable
    const dir = await call(env, "/lists/public.json?limit=500");
    for (const l of dir.body.lists || []) {
      const m = model.get(l.slug);
      if (!m) problems.push(`${afterOp}: directory advertises unknown list ${l.slug}`);
      else if (m.visibility !== "public") problems.push(`${afterOp}: directory advertises PRIVATE list ${l.slug}`);
      else if (l.likes !== m.likes.size) problems.push(`${afterOp}: directory likes ${l.slug} model=${m.likes.size} api=${l.likes}`);
    }
    // 3. the dashboard must show exactly the model's lists
    const dash = await call(env, "/api/creator/lists", { method: "POST", json: K() });
    const shown = new Set((dash.body.lists || []).map((l) => l.slug));
    for (const slug of model.keys()) if (!shown.has(slug)) problems.push(`${afterOp}: dashboard is missing ${slug}`);
    for (const s of shown) if (!model.has(s)) problems.push(`${afterOp}: dashboard shows unknown ${s}`);
    for (const l of dash.body.lists || []) {
      const m = model.get(l.slug);
      if (m && l.likes !== m.likes.size) problems.push(`${afterOp}: dashboard likes ${l.slug} model=${m.likes.size} api=${l.likes}`);
    }
    // 4. D1 must never disagree with KV about a row it holds
    if (DB) {
      for (const row of DB.q("SELECT id, visibility, likes, items_json FROM creator_lists")) {
        const slug = row.id.split(":").slice(1).join(":");
        const m = model.get(slug);
        if (!m) { problems.push(`${afterOp}: D1 holds a row for a list that should not exist: ${row.id}`); continue; }
        if (row.visibility !== m.visibility) problems.push(`${afterOp}: D1 visibility ${slug} model=${m.visibility} d1=${row.visibility}`);
        if (row.likes !== m.likes.size) problems.push(`${afterOp}: D1 likes ${slug} model=${m.likes.size} d1=${row.likes}`);
      }
    }
  };

  const names = ["Top Ten", "Weekend", "Classics", "Anime", "Kids"];
  for (let i = 0; i < ops && problems.length < 6; i++) {
    const op = pick(["create", "create", "edit", "visibility", "like", "unlike", "delete", "reorder", "rotate"]);
    const slugs = [...model.keys()];
    if (op === "create") {
      const name = pick(names);
      const vis = rand() < 0.5 ? "public" : "private";
      const items = Math.floor(rand() * 4);
      const r = await call(env, "/api/creator/lists/save", { method: "POST", json: { ...K(), name, type: "movie", visibility: vis, items: Array.from({ length: items }, (_, j) => ({ id: "tt" + j })) } });
      if (r.body.ok) model.set(r.body.slug, { name, visibility: vis, itemCount: items, likes: new Set() });
      else problems.push(`create failed: ${JSON.stringify(r.body)}`);
    } else if (op === "edit" && slugs.length) {
      const slug = pick(slugs); const m = model.get(slug);
      const items = Math.floor(rand() * 5);
      const r = await call(env, "/api/creator/lists/save", { method: "POST", json: { ...K(), slug, name: m.name, type: "movie", visibility: m.visibility, items: Array.from({ length: items }, (_, j) => ({ id: "tt" + j })) } });
      if (r.body.ok) m.itemCount = items;
    } else if (op === "visibility" && slugs.length) {
      const slug = pick(slugs); const m = model.get(slug);
      const vis = m.visibility === "public" ? "private" : "public";
      const r = await call(env, "/api/creator/lists/save", { method: "POST", json: { ...K(), slug, name: m.name, type: "movie", visibility: vis, items: Array.from({ length: m.itemCount }, (_, j) => ({ id: "tt" + j })) } });
      if (r.body.ok) m.visibility = vis;
    } else if ((op === "like" || op === "unlike") && slugs.length) {
      const slug = pick(slugs); const m = model.get(slug);
      const voter = op === "like" ? `203.0.${(voterSeq >> 8) & 255}.${(voterSeq++ % 254) + 1}` : (m.likes.size ? [...m.likes][0] : null);
      if (!voter) continue;
      const r = await call(env, "/api/lists/like", { method: "POST", ip: voter, json: { username: "alice", slug, action: op === "unlike" ? "unlike" : "like" } });
      if (r.body.ok) { if (op === "like") m.likes.add(voter); else m.likes.delete(voter); }
    } else if (op === "delete" && slugs.length) {
      const slug = pick(slugs);
      const r = await call(env, "/api/creator/lists/delete", { method: "POST", json: { ...K(), slug } });
      if (r.body.ok) model.delete(slug);
    } else if (op === "reorder" && slugs.length) {
      await call(env, "/api/creator/lists/reorder", { method: "POST", json: { ...K(), order: slugs.slice().reverse() } });
    } else if (op === "rotate") {
      // rotate through the admin path, which needs no recovery answer
      const r = await call(env, "/admin/api/reset-creator-key", { method: "POST", json: { username: "alice" }, cookie: globalThis.__adm });
      if (r.body && r.body.ok) key = r.body.creatorKey;
    }
    await check(`op#${i} ${op}`);
  }
  return problems;
}

// admin cookie for the rotate op
{
  const { adminCookie } = await import("./kit.mjs");
  const e = makeEnv({ CONFIGS: makeKv() });
  globalThis.__adm = await adminCookie(e);
}

for (const withD1 of [false, true]) {
  for (const seed of [1, 7, 42, 1337, 99991]) {
    const problems = await runSeed(seed, 120, withD1);
    console.log(`${withD1 ? "KV+D1  " : "KV-only"} seed=${String(seed).padEnd(6)} ${problems.length ? "FAIL" : "ok  "}  ${problems.slice(0, 4).join(" | ")}`);
  }
}

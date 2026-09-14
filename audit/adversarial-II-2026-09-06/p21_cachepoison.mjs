// Phase 24/15: does an empty-but-successful upstream response overwrite a good
// cached chart?
//
// The first version of this probe was INCONCLUSIVE and §11.1 records it that
// way. It ran the cron twice in one process and compared the cached chart
// before and after. Two things made that unable to answer anything:
//
//   1. the canned upstream body did not survive the chart normaliser, so the
//      "healthy" prewarm cached `{"data":[]}` and there was never a good value
//      for the empty reply to destroy;
//   2. even with a good value, the second tick made ZERO upstream calls -- the
//      first tick's result was still fresh in KV, and still sitting in this
//      isolate's in-memory chart memo (PER_USER_CACHE_MAP). "The cache was not
//      damaged" and "nothing ran" look identical from the outside.
//
// Point 2 is the one worth remembering: any probe that drives the cron more
// than once in a single process is measuring an isolate that has already
// answered that question from memory. This version arranges both halves --
// every KV copy made stale, and the second tick run on a genuinely separate
// module instance -- and asserts the upstream was really called.
import { makeKv, worker, freshIsolate } from "../../tests/harness.mjs";
const realFetch = globalThis.fetch;
const kv = makeKv();
const env = { CONFIGS: kv, TMDB_API_KEY: "k", TRAKT_CLIENT_ID: "t", SIMKL_CLIENT_ID: "s", MDBLIST_API_KEY: "m" };
// A Trakt chart body, because that one does normalise into real items.
const good = JSON.stringify([
  { movie: { title: "Real Movie", year: 2020, ids: { imdb: "tt0000001", trakt: 1, tmdb: 11 } } },
  { movie: { title: "Second", year: 2021, ids: { imdb: "tt0000002", trakt: 2, tmdb: 12 } } },
]);
const isEmpty = (raw) => /"data":(\[\]|\{\})/.test(String(raw));

let fetches = 0;
async function tick(w, body) {
  globalThis.fetch = async () => { fetches++; return new Response(body, { status: 200, headers: { "content-type": "application/json" } }); };
  const pending = [];
  const ctx = { waitUntil(p) { pending.push(Promise.resolve(p).catch(() => {})); } };
  await w.scheduled({ cron: "x" }, env, ctx);
  await Promise.all(pending);
}

await tick(worker, good);
const good_ = [...kv._store.keys()].filter((k) => k.startsWith("cache:") && !isEmpty(kv._store.get(k)));
console.log(`after a HEALTHY prewarm: ${good_.length} cache keys hold real items`);
console.log("  e.g.", good_[0], "->", String(kv._store.get(good_[0])).slice(0, 90));

for (const k of [...kv._store.keys()].filter((x) => x.startsWith("cache:"))) {
  try { const v = JSON.parse(String(kv._store.get(k))); v.freshUntil = Date.now() - 1; kv._store.set(k, JSON.stringify(v)); }
  catch { /* not a cache record */ }
}
const cold = await freshIsolate();
fetches = 0;
await tick(cold, "[]");
console.log(`\nEMPTY-200 tick on a cold isolate: ${fetches} upstream calls made`);
if (!fetches) console.log("  INCONCLUSIVE - nothing was fetched, so nothing could have been overwritten");

const emptied = good_.filter((k) => isEmpty(kv._store.get(k)));
console.log(`${good_.length - emptied.length}/${good_.length} good cache entries kept their contents`);
if (emptied.length) console.log("  emptied:", JSON.stringify(emptied.slice(0, 8)));
console.log(!fetches ? "INCONCLUSIVE"
  : (emptied.length
    ? `FAIL - ${emptied.length} good cached chart(s) were replaced by an empty upstream reply`
    : "PASS - no good cached chart was replaced by an empty upstream reply"));

globalThis.fetch = realFetch;

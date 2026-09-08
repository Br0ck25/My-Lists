// Count OUTBOUND fetch() subrequests per invocation (free plan cap = 50).
import { makeEnv, makeKv, makeD1, call, createUser, worker } from "../../tests/harness.mjs";

const real = globalThis.fetch;
let n = 0, hosts = new Map();
globalThis.fetch = async (u, init) => {
  n++;
  const s = typeof u === "string" ? u : (u && u.url) || "";
  try { const h = new URL(s).host; hosts.set(h, (hosts.get(h) || 0) + 1); } catch {}
  // Plausible provider answers so the code keeps going rather than bailing early.
  const body = JSON.stringify({
    results: Array.from({ length: 20 }, (_, i) => ({ id: 1000 + i, title: "T" + i, name: "T" + i, media_type: "movie", poster_path: "/p.jpg", release_date: "2024-01-01", external_ids: { imdb_id: "tt" + (1000 + i) } })),
    movie_results: [{ id: 1, title: "T" }], tv_results: [],
    total_pages: 5, total_results: 100,
    id: 1, name: "N", title: "T", imdb_id: "tt0000001", seasons: [{ season_number: 1, episode_count: 3 }],
    episodes: [{ id: 9, name: "E", season_number: 1, episode_number: 1, air_date: "2024-01-01" }],
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
};

async function count(label, fn) {
  n = 0; hosts = new Map();
  try { await fn(); } catch (e) { console.log("   (threw:", String(e.message).slice(0, 60) + ")"); }
  const top = [...hosts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,3).map(([h,c]) => `${h}x${c}`).join(" ");
  const flag = n > 50 ? "  <== OVER the 50 free-plan cap" : "";
  console.log(`${label.padEnd(48)} fetch()=${String(n).padStart(4)}  ${top}${flag}`);
}

const mkEnv = () => { const e = makeEnv({ CONFIGS: makeKv(), DB: makeD1() }); e.TMDB_API_KEY = "k"; e.TRAKT_CLIENT_ID = "k"; e.MDBLIST_API_KEY = "k"; e.SIMKL_CLIENT_ID = "k"; return e; };

await count("POST /api/bulk-resolve (200 titles, the max)", async () => {
  const env = mkEnv();
  await call(env, "/api/bulk-resolve", { method: "POST", json: { items: Array.from({length:200},(_,i)=>({title:"Movie "+i, year: 2000+i%20})) } });
});
await count("POST /api/bulk-resolve (20 titles)", async () => {
  const env = mkEnv();
  await call(env, "/api/bulk-resolve", { method: "POST", json: { items: Array.from({length:20},(_,i)=>({title:"Movie "+i, year: 2010})) } });
});
await count("POST /api/details/batch (100 ids)", async () => {
  const env = mkEnv();
  await call(env, "/api/details/batch", { method: "POST", json: { ids: Array.from({length:100},(_,i)=>"tt"+(1000000+i)) } });
});
await count("POST /api/recommendations", async () => {
  const env = mkEnv();
  await call(env, "/api/recommendations", { method: "POST", json: { watchHistory: Array.from({length:40},(_,i)=>({id:"tt"+i,title:"T"+i,type:"movie"})) } });
});
await count("GET /api/quick-channel-shows?network=213", async () => {
  const env = mkEnv();
  await call(env, "/api/quick-channel-shows?network=213&type=series");
});
await count("GET /api/title-search?q=matrix", async () => {
  const env = mkEnv();
  await call(env, "/api/title-search?q=matrix");
});
await count("cron scheduled() tick", async () => {
  const env = mkEnv();
  for (let i = 0; i < 30; i++) env.CONFIGS._store.set(`creator:u${i}`, JSON.stringify({ keyHash: "x" }));
  for (let i = 0; i < 30; i++) env.CONFIGS._store.set(`creatorsynctracking:u${i}`, JSON.stringify({ continueWatching: Array.from({length:10},(_,j)=>({showId:String(j), showTitle:"S"+j, tmdbId: 100+j, seasonNum:1, episodeNum:1 })), watchHistory: [] }));
  const pending = [];
  await worker.scheduled({}, env, { waitUntil: (p) => pending.push(Promise.resolve(p).catch(()=>{})) });
  await Promise.all(pending);
});
globalThis.fetch = real;

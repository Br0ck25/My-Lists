// Live HTTP server in front of the real Worker, with in-memory KV + real SQLite D1.
// Upstream (TMDB/Trakt/MDBList/Simkl) fetches are stubbed so the UI gets
// deterministic data and the page never needs the network.
import http from "node:http";
import { makeKv, makeD1, makeEnv } from "../../tests/harness.mjs";

const REAL_FETCH = globalThis.fetch;
const upstreamLog = [];

function jsonRes(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

function stubUpstream(url) {
  const u = String(url);
  upstreamLog.push(u);
  // TMDB
  if (u.includes("api.themoviedb.org")) {
    if (u.includes("/search/")) {
      return jsonRes({ results: [
        { id: 550, title: "Fight Club", name: "Fight Club", release_date: "1999-10-15", first_air_date: "1999-10-15", poster_path: "/p.jpg", overview: "o", vote_average: 8.4, media_type: u.includes("/tv") ? "tv" : "movie" },
        { id: 551, title: "<img src=x onerror=alert(1)>", name: "<img src=x onerror=alert(1)>", release_date: "2001-01-01", first_air_date: "2001-01-01", poster_path: "/q.jpg", overview: "<script>alert(2)</script>", vote_average: 5, media_type: u.includes("/tv") ? "tv" : "movie" },
      ], total_results: 2, total_pages: 1, page: 1 });
    }
    if (u.includes("/external_ids")) return jsonRes({ imdb_id: "tt0137523", id: 550 });
    if (u.includes("/find/")) return jsonRes({ movie_results: [{ id: 550, title: "Fight Club", poster_path: "/p.jpg" }], tv_results: [] });
    if (/\/tv\/\d+\/season\/\d+/.test(u)) return jsonRes({ episodes: [{ id: 1, episode_number: 1, season_number: 1, name: "Ep1", still_path: "/s.jpg", air_date: "2020-01-01", overview: "" }] });
    if (/\/tv\/\d+$/.test(u.split("?")[0])) return jsonRes({ id: 1399, name: "Test Show", seasons: [{ season_number: 1, episode_count: 10, name: "Season 1" }], external_ids: { imdb_id: "tt0944947" }, poster_path: "/p.jpg", overview: "", first_air_date: "2011-04-17" });
    if (/\/movie\/\d+$/.test(u.split("?")[0])) return jsonRes({ id: 550, title: "Fight Club", imdb_id: "tt0137523", poster_path: "/p.jpg", overview: "", release_date: "1999-10-15", external_ids: { imdb_id: "tt0137523" } });
    if (u.includes("/discover/") || u.includes("/trending/") || u.includes("/list/")) {
      return jsonRes({ results: [{ id: 550, title: "Fight Club", name: "Fight Club", poster_path: "/p.jpg", release_date: "1999-10-15", first_air_date: "1999-10-15", overview: "", vote_average: 8.4 }], items: [{ id: 550, title: "Fight Club", media_type: "movie", poster_path: "/p.jpg" }], total_pages: 1, page: 1, total_results: 1, name: "TMDB List", description: "d" });
    }
    return jsonRes({ results: [], items: [], total_pages: 1, page: 1 });
  }
  // Trakt
  if (u.includes("api.trakt.tv")) {
    if (u.includes("/lists")) return jsonRes([{ ids: { trakt: 1, slug: "my-list" }, name: "My Trakt List", item_count: 5, privacy: "public", user: { ids: { slug: "someone" } }, description: "d" }]);
    if (u.includes("/items")) return jsonRes([{ type: "movie", movie: { title: "Fight Club", year: 1999, ids: { imdb: "tt0137523", tmdb: 550, trakt: 1 } } }]);
    if (u.includes("/search")) return jsonRes([{ type: "list", list: { ids: { trakt: 1, slug: "s" }, name: "Found list", user: { ids: { slug: "u" } }, item_count: 3 } }]);
    if (u.includes("/oauth/device/code")) return jsonRes({ device_code: "dc", user_code: "ABCD1234", verification_url: "https://trakt.tv/activate", expires_in: 600, interval: 5 });
    if (u.includes("/oauth/device/token")) return jsonRes({ error: "authorization_pending" }, 400);
    return jsonRes([]);
  }
  // MDBList
  if (u.includes("mdblist.com")) {
    if (u.includes("/toplists")) return new Response("<html><body><a href='/lists/user/top-list'>Top List</a></body></html>", { headers: { "content-type": "text/html" } });
    if (u.includes("/lists/")) return jsonRes([{ id: 1, name: "MDB List", slug: "mdb-list", items: 10, user_name: "u", description: "d" }]);
    if (u.includes("/items")) return jsonRes({ movies: [{ imdb_id: "tt0137523", title: "Fight Club", release_year: 1999 }], shows: [] });
    return jsonRes([]);
  }
  // Simkl
  if (u.includes("simkl.com")) return jsonRes([]);
  // images
  if (u.includes("image.tmdb.org")) return new Response(Buffer.alloc(70), { headers: { "content-type": "image/jpeg" } });
  return jsonRes({ ok: true, stubbed: true, url: u });
}

globalThis.fetch = async (input, init) => {
  const url = String(input && input.url ? input.url : input);
  if (/^https?:\/\/(127\.0\.0\.1|localhost)/.test(url)) return REAL_FETCH(input, init);
  try { return stubUpstream(url); } catch (e) { return jsonRes({ error: String(e) }, 500); }
};

const { worker } = await import("../../tests/harness.mjs");

const kv = makeKv();
const d1 = makeD1();
const env = makeEnv({ CONFIGS: kv, DB: d1 });
env.TMDB_API_KEY = "tmdbkey";
env.TRAKT_CLIENT_ID = "traktid";
env.MDBLIST_API_KEY = "mdbkey";

let ipN = 0;
function nextIp() { ipN++; return `198.51.${(ipN >> 8) & 255}.${ipN & 255}`; }

// --- fault injection control plane ---
const faults = []; // {match, status, body, delayMs, drop, times}
function applyFault(pathname) {
  for (const f of faults) {
    if (!new RegExp(f.match).test(pathname)) continue;
    if (f.times !== undefined) { if (f.times <= 0) continue; f.times--; }
    return f;
  }
  return null;
}

const PORT = Number(process.env.PORT || 8787);
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v !== undefined) headers.set(k, v);
  }
  headers.set("CF-Connecting-IP", nextIp());
  const url = "http://127.0.0.1:" + PORT + req.url;
  const request = new Request(url, {
    method: req.method,
    headers,
    body: body && req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
  });
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => {})) };
  const pathOnly = req.url.split("?")[0];
  if (pathOnly === "/__ctl") {
    const cfg = body ? JSON.parse(body.toString()) : {};
    if (cfg.reset) faults.length = 0;
    if (cfg.faults) faults.push(...cfg.faults);
    res.statusCode = 200; res.setHeader("content-type","application/json");
    return res.end(JSON.stringify({ ok: true, faults }));
  }
  const f = applyFault(req.url);
  if (f) {
    if (f.delayMs) await new Promise(r => setTimeout(r, f.delayMs));
    if (f.drop) { req.socket.destroy(); return; }
    if (f.status || f.body !== undefined) {
      res.statusCode = f.status || 200;
      res.setHeader("content-type", f.contentType || "application/json");
      return res.end(f.body === undefined ? JSON.stringify({ error: "injected" }) : f.body);
    }
  }
  try {
    const out = await worker.fetch(request, env, ctx);
    await Promise.all(pending);
    res.statusCode = out.status;
    out.headers.forEach((v, k) => { if (k !== "content-encoding") res.setHeader(k, v); });
    const buf = Buffer.from(await out.arrayBuffer());
    res.end(buf);
  } catch (e) {
    console.error("WORKER THREW", req.method, req.url, e && e.stack);
    res.statusCode = 500;
    res.end("worker threw: " + (e && e.message));
  }
});
server.listen(PORT, "127.0.0.1", () => console.log("listening on http://127.0.0.1:" + PORT));

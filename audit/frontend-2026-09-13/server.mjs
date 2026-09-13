// Runs the REAL Worker over HTTP with SQLite-backed D1 + in-memory KV,
// so a real browser can drive the real frontend.
import http from "node:http";
import { makeKv, makeD1, makeEnv } from "../../tests/harness.mjs";

const worker = (await import(new URL("../../worker_entry_combined.js", import.meta.url).href)).default;

const kv = makeKv();
const db = makeD1();
const env = makeEnv({ CONFIGS: kv, DB: db, ADMIN_KEY: "test-admin-secret" });
globalThis.__env = env;

// Log every outbound fetch the worker attempts (upstream providers) and stub it.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const u = typeof input === "string" ? input : (input && input.url) || String(input);
  if (u.startsWith("http://127.0.0.1") || u.startsWith("http://localhost")) return realFetch(input, init);
  UPSTREAM.push(u);
  // Generic inert JSON so catalog code paths don't explode.
  return new Response(JSON.stringify({ results: [], items: [], data: [] }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
};
const UPSTREAM = [];

const REQS = [];
const server = http.createServer(async (req, res) => {
  const url = "http://127.0.0.1:8787" + req.url;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v !== undefined) headers.set(k, v);
  }
  if (!headers.has("cf-connecting-ip")) headers.set("cf-connecting-ip", "198.51.100.7");
  const request = new Request(url, {
    method: req.method,
    headers,
    body: body && req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
  });
  const ctx = { waitUntil: (p) => { Promise.resolve(p).catch(() => {}); }, passThroughOnException() {} };
  let resp;
  try {
    resp = await worker.fetch(request, env, ctx);
  } catch (e) {
    REQS.push({ m: req.method, u: req.url, s: "THROW", err: String(e && e.stack || e) });
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("worker threw: " + (e && e.stack || e));
    return;
  }
  REQS.push({ m: req.method, u: req.url, s: resp.status });
  const out = Buffer.from(await resp.arrayBuffer());
  const h = {};
  resp.headers.forEach((v, k) => { h[k] = v; });
  res.writeHead(resp.status, h);
  res.end(out);
});

server.listen(8787, "127.0.0.1", () => console.log("LIVE on http://127.0.0.1:8787"));

// Control channel for the test driver.
http.createServer(async (req, res) => {
  if (req.url === "/reqs") { res.end(JSON.stringify(REQS)); return; }
  if (req.url === "/reqs/clear") { REQS.length = 0; res.end("ok"); return; }
  if (req.url === "/upstream") { res.end(JSON.stringify(UPSTREAM)); return; }
  if (req.url.startsWith("/sql?")) {
    const q = decodeURIComponent(req.url.slice(5));
    try { res.end(JSON.stringify(db.q(q))); } catch (e) { res.end(JSON.stringify({ err: String(e) })); }
    return;
  }
  if (req.url === "/kv") { res.end(JSON.stringify([...kv._store.keys()])); return; }
  res.end("?");
}).listen(8788, "127.0.0.1");

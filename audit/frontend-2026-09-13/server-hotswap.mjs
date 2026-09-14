// Same worker harness, but can hot-swap between "deploy v1" and "deploy v2"
// on the SAME origin so service-worker update behaviour can be tested.
import http from "node:http";
import { makeKv, makeD1, makeEnv } from "../../tests/harness.mjs";
const v1 = (await import(new URL("../../worker_entry_combined.js?d=1", import.meta.url).href)).default;
const v2 = (await import(new URL("worker_v2.js", import.meta.url).href)).default;
let active = v1, label = "v1";
const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1(), ADMIN_KEY: "k" });
const realFetch = globalThis.fetch;
globalThis.fetch = async (i, init) => {
  const u = typeof i === "string" ? i : (i && i.url) || String(i);
  if (u.startsWith("http://127.0.0.1")) return realFetch(i, init);
  return new Response(JSON.stringify({ results: [], items: [], data: [] }), { status:200, headers:{ "Content-Type":"application/json" } });
};
http.createServer(async (req, res) => {
  if (req.url === "/__deploy/v2") { active = v2; label = "v2"; res.end("now v2"); return; }
  if (req.url === "/__deploy/v1") { active = v1; label = "v1"; res.end("now v1"); return; }
  if (req.url === "/__deploy/which") { res.end(label); return; }
  const chunks=[]; for await (const c of req) chunks.push(c);
  const headers = new Headers();
  for (const [k,v] of Object.entries(req.headers)) if (v!==undefined) headers.set(k, Array.isArray(v)?v.join(","):v);
  if (!headers.has("cf-connecting-ip")) headers.set("cf-connecting-ip","198.51.100.9");
  const request = new Request("http://127.0.0.1:8790"+req.url, { method:req.method, headers, body: chunks.length&&req.method!=="GET"&&req.method!=="HEAD"?Buffer.concat(chunks):undefined });
  const ctx = { waitUntil:(p)=>{Promise.resolve(p).catch(()=>{})}, passThroughOnException(){} };
  let r; try { r = await active.fetch(request, env, ctx); } catch(e){ res.writeHead(500); res.end(String(e)); return; }
  const h={}; r.headers.forEach((v,k)=>{h[k]=v;});
  res.writeHead(r.status,h); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(8790,"127.0.0.1",()=>console.log("hot-swap server on 8790"));

// The attribute half of the fix: a payload in an install link's tmdbKey used to
// end value="..." and inject its own event handler. Driven in real Chromium.
import http from "node:http";
import { chromium } from "playwright";
import { makeEnv, makeKv, makeD1, worker } from "../../tests/harness.mjs";

const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
const ctx = { waitUntil: (p) => { Promise.resolve(p).catch(() => {}); } };
const server = http.createServer(async (req, res) => {
  const url = "http://127.0.0.1:" + server.address().port + req.url;
  const chunks = []; for await (const c of req) chunks.push(c);
  const init = { method: req.method, headers: req.headers };
  if (chunks.length) init.body = Buffer.concat(chunks);
  const out = await worker.fetch(new Request(url, init), env, ctx);
  const body = Buffer.from(await out.arrayBuffer());
  const h = {}; out.headers.forEach((v, k) => { h[k] = v; });
  res.writeHead(out.status, h); res.end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + server.address().port;

const cfg = Buffer.from(JSON.stringify({
  entries: [{ id: "a", name: "Popular", url: "tmdb:chart:popular", type: "movie", enabled: true }],
  tmdbKey: 'x" autofocus onfocus="window.__ATTRXSS=1;document.title=\'PWNED3\'',
}), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
const p = await b.newPage();
await p.goto(`${base}/${cfg}/configure`, { waitUntil: "domcontentloaded" });
await p.waitForTimeout(300);
console.log("attribute-injected handler ran:", await p.evaluate(() => window.__ATTRXSS === 1));
console.log("document.title                :", await p.title());
console.log("the key still round-trips     :", JSON.stringify(await p.evaluate(() => {
  const el = document.getElementById("tmdbKeyInput"); return el ? el.value : null; })));
await b.close(); server.close();

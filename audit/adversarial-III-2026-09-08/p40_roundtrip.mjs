// The escaping must be invisible to everything downstream: < is a valid
// escape in both grammars this output has to satisfy (JSON for the ld+json
// blocks, JavaScript source for the rest), so every parsed value must come
// back byte-identical. This is the regression risk of the fix.
import http from "node:http";
import { chromium } from "playwright";
import { makeEnv, makeKv, makeD1, worker, call, createUser } from "../../tests/harness.mjs";

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

// Real-world names that contain the characters the fix now escapes, plus the
// two line separators that used to be a SyntaxError in JS source.
const NAME = 'Sci-Fi <3 & "Classics" — 2000s   top 10 > 8.0 ❤️ 日本語';
const ITEM = 'A Movie: Part <II> & "The Sequel"';
const pub = await (await fetch(base + "/api/publish-list", {
  method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" },
  body: JSON.stringify({ name: NAME, type: "movie", visibility: "public",
                         items: [{ id: "tt0111161", title: ITEM }] }),
})).json();

const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
const p = await b.newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e).slice(0, 90)));
await p.goto(base + "/lists/user/" + pub.listName, { waitUntil: "domcontentloaded" });

const got = await p.evaluate(() => ({
  name: SERVER_DEEP_LINK_LIST && SERVER_DEEP_LINK_LIST.name,
  item: SERVER_DEEP_LINK_LIST && SERVER_DEEP_LINK_LIST.sample[0].name,
  entriesIsArray: Array.isArray(serverEntries),
  chartsLoaded: typeof CHART_SLUG_ENTRIES !== "undefined" && CHART_SLUG_ENTRIES.length > 0,
  ldJson: (() => { try { return !!JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent).name; } catch (e) { return "PARSE FAILED: " + e.message; } })(),
}));
console.log("list name round-trips exactly :", got.name === NAME);
console.log("item title round-trips exactly:", got.item === ITEM);
console.log("serverEntries still an array  :", got.entriesIsArray);
console.log("chart tables still populated  :", got.chartsLoaded);
console.log("ld+json still parses as JSON  :", got.ldJson);
console.log("page errors                   :", errs);
if (got.name !== NAME) { console.log("  expected:", JSON.stringify(NAME)); console.log("  got     :", JSON.stringify(got.name)); }
await b.close(); server.close();

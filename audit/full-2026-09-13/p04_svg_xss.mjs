import { makeEnv, makeKv, makeD1, call } from "../../tests/harness.mjs";
const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
const probes = [
  "/api/channel-poster?name=" + encodeURIComponent('</text><script>alert(1)</script>'),
  "/api/channel-poster?format=landscape&name=" + encodeURIComponent('"><script>alert(1)</script>'),
  "/api/channel-poster?name=x&bg=" + encodeURIComponent('http://x"><script>alert(1)</script>'),
  "/api/channel-logo?path=" + encodeURIComponent('../../../etc/passwd'),
  "/api/channel-logo?path=" + encodeURIComponent('/a.png"></image><script>alert(1)</script><image href="'),
];
for (const p of probes) {
  const r = await call(env, p);
  const t = String(r.text || "");
  console.log(p.slice(0, 80).padEnd(82), r.status,
    "csp=", (r.headers.get("content-security-policy")||"").slice(0,24),
    "ct=", r.headers.get("content-type"),
    "|| <script> present:", t.includes("<script"), "|| len", t.length);
}

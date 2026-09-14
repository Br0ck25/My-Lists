import { makeEnv, makeKv, call } from "../../tests/harness.mjs";
const env = makeEnv({ CONFIGS: makeKv() });
for (const p of ["/lists/curated/action", "/lists/curated/for-you", "/lists/curated/a"]) {
  const r = await call(env, p);
  console.log(p, "->", r.status, typeof r.body === "object" ? JSON.stringify(r.body) : String(r.text).slice(0, 120));
}
// compare against a working sibling
const ok = await call(env, "/lists/trending");
console.log("/lists/trending ->", ok.status, String(ok.text).slice(0, 60));

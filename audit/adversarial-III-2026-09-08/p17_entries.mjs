import { makeEnv, makeKv, call } from "../../tests/harness.mjs";
const env = makeEnv({ CONFIGS: makeKv() });
const B = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const BROWSER = { Accept: "text/html", "User-Agent": "Mozilla/5.0 Chrome/120", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" };
const MARK = "ZZ</script><svg onload=1>YY";

// A. base64 config, entries WITH the required id/url/type fields
const cfg = B({ entries: [{ id: "x", url: "tmdb:chart:popular", type: "movie", name: MARK, group: MARK }] });
const a = await call(env, `/${cfg}/configure`, { headers: BROWSER });
console.log("A base64 entries[].name breakout:", a.text.includes(MARK));

// B. server-stored config via /api/save (short id), which does NOT filter entries
const saved = await call(env, "/api/save", { method: "POST", json: { entries: [{ name: MARK, url: "tmdb:chart:popular", type: "movie" }] } });
console.log("   /api/save ->", saved.status, JSON.stringify(saved.body));
if (saved.body && saved.body.id) {
  const b = await call(env, `/${saved.body.id}/configure`, { headers: BROWSER });
  console.log("B short-id entries[].name breakout:", b.text.includes(MARK));
  const i = b.text.indexOf(MARK);
  if (i > -1) console.log("   ", JSON.stringify(b.text.slice(Math.max(0,i-120), i+60)));
}

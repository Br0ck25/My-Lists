import { makeEnv, makeKv, call } from "../../tests/harness.mjs";
const env = makeEnv({ CONFIGS: makeKv() });
const B = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const BROWSER = { Accept: "text/html", "User-Agent": "Mozilla/5.0 Chrome/120", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" };
const MARK = `x" autofocus onfocus="window.__ATTRXSS=1`;
for (const f of ["traktKey","tmdbKey","mdblistKey","traktUsername","simklKey","region"]) {
  const r = await call(env, `/${B({ entries: [], [f]: MARK })}/configure`, { headers: BROWSER });
  console.log(f.padEnd(18), r.text.includes(MARK) ? "ATTRIBUTE BREAKOUT" : "-");
}

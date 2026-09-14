import { makeEnv, makeKv, call } from "../../tests/harness.mjs";
const env = makeEnv({ CONFIGS: makeKv() });
const B = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const BROWSER = { Accept: "text/html", "User-Agent": "Mozilla/5.0 Chrome/120", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" };
for (const f of ["traktKey","tmdbKey","mdblistKey","traktUsername","traktAccessToken","mdblistAccessToken"]) {
  const MARK = `ZZ</script><svg onload=1>YY`;
  const r = await call(env, `/${B({ entries: [], [f]: MARK })}/configure`, { headers: BROWSER });
  const i = r.text.indexOf("ZZ</script>");
  console.log("### " + f);
  console.log(i === -1 ? "   not reflected" : "   " + JSON.stringify(r.text.slice(Math.max(0,i-160), i+60)));
}

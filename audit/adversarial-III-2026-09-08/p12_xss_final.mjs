import { makeEnv, makeKv, makeD1, call, createUser } from "../../tests/harness.mjs";
const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
const BROWSER = { Accept: "text/html", "User-Agent": "Mozilla/5.0 Chrome/120", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" };
const B = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
// No double quotes, so JSON.stringify does not alter a single byte of it.
const P = (t) => `</script><svg onload=window.__pwn='${t}'>`;
const hit = (html, t) => html.includes(P(t));

console.log("== A. /{config}/configure ==");
for (const f of ["traktAccessToken","mdblistAccessToken","tmdbKey","mdblistKey","traktKey","traktUsername","region","simklKey"]) {
  const r = await call(env, `/${B({ entries: [], [f]: P(f) })}/configure`, { headers: BROWSER });
  console.log(`   ${f.padEnd(20)} ${hit(r.text, f) ? "BREAKOUT" : "-"}`);
}
const rE = await call(env, `/${B({ entries: [{ name: P("entryName"), url: P("entryUrl"), type: "movie", enabled: true, group: P("entryGroup") }] })}/configure`, { headers: BROWSER });
for (const f of ["entryName","entryUrl","entryGroup"]) console.log(`   ${f.padEnd(20)} ${hit(rE.text, f) ? "BREAKOUT" : "-"}`);

console.log("== B. anonymous publish -> shared page ==");
const pub = await call(env, "/api/publish-list", { method: "POST", json: {
  name: "Free " + P("pubName"), type: "movie", visibility: "public",
  items: [{ id: "tt0111161", title: P("pubItem"), poster: P("pubPoster") }] }});
const slug = pub.body.listName;
const pg = await call(env, `/lists/user/${slug}`, { headers: BROWSER });
console.log("   status", pg.status, "name:", hit(pg.text,"pubName") ? "BREAKOUT" : "-", " item title:", hit(pg.text,"pubItem") ? "BREAKOUT":"-", " poster:", hit(pg.text,"pubPoster")?"BREAKOUT":"-");

console.log("== C. creator list + display name ==");
const U = await createUser(env, "xssowner", { displayName: "</script><svg onload=1>" });
const sv = await call(env, "/api/creator/lists/save", { method: "POST", json: {
  creatorName: U.creatorName, creatorKey: U.creatorKey, name: "Nice " + P("listName"),
  type: "movie", visibility: "public", items: [{ id: "tt1", title: P("itemName") }] }});
const pg2 = await call(env, `/lists/xssowner/${sv.body.slug}`, { headers: BROWSER });
console.log("   status", pg2.status, " listName:", hit(pg2.text,"listName")?"BREAKOUT":"-",
            " itemName:", hit(pg2.text,"itemName")?"BREAKOUT":"-",
            " displayName:", pg2.text.includes("</script><svg onload=1>")?"BREAKOUT":"-");
const i = pg2.text.indexOf("SERVER_DEEP_LINK_LIST");
console.log("   ---");
console.log("  ", pg2.text.slice(i, i+260));

import { makeEnv, makeKv, makeD1, call, createUser } from "../../tests/harness.mjs";
const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
const U = await createUser(env, "pathuser");
await call(env, "/api/creator/lists/save", { method: "POST", json: {
  creatorName: U.creatorName, creatorKey: U.creatorKey, name: "Pub", type: "movie", visibility: "public", items: [{id:"tt1"}] }});

const paths = [
  "/api/toplists",
  "/lists/pathuser/pub", "/lists/pathuser/pub.json", "/lists/pathuser/nope",
  "/lists/user/anything", "/lists/%2e%2e%2f%2e%2e%2fetc/passwd",
  "/lists/curated/x", "/lists/curated/x/y",
  "/lists/trakt/a/b", "/lists/mdblist/a/b", "/lists/tmdb/12345", "/lists/tmdb/collection/99",
  "/lists/" + "a".repeat(300) + "/b",
  "/x/manifest.json", "/manifest.json",
  "/x/catalog/movie/y.json", "/eyJhIjoxfQ/catalog/movie/mylists-x.json",
  "/x/subtitles/movie/tt1234567.json", "/x/subtitles/series/tt1:1:1.json",
  "/x/subtitles/movie/" + "%2e".repeat(100) + ".json",
  "/x/configure", "/configure",
  "/meta/movie/tt123.json", "/x/meta/series/tt1:1:1.json",
  "/api/scrobble", "/api/scrobble?creator=pathuser&key=bad",
  "/sw.js", "/app.js", "/app.css", "/guide", "/robots.txt", "/sitemap.xml", "/app.webmanifest",
  "/icon.png", "/unavailable-poster.svg",
  "/channels/abc",
  "/api/poster-badge?poster=http://169.254.169.254/&airDate=2030-01-01",
  "/api/poster-badge?poster=https://image.tmdb.org/t/p/w500/x.jpg&airDate=NOTADATE",
  "/api/channel-logo?path=../../../etc/passwd",
  "/api/channel-poster?x=1",
  "/api/details?id=" + "%00".repeat(50),
  "/api/season?id=-1&season=-1",
  "/api/show-episodes?id=NaN&season=Infinity",
  "/nonexistent-route-xyz",
];
for (const p of paths) {
  let r;
  try { r = await call(env, p); } catch (e) { console.log(p, "THREW", e.message.slice(0,80)); continue; }
  const b = typeof r.body === "object" ? JSON.stringify(r.body).slice(0,90) : String(r.text).slice(0,60).replace(/\n/g," ");
  console.log(String(r.status).padStart(3), p.slice(0,70).padEnd(72), b);
}

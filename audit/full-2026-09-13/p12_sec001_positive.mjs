// SEC-001 regression guard: the paths that MUST keep working after the gate.
import { makeEnv, makeKv, makeD1, call, createUser } from "../../tests/harness.mjs";
const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
const u = await createUser(env, "ownercheck");
const cred = { creatorName: "ownercheck", creatorKey: u.creatorKey };
await call(env, "/api/creator/sync/save-tracking", { method: "POST", json: {
  ...cred,
  watchHistory: [{ id: "tt55:1:1", showId: "tt55", showTitle: "Owned Show", seasonNum: 1, episodeNum: 1, watchedAt: 9 }],
  watchlist: [{ id: "tt66", name: "Owned Movie", type: "movie" }],
}});
const rows = [
  { id: "wh", name: "History", type: "series", url: "autotrack:watch-history:series:ownercheck" },
  { id: "wl", name: "Watchlist", type: "movie", url: "autotrack:watchlist:movie:ownercheck" },
];
const ok = (b) => JSON.stringify((b.metas || []).map((m) => m.id));

// 1. Auto-track Playback OFF, personal shelves present -- the case that used to
//    carry no credential at all.
let r = await call(env, "/api/save", { method: "POST", json: {
  entries: rows, trackCreatorName: "ownercheck", trackCreatorKey: u.creatorKey,
}});
console.log("1. save (track off)      ->", r.status, JSON.stringify(r.body));
const cfgOff = r.body.id;
console.log("   own catalog wh        ->", ok((await call(env, "/" + cfgOff + "/catalog/series/wh.json")).body));
console.log("   own catalog wl        ->", ok((await call(env, "/" + cfgOff + "/catalog/movie/wl.json")).body));

// 2. Auto-track Playback ON -- the shape that already worked.
r = await call(env, "/api/save", { method: "POST", json: {
  entries: rows, track: true, trackCreatorName: "ownercheck", trackCreatorKey: u.creatorKey,
}});
const cfgOn = r.body.id;
console.log("2. save (track on)       ->", r.status, "catalog:", ok((await call(env, "/" + cfgOn + "/catalog/series/wh.json")).body));

// 3. A config written before this release: names the account, carries no key.
env.CONFIGS._store.set("legacycfg123", JSON.stringify({ entries: rows, trackCreatorName: "ownercheck" }));
console.log("3. legacy config         ->", ok((await call(env, "/legacycfg123/catalog/series/wh.json")).body),
            "(LEGACY_UNVERIFIED_CONFIG_SHELVES)");

// 4. The owner's own Live Preview in the builder page.
r = await call(env, "/api/preview?type=series&creatorName=ownercheck&creatorKey=" +
  encodeURIComponent(u.creatorKey) + "&url=" + encodeURIComponent("autotrack:watch-history:series:ownercheck"));
console.log("4. owner /api/preview    ->", r.status, JSON.stringify((r.body.sample || []).map((x) => x.name)));

// 5. A shelf its owner explicitly shared is readable by a stranger.
await call(env, "/api/creator/sync/share-tracking", { method: "POST", json: { ...cred, slug: "watch-history", shared: true } });
r = await call(env, "/api/preview?type=series&url=" + encodeURIComponent("autotrack:watch-history:series:ownercheck"));
console.log("5. shared, no creds      ->", r.status, JSON.stringify((r.body.sample || []).map((x) => x.name)));
r = await call(env, "/lists/ownercheck/watch-history.json");
console.log("   /lists/.../watch-history.json ->", r.status, r.body && r.body.ok);

// 6. ...and turning sharing back off closes it again.
await call(env, "/api/creator/sync/share-tracking", { method: "POST", json: { ...cred, slug: "watch-history", shared: false } });
r = await call(env, "/api/preview?type=series&url=" + encodeURIComponent("autotrack:watch-history:series:ownercheck"));
console.log("6. un-shared, no creds   ->", r.status, JSON.stringify((r.body.sample || []).map((x) => x.name)));

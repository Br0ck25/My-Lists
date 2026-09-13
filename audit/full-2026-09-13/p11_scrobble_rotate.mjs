// Probe BE-003: rotating the scrobble token while the D1 write fails leaves the
// OLD token working and the NEW one dead, while the API reports the new one.
import { makeEnv, makeKv, makeD1, call, createUser } from "../../tests/harness.mjs";
const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
const u = await createUser(env, "rotator");
const cred = { creatorName: "rotator", creatorKey: u.creatorKey };

let r = await call(env, "/api/creator/scrobble-token", { method: "POST", json: cred });
const oldTok = r.body.token;
console.log("initial token:", oldTok);

// D1 goes down for scrobble_tokens writes only.
env.DB.failWhen((sql) => /scrobble_tokens/.test(sql) && /DELETE|INSERT/i.test(sql));
r = await call(env, "/api/creator/scrobble-token", { method: "POST", json: { ...cred, rotate: true } });
const newTok = r.body.token;
console.log("rotate ->", r.status, JSON.stringify(r.body));
env.DB.failWhen(null);

const probe = async (tok, label) => {
  const res = await call(env, "/api/scrobble?st=" + encodeURIComponent(tok), { method: "POST",
    json: { event: "media.scrobble", Metadata: { type: "movie", title: "X", guid: "imdb://tt1" } } });
  console.log(`  ${label} (${tok.slice(0,8)}...) -> ${res.status} ${JSON.stringify(res.body).slice(0,80)}`);
};
console.log("after rotation:");
await probe(newTok, "NEW token (should work)");
await probe(oldTok, "OLD token (should be revoked)");

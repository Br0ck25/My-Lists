// Prove the `clientId` reference at 25_api-catalog-routes.js:2575 is unbound.
import { makeEnv, makeKv, call } from "../../tests/harness.mjs";

const env = makeEnv({ CONFIGS: makeKv() });
env.TRAKT_CLIENT_ID = "test-trakt-client";
env.TRAKT_CLIENT_SECRET = "test-trakt-secret";

// Intercept outbound fetches so no real network is touched.
const realFetch = globalThis.fetch;
const seen = [];
globalThis.fetch = async (u, init) => {
  const urlStr = typeof u === "string" ? u : u.url;
  seen.push({ url: urlStr, headers: (init && init.headers) || {} });
  if (urlStr.includes("/oauth/token")) {
    return new Response(JSON.stringify({ access_token: "ACCESS123", refresh_token: "R" }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  if (urlStr.includes("/users/me")) {
    return new Response(JSON.stringify({ username: "traktuser" }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  return new Response("{}", { status: 200 });
};

// 1. start -> capture state cookie
const start = await call(env, "/api/trakt/oauth/start");
const setCookie = start.headers.get("set-cookie") || "";
const state = (setCookie.match(/mla_trakt_state=([^;]+)/) || [])[1];
console.log("start status", start.status, "state", state);

// 2. callback with the matching state
const cb = await call(env, `/api/trakt/oauth/callback?code=abc&state=${state}`, {
  headers: { Cookie: `mla_trakt_state=${state}` },
});
console.log("callback status", cb.status);
console.log("Location:", cb.headers.get("location"));
console.log("outbound fetches:", seen.map(s => s.url));
globalThis.fetch = realFetch;

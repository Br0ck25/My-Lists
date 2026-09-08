import { makeKv, makeD1, makeEnv, call } from "../../tests/harness.mjs";
const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
const login = await call(env, "/admin/login", { method: "POST", form: { key: "test-admin-secret" } });
const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
// /admin/logout accepts any method, and has no CSRF token.
for (const m of ["GET", "POST", "HEAD", "PUT", "DELETE"]) {
  const r = await call(env, "/admin/logout", { method: m, cookie });
  console.log("/admin/logout", m.padEnd(7), r.status, (r.headers.get("set-cookie")||"").slice(0, 34));
}
// /admin still reachable afterwards with the same cookie (cookie is stateless)
const after = await call(env, "/admin", { cookie });
console.log("cookie still valid after logout (stateless session):", after.status === 200 && after.text.includes("Creator"));
// publish-list rate limit + size
let ok = 0;
for (let i = 0; i < 12; i++) {
  const r = await call(env, "/api/publish-list", { method: "POST", ip: "203.0.113.99", json: { name: "L" + i, type: "movie", visibility: "public", items: [{id:"tt1"}] } });
  if (r.body && r.body.ok) ok++;
}
console.log("publish-list accepted from one IP in a burst:", ok, "of 12");

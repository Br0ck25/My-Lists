// Adversarial harness: real-SQLite D1 + an instrumentable KV.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
if (!globalThis.caches) {
  globalThis.caches = {
    default: { match: async () => null, put: async () => {} },
    open: async () => ({ match: async () => null, put: async () => {} }),
  };
}
export const worker = (await import("../../worker_entry_combined.js")).default;

export function makeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  const hooks = { beforePut: null, beforeGet: null, beforeDelete: null, beforeList: null };
  const log = [];
  const kv = {
    _store: store, _hooks: hooks, _log: log,
    async get(key, type) {
      log.push(["get", key]);
      if (hooks.beforeGet) await hooks.beforeGet(key);
      if (!store.has(key)) return null;
      const raw = store.get(key);
      if (type === "json") { try { return JSON.parse(raw); } catch { return null; } }
      return raw;
    },
    async put(key, value, opts) {
      log.push(["put", key]);
      if (hooks.beforePut) await hooks.beforePut(key, value, opts);
      store.set(key, typeof value === "string" ? value : JSON.stringify(value));
    },
    async delete(key) {
      log.push(["delete", key]);
      if (hooks.beforeDelete) await hooks.beforeDelete(key);
      store.delete(key);
    },
    async list({ prefix = "", limit = 1000, cursor } = {}) {
      log.push(["list", prefix, cursor]);
      if (hooks.beforeList) await hooks.beforeList(prefix, cursor);
      // Real KV cursors are opaque and positioned by KEY, not offset --
      // model that (an offset cursor hides bugs when keys change mid-scan).
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const after = cursor ? Buffer.from(cursor, "base64").toString("utf8") : null;
      const start = after ? keys.findIndex((k) => k > after) : 0;
      const from = start === -1 ? keys.length : start;
      const slice = keys.slice(from, from + limit);
      const complete = from + slice.length >= keys.length;
      return {
        keys: slice.map((name) => ({ name })),
        list_complete: complete,
        cursor: complete ? undefined : Buffer.from(slice[slice.length - 1]).toString("base64"),
      };
    },
  };
  return kv;
}

export function makeRealD1({ schema = "../../schema.sql", extra = [], sql = [], foreignKeys = true } = {}) {
  const db = new DatabaseSync(":memory:");
  if (foreignKeys) db.exec("PRAGMA foreign_keys = ON;");
  db.exec(readFileSync(new URL(schema, import.meta.url), "utf8"));
  for (const e of extra) db.exec(readFileSync(new URL(e, import.meta.url), "utf8"));
  for (const q of sql) db.exec(q);
  const state = { fail: null, log: [] };
  function exec(sql, args) {
    const s = String(sql);
    state.log.push({ sql: s, args });
    if (state.fail && state.fail(s, args)) { const e = new Error("D1_ERROR: injected"); e.injected = true; throw e; }
    const norm = (v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v);
    const stmt = db.prepare(s);
    if (/^\s*(SELECT|PRAGMA|WITH)/i.test(s)) {
      return { results: stmt.all(...args.map(norm)), success: true, meta: { changes: 0 } };
    }
    const info = stmt.run(...args.map(norm));
    return { results: [], success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  }
  return {
    _db: db, _state: state,
    q: (sql, ...a) => db.prepare(sql).all(...a),
    failWhen(fn) { state.fail = fn; },
    prepare(sql) {
      const mk = (args) => ({
        async run() { const r = exec(sql, args); return { success: true, meta: r.meta }; },
        async all() { const r = exec(sql, args); return { success: true, results: r.results, meta: r.meta }; },
        async first(c) { const r = exec(sql, args); const row = r.results[0] || null; return c && row ? row[c] : row; },
        bind: (...a2) => mk(a2),
      });
      return mk([]);
    },
    async batch(stmts) { const out = []; for (const st of stmts) out.push(await st.run()); return out; },
    async exec(sql) { db.exec(String(sql)); return { count: 0 }; },
  };
}

let ipSeq = 1;
export function nextIp() { const n = ipSeq++; return `198.51.${(n >> 8) & 255}.${n & 255}`; }

export function makeEnv(opts = {}) {
  return { CONFIGS: opts.CONFIGS || makeKv(), ADMIN_KEY: opts.ADMIN_KEY === undefined ? "test-admin-secret" : opts.ADMIN_KEY, DB: opts.DB, ...(opts.extra || {}) };
}

export async function call(env, path, opts = {}) {
  const { method = "GET", json, form, headers = {}, ip = nextIp(), cookie, raw } = opts;
  const pending = [];
  const ctx = { waitUntil(p) { pending.push(Promise.resolve(p).catch((e) => { ctx._errs.push(e); })); }, _errs: [] };
  const h = { ...headers };
  if (ip) h["CF-Connecting-IP"] = ip;
  if (cookie) h.Cookie = cookie;
  const init = { method, headers: h };
  if (json !== undefined) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(json); }
  else if (raw !== undefined) { init.body = raw; }
  else if (form) { const fd = new FormData(); for (const [k, v] of Object.entries(form)) fd.set(k, v); init.body = fd; }
  const res = await worker.fetch(new Request("https://example.test" + path, init), env, ctx);
  await Promise.all(pending);
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body, headers: res.headers, text, waitUntilErrors: ctx._errs };
}

export async function createUser(env, name, extra = {}) {
  const ip = extra.ip || nextIp();
  const r = await call(env, "/api/creator/create", { method: "POST", ip, json: { creatorName: name, displayName: extra.displayName, recoveryAnswer: extra.recoveryAnswer } });
  if (!r.body || !r.body.ok) throw new Error(`create ${name} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return { ...r.body, ip };
}
export async function adminCookie(env, key = "test-admin-secret") {
  const r = await call(env, "/admin/login", { method: "POST", form: { key } });
  const sc = r.headers.get("set-cookie") || "";
  return sc.split(";")[0];
}

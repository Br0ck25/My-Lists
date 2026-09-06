// Shared in-memory Worker harness for the production-audit test suite.
// The Worker is a real ES module; we only stub KV, D1, caches, and waitUntil.
//
// D1 is backed by REAL SQLite (node:sqlite, Node 22.13+), loaded from the
// committed schema.sql, with PRAGMA foreign_keys = ON to match D1's own
// documented default ("D1 enforces that foreign key constraints are valid
// within all queries and migrations"). It used to be a regex-matching mock,
// and three of its shortcuts were each hiding a live defect:
//
//   * `SELECT * FROM creator_lists WHERE id = ?` was hardcoded to return no
//     rows, so getCreatorList's D1 branch was never executed by ANY test in
//     this suite. A mutation that removed the D1 write from
//     /api/creator/lists/save outright left the whole suite green.
//   * It could not throw, so no test ever covered "KV healthy, D1 fails" --
//     which is the state where key rotation and account deletion both used
//     to report success while doing nothing.
//   * It could not enforce a primary key, a NOT NULL, a DEFAULT or a foreign
//     key, so a column the code never binds (creator_lists.likes) silently
//     read back as whatever the mock had stashed rather than as the column
//     default the real database would apply.
//
// Real SQLite removes all three at once. `failWhen(fn)` is the fault
// injector: any statement the predicate matches throws, the same way a D1
// outage or a row-size violation does.

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

if (!globalThis.caches) {
  globalThis.caches = {
    default: { match: async () => null, put: async () => {} },
    open: async () => ({ match: async () => null, put: async () => {} }),
  };
}

export const worker = (await import("../worker_entry_combined.js")).default;

const SCHEMA_SQL = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

export function makeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  // Fault injection, matching makeD1().failWhen: a hook that throws makes the
  // corresponding KV call fail. Used to cover the partial-write paths where a
  // route has to decide between reporting success and reporting the truth.
  const hooks = { beforeGet: null, beforePut: null, beforeDelete: null, beforeList: null };
  return {
    _store: store,
    _hooks: hooks,
    async get(key, type) {
      if (hooks.beforeGet) await hooks.beforeGet(key);
      if (!store.has(key)) return null;
      const raw = store.get(key);
      if (type === "json") {
        try { return JSON.parse(raw); } catch { return null; }
      }
      return raw;
    },
    async put(key, value) {
      if (hooks.beforePut) await hooks.beforePut(key, value);
      store.set(key, typeof value === "string" ? value : JSON.stringify(value));
    },
    async delete(key) {
      if (hooks.beforeDelete) await hooks.beforeDelete(key);
      store.delete(key);
    },
    // Real KV cursors are opaque and positioned by KEY, not by offset. An
    // integer offset into a freshly re-sorted array behaves differently the
    // moment keys are added or removed mid-traversal -- which is exactly what
    // happens during an index rebuild or an account purge -- so this models
    // the real contract instead.
    async list({ prefix = "", limit = 1000, cursor } = {}) {
      if (hooks.beforeList) await hooks.beforeList(prefix, cursor);
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const after = cursor ? Buffer.from(cursor, "base64").toString("utf8") : null;
      const found = after ? keys.findIndex((k) => k > after) : 0;
      const start = found === -1 ? keys.length : found;
      const slice = keys.slice(start, start + limit);
      const complete = start + slice.length >= keys.length;
      return {
        keys: slice.map((name) => ({ name })),
        list_complete: complete,
        cursor: complete ? undefined : Buffer.from(slice[slice.length - 1]).toString("base64"),
      };
    },
  };
}

export function makeD1({ foreignKeys = true } = {}) {
  const db = new DatabaseSync(":memory:");
  if (foreignKeys) db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA_SQL);
  // schema.sql is the documented way to provision a fresh database and now
  // carries every index the migrations leave behind, so there is nothing to
  // add here -- the drift test in worker.test.mjs is what keeps the two
  // provisioning paths identical.

  const state = { fail: null };
  const norm = (v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v);

  function exec(sql, args) {
    const s = String(sql);
    if (state.fail && state.fail(s, args)) {
      const err = new Error("D1_ERROR: injected failure");
      err.injected = true;
      throw err;
    }
    const stmt = db.prepare(s);
    const bound = args.map(norm);
    if (/^\s*(SELECT|PRAGMA|WITH)/i.test(s)) {
      return { results: stmt.all(...bound), success: true, meta: { changes: 0 } };
    }
    const info = stmt.run(...bound);
    return {
      results: [],
      success: true,
      meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid), duration: 0 },
    };
  }

  const q = (sql, ...args) => db.prepare(sql).all(...args.map(norm));

  // Map-shaped views over the real tables, so assertions that predate the
  // SQLite backing (db._creators.size, db._lists.has(id)) keep reading
  // naturally. Live queries, not snapshots.
  const tableView = (table, idCol) => ({
    get size() { return Number(q(`SELECT COUNT(*) AS n FROM ${table}`)[0].n); },
    has: (id) => q(`SELECT 1 FROM ${table} WHERE ${idCol} = ?`, id).length > 0,
    get: (id) => q(`SELECT * FROM ${table} WHERE ${idCol} = ?`, id)[0],
    keys: () => q(`SELECT ${idCol} AS id FROM ${table}`).map((r) => r.id),
    values: () => q(`SELECT * FROM ${table}`),
  });

  // Standalone (not `this`-bound): one test hands these to a wrapper object.
  const _stat = (kind, day) => {
    const rows = q("SELECT n FROM stats WHERE kind = ? AND day = ?", kind, day);
    return rows.length ? Number(rows[0].n) : undefined;
  };
  const _statBuckets = (kind) => q("SELECT day FROM stats WHERE kind = ?", kind).map((r) => r.day);

  return {
    _db: db,
    _creators: tableView("creators", "username"),
    _lists: tableView("creator_lists", "id"),
    _stat,
    _statBuckets,
    q,
    // Make chosen statements throw. `fn(sql, args) => boolean`; null clears.
    failWhen(fn) { state.fail = fn; },
    prepare(sql) {
      // Real D1 exposes run()/all() directly as well as after .bind(), since
      // bind() is only needed for a query that actually has placeholders.
      // `_spec` lets batch() run the statements itself, synchronously -- see
      // batch's own comment.
      const mk = (args) => ({
        _spec: { sql, args },
        async run() { const r = exec(sql, args); return { success: true, meta: r.meta }; },
        async all() { const r = exec(sql, args); return { success: true, results: r.results, meta: r.meta }; },
        async first(col) {
          const row = exec(sql, args).results[0] || null;
          return col && row ? row[col] : row;
        },
        bind: (...a) => mk(a),
      });
      return mk([]);
    },
    // Atomic, and synchronous once entered. node:sqlite's DatabaseSync is a
    // single synchronous connection, so awaiting each statement inside an
    // explicit BEGIN lets a second overlapping batch open a nested
    // transaction and throw -- which, since every counter call site swallows
    // its errors, silently dropped 19 of 20 concurrent bumps and made the
    // atomic-counter test fail for a reason that has nothing to do with the
    // Worker. Running the statements straight through models what D1
    // actually guarantees: a batch is one transaction, and batches do not
    // interleave with each other.
    async batch(stmts) {
      const specs = stmts.map((st) => st && st._spec).filter(Boolean);
      db.exec("BEGIN");
      try {
        const out = specs.map((sp) => {
          const r = exec(sp.sql, sp.args);
          return { success: true, meta: r.meta, results: r.results };
        });
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    async exec(sql) { db.exec(String(sql)); return { count: 0, duration: 0 }; },
  };
}

let ipSeq = 1;
export function nextIp() {
  const n = ipSeq++;
  return `198.51.${(n >> 8) & 255}.${n & 255}`;
}

export function makeEnv(opts = {}) {
  return {
    CONFIGS: opts.CONFIGS || makeKv(),
    ADMIN_KEY: opts.ADMIN_KEY === undefined ? "test-admin-secret" : opts.ADMIN_KEY,
    DB: opts.DB,
  };
}

export async function call(env, path, opts = {}) {
  const {
    method = "GET",
    json,
    form,
    headers = {},
    ip = nextIp(),
    cookie,
  } = opts;
  const pending = [];
  const ctx = {
    waitUntil(p) {
      pending.push(Promise.resolve(p).catch(() => {}));
    },
  };
  const h = { ...headers };
  if (ip) h["CF-Connecting-IP"] = ip;
  if (cookie) h.Cookie = cookie;
  const init = { method, headers: h };
  if (json !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(json);
  } else if (form) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(form)) fd.set(k, v);
    init.body = fd;
  }
  const res = await worker.fetch(new Request("https://example.test" + path, init), env, ctx);
  await Promise.all(pending);
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* html / empty */ }
  return { status: res.status, body, headers: res.headers, text };
}

export async function createUser(env, name, extra = {}) {
  const ip = extra.ip || nextIp();
  const r = await call(env, "/api/creator/create", {
    method: "POST",
    ip,
    json: {
      creatorName: name,
      displayName: extra.displayName,
      recoveryAnswer: extra.recoveryAnswer,
    },
  });
  if (!r.body || !r.body.ok) {
    throw new Error(`create ${name} failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return { ...r.body, ip };
}

// Shared in-memory Worker harness for the production-audit test suite.
// The Worker is a real ES module; we only stub KV, D1, caches, and waitUntil.

if (!globalThis.caches) {
  globalThis.caches = {
    default: { match: async () => null, put: async () => {} },
    open: async () => ({ match: async () => null, put: async () => {} }),
  };
}

export const worker = (await import("../worker_entry_combined.js")).default;

export function makeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    _store: store,
    async get(key, type) {
      if (!store.has(key)) return null;
      const raw = store.get(key);
      if (type === "json") {
        try { return JSON.parse(raw); } catch { return null; }
      }
      return raw;
    },
    async put(key, value) {
      store.set(key, typeof value === "string" ? value : JSON.stringify(value));
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix = "", limit = 1000, cursor } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) || 0 : 0;
      const slice = keys.slice(start, start + limit);
      const next = start + slice.length;
      return {
        keys: slice.map((name) => ({ name })),
        list_complete: next >= keys.length,
        cursor: next >= keys.length ? undefined : String(next),
      };
    },
  };
}

export function makeD1() {
  const creators = new Map();
  const lists = new Map();
  // Keyed "kind\u0000day" -> n. Models the real table's PRIMARY KEY
  // (kind, day) and, crucially, the atomicity of its upsert: the increment
  // happens inside this one synchronous call, so two overlapping callers
  // cannot both read the same value and both write value+1 the way the KV
  // read-modify-write path can.
  const stats = new Map();
  const statKey = (kind, day) => `${kind}\u0000${day}`;
  function run(sql, args) {
    const s = String(sql);
    if (/INSERT INTO stats/i.test(s)) {
      const [kind, day, n] = args;
      const k = statKey(kind, day);
      if (stats.has(k)) {
        if (/DO UPDATE SET n = n \+ excluded\.n/i.test(s)) stats.set(k, stats.get(k) + Number(n));
        // DO NOTHING: leave the existing row alone (migrate-d1 is re-runnable)
      } else {
        stats.set(k, Number(n));
      }
      return { meta: { changes: 1 }, success: true };
    }
    if (/INSERT INTO creators/i.test(s)) {
      const [username, display_name, key_hash, recovery_answer_hash, created_at] = args;
      if (creators.has(username) && /ON CONFLICT/i.test(s)) return { meta: { changes: 0 }, success: true };
      creators.set(username, { username, display_name, key_hash, recovery_answer_hash, created_at, last_active: null });
      return { meta: { changes: 1 }, success: true };
    }
    if (/UPDATE creators SET key_hash/i.test(s)) {
      const [key_hash, username] = args;
      const row = creators.get(username);
      if (!row) return { meta: { changes: 0 }, success: true };
      row.key_hash = key_hash;
      return { meta: { changes: 1 }, success: true };
    }
    if (/DELETE FROM creators WHERE username/i.test(s)) {
      const had = creators.delete(args[0]);
      return { meta: { changes: had ? 1 : 0 }, success: true };
    }
    if (/INSERT INTO creator_lists/i.test(s)) {
      const id = args[0];
      lists.set(id, args);
      return { meta: { changes: 1 }, success: true };
    }
    if (/DELETE FROM creator_lists WHERE id LIKE/i.test(s)) {
      const like = String(args[0] || "").replace(/%/g, "");
      let n = 0;
      for (const id of [...lists.keys()]) {
        if (id.startsWith(like)) { lists.delete(id); n++; }
      }
      return { meta: { changes: n }, success: true };
    }
    if (/DELETE FROM creator_lists WHERE id =/i.test(s)) {
      const had = lists.delete(args[0]);
      return { meta: { changes: had ? 1 : 0 }, success: true };
    }
    if (/UPDATE creator_lists SET likes/i.test(s)) {
      return { meta: { changes: lists.has(args[1]) ? 1 : 0 }, success: true };
    }
    return { meta: { changes: 0 }, success: true };
  }
  function all(sql, args) {
    const s = String(sql);
    if (/SELECT n FROM stats WHERE kind = \? AND day = \?/i.test(s)) {
      const k = statKey(args[0], args[1]);
      return { results: stats.has(k) ? [{ n: stats.get(k) }] : [] };
    }
    if (/SELECT day, n FROM stats WHERE kind = \? AND day != 'total'/i.test(s)) {
      const out = [];
      for (const [k, n] of stats) {
        const [kind, day] = k.split("\u0000");
        if (kind === args[0] && day !== "total") out.push({ day, n });
      }
      return { results: out };
    }
    if (/SELECT kind, n FROM stats WHERE day = 'total' AND kind LIKE \?/i.test(s)) {
      const prefix = String(args[0]).replace(/%$/, "");
      const limit = Number(args[1]) || 1000;
      const out = [];
      for (const [k, n] of stats) {
        const [kind, day] = k.split("\u0000");
        if (day === "total" && kind.startsWith(prefix)) out.push({ kind, n });
      }
      out.sort((a, b) => b.n - a.n);
      return { results: out.slice(0, limit) };
    }
    if (/SELECT name, install_count FROM source_groups/i.test(s)) {
      return { results: [] };
    }
    if (/SELECT \* FROM creators WHERE username/i.test(s)) {
      const row = creators.get(args[0]);
      return { results: row ? [row] : [] };
    }
    if (/SELECT COUNT\(\*\)/i.test(s)) {
      return { results: [{ n: creators.size }] };
    }
    if (/SELECT username, display_name/i.test(s)) {
      return { results: [...creators.values()] };
    }
    if (/SELECT \* FROM creator_lists WHERE id =/i.test(s)) {
      return { results: [] };
    }
    return { results: [] };
  }
  return {
    _creators: creators,
    _lists: lists,
    _stats: stats,
    // Readable accessors so tests never have to know the composite-key encoding.
    _stat: (kind, day) => stats.get(statKey(kind, day)),
    _statBuckets: (kind) =>
      [...stats.keys()].map((k) => k.split("\u0000")).filter(([kk]) => kk === kind).map(([, d]) => d),
    prepare(sql) {
      // Real D1's PreparedStatement exposes run()/all() directly, not only
      // after .bind() -- bind() is only needed when the query actually has
      // placeholders. A mock that required .bind() unconditionally masked
      // any code path calling .prepare(sql).all()/.run() on a parameterless
      // query (renderAdminDashboard's creator COUNT(*), for one).
      return {
        bind(...args) {
          return {
            run: async () => run(sql, args),
            all: async () => all(sql, args),
          };
        },
        run: async () => run(sql, []),
        all: async () => all(sql, []),
      };
    },
    async batch(stmts) {
      for (const st of stmts) {
        if (st && typeof st.run === "function") await st.run();
      }
    },
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

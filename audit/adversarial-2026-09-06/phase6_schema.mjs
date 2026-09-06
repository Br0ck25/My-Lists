import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
const R = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

function describe(db, label) {
  const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const out = { label, tables: {} };
  for (const t of tables) {
    const cols = db.prepare(`PRAGMA table_info(${t.name})`).all();
    const idx = db.prepare(`PRAGMA index_list(${t.name})`).all();
    const fks = db.prepare(`PRAGMA foreign_key_list(${t.name})`).all();
    const idxDetail = idx.map(i => ({ name: i.name, unique: i.unique, origin: i.origin, cols: db.prepare(`PRAGMA index_info(${i.name})`).all().map(c=>c.name) }));
    out.tables[t.name] = {
      cols: cols.map(c => `${c.name} ${c.type} notnull=${c.notnull} dflt=${c.dflt_value} pk=${c.pk}`),
      indexes: idxDetail.sort((a,b)=>a.name<b.name?-1:1),
      fks,
    };
  }
  return out;
}

// A: fresh from schema.sql
const A = new DatabaseSync(":memory:");
A.exec(R("../../schema.sql"));
const descA = describe(A, "fresh schema.sql");

// B: "old" database = schema.sql WITHOUT likes column and WITHOUT stats table,
//    reconstructed to be what migrations 0001/0002 were written against,
//    then migrated 0001 -> 0002.
const oldSchema = `
CREATE TABLE creators (
    username TEXT PRIMARY KEY, display_name TEXT NOT NULL, key_hash TEXT NOT NULL,
    recovery_answer_hash TEXT, created_at INTEGER NOT NULL, last_active INTEGER);
CREATE TABLE creator_lists (
    id TEXT PRIMARY KEY, username TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'private', items_json TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    FOREIGN KEY (username) REFERENCES creators(username) ON DELETE CASCADE);
CREATE TABLE source_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, install_count INTEGER NOT NULL DEFAULT 0);
CREATE INDEX idx_creator_lists_username ON creator_lists(username);
CREATE INDEX idx_creator_lists_visibility ON creator_lists(visibility);
`;
const B = new DatabaseSync(":memory:");
B.exec(oldSchema);
B.exec(R("../../migrations/0001_add_likes_to_creator_lists.sql"));
B.exec(R("../../migrations/0002_add_stats_table.sql"));
const descB = describe(B, "old + 0001 + 0002");

function diff(a, b) {
  const names = new Set([...Object.keys(a.tables), ...Object.keys(b.tables)]);
  for (const n of names) {
    const ta = a.tables[n], tb = b.tables[n];
    if (!ta) { console.log(`TABLE only in ${b.label}: ${n}`); continue; }
    if (!tb) { console.log(`TABLE only in ${a.label}: ${n}`); continue; }
    const ca = JSON.stringify(ta.cols), cb = JSON.stringify(tb.cols);
    if (ca !== cb) console.log(`COLUMNS differ for ${n}:\n  ${a.label}: ${ca}\n  ${b.label}: ${cb}`);
    const ia = ta.indexes.map(i=>`${i.name}[${i.cols}]u=${i.unique}o=${i.origin}`).sort().join(",");
    const ib = tb.indexes.map(i=>`${i.name}[${i.cols}]u=${i.unique}o=${i.origin}`).sort().join(",");
    if (ia !== ib) console.log(`INDEXES differ for ${n}:\n  ${a.label}: ${ia}\n  ${b.label}: ${ib}`);
    const fa = JSON.stringify(ta.fks), fb = JSON.stringify(tb.fks);
    if (fa !== fb) console.log(`FKS differ for ${n}:\n  ${a.label}: ${fa}\n  ${b.label}: ${fb}`);
  }
}
console.log("=== schema.sql (fresh) ===");
console.log(JSON.stringify(descA, null, 1));
console.log("=== DIFF: fresh schema.sql  vs  old+0001+0002 ===");
diff(descA, descB);

// Idempotency: run each migration twice
for (const m of ["../../migrations/0001_add_likes_to_creator_lists.sql", "../../migrations/0002_add_stats_table.sql"]) {
  const D = new DatabaseSync(":memory:");
  D.exec(oldSchema);
  D.exec(R(m));
  try { D.exec(R(m)); console.log(`RERUN ${m}: OK (idempotent)`); }
  catch (e) { console.log(`RERUN ${m}: THROWS -> ${e.message}`); }
}
// schema.sql then 0001 (i.e. someone runs the migration on a fresh DB)
const C = new DatabaseSync(":memory:");
C.exec(R("../../schema.sql"));
try { C.exec(R("../../migrations/0001_add_likes_to_creator_lists.sql")); console.log("fresh schema.sql + 0001: OK"); }
catch (e) { console.log("fresh schema.sql + 0001: THROWS ->", e.message); }
try { C.exec(R("../../migrations/0002_add_stats_table.sql")); console.log("fresh schema.sql + 0002: OK"); }
catch (e) { console.log("fresh schema.sql + 0002: THROWS ->", e.message); }

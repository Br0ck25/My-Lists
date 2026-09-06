// Phase 6 + 7: effective migrated schema vs schema.sql, in real SQLite; FK enforcement.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
const schema = readFileSync("../../schema.sql","utf8");
const m1 = readFileSync("../../migrations/0001a_add_likes_column.sql","utf8")
  + "\n" + readFileSync("../../migrations/0001b_add_likes_index.sql","utf8");
const m2 = readFileSync("../../migrations/0002_add_stats_table.sql","utf8");
const m3 = readFileSync("../../migrations/0003_add_missing_indexes.sql","utf8");

function dump(db){
  const out={};
  const tables=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  for(const t of tables){
    out[t.name]={
      columns: db.prepare(`PRAGMA table_info(${t.name})`).all().map(c=>`${c.name} ${c.type} notnull=${c.notnull} dflt=${c.dflt_value} pk=${c.pk}`),
      indexes: db.prepare(`PRAGMA index_list(${t.name})`).all().map(i=>{
        const cols=db.prepare(`PRAGMA index_info(${i.name})`).all().map(x=>x.name).join(",");
        return `${i.name} unique=${i.unique} origin=${i.origin} cols=(${cols})`;
      }).sort(),
      fks: db.prepare(`PRAGMA foreign_key_list(${t.name})`).all().map(f=>`${f.from}->${f.table}.${f.to} onDelete=${f.on_delete} onUpdate=${f.on_update}`),
    };
  }
  return out;
}

// FRESH: schema.sql as documented
const fresh=new DatabaseSync(":memory:"); fresh.exec(schema);

// MIGRATED: the shape that predates every migration, then all of them in
// order. Pre-0001 creator_lists had no `likes` and no likes index; pre-0002
// there was no `stats` table; pre-0003 neither of the two composite indexes.
const preSchema = schema
  .replace(/\n\s*likes INTEGER NOT NULL DEFAULT 0,/,"")
  .replace(/DROP TABLE IF EXISTS stats;[\s\S]*?PRIMARY KEY \(kind, day\)\n\);/,"")
  .replace(/CREATE INDEX idx_creator_lists_likes ON creator_lists\(likes\);/,"")
  .replace(/CREATE INDEX idx_creators_last_active[^;]*;/,"")
  .replace(/CREATE INDEX idx_creator_lists_vis_likes[^;]*;/,"");
const strip = (sql) => sql.split("\n").filter(l => !l.trim().startsWith("--")).join("\n");
const migrated=new DatabaseSync(":memory:");
migrated.exec(preSchema);
for (const m of [m1, m2, m3]) migrated.exec(strip(m));

const a=dump(fresh), b=dump(migrated);
const A=JSON.stringify(a,null,1), B=JSON.stringify(b,null,1);
// The pre-0001 shape is RECONSTRUCTED from schema.sql (the historical file is
// not in the repo), so treat a difference as a lead, not a verdict. The only
// difference today is column ORDER -- ALTER TABLE ADD COLUMN appends, so `likes`
// is 7th in a fresh database and last in a migrated one. Every statement in the
// Worker names its columns and every read is by name, so this is inert.
console.log(A===B ? "PASS - fresh schema.sql and fully-migrated schema are identical"
                  : "INFO - difference between fresh and migrated (check whether it is only column order):");
if(A!==B){
  const al=A.split("\n"), bl=B.split("\n");
  for(let i=0;i<Math.max(al.length,bl.length);i++) if(al[i]!==bl[i]) console.log(`  fresh: ${al[i]}\n  migr : ${bl[i]}`);
}
console.log("\nFRESH SCHEMA:");
console.log(JSON.stringify(a,null,1));

// idempotence / rerun behaviour
console.log("\n-- migration rerun behaviour --");
// Migrations are ordered, so each is tested on a database that already has
// its predecessors -- 0003's composite index needs the column 0001a adds.
const ordered = [["0001a+b",m1],["0002",m2],["0003",m3]];
for(let k=0;k<ordered.length;k++){
  const [name,sql]=ordered[k];
  const db=new DatabaseSync(":memory:"); db.exec(preSchema);
  for(let j=0;j<k;j++) db.exec(strip(ordered[j][1]));
  const body=strip(sql);
  db.exec(body);
  try{ db.exec(body); console.log(`  ${name}: rerun OK (idempotent)`); }
  catch(e){ console.log(`  ${name}: rerun THROWS -> ${e.message}`); }
}
// interrupted between 0001a and 0001b: the ALTER landed, the index did not.
// As ONE file this was unrecoverable -- re-running stopped at the ALTER and
// the CREATE INDEX was never reached. Split, the index half is idempotent and
// can simply be run.
{
  const db=new DatabaseSync(":memory:"); db.exec(preSchema);
  db.exec("ALTER TABLE creator_lists ADD COLUMN likes INTEGER NOT NULL DEFAULT 0;");
  const m1b=readFileSync("../../migrations/0001b_add_likes_index.sql","utf8");
  try{
    db.exec(strip(m1b));
    const idx=db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_creator_lists_likes'").all();
    console.log("  interrupted 0001a -> running 0001b recovers:", idx.length>0 ? "PASS" : "FAIL");
  }catch(e){ console.log("  interrupted 0001a -> 0001b THROWS ->", e.message); }
}

// FK enforcement
console.log("\n-- referential integrity --");
for(const fk of [true,false]){
  const db=new DatabaseSync(":memory:");
  if(fk) db.exec("PRAGMA foreign_keys = ON;");
  db.exec(schema);
  db.prepare("INSERT INTO creators VALUES (?,?,?,?,?,?)").run("u1","U1","h",null,1,null);
  db.prepare("INSERT INTO creator_lists VALUES (?,?,?,?,?,?,?,?,?)").run("u1:a","u1","A","movie","public","[]",0,1,1);
  let orphan="allowed";
  try{ db.prepare("INSERT INTO creator_lists VALUES (?,?,?,?,?,?,?,?,?)").run("ghost:b","ghost","B","movie","public","[]",0,1,1); }
  catch(e){ orphan="rejected: "+e.message; }
  db.prepare("DELETE FROM creators WHERE username=?").run("u1");
  const left=db.prepare("SELECT COUNT(*) n FROM creator_lists WHERE username='u1'").get().n;
  console.log(`  foreign_keys=${fk?"ON":"OFF"}: orphan insert ${orphan}; rows left after creator delete = ${left} (cascade ${left===0?"fired":"DID NOT fire"})`);
}

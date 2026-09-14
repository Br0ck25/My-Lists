import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
const R = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const oldSchema = R("../../schema.sql");
function mk(withLikesIdx) {
  const d = new DatabaseSync(":memory:");
  d.exec(oldSchema);
  if (withLikesIdx) d.exec("CREATE INDEX IF NOT EXISTS idx_creator_lists_likes ON creator_lists(likes);");
  return d;
}
const queries = [
  ["public directory", "SELECT id, username, name, type, visibility, likes, created_at, updated_at, json_array_length(items_json) AS item_count FROM creator_lists WHERE visibility = 'public' ORDER BY likes DESC, updated_at DESC LIMIT 50"],
  ["creators list", "SELECT username, display_name, created_at, last_active FROM creators ORDER BY last_active DESC, created_at DESC LIMIT 50"],
  ["stats totals LIKE", "SELECT kind, n FROM stats WHERE day = 'total' AND kind LIKE 'apiuse:%' ORDER BY n DESC LIMIT 50"],
  ["stats per-kind days", "SELECT day, n FROM stats WHERE kind = 'pageviews' AND day != 'total'"],
  ["creator count", "SELECT COUNT(*) AS n FROM creators"],
  ["delete lists LIKE", "DELETE FROM creator_lists WHERE id LIKE 'alice:%'"],
];
for (const withIdx of [false, true]) {
  const d = mk(withIdx);
  console.log(`\n### ${withIdx ? "WITH idx_creator_lists_likes (migrated DB)" : "schema.sql as committed (fresh DB)"}`);
  for (const [label, q] of queries) {
    const plan = d.prepare("EXPLAIN QUERY PLAN " + q).all();
    console.log(` ${label}: ` + plan.map(p => p.detail).join(" | "));
  }
}
// malformed items_json behaviour
const d = mk(true);
d.exec("INSERT INTO creators VALUES ('a','A','h',NULL,1,NULL)");
d.exec("INSERT INTO creator_lists (id,username,name,type,visibility,items_json,likes,created_at,updated_at) VALUES ('a:x','a','X','movie','public','not-json',0,1,1)");
try { console.log("\njson_array_length on malformed:", d.prepare("SELECT json_array_length(items_json) AS n FROM creator_lists").all()); }
catch (e) { console.log("\njson_array_length on malformed THROWS:", e.message); }

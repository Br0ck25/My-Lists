// The list-size guard is stated in bytes and measured in UTF-16 code units.
// D1's row limit is bytes, so a large non-ASCII list passes the guard and is
// then silently refused by D1 -- with D1 bound, that is a live divergence.
import { makeKv, makeD1, makeEnv, call, createUser } from "../../tests/harness.mjs";

const CAP = 1_800_000;                       // CREATOR_LIST_BYTES_MAX
const D1_ROW_MAX = 2_000_000;                // D1: "Maximum string, BLOB or table row size"

// A realistic Japanese-title list: 1 UTF-16 unit per char, 3 UTF-8 bytes per char.
function jpItems(n) {
  const title = "鋼の錬金術師 フルメタル・アルケミスト 第".repeat(6);
  const overview = "この物語は錬金術師の兄弟が賢者の石を探す旅を描いた作品である。".repeat(20);
  return Array.from({ length: n }, (_, i) => ({
    id: "tt" + (1000000 + i), title: title + i, overview, year: 2015, type: "series",
    poster: "https://image.tmdb.org/t/p/w500/abcdefghijklmnopqrst.jpg",
  }));
}

// Grow until just under the guard, measured the way the guard measures it.
let items = jpItems(400);
let json = JSON.stringify(items);
while (json.length < CAP * 0.97 && items.length < 10000) {
  items = items.concat(jpItems(50));
  json = JSON.stringify(items);
}
const utf16 = json.length;
const bytes = new TextEncoder().encode(json).length;
console.log(`items:               ${items.length}`);
console.log(`JSON.stringify().length (UTF-16 units, what the guard checks): ${utf16.toLocaleString()}  cap ${CAP.toLocaleString()}  -> ${utf16 <= CAP ? "ACCEPTED" : "rejected"}`);
console.log(`UTF-8 bytes (what D1 actually limits):                        ${bytes.toLocaleString()}  cap ${D1_ROW_MAX.toLocaleString()}  -> ${bytes > D1_ROW_MAX ? "OVER D1's ROW LIMIT by " + ((bytes / D1_ROW_MAX - 1) * 100).toFixed(0) + "%" : "under"}`);
console.log(`ratio bytes/unit:    ${(bytes / utf16).toFixed(2)}\n`);

// Now the consequence, with D1 bound the way production has it.
const kv = makeKv(), db = makeD1(), env = makeEnv({ CONFIGS: kv, DB: db });
const U = await createUser(env, "bigjp");
// node:sqlite does not enforce D1's 2 MB row limit, so inject exactly the
// refusal D1 would give for an oversized bound parameter.
db.failWhen((sql, args) => /INSERT INTO creator_lists/i.test(sql) &&
  args.some((a) => typeof a === "string" && new TextEncoder().encode(a).length > D1_ROW_MAX));

const r = await call(env, "/api/creator/lists/save", { method: "POST", json: {
  creatorName: U.creatorName, creatorKey: U.creatorKey,
  name: "Anime Collection", type: "series", visibility: "public", items } });
console.log("POST /api/creator/lists/save ->", r.status, JSON.stringify(r.body).slice(0, 90));
console.log("KV record written:      ", kv._store.has(`creatorlist:bigjp:${r.body.slug}`));
console.log("D1 row written:         ", db._lists.has(`bigjp:${r.body.slug}`));
console.log("public page still works:", (await call(env, `/lists/bigjp/${r.body.slug}.json`)).status);

// Where the divergence actually shows.
const login = await call(env, "/admin/login", { method: "POST", form: { key: "test-admin-secret" } });
const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
const dash = await call(env, "/admin", { cookie });
console.log("admin dashboard lists it:", dash.text.includes("Anime Collection"));
const mig = await call(env, "/admin/api/migrate-d1", { method: "POST", cookie });
db.failWhen(null);
console.log("migrate-d1 repairs it:  ", JSON.stringify(mig.body.results && mig.body.results.errors || []).slice(0, 120) || "(no errors)");

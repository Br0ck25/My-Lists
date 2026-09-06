// Phase 8: adversarial /admin/api/migrate-d1.
import { makeKv, makeD1, makeEnv, call, createUser } from "../../tests/harness.mjs";
const R=[];const rec=(n,ok,d)=>{R.push({n,ok});console.log(ok?"PASS":"FAIL","-",n,d?"\n    "+d:"")};
const kv=makeKv(),db=makeD1(),env=makeEnv({CONFIGS:kv,DB:db});
const login=await call(env,"/admin/login",{method:"POST",form:{key:"test-admin-secret"}});
const cookie=(login.headers.get("set-cookie")||"").split(";")[0];
const S=(k,v)=>kv._store.set(k,typeof v==="string"?v:JSON.stringify(v));

// --- an ugly KV dataset, straight from the audit brief ---
S("creator:valid1",{displayName:"Valid",keyHash:"h1",recoveryAnswerHash:null,createdAt:1000});
S("creator:badjson1","{not json");
S("creator:nokeyhash",{displayName:"NoHash",createdAt:2000});
S("creator:noorder",{displayName:"NoOrder",keyHash:"h2",createdAt:3000});
S("creatorlist:valid1:good",{name:"Good",type:"movie",visibility:"public",items:[{id:"a"}],likes:5,createdAt:1,updatedAt:2});
S("creatorlist:valid1:legacyvis",{name:"Legacy",type:"movie",items:[],createdAt:1,updatedAt:2});       // no visibility
S("creatorlist:valid1:garbagevis",{name:"Garbage",type:"movie",visibility:"WHATEVER",items:[],createdAt:1,updatedAt:2});
S("creatorlist:valid1:likestring",{name:"LikeStr",type:"movie",visibility:"public",items:[],likes:"12",createdAt:1,updatedAt:2});
S("creatorlist:valid1:likeneg",{name:"LikeNeg",type:"movie",visibility:"public",items:[],likes:-4,createdAt:1,updatedAt:2});
S("creatorlist:valid1:badts",{name:"BadTs",type:"movie",visibility:"public",items:[],createdAt:"yesterday",updatedAt:null});
S("creatorlist:valid1:badjson","{{{");
S("creatorlist:ghostuser:orphan",{name:"Orphan",type:"movie",visibility:"public",items:[],createdAt:1,updatedAt:1}); // list without creator
S("publishedlist:user:anon1",{name:"Anon",type:"movie",items:[],createdAt:1});
S("publishedlist:user:anonbad","}}}");
S("stats:pageviews:total","4200");
S("stats:pageviews:2026-09-01","7");
S("stats:pageviews:notaday","99");
S("stats:apiuse:tmdb:total","31");
S("stats:sourcegroup:mygroup:total","9");
S("stats:corrupt:total","not-a-number");
S("stats:genres:alltime",{action:5});
S("stats:creator_count","4");

let r,guard=0;
do { r=await call(env,"/admin/api/migrate-d1",{method:"POST",cookie,json:{}}); } while(!r.body.done && ++guard<30);
console.log("migrate result:",JSON.stringify(r.body));

rec("migration completes", r.body.done===true, "");
rec("valid creator migrated", db._creators.has("valid1"),"");
rec("malformed creator JSON is reported, not silently dropped",
    (r.body.results.errors||[]).some(e=>e.includes("badjson1")) || r.body.results.skipped>0,
    `errors=${JSON.stringify(r.body.results.errors)} skipped=${r.body.results.skipped}`);
rec("list without a creator is not silently counted as migrated",
    !db._lists.has("ghostuser:orphan"),
    `orphan in D1 = ${db._lists.has("ghostuser:orphan")}; errors=${JSON.stringify(r.body.results.errors)}`);
const ls=id=>db._lists.get(id);
rec("likes stored as a string migrate as a number", ls("valid1:likestring") && ls("valid1:likestring").likes===12, JSON.stringify(ls("valid1:likestring")));
rec("negative likes are not migrated as-is", !(ls("valid1:likeneg")&&ls("valid1:likeneg").likes<0), JSON.stringify(ls("valid1:likeneg")));
rec("legacy no-visibility list is stamped public in KV", JSON.parse(kv._store.get("creatorlist:valid1:legacyvis")).visibility==="public", kv._store.get("creatorlist:valid1:legacyvis"));
rec("malformed timestamps do not break the row", !!ls("valid1:badts"), JSON.stringify(ls("valid1:badts")));
rec("stats counters migrated", db._stat("pageviews","total")===4200 && db._stat("pageviews","2026-09-01")===7,
    `total=${db._stat("pageviews","total")} day=${db._stat("pageviews","2026-09-01")}`);
rec("non-numeric counter is skipped and counted as skipped", db._stat("corrupt","total")===undefined, "");
rec("sourcegroup counted once, in its own table", db.q("SELECT * FROM source_groups").length===1 && db._stat("sourcegroup:mygroup","total")===undefined,
    JSON.stringify(db.q("SELECT * FROM source_groups"))+" statsRow="+db._stat("sourcegroup:mygroup","total"));

// --- rerun must not change valid data, and must not double counters ---
const snapBefore=JSON.stringify({c:db.q("SELECT * FROM creators ORDER BY username"),l:db.q("SELECT * FROM creator_lists ORDER BY id"),s:db.q("SELECT * FROM stats ORDER BY kind,day")});
guard=0; do { r=await call(env,"/admin/api/migrate-d1",{method:"POST",cookie,json:{}}); } while(!r.body.done && ++guard<30);
const snapAfter=JSON.stringify({c:db.q("SELECT * FROM creators ORDER BY username"),l:db.q("SELECT * FROM creator_lists ORDER BY id"),s:db.q("SELECT * FROM stats ORDER BY kind,day")});
rec("re-running the migration changes nothing", snapBefore===snapAfter, snapBefore===snapAfter?"":`before=${snapBefore}\n    after =${snapAfter}`);

// --- does migration roll newer D1 data back to older KV? ---
db._db.exec("UPDATE creator_lists SET likes=999, name='D1 NEWER', updated_at=9999999999999 WHERE id='valid1:good'");
guard=0; do { r=await call(env,"/admin/api/migrate-d1",{method:"POST",cookie,json:{}}); } while(!r.body.done && ++guard<30);
const g=ls("valid1:good");
console.log("\nafter migrate over a hand-edited D1 row:",JSON.stringify(g));
rec("migration restores KV's authoritative like count", g.likes===5, `likes=${g.likes}`);
rec("migration also repairs a drifted name/items in D1", g.name==="Good",
    `D1 name is still '${g.name}' - migrate-d1 DO UPDATE only sets likes+visibility, so name/type/items_json/updated_at can never be repaired`);

console.log("\n"+R.filter(x=>!x.ok).length+" FAILURES of "+R.length);

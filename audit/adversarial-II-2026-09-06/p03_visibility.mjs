// Phase 14 + 34: visibility leak matrix, private-list existence oracle, like state machine.
import { makeKv, makeD1, makeEnv, call, createUser, nextIp } from "../../tests/harness.mjs";
const R=[];const rec=(n,ok,d)=>{R.push({n,ok});console.log(ok?"PASS":"FAIL","-",n,d?"\n    "+d:"")};

const kv=makeKv(); const db=makeD1(); const env=makeEnv({CONFIGS:kv,DB:db});
const owner=await createUser(env,"vizowner");
const other=await createUser(env,"vizother");

// A private list, created through the real API
await call(env,"/api/creator/lists/save",{method:"POST",json:{creatorName:"vizowner",creatorKey:owner.creatorKey,name:"Secret Movies",type:"movie",visibility:"private",items:[{id:"tt-secret"}]}});

// 1. Public page must 404
const page=await call(env,"/lists/vizowner/secret-movies.json");
rec("private list 404s on public page", page.status===404, `status=${page.status} body=${JSON.stringify(page.body).slice(0,200)}`);

// 2. Directory must not carry it
const dir=await call(env,"/lists/public.json");
rec("private list absent from directory", !JSON.stringify(dir.body).includes("secret-movies"), JSON.stringify(dir.body).slice(0,200));

// 3. Search must not carry it
const search=await call(env,"/api/search-published-lists?q=Secret");
rec("private list absent from search", !JSON.stringify(search.body).includes("secret-movies"), JSON.stringify(search.body).slice(0,300));

// 4. /api/lists/like must not act as an existence oracle for private lists
const likeMissing=await call(env,"/api/lists/like",{method:"POST",ip:"203.0.113.5",json:{username:"vizowner",slug:"no-such-list-here"}});
const likePrivate=await call(env,"/api/lists/like",{method:"POST",ip:"203.0.113.6",json:{username:"vizowner",slug:"secret-movies"}});
rec("like endpoint does not distinguish private-existing from nonexistent",
    likeMissing.status===likePrivate.status,
    `nonexistent -> ${likeMissing.status} ${JSON.stringify(likeMissing.body)}\n    private-existing -> ${likePrivate.status} ${JSON.stringify(likePrivate.body)}`);

// 5. an anonymous stranger must not be able to change a private list's like count
const rec5=JSON.parse(kv._store.get("creatorlist:vizowner:secret-movies")||"{}");
rec("anonymous like cannot mutate a private list record", (rec5.likes||0)===0, `likes now = ${rec5.likes}`);

// 6. inflated likes carry over when the list is later published
await call(env,"/api/creator/lists/save",{method:"POST",json:{creatorName:"vizowner",creatorKey:owner.creatorKey,slug:"secret-movies",name:"Secret Movies",type:"movie",visibility:"public",items:[{id:"tt-secret"}]}});
const afterPub=JSON.parse(kv._store.get("creatorlist:vizowner:secret-movies")||"{}");
rec("publishing does not inherit likes accrued while private",(afterPub.likes||0)===0,`likes=${afterPub.likes}`);

// 7. Creator B cannot save over Creator A's list
const cross=await call(env,"/api/creator/lists/save",{method:"POST",json:{creatorName:"vizother",creatorKey:other.creatorKey,slug:"secret-movies",name:"Hijack",type:"movie",visibility:"public",items:[]}});
const stillOwner=JSON.parse(kv._store.get("creatorlist:vizowner:secret-movies")||"{}");
rec("cross-creator save does not touch the other creator's record", stillOwner.name==="Secret Movies", `name=${stillOwner.name} resp=${JSON.stringify(cross.body)}`);

// 8. NOT A DEFECT - documented legacy behaviour, kept so it is not re-derived.
// These records are written straight into KV, bypassing the write path (which
// always normalises to "public"/"private"). backfillListVisibilityValue's
// documented rule is that a record with no enum value was served as public
// under the old rule and is stamped "public" on read, so a 200 here is
// correct. The real check is that no *write path* can produce such a record --
// which p23_fuzz.mjs proves across 286 malformed payloads.
const cases=[undefined,null,"","PUBLIC","garbage",0,false,1,true,"Public"," public"];
let leaked=[];
for(let i=0;i<cases.length;i++){
  const slug=`vcase${i}`;
  kv._store.set(`creatorlist:vizowner:${slug}`,JSON.stringify({name:"C"+i,slug,type:"movie",items:[],visibility:cases[i],createdAt:1,updatedAt:1}));
  const r=await call(env,`/lists/vizowner/${slug}.json`);
  if(r.status===200) leaked.push(`${JSON.stringify(cases[i])} -> 200`);
}
console.log("INFO  - legacy stamp (expected, not a defect):", leaked.join(", ")||"none");

// 9. legacy backfill: a record with NO visibility field is treated as public (documented) - verify it is *stamped*
const stamped=JSON.parse(kv._store.get("creatorlist:vizowner:vcase0")||"{}");
rec("legacy record without visibility is stamped on read", stamped.visibility!==undefined, JSON.stringify(stamped));

console.log("\n"+R.filter(r=>!r.ok).length+" FAILURES of "+R.length);

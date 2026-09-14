// Phase 20/21/32: pagination correctness, caps, off-by-one, index rebuild at scale.
import { makeKv, makeEnv, call, worker } from "../../tests/harness.mjs";
const R=[];const rec=(n,ok,d)=>{R.push({n,ok});console.log(ok?"PASS":"FAIL","-",n,d?"\n    "+d:"")};

function seed(n){
  const kv=makeKv();
  for(let i=0;i<n;i++){
    const slug=`list-${String(i).padStart(6,"0")}`;
    kv._store.set(`creatorlist:owner:${slug}`,JSON.stringify({name:`List ${i}`,slug,type:"movie",visibility:"public",items:[{id:"x"}],likes:i,createdAt:1,updatedAt:1}));
  }
  kv._store.set("creator:owner",JSON.stringify({displayName:"Owner",keyHash:"h",createdAt:1}));
  return kv;
}
async function fullRebuild(env){
  let guard=0;
  while(guard++<200){
    const pending=[]; const ctx={waitUntil(p){pending.push(Promise.resolve(p).catch(()=>{}))}};
    const before=env.CONFIGS._store.get("index:publiclists");
    await call(env,"/lists/public.json");
    // drive the chunked build to completion via the admin path instead
    break;
  }
}
for(const n of [999,1000,1001,1999,2000,2001]){
  const kv=seed(n); const env=makeEnv({CONFIGS:kv});
  const login=await call(env,"/admin/login",{method:"POST",form:{key:"test-admin-secret"}});
  const cookie=(login.headers.get("set-cookie")||"").split(";")[0];
  let r,guard=0;
  do { r=await call(env,"/admin/api/rebuild-public-index",{method:"POST",cookie,json:{}}); } while(!r.body.done && ++guard<500);
  const idx=JSON.parse(kv._store.get("index:publiclists")||'{"entries":[]}');
  // page through /lists/public.json and check no dupes / no gaps
  const seen=new Set(); let dup=0, total=null;
  for(let off=0;off<idx.entries.length+600;off+=500){
    const page=await call(env,`/lists/public.json?limit=500&offset=${off}`);
    total=page.body.total;
    for(const l of page.body.lists){ if(seen.has(l.slug)) dup++; seen.add(l.slug); }
    if(!page.body.lists.length) break;
  }
  const cap = idx.entries.length;
  rec(`n=${n}: index build completes and paging returns every indexed entry exactly once`,
      dup===0 && seen.size===cap,
      `seeded=${n} indexed=${cap} pagedUnique=${seen.size} dupes=${dup} total=${total} rebuildCalls=${guard}`);
}
console.log("\n"+R.filter(x=>!x.ok).length+" FAILURES of "+R.length);

// Phase 5/13/14/29: per-list delete + visibility transitions under partial failure.
import { makeKv, makeD1, makeEnv, call, createUser } from "../../tests/harness.mjs";
const R = []; const rec=(n,ok,d)=>{R.push({n,ok});console.log(ok?"PASS":"FAIL","-",n,d?"\n    "+d:"")};

async function mk(name){
  const kv=makeKv(); const db=makeD1(); const env=makeEnv({CONFIGS:kv,DB:db});
  const u=await createUser(env,name);
  await call(env,"/api/creator/lists/save",{method:"POST",json:{creatorName:name,creatorKey:u.creatorKey,name:"Pub List",type:"movie",visibility:"public",items:[{id:"tt1"}]}});
  await call(env,"/lists/public.json"); // materialise index
  return {kv,db,env,u};
}
const inIndex=(kv,frag)=>{const r=kv._store.get("index:publiclists");return r?JSON.parse(r).entries.some(e=>String(e.id).includes(frag)):false;};

// A. KV delete of the list record fails -> route still says ok:true
{
  const {kv,env,u}=await mk("dela1");
  kv._hooks.beforeDelete=async k=>{ if(k.startsWith("creatorlist:")) throw new Error("KV delete down"); };
  const res=await call(env,"/api/creator/lists/delete",{method:"POST",json:{creatorName:"dela1",creatorKey:u.creatorKey,slug:"pub-list"}});
  kv._hooks.beforeDelete=null;
  const stillThere=kv._store.has("creatorlist:dela1:pub-list");
  const page=await call(env,"/lists/dela1/pub-list.json");
  rec("delete list: KV delete failure is not reported as ok",
      !(res.body&&res.body.ok===true&&stillThere),
      `resp=${JSON.stringify(res.body)} recordStillInKV=${stillThere} publicPageStatus=${page.status}`);
}

// B. public index write fails during list delete -> route still says ok:true
{
  const {kv,env,u}=await mk("delb1");
  kv._hooks.beforePut=async k=>{ if(k==="index:publiclists") throw new Error("KV index down"); };
  const res=await call(env,"/api/creator/lists/delete",{method:"POST",json:{creatorName:"delb1",creatorKey:u.creatorKey,slug:"pub-list"}});
  kv._hooks.beforePut=null;
  rec("delete list: directory-removal failure is not reported as ok",
      !(res.body&&res.body.ok===true&&inIndex(kv,"delb1")),
      `resp=${JSON.stringify(res.body)} stillInDirectory=${inIndex(kv,"delb1")}`);
  const dir=await call(env,"/lists/public.json");
  rec("delete list: deleted list is not served by /lists/public.json",
      !JSON.stringify(dir.body).includes("delb1"), JSON.stringify(dir.body).slice(0,300));
}

// C. make private: index removal fails -> route reports failure (expected pass)
{
  const {kv,env,u}=await mk("delc1");
  kv._hooks.beforePut=async k=>{ if(k==="index:publiclists") throw new Error("KV index down"); };
  const res=await call(env,"/api/creator/lists/save",{method:"POST",json:{creatorName:"delc1",creatorKey:u.creatorKey,slug:"pub-list",name:"Pub List",type:"movie",visibility:"private",items:[{id:"tt1"}]}});
  kv._hooks.beforePut=null;
  rec("make-private: directory failure reported",
      !(res.body&&res.body.ok===true&&inIndex(kv,"delc1")),
      `resp=${JSON.stringify(res.body)} stillInDirectory=${inIndex(kv,"delc1")}`);
}

// D. account/reset with failing index write
{
  const {kv,env,u}=await mk("delr1");
  kv._hooks.beforePut=async k=>{ if(k==="index:publiclists") throw new Error("KV index down"); };
  const res=await call(env,"/api/creator/account/reset",{method:"POST",json:{creatorName:"delr1",creatorKey:u.creatorKey,confirm:"RESET"}});
  kv._hooks.beforePut=null;
  rec("account/reset: directory failure reported",
      !(res.body&&res.body.ok===true&&inIndex(kv,"delr1")),
      `resp=${JSON.stringify(res.body)} stillInDirectory=${inIndex(kv,"delr1")}`);
}

// E. admin delete-creator-list with failing index write
{
  const {kv,env}=await mk("dele1");
  const login=await call(env,"/admin/login",{method:"POST",form:{key:"test-admin-secret"}});
  const cookie=(login.headers.get("set-cookie")||"").split(";")[0];
  kv._hooks.beforePut=async k=>{ if(k==="index:publiclists") throw new Error("KV index down"); };
  const res=await call(env,"/admin/api/delete-creator-list",{method:"POST",cookie,json:{username:"dele1",slug:"pub-list"}});
  kv._hooks.beforePut=null;
  rec("admin delete-creator-list: directory failure reported",
      !(res.body&&res.body.ok===true&&inIndex(kv,"dele1")),
      `resp=${JSON.stringify(res.body)} stillInDirectory=${inIndex(kv,"dele1")}`);
}
console.log("\n"+R.filter(r=>!r.ok).length+" FAILURES of "+R.length);

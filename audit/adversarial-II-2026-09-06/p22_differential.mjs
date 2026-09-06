// Phase 10: differential KV-only vs KV+D1. Every externally observable
// operation must behave identically.
import { makeKv, makeD1, makeEnv, call, createUser } from "../../tests/harness.mjs";
const diffs=[];
function norm(x){
  return JSON.parse(JSON.stringify(x, (k,v)=>{
    if(["updatedAt","createdAt","publishedAt","version","token","creatorKey","url","jsonUrl","freshUntil","lastPingAt"].includes(k)) return "<vary>";
    return v;
  }));
}
async function scenario(env, tag){
  const out=[];
  const rec=(label,r)=>out.push({label,status:r.status,body:norm(r.body)});
  const u=await createUser(env,"diff"+tag,{recoveryAnswer:"a long recovery answer here"});
  const K={creatorName:"diff"+tag,creatorKey:u.creatorKey};
  const rename=(o)=>JSON.parse(JSON.stringify(o).replaceAll("diff"+tag,"USER"));
  rec("create-dup",await call(env,"/api/creator/create",{method:"POST",json:{creatorName:"diff"+tag}}));
  rec("save-public",await call(env,"/api/creator/lists/save",{method:"POST",json:{...K,name:"P",type:"movie",visibility:"public",items:[{id:"a"}]}}));
  rec("save-private",await call(env,"/api/creator/lists/save",{method:"POST",json:{...K,name:"Q",type:"movie",visibility:"private",items:[{id:"b"}]}}));
  rec("lists",await call(env,"/api/creator/lists",{method:"POST",json:K}));
  rec("public-page",await call(env,`/lists/diff${tag}/p.json`));
  rec("private-page",await call(env,`/lists/diff${tag}/q.json`));
  rec("directory",await call(env,"/lists/public.json"));
  rec("search",await call(env,"/api/search-published-lists?q=P"));
  rec("like",await call(env,"/api/lists/like",{method:"POST",ip:"203.0.113.9",json:{username:"diff"+tag,slug:"p"}}));
  rec("like-again",await call(env,"/api/lists/like",{method:"POST",ip:"203.0.113.9",json:{username:"diff"+tag,slug:"p"}}));
  rec("unlike",await call(env,"/api/lists/like",{method:"POST",ip:"203.0.113.9",json:{username:"diff"+tag,slug:"p",action:"unlike"}}));
  rec("make-private",await call(env,"/api/creator/lists/save",{method:"POST",json:{...K,slug:"p",name:"P",type:"movie",visibility:"private",items:[{id:"a"}]}}));
  rec("directory-after",await call(env,"/lists/public.json"));
  rec("reorder",await call(env,"/api/creator/lists/reorder",{method:"POST",json:{...K,order:["q","p"]}}));
  rec("sync-save",await call(env,"/api/creator/sync/save",{method:"POST",json:{...K,config:[{z:1}]}}));
  rec("sync-load",await call(env,"/api/creator/sync/load",{method:"POST",json:K}));
  rec("rotate",await call(env,"/api/creator/reset-key",{method:"POST",json:{username:"diff"+tag,recoveryAnswer:"a long recovery answer here"}}));
  const oldRestore=await call(env,"/api/creator/restore",{method:"POST",json:K});
  rec("old-key-after-rotate",oldRestore);
  return rename(out);
}
const a=await scenario(makeEnv({CONFIGS:makeKv()}),"kv");
const b=await scenario(makeEnv({CONFIGS:makeKv(),DB:makeD1()}),"d1");
for(let i=0;i<a.length;i++){
  const A=JSON.stringify(a[i]), B=JSON.stringify(b[i]);
  if(A!==B) diffs.push(`${a[i].label}\n    KV-only : ${A}\n    KV+D1   : ${B}`);
}
console.log(diffs.length? "BEHAVIOURAL DIFFERENCES between KV-only and KV+D1:\n  "+diffs.join("\n  ")
                        : "PASS - KV-only and KV+D1 are observationally identical across "+a.length+" operations");

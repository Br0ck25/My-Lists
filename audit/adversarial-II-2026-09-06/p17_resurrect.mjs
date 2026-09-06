// Phase 5/13/33: a write in flight during account deletion resurrects account data.
import { makeKv, makeD1, makeEnv, call, createUser } from "../../tests/harness.mjs";
const R=[];const rec=(n,ok,d)=>{R.push({n,ok});console.log(ok?"PASS":"FAIL","-",n,d?"\n    "+d:"")};

const kv=makeKv(),db=makeD1(),env=makeEnv({CONFIGS:kv,DB:db});
const u=await createUser(env,"ghost1");
const K={creatorName:"ghost1",creatorKey:u.creatorKey};
await call(env,"/api/creator/sync/save",{method:"POST",json:{...K,config:[{original:true}]}});

// Hold the in-flight save's KV write until the delete has completed.
let release; const gate=new Promise(r=>release=r);
kv._hooks.beforePut=async(k)=>{ if(k==="creatorsync:ghost1"){ kv._hooks.beforePut=null; await gate; } };
const inflight=call(env,"/api/creator/sync/save",{method:"POST",json:{...K,config:[{inflight:true}]}});
await new Promise(r=>setTimeout(r,20));
const del=await call(env,"/api/creator/delete-account",{method:"POST",json:{...K,confirm:"DELETE"}});
release();
const saved=await inflight;

const leftovers=[...kv._store.keys()].filter(k=>k.includes("ghost1"));
rec("delete-account reported success", del.body.ok===true, JSON.stringify(del.body));
rec("no account data survives a write that was in flight during deletion",
    leftovers.length===0,
    `in-flight save responded ${saved.status} ${JSON.stringify(saved.body)}\n    KV keys left behind: ${JSON.stringify(leftovers)}`);

// Someone else now claims the freed username.
const b=await createUser(env,"ghost1");
const load=await call(env,"/api/creator/sync/load",{method:"POST",json:{creatorName:"ghost1",creatorKey:b.creatorKey}});
rec("a reclaimed username does not inherit the resurrected blob",
    JSON.stringify(load.body.data.config)==="[]",
    `new owner's config = ${JSON.stringify(load.body.data.config)}`);
console.log("\n"+R.filter(x=>!x.ok).length+" FAILURES of "+R.length);

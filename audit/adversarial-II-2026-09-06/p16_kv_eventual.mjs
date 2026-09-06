// Phase 27 blind spot + Phase 28 claim: "the old key stops working immediately".
// Models Cloudflare KV's documented read semantics: a read can be served from an
// edge cache for up to ~60s after a write, from a colo that did not serve the write.
import { makeKv, makeD1, makeEnv, call, createUser, worker } from "../../tests/harness.mjs";
const R=[];const rec=(n,ok,d)=>{R.push({n,ok});console.log(ok?"PASS":"FAIL","-",n,d?"\n    "+d:"")};

// A KV whose reads can be served from a snapshot taken before a write ("another colo").
function makeEventualKv(){
  const base=makeKv();
  let staleSnapshot=null;
  return {
    ...base,
    _store: base._store,
    _hooks: base._hooks,
    freezeSnapshot(){ staleSnapshot=new Map(base._store); },
    thaw(){ staleSnapshot=null; },
    async get(k,t){
      if(staleSnapshot){
        if(!staleSnapshot.has(k)) return null;
        const raw=staleSnapshot.get(k);
        return t==="json"?(()=>{try{return JSON.parse(raw)}catch{return null}})():raw;
      }
      return base.get(k,t);
    },
    put:base.put, delete:base.delete, list:base.list,
  };
}

// --- key rotation ---
{
  const kv=makeEventualKv(), db=makeD1(), env=makeEnv({CONFIGS:kv,DB:db});
  const u=await createUser(env,"evkey1",{recoveryAnswer:"a long recovery answer"});
  const oldKey=u.creatorKey;
  const rot=await call(env,"/api/creator/reset-key",{method:"POST",json:{username:"evkey1",recoveryAnswer:"a long recovery answer"}});
  // Another colo has not seen the new value yet: its reads still serve the pre-rotation record.
  kv.freezeSnapshotFromBefore = null;
  // rebuild a "before" snapshot by restoring the old profile into a stale view
  const stale=new Map(kv._store);
  stale.set("creator:evkey1", JSON.stringify({...JSON.parse(kv._store.get("creator:evkey1")), keyHash: await (async()=>{ // old hash
      // recover the old hash from D1? it was overwritten. Instead: simulate by re-creating from the original create.
      return null; })()}));
  // Simpler and faithful: capture the record BEFORE rotating, in a second run.
  const kv2=makeEventualKv(), db2=makeD1(), env2=makeEnv({CONFIGS:kv2,DB:db2});
  const u2=await createUser(env2,"evkey2",{recoveryAnswer:"a long recovery answer"});
  const beforeRecord=kv2._store.get("creator:evkey2");
  const rot2=await call(env2,"/api/creator/reset-key",{method:"POST",json:{username:"evkey2",recoveryAnswer:"a long recovery answer"}});
  // now simulate the stale colo: its KV get returns the pre-rotation record
  const snap=new Map(kv2._store); snap.set("creator:evkey2", beforeRecord);
  kv2.__snap=snap;
  const origGet=kv2.get;
  kv2.get=async(k,t)=>{ if(k==="creator:evkey2"){ const raw=snap.get(k); return t==="json"?JSON.parse(raw):raw; } return origGet(k,t); };
  const oldOnStaleColo=await call(env2,"/api/creator/restore",{method:"POST",json:{creatorName:"evkey2",creatorKey:u2.creatorKey}});
  const newOnStaleColo=await call(env2,"/api/creator/restore",{method:"POST",json:{creatorName:"evkey2",creatorKey:rot2.body.creatorKey}});
  kv2.get=origGet;
  rec("rotated-away key stops authenticating even on a colo serving a stale KV read",
      !(oldOnStaleColo.body&&oldOnStaleColo.body.ok===true),
      `old key on stale colo -> ${JSON.stringify(oldOnStaleColo.body)}\n    new key on stale colo -> ${JSON.stringify(newOnStaleColo.body)}\n    (D1 already holds the new hash, but getCreator prefers KV and only falls back on a MISS)`);
}

// --- account deletion ---
{
  const kv=makeEventualKv(), db=makeD1(), env=makeEnv({CONFIGS:kv,DB:db});
  const u=await createUser(env,"evdel1");
  const beforeRecord=kv._store.get("creator:evdel1");
  await call(env,"/api/creator/delete-account",{method:"POST",json:{creatorName:"evdel1",creatorKey:u.creatorKey,confirm:"DELETE"}});
  const origGet=kv.get;
  kv.get=async(k,t)=>{ if(k==="creator:evdel1"){ return t==="json"?JSON.parse(beforeRecord):beforeRecord; } return origGet(k,t); };
  const afterDelete=await call(env,"/api/creator/restore",{method:"POST",json:{creatorName:"evdel1",creatorKey:u.creatorKey}});
  const canStillWrite=await call(env,"/api/creator/sync/save",{method:"POST",json:{creatorName:"evdel1",creatorKey:u.creatorKey,config:[{ghost:true}]}});
  kv.get=origGet;
  rec("deleted account stops authenticating even on a colo serving a stale KV read",
      !(afterDelete.body&&afterDelete.body.ok===true),
      `restore -> ${JSON.stringify(afterDelete.body)}; sync/save -> ${JSON.stringify(canStillWrite.body)}; resurrected KV key present = ${kv._store.has("creatorsync:evdel1")}`);
}
console.log("\n"+R.filter(x=>!x.ok).length+" FAILURES of "+R.length);

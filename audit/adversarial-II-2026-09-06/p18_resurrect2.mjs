// Which write paths can resurrect a deleted account's data?
import { makeKv, makeD1, makeEnv, call, createUser } from "../../tests/harness.mjs";
const paths=[
  ["/api/creator/sync/save",       b=>({...b,config:[{x:1}],keys:{tmdb:"VICTIM-TMDB-KEY"}}), "creatorsync:"],
  ["/api/creator/sync/save-tracking", b=>({...b,watchHistory:[{id:"tt-private"}]}),          "creatorsynctracking:"],
  ["/api/creator/sync/save-presets",  b=>({...b,presets:{p:{name:"p"}}}),                     "creatorsyncpresets:"],
  ["/api/creator/sync/save-channels", b=>({...b,channels:{c:{}}}),                            "creatorsyncchannels:"],
  ["/api/creator/lists/save",         b=>({...b,name:"Ghost List",type:"movie",visibility:"public",items:[]}), "creatorlist:"],
  ["/api/creator/sync/share-tracking",b=>({...b,slug:"watchlist",shared:true}),                "creatorshare:"],
  ["/api/creator/scrobble-token",     b=>({...b}),                                            "creatorscrobbletoken:"],
];
for(const [route,mk,prefix] of paths){
  const kv=makeKv(),db=makeD1(),env=makeEnv({CONFIGS:kv,DB:db});
  const name="res"+prefix.replace(/[^a-z]/g,"").slice(0,12);
  const u=await createUser(env,name);
  const K={creatorName:name,creatorKey:u.creatorKey};
  let release; const gate=new Promise(r=>release=r); let armed=true;
  kv._hooks.beforePut=async(k)=>{ if(armed && k.startsWith(prefix) && k.includes(name)){ armed=false; await gate; } };
  const inflight=call(env,route,{method:"POST",json:mk(K)});
  await new Promise(r=>setTimeout(r,25));
  const del=await call(env,"/api/creator/delete-account",{method:"POST",json:{...K,confirm:"DELETE"}});
  release(); const done=await inflight; kv._hooks.beforePut=null;
  const left=[...kv._store.keys()].filter(k=>k.includes(name));
  console.log(`${left.length?"RESURRECTED":"clean      "}  ${route.padEnd(36)} delete=${JSON.stringify(del.body.ok)} inflight=${done.status} leftover=${JSON.stringify(left)}`);
}

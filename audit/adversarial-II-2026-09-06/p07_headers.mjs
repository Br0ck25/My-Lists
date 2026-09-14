// Phase 16: response cache-header audit on sensitive endpoints.
import { makeKv, makeD1, makeEnv, call, createUser } from "../../tests/harness.mjs";
const kv=makeKv(),db=makeD1(),env=makeEnv({CONFIGS:kv,DB:db});
const u=await createUser(env,"hdr1",{recoveryAnswer:"a very long recovery answer"});
const K={creatorName:"hdr1",creatorKey:u.creatorKey};
await call(env,"/api/creator/lists/save",{method:"POST",json:{...K,name:"Pub",type:"movie",visibility:"public",items:[{id:"tt1"}]}});
await call(env,"/api/creator/lists/save",{method:"POST",json:{...K,name:"Priv",type:"movie",visibility:"private",items:[{id:"tt2"}]}});
await call(env,"/api/creator/sync/save",{method:"POST",json:{...K,config:[{secret:"my-tmdb-key"}],keys:{tmdb:"SECRETKEY123"}}});
const login=await call(env,"/admin/login",{method:"POST",form:{key:"test-admin-secret"}});
const cookie=(login.headers.get("set-cookie")||"").split(";")[0];

const probes=[
  ["POST","/api/creator/lists",{json:K},"private+public list contents"],
  ["POST","/api/creator/sync/load",{json:K},"full account sync blob incl. provider API keys"],
  ["POST","/api/creator/sync/meta",{json:K},"account metadata"],
  ["POST","/api/creator/restore",{json:K},"account identity"],
  ["POST","/api/creator/track-status",{json:K},"playback diagnostics"],
  ["GET","/lists/hdr1/pub.json",{},"public list json"],
  ["GET","/lists/public.json",{},"directory"],
  ["GET","/api/search-published-lists?q=Pub",{},"search"],
  ["GET","/admin/api/analytics",{cookie},"admin analytics"],
  ["GET","/admin/api/apiusage",{cookie},"admin api usage"],
  ["GET","/admin/api/leaderboard",{cookie},"admin leaderboard"],
  ["GET","/admin/api/feedback",{cookie},"admin feedback (user emails)"],
  ["GET","/admin",{cookie},"admin dashboard html"],
];
console.log("METHOD PATH".padEnd(46),"STATUS","CACHE-CONTROL".padEnd(28),"VARY");
const bad=[];
for(const [m,p,opts,label] of probes){
  const r=await call(env,p,{method:m,...opts});
  const cc=r.headers.get("cache-control")||"(none)";
  const vary=r.headers.get("vary")||"(none)";
  console.log(`${m} ${p}`.padEnd(46), String(r.status).padEnd(6), cc.padEnd(28), vary, "|", label);
  const sensitive=/creator|admin|sync|restore|track-status/.test(p);
  if(sensitive && !/no-store|no-cache|private/.test(cc)) bad.push(`${m} ${p} -> ${cc}`);
}
console.log("\nSensitive endpoints WITHOUT a no-store/private cache directive:");
console.log(bad.length? bad.map(x=>"  "+x).join("\n") : "  none");

// Does making a list private change what a cache would have kept?
const before=await call(env,"/lists/hdr1/pub.json");
console.log("\npublic list json cache-control:",before.headers.get("cache-control"));
await call(env,"/api/creator/lists/save",{method:"POST",json:{...K,slug:"pub",name:"Pub",type:"movie",visibility:"private",items:[{id:"tt1"}]}});
const after=await call(env,"/lists/hdr1/pub.json");
console.log("after making it private, status:",after.status,"cache-control:",after.headers.get("cache-control"));

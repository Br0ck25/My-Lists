// Phase 12: force real interleaving on the single creatorlistorder key.
import { makeKv, makeEnv, call, createUser } from "../../tests/harness.mjs";
const kv=makeKv(),env=makeEnv({CONFIGS:kv});
const u=await createUser(env,"racer1");
const K={creatorName:"racer1",creatorKey:u.creatorKey};
// Make every KV get take a real tick so concurrent handlers genuinely interleave.
kv._hooks.beforeGet=async()=>{ await new Promise(r=>setTimeout(r,1)); };
const saves=[];
for(let i=0;i<12;i++) saves.push(call(env,"/api/creator/lists/save",{method:"POST",json:{...K,name:"List "+i,type:"movie",visibility:"private",items:[]}}));
const res=await Promise.all(saves);
kv._hooks.beforeGet=null;
const order=JSON.parse(kv._store.get("creatorlistorder:racer1")).order;
const records=[...kv._store.keys()].filter(k=>k.startsWith("creatorlist:racer1:")).map(k=>k.slice("creatorlist:racer1:".length));
const dash=await call(env,"/api/creator/lists",{method:"POST",json:K});
console.log("returned slugs :",res.map(r=>r.body.slug).join(","));
console.log("kv records     :",records.length,JSON.stringify(records));
console.log("order entries  :",order.length,JSON.stringify(order));
console.log("dashboard lists:",dash.body.lists.length,JSON.stringify(dash.body.lists.map(l=>l.slug)));
const missingFromOrder=records.filter(s=>!order.includes(s));
console.log(missingFromOrder.length? "FAIL - records missing from order: "+JSON.stringify(missingFromOrder) : "PASS - order covers every record");
console.log(dash.body.lists.length===records.length? "PASS - dashboard shows all records":"FAIL - dashboard shows "+dash.body.lists.length+" of "+records.length);

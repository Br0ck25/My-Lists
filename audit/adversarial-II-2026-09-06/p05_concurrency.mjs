// Phase 12 + 25: optimistic concurrency attack + clock behaviour.
import { makeKv, makeD1, makeEnv, call, createUser } from "../../tests/harness.mjs";
const R=[];const rec=(n,ok,d)=>{R.push({n,ok});console.log(ok?"PASS":"FAIL","-",n,d?"\n    "+d:"")};

const kv=makeKv(),db=makeD1(),env=makeEnv({CONFIGS:kv,DB:db});
const u=await createUser(env,"concur1");
const K={creatorName:"concur1",creatorKey:u.creatorKey};

// baseline
let r=await call(env,"/api/creator/sync/save",{method:"POST",json:{...K,config:[{v:1}]}});
const v1=r.body.updatedAt;

// A: classic stale write
await call(env,"/api/creator/sync/save",{method:"POST",json:{...K,config:[{v:2}],expectedUpdatedAt:v1}});
const stale=await call(env,"/api/creator/sync/save",{method:"POST",json:{...K,config:[{v:3}],expectedUpdatedAt:v1}});
rec("stale sync/save is rejected", stale.status===409, `${stale.status} ${JSON.stringify(stale.body)}`);

// B: a client that omits expectedUpdatedAt still clobbers (documented additive behaviour)
const noGuard=await call(env,"/api/creator/sync/save",{method:"POST",json:{...K,config:[{v:99}]}});
const cur=JSON.parse(kv._store.get("creatorsync:concur1"));
rec("legacy client without expectedUpdatedAt overwrites (documented)", cur.config[0].v===99, `config=${JSON.stringify(cur.config)}`);

// C: cross-blob independence - a stale CONFIG save must not destroy tracking/presets/channels
await call(env,"/api/creator/sync/save-tracking",{method:"POST",json:{...K,watchHistory:[{id:"h1"}]}});
await call(env,"/api/creator/sync/save-presets",{method:"POST",json:{...K,presets:{p:{name:"p"}}}});
await call(env,"/api/creator/sync/save-channels",{method:"POST",json:{...K,channels:{c:{}}}});
await call(env,"/api/creator/sync/save",{method:"POST",json:{...K,config:[{v:100}]}});
const load=await call(env,"/api/creator/sync/load",{method:"POST",json:K});
const d=load.body.data;
rec("config save does not destroy tracking", d.watchHistory&&d.watchHistory.length===1, JSON.stringify(d.watchHistory));
rec("config save does not destroy presets", d.presets&&Object.keys(d.presets).length===1, JSON.stringify(d.presets));
rec("config save does not destroy channels", d.channels&&Object.keys(d.channels).length===1, JSON.stringify(d.channels));

// D: same-millisecond writes (Date.now frozen per request in Workers)
{
  const kv2=makeKv(),env2=makeEnv({CONFIGS:kv2});
  const u2=await createUser(env2,"concur2");
  const K2={creatorName:"concur2",creatorKey:u2.creatorKey};
  const realNow=Date.now; const frozen=realNow();
  Date.now=()=>frozen;
  const a=await call(env2,"/api/creator/sync/save",{method:"POST",json:{...K2,config:[{v:"A"}]}});
  const b=await call(env2,"/api/creator/sync/save",{method:"POST",json:{...K2,config:[{v:"B"}],expectedUpdatedAt:a.body.updatedAt}});
  const c=await call(env2,"/api/creator/sync/save",{method:"POST",json:{...K2,config:[{v:"C"}],expectedUpdatedAt:a.body.updatedAt}});
  Date.now=realNow;
  rec("frozen clock: second stale write still rejected", c.status===409,
      `a=${a.body.updatedAt} b=${b.status}/${b.body.updatedAt} c=${c.status} ${JSON.stringify(c.body)}`);
}

// E: clock moves BACKWARD between saves
{
  const kv3=makeKv(),env3=makeEnv({CONFIGS:kv3});
  const u3=await createUser(env3,"concur3");
  const K3={creatorName:"concur3",creatorKey:u3.creatorKey};
  const realNow=Date.now; let t=realNow();
  Date.now=()=>t;
  const a=await call(env3,"/api/creator/sync/save",{method:"POST",json:{...K3,config:[{v:"A"}]}});
  t = t - 60000; // clock jumps back a minute
  const b=await call(env3,"/api/creator/sync/save",{method:"POST",json:{...K3,config:[{v:"B"}],expectedUpdatedAt:a.body.updatedAt}});
  const cAfter=await call(env3,"/api/creator/sync/save",{method:"POST",json:{...K3,config:[{v:"C"}],expectedUpdatedAt:a.body.updatedAt}});
  Date.now=realNow;
  rec("backward clock: version stays strictly increasing and stale is rejected",
      b.body.updatedAt>a.body.updatedAt && cAfter.status===409,
      `a=${a.body.updatedAt} b=${b.body.updatedAt} cStatus=${cAfter.status}`);
}

// F: list save has NO concurrency guard - two devices editing the same list
{
  const kv4=makeKv(),env4=makeEnv({CONFIGS:kv4});
  const u4=await createUser(env4,"concur4");
  const K4={creatorName:"concur4",creatorKey:u4.creatorKey};
  await call(env4,"/api/creator/lists/save",{method:"POST",json:{...K4,name:"Shared",type:"movie",visibility:"private",items:[{id:"1"}]}});
  const A=call(env4,"/api/creator/lists/save",{method:"POST",json:{...K4,slug:"shared",name:"Shared",type:"movie",visibility:"private",items:[{id:"1"},{id:"2"}]}});
  const B=call(env4,"/api/creator/lists/save",{method:"POST",json:{...K4,slug:"shared",name:"Shared",type:"movie",visibility:"private",items:[{id:"1"},{id:"3"}]}});
  await Promise.all([A,B]);
  const stored=JSON.parse(kv4._store.get("creatorlist:concur4:shared"));
  rec("list save offers some staleness protection", false,
      `INFO ONLY: concurrent list edits last-write-wins, stored items = ${JSON.stringify(stored.items)}; endpoint accepts no expectedUpdatedAt`);
}

// G: reorder vs save race on the single creatorlistorder key
{
  const kv5=makeKv(),env5=makeEnv({CONFIGS:kv5});
  const u5=await createUser(env5,"concur5");
  const K5={creatorName:"concur5",creatorKey:u5.creatorKey};
  const saves=[];
  for(let i=0;i<8;i++) saves.push(call(env5,"/api/creator/lists/save",{method:"POST",json:{...K5,name:"L"+i,type:"movie",visibility:"private",items:[]}}));
  const done=await Promise.all(saves);
  const order=JSON.parse(kv5._store.get("creatorlistorder:concur5")).order;
  const records=[...kv5._store.keys()].filter(k=>k.startsWith("creatorlist:concur5:"));
  rec("concurrent list creation keeps order and records in step",
      order.length===records.length,
      `orderEntries=${order.length} ${JSON.stringify(order)} kvRecords=${records.length} ${JSON.stringify(records.map(k=>k.split(":").pop()))}`);
  const dash=await call(env5,"/api/creator/lists",{method:"POST",json:K5});
  rec("dashboard shows every list that exists",
      dash.body.lists.length===records.length,
      `dashboard=${dash.body.lists.length} kvRecords=${records.length}`);
}

console.log("\n"+R.filter(r=>!r.ok).length+" FAILURES of "+R.length);

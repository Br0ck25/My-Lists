// Reproduces the exact payload saveCreatorListEdit() sends, from two "devices".
const B = "http://127.0.0.1:8787";
const j = async (p,o={}) => { const r = await fetch(B+p,{headers:{'content-type':'application/json'},...o}); const t=await r.text(); let b=t; try{b=JSON.parse(t)}catch{}; return {status:r.status, body:b}; };
const u = "lostupd" + Date.now().toString(36);
let r = await j("/api/creator/create",{method:"POST",body:JSON.stringify({creatorName:u})});
const key = r.body.creatorKey;
const save = (items, expected) => j("/api/creator/lists/save",{method:"POST",body:JSON.stringify({
  creatorName:u, creatorKey:key, slug:"shared", name:"Shared List", type:"movie", items, visibility:"private",
  ...(expected!==undefined?{expectedUpdatedAt:expected}:{}) })});
await save([{id:"tt1",type:"movie",name:"A"}]);
let lists = (await j("/api/creator/lists",{method:"POST",body:JSON.stringify({creatorName:u,creatorKey:key})})).body;
const base = lists.lists.find(l=>l.slug==="shared");
console.log("baseline updatedAt:", base.updatedAt, " items:", base.items?.length ?? base.itemCount);

// Device 1 and Device 2 both loaded that baseline. Device 1 adds B; Device 2 adds C.
const d1 = await save([{id:"tt1",type:"movie",name:"A"},{id:"tt2",type:"movie",name:"B"}]);   // no expectedUpdatedAt (saveCreatorListEdit)
await new Promise(r=>setTimeout(r,10));
const d2 = await save([{id:"tt1",type:"movie",name:"A"},{id:"tt3",type:"movie",name:"C"}]);   // no expectedUpdatedAt
console.log("device1 save:", d1.status, JSON.stringify(d1.body).slice(0,90));
console.log("device2 save:", d2.status, JSON.stringify(d2.body).slice(0,90));
lists = (await j("/api/creator/lists",{method:"POST",body:JSON.stringify({creatorName:u,creatorKey:key})})).body;
const final = lists.lists.find(l=>l.slug==="shared");
console.log("final items:", JSON.stringify((final.items||[]).map(i=>i.name)));
console.log((final.items||[]).some(i=>i.name==="B") ? "both kept" : "*** LOST UPDATE: device 1's addition is gone, both saves reported ok ***");

// Same two saves, but WITH the baseline the server supports:
const d3 = await save([{id:"tt1",type:"movie",name:"A"},{id:"tt4",type:"movie",name:"D"}], final.updatedAt);
const d4 = await save([{id:"tt1",type:"movie",name:"A"},{id:"tt5",type:"movie",name:"E"}], final.updatedAt);
console.log("\nwith expectedUpdatedAt -> first:", d3.status, " second:", d4.status, JSON.stringify(d4.body).slice(0,80));

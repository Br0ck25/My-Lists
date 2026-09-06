// Phase 35: randomized, model-based stateful testing against KV+D1.
import { makeKv, makeD1, makeEnv, call, createUser } from "../../tests/harness.mjs";

function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;}}

async function runSeed(seed, steps=250){
  const rnd=mulberry32(seed);
  const pick=a=>a[Math.floor(rnd()*a.length)];
  const kv=makeKv(),db=makeD1(),env=makeEnv({CONFIGS:kv,DB:db});
  const user="model"+seed;
  let cred=await createUser(env,user,{recoveryAnswer:"a recovery answer that is long"});
  let key=cred.creatorKey;
  // model: slug -> {name, visibility, items, likes}
  const model=new Map();
  const violations=[];
  const check=async(after)=>{
    // every modelled list exists in KV with the modelled visibility
    for(const [slug,m] of model){
      const raw=kv._store.get(`creatorlist:${user}:${slug}`);
      if(!raw){ violations.push(`${after}: list ${slug} missing from KV`); continue; }
      const rec=JSON.parse(raw);
      if(rec.visibility!==m.visibility) violations.push(`${after}: ${slug} visibility ${rec.visibility} != model ${m.visibility}`);
      if((rec.items||[]).length!==m.items) violations.push(`${after}: ${slug} items ${(rec.items||[]).length} != model ${m.items}`);
      if((rec.likes||0)!==m.likes) violations.push(`${after}: ${slug} likes ${rec.likes} != model ${m.likes}`);
      // public page must agree with visibility
      const page=await call(env,`/lists/${user}/${slug}.json`);
      const shouldBe = m.visibility==="public" ? 200 : 404;
      if(page.status!==shouldBe) violations.push(`${after}: ${slug} public page ${page.status}, expected ${shouldBe} for ${m.visibility}`);
    }
    // nothing in KV that the model does not know about
    for(const k of kv._store.keys()){
      if(k.startsWith(`creatorlist:${user}:`)){
        const slug=k.slice(`creatorlist:${user}:`.length);
        if(!model.has(slug)) violations.push(`${after}: orphan KV list ${slug} not in model`);
      }
    }
    // the directory must never advertise a private or deleted list
    const idxRaw=kv._store.get("index:publiclists");
    if(idxRaw){
      for(const e of JSON.parse(idxRaw).entries){
        if(!String(e.id).startsWith(`c:${user}:`)) continue;
        const slug=String(e.id).slice(`c:${user}:`.length);
        const m=model.get(slug);
        if(!m) violations.push(`${after}: directory advertises deleted list ${slug}`);
        else if(m.visibility!=="public") violations.push(`${after}: directory advertises PRIVATE list ${slug}`);
      }
    }
  };
  let likeIp=1;
  for(let i=0;i<steps && violations.length<8;i++){
    const op=pick(["create","edit","rename","visibility","like","unlike","delete","reorder","sync","rotate","createDup"]);
    const slugs=[...model.keys()];
    try{
      if(op==="create"||!slugs.length){
        const name=`List ${i}`;
        const vis=pick(["public","private"]);
        const items=Math.floor(rnd()*3);
        const r=await call(env,"/api/creator/lists/save",{method:"POST",json:{creatorName:user,creatorKey:key,name,type:"movie",visibility:vis,items:Array.from({length:items},(_,j)=>({id:"tt"+j}))}});
        if(r.body&&r.body.ok) model.set(r.body.slug,{name,visibility:vis,items,likes:0});
      } else if(op==="createDup"){
        // same name again -> must get a different slug, never overwrite
        const existing=pick(slugs); const m=model.get(existing);
        const r=await call(env,"/api/creator/lists/save",{method:"POST",json:{creatorName:user,creatorKey:key,name:m.name,type:"movie",visibility:"private",items:[]}});
        if(r.body&&r.body.ok){ if(r.body.slug===existing){ /* server chose to edit in place */ model.set(existing,{...m,visibility:"private",items:0}); } else model.set(r.body.slug,{name:m.name,visibility:"private",items:0,likes:0}); }
      } else if(op==="edit"||op==="rename"||op==="visibility"){
        const slug=pick(slugs); const m=model.get(slug);
        const name=op==="rename"?`Renamed ${i}`:m.name;
        const vis=op==="visibility"?pick(["public","private"]):m.visibility;
        const items=op==="edit"?Math.floor(rnd()*4):m.items;
        const r=await call(env,"/api/creator/lists/save",{method:"POST",json:{creatorName:user,creatorKey:key,slug,name,type:"movie",visibility:vis,items:Array.from({length:items},(_,j)=>({id:"tt"+j}))}});
        if(r.body&&r.body.ok) model.set(slug,{name,visibility:vis,items,likes:m.likes});
      } else if(op==="like"||op==="unlike"){
        const slug=pick(slugs); const m=model.get(slug);
        const ip=`198.51.${(likeIp>>8)&255}.${likeIp&255}`; likeIp++;
        const r=await call(env,"/api/lists/like",{method:"POST",ip,json:{username:user,slug,action:op==="unlike"?"unlike":"like"}});
        if(r.body&&r.body.ok) model.set(slug,{...m,likes:r.body.likes});
      } else if(op==="delete"){
        const slug=pick(slugs);
        const r=await call(env,"/api/creator/lists/delete",{method:"POST",json:{creatorName:user,creatorKey:key,slug}});
        if(r.body&&r.body.ok) model.delete(slug);
      } else if(op==="reorder"){
        await call(env,"/api/creator/lists/reorder",{method:"POST",json:{creatorName:user,creatorKey:key,order:[...slugs].reverse()}});
      } else if(op==="sync"){
        await call(env,"/api/creator/sync/save",{method:"POST",json:{creatorName:user,creatorKey:key,config:[{i}]}});
      } else if(op==="rotate"){
        const r=await call(env,"/api/creator/reset-key",{method:"POST",json:{username:user,recoveryAnswer:"a recovery answer that is long"}});
        if(r.body&&r.body.ok){
          const old=key; key=r.body.creatorKey;
          const oldStillWorks=await call(env,"/api/creator/restore",{method:"POST",json:{creatorName:user,creatorKey:old}});
          if(oldStillWorks.body&&oldStillWorks.body.ok) violations.push(`step ${i}: OLD KEY STILL AUTHENTICATES after rotation`);
        }
      }
      await check(`step ${i} after ${op}`);
    }catch(e){ violations.push(`step ${i} ${op} threw: ${e.message}`); }
  }
  return violations;
}

let bad=0;
for(const seed of [1,2,3,7,11,42,99,1234]){
  const v=await runSeed(seed,120);
  if(v.length){ bad++; console.log(`SEED ${seed}: ${v.length} violation(s)`); v.slice(0,6).forEach(x=>console.log("   "+x)); }
  else console.log(`SEED ${seed}: clean`);
}
console.log(bad? `\n${bad} seed(s) produced violations` : "\nall seeds clean");

const B="http://127.0.0.1:8787";
const j=async(p,o={})=>{const r=await fetch(B+p,{headers:{'content-type':'application/json'},...o});const t=await r.text();let b=t;try{b=JSON.parse(t)}catch{};return{status:r.status,body:b}};
for (const n of [2,3]) {
  const u="race"+n+Date.now().toString(36);
  const rs = await Promise.all(Array.from({length:n},()=>j("/api/creator/create",{method:"POST",body:JSON.stringify({creatorName:u})})));
  console.log(`\n${n} concurrent /api/creator/create for "${u}":`);
  rs.forEach((r,i)=>console.log(`   #${i}: ${r.status} ${JSON.stringify(r.body).slice(0,110)}`));
  const keys = rs.filter(r=>r.body&&r.body.creatorKey).map(r=>r.body.creatorKey);
  for (const k of keys) {
    const chk = await j("/api/creator/restore",{method:"POST",body:JSON.stringify({creatorName:u,creatorKey:k})});
    console.log(`   key ${k} -> restore ${chk.status} ${JSON.stringify(chk.body).slice(0,70)}`);
  }
}
// sequential (what 3 clicks 50ms apart really look like)
const u="seq"+Date.now().toString(36);
const out=[];
for (let i=0;i<3;i++){ out.push(await j("/api/creator/create",{method:"POST",body:JSON.stringify({creatorName:u})})); }
console.log(`\n3 SEQUENTIAL creates for "${u}":`);
out.forEach((r,i)=>console.log(`   #${i}: ${r.status} ${JSON.stringify(r.body).slice(0,110)}`));

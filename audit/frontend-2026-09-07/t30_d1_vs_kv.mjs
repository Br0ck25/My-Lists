async function probe(port, label) {
  const B = "http://127.0.0.1:" + port;
  const j = async (p,o={}) => { const r = await fetch(B+p,{headers:{'content-type':'application/json'},...o}); const t=await r.text(); let b=t; try{b=JSON.parse(t)}catch{}; return {status:r.status, body:b}; };
  let firstOk = 0, lastOk = 0, n = 5;
  for (let i=0;i<n;i++) {
    const u = "cmp"+port+i+Date.now().toString(36);
    const rs = await Promise.all([0,1].map(()=>j("/api/creator/create",{method:"POST",body:JSON.stringify({creatorName:u})})));
    const keys = rs.map(r=>r.body&&r.body.creatorKey).filter(Boolean);
    if (keys.length !== 2) { console.log("  (only", keys.length, "keys returned)"); continue; }
    const a = (await j("/api/creator/restore",{method:"POST",body:JSON.stringify({creatorName:u,creatorKey:keys[0]})})).status;
    const b = (await j("/api/creator/restore",{method:"POST",body:JSON.stringify({creatorName:u,creatorKey:keys[1]})})).status;
    if (a===200) firstOk++; if (b===200) lastOk++;
  }
  console.log(`${label}: over ${n} double-creates -> first response's key valid ${firstOk}/${n}, second response's key valid ${lastOk}/${n}`);
}
await probe(8787, "D1 bound   ");
await probe(8788, "D1 UNbound ");

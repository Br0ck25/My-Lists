import { makeKv, worker } from "../../tests/harness.mjs";
const realFetch=globalThis.fetch;
const kv=makeKv();
// record TTLs
const ttls=new Map(); const basePut=kv.put.bind(kv);
kv.put=async(k,v,opts)=>{ ttls.set(k,opts&&opts.expirationTtl); return basePut(k,v); };
const env={CONFIGS:kv,TMDB_API_KEY:"k",TRAKT_CLIENT_ID:"t",SIMKL_CLIENT_ID:"s",MDBLIST_API_KEY:"m"};
globalThis.fetch=async()=>new Response("{}",{status:200,headers:{"content-type":"application/json"}});
const pending=[];const ctx={waitUntil(p){pending.push(Promise.resolve(p).catch(()=>{}))}};
await worker.scheduled({cron:"x"},env,ctx); await Promise.all(pending);
globalThis.fetch=realFetch;
const keys=[...kv._store.keys()].filter(k=>k!=="index:publiclists");
console.log("keys written by a prewarm against an upstream that answers 200 {}:",keys.length);
for(const k of keys.slice(0,12)) console.log(`  ${k}  ttl=${ttls.get(k)}  value=${String(kv._store.get(k)).slice(0,90)}`);
const empties=keys.filter(k=>{const v=String(kv._store.get(k));return v==="[]"||v==="{}"||/"items":\[\]/.test(v)||/^\{"ts":\d+,"items":\[\]\}$/.test(v);});
console.log("\nof those, empty payloads:",empties.length,"e.g.",JSON.stringify(empties.slice(0,5)));
console.log("longest TTL among them:",Math.max(...empties.map(k=>ttls.get(k)||0)));

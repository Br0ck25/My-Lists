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
// The first version of this matcher looked for `[]`, `{}` or `"items":[]` and
// so matched nothing at all -- the cache format is `{"data":...,"freshUntil":...}`
// -- which made the probe print "empty payloads: 0" over a KV full of them.
const empties=keys.filter(k=>/"data":(\[\]|\{\})/.test(String(kv._store.get(k))));
console.log("\nof those, empty payloads:",empties.length,"e.g.",JSON.stringify(empties.slice(0,5)));
console.log("longest KV TTL among them:",empties.length?Math.max(...empties.map(k=>ttls.get(k)||0)):"n/a");

// The KV TTL is retention, not freshness. What decides how long a person is
// shown an empty chart is `freshUntil`, and the prewarm re-runs every few
// minutes, so an empty cached on a cold start is retried well before the
// 24h TTL. Reporting the TTL alone reads like a day-long outage; it isn't.
const now=Date.now();
const windows=empties.map(k=>{try{return Math.round((JSON.parse(String(kv._store.get(k))).freshUntil-now)/1000);}catch{return null;}}).filter(x=>x!==null);
if(windows.length) console.log(`freshness window of an empty entry: ${Math.min(...windows)}-${Math.max(...windows)}s (that is how long it is served before a refresh is attempted, not the ${Math.max(...empties.map(k=>ttls.get(k)||0))}s TTL)`);

// This is the cold-start case: nothing good was cached, so an empty answer is
// all there is to serve and refusing to write it would only mean refetching
// the same nothing. refuseEmptyOverwrite protects an EXISTING good value --
// see p21 for that half, which is the one that matters.
console.log("\n(cold start: no previous value existed, so writing the empty result is correct here -- p21 covers the overwrite case)");

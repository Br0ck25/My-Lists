// Phase 24: external API contract mutation - can bad upstream data corrupt persistent state?
import { makeKv, makeEnv, call, worker } from "../../tests/harness.mjs";
const realFetch=globalThis.fetch;
const cases={
  "200 + malformed JSON": ()=>new Response("{not json",{status:200,headers:{"content-type":"application/json"}}),
  "200 + empty object":   ()=>new Response("{}",{status:200,headers:{"content-type":"application/json"}}),
  "200 + array instead of object": ()=>new Response("[]",{status:200,headers:{"content-type":"application/json"}}),
  "200 + results:null":   ()=>new Response(JSON.stringify({results:null}),{status:200,headers:{"content-type":"application/json"}}),
  "200 + items missing id/title": ()=>new Response(JSON.stringify({results:[{},{id:null},{title:null}]}),{status:200,headers:{"content-type":"application/json"}}),
  "200 + duplicate entries": ()=>new Response(JSON.stringify({results:[{id:1,title:"A"},{id:1,title:"A"},{id:1,title:"A"}]}),{status:200,headers:{"content-type":"application/json"}}),
  "204 no content":       ()=>new Response(null,{status:204}),
  "301 redirect":         ()=>new Response("",{status:301,headers:{location:"https://example.com/x"}}),
  "401":                  ()=>new Response("unauthorized",{status:401}),
  "403":                  ()=>new Response("forbidden",{status:403}),
  "404":                  ()=>new Response("nope",{status:404}),
  "429":                  ()=>new Response("slow down",{status:429}),
  "500":                  ()=>new Response("boom",{status:500}),
  "timeout (never resolves)": ()=>new Promise(()=>{}),
};
for(const [label,mk] of Object.entries(cases)){
  const kv=makeKv();
  const env={CONFIGS:kv,TMDB_API_KEY:"k",TRAKT_CLIENT_ID:"t",SIMKL_CLIENT_ID:"s",MDBLIST_API_KEY:"m"};
  globalThis.fetch=async()=>{ const r=mk(); return r instanceof Promise? Promise.race([r,new Promise((_,rj)=>setTimeout(()=>rj(new Error("simulated timeout")),50))]) : r; };
  let threw=null;
  const pending=[]; const ctx={waitUntil(p){pending.push(Promise.resolve(p).catch(e=>e))}};
  try{ await worker.scheduled({cron:"x"},env,ctx); await Promise.all(pending); }catch(e){ threw=e; }
  // What did the prewarm write into KV?
  const chartKeys=[...kv._store.keys()].filter(k=>!k.startsWith("cron:"));
  const emptyCached=chartKeys.filter(k=>{ const v=kv._store.get(k); return /\[\]|"items":\[\]|^\{\}$/.test(v||""); });
  console.log(`${label.padEnd(32)} threw=${threw?threw.message.slice(0,30):"no"}  kvKeysWritten=${chartKeys.length}  emptyOrEmptyItems=${emptyCached.length}`);
  if(chartKeys.length && chartKeys.length<6) console.log("     keys:",JSON.stringify(chartKeys.slice(0,6)),"sample:",String(kv._store.get(chartKeys[0])).slice(0,120));
}
globalThis.fetch=realFetch;

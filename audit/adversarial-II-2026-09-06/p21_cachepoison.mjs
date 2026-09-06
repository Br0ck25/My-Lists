// Phase 24/15: does an empty-but-successful upstream response overwrite a good cached chart?
import { makeKv, worker } from "../../tests/harness.mjs";
const realFetch=globalThis.fetch;
const kv=makeKv();
const env={CONFIGS:kv,TMDB_API_KEY:"k",TRAKT_CLIENT_ID:"t",SIMKL_CLIENT_ID:"s",MDBLIST_API_KEY:"m"};
const good=JSON.stringify({results:[{id:1,title:"Real Movie",release_date:"2020-01-01",poster_path:"/p.jpg"},{id:2,title:"Another",release_date:"2021-01-01"}],
  movies:[{movie:{title:"Real",ids:{imdb:"tt1",trakt:1},year:2020}}]});
async function tick(body){
  globalThis.fetch=async()=>new Response(body,{status:200,headers:{"content-type":"application/json"}});
  const pending=[];const ctx={waitUntil(p){pending.push(Promise.resolve(p).catch(()=>{}))}};
  await worker.scheduled({cron:"x"},env,ctx); await Promise.all(pending);
}
await tick(good);
const key=[...kv._store.keys()].find(k=>k.startsWith("cache:tmdb:chart:trending:movie"));
console.log("after a HEALTHY prewarm:", key, "->", String(kv._store.get(key)).slice(0,140));
await tick("{}");
console.log("after an EMPTY-200 prewarm:", key, "->", String(kv._store.get(key)).slice(0,140));
const after=String(kv._store.get(key));
console.log(/"data":\[\]|"data":\{\}/.test(after)
  ? "FAIL - a successful-but-empty upstream reply overwrote a good cached chart with an empty one"
  : "PASS - the good cached chart survived");
globalThis.fetch=realFetch;

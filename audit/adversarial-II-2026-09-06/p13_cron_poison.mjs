// Phase 22: a single failing account is a poison pill for the whole sweep.
import { makeKv, worker } from "../../tests/harness.mjs";
const kv=makeKv();
for(let i=0;i<5;i++){
  const u=`poison${i}`;
  kv._store.set(`creator:${u}`,JSON.stringify({displayName:u,keyHash:"h",createdAt:1}));
  kv._store.set(`creatorsynctracking:${u}`,JSON.stringify({fullyWatchedShowIds:[`tt${i}`],watchHistory:[{type:"episode",showId:`tt${i}`,seasonNum:1,episodeNum:1}],continueWatching:[]}));
}
const realFetch=globalThis.fetch;
globalThis.fetch=async()=>new Response(JSON.stringify({episodes:[]}),{status:200,headers:{"content-type":"application/json"}});
// account poison2's tracking key is unreadable (a KV hiccup on one key)
kv._hooks.beforeGet=async k=>{ if(k==="creatorsynctracking:poison2") throw new Error("KV get failed for this one key"); };
const touched=new Set(); const origGet=kv.get.bind(kv);
kv.get=async(k,t)=>{ if(k.startsWith("creatorsynctracking:")) touched.add(k); return origGet(k,t); };
for(let t=0;t<4;t++){
  const pending=[]; const ctx={waitUntil(p){pending.push(Promise.resolve(p).catch(()=>{}))}};
  try{ await worker.scheduled({cron:"x"},{CONFIGS:kv,TMDB_API_KEY:"k"},ctx); await Promise.all(pending);}catch(e){}
}
kv.get=origGet; kv._hooks.beforeGet=null; globalThis.fetch=realFetch;
const reached=[...touched].sort();
console.log("tracking keys the sweep managed to read:",JSON.stringify(reached));
console.log("cursor after 4 ticks:",JSON.stringify(kv._store.get("cron:continuewatching:cursor")));
const after=["poison3","poison4"].filter(u=>!reached.includes(`creatorsynctracking:${u}`));
console.log(after.length? `FAIL - accounts after the poison key are never swept: ${JSON.stringify(after)}`
                        : "PASS - sweep continues past a failing account");

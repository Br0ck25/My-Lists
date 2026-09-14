// Phase 22: cron adversarial - cursor handling, budget/starvation, invalid cursor.
import { makeKv, makeEnv, worker } from "../../tests/harness.mjs";
const R=[];const rec=(n,ok,d)=>{R.push({n,ok});console.log(ok?"PASS":"FAIL","-",n,d?"\n    "+d:"")};

function trackedEnv(kv, extra={}) { return { CONFIGS: kv, TMDB_API_KEY: "fake-tmdb-key", ...extra }; }
async function tick(env){
  const pending=[]; const ctx={waitUntil(p){pending.push(Promise.resolve(p).catch(e=>({err:e})))}};
  await worker.scheduled({cron:"*/6 * * * *"},env,ctx);
  return Promise.all(pending);
}

// Stub fetch so TMDB lookups are deterministic and countable.
let tmdbCalls=0; const realFetch=globalThis.fetch;
globalThis.fetch=async(u,o)=>{
  const url=String(u);
  if(url.includes("api.themoviedb.org")){
    tmdbCalls++;
    return new Response(JSON.stringify({episodes:[],results:[],id:1}),{status:200,headers:{"content-type":"application/json"}});
  }
  return new Response("{}",{status:200,headers:{"content-type":"application/json"}});
};

// --- A. budget exhaustion starves the rest of the page, and the cursor still advances
{
  const kv=makeKv();
  // 30 accounts so there are two pages of 25.
  for(let i=0;i<30;i++){
    const u=`cronuser${String(i).padStart(2,"0")}`;
    kv._store.set(`creator:${u}`,JSON.stringify({displayName:u,keyHash:"h",createdAt:1}));
    // account 00 is a heavy user: 200 fully-watched shows, each with watch history
    const shows = i===0 ? 200 : 1;
    const ids=[],hist=[];
    for(let s=0;s<shows;s++){ ids.push(`tt${i}_${s}`); hist.push({type:"episode",showId:`tt${i}_${s}`,seasonNum:1,episodeNum:1,showTitle:"S"}); }
    kv._store.set(`creatorsynctracking:${u}`,JSON.stringify({fullyWatchedShowIds:ids,watchHistory:hist,continueWatching:[],updatedAt:1}));
  }
  const touched=new Set();
  const env=trackedEnv(kv);
  const origGet=kv.get.bind(kv);
  kv.get=async(k,t)=>{ if(k.startsWith("creatorsynctracking:")) touched.add(k.slice("creatorsynctracking:".length)); return origGet(k,t); };
  for(let t=0;t<6;t++) await tick(env);
  kv.get=origGet;
  const seen=[...touched].sort();
  const never=[];
  for(let i=0;i<30;i++){ const u=`cronuser${String(i).padStart(2,"0")}`; if(!seen.includes(u)) never.push(u); }
  rec("every account is reached by the cron within a few full cycles",
      never.length===0,
      `after 6 ticks, ${never.length} accounts were NEVER read: ${JSON.stringify(never)}\n    cursor now = ${JSON.stringify(kv._store.get("cron:continuewatching:cursor"))}`);
}

// --- B. invalid / rejected cursor wedges the sweep permanently
{
  const kv=makeKv();
  for(let i=0;i<3;i++){
    const u=`wedge${i}`;
    kv._store.set(`creator:${u}`,JSON.stringify({displayName:u,keyHash:"h",createdAt:1}));
    kv._store.set(`creatorsynctracking:${u}`,JSON.stringify({fullyWatchedShowIds:[],watchHistory:[],continueWatching:[]}));
  }
  kv._store.set("cron:continuewatching:cursor","THIS-CURSOR-IS-NO-LONGER-VALID");
  const env=trackedEnv(kv);
  kv._hooks.beforeList=async(prefix,cursor)=>{ if(cursor) { const e=new Error("KV list failed: invalid cursor"); throw e; } };
  const results=[];
  for(let t=0;t<3;t++) results.push(await tick(env));
  kv._hooks.beforeList=null;
  const cursorAfter=kv._store.get("cron:continuewatching:cursor");
  rec("a rejected cursor is cleared so the sweep can recover",
      cursorAfter!=="THIS-CURSOR-IS-NO-LONGER-VALID",
      `cursor after 3 ticks is still ${JSON.stringify(cursorAfter)} - every tick throws on it and nothing resets it`);
}

// --- C. two overlapping cron runs
{
  const kv=makeKv();
  for(let i=0;i<5;i++){
    const u=`ovl${i}`;
    kv._store.set(`creator:${u}`,JSON.stringify({displayName:u,keyHash:"h",createdAt:1}));
    kv._store.set(`creatorsynctracking:${u}`,JSON.stringify({fullyWatchedShowIds:[`ttx${i}`],watchHistory:[{type:"episode",showId:`ttx${i}`,seasonNum:1,episodeNum:1}],continueWatching:[]}));
  }
  const env=trackedEnv(kv);
  await Promise.all([tick(env),tick(env)]);
  const blob=JSON.parse(kv._store.get("creatorsynctracking:ovl0"));
  rec("overlapping cron runs do not duplicate Continue Watching entries",
      (blob.continueWatching||[]).length<=1, JSON.stringify(blob.continueWatching));
}

// --- D. scheduled() has no exception boundary
{
  const kv=makeKv();
  const env=trackedEnv(kv);
  const bad={ get: async()=>{ throw new Error("KV totally down"); }, put: async()=>{throw new Error("down")}, list: async()=>{throw new Error("down")}, delete: async()=>{throw new Error("down")} };
  let threw=null;
  try{
    const pending=[]; const ctx={waitUntil(p){pending.push(p)}};
    await worker.scheduled({cron:"*/6 * * * *"},{CONFIGS:bad,TMDB_API_KEY:"k"},ctx);
    await Promise.all(pending);
  }catch(e){ threw=e; }
  rec("scheduled() survives a total KV outage without an unhandled rejection",
      threw===null, threw?`scheduled() rejected with: ${threw.message}`:"");
}
globalThis.fetch=realFetch;
console.log("\n"+R.filter(x=>!x.ok).length+" FAILURES of "+R.length);

// Phase 17: authorization matrix - anonymous / creator A / creator B / admin.
import { makeKv, makeD1, makeEnv, call, createUser } from "../../tests/harness.mjs";
const kv=makeKv(),db=makeD1(),env=makeEnv({CONFIGS:kv,DB:db});
const A=await createUser(env,"authza"); const B=await createUser(env,"authzb");
const KA={creatorName:"authza",creatorKey:A.creatorKey};
const KB={creatorName:"authzb",creatorKey:B.creatorKey};
const wrong={creatorName:"authza",creatorKey:"MYL-XXXX-XXXX-XXXX"};
await call(env,"/api/creator/lists/save",{method:"POST",json:{...KA,name:"A List",type:"movie",visibility:"private",items:[{id:"secret"}]}});
await call(env,"/api/creator/sync/save",{method:"POST",json:{...KA,config:[{p:"A private config"}],keys:{tmdb:"A-TMDB-KEY"}}});
await call(env,"/api/creator/sync/save-tracking",{method:"POST",json:{...KA,watchHistory:[{id:"A watched this"}]}});
const login=await call(env,"/admin/login",{method:"POST",form:{key:"test-admin-secret"}});
const cookie=(login.headers.get("set-cookie")||"").split(";")[0];

// Mutation + read routes that take creator credentials in the body.
const creatorRoutes=[
 ["/api/creator/lists",{}],["/api/creator/lists/save",{name:"X",type:"movie",items:[]}],
 ["/api/creator/lists/delete",{slug:"a-list"}],["/api/creator/lists/reorder",{order:["a-list"]}],
 ["/api/creator/sync/save",{config:[]}],["/api/creator/sync/load",{}],["/api/creator/sync/meta",{}],
 ["/api/creator/sync/save-tracking",{watchHistory:[]}],["/api/creator/sync/save-presets",{presets:{}}],
 ["/api/creator/sync/save-channels",{channels:{}}],["/api/creator/sync/like",{usernameSlug:"z",liked:true}],
 ["/api/creator/sync/share-tracking",{slug:"watchlist",shared:true}],
 ["/api/creator/scrobble-token",{}],["/api/creator/restore",{}],["/api/creator/track-status",{}],
 ["/api/creator/scrobble-seen-users",{}],
 ["/api/creator/account/reset",{confirm:"RESET"}],["/api/creator/delete-account",{confirm:"DELETE"}],
];
console.log("ROUTE".padEnd(42),"anon","wrongkey","B-as-A");
const problems=[];
for(const [p,extra] of creatorRoutes){
  const anon=await call(env,p,{method:"POST",json:{...extra}});
  const wr=await call(env,p,{method:"POST",json:{...wrong,...extra}});
  // B sends its own creds but names A's resource where the route takes a target
  const bAsA=await call(env,p,{method:"POST",json:{...KB,...extra}});
  const okAnon=anon.body&&anon.body.ok===true, okWrong=wr.body&&wr.body.ok===true;
  console.log(p.padEnd(42),
    `${anon.status}${okAnon?"/OK!":""}`.padEnd(5),
    `${wr.status}${okWrong?"/OK!":""}`.padEnd(9),
    `${bAsA.status}${bAsA.body&&bAsA.body.ok===true?"/ok":""}`);
  if(okAnon) problems.push(`ANONYMOUS accepted at ${p}`);
  if(okWrong) problems.push(`WRONG KEY accepted at ${p}`);
}
// A's private data must be untouched by anything B did
const aList=kv._store.get("creatorlist:authza:a-list");
const aSync=kv._store.get("creatorsync:authza");
const aTrack=kv._store.get("creatorsynctracking:authza");
console.log("\nA's private list intact:",!!aList&&aList.includes("secret"));
console.log("A's config intact:",!!aSync&&aSync.includes("A private config"));
console.log("A's tracking intact:",!!aTrack&&aTrack.includes("A watched this"));
if(!aList||!aList.includes("secret")) problems.push("Creator B destroyed A's list");
if(!aSync||!aSync.includes("A private config")) problems.push("Creator B destroyed A's config");
if(!aTrack||!aTrack.includes("A watched this")) problems.push("Creator B destroyed A's tracking");

// Admin routes without a session
const adminRoutes=[["GET","/admin/api/analytics"],["GET","/admin/api/apiusage"],["GET","/admin/api/leaderboard"],
 ["GET","/admin/api/feedback"],["GET","/admin"],["GET","/admin/api/netflix-preview"],["GET","/admin/api/provider-lookup"],
 ["POST","/admin/api/reset-creator-key"],["POST","/admin/api/migrate-d1"],["POST","/admin/api/rebuild-public-index"],
 ["POST","/admin/api/delete-creator-list"],["POST","/admin/api/backfill-trending"],["POST","/admin/api/migrate-day-counts"],
 ["POST","/admin/api/feedback/reply"],["POST","/admin/api/feedback/status"],["POST","/admin/api/feedback/edit"],["POST","/admin/api/feedback/delete"]];
console.log("\nADMIN ROUTE".padEnd(42),"no-session","creator-cookie");
for(const [m,p] of adminRoutes){
  const noSess=await call(env,p,m==="GET"?{method:m}:{method:m,json:{}});
  const fake=await call(env,p,m==="GET"?{method:m,cookie:"admin_session=deadbeef"}:{method:m,cookie:"admin_session=deadbeef",json:{}});
  console.log(p.padEnd(42),String(noSess.status).padEnd(10),fake.status);
  if(noSess.status===200&&!(noSess.body&&noSess.body.ok===false)) problems.push(`ADMIN route open without session: ${p} -> ${noSess.status}`);
  if(fake.status===200&&!(fake.body&&fake.body.ok===false)) problems.push(`ADMIN route accepts a forged cookie: ${p}`);
}
console.log("\nPROBLEMS:\n"+(problems.length?problems.map(x=>"  "+x).join("\n"):"  none"));

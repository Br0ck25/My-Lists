// Phase 4/5/9: hybrid KV/D1 failure matrix + split-brain hunting.
import { makeKv, makeD1, makeEnv, call, createUser } from "../../tests/harness.mjs";
const R=[];const rec=(n,ok,d)=>{R.push({n,ok});console.log(ok?"PASS":"FAIL","-",n,d?"\n    "+d:"")};

// --- A. creator create: D1 throws, KV fine -> divergence but ok:true (documented) then rotate
{
  const kv=makeKv(),db=makeD1(),env=makeEnv({CONFIGS:kv,DB:db});
  db.failWhen(s=>/INSERT INTO creators/i.test(s));
  const u=await createUser(env,"splitc1");
  db.failWhen(null);
  rec("create with failing D1 still authenticates via KV",
      (await call(env,"/api/creator/restore",{method:"POST",json:{creatorName:"splitc1",creatorKey:u.creatorKey}})).body.ok===true,
      `d1HasRow=${db._creators.has("splitc1")}`);
  // now the account exists only in KV. Rotate the key.
  const rot=await call(env,"/api/creator/reset-key",{method:"POST",json:{username:"splitc1",recoveryAnswer:"x"}});
  rec("reset-key without recovery answer refuses", rot.body.ok===false, JSON.stringify(rot.body));
}

// --- B. State F: both stores hold the record but values differ (D1 newer)
{
  const kv=makeKv(),db=makeD1(),env=makeEnv({CONFIGS:kv,DB:db});
  const u=await createUser(env,"splitf1");
  await call(env,"/api/creator/lists/save",{method:"POST",json:{creatorName:"splitf1",creatorKey:u.creatorKey,name:"L",type:"movie",visibility:"public",items:[{id:"a"}]}});
  // Simulate: a D1-only write landed (e.g. some other worker/admin tool) making D1 newer
  db._db.exec("UPDATE creator_lists SET name='D1-NEWER', visibility='private', updated_at=9999999999999 WHERE id='splitf1:l'");
  const pub=await call(env,"/lists/splitf1/l.json");
  const dash=await call(env,"/api/creator/lists",{method:"POST",json:{creatorName:"splitf1",creatorKey:u.creatorKey}});
  rec("public page and dashboard agree when D1 is newer than KV",
      (pub.status===404)===(JSON.stringify(dash.body).includes('"visibility":"private"')),
      `publicStatus=${pub.status} dashboard=${JSON.stringify(dash.body).slice(0,300)}`);
}

// --- C. State E: D1 has the creator, KV doesn't (KV row lost) -> can they still be deleted?
{
  const kv=makeKv(),db=makeD1(),env=makeEnv({CONFIGS:kv,DB:db});
  const u=await createUser(env,"splite1");
  kv._store.delete("creator:splite1"); // KV record vanishes; D1 mirror remains
  const restore=await call(env,"/api/creator/restore",{method:"POST",json:{creatorName:"splite1",creatorKey:u.creatorKey}});
  rec("account still reachable from the D1 mirror alone", restore.body.ok===true, JSON.stringify(restore.body));
  const del=await call(env,"/api/creator/delete-account",{method:"POST",json:{creatorName:"splite1",creatorKey:u.creatorKey,confirm:"DELETE"}});
  const stillAuth=await call(env,"/api/creator/restore",{method:"POST",json:{creatorName:"splite1",creatorKey:u.creatorKey}});
  rec("deleting a KV-less (D1-only) account actually revokes it",
      !(del.body.ok===true&&stillAuth.body.ok===true),
      `delete=${JSON.stringify(del.body)} stillAuthenticates=${stillAuth.body.ok} d1Row=${db._creators.has("splite1")}`);
}

// --- D. rotation while D1 write fails and DELETE also fails
{
  const kv=makeKv(),db=makeD1(),env=makeEnv({CONFIGS:kv,DB:db});
  const u=await createUser(env,"splitd1",{recoveryAnswer:"correct horse battery"});
  db.failWhen(s=>/UPDATE creators SET key_hash|DELETE FROM creators/i.test(s));
  const rot=await call(env,"/api/creator/reset-key",{method:"POST",json:{username:"splitd1",recoveryAnswer:"correct horse battery"}});
  db.failWhen(null);
  const oldWorks=(await call(env,"/api/creator/restore",{method:"POST",json:{creatorName:"splitd1",creatorKey:u.creatorKey}})).body.ok===true;
  rec("failed rotation leaves the old key working and hands back no new key",
      rot.body.ok===false && oldWorks, `rot=${JSON.stringify(rot.body)} oldKeyWorks=${oldWorks}`);
}

// --- E. list save: KV put fails after D1 write succeeded
{
  const kv=makeKv(),db=makeD1(),env=makeEnv({CONFIGS:kv,DB:db});
  const u=await createUser(env,"splitg1");
  kv._hooks.beforePut=async k=>{ if(k.startsWith("creatorlist:")) throw new Error("KV put down"); };
  const save=await call(env,"/api/creator/lists/save",{method:"POST",json:{creatorName:"splitg1",creatorKey:u.creatorKey,name:"Ghost",type:"movie",visibility:"public",items:[{id:"x"}]}});
  kv._hooks.beforePut=null;
  const inD1=db._lists.has("splitg1:ghost");
  const inKv=kv._store.has("creatorlist:splitg1:ghost");
  rec("list save: KV failure is not reported as success",
      !(save.body&&save.body.ok===true), `resp=${save.status} ${JSON.stringify(save.body)} inD1=${inD1} inKV=${inKv}`);
  // Now the mirror holds a record the authoritative store never got. Does it leak anywhere?
  const dash=await call(env,"/api/creator/lists",{method:"POST",json:{creatorName:"splitg1",creatorKey:u.creatorKey}});
  const page=await call(env,"/lists/splitg1/ghost.json");
  rec("orphan D1-only list is not resurrected as a real list",
      !(inD1 && page.status===200), `d1Only=${inD1} publicPage=${page.status} dashboard=${JSON.stringify(dash.body).slice(0,200)}`);
}

// --- F. likes: D1 unavailable then restored - do the two stores reconcile?
{
  const kv=makeKv(),db=makeD1(),env=makeEnv({CONFIGS:kv,DB:db});
  const u=await createUser(env,"splith1");
  await call(env,"/api/creator/lists/save",{method:"POST",json:{creatorName:"splith1",creatorKey:u.creatorKey,name:"L",type:"movie",visibility:"public",items:[]}});
  db.failWhen(s=>/UPDATE creator_lists SET likes/i.test(s));
  for(const ip of ["198.18.0.1","198.18.0.2","198.18.0.3"]) await call(env,"/api/lists/like",{method:"POST",ip,json:{username:"splith1",slug:"l"}});
  db.failWhen(null);
  const kvLikes=JSON.parse(kv._store.get("creatorlist:splith1:l")).likes;
  const d1Likes=db._lists.get("splith1:l").likes;
  // now the owner renames the list; does the stale D1 0 come back?
  await call(env,"/api/creator/lists/save",{method:"POST",json:{creatorName:"splith1",creatorKey:u.creatorKey,slug:"l",name:"Renamed",type:"movie",visibility:"public",items:[]}});
  const kvAfter=JSON.parse(kv._store.get("creatorlist:splith1:l")).likes;
  const d1After=db._lists.get("splith1:l").likes;
  rec("a rename after D1 like-outage does not destroy the count",
      kvAfter===3, `kvBefore=${kvLikes} d1Before=${d1Likes} kvAfter=${kvAfter} d1After=${d1After}`);

  // What the divergence actually costs, measured rather than assumed: every
  // surface a person can see reads the true count, because KV is
  // authoritative for likes and the read paths prefer it.
  const dash=await call(env,"/api/creator/lists",{method:"POST",json:{creatorName:"splith1",creatorKey:u.creatorKey}});
  const dir=await call(env,"/lists/public.json");
  const dirEntry=(dir.body.entries||dir.body.lists||[]).find(e=>(e.slug||"")==="l");
  rec("the stale D1 count is not visible on any read path",
      (dash.body.lists||[]).every(l=>l.likes===3) && (!dirEntry || dirEntry.likes===3),
      `dashboard=${JSON.stringify((dash.body.lists||[]).map(l=>l.likes))} directory=${dirEntry?dirEntry.likes:"(absent)"} d1=${d1After}`);

  // A rename deliberately does NOT push likes into D1: /api/lists/like owns
  // that column and may have moved it since this handler read the record, so
  // lists/save binds `likes` on INSERT and leaves it out of the DO UPDATE.
  // The repair is the documented one -- migrate-d1, which pushes KV over D1
  // for every column it can derive. That is what N9 restored, and this is the
  // assertion that says so. (The earlier version of this probe asserted the
  // rename should converge, which is asserting the wrong mechanism.)
  const login=await call(env,"/admin/login",{method:"POST",form:{key:env.ADMIN_KEY}});
  const cookie=((login.headers.get("set-cookie")||"").match(/^([^=]+=[^;]+)/)||[])[1]||"";
  for(let i=0;i<10;i++){ const r=await call(env,"/admin/api/migrate-d1",{method:"POST",cookie}); if(r.body.done) break; }
  const d1Repaired=db._lists.get("splith1:l").likes;
  rec("migrate-d1 converges the D1 mirror on the true like count",
      d1Repaired===3, `before=${d1After} afterMigrate=${d1Repaired} (kv=${kvAfter})`);
}

console.log("\n"+R.filter(r=>!r.ok).length+" FAILURES of "+R.length);

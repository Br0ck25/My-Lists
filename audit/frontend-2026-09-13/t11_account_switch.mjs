import pw from "playwright-core";
const { chromium } = pw;
const CHROMIUM = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const ALICE = { name:"alice", key:"MYL-CDLF-7STV-8BM4" };
const BOB   = { name:"bob",   key:"MYL-KMZ8-TUT3-YNT9" };
const browser = await chromium.launch({ executablePath:CHROMIUM, args:["--no-sandbox","--disable-dev-shm-usage"] });
const page = await (await browser.newContext({viewport:{width:1400,height:1000}})).newPage();
const errs=[]; page.on("pageerror",e=>errs.push(String(e.message).slice(0,180)));
await page.goto("http://127.0.0.1:8787/", { waitUntil:"load" });
await page.waitForTimeout(3500);

const dumpLS = () => page.evaluate(() => {
  const o={}; for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i); o[k]=(localStorage.getItem(k)||"").slice(0,60);} 
  const s={}; for(let i=0;i<sessionStorage.length;i++){const k=sessionStorage.key(i); s[k]=(sessionStorage.getItem(k)||"").slice(0,60);} 
  return { ls:o, ss:s, activeCreator: (typeof window.activeCreator!=='undefined'&&window.activeCreator)?window.activeCreator.creatorName:null };
});
async function login(u){
  await page.evaluate(()=>window.openRestoreModal&&window.openRestoreModal());
  await page.waitForTimeout(400);
  await page.fill("#restoreNameInput", u.name); await page.fill("#restoreKeyInput", u.key);
  await page.click("#restoreSubmitBtn"); await page.waitForTimeout(2500);
}
await login(ALICE);
console.log("AFTER ALICE LOGIN:", JSON.stringify(await dumpLS(), null, 1).slice(0,900));
// give alice some data
await page.evaluate(() => {
  const m = window.loadLocalCustomLists ? window.loadLocalCustomLists() : {};
  m["watch-history"] = { id:"watch-history", name:"Watch History", items:[{id:"ttALICE1",type:"movie",name:"ALICE_SECRET_MOVIE"}] };
  window.saveLocalCustomListsMap(m);
  localStorage.setItem("myListAddon:traktAccessToken","ALICE_TRAKT_TOKEN");
  localStorage.setItem("myListAddon:likedLists", JSON.stringify(["alice/private-list"]));
});
await page.waitForTimeout(2500);
console.log("ALICE DATA SET. keys:", Object.keys((await dumpLS()).ls).length);
// sign out
await page.evaluate(()=>window.switchCreatorProfile&&window.switchCreatorProfile());
await page.waitForTimeout(1500);
const afterOut = await dumpLS();
console.log("AFTER SIGNOUT ls keys:", JSON.stringify(Object.keys(afterOut.ls)));
console.log("AFTER SIGNOUT ss keys:", JSON.stringify(Object.keys(afterOut.ss)));
const leak1 = await page.evaluate(()=>{
  const all = JSON.stringify({ls:{...localStorage}, ss:{...sessionStorage}});
  return { hasAliceMovie: all.includes("ALICE_SECRET_MOVIE"), hasAliceToken: all.includes("ALICE_TRAKT_TOKEN"),
           domHasAlice: (document.body.innerText||"").includes("ALICE_SECRET_MOVIE"),
           memWatchIds: (window._watchedItemIds? window._watchedItemIds.size : -1),
           memLists: window.loadLocalCustomLists ? Object.keys(window.loadLocalCustomLists()) : null };
});
console.log("LEAK AFTER SIGNOUT:", JSON.stringify(leak1));
await login(BOB);
const leak2 = await page.evaluate(()=>{
  const all = JSON.stringify({ls:{...localStorage}, ss:{...sessionStorage}});
  return { activeCreator: window.activeCreator ? window.activeCreator.creatorName : null,
           hasAliceMovie: all.includes("ALICE_SECRET_MOVIE"), hasAliceToken: all.includes("ALICE_TRAKT_TOKEN"),
           domHasAlice: (document.body.innerText||"").includes("ALICE_SECRET_MOVIE"),
           lists: window.loadLocalCustomLists ? JSON.stringify(window.loadLocalCustomLists()).slice(0,200) : null };
});
console.log("AFTER BOB LOGIN:", JSON.stringify(leak2,null,1));
console.log("pageerrors:", JSON.stringify([...new Set(errs)]));
await browser.close();

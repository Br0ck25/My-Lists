import pw from "playwright-core";
const { chromium } = pw;
const CHROMIUM = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const O = "http://127.0.0.1:8790";
const dep = async (v) => (await fetch(O + "/__deploy/" + v)).text();
await dep("v1");
const browser = await chromium.launch({ executablePath:CHROMIUM, args:["--no-sandbox","--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ viewport:{width:1280,height:800}, serviceWorkers:"allow" });
const page = await ctx.newPage();
const errs=[]; page.on("pageerror",e=>errs.push(String(e.message).slice(0,140)));
const dumpCaches = () => page.evaluate(async () => {
  const out={}; for (const n of await caches.keys()) { const c=await caches.open(n); out[n]=(await c.keys()).map(r=>new URL(r.url).pathname+new URL(r.url).search); } return out; });

console.log("--- 1. first online load (deploy v1) ---");
await page.goto(O+"/", { waitUntil:"load" }); await page.waitForTimeout(4000);
await page.evaluate(()=>navigator.serviceWorker.ready);
await page.waitForTimeout(1500);
console.log("SW controller:", await page.evaluate(()=>!!navigator.serviceWorker.controller));
console.log("caches:", JSON.stringify(await dumpCaches()));

console.log("--- 2. offline reload (should serve cached shell) ---");
await ctx.setOffline(true);
let ok=true; try { await page.goto(O+"/", { waitUntil:"load", timeout:20000 }); } catch(e){ ok=false; console.log("   navigation FAILED:", e.message.slice(0,90)); }
await page.waitForTimeout(2500);
console.log("   offline page title:", ok? await page.title() : "(n/a)");
console.log("   app booted offline?:", await page.evaluate(()=>typeof window.addRow === 'function'));
await ctx.setOffline(false);

console.log("--- 3. DEPLOY v2, then visit a NON-'/' page while online ---");
await dep("v2");
await page.goto(O+"/guide", { waitUntil:"load" }); await page.waitForTimeout(2000);
// /guide has no app.js; use a real app page that is not "/" : a configure/deep link
await page.goto(O+"/?src=share", { waitUntil:"load" }); await page.waitForTimeout(4000);
console.log("   page now references:", await page.evaluate(()=>{ const s=[...document.querySelectorAll('script[src]')].map(x=>x.getAttribute('src')); return s.filter(x=>x&&x.includes('app.js')); }));
console.log("   caches after deploy+deeplink:", JSON.stringify(await dumpCaches()));

console.log("--- 4. go offline and navigate to '/' ---");
await ctx.setOffline(true);
errs.length=0;
let ok2=true; try { await page.goto(O+"/", { waitUntil:"load", timeout:20000 }); } catch(e){ ok2=false; console.log("   navigation FAILED:", e.message.slice(0,90)); }
await page.waitForTimeout(3000);
const final = await page.evaluate(()=>({ title:document.title, appJs:[...document.querySelectorAll('script[src]')].map(s=>s.getAttribute('src')).filter(s=>s&&s.includes('app.js')),
   booted: typeof window.addRow === 'function', bodyLen:(document.body.innerText||'').trim().length }));
console.log("   RESULT:", JSON.stringify(final));
console.log("   pageerrors:", JSON.stringify([...new Set(errs)]));
console.log(final.booted ? "   -> offline still works" : "   -> *** OFFLINE PAGE IS DEAD: shell cached but its bundle was evicted ***");
await browser.close();

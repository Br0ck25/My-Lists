import pw from "playwright-core";
const { chromium } = pw;
const CHROMIUM = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({ executablePath:CHROMIUM, args:["--no-sandbox","--disable-dev-shm-usage"] });
const CASES = [
  { n:"HTTP 500",        h:(r)=>r.fulfill({status:500,contentType:"application/json",body:JSON.stringify({ok:false,error:"server exploded"})}) },
  { n:"HTTP 401",        h:(r)=>r.fulfill({status:401,contentType:"application/json",body:JSON.stringify({ok:false,error:"unauthorized"})}) },
  { n:"HTTP 429",        h:(r)=>r.fulfill({status:429,contentType:"application/json",body:JSON.stringify({ok:false,error:"rate limited"})}) },
  { n:"malformed JSON",  h:(r)=>r.fulfill({status:200,contentType:"application/json",body:"{not json at all"}) },
  { n:"empty body",      h:(r)=>r.fulfill({status:200,contentType:"application/json",body:""}) },
  { n:"HTML not JSON",   h:(r)=>r.fulfill({status:200,contentType:"text/html",body:"<html>gateway</html>"}) },
  { n:"ok:true no fields",h:(r)=>r.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})}) },
  { n:"null arrays",     h:(r)=>r.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true,results:null,lists:null,sample:null})}) },
  { n:"network abort",   h:(r)=>r.abort("failed") },
];
for (const c of CASES) {
  const ctx = await browser.newContext({viewport:{width:1280,height:900}});
  const page = await ctx.newPage();
  const errs=[]; page.on("pageerror",e=>errs.push(String(e.message).slice(0,110)));
  await page.route("**/api/**", c.h);
  await page.goto("http://127.0.0.1:8787/", { waitUntil:"load" }).catch(()=>{});
  await page.waitForTimeout(3500);
  // exercise tabs + a search under the fault
  for (const t of ["lists","discover","search","settings","catalogs"]) { try{ await page.click("#tab-desktop-"+t,{timeout:1500}); await page.waitForTimeout(350);}catch(e){} }
  try { await page.click("#tab-desktop-search",{timeout:1500}); await page.fill("#catalogSearchInput","test"); await page.waitForTimeout(1500);} catch(e){}
  const s = await page.evaluate(()=>{
    const vis=(e)=>{const r=e.getBoundingClientRect();const st=getComputedStyle(e);return r.width>0&&r.height>0&&st.visibility!=='hidden'&&st.display!=='none';};
    return { booted: typeof window.addRow==='function',
      visibleButtons: [...document.querySelectorAll('button')].filter(vis).length,
      stuckSpinners: [...document.querySelectorAll('[class*="spinner"],[class*="loading"]')].filter(vis).length,
      blockingOverlay: [...document.querySelectorAll('.modal-overlay')].filter(vis).length,
      scrollLocked: document.documentElement.style.overflow==='hidden',
      tabsClickable: !!document.getElementById('tab-desktop-lists'),
      bodyText: (document.body.innerText||'').trim().length };
  });
  // can the user still navigate after the fault?
  let navOk=true; try { await page.click("#tab-desktop-lists",{timeout:2000}); } catch(e){ navOk=false; }
  console.log(c.n.padEnd(16), JSON.stringify({...s, navOk, pageerrors:[...new Set(errs)].slice(0,2)}));
  await ctx.close();
}
await browser.close();

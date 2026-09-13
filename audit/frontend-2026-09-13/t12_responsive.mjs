import pw from "playwright-core";
import { installMocks } from "./mocks.mjs";
const { chromium } = pw;
const CHROMIUM = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const WIDTHS = [320,375,390,412,768,1024,1280,1440,1920];
const browser = await chromium.launch({ executablePath:CHROMIUM, args:["--no-sandbox","--disable-dev-shm-usage"] });
const TABS=["catalogs","lists","channels","discover","search","settings"];
for (const w of WIDTHS) {
  const ctx = await browser.newContext({ viewport:{width:w,height:800}, isMobile:w<768, hasTouch:w<768 });
  const page = await ctx.newPage();
  const errs=[]; page.on("pageerror",e=>errs.push(String(e.message).slice(0,120)));
  await installMocks(page,{});
  await page.goto("http://127.0.0.1:8787/", { waitUntil:"load" });
  await page.waitForTimeout(3000);
  const rows=[];
  for (const t of TABS) {
    const sel = w<768 ? "#tab-mobile-"+t : "#tab-desktop-"+t;
    try { await page.click(sel,{timeout:2500}); } catch(e){ try{ await page.click("#tab-desktop-"+t,{timeout:1500}); }catch(e2){} }
    await page.waitForTimeout(700);
    const m = await page.evaluate(() => {
      const de=document.documentElement;
      const over=[];
      document.querySelectorAll('*').forEach(el=>{
        const r=el.getBoundingClientRect(); const s=getComputedStyle(el);
        if (s.display==='none'||s.visibility==='hidden'||r.width===0) return;
        if (r.right > window.innerWidth + 2) over.push((el.tagName+"."+String(el.className).split(" ")[0]).slice(0,40)+" right="+Math.round(r.right));
      });
      // controls clipped/unreachable
      const offLeft=[...document.querySelectorAll('button,a,input,select')].filter(el=>{const r=el.getBoundingClientRect();const s=getComputedStyle(el);return s.display!=='none'&&r.width>0&&r.left<-2;}).length;
      return { hScroll: de.scrollWidth - window.innerWidth, overflowing: [...new Set(over)].slice(0,6), overflowCount: over.length, offLeft };
    });
    rows.push({tab:t, ...m});
  }
  const bad = rows.filter(r=>r.hScroll>0 || r.overflowCount>0 || r.offLeft>0);
  console.log("W="+w, bad.length? JSON.stringify(bad) : "OK (no horizontal overflow on any tab)", errs.length?("ERRS:"+JSON.stringify([...new Set(errs)])):"" );
  await ctx.close();
}
await browser.close();

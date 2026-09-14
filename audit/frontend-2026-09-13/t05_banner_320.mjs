import pw from "playwright-core";
import { installMocks } from "./mocks.mjs";
const { chromium } = pw;
const CHROMIUM = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({ executablePath:CHROMIUM, args:["--no-sandbox","--disable-dev-shm-usage"] });
for (const w of [320,375,412,768,1280]) {
  const page = await (await browser.newContext({viewport:{width:w,height:720}, isMobile:w<768, hasTouch:w<768})).newPage();
  await installMocks(page,{});
  await page.goto("http://127.0.0.1:8787/", { waitUntil:"load" });
  await page.waitForTimeout(2500);
  await page.evaluate(()=>{ try{ window.addRow('L1','tmdb:chart:popular','movie',true,'T'); eval('lastGeneratedConfigHash = computeConfigStateHash();'); window.addRow('L2','tmdb:chart:top_rated','movie',true,'T'); eval('checkUnsavedInstallLink();'); }catch(e){} });
  await page.waitForTimeout(900);   // let the 0.25s transition finish
  const r = await page.evaluate((vw)=>{
    const b=document.getElementById('unsavedInstallBanner'); const btn=document.getElementById('unsavedInstallBtn');
    const nav=document.querySelector('nav.bottom-nav');
    const br=b.getBoundingClientRect(), rr=btn.getBoundingClientRect();
    const nr = nav? nav.getBoundingClientRect():null;
    const cx=Math.min(rr.left+rr.width/2, vw-1), cy=rr.top+rr.height/2;
    const el=document.elementFromPoint(cx,cy);
    return { opacity:getComputedStyle(b).opacity,
      bannerZ:getComputedStyle(b).zIndex, navZ: nav?getComputedStyle(nav).zIndex:null, navDisplay: nav?getComputedStyle(nav).display:null,
      bannerRect:{t:Math.round(br.top),b:Math.round(br.bottom),l:Math.round(br.left),r:Math.round(br.right)},
      navRect: nr?{t:Math.round(nr.top),b:Math.round(nr.bottom)}:null,
      btn:{l:Math.round(rr.left),r:Math.round(rr.right),w:Math.round(rr.width)},
      visibleW: Math.round(Math.max(0,Math.min(rr.right,vw)-Math.max(rr.left,0))),
      hitAtCentre: el? (el.id||el.tagName+"."+String(el.className).split(" ")[0]) : null,
      overlapsNav: nr ? (rr.bottom > nr.top && rr.top < nr.bottom) : false };
  }, w);
  console.log("W="+String(w).padEnd(5), JSON.stringify(r));
  await page.context().close();
}
await browser.close();

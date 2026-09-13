import pw from "playwright-core";
import { installMocks } from "./mocks.mjs";
const { chromium } = pw;
const CHROMIUM = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({ executablePath:CHROMIUM, args:["--no-sandbox","--disable-dev-shm-usage"] });
const page = await (await browser.newContext({viewport:{width:1280,height:900}})).newPage();
await installMocks(page,{});
await page.goto("http://127.0.0.1:8787/", { waitUntil:"load" }); await page.waitForTimeout(3000);
for (const t of ["catalogs","lists","channels","discover","search","settings"]) {
  try{ await page.click("#tab-desktop-"+t,{timeout:2500}); }catch(e){}
  await page.waitForTimeout(900);
  const a = await page.evaluate(() => {
    const vis=(e)=>{const r=e.getBoundingClientRect();const s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';};
    const inputs=[...document.querySelectorAll('input,select,textarea')].filter(vis).filter(i=>i.type!=='hidden');
    const unl = inputs.filter(i=>{
      if (i.getAttribute('aria-label')||i.getAttribute('aria-labelledby')||i.getAttribute('title')) return false;
      if (i.id && document.querySelector('label[for="'+CSS.escape(i.id)+'"]')) return false;
      if (i.closest('label')) return false;
      return true; });
    return { inputs: inputs.length, unlabelled: unl.length,
      sample: unl.map(i=>(i.tagName+"#"+(i.id||"?")+"["+(i.type||"")+"] ph='"+(i.placeholder||"")+"'").slice(0,58)).slice(0,6),
      clickableNonBtn: [...document.querySelectorAll('[onclick]')].filter(e=>vis(e)&&!['BUTTON','A','INPUT','SELECT','TEXTAREA'].includes(e.tagName)&&e.getAttribute('role')!=='button'&&!e.hasAttribute('tabindex')).length,
      btnNoName: [...document.querySelectorAll('button')].filter(vis).filter(b=>!(b.textContent||'').trim()&&!b.getAttribute('aria-label')&&!b.getAttribute('title')).length };
  });
  console.log(t.padEnd(10), JSON.stringify(a));
}
await browser.close();

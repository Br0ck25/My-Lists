import pw from "playwright-core";
const { chromium } = pw;
const CHROMIUM = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({ executablePath:CHROMIUM, args:["--no-sandbox","--disable-dev-shm-usage"] });
const URLS = [
  "http://127.0.0.1:8787/lists/alice/evil-list",
  "http://127.0.0.1:8787/creator/alice",
  "http://127.0.0.1:8787/?q=" + encodeURIComponent('"><img src=x onerror="window.__XSS=1">'),
  "http://127.0.0.1:8787/#/list?url=" + encodeURIComponent('javascript:window.__XSS=1'),
];
for (const u of URLS) {
  const ctx = await browser.newContext({viewport:{width:1280,height:900}});
  const page = await ctx.newPage();
  const errs=[]; page.on("pageerror",e=>errs.push(String(e.message).slice(0,120)));
  let status = null;
  page.on("response", r=>{ if (r.url()===u) status = r.status(); });
  try { await page.goto(u, { waitUntil:"load", timeout:25000 }); } catch(e){ console.log(u.slice(0,70), "NAV ERR", e.message.slice(0,60)); await ctx.close(); continue; }
  await page.waitForTimeout(4000);
  const r = await page.evaluate(() => ({
    xss: window.__XSS || 0,
    title: document.title.slice(0,60),
    scripts: document.querySelectorAll('script').length,
    // did the payload break out of the inline script / an attribute?
    strayImg: [...document.querySelectorAll('img[onerror]')].filter(i=>(i.getAttribute('onerror')||'').includes('__XSS')).length,
    straySvg: [...document.querySelectorAll('svg[onload]')].filter(i=>(i.getAttribute('onload')||'').includes('__XSS')).length,
    booted: typeof window.addRow === 'function',
    bodyLen: (document.body.innerText||'').length,
  }));
  console.log(u.slice(0,72).padEnd(74), "status="+status, JSON.stringify(r), (errs.length ? "ERR:"+JSON.stringify([...new Set(errs)].slice(0,1)) : ""));
  await ctx.close();
}
await browser.close();

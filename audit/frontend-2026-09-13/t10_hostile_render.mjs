import pw from "playwright-core";
import { installMocks, XSS } from "./mocks.mjs";
const { chromium } = pw;
const CHROMIUM = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({ executablePath: CHROMIUM, args:["--no-sandbox","--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ viewport:{width:1400,height:1000} });
const page = await ctx.newPage();
const errs=[]; page.on("pageerror",e=>errs.push(String(e.message).slice(0,160)));
await installMocks(page, { hostile: true });
await page.goto("http://127.0.0.1:8787/", { waitUntil: "load" });
await page.waitForTimeout(5000);
const tabs = await page.$$eval('[role="tab"],.tab,.tab-btn,.nav-tab', els => els.map(e=>({t:(e.textContent||"").trim().slice(0,30), id:e.id||"", cls:e.className})).slice(0,20));
console.log("TABS:", JSON.stringify(tabs));
// click through every visible tab, then probe
for (const sel of ['[role="tab"]','.tab','.tab-btn','.nav-tab']) {
  const els = await page.$$(sel);
  for (let i=0;i<Math.min(els.length,12);i++) {
    try { await els[i].click({timeout:1500}); await page.waitForTimeout(400); } catch(e){}
  }
}
await page.waitForTimeout(2000);
const res = await page.evaluate(() => ({
  xss: window.__XSS || 0, xssurl: window.__XSSURL || 0,
  imgOnerror: document.querySelectorAll('img[onerror]').length,
  svgOnload: document.querySelectorAll('svg[onload]').length,
  jsHrefs: [...document.querySelectorAll('a[href^="javascript:"]')].length,
  rawProbeInText: (document.body.innerText||"").includes('onerror='),
  htmlLen: document.documentElement.innerHTML.length,
}));
console.log("XSS PROBE:", JSON.stringify(res));
console.log("pageerrors:", JSON.stringify(errs.slice(0,10)));
await browser.close();

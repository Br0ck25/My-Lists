import pw from "playwright-core";
import { installMocks } from "./mocks.mjs";
const { chromium } = pw;
const CHROMIUM = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({ executablePath:CHROMIUM, args:["--no-sandbox","--disable-dev-shm-usage"] });
const page = await (await browser.newContext({viewport:{width:1400,height:1000}})).newPage();
const errs=[]; page.on("pageerror",e=>errs.push(String(e.message).slice(0,180)));
await installMocks(page,{});
await page.goto("http://127.0.0.1:8787/", { waitUntil:"load" });
await page.waitForTimeout(3500);

const state = () => page.evaluate(() => ({
  overlays: document.querySelectorAll('#activeModalOverlay').length,
  allOverlays: document.querySelectorAll('.modal-overlay').length,
  htmlOverflow: document.documentElement.style.overflow,
  padRight: document.documentElement.style.paddingRight,
  depth: (typeof window.__d==='undefined') ? null : null,
  bodyChildren: document.body.children.length,
  activeEl: document.activeElement ? (document.activeElement.tagName + "#" + (document.activeElement.id||"")) : null,
}));

console.log("BASELINE:", JSON.stringify(await state()));

// 1) 120 open/close cycles -> leaks?
const before = await page.evaluate(() => ({ nodes: document.getElementsByTagName('*').length }));
for (let i=0;i<120;i++){
  await page.evaluate(()=>window.showModal('<h2>T</h2><button id="b1">ok</button>'));
  await page.evaluate(()=>window.closeModal());
}
const after = await page.evaluate(() => ({ nodes: document.getElementsByTagName('*').length }));
console.log("120 open/close  nodes before/after:", before.nodes, after.nodes, " state:", JSON.stringify(await state()));

// 2) scroll lock accounting: open dynamic modal from inside a static modal
const r = await page.evaluate(() => {
  const out = {};
  const root = document.documentElement;
  // simulate a static modal being open: it locks
  window.lockBackgroundScroll(true);
  out.afterStaticLock = root.style.overflow;
  window.showModal('<h2>Dynamic</h2>');          // showModal -> closeModal() -> unlock, then lock
  out.afterDynamicOpen = root.style.overflow;
  window.closeModal();                            // closes dynamic -> unlock
  out.afterDynamicClose = root.style.overflow;   // STATIC still open: should still be 'hidden'
  return out;
});
console.log("SCROLL LOCK NESTING:", JSON.stringify(r));

// 3) stacked showModal (modal from modal)
const r2 = await page.evaluate(() => {
  window.showModal('<h2>A</h2><button id="ba">a</button>');
  const a = document.querySelectorAll('.modal-overlay').length;
  window.showModal('<h2>B</h2><button id="bb">b</button>');
  const b = document.querySelectorAll('.modal-overlay').length;
  const txt = document.getElementById('activeModalOverlay').textContent;
  window.closeModal();
  return { afterA:a, afterB:b, visibleText:txt.slice(0,20), afterClose: document.querySelectorAll('.modal-overlay').length, overflow: document.documentElement.style.overflow };
});
console.log("STACKED MODALS:", JSON.stringify(r2));

// 4) Escape + outside-click + focus restore
await page.evaluate(()=>{ document.getElementById('tab-desktop-settings').focus(); window.showModal('<h2>Esc</h2><button id="bx">x</button>'); });
await page.waitForTimeout(200);
const focIn = await page.evaluate(()=>document.activeElement.tagName+"#"+(document.activeElement.id||""));
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
const focOut = await page.evaluate(()=>({ el: document.activeElement.tagName+"#"+(document.activeElement.id||""), overlays: document.querySelectorAll('.modal-overlay').length }));
console.log("ESCAPE:", JSON.stringify({focIn, focOut}));
console.log("pageerrors:", JSON.stringify([...new Set(errs)]));
await browser.close();

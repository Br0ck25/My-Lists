import pw from "playwright-core";
import { installMocks } from "./mocks.mjs";
const { chromium } = pw;
const CHROMIUM = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({ executablePath:CHROMIUM, args:["--no-sandbox","--disable-dev-shm-usage"] });
// A realistic backup: one list literally named 2024 (unquoted number in hand-edited JSON)
const BACKUP = { version:"3.0", entries:[
  { name:"My Good List", url:"tmdb:chart:popular", type:"movie", enabled:true, group:"Custom" },
  { name:2024,           url:"tmdb:chart:top_rated", type:"movie", enabled:true, group:"Custom" },
  { name:"Another List", url:"tmdb:chart:trending", type:"movie", enabled:true, group:"Custom" },
]};
const page = await (await browser.newContext({viewport:{width:1280,height:900}})).newPage();
const errs=[]; page.on("pageerror",e=>errs.push(String(e.message).slice(0,140)));
await installMocks(page,{});
await page.goto("http://127.0.0.1:8787/", { waitUntil:"load" }); await page.waitForTimeout(3000);

const before = await page.evaluate(()=>document.querySelectorAll('#lists .entry').length);
console.log("rows BEFORE import:", before);

// the real user path: paste into the config box and press Import
await page.evaluate((b)=>{ const el=document.getElementById('configJsonBox'); el.value = JSON.stringify(b); }, BACKUP);
await page.evaluate(()=>{ window.importConfigJson(); }).catch(e=>{ console.log("   evaluate rejected (uncaught in handler):", String(e.message).split("\n")[0].slice(0,90)); });
await page.waitForTimeout(1500);

const after = await page.evaluate(()=>({
  rows: document.querySelectorAll('#lists .entry').length,
  rowNames: [...document.querySelectorAll('#lists .entry .name')].map(i=>i.value||i.textContent).slice(0,6),
  importThrew: window.__importThrew || null,
  modalShown: document.querySelectorAll('.modal-overlay').length,
  modalText: (document.querySelector('#activeModalOverlay')?.textContent||'').trim().slice(0,140),
  scrollLocked: document.documentElement.style.overflow==='hidden',
  stillWorks: typeof window.addRow==='function',
}));
console.log("AFTER import:", JSON.stringify(after,null,1));
console.log("uncaught pageerrors:", JSON.stringify([...new Set(errs)]));
console.log(after.rows < 3 ? ">>> DATA LOSS: valid entries were dropped and no report shown" : ">>> import survived");
await browser.close();

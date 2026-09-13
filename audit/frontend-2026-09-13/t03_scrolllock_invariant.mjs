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

const violations = await page.evaluate(async () => {
  const OPS = {
    openSelect:   () => window.openSelectListModal('tt0111161','movie','Shawshank',''),
    closeSelect:  () => window.closeSelectListModal(),
    openCreate:   () => window.openCreateListModal(),
    closeCreate:  () => window.closeCreateListModal(),
    showAlert:    () => window.showAppAlert('T','m',false),
    showModal:    () => window.showModal('<h2>X</h2><button>b</button>'),
    closeModal:   () => window.closeModal(),
  };
  const names = Object.keys(OPS);
  const anyModalOpen = () => {
    if (document.getElementById('activeModalOverlay')) return true;
    for (const id of ['createListModal','selectListModal','addShelfModal','traktDeviceModal']) {
      const el = document.getElementById(id);
      if (el && el.style.display && el.style.display !== 'none') return true;
    }
    return false;
  };
  const bad = [];
  let seq = [];
  // deterministic PRNG for reproducibility
  let s = 12345; const rnd = () => (s = (s*1103515245+12345) & 0x7fffffff) / 0x7fffffff;
  for (let trial = 0; trial < 400; trial++) {
    // reset to a clean state
    window.closeModal(); window.closeSelectListModal(); window.closeCreateListModal();
    while (document.documentElement.style.overflow === 'hidden') { window.lockBackgroundScroll(false); }
    seq = [];
    const len = 2 + Math.floor(rnd()*4);
    for (let i=0;i<len;i++){ const n = names[Math.floor(rnd()*names.length)]; seq.push(n); try{ OPS[n](); }catch(e){ seq.push('THREW:'+e.message.slice(0,40)); } }
    // now close everything the way a user would
    window.closeModal(); window.closeSelectListModal(); window.closeCreateListModal();
    const open = anyModalOpen();
    const locked = document.documentElement.style.overflow === 'hidden';
    if (!open && locked) { bad.push({ seq: seq.join(' > '), locked, open }); if (bad.length>=6) break; }
  }
  return bad;
});
console.log("INVARIANT VIOLATIONS (no modal open but page scroll-locked):", violations.length);
violations.forEach(v=>console.log("  SEQ:", v.seq));
console.log("pageerrors:", JSON.stringify([...new Set(errs)]));
await browser.close();

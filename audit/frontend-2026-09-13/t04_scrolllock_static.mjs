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
const ov = () => page.evaluate(()=>document.documentElement.style.overflow);

// A) static modal opened twice, closed once  -> scroll stuck?
console.log("A) double-open selectListModal");
let r = await page.evaluate(() => {
  const out={};
  window.openSelectListModal('tt0111161','movie','Shawshank','');
  out.afterOpen1 = document.documentElement.style.overflow;
  window.openSelectListModal('tt0111162','movie','Other','');
  out.afterOpen2 = document.documentElement.style.overflow;
  window.closeSelectListModal();
  out.afterClose = document.documentElement.style.overflow;
  out.modalVisible = document.getElementById('selectListModal').style.display;
  return out;
});
console.log("   ", JSON.stringify(r));

// reset
await page.reload({waitUntil:"load"}); await page.waitForTimeout(3000);

// B) static modal open, then a dynamic modal (showAppAlert) over it, close dynamic
console.log("B) dynamic modal over static modal");
r = await page.evaluate(() => {
  const out={};
  window.openSelectListModal('tt0111161','movie','Shawshank','');
  out.afterStaticOpen = document.documentElement.style.overflow;
  window.showAppAlert('Oops','something failed',false);   // -> showModal -> closeModal() first
  out.afterAlertOpen = document.documentElement.style.overflow;
  window.closeModal();
  out.afterAlertClose = document.documentElement.style.overflow;
  out.staticStillOpen = document.getElementById('selectListModal').style.display;
  return out;
});
console.log("   ", JSON.stringify(r));
// can the user actually scroll the page behind the still-open modal?
const scrolled = await page.evaluate(async () => { window.scrollTo(0,600); await new Promise(r=>setTimeout(r,80)); return window.pageYOffset; });
console.log("    page scrolled behind open modal to Y =", scrolled);

await page.reload({waitUntil:"load"}); await page.waitForTimeout(3000);
// C) close static modal that was never opened -> depth underflow?
console.log("C) stray closes then a normal modal");
r = await page.evaluate(() => {
  const out={};
  window.closeSelectListModal(); window.closeCreateListModal(); window.closeModal(); window.closeModal();
  window.showModal('<h2>Normal</h2>');
  out.afterOpen = document.documentElement.style.overflow;
  window.closeModal();
  out.afterClose = document.documentElement.style.overflow;
  return out;
});
console.log("   ", JSON.stringify(r));
console.log("pageerrors:", JSON.stringify([...new Set(errs)]));
await browser.close();

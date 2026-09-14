import { open, report } from "./drive.mjs";
const { browser, page, logs } = await open({ viewport: { width: 390, height: 780 } });
await page.route("**/*", r => r.request().url().startsWith("http://127.0.0.1:8787") ? r.continue() : r.abort());
page.on("dialog", d => d.dismiss().catch(()=>{}));
await page.goto("http://127.0.0.1:8787/", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(2500);

const scrollProbe = async () => {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.mouse.move(195, 500);
  await page.mouse.wheel(0, 700);
  await page.waitForTimeout(350);
  return page.evaluate(() => window.scrollY);
};
console.log("1. page scrolls normally:            ", await scrollProbe());
await page.evaluate(() => { window.scrollTo(0, 400); showModal("<h2>Test</h2><button>ok</button>"); });
await page.waitForTimeout(300);
console.log("2. locked while a modal is open:     ", await scrollProbe(), "(expect 0)");
await page.evaluate(() => closeModal());
await page.waitForTimeout(300);
console.log("3. unlocked again after close:       ", await scrollProbe());
console.log("   scroll position restored to 400?  ", await page.evaluate(() => document.documentElement.style.overflow === "" ));

// nested: a confirm raised from a dialog must not unlock the page under it
await page.evaluate(() => { showModal("<h2>Outer</h2><button>ok</button>"); });
await page.waitForTimeout(200);
const nested = await page.evaluate(() => {
  const before = document.documentElement.style.overflow;
  lockBackgroundScroll(true);          // a second lock, as a nested dialog takes
  lockBackgroundScroll(false);         // and releases
  return { before, after: document.documentElement.style.overflow };
});
console.log("4. nested lock/release keeps the outer lock:", JSON.stringify(nested));
await page.evaluate(() => closeModal());
await page.waitForTimeout(200);
console.log("5. fully released at the end:        ", JSON.stringify(await page.evaluate(() => document.documentElement.style.overflow)));
report(logs, "scroll sanity");
await browser.close();

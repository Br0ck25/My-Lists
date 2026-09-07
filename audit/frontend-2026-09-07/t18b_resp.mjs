import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
const WIDTHS = process.argv.slice(2).map(Number);
const TABS = ["catalogs","lists","channels","discover","search","settings"];
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: WIDTHS[0], height: 800 } });
await ctx.route("**/*", (route) => {
  const u = route.request().url();
  if (u.startsWith("http://127.0.0.1:8787")) return route.continue();
  return route.abort();
});
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", e => errs.push(String(e).slice(0,90)));
await page.goto("http://127.0.0.1:8787/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2500);
for (const w of WIDTHS) {
  await page.setViewportSize({ width: w, height: 800 });
  await page.waitForTimeout(500);
  const out = [];
  for (const t of TABS) {
    await page.click(`[data-tab="${t}"]`).catch(()=>{});
    await page.waitForTimeout(450);
    const r = await page.evaluate((vw) => {
      const de = document.documentElement;
      const hScroll = de.scrollWidth - de.clientWidth;
      let over = [];
      if (hScroll > 0) {
        over = [...document.querySelectorAll("body *")].filter(e => {
          const b = e.getBoundingClientRect();
          if (b.width === 0 || b.height === 0) return false;
          const s = getComputedStyle(e);
          if (s.display === "none" || s.visibility === "hidden") return false;
          return b.right > vw + 1.5 && b.width <= vw * 3;
        }).slice(0,4).map(e => e.tagName + "." + (e.className||"").toString().trim().split(/\s+/)[0] + "@" + Math.round(e.getBoundingClientRect().right));
      }
      const nav = document.querySelector(".bottom-nav");
      const navVis = nav ? getComputedStyle(nav).display !== "none" : false;
      const navItems = nav ? [...nav.querySelectorAll("button")].map(b=>Math.round(b.getBoundingClientRect().right)) : [];
      const navOver = navItems.filter(x => x > vw + 1).length;
      const tiny = [...document.querySelectorAll("button,a[href]")].filter(e=>{const b=e.getBoundingClientRect(); return b.width>0&&b.height>0&&(b.height<24||b.width<24);}).length;
      return { hScroll, over, navVis, navOver, tiny };
    }, w);
    out.push({ t, ...r });
  }
  const bad = out.filter(r => r.hScroll > 0);
  console.log(`w=${w}  maxHScroll=${Math.max(...out.map(r=>r.hScroll))}  navVisible=${out[0].navVis}  navItemsOffscreen=${Math.max(...out.map(r=>r.navOver))}  tinyTargets=${Math.max(...out.map(r=>r.tiny))}`);
  for (const b of bad) console.log(`    ${b.t}: hScroll=${b.hScroll} ${JSON.stringify(b.over)}`);
}
console.log("pageerrors:", errs.length, errs.slice(0,3));
await browser.close();

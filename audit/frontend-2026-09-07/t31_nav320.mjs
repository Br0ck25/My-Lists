import { open } from "./drive.mjs";
const { browser, page } = await open({ viewport: { width: 320, height: 720 } });
await page.route("**/*", r => r.request().url().startsWith("http://127.0.0.1:8787") ? r.continue() : r.abort());
await page.goto("http://127.0.0.1:8787/", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(2200);
const nav = await page.evaluate(() => {
  const n = document.querySelector(".bottom-nav");
  const r = n.getBoundingClientRect();
  return { navRect: { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) },
    items: [...n.querySelectorAll("button")].map(b => { const x = b.getBoundingClientRect();
      return { label: b.textContent.trim().slice(0,10), left: Math.round(x.left), right: Math.round(x.right), w: Math.round(x.width), clipped: x.right > 320.5 }; }),
    overflowX: getComputedStyle(n).overflowX, viewport: window.innerWidth };
});
console.log(JSON.stringify(nav, null, 1));
const clipped = nav.items.filter(i=>i.clipped);
console.log(clipped.length ? `\n*** ${clipped.length} bottom-nav item(s) extend past the 320px viewport: ${clipped.map(c=>c.label+"(right="+c.right+")").join(", ")} ***` : "\nnav fits");
// can the last item still be tapped?
if (clipped.length) {
  const label = clipped[clipped.length-1].label;
  const ok = await page.evaluate((l) => {
    const b = [...document.querySelectorAll(".bottom-nav button")].find(x=>x.textContent.trim().startsWith(l));
    const r = b.getBoundingClientRect();
    const cx = Math.min(r.left + r.width/2, window.innerWidth - 2), cy = r.top + r.height/2;
    const hit = document.elementFromPoint(cx, cy);
    return { centerX: Math.round(r.left + r.width/2), reachable: !!(hit && (hit === b || b.contains(hit))) };
  }, label);
  console.log("last nav item tap test:", JSON.stringify(ok));
}
await page.screenshot({ path: "nav320.png", clip: { x:0, y: 620, width: 320, height: 100 } });
console.log("screenshot -> rig/nav320.png");
await browser.close();

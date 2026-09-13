import pw from "playwright-core";
const { chromium } = pw;
const CHROMIUM = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({ executablePath: CHROMIUM, args:["--no-sandbox","--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ viewport:{width:1280,height:900} });
const page = await ctx.newPage();
const posts = [];
await page.route("**/api/**", async (route) => {
  const r = route.request();
  posts.push({ m: r.method(), u: r.url().replace("http://127.0.0.1:8787",""), b: (r.postData()||"").slice(0,200) });
  await route.continue();
});
await page.goto("http://127.0.0.1:8787/", { waitUntil: "load" });
await page.waitForTimeout(6000);
const counts = {};
for (const p of posts) { const k = p.m+" "+p.u.split("?")[0]+" :: "+p.b; counts[k]=(counts[k]||0)+1; }
const dupes = Object.entries(counts).filter(([,n])=>n>1).sort((a,b)=>b[1]-a[1]);
console.log("total api calls on load:", posts.length);
console.log("distinct payloads:", Object.keys(counts).length);
console.log("DUPLICATE payloads (identical method+url+body):");
for (const [k,n] of dupes.slice(0,15)) console.log("  x"+n, k.slice(0,180));
console.log("\nsample distinct bodies:");
for (const k of Object.keys(counts).slice(0,8)) console.log("  ", k.slice(0,170));
await browser.close();

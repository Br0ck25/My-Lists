import { open } from "./drive.mjs";
const { browser, context, page } = await open();
await context.route("**/*", r => r.request().url().startsWith("http://127.0.0.1:8787") ? r.continue() : r.abort());
await page.goto("http://127.0.0.1:8787/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2500);
const cdp = await context.newCDPSession(page);
await cdp.send("Performance.enable");
const metrics = async () => {
  const m = await cdp.send("Performance.getMetrics");
  const g = (n) => (m.metrics.find(x=>x.name===n)||{}).value;
  return { nodes: g("Nodes"), listeners: g("JSEventListeners"), docs: g("Documents"), heapMB: +(g("JSHeapUsedSize")/1048576).toFixed(1) };
};
const base = await metrics(); console.log("baseline      :", JSON.stringify(base));

// 200 modal open/close cycles
await page.evaluate(async () => { for (let i=0;i<200;i++) { showModal("<h2>t"+i+"</h2><button>x</button>"); closeModal(); } });
await page.waitForTimeout(600); await cdp.send("HeapProfiler.collectGarbage").catch(()=>{});
console.log("200 modals    :", JSON.stringify(await metrics()));

// 200 tab switches
await page.evaluate(async () => { const t=["catalogs","lists","channels","discover","search","settings"]; for (let i=0;i<200;i++) switchTab(t[i%6]); });
await page.waitForTimeout(1200); await cdp.send("HeapProfiler.collectGarbage").catch(()=>{});
console.log("200 tab flips :", JSON.stringify(await metrics()));

// 60 searches
for (let i=0;i<60;i++) await page.evaluate((i)=>{ const el=document.getElementById("catalogSearchInput"); el.value="q"+i; handleCatalogSearchInput(el); }, i);
await page.waitForTimeout(3000); await cdp.send("HeapProfiler.collectGarbage").catch(()=>{});
const end = await metrics();
console.log("60 searches   :", JSON.stringify(end));
console.log("\ndelta listeners:", end.listeners - base.listeners, " nodes:", end.nodes - base.nodes, " heapMB:", (end.heapMB-base.heapMB).toFixed(1));
await browser.close();

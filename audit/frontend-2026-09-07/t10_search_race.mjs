import { open, report } from "./drive.mjs";
const ctl = (b) => fetch("http://127.0.0.1:8787/__ctl", { method:"POST", body: JSON.stringify(b) }).then(r=>r.json());

await ctl({ reset: true, faults: [
  // "slowq" takes 4s and returns a distinctive result; everything else is fast
  { match: "title-search.*q=slowq", delayMs: 4000, status: 200,
    body: JSON.stringify({ ok:true, results:[{ id:"tmdb:1", tmdbId:1, title:"SLOW-RESULT", name:"SLOW-RESULT", type:"movie", year:"1990", poster:"", vote_average:1, genre_ids:[] }] }) },
  { match: "title-search.*q=fastq", delayMs: 100, status: 200,
    body: JSON.stringify({ ok:true, results:[{ id:"tmdb:2", tmdbId:2, title:"FAST-RESULT", name:"FAST-RESULT", type:"movie", year:"2020", poster:"", vote_average:9, genre_ids:[] }] }) },
]});

const { browser, page, logs } = await open();
await page.goto("http://127.0.0.1:8787/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2000);
await page.click('[data-tab="search"]');
await page.waitForTimeout(600);

// Case 1: slow query then fast query -> whose results end up on screen?
await page.fill("#catalogSearchInput", "slowq");
await page.press("#catalogSearchInput", "Enter");
await page.waitForTimeout(600);          // slow request is in flight
await page.fill("#catalogSearchInput", "fastq");
await page.press("#catalogSearchInput", "Enter");
await page.waitForTimeout(1500);
const mid = await page.evaluate(() => document.getElementById("catalogSearchResult").innerText.slice(0,120));
console.log("t=+2.1s (fast landed, slow still pending) shows:", JSON.stringify(mid));
await page.waitForTimeout(4000);         // let the slow one land
const after = await page.evaluate(() => ({
  box: document.getElementById("catalogSearchInput").value,
  shown: document.getElementById("catalogSearchResult").innerText.slice(0,120),
  raw: (window._rawCatalogTitleItems||[]).map(x=>x.title||x.name),
}));
console.log("t=+6s  input box =", JSON.stringify(after.box), " results =", JSON.stringify(after.shown));
console.log("  _rawCatalogTitleItems:", JSON.stringify(after.raw));
console.log(/SLOW-RESULT/.test(after.shown) ? "*** RACE CONFIRMED: obsolete response overwrote the newer one ***" : "  (no overwrite)");

// Case 2: search, then CLEAR the box while the request is in flight
await page.fill("#catalogSearchInput", "");
await page.waitForTimeout(1500);
await page.fill("#catalogSearchInput", "slowq");
await page.press("#catalogSearchInput", "Enter");
await page.waitForTimeout(500);
await page.fill("#catalogSearchInput", "");     // user clears -> default view
await page.waitForTimeout(5000);
const cleared = await page.evaluate(() => ({
  box: document.getElementById("catalogSearchInput").value,
  shown: document.getElementById("catalogSearchResult").innerText.slice(0,140),
}));
console.log("\nafter clearing the box mid-flight: input =", JSON.stringify(cleared.box), " results =", JSON.stringify(cleared.shown));
console.log(/SLOW-RESULT/.test(cleared.shown) ? "*** CONFIRMED: results for a query the user erased are shown over the default view ***" : "  (default view retained)");
report(logs, "search race");
await browser.close();
await ctl({ reset: true });

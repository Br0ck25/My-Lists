import { open, report } from "./drive.mjs";
const ctl = (b) => fetch("http://127.0.0.1:8787/__ctl", { method:"POST", body: JSON.stringify(b) }).then(r=>r.json());

async function scenario(label, faults, steps) {
  await ctl({ reset: true, faults });
  const { browser, page, logs } = await open();
  await page.route("**/*", r => r.request().url().startsWith("http://127.0.0.1:8787") ? r.continue() : r.abort());
  page.on("dialog", d => d.dismiss().catch(()=>{}));
  await page.goto("http://127.0.0.1:8787/", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2200);
  const out = await steps(page);
  const stuck = await page.evaluate(() => ({
    disabledVisibleButtons: [...document.querySelectorAll("button[disabled]")].filter(b=>b.offsetParent).map(b=>(b.textContent||"").trim().slice(0,28)),
    spinnersLeft: [...document.querySelectorAll(".status-spin")].filter(e=>e.offsetParent).length,
    overlay: !!document.getElementById("activeModalOverlay"),
    bodyOverflow: document.body.style.overflow,
    errorTextOnScreen: [...document.querySelectorAll(".testresult.err")].filter(e=>e.offsetParent).map(e=>e.textContent.trim().slice(0,60)).slice(0,3),
  }));
  console.log(`\n### ${label}`);
  console.log("  result:", JSON.stringify(out));
  console.log("  stuck-state:", JSON.stringify(stuck));
  const pe = logs.errors.length;
  if (pe) console.log("  PAGEERRORS:", pe, logs.errors[0].split("\n")[0].slice(0,140));
  await browser.close();
}

// 1. title-search 500
await scenario("search -> 500", [{ match: "/api/title-search", status: 500, body: '{"ok":false,"error":"boom"}' }], async (page) => {
  await page.click('[data-tab="search"]'); await page.waitForTimeout(400);
  await page.fill("#catalogSearchInput", "batman"); await page.press("#catalogSearchInput", "Enter");
  await page.waitForTimeout(2000);
  return { shown: await page.evaluate(()=>document.getElementById("catalogSearchResult").innerText.slice(0,90)) };
});
// 2. title-search malformed JSON
await scenario("search -> malformed JSON", [{ match: "/api/title-search", status: 200, body: '{"ok":true, "results": [' , contentType:"application/json" }], async (page) => {
  await page.click('[data-tab="search"]'); await page.waitForTimeout(400);
  await page.fill("#catalogSearchInput", "batman"); await page.press("#catalogSearchInput", "Enter");
  await page.waitForTimeout(2000);
  return { shown: await page.evaluate(()=>document.getElementById("catalogSearchResult").innerText.slice(0,90)) };
});
// 3. title-search HTML (502 from an edge)
await scenario("search -> 502 HTML body", [{ match: "/api/title-search", status: 502, body: "<html><body>Bad gateway</body></html>", contentType: "text/html" }], async (page) => {
  await page.click('[data-tab="search"]'); await page.waitForTimeout(400);
  await page.fill("#catalogSearchInput", "batman"); await page.press("#catalogSearchInput", "Enter");
  await page.waitForTimeout(2000);
  return { shown: await page.evaluate(()=>document.getElementById("catalogSearchResult").innerText.slice(0,90)) };
});
// 4. search -> 429
await scenario("search -> 429", [{ match: "/api/title-search", status: 429, body: '{"ok":false,"error":"Too many requests."}' }], async (page) => {
  await page.click('[data-tab="search"]'); await page.waitForTimeout(400);
  await page.fill("#catalogSearchInput", "batman"); await page.press("#catalogSearchInput", "Enter");
  await page.waitForTimeout(2000);
  return { shown: await page.evaluate(()=>document.getElementById("catalogSearchResult").innerText.slice(0,90)) };
});
// 5. sign-in -> 401
await scenario("sign-in -> 401", [{ match: "/api/creator/restore", status: 401, body: '{"ok":false,"error":"Wrong key."}' }], async (page) => {
  await page.evaluate(async () => { openRestoreModal(); await new Promise(r=>setTimeout(r,250));
    document.getElementById("restoreNameInput").value="alice"; document.getElementById("restoreKeyInput").value="MYL-XXXX-XXXX-XXXX";
    await submitRestoreProfile(); });
  await page.waitForTimeout(1200);
  return { err: await page.evaluate(()=>document.getElementById("restoreModalError")?.innerText.trim().slice(0,70)),
           stillOpen: await page.evaluate(()=>!!document.getElementById("activeModalOverlay")) };
});
// 6. sign-in -> dropped connection
await scenario("sign-in -> connection dropped", [{ match: "/api/creator/restore", drop: true }], async (page) => {
  await page.evaluate(async () => { openRestoreModal(); await new Promise(r=>setTimeout(r,250));
    document.getElementById("restoreNameInput").value="alice"; document.getElementById("restoreKeyInput").value="MYL-XXXX-XXXX-XXXX";
    await submitRestoreProfile(); });
  await page.waitForTimeout(1500);
  return { err: await page.evaluate(()=>document.getElementById("restoreModalError")?.innerText.trim().slice(0,70)) };
});
// 7. live preview -> 500
await scenario("live preview -> 500", [{ match: "/api/preview", status: 500, body: '{"ok":false,"error":"boom"}' }], async (page) => {
  await page.evaluate(() => { if (typeof addRow === "function") addRow("Test Row","https://mdblist.com/lists/a/b","movie"); });
  await page.waitForTimeout(300);
  await page.evaluate(() => { if (typeof renderLivePreview === "function") renderLivePreview(); });
  await page.waitForTimeout(2500);
  return { shelf: await page.evaluate(()=>{const e=document.querySelector(".live-preview-posters"); return e?e.innerText.slice(0,80):"(none)";}) };
});
await ctl({ reset: true });

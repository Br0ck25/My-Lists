import { open, report } from "./drive.mjs";
const { browser, page, logs } = await open();
await page.route("**/*", r => r.request().url().startsWith("http://127.0.0.1:8787") ? r.continue() : r.abort());
page.on("dialog", d => { console.log("  dialog:", d.message().slice(0,50)); d.dismiss().catch(()=>{}); });
await page.goto("http://127.0.0.1:8787/admin", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(700);
await page.fill("input[type=password]", "test-admin-secret");
await page.click("button");
await page.waitForTimeout(3500);

const probe = await page.evaluate(() => {
  const names = ["runDeleteCreatorLists","loadAnalytics","loadFeedback","switchAdminTab","loadLeaderboard",
                 "runRebuildIndex","loadPublishedLists","runResetCreatorKey","loadApiUsage","runProviderLookup",
                 "loadSchemaStatus","runNetflixPreview","runMigrateD1"];
  const out = {};
  for (const n of names) out[n] = typeof window[n];
  return { defined: out,
    onclickCount: document.querySelectorAll("[onclick]").length,
    idCount: document.querySelectorAll("[id]").length,
    bodyText: document.body.innerText.replace(/\s+/g," ").slice(0,200) };
});
console.log("admin globals after login:", JSON.stringify(probe.defined, null, 1));
console.log("elements with onclick:", probe.onclickCount, " page text:", JSON.stringify(probe.bodyText));

// click every visible admin button and count ReferenceErrors
const before = logs.errors.length;
const btns = await page.$$("button, [onclick]");
let clicked = 0;
for (const b of btns) {
  try { const vis = await b.evaluate(e=>!!e.offsetParent); if (!vis) continue; await b.click({timeout:900}); clicked++; await page.waitForTimeout(120); } catch {}
}
await page.waitForTimeout(1500);
console.log(`\nclicked ${clicked} visible admin controls -> ${logs.errors.length - before} new page errors`);
const uniq = [...new Set(logs.errors.slice(before).map(e=>e.split("\n")[0]))];
console.log("distinct errors:", JSON.stringify(uniq.slice(0,12), null, 1));
await browser.close();

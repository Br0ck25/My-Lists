import { open } from "./drive.mjs";
const { browser, page } = await open();
await page.route("**/*", r => r.request().url().startsWith("http://127.0.0.1:8787") ? r.continue() : r.abort());
await page.goto("http://127.0.0.1:8787/", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(2500);
console.log("remaining unlabelled controls:", JSON.stringify(await page.evaluate(() => {
  const inputs = [...document.querySelectorAll("input,select,textarea")].filter(e => e.type !== "hidden");
  return inputs.filter(e => !e.labels?.length && !e.getAttribute("aria-label") && !e.getAttribute("aria-labelledby") && !e.getAttribute("title") && !e.placeholder)
    .map(e => ({ tag: e.tagName, id: e.id || "(none)", cls: (e.className||"").toString().slice(0,30), opts: e.tagName === "SELECT" ? [...e.options].slice(0,3).map(o=>o.textContent.trim()) : undefined }));
}), null, 1));
// live region appears once a toast is used
await page.evaluate(() => showAddedToast("Added to My Catalogs"));
await page.waitForTimeout(300);
console.log("\nafter a toast fires:", JSON.stringify(await page.evaluate(() => {
  const t = document.getElementById("actionToast");
  return { exists: !!t, role: t && t.getAttribute("role"), live: t && t.getAttribute("aria-live"), text: t && t.textContent,
           liveRegions: document.querySelectorAll("[aria-live]").length };
})));
// tab semantics
console.log("\ntab wiring:", JSON.stringify(await page.evaluate(() => {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const bad = tabs.filter(t => !document.getElementById(t.getAttribute("aria-controls") || ""));
  const panels = [...document.querySelectorAll('[role="tabpanel"]')];
  return { tabs: tabs.length, tabsWithBrokenAriaControls: bad.length, panels: panels.length,
           panelsWithBrokenLabel: panels.filter(p => !document.getElementById(p.getAttribute("aria-labelledby")||"")).length,
           selectedCount: tabs.filter(t => t.getAttribute("aria-selected") === "true").length,
           tabbable: tabs.filter(t => t.getAttribute("tabindex") === "0").length };
})));
// arrow keys move between tabs
await page.evaluate(() => document.querySelector('.tab-bar [role="tab"][aria-selected="true"]').focus());
await page.keyboard.press("ArrowRight");
await page.waitForTimeout(500);
console.log("\nafter ArrowRight from the selected tab:", JSON.stringify(await page.evaluate(() => ({
  focused: document.activeElement.getAttribute("data-tab"),
  selected: document.querySelector('.tab-bar [role="tab"][aria-selected="true"]').getAttribute("data-tab"),
  visiblePanel: [...document.querySelectorAll("[data-tab-panel]")].filter(e=>!e.hidden && e.offsetParent).map(e=>e.dataset.tabPanel),
}))));
// only one nav bar is exposed at a time?
for (const w of [390, 1280]) {
  await page.setViewportSize({ width: w, height: 800 });
  await page.waitForTimeout(400);
  console.log(`w=${w} exposed tablists:`, await page.evaluate(() =>
    [...document.querySelectorAll('[role="tablist"]')].filter(e => getComputedStyle(e).display !== "none").map(e => e.className)));
}
await browser.close();

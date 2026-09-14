import { open } from "./drive.mjs";
// FE-15: the app must OPEN offline, and must never be pinned to a stale shell.
const { browser, context, page, logs } = await open();
const dump = async (label) => {
  const c = await page.evaluate(async () => {
    const out = {};
    for (const n of await caches.keys()) {
      const cc = await caches.open(n);
      out[n] = (await cc.keys()).map(r => new URL(r.url).pathname + new URL(r.url).search);
    }
    return out;
  });
  console.log(label, JSON.stringify(c));
};

await page.goto("http://127.0.0.1:8787/", { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(2500);
await dump("after visit 1:");
await page.reload({ waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(2500);
await dump("after visit 2:");

// --- the actual finding: reload with no network ---
await context.setOffline(true);
const nav = await page.goto("http://127.0.0.1:8787/", { waitUntil: "domcontentloaded", timeout: 30000 })
  .catch(e => ({ err: e.message.split("\n")[0] }));
console.log("\nOFFLINE reload:", nav && nav.err ? "FAILED -> " + nav.err : "status " + nav.status());
if (nav && !nav.err) {
  await page.waitForTimeout(3000);
  const st = await page.evaluate(() => ({
    title: document.title.slice(0, 40),
    tabs: document.querySelectorAll('[role="tab"]').length,
    bundleRan: typeof window.switchTab === "function",
    cssApplied: getComputedStyle(document.body).backgroundColor,
    visiblePanel: [...document.querySelectorAll("[data-tab-panel]")].filter(e => !e.hidden && e.offsetParent).map(e => e.dataset.tabPanel),
  }));
  console.log("  offline page:", JSON.stringify(st));
  console.log("  ", st.bundleRan && st.tabs === 12 ? "*** the app booted offline ***" : "!!! shell loaded but the app did not boot");
}
await context.setOffline(false);

// --- and it must not pin a stale shell when the network comes back ---
const before = await page.evaluate(async () => (await (await caches.open("mylists-shell-v2")).match("/")) ? "cached" : "absent");
const res = await page.goto("http://127.0.0.1:8787/", { waitUntil: "domcontentloaded", timeout: 30000 });
console.log("\nback online: shell was", before, "-> navigation served from", res.fromServiceWorker ? "SW" : "network", "status", res.status());
const fresh = await page.evaluate(() => !!document.querySelector('script[src^="/app.js?v="]'));
console.log("  page still names a versioned bundle:", fresh);
console.log("\npageerrors:", logs.errors.length, logs.errors.slice(0,2));
await browser.close();

import { open } from "./drive.mjs";
const ctl = (b) => fetch("http://127.0.0.1:8787/__ctl", { method:"POST", body: JSON.stringify(b) }).then(r=>r.json());
await ctl({ reset: true });

const { browser, context, page } = await open();

// 1. A browser carrying the OLD cache name must have it dropped on activate.
await page.goto("http://127.0.0.1:8787/", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.evaluate(async () => {
  const c = await caches.open("mylists-app-v1");
  await c.put("/app.js?v=OLDHASH", new Response("// stale bundle"));
});
console.log("seeded old cache:", await page.evaluate(async () => (await caches.keys()).sort()));
// unregister + reload so install/activate run again with the old cache present
await page.evaluate(async () => { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); });
await page.reload({ waitUntil: "networkidle", timeout: 45000 });
await page.waitForTimeout(3000);
console.log("after activate      :", await page.evaluate(async () => (await caches.keys()).sort()));

// 2. Network-first: a changed page must win over the cached copy.
await page.goto("http://127.0.0.1:8787/", { waitUntil: "networkidle", timeout: 45000 });
await page.waitForTimeout(2000);
console.log("\nshell cached        :", await page.evaluate(async () => !!(await (await caches.open("mylists-shell-v2")).match("/"))));

await ctl({ reset: true, faults: [{ match: "^/$", status: 200, contentType: "text/html",
  body: "<!doctype html><title>DEPLOYED-N-PLUS-1</title><body>new shell</body>" }] });
await page.goto("http://127.0.0.1:8787/", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(800);
const t = await page.title();
console.log("after a 'deploy'    :", JSON.stringify(t));
console.log("  ", /DEPLOYED-N-PLUS-1/.test(t)
  ? "*** network-first holds: the new page wins over the cached one ***"
  : "!!! STALE: the cached shell shadowed the deploy");
await ctl({ reset: true });
await browser.close();

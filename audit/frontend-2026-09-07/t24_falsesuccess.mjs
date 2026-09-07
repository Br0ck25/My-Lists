import { open } from "./drive.mjs";
const { browser, page, logs } = await open();
await page.route("**/*", r => r.request().url().startsWith("http://127.0.0.1:8787") ? r.continue() : r.abort());
await page.goto("http://127.0.0.1:8787/", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(2200);

// The server WILL reject this: no Trakt account is connected.
const probe = await page.evaluate(async () => {
  const r = await fetch("/api/external-list/item-mutate", { method:"POST", headers:{"content-type":"application/json"},
    body: JSON.stringify({ action:"remove", provider:"trakt", target:"watchlist", listId:"watchlist", id:"tt0137523", type:"movie" }) });
  return { status: r.status, body: (await r.text()).slice(0,120) };
});
console.log("server's answer to that exact mutation:", JSON.stringify(probe));

// Now drive the client function the Remove button calls.
const btn = await page.evaluateHandle(() => { const b = document.createElement("button"); b.textContent="Remove"; document.body.appendChild(b); return b; });
await page.evaluate(async (b) => {
  window.__toast = null;
  const orig = window.showAddedToast;
  window.showAddedToast = (m) => { window.__toast = m; };
  await removeSingleExternalItemDirect("trakt","watchlist","watchlist","tt0137523","movie", b);
  window.showAddedToast = orig;
}, btn);
await page.waitForTimeout(1200);
const res = await page.evaluate(() => ({
  toast: window.__toast,
  membership: (typeof getExternalListMembership === "function") ? getExternalListMembership("trakt:watchlist:watchlist:tt0137523") : "n/a",
}));
console.log("client outcome        :", JSON.stringify(res));
console.log(res.toast && /Removed/.test(res.toast)
  ? "\n*** CONFIRMED: the write was REJECTED by the server (400 ok:false) and the UI reported success ***"
  : "\nno false success");
console.log("\nrequests the client made to item-mutate:",
  logs.requests.filter(r=>r.url.includes("item-mutate")).length);
await browser.close();

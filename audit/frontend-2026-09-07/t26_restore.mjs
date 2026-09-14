import { open, report } from "./drive.mjs";
const { browser, page, logs } = await open();
await page.route("**/*", r => r.request().url().startsWith("http://127.0.0.1:8787") ? r.continue() : r.abort());
page.on("dialog", d => d.dismiss().catch(()=>{}));
await page.goto("http://127.0.0.1:8787/", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(2200);

// Export a real backup first so the shape is authentic.
const real = await page.evaluate(() => JSON.stringify(buildFullBackupPayload()).slice(0, 400));
console.log("shape of a genuine export (first 400 chars):", real);

// A backup whose likedLists holds objects instead of URL strings. This is what an
// older export, a hand-edited file, or a third-party tool can plausibly contain.
const backup = {
  version: "3.0",
  entries: [],
  settings: { likedLists: [{ url: "https://mdblist.com/lists/a/b", name: "Sci-Fi" }] },
};
await page.evaluate((b) => {
  document.getElementById("configJsonBox").value = JSON.stringify(b);
  importConfigJson();
}, backup);
await page.waitForTimeout(1500);
console.log("\nstored likedLists after restore:", await page.evaluate(()=>localStorage.getItem("myListAddon:likedLists")));
console.log("restore reported:", await page.evaluate(()=>{
  const o = document.getElementById("activeModalOverlay"); return o ? o.innerText.replace(/\s+/g," ").slice(0,160) : "(no report modal)"; }));

// Now use the app: Discover -> Curated
await page.evaluate(()=>closeModal());
await page.click('[data-tab="discover"]').catch(()=>{});
await page.waitForTimeout(800);
await page.click('#discoverSubnavBar [data-sub="curated"]').catch(()=>{});
await page.waitForTimeout(4000);
const feed = await page.evaluate(() => {
  const el = document.getElementById("curatedListsFeed");
  return { text: el ? el.innerText.replace(/\s+/g," ").trim().slice(0,180) : "(missing)", children: el ? el.children.length : -1 };
});
console.log("\nDiscover > Curated after the restore:", JSON.stringify(feed));
const errs = logs.console.filter(c=>c.type==="error"&&!/ERR_|Failed to load resource/.test(c.text)).map(c=>c.text.split("\n")[0].slice(0,110));
console.log("console errors:", JSON.stringify(errs));

// And it survives a reload -- permanent until storage is cleared by hand.
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(2200);
await page.click('[data-tab="discover"]').catch(()=>{});
await page.waitForTimeout(600);
await page.click('#discoverSubnavBar [data-sub="curated"]').catch(()=>{});
await page.waitForTimeout(4000);
console.log("\nafter a full reload:", JSON.stringify(await page.evaluate(() => {
  const el = document.getElementById("curatedListsFeed");
  return el ? el.innerText.replace(/\s+/g," ").trim().slice(0,140) : "(missing)"; })));
console.log("console errors after reload:", JSON.stringify(logs.console.filter(c=>c.type==="error"&&!/ERR_|Failed to load resource/.test(c.text)).map(c=>c.text.split("\n")[0].slice(0,110))));
await browser.close();

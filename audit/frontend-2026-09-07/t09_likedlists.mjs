import { open, report } from "./drive.mjs";
async function run(label, seed) {
  const { browser, page, logs } = await open();
  await page.addInitScript((s) => { if (s) localStorage.setItem("myListAddon:likedLists", s); }, seed);
  await page.goto("http://127.0.0.1:8787/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.click('[data-tab="discover"]').catch(()=>{});
  await page.waitForTimeout(1200);
  // click the "curated" pill
  await page.click('#discoverSubnavBar [data-sub="curated"]').catch(()=>{});
  await page.waitForTimeout(3500);
  const feed = await page.evaluate(() => {
    const el = document.getElementById("curatedListsFeed");
    return { present: !!el, text: el ? el.innerText.trim().slice(0,200) : "", childCount: el ? el.children.length : -1 };
  });
  const errs = logs.console.filter(c => c.type === "error" && !/ERR_CONNECTION_RESET|Failed to load resource/.test(c.text)).map(c=>c.text.split("\n")[0].slice(0,120));
  console.log(`\n[${label}]`);
  console.log("  curatedListsFeed:", JSON.stringify(feed));
  console.log("  errors:", JSON.stringify(errs));
  await browser.close();
}
await run("baseline (no liked lists)", null);
await run("normal (array of url strings)", JSON.stringify(["https://mdblist.com/lists/a/b"]));
await run("objects (what a restore can write)", JSON.stringify([{ url: "https://mdblist.com/lists/a/b", name: "x" }]));

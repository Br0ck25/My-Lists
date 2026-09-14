import { open } from "./drive.mjs";
const { browser, page } = await open({ viewport: { width: 390, height: 780 } });
await page.addInitScript(() => {
  localStorage.setItem("myListAddon:localCustomLists", JSON.stringify({
    "my-faves": { name: "My Faves", type: "movie", items: [{ id: "tt0111161", type: "movie", name: "Shawshank" }] }}));
});
await page.goto("http://127.0.0.1:8787/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2000);
await page.evaluate(() => openSelectListModal("tt0137523","movie","Fight Club",""));
await page.waitForTimeout(400);
console.log("modal open, body.style.overflow =", await page.evaluate(()=>document.body.style.overflow));
await page.evaluate(() => window.scrollTo(0,0));
await page.mouse.move(195, 700);   // over the overlay backdrop, below the card
await page.mouse.wheel(0, 900);
await page.waitForTimeout(500);
const y = await page.evaluate(() => window.scrollY);
console.log("scrollY behind an OPEN modal after wheel:", y);
console.log(y > 0 ? "*** scroll lock is a NO-OP: page scrolls behind the modal ***" : "scroll lock works");
// also: does the html element carry an explicit overflow-y?
console.log("computed html overflow-y:", await page.evaluate(()=>getComputedStyle(document.documentElement).overflowY),
            " (explicit because html{overflow-x:hidden} forces overflow-y:visible -> auto)");
await browser.close();

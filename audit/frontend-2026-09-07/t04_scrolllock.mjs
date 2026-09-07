import { open, report } from "./drive.mjs";
const { browser, page, logs } = await open();
await page.addInitScript(() => {
  localStorage.setItem("myListAddon:localCustomLists", JSON.stringify({
    "my-faves": { name: "My Faves", type: "movie", items: [{ id: "tt0111161", type: "movie", name: "Shawshank" }] }
  }));
});
await page.goto("http://127.0.0.1:8787/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2500);

const st = async () => page.evaluate(() => ({
  bodyOverflow: document.body.style.overflow,
  select: getComputedStyle(document.getElementById("selectListModal")).display,
  create: getComputedStyle(document.getElementById("createListModal")).display,
  canScroll: document.body.scrollHeight > window.innerHeight,
}));

console.log("before:", JSON.stringify(await st()));
await page.evaluate(() => openSelectListModal("tt0137523", "movie", "Fight Club", ""));
await page.waitForTimeout(400);
console.log("selectListModal open:", JSON.stringify(await st()));

// Click the "+ Create New List" button inside the modal body
const found = await page.evaluate(() => {
  const btns = [...document.querySelectorAll("#selectListModalBody button")];
  const b = btns.find(x => x.textContent.includes("Create New List"));
  if (!b) return false;
  b.click();
  return true;
});
console.log('clicked "+ Create New List":', found);
await page.waitForTimeout(400);
console.log("after create modal opens:", JSON.stringify(await st()));

// now cancel the create-list modal the way a user would
await page.evaluate(() => {
  const b = [...document.querySelectorAll("#createListModal button")].find(x => x.textContent.trim() === "Cancel");
  b.click();
});
await page.waitForTimeout(400);
const end = await st();
console.log("after Cancel:", JSON.stringify(end));
console.log(end.bodyOverflow === "hidden" ? "\n*** BUG CONFIRMED: body scroll left locked with no modal open ***" : "\nno leak");

// prove the page can no longer be scrolled
const scrolled = await page.evaluate(async () => {
  window.scrollTo(0, 500);
  await new Promise(r => setTimeout(r, 200));
  return { y: window.scrollY, docOverflow: getComputedStyle(document.body).overflowY };
});
console.log("scroll attempt:", JSON.stringify(scrolled));
report(logs, "scroll lock");
await browser.close();

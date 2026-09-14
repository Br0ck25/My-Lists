import { open } from "./drive.mjs";
let broken = 0, runs = 6;
for (let i = 0; i < runs; i++) {
  const { browser, page } = await open();
  await page.route("**/*", r => r.request().url().startsWith("http://127.0.0.1:8787") ? r.continue() : r.abort());
  page.on("dialog", d => d.dismiss().catch(()=>{}));
  await page.goto("http://127.0.0.1:8787/", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(1800);
  const name = "dc" + i + Date.now().toString(36);
  await page.evaluate(async (n) => {
    openCreateProfileModal(); await new Promise(r=>setTimeout(r,250));
    document.getElementById("createProfileNameInput").value = n;
    const b = [...document.querySelectorAll("#activeModalOverlay button")].find(x=>/create/i.test(x.textContent));
    b.click(); b.click();                       // ordinary impatient DOUBLE-click
  }, name);
  await page.waitForTimeout(2500);
  const r = await page.evaluate(async (n) => {
    const k = localStorage.getItem("myListAddon:creatorKey");
    const res = await fetch("/api/creator/restore", { method:"POST", headers:{"content-type":"application/json"},
      body: JSON.stringify({ creatorName: n, creatorKey: k }) });
    const shown = (document.getElementById("revealedCreatorKey")||{textContent:""}).textContent.trim();
    return { keyStored: k, keyShown: shown, restore: res.status };
  }, name);
  if (r.restore !== 200) broken++;
  console.log(`run ${i}: stored=${r.keyStored} shownToUser=${r.keyShown} restore=${r.restore} ${r.restore!==200?"<-- BROKEN ACCOUNT":""}`);
  await browser.close();
}
console.log(`\n${broken}/${runs} double-clicks produced an account whose key does not authenticate`);

import { open } from "./drive.mjs";
const { browser, page } = await open();
await page.goto("http://127.0.0.1:8787/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2000);
// Use the page's OWN escapeAttr, in the page's own exact markup shape.
const r = await page.evaluate(() => {
  window.__pwned = 0;
  const hostile = '"); window.__pwned = 1; //';
  const html = '<button id="probe" onclick="probeFn(&quot;' + escapeAttr(hostile) + '&quot;)">x</button>';
  window.probeFn = () => {};
  const d = document.createElement("div");
  d.innerHTML = html;
  document.body.appendChild(d);
  const rawAttr = document.getElementById("probe").getAttribute("onclick");
  document.getElementById("probe").click();
  return { escaped: escapeAttr(hostile), rawAttr, pwned: window.__pwned };
});
console.log("escapeAttr output :", JSON.stringify(r.escaped));
console.log("decoded onclick   :", JSON.stringify(r.rawAttr));
console.log("window.__pwned    :", r.pwned);
console.log(r.pwned === 1 ? "\n*** CONFIRMED: escapeAttr does NOT protect &quot;-delimited JS string literals inside inline handlers ***" : "\nnot exploitable");
await browser.close();

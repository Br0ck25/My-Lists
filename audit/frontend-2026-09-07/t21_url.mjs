import { open } from "./drive.mjs";
const CASES = [
  "/#/list?name=Normal&type=movie&url=https%3A%2F%2Fmdblist.com%2Flists%2Fa%2Fb",
  '/#/list?name=%22%3E%3Cimg%20src%3Dx%20onerror%3Dwindow.__xss%3D1%3E&type=movie&url=https%3A%2F%2Fmdblist.com%2Flists%2Fa%2Fb',
  '/#/list?name=X&type=%22%3E%3Cscript%3Ewindow.__xss%3D2%3C%2Fscript%3E&url=javascript%3Awindow.__xss%3D3',
  '/#/item?id=javascript%3Awindow.__xss%3D4&type=movie',
  '/#/item?id=%3Cimg%20src%3Dx%20onerror%3Dwindow.__xss%3D5%3E&type=series',
  "/#/list?name=&type=&url=",
  "/#/list",
  "/#/item?id=&type=",
  "/#/nonsense?a=b",
  "/#" + "A".repeat(5000),
  "/?tab=%00%01%02",
  "/lists/eviluser/evil-img-src-x-onerror-window-xss-1",
  "/lists/../../etc/passwd",
  "/channels/does-not-exist",
];
for (const c of CASES) {
  const { browser, page, logs } = await open();
  await page.route("**/*", r => r.request().url().startsWith("http://127.0.0.1:8787") ? r.continue() : r.abort());
  let dialog = null;
  page.on("dialog", d => { dialog = d.message().slice(0,60); d.dismiss().catch(()=>{}); });
  let status = 0;
  try { const r = await page.goto("http://127.0.0.1:8787" + c, { waitUntil: "domcontentloaded", timeout: 25000 }); status = r ? r.status() : 0; }
  catch (e) { status = "ERR:" + e.message.split("\n")[0].slice(0,40); }
  await page.waitForTimeout(2200);
  const st = await page.evaluate(() => ({
    xss: window.__xss || 0,
    tab: (typeof currentActiveTab !== "undefined") ? currentActiveTab : null,
    visible: [...document.querySelectorAll("[data-tab-panel]")].filter(e=>!e.hidden && e.offsetParent).map(e=>e.dataset.tabPanel),
    jsHrefs: [...document.querySelectorAll("a[href^='javascript:']")].length,
    bodyLen: document.body.innerText.length,
  })).catch(e=>({err:String(e).slice(0,60)}));
  const errs = logs.errors.length;
  console.log(`${String(status).padEnd(9)} xss=${st.xss} tab=${st.tab} panels=${JSON.stringify(st.visible)} jsHrefs=${st.jsHrefs} pageerrors=${errs} dialog=${dialog}  <- ${c.slice(0,70)}`);
  if (errs) console.log("        ", logs.errors[0].split("\n")[0].slice(0,140));
  await browser.close();
}

import { open, report } from "./drive.mjs";

// A) malformed JSON in every myListAddon key the app reads
{
  const { browser, page, logs } = await open();
  await page.route("**/*", r => r.request().url().startsWith("http://127.0.0.1:8787") ? r.continue() : r.abort());
  await page.addInitScript(() => {
    const keys = ["myListAddon:localCustomLists","myListAddon:localChannels","myListAddon:localMergedChannels",
      "myListAddon:presets","myListAddon:state","myListAddon:likedLists","myListAddon:watchHistory",
      "myListAddon:hiddenLists","myListAddon:dashboardListOrder","myListAddon:fullyWatchedShows",
      "myListAddon:dismissedContinueWatching","myListAddon:curatedRecommendations","myListAddon:hiddenMyListsSections"];
    for (const k of keys) localStorage.setItem(k, "{not json,,,");
  });
  await page.goto("http://127.0.0.1:8787/", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2500);
  for (const t of ["catalogs","lists","channels","discover","search","settings"]) {
    await page.click(`[data-tab="${t}"]`).catch(()=>{}); await page.waitForTimeout(450);
  }
  console.log("A) every storage key is malformed JSON:");
  console.log("   pageerrors:", logs.errors.length, logs.errors.slice(0,2).map(e=>e.split("\n")[0].slice(0,110)));
  console.log("   console.errors:", logs.console.filter(c=>c.type==="error"&&!/ERR_|Failed to load resource/.test(c.text)).map(c=>c.text.split("\n")[0].slice(0,110)));
  console.log("   app still usable (visible panel):", await page.evaluate(()=>[...document.querySelectorAll("[data-tab-panel]")].filter(e=>!e.hidden&&e.offsetParent).map(e=>e.dataset.tabPanel)));
  await browser.close();
}

// B) wrong TYPES (arrays where objects expected and vice versa)
{
  const { browser, page, logs } = await open();
  await page.route("**/*", r => r.request().url().startsWith("http://127.0.0.1:8787") ? r.continue() : r.abort());
  await page.addInitScript(() => {
    localStorage.setItem("myListAddon:localCustomLists", "[1,2,3]");
    localStorage.setItem("myListAddon:localChannels", '"a string"');
    localStorage.setItem("myListAddon:presets", "42");
    localStorage.setItem("myListAddon:state", "null");
    localStorage.setItem("myListAddon:likedLists", '{"not":"an array"}');
    localStorage.setItem("myListAddon:watchHistory", '{"x":1}');
    localStorage.setItem("myListAddon:dashboardListOrder", '"nope"');
  });
  await page.goto("http://127.0.0.1:8787/", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2500);
  for (const t of ["catalogs","lists","channels","discover","search","settings"]) {
    await page.click(`[data-tab="${t}"]`).catch(()=>{}); await page.waitForTimeout(450);
  }
  console.log("\nB) storage keys hold the wrong TYPE:");
  console.log("   pageerrors:", logs.errors.length, logs.errors.slice(0,3).map(e=>e.split("\n")[0].slice(0,120)));
  console.log("   console.errors:", logs.console.filter(c=>c.type==="error"&&!/ERR_|Failed to load resource/.test(c.text)).map(c=>c.text.split("\n")[0].slice(0,120)));
  await browser.close();
}

// C) quota exhausted
{
  const { browser, page, logs } = await open();
  await page.route("**/*", r => r.request().url().startsWith("http://127.0.0.1:8787") ? r.continue() : r.abort());
  await page.goto("http://127.0.0.1:8787/", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2200);
  const filled = await page.evaluate(() => {
    let n = 0; const blob = "x".repeat(100000);
    try { for (;n<200;n++) localStorage.setItem("__fill"+n, blob); } catch(e) { return { n, err: e.name }; }
    return { n, err: null };
  });
  console.log("\nC) localStorage filled to quota:", JSON.stringify(filled));
  const res = await page.evaluate(() => {
    window.__alerts = [];
    const s = window.showAppAlert; window.showAppAlert = (t,m)=>window.__alerts.push(t+": "+String(m).slice(0,80));
    let ok = null, threw = null;
    try { ok = saveLocalCustomListsMap({ mylist: { name:"L", type:"movie", items: Array.from({length:50},(_,i)=>({id:"tt"+i,type:"movie",name:"N"+i})) } }); }
    catch (e) { threw = String(e).slice(0,90); }
    window.showAppAlert = s;
    return { returned: ok, threw, alerts: window.__alerts,
             readBack: (()=>{ try { return Object.keys(JSON.parse(localStorage.getItem("myListAddon:localCustomLists")||"{}")); } catch(e){ return "unreadable"; } })(),
             session: (()=>{ try { return Object.keys(JSON.parse(sessionStorage.getItem("myListAddon:localCustomLists")||"{}")); } catch(e){ return "unreadable"; } })() };
  });
  console.log("   saveLocalCustomListsMap under quota pressure:", JSON.stringify(res));
  console.log("   pageerrors:", logs.errors.length);
  await browser.close();
}

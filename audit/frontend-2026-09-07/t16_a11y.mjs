import { open } from "./drive.mjs";
const { browser, page } = await open();
await page.goto("http://127.0.0.1:8787/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2500);

// 1) Escape closes modals?
const esc = async (openFn, id) => {
  await page.evaluate(openFn);
  await page.waitForTimeout(400);
  const before = await page.evaluate((i) => i ? getComputedStyle(document.getElementById(i)).display : (document.getElementById("activeModalOverlay") ? "present" : "absent"), id);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const after = await page.evaluate((i) => i ? getComputedStyle(document.getElementById(i)).display : (document.getElementById("activeModalOverlay") ? "present" : "absent"), id);
  return { before, after };
};
console.log("showModal + Escape          :", JSON.stringify(await esc(() => showModal("<h2>t</h2><button>ok</button>"), null)));
await page.evaluate(() => closeModal());
console.log("createListModal + Escape    :", JSON.stringify(await esc(() => openCreateListModal(), "createListModal")));
await page.evaluate(() => { document.getElementById("createListModal").style.display="none"; });

// 2) Focus management on showModal
const focus = await page.evaluate(async () => {
  const btn = document.querySelector("button");
  btn.focus();
  const before = document.activeElement.tagName + "#" + document.activeElement.id;
  showModal('<h2>x</h2><button id="inModal">ok</button>');
  await new Promise(r=>setTimeout(r,150));
  const during = document.activeElement.tagName + "#" + document.activeElement.id;
  closeModal();
  await new Promise(r=>setTimeout(r,150));
  const after = document.activeElement.tagName + "#" + document.activeElement.id;
  return { before, during, after };
});
console.log("focus before/during/after modal:", JSON.stringify(focus));

// 3) Is focus trapped inside the modal? Tab from the overlay
const trap = await page.evaluate(async () => {
  showModal('<h2>x</h2><button id="m1">a</button><button id="m2">b</button>');
  await new Promise(r=>setTimeout(r,120));
  document.getElementById("m2").focus();
  return { hasTabindex: !!document.getElementById("activeModalOverlay").hasAttribute("tabindex"),
           role: document.getElementById("activeModalOverlay").getAttribute("role"),
           ariaModal: document.getElementById("activeModalOverlay").getAttribute("aria-modal") };
});
console.log("modal semantics:", JSON.stringify(trap));
await page.keyboard.press("Tab");
console.log("after Tab from last modal button, focus is:",
  await page.evaluate(() => { const a=document.activeElement; return a.tagName + "#" + a.id + "." + (a.className||"").toString().slice(0,30) + " insideModal=" + !!a.closest("#activeModalOverlay"); }));
await page.evaluate(()=>closeModal());

// 4) clickable divs acting as buttons
const stats = await page.evaluate(() => {
  const clickable = [...document.querySelectorAll("[onclick]")];
  const nonNative = clickable.filter(e => !["BUTTON","A","INPUT","SELECT","TEXTAREA","LABEL","OPTION"].includes(e.tagName));
  const noKb = nonNative.filter(e => !e.hasAttribute("tabindex") && !e.getAttribute("role"));
  const inputs = [...document.querySelectorAll("input,select,textarea")].filter(e=>e.type!=="hidden");
  const unlabeled = inputs.filter(e => !e.labels?.length && !e.getAttribute("aria-label") && !e.getAttribute("aria-labelledby") && !e.getAttribute("title") && !e.placeholder);
  const imgsNoAlt = [...document.querySelectorAll("img")].filter(e=>!e.hasAttribute("alt"));
  return { totalOnclick: clickable.length, nonNativeClickable: nonNative.length, nonNativeNoKeyboard: noKb.length,
           samples: noKb.slice(0,6).map(e=>e.tagName+"."+(e.className||"").toString().slice(0,40)),
           inputs: inputs.length, unlabeledInputs: unlabeled.length,
           unlabeledSamples: unlabeled.slice(0,6).map(e=>e.id||e.name||e.type),
           imgsNoAlt: imgsNoAlt.length,
           liveRegions: document.querySelectorAll("[aria-live]").length,
           landmarks: document.querySelectorAll("main,nav,header,footer,[role=main],[role=navigation]").length,
           h1: document.querySelectorAll("h1").length,
           skipLink: !!document.querySelector('a[href^="#"][class*=skip], .skip-link'),
           tabsWithRole: document.querySelectorAll("[role=tab]").length,
           tablist: document.querySelectorAll("[role=tablist]").length };
});
console.log("\na11y snapshot:", JSON.stringify(stats, null, 1));

// 5) focus visibility
const fv = await page.evaluate(() => {
  const b = document.querySelector("button"); b.focus();
  const s = getComputedStyle(b);
  return { outline: s.outlineStyle + " " + s.outlineWidth + " " + s.outlineColor, boxShadow: s.boxShadow.slice(0,60) };
});
console.log("focus ring on a focused button:", JSON.stringify(fv));
await browser.close();

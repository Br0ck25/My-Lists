// Does a backgrounded PWA pick up changes another device made, or overwrite them?
//
// The scenario: the phone has the PWA open but backgrounded for a long stretch,
// a desktop makes changes meanwhile, and the phone is then reopened.
//
// Visibility is emulated at the DOM level (document.visibilityState/hidden are
// overridden and visibilitychange/blur/focus/pageshow dispatched), because
// headless Chromium does not occlude a background tab -- bringToFront leaves
// visibilityState 'visible'. The client only ever reads those two properties
// and those events, so this is exactly what it observes on a real resume.
//
// Wall-clock time is compressed. Nothing on the resume path is time-based: the
// lists cache is in-flight-only with no TTL, and the 60s poll is gated on
// visibility. Phase B holds the phone hidden for 70s -- across a full poll
// interval -- and counts the requests it makes, which shows the 30-minute and
// the 70-second background are the same code path.
import { open, report } from "./drive.mjs";

const B = "http://127.0.0.1:8787";
const USER = process.argv[2];
const KEY = process.argv[3];
if (!USER || !KEY) { console.error("usage: node t46_background_resume.mjs <user> <creatorKey>"); process.exit(1); }

const api = (p, body) => fetch(B + p, { method: "POST",
  headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());

const serverState = async () => {
  const [sync, lists] = await Promise.all([
    api("/api/creator/sync/load", { creatorName: USER, creatorKey: KEY }),
    api("/api/creator/lists", { creatorName: USER, creatorKey: KEY }),
  ]);
  const l = (lists.lists || []).find((x) => x.slug === "shared-list");
  return { configRows: ((sync.data && sync.data.config) || []).map((c) => c.name),
    listName: l && l.name, listItems: l ? (l.items || []).map((i) => i.title) : null };
};

const phoneState = (page) => page.evaluate(() => ({
  vis: document.visibilityState,
  configRows: [...document.querySelectorAll("#lists .entry .name")].map((e) => e.value),
  shownList: (document.getElementById("creatorDashboard") || {}).innerText
    ? document.getElementById("creatorDashboard").innerText.replace(/\s+/g, " ").slice(0, 150) : "",
  memList: (typeof lastCreatorListsData !== "undefined" && Array.isArray(lastCreatorListsData))
    ? (lastCreatorListsData.find((l) => l.slug === "shared-list") || null) : null,
})).then((s) => ({ ...s, memList: s.memList ? { name: s.memList.name,
    items: (s.memList.items || []).map((i) => i.title), updatedAt: s.memList.updatedAt } : null }));

const { browser, page, logs } = await open({ viewport: { width: 390, height: 844 } });
await page.goto(B + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2500);
await page.evaluate(async ({ u, k }) => {
  if (typeof openRestoreModal === "function") openRestoreModal();
  await new Promise((r) => setTimeout(r, 300));
  document.getElementById("restoreNameInput").value = u;
  document.getElementById("restoreKeyInput").value = k;
  await submitRestoreProfile();
}, { u: USER, k: KEY });
await page.waitForTimeout(4000);

const hide = () => page.evaluate(() => {
  Object.defineProperty(document, "visibilityState", { get: () => "hidden", configurable: true });
  Object.defineProperty(document, "hidden", { get: () => true, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("blur"));
});
const show = () => page.evaluate(() => {
  Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
  Object.defineProperty(document, "hidden", { get: () => false, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("focus"));
  window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
});
const apiReqsSince = (n) => logs.requests.slice(n)
  .filter((r) => r.method === "POST" && r.url.includes("/api/creator/")).map((r) => r.url.replace(B, ""));

console.log("### PHASE A — phone signed in, phone and server agree");
console.log("  server:", JSON.stringify(await serverState()));
console.log("  phone :", JSON.stringify(await phoneState(page)));

console.log("\n### PHASE B — phone backgrounded 70s (one full poll interval); desktop edits THE LIST");
await hide();
const nB = logs.requests.length;
await api("/api/creator/lists/save", { creatorName: USER, creatorKey: KEY, slug: "shared-list",
  name: "Shared List (desktop edit)", type: "movie", visibility: "public",
  items: [{ id: "tt0137523", type: "movie", title: "Fight Club", year: 1999 },
          { id: "tt0468569", type: "movie", title: "The Dark Knight", year: 2008 }] });
console.log("  server now:", JSON.stringify(await serverState()));
await page.waitForTimeout(70000);
console.log("  requests the phone made while hidden (70s):", JSON.stringify(apiReqsSince(nB)));
const nB2 = logs.requests.length;
await show();
await page.waitForTimeout(8000);
console.log("  requests on resume:", JSON.stringify(apiReqsSince(nB2)));
const afterB = await phoneState(page);
console.log("  phone now :", JSON.stringify(afterB));
console.log(`  >>> phone shows the desktop's LIST change? ${afterB.memList && /desktop edit/i.test(afterB.memList.name) ? "YES" : "NO"}`);

console.log("\n### PHASE C — phone backgrounded again; desktop edits CONFIG (a tracked stamp)");
await hide();
const nC = logs.requests.length;
const cur = await api("/api/creator/sync/load", { creatorName: USER, creatorKey: KEY });
await api("/api/creator/sync/save", { creatorName: USER, creatorKey: KEY,
  config: [{ name: "DESKTOP-EDITED-ROW", url: "https://mdblist.com/lists/" + USER + "/x", type: "movie", enabled: true },
           { name: "DESKTOP-NEW-ROW", url: "https://mdblist.com/lists/" + USER + "/y", type: "movie", enabled: true }],
  likedLists: ["https://mdblist.com/lists/" + USER + "/liked"],
  expectedUpdatedAt: cur.data && cur.data.updatedAt });
console.log("  server now:", JSON.stringify(await serverState()));
await page.waitForTimeout(1500);
const nC2 = logs.requests.length;
await show();
await page.waitForTimeout(8000);
console.log("  requests on resume:", JSON.stringify(apiReqsSince(nC2)));
const afterC = await phoneState(page);
console.log("  phone now :", JSON.stringify(afterC));
console.log(`  >>> phone shows the desktop's CONFIG change? ${afterC.configRows.some((n) => /DESKTOP/.test(n)) ? "YES" : "NO"}`);
console.log(`  >>> and the LIST change, carried along?      ${afterC.memList && /desktop edit/i.test(afterC.memList.name) ? "YES" : "NO"}`);

console.log("\n### PHASE D — the phone now saves a list edit built on whatever it is showing");
const beforeD = await serverState();
const editResult = await page.evaluate(async () => {
  const stale = (lastCreatorListsData || []).find((l) => l.slug === "shared-list");
  if (!stale) return { skipped: "no list in memory" };
  // Exactly what the builder holds after the user opens this list and adds one
  // film: the items the phone is showing, plus the new one.
  editingCreatorListSlug = "shared-list";
  customListDraftType = "movie";
  customListDraftItems = [...(stale.items || []), { id: "tt1375666", type: "movie", title: "Inception", year: 2010 }];
  await saveCreatorListEdit(stale.name);
  const modal = document.querySelector(".appNoticeTitle, #appNoticeTitle");
  return { baselineCited: stale.updatedAt,
    noticeShown: document.body.innerText.includes("Changed Elsewhere"),
    modalTitle: modal ? modal.textContent.trim() : null };
});
await page.waitForTimeout(3000);
const afterD = await serverState();
console.log("  phone edit result:", JSON.stringify(editResult));
console.log("  server before:", JSON.stringify(beforeD));
console.log("  server after :", JSON.stringify(afterD));
const lost = (beforeD.listItems || []).filter((t) => !(afterD.listItems || []).includes(t));
console.log(`  >>> desktop items the phone's save destroyed: ${lost.length ? JSON.stringify(lost) : "none"}`);

console.log("\n### PHASE E — phone triggers a config autosave from its stale baseline");
const beforeE = await serverState();
await page.evaluate(() => {
  const row = document.querySelector("#lists .entry .name");
  if (row) { row.value = "PHONE-EDITED-ROW"; row.dispatchEvent(new Event("input", { bubbles: true })); }
  if (typeof scheduleCreatorSyncSave === "function") scheduleCreatorSyncSave();
});
await page.waitForTimeout(7000);
const afterE = await serverState();
console.log("  server before:", JSON.stringify(beforeE));
console.log("  server after :", JSON.stringify(afterE));
const lostCfg = beforeE.configRows.filter((c) => !afterE.configRows.includes(c));
console.log(`  >>> desktop config rows the phone's autosave destroyed: ${lostCfg.length ? JSON.stringify(lostCfg) : "none"}`);
console.log("  phone after the 409 recovery:", JSON.stringify(await phoneState(page)));
console.log("  409s the phone received:", logs.responses.filter((r) => r.status === 409).length);

report(logs, "background resume");
await browser.close();

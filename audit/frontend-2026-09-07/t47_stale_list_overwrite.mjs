// Follow-on to t46. t46 showed that when the desktop changes ONLY a custom list,
// a resuming phone does not refetch it: /api/creator/sync/meta reports the four
// stamps it tracks (config, tracking, presets, channels) unchanged, and
// creatorlist:<user>:<slug> is not one of them.
//
// This probe asks the consequence question: while the phone is sitting on that
// stale copy, (1) does anything else make it converge, and (2) what happens when
// the person edits that list on the phone -- is the desktop's work overwritten?
import { open, report } from "./drive.mjs";

const B = "http://127.0.0.1:8787";
const USER = process.argv[2];
const KEY = process.argv[3];
if (!USER || !KEY) { console.error("usage: node t47_stale_list_overwrite.mjs <user> <creatorKey>"); process.exit(1); }

const api = (p, body) => fetch(B + p, { method: "POST",
  headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
const serverList = async () => {
  const r = await api("/api/creator/lists", { creatorName: USER, creatorKey: KEY });
  const l = (r.lists || []).find((x) => x.slug === "shared-list");
  return l ? { name: l.name, items: (l.items || []).map((i) => i.title), updatedAt: l.updatedAt } : null;
};
const memList = (page) => page.evaluate(() => {
  const l = (typeof lastCreatorListsData !== "undefined" && Array.isArray(lastCreatorListsData))
    ? lastCreatorListsData.find((x) => x.slug === "shared-list") : null;
  return l ? { name: l.name, items: (l.items || []).map((i) => i.title), updatedAt: l.updatedAt } : null;
});

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
});
const show = () => page.evaluate(() => {
  Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
  Object.defineProperty(document, "hidden", { get: () => false, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("focus"));
  window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
});
const since = (n) => logs.requests.slice(n).filter((r) => r.method === "POST" && r.url.includes("/api/creator/")).map((r) => r.url.replace(B, ""));

console.log("phone at sign-in :", JSON.stringify(await memList(page)));

// desktop adds a film while the phone is backgrounded
await hide();
await api("/api/creator/lists/save", { creatorName: USER, creatorKey: KEY, slug: "shared-list",
  name: "Shared List", type: "movie", visibility: "public",
  items: [{ id: "tt0137523", type: "movie", title: "Fight Club", year: 1999 },
          { id: "tt0468569", type: "movie", title: "The Dark Knight", year: 2008 }] });
console.log("server after desktop:", JSON.stringify(await serverList()));
await page.waitForTimeout(1000);
let n = logs.requests.length;
await show();
await page.waitForTimeout(7000);
console.log("resume requests   :", JSON.stringify(since(n)));
const resumed = await memList(page);
console.log("phone after resume:", JSON.stringify(resumed),
  resumed.items.includes("The Dark Knight") ? "  <-- converged" : "  <-- STALE (FE-17 regressed)");

// (1) does ordinary navigation make it converge?
for (const tab of ["customLists", "myLists", "settings", "customLists"]) {
  n = logs.requests.length;
  await page.evaluate((t) => { if (typeof switchTab === "function") switchTab(t); }, tab);
  await page.waitForTimeout(2500);
  console.log(`  switchTab(${tab}) -> ${JSON.stringify(since(n))}  mem: ${JSON.stringify(await memList(page))}`);
}

// (2) the person edits that list on the phone, on top of whatever it is showing
console.log("\n--- phone adds Inception to the copy it is showing ---");
const before = await serverList();
const res = await page.evaluate(async () => {
  const stale = (lastCreatorListsData || []).find((l) => l.slug === "shared-list");
  if (!stale) return { skipped: true };
  editingCreatorListSlug = "shared-list";
  customListDraftType = "movie";
  customListDraftItems = [...(stale.items || []), { id: "tt1375666", type: "movie", title: "Inception", year: 2010 }];
  // Read before the save: a successful one clears the draft.
  const sent = customListDraftItems.map((i) => i.title);
  await saveCreatorListEdit(stale.name);
  await new Promise((r) => setTimeout(r, 500));
  return { citedBaseline: stale.updatedAt,
    sentItems: sent,
    noticeShown: /Changed Elsewhere/i.test(document.body.innerText),
    noticeText: (document.body.innerText.match(/Another device saved[^]{0,120}/) || [""])[0] };
});
await page.waitForTimeout(2500);
const after = await serverList();
console.log("phone sent        :", JSON.stringify(res));
console.log("server before edit:", JSON.stringify(before));
console.log("server after  edit:", JSON.stringify(after));
const lost = (before.items || []).filter((t) => !(after.items || []).includes(t));
console.log(`>>> desktop films destroyed by the phone's save: ${lost.length ? JSON.stringify(lost) : "NONE"}`);
console.log(`>>> phone warned the person: ${res.noticeShown ? "YES" : "NO"}`);
console.log(">>> 409s:", logs.responses.filter((r) => r.status === 409).length);
// Post-fix expectation. Before the lists stamp existed, the resume left the
// phone on a one-item copy, the save was refused with a 409 and the person got
// "This List Changed Elsewhere" -- correct, but a detour caused by showing them
// something out of date. With the stamp, the resume converges first and the
// edit simply merges. `resumed` is the state captured right after the resume,
// before any edit, which is the thing actually under test.
const converged = resumed.items.includes("The Dark Knight");
console.log(`\n>>> RESULT: ${converged && lost.length === 0
  ? "PASS -- the phone converged on resume and its edit merged with the desktop's"
  : "FAIL -- " + (converged ? "the desktop's work was lost" : "the phone is still showing a stale list (FE-17)")}`);

report(logs, "stale list overwrite");
await browser.close();

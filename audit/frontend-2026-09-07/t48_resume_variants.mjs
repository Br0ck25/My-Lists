// Three variants that decide the practical answer to "will the phone show what
// the desktop changed", given t46/t47's finding that a list-only change is not
// covered by the /api/creator/sync/meta gate:
//
//   1. The phone stays in the FOREGROUND across a full 60s poll -- same gate?
//   2. COLD START: the OS evicted the PWA, so reopening is a fresh page load.
//   3. After the 409 warning, does the phone converge, or stay stale?
import { open, report } from "./drive.mjs";

const B = "http://127.0.0.1:8787";
const USER = process.argv[2];
const KEY = process.argv[3];
if (!USER || !KEY) { console.error("usage: node t48_resume_variants.mjs <user> <creatorKey>"); process.exit(1); }

const api = (p, body) => fetch(B + p, { method: "POST",
  headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
const serverList = async () => {
  const r = await api("/api/creator/lists", { creatorName: USER, creatorKey: KEY });
  const l = (r.lists || []).find((x) => x.slug === "shared-list");
  return l ? { name: l.name, items: (l.items || []).map((i) => i.title) } : null;
};
const memList = (page) => page.evaluate(() => {
  const l = (typeof lastCreatorListsData !== "undefined" && Array.isArray(lastCreatorListsData))
    ? lastCreatorListsData.find((x) => x.slug === "shared-list") : null;
  return l ? { name: l.name, items: (l.items || []).map((i) => i.title) } : null;
});
const signIn = (page) => page.evaluate(async ({ u, k }) => {
  if (typeof openRestoreModal === "function") openRestoreModal();
  await new Promise((r) => setTimeout(r, 300));
  document.getElementById("restoreNameInput").value = u;
  document.getElementById("restoreKeyInput").value = k;
  await submitRestoreProfile();
}, { u: USER, k: KEY });

const { browser, page, logs } = await open({ viewport: { width: 390, height: 844 } });
const since = (n) => logs.requests.slice(n).filter((r) => r.method === "POST" && r.url.includes("/api/creator/")).map((r) => r.url.replace(B, ""));

await page.goto(B + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2500);
await signIn(page);
await page.waitForTimeout(4000);
console.log("phone at sign-in:", JSON.stringify(await memList(page)));

// ---- 1. foreground the whole time, desktop edits the list -------------------
console.log("\n### 1. phone left OPEN AND VISIBLE across a full 60s poll");
await api("/api/creator/lists/save", { creatorName: USER, creatorKey: KEY, slug: "shared-list",
  name: "Shared List", type: "movie", visibility: "public",
  items: [{ id: "tt0137523", type: "movie", title: "Fight Club", year: 1999 },
          { id: "tt0468569", type: "movie", title: "The Dark Knight", year: 2008 }] });
console.log("  server:", JSON.stringify(await serverList()));
let n = logs.requests.length;
await page.waitForTimeout(70000);
console.log("  requests in 70s visible:", JSON.stringify(since(n)));
console.log("  phone :", JSON.stringify(await memList(page)));
const fgStale = !(await memList(page)).items.includes("The Dark Knight");
console.log(`  >>> foreground phone converged? ${fgStale ? "NO — still stale" : "YES"}`);

// ---- 3. does the failed save converge it? ----------------------------------
console.log("\n### 3. person edits the list from the stale copy, gets the warning, then what?");
const r3 = await page.evaluate(async () => {
  const stale = (lastCreatorListsData || []).find((l) => l.slug === "shared-list");
  editingCreatorListSlug = "shared-list";
  customListDraftType = "movie";
  customListDraftItems = [...(stale.items || []), { id: "tt1375666", type: "movie", title: "Inception", year: 2010 }];
  await saveCreatorListEdit(stale.name);
  return { warned: /Changed Elsewhere/i.test(document.body.innerText) };
});
await page.waitForTimeout(4000);
const afterWarn = await memList(page);
console.log("  warned:", r3.warned, " phone now:", JSON.stringify(afterWarn));
console.log(`  >>> phone converged after the refused save? ${afterWarn.items.includes("The Dark Knight") ? "YES" : "NO"}`);
console.log("  server:", JSON.stringify(await serverList()));

// ---- 2. cold start ---------------------------------------------------------
console.log("\n### 2. COLD START — OS evicted the PWA; reopening is a fresh load");
await api("/api/creator/lists/save", { creatorName: USER, creatorKey: KEY, slug: "shared-list",
  name: "Shared List", type: "movie", visibility: "public",
  items: [{ id: "tt0137523", type: "movie", title: "Fight Club", year: 1999 },
          { id: "tt0468569", type: "movie", title: "The Dark Knight", year: 2008 },
          { id: "tt0110912", type: "movie", title: "Pulp Fiction", year: 1994 }] });
console.log("  server:", JSON.stringify(await serverList()));
n = logs.requests.length;
await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(9000);
console.log("  requests on cold start:", JSON.stringify(since(n)));
const cold = await memList(page);
console.log("  phone :", JSON.stringify(cold));
console.log(`  >>> cold start converged? ${cold && cold.items.includes("Pulp Fiction") ? "YES" : "NO"}`);
report(logs, "resume variants");
await browser.close();

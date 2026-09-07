import { open, report } from "./drive.mjs";
const ctl = (b) => fetch("http://127.0.0.1:8787/__ctl", { method:"POST", body: JSON.stringify(b) }).then(r=>r.json());
const KEYS = { alice: process.argv[2], bob: process.argv[3] };

// Delay ONLY the first sync/load (alice's) so it resolves after bob's.
await ctl({ reset: true, faults: [{ match: "^/api/creator/sync/load", delayMs: 7000, times: 1 }] });

const { browser, page, logs } = await open();
await page.goto("http://127.0.0.1:8787/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2500);
const signIn = (u) => page.evaluate(async ({u,k}) => {
  document.getElementById("restoreNameInput") || openRestoreModal();
  await new Promise(r => setTimeout(r, 200));
  if (typeof openRestoreModal === "function" && !document.getElementById("restoreNameInput")) openRestoreModal();
  await new Promise(r => setTimeout(r, 200));
  document.getElementById("restoreNameInput").value = u;
  document.getElementById("restoreKeyInput").value = k;
  submitRestoreProfile();          // NOT awaited: mimics a user who does not wait
}, { u, k: KEYS[u] });

await signIn("alice");
await page.waitForTimeout(1200);   // alice's sync/load is now in flight (7s)
await signIn("bob");
await page.waitForTimeout(2500);
const mid = await page.evaluate(() => ({
  who: (typeof activeCreator!=="undefined"&&activeCreator)?activeCreator.creatorName:null,
  rows: [...document.querySelectorAll("#lists .entry .name")].map(e=>e.value),
  liked: localStorage.getItem("myListAddon:likedLists"),
}));
console.log("t=+3.7s (bob signed in, alice's load still pending):", JSON.stringify(mid));

await page.waitForTimeout(7000);   // alice's response lands now
const after = await page.evaluate(() => ({
  who: (typeof activeCreator!=="undefined"&&activeCreator)?activeCreator.creatorName:null,
  lsCreator: localStorage.getItem("myListAddon:creatorName"),
  rows: [...document.querySelectorAll("#lists .entry .name")].map(e=>e.value),
  liked: localStorage.getItem("myListAddon:likedLists"),
  bodyHasAlice: document.body.innerText.includes("alice"),
}));
console.log("t=+10.7s (alice's obsolete response has landed):", JSON.stringify(after));
const leaked = after.who === "bob" && (after.rows.some(r=>/alice/i.test(r)) || (after.liked||"").includes("alice"));
console.log(leaked ? "\n*** CONFIRMED: alice's sync payload was applied to bob's signed-in session ***" : "\nno cross-account leak on this path");

// did the client then push the contaminated state up to bob's account?
const pushes = logs.requests.filter(r => /sync\/save|sync\/like/.test(r.url) && r.method === "POST");
console.log("\nsync writes made after the switch:", pushes.length);
for (const p of pushes.slice(-4)) console.log("  ", p.url.replace("http://127.0.0.1:8787",""), (p.post||"").slice(0,220));
report(logs, "sync race");
await browser.close();
await ctl({ reset: true });

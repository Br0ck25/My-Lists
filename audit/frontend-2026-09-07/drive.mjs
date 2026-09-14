import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";

export async function open(opts = {}) {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const context = await browser.newContext({
    viewport: opts.viewport || { width: 1280, height: 900 },
    ...(opts.contextOpts || {}),
  });
  const page = await context.newPage();
  const logs = { console: [], errors: [], failed: [], requests: [], responses: [] };
  page.on("console", (m) => {
    logs.console.push({ type: m.type(), text: m.text().slice(0, 500), loc: m.location() });
  });
  page.on("pageerror", (e) => logs.errors.push(String(e && e.stack || e).slice(0, 800)));
  page.on("requestfailed", (r) => logs.failed.push({ url: r.url(), err: r.failure() && r.failure().errorText }));
  page.on("request", (r) => logs.requests.push({ url: r.url(), method: r.method(), post: r.postData() }));
  page.on("response", (r) => { if (r.status() >= 400) logs.responses.push({ url: r.url(), status: r.status() }); });
  return { browser, context, page, logs };
}

export function report(logs, label) {
  const errs = logs.console.filter((c) => c.type === "error");
  const warns = logs.console.filter((c) => c.type === "warning");
  console.log(`\n===== ${label} =====`);
  console.log(`pageerrors: ${logs.errors.length}, console.error: ${errs.length}, console.warn: ${warns.length}, requestfailed: ${logs.failed.length}, 4xx/5xx: ${logs.responses.length}`);
  for (const e of logs.errors.slice(0, 15)) console.log("  PAGEERROR:", e.split("\n").slice(0, 3).join(" | "));
  const seen = new Set();
  for (const e of errs) { const k = e.text.slice(0,150); if (seen.has(k)) continue; seen.add(k); console.log("  CONSOLE.ERROR:", k); }
  const seenW = new Set();
  for (const e of warns) { const k = e.text.slice(0,150); if (seenW.has(k)) continue; seenW.add(k); console.log("  CONSOLE.WARN:", k); }
  for (const f of logs.failed.slice(0, 15)) console.log("  REQFAIL:", f.err, f.url.slice(0, 160));
  const rs = new Set();
  for (const r of logs.responses) { const k = r.status + " " + r.url.split("?")[0]; if (rs.has(k)) continue; rs.add(k); console.log("  HTTP:", k); }
}

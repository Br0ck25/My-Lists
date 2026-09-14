import pw from "playwright-core";
const { chromium } = pw;
const CHROMIUM = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
export async function open({ viewport = { width: 1280, height: 900 }, url = "http://127.0.0.1:8787/", isMobile = false } = {}) {
  const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const ctx = await browser.newContext({ viewport, hasTouch: isMobile, isMobile, serviceWorkers: "allow" });
  const page = await ctx.newPage();
  const errors = [], console_ = [], requests = [], failed = [];
  page.on("pageerror", (e) => errors.push(String(e && e.message || e)));
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console_.push(m.type() + ": " + m.text().slice(0, 300)); });
  page.on("request", (r) => requests.push(r.method() + " " + r.url()));
  page.on("requestfailed", (r) => failed.push(r.method() + " " + r.url() + " :: " + (r.failure() && r.failure().errorText)));
  page.on("response", (r) => { if (r.status() >= 400) failed.push("HTTP " + r.status() + " " + r.url()); });
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  return { browser, ctx, page, errors, console_, requests, failed };
}

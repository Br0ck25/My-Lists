// PHASE 25 -- clock / calendar behaviour of the day-bucket and daily-seed helpers.
import { readFileSync } from "node:fs";
const src03 = readFileSync(new URL("../../03_admin.js", import.meta.url), "utf8");
const src02 = readFileSync(new URL("../../02_http-and-creator-utils.js", import.meta.url), "utf8");
function grab(src, name) {
  const start = src.indexOf(`function ${name}`);
  if (start < 0) throw new Error("missing " + name);
  let i = src.indexOf("{", start), d = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") d++;
    else if (src[i] === "}") { d--; if (!d) { i++; break; } }
  }
  return src.slice(start, i);
}
const F = new Function(
  grab(src03, "easternDateKey") + "\n" + grab(src03, "statsToday") + "\n" +
  grab(src02, "getDailySeed") + "\n" + grab(src02, "pseudoRandom") + "\n" + grab(src02, "deterministicDailyShuffle") + "\n" +
  "return { easternDateKey, statsToday, getDailySeed, deterministicDailyShuffle };"
)();

const cases = [
  ["DST spring forward, 01:59 ET", "2026-03-08T06:59:00Z"],
  ["DST spring forward, 03:01 ET", "2026-03-08T08:01:00Z"],
  ["DST fall back, 01:30 EDT",     "2026-11-01T05:30:00Z"],
  ["DST fall back, 01:30 EST",     "2026-11-01T06:30:00Z"],
  ["23:59 ET Dec 31",              "2027-01-01T04:59:00Z"],
  ["00:01 ET Jan 1",               "2027-01-01T05:01:00Z"],
  ["UTC midnight, still Dec 31 ET","2027-01-01T00:00:00Z"],
  ["19:00 ET (00:00 UTC next day)","2026-06-02T00:00:00Z"],
];
console.log("=== easternDateKey ===");
for (const [label, iso] of cases) {
  console.log("  " + label.padEnd(34) + iso + "  ->  " + F.easternDateKey(new Date(iso)));
}

console.log("");
console.log("=== getDailySeed / deterministicDailyShuffle across the UTC day boundary ===");
const realNow = Date.now;
const arr = Array.from({ length: 10 }, (_, i) => i);
for (const iso of ["2026-06-01T23:59:59Z", "2026-06-02T00:00:01Z", "2026-06-02T12:00:00Z"]) {
  Date.now = () => new Date(iso).getTime();
  console.log("  " + iso + "  seed=" + F.getDailySeed("x") + "  shuffle=" + JSON.stringify(F.deterministicDailyShuffle(arr, "x")));
}
Date.now = realNow;

console.log("");
console.log("=== stats day bucket vs daily-seed day: do they agree? ===");
Date.now = () => new Date("2026-06-02T02:00:00Z").getTime();   // 22:00 ET on Jun 1
console.log("  02:00 UTC Jun 2 = 22:00 ET Jun 1");
console.log("    statsToday() (Eastern) :", F.easternDateKey(new Date(Date.now())));
console.log("    getDailySeed()  (UTC)  :", F.getDailySeed(""));
Date.now = realNow;

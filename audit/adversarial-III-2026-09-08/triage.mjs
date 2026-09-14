import * as acorn from "acorn";
import * as escope from "eslint-scope";
import { readFileSync } from "node:fs";
const file = process.argv[2];
const names = new Set(process.argv.slice(3));
const src = readFileSync(file, "utf8");
const lines = src.split("\n");
const ast = acorn.parse(src, { ecmaVersion: 2023, sourceType: "script", locations: true, ranges: true });
const sm = escope.analyze(ast, { ecmaVersion: 2023, sourceType: "script" });
for (const ref of sm.globalScope.through) {
  const n = ref.identifier.name;
  if (names.size && !names.has(n)) continue;
  const ln = ref.identifier.loc.start.line;
  const col = ref.identifier.loc.start.column;
  const text = (lines[ln-1] || "").trim();
  // is it guarded by typeof in the same line?
  const guarded = /typeof\s+/.test(lines[ln-1] || "") && (lines[ln-1]||"").includes("typeof " + n);
  console.log(`${n} @${ln}:${col} ${guarded ? "[typeof-guarded]" : "[BARE]"}  ${text.slice(0,160)}`);
}

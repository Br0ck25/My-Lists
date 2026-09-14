import * as acorn from "acorn";
import { readFileSync } from "node:fs";
const src = readFileSync(process.argv[2], "utf8");
const ast = acorn.parse(src, { ecmaVersion: 2023, sourceType: process.argv[3] || "module", locations: true, ranges: true });
const declared = new Map(); // name -> line
const used = new Map();     // name -> count
function walk(n, parent) {
  if (!n || typeof n.type !== "string") return;
  if (n.type === "FunctionDeclaration" && n.id) {
    if (!declared.has(n.id.name)) declared.set(n.id.name, n.loc.start.line);
  }
  if ((n.type === "VariableDeclarator") && n.id && n.id.type === "Identifier" && n.init &&
      (n.init.type === "FunctionExpression" || n.init.type === "ArrowFunctionExpression")) {
    if (!declared.has(n.id.name)) declared.set(n.id.name, n.loc.start.line);
  }
  if (n.type === "Identifier") {
    const isDeclSite = parent && ((parent.type === "FunctionDeclaration" && parent.id === n) ||
      (parent.type === "VariableDeclarator" && parent.id === n) ||
      (parent.type === "MemberExpression" && parent.property === n && !parent.computed) ||
      (parent.type === "Property" && parent.key === n && !parent.computed) ||
      (parent.type === "FunctionExpression" && parent.id === n));
    if (!isDeclSite) used.set(n.name, (used.get(n.name) || 0) + 1);
  }
  for (const k of Object.keys(n)) {
    if (k === "loc" || k === "range" || k === "type") continue;
    const v = n[k];
    if (Array.isArray(v)) v.forEach(c => walk(c, n));
    else if (v && typeof v.type === "string") walk(v, n);
  }
}
walk(ast, null);
// also count string occurrences (dynamic dispatch / inline handlers)
const dead = [];
for (const [name, line] of declared) {
  const n = used.get(name) || 0;
  if (n === 0) {
    const strCount = (src.match(new RegExp("[\"'`]" + name + "\\b", "g")) || []).length;
    dead.push([name, line, strCount]);
  }
}
dead.sort((a,b)=>a[1]-b[1]);
console.log(`${declared.size} functions declared; ${dead.length} never referenced by identifier`);
for (const [n,l,s] of dead) console.log(`  line ${l}\t${n}${s ? `   (appears ${s}x as a string literal)` : "   <-- NO string reference either"}`);

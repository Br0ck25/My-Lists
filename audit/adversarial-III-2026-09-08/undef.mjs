import * as acorn from "acorn";
import * as escope from "eslint-scope";
import { readFileSync } from "node:fs";

const file = process.argv[2];
const src = readFileSync(file, "utf8");
const ast = acorn.parse(src, { ecmaVersion: 2023, sourceType: "script", locations: true, ranges: true });
const scopeManager = escope.analyze(ast, { ecmaVersion: 2023, sourceType: "script", ignoreEval: true });

const globals = new Set([
  "console","fetch","Response","Request","URL","URLSearchParams","crypto","TextEncoder","TextDecoder",
  "JSON","Math","Date","Object","Array","String","Number","Boolean","Map","Set","WeakMap","WeakSet",
  "Promise","Error","TypeError","RangeError","SyntaxError","ReferenceError","Symbol","Proxy","Reflect",
  "btoa","atob","setTimeout","clearTimeout","setInterval","clearInterval","queueMicrotask",
  "Uint8Array","Uint16Array","Uint32Array","Int8Array","Int16Array","Int32Array","Float32Array","Float64Array",
  "ArrayBuffer","DataView","Blob","FormData","Headers","ReadableStream","WritableStream","TransformStream",
  "AbortController","AbortSignal","caches","globalThis","structuredClone","performance","navigator",
  "escape","unescape","encodeURIComponent","decodeURIComponent","encodeURI","decodeURI","isNaN","isFinite",
  "parseInt","parseFloat","undefined","NaN","Infinity","BigInt","Intl","RegExp","Function","JSON","WebAssembly",
  "EventTarget","Event","CustomEvent","MessageChannel","scheduler","HTMLRewriter","WebSocket","crypto",
  "document","window","location","localStorage","sessionStorage","history","alert","confirm","prompt","self",
  "requestAnimationFrame","cancelAnimationFrame","matchMedia","getComputedStyle","IntersectionObserver",
  "MutationObserver","ResizeObserver","Node","Element","HTMLElement","Image","FileReader","File","URL",
  "customElements","XMLHttpRequest","Notification","indexedDB","screen","devicePixelRatio","CSS","DOMParser",
  "process","Buffer","require","module","exports","__dirname","__filename",
]);

const unresolved = [];
for (const ref of scopeManager.globalScope.through) {
  const name = ref.identifier.name;
  if (globals.has(name)) continue;
  unresolved.push({ name, line: ref.identifier.loc.start.line, write: ref.isWrite() });
}
// group
const by = new Map();
for (const u of unresolved) {
  if (!by.has(u.name)) by.set(u.name, []);
  by.get(u.name).push(u.line + (u.write ? "(w)" : ""));
}
for (const [name, lines] of [...by.entries()].sort()) {
  console.log(`${name}: ${lines.slice(0, 12).join(", ")}${lines.length > 12 ? ` ... (${lines.length} total)` : ""}`);
}

// Every identifier must actually resolve to a binding.
//
// `node --check` proves a file PARSES. It says nothing about whether the names
// inside it exist, and this codebase is unusually exposed to that gap: 27
// source files are concatenated into ONE script scope, so a `const` declared
// inside one route's block is invisible to the next route's block -- while
// looking, in the source, like it is right there. Three live bugs came from
// exactly that, and every one of them was silent:
//
//   isShow    25_api-catalog-routes.js  -> /lists/curated/<slug> threw a
//                                          ReferenceError and answered HTTP 500
//                                          on EVERY request, for months
//   clientId  25_api-catalog-routes.js  -> the Trakt OAuth callback's /users/me
//                                          lookup threw before fetch was even
//                                          called; the surrounding catch ate it,
//                                          so browser logins silently never
//                                          learned the user's Trakt username
//   listName  18_client-copy...js       -> the ONLY site that emits a list-copy
//                                          event threw into a bare catch every
//                                          time, so the admin "copies" column
//                                          has always been structurally zero
//
// Two of those sat behind a `catch {}`, which is why 358 tests, a full render
// check and five prior audits all went past them. A parser does not.
//
// Run:
//   node scope_check.mjs worker worker_entry_combined.js
//   node scope_check.mjs page   rendered.html
import { readFileSync } from "node:fs";
import * as acorn from "acorn";
import * as escope from "eslint-scope";

const [mode, file] = process.argv.slice(2);
if (!mode || !file) {
  console.error("usage: node scope_check.mjs <worker|page> <file>");
  process.exit(2);
}

// Names the runtime provides. Deliberately explicit rather than inferred: a
// typo'd global is exactly the bug this is looking for, so "it exists at
// runtime somewhere" is not a good enough reason to accept a name.
const RUNTIME = new Set([
  // ECMAScript
  "globalThis", "undefined", "NaN", "Infinity", "Object", "Array", "String", "Number",
  "Boolean", "Symbol", "BigInt", "Math", "JSON", "Date", "RegExp", "Map", "Set", "WeakMap",
  "WeakSet", "Promise", "Proxy", "Reflect", "Function", "Error", "TypeError", "RangeError",
  "SyntaxError", "ReferenceError", "EvalError", "URIError", "AggregateError", "Intl",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent",
  "encodeURI", "decodeURI", "escape", "unescape", "structuredClone", "queueMicrotask", "eval",
  "ArrayBuffer", "SharedArrayBuffer", "DataView", "Atomics", "FinalizationRegistry", "WeakRef",
  "Uint8Array", "Uint8ClampedArray", "Uint16Array", "Uint32Array", "Int8Array", "Int16Array",
  "Int32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
  // Web platform, shared by Workers and browsers
  "console", "fetch", "Request", "Response", "Headers", "FormData", "Blob", "File",
  "URL", "URLSearchParams", "TextEncoder", "TextDecoder", "TextEncoderStream",
  "TextDecoderStream", "crypto", "atob", "btoa", "setTimeout", "clearTimeout", "setInterval",
  "clearInterval", "AbortController", "AbortSignal", "Event", "EventTarget", "CustomEvent",
  "MessageChannel", "MessagePort", "ReadableStream", "WritableStream", "TransformStream",
  "CompressionStream", "DecompressionStream", "WebSocket", "performance", "navigator",
  "caches", "CacheStorage", "DOMException",
  // Workers runtime
  "HTMLRewriter", "scheduler", "WebAssembly",
  // Browser
  "window", "self", "document", "location", "history", "localStorage", "sessionStorage",
  "indexedDB", "screen", "alert", "confirm", "prompt", "getComputedStyle", "matchMedia",
  "requestAnimationFrame", "cancelAnimationFrame", "requestIdleCallback", "Image", "Audio",
  "Node", "Element", "HTMLElement", "DocumentFragment", "DOMParser", "XMLSerializer",
  "MutationObserver", "IntersectionObserver", "ResizeObserver", "XMLHttpRequest",
  "FileReader", "Notification", "customElements", "CSS", "devicePixelRatio",
  "innerWidth", "innerHeight", "outerWidth", "outerHeight", "scrollX", "scrollY",
  "pageXOffset", "pageYOffset", "scrollTo", "scrollBy", "open", "close", "print",
  "addEventListener", "removeEventListener", "dispatchEvent", "postMessage", "getSelection",
  // Loaded from a CDN by the page itself (see the <script src> in renderBuilder)
  "fflate",
]);

const src = readFileSync(file, "utf8");
const isPage = mode === "page";

// The page is many inline <script> blocks that share one script scope in the
// browser, so they have to be analysed together -- the preamble declares
// ORIGIN and serverEntries, which the bundle below reads. Skipped: ld+json
// (not JavaScript) and src-only tags (not in this document).
function pageScript(html) {
  const parts = [];
  for (const m of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    const [, attrs, body] = m;
    const type = /type\s*=\s*"([^"]*)"/.exec(attrs);
    if (type && type[1] !== "module" && !/javascript/i.test(type[1])) continue;
    if (/\bsrc=/.test(attrs) && !body.trim()) continue;
    parts.push(body);
  }
  if (parts.length < 2) {
    console.error(`FAIL: expected several inline scripts in ${file}, found ${parts.length}`);
    process.exit(1);
  }
  return parts.join("\n;\n");
}

const code = isPage ? pageScript(src) : src;
const sourceType = isPage ? "script" : "module";

let ast;
try {
  ast = acorn.parse(code, { ecmaVersion: 2023, sourceType, locations: true, ranges: true });
} catch (e) {
  console.error(`FAIL: ${file} did not parse: ${e.message}`);
  process.exit(1);
}
const scopeManager = escope.analyze(ast, { ecmaVersion: 2023, sourceType });

// Three things legitimately create a global that no declaration mentions, and
// all three are used deliberately throughout this codebase. Each is an
// allowance with a reason, not a blanket mute:
//
//   1. `window.foo = ...` -- how every client entry point is exported.
//   2. A bare top-level assignment in sloppy mode (`traktUsername = ...`),
//      which creates a global. Only in `page` mode: the Worker is an ES module,
//      where the same line is itself a ReferenceError and so IS the bug.
//   3. `typeof foo` anywhere -- the author is saying "this may not exist",
//      which is a decision, not a slip.
const assignedToGlobalObject = new Set();
for (const m of code.matchAll(/\b(?:window|globalThis|self)\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) {
  assignedToGlobalObject.add(m[1]);
}
const typeofGuarded = new Set();
for (const m of code.matchAll(/\btypeof\s+([A-Za-z_$][\w$]*)/g)) {
  typeofGuarded.add(m[1]);
}

// In `script` mode eslint-scope deliberately leaves top-level declarations
// unresolved in `through`, because in a browser they become properties of the
// global object rather than bindings in a lexical scope. They are still real
// declarations, and globalScope.variables is where they land -- so without
// this the check would flag all 675 of this bundle's own top-level functions.
//
// This does not weaken it. A block-scoped `const` -- which is what listName
// was -- never reaches globalScope.variables, so it is still caught; and so is
// a name that is declared nowhere at all, which is what isShow and clientId
// were.
const topLevelDeclared = new Set(scopeManager.globalScope.variables.map((v) => v.name));

const lines = code.split("\n");
const unresolved = new Map();
for (const ref of scopeManager.globalScope.through) {
  const name = ref.identifier.name;
  if (RUNTIME.has(name)) continue;
  if (topLevelDeclared.has(name)) continue;
  if (assignedToGlobalObject.has(name)) continue;
  if (typeofGuarded.has(name)) continue;
  if (isPage && ref.isWrite()) continue;
  if (isPage) {
    // A name written bare somewhere in this script is an implicit global from
    // then on; the read is legitimate.
    const written = scopeManager.globalScope.through.some(
      (r) => r.identifier.name === name && r.isWrite()
    );
    if (written) continue;
  }
  if (!unresolved.has(name)) unresolved.set(name, []);
  unresolved.get(name).push(ref.identifier.loc.start.line);
}

if (unresolved.size) {
  console.error(`FAIL: ${unresolved.size} identifier(s) in ${file} resolve to no binding:`);
  for (const [name, at] of [...unresolved].sort()) {
    const first = at[0];
    console.error(`    ${name}  (${at.length} reference${at.length === 1 ? "" : "s"}, first at ${mode === "page" ? "bundle " : ""}line ${first})`);
    console.error(`        ${(lines[first - 1] || "").trim().slice(0, 140)}`);
  }
  console.error("");
  console.error("  Each of these throws a ReferenceError the moment that line runs. If the name");
  console.error("  is declared elsewhere in the file, check it is not inside a different block:");
  console.error("  all 27 sources share ONE scope, so a const in one route's block is invisible");
  console.error("  to the next one's. If it is genuinely optional, guard it with typeof.");
  process.exit(1);
}

const refs = scopeManager.globalScope.through.length;
console.log(`  every identifier resolves (${refs} global references, ${topLevelDeclared.size} top-level declarations, ${assignedToGlobalObject.size} window.* exports, ${typeofGuarded.size} typeof-guarded)`);

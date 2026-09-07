// Runs the client-side bundle (09_..24_) the way a browser would, so its
// behaviour can be tested rather than only its syntax.
//
// Why this exists. 35,225 of the 59,240 source lines are the builder UI, and
// until now the suite reached them only through render_check.js (does the page
// render) and html_checks.py (does the bundle parse, do inline handlers
// resolve). Both audits have been server-side audits for exactly this reason.
// Nothing exercised what the client actually DOES -- which request it sends,
// what it does with the answer -- and that is where the client/server contract
// lives. R2 is the case in point: the server grew a conflict guard, and no
// client call site sends the field that arms it.
//
// How it works, and why not jsdom or Playwright. This repo has no package.json
// and CI runs on bare node + python; adding a browser or a DOM library would
// change that and cost minutes per run. The pieces were already here: the
// Worker evaluates in a `vm` (render_check.js), renderBuilder returns the page
// as a string, and html_checks.py already pulls the inline script out of it.
// This does the same three things and then evaluates the result against a DOM
// stub small enough to read.
//
// The stub is deliberately permissive: getElementById hands back a live stub
// for any id rather than null, because the goal is to get the bundle's ~530
// functions DEFINED so a test can call one directly. That means it is not a
// substitute for a real browser and cannot test rendering or layout. What it
// tests well is logic: payload shapes, response handling, state transitions --
// the parts a server-side change can silently break.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Rendering the page and concatenating 1.4MB of script is the slow part, so it
// happens once per process and every loadClient() re-evaluates the same text.
let CACHED_SCRIPT = null;

function renderPage() {
  let src = fs.readFileSync(path.join(REPO_ROOT, "worker_entry_combined.js"), "utf8");
  const idx = src.lastIndexOf("export default");
  if (idx === -1) throw new Error("no `export default` in the combined Worker");
  src = src.slice(0, idx);

  const sandbox = {
    console, Date, Math, JSON, TextEncoder, TextDecoder, URL, URLSearchParams,
    crypto: globalThis.crypto,
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    fetch: async () => { throw new Error("no network while rendering"); },
    caches: { default: { match: async () => null, put: async () => {} } },
    setTimeout, clearTimeout, setInterval, clearInterval,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "worker_entry_combined.js" });
  if (typeof sandbox.renderBuilder !== "function") throw new Error("renderBuilder is not defined");
  return sandbox.renderBuilder("https://example.com", {});
}

function clientScript() {
  if (CACHED_SCRIPT) return CACHED_SCRIPT;
  const html = renderPage();
  const blocks = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
  // Every inline block, in document order. Not just the largest one: the
  // per-request preamble is its own small block and declares ORIGIN,
  // IS_CONFIGURE and serverEntries, which the bundle reads. Classic scripts
  // share one top-level script scope in a browser, and concatenating them
  // reproduces that -- evaluating the bundle alone throws on serverEntries.
  const inline = blocks
    .filter(([, attrs, body]) => !/application\/ld\+json/.test(attrs) && !/\bsrc=/.test(attrs) && body.trim())
    .map(([, , body]) => body);
  if (inline.length < 2) throw new Error(`expected several inline scripts, got ${inline.length}`);
  // A bridge into the bundle's own script scope, appended after it.
  //
  // Top-level `let`/`const` in a classic script live in the script scope, not
  // on globalThis -- so `sandbox.lastCreatorListsData = [...]` from a test sets
  // an unrelated global that the bundle's code never reads. (`var` does land on
  // globalThis, which makes the difference easy to miss: activeCreator is a
  // var and works, lastCreatorListsData is a let and silently does not.)
  //
  // A DIRECT eval, evaluated as part of this same script, is the one thing
  // that can see those bindings. Test-only, appended here rather than added to
  // any shipped source.
  const bridge = `
;globalThis.__scopeGet = function (expr) { return eval(expr); };
globalThis.__scopeSet = function (name, value) { eval(name + " = value"); };
globalThis.__scopeCall = function (name, args) { return eval(name).apply(null, args || []); };
`;
  CACHED_SCRIPT = inline.join("\n;\n") + bridge;
  return CACHED_SCRIPT;
}

function makeElement() {
  const node = {
    style: {}, dataset: {}, children: [], value: "", textContent: "", innerHTML: "",
    checked: false, hidden: false, disabled: false, id: "", className: "",
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild() {}, removeChild() {}, remove() {}, insertAdjacentHTML() {},
    setAttribute() {}, getAttribute: () => null, removeAttribute() {}, hasAttribute: () => false,
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
    querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    focus() {}, blur() {}, click() {}, scrollIntoView() {}, select() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }),
  };
  return node;
}

function makeStorage(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  return {
    _store: store,
    getItem: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
    setItem: (k, v) => { store.set(String(k), String(v)); },
    removeItem: (k) => { store.delete(String(k)); },
    clear: () => store.clear(),
    key: (i) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
}

/**
 * Evaluate the client bundle and hand back its scope.
 *
 * opts.routes  { "/api/creator/lists": (req) => ({ status?, json? }) }
 *              Matched by pathname. An unmatched path throws, so a test that
 *              triggers an unexpected request fails loudly instead of hanging.
 * opts.storage seed for localStorage.
 *
 * Returns the sandbox, plus `requests` -- every fetch the client made, with
 * its parsed body -- which is what most tests assert on.
 */
export function loadClient(opts = {}) {
  const requests = [];
  const routes = opts.routes || {};
  const localStorageStub = makeStorage(opts.storage);

  const byId = new Map();
  const documentStub = {
    readyState: "complete",
    documentElement: makeElement(), body: makeElement(), head: makeElement(),
    createElement: makeElement, createTextNode: makeElement, createDocumentFragment: makeElement,
    getElementById(id) { if (!byId.has(id)) byId.set(id, makeElement()); return byId.get(id); },
    querySelector: () => makeElement(), querySelectorAll: () => [],
    getElementsByClassName: () => [], getElementsByTagName: () => [],
    addEventListener() {}, removeEventListener() {}, cookie: "",
  };

  const sandbox = {
    console: opts.console || { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    Date, Math, JSON, TextEncoder, TextDecoder, URL, URLSearchParams,
    Promise, Array, Object, String, Number, Boolean, Map, Set, WeakMap, RegExp, Error,
    // Timers are no-ops by default: the bundle schedules autosaves and
    // heartbeats at load, and a test wants to drive the function it is
    // testing, not race a background timer. opts.timers turns them back on.
    setTimeout: opts.timers ? setTimeout : () => 0,
    clearTimeout: opts.timers ? clearTimeout : () => {},
    setInterval: opts.timers ? setInterval : () => 0,
    clearInterval: opts.timers ? clearInterval : () => {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    document: documentStub,
    localStorage: localStorageStub, sessionStorage: makeStorage(),
    navigator: { userAgent: "node", clipboard: { writeText: async () => {} }, onLine: true },
    location: {
      href: "https://example.com/", origin: "https://example.com", protocol: "https:",
      host: "example.com", hostname: "example.com", pathname: "/", search: "", hash: "",
      assign() {}, replace() {}, reload() {},
    },
    history: { pushState() {}, replaceState() {}, back() {}, go() {} },
    alert() {}, confirm: () => true, prompt: () => null,
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    crypto: globalThis.crypto,
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
    Image: makeElement, Event: function Event() {}, CustomEvent: function CustomEvent() {},
    matchMedia: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
    Response, Request, Headers, AbortController,

    async fetch(input, init = {}) {
      const url = String(input && input.url ? input.url : input);
      const { pathname } = new URL(url, "https://example.com");
      let body = null;
      if (init.body) { try { body = JSON.parse(init.body); } catch { body = init.body; } }
      const record = { url, pathname, method: (init.method || "GET").toUpperCase(), body, headers: init.headers || {} };
      requests.push(record);
      const handler = routes[pathname];
      if (!handler) {
        throw new Error(`client-harness: no route stubbed for ${record.method} ${pathname}`);
      }
      const out = (await handler(record)) || {};
      const status = out.status || 200;
      const payload = out.json === undefined ? { ok: true } : out.json;
      return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(clientScript(), sandbox, { filename: "client-bundle.js" });

  sandbox.requests = requests;
  sandbox.__byId = byId;
  // Read, write and call inside the bundle's script scope -- see the bridge.
  sandbox.get = (expr) => sandbox.__scopeGet(expr);
  sandbox.set = (name, value) => sandbox.__scopeSet(name, value);
  sandbox.call = (name, ...args) => sandbox.__scopeCall(name, args);
  return sandbox;
}

/** Requests the client sent to one path, newest last. */
export function requestsTo(client, pathname) {
  return client.requests.filter((r) => r.pathname === pathname);
}

// Sandboxed renderBuilder() execution.
// Strips the trailing `export default { ... }` block so the file can be
// evaluated as a plain script inside a vm context, then calls renderBuilder
// and writes the rendered HTML out for downstream checks.
const fs = require('fs');
const vm = require('vm');

const outPath = process.argv[2] || 'rendered.html';
let src = fs.readFileSync('worker_entry_combined.js', 'utf8');

const idx = src.lastIndexOf('export default');
if (idx === -1) { console.error('FAIL: no `export default` found'); process.exit(1); }
src = src.slice(0, idx);

const sandbox = {
  console,
  Date,
  Math,
  JSON,
  TextEncoder,
  TextDecoder,
  URL,
  URLSearchParams,
  crypto: require('crypto').webcrypto,
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  fetch: async () => { throw new Error('no network in sandbox'); },
  caches: { default: { match: async () => null, put: async () => {} } },
  setTimeout, clearTimeout, setInterval, clearInterval,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

try {
  vm.runInContext(src, sandbox, { filename: 'worker_entry_combined.js' });
} catch (e) {
  console.error('FAIL: evaluating combined file threw:', e.message);
  process.exit(1);
}

if (typeof sandbox.renderBuilder !== 'function') {
  console.error('FAIL: renderBuilder is not defined after evaluation');
  process.exit(1);
}

let html;
try {
  html = sandbox.renderBuilder('https://example.com', {});
} catch (e) {
  console.error('FAIL: renderBuilder() threw:', e.message);
  process.exit(1);
}
if (typeof html !== 'string' || html.length < 100000) {
  console.error('FAIL: renderBuilder returned unexpected output, length =', html && html.length);
  process.exit(1);
}
fs.writeFileSync(outPath, html);
console.log('renderBuilder OK  ->', outPath, html.length, 'chars');

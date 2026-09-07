// Sandboxed page rendering.
//
// Strips the trailing `export default { ... }` block so the file can be
// evaluated as a plain script inside a vm context, then renders a page and
// writes it out for downstream checks.
//
//   node render_check.js rendered.html          -> the builder page
//   node render_check.js admin.html --admin     -> the admin dashboard
//
// The admin page needs its own pass. It is a template literal like the builder
// page, and a single backslash inside one is eaten before the browser sees it
// -- which is how `\n\n` inside a confirm() string became a REAL newline,
// split a single-quoted string across two lines, and made the whole 60KB
// dashboard script a SyntaxError. Every admin control was dead for two days
// and nothing here noticed, because this file only ever rendered the builder.
const fs = require('fs');
const vm = require('vm');

const outPath = process.argv[2] || 'rendered.html';
const wantAdmin = process.argv.includes('--admin');
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

const fnName = wantAdmin ? 'renderAdminDashboard' : 'renderBuilder';
if (typeof sandbox[fnName] !== 'function') {
  console.error('FAIL: ' + fnName + ' is not defined after evaluation');
  process.exit(1);
}

// Enough of a KV binding to get past renderAdminDashboard's own "no CONFIGS
// bound" early return, which would otherwise hand back a 200-character stub
// and check nothing. Empty answers are fine: the dashboard's markup and its
// inline script are the same whether or not there is data to put in them.
const emptyKv = {
  get: async () => null,
  put: async () => {},
  delete: async () => {},
  list: async () => ({ keys: [], list_complete: true }),
};

async function main() {
  let html;
  try {
    html = wantAdmin
      ? await sandbox.renderAdminDashboard({ CONFIGS: emptyKv })
      : sandbox.renderBuilder('https://example.com', {});
  } catch (e) {
    console.error('FAIL: ' + fnName + '() threw:', e.message);
    process.exit(1);
  }
  const min = wantAdmin ? 20000 : 100000;
  if (typeof html !== 'string' || html.length < min) {
    console.error('FAIL: ' + fnName + ' returned unexpected output, length =', html && html.length);
    process.exit(1);
  }
  fs.writeFileSync(outPath, html);
  console.log(fnName + ' OK  ->', outPath, html.length, 'chars');
}

main();

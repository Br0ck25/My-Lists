// Sandboxed page rendering.
//
// Strips the trailing `export default { ... }` block so the file can be
// evaluated as a plain script inside a vm context, then renders a page and
// writes it out for downstream checks.
//
//   node render_check.js rendered.html          -> the builder page
//   node render_check.js admin.html --admin     -> the admin dashboard
//   node render_check.js sw.js --sw             -> the service worker
//   node render_check.js hostile.html --hostile -> the builder page with every
//                                                  caller-supplied field set to
//                                                  an XSS payload
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
const wantSw = process.argv.includes('--sw');
const wantHostile = process.argv.includes('--hostile');
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

// Top-level `const` in a classic script lives in the script scope, not on
// globalThis -- so SERVICE_WORKER_JS is invisible to the sandbox the way a
// function declaration is not. One appended line, test-only, rather than
// changing how the Worker declares it.
src += '\n;try { globalThis.SERVICE_WORKER_JS = SERVICE_WORKER_JS; } catch (e) {}\n';

try {
  vm.runInContext(src, sandbox, { filename: 'worker_entry_combined.js' });
} catch (e) {
  console.error('FAIL: evaluating combined file threw:', e.message);
  process.exit(1);
}

// The service worker is a plain string, not a render function -- it is
// emitted from a template literal like every other page here, so `node --check`
// on the combined Worker cannot see inside it either. Written out so the caller
// can check it the same way.
if (wantSw) {
  const sw = sandbox.SERVICE_WORKER_JS;
  if (typeof sw !== 'string' || sw.length < 500) {
    console.error('FAIL: SERVICE_WORKER_JS is missing or implausibly short, length =', sw && sw.length);
    process.exit(1);
  }
  fs.writeFileSync(outPath, sw);
  console.log('SERVICE_WORKER_JS OK  ->', outPath, sw.length, 'chars');
  process.exit(0);
}

// Every field a caller can put into the rendered page, set to a payload that
// would end the inline <script> (or the enclosing attribute) if it reached the
// browser unescaped. html_checks.py asserts, against this exact render, that
// neither marker survives in a form that could break out -- and that both
// markers are present at all, so the check cannot pass by rendering nothing.
//
// Keep the two marker strings identical to the ones in html_checks.py.
const XSS_SCRIPT = 'MYLXSSPROBE</script><svg onload=1>';
const XSS_ATTR = 'MYLXSSATTR" onfocus="1';
const hostileOpts = {
  isConfigureMode: true,
  deepLinkList: {
    name: XSS_SCRIPT,
    type: 'movie',
    url: 'https://example.com/lists/someone/a-list',
    creatorName: XSS_SCRIPT,
    likes: 0,
    sample: [{ id: 'tt0111161', name: XSS_SCRIPT, poster: XSS_SCRIPT, year: XSS_SCRIPT, type: 'movie' }],
    maybeMore: false,
  },
  initialEntries: [
    { id: 'e1', name: XSS_SCRIPT, url: 'tmdb:chart:popular', type: 'movie', enabled: true, group: XSS_SCRIPT },
  ],
  initialKeys: {
    // Rendered into value="..." attributes (15_tab-settings-html.js).
    tmdbKey: XSS_ATTR, mdblistKey: XSS_ATTR, traktKey: XSS_ATTR,
    traktUsername: XSS_ATTR, simklKey: XSS_ATTR,
    // Rendered into the inline <script> preamble (16_client-row-core.js).
    traktAccessToken: XSS_SCRIPT, mdblistAccessToken: XSS_SCRIPT,
    simklAccessToken: XSS_SCRIPT, simklUsername: XSS_SCRIPT,
  },
};

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
      : sandbox.renderBuilder('https://example.com', wantHostile ? hostileOpts : {});
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
  console.log(fnName + (wantHostile ? ' (hostile input)' : '') + ' OK  ->', outPath, html.length, 'chars');
}

main();

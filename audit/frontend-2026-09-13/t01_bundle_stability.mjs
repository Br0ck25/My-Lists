import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
let src = fs.readFileSync(new URL('../../worker_entry_combined.js', import.meta.url),'utf8');
src = src.slice(0, src.lastIndexOf('export default'));
const sandbox = { console, Date, Math, JSON, TextEncoder, TextDecoder, URL, URLSearchParams,
  crypto: webcrypto, atob:(s)=>Buffer.from(s,'base64').toString('binary'),
  btoa:(s)=>Buffer.from(s,'binary').toString('base64'), fetch: async()=>{throw new Error('no net')},
  caches:{default:{match:async()=>null,put:async()=>{}}}, setTimeout, clearTimeout, setInterval, clearInterval };
sandbox.globalThis = sandbox; vm.createContext(sandbox);
vm.runInContext(src, sandbox, {filename:'w.js'});

const START = "<script>/*MYLISTS_APP_BUNDLE_START*/";
const END = "/*MYLISTS_APP_BUNDLE_END*/<" + "/script>";
function extract(html){ const s=html.indexOf(START); if(s===-1) return null;
  const b=s+START.length; const e=html.indexOf(END,b); if(e===-1) return null; return html.slice(b,e); }

const variants = {
  plain:        ['https://example.com', {}],
  otherOrigin:  ['https://evil.test',   {}],
  configure:    ['https://example.com', { isConfigureMode: true }],
  withTokens:   ['https://example.com', { initialKeys: { traktAccessToken:'SECRET_TRAKT_TOKEN_AAA', mdblistAccessToken:'SECRET_MDB_BBB', simklAccessToken:'SECRET_SIMKL_CCC', simklUsername:'victimuser', tmdbKey:'KEYKEYKEY', traktUsername:'victimuser2' } }],
  withEntries:  ['https://example.com', { initialEntries: [{id:'e1',name:'PRIVATE_LIST_NAME',url:'tmdb:chart:popular',type:'movie',enabled:true}] }],
  deepLink:     ['https://example.com', { deepLinkList: { name:'DEEPLINK_NAME', type:'movie', url:'https://x/lists/a/b', creatorName:'CREATORX', likes:3, sample:[], maybeMore:false } }],
};
const out = {};
for (const [k,[o,opt]] of Object.entries(variants)) {
  const html = sandbox.renderBuilder(o, opt);
  const b = extract(html);
  out[k] = b;
  console.log(k.padEnd(14), 'html='+html.length, 'bundle='+(b?b.length:'MISSING'));
}
const base = out.plain;
let anyDiff = false;
for (const [k,b] of Object.entries(out)) {
  if (k==='plain') continue;
  if (b === base) { console.log('  IDENTICAL  ', k); continue; }
  anyDiff = true;
  console.log('  *** DIFFERS ***', k, 'len', b.length, 'vs', base.length);
  for (let i=0;i<Math.min(b.length,base.length);i++){ if(b[i]!==base[i]){
    console.log('   first diff at', i); console.log('   base  :', JSON.stringify(base.slice(Math.max(0,i-90), i+90)));
    console.log('   variant:', JSON.stringify(b.slice(Math.max(0,i-90), i+90))); break; } }
}
// secret leakage check
for (const needle of ['SECRET_TRAKT_TOKEN_AAA','SECRET_MDB_BBB','SECRET_SIMKL_CCC','victimuser','PRIVATE_LIST_NAME','DEEPLINK_NAME','CREATORX','KEYKEYKEY','evil.test']) {
  for (const [k,b] of Object.entries(out)) if (b && b.includes(needle)) console.log('!!! LEAK into bundle:', needle, 'in variant', k);
}
console.log(anyDiff ? 'RESULT: BUNDLE VARIES' : 'RESULT: bundle stable across variants');

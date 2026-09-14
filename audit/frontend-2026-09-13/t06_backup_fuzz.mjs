import pw from "playwright-core";
import { installMocks, XSS } from "./mocks.mjs";
const { chromium } = pw;
const CHROMIUM = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({ executablePath:CHROMIUM, args:["--no-sandbox","--disable-dev-shm-usage"] });
const BACKUPS = {
  "empty object":        {},
  "null entries":        { version:"3.0", entries:null, customLists:null, channels:null },
  "entries not array":   { version:"3.0", entries:"nope" },
  "entry missing fields":{ version:"3.0", entries:[{}] },
  "wrong types":         { version:"3.0", entries:[{name:123,url:{a:1},type:[],enabled:"yes"}] },
  "name/url transposed": { version:"3.0", entries:[{name:"https://mdblist.com/lists/x/y",url:"Coming Soon",type:"movie"}] },
  "XSS in list name":    { version:"3.0", entries:[{name:XSS,url:"tmdb:chart:popular",type:"movie",enabled:true}] },
  "unsafe id chars":     { version:"3.0", customLists:{ 'bad"<id':{ name:"x", items:[] }, 'ok-id':{name:"y",items:[]} } },
  "proto pollution":     JSON.parse('{"version":"3.0","entries":[],"__proto__":{"polluted":"YES"}}'),
  "ctor pollution":      JSON.parse('{"version":"3.0","entries":[],"constructor":{"prototype":{"polluted2":"YES"}}}'),
  "old 1.x format":      { entries:[{name:"Old",url:"https://mdblist.com/lists/a/b",type:"movie"}] },
  "v2 format":           { version:"2.0", entries:[{name:"V2",url:"tmdb:chart:popular",type:"movie"}], keys:{tmdbKey:"x"} },
  "duplicate ids":       { version:"3.0", entries:[{name:"D",url:"tmdb:chart:popular",type:"movie",id:"same"},{name:"D",url:"tmdb:chart:popular",type:"movie",id:"same"}] },
  "300 entries":         { version:"3.0", entries:Array.from({length:300},(_,i)=>({name:"L"+i,url:"tmdb:chart:popular",type:"movie",enabled:true})) },
};
for (const [label, backup] of Object.entries(BACKUPS)) {
  const ctx = await browser.newContext({viewport:{width:1280,height:900}});
  const page = await ctx.newPage();
  const errs=[]; page.on("pageerror",e=>errs.push(String(e.message).slice(0,110)));
  await installMocks(page,{});
  try {
    await page.goto("http://127.0.0.1:8787/", { waitUntil:"load", timeout:25000 });
    await page.waitForTimeout(2500);
    const r = await Promise.race([
      page.evaluate((b) => {
        let threw=null;
        try { window.applyImportedConfig(b); } catch(e){ threw=String(e.message).slice(0,110); }
        return { threw, polluted: ({}).polluted||null, polluted2: ({}).polluted2||null,
          xssFired: window.__XSS||0, rows: document.querySelectorAll('#lists .entry').length,
          scrollLocked: document.documentElement.style.overflow==='hidden',
          stillWorks: typeof window.addRow==='function' };
      }, backup),
      new Promise(res=>setTimeout(()=>res({TIMEOUT:true}), 20000)),
    ]);
    console.log(label.padEnd(21), JSON.stringify({...r, err:[...new Set(errs)].slice(0,1)}));
  } catch(e) { console.log(label.padEnd(21), "HARNESS ERR:", String(e.message).slice(0,90)); }
  await ctx.close();
}
await browser.close();

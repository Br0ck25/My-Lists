import re, sys, subprocess, os
path = sys.argv[1]
tag  = sys.argv[2]
html = open(path, encoding='utf-8').read()

# --- largest <script> block -> node --check ---
blocks = re.findall(r'<script[^>]*>(.*?)</script>', html, re.DOTALL)
if not blocks:
    print("FAIL: no <script> blocks found"); sys.exit(1)
blocks.sort(key=len)
biggest = blocks[-1]
fn = f'inner_{tag}.js'
open(fn,'w',encoding='utf-8').write(biggest)
r = subprocess.run(['node','--check',fn], capture_output=True, text=True)
if r.returncode != 0:
    print("FAIL: largest <script> block syntax error:\n", r.stderr[:3000]); sys.exit(1)
print(f"  inner script OK ({len(blocks)} blocks, largest {len(biggest)} chars)")

# --- duplicate top-level declarations in the client bundle ---
# Every client module (09_..24_) is concatenated into this one <script>, so
# two top-level `function foo()` declarations do not collide loudly -- the
# later one silently wins and the earlier one becomes unreachable. That is
# how handlePosterImgError ended up with two different implementations,
# only one of which ever ran, and how edits to the losing copy of
# escapeHtml changed nothing at all. Cheap to check, and the failure mode
# is invisible without it.
import collections
decls = collections.Counter(
    re.findall(r'^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(', biggest, re.M)
)
dupes = {name: n for name, n in decls.items() if n > 1}
if dupes:
    print("FAIL: duplicate top-level function declarations in the client bundle:")
    for name, n in sorted(dupes.items()):
        print(f"    {name}  declared {n}x")
    print("  Each module shares one script scope in the browser -- the last")
    print("  declaration wins and the others are dead. Keep exactly one.")
    sys.exit(1)
print(f"  no duplicate top-level declarations ({len(decls)} functions)")

# --- inline on*= handlers resolve to a function that exists ---
# The CSP deliberately allows 'unsafe-inline' on script-src because this app
# drives its UI from inline onclick=/onchange= attributes (see
# securityHeaders, 02_http-and-creator-utils.js). That is a reasonable trade
# only if those handlers actually resolve: a typo'd or deleted function is a
# ReferenceError the moment someone clicks it, and nothing else in this
# pipeline would notice -- node --check sees the page as a string, and the
# inner-script parse above only proves the bundle PARSES.
#
# Matching has to be careful or it is worse than useless. Two things produce
# false positives: method calls (something.getElementById(...)), and ordinary
# prose inside string arguments -- onclick="addRow('Streaming (All
# Services)', ...)" is not a call to Streaming(). So string literals are
# blanked first, and only bare identifiers count as calls.
def _blank_handler_strings(code):
    out = []
    i = 0
    while i < len(code):
        if code.startswith('&quot;', i):
            end = code.find('&quot;', i + 6)
            if end == -1:
                break
            out.append('""')
            i = end + 6
            continue
        ch = code[i]
        if ch in ("'", '"'):
            end = code.find(ch, i + 1)
            if end == -1:
                break
            out.append('""')
            i = end + 1
            continue
        out.append(ch)
        i += 1
    return ''.join(out)

HANDLER_ATTR = re.compile(
    r'\son(?:click|change|input|submit|keyup|keydown|keypress|blur|focus'
    r'|load|error|mouseenter|mouseleave|toggle)\s*=\s*"([^"]*)"')
JS_KEYWORDS = {'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'async',
               'await', 'function', 'do', 'else', 'in', 'of', 'delete', 'void', 'throw', 'case'}
JS_GLOBALS = {'alert', 'confirm', 'prompt', 'open', 'close', 'print', 'Number', 'String',
              'Boolean', 'Array', 'Object', 'JSON', 'Date', 'Math', 'parseInt', 'parseFloat',
              'isNaN', 'encodeURIComponent', 'decodeURIComponent', 'setTimeout', 'clearTimeout',
              'setInterval', 'fetch', 'Set', 'Map', 'RegExp', 'Error', 'Promise', 'Symbol'}

# Handler attributes are looked for across the WHOLE page, not just its
# static markup. Most of this app's UI is markup the client builds at
# runtime, so the majority of its onclick= attributes exist as text inside
# string literals in the bundle. Scanning static markup alone covered 580
# call sites; including the bundle's own strings covers 733, and catches the
# case that actually happens -- a function gets deleted or renamed while a
# button somewhere still calls it.
all_script = "\n".join(blocks)
defined = set(re.findall(r'(?:^|\s)(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(', all_script))
defined |= set(re.findall(r'(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()', all_script))
defined |= set(re.findall(r'window\.([A-Za-z_$][\w$]*)\s*=', all_script))
# EVERY script block, not only the biggest: the page carries a few small
# early ones (the theme toggle lives in one), and a handler resolves against
# whatever the whole page defines. Scanning only the bundle reported
# toggleTheme() as missing when it is perfectly fine.

handler_calls = collections.Counter()
for _m in HANDLER_ATTR.finditer(html):
    for _mm in re.finditer(r'(?<![-.\w$])([A-Za-z_$][\w$]*)\s*\(', _blank_handler_strings(_m.group(1))):
        _fn = _mm.group(1)
        if _fn in JS_KEYWORDS or _fn in JS_GLOBALS:
            continue
        handler_calls[_fn] += 1

unresolved = {fn: n for fn, n in handler_calls.items() if fn not in defined}
if unresolved:
    print("FAIL: inline handlers call functions that do not exist in the bundle:")
    for fn, n in sorted(unresolved.items(), key=lambda x: -x[1]):
        print(f"    {fn}()  referenced {n}x  -> ReferenceError when clicked")
    sys.exit(1)
print(f"  inline handlers resolve ({len(handler_calls)} distinct functions, "
      f"{sum(handler_calls.values())} call sites)")


# --- CSS brace balance ---
styles = re.findall(r'<style[^>]*>(.*?)</style>', html, re.DOTALL)
tot_o = tot_c = 0
for i, s in enumerate(styles):
    o, c = s.count('{'), s.count('}')
    tot_o += o; tot_c += c
    if o != c:
        print(f"FAIL: <style> block {i} unbalanced: {{={o} }}={c}"); sys.exit(1)
print(f"  CSS brace balance OK ({len(styles)} blocks, {tot_o} pairs)")

# --- unresolved template placeholders ---
leftovers = re.findall(r'\$\{[a-zA-Z_$]', html)
print(f"  unresolved ${{ placeholders: {len(leftovers)}")
print(f"  total length: {len(html)}")

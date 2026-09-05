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

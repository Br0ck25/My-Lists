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

import re, sys, collections
html = open(sys.argv[1], encoding='utf-8').read()
blocks = re.findall(r'<script[^>]*>(.*?)</script>', html, re.DOTALL)
all_script = "\n".join(blocks)
defined = set(re.findall(r'(?:^|\s)(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(', all_script))
defined |= set(re.findall(r'(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()', all_script))
defined |= set(re.findall(r'window\.([A-Za-z_$][\w$]*)\s*=', all_script))
defined |= set(re.findall(r'globalThis\.([A-Za-z_$][\w$]*)\s*=', all_script))

KW = {'if','for','while','switch','catch','return','typeof','new','async','await','function',
      'do','else','in','of','delete','void','throw','case','this','try','const','let','var','class'}
G = {'alert','confirm','prompt','open','close','print','Number','String','Boolean','Array','Object',
     'JSON','Date','Math','parseInt','parseFloat','isNaN','encodeURIComponent','decodeURIComponent',
     'setTimeout','clearTimeout','setInterval','fetch','Set','Map','RegExp','Error','Promise','Symbol',
     'Array','requestAnimationFrame','queueMicrotask','structuredClone','Intl'}

def blank(code):
    out=[];i=0
    while i < len(code):
        if code.startswith('&quot;', i):
            e = code.find('&quot;', i+6)
            if e == -1: break
            out.append('""'); i = e+6; continue
        ch = code[i]
        if ch in ("'", '"'):
            e = code.find(ch, i+1)
            if e == -1: break
            out.append('""'); i = e+1; continue
        out.append(ch); i += 1
    return ''.join(out)

# BOTH quote styles, ANY on* attribute
PATS = [re.compile(r'\son([a-z]+)\s*=\s*"([^"]*)"'), re.compile(r"\son([a-z]+)\s*=\s*'([^']*)'")]
calls = collections.Counter(); byevent = collections.Counter(); where = {}
for pat in PATS:
    for m in pat.finditer(html):
        ev = m.group(1); code = m.group(2)
        byevent[ev] += 1
        for mm in re.finditer(r'(?<![-.\w$])([A-Za-z_$][\w$]*)\s*\(', blank(code)):
            fn = mm.group(1)
            if fn in KW or fn in G: continue
            calls[fn] += 1
            where.setdefault(fn, (ev, code[:110]))
print("events seen:", dict(byevent))
un = {f:n for f,n in calls.items() if f not in defined}
print(f"{len(calls)} distinct handler functions, {sum(calls.values())} call sites")
if un:
    print("UNRESOLVED:")
    for f,n in sorted(un.items(), key=lambda x:-x[1]):
        print(f"   {f}()  x{n}   on{where[f][0]}=  {where[f][1]}")
else:
    print("all resolve")

import sys
with open('18_client-copy-and-trakt-export.js', 'r', encoding='utf-8') as f:
    content = f.read()

lines = content.split('\n')
idx = -1
for i, l in enumerate(lines):
    if '// --- Import from Trakt export' in l:
        idx = i
        break

if idx != -1:
    with open('scratch.js', 'r', encoding='utf-8') as f:
        code = f.read()
    lines.insert(idx, code)
    with open('18_client-copy-and-trakt-export.js', 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))
    print('Fixed!')
else:
    print('Not found')

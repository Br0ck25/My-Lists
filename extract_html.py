import re
with open('worker_entry_combined.js', 'r', encoding='utf-8') as f:
    content = f.read()

match = re.search(r'function renderBuilder\(.*?\).*?return `(.*?)`;\n\}', content, re.DOTALL)
if match:
    html_content = match.group(1)
    with open('test.html', 'w', encoding='utf-8') as f:
        f.write(html_content)
    
    script_match = re.search(r'<script>(.*?)</script>', html_content, re.DOTALL)
    if script_match:
        with open('test_inner.js', 'w', encoding='utf-8') as f:
            f.write(script_match.group(1))
        print("Successfully extracted test_inner.js")
    else:
        print("Could not find script block")
else:
    print("Could not find renderBuilder")

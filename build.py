# Python equivalent of build.ps1: header + numbered split files, byte-exact.
import glob, re, io
combined_old = open('worker_entry_combined.js','rb').read()
first = open('00_constants.js','rb').read()
at = combined_old.find(first)
assert at != -1, "could not locate 00_constants.js inside the existing combined file"
header = combined_old[:at]
print("header bytes:", len(header))

out = bytearray(header)
for f in sorted(glob.glob('[0-9][0-9]_*.js')):
    data = open(f,'rb').read()
    out += data
    if not data.endswith(b'\n'):
        out += b'\r\n'
open('worker_entry_combined.js','wb').write(bytes(out))
print("combined bytes:", len(out), " (was", len(combined_old), ")")

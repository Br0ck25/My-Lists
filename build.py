# Python equivalent of build.ps1: header + numbered split files, byte-exact.
#
# The header used to be recovered by searching the EXISTING combined file for
# the current contents of 00_constants.js and keeping everything before it.
# That made the build self-referential: editing 00_constants.js broke the
# search, and the build then refused to run at all ("could not locate
# 00_constants.js inside the existing combined file"). It also meant the
# header had no source file, so a direct edit to it inside the generated
# Worker was invisible to the CI drift check. It now comes from header.js
# like every other input.
import glob

out = bytearray(open('header.js', 'rb').read())
for f in sorted(glob.glob('[0-9][0-9]_*.js')):
    data = open(f, 'rb').read()
    out += data
    if not data.endswith(b'\n'):
        out += b'\r\n'
open('worker_entry_combined.js', 'wb').write(bytes(out))
print("header bytes:", len(open('header.js', 'rb').read()))
print("combined bytes:", len(out))

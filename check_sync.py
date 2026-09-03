import sys, glob, os
combined = open('worker_entry_combined.js','rb').read()
bad=0
for f in sorted(glob.glob('[0-9][0-9]_*.js')):
    data = open(f,'rb').read()
    if data not in combined:
        print("  MISMATCH:", f)
        bad+=1
    else:
        print("  ok:", f, len(data))
sys.exit(1 if bad else 0)

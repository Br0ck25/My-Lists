#!/usr/bin/env bash
# The full verification pipeline. Run from the repo root: bash tools/verify.sh
# Never redirect this to /dev/null -- a check nobody reads is not a check.
set -e
cd "$(dirname "$0")/.."

echo "=== 1. rebuild the combined file from the split files ==="
python3 tools/build.py

echo; echo "=== 2. split/combined byte consistency ==="
python3 tools/check_sync.py | grep MISMATCH && { echo "  FAILED"; exit 1; } || echo "  all split files present verbatim"

echo; echo "=== 3. node --check ==="
node --check worker_entry_combined.js && echo "  OK"

echo; echo "=== 4. sandboxed renderBuilder() ==="
node tools/render_check.js rendered.html

echo; echo "=== 5. rendered <script> syntax + CSS balance ==="
python3 tools/html_checks.py rendered.html run

echo; echo "=== 6. template-literal hazard (files 09-24) ==="
python3 - <<'PY'
import glob,sys
bad=0
for f in sorted(glob.glob('[0-2][0-9]_*.js')):
    n=int(f[:2])
    if not (9<=n<=24): continue
    d=open(f,'rb').read()
    # A backtick anywhere in 09-24 terminates the renderBuilder literal early.
    # A handful are legitimate (they open/close it); the count must not GROW.
    if d.count(b'`') > 10:
        bad+=1; print(f"  FAIL {f}: {d.count(96)} backticks -- one of these will break the build")
print("  RESULT:", "FAIL" if bad else "no file in the literal carries an unexpected backtick")
sys.exit(1 if bad else 0)
PY

echo; echo "=== 7. behavioural suites ==="
fail=0
for t in tests/*.js; do
  printf "  %-38s " "$(basename "$t")"
  if out=$(node "$t" 2>&1); then echo "$out" | tail -1
  else echo "FAILED"; echo "$out" | tail -20; fail=1; fi
done
[ "$fail" = 0 ] || { echo; echo "SUITES FAILED"; exit 1; }

echo; echo "ALL CHECKS PASSED"

#!/usr/bin/env bash
# PHASE 27 -- mutation testing. Each mutation is a controlled, semantically
# real bug. If the suite stays green, that behaviour is not covered.
set -u
SRC=$(cd "$(dirname "$0")/../.." && pwd)
WORK=/tmp/claude-0/-home-user-My-Lists/ae496c16-dc4b-512b-ad97-71ce0611b42c/scratchpad/mut
NAME=$1
shift
DIR="$WORK/$NAME"
rm -rf "$DIR"; mkdir -p "$WORK"
cp -r "$SRC" "$DIR" 2>/dev/null
rm -rf "$DIR/.git" "$DIR/.audit"
cd "$DIR" || exit 9
# apply the mutation (passed as a python3 snippet on stdin)
python3 - "$@" <<'PYEOF'
import sys, re, io, os
target, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(target, encoding='utf-8').read()
if old not in s:
    print("MUTATION-NOT-APPLIED"); sys.exit(9)
s = s.replace(old, new, 1)
open(target, 'w', encoding='utf-8').write(s)
PYEOF
rc=$?
if [ $rc -ne 0 ]; then echo "$NAME: MUTATION NOT APPLIED"; exit 9; fi
python3 build.py > /dev/null 2>&1 || { echo "$NAME: BUILD FAILED"; exit 9; }
node --check worker_entry_combined.js 2>/dev/null || { echo "$NAME: SYNTAX ERROR"; exit 9; }
out=$(node --test tests/*.test.mjs 2>&1)
fails=$(echo "$out" | grep -E "^# fail " | awk '{print $3}')
passes=$(echo "$out" | grep -E "^# pass " | awk '{print $3}')
if [ "${fails:-1}" = "0" ]; then
  echo "$NAME: SURVIVED (suite stayed green: $passes pass / $fails fail)"
else
  echo "$NAME: killed ($passes pass / $fails fail)"
fi

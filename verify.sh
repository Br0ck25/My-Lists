#!/usr/bin/env bash
# Run from the repo root: bash verify.sh
set -euo pipefail
cd "$(dirname "$0")"

echo "=== 1. rebuild combined Worker ==="
python3 build.py

echo
echo "=== 2. build drift (CRLF-insensitive) ==="
if git diff --ignore-cr-at-eol --quiet -- worker_entry_combined.js; then
  echo "  OK"
else
  echo "  FAILED — worker_entry_combined.js does not match source"
  git diff --ignore-cr-at-eol --stat -- worker_entry_combined.js
  exit 1
fi

echo
echo "=== 3. node --check ==="
node --check worker_entry_combined.js && echo "  OK"

echo
echo "=== 4. render + validate the builder page ==="
# node --check above only parses the outer JS file; the inline <script> the
# rendered page returns as a template-literal STRING is invisible to it. See
# .github/workflows/ci.yml for the full explanation.
node render_check.js rendered.html
python3 html_checks.py rendered.html local
rm -f rendered.html inner_local.js

echo
echo "=== 5. FUNCTION-MAP.md drift ==="
# gen_map.py is only useful if it is actually re-run. It was not: 26% of the
# map's 811 line numbers pointed at a line that no longer held that symbol,
# so navigating by it quietly sent you to the wrong place. Regenerating is
# cheap and deterministic, so the map is now checked the same way the
# combined Worker is.
python3 gen_map.py > /dev/null
if git diff --ignore-cr-at-eol --quiet -- FUNCTION-MAP.md; then
  echo "  OK"
else
  echo "  FAILED — FUNCTION-MAP.md is stale; run: python3 gen_map.py"
  git diff --ignore-cr-at-eol --stat -- FUNCTION-MAP.md
  exit 1
fi

echo
echo "=== 6. tests ==="
node --test tests/*.test.mjs

echo
echo "ALL CHECKS PASSED"

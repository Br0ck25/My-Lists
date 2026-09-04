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
echo "=== 4. tests ==="
node --test tests/*.test.mjs

echo
echo "ALL CHECKS PASSED"

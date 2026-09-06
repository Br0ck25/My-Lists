#!/usr/bin/env bash
# Mutation testing for the second pass (R1-R5) -- the items left open when
# AUDIT-2026-09-06-ADVERSARIAL-II.md was written and closed afterwards. Same
# contract as mutate2.sh / mutate3.sh: destructive to the directory it runs in,
# restores the sources itself, CAUGHT means the suite noticed the sabotage.
#
#   git archive HEAD | tar -x -C /tmp/mut4
#   cp audit/adversarial-II-2026-09-06/mutate4.sh /tmp/mut4/
#   cd /tmp/mut4 && bash mutate4.sh
cd "$(dirname "$0")"
mkdir -p .pristine; for f in [0-9][0-9]_*.js; do cp "$f" ".pristine/$f"; done
cp schema.sql .pristine/schema.sql
restore(){ for f in [0-9][0-9]_*.js; do cp ".pristine/$f" "$f"; done; cp .pristine/schema.sql schema.sql; python3 build.py >/dev/null; }
one(){ local name="$1"; local file="$2"; local spec="$3"
  restore
  python3 - "$file" "$spec" <<'PY' || { echo "SKIP     $name"; restore; return; }
import sys, json
path, spec = sys.argv[1], json.loads(sys.argv[2])
s = open(path, encoding='utf-8').read()
if s.count(spec['old']) != 1: sys.exit(1)
open(path,'w',encoding='utf-8').write(s.replace(spec['old'], spec['new']))
PY
  python3 build.py >/dev/null
  node --check worker_entry_combined.js 2>/dev/null || { echo "SKIP     $name (syntax)"; restore; return; }
  out=$(node --test tests/worker.test.mjs 2>&1 | grep -E "^# (pass|fail)" | tr '\n' ' ')
  f=$(echo "$out" | sed -n 's/.*# fail \([0-9]*\).*/\1/p')
  if [ "${f:-0}" -gt 0 ]; then echo "CAUGHT   $name"; else echo "SURVIVED $name   <-- test not real"; fi
  restore; }
one "R1 anon delete does nothing" "02_http-and-creator-utils.js" "{\"old\": \"    try {\\n      await env.CONFIGS.delete(key);\\n    } catch (e) {\\n      console.error(\\\"deletePublishedLists: could not delete\\\", key, e);\\n      out.ok = false;\\n    }\", \"new\": \"    try {\\n      if (false) await env.CONFIGS.delete(key);\\n    } catch (e) {\\n      out.ok = false;\\n    }\"}"
one "R1 anon delete swallows failure" "02_http-and-creator-utils.js" "{\"old\": \"      console.error(\\\"deletePublishedLists: could not delete\\\", key, e);\\n      out.ok = false;\", \"new\": \"      console.error(\\\"deletePublishedLists: could not delete\\\", key, e);\"}"
one "R2 list conflict guard removed" "26_api-creator-and-admin-routes.js" "{\"old\": \"      if (existingReadable && listExpected.value !== null && storedUpdatedAt > listExpected.value) {\", \"new\": \"      if (false) {\"}"
one "R2 bare Date.now as the list version" "26_api-creator-and-admin-routes.js" "{\"old\": \"      const updatedAt = nextSyncVersion(storedUpdatedAt);\", \"new\": \"      const updatedAt = Date.now();\"}"
one "R3 D1 tombstone never written" "02_http-and-creator-utils.js" "{\"old\": \"        await env.DB.prepare(\\n          \\\"INSERT INTO creator_tombstones (username, until) VALUES (?, ?) ON CONFLICT(username) DO UPDATE SET until = excluded.until\\\"\\n        ).bind(u, Date.now() + CREATOR_TOMBSTONE_TTL_SEC * 1000).run();\", \"new\": \"        /* mutated */;\"}"
one "R3 D1 tombstone never read" "02_http-and-creator-utils.js" "{\"old\": \"  if (env.DB) {\\n    try {\\n      const { results } = await env.DB.prepare(\\n        \\\"SELECT until FROM creator_tombstones WHERE username = ?\\\"\\n      ).bind(username).all();\", \"new\": \"  if (false) {\\n    try {\\n      const { results } = await env.DB.prepare(\\n        \\\"SELECT until FROM creator_tombstones WHERE username = ?\\\"\\n      ).bind(username).all();\"}"
one "R5 order write stops merging" "26_api-creator-and-admin-routes.js" "{\"old\": \"          const freshRaw = await env.CONFIGS.get(\`creatorlistorder:\${auth.username}\`);\", \"new\": \"          const freshRaw = null;\"}"
one "R1 paging cursor always null" "26_api-creator-and-admin-routes.js" "{\"old\": \"        cursor: listed.list_complete ? null : (listed.cursor || null),\", \"new\": \"        cursor: null,\"}"
restore; echo "--- restored ---"

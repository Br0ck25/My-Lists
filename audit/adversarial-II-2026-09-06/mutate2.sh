#!/usr/bin/env bash
# Phase 27: mutation testing. Each mutation is a controlled bug; a healthy
# suite must fail. Restores the pristine sources after every run.
cd "$(dirname "$0")"
mkdir -p .pristine
for f in [0-9][0-9]_*.js; do cp "$f" ".pristine/$f"; done
restore(){ for f in [0-9][0-9]_*.js; do cp ".pristine/$f" "$f"; done; python3 build.py >/dev/null; }

run_one(){
  local name="$1"; shift
  restore
  "$@" || { echo "SKIP  $name (mutation did not apply)"; restore; return; }
  python3 build.py >/dev/null
  if ! node --check worker_entry_combined.js 2>/dev/null; then echo "SKIP  $name (syntax)"; restore; return; fi
  out=$(node --test tests/*.test.mjs 2>&1 | grep -E "^# (pass|fail)" | tr '\n' ' ')
  fails=$(echo "$out" | sed -n 's/.*# fail \([0-9]*\).*/\1/p')
  if [ "${fails:-0}" -gt 0 ]; then echo "CAUGHT   $name  ($out)"; else echo "SURVIVED $name  ($out)  <-- coverage hole"; fi
  restore
}

# M1: remove the auth check on the most destructive endpoint
run_one "M1 delete-account skips authentication" \
  perl -0pi -e 's/(if \(path === "\/api\/creator\/delete-account" && request\.method === "POST"\) \{)/$1\n      const __mut = 1;/' 26_api-creator-and-admin-routes.js

# M2: invert the public-visibility test (private lists become public)
run_one "M2 isPublicListVisibility inverted" \
  perl -0pi -e 's/function isPublicListVisibility\(visibility\) \{\n  return visibility === "public";/function isPublicListVisibility(visibility) {\n  return visibility !== "public";/' 02_http-and-creator-utils.js

# M3: normalizeListVisibility fails OPEN
run_one "M3 normalizeListVisibility defaults to public" \
  perl -0pi -e 's/return raw === "public" \? "public" : "private";/return raw === "private" ? "private" : "public";/' 02_http-and-creator-utils.js

# M4: skip the KV write in lists/save (D1 only)
run_one "M4 lists-save skips the KV write" \
  perl -0pi -e 's/      await env\.CONFIGS\.put\(\n        `creatorlist:\$\{auth\.username\}:\$\{slug\}`,/      if (false) await env.CONFIGS.put(\n        `creatorlist:\${auth.username}:\${slug}`,/' 26_api-creator-and-admin-routes.js

# M5: skip the D1 write in lists/save
run_one "M5 lists-save skips the D1 write" \
  perl -0pi -e 's/      if \(env\.DB\) \{\n        try \{\n          const listId = `\$\{auth\.username\}:\$\{slug\}`;/      if (false) {\n        try {\n          const listId = `\${auth.username}:\${slug}`;/' 26_api-creator-and-admin-routes.js

# M6: ignore the optimistic-concurrency version entirely
run_one "M6 sync conflict guard removed" \
  perl -0pi -e 's/if \(expectedUpdatedAt !== null && currentUpdatedAt > expectedUpdatedAt\) \{/if (false) {/' 26_api-creator-and-admin-routes.js

# M7: nextSyncVersion stops being strictly increasing
run_one "M7 nextSyncVersion returns a bare Date.now()" \
  perl -0pi -e 's/  return Number\.isFinite\(prev\) && prev >= now \? prev \+ 1 : now;/  return now;/' 02_http-and-creator-utils.js

# M8: drop the pagination cursor in listAllKeys
run_one "M8 listAllKeys stops following the cursor" \
  perl -0pi -e 's/    cursor = result\.cursor;\n    if \(result\.list_complete\) \{\n      break;\n    \}/    cursor = undefined;\n    break;/' 02_http-and-creator-utils.js

# M9: change < to <= in pickFreeSlug numbered scan
run_one "M9 pickFreeSlug off-by-one" \
  perl -0pi -e 's/for \(let attempt = 2; attempt <= SLUG_NUMBERED_ATTEMPTS; attempt\+\+\)/for (let attempt = 2; attempt < SLUG_NUMBERED_ATTEMPTS; attempt++)/' 02_http-and-creator-utils.js

# M10: change one KV key prefix
run_one "M10 creatorlist key prefix changed on read" \
  perl -0pi -e 's/    const raw = await env\.CONFIGS\.get\(`creatorlist:\$\{username\}:\$\{slug\}`\);/    const raw = await env.CONFIGS.get(`creatorlistX:\${username}:\${slug}`);/' 02_http-and-creator-utils.js

# M11: key rotation no longer invalidates the isolate memo
run_one "M11 invalidateCreatorAuthMemo becomes a no-op" \
  perl -0pi -e 's/function invalidateCreatorAuthMemo\(\) \{/function invalidateCreatorAuthMemo() {\n  return;/' 02_http-and-creator-utils.js

# M12: purge stops deleting the identity
run_one "M12 purge never removes the KV identity" \
  perl -0pi -e 's/          await env\.CONFIGS\.delete\(`creator:\$\{u\}`\);/          if (false) await env.CONFIGS.delete(`creator:\${u}`);/' 02_http-and-creator-utils.js

# M13: verifyCreatorKey always succeeds
run_one "M13 timingSafeEqualHex always true" \
  perl -0pi -e 's/function timingSafeEqualHex\(a, b\) \{/function timingSafeEqualHex(a, b) {\n  return true;/' 02_http-and-creator-utils.js

# M14: removal from the public index becomes a no-op
run_one "M14 updatePublicListIndex ignores removals" \
  perl -0pi -e 's/  if \(!entry\) await noteRemovedFromPublicIndex\(env, \[id\]\);/  if (!entry) return true;/' 02_http-and-creator-utils.js

# M15: rate limit removed from creator create
run_one "M15 creator-create rate limit removed" \
  perl -0pi -e 's/      if \(await env\.CONFIGS\.get\(rateLimitKey\)\) \{\n        return json\(\{ ok: false, error: "Please wait a moment before creating another Profile\." \}, 429\);\n      \}//' 26_api-creator-and-admin-routes.js

# M16: like route stops re-reading before write (the stale-clobber bug)
run_one "M16 like route writes its stale snapshot back" \
  perl -0pi -e 's/        const freshRaw = await env\.CONFIGS\.get\(likeKey\);/        const freshRaw = JSON.stringify(likeData);/' 25_api-catalog-routes.js

restore
echo "--- sources restored ---"

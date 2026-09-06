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

# M1b: genuinely remove the auth check from delete-account
run_one "M1b delete-account accepts any credentials" \
  perl -0pi -e 's/(if \(path === "\/api\/creator\/delete-account" && request\.method === "POST"\) \{[\s\S]{0,900}?)const auth = await authenticateCreator\(body\.creatorName, body\.creatorKey\);/$1const auth = { ok: true, username: String(body.creatorName||"").toLowerCase(), displayName: "x" };/' 26_api-creator-and-admin-routes.js

# M17: the per-list delete stops deleting the KV record
run_one "M17 deleteCreatorLists never deletes the KV record" \
  perl -0pi -e 's/    try \{\n      await env\.CONFIGS\.delete\(key\);\n    \} catch \(e\) \{/    try {\n      if (false) await env.CONFIGS.delete(key);\n    } catch (e) {/' 02_http-and-creator-utils.js

# M18: the account purge stops removing lists from the public directory
run_one "M18 purge skips the public-directory cleanup" \
  perl -0pi -e 's/  await removeListsFromPublicIndex\(env, purgedListIds\);/  if (false) await removeListsFromPublicIndex(env, purgedListIds);/' 02_http-and-creator-utils.js

# M19: the cron cursor advances even when the batch was not finished
run_one "M19 cron cursor advances before the batch is processed" \
  perl -0pi -e "s/  await env\.CONFIGS\.put\('cron:continuewatching:cursor', listResult\.list_complete \? '' : \(listResult\.cursor \|\| ''\)\);/  await env.CONFIGS.put('cron:continuewatching:cursor', listResult.cursor || '');/" 07_source-fetchers-tmdb-simkl.js

# M20: the like endpoint stops requiring the list to exist
run_one "M20 like endpoint accepts any username/slug" \
  perl -0pi -e 's/      if \(!likeKey\) return json\(\{ ok: false, error: "List not found\." \}, 404\);/      if (!likeKey) { likeKey = likeCreatorKey; likeRaw = JSON.stringify({name:"x",visibility:"private",items:[]}); }/' 25_api-catalog-routes.js

# M21: the recovery-answer per-account failure budget is removed
run_one "M21 reset-key per-account failure budget removed" \
  perl -0pi -e 's/      if \(await readAuthFailureCount\(env, resetScope, resetDay\) >= RESET_KEY_ACCOUNT_MAX_FAILURES\) \{/      if (false) {/' 26_api-creator-and-admin-routes.js

# M22: sync/save-tracking stops guarding derived lists
run_one "M22 share-tracking accepts any slug" \
  perl -0pi -e 's/      if \(!ALLOWED_SHARE_SLUGS\.has\(slug\)\) \{/      if (false) {/' 26_api-creator-and-admin-routes.js

# M23: reorder stops validating slug characters
run_one "M23 reorder accepts arbitrary slug strings" \
  perl -0pi -e 's/            \.filter\(\(s\) => s\.length <= 60 && \/\^\[a-zA-Z0-9\._-\]\+\$\/\.test\(s\)\)/            .filter((s) => true)/' 26_api-creator-and-admin-routes.js

restore
echo "--- sources restored ---"

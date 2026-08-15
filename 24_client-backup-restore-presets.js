// --- config JSON export/import (backup / restore) --------------------------
//
// A plain-text alternative to the install link: the same { entries,
// mdblistKey } shape buildConfig() encodes into a base64 URL, but here it's
// left as readable JSON in a textarea -- something to copy into a notes app
// or another device, and paste back in later, without touching the actual
// install link.
function exportConfigJson() {
  const entries = collectEntries();
  if (!entries.length) {
    alert('Add at least one list first.');
    return;
  }
  const keys = collectKeys();
  const payload = { entries };
  if (keys.mdblistKey) payload.mdblistKey = keys.mdblistKey;
  if (keys.traktKey) payload.traktKey = keys.traktKey;
  if (keys.traktUsername) payload.traktUsername = keys.traktUsername;
  if (keys.traktAccessToken) payload.traktAccessToken = keys.traktAccessToken;
  document.getElementById('configJsonBox').value = JSON.stringify(payload, null, 2);
}

function importConfigJson() {
  const raw = document.getElementById('configJsonBox').value.trim();
  if (!raw) {
    alert('Paste a config JSON blob into the box first.');
    return;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    alert('That is not valid JSON.');
    return;
  }
  applyImportedConfig(data);
}

// Shared by importConfigJson (textarea) and uploadConfigFile (file upload) --
// same validation and row-rebuilding either way, just a different source
// for the raw JSON.
function applyImportedConfig(data) {
  if (!data || !Array.isArray(data.entries)) {
    alert('That JSON does not look like a My Lists config -- expected an "entries" array.');
    return;
  }
  document.getElementById('lists').innerHTML = '';
  data.entries.forEach((e) => addRow(e.name, e.url, e.type, e.enabled, e.group, e.id));
  if (data.mdblistKey) document.getElementById('mdblistKeyInput').value = data.mdblistKey;
  if (data.traktKey) document.getElementById('traktKeyInput').value = data.traktKey;
  if (data.traktUsername) document.getElementById('traktUsernameInput').value = data.traktUsername;
  if (data.traktAccessToken) {
    traktAccessToken = data.traktAccessToken;
    renderTraktConnectStatus();
  }
  renumber();
  checkAllDuplicateUrls();
  saveState();
  renderChannelMergeList();
  scheduleMyMdblistListsRefresh();
  scheduleMyTraktListsRefresh();
  alert('Imported ' + data.entries.length + ' list(s).');
}

// --- import from an existing link -------------------------------------------
//
// Reads this add-on's own install link / configure link / stremio:// /
// wako:// link back into rows, via the server's /api/resolve (same
// resolveConfig() the manifest/configure routes use, so it works whether
// the link is a short KV id or a legacy self-contained base64 blob). This
// can only work for THIS add-on's own links -- a manifest from a different
// Stremio add-on, or a screenshot of one, doesn't carry the original list
// URLs anywhere recoverable, so there's no reliable way to reconstruct rows
// from either of those; Bulk Add below is the practical fallback there.
async function importFromLink() {
  const raw = document.getElementById('importLinkInput').value.trim();
  if (!raw) {
    alert('Paste an install link, configure link, or stremio://\\/wako:// link first.');
    return;
  }
  const cleaned = raw.replace(/^stremio:\\/\\//, 'https://').replace(/^wako:\\/\\//, 'https://');
  const m = cleaned.match(/\\/([^/]+)\\/(?:manifest\\.json|configure)(?:[/?#]|$)/);
  let config = null;
  if (m) {
    config = m[1];
  } else if (/^[A-Za-z0-9_-]{6,}$/.test(cleaned)) {
    config = cleaned; // looks like a bare config id/token, pasted on its own
  }
  if (!config) {
    alert('Could not find a config in that link -- paste the full install link (ending in /manifest.json) or a configure link.');
    return;
  }
  try {
    const res = await fetch(ORIGIN + '/api/resolve?config=' + encodeURIComponent(config));
    const data = await res.json();
    if (!data.ok) {
      alert('Could not load that link: ' + (data.error || 'unknown error'));
      return;
    }
    data.entries.forEach((e) => addRow(e.name, e.url, e.type, e.enabled, e.group, e.id));
    if (data.mdblistKey) document.getElementById('mdblistKeyInput').value = data.mdblistKey;
    if (data.traktKey) document.getElementById('traktKeyInput').value = data.traktKey;
    if (data.traktUsername) document.getElementById('traktUsernameInput').value = data.traktUsername;
    if (data.traktAccessToken) {
      traktAccessToken = data.traktAccessToken;
      renderTraktConnectStatus();
    }
    renumber();
    checkAllDuplicateUrls();
    saveState();
    renderChannelMergeList();
    document.getElementById('importLinkInput').value = '';
    alert('Imported ' + data.entries.length + ' list(s) from that link.');
  } catch (e) {
    alert('Network error while resolving that link.');
  }
}

// --- personal presets --------------------------------------------------------
//
// Named local saves of a row selection, for reuse ("my usual setup") or
// sharing (Share copies the same JSON shape the Backup/Restore export
// uses, so the recipient can paste it into their own Import box). Stored
// separately from the autosave snapshot under its own localStorage key, and
// deliberately never includes the MDBList key -- a preset is meant to be
// safe to hand to someone else without a second thought.
const PRESETS_KEY = 'myListAddon:presets';

// Backs every preset-related function below (they all go through
// loadPresetsMap()), since localStorage alone can't be trusted to hold
// everything once a signed-in account's presets include a large Channel --
// once something's too big to persist there, it would otherwise silently
// vanish from Load/Share/Download/Delete too, not just fail to save.
// localStorage is still used underneath as a best-effort mirror for
// whatever it CAN hold, refreshed from the account by loadCreatorSync
// after every sign-in.
let cachedPresetsMap = null;

function loadPresetsMap() {
  if (cachedPresetsMap) return cachedPresetsMap;
  try {
    cachedPresetsMap = JSON.parse(localStorage.getItem(PRESETS_KEY) || '{}');
  } catch (e) {
    cachedPresetsMap = {};
  }
  return cachedPresetsMap;
}

function savePresetsMap(map) {
  // Always updates the cache first, even if the localStorage write below
  // fails -- this is what actually keeps a too-big-for-local-storage
  // preset visible and usable for the rest of this page session, whether
  // or not it also successfully persists to disk.
  cachedPresetsMap = map;
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(map));
    return true;
  } catch (e) {
    // Most likely a quota error -- a TV Channel with hundreds of episodes
    // easily runs well past 100KB on its own, and localStorage's total
    // quota is shared across every preset saved plus everything else this
    // add-on keeps there. This used to fail completely silently, which
    // looked exactly like "doesn't work" with no explanation at all --
    // callers now get a false back and can say something useful instead.
    return false;
  }
}

// Pushes a presets map straight to the account's dedicated presets record
// (see /api/creator/sync/save-presets) -- the ONLY path presets travel to
// the server through now, whether from the normal debounced
// schedulePresetsSync path or, as originally added here, as a fallback
// when the local write just failed (see saveCurrentAsPreset below):
// loadPresetsMap() there would only re-read the same stale, pre-failure
// data from localStorage, silently dropping the new preset even for
// someone who's signed in -- passing the in-memory map directly here is
// what actually gets the just-added preset saved anywhere at all in that
// case. Deliberately sends nothing else (no config/collapsedPanels/
// likedLists) -- see save-presets' own comment for why keeping this
// request small is the actual point of the split.
async function pushPresetsDirectly(presetsMap) {
  if (!activeCreator) return { ok: false, error: null };
  const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
  if (!creatorKey) return { ok: false, error: null };
  try {
    const presetsB64 = await compressJsonToBase64(presetsMap);
    const res = await fetch(ORIGIN + '/api/creator/sync/save-presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creatorName: activeCreator.creatorName,
        creatorKey: creatorKey,
        presets: presetsB64 ? undefined : presetsMap,
        presetsB64: presetsB64,
      }),
    });
    const data = await res.json().catch(() => null);
    if (!data || data.ok === false) {
      // Logged (not just discarded) so a DevTools console check actually
      // shows what went wrong -- an HTTP status with no JSON body at all
      // usually means the request was killed outright (e.g. Cloudflare's
      // free-plan 10ms CPU budget on this Worker) rather than anything
      // this endpoint's own code returned. Should be rare now that this
      // request no longer bundles config/watchHistory/etc alongside a
      // large presets payload the way the old shared endpoint did.
      console.error('pushPresetsDirectly failed:', res.status, data);
      return { ok: false, error: (data && data.error) || null, status: res.status };
    }
    return { ok: true, error: null };
  } catch (e) {
    console.error('pushPresetsDirectly failed:', e);
    return { ok: false, error: null };
  }
}

async function saveCurrentAsPreset() {
  const nameInput = document.getElementById('presetNameInput');
  const name = nameInput.value.trim();
  if (!name) {
    alert('Name this preset first.');
    return;
  }
  const entries = collectEntries();
  if (!entries.length) {
    alert('Add at least one list first.');
    return;
  }
  const map = loadPresetsMap();
  map[name] = { entries };
  const localOk = savePresetsMap(map);

  if (!localOk) {
    // Local storage is full -- if this account is signed in, push the
    // in-memory map (not a re-read of the stale local copy) straight to
    // the server instead of just failing the same way a local-only setup
    // would. KV values go up to 25MB, comfortably clear of anything a
    // Channel-heavy preset would realistically hit on its own -- though
    // several such presets in the same account can still add up close to
    // that limit (see the size guard on /api/creator/sync/save-presets).
    const pushResult = activeCreator ? await pushPresetsDirectly(map) : { ok: false, error: null };
    if (!pushResult.ok) {
      alert(
        activeCreator
          ? (pushResult.error
              ? 'Could not save this preset to your account: ' + pushResult.error
              : 'Could not save this preset to your account either \u2014 check your connection and try again. If this keeps happening, check the browser console (F12) for more detail.')
          : 'Could not save this preset \u2014 your browser\\'s local storage is full. This usually happens when a TV Channel with a lot of episodes is included, since each preset stores a full copy of everything in it. Try removing a large Channel from this preset, deleting an older preset you no longer need, using Backup/Restore\\'s "Download as file" option instead (which isn\\'t limited the same way), or creating a free account so this can be saved there instead of just this browser.'
      );
      return;
    }
  }

  nameInput.value = '';
  renderPresetsList();
  if (localOk) schedulePresetsSync();
}

function renderPresetsList() {
  const container = document.getElementById('presetsList');
  const badge = document.getElementById('presetsCountBadge');
  const map = loadPresetsMap();
  const names = Object.keys(map).sort();
  if (badge) badge.textContent = names.length ? '(' + names.length + ' saved)' : '';
  if (!names.length) {
    container.innerHTML = '<p><small>No saved presets yet.</small></p>';
    return;
  }
  container.innerHTML = names.map((n) => {
    const count = (map[n].entries || []).length;
    return '<div class="row quick-row" data-preset="' + escapeAttr(n) + '">' +
      '<strong>' + escapeHtml(n) + '</strong> <small style="color:var(--muted);">(' + count + ' list(s))</small>' +
      '<span class="actions" style="gap:6px;">' +
      '<button type="button" class="secondary preset-load-btn">Load</button>' +
      '<button type="button" class="secondary preset-share-btn">Share</button>' +
      '<button type="button" class="secondary preset-download-btn">Download</button>' +
      '<button type="button" class="secondary preset-delete-btn">Delete</button>' +
      '</span></div>';
  }).join('');
}

document.getElementById('presetsList').addEventListener('click', (e) => {
  const row = e.target.closest('[data-preset]');
  if (!row) return;
  const name = row.getAttribute('data-preset');
  if (e.target.classList.contains('preset-load-btn')) loadPreset(name);
  else if (e.target.classList.contains('preset-share-btn')) sharePreset(name);
  else if (e.target.classList.contains('preset-download-btn')) downloadPreset(name);
  else if (e.target.classList.contains('preset-delete-btn')) deletePreset(name);
});

function loadPreset(name) {
  const map = loadPresetsMap();
  const preset = map[name];
  if (!preset) return;
  document.getElementById('lists').innerHTML = '';
  preset.entries.forEach((e) => addRow(e.name, e.url, e.type, e.enabled, e.group, e.id));
  renumber();
  checkAllDuplicateUrls();
  saveState();
  renderChannelMergeList();
}

function sharePreset(name) {
  const map = loadPresetsMap();
  const preset = map[name];
  if (!preset) return;
  const jsonStr = JSON.stringify({ entries: preset.entries }, null, 2);
  navigator.clipboard.writeText(jsonStr).then(() => {
    alert('"' + name + '" copied to your clipboard as JSON -- paste it into the Backup/Restore box above (on this device or another) to import it.');
  }).catch(() => {
    prompt('Copy this preset\\'s JSON:', jsonStr);
  });
}

function deletePreset(name) {
  if (!confirm('Delete preset "' + name + '"?')) return;
  const map = loadPresetsMap();
  delete map[name];
  savePresetsMap(map);
  renderPresetsList();
  schedulePresetsSync();
}

// --- file download/upload (Backup/Restore and My Presets) -------------------
//
// Shared by both the whole-setup Backup/Restore panel and individual
// presets -- same underlying JSON shape as exportConfigJson/importConfigJson,
// just written to/read from an actual file instead of a textarea, for
// people who'd rather drag a file into a folder than copy-paste text.
function downloadJsonFile(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Reads a chosen file as text and hands it to onParsed(jsonData); shared
// error handling (bad file, invalid JSON) so each upload button only needs
// to say what to do once parsing succeeds. Always clears the file input
// afterward so choosing the same filename again still fires a change event.
function readJsonFile(input, onParsed) {
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try {
      data = JSON.parse(reader.result);
    } catch (e) {
      alert('That file is not valid JSON.');
      input.value = '';
      return;
    }
    onParsed(data, file);
    input.value = '';
  };
  reader.onerror = () => {
    alert('Could not read that file.');
    input.value = '';
  };
  reader.readAsText(file);
}

function downloadConfigJson() {
  const entries = collectEntries();
  if (!entries.length) {
    alert('Add at least one list first.');
    return;
  }
  const keys = collectKeys();
  const payload = { entries };
  if (keys.mdblistKey) payload.mdblistKey = keys.mdblistKey;
  if (keys.traktKey) payload.traktKey = keys.traktKey;
  if (keys.traktUsername) payload.traktUsername = keys.traktUsername;
  if (keys.traktAccessToken) payload.traktAccessToken = keys.traktAccessToken;
  downloadJsonFile('my-lists-config.json', payload);
}

function uploadConfigFile(input) {
  readJsonFile(input, (data) => applyImportedConfig(data));
}

function downloadPreset(name) {
  const map = loadPresetsMap();
  const preset = map[name];
  if (!preset) return;
  downloadJsonFile((slugify(name) || 'preset') + '.json', { entries: preset.entries });
}

function uploadPresetFile(input) {
  readJsonFile(input, (data, file) => {
    if (!data || !Array.isArray(data.entries)) {
      alert('That file does not look like a preset -- expected an "entries" array.');
      return;
    }
    const suggested = (file.name || 'Preset').replace(/\.json$/i, '');
    const name = (prompt('Save this preset as:', suggested) || '').trim();
    if (!name) return;
    const map = loadPresetsMap();
    map[name] = { entries: data.entries };
    savePresetsMap(map);
    renderPresetsList();
    schedulePresetsSync();
  });
}

// --- browser-storage persistence -------------------------------------------
// Keeps whatever the person has added/removed/toggled so a page refresh
// doesn't lose their in-progress list or entered API keys. The stored state
// is only used in the browser; it is never uploaded anywhere.
const STORAGE_KEY = 'myListAddon:state';

function saveState() {
  if (suppressSave) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      entries: collectEntries(),
      keys: collectKeys(),
    }));
  } catch (e) {
    // localStorage unavailable (private browsing, disabled, etc.) — fine,
    // just means refreshes won't be remembered.
  }
  scheduleCreatorSyncSave();
}

function loadSavedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      keys: parsed.keys && typeof parsed.keys === 'object' ? parsed.keys : {},
    };
  } catch (e) {
    return null;
  }
}

function copyLink(url) {
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.getElementById('copyBtn');
    if (btn) { const old = btn.textContent; btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = old, 1500); }
  }).catch(() => alert(url));
}

async function generate() {
  const entries = collectEntries();
  if (!entries.length) { alert('Add at least one list.'); return; }
  const keys = collectKeys();

  const box = document.getElementById('result');
  box.style.display = 'block';
  box.innerHTML = '<p><small>Generating link\u2026</small></p>';

  // Prefer a short, KV-backed id (see /api/save) so the install URL stays a
  // fixed short length no matter how many lists are configured. If this
  // Worker has no CONFIGS KV namespace bound, fall back to the old
  // self-contained base64 link.
  let config = null;
  try {
    const res = await fetch(ORIGIN + '/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entries, mdblistKey: keys.mdblistKey, traktKey: keys.traktKey, traktUsername: keys.traktUsername, traktAccessToken: keys.traktAccessToken,
        track: keys.track, trackCreatorName: keys.trackCreatorName, trackCreatorKey: keys.trackCreatorKey,
      }),
    });
    const data = await res.json();
    if (data.ok) config = data.id;
  } catch (e) {
    // network error — fall through to the client-side link below
  }

  let sizeWarning = '';
  if (!config) {
    config = buildConfig(entries, keys);
    // Row count alone misses this: a single Channel with a few dozen
    // episodes can make the encoded config huge even with just one or two
    // rows total, so this checks the actual encoded length instead.
    if (config.length > 4000) {
      sizeWarning = '<p class="testresult err">\u26a0 This link encodes everything directly into the URL (no server-side storage is set up on this Worker), so it\\'s long and may fail to install in apps with URL-length limits \u2014 including wako. If you\\'re the Worker owner, binding a KV namespace named "CONFIGS" fixes this by giving links a short id instead.</p>';
    }
  }

  const installUrl = ORIGIN + '/' + config + '/manifest.json';
  const stremioUrl = 'stremio://' + installUrl.replace(/^https?:\\/\\//, '');
  const wakoUrl = 'wako://' + installUrl.replace(/^https?:\\/\\//, '');
  // A group breakdown alongside the plain install-count beacon -- each
  // row's own .group ("MDBList Charts", "Custom Lists", "Channels", etc.)
  // is already a meaningful "what kind of source is this" label, no need
  // for a separate classification step. Tied to install-link generation
  // specifically rather than every add/remove click, since "ended up in a
  // real install" is a more meaningful signal than "was clicked once,
  // maybe removed a second later" -- and it means this doesn't need
  // touching dozens of individual Quick Add button handlers.
  const groupCounts = {};
  entries.forEach((e) => {
    const g = e.group || 'Custom';
    groupCounts[g] = (groupCounts[g] || 0) + 1;
  });
  fetch(ORIGIN + '/api/track-install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groups: groupCounts }),
  }).catch(() => {});

  box.innerHTML = \`
    \${sizeWarning}
    <a class="installlink" href="\${installUrl}" id="manifestLink">\${installUrl}</a>
    <div class="actions">
      <button class="btn-copy secondary" id="copyBtn" onclick="copyLink('\${installUrl}')">Copy link</button>
      <a class="btn-stremio" href="\${stremioUrl}">Open in Stremio</a>
      <a class="btn-wako" href="\${wakoUrl}">Open in wako</a>
    </div>
    <p class="hint"><small>If "Open in wako" doesn't do anything on your device, wako may not register a URL scheme yet &mdash; copy the link instead and paste it into wako &rarr; Settings &gt; Extensions &gt; Install an add-on.</small></p>\`;
  // The mobile sticky CTA bar can be tapped from anywhere on a long page of
  // rows, so bring the result into view rather than leaving it rendered
  // off-screen above the fold the person's currently scrolled past.
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// pre-fill
suppressSave = true;
const serverEntries = (${initialEntriesJson});
if (serverEntries.length) {
  // Opened via a real install/configure link — this is the source of truth.
  serverEntries.forEach(e => addRow(e.name, e.url, e.type, e.enabled, e.group, e.id));
} else {
  // Fresh visit to the plain builder page — restore whatever was left off
  // last time, if anything was saved.
  const saved = loadSavedState();
  if (saved && Array.isArray(saved.entries) && saved.entries.length) {
    saved.entries.forEach(e => addRow(e.name, e.url, e.type, e.enabled, e.group, e.id));
  }
  if (saved && saved.keys && saved.keys.mdblistKey) {
    document.getElementById('mdblistKeyInput').value = saved.keys.mdblistKey;
  }
  if (saved && saved.keys && saved.keys.traktKey) {
    document.getElementById('traktKeyInput').value = saved.keys.traktKey;
  }
  if (saved && saved.keys && saved.keys.traktUsername) {
    document.getElementById('traktUsernameInput').value = saved.keys.traktUsername;
  }
  if (saved && saved.keys && saved.keys.traktAccessToken) {
    traktAccessToken = saved.keys.traktAccessToken;
  }
}
// Trakt's OAuth connection is local, per-browser state -- unlike the
// catalog entries above (which come from whatever install link opened
// this page), it was never embedded in that link and only ever lives in
// this browser's own localStorage (see disconnectTrakt/
// pickUpTraktTokenFromUrl, both of which call saveState()). Restored here
// regardless of which branch above ran, and only as a fallback (never
// overwriting a token the server already provided for this exact
// install), so a page that opened via an existing install link -- the
// common case, since it's what "refresh" usually means here -- doesn't
// lose an already-connected Trakt session just because it also happened
// to have rows preloaded from that link.
if (!traktAccessToken) {
  const savedForTrakt = loadSavedState();
  if (savedForTrakt && savedForTrakt.keys && savedForTrakt.keys.traktAccessToken) {
    traktAccessToken = savedForTrakt.keys.traktAccessToken;
  }
}
suppressSave = false;
renumber();
renderPresetsList();
renderChannelMergeList();
scheduleMyMdblistListsRefresh();
scheduleMyTraktListsRefresh();
renderCreatorProfileBar();
renderAccountKeySection();
renderTrackPlaybackSection();
renderCreatorDashboard();
pickUpTraktTokenFromUrl();
renderTraktConnectStatus();
document.querySelectorAll('details.panel.collapsible').forEach((d) => {
  d.addEventListener('toggle', scheduleCreatorSyncSave);
});
restoreActiveTab();
tryAutoRestoreCreatorProfile();

// Deep-link support for the list-details/item-details full pages (see
// openListDetailsPage in 23_client-list-management.js and
// openItemDetailsModal in 19_client-search-and-likes.js) -- both push a
// real #/list?... or #/item?... URL when opened, so a bookmark, shared
// link, or a plain page refresh lands back on that exact page instead of
// always falling back to whatever tab was last active.
(function handleInitialDeepLink() {
  if (SERVER_DEEP_LINK_LIST) {
    openListDetailsPage(SERVER_DEEP_LINK_LIST.name, SERVER_DEEP_LINK_LIST.type, SERVER_DEEP_LINK_LIST.url, SERVER_DEEP_LINK_LIST, { skipPushState: true });
    return;
  }
  const path = location.pathname || '';
  const mdbMatch = path.match(new RegExp('^/lists/mdblist/([^/]+)/([^/]+)', 'i'));
  if (mdbMatch) {
    const listUrl = 'https://mdblist.com/lists/' + mdbMatch[1] + '/' + mdbMatch[2];
    const name = typeof deslugify === 'function' ? deslugify(mdbMatch[2]) : mdbMatch[2];
    openListDetailsPage(name, 'movie', listUrl, null, { skipPushState: true });
    return;
  }
  const traktMatch = path.match(new RegExp('^/lists/trakt/([^/]+)/([^/]+)', 'i'));
  if (traktMatch) {
    const listUrl = 'https://trakt.tv/users/' + traktMatch[1] + '/lists/' + traktMatch[2];
    const name = typeof deslugify === 'function' ? deslugify(traktMatch[2]) : traktMatch[2];
    openListDetailsPage(name, 'movie', listUrl, null, { skipPushState: true });
    return;
  }
  const tmdbMatch = path.match(new RegExp('^/lists/tmdb/([0-9]+)', 'i'));
  if (tmdbMatch) {
    const listUrl = 'https://www.themoviedb.org/list/' + tmdbMatch[1];
    openListDetailsPage('TMDB List ' + tmdbMatch[1], 'movie', listUrl, null, { skipPushState: true });
    return;
  }

  const hash = location.hash || '';
  if (hash.startsWith('#/list?')) {
    const params = new URLSearchParams(hash.slice('#/list?'.length));
    openListDetailsPage(params.get('name') || 'List', params.get('type') || 'movie', params.get('url') || '', null, { skipPushState: true });
  } else if (hash.startsWith('#/item?')) {
    const params = new URLSearchParams(hash.slice('#/item?'.length));
    openItemDetailsModal(params.get('id') || '', params.get('type') || 'movie', { skipPushState: true });
  }
})();

window.addEventListener('popstate', (e) => {
  const state = e.state;
  if (state && state.view === 'list') {
    openListDetailsPage(state.name, state.type, state.listUrl, null, { skipPushState: true });
  } else if (state && state.view === 'item') {
    openItemDetailsModal(state.id, state.type, { skipPushState: true });
  } else {
    if (location.pathname.startsWith('/lists/')) {
      history.replaceState({ view: 'tab', tab: window._previousTab || 'discover' }, '', '/');
    }
    const targetTab = window._previousTab || localStorage.getItem('myListAddon:activeTab') || 'discover';
    const cleanTab = (targetTab === 'list-details' || targetTab === 'item-details') ? 'discover' : targetTab;

    document.querySelectorAll('.tab-panel').forEach(function(p) {
      p.hidden = (p.getAttribute('data-tab-panel') !== cleanTab);
    });
    document.querySelectorAll('.tab-btn').forEach(function(b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === cleanTab);
    });
    document.querySelectorAll('.bottom-nav-item').forEach(function(b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === cleanTab);
    });

    const addShelfBtn = document.getElementById('headerAddShelfBtn');
    if (addShelfBtn) addShelfBtn.style.display = (cleanTab === 'catalogs' ? 'block' : 'none');
    const createListBtn = document.getElementById('headerCreateListBtn');
    if (createListBtn) createListBtn.style.display = (cleanTab === 'lists' ? 'block' : 'none');

    try {
      localStorage.setItem('myListAddon:activeTab', cleanTab);
    } catch (err) {}

    if (typeof window._previousScrollY === 'number') {
      const scrollPos = window._previousScrollY;
      setTimeout(() => {
        window.scrollTo({ top: scrollPos, behavior: 'instant' });
      }, 0);
    }
  }
});
</script>

</body>
</html>`;
}


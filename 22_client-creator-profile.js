// --- Creator Profile system --------------------------------------------------
//
// No accounts, no email, no passwords -- see the matching server-side
// comment above authenticateCreator for the security model. This is the
// entry point every "Save List" click goes through: build the list first
// (search/add/reorder/"Save as a List" above, all unchanged), then this
// button is what actually persists it somewhere with a URL, either
// activeCreator is declared globally at script start
let pendingSaveListContext = null; // { sourceRow, urlInput, payload, name } while a save modal flow is in progress
let editingCreatorListSlug = null; // set by editCreatorList() below while editing an existing Creator-owned list
let editingLocalCustomListSlug = null; // set by editLocalCustomList() below while editing an existing browser-only list
let lastLocalCustomListsData = null; // cached result of the last local-dashboard render, so Edit/Add-to-config don't need to re-read localStorage

// --- Local (browser-only) Custom Lists ----------------------------------
//
// Saving a Custom List used to require a Creator Profile -- clicking "Save
// as a List" without one popped up an explainer and blocked further
// progress until an account existed. That's gone: anyone can build and
// save Custom Lists now, signed in or not. The only real difference is
// *where* the saved list lives afterward -- a Creator Profile's lists live
// on the server (so they follow you to another browser/device); without
// one, they live here in localStorage instead, and everything else about
// the experience -- the dashboard showing your saved lists with
// Edit/Delete/Add-to-your-lists, editing one back into the picker, all of
// it -- works identically either way. There's deliberately no
// Public/Private choice for a local list the way there is for a
// Creator-owned one: without a server there's no shareable link for
// "Public" to mean anything, so a local save just saves, no modal at all.
const LOCAL_CUSTOM_LISTS_KEY = 'myListAddon:localCustomLists';

function loadLocalCustomLists() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_CUSTOM_LISTS_KEY) || '{}');
  } catch (e) {
    return {};
  }
}
function saveLocalCustomListsMap(map) {
  try {
    localStorage.setItem(LOCAL_CUSTOM_LISTS_KEY, JSON.stringify(map));
    return true;
  } catch (e) {
    // Most commonly a QuotaExceededError -- localStorage is capped
    // (~5-10MB per origin depending on browser) and every Custom List
    // lives in one combined blob under this key, so a large import (or
    // just a lot of accumulated lists already) can push a save over the
    // limit. Callers now get told about this instead of it failing
    // silently -- see saveItemsAsNewCustomList below, which used to
    // report { ok: true } here unconditionally even when this write
    // never actually landed.
    console.error('saveLocalCustomListsMap failed:', e);
    return false;
  }
}

// Saves (or re-saves, if this row already has a localSlug from a previous
// save) a Custom List row to the local store, and stamps the row's own
// payload with that slug so a later re-save or the row-level "Save List"
// button targets the same local entry instead of creating a duplicate --
// the same role creatorSlug plays for a Creator-owned list.
function saveLocalCustomList(sourceRow, urlInput, payload, name) {
  const map = loadLocalCustomLists();
  let slug = payload.localSlug;
  if (!slug || !map[slug]) {
    const base = slugify(name) || 'list';
    slug = base;
    let n = 2;
    while (map[slug]) {
      slug = base + '-' + n;
      n++;
    }
  }
  const now = Date.now();
  const existing = map[slug];
  map[slug] = {
    slug: slug,
    name: name,
    type: payload.type,
    items: payload.items,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
  };
  saveLocalCustomListsMap(map);

  const updatedPayload = Object.assign({}, payload, { localSlug: slug });
  sourceRow.outerHTML = customListSourceRowHtml('customlist:v1:' + JSON.stringify(updatedPayload));
  saveState();
  renderCreatorDashboard();
}

// Runs once, right after a brand-new account is created -- uploads every
// list from this browser's local store to the new account (as Public, the
// same default the visibility picker itself defaults to) so nothing built
// before signing up gets left behind. Any row in #lists that pointed at a
// migrated local list gets repointed at the new server copy (creatorSlug
// instead of localSlug) so a future edit or re-save targets the right
// place. Best-effort per list -- one failing (e.g. a dropped connection
// partway through) doesn't lose the others; anything that didn't migrate
// stays in the local store rather than being deleted, so it isn't lost.
async function migrateLocalCustomListsToAccount() {
  if (!activeCreator) return;
  const localMap = loadLocalCustomLists();
  // Watch History and Continue Watching are auto-generated tracking data,
  // not something anyone hand-built to share -- migrating them through
  // here would silently turn private watch history into a public server
  // list (see visibility: 'public' below) and then delete the local copy.
  // They do still get synced to the account, just privately and through
  // pushCreatorSync/loadCreatorSync's own blob instead of this endpoint --
  // that already runs right after this function returns (see
  // submitCreateProfile), so nothing here needs to push them itself.
  const AUTO_TRACKED_SLUGS = ['watch-history', 'continue-watching'];
  const slugs = Object.keys(localMap).filter((slug) => !AUTO_TRACKED_SLUGS.includes(slug));
  if (!slugs.length) return;
  const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
  let migratedCount = 0;
  let failedCount = 0;
  for (const slug of slugs) {
    const list = localMap[slug];
    try {
      const res = await fetch(ORIGIN + '/api/creator/lists/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          creatorName: activeCreator.creatorName,
          creatorKey: creatorKey,
          name: list.name,
          type: list.type,
          items: list.items,
          visibility: 'public',
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        failedCount++;
        continue;
      }
      migratedCount++;
      delete localMap[slug];
      // Repoint any row already in #lists that was built from this local
      // list so it now saves/edits against the account instead.
      document.querySelectorAll('#lists .url').forEach((urlInput) => {
        const rowPayload = parseCustomListPayloadClient(urlInput.value);
        if (!rowPayload || rowPayload.localSlug !== slug) return;
        const updatedPayload = Object.assign({}, rowPayload, {
          publishedUrl: data.url,
          creatorSlug: data.slug,
          creatorOwner: activeCreator.creatorName,
          visibility: 'public',
        });
        delete updatedPayload.localSlug;
        const sourceRow = urlInput.closest('.source-row');
        if (sourceRow) sourceRow.outerHTML = customListSourceRowHtml('customlist:v1:' + JSON.stringify(updatedPayload));
      });
    } catch (e) {
      failedCount++;
    }
  }
  saveLocalCustomListsMap(localMap);
  if (migratedCount) {
    renumber();
    checkAllDuplicateUrls();
    saveState();
    renderCreatorDashboard();
  }
  if (failedCount) {
    alert(
      migratedCount
        ? migratedCount + ' list' + (migratedCount === 1 ? '' : 's') + ' moved to your account, but ' + failedCount + ' couldn\\'t be moved -- they\\'re still saved locally, try again from this browser.'
        : 'Could not move your local lists to your account -- they\\'re still saved locally, try again from this browser.'
    );
  }
}

let lastCreatorListsData = null; // cached result of the last dashboard fetch, so Edit/Share don't need a round-trip

function showModal(innerHtml, extraClass) {
  closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'activeModalOverlay';
  overlay.innerHTML = '<div class="modal-card' + (extraClass ? ' ' + extraClass : '') + '">' + innerHtml + '</div>';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });
  document.body.appendChild(overlay);
}
function closeModal() {
  const existing = document.getElementById('activeModalOverlay');
  if (existing) existing.remove();
}

function renderCreatorProfileBar() {
  const bar = document.getElementById('creatorProfileBar');
  if (!bar) return;
  if (activeCreator) {
    bar.innerHTML =
      '<div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px;">' +
      '<div style="display:flex; align-items:center; gap:8px;">' +
      '<span class="subnav-pill active" style="margin:0; font-size:0.82rem; padding:6px 12px; cursor:pointer;" onclick="switchTab(&quot;keys&quot;)">&#x1F464; ' + escapeHtml(activeCreator.displayName) + '</span>' +
      '<button type="button" class="lc-btn" style="padding:5px 9px; font-size:0.78rem;" onclick="switchCreatorProfile()" title="Sign Out / Switch">Sign Out</button>' +
      '</div>' +
      '<a href="https://buymeacoffee.com/brock25" target="_blank" rel="noopener" style="font-size:0.8rem; color:var(--muted); text-decoration:none; font-weight:500; white-space:nowrap;">&#x2615; Buy me a coffee</a>' +
      '</div>';
  } else {
    bar.innerHTML =
      '<div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px;">' +
      '<div style="display:flex; align-items:center; gap:6px;">' +
      '<button type="button" class="lc-btn primary" onclick="openCreateProfileModal()" style="padding:6px 12px; font-size:0.82rem; font-weight:700;">+ Create Account</button>' +
      '<button type="button" class="lc-btn" onclick="openRestoreModal()" style="padding:6px 12px; font-size:0.82rem;">Restore</button>' +
      '</div>' +
      '<a href="https://buymeacoffee.com/brock25" target="_blank" rel="noopener" style="font-size:0.8rem; color:var(--muted); text-decoration:none; font-weight:500; white-space:nowrap;">&#x2615; Buy me a coffee</a>' +
      '</div>';
  }
}

// Lives in Settings -> Keys & Account
function renderAccountKeySection() {
  const box = document.getElementById('accountKeySection');
  if (!box) return;
  if (!activeCreator) {
    box.innerHTML =
      '<p style="margin:0 0 10px; color:var(--muted); font-size:0.85rem;">Save and sync your lists, channels, presets, likes, and settings across all your devices automatically. No email or password needed &mdash; just a username and key.</p>' +
      '<div class="actions" style="flex-direction:row; width:auto; gap:8px; flex-wrap:wrap; margin-top:12px;">' +
      '<button type="button" class="primary" onclick="openCreateProfileModal()">Create Free Account</button>' +
      '<button type="button" class="secondary" onclick="openRestoreModal()">Restore Existing Account</button>' +
      '</div>';
    return;
  }
  const key = localStorage.getItem('myListAddon:creatorKey') || '';
  box.innerHTML =
    '<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; flex-wrap:wrap; gap:8px;">' +
    '<div>' +
    '<span style="font-size:0.75rem; text-transform:uppercase; letter-spacing:0.5px; color:var(--muted); font-weight:700;">Signed in as</span>' +
    '<h3 style="margin:2px 0 0; font-size:1.1rem; font-weight:800; color:var(--text);">&#x1F464; ' + escapeHtml(activeCreator.displayName) + '</h3>' +
    '</div>' +
    '<button type="button" class="secondary lc-btn" onclick="switchCreatorProfile()">Sign Out / Switch</button>' +
    '</div>' +
    '<p style="margin:0 0 4px;"><small>Account Key</small></p>' +
    '<div class="creator-key-display" id="accountKeyDisplay">' + '\u2022'.repeat(Math.max(8, key.length)) + '</div>' +
    '<div class="actions" style="flex-direction:row; width:auto; gap:8px; flex-wrap:wrap; margin-top:10px;">' +
    '<button type="button" class="secondary" id="accountKeyToggleBtn" onclick="toggleAccountKeyVisibility()">Show Key</button>' +
    '<button type="button" class="secondary" onclick="copyAccountKey()">Copy Key</button>' +
    '</div>' +
    '<p style="margin-top:10px;"><small>Anyone with this key can sign in as you and edit your lists &mdash; keep it somewhere safe, and don\\'t share it.</small></p>';
}

function toggleAccountKeyVisibility() {
  const display = document.getElementById('accountKeyDisplay');
  const btn = document.getElementById('accountKeyToggleBtn');
  if (!display || !btn) return;
  const key = localStorage.getItem('myListAddon:creatorKey') || '';
  const isHidden = btn.textContent === 'Show Key';
  if (isHidden) {
    display.textContent = key;
    btn.textContent = 'Hide Key';
  } else {
    display.textContent = '\u2022'.repeat(Math.max(8, key.length));
    btn.textContent = 'Show Key';
  }
}

// "Auto-track playback" panel on Settings -- see buildManifest's comment
// (05_catalog-core.js) for the full mechanism this powers. Requires a
// Creator Profile: a bare Stremio/wako request has no cookies and no
// login of its own, so the only way the server-side handler for it knows
// whose Watch History to update is whatever's baked into the install
// link itself -- and a Creator Profile's Watch History is the only kind
// that persists anywhere outside a single browser for that link to
// point at in the first place.
function renderTrackPlaybackSection() {
  const box = document.getElementById('trackPlaybackSection');
  if (!box) return;
  if (!activeCreator) {
    box.innerHTML = '<p><small>Sign in to a Creator Profile above to turn this on \u2014 without one, there\u2019s no account on file for a bare Stremio/wako request to update.</small></p>';
    return;
  }
  let enabled = false;
  try { enabled = localStorage.getItem('myListAddon:trackPlayback') === '1'; } catch (e) {}
  box.innerHTML =
    '<label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:0.92rem;">' +
      '<input type="checkbox" id="trackPlaybackCheck" ' + (enabled ? 'checked' : '') + ' onchange="onTrackPlaybackToggle(this)">' +
      '<span>Enabled</span>' +
    '</label>' +
    '<p style="margin-top:8px;"><small>Takes effect on your next install link \u2014 generate a fresh one from Configure &amp; Install after turning this on or off.</small></p>' +
    '<div id="trackPlaybackStatus" style="margin-top:10px;"></div>';
  if (enabled) refreshTrackPlaybackStatus();
}

function onTrackPlaybackToggle(cb) {
  try { localStorage.setItem('myListAddon:trackPlayback', cb.checked ? '1' : '0'); } catch (e) {}
  if (typeof saveState === 'function') saveState();
  if (typeof scheduleCreatorSyncSave === 'function') scheduleCreatorSyncSave();
  if (cb.checked) {
    refreshTrackPlaybackStatus();
  } else {
    const statusBox = document.getElementById('trackPlaybackStatus');
    if (statusBox) statusBox.innerHTML = '';
  }
}

async function refreshTrackPlaybackStatus() {
  const statusBox = document.getElementById('trackPlaybackStatus');
  if (!statusBox || !activeCreator) return;
  const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
  statusBox.innerHTML = '<small>Checking last ping\u2026</small>';
  try {
    const res = await fetch(ORIGIN + '/api/creator/track-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creatorName: activeCreator.creatorName, creatorKey: creatorKey }),
    });
    const data = await res.json();
    if (!data.ok || !data.lastPingAt) {
      statusBox.innerHTML = '<small>No ping received yet. If you\u2019ve played something in Stremio/wako since installing with this on and it still says that, the subtitle-request hook likely isn\u2019t firing for that app/platform \u2014 that would mean this approach doesn\u2019t work there, not that it\u2019s just slow.</small>';
      return;
    }
    const when = new Date(data.lastPingAt).toLocaleString();
    statusBox.innerHTML = '<small>Last ping: ' + escapeHtml(when) + ' \u2014 id: <code>' + escapeHtml(data.lastPingId || '') + '</code>, matched: ' + escapeHtml(data.matched || 'unknown') + '</small>';
  } catch (e) {
    statusBox.innerHTML = '<small>Could not check status right now.</small>';
  }
}

function copyAccountKey() {
  const key = localStorage.getItem('myListAddon:creatorKey') || '';
  if (!key) return;
  navigator.clipboard.writeText(key).then(() => {
    alert('Key copied to your clipboard.');
  }).catch(() => {
    prompt('Copy your Key:', key);
  });
}

function switchCreatorProfile() {
  activeCreator = null;
  editingCreatorListSlug = null;
  lastCreatorListsData = null;
  localStorage.removeItem('myListAddon:creatorName');
  localStorage.removeItem('myListAddon:creatorKey');
  renderCreatorProfileBar();
  renderAccountKeySection();
  renderTrackPlaybackSection();
  renderCreatorDashboard();
}

function openRestoreModal() {
  showModal(
    '<button type="button" class="modal-close-x" onclick="closeModal()">\u2715</button>' +
    '<h2>Restore Account</h2>' +
    '<p class="modal-sub">Enter your Username and Account Key to restore and sync your lists.</p>' +
    '<div class="row"><input type="text" id="restoreNameInput" placeholder="Username"></div>' +
    '<div class="row" style="margin-top:8px;"><input type="text" id="restoreKeyInput" placeholder="Key (e.g. MYL-XXXX-XXXX-XXXX)"></div>' +
    '<div id="restoreModalError"></div>' +
    '<div class="actions" style="margin-top:14px;">' +
    '<button type="button" class="primary" onclick="submitRestoreProfile()">Restore Account</button>' +
    '<button type="button" class="secondary" onclick="closeModal(); openCreateProfileModal();">Need an account? Create one</button>' +
    '</div>'
  );
}

async function submitRestoreProfile() {
  const name = document.getElementById('restoreNameInput').value.trim();
  const key = document.getElementById('restoreKeyInput').value.trim();
  const errBox = document.getElementById('restoreModalError');
  if (!name || !key) {
    errBox.innerHTML = '<p class="testresult err">Enter both your Username and Key.</p>';
    return;
  }
  try {
    const res = await fetch(ORIGIN + '/api/creator/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creatorName: name, creatorKey: key }),
    });
    const data = await res.json();
    if (!data.ok) {
      errBox.innerHTML = '<p class="testresult err">' +
        escapeHtml(data.error === 'no-kv' ? 'This Worker has no CONFIGS KV namespace bound.' : (data.error || 'Could not restore.')) + '</p>';
      return;
    }
    activeCreator = { creatorName: data.creatorName, displayName: data.displayName };
    localStorage.setItem('myListAddon:creatorName', data.creatorName);
    localStorage.setItem('myListAddon:creatorKey', key);
    closeModal();
    renderCreatorProfileBar();
    renderAccountKeySection();
    renderTrackPlaybackSection();
    renderCreatorDashboard();
    loadCreatorSync();
  } catch (e) {
    errBox.innerHTML = '<p class="testresult err">Network error.</p>';
  }
}

// Silent on failure by design -- a browser with a stale/invalid stored key
// (e.g. the profile was somehow deleted) just falls back to logged-out
// rather than throwing an error at page load.
async function tryAutoRestoreCreatorProfile() {
  const name = localStorage.getItem('myListAddon:creatorName');
  const key = localStorage.getItem('myListAddon:creatorKey');
  if (!name || !key) return;
  try {
    const res = await fetch(ORIGIN + '/api/creator/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creatorName: name, creatorKey: key }),
    });
    const data = await res.json();
    if (data.ok) {
      activeCreator = { creatorName: data.creatorName, displayName: data.displayName };
      renderCreatorProfileBar();
      renderAccountKeySection();
      renderTrackPlaybackSection();
      renderCreatorDashboard();
      loadCreatorSync();
    }
  } catch (e) {
    // stay logged out
  }
}

// --- Site-wide account sync --------------------------------------------
//
// Derives a stable key for a collapsible panel from its own <summary>
// text rather than requiring every one of them to carry an explicit id --
// there's about 20 of these across the page already, and titles like
// "Custom Lists" or "Channels" are already unique and don't change, so
// this avoids a large, purely-mechanical HTML edit for no behavioral
// difference.
function collapsiblePanelKey(details) {
  const summary = details.querySelector('summary');
  const text = summary ? summary.textContent.trim() : '';
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'panel';
}
function collectCollapsedPanelsState() {
  const state = {};
  document.querySelectorAll('details.panel.collapsible').forEach((d) => {
    state[collapsiblePanelKey(d)] = d.open;
  });
  return state;
}
function applyCollapsedPanelsState(state) {
  if (!state || typeof state !== 'object') return;
  document.querySelectorAll('details.panel.collapsible').forEach((d) => {
    const key = collapsiblePanelKey(d);
    if (Object.prototype.hasOwnProperty.call(state, key)) d.open = !!state[key];
  });
}

let creatorSyncSaveTimer = null;
// Debounced -- reordering a list of rows, toggling several panels, or
// typing into a preset name can all fire this repeatedly in quick
// succession, and there's no need to push a request for every single one
// of those when only the last matters.
function scheduleCreatorSyncSave() {
  if (!activeCreator) return;
  if (creatorSyncSaveTimer) clearTimeout(creatorSyncSaveTimer);
  creatorSyncSaveTimer = setTimeout(pushCreatorSync, 1200);
}

// Debounced sibling of scheduleCreatorSyncSave, just for presets -- call
// this (not scheduleCreatorSyncSave) after any change to presets
// specifically (add/delete/upload -- see saveCurrentAsPreset,
// deletePreset, uploadPresetFile below). Presets travel to the server
// through pushPresetsDirectly/save-presets exclusively now; see that
// function's comment for why they were split out of the routine autosave.
let presetsSyncTimer = null;
function schedulePresetsSync() {
  if (!activeCreator) return;
  if (presetsSyncTimer) clearTimeout(presetsSyncTimer);
  presetsSyncTimer = setTimeout(() => { pushPresetsDirectly(loadPresetsMap()); }, 1200);
}

async function pushCreatorSync() {
  if (!activeCreator) return;
  const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
  if (!creatorKey) return;
  try {
    const localMap = loadLocalCustomLists();
    await fetch(ORIGIN + '/api/creator/sync/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creatorName: activeCreator.creatorName,
        creatorKey: creatorKey,
        config: collectEntries(),
        // Presets deliberately NOT included here -- they're the one piece
        // of this state that can genuinely grow large (a TV Channel's
        // "url" is its entire episode list) while everything else in this
        // payload changes far more often but stays small. Bundling both
        // together meant every single autosave re-sent and re-processed
        // the full, ever-growing presets payload, which could tip a
        // request over Cloudflare's free-plan 10ms CPU budget. See
        // pushPresetsDirectly/schedulePresetsSync and the dedicated
        // /api/creator/sync/save-presets endpoint, which now handle
        // presets on their own, only when presets actually change.
        collapsedPanels: collectCollapsedPanelsState(),
        likedLists: [...getLikedListsSet()],
        // Always the full current list, same overwrite-the-blob approach
        // as everything else synced here -- see loadCreatorSync's comment
        // for why signing in replaces local state wholesale rather than
        // merging.
        watchHistory: (localMap['watch-history'] && localMap['watch-history'].items) || [],
        continueWatching: (localMap['continue-watching'] && localMap['continue-watching'].items) || [],
        trackPlayback: localStorage.getItem('myListAddon:trackPlayback') === '1',
        // Feeds the server-side Continue Watching cron (checkForNewEpisodes
        // in 26_api-creator-and-admin-routes.js) -- see the blob comment
        // there for why both of these need to travel alongside Watch
        // History/Continue Watching rather than being derived server-side.
        fullyWatchedShowIds: [...(window._fullyWatchedShowIds || [])],
        dismissedContinueWatching: window._dismissedContinueWatching || {},
      }),
    });
  } catch (e) {
    // silently fail, it's a background sync
  }
}

// Called right after sign-in (fresh restore, auto-restore, or a brand new
// profile). A null 'data' means this account has never synced from any
// device before, so rather than wiping out whatever's already on this
// browser, that current state is adopted as-is and pushed up as the
// account's first save. A real 'data' means the opposite: signing in
// replaces this browser's local state with the account's, the same way
// signing into any other synced account would.
async function loadCreatorSync() {
  if (!activeCreator) return;
  const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
  if (!creatorKey) return;
  try {
    const res = await fetch(ORIGIN + '/api/creator/sync/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creatorName: activeCreator.creatorName, creatorKey: creatorKey }),
    });
    const data = await res.json();
    if (!data.ok) return;
    if (!data.data) {
      pushCreatorSync();
      const localPresets = loadPresetsMap();
      if (localPresets && Object.keys(localPresets).length) pushPresetsDirectly(localPresets);
      return;
    }
    const synced = data.data;
    suppressSave = true;
    document.getElementById('lists').innerHTML = '';
    if (Array.isArray(synced.config)) {
      synced.config.forEach((e) => addRow(e.name, e.url, e.type, e.enabled, e.group, e.id));
    }
    renumber();
    suppressSave = false;
    renderChannelMergeList();
    
    if (synced.presetsB64) {
      decompressBase64ToJson(synced.presetsB64).then(parsedPresets => {
        if (parsedPresets) {
          savePresetsMap(parsedPresets);
          renderPresetsList();
        }
      });
    } else if (synced.presets && typeof synced.presets === 'object') {
      savePresetsMap(synced.presets);
      renderPresetsList();
    }
    
    applyCollapsedPanelsState(synced.collapsedPanels);
    if (typeof synced.trackPlayback === 'boolean') {
      try { localStorage.setItem('myListAddon:trackPlayback', synced.trackPlayback ? '1' : '0'); } catch (e) {}
      if (typeof renderTrackPlaybackSection === 'function') renderTrackPlaybackSection();
    }
    if (Array.isArray(synced.likedLists)) {
      try {
        localStorage.setItem('myListAddon:likedLists', JSON.stringify(synced.likedLists));
      } catch (e) {
        // non-critical, see rememberLikedList's own comment
      }
    }

    // Watch History / Continue Watching -- same wholesale-replace as
    // everything else in this blob (see this function's own comment).
    // getOrCreateWatchHistoryList/getOrCreateContinueWatchingList are used
    // just to get a properly-shaped, slugged entry to overwrite the items
    // on, rather than hand-building one here and risking it drifting out
    // of sync with that shape later.
    let touchedTracking = false;
    if (Array.isArray(synced.watchHistory)) {
      const wh = getOrCreateWatchHistoryList();
      wh.items = synced.watchHistory;
      wh.updatedAt = Date.now();
      const map = loadLocalCustomLists();
      map['watch-history'] = wh;
      saveLocalCustomListsMap(map);
      window._watchedItemIds = new Set(synced.watchHistory.map((it) => String(it.id)));
      touchedTracking = true;
    }
    if (Array.isArray(synced.continueWatching)) {
      const cw = getOrCreateContinueWatchingList();
      cw.items = synced.continueWatching;
      cw.updatedAt = Date.now();
      const map = loadLocalCustomLists();
      map['continue-watching'] = cw;
      saveLocalCustomListsMap(map);
      window._inProgressShowIds = new Set(synced.continueWatching.map((it) => String(it.showId)).filter(Boolean));
      touchedTracking = true;
    }
    // Both feed the server-side Continue Watching cron and, once adopted
    // here, the exact same badge/dismissal logic Watch History and
    // Continue Watching already use client-side (see updateContinueWatching
    // and setShowFullyWatched in 21_client-custom-list-builder.js) --
    // without adopting these too, a show newly re-flagged fully-watched by
    // the cron wouldn't show its badge here until this browser happened to
    // recompute it independently, and a dismissal made on another device
    // wouldn't be respected on this one.
    if (Array.isArray(synced.fullyWatchedShowIds)) {
      window._fullyWatchedShowIds = new Set(synced.fullyWatchedShowIds.map(String));
      try {
        localStorage.setItem('myListAddon:fullyWatchedShows', JSON.stringify(synced.fullyWatchedShowIds));
      } catch (e) {
        // non-critical
      }
    }
    if (synced.dismissedContinueWatching && typeof synced.dismissedContinueWatching === 'object') {
      window._dismissedContinueWatching = synced.dismissedContinueWatching;
      try {
        localStorage.setItem('myListAddon:dismissedContinueWatching', JSON.stringify(synced.dismissedContinueWatching));
      } catch (e) {
        // non-critical
      }
    }
    // The dashboard may have already rendered (from before this fetch
    // resolved) with whatever was on this browser beforehand -- refresh it
    // now that the synced watch data has landed, or a device signing in
    // for the first time would show a stale/empty Watch History card
    // until something else happened to trigger a re-render.
    if (touchedTracking && typeof renderCreatorDashboard === 'function') renderCreatorDashboard();

    saveState();
  } catch (e) {
    // Network hiccup -- stay with whatever's already on this browser
    // rather than blocking on a retry.
  }
}

// Shared entry point into the save flow -- used both by the row-level
// "Save List" button (startSaveListFlow below) and directly by Save as a
// List, so a freshly-built list goes straight into saving instead of
// needing a separate trip down to the row below and a second click.
// Signed in -> asks Public/Private, then saves to the Creator Profile.
// Not signed in -> saves straight to this browser's local Custom Lists
// store, no modal at all (see saveLocalCustomList's own comment for why
// there's no equivalent Public/Private step for a local save).
function beginSaveListFlow(sourceRow, urlInput, name) {
  const payload = parseCustomListPayloadClient(urlInput.value);
  if (!payload) {
    alert('Could not read this list.');
    return;
  }
  if (activeCreator) {
    pendingSaveListContext = { sourceRow, urlInput, payload, name };
    openVisibilityModal();
  } else {
    saveLocalCustomList(sourceRow, urlInput, payload, name);
  }
}

// Entry point for the row-level "Save List" button (still here for lists
// that already exist as a row but haven't been through the save flow yet
// -- e.g. one loaded from a shared/backed-up config).
function startSaveListFlow(btn) {
  const sourceRow = btn.closest('.source-row');
  const urlInput = sourceRow && sourceRow.querySelector('.url');
  if (!urlInput) {
    alert('Could not read this list.');
    return;
  }
  const rowDiv = urlInput.closest('.entry');
  const name = rowDiv && rowDiv.querySelector('.name') ? rowDiv.querySelector('.name').value.trim() : '';
  if (!name) {
    alert('Name this list first (in the row above), then try again.');
    return;
  }
  beginSaveListFlow(sourceRow, urlInput, name);
}

function openCreateProfileModal() {
  showModal(
    '<button type="button" class="modal-close-x" onclick="closeModal()">\u2715</button>' +
    '<h2>Create a Free Account</h2>' +
    '<p class="modal-sub">Save and sync your custom lists, presets, and channels from any device.<br>No email. No password. Just a username and key.</p>' +
    '<div class="row"><input type="text" id="createProfileNameInput" placeholder="Choose a Username"></div>' +
    '<div id="createProfileError"></div>' +
    '<div class="actions" style="margin-top:14px;">' +
    '<button type="button" class="primary" onclick="submitCreateProfile()">Create Account</button>' +
    '<button type="button" class="secondary" onclick="closeModal(); openRestoreModal();">Already have one? Restore</button>' +
    '</div>'
  );
}

async function submitCreateProfile() {
  const name = document.getElementById('createProfileNameInput').value.trim();
  const errBox = document.getElementById('createProfileError');
  if (!name) {
    errBox.innerHTML = '<p class="testresult err">Enter a username.</p>';
    return;
  }
  try {
    const res = await fetch(ORIGIN + '/api/creator/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creatorName: name }),
    });
    const data = await res.json();
    if (!data.ok) {
      errBox.innerHTML = '<p class="testresult err">' +
        escapeHtml(data.error === 'no-kv' ? 'This Worker has no CONFIGS KV namespace bound.' : (data.error || 'Could not create profile.')) + '</p>';
      return;
    }
    activeCreator = { creatorName: data.creatorName, displayName: data.displayName };
    localStorage.setItem('myListAddon:creatorName', data.creatorName);
    localStorage.setItem('myListAddon:creatorKey', data.creatorKey);
    renderCreatorProfileBar();
    renderAccountKeySection();
    renderTrackPlaybackSection();
    showKeyRevealModal(data.displayName, data.creatorKey);
    loadCreatorSync();
    migrateLocalCustomListsToAccount();
  } catch (e) {
    errBox.innerHTML = '<p class="testresult err">Network error.</p>';
  }
}

// The Key is shown here in full the moment it's created -- it was never
// stored anywhere server-side (only its hash was), so this is the only
// time it's ever handed back in full without the person having to reveal
// it themselves. It can still be viewed again later from Settings (see
// renderKeyRevealSettingsSection), just hidden behind a click there rather
// than shown outright, so this isn't the one and only chance at it the
// way it used to be. Whether or not there's a list still waiting to be
// saved (pendingSaveListContext), "Continue" leads into the same
// visibility step next.
function showKeyRevealModal(displayName, creatorKey) {
  showModal(
    '<h2>Creator Profile Created</h2>' +
    '<p class="modal-sub" style="margin-bottom:4px;">Username</p>' +
    '<p style="margin:0 0 14px; font-weight:600;">' + escapeHtml(displayName) + '</p>' +
    '<p class="modal-sub" style="margin-bottom:4px;">Key</p>' +
    '<div class="creator-key-display" id="revealedCreatorKey">' + escapeHtml(creatorKey) + '</div>' +
    '<p class="modal-sub">Save this key somewhere safe. You\\'ll need it to edit your lists from another browser. You can view it again later from Settings.</p>' +
    '<div class="actions">' +
    '<button type="button" class="secondary" onclick="copyRevealedCreatorKey()">Copy Key</button>' +
    '<button type="button" onclick="continueAfterKeyReveal()">Continue</button>' +
    '</div>'
  );
}

function copyRevealedCreatorKey() {
  const text = document.getElementById('revealedCreatorKey').textContent;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => alert('Copied.')).catch(() => prompt('Copy this key:', text));
  } else {
    prompt('Copy this key:', text);
  }
}

function continueAfterKeyReveal() {
  closeModal();
  if (pendingSaveListContext) {
    openVisibilityModal();
  } else {
    renderCreatorDashboard();
  }
}

function openVisibilityModal() {
  const ctx = pendingSaveListContext;
  if (!ctx) return;
  showModal(
    '<button type="button" class="modal-close-x" onclick="closeModal()">\u2715</button>' +
    '<h2 style="margin-top:0; color:#001f3f;">Visibility</h2>' +
    '<div class="visibility-choice" style="display:flex; flex-direction:column; gap:16px; margin: 20px 0;">' +
    '<label style="display:flex; align-items:flex-start; gap:12px; cursor:pointer; color:#001f3f;">' +
      '<input type="radio" name="listVisibility" value="public" checked style="margin-top:4px; accent-color:#003366;">' +
      '<span style="flex:1;"><strong>Public</strong><br><small style="color:#555;">Anyone with the link can view and use this list.</small></span>' +
    '</label>' +
    '<label style="display:flex; align-items:flex-start; gap:12px; cursor:pointer; color:#001f3f;">' +
      '<input type="radio" name="listVisibility" value="private" style="margin-top:4px; accent-color:#003366;">' +
      '<span style="flex:1;"><strong>Private</strong><br><small style="color:#555;">Only you can view and edit this list after restoring your Creator Profile.</small></span>' +
    '</label>' +
    '</div>' +
    '<div style="display:flex; justify-content:flex-end;">' +
      '<button type="button" onclick="confirmSaveAsCreator()" style="background: transparent; color: #003366; font-weight: 600; border: none; padding: 8px 16px; font-size: 1rem; cursor: pointer;">Save List</button>' +
    '</div>'
  );
}

async function confirmSaveAsCreator() {
  const ctx = pendingSaveListContext;
  if (!ctx || !activeCreator) return;
  const checked = document.querySelector('input[name="listVisibility"]:checked');
  const visibility = checked ? checked.value : 'public';
  const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
  closeModal();
  try {
    const res = await fetch(ORIGIN + '/api/creator/lists/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creatorName: activeCreator.creatorName,
        creatorKey: creatorKey,
        slug: ctx.payload.creatorSlug || undefined,
        name: ctx.name,
        type: ctx.payload.type,
        items: ctx.payload.items,
        visibility: visibility,
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      alert('Could not save this list: ' + (data.error || 'unknown error'));
      return;
    }
    const updatedPayload = Object.assign({}, ctx.payload, {
      listName: ctx.name,
      publishedUrl: visibility === 'public' ? data.url : undefined,
      creatorSlug: data.slug,
      creatorOwner: activeCreator.creatorName,
      visibility: visibility,
    });
    ctx.sourceRow.outerHTML = customListSourceRowHtml('customlist:v1:' + JSON.stringify(updatedPayload));
    saveState();
    alert(
      visibility === 'private'
        ? 'Saved to your Creator Profile as a private list.'
        : 'Saved to your Creator Profile. Link:\\n' + data.url
    );
    renderCreatorDashboard();
  } catch (e) {
    alert('Network error while saving.');
  } finally {
    pendingSaveListContext = null;
  }
}

// --- Creator Dashboard ---------------------------------------------------------

async function renderCreatorDashboard() {
  const box = document.getElementById('creatorDashboard');
  if (!box) return;
  if (!activeCreator) {
    renderLocalCustomListsDashboard(box);
    return;
  }
  box.innerHTML = '<p><small>Loading your lists\u2026</small></p>';
  const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
  try {
    const res = await fetch(ORIGIN + '/api/creator/lists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creatorName: activeCreator.creatorName, creatorKey: creatorKey }),
    });
    const data = await res.json();
    if (!data.ok) {
      box.innerHTML = '<p class="testresult err">\u2717 ' + escapeHtml(data.error || 'Could not load your lists.') + '</p>';
      return;
    }
    lastCreatorListsData = data.lists;
    
    // Prune any config rows that reference a creatorSlug no longer on the server
    // (these are ghost rows left behind by previously deleted lists)
    {
      const validSlugs = new Set((data.lists || []).map(l => l.slug));
      let pruned = false;
      document.querySelectorAll('#lists .url').forEach((urlInput) => {
        const rowPayload = parseCustomListPayloadClient(urlInput.value);
        if (rowPayload && rowPayload.creatorSlug && !validSlugs.has(rowPayload.creatorSlug)) {
          const entry = urlInput.closest('.entry');
          if (entry) { entry.remove(); pruned = true; }
        }
      });
      if (pruned && typeof saveState === 'function') saveState();
    }
    
    const rowsHtml = data.lists.length
      ? data.lists.map((l) => {
          const shareBtn = l.visibility === 'private'
            ? ''
            : '<button type="button" class="lc-btn secondary creatorListShareBtn" data-url="' + escapeAttr(l.url) + '">Share</button>';
          const allPosters = (l.items || []).slice(0, 9).filter((it) => it.poster);
          const totalCount = l.itemCount || allPosters.length;
          const posterThumbs = allPosters.map((it, i) => {
            const isMobileEnd = (i === 2 && allPosters.length > 3);
            const isDesktopEnd = (i === allPosters.length - 1 && allPosters.length >= 4);
            let overlays = '';
            if (isMobileEnd) {
              overlays += '<div class="list-card-count-overlay mobile-only creatorListViewBtn" data-slug="' + escapeAttr(l.slug) + '" data-name="' + escapeAttr(l.name) + '" data-type="' + escapeAttr(l.type) + '" style="cursor:pointer;">' + totalCount + ' &rsaquo;</div>';
            }
            if (isDesktopEnd) {
              overlays += '<div class="list-card-count-overlay desktop-only creatorListViewBtn" data-slug="' + escapeAttr(l.slug) + '" data-name="' + escapeAttr(l.name) + '" data-type="' + escapeAttr(l.type) + '" style="cursor:pointer;">' + totalCount + ' &rsaquo;</div>';
            }
            return '<div class="list-card-mini-poster-tile">' +
              '<div class="list-card-mini-poster-img-wrap">' +
                '<img src="' + escapeAttr(it.poster) + '" class="clickable-poster" data-id="' + escapeAttr(it.imdbId || it.id) + '" data-type="' + escapeAttr(l.type || 'movie') + '" alt="" loading="lazy">' +
                overlays +
              '</div>' +
              '<div class="list-card-mini-poster-name">' + escapeHtml(it.title || '') + '</div>' +
            '</div>';
          }).join('');
          return '<div class="creator-list-row list-card" data-slug="' + escapeAttr(l.slug) + '" data-list-type="' + escapeAttr(l.type || 'movie') + '">' +
            '<div class="list-card-header">' +
              '<div class="list-card-icon src-mylist">ML</div>' +
              '<div class="list-card-body">' +
                '<div class="list-card-title">' +
                  '<span class="drag-handle" draggable="true" style="cursor:grab; padding:0 6px 0 0;">\u2630</span>' +
                  escapeHtml(l.name) +
                '</div>' +
                '<div class="list-card-meta">' +
                  '<span>' + (l.visibility === 'private' ? 'Private' : 'Public') + '</span>' +
                  '<span class="list-card-meta-sep">&middot;</span>' +
                  '<span>' + (l.type === 'series' ? 'Shows' : 'Movies') + '</span>' +
                  '<span class="list-card-meta-sep">&middot;</span>' +
                  '<span>' + l.itemCount + ' items</span>' +
                  ((l.likes || 0) > 0 ? '<span class="list-card-meta-sep">&middot;</span><span>\u2665 ' + l.likes + '</span>' : '') +
                '</div>' +
              '</div>' +
              '<div class="list-card-actions">' +
                '<button type="button" class="lc-btn secondary creatorListEditBtn" data-slug="' + escapeAttr(l.slug) + '">Edit</button>' +
                '<button type="button" class="lc-btn secondary creatorListDeleteBtn" data-slug="' + escapeAttr(l.slug) + '">Delete</button>' +
                shareBtn +
                '<button type="button" class="lc-btn primary creatorListAddToConfigBtn" data-slug="' + escapeAttr(l.slug) + '">+ Add</button>' +
              '</div>' +
            '</div>' +
            (posterThumbs ? '<div class="list-card-posters poster-preview-static creatorListViewTrigger" data-slug="' + escapeAttr(l.slug) + '" data-name="' + escapeAttr(l.name) + '" data-type="' + escapeAttr(l.type) + '" style="cursor:pointer;">' + posterThumbs + '</div>' : '') +
          '</div>';
        }).join('')
      : '<p><small>No lists yet \u2014 build one under Create List to get started.</small></p>';

    // Watch History / Continue Watching never live on the server (see
    // renderAutoTrackedListsHtml) -- append them from localStorage so
    // they don't vanish just because someone's signed in. lastLocalCustomListsData
    // gets pointed at just these two so the click-delegation handlers below
    // (Edit/Delete/+Add/View) can still resolve a click on either of them
    // while lastCreatorListsData covers the server rows above.
    const autoTracked = renderAutoTrackedListsHtml();
    lastLocalCustomListsData = autoTracked.lists;

    box.innerHTML = '<div id="creatorListRows" style="margin-bottom:14px;">' + rowsHtml + autoTracked.html + '</div>';
    document.querySelectorAll('#creatorListRows .drag-handle').forEach((h) => initCreatorListTouchDrag(h));
  } catch (e) {
    box.innerHTML = '<p class="testresult err">\u2717 Network error loading your lists.</p>';
  }
}

// Local equivalent of the dashboard above -- same row layout (minus
// Share, which needs a server-hosted URL to share, and minus drag-to-
// reorder, which would need a local reordering scheme of its own; sorted
// by most-recently-updated instead). Synchronous, no fetch, since it's
// just reading localStorage.
// Builds one list-card's HTML for a local (browser-only) list -- shared by
// renderLocalCustomListsDashboard (signed out: every local list) and
// renderAutoTrackedListsHtml (signed in: just Watch History/Continue
// Watching, since those two never get migrated to a Creator Profile).
// Builds a "Show Name S03E07 Episode Name" label for a Watch History /
// Continue Watching episode entry -- both store showTitle/seasonNum/
// episodeNum alongside the raw episode name (see toggleWatchStatus,
// toggleBatchWatchStatus, and updateContinueWatching), so the season and
// episode number can always be reconstructed here instead of just showing
// the bare episode title, which on its own doesn't say which show or
// which episode it even is. Falls back to whatever name/title it has for
// movies (no season/episode) or older entries saved before this existed.
// Splits a Watch History / Continue Watching episode entry into a
// "Show Name S03E07" line and an "Episode Name" line -- both items store
// showTitle/seasonNum/episodeNum alongside the raw episode name (see
// toggleWatchStatus, toggleBatchWatchStatus, and updateContinueWatching),
// so this can always reconstruct which show/season/episode it is instead
// of just showing the bare episode title, which on its own says neither.
// Movies (no season/episode) and older entries saved before this existed
// just get a single line back, with subtitle empty.
function formatWatchItemLabel(it) {
  if (!it) return { title: '', subtitle: '' };
  if (it.showTitle && it.seasonNum != null && it.episodeNum != null) {
    const s = String(it.seasonNum).padStart(2, '0');
    const e = String(it.episodeNum).padStart(2, '0');
    return { title: it.showTitle + ' S' + s + 'E' + e, subtitle: it.name || it.title || '' };
  }
  return { title: it.title || it.name || '', subtitle: '' };
}

function buildLocalListCardHtml(l) {
  const isAutoTracked = l.slug === 'watch-history' || l.slug === 'continue-watching';
  const itemCount = (l.items || []).length;
  const allPosters = (l.items || []).slice(0, 9).filter((it) => (l.slug === 'continue-watching' && it.showPoster) ? it.showPoster : it.poster);
  const totalCount = itemCount || allPosters.length;
  const posterThumbs = allPosters.map((it, i) => {
    const isMobileEnd = (i === 2 && allPosters.length > 3);
    const isDesktopEnd = (i === allPosters.length - 1 && allPosters.length >= 4);
    let overlays = '';
    if (isMobileEnd) {
      overlays += '<div class="list-card-count-overlay mobile-only localListViewBtn" data-slug="' + escapeAttr(l.slug) + '" data-name="' + escapeAttr(l.name) + '" data-type="' + escapeAttr(l.type) + '" style="cursor:pointer;">' + totalCount + ' &rsaquo;</div>';
    }
    if (isDesktopEnd) {
      overlays += '<div class="list-card-count-overlay desktop-only localListViewBtn" data-slug="' + escapeAttr(l.slug) + '" data-name="' + escapeAttr(l.name) + '" data-type="' + escapeAttr(l.type) + '" style="cursor:pointer;">' + totalCount + ' &rsaquo;</div>';
    }
    // Watch History / Continue Watching items are keyed by episode/
    // movie id (it.id), not the imdbId/title shape a hand-built
    // Custom List item has -- fall back through both schemas, and
    // for a Continue Watching entry specifically, link the poster to
    // the show itself (it.showId) rather than the episode's own id,
    // since there's no per-episode details view to send it to.
    const posterId = it.showId || it.imdbId || it.id;
    const posterType = it.showId ? 'series' : (l.type || 'movie');
    const label = formatWatchItemLabel(it);
    // Only Continue Watching gets a remove button -- Watch History and
    // regular Custom Lists don't have a "dismiss until something changes"
    // concept the way Continue Watching's "what's next" suggestion does.
    const removeBtn = (l.slug === 'continue-watching' && it.showId)
      ? '<button type="button" class="cw-remove-btn" onclick="event.stopPropagation(); dismissContinueWatchingShow(&quot;' + escapeAttr(it.showId) + '&quot;)" title="Remove from Continue Watching">&times;</button>'
      : '';
    const itemPoster = (l.slug === 'continue-watching' && it.showPoster) ? it.showPoster : it.poster;
    return '<div class="list-card-mini-poster-tile">' +
      '<div class="list-card-mini-poster-img-wrap">' +
        '<img src="' + escapeAttr(itemPoster) + '" class="clickable-poster" data-id="' + escapeAttr(posterId) + '" data-type="' + escapeAttr(posterType) + '" alt="" loading="lazy">' +
        removeBtn +
        overlays +
      '</div>' +
      '<div class="list-card-mini-poster-name">' + escapeHtml(label.title) + '</div>' +
      (label.subtitle ? '<div class="list-card-mini-poster-subtitle">' + escapeHtml(label.subtitle) + '</div>' : '') +
    '</div>';
  }).join('');
  const typeLabel = l.type === 'series' ? 'Shows' : l.type === 'movie' ? 'Movies' : 'Mixed';
  // Watch History's own card: every poster shown here is watched by
  // definition, so the blue checkmark badge is redundant -- same
  // suppression the Live Preview shelf and "see all" modal already apply
  // via this class (see the .is-watch-history-shelf CSS rule), just not
  // previously wired up to this specific card's markup.
  const cardClass = 'list-card' + (l.slug === 'watch-history' ? ' is-watch-history-shelf' : '');
  return '<div class="' + cardClass + '" data-slug="' + escapeAttr(l.slug) + '" data-list-type="' + escapeAttr(l.type || 'movie') + '">' +
    '<div class="list-card-header">' +
      '<div class="list-card-icon src-mylist">ML</div>' +
      '<div class="list-card-body">' +
        '<div class="list-card-title">' + escapeHtml(l.name) + '</div>' +
        '<div class="list-card-meta">' +
          '<span>' + typeLabel + '</span>' +
          '<span class="list-card-meta-sep">&middot;</span>' +
          '<span>' + itemCount + ' item' + (itemCount === 1 ? '' : 's') + '</span>' +
        '</div>' +
      '</div>' +
      // Watch History and Continue Watching are auto-generated from what
      // you actually watch, not something to hand-edit or delete -- Edit
      // would desync it from _watchedItemIds (nothing would tell the
      // "watched" badge system an item was removed), and Delete doesn't
      // just clear this browser: the next background account sync push
      // (a full overwrite, not a merge) would wipe it from every
      // signed-in device too. Both stay view-only; the poster grid below
      // still works normally.
      (isAutoTracked
        ? '<div class="list-card-actions">' +
            '<span style="font-size:0.78rem; color:var(--muted); white-space:nowrap; margin-right:8px;">Auto-tracked</span>' +
            '<button type="button" class="lc-btn primary localListAddToConfigBtn" data-slug="' + escapeAttr(l.slug) + '">+ Add</button>' +
          '</div>'
        : '<div class="list-card-actions">' +
            '<button type="button" class="lc-btn secondary localListEditBtn" data-slug="' + escapeAttr(l.slug) + '">Edit</button>' +
            '<button type="button" class="lc-btn secondary localListDeleteBtn" data-slug="' + escapeAttr(l.slug) + '">Delete</button>' +
            '<button type="button" class="lc-btn primary localListAddToConfigBtn" data-slug="' + escapeAttr(l.slug) + '">+ Add</button>' +
          '</div>') +
    '</div>' +
    (posterThumbs ? '<div class="list-card-posters poster-preview-static localListViewTrigger" data-slug="' + escapeAttr(l.slug) + '" data-name="' + escapeAttr(l.name) + '" data-type="' + escapeAttr(l.type) + '" style="cursor:pointer;">' + posterThumbs + '</div>' : '') +
  '</div>';
}

// Backfills a slug onto Watch History / Continue Watching entries saved by
// an older version of this addon before they carried one -- without it,
// the dashboard's View/Edit/Delete/+Add buttons can't match a click back
// to the right entry. Same patch getOrCreateWatchHistoryList /
// getOrCreateContinueWatchingList apply on write; this covers the
// read-only path where someone opens this tab without touching either
// list first.
function backfillAutoTrackedListSlugs(map) {
  let patched = false;
  ['watch-history', 'continue-watching'].forEach((key) => {
    if (map[key] && !map[key].slug) {
      map[key].slug = key;
      patched = true;
    }
  });
  if (patched) saveLocalCustomListsMap(map);
}

// Watch History and Continue Watching are always local -- generated by
// this browser as you watch things, and deliberately never uploaded to a
// Creator Profile the way an ordinary saved Custom List is (turning your
// private watch history into a public server list on sign-up would be a
// bad surprise). That means the signed-in dashboard below, which replaces
// this panel with server data, would otherwise make them disappear the
// moment someone signs in -- this renders them from localStorage
// regardless of sign-in state so they can be appended alongside whatever
// else the panel is showing.
function renderAutoTrackedListsHtml() {
  const map = loadLocalCustomLists();
  backfillAutoTrackedListSlugs(map);
  const lists = ['watch-history', 'continue-watching'].map((key) => map[key]).filter(Boolean);
  return { html: lists.map(buildLocalListCardHtml).join(''), lists: lists };
}

function renderLocalCustomListsDashboard(box) {
  const map = loadLocalCustomLists();
  backfillAutoTrackedListSlugs(map);

  const lists = Object.keys(map)
    .map((k) => map[k])
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  lastLocalCustomListsData = lists;
  const rowsHtml = lists.length
    ? lists.map(buildLocalListCardHtml).join('')
    : '<p><small>No lists yet \u2014 build one under Create List to get started.</small></p>';
  box.innerHTML = '<div id="creatorListRows" style="margin-bottom:14px;">' + rowsHtml + '</div>';
}


const _creatorDashEl = document.getElementById('creatorDashboard');
if (_creatorDashEl) {
  _creatorDashEl.addEventListener('click', async (e) => {
    if (e.target.closest('.clickable-poster')) return;
    const viewBtn = e.target.closest('.creatorListViewBtn, .localListViewBtn, .creatorListViewTrigger, .localListViewTrigger');
  if (viewBtn) {
    const slug = viewBtn.dataset.slug;
    const pool = (viewBtn.classList.contains('localListViewBtn') || viewBtn.classList.contains('localListViewTrigger')) ? lastLocalCustomListsData : lastCreatorListsData;
    const list = (pool || []).filter((l) => l.slug === slug)[0];
    const sample = list ? (list.items || []).map((it) => {
      const label = formatWatchItemLabel(it);
      return {
        // Watch History / Continue Watching items store the episode's own
        // id, not the show's -- there's no per-episode details view, so
        // point the poster at the show instead (same fallback used for the
        // dashboard's own mini-poster thumbnails above).
        id: it.showId || it.imdbId || it.id,
        type: it.showId ? 'series' : (list.type || 'movie'),
        name: label.title,
        subtitle: label.subtitle,
        poster: (list.slug === 'continue-watching' && it.showPoster) ? it.showPoster : it.poster,
        year: it.year,
        // Only Continue Watching's own grid gets a remove button -- see
        // buildLocalListCardHtml's matching comment for why.
        removeShowId: (list.slug === 'continue-watching' && it.showId) ? it.showId : null,
      };
    }) : [];
    openListPreviewModal(viewBtn.dataset.name, viewBtn.dataset.type, '', { sample: sample, maybeMore: false });
    return;
  }
  const shareBtn = e.target.closest('.creatorListShareBtn');
  if (shareBtn) {
    const listUrl = shareBtn.dataset.url;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(listUrl).then(() => alert("Link copied: " + listUrl)).catch(() => prompt("Share this link:", listUrl));
    } else {
      prompt("Share this link:", listUrl);
    }
    return;
  }
  const deleteBtn = e.target.closest('.creatorListDeleteBtn');
  if (deleteBtn) {
    const slug = deleteBtn.dataset.slug;
    if (!confirm("Delete this list? This cannot be undone.")) return;
    const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
    try {
      const res = await fetch(ORIGIN + '/api/creator/lists/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ creatorName: activeCreator.creatorName, creatorKey: creatorKey, slug: slug }),
      });
      const data = await res.json();
      if (!data.ok) {
        alert('Could not delete: ' + (data.error || 'unknown error'));
        return;
      }
      
      // Remove from main lists config if present
      document.querySelectorAll('#lists .url').forEach((urlInput) => {
        const rowPayload = parseCustomListPayloadClient(urlInput.value);
        if (rowPayload && (rowPayload.creatorSlug === slug || rowPayload.slug === slug)) {
          const entry = urlInput.closest('.entry');
          if (entry) {
            entry.remove();
            if (typeof saveState === 'function') saveState();
          }
        }
      });
      
      renderCreatorDashboard();
    } catch (err) {
      alert('Network error while deleting.');
    }
    return;
  }
  const editBtn = e.target.closest('.creatorListEditBtn');
  if (editBtn) {
    editCreatorList(editBtn.dataset.slug);
    return;
  }
  const addToConfigBtn = e.target.closest('.creatorListAddToConfigBtn');
  if (addToConfigBtn) {
    const slug = addToConfigBtn.dataset.slug;
    const listMeta = (lastCreatorListsData || []).find((l) => l.slug === slug);
    if (!listMeta) {
      alert('Could not find that list -- try refreshing.');
      return;
    }
    const payload = { listId: generateChannelId(), type: listMeta.type, items: listMeta.items || [], shuffle: false };
    addRow(listMeta.name, 'customlist:v1:' + JSON.stringify(payload), listMeta.type, true, 'Custom Lists');
    addToConfigBtn.disabled = true;
    addToConfigBtn.textContent = 'Added \u2713';
    return;
  }
  const localEditBtn = e.target.closest('.localListEditBtn');
  if (localEditBtn) {
    const editSlug = localEditBtn.dataset.slug;
    // Defense in depth -- these buttons no longer render for Watch
    // History/Continue Watching (see buildLocalListCardHtml), but guard
    // here too in case anything else ever calls this. Editing one by hand
    // would desync it from _watchedItemIds, since nothing would tell the
    // "watched" badge system an item was removed.
    if (editSlug === 'watch-history' || editSlug === 'continue-watching') return;
    editLocalCustomList(editSlug);
    return;
  }
  const localDeleteBtn = e.target.closest('.localListDeleteBtn');
  if (localDeleteBtn) {
    const slug = localDeleteBtn.dataset.slug;
    // Same as above -- deleting either of these doesn't just clear this
    // browser, it also wipes them from every signed-in device on the next
    // background account sync (a full overwrite, not a merge).
    if (slug === 'watch-history' || slug === 'continue-watching') return;
    if (!confirm("Delete this list? This cannot be undone.")) return;
    const map = loadLocalCustomLists();
    delete map[slug];
    saveLocalCustomListsMap(map);
    
    // Remove from main lists config if present
    document.querySelectorAll('#lists .url').forEach((urlInput) => {
      const rowPayload = parseCustomListPayloadClient(urlInput.value);
      if (rowPayload && rowPayload.localSlug === slug) {
        const entry = urlInput.closest('.entry');
        if (entry) entry.remove();
      }
    });
    if (typeof saveState === 'function') saveState();
    
    renderCreatorDashboard();
    return;
  }
  const localAddToConfigBtn = e.target.closest('.localListAddToConfigBtn');
  if (localAddToConfigBtn) {
    const slug = localAddToConfigBtn.dataset.slug;
    const listMeta = (lastLocalCustomListsData || []).find((l) => l.slug === slug);
    if (!listMeta) {
      alert('Could not find that list -- try refreshing.');
      return;
    }
    
    const items = listMeta.items || [];
    
    if (listMeta.type === 'mixed' || slug === 'watch-history' || slug === 'continue-watching') {
      const movies = [];
      const series = [];
      
      items.forEach(it => {
        const isMovie = it.kind === 'movie' || it.type === 'movie';
        const mapped = {
          imdbId: isMovie ? (it.imdbId || it.id) : (it.showId || it.imdbId || it.id),
          title: isMovie ? (it.title || it.name) : (it.showTitle || it.title || it.name),
          poster: isMovie ? it.poster : (it.showPoster || it.poster),
          year: it.year
        };
        
        if (isMovie) {
          movies.push(mapped);
        } else {
          // Keep only one entry per show in the catalog
          if (!series.some(s => s.imdbId === mapped.imdbId)) {
            series.push(mapped);
          }
        }
      });
      
      if (movies.length > 0) {
        const url = activeCreator && (slug === 'watch-history' || slug === 'continue-watching')
          ? 'autotrack:' + slug + ':movie:' + activeCreator.normalized
          : 'customlist:v1:' + JSON.stringify({ listId: generateChannelId(), localSlug: slug, type: 'movie', items: movies, shuffle: false });
        addRow(listMeta.name + (series.length > 0 ? ' (Movies)' : ''), url, 'movie', true, 'My Lists');
      }
      if (series.length > 0 || movies.length === 0) {
        const url = activeCreator && (slug === 'watch-history' || slug === 'continue-watching')
          ? 'autotrack:' + slug + ':series:' + activeCreator.normalized
          : 'customlist:v1:' + JSON.stringify({ listId: generateChannelId(), localSlug: slug, type: 'series', items: series, shuffle: false });
        addRow(listMeta.name + (movies.length > 0 ? ' (Shows)' : ''), url, 'series', true, 'My Lists');
      }
    } else {
      const payload = { listId: generateChannelId(), localSlug: slug, type: listMeta.type, items: items, shuffle: false };
      addRow(listMeta.name, 'customlist:v1:' + JSON.stringify(payload), listMeta.type, true, 'My Lists');
    }
    
    localAddToConfigBtn.disabled = true;
    localAddToConfigBtn.textContent = 'Added \u2713';
  }
});
}

function editCreatorList(slug) {
  const listMeta = (lastCreatorListsData || []).find((l) => l.slug === slug);
  if (!listMeta) {
    alert('Could not find that list -- try refreshing.');
    return;
  }
  customListDraftItems = (listMeta.items || []).slice();
  customListDraftType = listMeta.type;
  editingCreatorListSlug = slug;
  editingCustomListUrlInput = null;
  document.getElementById('customListNameInput').value = listMeta.name;
  document.getElementById('customListSearchType').value = listMeta.type === 'series' ? 'tv' : 'movie';
  const visSelect = document.getElementById('customListVisibilitySelect');
  if (visSelect) visSelect.value = listMeta.visibility === 'private' ? 'private' : 'public';
  renderCustomListDraftList();
  updateCustomListSaveButtonLabel();
  switchTab('lists');
  // Create List has no pill of its own in #listsSubnavBar (it's only ever
  // reached via a list's Edit button, not a tab click), so there's no
  // correct button to highlight here -- passing none leaves every pill
  // unhighlighted instead of the wrong one lighting up. Previously this
  // grabbed whichever pill happened to be 5th, which meant "Find Lists"
  // would light up while looking at the Create List panel instead of Find
  // Lists as soon as anything else got added to the pill bar and shifted
  // that position.
  if (typeof switchListsSubmenu === 'function') switchListsSubmenu('create-list');
  const panel = document.getElementById('listsSubCreateList');
  if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Local equivalent of editCreatorList above.
function editLocalCustomList(slug) {
  const map = loadLocalCustomLists();
  const listMeta = map[slug];
  if (!listMeta) {
    alert('Could not find that list -- try refreshing.');
    return;
  }
  customListDraftItems = (listMeta.items || []).slice();
  customListDraftType = listMeta.type;
  editingLocalCustomListSlug = slug;
  editingCreatorListSlug = null;
  editingCustomListUrlInput = null;
  document.getElementById('customListNameInput').value = listMeta.name;
  document.getElementById('customListSearchType').value = listMeta.type === 'series' ? 'tv' : 'movie';
  renderCustomListDraftList();
  updateCustomListSaveButtonLabel();
  switchTab('lists');
  // Same reasoning as editCreatorList above -- Create List has no pill of
  // its own to correctly highlight.
  if (typeof switchListsSubmenu === 'function') switchListsSubmenu('create-list');
  const panel = document.getElementById('listsSubCreateList');
  if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Drag-to-reorder for the Dashboard's own list of lists -- same live-DOM-
// reorder-then-persist technique used for the picks draft above, just
// keyed by data-slug instead of a data-idx into a local array, since the
// "array" here is the server's own persisted order.
let creatorListDragRow = null;

function getCreatorListDragAfterElement(container, y) {
  const els = [...container.querySelectorAll('.creator-list-row:not(.dragging)')];
  return els.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) return { offset: offset, element: child };
    return closest;
  }, { offset: -Infinity, element: null }).element;
}

async function persistCreatorListOrderFromDom() {
  const container = document.getElementById('creatorListRows');
  if (!container) return;
  const order = [...container.querySelectorAll('.creator-list-row')].map((row) => row.dataset.slug);
  const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
  try {
    await fetch(ORIGIN + '/api/creator/lists/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creatorName: activeCreator.creatorName, creatorKey: creatorKey, order: order }),
    });
  } catch (e) {
    // A failed reorder save just means it reverts to server order next
    // load -- not worth interrupting with an error for a drag-and-drop.
  }
}

function initCreatorListTouchDrag(handle) {
  if (!handle) return;
  handle.addEventListener('dragstart', (e) => {
    creatorListDragRow = handle.closest('.creator-list-row');
    creatorListDragRow.classList.add('dragging');
  });
  document.addEventListener('dragover', (e) => {
    if (!creatorListDragRow) return;
    const container = document.getElementById('creatorListRows');
    if (!container) return;
    e.preventDefault();
    const afterEl = getCreatorListDragAfterElement(container, e.clientY);
    if (afterEl == null) container.appendChild(creatorListDragRow);
    else if (afterEl !== creatorListDragRow) container.insertBefore(creatorListDragRow, afterEl);
  });
  handle.addEventListener('dragend', () => {
    if (creatorListDragRow) creatorListDragRow.classList.remove('dragging');
    creatorListDragRow = null;
    persistCreatorListOrderFromDom();
  });
  handle.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
    e.preventDefault();
    creatorListDragRow = handle.closest('.creator-list-row');
    creatorListDragRow.classList.add('dragging');
    try { handle.setPointerCapture(e.pointerId); } catch (err) {}
    const move = (ev) => {
      const container = document.getElementById('creatorListRows');
      if (!container || !creatorListDragRow) return;
      const afterEl = getCreatorListDragAfterElement(container, ev.clientY);
      if (afterEl == null) container.appendChild(creatorListDragRow);
      else if (afterEl !== creatorListDragRow) container.insertBefore(creatorListDragRow, afterEl);
    };
    const end = () => {
      document.removeEventListener('pointermove', move);
      if (creatorListDragRow) creatorListDragRow.classList.remove('dragging');
      creatorListDragRow = null;
      persistCreatorListOrderFromDom();
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', end, { once: true });
    document.addEventListener('pointercancel', end, { once: true });
  });
}

// Editing a row's name/url/type or toggling its checkbox doesn't go through
// addRow/renumber, so save on those too via delegation instead of wiring up
// a listener on every individual field.
document.getElementById('lists').addEventListener('input', saveState);
document.getElementById('lists').addEventListener('change', saveState);

function openCreateListModal() {
  document.getElementById('createListModalName').value = '';
  document.getElementById('createListModalPublic').checked = true;
  document.getElementById('createListModalBtn').disabled = true;
  document.getElementById('createListModalBtn').style.opacity = '0.5';
  document.getElementById('createListModal').style.display = 'flex';
}

async function submitCreateListModal() {
  const name = document.getElementById('createListModalName').value.trim();
  if (!name) return;
  const isPublic = document.getElementById('createListModalPublic').checked;
  const visibility = isPublic ? 'public' : 'private';
  
  const payload = { listId: generateChannelId(), type: 'movie', items: [], shuffle: false };
  const newUrl = 'customlist:v1:' + JSON.stringify(payload);
  
  const btn = document.getElementById('createListModalBtn');
  btn.innerText = 'Saving...';
  btn.disabled = true;
  
  try {
    if (activeCreator) {
      const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
      const res = await fetch(ORIGIN + '/api/creator/lists/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          creatorName: activeCreator.creatorName,
          creatorKey: creatorKey,
          name: name,
          type: 'movie',
          items: [],
          visibility: visibility
        })
      });
      const data = await res.json();
      if (!data.ok) {
        alert('Could not save this list: ' + (data.error || 'unknown error'));
        btn.innerText = 'Create';
        btn.disabled = false;
        return;
      }
      
      const updatedPayload = Object.assign({}, payload, {
        listName: name,
        publishedUrl: visibility === 'public' ? data.url : undefined,
        creatorSlug: data.slug,
        creatorOwner: activeCreator.creatorName,
        visibility: visibility
      });
      addRow(name, 'customlist:v1:' + JSON.stringify(updatedPayload), 'movie', true, 'Custom Lists');
    } else {
      // Local list
      const slug = payload.listId;
      payload.localSlug = slug;
      
      const map = loadLocalCustomLists();
      map[slug] = {
        name: name,
        type: 'movie',
        items: [],
        updatedAt: Date.now()
      };
      saveLocalCustomListsMap(map);
      
      addRow(name, 'customlist:v1:' + JSON.stringify(payload), 'movie', true, 'Custom Lists');
    }
    
    saveState();
    document.getElementById('createListModal').style.display = 'none';
    switchTab('lists');
    switchListsSubmenu('my-lists', document.querySelector('#listsSubnavBar button:nth-child(1)'));
    renderCreatorDashboard();
  } catch (e) {
    alert('Network error while saving.');
  } finally {
    btn.innerText = 'Create';
    btn.disabled = false;
  }
}


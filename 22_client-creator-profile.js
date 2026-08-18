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
      '</div>' +
      '<a href="https://buymeacoffee.com/brock25" target="_blank" rel="noopener" style="font-size:0.8rem; color:var(--muted); text-decoration:none; font-weight:500; white-space:nowrap;">&#x2615; Buy me a coffee</a>' +
      '</div>';
  } else {
    bar.innerHTML =
      '<div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px;">' +
      '<div style="display:flex; align-items:center; gap:6px;">' +
      '<button type="button" class="lc-btn primary" onclick="openRestoreModal()" style="padding:6px 12px; font-size:0.82rem; font-weight:700;">Login</button>' +
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
      '<button type="button" class="secondary" onclick="openRestoreModal()">Login</button>' +
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
    '<p style="margin-top:10px;"><small>Anyone with this key can sign in as you and edit your lists &mdash; keep it somewhere safe, and don&apos;t share it.</small></p>' +
    '<div class="danger-zone" style="margin-top:20px; padding:14px 16px; border:1px solid rgba(255,59,48,0.3); border-radius:12px; background:rgba(255,59,48,0.05);">' +
      '<div style="font-weight:700; font-size:0.9rem; color:var(--danger, #ff3b30); margin-bottom:4px;">Delete Account</div>' +
      '<p style="margin:0 0 10px; font-size:0.82rem; color:var(--muted);">Permanently delete your account, all published lists, and all synced data from the server.</p>' +
      '<button type="button" class="lc-btn" style="background:#ff3b30; color:#fff; border:none; padding:7px 14px; font-weight:700; border-radius:8px; cursor:pointer;" onclick="openDeleteAccountModal()">Delete Account &amp; All Data</button>' +
    '</div>';
}

function openDeleteAccountModal() {
  if (!activeCreator) return;
  showModal(
    '<div class="modal-body">' +
      '<h2 class="panel-title" style="color:var(--danger, #ff3b30);">&#x26A0; Delete Account &amp; All Data</h2>' +
      '<p style="margin:8px 0 14px; font-size:0.9rem;">Are you sure you want to delete your account <strong>' + escapeHtml(activeCreator.displayName) + '</strong>?</p>' +
      '<div style="background:rgba(255,59,48,0.08); border:1px solid rgba(255,59,48,0.25); border-radius:8px; padding:12px; margin-bottom:14px; font-size:0.85rem; color:var(--text);">' +
        '<p style="margin:0 0 6px; font-weight:700; color:var(--danger, #ff3b30);">&#x2717; This action is permanent and cannot be undone.</p>' +
        '<ul style="margin:0; padding-left:18px; color:var(--muted);">' +
          '<li>All your published lists will be deleted from the server.</li>' +
          '<li>All synced backups, likes, and channel configurations will be erased.</li>' +
          '<li>Your account key will become permanently invalid.</li>' +
        '</ul>' +
      '</div>' +
      '<div id="deleteAccountStatus"></div>' +
      '<div class="actions" style="margin-top:16px; flex-direction:row; justify-content:flex-end; gap:8px;">' +
        '<button type="button" class="secondary" onclick="closeModal()">Cancel</button>' +
        '<button type="button" id="confirmDeleteAccountBtn" class="primary" style="background:#ff3b30; border-color:#ff3b30; color:#fff;" onclick="handleDeleteAccount()">Permanently Delete Everything</button>' +
      '</div>' +
    '</div>'
  );
}

async function handleDeleteAccount() {
  if (!activeCreator) return;
  const btn = document.getElementById('confirmDeleteAccountBtn');
  const status = document.getElementById('deleteAccountStatus');
  if (btn) btn.disabled = true;
  if (status) status.innerHTML = '<p style="color:var(--muted); font-size:0.85rem;">Deleting account and all data\u2026</p>';
  const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
  try {
    const res = await fetch(ORIGIN + '/api/creator/delete-account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creatorName: activeCreator.creatorName, creatorKey: creatorKey }),
    });
    const data = await res.json().catch(() => null);
    if (!data || !data.ok) {
      if (status) status.innerHTML = '<p class="testresult err">&#x2717; ' + escapeHtml((data && data.error) || 'Failed to delete account.') + '</p>';
      if (btn) btn.disabled = false;
      return;
    }
    localStorage.removeItem('myListAddon:creatorName');
    localStorage.removeItem('myListAddon:creatorKey');
    localStorage.removeItem('myListAddon:creatorDisplayName');
    localStorage.removeItem('myListAddon:dashboardListOrder');
    activeCreator = null;
    closeModal();
    renderCreatorProfileBar();
    renderAccountKeySection();
    renderCreatorDashboard();
    renderLocalCustomListsDashboard();
    showAddedToast('Your account and all data have been permanently deleted.');
  } catch (err) {
    if (status) status.innerHTML = '<p class="testresult err">&#x2717; Network error deleting account.</p>';
    if (btn) btn.disabled = false;
  }
}

function openShareListModal(listName, listUrl) {
  showModal(
    '<div class="modal-body">' +
      '<h2 class="panel-title" style="margin-bottom:6px;">Share List</h2>' +
      '<p style="margin:0 0 14px; font-size:0.88rem; color:var(--muted);">Share <strong>' + escapeHtml(listName || 'Custom List') + '</strong> with others or open it in your browser.</p>' +
      '<div style="display:flex; gap:8px; align-items:center; margin-bottom:14px;">' +
        '<input type="text" id="shareListUrlInput" value="' + escapeAttr(listUrl) + '" readonly style="flex:1; padding:10px 12px; font-size:0.9rem; border-radius:8px; border:1px solid var(--border); background:var(--bg); color:var(--text);">' +
        '<button type="button" class="lc-btn primary" id="shareListCopyBtn" onclick="copyShareListUrl()" style="white-space:nowrap; padding:10px 16px;">Copy Link</button>' +
      '</div>' +
      '<div class="actions" style="margin-top:16px; flex-direction:row; justify-content:flex-end; gap:8px;">' +
        '<a href="' + escapeAttr(listUrl) + '" target="_blank" class="button secondary lc-btn" style="text-decoration:none; display:inline-flex; align-items:center;">Open Link &nearr;</a>' +
        '<button type="button" class="secondary lc-btn" onclick="closeModal()">Close</button>' +
      '</div>' +
    '</div>'
  );
}

function copyShareListUrl() {
  const input = document.getElementById('shareListUrlInput');
  const btn = document.getElementById('shareListCopyBtn');
  if (!input) return;
  input.select();
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(input.value).then(() => {
      if (btn) btn.textContent = 'Copied \u2713';
      showAddedToast('Link copied to clipboard!');
      setTimeout(() => { if (btn) btn.textContent = 'Copy Link'; }, 2000);
    }).catch(() => {
      document.execCommand('copy');
      if (btn) btn.textContent = 'Copied \u2713';
      showAddedToast('Link copied to clipboard!');
      setTimeout(() => { if (btn) btn.textContent = 'Copy Link'; }, 2000);
    });
  } else {
    document.execCommand('copy');
    if (btn) btn.textContent = 'Copied \u2713';
    showAddedToast('Link copied to clipboard!');
    setTimeout(() => { if (btn) btn.textContent = 'Copy Link'; }, 2000);
  }
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
    '<h2>Login</h2>' +
    '<p class="modal-sub">Enter your Username and Account Key to login and sync your lists.</p>' +
    '<div class="row"><input type="text" id="restoreNameInput" placeholder="Username"></div>' +
    '<div class="row" style="margin-top:8px;"><input type="text" id="restoreKeyInput" placeholder="Key (e.g. MYL-XXXX-XXXX-XXXX)"></div>' +
    '<div id="restoreModalError"></div>' +
    '<div class="actions" style="margin-top:14px;">' +
    '<button type="button" class="primary" onclick="submitRestoreProfile()">Login</button>' +
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
  // Tracking data (Watch History/Continue Watching/etc) is split into its
  // own sync call now -- see pushTrackingSync's own comment -- so anything
  // that already calls this general scheduler also gets tracking synced
  // in lockstep, rather than auditing every individual call site for
  // whether it happens to touch tracking data too.
  scheduleTrackingSync();
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

// Debounced sibling of scheduleCreatorSyncSave, just for Watch History/
// Continue Watching tracking data -- split out for the same reason
// presets were: watchHistory in particular can grow into the thousands of
// items (e.g. a bulk "mark as watched" import), and bundling it into every
// routine autosave meant every single config change re-sent and
// re-processed the whole thing, which risked the same free-plan CPU
// budget problem presets did -- and, worse, meant a large watchHistory
// that failed to save left Stremio/wako's Watch History/Continue Watching
// catalog rows showing "No items found" even though the browser's own
// local copy looked complete.
let trackingSyncTimer = null;
function scheduleTrackingSync() {
  if (!activeCreator) return;
  if (trackingSyncTimer) clearTimeout(trackingSyncTimer);
  trackingSyncTimer = setTimeout(pushTrackingSync, 1200);
}

async function pushCreatorSync() {
  if (!activeCreator) return;
  const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
  if (!creatorKey) return;
  try {
    await fetch(ORIGIN + '/api/creator/sync/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creatorName: activeCreator.creatorName,
        creatorKey: creatorKey,
        config: collectEntries(),
        keys: (typeof collectKeys === 'function') ? collectKeys() : {},
        // Presets and tracking data (watchHistory/continueWatching/etc)
        // deliberately NOT included here -- both are pieces of this state
        // that can genuinely grow large, while everything else in this
        // payload changes far more often but stays small. See
        // pushPresetsDirectly/schedulePresetsSync and
        // pushTrackingSync/scheduleTrackingSync, which now handle those on
        // their own, only when they actually change.
        collapsedPanels: collectCollapsedPanelsState(),
        likedLists: [...getLikedListsSet()],
      }),
    });
  } catch (e) {
    // silently fail, it's a background sync
  }
}

// Pushes Watch History/Continue Watching tracking data straight to the
// account's dedicated tracking record (see /api/creator/sync/save-
// tracking) -- the ONLY path this data travels to the server through now.
async function pushTrackingSync() {
  if (!activeCreator) return;
  const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
  if (!creatorKey) return;
  try {
    const localMap = loadLocalCustomLists();
    await fetch(ORIGIN + '/api/creator/sync/save-tracking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creatorName: activeCreator.creatorName,
        creatorKey: creatorKey,
        // Always the full current list, same overwrite-the-blob approach
        // as everything else synced here -- see loadCreatorSync's comment
        // for why signing in replaces local state wholesale rather than
        // merging.
        watchHistory: (localMap['watch-history'] && localMap['watch-history'].items) || [],
        continueWatching: (localMap['continue-watching'] && localMap['continue-watching'].items) || [],
        watchlist: (localMap['watchlist'] && localMap['watchlist'].items) || [],
        trackPlayback: localStorage.getItem('myListAddon:trackPlayback') === '1',
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
      pushTrackingSync();
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

    if (synced.keys && typeof synced.keys === 'object') {
      try {
        if (synced.keys.tmdbKey) {
          localStorage.setItem('myListAddon:tmdbKey', synced.keys.tmdbKey);
          const el = document.getElementById('tmdbKeyInput');
          if (el) el.value = synced.keys.tmdbKey;
        }
        if (synced.keys.tmdbSessionId) {
          localStorage.setItem('myListAddon:tmdbSessionId', synced.keys.tmdbSessionId);
          window.tmdbSessionId = synced.keys.tmdbSessionId;
        }
        if (synced.keys.tmdbAccountId) {
          localStorage.setItem('myListAddon:tmdbAccountId', synced.keys.tmdbAccountId);
          window.tmdbAccountId = synced.keys.tmdbAccountId;
        }
        if (synced.keys.tmdbUsername) {
          localStorage.setItem('myListAddon:tmdbUsername', synced.keys.tmdbUsername);
          window.tmdbUsername = synced.keys.tmdbUsername;
        }
        if (synced.keys.mdblistKey) {
          localStorage.setItem('myListAddon:mdblistKey', synced.keys.mdblistKey);
          const el = document.getElementById('mdblistKeyInput');
          if (el) el.value = synced.keys.mdblistKey;
        }
        if (synced.keys.mdblistAccessToken) {
          localStorage.setItem('myListAddon:mdblistAccessToken', synced.keys.mdblistAccessToken);
          window.mdblistAccessToken = synced.keys.mdblistAccessToken;
        }
        if (synced.keys.traktKey) {
          localStorage.setItem('myListAddon:traktKey', synced.keys.traktKey);
          const el = document.getElementById('traktKeyInput');
          if (el) el.value = synced.keys.traktKey;
        }
        if (synced.keys.traktUsername) {
          localStorage.setItem('myListAddon:traktUsername', synced.keys.traktUsername);
          const el = document.getElementById('traktUsernameInput');
          if (el) el.value = synced.keys.traktUsername;
        }
        if (synced.keys.traktAccessToken) {
          localStorage.setItem('myListAddon:traktAccessToken', synced.keys.traktAccessToken);
          window.traktAccessToken = synced.keys.traktAccessToken;
        }
        if (typeof updateConnectionStatusBadges === 'function') updateConnectionStatusBadges();
        if (typeof scheduleMyTmdbListsRefresh === 'function') scheduleMyTmdbListsRefresh();
        if (typeof scheduleMyMdblistListsRefresh === 'function') scheduleMyMdblistListsRefresh();
        if (typeof scheduleMyTraktListsRefresh === 'function') scheduleMyTraktListsRefresh();
      } catch (e) {}
    }

    // Watch History / Continue Watching -- same wholesale-replace as
    // everything else in this blob (see this function's own comment).
    // getOrCreateWatchHistoryList/getOrCreateContinueWatchingList are used
    // just to get a properly-shaped, slugged entry to overwrite the items
    // on, rather than hand-building one here and risking it drifting out
    // of sync with that shape later.
    let touchedTracking = false;
    if (Array.isArray(synced.watchHistory)) {
      const localWH = loadLocalCustomLists()['watch-history'];
      const localWHItems = (localWH && localWH.items) || [];
      if (localWHItems.length > synced.watchHistory.length) {
        // Local has more than the server -- almost certainly an earlier
        // sync of this data never actually completed (see
        // pushTrackingSync's own comment on why Watch History was split
        // out of the main sync blob in the first place: a large
        // watchHistory could silently fail to save under the old combined
        // payload). Don't adopt the server's smaller copy over data
        // that's visibly sitting in this browser right now -- push local
        // up instead so the server catches up.
        if (typeof scheduleTrackingSync === 'function') scheduleTrackingSync();
      } else {
        const wh = getOrCreateWatchHistoryList();
        wh.items = synced.watchHistory;
        wh.updatedAt = Date.now();
        const map = loadLocalCustomLists();
        map['watch-history'] = wh;
        saveLocalCustomListsMap(map);
        window._watchedItemIds = new Set(synced.watchHistory.map((it) => String(it.id)));
      }
      touchedTracking = true;
    }
    if (Array.isArray(synced.continueWatching)) {
      const localCW = loadLocalCustomLists()['continue-watching'];
      const localCWItems = (localCW && localCW.items) || [];
      const dedupedIncoming = dedupeContinueWatchingItems(synced.continueWatching);
      if (localCWItems.length > dedupedIncoming.length) {
        // Same self-heal as Watch History just above.
        if (typeof scheduleTrackingSync === 'function') scheduleTrackingSync();
      } else {
        const cw = getOrCreateContinueWatchingList();
        cw.items = dedupedIncoming;
        cw.updatedAt = Date.now();
        const map = loadLocalCustomLists();
        map['continue-watching'] = cw;
        saveLocalCustomListsMap(map);
        window._inProgressShowIds = new Set(dedupedIncoming.map((it) => String(it.showId)).filter(Boolean));
        // The server's own copy may still carry whatever duplicate this
        // just cleaned up (if it was ever written by an older, race-prone
        // version of this code) -- push the corrected version back so it
        // doesn't just reappear on the next sync-down.
        if (dedupedIncoming.length !== synced.continueWatching.length && typeof scheduleTrackingSync === 'function') {
          scheduleTrackingSync();
        }
      }
      touchedTracking = true;
    }
    if (Array.isArray(synced.watchlist)) {
      const localWL = loadLocalCustomLists()['watchlist'];
      const localWLItems = (localWL && localWL.items) || [];
      if (localWLItems.length > synced.watchlist.length) {
        if (typeof scheduleTrackingSync === 'function') scheduleTrackingSync();
      } else {
        const map = loadLocalCustomLists();
        backfillAutoTrackedListSlugs(map);
        map['watchlist'].items = synced.watchlist;
        map['watchlist'].updatedAt = Date.now();
        saveLocalCustomListsMap(map);
      }
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
    if (Array.isArray(synced.dashboardListOrder) && synced.dashboardListOrder.length) {
      try {
        localStorage.setItem('myListAddon:dashboardListOrder', JSON.stringify(synced.dashboardListOrder));
      } catch (e) {
        // non-critical
      }
      touchedTracking = true;
    }
    // The dashboard may have already rendered (from before this fetch
    // resolved) with whatever was on this browser beforehand -- refresh it
    // now that the synced watch data has landed, or a device signing in
    // for the first time would show a stale/empty Watch History card
    // until something else happened to trigger a re-render.
    if (touchedTracking && typeof renderCreatorDashboard === 'function') renderCreatorDashboard();
    try { if (typeof cleanWatchedFromWatchlists === 'function') cleanWatchedFromWatchlists(); } catch (e) {}

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
    '<button type="button" class="secondary" onclick="closeModal(); openRestoreModal();">Already have one? Login</button>' +
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
    '<div class="modal-body">' +
      '<button type="button" class="modal-close-x" onclick="closeModal()">\u2715</button>' +
      '<h2 class="panel-title" style="margin-top:0;">Save Custom List</h2>' +
      '<p style="margin:0 0 16px; font-size:0.88rem; color:var(--muted);">Choose visibility for <strong>' + escapeHtml(ctx.name || 'Custom List') + '</strong> on your Creator Profile.</p>' +
      '<div class="visibility-choice" style="display:flex; flex-direction:column; gap:12px; margin: 16px 0 20px;">' +
        '<label style="display:flex; align-items:flex-start; gap:12px; cursor:pointer; padding:12px 14px; border:1px solid var(--border); border-radius:10px; background:var(--bg);">' +
          '<input type="radio" name="listVisibility" value="public" checked style="margin-top:3px; accent-color:var(--brand);">' +
          '<span style="flex:1;"><strong style="color:var(--text); font-size:0.92rem;">Public</strong><br><small style="color:var(--muted);">Anyone with the link can view, like, and add this list to their catalogs.</small></span>' +
        '</label>' +
        '<label style="display:flex; align-items:flex-start; gap:12px; cursor:pointer; padding:12px 14px; border:1px solid var(--border); border-radius:10px; background:var(--bg);">' +
          '<input type="radio" name="listVisibility" value="private" style="margin-top:3px; accent-color:var(--brand);">' +
          '<span style="flex:1;"><strong style="color:var(--text); font-size:0.92rem;">Private</strong><br><small style="color:var(--muted);">Only you can view and edit this list when logged into your account.</small></span>' +
        '</label>' +
      '</div>' +
      '<div class="actions" style="margin-top:16px; flex-direction:row; justify-content:flex-end; gap:8px;">' +
        '<button type="button" class="secondary lc-btn" onclick="closeModal()">Cancel</button>' +
        '<button type="button" class="primary lc-btn" onclick="confirmSaveAsCreator()">Save List</button>' +
      '</div>' +
    '</div>'
  );
}

function showSavedCustomListModal(listName, visibility, url) {
  const isPrivate = visibility === 'private';
  showModal(
    '<div class="modal-body">' +
      '<button type="button" class="modal-close-x" onclick="closeModal()">\u2715</button>' +
      '<h2 class="panel-title" style="margin-top:0;">\u2713 List Saved</h2>' +
      '<p style="margin:8px 0 16px; font-size:0.9rem; color:var(--text);">' +
        '<strong>' + escapeHtml(listName || 'Custom List') + '</strong> has been saved to your Creator Profile as a <strong>' + (isPrivate ? 'private' : 'public') + '</strong> list.' +
      '</p>' +
      (isPrivate
        ? '<div style="padding:12px 14px; background:rgba(0,122,255,0.08); border:1px solid rgba(0,122,255,0.2); border-radius:10px; margin-bottom:16px;">' +
            '<p style="margin:0; font-size:0.84rem; color:var(--text);">&#x1F512; Only you can see this list from your profile when logged in.</p>' +
          '</div>'
        : '<div style="margin-bottom:16px;">' +
            '<p style="margin:0 0 8px; font-size:0.84rem; color:var(--muted);">Public share link:</p>' +
            '<div style="display:flex; gap:8px; align-items:center;">' +
              '<input type="text" id="savedListUrlInput" value="' + escapeAttr(url || '') + '" readonly style="flex:1; padding:10px 12px; font-size:0.88rem; border-radius:8px; border:1px solid var(--border); background:var(--bg); color:var(--text);">' +
              '<button type="button" class="lc-btn primary" id="savedListCopyBtn" onclick="copyShareUrlById(&quot;savedListUrlInput&quot;, this)" style="white-space:nowrap; padding:10px 14px;">Copy Link</button>' +
            '</div>' +
          '</div>'
      ) +
      '<div class="actions" style="margin-top:16px; flex-direction:row; justify-content:flex-end; gap:8px;">' +
        (!isPrivate && url ? '<a href="' + escapeAttr(url) + '" target="_blank" class="button secondary lc-btn" style="text-decoration:none; display:inline-flex; align-items:center;">Open Link &nearr;</a>' : '') +
        '<button type="button" class="primary lc-btn" onclick="closeModal()">Done</button>' +
      '</div>' +
    '</div>'
  );
}

function copyShareUrlById(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  input.select();
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(input.value).then(() => {
      if (btn) btn.textContent = 'Copied \u2713';
      showAddedToast('Link copied to clipboard!');
      setTimeout(() => { if (btn) btn.textContent = 'Copy Link'; }, 2000);
    }).catch(() => {
      document.execCommand('copy');
      if (btn) btn.textContent = 'Copied \u2713';
      showAddedToast('Link copied to clipboard!');
      setTimeout(() => { if (btn) btn.textContent = 'Copy Link'; }, 2000);
    });
  } else {
    document.execCommand('copy');
    if (btn) btn.textContent = 'Copied \u2713';
    showAddedToast('Link copied to clipboard!');
    setTimeout(() => { if (btn) btn.textContent = 'Copy Link'; }, 2000);
  }
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
      showAppNoticeModal('Could Not Save List', data.error || 'Unknown error occurred.', true);
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
    showSavedCustomListModal(ctx.name, visibility, data.url);
    renderCreatorDashboard();
  } catch (e) {
    showAppNoticeModal('Network Error', 'A network error occurred while saving. Please try again.', true);
  } finally {
    pendingSaveListContext = null;
  }
}

function showAppNoticeModal(title, message, isError) {
  showModal(
    '<div class="modal-body">' +
      '<button type="button" class="modal-close-x" onclick="closeModal()">\u2715</button>' +
      '<h2 class="panel-title" style="margin-top:0;' + (isError ? ' color:var(--danger);' : '') + '">' + escapeHtml(title || 'Notice') + '</h2>' +
      '<p style="margin:12px 0 20px; font-size:0.9rem; color:var(--text); line-height:1.4;">' + escapeHtml(message || '') + '</p>' +
      '<div class="actions" style="margin-top:16px; flex-direction:row; justify-content:flex-end;">' +
        '<button type="button" class="primary lc-btn" onclick="closeModal()">OK</button>' +
      '</div>' +
    '</div>'
  );
}

// --- Creator Dashboard ---------------------------------------------------------

async function renderCreatorDashboard(options) {
  const silent = !!(options && options.silent);
  const box = document.getElementById('creatorDashboard');
  if (!box) return;
  if (!activeCreator) {
    renderLocalCustomListsDashboard(box, silent);
    return;
  }
  const hasExistingContent = !!(box.querySelector('#creatorListRows') || (box.children && box.children.length > 0 && !box.querySelector('.testresult')));
  if (!hasExistingContent && !silent) {
    box.innerHTML = '<p><small>Loading your lists\u2026</small></p>';
  }
  const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
  try {
    const res = await fetch(ORIGIN + '/api/creator/lists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creatorName: activeCreator.creatorName, creatorKey: creatorKey }),
    });
    const data = await res.json();
    if (!data.ok) {
      if (!hasExistingContent) {
        box.innerHTML = '<p class="testresult err">\u2717 ' + escapeHtml(data.error || 'Could not load your lists.') + '</p>';
      }
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
    
    const autoTracked = renderAutoTrackedListsHtml();
    lastLocalCustomListsData = autoTracked.lists;

    function buildServerListCardHtml(l) {
      const shareBtn = l.visibility === 'private'
        ? ''
        : '<button type="button" class="lc-btn secondary creatorListShareBtn" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '">Share</button>';
      const isWatchlist = l.slug === 'watchlist' || l.isWatchlist || (l.name && l.name.toLowerCase() === 'watchlist');
      const deleteBtnHtml = isWatchlist ? '' : '<button type="button" class="lc-btn secondary creatorListDeleteBtn" data-slug="' + escapeAttr(l.slug) + '">Delete</button>';
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
        const removeBtn = isWatchlist
          ? '<button type="button" class="cw-remove-btn" onclick="event.stopPropagation(); removeWatchlistItemDirect(&quot;' + escapeAttr(it.imdbId || it.id) + '&quot;, this)" title="Remove from Watchlist">&times;</button>'
          : '';
        const posterType = it.kind || (it.type !== 'mixed' ? (it.type || '') : '') || (it.showId ? 'series' : (l.type === 'mixed' ? '' : (l.type || '')));
        return '<div class="list-card-mini-poster-tile">' +
          '<div class="list-card-mini-poster-img-wrap">' +
            '<img src="' + escapeAttr(it.poster) + '" class="clickable-poster" data-id="' + escapeAttr(it.imdbId || it.id) + '" data-type="' + escapeAttr(posterType) + '" alt="" loading="lazy">' +
            removeBtn +
            overlays +
          '</div>' +
          '<div class="list-card-mini-poster-name">' + escapeHtml(it.title || '') + '</div>' +
          (it.year ? '<div class="list-card-mini-poster-year">' + escapeHtml(it.year) + '</div>' : '') +
        '</div>';
      }).join('');
      const isAdded = typeof isListAddedToConfig === 'function' ? isListAddedToConfig(null, l.type, l.slug) : false;
      return '<div class="list-card creator-list-row" draggable="true" data-slug="' + escapeAttr(l.slug) + '">' +
        '<div class="list-card-header">' +
          '<div class="list-card-body">' +
            '<div class="list-card-title">' +
              '<span class="drag-handle-list" title="Drag to reorder">&#x2630;</span>' +
              escapeHtml(l.name) +
            '</div>' +
            '<div class="list-card-meta">' +
              '<span>' + (l.visibility === 'private' ? 'Private' : 'Public') + '</span>' +
              '<span class="list-card-meta-sep">&middot;</span>' +
              '<span>' + (l.type === 'series' ? 'Shows' : (l.type === 'mixed' ? 'Mixed' : 'Movies')) + '</span>' +
              '<span class="list-card-meta-sep">&middot;</span>' +
              '<span>' + totalCount + ' item' + (totalCount === 1 ? '' : 's') + '</span>' +
              '<span class="list-card-meta-sep">&middot;</span><span>&#9829; ' + (l.likes || 0) + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="list-card-actions">' +
            '<button type="button" class="lc-btn secondary creatorListEditBtn" data-slug="' + escapeAttr(l.slug) + '">Edit</button>' +
            deleteBtnHtml +
            shareBtn +
            '<button type="button" class="lc-btn ' + (isAdded ? 'secondary creatorListAddToConfigBtn is-added' : 'primary creatorListAddToConfigBtn') + '" ' +
              (isAdded ? 'style="color:var(--danger);"' : '') +
              ' data-slug="' + escapeAttr(l.slug) + '">' +
              (isAdded ? 'Remove' : '+ Add') +
            '</button>' +
          '</div>' +
        '</div>' +
        (posterThumbs ? '<div class="list-card-posters poster-preview-static creatorListViewTrigger" data-slug="' + escapeAttr(l.slug) + '" data-name="' + escapeAttr(l.name) + '" data-type="' + escapeAttr(l.type) + '" style="cursor:pointer;">' + posterThumbs + '</div>' : '') +
      '</div>';
    }

    const allDashboardLists = [
      ...(data.lists || []).map((l) => ({ isServer: true, list: l })),
      ...(autoTracked.lists || []).map((l) => ({ isServer: false, list: l })),
    ];

    let savedOrder = [];
    if (Array.isArray(data.order) && data.order.length) {
      savedOrder = data.order;
      try {
        localStorage.setItem('myListAddon:dashboardListOrder', JSON.stringify(savedOrder));
      } catch (e) {}
    } else {
      try {
        savedOrder = JSON.parse(localStorage.getItem('myListAddon:dashboardListOrder') || '[]');
      } catch (e) {}
    }
    if (savedOrder && savedOrder.length) {
      const orderMap = new Map(savedOrder.map((s, idx) => [s, idx]));
      allDashboardLists.sort((a, b) => {
        const posA = orderMap.has(a.list.slug) ? orderMap.get(a.list.slug) : 9999;
        const posB = orderMap.has(b.list.slug) ? orderMap.get(b.list.slug) : 9999;
        return posA - posB;
      });
    }

    const rowsHtml = allDashboardLists.length
      ? allDashboardLists.map((item) => item.isServer ? buildServerListCardHtml(item.list) : buildLocalListCardHtml(item.list)).join('')
      : '<p><small>No lists yet \u2014 build one under Create List to get started.</small></p>';

    const prevScrollTop = box.scrollTop;
    box.innerHTML = '<div id="creatorListRows" style="margin-bottom:14px;">' + rowsHtml + '</div>';
    if (prevScrollTop) box.scrollTop = prevScrollTop;
    document.querySelectorAll('#creatorListRows .drag-handle-list').forEach((h) => initCreatorListTouchDrag(h));
  } catch (e) {
    if (!hasExistingContent) {
      box.innerHTML = '<p class="testresult err">\u2717 Network error loading your lists.</p>';
    }
  }
}

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
  const isWatchlist = l.slug === 'watchlist' || l.isWatchlist || (l.name && l.name.toLowerCase() === 'watchlist');
  const itemCount = (l.items || []).length;
  const allPosters = (l.items || []).slice(0, 9).filter((it) => (l.slug === 'continue-watching' ? (it.showPoster || it.poster) : (it.poster || it.showPoster)));
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
    const posterId = it.showId || it.imdbId || it.id;
    const posterType = it.kind || (it.type !== 'mixed' ? (it.type || '') : '') || (it.showId ? 'series' : (l.type === 'mixed' ? '' : (l.type || '')));
    const label = formatWatchItemLabel(it);
    let removeBtn = '';
    if (l.slug === 'continue-watching' && it.showId) {
      removeBtn = '<button type="button" class="cw-remove-btn" onclick="event.stopPropagation(); dismissContinueWatchingShow(&quot;' + escapeAttr(it.showId) + '&quot;, this)" title="Remove from Continue Watching">&times;</button>';
    } else if (isWatchlist) {
      removeBtn = '<button type="button" class="cw-remove-btn" onclick="event.stopPropagation(); removeWatchlistItemDirect(&quot;' + escapeAttr(it.imdbId || it.id) + '&quot;, this)" title="Remove from Watchlist">&times;</button>';
    } else if (l.slug === 'watch-history') {
      removeBtn = '<button type="button" class="cw-remove-btn" onclick="event.stopPropagation(); removeWatchHistoryItemDirect(&quot;' + escapeAttr(it.id || it.imdbId) + '&quot;, this)" title="Remove from Watch History">&times;</button>';
    }
    const itemPoster = l.slug === 'continue-watching' ? (it.showPoster || it.poster) : (it.poster || it.showPoster);
    return '<div class="list-card-mini-poster-tile">' +
      '<div class="list-card-mini-poster-img-wrap">' +
        '<img src="' + escapeAttr(itemPoster) + '" class="clickable-poster" data-id="' + escapeAttr(posterId) + '" data-type="' + escapeAttr(posterType) + '" alt="" loading="lazy">' +
        removeBtn +
        overlays +
      '</div>' +
      '<div class="list-card-mini-poster-name">' + escapeHtml(label.title) + '</div>' +
      (label.subtitle ? '<div class="list-card-mini-poster-subtitle">' + escapeHtml(label.subtitle) + '</div>' : '') +
      (it.year ? '<div class="list-card-mini-poster-year">' + escapeHtml(it.year) + '</div>' : '') +
    '</div>';
  }).join('');
  const typeLabel = l.type === 'series' ? 'Shows' : l.type === 'movie' ? 'Movies' : 'Mixed';
  const cardClass = 'creator-list-row list-card' + (l.slug === 'watch-history' ? ' is-watch-history-shelf' : '');

  let isAdded = typeof isListAddedToConfig === 'function' ? isListAddedToConfig(null, l.type, l.slug) : false;
  if (!isAdded && isAutoTracked) {
    const entries = document.querySelectorAll('#lists .entry');
    for (const entry of entries) {
      const nameInput = entry.querySelector('.name');
      const urlInput = entry.querySelector('.url');
      if (urlInput && (urlInput.value.indexOf('autotrack:' + l.slug) !== -1 || (urlInput.value.indexOf(l.slug) !== -1 && urlInput.value.startsWith('customlist:v1:')))) {
        isAdded = true;
        break;
      }
      if (nameInput && nameInput.value.trim().toLowerCase().startsWith(l.name.toLowerCase())) {
        isAdded = true;
        break;
      }
    }
  }
  const addBtnHtml = '<button type="button" class="lc-btn ' + (isAdded ? 'secondary localListAddToConfigBtn is-added' : 'primary localListAddToConfigBtn') + '" ' +
    (isAdded ? 'style="color:var(--danger);"' : '') +
    ' data-slug="' + escapeAttr(l.slug) + '">' +
    (isAdded ? 'Remove' : '+ Add') +
  '</button>';

  const deleteBtnHtml = (isAutoTracked || isWatchlist)
    ? ''
    : '<button type="button" class="lc-btn secondary localListDeleteBtn" data-slug="' + escapeAttr(l.slug) + '">Delete</button>';

  return '<div class="' + cardClass + '" draggable="true" data-slug="' + escapeAttr(l.slug) + '" data-list-type="' + escapeAttr(l.type || 'movie') + '">' +
    '<div class="list-card-header">' +
      '<div class="list-card-body">' +
        '<div class="list-card-title">' +
          '<span class="drag-handle-list" draggable="true" title="Drag to reorder">&#x2630;</span>' +
          escapeHtml(l.name) +
        '</div>' +
        '<div class="list-card-meta">' +
          '<span>' + typeLabel + '</span>' +
          '<span class="list-card-meta-sep">&middot;</span>' +
          '<span>' + totalCount + ' item' + (totalCount === 1 ? '' : 's') + '</span>' +
          '<span class="list-card-meta-sep">&middot;</span><span>&#9829; ' + (l.likes || 0) + '</span>' +
        '</div>' +
      '</div>' +
      (isAutoTracked
        ? '<div class="list-card-actions">' +
            '<span style="font-size:0.78rem; color:var(--muted); white-space:nowrap; margin-right:8px;">Auto-tracked</span>' +
            addBtnHtml +
          '</div>'
        : '<div class="list-card-actions">' +
            '<button type="button" class="lc-btn secondary localListEditBtn" data-slug="' + escapeAttr(l.slug) + '">Edit</button>' +
            deleteBtnHtml +
            addBtnHtml +
          '</div>') +
    '</div>' +
    (posterThumbs ? '<div class="list-card-posters poster-preview-static localListViewTrigger" data-slug="' + escapeAttr(l.slug) + '" data-name="' + escapeAttr(l.name) + '" data-type="' + escapeAttr(l.type || 'movie') + '" style="cursor:pointer;">' + posterThumbs + '</div>' : '') +
  '</div>';
}

// list first.
function backfillAutoTrackedListSlugs(map) {
  let patched = false;
  ['watch-history', 'continue-watching'].forEach((key) => {
    if (map[key] && !map[key].slug) {
      map[key].slug = key;
      patched = true;
    }
  });
  // Auto-create mixed Watchlist if not present
  const hasWatchlist = Object.values(map).some(
    (l) => l && (l.slug === 'watchlist' || (l.name && l.name.toLowerCase() === 'watchlist') || l.isWatchlist)
  );
  if (!hasWatchlist) {
    map['watchlist'] = {
      slug: 'watchlist',
      name: 'Watchlist',
      type: 'mixed',
      isWatchlist: true,
      items: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    patched = true;
  }
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
  const keys = ['watch-history', 'continue-watching', 'watchlist'];
  const lists = keys.map((key) => map[key]).filter(Boolean);
  return { html: lists.map(buildLocalListCardHtml).join(''), lists: lists };
}

function renderLocalCustomListsDashboard(box, silent) {
  const map = loadLocalCustomLists();
  backfillAutoTrackedListSlugs(map);

  const lists = Object.keys(map).map((k) => map[k]);
  let savedOrder = [];
  try {
    savedOrder = JSON.parse(localStorage.getItem('myListAddon:dashboardListOrder') || '[]');
  } catch (e) {}
  if (savedOrder && savedOrder.length) {
    const orderMap = new Map(savedOrder.map((s, idx) => [s, idx]));
    lists.sort((a, b) => {
      const posA = orderMap.has(a.slug) ? orderMap.get(a.slug) : 9999;
      const posB = orderMap.has(b.slug) ? orderMap.get(b.slug) : 9999;
      if (posA !== posB) return posA - posB;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
  } else {
    lists.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  lastLocalCustomListsData = lists;
  const rowsHtml = lists.length
    ? lists.map(buildLocalListCardHtml).join('')
    : '<p><small>No lists yet \u2014 build one under Create List to get started.</small></p>';
  const prevScrollTop = box ? box.scrollTop : 0;
  box.innerHTML = '<div id="creatorListRows" style="margin-bottom:14px;">' + rowsHtml + '</div>';
  if (prevScrollTop) box.scrollTop = prevScrollTop;
  document.querySelectorAll('#creatorListRows .drag-handle-list').forEach((h) => initCreatorListTouchDrag(h));
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
    const isCw = list && list.slug === 'continue-watching';
    const isWatchlist = list && (list.slug === 'watchlist' || list.isWatchlist || (list.name && list.name.toLowerCase() === 'watchlist'));
    const isHistory = list && (list.slug === 'watch-history' || (list.name && list.name.toLowerCase() === 'watch history'));
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
        poster: isCw ? (it.showPoster || it.poster) : (it.poster || it.showPoster),
        year: it.year,
        removeShowId: isCw ? (it.showId || it.id) : null,
        removeWatchlistId: isWatchlist ? (it.imdbId || it.id) : null,
        removeHistoryId: isHistory ? (it.id || it.imdbId) : null,
        removeCustomListSlug: (!isCw && !isWatchlist && !isHistory) ? list.slug : null,
      };
    }) : [];
    openListDetailsPage(viewBtn.dataset.name, viewBtn.dataset.type, '', { sample: sample, maybeMore: false });
    return;
  }
  const shareBtn = e.target.closest('.creatorListShareBtn');
  if (shareBtn) {
    const listUrl = shareBtn.dataset.url;
    const listName = shareBtn.dataset.name || 'Custom List';
    openShareListModal(listName, listUrl);
    return;
  }
  const deleteBtn = e.target.closest('.creatorListDeleteBtn');
  if (deleteBtn) {
    const slug = deleteBtn.dataset.slug;
    if (slug === 'watchlist') return;
    const confirmFn = typeof showAppConfirm === 'function' ? showAppConfirm : (title, msg, btnText, cb) => { if (confirm(msg)) cb(); };
    confirmFn("Delete List", "Delete this list? This cannot be undone.", "Delete", async () => {
      const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
      try {
        const res = await fetch(ORIGIN + '/api/creator/lists/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ creatorName: activeCreator.creatorName, creatorKey: creatorKey, slug: slug }),
        });
        const data = await res.json();
        if (!data.ok) {
          if (typeof showAppAlert === 'function') {
            showAppAlert('Error', 'Could not delete: ' + (data.error || 'unknown error'), false);
          } else {
            alert('Could not delete: ' + (data.error || 'unknown error'));
          }
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
        if (typeof showAppAlert === 'function') {
          showAppAlert('Network Error', 'Network error while deleting.', false);
        } else {
          alert('Network error while deleting.');
        }
      }
    }, true);
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
    const isAdded = addToConfigBtn.classList.contains('is-added') || (typeof isListAddedToConfig === 'function' && isListAddedToConfig(null, listMeta.type, slug));
    if (isAdded) {
      if (typeof removeListFromConfig === 'function') {
        removeListFromConfig(null, listMeta.type, slug);
        removeListFromConfig(null, 'movie', slug);
        removeListFromConfig(null, 'series', slug);
      }
      addToConfigBtn.classList.remove('is-added', 'secondary');
      addToConfigBtn.classList.add('primary');
      addToConfigBtn.textContent = '+ Add';
      addToConfigBtn.style.color = '';
      showAddedToast('Removed "' + listMeta.name + '" from your Catalogs.');
    } else {
      if (listMeta.type === 'mixed') {
        const items = listMeta.items || [];
        const movies = items.filter(it => (it.kind === 'movie' || it.type === 'movie' || (!it.kind && !it.type)));
        const series = items.filter(it => (it.kind === 'series' || it.type === 'series' || it.type === 'tv'));
        if (movies.length > 0) {
          const payload = { listId: generateChannelId(), listSlug: slug, type: 'movie', items: movies, shuffle: false };
          addRow(listMeta.name + (series.length > 0 ? ' (Movies)' : ''), 'customlist:v1:' + JSON.stringify(payload), 'movie', true, 'Custom Lists');
        }
        if (series.length > 0 || movies.length === 0) {
          const payload = { listId: generateChannelId(), listSlug: slug, type: 'series', items: series, shuffle: false };
          addRow(listMeta.name + (movies.length > 0 ? ' (Shows)' : ''), 'customlist:v1:' + JSON.stringify(payload), 'series', true, 'Custom Lists');
        }
      } else {
        const payload = { listId: generateChannelId(), listSlug: slug, type: listMeta.type, items: listMeta.items || [], shuffle: false };
        addRow(listMeta.name, 'customlist:v1:' + JSON.stringify(payload), listMeta.type, true, 'Custom Lists');
      }
      addToConfigBtn.classList.add('is-added', 'secondary');
      addToConfigBtn.classList.remove('primary');
      addToConfigBtn.textContent = 'Remove';
      addToConfigBtn.style.color = 'var(--danger)';
      showAddedToast('Added "' + listMeta.name + '" to your Catalogs.');
    }
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
    if (slug === 'watch-history' || slug === 'continue-watching' || slug === 'watchlist') return;
    const confirmFn = typeof showAppConfirm === 'function' ? showAppConfirm : (title, msg, btnText, cb) => { if (confirm(msg)) cb(); };
    confirmFn("Delete List", "Delete this list? This cannot be undone.", "Delete", () => {
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
    }, true);
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
    
    let isAdded = localAddToConfigBtn.classList.contains('is-added') || (typeof isListAddedToConfig === 'function' && isListAddedToConfig(null, listMeta.type, slug));
    if (!isAdded && (slug === 'watch-history' || slug === 'continue-watching')) {
      const entries = document.querySelectorAll('#lists .entry');
      for (const entry of entries) {
        const nameInput = entry.querySelector('.name');
        const urlInput = entry.querySelector('.url');
        if (urlInput && (urlInput.value.indexOf('autotrack:' + slug) !== -1 || (urlInput.value.indexOf(slug) !== -1 && urlInput.value.startsWith('customlist:v1:')))) {
          isAdded = true;
          break;
        }
        if (nameInput && nameInput.value.trim().toLowerCase().startsWith(listMeta.name.toLowerCase())) {
          isAdded = true;
          break;
        }
      }
    }

    if (isAdded) {
      document.querySelectorAll('#lists .url').forEach((urlInput) => {
        const rowPayload = parseCustomListPayloadClient(urlInput.value);
        if (rowPayload && rowPayload.localSlug === slug) {
          const entry = urlInput.closest('.entry');
          if (entry) entry.remove();
        } else if (urlInput.value.indexOf('autotrack:' + slug) !== -1) {
          const entry = urlInput.closest('.entry');
          if (entry) entry.remove();
        }
      });
      if (slug === 'watch-history' || slug === 'continue-watching') {
        document.querySelectorAll('#lists .entry').forEach((entry) => {
          const nameInput = entry.querySelector('.name');
          if (nameInput && nameInput.value.trim().toLowerCase().startsWith(listMeta.name.toLowerCase())) {
            entry.remove();
          }
        });
      }
      if (typeof renumber === 'function') renumber();
      if (typeof saveState === 'function') saveState();
      localAddToConfigBtn.classList.remove('is-added', 'secondary');
      localAddToConfigBtn.classList.add('primary');
      localAddToConfigBtn.textContent = '+ Add';
      localAddToConfigBtn.style.color = '';
      showAddedToast('Removed "' + listMeta.name + '" from your Catalogs.');
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
          ? 'autotrack:' + slug + ':movie:' + activeCreator.creatorName
          : 'customlist:v1:' + JSON.stringify({ listId: generateChannelId(), localSlug: slug, type: 'movie', items: movies, shuffle: false });
        addRow(listMeta.name + (series.length > 0 ? ' (Movies)' : ''), url, 'movie', true, 'My Lists');
      }
      if (series.length > 0 || movies.length === 0) {
        const url = activeCreator && (slug === 'watch-history' || slug === 'continue-watching')
          ? 'autotrack:' + slug + ':series:' + activeCreator.creatorName
          : 'customlist:v1:' + JSON.stringify({ listId: generateChannelId(), localSlug: slug, type: 'series', items: series, shuffle: false });
        addRow(listMeta.name + (movies.length > 0 ? ' (Shows)' : ''), url, 'series', true, 'My Lists');
      }
    } else {
      const payload = { listId: generateChannelId(), localSlug: slug, type: listMeta.type, items: items, shuffle: false };
      addRow(listMeta.name, 'customlist:v1:' + JSON.stringify(payload), listMeta.type, true, 'My Lists');
    }
    
    localAddToConfigBtn.classList.add('is-added', 'secondary');
    localAddToConfigBtn.classList.remove('primary');
    localAddToConfigBtn.textContent = 'Remove';
    localAddToConfigBtn.style.color = 'var(--danger)';
    showAddedToast('Added "' + listMeta.name + '" to your Catalogs.');
  }
});
}

function editCreatorList(slug) {
  const listMeta = (lastCreatorListsData || []).find((l) => l.slug === slug);
  if (!listMeta) {
    alert('Could not find that list -- try refreshing.');
    return;
  }
  const isWatchlist = slug === 'watchlist' || listMeta.isWatchlist || (listMeta.name && listMeta.name.toLowerCase() === 'watchlist');
  customListDraftItems = (listMeta.items || []).slice();
  customListDraftType = isWatchlist ? 'mixed' : (listMeta.type || 'mixed');
  editingCreatorListSlug = slug;
  editingCustomListUrlInput = null;
  document.getElementById('customListNameInput').value = listMeta.name;
  document.getElementById('customListSearchType').value = customListDraftType === 'series' ? 'tv' : 'movie';
  if (typeof updateCustomListTypeRadio === 'function') updateCustomListTypeRadio(customListDraftType);
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
  const isWatchlist = slug === 'watchlist' || listMeta.isWatchlist || (listMeta.name && listMeta.name.toLowerCase() === 'watchlist');
  customListDraftItems = (listMeta.items || []).slice();
  customListDraftType = isWatchlist ? 'mixed' : (listMeta.type || 'mixed');
  editingLocalCustomListSlug = slug;
  editingCreatorListSlug = null;
  editingCustomListUrlInput = null;
  document.getElementById('customListNameInput').value = listMeta.name;
  document.getElementById('customListSearchType').value = customListDraftType === 'series' ? 'tv' : 'movie';
  if (typeof updateCustomListTypeRadio === 'function') updateCustomListTypeRadio(customListDraftType);
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
  const order = [...container.querySelectorAll('.creator-list-row')].map((row) => row.dataset.slug).filter(Boolean);
  try {
    localStorage.setItem('myListAddon:dashboardListOrder', JSON.stringify(order));
  } catch (e) {}
  if (activeCreator) {
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
}

function initCreatorListTouchDrag(handle) {
  if (!handle) return;
  handle.setAttribute('draggable', 'true');
  handle.addEventListener('dragstart', (e) => {
    creatorListDragRow = handle.closest('.creator-list-row');
    if (creatorListDragRow) {
      creatorListDragRow.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', creatorListDragRow.dataset.slug || '');
      }
    }
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
    if (!creatorListDragRow) return;
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

document.addEventListener('dragover', (e) => {
  if (!creatorListDragRow) return;
  const container = document.getElementById('creatorListRows');
  if (!container) return;
  e.preventDefault();
  const afterEl = getCreatorListDragAfterElement(container, e.clientY);
  if (afterEl == null) container.appendChild(creatorListDragRow);
  else if (afterEl !== creatorListDragRow) container.insertBefore(creatorListDragRow, afterEl);
});

// Editing a row's name/url/type or toggling its checkbox doesn't go through
// addRow/renumber, so save on those too via delegation instead of wiring up
// a listener on every individual field.
document.getElementById('lists').addEventListener('input', saveState);
document.getElementById('lists').addEventListener('change', saveState);

function openCreateListModal() {
  const nameEl = document.getElementById('createListModalName');
  if (nameEl) nameEl.value = '';
  const typeEl = document.getElementById('createListModalType');
  if (typeEl) typeEl.value = 'movie';
  const pubEl = document.getElementById('createListModalPublic');
  if (pubEl) pubEl.checked = true;
  const btn = document.getElementById('createListModalBtn');
  if (btn) {
    btn.disabled = true;
    btn.style.opacity = '0.5';
    btn.innerText = 'Create';
  }
  const modal = document.getElementById('createListModal');
  if (modal) modal.style.display = 'flex';
}

async function submitCreateListModal() {
  const name = document.getElementById('createListModalName').value.trim();
  if (!name) return;
  const isPublic = document.getElementById('createListModalPublic').checked;
  const visibility = isPublic ? 'public' : 'private';
  const typeEl = document.getElementById('createListModalType');
  const type = typeEl ? typeEl.value : 'movie';
  
  const currentPendingItem = window._selectListModalCurrentItem;
  let initialItems = [];
  
  const btn = document.getElementById('createListModalBtn');
  btn.innerText = 'Saving...';
  btn.disabled = true;
  
  try {
    if (currentPendingItem && currentPendingItem.title) {
      let finalImdbId = currentPendingItem.id;
      if (finalImdbId && !String(finalImdbId).startsWith('tt')) {
        const endpoint = currentPendingItem.type === 'movie' ? '/api/resolve-movie?tmdbId=' : '/api/resolve-show?tmdbId=';
        try {
          const res = await fetch(ORIGIN + endpoint + encodeURIComponent(finalImdbId));
          const data = await res.json();
          if (data.ok && data.imdbId) finalImdbId = data.imdbId;
        } catch(e) {}
      }
      initialItems.push({
        imdbId: finalImdbId || currentPendingItem.id,
        type: currentPendingItem.type || (type === 'series' ? 'series' : 'movie'),
        title: currentPendingItem.title,
        poster: currentPendingItem.poster || undefined
      });
    }

    const payload = { listId: generateChannelId(), type: type, items: initialItems, shuffle: false };
    const newUrl = 'customlist:v1:' + JSON.stringify(payload);

    if (activeCreator) {
      const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
      const res = await fetch(ORIGIN + '/api/creator/lists/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          creatorName: activeCreator.creatorName,
          creatorKey: creatorKey,
          name: name,
          type: type,
          items: initialItems,
          visibility: visibility
        })
      });
      const data = await res.json();
      if (!data.ok) {
        showAppNoticeModal('Could Not Save List', data.error || 'Unknown error occurred.', true);
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
      addRow(name, 'customlist:v1:' + JSON.stringify(updatedPayload), type, true, 'Custom Lists');
    } else {
      // Local list
      const slug = payload.listId;
      payload.localSlug = slug;
      
      const map = loadLocalCustomLists();
      map[slug] = {
        name: name,
        type: type,
        items: initialItems,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      saveLocalCustomListsMap(map);
      
      addRow(name, 'customlist:v1:' + JSON.stringify(payload), type, true, 'Custom Lists');
    }
    
    saveState();
    document.getElementById('createListModal').style.display = 'none';
    renderCreatorDashboard();
    
    if (currentPendingItem && currentPendingItem.title) {
      showAddedToast('Added "' + currentPendingItem.title + '" to "' + name + '".');
      if (typeof trackEvent === 'function') trackEvent('list-add', initialItems[0] ? initialItems[0].imdbId : currentPendingItem.id, currentPendingItem.title, currentPendingItem.type);
      window._selectListModalCurrentItem = null;
    } else {
      showAddedToast('Created list "' + name + '".');
      switchTab('lists');
    }
  } catch (err) {
    showAppNoticeModal('Network Error', 'A network error occurred while creating your list. Please check your connection and try again.', true);
  } finally {
    btn.innerText = 'Create';
    btn.disabled = false;
  }
}

function removeWatchlistItemDirect(id, btn) {
  if (!id) return;
  if (btn) {
    const tile = btn.closest('.list-card-mini-poster-tile, .live-preview-poster-card');
    if (tile) {
      tile.style.opacity = '0';
      tile.style.transform = 'scale(0.85)';
      tile.style.transition = 'all 0.2s ease';
      setTimeout(() => {
        if (tile && tile.parentNode) tile.parentNode.removeChild(tile);
      }, 200);
    }
  }
  const targetId = String(id);
  const map = (typeof loadLocalCustomLists === 'function') ? loadLocalCustomLists() : {};
  let changed = false;
  Object.keys(map).forEach(key => {
    const list = map[key];
    if (list && (list.slug === 'watchlist' || list.isWatchlist || (list.name && list.name.toLowerCase() === 'watchlist'))) {
      const initialLen = (list.items || []).length;
      list.items = (list.items || []).filter(it => it && String(it.id || it.imdbId) !== targetId && String(it.showId || '') !== targetId);
      if (list.items.length !== initialLen) {
        list.updatedAt = Date.now();
        changed = true;
      }
    }
  });
  if (changed) {
    if (typeof saveLocalCustomListsMap === 'function') saveLocalCustomListsMap(map);
    if (typeof scheduleCreatorSyncSave === 'function') scheduleCreatorSyncSave();
    if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard({ silent: true });
    if (typeof showAddedToast === 'function') showAddedToast('Removed item from Watchlist.');
  }
  if (typeof activeCreator !== 'undefined' && activeCreator && Array.isArray(lastCreatorListsData)) {
    const creatorWatchlist = lastCreatorListsData.find(l => l && (l.slug === 'watchlist' || l.isWatchlist || (l.name && l.name.toLowerCase() === 'watchlist')));
    if (creatorWatchlist && Array.isArray(creatorWatchlist.items)) {
      const initialLen = creatorWatchlist.items.length;
      creatorWatchlist.items = creatorWatchlist.items.filter(it => it && String(it.id || it.imdbId) !== targetId && String(it.showId || '') !== targetId);
      if (creatorWatchlist.items.length !== initialLen) {
        const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
        fetch(ORIGIN + '/api/creator/lists/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            creatorName: activeCreator.creatorName,
            creatorKey: creatorKey,
            name: creatorWatchlist.name,
            type: creatorWatchlist.type || 'mixed',
            items: creatorWatchlist.items,
            visibility: creatorWatchlist.visibility || 'private',
            slug: creatorWatchlist.slug,
          }),
        }).then(() => {
          if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard({ silent: true });
        }).catch(() => {});
      }
    }
  }
}

function removeWatchHistoryItemDirect(id, btn) {
  if (!id) return;
  if (btn) {
    const tile = btn.closest('.list-card-mini-poster-tile, .live-preview-poster-card');
    if (tile) {
      tile.style.opacity = '0';
      tile.style.transform = 'scale(0.85)';
      tile.style.transition = 'all 0.2s ease';
      setTimeout(() => {
        if (tile && tile.parentNode) tile.parentNode.removeChild(tile);
      }, 200);
    }
  }
  const targetId = String(id);
  const map = (typeof loadLocalCustomLists === 'function') ? loadLocalCustomLists() : {};
  if (map['watch-history'] && Array.isArray(map['watch-history'].items)) {
    const initialLen = map['watch-history'].items.length;
    map['watch-history'].items = map['watch-history'].items.filter(it => String(it.id || it.imdbId) !== targetId);
    if (map['watch-history'].items.length !== initialLen) {
      if (window._watchedItemIds) window._watchedItemIds.delete(targetId);
      map['watch-history'].updatedAt = Date.now();
      if (typeof saveLocalCustomListsMap === 'function') saveLocalCustomListsMap(map);
      if (typeof scheduleCreatorSyncSave === 'function') scheduleCreatorSyncSave();
      if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard({ silent: true });
      if (typeof showAddedToast === 'function') showAddedToast('Removed item from Watch History.');
    }
  }
}

function removeCustomListItemDirect(id, slug, btn) {
  if (!id || !slug) return;
  if (btn) {
    const tile = btn.closest('.list-card-mini-poster-tile, .live-preview-poster-card');
    if (tile) {
      tile.style.opacity = '0';
      tile.style.transform = 'scale(0.85)';
      tile.style.transition = 'all 0.2s ease';
      setTimeout(() => {
        if (tile && tile.parentNode) tile.parentNode.removeChild(tile);
      }, 200);
    }
  }
  const targetId = String(id);
  const map = (typeof loadLocalCustomLists === 'function') ? loadLocalCustomLists() : {};
  if (map[slug] && Array.isArray(map[slug].items)) {
    const initialLen = map[slug].items.length;
    map[slug].items = map[slug].items.filter(it => it && String(it.id || it.imdbId) !== targetId && String(it.showId || '') !== targetId);
    if (map[slug].items.length !== initialLen) {
      map[slug].updatedAt = Date.now();
      if (typeof saveLocalCustomListsMap === 'function') saveLocalCustomListsMap(map);
      if (typeof scheduleCreatorSyncSave === 'function') scheduleCreatorSyncSave();
      if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard({ silent: true });
      if (typeof showAddedToast === 'function') showAddedToast('Removed item from list.');
    }
  }
}



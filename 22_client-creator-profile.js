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

let _memoryCustomListsString = null;
let _memoryCustomListsObj = null;

function compactCustomListItem(it) {
  if (!it || typeof it !== 'object') return it;
  const clean = {
    id: it.id || it.imdbId || (it.tmdbId ? 'tmdb:' + it.tmdbId : undefined),
    type: it.type || it.mediatype || it.kind || 'movie',
    name: it.name || it.title || 'Untitled',
  };
  if (it.year) clean.year = String(it.year).slice(0, 4);
  if (it.poster) clean.poster = it.poster;
  if (it.showPoster && it.showPoster !== it.poster) clean.showPoster = it.showPoster;
  if (it.showId) clean.showId = it.showId;
  if (it.showTitle) clean.showTitle = it.showTitle;
  if (it.seasonNum != null) clean.seasonNum = Number(it.seasonNum);
  if (it.episodeNum != null) clean.episodeNum = Number(it.episodeNum);
  if (it.season != null && clean.seasonNum == null) clean.seasonNum = Number(it.season);
  if (it.episode != null && clean.episodeNum == null) clean.episodeNum = Number(it.episode);
  if (it.watchedAt) clean.watchedAt = it.watchedAt;
  if (it.imdbId) clean.imdbId = it.imdbId;
  if (it.tmdbId) clean.tmdbId = it.tmdbId;
  if (it.airDate) clean.airDate = it.airDate;
  if (it.isUnaired) clean.isUnaired = true;
  if (it.seasonFinaleAirDate) clean.seasonFinaleAirDate = it.seasonFinaleAirDate;
  if (it.isSeasonPremiere) clean.isSeasonPremiere = true;
  if (it.isSeasonFinale) clean.isSeasonFinale = true;
  return clean;
}

// Told once per session, naming the lists and the count, because losing
// items off the end of a list is not something a person can be expected to
// notice on their own.
let _trimNotified = false;
function notifyListsTrimmed(trimmed) {
  if (_trimNotified || !trimmed || !trimmed.length) return;
  _trimNotified = true;
  const detail = trimmed.slice(0, 4).map((t) => t.slug + ' (' + t.dropped + ')').join(', ');
  const msg = 'Some lists are too large to store in this browser, so the oldest items were dropped to make them fit: ' +
    detail + (trimmed.length > 4 ? ', and others' : '') +
    '. Creating a Creator Profile stores your lists on your account instead, with no size limit.';
  try {
    if (typeof showAppAlert === 'function') showAppAlert('Some list items could not be kept', msg, false);
    else console.warn(msg);
  } catch (e) {}
}
window.notifyListsTrimmed = notifyListsTrimmed;

// Lists trimmed by the most recent compaction pass -- see the note inside.
let _lastCompactionTrimmed = [];

function compactCustomListMap(map, maxItemsPerList) {
  _lastCompactionTrimmed = [];
  if (!map || typeof map !== 'object') return {};
  const maxItems = maxItemsPerList || 1000;
  const result = {};
  for (const slug in map) {
    const list = map[slug];
    if (!list || typeof list !== 'object') continue;
    const cleanList = {
      slug: list.slug || slug,
      name: list.name || 'Custom List',
      type: list.type || 'mixed',
      createdAt: list.createdAt,
      updatedAt: list.updatedAt,
      visibility: list.visibility || 'private',
    };
    if (list.localSlug) cleanList.localSlug = list.localSlug;
    if (list.creatorSlug) cleanList.creatorSlug = list.creatorSlug;
    if (list.isWatchlist) cleanList.isWatchlist = true;
    if (list.isContinueWatching) cleanList.isContinueWatching = true;
    if (list.isWatchHistory) cleanList.isWatchHistory = true;
    if (Array.isArray(list.items)) {
      // Truncation here is permanent: the trimmed map is what gets written
      // AND what is held in memory afterwards, so anything cut is gone at
      // the next save. A real account exported 1,157 watch-history items
      // against a 1,000 cap -- the next successful save would have silently
      // discarded 157 of them, and the 500-item retry path would have
      // discarded 657. Record it so the caller can say so.
      if (list.items.length > maxItems) {
        _lastCompactionTrimmed.push({ slug: cleanList.slug, dropped: list.items.length - maxItems });
      }
      const trimmedItems = list.items.slice(0, maxItems);
      cleanList.items = trimmedItems.map(compactCustomListItem);
    } else {
      cleanList.items = [];
    }
    result[slug] = cleanList;
  }
  return result;
}

function loadLocalCustomLists() {
  try {
    if (_memoryCustomListsObj && typeof _memoryCustomListsObj === 'object') return _memoryCustomListsObj;
    let str = _memoryCustomListsString;
    if (!str) {
      try { str = sessionStorage.getItem(LOCAL_CUSTOM_LISTS_KEY); } catch(e) {}
    }
    if (!str) {
      str = localStorage.getItem(LOCAL_CUSTOM_LISTS_KEY);
    }
    const map = JSON.parse(str || '{}');
    if (map && typeof map === 'object') {
      _memoryCustomListsString = str;
      _memoryCustomListsObj = map;
      return map;
    }
    return {};
  } catch (e) {
    return {};
  }
}

// Shown once per session when local storage can no longer hold the custom
// lists. Silence was the actual bug here -- the write failed, the UI said
// nothing, and the loss only became visible much later.
let _storageFullNotified = false;
function notifyStorageFull(savedToAccount) {
  if (_storageFullNotified) return;
  _storageFullNotified = true;
  const msg = savedToAccount
    ? 'This browser has run out of local storage, so your lists are being saved to your account instead. Nothing has been lost. Removing a few very large lists or channels will restore offline access.'
    : 'This browser has run out of local storage and your latest changes could NOT be saved. Create a Creator Profile to store your lists on your account, or remove a few very large lists or channels, then try again.';
  try {
    if (typeof showAppAlert === 'function') showAppAlert('Local storage is full', msg, false);
    else console.warn(msg);
  } catch (e) {}
}
window.notifyStorageFull = notifyStorageFull;

function saveLocalCustomListsMap(map) {
  if (!map || typeof map !== 'object') return false;
  
  // Compact items to strip bloated descriptions/cast/extra metadata.
  //
  // The per-list cap exists only to fit the browser's ~5MB ceiling. A
  // signed-in account stores each list as its own server-side record with no
  // such ceiling, so capping there is pure data loss for no benefit -- the
  // limit is raised well clear of any realistic list. Signed out, the cap
  // still applies (there is nowhere else for the data to go), but it is no
  // longer silent.
  const signedIn = (typeof activeCreator !== 'undefined' && !!activeCreator);
  const leanMap = compactCustomListMap(map, signedIn ? 100000 : 1000);
  if (_lastCompactionTrimmed.length) {
    notifyListsTrimmed(_lastCompactionTrimmed.slice());
  }
  _memoryCustomListsObj = leanMap;
  
  try {
    const str = JSON.stringify(leanMap);
    _memoryCustomListsString = str;
    
    // Always attempt to save to sessionStorage as a fast backup
    try { sessionStorage.setItem(LOCAL_CUSTOM_LISTS_KEY, str); } catch(e) {}
    
    localStorage.setItem(LOCAL_CUSTOM_LISTS_KEY, str);
    return true;
  } catch (e) {
    // If quota exceeded, try a tighter compression (500 items max per list)
    try {
      const ultraLeanMap = compactCustomListMap(map, 500);
      if (_lastCompactionTrimmed.length) {
        notifyListsTrimmed(_lastCompactionTrimmed.slice());
      }
      _memoryCustomListsObj = ultraLeanMap;
      const ultraStr = JSON.stringify(ultraLeanMap);
      _memoryCustomListsString = ultraStr;
      try { sessionStorage.setItem(LOCAL_CUSTOM_LISTS_KEY, ultraStr); } catch(e) {}
      localStorage.setItem(LOCAL_CUSTOM_LISTS_KEY, ultraStr);
      return true;
    } catch (retryErr) {
      // Both writes failed. This used to return true regardless, which meant
      // every caller believed a save had happened when nothing had been
      // written -- the data lived only in memory, and the next page load read
      // whatever older copy localStorage still held. That is how one account
      // lost 24 of its 51 custom lists with no error shown anywhere.
      //
      // It now reports the truth. For a signed-in account the data is pushed
      // straight to the server instead, which has no such ceiling, and THAT
      // is a real save -- so true is honest there. For everyone else it is a
      // failure, and the caller (and the person) get told.
      console.warn('saveLocalCustomListsMap: localStorage quota exceeded:', retryErr.message || retryErr);
      window._localStorageFull = true;
      if (typeof activeCreator !== 'undefined' && activeCreator) {
        try { if (typeof scheduleTrackingSync === 'function') scheduleTrackingSync({ force: true }); } catch (e) {}
        try { if (typeof pushCreatorSync === 'function') pushCreatorSync(); } catch (e) {}
        notifyStorageFull(true);
        return true;
      }
      notifyStorageFull(false);
      return false;
    }
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
        ? migratedCount + ' list' + (migratedCount === 1 ? '' : 's') + " moved to your account, but " + failedCount + " couldn't be moved -- they're still saved locally, try again from this browser."
        : "Could not move your local lists to your account -- they're still saved locally, try again from this browser."
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
      '<div style="display:flex; align-items:center; gap:8px;">' +
      '<button type="button" class="subnav-pill active" style="margin:0; font-size:0.85rem; padding:8px 14px; font-weight:700; cursor:pointer; display:inline-flex; align-items:center; gap:6px; border-radius:var(--radius-pill);" onclick="switchTab(&quot;account&quot;)">&#x1F464; ' + escapeHtml(activeCreator.displayName) + '</button>' +
      '</div>';
  } else {
    bar.innerHTML =
      '<div style="display:flex; align-items:center; gap:6px;">' +
      '<button type="button" class="lc-btn primary" onclick="openRestoreModal()" style="padding:8px 16px; font-size:0.85rem; font-weight:700; border-radius:var(--radius-pill);">Login</button>' +
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
    '<div class="danger-zone" style="margin-top:20px; padding:14px 16px; border:1px solid rgba(255,149,0,0.35); border-radius:12px; background:rgba(255,149,0,0.06);">' +
      '<div style="font-weight:700; font-size:0.9rem; color:#ff9500; margin-bottom:4px;">Reset Account</div>' +
      '<p style="margin:0 0 10px; font-size:0.82rem; color:var(--muted);">Delete every list, channel, preset, watch history entry and catalog row on this account, returning it to how it was when you created it. Your account and key stay the same, and you stay signed in.</p>' +
      '<button type="button" class="lc-btn" style="background:#ff9500; color:#fff; border:none; padding:7px 14px; font-weight:700; border-radius:8px; cursor:pointer;" onclick="openResetAccountModal()">Reset Account Data</button>' +
    '</div>' +
    '<div class="danger-zone" style="margin-top:12px; padding:14px 16px; border:1px solid rgba(255,59,48,0.3); border-radius:12px; background:rgba(255,59,48,0.05);">' +
      '<div style="font-weight:700; font-size:0.9rem; color:var(--danger, #ff3b30); margin-bottom:4px;">Delete Account</div>' +
      '<p style="margin:0 0 10px; font-size:0.82rem; color:var(--muted);">Permanently delete your account, all published lists, and all synced data from the server.</p>' +
      '<button type="button" class="lc-btn" style="background:#ff3b30; color:#fff; border:none; padding:7px 14px; font-weight:700; border-radius:8px; cursor:pointer;" onclick="openDeleteAccountModal()">Delete Account &amp; All Data</button>' +
    '</div>';
}

// Empties the account without deleting it: every list, channel, preset,
// catalog row and tracking record goes, the account and its key stay, and
// the person remains signed in on a blank slate.
//
// Local state is cleared FIRST and the server call made second, deliberately.
// The reverse order leaves a window where the browser still holds the old
// lists and any autosave, scrobble ping or background sync landing in that
// window would push them straight back up to the account that was just
// wiped. Clearing locally first means the worst case is a browser that has
// forgotten data the server still holds -- recoverable by signing in again --
// rather than a reset that silently undoes itself.
async function openResetAccountModal() {
  if (!activeCreator) return;
  const confirmFn = typeof showAppConfirm === 'function'
    ? showAppConfirm
    : (title, msg, btnText, cb) => { if (confirm(msg)) cb(); };
  confirmFn(
    'Reset Account Data',
    'This deletes every list, channel, preset, catalog row and watch history entry on your account, on this device and on the server. Your account name and key stay the same and you will remain signed in. This cannot be undone.',
    'Reset Everything',
    async () => {
      const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
      const creatorName = activeCreator.creatorName;
      const displayName = activeCreator.displayName;
      if (!creatorKey) return;

      // Stop anything in flight from re-uploading what we are about to clear.
      window._suppressCreatorSync = true;
      try {
        if (typeof clearLocalAccountData === 'function') clearLocalAccountData();

        const res = await fetch(ORIGIN + '/api/creator/account/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ creatorName: creatorName, creatorKey: creatorKey, confirm: 'RESET' }),
        });
        const data = await res.json().catch(() => null);
        if (!data || !data.ok) {
          const msg = (data && data.error) || 'The reset could not be completed.';
          if (typeof showAppAlert === 'function') showAppAlert('Reset Failed', msg + ' Your local data has been cleared; sign in again to restore it from your account.', false);
          else alert(msg);
          return;
        }

        // clearLocalAccountData signs the person out as a side effect, so put
        // them back where they were -- on their own, now-empty account.
        // The same three keys sign-in writes (see signInCreatorProfile) --
        // not an 'activeCreator' blob, which nothing reads.
        activeCreator = { creatorName: creatorName, displayName: displayName };
        localStorage.setItem('myListAddon:creatorName', creatorName);
        localStorage.setItem('myListAddon:creatorDisplayName', displayName || creatorName);
        localStorage.setItem('myListAddon:creatorKey', creatorKey);

        if (typeof renderCreatorProfileBar === 'function') renderCreatorProfileBar();
        if (typeof renderAccountKeySection === 'function') renderAccountKeySection();
        if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard();
        if (typeof showAppAlert === 'function') {
          showAppAlert('Account Reset', 'Your account is now empty and ready to start again.', true);
        }
      } catch (e) {
        if (typeof showAppAlert === 'function') showAppAlert('Reset Failed', 'Could not reach the server. Your local data has been cleared; sign in again to restore it from your account.', false);
      } finally {
        window._suppressCreatorSync = false;
      }
    }
  );
}
window.openResetAccountModal = openResetAccountModal;

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
    clearLocalAccountData();
    closeModal();
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
function renderWatchlistPreferencesSection() {
  const box = document.getElementById('watchlistPreferencesSection');
  if (!box) return;
  let autoClean = true;
  try {
    const val = localStorage.getItem('myListAddon:removeWatchedFromWatchlist');
    autoClean = val !== '0';
  } catch (e) {}
  box.innerHTML =
    '<label style="display:flex; align-items:flex-start; gap:10px; cursor:pointer; font-size:0.92rem; user-select:none;">' +
      '<input type="checkbox" id="removeWatchedFromWatchlistCheck" ' + (autoClean ? 'checked' : '') + ' onchange="onRemoveWatchedFromWatchlistToggle(this)" style="margin-top:2px; cursor:pointer; width:16px; height:16px;">' +
      '<div>' +
        '<span style="font-weight:600;">Automatically remove watched items from Watchlist</span>' +
        '<p style="margin:4px 0 0; color:var(--muted); font-size:0.82rem;">Movies are removed once watched. TV shows are only removed after every episode has been watched.</p>' +
      '</div>' +
    '</label>';
}

function onRemoveWatchedFromWatchlistToggle(cb) {
  try {
    localStorage.setItem('myListAddon:removeWatchedFromWatchlist', cb.checked ? '1' : '0');
  } catch (e) {}
  if (cb.checked && typeof cleanWatchedFromWatchlists === 'function') {
    cleanWatchedFromWatchlists();
  }
  if (typeof pushTrackingSync === 'function') pushTrackingSync();
  if (typeof scheduleCreatorSyncSave === 'function') scheduleCreatorSyncSave();
}

// "Hidden Lists" panel on Settings -- lets the person hide specific lists
// (by identifier -- see setListHidden's own comment, 21_client-custom-
// list-builder.js) from My Lists, the Airing Next dashboard card, and
// Simkl Airing Next, without deleting or unsyncing anything underneath.
//
// Enumerates every list this browser currently knows about across every
// source that can produce one -- local Custom Lists (via
// loadLocalCustomLists, same store getOrCreateAiringNextList uses, so
// Airing Next's synthetic 'airing-next' entry shows up here too), a
// signed-in Creator Profile's server-side lists (lastCreatorListsData,
// already fetched by renderCreatorDashboard -- this panel doesn't re-fetch
// on its own), and whichever of MDBList/Trakt/TMDB/Simkl the person has
// connected (window._myMdblistLists/_myTraktLists/_myTmdbLists/
// _mySimklLists -- each already populated by that provider's own "My
// Lists" panel render, so this can be empty here until that panel has
// loaded at least once). A list already hidden is included too (checkbox
// unchecked) so it can be found and re-shown -- this panel is the only
// place a hidden list is still visible at all.
function renderHiddenListsSettingsSection() {
  const box = document.getElementById('hiddenListsSettingsSection');
  if (!box) return;

  const rows = []; // { id, name, source }
  const seenIds = new Set();
  function addRow(id, name, source) {
    if (!id || seenIds.has(id)) return;
    seenIds.add(id);
    rows.push({ id: id, name: name || id, source: source });
  }

  // Local Custom Lists (keyed by slug) -- includes the synthetic
  // 'airing-next' entry once it has any items, matching how the dashboard
  // itself only ever shows that card once it's eligible.
  try {
    const map = (typeof loadLocalCustomLists === 'function') ? loadLocalCustomLists() : {};
    Object.keys(map).forEach((slug) => {
      const l = map[slug];
      if (!l || !l.slug) return;
      if (l.slug === 'airing-next') {
        addRow('airing-next', 'Airing Next', 'Dashboard');
      } else {
        addRow(l.slug, l.name || l.slug, 'My Lists');
      }
    });
  } catch (e) {}
  if (typeof collectAiringNextCandidateShowIds === 'function' && collectAiringNextCandidateShowIds().size) {
    addRow('airing-next', 'Airing Next', 'Dashboard');
  }

  // A signed-in Creator Profile's server-side lists -- already fetched by
  // renderCreatorDashboard into lastCreatorListsData; not re-fetched here.
  if (Array.isArray(lastCreatorListsData)) {
    lastCreatorListsData.forEach((l) => {
      if (l && l.slug) addRow(l.slug, l.name || l.slug, 'My Lists');
    });
  }

  // Connected providers -- each keyed by url, matching the filter applied
  // in that provider's own render function (17_client-my-lists-and-trakt-
  // oauth.js). Simkl's own 'simkl:user:shows:airing-next' entry naturally
  // lands under its own "Simkl Airing Next" label via the url check below.
  const providerLists = [
    { arr: window._myMdblistLists, label: 'MDBList' },
    { arr: window._myTraktLists, label: 'Trakt' },
    { arr: window._myTmdbLists, label: 'TMDB' },
    { arr: window._mySimklLists, label: 'Simkl' },
  ];
  providerLists.forEach(({ arr, label }) => {
    if (!Array.isArray(arr)) return;
    arr.forEach((l) => {
      if (!l || !l.url) return;
      const isSimklAiringNext = l.url.includes(':airing-next');
      addRow(l.url, l.name || l.url, isSimklAiringNext ? 'Simkl Airing Next' : label);
    });
  });

  if (!rows.length && Object.keys(MY_LISTS_SECTION_PANEL_IDS || {}).length === 0) {
    box.innerHTML = '<p style="color:var(--muted); font-size:0.85rem;"><small>No lists found yet -- visit My Lists (and connect any providers you use) first, then come back here to manage what\u2019s shown.</small></p>';
    return;
  }

  rows.sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));

  const hiddenIds = new Set(typeof getHiddenListIds === 'function' ? getHiddenListIds() : []);
  const hiddenSections = new Set(typeof getHiddenMyListsSections === 'function' ? getHiddenMyListsSections() : []);

  // Whole-section toggles first -- coarser than the per-list rows below,
  // for someone who wants an entire provider's "Your X Lists" panel gone
  // from My Lists rather than hiding each list inside it one at a time.
  // Always a fixed set of 4 (see MY_LISTS_SECTION_PANEL_IDS, 21_client-
  // custom-list-builder.js) regardless of whether that provider is
  // connected yet -- hiding ahead of connecting is harmless and saves a
  // trip back here after connecting.
  const sectionLabels = { mdblist: 'Your MDBList Lists', trakt: 'Your Trakt Lists', tmdb: 'Your TMDB Lists', simkl: 'Your Simkl Lists' };
  const sectionsHtml = Object.keys(sectionLabels).map((section) => {
    const checked = hiddenSections.has(section);
    return '<label style="display:flex; align-items:center; gap:10px; cursor:pointer; font-size:0.9rem; user-select:none; padding:6px 0; border-bottom:1px solid var(--border);">' +
      '<input type="checkbox" ' + (checked ? 'checked' : '') + ' data-section-id="' + escapeAttr(section) + '" onchange="onHiddenSectionToggle(this)" style="cursor:pointer; width:16px; height:16px; flex-shrink:0;">' +
      '<span style="font-weight:600;">' + escapeHtml(sectionLabels[section]) + '</span>' +
    '</label>';
  }).join('');

  const rowsHtml = rows.length ? rows.map((r) => {
    const checked = hiddenIds.has(String(r.id));
    return '<label style="display:flex; align-items:flex-start; gap:10px; cursor:pointer; font-size:0.9rem; user-select:none; padding:6px 0; border-bottom:1px solid var(--border);">' +
      '<input type="checkbox" ' + (checked ? 'checked' : '') + ' data-list-id="' + escapeAttr(r.id) + '" onchange="onHiddenListToggle(this)" style="margin-top:2px; cursor:pointer; width:16px; height:16px; flex-shrink:0;">' +
      '<div style="min-width:0;">' +
        '<span style="font-weight:600; overflow-wrap:anywhere;">' + escapeHtml(r.name) + '</span>' +
        '<div style="color:var(--muted); font-size:0.78rem; margin-top:2px;">' + escapeHtml(r.source) + '</div>' +
      '</div>' +
    '</label>';
  }).join('') : '<p style="color:var(--muted); font-size:0.85rem; margin-top:8px;"><small>No individual lists found yet -- visit My Lists (and connect any providers you use) first.</small></p>';

  box.innerHTML =
    '<p style="margin:0 0 6px; font-weight:600; font-size:0.85rem;">Whole Sections</p>' +
    sectionsHtml +
    '<p style="margin:14px 0 6px; font-weight:600; font-size:0.85rem;">Individual Lists</p>' +
    rowsHtml;
}

function onHiddenListToggle(cb) {
  const id = cb && cb.dataset ? cb.dataset.listId : '';
  if (!id) return;
  // Checked = hidden, unchecked = visible -- matches the panel's own name
  // ("Hidden Lists": check a box to hide that list).
  if (typeof setListHidden === 'function') setListHidden(id, cb.checked);
}

function onHiddenSectionToggle(cb) {
  const section = cb && cb.dataset ? cb.dataset.sectionId : '';
  if (!section) return;
  // Same checked = hidden convention as onHiddenListToggle above.
  if (typeof setMyListsSectionHidden === 'function') setMyListsSectionHidden(section, cb.checked);
}

// that persists anywhere outside a single browser for that link to
// point at in the first place.
function renderTrackPlaybackSection() {
  const box = document.getElementById('trackPlaybackSection');
  if (!box) return;
  if (!activeCreator) {
    box.innerHTML = '<p><small>Sign in to a Profile above to enable automatic scrobbling \u2014 without one, there\u2019s no account on file to sync playback to.</small></p>';
    return;
  }
  let enabled = false;
  try { enabled = localStorage.getItem('myListAddon:trackPlayback') === '1'; } catch (e) {}
  const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
  const webhookUrl = buildScrobbleWebhookUrl(activeCreator.creatorName, creatorKey);

  let filterUsers = false;
  let allowedUsers = '';
  let blockAnon = false;
  try {
    allowedUsers = localStorage.getItem('myListAddon:scrobbleAllowedUsers') || '';
    filterUsers = localStorage.getItem('myListAddon:scrobbleFilterUsers') === '1' || (allowedUsers.trim().length > 0);
    blockAnon = localStorage.getItem('myListAddon:scrobbleBlockAnonymous') === '1';
  } catch (e) {}

  box.innerHTML =
    '<div style="margin-bottom:14px; padding-bottom:14px; border-bottom:1px solid var(--border);">' +
      '<p style="margin:0 0 6px; font-weight:700; font-size:0.92rem;">Streaming Apps &amp; Addon Players (Stremio, Nuvio, Wako, etc.)</p>' +
      '<label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:0.9rem;">' +
        '<input type="checkbox" id="trackPlaybackCheck" ' + (enabled ? 'checked' : '') + ' onchange="onTrackPlaybackToggle(this)">' +
        '<span>Enable In-App Playback Auto-Tracking</span>' +
      '</label>' +
      '<p style="margin:6px 0 0; color:var(--muted); font-size:0.8rem;">Automatically marks movies and episodes as watched whenever playback starts in any supported streaming app or addon player (Stremio, Nuvio, Wako, etc.) via the built-in playback hook. Takes effect on your next install link.</p>' +
    '</div>' +

    '<div style="margin-bottom:14px; padding-bottom:14px; border-bottom:1px solid var(--border);">' +
      '<p style="margin:0 0 6px; font-weight:700; font-size:0.92rem;">Home Media Servers (Plex, Jellyfin &amp; Emby Scrobbler)</p>' +
      '<p style="margin:0 0 8px; color:var(--muted); font-size:0.82rem;">Automatically scrobble watched movies and TV episodes from your Plex, Jellyfin, or Emby media servers directly into your personal Watch History and Continue Watching lists.</p>' +
      '<div class="webhook-input-group">' +
        '<input type="text" readonly id="scrobbleWebhookInput" value="' + escapeHtml(webhookUrl) + '" style="padding:8px 10px; border-radius:6px; border:1px solid var(--border); background:rgba(0,0,0,0.3); color:var(--text); font-family:monospace; font-size:0.82rem;">' +
        '<button type="button" class="secondary lc-btn" onclick="copyScrobbleWebhookUrl()" style="padding:8px 14px; font-size:0.84rem;">Copy Webhook URL</button>' +
      '</div>' +

      '<div style="margin:10px 0; padding:10px 12px; background:rgba(255,255,255,0.03); border-radius:8px; border:1px solid var(--border); box-sizing:border-box; width:100%; max-width:100%;">' +
        '<label style="display:flex; align-items:flex-start; gap:8px; cursor:pointer; font-size:0.86rem; user-select:none; margin:0 0 4px;">' +
          '<input type="checkbox" id="scrobbleFilterUsersCb" ' + (filterUsers ? 'checked' : '') + ' onchange="onScrobbleFilterUsersToggle(this)" style="width:16px; height:16px; margin-top:2px; cursor:pointer; flex:none;">' +
          '<span style="font-weight:600;">Enable Media Server User Filtering</span>' +
        '</label>' +
        '<p style="margin:0 0 8px; color:var(--muted); font-size:0.8rem;">When enabled, only selected or specified media server user profiles will scrobble into your lists. Unselected users will be ignored.</p>' +
        '<div id="scrobbleFilterDetails" style="' + (filterUsers ? '' : 'display:none;') + ' margin-top:8px; padding-top:8px; border-top:1px solid rgba(255,255,255,0.06);">' +
          '<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">' +
            '<p style="margin:0; font-size:0.8rem; font-weight:600; color:var(--text);">Select Allowed Users:</p>' +
            '<button type="button" class="secondary lc-btn" onclick="loadScrobbleSeenUsers()" style="padding:3px 8px; font-size:0.75rem;">Refresh Users</button>' +
          '</div>' +
          '<div id="scrobbleSeenUsersBox" style="font-size:0.82rem; color:var(--muted); margin-bottom:10px;"><small>Loading\u2026</small></div>' +
          '<p style="margin:0 0 4px; font-size:0.8rem; color:var(--muted);">Additional / Manual Usernames (comma-separated):</p>' +
          '<input type="text" id="scrobbleAllowedUsersInput" placeholder="e.g. James, Alice" value="' + escapeHtml(allowedUsers) + '" oninput="onScrobbleAllowedUsersChange()" style="width:100%; box-sizing:border-box; margin-bottom:8px; font-size:0.84rem;">' +
          '<label style="display:flex; align-items:flex-start; gap:8px; cursor:pointer; font-size:0.84rem; user-select:none; margin:0;">' +
            '<input type="checkbox" id="scrobbleBlockAnonCb" ' + (blockAnon ? 'checked' : '') + ' onchange="onScrobbleBlockAnonChange(this)" style="width:16px; height:16px; margin-top:2px; cursor:pointer; flex:none;">' +
            '<span>Block scrobbles with no username in the payload</span>' +
          '</label>' +
        '</div>' +
      '</div>' +

      '<div style="margin:10px 0; padding:10px 12px; background:rgba(255,255,255,0.03); border-radius:8px; border:1px solid var(--border); box-sizing:border-box; width:100%; max-width:100%;">' +
        '<label style="display:flex; align-items:flex-start; gap:8px; cursor:pointer; font-size:0.86rem; user-select:none; margin:0 0 8px;">' +
          '<input type="checkbox" id="syncMediaServerHistoryCb" checked onchange="toggleMediaServerSync(this.checked)" style="width:16px; height:16px; margin-top:2px; cursor:pointer; flex:none;">' +
          '<span style="font-weight:600;">Automatically sync media server scrobbles to your Watch History list</span>' +
        '</label>' +
        '<label style="display:flex; align-items:flex-start; gap:8px; cursor:pointer; font-size:0.86rem; user-select:none; margin:0 0 10px;">' +
          '<input type="checkbox" id="forwardScrobbleToProvidersCb" checked onchange="toggleForwardScrobbles(this.checked)" style="width:16px; height:16px; margin-top:2px; cursor:pointer; flex:none;">' +
          '<span style="font-weight:600;">Forward scrobbles to connected external accounts (Trakt, Simkl, MDBList)</span>' +
        '</label>' +
        '<div>' +
          '<button type="button" class="secondary lc-btn" onclick="syncAllConnectedAccountsNow(this)" style="padding:8px 14px; font-size:0.82rem; white-space:normal; line-height:1.35; text-align:center; max-width:100%; width:100%; box-sizing:border-box;">Sync Current Watch History to Connected Accounts Now</button>' +
        '</div>' +
      '</div>' +

      '<div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(min(100%, 200px), 1fr)); gap:8px; margin-top:10px; width:100%; max-width:100%; box-sizing:border-box;">' +
        '<details style="background:rgba(255,255,255,0.03); border:1px solid var(--border); border-radius:8px; padding:8px 10px; font-size:0.82rem;">' +
          '<summary style="cursor:pointer; font-weight:600; color:var(--accent-2);">Plex Webhook Setup</summary>' +
          '<p style="margin:6px 0 4px; color:var(--muted);">1. Open <strong>Plex Web &rarr; Settings &rarr; Webhooks</strong>.<br>2. Click <strong>Add Webhook</strong> and paste the URL above.<br>3. Click <strong>Save Changes</strong>.</p>' +
        '</details>' +
        '<details style="background:rgba(255,255,255,0.03); border:1px solid var(--border); border-radius:8px; padding:8px 10px; font-size:0.82rem;">' +
          '<summary style="cursor:pointer; font-weight:600; color:var(--accent-2);">Jellyfin Webhook Setup</summary>' +
          '<p style="margin:6px 0 4px; color:var(--muted);">1. In Jellyfin <strong>Dashboard &rarr; Plugins</strong>, install the <strong>Webhook</strong> plugin.<br>2. Go to Webhook settings &rarr; <strong>Add Generic Destination</strong>.<br>3. Paste the URL and check <strong>Playback</strong> events.</p>' +
        '</details>' +
        '<details style="background:rgba(255,255,255,0.03); border:1px solid var(--border); border-radius:8px; padding:8px 10px; font-size:0.82rem;">' +
          '<summary style="cursor:pointer; font-weight:600; color:var(--accent-2);">Emby Webhook Setup</summary>' +
          '<p style="margin:6px 0 4px; color:var(--muted);">1. Open Emby Server <strong>Dashboard &rarr; Webhooks</strong>.<br>2. Click <strong>Add Webhook</strong> and paste the URL above.<br>3. Check <strong>Playback</strong> / <strong>Scrobble</strong> events.</p>' +
        '</details>' +
      '</div>' +
    '</div>' +

    '<div id="trackPlaybackStatus" style="margin-top:8px;"></div>';

  refreshTrackPlaybackStatus();
  loadScrobbleSeenUsers();
}

function buildScrobbleWebhookUrl(creatorName, creatorKey) {
  return ORIGIN + '/api/scrobble?creator=' + encodeURIComponent(creatorName) + '&key=' + encodeURIComponent(creatorKey);
}

function onScrobbleFilterUsersToggle(cb) {
  try { localStorage.setItem('myListAddon:scrobbleFilterUsers', cb.checked ? '1' : '0'); } catch (e) {}
  const details = document.getElementById('scrobbleFilterDetails');
  if (details) details.style.display = cb.checked ? '' : 'none';
  if (cb.checked) {
    syncScrobbleUserCheckboxes();
  }
  if (typeof pushTrackingSync === 'function') pushTrackingSync();
}

function onScrobbleAllowedUsersChange() {
  try {
    const val = (document.getElementById('scrobbleAllowedUsersInput') || {}).value || '';
    localStorage.setItem('myListAddon:scrobbleAllowedUsers', val);
    const filterCb = document.getElementById('scrobbleFilterUsersCb');
    if (filterCb && !filterCb.checked && val.trim().length > 0) {
      filterCb.checked = true;
      localStorage.setItem('myListAddon:scrobbleFilterUsers', '1');
      const details = document.getElementById('scrobbleFilterDetails');
      if (details) details.style.display = '';
    }
  } catch (e) {}
  syncScrobbleUserCheckboxes();
  if (typeof pushTrackingSync === 'function') pushTrackingSync();
}

function onScrobbleBlockAnonChange(cb) {
  try { localStorage.setItem('myListAddon:scrobbleBlockAnonymous', cb.checked ? '1' : '0'); } catch (e) {}
  if (typeof pushTrackingSync === 'function') pushTrackingSync();
}

function _refreshScrobbleWebhookInput() {
  const input = document.getElementById('scrobbleWebhookInput');
  if (!input || !activeCreator) return;
  const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
  input.value = buildScrobbleWebhookUrl(activeCreator.creatorName, creatorKey);
}

function syncScrobbleUserCheckboxes() {
  const allowed = (localStorage.getItem('myListAddon:scrobbleAllowedUsers') || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const checkboxes = document.querySelectorAll('.scrobble-user-cb');
  checkboxes.forEach((cb) => {
    cb.checked = allowed.includes(cb.value.toLowerCase());
  });
}

function onScrobbleUserCheckboxToggle() {
  try {
    const currentAllowed = (localStorage.getItem('myListAddon:scrobbleAllowedUsers') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const checkboxes = Array.from(document.querySelectorAll('.scrobble-user-cb'));
    const detectedNames = checkboxes.map((cb) => cb.value.toLowerCase());
    const manualKept = currentAllowed.filter((name) => !detectedNames.includes(name.toLowerCase()));
    const checkedDetected = checkboxes.filter((cb) => cb.checked).map((cb) => cb.value);
    const combined = [...manualKept, ...checkedDetected];
    const val = combined.join(', ');
    localStorage.setItem('myListAddon:scrobbleAllowedUsers', val);
    const input = document.getElementById('scrobbleAllowedUsersInput');
    if (input) input.value = val;
    // When a checkbox is toggled, ensure user filter is enabled
    localStorage.setItem('myListAddon:scrobbleFilterUsers', '1');
    const filterCb = document.getElementById('scrobbleFilterUsersCb');
    if (filterCb) filterCb.checked = true;
    const details = document.getElementById('scrobbleFilterDetails');
    if (details) details.style.display = '';
  } catch (e) {}
  if (typeof pushTrackingSync === 'function') pushTrackingSync();
}

async function loadScrobbleSeenUsers() {
  const box = document.getElementById('scrobbleSeenUsersBox');
  if (!box || !activeCreator) return;
  const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
  box.innerHTML = '<span style="color:var(--muted); font-size:0.8rem;">Checking detected users\u2026</span>';
  try {
    const res = await fetch(ORIGIN + '/api/creator/scrobble-seen-users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creatorName: activeCreator.creatorName, creatorKey }),
    });
    const data = await res.json();
    if (!data.ok || !data.users || !Object.keys(data.users).length) {
      box.innerHTML = '<span style="color:var(--muted); font-size:0.8rem;">No users detected yet. Once Plex, Jellyfin, or Emby sends a webhook event, detected user profiles will appear here as selectable checkboxes.</span>';
      return;
    }
    const allowed = (localStorage.getItem('myListAddon:scrobbleAllowedUsers') || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    let html = '<div style="display:flex; flex-direction:column; gap:4px; margin-top:4px;">';
    for (const [username, info] of Object.entries(data.users)) {
      const isChecked = allowed.includes(username.toLowerCase());
      let timeStr = '';
      if (info && info.lastSeen) {
        const diff = Math.max(0, Date.now() - info.lastSeen);
        const mins = Math.floor(diff / 60000);
        if (mins < 1) timeStr = ' \u2014 seen just now';
        else if (mins < 60) timeStr = ' \u2014 seen ' + mins + 'm ago';
        else {
          const hours = Math.floor(mins / 60);
          if (hours < 24) timeStr = ' \u2014 seen ' + hours + 'h ago';
          else timeStr = ' \u2014 seen ' + Math.floor(hours / 24) + 'd ago';
        }
      }
      const serverName = (info && info.server) || 'Media Server';
      html +=
        '<label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:0.84rem; padding:3px 0;">' +
          '<input type="checkbox" class="scrobble-user-cb" value="' + escapeHtml(username) + '" ' + (isChecked ? 'checked' : '') + ' onchange="onScrobbleUserCheckboxToggle()" style="width:15px; height:15px; cursor:pointer; flex:none;">' +
          '<span><strong>' + escapeHtml(username) + '</strong> <span style="color:var(--muted); font-size:0.78rem;">(' + escapeHtml(serverName) + timeStr + ')</span></span>' +
        '</label>';
    }
    html += '</div>';
    box.innerHTML = html;
  } catch (err) {
    box.innerHTML = '<span style="color:var(--muted); font-size:0.8rem;">Could not load detected users right now.</span>';
  }
}

function copyScrobbleWebhookUrl() {
  const input = document.getElementById('scrobbleWebhookInput');
  if (!input || !input.value) return;
  navigator.clipboard.writeText(input.value).then(() => {
    if (typeof showAddedToast === 'function') showAddedToast('Webhook URL copied to clipboard! \u2713');
    else if (typeof showAppAlert === 'function') showAppAlert('Copied', 'Scrobble Webhook URL copied to clipboard! Paste this URL into Plex, Jellyfin, or Emby webhooks settings.', true);
    else alert('Scrobble Webhook URL copied to clipboard! Paste this URL into Plex, Jellyfin, or Emby webhooks settings.');
  }).catch(() => {
    prompt('Copy your Scrobble Webhook URL:', input.value);
  });
}

function toggleMediaServerSync(enabled) {
  try { localStorage.setItem('myListAddon:syncMediaServerHistory', enabled ? 'true' : 'false'); } catch (e) {}
  if (typeof saveState === 'function') saveState();
}

function toggleForwardScrobbles(enabled) {
  try { localStorage.setItem('myListAddon:forwardScrobbleToProviders', enabled ? 'true' : 'false'); } catch (e) {}
  if (typeof saveState === 'function') saveState();
}

function onTrackPlaybackToggle(cb) {
  try { localStorage.setItem('myListAddon:trackPlayback', cb.checked ? '1' : '0'); } catch (e) {}
  if (typeof saveState === 'function') saveState();
  if (typeof scheduleCreatorSyncSave === 'function') scheduleCreatorSyncSave();
  if (cb.checked) {
    refreshTrackPlaybackStatus();
  }
}

async function refreshTrackPlaybackStatus() {
  const statusBox = document.getElementById('trackPlaybackStatus');
  if (!statusBox || !activeCreator) return;
  const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
  statusBox.innerHTML = '<small style="color:var(--muted);">Checking scrobble status\u2026</small>';
  try {
    const res = await fetch(ORIGIN + '/api/creator/track-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creatorName: activeCreator.creatorName, creatorKey: creatorKey }),
    });
    const data = await res.json();
    if (!data.ok || !data.lastPingAt) {
      statusBox.innerHTML = '<div style="display:flex; align-items:center; gap:8px; padding:8px 12px; background:rgba(255,255,255,0.03); border-radius:6px; font-size:0.83rem; color:var(--muted);"><span style="color:var(--muted);">&#x25CB;</span> <span>Ready for playback / scrobble events from Stremio, Plex, Jellyfin, or Emby.</span></div>';
      return;
    }
    const when = new Date(data.lastPingAt).toLocaleString();
    const serverLabel = data.lastServer ? '<strong>' + escapeHtml(data.lastServer) + '</strong>' : '<strong>In-App Streaming Player</strong>';
    const userLabel = data.lastUser ? ' &bull; User: <strong>' + escapeHtml(data.lastUser) + '</strong>' : '';
    const rawMatched = data.matched || data.lastPingId || 'OK';
    const displayMatched = rawMatched.replace(/^(yes|no|error)\b/i, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
    statusBox.innerHTML =
      '<div style="padding:10px 12px; background:rgba(0,122,255,0.08); border:1px solid rgba(0,122,255,0.25); border-radius:8px; font-size:0.84rem;">' +
        '<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:4px;">' +
          '<span style="color:var(--accent); font-weight:700;">\u2713 Last Scrobble Activity</span>' +
          '<span style="color:var(--muted); font-size:0.78rem;">' + escapeHtml(when) + '</span>' +
        '</div>' +
        '<div style="color:var(--text);">' +
          'Source: ' + serverLabel + userLabel + ' &bull; Matched: <code style="color:var(--accent-2);">' + escapeHtml(displayMatched) + '</code>' +
        '</div>' +
      '</div>';
  } catch (e) {
    statusBox.innerHTML = '<small style="color:var(--muted);">Could not check status right now.</small>';
  }
}

function copyAccountKey() {
  const key = localStorage.getItem('myListAddon:creatorKey') || '';
  if (!key) return;
  navigator.clipboard.writeText(key).then(() => {
    if (typeof showAddedToast === 'function') showAddedToast('Key copied to clipboard! \u2713');
    else alert('Key copied to your clipboard.');
  }).catch(() => {
    prompt('Copy your Key:', key);
  });
}

function clearLocalAccountData() {
  activeCreator = null;
  editingCreatorListSlug = null;
  lastCreatorListsData = null;
  resetCreatorListsCache();

  // Clear in-memory tokens and credentials
  traktAccessToken = '';
  if (typeof traktUsername !== 'undefined') traktUsername = '';
  mdblistAccessToken = '';
  if (typeof mdblistUsername !== 'undefined') mdblistUsername = '';
  simklAccessToken = '';
  if (typeof simklUsername !== 'undefined') simklUsername = '';
  tmdbSessionId = '';
  tmdbAccountId = '';
  tmdbUsername = '';

  // Clear personal list arrays & tracking sets
  window._myTraktLists = [];
  window._myPrivateTraktLists = [];
  window._myTmdbLists = [];
  window._mySimklLists = [];
  window._myMdblistLists = [];
  // Read everywhere else as a plain object (Object.keys(...), map lookups by
  // show id), so resetting it to a Set left a value nothing could use.
  window._dismissedContinueWatching = {};
  window._fullyWatchedShowIds = new Set();
  window._inProgressShowIds = new Set();

  // The watch-badge index. Left in place, the previous account's watched
  // ticks kept appearing on posters after signing out.
  window._watchedItemIds = new Set();
  window._rawWatchHistoryItems = [];
  window._watchedIndexLength = 0;
  window._currentItemDetails = null;
  window._episodeDataCache = {};
  window._currentListDetailsAllItems = [];

  // Caches held by other modules that key off the same data.
  if (typeof resetPresetsCache === 'function') resetPresetsCache();
  if (typeof invalidatePosterRenderCaches === 'function') invalidatePosterRenderCaches();
  if (typeof channelDraftItems !== 'undefined') channelDraftItems = [];
  if (typeof channelDraftPoster !== 'undefined') channelDraftPoster = null;
  if (typeof channelDraftBackdrop !== 'undefined') channelDraftBackdrop = null;
  if (typeof editingChannelId !== 'undefined') editingChannelId = null;
  if (typeof customListDraftItems !== 'undefined') customListDraftItems = [];
  _memoryCustomListsString = null;
  _memoryCustomListsObj = null;

  // Clear all localStorage keys for account data, credentials, and custom lists
  try {
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) {
        if (
          k.startsWith('myListAddon:') ||
          k === 'localCustomLists' ||
          k === 'localChannels' ||
          k === 'localMergedChannels' ||
          k === 'presets'
        ) {
          // Preserve persistent UI tab navigation if desired, wipe everything else
          if (
            k !== 'myListAddon:activeTab' &&
            k !== 'myListAddon:settingsSubmenu' &&
            k !== 'myListAddon:catalogsSubmenu' &&
            k !== 'myListAddon:discoverSubmenu' &&
            k !== 'myListAddon:channelsSubmenu' &&
            k !== 'myListAddon:listsSubmenu'
          ) {
            keysToRemove.push(k);
          }
        }
      }
    }
    keysToRemove.forEach((k) => localStorage.removeItem(k));
  } catch (e) {}

  // The reason signing out left Watch History, Continue Watching, Watchlist,
  // Airing Next and every Custom List on screen: saveLocalCustomListsMap
  // mirrors the map into sessionStorage as a fast backup, and
  // loadLocalCustomLists reads sessionStorage BEFORE localStorage. Wiping
  // only localStorage therefore cleared the slower copy and left the one
  // that actually gets read, so the next render pulled the signed-out
  // account's lists straight back.
  try {
    const sessionKeys = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k && (k.indexOf('myListAddon:') === 0 || k === 'localCustomLists' || k === 'localChannels' || k === 'localMergedChannels' || k === 'presets')) {
        sessionKeys.push(k);
      }
    }
    sessionKeys.forEach((k) => sessionStorage.removeItem(k));
  } catch (e) {}

  // Clear form inputs
  const inputIds = [
    'tmdbKeyInput', 'mdblistKeyInput', 'traktKeyInput', 'traktUsernameInput', 'simklKeyInput',
    'presetNameInput', 'channelNameInput', 'customListNameInput', 'bulkPasteBox', 'importLinkInput',
    'configJsonBox', 'customListSearchInput', 'channelSearchInput'
  ];
  inputIds.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  // Clear checkboxes
  const checkboxIds = [
    'syncTraktHistoryCheckbox', 'syncMdblistHistoryCheckbox', 'syncSimklHistoryCheckbox',
    'syncMediaServerHistoryCheckbox', 'forwardScrobblesCheckbox', 'trackPlaybackCheck',
    'removeWatchedFromWatchlistCheck', 'shuffleShelvesCheckbox', 'shuffleItemsCheckbox'
  ];
  checkboxIds.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.checked = false;
  });

  // Clear rows and list containers
  const listsEl = document.getElementById('lists');
  if (listsEl) listsEl.innerHTML = '';

  const resultContainerIds = [
    'myTraktListsResult', 'myPrivateTraktListsResult', 'myTmdbListsResult',
    'mySimklListsResult', 'myMdblistListsResult', 'channelDraftList', 'customListDraftList'
  ];
  resultContainerIds.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '';
  });

  // Re-render UI components into logged-out/empty state
  if (typeof renderCreatorProfileBar === 'function') renderCreatorProfileBar();
  if (typeof renderAccountKeySection === 'function') renderAccountKeySection();
  if (typeof renderWatchlistPreferencesSection === 'function') renderWatchlistPreferencesSection();
  if (typeof renderHiddenListsSettingsSection === 'function') renderHiddenListsSettingsSection();
  if (typeof renderTrackPlaybackSection === 'function') renderTrackPlaybackSection();
  if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard();
  if (typeof renderTraktConnectStatus === 'function') renderTraktConnectStatus();
  if (typeof renderTmdbConnectStatus === 'function') renderTmdbConnectStatus();
  if (typeof renderSimklConnectStatus === 'function') renderSimklConnectStatus();
  if (typeof renderMdblistConnectStatus === 'function') renderMdblistConnectStatus();
  if (typeof updateConnectionStatusBadges === 'function') updateConnectionStatusBadges();
  if (typeof renderChannelsList === 'function') renderChannelsList();
  if (typeof renderChannelMergeList === 'function') renderChannelMergeList();
  if (typeof renderPresetsList === 'function') renderPresetsList();
  if (typeof renumber === 'function') renumber();
  if (typeof updateAllListAddButtons === 'function') updateAllListAddButtons();
}

function switchCreatorProfile() {
  clearLocalAccountData();
  if (typeof showAddedToast === 'function') {
    showAddedToast('Signed out \u2713');
  }
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
    '</div>' +
    '<p class="modal-sub" style="margin-top:14px;"><a href="#" onclick="event.preventDefault(); closeModal(); openForgotKeyModal();">Forgot your key?</a></p>'
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
    // Clean any prior account state before loading restored account
    clearLocalAccountData();
    activeCreator = { creatorName: data.creatorName, displayName: data.displayName };
    localStorage.setItem('myListAddon:creatorName', data.creatorName);
    localStorage.setItem('myListAddon:creatorDisplayName', data.displayName || data.creatorName);
    localStorage.setItem('myListAddon:creatorKey', key);
    closeModal();
    renderCreatorProfileBar();
    renderAccountKeySection();
    renderWatchlistPreferencesSection();
    renderTrackPlaybackSection();
    renderCreatorDashboard();
    await loadCreatorSync();
  } catch (e) {
    errBox.innerHTML = '<p class="testresult err">Network error.</p>';
  }
}

// Self-service key reset for anyone who set a recovery answer at signup
// (see /api/creator/reset-key and its own comment). Reuses
// showKeyRevealModal -- same one-time reveal UX as signup and the
// admin-side reset -- and, once revealed, logs the new key straight in
// the same way a successful restore would, since at that point the
// person has fully proven who they are.
function openForgotKeyModal() {
  showModal(
    '<button type="button" class="modal-close-x" onclick="closeModal()">\u2715</button>' +
    '<h2>Reset Your Key</h2>' +
    '<p class="modal-sub">Enter your Username and the recovery answer you set when you created your account.</p>' +
    '<div class="row"><input type="text" id="forgotKeyNameInput" placeholder="Username"></div>' +
    '<div class="row" style="margin-top:8px;"><input type="text" id="forgotKeyAnswerInput" placeholder="Recovery Answer"></div>' +
    '<div id="forgotKeyModalError"></div>' +
    '<div class="actions" style="margin-top:14px;">' +
    '<button type="button" class="primary" onclick="submitForgotKey()">Reset Key</button>' +
    '<button type="button" class="secondary" onclick="closeModal(); openRestoreModal();">Back to Login</button>' +
    '</div>' +
    '<p class="modal-sub" style="margin-top:14px;">Didn\\'t set a recovery answer, or don\\'t remember it? Reach out via Settings &gt; Feedback &amp; Support.</p>'
  );
}

async function submitForgotKey() {
  const name = document.getElementById('forgotKeyNameInput').value.trim();
  const answer = document.getElementById('forgotKeyAnswerInput').value.trim();
  const errBox = document.getElementById('forgotKeyModalError');
  if (!name || !answer) {
    errBox.innerHTML = '<p class="testresult err">Enter both your Username and Recovery Answer.</p>';
    return;
  }
  try {
    const res = await fetch(ORIGIN + '/api/creator/reset-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: name, recoveryAnswer: answer }),
    });
    const data = await res.json();
    if (!data.ok) {
      errBox.innerHTML = '<p class="testresult err">' + escapeHtml(data.error || 'Could not reset your key.') + '</p>';
      return;
    }
    clearLocalAccountData();
    activeCreator = { creatorName: data.creatorName, displayName: data.displayName };
    localStorage.setItem('myListAddon:creatorName', data.creatorName);
    localStorage.setItem('myListAddon:creatorDisplayName', data.displayName || data.creatorName);
    localStorage.setItem('myListAddon:creatorKey', data.creatorKey);
    closeModal();
    showKeyRevealModal(data.displayName, data.creatorKey);
    renderCreatorProfileBar();
    renderAccountKeySection();
    renderWatchlistPreferencesSection();
    renderTrackPlaybackSection();
    renderCreatorDashboard();
    await loadCreatorSync();
  } catch (e) {
    errBox.innerHTML = '<p class="testresult err">Network error.</p>';
  }
}


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
      localStorage.setItem('myListAddon:creatorDisplayName', data.displayName || data.creatorName);
      renderCreatorProfileBar();
      renderAccountKeySection();
      renderWatchlistPreferencesSection();
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
function scheduleCreatorSyncSave(opts) {
  if (!activeCreator) return;
  if (creatorSyncSaveTimer) clearTimeout(creatorSyncSaveTimer);
  creatorSyncSaveTimer = setTimeout(pushCreatorSync, 1200);
  // Tracking data (Watch History/Continue Watching/etc) is split into its
  // own sync call now -- see pushTrackingSync's own comment -- so anything
  // that already calls this general scheduler also gets tracking synced
  // in lockstep, rather than auditing every individual call site for
  // whether it happens to touch tracking data too.
  scheduleTrackingSync(opts);
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
  presetsSyncTimer = setTimeout(() => {
    const fn = (typeof pushPresetsDirectly === 'function') ? pushPresetsDirectly : (window.pushPresetsDirectly || null);
    const getMapFn = (typeof loadPresetsMap === 'function') ? loadPresetsMap : (window.loadPresetsMap || (() => ({})));
    if (fn) fn(getMapFn());
  }, 1200);
}

// Debounced sibling of scheduleCreatorSyncSave, just for TV Channels --
// syncs the user's saved local channels to the server so they roam across
// browsers seamlessly when signed in.
let channelsSyncTimer = null;
function scheduleChannelsSync() {
  if (typeof activeCreator === 'undefined' || !activeCreator) return;
  if (channelsSyncTimer) clearTimeout(channelsSyncTimer);
  channelsSyncTimer = setTimeout(pushChannelsSync, 1200);
}

async function pushChannelsSync() {
  // A reset has just cleared this browser on purpose; an autosave or
  // scrobble landing now would push the old state straight back up to
  // the account that was just emptied.
  if (window._suppressCreatorSync) return;
  if (typeof activeCreator === 'undefined' || !activeCreator) return;
  const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
  if (!creatorKey) return;
  try {
    const localChannels = (typeof loadLocalChannels === 'function') ? loadLocalChannels() : {};
    const localMerged = (typeof loadLocalMergedChannels === 'function') ? loadLocalMergedChannels() : {};
    await fetch(ORIGIN + '/api/creator/sync/save-channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creatorName: activeCreator.creatorName,
        creatorKey: creatorKey,
        channels: localChannels,
        mergedChannels: localMerged,
      }),
    });
  } catch (e) {
    // silently fail, it's a background sync
  }
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
let _pendingIntentionalRemoval = false;
function scheduleTrackingSync(opts) {
  if (!activeCreator) return;
  if (trackingSyncTimer) clearTimeout(trackingSyncTimer);
  if (opts && opts.intentionalRemoval) {
    _pendingIntentionalRemoval = true;
    try { localStorage.setItem('myListAddon:lastIntentionalRemoval', Date.now()); } catch(e) {}
  }
  trackingSyncTimer = setTimeout(() => {
    const flag = _pendingIntentionalRemoval;
    _pendingIntentionalRemoval = false;
    pushTrackingSync({ intentionalRemoval: flag });
  }, 300);
}

async function pushCreatorSync() {
  // A reset has just cleared this browser on purpose; an autosave or
  // scrobble landing now would push the old state straight back up to
  // the account that was just emptied.
  if (window._suppressCreatorSync) return;
  if (!activeCreator) return;
  const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
  if (!creatorKey) return;
  try {
    const res = await fetch(ORIGIN + '/api/creator/sync/save', {
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
        hiddenLists: (function() {
          try { return JSON.parse(localStorage.getItem('myListAddon:hiddenLists') || '[]'); } catch (e) { return []; }
        })(),
        hiddenMyListsSections: (function() {
          try { return JSON.parse(localStorage.getItem('myListAddon:hiddenMyListsSections') || '[]'); } catch (e) { return []; }
        })(),
        // The updatedAt this browser last actually saw (from a prior
        // /sync/load or /sync/save), i.e. the version these edits are
        // built on top of -- lets the server tell whether another device
        // saved in between instead of silently overwriting it. See
        // /api/creator/sync/save's own comment.
        expectedUpdatedAt: window._serverSyncUpdatedAt,
      }),
    });
    if (res.status === 409) {
      // Another device saved more recently than what this browser last
      // saw. Don't clobber that write -- pull the latest instead. Any
      // edit still pending in this tab hasn't gone anywhere (it's still
      // sitting in the DOM/localStorage) and goes up on the next autosave,
      // now against the correct baseline.
      if (typeof loadCreatorSync === 'function') loadCreatorSync({ background: true });
      return;
    }
    const data = await res.json().catch(() => null);
    if (data && data.ok && typeof data.updatedAt === 'number') {
      window._serverSyncUpdatedAt = data.updatedAt;
    }
    window._lastCreatorSyncPushedAt = Date.now();
  } catch (e) {
    // silently fail, it's a background sync
  }
}

// Cheap fingerprint of everything pushTrackingSync would send, used to
// skip the request entirely when none of it has actually changed.
//
// scheduleCreatorSyncSave calls scheduleTrackingSync in lockstep on
// purpose (see its own comment -- it avoids auditing every call site for
// whether it happens to touch tracking data), but the consequence was
// that collapsing a panel, reordering a row, or renaming a preset each
// re-uploaded a watchHistory that can run to thousands of items, and made
// the server re-read, merge and rewrite the whole record for nothing.
// Keeping the lockstep call but making the push itself a no-op when
// nothing tracking-related moved gets the same safety with none of the
// cost.
//
// Deliberately NOT a hash of the full payload -- building that string is
// most of the work being avoided. Length plus the first and last id plus
// the newest watchedAt of each list catches every real mutation (add,
// remove, reorder, re-watch), and anything it somehow missed is corrected
// by the heartbeat below rather than lost.
// --- Discover recommendations snapshot --------------------------------------
//
// The Discover tab's Recommended Movies/Recommended Shows cards are built
// in the browser from this account's whole picture: Continue Watching,
// Watch History, Watchlist and every other custom list. The catalog row
// those cards add (custom:curated:recommended-movies) is served by
// fetchCuratedCatalog (05_catalog-core.js), which can only see whatever
// tracking data reached the server -- so left to re-derive, it produced a
// different set of items, and a different number of them, from the card
// that advertised the list. Carrying the rendered list up with the rest of
// the tracking data is the same approach Airing Next already takes, and
// for the same reason.
const CURATED_RECS_KEY = 'myListAddon:curatedRecommendations';

function loadCuratedRecommendations() {
  try {
    const raw = JSON.parse(localStorage.getItem(CURATED_RECS_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return null;
    return {
      movies: Array.isArray(raw.movies) ? raw.movies : [],
      shows: Array.isArray(raw.shows) ? raw.shows : [],
      updatedAt: Number(raw.updatedAt) || 0,
    };
  } catch (e) {
    return null;
  }
}

// Same cheap-fingerprint idea as trackingSyncSignature's own listSig --
// length plus the first and last id of each side. Enough to notice the
// recommendations actually changing without stringifying eighty items on
// every autosave.
function curatedRecsSignature(blob) {
  if (!blob) return '0';
  var m = Array.isArray(blob.movies) ? blob.movies : [];
  var s = Array.isArray(blob.shows) ? blob.shows : [];
  function ends(arr) {
    if (!arr.length) return '0';
    return arr.length + '/' + ((arr[0] && arr[0].id) || '') + '/' + ((arr[arr.length - 1] && arr[arr.length - 1].id) || '');
  }
  return ends(m) + '|' + ends(s);
}

// Called by the Discover tab every time it renders those two cards (see
// 19_client-search-and-likes.js). Writing unconditionally would bump
// updatedAt on every visit and make the tracking signature look changed,
// forcing a pointless full push each time -- so an unchanged list is a
// no-op.
function persistCuratedRecommendations(movies, shows) {
  const blob = {
    movies: Array.isArray(movies) ? movies : [],
    shows: Array.isArray(shows) ? shows : [],
    updatedAt: Date.now(),
  };
  if (!blob.movies.length && !blob.shows.length) return;
  const existing = loadCuratedRecommendations();
  if (existing && curatedRecsSignature(existing) === curatedRecsSignature(blob)) return;
  try {
    localStorage.setItem(CURATED_RECS_KEY, JSON.stringify(blob));
  } catch (e) {}
  if (typeof scheduleTrackingSync === 'function') scheduleTrackingSync();
}
window.persistCuratedRecommendations = persistCuratedRecommendations;

function trackingSyncSignature(localMap) {
  function listSig(items) {
    if (!Array.isArray(items) || !items.length) return '0';
    var first = items[0] || {};
    var last = items[items.length - 1] || {};
    var newest = 0;
    for (var i = 0; i < items.length; i++) {
      var w = (items[i] && items[i].watchedAt) || 0;
      if (w > newest) newest = w;
    }
    return items.length + '/' + (first.id || first.imdbId || first.showId || '') +
      '/' + (last.id || last.imdbId || last.showId || '') + '/' + newest;
  }
  var wl = localMap['watchlist'] || {};
  return [
    listSig((localMap['watch-history'] || {}).items),
    listSig((localMap['continue-watching'] || {}).items),
    listSig((localMap['airing-next'] || {}).items),
    curatedRecsSignature(loadCuratedRecommendations()),
    listSig(wl.items),
    Number(wl.updatedAt) || 0,
    (window._fullyWatchedShowIds ? window._fullyWatchedShowIds.size || [...window._fullyWatchedShowIds].length : 0),
    Object.keys(window._dismissedContinueWatching || {}).length,
    localStorage.getItem('myListAddon:trackPlayback') === '1' ? 1 : 0,
    localStorage.getItem('myListAddon:removeWatchedFromWatchlist') !== '0' ? 1 : 0,
    localStorage.getItem('myListAddon:scrobbleFilterUsers') === '1' ? 1 : 0,
    localStorage.getItem('myListAddon:scrobbleAllowedUsers') || '',
    localStorage.getItem('myListAddon:scrobbleBlockAnonymous') === '1' ? 1 : 0,
  ].join('|');
}

// Even with an unchanged signature, push at least this often. A scrobble
// landing server-side is rescued by save-tracking's own merge, so this is
// purely a self-healing floor: if the signature ever failed to notice
// something, the account is at most this far out of date rather than
// permanently stale.
var TRACKING_SYNC_HEARTBEAT_MS = 10 * 60 * 1000;

// Pushes Watch History/Continue Watching tracking data straight to the
// account's dedicated tracking record (see /api/creator/sync/save-
// tracking) -- the ONLY path this data travels to the server through now.
async function pushTrackingSync(opts) {
  // A reset has just cleared this browser on purpose; an autosave or
  // scrobble landing now would push the old state straight back up to
  // the account that was just emptied.
  if (window._suppressCreatorSync) return;
  if (!activeCreator) return;
  const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
  if (!creatorKey) return;
  try {
    const localMap = loadLocalCustomLists();
    // An intentional removal must always reach the server -- it is the one
    // push whose whole purpose is to make the stored list shorter, and
    // save-tracking treats it specially (it skips the scrobble rescue).
    const isIntentional = !!(opts && opts.intentionalRemoval);
    const sig = trackingSyncSignature(localMap);
    const sinceLast = Date.now() - (window._lastTrackingSyncPushedAt || 0);
    if (!isIntentional && sig === window._lastTrackingSig && sinceLast < TRACKING_SYNC_HEARTBEAT_MS) {
      return;
    }
    const wl = localMap['watchlist'] || {};
    const wlItems = Array.isArray(wl.items) ? wl.items : [];
    const wlUpdatedAt = Number(wl.updatedAt) || Date.now();
    await fetch(ORIGIN + '/api/creator/sync/save-tracking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creatorName: activeCreator.creatorName,
        creatorKey: creatorKey,
        // Always the full current list, same overwrite-the-blob approach
        // as everything else synced here -- see loadCreatorSync's comment
        // for why signing in replaces local state wholesale rather than
        // merging. The one exception is a scrobble ping landing between
        // this browser's last load and this push -- see save-tracking's
        // own comment for the narrow rescue that covers that, and
        // intentionalRemoval below for why a deliberate delete skips it.
        watchHistory: (localMap['watch-history'] && localMap['watch-history'].items) || [],
        continueWatching: (localMap['continue-watching'] && localMap['continue-watching'].items) || [],
        airingNext: (localMap['airing-next'] && localMap['airing-next'].items) || [],
        curatedRecommendations: loadCuratedRecommendations(),
        watchlist: wlItems,
        watchlistUpdatedAt: wlUpdatedAt,
        trackPlayback: localStorage.getItem('myListAddon:trackPlayback') === '1',
        removeWatchedFromWatchlist: localStorage.getItem('myListAddon:removeWatchedFromWatchlist') !== '0',
        scrobbleFilterUsers: localStorage.getItem('myListAddon:scrobbleFilterUsers') === '1',
        scrobbleAllowedUsers: localStorage.getItem('myListAddon:scrobbleAllowedUsers') || '',
        scrobbleBlockAnonymous: localStorage.getItem('myListAddon:scrobbleBlockAnonymous') === '1',
        fullyWatchedShowIds: [...(window._fullyWatchedShowIds || [])],
        dismissedContinueWatching: window._dismissedContinueWatching || {},
        // Set only by flows that are deliberately shrinking Watch History
        // (Clear Watch History, removing a single item) -- tells the
        // server to trust this array exactly as sent instead of rescuing
        // any item a recent scrobble might have added that isn't in it,
        // so an intentional delete can never be silently undone by that
        // rescue on the very next autosave.
        intentionalRemoval: !!(opts && opts.intentionalRemoval),
      }),
    });
    window._lastTrackingSyncPushedAt = Date.now();
    window._lastTrackingSig = sig;
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
async function loadCreatorSync(opts) {
  const isBackgroundResume = !!(opts && opts.background);
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
    window._lastCreatorSyncLoadedAt = Date.now();
    if (!data.data) {
      pushCreatorSync();
      const localPresets = loadPresetsMap();
      if (localPresets && Object.keys(localPresets).length) pushPresetsDirectly(localPresets);
      const localChannels = (typeof loadLocalChannels === 'function') ? loadLocalChannels() : {};
      const localMerged = (typeof loadLocalMergedChannels === 'function') ? loadLocalMergedChannels() : {};
      if ((localChannels && Object.keys(localChannels).length) || (localMerged && Object.keys(localMerged).length)) {
        pushChannelsSync();
      }
      pushTrackingSync();
      return;
    }
    const synced = data.data;
    // Snapshot of the four stamps this browser is now level with. The
    // background poll compares /api/creator/sync/meta against exactly
    // these and skips the full load when none of them has moved -- see
    // handleForegroundResumeSync below.
    window._syncMetaStamps = {
      config: Number(synced.updatedAt) || 0,
      tracking: Number(synced.trackingUpdatedAt) || 0,
      presets: Number(synced.presetsUpdatedAt) || 0,
      channels: Number(synced.channelsUpdatedAt) || 0,
    };
    const timeChanged = typeof window._serverSyncUpdatedAt === 'undefined' || (synced.updatedAt && synced.updatedAt > window._serverSyncUpdatedAt);
    if (synced.updatedAt !== undefined) window._serverSyncUpdatedAt = synced.updatedAt;
    
    const currentConfigStr = JSON.stringify(synced.config || []);
    const configDataChanged = currentConfigStr !== window._lastConfigStr;
    window._lastConfigStr = currentConfigStr;
    
    const configChanged = timeChanged && configDataChanged;

    const trackingChanged = typeof window._serverTrackingUpdatedAt === 'undefined' || (synced.trackingUpdatedAt && synced.trackingUpdatedAt > window._serverTrackingUpdatedAt);
    if (synced.trackingUpdatedAt !== undefined) window._serverTrackingUpdatedAt = synced.trackingUpdatedAt;

    // Only rebuild lists table DOM if the list config actually changed or it's a full initial load
    if (!isBackgroundResume || configChanged) {
      suppressSave = true;
      document.getElementById('lists').innerHTML = '';
      if (Array.isArray(synced.config)) {
        synced.config.forEach((e) => addRow(e.name, e.url, e.type, e.enabled, e.group, e.id));
      }
      renumber();
      suppressSave = false;

      // Re-trigger live preview if catalogs tab has already been visited
      if (window._catalogsInitializedOnce && typeof renderLivePreview === 'function') {
        renderLivePreview();
      }
    }

    // Restore hidden lists state from sync so the selections survive
    // cross-browser logins. Both keys live only in localStorage locally;
    // the server blob now carries them so this browser can adopt them.
    if (Array.isArray(synced.hiddenLists)) {
      try { localStorage.setItem('myListAddon:hiddenLists', JSON.stringify(synced.hiddenLists)); } catch (e) {}
    }
    if (Array.isArray(synced.hiddenMyListsSections)) {
      try { localStorage.setItem('myListAddon:hiddenMyListsSections', JSON.stringify(synced.hiddenMyListsSections)); } catch (e) {}
      if (typeof applyHiddenMyListsSections === 'function') applyHiddenMyListsSections();
    }

    if (synced.channels && typeof synced.channels === 'object') {
      if (typeof saveLocalChannelsMap === 'function') {
        saveLocalChannelsMap(synced.channels);
      }
    }
    if (synced.mergedChannels && typeof synced.mergedChannels === 'object') {
      if (typeof saveLocalMergedChannelsMap === 'function') {
        saveLocalMergedChannelsMap(synced.mergedChannels);
      }
    }
    if (typeof renderMyCreatedChannelsList === 'function') renderMyCreatedChannelsList();
    if (typeof renderChannelMergeList === 'function') renderChannelMergeList();
    
    if (synced.presetsB64) {
      decompressBase64ToJson(synced.presetsB64).then(parsedPresets => {
        const normFn = (typeof extractNormalizedPresetsMap === 'function') ? extractNormalizedPresetsMap : (window.extractNormalizedPresetsMap || (x => x));
        const normalized = normFn(parsedPresets);
        if (normalized && typeof normalized === 'object' && Object.keys(normalized).length > 0) {
          const getMapFn = (typeof loadPresetsMap === 'function') ? loadPresetsMap : (window.loadPresetsMap || (() => ({})));
          const saveMapFn = (typeof savePresetsMap === 'function') ? savePresetsMap : (window.savePresetsMap || (() => {}));
          const renderFn = (typeof renderPresetsList === 'function') ? renderPresetsList : (window.renderPresetsList || (() => {}));
          const localMap = getMapFn();
          const merged = { ...localMap, ...normalized };
          saveMapFn(merged);
          renderFn();
        }
      }).catch(() => {});
    } else if (synced.presets && typeof synced.presets === 'object' && Object.keys(synced.presets).length > 0) {
      const normFn = (typeof extractNormalizedPresetsMap === 'function') ? extractNormalizedPresetsMap : (window.extractNormalizedPresetsMap || (x => x));
      const normalized = normFn(synced.presets);
      const getMapFn = (typeof loadPresetsMap === 'function') ? loadPresetsMap : (window.loadPresetsMap || (() => ({})));
      const saveMapFn = (typeof savePresetsMap === 'function') ? savePresetsMap : (window.savePresetsMap || (() => {}));
      const renderFn = (typeof renderPresetsList === 'function') ? renderPresetsList : (window.renderPresetsList || (() => {}));
      const localMap = getMapFn();
      const merged = { ...localMap, ...normalized };
      saveMapFn(merged);
      renderFn();
    } else {
      // Server presets are empty: keep local presets and push them up to sync so they are preserved in Cloudflare KV
      const getMapFn = (typeof loadPresetsMap === 'function') ? loadPresetsMap : (window.loadPresetsMap || (() => ({})));
      const pushFn = (typeof pushPresetsDirectly === 'function') ? pushPresetsDirectly : (window.pushPresetsDirectly || null);
      const renderFn = (typeof renderPresetsList === 'function') ? renderPresetsList : (window.renderPresetsList || (() => {}));
      const localMap = getMapFn();
      if (localMap && Object.keys(localMap).length > 0) {
        if (pushFn) pushFn(localMap);
      }
      renderFn();
    }
    
    applyCollapsedPanelsState(synced.collapsedPanels);
    if (typeof synced.trackPlayback === 'boolean') {
      try { localStorage.setItem('myListAddon:trackPlayback', synced.trackPlayback ? '1' : '0'); } catch (e) {}
      if (typeof renderTrackPlaybackSection === 'function') renderTrackPlaybackSection();
    }
    if (typeof synced.removeWatchedFromWatchlist === 'boolean') {
      try { localStorage.setItem('myListAddon:removeWatchedFromWatchlist', synced.removeWatchedFromWatchlist ? '1' : '0'); } catch (e) {}
      if (typeof renderWatchlistPreferencesSection === 'function') renderWatchlistPreferencesSection();
    }
    if (typeof synced.scrobbleFilterUsers === 'boolean') {
      try { localStorage.setItem('myListAddon:scrobbleFilterUsers', synced.scrobbleFilterUsers ? '1' : '0'); } catch (e) {}
    }
    if (typeof synced.scrobbleAllowedUsers === 'string') {
      try { localStorage.setItem('myListAddon:scrobbleAllowedUsers', synced.scrobbleAllowedUsers); } catch (e) {}
    }
    if (typeof synced.scrobbleBlockAnonymous === 'boolean') {
      try { localStorage.setItem('myListAddon:scrobbleBlockAnonymous', synced.scrobbleBlockAnonymous ? '1' : '0'); } catch (e) {}
    }
    if (synced.scrobbleFilterUsers !== undefined || synced.scrobbleAllowedUsers !== undefined || synced.scrobbleBlockAnonymous !== undefined) {
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
        const tmdbDisc = localStorage.getItem('myListAddon:tmdbDisconnected') === 'true';
        const mdblistDisc = localStorage.getItem('myListAddon:mdblistDisconnected') === 'true';
        const traktDisc = localStorage.getItem('myListAddon:traktDisconnected') === 'true';
        const simklDisc = localStorage.getItem('myListAddon:simklDisconnected') === 'true';
        let needPushSync = false;

        if (synced.keys.tmdbKey && !tmdbDisc) {
          localStorage.setItem('myListAddon:tmdbKey', synced.keys.tmdbKey);
          const el = document.getElementById('tmdbKeyInput');
          if (el) el.value = synced.keys.tmdbKey;
        } else if (tmdbDisc) {
          localStorage.removeItem('myListAddon:tmdbKey');
          const el = document.getElementById('tmdbKeyInput');
          if (el) el.value = '';
        } else if (localStorage.getItem('myListAddon:tmdbKey')) {
          needPushSync = true;
        }

        if (synced.keys.tmdbSessionId && !tmdbDisc) {
          localStorage.setItem('myListAddon:tmdbSessionId', synced.keys.tmdbSessionId);
          window.tmdbSessionId = synced.keys.tmdbSessionId;
          tmdbSessionId = synced.keys.tmdbSessionId;
        } else if (tmdbDisc) {
          localStorage.removeItem('myListAddon:tmdbSessionId');
          window.tmdbSessionId = '';
          tmdbSessionId = '';
        } else if (localStorage.getItem('myListAddon:tmdbSessionId')) {
          needPushSync = true;
        }

        if (synced.keys.tmdbAccountId && !tmdbDisc) {
          localStorage.setItem('myListAddon:tmdbAccountId', synced.keys.tmdbAccountId);
          window.tmdbAccountId = synced.keys.tmdbAccountId;
          tmdbAccountId = synced.keys.tmdbAccountId;
        } else if (tmdbDisc) {
          localStorage.removeItem('myListAddon:tmdbAccountId');
          window.tmdbAccountId = '';
          tmdbAccountId = '';
        } else if (localStorage.getItem('myListAddon:tmdbAccountId')) {
          needPushSync = true;
        }

        if (synced.keys.tmdbUsername && !tmdbDisc) {
          localStorage.setItem('myListAddon:tmdbUsername', synced.keys.tmdbUsername);
          window.tmdbUsername = synced.keys.tmdbUsername;
          tmdbUsername = synced.keys.tmdbUsername;
        } else if (tmdbDisc) {
          localStorage.removeItem('myListAddon:tmdbUsername');
          window.tmdbUsername = '';
          tmdbUsername = '';
        } else if (localStorage.getItem('myListAddon:tmdbUsername')) {
          needPushSync = true;
        }

        if (synced.keys.mdblistKey && !mdblistDisc) {
          localStorage.setItem('myListAddon:mdblistKey', synced.keys.mdblistKey);
          const el = document.getElementById('mdblistKeyInput');
          if (el) el.value = synced.keys.mdblistKey;
        } else if (mdblistDisc) {
          localStorage.removeItem('myListAddon:mdblistKey');
          const el = document.getElementById('mdblistKeyInput');
          if (el) el.value = '';
        } else if (localStorage.getItem('myListAddon:mdblistKey')) {
          needPushSync = true;
        }

        if (synced.keys.mdblistAccessToken && !mdblistDisc) {
          localStorage.setItem('myListAddon:mdblistAccessToken', synced.keys.mdblistAccessToken);
          window.mdblistAccessToken = synced.keys.mdblistAccessToken;
          mdblistAccessToken = synced.keys.mdblistAccessToken;
        } else if (mdblistDisc) {
          localStorage.removeItem('myListAddon:mdblistAccessToken');
          window.mdblistAccessToken = '';
          mdblistAccessToken = '';
        } else if (localStorage.getItem('myListAddon:mdblistAccessToken')) {
          needPushSync = true;
        }

        if (synced.keys.mdblistUsername && !mdblistDisc) {
          localStorage.setItem('myListAddon:mdblistUsername', synced.keys.mdblistUsername);
          window.mdblistUsername = synced.keys.mdblistUsername;
          mdblistUsername = synced.keys.mdblistUsername;
        } else if (mdblistDisc) {
          localStorage.removeItem('myListAddon:mdblistUsername');
          window.mdblistUsername = '';
          mdblistUsername = '';
        } else if (localStorage.getItem('myListAddon:mdblistUsername')) {
          needPushSync = true;
        }

        if (synced.keys.traktKey && !traktDisc) {
          localStorage.setItem('myListAddon:traktKey', synced.keys.traktKey);
          const el = document.getElementById('traktKeyInput');
          if (el) el.value = synced.keys.traktKey;
        } else if (traktDisc) {
          localStorage.removeItem('myListAddon:traktKey');
          const el = document.getElementById('traktKeyInput');
          if (el) el.value = '';
        } else if (localStorage.getItem('myListAddon:traktKey')) {
          needPushSync = true;
        }

        if (synced.keys.traktUsername && !traktDisc) {
          localStorage.setItem('myListAddon:traktUsername', synced.keys.traktUsername);
          const el = document.getElementById('traktUsernameInput');
          if (el) el.value = synced.keys.traktUsername;
          traktUsername = synced.keys.traktUsername;
        } else if (traktDisc) {
          localStorage.removeItem('myListAddon:traktUsername');
          const el = document.getElementById('traktUsernameInput');
          if (el) el.value = '';
          traktUsername = '';
        } else if (localStorage.getItem('myListAddon:traktUsername')) {
          needPushSync = true;
        }

        if (synced.keys.traktAccessToken && !traktDisc) {
          localStorage.setItem('myListAddon:traktAccessToken', synced.keys.traktAccessToken);
          window.traktAccessToken = synced.keys.traktAccessToken;
          traktAccessToken = synced.keys.traktAccessToken;
        } else if (traktDisc) {
          localStorage.removeItem('myListAddon:traktAccessToken');
          window.traktAccessToken = '';
          traktAccessToken = '';
        } else if (localStorage.getItem('myListAddon:traktAccessToken')) {
          needPushSync = true;
        }

        if (synced.keys.simklKey && !simklDisc) {
          localStorage.setItem('myListAddon:simklKey', synced.keys.simklKey);
          const el = document.getElementById('simklKeyInput');
          if (el) el.value = synced.keys.simklKey;
        } else if (simklDisc) {
          localStorage.removeItem('myListAddon:simklKey');
          const el = document.getElementById('simklKeyInput');
          if (el) el.value = '';
        } else if (localStorage.getItem('myListAddon:simklKey')) {
          needPushSync = true;
        }

        if (synced.keys.simklAccessToken && !simklDisc) {
          localStorage.setItem('myListAddon:simklAccessToken', synced.keys.simklAccessToken);
          window.simklAccessToken = synced.keys.simklAccessToken;
          simklAccessToken = synced.keys.simklAccessToken;
        } else if (simklDisc) {
          localStorage.removeItem('myListAddon:simklAccessToken');
          window.simklAccessToken = '';
          simklAccessToken = '';
        } else if (localStorage.getItem('myListAddon:simklAccessToken')) {
          needPushSync = true;
        }

        if (synced.keys.simklUsername && !simklDisc) {
          localStorage.setItem('myListAddon:simklUsername', synced.keys.simklUsername);
          window.simklUsername = synced.keys.simklUsername;
          simklUsername = synced.keys.simklUsername;
        } else if (simklDisc) {
          localStorage.removeItem('myListAddon:simklUsername');
          window.simklUsername = '';
          simklUsername = '';
        } else if (localStorage.getItem('myListAddon:simklUsername')) {
          needPushSync = true;
        }

        if (typeof synced.keys.syncTraktHistory === 'boolean') {
          localStorage.setItem('myListAddon:syncTraktHistory', synced.keys.syncTraktHistory ? 'true' : 'false');
        }
        if (typeof synced.keys.syncMdblistHistory === 'boolean') {
          localStorage.setItem('myListAddon:syncMdblistHistory', synced.keys.syncMdblistHistory ? 'true' : 'false');
        }
        if (typeof synced.keys.syncSimklHistory === 'boolean') {
          localStorage.setItem('myListAddon:syncSimklHistory', synced.keys.syncSimklHistory ? 'true' : 'false');
        }
        if (typeof updateConnectionStatusBadges === 'function') updateConnectionStatusBadges();
        if (typeof renderTraktConnectStatus === 'function') renderTraktConnectStatus();
        if (typeof renderMdblistConnectStatus === 'function') renderMdblistConnectStatus();
        if (typeof renderSimklConnectStatus === 'function') renderSimklConnectStatus();
        if (!isBackgroundResume) {
          if (typeof scheduleMyTmdbListsRefresh === 'function') scheduleMyTmdbListsRefresh();
          if (typeof scheduleMyMdblistListsRefresh === 'function') scheduleMyMdblistListsRefresh();
          if (typeof scheduleMyTraktListsRefresh === 'function') scheduleMyTraktListsRefresh();
          if (typeof scheduleMySimklListsRefresh === 'function') scheduleMySimklListsRefresh();
        }
        if (needPushSync && typeof pushCreatorSync === 'function') pushCreatorSync();
      } catch (e) {}
    }

    // Restore UI settings from synced.keys -- these are sent by collectKeys()
    // on every pushCreatorSync but were never applied back to the DOM on load,
    // so signing in from a different browser left them at their defaults.
    if (synced.keys && typeof synced.keys === 'object') {
      if (typeof synced.keys.hideNonDigitalReleases === 'boolean') {
        const cb = document.getElementById('hideNonDigitalReleasesCheckbox');
        if (cb) cb.checked = synced.keys.hideNonDigitalReleases;
        try { localStorage.setItem('myListAddon:hideNonDigitalReleases', synced.keys.hideNonDigitalReleases ? '1' : '0'); } catch (e) {}
      }
      if (typeof synced.keys.shuffleShelves === 'boolean') {
        const el = document.getElementById('shuffleShelvesCheckbox');
        if (el) el.checked = synced.keys.shuffleShelves;
      }
      if (typeof synced.keys.shuffleItems === 'boolean') {
        const el = document.getElementById('shuffleItemsCheckbox');
        if (el) el.checked = synced.keys.shuffleItems;
      }
      if (synced.keys.region) {
        const el = document.getElementById('regionSelect');
        if (el) el.value = synced.keys.region;
        try { localStorage.setItem('myListAddon:region', synced.keys.region); } catch (e) {}
      }
      const badgeKeys = [
        { key: 'showBadgesAiringNext', id: 'badgeAiringNextCheckbox' },
        { key: 'showBadgesContinueWatching', id: 'badgeContinueWatchingCheckbox' },
        { key: 'showBadgesCatalogs', id: 'badgeCatalogsCheckbox' },
        { key: 'showBadgesStremioAiringNext', id: 'badgeStremioAiringNextCheckbox' },
        { key: 'showBadgesStremioContinueWatching', id: 'badgeStremioContinueWatchingCheckbox' },
        { key: 'showBadgesStremioCatalogs', id: 'badgeStremioCatalogsCheckbox' },
        { key: 'showBadgesStremio', id: 'badgeStremioCheckbox' },
        { key: 'showBadgeAirDate', id: 'badgeAirDateCheckbox' },
        { key: 'showBadgeSeasonPremiere', id: 'badgeSeasonPremiereCheckbox' },
        { key: 'showBadgeSeasonFinale', id: 'badgeSeasonFinaleCheckbox' },
        { key: 'showBadgeSeasonFinaleDate', id: 'badgeSeasonFinaleDateCheckbox' },
        { key: 'showBadgeRating', id: 'badgeRatingCheckbox' },
        { key: 'showBadgeWatched', id: 'badgeWatchedCheckbox' },
      ];
      badgeKeys.forEach(({ key, id }) => {
        if (typeof synced.keys[key] === 'boolean') {
          try { localStorage.setItem('myListAddon:' + key, synced.keys[key] ? '1' : '0'); } catch (e) {}
          const el = document.getElementById(id);
          if (el) el.checked = synced.keys[key];
        }
      });
    }

    // Watch History / Continue Watching -- merge server tracking items with
    // any local-only items so server scrobbles take immediate precedence without
    // losing un-pushed local edits.
    let touchedTracking = false;
    if (!isBackgroundResume || trackingChanged) {
      let isRecentRemoval = false;
      try {
        const lastRemovalStr = localStorage.getItem('myListAddon:lastIntentionalRemoval');
        if (lastRemovalStr && Date.now() - parseInt(lastRemovalStr, 10) < 30000) {
          isRecentRemoval = true;
        }
      } catch(e) {}

      if (Array.isArray(synced.watchHistory)) {
        const serverItems = synced.watchHistory;
        const localWH = loadLocalCustomLists()['watch-history'];
        const localWHItems = (localWH && Array.isArray(localWH.items)) ? localWH.items : [];
        const serverIds = new Set(serverItems.map((it) => String(it && (it.id || it.imdbId))));
        const localOnlyWH = localWHItems.filter((it) => it && !serverIds.has(String(it.id || it.imdbId)));
        
        let mergedWH = [...serverItems, ...localOnlyWH];
        if (isRecentRemoval) {
          mergedWH = localWHItems;
        }

        const wh = getOrCreateWatchHistoryList();
        wh.items = mergedWH;
        wh.updatedAt = Date.now();
        const map = loadLocalCustomLists();
        map['watch-history'] = wh;
        saveLocalCustomListsMap(map);
        const watchedIds = new Set();
        mergedWH.forEach((it) => {
          if (!it) return;
          if (it.id) watchedIds.add(String(it.id));
          if (it.imdbId) watchedIds.add(String(it.imdbId));
          if (it.tmdbId) {
            watchedIds.add(String(it.tmdbId));
            watchedIds.add('tmdb:' + it.tmdbId);
          }
          if (it.type === 'episode' && it.seasonNum != null && it.episodeNum != null) {
            if (it.showId) watchedIds.add(String(it.showId) + ':' + it.seasonNum + ':' + it.episodeNum);
            if (it.showTitle) watchedIds.add(String(it.showTitle) + ':' + it.seasonNum + ':' + it.episodeNum);
          }
        });
        window._watchedItemIds = watchedIds;
        window._rawWatchHistoryItems = mergedWH;

        if (localOnlyWH.length > 0 && typeof scheduleTrackingSync === 'function') {
          scheduleTrackingSync();
        }
        touchedTracking = true;
      }
      if (Array.isArray(synced.continueWatching)) {
        const serverCW = dedupeContinueWatchingItems(synced.continueWatching);
        const localCW = loadLocalCustomLists()['continue-watching'];
        const localCWItems = (localCW && Array.isArray(localCW.items)) ? localCW.items : [];
        const serverShowIds = new Set(serverCW.map((it) => String(it && it.showId)).filter(Boolean));
        
        const localOnlyCW = localCWItems.filter((it) => it && (!it.showId || !serverShowIds.has(String(it.showId))));
        let mergedCW = dedupeContinueWatchingItems([...serverCW, ...localOnlyCW]);
        if (isRecentRemoval) {
          mergedCW = localCWItems;
        }

        const cw = getOrCreateContinueWatchingList();
        cw.items = mergedCW;
        cw.updatedAt = Date.now();
        const map = loadLocalCustomLists();
        map['continue-watching'] = cw;
        saveLocalCustomListsMap(map);
        window._inProgressShowIds = new Set(mergedCW.map((it) => String(it && it.showId)).filter(Boolean));

        if (localOnlyCW.length > 0 && typeof scheduleTrackingSync === 'function') {
          scheduleTrackingSync();
        }
        touchedTracking = true;
      }
      if (Array.isArray(synced.watchlist)) {
        const map = loadLocalCustomLists();
        backfillAutoTrackedListSlugs(map);
        const localWL = map['watchlist'] || { items: [], updatedAt: 0 };
        const serverItems = synced.watchlist;
        const localItems = (localWL && Array.isArray(localWL.items)) ? localWL.items : [];
        
        const serverIds = new Set(serverItems.map((it) => String(it && (it.id || it.imdbId))));
        const localOnly = localItems.filter((it) => it && !serverIds.has(String(it.id || it.imdbId)));
        const mergedWL = [...serverItems, ...localOnly];

        map['watchlist'].items = mergedWL;
        map['watchlist'].updatedAt = Date.now();
        saveLocalCustomListsMap(map);

        if (localOnly.length > 0 && typeof pushTrackingSync === 'function') {
          pushTrackingSync();
        }
        touchedTracking = true;
      }
      // Adopted only when this browser has nothing of its own. The
      // server copy is whatever some browser last rendered; if this one
      // has already rendered its own, that is the fresher of the two and
      // opening Discover will push it back up anyway.
      if (synced.curatedRecommendations && typeof synced.curatedRecommendations === 'object') {
        const serverRecs = synced.curatedRecommendations;
        const localRecs = loadCuratedRecommendations();
        const serverHas = (Array.isArray(serverRecs.movies) && serverRecs.movies.length) ||
          (Array.isArray(serverRecs.shows) && serverRecs.shows.length);
        const localHas = !!(localRecs && (((localRecs.movies || []).length) || ((localRecs.shows || []).length)));
        if (serverHas && !localHas) {
          try {
            localStorage.setItem(CURATED_RECS_KEY, JSON.stringify(serverRecs));
          } catch (e) {}
        }
      }
      if (Array.isArray(synced.airingNext)) {
        const map = loadLocalCustomLists();
        const currentAN = map['airing-next'] || { slug: 'airing-next', name: 'Airing Next', type: 'series', items: [] };
        const localAiringCount = Array.isArray(currentAN.items) ? currentAN.items.length : 0;
        if (synced.airingNext.length || !localAiringCount) {
          currentAN.items = synced.airingNext;
          currentAN.updatedAt = Date.now();
          map['airing-next'] = currentAN;
          saveLocalCustomListsMap(map);
          touchedTracking = true;
        } else {
          // The account has no Airing Next but this browser has computed
          // one, so this browser's copy is the only one that exists --
          // send it up rather than taking the empty one.
          //
          // This is also the one reliable moment to do it. Airing Next is
          // only ever pushed by the refresh that builds it, and that
          // refresh runs on a load timer that routinely wins the race
          // against sign-in restoring activeCreator -- pushTrackingSync
          // bails when it is not set yet, and the list is left cached
          // locally as fresh, so every later load short-circuits the
          // refresh and never pushes either. The account stayed empty
          // indefinitely while this browser's own dashboard card looked
          // fine, which is exactly what made the autotrack:airing-next
          // row (and the Live Preview of it) report no items while the
          // signed-out snapshot version of the same list worked. Here
          // activeCreator is set by definition, so the push lands.
          if (typeof scheduleTrackingSync === 'function') scheduleTrackingSync();
        }
      }
      if (Array.isArray(synced.fullyWatchedShowIds)) {
        window._fullyWatchedShowIds = new Set(synced.fullyWatchedShowIds.map(String));
        try {
          localStorage.setItem('myListAddon:fullyWatchedShows', JSON.stringify(synced.fullyWatchedShowIds));
        } catch (e) {}
      }
      if (!isRecentRemoval && synced.dismissedContinueWatching && typeof synced.dismissedContinueWatching === 'object') {
        window._dismissedContinueWatching = synced.dismissedContinueWatching;
        try {
          localStorage.setItem('myListAddon:dismissedContinueWatching', JSON.stringify(synced.dismissedContinueWatching));
        } catch (e) {}
      }
      if (Array.isArray(synced.dashboardListOrder) && synced.dashboardListOrder.length) {
        try {
          localStorage.setItem('myListAddon:dashboardListOrder', JSON.stringify(synced.dashboardListOrder));
        } catch (e) {}
        touchedTracking = true;
      }
    }
    if (touchedTracking) {
      if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard({ silent: true });
      if (typeof renderMyCustomListsList === 'function') renderMyCustomListsList();
      if (typeof renderWatchHistoryGrid === 'function') renderWatchHistoryGrid();
      if (typeof renderContinueWatchingGrid === 'function') renderContinueWatchingGrid();
    }
    try { if (typeof cleanWatchedFromWatchlists === 'function') cleanWatchedFromWatchlists(); } catch (e) {}

    suppressSave = true;
    saveState();
    suppressSave = false;
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
    '<div class="row"><input type="text" id="createProfileNameInput" placeholder="Choose a Username" maxlength="25"></div>' +
    '<div class="row" style="margin-top:8px;"><input type="text" id="createProfileDisplayInput" placeholder="Display name (optional)" maxlength="40"></div>' +
    '<div class="row" style="margin-top:8px;"><input type="text" id="createProfileRecoveryInput" placeholder="Recovery Answer (optional)"></div>' +
    '<p class="modal-sub" style="font-size:0.78rem; margin-top:4px;">If you ever lose your key, this is the only way back in besides contacting us. Use something only you know -- not a public username or anything someone could look up.</p>' +
    '<div id="createProfileError"></div>' +
    '<div class="actions" style="margin-top:14px;">' +
    '<button type="button" class="primary" onclick="submitCreateProfile()">Create Account</button>' +
    '<button type="button" class="secondary" onclick="closeModal(); openRestoreModal();">Already have one? Login</button>' +
    '</div>'
  );
}

async function submitCreateProfile() {
  const name = document.getElementById('createProfileNameInput').value.trim();
  const displayInput = document.getElementById('createProfileDisplayInput');
  const displayName = displayInput ? displayInput.value.trim() : '';
  const recoveryAnswer = document.getElementById('createProfileRecoveryInput').value.trim();
  const errBox = document.getElementById('createProfileError');
  if (!name) {
    errBox.innerHTML = '<p class="testresult err">Enter a username.</p>';
    return;
  }
  try {
    const res = await fetch(ORIGIN + '/api/creator/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creatorName: name, displayName: displayName || undefined, recoveryAnswer: recoveryAnswer || undefined }),
    });
    const data = await res.json();
    if (!data.ok) {
      errBox.innerHTML = '<p class="testresult err">' +
        escapeHtml(data.error === 'no-kv' ? 'This Worker has no CONFIGS KV namespace bound.' : (data.error || 'Could not create profile.')) + '</p>';
      return;
    }
    activeCreator = { creatorName: data.creatorName, displayName: data.displayName };
    localStorage.setItem('myListAddon:creatorName', data.creatorName);
    localStorage.setItem('myListAddon:creatorDisplayName', data.displayName || data.creatorName);
    localStorage.setItem('myListAddon:creatorKey', data.creatorKey);
    renderCreatorProfileBar();
    renderAccountKeySection();
    renderWatchlistPreferencesSection();
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
    '<h2>Profile Created</h2>' +
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
      '<p style="margin:0 0 16px; font-size:0.88rem; color:var(--muted);">Choose visibility for <strong>' + escapeHtml(ctx.name || 'Custom List') + '</strong> on your Profile.</p>' +
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
        '<strong>' + escapeHtml(listName || 'Custom List') + '</strong> has been saved to your Profile as a <strong>' + (isPrivate ? 'private' : 'public') + '</strong> list.' +
      '</p>' +
      (isPrivate
        ? '<div style="padding:12px 14px; background:rgba(0,122,255,0.08); border:1px solid rgba(0,122,255,0.2); border-radius:10px; margin-bottom:16px;">' +
            '<p style="margin:0; font-size:0.84rem; color:var(--text);">Only you can see this list from your profile when logged in.</p>' +
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

// Joins an already-in-flight /api/creator/lists request instead of starting
// a second one.
//
// renderCreatorDashboard is routinely invoked twice in immediate succession
// -- sign-in and restore both call it and then call loadCreatorSync, which
// calls it again itself -- and each invocation was its own POST. That
// endpoint returns the FULL items array for every list the account owns, so
// for anyone with large Custom Lists the duplicate was megabytes of
// identical data plus a second key verification, every time.
//
// Deliberately in-flight only, with no time-based cache. A request that
// begins after the previous one has finished always goes to the network, so
// this can never serve a stale list -- which matters because saving,
// deleting or reordering a list re-renders the dashboard immediately
// afterwards and must see the change. It only ever collapses calls that
// genuinely overlap, where the second was going to receive the same bytes
// as the first regardless.
let _creatorListsInFlight = null;
// The last full response, kept so an unchanged reply can be answered from
// memory. Nothing mutates lastCreatorListsData in place -- every consumer
// only reads it (find/forEach) -- so handing back the same object is safe
// rather than a shared-mutable-state trap.
let _lastCreatorListsResponse = null;
let _creatorListsVersion = '';

// Cleared whenever the cached lists are dropped, so the browser can never
// claim to hold a version it no longer has.
function resetCreatorListsCache() {
  _lastCreatorListsResponse = null;
  _creatorListsVersion = '';
}

async function fetchCreatorListsOnce(creatorKey) {
  if (_creatorListsInFlight) return await _creatorListsInFlight;
  const p = (async () => {
    // Only claim a version if the data that version describes is still
    // here; otherwise an "unchanged" reply would leave nothing to render.
    const canReuse = !!(_creatorListsVersion && _lastCreatorListsResponse && Array.isArray(lastCreatorListsData));
    const res = await fetch(ORIGIN + '/api/creator/lists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creatorName: activeCreator.creatorName,
        creatorKey: creatorKey,
        knownVersion: canReuse ? _creatorListsVersion : '',
      }),
    });
    const data = await res.json();
    if (data && data.ok && data.unchanged) {
      // Nothing changed server-side -- reuse the copy already in memory.
      if (canReuse) return _lastCreatorListsResponse;
      // Should be unreachable (the version was only sent when reusable),
      // but if it ever happens, ask again without a version rather than
      // returning a response with no lists in it.
      resetCreatorListsCache();
      const retry = await fetch(ORIGIN + '/api/creator/lists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ creatorName: activeCreator.creatorName, creatorKey: creatorKey }),
      });
      const retryData = await retry.json();
      if (retryData && retryData.ok) {
        _lastCreatorListsResponse = retryData;
        _creatorListsVersion = retryData.version || '';
      }
      return retryData;
    }
    if (data && data.ok) {
      _lastCreatorListsResponse = data;
      _creatorListsVersion = data.version || '';
    } else {
      resetCreatorListsCache();
    }
    return data;
  })();
  _creatorListsInFlight = p;
  try {
    return await p;
  } finally {
    _creatorListsInFlight = null;
  }
}

// --- Recovering lists the browser lost --------------------------------------
// A signed-in account keeps every Custom List as its own server-side record
// (creatorlist:<user>:<slug>), and since the quota fix those records are
// written even when localStorage refuses. But nothing ever wrote them BACK.
// The reconciliation further down only ever flowed row -> server and
// row -> local, and it is driven by iterating the rows currently in the
// page, so a list that had disappeared from localStorage entirely was never
// even considered -- the dashboard would render it from the server response
// while the local map, which is what catalog rows, See All and editing all
// read, stayed empty.
//
// That is the whole remaining gap, and it is why this is a backfill rather
// than the much larger change of making the server authoritative at runtime.
// The data is already in the response the dashboard just fetched; it costs
// nothing to put it back.
const DELETED_CREATOR_LISTS_KEY = 'myListAddon:deletedCreatorLists';
const DELETED_TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;

function loadDeletedCreatorLists() {
  try {
    const raw = localStorage.getItem(DELETED_CREATOR_LISTS_KEY);
    const map = raw ? JSON.parse(raw) : {};
    if (!map || typeof map !== 'object') return {};
    // Tombstones expire. Keeping them forever would mean a list deleted a
    // year ago could never be recovered from the account if the browser
    // cache were later lost for an unrelated reason.
    const now = Date.now();
    let changed = false;
    Object.keys(map).forEach((k) => {
      if (!(now - (Number(map[k]) || 0) < DELETED_TOMBSTONE_TTL_MS)) { delete map[k]; changed = true; }
    });
    if (changed) { try { localStorage.setItem(DELETED_CREATOR_LISTS_KEY, JSON.stringify(map)); } catch (e) {} }
    return map;
  } catch (e) {
    return {};
  }
}

// Called when a list is deleted, BEFORE the server confirms.
//
// One of the two delete paths removes the list locally and then fires the
// server delete without waiting for it (.catch(() => {})). If that request
// never lands, the list survives on the server while being gone locally --
// which is exactly the shape the backfill below would read as "lost" and
// helpfully restore. Resurrecting a list somebody deliberately deleted is a
// bug this project has already had once, so the tombstone is recorded at
// request time rather than on success.
function recordCreatorListDeletion(slug) {
  if (!slug) return;
  try {
    const map = loadDeletedCreatorLists();
    map[String(slug)] = Date.now();
    localStorage.setItem(DELETED_CREATOR_LISTS_KEY, JSON.stringify(map));
  } catch (e) {}
}
window.recordCreatorListDeletion = recordCreatorListDeletion;

// Matches the way the delete paths look a list up: a local entry can be
// keyed by its map key while carrying the slug under any of several fields.
function localMapHasList(map, slug) {
  if (!map || !slug) return false;
  if (map[slug]) return true;
  return Object.keys(map).some((k) => {
    const l = map[k];
    return !!l && (l.slug === slug || l.creatorSlug === slug || l.localSlug === slug || l.listSlug === slug);
  });
}

// The auto-tracked lists are generated locally from watch state, not owned by
// the account in the same way. Writing a server copy over them would fight
// the tracking code for control of the same slug.
const BACKFILL_SKIP_SLUGS = new Set(['watchlist', 'watch-history', 'continue-watching', 'airing-next']);

// Restores lists that exist on the account but are missing from this
// browser. Deliberately narrow: it only ever ADDS a list that is entirely
// absent. It never merges items into a list that already exists locally,
// because a local copy may legitimately be ahead of the server (an edit made
// while offline), and picking a winner there is a different problem with a
// different right answer.
function backfillCreatorListsIntoLocalMap(serverLists) {
  if (!Array.isArray(serverLists) || !serverLists.length) return 0;
  if (typeof loadLocalCustomLists !== 'function' || typeof saveLocalCustomListsMap !== 'function') return 0;
  const map = loadLocalCustomLists();
  const tombstones = loadDeletedCreatorLists();
  const restored = [];
  serverLists.forEach((l) => {
    if (!l || !l.slug) return;
    if (BACKFILL_SKIP_SLUGS.has(l.slug)) return;
    if (tombstones[l.slug]) return;
    if (localMapHasList(map, l.slug)) return;
    if (!Array.isArray(l.items)) return;
    map[l.slug] = {
      slug: l.slug,
      creatorSlug: l.slug,
      name: l.name || l.slug,
      type: l.type || 'mixed',
      items: l.items,
      visibility: l.visibility || 'private',
      createdAt: l.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    restored.push(l.slug);
  });
  if (!restored.length) return 0;
  saveLocalCustomListsMap(map);
  console.info('Restored ' + restored.length + ' list(s) from your account that were missing from this browser:', restored.join(', '));
  return restored.length;
}
window.backfillCreatorListsIntoLocalMap = backfillCreatorListsIntoLocalMap;

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
    const data = await fetchCreatorListsOnce(creatorKey);
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

    // Sync items from live Catalog rows if the row contains more items
    let hasLocalUpdates = false;
    const localMapForCreator = loadLocalCustomLists();
    document.querySelectorAll('#lists .entry').forEach((entry) => {
      const urlInput = entry.querySelector('.url');
      if (!urlInput || !urlInput.value.startsWith('customlist:v1:')) return;
      try {
        const rowPayload = JSON.parse(urlInput.value.slice('customlist:v1:'.length));
        const slug = rowPayload.creatorSlug || rowPayload.localSlug || rowPayload.listSlug;
        if (!slug || !Array.isArray(rowPayload.items) || !rowPayload.items.length) return;
        const sList = (data.lists || []).find(l => l && l.slug === slug);
        if (sList && rowPayload.items.length > (sList.items || []).length) {
          sList.items = rowPayload.items;
          sList.itemCount = rowPayload.items.length;
          fetch(ORIGIN + '/api/creator/lists/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              creatorName: activeCreator.creatorName,
              creatorKey: creatorKey,
              slug: slug,
              name: sList.name,
              type: sList.type || rowPayload.type || 'movie',
              items: rowPayload.items,
              visibility: sList.visibility || 'private',
            })
          }).catch(() => {});
        }
        if (localMapForCreator[slug] && rowPayload.items.length > (localMapForCreator[slug].items || []).length) {
          localMapForCreator[slug].items = rowPayload.items;
          localMapForCreator[slug].updatedAt = Date.now();
          hasLocalUpdates = true;
        }
      } catch (e) {}
    });
    if (hasLocalUpdates) saveLocalCustomListsMap(localMapForCreator);

    // ...and the other direction: anything the account has that this browser
    // has lost. See backfillCreatorListsIntoLocalMap for why this is an
    // add-only operation.
    try { backfillCreatorListsIntoLocalMap(data.lists || []); } catch (e) {}
    
    const autoTracked = renderAutoTrackedListsHtml();
    lastLocalCustomListsData = autoTracked.lists;

    function buildServerListCardHtml(l) {
      if (!l) return '';
      const shareBtn = l.visibility === 'private'
        ? ''
        : '<button type="button" class="lc-btn secondary creatorListShareBtn" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '">Share</button>';
      const isWatchlist = l.slug === 'watchlist' || l.isWatchlist || (l.name && String(l.name).toLowerCase() === 'watchlist');
      const deleteBtnHtml = isWatchlist ? '' : '<button type="button" class="lc-btn secondary creatorListDeleteBtn" data-slug="' + escapeAttr(l.slug) + '">Delete</button>';
      
      const matchingRow = document.querySelector('#lists .entry .url[value*="' + l.slug + '"]');
      if (matchingRow && matchingRow.value.startsWith('customlist:v1:')) {
        try {
          const rp = JSON.parse(matchingRow.value.slice('customlist:v1:'.length));
          if (Array.isArray(rp.items) && rp.items.length > (l.items || []).length) {
            l.items = rp.items;
            l.itemCount = rp.items.length;
          }
        } catch (e) {}
      }

      const resolveItemPoster = (it) => {
        if (!it) return '';
        let p = it.poster || it.showPoster;
        if (!p) {
          const epId = String(it.id || '');
          const sId = it.showId || (epId.startsWith('tt') && epId.includes(':') ? epId.split(':')[0] : (it.imdbId || it.id));
          if (sId && String(sId).startsWith('tt')) {
            p = 'https://images.metahub.space/poster/medium/' + sId + '/img';
          }
        }
        return p || '';
      };
      const allPosters = (l.items || []).slice(0, 9).filter((it) => it && resolveItemPoster(it));
      const totalCount = l.itemCount || (l.items || []).length || allPosters.length;
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
        const itemPoster = resolveItemPoster(it);
        const label = formatWatchItemLabel(it);
        const posterEl = itemPoster
          ? '<img src="' + escapeAttr(itemPoster) + '" class="clickable-poster" data-id="' + escapeAttr(it.showId || it.imdbId || it.id || (it.tmdbId ? ('tmdb:' + it.tmdbId) : '')) + '" data-type="' + escapeAttr(posterType) + '" data-title="' + escapeAttr(label.title || it.showTitle || it.title || it.name || '') + '" alt="" loading="lazy" onerror="handlePosterImgError(this)">'
          : '<div class="live-preview-poster live-preview-poster-placeholder" data-needs-fallback="1" style="width:100%;height:100%;"><small style="color:var(--muted); font-size:0.7rem;">No poster</small></div>';
        return '<div class="list-card-mini-poster-tile" data-id="' + escapeAttr(it.showId || it.imdbId || it.id || '') + '" data-type="' + escapeAttr(posterType) + '" data-title="' + escapeAttr(label.title || it.showTitle || it.title || it.name || '') + '">' +
          '<div class="list-card-mini-poster-img-wrap">' +
            posterEl +
            removeBtn +
            overlays +
          '</div>' +
          '<div class="list-card-mini-poster-name">' + escapeHtml(label.title || it.title || it.name || '') + '</div>' +
          (label.subtitle ? '<div class="list-card-mini-poster-subtitle">' + escapeHtml(label.subtitle) + '</div>' : '') +
          (it.year ? '<div class="list-card-mini-poster-year">' + escapeHtml(it.year) + '</div>' : '') +
        '</div>';
      }).join('');
      const isAdded = typeof isListAddedToConfig === 'function' ? isListAddedToConfig(null, l.type, l.slug) : false;
      return '<div class="list-card creator-list-row" draggable="true" data-slug="' + escapeAttr(l.slug) + '">' +
        '<div class="list-card-header">' +
          '<div class="list-card-body creatorListViewBtn" data-slug="' + escapeAttr(l.slug) + '" data-name="' + escapeAttr(l.name) + '" data-type="' + escapeAttr(l.type) + '" style="cursor:pointer;">' +
            '<div class="list-card-title">' +
              '<span class="drag-handle-list" title="Drag to reorder" onclick="event.stopPropagation();">&#x2630;</span>' +
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

    const serverCustomLists = (data.lists || []).filter((l) => l && l.slug !== 'watchlist' && l.slug !== 'watch-history' && l.slug !== 'continue-watching');
    const serverWatchlist = (data.lists || []).find((l) => l && (l.slug === 'watchlist' || l.isWatchlist || (l.name && l.name.toLowerCase() === 'watchlist')));
    if (serverWatchlist) {
      const localMap = loadLocalCustomLists();
      if (localMap['watchlist']) {
        if (serverWatchlist.visibility) localMap['watchlist'].visibility = serverWatchlist.visibility;
        if (serverWatchlist.likes != null) localMap['watchlist'].likes = serverWatchlist.likes;
        if (serverWatchlist.url) localMap['watchlist'].url = serverWatchlist.url;
        saveLocalCustomListsMap(localMap);
      }
    }

    // Merge any local/restored custom lists that are not yet on the server
    const serverSlugs = new Set((data.lists || []).map(l => l.slug));
    const localRestoredCustomLists = [];
    Object.keys(localMapForCreator || {}).forEach((k) => {
      if (k === 'watchlist' || k === 'watch-history' || k === 'continue-watching' || k === 'airing-next') return;
      const l = localMapForCreator[k];
      if (!l) return;
      if (!l.slug) l.slug = k;
      if (!serverSlugs.has(l.slug)) {
        localRestoredCustomLists.push(l);
        if (activeCreator && creatorKey) {
          fetch(ORIGIN + '/api/creator/lists/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              creatorName: activeCreator.creatorName,
              creatorKey: creatorKey,
              slug: l.slug,
              name: l.name || l.slug,
              type: l.type || 'movie',
              items: l.items || [],
              visibility: l.visibility || 'private',
            })
          }).catch(() => {});
        }
      }
    });

    const allDashboardLists = [
      ...serverCustomLists.map((l) => ({ isServer: true, list: l })),
      ...localRestoredCustomLists.map((l) => ({ isServer: false, list: l })),
      ...(autoTracked.lists || []).map((l) => ({ isServer: false, list: l })),
    ];
    // Airing Next is local-only (see its own comment, 21_client-custom-
    // list-builder.js) -- folded into the same array (rather than its own
    // separate card type) purely so it sorts and drags alongside every
    // other card via the shared savedOrder/persistCreatorListOrderFromDom
    // machinery below; buildAiringNextCardHtml (unlike buildServerListCardHtml/
    // buildLocalListCardHtml) takes no arguments, so "list" here is just a
    if (typeof collectAiringNextCandidateShowIds === 'function' && collectAiringNextCandidateShowIds().size && typeof buildAiringNextCardHtml === 'function') {
      allDashboardLists.push({ isAiringNext: true, list: { slug: 'airing-next' } });
    }

    const visibleDashboardLists = (typeof isListHidden === 'function') ? allDashboardLists.filter((item) => !isListHidden(item.list && item.list.slug)) : allDashboardLists;

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
      visibleDashboardLists.sort((a, b) => {
        const slugA = (a && a.list && a.list.slug) || '';
        const slugB = (b && b.list && b.list.slug) || '';
        const posA = (slugA && orderMap.has(slugA)) ? orderMap.get(slugA) : 9999;
        const posB = (slugB && orderMap.has(slugB)) ? orderMap.get(slugB) : 9999;
        return posA - posB;
      });
    }

    const rowsHtml = visibleDashboardLists.length
      ? visibleDashboardLists.map((item) => {
          if (!item) return '';
          if (item.isAiringNext) return (typeof buildAiringNextCardHtml === 'function' ? buildAiringNextCardHtml() : '');
          if (item.isServer) return buildServerListCardHtml(item.list);
          return buildLocalListCardHtml(item.list);
        }).filter(Boolean).join('')
      : '<p><small>No lists yet \u2014 build one under Create List to get started.</small></p>';

    const prevScrollTop = box.scrollTop;
    box.innerHTML = '<div id="creatorListRows" style="margin-bottom:14px;">' + rowsHtml + '</div>';
    if (prevScrollTop) box.scrollTop = prevScrollTop;
    document.querySelectorAll('#creatorListRows .drag-handle-list').forEach((h) => initCreatorListTouchDrag(h));
    if (typeof renderHiddenListsSettingsSection === 'function') renderHiddenListsSettingsSection();
  } catch (e) {
    console.error('renderCreatorDashboard error:', e);
    if (!hasExistingContent) {
      box.innerHTML = '<p class="testresult err">\u2717 Network error loading your lists.</p>';
    }
  }
}

function formatWatchItemLabel(it) {
  if (!it) return { title: '', subtitle: '' };
  const epTitle = it.name || it.episodeTitle || (it.title !== it.showTitle ? it.title : '') || ((it.isSeasonPremiere && it.seasonNum != null && it.seasonNum > 1) ? 'Season Premiere' : (it.episodeNum != null ? ('Episode ' + it.episodeNum) : '')) || '';
  if (it.showTitle && it.seasonNum != null && it.episodeNum != null) {
    const s = String(it.seasonNum).padStart(2, '0');
    const e = String(it.episodeNum).padStart(2, '0');
    return { title: it.showTitle + ' S' + s + 'E' + e, subtitle: epTitle };
  }
  if (it.showTitle) {
    return { title: it.showTitle, subtitle: epTitle };
  }
  return { title: it.title || it.name || '', subtitle: '' };
}

function buildLocalListCardHtml(l) {
  if (!l) return '';
  const isAutoTracked = l.slug === 'watch-history' || l.slug === 'continue-watching';
  const isWatchlist = l.slug === 'watchlist' || l.isWatchlist || (l.name && String(l.name).toLowerCase() === 'watchlist');
  const liveMap = (typeof loadLocalCustomLists === 'function') ? loadLocalCustomLists() : null;
  const liveEntry = (liveMap && l.slug) ? liveMap[l.slug] : null;
  if (liveEntry && Array.isArray(liveEntry.items)) {
    l.items = liveEntry.items;
    if (liveEntry.visibility) l.visibility = liveEntry.visibility;
    if (liveEntry.type && !l.type) l.type = liveEntry.type;
  }
  const resolveItemPoster = (it) => {
    if (!it) return '';
    let p = l.slug === 'continue-watching' ? (it.showPoster || it.poster) : (it.poster || it.showPoster);
    if (!p) {
      const epId = String(it.id || '');
      const sId = it.showId || (epId.startsWith('tt') && epId.includes(':') ? epId.split(':')[0] : (it.imdbId || it.id));
      if (sId && String(sId).startsWith('tt')) {
        p = 'https://images.metahub.space/poster/medium/' + sId + '/img';
      }
    }
    return p || '';
  };
  const itemCount = (l.items || []).length;
  const allPosters = (l.items || []).slice(0, 9).filter((it) => it && resolveItemPoster(it));
  const totalCount = itemCount || allPosters.length;
  const posterThumbs = allPosters.map((it, i) => {
    if (!it) return '';
    const isMobileEnd = (i === 2 && allPosters.length > 3);
    const isDesktopEnd = (i === allPosters.length - 1 && allPosters.length >= 4);
    let overlays = '';
    if (isMobileEnd) {
      overlays += '<div class="list-card-count-overlay mobile-only localListViewBtn" data-slug="' + escapeAttr(l.slug) + '" data-name="' + escapeAttr(l.name) + '" data-type="' + escapeAttr(l.type) + '" style="cursor:pointer;">' + totalCount + ' &rsaquo;</div>';
    }
    if (isDesktopEnd) {
        overlays += '<div class="list-card-count-overlay desktop-only localListViewBtn" data-slug="' + escapeAttr(l.slug) + '" data-name="' + escapeAttr(l.name) + '" data-type="' + escapeAttr(l.type) + '" style="cursor:pointer;">' + totalCount + ' &rsaquo;</div>';
    }
    const posterId = it.showId || it.imdbId || it.id || '';
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
    const itemPoster = resolveItemPoster(it);
    const isAiringList = l.slug === 'airing-next' || l.statusKey === 'airing-next';
    const isCwList = l.slug === 'continue-watching' || l.statusKey === 'continue-watching';
    const showLocationBadges = typeof getBadgeSetting === 'function'
      ? (isAiringList ? getBadgeSetting('showBadgesAiringNext') : (isCwList ? getBadgeSetting('showBadgesContinueWatching') : getBadgeSetting('showBadgesCatalogs')))
      : true;
    const showAirDate = showLocationBadges && (typeof getBadgeSetting === 'function' ? getBadgeSetting('showBadgeAirDate') : true);
    const showPremiere = showLocationBadges && (typeof getBadgeSetting === 'function' ? getBadgeSetting('showBadgeSeasonPremiere') : true);
    const showFinale = showLocationBadges && (typeof getBadgeSetting === 'function' ? getBadgeSetting('showBadgeSeasonFinale') : true);
    const showFinaleDate = showLocationBadges && (typeof getBadgeSetting === 'function' ? getBadgeSetting('showBadgeSeasonFinaleDate') : true);

    const airingList = (isCwList && typeof loadLocalCustomLists === 'function') ? ((loadLocalCustomLists()['airing-next'] || {}).items || []) : [];
    const airingMatch = airingList.find((a) => {
      if (!a) return false;
      const aShowId = String(a.showId || a.id || '').split(':')[0];
      const itShowId = String(it.showId || it.id || posterId || '').split(':')[0];
      if (a.showId && (a.showId === it.showId || a.showId === posterId || a.showId === it.id)) return true;
      if (aShowId && itShowId && aShowId === itShowId) return true;
      if (a.canonicalTmdbId && it.canonicalTmdbId && a.canonicalTmdbId === it.canonicalTmdbId) return true;
      if (a.tmdbId && it.tmdbId && String(a.tmdbId) === String(it.tmdbId)) return true;
      if (a.imdbId && it.imdbId && a.imdbId === it.imdbId) return true;
      const aTitle = String(a.showTitle || a.title || a.name || '').toLowerCase().trim();
      const itTitle = String(it.showTitle || it.title || it.name || '').toLowerCase().trim();
      if (aTitle && itTitle && aTitle === itTitle) return true;
      return false;
    });
    const itSeason = it.seasonNum != null ? it.seasonNum : (airingMatch ? airingMatch.seasonNum : null);
    const itEpisode = it.episodeNum != null ? it.episodeNum : (airingMatch ? airingMatch.episodeNum : null);
    
    // Check if this show is on an older past season (not the newest season)
    const isOlderSeason = isCwList && !!(airingMatch && airingMatch.seasonNum != null && it.seasonNum != null && it.seasonNum < airingMatch.seasonNum);

    let dateBadge = '';
    let bottomBadge = '';

    if (showLocationBadges && !isOlderSeason) {
      const isSameEpisode = !!(airingMatch && (!itSeason || !airingMatch.seasonNum || itSeason === airingMatch.seasonNum) && (!itEpisode || !airingMatch.episodeNum || itEpisode === airingMatch.episodeNum));
      const effectiveAirDate = it.airDate || (isSameEpisode && airingMatch ? airingMatch.airDate : null);
      const hasAired = effectiveAirDate && typeof isEpisodeAired === 'function' ? isEpisodeAired(effectiveAirDate) : false;
      const isUnairedEp = effectiveAirDate ? !hasAired : !!(it.isUnaired || (isSameEpisode && airingMatch && airingMatch.isUnaired));

      if (showAirDate && effectiveAirDate && !hasAired && typeof isEpisodeAired === 'function') {
        const badgeText = typeof formatAirDateBadge === 'function' ? formatAirDateBadge(effectiveAirDate) : '';
        if (badgeText) {
          dateBadge = '<div class="cw-date-badge" title="Airs on ' + escapeAttr(effectiveAirDate) + '">' + escapeHtml(badgeText) + '</div>';
        }
      }

      const currentEpNum = itEpisode != null ? itEpisode : (isSameEpisode && airingMatch ? airingMatch.episodeNum : null);
      const isSeasonPremiere = (currentEpNum === 1 || (currentEpNum == null && (it.isSeasonPremiere || (isSameEpisode && airingMatch && airingMatch.isSeasonPremiere))));
      const isSeasonFinale = !!(it.isSeasonFinale || (isSameEpisode && airingMatch && airingMatch.isSeasonFinale) || (airingMatch && airingMatch.seasonFinaleEpisodeNumber && currentEpNum != null && currentEpNum === airingMatch.seasonFinaleEpisodeNumber));
      const seasonFinaleAirDate = it.seasonFinaleAirDate || (airingMatch ? (airingMatch.seasonFinaleAirDate || (airingMatch.isSeasonFinale ? airingMatch.airDate : null)) : null);
      const isFinaleUnaired = seasonFinaleAirDate && typeof isEpisodeAired === 'function' ? !isEpisodeAired(seasonFinaleAirDate) : !!seasonFinaleAirDate;

      if (showPremiere && isSeasonPremiere && isUnairedEp) {
        bottomBadge = '<div class="cw-date-badge cw-date-badge-premiere" title="Airs on ' + escapeAttr(effectiveAirDate || '') + '">Season Premiere</div>';
      } else if (showFinale && isSeasonFinale) {
        bottomBadge = '<div class="cw-date-badge cw-date-badge-finale" title="Airs on ' + escapeAttr(effectiveAirDate || seasonFinaleAirDate || '') + '">Season Finale</div>';
      } else if (showFinaleDate && seasonFinaleAirDate && isFinaleUnaired && (!currentEpNum || currentEpNum >= 2)) {
        const finaleText = typeof formatAirDateBadge === 'function' ? formatAirDateBadge(seasonFinaleAirDate) : '';
        if (finaleText) {
          bottomBadge = '<div class="cw-date-badge cw-date-badge-finale-date" title="Season finale airs on ' + escapeAttr(seasonFinaleAirDate) + '">Finale: ' + escapeHtml(finaleText) + '</div>';
        }
      }
    }

    const posterEl = itemPoster
      ? '<img src="' + escapeAttr(itemPoster) + '" class="clickable-poster" data-id="' + escapeAttr(posterId) + '" data-type="' + escapeAttr(posterType) + '" data-title="' + escapeAttr(label.title || it.showTitle || it.title || it.name || '') + '" alt="" loading="lazy" onerror="handlePosterImgError(this)">'
      : '<div class="live-preview-poster live-preview-poster-placeholder" data-needs-fallback="1" style="width:100%;height:100%;"><small style="color:var(--muted); font-size:0.7rem;">No poster</small></div>';
    return '<div class="list-card-mini-poster-tile" data-id="' + escapeAttr(posterId) + '" data-type="' + escapeAttr(posterType) + '" data-title="' + escapeAttr(label.title || it.showTitle || it.title || it.name || '') + '">' +
      '<div class="list-card-mini-poster-img-wrap">' +
        posterEl +
        dateBadge +
        bottomBadge +
        removeBtn +
        overlays +
      '</div>' +
      '<div class="list-card-mini-poster-name">' + escapeHtml(label.title) + '</div>' +
      (label.subtitle ? '<div class="list-card-mini-poster-subtitle">' + escapeHtml(label.subtitle) + '</div>' : '') +
      (it.year ? '<div class="list-card-mini-poster-year">' + escapeHtml(it.year) + '</div>' : '') +
    '</div>';
  }).join('');
  const typeLabel = l.type === 'series' ? 'Shows' : l.type === 'movie' ? 'Movies' : 'Mixed';
  const cardClass = 'creator-list-row list-card' + (l.slug === 'watch-history' ? ' is-watch-history-shelf' : (l.slug === 'continue-watching' ? ' continue-watching-card is-continue-watching-shelf' : (l.slug === 'airing-next' ? ' airing-next-card is-airing-next-shelf' : '')));
  const isPublic = l.visibility === 'public';
  const shareUrl = l.url || ((typeof activeCreator !== 'undefined' && activeCreator)
    ? (location.origin + '/lists/' + activeCreator.creatorName + '/' + (l.slug || 'watchlist'))
    : (location.origin + '/lists/' + (l.slug === 'watchlist' ? 'watchlist' : ('custom/' + l.slug))));
  const shareBtn = isPublic
    ? '<button type="button" class="lc-btn secondary creatorListShareBtn" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(shareUrl) + '">Share</button>'
    : '';

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
      '<div class="list-card-body localListViewBtn" data-slug="' + escapeAttr(l.slug) + '" data-name="' + escapeAttr(l.name) + '" data-type="' + escapeAttr(l.type || 'movie') + '" style="cursor:pointer;">' +
        '<div class="list-card-title">' +
          '<span class="drag-handle-list" draggable="true" title="Drag to reorder" onclick="event.stopPropagation();">&#x2630;</span>' +
          escapeHtml(l.name) +
        '</div>' +
        '<div class="list-card-meta">' +
          (!isAutoTracked ? ('<span>' + (isPublic ? 'Public' : 'Private') + '</span><span class="list-card-meta-sep">&middot;</span>') : '') +
          '<span>' + typeLabel + '</span>' +
          '<span class="list-card-meta-sep">&middot;</span>' +
          '<span>' + totalCount + ' item' + (totalCount === 1 ? '' : 's') + '</span>' +
          (!isAutoTracked && l.slug !== 'watchlist' ? '<span class="list-card-meta-sep">&middot;</span><span>&#9829; ' + (l.likes || 0) + '</span>' : '') +
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
            shareBtn +
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
      createdAt: 0,
      updatedAt: 0,
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

  // Sync items from any live DOM rows in Catalogs if the DOM row has more items
  let hasLocalUpdates = false;
  document.querySelectorAll('#lists .entry').forEach((entry) => {
    const urlInput = entry.querySelector('.url');
    if (!urlInput || !urlInput.value.startsWith('customlist:v1:')) return;
    try {
      const rowPayload = JSON.parse(urlInput.value.slice('customlist:v1:'.length));
      const slug = rowPayload.localSlug || rowPayload.creatorSlug || rowPayload.listSlug;
      if (!slug || !Array.isArray(rowPayload.items) || !rowPayload.items.length) return;
      if (map[slug]) {
        if (rowPayload.items.length > (map[slug].items || []).length) {
          map[slug].items = rowPayload.items;
          map[slug].updatedAt = Date.now();
          hasLocalUpdates = true;
        }
      }
    } catch (e) {}
  });
  if (hasLocalUpdates) saveLocalCustomListsMap(map);

  // Airing Next lives in this same map (getOrCreateAiringNextList uses the
  // same store) but needs its own render path (buildAiringNextCardHtml,
  // no args) rather than the generic buildLocalListCardHtml -- filtered
  // out of the plain loop below and re-added as a stub so it still
  // participates in the shared saved-order sort/drag exactly like every
  // other card (see the matching comment in renderCreatorDashboard above).
  const lists = Object.keys(map).map((k) => map[k]).filter((l) => l && l.slug !== 'airing-next');
  const airingNextEligible = typeof collectAiringNextCandidateShowIds === 'function' && collectAiringNextCandidateShowIds().size && typeof buildAiringNextCardHtml === 'function';
  if (airingNextEligible) {
    lists.push({ slug: 'airing-next', isAiringNext: true, updatedAt: (map['airing-next'] && map['airing-next'].updatedAt) || Date.now() });
  }

  const visibleLists = (typeof isListHidden === 'function') ? lists.filter((l) => !isListHidden(l && l.slug)) : lists;

  let savedOrder = [];
  try {
    savedOrder = JSON.parse(localStorage.getItem('myListAddon:dashboardListOrder') || '[]');
  } catch (e) {}
  if (savedOrder && savedOrder.length) {
    const orderMap = new Map(savedOrder.map((s, idx) => [s, idx]));
    visibleLists.sort((a, b) => {
      const posA = orderMap.has(a.slug) ? orderMap.get(a.slug) : 9999;
      const posB = orderMap.has(b.slug) ? orderMap.get(b.slug) : 9999;
      if (posA !== posB) return posA - posB;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
  } else {
    visibleLists.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  lastLocalCustomListsData = visibleLists;
  const rowsHtml = visibleLists.length
    ? visibleLists.map((l) => l.isAiringNext ? buildAiringNextCardHtml() : buildLocalListCardHtml(l)).join('')
    : '<p><small>No lists yet \u2014 build one under Create List to get started.</small></p>';
  const prevScrollTop = box ? box.scrollTop : 0;
  box.innerHTML = '<div id="creatorListRows" style="margin-bottom:14px;">' + rowsHtml + '</div>';
  if (prevScrollTop) box.scrollTop = prevScrollTop;
  document.querySelectorAll('#creatorListRows .drag-handle-list').forEach((h) => initCreatorListTouchDrag(h));
  if (typeof renderHiddenListsSettingsSection === 'function') renderHiddenListsSettingsSection();
}


const _creatorDashEl = document.getElementById('creatorDashboard');
if (_creatorDashEl) {
  _creatorDashEl.addEventListener('click', async (e) => {
    if (e.target.closest('.clickable-poster')) return;
    const airingViewBtn = e.target.closest('.airingNextViewBtn');
    if (airingViewBtn) {
      if (typeof openAiringNextDetailsPage === 'function') openAiringNextDetailsPage();
      return;
    }
    const airingAddBtn = e.target.closest('.airingNextAddToConfigBtn');
    if (airingAddBtn) {
      const list = (typeof getOrCreateAiringNextList === 'function') ? getOrCreateAiringNextList() : { items: [] };
      let isAdded = airingAddBtn.classList.contains('is-added') || (typeof isListAddedToConfig === 'function' && isListAddedToConfig(null, 'series', 'airing-next'));
      if (isAdded) {
        if (typeof removeListFromConfig === 'function') removeListFromConfig(null, 'series', 'airing-next');
        if (typeof renumber === 'function') renumber();
        if (typeof saveState === 'function') saveState();
        airingAddBtn.classList.remove('is-added', 'secondary');
        airingAddBtn.classList.add('primary');
        airingAddBtn.textContent = '+ Add';
        airingAddBtn.style.color = '';
        if (typeof updateAllListAddButtons === 'function') updateAllListAddButtons();
        if (typeof showAddedToast === 'function') showAddedToast('Removed "Airing Next" from your Catalogs.');
        return;
      }
      // Signed-in Creator account: a live catalog reading server-side
      // tracking data (see fetchAutoTrackedCatalog, 05_catalog-core.js).
      // Local-only browser: a snapshot of today's items, same as Watch
      // History/Continue Watching fall back to for local-only users --
      // it'll go stale as the schedule moves and needs a manual Configure
      // -> Update to refresh (see this repo's README).
      const url = (typeof activeCreator !== 'undefined' && activeCreator)
        ? 'autotrack:airing-next:series:' + activeCreator.creatorName
        : 'customlist:v1:' + JSON.stringify({
            listId: (typeof generateChannelId === 'function') ? generateChannelId() : String(Date.now()),
            localSlug: 'airing-next',
            type: 'series',
            items: (list.items || []).map((it) => ({ imdbId: it.showId, title: it.showTitle, poster: it.showPoster })),
            shuffle: false,
          });
      if (typeof addRow === 'function') addRow('Airing Next', url, 'series', true, 'My Lists');
      airingAddBtn.classList.add('is-added', 'secondary');
      airingAddBtn.classList.remove('primary');
      airingAddBtn.textContent = 'Remove';
      airingAddBtn.style.color = 'var(--danger)';
      if (typeof updateAllListAddButtons === 'function') updateAllListAddButtons();
      if (typeof showAddedToast === 'function') showAddedToast('Added "Airing Next" to your Catalogs.');
      return;
    }
    const viewBtn = e.target.closest('.creatorListViewBtn, .localListViewBtn, .creatorListViewTrigger, .localListViewTrigger');
  if (viewBtn) {
    const slug = viewBtn.dataset.slug;
    const pool = (viewBtn.classList.contains('localListViewBtn') || viewBtn.classList.contains('localListViewTrigger')) ? lastLocalCustomListsData : lastCreatorListsData;
    let list = (pool || []).find((l) => l && l.slug === slug);
    if (!list) {
      const localMap = (typeof loadLocalCustomLists === 'function') ? loadLocalCustomLists() : {};
      list = (slug && localMap[slug]) || Object.values(localMap).find((l) => l && (l.slug === slug || l.name === viewBtn.dataset.name)) || (typeof lastCreatorListsData !== 'undefined' && (lastCreatorListsData || []).find((l) => l && (l.slug === slug || l.name === viewBtn.dataset.name))) || (typeof lastLocalCustomListsData !== 'undefined' && (lastLocalCustomListsData || []).find((l) => l && (l.slug === slug || l.name === viewBtn.dataset.name)));
    }
    const isCw = list && list.slug === 'continue-watching';
    const isWatchlist = list && (list.slug === 'watchlist' || list.isWatchlist || (list.name && list.name.toLowerCase() === 'watchlist'));
    const isHistory = list && (list.slug === 'watch-history' || (list.name && list.name.toLowerCase() === 'watch history'));
    const rawListItems = isCw ? (typeof dedupeContinueWatchingItems === 'function' ? dedupeContinueWatchingItems(list.items || []) : (list.items || [])) : (list ? (list.items || []) : []);
    const sample = rawListItems.map((it) => {
      const label = formatWatchItemLabel(it);
      const isShow = (it.type === 'series' || it.type === 'tv' || it.type === 'show' || it.kind === 'series' || it.kind === 'tv' || !!it.showId || it.seasonNum != null);
      const itemType = isShow ? 'series' : ((it.type === 'movie' || it.kind === 'movie') ? 'movie' : (it.type === 'episode' ? 'episode' : (list && list.type && list.type !== 'mixed' ? list.type : (viewBtn.dataset.type || 'movie'))));
      const epId = String(it.id || '');
      const showId = isCw ? (it.showId || (epId.startsWith('tt') && epId.includes(':') ? epId.split(':')[0] : (epId.startsWith('tmdb:') && epId.includes(':') ? epId.split(':')[0] + ':' + epId.split(':')[1] : (it.imdbId || it.id)))) : (it.showId || it.imdbId || it.id || (it.tmdbId ? ('tmdb:' + it.tmdbId) : null));
      const showPoster = isCw ? (it.showPoster || (showId && String(showId).startsWith('tt') ? ('https://images.metahub.space/poster/medium/' + showId + '/img') : it.poster)) : (it.poster || it.showPoster);
      return {
        id: showId,
        showId: showId,
        seasonNum: it.seasonNum,
        episodeNum: it.episodeNum,
        type: itemType,
        name: label.title || it.title || it.name || 'Untitled',
        subtitle: label.subtitle || '',
        poster: showPoster,
        year: it.year,
        airDate: it.airDate,
        isUnaired: it.isUnaired,
        seasonFinaleAirDate: it.seasonFinaleAirDate,
        isSeasonPremiere: it.isSeasonPremiere,
        isSeasonFinale: it.isSeasonFinale,
        removeShowId: isCw ? (it.showId || it.id) : null,
        removeWatchlistId: isWatchlist ? (it.imdbId || it.id) : null,
        removeHistoryId: isHistory ? (it.id || it.imdbId) : null,
        removeCustomListSlug: (!isCw && !isWatchlist && !isHistory) ? list.slug : null,
      };
    });
    const listSlug = (list && (list.slug || list.localSlug)) || (isCw ? 'continue-watching' : (isHistory ? 'watch-history' : (isWatchlist ? 'watchlist' : slug)));
    const listUrl = listSlug ? ('custom:' + listSlug) : '';
    const listType = (viewBtn.dataset.type && viewBtn.dataset.type !== 'undefined') ? viewBtn.dataset.type : ((list && list.type) || (isCw ? 'series' : (isWatchlist ? 'mixed' : 'movie')));
    openListDetailsPage(viewBtn.dataset.name || (list && list.name) || 'Custom List', listType, listUrl, { sample: sample, count: sample.length, maybeMore: false });
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
      recordCreatorListDeletion(slug);
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
        
        // Remove from local storage map so it doesn't get resurrected
        const map = loadLocalCustomLists();
        delete map[slug];
        Object.keys(map).forEach((k) => {
          if (map[k] && (map[k].slug === slug || map[k].creatorSlug === slug || map[k].localSlug === slug || map[k].listSlug === slug)) {
            delete map[k];
          }
        });
        saveLocalCustomListsMap(map);
        
        // Remove from main lists config if present
        document.querySelectorAll('#lists .url').forEach((urlInput) => {
          const rowPayload = parseCustomListPayloadClient(urlInput.value);
          if (rowPayload && (rowPayload.creatorSlug === slug || rowPayload.slug === slug || rowPayload.localSlug === slug || rowPayload.listSlug === slug)) {
            const entry = urlInput.closest('.entry');
            if (entry) {
              entry.remove();
            }
          }
        });
        if (typeof saveState === 'function') saveState();
        if (typeof scheduleCreatorSyncSave === 'function') scheduleCreatorSyncSave();
        if (typeof pushCreatorSync === 'function') pushCreatorSync();
        
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
      if (typeof updateAllListAddButtons === 'function') updateAllListAddButtons();
      showAddedToast('Removed "' + listMeta.name + '" from your Catalogs.');
    } else {
      if (listMeta.type === 'mixed') {
        const items = listMeta.items || [];
        const movies = items.filter(it => (it.kind === 'movie' || it.type === 'movie' || (!it.kind && !it.type && !it.showId)));
        const series = items.filter(it => (it.kind === 'series' || it.type === 'series' || it.type === 'tv' || it.showId));
        const mPayload = { listId: generateChannelId(), creatorSlug: slug, listSlug: slug, creatorOwner: listMeta.creatorName || (activeCreator ? activeCreator.creatorName : undefined), type: 'movie', items: movies, shuffle: false, publishedUrl: listMeta.url || undefined };
        addRow(listMeta.name + ' (Movies)', 'customlist:v1:' + JSON.stringify(mPayload), 'movie', true, 'Custom Lists');
        const sPayload = { listId: generateChannelId(), creatorSlug: slug, listSlug: slug, creatorOwner: listMeta.creatorName || (activeCreator ? activeCreator.creatorName : undefined), type: 'series', items: series, shuffle: false, publishedUrl: listMeta.url || undefined };
        addRow(listMeta.name + ' (Shows)', 'customlist:v1:' + JSON.stringify(sPayload), 'series', true, 'Custom Lists');
      } else {
        const payload = { listId: generateChannelId(), listSlug: slug, type: listMeta.type, items: listMeta.items || [], shuffle: false };
        addRow(listMeta.name, 'customlist:v1:' + JSON.stringify(payload), listMeta.type, true, 'Custom Lists');
      }
      addToConfigBtn.classList.add('is-added', 'secondary');
      addToConfigBtn.classList.remove('primary');
      addToConfigBtn.textContent = 'Remove';
      addToConfigBtn.style.color = 'var(--danger)';
      if (typeof updateAllListAddButtons === 'function') updateAllListAddButtons();
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
      Object.keys(map).forEach((k) => {
        if (map[k] && (map[k].slug === slug || map[k].creatorSlug === slug || map[k].localSlug === slug || map[k].listSlug === slug)) {
          delete map[k];
        }
      });
      saveLocalCustomListsMap(map);
      
      // If signed into creator, also delete from server if it exists
      if (activeCreator) {
        const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
        if (creatorKey) {
          // Fire-and-forget: if this never lands the list survives on the
          // account while being gone locally, which is precisely what the
          // backfill must not undo.
          recordCreatorListDeletion(slug);
          fetch(ORIGIN + '/api/creator/lists/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ creatorName: activeCreator.creatorName, creatorKey: creatorKey, slug: slug }),
          }).catch(() => {});
        }
      }
      
      // Remove from main lists config if present
      document.querySelectorAll('#lists .url').forEach((urlInput) => {
        const rowPayload = parseCustomListPayloadClient(urlInput.value);
        if (rowPayload && (rowPayload.localSlug === slug || rowPayload.creatorSlug === slug || rowPayload.slug === slug || rowPayload.listSlug === slug)) {
          const entry = urlInput.closest('.entry');
          if (entry) entry.remove();
        }
      });
      if (typeof saveState === 'function') saveState();
      if (typeof scheduleCreatorSyncSave === 'function') scheduleCreatorSyncSave();
      if (typeof pushCreatorSync === 'function') pushCreatorSync();
      
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
      if (typeof removeListFromConfig === 'function') {
        removeListFromConfig(null, listMeta.type, slug);
        removeListFromConfig(null, 'movie', slug);
        removeListFromConfig(null, 'series', slug);
      }
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
      if (typeof updateAllListAddButtons === 'function') updateAllListAddButtons();
      showAddedToast('Removed "' + listMeta.name + '" from your Catalogs.');
      return;
    }

    const items = normalizeSnapshotItemsForCatalog(listMeta.items || []);
    
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
      
      const movieUrl = activeCreator && (slug === 'watch-history' || slug === 'continue-watching')
        ? 'autotrack:' + slug + ':movie:' + activeCreator.creatorName
        : 'customlist:v1:' + JSON.stringify({ listId: generateChannelId(), localSlug: slug, listSlug: slug, type: 'movie', items: movies, shuffle: false });
      addRow(listMeta.name + ' (Movies)', movieUrl, 'movie', true, 'My Lists');
      const showUrl = activeCreator && (slug === 'watch-history' || slug === 'continue-watching')
        ? 'autotrack:' + slug + ':series:' + activeCreator.creatorName
        : 'customlist:v1:' + JSON.stringify({ listId: generateChannelId(), localSlug: slug, listSlug: slug, type: 'series', items: series, shuffle: false });
      addRow(listMeta.name + ' (Shows)', showUrl, 'series', true, 'My Lists');
    } else {
      const payload = { listId: generateChannelId(), localSlug: slug, type: listMeta.type, items: items, shuffle: false };
      addRow(listMeta.name, 'customlist:v1:' + JSON.stringify(payload), listMeta.type, true, 'My Lists');
    }
    
    localAddToConfigBtn.classList.add('is-added', 'secondary');
    localAddToConfigBtn.classList.remove('primary');
    localAddToConfigBtn.textContent = 'Remove';
    localAddToConfigBtn.style.color = 'var(--danger)';
    if (typeof updateAllListAddButtons === 'function') updateAllListAddButtons();
    showAddedToast('Added "' + listMeta.name + '" to your Catalogs.');
  }
});
}

// A customlist:v1: snapshot is read back by fetchCustomListCatalog
// (05_catalog-core.js), which drops any item without an imdbId. Ordinary
// custom-list picks always have one. Auto-tracked and derived lists do
// not: an Airing Next entry is keyed by showId, a Watch History episode
// by its own episode id with the series in showId. Passing those through
// untouched produced a snapshot every item of which was filtered out
// server-side -- a row that embedded real data and still rendered "No
// items found".
//
// This fills in the missing identifier without disturbing anything that
// already has one, so a normal custom list round-trips byte-identically
// (kind/type in particular are preserved -- fetchCustomListCatalog reads
// them to decide whether an item belongs in a movie or a series row).
function normalizeSnapshotItemsForCatalog(items) {
  if (!Array.isArray(items)) return [];
  return items.map((it) => {
    if (!it || it.imdbId) return it;
    const derivedId = it.showId || it.id || (it.tmdbId ? ('tmdb:' + it.tmdbId) : '');
    if (!derivedId) return it;
    return Object.assign({}, it, {
      imdbId: derivedId,
      title: it.title || it.showTitle || it.name || '',
      poster: it.poster || it.showPoster || '',
    });
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
  const stEl1 = document.getElementById('customListSearchType');
  if (stEl1) stEl1.value = customListDraftType === 'series' ? 'tv' : 'movie';
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
  const stEl2 = document.getElementById('customListSearchType');
  if (stEl2) stEl2.value = customListDraftType === 'series' ? 'tv' : 'movie';
  if (typeof updateCustomListTypeRadio === 'function') updateCustomListTypeRadio(customListDraftType);
  const visSelect = document.getElementById('customListVisibilitySelect');
  if (visSelect) visSelect.value = (listMeta.visibility === 'public') ? 'public' : 'private';
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

function openCreateListModal(presetDestination) {
  const destEl = document.getElementById('createListModalDestination');
  if (destEl) {
    const traktToken = (typeof traktAccessToken !== 'undefined' && traktAccessToken) || localStorage.getItem('myListAddon:traktAccessToken') || '';
    const tmdbSess = (typeof tmdbSessionId !== 'undefined' && tmdbSessionId) || localStorage.getItem('myListAddon:tmdbSessionId') || '';
    const tmdbAcc = (typeof tmdbAccountId !== 'undefined' && tmdbAccountId) || localStorage.getItem('myListAddon:tmdbAccountId') || '';
    const mdbToken = (typeof mdblistAccessToken !== 'undefined' && mdblistAccessToken) || localStorage.getItem('myListAddon:mdblistAccessToken') || '';
    const mdbKey = (document.getElementById('mdblistKeyInput')?.value.trim()) || localStorage.getItem('myListAddon:mdblistKey') || '';
    const simklToken = (typeof simklAccessToken !== 'undefined' && simklAccessToken) || localStorage.getItem('myListAddon:simklAccessToken') || '';

    let optsHtml = '<option value="custom">Custom List (Local / Creator)</option>';
    if (traktToken) optsHtml += '<option value="trakt">Trakt List</option>';
    if (tmdbSess || tmdbAcc) optsHtml += '<option value="tmdb">TMDB List</option>';
    if (mdbToken || mdbKey) optsHtml += '<option value="mdblist">MDBList List</option>';
    if (simklToken) optsHtml += '<option value="simkl">Simkl List</option>';
    destEl.innerHTML = optsHtml;

    if (presetDestination && destEl.querySelector('option[value="' + presetDestination + '"]')) {
      destEl.value = presetDestination;
    } else {
      destEl.value = 'custom';
    }
  }

  const nameEl = document.getElementById('createListModalName');
  if (nameEl) nameEl.value = '';
  const descEl = document.getElementById('createListModalDesc');
  if (descEl) descEl.value = '';
  const typeEl = document.getElementById('createListModalType');
  if (typeEl) typeEl.value = 'movie';
  const pubEl = document.getElementById('createListModalPublic');
  if (pubEl) pubEl.checked = true;
  
  if (typeof onChangeCreateListDestination === 'function') onChangeCreateListDestination();

  const btn = document.getElementById('createListModalBtn');
  if (btn) {
    btn.disabled = true;
    btn.style.opacity = '0.5';
    btn.innerText = 'Create';
  }
  const modal = document.getElementById('createListModal');
  if (modal) modal.style.display = 'flex';
  if (nameEl) nameEl.focus();
}

function onChangeCreateListDestination() {
  const pubWrap = document.getElementById('createListModalPublicWrap');
  if (pubWrap) {
    pubWrap.style.display = 'flex';
  }
}

async function submitCreateListModal() {
  const name = document.getElementById('createListModalName').value.trim();
  if (!name) return;
  const desc = document.getElementById('createListModalDesc') ? document.getElementById('createListModalDesc').value.trim() : '';
  const destEl = document.getElementById('createListModalDestination');
  const dest = destEl ? destEl.value : 'custom';
  const isPublic = document.getElementById('createListModalPublic') ? document.getElementById('createListModalPublic').checked : true;
  const visibility = isPublic ? 'public' : 'private';
  const typeEl = document.getElementById('createListModalType');
  const type = typeEl ? typeEl.value : 'movie';
  
  const currentPendingItem = window._selectListModalCurrentItem;
  let initialItems = [];
  
  const btn = document.getElementById('createListModalBtn');
  btn.innerText = 'Creating...';
  btn.disabled = true;

  try {
    let finalImdbId = '';
    let cleanTmdbId = '';
    if (currentPendingItem && currentPendingItem.title) {
      finalImdbId = currentPendingItem.id;
      if (finalImdbId && !String(finalImdbId).startsWith('tt')) {
        cleanTmdbId = String(finalImdbId).replace(/^tmdb:/, '');
        const endpoint = currentPendingItem.type === 'movie' ? '/api/resolve-movie?tmdbId=' : '/api/resolve-show?tmdbId=';
        try {
          const res = await fetch(ORIGIN + endpoint + encodeURIComponent(cleanTmdbId));
          const data = await res.json();
          if (data.ok && data.imdbId) finalImdbId = data.imdbId;
        } catch(e) {}
      } else if (finalImdbId && String(finalImdbId).startsWith('tt')) {
        const apiKeyTmdb = (document.getElementById('tmdbKeyInput')?.value.trim()) || localStorage.getItem('myListAddon:tmdbKey') || '';
        if (apiKeyTmdb) {
          try {
            const findRes = await fetch('https://api.themoviedb.org/3/find/' + encodeURIComponent(finalImdbId) + '?api_key=' + encodeURIComponent(apiKeyTmdb) + '&external_source=imdb_id');
            const findData = await findRes.json();
            const hit = (findData.movie_results && findData.movie_results[0]) || (findData.tv_results && findData.tv_results[0]);
            if (hit && hit.id) cleanTmdbId = String(hit.id);
          } catch(e) {}
        }
      }

      initialItems.push({
        imdbId: finalImdbId || currentPendingItem.id,
        type: currentPendingItem.type || (type === 'series' ? 'series' : 'movie'),
        title: currentPendingItem.title,
        poster: currentPendingItem.poster || undefined
      });
    }

    if (dest === 'custom') {
      const payload = { listId: generateChannelId(), type: type, items: initialItems, shuffle: false };
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
          listSlug: data.slug,
          creatorOwner: activeCreator.creatorName,
          visibility: visibility
        });
        if (type === 'mixed') {
          const movies = initialItems.filter(it => (it.kind === 'movie' || it.type === 'movie' || (!it.kind && !it.type && !it.showId)));
          const series = initialItems.filter(it => (it.kind === 'series' || it.type === 'series' || it.type === 'tv' || it.showId));
          const mPayload = Object.assign({}, updatedPayload, { listId: generateChannelId(), type: 'movie', items: movies });
          addRow(name + ' (Movies)', 'customlist:v1:' + JSON.stringify(mPayload), 'movie', true, 'Custom Lists');
          const sPayload = Object.assign({}, updatedPayload, { listId: generateChannelId(), type: 'series', items: series });
          addRow(name + ' (Shows)', 'customlist:v1:' + JSON.stringify(sPayload), 'series', true, 'Custom Lists');
        } else {
          addRow(name, 'customlist:v1:' + JSON.stringify(updatedPayload), type, true, 'Custom Lists');
        }
      } else {
        const base = slugify(name) || 'list';
        let slug = base;
        const map = loadLocalCustomLists();
        let n = 2;
        while (map[slug]) {
          slug = base + '-' + n;
          n++;
        }
        payload.localSlug = slug;
        payload.listSlug = slug;
        map[slug] = {
          slug: slug,
          name: name,
          type: type,
          items: initialItems,
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
        saveLocalCustomListsMap(map);
        if (type === 'mixed') {
          const movies = initialItems.filter(it => (it.kind === 'movie' || it.type === 'movie' || (!it.kind && !it.type && !it.showId)));
          const series = initialItems.filter(it => (it.kind === 'series' || it.type === 'series' || it.type === 'tv' || it.showId));
          const mPayload = Object.assign({}, payload, { listId: generateChannelId(), type: 'movie', items: movies });
          addRow(name + ' (Movies)', 'customlist:v1:' + JSON.stringify(mPayload), 'movie', true, 'Custom Lists');
          const sPayload = Object.assign({}, payload, { listId: generateChannelId(), type: 'series', items: series });
          addRow(name + ' (Shows)', 'customlist:v1:' + JSON.stringify(sPayload), 'series', true, 'Custom Lists');
        } else {
          addRow(name, 'customlist:v1:' + JSON.stringify(payload), type, true, 'Custom Lists');
        }
      }
    } else {
      // External Provider Creation (Trakt, TMDB, MDBList)
      const traktToken = (typeof traktAccessToken !== 'undefined' && traktAccessToken) || localStorage.getItem('myListAddon:traktAccessToken') || '';
      const traktKey = (document.getElementById('traktKeyInput')?.value.trim()) || localStorage.getItem('myListAddon:traktKey') || '';
      const traktUser = (typeof traktUsername !== 'undefined' && traktUsername) || localStorage.getItem('myListAddon:traktUsername') || '';
      const tmdbSess = (typeof tmdbSessionId !== 'undefined' && tmdbSessionId) || localStorage.getItem('myListAddon:tmdbSessionId') || '';
      const tmdbKey = (document.getElementById('tmdbKeyInput')?.value.trim()) || localStorage.getItem('myListAddon:tmdbKey') || '';
      const mdbToken = (typeof mdblistAccessToken !== 'undefined' && mdblistAccessToken) || localStorage.getItem('myListAddon:mdblistAccessToken') || '';
      const mdbKey = (document.getElementById('mdblistKeyInput')?.value.trim()) || localStorage.getItem('myListAddon:mdblistKey') || '';
      const mdbUser = (typeof mdblistUsername !== 'undefined' && mdblistUsername) || localStorage.getItem('myListAddon:mdblistUsername') || '';
      const simklToken = (typeof simklAccessToken !== 'undefined' && simklAccessToken) || localStorage.getItem('myListAddon:simklAccessToken') || '';
      const simklKey = (document.getElementById('simklKeyInput')?.value.trim()) || localStorage.getItem('myListAddon:simklKey') || '';

      const res = await fetch(ORIGIN + '/api/external-list/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: dest,
          name: name,
          description: desc,
          privacy: visibility,
          type: type,
          traktAccessToken: traktToken,
          traktKey: traktKey,
          traktUsername: traktUser,
          tmdbSessionId: tmdbSess,
          tmdbKey: tmdbKey,
          mdblistAccessToken: mdbToken,
          mdblistKey: mdbKey,
          mdblistUsername: mdbUser,
          simklAccessToken: simklToken,
          simklKey: simklKey
        })
      });
      const data = await res.json();
      if (!data.ok || !data.list) {
        showAppNoticeModal('Could Not Create List', data.error || 'Failed to create list on ' + dest.toUpperCase() + '.', true);
        btn.innerText = 'Create';
        btn.disabled = false;
        return;
      }

      const createdList = data.list;
      const groupLabel = dest === 'trakt' ? 'Trakt' : (dest === 'tmdb' ? 'TMDB' : (dest === 'simkl' ? 'Simkl' : 'MDBList'));
      addRow(name, createdList.url, type, true, groupLabel);

      // If pending item, add it to the newly created list
      if (currentPendingItem && currentPendingItem.id) {
        if (typeof setExternalListMembership === 'function' && typeof makeExternalKey === 'function') {
          const newKey = makeExternalKey(dest, 'custom', createdList.id || createdList.slug, currentPendingItem.id);
          setExternalListMembership(newKey, true);
          if (finalImdbId) setExternalListMembership(makeExternalKey(dest, 'custom', createdList.id || createdList.slug, finalImdbId), true);
          if (cleanTmdbId) setExternalListMembership(makeExternalKey(dest, 'custom', createdList.id || createdList.slug, cleanTmdbId), true);
        }

        fetch(ORIGIN + '/api/external-list/item-mutate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'add',
            provider: dest,
            target: 'custom',
            listId: createdList.id || createdList.slug,
            id: currentPendingItem.id,
            imdbId: finalImdbId,
            tmdbId: cleanTmdbId,
            type: currentPendingItem.type || type,
            title: currentPendingItem.title,
            poster: currentPendingItem.poster,
            traktAccessToken: traktToken,
            traktKey: traktKey,
            traktUsername: traktUser,
            tmdbSessionId: tmdbSess,
            tmdbKey: tmdbKey,
            mdblistAccessToken: mdbToken,
            mdblistKey: mdbKey,
            simklAccessToken: simklToken,
            simklKey: simklKey
          })
        }).catch(() => {});
      }

      // Refresh list caches
      if (dest === 'trakt' && typeof loadMyTraktLists === 'function') loadMyTraktLists();
      if (dest === 'tmdb' && typeof loadMyTmdbLists === 'function') loadMyTmdbLists();
      if (dest === 'mdblist' && typeof loadMyMdblistLists === 'function') loadMyMdblistLists();
      if (dest === 'simkl' && typeof loadMySimklLists === 'function') loadMySimklLists();
    }

    saveState();
    document.getElementById('createListModal').style.display = 'none';
    if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard();

    if (currentPendingItem && currentPendingItem.title) {
      showAddedToast('Created list "' + name + '" and added "' + currentPendingItem.title + '".');
      window._selectListModalCurrentItem = null;
    } else {
      showAddedToast('Created list "' + name + '" on ' + (dest === 'custom' ? 'Custom Lists' : dest.toUpperCase()) + '.');
      switchTab('lists');
    }
  } catch (err) {
    showAppNoticeModal('Network Error', 'A network error occurred while creating your list. Please check your connection and try again.', true);
  } finally {
    btn.innerText = 'Create';
    btn.disabled = false;
  }
}

function deleteExternalListDirect(provider, listId, listName, btn) {
  if (!provider || !listId) return;
  const providerLabel = provider === 'trakt' ? 'Trakt' : (provider === 'tmdb' ? 'TMDB' : (provider === 'mdblist' ? 'MDBList' : provider));
  
  const confirmFn = typeof showAppConfirm === 'function' ? showAppConfirm : (title, msg, btnText, cb) => { if (confirm(msg)) cb(); };
  
  confirmFn(
    'Delete List',
    'Are you sure you want to permanently delete the list "' + (listName || 'Custom List') + '" from your ' + providerLabel + ' account? This action cannot be undone.',
    'Delete Permanently',
    async () => {
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Deleting...';
      }

      const traktToken = (typeof traktAccessToken !== 'undefined' && traktAccessToken) || localStorage.getItem('myListAddon:traktAccessToken') || '';
      const traktKey = (document.getElementById('traktKeyInput')?.value.trim()) || localStorage.getItem('myListAddon:traktKey') || '';
      const tmdbSess = (typeof tmdbSessionId !== 'undefined' && tmdbSessionId) || localStorage.getItem('myListAddon:tmdbSessionId') || '';
      const tmdbKey = (document.getElementById('tmdbKeyInput')?.value.trim()) || localStorage.getItem('myListAddon:tmdbKey') || '';
      const mdbToken = (typeof mdblistAccessToken !== 'undefined' && mdblistAccessToken) || localStorage.getItem('myListAddon:mdblistAccessToken') || '';
      const mdbKey = (document.getElementById('mdblistKeyInput')?.value.trim()) || localStorage.getItem('myListAddon:mdblistKey') || '';

      try {
        const res = await fetch(ORIGIN + '/api/external-list/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: provider,
            listId: listId,
            traktAccessToken: traktToken,
            traktKey: traktKey,
            tmdbSessionId: tmdbSess,
            tmdbKey: tmdbKey,
            mdblistAccessToken: mdbToken,
            mdblistKey: mdbKey
          })
        });
        const data = await res.json();
        if (!data.ok) {
          showAppNoticeModal('Could Not Delete List', data.error || 'Failed to delete list from ' + providerLabel + '.', true);
          if (btn) { btn.disabled = false; btn.textContent = 'Delete'; }
          return;
        }

        // Animate card removal if present
        const card = btn ? btn.closest('.list-card, .creator-list-row') : null;
        if (card) {
          card.style.opacity = '0';
          card.style.transform = 'scale(0.9)';
          card.style.transition = 'all 0.2s ease';
          setTimeout(() => { if (card && card.parentNode) card.parentNode.removeChild(card); }, 200);
        }

        // Remove row entries from #lists
        let removedFromConfig = false;
        document.querySelectorAll('#lists .entry').forEach(row => {
          const u = row.querySelector('.url')?.value || '';
          if (u && (u.includes(listId) || (provider === 'trakt' && u.includes('/lists/' + listId)))) {
            row.remove();
            removedFromConfig = true;
          }
        });
        if (removedFromConfig) {
          renumber();
          saveState();
        }

        // If currently in list-details view of this list, go back
        const detailsPanel = document.getElementById('content-list-details');
        if (detailsPanel && !detailsPanel.hidden) {
          navigateBackFromDetail();
        }

        // Refresh caches
        if (provider === 'trakt' && typeof loadMyTraktLists === 'function') loadMyTraktLists();
        if (provider === 'tmdb' && typeof loadMyTmdbLists === 'function') loadMyTmdbLists();
        if (provider === 'mdblist' && typeof loadMyMdblistLists === 'function') loadMyMdblistLists();

        showAddedToast('Deleted list "' + (listName || 'List') + '" from ' + providerLabel + '.');
      } catch (err) {
        showAppNoticeModal('Network Error', 'A network error occurred while deleting the list. Please check your connection and try again.', true);
        if (btn) { btn.disabled = false; btn.textContent = 'Delete'; }
      }
    },
    true
  );
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
    if (typeof pushTrackingSync === 'function') pushTrackingSync({ intentionalRemoval: true });
    if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard({ silent: true });
    if (typeof syncCustomListToCatalogRows === 'function') {
      syncCustomListToCatalogRows('watchlist', (map['watchlist'] ? map['watchlist'].items : []), 'Watchlist', 'mixed');
    }
    if (typeof showAddedToast === 'function') showAddedToast('Removed item from Watchlist.');
  }
  if (typeof activeCreator !== 'undefined' && activeCreator && Array.isArray(lastCreatorListsData)) {
    const creatorWatchlist = lastCreatorListsData.find(l => l && (l.slug === 'watchlist' || l.isWatchlist || (l.name && l.name.toLowerCase() === 'watchlist')));
    if (creatorWatchlist && Array.isArray(creatorWatchlist.items)) {
      const initialLen = creatorWatchlist.items.length;
      creatorWatchlist.items = creatorWatchlist.items.filter(it => it && String(it.id || it.imdbId) !== targetId && String(it.showId || '') !== targetId);
      if (creatorWatchlist.items.length !== initialLen) {
        if (typeof syncCustomListToCatalogRows === 'function') {
          syncCustomListToCatalogRows(creatorWatchlist.slug, creatorWatchlist.items, creatorWatchlist.name, creatorWatchlist.type || 'mixed');
        }
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
          if (typeof showAddedToast === 'function') showAddedToast('Removed item from Watchlist.');
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
    map['watch-history'].items = map['watch-history'].items.filter(it => String(it.id || it.imdbId) !== targetId && String(it.showId || '') !== targetId);
    if (map['watch-history'].items.length !== initialLen) {
      if (window._watchedItemIds) window._watchedItemIds.delete(targetId);
      map['watch-history'].updatedAt = Date.now();
      if (typeof saveLocalCustomListsMap === 'function') saveLocalCustomListsMap(map);
      if (typeof scheduleCreatorSyncSave === 'function') scheduleCreatorSyncSave({ intentionalRemoval: true });
      if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard({ silent: true });
      if (typeof showAddedToast === 'function') showAddedToast('Removed item from Watch History.');
      // Removing the last watched episode of a show drops it from Airing
      // Next's candidate set -- see syncAiringNextWatchState's own
      // comment (21_client-custom-list-builder.js).
      if (typeof syncAiringNextWatchState === 'function') syncAiringNextWatchState();
    }
  }
  if (window._rawWatchHistoryItems && Array.isArray(window._rawWatchHistoryItems)) {
    window._rawWatchHistoryItems = window._rawWatchHistoryItems.filter(it => String(it.id || it.imdbId) !== targetId && String(it.showId || '') !== targetId);
    if (document.getElementById('content-list-details') && !document.getElementById('content-list-details').hidden) {
      if (typeof renderWatchHistoryGrid === 'function') renderWatchHistoryGrid();
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
      if (typeof syncCustomListToCatalogRows === 'function') {
        syncCustomListToCatalogRows(slug, map[slug].items, map[slug].name, map[slug].type);
      }
      if (typeof showAddedToast === 'function') showAddedToast('Removed item from list.');
    }
  }
  // Signed-in Creator Profile: this list may actually be server-hosted
  // rather than (or in addition to) sitting in the local map above -- the
  // See All view renders creator-owned and local-only lists through the
  // exact same card/remove-button markup (see the shared click handler
  // this function is called from), so a signed-in user's "xyz" custom
  // list is often a lastCreatorListsData entry, not a loadLocalCustomLists()
  // one. Without this block the tile still fades out (it's removed
  // unconditionally above) but nothing is ever actually deleted server
  // side, so the item is back the moment the list reloads -- same shape
  // of fix as removeWatchlistItemDirect just above already has.
  if (typeof activeCreator !== 'undefined' && activeCreator && Array.isArray(lastCreatorListsData)) {
    const creatorList = lastCreatorListsData.find(l => l && l.slug === slug);
    if (creatorList && Array.isArray(creatorList.items)) {
      const initialLen = creatorList.items.length;
      creatorList.items = creatorList.items.filter(it => it && String(it.id || it.imdbId) !== targetId && String(it.showId || '') !== targetId);
      if (creatorList.items.length !== initialLen) {
        if (typeof syncCustomListToCatalogRows === 'function') {
          syncCustomListToCatalogRows(creatorList.slug, creatorList.items, creatorList.name, creatorList.type);
        }
        const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
        fetch(ORIGIN + '/api/creator/lists/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            creatorName: activeCreator.creatorName,
            creatorKey: creatorKey,
            slug: creatorList.slug,
            name: creatorList.name,
            type: creatorList.type,
            items: creatorList.items,
            visibility: creatorList.visibility || 'public',
          }),
        }).then(() => {
          if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard({ silent: true });
          if (typeof showAddedToast === 'function') showAddedToast('Removed item from list.');
        }).catch(() => {});
      }
    }
  }
}

function clearWatchHistoryAll() {
  const confirmFn = typeof showAppConfirm === 'function' ? showAppConfirm : (title, msg, btnText, cb) => { if (confirm(msg)) cb(); };
  confirmFn(
    'Clear Watch History',
    'Are you sure you want to remove all items from your Watch History? This will reset your watched history and cannot be undone.',
    'Clear All',
    () => {
      const map = (typeof loadLocalCustomLists === 'function') ? loadLocalCustomLists() : {};
      if (map['watch-history']) {
        map['watch-history'].items = [];
        map['watch-history'].updatedAt = Date.now();
        if (typeof saveLocalCustomListsMap === 'function') saveLocalCustomListsMap(map);
      }
      window._watchedItemIds = new Set();
      window._rawWatchHistoryItems = [];
      window._fullyWatchedShowIds = new Set();
      try {
        localStorage.removeItem('myListAddon:fullyWatchedShows');
      } catch (e) {}

      if (typeof scheduleCreatorSyncSave === 'function') scheduleCreatorSyncSave({ intentionalRemoval: true });
      if (typeof pushTrackingSync === 'function') pushTrackingSync({ intentionalRemoval: true });

      // Refresh list details view if currently visible
      if (document.getElementById('content-list-details') && !document.getElementById('content-list-details').hidden) {
        const params = window._currentListDetailsParams;
        if (params && (params.name.toLowerCase().includes('watch history') || params.listUrl === 'autotrack:watch-history' || params.listUrl === 'custom:watch-history')) {
          if (typeof renderWatchHistoryGrid === 'function') renderWatchHistoryGrid();
          if (typeof _updateListDetailsItemCount === 'function') _updateListDetailsItemCount(0);
        }
      }

      // Refresh dashboard if visible
      if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard({ silent: true });
      if (typeof renderLocalCustomListsDashboard === 'function') {
        const box = document.getElementById('localCustomListsDashboard');
        if (box) renderLocalCustomListsDashboard(box, true);
      }

      if (typeof showAddedToast === 'function') showAddedToast('Watch History cleared \u2713');
    },
    true
  );
}
window.clearWatchHistoryAll = clearWatchHistoryAll;

function clearContinueWatchingAll() {
  const confirmFn = typeof showAppConfirm === 'function' ? showAppConfirm : (title, msg, btnText, cb) => { if (confirm(msg)) cb(); };
  confirmFn(
    'Clear Continue Watching',
    'Are you sure you want to remove all items from Continue Watching? This will reset your in-progress movies and shows.',
    'Clear All',
    () => {
      const map = (typeof loadLocalCustomLists === 'function') ? loadLocalCustomLists() : {};
      if (map['continue-watching']) {
        map['continue-watching'].items = [];
        map['continue-watching'].updatedAt = Date.now();
        if (typeof saveLocalCustomListsMap === 'function') saveLocalCustomListsMap(map);
      }
      window._currentListDetailsAllItems = [];

      if (typeof scheduleCreatorSyncSave === 'function') scheduleCreatorSyncSave({ intentionalRemoval: true });
      if (typeof pushTrackingSync === 'function') pushTrackingSync({ intentionalRemoval: true });

      // Refresh list details view if currently visible
      if (document.getElementById('content-list-details') && !document.getElementById('content-list-details').hidden) {
        const params = window._currentListDetailsParams;
        if (params && (params.name.toLowerCase().includes('continue watching') || params.listUrl === 'autotrack:continue-watching' || params.listUrl === 'custom:continue-watching' || (params.listUrl && params.listUrl.includes('continue-watching')))) {
          const gridEl = document.getElementById('detailGrid');
          const statusEl = document.getElementById('detailStatus');
          const subEl = document.getElementById('detailSubtitle');
          if (gridEl) gridEl.innerHTML = '';
          if (statusEl) statusEl.innerHTML = '<small>No items in continue watching.</small>';
          if (subEl) subEl.textContent = '0 items';
          if (typeof _updateListDetailsItemCount === 'function') _updateListDetailsItemCount(0);
        }
      }

      // Refresh dashboard if visible
      if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard({ silent: true });
      if (typeof renderLocalCustomListsDashboard === 'function') {
        const box = document.getElementById('localCustomListsDashboard');
        if (box) renderLocalCustomListsDashboard(box, true);
      }

      if (typeof showAddedToast === 'function') showAddedToast('Continue Watching cleared \u2713');
    },
    true
  );
}
window.clearContinueWatchingAll = clearContinueWatchingAll;

// --- Multi-Device Background Sync & Foreground Resume -----------------------
let _lastForegroundSyncCheck = 0;
const FOREGROUND_SYNC_COOLDOWN_MS = 5000; // 5 seconds cooldown
let _foregroundSyncTimer = null;
let _isSyncingForeground = false;

async function handleForegroundResumeSync() {
  if (typeof document !== 'undefined' && document.visibilityState && document.visibilityState !== 'visible') {
    return;
  }
  const now = Date.now();
  if (now - _lastForegroundSyncCheck < FOREGROUND_SYNC_COOLDOWN_MS || _isSyncingForeground) {
    return;
  }
  _lastForegroundSyncCheck = now;

  if (typeof activeCreator === 'undefined' || !activeCreator) return;
  const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
  if (!creatorKey) return;

  // Defer slightly so tab switch and UI clicks are completely instant and smooth
  if (_foregroundSyncTimer) clearTimeout(_foregroundSyncTimer);
  _foregroundSyncTimer = setTimeout(async () => {
    _isSyncingForeground = true;
    try {
      // Ask the cheap endpoint first. sync/load reads six KV keys and sends
      // back the entire watchHistory -- which for an active account is
      // megabytes, and on a poll like this one is almost always identical
      // to what this browser already has. sync/meta answers the only
      // question that matters here (has anything moved?) in a few dozen
      // bytes, so the expensive call happens on real change instead of on
      // a timer. See the endpoint's own comment,
      // 26_api-creator-and-admin-routes.js.
      let needsFullLoad = true;
      const known = window._syncMetaStamps;
      if (known) {
        try {
          const metaRes = await fetch(ORIGIN + '/api/creator/sync/meta', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ creatorName: activeCreator.creatorName, creatorKey: creatorKey }),
          });
          const meta = await metaRes.json();
          if (meta && meta.ok) {
            needsFullLoad =
              (Number(meta.config) || 0) > (known.config || 0) ||
              (Number(meta.tracking) || 0) > (known.tracking || 0) ||
              (Number(meta.presets) || 0) > (known.presets || 0) ||
              (Number(meta.channels) || 0) > (known.channels || 0);
          }
          // Anything other than a clean ok:true response leaves
          // needsFullLoad true, so a failed or unrecognised meta check
          // degrades into exactly the old behaviour rather than into a
          // browser that quietly stops syncing.
        } catch (e) {
          needsFullLoad = true;
        }
      }
      if (needsFullLoad && typeof loadCreatorSync === 'function') {
        await loadCreatorSync({ background: true });
      }
    } catch (e) {
      // Silent background sync
    } finally {
      _isSyncingForeground = false;
    }
  }, 250);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      handleForegroundResumeSync();
    }
  });
  // Periodic background check while the dashboard is open. This used to run
  // every 15 seconds and call sync/load outright; it now runs a quarter as
  // often and asks sync/meta first, so an idle open tab costs one tiny
  // request a minute instead of four full state downloads. Returning to the
  // tab still syncs immediately via the visibilitychange/focus handlers
  // below, which is where responsiveness actually comes from.
  setInterval(() => {
    if (document.visibilityState === 'visible') {
      handleForegroundResumeSync();
    }
  }, 60000);
}
if (typeof window !== 'undefined') {
  window.addEventListener('focus', () => {
    handleForegroundResumeSync();
  });
  window.addEventListener('pageshow', () => {
    handleForegroundResumeSync();
  });
}

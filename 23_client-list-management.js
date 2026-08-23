// Reordering & position management
function moveRow(btn, dir) {
  const entry = btn.closest('.entry');
  const container = document.getElementById('lists');
  // Works off the ordered array of .entry elements (not raw DOM siblings)
  // so this stays correct regardless of what else the container holds.
  const entries = [...container.querySelectorAll('.entry')];
  const idx = entries.indexOf(entry);
  if (dir < 0 && idx > 0) {
    container.insertBefore(entry, entries[idx - 1]);
  } else if (dir > 0 && idx < entries.length - 1) {
    container.insertBefore(entries[idx + 1], entry);
  }
  renumber();
}

function renumber() {
  const entries = [...document.querySelectorAll('#lists .entry')];
  entries.forEach((div, i) => {
    const posInput = div.querySelector('.pos');
    if (posInput) {
      posInput.value = i + 1;
      posInput.max = entries.length;
    }
    const ups = div.querySelectorAll('.movebtn');
    if (ups && ups.length >= 2) {
      ups[0].disabled = (i === 0);
      ups[1].disabled = (i === entries.length - 1);
    }
  });
  updateListGroupFilterOptions();
  filterLists();
  saveState();
}

// Lets someone type a new position directly into a row's number box (e.g.
// "60" -> "2") instead of clicking the up arrow 58 times -- the row is
// pulled out and reinserted at that spot, and everything in between shifts
// down (or up) by one to make room, same as dragging it there would.
function movePosTo(input) {
  const container = document.getElementById('lists');
  const entries = [...container.querySelectorAll('.entry')];
  const entry = input.closest('.entry');
  const from = entries.indexOf(entry);
  const typed = parseInt(input.value, 10);
  if (!typed || isNaN(typed)) {
    renumber(); // invalid/empty input -- just restore the correct number
    return;
  }
  const to = Math.min(Math.max(typed, 1), entries.length) - 1;
  if (to === from) {
    renumber();
    return;
  }
  entries.splice(from, 1);
  entries.splice(to, 0, entry);
  entries.forEach((e) => container.appendChild(e));
  renumber();
}

// Drag-to-reorder, as an addition to (not a replacement for) the \u2191/\u2193
// buttons above -- those still work and are the only option on touch
// devices, where native HTML5 drag-and-drop generally isn't supported.
let dragSrcEntry = null;

document.getElementById('lists').addEventListener('dragstart', (e) => {
  const handle = e.target.closest('.drag-handle');
  if (!handle) { e.preventDefault(); return; }
  dragSrcEntry = handle.closest('.entry');
  dragSrcEntry.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
});

document.getElementById('lists').addEventListener('dragend', () => {
  if (dragSrcEntry) dragSrcEntry.classList.remove('dragging');
  dragSrcEntry = null;
  renumber();
});

document.getElementById('lists').addEventListener('dragover', (e) => {
  if (!dragSrcEntry) return;
  e.preventDefault();
  const container = document.getElementById('lists');
  const afterEl = getDragAfterElement(container, e.clientY);
  if (afterEl == null) {
    container.appendChild(dragSrcEntry);
  } else if (afterEl !== dragSrcEntry) {
    container.insertBefore(dragSrcEntry, afterEl);
  }
});

function getDragAfterElement(container, y) {
  const els = [...container.querySelectorAll('.entry:not(.dragging)')];
  return els.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) {
      return { offset: offset, element: child };
    }
    return closest;
  }, { offset: -Infinity, element: null }).element;
}

// Touch/pen drag-to-reorder -- native HTML5 drag-and-drop (above) generally
// doesn't fire on touch devices at all, which left dragging a list of 60
// rows into place a real chore on mobile (the \u2191/\u2193 buttons and the
// editable position number both still work there, but neither is as fast
// as a drag). Pointer Events cover touch/pen here without disturbing the
// existing mouse path -- gated to pointerType so a mouse drag still goes
// through the HTML5 dragstart/dragover listeners above untouched. Called
// once per row (from addRow) since each row gets its own handle.
let touchDragEntry = null;

function initTouchDrag(handle) {
  if (!handle) return;
  handle.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
    e.preventDefault();
    touchDragEntry = handle.closest('.entry');
    touchDragEntry.classList.add('dragging');
    try { handle.setPointerCapture(e.pointerId); } catch (err) {}
    document.addEventListener('pointermove', onTouchDragMove);
    document.addEventListener('pointerup', onTouchDragEnd, { once: true });
    document.addEventListener('pointercancel', onTouchDragEnd, { once: true });
  });
}

function onTouchDragMove(e) {
  if (!touchDragEntry) return;
  const container = document.getElementById('lists');
  const afterEl = getDragAfterElement(container, e.clientY);
  if (afterEl == null) {
    container.appendChild(touchDragEntry);
  } else if (afterEl !== touchDragEntry) {
    container.insertBefore(touchDragEntry, afterEl);
  }
}

function onTouchDragEnd() {
  document.removeEventListener('pointermove', onTouchDragMove);
  if (touchDragEntry) touchDragEntry.classList.remove('dragging');
  touchDragEntry = null;
  renumber();
}

// --- undo toast -------------------------------------------------------------
//
// A brief window to reverse Remove All or a single row's Remove button,
// Gmail-style, instead of a confirm() dialog every time. Only remembers the
// single most recent destructive action (not a full history) -- good enough
// for "oops, changed my mind" without the complexity of a real undo stack.
let undoSnapshot = null;
let undoTimer = null;

function captureUndoSnapshot() {
  undoSnapshot = { entries: collectEntries() };
}

function showUndoToast(message) {
  const toast = document.getElementById('undoToast');
  document.getElementById('undoToastMsg').textContent = message;
  toast.style.display = 'flex';
  clearTimeout(undoTimer);
  undoTimer = setTimeout(hideUndoToast, 8000);
}

function hideUndoToast() {
  document.getElementById('undoToast').style.display = 'none';
  clearTimeout(undoTimer);
}

function performUndo() {
  if (!undoSnapshot) { hideUndoToast(); return; }
  document.getElementById('lists').innerHTML = '';
  undoSnapshot.entries.forEach((e) => addRow(e.name, e.url, e.type, e.enabled, e.group, e.id));
  renumber();
  checkAllDuplicateUrls();
  saveState();
  hideUndoToast();
  undoSnapshot = null;
  renderChannelMergeList();
}

// Removes a single row, with the same brief-undo safety net as Remove All
// below -- wired up from each row's own Remove button in addRow().
function removeEntryWithUndo(btn) {
  const entry = btn.closest('.entry');
  const nameEl = entry.querySelector('.name');
  const name = (nameEl && nameEl.value.trim()) || 'Untitled list';
  captureUndoSnapshot();
  entry.remove();
  renumber();
  checkAllDuplicateUrls();
  renderChannelMergeList();
  showUndoToast('Removed "' + name + '".');
}

// Clears the whole builder in one go, for when someone's added a bunch of
// lists and changed their mind rather than removing them one at a time.
// No confirm() dialog -- the undo toast above is the safety net instead, so
// this is a single click like the rest of the bulk actions next to it.
function removeAllLists() {
  const entries = document.querySelectorAll('#lists .entry');
  if (!entries.length) return;
  captureUndoSnapshot();
  document.getElementById('lists').innerHTML = '';
  renumber();
  saveState();
  renderChannelMergeList();
  showUndoToast('Removed ' + entries.length + ' list(s).');
}

// --- search/filter box -------------------------------------------------------
//
// Purely a view filter -- hides non-matching rows without touching the
// underlying data, so it's safe to type into even mid-edit. Re-applied at
// the end of renumber() so it survives adds/removes/reorders/imports.
// Rebuilds the group filter's options from whatever groups actually exist
// right now (rather than a fixed hardcoded list, which would drift out of
// sync with whatever Quick Add panels/group names exist) -- called from
// renumber() below, which already runs after every add/remove/reorder.
// Preserves the current selection across a rebuild so re-filtering after
// an edit doesn't silently reset back to "All groups".
function updateListGroupFilterOptions() {
  const select = document.getElementById('listGroupFilterSelect');
  if (!select) return;
  const currentValue = select.value;
  const groups = new Set();
  document.querySelectorAll('#lists .entry').forEach((div) => {
    groups.add(div.dataset.group || 'Custom');
  });
  const sortedGroups = Array.from(groups).sort((a, b) => a.localeCompare(b));
  select.innerHTML = '<option value="">All groups</option>' +
    sortedGroups.map((g) => '<option value="' + escapeAttr(g) + '">' + escapeHtml(g) + '</option>').join('');
  if (sortedGroups.includes(currentValue)) select.value = currentValue;
}

function filterLists() {
  const input = document.getElementById('listFilterInput');
  if (!input) return;
  const q = input.value.trim().toLowerCase();
  const groupSelect = document.getElementById('listGroupFilterSelect');
  const groupFilter = groupSelect ? groupSelect.value : '';
  document.querySelectorAll('#lists .entry').forEach((div) => {
    const nameEl = div.querySelector('.name');
    const name = (nameEl ? nameEl.value : '').toLowerCase();
    const matchesName = !q || name.indexOf(q) !== -1;
    const matchesGroup = !groupFilter || (div.dataset.group || 'Custom') === groupFilter;
    div.style.display = (matchesName && matchesGroup) ? '' : 'none';
  });
}

// --- compact view -------------------------------------------------------------
//
// Toggles a single class on the container; the actual hiding is pure CSS
// (see #lists.compact rules) so this stays a one-line flip regardless of
// how many rows are on screen.
let isLivePreviewEditMode = false;

function toggleLivePreviewEdit() {
  isLivePreviewEditMode = !isLivePreviewEditMode;
  const listsContainer = document.getElementById('lists');
  const btn = document.getElementById('livePreviewEditBtn');
  if (isLivePreviewEditMode) {
    listsContainer.classList.add('live-preview-edit-mode');
    if (btn) {
      btn.textContent = 'Done Editing';
      btn.classList.remove('secondary');
      btn.classList.add('primary');
    }
  } else {
    listsContainer.classList.remove('live-preview-edit-mode');
    if (btn) {
      btn.textContent = 'Edit';
      btn.classList.remove('primary');
      btn.classList.add('secondary');
    }
  }
}

function toggleCompactView(btn) {
  const container = document.getElementById('lists');
  const isCompact = container.classList.toggle('compact');
  btn.textContent = isCompact ? 'Full view' : 'Compact view';
}

function slugify(s) {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'').slice(0,60);
}

async function testSourceRow(btn) {
  const sourceRow = btn.closest('.source-row');
  const entry = btn.closest('.entry');
  const url = sourceRow.querySelector('.url').value.trim();
  const type = entry.querySelector('.type').value;
  const resultEl = sourceRow.querySelector('.testresult');

  if (!url) { resultEl.className = 'testresult err'; resultEl.textContent = 'Paste a URL first.'; return; }

  btn.disabled = true;
  resultEl.className = 'testresult pending';
  resultEl.textContent = 'Testing\u2026';

  try {
    const body = { url, type };
    const mdblistKey = document.getElementById('mdblistKeyInput').value.trim();
    if (mdblistKey) body.mdblistKey = mdblistKey;
    const traktKey = document.getElementById('traktKeyInput').value.trim();
    if (traktKey) body.traktKey = traktKey;
    if (traktAccessToken) body.traktAccessToken = traktAccessToken;
    const res = await fetch(\`\${ORIGIN}/api/preview\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    const data = await res.json();
    if (data.ok) {
      const more = data.maybeMore ? '+' : '';
      resultEl.className = 'testresult ok';
      const thumbs = (data.sample || []).filter((s) => s.poster).slice(0, 5).map((s) =>
        '<img class="preview-thumb" src="' + escapeAttr(s.poster) + '" alt="' + escapeAttr(s.name) + '" title="' + escapeAttr(s.name) + '" loading="lazy">'
      ).join('');
      const label = data.count === 0
        ? '\u2713 Reachable, but 0 items matched (check the movie/series toggle).'
        : \`\u2713 \${data.count}\${more} items found\`;
      resultEl.innerHTML = '<div>' + label + '</div>' + (thumbs ? '<div class="preview-thumbs">' + thumbs + '</div>' : '');
    } else {
      resultEl.className = 'testresult err';
      resultEl.textContent = '\u2717 ' + data.error;
    }
  } catch (e) {
    resultEl.className = 'testresult err';
    resultEl.textContent = '\u2717 Network error testing this list.';
  } finally {
    btn.disabled = false;
  }
}

// Runs every row's Test one panel at a time (well, CONCURRENCY at a time)
// by just calling the exact same testSourceRow used for a single row --
// same inline per-row result, same everything, just walking the whole
// list instead of one button click. A summary alert at the end since
// there's no single place on a long list where all the individual
// testresult divs would be visible at once.
async function testAllSources() {
  const buttons = Array.from(document.querySelectorAll('#lists .btn-test'));
  if (!buttons.length) {
    alert('No lists to test yet -- add some above first.');
    return;
  }
  const testAllBtn = document.getElementById('testAllBtn');
  if (testAllBtn) {
    testAllBtn.disabled = true;
    testAllBtn.textContent = 'Testing all\u2026';
  }

  let idx = 0;
  const CONCURRENCY = 4;
  async function worker() {
    while (idx < buttons.length) {
      const i = idx++;
      if (testAllBtn) testAllBtn.textContent = 'Testing all\u2026 (' + (i + 1) + '/' + buttons.length + ')';
      await testSourceRow(buttons[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, buttons.length) }, () => worker()));

  let okCount = 0;
  let errCount = 0;
  document.querySelectorAll('#lists .testresult').forEach((el) => {
    if (el.classList.contains('ok')) okCount++;
    else if (el.classList.contains('err')) errCount++;
  });

  if (testAllBtn) {
    testAllBtn.disabled = false;
    testAllBtn.textContent = 'Test all';
  }
  alert('Tested ' + buttons.length + ' source' + (buttons.length === 1 ? '' : 's') + ' \u2014 ' + okCount + ' ok, ' + errCount + ' failed.');
}

function buildConfig(entries, keys) {
  const payload = { entries };
  if (keys && keys.mdblistKey) payload.mdblistKey = keys.mdblistKey;
  if (keys && keys.traktKey) payload.traktKey = keys.traktKey;
  if (keys && keys.traktUsername) payload.traktUsername = keys.traktUsername;
  if (keys && keys.traktAccessToken) payload.traktAccessToken = keys.traktAccessToken;
  if (keys && keys.track) {
    payload.track = true;
    payload.trackCreatorName = keys.trackCreatorName;
    payload.trackCreatorKey = keys.trackCreatorKey;
  }
  if (keys && keys.shuffleShelves) payload.shuffleShelves = true;
  if (keys && keys.shuffleItems) payload.shuffleItems = true;
  const jsonStr = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(jsonStr);
  let bin = '';
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+\$/,'');
}

// Repairs an autotrack: URL that was generated before activeCreator's
// normalized username was correctly threaded through (a past bug baked
// the literal string "undefined" into the username segment for anyone
// who added Watch History/Continue Watching to a shelf while that bug was
// live -- see the "+Add to catalog" handler in 22_client-creator-
// profile.js). Also repairs a URL left over from a *different* signed-in
// account (e.g. after switching Creator Profiles), which would otherwise
// silently keep reading someone else's tracking data forever. A no-op for
// anything else, including when nobody's signed in right now -- there's
// no correct username to repair it with yet, so it's left alone until
// there is.
function repairAutotrackUrl(url) {
  if (!activeCreator || !activeCreator.creatorName) return url;
  const m = /^autotrack:(watch-history|continue-watching):(movie|series):(.*)$/.exec(url);
  if (!m || m[3] === activeCreator.creatorName) return url;
  return 'autotrack:' + m[1] + ':' + m[2] + ':' + activeCreator.creatorName;
}

function collectEntries() {
  // Catalog IDs must be unique per (type, id) pair for wako/Stremio to tell
  // catalogs apart. Several quick-add sections deliberately reuse short
  // display names like "Movies" or "Shows" (e.g. Trending, Popular Today,
  // Popular This Year, Latest Releases all have a "Movies" row) — if the id
  // were derived from that name, all of them would collide onto the same
  // catalog id and only one (or none, depending on the client) would show
  // up after install. Deriving the id from the URL instead keeps it unique
  // per underlying list; the seen-count fallback below still protects
  // against two rows that genuinely share the same URL + type.
  const seen = {};
  return [...document.querySelectorAll('#lists .entry')].map(div => {
    const name = div.querySelector('.name').value.trim();
    // A merged entry has multiple .url inputs (one per source); join them
    // newline-separated into the single stored "url" field -- fetchCatalog
    // server-side splits on the same delimiter to fan out to each source.
    const urls = [...div.querySelectorAll('.url')].map(el => {
      const raw = el.value.trim();
      const repaired = repairAutotrackUrl(raw);
      // Written back into the actual input, not just the returned data --
      // so the repair sticks (gets picked up by the next autosave/sync)
      // instead of silently re-appearing every time this runs.
      if (repaired !== raw) el.value = repaired;
      return repaired;
    }).filter(Boolean);
    const url = urls.join('\\n');
    const type = div.querySelector('.type').value;
    // The per-list enable/disable checkbox was removed -- every added list
    // is simply included now (remove the row entirely to leave it out).
    const enabled = true;
    // A Channel's "url" is its whole JSON payload, not a real list URL --
    // slugifying that (like every other source below) would just truncate
    // to the poster URL's prefix, producing a meaningless, collision-prone
    // id. Channels get their own stable id instead (see generateChannelId).
    const isChannelRow = url.startsWith('channel:v1:');
    let id = isChannelRow
      ? (div.dataset.channelId || generateChannelId())
      : (slugify(urls[0] || '') || slugify(name) || 'list');
    const key = type + ':' + id;
    if (seen[key] === undefined) {
      seen[key] = 1;
    } else {
      seen[key] += 1;
      id = id + '-' + seen[key];
    }
    return { id, name, type, url, enabled, group: div.dataset.group || 'Custom' };
  }).filter(e => e.name && e.url);
}

function collectKeys() {
  let track = false;
  try { track = localStorage.getItem('myListAddon:trackPlayback') === '1'; } catch (e) {}

  const tmdbKeyEl = document.getElementById('tmdbKeyInput');
  let tmdbKey = tmdbKeyEl ? tmdbKeyEl.value.trim() : '';
  if (!tmdbKey) {
    try { tmdbKey = localStorage.getItem('myListAddon:tmdbKey') || ''; } catch (e) {}
  }
  let tmdbSession = (typeof tmdbSessionId !== 'undefined' && tmdbSessionId) || '';
  if (!tmdbSession) {
    try { tmdbSession = localStorage.getItem('myListAddon:tmdbSessionId') || ''; } catch (e) {}
  }
  let tmdbAcc = (typeof tmdbAccountId !== 'undefined' && tmdbAccountId) || '';
  if (!tmdbAcc) {
    try { tmdbAcc = localStorage.getItem('myListAddon:tmdbAccountId') || ''; } catch (e) {}
  }
  let tmdbUser = (typeof tmdbUsername !== 'undefined' && tmdbUsername) || '';
  if (!tmdbUser) {
    try { tmdbUser = localStorage.getItem('myListAddon:tmdbUsername') || ''; } catch (e) {}
  }

  const mdblistKeyEl = document.getElementById('mdblistKeyInput');
  let mdblistKey = mdblistKeyEl ? mdblistKeyEl.value.trim() : '';
  if (!mdblistKey) {
    try { mdblistKey = localStorage.getItem('myListAddon:mdblistKey') || ''; } catch (e) {}
  }
  let mdblistToken = (typeof mdblistAccessToken !== 'undefined' && mdblistAccessToken) || '';
  if (!mdblistToken) {
    try { mdblistToken = localStorage.getItem('myListAddon:mdblistAccessToken') || ''; } catch (e) {}
  }
  let mdblistUser = (typeof mdblistUsername !== 'undefined' && mdblistUsername) || '';
  if (!mdblistUser) {
    try { mdblistUser = localStorage.getItem('myListAddon:mdblistUsername') || ''; } catch (e) {}
  }

  const traktKeyEl = document.getElementById('traktKeyInput');
  let traktKey = traktKeyEl ? traktKeyEl.value.trim() : '';
  if (!traktKey) {
    try { traktKey = localStorage.getItem('myListAddon:traktKey') || ''; } catch (e) {}
  }
  const traktUserEl = document.getElementById('traktUsernameInput');
  let traktUser = traktUserEl ? traktUserEl.value.trim() : '';
  if (!traktUser) {
    try { traktUser = localStorage.getItem('myListAddon:traktUsername') || ''; } catch (e) {}
  }
  let traktToken = (typeof traktAccessToken !== 'undefined' && traktAccessToken) || '';
  if (!traktToken) {
    try { traktToken = localStorage.getItem('myListAddon:traktAccessToken') || ''; } catch (e) {}
  }

  const simklKeyEl = document.getElementById('simklKeyInput');
  let simklKey = simklKeyEl ? simklKeyEl.value.trim() : '';
  if (!simklKey) {
    try { simklKey = localStorage.getItem('myListAddon:simklKey') || ''; } catch (e) {}
  }
  let simklToken = (typeof simklAccessToken !== 'undefined' && simklAccessToken) || '';
  if (!simklToken) {
    try { simklToken = localStorage.getItem('myListAddon:simklAccessToken') || ''; } catch (e) {}
  }
  let simklUser = (typeof simklUsername !== 'undefined' && simklUsername) || '';
  if (!simklUser) {
    try { simklUser = localStorage.getItem('myListAddon:simklUsername') || ''; } catch (e) {}
  }

  const keys = {
    tmdbKey: tmdbKey,
    tmdbSessionId: tmdbSession,
    tmdbAccountId: tmdbAcc,
    tmdbUsername: tmdbUser,
    mdblistKey: mdblistKey,
    mdblistAccessToken: mdblistToken,
    mdblistUsername: mdblistUser,
    traktKey: traktKey,
    traktUsername: traktUser,
    traktAccessToken: traktToken,
    simklKey: simklKey,
    simklAccessToken: simklToken,
    simklUsername: simklUser,
    shuffleShelves: document.getElementById('shuffleShelvesCheckbox') ? document.getElementById('shuffleShelvesCheckbox').checked : false,
    shuffleItems: document.getElementById('shuffleItemsCheckbox') ? document.getElementById('shuffleItemsCheckbox').checked : false,
    syncTraktHistory: localStorage.getItem('myListAddon:syncTraktHistory') === 'true',
    syncMdblistHistory: localStorage.getItem('myListAddon:syncMdblistHistory') === 'true',
    syncSimklHistory: localStorage.getItem('myListAddon:syncSimklHistory') === 'true',
  };
  if (typeof activeCreator !== 'undefined' && activeCreator) {
    keys.creatorName = activeCreator.creatorName;
    if (track) {
      keys.track = true;
      keys.trackCreatorName = activeCreator.creatorName;
      keys.trackCreatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
    }
  }
  return keys;
}

// --- Live Preview -----------------------------------------------------------
//
// Renders every currently-enabled row as an actual shelf -- name + a strip
// of real posters -- the same way it'll show up on the wako/Stremio home
// screen once installed, in the same top-to-bottom order. Reuses
// collectEntries() (so a merged/multi-source row, a Channel, a Custom
// List, an official chart shortcut, the Watchlist, all resolve exactly the
// same way they would for a real install) and the existing /api/preview
// endpoint (already used by the per-row "Test" button) rather than any new
// server-side machinery -- fetchCatalog already handles every entry.url
// shape uniformly, so this is just that same endpoint called once per row.
// Manual "Refresh" button rather than auto-refreshing on every edit, since
// that would mean firing a burst of live requests on every keystroke.
//
// Each shelf's full fetched sample (up to 100 -- PAGE_SIZE, i.e. exactly
// what the real catalog's first page would contain) is kept in
// livePreviewShelfData is declared globally at script start


async function renderLivePreview() {
  const container = document.getElementById('lists');
  if (!container) return;
  
  // Important: We only collect shelves that are ENABLED, but our DOM contains all .entry rows.
  // So we must iterate all entries and map them to collectEntries().
  const entries = [...container.querySelectorAll('.entry')];
  const allShelves = collectEntries(); // returns one for every entry
  
  // livePreviewShelfData needs to match enabled shelves if openLivePreviewSeeAll expects an array of enabled.
  // Wait, collectEntries() returns all shelves. The previous code did:
  // const shelves = collectEntries().filter(e => e.enabled);
  // So livePreviewShelfData maps 1:1 with ENABLED shelves.
  const shelves = allShelves.filter((e) => e.enabled);
  livePreviewShelfData = shelves.map(() => null);
  
  if (!shelves.length) {
    // If no enabled shelves, do nothing (posters just stay hidden)
    return;
  }
  
  const keys = collectKeys();
  const CONCURRENCY = 4;
  let nextIdx = 0;
  
  // We need to map the enabled shelf index (0 to shelves.length-1) to the actual DOM entry.
  // We can do this by keeping a parallel array of DOM elements for enabled shelves.
  const enabledEntries = entries.filter((_, i) => allShelves[i].enabled);
  
  async function worker() {
    while (true) {
      const i = nextIdx++;
      if (i >= shelves.length) return;
      const s = shelves[i];
      const entryDOM = enabledEntries[i];
      if (!entryDOM) continue;
      
      const postersContainer = entryDOM.querySelector('.live-preview-posters');
      if (!postersContainer) continue;
      
      if (s.name && s.name.toLowerCase().includes('watch history')) {
        postersContainer.classList.add('is-watch-history-shelf');
      } else {
        postersContainer.classList.remove('is-watch-history-shelf');
      }
      
      // Determine how many posters we can visibly show (using the old logic)
      const visibleCount = (window.innerWidth < 600) ? 3 : (window.innerWidth < 1000) ? 6 : 9;
      const seeAllBtn = entryDOM.querySelector('.live-preview-shelf-title button');
      if (seeAllBtn) {
        seeAllBtn.onclick = (e) => {
          e.stopPropagation();
          openLivePreviewSeeAll(i);
        };
      }
      
      try {
        const body = { url: s.url, type: s.type, sample: 100 };
        if (keys.tmdbKey) body.tmdbKey = keys.tmdbKey;
        if (keys.mdblistKey) body.mdblistKey = keys.mdblistKey;
        if (keys.traktKey) body.traktKey = keys.traktKey;
        if (keys.traktAccessToken) body.traktAccessToken = keys.traktAccessToken;
        if (keys.creatorName) body.creatorName = keys.creatorName;
        const res = await fetch(ORIGIN + '/api/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          cache: 'no-store',
        });
        const data = await res.json();
        if (!data.ok) {
          postersContainer.innerHTML = '<p class="testresult err">✗ ' + escapeHtml(data.error || 'Could not load this catalog.') + '</p>';
          continue;
        }
        if (!data.sample || !data.sample.length) {
          postersContainer.innerHTML = '<p><small>No items found.</small></p>';
          continue;
        }
        livePreviewShelfData[i] = { name: s.name, type: s.type, url: s.url, sample: data.sample, maybeMore: data.maybeMore };
        postersContainer.innerHTML = data.sample.slice(0, visibleCount).map(livePreviewPosterHtml).join('');
        if (seeAllBtn && data.sample.length > visibleCount) seeAllBtn.disabled = false;
      } catch (e) {
        postersContainer.innerHTML = '<p class="testresult err">✗ Network error loading this catalog.</p>';
      }
    }
  }

  const workers = Array(Math.min(CONCURRENCY, shelves.length)).fill(0).map(worker);
  await Promise.all(workers);
}

function handlePosterImgError(img) {
  if (!img) return;
  img.onerror = null;
  const imdb = img.getAttribute('data-imdb') || '';
  if (img.src.indexOf('images.metahub.space') === -1 && imdb && imdb.startsWith('tt')) {
    img.src = 'https://images.metahub.space/poster/medium/' + imdb + '/img';
  } else {
    img.style.display = 'none';
    const ph = img.nextElementSibling;
    if (ph) ph.style.display = 'flex';
  }
}

function livePreviewPosterHtml(m) {
  const landscape = m.posterShape === 'landscape';
  const posterClass = 'live-preview-poster' + (landscape ? ' landscape' : '');
  const posterEl = m.poster
    ? '<img class="' + posterClass + '" src="' + escapeAttr(m.poster) + '" alt="" loading="lazy" onerror="handlePosterImgError(this)" data-imdb="' + escapeAttr(m.id || '') + '"><div class="' + posterClass + ' live-preview-poster-placeholder" style="display:none;"><small style="color:var(--muted); font-size:0.7rem;">No poster</small></div>'
    : '<div class="' + posterClass + ' live-preview-poster-placeholder"><small style="color:var(--muted); font-size:0.7rem;">No poster</small></div>';
  
  let removeBtn = '';
  if (m.removeShowId) {
    removeBtn = '<button type="button" class="cw-remove-btn" data-remove-type="cw" data-remove-id="' + escapeAttr(m.removeShowId) + '" onclick="event.stopPropagation(); removeListItemFromDetails(this)" title="Remove from Continue Watching">&times;</button>';
  } else if (m.removeWatchlistId) {
    removeBtn = '<button type="button" class="cw-remove-btn" data-remove-type="watchlist" data-remove-id="' + escapeAttr(m.removeWatchlistId) + '" onclick="event.stopPropagation(); removeListItemFromDetails(this)" title="Remove from Watchlist">&times;</button>';
  } else if (m.removeHistoryId) {
    removeBtn = '<button type="button" class="cw-remove-btn" data-remove-type="history" data-remove-id="' + escapeAttr(m.removeHistoryId) + '" onclick="event.stopPropagation(); removeListItemFromDetails(this)" title="Remove from Watch History">&times;</button>';
  } else if (m.removeCustomListSlug) {
    removeBtn = '<button type="button" class="cw-remove-btn" data-remove-type="custom" data-remove-id="' + escapeAttr(m.id) + '" data-remove-slug="' + escapeAttr(m.removeCustomListSlug) + '" onclick="event.stopPropagation(); removeListItemFromDetails(this)" title="Remove from List">&times;</button>';
  } else if (m.removeExternalProvider) {
    removeBtn = '<button type="button" class="cw-remove-btn" data-remove-type="external" data-provider="' + escapeAttr(m.removeExternalProvider) + '" data-target="' + escapeAttr(m.removeExternalTarget || '') + '" data-list-id="' + escapeAttr(m.removeExternalListId || '') + '" data-remove-id="' + escapeAttr(m.id) + '" data-media-type="' + escapeAttr(m.type || 'movie') + '" onclick="event.stopPropagation(); removeListItemFromDetails(this)" title="Remove from ' + escapeAttr(m.removeExternalProvider) + '">&times;</button>';
  }

  const yearHtml = m.year ? '<div class="live-preview-poster-year">' + escapeHtml(m.year) + '</div>' : '';
  const addOverlay = '<div class="poster-add-overlay" title="Add to Lists">+</div>';
  let dateBadge = '';
  if (m.airDate && (m.isUnaired || (typeof isEpisodeAired === 'function' && !isEpisodeAired({ air_date: m.airDate })))) {
    const badgeText = typeof formatAirDateBadge === 'function' ? formatAirDateBadge(m.airDate) : m.airDate;
    if (badgeText) {
      dateBadge = '<div class="cw-date-badge" title="Airs on ' + escapeAttr(m.airDate) + '">' + escapeHtml(badgeText) + '</div>';
    }
  }
  return '<div class="live-preview-poster-card clickable-poster" data-id="' + escapeAttr(m.id || '') + '" data-type="' + escapeAttr(m.type || '') + '" data-title="' + escapeAttr(m.name || '') + '" data-poster="' + escapeAttr(m.poster || '') + '">' +
    '<div style="position:relative; width:100%;">' +
      posterEl +
      dateBadge +
      removeBtn +
      addOverlay +
    '</div>' +
    '<div class="live-preview-poster-name">' + escapeHtml(m.name || '') + '</div>' +
    (m.subtitle ? '<div class="live-preview-poster-subtitle">' + escapeHtml(m.subtitle) + '</div>' : '') +
    yearHtml +
  '</div>';
}

function removeListItemFromDetails(btn) {
  if (!btn) return;
  const type = btn.dataset.removeType || '';
  const id = btn.dataset.removeId || '';
  const extra = btn.dataset.removeSlug || '';
  if (!id) return;
  const targetId = String(id);
  const card = btn.closest('.live-preview-poster-card, .list-card-mini-poster-tile');
  if (card) {
    card.style.opacity = '0';
    card.style.transform = 'scale(0.85)';
    card.style.transition = 'all 0.2s ease';
    setTimeout(() => {
      if (card && card.parentNode) {
        card.parentNode.removeChild(card);
        const grid = document.getElementById('detailGrid');
        const remaining = grid ? grid.querySelectorAll('.live-preview-poster-card').length : 0;
        if (typeof window._updateListDetailsItemCount === 'function') {
          window._updateListDetailsItemCount(remaining);
        }
        if (remaining === 0 && grid) {
          const statusEl = document.getElementById('detailStatus');
          if (statusEl) statusEl.innerHTML = '<small>No items left.</small>';
        }
      }
    }, 200);
  }

  // Clean from preloaded cache so refreshing or re-navigating reflects deletion
  if (window._listPreloadedCache) {
    Object.keys(window._listPreloadedCache).forEach((k) => {
      const cache = window._listPreloadedCache[k];
      if (cache && Array.isArray(cache.sample)) {
        cache.sample = cache.sample.filter((it) => it && String(it.id || it.removeShowId || it.removeWatchlistId || it.removeHistoryId) !== targetId);
      }
    });
  }

  if (type === 'cw') {
    if (typeof dismissContinueWatchingShow === 'function') dismissContinueWatchingShow(targetId, btn);
  } else if (type === 'watchlist') {
    if (typeof removeWatchlistItemDirect === 'function') removeWatchlistItemDirect(targetId, btn);
  } else if (type === 'history') {
    if (typeof removeWatchHistoryItemDirect === 'function') removeWatchHistoryItemDirect(targetId, btn);
  } else if (type === 'custom' && extra) {
    if (typeof removeCustomListItemDirect === 'function') removeCustomListItemDirect(targetId, extra, btn);
  } else if (type === 'external') {
    const provider = btn.dataset.provider || '';
    const target = btn.dataset.target || '';
    const listId = btn.dataset.listId || '';
    const mediaType = btn.dataset.mediaType || 'movie';

    if (typeof setExternalListMembership === 'function' && typeof makeExternalKey === 'function') {
      setExternalListMembership(makeExternalKey(provider, target, listId, targetId), false);
      setExternalListMembership(makeExternalKey(provider, target, listId, targetId.replace(/^tmdb:/, '')), false);
    }

    const traktToken = (typeof traktAccessToken !== 'undefined' && traktAccessToken) || localStorage.getItem('myListAddon:traktAccessToken') || '';
    const traktKey = (document.getElementById('traktKeyInput')?.value.trim()) || localStorage.getItem('myListAddon:traktKey') || '';
    const traktUser = (typeof traktUsername !== 'undefined' && traktUsername) || localStorage.getItem('myListAddon:traktUsername') || '';
    const simklToken = (typeof simklAccessToken !== 'undefined' && simklAccessToken) || localStorage.getItem('myListAddon:simklAccessToken') || '';
    const simklKey = (document.getElementById('simklKeyInput')?.value.trim()) || localStorage.getItem('myListAddon:simklKey') || '';
    const tmdbSess = (typeof tmdbSessionId !== 'undefined' && tmdbSessionId) || localStorage.getItem('myListAddon:tmdbSessionId') || '';
    const tmdbAcc = (typeof tmdbAccountId !== 'undefined' && tmdbAccountId) || localStorage.getItem('myListAddon:tmdbAccountId') || '';
    const tmdbKey = (document.getElementById('tmdbKeyInput')?.value.trim()) || localStorage.getItem('myListAddon:tmdbKey') || '';
    const mdbToken = (typeof mdblistAccessToken !== 'undefined' && mdblistAccessToken) || localStorage.getItem('myListAddon:mdblistAccessToken') || '';
    const mdbKey = (document.getElementById('mdblistKeyInput')?.value.trim()) || localStorage.getItem('myListAddon:mdblistKey') || '';

    fetch(ORIGIN + '/api/external-list/item-mutate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'remove',
        provider: provider,
        target: target,
        listId: listId,
        id: targetId,
        imdbId: targetId.startsWith('tt') ? targetId : '',
        tmdbId: targetId.startsWith('tmdb:') ? targetId.slice(5) : (targetId.startsWith('tt') ? '' : targetId),
        type: mediaType,
        traktAccessToken: traktToken,
        traktKey: traktKey,
        traktUsername: traktUser,
        simklAccessToken: simklToken,
        simklKey: simklKey,
        tmdbSessionId: tmdbSess,
        tmdbAccountId: tmdbAcc,
        tmdbKey: tmdbKey,
        mdblistAccessToken: mdbToken,
        mdblistKey: mdbKey
      })
    }).catch(() => {});

    showAddedToast('Removed from ' + (provider ? provider.toUpperCase() : 'List') + '.');
  }
}

window.setWatchHistoryFilter = function(filterType, btn) {
  window._watchHistoryFilter = filterType || 'all';
  const filterBar = document.getElementById('detailFilterBar');
  if (filterBar) {
    filterBar.querySelectorAll('.wh-filter-pill').forEach((b) => {
      b.classList.toggle('active', b.dataset.whFilter === window._watchHistoryFilter);
    });
  }
  if (typeof renderWatchHistoryGrid === 'function') renderWatchHistoryGrid();
};

window.setWatchHistorySort = function(sortVal) {
  window._watchHistorySort = sortVal || 'recent';
  if (typeof renderWatchHistoryGrid === 'function') renderWatchHistoryGrid();
};

window.toggleWatchHistoryGroupShows = function(checked) {
  localStorage.setItem('myListAddon:watchHistoryGroupShows', checked ? 'true' : 'false');
  if (typeof renderWatchHistoryGrid === 'function') renderWatchHistoryGrid();
};

window.renderWatchHistoryGrid = function() {
  const gridEl = document.getElementById('detailGrid');
  const statusEl = document.getElementById('detailStatus');
  const subEl = document.getElementById('detailSubtitle');
  if (!gridEl) return;

  const rawItems = window._rawWatchHistoryItems || [];
  if (!rawItems.length) {
    gridEl.innerHTML = '';
    if (statusEl) statusEl.innerHTML = '<small>No items in watch history.</small>';
    if (subEl) subEl.textContent = '0 items';
    return;
  }

  const filter = window._watchHistoryFilter || 'all';
  const sortMode = window._watchHistorySort || 'recent';
  const groupShows = (localStorage.getItem('myListAddon:watchHistoryGroupShows') === 'true');

  let processed = [];

  if (groupShows) {
    const showMap = new Map();
    rawItems.forEach((it) => {
      if (!it) return;
      const isEp = it.type === 'episode' || !!it.showId;
      if (isEp) {
        const showKey = String(it.showId || it.showTitle || it.id);
        const sId = it.showId || (String(it.id).startsWith('tt') ? it.id : null);
        let showPosterUrl = it.showPoster || '';
        if (!showPosterUrl && sId) {
          showPosterUrl = 'https://images.metahub.space/poster/medium/' + encodeURIComponent(sId) + '/img';
        }
        if (!showMap.has(showKey)) {
          showMap.set(showKey, {
            id: sId || it.id,
            type: 'series',
            name: it.showTitle || it.title || it.name || 'Show',
            showTitle: it.showTitle || it.title || it.name || 'Show',
            poster: showPosterUrl,
            showPoster: showPosterUrl,
            year: it.year,
            watchedCount: 0,
            watchedAt: it.watchedAt || 0,
            removeShowId: sId || it.id,
          });
        }
        const entry = showMap.get(showKey);
        entry.watchedCount++;
        if ((it.watchedAt || 0) > (entry.watchedAt || 0)) {
          entry.watchedAt = it.watchedAt || 0;
        }
        if (!entry.poster && showPosterUrl) {
          entry.poster = showPosterUrl;
        }
      } else {
        let movPoster = it.poster || it.showPoster || '';
        if (!movPoster && (it.imdbId || it.id)) {
          movPoster = 'https://images.metahub.space/poster/medium/' + encodeURIComponent(it.imdbId || it.id) + '/img';
        }
        processed.push({
          id: it.imdbId || it.id,
          type: 'movie',
          name: it.title || it.name || 'Movie',
          subtitle: '',
          poster: movPoster,
          year: it.year,
          watchedAt: it.watchedAt || 0,
          removeHistoryId: it.id || it.imdbId,
        });
      }
    });

    showMap.forEach((entry) => {
      if (!entry.poster && entry.id) {
        entry.poster = 'https://images.metahub.space/poster/medium/' + encodeURIComponent(entry.id) + '/img';
      }
      entry.subtitle = entry.watchedCount + ' episode' + (entry.watchedCount === 1 ? '' : 's') + ' watched';
      processed.push(entry);
    });
  } else {
    processed = rawItems.map((it) => {
      const label = (typeof formatWatchItemLabel === 'function') ? formatWatchItemLabel(it) : { title: it.title || it.name || '', subtitle: '' };
      return {
        id: it.showId || it.imdbId || it.id,
        type: it.showId ? 'series' : (it.type || 'movie'),
        name: label.title,
        subtitle: label.subtitle,
        poster: it.poster || it.showPoster || '',
        year: it.year,
        watchedAt: it.watchedAt || 0,
        removeHistoryId: it.id || it.imdbId,
      };
    });
  }

  if (filter === 'movie') {
    processed = processed.filter((it) => it.type === 'movie');
  } else if (filter === 'series') {
    processed = processed.filter((it) => it.type === 'series' || it.type === 'episode');
  }

  if (sortMode === 'recent') {
    processed.sort((a, b) => (b.watchedAt || 0) - (a.watchedAt || 0));
  } else if (sortMode === 'oldest') {
    processed.sort((a, b) => (a.watchedAt || 0) - (b.watchedAt || 0));
  } else if (sortMode === 'title-asc') {
    processed.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  } else if (sortMode === 'title-desc') {
    processed.sort((a, b) => (b.name || '').localeCompare(a.name || ''));
  }

  gridEl.innerHTML = processed.map(livePreviewPosterHtml).join('');
  if (subEl) {
    subEl.textContent = processed.length + ' item' + (processed.length === 1 ? '' : 's');
  }
  if (statusEl) {
    statusEl.innerHTML = processed.length ? '' : '<small>No matching items found.</small>';
  }
};

window.switchListDetailsType = function(newType) {
  if (!window._currentListDetailsParams) return;
  const p = window._currentListDetailsParams;
  window._currentListDetailsFilter = newType;

  // Update pill active states
  const aBtn = document.getElementById('detailTypeAllBtn');
  const mBtn = document.getElementById('detailTypeMovieBtn');
  const sBtn = document.getElementById('detailTypeSeriesBtn');
  if (aBtn) aBtn.classList.toggle('active', newType === 'all');
  if (mBtn) mBtn.classList.toggle('active', newType === 'movie');
  if (sBtn) sBtn.classList.toggle('active', newType === 'series');

  // If this is a dual-type chart (separate endpoint for movies vs series)
  let isDualTypeChart = false;
  let targetUrl = p.listUrl;
  let targetName = p.name;

  if (p.listUrl === 'tmdb:chart:new_movies' || p.listUrl === 'tmdb:chart:new_shows') {
    isDualTypeChart = true;
    if (newType === 'series') {
      targetUrl = 'tmdb:chart:new_shows';
      targetName = 'New Shows';
    } else if (newType === 'movie') {
      targetUrl = 'tmdb:chart:new_movies';
      targetName = 'New Movies';
    }
  } else if (typeof CHART_SLUG_ENTRIES !== 'undefined' && Array.isArray(CHART_SLUG_ENTRIES)) {
    const match = CHART_SLUG_ENTRIES.find((e) => e.name === p.name || e.movieUrl === p.listUrl || e.showUrl === p.listUrl);
    if (match && match.movieUrl && match.showUrl) {
      isDualTypeChart = true;
      targetName = match.name || p.name;
      if (newType === 'series') targetUrl = match.showUrl;
      else if (newType === 'movie') targetUrl = match.movieUrl;
    }
  }
  if (!isDualTypeChart && p.listUrl && (p.listUrl.startsWith('tmdb:genre:') || p.listUrl.startsWith('tmdb:chart:') || p.listUrl.startsWith('trakt:chart:') || p.listUrl.startsWith('simkl:chart:') || p.listUrl.startsWith('tmdb:kids:') || p.listUrl.startsWith('tmdb:holiday:'))) {
    isDualTypeChart = true;
  }

  if (isDualTypeChart && (newType === 'movie' || newType === 'series') && (p.type !== newType || p.listUrl !== targetUrl)) {
    openListDetailsPage(targetName, newType, targetUrl, null, {
      skipPushState: true
    });
    return;
  }

  // Instant client filter for mixed lists (e.g. Watchlist, Custom Mixed Lists):
  if (window._currentListDetailsAllItems && Array.isArray(window._currentListDetailsAllItems)) {
    let filtered = window._currentListDetailsAllItems;
    if (newType === 'movie') {
      filtered = filtered.filter((it) => it.type === 'movie' || (!it.showId && it.type !== 'series' && it.type !== 'episode'));
    } else if (newType === 'series') {
      filtered = filtered.filter((it) => it.type === 'series' || it.type === 'episode' || !!it.showId || it.seasonNum != null);
    }
    const gridEl = document.getElementById('detailGrid');
    const statusEl = document.getElementById('detailStatus');
    if (gridEl) {
      gridEl.innerHTML = filtered.map(livePreviewPosterHtml).join('');
    }
    if (statusEl) {
      statusEl.innerHTML = filtered.length ? '' : '<small>No matching items found.</small>';
    }
  }
};

// The full-page "See All" view for any single, already-known list url --
// used by the Catalogs/Shelves Live Preview, Search results, and My Lists'
// own "view list" buttons alike, so there's one paginated list view in the
// whole app instead of several slightly-different modal/overlay
// implementations. Reuses the exact same /api/preview pagination logic
// the old modal (openListPreviewModal) used -- only the container changed,
// from a showModal() card to the dedicated list-details tab panel (see
// 09_page-shell.js), so a real back button and browser-tab-switch history
// work the way they do for item details, instead of a floating overlay.
//
// opts.skipPushState is set by the popstate handler and the initial
// deep-link check (both in 24_client-backup-restore-presets.js) -- in
// either case the browser's URL already points here, so pushing another
// history entry would just create a duplicate back-button step.
async function openListDetailsPage(name, type, listUrl, preloaded, opts) {
  opts = opts || {};
  const currentActiveTab = window._originTab || localStorage.getItem('myListAddon:activeTab') || document.querySelector('.tab-btn.active, .bottom-nav-item.active')?.dataset.tab || 'discover';
  const currentSubmenu = window._currentCatalogsSubmenu || localStorage.getItem('myListAddon:catalogsSubmenu') || 'all';
  
  if (!opts.preserveScroll) {
    if (currentActiveTab !== 'list-details' && currentActiveTab !== 'item-details') {
      window._previousTab = currentActiveTab;
      window._previousScrollY = window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0;
    }
    switchTab('list-details');
    if (typeof opts.restoreScrollY === 'number') {
      window.scrollTo({ top: opts.restoreScrollY, behavior: 'instant' });
    } else {
      window.scrollTo({ top: 0, behavior: 'instant' });
    }
  }

  if (!opts.skipPushState) {
    try {
      const cleanPath = (typeof getListCleanPath === 'function') ? getListCleanPath(listUrl, name) : null;
      const safeUrlParam = (listUrl && listUrl.length < 1500) ? listUrl : '';
      const targetUrl = cleanPath || ('/#/list?' + new URLSearchParams({ name: name || '', type: type || 'movie', url: safeUrlParam }).toString());
      const currentLoc = window.location.pathname + window.location.search + window.location.hash;
      if (window.location.hash !== targetUrl && currentLoc !== targetUrl) {
        if (cleanPath) {
          history.pushState({ view: 'list', name: name, type: type, listUrl: listUrl, fromTab: currentActiveTab, fromCatalogsSubmenu: currentSubmenu }, '', cleanPath);
        } else {
          const params = new URLSearchParams({ name: name || '', type: type || 'movie', url: safeUrlParam });
          history.pushState({ view: 'list', name: name, type: type, listUrl: safeUrlParam, fromTab: currentActiveTab, fromCatalogsSubmenu: currentSubmenu }, '', '/#/list?' + params.toString());
        }
      }
    } catch (e) {}
  } else if (opts.preserveScroll) {
    try {
      const safeUrlParam = (listUrl && listUrl.length < 1500) ? listUrl : '';
      history.replaceState({ view: 'list', name: name, type: type, listUrl: safeUrlParam, fromTab: currentActiveTab, fromCatalogsSubmenu: currentSubmenu }, '');
    } catch (e) {}
  }

  const cacheKey = (name || '') + '::' + (listUrl || '');
  window._currentListDetailsKey = cacheKey;
  window._listPreloadedCache = window._listPreloadedCache || {};
  if (preloaded && preloaded.sample && preloaded.sample.length) {
    window._listPreloadedCache[cacheKey] = preloaded;
  } else if (!preloaded) {
    if (window._listPreloadedCache[cacheKey]) {
      preloaded = window._listPreloadedCache[cacheKey];
    } else if (listUrl && window._curatedRecs && window._curatedRecs[listUrl]) {
      const rec = window._curatedRecs[listUrl];
      preloaded = { sample: rec.items, count: rec.items.length, maybeMore: false };
    } else if (listUrl && window._simklListsMap && window._simklListsMap[listUrl]) {
      const simklList = window._simklListsMap[listUrl];
      const parts = (listUrl || '').split(':');
      const stKey = parts[3] || 'plantowatch';
      const sample = (simklList.items || []).map((it) => Object.assign({}, it, {
        removeExternalProvider: 'simkl',
        removeExternalTarget: 'status',
        removeExternalListId: stKey,
      }));
      preloaded = { sample: sample, count: sample.length, maybeMore: false };
    } else if (listUrl && listUrl.startsWith('channel:')) {
      try {
        const map = (typeof loadLocalChannels === 'function') ? loadLocalChannels() : {};
        let ch = null;
        if (listUrl.startsWith('channel:id:')) {
          const id = listUrl.slice('channel:id:'.length);
          ch = map[id];
        } else if (listUrl.startsWith('channel:v1:')) {
          try {
            ch = JSON.parse(listUrl.slice('channel:v1:'.length));
          } catch (e) {}
        }
        if (!ch) {
          ch = Object.values(map).find((c) => c && c.name === name);
        }
        if (ch && Array.isArray(ch.items)) {
          const sample = ch.items.map((it, idx) => {
            let showName = it.showName || '';
            let epName = it.epName || '';
            let seasonEp = '';
            if (it.season != null && it.episode != null) {
              seasonEp = 'S' + it.season + 'E' + it.episode;
            }
            if (!showName && it.title) {
              if (it.title.indexOf(' S') !== -1 && it.title.indexOf('E') !== -1) {
                const sIdx = it.title.indexOf(' S');
                showName = it.title.slice(0, sIdx).trim();
                const rest = it.title.slice(sIdx + 1).trim();
                const dashIdx = rest.indexOf(' \u2014 ') !== -1 ? rest.indexOf(' \u2014 ') : (rest.indexOf(' - ') !== -1 ? rest.indexOf(' - ') : rest.indexOf(': '));
                if (dashIdx !== -1) {
                  if (!seasonEp) seasonEp = rest.slice(0, dashIdx).trim();
                  if (!epName) epName = rest.slice(dashIdx + (rest.indexOf(': ') === dashIdx ? 2 : 3)).trim();
                } else {
                  if (!seasonEp) seasonEp = rest.trim();
                }
              } else if (it.title.indexOf(' \u2014 ') !== -1) {
                const parts = it.title.split(' \u2014 ');
                showName = parts[0].trim();
                if (!epName) epName = parts[1].trim();
              } else {
                showName = it.title.trim();
              }
            }
            if (!showName) showName = ch.name || 'TV Channel';
            if (!epName) {
              if (it.epName) epName = it.epName;
              else if (it.title && it.title !== showName) epName = it.title;
              else if (seasonEp) epName = 'Episode ' + (it.episode != null ? it.episode : '');
              else epName = 'Episode';
            }
            const displayTitle = seasonEp ? (showName + ' ' + seasonEp) : showName;
            const fullTitle = showName + (seasonEp ? ' ' + seasonEp : '') + (epName ? ' \u2014 ' + epName : '');
            return {
              id: it.showId || it.id || ('channel_item_' + idx),
              type: it.type || (it.season != null ? 'episode' : 'series'),
              name: displayTitle,
              fullTitle: fullTitle,
              subtitle: '',
              poster: it.showPoster || it.poster || '',
              year: it.year,
              airDate: it.airDate,
              isUnaired: it.isUnaired,
              showId: it.showId,
              seasonNum: it.season,
              epNum: it.episode,
            };
          });
          preloaded = { sample: sample, count: sample.length, maybeMore: false };
        }
      } catch (e) {}
    } else if (listUrl && listUrl.startsWith('autotrack:')) {
      const parts = listUrl.split(':');
      const slug = parts[1];
      const kind = parts[2];
      const creator = parts[3];
      if (typeof getAutoTrackChannelItems === 'function') {
        const sample = getAutoTrackChannelItems(slug, kind, creator);
        preloaded = { sample: sample, count: sample.length, maybeMore: false };
      }
    } else if (!listUrl && name) {
      // Look up local custom lists or creator lists by name or slug
      try {
        const map = (typeof loadLocalCustomLists === 'function') ? loadLocalCustomLists() : {};
        let match = Object.values(map).find((l) => l && (l.name === name || l.slug === name || (name && l.name && l.name.toLowerCase() === name.toLowerCase())));
        if (match && Array.isArray(match.items) && match.items.length) {
          const isCw = match.slug === 'continue-watching';
          const isWatchlist = match.slug === 'watchlist' || match.isWatchlist || (match.name && match.name.toLowerCase() === 'watchlist');
          const isHistory = match.slug === 'watch-history' || (match.name && match.name.toLowerCase() === 'watch history');
          const sample = match.items.map((it) => {
            const label = (typeof formatWatchItemLabel === 'function') ? formatWatchItemLabel(it) : { title: it.title || it.name || '', subtitle: '' };
            return {
              id: it.showId || it.imdbId || it.id,
              type: it.showId ? 'series' : (it.type || it.kind || (match.type === 'mixed' ? 'movie' : (match.type || 'movie'))),
              name: label.title,
              subtitle: label.subtitle,
              poster: isCw ? (it.showPoster || it.poster) : (it.poster || it.showPoster),
              year: it.year,
              airDate: it.airDate,
              isUnaired: it.isUnaired,
              removeShowId: isCw ? (it.showId || it.id) : null,
              removeWatchlistId: isWatchlist ? (it.imdbId || it.id) : null,
              removeHistoryId: isHistory ? (it.id || it.imdbId) : null,
              removeCustomListSlug: (!isCw && !isWatchlist && !isHistory) ? match.slug : null,
            };
          });
          preloaded = { sample: sample, count: sample.length, maybeMore: false };
          window._listPreloadedCache[cacheKey] = preloaded;
        }
      } catch (e) {}

      if (!preloaded && typeof lastCreatorListsData !== 'undefined' && Array.isArray(lastCreatorListsData)) {
        const match = lastCreatorListsData.find((l) => l && (l.name === name || l.slug === name || (name && l.name && l.name.toLowerCase() === name.toLowerCase())));
        if (match && Array.isArray(match.items) && match.items.length) {
          const isCw = match.slug === 'continue-watching';
          const isWatchlist = match.slug === 'watchlist' || match.isWatchlist || (match.name && match.name.toLowerCase() === 'watchlist');
          const isHistory = match.slug === 'watch-history' || (match.name && match.name.toLowerCase() === 'watch history');
          const sample = match.items.map((it) => {
            const label = (typeof formatWatchItemLabel === 'function') ? formatWatchItemLabel(it) : { title: it.title || it.name || '', subtitle: '' };
            return {
              id: it.showId || it.imdbId || it.id,
              type: it.showId ? 'series' : (it.type || it.kind || (match.type === 'mixed' ? 'movie' : (match.type || 'movie'))),
              name: label.title,
              subtitle: label.subtitle,
              poster: isCw ? (it.showPoster || it.poster) : (it.poster || it.showPoster),
              year: it.year,
              airDate: it.airDate,
              isUnaired: it.isUnaired,
              removeShowId: isCw ? (it.showId || it.id) : null,
              removeWatchlistId: isWatchlist ? (it.imdbId || it.id) : null,
              removeHistoryId: isHistory ? (it.id || it.imdbId) : null,
              removeCustomListSlug: (!isCw && !isWatchlist && !isHistory) ? match.slug : null,
            };
          });
          preloaded = { sample: sample, count: sample.length, maybeMore: false };
          window._listPreloadedCache[cacheKey] = preloaded;
        }
      }
    }
  }

  const titleEl = document.getElementById('detailTitle');
  const subEl = document.getElementById('detailSubtitle');
  const gridEl = document.getElementById('detailGrid');
  const statusEl = document.getElementById('detailStatus');
  const addBtn = document.getElementById('detailAddBtn');
  const likeBtn = document.getElementById('detailLikeBtn');
  if (!gridEl) return;

  let creatorName = (opts && opts.creatorName) || (preloaded && preloaded.creatorName) || null;
  const nLower = (name || '').trim().toLowerCase();
  const urlStr = (listUrl || '').trim();
  const urlLower = urlStr.toLowerCase();

  // 1. Explicitly requested "My Lists Addon" lists (Combined, Streaming Catalogs, Genres, Holidays, Kids except Netflix Kids):
  if (
    nLower === 'popular' ||
    nLower === 'trending' ||
    nLower === 'streaming top 10 (all services)' ||
    nLower === 'streaming (all services)' ||
    urlLower.startsWith('tmdb:genre:') ||
    urlLower.startsWith('tmdb:holiday:') ||
    urlLower === 'tmdb:chart:appletv' ||
    urlLower === 'tmdb:chart:disney' ||
    urlLower === 'tmdb:chart:discovery' ||
    urlLower === 'tmdb:chart:hbomax' ||
    urlLower === 'tmdb:chart:hulu' ||
    urlLower === 'tmdb:chart:netflix' ||
    urlLower === 'tmdb:chart:paramount' ||
    urlLower === 'tmdb:chart:primevideo' ||
    urlLower === 'tmdb:chart:peacock' ||
    (urlLower.startsWith('tmdb:kids:') && !nLower.includes('netflix kids') && urlLower !== 'tmdb:chart:netflixkids')
  ) {
    creatorName = 'My Lists Addon';
  }
  // 2. MDBList lists: Extract username or official -> MDBList
  else if (urlLower.includes('mdblist.com/lists/')) {
    const mdb = urlStr.match(new RegExp('(?:https?:)?(?://(?:www\\.)?mdblist\\.com/lists/([^/]+))', 'i'));
    if (mdb) {
      const u = mdb[1];
      if (u.toLowerCase() === 'official') {
        creatorName = 'MDBList';
      } else {
        creatorName = u;
      }
    } else {
      creatorName = 'MDBList';
    }
  }
  // 3. Trakt user lists & charts:
  else if (urlLower.includes('trakt.tv/users/')) {
    const trakt = urlStr.match(new RegExp('(?:https?:)?(?://(?:www\\.)?trakt\\.tv/users/([^/]+))', 'i'));
    if (trakt) {
      creatorName = trakt[1];
    } else {
      creatorName = 'Trakt';
    }
  } else if (urlLower.startsWith('trakt:chart:') || urlLower.startsWith('trakt:watchlist') || urlLower.startsWith('trakt:history')) {
    creatorName = 'Trakt';
  }
  // 4. Simkl charts & user lists:
  else if (urlLower.startsWith('simkl:chart:')) {
    creatorName = 'Simkl';
  } else if (urlLower.startsWith('simkl:user:')) {
    const parts = urlStr.split(':');
    creatorName = parts[2] || 'Simkl';
  }
  // 5. TMDB provider streaming & official charts:
  else if (urlLower === 'tmdb:chart:netflixkids' || nLower.includes('netflix kids')) {
    creatorName = 'Netflix';
  } else if (urlLower.startsWith('tmdb:chart:') || urlLower === 'tmdb:hidden-gems' || urlLower.startsWith('tmdb:top10:')) {
    creatorName = 'TMDB';
  }
  // 6. Creator profile lists or custom lists:
  else if (urlLower.startsWith('channel:') || urlLower.startsWith('channel:v1:') || urlLower.startsWith('autotrack:')) {
    if (!creatorName) creatorName = 'My Lists Addon';
  } else if (urlLower.startsWith('custom:')) {
    if (!creatorName) creatorName = 'My Lists Addon';
  } else if (!creatorName) {
    const internal = urlStr.match(new RegExp('^/lists/([^/]+)/[^/]+', 'i'));
    if (internal && internal[1] !== 'mdblist' && internal[1] !== 'trakt' && internal[1] !== 'tmdb') {
      creatorName = internal[1];
    } else {
      creatorName = 'My Lists Addon';
    }
  }

  let knownTotalItems = (opts && opts.itemCount) || (preloaded && preloaded.itemCount) || (preloaded && Array.isArray(preloaded.items) ? preloaded.items.length : null);
  let likesCount = (opts && opts.likes !== undefined && opts.likes !== null && opts.likes !== '') ? opts.likes : ((preloaded && preloaded.likes !== undefined && preloaded.likes !== null) ? preloaded.likes : null);

  const isNoLikesList =
    nLower.includes('recommended movies') ||
    nLower.includes('recommended shows') ||
    nLower.includes('continue watching') ||
    nLower.includes('watch history') ||
    urlLower.startsWith('custom:curated:') ||
    urlLower.startsWith('autotrack:') ||
    urlLower === 'custom:continue-watching' ||
    urlLower === 'custom:watch-history';

  if (isNoLikesList) {
    likesCount = null;
  }

  function formatSubtitle(count, maybeMore, itemsThisPage) {
    const parts = [];
    if (creatorName) parts.push('by ' + creatorName);
    parts.push(type === 'series' ? 'Shows' : 'Movies');
    if (knownTotalItems != null && knownTotalItems > 0) {
      parts.push(knownTotalItems.toLocaleString() + ' item' + (knownTotalItems === 1 ? '' : 's'));
    } else if (count !== undefined && count !== null) {
      parts.push(count.toLocaleString() + ' item' + (count === 1 ? '' : 's'));
    } else {
      parts.push('Loading\u2026');
    }
    if (likesCount !== null && likesCount !== undefined && likesCount !== '' && !isNoLikesList) {
      parts.push('\u2665 ' + likesCount);
    }
    return parts.join(' \u2022 ');
  }

  window._currentListDetailsUpdateLikes = function(newLikes) {
    likesCount = newLikes;
    subEl.textContent = formatSubtitle(loadedCount, false, 0);
  };

  window._updateListDetailsItemCount = function(newCount) {
    loadedCount = newCount;
    if (subEl) subEl.textContent = formatSubtitle(newCount, false, 0);
  };

  titleEl.textContent = name || 'List';
  subEl.textContent = formatSubtitle(null, false, 0);
  gridEl.innerHTML = '';
  gridEl.classList.toggle('is-watch-history-shelf', !!(name && name.toLowerCase().includes('watch history')));
  statusEl.innerHTML = '<small>Loading\u2026</small>';

  // Both only make sense against a real external url -- a local/My Lists
  // preview (listUrl === '') has nothing a catalog row could point at,
  // and nothing any other visitor could "like" either.
  function updateDetailAddBtn() {
    if (!listUrl && !name) {
      addBtn.style.display = 'none';
      return;
    }
    addBtn.style.display = '';
    const isAdded = typeof isListAddedToConfig === 'function' ? (isListAddedToConfig(listUrl, type) || isListAddedToConfig(null, type, listUrl)) : false;
    if (isAdded) {
      addBtn.textContent = 'Remove';
      addBtn.classList.remove('primary');
      addBtn.classList.add('secondary');
      addBtn.style.color = 'var(--danger)';
    } else {
      addBtn.textContent = '+ Add';
      addBtn.classList.add('primary');
      addBtn.classList.remove('secondary');
      addBtn.style.color = '';
    }
  }
  updateDetailAddBtn();

  window._currentListDetailsParams = { name, type, listUrl };
  window._currentListDetailsFilter = (type === 'movie' || type === 'series') ? type : 'all';
  window._currentListDetailsAllItems = [];
  const filterBar = document.getElementById('detailFilterBar');
  const isWatchHistory = (name && name.toLowerCase().includes('watch history')) || (listUrl === 'autotrack:watch-history' || listUrl === 'custom:watch-history');

  let isDualTypeChart = false;
  if (typeof CHART_SLUG_ENTRIES !== 'undefined' && Array.isArray(CHART_SLUG_ENTRIES)) {
    const match = CHART_SLUG_ENTRIES.find((e) => e.name === name || e.movieUrl === listUrl || e.showUrl === listUrl);
    if (match && match.movieUrl && match.showUrl) {
      isDualTypeChart = true;
    }
  }
  if (!isDualTypeChart && listUrl && (listUrl.startsWith('tmdb:genre:') || listUrl.startsWith('tmdb:chart:') || listUrl.startsWith('trakt:chart:') || listUrl.startsWith('simkl:chart:') || listUrl.startsWith('tmdb:kids:') || listUrl.startsWith('tmdb:holiday:'))) {
    isDualTypeChart = true;
  }

  const isMixedList = type === 'mixed' || isDualTypeChart || (preloaded && preloaded.sample && preloaded.sample.some((it) => it.type === 'series' || it.showId) && preloaded.sample.some((it) => it.type === 'movie' || (!it.showId && it.type !== 'series' && it.type !== 'episode'))) || (listUrl && (listUrl.includes('watchlist') || listUrl.includes('continue-watching') || listUrl.startsWith('autotrack:')));

  const whControls = document.getElementById('whFilterControls');
  const whSortControls = document.getElementById('whSortControls');
  const genericTypeControls = document.getElementById('genericTypeFilterControls');

  if (filterBar) {
    if (isWatchHistory) {
      filterBar.style.display = 'flex';
      if (whControls) whControls.style.display = 'flex';
      if (whSortControls) whSortControls.style.display = 'flex';
      if (genericTypeControls) genericTypeControls.style.display = 'none';

      const groupShowsCb = document.getElementById('whGroupShowsCheckbox');
      if (groupShowsCb) {
        groupShowsCb.checked = localStorage.getItem('myListAddon:watchHistoryGroupShows') === 'true';
      }
      const sortSel = document.getElementById('whSortSelect');
      if (sortSel) {
        sortSel.value = window._watchHistorySort || 'recent';
      }
      const curFilter = window._watchHistoryFilter || 'all';
      filterBar.querySelectorAll('.wh-filter-pill').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.whFilter === curFilter);
      });
    } else if (isDualTypeChart || isMixedList) {
      filterBar.style.display = 'flex';
      if (whControls) whControls.style.display = 'none';
      if (whSortControls) whSortControls.style.display = 'none';
      if (genericTypeControls) {
        genericTypeControls.style.display = 'flex';
        const aBtn = document.getElementById('detailTypeAllBtn');
        const mBtn = document.getElementById('detailTypeMovieBtn');
        const sBtn = document.getElementById('detailTypeSeriesBtn');
        if (isDualTypeChart) {
          // On dual-type charts (Catalogs Quick Add & Discover), hide 'All' and show only 'Movies' & 'Shows'
          if (aBtn) aBtn.style.display = 'none';
          if (mBtn) {
            mBtn.style.display = '';
            mBtn.classList.toggle('active', type === 'movie');
          }
          if (sBtn) {
            sBtn.style.display = '';
            sBtn.classList.toggle('active', type === 'series');
          }
        } else {
          // On mixed lists, show 'All', 'Movies', and 'Shows'
          const curFilter = window._currentListDetailsFilter || (type === 'movie' || type === 'series' ? type : 'all');
          if (aBtn) {
            aBtn.style.display = '';
            aBtn.classList.toggle('active', curFilter === 'all');
          }
          if (mBtn) {
            mBtn.style.display = '';
            mBtn.classList.toggle('active', curFilter === 'movie');
          }
          if (sBtn) {
            sBtn.style.display = '';
            sBtn.classList.toggle('active', curFilter === 'series');
          }
        }
      }
    } else {
      filterBar.style.display = 'none';
    }
  }

  if (isWatchHistory) {
    if (likeBtn) likeBtn.style.display = 'none';
    if (addBtn) addBtn.style.display = 'none';
    const localMap = (typeof loadLocalCustomLists === 'function') ? loadLocalCustomLists() : {};
    const hist = localMap['watch-history'];
    window._rawWatchHistoryItems = (hist && Array.isArray(hist.items)) ? hist.items : [];
    renderWatchHistoryGrid();
    return;
  }

  if (likeBtn) {
    if (listUrl && !listUrl.startsWith('custom:') && !listUrl.startsWith('channel:') && !listUrl.startsWith('channel:v1:') && !listUrl.startsWith('autotrack:')) {
      const isLiked = getLikedListsSet().has(listUrl);
      likeBtn.style.display = '';
      likeBtn.dataset.url = listUrl;
      likeBtn.classList.toggle('liked', isLiked);
      likeBtn.innerHTML = isLiked ? '&#9829;' : '&#9825;';
    } else {
      likeBtn.style.display = 'none';
    }
  }

  addBtn.onclick = function() {
    const isAdded = typeof isListAddedToConfig === 'function' ? (isListAddedToConfig(listUrl, type) || isListAddedToConfig(null, type, listUrl)) : false;
    if (isAdded) {
      if (typeof removeListFromConfig === 'function') {
        removeListFromConfig(listUrl, type);
        removeListFromConfig(null, type, listUrl);
      }
      updateDetailAddBtn();
      showAddedToast('Removed "' + (name || 'List') + '" from your Catalogs.');
    } else {
      if (listUrl && listUrl.startsWith('custom:curated:')) {
        addRow(name || 'Curated List', listUrl, type, true, 'Curated');
      } else if (listUrl && (listUrl.startsWith('tmdb:chart:') || listUrl.startsWith('tmdb:') || listUrl.startsWith('autotrack:'))) {
        addRow(name || 'List', listUrl, type, true, 'New Releases');
      } else {
        addRow(name || 'List', listUrl, type, true, 'Custom');
      }
      updateDetailAddBtn();
      showAddedToast('Added "' + (name || 'List') + '" to your Catalogs.');
    }
  };

  const keys = collectKeys();
  let skip = 0;
  let loading = false;
  let done = false;
  let loadedCount = 0;
  let pagesLoaded = 0;
  const MAX_PAGES = 20;

  const isSimklUserList = listUrl && listUrl.startsWith('simkl:user:');
  const simklStatusMatch = isSimklUserList ? (listUrl.split(':')[3] || 'plantowatch') : '';

  const traktUser = (typeof traktUsername !== 'undefined' && traktUsername) || localStorage.getItem('myListAddon:traktUsername') || '';
  const isTraktWatchlist = listUrl && (listUrl === 'trakt:watchlist' || listUrl.includes('trakt.tv/users/' + traktUser + '/watchlist') || (listUrl.includes('/watchlist') && listUrl.includes('trakt')));
  const isTraktHistory = listUrl && (listUrl === 'trakt:history' || listUrl.includes('/history'));
  const isTraktUserList = listUrl && (listUrl.startsWith('trakt:user:') || listUrl.includes('trakt.tv/users/'));
  const traktListSlug = isTraktUserList ? (listUrl.includes('/lists/') ? (listUrl.split('/lists/')[1] || '').split('/')[0] : (listUrl.split(':')[3] || '')) : '';

  const tmdbAcc = (typeof tmdbAccountId !== 'undefined' && tmdbAccountId) || localStorage.getItem('myListAddon:tmdbAccountId') || '';
  const isTmdbWatchlist = listUrl && (listUrl === 'tmdb:watchlist' || listUrl.startsWith('tmdb:account:watchlist') || (listUrl.includes('watchlist') && listUrl.includes('tmdb')));
  const isTmdbFavorites = listUrl && (listUrl === 'tmdb:favorites' || listUrl.startsWith('tmdb:account:favorites') || (listUrl.includes('favorite') && listUrl.includes('tmdb')));
  const isTmdbUserList = listUrl && (listUrl.includes('themoviedb.org/list/') || listUrl.startsWith('tmdb:list:'));
  const tmdbListId = isTmdbUserList ? (listUrl.match(new RegExp('list(?:/|:)([0-9]+)', 'i'))?.[1] || '') : '';

  const mdbUser = (typeof mdblistUsername !== 'undefined' && mdblistUsername) || localStorage.getItem('myListAddon:mdblistUsername') || '';
  const isMdbWatchlist = listUrl && (listUrl === 'mdblist:watchlist' || (listUrl.includes('watchlist') && listUrl.includes('mdblist')));
  const isMdbHistory = listUrl && (listUrl === 'mdblist:history' || (listUrl.includes('history') && listUrl.includes('mdblist')));
  const isMdbUserList = listUrl && (listUrl.includes('mdblist.com/lists/') || listUrl.startsWith('mdblist:list:'));
  const mdbListId = isMdbUserList ? (listUrl.includes('mdblist.com/lists/') ? (listUrl.split('/lists/')[1] || '').split('/')[1] || (listUrl.split('/lists/')[1] || '').split('/')[0] : (listUrl.split(':')[2] || '')) : '';

  function annotatePersonalItem(it) {
    if (!it) return it;
    if (isSimklUserList) {
      return Object.assign({}, it, {
        removeExternalProvider: 'simkl',
        removeExternalTarget: 'status',
        removeExternalListId: simklStatusMatch,
      });
    }
    if (isTraktWatchlist) {
      return Object.assign({}, it, {
        removeExternalProvider: 'trakt',
        removeExternalTarget: 'watchlist',
        removeExternalListId: 'watchlist',
      });
    }
    if (isTraktHistory) {
      return Object.assign({}, it, {
        removeExternalProvider: 'trakt',
        removeExternalTarget: 'history',
        removeExternalListId: 'history',
      });
    }
    if (isTraktUserList && traktListSlug) {
      return Object.assign({}, it, {
        removeExternalProvider: 'trakt',
        removeExternalTarget: 'custom',
        removeExternalListId: traktListSlug,
      });
    }
    if (isMdbWatchlist) {
      return Object.assign({}, it, {
        removeExternalProvider: 'mdblist',
        removeExternalTarget: 'watchlist',
        removeExternalListId: 'watchlist',
      });
    }
    if (isMdbHistory) {
      return Object.assign({}, it, {
        removeExternalProvider: 'mdblist',
        removeExternalTarget: 'history',
        removeExternalListId: 'history',
      });
    }
    if (isMdbUserList && mdbListId) {
      return Object.assign({}, it, {
        removeExternalProvider: 'mdblist',
        removeExternalTarget: 'custom',
        removeExternalListId: mdbListId,
      });
    }
    if (isTmdbWatchlist) {
      return Object.assign({}, it, {
        removeExternalProvider: 'tmdb',
        removeExternalTarget: 'watchlist',
      });
    }
    if (isTmdbFavorites) {
      return Object.assign({}, it, {
        removeExternalProvider: 'tmdb',
        removeExternalTarget: 'favorite',
      });
    }
    if (isTmdbUserList && tmdbListId) {
      return Object.assign({}, it, {
        removeExternalProvider: 'tmdb',
        removeExternalTarget: 'custom',
        removeExternalListId: tmdbListId,
      });
    }
    if (isMdbWatchlist) {
      return Object.assign({}, it, {
        removeExternalProvider: 'mdblist',
        removeExternalTarget: 'watchlist',
      });
    }
    if (isMdbUserList && mdbListId) {
      return Object.assign({}, it, {
        removeExternalProvider: 'mdblist',
        removeExternalTarget: 'custom',
        removeExternalListId: mdbListId,
      });
    }
    return it;
  }

  function appendItems(items) {
    const annotated = items.map(annotatePersonalItem);
    window._currentListDetailsAllItems = (window._currentListDetailsAllItems || []).concat(annotated);
    const curFilter = window._currentListDetailsFilter || 'all';
    let filtered = window._currentListDetailsAllItems;
    if (curFilter === 'movie') {
      filtered = filtered.filter((it) => it.type === 'movie' || (!it.showId && it.type !== 'series' && it.type !== 'episode'));
    } else if (curFilter === 'series') {
      filtered = filtered.filter((it) => it.type === 'series' || it.type === 'episode' || !!it.showId || it.seasonNum != null);
    }
    gridEl.innerHTML = filtered.map(livePreviewPosterHtml).join('');
    loadedCount = window._currentListDetailsAllItems.length;
  }
  function updateStatusAfterPage(maybeMore, itemsThisPage) {
    subEl.textContent = formatSubtitle(loadedCount, maybeMore, itemsThisPage);
    if (!maybeMore || itemsThisPage === 0 || pagesLoaded >= MAX_PAGES) {
      done = true;
      statusEl.innerHTML = loadedCount ? '' : '<small>No items found.</small>';
    } else {
      statusEl.innerHTML = '<small>Scroll for more\u2026</small>';
    }
  }

  async function loadNextPage() {
    if (loading || done) return;
    if (!listUrl || listUrl.startsWith('custom:')) {
      done = true;
      statusEl.innerHTML = loadedCount ? '' : '<small>No items found.</small>';
      return;
    }
    loading = true;
    statusEl.innerHTML = '<small>Loading\u2026</small>';
    try {
      const body = { url: listUrl, type: type, skip: skip, sample: 100 };
      if (keys.tmdbKey) body.tmdbKey = keys.tmdbKey;
      if (keys.mdblistKey) body.mdblistKey = keys.mdblistKey;
      if (keys.mdblistAccessToken) body.mdblistAccessToken = keys.mdblistAccessToken;
      if (keys.traktKey) body.traktKey = keys.traktKey;
      if (keys.traktAccessToken) body.traktAccessToken = keys.traktAccessToken;
      if (keys.simklKey) body.simklKey = keys.simklKey;
      if (keys.simklAccessToken) body.simklAccessToken = keys.simklAccessToken;
      if (creatorName) body.creatorName = creatorName;
      const res = await fetch(ORIGIN + '/api/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
      });
      const data = await res.json();
      if (!data.ok) {
        statusEl.innerHTML = '<p class="testresult err">\u2717 ' + escapeHtml(data.error || 'Could not load this list.') + '</p>';
        done = true;
        return;
      }
      if (typeof data.totalItems === 'number' && data.totalItems > 0) {
        knownTotalItems = data.totalItems;
      }
      const items = data.sample || [];
      appendItems(items);
      skip += items.length;
      pagesLoaded++;
      updateStatusAfterPage(data.maybeMore, items.length);
    } catch (e) {
      console.error('List preview fetch error:', e);
      statusEl.innerHTML = '<p class="testresult err">\u2717 ' + escapeHtml(e && e.message ? e.message : 'Network error loading this list.') + '</p>';
      done = true;
    } finally {
      loading = false;
    }
  }

  // Scrolls the whole page (not a modal card) -- this is a real tab panel
  // now, so "near the bottom of the page" is what should trigger the next
  // page, the same way any other infinite-scroll feed on the page would.
  if (!window._listDetailsScrollBound) {
    window._listDetailsScrollBound = true;
    window.addEventListener('scroll', () => {
      const panel = document.getElementById('content-list-details');
      if (!panel || panel.hidden || !window._listDetailsLoadNextPage) return;
      if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 400) {
        window._listDetailsLoadNextPage();
      }
    });
  }
  window._listDetailsLoadNextPage = loadNextPage;

  if (preloaded && preloaded.sample && preloaded.sample.length) {
    appendItems(preloaded.sample);
    skip = preloaded.sample.length;
    pagesLoaded = 1;
    updateStatusAfterPage(preloaded.maybeMore, preloaded.sample.length);
  } else {
    await loadNextPage();
  }

  if (opts && typeof opts.restoreScrollY === 'number') {
    const scrollTarget = opts.restoreScrollY;
    setTimeout(() => {
      window.scrollTo({ top: scrollTarget, behavior: 'instant' });
    }, 10);
  }
}

// Reuses the page-0 sample renderLivePreview already fetched for this
// shelf (see livePreviewShelfData) so opening See All doesn't cost a
// redundant request -- openListDetailsPage picks up pagination from
// there for anything beyond it.
function openLivePreviewSeeAll(i) {
  const shelf = livePreviewShelfData[i];
  if (!shelf) return;
  openListDetailsPage(shelf.name, shelf.type, shelf.url, { sample: shelf.sample, maybeMore: shelf.maybeMore });
}

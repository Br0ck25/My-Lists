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
  // trackPlayback only actually applies once signed into a Creator
  // Profile (see renderTrackPlaybackSection's comment for why) -- the
  // checkbox state can outlive a sign-out in localStorage, so this only
  // includes it when there's actually an account to attach it to.
  let track = false;
  try { track = localStorage.getItem('myListAddon:trackPlayback') === '1'; } catch (e) {}
  const keys = {
    mdblistKey: document.getElementById('mdblistKeyInput').value.trim(),
    traktKey: document.getElementById('traktKeyInput').value.trim(),
    traktUsername: document.getElementById('traktUsernameInput').value.trim(),
    traktAccessToken: traktAccessToken,
  };
  if (track && typeof activeCreator !== 'undefined' && activeCreator) {
    keys.track = true;
    keys.trackCreatorName = activeCreator.creatorName;
    keys.trackCreatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
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
        if (keys.mdblistKey) body.mdblistKey = keys.mdblistKey;
        if (keys.traktKey) body.traktKey = keys.traktKey;
        if (keys.traktAccessToken) body.traktAccessToken = keys.traktAccessToken;
        const res = await fetch(ORIGIN + '/api/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          cache: 'no-store',
        });
        const data = await res.json();
        if (!data.ok) {
          postersContainer.innerHTML = '<p class="testresult err">✗ ' + escapeHtml(data.error || 'Could not load this shelf.') + '</p>';
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
        postersContainer.innerHTML = '<p class="testresult err">✗ Network error loading this shelf.</p>';
      }
    }
  }

  const workers = Array(Math.min(CONCURRENCY, shelves.length)).fill(0).map(worker);
  await Promise.all(workers);
}

function livePreviewPosterHtml(m) {
  const landscape = m.posterShape === 'landscape';
  const posterClass = 'live-preview-poster' + (landscape ? ' landscape' : '');
  const posterEl = m.poster
    ? '<img class="' + posterClass + '" src="' + escapeAttr(m.poster) + '" alt="" loading="lazy">'
    : '<div class="' + posterClass + ' live-preview-poster-placeholder"><small style="color:var(--muted); font-size:0.7rem;">No poster</small></div>';
  const removeBtn = m.removeShowId
    ? '<button type="button" class="cw-remove-btn" onclick="event.stopPropagation(); dismissContinueWatchingShow(&quot;' + escapeAttr(m.removeShowId) + '&quot;)" title="Remove from Continue Watching">&times;</button>'
    : '';
  const yearHtml = m.year ? '<div class="live-preview-poster-year">' + escapeHtml(m.year) + '</div>' : '';
  const addOverlay = '<div class="poster-add-overlay" title="Add to Custom List">+</div>';
  return '<div class="live-preview-poster-card clickable-poster" data-id="' + escapeAttr(m.id || '') + '" data-type="' + escapeAttr(m.type || '') + '" data-title="' + escapeAttr(m.name || '') + '" data-poster="' + escapeAttr(m.poster || '') + '">' +
    '<div style="position:relative; width:100%;">' +
      posterEl +
      removeBtn +
      addOverlay +
    '</div>' +
    '<div class="live-preview-poster-name">' + escapeHtml(m.name || '') + '</div>' +
    (m.subtitle ? '<div class="live-preview-poster-subtitle">' + escapeHtml(m.subtitle) + '</div>' : '') +
    yearHtml +
  '</div>';
}

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
  const currentActiveTab = localStorage.getItem('myListAddon:activeTab') || document.querySelector('.tab-btn.active, .bottom-nav-item.active')?.dataset.tab || 'discover';
  if (currentActiveTab !== 'list-details' && currentActiveTab !== 'item-details') {
    window._previousTab = currentActiveTab;
    window._previousScrollY = window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0;
  }
  switchTab('list-details');

  if (!opts.skipPushState) {
    const cleanPath = (listUrl && typeof getListCleanPath === 'function') ? getListCleanPath(listUrl, name) : null;
    if (cleanPath) {
      history.pushState({ view: 'list', name: name, type: type, listUrl: listUrl }, '', cleanPath);
    } else {
      const params = new URLSearchParams({ name: name || '', type: type || 'movie', url: listUrl || '' });
      history.pushState({ view: 'list', name: name, type: type, listUrl: listUrl || '' }, '', '/#/list?' + params.toString());
    }
  }

  if (!preloaded && listUrl && window._curatedRecs && window._curatedRecs[listUrl]) {
    const rec = window._curatedRecs[listUrl];
    preloaded = { sample: rec.items, count: rec.items.length, maybeMore: false };
  }

  const titleEl = document.getElementById('detailTitle');
  const subEl = document.getElementById('detailSubtitle');
  const gridEl = document.getElementById('detailGrid');
  const statusEl = document.getElementById('detailStatus');
  const addBtn = document.getElementById('detailAddBtn');
  const likeBtn = document.getElementById('detailLikeBtn');
  if (!gridEl) return;

  let creatorName = (opts && opts.creatorName) || (preloaded && preloaded.creatorName) || null;
  if (!creatorName && listUrl) {
    const mdb = listUrl.match(new RegExp('(?:https?:)?(?://)?(?:www\\.)?mdblist\\.com/lists/([^/]+)', 'i'));
    if (mdb) creatorName = mdb[1];
    const trakt = listUrl.match(new RegExp('(?:https?:)?(?://)?(?:www\\.)?trakt\\.tv/users/([^/]+)', 'i'));
    if (trakt) creatorName = trakt[1];
    const internal = listUrl.match(new RegExp('^/lists/([^/]+)/[^/]+', 'i'));
    if (internal && internal[1] !== 'mdblist' && internal[1] !== 'trakt' && internal[1] !== 'tmdb') {
      creatorName = internal[1];
    }
  }

  const knownTotalItems = (opts && opts.itemCount) || (preloaded && preloaded.itemCount) || (preloaded && Array.isArray(preloaded.items) ? preloaded.items.length : null);
  let likesCount = (opts && opts.likes !== undefined && opts.likes !== null && opts.likes !== '') ? opts.likes : ((preloaded && preloaded.likes !== undefined && preloaded.likes !== null) ? preloaded.likes : null);

  function formatSubtitle(count, maybeMore, itemsThisPage) {
    const parts = [];
    if (creatorName) parts.push('by ' + creatorName);
    parts.push(type === 'series' ? 'Shows' : 'Movies');
    if (knownTotalItems) {
      parts.push(knownTotalItems + ' items');
    } else if (count !== undefined && count !== null) {
      parts.push(count + (maybeMore && itemsThisPage > 0 && pagesLoaded < MAX_PAGES ? '+' : '') + ' item' + (count === 1 ? '' : 's'));
    } else {
      parts.push('Loading\u2026');
    }
    if (likesCount !== null && likesCount !== undefined && likesCount !== '') {
      parts.push('\u2665 ' + likesCount);
    }
    return parts.join(' \u2022 ');
  }

  window._currentListDetailsUpdateLikes = function(newLikes) {
    likesCount = newLikes;
    subEl.textContent = formatSubtitle(loadedCount, false, 0);
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
    if (!listUrl || listUrl.startsWith('custom:')) {
      addBtn.style.display = 'none';
      return;
    }
    addBtn.style.display = '';
    const isAdded = typeof isListAddedToConfig === 'function' ? isListAddedToConfig(listUrl, type) : false;
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

  if (likeBtn) {
    if (listUrl && !listUrl.startsWith('custom:')) {
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
    const isAdded = typeof isListAddedToConfig === 'function' ? isListAddedToConfig(listUrl, type) : false;
    if (isAdded) {
      if (typeof removeListFromConfig === 'function') removeListFromConfig(listUrl, type);
      updateDetailAddBtn();
      showAddedToast('Removed "' + (name || 'List') + '" from your Catalogs.');
    } else {
      addRow(name || 'List', listUrl, type, true, 'Custom');
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

  function appendItems(items) {
    gridEl.insertAdjacentHTML('beforeend', items.map(livePreviewPosterHtml).join(''));
    loadedCount += items.length;
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
      if (keys.mdblistKey) body.mdblistKey = keys.mdblistKey;
      if (keys.traktKey) body.traktKey = keys.traktKey;
      if (keys.traktAccessToken) body.traktAccessToken = keys.traktAccessToken;
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
      const items = data.sample || [];
      appendItems(items);
      skip += items.length;
      pagesLoaded++;
      updateStatusAfterPage(data.maybeMore, items.length);
    } catch (e) {
      statusEl.innerHTML = '<p class="testresult err">\u2717 Network error loading this list.</p>';
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






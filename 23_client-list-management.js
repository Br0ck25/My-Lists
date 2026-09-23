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
  if (typeof updateAllListAddButtons === 'function') updateAllListAddButtons();
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

// Drag-to-reorder, as an addition to (not a replacement for) the ↑/↓
// buttons above -- those still work and are the only option on touch
// devices, where native HTML5 drag-and-drop generally isn't supported.
// Drag-to-reorder for catalog rows, powered by unified createSortableList
const listsContainer = document.getElementById('lists');
if (listsContainer) {
  createSortableList(listsContainer, {
    itemSelector: '.entry',
    handleSelector: '.drag-handle, .shelf-drag-handle',
    onReorder: renumber
  });
}

function initTouchDrag(handle) {
  // Handled transparently by createSortableList on container
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

let activeUndoToast = null;

function showUndoToast(message) {
  if (typeof showToast === 'function') {
    if (activeUndoToast && typeof activeUndoToast.dismiss === 'function') {
      activeUndoToast.dismiss();
    }
    activeUndoToast = showToast(message, 'undo', {
      duration: 8000,
      actionText: 'Undo',
      onAction: function() {
        performUndo();
      }
    });
    return;
  }
  const toast = document.getElementById('undoToast');
  if (toast) {
    document.getElementById('undoToastMsg').textContent = message;
    toast.style.display = 'flex';
    clearTimeout(undoTimer);
    undoTimer = setTimeout(hideUndoToast, 8000);
  }
}

function hideUndoToast() {
  if (activeUndoToast && typeof activeUndoToast.dismiss === 'function') {
    activeUndoToast.dismiss();
    activeUndoToast = null;
  }
  const toast = document.getElementById('undoToast');
  if (toast) toast.style.display = 'none';
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
    const keys = typeof collectKeys === 'function' ? collectKeys() : {};
    const body = { url, type };
    if (keys.tmdbKey) body.tmdbKey = keys.tmdbKey;
    if (keys.mdblistKey) body.mdblistKey = keys.mdblistKey;
    if (keys.mdblistAccessToken) body.mdblistAccessToken = keys.mdblistAccessToken;
    if (keys.traktKey) body.traktKey = keys.traktKey;
    if (keys.traktAccessToken) body.traktAccessToken = keys.traktAccessToken;
    if (keys.simklKey) body.simklKey = keys.simklKey;
    if (keys.simklAccessToken) body.simklAccessToken = keys.simklAccessToken;
    if (keys.creatorName) body.creatorName = keys.creatorName;
    const previewKey = previewCreatorKey(url);
    if (previewKey) body.creatorKey = previewKey;
    if (keys.adultContentFilter || (typeof isAdultContentFilterEnabled === 'function' && isAdultContentFilterEnabled())) body.adultContentFilter = true;
    const res = await fetch(ORIGIN + '/api/preview', {
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
        '<img class="preview-thumb" src="' + escapeAttr(typeof resolveClientPoster === 'function' ? resolveClientPoster(s, s.poster) : s.poster) + '" alt="' + escapeAttr(s.name) + '" title="' + escapeAttr(s.name) + '" loading="lazy">'
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

function buildConfig(entries, keys) {
  const payload = { entries };
  if (keys && keys.tmdbKey) payload.tmdbKey = keys.tmdbKey;
  if (keys && keys.mdblistKey) payload.mdblistKey = keys.mdblistKey;
  if (keys && keys.mdblistAccessToken) payload.mdblistAccessToken = keys.mdblistAccessToken;
  if (keys && keys.traktKey) payload.traktKey = keys.traktKey;
  if (keys && keys.traktUsername) payload.traktUsername = keys.traktUsername;
  if (keys && keys.traktAccessToken) payload.traktAccessToken = keys.traktAccessToken;
  if (keys && keys.simklKey) payload.simklKey = keys.simklKey;
  if (keys && keys.simklAccessToken) payload.simklAccessToken = keys.simklAccessToken;
  if (keys && keys.simklUsername) payload.simklUsername = keys.simklUsername;
  if (keys && keys.track) {
    payload.track = true;
    payload.trackCreatorName = keys.trackCreatorName;
    payload.trackCreatorKey = keys.trackCreatorKey;
  }
  if (keys && keys.shuffleShelves) payload.shuffleShelves = true;
  if (keys && keys.shuffleItems) payload.shuffleItems = true;
  if (keys && keys.region && keys.region !== 'US') payload.region = keys.region;
  if (keys && keys.hideNonDigitalReleases) payload.hideNonDigitalReleases = true;
  if (keys && keys.adultContentFilter) payload.adultContentFilter = true;
  if (keys && keys.dedupeAcrossLists) payload.dedupeAcrossLists = true;
  // BetterPosters. Only written when it is actually on, and each style key
  // only when it differs from btttr.cc's default for that option -- an
  // install link should not grow by eight keys for a feature left off, and a
  // default style round-trips to the same URL either way.
  if (keys && keys.betterPosters) {
    payload.betterPosters = true;
    if (keys.betterPostersGenre === false) payload.betterPostersGenre = false;
    if (keys.betterPostersRating === false) payload.betterPostersRating = false;
    if (keys.betterPostersTrendTags === false) payload.betterPostersTrendTags = false;
    if (keys.betterPostersQuality) payload.betterPostersQuality = true;
    if (keys.betterPostersAge) payload.betterPostersAge = true;
    if (keys.betterPostersLang && keys.betterPostersLang !== 'en') payload.betterPostersLang = keys.betterPostersLang;
    if (keys.betterPostersRatingSource && keys.betterPostersRatingSource !== 'avg') payload.betterPostersRatingSource = keys.betterPostersRatingSource;
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
//
// The slug is matched generically rather than as a fixed list. It used to
// name only watch-history and continue-watching, which meant an Airing
// Next row pointing at the wrong username was the one autotrack row that
// never self-healed: every other kind silently corrected itself on the
// next collectEntries() while that one kept resolving
// creatorsynctracking:<wrong-name>, missing, and rendering "No items
// found" indefinitely. Every autotrack slug reads the same per-account
// tracking record, so every one of them wants the same repair -- and
// spelling them out individually means each slug added later inherits
// the bug again.
function repairAutotrackUrl(url) {
  if (!activeCreator || !activeCreator.creatorName) return url;
  const m = /^autotrack:([a-z0-9-]+):(movie|series|mixed):(.*)$/.exec(url);
  if (!m || m[3] === activeCreator.creatorName) return url;
  return 'autotrack:' + m[1] + ':' + m[2] + ':' + activeCreator.creatorName;
}

// The Creator Key that lets /api/preview prove who is asking.
//
// Watch History, Continue Watching, Watchlist and Airing Next are
// 'autotrack:<slug>:<type>:<username>' rows, and reading one server-side
// means reading that account's private tracking record. /api/preview is an
// unauthenticated endpoint, so the username inside that string is a claim and
// nothing more until the caller proves it -- and mayReadTrackedShelf
// (02_http-and-creator-utils.js) answers an unproven reader with an EMPTY
// shelf rather than an error, because a catalog row has no way to show a
// message. That is exactly what "No items found." in Live Preview & Editor
// was: not a missing shelf, an unauthenticated read of one. Airing Next has
// no share flag at all (only watchlist, watch-history and continue-watching
// have one), so proving ownership is the ONLY way to read it -- which is why
// adding it to the config could never preview even for its own owner.
//
// Sent only for a url that actually names one of those shelves, for the same
// reason collectKeys only puts trackCreatorKey into a config that carries
// one: the key is a bearer credential, and a preview of a public
// mdblist/trakt/tmdb list has no business carrying it.
function previewCreatorKey(url) {
  if (typeof activeCreator === 'undefined' || !activeCreator || !activeCreator.creatorName) return '';
  if (!urlHasAutotrackSource(url)) return '';
  try {
    return localStorage.getItem('myListAddon:creatorKey') || '';
  } catch (e) {
    return '';
  }
}

// A merged row stacks several sources into one newline-separated url (see
// collectEntries), so a personal shelf can sit on any line of it, not only
// the first.
function urlHasAutotrackSource(url) {
  return String(url || '').split('\\n').some((line) => line.trim().startsWith('autotrack:'));
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

  const tmdbDisc = localStorage.getItem('myListAddon:tmdbDisconnected') === 'true';
  const mdblistDisc = localStorage.getItem('myListAddon:mdblistDisconnected') === 'true';
  const traktDisc = localStorage.getItem('myListAddon:traktDisconnected') === 'true';
  const simklDisc = localStorage.getItem('myListAddon:simklDisconnected') === 'true';

  const tmdbKeyEl = document.getElementById('tmdbKeyInput');
  let tmdbKey = tmdbKeyEl ? tmdbKeyEl.value.trim() : '';
  if (!tmdbKey && !tmdbDisc) {
    try { tmdbKey = localStorage.getItem('myListAddon:tmdbKey') || ''; } catch (e) {}
  }
  let tmdbSession = (typeof tmdbSessionId !== 'undefined' && tmdbSessionId) || '';
  if (!tmdbSession && !tmdbDisc) {
    try { tmdbSession = localStorage.getItem('myListAddon:tmdbSessionId') || ''; } catch (e) {}
  }
  let tmdbAcc = (typeof tmdbAccountId !== 'undefined' && tmdbAccountId) || '';
  if (!tmdbAcc && !tmdbDisc) {
    try { tmdbAcc = localStorage.getItem('myListAddon:tmdbAccountId') || ''; } catch (e) {}
  }
  let tmdbUser = (typeof tmdbUsername !== 'undefined' && tmdbUsername) || '';
  if (!tmdbUser && !tmdbDisc) {
    try { tmdbUser = localStorage.getItem('myListAddon:tmdbUsername') || ''; } catch (e) {}
  }

  const mdblistKeyEl = document.getElementById('mdblistKeyInput');
  let mdblistKey = mdblistKeyEl ? mdblistKeyEl.value.trim() : '';
  if (!mdblistKey && !mdblistDisc) {
    try { mdblistKey = localStorage.getItem('myListAddon:mdblistKey') || ''; } catch (e) {}
  }
  let mdblistToken = (typeof mdblistAccessToken !== 'undefined' && mdblistAccessToken) || '';
  if (!mdblistToken && !mdblistDisc) {
    try { mdblistToken = localStorage.getItem('myListAddon:mdblistAccessToken') || ''; } catch (e) {}
  }
  let mdblistUser = (typeof mdblistUsername !== 'undefined' && mdblistUsername) || '';
  if (!mdblistUser && !mdblistDisc) {
    try { mdblistUser = localStorage.getItem('myListAddon:mdblistUsername') || ''; } catch (e) {}
  }

  const traktKeyEl = document.getElementById('traktKeyInput');
  let traktKey = traktKeyEl ? traktKeyEl.value.trim() : '';
  if (!traktKey && !traktDisc) {
    try { traktKey = localStorage.getItem('myListAddon:traktKey') || ''; } catch (e) {}
  }
  const traktUserEl = document.getElementById('traktUsernameInput');
  let traktUser = traktUserEl ? traktUserEl.value.trim() : '';
  if (!traktUser && !traktDisc) {
    try { traktUser = localStorage.getItem('myListAddon:traktUsername') || ''; } catch (e) {}
  }
  let traktToken = (typeof traktAccessToken !== 'undefined' && traktAccessToken) || '';
  if (!traktToken && !traktDisc) {
    try { traktToken = localStorage.getItem('myListAddon:traktAccessToken') || ''; } catch (e) {}
  }

  const simklKeyEl = document.getElementById('simklKeyInput');
  let simklKey = simklKeyEl ? simklKeyEl.value.trim() : '';
  if (!simklKey && !simklDisc) {
    try { simklKey = localStorage.getItem('myListAddon:simklKey') || ''; } catch (e) {}
  }
  let simklToken = (typeof simklAccessToken !== 'undefined' && simklAccessToken) || '';
  if (!simklToken && !simklDisc) {
    try { simklToken = localStorage.getItem('myListAddon:simklAccessToken') || ''; } catch (e) {}
  }
  let simklUser = (typeof simklUsername !== 'undefined' && simklUsername) || '';
  if (!simklUser && !simklDisc) {
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
    region: (function() {
      const el = document.getElementById('regionSelect');
      if (el && el.value) return el.value;
      try { return localStorage.getItem('myListAddon:region') || 'US'; } catch (e) { return 'US'; }
    })(),
    hideNonDigitalReleases: document.getElementById('hideNonDigitalReleasesCheckbox') ? document.getElementById('hideNonDigitalReleasesCheckbox').checked : false,
    adultContentFilter: typeof isAdultContentFilterEnabled === 'function' ? isAdultContentFilterEnabled() : (localStorage.getItem('myListAddon:adultContentFilter') === '1'),
    dedupeAcrossLists: document.getElementById('dedupeAcrossListsCheckbox') ? document.getElementById('dedupeAcrossListsCheckbox').checked : (localStorage.getItem('myListAddon:dedupeAcrossLists') === '1'),
    syncTraktHistory: localStorage.getItem('myListAddon:syncTraktHistory') === 'true',
    syncMdblistHistory: localStorage.getItem('myListAddon:syncMdblistHistory') === 'true',
    syncSimklHistory: localStorage.getItem('myListAddon:syncSimklHistory') === 'true',
    betterPosters: getBetterPostersSetting('betterPosters', false),
    betterPostersGenre: getBetterPostersSetting('betterPostersGenre', true),
    betterPostersRating: getBetterPostersSetting('betterPostersRating', true),
    betterPostersTrendTags: getBetterPostersSetting('betterPostersTrendTags', true),
    betterPostersQuality: getBetterPostersSetting('betterPostersQuality', false),
    betterPostersAge: getBetterPostersSetting('betterPostersAge', false),
    betterPostersLang: getBetterPostersChoice('betterPostersLang', 'en'),
    betterPostersRatingSource: getBetterPostersChoice('betterPostersRatingSource', 'avg'),
    showBadgesAiringNext: getBadgeSetting('showBadgesAiringNext'),
    showBadgesContinueWatching: getBadgeSetting('showBadgesContinueWatching'),
    showBadgesWatchlist: getBadgeSetting('showBadgesWatchlist'),
    showBadgesTraktContinueWatching: getBadgeSetting('showBadgesTraktContinueWatching'),
    showBadgesMdblistUpNext: getBadgeSetting('showBadgesMdblistUpNext'),
    showBadgesCatalogs: getBadgeSetting('showBadgesCatalogs'),
    showBadgesStremioAiringNext: getBadgeSetting('showBadgesStremioAiringNext'),
    showBadgesStremioContinueWatching: getBadgeSetting('showBadgesStremioContinueWatching'),
    showBadgesStremioWatchlist: getBadgeSetting('showBadgesStremioWatchlist'),
    showBadgesStremioCatalogs: getBadgeSetting('showBadgesStremioCatalogs'),
    showBadgesStremio: getBadgeSetting('showBadgesStremio'),
    showBadgeAirDate: getBadgeSetting('showBadgeAirDate'),
    showBadgeSeasonPremiere: getBadgeSetting('showBadgeSeasonPremiere'),
    showBadgeSeasonFinale: getBadgeSetting('showBadgeSeasonFinale'),
    showBadgeSeasonFinaleDate: getBadgeSetting('showBadgeSeasonFinaleDate'),
    showBadgeRating: getBadgeSetting('showBadgeRating'),
    showBadgeImdbRating: false,
    showBadgeTmdbRating: getBadgeSetting('showBadgeTmdbRating'),
    posterRatingSource: typeof getPosterRatingSource === 'function' ? getPosterRatingSource() : 'tmdb',
    showBadgeWatched: getBadgeSetting('showBadgeWatched'),
  };
  if (typeof activeCreator !== 'undefined' && activeCreator) {
    keys.creatorName = activeCreator.creatorName;
    if (track) keys.track = true;
    // The Creator Key travels with the config whenever the config actually
    // contains one of this account's personal shelves -- not only when
    // Auto-track Playback happens to be on.
    //
    // A Watch History / Continue Watching / Watchlist row is
    // 'autotrack:<slug>:<type>:<username>', and reading it server-side means
    // reading this account's private tracking record. /api/save now refuses to
    // store a config naming an account unless the request proves it owns it, so
    // without this a signed-in person with playback tracking switched off could
    // no longer generate an install link containing their own shelves.
    //
    // Deliberately conditional rather than unconditional: an install link is a
    // bearer credential (see README), and there is no reason to put an account
    // key in one that carries nothing belonging to that account.
    const hasPersonalShelf = [...document.querySelectorAll('#lists .entry .url')]
      .some((el) => String(el.value || '').trim().startsWith('autotrack:'));
    if (track || hasPersonalShelf) {
      keys.trackCreatorName = activeCreator.creatorName;
      keys.trackCreatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
    }
  }
  return keys;
}

function getBadgeSetting(key) {
  try {
    return localStorage.getItem('myListAddon:' + key) !== '0';
  } catch (e) {
    return true;
  }
}
window.getBadgeSetting = getBadgeSetting;

function getPosterRatingSource() {
  try {
    const s = localStorage.getItem('myListAddon:posterRatingSource');
    if (s === 'none') return 'none';
    if (s === 'tmdb') return 'tmdb';
    if (localStorage.getItem('myListAddon:showBadgeTmdbRating') === '0') return 'none';
    if (localStorage.getItem('myListAddon:showBadgeRating') === '0') return 'none';
    return 'tmdb';
  } catch (e) {
    return 'tmdb';
  }
}
window.getPosterRatingSource = getPosterRatingSource;

function toggleTmdbRatingSetting(isChecked) {
  try {
    localStorage.setItem('myListAddon:showBadgeTmdbRating', isChecked ? '1' : '0');
    localStorage.setItem('myListAddon:showBadgeRating', isChecked ? '1' : '0');
    localStorage.setItem('myListAddon:posterRatingSource', isChecked ? 'tmdb' : 'none');
    localStorage.setItem('myListAddon:showBadgeImdbRating', '0');
  } catch (e) {}
  if (window._discoverFeedsCache) window._discoverFeedsCache = {};
  applyBadgeBodyClasses();
  if (typeof scheduleCreatorSyncSave === 'function') scheduleCreatorSyncSave();
  if (typeof saveState === 'function') saveState();
  if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard({ silent: true });
  if (typeof renderLivePreview === 'function') renderLivePreview();
  if (typeof applySearchFilters === 'function') applySearchFilters();
  if (typeof render5PosterListsFeed === 'function') {
    const activeDiscoverSub = localStorage.getItem('myListAddon:discoverSubmenu') || 'all';
    if (typeof renderDiscoverChartsList === 'function') renderDiscoverChartsList(activeDiscoverSub, true);
  }
}
window.toggleTmdbRatingSetting = toggleTmdbRatingSetting;

function setPosterRatingSource(source) {
  const enabled = (source === 'tmdb' || source === true);
  toggleTmdbRatingSetting(enabled);
}
window.setPosterRatingSource = setPosterRatingSource;

function applyBadgeBodyClasses() {
  const b = document.body;
  if (!b) return;
  // Badge settings just changed, so the memoized copy the poster renderer
  // holds is stale -- see getPosterBadgeSettings.
  if (typeof invalidatePosterRenderCaches === 'function') invalidatePosterRenderCaches();
  b.classList.toggle('hide-airing-next-badges', !getBadgeSetting('showBadgesAiringNext'));
  b.classList.toggle('hide-continue-watching-badges', !getBadgeSetting('showBadgesContinueWatching'));
  b.classList.toggle('hide-watchlist-badges', !getBadgeSetting('showBadgesWatchlist'));
  b.classList.toggle('hide-trakt-continue-watching-badges', !getBadgeSetting('showBadgesTraktContinueWatching'));
  b.classList.toggle('hide-mdblist-up-next-badges', !getBadgeSetting('showBadgesMdblistUpNext'));
  b.classList.toggle('hide-catalogs-badges', !getBadgeSetting('showBadgesCatalogs'));
  b.classList.toggle('hide-badge-air-date', !getBadgeSetting('showBadgeAirDate'));
  b.classList.toggle('hide-badge-season-premiere', !getBadgeSetting('showBadgeSeasonPremiere'));
  b.classList.toggle('hide-badge-season-finale', !getBadgeSetting('showBadgeSeasonFinale'));
  b.classList.toggle('hide-badge-season-finale-date', !getBadgeSetting('showBadgeSeasonFinaleDate'));
  const ratingSource = getPosterRatingSource();
  const showTmdb = ratingSource === 'tmdb' && getBadgeSetting('showBadgeRating') && getBadgeSetting('showBadgeTmdbRating');
  b.classList.toggle('hide-badge-rating', !showTmdb);
  b.classList.toggle('hide-badge-imdb-rating', true);
  b.classList.toggle('hide-badge-tmdb-rating', !showTmdb);
  b.classList.toggle('hide-badge-watched', !getBadgeSetting('showBadgeWatched'));
}
window.applyBadgeBodyClasses = applyBadgeBodyClasses;

function toggleBadgeSetting(key, isChecked) {
  try {
    localStorage.setItem('myListAddon:' + key, isChecked ? '1' : '0');
  } catch (e) {}
  applyBadgeBodyClasses();
  if (typeof scheduleCreatorSyncSave === 'function') scheduleCreatorSyncSave();
  if (typeof saveState === 'function') saveState();
  if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard({ silent: true });
  if (typeof renderLivePreview === 'function') renderLivePreview();
}
window.toggleBadgeSetting = toggleBadgeSetting;

// --- Better Posters (btttr.cc) ---------------------------------------------
//
// Deliberately NOT getBadgeSetting: that one treats "absent" as on, which is
// right for badges (they predate the stored setting) and wrong here -- the
// master switch has to stay off until someone asks for it. So each key
// carries its own default instead.
function getBetterPostersSetting(key, defaultOn) {
  try {
    const v = localStorage.getItem('myListAddon:' + key);
    if (v === null) return !!defaultOn;
    return v === '1';
  } catch (e) {
    return !!defaultOn;
  }
}
window.getBetterPostersSetting = getBetterPostersSetting;

function getBetterPostersChoice(key, fallback) {
  try {
    return localStorage.getItem('myListAddon:' + key) || fallback;
  } catch (e) {
    return fallback;
  }
}
window.getBetterPostersChoice = getBetterPostersChoice;

// One handler for both the checkboxes and the two dropdowns -- a boolean is
// stored as 1/0, a dropdown value as itself.
function toggleBetterPostersSetting(key, value) {
  try {
    localStorage.setItem('myListAddon:' + key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
  } catch (e) {}
  if (key === 'betterPosters') applyBetterPostersOptionsVisibility();
  refreshBetterPostersSurfaces();
  if (typeof scheduleCreatorSyncSave === 'function') scheduleCreatorSyncSave();
  if (typeof saveState === 'function') saveState();
}
window.toggleBetterPostersSetting = toggleBetterPostersSetting;

// No refetch needed. Every website surface resolves its poster at render time
// through resolveClientPoster (19), and nothing writes the resolved URL back
// onto the item, so the original poster is always still there to fall back to
// when the setting goes off again -- re-rendering is the whole job. Surfaces
// not currently on screen pick the change up when they next render, the same
// way the badge settings behave.
function refreshBetterPostersSurfaces() {
  if (typeof invalidatePosterRenderCaches === 'function') invalidatePosterRenderCaches();
  // Tiles already patched carry a done-marker; clear it so they are
  // reconsidered under the new setting.
  try {
    document.querySelectorAll('[data-better-poster-done]').forEach((el) => { delete el.dataset.betterPosterDone; });
  } catch (e) {}
  if (typeof applyBetterPostersToTmdbTiles === 'function') applyBetterPostersToTmdbTiles(document);
  if (typeof renderLivePreview === 'function') renderLivePreview();
  if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard({ silent: true });
}
window.refreshBetterPostersSurfaces = refreshBetterPostersSurfaces;

// The style controls are meaningless while the master switch is off, so they
// collapse rather than sitting there inert.
function applyBetterPostersOptionsVisibility() {
  const wrap = document.getElementById('betterPostersOptions');
  if (!wrap) return;
  wrap.style.display = getBetterPostersSetting('betterPosters', false) ? 'flex' : 'none';
}
window.applyBetterPostersOptionsVisibility = applyBetterPostersOptionsVisibility;

const BETTER_POSTERS_TOGGLES = [
  { key: 'betterPosters', id: 'betterPostersCheckbox', on: false },
  { key: 'betterPostersGenre', id: 'betterPostersGenreCheckbox', on: true },
  { key: 'betterPostersRating', id: 'betterPostersRatingCheckbox', on: true },
  { key: 'betterPostersTrendTags', id: 'betterPostersTrendTagsCheckbox', on: true },
  { key: 'betterPostersQuality', id: 'betterPostersQualityCheckbox', on: false },
  { key: 'betterPostersAge', id: 'betterPostersAgeCheckbox', on: false },
];

function initBetterPostersSettingsUI() {
  BETTER_POSTERS_TOGGLES.forEach(({ key, id, on }) => {
    const el = document.getElementById(id);
    if (el) el.checked = getBetterPostersSetting(key, on);
  });
  const langEl = document.getElementById('betterPostersLangSelect');
  if (langEl) langEl.value = getBetterPostersChoice('betterPostersLang', 'en');
  const rsEl = document.getElementById('betterPostersRatingSourceSelect');
  if (rsEl) rsEl.value = getBetterPostersChoice('betterPostersRatingSource', 'avg');
  applyBetterPostersOptionsVisibility();
}
window.initBetterPostersSettingsUI = initBetterPostersSettingsUI;

function initBadgeSettingsUI() {
  const badgeKeys = [
    { key: 'showBadgesAiringNext', id: 'badgeAiringNextCheckbox' },
    { key: 'showBadgesContinueWatching', id: 'badgeContinueWatchingCheckbox' },
    { key: 'showBadgesWatchlist', id: 'badgeWatchlistCheckbox' },
    { key: 'showBadgesTraktContinueWatching', id: 'badgeTraktContinueWatchingCheckbox' },
    { key: 'showBadgesMdblistUpNext', id: 'badgeMdblistUpNextCheckbox' },
    { key: 'showBadgesCatalogs', id: 'badgeCatalogsCheckbox' },
    { key: 'showBadgesStremioAiringNext', id: 'badgeStremioAiringNextCheckbox' },
    { key: 'showBadgesStremioContinueWatching', id: 'badgeStremioContinueWatchingCheckbox' },
    { key: 'showBadgesStremioWatchlist', id: 'badgeStremioWatchlistCheckbox' },
    { key: 'showBadgesStremioCatalogs', id: 'badgeStremioCatalogsCheckbox' },
    { key: 'showBadgesStremio', id: 'badgeStremioCheckbox' },
    { key: 'showBadgeAirDate', id: 'badgeAirDateCheckbox' },
    { key: 'showBadgeSeasonPremiere', id: 'badgeSeasonPremiereCheckbox' },
    { key: 'showBadgeSeasonFinale', id: 'badgeSeasonFinaleCheckbox' },
    { key: 'showBadgeSeasonFinaleDate', id: 'badgeSeasonFinaleDateCheckbox' },
    { key: 'showBadgeRating', id: 'badgeRatingCheckbox' },
    { key: 'showBadgeImdbRating', id: 'badgeImdbRatingCheckbox' },
    { key: 'showBadgeTmdbRating', id: 'badgeTmdbRatingCheckbox' },
    { key: 'showBadgeWatched', id: 'badgeWatchedCheckbox' },
  ];
  badgeKeys.forEach(({ key, id }) => {
    const el = document.getElementById(id);
    if (el) {
      el.checked = getBadgeSetting(key);
    }
  });
  const currentRatingSource = getPosterRatingSource();
  const tmdbEl = document.getElementById('badgeTmdbRatingCheckbox');
  if (tmdbEl) {
    tmdbEl.checked = (currentRatingSource === 'tmdb');
  }
  const rNone = document.getElementById('posterRatingNoneRadio');
  const rImdb = document.getElementById('posterRatingImdbRadio');
  const rTmdb = document.getElementById('posterRatingTmdbRadio');
  if (rNone) rNone.checked = (currentRatingSource === 'none');
  if (rImdb) rImdb.checked = false;
  if (rTmdb) rTmdb.checked = (currentRatingSource === 'tmdb');

  const compEl = document.getElementById('autoRecommendCompanionsCheckbox');
  if (compEl && typeof getCompanionRecommendationSetting === 'function') {
    compEl.checked = getCompanionRecommendationSetting();
  }
  applyBadgeBodyClasses();
}
window.initBadgeSettingsUI = initBadgeSettingsUI;
document.addEventListener('DOMContentLoaded', () => {
  initBadgeSettingsUI();
  initBetterPostersSettingsUI();
});

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


// Normalises a show id down to its show-level key. Plain \`id.split(':')[0]\`
// collapses every \`tmdb:\`-prefixed show to the literal string "tmdb", so a
// second (and third, and fourth...) tmdb-identified show reads as a
// duplicate of the first one wherever this key is used to dedupe a merge or
// index a lookup map -- the same normalisation bug documented as
// DB-002/BE-002 and already fixed server-side via trackingShowKey
// (02_http-and-creator-utils.js). This is that same fix, reimplemented
// locally since this file runs in the browser, not the Worker.
function _liveMergeBaseId(raw) {
  const s = String(raw || '').toLowerCase();
  if (!s) return '';
  if (s.startsWith('tmdb:')) {
    const parts = s.split(':');
    return parts.length >= 2 ? parts[0] + ':' + parts[1] : s;
  }
  return s.split(':')[0];
}
function _liveMergeShowKey(item) {
  return _liveMergeBaseId(item && (item.showId || item.id));
}

// Normalises a fallback/cached item (My Lists' own Continue Watching or
// Airing Next data) into the same meta shape the live /api/preview sample
// uses, for the shelves below that fall back to it.
function _liveFallbackMeta(it, defaultType) {
  return {
    id: it.id,
    showId: it.showId || it.id,
    type: it.type || defaultType || (it.episodeTitle ? 'series' : 'series'),
    name: it.name || it.title,
    // Resolved the same way the Lists tab resolves it. Reading it.poster
    // alone left every Airing Next tile as "No poster": those items carry no
    // poster of their own, and My Lists only ever showed one because
    // resolveListCardItemPoster falls back to showPoster and then to a
    // metahub poster built from the show's IMDb id. Live Preview had no such
    // fallback, so the two surfaces disagreed about the same item -- and
    // turning Better Posters on masked it, since that builds a URL from the
    // id and never needs a poster field at all.
    poster: (typeof resolveListCardItemPoster === 'function')
      ? resolveListCardItemPoster(it)
      : (it.poster || it.showPoster || ''),
    year: it.year || it.releaseInfo,
    showTitle: it.showTitle || it.name || it.title,
    seasonNum: it.seasonNum != null ? it.seasonNum : it.season,
    episodeNum: it.episodeNum != null ? it.episodeNum : it.episode,
    airDate: it.airDate,
    airTime: it.airTime,
    isUnaired: it.isUnaired,
    isSeasonPremiere: it.isSeasonPremiere,
    isSeasonFinale: it.isSeasonFinale,
    imdbRating: it.imdbRating,
    rating: it.rating,
    vote_average: it.vote_average,
  };
}

async function renderLivePreview() {
  const container = document.getElementById('lists');
  if (!container) return;
  
  const entries = [...container.querySelectorAll('.entry')];
  const allShelves = collectEntries();
  const shelves = allShelves.filter((e) => e.enabled);
  livePreviewShelfData = shelves.map(() => null);
  
  if (!shelves.length) {
    return;
  }
  
  const keys = collectKeys();
  const CONCURRENCY = 4;
  let nextIdx = 0;
  
  const enabledEntries = entries.filter((_, i) => allShelves[i].enabled);

  // Determine how many posters we visibly show per shelf
  const visibleCount = (window.innerWidth < 600) ? 3 : (window.innerWidth < 1000) ? 6 : 9;
  const skeletonCardHtml = '<div class="live-preview-skeleton-card">' +
    '<div class="live-preview-skeleton-poster"></div>' +
    '<div class="live-preview-skeleton-line"></div>' +
    '<div class="live-preview-skeleton-line-sub"></div>' +
    '</div>';
  const skeletonsHtml = Array(visibleCount).fill(skeletonCardHtml).join('');

  // Pre-render shimmer skeletons and set status spinner on all enabled shelves
  // (but don't wipe out existing posters if this is just a background refresh)
  enabledEntries.forEach((entryDOM) => {
    const postersContainer = entryDOM.querySelector('.live-preview-posters');
    if (postersContainer) {
      if (!postersContainer.innerHTML.trim() || postersContainer.innerHTML.includes('live-preview-skeleton-card')) {
        postersContainer.innerHTML = skeletonsHtml;
      }
    }
    const statusEl = entryDOM.querySelector('.live-preview-shelf-status');
    if (statusEl) statusEl.innerHTML = '<span class="status-spin">&#x21BB;</span> <span>Loading&hellip;</span>';
  });
  
  async function worker() {
    while (true) {
      const i = nextIdx++;
      if (i >= shelves.length) return;
      const s = shelves[i];
      const entryDOM = enabledEntries[i];
      if (!entryDOM) continue;
      
      const postersContainer = entryDOM.querySelector('.live-preview-posters');
      const statusEl = entryDOM.querySelector('.live-preview-shelf-status');
      if (!postersContainer) continue;
      
      const sUrl = (s.url || '').toLowerCase();
      const sName = (s.name || '').toLowerCase();
      const isCwShelf = sUrl.includes('continue-watching') || sUrl.includes('continue_watching') || sName.includes('continue watching');
      const isAiringShelf = sUrl.includes('airing-next') || sUrl.includes('airing_next') || sName.includes('airing next');
      // Checked after the other two so a shelf whose name mentions both
      // keeps the more specific meaning, the same precedence
      // livePreviewPosterHtml uses for an individual tile.
      const isWatchlistShelf = !isCwShelf && !isAiringShelf && (sUrl.includes('watchlist') || sName.includes('watchlist'));
      // A personal/auto-tracked shelf (Continue Watching, Watchlist, Watch
      // History, Airing Next -- this add-on's own or a connected Trakt/
      // MDBList/Simkl account's) is legitimately empty a lot of the time --
      // nothing in progress, nothing upcoming -- and that is not a
      // misconfiguration worth a "No items found." block sitting in the
      // editor. A row for any other list being empty usually does mean
      // something is wrong (a bad URL, a list that got deleted upstream),
      // so only these get hidden rather than shown empty; the row's config
      // is untouched, so the moment the account has something in it again,
      // the same row picks it back up as it normally would.
      const isPersonalTrackedShelf = isPersonalShelfUrlClient(s.url);

      if (s.name && s.name.toLowerCase().includes('watch history')) {
        postersContainer.classList.add('is-watch-history-shelf');
      } else {
        postersContainer.classList.remove('is-watch-history-shelf');
      }
      postersContainer.classList.toggle('is-continue-watching-shelf', isCwShelf);
      postersContainer.classList.toggle('is-airing-next-shelf', isAiringShelf);
      postersContainer.classList.toggle('is-watchlist-shelf', isWatchlistShelf);
      if (isCwShelf) entryDOM.dataset.listSlug = 'continue-watching';
      if (isAiringShelf) entryDOM.dataset.listSlug = 'airing-next';
      if (isWatchlistShelf) entryDOM.dataset.listSlug = 'watchlist';
      
      const seeAllBtn = entryDOM.querySelector('.live-preview-shelf-title button');
      if (seeAllBtn) {
        seeAllBtn.onclick = (e) => {
          e.stopPropagation();
          openLivePreviewSeeAll(i);
        };
      }
      
      // The sample to show INSTEAD of what /api/preview returned, for the two
      // shelves that have a locally-known copy.
      //
      // It has to come from the account that actually backs THIS shelf. It
      // used to try Trakt first for any Continue Watching / Airing Next row
      // whatever its URL, so a row tracked by this add-on
      // (autotrack:continue-watching:...) was shown the connected TRAKT
      // account's shelf instead of its own. Two different accounts, two
      // different sets of shows -- which is why the Lists tab and Live Preview
      // could disagree about the same row, and why syncing the add-on's own
      // shelf to the account changed nothing: this path never read it.
      function traktShelfSample(stillUpcoming) {
        if (isCwShelf) {
          const lists = window._myPrivateTraktLists || window._myTraktLists || [];
          const cwList = lists.find((l) => l && (l.statusKey === 'continue-watching' || l.slug === 'continue-watching' || (l.url && (l.url === 'trakt:continue-watching' || l.url.includes(':continue-watching')))));
          if (cwList && Array.isArray(cwList.items) && cwList.items.length) {
            let items = cwList.items;
            if (s.type === 'movie') {
              items = items.filter(it => it && (it.type === 'movie' || it.kind === 'movie'));
            } else if (s.type === 'series') {
              items = items.filter(it => it && (it.type === 'series' || it.kind === 'series' || it.episodeTitle || it.seasonNum != null));
            }
            return items.length ? items : null;
          }
        } else if (isAiringShelf) {
          // Only items with a confirmed, still-upcoming air date belong on this
          // shelf -- the same filter openTraktAiringNextDetailsPage already
          // applies (17_client-my-lists-and-trakt-oauth.js). Without it, raw
          // candidate shows that were never confirmed to have an upcoming
          // episode (or whose episode has since aired) get merged in as if
          // they were real Airing Next entries, inflating the shelf beyond
          // what Trakt actually has scheduled.
          let cachedAiring = null;
          try {
            cachedAiring = JSON.parse(localStorage.getItem('myListAddon:traktAiringNextCache') || 'null');
          } catch (e) {}
          if (Array.isArray(cachedAiring) && cachedAiring.length) {
            const filtered = stillUpcoming(cachedAiring);
            if (filtered.length) return filtered;
          }
          const lists = window._myPrivateTraktLists || window._myTraktLists || [];
          const aList = lists.find((l) => l && (l.statusKey === 'airing-next' || l.slug === 'airing-next' || (l.url && (l.url === 'trakt:airing-next' || l.url.includes(':airing-next')))));
          if (aList && Array.isArray(aList.items) && aList.items.length) {
            const filtered = stillUpcoming(aList.items);
            if (filtered.length) return filtered;
          }
        }
        return null;
      }

      // This add-on's own auto-tracked shelf -- the exact list the Lists tab
      // renders, and the only copy guaranteed current on this device.
      function addonShelfSample(stillUpcoming) {
        const localSlug = isCwShelf ? 'continue-watching' : (isAiringShelf ? 'airing-next' : '');
        if (!localSlug || typeof loadLocalCustomLists !== 'function') return null;
        const localList = loadLocalCustomLists()[localSlug];
        let items = (localList && Array.isArray(localList.items)) ? localList.items : [];
        if (!items.length) return null;
        if (isAiringShelf) {
          items = stillUpcoming(items);
        } else if (s.type === 'movie') {
          items = items.filter((it) => it && (it.type === 'movie' || it.kind === 'movie'));
        } else if (s.type === 'series') {
          items = items.filter((it) => it && (it.type === 'series' || it.kind === 'series' || it.episodeTitle || it.seasonNum != null || it.episodeNum != null || it.season != null));
        }
        return items.length ? items : null;
      }

      function getFallbackShelfSample() {
        const stillUpcoming = (arr) => arr.filter((it) => it && it.airDate && (typeof isEpisodeAired !== 'function' || !isEpisodeAired(it.airDate)));
        // An "autotrack:" row is this add-on's own shelf, so its own list is
        // the only right answer -- never a connected Trakt account's.
        if ((s.url || '').toLowerCase().indexOf('autotrack:') !== -1) {
          return addonShelfSample(stillUpcoming);
        }
        // Everything else keeps the behaviour it had: Trakt's copy where there
        // is one, and the add-on's own list only as a last resort.
        return traktShelfSample(stillUpcoming) || addonShelfSample(stillUpcoming);
      }
      
      try {
        const body = { url: s.url, type: s.type, sample: 100 };
        if (keys.tmdbKey) body.tmdbKey = keys.tmdbKey;
        if (keys.mdblistKey) body.mdblistKey = keys.mdblistKey;
        if (keys.mdblistAccessToken) body.mdblistAccessToken = keys.mdblistAccessToken;
        if (keys.traktKey) body.traktKey = keys.traktKey;
        if (keys.traktAccessToken) body.traktAccessToken = keys.traktAccessToken;
        if (keys.simklKey) body.simklKey = keys.simklKey;
        if (keys.simklAccessToken) body.simklAccessToken = keys.simklAccessToken;
        if (keys.creatorName) body.creatorName = keys.creatorName;
        const previewKey = previewCreatorKey(s.url);
        if (previewKey) body.creatorKey = previewKey;
        if (keys.hideNonDigitalReleases) body.hideNonDigitalReleases = true;
        if (keys.adultContentFilter) body.adultContentFilter = true;
        const res = await fetch(ORIGIN + '/api/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          cache: 'no-store',
        });
        const data = await res.json();
        if (statusEl) statusEl.innerHTML = '';
        if (!data.ok) {
          const fallback = getFallbackShelfSample();
          if (fallback && fallback.length) {
            data.ok = true;
            data.sample = fallback.map(it => _liveFallbackMeta(it, s.type === 'movie' ? 'movie' : 'series'));
            data.totalItems = fallback.length;
          }
        }
        if (data.ok && Array.isArray(data.sample)) {
          if (isCwShelf) {
            if (s.type === 'movie') {
              // Ensure movie shelf only contains movie items, never TV shows
              data.sample = data.sample.filter(it => it && (it.type === 'movie' || it.kind === 'movie') && !it.seasonNum && !it.episodeNum && !it.episodeTitle);
            } else if (s.type === 'series') {
              // Prefer the "My Lists" sample over the live /api/preview sample
              // when one is available, rather than unioning the two. The two
              // used to get merged: every item the live fetch returned, plus
              // any item from "My Lists" not already present. That could
              // pull in a show the live fetch has that "My Lists" does not
              // (or the reverse), so this shelf's count and "My Lists"'s
              // count for what is supposed to be the same list could
              // disagree -- confusing when they're shown side by side. It
              // also meant inconsistent rating badges: fetchTraktContinueWatching's
              // live sample never carries a rating (its own dashboard fetch
              // path is the only place these items get enriched with one),
              // so a tile's rating badge depended on which of the two
              // sources happened to supply that particular item. Falling
              // through to the live sample only when "My Lists" has not
              // loaded yet this session preserves the original purpose of
              // the merge (covering a live fetch truncated by Workers'
              // subrequest cap) without either inconsistency.
              const fallback = getFallbackShelfSample();
              if (fallback && Array.isArray(fallback) && fallback.length) {
                data.sample = fallback.map(item => _liveFallbackMeta(item, 'series'));
                data.totalItems = data.sample.length;
              }
            }
          } else if (isAiringShelf) {
            // Same reasoning as the Continue Watching series shelf above --
            // see its comment.
            const fallback = getFallbackShelfSample();
            if (fallback && Array.isArray(fallback) && fallback.length) {
              const sample = fallback.map(item => _liveFallbackMeta(item, 'series'));
              sample.sort((a, b) => (a.airDate || '9999').localeCompare(b.airDate || '9999'));
              data.sample = sample;
              data.totalItems = sample.length;
            }
          }
        }
        if (!data.ok) {
          entryDOM.style.display = '';
          postersContainer.innerHTML = '<p class="testresult err">&#x2717; ' + escapeHtml(data.error || 'Could not load this catalog.') + '</p>';
          continue;
        }
        if (!data.sample || !data.sample.length) {
          if (isPersonalTrackedShelf) {
            entryDOM.style.display = 'none';
          } else {
            entryDOM.style.display = '';
            postersContainer.innerHTML = '<p><small>No items found.</small></p>';
          }
          continue;
        }
        entryDOM.style.display = '';
        livePreviewShelfData[i] = { name: s.name, type: s.type, url: s.url, sample: data.sample, maybeMore: data.maybeMore, totalItems: data.totalItems };
        const sliced = data.sample.slice(0, visibleCount);
        sliced.forEach(item => { item.listUrl = s.url; item.listName = s.name; item.isLivePreviewShelf = true; });
        postersContainer.innerHTML = sliced.map(livePreviewPosterHtml).join('');
        if (seeAllBtn && data.sample.length > visibleCount) seeAllBtn.disabled = false;
      } catch (e) {
        if (statusEl) statusEl.innerHTML = '';
        const fallback = getFallbackShelfSample();
        if (fallback && fallback.length) {
          entryDOM.style.display = '';
          const sample = fallback.map(it => _liveFallbackMeta(it, s.type === 'movie' ? 'movie' : 'series'));
          livePreviewShelfData[i] = { name: s.name, type: s.type, url: s.url, sample, maybeMore: false, totalItems: sample.length };
          const sliced = sample.slice(0, visibleCount);
          sliced.forEach(item => { item.listUrl = s.url; item.listName = s.name; item.isLivePreviewShelf = true; });
          postersContainer.innerHTML = sliced.map(livePreviewPosterHtml).join('');
          if (seeAllBtn && sample.length > visibleCount) seeAllBtn.disabled = false;
        } else {
          entryDOM.style.display = '';
          postersContainer.innerHTML = '<p class="testresult err">&#x2717; Network error loading this catalog.</p>';
        }
      }
    }
  }

  const workers = Array(Math.min(CONCURRENCY, shelves.length)).fill(0).map(worker);
  await Promise.all(workers);

  // "Remove duplicate items across lists" (Settings -> dedupeAcrossListsCheckbox).
  // Runs once every shelf above has actually resolved, not per-shelf as each
  // one finishes -- the whole point is comparing a later shelf against
  // earlier ones, which only means something once "earlier" has a final
  // answer. Mirrors dedupeAcrossListEntries (05_catalog-core.js) exactly:
  // the config's first list of a type is untouched, everything after it
  // (in this same top-to-bottom order) loses whatever id an earlier
  // same-type shelf already has, so what's shown here matches what the
  // real Stremio/Nuvio catalogs will once this config is saved.
  let dedupeAcrossLists = false;
  try { dedupeAcrossLists = localStorage.getItem('myListAddon:dedupeAcrossLists') === '1'; } catch (e) {}
  if (dedupeAcrossLists) {
    const seenByType = {};
    livePreviewShelfData.forEach((shelf, i) => {
      if (!shelf || !Array.isArray(shelf.sample) || !shelf.sample.length) return;
      // Same exclusion the Worker applies in dedupeAcrossListEntries
      // (05_catalog-core.js): a personal shelf is neither stripped nor a
      // source of strips. Preview has to agree with what gets served, or the
      // editor shows a shelf the install does not.
      if (isPersonalShelfUrlClient(shelf.url)) return;
      const seen = seenByType[shelf.type] || (seenByType[shelf.type] = new Set());
      const before = shelf.sample.length;
      shelf.sample = shelf.sample.filter((item) => item && item.id && !seen.has(item.id));
      shelf.sample.forEach((item) => seen.add(item.id));
      const removed = before - shelf.sample.length;
      if (!removed) return;
      if (typeof shelf.totalItems === 'number') {
        shelf.totalItems = Math.max(shelf.sample.length, shelf.totalItems - removed);
      }
      const entryDOM = enabledEntries[i];
      const postersContainer = entryDOM && entryDOM.querySelector('.live-preview-posters');
      const seeAllBtn = entryDOM && entryDOM.querySelector('.live-preview-shelf-title button');
      if (!postersContainer) return;
      if (!shelf.sample.length) {
        postersContainer.innerHTML = '<p><small>No items left after removing duplicates of an earlier list.</small></p>';
        if (seeAllBtn) seeAllBtn.disabled = true;
        return;
      }
      const sliced = shelf.sample.slice(0, visibleCount);
      sliced.forEach((item) => { item.listUrl = shelf.url; item.listName = shelf.name; item.isLivePreviewShelf = true; });
      postersContainer.innerHTML = sliced.map(livePreviewPosterHtml).join('');
      if (seeAllBtn) seeAllBtn.disabled = !(shelf.sample.length > visibleCount);
    });
  }
}

// Hides a poster that could not be loaded and shows a "No poster" tile in
// its place.
//
// Two different markups reach here, and this used to assume only one of
// them. livePreviewPosterHtml (below) emits a hidden placeholder as the
// img's immediate next sibling, so revealing img.nextElementSibling was
// right there. Every other call site emits no placeholder at all:
// renderCatalogSearchResults (19_client-search-and-likes.js) follows the
// img with .poster-add-overlay, the list-card mini tiles
// (22_client-creator-profile.js) follow it with .cw-remove-btn and
// .list-card-count-overlay, and the replacement <img> that
// resolveMissingPostersInDom (16_client-row-core.js) swaps in has no
// sibling whatsoever.
//
// At those sites the old code hid the poster and then set display:flex on
// whatever happened to sit next to it, so no "No poster" tile ever
// appeared -- just an empty gap -- and on the count badge, which is shown
// and hidden per breakpoint by a media query, an inline display:flex
// overrode that query and put the badge on screen at both widths at once.
//
// So: reveal a real placeholder when one exists, create one when it does
// not, and never touch a sibling that is not a placeholder.
function showPosterPlaceholderFor(img) {
  if (!img) return;
  img.style.display = 'none';
  const parent = img.parentElement;
  if (!parent) return;
  let ph = null;
  const sib = img.nextElementSibling;
  if (sib && sib.classList && sib.classList.contains('live-preview-poster-placeholder')) {
    ph = sib;
  } else {
    ph = parent.querySelector(':scope > .live-preview-poster-placeholder');
  }
  if (!ph) {
    ph = document.createElement('div');
    ph.className = 'live-preview-poster live-preview-poster-placeholder';
    ph.innerHTML = '<small style="color:var(--muted); font-size:0.7rem;">No poster</small>';
    parent.appendChild(ph);
  }
  ph.style.display = 'flex';
}

function handlePosterImgError(img) {
  if (!img) return;
  if (img.dataset.hasFailedFallback) {
    showPosterPlaceholderFor(img);
    return;
  }
  img.dataset.hasFailedFallback = '1';

  const card = img.closest('.live-preview-poster-card') || img.closest('.list-card') || img.closest('[data-title]');
  let title = (card && (card.dataset.title || card.dataset.name)) || '';
  const type = (card && (card.dataset.type || card.dataset.listType)) || 'movie';
  const id = (card && (card.dataset.id || card.dataset.imdbId)) || '';

  // Clean episode indicators from show title for fallback lookup, e.g. "Ted Lasso S03E01" -> "Ted Lasso"
  const cleanTitle = title.replace(/\s+S\d+E\d+.*$/i, '').trim();

  const tmdbId = id.startsWith('tmdb:') ? id.slice(5).split(':')[0] : (/^\d+/.test(id) ? id.split(':')[0] : '');
  const imdbId = id.startsWith('tt') ? id.split(':')[0] : '';

  if (cleanTitle || tmdbId || imdbId) {
    fetch(ORIGIN + '/api/poster-fallback?title=' + encodeURIComponent(cleanTitle || title) + '&type=' + encodeURIComponent(type) + (tmdbId ? '&tmdbId=' + encodeURIComponent(tmdbId) : '') + (imdbId ? '&imdbId=' + encodeURIComponent(imdbId) : ''))
      .then(r => r.json())
      .then(data => {
        if (data && data.ok && data.poster) {
          img.src = data.poster;
          img.style.display = '';
        } else {
          showPosterPlaceholderFor(img);
        }
      })
      .catch(() => {
        showPosterPlaceholderFor(img);
      });
  } else {
    showPosterPlaceholderFor(img);
  }
}

// --- Poster-render caches ----------------------------------------------------
// livePreviewPosterHtml below is called once per card, and a Watch History
// grid can be several thousand cards. Two things in it were priced as if it
// ran a handful of times: four separate localStorage reads for badge
// settings (so ~4,000 synchronous reads for a 1,000-item grid), and, for
// every Continue Watching or Airing Next card, a fresh loadLocalCustomLists()
// plus a linear scan of the whole airing-next list -- O(cards x airing
// entries) on the main thread before a single pixel is painted.
//
// Both inputs are the same for every card in a render pass, so they are
// computed once and reused. The TTL is short enough to be invisible to a
// person toggling a setting (the settings UI re-renders well after it
// lapses) and long enough to cover any single pass; invalidatePosterRender-
// Caches is also called outright wherever badge settings change, so the TTL
// is a backstop rather than the mechanism.
var _posterBadgeCache = null;
var _posterBadgeCacheAt = 0;
var _airingIndexCache = null;
var _airingIndexCacheAt = 0;
var POSTER_RENDER_CACHE_MS = 250;

function invalidatePosterRenderCaches() {
  _posterBadgeCache = null;
  _posterBadgeCacheAt = 0;
  _airingIndexCache = null;
  _airingIndexCacheAt = 0;
}
window.invalidatePosterRenderCaches = invalidatePosterRenderCaches;

function getPosterBadgeSettings() {
  var now = Date.now();
  if (_posterBadgeCache && (now - _posterBadgeCacheAt) < POSTER_RENDER_CACHE_MS) {
    return _posterBadgeCache;
  }
  var get = (typeof getBadgeSetting === 'function') ? getBadgeSetting : function() { return true; };
  _posterBadgeCache = {
    continueWatching: get('showBadgesContinueWatching'),
    watchlist: get('showBadgesWatchlist'),
    traktContinueWatching: get('showBadgesTraktContinueWatching'),
    mdblistUpNext: get('showBadgesMdblistUpNext'),
    airingNext: get('showBadgesAiringNext'),
    catalogs: get('showBadgesCatalogs'),
    airDate: get('showBadgeAirDate'),
    seasonPremiere: get('showBadgeSeasonPremiere'),
    seasonFinale: get('showBadgeSeasonFinale'),
    seasonFinaleDate: get('showBadgeSeasonFinaleDate'),
    rating: get('showBadgeRating'),
    imdbRating: get('showBadgeImdbRating'),
    tmdbRating: get('showBadgeTmdbRating'),
  };
  _posterBadgeCacheAt = now;
  return _posterBadgeCache;
}

// Index of the Airing Next list by every identity the old linear scan used
// to match on, so a lookup is a few Map hits instead of a walk of the whole
// list per card.
//
// The subtlety worth stating plainly: the old code was
// airingList.find(...), which walks the list IN ORDER and returns the first
// entry matching ANY of its predicates. So when two different entries would
// each match a card by different routes -- say entry 0 by title and entry 3
// by showId -- the old code returns entry 0, because position wins over
// which predicate fired. An index that simply checked showId before title
// would return entry 3 instead, which is a real behaviour change and not a
// theoretical one (it showed up immediately under randomised comparison
// against the original predicate).
//
// So each key stores the entry's POSITION as well, and a lookup gathers
// every candidate and keeps the earliest -- identical results to find(),
// without the walk. Keys are inserted first-wins so a duplicate identity
// within the list also resolves to its earliest occurrence.
function getAiringNextIndex() {
  var now = Date.now();
  if (_airingIndexCache && (now - _airingIndexCacheAt) < POSTER_RENDER_CACHE_MS) {
    return _airingIndexCache;
  }
  var byShowId = new Map();
  var byBaseId = new Map();
  var byTmdb = new Map();
  var byImdb = new Map();
  var byTitle = new Map();
  var list = [];
  try {
    list = (typeof loadLocalCustomLists === 'function')
      ? ((loadLocalCustomLists()['airing-next'] || {}).items || [])
      : [];
  } catch (e) {
    list = [];
  }
  function put(map, key, entry, i) {
    if (key && !map.has(key)) map.set(key, { entry: entry, i: i });
  }
  for (var i = 0; i < list.length; i++) {
    var a = list[i];
    if (!a) continue;
    put(byShowId, String(a.showId || ''), a, i);
    put(byBaseId, _liveMergeShowKey(a), a, i);
    if (a.canonicalTmdbId != null) put(byTmdb, 'c' + String(a.canonicalTmdbId), a, i);
    if (a.tmdbId != null) put(byTmdb, 't' + String(a.tmdbId), a, i);
    if (a.imdbId) put(byImdb, String(a.imdbId), a, i);
    put(byTitle, String(a.showTitle || a.title || a.name || '').toLowerCase().trim(), a, i);
  }
  var scheduleItems = [];
  try {
    if (window._airingNextScheduleMap && typeof window._airingNextScheduleMap === 'object') {
      scheduleItems = Object.values(window._airingNextScheduleMap);
    } else {
      var raw = localStorage.getItem('myListAddon:airingScheduleMap');
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') scheduleItems = Object.values(parsed);
      }
    }
  } catch (e) {}
  for (var j = 0; j < scheduleItems.length; j++) {
    var sa = scheduleItems[j];
    if (!sa) continue;
    put(byShowId, String(sa.showId || ''), sa, list.length + j);
    put(byBaseId, _liveMergeShowKey(sa), sa, list.length + j);
    if (sa.canonicalTmdbId != null) put(byTmdb, 'c' + String(sa.canonicalTmdbId), sa, list.length + j);
    if (sa.tmdbId != null) put(byTmdb, 't' + String(sa.tmdbId), sa, list.length + j);
    if (sa.imdbId) put(byImdb, String(sa.imdbId), sa, list.length + j);
    put(byTitle, String(sa.showTitle || sa.title || sa.name || '').toLowerCase().trim(), sa, list.length + j);
  }
  var providerAiringItems = [];
  try {
    const traktLists = window._myPrivateTraktLists || window._myTraktLists || [];
    const traktAiring = traktLists.find((l) => l && (l.statusKey === 'airing-next' || l.slug === 'airing-next' || (l.url && l.url.includes(':airing-next'))));
    if (traktAiring && Array.isArray(traktAiring.items)) providerAiringItems.push(...traktAiring.items);

    const mdbLists = window._myMdblistLists || [];
    const mdbAiring = mdbLists.find((l) => l && (l.statusKey === 'airing-next' || l.slug === 'airing-next' || (l.url && l.url.includes(':airing-next'))));
    if (mdbAiring && Array.isArray(mdbAiring.items)) providerAiringItems.push(...mdbAiring.items);

    const simklLists = window._mySimklLists || [];
    const simklAiring = simklLists.find((l) => l && (l.statusKey === 'airing-next' || (l.url && l.url.includes(':airing-next'))));
    if (simklAiring && Array.isArray(simklAiring.items)) providerAiringItems.push(...simklAiring.items);
  } catch (e) {}
  var baseOffset = list.length + scheduleItems.length;
  for (var k = 0; k < providerAiringItems.length; k++) {
    var pa = providerAiringItems[k];
    if (!pa) continue;
    put(byShowId, String(pa.showId || pa.id || ''), pa, baseOffset + k);
    put(byBaseId, _liveMergeShowKey(pa), pa, baseOffset + k);
    if (pa.canonicalTmdbId != null) put(byTmdb, 'c' + String(pa.canonicalTmdbId), pa, baseOffset + k);
    if (pa.tmdbId != null) put(byTmdb, 't' + String(pa.tmdbId), pa, baseOffset + k);
    if (pa.imdbId) put(byImdb, String(pa.imdbId), pa, baseOffset + k);
    put(byTitle, String(pa.showTitle || pa.title || pa.name || '').toLowerCase().trim(), pa, baseOffset + k);
  }
  _airingIndexCache = {
    empty: list.length === 0 && scheduleItems.length === 0 && providerAiringItems.length === 0,
    byShowId: byShowId,
    byBaseId: byBaseId,
    byTmdb: byTmdb,
    byImdb: byImdb,
    byTitle: byTitle,
  };
  _airingIndexCacheAt = now;
  return _airingIndexCache;
}

function findAiringMatchFor(m) {
  var idx = getAiringNextIndex();
  if (idx.empty) return null;
  var best = null;
  function consider(hit) {
    if (hit && (best === null || hit.i < best.i)) best = hit;
  }
  // Predicate 1: an entry's showId against any of this card's identities.
  if (m.id) consider(idx.byShowId.get(String(m.id)));
  if (m.removeShowId) consider(idx.byShowId.get(String(m.removeShowId)));
  if (m.showId) consider(idx.byShowId.get(String(m.showId)));
  if (m.imdbId) consider(idx.byShowId.get(String(m.imdbId)));
  // Predicate 2: base id (colon-normalised, tmdb-aware -- see _liveMergeBaseId) on both sides.
  var mBase = _liveMergeBaseId(m.showId || m.id || m.removeShowId);
  if (mBase) consider(idx.byBaseId.get(mBase));
  // Predicates 3-5: canonical TMDB id, TMDB id, IMDb id.
  if (m.canonicalTmdbId != null) consider(idx.byTmdb.get('c' + String(m.canonicalTmdbId)));
  if (m.tmdbId != null) consider(idx.byTmdb.get('t' + String(m.tmdbId)));
  if (m.imdbId) consider(idx.byImdb.get(String(m.imdbId)));
  // Predicate 6: normalised title.
  var mTitle = String(m.showTitle || m.title || m.name || '').toLowerCase().trim();
  if (mTitle) consider(idx.byTitle.get(mTitle));
  return best ? best.entry : null;
}

// --- Chunked poster-grid rendering -------------------------------------------
// Building an entire grid in one assignment is fine for a 40-item chart and
// punishing for a Watch History that has grown into the thousands: the map
// runs to completion, a multi-megabyte HTML string is assembled, and the
// browser then parses and lays out ~8 nodes and an <img> per card before
// anything at all appears. Every filter pill and sort change paid it again.
//
// This paints the first screenful synchronously -- so the grid is visible
// immediately regardless of list size -- then appends the rest in small
// batches between frames, keeping the main thread free for scrolling and
// taps in between. insertAdjacentHTML is used rather than rebuilding
// innerHTML so earlier batches are never re-parsed.
//
// Each call takes a generation token: starting a new render invalidates any
// batches still queued from the previous one, so rapidly toggling filters
// can never interleave two lists into the same grid.
var POSTER_GRID_FIRST_CHUNK = 60;
var POSTER_GRID_BATCH = 60;
var _posterGridGeneration = 0;

function renderPosterGridChunked(gridEl, items, onComplete) {
  if (!gridEl) return;
  var generation = ++_posterGridGeneration;
  gridEl.innerHTML = '';
  if (!items || !items.length) {
    if (typeof onComplete === 'function') onComplete(0);
    return;
  }

  var first = items.slice(0, POSTER_GRID_FIRST_CHUNK);
  gridEl.insertAdjacentHTML('beforeend', first.map(livePreviewPosterHtml).join(''));
  // A TMDB-id-only item cannot get a BetterPosters URL at render time, so
  // the ids for what just landed on screen are translated and patched in.
  if (typeof applyBetterPostersToTmdbTiles === 'function') applyBetterPostersToTmdbTiles(gridEl);

  if (items.length <= POSTER_GRID_FIRST_CHUNK) {
    if (typeof onComplete === 'function') onComplete(items.length);
    return;
  }

  var cursor = POSTER_GRID_FIRST_CHUNK;
  var schedule = (typeof window !== 'undefined' && window.requestAnimationFrame)
    ? function(fn) { window.requestAnimationFrame(fn); }
    : function(fn) { setTimeout(fn, 16); };

  function step() {
    // A newer render started, or the grid was swapped out from under us --
    // abandon this pass rather than appending into someone else's list.
    if (generation !== _posterGridGeneration) return;
    if (!gridEl.isConnected) return;
    var slice = items.slice(cursor, cursor + POSTER_GRID_BATCH);
    if (!slice.length) {
      if (typeof onComplete === 'function') onComplete(items.length);
      return;
    }
    gridEl.insertAdjacentHTML('beforeend', slice.map(livePreviewPosterHtml).join(''));
    if (typeof applyBetterPostersToTmdbTiles === 'function') applyBetterPostersToTmdbTiles(gridEl);
    cursor += slice.length;
    if (cursor < items.length) {
      schedule(step);
    } else if (typeof onComplete === 'function') {
      onComplete(items.length);
    }
  }
  schedule(step);
}
window.renderPosterGridChunked = renderPosterGridChunked;

// Same chunked/rAF batching as renderPosterGridChunked, but appends to
// whatever the grid already holds instead of clearing it first. A large
// (100-200+ item) list's See All loads in pages as the user scrolls, and
// each new page used to go through renderPosterGridChunked with the WHOLE
// accumulated item list -- wiping and rebuilding every already-rendered
// poster card (discarding already-decoded images along with it) on every
// single page. That's what made scrolling through a big list jump around
// instead of scrolling smoothly: the grid kept getting torn down and
// rebuilt out from under the user's own scroll position. This only ever
// needs to add the new page's own items, so it only ever does that.
function appendPosterGridItems(gridEl, items) {
  if (!gridEl || !items || !items.length) return;
  var generation = ++_posterGridGeneration;
  var cursor = 0;
  var schedule = (typeof window !== 'undefined' && window.requestAnimationFrame)
    ? function(fn) { window.requestAnimationFrame(fn); }
    : function(fn) { setTimeout(fn, 16); };
  function step() {
    if (generation !== _posterGridGeneration) return;
    if (!gridEl.isConnected) return;
    var slice = items.slice(cursor, cursor + POSTER_GRID_BATCH);
    if (!slice.length) return;
    gridEl.insertAdjacentHTML('beforeend', slice.map(livePreviewPosterHtml).join(''));
    if (typeof applyBetterPostersToTmdbTiles === 'function') applyBetterPostersToTmdbTiles(gridEl);
    cursor += slice.length;
    if (cursor < items.length) schedule(step);
  }
  step();
}
window.appendPosterGridItems = appendPosterGridItems;

// Client mirror of isPersonalShelfUrl (00_constants.js) -- Continue Watching,
// Airing Next, Watch History and Watchlist, from any provider. Kept in step
// with it by tests/personal-shelves.test.mjs, which asserts both sides answer
// the same for the same URLs.
function isPersonalShelfUrlClient(url) {
  if (!url) return false;
  return String(url).split(/[\\r\\n]+/).some((line) => {
    const u = line.trim().toLowerCase();
    if (!u) return false;
    return u.indexOf('autotrack:') === 0 ||
      u.indexOf('trakt:watchlist') === 0 || u.indexOf('trakt:history') === 0 || u.indexOf('trakt:airing-next') === 0 || u.indexOf('trakt:continue-watching') === 0 || u.indexOf('trakt:user:') === 0 ||
      u.indexOf('mdblist:watchlist') === 0 || u.indexOf('mdblist:history') === 0 || u.indexOf('mdblist:airing-next') === 0 || u.indexOf('mdblist:upnext') === 0 || u.indexOf('mdblist:user:') === 0 ||
      u.indexOf('simkl:watchlist') === 0 || u.indexOf('simkl:history') === 0 || u.indexOf('simkl:airing-next') === 0 || u.indexOf('simkl:user:') === 0;
  });
}
window.isPersonalShelfUrlClient = isPersonalShelfUrlClient;

function livePreviewPosterHtml(m) {
  // Resolved into a local, never written back onto m. It used to assign
  // "m.poster = ..." to it, which meant a re-render of the same cached item saw the
  // already-resolved URL as its own original -- harmless while the result was
  // stable, but it would make a Better Posters URL stick after the setting was
  // switched back off, with no original left to restore.
  const resolvedPoster = (typeof resolveClientPoster === 'function')
    ? resolveClientPoster(m, m.poster)
    : m.poster;
  const landscape = m.posterShape === 'landscape';
  const posterClass = 'live-preview-poster' + (landscape ? ' landscape' : '');
  const posterEl = resolvedPoster
    ? '<img class="' + posterClass + '" src="' + escapeAttr(resolvedPoster) + '" alt="" loading="lazy" onerror="handlePosterImgError(this)" data-imdb="' + escapeAttr(m.id || '') + '"><div class="' + posterClass + ' live-preview-poster-placeholder" style="display:none;"><small style="color:var(--muted); font-size:0.7rem;">No poster</small></div>'
    : '<div class="' + posterClass + ' live-preview-poster-placeholder"><small style="color:var(--muted); font-size:0.7rem;">No poster</small></div>';
  
  const parentUrl = (m.listUrl || (window._currentListDetailsParams ? window._currentListDetailsParams.listUrl : '') || '').toLowerCase();
  const parentName = (m.listName || (window._currentListDetailsParams ? window._currentListDetailsParams.name : '') || '').toLowerCase();

  let decodedSlug = '';
  if (parentUrl.startsWith('customlist:v1:')) {
    try {
      const payload = JSON.parse(parentUrl.slice('customlist:v1:'.length));
      decodedSlug = (payload.localSlug || payload.creatorSlug || payload.slug || payload.listSlug || '').toLowerCase();
    } catch (e) {}
  }

  const isCwListContext = parentUrl.includes('continue-watching') || parentUrl.includes('continue_watching') || parentName.includes('continue watching') || decodedSlug === 'continue-watching';
  const isAiringListContext = parentUrl.includes('airing-next') || parentUrl.includes('airing_next') || parentName.includes('airing next') || decodedSlug === 'airing-next';
  const isTraktCwContext = parentUrl === 'trakt:continue-watching' || (parentUrl.includes('continue-watching') && parentUrl.includes('trakt'));
  const isMdblistUpNextContext = parentUrl.includes('upnext') || parentUrl.includes('up-next') || parentName.includes('up next');

  const isCwItem = !!(m.removeShowId || m.isCw || m.listSlug === 'continue-watching' || isCwListContext || isTraktCwContext || isMdblistUpNextContext);
  const isAiringItem = !!(m.isAiringNext || m.listSlug === 'airing-next' || isAiringListContext);
  // A Watchlist shelf carries the same premiere / finale / air-date chips now
  // that fetchAutoTrackedCatalog enriches it from the same Airing Next data
  // (05_catalog-core.js). Checked AFTER the two above so a shelf that is both
  // keeps its more specific meaning.
  const isWatchlistListContext = parentUrl.includes('watchlist') || parentName.includes('watchlist') || decodedSlug === 'watchlist';
  const isWatchlistItem = !isCwItem && !isAiringItem && !!(m.listSlug === 'watchlist' || isWatchlistListContext);

  let removeBtn = '';
  if (!m.isLivePreviewShelf && !m.hideRemoveBtn) {
    if (m.removeExternalProvider) {
      removeBtn = '<button type="button" class="cw-remove-btn" data-remove-type="external" data-provider="' + escapeAttr(m.removeExternalProvider) + '" data-target="' + escapeAttr(m.removeExternalTarget || '') + '" data-list-id="' + escapeAttr(m.removeExternalListId || '') + '" data-remove-id="' + escapeAttr(m.id) + '" data-media-type="' + escapeAttr(m.type || 'movie') + '" onclick="event.stopPropagation(); removeListItemFromDetails(this)" title="Remove from ' + escapeAttr(m.removeExternalProvider) + '" aria-label="Remove from ' + escapeAttr(m.removeExternalProvider) + '">\u2715</button>';
    } else {
      const cwRemoveTarget = m.removeShowId || (isCwItem ? (m.showId || m.id || m.imdbId) : null);
      if (cwRemoveTarget) {
        removeBtn = '<button type="button" class="cw-remove-btn" data-remove-type="cw" data-remove-id="' + escapeAttr(cwRemoveTarget) + '" onclick="event.stopPropagation(); removeListItemFromDetails(this)" title="Remove from Continue Watching" aria-label="Remove from Continue Watching">\u2715</button>';
      } else if (m.removeAiringShowId) {
        removeBtn = '<button type="button" class="cw-remove-btn" data-remove-type="airing" data-remove-id="' + escapeAttr(m.removeAiringShowId) + '" onclick="event.stopPropagation(); removeListItemFromDetails(this)" title="Remove from Airing Next" aria-label="Remove from Airing Next">\u2715</button>';
      } else if (m.removeWatchlistId) {
        removeBtn = '<button type="button" class="cw-remove-btn" data-remove-type="watchlist" data-remove-id="' + escapeAttr(m.removeWatchlistId) + '" onclick="event.stopPropagation(); removeListItemFromDetails(this)" title="Remove from Watchlist" aria-label="Remove from Watchlist">\u2715</button>';
      } else if (m.removeHistoryId) {
        removeBtn = '<button type="button" class="cw-remove-btn" data-remove-type="history" data-remove-id="' + escapeAttr(m.removeHistoryId) + '" onclick="event.stopPropagation(); removeListItemFromDetails(this)" title="Remove from Watch History" aria-label="Remove from Watch History">\u2715</button>';
      } else if (m.removeCustomListSlug) {
        removeBtn = '<button type="button" class="cw-remove-btn" data-remove-type="custom" data-remove-id="' + escapeAttr(m.id) + '" data-remove-slug="' + escapeAttr(m.removeCustomListSlug) + '" onclick="event.stopPropagation(); removeListItemFromDetails(this)" title="Remove from List" aria-label="Remove from List">\u2715</button>';
      }
    }
  }
  
  const badgeSettings = getPosterBadgeSettings();
  const locationAllowed = isTraktCwContext
    ? (badgeSettings.traktContinueWatching !== false)
    : (isMdblistUpNextContext
        ? (badgeSettings.mdblistUpNext !== false)
        : (isCwItem
            ? badgeSettings.continueWatching
            : (isAiringItem
                ? badgeSettings.airingNext
                : (isWatchlistItem ? badgeSettings.watchlist !== false : false))));

  const showAirDate = locationAllowed && badgeSettings.airDate;
  const showPremiere = locationAllowed && badgeSettings.seasonPremiere;
  const showFinale = locationAllowed && badgeSettings.seasonFinale;
  const showFinaleDate = locationAllowed && badgeSettings.seasonFinaleDate;

  let airingMatch = null;
  if (isCwItem || isAiringItem || isWatchlistItem) {
    airingMatch = findAiringMatchFor(m);
  }

  const localCwItem = (isCwItem && typeof loadLocalCustomLists === 'function')
    ? (((loadLocalCustomLists()['continue-watching'] || {}).items || []).find(it => it && (it.showId === m.id || it.id === m.id || (m.showId && (it.showId === m.showId || it.id === m.showId)))))
    : null;

  const effectiveSeasonNum = m.seasonNum != null ? m.seasonNum : (m.season != null ? m.season : (localCwItem && localCwItem.seasonNum != null ? localCwItem.seasonNum : null));
  const effectiveEpisodeNum = m.episodeNum != null ? m.episodeNum : (m.episode != null ? m.episode : (localCwItem && localCwItem.episodeNum != null ? localCwItem.episodeNum : null));

  const mSeason = effectiveSeasonNum != null ? effectiveSeasonNum : (!isCwItem && airingMatch ? airingMatch.seasonNum : null);
  const mEpisode = effectiveEpisodeNum != null ? effectiveEpisodeNum : (!isCwItem && airingMatch ? airingMatch.episodeNum : null);
  
  // Check if this show is on an older past season (not the newest season)
  const isOlderSeason = isCwItem && !!(airingMatch && airingMatch.seasonNum != null && effectiveSeasonNum != null && effectiveSeasonNum < airingMatch.seasonNum);

  let dateBadge = '';
  let bottomBadge = '';

  if (locationAllowed && !isOlderSeason) {
    const isSameSeason = !!(airingMatch && (!mSeason || !airingMatch.seasonNum || mSeason === airingMatch.seasonNum));
    const isSameEpisode = isSameSeason && (!mEpisode || !airingMatch.episodeNum || mEpisode === airingMatch.episodeNum);
    const effectiveAirDate = m.airDate || (isSameEpisode && airingMatch ? airingMatch.airDate : null);
    const currentEpNum = mEpisode != null ? mEpisode : (isSameEpisode && airingMatch ? airingMatch.episodeNum : null);
    const hasLaterAiringEp = !!(isSameSeason && airingMatch && airingMatch.episodeNum != null && currentEpNum != null && currentEpNum < airingMatch.episodeNum);
    const hasAired = (effectiveAirDate && typeof isEpisodeAired === 'function') ? isEpisodeAired(effectiveAirDate) : hasLaterAiringEp;
    const isUnairedEp = effectiveAirDate ? !hasAired : (!hasLaterAiringEp && !!(m.isUnaired || (isSameEpisode && airingMatch && airingMatch.isUnaired)));

    if (showAirDate && !m.hideDateBadge && effectiveAirDate && !hasAired && typeof isEpisodeAired === 'function') {
      // Built rather than passed straight through: this renderer resolves the
      // date, season and episode itself from the tile plus its Airing Next
      // match, and those resolved values are what the air time has to be
      // looked up against.
      dateBadge = typeof watchItemAirDateBadgeHtml === 'function'
        ? watchItemAirDateBadgeHtml({
            airDate: effectiveAirDate,
            airTime: m.airTime || (airingMatch && airingMatch.airTime) || '',
            showId: m.showId || m.id,
            seasonNum: mSeason,
            episodeNum: currentEpNum,
          })
        : '';
    }

    const isSeasonPremiere = (currentEpNum === 1 || (currentEpNum == null && (m.isSeasonPremiere || (isSameEpisode && airingMatch && airingMatch.isSeasonPremiere))));
    const isSeasonFinale = !!(m.isSeasonFinale || (isSameEpisode && airingMatch && airingMatch.isSeasonFinale) || (airingMatch && airingMatch.seasonFinaleEpisodeNumber && currentEpNum != null && currentEpNum === airingMatch.seasonFinaleEpisodeNumber));
    const seasonFinaleAirDate = m.seasonFinaleAirDate || (airingMatch ? (airingMatch.seasonFinaleAirDate || (airingMatch.isSeasonFinale ? airingMatch.airDate : null)) : null);
    const isFinaleUnaired = seasonFinaleAirDate && typeof isEpisodeAired === 'function' ? !isEpisodeAired(seasonFinaleAirDate) : !!seasonFinaleAirDate;

    if (m.isCompanion || (localCwItem && localCwItem.isCompanion)) {
      const compType = m.companionType || (localCwItem && localCwItem.companionType);
      const compNote = m.companionNote || (localCwItem && localCwItem.companionNote) || 'Next in Storyline';
      const compLabel = compType === 'bridge_movie' ? 'Bridge Movie' : (compType === 'sequel_movie' ? 'Sequel Film' : 'Storyline');
      bottomBadge = '<div class="cw-date-badge cw-date-badge-companion" title="' + escapeAttr(compNote) + '">' + escapeHtml(compLabel) + '</div>';
    } else if (showPremiere && isSeasonPremiere && isUnairedEp) {
      bottomBadge = '<div class="cw-date-badge cw-date-badge-premiere" title="Airs on ' + escapeAttr(effectiveAirDate || '') + '">Season Premiere</div>';
    } else if (showFinale && isSeasonFinale) {
      bottomBadge = '<div class="cw-date-badge cw-date-badge-finale" title="Airs on ' + escapeAttr(effectiveAirDate || seasonFinaleAirDate || '') + '">Season Finale</div>';
    } else if (showFinaleDate && seasonFinaleAirDate && isFinaleUnaired && (!isSeasonPremiere || !isUnairedEp || currentEpNum >= 2)) {
      const finaleText = typeof formatAirDateBadge === 'function' ? formatAirDateBadge(seasonFinaleAirDate) : '';
      if (finaleText) {
        bottomBadge = '<div class="cw-date-badge cw-date-badge-finale-date" title="Season finale airs on ' + escapeAttr(seasonFinaleAirDate) + '">Finale: ' + escapeHtml(finaleText) + '</div>';
      }
    }
  }
  const ratingSpan = (!m.isLivePreviewShelf && typeof formatRatingSpanHtml === 'function') ? formatRatingSpanHtml(m) : '';
  let subtitleHtml = '';
  const subText = m.isLivePreviewShelf ? (m.subtitle || '') : (m.subtitle || (m.year ? String(m.year) : ''));
  if (subText && ratingSpan) {
    subtitleHtml = '<div class="live-preview-poster-subtitle" style="display:flex; align-items:center; justify-content:space-between; gap:4px; width:100%;"><span>' + escapeHtml(subText) + '</span>' + ratingSpan + '</div>';
  } else if (subText) {
    subtitleHtml = '<div class="live-preview-poster-subtitle">' + escapeHtml(subText) + '</div>';
  } else if (ratingSpan) {
    subtitleHtml = '<div class="live-preview-poster-subtitle" style="display:flex; align-items:center; justify-content:flex-end; gap:4px; width:100%;">' + ratingSpan + '</div>';
  }
  const extraCardClass = isTraktCwContext ? ' detail-page-trakt-continue-watching' : (isMdblistUpNextContext ? ' detail-page-mdblist-up-next' : '');
  // resolvedPoster, not m.poster: this attribute is what the poster modal
  // reads back, so it has to carry the same URL the tile is showing -- the
  // safe-poster stand-in for a filtered adult item, and the Better Posters
  // URL when that is on. It used to match only because the poster was
  // assigned onto m above.
  return '<div class="live-preview-poster-card clickable-poster' + extraCardClass + '" data-id="' + escapeAttr(m.id || '') + '" data-type="' + escapeAttr(m.type || '') + '" data-title="' + escapeAttr(m.name || '') + '" data-poster="' + escapeAttr(resolvedPoster || '') + '">' +
    '<div style="position:relative; width:100%;">' +
      posterEl +
      dateBadge +
      bottomBadge +
      removeBtn +
    '</div>' +
    '<div class="live-preview-poster-name">' + escapeHtml(m.name || '') + '</div>' +
    subtitleHtml +
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
        cache.sample = cache.sample.filter((it) => it && String(it.id || it.removeShowId || it.removeAiringShowId || it.removeWatchlistId || it.removeHistoryId) !== targetId);
      }
    });
  }

  if (type === 'cw') {
    if (typeof dismissContinueWatchingShow === 'function') dismissContinueWatchingShow(targetId, btn);
  } else if (type === 'airing') {
    if (typeof removeAiringNextShow === 'function') removeAiringNextShow(targetId, btn);
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

    if (provider === 'simkl') {
      if (Array.isArray(window._mySimklLists)) {
        window._mySimklLists.forEach((l) => {
          if (l && Array.isArray(l.items)) {
            l.items = l.items.filter((it) => it && String(it.id || it.imdbId || (it.tmdbId ? 'tmdb:' + it.tmdbId : '')) !== targetId);
          }
        });
      }
      try {
        const simklCache = JSON.parse(localStorage.getItem('myListAddon:simklAiringNextCache') || '[]');
        if (Array.isArray(simklCache)) {
          const updatedCache = simklCache.filter((c) => c && String(c.id || c.imdbId || (c.tmdbId ? 'tmdb:' + c.tmdbId : '')) !== targetId);
          localStorage.setItem('myListAddon:simklAiringNextCache', JSON.stringify(updatedCache));
        }
      } catch (e) {}
    } else if (provider === 'mdblist') {
      if (Array.isArray(window._myMdblistLists)) {
        window._myMdblistLists.forEach((l) => {
          if (l && Array.isArray(l.items)) {
            l.items = l.items.filter((it) => it && String(it.id || it.imdbId || (it.tmdbId ? 'tmdb:' + it.tmdbId : '')) !== targetId);
          }
        });
      }
    } else if (provider === 'trakt') {
      const tLists = window._myPrivateTraktLists || window._myTraktLists;
      if (Array.isArray(tLists)) {
        tLists.forEach((l) => {
          if (l && Array.isArray(l.items)) {
            l.items = l.items.filter((it) => it && String(it.id || it.imdbId || (it.tmdbId ? 'tmdb:' + it.tmdbId : '')) !== targetId);
          }
        });
      }
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
    }).then((res) => externalMutateError(res)).catch(() => 'Network error.')
      .then((err) => {
        // The tile has already gone from the page, and putting it back after
        // the fact would be worse than saying what happened -- so this reports
        // rather than reverts. Without it the toast said "Removed from TRAKT."
        // for a removal Trakt refused, and the item was still there next time
        // the list loaded.
        if (!err) return;
        if (typeof showAppAlert === 'function') {
          showAppAlert('Could Not Remove From ' + (provider ? provider.toUpperCase() : 'List'), err, false);
        } else {
          showAddedToast('Could not remove: ' + err);
        }
      });

    showAddedToast('Removing from ' + (provider ? provider.toUpperCase() : 'List') + '\u2026');
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

// The type a raw Watch History entry shows up as in the ungrouped grid, and
// whether it survives the current filter pill. Shared so that the full render
// below and the in-place update beside it cannot disagree about what "3 items"
// means.
function watchHistoryGridType(it) {
  return (it && it.showId) ? 'series' : ((it && it.type) || 'movie');
}
function watchHistoryPassesFilter(it, filter) {
  const t = watchHistoryGridType(it);
  if (filter === 'movie') return t === 'movie';
  if (filter === 'series') return t === 'series' || t === 'episode';
  return true;
}

// How many tiles the grid shows for a set of raw items. Mirrors the grouping
// and filtering renderWatchHistoryGrid does below -- the count only, because
// rebuilding the tiles themselves is the thing being avoided. Kept next to it
// so the pair stay in step.
function watchHistoryTileCount(items, filter, grouped) {
  if (!grouped) {
    return (items || []).filter((it) => watchHistoryPassesFilter(it, filter)).length;
  }
  const shows = new Set();
  let movies = 0;
  (items || []).forEach((it) => {
    if (!it) return;
    if (it.type === 'episode' || !!it.showId) shows.add(String(it.showId || it.showTitle || it.id));
    else movies++;
  });
  if (filter === 'movie') return movies;
  if (filter === 'series') return shows.size;
  return shows.size + movies;
}

// Called after ONE item has been taken out of Watch History while the See All
// page is open. Returns true if it brought the page up to date on its own.
//
// This exists because the removal used to call renderWatchHistoryGrid(), and
// that starts with gridEl.innerHTML = '' -- so deleting a single item blanked
// the grid and rebuilt every tile from scratch, re-requesting every poster and
// throwing the person back to the top of a list they had scrolled into. On a
// history of any real size that reads as the whole list reloading, which is
// exactly what it was.
//
// Nothing about the surviving tiles changed, so nothing about them needs to be
// re-rendered: the clicked tile is already being faded out by the handler that
// got us here, anything else the removal took with it is dropped in place, and
// the counts are recomputed from the raw items.
//
// That holds in grouped-by-show mode too. Every tile there stands for a
// disjoint set of raw items -- one show, or one movie -- so removing one can
// never change another's episode count; and there is no way to remove a single
// episode while grouped, because the grid has no episode tiles. Toggling the
// grouping re-renders on its own (toggleWatchHistoryGroupShows), so a count
// that went stale in the other mode is recomputed on the way in.
function updateWatchHistoryGridAfterRemoval() {
  const gridEl = document.getElementById('detailGrid');
  const detailTab = document.getElementById('content-list-details');
  // Not on screen -- reopening the page renders it fresh from
  // _rawWatchHistoryItems anyway, so there is nothing to keep in step here.
  if (!gridEl || !detailTab || detailTab.hasAttribute('hidden')) return true;
  const p = window._currentListDetailsParams;
  if (!p) return true;
  const isLocalHist = (!p.listUrl && p.name && p.name.toLowerCase().includes('watch history')) || p.listUrl === 'watch-history' || p.listUrl === 'custom:watch-history' || p.listUrl === 'autotrack:watch-history';
  if (!isLocalHist) return true;
  // No usable item list to reconcile against -- say so and let the full render
  // work it out from whatever state there is.
  if (!Array.isArray(window._rawWatchHistoryItems)) return false;
  const grouped = localStorage.getItem('myListAddon:watchHistoryGroupShows') === 'true';

  // Both tile identities: an ungrouped tile carries the item's own id, a
  // grouped show tile carries the show id. A show keeps its tile for as long
  // as any episode of it is still in the history.
  const live = new Set();
  window._rawWatchHistoryItems.forEach((it) => {
    if (!it) return;
    live.add(String(it.id || it.imdbId || ''));
    if (it.showId) live.add(String(it.showId));
  });
  gridEl.querySelectorAll('.cw-remove-btn[data-remove-type="history"]').forEach((b) => {
    if (live.has(String(b.dataset.removeId || ''))) return;
    const card = b.closest('.live-preview-poster-card');
    // Leave the one already mid-fade to its own animation.
    if (!card || card.style.opacity === '0') return;
    if (card.parentNode) card.parentNode.removeChild(card);
  });

  const filter = window._watchHistoryFilter || 'all';
  const remaining = watchHistoryTileCount(window._rawWatchHistoryItems, filter, grouped);
  const subEl = document.getElementById('detailSubtitle');
  if (subEl) subEl.textContent = remaining + ' item' + (remaining === 1 ? '' : 's');
  const statusEl = document.getElementById('detailStatus');
  if (statusEl) statusEl.innerHTML = remaining ? '' : '<small>No matching items found.</small>';
  return true;
}
window.updateWatchHistoryGridAfterRemoval = updateWatchHistoryGridAfterRemoval;

function renderWatchHistoryGrid() {
  const gridEl = document.getElementById('detailGrid');
  const statusEl = document.getElementById('detailStatus');
  const subEl = document.getElementById('detailSubtitle');
  if (!gridEl) return;
  
  const detailTab = document.getElementById('content-list-details');
  if (!detailTab || detailTab.hasAttribute('hidden')) return;
  const p = window._currentListDetailsParams;
  if (!p) return;
  const isExtHist = !!(
    (p.listUrl && (p.listUrl === 'trakt:history' || p.listUrl.startsWith('trakt:history') || (p.listUrl.includes('trakt.tv/users/') && p.listUrl.includes('/history')))) ||
    (p.listUrl && (p.listUrl === 'mdblist:history' || p.listUrl.startsWith('mdblist:history') || p.listUrl.includes('mdblist.com/history') || (p.listUrl.includes('mdblist.com/lists/') && p.listUrl.includes('/history')))) ||
    (p.listUrl && p.listUrl.startsWith('simkl:user:') && p.listUrl.includes(':history'))
  );
  if (isExtHist) return;
  const isLocalHist = (!p.listUrl && p.name && p.name.toLowerCase().includes('watch history')) || p.listUrl === 'watch-history' || p.listUrl === 'custom:watch-history' || p.listUrl === 'autotrack:watch-history';
  if (!isLocalHist) return;


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
        let showPosterUrl = it.showPoster || it.poster || '';
        if (!showPosterUrl && sId && sId.startsWith('tt')) {
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
            // removeHistoryId, NOT removeShowId. livePreviewPosterHtml reads
            // removeShowId as "this is a Continue Watching tile" -- it tests
            // for it first, and isCwItem keys off it too -- so a grouped Watch
            // History show tile rendered a button labelled "Remove from
            // Continue Watching" that dispatched to dismissContinueWatchingShow
            // and left the watch history untouched, while also picking up
            // Continue Watching's poster badge settings. removeWatchHistoryItemDirect
            // already matches on showId as well as item id, so handing it the
            // show id removes exactly what this tile stands for: every watched
            // episode of that show.
            removeHistoryId: sId || it.id,
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
        if (!movPoster && (it.imdbId || it.id) && String(it.imdbId || it.id).startsWith('tt')) {
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
      if (!entry.poster && entry.id && String(entry.id).startsWith('tt')) {
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
        type: watchHistoryGridType(it),
        name: label.title,
        subtitle: label.subtitle,
        poster: it.poster || it.showPoster || '',
        year: it.year,
        watchedAt: it.watchedAt || 0,
        removeHistoryId: it.id || it.imdbId,
      };
    });
  }

  // Same predicate as watchHistoryPassesFilter, against the processed tiles
  // (grouping rewrites an episode's type, so this cannot read the raw item).
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

  processed.forEach(item => item.listUrl = 'watch-history');
  renderPosterGridChunked(gridEl, processed);
  if (subEl) {
    subEl.textContent = processed.length + ' item' + (processed.length === 1 ? '' : 's');
  }
  if (statusEl) {
    statusEl.innerHTML = processed.length ? '' : '<small>No matching items found.</small>';
  }
}
window.renderWatchHistoryGrid = renderWatchHistoryGrid;


// --- "On Today": what this channel is actually running --------------------
//
// A rotating channel stores a pool much bigger than a day, and until now the
// only way to see which shows and episodes today's lineup had drawn from it
// was to open the channel in Stremio. So you could set 24 shows x 3 episodes
// and have no idea what that produced.
//
// The Worker answers it (see /api/channel-lineup), which matters: the
// rotation is a seeded shuffle, and a second copy of that PRNG living on
// this page is the kind of thing that drifts by one episode after some later
// edit and is never noticed. This asks the same function the meta route uses.
async function renderChannelLineupTab(params) {
  const gridEl = document.getElementById('detailGrid');
  const statusEl = document.getElementById('detailStatus');
  const subEl = document.getElementById('detailSubtitle');
  if (!gridEl) return;
  const listUrl = (params && params.listUrl) || '';
  const channelId = listUrl.startsWith('channel:id:') ? listUrl.slice('channel:id:'.length) : '';
  const channel = channelId && typeof loadLocalChannels === 'function' ? loadLocalChannels()[channelId] : null;
  if (!channel) {
    if (statusEl) statusEl.innerHTML = '<small>This channel is not saved in this browser, so there is nothing to look up.</small>';
    return;
  }
  gridEl.innerHTML = '';
  // The lineup rewrites the page subtitle with today's numbers, so hold on to
  // the list's own subtitle -- All has to put it back.
  if (subEl && typeof window._listDetailsSubtitleBeforeLineup !== 'string') {
    window._listDetailsSubtitleBeforeLineup = subEl.textContent || '';
  }
  if (statusEl) statusEl.innerHTML = '<small>Working out what is on&hellip;</small>';
  try {
    const res = await fetch(ORIGIN + '/api/channel-lineup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'channel:v1:' + JSON.stringify(channel) }),
      cache: 'no-store',
    });
    const data = await res.json();
    if (!data.ok) {
      if (statusEl) statusEl.innerHTML = '<p class="testresult err">✗ ' + escapeHtml(data.error || 'Could not work out this channel’s lineup.') + '</p>';
      return;
    }
    const items = data.items || [];
    if (!items.length) {
      if (statusEl) statusEl.innerHTML = '<small>Nothing is scheduled for this channel right now.</small>';
      return;
    }
    const tiles = items.map((it, idx) => {
      const seasonEp = (it.season != null && it.episode != null && it.kind !== 'movie')
        ? ('S' + it.season + 'E' + it.episode) : '';
      const showName = it.showName || it.title || 'Untitled';
      return {
        id: (typeof channelItemId === 'function' ? channelItemId(it, idx) : (it.imdbId || String(idx))),
        type: it.kind === 'movie' ? 'movie' : 'series',
        // The running order IS the answer here, so each tile is numbered:
        // "12." is the twelfth thing this channel plays today.
        name: (idx + 1) + '. ' + showName + (seasonEp ? ' ' + seasonEp : ''),
        subtitle: it.epName || '',
        title: it.title || showName,
        poster: it.thumbnail || it.poster || it.showPoster || channel.poster || '',
        thumbnail: it.thumbnail || it.poster || '',
        year: it.released ? String(it.released).slice(0, 4) : '',
        listUrl: listUrl,
        listName: channel.name || '',
      };
    });
    if (typeof renderPosterGridChunked === 'function') renderPosterGridChunked(gridEl, tiles);
    const bits = [items.length + ' playing today'];
    if (data.rotating && data.plan) {
      bits.push('out of ' + data.poolSize + ', ' + data.plan.shows + ' shows × ' + data.plan.episodes + ' episodes');
    }
    // An honest label rather than a lineup that differs from what will play:
    // this endpoint is unauthenticated and cannot read anyone's history, so
    // a channel whose rules depend on one is previewed without them.
    if ((data.unappliedRules || []).length) {
      bits.push('shown without ' + (data.unappliedRules.indexOf('dynamic') !== -1
        ? 'your Continue Watching'
        : 'the watched-episode filter') + ', which only applies once installed');
    }
    if (subEl) subEl.textContent = bits.join(' · ');
    if (statusEl) statusEl.innerHTML = '';
  } catch (e) {
    if (statusEl) statusEl.innerHTML = '<p class="testresult err">✗ Network error working out this channel’s lineup.</p>';
  }
}

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

  // "On Today" is not a filter over what is loaded -- it is a different
  // question, answered by the Worker: out of this channel's whole pool,
  // which picks is it actually running right now? See renderChannelLineupTab.
  if (newType === 'lineup') {
    if (typeof renderChannelLineupTab === 'function') renderChannelLineupTab(p);
    return;
  }

  // Coming back off On Today: restore the subtitle it borrowed, so All reads
  // as the list again rather than keeping today's running-order line.
  if (typeof window._listDetailsSubtitleBeforeLineup === 'string') {
    if (typeof window._listDetailsSubtitleRefresh === 'function') {
      window._listDetailsSubtitleRefresh();
    } else {
      const subEl = document.getElementById('detailSubtitle');
      if (subEl) subEl.textContent = window._listDetailsSubtitleBeforeLineup;
    }
    const statusEl = document.getElementById('detailStatus');
    if (statusEl) statusEl.innerHTML = '';
    window._listDetailsSubtitleBeforeLineup = null;
  }

  // If this is a dual-type chart (separate endpoint for movies vs series)
  let isDualTypeChart = false;
  let targetUrl = p.listUrl;
  let targetName = p.name;

  if (p.listUrl === 'tmdb:chart:new_movies' || p.listUrl === 'tmdb:chart:new_shows') {
    isDualTypeChart = true;
    if (newType === 'series') {
      targetUrl = 'tmdb:chart:new_shows';
      targetName = 'New Releases';
    } else if (newType === 'movie') {
      targetUrl = 'tmdb:chart:new_movies';
      targetName = 'New Releases';
    }
  } else if (typeof COMBINED_CHART_LISTS !== 'undefined' && Array.isArray(COMBINED_CHART_LISTS)) {
    const nl = String.fromCharCode(10);
    const combinedMatch = COMBINED_CHART_LISTS.find((c) => {
      const movieJoined = Array.isArray(c.movieUrls) ? c.movieUrls.join(nl) : '';
      const showJoined = Array.isArray(c.showUrls) ? c.showUrls.join(nl) : '';
      return c.name === p.name || movieJoined === p.listUrl || showJoined === p.listUrl;
    });
    if (combinedMatch) {
      isDualTypeChart = true;
      targetName = combinedMatch.name || p.name;
      if (newType === 'series') targetUrl = Array.isArray(combinedMatch.showUrls) ? combinedMatch.showUrls.join(nl) : p.listUrl;
      else if (newType === 'movie') targetUrl = Array.isArray(combinedMatch.movieUrls) ? combinedMatch.movieUrls.join(nl) : p.listUrl;
    }
  }
  
  if (!isDualTypeChart && typeof CHART_SLUG_ENTRIES !== 'undefined' && Array.isArray(CHART_SLUG_ENTRIES)) {
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

  const isExternalProviderList = !!(p.listUrl && (
    p.listUrl === 'trakt:history' || p.listUrl.startsWith('trakt:history:') || (p.listUrl.includes('trakt.tv/users/') && p.listUrl.includes('/history')) ||
    p.listUrl === 'trakt:watchlist' || p.listUrl.startsWith('trakt:watchlist:') || (p.listUrl.includes('trakt.tv/users/') && p.listUrl.includes('/watchlist')) ||
    p.listUrl === 'mdblist:history' || p.listUrl.startsWith('mdblist:history:') || p.listUrl.includes('mdblist.com/history') || (p.listUrl.includes('mdblist.com/lists/') && p.listUrl.includes('/history')) ||
    p.listUrl === 'mdblist:watchlist' || p.listUrl.startsWith('mdblist:watchlist:') || (p.listUrl.includes('mdblist.com/lists/') && p.listUrl.includes('/watchlist'))
  ));

  if ((isDualTypeChart || isExternalProviderList) && (newType === 'movie' || newType === 'series' || (newType === 'all' && isExternalProviderList)) && (p.type !== newType || p.listUrl !== targetUrl)) {
    openListDetailsPage(targetName, newType === 'all' ? 'mixed' : newType, targetUrl, null, {
      preserveScroll: true
    });
    return;
  }

  // Instant client filter for mixed lists (e.g. Watchlist, Custom Mixed Lists):
  if (window._currentListDetailsAllItems && Array.isArray(window._currentListDetailsAllItems)) {
    let filtered = window._currentListDetailsAllItems;
    if (newType === 'movie') {
      filtered = filtered.filter((it) => it.type === 'movie' || it.kind === 'movie' || (!it.showId && it.type !== 'series' && it.type !== 'tv' && it.type !== 'show' && it.type !== 'episode' && it.kind !== 'series' && it.kind !== 'tv'));
    } else if (newType === 'series') {
      filtered = filtered.filter((it) => it.type === 'series' || it.type === 'tv' || it.type === 'show' || it.type === 'episode' || it.kind === 'series' || it.kind === 'tv' || !!it.showId || it.seasonNum != null);
    }
    const gridEl = document.getElementById('detailGrid');
    const statusEl = document.getElementById('detailStatus');
    if (gridEl) {
      filtered.forEach(item => { item.listUrl = p.listUrl; item.listName = p.name; });
      renderPosterGridChunked(gridEl, filtered);
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
async function openListDetailsPage(name, type, listUrl, preloaded, opts) {
  opts = opts || {};
  const nLower = (name || '').trim().toLowerCase();
  const urlStr = (listUrl || '').trim();
  const urlLower = urlStr.toLowerCase();
  const storylineEventId = (listUrl && listUrl.startsWith('custom:storyline:')) ? listUrl.slice('custom:storyline:'.length) : null;
  const currentActiveTab = window._originTab || localStorage.getItem('myListAddon:activeTab') || document.querySelector('.tab-btn.active, .bottom-nav-item.active')?.dataset.tab || 'discover';
  const currentSubmenu = window._currentCatalogsSubmenu || localStorage.getItem('myListAddon:catalogsSubmenu') || 'all';
  const currentChannelsSubmenu = window._currentChannelsSubmenu || localStorage.getItem('myListAddon:channelsSubmenu') || 'storylines';
  
  if (!opts.preserveScroll) {
    if (currentActiveTab !== 'list-details' && currentActiveTab !== 'item-details') {
      window._previousTab = currentActiveTab;
      window._previousScrollY = window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0;
      window._previousChannelsSubmenu = currentChannelsSubmenu;
    }
    switchTab('list-details');
    if (typeof opts.restoreScrollY === 'number') {
      window.scrollTo({ top: opts.restoreScrollY, behavior: 'instant' });
    } else {
      window.scrollTo({ top: 0, behavior: 'instant' });
    }
  }
  if (opts.preserveScroll) {
    try {
      const cleanPath = (typeof getListCleanPath === 'function') ? getListCleanPath(listUrl, name) : null;
      const safeUrlParam = (listUrl && listUrl.length < 1500) ? listUrl : '';
      const targetUrl = cleanPath || ('/#/list?' + new URLSearchParams({ name: name || '', type: type || 'movie', url: safeUrlParam }).toString());
      history.replaceState({ view: 'list', name: name, type: type, listUrl: safeUrlParam, fromTab: currentActiveTab, fromCatalogsSubmenu: currentSubmenu, fromChannelsSubmenu: currentChannelsSubmenu, previousScrollY: window._previousScrollY }, '', targetUrl);
    } catch (e) {}
  } else if (!opts.skipPushState) {
    try {
      const cleanPath = (typeof getListCleanPath === 'function') ? getListCleanPath(listUrl, name) : null;
      const safeUrlParam = (listUrl && listUrl.length < 1500) ? listUrl : '';
      const targetUrl = cleanPath || ('/#/list?' + new URLSearchParams({ name: name || '', type: type || 'movie', url: safeUrlParam }).toString());
      const currentLoc = window.location.pathname + window.location.search + window.location.hash;
      if (window.location.hash !== targetUrl && currentLoc !== targetUrl) {
        if (cleanPath) {
          history.pushState({ view: 'list', name: name, type: type, listUrl: listUrl, fromTab: currentActiveTab, fromCatalogsSubmenu: currentSubmenu, fromChannelsSubmenu: currentChannelsSubmenu, previousScrollY: window._previousScrollY }, '', cleanPath);
        } else {
          const params = new URLSearchParams({ name: name || '', type: type || 'movie', url: safeUrlParam });
          history.pushState({ view: 'list', name: name, type: type, listUrl: safeUrlParam, fromTab: currentActiveTab, fromCatalogsSubmenu: currentSubmenu, fromChannelsSubmenu: currentChannelsSubmenu, previousScrollY: window._previousScrollY }, '', '/#/list?' + params.toString());
        }
      }
    } catch (e) {}
  }

  const cacheKey = (name || '') + '::' + (type || '') + '::' + (listUrl || '');
  window._currentListDetailsKey = cacheKey;
  window._listPreloadedCache = window._listPreloadedCache || {};
  if (preloaded && preloaded.sample && preloaded.sample.length) {
    window._listPreloadedCache[cacheKey] = preloaded;
  } else if (!preloaded || !preloaded.sample || !preloaded.sample.length) {
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
              // Same collapse as openChannelDetailsPage had -- see channelItemId
              // (20_client-channel-builder.js) for why the show id alone is not enough.
              id: (typeof channelItemId === 'function') ? channelItemId(it, idx) : (it.showId || it.id || ('channel_item_' + idx)),
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
      if (slug === 'continue-watching') {
        const map = (typeof loadLocalCustomLists === 'function') ? loadLocalCustomLists() : {};
        const cwList = map['continue-watching'] || (typeof getOrCreateContinueWatchingList === 'function' ? getOrCreateContinueWatchingList() : null);
        const rawItems = (cwList && Array.isArray(cwList.items)) ? cwList.items : [];
        const deduped = (typeof dedupeContinueWatchingItems === 'function') ? dedupeContinueWatchingItems(rawItems) : rawItems;
        const sample = deduped.map((it) => {
          const label = (typeof formatWatchItemLabel === 'function') ? formatWatchItemLabel(it) : { title: it.title || it.name || '', subtitle: '' };
          const epId = String(it.id || '');
          const showId = it.showId || (epId.startsWith('tt') && epId.includes(':') ? epId.split(':')[0] : (epId.startsWith('tmdb:') && epId.includes(':') ? epId.split(':')[0] + ':' + epId.split(':')[1] : (it.imdbId || it.id)));
          const showPoster = it.showPoster || (showId && String(showId).startsWith('tt') ? ('https://images.metahub.space/poster/medium/' + showId + '/img') : it.poster);
          return {
            id: showId || it.id,
            showId: showId || it.id,
            showTitle: it.showTitle || it.title || it.name,
            seasonNum: it.seasonNum,
            episodeNum: it.episodeNum,
            type: 'series',
            name: label.title,
            subtitle: label.subtitle,
            poster: showPoster,
            year: it.year,
            airDate: it.airDate,
            isUnaired: it.isUnaired,
            seasonFinaleAirDate: it.seasonFinaleAirDate,
            isSeasonPremiere: it.isSeasonPremiere,
            isSeasonFinale: it.isSeasonFinale,
            removeShowId: showId || it.id,
          };
        });
        preloaded = { sample: sample, count: sample.length, maybeMore: false };
        window._listPreloadedCache[cacheKey] = preloaded;
      } else if (slug === 'watch-history') {
        const map = (typeof loadLocalCustomLists === 'function') ? loadLocalCustomLists() : {};
        const whList = map['watch-history'] || { items: [] };
        const sample = (whList.items || []).map((it) => {
          const label = (typeof formatWatchItemLabel === 'function') ? formatWatchItemLabel(it) : { title: it.title || it.name || '', subtitle: '' };
          const isShow = (it.type === 'series' || it.type === 'tv' || it.type === 'show' || it.kind === 'series' || it.kind === 'tv' || !!it.showId || it.seasonNum != null);
          return {
            id: it.showId || it.imdbId || it.id,
            type: isShow ? 'series' : 'movie',
            name: label.title,
            subtitle: label.subtitle,
            poster: it.poster || it.showPoster,
            year: it.year,
            rating: it.rating != null ? it.rating : (it.vote_average != null ? it.vote_average : (it.tmdbRating != null ? it.tmdbRating : (it.imdbRating ? parseFloat(it.imdbRating) : undefined))),
            vote_average: it.vote_average != null ? it.vote_average : undefined,
            airDate: it.airDate,
            removeHistoryId: it.id || it.imdbId,
          };
        });
        preloaded = { sample: sample, count: sample.length, maybeMore: false };
        window._listPreloadedCache[cacheKey] = preloaded;
      }
    } else if (listUrl && (listUrl.startsWith('custom:') || listUrl.startsWith('customlist:v1:') || listUrl.startsWith('/lists/custom/'))) {
      try {
        let slug = '';
        let directItems = null;
        if (listUrl.startsWith('custom:')) {
          slug = listUrl.slice('custom:'.length);
        } else if (listUrl.startsWith('/lists/custom/')) {
          slug = listUrl.slice('/lists/custom/'.length);
        } else if (listUrl.startsWith('customlist:v1:')) {
          try {
            const p = JSON.parse(listUrl.slice('customlist:v1:'.length));
            slug = p.listSlug || p.localSlug || p.creatorSlug || '';
            if (Array.isArray(p.items)) directItems = p.items;
          } catch (e) {}
        }
        const match = (typeof findCustomListBySlugOrName === 'function') ? findCustomListBySlugOrName(slug, name) : null;
        const rawItems = (match && Array.isArray(match.items) && match.items.length) ? match.items : (directItems || []);
        if (rawItems.length) {
          const isCw = (match && match.slug === 'continue-watching') || slug === 'continue-watching';
          const isWatchlist = (match && (match.slug === 'watchlist' || match.isWatchlist)) || slug === 'watchlist';
          const isHistory = (match && match.slug === 'watch-history') || slug === 'watch-history';
          const itemsToProcess = isCw ? (typeof dedupeContinueWatchingItems === 'function' ? dedupeContinueWatchingItems(rawItems) : rawItems) : rawItems;
          const sample = itemsToProcess.map((it) => {
            const label = (typeof formatWatchItemLabel === 'function') ? formatWatchItemLabel(it) : { title: it.title || it.name || '', subtitle: '' };
            const isShow = (it.type === 'series' || it.type === 'tv' || it.type === 'show' || it.kind === 'series' || it.kind === 'tv' || !!it.showId || it.seasonNum != null);
            const itemType = isShow ? 'series' : ((it.type === 'movie' || it.kind === 'movie') ? 'movie' : (it.type === 'episode' ? 'episode' : ((match && match.type && match.type !== 'mixed') ? match.type : (type || 'movie'))));
            const epId = String(it.id || '');
            const showId = isCw ? (it.showId || (epId.startsWith('tt') && epId.includes(':') ? epId.split(':')[0] : (epId.startsWith('tmdb:') && epId.includes(':') ? epId.split(':')[0] + ':' + epId.split(':')[1] : (it.imdbId || it.id)))) : (it.showId || it.imdbId || it.id || (it.tmdbId ? ('tmdb:' + it.tmdbId) : null));
            const showPoster = isCw ? (it.showPoster || (showId && String(showId).startsWith('tt') ? ('https://images.metahub.space/poster/medium/' + showId + '/img') : it.poster)) : (it.poster || it.showPoster);
            return {
              id: showId,
              // showId here is the "is this a TV show" flag the Movies/Shows
              // tab filters below key off of (!!it.showId) -- id above keeps
              // the full imdbId/id fallback chain for navigation/posters,
              // but that same fallback would make every plain movie item
              // (no real showId, just its own imdbId) carry a truthy showId
              // too, so the Shows tab matched movies right along with shows.
              // Only a genuine show/episode gets one here.
              showId: isShow ? showId : null,
              showTitle: it.showTitle || it.title || it.name,
              seasonNum: it.seasonNum,
              episodeNum: it.episodeNum,
              type: itemType,
              name: label.title || it.title || it.name || 'Untitled',
              subtitle: label.subtitle || '',
              poster: showPoster,
              year: it.year,
              rating: it.rating != null ? it.rating : (it.vote_average != null ? it.vote_average : (it.tmdbRating != null ? it.tmdbRating : (it.imdbRating ? parseFloat(it.imdbRating) : undefined))),
              vote_average: it.vote_average != null ? it.vote_average : undefined,
              airDate: it.airDate,
              isUnaired: it.isUnaired,
              seasonFinaleAirDate: it.seasonFinaleAirDate,
              isSeasonPremiere: it.isSeasonPremiere,
              isSeasonFinale: it.isSeasonFinale,
              removeShowId: isCw ? (it.showId || it.id) : null,
              removeWatchlistId: isWatchlist ? (it.imdbId || it.id) : null,
              removeHistoryId: isHistory ? (it.id || it.imdbId) : null,
              removeCustomListSlug: (!isCw && !isWatchlist && !isHistory && (match ? (match.slug || match.localSlug) : slug)) ? (match ? (match.slug || match.localSlug) : slug) : null,
            };
          });
          preloaded = { sample: sample, count: sample.length, maybeMore: false };
          window._listPreloadedCache[cacheKey] = preloaded;
        }
      } catch (e) {}
    } else if (!listUrl && name) {
      const isGenericChartName = nLower === 'popular' || nLower.startsWith('popular ') || nLower.startsWith('popular -') || nLower === 'trending' || nLower.startsWith('trending ') || nLower.startsWith('trending -') || nLower === 'new releases' || nLower.startsWith('new releases') || nLower === 'airing next';
      if (!isGenericChartName) {
        try {
          const map = (typeof loadLocalCustomLists === 'function') ? loadLocalCustomLists() : {};
          let match = Object.values(map).find((l) => l && (l.name === name || l.slug === name || (name && l.name && l.name.toLowerCase() === name.toLowerCase())));
          if (match && Array.isArray(match.items) && match.items.length) {
            const isCw = match.slug === 'continue-watching';
            const isWatchlist = match.slug === 'watchlist' || match.isWatchlist || (match.name && match.name.toLowerCase() === 'watchlist');
            const isHistory = match.slug === 'watch-history' || (match.name && match.name.toLowerCase() === 'watch history');
            const itemsToProcess = isCw ? (typeof dedupeContinueWatchingItems === 'function' ? dedupeContinueWatchingItems(match.items) : match.items) : match.items;
            const sample = itemsToProcess.map((it) => {
              const label = (typeof formatWatchItemLabel === 'function') ? formatWatchItemLabel(it) : { title: it.title || it.name || '', subtitle: '' };
              const isShow = (it.type === 'series' || it.type === 'tv' || it.type === 'show' || it.kind === 'series' || it.kind === 'tv' || !!it.showId || it.seasonNum != null);
              const itemType = isShow ? 'series' : ((it.type === 'movie' || it.kind === 'movie') ? 'movie' : (it.type === 'episode' ? 'episode' : (match && match.type && match.type !== 'mixed' ? match.type : 'movie')));
              const epId = String(it.id || '');
              const showId = isCw ? (it.showId || (epId.startsWith('tt') && epId.includes(':') ? epId.split(':')[0] : (epId.startsWith('tmdb:') && epId.includes(':') ? epId.split(':')[0] + ':' + epId.split(':')[1] : (it.imdbId || it.id)))) : (it.showId || it.imdbId || it.id || (it.tmdbId ? ('tmdb:' + it.tmdbId) : null));
              const showPoster = isCw ? (it.showPoster || (showId && String(showId).startsWith('tt') ? ('https://images.metahub.space/poster/medium/' + showId + '/img') : it.poster)) : (it.poster || it.showPoster);
              return {
                id: showId,
                // See the equivalent customlist:v1: branch above -- showId
                // here must stay gated on isShow, or a plain movie's own
                // imdbId (the fallback's last resort) reads as a truthy
                // showId and the Shows tab filter (!!it.showId) matches it.
                showId: isShow ? showId : null,
                showTitle: it.showTitle || it.title || it.name,
                seasonNum: it.seasonNum,
                episodeNum: it.episodeNum,
                type: itemType,
                name: label.title || it.title || it.name || 'Untitled',
                subtitle: label.subtitle || '',
                poster: showPoster,
                year: it.year,
                rating: it.rating != null ? it.rating : (it.vote_average != null ? it.vote_average : (it.tmdbRating != null ? it.tmdbRating : (it.imdbRating ? parseFloat(it.imdbRating) : undefined))),
                vote_average: it.vote_average != null ? it.vote_average : undefined,
                airDate: it.airDate,
                isUnaired: it.isUnaired,
                seasonFinaleAirDate: it.seasonFinaleAirDate,
                isSeasonPremiere: it.isSeasonPremiere,
                isSeasonFinale: it.isSeasonFinale,
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
              const isShow = (it.type === 'series' || it.type === 'tv' || it.type === 'show' || it.kind === 'series' || it.kind === 'tv' || !!it.showId || it.seasonNum != null);
              const itemType = isShow ? 'series' : ((it.type === 'movie' || it.kind === 'movie') ? 'movie' : (it.type === 'episode' ? 'episode' : (match && match.type && match.type !== 'mixed' ? match.type : 'movie')));
              return {
                id: it.showId || it.imdbId || it.id || (it.tmdbId ? ('tmdb:' + it.tmdbId) : null),
                type: itemType,
                name: label.title || it.title || it.name || 'Untitled',
                subtitle: label.subtitle || '',
                poster: isCw ? (it.showPoster || it.poster) : (it.poster || it.showPoster),
                year: it.year,
                rating: it.rating != null ? it.rating : (it.vote_average != null ? it.vote_average : (it.tmdbRating != null ? it.tmdbRating : (it.imdbRating ? parseFloat(it.imdbRating) : undefined))),
                vote_average: it.vote_average != null ? it.vote_average : undefined,
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
  }

  const titleEl = document.getElementById('detailTitle');
  const subEl = document.getElementById('detailSubtitle');
  const gridEl = document.getElementById('detailGrid');
  const statusEl = document.getElementById('detailStatus');
  const addBtn = document.getElementById('detailAddBtn');
  const likeBtn = document.getElementById('detailLikeBtn');
  if (!gridEl) return;

  let creatorName = (opts && opts.creatorName) || (preloaded && preloaded.creatorName) || null;

  if (
    nLower === 'popular' ||
    nLower === 'trending' ||
    nLower === 'streaming top 10 (all services)' ||
    nLower === 'streaming (all services)' ||
    urlLower.startsWith('tmdb:genre:') ||
    urlLower.startsWith('tmdb:holiday:') ||
    urlLower.startsWith('mylists:') ||
    urlLower.startsWith('tmdb:new-on-streaming') ||
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
  else if (urlLower.includes('trakt.tv/users/')) {
    const trakt = urlStr.match(new RegExp('(?:https?:)?(?://(?:www\\.)?trakt\\.tv/users/([^/]+))', 'i'));
    if (trakt && trakt[1] && trakt[1].toLowerCase() !== 'me') {
      creatorName = trakt[1];
    } else {
      creatorName = 'Trakt';
    }
  } else if (urlLower.startsWith('trakt:') || urlLower.includes('trakt.tv') || nLower.includes('trakt')) {
    creatorName = 'Trakt';
  }
  else if (urlLower.startsWith('simkl:chart:')) {
    creatorName = 'Simkl';
  } else if (urlLower.startsWith('simkl:user:')) {
    const parts = urlStr.split(':');
    creatorName = parts[2] || 'Simkl';
  }
  else if (urlLower === 'tmdb:chart:netflixkids' || nLower.includes('netflix kids')) {
    creatorName = 'Netflix';
  } else if (urlLower.startsWith('tmdb:chart:') || urlLower === 'tmdb:hidden-gems' || urlLower.startsWith('tmdb:top10:')) {
    creatorName = 'TMDB';
  }
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

  // The list's real size when something upstream actually knows it: a
  // stored list's item count, or a source that reports a total (see
  // /api/preview's totalItems). Coerced, because it arrives from a dataset
  // attribute -- a string -- as often as it arrives as a number, and it is
  // compared against the loaded count below.
  const rawKnownTotal = (opts && opts.itemCount) || (preloaded && preloaded.itemCount) ||
    (preloaded && Array.isArray(preloaded.items) ? preloaded.items.length : null);
  let knownTotalItems = Number.isFinite(Number(rawKnownTotal)) && Number(rawKnownTotal) > 0
    ? Number(rawKnownTotal)
    : null;
  // Whether the source still has pages this view has not loaded. Held here
  // rather than passed around, so every re-render of the subtitle -- a page
  // arriving, a like landing, an item being removed -- agrees about it.
  let moreToLoad = false;
  let likesCount = (opts && opts.likes !== undefined && opts.likes !== null && opts.likes !== '') ? opts.likes : ((preloaded && preloaded.likes !== undefined && preloaded.likes !== null) ? preloaded.likes : null);

  const isNoLikesList =
    nLower.includes('recommended movies') ||
    nLower.includes('recommended shows') ||
    nLower.includes('continue watching') ||
    nLower.includes('watch history') ||
    nLower.includes('airing next') ||
    urlLower.startsWith('custom:curated:') ||
    urlLower.startsWith('autotrack:') ||
    urlLower.startsWith('simkl:user:') ||
    urlLower === 'custom:continue-watching' ||
    urlLower === 'custom:watch-history' ||
    urlLower === 'custom:airing-next';

  if (isNoLikesList) {
    likesCount = null;
  }

  function formatSubtitle(count) {
    const parts = [];
    if (creatorName) parts.push('by ' + creatorName);
    parts.push(type === 'series' ? 'Shows' : (type === 'mixed' ? 'Mixed' : 'Movies'));
    const loaded = (count === undefined || count === null) ? null : Number(count);
    // A known total is only believable while it is at least what is already
    // on screen. One that the loaded items have overtaken was never the
    // list's size -- it was a first page's length, capped at 100 by
    // /api/preview, handed over by whatever card was clicked. Believing it
    // is how a 303-item chart went on saying "100 items" after the whole
    // thing had been scrolled through.
    if (knownTotalItems != null && (loaded == null || knownTotalItems >= loaded)) {
      parts.push(knownTotalItems.toLocaleString() + ' item' + (knownTotalItems === 1 ? '' : 's'));
    } else if (loaded != null) {
      // No total from the source, so the honest claim is "at least this
      // many" until the last page lands -- a bare "100" on a list still
      // paging in reads as the whole list.
      parts.push(loaded.toLocaleString() + (moreToLoad ? '+' : '') + ' item' + (loaded === 1 ? '' : 's'));
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
    subEl.textContent = formatSubtitle(loadedCount);
  };

  window._updateListDetailsItemCount = function(newCount) {
    // A removal makes the list itself shorter, so a total this page was
    // handed has to come down with it -- otherwise the header keeps
    // advertising the size the list had before the item was removed.
    if (knownTotalItems != null && typeof newCount === 'number' && newCount < loadedCount) {
      knownTotalItems = Math.max(0, knownTotalItems - (loadedCount - newCount));
      if (knownTotalItems === 0) knownTotalItems = null;
    }
    loadedCount = newCount;
    if (subEl) subEl.textContent = formatSubtitle(newCount);
  };

  titleEl.textContent = name || 'List';
  subEl.textContent = formatSubtitle(null);
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
    let isAdded;
    if (storylineEventId) {
      const chId = 'channel-' + storylineEventId;
      isAdded = [...document.querySelectorAll('#lists .entry')].some((row) =>
        [...row.querySelectorAll('.url')].some((u) => u.value.includes(chId))
      );
    } else {
      isAdded = typeof isListAddedToConfig === 'function' ? (isListAddedToConfig(listUrl, type) || isListAddedToConfig(null, type, listUrl) || isListAddedToConfig(listUrl, 'movie') || isListAddedToConfig(listUrl, 'series') || isListAddedToConfig(listUrl)) : false;
    }
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

  const isContinueWatching = (name && name.toLowerCase().includes('continue watching')) || (listUrl === 'autotrack:continue-watching' || listUrl === 'custom:continue-watching' || (listUrl && listUrl.includes('continue-watching')));
  if (isContinueWatching) {
    type = 'series';
    isDualTypeChart = false;
  }

  window._currentListDetailsParams = { name, type, listUrl };
  window._currentListDetailsFilter = (isDualTypeChart && !isContinueWatching) ? type : 'all';
  window._currentListDetailsAllItems = [];
  // A fresh list page: whatever subtitle On Today had stashed belongs to the
  // list we just left.
  window._listDetailsSubtitleBeforeLineup = null;
  window._listDetailsSubtitleRefresh = null;
  const filterBar = document.getElementById('detailFilterBar');
  const isExternalHistory = !!(
    (listUrl && (listUrl === 'trakt:history' || listUrl.startsWith('trakt:history') || (listUrl.includes('trakt.tv/users/') && listUrl.includes('/history')))) ||
    (listUrl && (listUrl === 'mdblist:history' || listUrl.startsWith('mdblist:history') || listUrl.includes('mdblist.com/history') || (listUrl.includes('mdblist.com/lists/') && listUrl.includes('/history')))) ||
    (listUrl && listUrl.startsWith('simkl:user:') && listUrl.includes(':history'))
  );
  const isLocalWatchHistory = !isExternalHistory && (
    (!listUrl && (nLower === 'watch history' || nLower.includes('watch history'))) ||
    listUrl === 'autotrack:watch-history' ||
    listUrl === 'custom:watch-history' ||
    listUrl === 'watch-history'
  );
  const isMixedList = type === 'mixed' || isDualTypeChart || isExternalHistory || (preloaded && preloaded.sample && preloaded.sample.some((it) => it.type === 'series' || it.showId) && preloaded.sample.some((it) => it.type === 'movie' || (!it.showId && it.type !== 'series' && it.type !== 'episode'))) || (listUrl && (listUrl.includes('watchlist') || listUrl.includes('continue-watching') || listUrl.startsWith('autotrack:')));

  // A channel saved in this browser -- the only thing that HAS a "today" to
  // show, and the only one whose payload is here to ask about. A directory
  // preview is somebody else's channel and is not in the local store.
  const lineupChannelId = (listUrl && listUrl.startsWith('channel:id:')) ? listUrl.slice('channel:id:'.length) : '';
  const canShowLineup = !!(lineupChannelId && typeof loadLocalChannels === 'function' && loadLocalChannels()[lineupChannelId]);
  // Whether the Movies/Shows pills have anything to divide. A channel of
  // only episodes has nothing to filter, but it still has a lineup -- which
  // is why the bar can no longer be gated on being mixed.
  const channelHasBothTypes = !!(preloaded && preloaded.sample &&
    preloaded.sample.some((it) => it && it.type === 'movie') &&
    preloaded.sample.some((it) => it && it.type !== 'movie'));

  const whControls = document.getElementById('whFilterControls');
  const whSortControls = document.getElementById('whSortControls');
  const genericTypeControls = document.getElementById('genericTypeFilterControls');
  const cwClearBtn = document.getElementById('cwClearHistoryBtn');
  if (cwClearBtn) cwClearBtn.style.display = 'none';

  if (filterBar) {
    if (isLocalWatchHistory) {
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
    } else if (isDualTypeChart || isMixedList || canShowLineup) {
      filterBar.style.display = 'flex';
      if (whControls) whControls.style.display = 'none';
      if (whSortControls) whSortControls.style.display = 'none';
      if (genericTypeControls) {
        genericTypeControls.style.display = 'flex';
        if (cwClearBtn) {
          cwClearBtn.style.display = isContinueWatching ? '' : 'none';
        }
        const aBtn = document.getElementById('detailTypeAllBtn');
        const mBtn = document.getElementById('detailTypeMovieBtn');
        const sBtn = document.getElementById('detailTypeSeriesBtn');
        const isExternalProvider = isExternalHistory || (listUrl && (listUrl.includes('trakt:watchlist') || (listUrl.includes('trakt.tv/users/') && listUrl.includes('/watchlist')) || listUrl.includes('mdblist:watchlist')));
        if (canShowLineup && !channelHasBothTypes) {
          // One kind of thing in this channel, so Movies and Shows would be
          // two pills showing the same list. All stays: it is the whole
          // channel, and the way back from On Today.
          const curFilter = window._currentListDetailsFilter || 'all';
          if (aBtn) {
            aBtn.style.display = '';
            aBtn.classList.toggle('active', curFilter !== 'lineup');
          }
          if (mBtn) mBtn.style.display = 'none';
          if (sBtn) sBtn.style.display = 'none';
        } else if (isDualTypeChart && !isExternalProvider) {
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

  if (isLocalWatchHistory) {
    if (likeBtn) likeBtn.style.display = 'none';
    if (addBtn) addBtn.style.display = 'none';
    const localMap = (typeof loadLocalCustomLists === 'function') ? loadLocalCustomLists() : {};
    const hist = localMap['watch-history'];
    window._rawWatchHistoryItems = (hist && Array.isArray(hist.items)) ? hist.items : [];
    renderWatchHistoryGrid();
    return;
  }

  if (likeBtn) {
    // Watchlist/History/Airing-Next/a connected account's own Simkl or
    // Trakt list resolve to a DIFFERENT real list depending on who's
    // viewing (they're session/account-relative, not a fixed shared
    // list), so there's no one thing a like could mean -- excluded here
    // for the same reason the server's own sentinel allowlist
    // (normalizeExternalListUrl, 02_http-and-creator-utils.js) never
    // accepts them either, rather than showing a button that can only
    // ever fail.
    const isPersonalSentinel = listUrl && (
      listUrl.startsWith('mdblist:watchlist') || listUrl.startsWith('mdblist:history') || listUrl.startsWith('mdblist:airing-next') || listUrl.startsWith('mdblist:upnext') ||
      listUrl.startsWith('trakt:watchlist') || listUrl.startsWith('trakt:history') || listUrl.startsWith('trakt:airing-next') || listUrl.startsWith('trakt:continue-watching') ||
      listUrl.startsWith('trakt:user:') || listUrl.startsWith('mdblist:user:')
    );
    // A channel published to Explore Channels IS likeable -- the directory's
    // own cards have had a heart all along -- but by its published code
    // against /api/channel/like, not by a list URL against the list ledger.
    // That is why the channel: exclusion below is right and the button was
    // still missing here: there was no channel-flavoured branch to fall into.
    // Only a channel opened FROM the directory has a code; one of your own
    // saved channels has nothing published to like.
    const channelLikeCode = (opts && opts.channelLikeCode) || '';
    if (channelLikeCode) {
      const chLiked = typeof _channelDirectoryLiked !== 'undefined' && !!_channelDirectoryLiked[channelLikeCode];
      likeBtn.style.display = '';
      // Cleared, not left stale: the delegated .searchLikeExternalBtn handler
      // (19_client-search-and-likes.js) acts on dataset.url and returns early
      // without one, so this button reaches only the channel path below --
      // the same arrangement the directory's own hearts already use.
      delete likeBtn.dataset.url;
      likeBtn.dataset.channelLikeCode = channelLikeCode;
      likeBtn.setAttribute('aria-label', 'Like this channel');
      likeBtn.title = 'Like this channel';
      likeBtn.classList.toggle('liked', chLiked);
      likeBtn.innerHTML = chLiked ? '&#9829;' : '&#9825;';
      likeBtn.onclick = function() {
        if (typeof toggleChannelDirectoryLike === 'function') toggleChannelDirectoryLike(channelLikeCode, likeBtn);
      };
    } else if (listUrl && !isNoLikesList && !isPersonalSentinel && !listUrl.startsWith('custom:') && !listUrl.startsWith('channel:') && !listUrl.startsWith('channel:v1:') && !listUrl.startsWith('autotrack:') && !listUrl.startsWith('simkl:user:')) {
      const isLiked = getLikedListsSet().has(listUrl);
      likeBtn.style.display = '';
      likeBtn.dataset.url = listUrl;
      delete likeBtn.dataset.channelLikeCode;
      likeBtn.onclick = null;
      likeBtn.setAttribute('aria-label', 'Like this list');
      likeBtn.title = 'Like this list';
      likeBtn.classList.toggle('liked', isLiked);
      likeBtn.innerHTML = isLiked ? '&#9829;' : '&#9825;';
    } else {
      likeBtn.style.display = 'none';
      delete likeBtn.dataset.channelLikeCode;
      likeBtn.onclick = null;
    }
  }

  addBtn.onclick = function() {
    if (storylineEventId) {
      if (typeof createInstantStorylineChannel === 'function') {
        createInstantStorylineChannel(storylineEventId, addBtn);
      }
      return;
    }
    const isAdded = typeof isListAddedToConfig === 'function' ? (isListAddedToConfig(listUrl, type) || isListAddedToConfig(null, type, listUrl) || isListAddedToConfig(listUrl, 'movie') || isListAddedToConfig(listUrl, 'series') || isListAddedToConfig(listUrl)) : false;
    if (isAdded) {
      if (typeof removeListFromConfig === 'function') {
        removeListFromConfig(listUrl, type);
        removeListFromConfig(listUrl, 'movie');
        removeListFromConfig(listUrl, 'series');
        removeListFromConfig(listUrl, 'mixed');
        removeListFromConfig(listUrl);
        removeListFromConfig(null, type, listUrl);
      }
      updateDetailAddBtn();
      if (typeof updateAllListAddButtons === 'function') updateAllListAddButtons();
      showAddedToast('Removed "' + (name || 'List') + '" from your Catalogs.');
    } else {
      let slug = '';
      if (listUrl) {
        if (listUrl.startsWith('autotrack:')) slug = listUrl.split(':')[1] || '';
        else if (listUrl.startsWith('custom:') && !listUrl.startsWith('custom:curated:')) slug = listUrl.slice('custom:'.length);
      }
      if (!slug && !listUrl && (name && (name.toLowerCase() === 'continue watching' || name.toLowerCase() === 'watch history' || name.toLowerCase() === 'watchlist'))) {
        slug = name.toLowerCase().replace(' ', '-');
      }

      if (slug === 'continue-watching' || slug === 'watch-history' || slug === 'watchlist') {
        const localMap = (typeof loadLocalCustomLists === 'function') ? loadLocalCustomLists() : {};
        const listMeta = localMap[slug] || (typeof lastLocalCustomListsData !== 'undefined' && (lastLocalCustomListsData || []).find((l) => l.slug === slug)) || { name: name || slug, slug: slug, type: type || 'series', items: [] };
        const items = listMeta.items || [];
        const isMovieType = type === 'movie';
        const isSeriesType = type === 'series';

        if (listMeta.type === 'mixed' || slug === 'watch-history' || slug === 'continue-watching' || slug === 'watchlist') {
          const movies = [];
          const series = [];
          items.forEach((it) => {
            const isMovie = it.kind === 'movie' || it.type === 'movie';
            const mapped = {
              imdbId: isMovie ? (it.imdbId || it.id) : (it.showId || it.imdbId || it.id),
              title: isMovie ? (it.title || it.name) : (it.showTitle || it.title || it.name),
              poster: isMovie ? it.poster : (it.showPoster || it.poster),
              year: it.year,
            };
            if (isMovie) {
              movies.push(mapped);
            } else {
              if (!series.some((s) => s.imdbId === mapped.imdbId)) {
                series.push(mapped);
              }
            }
          });

          if (isMovieType || (!isSeriesType && movies.length > 0)) {
            const url = (typeof activeCreator !== 'undefined' && activeCreator && (slug === 'watch-history' || slug === 'continue-watching'))
              ? 'autotrack:' + slug + ':movie:' + activeCreator.creatorName
              : 'customlist:v1:' + JSON.stringify({ listId: generateChannelId(), localSlug: slug, type: 'movie', items: movies, shuffle: false });
            addRow(listMeta.name + ((!isMovieType && series.length > 0) ? ' (Movies)' : ''), url, 'movie', true, 'My Lists');
          }
          if (isSeriesType || (!isMovieType && (series.length > 0 || movies.length === 0))) {
            const url = (typeof activeCreator !== 'undefined' && activeCreator && (slug === 'watch-history' || slug === 'continue-watching'))
              ? 'autotrack:' + slug + ':series:' + activeCreator.creatorName
              : 'customlist:v1:' + JSON.stringify({ listId: generateChannelId(), localSlug: slug, type: 'series', items: series, shuffle: false });
            addRow(listMeta.name + ((!isSeriesType && movies.length > 0) ? ' (Shows)' : ''), url, 'series', true, 'My Lists');
          }
        } else {
          const payload = { listId: generateChannelId(), localSlug: slug, type: listMeta.type || type || 'movie', items: items, shuffle: false };
          addRow(listMeta.name, 'customlist:v1:' + JSON.stringify(payload), listMeta.type || type || 'movie', true, 'My Lists');
        }
      } else if (slug && (typeof loadLocalCustomLists === 'function') && loadLocalCustomLists()[slug]) {
        const listMeta = loadLocalCustomLists()[slug];
        const payload = { listId: generateChannelId(), localSlug: slug, type: listMeta.type || type || 'movie', items: listMeta.items || [], shuffle: false };
        addRow(listMeta.name || name || 'Custom List', 'customlist:v1:' + JSON.stringify(payload), listMeta.type || type || 'movie', true, 'My Lists');
      } else if (slug && typeof lastCreatorListsData !== 'undefined' && Array.isArray(lastCreatorListsData) && lastCreatorListsData.find((l) => l.slug === slug)) {
        const listMeta = lastCreatorListsData.find((l) => l.slug === slug);
        const payload = { listId: generateChannelId(), listSlug: slug, type: listMeta.type || type || 'movie', items: listMeta.items || [], shuffle: false };
        addRow(listMeta.name || name || 'Custom List', 'customlist:v1:' + JSON.stringify(payload), listMeta.type || type || 'movie', true, 'Custom Lists');
      } else if (listUrl && listUrl.startsWith('custom:curated:')) {
        addRow(name || 'Curated List', listUrl, type, true, 'Curated');
      } else if (listUrl && (listUrl.startsWith('mylists:') || listUrl.startsWith('tmdb:new-on-streaming'))) {
        addRow(name || 'List', listUrl, type === 'series' ? 'series' : 'movie', true, 'My Lists Addon Charts');
      } else if (listUrl && (listUrl.startsWith('tmdb:chart:') || listUrl.startsWith('tmdb:') || listUrl.startsWith('autotrack:'))) {
        addRow(name || 'List', listUrl, type, true, 'New Releases');
      } else {
        if (type === 'mixed') {
          addRow((name || 'List') + ' (Movies)', listUrl, 'movie', true, 'Custom');
          addRow((name || 'List') + ' (Shows)', listUrl, 'series', true, 'Custom');
        } else {
          addRow(name || 'List', listUrl, type, true, 'Custom');
        }
      }
      updateDetailAddBtn();
      if (typeof updateAllListAddButtons === 'function') updateAllListAddButtons();
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
  // A source that doesn't actually honor skip (a malformed/misdetected
  // URL, or a provider whose pagination silently ignores an out-of-range
  // offset) can keep answering maybeMore:true with the exact same items
  // every time. Trusting that alone means this loop only stops at
  // MAX_PAGES * one page's worth of items (up to 2,000) of pure repeats of
  // a list that might only have a few hundred real items. Tracked
  // independent of the type-tab filter in appendItems below, by id, so a
  // page that comes back with zero items this loop hasn't already seen
  // stops pagination even if the server insists there's more.
  const seenItemIds = new Set();

  const isSimklUserList = listUrl && listUrl.startsWith('simkl:user:');
  const simklStatusMatch = isSimklUserList ? (listUrl.split(':')[3] || 'plantowatch') : '';

  const traktUser = (typeof traktUsername !== 'undefined' && traktUsername) || localStorage.getItem('myListAddon:traktUsername') || '';
  const isTraktWatchlist = !!(listUrl && traktUser && (listUrl === 'trakt:watchlist' || listUrl.toLowerCase().includes('trakt.tv/users/' + traktUser.toLowerCase() + '/watchlist')));
  const isTraktHistory = !!(listUrl && traktUser && (listUrl === 'trakt:history' || listUrl.toLowerCase().includes('trakt.tv/users/' + traktUser.toLowerCase() + '/history')));
  const isTraktUserList = !!(listUrl && traktUser && (listUrl.startsWith('trakt:user:') || listUrl.toLowerCase().includes('trakt.tv/users/' + traktUser.toLowerCase() + '/lists/')));
  const traktListSlug = isTraktUserList ? (listUrl.includes('/lists/') ? (listUrl.split('/lists/')[1] || '').split('/')[0] : (listUrl.split(':')[3] || '')) : '';

  const tmdbAcc = (typeof tmdbAccountId !== 'undefined' && tmdbAccountId) || localStorage.getItem('myListAddon:tmdbAccountId') || '';
  const isTmdbWatchlist = !!(listUrl && tmdbAcc && (listUrl === 'tmdb:watchlist' || listUrl.startsWith('tmdb:account:watchlist') || listUrl === 'tmdb:account:watchlist:movies' || listUrl === 'tmdb:account:watchlist:series'));
  const isTmdbFavorites = !!(listUrl && tmdbAcc && (listUrl === 'tmdb:favorites' || listUrl.startsWith('tmdb:account:favorites') || listUrl === 'tmdb:account:favorites:movies' || listUrl === 'tmdb:account:favorites:series'));
  const isTmdbUserList = !!(listUrl && tmdbAcc && (listUrl.includes('themoviedb.org/list/') || listUrl.startsWith('tmdb:list:')));
  const tmdbListId = isTmdbUserList ? (listUrl.match(new RegExp('list(?:/|:)([0-9]+)', 'i'))?.[1] || '') : '';

  const mdbUser = (typeof mdblistUsername !== 'undefined' && mdblistUsername) || localStorage.getItem('myListAddon:mdblistUsername') || '';
  const isMdbWatchlist = !!(listUrl && (listUrl === 'mdblist:watchlist' || (mdbUser && listUrl.toLowerCase().includes('mdblist.com/lists/' + mdbUser.toLowerCase() + '/watchlist'))));
  const isMdbHistory = !!(listUrl && (listUrl === 'mdblist:history' || listUrl.startsWith('mdblist:history') || listUrl.toLowerCase().includes('mdblist.com/history') || (listUrl.toLowerCase().includes('mdblist.com/lists/') && listUrl.toLowerCase().includes('/history'))));
  const isMdbUserList = !!(listUrl && mdbUser && !isMdbWatchlist && !isMdbHistory && !listUrl.toLowerCase().includes('mdblist.com/lists/official/') && (listUrl.toLowerCase().includes('mdblist.com/lists/' + mdbUser.toLowerCase() + '/') || listUrl.startsWith('mdblist:list:')));
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
    return it;
  }

  // Returns how many of the passed-in items weren't already in this
  // list-details view (by id) before appending -- loadNextPage uses this
  // to tell a genuine next page apart from a source repeating itself.
  // Preloaded/local sources (custom lists, autotrack, etc.) never call
  // loadNextPage at all (see its own early-return), so this only ever
  // runs against real paginated /api/preview results, which always carry
  // a stable id.
  function appendItems(items) {
    let newCount = 0;
    const freshItems = [];
    items.forEach((it) => {
      const key = it && (it.id != null ? String(it.id) : null);
      if (key === null || !seenItemIds.has(key)) {
        newCount++;
        if (key !== null) seenItemIds.add(key);
        freshItems.push(it);
      }
    });
    // Only genuinely new items ever reach the grid -- a page that repeats
    // an id already shown (a source that doesn't honor skip, say) used to
    // still get concatenated here even though the pagination-stop check
    // right below already knew it added nothing, so the same items could
    // render twice before the loop gave up.
    const annotated = freshItems.map(annotatePersonalItem);
    window._currentListDetailsAllItems = (window._currentListDetailsAllItems || []).concat(annotated);
    const curFilter = window._currentListDetailsFilter || 'all';
    // Filter just THIS page's new items, not the whole accumulated list --
    // switchListDetailsType's own full re-render already handles what's on
    // screen changing when the filter itself changes (see its "Instant
    // client filter" block); this only ever needs to decide whether the
    // items that just arrived belong on the currently-active tab.
    let newlyMatching = annotated;
    if (curFilter === 'movie') {
      newlyMatching = annotated.filter((it) => it.type === 'movie' || it.kind === 'movie' || (!it.showId && it.type !== 'series' && it.type !== 'tv' && it.type !== 'show' && it.type !== 'episode' && it.kind !== 'series' && it.kind !== 'tv'));
    } else if (curFilter === 'series') {
      newlyMatching = annotated.filter((it) => it.type === 'series' || it.type === 'tv' || it.type === 'show' || it.type === 'episode' || it.kind === 'series' || it.kind === 'tv' || !!it.showId || it.seasonNum != null);
    }
    newlyMatching.forEach(item => { item.listUrl = listUrl; item.listName = name; });
    // Append (not rebuild) -- see appendPosterGridItems's own comment for
    // why: this is the path a large Custom List, Watchlist, or paginated
    // chart takes as the user scrolls, and it used to tear down and
    // rebuild every already-rendered poster on every page that arrived.
    // On Today owns the grid, the status line and the subtitle while it is
    // the open tab, so a page that lands behind it is only accumulated --
    // All re-renders from the accumulated items the moment it is clicked.
    if (window._currentListDetailsFilter !== 'lineup') appendPosterGridItems(gridEl, newlyMatching);
    loadedCount = window._currentListDetailsAllItems.length;
    return newCount;
  }
  function updateStatusAfterPage(maybeMore, itemsThisPage) {
    const onLineup = window._currentListDetailsFilter === 'lineup';
    if (!maybeMore || itemsThisPage === 0 || pagesLoaded >= MAX_PAGES) {
      done = true;
      if (!onLineup) statusEl.innerHTML = loadedCount ? '' : '<small>No items found.</small>';
    } else if (!onLineup) {
      statusEl.innerHTML = '<small>Scroll for more\u2026</small>';
    }
    // Set before the subtitle is written, not after: the subtitle says "100+"
    // rather than "100" precisely when this is true.
    moreToLoad = !done;
    if (!onLineup) subEl.textContent = formatSubtitle(loadedCount);
  }
  // How All puts the list's own subtitle back after On Today borrowed it --
  // recomputed rather than restored from a string, so a count that grew while
  // On Today was open is still right.
  window._listDetailsSubtitleRefresh = function() {
    subEl.textContent = formatSubtitle(loadedCount);
  };

  async function loadNextPage() {
    if (loading || done) return;
    // Same reason as in appendItems: while On Today is the open tab the status
    // line is its, so a page loading behind it says nothing.
    const quiet = window._currentListDetailsFilter === 'lineup';
    if (!listUrl || listUrl.startsWith('custom:') || listUrl.startsWith('autotrack:')) {
      done = true;
      if (!quiet) statusEl.innerHTML = loadedCount ? '' : '<small>No items found.</small>';
      return;
    }
    loading = true;
    if (!quiet) statusEl.innerHTML = '<small>Loading\u2026</small>';
    try {
      const body = { url: listUrl, type: type, skip: skip, sample: 100 };
      if (keys.tmdbKey) body.tmdbKey = keys.tmdbKey;
      if (keys.mdblistKey) body.mdblistKey = keys.mdblistKey;
      if (keys.mdblistAccessToken) body.mdblistAccessToken = keys.mdblistAccessToken;
      if (keys.traktKey) body.traktKey = keys.traktKey;
      if (keys.traktAccessToken) {
        const isOwnList = !listUrl || listUrl.startsWith('trakt:') || (traktUser && listUrl.toLowerCase().includes('/users/' + traktUser.toLowerCase() + '/'));
        if (isOwnList) body.traktAccessToken = keys.traktAccessToken;
      }
      if (keys.simklKey) body.simklKey = keys.simklKey;
      if (keys.simklAccessToken) body.simklAccessToken = keys.simklAccessToken;
      if (creatorName) body.creatorName = creatorName;
      if (keys.adultContentFilter || (typeof isAdultContentFilterEnabled === 'function' && isAdultContentFilterEnabled())) body.adultContentFilter = true;
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
      const newCount = appendItems(items);
      skip += items.length;
      pagesLoaded++;
      // A page that came back non-empty but contributed nothing new (every
      // id was already in this view) means the source isn't actually
      // advancing with skip -- treat it as "no more", the same as an
      // empty page, rather than trusting maybeMore into fetching the same
      // content again up to MAX_PAGES.
      updateStatusAfterPage(data.maybeMore, newCount);
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
  // itemCount, not just the page-0 sample, so the header shows the list's
  // real size right away instead of the first page's length (100, if the
  // list has more) until scrolling has paged in the rest. The server
  // already knows this from the same /api/preview call that fetched
  // sample -- see /api/preview's own totalItems (25_api-catalog-routes.js).
  openListDetailsPage(shelf.name, shelf.type, shelf.url, { sample: shelf.sample, maybeMore: shelf.maybeMore, itemCount: shelf.totalItems });
}

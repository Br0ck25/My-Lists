// --- Channel builder ---------------------------------------------------------
//
// Builds one synthetic "series" out of hand-picked real episodes (from any
// shows) and/or whole movies. channelDraftItems holds the in-progress picks
// until "Save as a Channel" bundles them into one entry -- same shape a
// server-side channel payload needs (see parseChannelPayload/
// buildChannelMeta in the Worker): { kind: 'episode', imdbId, season,
// episode, title, released, thumbnail } or { kind: 'movie', imdbId, title,
// year, thumbnail }.
let channelDraftItems = [];
let channelDraftPoster = null;

async function runChannelTitleSearch() {
  const q = document.getElementById('channelSearchInput').value.trim();
  const box = document.getElementById('channelSearchResult');
  document.getElementById('channelEpisodePicker').innerHTML = '';
  if (!q) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = '<p><small>Searching\u2026</small></p>';
  try {
    const res = await fetch(ORIGIN + '/api/title-search?q=' + encodeURIComponent(q) + '&type=tv', { cache: 'no-store' });
    const data = await res.json();
    if (!data.ok) {
      box.innerHTML = '<p class="testresult err">\u2717 ' + escapeHtml(data.error || 'Search failed.') + '</p>';
      return;
    }
    renderChannelTitleResults(data.results);
  } catch (e) {
    box.innerHTML = '<p class="testresult err">\u2717 Network error while searching.</p>';
  }
}

function renderChannelTitleResults(results) {
  const box = document.getElementById('channelSearchResult');
  if (!results.length) {
    box.innerHTML = '<p><small>No matches.</small></p>';
    return;
  }
  box.innerHTML = results.map((r) => {
    const label = r.year ? escapeHtml(r.title) + ' (' + escapeHtml(r.year) + ')' : escapeHtml(r.title);
    const posterImg = r.poster
      ? '<img class="preview-thumb" src="' + escapeAttr(r.poster) + '" alt="" loading="lazy">'
      : '';
    return '<div class="row searchresult-row">' +
      '<div style="display:flex; gap:10px; align-items:center;">' + posterImg + '<strong>' + label + '</strong></div>' +
      '<button type="button" class="secondary channelTitleBtn"' +
      ' data-tmdbid="' + r.tmdbId + '"' +
      ' data-title="' + escapeAttr(r.title) + '" data-poster="' + escapeAttr(r.poster || '') + '">+ Browse episodes</button>' +
      '</div>';
  }).join('');
}

document.getElementById('channelSearchResult').addEventListener('click', (e) => {
  const btn = e.target.closest('.channelTitleBtn');
  if (!btn) return;
  browseChannelShow(btn.dataset.tmdbid, btn.dataset.title, btn.dataset.poster);
});

async function browseChannelShow(tmdbId, showName, showPoster) {
  const box = document.getElementById('channelEpisodePicker');
  box.innerHTML = '<p><small>Loading seasons\u2026</small></p>';
  try {
    const res = await fetch(ORIGIN + '/api/show-seasons?tmdbId=' + encodeURIComponent(tmdbId), { cache: 'no-store' });
    const data = await res.json();
    if (!data.ok) {
      box.innerHTML = '<p class="testresult err">\u2717 ' + escapeHtml(data.error || 'Could not load seasons.') + '</p>';
      return;
    }
    const poster = data.poster || showPoster || '';
    const seasonNumbers = data.seasons.map((s) => s.season).join(',');
    const seasonButtons = data.seasons.map((s) =>
      '<button type="button" class="secondary channelSeasonBtn"' +
      ' data-tmdbid="' + tmdbId + '" data-imdbid="' + escapeAttr(data.imdbId) + '"' +
      ' data-showname="' + escapeAttr(showName) + '" data-poster="' + escapeAttr(poster) + '"' +
      ' data-season="' + s.season + '">' +
      escapeHtml(s.name || ('Season ' + s.season)) + ' (' + s.episodeCount + ')</button>'
    ).join(' ');
    box.innerHTML = '<p><small>Pick a season of <strong>' + escapeHtml(showName) + '</strong>, or:</small></p>' +
      '<div class="actions" style="flex-wrap:wrap; margin-bottom:10px;">' +
      '<button type="button" class="secondary channelAddAllSeasonsBtn"' +
      ' data-tmdbid="' + tmdbId + '" data-imdbid="' + escapeAttr(data.imdbId) + '"' +
      ' data-showname="' + escapeAttr(showName) + '" data-poster="' + escapeAttr(poster) + '"' +
      ' data-seasons="' + seasonNumbers + '">Add every season (all episodes)</button>' +
      '</div>' +
      '<div class="actions" style="flex-wrap:wrap;">' + seasonButtons + '</div>' +
      '<div id="channelEpisodeList"></div>';
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    box.innerHTML = '<p class="testresult err">\u2717 Network error loading seasons.</p>';
  }
}

document.getElementById('channelEpisodePicker').addEventListener('click', (e) => {
  const seasonBtn = e.target.closest('.channelSeasonBtn');
  if (seasonBtn) {
    loadChannelSeasonEpisodes(
      seasonBtn.dataset.tmdbid, seasonBtn.dataset.imdbid, seasonBtn.dataset.showname,
      seasonBtn.dataset.poster, seasonBtn.dataset.season
    );
    return;
  }
  const addAllSeasonsBtn = e.target.closest('.channelAddAllSeasonsBtn');
  if (addAllSeasonsBtn) {
    addAllSeasonsToChannel(
      addAllSeasonsBtn.dataset.tmdbid, addAllSeasonsBtn.dataset.imdbid, addAllSeasonsBtn.dataset.showname,
      addAllSeasonsBtn.dataset.poster, addAllSeasonsBtn.dataset.seasons, addAllSeasonsBtn
    );
    return;
  }
  const addAllBtn = e.target.closest('.channelAddAllEpisodesBtn');
  if (addAllBtn) {
    addAllEpisodesToChannel(addAllBtn.dataset.imdbid, addAllBtn.dataset.showname, addAllBtn.dataset.poster);
    return;
  }
  const addBtn = e.target.closest('.channelAddEpisodesBtn');
  if (addBtn) {
    addCheckedEpisodesToChannel(addBtn.dataset.imdbid, addBtn.dataset.showname, addBtn.dataset.poster);
  }
});

// Fetches every season's episode list (in parallel -- server-cached anyway,
// see /api/show-episodes) and adds all of them in original broadcast order,
// for "just give me the whole show" instead of clicking through season by
// season.
async function addAllSeasonsToChannel(tmdbId, imdbId, showName, showPoster, seasonsCsv, btn) {
  const seasons = String(seasonsCsv || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!seasons.length) return;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Adding every season\u2026';
  }
  try {
    const results = await Promise.all(seasons.map((season) =>
      fetch(ORIGIN + '/api/show-episodes?tmdbId=' + encodeURIComponent(tmdbId) + '&season=' + encodeURIComponent(season), { cache: 'no-store' })
        .then((res) => res.json())
        .then((data) => ({ season: parseInt(season, 10), episodes: data.ok ? data.episodes : [] }))
        .catch(() => ({ season: parseInt(season, 10), episodes: [] }))
    ));
    const showEpisodes = [];
    results
      .sort((a, b) => a.season - b.season)
      .forEach(({ season, episodes }) => {
        episodes.forEach((ep) => {
          showEpisodes.push({
            kind: 'episode',
            imdbId: imdbId,
            season: season,
            episode: ep.episode,
            title: (showName ? showName + ' S' + season + 'E' + ep.episode + ' \u2014 ' : '') + (ep.name || ('Episode ' + ep.episode)),
            released: ep.released,
            thumbnail: ep.thumbnail || showPoster,
          });
        });
      });
    // Same safety caps as Quick Add Channel -- a single long-running show
    // (soap, game show, talk show, news magazine) can have thousands of
    // episodes, which is exactly what crashed Stremio the last time this
    // wasn't capped.
    let finalEpisodes = showEpisodes.length > CHANNEL_MAX_EPISODES_PER_SHOW
      ? showEpisodes.slice(-CHANNEL_MAX_EPISODES_PER_SHOW)
      : showEpisodes;
    const trimmedForShowLength = finalEpisodes.length < showEpisodes.length;
    const remainingBudget = CHANNEL_MAX_TOTAL_ITEMS - channelDraftItems.length;
    const trimmedForTotalBudget = finalEpisodes.length > remainingBudget;
    if (trimmedForTotalBudget) finalEpisodes = finalEpisodes.slice(0, Math.max(0, remainingBudget));
    finalEpisodes.forEach((it) => channelDraftItems.push(it));
    if (!channelDraftPoster) channelDraftPoster = showPoster || null;
    renderChannelDraftList();
    if (btn) {
      let label = 'Added ' + finalEpisodes.length + ' episodes \u2713';
      if (trimmedForShowLength) label = 'Added most recent ' + CHANNEL_MAX_EPISODES_PER_SHOW + ' episodes \u2713';
      if (trimmedForTotalBudget) label = 'Added ' + finalEpisodes.length + ' (channel size limit reached)';
      btn.textContent = label;
    }
  } catch (e) {
    alert('Something went wrong adding every season -- try again, or add seasons one at a time.');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Add every season (all episodes)';
    }
  }
}

async function loadChannelSeasonEpisodes(tmdbId, imdbId, showName, showPoster, season) {
  const listBox = document.getElementById('channelEpisodeList');
  if (!listBox) return;
  listBox.innerHTML = '<p><small>Loading episodes\u2026</small></p>';
  try {
    const res = await fetch(
      ORIGIN + '/api/show-episodes?tmdbId=' + encodeURIComponent(tmdbId) + '&season=' + encodeURIComponent(season),
      { cache: 'no-store' }
    );
    const data = await res.json();
    if (!data.ok) {
      listBox.innerHTML = '<p class="testresult err">\u2717 ' + escapeHtml(data.error || 'Could not load episodes.') + '</p>';
      return;
    }
    const rows = data.episodes.map((ep) => {
      const epJson = escapeAttr(JSON.stringify({
        season: parseInt(season, 10), episode: ep.episode, title: ep.name, released: ep.released, thumbnail: ep.thumbnail,
      }));
      return '<label class="row quick-row" style="cursor:pointer;">' +
        '<span><input type="checkbox" class="channelEpisodeCheck" data-ep="' + epJson + '"> ' +
        'S' + season + 'E' + ep.episode + ' \u2014 ' + escapeHtml(ep.name || '') + '</span>' +
        '</label>';
    }).join('');
    listBox.innerHTML = rows +
      '<div class="actions" style="margin-top:8px;">' +
      '<button type="button" class="secondary channelAddEpisodesBtn"' +
      ' data-imdbid="' + escapeAttr(imdbId) + '" data-showname="' + escapeAttr(showName) + '"' +
      ' data-poster="' + escapeAttr(showPoster) + '">Add checked episodes</button>' +
      '<button type="button" class="secondary channelAddAllEpisodesBtn"' +
      ' data-imdbid="' + escapeAttr(imdbId) + '" data-showname="' + escapeAttr(showName) + '"' +
      ' data-poster="' + escapeAttr(showPoster) + '">Add all episodes</button>' +
      '</div>';
    listBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    listBox.innerHTML = '<p class="testresult err">\u2717 Network error loading episodes.</p>';
  }
}

function addCheckedEpisodesToChannel(imdbId, showName, showPoster) {
  const checks = document.querySelectorAll('#channelEpisodeList .channelEpisodeCheck:checked');
  if (!checks.length) {
    alert('Check at least one episode first.');
    return;
  }
  checks.forEach((cb) => {
    let ep;
    try {
      ep = JSON.parse(cb.dataset.ep);
    } catch (e) {
      return;
    }
    channelDraftItems.push({
      kind: 'episode',
      imdbId: imdbId,
      season: ep.season,
      episode: ep.episode,
      title: (showName ? showName + ' S' + ep.season + 'E' + ep.episode + ' \u2014 ' : '') + (ep.title || ('Episode ' + ep.episode)),
      released: ep.released,
      thumbnail: ep.thumbnail || showPoster,
    });
  });
  if (!channelDraftPoster) channelDraftPoster = showPoster || null;
  renderChannelDraftList();
}

// Checks every episode box for the currently-loaded season, then reuses
// addCheckedEpisodesToChannel above rather than duplicating its logic.
function addAllEpisodesToChannel(imdbId, showName, showPoster) {
  document.querySelectorAll('#channelEpisodeList .channelEpisodeCheck').forEach((cb) => {
    cb.checked = true;
  });
  addCheckedEpisodesToChannel(imdbId, showName, showPoster);
}

function renderChannelDraftList() {
  const box = document.getElementById('channelDraftList');
  const badge = document.getElementById('channelDraftCountBadge');
  if (badge) badge.textContent = channelDraftItems.length ? '(' + channelDraftItems.length + ' picked)' : '';
  const picksBadge = document.getElementById('channelDraftPicksCountBadge');
  if (picksBadge) picksBadge.textContent = channelDraftItems.length ? '(' + channelDraftItems.length + ')' : '';
  if (!channelDraftItems.length) {
    box.innerHTML = '<p><small>Nothing added yet -- search above to get started.</small></p>';
    return;
  }
  box.innerHTML = channelDraftItems.map((it, i) => {
    const label = it.kind === 'movie'
      ? escapeHtml(it.title) + (it.year ? ' (' + escapeHtml(it.year) + ')' : '') + ' \u2014 Movie'
      : escapeHtml(it.title) + ' \u2014 S' + it.season + 'E' + it.episode;
    return '<div class="row quick-row channel-pick" data-idx="' + i + '" style="align-items:center; flex-wrap:nowrap;">' +
      '<span class="drag-handle" draggable="true" style="cursor:grab; touch-action:none; padding:6px;">\u2630</span>' +
      '<input type="number" class="pos channelPosInput" min="1" max="' + channelDraftItems.length + '" value="' + (i + 1) + '" style="width:60px; flex:none;" title="Type a position to move this pick there">' +
      '<span style="flex:1;">' + label + '</span>' +
      '<button type="button" class="movebtn secondary channelMoveBtn" data-dir="-1"' + (i === 0 ? ' disabled' : '') + '>\u2191</button>' +
      '<button type="button" class="movebtn secondary channelMoveBtn" data-dir="1"' + (i === channelDraftItems.length - 1 ? ' disabled' : '') + '>\u2193</button>' +
      '<button type="button" class="secondary channelRemovePickBtn">Remove</button>' +
      '</div>';
  }).join('');
  document.querySelectorAll('#channelDraftList .drag-handle').forEach((h) => initChannelTouchDrag(h));
}

// A channel built from a whole show (or several) can easily run into the
// hundreds of picks -- letting someone clear the slate in one click beats
// hitting Remove hundreds of times to start over.
function removeAllChannelDraftPicks() {
  if (!channelDraftItems.length) return;
  if (!confirm('Remove all ' + channelDraftItems.length + ' picks? This can\\'t be undone.')) return;
  channelDraftItems = [];
  renderChannelDraftList();
}

document.getElementById('channelDraftList').addEventListener('click', (e) => {
  const removeBtn = e.target.closest('.channelRemovePickBtn');
  if (removeBtn) {
    const row = removeBtn.closest('.channel-pick');
    const idx = parseInt(row.dataset.idx, 10);
    channelDraftItems.splice(idx, 1);
    renderChannelDraftList();
    return;
  }
  const moveBtn = e.target.closest('.channelMoveBtn');
  if (moveBtn) {
    const row = moveBtn.closest('.channel-pick');
    const idx = parseInt(row.dataset.idx, 10);
    const swapWith = idx + parseInt(moveBtn.dataset.dir, 10);
    if (swapWith < 0 || swapWith >= channelDraftItems.length) return;
    const tmp = channelDraftItems[idx];
    channelDraftItems[idx] = channelDraftItems[swapWith];
    channelDraftItems[swapWith] = tmp;
    renderChannelDraftList();
  }
});

// Lets someone type a new position directly into a pick's number box
// instead of clicking the up arrow repeatedly -- same idea as
// movePosTo()/the Custom List draft's own position input, adapted for
// this array-backed draft.
document.getElementById('channelDraftList').addEventListener('change', (e) => {
  const posInput = e.target.closest('.channelPosInput');
  if (!posInput) return;
  const row = posInput.closest('.channel-pick');
  const from = parseInt(row.dataset.idx, 10);
  const typed = parseInt(posInput.value, 10);
  if (!typed || isNaN(typed)) {
    renderChannelDraftList();
    return;
  }
  const to = Math.min(Math.max(typed, 1), channelDraftItems.length) - 1;
  if (to === from) {
    renderChannelDraftList();
    return;
  }
  const [item] = channelDraftItems.splice(from, 1);
  channelDraftItems.splice(to, 0, item);
  renderChannelDraftList();
});

// Mouse drag-and-drop -- same live-DOM-reorder-then-read-back-order
// technique the Custom List draft's own drag uses (see
// reorderCustomListDraftFromDom's own comment for the full rationale),
// adapted for channelDraftItems/.channel-pick instead.
let channelDragRow = null;

document.getElementById('channelDraftList').addEventListener('dragstart', (e) => {
  const handle = e.target.closest('.drag-handle');
  if (!handle) { e.preventDefault(); return; }
  channelDragRow = handle.closest('.channel-pick');
  channelDragRow.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
});

document.getElementById('channelDraftList').addEventListener('dragend', () => {
  if (channelDragRow) channelDragRow.classList.remove('dragging');
  channelDragRow = null;
  reorderChannelDraftFromDom();
});

document.getElementById('channelDraftList').addEventListener('dragover', (e) => {
  if (!channelDragRow) return;
  e.preventDefault();
  const container = document.getElementById('channelDraftList');
  const afterEl = getChannelDragAfterElement(container, e.clientY);
  if (afterEl == null) {
    container.appendChild(channelDragRow);
  } else if (afterEl !== channelDragRow) {
    container.insertBefore(channelDragRow, afterEl);
  }
});

function getChannelDragAfterElement(container, y) {
  const els = [...container.querySelectorAll('.channel-pick:not(.dragging)')];
  return els.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) {
      return { offset: offset, element: child };
    }
    return closest;
  }, { offset: -Infinity, element: null }).element;
}

function reorderChannelDraftFromDom() {
  const container = document.getElementById('channelDraftList');
  const rows = [...container.querySelectorAll('.channel-pick')];
  channelDraftItems = rows.map((row) => channelDraftItems[parseInt(row.dataset.idx, 10)]);
  renderChannelDraftList();
}

// Touch/pen drag-to-reorder -- native HTML5 drag-and-drop above generally
// doesn't fire on touch devices at all; the \u2191/\u2193 buttons and
// editable position number both still work fine on touch regardless.
let channelTouchDragRow = null;

function initChannelTouchDrag(handle) {
  if (!handle) return;
  handle.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
    e.preventDefault();
    channelTouchDragRow = handle.closest('.channel-pick');
    channelTouchDragRow.classList.add('dragging');
    try { handle.setPointerCapture(e.pointerId); } catch (err) {}
    document.addEventListener('pointermove', onChannelTouchDragMove);
    document.addEventListener('pointerup', onChannelTouchDragEnd, { once: true });
    document.addEventListener('pointercancel', onChannelTouchDragEnd, { once: true });
  });
}

function onChannelTouchDragMove(e) {
  if (!channelTouchDragRow) return;
  const container = document.getElementById('channelDraftList');
  const afterEl = getChannelDragAfterElement(container, e.clientY);
  if (afterEl == null) {
    container.appendChild(channelTouchDragRow);
  } else if (afterEl !== channelTouchDragRow) {
    container.insertBefore(channelTouchDragRow, afterEl);
  }
}

function onChannelTouchDragEnd() {
  document.removeEventListener('pointermove', onChannelTouchDragMove);
  if (channelTouchDragRow) channelTouchDragRow.classList.remove('dragging');
  channelTouchDragRow = null;
  reorderChannelDraftFromDom();
}

// One-time shuffle of the picks *while building* -- separate from the
// "Randomize play order" checkbox below, which reshuffles the saved
// channel itself once a day. This one just saves having to drag everything
// into a random order by hand before saving.
function shuffleChannelDraft() {
  if (channelDraftItems.length < 2) return;
  for (let i = channelDraftItems.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = channelDraftItems[i];
    channelDraftItems[i] = channelDraftItems[j];
    channelDraftItems[j] = tmp;
  }
  renderChannelDraftList();
}

// Set by editChannel below while an existing channel's picks are loaded
// into the draft for editing; null means "Save" creates a brand new
// channel, same as always.
let editingChannelUrlInput = null;

function saveChannel() {
  const nameInput = document.getElementById('channelNameInput');
  const name = nameInput.value.trim();
  if (!name) {
    alert('Name this channel first.');
    return;
  }
  if (!channelDraftItems.length) {
    alert('Add at least one episode or movie first.');
    return;
  }
  const poster = channelDraftPoster || (channelDraftItems[0] && channelDraftItems[0].thumbnail) || null;
  const shuffle = document.getElementById('channelRandomizeCheck').checked;

  if (editingChannelUrlInput) {
    // Update in place: reuse the channel's existing channelId so any
    // merged siblings (see mergeChannelsIntoRow) and its own already-
    // generated meta id keep resolving to the same channel, just with
    // fresh contents.
    const oldPayload = parseChannelPayloadClient(editingChannelUrlInput.value) || {};
    const channelId = oldPayload.channelId || generateChannelId();
    const payload = { channelId: channelId, name: name, poster: poster, items: channelDraftItems, shuffle: shuffle };
    const newUrl = 'channel:v1:' + JSON.stringify(payload);
    const sourceRow = editingChannelUrlInput.closest('.source-row');
    if (sourceRow) sourceRow.outerHTML = channelSourceRowHtml(newUrl);
    // A row holding just this one channel also uses its own name as the
    // row's name -- keep those in sync. A merged row's name is the shared
    // shelf name instead, so that's left alone.
    const rowDiv = editingChannelUrlInput.closest('.entry');
    if (rowDiv && rowDiv.querySelectorAll('.url').length === 1) {
      const rowNameInput = rowDiv.querySelector('.name');
      if (rowNameInput) rowNameInput.value = name;
    }
    editingChannelUrlInput = null;
    renumber();
    checkAllDuplicateUrls();
    saveState();
    alert('Channel "' + name + '" updated.');
  } else {
    // channelId AND name are both embedded in the payload itself (not just
    // the row's own id/name) so this channel keeps its own identity even if
    // it's later merged with other channels into one row -- see
    // mergeChannelsIntoRow, where multiple channel payloads get newline-
    // joined into a single entry's url and fetched independently server-
    // side. In that context there's no single "entry.id"/"entry.name" to
    // fall back on for any individual channel -- only the merged row's own,
    // which every channel in it would otherwise incorrectly share.
    const channelId = generateChannelId();
    const payload = { channelId: channelId, name: name, poster: poster, items: channelDraftItems, shuffle: shuffle };
    addRow(name, 'channel:v1:' + JSON.stringify(payload), 'series', true, 'Channels', channelId);
    alert('Channel "' + name + '" added to your list below.');
  }

  channelDraftItems = [];
  channelDraftPoster = null;
  nameInput.value = '';
  document.getElementById('channelRandomizeCheck').checked = false;
  document.getElementById('channelSearchInput').value = '';
  document.getElementById('channelSearchResult').innerHTML = '';
  document.getElementById('channelEpisodePicker').innerHTML = '';
  renderChannelDraftList();
  renderChannelMergeList();
  updateChannelSaveButtonLabel();
}

// Loads an existing channel's picks back into the draft picker so they can
// be adjusted and saved back over the same channel, instead of needing to
// delete and rebuild it from scratch.
function editChannel(btnOrRow) {
  const sourceRow = btnOrRow.closest ? btnOrRow.closest('.source-row') || btnOrRow : btnOrRow;
  const urlInput = sourceRow && sourceRow.querySelector('.url');
  if (!urlInput) {
    alert('Could not read this channel to edit it.');
    return;
  }
  const payload = parseChannelPayloadClient(urlInput.value);
  if (!payload) {
    alert('Could not read this channel to edit it.');
    return;
  }
  channelDraftItems = (payload.items || []).slice();
  channelDraftPoster = payload.poster || null;
  document.getElementById('channelNameInput').value = payload.name || '';
  document.getElementById('channelRandomizeCheck').checked = !!payload.shuffle;
  editingChannelUrlInput = urlInput;
  renderChannelDraftList();
  updateChannelSaveButtonLabel();
  
  const picksDetails = document.getElementById('channelDraftPicksDetails');
  if (picksDetails) picksDetails.open = false;

  window.scrollTo({ top: document.getElementById('catalogsSubChannels').offsetTop - 20, behavior: 'smooth' });
  const searchInput = document.getElementById('channelSearchInput');
  if (searchInput) searchInput.focus();
}

function renderMyCreatedChannelsList() {
  const box = document.getElementById('myCreatedChannelsList');
  if (!box) return;
  const rows = [...document.querySelectorAll('#lists .entry')].filter((div) =>
    [...div.querySelectorAll('.url')].some((el) => el.value.trim().startsWith('channel:v1:'))
  );
  if (!rows.length) {
    box.innerHTML = '<p><small>No created channels yet.</small></p>';
    return;
  }
  box.innerHTML = rows.map((div, i) => {
    const nameEl = div.querySelector('.name');
    const name = (nameEl && nameEl.value.trim()) || 'Untitled channel';
    const channelCount = [...div.querySelectorAll('.url')].filter((el) => el.value.trim().startsWith('channel:v1:')).length;
    const label = channelCount > 1
      ? escapeHtml(name) + ' (Combined: ' + channelCount + ' channels)'
      : escapeHtml(name);
    
    // We assign an ID to the row so we can reliably find it when Edit or Delete is clicked
    if (!div.id) div.id = 'channel-row-' + i + '-' + Date.now();
    
    return '<div class="row quick-row" style="display:flex; justify-content:space-between; align-items:center;">' +
      '<div style="font-weight:600; font-size:0.9rem; flex:1;">' + label + '</div>' +
      '<div class="actions" style="flex-wrap:nowrap; gap:8px;">' +
        '<button type="button" class="lc-btn secondary" style="padding:6px 12px; font-size:0.8rem;" onclick="editChannel(document.getElementById(&quot;' + div.id + '&quot;).querySelector(&quot;.source-row&quot;))">Edit</button>' +
        '<button type="button" class="lc-btn secondary" style="padding:6px 12px; font-size:0.8rem; color:var(--red);" onclick="document.getElementById(&quot;' + div.id + '&quot;).remove(); saveState(); renderMyCreatedChannelsList(); renderChannelMergeList();">Delete</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function cancelEditChannel() {
  editingChannelUrlInput = null;
  channelDraftItems = [];
  channelDraftPoster = null;
  document.getElementById('channelNameInput').value = '';
  document.getElementById('channelRandomizeCheck').checked = false;
  renderChannelDraftList();
  updateChannelSaveButtonLabel();
  const picksDetails = document.getElementById('channelDraftPicksDetails');
  if (picksDetails) picksDetails.open = true;
}

// Swaps the Save button's label/behavior hint between "new channel" and
// "updating an existing one", and shows/hides the Cancel-edit button next
// to it, so it's obvious which mode the picker is in.
function updateChannelSaveButtonLabel() {
  const saveBtn = document.getElementById('channelSaveBtn');
  const cancelBtn = document.getElementById('channelCancelEditBtn');
  if (!saveBtn) return;
  if (editingChannelUrlInput) {
    saveBtn.textContent = 'Save changes to this Channel';
    if (cancelBtn) cancelBtn.style.display = '';  } else {
    saveBtn.textContent = 'Save as a Channel';
    if (cancelBtn) cancelBtn.style.display = 'none';
  }
}

document.querySelectorAll('.channelQuickAddBtn').forEach((btn) => {
  btn.addEventListener('click', () => quickAddChannel(btn.dataset.name, btn.dataset.listurl || null, btn.dataset.networkid || null, btn));
});

// Builds a whole channel automatically from either a curated mdblist.com
// show list or a TMDB network id directly: resolves every show to TMDB
// (one request, server-side -- see /api/quick-channel-shows), then walks
// each show's seasons/episodes via the same /api/show-seasons +
// /api/show-episodes endpoints the manual picker uses. Deliberately
// sequential across shows (one at a time, each show's own seasons fetched
// in parallel) rather than firing everything at once -- slower, but keeps
// a live "show 4 of 18" status line honest and avoids hammering either
// this Worker or TMDB with a burst of concurrent requests for a large
// lineup.
// Stremio has been observed to crash outright on a channel with 100,000+
// episodes -- a full network lineup list can include a handful of decades-
// long-running game shows, talk shows, or soaps that alone contribute
// thousands of episodes each, and nothing here was capping that. These two
// limits keep any single show from dominating a channel, and keep the
// channel's overall size well under whatever broke last time, with a
// comfortable safety margin.
const CHANNEL_MAX_EPISODES_PER_SHOW = 50;
const CHANNEL_MAX_TOTAL_ITEMS = 2000;
// Quick Add Channel (network-id based) stores a bigger pool than what's
// ever shown and marks the payload for daily rotation (see dailyRotate
// below and buildChannelMeta server-side) -- the server picks a fresh
// day's lineup from this pool on a schedule, so the channel's actual
// lineup changes over time instead of being permanently fixed to whatever
// happened to build first. This is the storage-side cap for that pool;
// CHANNEL_MAX_TOTAL_ITEMS above stays the safe upper bound (and the only
// cap that applies to the manual "Add every season" button, which has no
// pool/rotation concept).
const CHANNEL_POOL_MAX_ITEMS = 6000;
// What a rotating day's lineup actually looks like -- must match
// CHANNEL_ROTATION_SHOWS_PER_DAY / CHANNEL_ROTATION_EPISODES_PER_SHOW
// server-side. Used here only for display text (the real selection logic
// lives in buildChannelMeta).
const CHANNEL_ROTATION_SHOWS_PER_DAY = 24;
const CHANNEL_ROTATION_EPISODES_PER_SHOW = 3;

async function quickAddChannel(name, listUrl, networkId, btn) {
  const statusBox = document.getElementById('channelQuickAddStatus');
  // Restored on the way out below -- this is called both from the fixed
  // Quick Add network buttons ("Quick Add CBS") and from "Import from
  // link", each with its own resting label, so hardcoding one back would
  // leave the other mislabeled after its first use.
  const originalLabel = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Building ' + name + '\u2026';
  }
  if (statusBox) statusBox.innerHTML = '<p><small>Fetching ' + escapeHtml(name) + ' show list\u2026</small></p>';
  try {
    let params = networkId ? 'networkId=' + encodeURIComponent(networkId) : 'url=' + encodeURIComponent(listUrl);
    if (!networkId) {
      // Only the link-import path needs these -- a curated network id never
      // touches a personal mdblist/Trakt list, but a pasted link might be a
      // private one.
      const keys = collectKeys();
      if (keys.mdblistKey) params += '&mdblistKey=' + encodeURIComponent(keys.mdblistKey);
      if (keys.traktKey) params += '&traktKey=' + encodeURIComponent(keys.traktKey);
      if (keys.traktAccessToken) params += '&traktAccessToken=' + encodeURIComponent(keys.traktAccessToken);
    }
    const res = await fetch(ORIGIN + '/api/quick-channel-shows?' + params, { cache: 'no-store' });
    const data = await res.json();
    if (!data.ok) {
      alert('Could not build ' + name + ': ' + (data.error || 'unknown error'));
      return;
    }
    // Shuffled so repeated clicks surface different shows -- otherwise the
    // total-item cap below always cuts off at the same point in list order,
    // meaning the same handful of shows (whatever happens to sort first)
    // would win every single time.
    const shows = data.shows.slice();
    for (let i = shows.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = shows[i];
      shows[i] = shows[j];
      shows[j] = tmp;
    }
    const items = [];
    // Used to be routed through /api/logo-pad, an SVG that referenced the
    // network's logo (CBS eye, NBC peacock, etc.) by URL and drew it
    // smaller within a padded frame -- looked fine in this page's own Live
    // Preview (a real browser will happily fetch that nested image), but
    // wako and Stremio's own apps never actually loaded it, since neither
    // one's meta-poster pipeline fetches/renders an SVG that itself points
    // at another remote image. Using the network's logo URL directly here
    // instead -- exactly the same kind of plain TMDB image URL every other
    // poster in this add-on already uses successfully -- trades away the
    // padded/shrunk look for actually showing up everywhere.
    let poster = data.networkLogo || null;
    let showsIncluded = 0;
    let showsTrimmed = 0;
    let stoppedEarly = false;
    for (let i = 0; i < shows.length; i++) {
      if (items.length >= CHANNEL_POOL_MAX_ITEMS) {
        stoppedEarly = true;
        break;
      }
      const show = shows[i];
      if (statusBox) {
        statusBox.innerHTML = '<p><small>Building ' + escapeHtml(name) + '\u2026 show ' + (i + 1) + ' of ' + shows.length +
          ' (' + escapeHtml(show.name) + ')</small></p>';
      }
      if (!poster && show.poster) poster = show.poster;
      try {
        const seasonsRes = await fetch(ORIGIN + '/api/show-seasons?tmdbId=' + encodeURIComponent(show.tmdbId), { cache: 'no-store' });
        const seasonsData = await seasonsRes.json();
        if (!seasonsData.ok) continue;
        const seasonResults = await Promise.all(seasonsData.seasons.map((s) =>
          fetch(ORIGIN + '/api/show-episodes?tmdbId=' + encodeURIComponent(show.tmdbId) + '&season=' + encodeURIComponent(s.season), { cache: 'no-store' })
            .then((r) => r.json())
            .then((d) => ({ season: s.season, episodes: d.ok ? d.episodes : [] }))
            .catch(() => ({ season: s.season, episodes: [] }))
        ));
        const showEpisodes = [];
        seasonResults
          .sort((a, b) => a.season - b.season)
          .forEach(({ season, episodes }) => {
            episodes.forEach((ep) => {
              showEpisodes.push({
                kind: 'episode',
                imdbId: show.imdbId,
                season: season,
                episode: ep.episode,
                title: (show.name ? show.name + ' S' + season + 'E' + ep.episode + ' \u2014 ' : '') + (ep.name || ('Episode ' + ep.episode)),
                released: ep.released,
                thumbnail: ep.thumbnail || show.poster,
              });
            });
          });
        // A show that's run for decades (soaps, game shows, talk shows,
        // news magazines) can rack up thousands of episodes on its own --
        // keep the most recent ones rather than pulling in its entire
        // history wholesale.
        let finalShowEpisodes = showEpisodes.length > CHANNEL_MAX_EPISODES_PER_SHOW
          ? showEpisodes.slice(-CHANNEL_MAX_EPISODES_PER_SHOW)
          : showEpisodes;
        if (finalShowEpisodes.length < showEpisodes.length) showsTrimmed++;
        const remainingBudget = CHANNEL_POOL_MAX_ITEMS - items.length;
        if (finalShowEpisodes.length > remainingBudget) {
          finalShowEpisodes = finalShowEpisodes.slice(0, remainingBudget);
          stoppedEarly = true;
        }
        if (finalShowEpisodes.length) showsIncluded++;
        items.push(...finalShowEpisodes);
      } catch (e) {
        // One show failing (network hiccup, no seasons data, etc.) shouldn't
        // abort the whole channel -- just skip it and keep going.
        continue;
      }
    }
    if (!items.length) {
      alert('Could not build ' + name + ' -- no episodes were found.');
      return;
    }
    const channelId = generateChannelId();
    // dailyRotate: the server picks a fresh random 2000-item slice of this
    // stored pool each day (see buildChannelMeta) rather than always
    // showing the exact same fixed set -- so the actual lineup someone
    // sees changes over time, drawn from everything gathered here.
    const payload = { channelId: channelId, name: name, poster: poster, items: items, shuffle: false, dailyRotate: true };
    addRow(name, 'channel:v1:' + JSON.stringify(payload), 'series', true, 'Channels', channelId);
    renderChannelMergeList();
    let summary = name + ' channel added \u2014 ' + items.length + ' episodes across ' + showsIncluded + ' show(s) gathered. ' +
      'It\\'ll show ' + CHANNEL_ROTATION_SHOWS_PER_DAY + ' shows \u00d7 ' + CHANNEL_ROTATION_EPISODES_PER_SHOW + ' episodes each from that pool, refreshed daily.';
    if (showsTrimmed) summary += ' ' + showsTrimmed + ' long-running show(s) were trimmed to their most recent ' + CHANNEL_MAX_EPISODES_PER_SHOW + ' episodes.';
    if (stoppedEarly) summary += ' Stopped gathering early to keep the pool a safe size (some shows in the list weren\\'t included).';
    alert(summary);
  } catch (e) {
    alert('Network error while building ' + name + '.');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
    if (statusBox) statusBox.innerHTML = '';
  }
}

// Companion to the fixed Quick Add network buttons above -- same
// quickAddChannel machinery, just fed a pasted list link instead of a
// TMDB network id. The server side (/api/quick-channel-shows) requests
// type "series" from that link regardless of source, so any movies mixed
// into the list are silently dropped rather than erroring out.
async function importChannelFromLink(btn) {
  const urlInput = document.getElementById('channelImportUrlInput');
  const nameInput = document.getElementById('channelImportNameInput');
  const listUrl = urlInput.value.trim();
  const name = nameInput.value.trim();
  if (!listUrl) {
    alert('Paste a list URL first.');
    return;
  }
  if (!name) {
    alert('Name this channel first.');
    return;
  }
  await quickAddChannel(name, listUrl, null, btn);
  urlInput.value = '';
  nameInput.value = '';
}


//
// A channel is already just one item (one poster tile) in whatever catalog
// it belongs to -- so putting several channels side by side in one shelf is
// the exact same "merge multiple sources into one row" mechanism every
// other list type here already uses (newline-joined urls, fanned out and
// concatenated by fetchMergedCatalog server-side). This just needs a UI for
// picking which already-saved channels to fold together.
let channelMergeRows = [];

function renderChannelMergeList() {
  renderMyCreatedChannelsList();
  const box = document.getElementById('channelMergeList');
  if (!box) return;
  const selectAllCheck = document.getElementById('channelMergeSelectAllCheck');
  if (selectAllCheck) selectAllCheck.checked = false;
  const rows = [...document.querySelectorAll('#lists .entry')].filter((div) =>
    [...div.querySelectorAll('.url')].some((el) => el.value.trim().startsWith('channel:v1:'))
  );
  channelMergeRows = rows;
  if (!rows.length) {
    box.innerHTML = '<p><small>No saved channels yet -- build one above first.</small></p>';
    return;
  }
  box.innerHTML = rows.map((div, i) => {
    const nameEl = div.querySelector('.name');
    const name = (nameEl && nameEl.value.trim()) || 'Untitled channel';
    const channelCount = [...div.querySelectorAll('.url')].filter((el) => el.value.trim().startsWith('channel:v1:')).length;
    const label = channelCount > 1
      ? escapeHtml(name) + ' (' + channelCount + ' channels already merged here)'
      : escapeHtml(name);
    return '<label class="row quick-row" style="cursor:pointer;">' +
      '<span><input type="checkbox" class="channelMergeCheck" data-rowidx="' + i + '"> ' + label + '</span>' +
      '</label>';
  }).join('');
}

// Bulk-checks (or unchecks) every saved channel in the merge list -- the
// individual checkboxes get wiped out on every renderChannelMergeList()
// re-render, so this checkbox is reset there too rather than trying to
// track a stale "was everything checked" state across a refresh.
function toggleAllChannelMergeChecks(checkbox) {
  document.querySelectorAll('#channelMergeList .channelMergeCheck').forEach((cb) => {
    cb.checked = checkbox.checked;
  });
}

function mergeChannelsIntoRow() {
  const checks = document.querySelectorAll('#channelMergeList .channelMergeCheck:checked');
  if (checks.length < 2) {
    alert('Check at least two channels to merge.');
    return;
  }
  const nameInput = document.getElementById('channelMergeNameInput');
  const combinedName = nameInput.value.trim();
  if (!combinedName) {
    alert('Name the combined shelf first.');
    return;
  }
  const selectedRows = [...checks].map((cb) => channelMergeRows[parseInt(cb.dataset.rowidx, 10)]).filter(Boolean);
  const urls = [];
  selectedRows.forEach((div) => {
    [...div.querySelectorAll('.url')].forEach((el) => {
      const v = el.value.trim();
      if (v.startsWith('channel:v1:')) urls.push(v);
    });
  });
  if (!urls.length) {
    alert('Could not read those channels -- try refreshing the list and try again.');
    return;
  }
  // The originals are folded into the new merged row, so they'd otherwise
  // just be exact duplicates left behind -- same brief-undo safety net as
  // any other row removal, in case this was a misclick.
  captureUndoSnapshot();
  selectedRows.forEach((div) => div.remove());
  addRow(combinedName, urls.join('\\n'), 'series', true, 'Channels');
  nameInput.value = '';
  renumber();
  checkAllDuplicateUrls();
  renderChannelMergeList();
  showUndoToast('Merged ' + urls.length + ' channel(s) into "' + combinedName + '".');
}







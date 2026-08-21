// --- Custom Lists ---------------------------------------------------------------
//
// A hand-picked list of movies OR shows (not both -- see customListDraftType):
// each pick is saved as-is, no episode-picker step, and the resulting shelf is
// just multiple normal catalog tiles rather than one synthetic item -- see
// fetchCustomListCatalog server-side for why that's the deliberate design.
let customListDraftItems = [];
let customListDraftType = 'movie'; // 'movie' or 'series', set by user toggle

// Skips the search-and-pick draft entirely -- copyListToCustomList already
// does exactly "fetch this list's items and save them as a Custom List"
// (splitting into "(Movies)"/"(Shows)" lists on its own if the source turns
// out to be mixed), same machinery the My Lists/Search Lists panels' own
// "Copy to Custom List" buttons use, just fed a freely-pasted link and a
// name instead of a link the client already had metadata for.
async function importCustomListFromLink(btn) {
  const urlInput = document.getElementById('customListImportUrlInput');
  const nameInput = document.getElementById('customListImportNameInput');
  const syncCheck = document.getElementById('customListImportSyncCheck');
  const listUrl = urlInput.value.trim();
  if (!listUrl) {
    alert('Paste a list URL first.');
    return;
  }
  const name = nameInput.value.trim() || guessNameFromUrl(listUrl);
  const syncWithLink = syncCheck ? syncCheck.checked : false;
  await copyListToCustomList(name, listUrl, 'unknown', btn, null, { sourceUrl: syncWithLink ? listUrl : '' });
  urlInput.value = '';
  nameInput.value = '';
}

async function runCustomListSearch() {
  const q = document.getElementById('customListSearchInput').value.trim();
  const searchType = document.getElementById('customListSearchType').value; // 'movie' or 'tv'
  const box = document.getElementById('customListSearchResult');
  if (!q) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = '<p><small>Searching\u2026</small></p>';
  try {
    fetch(ORIGIN + '/api/track-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q }),
      keepalive: true,
    }).catch(() => {});
  } catch (e) {}
  try {
    const res = await fetch(ORIGIN + '/api/title-search?q=' + encodeURIComponent(q) + '&type=' + searchType, { cache: 'no-store' });
    const data = await res.json();
    if (!data.ok) {
      box.innerHTML = '<p class="testresult err">\u2717 ' + escapeHtml(data.error || 'Search failed.') + '</p>';
      return;
    }
    renderCustomListSearchResults(data.results, searchType);
  } catch (e) {
    box.innerHTML = '<p class="testresult err">\u2717 Network error while searching.</p>';
  }
}

function renderCustomListSearchResults(results, searchType) {
  const box = document.getElementById('customListSearchResult');
  if (!results.length) {
    box.innerHTML = '<p style="color:var(--muted); font-size:0.85rem;"><small>No matches found.</small></p>';
    return;
  }
  const cardsHtml = results.map((r) => {
    const posterImg = r.poster
      ? '<img class="preview-thumb" src="' + escapeAttr(r.poster) + '" alt="" loading="lazy">'
      : '<div class="preview-thumb" style="display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:0.7rem;text-align:center;padding:4px;">No poster</div>';
    return '<div class="custom-list-search-item" style="display:flex; flex-direction:column; align-items:center; width:100%; min-width:0;">' +
      posterImg +
      '<div style="width:100%; font-size:0.75rem; font-weight:600; text-align:center; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin:4px 0 1px;" title="' + escapeAttr(r.title) + '">' +
        escapeHtml(r.title) +
      '</div>' +
      (r.year ? '<div style="font-size:0.7rem; color:var(--muted); text-align:center; margin-bottom:4px;">' + escapeHtml(r.year) + '</div>' : '<div style="height:14px; margin-bottom:4px;"></div>') +
      '<button type="button" class="lc-btn secondary customListAddBtn" style="width:100%; padding:4px 6px; font-size:0.75rem;"' +
      ' data-tmdbid="' + r.tmdbId + '" data-searchtype="' + searchType + '"' +
      ' data-title="' + escapeAttr(r.title) + '" data-year="' + escapeAttr(r.year || '') + '"' +
      ' data-poster="' + escapeAttr(r.poster || '') + '">+ Add</button>' +
      '</div>';
  }).join('');
  box.innerHTML = '<div class="poster-grid-3" style="margin-top:10px;">' + cardsHtml + '</div>';
}

const customListSearchBox = document.getElementById('customListSearchResult');
if (customListSearchBox) {
  customListSearchBox.addEventListener('click', (e) => {
    const btn = e.target.closest('.customListAddBtn');
    if (!btn) return;
    addToCustomListDraft(btn.dataset.searchtype, btn.dataset.tmdbid, btn.dataset.title, btn.dataset.year, btn.dataset.poster, btn);
  });
}

async function addToCustomListDraft(searchType, tmdbId, title, year, poster, btn) {
  const itemType = searchType === 'tv' ? 'series' : 'movie';
  if (customListDraftType && customListDraftType !== 'mixed' && customListDraftType !== itemType) {
    if (!customListDraftItems.length) {
      customListDraftType = itemType;
      updateCustomListTypeRadio(itemType);
    } else {
      customListDraftType = 'mixed';
      updateCustomListTypeRadio('mixed');
    }
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Adding\u2026';
  }
  try {
    const endpoint = itemType === 'movie' ? '/api/resolve-movie?tmdbId=' : '/api/resolve-show?tmdbId=';
    const res = await fetch(ORIGIN + endpoint + encodeURIComponent(tmdbId), { cache: 'no-store' });
    const data = await res.json();
    if (!data.ok) {
      alert('Could not add "' + title + '": ' + (data.error || 'unknown error'));
      if (btn) {
        btn.disabled = false;
        btn.textContent = '+ Add';
      }
      return;
    }
    customListDraftItems.push({
      imdbId: data.imdbId,
      title: title,
      year: year || undefined,
      poster: poster || undefined,
      type: itemType,
    });
    if (!customListDraftType) customListDraftType = itemType;
    renderCustomListDraftList();
    if (btn) btn.textContent = 'Added \u2713';
    if (typeof trackEvent === 'function') trackEvent('list-add', data.imdbId, title, itemType);
  } catch (e) {
    alert('Network error adding "' + title + '".');
    if (btn) {
      btn.disabled = false;
      btn.textContent = '+ Add';
    }
  }
}

function renderCustomListDraftList() {
  const box = document.getElementById('customListDraftList');
  const badge = document.getElementById('customListDraftCountBadge');
  if (badge) badge.textContent = customListDraftItems.length ? '(' + customListDraftItems.length + ')' : '';
  if (!customListDraftItems.length) {
    box.innerHTML = '<p style="color:var(--muted); font-size:0.85rem;"><small>No items in this list yet &mdash; tap + on any movie or show across Discover, Search, or Charts to add it.</small></p>';
    return;
  }
  const cardsHtml = customListDraftItems.map((it, i) => {
    const itType = it.type || (it.kind === 'series' || it.kind === 'tv' ? 'series' : 'movie');
    const label = it.title || it.name || 'Untitled';
    const typeLabel = itType === 'series' ? 'Show' : 'Movie';
    const yearSub = (it.year ? it.year + ' \u2022 ' : '') + typeLabel;
    const posterEl = it.poster
      ? '<img class="live-preview-poster" src="' + escapeAttr(it.poster) + '" alt="" loading="lazy">'
      : '<div class="live-preview-poster live-preview-poster-placeholder"><small style="color:var(--muted); font-size:0.7rem;">No poster</small></div>';
    
    return '<div class="live-preview-poster-card custom-list-pick" data-idx="' + i + '" style="position:relative; cursor:grab; user-select:none; touch-action:manipulation;">' +
      '<div style="position:relative; width:100%;">' +
        posterEl +
        '<div style="position:absolute; top:4px; left:4px; z-index:4;">' +
          '<input type="number" class="pos customListPosInput" min="1" max="' + customListDraftItems.length + '" value="' + (i + 1) + '" title="Type position to move" style="width:34px; height:24px; min-height:unset; padding:2px; font-size:0.75rem; text-align:center; border-radius:6px; background:rgba(0,0,0,0.75); color:#fff; border:1px solid rgba(255,255,255,0.3); font-weight:700;">' +
        '</div>' +
        '<button type="button" class="cw-remove-btn customListRemovePickBtn" title="Remove from list" style="z-index:4;">&times;</button>' +
      '</div>' +
      '<div class="live-preview-poster-name" title="' + escapeAttr(label) + '">' + escapeHtml(label) + '</div>' +
      '<div class="live-preview-poster-year">' + escapeHtml(yearSub) + '</div>' +
    '</div>';
  }).join('');
  box.innerHTML = '<div class="poster-grid-3" style="margin-top:10px;">' + cardsHtml + '</div>';
  initCustomListHoldDrag();
}

document.getElementById('customListDraftList').addEventListener('click', (e) => {
  const removeBtn = e.target.closest('.customListRemovePickBtn');
  if (removeBtn) {
    const row = removeBtn.closest('.custom-list-pick');
    const idx = parseInt(row.dataset.idx, 10);
    customListDraftItems.splice(idx, 1);
    renderCustomListDraftList();
    return;
  }
});

// Lets someone type a new position directly into a pick's number box
document.getElementById('customListDraftList').addEventListener('change', (e) => {
  const posInput = e.target.closest('.customListPosInput');
  if (!posInput) return;
  const row = posInput.closest('.custom-list-pick');
  const from = parseInt(row.dataset.idx, 10);
  const typed = parseInt(posInput.value, 10);
  if (!typed || isNaN(typed)) {
    renderCustomListDraftList();
    return;
  }
  const to = Math.min(Math.max(typed, 1), customListDraftItems.length) - 1;
  if (to === from) {
    renderCustomListDraftList();
    return;
  }
  const [item] = customListDraftItems.splice(from, 1);
  customListDraftItems.splice(to, 0, item);
  renderCustomListDraftList();
});

let customListHoldDragBound = false;

function initCustomListHoldDrag() {
  const container = document.getElementById('customListDraftList');
  if (!container || customListHoldDragBound) return;
  customListHoldDragBound = true;

  let activeCard = null;
  let isDragging = false;
  let holdTimer = null;
  let startX = 0;
  let startY = 0;

  const cancelHold = () => {
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  };

  const stopDrag = () => {
    cancelHold();
    if (isDragging && activeCard) {
      activeCard.classList.remove('dragging');
      reorderCustomListDraftFromDom();
    }
    isDragging = false;
    activeCard = null;
    document.body.style.userSelect = '';
  };

  const startDrag = (card) => {
    isDragging = true;
    activeCard = card;
    card.classList.add('dragging');
    document.body.style.userSelect = 'none';
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      try { navigator.vibrate(30); } catch (err) {}
    }
  };

  const handleMove = (clientX, clientY, e) => {
    if (!activeCard) return;

    if (!isDragging) {
      const dist = Math.hypot(clientX - startX, clientY - startY);
      if (dist > 12) {
        cancelHold();
        activeCard = null;
      }
      return;
    }

    if (e && e.cancelable) {
      e.preventDefault();
    }

    const grid = container.querySelector('.poster-grid-3') || container;
    const targetCard = getCustomListDragAfterElement(grid, clientX, clientY);
    if (targetCard && targetCard !== activeCard) {
      const box = targetCard.getBoundingClientRect();
      const isAfter = (clientY > box.top + box.height / 2) || (clientY >= box.top && clientX > box.left + box.width / 2);
      if (isAfter) {
        grid.insertBefore(activeCard, targetCard.nextSibling);
      } else {
        grid.insertBefore(activeCard, targetCard);
      }
    }
  };

  container.addEventListener('dragstart', (e) => { e.preventDefault(); });

  // Pointer events for desktop & unified pointer handling
  container.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.customListRemovePickBtn, .customListPosInput')) return;
    const card = e.target.closest('.custom-list-pick');
    if (!card) return;

    cancelHold();
    activeCard = card;
    isDragging = false;
    startX = e.clientX;
    startY = e.clientY;

    const isTouch = e.pointerType === 'touch' || e.pointerType === 'pen';
    holdTimer = setTimeout(() => {
      startDrag(card);
    }, isTouch ? 180 : 120);
  });

  window.addEventListener('pointermove', (e) => {
    if (!activeCard) return;
    handleMove(e.clientX, e.clientY, e);
  }, { passive: false });

  window.addEventListener('pointerup', () => {
    if (activeCard) stopDrag();
  });

  window.addEventListener('pointercancel', (e) => {
    if (!isDragging) {
      cancelHold();
      activeCard = null;
    } else if (e.pointerType !== 'touch') {
      stopDrag();
    }
  });

  // Dedicated touch listeners for guaranteed mobile gesture prevention
  container.addEventListener('touchstart', (e) => {
    if (e.target.closest('.customListRemovePickBtn, .customListPosInput')) return;
    const card = e.target.closest('.custom-list-pick');
    if (!card || e.touches.length !== 1) return;

    cancelHold();
    activeCard = card;
    isDragging = false;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;

    holdTimer = setTimeout(() => {
      startDrag(card);
    }, 180);
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (!activeCard || !e.touches || e.touches.length !== 1) return;
    if (isDragging && e.cancelable) {
      e.preventDefault();
    }
    handleMove(e.touches[0].clientX, e.touches[0].clientY, e);
  }, { passive: false });

  window.addEventListener('touchend', () => {
    if (activeCard) stopDrag();
  });

  window.addEventListener('touchcancel', () => {
    if (activeCard) stopDrag();
  });
}

function getCustomListDragAfterElement(container, x, y) {
  const els = [...container.querySelectorAll('.custom-list-pick:not(.dragging)')];
  if (!els.length) return null;

  for (const child of els) {
    const box = child.getBoundingClientRect();
    if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) {
      return child;
    }
  }

  let closest = null;
  let closestDistance = Infinity;
  for (const child of els) {
    const box = child.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const dist = Math.hypot(x - cx, y - cy);
    if (dist < closestDistance) {
      closestDistance = dist;
      closest = child;
    }
  }
  return closest;
}

function reorderCustomListDraftFromDom() {
  const container = document.getElementById('customListDraftList');
  const rows = [...container.querySelectorAll('.custom-list-pick')];
  if (rows.length) {
    customListDraftItems = rows.map((row) => customListDraftItems[parseInt(row.dataset.idx, 10)]).filter(Boolean);
  }
  renderCustomListDraftList();
}

function shuffleCustomListDraft() {
  if (customListDraftItems.length < 2) return;
  for (let i = customListDraftItems.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = customListDraftItems[i];
    customListDraftItems[i] = customListDraftItems[j];
    customListDraftItems[j] = tmp;
  }
  renderCustomListDraftList();
}

// Set by editCustomList below while an existing Custom List's picks are
// loaded into the draft for editing; null means "Save" creates a brand
// new list, same as always.
let editingCustomListUrlInput = null;

// Carries a stable id across an edit (see editCustomList) so a shuffled
// list's daily reshuffle seed stays consistent rather than resetting every
// time it's edited -- same reasoning as a Channel's channelId, and needed
// for the same reason: this list could end up merged with others into one
// row (the ordinary merge-into-one-shelf mechanism, not a dedicated
// feature here), where there's no outer entry.id to fall back on for any
// individual list's own seed.
let customListDraftListId = null;

function saveCustomList() {
  const nameInput = document.getElementById('customListNameInput');
  const name = nameInput.value.trim();
  if (!name) {
    alert('Name this list first.');
    return;
  }

  if (editingCreatorListSlug) {
    saveCreatorListEdit(name);
    return;
  }
  if (editingLocalCustomListSlug) {
    saveLocalCustomListEdit(name);
    return;
  }

  const shuffle = document.getElementById('customListRandomizeCheck').checked;
  const listId = customListDraftListId || generateChannelId();
  // Allow empty lists -- type defaults to 'movie' if nothing was added yet
  const listType = customListDraftType || 'movie';
  const payload = { listId: listId, type: listType, items: customListDraftItems, shuffle: shuffle };
  const newUrl = 'customlist:v1:' + JSON.stringify(payload);

  // Locate (or create) the row's actual DOM node so it can be handed
  // straight into the save flow below -- using replaceWith + a direct
  // reference to the freshly-parsed node, rather than outerHTML + a stale
  // reference, since pendingSaveListContext needs a node still attached to
  // the document when the save flow eventually writes the published URL
  // back into it.
  let sourceRow;
  if (editingCustomListUrlInput) {
    const oldSourceRow = editingCustomListUrlInput.closest('.source-row');
    const temp = document.createElement('div');
    temp.innerHTML = customListSourceRowHtml(newUrl);
    sourceRow = temp.firstElementChild;
    if (oldSourceRow) oldSourceRow.replaceWith(sourceRow);
    // A row holding just this one Custom List also uses its own name as
    // the row's name -- keep those in sync. A merged row's name is the
    // shared shelf name instead, so that's left alone.
    const rowDiv = sourceRow.closest('.entry');
    if (rowDiv && rowDiv.querySelectorAll('.url').length === 1) {
      const rowNameInput = rowDiv.querySelector('.name');
      if (rowNameInput) rowNameInput.value = name;
    }
    editingCustomListUrlInput = null;
    renumber();
    checkAllDuplicateUrls();
    saveState();
  } else {
    if (listType === 'mixed') {
      const movies = customListDraftItems.filter(it => (it.kind === 'movie' || it.type === 'movie' || (!it.kind && !it.type)));
      const series = customListDraftItems.filter(it => (it.kind === 'series' || it.type === 'series' || it.type === 'tv'));
      if (movies.length > 0) {
        const moviePayload = { listId: generateChannelId(), type: 'movie', items: movies, shuffle: shuffle };
        const movieUrl = 'customlist:v1:' + JSON.stringify(moviePayload);
        const movieRow = addRow(name + (series.length > 0 ? ' (Movies)' : ''), movieUrl, 'movie', true, 'Custom Lists');
        if (!sourceRow) sourceRow = movieRow ? movieRow.querySelector('.source-row') : null;
      }
      if (series.length > 0 || movies.length === 0) {
        const seriesPayload = { listId: generateChannelId(), type: 'series', items: series, shuffle: shuffle };
        const seriesUrl = 'customlist:v1:' + JSON.stringify(seriesPayload);
        const seriesRow = addRow(name + (movies.length > 0 ? ' (Shows)' : ''), seriesUrl, 'series', true, 'Custom Lists');
        if (!sourceRow) sourceRow = seriesRow ? seriesRow.querySelector('.source-row') : null;
      }
    } else {
      const newRowDiv = addRow(name, newUrl, customListDraftType, true, 'Custom Lists');
      sourceRow = newRowDiv ? newRowDiv.querySelector('.source-row') : null;
    }
  }

  customListDraftItems = [];
  customListDraftType = 'movie';
  updateCustomListTypeRadio('movie');
  customListDraftListId = null;
  nameInput.value = '';
  const searchInput = document.getElementById('customListSearchInput');
  if (searchInput) searchInput.value = '';
  const searchRes = document.getElementById('customListSearchResult');
  if (searchRes) searchRes.innerHTML = '';
  renderCustomListDraftList();
  updateCustomListSaveButtonLabel();

  // Straight into the same save flow the row's own "Save List" button
  // uses (creator-profile signed-in -> visibility picker directly;
  // otherwise the anonymous-vs-create-a-profile choice) -- no separate
  // trip down to the list below and a second click needed.
  const urlInput = sourceRow ? sourceRow.querySelector('.url') : null;
  if (sourceRow && urlInput) {
    beginSaveListFlow(sourceRow, urlInput, name);
  } else {
    alert('List "' + name + '" saved, but the save dialog couldn\\'t open automatically -- use the "Save List" button on it below.');
  }
}

// Saves changes to a list already living on the creator's profile --
// straight back to the server (no local row involved at all, unlike every
// other save path here), since a Creator-owned list's canonical copy is
// the one on the server, not a row in this particular install link.
async function saveCreatorListEdit(name) {
  if (!activeCreator) {
    alert('Your Creator Profile session expired -- please restore it again.');
    editingCreatorListSlug = null;
    updateCustomListSaveButtonLabel();
    return;
  }
  const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
  const visSelect = document.getElementById('customListVisibilitySelect');
  const visibility = visSelect && visSelect.value === 'private' ? 'private' : 'public';
  try {
    const res = await fetch(ORIGIN + '/api/creator/lists/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creatorName: activeCreator.creatorName,
        creatorKey: creatorKey,
        slug: editingCreatorListSlug,
        name: name,
        type: customListDraftType,
        items: customListDraftItems,
        visibility: visibility,
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      if (typeof showAppNoticeModal === 'function') {
        showAppNoticeModal('Could Not Save Changes', data.error || 'Unknown error occurred.', true);
      } else {
        alert('Could not save changes: ' + (data.error || 'unknown error'));
      }
      return;
    }
    if (typeof showSavedCustomListModal === 'function') {
      showSavedCustomListModal(name, visibility, data.url);
    } else {
      showAddedToast('"' + name + '" updated \u2713');
    }
    cancelEditCustomList();
    renderCreatorDashboard();
  } catch (e) {
    if (typeof showAppNoticeModal === 'function') {
      showAppNoticeModal('Network Error', 'A network error occurred while saving. Please try again.', true);
    } else {
      alert('Network error while saving.');
    }
  }
}

// Local equivalent of saveCreatorListEdit above -- same role, writes to
// the local store instead of the server, no visibility to preserve since
// local lists don't have one.
function saveLocalCustomListEdit(name) {
  const map = loadLocalCustomLists();
  const slug = editingLocalCustomListSlug;
  const existing = map[slug];
  map[slug] = {
    slug: slug,
    name: name,
    type: customListDraftType,
    items: customListDraftItems,
    createdAt: existing ? existing.createdAt : Date.now(),
    updatedAt: Date.now(),
  };
  saveLocalCustomListsMap(map);
  showAddedToast('"' + name + '" updated \u2713');
  cancelEditCustomList();
  renderCreatorDashboard();
}

// Loads an existing Custom List's picks back into the draft so they can be
// adjusted and saved back over the same list, instead of needing to
// delete and rebuild it from scratch.
function editCustomList(btn) {
  const sourceRow = btn.closest('.source-row');
  const urlInput = sourceRow && sourceRow.querySelector('.url');
  if (!urlInput) {
    alert('Could not read this list to edit it.');
    return;
  }
  const payload = parseCustomListPayloadClient(urlInput.value);
  if (!payload) {
    alert('Could not read this list to edit it.');
    return;
  }
  customListDraftItems = (payload.items || []).slice();
  customListDraftType = payload.type || 'movie';
  updateCustomListTypeRadio(customListDraftType);
  customListDraftListId = payload.listId || null;
  const rowDiv = urlInput.closest('.entry');
  const currentName = rowDiv && rowDiv.querySelectorAll('.url').length === 1 && rowDiv.querySelector('.name')
    ? rowDiv.querySelector('.name').value.trim()
    : '';
  document.getElementById('customListNameInput').value = currentName;
  const searchTypeEl = document.getElementById('customListSearchType');
  if (searchTypeEl) searchTypeEl.value = payload.type === 'series' ? 'tv' : 'movie';
  document.getElementById('customListRandomizeCheck').checked = !!payload.shuffle;
  editingCustomListUrlInput = urlInput;
  editingCreatorListSlug = null;
  renderCustomListDraftList();
  updateCustomListSaveButtonLabel();

  switchTab('lists');
  // Create List has no pill of its own -- see the matching fix in
  // editCreatorList/editLocalCustomList for why this doesn't try to grab
  // one to highlight.
  if (typeof switchListsSubmenu === 'function') switchListsSubmenu('create-list');
  const panel = document.getElementById('listsSubCreateList');
  if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cancelEditCustomList() {
  editingCustomListUrlInput = null;
  editingCreatorListSlug = null;
  editingLocalCustomListSlug = null;
  customListDraftItems = [];
  customListDraftType = 'movie';
  updateCustomListTypeRadio('movie');
  customListDraftListId = null;
  document.getElementById('customListNameInput').value = '';
  const searchInput = document.getElementById('customListSearchInput');
  if (searchInput) searchInput.value = '';
  const searchRes = document.getElementById('customListSearchResult');
  if (searchRes) searchRes.innerHTML = '';
  document.getElementById('customListRandomizeCheck').checked = false;
  renderCustomListDraftList();
  updateCustomListSaveButtonLabel();
  
  if (typeof switchListsSubmenu === 'function') {
    switchListsSubmenu('my-lists', document.querySelector('#listsSubnavBar button:nth-child(1)'));
  }
}

function updateCustomListSaveButtonLabel() {
  const saveBtn = document.getElementById('customListSaveBtn');
  const cancelBtn = document.getElementById('customListCancelEditBtn');
  const visRow = document.getElementById('customListVisibilityRow');
  if (!saveBtn) return;
  const titleEl = document.getElementById('customListEditorTitle');
  const isEditing = editingCreatorListSlug || editingLocalCustomListSlug || editingCustomListUrlInput;
  if (titleEl) {
    titleEl.innerHTML = (isEditing ? 'Edit Custom List' : 'Create a Custom List') + ' <span class="badge" id="customListDraftCountBadge"></span>';
    // Must update badge text again since we just rewrote innerHTML
    const badge = document.getElementById('customListDraftCountBadge');
    if (badge) badge.textContent = customListDraftItems.length ? '(' + customListDraftItems.length + ')' : '';
  }

  saveBtn.textContent = 'Save';
  if (cancelBtn) {
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.display = isEditing ? '' : 'none';
  }
  if (visRow) {
    visRow.style.display = editingCreatorListSlug ? '' : 'none';
  }
}



function closeCreateListModal() {
  document.getElementById('listsSubCreateList').style.display = 'none';
  document.getElementById('listsSubMyLists').style.display = 'block';
}

function setCustomListDraftTypeToggle(type) {
  if (type === 'mixed') {
    customListDraftType = 'mixed';
    updateCustomListTypeRadio('mixed');
    return;
  }
  if (customListDraftItems.length > 0 && customListDraftType !== type) {
    const hasOpposite = customListDraftItems.some(it => {
      const itType = it.type || (it.kind === 'series' || it.kind === 'tv' ? 'series' : 'movie');
      return itType !== type;
    });
    if (hasOpposite) {
      alert('This list contains both movies and shows -- keep it set to "Mixed" or remove incompatible items first.');
      updateCustomListTypeRadio(customListDraftType);
      return;
    }
  }
  customListDraftType = type;
  updateCustomListTypeRadio(type);
}

function updateCustomListTypeRadio(type) {
  const radios = document.getElementsByName('customListTypeRadio');
  for (let i = 0; i < radios.length; i++) {
    if (radios[i].value === type) {
      radios[i].checked = true;
    }
  }
}

// --- Watch History --------------------------------------------------------

window._watchedItemIds = new Set();
// Shows where every currently-aired episode has been watched -- separate
// from _watchedItemIds (which only ever holds movie/episode ids, never a
// show's own id) since a show's poster is never itself added to Watch
// History, only its episodes are. Computed by updateContinueWatching
// below whenever it can't find a next unwatched, aired episode.
window._fullyWatchedShowIds = new Set();
// Shows with at least one watched episode but still an unwatched, aired
// episode waiting -- i.e. currently sitting in Continue Watching. Gets the
// amber "in progress" badge instead of the blue checkmark; a show moves
// out of this set and into _fullyWatchedShowIds the moment its last
// episode is watched. Derived the same way _fullyWatchedShowIds is
// (initWatchHistory on load, updateContinueWatching as things change), so
// the two sets are always mutually exclusive for a given showId.
window._inProgressShowIds = new Set();
// Shows explicitly dismissed from Continue Watching, keyed by showId, each
// mapped to the exact watched snapshot (season/episode) the dismissal was
// made at -- see dismissContinueWatchingShow below for why a snapshot
// rather than a plain boolean. Restored from localStorage in
// initWatchHistory below for a local-only browser; a signed-in account
// gets it from the server instead (see loadCreatorSync).
window._dismissedContinueWatching = {};

// Finds the position:relative box a watched-checkmark badge should be
// inserted into for a given .clickable-poster/.clickable-episode element.
// Poster markup isn't consistent across the app -- some wrap the image in
// its own positioned box (livePreviewPosterHtml), some set
// position:relative on the clickable element itself via a CSS class
// rather than an inline style (.list-card-mini-poster-img-wrap), and some
// put .clickable-poster directly on the <img> (the Custom Lists /
// Continue Watching dashboard cards) -- and an <img> can't hold rendered
// children, so that last case falls back to the image's own parent
// instead of the image itself.
function findWatchBadgeWrap(el) {
  const wrap = el.querySelector('div[style*="position:relative"]') || el.querySelector('.poster-image-wrap') || el.querySelector('div[style*="aspect-ratio"]');
  if (wrap) return wrap;
  if (el.tagName === 'IMG') return el.parentElement;
  return el;
}

// Returns 'full' (blue checkmark), 'partial' (amber circle), or null (no
// badge) for a given poster/episode element's id+type. A show's own
// poster (data-type="series") is checked against the two show-level sets
// instead of the regular per-item watched set, since the show's id itself
// never lands in Watch History -- only its episodes do. Episodes/movies
// have no data-type "series", so they fall through to the plain
// watched-item check same as always.
function computeWatchBadgeState(id, type) {
  if (type === 'series') {
    if (window._fullyWatchedShowIds && window._fullyWatchedShowIds.has(id)) return 'full';
    if (window._inProgressShowIds && window._inProgressShowIds.has(id)) return 'partial';
    return null;
  }
  return (window._watchedItemIds && window._watchedItemIds.has(id)) ? 'full' : null;
}

// Builds the badge markup for a given state -- shared by the observer and
// refreshWatchBadge below so the two can never drift out of sync on markup.
function watchBadgeHtml(state) {
  return state === 'partial'
    ? '<div class="watch-indicator-overlay watch-indicator-partial">&#x25D0;</div>'
    : '<div class="watch-indicator-overlay">&#x2713;</div>';
}

function initWatchHistory() {
  if (typeof loadLocalCustomLists === 'function') {
    const map = loadLocalCustomLists();
    Object.keys(map).forEach(key => {
      const l = map[key];
      if (key === 'watch-history' || key.includes('watch-history') || (l && l.name && l.name.toLowerCase().includes('watch history'))) {
        const items = (l && l.items) || [];
        items.forEach(it => {
          if (it.id) window._watchedItemIds.add(String(it.id));
          if (it.imdbId) window._watchedItemIds.add(String(it.imdbId));
          if (it.tmdbId) {
            window._watchedItemIds.add(String(it.tmdbId));
            window._watchedItemIds.add('tmdb:' + it.tmdbId);
          }
        });
      }
      if (key === 'continue-watching' || (l && l.name && l.name.toLowerCase().includes('continue watching'))) {
        const items = (l && l.items) || [];
        items.forEach(it => { if (it.showId) window._inProgressShowIds.add(String(it.showId)); });
      }
    });
  }
  try {
    const rawWh = JSON.parse(localStorage.getItem('myListAddon:watchHistory') || '[]');
    if (Array.isArray(rawWh)) {
      rawWh.forEach(it => {
        if (it.id) window._watchedItemIds.add(String(it.id));
        if (it.imdbId) window._watchedItemIds.add(String(it.imdbId));
      });
    }
  } catch (e) {}
  try {
    const raw = localStorage.getItem('myListAddon:fullyWatchedShows');
    if (raw) JSON.parse(raw).forEach(id => window._fullyWatchedShowIds.add(String(id)));
  } catch (e) {
    // non-critical -- badges just won't show for shows until the next
    // time updateContinueWatching recomputes them
  }
  try {
    const dismissedRaw = localStorage.getItem('myListAddon:dismissedContinueWatching');
    if (dismissedRaw) {
      const parsed = JSON.parse(dismissedRaw);
      if (parsed && typeof parsed === 'object') window._dismissedContinueWatching = parsed;
    }
  } catch (e) {
    // non-critical -- a dismissed show might just reappear once
  }

  const observer = new MutationObserver(mutations => {
    if (!window._watchedItemIds) return;
    document.querySelectorAll('.clickable-poster, .clickable-episode').forEach(el => {
      const id = el.dataset.id;
      if (!id) return;
      const state = computeWatchBadgeState(id, el.dataset.type);
      if (!state) return;
      const wrap = findWatchBadgeWrap(el);
      if (!wrap) return;
      // Checking wrap (not el) for an existing badge matters: when el is
      // an <img> (it can't hold children), wrap is el.parentElement --
      // checking el itself here would always find nothing, insert another
      // badge into wrap every time this observer fires, and since that
      // insertion is itself a mutation under the very subtree being
      // observed, immediately re-trigger this same callback -- an
      // unbounded loop that floods the DOM and freezes the tab.
      if (!wrap.querySelector('.watch-indicator-overlay')) {
        wrap.insertAdjacentHTML('beforeend', watchBadgeHtml(state));
      }
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
  try { cleanWatchedFromWatchlists(); } catch (e) {}
}
setTimeout(initWatchHistory, 500);

// Adds/removes/updates the watched badge on every currently on-screen
// poster/episode card matching this id. Called right after toggling
// something, so the change shows up immediately rather than waiting on
// the MutationObserver above (which only reacts to new DOM nodes
// appearing, not to the watch-state sets changing underneath content
// that's already on screen).
function refreshWatchBadge(id, type) {
  const strId = String(id);
  const state = computeWatchBadgeState(strId, type);
  document.querySelectorAll('.clickable-poster[data-id="' + escapeAttr(strId) + '"], .clickable-episode[data-id="' + escapeAttr(strId) + '"]').forEach(el => {
    const wrap = findWatchBadgeWrap(el);
    if (!wrap) return;
    // See the matching comment in initWatchHistory's observer above -- this
    // has to check wrap, not el, for the same reason.
    const overlay = wrap.querySelector('.watch-indicator-overlay');
    if (state) {
      if (!overlay) {
        wrap.insertAdjacentHTML('beforeend', watchBadgeHtml(state));
      } else {
        // Swap in place (rather than remove+reinsert) when a show flips
        // straight from partial to full on its last episode -- keeps the
        // existing badge element instead of a flicker of removal.
        overlay.className = 'watch-indicator-overlay' + (state === 'partial' ? ' watch-indicator-partial' : '');
        overlay.innerHTML = state === 'partial' ? '&#x25D0;' : '&#x2713;';
      }
    } else if (overlay) {
      overlay.remove();
    }
  });
}

// Updates the fully-watched set for one show (persisting it so the badge
// survives a refresh) and immediately refreshes that show's badge
// wherever its poster is currently on screen. Fully watched and in
// progress are mutually exclusive, so marking one clears the other.
function setShowFullyWatched(showId, isFullyWatched) {
  if (!window._fullyWatchedShowIds) window._fullyWatchedShowIds = new Set();
  const had = window._fullyWatchedShowIds.has(showId);
  if (isFullyWatched) {
    window._fullyWatchedShowIds.add(showId);
    if (window._inProgressShowIds) window._inProgressShowIds.delete(showId);
  } else {
    window._fullyWatchedShowIds.delete(showId);
  }
  if (had !== isFullyWatched) {
    try {
      localStorage.setItem('myListAddon:fullyWatchedShows', JSON.stringify([...window._fullyWatchedShowIds]));
    } catch (e) {
      // non-critical
    }
  }
  refreshWatchBadge(showId, 'series');
}

// Companion to setShowFullyWatched above -- marks a show as having an
// unwatched-but-aired episode waiting (the amber badge) or clears that
// state. Not persisted to its own localStorage key the way
// fullyWatchedShows is: it's fully derivable from the Continue Watching
// list itself, which initWatchHistory already re-reads on every page
// load, so a second persisted copy would just be one more place for the
// two to drift out of sync.
function setShowInProgress(showId, isInProgress) {
  if (!window._inProgressShowIds) window._inProgressShowIds = new Set();
  if (isInProgress) {
    window._inProgressShowIds.add(showId);
  } else {
    window._inProgressShowIds.delete(showId);
  }
  refreshWatchBadge(showId, 'series');
}

// Automatically removes a watched item (by its ID, IMDb ID, or parent show ID)
// from any Custom List designated as the Watchlist.
function removeWatchedItemFromWatchlist(id, showId, extraIds) {
  if (!id && !showId && (!extraIds || !extraIds.length)) return;
  const targetIds = new Set();
  const addId = (raw) => {
    if (!raw) return;
    const s = String(raw).trim();
    if (!s) return;
    targetIds.add(s);
    if (s.startsWith('tmdb:')) targetIds.add(s.slice(5));
    else if (/^\d+$/.test(s)) targetIds.add('tmdb:' + s);
  };
  addId(id);
  addId(showId);
  if (Array.isArray(extraIds)) extraIds.forEach(addId);
  if (window._currentItemDetails) {
    addId(window._currentItemDetails.id);
    addId(window._currentItemDetails.imdbId);
    addId(window._currentItemDetails.tmdbId);
  }

  const map = typeof loadLocalCustomLists === 'function' ? loadLocalCustomLists() : {};
  let localChanged = false;

  Object.keys(map).forEach((key) => {
    const list = map[key];
    if (!list) return;
    const isWatchlist = list.slug === 'watchlist' || (list.name && list.name.toLowerCase() === 'watchlist') || list.isWatchlist;
    if (!isWatchlist || !Array.isArray(list.items) || !list.items.length) return;

    const initialLen = list.items.length;
    list.items = list.items.filter((it) => {
      if (!it) return false;
      const itId = String(it.id || '');
      const itImdbId = String(it.imdbId || '');
      const itShowId = String(it.showId || '');
      const itTmdbId = String(it.tmdbId || '');

      if (itId && (targetIds.has(itId) || (/^\d+$/.test(itId) && targetIds.has('tmdb:' + itId)) || (itId.startsWith('tmdb:') && targetIds.has(itId.slice(5))))) return false;
      if (itImdbId && targetIds.has(itImdbId)) return false;
      if (itShowId && targetIds.has(itShowId)) return false;
      if (itTmdbId && (targetIds.has(itTmdbId) || targetIds.has('tmdb:' + itTmdbId))) return false;
      return true;
    });

    if (list.items.length !== initialLen) {
      list.updatedAt = Date.now();
      localChanged = true;

      // Update matching catalog shelf row in #lists if added to shelves
      const matchingRow = [...document.querySelectorAll('#lists .entry')].find((row) => {
        const urlEl = row.querySelector('.url');
        if (!urlEl || !urlEl.value.startsWith('customlist:v1:')) return false;
        try {
          const p = JSON.parse(urlEl.value.slice('customlist:v1:'.length));
          return p.localSlug === list.slug || p.name === list.name;
        } catch {
          return false;
        }
      });
      if (matchingRow) {
        const urlEl = matchingRow.querySelector('.url');
        try {
          const p = JSON.parse(urlEl.value.slice('customlist:v1:'.length));
          p.items = list.items;
          urlEl.value = 'customlist:v1:' + JSON.stringify(p);
          if (typeof customListSourceRowHtml === 'function') {
            matchingRow.outerHTML = customListSourceRowHtml('customlist:v1:' + JSON.stringify(p));
          }
          if (typeof saveState === 'function') saveState();
        } catch {}
      }
    }
  });

  if (localChanged) {
    if (typeof saveLocalCustomListsMap === 'function') saveLocalCustomListsMap(map);
    if (typeof scheduleCreatorSyncSave === 'function') scheduleCreatorSyncSave();
    if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard();
  }

  // Also check Creator profile lists if signed in
  if (typeof activeCreator !== 'undefined' && activeCreator && typeof lastCreatorListsData !== 'undefined' && Array.isArray(lastCreatorListsData)) {
    const creatorWatchlist = lastCreatorListsData.find(
      (l) => l && (l.slug === 'watchlist' || (l.name && l.name.toLowerCase() === 'watchlist') || l.isWatchlist)
    );
    if (creatorWatchlist && Array.isArray(creatorWatchlist.items) && creatorWatchlist.items.length) {
      const initialLen = creatorWatchlist.items.length;
      const updatedItems = creatorWatchlist.items.filter((it) => {
        if (!it) return false;
        const itId = String(it.id || '');
        const itImdbId = String(it.imdbId || '');
        const itShowId = String(it.showId || '');
        const itTmdbId = String(it.tmdbId || '');

        if (itId && (targetIds.has(itId) || (/^\d+$/.test(itId) && targetIds.has('tmdb:' + itId)) || (itId.startsWith('tmdb:') && targetIds.has(itId.slice(5))))) return false;
        if (itImdbId && targetIds.has(itImdbId)) return false;
        if (itShowId && targetIds.has(itShowId)) return false;
        if (itTmdbId && (targetIds.has(itTmdbId) || targetIds.has('tmdb:' + itTmdbId))) return false;
        return true;
      });
      if (updatedItems.length !== initialLen) {
        creatorWatchlist.items = updatedItems;
        const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
        fetch(ORIGIN + '/api/creator/lists/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            creatorName: activeCreator.creatorName,
            creatorKey: creatorKey,
            name: creatorWatchlist.name,
            type: creatorWatchlist.type || 'mixed',
            items: updatedItems,
            visibility: creatorWatchlist.visibility || 'private',
            slug: creatorWatchlist.slug,
          }),
        }).catch(() => {});
      }
    }
  }
}

// Scans Watch History and removes any watched movies, shows, or episodes from all Watchlists
function cleanWatchedFromWatchlists() {
  const map = typeof loadLocalCustomLists === 'function' ? loadLocalCustomLists() : {};
  const historyList = map['watch-history'];
  const watchedItems = (historyList && Array.isArray(historyList.items)) ? historyList.items : [];
  if (!watchedItems.length && (!window._watchedItemIds || !window._watchedItemIds.size)) return;

  const watchedIds = new Set(window._watchedItemIds ? Array.from(window._watchedItemIds) : []);
  const watchedShowIds = new Set();
  watchedItems.forEach((w) => {
    if (w.id) {
      const s = String(w.id);
      watchedIds.add(s);
      if (s.startsWith('tmdb:')) watchedIds.add(s.slice(5));
      else if (/^\d+$/.test(s)) watchedIds.add('tmdb:' + s);
    }
    if (w.imdbId) watchedIds.add(String(w.imdbId));
    if (w.tmdbId) {
      const s = String(w.tmdbId);
      watchedIds.add(s);
      watchedIds.add('tmdb:' + s);
    }
    if (w.showId) watchedShowIds.add(String(w.showId));
  });

  let localChanged = false;

  Object.keys(map).forEach((key) => {
    const list = map[key];
    if (!list) return;
    const isWatchlist = list.slug === 'watchlist' || (list.name && list.name.toLowerCase() === 'watchlist') || list.isWatchlist;
    if (!isWatchlist || !Array.isArray(list.items) || !list.items.length) return;

    const initialLen = list.items.length;
    list.items = list.items.filter((it) => {
      if (!it) return false;
      const itId = String(it.id || '');
      const itImdbId = String(it.imdbId || '');
      const itShowId = String(it.showId || '');
      const itTmdbId = String(it.tmdbId || '');

      if (itId && (watchedIds.has(itId) || (/^\d+$/.test(itId) && watchedIds.has('tmdb:' + itId)) || (itId.startsWith('tmdb:') && watchedIds.has(itId.slice(5))))) return false;
      if (itImdbId && watchedIds.has(itImdbId)) return false;
      if (itShowId && (watchedShowIds.has(itShowId) || watchedIds.has(itShowId))) return false;
      if (itTmdbId && (watchedIds.has(itTmdbId) || watchedIds.has('tmdb:' + itTmdbId))) return false;
      if (itId && watchedShowIds.has(itId)) return false;

      return true;
    });

    if (list.items.length !== initialLen) {
      list.updatedAt = Date.now();
      localChanged = true;
    }
  });

  if (localChanged) {
    if (typeof saveLocalCustomListsMap === 'function') saveLocalCustomListsMap(map);
    if (typeof scheduleCreatorSyncSave === 'function') scheduleCreatorSyncSave();
    if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard();
  }
}

function getOrCreateWatchHistoryList() {
  const map = loadLocalCustomLists();
  if (!map['watch-history']) {
    map['watch-history'] = {
      slug: 'watch-history',
      localSlug: 'watch-history',
      name: 'Watch History',
      description: 'Automatically tracking your watched movies, shows, and episodes.',
      items: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    saveLocalCustomListsMap(map);
  } else if (!map['watch-history'].slug) {
    // Backfills a slug on a Watch History list saved before this list
    // started needing one -- without it, "Your Custom Lists" can't match
    // its View/Edit/Delete/+Add buttons back to this entry.
    map['watch-history'].slug = 'watch-history';
    saveLocalCustomListsMap(map);
  }
  return map['watch-history'];
}

window.toggleWatchStatus = function(id, type, name, poster) {
  const map = loadLocalCustomLists();
  const list = getOrCreateWatchHistoryList();
  
  const existingIdx = list.items.findIndex(it => it.id === id);
  if (existingIdx >= 0) {
    list.items.splice(existingIdx, 1);
    window._watchedItemIds.delete(id);
  } else {
    // If this is an episode, embed show/season/episode context so
    // updateContinueWatching() can find "next unwatched" without extra API calls.
    let item = { id, type, name, poster, watchedAt: Date.now() };
    if (type === 'episode') {
      const d = window._currentItemDetails;
      if (d) {
        item.showId = d.id;
        item.showTitle = d.title;
        item.showPoster = d.poster || '';
        const cache = window._episodeDataCache || {};
        const found = Object.values(cache).find(ep => String(ep.id) === String(id));
        // Prefer the season number stamped onto the cached episode itself
        // (set when that season's episode grid was loaded) over the single
        // "last season expanded" global, since more than one season can be
        // expanded at once and that global can point at the wrong one.
        item.seasonNum = (found && found.season_number != null) ? found.season_number : (window._currentSeasonNum || null);
        item.episodeNum = found ? found.episode_number : null;
      }
    }
    list.items.unshift(item);
    window._watchedItemIds.add(id);
    removeWatchedItemFromWatchlist(id, item.showId || (type === 'movie' ? id : null));
    if (typeof trackEvent === 'function') {
      trackEvent('watched', item.showId || id, item.showTitle || name, type === 'movie' ? 'movie' : 'series');
    }
  }
  
  list.updatedAt = Date.now();
  map['watch-history'] = list;
  saveLocalCustomListsMap(map);
  if (typeof scheduleCreatorSyncSave === 'function') scheduleCreatorSyncSave();

  // Update Continue Watching for episode toggles
  if (type === 'episode') {
    const d = window._currentItemDetails;
    if (d && d.id) updateContinueWatching(d.id).catch(() => {});
  }
  
  // Re-render UI
  if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard();
  
  // Update button if we are in the details modal
  const btn = document.getElementById('btnMarkWatched');
  if (btn) {
    if (window._watchedItemIds.has(id)) {
      btn.innerHTML = '<span style="margin-right:4px;">&#x2713;</span> Mark as unwatched';
      btn.classList.remove('primary');
      btn.classList.add('secondary');
    } else {
      btn.innerHTML = 'Mark as Watched';
      btn.classList.remove('secondary');
      btn.classList.add('primary');
    }
  }
  
  // To update posters dynamically, we need to refresh the grid if possible
  // For now, let's just let the user see it next time, or we can toggle class on existing DOM elements
  refreshWatchBadge(id, type);
};

// Batch-adds or batch-removes many items (episodes, mainly) to/from the
// Watch History list in a single localStorage write.
window.toggleBatchWatchStatus = function(items) {
  if (!items || !items.length) return { added: 0, removed: 0, nowWatched: false };

  const map = loadLocalCustomLists();
  const list = getOrCreateWatchHistoryList();

  const allWatched = items.every(it => window._watchedItemIds.has(String(it.id)));
  let added = 0;
  let removed = 0;

  if (allWatched) {
    const removeIds = new Set(items.map(it => String(it.id)));
    list.items = list.items.filter(it => !removeIds.has(String(it.id)));
    removeIds.forEach(id => {
      if (window._watchedItemIds.has(id)) {
        window._watchedItemIds.delete(id);
        removed++;
      }
    });
  } else {
    const existingIds = new Set(list.items.map(it => String(it.id)));
    items.forEach(it => {
      const id = String(it.id);
      if (!existingIds.has(id)) {
        list.items.unshift({ id: id, type: it.type, name: it.name, poster: it.poster,
          showId: it.showId || null, showTitle: it.showTitle || null, showPoster: it.showPoster || '',
          seasonNum: it.seasonNum || null, episodeNum: it.episodeNum || null, watchedAt: Date.now() });
        existingIds.add(id);
        added++;
      }
      window._watchedItemIds.add(id);
      removeWatchedItemFromWatchlist(id, it.showId || (it.type === 'movie' ? id : null));
    });
    if (typeof trackEventsBatch === 'function') {
      const seen = new Set();
      const trackItems = [];
      items.forEach((it) => {
        const key = it.showId || it.id;
        if (seen.has(key)) return;
        seen.add(key);
        trackItems.push({ id: it.showId || it.id, title: it.showTitle || it.name, mediaType: it.type === 'movie' ? 'movie' : 'series' });
      });
      trackEventsBatch('watched', trackItems);
    }
  }

  list.updatedAt = Date.now();
  map['watch-history'] = list;
  saveLocalCustomListsMap(map);
  if (typeof scheduleCreatorSyncSave === 'function') scheduleCreatorSyncSave();

  updateContinueWatchingForBatch(items).catch(() => {});

  if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard();

  items.forEach(it => refreshWatchBadge(it.id, it.type));

  return { added: added, removed: removed, nowWatched: !allWatched };
};

// Fetches every aired episode across every season of the show currently
// open in the item details modal and hands them all to
// toggleBatchWatchStatus in one call -- that function's own all-watched
// check is what decides whether this ends up marking the whole show
// watched or, if it already was, flipping it back to unwatched. Unaired
// episodes are left out entirely so a show with an upcoming season can
// still reach "fully watched" for everything that's actually aired so
// far, matching the same rule updateContinueWatching uses for the
// blue-checkmark badge.
window.markShowWatched = async function(imdbId) {
  const d = window._currentItemDetails;
  if (!d || !d.id || String(d.id) !== String(imdbId) || !d.seasonsData) return;

  const btn = document.getElementById('btnMarkShowWatched');
  const seasons = d.seasonsData.filter(s => s.season_number !== 0);
  if (!seasons.length) return;

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = 'Fetching episodes... (0/' + seasons.length + ')';
  }

  const tkInput = document.getElementById('tmdbKeyInput');
  const tmdbKey = (tkInput && tkInput.value ? tkInput.value.trim() : '') || localStorage.getItem('myListAddon:tmdbKey') || '';

  const allEpisodes = [];
  const CONCURRENCY = 4;
  let nextIdx = 0;
  let done = 0;
  let failedSeasons = 0;

  async function worker() {
    while (nextIdx < seasons.length) {
      const season = seasons[nextIdx++];
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 200 * attempt));
          const res = await fetch(ORIGIN + '/api/season?imdbId=' + encodeURIComponent(imdbId) +
            (d.tmdbId ? '&tmdbId=' + encodeURIComponent(d.tmdbId) : '') +
            '&seasonNum=' + season.season_number + (tmdbKey ? '&tmdbKey=' + encodeURIComponent(tmdbKey) : ''));
          const data = await res.json();
          if (data.ok && data.season && Array.isArray(data.season.episodes)) {
            data.season.episodes.forEach((ep) => {
              if (typeof isEpisodeAired === 'function' && !isEpisodeAired(ep)) return;
              allEpisodes.push({
                id: String(ep.id),
                type: 'episode',
                name: ep.name,
                poster: d.poster || '',
                showId: String(d.id),
                showTitle: d.title,
                showPoster: d.poster || '',
                seasonNum: season.season_number,
                episodeNum: ep.episode_number,
              });
            });
            break;
          }
        } catch (e) {
        }
        if (attempt === 2) failedSeasons++;
      }
      done++;
      if (btn) btn.innerHTML = 'Fetching episodes... (' + done + '/' + seasons.length + ')';
    }
  }

  await Promise.all(Array(Math.min(CONCURRENCY, seasons.length)).fill(0).map(worker));

  if (!btn) return;
  btn.disabled = false;

  if (!allEpisodes.length) {
    const stillFullyWatched = window._fullyWatchedShowIds && window._fullyWatchedShowIds.has(String(imdbId));
    if (failedSeasons > 0) {
      btn.innerHTML = "Couldn't load episodes -- try again";
    } else {
      btn.innerHTML = stillFullyWatched ? '<span style="margin-right:4px;">&#x2713;</span> Mark Whole Show Unwatched' : 'Mark Whole Show Watched';
    }
    return;
  }

  const result = window.toggleBatchWatchStatus(allEpisodes);
  const nowWatched = result.nowWatched;
  setShowFullyWatched(String(imdbId), nowWatched);
  if (nowWatched) {
    btn.innerHTML = '<span style="margin-right:4px;">&#x2713;</span> Mark Whole Show Unwatched';
    btn.classList.remove('primary');
    btn.classList.add('secondary');
  } else {
    btn.innerHTML = 'Mark Whole Show Watched';
    btn.classList.remove('secondary');
    btn.classList.add('primary');
  }
};

// One-way add to Watch History as watched -- unlike toggleBatchWatchStatus
// above (which flips a fully-watched batch back to unwatched, since it's a
// toggle), this only ever adds and skips anything already present. Used by
// the Trakt Export / Letterboxd Export importers' "mark as watched"
// option: re-running an import over the same export file (or one that
// overlaps an earlier one) should never accidentally unmark something that
// was already logged as watched, which a toggle-based call would risk the
// moment every item in a batch happened to already be watched.
window.addItemsToWatchHistory = async function(items) {
  if (!items || !items.length) return { added: 0, cwSucceeded: 0, cwTotal: 0 };
  const map = loadLocalCustomLists();
  const list = getOrCreateWatchHistoryList();
  const existingIds = new Set(list.items.map(it => String(it.id)));
  let added = 0;
  items.forEach(it => {
    const id = String(it.id);
    if (existingIds.has(id)) return;
    list.items.unshift({
      id: id, type: it.type, name: it.name, poster: it.poster,
      showId: it.showId || null, showTitle: it.showTitle || null, showPoster: it.showPoster || '',
      seasonNum: it.seasonNum != null ? it.seasonNum : null, episodeNum: it.episodeNum != null ? it.episodeNum : null,
      watchedAt: it.watchedAt || Date.now(),
    });
    existingIds.add(id);
    window._watchedItemIds.add(id);
    added++;
  });
  if (!added) return { added: 0, cwSucceeded: 0, cwTotal: 0 };
  if (typeof trackEventsBatch === 'function') {
    const seen = new Set();
    const trackItems = [];
    items.forEach((it) => {
      const key = it.showId || it.id;
      if (seen.has(key)) return;
      seen.add(key);
      trackItems.push({ id: it.showId || it.id, title: it.showTitle || it.name, mediaType: it.type === 'movie' ? 'movie' : 'series' });
    });
    trackEventsBatch('watched', trackItems);
  }
  list.updatedAt = Date.now();
  map['watch-history'] = list;
  saveLocalCustomListsMap(map);
  if (typeof scheduleCreatorSyncSave === 'function') scheduleCreatorSyncSave();
  // Awaited (unlike toggleBatchWatchStatus's own fire-and-forget call
  // above) -- this is what a bulk importer processing dozens or hundreds
  // of shows actually needs: the caller's own "done" message shouldn't
  // fire while most of the batch is still mid-flight, and cwSucceeded/
  // cwTotal below let it report real numbers instead of assuming success.
  const cwResult = await updateContinueWatchingForBatch(items);
  if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard();
  items.forEach(it => refreshWatchBadge(it.id, it.type));
  return { added: added, cwSucceeded: cwResult.succeeded, cwTotal: cwResult.total };
};

// --- Continue Watching --------------------------------------------------------

// Drops any but the first entry per showId (items are always unshifted,
// so first = most recently added) -- shared by getOrCreateContinueWatchingList
// (self-healing local data left over from a fixed race condition, see its
// own comment) and loadCreatorSync's sync-down (server data can carry the
// same kind of duplicate forward if it was ever written by an older,
// race-prone version of this code, or by the cron/Auto-Track ping in a
// narrow window against a concurrent client save).
function dedupeContinueWatchingItems(items) {
  if (!items || !items.length) return items || [];
  const seenShowIds = new Set();
  const watchedSet = window._watchedItemIds || new Set();
  return items.filter((it) => {
    if (!it) return false;
    // An episode already marked as watched in Watch History must never be in Continue Watching
    if (it.id && watchedSet.has(String(it.id))) return false;
    if (!it.showId) return true;
    if (seenShowIds.has(String(it.showId))) return false;
    seenShowIds.add(String(it.showId));
    return true;
  });
}

function getOrCreateContinueWatchingList() {
  const map = loadLocalCustomLists();
  if (!map['continue-watching']) {
    map['continue-watching'] = {
      slug: 'continue-watching',
      localSlug: 'continue-watching',
      name: 'Continue Watching',
      description: 'Next unwatched episode for each show you have started.',
      type: 'series',
      items: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    saveLocalCustomListsMap(map);
  } else if (!map['continue-watching'].slug) {
    map['continue-watching'].slug = 'continue-watching';
    saveLocalCustomListsMap(map);
  }
  const cwList = map['continue-watching'];
  // Self-heals data left over from a race condition in a previous version
  // of updateContinueWatching, where concurrent commits for different
  // shows could clobber each other and leave a stale duplicate entry for
  // the same show sitting alongside a fresh one (see
  // updateContinueWatching's own comment -- the write itself is fixed now,
  // this just cleans up whatever it already left behind). Only saves if
  // anything actually needed dropping.
  if (cwList.items && cwList.items.length) {
    const deduped = dedupeContinueWatchingItems(cwList.items);
    if (deduped.length !== cwList.items.length) {
      cwList.items = deduped;
      cwList.updatedAt = Date.now();
      saveLocalCustomListsMap(map);
      if (typeof scheduleCreatorSyncSave === 'function') scheduleCreatorSyncSave();
    }
  }
  return cwList;
}

// Serializes the read-modify-write of localStorage's continue-watching
// list (and the fullyWatchedShowIds/inProgressShowIds it triggers) across
// concurrent updateContinueWatching calls -- see that function's own
// comment for why. Network fetches still run in parallel across workers;
// only the actual commit (load list, mutate, save list) queues up one at
// a time, so it can never race with another commit in flight.
let cwCommitLock = Promise.resolve();
function withCwCommitLock(fn) {
  const run = cwCommitLock.then(fn, fn);
  // Swallow errors here so one failed commit doesn't permanently wedge the
  // queue for every commit after it -- the actual error still propagates
  // to whoever's awaiting "run" itself.
  cwCommitLock = run.then(() => {}, () => {});
  return run;
}

async function updateContinueWatching(showId) {
  if (!showId) return { ok: false };

  const tkInput = document.getElementById('tmdbKeyInput');
  const tmdbKey = tkInput && tkInput.value ? tkInput.value.trim() : '';

  // Reading Watch History here (outside the commit lock) is safe: nothing
  // concurrently writes to Watch History during a Continue Watching batch
  // -- see addItemsToWatchHistory, which always finishes adding everything
  // to Watch History before it ever calls updateContinueWatchingForBatch.
  const watchedEps = (loadLocalCustomLists()['watch-history']?.items || []).filter(it =>
    it.type === 'episode' && it.showId === showId && it.seasonNum != null && it.episodeNum != null
  );

  if (!watchedEps.length) {
    return withCwCommitLock(() => {
      const map = loadLocalCustomLists();
      const cwList = getOrCreateContinueWatchingList();
      cwList.items = cwList.items.filter(it => it.showId !== showId);
      map['continue-watching'] = cwList;
      cwList.updatedAt = Date.now();
      saveLocalCustomListsMap(map);
      if (typeof scheduleCreatorSyncSave === 'function') scheduleCreatorSyncSave();
      if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard();
      setShowFullyWatched(showId, false);
      setShowInProgress(showId, false);
      return { ok: true };
    });
  }

  const latest = watchedEps.reduce((best, ep) => {
    if (ep.seasonNum > best.seasonNum) return ep;
    if (ep.seasonNum === best.seasonNum && ep.episodeNum > best.episodeNum) return ep;
    return best;
  }, watchedEps[0]);

  // Whether every currently-aired episode has been watched -- stays null
  // if a fetch below fails, so a network hiccup can't flip the badge one
  // way or the other; it just leaves whatever was already known. Also
  // doubles as this function's own success signal (see the "ok" returned
  // below) -- a caller processing many shows at once (see
  // updateContinueWatchingForBatch) needs to tell "genuinely fully
  // watched" apart from "the fetch failed", since both leave no Continue
  // Watching entry behind but only one of them should be retried.
  let showFullyWatched = null;
  // Computed here (network phase, runs concurrently across workers) and
  // only written to the list inside the locked commit phase below -- see
  // withCwCommitLock's own comment for why the write itself can't race.
  let newEntry = null;

  try {
    const res = await fetch(ORIGIN + '/api/season?imdbId=' + encodeURIComponent(showId) +
      '&seasonNum=' + latest.seasonNum + '&tmdbKey=' + encodeURIComponent(tmdbKey));
    const data = await res.json();
    if (!data.ok || !data.season || !data.season.episodes) throw new Error('no data');

    const eps = data.season.episodes.filter(ep => isEpisodeAired(ep));
    const nextInSeason = eps.find(ep => ep.episode_number > latest.episodeNum);

    if (nextInSeason) {
      newEntry = {
        id: String(nextInSeason.id),
        type: 'episode',
        // Bare episode name -- matching Watch History's own item.name
        // convention. formatWatchItemLabel already reconstructs "Show
        // SxxExx" from showTitle/seasonNum/episodeNum for display, so a
        // pre-formatted composite string here would show that same
        // show/season/episode prefix twice (once from formatWatchItemLabel
        // itself, once baked into this string as its subtitle).
        name: nextInSeason.name,
        poster: latest.showPoster || '',
        showId: showId,
        showTitle: latest.showTitle || '',
        showPoster: latest.showPoster || '',
        seasonNum: latest.seasonNum,
        episodeNum: nextInSeason.episode_number
      };
      showFullyWatched = false;
    } else {
      const nextSeasonNum = latest.seasonNum + 1;
      const res2 = await fetch(ORIGIN + '/api/season?imdbId=' + encodeURIComponent(showId) +
        '&seasonNum=' + nextSeasonNum + '&tmdbKey=' + encodeURIComponent(tmdbKey));
      const data2 = await res2.json();
      if (data2.ok && data2.season && data2.season.episodes) {
        const nextEps = data2.season.episodes.filter(ep => isEpisodeAired(ep));
        const firstNext = nextEps[0];
        if (firstNext) {
          newEntry = {
            id: String(firstNext.id),
            type: 'episode',
            name: firstNext.name,
            poster: latest.showPoster || '',
            showId: showId,
            showTitle: latest.showTitle || '',
            showPoster: latest.showPoster || '',
            seasonNum: nextSeasonNum,
            episodeNum: firstNext.episode_number
          };
          showFullyWatched = false;
        } else {
          // TMDB knows about the next season but it hasn't started airing
          // yet -- nothing unwatched-and-aired remains right now.
          showFullyWatched = true;
        }
      } else {
        // No further season at all -- this was the last one, and it's
        // fully watched.
        showFullyWatched = true;
      }
    }
  } catch (e) {
    // Silent failure -- showFullyWatched stays null, see comment above.
  }

  return withCwCommitLock(() => {
    const map = loadLocalCustomLists();
    const cwList = getOrCreateContinueWatchingList();
    // Removes any existing entry for this show -- including a stale one
    // that might otherwise never get cleaned up -- before (maybe) adding
    // the fresh one computed above.
    cwList.items = cwList.items.filter(it => it.showId !== showId);
    if (newEntry) cwList.items.unshift(newEntry);
    map['continue-watching'] = cwList;
    cwList.updatedAt = Date.now();
    saveLocalCustomListsMap(map);
    if (typeof scheduleCreatorSyncSave === 'function') scheduleCreatorSyncSave();
    if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard();
    if (showFullyWatched !== null) setShowFullyWatched(showId, showFullyWatched);
    if (showFullyWatched === false) setShowInProgress(showId, true);
    return { ok: showFullyWatched !== null };
  });
}

// Runs updateContinueWatching for every distinct show in a batch, a few at
// a time rather than strictly one-at-a-time -- a large batch (e.g. a
// fresh Trakt/Letterboxd "mark as watched" import, which can easily span
// dozens to hundreds of distinct shows) doing one full TMDB round trip per
// show in sequence was slow enough, and any one transient failure (rate
// limit, network blip) silently dropped that show from Continue Watching
// forever with no visibility, that it looked like the feature just "didn't
// add all shows it should have" -- which it didn't, but not because
// anything was actually broken beyond not reporting the gap. Tracks real
// success/failure (via updateContinueWatching's own return value, since it
// swallows its own network errors internally rather than throwing) so a
// caller doing a large bulk operation can report honest numbers instead of
// assuming everything worked.
async function updateContinueWatchingForBatch(items) {
  const showIds = [...new Set(items.map(it => it.showId).filter(Boolean))];
  if (!showIds.length) return { succeeded: 0, total: 0 };
  const CONCURRENCY = 3;
  let nextIdx = 0;
  let succeeded = 0;
  async function worker() {
    while (nextIdx < showIds.length) {
      const showId = showIds[nextIdx++];
      try {
        const result = await updateContinueWatching(showId);
        if (result && result.ok) succeeded++;
      } catch (e) {
        // updateContinueWatching doesn't normally throw (see its own
        // try/catch), but guard anyway so one unexpected error can't abort
        // the rest of the batch.
      }
    }
  }
  const workers = Array(Math.min(CONCURRENCY, showIds.length)).fill(0).map(worker);
  await Promise.all(workers);
  return { succeeded: succeeded, total: showIds.length };
}

// Removes a show from Continue Watching without marking anything as
// watched -- the person just doesn't want to be reminded about it right
// now. Records exactly which watched snapshot (season/episode) this
// dismissal applies to rather than a plain "dismissed forever" flag --
// see checkForNewEpisodes and handleSubtitlesTrack's own "stillDismissed"
// comments (both further down this file) for the matching server-side
// check -- so watching a genuinely newer episode later naturally
// supersedes the dismissal and lets the show reappear on its own.
// Referenced by the "x" button on every Continue Watching card
// (buildLocalListCardHtml/livePreviewPosterHtml's removeBtn).
function dismissContinueWatchingShow(showId, btn) {
  if (!showId) return;
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
  if (!window._dismissedContinueWatching) window._dismissedContinueWatching = {};

  const history = loadLocalCustomLists()['watch-history'];
  const watchedEps = (history ? history.items : []).filter(it =>
    it.type === 'episode' && it.showId === showId && it.seasonNum != null && it.episodeNum != null
  );
  if (watchedEps.length) {
    const latest = watchedEps.reduce((best, ep) => {
      if (ep.seasonNum > best.seasonNum) return ep;
      if (ep.seasonNum === best.seasonNum && ep.episodeNum > best.episodeNum) return ep;
      return best;
    }, watchedEps[0]);
    window._dismissedContinueWatching[showId] = { seasonNum: latest.seasonNum, episodeNum: latest.episodeNum };
  }
  try {
    localStorage.setItem('myListAddon:dismissedContinueWatching', JSON.stringify(window._dismissedContinueWatching));
  } catch (e) {
    // non-critical -- the dismissal still applies for this session either way
  }

  // Goes through the same commit lock updateContinueWatching's own writes
  // do, so this can't race with an in-flight commit for the same (or any
  // other) show -- see withCwCommitLock's own comment.
  withCwCommitLock(() => {
    const map = loadLocalCustomLists();
    const cwList = getOrCreateContinueWatchingList();
    cwList.items = cwList.items.filter(it => it.showId !== showId);
    map['continue-watching'] = cwList;
    cwList.updatedAt = Date.now();
    saveLocalCustomListsMap(map);
    if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard({ silent: true });
  });

  // Dismissed is functionally "caught up" from this add-on's own
  // perspective (same bucket checkForNewEpisodes tracks it in
  // server-side) -- flips the badge from amber back to the blue
  // checkmark, and the cron will still periodically check TMDB in case a
  // real new episode later supersedes this dismissal.
  setShowFullyWatched(showId, true);
  if (typeof scheduleTrackingSync === 'function') scheduleTrackingSync();
}


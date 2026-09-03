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
  if (customListDraftType !== 'mixed') {
    if (customListDraftItems.length > 0 && customListDraftType !== itemType) {
      customListDraftType = 'mixed';
      updateCustomListTypeRadio('mixed');
    } else if (!customListDraftItems.length && !customListDraftType) {
      customListDraftType = itemType;
      updateCustomListTypeRadio(itemType);
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

function removeAllCustomListDraftPicks() {
  if (!customListDraftItems.length) return;
  if (!confirm('Remove all ' + customListDraftItems.length + ' picks? This cannot be undone.')) return;
  customListDraftItems = [];
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
    if (typeof renderLivePreview === 'function') renderLivePreview();
    showAddedToast('"' + name + '" updated \u2713');
  } else {
    const visSelect = document.getElementById('customListVisibilitySelect');
    const visibility = visSelect && visSelect.value === 'private' ? 'private' : 'public';
    if (activeCreator) {
      const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
      fetch(ORIGIN + '/api/creator/lists/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          creatorName: activeCreator.creatorName,
          creatorKey: creatorKey,
          name: name,
          type: listType,
          items: customListDraftItems,
          visibility: visibility,
        }),
      }).then(async (res) => {
        const data = await res.json();
        if (!data.ok) {
          alert('Could not save list: ' + (data.error || 'unknown error'));
          return;
        }
        const slug = data.slug;
        if (listType === 'mixed') {
          const movies = customListDraftItems.filter(it => (it.kind === 'movie' || it.type === 'movie' || (!it.kind && !it.type && !it.showId)));
          const series = customListDraftItems.filter(it => (it.kind === 'series' || it.type === 'series' || it.type === 'tv' || it.showId));
          const moviePayload = { listId: generateChannelId(), creatorSlug: slug, listSlug: slug, creatorOwner: activeCreator.creatorName, type: 'movie', items: movies, shuffle: shuffle, publishedUrl: visibility === 'public' ? data.url : undefined };
          addRow(name + ' (Movies)', 'customlist:v1:' + JSON.stringify(moviePayload), 'movie', true, 'Custom Lists');
          const seriesPayload = { listId: generateChannelId(), creatorSlug: slug, listSlug: slug, creatorOwner: activeCreator.creatorName, type: 'series', items: series, shuffle: shuffle, publishedUrl: visibility === 'public' ? data.url : undefined };
          addRow(name + ' (Shows)', 'customlist:v1:' + JSON.stringify(seriesPayload), 'series', true, 'Custom Lists');
        } else {
          const payload = { listId: generateChannelId(), creatorSlug: slug, listSlug: slug, creatorOwner: activeCreator.creatorName, type: listType, items: customListDraftItems, shuffle: shuffle, publishedUrl: visibility === 'public' ? data.url : undefined };
          addRow(name, 'customlist:v1:' + JSON.stringify(payload), listType, true, 'Custom Lists');
        }
        saveState();
        renderCreatorDashboard();
        if (typeof renderLivePreview === 'function') renderLivePreview();
        if (typeof updateAllListAddButtons === 'function') updateAllListAddButtons();
        if (typeof showSavedCustomListModal === 'function') {
          showSavedCustomListModal(name, visibility, data.url);
        } else {
          showAddedToast('"' + name + '" saved \u2713');
        }
      }).catch(() => {
        alert('Network error while saving list.');
      });
    } else {
      const map = loadLocalCustomLists();
      const base = slugify(name) || 'list';
      let slug = base;
      let n = 2;
      while (map[slug]) {
        slug = base + '-' + n;
        n++;
      }
      map[slug] = {
        slug: slug,
        name: name,
        type: listType,
        items: customListDraftItems,
        visibility: visibility,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      saveLocalCustomListsMap(map);
      if (typeof scheduleCreatorSyncSave === 'function') scheduleCreatorSyncSave();

      if (listType === 'mixed') {
        const movies = customListDraftItems.filter(it => (it.kind === 'movie' || it.type === 'movie' || (!it.kind && !it.type && !it.showId)));
        const series = customListDraftItems.filter(it => (it.kind === 'series' || it.type === 'series' || it.type === 'tv' || it.showId));
        const moviePayload = { listId: generateChannelId(), localSlug: slug, listSlug: slug, type: 'movie', items: movies, shuffle: shuffle };
        addRow(name + ' (Movies)', 'customlist:v1:' + JSON.stringify(moviePayload), 'movie', true, 'Custom Lists');
        const seriesPayload = { listId: generateChannelId(), localSlug: slug, listSlug: slug, type: 'series', items: series, shuffle: shuffle };
        addRow(name + ' (Shows)', 'customlist:v1:' + JSON.stringify(seriesPayload), 'series', true, 'Custom Lists');
      } else {
        const payload = { listId: generateChannelId(), localSlug: slug, listSlug: slug, type: listType, items: customListDraftItems, shuffle: shuffle };
        addRow(name, 'customlist:v1:' + JSON.stringify(payload), listType, true, 'Custom Lists');
      }
      saveState();
      renderCreatorDashboard();
      if (typeof renderLivePreview === 'function') renderLivePreview();
      if (typeof updateAllListAddButtons === 'function') updateAllListAddButtons();
      showAddedToast('"' + name + '" saved \u2713');
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
}

// Saves changes to a list already living on the creator's profile --
// straight back to the server (no local row involved at all, unlike every
// other save path here), since a Creator-owned list's canonical copy is
// the one on the server, not a row in this particular install link.
async function saveCreatorListEdit(name) {
  if (!activeCreator) {
    alert('Your Profile session expired -- please restore it again.');
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
    if (editingCreatorListSlug === 'watchlist') {
      const map = loadLocalCustomLists();
      if (map['watchlist']) {
        map['watchlist'].items = customListDraftItems;
        map['watchlist'].visibility = visibility;
        map['watchlist'].updatedAt = Date.now();
        saveLocalCustomListsMap(map);
      }
      if (typeof pushTrackingSync === 'function') pushTrackingSync();
    }
    if (typeof syncCustomListToCatalogRows === 'function') {
      syncCustomListToCatalogRows(editingCreatorListSlug, customListDraftItems, name, customListDraftType);
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
async function saveLocalCustomListEdit(name) {
  const map = loadLocalCustomLists();
  const slug = editingLocalCustomListSlug;
  const existing = map[slug];
  const visSelect = document.getElementById('customListVisibilitySelect');
  const visibility = visSelect && visSelect.value === 'public' ? 'public' : 'private';
  map[slug] = {
    slug: slug,
    name: name,
    type: customListDraftType,
    items: customListDraftItems,
    visibility: visibility,
    createdAt: existing ? existing.createdAt : Date.now(),
    updatedAt: Date.now(),
  };
  saveLocalCustomListsMap(map);
  if (slug === 'watchlist') {
    if (typeof pushTrackingSync === 'function') pushTrackingSync();
  }
  if (typeof scheduleCreatorSyncSave === 'function') {
    scheduleCreatorSyncSave();
  }
  if (typeof syncCustomListToCatalogRows === 'function') {
    syncCustomListToCatalogRows(slug, customListDraftItems, name, customListDraftType);
  }

  let finalUrl = ((typeof activeCreator !== 'undefined' && activeCreator)
    ? (location.origin + '/lists/' + activeCreator.creatorName + '/' + (slug || 'watchlist'))
    : (location.origin + '/lists/' + (slug === 'watchlist' ? 'watchlist' : ('custom/' + slug))));

  if (typeof activeCreator !== 'undefined' && activeCreator) {
    const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
    if (creatorKey) {
      try {
        const res = await fetch(ORIGIN + '/api/creator/lists/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            creatorName: activeCreator.creatorName,
            creatorKey: creatorKey,
            slug: slug,
            name: name,
            type: customListDraftType,
            items: customListDraftItems,
            visibility: visibility,
          }),
        });
        const data = await res.json();
        if (data.ok && data.url) {
          finalUrl = data.url;
        }
      } catch (e) {}
    }
  }

  if (typeof showSavedCustomListModal === 'function') {
    showSavedCustomListModal(name, visibility, finalUrl);
  } else {
    showAddedToast('"' + name + '" updated \u2713');
  }
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
  const nameInput = document.getElementById('customListNameInput');
  const currentListName = nameInput ? nameInput.value.trim() : '';
  const isEditing = !!(editingCreatorListSlug || editingLocalCustomListSlug || editingCustomListUrlInput);
  if (titleEl) {
    if (isEditing) {
      titleEl.textContent = currentListName ? ('Edit ' + currentListName) : 'Edit List';
    } else {
      titleEl.textContent = 'Create a Custom List';
    }
  }

  saveBtn.textContent = 'Save';
  if (cancelBtn) {
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.display = isEditing ? '' : 'none';
  }
  if (visRow) {
    visRow.style.display = '';
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

// Every key a watch-history item can be looked up by.
//
// These permutations used to be spelled out separately in three places (the
// initial index build, and the add/remove halves of toggleWatchStatus), and
// computeWatchBadgeState carried a linear scan of the whole history as a
// safety net for anything they missed. That scan ran for every poster that
// was NOT already known to be watched -- which is most of them -- so a page
// of 1,200 posters against a 1,200-item history cost 1.44 million
// comparisons per pass. Collecting the permutations here means the set can
// answer every one of those questions in O(1), and the scan can go.
function watchedIndexKeysFor(it, details) {
  if (!it) return [];
  const keys = [];
  if (it.id) keys.push(String(it.id));
  if (it.imdbId) keys.push(String(it.imdbId));
  if (it.tmdbId) {
    keys.push(String(it.tmdbId));
    keys.push('tmdb:' + it.tmdbId);
  }
  if (it.seasonNum != null && it.episodeNum != null) {
    const se = ':' + it.seasonNum + ':' + it.episodeNum;
    if (it.showId) {
      const sid = String(it.showId);
      keys.push(sid + se);
      // A show is stored sometimes as "tmdb:123" and sometimes as "123",
      // while the poster on screen may carry either form in data-show-id.
      // Indexing both directions is what the old linear scan was really
      // doing when it compared against 'tmdb:' + sid.
      if (sid.indexOf('tmdb:') === 0) keys.push(sid.slice(5) + se);
      else keys.push('tmdb:' + sid + se);
    }
    if (it.showTitle) keys.push(String(it.showTitle) + se);
    if (details) {
      if (details.id) keys.push(String(details.id) + se);
      if (details.imdbId) keys.push(String(details.imdbId) + se);
      if (details.tmdbId) keys.push('tmdb:' + details.tmdbId + se);
      if (details.title) keys.push(String(details.title) + se);
    }
  }
  return keys;
}
window.watchedIndexKeysFor = watchedIndexKeysFor;

// Rebuilds the whole index from an item array. Cheap enough to run on any
// change (one pass over the history) and far cheaper than the per-poster
// scan it replaces.
function rebuildWatchedIndex(items) {
  const list = Array.isArray(items) ? items : [];
  window._rawWatchHistoryItems = list;
  window._watchedItemIds = new Set();
  for (let i = 0; i < list.length; i++) {
    const keys = watchedIndexKeysFor(list[i], null);
    for (let k = 0; k < keys.length; k++) window._watchedItemIds.add(keys[k]);
  }
  window._watchedIndexLength = list.length;
  // The old observer re-badged every poster on the page on ANY mutation,
  // which incidentally covered the case where watch state changes after the
  // posters are already on screen -- history arriving from the account
  // mid-session, for instance. Now that it only looks at nodes as they are
  // added, that case needs saying out loud: whenever the index is rebuilt,
  // sweep what is currently visible. One pass over the posters on screen,
  // not one pass per poster per mutation.
  if (typeof window._badgeExistingPosters === 'function') {
    try { window._badgeExistingPosters(); } catch (e) {}
  }
  return window._watchedItemIds;
}
window.rebuildWatchedIndex = rebuildWatchedIndex;

// The scan that was removed also quietly covered the case where the history
// array had changed without the set being updated alongside it. That is
// still worth guarding, just not once per poster: a length change is enough
// to notice, and the rebuild is a single pass.
function ensureWatchedIndexFresh() {
  const list = window._rawWatchHistoryItems;
  if (!Array.isArray(list)) return;
  if (window._watchedIndexLength !== list.length) rebuildWatchedIndex(list);
}
window.ensureWatchedIndexFresh = ensureWatchedIndexFresh;
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
function computeWatchBadgeState(id, type, el) {
  if (type === 'series') {
    if (window._fullyWatchedShowIds && window._fullyWatchedShowIds.has(id)) return 'full';
    if (window._inProgressShowIds && window._inProgressShowIds.has(id)) return 'partial';
    return null;
  }
  if (window._watchedItemIds && window._watchedItemIds.has(id)) return 'full';
  if (el && el.dataset) {
    const s = el.dataset.season;
    const ep = el.dataset.episode;
    const sid = el.dataset.showId;
    if (s != null && ep != null) {
      if (sid && window._watchedItemIds) {
        const sidStr = String(sid);
        if (window._watchedItemIds.has(sidStr + ':' + s + ':' + ep)) return 'full';
        // Same show, other id spelling -- see watchedIndexKeysFor.
        const alt = sidStr.indexOf('tmdb:') === 0 ? sidStr.slice(5) : ('tmdb:' + sidStr);
        if (window._watchedItemIds.has(alt + ':' + s + ':' + ep)) return 'full';
      }
      const d = window._currentItemDetails;
      if (d) {
        if (d.id && window._watchedItemIds && window._watchedItemIds.has(d.id + ':' + s + ':' + ep)) return 'full';
        if (d.tmdbId && window._watchedItemIds && window._watchedItemIds.has('tmdb:' + d.tmdbId + ':' + s + ':' + ep)) return 'full';
        if (d.title && window._watchedItemIds && window._watchedItemIds.has(d.title + ':' + s + ':' + ep)) return 'full';
      }
    }
  }
  return null;
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
        rebuildWatchedIndex(items);
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
      if (!window._rawWatchHistoryItems || !window._rawWatchHistoryItems.length) window._rawWatchHistoryItems = rawWh;
      // Legacy standalone key -- merged into the same index rather than
      // indexed differently, so lookups need only consult one set.
      rawWh.forEach((it) => {
        const keys = watchedIndexKeysFor(it, null);
        for (let k = 0; k < keys.length; k++) window._watchedItemIds.add(keys[k]);
      });
      window._watchedIndexLength = (window._rawWatchHistoryItems || []).length;
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

  // Badges new posters as they appear.
  //
  // This used to run its whole body synchronously on every mutation record,
  // and the body was a document-wide querySelectorAll for
  // .clickable-poster/.clickable-episode followed by a badge computation for
  // every match -- everything already on the page, not just what had just
  // changed. Two things made that expensive enough to notice:
  //
  //   * The grid renderer appends posters in batches across animation frames
  //     (renderPosterGridChunked, 23_client-list-management.js), so a 1,200
  //     item See All page fires this ~20 times over a grid that keeps
  //     growing -- re-badging everything already placed, each time.
  //   * Inserting a badge is itself a childList mutation inside the observed
  //     subtree, so every pass scheduled more passes.
  //
  // Now: mutation records are collected and drained once per animation
  // frame, and only the nodes that were actually added get looked at. The
  // badge insertions still re-enter, but an inserted overlay contains no
  // posters, so that pass finds nothing and costs nothing. Work per frame is
  // proportional to what just appeared rather than to the size of the page.
  let _badgeQueue = [];
  let _badgeScheduled = false;

  function badgeElement(el) {
    if (!el || !el.dataset) return;
    const id = el.dataset.id;
    if (!id) return;
    const state = computeWatchBadgeState(id, el.dataset.type, el);
    if (!state) return;
    const wrap = findWatchBadgeWrap(el);
    if (!wrap) return;
    // Checking wrap (not el) for an existing badge matters: when el is an
    // <img> (it can't hold children), wrap is el.parentElement -- checking el
    // itself here would always find nothing and insert another badge every
    // time this runs.
    if (!wrap.querySelector('.watch-indicator-overlay')) {
      wrap.insertAdjacentHTML('beforeend', watchBadgeHtml(state));
    }
  }

  function drainBadgeQueue() {
    _badgeScheduled = false;
    const nodes = _badgeQueue;
    _badgeQueue = [];
    if (!window._watchedItemIds) return;
    // One freshness check per frame rather than one per poster -- see
    // ensureWatchedIndexFresh.
    if (typeof ensureWatchedIndexFresh === 'function') ensureWatchedIndexFresh();
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!node || node.nodeType !== 1) continue;
      if (!node.isConnected) continue;
      if (node.matches && node.matches('.clickable-poster, .clickable-episode')) badgeElement(node);
      if (node.querySelectorAll) {
        const found = node.querySelectorAll('.clickable-poster, .clickable-episode');
        for (let j = 0; j < found.length; j++) badgeElement(found[j]);
      }
    }
  }

  const observer = new MutationObserver((mutations) => {
    for (let i = 0; i < mutations.length; i++) {
      const added = mutations[i].addedNodes;
      for (let j = 0; j < added.length; j++) _badgeQueue.push(added[j]);
    }
    if (!_badgeQueue.length || _badgeScheduled) return;
    _badgeScheduled = true;
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(drainBadgeQueue);
    else setTimeout(drainBadgeQueue, 16);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Badges anything already on the page when this first runs, since the
  // observer only ever sees what arrives after it.
  window._badgeExistingPosters = function() {
    _badgeQueue.push(document.body);
    if (_badgeScheduled) return;
    _badgeScheduled = true;
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(drainBadgeQueue);
    else setTimeout(drainBadgeQueue, 16);
  };
  window._badgeExistingPosters();
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
  document.querySelectorAll('.clickable-poster[data-id="' + escapeAttr(strId) + '"], .clickable-episode[data-id="' + escapeAttr(strId) + '"]').forEach(el => {
    const wrap = findWatchBadgeWrap(el);
    if (!wrap) return;
    const state = computeWatchBadgeState(strId, type || (el.dataset ? el.dataset.type : undefined), el);
    const overlay = wrap.querySelector('.watch-indicator-overlay');
    if (state) {
      if (!overlay) {
        wrap.insertAdjacentHTML('beforeend', watchBadgeHtml(state));
      } else {
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
  if (isFullyWatched && typeof cleanWatchedFromWatchlists === 'function') {
    cleanWatchedFromWatchlists();
  }
  // Keeps the already-computed Airing Next list in sync with a watched-
  // state change the instant it happens (e.g. "Mark Whole Show Unwatched")
  // instead of leaving a stale entry on screen until the next scheduled
  // refresh -- see syncAiringNextWatchState's own comment further down.
  if (typeof syncAiringNextWatchState === 'function') syncAiringNextWatchState();
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
  if (typeof syncAiringNextWatchState === 'function') syncAiringNextWatchState();
}

// Automatically removes a watched item from any Custom List designated as the Watchlist.
// Movies are removed as soon as they are watched.
// TV shows are ONLY removed when every episode is watched (in _fullyWatchedShowIds).
function removeWatchedItemFromWatchlist(id, showId, extraIds) {
  if (!id && !showId && (!extraIds || !extraIds.length)) return;
  const shouldRemove = (function() {
    try { return localStorage.getItem('myListAddon:removeWatchedFromWatchlist') !== '0'; }
    catch (e) { return true; }
  })();
  if (!shouldRemove) return;
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
  if (Array.isArray(extraIds)) extraIds.forEach(addId);
  if (window._currentItemDetails) {
    addId(window._currentItemDetails.id);
    addId(window._currentItemDetails.imdbId);
    addId(window._currentItemDetails.tmdbId);
  }

  const fullyWatchedShowIds = window._fullyWatchedShowIds || new Set();

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
      const isSeries = it.type === 'series' || it.type === 'tv' || it.type === 'show';

      if (isSeries) {
        if (itId && fullyWatchedShowIds.has(itId)) return false;
        if (itImdbId && fullyWatchedShowIds.has(itImdbId)) return false;
        if (itShowId && fullyWatchedShowIds.has(itShowId)) return false;
        if (itTmdbId && fullyWatchedShowIds.has(itTmdbId)) return false;
        if (itId && itId.startsWith('tmdb:') && fullyWatchedShowIds.has(itId.slice(5))) return false;
        if (itId && /^\d+$/.test(itId) && fullyWatchedShowIds.has('tmdb:' + itId)) return false;
        return true;
      }

      if (itId && (targetIds.has(itId) || (/^\d+$/.test(itId) && targetIds.has('tmdb:' + itId)) || (itId.startsWith('tmdb:') && targetIds.has(itId.slice(5))))) return false;
      if (itImdbId && targetIds.has(itImdbId)) return false;
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
    if (typeof pushTrackingSync === 'function') pushTrackingSync();
    if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard({ silent: true });
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
        const isSeries = it.type === 'series' || it.type === 'tv' || it.type === 'show';

        if (isSeries) {
          if (itId && fullyWatchedShowIds.has(itId)) return false;
          if (itImdbId && fullyWatchedShowIds.has(itImdbId)) return false;
          if (itShowId && fullyWatchedShowIds.has(itShowId)) return false;
          if (itTmdbId && fullyWatchedShowIds.has(itTmdbId)) return false;
          if (itId && itId.startsWith('tmdb:') && fullyWatchedShowIds.has(itId.slice(5))) return false;
          if (itId && /^\d+$/.test(itId) && fullyWatchedShowIds.has('tmdb:' + itId)) return false;
          return true;
        }

        if (itId && (targetIds.has(itId) || (/^\d+$/.test(itId) && targetIds.has('tmdb:' + itId)) || (itId.startsWith('tmdb:') && targetIds.has(itId.slice(5))))) return false;
        if (itImdbId && targetIds.has(itImdbId)) return false;
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

// Scans Watch History and removes watched items from the user's Watchlist.
// Rule: movies are removed as soon as they appear in Watch History.
//       TV shows are removed ONLY when every episode has been watched
//       (i.e. the show appears in window._fullyWatchedShowIds). A show with
//       even one unwatched episode stays in the Watchlist so the user doesn't
//       lose track of it mid-series.
function cleanWatchedFromWatchlists() {
  const shouldRemove = (function() {
    try { return localStorage.getItem('myListAddon:removeWatchedFromWatchlist') !== '0'; }
    catch (e) { return true; }
  })();
  if (!shouldRemove) return;

  const map = typeof loadLocalCustomLists === 'function' ? loadLocalCustomLists() : {};
  const historyList = map['watch-history'];
  const watchedItems = (historyList && Array.isArray(historyList.items)) ? historyList.items : [];
  const hasWatchedIds = watchedItems.length > 0 || (window._watchedItemIds && window._watchedItemIds.size > 0);
  const hasFullyWatched = window._fullyWatchedShowIds && window._fullyWatchedShowIds.size > 0;
  if (!hasWatchedIds && !hasFullyWatched) return;

  // Build the set of watched movie/episode IDs (used only for movies).
  const watchedIds = new Set(window._watchedItemIds ? Array.from(window._watchedItemIds) : []);
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
  });

  // Fully-watched show IDs (only populated once the cron/logic marks a
  // show as completely done -- a partially-watched show is NOT included).
  const fullyWatchedShowIds = window._fullyWatchedShowIds || new Set();

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
      const itTmdbId = String(it.tmdbId || '');
      const isSeries = it.type === 'series' || it.type === 'tv' || it.type === 'show';

      if (isSeries) {
        // TV shows: only remove when fully watched (all episodes done).
        if (itId && fullyWatchedShowIds.has(itId)) return false;
        if (itImdbId && fullyWatchedShowIds.has(itImdbId)) return false;
        if (itTmdbId && fullyWatchedShowIds.has(itTmdbId)) return false;
        if (itId && itId.startsWith('tmdb:') && fullyWatchedShowIds.has(itId.slice(5))) return false;
        if (itId && /^\d+$/.test(itId) && fullyWatchedShowIds.has('tmdb:' + itId)) return false;
        return true;
      } else {
        // Movies: remove as soon as they appear in Watch History.
        if (itId && (watchedIds.has(itId) || (/^\d+$/.test(itId) && watchedIds.has('tmdb:' + itId)) || (itId.startsWith('tmdb:') && watchedIds.has(itId.slice(5))))) return false;
        if (itImdbId && watchedIds.has(itImdbId)) return false;
        if (itTmdbId && (watchedIds.has(itTmdbId) || watchedIds.has('tmdb:' + itTmdbId))) return false;
        return true;
      }
    });

    if (list.items.length !== initialLen) {
      list.updatedAt = Date.now();
      localChanged = true;
    }
  });

  if (localChanged) {
    if (typeof saveLocalCustomListsMap === 'function') saveLocalCustomListsMap(map);
    if (typeof pushTrackingSync === 'function') pushTrackingSync();
    if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard({ silent: true });
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
  
  let existingIdx = list.items.findIndex(it => it.id === id);
  
  if (existingIdx < 0 && type === 'episode') {
    const d = window._currentItemDetails;
    if (d) {
      const cache = window._episodeDataCache || {};
      const found = Object.values(cache).find(ep => String(ep.id) === String(id));
      if (found && found.season_number != null && found.episode_number != null) {
        const fallbackId = d.id + ':' + found.season_number + ':' + found.episode_number;
        existingIdx = list.items.findIndex(it => it.id === fallbackId);
        if (existingIdx >= 0) id = fallbackId;
      }
    }
  }

  if (existingIdx >= 0) {
    const removedItem = list.items.splice(existingIdx, 1)[0];
    if (removedItem) {
      if (removedItem.id) window._watchedItemIds.delete(String(removedItem.id));
      if (removedItem.imdbId) window._watchedItemIds.delete(String(removedItem.imdbId));
      if (removedItem.tmdbId) {
        window._watchedItemIds.delete(String(removedItem.tmdbId));
        window._watchedItemIds.delete('tmdb:' + removedItem.tmdbId);
      }
      if (removedItem.seasonNum != null && removedItem.episodeNum != null) {
        if (removedItem.showId) window._watchedItemIds.delete(String(removedItem.showId) + ':' + removedItem.seasonNum + ':' + removedItem.episodeNum);
        if (removedItem.showTitle) window._watchedItemIds.delete(String(removedItem.showTitle) + ':' + removedItem.seasonNum + ':' + removedItem.episodeNum);
        const d = window._currentItemDetails;
        if (d) {
          if (d.id) window._watchedItemIds.delete(String(d.id) + ':' + removedItem.seasonNum + ':' + removedItem.episodeNum);
          if (d.imdbId) window._watchedItemIds.delete(String(d.imdbId) + ':' + removedItem.seasonNum + ':' + removedItem.episodeNum);
          if (d.tmdbId) {
            window._watchedItemIds.delete(String(d.tmdbId) + ':' + removedItem.seasonNum + ':' + removedItem.episodeNum);
            window._watchedItemIds.delete('tmdb:' + d.tmdbId + ':' + removedItem.seasonNum + ':' + removedItem.episodeNum);
          }
          if (d.title) window._watchedItemIds.delete(String(d.title) + ':' + removedItem.seasonNum + ':' + removedItem.episodeNum);
        }
      }
    }
    window._watchedItemIds.delete(String(id));
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
    window._watchedItemIds.add(String(id));
    if (item.seasonNum != null && item.episodeNum != null) {
      if (item.showId) window._watchedItemIds.add(String(item.showId) + ':' + item.seasonNum + ':' + item.episodeNum);
      if (item.showTitle) window._watchedItemIds.add(String(item.showTitle) + ':' + item.seasonNum + ':' + item.episodeNum);
      const d = window._currentItemDetails;
      if (d) {
        if (d.id) window._watchedItemIds.add(String(d.id) + ':' + item.seasonNum + ':' + item.episodeNum);
        if (d.imdbId) window._watchedItemIds.add(String(d.imdbId) + ':' + item.seasonNum + ':' + item.episodeNum);
        if (d.tmdbId) {
          window._watchedItemIds.add(String(d.tmdbId) + ':' + item.seasonNum + ':' + item.episodeNum);
          window._watchedItemIds.add('tmdb:' + d.tmdbId + ':' + item.seasonNum + ':' + item.episodeNum);
        }
        if (d.title) window._watchedItemIds.add(String(d.title) + ':' + item.seasonNum + ':' + item.episodeNum);
      }
    }
    removeWatchedItemFromWatchlist(id, item.showId || (type === 'movie' ? id : null));
    if (typeof trackEvent === 'function') {
      trackEvent('watched', item.showId || id, item.showTitle || name, type === 'movie' ? 'movie' : 'series');
    }
  }

  window._rawWatchHistoryItems = list.items;
  list.updatedAt = Date.now();
  map['watch-history'] = list;
  saveLocalCustomListsMap(map);
  if (typeof scheduleCreatorSyncSave === 'function') {
    scheduleCreatorSyncSave(existingIdx >= 0 ? { intentionalRemoval: true } : undefined);
  }

  // Update Continue Watching for episode toggles
  if (type === 'episode') {
    const d = window._currentItemDetails;
    if (d && d.id) updateContinueWatching(d.id).catch(() => {});
    if (typeof updateSeasonWatchedButton === 'function' && window._currentSeasonNum != null) {
      updateSeasonWatchedButton(window._currentSeasonNum);
    }
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
//
// forceUnwatch (optional): overrides the auto-detected "are these all
// already watched" check below with an explicit true/false from the
// caller, instead of re-deriving it from window._watchedItemIds. Exists
// for markShowWatched (below): that caller re-fetches every season fresh
// from TMDB on every click, and if TMDB's episode ids for the aired-
// episode set drift even slightly between the click that marked a show
// watched and a later click meant to unwatch it (a metadata refresh, a
// newly-aired episode changing which ids count as "aired", etc.), the
// items.every(...) check below can come back false on what the person
// sees as an "unwatch" click -- silently re-adding the (mostly already
// watched) episodes instead of removing them, so the button visibly does
// nothing and needs a second click once every id lines up. Passing the
// button's own current state explicitly removes that class of mismatch
// entirely for this caller.
window.toggleBatchWatchStatus = function(items, forceUnwatch) {
  if (!items || !items.length) return { added: 0, removed: 0, nowWatched: false };

  const map = loadLocalCustomLists();
  const list = getOrCreateWatchHistoryList();

  const allWatched = typeof forceUnwatch === 'boolean' ? forceUnwatch : items.every(it => window._watchedItemIds.has(String(it.id)));
  let added = 0;
  let removed = 0;

  if (allWatched) {
    const removeIds = new Set(items.map(it => String(it.id)));
    const removeCompositeKeys = new Set();
    items.forEach(it => {
      removeIds.add(String(it.id));
      if (it.imdbId) removeIds.add(String(it.imdbId));
      if (it.tmdbId) {
        removeIds.add(String(it.tmdbId));
        removeIds.add('tmdb:' + it.tmdbId);
      }
      if (it.seasonNum != null && it.episodeNum != null) {
        if (it.showId) {
          removeCompositeKeys.add(String(it.showId) + ':' + it.seasonNum + ':' + it.episodeNum);
          if (String(it.showId).startsWith('tmdb:')) {
            removeCompositeKeys.add(String(it.showId).slice(5) + ':' + it.seasonNum + ':' + it.episodeNum);
          } else {
            removeCompositeKeys.add('tmdb:' + it.showId + ':' + it.seasonNum + ':' + it.episodeNum);
          }
        }
        if (it.showTitle) removeCompositeKeys.add(String(it.showTitle) + ':' + it.seasonNum + ':' + it.episodeNum);
        const d = window._currentItemDetails;
        if (d) {
          if (d.id) removeCompositeKeys.add(String(d.id) + ':' + it.seasonNum + ':' + it.episodeNum);
          if (d.imdbId) removeCompositeKeys.add(String(d.imdbId) + ':' + it.seasonNum + ':' + it.episodeNum);
          if (d.tmdbId) {
            removeCompositeKeys.add(String(d.tmdbId) + ':' + it.seasonNum + ':' + it.episodeNum);
            removeCompositeKeys.add('tmdb:' + d.tmdbId + ':' + it.seasonNum + ':' + it.episodeNum);
          }
          if (d.title) removeCompositeKeys.add(String(d.title) + ':' + it.seasonNum + ':' + it.episodeNum);
        }
      }
    });

    list.items = list.items.filter(it => !removeIds.has(String(it.id)));
    window._rawWatchHistoryItems = list.items;
    removeIds.forEach(id => {
      if (window._watchedItemIds) {
        window._watchedItemIds.delete(id);
        removed++;
      }
    });
    removeCompositeKeys.forEach(k => {
      if (window._watchedItemIds) window._watchedItemIds.delete(k);
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
      if (window._watchedItemIds) {
        window._watchedItemIds.add(id);
        if (it.imdbId) window._watchedItemIds.add(String(it.imdbId));
        if (it.tmdbId) {
          window._watchedItemIds.add(String(it.tmdbId));
          window._watchedItemIds.add('tmdb:' + it.tmdbId);
        }
        if (it.seasonNum != null && it.episodeNum != null) {
          if (it.showId) {
            window._watchedItemIds.add(String(it.showId) + ':' + it.seasonNum + ':' + it.episodeNum);
            if (String(it.showId).startsWith('tmdb:')) {
              window._watchedItemIds.add(String(it.showId).slice(5) + ':' + it.seasonNum + ':' + it.episodeNum);
            } else {
              window._watchedItemIds.add('tmdb:' + it.showId + ':' + it.seasonNum + ':' + it.episodeNum);
            }
          }
          if (it.showTitle) window._watchedItemIds.add(String(it.showTitle) + ':' + it.seasonNum + ':' + it.episodeNum);
          const d = window._currentItemDetails;
          if (d) {
            if (d.id) window._watchedItemIds.add(String(d.id) + ':' + it.seasonNum + ':' + it.episodeNum);
            if (d.imdbId) window._watchedItemIds.add(String(d.imdbId) + ':' + it.seasonNum + ':' + it.episodeNum);
            if (d.tmdbId) {
              window._watchedItemIds.add(String(d.tmdbId) + ':' + it.seasonNum + ':' + it.episodeNum);
              window._watchedItemIds.add('tmdb:' + d.tmdbId + ':' + it.seasonNum + ':' + it.episodeNum);
            }
            if (d.title) window._watchedItemIds.add(String(d.title) + ':' + it.seasonNum + ':' + it.episodeNum);
          }
        }
      }
      removeWatchedItemFromWatchlist(id, it.showId || (it.type === 'movie' ? id : null));
    });
    window._rawWatchHistoryItems = list.items;
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
  if (typeof scheduleCreatorSyncSave === 'function') {
    scheduleCreatorSyncSave(allWatched ? { intentionalRemoval: true } : undefined);
  }

  updateContinueWatchingForBatch(items).catch(() => {});

  if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard();

  items.forEach((it) => {
    refreshWatchBadge(it.id, it.type);
    if (typeof syncSingleItemToConnectedProviders === 'function') {
      syncSingleItemToConnectedProviders(it, !allWatched ? 'add' : 'remove');
    }
  });

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

  // Capture intent from the button's own state before it's disabled/
  // relabeled below -- see toggleBatchWatchStatus's forceUnwatch comment
  // for why this is passed through explicitly rather than re-derived from
  // window._watchedItemIds after the fresh TMDB fetch below.
  const wasFullyWatched = window._fullyWatchedShowIds && window._fullyWatchedShowIds.has(String(imdbId));

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
              const epStill = ep.still_path
                ? (ep.still_path.startsWith('http') ? ep.still_path : 'https://image.tmdb.org/t/p/w500' + ep.still_path)
                : (d.poster || '');
              allEpisodes.push({
                id: String(ep.id),
                type: 'episode',
                name: ep.name,
                poster: epStill,
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

  const result = window.toggleBatchWatchStatus(allEpisodes, wasFullyWatched);
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
  document.querySelectorAll('.btn-mark-season-watched').forEach((seasonBtn) => {
    if (nowWatched) {
      seasonBtn.innerHTML = '<span style="margin-right:4px;">&#x2713;</span> Mark Season Unwatched';
      seasonBtn.classList.remove('primary');
      seasonBtn.classList.add('secondary');
    } else {
      seasonBtn.innerHTML = 'Mark Season Watched';
      seasonBtn.classList.remove('secondary');
      seasonBtn.classList.add('primary');
    }
  });
};

// One-way add to Watch History as watched -- unlike toggleBatchWatchStatus
// above (which flips a fully-watched batch back to unwatched, since it's a
// toggle), this only ever adds and skips anything already present. Used by
// the Trakt Export / Letterboxd Export importers' "mark as watched"
// option: re-running an import over the same export file (or one that
// overlaps an earlier one) should never accidentally unmark something that
// was already logged as watched, which a toggle-based call would risk the
// moment every item in a batch happened to already be watched.
window.addItemsToWatchHistory = async function(items, skipExternalSync = false) {
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
  if (added > 0) {
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
    const saved = saveLocalCustomListsMap(map);
    if (!saved) return { added: 0, cwSucceeded: 0, cwTotal: 0, quotaExceeded: true };
    if (typeof scheduleCreatorSyncSave === 'function') scheduleCreatorSyncSave();
    // Imports (Trakt/MDBList history) are the only source of entries
    // that carry a show poster where an episode still belongs, so this is
    // the one place worth kicking the backfill from directly rather than
    // waiting for the next page load. Not awaited -- the caller's own
    // "done" message should not sit behind a cosmetic fetch.
    if (typeof backfillWatchHistoryEpisodeStills === 'function') {
      backfillWatchHistoryEpisodeStills().catch(() => {});
    }
  } else if (!skipExternalSync) {
    // If nothing was added, and this is NOT a mass import, just return.
    // Mass imports (skipExternalSync=true) should proceed to retry Continue Watching
    // even if added=0, so the user can explicitly "run this again" as the alert suggests.
    return { added: 0, cwSucceeded: 0, cwTotal: 0 };
  }

  // Awaited (unlike toggleBatchWatchStatus's own fire-and-forget call
  // above) -- this is what a bulk importer processing dozens or hundreds
  // of shows actually needs: the caller's own "done" message shouldn't
  // fire while most of the batch is still mid-flight, and cwSucceeded/
  // cwTotal below let it report real numbers instead of assuming success.
  const cwResult = await updateContinueWatchingForBatch(items);
  if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard();
  items.forEach((it) => {
    refreshWatchBadge(it.id, it.type);
    if (!skipExternalSync && typeof syncSingleItemToConnectedProviders === 'function') {
      syncSingleItemToConnectedProviders(it, 'add');
    }
  });
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
  const seenTitles = new Set();
  const watchedSet = window._watchedItemIds || (function() {
    try {
      const map = loadLocalCustomLists();
      const wh = map['watch-history'];
      return new Set(((wh && wh.items) || []).map(it => String(it && (it.id || it.imdbId))).filter(Boolean));
    } catch (e) { return new Set(); }
  })();
  return items.filter((it) => {
    if (!it) return false;
    const epId = String(it.id || '');
    // An episode already marked as watched in Watch History must never be in Continue Watching
    if (epId && watchedSet.has(epId)) return false;
    const showId = String(it.showId || (epId.startsWith('tt') && epId.includes(':') ? epId.split(':')[0] : (epId.startsWith('tmdb:') && epId.includes(':') ? epId.split(':')[0] + ':' + epId.split(':')[1] : (it.imdbId || epId))) || '');
    const titleKey = (it.showTitle || '').toLowerCase().trim();
    if (!showId) return true;
    if (seenShowIds.has(showId)) return false;
    if (titleKey && seenTitles.has(titleKey)) return false;
    seenShowIds.add(showId);
    if (titleKey) seenTitles.add(titleKey);
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

    const allEps = data.season.episodes;
    const nextInSeason = allEps.find((ep) => ep.episode_number > latest.episodeNum);

    if (nextInSeason) {
      const aired = isEpisodeAired(nextInSeason);
      const isPremiere = nextInSeason.episode_number === 1 && latest.seasonNum > 1;
      const isFinale = nextInSeason.episode_number === allEps.length;
      const lastEp = allEps[allEps.length - 1];
      const finaleAir = (lastEp && lastEp.air_date) ? lastEp.air_date : null;
      newEntry = {
        id: String(nextInSeason.id),
        type: 'episode',
        name: nextInSeason.name,
        poster: latest.showPoster || '',
        showId: showId,
        showTitle: latest.showTitle || '',
        showPoster: latest.showPoster || '',
        seasonNum: latest.seasonNum,
        episodeNum: nextInSeason.episode_number,
        airDate: nextInSeason.air_date || null,
        isUnaired: !aired,
        isSeasonPremiere: isPremiere,
        isSeasonFinale: isFinale,
        seasonFinaleAirDate: (!isPremiere && !isFinale) ? finaleAir : null,
      };
      // If the next episode has not aired yet, all currently aired episodes have been watched
      showFullyWatched = !aired;
    } else {
      const nextSeasonNum = latest.seasonNum + 1;
      const res2 = await fetch(ORIGIN + '/api/season?imdbId=' + encodeURIComponent(showId) +
        '&seasonNum=' + nextSeasonNum + '&tmdbKey=' + encodeURIComponent(tmdbKey));
      const data2 = await res2.json();
      if (data2.ok && data2.season && Array.isArray(data2.season.episodes) && data2.season.episodes.length) {
        const allEpsNext = data2.season.episodes;
        const firstNext = allEpsNext[0];
        if (firstNext) {
          const aired = isEpisodeAired(firstNext);
          const isPremiere = firstNext.episode_number === 1 && nextSeasonNum > 1;
          const isFinale = allEpsNext.length === 1;
          const lastEp = allEpsNext[allEpsNext.length - 1];
          const finaleAir = (lastEp && lastEp.air_date) ? lastEp.air_date : null;
          newEntry = {
            id: String(firstNext.id),
            type: 'episode',
            name: firstNext.name,
            poster: latest.showPoster || '',
            showId: showId,
            showTitle: latest.showTitle || '',
            showPoster: latest.showPoster || '',
            seasonNum: nextSeasonNum,
            episodeNum: firstNext.episode_number,
            airDate: firstNext.air_date || null,
            isUnaired: !aired,
            isSeasonPremiere: isPremiere,
            isSeasonFinale: isFinale,
            seasonFinaleAirDate: (!isPremiere && !isFinale) ? finaleAir : null,
          };
          showFullyWatched = !aired;
        } else {
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
      let attempts = 0;
      let success = false;
      while (attempts < 3 && !success) {
        attempts++;
        try {
          const result = await updateContinueWatching(showId);
          if (result && result.ok) {
            success = true;
            succeeded++;
          } else if (attempts < 3) {
            await new Promise(r => setTimeout(r, 1000));
          }
        } catch (e) {
          if (attempts < 3) await new Promise(r => setTimeout(r, 1000));
        }
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
  if (typeof scheduleTrackingSync === 'function') scheduleTrackingSync({ intentionalRemoval: true });
}

// --- Airing Next ------------------------------------------------------------
//
// A read-only, client-computed shelf listing every watched show's next
// upcoming episode, soonest first. A show's next air date itself only
// changes when TMDB's own schedule changes, so the item list is
// recomputed against TMDB on a timer (refreshAiringNext below) rather
// than on every watch event -- but WHICH shows are even eligible changes
// the instant this browser's own watch state does (marking something
// watched/unwatched, etc.), so syncAiringNextWatchState below re-derives
// that part immediately, purely from already-local data, no network
// involved. No Fully Watched/In Progress split -- every watched show with
// a known upcoming episode is listed together.

const AIRING_NEXT_REFRESH_MS = 6 * 3600 * 1000; // matches the server Continue Watching cron's own cadence
const AIRING_NEXT_MAX_SHOWS_PER_RUN = 60; // bounds one refresh's /api/details calls for anyone with very large history
const AIRING_NEXT_CONCURRENCY = 4;


function getOrCreateAiringNextList() {
  const map = loadLocalCustomLists();
  if (!map['airing-next']) {
    map['airing-next'] = {
      slug: 'airing-next',
      localSlug: 'airing-next',
      name: 'Airing Next',
      description: 'Upcoming episodes for shows you have watched, soonest first.',
      type: 'series',
      items: [],
      updatedAt: 0, // 0 (not Date.now()) so a fresh install refreshes on first load instead of waiting a full cycle
      createdAt: Date.now(),
    };
    saveLocalCustomListsMap(map);
  } else if (!map['airing-next'].slug) {
    map['airing-next'].slug = 'airing-next';
    saveLocalCustomListsMap(map);
  }
  return map['airing-next'];
}

// Every distinct show with at least one watched episode is a candidate --
// this list shows all of them with a known upcoming episode, no Fully
// Watched/In Progress split (that distinction was removed; see this
// function's git history for the old bucketing logic if it's ever needed
// again).
function collectAiringNextCandidateShowIds() {
  const ids = new Set();
  const map = loadLocalCustomLists();
  const watchHistoryItems = (map['watch-history'] || {}).items || [];
  watchHistoryItems.forEach((it) => {
    if (it && it.type === 'episode' && it.showId) ids.add(it.showId);
  });
  // Belt-and-suspenders: also counts a show explicitly known as fully
  // watched even if Watch History was cleared.
  if (window._fullyWatchedShowIds) {
    window._fullyWatchedShowIds.forEach((id) => ids.add(id));
  }
  return ids;
}

// Re-derives the already-computed Airing Next list's eligibility against
// current local state -- no network involved, unlike refreshAiringNext
// below (which is the only thing that ever fetches a new next-air-date
// from TMDB). Called from setShowFullyWatched/setShowInProgress (this
// file) and removeWatchHistoryItemDirect (22_client-creator-profile.js)
// so a show with no watched episodes left (e.g. "Mark Whole Show
// Unwatched", or the last Watch History row for it removed) drops out of
// the list immediately instead of lingering until the next 6-hour
// refresh. Deliberately never ADDS a show that isn't already in the
// cached list -- a newly-eligible show still needs its actual
// next-air-date fetched from TMDB, which only refreshAiringNext does.
function syncAiringNextWatchState() {
  if (typeof loadLocalCustomLists !== 'function' || typeof saveLocalCustomListsMap !== 'function') return;
  const map = loadLocalCustomLists();
  const list = map['airing-next'];

  const candidates = collectAiringNextCandidateShowIds();

  // If there are candidate shows that aren't in the cached list at all, those
  // newly-watched shows need a TMDB lookup to get their next air date. Force a
  // full refresh so they appear without waiting up to 6 hours.
  const cachedShowIds = new Set((list && Array.isArray(list.items) ? list.items : []).map((it) => it && it.showId).filter(Boolean));
  const hasNewCandidates = [...candidates].some((id) => !cachedShowIds.has(id));
  if (hasNewCandidates) {
    refreshAiringNext(true).catch(() => {});
    return;
  }

  if (!list || !Array.isArray(list.items) || !list.items.length) return;

  let changed = false;
  const filtered = list.items.filter((it) => {
    const stillCandidate = it && it.showId && candidates.has(it.showId);
    if (!stillCandidate) changed = true;
    return stillCandidate;
  });
  if (!changed) return;

  list.items = filtered;
  map['airing-next'] = list;
  saveLocalCustomListsMap(map);
  if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard({ silent: true });
  // Keeps a signed-in account's live "autotrack:airing-next:..." Stremio
  // catalog in sync too, not just this browser's own dashboard preview --
  // no-ops if not signed in, same guard as scheduleTrackingSync's own.
  if (typeof scheduleTrackingSync === 'function') scheduleTrackingSync();
}

// Recomputes the Airing Next list against TMDB, throttled to
// AIRING_NEXT_CONCURRENCY parallel /api/details calls at a time -- each
// call is a single cheap edge-cached lookup (same endpoint the item
// details modal already uses), but a large watch history could still mean
// dozens of shows, so this fans out a few at a time rather than one giant
// Promise.all. No-ops (returns the existing list untouched) if the last
// refresh is still within AIRING_NEXT_REFRESH_MS, unless force is true.
async function refreshAiringNext(force) {
  const existing = getOrCreateAiringNextList();
  const hasExpiredItems = Array.isArray(existing.items) && existing.items.some(it => it && it.airDate && typeof isEpisodeAired === 'function' && isEpisodeAired(it.airDate));
  const needsEnrichment = Array.isArray(existing.items) && existing.items.length > 0 && existing.items.some(it => it && !it.name && !it.episodeTitle);
  if (!force && Array.isArray(existing.items) && existing.items.length > 0 && !needsEnrichment && !hasExpiredItems && existing.updatedAt && (Date.now() - existing.updatedAt) < AIRING_NEXT_REFRESH_MS) {
    // Reconciled with the account even though nothing was recomputed.
    // The push at the bottom of this function is otherwise the only one
    // that ever happens, so a list that was built while sign-in had not
    // finished yet -- pushTrackingSync bails without activeCreator --
    // would be cached as fresh here and never sent, leaving the
    // autotrack:airing-next catalog row empty for as long as the cache
    // held. scheduleTrackingSync's signature guard makes this a no-op
    // when the account already has this exact list.
    if (typeof scheduleTrackingSync === 'function') scheduleTrackingSync();
    return existing;
  }

  const candidates = [...collectAiringNextCandidateShowIds()].slice(0, AIRING_NEXT_MAX_SHOWS_PER_RUN);
  if (!candidates.length) return existing;

  // Best-known title/poster for each show, straight from Watch History --
  // avoids depending on /api/details (TMDB-only) for display fields that
  // might already be known from a richer source (e.g. an imported Trakt
  // history entry).
  const knownByShow = new Map();
  ((loadLocalCustomLists()['watch-history'] || {}).items || []).forEach((it) => {
    if (it && it.showId && it.showTitle && !knownByShow.has(it.showId)) {
      knownByShow.set(it.showId, { title: it.showTitle, poster: it.showPoster });
    }
  });

  const tkInput = document.getElementById('tmdbKeyInput');
  const tmdbKey = tkInput && tkInput.value ? tkInput.value.trim() : '';

  const results = [];
  const bypassFresh = !!(force || hasExpiredItems);

  // Turns one /api/details payload into an Airing Next entry, or null when
  // the show has no upcoming episode. Shared by the batch path and the
  // per-id fallback below so both produce identical entries.
  function airingEntryFrom(showId, d) {
    if (!d || !d.nextEpisodeAirDate) return null;
    if (typeof isEpisodeAired === 'function' && isEpisodeAired(d.nextEpisodeAirDate)) return null;
    const known = knownByShow.get(showId);
    const epName = d.nextEpisodeName || (d.nextEpisodeNumber === 1 ? 'Season Premiere' : (d.nextEpisodeNumber != null ? ('Episode ' + d.nextEpisodeNumber) : ''));
    const isFinale = !!(d.isSeasonFinale || (d.totalEpisodesInSeason != null && d.nextEpisodeNumber === d.totalEpisodesInSeason && d.nextEpisodeNumber > 1));
    return {
      id: showId,
      showId: showId,
      canonicalTmdbId: d.tmdbId ? String(d.tmdbId) : null,
      showTitle: (known && known.title) || d.title || '',
      showPoster: (known && known.poster) || d.poster || '',
      name: epName,
      episodeTitle: epName,
      airDate: d.nextEpisodeAirDate,
      seasonNum: d.nextEpisodeSeasonNumber,
      episodeNum: d.nextEpisodeNumber,
      isSeasonPremiere: d.nextEpisodeNumber === 1,
      isSeasonFinale: isFinale,
      seasonFinaleAirDate: d.seasonFinaleAirDate || null,
      seasonFinaleEpisodeNumber: d.seasonFinaleEpisodeNumber || null,
      isUnaired: true,
    };
  }

  // One request for the whole candidate set instead of up to 60 separate
  // ones at a concurrency of 4 -- which was fifteen sequential waves of
  // request latency before this shelf could be rebuilt. The server resolves
  // each id through the same cached path a single /api/details call would
  // have used, so this removes round trips rather than adding upstream
  // calls. See /api/details/batch, 25_api-catalog-routes.js.
  let batchOk = false;
  try {
    const batchRes = await fetch(ORIGIN + '/api/details/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: candidates,
        type: 'series',
        tmdbKey: tmdbKey,
        fresh: bypassFresh ? '1' : '',
      }),
    });
    const batchData = await batchRes.json();
    if (batchData && batchData.ok && batchData.results) {
      batchOk = true;
      // Iterated over candidates rather than over the response keys so
      // entries stay in candidate order, which is what the dedupe below
      // relies on for its "keep the earliest" behaviour.
      for (let i = 0; i < candidates.length; i++) {
        const showId = candidates[i];
        const entry = airingEntryFrom(showId, batchData.results[showId]);
        if (entry) results.push(entry);
      }
    }
  } catch (e) {
    // Falls through to the per-id path below.
  }

  // Fallback for anything that did not get a usable batch response (an
  // older self-hosted Worker without the batch route, or a network
  // hiccup). Behaviourally identical to what this function did before.
  if (!batchOk) {
    let cursor = 0;
    async function worker() {
      while (cursor < candidates.length) {
        const showId = candidates[cursor++];
        try {
          const bypass = bypassFresh ? '&fresh=1&_t=' + Date.now() : '';
          const res = await fetch(ORIGIN + '/api/details?imdbId=' + encodeURIComponent(showId) + '&type=series&tmdbKey=' + encodeURIComponent(tmdbKey) + bypass);
          const data = await res.json();
          const entry = airingEntryFrom(showId, data && data.ok ? data.details : null);
          if (entry) results.push(entry);
        } catch (e) {
          // Network hiccup or no TMDB key configured -- this show is simply
          // retried on the next refresh (or a manual "force" one) rather
          // than blocking the rest of the batch.
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(AIRING_NEXT_CONCURRENCY, candidates.length) }, worker));
  }

  // Deduplicate by canonical TMDB ID or showId -- a show can appear under
  // multiple IDs if Watch History recorded both an imdb and a tmdb-prefixed
  // form; keep the first (earliest-resolved) entry for each show.
  const seenIds = new Set();
  const deduped = results.filter((it) => {
    const normalizedShowId = it.showId.startsWith('tmdb:') ? it.showId.slice(5) : it.showId;
    const key1 = it.canonicalTmdbId ? 'tmdb:' + it.canonicalTmdbId : 'id:' + normalizedShowId;
    
    if (seenIds.has(key1)) return false;
    seenIds.add(key1);
    
    // Also track the original showId so we don't duplicate on fallback
    if (seenIds.has('id:' + normalizedShowId)) return false;
    seenIds.add('id:' + normalizedShowId);
    
    return true;
  });
  deduped.sort((a, b) => (a.airDate || '').localeCompare(b.airDate || ''));

  const map = loadLocalCustomLists();
  const fresh = getOrCreateAiringNextList();
  fresh.items = deduped;
  fresh.updatedAt = Date.now();
  map['airing-next'] = fresh;
  saveLocalCustomListsMap(map);
  if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard({ silent: true });
  // Pushes the freshly computed list to this account's server-side
  // tracking record (no-ops if not signed in -- see scheduleTrackingSync's
  // own guard) so the "autotrack:airing-next:series:<username>" Stremio
  // catalog (fetchAutoTrackedCatalog, 05_catalog-core.js) reflects it too,
  // not just this browser's own dashboard preview.
  if (typeof scheduleTrackingSync === 'function') scheduleTrackingSync();
  return fresh;
}

// Kicked off after Watch History/Continue Watching have had a chance to
// populate (initWatchHistory itself fires at 500ms -- see 21's own
// setTimeout above) rather than racing them for the same localStorage
// reads.
setTimeout(() => { refreshAiringNext(false).catch(() => {}); }, 600);

// --- Watch History episode stills -------------------------------------------
//
// A Watch History entry keeps the episode's own still image in poster and
// the series artwork in showPoster, and every renderer reads poster first,
// falling back to showPoster. The paths that build an entry from TMDB
// directly -- markShowWatched above, and the two scrobble handlers in
// 26_api-creator-and-admin-routes.js -- all fill in the real still. The
// import paths cannot: Trakt's and MDBList's history rows carry no
// per-episode image at all, so they write the show poster into BOTH
// fields. That is the whole of "sometimes the episodes get show posters":
// scrobbled episodes have stills, imported ones never did.
//
// This fills them in afterwards from the same /api/season endpoint
// markShowWatched already uses -- one call per show+season, and that
// endpoint's TMDB fetch is edge-cached for a week, so a large history
// costs a handful of cheap requests rather than one per episode. An
// episode whose season genuinely has no still on TMDB simply keeps the
// show poster, which is the intended fallback; the season is recorded as
// checked so it is not re-fetched on every page load.
const EPISODE_STILL_CHECKS_KEY = 'myListAddon:episodeStillChecks';
const EPISODE_STILL_RECHECK_MS = 7 * 24 * 3600 * 1000;
const EPISODE_STILL_MAX_GROUPS_PER_RUN = 12;
const EPISODE_STILL_CONCURRENCY = 3;

function loadEpisodeStillChecks() {
  try {
    const raw = JSON.parse(localStorage.getItem(EPISODE_STILL_CHECKS_KEY) || '{}');
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  } catch (e) {
    return {};
  }
}

function saveEpisodeStillChecks(checks) {
  try {
    localStorage.setItem(EPISODE_STILL_CHECKS_KEY, JSON.stringify(checks));
  } catch (e) {}
}

// True when this entry is showing series artwork where an episode still
// belongs. Three ways that happens: no poster at all, a poster identical
// to the entry's own showPoster, or a metahub poster URL -- metahub only
// ever serves show artwork, never episode stills, so one appearing in the
// poster field is always a fallback that got written in.
function needsEpisodeStill(it) {
  if (!it) return false;
  const isEpisode = it.type === 'episode' || (it.seasonNum != null && it.episodeNum != null);
  if (!isEpisode) return false;
  if (!it.showId || it.seasonNum == null || it.episodeNum == null) return false;
  const poster = String(it.poster || '');
  if (!poster) return true;
  if (it.showPoster && poster === String(it.showPoster)) return true;
  if (poster.indexOf('images.metahub.space/poster/') !== -1) return true;
  return false;
}

async function backfillWatchHistoryEpisodeStills() {
  if (typeof loadLocalCustomLists !== 'function' || typeof saveLocalCustomListsMap !== 'function') return 0;
  const map = loadLocalCustomLists();
  const list = map['watch-history'];
  const items = (list && Array.isArray(list.items)) ? list.items : [];
  if (!items.length) return 0;

  const checks = loadEpisodeStillChecks();
  const now = Date.now();
  const groups = new Map();
  items.forEach((it) => {
    if (!needsEpisodeStill(it)) return;
    const key = String(it.showId) + '|' + String(it.seasonNum);
    const lastChecked = Number(checks[key]) || 0;
    if (lastChecked && (now - lastChecked) < EPISODE_STILL_RECHECK_MS) return;
    if (!groups.has(key)) groups.set(key, { showId: it.showId, seasonNum: it.seasonNum, items: [] });
    groups.get(key).items.push(it);
  });
  if (!groups.size) return 0;

  const pending = [...groups.entries()].slice(0, EPISODE_STILL_MAX_GROUPS_PER_RUN);
  const tkInput = document.getElementById('tmdbKeyInput');
  const tmdbKey = (tkInput && tkInput.value ? tkInput.value.trim() : '') || localStorage.getItem('myListAddon:tmdbKey') || '';

  let changed = 0;
  let nextIdx = 0;
  async function worker() {
    while (nextIdx < pending.length) {
      const entry = pending[nextIdx++];
      const key = entry[0];
      const group = entry[1];
      try {
        const res = await fetch(ORIGIN + '/api/season?imdbId=' + encodeURIComponent(group.showId) +
          '&seasonNum=' + encodeURIComponent(group.seasonNum) +
          (tmdbKey ? '&tmdbKey=' + encodeURIComponent(tmdbKey) : ''));
        const data = await res.json();
        const episodes = (data && data.ok && data.season && Array.isArray(data.season.episodes)) ? data.season.episodes : null;
        // A miss here is a network or TMDB failure, not "this season has
        // no stills" -- deliberately left unrecorded so the next run
        // retries it rather than writing it off for a week.
        if (!episodes) continue;
        const byNumber = new Map();
        episodes.forEach((ep) => {
          if (ep && ep.episode_number != null) byNumber.set(Number(ep.episode_number), ep);
        });
        group.items.forEach((it) => {
          const ep = byNumber.get(Number(it.episodeNum));
          if (!ep || !ep.still_path) return;
          const raw = String(ep.still_path);
          const still = raw.indexOf('http') === 0 ? raw : ('https://image.tmdb.org/t/p/w500' + raw);
          if (it.poster === still) return;
          // Keep the artwork that was in poster as the show-level
          // fallback if this entry never had one recorded separately,
          // so replacing poster can never leave it with nothing to fall
          // back to.
          if (!it.showPoster && it.poster) it.showPoster = it.poster;
          it.poster = still;
          changed++;
        });
        checks[key] = now;
      } catch (e) {
        // Same as above -- retried on the next run.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(EPISODE_STILL_CONCURRENCY, pending.length) }, worker));

  saveEpisodeStillChecks(checks);
  if (changed) {
    list.items = items;
    list.updatedAt = Date.now();
    map['watch-history'] = list;
    saveLocalCustomListsMap(map);
    if (typeof invalidatePosterRenderCaches === 'function') invalidatePosterRenderCaches();
    if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard({ silent: true });
    if (typeof scheduleTrackingSync === 'function') scheduleTrackingSync();
  }
  return changed;
}
window.backfillWatchHistoryEpisodeStills = backfillWatchHistoryEpisodeStills;

// Deliberately after the Airing Next kick above rather than alongside it:
// both read the same Watch History out of localStorage, and this one is
// the strictly less urgent of the two (a poster improving a moment later
// is invisible; an Airing Next row that has not populated is not).
setTimeout(() => { backfillWatchHistoryEpisodeStills().catch(() => {}); }, 1400);

// Builds the "Airing Next" dashboard card -- deliberately not part of
// buildLocalListCardHtml/renderAutoTrackedListsHtml (22_client-creator-
// profile.js): unlike Continue Watching/Watch History it has no local
// commit-lock/dismiss machinery of its own, just a filter state and an
// "+Add to Config" toggle, so it's simpler to keep self-contained. Adding
// it to the Stremio config generates "autotrack:airing-next:series:
// <username>" for a signed-in Creator account (served live by
// fetchAutoTrackedCatalog, 05_catalog-core.js, off the airingNext field
// pushed by pushTrackingSync) or a "customlist:v1:" snapshot of the
// current items for a local-only browser, same as Watch History does for
// local-only users -- see the README's "Stale install links" note for why
// that snapshot needs a manual Configure -> Update to refresh later.
function buildAiringNextCardHtml() {
  const list = getOrCreateAiringNextList();
  const filtered = list.items || [];
  const totalCount = filtered.length;
  const shown = filtered.slice(0, 9);

  const showAirDate = typeof getBadgeSetting === 'function' ? getBadgeSetting('showBadgeAirDate') : true;
  const showPremiere = typeof getBadgeSetting === 'function' ? getBadgeSetting('showBadgeSeasonPremiere') : true;
  const showFinale = typeof getBadgeSetting === 'function' ? getBadgeSetting('showBadgeSeasonFinale') : true;
  const showFinaleDate = typeof getBadgeSetting === 'function' ? getBadgeSetting('showBadgeSeasonFinaleDate') : true;

  const posterThumbs = shown.map((it, i) => {
    const isMobileEnd = (i === 2 && shown.length > 3);
    const isDesktopEnd = (i === shown.length - 1 && shown.length >= 4);
    let overlays = '';
    if (isMobileEnd) overlays += '<div class="list-card-count-overlay mobile-only airingNextViewBtn" style="cursor:pointer;">' + totalCount + ' &rsaquo;</div>';
    if (isDesktopEnd) overlays += '<div class="list-card-count-overlay desktop-only airingNextViewBtn" style="cursor:pointer;">' + totalCount + ' &rsaquo;</div>';
    const hasAired = it.airDate && typeof isEpisodeAired === 'function' ? isEpisodeAired(it.airDate) : false;
    const isUnairedEp = it.airDate ? !hasAired : !!it.isUnaired;
    let dateBadge = '';
    if (showAirDate && it.airDate && !hasAired && typeof isEpisodeAired === 'function') {
      const badgeText = typeof formatAirDateBadge === 'function' ? formatAirDateBadge(it.airDate) : '';
      if (badgeText) {
        dateBadge = '<div class="cw-date-badge" title="Airs on ' + escapeAttr(it.airDate) + '">' + escapeHtml(badgeText) + '</div>';
      }
    }
    const isSeasonPremiere = (it.episodeNum === 1 || (it.episodeNum == null && it.isSeasonPremiere));
    const isFinaleUnaired = it.seasonFinaleAirDate && typeof isEpisodeAired === 'function' ? !isEpisodeAired(it.seasonFinaleAirDate) : !!it.seasonFinaleAirDate;
    let bottomBadge = '';
    if (isUnairedEp) {
      if (showPremiere && isSeasonPremiere) {
        bottomBadge = '<div class="cw-date-badge cw-date-badge-premiere" title="Airs on ' + escapeAttr(it.airDate || '') + '">Season Premiere</div>';
      } else if (showFinale && it.isSeasonFinale) {
        bottomBadge = '<div class="cw-date-badge cw-date-badge-finale" title="Airs on ' + escapeAttr(it.airDate || '') + '">Season Finale</div>';
      } else if (showFinaleDate && it.seasonFinaleAirDate && isFinaleUnaired) {
        const finaleText = typeof formatAirDateBadge === 'function' ? formatAirDateBadge(it.seasonFinaleAirDate) : '';
        if (finaleText) {
          bottomBadge = '<div class="cw-date-badge cw-date-badge-finale-date" title="Season finale airs on ' + escapeAttr(it.seasonFinaleAirDate) + '">Finale: ' + escapeHtml(finaleText) + '</div>';
        }
      }
    }
    const label = (typeof formatWatchItemLabel === 'function')
      ? formatWatchItemLabel(it)
      : {
          title: (it.showTitle || '') + (it.seasonNum != null && it.episodeNum != null ? ' S' + String(it.seasonNum).padStart(2, '0') + 'E' + String(it.episodeNum).padStart(2, '0') : ''),
          subtitle: it.name || it.episodeTitle || (it.isSeasonPremiere ? 'Season Premiere' : (it.episodeNum != null ? ('Episode ' + it.episodeNum) : ''))
        };
    return '<div class="list-card-mini-poster-tile">' +
      '<div class="list-card-mini-poster-img-wrap">' +
        '<img src="' + escapeAttr(it.showPoster || '') + '" class="clickable-poster" data-id="' + escapeAttr(it.showId) + '" data-type="series" alt="" loading="lazy">' +
        dateBadge +
        bottomBadge +
        overlays +
      '</div>' +
      '<div class="list-card-mini-poster-name">' + escapeHtml(label.title) + '</div>' +
      (label.subtitle ? '<div class="list-card-mini-poster-subtitle">' + escapeHtml(label.subtitle) + '</div>' : '') +
    '</div>';
  }).join('');

  const isAdded = typeof isListAddedToConfig === 'function' ? isListAddedToConfig(null, 'series', 'airing-next') : false;
  const addBtnHtml = '<button type="button" class="lc-btn ' + (isAdded ? 'secondary localListAddToConfigBtn airingNextAddToConfigBtn is-added' : 'primary localListAddToConfigBtn airingNextAddToConfigBtn') + '" ' +
    (isAdded ? 'style="color:var(--danger);"' : '') +
    ' data-slug="airing-next">' + (isAdded ? 'Remove' : '+ Add') + '</button>';

  return '<div class="creator-list-row list-card" draggable="true" data-slug="airing-next" data-list-type="series">' +
    '<div class="list-card-header">' +
      '<div class="list-card-body">' +
        '<div class="list-card-title">' +
          '<span class="drag-handle-list" draggable="true" title="Drag to reorder">&#x2630;</span>' +
          'Airing Next' +
        '</div>' +
        '<div class="list-card-meta">' +
          '<span>Shows</span><span class="list-card-meta-sep">&middot;</span><span>' + totalCount + ' item' + (totalCount === 1 ? '' : 's') + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="list-card-actions">' +
        '<span style="font-size:0.78rem; color:var(--muted); white-space:nowrap;">Auto-tracked</span>' +
        addBtnHtml +
      '</div>' +
    '</div>' +
    (posterThumbs ? '<div class="list-card-posters poster-preview-static">' + posterThumbs + '</div>' : '<p><small>Nothing scheduled yet.</small></p>') +
  '</div>';
}

// Opens the dedicated full-page Airing Next view (openListDetailsPage, 23_list-
// management.js), which renders straight from the sample array below
// without needing a server-side catalog route.
function openAiringNextDetailsPage() {
  const list = getOrCreateAiringNextList();
  const sample = (list.items || []).map((it) => {
    const label = (typeof formatWatchItemLabel === 'function')
      ? formatWatchItemLabel(it)
      : {
          title: (it.showTitle || '') + (it.seasonNum != null && it.episodeNum != null ? ' S' + String(it.seasonNum).padStart(2, '0') + 'E' + String(it.episodeNum).padStart(2, '0') : ''),
          subtitle: it.name || it.episodeTitle || (it.isSeasonPremiere ? 'Season Premiere' : (it.episodeNum != null ? ('Episode ' + it.episodeNum) : ''))
        };
    return {
      id: it.showId,
      type: 'series',
      name: label.title,
      subtitle: label.subtitle,
      poster: it.showPoster,
      airDate: it.airDate,
      isUnaired: true,
      isSeasonPremiere: it.isSeasonPremiere,
      isSeasonFinale: it.isSeasonFinale,
      seasonFinaleAirDate: it.seasonFinaleAirDate,
      seasonFinaleEpisodeNumber: it.seasonFinaleEpisodeNumber,
    };
  });
  openListDetailsPage('Airing Next', 'series', 'custom:airing-next', { sample: sample, count: sample.length, maybeMore: false });
}

// --- Hidden Lists (Settings toggle) ------------------------------------
//
// Lets the person hide specific lists -- by identifier, not by section --
// from every place lists get rendered: My Lists (local Custom Lists and
// each connected provider's personal lists), the Airing Next dashboard
// card, and Simkl Airing Next. A hidden list still exists and is still
// tracked/updated normally underneath; only its rendering is suppressed,
// the same way a browser bookmark folder can be collapsed without
// deleting what's in it. Persisted as a flat array of identifiers in
// localStorage so it survives reloads without needing a server round
// trip -- this is a display preference, not data, so it doesn't need to
// live in Watch History/Continue Watching's synced blob.
//
// Identifiers: a local Custom List (including the synthetic
// 'airing-next' slug used by getOrCreateAiringNextList) is keyed by its
// slug; every provider-backed list (MDBList/Trakt/TMDB/Simkl, including
// 'simkl:user:shows:airing-next') is keyed by its url. Both happen to
// already be the unique identifier each render function keys its own
// lists by, so no extra id scheme was needed.
const HIDDEN_LISTS_KEY = 'myListAddon:hiddenLists';

function getHiddenListIds() {
  try {
    const raw = JSON.parse(localStorage.getItem(HIDDEN_LISTS_KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    return [];
  }
}

function isListHidden(id) {
  if (!id) return false;
  return getHiddenListIds().includes(String(id));
}

// Adds or removes a single identifier from the hidden set and re-renders
// every place a hidden list could currently be showing, so the change is
// visible immediately without a full page reload. Each re-render call is
// individually guarded (typeof ... === 'function') since not every one of
// these is necessarily defined yet depending on where in the page's own
// load sequence this fires from.
function setListHidden(id, hidden) {
  if (!id) return;
  const idStr = String(id);
  const current = getHiddenListIds();
  const has = current.includes(idStr);
  if (hidden === has) return; // already in the requested state
  const next = hidden ? [...current, idStr] : current.filter((x) => x !== idStr);
  try {
    localStorage.setItem(HIDDEN_LISTS_KEY, JSON.stringify(next));
  } catch (e) {
    // non-critical -- worst case the toggle doesn't persist across reloads
  }
  if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard();
  if (typeof renderMySimklLists === 'function' && window._mySimklLists) renderMySimklLists(window._mySimklLists);
  if (typeof renderMyMdblistLists === 'function' && window._myMdblistLists) renderMyMdblistLists(window._myMdblistLists);
  if (typeof renderMyTraktLists === 'function' && window._myTraktLists) renderMyTraktLists(window._myTraktLists);
  if (typeof renderMyTmdbLists === 'function' && window._myTmdbLists) renderMyTmdbLists(window._myTmdbLists);
  if (typeof renderHiddenListsSettingsSection === 'function') renderHiddenListsSettingsSection();
}

// --- Hidden My Lists Sections --------------------------------------------
//
// A coarser companion to the per-list hiding above: hides an entire
// provider's "Your X Lists" panel on the My Lists tab (My MDBList/Trakt/
// TMDB/Simkl Lists) -- for someone who's connected a provider account but
// doesn't want that whole block cluttering My Lists, without having to
// hide every individual list inside it one at a time (and without having
// to re-hide new lists that provider adds later). Deliberately a separate
// key/mechanism from HIDDEN_LISTS_KEY above -- these are section
// identifiers (a fixed small set: 'mdblist', 'trakt', 'tmdb', 'simkl'),
// not list identifiers, and mixing the two would make it ambiguous
// whether a given hidden id in one list meant "this specific list" or
// "this whole section" when read back.
const HIDDEN_SECTIONS_KEY = 'myListAddon:hiddenMyListsSections';
const MY_LISTS_SECTION_PANEL_IDS = {
  mdblist: 'myListsSectionPanel-mdblist',
  trakt: 'myListsSectionPanel-trakt',
  tmdb: 'myListsSectionPanel-tmdb',
  simkl: 'myListsSectionPanel-simkl',
};

function getHiddenMyListsSections() {
  try {
    const raw = JSON.parse(localStorage.getItem(HIDDEN_SECTIONS_KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    return [];
  }
}

function isMyListsSectionHidden(section) {
  if (!section) return false;
  return getHiddenMyListsSections().includes(String(section));
}

// Applies the current hidden-sections state directly to each panel's own
// display style -- no re-render needed the way per-list hiding requires,
// since the section panels themselves are static markup (12_tab-custom-
// lists.js) that already exists in the DOM; hiding/showing one is just a
// style toggle, not a re-render of provider data. Safe to call any time
// (e.g. on tab switch) since it's idempotent.
function applyHiddenMyListsSections() {
  const hidden = new Set(getHiddenMyListsSections());
  Object.keys(MY_LISTS_SECTION_PANEL_IDS).forEach((section) => {
    const el = document.getElementById(MY_LISTS_SECTION_PANEL_IDS[section]);
    if (el) el.style.display = hidden.has(section) ? 'none' : '';
  });
}

function setMyListsSectionHidden(section, hidden) {
  if (!section || !MY_LISTS_SECTION_PANEL_IDS[section]) return;
  const current = getHiddenMyListsSections();
  const has = current.includes(section);
  if (hidden === has) return;
  const next = hidden ? [...current, section] : current.filter((s) => s !== section);
  try {
    localStorage.setItem(HIDDEN_SECTIONS_KEY, JSON.stringify(next));
  } catch (e) {
    // non-critical -- worst case the toggle doesn't persist across reloads
  }
  applyHiddenMyListsSections();
  if (typeof renderHiddenListsSettingsSection === 'function') renderHiddenListsSettingsSection();
}

// Applied once on page load and once more each time the Lists tab is
// switched to (see switchTab, 16_client-row-core.js) -- the My Lists
// section panels only exist once that panel's markup is in the DOM, and
// while it's always present (not conditionally rendered), applying this
// on every Lists-tab visit rather than assuming a single page-load call
// suffices costs nothing and removes any ordering dependency on exactly
// when this script runs relative to the panel markup existing.
setTimeout(() => { applyHiddenMyListsSections(); }, 0);



async function fetchAllItemsForList(listUrl, type, btn, progressLabel) {
  const keys = (typeof collectKeys === 'function') ? collectKeys() : {};
  const items = [];
  let skip = 0;
  let pagesLoaded = 0;
  const MAX_PAGES = 250; // safety cap (~25,000 items) -- generous headroom above the
  // 6000-item-per-list cap below so a big Watch History copy can still split across
  // several numbered lists instead of silently truncating (see copyListToCustomList)
  //
  // A source that doesn't actually honor skip (a malformed/misdetected
  // URL, or a provider whose pagination silently ignores an out-of-range
  // offset) can keep answering maybeMore:true with the exact same items
  // every time -- trusting that alone means a 250-item list can turn into
  // up to 25,000 duplicated entries before this loop gives up. Tracked by
  // id so a page that contributes nothing new stops the loop immediately,
  // the same guard openListDetailsPage's own pagination uses.
  const seenIds = new Set();
  while (pagesLoaded < MAX_PAGES) {
    const body = { url: listUrl, type: type, skip: skip, sample: 100 };
    if (keys.tmdbKey) body.tmdbKey = keys.tmdbKey;
    if (keys.mdblistKey) body.mdblistKey = keys.mdblistKey;
    if (keys.mdblistAccessToken) body.mdblistAccessToken = keys.mdblistAccessToken;
    if (keys.traktKey) body.traktKey = keys.traktKey;
    if (keys.traktAccessToken) body.traktAccessToken = keys.traktAccessToken;
    if (keys.simklKey) body.simklKey = keys.simklKey;
    if (keys.simklAccessToken) body.simklAccessToken = keys.simklAccessToken;
    if (keys.simklUsername) body.simklUsername = keys.simklUsername;
    // creatorName AND the key: an autotrack: source is this account's private
    // shelf and the server now requires proof rather than a claimed name.
    Object.assign(body, previewCreatorAuth());
    const res = await fetch(ORIGIN + '/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'unknown error');
    const pageItems = data.sample || [];
    let newCount = 0;
    pageItems.forEach((m) => {
      const key = m && m.id != null ? String(m.id) : null;
      if (key === null || !seenIds.has(key)) {
        newCount++;
        if (key !== null) seenIds.add(key);
      }
      items.push({
        id: m.id,
        imdbId: m.id,
        title: m.name,
        year: m.year || '',
        poster: m.poster || null,
        showTitle: m.showTitle || null,
        type: m.type || type,
        seasonNum: m.season != null ? m.season : null,
        episodeNum: m.episode != null ? m.episode : null
      });
    });
    skip += pageItems.length;
    pagesLoaded++;
    if (btn) btn.textContent = 'Copying' + (progressLabel ? ' ' + progressLabel : '') + '\u2026 (' + items.length + ' so far)';
    if (!data.maybeMore || pageItems.length === 0 || newCount === 0) break;
  }
  return items;
}

function getItemKey(it) {
  if (!it) return '';
  if (it.imdbId && String(it.imdbId).trim()) return String(it.imdbId).trim();
  if (it.id && String(it.id).trim()) return String(it.id).trim();
  if (it.tmdbId && String(it.tmdbId).trim()) return 'tmdb:' + String(it.tmdbId).trim();
  const title = String(it.title || it.name || it.showTitle || '').toLowerCase().trim();
  const year = String(it.year || '').trim();
  return title ? (title + ':' + year) : '';
}
window.getItemKey = getItemKey;

function performSmartListMerge(currentItems, baseItemIds, remoteItems, options) {
  options = options || {};
  const mirrorRemovals = !!options.mirrorRemovals;
  const current = Array.isArray(currentItems) ? currentItems : [];
  const remote = Array.isArray(remoteItems) ? remoteItems : [];
  const baseList = Array.isArray(baseItemIds) ? baseItemIds.map(String) : [];

  const currentKeys = new Set(current.map(getItemKey).filter(Boolean));
  const baseSet = new Set(baseList);

  // User removals: items that were in the base snapshot, but are not in current list
  const userRemovedIds = new Set();
  if (baseList.length > 0) {
    baseList.forEach((id) => {
      if (id && !currentKeys.has(id)) {
        userRemovedIds.add(id);
      }
    });
  }

  // Merged items
  const mergedItems = [];
  const mergedKeys = new Set();

  // 1. Keep all current items in their existing user-defined order
  current.forEach((it) => {
    const key = getItemKey(it);
    // If mirroring remote removals and this item was in the base snapshot but dropped upstream, remove it
    if (mirrorRemovals && baseSet.has(key)) {
      const stillInRemote = remote.some((r) => getItemKey(r) === key);
      if (!stillInRemote) return;
    }
    if (key) mergedKeys.add(key);
    mergedItems.push(it);
  });

  // 2. Discover newly added remote items
  let addedCount = 0;
  remote.forEach((r) => {
    const rKey = getItemKey(r);
    if (!rKey) return;
    // Do not resurrect items the user explicitly removed
    if (userRemovedIds.has(rKey)) return;
    // If it's already in the list, skip
    if (mergedKeys.has(rKey)) return;

    // If baseItemIds existed, verify it's a new remote item (not in base snapshot)
    // Or if baseItemIds was empty, it's an item in remote not in current
    if (baseList.length === 0 || !baseSet.has(rKey)) {
      mergedItems.push(r);
      mergedKeys.add(rKey);
      addedCount++;
    }
  });

  const newBaseItemIds = remote.map(getItemKey).filter(Boolean);

  return {
    items: mergedItems,
    addedCount: addedCount,
    newBaseItemIds: newBaseItemIds,
  };
}
window.performSmartListMerge = performSmartListMerge;

// Saves a fresh Custom List directly -- to the account if signed in
// (mirroring confirmSaveAsCreator's /api/creator/lists/save call, Public
// by default same as that picker's own default), to this browser's local
// store otherwise (mirroring saveLocalCustomList). Unlike either of those,
// there's no existing row/draft involved here at all -- this always
// creates a brand new saved list, never edits one in place.
async function saveItemsAsNewCustomList(name, type, items, visibility, extraProps) {
  visibility = visibility === 'private' ? 'private' : 'public';
  extraProps = extraProps || {};
  const sourceUrl = extraProps.sourceUrl || '';
  const synced = extraProps.synced != null ? !!extraProps.synced : !!sourceUrl;
  const lastSyncedAt = Number.isFinite(Number(extraProps.lastSyncedAt))
    ? Number(extraProps.lastSyncedAt)
    : (synced ? Date.now() : undefined);
  const baseItemIds = Array.isArray(extraProps.baseItemIds)
    ? extraProps.baseItemIds
    : (synced ? items.map(getItemKey).filter(Boolean) : undefined);

  if (activeCreator) {
    const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
    try {
      const payload = {
        creatorName: activeCreator.creatorName,
        creatorKey: creatorKey,
        name: name,
        type: type,
        items: items,
        visibility: visibility,
        sourceUrl: sourceUrl,
        synced: synced,
      };
      if (lastSyncedAt !== undefined) payload.lastSyncedAt = lastSyncedAt;
      if (baseItemIds !== undefined) payload.baseItemIds = baseItemIds;
      const res = await fetch(ORIGIN + '/api/creator/lists/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!data.ok) return { ok: false, error: data.error || 'unknown error' };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: 'network error' };
    }
  }
  const map = loadLocalCustomLists();
  const base = slugify(name) || 'list';
  let slug = base;
  let n = 2;
  while (map[slug]) {
    slug = base + '-' + n;
    n++;
  }
  const now = Date.now();
  map[slug] = {
    slug: slug,
    name: name,
    type: type,
    items: items,
    visibility: visibility,
    sourceUrl: sourceUrl,
    synced: synced,
    createdAt: now,
    updatedAt: now
  };
  if (lastSyncedAt !== undefined) map[slug].lastSyncedAt = lastSyncedAt;
  if (baseItemIds !== undefined) map[slug].baseItemIds = baseItemIds;
  const persisted = saveLocalCustomListsMap(map);
  if (!persisted) {
    return { ok: false, error: 'localStorage save failed (likely full \u2014 try clearing out some old Custom Lists, or importing fewer categories at once)' };
  }
  return { ok: true };
}

// Copies a Trakt (or any) list straight into a saved Custom List -- no
// detour through the draft picker for a manual "Save as a List" click,
// since there's nothing to review here that isn't already decided (the
// whole list, as-is). Mixed lists and watch history copy as a unified mixed
// custom list with movies and episodes/shows intact.
const CUSTOM_LIST_CHUNK_SIZE = 6000;

async function copyListToCustomList(name, listUrl, contentType, btn, historyMode, extraProps) {
  const isSingle = contentType === 'movie' || contentType === 'series';
  const typesToFetch = isSingle ? [contentType] : ['movie', 'series'];
  const originalLabel = btn ? btn.textContent : '';

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Copying\u2026';
  }

  const allItems = [];
  let hasMovies = false;
  let hasShows = false;
  const failed = [];

  for (const type of typesToFetch) {
    const typeLabel = type === 'movie' ? 'Movies' : 'Shows';
    let items;
    try {
      items = await fetchAllItemsForList(listUrl, type, btn, !isSingle ? typeLabel : '');
    } catch (e) {
      failed.push({ name: !isSingle ? name + ' (' + typeLabel + ')' : name, error: e.message || 'network error' });
      continue;
    }
    if (!items.length) continue;
    if (type === 'movie') hasMovies = true;
    if (type === 'series') hasShows = true;

    items.forEach((it) => {
      allItems.push({
        id: it.imdbId || it.id,
        imdbId: it.imdbId || (String(it.id || '').startsWith('tt') ? it.id : ''),
        tmdbId: it.tmdbId || '',
        title: it.title || it.name || '',
        year: it.year || '',
        poster: it.poster || null,
        showTitle: it.showTitle || null,
        type: it.type || (it.seasonNum != null ? 'episode' : (type === 'series' ? 'series' : 'movie')),
        seasonNum: it.seasonNum != null ? it.seasonNum : (it.season != null ? it.season : null),
        episodeNum: it.episodeNum != null ? it.episodeNum : (it.episode != null ? it.episode : null)
      });
    });
  }

  if (btn) {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }

  if (!allItems.length) {
    if (failed.length) {
      const errMsg = 'Could not copy: ' + failed.map((f) => f.name + ' (' + f.error + ')').join(', ');
      if (typeof showAppAlert === 'function') {
        showAppAlert('Copy Incomplete', errMsg, false);
      } else {
        alert(errMsg);
      }
    } else {
      if (typeof showAppAlert === 'function') {
        showAppAlert('No Items', 'That list has no items to copy.', false);
      } else {
        alert('That list has no items to copy.');
      }
    }
    return;
  }

  const finalType = (hasMovies && hasShows) ? 'mixed' : (hasShows ? 'series' : 'movie');
  const baseListName = name;
  const created = [];

  const syncProps = Object.assign({}, extraProps);
  if (syncProps.sourceUrl) {
    syncProps.synced = true;
    syncProps.lastSyncedAt = Date.now();
    syncProps.baseItemIds = allItems.map(getItemKey).filter(Boolean);
  }

  for (let i = 0; i * CUSTOM_LIST_CHUNK_SIZE < allItems.length; i++) {
    const chunk = allItems.slice(i * CUSTOM_LIST_CHUNK_SIZE, (i + 1) * CUSTOM_LIST_CHUNK_SIZE);
    const listName = i === 0 ? baseListName : baseListName + ' ' + (i + 1);
    const result = await saveItemsAsNewCustomList(listName, finalType, chunk, 'private', syncProps);
    if (result.ok) {
      created.push({ name: listName, count: chunk.length });
    } else {
      failed.push({ name: listName, error: result.error });
    }
  }

  if (btn) {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }

  if (!created.length && !failed.length) {
    if (typeof showAppAlert === 'function') {
      showAppAlert('No Items', 'That list has no items to copy.', false);
    } else {
      alert('That list has no items to copy.');
    }
    return;
  }
  if (created.length) {
    try {
      if (typeof trackEvent === 'function') {
        // created[0].name, not listName: the latter is a const declared inside
        // the chunking loop above, so this reference -- outside the loop -- was
        // an unbound identifier that threw a ReferenceError into the
        // surrounding catch every single time. This is the ONLY site in the app
        // that emits a list-copy event, so stats:list_copy: never received a
        // write and the admin Community Lists "copies" column (and the
        // likes + copies*2 ranking beside it) has always been structurally
        // zero.
        trackEvent('list-copy', listUrl || created[0].name, created[0].name);
      }
    } catch (e) {}
    renderCreatorDashboard();
  }

  let msg = '';
  if (created.length) {
    msg += 'Created ' + created.map((c) => '"' + c.name + '" (' + c.count + ' item' + (c.count === 1 ? '' : 's') + ')').join(' and ') +
      ' in your Custom Lists \u2014 find them under the Custom Lists tab to add them to your lists.';
  }
  if (failed.length) {
    msg += (msg ? ' | ' : '') + 'Could not copy: ' + failed.map((f) => f.name + ' (' + f.error + ')').join(', ');
  }
  if (typeof showAppAlert === 'function') {
    showAppAlert(failed.length ? 'Copy Incomplete' : 'List Copied', msg, !failed.length);
  } else {
    alert(msg);
  }
}

async function syncCustomListWithExternalSource(slug, btn, options) {
  options = options || {};
  const isSilent = !!options.silent;
  if (!slug) return { ok: false, error: 'missing-slug' };

  let listMeta = null;
  let isServerList = false;
  if (typeof activeCreator !== 'undefined' && activeCreator && Array.isArray(lastCreatorListsData)) {
    listMeta = lastCreatorListsData.find((l) => l && l.slug === slug);
    if (listMeta) isServerList = true;
  }
  const localMap = (typeof loadLocalCustomLists === 'function') ? loadLocalCustomLists() : {};
  if (!listMeta) {
    listMeta = localMap[slug];
    if (listMeta) isServerList = false;
  }
  if (!listMeta) {
    if (!isSilent) {
      if (typeof showAppAlert === 'function') showAppAlert('Sync Error', 'Could not find list: ' + slug, false);
      else alert('Could not find list: ' + slug);
    }
    return { ok: false, error: 'list-not-found' };
  }

  const sourceUrl = listMeta.sourceUrl || (localMap[slug] && localMap[slug].sourceUrl);
  if (!sourceUrl) {
    if (!isSilent) {
      if (typeof showAppAlert === 'function') showAppAlert('Sync Error', 'This list does not have an external source URL.', false);
      else alert('This list does not have an external source URL.');
    }
    return { ok: false, error: 'no-source-url' };
  }

  const originalLabel = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Syncing\u2026';
  }

  try {
    const listType = listMeta.type || (localMap[slug] && localMap[slug].type) || 'mixed';
    const isSingle = listType === 'movie' || listType === 'series';
    const typesToFetch = isSingle ? [listType] : ['movie', 'series'];
    const remoteItems = [];

    for (const type of typesToFetch) {
      const typeLabel = type === 'movie' ? 'Movies' : 'Shows';
      const items = await fetchAllItemsForList(sourceUrl, type, btn, !isSingle ? typeLabel : '');
      if (Array.isArray(items)) {
        items.forEach((it) => {
          remoteItems.push({
            id: it.imdbId || it.id,
            imdbId: it.imdbId || (String(it.id || '').startsWith('tt') ? it.id : ''),
            tmdbId: it.tmdbId || '',
            title: it.title || it.name || '',
            year: it.year || '',
            poster: it.poster || null,
            showTitle: it.showTitle || null,
            type: it.type || (it.seasonNum != null ? 'episode' : (type === 'series' ? 'series' : 'movie')),
            seasonNum: it.seasonNum != null ? it.seasonNum : (it.season != null ? it.season : null),
            episodeNum: it.episodeNum != null ? it.episodeNum : (it.episode != null ? it.episode : null),
          });
        });
      }
    }

    const currentItems = Array.isArray(listMeta.items) ? listMeta.items : ((localMap[slug] && Array.isArray(localMap[slug].items)) ? localMap[slug].items : []);
    const baseItemIds = Array.isArray(listMeta.baseItemIds) ? listMeta.baseItemIds : ((localMap[slug] && Array.isArray(localMap[slug].baseItemIds)) ? localMap[slug].baseItemIds : null);

    const mergeResult = performSmartListMerge(currentItems, baseItemIds, remoteItems, options);
    const now = Date.now();

    // Persist locally
    if (localMap[slug]) {
      localMap[slug].items = mergeResult.items;
      localMap[slug].baseItemIds = mergeResult.newBaseItemIds;
      localMap[slug].lastSyncedAt = now;
      localMap[slug].updatedAt = now;
      localMap[slug].synced = true;
      localMap[slug].sourceUrl = sourceUrl;
      saveLocalCustomListsMap(localMap);
    }

    // Persist to creator account if signed in
    if (typeof activeCreator !== 'undefined' && activeCreator) {
      const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
      if (creatorKey) {
        const body = {
          creatorName: activeCreator.creatorName,
          creatorKey: creatorKey,
          slug: slug,
          name: listMeta.name,
          type: listType,
          items: mergeResult.items,
          visibility: listMeta.visibility || 'private',
          sourceUrl: sourceUrl,
          synced: true,
          lastSyncedAt: now,
          baseItemIds: mergeResult.newBaseItemIds,
        };
        if (Number.isFinite(listMeta.updatedAt)) body.expectedUpdatedAt = listMeta.updatedAt;
        const res = await fetch(ORIGIN + '/api/creator/lists/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const resData = await res.json();
        if (resData && resData.ok && Number.isFinite(resData.updatedAt)) {
          listMeta.updatedAt = resData.updatedAt;
        }
      }
    }

    // Update in-memory metadata
    listMeta.items = mergeResult.items;
    listMeta.itemCount = mergeResult.items.length;
    listMeta.baseItemIds = mergeResult.newBaseItemIds;
    listMeta.lastSyncedAt = now;
    listMeta.synced = true;
    listMeta.sourceUrl = sourceUrl;

    // Sync to catalog shelf rows if added to user's catalogs
    if (typeof syncCustomListToCatalogRows === 'function') {
      syncCustomListToCatalogRows(slug, mergeResult.items, listMeta.name, listType);
    }

    // Refresh dashboard UI if function exists
    if (typeof renderCreatorDashboard === 'function') {
      renderCreatorDashboard({ silent: true });
    }

    if (!isSilent) {
      const msg = mergeResult.addedCount > 0
        ? 'Synced "' + listMeta.name + '": ' + mergeResult.addedCount + ' new item' + (mergeResult.addedCount === 1 ? '' : 's') + ' added.'
        : 'Synced "' + listMeta.name + '": already up to date with external link.';
      if (typeof showAddedToast === 'function') {
        showAddedToast(msg);
      } else if (typeof showAppAlert === 'function') {
        showAppAlert('List Synced', msg, false);
      } else {
        alert(msg);
      }
    }

    return { ok: true, addedCount: mergeResult.addedCount, totalCount: mergeResult.items.length };
  } catch (err) {
    console.error('syncCustomListWithExternalSource error:', err);
    if (!isSilent) {
      const errMsg = 'Could not sync list: ' + (err.message || 'network error');
      if (typeof showAppAlert === 'function') showAppAlert('Sync Error', errMsg, false);
      else alert(errMsg);
    }
    return { ok: false, error: err.message || 'sync-failed' };
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalLabel || 'Sync';
    }
  }
}
window.syncCustomListWithExternalSource = syncCustomListWithExternalSource;

// Walks the connected Trakt account's full watch history (movies, then
// episodes) via /api/trakt-history-raw and adds every item to Watch
// History (and, for shows, Continue Watching) -- the live-account
// equivalent of the Trakt Export importer's "mark as watched" checkbox,
// for someone who's connected Trakt directly rather than uploading an
// export file. Reuses mapTraktExportEntryToWatchHistoryItem unchanged: the
// raw row shape is identical either way, since Trakt's own export is
// generated from this same API.
async function markTraktHistoryAllWatched(btn) {
  if (!traktAccessToken) {
    if (typeof showAppAlert === 'function') {
      showAppAlert('Trakt Not Connected', 'Please connect your Trakt account in Settings first.', false);
    } else {
      alert('Connect Trakt first.');
    }
    return;
  }
  const originalLabel = btn ? btn.textContent : '';
  if (btn) btn.disabled = true;

  const MAX_PAGES = 100;
  const whItems = [];
  const seenIds = new Set();
  let hitPageCap = false;

  for (const kind of ['movies', 'episodes']) {
    let page = 1;
    let hasMore = true;
    while (hasMore && page <= MAX_PAGES) {
      if (btn) btn.textContent = 'Fetching ' + kind + ' (page ' + page + ')\u2026';
      let data;
      try {
        const res = await fetch(ORIGIN + '/api/trakt-history-raw', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accessToken: traktAccessToken, type: kind, page: page, limit: 100 }),
        });
        data = await res.json();
      } catch (e) {
        if (typeof showAppAlert === 'function') {
          showAppAlert('Network Error', 'Network error fetching Trakt history.', false);
        } else {
          alert('Network error fetching Trakt history.');
        }
        if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
        return;
      }
      if (!data.ok) {
        if (typeof showAppAlert === 'function') {
          showAppAlert('Error', data.error || 'Could not fetch Trakt history.', false);
        } else {
          alert(data.error || 'Could not fetch Trakt history.');
        }
        if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
        return;
      }
      (data.items || []).forEach((it) => {
        const mapped = mapTraktExportEntryToWatchHistoryItem(it);
        // A rewatch logs a fresh row every time -- Watch History only
        // needs one entry per item, same dedupe as the Export importer.
        if (!mapped || seenIds.has(mapped.id)) return;
        seenIds.add(mapped.id);
        whItems.push(mapped);
      });
      hasMore = !!data.hasMore;
      page++;
    }
    if (page > MAX_PAGES && hasMore) hitPageCap = true;
  }

  if (!whItems.length) {
    if (typeof showAppAlert === 'function') {
      showAppAlert('No History', 'No watch history found on your Trakt account.', false);
    } else {
      alert('No watch history found on your Trakt account.');
    }
    if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
    return;
  }

  if (btn) btn.textContent = 'Marking ' + whItems.length + ' item(s) as watched\u2026';
  const whResult = await addItemsToWatchHistory(whItems, true);
  if (btn) { btn.disabled = false; btn.textContent = originalLabel; }

  if (whResult.quotaExceeded) {
    const msg = 'Not enough local storage space to save your history. Your browser limits storage to ~5MB. Please delete some large custom lists and try again.';
    if (typeof showAppAlert === 'function') showAppAlert('Storage Full', msg, false);
    else alert(msg);
    return;
  }

  let msg = 'Marked ' + whResult.added + ' item' + (whResult.added === 1 ? '' : 's') + ' as watched \u2014 find them under Watch History.';
  if (whResult.cwTotal) {
    msg += ' Continue Watching checked for ' + whResult.cwSucceeded + ' of ' + whResult.cwTotal + ' show' + (whResult.cwTotal === 1 ? '' : 's') +
      (whResult.cwSucceeded < whResult.cwTotal ? ' \u2014 the rest hit a network hiccup or TMDB rate limit; reopening one of those shows will retry it, or run this again.' : '.');
  }
  if (hitPageCap) {
    msg += ' (Your history is large enough that this only covered the ' + (MAX_PAGES * 100).toLocaleString() + ' most recent watches per type \u2014 run it again later to pick up more.)';
  }
  if (typeof showAppAlert === 'function') {
    showAppAlert('Trakt History Synced', msg, true);
  } else {
    alert(msg);
  }
}

function mapMdblistItemsToWatchHistory(rawItems) {
  const whItems = [];
  const seenIds = new Set();

  (rawItems || []).forEach((it) => {
    if (!it) return;
    // MDBList sync/watched episode shape: { last_watched_at, episode: { season, number, name, ids, show: { title, year, ids: { imdb, tmdb } }, poster } }
    // MDBList sync/watched movie shape:   { last_watched_at, movie: { title, year, ids: { imdb, tmdb } } }
    const ep = it.episode || null;
    const epShow = ep && ep.show ? ep.show : null;   // show nested inside episode
    const inner = it.show || it.movie || epShow || it;
    const watchedAtMs = (() => {
      const d = it.last_watched_at || it.watched_at || inner.last_watched_at || inner.watched_at;
      if (!d) return Date.now();
      const t = new Date(d).getTime();
      return isNaN(t) ? Date.now() : t;
    })();

    const imdbId = inner.imdb_id || inner.imdbid ||
                   (inner.ids && inner.ids.imdb) ||
                   (typeof inner.id === 'string' && inner.id.startsWith('tt') ? inner.id : '');
    const tmdbId = inner.tmdb_id || inner.tmdbid || (inner.ids && inner.ids.tmdb) || '';
    const isMovie = !ep && !epShow && !it.show && (it.movie || inner.mediatype === 'movie' || inner.type === 'movie');

    if (!imdbId && !tmdbId) return;

    if (isMovie) {
      const poster = inner.poster || it.poster || (imdbId ? 'https://images.metahub.space/poster/medium/' + imdbId + '/img' : '');
      const id = imdbId || ('tmdb:' + tmdbId);
      if (!seenIds.has(id)) {
        seenIds.add(id);
        whItems.push({
          id: id,
          imdbId: imdbId || undefined,
          tmdbId: tmdbId ? String(tmdbId) : undefined,
          type: 'movie',
          title: inner.title || inner.name || 'Movie',
          year: inner.release_year ? String(inner.release_year) : (inner.year ? String(inner.year) : ''),
          poster: inner.poster || it.poster || (imdbId ? 'https://images.metahub.space/poster/medium/' + imdbId + '/img' : ''),
          watchedAt: watchedAtMs,
        });
      }
      return;
    }

    // Series / Episode
    const showTitle = inner.title || inner.name || it.title || 'Show';
    // showPoster: full show artwork used by catalog renderer (metahub keyed by IMDb ID)
    // poster: episode still image used by the history-shelf item renderer
    const showPoster = imdbId ? 'https://images.metahub.space/poster/medium/' + imdbId + '/img' : (inner.poster || '');
    const showId = imdbId || (tmdbId ? ('tmdb:' + tmdbId) : '');

    if (ep) {
      const seasonNum = ep.season || 1;
      const epNum = ep.number || ep.episode || 1;
      const epTmdbId = ep.ids && ep.ids.tmdb ? String(ep.ids.tmdb) : (ep.tmdb_id ? String(ep.tmdb_id) : '');
      const epKey = showId + ':' + seasonNum + ':' + epNum;
      if (!seenIds.has(epKey)) {
        seenIds.add(epKey);
        whItems.push({
          id: epTmdbId || epKey,
          type: 'episode',
          name: ep.name || ep.title || ('Episode ' + epNum),
          showTitle: showTitle,
          showId: showId,
          showPoster: showPoster,
          seasonNum: seasonNum,
          episodeNum: epNum,
          poster: ep.poster || ep.still || showPoster,
          watchedAt: watchedAtMs,
        });
      }
      return;
    }

    if (Array.isArray(inner.seasons) && inner.seasons.length) {
      inner.seasons.forEach((s) => {
        const seasonNum = s.number || s.season_number || s.season || 1;
        if (Array.isArray(s.episodes) && s.episodes.length) {
          s.episodes.forEach((sep) => {
            const epNum = sep.number || sep.episode_number || sep.episode || 1;
            const epTmdbId = sep.tmdb_id || sep.tmdbid || (sep.ids && sep.ids.tmdb) || '';
            const epKey = showId + ':' + seasonNum + ':' + epNum;
            if (!seenIds.has(epKey)) {
              seenIds.add(epKey);
              whItems.push({
                id: epTmdbId ? String(epTmdbId) : epKey,
                type: 'episode',
                name: sep.name || sep.title || ('Episode ' + epNum),
                showTitle: showTitle,
                showId: showId,
                showPoster: showPoster,
                seasonNum: seasonNum,
                // episodeNum, not epNum. Every reader of a Watch History
                // entry -- the SxxExx label, the Continue Watching
                // recompute, the episode-still backfill in
                // 21_client-custom-list-builder.js -- looks for
                // episodeNum, so an entry written with epNum was
                // effectively an episode with no episode number.
                episodeNum: epNum,
                poster: showPoster,
                watchedAt: sep.watched_at || sep.last_watched_at ? (new Date(sep.watched_at || sep.last_watched_at).getTime() || watchedAtMs) : watchedAtMs,
              });
            }
          });
        }
      });
    } else {
      const epKey = showId + ':' + (inner.season || 1) + ':' + (inner.episode || 1);
      if (!seenIds.has(epKey)) {
        seenIds.add(epKey);
        whItems.push({
          id: inner.episode_tmdb_id ? String(inner.episode_tmdb_id) : epKey,
          type: inner.season ? 'episode' : 'series',
          name: inner.episode_title || showTitle,
          showTitle: showTitle,
          showId: showId,
          showPoster: showPoster,
          seasonNum: inner.season || 1,
          episodeNum: inner.episode || 1,
          poster: showPoster,
          watchedAt: watchedAtMs,
        });
      }
    }
  });

  return whItems;
}

async function markMdblistHistoryAllWatched(btn) {
  const manualKey = document.getElementById('mdblistKeyInput') ? document.getElementById('mdblistKeyInput').value.trim() : '';
  const token = mdblistAccessToken || manualKey;
  if (!token) {
    if (typeof showAppAlert === 'function') {
      showAppAlert('MDBList Not Connected', 'Please connect your MDBList account or enter an API key in Settings first.', false);
    } else {
      alert('Connect MDBList first.');
    }
    return;
  }
  const originalLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Fetching MDBList history\u2026'; }

  // Paginate through all pages of sync/watched
  const MAX_PAGES = 50;
  let allRawItems = [];
  let page = 1;
  let fetchMore = true;
  while (fetchMore && page <= MAX_PAGES) {
    if (btn) btn.textContent = 'Fetching MDBList history (page ' + page + ')\u2026';
    let data;
    try {
      const res = await fetch(ORIGIN + '/api/mdblist-history-raw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken: mdblistAccessToken, apikey: manualKey, page }),
      });
      data = await res.json();
    } catch (e) {
      if (typeof showAppAlert === 'function') {
        showAppAlert('Network Error', 'Network error fetching MDBList history (page ' + page + ').', false);
      } else {
        alert('Network error fetching MDBList history.');
      }
      if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
      return;
    }
    if (!data.ok) {
      if (typeof showAppAlert === 'function') {
        showAppAlert('Error', data.error || 'Could not fetch MDBList history.', false);
      } else {
        alert(data.error || 'Could not fetch MDBList history.');
      }
      if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
      return;
    }
    allRawItems = allRawItems.concat(data.items || []);
    fetchMore = !!data.hasMore;
    page++;
  }

  const whItems = mapMdblistItemsToWatchHistory(allRawItems);
  console.log('[MDBList] raw items:', allRawItems.length, 'mapped:', whItems.length);

  if (!whItems.length) {
    const detailMsg = 'No watch history found on your MDBList account. Fetched ' + allRawItems.length + ' raw items from MDBList.';
    if (typeof showAppAlert === 'function') {
      showAppAlert('No History', detailMsg, false);
    } else {
      alert(detailMsg);
    }
    if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
    return;
  }

  if (btn) btn.textContent = 'Marking ' + whItems.length + ' item(s) as watched\u2026';
  const whResult = await addItemsToWatchHistory(whItems, true);
  if (btn) { btn.disabled = false; btn.textContent = originalLabel; }

  if (whResult.quotaExceeded) {
    const msg = 'Not enough local storage space to save your history. Your browser limits storage to ~5MB. Please delete some large custom lists and try again.';
    if (typeof showAppAlert === 'function') showAppAlert('Storage Full', msg, false);
    else alert(msg);
    return;
  }

  let msg = 'Marked ' + whResult.added + ' item' + (whResult.added === 1 ? '' : 's') + ' as watched \u2014 find them under Watch History.';
  if (whResult.cwTotal) {
    msg += ' Continue Watching checked for ' + whResult.cwSucceeded + ' of ' + whResult.cwTotal + ' show' + (whResult.cwTotal === 1 ? '' : 's') +
      (whResult.cwSucceeded < whResult.cwTotal ? ' \u2014 reopening one of those shows will retry it, or run this again.' : '.');
  }
  if (typeof showAppAlert === 'function') {
    showAppAlert('MDBList History Synced', msg, true);
  } else {
    alert(msg);
  }
}

async function markSimklListAllWatched(btn) {
  const token = (typeof simklAccessToken !== 'undefined' && simklAccessToken) || localStorage.getItem('myListAddon:simklAccessToken') || '';
  if (!token) {
    if (typeof showAppAlert === 'function') {
      showAppAlert('Simkl Not Connected', 'Please connect your Simkl account in Settings first.', false);
    } else {
      alert('Connect Simkl first.');
    }
    return;
  }
  const originalLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Fetching items\u2026'; }

  const listUrl = btn ? btn.getAttribute('data-url') : '';
  const listName = btn ? btn.getAttribute('data-name') : 'Simkl Completed';
  const listType = btn ? btn.getAttribute('data-type') : 'movie';

  try {
    const rawItems = await fetchAllItemsForList(listUrl, listType, btn);
    if (!rawItems || !rawItems.length) {
      if (typeof showAppAlert === 'function') {
        showAppAlert('No Items', 'No items found in ' + listName + '.', false);
      } else {
        alert('No items found in ' + listName + '.');
      }
      if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
      return;
    }

    const whItems = [];
    const seenIds = new Set();

    for (const it of rawItems) {
      const isMovie = it.type === 'movie' || (!it.showId && it.type !== 'series' && it.type !== 'episode');
      const rootImdb = it.imdbId || (String(it.id || '').startsWith('tt') ? String(it.id).split(':')[0] : '');
      const rootTmdb = it.tmdbId ? String(it.tmdbId).split(':')[0] : (!isNaN(parseInt(it.id, 10)) ? String(parseInt(it.id, 10)) : '');
      const showId = it.showId || rootImdb || (rootTmdb ? 'tmdb:' + rootTmdb : it.id);
      const title = it.title || it.name || it.showTitle || '';
      const showTitle = it.showTitle || it.title || it.name || '';
      const poster = it.poster || '';
      const showPoster = it.showPoster || it.poster || '';

      if (isMovie) {
        const id = rootImdb || (rootTmdb ? 'tmdb:' + rootTmdb : it.id);
        if (!seenIds.has(id)) {
          seenIds.add(id);
          whItems.push({
            id: id,
            imdbId: rootImdb || undefined,
            tmdbId: rootTmdb || undefined,
            type: 'movie',
            name: title,
            title: title,
            year: it.year || '',
            poster: poster,
            watchedAt: Date.now(),
          });
        }
      } else {
        const epKey = (it.seasonNum != null && it.episodeNum != null) ? (showId + ':' + it.seasonNum + ':' + it.episodeNum) : showId;
        if (!seenIds.has(epKey)) {
          seenIds.add(epKey);
          whItems.push({
            id: epKey,
            imdbId: rootImdb || undefined,
            tmdbId: rootTmdb || undefined,
            type: it.seasonNum != null ? 'episode' : 'series',
            name: title,
            title: title,
            showTitle: showTitle,
            showId: showId,
            showPoster: showPoster,
            seasonNum: it.seasonNum || null,
            episodeNum: it.episodeNum || null,
            poster: poster || showPoster,
            watchedAt: Date.now(),
          });
        }
      }
    }

    if (btn) btn.textContent = 'Marking ' + whItems.length + ' item(s) as watched\u2026';
    const whResult = await addItemsToWatchHistory(whItems, true);
    if (btn) { btn.disabled = false; btn.textContent = originalLabel; }

    if (whResult.quotaExceeded) {
      const msg = 'Not enough local storage space to save your history. Your browser limits storage to ~5MB. Please delete some large custom lists and try again.';
      if (typeof showAppAlert === 'function') showAppAlert('Storage Full', msg, false);
      else alert(msg);
      return;
    }

    let msg = 'Marked ' + whResult.added + ' item' + (whResult.added === 1 ? '' : 's') + ' as watched \u2014 find them under Watch History.';
    if (whResult.cwTotal) {
      msg += ' Continue Watching checked for ' + whResult.cwSucceeded + ' of ' + whResult.cwTotal + ' show' + (whResult.cwTotal === 1 ? '' : 's') + '.';
    }
    if (typeof showAppAlert === 'function') {
      showAppAlert('Simkl Completed Synced', msg, true);
    } else {
      alert(msg);
    }
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
    if (typeof showAppAlert === 'function') {
      showAppAlert('Error', 'Could not mark items as watched: ' + (err.message || 'network error'), false);
    } else {
      alert('Could not mark items as watched: ' + (err.message || 'network error'));
    }
  }
}

// Sends an arbitrarily large title list to /api/bulk-resolve in bounded
// chunks and returns every resolved row together.
//
// That endpoint issues up to two TMDB calls per item and always spends the
// Worker owner's shared key, so it now caps a single request at
// BULK_RESOLVE_ITEMS_MAX (see 00_constants.js). Sending a whole category
// in one request, as this used to, exceeded Cloudflare's per-invocation
// subrequest limit well before the cap existed -- so a big Letterboxd
// import did not partly work, it failed the category outright. Chunking
// makes an import of any size succeed as several bounded calls, and the
// chunk size comes from the same constant the server validates against so
// the two cannot drift apart.
//
// The server may also process only PART of a chunk and say so: its outbound
// budget is 50 fetches per invocation on a free Cloudflare Worker and two per
// title, so 200 titles do not fit there. It answers with nextIndex -- how
// many of the titles just sent it got through -- and the loop resumes from
// exactly there. A deployment that predates that sends no nextIndex, which is
// read as "the whole chunk", so this keeps working against an older Worker.
//
// Advancing by anything other than what the server actually consumed is how
// an import silently drops titles, which is worse than failing, so a reply
// claiming no progress is treated as an error rather than retried forever.
//
// Throws on the first failed chunk, matching the previous single-request
// behaviour: each caller already has its own catch that reports the
// category as failed rather than silently importing half of it.
async function bulkResolveInChunks(items) {
  const list = Array.isArray(items) ? items : [];
  const CHUNK = ${BULK_RESOLVE_ITEMS_MAX};
  const out = [];
  let i = 0;
  while (i < list.length) {
    const sent = Math.min(CHUNK, list.length - i);
    const res = await fetch(ORIGIN + '/api/bulk-resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: list.slice(i, i + sent) }),
    });
    const data = await res.json();
    if (!data || !data.ok) throw new Error((data && data.error) || 'unknown error');
    if (Array.isArray(data.resolved)) out.push.apply(out, data.resolved);
    const consumed = Number.isFinite(data.nextIndex) ? Math.min(data.nextIndex, sent) : sent;
    if (consumed < 1) throw new Error('the server made no progress on this batch');
    i += consumed;
  }
  return out;
}

// --- Trakt history row -> Watch History item ------------------------------
//
// Used by the live Trakt history import above (readTraktHistoryRaw's own
// mapping step). It used to live inside a Trakt-export-zip importer that this
// build no longer renders: both that and its Letterboxd twin bound their file
// inputs with
//   document.getElementById('traktExportFileInput')?.addEventListener(...)
// at script-evaluation time, and neither id exists in the page any more --
// optional chaining meant they simply never attached, and ~530 lines behind
// them, runTraktExportImport and runLetterboxdExportImport included, were
// unreachable. The unified importer (onUnifiedImportFilesSelected, below)
// replaced both and reads .zip itself. This mapper is the one piece of it that
// something live still calls.
// Maps one raw History row to the shape addItemsToWatchHistory expects --
// used by the "Also add these to Watch History" checkbox. An episode row
// needs a real TMDB episode id (the same id space Watch History uses
// everywhere else in this add-on, e.g. toggleWatchStatus/markSeasonWatched)
// to key on; Trakt's own export includes one at it.episode.ids.tmdb, so a
// row missing that (older export format, or an episode TMDB has since
// delisted) is skipped rather than guessed at with a Trakt-specific id
// that nothing else in this app would recognize.
function mapTraktExportEntryToWatchHistoryItem(it) {
  // Trakt's history rows always carry a real watched_at (ISO 8601) --
  // both the live API and the export JSON use the exact same shape, since
  // the export is generated from this same API. Falls back to "now" only
  // if it's ever missing or unparseable, so an import still lands
  // somewhere sensible rather than being silently dropped.
  const watchedAtMs = (() => {
    if (!it.watched_at) return Date.now();
    const t = new Date(it.watched_at).getTime();
    return isNaN(t) ? Date.now() : t;
  })();
  if (it.type === 'episode' && it.show && it.show.ids && it.show.ids.imdb && it.episode) {
    const epId = it.episode.ids && it.episode.ids.tmdb ? String(it.episode.ids.tmdb) : null;
    if (!epId) return null;
    const showPoster = 'https://images.metahub.space/poster/medium/' + it.show.ids.imdb + '/img';
    return {
      id: epId,
      type: 'episode',
      name: it.episode.title || '',
      // Trakt's export carries no per-episode still image -- fall back to
      // the show poster (see this function's own comment above).
      poster: showPoster,
      showId: it.show.ids.imdb,
      showTitle: it.show.title || '',
      showPoster: showPoster,
      seasonNum: it.episode.season,
      episodeNum: it.episode.number,
      watchedAt: watchedAtMs,
    };
  }
  const obj = it.movie;
  if (!obj || !obj.ids || !obj.ids.imdb) return null;
  return {
    id: obj.ids.imdb,
    type: 'movie',
    name: obj.title || '',
    poster: 'https://images.metahub.space/poster/medium/' + obj.ids.imdb + '/img',
    watchedAt: watchedAtMs,
  };
}

// --- Unified Multi-Format List Importer -----------------------------------
let unifiedImportSelectedFiles = [];
let discoveredImportCategories = [];

function populateImportTargetLists() {
  const sel = document.getElementById('importTargetListSelect');
  if (!sel) return;
  const currentVal = sel.value;
  const map = typeof loadLocalCustomLists === 'function' ? loadLocalCustomLists() : {};
  let options = '<option value="watchlist">Watchlist</option>' +
    '<option value="watch-history">Watch History</option>';

  const userLists = Object.keys(map).filter(k => k !== 'watchlist' && k !== 'watch-history' && k !== 'continue-watching');
  if (userLists.length) {
    options += '<optgroup label="Your Custom Lists">';
    userLists.forEach(slug => {
      const l = map[slug];
      if (l) options += '<option value="list:' + escapeAttr(slug) + '">' + escapeHtml(l.name || slug) + ' (' + (l.type === 'series' ? 'Shows' : (l.type === 'movie' ? 'Movies' : 'Mixed')) + ')</option>';
    });
    options += '</optgroup>';
  }
  options += '<option value="new">+ Create New Custom List&hellip;</option>';
  sel.innerHTML = options;
  if (currentVal && Array.from(sel.options).some(o => o.value === currentVal)) {
    sel.value = currentVal;
  }
  onImportTargetListChange();
}

function onImportTargetListChange() {
  const sel = document.getElementById('importTargetListSelect');
  const wrap = document.getElementById('importNewListInputWrap');
  if (!sel || !wrap) return;
  wrap.style.display = sel.value === 'new' ? 'block' : 'none';
}

function buildCategoryTargetOptionsHtml(defaultTarget, defaultNewName) {
  const map = typeof loadLocalCustomLists === 'function' ? loadLocalCustomLists() : {};
  let opts = '<option value="watchlist"' + (defaultTarget === 'watchlist' ? ' selected' : '') + '>Watchlist</option>' +
    '<option value="watch-history"' + (defaultTarget === 'watch-history' ? ' selected' : '') + '>Watch History</option>';

  const userLists = Object.keys(map).filter(k => k !== 'watchlist' && k !== 'watch-history' && k !== 'continue-watching');
  if (userLists.length) {
    opts += '<optgroup label="Your Custom Lists">';
    userLists.forEach(slug => {
      const l = map[slug];
      if (l) {
        const val = 'list:' + slug;
        opts += '<option value="' + escapeAttr(val) + '"' + (defaultTarget === val ? ' selected' : '') + '>' + escapeHtml(l.name || slug) + '</option>';
      }
    });
    opts += '</optgroup>';
  }
  const cleanNewName = defaultNewName || 'Imported List';
  opts += '<option value="new:' + escapeAttr(cleanNewName) + '"' + (defaultTarget.startsWith('new') ? ' selected' : '') + '>+ New List: ' + escapeHtml(cleanNewName) + '</option>';
  return opts;
}

function renderDiscoveredCategories() {
  const box = document.getElementById('unifiedImportResult');
  if (!box) return;

  if (!discoveredImportCategories.length) {
    box.innerHTML = '';
    return;
  }

  const globalTargetWrap = document.getElementById('importTargetListSelect')?.closest('div');
  const globalNewWrap = document.getElementById('importNewListInputWrap');
  if (globalTargetWrap) globalTargetWrap.style.display = discoveredImportCategories.length > 1 ? 'none' : '';
  if (globalNewWrap && discoveredImportCategories.length > 1) globalNewWrap.style.display = 'none';

  let html = '<div style="margin-top:10px; border-top:1px solid var(--border); padding-top:12px;">' +
    '<p style="font-weight:600; font-size:0.9rem; margin-bottom:8px; color:var(--text);">Discovered Lists & Categories (' + discoveredImportCategories.length + '):</p>' +
    '<div style="display:flex; flex-direction:column; gap:10px;">';

  discoveredImportCategories.forEach((cat, idx) => {
    const isWatchedOrDiary = cat.isWatchCategory || cat.id.includes('watch') || cat.id.includes('diary') || cat.id.includes('history');
    const watchToggle = isWatchedOrDiary
      ? '<div style="margin-left:26px; margin-top:4px;"><label style="font-size:0.8rem; color:var(--muted); cursor:pointer; display:inline-flex; align-items:center; gap:5px;"><input type="checkbox" class="importCatAlsoMarkWatchedCheck" data-cat-index="' + idx + '" checked> Also add to Watch History (marks watched)</label></div>'
      : '';

    html += '<div class="row" style="flex-direction:column; align-items:flex-start; padding:10px 12px; background:var(--bg-2, rgba(255,255,255,0.03)); border:1px solid var(--border); border-radius:8px;">' +
      '<div style="display:flex; align-items:center; justify-content:space-between; width:100%; flex-wrap:wrap; gap:8px;">' +
        '<label style="display:inline-flex; align-items:center; gap:8px; font-weight:600; font-size:0.9rem; cursor:pointer; color:var(--text);">' +
          '<input type="checkbox" class="importCatCheck" data-cat-index="' + idx + '" checked> ' +
          escapeHtml(cat.label) +
          ' <span style="font-weight:normal; color:var(--muted); font-size:0.82rem;">(' + cat.items.length + ' entries)</span>' +
        '</label>' +
        '<div style="display:inline-flex; align-items:center; gap:6px;">' +
          '<span style="font-size:0.8rem; color:var(--muted);">Destination:</span>' +
          '<select class="importCatTargetSelect" data-cat-index="' + idx + '" style="padding:6px 10px; font-size:0.85rem; border-radius:6px; border:1px solid var(--border); background:var(--bg); color:var(--text);">' +
            buildCategoryTargetOptionsHtml(cat.defaultTarget, cat.defaultNewName) +
          '</select>' +
        '</div>' +
      '</div>' +
      watchToggle +
    '</div>';
  });

  html += '</div></div>';
  box.innerHTML = html;
}

async function onUnifiedImportFilesSelected(input) {
  unifiedImportSelectedFiles = input.files ? Array.from(input.files) : [];
  discoveredImportCategories = [];
  const countEl = document.getElementById('unifiedImportSelectedCount');
  const box = document.getElementById('unifiedImportResult');
  const sourceSel = document.getElementById('importListSourceSelect');
  const selectedSource = sourceSel ? sourceSel.value : 'auto';

  if (!countEl) return;
  if (!unifiedImportSelectedFiles.length) {
    countEl.textContent = 'No files selected';
    if (box) box.innerHTML = '';
    return;
  }

  if (unifiedImportSelectedFiles.length === 1) {
    countEl.textContent = unifiedImportSelectedFiles[0].name;
  } else {
    countEl.textContent = unifiedImportSelectedFiles.length + ' files selected';
  }

  if (box) {
    box.innerHTML = '<p style="margin-top:10px; font-size:0.85rem; color:var(--muted);"><small>Scanning file(s)&hellip;</small></p>';
  }

  const discovered = [];

  for (const file of unifiedImportSelectedFiles) {
    const isZip = file.name.toLowerCase().endsWith('.zip');
    if (isZip) {
      if (typeof fflate === 'undefined') {
        if (box) box.innerHTML = '<p class="testresult err">\u2717 The zip reader library (fflate) is not loaded.</p>';
        return;
      }
      try {
        const buf = await file.arrayBuffer();
        const zipEntries = fflate.unzipSync(new Uint8Array(buf));
        const entriesByCat = new Map();

        for (const [entryName, u8data] of Object.entries(zipEntries)) {
          if (entryName.endsWith('/') || entryName.startsWith('__MACOSX')) continue;
          const lowerName = entryName.toLowerCase();
          const baseName = entryName.split('/').pop() || entryName;
          const lowerBase = baseName.toLowerCase();

          if (!lowerName.endsWith('.csv') && !lowerName.endsWith('.json') && !lowerName.endsWith('.txt')) continue;

          const text = fflate.strFromU8(u8data);
          const items = extractItemsFromFileContent(baseName, text, selectedSource);
          if (!items.length) continue;

          // Categorization & chunk grouping logic for Trakt, Letterboxd, Simkl, and custom lists
          const noExt = baseName.replace(/\.[^.]+$/, '');
          // Strip chunk number suffixes e.g. -1, -2, _1, .part1, (1)
          const cleanBase = noExt.replace(/[-_ ]\d+$/, '').replace(/\.part\d+$/, '');
          const lowerClean = cleanBase.toLowerCase();

          let catKey = lowerClean;
          let catLabel = '';
          let defaultTarget = 'new';
          let defaultNewName = '';
          let isWatchCategory = false;

          if (lowerClean === 'watched-history' || lowerClean === 'history') {
            catKey = 'history';
            catLabel = 'Watch History';
            defaultTarget = 'watch-history';
            isWatchCategory = true;
          } else if (lowerClean === 'watched-movies') {
            catKey = 'watched-movies';
            catLabel = 'Watched Movies';
            defaultTarget = 'watch-history';
            isWatchCategory = true;
          } else if (lowerClean === 'watched-shows') {
            catKey = 'watched-shows';
            catLabel = 'Watched Shows';
            defaultTarget = 'watch-history';
            isWatchCategory = true;
          } else if (lowerClean === 'watched') {
            catKey = 'watched';
            catLabel = 'Watched (all-time list)';
            defaultTarget = 'watch-history';
            isWatchCategory = true;
          } else if (lowerClean === 'collection-movies') {
            catKey = 'collection-movies';
            catLabel = 'Collection Movies';
            defaultTarget = 'new';
            defaultNewName = 'Collection Movies';
          } else if (lowerClean === 'collection-shows') {
            catKey = 'collection-shows';
            catLabel = 'Collection Shows';
            defaultTarget = 'new';
            defaultNewName = 'Collection Shows';
          } else if (lowerClean === 'collection') {
            catKey = 'collection';
            catLabel = 'Collection';
            defaultTarget = 'new';
            defaultNewName = 'Collection';
          } else if (lowerClean === 'lists-watchlist' || lowerClean === 'watchlist') {
            catKey = 'watchlist';
            catLabel = 'Watchlist';
            defaultTarget = 'watchlist';
          } else if (lowerClean === 'ratings-movies') {
            catKey = 'ratings-movies';
            catLabel = 'Ratings Movies';
            defaultTarget = 'new';
            defaultNewName = 'Ratings Movies';
          } else if (lowerClean === 'ratings-shows') {
            catKey = 'ratings-shows';
            catLabel = 'Ratings Shows';
            defaultTarget = 'new';
            defaultNewName = 'Ratings Shows';
          } else if (lowerClean === 'ratings') {
            catKey = 'ratings';
            catLabel = 'Ratings';
            defaultTarget = 'new';
            defaultNewName = 'Ratings';
          } else if (lowerClean === 'diary') {
            catKey = 'diary';
            catLabel = 'Diary';
            defaultTarget = 'watch-history';
            isWatchCategory = true;
          } else if (lowerName.includes('lists/') || lowerClean.startsWith('lists-')) {
            const listName = cleanBase.replace(/^lists-?/, '').replace(/[-_]/g, ' ').trim();
            // Doubled backslashes (\\b\\w) required here -- see
            // guessNameFromUrl's own comment in 19_client-search-and-likes.js
            // for why: this file's text passes through the outer template
            // literal's own backslash-escape processing before the browser
            // parses it, so a single \b\w here would reach the browser as a
            // regex matching a literal backspace byte + "w" (matches
            // nothing) instead of word-boundary + word-character.
            const titleCase = listName.replace(/\\b\\w/g, c => c.toUpperCase());
            catKey = 'list_' + lowerClean;
            catLabel = 'List: ' + titleCase;
            defaultTarget = 'new';
            defaultNewName = titleCase;
          } else {
            // Doubled backslashes required -- see the titleCase comment
            // just above.
            const humanName = cleanBase.replace(/[-_]/g, ' ').trim().replace(/\\b\\w/g, c => c.toUpperCase());
            catKey = lowerClean;
            catLabel = humanName;
            defaultTarget = (lowerClean.includes('watchlist') ? 'watchlist' : (lowerClean.includes('history') || lowerClean.includes('watched') ? 'watch-history' : 'new'));
            defaultNewName = humanName;
            isWatchCategory = defaultTarget === 'watch-history';
          }

          if (!entriesByCat.has(catKey)) {
            entriesByCat.set(catKey, {
              id: catKey,
              label: catLabel,
              items: [],
              defaultTarget: defaultTarget,
              defaultNewName: defaultNewName,
              isWatchCategory: isWatchCategory
            });
          }
          entriesByCat.get(catKey).items.push(...items);
        }

        for (const cat of entriesByCat.values()) {
          // Dedupe within category
          const uMap = new Map();
          cat.items.forEach(it => {
            const k = it.imdbId ? ('imdb:' + it.imdbId) : (it.title ? ((it.title + '|' + it.year).toLowerCase()) : ('raw:' + it.id));
            if (!uMap.has(k)) uMap.set(k, it);
          });
          cat.items = Array.from(uMap.values());
          if (cat.items.length) discovered.push(cat);
        }
      } catch (err) {
        if (box) box.innerHTML = '<p class="testresult err">\u2717 Could not read zip: ' + escapeHtml(err && err.message ? err.message : String(err)) + '</p>';
        return;
      }
    } else {
      // Standalone single file (.csv, .json, .txt)
      try {
        const text = await file.text();
        const items = extractItemsFromFileContent(file.name, text, selectedSource);
        if (items.length) {
          const lowerName = file.name.toLowerCase();
          let defaultTarget = 'watchlist';
          if (lowerName.includes('history') || lowerName.includes('watched') || lowerName.includes('diary')) {
            defaultTarget = 'watch-history';
          }
          const defaultNewName = file.name.replace(/\.[^.]+$/, '');
          discovered.push({
            id: 'file_' + file.name,
            label: file.name,
            items: items,
            defaultTarget: defaultTarget,
            defaultNewName: defaultNewName,
            isWatchCategory: defaultTarget === 'watch-history'
          });
        }
      } catch (err) {}
    }
  }

  discoveredImportCategories = discovered;
  if (!discoveredImportCategories.length) {
    if (box) box.innerHTML = '<p class="testresult err">\u2717 No recognizable movie or TV show entries found in selected file(s).</p>';
    return;
  }

  renderDiscoveredCategories();
}

// Parses arbitrary CSV text into an array of objects
function parseCsvToRows(text) {
  const cr = String.fromCharCode(13);
  const lf = String.fromCharCode(10);
  const cleanText = text ? text.split(cr).join('') : '';
  const lines = cleanText.split(lf).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  
  function parseLine(line) {
    const cells = [];
    let inQuotes = false;
    let cell = '';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        cells.push(cell.trim());
        cell = '';
      } else {
        cell += ch;
      }
    }
    cells.push(cell.trim());
    return cells;
  }

  const cleanHeaderRgx = new RegExp('[^a-z0-9]', 'g');
  const headers = parseLine(lines[0]).map(h => h.toLowerCase().replace(cleanHeaderRgx, ''));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseLine(lines[i]);
    if (!vals.length || (vals.length === 1 && !vals[0])) continue;
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = vals[idx] !== undefined ? vals[idx] : '';
    });
    rows.push(row);
  }
  return rows;
}

// Inspects content/filename to detect source format
function detectFileFormat(filename, text, userSource) {
  if (userSource && userSource !== 'auto') return userSource;
  const lowerName = (filename || '').toLowerCase();
  const lowerText = (text || '').slice(0, 2000).toLowerCase();

  if (lowerText.includes('letterboxd uri') || lowerName.includes('letterboxd') || lowerName.includes('watched.csv') || lowerName.includes('diary.csv')) {
    return 'letterboxd';
  }
  if (lowerText.includes('const') && (lowerText.includes('title type') || lowerText.includes('imdb rating') || lowerText.includes('your rating'))) {
    return 'imdb';
  }
  if (lowerText.includes('trakt_id') || lowerText.includes('trakt.tv') || lowerName.includes('trakt')) {
    return 'trakt';
  }
  if (lowerText.includes('simkl') || lowerName.includes('simkl')) {
    return 'simkl';
  }
  if (lowerText.includes('movieid') && (lowerText.includes('imdbid') || lowerText.includes('tmdbid'))) {
    return 'movielens';
  }
  if (lowerText.includes('tmdb') || lowerText.includes('themoviedb') || lowerName.includes('tmdb')) {
    return 'tmdb';
  }
  return 'generic';
}

// Extracts items from a single file's text content
function extractItemsFromFileContent(filename, text, source) {
  const format = detectFileFormat(filename, text, source);
  const items = [];

  // Try JSON first if text looks like JSON
  if (text.trim().startsWith('[') || text.trim().startsWith('{')) {
    try {
      const json = JSON.parse(text);
      const rawList = Array.isArray(json) ? json : (json.movies || json.shows || json.items || json.results || json.history || json.watchlist || []);
      if (Array.isArray(rawList)) {
        rawList.forEach(entry => {
          if (!entry) return;
          const movie = entry.movie || entry;
          const show = entry.show;
          const ep = entry.episode;
          const title = (show && show.title) || movie.title || movie.name || (entry.title || entry.name || '');
          const year = (movie.year || (movie.release_date && movie.release_date.slice(0, 4)) || (show && show.year) || entry.year || '');
          const ids = entry.ids || movie.ids || show.ids || {};
          const imdbId = ids.imdb || movie.imdb_id || entry.imdb_id || (typeof movie.id === 'string' && movie.id.startsWith('tt') ? movie.id : '');
          const tmdbId = ids.tmdb || movie.tmdb_id || entry.tmdb_id || (typeof movie.id === 'number' ? movie.id : '');
          const type = (show || ep || entry.type === 'show' || entry.type === 'series' || entry.media_type === 'tv') ? 'series' : 'movie';
          const poster = movie.poster_path ? ('https://image.tmdb.org/t/p/w500' + movie.poster_path) : (imdbId ? 'https://images.metahub.space/poster/medium/' + imdbId + '/img' : '');
          if (imdbId || tmdbId || title) {
            items.push({
              id: imdbId || (tmdbId ? 'tmdb:' + tmdbId : title),
              imdbId: imdbId || '',
              tmdbId: tmdbId ? String(tmdbId) : '',
              title: title,
              name: title,
              year: year ? String(year) : '',
              type: type,
              poster: poster,
            });
          }
        });
        return items;
      }
    } catch (e) {}
  }

  // Parse as CSV / Delimited rows
  const rows = parseCsvToRows(text);
  if (!rows.length) {
    // Fallback: search for tt IDs line-by-line
    const cr = String.fromCharCode(13);
    const lf = String.fromCharCode(10);
    const cleanText = text ? text.split(cr).join('') : '';
    const lines = cleanText.split(lf);
    const ttRgx = new RegExp('\\b(tt\\d{7,10})\\b');
    const sepRgx = new RegExp('[,\\t]', 'g');
    lines.forEach(l => {
      const match = l.match(ttRgx);
      if (match) {
        const cleanTitle = l.replace(match[1], '').replace(sepRgx, ' ').trim() || match[1];
        items.push({
          id: match[1],
          imdbId: match[1],
          title: cleanTitle,
          name: cleanTitle,
          year: '',
          type: 'movie',
          poster: 'https://images.metahub.space/poster/medium/' + match[1] + '/img',
        });
      }
    });
    return items;
  }

  const digitRgx = new RegExp('^\\d+$');
  rows.forEach(r => {
    let imdbId = r.const || r.tconst || r.imdbid || r.imdb_id || '';
    if (imdbId && !imdbId.startsWith('tt') && digitRgx.test(imdbId)) {
      imdbId = 'tt' + imdbId.padStart(7, '0');
    }
    const tmdbId = r.tmdbid || r.tmdb_id || r.tmdb || '';
    const title = r.title || r.name || r.originalname || r.movietitle || '';
    const year = r.year || r.releaseyear || (r.releasedate ? r.releasedate.slice(0, 4) : '') || (r.date ? r.date.slice(0, 4) : '') || '';
    const titleType = (r.titletype || r.type || r.mediatype || '').toLowerCase();
    const type = (titleType.includes('tv') || titleType.includes('show') || titleType.includes('series') || titleType.includes('episode')) ? 'series' : 'movie';
    const poster = imdbId ? ('https://images.metahub.space/poster/medium/' + imdbId + '/img') : '';

    if (imdbId || tmdbId || title) {
      items.push({
        id: imdbId || (tmdbId ? 'tmdb:' + tmdbId : title),
        imdbId: imdbId || '',
        tmdbId: tmdbId ? String(tmdbId) : '',
        title: title,
        name: title,
        year: year ? String(year) : '',
        type: type,
        poster: poster,
      });
    }
  });

  return items;
}

async function runUnifiedListImport() {
  const btn = document.getElementById('btnUnifiedImport');
  const resultBox = document.getElementById('unifiedImportResult');
  const globalMarkWatchedCheck = document.getElementById('importAlsoMarkWatchedCheck');
  const globalAlsoMarkWatched = globalMarkWatchedCheck ? globalMarkWatchedCheck.checked : false;

  if (!discoveredImportCategories.length) {
    if (typeof showAppAlert === 'function') showAppAlert('File Required', 'Please select at least one file to import.', false);
    else alert('Please select at least one file to import.');
    return;
  }

  const checkedCatCards = Array.from(document.querySelectorAll('.importCatCheck:checked'));
  if (!checkedCatCards.length) {
    if (typeof showAppAlert === 'function') showAppAlert('Selection Required', 'Please select at least one category/list to import.', false);
    else alert('Please select at least one category/list to import.');
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Importing\u2026';
  }

  const selectedCategories = checkedCatCards.map(chk => {
    const idx = parseInt(chk.dataset.catIndex, 10);
    const cat = discoveredImportCategories[idx];
    const targetSel = document.querySelector('.importCatTargetSelect[data-cat-index="' + idx + '"]');
    const watchChk = document.querySelector('.importCatAlsoMarkWatchedCheck[data-cat-index="' + idx + '"]');
    return {
      cat: cat,
      target: targetSel ? targetSel.value : cat.defaultTarget,
      alsoMarkWatched: (watchChk ? watchChk.checked : false) || globalAlsoMarkWatched
    };
  });

  const createdSummary = [];
  const errors = [];
  let totalWatchedAdded = 0;

  for (const entry of selectedCategories) {
    const cat = entry.cat;
    const targetList = entry.target;
    const alsoMarkWatched = entry.alsoMarkWatched;
    const rawItems = cat.items;

    if (resultBox) {
      resultBox.innerHTML = '<p style="font-size:0.88rem; color:var(--muted);"><small>Processing ' + escapeHtml(cat.label) + ' (' + rawItems.length + ' items)&hellip;</small></p>';
    }

    // Resolve missing IMDb / Poster metadata via TMDB bulk-resolve
    const toResolve = rawItems.filter(it => !it.imdbId && it.title);
    if (toResolve.length > 0) {
      try {
        const resolvedAll = await bulkResolveInChunks(toResolve);
        const resolvedMap = new Map();
        resolvedAll.forEach(r => {
          if (r.title) resolvedMap.set((r.title + '|' + (r.year || '')).toLowerCase(), r);
        });
        rawItems.forEach(it => {
          if (!it.imdbId && it.title) {
            const found = resolvedMap.get((it.title + '|' + it.year).toLowerCase());
            if (found && found.imdbId) {
              it.imdbId = found.imdbId;
              it.id = found.imdbId;
              it.poster = 'https://images.metahub.space/poster/medium/' + found.imdbId + '/img';
            }
          }
        });
      } catch (e) {
        // Same as before: an unresolved title keeps whatever metadata it
        // already had and the import continues.
      }
    }

    const finalItems = rawItems.map(it => ({
      id: it.imdbId || it.id,
      imdbId: it.imdbId || '',
      tmdbId: it.tmdbId || '',
      type: it.type || 'movie',
      name: it.title || it.name,
      title: it.title || it.name,
      poster: it.poster || (it.imdbId ? ('https://images.metahub.space/poster/medium/' + it.imdbId + '/img') : ''),
      year: it.year || ''
    }));

    let savedCount = 0;
    let listDisplayName = '';

    if (targetList === 'watchlist') {
      listDisplayName = 'Watchlist';
      const map = loadLocalCustomLists();
      let wl = map['watchlist'];
      if (!wl) {
        wl = { slug: 'watchlist', localSlug: 'watchlist', name: 'Watchlist', description: 'Your personal Watchlist.', type: 'mixed', items: [], createdAt: Date.now(), updatedAt: Date.now() };
      }
      const existing = new Set((wl.items || []).map(i => String(i.id || i.imdbId)));
      finalItems.forEach(it => {
        const key = String(it.id || it.imdbId);
        if (!existing.has(key)) {
          wl.items.unshift(it);
          existing.add(key);
          savedCount++;
        }
      });
      wl.updatedAt = Date.now();
      map['watchlist'] = wl;
      saveLocalCustomListsMap(map);
    } else if (targetList === 'watch-history') {
      listDisplayName = 'Watch History';
      if (typeof addItemsToWatchHistory === 'function') {
        const whResult = await addItemsToWatchHistory(finalItems, true);
        savedCount = whResult.added;
      }
    } else if (targetList.startsWith('list:')) {
      const slug = targetList.slice(5);
      const map = loadLocalCustomLists();
      const existingList = map[slug];
      if (existingList) {
        listDisplayName = existingList.name || slug;
        existingList.items = Array.isArray(existingList.items) ? existingList.items : [];
        const existing = new Set(existingList.items.map(i => String(i.id || i.imdbId)));
        finalItems.forEach(it => {
          const key = String(it.id || it.imdbId);
          if (!existing.has(key)) {
            existingList.items.unshift(it);
            existing.add(key);
            savedCount++;
          }
        });
        existingList.updatedAt = Date.now();
        map[slug] = existingList;
        saveLocalCustomListsMap(map);
      }
    } else if (targetList.startsWith('new')) {
      let newListName = targetList.startsWith('new:') ? targetList.slice(4).trim() : cat.defaultNewName;
      if (!newListName) newListName = cat.label;
      listDisplayName = newListName;
      const hasMovies = finalItems.some(i => i.type === 'movie');
      const hasShows = finalItems.some(i => i.type === 'series');
      const listType = (hasMovies && !hasShows) ? 'movie' : ((!hasMovies && hasShows) ? 'series' : 'mixed');
      const saveRes = await saveItemsAsNewCustomList(newListName, listType, finalItems, 'public');
      if (saveRes.ok) {
        savedCount = finalItems.length;
      } else {
        errors.push(newListName + ': ' + (saveRes.error || 'Could not save list.'));
      }
    }

    if (alsoMarkWatched && targetList !== 'watch-history' && typeof addItemsToWatchHistory === 'function') {
      const whResult = await addItemsToWatchHistory(finalItems, true);
      totalWatchedAdded += whResult.added;
    }

    if (savedCount > 0) {
      createdSummary.push(listDisplayName + ' (' + savedCount + ' items)');
    }
  }

  if (btn) {
    btn.disabled = false;
    btn.textContent = 'Import';
  }
  if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard();
  if (typeof populateImportTargetLists === 'function') populateImportTargetLists();

  let summaryHtml = '<div style="margin-top:12px;">';
  if (createdSummary.length) {
    summaryHtml += '<p class="testresult ok">\u2713 Successfully imported:<br>' + createdSummary.map(escapeHtml).join('<br>') + '</p>';
  }
  if (totalWatchedAdded) {
    summaryHtml += '<p style="margin-top:6px; font-size:0.85rem; color:#7ce7b6;">\u2713 Marked ' + totalWatchedAdded + ' item(s) as watched in Watch History.</p>';
  }
  if (errors.length) {
    summaryHtml += '<p class="testresult err" style="margin-top:8px;">' + errors.map(escapeHtml).join('<br>') + '</p>';
  }
  if (!createdSummary.length && !errors.length) {
    summaryHtml += '<p style="color:var(--muted); font-size:0.85rem;">No new items were added (items may already exist in the target lists).</p>';
  }
  summaryHtml += '</div>';

  if (resultBox) resultBox.innerHTML = summaryHtml;
}



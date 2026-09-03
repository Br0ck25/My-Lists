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

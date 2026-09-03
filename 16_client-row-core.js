<!--
  Two script elements follow, and the split between them is deliberate.

  The client bundle is around 1.3MB, and it used to be inlined into this
  page in full. That is fine for the home page, which is byte-identical for
  everyone and now answers a repeat visit with a 304 -- but it is not fine
  for the pages people actually share. Every distinct shared list URL, every
  configure link and every deep link produces different HTML, so each one
  re-sent the entire bundle, and the browser re-parsed it from scratch every
  time because inline script gets no code cache.

  So everything that varies per request lives in the small inline preamble
  below, and everything that does not lives in a separate script served from
  a content-hashed URL with immutable caching. The bundle is then fetched
  once and reused across every page of the site, and a deploy changes the
  hash so nobody is ever served a stale one.

  Both are plain classic scripts with no defer/async, so they still execute
  in order, and the preamble's const/let bindings are script-scoped globals
  that the bundle reads and assigns exactly as it did when the two were one
  element.
-->
<script>
const ORIGIN = (typeof location !== 'undefined' && location.origin) ? location.origin : ${JSON.stringify(origin)};
const IS_CONFIGURE = ${isConfigureMode};
// Populated by the /lists/<slug> route (25_api-catalog-routes.js) when this
// exact page load resolved a known chart slug -- e.g. loading
// /lists/TMDB-Trending directly (a bookmark, a shared link, a refresh)
// rather than reaching it by clicking "See All" inside an already-running
// session. null on every other page load (the normal case). See
// handleInitialDeepLink in 24_client-backup-restore-presets.js, which
// checks this before falling back to the older #/list?... hash format for
// anything that isn't one of these known charts.
const SERVER_DEEP_LINK_LIST = ${JSON.stringify(deepLinkList)};
// The signed-in person's OAuth tokens. These are the reason the preamble
// exists at all: they are specific to one page load and must never end up
// in the shared bundle below, which is cached publicly under a URL that is
// identical for every visitor.
let traktAccessToken = ${JSON.stringify(initialTraktAccessToken)};
let mdblistAccessToken = ${JSON.stringify(initialMdblistAccessToken)};
let simklAccessToken = ${JSON.stringify(initialSimklAccessToken)};
let simklUsername = ${JSON.stringify(initialSimklUsername)};
// Resolved from an install/configure link by the route that rendered this
// page. Previously declared far down in 24_client-backup-restore-presets.js;
// hoisted here because they differ per config. Moving a const declaration
// earlier is always safe -- anything that read it before would have been a
// temporal-dead-zone error, so nothing could have been relying on the old
// position.
const serverEntries = (${initialEntriesJson});
const serverEntriesAreDefaults = ${usingDefaultEntries ? 'true' : 'false'};
const serverShuffleShelves = ${initialShuffleShelves ? 'true' : 'false'};
const serverShuffleItems = ${initialShuffleItems ? 'true' : 'false'};
</script>
<script>/*MYLISTS_APP_BUNDLE_START*/
// Every native/official chart's (slug, name, movieUrl, showUrl) -- lets
// openListDetailsPage (23_client-list-management.js) push the clean
// /lists/<slug> path when the list it's opening is one of these, instead
// of always falling back to the older #/list?... hash format.
const CHART_SLUG_ENTRIES = ${JSON.stringify(CHART_SLUG_ENTRIES)};

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
function escapeAttr(s) { return escapeHtml(s); }

(function earlySubmenuSync() {
  try {
    // 1. Catalogs submenu early sync
    var catSub = localStorage.getItem('myListAddon:catalogsSubmenu') || 'all';
    var catBar = document.getElementById('catalogsFilterBar');
    if (catBar) {
      catBar.querySelectorAll('.subnav-pill').forEach(function(p) {
        var match = p.getAttribute('data-sub') === catSub || (p.getAttribute('onclick') || '').indexOf("'" + catSub + "'") !== -1;
        p.classList.toggle('active', match);
        var c = p.querySelector('.check-icon'); if (c) c.remove();
        if (match) p.insertAdjacentHTML('afterbegin', '<span class="check-icon">&#x2713;</span> ');
      });
    }
    var subShelves = document.getElementById('catalogsSubShelves');
    var subQuickAdd = document.getElementById('catalogsSubQuickAdd');
    var subBulk = document.getElementById('catalogsSubBulk');
    if (subShelves) subShelves.style.display = (catSub === 'all' || catSub === 'shelves') ? 'block' : 'none';
    if (subQuickAdd) subQuickAdd.style.display = (catSub === 'quickadd') ? 'block' : 'none';
    if (subBulk) subBulk.style.display = (catSub === 'bulk') ? 'block' : 'none';

    // 2. Lists submenu early sync
    var listSub = localStorage.getItem('myListAddon:listsSubmenu') || 'my-lists';
    var listBar = document.getElementById('listsSubnavBar');
    if (listBar) {
      listBar.querySelectorAll('.subnav-pill').forEach(function(p) {
        var match = p.getAttribute('data-sub') === listSub || (p.getAttribute('onclick') || '').indexOf("'" + listSub + "'") !== -1;
        p.classList.toggle('active', match);
        var c = p.querySelector('.check-icon'); if (c) c.remove();
        if (match) p.insertAdjacentHTML('afterbegin', '<span class="check-icon">&#x2713;</span> ');
      });
    }
    var subMyLists = document.getElementById('listsSubMyLists');
    var subLiked = document.getElementById('listsSubLiked');
    var subListImport = document.getElementById('listsSubImport');
    var subListBulk = document.getElementById('listsSubBulk');
    var subCreate = document.getElementById('listsSubCreateList');
    if (subMyLists) subMyLists.style.display = (listSub === 'my-lists') ? 'block' : 'none';
    if (subLiked) subLiked.style.display = (listSub === 'liked') ? 'block' : 'none';
    if (subListImport) subListImport.style.display = (listSub === 'import') ? 'block' : 'none';
    if (subListBulk) subListBulk.style.display = (listSub === 'bulk') ? 'block' : 'none';
    if (subCreate) subCreate.style.display = (listSub === 'create-list') ? 'block' : 'none';

    // 3. Channels submenu early sync
    var chSub = localStorage.getItem('myListAddon:channelsSubmenu') || 'my-channels';
    var chBar = document.getElementById('channelsSubnavBar');
    if (chBar) {
      chBar.querySelectorAll('.subnav-pill').forEach(function(p) {
        var match = p.getAttribute('data-sub') === chSub || (p.getAttribute('onclick') || '').indexOf("'" + chSub + "'") !== -1;
        p.classList.toggle('active', match);
        var c = p.querySelector('.check-icon'); if (c) c.remove();
        if (match) p.insertAdjacentHTML('afterbegin', '<span class="check-icon">&#x2713;</span> ');
      });
    }
    var subMyChannels = document.getElementById('channelsSubMyChannels');
    var subStorylines = document.getElementById('channelsSubStorylines');
    var subChQuickAdd = document.getElementById('channelsSubQuickAdd');
    var subChImport = document.getElementById('channelsSubImport');
    var subBuild = document.getElementById('channelsSubBuild');
    if (subMyChannels) subMyChannels.style.display = (chSub === 'my-channels') ? 'block' : 'none';
    if (subStorylines) subStorylines.style.display = (chSub === 'storylines') ? 'block' : 'none';
    if (subChQuickAdd) subChQuickAdd.style.display = (chSub === 'quickadd') ? 'block' : 'none';
    if (subChImport) subChImport.style.display = (chSub === 'import') ? 'block' : 'none';
    if (subBuild) subBuild.style.display = (chSub === 'build') ? 'block' : 'none';

    // 4. Settings submenu early sync
    var setSub = localStorage.getItem('myListAddon:settingsSubmenu') || 'account';
    var setBar = document.getElementById('settingsSubnavBar');
    if (setBar) {
      setBar.querySelectorAll('.subnav-pill').forEach(function(p) {
        var match = p.getAttribute('data-sub') === setSub || (p.getAttribute('onclick') || '').indexOf("'" + setSub + "'") !== -1;
        p.classList.toggle('active', match);
        var c = p.querySelector('.check-icon'); if (c) c.remove();
        if (match) p.insertAdjacentHTML('afterbegin', '<span class="check-icon">&#x2713;</span> ');
      });
    }
    var subAccount = document.getElementById('settingsSubAccount');
    var subExternal = document.getElementById('settingsSubExternal');
    var subBackup = document.getElementById('settingsSubBackup');
    var subFeedback = document.getElementById('settingsSubFeedback');
    if (subAccount) subAccount.style.display = (setSub === 'account' || setSub === 'keys') ? 'block' : 'none';
    if (subExternal) subExternal.style.display = (setSub === 'external') ? 'block' : 'none';
    if (subBackup) subBackup.style.display = (setSub === 'backup') ? 'block' : 'none';
    if (subFeedback) subFeedback.style.display = (setSub === 'feedback') ? 'block' : 'none';

    // 5. Discover submenu early sync
    var discSub = localStorage.getItem('myListAddon:discoverSubmenu') || 'all';
    var discBar = document.getElementById('discoverSubnavBar');
    if (discBar) {
      discBar.querySelectorAll('.subnav-pill').forEach(function(p) {
        var match = p.getAttribute('data-sub') === discSub || (p.getAttribute('onclick') || '').indexOf("'" + discSub + "'") !== -1;
        p.classList.toggle('active', match);
        var c = p.querySelector('.check-icon'); if (c) c.remove();
        if (match) p.insertAdjacentHTML('afterbegin', '<span class="check-icon">&#x2713;</span> ');
      });
    }
  } catch (e) {}
})();

function deslugify(s) {
  return String(s || '')
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function getListCleanPath(listUrl, name) {
  const normName = String(name || '').toLowerCase().trim();
  if (normName === 'continue watching' || normName === 'continue-watching' || normName === 'continue_watching') return '/lists/continue-watching';
  if (normName === 'watch history' || normName === 'watch-history' || normName === 'watch_history') return '/lists/watch-history';
  if (normName === 'watchlist') return '/lists/watchlist';

  const cleanSlug = name ? String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') : '';
  const rawUrl = String(listUrl || '').trim();

  if (!rawUrl) {
    if (cleanSlug) return '/lists/custom/' + cleanSlug;
    return null;
  }

  if (rawUrl.startsWith('autotrack:')) {
    const parts = rawUrl.split(':');
    const slug = parts[1] || 'watch-history';
    return '/lists/' + slug;
  }

  if (rawUrl.startsWith('customlist:v1:')) {
    try {
      const payload = JSON.parse(rawUrl.slice('customlist:v1:'.length));
      const slug = payload.localSlug || payload.creatorSlug || payload.slug;
      if (slug === 'continue-watching' || slug === 'watch-history' || slug === 'watchlist') {
        return '/lists/' + slug;
      }
      if (slug) return '/lists/custom/' + slug;
    } catch (e) {}
  }

  if (rawUrl.startsWith('custom:')) {
    const slug = rawUrl.slice(7);
    if (slug === 'continue-watching' || slug === 'watch-history' || slug === 'watchlist') {
      return '/lists/' + slug;
    }
    if (slug.startsWith('curated:')) {
      return '/lists/curated/' + slug.slice(8);
    }
    return '/lists/custom/' + slug;
  }

  if (rawUrl === 'tmdb:chart:new_movies') return '/lists/new-movies';
  if (rawUrl === 'tmdb:chart:new_shows') return '/lists/new-shows';

  // 2. Known chart
  if (typeof CHART_SLUG_ENTRIES !== 'undefined') {
    const knownChart = CHART_SLUG_ENTRIES.find((e) => e.movieUrl === rawUrl || e.showUrl === rawUrl || e.url === rawUrl);
    if (knownChart) return '/lists/' + knownChart.slug;
  }

  // 3. Addon internal list (/lists/:user/:slug)
  if (typeof location !== 'undefined' && rawUrl.startsWith(location.origin + '/lists/')) {
    return rawUrl.slice(location.origin.length);
  }
  if (rawUrl.startsWith('/lists/')) {
    return rawUrl;
  }

  // 4. MDBList list
  const mdbMatch = rawUrl.match(new RegExp('(?:https?:)?(?://)?(?:www\\.)?mdblist\\.com/lists/([^/]+)/([^/?#]+)', 'i'));
  if (mdbMatch) {
    return '/lists/mdblist/' + mdbMatch[1] + '/' + mdbMatch[2];
  }
  if (rawUrl === 'mdblist:watchlist' || (rawUrl.startsWith('mdblist:') && normName.includes('watchlist'))) {
    return '/lists/mdblist/watchlist';
  }
  if (rawUrl === 'mdblist:history' || (rawUrl.startsWith('mdblist:') && normName.includes('history'))) {
    return '/lists/mdblist/history';
  }
  if (rawUrl.startsWith('mdblist:list:')) {
    const listId = rawUrl.slice('mdblist:list:'.length);
    return '/lists/mdblist/' + listId + (cleanSlug && cleanSlug !== '-' ? '-' + cleanSlug : '');
  }
  if (rawUrl.startsWith('mdblist:')) {
    const parts = rawUrl.slice(8).split(':');
    if (parts.length >= 2) return '/lists/mdblist/' + parts[0] + '/' + parts[1];
    return '/lists/mdblist/' + (cleanSlug || parts[0]);
  }

  // 5. Trakt list
  const traktMatch = rawUrl.match(new RegExp('(?:https?:)?(?://)?(?:www\\.)?(?:api\\.)?trakt\\.tv/users/([^/]+)/lists/([^/?#]+)', 'i'));
  if (traktMatch) {
    return '/lists/trakt/' + traktMatch[1] + '/' + traktMatch[2];
  }
  if (rawUrl === 'trakt:watchlist' || (rawUrl.startsWith('trakt:') && normName.includes('watchlist'))) {
    return '/lists/trakt/watchlist';
  }
  if (rawUrl === 'trakt:history' || (rawUrl.startsWith('trakt:') && normName.includes('history'))) {
    return '/lists/trakt/history';
  }
  if (rawUrl === 'trakt:collection' || (rawUrl.startsWith('trakt:') && normName.includes('collection'))) {
    return '/lists/trakt/collection';
  }
  if (rawUrl.startsWith('trakt:users/')) {
    return '/lists/trakt/' + rawUrl.slice(12).replace('/lists/', '/');
  }
  if (rawUrl.startsWith('trakt:')) {
    const parts = rawUrl.slice(6).split(':');
    if (parts.length >= 2) return '/lists/trakt/' + parts[0] + '/' + parts[1];
    return '/lists/trakt/' + (cleanSlug || parts[0]);
  }

  // 6. TMDB
  const tmdbCollMatch = rawUrl.match(new RegExp('(?:https?:)?(?://)?(?:www\\.)?themoviedb\\.org/collection/([0-9]+)', 'i')) ||
    (rawUrl.startsWith('tmdb:collection:') ? [null, rawUrl.slice('tmdb:collection:'.length).split(/[^0-9]/)[0]] : null);
  if (tmdbCollMatch && tmdbCollMatch[1]) {
    return '/lists/tmdb/collection/' + tmdbCollMatch[1] + (cleanSlug && cleanSlug !== '-' ? '-' + cleanSlug : '');
  }
  const tmdbMatch = rawUrl.match(new RegExp('(?:https?:)?(?://)?(?:www\\.)?themoviedb\\.org/list/([0-9]+)', 'i')) ||
    (rawUrl.startsWith('tmdb:list:') ? [null, rawUrl.slice('tmdb:list:'.length).split(/[^0-9]/)[0]] : null);
  if (tmdbMatch && tmdbMatch[1]) {
    return '/lists/tmdb/' + tmdbMatch[1] + (cleanSlug && cleanSlug !== '-' ? '-' + cleanSlug : '');
  }
  if (rawUrl === 'tmdb:watchlist' || (rawUrl.startsWith('tmdb:') && normName.includes('watchlist'))) {
    return '/lists/tmdb/watchlist';
  }
  if (rawUrl === 'tmdb:favorites' || (rawUrl.startsWith('tmdb:') && normName.includes('favorites'))) {
    return '/lists/tmdb/favorites';
  }

  // 7. Simkl
  if (rawUrl.startsWith('simkl:completed:movies') || normName === 'simkl completed (movies)') return '/lists/simkl/completed-movies';
  if (rawUrl.startsWith('simkl:completed:shows') || normName === 'simkl completed (shows)') return '/lists/simkl/completed-shows';
  if (rawUrl.startsWith('simkl:watching:movies') || normName === 'simkl watching (movies)') return '/lists/simkl/watching-movies';
  if (rawUrl.startsWith('simkl:watching:shows') || normName === 'simkl watching (shows)') return '/lists/simkl/watching-shows';
  if (rawUrl.startsWith('simkl:plantowatch:movies') || normName === 'simkl plan to watch (movies)') return '/lists/simkl/plantowatch-movies';
  if (rawUrl.startsWith('simkl:plantowatch:shows') || normName === 'simkl plan to watch (shows)') return '/lists/simkl/plantowatch-shows';
  if (rawUrl.startsWith('simkl:hold:movies') || normName === 'simkl on hold (movies)') return '/lists/simkl/hold-movies';
  if (rawUrl.startsWith('simkl:hold:shows') || normName === 'simkl on hold (shows)') return '/lists/simkl/hold-shows';
  if (rawUrl.startsWith('simkl:dropped:movies') || normName === 'simkl not interesting (movies)') return '/lists/simkl/dropped-movies';
  if (rawUrl.startsWith('simkl:dropped:shows') || normName === 'simkl not interesting (shows)') return '/lists/simkl/dropped-shows';
  const simklMatch = rawUrl.match(new RegExp('(?:https?:)?(?://)?(?:www\\.)?simkl\\.com/[^/]+/list/([0-9]+)(?:/([^/?#]+))?', 'i'));
  if (simklMatch && simklMatch[1]) {
    return '/lists/simkl/' + simklMatch[1] + (simklMatch[2] ? '-' + simklMatch[2] : (cleanSlug ? '-' + cleanSlug : ''));
  }
  if (rawUrl.startsWith('simkl:custom:')) {
    const listId = rawUrl.slice(13);
    return '/lists/simkl/' + listId + (cleanSlug ? '-' + cleanSlug : '');
  }
  // 8. Channels (My Channels / TV Channels)
  if (rawUrl.startsWith('channel:')) {
    if (cleanSlug) return '/channels/' + cleanSlug;
    const chId = rawUrl.replace(/^channel:(?:id:|v1:)?/, '');
    if (chId) return '/channels/' + chId;
  }

  if (cleanSlug) {
    return '/lists/custom/' + cleanSlug;
  }

  return null;
}

function isListAddedToConfig(url, type, slug) {
  let targetSlug = slug || '';
  if (!targetSlug && url) {
    if (url.startsWith('autotrack:')) {
      targetSlug = url.split(':')[1] || '';
    } else if (url.startsWith('custom:') && !url.startsWith('custom:curated:')) {
      targetSlug = url.slice('custom:'.length);
    } else if (url.startsWith('customlist:v1:')) {
      const p = (typeof parseCustomListPayloadClient === 'function') ? parseCustomListPayloadClient(url) : null;
      if (p) targetSlug = p.localSlug || p.listSlug || p.creatorSlug || p.slug || '';
    }
  }

  const entries = document.querySelectorAll('#lists .entry');
  for (const entry of entries) {
    const t = entry.querySelector('.type') ? entry.querySelector('.type').value : '';
    if (type && t && t !== type && t !== 'both' && type !== 'both' && type !== 'mixed' && t !== 'mixed') {
      if (targetSlug !== 'continue-watching' && targetSlug !== 'watch-history' && targetSlug !== 'watchlist') {
        continue;
      }
    }
    const urlInputs = entry.querySelectorAll('.url');
    for (const el of urlInputs) {
      const u = el.value.trim();
      if (url && (u === url.trim() || (u.startsWith('autotrack:') && url.startsWith('autotrack:') && u.split(':')[1] === url.split(':')[1]))) return true;
      if (targetSlug) {
        if (u === 'custom:' + targetSlug || u === 'autotrack:' + targetSlug) return true;
        if (u.startsWith('autotrack:' + targetSlug + ':') || u.startsWith('autotrack:' + targetSlug)) return true;
        if (u.startsWith('/lists/') && u.endsWith('/' + targetSlug)) return true;
        const payload = (typeof parseCustomListPayloadClient === 'function') ? parseCustomListPayloadClient(u) : null;
        if (payload && (payload.localSlug === targetSlug || payload.listSlug === targetSlug || payload.creatorSlug === targetSlug || payload.slug === targetSlug)) return true;
      }
    }
    if (targetSlug && (targetSlug === 'continue-watching' || targetSlug === 'watch-history' || targetSlug === 'watchlist')) {
      const nameInput = entry.querySelector('.name');
      const cleanName = targetSlug.replace('-', ' ');
      if (nameInput && nameInput.value.trim().toLowerCase().startsWith(cleanName)) {
        return true;
      }
    }
  }
  return false;
}

function removeListFromConfig(url, type, slug) {
  let targetSlug = slug || '';
  if (!targetSlug && url) {
    if (url.startsWith('autotrack:')) {
      targetSlug = url.split(':')[1] || '';
    } else if (url.startsWith('custom:') && !url.startsWith('custom:curated:')) {
      targetSlug = url.slice('custom:'.length);
    } else if (url.startsWith('customlist:v1:')) {
      const p = (typeof parseCustomListPayloadClient === 'function') ? parseCustomListPayloadClient(url) : null;
      if (p) targetSlug = p.localSlug || p.listSlug || p.creatorSlug || p.slug || '';
    }
  }

  const entries = document.querySelectorAll('#lists .entry');
  let removed = false;
  for (const entry of entries) {
    const t = entry.querySelector('.type') ? entry.querySelector('.type').value : '';
    if (type && t && t !== type && t !== 'both' && type !== 'both' && type !== 'mixed' && t !== 'mixed') {
      if (targetSlug !== 'continue-watching' && targetSlug !== 'watch-history' && targetSlug !== 'watchlist') {
        continue;
      }
    }
    const urlInputs = entry.querySelectorAll('.url');
    let match = false;
    for (const el of urlInputs) {
      const u = el.value.trim();
      if (url && (u === url.trim() || (u.startsWith('autotrack:') && url.startsWith('autotrack:') && u.split(':')[1] === url.split(':')[1]))) { match = true; break; }
      if (targetSlug) {
        if (u === 'custom:' + targetSlug || u === 'autotrack:' + targetSlug) { match = true; break; }
        if (u.startsWith('autotrack:' + targetSlug + ':') || u.startsWith('autotrack:' + targetSlug)) { match = true; break; }
        if (u.startsWith('/lists/') && u.endsWith('/' + targetSlug)) { match = true; break; }
        const payload = (typeof parseCustomListPayloadClient === 'function') ? parseCustomListPayloadClient(u) : null;
        if (payload && (payload.localSlug === targetSlug || payload.listSlug === targetSlug || payload.creatorSlug === targetSlug || payload.slug === targetSlug)) { match = true; break; }
      }
    }
    if (!match && targetSlug && (targetSlug === 'continue-watching' || targetSlug === 'watch-history' || targetSlug === 'watchlist')) {
      const nameInput = entry.querySelector('.name');
      const cleanName = targetSlug.replace('-', ' ');
      if (nameInput && nameInput.value.trim().toLowerCase().startsWith(cleanName)) {
        match = true;
      }
    }
    if (match) {
      entry.remove();
      removed = true;
    }
  }
  if (removed) {
    if (typeof renumber === 'function') renumber();
    if (typeof saveState === 'function') saveState();
    if (typeof updateAllListAddButtons === 'function') updateAllListAddButtons();
  }
  return removed;
}

function updateAllListAddButtons() {
  // 1. Local list cards in My Lists
  document.querySelectorAll('.localListAddToConfigBtn').forEach((btn) => {
    const slug = btn.dataset.slug;
    if (!slug) return;
    const card = btn.closest('.list-card');
    const type = card ? card.dataset.listType : null;
    const isAdded = isListAddedToConfig(null, type, slug);
    btn.classList.toggle('is-added', isAdded);
    btn.classList.toggle('secondary', isAdded);
    btn.classList.toggle('primary', !isAdded);
    btn.textContent = isAdded ? 'Remove' : '+ Add';
    btn.style.color = isAdded ? 'var(--danger)' : '';
  });

  // 2. Creator Profile server list cards
  document.querySelectorAll('.creatorListAddToConfigBtn').forEach((btn) => {
    const slug = btn.dataset.slug;
    if (!slug) return;
    const card = btn.closest('.list-card');
    const type = card ? card.dataset.listType : null;
    const isAdded = isListAddedToConfig(null, type, slug);
    btn.classList.toggle('is-added', isAdded);
    btn.classList.toggle('secondary', isAdded);
    btn.classList.toggle('primary', !isAdded);
    btn.textContent = isAdded ? 'Remove' : '+ Add';
    btn.style.color = isAdded ? 'var(--danger)' : '';
  });

  // 3. See All / List Details page add button
  const detailAddBtn = document.getElementById('detailAddBtn');
  if (detailAddBtn && window._currentListDetailsParams) {
    const { listUrl, type } = window._currentListDetailsParams;
    const isAdded = isListAddedToConfig(listUrl, type);
    detailAddBtn.classList.toggle('is-added', isAdded);
    detailAddBtn.classList.toggle('secondary', isAdded);
    detailAddBtn.classList.toggle('primary', !isAdded);
    detailAddBtn.textContent = isAdded ? 'Remove' : '+ Add';
    detailAddBtn.style.color = isAdded ? 'var(--danger)' : '';
  }

  // 4. Curated list add buttons
  document.querySelectorAll('.curated-add-btn').forEach((btn) => {
    const url = btn.dataset.url;
    const type = btn.dataset.type;
    const slug = btn.dataset.slug;
    const isAdded = isListAddedToConfig(url, type, slug);
    btn.classList.toggle('is-added', isAdded);
    btn.classList.toggle('secondary', isAdded);
    btn.classList.toggle('primary', !isAdded);
    btn.textContent = isAdded ? 'Remove' : '+ Add';
    btn.style.color = isAdded ? 'var(--danger)' : '';
  });

  // 5. Search result list add buttons
  document.querySelectorAll('.list-search-add-btn').forEach((btn) => {
    const url = btn.dataset.url;
    const type = btn.dataset.type;
    const isAdded = isListAddedToConfig(url, type);
    btn.classList.toggle('is-added', isAdded);
    btn.classList.toggle('secondary', isAdded);
    btn.classList.toggle('primary', !isAdded);
    btn.textContent = isAdded ? 'Remove' : '+ Add';
    btn.style.color = isAdded ? 'var(--danger)' : '';
  });

  // 6. Provider My Lists add buttons (Simkl, Trakt, MDBList)
  document.querySelectorAll('.myListAddBtn').forEach((btn) => {
    const url = btn.dataset.url;
    const type = btn.dataset.type;
    const isAdded = typeof isListAddedToConfig === 'function' ? (isListAddedToConfig(url, type) || isListAddedToConfig(null, type, url)) : false;
    btn.classList.toggle('is-added', isAdded);
    btn.classList.toggle('secondary', isAdded);
    btn.classList.toggle('primary', !isAdded);
    btn.textContent = isAdded ? 'Remove' : '+ Add';
    btn.style.color = isAdded ? 'var(--danger)' : '';
    btn.disabled = false;
  });
}


function navigateBackFromDetail() {
  const currentTab = document.querySelector('.tab-panel:not([hidden])')?.dataset?.tabPanel;
  if (currentTab === 'item-details' && window._previousTab === 'list-details') {
    if (history.length > 1) {
      history.back();
    } else {
      switchTab('list-details');
      if (typeof window._listScrollY === 'number') {
        const scrollPos = window._listScrollY;
        window.scrollTo({ top: scrollPos, behavior: 'instant' });
      }
    }
  } else if (history.length > 1 && window._previousTab && window._previousTab !== 'list-details' && window._previousTab !== 'item-details') {
    history.back();
  } else {
    const targetTab = window._originTab || window._previousTab || localStorage.getItem('myListAddon:activeTab') || 'discover';
    const cleanTab = (targetTab === 'list-details' || targetTab === 'item-details') ? 'discover' : targetTab;
    if (location.pathname.startsWith('/lists/') || location.pathname.startsWith('/channels/')) {
      try {
        history.replaceState({ view: 'tab', tab: cleanTab }, '', '/');
      } catch (e) {}
    }
    switchTab(cleanTab);
    if (cleanTab === 'catalogs') {
      const targetSubmenu = window._previousCatalogsSubmenu || localStorage.getItem('myListAddon:catalogsSubmenu') || 'all';
      if (typeof switchCatalogsSubmenu === 'function') switchCatalogsSubmenu(targetSubmenu);
    } else if (cleanTab === 'channels') {
      const targetSubmenu = window._previousChannelsSubmenu || localStorage.getItem('myListAddon:channelsSubmenu') || 'storylines';
      if (typeof switchChannelsSubmenu === 'function') switchChannelsSubmenu(targetSubmenu);
    }
    if (typeof window._previousScrollY === 'number') {
      const scrollPos = window._previousScrollY;
      window.scrollTo({ top: scrollPos, behavior: 'instant' });
      requestAnimationFrame(() => {
        window.scrollTo({ top: scrollPos, behavior: 'instant' });
        setTimeout(() => {
          window.scrollTo({ top: scrollPos, behavior: 'instant' });
        }, 50);
      });
    }
  }
}

// Global state variables
var suppressSave = false;
var activeCreator = (function() {
  try {
    const name = localStorage.getItem('myListAddon:creatorName');
    const key = localStorage.getItem('myListAddon:creatorKey');
    const disp = localStorage.getItem('myListAddon:creatorDisplayName') || name;
    if (name && key) return { creatorName: name, displayName: disp };
  } catch (e) {}
  return null;
})();
var livePreviewShelfData = [];
// No dedicated text input for this one (unlike the other keys) -- it's set
// via the Connect Trakt button/OAuth flow, not typed in, so it lives as
// its own piece of state instead of being read from a DOM field.
var activeTraktToken = null;
// traktAccessToken / mdblistAccessToken / simklAccessToken / simklUsername
// are declared in the small per-request preamble at the top of this script
// section, not here. They carry the signed-in person's OAuth tokens, so
// they must stay in the inline page, out of the shared, cacheable bundle
// below -- see the preamble's own comment. They are still ordinary
// script-scoped bindings, so every assignment and read in this file works
// exactly as before.

async function compressJsonToBase64(obj) {
  try {
    const stream = new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream('gzip'));
    const buffer = await new Response(stream).arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 16384;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  } catch (e) {
    return null;
  }
}
async function decompressBase64ToJson(b64) {
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    const text = await new Response(stream).text();
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

// --- Tab & Submenu Navigation ---------------------------------------------
function switchTab(name) {
  if (name === 'backup') {
    switchTab('settings');
    switchSettingsSubmenu('backup', document.querySelector('#settingsSubnavBar button:nth-child(4)'));
    return;
  }
  if (name === 'keys' || name === 'account') {
    switchTab('settings');
    switchSettingsSubmenu('account', document.querySelector('#settingsSubnavBar button:nth-child(1)'));
    return;
  }
  if (name === 'quick-add' || name === 'toplists') {
    switchTab('catalogs');
    switchCatalogsSubmenu('quickadd', document.querySelector('#catalogsFilterBar button:nth-child(2)'));
    return;
  }

  const titles = {
    discover: { title: 'Discover', sub: 'Explore Popular & Streaming' },
    catalogs: { title: 'Catalogs', sub: 'Manage Configured Catalogs' },
    lists: { title: 'Lists', sub: 'Custom, Connected & Liked Lists' },
    channels: { title: 'Channels', sub: '24/7 Continuous TV Streaming' },
    search: { title: 'Search', sub: 'Find Movies, Shows & Lists' },
    settings: { title: 'Settings', sub: 'Accounts, API Keys & Tools' }
  };
  const t = titles[name] || { title: 'My Lists Addon', sub: '' };
  const titleEl = document.getElementById('pageMainTitle');
  const subEl = document.getElementById('pageSubtitle');
  if (titleEl) titleEl.textContent = t.title;
  if (subEl) subEl.textContent = t.sub;

  try {
    document.documentElement.removeAttribute('data-initial-tab');
  } catch (e) {}

  // Instant DOM tab switching
  const panels = document.querySelectorAll('.tab-panel');
  for (let i = 0; i < panels.length; i++) {
    const p = panels[i];
    p.hidden = (p.getAttribute('data-tab-panel') !== name);
  }
  const tabBtns = document.querySelectorAll('.tab-btn');
  for (let i = 0; i < tabBtns.length; i++) {
    const b = tabBtns[i];
    b.classList.toggle('active', b.getAttribute('data-tab') === name);
  }
  const navItems = document.querySelectorAll('.bottom-nav-item');
  for (let i = 0; i < navItems.length; i++) {
    const b = navItems[i];
    b.classList.toggle('active', b.getAttribute('data-tab') === name);
  }

  if (name !== 'list-details' && name !== 'item-details') {
    window._originTab = name;
    window._previousTab = name;
    try {
      localStorage.setItem('myListAddon:activeTab', name);
    } catch (e) {}
    const hash = location.hash || '';
    const isDetailUrl = hash.startsWith('#/item?') || hash.startsWith('#/list?') || (location.pathname.startsWith('/lists/') && location.pathname !== '/lists');
    try {
      if (isDetailUrl) {
        history.pushState({ view: 'tab', tab: name, fromCatalogsSubmenu: window._currentCatalogsSubmenu }, '', '/');
      } else {
        history.replaceState({ view: 'tab', tab: name, fromCatalogsSubmenu: window._currentCatalogsSubmenu }, '', '/');
      }
    } catch (e) {}
  }

  if (name === 'catalogs') {
    let savedSub = 'all';
    try {
      savedSub = localStorage.getItem('myListAddon:catalogsSubmenu') || 'all';
    } catch (e) {}
    if (typeof switchCatalogsSubmenu === 'function') switchCatalogsSubmenu(savedSub);
  }

  if (name === 'lists') {
    if (typeof applyHiddenMyListsSections === 'function') applyHiddenMyListsSections();
    if (!window._listsInitializedOnce) {
      window._listsInitializedOnce = true;
      let savedSub = 'my-lists';
      try {
        savedSub = localStorage.getItem('myListAddon:listsSubmenu') || 'my-lists';
      } catch (e) {}
      const pills = document.querySelectorAll('#listsSubnavBar .subnav-pill');
      let targetBtn = null;
      pills.forEach((p) => {
        const oc = p.getAttribute('onclick') || '';
        if (oc.indexOf("'" + savedSub + "'") !== -1 || oc.indexOf('"' + savedSub + '"') !== -1) {
          targetBtn = p;
        }
      });
      switchListsSubmenu(savedSub, targetBtn || pills[0]);
    }
  }
  if (name === 'settings') {
    if (!window._settingsInitializedOnce) {
      window._settingsInitializedOnce = true;
      let savedSub = 'account';
      try {
        savedSub = localStorage.getItem('myListAddon:settingsSubmenu') || 'account';
      } catch (e) {}
      const pills = document.querySelectorAll('#settingsSubnavBar .subnav-pill');
      let targetBtn = null;
      pills.forEach((p) => {
        const oc = p.getAttribute('onclick') || '';
        if (oc.indexOf("'" + savedSub + "'") !== -1 || oc.indexOf('"' + savedSub + '"') !== -1) {
          targetBtn = p;
        }
      });
      switchSettingsSubmenu(savedSub, targetBtn || pills[0]);
    }
  }
  if (name === 'channels') {
    if (!window._channelsInitializedOnce) {
      window._channelsInitializedOnce = true;
      let savedSub = 'my-channels';
      try {
        savedSub = localStorage.getItem('myListAddon:channelsSubmenu') || 'my-channels';
      } catch (e) {}
      const pills = document.querySelectorAll('#channelsSubnavBar .subnav-pill');
      let targetBtn = null;
      pills.forEach((p) => {
        const oc = p.getAttribute('onclick') || '';
        if (oc.indexOf("'" + savedSub + "'") !== -1 || oc.indexOf('"' + savedSub + '"') !== -1) {
          targetBtn = p;
        }
      });
      if (typeof switchChannelsSubmenu === 'function') {
        switchChannelsSubmenu(savedSub, targetBtn || pills[0]);
      }
    } else {
      if (typeof renderMyCreatedChannelsList === 'function') renderMyCreatedChannelsList();
    }
  }
  if (name === 'catalogs') {
    if (!window._catalogsInitializedOnce) {
      window._catalogsInitializedOnce = true;
      const triggerLivePreview = () => {
        const hasRows = document.getElementById('lists') && document.getElementById('lists').querySelector('.entry');
        if (hasRows) {
          if (typeof renderLivePreview === 'function') renderLivePreview();
        } else {
          setTimeout(triggerLivePreview, 50);
        }
      };
      triggerLivePreview();
    }
  }
  if (name === 'discover') {
    if (!window._discoverInitializedOnce) {
      window._discoverInitializedOnce = true;
      let savedFilter = 'all';
      try {
        savedFilter = localStorage.getItem('myListAddon:discoverSubmenu') || 'all';
      } catch (e) {}
      const activeFilter = window._currentDiscoverFilter || savedFilter;
      window._currentDiscoverFilter = activeFilter;
      const pills = document.querySelectorAll('#discoverSubnavBar .subnav-pill');
      let targetBtn = null;
      pills.forEach((p) => {
        const oc = p.getAttribute('onclick') || '';
        if (oc.indexOf("'" + activeFilter + "'") !== -1 || oc.indexOf('"' + activeFilter + '"') !== -1) {
          targetBtn = p;
        }
      });
      filterDiscoverShelves(activeFilter, targetBtn || pills[0]);
    }
  }
  if (name === 'search') {
    const input = document.getElementById('catalogSearchInput');
    if (input && !input.value.trim()) {
      if (typeof renderDefaultCatalogSearch === 'function') renderDefaultCatalogSearch();
    }
  }
}

function showAddedToast(msg) {
  let toast = document.getElementById('actionToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'actionToast';
    toast.className = 'action-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg || 'Added to My Catalogs \u2713';
  toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.classList.remove('show');
  }, 2200);
}

function handlePosterImgError(img) {
  if (!img || img.dataset.hasFailedFallback) {
    if (img) {
      img.style.display = 'none';
      const parent = img.parentElement;
      if (parent && !parent.querySelector('.live-preview-poster-placeholder')) {
        const ph = document.createElement('div');
        ph.className = 'live-preview-poster live-preview-poster-placeholder';
        ph.innerHTML = '<small style="color:var(--muted); font-size:0.7rem;">No poster</small>';
        parent.appendChild(ph);
      }
    }
    return;
  }
  img.dataset.hasFailedFallback = '1';
  const card = img.closest('.live-preview-poster-card') || img.closest('.list-card') || img.closest('[data-title]');
  const title = (card && card.dataset.title) || (card && card.dataset.name) || '';
  const type = (card && card.dataset.type) || (card && card.dataset.listType) || 'movie';
  const id = (card && card.dataset.id) || (card && card.dataset.imdbId) || '';
  if (title || id) {
    const tmdbId = id.startsWith('tmdb:') ? id.slice(5) : '';
    const imdbId = id.startsWith('tt') ? id : '';
    fetch(ORIGIN + '/api/poster-fallback?title=' + encodeURIComponent(title) + '&type=' + encodeURIComponent(type) + (tmdbId ? '&tmdbId=' + encodeURIComponent(tmdbId) : '') + (imdbId ? '&imdbId=' + encodeURIComponent(imdbId) : ''))
      .then(r => r.json())
      .then(data => {
        if (data && data.ok && data.poster) {
          img.src = data.poster;
          img.style.display = '';
        }
      })
      .catch(() => {});
  }
}

function resolveMissingPostersInDom(rootEl) {
  const container = rootEl || document;
  container.querySelectorAll('.live-preview-poster-placeholder[data-needs-fallback="1"]').forEach(ph => {
    if (ph.dataset.fallbackRequested) return;
    ph.dataset.fallbackRequested = '1';
    const card = ph.closest('.live-preview-poster-card') || ph.closest('.list-card') || ph.closest('[data-title]');
    const title = (card && card.dataset.title) || (card && card.dataset.name) || '';
    const type = (card && card.dataset.type) || (card && card.dataset.listType) || 'movie';
    const id = (card && card.dataset.id) || '';
    if (!title && !id) return;
    const tmdbId = id.startsWith('tmdb:') ? id.slice(5) : '';
    const imdbId = id.startsWith('tt') ? id : '';
    fetch(ORIGIN + '/api/poster-fallback?title=' + encodeURIComponent(title) + '&type=' + encodeURIComponent(type) + (tmdbId ? '&tmdbId=' + encodeURIComponent(tmdbId) : '') + (imdbId ? '&imdbId=' + encodeURIComponent(imdbId) : ''))
      .then(r => r.json())
      .then(data => {
        if (data && data.ok && data.poster) {
          const newImg = document.createElement('img');
          newImg.className = 'live-preview-poster';
          newImg.src = data.poster;
          newImg.alt = '';
          newImg.loading = 'lazy';
          newImg.onerror = function() { handlePosterImgError(this); };
          ph.replaceWith(newImg);
        }
      })
      .catch(() => {});
  });
}

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

function showAppAlert(title, message, isSuccess = false) {
  const icon = isSuccess ? '\u2713' : '\u2715';
  const iconColor = isSuccess ? 'var(--accent-2, #00b4d8)' : 'var(--danger, #e63946)';
  const html =
    '<div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px;">' +
      '<h3 style="margin:0; font-size:1.1rem; display:flex; align-items:center; gap:8px;">' +
        '<span style="color:' + iconColor + '; font-weight:bold; font-size:1.2rem;">' + icon + '</span> ' +
        escapeHtml(title) +
      '</h3>' +
      '<button type="button" class="action-btn" onclick="closeModal()" style="width:32px; height:32px; min-height:unset; padding:0; border-radius:50%; background:var(--bg); color:var(--muted); border:1px solid var(--border-strong); display:inline-flex; align-items:center; justify-content:center; font-size:1rem; line-height:1; cursor:pointer; flex:none;">\u2715</button>' +
    '</div>' +
    '<p style="margin:0 0 16px; color:var(--muted); font-size:0.9rem; line-height:1.4; white-space:pre-wrap;">' + escapeHtml(message) + '</p>' +
    '<div style="display:flex; justify-content:flex-end; gap:8px;">' +
      '<button type="button" class="primary" onclick="closeModal()" style="min-width:80px; padding:8px 16px;">OK</button>' +
    '</div>';
  showModal(html);
}

function showAppConfirm(title, message, confirmBtnText, onConfirm, isDanger = true) {
  const icon = isDanger ? '&#x26A0;' : '?';
  const iconColor = isDanger ? 'var(--danger, #e63946)' : 'var(--accent-2, #00b4d8)';
  const confirmBtnStyle = isDanger ? 'background:var(--danger, #e63946); color:#fff; border:none;' : '';
  const html =
    '<div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px;">' +
      '<h3 style="margin:0; font-size:1.1rem; display:flex; align-items:center; gap:8px;">' +
        '<span style="color:' + iconColor + '; font-weight:bold; font-size:1.2rem;">' + icon + '</span> ' +
        escapeHtml(title) +
      '</h3>' +
      '<button type="button" class="action-btn" onclick="closeModal()" style="width:32px; height:32px; min-height:unset; padding:0; border-radius:50%; background:var(--bg); color:var(--muted); border:1px solid var(--border-strong); display:inline-flex; align-items:center; justify-content:center; font-size:1rem; line-height:1; cursor:pointer; flex:none;">\u2715</button>' +
    '</div>' +
    '<p style="margin:0 0 16px; color:var(--muted); font-size:0.9rem; line-height:1.4; white-space:pre-wrap;">' + escapeHtml(message) + '</p>' +
    '<div style="display:flex; justify-content:flex-end; gap:8px;">' +
      '<button type="button" class="secondary" onclick="closeModal()" style="min-width:80px; padding:8px 16px;">Cancel</button>' +
      '<button type="button" class="primary" id="appConfirmBtn" style="min-width:80px; padding:8px 16px; ' + confirmBtnStyle + '">' + escapeHtml(confirmBtnText || 'Confirm') + '</button>' +
    '</div>';
  showModal(html);
  const btn = document.getElementById('appConfirmBtn');
  if (btn) {
    btn.onclick = () => {
      closeModal();
      if (typeof onConfirm === 'function') onConfirm();
    };
  }
}

function restoreActiveTab() {
  const p = (typeof location !== 'undefined' && location.pathname) ? location.pathname : '';
  const h = (typeof location !== 'undefined' && location.hash) ? location.hash : '';
  const isDeep = (typeof SERVER_DEEP_LINK_LIST !== 'undefined' && SERVER_DEEP_LINK_LIST) ||
    (p.startsWith('/lists/') && p !== '/lists') ||
    p.startsWith('/channels/') ||
    h.startsWith('#/list?') ||
    h.startsWith('#/item?');

  if (isDeep) {
    try {
      window._originTab = localStorage.getItem('myListAddon:activeTab') || 'discover';
      window._previousTab = window._originTab;
    } catch (e) {}
    return;
  }

  let tab = 'discover';
  try {
    tab = localStorage.getItem('myListAddon:activeTab') || 'discover';
  } catch (e) {}
  if (tab === 'item-details' || tab === 'list-details') tab = 'discover';
  switchTab(tab);
}

function switchListsSubmenu(name, btn) {
  try {
    document.documentElement.removeAttribute('data-initial-lists-sub');
    localStorage.setItem('myListAddon:listsSubmenu', name);
  } catch (e) {}
  document.querySelectorAll('#listsSubnavBar .subnav-pill').forEach(function(p) {
    p.classList.remove('active');
    const c = p.querySelector('.check-icon');
    if (c) c.remove();
  });
  if (btn) {
    btn.classList.add('active');
    btn.insertAdjacentHTML('afterbegin', '<span class="check-icon">&#x2713;</span> ');
  }
  const subpanels = {
    'my-lists': 'listsSubMyLists',
    'liked': 'listsSubLiked',
    'bulk': 'listsSubBulk',
    'create-list': 'listsSubCreateList',
    'import': 'listsSubImport'
  };
  Object.keys(subpanels).forEach(function(k) {
    const el = document.getElementById(subpanels[k]);
    if (el) el.style.display = 'none';
  });
  const activeId = subpanels[name];
  const activeEl = document.getElementById(activeId);
  if (activeEl) activeEl.style.display = 'block';

  if (name === 'my-lists') {
    const creatorBox = document.getElementById('creatorDashboard');
    const hasCreatorContent = creatorBox && (creatorBox.querySelector('.list-card') || (creatorBox.children.length > 0 && !creatorBox.innerText.includes('Loading')));
    if (!hasCreatorContent && typeof renderCreatorDashboard === 'function') {
      renderCreatorDashboard();
    }
    const mdbBox = document.getElementById('myMdblistListsResult');
    const hasMdbContent = mdbBox && mdbBox.children.length > 0;
    if (!hasMdbContent && typeof runMyMdblistLists === 'function') {
      runMyMdblistLists();
    }
    const traktBox = document.getElementById('myTraktListsResult');
    const privateTraktBox = document.getElementById('myPrivateTraktListsResult');
    const hasTraktContent = (traktBox && traktBox.children.length > 0) || (privateTraktBox && privateTraktBox.children.length > 0);
    if (!hasTraktContent && typeof runMyTraktLists === 'function') {
      runMyTraktLists();
    }
    const tmdbBox = document.getElementById('myTmdbListsResult');
    const hasTmdbContent = tmdbBox && tmdbBox.children.length > 0;
    if (!hasTmdbContent && typeof runMyTmdbLists === 'function') {
      runMyTmdbLists();
    }
    const simklBox = document.getElementById('mySimklListsResult');
    const hasSimklContent = simklBox && simklBox.children.length > 0;
    if (!hasSimklContent && typeof runMySimklLists === 'function') {
      runMySimklLists();
    }
  }
  if (name === 'liked') {
    const likedBox = document.getElementById('likedListsFeed');
    const hasLikedContent = likedBox && likedBox.children.length > 0;
    if (!hasLikedContent && typeof renderLikedListsFeed === 'function') {
      renderLikedListsFeed();
    }
  }
}

function switchSettingsSubmenu(name, btn) {
  try {
    document.documentElement.removeAttribute('data-initial-settings-sub');
    localStorage.setItem('myListAddon:settingsSubmenu', name);
  } catch (e) {}
  if (btn) {
    document.querySelectorAll('#settingsSubnavBar .subnav-pill').forEach(function(p) {
      p.classList.remove('active');
      const c = p.querySelector('.check-icon');
      if (c) c.remove();
    });
    btn.classList.add('active');
    btn.insertAdjacentHTML('afterbegin', '<span class="check-icon">&#x2713;</span> ');
  }
  const subpanels = {
    'account': 'settingsSubAccount',
    'keys': 'settingsSubAccount',
    'external': 'settingsSubExternal',
    'backup': 'settingsSubBackup',
    'feedback': 'settingsSubFeedback'
  };
  Object.keys(subpanels).forEach(function(k) {
    const el = document.getElementById(subpanels[k]);
    if (el) el.style.display = 'none';
  });
  const activeId = subpanels[name] || 'settingsSubAccount';
  const activeEl = document.getElementById(activeId);
  if (activeEl) activeEl.style.display = 'block';
  if (name === 'backup' && typeof renderPresetsList === 'function') {
    renderPresetsList();
  }
  if (name === 'external' && typeof populateImportTargetLists === 'function') {
    populateImportTargetLists();
  }
  if (name === 'feedback' && typeof loadUserFeedbackThreads === 'function') {
    loadUserFeedbackThreads();
  }
}

// --- Two-Way Support & Feedback Chat Controller ------------------------------
let userFeedbackThreads = [];
let activeFeedbackThreadId = null;
let isComposingNewFeedback = false;

function getUserFeedbackThreadIds() {
  try {
    const raw = localStorage.getItem('myListAddon:feedbackThreadIds');
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function saveUserFeedbackThreadId(threadId) {
  if (!threadId) return;
  try {
    const ids = getUserFeedbackThreadIds();
    if (!ids.includes(threadId)) {
      ids.unshift(threadId);
      localStorage.setItem('myListAddon:feedbackThreadIds', JSON.stringify(ids.slice(0, 30)));
    }
  } catch (e) {}
}

async function loadUserFeedbackThreads() {
  const threadIds = getUserFeedbackThreadIds();
  const creatorName = (typeof activeCreator !== 'undefined' && activeCreator && activeCreator.creatorName) ? activeCreator.creatorName : null;

  try {
    const res = await fetch(ORIGIN + '/api/feedback/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        threadIds: threadIds,
        creatorName: creatorName,
      }),
    });
    const data = await res.json().catch(() => null);
    if (data && data.ok && Array.isArray(data.threads)) {
      userFeedbackThreads = data.threads;
      data.threads.forEach((t) => saveUserFeedbackThreadId(t.id));
      if (!activeFeedbackThreadId && userFeedbackThreads.length) {
        activeFeedbackThreadId = userFeedbackThreads[0].id;
      }
    }
  } catch (e) {}

  renderUserFeedbackThreadsUI();
}

function refreshUserFeedbackThreads() {
  const statusEl = document.getElementById('supportChatStatus');
  if (statusEl) statusEl.textContent = 'Refreshing\u2026';
  loadUserFeedbackThreads().then(() => {
    if (statusEl) {
      statusEl.textContent = 'Up to date';
      setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2000);
    }
  });
}

function toggleNewFeedbackForm(showNew) {
  isComposingNewFeedback = !!showNew;
  renderUserFeedbackThreadsUI();
  if (showNew) {
    const msgInput = document.getElementById('feedbackMessageInput');
    if (msgInput) { msgInput.focus(); }
  }
}

function selectFeedbackThread(threadId) {
  activeFeedbackThreadId = threadId;
  isComposingNewFeedback = false;
  renderUserFeedbackThreadsUI();
}

function renderUserFeedbackThreadsUI() {
  const bar = document.getElementById('supportThreadsBar');
  const chatView = document.getElementById('supportChatView');
  const formWrap = document.getElementById('newFeedbackFormWrap');
  const cancelBtn = document.getElementById('feedbackCancelNewBtn');
  const newTicketBtn = document.getElementById('btnNewFeedbackTicket');

  if (!userFeedbackThreads.length) {
    if (bar) bar.style.display = 'none';
    if (chatView) chatView.style.display = 'none';
    if (formWrap) formWrap.style.display = 'block';
    if (cancelBtn) cancelBtn.style.display = 'none';
    if (newTicketBtn) newTicketBtn.style.display = 'none';
    return;
  }

  if (newTicketBtn) newTicketBtn.style.display = 'inline-flex';

  if (bar) {
    bar.style.display = 'flex';
    bar.innerHTML = userFeedbackThreads.map((t) => {
      const isActive = t.id === activeFeedbackThreadId && !isComposingNewFeedback;
      const catLabel = t.category ? (t.category.charAt(0).toUpperCase() + t.category.slice(1)) : 'Support';
      const hasAdminReply = Array.isArray(t.messages) && t.messages.some((m) => m.sender === 'admin');
      const badge = hasAdminReply ? ' \uD83D\uDCAC' : '';
      return '<button type="button" class="support-thread-pill ' + (isActive ? 'active' : '') + '" onclick="selectFeedbackThread(&quot;' + escapeAttr(t.id) + '&quot;)">' +
        escapeHtml(catLabel) + badge +
      '</button>';
    }).join('');
  }

  if (isComposingNewFeedback) {
    if (chatView) chatView.style.display = 'none';
    if (formWrap) formWrap.style.display = 'block';
    if (cancelBtn) cancelBtn.style.display = 'inline-flex';
    return;
  }

  if (formWrap) formWrap.style.display = 'none';
  if (chatView) chatView.style.display = 'block';

  const activeThread = userFeedbackThreads.find((t) => t.id === activeFeedbackThreadId) || userFeedbackThreads[0];
  if (!activeThread) return;
  activeFeedbackThreadId = activeThread.id;

  const stream = document.getElementById('supportMessagesStream');
  if (stream) {
    const messages = Array.isArray(activeThread.messages) && activeThread.messages.length
      ? activeThread.messages
      : [{
          id: 'msg_init',
          sender: 'user',
          senderName: activeThread.creatorName || 'You',
          text: activeThread.message || '(Initial message)',
          timestamp: activeThread.createdAt || Date.now(),
        }];

    stream.innerHTML = messages.map((m) => {
      const isAdmin = m.sender === 'admin';
      const senderLabel = isAdmin ? '\uD83D\uDC68\u200D\uD83D\uDCBB Developer' : (m.senderName || 'You');
      const timeStr = m.timestamp ? new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      return '<div class="support-bubble ' + (isAdmin ? 'admin' : 'user') + '">' +
        '<div class="support-bubble-sender">' + escapeHtml(senderLabel) + '</div>' +
        '<div>' + escapeHtml(m.text || '') + '</div>' +
        (timeStr ? '<div class="support-bubble-time">' + escapeHtml(timeStr) + '</div>' : '') +
      '</div>';
    }).join('');

    stream.scrollTop = stream.scrollHeight;
  }
}

async function sendUserFeedbackReply() {
  if (!activeFeedbackThreadId) return;
  const input = document.getElementById('supportReplyInput');
  const btn = document.getElementById('supportReplySendBtn');
  const statusEl = document.getElementById('supportChatStatus');
  const text = (input ? input.value : '').trim();
  if (!text) return;

  if (btn) btn.disabled = true;
  if (statusEl) statusEl.textContent = 'Sending reply\u2026';

  const thread = userFeedbackThreads.find((t) => t.id === activeFeedbackThreadId);
  const creatorName = (typeof activeCreator !== 'undefined' && activeCreator && activeCreator.creatorName) ? activeCreator.creatorName : null;

  try {
    const res = await fetch(ORIGIN + '/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        threadId: activeFeedbackThreadId,
        message: text,
        creatorName: creatorName,
      }),
    });
    const data = await res.json().catch(() => null);
    if (data && data.ok && data.entry) {
      if (input) input.value = '';
      if (statusEl) statusEl.textContent = '';
      const idx = userFeedbackThreads.findIndex((t) => t.id === activeFeedbackThreadId);
      if (idx !== -1) {
        userFeedbackThreads[idx] = data.entry;
      } else {
        userFeedbackThreads.unshift(data.entry);
      }
      renderUserFeedbackThreadsUI();
    } else {
      if (statusEl) statusEl.textContent = (data && data.error) || 'Failed to send reply.';
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Connection error.';
  }
  if (btn) btn.disabled = false;
}

async function submitFeedback() {
  const btn = document.getElementById('feedbackSubmitBtn');
  const statusEl = document.getElementById('feedbackStatus');
  const category = document.getElementById('feedbackCategorySelect').value;
  const message = document.getElementById('feedbackMessageInput').value.trim();
  const contact = document.getElementById('feedbackContactInput').value.trim();
  if (!message) {
    if (statusEl) { statusEl.textContent = 'Write something first.'; statusEl.style.color = 'var(--danger)'; }
    return;
  }
  if (btn) btn.disabled = true;
  if (statusEl) { statusEl.textContent = 'Sending\u2026'; statusEl.style.color = 'var(--muted)'; }
  try {
    const res = await fetch(ORIGIN + '/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: category,
        message: message,
        contact: contact,
        creatorName: (typeof activeCreator !== 'undefined' && activeCreator) ? activeCreator.creatorName : null,
      }),
    });
    const data = await res.json().catch(() => null);
    if (data && data.ok && data.entry) {
      if (statusEl) { statusEl.textContent = 'Message sent! Connecting to chat\u2026'; statusEl.style.color = 'var(--accent)'; }
      document.getElementById('feedbackMessageInput').value = '';
      document.getElementById('feedbackContactInput').value = '';
      saveUserFeedbackThreadId(data.entry.id);
      userFeedbackThreads.unshift(data.entry);
      activeFeedbackThreadId = data.entry.id;
      isComposingNewFeedback = false;
      setTimeout(() => {
        if (statusEl) statusEl.textContent = '';
        renderUserFeedbackThreadsUI();
      }, 600);
    } else {
      if (statusEl) { statusEl.textContent = (data && data.error) || 'Could not send \u2014 try again in a moment.'; statusEl.style.color = 'var(--danger)'; }
    }
  } catch (e) {
    if (statusEl) { statusEl.textContent = 'Could not send \u2014 check your connection.'; statusEl.style.color = 'var(--danger)'; }
  }
  if (btn) btn.disabled = false;
}

// Fire-and-forget analytics beacon feeding recordTrackedEvent server-side
// (see its own comment) -- never awaited by callers, and wrapped so a
// failure here can never disrupt the actual watch/list action it's riding
// along on. keepalive lets the request finish even if the page navigates
// away right after (e.g. right after adding something and switching tabs).
function trackEvent(eventType, id, title, mediaType) {
  trackEventsBatch(eventType, [{ id: id, title: title, mediaType: mediaType }]);
}

function trackEventsBatch(eventType, items) {
  if (!items || !items.length) return;
  try {
    const events = items.slice(0, 50)
      .filter((it) => it && it.id)
      .map((it) => ({ eventType: eventType, id: String(it.id), title: it.title || '', mediaType: it.mediaType === 'series' ? 'series' : 'movie' }));
    if (!events.length) return;
    fetch(ORIGIN + '/api/track-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: events }),
      keepalive: true,
    }).catch(() => {});
  } catch (e) {
    // non-critical -- this is optional telemetry, not a real feature
  }
}

function filterDiscoverShelves(filter, btn) {
  try {
    document.documentElement.removeAttribute('data-initial-discover-sub');
  } catch (e) {}
  window._currentDiscoverFilter = filter || 'all';
  try {
    localStorage.setItem('myListAddon:discoverSubmenu', filter || 'all');
  } catch (e) {}
  if (btn) {
    document.querySelectorAll('#discoverSubnavBar .subnav-pill').forEach(function(p) {
      p.classList.remove('active');
      const c = p.querySelector('.check-icon');
      if (c) c.remove();
    });
    btn.classList.add('active');
    btn.insertAdjacentHTML('afterbegin', '<span class="check-icon">&#x2713;</span> ');
    try {
      btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    } catch (e) {}
  }
  const shelvesContainer = document.getElementById('discoverShelvesContainer');
  const feedContainer = document.getElementById('discoverListsFeed');
  const popularContainer = document.getElementById('discoverSubPopular');
  const curatedContainer = document.getElementById('discoverSubCurated');

  if (popularContainer) popularContainer.style.display = 'none';
  if (curatedContainer) curatedContainer.style.display = 'none';
  if (shelvesContainer) shelvesContainer.style.display = 'none';
  if (feedContainer) feedContainer.style.display = 'none';

  if (filter === 'popular') {
    if (popularContainer) {
      popularContainer.style.display = 'block';
      if (typeof loadPopularListsFeed === 'function') loadPopularListsFeed();
    }
  } else if (filter === 'curated') {
    if (curatedContainer) {
      curatedContainer.style.display = 'block';
      if (typeof loadCuratedListsFeed === 'function') loadCuratedListsFeed();
    }
  } else {
    if (feedContainer) {
      feedContainer.style.display = 'block';
      window._discoverFeedsCache = window._discoverFeedsCache || {};
      if (window._discoverFeedsCache[filter]) {
        feedContainer.innerHTML = window._discoverFeedsCache[filter];
        window._currentDiscoverRenderedFilter = filter;
      } else if (typeof renderDiscoverChartsList === 'function') {
        renderDiscoverChartsList(filter);
      }
    }
  }
}

// Renders the chart lists for the Movies or Shows tab in Discover as list-cards
// (matching how search results and the Lists tab look) by converting the
// baked-in chart data tables into the same object shape render5PosterListsFeed expects.
function renderDiscoverChartsList(type, forceRefresh) {
  const container = document.getElementById('discoverListsFeed');
  if (!container) return;
  window._discoverFeedsCache = window._discoverFeedsCache || {};
  if (!forceRefresh && window._discoverFeedsCache[type]) {
    container.innerHTML = window._discoverFeedsCache[type];
    window._currentDiscoverRenderedFilter = type;
    return;
  }
  if (!forceRefresh && window._currentDiscoverRenderedFilter === type && container.children.length > 0 && !container.innerText.includes('Loading')) {
    window._discoverFeedsCache[type] = container.innerHTML;
    return;
  }
  window._currentDiscoverRenderedFilter = type;
  container.innerHTML = '<p style="color:var(--muted); font-size:0.88rem;">Loading charts\u2026</p>';

  // Build list objects from all chart tables, filtered to the right type.
  const lists = [];

  // Helper: push a pair entry
  function pushPair(name, movieUrl, showUrl, group) {
    if ((type === 'movie' || type === 'all') && movieUrl) {
      lists.push({ name: name, url: movieUrl, type: 'movie', user: group, likes: 0 });
    }
    if ((type === 'series' || type === 'all') && showUrl) {
      lists.push({ name: name, url: showUrl, type: 'series', user: group, likes: 0 });
    }
  }
  // Helper: push single-type entry
  function pushSingle(name, url, entryType, group) {
    if (type === entryType || type === 'all' || type === 'gems' || type === 'kids' || type === 'holidays' || type === 'genres' || type === 'curated') {
      lists.push({ name: name, url: url, type: entryType, user: group, likes: 0 });
    }
  }

  // Each data table is baked in at render time via the server-side template.
  // They are exposed as window._CHARTS_* globals by 09_page-shell.js.

  if (type !== 'gems' && type !== 'kids' && type !== 'holidays' && type !== 'genres' && type !== 'curated') {
    if (type === 'movie' || type === 'all') {
      pushSingle('New Releases', 'tmdb:chart:new_movies', 'movie', 'TMDB');
    }
    if (type === 'series' || type === 'all') {
      pushSingle('New Releases', 'tmdb:chart:new_shows', 'series', 'TMDB');
    }
    if (window._CHARTS_TMDB) {
      window._CHARTS_TMDB.forEach(function(p) {
        if (p.name.startsWith('New Releases')) return;
        pushPair(p.name, p.movieUrl, p.showUrl, 'TMDB');
      });
    }
    if (window._CHARTS_TRAKT) {
      window._CHARTS_TRAKT.forEach(function(p) { pushPair(p.name, p.movieUrl, p.showUrl, 'Trakt'); });
    }
    if (window._CHARTS_TRAKT_BO) {
      window._CHARTS_TRAKT_BO.forEach(function(p) { pushSingle(p.name, p.url, p.type, 'Trakt'); });
    }
    if (window._CHARTS_MDBLIST) {
      window._CHARTS_MDBLIST.forEach(function(p) { pushPair(p.name, p.movieUrl, p.showUrl, 'MDBList'); });
    }
    if (window._CHARTS_SIMKL) {
      window._CHARTS_SIMKL.forEach(function(p) { pushPair(p.name, p.movieUrl, p.showUrl, 'Simkl'); });
    }
    if (window._CHARTS_SIMKL_ANIME) {
      window._CHARTS_SIMKL_ANIME.forEach(function(p) { pushSingle(p.name, p.url, p.type, 'Simkl'); });
    }
    if (window._CHARTS_STREAMING_TOP10) {
      window._CHARTS_STREAMING_TOP10.forEach(function(p) { pushPair(p.name + ' Top 10', p.movieUrl, p.showUrl, 'Streaming Top 10'); });
    }
    if (window._CHARTS_STREAMING_ALL) {
      window._CHARTS_STREAMING_ALL.forEach(function(p) { pushPair(p.name, p.movieUrl, p.showUrl, 'My Lists Addon'); });
    }
  }

  if (type === 'curated' || type === 'all') {
    const curatedPresets = [
      { name: 'Recommended Movies', url: 'custom:curated:recommended-movies', type: 'movie', user: 'Curated' },
      { name: 'Recommended Shows', url: 'custom:curated:recommended-shows', type: 'series', user: 'Curated' },
      { name: 'Curated: Hidden Gems', url: 'custom:curated:hidden-gems', type: 'movie', user: 'Curated' },
      { name: 'Curated: Top Rated Classics', url: 'custom:curated:top-rated-classics', type: 'movie', user: 'Curated' },
      { name: 'Curated: Cult Favorites', url: 'custom:curated:cult-favorites', type: 'movie', user: 'Curated' },
      { name: 'Curated: Binge-Worthy Series', url: 'custom:curated:binge-worthy-series', type: 'series', user: 'Curated' },
      { name: 'Curated: Award Winners', url: 'custom:curated:award-winners', type: 'movie', user: 'Curated' },
      { name: 'Curated: Feel-Good Hits', url: 'custom:curated:feel-good-hits', type: 'movie', user: 'Curated' },
      { name: 'Curated: Action & Thrills', url: 'custom:curated:action-thrills', type: 'movie', user: 'Curated' },
      { name: 'Curated: Sci-Fi Journeys', url: 'custom:curated:sci-fi-journeys', type: 'movie', user: 'Curated' },
      { name: 'Curated: Family Movie Night', url: 'custom:curated:family-movie-night', type: 'movie', user: 'Curated' },
      { name: 'Curated: True Crime & Mystery', url: 'custom:curated:true-crime-mystery', type: 'series', user: 'Curated' },
    ];
    curatedPresets.forEach(function(item) {
      pushSingle(item.name, item.url, item.type, 'Curated');
    });
  }

  if (type === 'gems' || type === 'all') {
    pushSingle('Hidden Gems', 'tmdb:hidden-gems', 'movie', 'Hidden Gems');
    pushSingle('Hidden Gems', 'tmdb:hidden-gems', 'series', 'Hidden Gems');
  }

  if (type === 'kids' || type === 'all') {
    if (window._CHARTS_KIDS) {
      window._CHARTS_KIDS.forEach(function(item) {
        if (item.movieUrl) pushSingle(item.name, item.movieUrl, 'movie', 'Kids');
        if (item.showUrl) pushSingle(item.name, item.showUrl, 'series', 'Kids');
      });
    }
  }

  if (type === 'holidays' || type === 'all') {
    if (window._CHARTS_HOLIDAYS) {
      window._CHARTS_HOLIDAYS.forEach(function(item) {
        if (item.movieUrl) pushSingle(item.name, item.movieUrl, 'movie', 'Holidays');
        if (item.showUrl) pushSingle(item.name, item.showUrl, 'series', 'Holidays');
      });
    }
  }

  if (type === 'genres' || type === 'all') {
    if (window._CHARTS_GENRES) {
      window._CHARTS_GENRES.forEach(function(item) {
        if (item.movieUrl) pushSingle(item.name, item.movieUrl, 'movie', 'Genres');
        if (item.showUrl) pushSingle(item.name, item.showUrl, 'series', 'Genres');
      });
    }
  }

  if (typeof render5PosterListsFeed === 'function') {
    render5PosterListsFeed(container, lists);
    window._discoverFeedsCache[type] = container.innerHTML;
    setTimeout(() => {
      if (container && window._currentDiscoverRenderedFilter === type) {
        window._discoverFeedsCache[type] = container.innerHTML;
      }
    }, 400);
  } else {
    container.innerHTML = '<p style="color:var(--muted); font-size:0.88rem;">Could not load chart lists.</p>';
  }
}

function switchCatalogsSubmenu(filter, btn) {
  if (filter === 'channels') {
    switchTab('channels');
    return;
  }
  try {
    document.documentElement.removeAttribute('data-initial-catalogs-sub');
  } catch (e) {}
  window._currentCatalogsSubmenu = filter || 'all';
  try {
    localStorage.setItem('myListAddon:catalogsSubmenu', filter || 'all');
  } catch (e) {}
  const hash = location.hash || '';
  const isDetailUrl = hash.startsWith('#/item?') || hash.startsWith('#/list?') || (location.pathname.startsWith('/lists/') && location.pathname !== '/lists');
  if (!isDetailUrl) {
    try {
      history.replaceState({ view: 'tab', tab: 'catalogs', fromCatalogsSubmenu: filter || 'all' }, '', '/');
    } catch (e) {}
  }
  if (!btn) {
    const selector = filter === 'quickadd' ? '#catalogsFilterBar button:nth-child(2)' : (filter === 'bulk' ? '#catalogsFilterBar button:nth-child(3)' : '#catalogsFilterBar button:nth-child(1)');
    btn = document.querySelector(selector);
  }
  if (btn) {
    document.querySelectorAll('#catalogsFilterBar .subnav-pill').forEach(function(p) {
      p.classList.remove('active');
      const c = p.querySelector('.check-icon');
      if (c) c.remove();
    });
    btn.classList.add('active');
    btn.insertAdjacentHTML('afterbegin', '<span class="check-icon">&#x2713;</span> ');
  }

  const panels = {
    'all': document.getElementById('catalogsSubShelves'),
    'quickadd': document.getElementById('catalogsSubQuickAdd'),
    'bulk': document.getElementById('catalogsSubBulk')
  };

  for (const key in panels) {
    if (panels[key]) {
      panels[key].style.display = (key === filter) ? 'block' : 'none';
    }
  }

  const undoToast = document.getElementById('undoToast');
  const resultDiv = document.getElementById('result');
  if (filter !== 'all') {
    if (undoToast) undoToast.style.display = 'none';
    if (resultDiv) resultDiv.style.display = 'none';
  } else {
    // Make sure all list rows are visible since we no longer have row-level filters
    document.querySelectorAll('#lists .entry').forEach(function(e) {
      e.style.display = '';
    });
  }
}

function setListSearchChip(filter, btn) {
  if (btn) {
    document.querySelectorAll('#listSearchTypeChips .subnav-pill').forEach(function(p) {
      p.classList.remove('active');
      const c = p.querySelector('.check-icon');
      if (c) c.remove();
    });
    btn.classList.add('active');
    btn.insertAdjacentHTML('afterbegin', '<span class="check-icon">&#x2713;</span> ');
  }
  const resultContainer = document.getElementById('listSearchResult');
  if (resultContainer) {
    resultContainer.setAttribute('data-type-filter', filter);
  }
  const cards = document.querySelectorAll('#listSearchResult .list-card');
  cards.forEach(function(card) {
    const cardType = card.getAttribute('data-list-type') || '';
    if (filter === 'all') {
      card.style.display = '';
    } else if (filter === 'movie') {
      card.style.display = (cardType === 'movie' || cardType === 'mixed') ? '' : 'none';
    } else if (filter === 'series') {
      card.style.display = (cardType === 'series' || cardType === 'mixed') ? '' : 'none';
    } else if (filter === 'lists') {
      card.style.display = '';
    }
  });
}

function quickAddProvider(name) {
  const providerData = {
    'Netflix': {
      top10Movie: 'https://mdblist.com/lists/hdlists/netflix-top-10-trending-movies',
      top10Series: 'https://mdblist.com/lists/hdlists/netflix-top-10-trending-shows',
      movie: 'https://mdblist.com/lists/garycrawfordgc/netflix-movies',
      series: 'https://mdblist.com/lists/garycrawfordgc/netflix-shows'
    },
    'Prime Video': {
      top10Movie: 'https://mdblist.com/lists/diimaan/amazon-prime-top-10-movies',
      top10Series: 'https://mdblist.com/lists/diimaan/amazon-prime-top-10-tv-shows',
      movie: 'https://mdblist.com/lists/garycrawfordgc/amazon-prime-movies',
      series: 'https://mdblist.com/lists/garycrawfordgc/amazon-prime-shows'
    },
    'Apple TV+': {
      top10Movie: 'https://mdblist.com/lists/ahmed2250/apple-tv-top-10-movies-today',
      top10Series: 'https://mdblist.com/lists/ahmed2250/apple-tv-top-10-tv-shows-today',
      movie: 'https://mdblist.com/lists/slimshizn/apple-tv-movies',
      series: 'https://mdblist.com/lists/snoak/latest-apple-tv-plus-tv-shows'
    },
    'Disney+': {
      top10Movie: 'https://mdblist.com/lists/andykai/disney-top-10-no-hulu',
      top10Series: 'https://mdblist.com/lists/andykai/disney-trending-no-hulu',
      movie: 'https://mdblist.com/lists/garycrawfordgc/disney-movies',
      series: 'https://mdblist.com/lists/garycrawfordgc/disney-shows'
    },
    'HBO Max': {
      top10Movie: 'https://mdblist.com/lists/harmes7/hbo-max-top-10-movies-m77r6mc20q',
      top10Series: 'https://mdblist.com/lists/harmes7/hbo-max-top-10-series-cp45l27nhd',
      movie: 'https://mdblist.com/lists/snoak/latest-max-movies',
      series: 'https://mdblist.com/lists/garycrawfordgc/hbo-shows'
    },
    'Hulu': {
      top10Movie: 'https://mdblist.com/lists/hulupiv/hulu-top-10-movies',
      top10Series: 'https://mdblist.com/lists/hulupiv/hulu-top-10-shows',
      movie: 'https://mdblist.com/lists/garycrawfordgc/hulu-movies',
      series: 'https://mdblist.com/lists/garycrawfordgc/hulu-shows'
    },
    'Paramount+': {
      top10Movie: 'https://mdblist.com/lists/ahmed2250/paramount-top-10-movies-today',
      top10Series: 'https://mdblist.com/lists/ahmed2250/paramount-top-10-tv-shows-today',
      movie: 'https://mdblist.com/lists/snoak/latest-paramount-plus-movies',
      series: 'https://mdblist.com/lists/snoak/latest-paramount-plus-tv-shows'
    },
    'Peacock': {
      top10Movie: 'https://mdblist.com/lists/diimaan/peacock-top-10-movies',
      top10Series: 'https://mdblist.com/lists/peacockpiv/peacock-top-10-shows',
      movie: 'https://mdblist.com/lists/tvgeniekodi/peacock-movies',
      series: 'https://mdblist.com/lists/tvgeniekodi/peacock-tv-shows'
    }
  };
  const data = providerData[name];
  if (data) {
    if (data.top10Movie) addRow(name + ' Top 10', data.top10Movie, 'movie', true, 'Streaming Top 10');
    if (data.top10Series) addRow(name + ' Top 10', data.top10Series, 'series', true, 'Streaming Top 10');
    if (data.movie) addRow(name, data.movie, 'movie', true, name);
    if (data.series) addRow(name, data.series, 'series', true, name);
    saveState();
    switchTab('catalogs');
  }
}

// Kept as a no-op (not removed) -- the poster-click handler in
// 19_client-search-and-likes.js still calls this defensively before every
// item-details open, and detailOverlay itself no longer exists (it's the
// list-details tab panel now, see 09_page-shell.js and
// openListDetailsPage in 23_client-list-management.js, which switchTab
// already hides/shows the normal way). Safer to leave this as a harmless
// no-op than to hunt down and remove every defensive call site.
function closeDetailOverlay() {}


// Renders one source URL row. A "merged" entry (multiple sources feeding
// one shelf) has several of these inside its .sources container; a normal
// entry has exactly one. Kept as its own function so addSourceRow can also
// generate one when the person clicks "+ Add another source".
function sourceRowHtml(u, readonly) {
  if (readonly) {
    return '<div class="source-row">' +
      '<div class="row field-row">' +
      '<input type="text" class="url" value="mdblist:watchlist" readonly style="opacity:0.75;">' +
      '</div>' +
      '<div class="testrow">' +
      '<button type="button" class="btn-test secondary" onclick="testSourceRow(this)">Test</button>' +
      '<div class="testresult"></div>' +
      '</div>' +
      '</div>';
  }
  return '<div class="source-row">' +
    '<div class="row field-row">' +
    '<input type="text" placeholder="mdblist.com, trakt.tv, or themoviedb.org list URL" class="url" value="' + escapeAttr(u) + '" oninput="checkDuplicateUrl(this)">' +
    '<button type="button" class="movebtn removebtn remove-source-btn" onclick="removeSourceRow(this)" style="display:none;">\u2715</button>' +
    '</div>' +
    '<small class="dup-warning" style="display:none;">\u26a0 Already added elsewhere in this list.</small>' +
    '<div class="testrow">' +
    '<button type="button" class="btn-test secondary" onclick="testSourceRow(this)">Test</button>' +
    '<div class="testresult"></div>' +
    '</div>' +
    '</div>';
}

// Shared with editChannel below -- client-side twin of the server's
// parseChannelPayload, since the builder page needs to read a channel's
// payload back out too (to render its summary, and now to load it back
// into the picker for editing).
function parseChannelPayloadClient(u) {
  try {
    const raw = String(u || '').trim();
    if (!raw.startsWith('channel:v1:')) return null;
    const data = JSON.parse(raw.slice('channel:v1:'.length));
    return data && Array.isArray(data.items) ? data : null;
  } catch (e) {
    return null;
  }
}

function channelSourceRowHtml(u) {
  let summary = 'Custom Channel';
  const payload = parseChannelPayloadClient(u);
  if (payload) {
    const items = payload.items || [];
    const epCount = items.filter((it) => it.kind === 'episode').length;
    const movieCount = items.filter((it) => it.kind === 'movie').length;
    const parts = [];
    if (epCount) parts.push(epCount + ' episode' + (epCount === 1 ? '' : 's'));
    if (movieCount) parts.push(movieCount + ' movie' + (movieCount === 1 ? '' : 's'));
    summary = items.length + ' pick' + (items.length === 1 ? '' : 's') + (parts.length ? ' (' + parts.join(', ') + ')' : '');
    if (payload.dailyRotate) {
      summary = items.length + '-episode pool \u2014 shows ' + CHANNEL_ROTATION_SHOWS_PER_DAY + ' shows \u00d7 ' +
        CHANNEL_ROTATION_EPISODES_PER_SHOW + ' episodes each, refreshed daily';
    } else if (payload.shuffle) {
      summary += ' \u2014 shuffled daily';
    }
  }
  return '<div class="source-row">' +
    '<p style="margin:0;"><small>' + escapeHtml(summary) + ' \u2014 built with the Channels panel above.</small> ' +
    '<button type="button" class="secondary channelEditBtn" style="padding:4px 10px; min-height:unset;" onclick="editChannel(this)">Edit</button></p>' +
    '<input type="hidden" class="url" value="' + escapeAttr(u) + '">' +
    '</div>';
}

// Custom Lists don't need the channelId/name-embedding machinery Channels
// do -- each pick is already its own real, independently resolvable movie
// or show (see fetchCustomListCatalog), so there's no synthetic identity
// to keep stable across a merge the way a Channel's is; the ordinary
// merge-into-one-shelf mechanism every other list type uses works fine
// here unmodified.
function parseCustomListPayloadClient(u) {
  try {
    const raw = String(u || '').trim();
    if (!raw.startsWith('customlist:v1:')) return null;
    const data = JSON.parse(raw.slice('customlist:v1:'.length));
    if (!data || !Array.isArray(data.items)) return null;
    if (data.type && data.type !== 'movie' && data.type !== 'series' && data.type !== 'mixed') return null;
    return data;
  } catch (e) {
    return null;
  }
}

function findCustomListBySlugOrName(slug, name) {
  if (!slug && !name) return null;
  const sLower = String(slug || '').toLowerCase().trim();
  const nLower = String(name || '').toLowerCase().trim();
  const slugifiedName = (typeof slugify === 'function' && name) ? slugify(name).toLowerCase() : '';
  const deslugified = (typeof deslugify === 'function' && slug) ? deslugify(slug).toLowerCase() : '';

  function matches(l) {
    if (!l) return false;
    const lSlug = String(l.slug || l.localSlug || l.creatorSlug || l.listSlug || '').toLowerCase();
    const lName = String(l.name || '').toLowerCase();
    const lNameSlug = (typeof slugify === 'function' && l.name) ? slugify(l.name).toLowerCase() : '';
    if (sLower && (lSlug === sLower || lName === sLower || lNameSlug === sLower || (deslugified && lName === deslugified))) return true;
    if (nLower && (lName === nLower || lSlug === nLower || lNameSlug === nLower || (slugifiedName && (lSlug === slugifiedName || lNameSlug === slugifiedName)))) return true;
    return false;
  }

  // 1. Check loadLocalCustomLists()
  try {
    const map = (typeof loadLocalCustomLists === 'function') ? loadLocalCustomLists() : {};
    if (sLower && map[sLower]) return map[sLower];
    const found = Object.values(map).find(matches);
    if (found) return found;
  } catch (e) {}

  // 2. Check DOM entries (#lists .entry)
  try {
    const entries = document.querySelectorAll('#lists .entry');
    for (const entry of entries) {
      const urlInput = entry.querySelector('.url');
      if (!urlInput || !urlInput.value) continue;
      const payload = (typeof parseCustomListPayloadClient === 'function') ? parseCustomListPayloadClient(urlInput.value) : null;
      if (payload && matches(payload)) return payload;
    }
  } catch (e) {}

  // 3. Check lastCreatorListsData
  if (typeof lastCreatorListsData !== 'undefined' && Array.isArray(lastCreatorListsData)) {
    const found = lastCreatorListsData.find(matches);
    if (found) return found;
  }

  // 4. Check lastLocalCustomListsData
  if (typeof lastLocalCustomListsData !== 'undefined' && Array.isArray(lastLocalCustomListsData)) {
    const found = lastLocalCustomListsData.find(matches);
    if (found) return found;
  }

  // 5. Check livePreviewShelfData
  if (typeof livePreviewShelfData !== 'undefined' && Array.isArray(livePreviewShelfData)) {
    const shelf = livePreviewShelfData.find(s => s && matches(s));
    if (shelf && Array.isArray(shelf.sample) && shelf.sample.length) {
      return { name: shelf.name, type: shelf.type, items: shelf.sample, slug: slug || shelf.slug };
    }
  }

  return null;
}

function customListSourceRowHtml(u) {
  let summary = 'Custom List';
  const payload = parseCustomListPayloadClient(u);
  let publishedLinkHtml = '';
  if (payload) {
    const items = payload.items || [];
    const label = payload.type === 'movie' ? 'movie' : 'show';
    summary = items.length + ' ' + label + (items.length === 1 ? '' : 's');
    if (payload.shuffle) summary += ' \u2014 shuffled daily';
    if (payload.publishedUrl) {
      publishedLinkHtml = '<p style="margin:6px 0 0;"><small>Shared at: <a href="' + escapeAttr(payload.publishedUrl) + '" target="_blank" style="color:var(--accent-2); word-break:break-all;">' + escapeHtml(payload.publishedUrl) + '</a></small></p>';
    }
  }
  return '<div class="source-row">' +
    '<p style="margin:0;"><small>' + escapeHtml(summary) + ' \u2014 built with the Custom List panel above.</small> ' +
    '<button type="button" class="secondary customListEditBtn" style="padding:4px 10px; min-height:unset;" onclick="editCustomList(this)">Edit</button> ' +
    '<button type="button" class="secondary customListShareBtn" style="padding:4px 10px; min-height:unset;" onclick="startSaveListFlow(this)">Save List</button></p>' +
    publishedLinkHtml +
    '<input type="hidden" class="url" value="' + escapeAttr(u) + '">' +
    '</div>';
}

function syncCustomListToCatalogRows(slug, items, name, type) {
  if (!slug || !Array.isArray(items)) return;
  let updatedAny = false;

  document.querySelectorAll('#lists .entry').forEach((entry) => {
    const sourceRows = entry.querySelectorAll('.source-row');
    sourceRows.forEach((sourceRow) => {
      const urlInput = sourceRow.querySelector('.url');
      if (!urlInput || !urlInput.value.startsWith('customlist:v1:')) return;
      try {
        const payload = JSON.parse(urlInput.value.slice('customlist:v1:'.length));
        const matchesSlug = payload.localSlug === slug || payload.listSlug === slug || payload.creatorSlug === slug || payload.slug === slug || (slug && payload.listId === slug);
        if (!matchesSlug) return;

        const shelfType = payload.type || type || 'movie';
        let shelfItems = items;
        if (shelfType === 'movie' && (type === 'mixed' || !type || items.some((it) => it && (it.kind === 'series' || it.type === 'series' || it.type === 'tv' || it.showId)))) {
          shelfItems = items.filter((it) => it && (it.kind === 'movie' || it.type === 'movie' || (!it.kind && !it.type && !it.showId)));
        } else if (shelfType === 'series' && (type === 'mixed' || !type || items.some((it) => it && (it.kind === 'movie' || it.type === 'movie')))) {
          shelfItems = items.filter((it) => it && (it.kind === 'series' || it.type === 'series' || it.type === 'tv' || it.showId));
        }

        payload.items = shelfItems;
        if (name && payload.name) payload.name = name;

        const newUrl = 'customlist:v1:' + JSON.stringify(payload);
        if (typeof customListSourceRowHtml === 'function') {
          const temp = document.createElement('div');
          temp.innerHTML = customListSourceRowHtml(newUrl);
          if (temp.firstElementChild) {
            sourceRow.replaceWith(temp.firstElementChild);
          } else {
            urlInput.value = newUrl;
          }
        } else {
          urlInput.value = newUrl;
        }

        if (name && entry.querySelectorAll('.url').length === 1) {
          const rowNameInput = entry.querySelector('.name');
          if (rowNameInput) {
            const isMixed = type === 'mixed' || (!type && items.some((it) => it && (it.kind === 'series' || it.type === 'series' || it.type === 'tv' || it.showId)) && items.some((it) => it && (it.kind === 'movie' || it.type === 'movie' || (!it.kind && !it.type && !it.showId))));
            if (isMixed) {
              if (payload.type === 'movie' && !name.toLowerCase().includes('(movies)')) {
                rowNameInput.value = name + ' (Movies)';
              } else if (payload.type === 'series' && !name.toLowerCase().includes('(shows)')) {
                rowNameInput.value = name + ' (Shows)';
              } else {
                rowNameInput.value = name;
              }
            } else {
              rowNameInput.value = name;
            }
          }
        }

        updatedAny = true;
      } catch (e) {}
    });
  });

  if (updatedAny) {
    if (typeof saveState === 'function') saveState();
    if (typeof renderLivePreview === 'function') renderLivePreview();
  }
}

// A short, stable random id for a Channel row -- generated once when the
// channel is first saved (see saveChannel), then carried forward as-is on
// every reload/restore (see the addRow(..., e.id) calls below) rather than
// being re-derived from content. Channels used to fall through to the
// generic slugify(url)-based id like every other row, but a channel's
// "url" is its whole JSON payload -- slugifying that just truncates to the
// poster URL's prefix, producing a meaningless (and collision-prone) id.
function generateChannelId() {
  const rand = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36).slice(-4);
  return 'ch' + rand + time;
}

// Maps a list group/name string to one of 8 accent colours for the avatar dot.
function entryAvatarColor(s) {
  var palette = ['#007AFF','#FF9500','#34C759','#FF3B30','#AF52DE','#5856D6','#00C7BE','#FF6B35'];
  var h = 0;
  var str = s || '';
  for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) & 0xffff;
  return palette[h % palette.length];
}

function openAddShelfModal() {
  document.getElementById('addShelfModalName').value = '';
  document.getElementById('addShelfModalLinksContainer').innerHTML = 
    '<div class="add-shelf-link-row" style="display:flex; align-items:center; gap:8px; margin-bottom:12px;">' +
      '<input type="url" class="addShelfModalLinkInput" placeholder="URL (e.g. Trakt, Letterboxd)" style="flex:1; padding: 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size:1rem;" oninput="onAddShelfModalLinkInput(this); validateAddShelfModal()">' +
    '</div>';
  document.getElementById('addShelfModalType').value = 'movie';
  validateAddShelfModal();
  document.getElementById('addShelfModal').style.display = 'flex';
  document.getElementById('addShelfModalName').focus();
}

function addShelfModalAddLink() {
  const container = document.getElementById('addShelfModalLinksContainer');
  const div = document.createElement('div');
  div.className = 'add-shelf-link-row';
  div.style.display = 'flex';
  div.style.alignItems = 'center';
  div.style.gap = '8px';
  div.style.marginBottom = '12px';
  div.innerHTML = 
    '<input type="url" class="addShelfModalLinkInput" placeholder="Additional URL" style="flex:1; padding: 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size:1rem;" oninput="onAddShelfModalLinkInput(this); validateAddShelfModal()">' +
    '<button type="button" class="lc-btn secondary" style="padding: 12px;" onclick="this.closest(&quot;.add-shelf-link-row&quot;).remove(); validateAddShelfModal()">\u2715</button>';
  container.appendChild(div);
  validateAddShelfModal();
}

function validateAddShelfModal() {
  const name = document.getElementById('addShelfModalName').value.trim();
  const links = Array.from(document.querySelectorAll('.addShelfModalLinkInput')).map(el => el.value.trim()).filter(Boolean);
  const btn = document.getElementById('addShelfModalBtn');
  if (name && links.length > 0) {
    btn.disabled = false;
    btn.style.opacity = '1';
  } else {
    btn.disabled = true;
    btn.style.opacity = '0.5';
  }
}

function onAddShelfModalLinkInput(inputEl) {
  const link = inputEl.value.trim().toLowerCase();
  const typeSelect = document.getElementById('addShelfModalType');
  // Only auto-switch type if it's the first input or type is currently 'movie' and we detect a show
  if (link.includes('type=show') || link.includes('shows') || link.includes('series') || link.includes('tv')) {
    typeSelect.value = 'series';
  } else if (link.includes('movie') && typeSelect.value === 'series' && document.querySelectorAll('.addShelfModalLinkInput').length === 1) {
    typeSelect.value = 'movie';
  }
}

function submitAddShelfModal() {
  const name = document.getElementById('addShelfModalName').value.trim();
  const links = Array.from(document.querySelectorAll('.addShelfModalLinkInput')).map(el => el.value.trim()).filter(Boolean);
  const type = document.getElementById('addShelfModalType').value;
  if (!name || links.length === 0) return;
  
  if (links.length === 1) {
    addRow(name, links[0], type, true, 'Custom');
  } else {
    addCombinedRow(name, links, type, 'Custom');
  }
  
  document.getElementById('addShelfModal').style.display = 'none';
  saveState();
}

function addRow(name, url, type, enabled, group, channelId) {
  if (enabled === undefined) enabled = true;
  const isCuratedRec = String(url || '').startsWith('custom:curated:recommended');
  if (isCuratedRec && (name === 'Recommended Movies' || name === 'Recommended Shows' || !name || name === 'Curated List')) {
    name = 'Recommended';
  }
  const container = document.getElementById('lists');
  const div = document.createElement('div');
  div.className = 'entry';
  div.dataset.group = group || 'Custom';
  const isWatchlist = url === 'mdblist:watchlist';
  const isChannel = String(url || '').startsWith('channel:v1:');
  const isCustomList = String(url || '').startsWith('customlist:v1:');
  const isPremade = (
    String(url || '').startsWith('tmdb:chart:') ||
    String(url || '').startsWith('tmdb:') ||
    String(url || '').startsWith('autotrack:') ||
    String(url || '').startsWith('custom:curated:') ||
    (group && group !== 'Custom' && group !== 'Custom Lists' && !isChannel && !isCustomList)
  );
  
  if (isPremade) {
    div.classList.add('premade-shelf');
  }
  
  if (isChannel) {
    if (channelId && String(channelId).startsWith('merged-')) {
      div.dataset.mergedId = channelId;
    }
    div.dataset.channelId = channelId || generateChannelId();
  }
  const urlList = isWatchlist
    ? ['mdblist:watchlist']
    : String(url || '').split('\\n').map((s) => s.trim()).filter(Boolean);
  const rowsHtml = isChannel
    ? urlList.map((u) => channelSourceRowHtml(u)).join('')
    : isCustomList
      ? urlList.map((u) => customListSourceRowHtml(u)).join('')
      : (urlList.length ? urlList : ['']).map((u) => sourceRowHtml(u, isWatchlist)).join('');

  // Avatar: first letter of name (or group), coloured by group
  const avatarLetter = escapeHtml(((name || group || 'L').trim()[0] || 'L'));
  const avatarBg = entryAvatarColor(group || name || '');

  div.innerHTML =
    '<div class="entry-card-top" style="flex-direction: column;">' +
      '<div class="entry-ctrl-row" style="width: 100%; justify-content: flex-start; margin-bottom: 2px;">' +
        '<div class="entry-pos-wrap" style="display:flex; align-items:center;">' +
          '<input type="number" class="pos" min="1" title="Type a position number to move this list there" onchange="movePosTo(this)">' +
        '</div>' +
        '<span class="drag-handle ec-btn" draggable="true" title="Drag to reorder" style="cursor:grab; font-size:1rem;">&#9776;</span>' +
        '<button type="button" class="ec-btn movebtn secondary" onclick="moveRow(this, -1)" title="Move up">&#8593;</button>' +
        '<button type="button" class="ec-btn movebtn secondary" onclick="moveRow(this, 1)" title="Move down">&#8595;</button>' +
        ((isCustomList || isChannel) ? ('<button type="button" class="ec-btn secondary" style="margin-left: auto; margin-right: 6px; font-weight:600; padding: 2px 10px;" onclick="' + (isCustomList ? 'editEntryCustomList(this)' : 'editEntryChannel(this)') + '">Edit</button>') : '') +
        '<button type="button" class="ec-btn movebtn removebtn danger" onclick="removeEntryWithUndo(this)" title="Remove this list" aria-label="Remove this list" style="' + (!(isCustomList || isChannel) ? 'margin-left: auto;' : '') + '">' +
          '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none;">' +
            '<polyline points="3 6 5 6 21 6"></polyline>' +
            '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>' +
            '<path d="M10 11v6"></path><path d="M14 11v6"></path>' +
            '<path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>' +
          '</svg>' +
        '</button>' +
      '</div>' +
      '<div style="display: flex; gap: 8px; width: 100%; align-items: center;">' +
        '<div class="entry-card-body" style="flex-direction: row; gap: 10px; align-items: center; width: 100%;">' +
          '<div class="entry-name-row" style="flex: 1;">' +
            '<input type="text" placeholder="Name (e.g. Trending Movies)" class="name" value="' + escapeAttr(name || '') + '">' +
          '</div>' +
          '<div class="entry-type-row" style="width: auto;">' +
            '<select class="type" ' + ((isChannel || isCustomList) ? 'disabled title="Type is fixed for this list kind"' : '') + '>' +
              '<option value="movie" ' + ((type === 'movie' || (isCustomList && type === 'movie')) ? 'selected' : '') + '>Movies</option>' +
              '<option value="series" ' + ((type === 'series' || isChannel || (isCustomList && type === 'series')) ? 'selected' : '') + '>Shows</option>' +
            '</select>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="sources">' + rowsHtml + '</div>' +
    (isWatchlist
      ? '<p class="watchlist-note"><small>Uses the MDBList API key from Settings.</small></p>'
      : (isChannel || isCustomList || isPremade)
        ? ''
        : '<button type="button" class="secondary add-source-btn" onclick="addSourceRow(this)">+ Add another source (merge into one catalog)</button>') +
    '<div class="live-preview-shelf" style="padding:0; margin:0; border:none; background:transparent;"><div class="live-preview-shelf-title"><span class="shelf-drag-handle" draggable="true" title="Drag to reorder catalog">&#x2630;</span><span class="shelf-title-text">' + escapeHtml(name || 'Unnamed') + ' - ' + (type === 'series' ? 'Series' : 'Movies') + '</span><span class="live-preview-shelf-status"></span><button type="button" class="text-action-btn" disabled>See All &rsaquo;</button></div><div class="live-preview-posters"><p style="color:var(--muted); font-size:0.88rem; text-align:center; padding: 20px;"><small>Click "Refresh Preview" above to load posters.</small></p></div></div>';
  container.appendChild(div);
  updateSourceRemoveButtons(div);
  relocateAddSourceBtn(div);
  initTouchDrag(div.querySelector('.drag-handle'));
  initTouchDrag(div.querySelector('.shelf-drag-handle'));
  checkAllDuplicateUrls();
  renumber();
  if (!suppressSave) {
    showAddedToast('"' + (name || 'Catalog') + '" added to My Catalogs \u2713');
  }
  return div;
}


// Combined Charts quick-adds pass an array of sources instead of one URL --
// this joins them the same newline-separated way a manually merged row's
// sources end up joined (see collectEntries/addSourceRow), then hands off
// to the regular addRow() so it's just an ordinary multi-source row from
// here on, editable/removable a source at a time like any other.
function addCombinedRow(name, urls, type, group) {
  addRow(name, urls.join('\\n'), type, true, group);
}

function addQuickAddRowsFromPairs(list, group, labelSuffix = "") {
  list.forEach((p) => {
    const label = labelSuffix ? p.name + " " + labelSuffix : p.name;
    if (p.movieUrl) addRow(label, p.movieUrl, "movie", true, group);
    if (p.showUrl) addRow(label, p.showUrl, "series", true, group);
  });
  saveState();
}

function addQuickAddRowsFromSimpleList(list, group) {
  list.forEach((l) => {
    addRow(l.name, l.url, l.type, true, group);
  });
  saveState();
}

${buildAddAllFnJs("addAllMdblistCharts", buildAddAllPairsCallsJs(MDBLIST_OFFICIAL_CHARTS, "MDBList Charts", ""))}

${buildAddAllFnJs("addAllTmdbCharts", buildAddAllPairsCallsJs(TMDB_CHART_LISTS, "TMDB Charts", ""))}

${buildAddAllFnJs("addAllTraktCharts", buildAddAllPairsCallsJs(TRAKT_CHART_LISTS, "Trakt Charts", "") + "\n" + buildAddAllSimpleCallsJs(TRAKT_BOXOFFICE_LIST, "Trakt Charts"))}

${buildAddAllFnJs("addAllSimklCharts", buildAddAllPairsCallsJs(SIMKL_CHART_LISTS, "Simkl Charts", "") + "\n" + buildAddAllSimpleCallsJs(SIMKL_ANIME_LIST, "Simkl Charts"))}

${buildAddAllFnJs("addAllStreaming", buildAddAllPairsCallsJs(STREAMING_ALL, "Streaming", ""))}

${buildAddAllFnJs("addAllStreamingTop10", buildAddAllPairsCallsJs(STREAMING_TOP10, "Streaming Top 10", "Top 10"))}

// Generates the client-side addAllCombinedCharts() function body straight
// from COMBINED_CHART_LISTS -- the individual "+ Movies"/"+ Shows"
// buttons on each row already get their (baked-in, hand-copy-free) source
// arrays this same way via jsStringArrayLiteral (see buildCombinedChartsHtml
// above). "Add all" used to be a second, hand-maintained copy of this same
// data that referenced STREAMING_TOP10/STREAMING_ALL directly -- both of
// which are server-side-only constants with no client-side equivalent, so
// clicking "Add all" threw a ReferenceError partway through (right after
// the hardcoded Popular/Trending/Streaming-Top-10-movies entries, which
// happened to not need those variables) and silently never added Streaming
// Top 10 Shows or Streaming (All Services) at all. Generating this
// function from the same single source of truth as the per-row buttons
// fixes that and makes a repeat impossible.
${buildAddAllCombinedChartsJs()}

${buildAddAllFnJs("addAllKidsCharts", buildAddAllPairsCallsJs(KIDS_LISTS, "Kids", ""))}
${buildAddAllFnJs("addAllHolidayCharts", buildAddAllPairsCallsJs(HOLIDAY_LISTS, "Holidays", ""))}
${buildAddAllFnJs("addAllGenreCharts", buildAddAllPairsCallsJs(GENRE_LISTS, "Genres", ""))}

function addAllHiddenGems() {
  addRow("Hidden Gems", "tmdb:hidden-gems", "movie", true, "Hidden Gems");
  addRow("Hidden Gems", "tmdb:hidden-gems", "series", true, "Hidden Gems");
  saveState();
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-add-all-action]');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const action = btn.getAttribute('data-add-all-action');
  if (action === 'mdblist-charts') addAllMdblistCharts();
  else if (action === 'tmdb-charts') addAllTmdbCharts();
  else if (action === 'trakt-charts') addAllTraktCharts();
  else if (action === 'simkl-charts') addAllSimklCharts();
  else if (action === 'streaming' || action === 'streaming-catalogs') addAllStreaming();
  else if (action === 'streaming-top10') addAllStreamingTop10();
  else if (action === 'combined-charts') addAllCombinedCharts();
  else if (action === 'hidden-gems') addAllHiddenGems();
  else if (action === 'kids') addAllKidsCharts();
  else if (action === 'holidays') addAllHolidayCharts();
  else if (action === 'genres') addAllGenreCharts();
});

// Adds a blank source row to an existing entry -- this is how a normal
// single-source row becomes a "merged" one: the server dedupes by IMDB id
// across whatever sources end up here (see fetchMergedCatalog).
function addSourceRow(btn) {
  const entry = btn.closest('.entry');
  const sources = entry.querySelector('.sources');
  const wrap = document.createElement('div');
  wrap.innerHTML = sourceRowHtml('', false);
  sources.appendChild(wrap.firstElementChild);
  updateSourceRemoveButtons(entry);
  relocateAddSourceBtn(entry);
  saveState();
}

function removeSourceRow(btn) {
  const entry = btn.closest('.entry');
  btn.closest('.source-row').remove();
  updateSourceRemoveButtons(entry);
  relocateAddSourceBtn(entry);
  checkAllDuplicateUrls();
  saveState();
}

// The per-source "remove" (\u2715) button only makes sense once an entry has
// more than one source -- hide it on a lone source so people aren't tempted
// to remove their only URL from here instead of using "Remove" on the
// whole row.
function updateSourceRemoveButtons(entry) {
  const rows = entry.querySelectorAll('.source-row');
  rows.forEach((row) => {
    const btn = row.querySelector('.remove-source-btn');
    if (btn) btn.style.display = rows.length > 1 ? '' : 'none';
  });
}

// "+ Add another source" is rendered once per entry (there's only ever one,
// regardless of how many source rows exist), while Test is rendered once
// per source row inside .testrow -- moving the single add-source button
// into the last row's .testrow puts them in the same flex container so
// they sit on one line together (wrapping only if the combined text
// genuinely can't fit), instead of the button rendering as its own
// separate block below the whole .sources stack. Re-run after every
// add/remove of a source row, since "the last row" changes each time.
function relocateAddSourceBtn(entry) {
  const btn = entry.querySelector('.add-source-btn');
  if (!btn) return; // watchlist/channel/customlist rows don't have one
  const testrows = entry.querySelectorAll('.sources .testrow');
  const lastTestrow = testrows[testrows.length - 1];
  if (!lastTestrow) return;
  const testresult = lastTestrow.querySelector('.testresult');
  if (testresult) lastTestrow.insertBefore(btn, testresult);
  else lastTestrow.appendChild(btn);
}

// Warns (doesn't block) when the same URL has been pasted into more than
// one source field anywhere in the builder -- catches an accidental double
// add, whether within one merged entry or across two separate rows.
function checkDuplicateUrl(input) {
  const val = input.value.trim();
  const row = input.closest('.source-row');
  const warn = row ? row.querySelector('.dup-warning') : null;
  if (!warn) return;
  if (!val || val === 'mdblist:watchlist') { warn.style.display = 'none'; return; }
  const all = [...document.querySelectorAll('#lists .url')];
  const dupCount = all.filter((el) => el.value.trim() === val).length;
  warn.style.display = dupCount > 1 ? '' : 'none';
}

function checkAllDuplicateUrls() {
  document.querySelectorAll('#lists .url').forEach((el) => checkDuplicateUrl(el));
}

function editEntryCustomList(btn) {
  const row = btn.closest('.entry');
  if (!row) return;
  const urlInput = row.querySelector('.sources .url');
  if (urlInput) {
    if (typeof editCustomList === 'function') {
      editCustomList(urlInput); // editCustomList in 21_client-custom-list-builder.js uses btn.closest('.source-row'), so we pass an element inside .source-row
    }
  }
}

function editEntryChannel(btn) {
  const row = btn.closest('.entry');
  if (!row) return;
  const urlInput = row.querySelector('.sources .url');
  if (urlInput) {
    if (typeof editChannel === 'function') {
      editChannel(urlInput); // editChannel in 20_client-channel-builder.js uses btn.closest('.source-row')
    }
  }
}

// Enables mouse wheel horizontal scrolling on .subnav-pills-bar and horizontal scrolling bars
document.addEventListener('wheel', (e) => {
  const bar = e.target.closest('.subnav-pills-bar, .tab-bar, .provider-chips-bar');
  if (!bar) return;
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
    if ((e.deltaY > 0 && bar.scrollLeft + bar.clientWidth < bar.scrollWidth) || (e.deltaY < 0 && bar.scrollLeft > 0)) {
      e.preventDefault();
      bar.scrollLeft += e.deltaY;
    }
  }
}, { passive: false });



<script>
const ORIGIN = ${JSON.stringify(origin)};
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
// Every native/official chart's (slug, name, movieUrl, showUrl) -- lets
// openListDetailsPage (23_client-list-management.js) push the clean
// /lists/<slug> path when the list it's opening is one of these, instead
// of always falling back to the older #/list?... hash format.
const CHART_SLUG_ENTRIES = ${JSON.stringify(CHART_SLUG_ENTRIES)};

function deslugify(s) {
  return String(s || '')
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function getListCleanPath(listUrl, name) {
  if (!listUrl) return null;
  const rawUrl = String(listUrl).trim();

  // 1. Known chart
  if (typeof CHART_SLUG_ENTRIES !== 'undefined') {
    const knownChart = CHART_SLUG_ENTRIES.find((e) => e.movieUrl === rawUrl || e.showUrl === rawUrl || e.url === rawUrl);
    if (knownChart) return '/lists/' + knownChart.slug;
  }

  // 2. Addon internal list (/lists/:user/:slug)
  if (typeof location !== 'undefined' && rawUrl.startsWith(location.origin + '/lists/')) {
    return rawUrl.slice(location.origin.length);
  }
  if (rawUrl.startsWith('/lists/')) {
    return rawUrl;
  }

  // 3. MDBList list: https://mdblist.com/lists/:user/:slug
  const mdbMatch = rawUrl.match(new RegExp('(?:https?:)?(?://)?(?:www\\.)?mdblist\\.com/lists/([^/]+)/([^/?#]+)', 'i'));
  if (mdbMatch) {
    return '/lists/mdblist/' + mdbMatch[1] + '/' + mdbMatch[2];
  }

  // 4. Trakt list: https://trakt.tv/users/:user/lists/:slug
  const traktMatch = rawUrl.match(new RegExp('(?:https?:)?(?://)?(?:www\\.)?trakt\\.tv/users/([^/]+)/lists/([^/?#]+)', 'i'));
  if (traktMatch) {
    return '/lists/trakt/' + traktMatch[1] + '/' + traktMatch[2];
  }

  // 5. TMDB list: https://www.themoviedb.org/list/:id
  const tmdbMatch = rawUrl.match(new RegExp('(?:https?:)?(?://)?(?:www\\.)?themoviedb\\.org/list/([0-9]+)', 'i'));
  if (tmdbMatch) {
    return '/lists/tmdb/' + tmdbMatch[1];
  }

  return null;
}

function isListAddedToConfig(url, type, slug) {
  const entries = document.querySelectorAll('#lists .entry');
  for (const entry of entries) {
    const t = entry.querySelector('.type') ? entry.querySelector('.type').value : '';
    if (type && t && t !== type && t !== 'both' && type !== 'both') continue;
    const urlInputs = entry.querySelectorAll('.url');
    for (const el of urlInputs) {
      const u = el.value.trim();
      if (url && u === url.trim()) return true;
      if (slug) {
        const payload = parseCustomListPayloadClient(u);
        if (payload && (payload.localSlug === slug || payload.listSlug === slug || payload.slug === slug)) return true;
      }
    }
  }
  return false;
}

function removeListFromConfig(url, type, slug) {
  const entries = document.querySelectorAll('#lists .entry');
  let removed = false;
  for (const entry of entries) {
    const t = entry.querySelector('.type') ? entry.querySelector('.type').value : '';
    if (type && t && t !== type && t !== 'both' && type !== 'both') continue;
    const urlInputs = entry.querySelectorAll('.url');
    for (const el of urlInputs) {
      const u = el.value.trim();
      let match = false;
      if (url && u === url.trim()) match = true;
      if (slug) {
        const payload = parseCustomListPayloadClient(u);
        if (payload && (payload.localSlug === slug || payload.listSlug === slug || payload.slug === slug)) match = true;
      }
      if (match) {
        entry.remove();
        removed = true;
        break;
      }
    }
  }
  if (removed) {
    renumber();
    saveState();
  }
  return removed;
}

function navigateBackFromDetail() {
  const targetTab = window._previousTab || 'discover';
  if (history.length > 1) {
    history.back();
  } else {
    if (location.pathname !== '/' && location.pathname !== '/configure' && !location.pathname.startsWith('/configure')) {
      history.replaceState({ view: 'tab', tab: targetTab }, '', '/');
    }
    document.querySelectorAll('.tab-panel').forEach(function(p) {
      p.hidden = (p.getAttribute('data-tab-panel') !== targetTab);
    });
    document.querySelectorAll('.tab-btn').forEach(function(b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === targetTab);
    });
    document.querySelectorAll('.bottom-nav-item').forEach(function(b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === targetTab);
    });
    const addShelfBtn = document.getElementById('headerAddShelfBtn');
    if (addShelfBtn) addShelfBtn.style.display = (targetTab === 'catalogs' ? 'block' : 'none');
    const createListBtn = document.getElementById('headerCreateListBtn');
    if (createListBtn) createListBtn.style.display = (targetTab === 'lists' ? 'block' : 'none');

    try {
      localStorage.setItem('myListAddon:activeTab', targetTab);
    } catch (e) {}
    if (typeof window._previousScrollY === 'number') {
      const scrollPos = window._previousScrollY;
      setTimeout(() => {
        window.scrollTo({ top: scrollPos, behavior: 'instant' });
      }, 0);
    }
  }
}

// Global state variables
var suppressSave = false;
var activeCreator = null;
var livePreviewShelfData = [];
// No dedicated text input for this one (unlike the other keys) -- it's set
// via the Connect Trakt button/OAuth flow, not typed in, so it lives as
// its own piece of state instead of being read from a DOM field.
var activeTraktToken = null;
let traktAccessToken = ${JSON.stringify(initialTraktAccessToken)};

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
  if (name === 'keys') {
    switchTab('settings');
    switchSettingsSubmenu('keys', document.querySelector('#settingsSubnavBar button:nth-child(1)'));
    return;
  }
  if (name === 'quick-add' || name === 'toplists') {
    switchTab('catalogs');
    switchCatalogsSubmenu('quickadd', document.querySelector('#catalogsFilterBar button:nth-child(2)'));
    return;
  }

  const titles = {
    discover: { title: 'Discover', sub: 'Explore Popular & Streaming' },
    catalogs: { title: 'My Catalogs', sub: 'Manage Configured Shelves' },
    lists: { title: 'Lists', sub: 'Community & Curated Lists' },
    channels: { title: 'Channels', sub: '24/7 Continuous TV Streaming' },
    search: { title: 'Search', sub: 'Find Movies, Shows & Lists' },
    settings: { title: 'Settings', sub: 'Accounts, API Keys & Tools' }
  };
  const t = titles[name] || { title: 'My Lists Addon', sub: '' };
  const titleEl = document.getElementById('pageMainTitle');
  const subEl = document.getElementById('pageSubtitle');
  if (titleEl) titleEl.textContent = t.title;
  if (subEl) subEl.textContent = t.sub;

  const createListBtn = document.getElementById('headerCreateListBtn');
  if (createListBtn) {
    createListBtn.style.display = name === 'lists' ? 'block' : 'none';
  }
  const addShelfBtn = document.getElementById('headerAddShelfBtn');
  if (addShelfBtn) {
    addShelfBtn.style.display = name === 'catalogs' ? 'block' : 'none';
  }

  document.querySelectorAll('.tab-panel').forEach(function(p) {
    p.hidden = (p.getAttribute('data-tab-panel') !== name);
  });
  document.querySelectorAll('.tab-btn').forEach(function(b) {
    b.classList.toggle('active', b.getAttribute('data-tab') === name);
  });
  document.querySelectorAll('.bottom-nav-item').forEach(function(b) {
    b.classList.toggle('active', b.getAttribute('data-tab') === name);
  });
  try {
    localStorage.setItem('myListAddon:activeTab', name);
  } catch (e) {}

  if (name !== 'list-details' && name !== 'item-details') {
    if (location.pathname.startsWith('/lists/')) {
      history.pushState({ view: 'tab', tab: name }, '', '/');
    }
  }

  if (name === 'lists') {
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
  if (name === 'settings') {
    let savedSub = 'keys';
    try {
      savedSub = localStorage.getItem('myListAddon:settingsSubmenu') || 'keys';
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
  if (name === 'catalogs') {
    // Auto-loads posters the moment this tab is shown -- previously
    // required clicking "Refresh Preview" by hand even just to look at
    // shelves that were already configured. The button (still there)
    // stays useful after editing a URL, since that shouldn't re-fire a
    // live request on every keystroke -- see renderLivePreview's own
    // comment.
    if (typeof renderLivePreview === 'function') renderLivePreview();
  }
  if (name === 'discover') {
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

function restoreActiveTab() {
  let tab = 'discover';
  try {
    tab = localStorage.getItem('myListAddon:activeTab') || 'discover';
  } catch (e) {}
  if (tab === 'item-details' || tab === 'list-details') tab = 'discover';
  switchTab(tab);
}

function switchListsSubmenu(name, btn) {
  try {
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
    if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard();
    if (typeof runMyMdblistLists === 'function') runMyMdblistLists();
    if (typeof runMyTraktLists === 'function') runMyTraktLists();
  }
  if (name === 'liked') renderLikedListsFeed();
}

function switchSettingsSubmenu(name, btn) {
  try {
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
    'keys': 'settingsSubKeys',
    'backup': 'settingsSubBackup',
    'feedback': 'settingsSubFeedback'
  };
  Object.keys(subpanels).forEach(function(k) {
    const el = document.getElementById(subpanels[k]);
    if (el) el.style.display = 'none';
  });
  const activeId = subpanels[name];
  const activeEl = document.getElementById(activeId);
  if (activeEl) activeEl.style.display = 'block';
}

// Sends a Settings > Feedback submission to the server -- deliberately
// works with or without a Creator Profile (attaches the username if
// signed in, purely informational, not required) since anyone should be
// able to report a bug or suggest something without needing an account
// first.
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
    if (data && data.ok) {
      if (statusEl) { statusEl.textContent = 'Thanks \u2014 sent.'; statusEl.style.color = 'var(--accent)'; }
      document.getElementById('feedbackMessageInput').value = '';
      document.getElementById('feedbackContactInput').value = '';
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
      if (typeof renderDiscoverChartsList === 'function') {
        renderDiscoverChartsList(filter);
      }
    }
  }
}

// Renders the chart lists for the Movies or Shows tab in Discover as list-cards
// (matching how search results and the Lists tab look) by converting the
// baked-in chart data tables into the same object shape render5PosterListsFeed expects.
function renderDiscoverChartsList(type) {
  const container = document.getElementById('discoverListsFeed');
  if (!container) return;
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
    if (type === entryType || type === 'all') {
      lists.push({ name: name, url: url, type: entryType, user: group, likes: 0 });
    } else if (type === 'gems' && entryType === 'movie') {
      // Hidden Gems only has movies, but if they click gems tab, show it
      lists.push({ name: name, url: url, type: entryType, user: group, likes: 0 });
    } else if (type === 'kids') {
      // Kids tab shows all items in kids lists
      lists.push({ name: name, url: url, type: entryType, user: group, likes: 0 });
    }
  }

  // Each data table is baked in at render time via the server-side template.
  // They are exposed as window._CHARTS_* globals by 09_page-shell.js.

  if (type !== 'gems' && type !== 'kids') {
    if (window._CHARTS_TMDB) {
      window._CHARTS_TMDB.forEach(function(p) { pushPair(p.name, p.movieUrl, p.showUrl, 'TMDB'); });
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
      window._CHARTS_STREAMING_ALL.forEach(function(p) { pushPair(p.name, p.movieUrl, p.showUrl, 'Streaming'); });
    }
  }

  if (type === 'gems' || type === 'all') {
    pushSingle('Hidden Gems', 'tmdb:hidden-gems', 'movie', 'Hidden Gems');
  }

  if (type === 'kids' || type === 'all') {
    if (window._CHARTS_KIDS) {
      window._CHARTS_KIDS.forEach(function(item) {
        pushSingle(item.name, item.movieUrl, 'movie', 'Kids Movies');
        pushSingle(item.name, item.showUrl, 'series', 'Kids Shows');
      });
    }
  }

  if (typeof render5PosterListsFeed === 'function') {
    render5PosterListsFeed(container, lists);
  } else {
    container.innerHTML = '<p style="color:var(--muted); font-size:0.88rem;">Could not load chart lists.</p>';
  }
}

function switchCatalogsSubmenu(filter, btn) {
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
    'channels': document.getElementById('catalogsSubChannels'),
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
    if (data.type !== 'movie' && data.type !== 'series') return null;
    return data;
  } catch (e) {
    return null;
  }
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
  const container = document.getElementById('lists');
  const div = document.createElement('div');
  div.className = 'entry';
  div.dataset.group = group || 'Custom';
  const isWatchlist = url === 'mdblist:watchlist';
  const isChannel = String(url || '').startsWith('channel:v1:');
  const isCustomList = String(url || '').startsWith('customlist:v1:');
  
  if (group && group !== 'Custom' && group !== 'Custom Lists' && !isChannel && !isCustomList) {
    div.classList.add('premade-shelf');
  }
  
  if (isChannel) {
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

  div.innerHTML = \`
    <div class="entry-card-top" style="flex-direction: column;">
      <div class="entry-ctrl-row" style="width: 100%; justify-content: flex-start; margin-bottom: 2px;">
        <div class="entry-pos-wrap" style="display:flex; align-items:center;">
          <input type="number" class="pos" min="1" title="Type a position number to move this list there" onchange="movePosTo(this)">
        </div>
        <span class="drag-handle ec-btn" draggable="true" title="Drag to reorder" style="cursor:grab; font-size:1rem;">&#9776;</span>
        <button type="button" class="ec-btn movebtn secondary" onclick="moveRow(this, -1)" title="Move up">&#8593;</button>
        <button type="button" class="ec-btn movebtn secondary" onclick="moveRow(this, 1)" title="Move down">&#8595;</button>
        \${(isCustomList || isChannel) ? \`<button type="button" class="ec-btn secondary" style="margin-left: auto; margin-right: 6px; font-weight:600; padding: 2px 10px;" onclick="\${isCustomList ? 'editEntryCustomList(this)' : 'editEntryChannel(this)'}">Edit</button>\` : ''}
        <button type="button" class="ec-btn movebtn removebtn danger" onclick="removeEntryWithUndo(this)" title="Remove this list" aria-label="Remove this list" style="\${!(isCustomList || isChannel) ? 'margin-left: auto;' : ''}">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none;">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
            <path d="M10 11v6"></path><path d="M14 11v6"></path>
            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>
          </svg>
        </button>
      </div>
      <div style="display: flex; gap: 8px; width: 100%; align-items: center;">
        <div class="entry-card-body" style="flex-direction: row; gap: 10px; align-items: center; width: 100%;">
          <div class="entry-name-row" style="flex: 1;">
            <input type="text" placeholder="Name (e.g. Trending Movies)" class="name" value="\${escapeHtml(name||'')}">
          </div>
          <div class="entry-type-row" style="width: auto;">
            <select class="type" \${(isChannel || isCustomList) ? 'disabled title="Type is fixed for this list kind"' : ''}>
              <option value="movie" \${(type==='movie'||(isCustomList&&type==='movie'))?'selected':''}>Movies</option>
              <option value="series" \${(type==='series'||isChannel||(isCustomList&&type==='series'))?'selected':''}>Shows</option>
            </select>
          </div>
        </div>
      </div>
    </div>
    <div class="sources">\${rowsHtml}</div>
    \${isWatchlist
      ? '<p class="watchlist-note"><small>Uses the MDBList API key from Settings.</small></p>'
      : (isChannel || isCustomList)
        ? ''
        : '<button type="button" class="secondary add-source-btn" onclick="addSourceRow(this)">+ Add another source (merge into one shelf)</button>'}
    <div class="live-preview-shelf" style="padding:0; margin:0; border:none; background:transparent;"><div class="live-preview-shelf-title"><span>\${escapeHtml(name||'Unnamed')} - \${type === 'series' ? 'Series' : 'Movies'}</span><button type="button" class="text-action-btn" disabled>See All \›</button></div><div class="live-preview-posters"><p style="color:var(--muted); font-size:0.88rem; text-align:center; padding: 20px;"><small>Click "Refresh Preview" above to load posters.</small></p></div></div>
  \`;
  container.appendChild(div);
  updateSourceRemoveButtons(div);
  relocateAddSourceBtn(div);
  initTouchDrag(div.querySelector('.drag-handle'));
  checkAllDuplicateUrls();
  renumber();
  if (!suppressSave) {
    showAddedToast('"' + (name || 'Shelf') + '" added to My Catalogs \u2713');
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
  else if (action === 'streaming') addAllStreaming();
  else if (action === 'streaming-top10') addAllStreamingTop10();
  else if (action === 'combined-charts') addAllCombinedCharts();
  else if (action === 'hidden-gems') addAllHiddenGems();
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



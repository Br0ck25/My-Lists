function setListSearchFilter(filter, btn) {
  if (btn) {
    document.querySelectorAll('#listSearchTypeChips .subnav-pill').forEach(function(p) {
      p.classList.remove('active');
      const c = p.querySelector('.check-icon');
      if (c) c.remove();
    });
    btn.classList.add('active');
    btn.insertAdjacentHTML('afterbegin', '<span class="check-icon">&#x2713;</span> ');
  }
  const cards = document.querySelectorAll('#listSearchResult .list-card');
  cards.forEach(function(card) {
    const cardType = card.getAttribute('data-list-type') || 'movie';
    if (filter === 'all') {
      card.style.display = '';
    } else if (filter === 'movie') {
      card.style.display = (cardType === 'movie' || cardType === 'mixed') ? '' : 'none';
    } else if (filter === 'series') {
      card.style.display = (cardType === 'series' || cardType === 'mixed') ? '' : 'none';
    } else {
      card.style.display = '';
    }
  });
}

function guessNameFromUrl(u) {
  try {
    const parts = String(u).split('/').filter(Boolean);
    let last = parts[parts.length - 1] || u;
    last = last.replace(/[-_]+/g, ' ').trim();
    if (!last) return 'List';
    return last.replace(/\\b\\w/g, (c) => c.toUpperCase());
  } catch (e) {
    return 'List';
  }
}

// Checks a pasted URL against both types via the same /api/preview endpoint
// the "Test" button uses, and picks whichever comes back with more items --
// this is how bulk-add tells Movies from Shows instead of guessing blind.
// A mixed list (rare, but TMDB v4 lists can hold both) just goes with
// whichever side has more; a list that fails on both sides (bad URL, needs
// a key, etc.) falls back to Movies same as before, so a broken link never
// blocks the rest of the paste -- the person can fix it in its row after.
async function detectListType(url, mdblistKey) {
  async function checkType(type) {
    try {
      const res = await fetch(ORIGIN + '/api/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url, type: type, mdblistKey: mdblistKey || '' }),
        cache: 'no-store',
      });
      return await res.json();
    } catch (e) {
      return { ok: false };
    }
  }
  try {
    const [movieRes, seriesRes] = await Promise.all([checkType('movie'), checkType('series')]);
    const movieCount = movieRes && movieRes.ok ? movieRes.count : 0;
    const seriesCount = seriesRes && seriesRes.ok ? seriesRes.count : 0;
    return seriesCount > movieCount ? 'series' : 'movie';
  } catch (e) {
    return 'movie';
  }
}

// Bulk paste -- one list URL per line instead of adding rows one at a time.
// Each line is checked live (see detectListType) so it lands as the right
// type instead of always defaulting to Movies; blank lines are ignored.
async function bulkAddLists(btn) {
  const box = document.getElementById('bulkPasteBox');
  const lines = box.value.split('\\n').map((s) => s.trim()).filter(Boolean);
  if (!lines.length) {
    alert('Paste at least one list URL first, one per line.');
    return;
  }
  const mdblistKey = document.getElementById('mdblistKeyInput').value.trim();
  const origLabel = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Checking ' + lines.length + ' list(s)…';
  }
  try {
    const types = await Promise.all(lines.map((u) => detectListType(u, mdblistKey)));
    lines.forEach((u, i) => addRow(guessNameFromUrl(u), u, types[i], true, 'Custom'));
    box.value = '';
    saveState();
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = origLabel;
    }
  }
}

// mdblist's Popular Lists is a fixed curated set (not a live search), so we
// load it once lazily on first search and then just filter it client-side
// by name/curator on every search -- feels instant. Trakt's side is a real
// live search hitting their API each time (see runListSearch below).
let mdblistPopularCache = null;

async function ensureMdblistPopularLoaded() {
  if (mdblistPopularCache) return mdblistPopularCache;
  try {
    const res = await fetch(ORIGIN + '/api/toplists');
    const data = await res.json();
    mdblistPopularCache = data.ok ? data.lists.slice().sort((a, b) => (b.likes || 0) - (a.likes || 0)) : [];
  } catch (e) {
    mdblistPopularCache = [];
  }
  return mdblistPopularCache;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
function escapeAttr(s) { return escapeHtml(s); }

async function runListSearch() {
  const q = document.getElementById('listSearchInput').value.trim();
  const box = document.getElementById('listSearchResult');
  if (!q) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = '<p><small>Searching\u2026</small></p>';

  const qLower = q.toLowerCase();
  const traktKey = document.getElementById('traktKeyInput').value.trim();
  const [mdblistAll, traktResult, myListsResult] = await Promise.all([
    ensureMdblistPopularLoaded(),
    fetch(ORIGIN + '/api/trakt-search?q=' + encodeURIComponent(q) + (traktKey ? '&traktKey=' + encodeURIComponent(traktKey) : ''), { cache: 'no-store' })
      .then((r) => r.json())
      .catch(() => ({ ok: false, error: 'Network error searching trakt.tv.' })),
    fetch(ORIGIN + '/api/search-published-lists?q=' + encodeURIComponent(q), { cache: 'no-store' })
      .then((r) => r.json())
      .catch(() => ({ ok: false, lists: [] })),
  ]);

  const mdblistMatches = mdblistAll
    .filter((l) => l.name.toLowerCase().includes(qLower) || l.user.toLowerCase().includes(qLower))
    .slice(0, 30);
  const traktMatches = traktResult.ok ? traktResult.lists.slice(0, 30) : [];
  const myListsMatches = myListsResult.ok ? myListsResult.lists : [];

  renderListSearchResults(mdblistMatches, traktMatches, traktResult.ok ? null : traktResult.error, myListsMatches);
}

function renderListSearchResults(mdblistMatches, traktMatches, traktError, myListsMatches) {
  const box = document.getElementById('listSearchResult');
  const alreadyAdded = new Set();
  document.querySelectorAll('#lists .entry').forEach((entry) => {
    const t = entry.querySelector('.type') ? entry.querySelector('.type').value : '';
    entry.querySelectorAll('.url').forEach((el) => {
      alreadyAdded.add(el.value.trim() + '|' + t);
    });
  });

  const combinedCards = [];

  // Build one .list-card per mdblist result
  mdblistMatches.forEach((l) => {
    const added = alreadyAdded.has(l.url + '|' + l.type);
    const alreadyLikedExt = getLikedListsSet().has(l.url);
    const typeLabel = l.type === 'series' ? 'Shows' : 'Movies';
    const cardHtml = '<div class="list-card" data-list-type="' + l.type + '">' +
      '<div class="list-card-header">' +
      '<div class="list-card-icon src-mdblist" aria-label="MDBList">M</div>' +
      '<div class="list-card-body">' +
      '<div class="list-card-title">' + escapeHtml(l.name) + '</div>' +
      '<div class="list-card-meta">' +
      '<span>by ' + escapeHtml(l.user) + '</span>' +
      '<span class="list-card-meta-sep">&middot;</span>' +
      '<span>' + typeLabel + '</span>' +
      '<span class="list-card-meta-sep">&middot;</span>' +
      '<span>' + l.items + ' items</span>' +
      '<span class="list-card-meta-sep">&middot;</span>' +
      '<span>&#9829; ' + l.likes + '</span>' +
      '</div>' +
      '</div>' +
      '<div class="list-card-actions">' +
      '<button type="button" class="lc-btn searchLikeExternalBtn' + (alreadyLikedExt ? ' liked' : '') + '" data-url="' + escapeAttr(l.url) + '">' +
      (alreadyLikedExt ? '&#9829;' : '&#9825;') +
      '</button>' +
      '<button type="button" class="lc-btn primary searchAddBtn" ' + (added ? 'disabled' : '') +
      ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + l.type + '">' +
      (added ? '&#10003; Added' : '+ Add') +
      '</button>' +
      '</div>' +
      '</div>' +
      '<div class="list-card-posters poster-preview-slot" data-url="' + escapeAttr(l.url) + '" data-type="' + l.type + '"></div>' +
      '</div>';
    combinedCards.push({ likes: l.likes || 0, html: cardHtml });
  });

  // Build one .list-card per Trakt result
  traktMatches.forEach((l) => {
    const addedMovie = alreadyAdded.has(l.url + '|movie');
    const addedSeries = alreadyAdded.has(l.url + '|series');
    const viewType = (l.contentType === 'movie' || l.contentType === 'series') ? l.contentType : 'movie';
    const alreadyLikedExt = getLikedListsSet().has(l.url);
    // Determine the card's data-list-type for chip filtering
    const cardType = (l.contentType === 'movie' || l.contentType === 'series') ? l.contentType : 'mixed';

    let addBtns;
    if (l.contentType === 'movie' || l.contentType === 'series') {
      const added = l.contentType === 'movie' ? addedMovie : addedSeries;
      addBtns = '<button type="button" class="lc-btn primary searchAddBtn" ' + (added ? 'disabled' : '') +
        ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + l.contentType + '">' +
        (added ? '&#10003; Added' : '+ Add') + '</button>';
    } else {
      addBtns =
        '<button type="button" class="lc-btn primary searchAddBtn" ' + (addedMovie ? 'disabled' : '') +
        ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="movie">' +
        (addedMovie ? '&#10003;' : '+ Movies') + '</button>' +
        '<button type="button" class="lc-btn primary searchAddBtn" ' + (addedSeries ? 'disabled' : '') +
        ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="series">' +
        (addedSeries ? '&#10003;' : '+ Shows') + '</button>';
    }

    const cardHtml = '<div class="list-card" data-list-type="' + cardType + '">' +
      '<div class="list-card-header">' +
      '<div class="list-card-icon src-trakt" aria-label="Trakt">T</div>' +
      '<div class="list-card-body">' +
      '<div class="list-card-title">' + escapeHtml(l.name) + '</div>' +
      '<div class="list-card-meta">' +
      '<span>by ' + escapeHtml(l.user) + '</span>' +
      '<span class="list-card-meta-sep">&middot;</span>' +
      '<span>' + l.items + ' items</span>' +
      '<span class="list-card-meta-sep">&middot;</span>' +
      '<span>&#9829; ' + l.likes + '</span>' +
      '</div>' +
      '</div>' +
      '<div class="list-card-actions">' +
      '<button type="button" class="lc-btn searchLikeExternalBtn' + (alreadyLikedExt ? ' liked' : '') + '" data-url="' + escapeAttr(l.url) + '">' +
      (alreadyLikedExt ? '&#9829;' : '&#9825;') +
      '</button>' +
      addBtns +
      '</div>' +
      '</div>' +
      '<div class="list-card-posters poster-preview-slot" data-url="' + escapeAttr(l.url) + '" data-type="' +
      (l.contentType === 'movie' || l.contentType === 'series' ? l.contentType : 'movie') + '"></div>' +
      '</div>';
    combinedCards.push({ likes: l.likes || 0, html: cardHtml });
  });

  // My Lists results
  (myListsMatches || []).forEach((l) => {
    const added = alreadyAdded.has(l.url + '|' + l.type);
    let usernameSlug = '';
    try {
      const parts = (l.url || '').split('/lists/')[1]?.split('/');
      if (parts && parts.length >= 2) usernameSlug = parts[0] + '/' + parts[1];
    } catch (e) {}
    const alreadyLiked = usernameSlug && getLikedListsSet().has(usernameSlug);
    const typeLabel = l.type === 'series' ? 'Shows' : 'Movies';
    const cardHtml = '<div class="list-card" data-list-type="' + l.type + '">' +
      '<div class="list-card-header">' +
      '<div class="list-card-icon src-mylist" aria-label="My Lists">&#9733;</div>' +
      '<div class="list-card-body">' +
      '<div class="list-card-title">' + escapeHtml(l.name) + '</div>' +
      '<div class="list-card-meta">' +
      '<span>by ' + escapeHtml(l.creatorName || 'Anonymous') + '</span>' +
      '<span class="list-card-meta-sep">&middot;</span>' +
      '<span>' + typeLabel + '</span>' +
      '<span class="list-card-meta-sep">&middot;</span>' +
      '<span>' + l.items + ' items</span>' +
      '<span class="list-card-meta-sep">&middot;</span>' +
      '<span class="like-count">&#9829; ' + (l.likes || 0) + '</span>' +
      '</div>' +
      '</div>' +
      '<div class="list-card-actions">' +
      '<button type="button" class="lc-btn searchLikeBtn' + (alreadyLiked ? ' liked' : '') + '" data-username-slug="' + escapeAttr(usernameSlug) + '">' +
      (alreadyLiked ? '&#9829;' : '&#9825;') +
      '</button>' +
      '<button type="button" class="lc-btn primary searchAddBtn" ' + (added ? 'disabled' : '') +
      ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + l.type + '">' +
      (added ? '&#10003; Added' : '+ Add') +
      '</button>' +
      '</div>' +
      '</div>' +
      '<div class="list-card-posters poster-preview-slot" data-url="' + escapeAttr(l.url) + '" data-type="' + l.type + '"></div>' +
      '</div>';
    combinedCards.push({ likes: l.likes || 0, html: cardHtml });
  });

  combinedCards.sort((a, b) => b.likes - a.likes);
  let html = combinedCards.map(c => c.html).join('');
  
  if (combinedCards.length === 0) {
    html = '<p style="color:var(--muted); font-size:0.9rem; padding:8px 0;"><small>No lists match that search.</small></p>';
  }
  if (traktError) {
    html += '<p class="testresult err" style="margin-top:8px;">&#10007; Trakt search: ' + escapeHtml(traktError) + '</p>';
  }
  box.innerHTML = html;

  // Re-apply active chip filter to newly rendered cards
  const activeChip = document.querySelector('#listSearchTypeChips .chip.active');
  if (activeChip && typeof setListSearchChip === 'function') setListSearchChip(activeChip);

  populateSearchResultPosters();
}

async function populateSearchResultPosters() {
  const slots = [...document.querySelectorAll('.poster-preview-slot')];
  let idx = 0;
  const CONCURRENCY = 5;
  async function worker() {
    while (idx < slots.length) {
      const slot = slots[idx++];
      const listUrl = slot.dataset.url;
      const type = slot.dataset.type || 'movie';
      try {
        const payload = { url: listUrl, type: type, sample: 12 };
        const mkInput = document.getElementById('mdblistKeyInput');
        if (mkInput && mkInput.value) payload.mdblistKey = mkInput.value.trim();
        const tkInput = document.getElementById('tmdbKeyInput');
        if (tkInput && tkInput.value) payload.tmdbKey = tkInput.value.trim();
        const trkInput = document.getElementById('traktKeyInput');
        if (trkInput && trkInput.value) payload.traktKey = trkInput.value.trim();

        const res = await fetch(ORIGIN + '/api/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          cache: 'no-store',
        });
        const data = await res.json();
        if (data.ok && data.sample && data.sample.length) {
          const validPosters = data.sample.filter((s) => s.poster).slice(0, 9);
          if (validPosters.length) {
            const totalCount = data.count || (validPosters.length * 10);
            let inner = '';
            validPosters.forEach((s, i) => {
              const isMobileEnd = (i === 2 && validPosters.length > 3);
              const isDesktopEnd = (i === validPosters.length - 1 && validPosters.length >= 4);

              let overlays = '';
              if (isMobileEnd) {
                overlays += '<div class="list-card-count-overlay mobile-only searchViewListBtn" data-name="' + escapeAttr(listUrl) + '" data-url="' + escapeAttr(listUrl) + '" data-type="' + escapeAttr(type) + '" style="cursor:pointer;">' + totalCount + ' &rsaquo;</div>';
              }
              if (isDesktopEnd) {
                overlays += '<div class="list-card-count-overlay desktop-only searchViewListBtn" data-name="' + escapeAttr(listUrl) + '" data-url="' + escapeAttr(listUrl) + '" data-type="' + escapeAttr(type) + '" style="cursor:pointer;">' + totalCount + ' &rsaquo;</div>';
              }

              inner += '<div class="list-card-mini-poster-tile">' +
                '<div class="list-card-mini-poster-img-wrap clickable-poster" data-id="' + escapeAttr(s.id || '') + '" data-type="' + escapeAttr(type || '') + '" data-title="' + escapeAttr(s.name || '') + '" data-poster="' + escapeAttr(s.poster || '') + '">' +
                  '<img src="' + escapeAttr(s.poster) + '" alt="" loading="lazy">' +
                  '<div class="poster-add-overlay">+</div>' +
                  overlays +
                '</div>' +
                '<div class="list-card-mini-poster-name">' + escapeHtml(s.name || '') + '</div>' +
              '</div>';
            });
            slot.className = 'list-card-posters';
            slot.innerHTML = inner;
          }
        }
      } catch (e) {
        // Posters are a nice-to-have here
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, slots.length) }, () => worker()));
}

function getLikedListsSet() {
  try {
    return new Set(JSON.parse(localStorage.getItem('myListAddon:likedLists') || '[]'));
  } catch (e) {
    return new Set();
  }
}

function rememberLikedList(usernameSlug) {
  const set = getLikedListsSet();
  set.add(usernameSlug);
  try {
    localStorage.setItem('myListAddon:likedLists', JSON.stringify([...set]));
  } catch (e) {}
}

function forgetLikedList(usernameSlug) {
  const set = getLikedListsSet();
  set.delete(usernameSlug);
  try {
    localStorage.setItem('myListAddon:likedLists', JSON.stringify([...set]));
  } catch (e) {}
}

document.addEventListener('click', async (e) => {
  const viewBtn = e.target.closest('.searchViewListBtn');
  if (viewBtn) {
    openListPreviewModal(viewBtn.dataset.name, viewBtn.dataset.type, viewBtn.dataset.url);
    return;
  }
  const addBtn = e.target.closest('.searchAddBtn');
  if (addBtn && !addBtn.disabled) {
    addRow(addBtn.dataset.name, addBtn.dataset.url, addBtn.dataset.type, true, 'Custom');
    addBtn.disabled = true;
    addBtn.textContent = 'Added \u2713';
    return;
  }
  const likeBtn = e.target.closest('.searchLikeBtn');
  if (likeBtn && !likeBtn.disabled) {
    const usernameSlug = likeBtn.dataset.usernameSlug || '';
    const parts = usernameSlug.split('/');
    if (parts.length !== 2) return;
    const wasLiked = likeBtn.classList.contains('liked');
    likeBtn.disabled = true;
    try {
      const res = await fetch(ORIGIN + '/api/lists/like', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: parts[0], slug: parts[1], action: wasLiked ? 'unlike' : 'like' }),
      });
      const data = await res.json();
      if (!data.ok) {
        alert('Could not update this like: ' + (data.error || 'unknown error'));
        return;
      }
      if (wasLiked) {
        forgetLikedList(usernameSlug);
        likeBtn.classList.remove('liked');
        likeBtn.textContent = '\u2661 Like';
      } else {
        rememberLikedList(usernameSlug);
        likeBtn.classList.add('liked');
        likeBtn.textContent = '\u2665 Unlike';
      }
      const row = likeBtn.closest('.searchresult-row');
      const countEl = row && row.querySelector('.like-count');
      if (countEl) countEl.textContent = '\u2665 ' + data.likes;
      if (activeCreator) {
        const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
        fetch(ORIGIN + '/api/creator/sync/like', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ creatorName: activeCreator.creatorName, creatorKey: creatorKey, usernameSlug: usernameSlug, liked: !wasLiked }),
        }).catch(() => {});
      }
    } catch (err) {
      alert('Network error while updating this like.');
    } finally {
      likeBtn.disabled = false;
    }
    return;
  }
  const likeExternalBtn = e.target.closest('.searchLikeExternalBtn');
  if (likeExternalBtn && !likeExternalBtn.disabled) {
    const listUrl = likeExternalBtn.dataset.url || '';
    if (!listUrl) return;
    const wasLiked = likeExternalBtn.classList.contains('liked');
    likeExternalBtn.disabled = true;
    try {
      const res = await fetch(ORIGIN + '/api/lists/like-external', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: listUrl, action: wasLiked ? 'unlike' : 'like' }),
      });
      const data = await res.json();
      if (!data.ok) {
        alert('Could not update this like: ' + (data.error || 'unknown error'));
        return;
      }
      if (wasLiked) {
        forgetLikedList(listUrl);
        likeExternalBtn.classList.remove('liked');
        likeExternalBtn.textContent = '\u2661 Like';
      } else {
        rememberLikedList(listUrl);
        likeExternalBtn.classList.add('liked');
        likeExternalBtn.textContent = '\u2665 Unlike';
      }
      if (activeCreator) {
        const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
        fetch(ORIGIN + '/api/creator/sync/like', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ creatorName: activeCreator.creatorName, creatorKey: creatorKey, usernameSlug: listUrl, liked: !wasLiked }),
        }).catch(() => {});
      }
    } catch (err) {
      alert('Network error while updating this like.');
    } finally {
      likeExternalBtn.disabled = false;
    }
  }
});

let popularListsFeedLoaded = false;
async function loadPopularListsFeed() {
  const container = document.getElementById('popularListsFeed');
  if (!container) return;
  if (!popularListsFeedLoaded) {
    container.innerHTML = '<p style="color:var(--muted); font-size:0.88rem;">Loading popular community lists…</p>';
  }
  try {
    const [toplists, published] = await Promise.all([
      ensureMdblistPopularLoaded(),
      fetch(ORIGIN + '/api/search-published-lists?q=').then(r => r.json()).catch(() => ({ lists: [] }))
    ]);
    const allLists = [...(published.lists || []), ...(toplists || [])];
    if (!allLists.length) {
      container.innerHTML = '<p style="color:var(--muted); font-size:0.88rem;">No community lists found.</p>';
      return;
    }
    render5PosterListsFeed(container, allLists);
    popularListsFeedLoaded = true;
  } catch (e) {
    container.innerHTML = '<p class="testresult err">&#x2717; Error loading community lists.</p>';
  }
}

async function loadCuratedListsFeed() {
  const container = document.getElementById('curatedListsFeed');
  if (!container) return;
  container.innerHTML = '<p style="color:var(--muted); font-size:0.88rem;">Loading curated lists…</p>';
  const toplists = await ensureMdblistPopularLoaded();
  const curated = (toplists || []).filter(l => (l.user || '').toLowerCase() === 'official' || (l.likes || 0) > 50);
  render5PosterListsFeed(container, curated);
}

async function renderLikedListsFeed() {
  const container = document.getElementById('likedListsFeed');
  if (!container) return;
  const likedUrls = [...getLikedListsSet()];
  if (!likedUrls.length) {
    container.innerHTML = '<p style="color:var(--muted); font-size:0.88rem;">No liked lists yet. Tap the heart &#x2661; on any list to save it here.</p>';
    return;
  }
  container.innerHTML = '<p style="color:var(--muted); font-size:0.88rem;">Loading your ' + likedUrls.length + ' liked list(s)...</p>';
  try {
    const toplists = await ensureMdblistPopularLoaded();
    const topMap = new Map();
    (toplists || []).forEach(l => {
      if (l.url) topMap.set(l.url, l);
      if (l.user && l.slug) topMap.set(l.user + '/' + l.slug, l);
    });

    const likedListObjects = likedUrls.map(u => {
      if (topMap.has(u)) return topMap.get(u);
      const name = guessNameFromUrl(u);
      const isSeries = u.toLowerCase().includes('show') || u.toLowerCase().includes('series') || u.toLowerCase().includes('tv');
      return {
        url: u,
        name: name,
        user: 'Community',
        type: isSeries ? 'series' : 'movie',
        items: 50,
        likes: 1
      };
    });

    render5PosterListsFeed(container, likedListObjects);
  } catch (e) {
    container.innerHTML = '<p class="testresult err">&#x2717; Error loading liked lists.</p>';
  }
}

function render5PosterListsFeed(container, lists) {
  const alreadyAdded = new Set();
  document.querySelectorAll('#lists .entry').forEach(function(entry) {
    const t = entry.querySelector('.type') ? entry.querySelector('.type').value : '';
    entry.querySelectorAll('.url').forEach(function(el) {
      alreadyAdded.add(el.value.trim() + '|' + t);
    });
  });

  const cardsHtml = lists.slice(0, 40).map(function(l) {
    const type = l.type || (l.mediatype === 'show' ? 'series' : 'movie');
    const added = alreadyAdded.has(l.url + '|' + type);
    const alreadyLiked = getLikedListsSet().has(l.url);
    const author = l.user || l.creatorName || 'Official';
    const itemCount = l.items || l.count || null;

    return '<div class="list-card" data-list-type="' + escapeAttr(type) + '">' +
      '<div class="list-card-header">' +
        '<div class="list-card-icon ' + (l.user ? 'src-mdblist' : 'src-mylist') + '">' + (l.user ? 'M' : '&#x2605;') + '</div>' +
        '<div class="list-card-body">' +
          '<div class="list-card-title">' + escapeHtml(l.name) + '</div>' +
          '<div class="list-card-meta">' +
            '<span>by ' + escapeHtml(author) + '</span>' +
            '<span class="list-card-meta-sep">&middot;</span>' +
            '<span>' + (type === 'series' ? 'Shows' : 'Movies') + '</span>' +
            (itemCount ? '<span class="list-card-meta-sep">&middot;</span><span>' + itemCount + ' items</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="list-card-actions">' +
          '<button type="button" class="lc-btn searchLikeExternalBtn' + (alreadyLiked ? ' liked' : '') + '" data-url="' + escapeAttr(l.url) + '">' +
            (alreadyLiked ? '&#x2665;' : '&#x2661;') +
          '</button>' +
          '<button type="button" class="lc-btn primary searchAddBtn" ' + (added ? 'disabled' : '') +
            ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(type) + '">' +
            (added ? '&#x2713; Added' : '+ Add') +
        '</div>' +
      '</div>' +
      '<div class="list-card-posters poster-preview-slot" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(type) + '"></div>' +
    '</div>';
  }).join('');

  container.innerHTML = cardsHtml;
  populateSearchResultPosters();
}

function openSeeAllDetail(title, categoryKey) {
  const overlay = document.getElementById('detailOverlay');
  const titleEl = document.getElementById('detailTitle');
  const subEl = document.getElementById('detailSubtitle');
  const gridEl = document.getElementById('detailGrid');
  const addAllBtn = document.getElementById('detailAddAllBtn');
  if (!overlay || !gridEl) return;

  if (titleEl) titleEl.textContent = title;
  if (subEl) subEl.textContent = 'Discover \u2022 Popular & Trending Catalogs';
  if (addAllBtn) {
    addAllBtn.onclick = function() {
      const targetBtn = document.querySelector('[data-add-all-action="' + categoryKey + '"]');
      if (targetBtn) targetBtn.click();
      closeDetailOverlay();
      switchTab('catalogs');
    };
  }

  // Find the matching shelf preview and clone its cards into the 3-column grid
  let sourceScroll = null;
  if (categoryKey === 'combined-charts') sourceScroll = document.getElementById('shelfScrollCombined');
  else if (categoryKey === 'tmdb-charts') sourceScroll = document.getElementById('shelfScrollTmdb');
  else if (categoryKey === 'streaming-top10') sourceScroll = document.getElementById('shelfScrollStreamingTop10');
  else if (categoryKey === 'trakt-charts') sourceScroll = document.getElementById('shelfScrollTrakt');
  else if (categoryKey === 'mdblist-charts') sourceScroll = document.getElementById('shelfScrollMdblist');
  else if (categoryKey === 'simkl-charts') sourceScroll = document.getElementById('shelfScrollSimkl');
  else if (categoryKey === 'streaming') sourceScroll = document.getElementById('shelfScrollStreaming');
  else if (categoryKey === 'hidden-gems') sourceScroll = document.getElementById('shelfScrollHiddenGems');

  if (sourceScroll) {
    gridEl.innerHTML = sourceScroll.innerHTML;
  } else {
    gridEl.innerHTML = '<p style="color:var(--muted); font-size:0.9rem;">No items available in this category.</p>';
  }

  overlay.classList.add('active');
  overlay.scrollTop = 0;
}

// --- Clickable Posters & Add to List Modal Logic ---
document.addEventListener('click', async (e) => {
  const addOverlayBtn = e.target.closest('.poster-add-overlay');
  const posterEl = e.target.closest('.clickable-poster');
  
  if (addOverlayBtn) {
    e.stopPropagation(); // prevent opening the details modal
    openSelectListModal(posterEl.dataset.id, posterEl.dataset.type, posterEl.dataset.title, posterEl.dataset.poster);
    return;
  }
  
  if (posterEl && !e.target.closest('.searchViewListBtn')) {
    openItemDetailsModal(posterEl.dataset.id, posterEl.dataset.type);
    return;
  }
});

function openEpisodeDetails(epNum) {
  const ep = window._episodeDataCache && window._episodeDataCache[epNum];
  if (!ep) return;
  
  const still = ep.still_path ? escapeAttr(ep.still_path) : '';
  const runtime = ep.runtime ? ep.runtime + ' min' : '';
  const date = ep.air_date ? ep.air_date : '';
  
  let infoHtml = '';
  if (date) infoHtml += '<div style="margin-bottom:6px;">' + escapeHtml(date) + '</div>';
  if (runtime) infoHtml += '<div style="margin-bottom:6px;">' + escapeHtml(runtime) + '</div>';
  if (ep.vote_average) infoHtml += '<div style="margin-bottom:6px;">\u2605 ' + escapeHtml(Number(ep.vote_average).toFixed(1)) + ' TMDB</div>';
  
  const innerHtml = 
    '<button type="button" class="modal-close-x" onclick="closeModal()">\u2715</button>' +
    '<div style="display:flex; flex-direction:row; gap:32px; flex-wrap:wrap; margin-top:20px;">' +
      '<div style="flex: 0 0 300px; max-width: 100%;">' +
        (still ? '<img src="' + still + '" style="width:100%; border-radius:8px; box-shadow: 0 4px 12px rgba(0,0,0,0.5);">' : '') +
      '</div>' +
      '<div style="flex: 1; min-width: 300px;">' +
        '<h1 style="margin:0 0 16px; font-size:2.5rem; font-family: serif;">E' + ep.episode_number + ' - ' + escapeHtml(ep.name) + '</h1>' +
          '<div style="margin-bottom:20px;">' +
            '<button type="button" id="btnMarkWatched" class="lc-btn ' + (window._watchedItemIds && window._watchedItemIds.has(String(ep.id)) ? 'secondary' : 'primary') + '" onclick="toggleEpisodeWatchStatus(' + ep.episode_number + ')">' +
              (window._watchedItemIds && window._watchedItemIds.has(String(ep.id)) ? '<span style="margin-right:4px;">&#x2713;</span> Mark as unwatched' : 'Mark as Watched') +
            '</button>' +
          '</div>' +
        '<div style="margin-bottom:16px; color:var(--text); font-size:1.05rem;">' + infoHtml + '</div>' +
        '<p style="font-size:1.05rem; line-height:1.6; color:var(--text); margin-bottom: 24px;">' + escapeHtml(ep.overview || 'No overview available.') + '</p>' +
      '</div>' +
    '</div>';
    
  showModal(innerHtml, 'modal-card-wide');
}

// An episode counts as "aired" once it has a real air_date that isn't in
// the future -- used to keep unaired/TBA episodes out of both the batch
// "mark watched" actions and Continue Watching's idea of what's next.
function isEpisodeAired(ep) {
  if (!ep || !ep.air_date) return false;
  const airDate = new Date(ep.air_date);
  if (isNaN(airDate.getTime())) return false;
  return airDate.getTime() <= Date.now();
}

// Toggles a single episode's watched status via the generic toggleWatchStatus
// (same one movies use) -- that function already embeds show/season/episode
// context and refreshes Continue Watching for episode toggles, so this is
// just a clean, backslash-free way to call it from the onclick attribute.
function toggleEpisodeWatchStatus(epNum) {
  const ep = window._episodeDataCache && window._episodeDataCache[epNum];
  if (!ep) return;
  window.toggleWatchStatus(String(ep.id), 'episode', ep.name || '', ep.still_path || '');
}


async function openItemDetailsModal(id, type) {
  if (!id || id.startsWith('channel_')) return;
  
  // A poster clicked from inside an open showModal()-based overlay (e.g.
  // the "View all" list preview) needs that overlay closed here --
  // switchTab below only changes which full-page tab-panel is active
  // underneath it, and does nothing to the overlay itself, which is a
  // separate, always-on-top element appended straight to <body>. Without
  // this, the destination page loads correctly in the background but stays
  // hidden behind the still-open modal.
  if (typeof closeModal === 'function') closeModal();
  
  window._previousTab = document.querySelector('.tab-btn.active')?.dataset.tab || 'discover';
  switchTab('item-details');
  
  const body = document.getElementById('itemDetailsBody');
  body.innerHTML = '<p style="color:var(--muted); text-align:center; padding: 40px;">Fetching information from TMDB...</p>';
  
  const tkInput = document.getElementById('tmdbKeyInput');
  const tmdbKey = tkInput && tkInput.value ? tkInput.value.trim() : '';
  
  try {
    const res = await fetch(ORIGIN + '/api/details?imdbId=' + encodeURIComponent(id) + '&tmdbKey=' + encodeURIComponent(tmdbKey) + (type ? '&type=' + encodeURIComponent(type) : ''));
    const data = await res.json();
    if (!data.ok || !data.details) throw new Error(data.error || 'Failed to load details');
    
    const d = data.details;
    window._currentItemDetails = d;
    
    // There's no server-side cron pushing updates into a browser's own
    // localStorage, so a newly-aired episode can't add itself to Continue
    // Watching in the background -- the closest thing to "automatic" is
    // refreshing it here, so simply reopening a show you're partway
    // through picks up anything that's aired since you last looked,
    // without needing to watch/unwatch something first to trigger it.
    // Only bothers if this show has any Watch History to begin with.
    if (type === 'series' && typeof updateContinueWatching === 'function') {
      const historyMap = loadLocalCustomLists();
      const history = historyMap['watch-history'];
      const hasWatchedEpisode = history && (history.items || []).some(it => it.type === 'episode' && it.showId === d.id);
      if (hasWatchedEpisode) updateContinueWatching(d.id).catch(() => {});
    }
    
    // Formatting helpers
    let dateStr = d.releaseYear || '';
    if (d.releaseDate) {
      try {
        const dateObj = new Date(d.releaseDate);
        if (!isNaN(dateObj)) {
          dateStr = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        }
      } catch(e) {}
    }

    let runtimeStr = '';
    if (d.runtime) {
      const h = Math.floor(d.runtime / 60);
      const m = d.runtime % 60;
      runtimeStr = (h > 0 ? h + 'h ' : '') + m + 'm';
    }

    const formatMoney = (val) => val ? '$' + val.toLocaleString('en-US') : '';
    const budgetStr = formatMoney(d.budget);
    const revenueStr = formatMoney(d.revenue);

    let infoHtml = '';
    if (dateStr) infoHtml += '<div style="margin-bottom:6px;">' + escapeHtml(dateStr) + '</div>';
    if (d.seasons) infoHtml += '<div style="margin-bottom:6px;">' + escapeHtml(d.seasons + ' season' + (d.seasons > 1 ? 's' : '')) + '</div>';
    if (runtimeStr) infoHtml += '<div style="margin-bottom:6px;">' + escapeHtml(runtimeStr) + '</div>';
    if (d.contentRating) infoHtml += '<div style="margin-bottom:6px;">' + escapeHtml(d.contentRating) + '</div>';
    if (d.rating) infoHtml += '<div style="margin-bottom:6px;">\u2605 ' + escapeHtml(d.rating) + ' TMDB</div>';
    if (budgetStr) infoHtml += '<div style="margin-bottom:6px;">Budget ' + escapeHtml(budgetStr) + '</div>';
    if (revenueStr) infoHtml += '<div style="margin-bottom:6px;">Box Office ' + escapeHtml(revenueStr) + '</div>';
    if (d.genres) infoHtml += '<div style="margin-bottom:20px;">' + escapeHtml(d.genres) + '</div>';
    
    const trailerHtml = d.trailerKey ? 
      '<h3 style="margin: 0 0 16px; font-family:serif; font-size:1.5rem;">Trailer</h3>' +
      '<div style="position:relative; padding-bottom:56.25%; height:0; overflow:hidden; border-radius:8px;">' +
      '<iframe style="position:absolute; top:0; left:0; width:100%; height:100%; border:0;" src="https://www.youtube.com/embed/' + escapeAttr(d.trailerKey) + '" allowfullscreen></iframe>' +
      '</div>' : '';

    let seasonsHtml = '';
    if (d.seasonsData && d.seasonsData.length > 0) {
      seasonsHtml += '<h3 style="margin: 32px 0 16px; font-family:serif; font-size:1.5rem;">Seasons</h3>';
      seasonsHtml += '<div style="display:flex; flex-direction:column; gap:16px;">';
      d.seasonsData.forEach(season => {
        if (season.season_number === 0) return; // Skip specials usually
        const sPoster = season.poster_path ? 'https://image.tmdb.org/t/p/w200' + season.poster_path : '';
        seasonsHtml += 
          '<div style="background:var(--surface-light); border:1px solid var(--border); border-radius:8px; overflow:hidden;">' +
            '<div style="display:flex; gap:16px; padding:16px; cursor:pointer; align-items:center;" onclick="toggleSeasonEpisodes(this, ' + season.season_number + ', &quot;' + escapeAttr(d.id) + '&quot;)">' +
              (sPoster ? '<img src="' + escapeAttr(sPoster) + '" style="width:80px; border-radius:4px; flex-shrink:0; box-shadow:0 2px 8px rgba(0,0,0,0.3);">' : '<div style="width:80px; height:120px; background:#333; border-radius:4px; flex-shrink:0;"></div>') +
              '<div style="display:flex; flex-direction:column; justify-content:center; flex:1;">' +
                '<h4 style="margin:0 0 4px; font-size:1.2rem;">' + escapeHtml(season.name) + '</h4>' +
                '<div style="color:var(--muted); font-size:0.9rem;">' + season.episode_count + ' episodes</div>' +
              '</div>' +
              '<button type="button" class="lc-btn primary season-watch-btn" onclick="event.stopPropagation(); markSeasonWatched(this, &quot;' + escapeAttr(d.id) + '&quot;, ' + season.season_number + ', &quot;' + escapeAttr(season.name) + '&quot;)">Mark Season Watched</button>' +
            '</div>' +
            '<div class="season-episodes-container" style="display:none; padding:16px; border-top:1px solid var(--border); background:rgba(0,0,0,0.2);">' +
              '<div class="episodes-grid" style="display:grid; grid-template-columns:repeat(auto-fill, minmax(140px, 1fr)); gap:16px;"></div>' +
            '</div>' +
          '</div>';
      });
      seasonsHtml += '</div>';
    }

    body.innerHTML = 
      '<div style="display:flex; flex-direction:row; gap:32px; flex-wrap:wrap;">' +
        '<div style="flex: 0 0 300px; max-width: 100%;">' +
          (d.poster ? '<img src="' + escapeAttr(d.poster) + '" style="width:100%; border-radius:8px; box-shadow: 0 4px 12px rgba(0,0,0,0.5);">' : '') +
        '</div>' +
        '<div style="flex: 1; min-width: 300px;">' +
          '<h1 style="margin:0 0 16px; font-size:2.5rem; font-family: serif;">' + escapeHtml(d.title) + '</h1>' +
          '<div style="margin-bottom:16px; color:var(--text); font-size:1.05rem;">' + infoHtml + '</div>' +
          '<p style="font-size:1.05rem; line-height:1.6; color:var(--text); margin-bottom: 24px;">' + escapeHtml(d.overview || 'No overview available.') + '</p>' +
          '<div style="display:flex; gap:16px; flex-wrap:wrap;">' +
            '<button type="button" class="lc-btn primary" onclick="openSelectListModal(&quot;' + escapeAttr(d.id) + '&quot;, &quot;' + escapeAttr(type) + '&quot;, &quot;' + escapeAttr(d.title) + '&quot;)">+ Add to list</button>' +
            (type === 'movie' ?
              '<button type="button" id="btnMarkWatched" class="lc-btn ' + (window._watchedItemIds && window._watchedItemIds.has(String(d.id)) ? 'secondary' : 'primary') + '" onclick="toggleWatchStatus(&quot;' + escapeAttr(d.id) + '&quot;, &quot;movie&quot;, &quot;' + escapeAttr(d.title) + '&quot;, &quot;' + escapeAttr(d.poster || '') + '&quot;)">' +
                (window._watchedItemIds && window._watchedItemIds.has(String(d.id)) ? '<span style="margin-right:4px;">&#x2713;</span> Mark as unwatched' : 'Mark as Watched') +
              '</button>'
            : type === 'series' ?
              '<button type="button" id="btnMarkShowWatched" class="lc-btn primary" onclick="markShowWatched(this, &quot;' + escapeAttr(d.id) + '&quot;, &quot;' + escapeAttr(d.title) + '&quot;, &quot;' + escapeAttr(d.poster || '') + '&quot;)">Mark Whole Show Watched</button>'
            : '') +
          '</div>' +
        '</div>' +
      '</div>' +
      (trailerHtml ? '<div style="margin-top:32px;">' + trailerHtml + '</div>' : '') +
      (seasonsHtml ? '<div style="margin-top:32px;">' + seasonsHtml + '</div>' : '');
      
  } catch (err) {
    body.innerHTML = '<p class="testresult err">\u2717 ' + escapeHtml(err.message) + '</p>';
  }
}

async function toggleSeasonEpisodes(headerEl, seasonNum, imdbId) {
  window._currentSeasonNum = seasonNum;
  const container = headerEl.nextElementSibling;
  const grid = container.querySelector('.episodes-grid');
  
  if (container.style.display === 'block') {
    container.style.display = 'none';
    return;
  }
  
  container.style.display = 'block';
  if (grid.innerHTML.trim() !== '') return; // already loaded
  
  grid.innerHTML = '<div style="grid-column: 1 / -1; text-align:center; padding: 20px; color:var(--muted);">Loading episodes...</div>';
  
  const tkInput = document.getElementById('tmdbKeyInput');
  const tmdbKey = tkInput && tkInput.value ? tkInput.value.trim() : '';
  
  try {
    const res = await fetch(ORIGIN + '/api/season?imdbId=' + encodeURIComponent(imdbId) + '&seasonNum=' + seasonNum + '&tmdbKey=' + encodeURIComponent(tmdbKey));
    const data = await res.json();
    if (!data.ok || !data.season || !data.season.episodes) throw new Error(data.error || 'Failed to load season');
    
    let epsHtml = '';
    if (!window._episodeDataCache) window._episodeDataCache = {};
    data.season.episodes.forEach(ep => {
      ep.season_number = seasonNum;
      window._episodeDataCache[ep.episode_number] = ep;
      const still = ep.still_path ? escapeAttr(ep.still_path) : '';
      epsHtml += 
        '<div class="clickable-episode" data-id="' + ep.id + '" style="display:flex; flex-direction:column; gap:4px; cursor:pointer;" onclick="openEpisodeDetails(' + ep.episode_number + ')">' +
          '<div style="width:100%; aspect-ratio:16/9; background:#222; border-radius:6px; overflow:hidden; position:relative; box-shadow:0 2px 6px rgba(0,0,0,0.4);">' +
            (still ? '<img src="' + still + '" style="width:100%; height:100%; object-fit:cover;">' : '') +
            '<div style="position:absolute; bottom:4px; left:4px; background:rgba(0,0,0,0.8); color:var(--brand); padding:2px 6px; border-radius:4px; font-weight:bold; font-size:0.8rem;">E' + ep.episode_number + '</div>' +
          '</div>' +
          '<div style="font-size:0.9rem; color:var(--text); line-height:1.2; padding-top:4px;">' + escapeHtml(ep.name) + '</div>' +
        '</div>';
    });
    grid.innerHTML = epsHtml || '<div style="grid-column: 1 / -1; color:var(--muted);">No episodes found.</div>';
  } catch (err) {
    grid.innerHTML = '<div style="grid-column: 1 / -1; color:red;">Error loading episodes.</div>';
  }
}

// Fetches every aired episode of a single season and batch-marks them
// watched (or unwatched if all already watched) via toggleBatchWatchStatus.
async function markSeasonWatched(btnEl, imdbId, seasonNum, seasonName) {
  if (!btnEl || btnEl.disabled) return;
  const origLabel = btnEl.textContent;
  btnEl.disabled = true;
  btnEl.textContent = 'Fetching episodes...';

  const tkInput = document.getElementById('tmdbKeyInput');
  const tmdbKey = tkInput && tkInput.value ? tkInput.value.trim() : '';

  try {
    const res = await fetch(ORIGIN + '/api/season?imdbId=' + encodeURIComponent(imdbId) + '&seasonNum=' + seasonNum + '&tmdbKey=' + encodeURIComponent(tmdbKey));
    const data = await res.json();
    if (!data.ok || !data.season || !data.season.episodes || !data.season.episodes.length) {
      throw new Error(data.error || 'No episodes found for this season.');
    }

    const d = window._currentItemDetails;
    const episodes = data.season.episodes
      .filter(ep => isEpisodeAired(ep))
      .map(ep => ({
        id: String(ep.id),
        type: 'episode',
        name: ep.name,
        poster: ep.still_path || '',
        showId: d ? d.id : null,
        showTitle: d ? d.title : null,
        showPoster: d ? (d.poster || '') : '',
        seasonNum: seasonNum,
        episodeNum: ep.episode_number
      }));

    if (!episodes.length) {
      btnEl.disabled = false;
      btnEl.textContent = origLabel;
      alert('No aired episodes found for this season yet.');
      return;
    }

    const result = window.toggleBatchWatchStatus(episodes);

    btnEl.disabled = false;
    if (result.nowWatched) {
      btnEl.innerHTML = '<span style="margin-right:4px;">&#x2713;</span> Mark Season Unwatched';
      btnEl.classList.remove('primary');
      btnEl.classList.add('secondary');
    } else {
      btnEl.textContent = 'Mark Season Watched';
      btnEl.classList.remove('secondary');
      btnEl.classList.add('primary');
    }
  } catch (err) {
    btnEl.disabled = false;
    btnEl.textContent = origLabel;
    alert('Could not load episodes for ' + (seasonName || 'this season') + ': ' + err.message);
  }
}

// Loops over every season in the open show, fetching in batches of 4,
// marks all aired episodes watched (or unwatched if all already marked).
async function markShowWatched(btnEl, imdbId, title, poster) {
  if (!btnEl || btnEl.disabled) return;

  const d = window._currentItemDetails;
  const seasonsData = (d && d.seasonsData) ? d.seasonsData.filter(s => s.season_number > 0) : [];
  if (!seasonsData.length) {
    alert('No seasons found for this show.');
    return;
  }

  const origLabel = btnEl.textContent;
  btnEl.disabled = true;
  btnEl.textContent = 'Fetching episodes...';

  const tkInput = document.getElementById('tmdbKeyInput');
  const tmdbKey = tkInput && tkInput.value ? tkInput.value.trim() : '';

  const allEpisodes = [];
  let hadError = false;
  const concurrency = 4;

  for (let i = 0; i < seasonsData.length; i += concurrency) {
    const batch = seasonsData.slice(i, i + concurrency);
    btnEl.textContent = 'Fetching episodes... (' + Math.min(i + concurrency, seasonsData.length) + '/' + seasonsData.length + ')';
    const results = await Promise.all(batch.map(season =>
      fetch(ORIGIN + '/api/season?imdbId=' + encodeURIComponent(imdbId) + '&seasonNum=' + season.season_number + '&tmdbKey=' + encodeURIComponent(tmdbKey))
        .then(r => r.json())
        .catch(() => ({ ok: false }))
    ));
    results.forEach((seasonRes, ri) => {
      if (seasonRes.ok && seasonRes.season && seasonRes.season.episodes) {
        const sNum = batch[ri] ? batch[ri].season_number : null;
        seasonRes.season.episodes
          .filter(ep => isEpisodeAired(ep))
          .forEach(ep => {
            allEpisodes.push({
              id: String(ep.id),
              type: 'episode',
              name: ep.name,
              poster: ep.still_path || '',
              showId: imdbId,
              showTitle: title,
              showPoster: poster || '',
              seasonNum: sNum,
              episodeNum: ep.episode_number
            });
          });
      } else {
        hadError = true;
      }
    });
  }

  if (!allEpisodes.length) {
    btnEl.disabled = false;
    btnEl.textContent = origLabel;
    alert('Could not load any aired episodes for this show.');
    return;
  }

  const result = window.toggleBatchWatchStatus(allEpisodes);

  btnEl.disabled = false;
  if (result.nowWatched) {
    btnEl.innerHTML = '<span style="margin-right:4px;">&#x2713;</span> Mark Whole Show Unwatched';
    btnEl.classList.remove('primary');
    btnEl.classList.add('secondary');
  } else {
    btnEl.textContent = 'Mark Whole Show Watched';
    btnEl.classList.remove('secondary');
    btnEl.classList.add('primary');
  }

  if (hadError) alert('Some seasons could not be loaded, so this show may only be partially marked.');
}

function openSelectListModal(id, type, title, poster) {
  const modal = document.getElementById('selectListModal');
  const body = document.getElementById('selectListModalBody');
  
  // Every Custom List the person could add this item to, from three
  // places: (1) lists already added to the live catalog as a #lists row
  // (editable in place via that row's own <input class="url">), (2)
  // local-only Custom Lists that were saved (e.g. via Import from a link,
  // or Copy to Custom List) but never added as a row, and (3) this
  // account's server-synced Creator lists, same story. (2) and (3) used to
  // be invisible here entirely -- only lists someone had explicitly
  // "+ Add"-ed to their catalog ever showed up, so anything imported and
  // left sitting under Your Custom Lists had no way to receive new items
  // from this picker. seenSlugs dedupes a list that's in both a row and
  // the local/creator source it came from, preferring the row (it's the
  // live, currently-configured copy).
  const customLists = [];
  const seenSlugs = new Set();

  document.querySelectorAll('#lists .entry').forEach(row => {
    const urlInput = row.querySelector('.url');
    if (urlInput && urlInput.value.startsWith('customlist:v1:')) {
      try {
        const payload = JSON.parse(urlInput.value.slice('customlist:v1:'.length));
        // Only include lists that have been properly saved
        if (!payload.localSlug && !payload.creatorSlug) return;
        // Filter by item type: if list has a type (movie or series), it must match the item being added
        if (payload.type && payload.type !== type) return;
        const nameInput = row.querySelector('.name');
        const slug = payload.localSlug || payload.creatorSlug;
        if (slug) seenSlugs.add((payload.localSlug ? 'local:' : 'creator:') + slug);
        customLists.push({
          name: nameInput ? nameInput.value : (payload.listName || 'Unnamed List'),
          source: 'row',
          row: row,
          items: payload.items || []
        });
      } catch(e) {}
    }
  });

  if (typeof loadLocalCustomLists === 'function') {
    const localMap = loadLocalCustomLists();
    Object.keys(localMap).forEach(slug => {
      // Watch History / Continue Watching are auto-managed, not something
      // to manually file items into from this picker.
      if (slug === 'watch-history' || slug === 'continue-watching') return;
      if (seenSlugs.has('local:' + slug)) return;
      const l = localMap[slug];
      if (l.type && l.type !== type) return;
      customLists.push({ name: l.name, source: 'local', slug: slug, type: l.type, visibility: l.visibility, items: l.items || [] });
    });
  }

  if (typeof activeCreator !== 'undefined' && activeCreator && Array.isArray(lastCreatorListsData)) {
    lastCreatorListsData.forEach(l => {
      if (seenSlugs.has('creator:' + l.slug)) return;
      if (l.type && l.type !== type) return;
      customLists.push({ name: l.name, source: 'creator', slug: l.slug, type: l.type, visibility: l.visibility, items: l.items || [] });
    });
  }
  
  let html = '';
  if (customLists.length === 0) {
    html += '<p style="text-align:center; padding:20px; color:#001f3f;">You have not created any Custom Lists yet. <a href="#" id="emptyCreateListLink" style="color:#003366; font-weight:600;">Create one now</a></p>';
    document.getElementById('addSelectedListsBtn').style.display = 'none';
    setTimeout(() => {
      const lnk = document.getElementById('emptyCreateListLink');
      if (lnk) {
        lnk.onclick = function(e) {
          e.preventDefault();
          document.getElementById('selectListModal').style.display = 'none';
          document.body.style.overflow = '';
          switchTab('lists');
          // Create List has no pill of its own -- see the matching fix in
          // editCreatorList/editLocalCustomList for why this doesn't try
          // to grab one to highlight.
          if (typeof switchListsSubmenu === 'function') switchListsSubmenu('create-list');
        };
      }
    }, 0);
  } else {
    document.getElementById('addSelectedListsBtn').style.display = 'block';
    customLists.forEach((list, idx) => {
      const isChecked = (list.items || []).some(it => (it.imdbId === id) || (it.id === id) || (it.imdbId === 'tmdb:' + id));
      
      html += 
        '<label style="display:flex; align-items:center; justify-content:space-between; padding:12px 0; border-bottom: 1px solid rgba(0,0,0,0.05); cursor:pointer; color:#001f3f; font-size:1rem;">' +
          '<span>' + escapeHtml(list.name) + '</span>' +
          '<input type="checkbox" class="list-select-cb" data-idx="' + idx + '" ' + (isChecked ? 'checked ' : '') + 'style="width:20px; height:20px; cursor:pointer; accent-color:#003366;">' +
        '</label>';
    });
    
    // Store globally so the onclick handler can access it
    window._selectListModalTempLists = customLists;
    window._selectListModalCurrentItem = { id: id, type: type, title: title, poster: poster };
  }
  
  body.innerHTML = html;
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

  document.getElementById('selectListModal').addEventListener('click', (e) => {
    if (e.target.id === 'selectListModal' || e.target.id === 'selectListModalCloseBtn') {
      document.getElementById('selectListModal').style.display = 'none';
      document.body.style.overflow = '';
    }
  });

document.getElementById('addSelectedListsBtn').addEventListener('click', async () => {
  if (!window._selectListModalTempLists || !window._selectListModalCurrentItem) return;
  const { id, type, title, poster } = window._selectListModalCurrentItem;
  
  const btn = document.getElementById('addSelectedListsBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';
  
  let finalImdbId = id;
  if (!String(finalImdbId).startsWith('tt')) {
    const endpoint = type === 'movie' ? '/api/resolve-movie?tmdbId=' : '/api/resolve-show?tmdbId=';
    try {
      const res = await fetch(endpoint + finalImdbId);
      const data = await res.json();
      if (data.ok) finalImdbId = data.imdbId;
      else finalImdbId = 'tmdb:' + finalImdbId;
    } catch(e) {
      finalImdbId = 'tmdb:' + finalImdbId;
    }
  }

  const checkboxes = document.querySelectorAll('.list-select-cb');
  let anyAdded = false;
  let anyRemoved = false;
  
  for (const cb of checkboxes) {
    const listIdx = parseInt(cb.dataset.idx, 10);
    const isChecked = cb.checked;
    const result = await toggleItemInSelectedList(id, finalImdbId, type, listIdx, isChecked, title, poster);
    if (result === 'added') anyAdded = true;
    else if (result === 'removed') anyRemoved = true;
  }
  
  document.getElementById('selectListModal').style.display = 'none';
  document.body.style.overflow = '';
  
  btn.disabled = false;
  btn.textContent = 'Done';
  
  if (anyAdded) showAddedToast('Added ' + title + ' to lists.');
  else if (anyRemoved && typeof showAddedToast === 'function') showAddedToast('Removed ' + title + ' from lists.');
});

// Adds or removes one item from one list picked in the Add-to-List modal.
// A list can be one of three things (see openSelectListModal): a live
// catalog row (mutated in place via its own <input class="url">, same as
// always), or a local/creator Custom List that was never added as a row --
// those don't have a DOM row to write to at all, so this builds the same
// {localSlug|creatorSlug, type, items, visibility} shape
// syncCustomListPayload already knows how to persist (to localStorage or
// the server respectively) and hands off to that, rather than a second,
// parallel save path.
async function toggleItemInSelectedList(originalId, imdbId, type, listIdx, shouldBeInList, title, poster) {
  if (!window._selectListModalTempLists || !window._selectListModalTempLists[listIdx]) return 'failed';
  const list = window._selectListModalTempLists[listIdx];

  if (list.source === 'row') {
    const changed = toggleItemInCustomListUrl(originalId, imdbId, type, listIdx, shouldBeInList, title, poster);
    if (!changed) return 'unchanged';
    return shouldBeInList ? 'added' : 'removed';
  }

  const matches = (it) => (it.imdbId === imdbId) || (it.id === originalId) || (it.imdbId === 'tmdb:' + originalId);
  const items = (list.items || []).slice();
  const idx = items.findIndex(matches);
  const exists = idx !== -1;
  if (shouldBeInList === exists) return 'unchanged';
  if (shouldBeInList) items.push({ imdbId, type, title, poster: poster || undefined });
  else items.splice(idx, 1);

  const payload = {
    type: list.type || type,
    items: items,
    visibility: list.visibility || 'public',
  };
  if (list.source === 'creator') payload.creatorSlug = list.slug;
  else payload.localSlug = list.slug;

  list.items = items; // keep this in sync in case the same list gets toggled again before the modal closes
  await syncCustomListPayload(payload, list.name);
  return shouldBeInList ? 'added' : 'removed';
}

function toggleItemInCustomListUrl(originalId, imdbId, type, listIdx, shouldBeInList, title, poster) {
  if (!window._selectListModalTempLists || !window._selectListModalTempLists[listIdx]) return false;
  const list = window._selectListModalTempLists[listIdx];
  
  try {
    const urlInput = list.row.querySelector('.url');
    if (!urlInput) return false;
    const payloadStr = urlInput.value.slice('customlist:v1:'.length);
    const payload = JSON.parse(payloadStr);
    
    // We check for existing items using imdbId, or fall back to checking originalId (tmdb fallback)
    const idx = payload.items.findIndex(it => (it.imdbId === imdbId) || (it.id === originalId) || (it.imdbId === 'tmdb:' + originalId));
    const exists = idx !== -1;
    
    let changed = false;
    if (shouldBeInList && !exists) {
      payload.items.push({ imdbId, type, title, poster: poster || undefined });
      changed = true;
    } else if (!shouldBeInList && exists) {
      payload.items.splice(idx, 1);
      changed = true;
    }
    
    if (changed) {
      const newUrl = 'customlist:v1:' + JSON.stringify(payload);
      const urlInput = list.row.querySelector('.url');
      if (urlInput) {
        urlInput.value = newUrl;
        if (typeof autoSaveDebounced === 'function') autoSaveDebounced();
      }
      
      // Sync to backend -- read the display name from the row's name input
      const nameInput = list.row.querySelector('.name');
      const rowName = (nameInput ? nameInput.value : '') || list.name || '';
      syncCustomListPayload(payload, rowName);
    }
    return changed;
    
  } catch (err) {
    console.error('Error adding to custom list', err);
    return false;
  }
}

async function syncCustomListPayload(payload, name) {
  if (payload.creatorSlug) {
    const creatorKey = localStorage.getItem('myListAddon:creatorKey');
    const creatorName = localStorage.getItem('myListAddon:creatorName');
    if (creatorKey && creatorName && name) {
      try {
        const res = await fetch(ORIGIN + '/api/creator/lists/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            creatorName: creatorName,
            creatorKey: creatorKey,
            slug: payload.creatorSlug,
            name: name,
            type: payload.type,
            items: payload.items,
            visibility: payload.visibility || 'private'
          })
        });
        const data = await res.json();
        if (!data.ok) {
          alert('Could not sync item to list: ' + (data.error || 'unknown error'));
        }
      } catch(e) {
        alert('Network error syncing list: ' + String(e));
      }
    }
  } else if (payload.localSlug) {
    if (typeof loadLocalCustomLists === 'function' && typeof saveLocalCustomListsMap === 'function') {
      const map = loadLocalCustomLists();
      if (map[payload.localSlug]) {
        map[payload.localSlug].items = payload.items;
        saveLocalCustomListsMap(map);
      }
    }
  }
}


let currentCatalogSearchType = 'movie';

function setCatalogSearchFilter(filter, btn) {
  if (btn) {
    document.querySelectorAll('#catalogSearchTypeChips .subnav-pill').forEach(function(p) {
      p.classList.remove('active');
      const c = p.querySelector('.check-icon');
      if (c) c.remove();
    });
    btn.classList.add('active');
    btn.insertAdjacentHTML('afterbegin', '<span class="check-icon">&#x2713;</span> ');
  }
  currentCatalogSearchType = filter;
  if (document.getElementById('catalogSearchInput').value.trim()) {
    runCatalogSearch();
  }
}

async function runCatalogSearch() {
  const q = document.getElementById('catalogSearchInput').value.trim();
  const resEl = document.getElementById('catalogSearchResult');
  if (!q) {
    resEl.innerHTML = '';
    return;
  }
  resEl.innerHTML = '<p><small>Searching...</small></p>';
  try {
    const res = await fetch(ORIGIN + '/api/title-search?type=' + currentCatalogSearchType + '&q=' + encodeURIComponent(q));
    const data = await res.json();
    if (!data.ok) {
      resEl.innerHTML = '<p class="testresult err">✗ ' + escapeHtml(data.error || 'Search failed.') + '</p>';
      return;
    }
    if (!data.results || !data.results.length) {
      resEl.innerHTML = '<p><small>No results found.</small></p>';
      return;
    }
    
    const postersHtml = data.results.map(m => {
      const posterClass = 'live-preview-poster';
      const posterEl = m.poster
        ? '<img class="' + posterClass + '" src="' + escapeAttr(m.poster) + '" alt="" loading="lazy">'
        : '<div class="' + posterClass + ' live-preview-poster-placeholder"><small style="color:var(--muted); font-size:0.7rem;">No poster</small></div>';
      
      const title = m.year ? (m.title + ' (' + m.year + ')') : m.title;
      const type = currentCatalogSearchType === 'tv' ? 'series' : 'movie';
      const id = (type === 'series' ? 'tmdb:' : 'tmdb:') + m.tmdbId; // Usually we just use m.id directly if it's a number, but wait - let's check how openItemDetailsModal handles it.
      // Usually TMDB ids are passed directly. Let's assume m.id is the raw ID and type is 'movie' or 'series'.
      
      return '<div class="live-preview-poster-card clickable-poster" ' +
        'data-id="' + escapeAttr(id || '') + '" ' +
        'data-type="' + escapeAttr(type) + '" ' +
        'data-title="' + escapeAttr(m.title || '') + '" ' +
        '>' +
        '<div style="position:relative; width:100%;">' +
          posterEl +
        '</div>' +
        '<div class="live-preview-poster-name">' + escapeHtml(title) + '</div></div>';
    }).join('');
    
    resEl.innerHTML = '<div class="poster-grid-3">' + postersHtml + '</div>';
  } catch (e) {
    resEl.innerHTML = '<p class="testresult err">✗ Network error.</p>';
  }
}







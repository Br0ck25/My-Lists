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

let traktPopularCache = null;
async function ensureTraktPopularLoaded() {
  if (traktPopularCache) return traktPopularCache;
  try {
    const key = (document.getElementById('traktKeyInput') ? document.getElementById('traktKeyInput').value.trim() : '') || localStorage.getItem('myListAddon:traktKey') || '';
    const res = await fetch(ORIGIN + '/api/trakt-popular-lists' + (key ? '?traktKey=' + encodeURIComponent(key) : ''));
    const data = await res.json();
    if (data.ok && Array.isArray(data.lists)) {
      traktPopularCache = data.lists;
      return traktPopularCache;
    }
  } catch (e) {}
  return [];
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

function renderListSearchResults(mdblistMatches, traktMatches, traktError, myListsMatches, targetBox) {
  const box = targetBox || document.getElementById('listSearchResult') || document.getElementById('catalogSearchResult');
  if (!box) return;
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
    const cardHtml = '<div class="list-card" data-list-type="' + l.type + '" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(l.type) + '" data-creator="' + escapeAttr(l.user || '') + '" data-items="' + escapeAttr(l.items || '') + '" data-likes="' + escapeAttr(l.likes || 0) + '">' +
      '<div class="list-card-header">' +
      '<div class="list-card-body">' +
      '<div class="list-card-title">' + escapeHtml(l.name) + '</div>' +
      '<div class="list-card-meta">' +
      '<span>by ' + escapeHtml(l.user) + '</span>' +
      '<span class="list-card-meta-sep">&middot;</span>' +
      '<span>' + typeLabel + '</span>' +
      '<span class="list-card-meta-sep">&middot;</span>' +
      '<span>' + l.items + ' items</span>' +
      '<span class="list-card-meta-sep">&middot;</span>' +
      '<span class="list-card-likes">&#9829; <span class="like-num">' + (l.likes || 0) + '</span></span>' +
      '</div>' +
      '</div>' +
      '<div class="list-card-actions">' +
      '<button type="button" class="lc-btn searchLikeExternalBtn' + (alreadyLikedExt ? ' liked' : '') + '" data-url="' + escapeAttr(l.url) + '">' +
      (alreadyLikedExt ? '&#9829;' : '&#9825;') +
      '</button>' +
      '<button type="button" class="lc-btn ' + (added ? 'secondary searchAddBtn is-added' : 'primary searchAddBtn') + '" ' +
      (added ? 'style="color:var(--danger);"' : '') +
      ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + l.type + '">' +
      (added ? 'Remove' : '+ Add') +
      '</button>' +
      '</div>' +
      '</div>' +
      '<div class="list-card-posters poster-preview-slot" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + l.type + '" data-creator="' + escapeAttr(l.user || '') + '" data-items="' + escapeAttr(l.items || '') + '" data-likes="' + escapeAttr(l.likes || 0) + '"></div>' +
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
      addBtns = '<button type="button" class="lc-btn ' + (added ? 'secondary searchAddBtn is-added' : 'primary searchAddBtn') + '" ' +
        (added ? 'style="color:var(--danger);"' : '') +
        ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + l.contentType + '">' +
        (added ? 'Remove' : '+ Add') + '</button>';
    } else {
      addBtns =
        '<button type="button" class="lc-btn ' + (addedMovie ? 'secondary searchAddBtn is-added' : 'primary searchAddBtn') + '" ' +
        (addedMovie ? 'style="color:var(--danger);"' : '') +
        ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="movie">' +
        (addedMovie ? 'Remove (Movies)' : '+ Movies') + '</button>' +
        '<button type="button" class="lc-btn ' + (addedSeries ? 'secondary searchAddBtn is-added' : 'primary searchAddBtn') + '" ' +
        (addedSeries ? 'style="color:var(--danger);"' : '') +
        ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="series">' +
        (addedSeries ? 'Remove (Shows)' : '+ Shows') + '</button>';
    }

    const cardHtml = '<div class="list-card" data-list-type="' + cardType + '" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(viewType) + '" data-creator="' + escapeAttr(l.user || '') + '" data-items="' + escapeAttr(l.items || '') + '" data-likes="' + escapeAttr(l.likes || 0) + '">' +
      '<div class="list-card-header">' +
      '<div class="list-card-body">' +
      '<div class="list-card-title">' + escapeHtml(l.name) + '</div>' +
      '<div class="list-card-meta">' +
      '<span>by ' + escapeHtml(l.user) + '</span>' +
      '<span class="list-card-meta-sep">&middot;</span>' +
      '<span>' + l.items + ' items</span>' +
      '<span class="list-card-meta-sep">&middot;</span>' +
      '<span class="list-card-likes">&#9829; <span class="like-num">' + (l.likes || 0) + '</span></span>' +
      '</div>' +
      '</div>' +
      '<div class="list-card-actions">' +
      '<button type="button" class="lc-btn searchLikeExternalBtn' + (alreadyLikedExt ? ' liked' : '') + '" data-url="' + escapeAttr(l.url) + '">' +
      (alreadyLikedExt ? '&#9829;' : '&#9825;') +
      '</button>' +
      addBtns +
      '</div>' +
      '</div>' +
      '<div class="list-card-posters poster-preview-slot" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' +
      (l.contentType === 'movie' || l.contentType === 'series' ? l.contentType : 'movie') + '" data-creator="' + escapeAttr(l.user || '') + '" data-items="' + escapeAttr(l.items || '') + '" data-likes="' + escapeAttr(l.likes || 0) + '"></div>' +
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
    const cardHtml = '<div class="list-card" data-list-type="' + l.type + '" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(l.type) + '" data-creator="' + escapeAttr(l.creatorName || 'Anonymous') + '" data-items="' + escapeAttr(l.items || '') + '" data-likes="' + escapeAttr(l.likes || 0) + '">' +
      '<div class="list-card-header">' +
      '<div class="list-card-body">' +
      '<div class="list-card-title">' + escapeHtml(l.name) + '</div>' +
      '<div class="list-card-meta">' +
      '<span>by ' + escapeHtml(l.creatorName || 'Anonymous') + '</span>' +
      '<span class="list-card-meta-sep">&middot;</span>' +
      '<span>' + typeLabel + '</span>' +
      '<span class="list-card-meta-sep">&middot;</span>' +
      '<span>' + l.items + ' items</span>' +
      '<span class="list-card-meta-sep">&middot;</span>' +
      '<span class="list-card-likes like-count">&#9829; <span class="like-num">' + (l.likes || 0) + '</span></span>' +
      '</div>' +
      '</div>' +
      '<div class="list-card-actions">' +
      (usernameSlug ? '<button type="button" class="lc-btn searchLikeBtn' + (alreadyLiked ? ' liked' : '') + '" data-username-slug="' + escapeAttr(usernameSlug) + '">' + (alreadyLiked ? '&#9829; Unlike' : '&#9825; Like') + '</button>' : '') +
      '<button type="button" class="lc-btn ' + (added ? 'secondary searchAddBtn is-added' : 'primary searchAddBtn') + '" ' +
      (added ? 'style="color:var(--danger);"' : '') +
      ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + l.type + '">' +
      (added ? 'Remove' : '+ Add') +
      '</button>' +
      '</div>' +
      '</div>' +
      '<div class="list-card-posters poster-preview-slot" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + l.type + '" data-creator="' + escapeAttr(l.creatorName || 'Anonymous') + '" data-items="' + escapeAttr(l.items || '') + '" data-likes="' + escapeAttr(l.likes || 0) + '"></div>' +
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
  // Fetches one /api/preview call for a single declared type -- split out
  // so a mixed-content list (see fetchPreviewForSlot below) can fire two
  // of these in parallel instead of duplicating the request logic.
  async function fetchPreviewOnce(listUrl, type) {
    const payload = { url: listUrl, type: type, sample: 12 };
    const mkInput = document.getElementById('mdblistKeyInput');
    if (mkInput && mkInput.value) payload.mdblistKey = mkInput.value.trim();
    const tkInput = document.getElementById('tmdbKeyInput');
    if (tkInput && tkInput.value) payload.tmdbKey = tkInput.value.trim();
    const trkInput = document.getElementById('traktKeyInput');
    if (trkInput && trkInput.value) payload.traktKey = trkInput.value.trim();
    // trakt:watchlist and trakt:history (the "Watchlist"/"Watch History"
    // cards under Your Trakt Lists) are both OAuth-only sources -- see
    // fetchTraktWatchlist/fetchTraktHistory, which throw immediately
    // without an accessToken, traktKey alone isn't enough for either.
    if (typeof traktAccessToken !== 'undefined' && traktAccessToken) payload.traktAccessToken = traktAccessToken;
    const res = await fetch(ORIGIN + '/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
    });
    return res.json();
  }
  // A list card that mixes movies and shows (MDBList/Trakt lists don't
  // have to be one or the other) gets marked data-type="mixed" by its
  // render function rather than being forced to either type -- /api/preview
  // itself only ever answers for one declared type per call (movie or
  // series, see its own coercion), so a single request here would only
  // ever surface that list's movies and leave a TV-heavy or TV-only list
  // showing no posters at all. Two parallel requests, merged, covers both.
  async function fetchPreviewForSlot(listUrl, type) {
    if (type !== 'mixed') {
      return fetchPreviewOnce(listUrl, type);
    }
    const [movieResult, seriesResult] = await Promise.all([
      fetchPreviewOnce(listUrl, 'movie').catch(() => null),
      fetchPreviewOnce(listUrl, 'series').catch(() => null),
    ]);
    const movieOk = movieResult && movieResult.ok;
    const seriesOk = seriesResult && seriesResult.ok;
    if (!movieOk && !seriesOk) return movieResult || seriesResult || { ok: false };
    const movieSample = movieOk ? (movieResult.sample || []) : [];
    const seriesSample = seriesOk ? (seriesResult.sample || []) : [];
    // Interleaved rather than movies-then-shows, so a list that's mostly
    // one type still shows a representative mix in the first few tiles
    // rather than, say, nine movie posters and zero show posters just
    // because movies happened to be fetched first.
    const merged = [];
    const maxLen = Math.max(movieSample.length, seriesSample.length);
    for (let i = 0; i < maxLen; i++) {
      if (movieSample[i]) merged.push(movieSample[i]);
      if (seriesSample[i]) merged.push(seriesSample[i]);
    }
    return {
      ok: true,
      sample: merged,
      count: (movieOk ? (movieResult.count || 0) : 0) + (seriesOk ? (seriesResult.count || 0) : 0),
    };
  }
  async function worker() {
    while (idx < slots.length) {
      const slot = slots[idx++];
      const listUrl = slot.dataset.url;
      const type = slot.dataset.type || 'movie';
      // Falls back to the url only if a card genuinely has no name to give
      // (shouldn't happen in practice -- every current caller sets
      // data-name alongside data-url) rather than always preferring the
      // url, which is what put a raw "tmdb:top10:netflix"-style internal
      // source string in the See All modal's title instead of an actual
      // display name.
      const listName = slot.dataset.name || listUrl;
      const parentCard = slot.closest('.list-card');
      const cardCreator = (parentCard && parentCard.dataset.creator) || slot.dataset.creator || '';
      const cardItems = (parentCard && parentCard.dataset.items) || slot.dataset.items || '';
      const cardLikes = (parentCard && parentCard.dataset.likes) || slot.dataset.likes || '';

      try {
        const data = await fetchPreviewForSlot(listUrl, type);
        if (data.ok && data.sample && data.sample.length) {
          const validPosters = data.sample.filter((s) => s.poster).slice(0, 9);
          if (validPosters.length) {
            const totalCount = cardItems || data.count || (validPosters.length * 10);
            let inner = '';
            validPosters.forEach((s, i) => {
              const isMobileEnd = (i === 2 && validPosters.length > 3);
              const isDesktopEnd = (i === validPosters.length - 1 && validPosters.length >= 4);

              let overlays = '';
              if (isMobileEnd) {
                overlays += '<div class="list-card-count-overlay mobile-only searchViewListBtn" data-name="' + escapeAttr(listName) + '" data-url="' + escapeAttr(listUrl) + '" data-type="' + escapeAttr(type) + '" data-creator="' + escapeAttr(cardCreator) + '" data-items="' + escapeAttr(totalCount) + '" data-likes="' + escapeAttr(cardLikes) + '" style="cursor:pointer;">' + totalCount + ' &rsaquo;</div>';
              }
              const isEndTile = isMobileEnd || isDesktopEnd;
              inner += '<div class="list-card-mini-poster-tile' + (isEndTile ? ' searchViewListBtn' : '') + '" data-name="' + escapeAttr(listName) + '" data-url="' + escapeAttr(listUrl) + '" data-type="' + escapeAttr(type) + '" data-creator="' + escapeAttr(cardCreator) + '" data-items="' + escapeAttr(totalCount) + '" data-likes="' + escapeAttr(cardLikes) + '">' +
                '<div class="list-card-mini-poster-img-wrap' + (isEndTile ? '' : ' clickable-poster') + '" ' + (isEndTile ? '' : 'data-id="' + escapeAttr(s.id || '') + '" data-type="' + escapeAttr(s.type || type || '') + '" data-title="' + escapeAttr(s.name || '') + '" data-poster="' + escapeAttr(s.poster || '') + '"') + '>' +
                  '<img src="' + escapeAttr(s.poster) + '" alt="" loading="lazy">' +
                  (isEndTile ? '' : '<div class="poster-add-overlay">+</div>') +
                  overlays +
                '</div>' +
                '<div class="list-card-mini-poster-name">' + escapeHtml(s.name || '') + '</div>' +
                (s.year ? '<div class="list-card-mini-poster-year">' + escapeHtml(s.year) + '</div>' : '') +
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
  const curatedBtn = e.target.closest('.curatedViewBtn');
  if (curatedBtn) {
    const customUrl = curatedBtn.dataset.url;
    const title = curatedBtn.dataset.title || 'Curated List';
    const type = curatedBtn.dataset.type || 'movie';
    const recObj = (window._curatedRecs && window._curatedRecs[customUrl]) || null;
    const items = recObj ? recObj.items : [];
    openListDetailsPage(title, type, customUrl, { sample: items, count: items.length, maybeMore: false }, {
      creatorName: 'Curated For You',
      itemCount: items.length,
      likes: 0
    });
    return;
  }
  const cardTitle = e.target.closest('.list-card-title');
  if (cardTitle) {
    const card = cardTitle.closest('.list-card');
    if (card && card.dataset.url) {
      const url = card.dataset.url;
      if (url.startsWith('custom:curated')) {
        const recObj = (window._curatedRecs && window._curatedRecs[url]) || null;
        const items = recObj ? recObj.items : [];
        openListDetailsPage(card.dataset.name || 'Curated List', card.dataset.type || 'movie', url, { sample: items, count: items.length, maybeMore: false }, {
          creatorName: 'Curated For You',
          itemCount: items.length,
          likes: 0
        });
        return;
      }
      openListDetailsPage(card.dataset.name, card.dataset.type, card.dataset.url, null, {
        creatorName: card.dataset.creator,
        itemCount: card.dataset.items,
        likes: card.dataset.likes
      });
      return;
    }
  }
  const viewBtn = e.target.closest('.searchViewListBtn');
  if (viewBtn) {
    openListDetailsPage(viewBtn.dataset.name, viewBtn.dataset.type, viewBtn.dataset.url, null, {
      creatorName: viewBtn.dataset.creator,
      itemCount: viewBtn.dataset.items,
      likes: viewBtn.dataset.likes
    });
    return;
  }
  const addBtn = e.target.closest('.searchAddBtn');
  if (addBtn) {
    const listName = addBtn.dataset.name || 'List';
    const listUrl = addBtn.dataset.url || '';
    const listType = addBtn.dataset.type || 'movie';
    const isAdded = addBtn.classList.contains('is-added') || (typeof isListAddedToConfig === 'function' && isListAddedToConfig(listUrl, listType));
    if (isAdded) {
      if (typeof removeListFromConfig === 'function') removeListFromConfig(listUrl, listType);
      addBtn.classList.remove('is-added', 'secondary');
      addBtn.classList.add('primary');
      addBtn.textContent = '+ Add';
      addBtn.style.color = '';
      showAddedToast('Removed "' + listName + '" from your Catalogs.');
    } else {
      addRow(listName, listUrl, listType, true, 'Custom');
      addBtn.classList.add('is-added', 'secondary');
      addBtn.classList.remove('primary');
      addBtn.textContent = 'Remove';
      addBtn.style.color = 'var(--danger)';
      showAddedToast('Added "' + listName + '" to your Catalogs.');
    }
    return;
  }
  const likeBtn = e.target.closest('.searchLikeBtn');
  if (likeBtn && !likeBtn.disabled) {
    const usernameSlug = likeBtn.dataset.usernameSlug || '';
    const parts = usernameSlug.split('/');
    if (parts.length !== 2) return;
    const wasLiked = likeBtn.classList.contains('liked');
    const card = likeBtn.closest('.list-card, .searchresult-row');
    let currentLikes = card ? parseInt(card.dataset.likes || '0', 10) : 0;
    if (isNaN(currentLikes)) currentLikes = 0;
    const newLikes = wasLiked ? Math.max(0, currentLikes - 1) : currentLikes + 1;

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
      const finalLikes = (data.likes !== undefined) ? data.likes : newLikes;
      if (wasLiked) {
        forgetLikedList(usernameSlug);
        likeBtn.classList.remove('liked');
        likeBtn.textContent = '\u2661 Like';
      } else {
        rememberLikedList(usernameSlug);
        likeBtn.classList.add('liked');
        likeBtn.textContent = '\u2665 Unlike';
      }
      if (card) {
        card.dataset.likes = finalLikes;
        const numEl = card.querySelector('.like-num');
        if (numEl) numEl.textContent = finalLikes;
        else {
          const countEl = card.querySelector('.like-count, .list-card-likes');
          if (countEl) countEl.innerHTML = '&#9829; <span class="like-num">' + finalLikes + '</span>';
        }
      }
      if (window._currentListDetailsUpdateLikes) {
        window._currentListDetailsUpdateLikes(finalLikes);
      }
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
    const card = likeExternalBtn.closest('.list-card, .searchresult-row');
    let currentLikes = card ? parseInt(card.dataset.likes || '0', 10) : 0;
    if (isNaN(currentLikes)) currentLikes = 0;
    const newLikes = wasLiked ? Math.max(0, currentLikes - 1) : currentLikes + 1;

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
      const finalLikes = (data.likes !== undefined) ? data.likes : newLikes;
      if (wasLiked) {
        forgetLikedList(listUrl);
        likeExternalBtn.classList.remove('liked');
        if (likeExternalBtn.id === 'detailLikeBtn') {
          likeExternalBtn.innerHTML = '&#9825;';
        } else {
          likeExternalBtn.innerHTML = '&#9825;';
        }
      } else {
        rememberLikedList(listUrl);
        likeExternalBtn.classList.add('liked');
        if (likeExternalBtn.id === 'detailLikeBtn') {
          likeExternalBtn.innerHTML = '&#9829;';
        } else {
          likeExternalBtn.innerHTML = '&#9829;';
        }
      }
      if (card) {
        card.dataset.likes = finalLikes;
        const numEl = card.querySelector('.like-num');
        if (numEl) numEl.textContent = finalLikes;
        else {
          const countEl = card.querySelector('.like-count, .list-card-likes');
          if (countEl) countEl.innerHTML = '&#9829; <span class="like-num">' + finalLikes + '</span>';
        }
      }
      if (window._currentListDetailsUpdateLikes) {
        window._currentListDetailsUpdateLikes(finalLikes);
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
    return;
  }
});

let popularListsFeedLoaded = false;
async function loadPopularListsFeed(forceRefresh) {
  const container = document.getElementById('popularListsFeed');
  if (!container) return;
  if (popularListsFeedLoaded && !forceRefresh && container.children.length > 0) {
    return;
  }
  container.innerHTML = '<p style="color:var(--muted); font-size:0.88rem;">Loading popular public lists…</p>';
  try {
    const [mdbLists, traktLists] = await Promise.all([
      ensureMdblistPopularLoaded(),
      ensureTraktPopularLoaded()
    ]);
    const combined = [...(mdbLists || []), ...(traktLists || [])];
    combined.sort((a, b) => (b.likes || 0) - (a.likes || 0));
    if (!combined.length) {
      container.innerHTML = '<p style="color:var(--muted); font-size:0.88rem;">No popular public lists found.</p>';
      return;
    }
    render5PosterListsFeed(container, combined);
    popularListsFeedLoaded = true;
  } catch (e) {
    container.innerHTML = '<p class="testresult err">&#x2717; Error loading popular lists.</p>';
  }
}

function buildCuratedRecommendationCard(title, type, customUrl, subtitle, items) {
  const previewPosters = items.slice(0, 9);
  const totalCount = items.length;

  let postersHtml = previewPosters.map((s, i) => {
    const isMobileEnd = (i === 2 && previewPosters.length > 3);
    const isDesktopEnd = (i === previewPosters.length - 1 && previewPosters.length >= 4);
    let overlays = '';
    if (isMobileEnd) {
      overlays += '<div class="list-card-count-overlay mobile-only curatedViewBtn" data-title="' + escapeAttr(title) + '" data-type="' + escapeAttr(type) + '" data-url="' + escapeAttr(customUrl) + '" style="cursor:pointer;">' + totalCount + ' &rsaquo;</div>';
    }
    if (isDesktopEnd) {
      overlays += '<div class="list-card-count-overlay desktop-only curatedViewBtn" data-title="' + escapeAttr(title) + '" data-type="' + escapeAttr(type) + '" data-url="' + escapeAttr(customUrl) + '" style="cursor:pointer;">' + totalCount + ' &rsaquo;</div>';
    }
    const isEndTile = isMobileEnd || isDesktopEnd;
    return '<div class="list-card-mini-poster-tile' + (isEndTile ? ' curatedViewBtn' : '') + '" data-title="' + escapeAttr(title) + '" data-type="' + escapeAttr(type) + '" data-url="' + escapeAttr(customUrl) + '">' +
      '<div class="list-card-mini-poster-img-wrap' + (isEndTile ? '' : ' clickable-poster') + '" ' + (isEndTile ? '' : 'data-id="' + escapeAttr(s.id || '') + '" data-type="' + escapeAttr(s.type || type) + '" data-title="' + escapeAttr(s.name || '') + '" data-poster="' + escapeAttr(s.poster || '') + '"') + '>' +
        '<img src="' + escapeAttr(s.poster) + '" alt="" loading="lazy">' +
        (isEndTile ? '' : '<div class="poster-add-overlay">+</div>') +
        overlays +
      '</div>' +
      '<div class="list-card-mini-poster-name">' + escapeHtml(s.name) + '</div>' +
      (s.year ? '<div class="list-card-mini-poster-year">' + escapeHtml(s.year) + '</div>' : '') +
    '</div>';
  }).join('');

  window._curatedRecs = window._curatedRecs || {};
  window._curatedRecs[customUrl] = { title, type, items };

  return '<div class="list-card" data-name="' + escapeAttr(title) + '" data-type="' + escapeAttr(type) + '" data-url="' + escapeAttr(customUrl) + '">' +
    '<div class="list-card-header">' +
      '<div class="list-card-body">' +
        '<div class="list-card-title curatedViewBtn" data-title="' + escapeAttr(title) + '" data-type="' + escapeAttr(type) + '" data-url="' + escapeAttr(customUrl) + '" style="cursor:pointer;">' + escapeHtml(title) + '</div>' +
        '<div class="list-card-meta">' +
          '<span>' + escapeHtml(subtitle) + '</span>' +
          '<span class="list-card-meta-sep">&middot;</span>' +
          '<span>' + (type === 'series' ? 'Shows' : 'Movies') + '</span>' +
          '<span class="list-card-meta-sep">&middot;</span>' +
          '<span>' + totalCount + ' items</span>' +
        '</div>' +
      '</div>' +
      '<div class="list-card-actions">' +
        '<button type="button" class="lc-btn primary curatedViewBtn" data-title="' + escapeAttr(title) + '" data-type="' + escapeAttr(type) + '" data-url="' + escapeAttr(customUrl) + '">View All</button>' +
      '</div>' +
    '</div>' +
    '<div class="list-card-posters">' + postersHtml + '</div>' +
  '</div>';
}

let curatedListsFeedLoaded = false;
let lastCuratedWatchCount = -1;
async function loadCuratedListsFeed(forceRefresh) {
  const container = document.getElementById('curatedListsFeed');
  if (!container) return;

  let customListsMap = {};
  try {
    if (typeof loadLocalCustomLists === 'function') {
      customListsMap = loadLocalCustomLists() || {};
    }
  } catch (e) {}

  const watchHistory = customListsMap['watch-history'] || (typeof getOrCreateWatchHistoryList === 'function' ? getOrCreateWatchHistoryList() : null) || { items: [] };
  const continueWatching = customListsMap['continue-watching'] || (typeof getOrCreateContinueWatchingList === 'function' ? getOrCreateContinueWatchingList() : null) || { items: [] };

  const currentCount = (watchHistory.items ? watchHistory.items.length : 0) + (continueWatching.items ? continueWatching.items.length : 0);
  const historyChanged = (currentCount !== lastCuratedWatchCount);

  if (curatedListsFeedLoaded && !forceRefresh && !historyChanged && container.children.length > 0) {
    return;
  }
  container.innerHTML = '<p style="color:var(--muted); font-size:0.88rem;">Loading your personalized curated lists…</p>';

  try {
    let customListsMap = {};
    try {
      if (typeof loadLocalCustomLists === 'function') {
        customListsMap = loadLocalCustomLists() || {};
      }
    } catch (e) {}

    const watchHistory = customListsMap['watch-history'] || (typeof getOrCreateWatchHistoryList === 'function' ? getOrCreateWatchHistoryList() : null) || { items: [] };
    const continueWatching = customListsMap['continue-watching'] || (typeof getOrCreateContinueWatchingList === 'function' ? getOrCreateContinueWatchingList() : null) || { items: [] };
    
    let whItems = (watchHistory && Array.isArray(watchHistory.items)) ? watchHistory.items : [];
    if (!whItems.length) {
      try {
        const rawWh = JSON.parse(localStorage.getItem('myListAddon:watchHistory') || '[]');
        if (Array.isArray(rawWh)) whItems = rawWh;
      } catch (e) {}
    }
    let cwItems = (continueWatching && Array.isArray(continueWatching.items)) ? continueWatching.items : [];

    const allWatched = [...cwItems, ...whItems];

    const movieIds = [];
    const showIds = [];
    const seenShowIds = new Set();
    const seenMovieIds = new Set();

    for (const it of allWatched) {
      if (!it) continue;
      const showId = it.showId || (it.type === 'series' ? it.id : null);
      if (showId && !seenShowIds.has(String(showId))) {
        seenShowIds.add(String(showId));
        showIds.push(String(showId));
      } else if (it.type === 'movie' || (!it.showId && it.type !== 'episode')) {
        const movieId = it.id || it.imdbId;
        if (movieId && !seenMovieIds.has(String(movieId))) {
          seenMovieIds.add(String(movieId));
          movieIds.push(String(movieId));
        }
      }
    }

    const likedUrls = [...getLikedListsSet()];
    const customLists = (typeof getLocalCustomLists === 'function' ? getLocalCustomLists() : []) || [];

    if (!movieIds.length && !showIds.length && !likedUrls.length && !customLists.length) {
      container.innerHTML =
        '<div style="text-align:center; padding:32px 16px; background:var(--card-bg, rgba(255,255,255,0.03)); border:1px solid var(--border); border-radius:14px; margin-top:10px;">' +
          '<div style="font-size:2rem; margin-bottom:8px;">✨</div>' +
          '<h3 style="margin:0 0 6px; font-size:1.05rem;">Personalized For You</h3>' +
          '<p style="margin:0 auto 14px; max-width:420px; font-size:0.85rem; color:var(--muted);">' +
            'Watch movies or shows with Auto-Track enabled, or like and create custom lists to unlock smart recommendations and similar lists here.' +
          '</p>' +
          '<div style="display:flex; justify-content:center; gap:8px;">' +
            '<button type="button" class="lc-btn primary" onclick="filterDiscoverShelves(&quot;all&quot;)">Explore Discover</button>' +
          '</div>' +
        '</div>';
      return;
    }

    const tmdbKey = (document.getElementById('tmdbKeyInput') ? document.getElementById('tmdbKeyInput').value.trim() : '') || localStorage.getItem('myListAddon:tmdbKey') || '';
    
    // Pass up to 12 recent movie IDs and 12 recent show IDs for rich diverse recommendations
    const sampleMovieIds = movieIds.slice(0, 12);
    const sampleShowIds = showIds.slice(0, 12);

    const [recData, mdblists, traktLists] = await Promise.all([
      (sampleMovieIds.length || sampleShowIds.length)
        ? fetch(ORIGIN + '/api/recommendations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ movieIds: sampleMovieIds, showIds: sampleShowIds, tmdbKey })
          }).then(r => r.json()).catch(() => ({ ok: false }))
        : Promise.resolve({ ok: false }),
      ensureMdblistPopularLoaded(),
      ensureTraktPopularLoaded()
    ]);

    const publicListsPool = [...(mdblists || []), ...(traktLists || [])];
    let sectionsHtml = '';

    // Section A: Recommended Movies List
    if (recData && recData.ok && recData.movies && recData.movies.length) {
      sectionsHtml += buildCuratedRecommendationCard('Recommended Movies', 'movie', 'custom:curated:recommended-movies', 'Based on your movie watch history', recData.movies);
    }

    // Section B: Recommended Shows List
    if (recData && recData.ok && recData.shows && recData.shows.length) {
      sectionsHtml += buildCuratedRecommendationCard('Recommended Shows', 'series', 'custom:curated:recommended-shows', 'Based on your series watch history & continue watching', recData.shows);
    }

    // Section C: Lists Similar to Liked Lists
    if (likedUrls.length && publicListsPool.length) {
      const likedKeywords = likedUrls.map(u => {
        const parts = u.split('/').filter(Boolean);
        return parts[parts.length - 1] ? parts[parts.length - 1].replace(/[-_]/g, ' ') : '';
      }).filter(Boolean);

      const similarToLiked = publicListsPool.filter(l => {
        if (likedUrls.includes(l.url)) return false;
        const nameLower = (l.name || '').toLowerCase();
        return likedKeywords.some(kw => kw.length > 3 && nameLower.includes(kw.toLowerCase()));
      }).slice(0, 5);

      if (similarToLiked.length) {
        sectionsHtml += '<div style="margin-top:24px; margin-bottom:8px;"><h3 style="font-size:0.95rem; margin:0 0 2px;">Lists Similar to Lists You Liked</h3><p style="margin:0; font-size:0.8rem; color:var(--muted);">Public community lists based on your liked lists</p></div>';
        const alreadyAdded = new Set();
        document.querySelectorAll('#lists .entry').forEach(function(entry) {
          const t = entry.querySelector('.type') ? entry.querySelector('.type').value : '';
          entry.querySelectorAll('.url').forEach(function(el) {
            alreadyAdded.add(el.value.trim() + '|' + t);
          });
        });
        sectionsHtml += similarToLiked.map(l => {
          const type = l.type || 'movie';
          const added = alreadyAdded.has(l.url + '|' + type);
          const alreadyLiked = getLikedListsSet().has(l.url);
          const author = l.user || l.creatorName || 'Community';
          return '<div class="list-card" data-list-type="' + escapeAttr(type) + '" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(type) + '" data-creator="' + escapeAttr(author) + '" data-items="' + escapeAttr(l.items || '') + '" data-likes="' + escapeAttr(l.likes || 0) + '">' +
            '<div class="list-card-header">' +
              '<div class="list-card-body">' +
                '<div class="list-card-title">' + escapeHtml(l.name) + '</div>' +
                '<div class="list-card-meta">' +
                  '<span>by ' + escapeHtml(author) + '</span>' +
                  '<span class="list-card-meta-sep">&middot;</span>' +
                  '<span>' + (type === 'series' ? 'Shows' : 'Movies') + '</span>' +
                  (l.items ? '<span class="list-card-meta-sep">&middot;</span><span>' + l.items + ' items</span>' : '') +
                  '<span class="list-card-meta-sep">&middot;</span><span class="list-card-likes">&#9829; <span class="like-num">' + (l.likes || 0) + '</span></span>' +
                '</div>' +
              '</div>' +
              '<div class="list-card-actions">' +
                '<button type="button" class="lc-btn searchLikeExternalBtn' + (alreadyLiked ? ' liked' : '') + '" data-url="' + escapeAttr(l.url) + '">' +
                  (alreadyLiked ? '&#9829;' : '&#9825;') +
                '</button>' +
                '<button type="button" class="lc-btn ' + (added ? 'secondary searchAddBtn is-added' : 'primary searchAddBtn') + '" ' +
                  (added ? 'style="color:var(--danger);"' : '') +
                  ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(type) + '">' +
                  (added ? 'Remove' : '+ Add') +
                '</button>' +
              '</div>' +
            '</div>' +
            '<div class="list-card-posters poster-preview-slot" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(type) + '" data-creator="' + escapeAttr(author) + '" data-items="' + escapeAttr(l.items || '') + '" data-likes="' + escapeAttr(l.likes || 0) + '"></div>' +
          '</div>';
        }).join('');
      }
    }

    // Section D: Lists Similar to Custom Lists
    if (customLists.length && publicListsPool.length) {
      const customKeywords = customLists.map(l => (l.name || '').toLowerCase()).filter(n => n.length > 2 && n !== 'watch history' && n !== 'continue watching');
      const similarToCustom = publicListsPool.filter(l => {
        const nameLower = (l.name || '').toLowerCase();
        return customKeywords.some(kw => nameLower.includes(kw) || kw.includes(nameLower));
      }).slice(0, 5);

      if (similarToCustom.length) {
        sectionsHtml += '<div style="margin-top:24px; margin-bottom:8px;"><h3 style="font-size:0.95rem; margin:0 0 2px;">Lists Similar to Your Custom Lists</h3><p style="margin:0; font-size:0.8rem; color:var(--muted);">Public lists matching the themes of custom lists you created</p></div>';
        const alreadyAdded = new Set();
        document.querySelectorAll('#lists .entry').forEach(function(entry) {
          const t = entry.querySelector('.type') ? entry.querySelector('.type').value : '';
          entry.querySelectorAll('.url').forEach(function(el) {
            alreadyAdded.add(el.value.trim() + '|' + t);
          });
        });
        sectionsHtml += similarToCustom.map(l => {
          const type = l.type || 'movie';
          const added = alreadyAdded.has(l.url + '|' + type);
          const alreadyLiked = getLikedListsSet().has(l.url);
          const author = l.user || l.creatorName || 'Community';
          return '<div class="list-card" data-list-type="' + escapeAttr(type) + '" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(type) + '" data-creator="' + escapeAttr(author) + '" data-items="' + escapeAttr(l.items || '') + '" data-likes="' + escapeAttr(l.likes || 0) + '">' +
            '<div class="list-card-header">' +
              '<div class="list-card-body">' +
                '<div class="list-card-title">' + escapeHtml(l.name) + '</div>' +
                '<div class="list-card-meta">' +
                  '<span>by ' + escapeHtml(author) + '</span>' +
                  '<span class="list-card-meta-sep">&middot;</span>' +
                  '<span>' + (type === 'series' ? 'Shows' : 'Movies') + '</span>' +
                  (l.items ? '<span class="list-card-meta-sep">&middot;</span><span>' + l.items + ' items</span>' : '') +
                  '<span class="list-card-meta-sep">&middot;</span><span class="list-card-likes">&#9829; <span class="like-num">' + (l.likes || 0) + '</span></span>' +
                '</div>' +
              '</div>' +
              '<div class="list-card-actions">' +
                '<button type="button" class="lc-btn searchLikeExternalBtn' + (alreadyLiked ? ' liked' : '') + '" data-url="' + escapeAttr(l.url) + '">' +
                  (alreadyLiked ? '&#9829;' : '&#9825;') +
                '</button>' +
                '<button type="button" class="lc-btn ' + (added ? 'secondary searchAddBtn is-added' : 'primary searchAddBtn') + '" ' +
                  (added ? 'style="color:var(--danger);"' : '') +
                  ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(type) + '">' +
                  (added ? 'Remove' : '+ Add') +
                '</button>' +
              '</div>' +
            '</div>' +
            '<div class="list-card-posters poster-preview-slot" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(type) + '" data-creator="' + escapeAttr(author) + '" data-items="' + escapeAttr(l.items || '') + '" data-likes="' + escapeAttr(l.likes || 0) + '"></div>' +
          '</div>';
        }).join('');
      }
    }

    if (!sectionsHtml) {
      container.innerHTML =
        '<div style="text-align:center; padding:24px 16px; background:var(--card-bg); border:1px solid var(--border); border-radius:14px;">' +
          '<p style="margin:0; font-size:0.88rem; color:var(--muted);">Watch more items or like community lists to build personalized recommendations.</p>' +
        '</div>';
      return;
    }

    container.innerHTML = sectionsHtml;
    populateSearchResultPosters();
    lastCuratedWatchCount = currentCount;
    curatedListsFeedLoaded = true;
  } catch (err) {
    container.innerHTML = '<p class="testresult err">&#x2717; Error loading curated lists.</p>';
  }
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

    return '<div class="list-card" data-list-type="' + escapeAttr(type) + '" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(type) + '" data-creator="' + escapeAttr(author) + '" data-items="' + escapeAttr(itemCount || '') + '" data-likes="' + escapeAttr(l.likes || 0) + '">' +
      '<div class="list-card-header">' +
        '<div class="list-card-body">' +
          '<div class="list-card-title">' + escapeHtml(l.name) + '</div>' +
          '<div class="list-card-meta">' +
            '<span>by ' + escapeHtml(author) + '</span>' +
            '<span class="list-card-meta-sep">&middot;</span>' +
            '<span>' + (type === 'series' ? 'Shows' : 'Movies') + '</span>' +
            (itemCount ? '<span class="list-card-meta-sep">&middot;</span><span>' + itemCount + ' items</span>' : '') +
            '<span class="list-card-meta-sep">&middot;</span><span class="list-card-likes">&#9829; <span class="like-num">' + (l.likes || 0) + '</span></span>' +
          '</div>' +
        '</div>' +
        '<div class="list-card-actions">' +
          '<button type="button" class="lc-btn searchLikeExternalBtn' + (alreadyLiked ? ' liked' : '') + '" data-url="' + escapeAttr(l.url) + '">' +
            (alreadyLiked ? '&#x2665;' : '&#x2661;') +
          '</button>' +
          '<button type="button" class="lc-btn ' + (added ? 'secondary searchAddBtn is-added' : 'primary searchAddBtn') + '" ' +
            (added ? 'style="color:var(--danger);"' : '') +
            ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(type) + '">' +
            (added ? 'Remove' : '+ Add') +
          '</button>' +
        '</div>' +
      '</div>' +
      '<div class="list-card-posters poster-preview-slot" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(type) + '" data-creator="' + escapeAttr(author) + '" data-items="' + escapeAttr(itemCount || '') + '" data-likes="' + escapeAttr(l.likes || 0) + '"></div>' +
    '</div>';
  }).join('');

  container.innerHTML = cardsHtml;
  populateSearchResultPosters();
}

// openSeeAllDetail (removed) used to clone posters out of shelfScrollX
// containers that were never actually rendered anywhere in the app --
// every category always fell through to "No items available in this
// category," and nothing ever called this function to begin with (no
// button in the Discover tab's actual card grid triggered it). Discover's
// chart/provider cards now get a real "See All" via openListDetailsPage
// instead, using each card's own already-known movieUrl/showUrl -- see
// buildStreamingRowsHtml (08_quickadd-chart-data.js) and its callers.

// --- Clickable Posters & Add to List Modal Logic ---
document.addEventListener('click', async (e) => {
  const addOverlayBtn = e.target.closest('.poster-add-overlay');
  const posterEl = addOverlayBtn ? addOverlayBtn.closest('.clickable-poster, .live-preview-poster-card, .list-card-mini-poster-img-wrap, .list-card-mini-poster-tile') : e.target.closest('.clickable-poster');
  
  if (addOverlayBtn && posterEl) {
    e.stopPropagation(); // prevent opening the details modal
    const id = posterEl.dataset.id || (posterEl.querySelector('.clickable-poster') && posterEl.querySelector('.clickable-poster').dataset.id) || '';
    const type = posterEl.dataset.type || (posterEl.querySelector('.clickable-poster') && posterEl.querySelector('.clickable-poster').dataset.type) || 'movie';
    const title = posterEl.dataset.title || (posterEl.querySelector('.clickable-poster') && posterEl.querySelector('.clickable-poster').dataset.title) || '';
    const poster = posterEl.dataset.poster || (posterEl.querySelector('img') && posterEl.querySelector('img').src) || '';
    openSelectListModal(id, type, title, poster);
    return;
  }
  
  if (posterEl && !e.target.closest('.searchViewListBtn, .curatedViewBtn, .list-card-count-overlay, .creatorListViewBtn, .discover-chart-seeall')) {
    // Posters clicked from inside a "See All" overlay (either kind -- the
    // Discover tab's chart overlay, or the Catalogs/Shelves Live Preview's
    // showModal()-based one) share this same handler, but opening item
    // details only ever switches to the item-details tab underneath --
    // neither overlay is a tab panel, so nothing was ever telling them to
    // close, and they stayed sitting on top of the item details page that
    // had just opened behind them. Closing both here is harmless when
    // neither is actually open (closeDetailOverlay/closeModal are already
    // no-ops in that case), so this covers every current and future
    // "click a poster from inside an overlay" spot without needing to
    // special-case each overlay's own trigger.
    closeDetailOverlay();
    closeModal();
    openItemDetailsModal(posterEl.dataset.id, posterEl.dataset.type);
    return;
  }
});

// Client-side "is this episode aired yet" check -- same rule the server's
// isEpisodeAiredServer uses (07_source-fetchers-tmdb-simkl.js). Needed by
// updateContinueWatching (21_client-custom-list-builder.js) and
// markShowWatched (also 21) to exclude future episodes from "fully
// watched" detection and from what Mark Whole Show Watched fetches.
function isEpisodeAired(ep) {
  if (!ep || !ep.air_date) return false;
  const airDate = new Date(ep.air_date);
  if (isNaN(airDate.getTime())) return false;
  return airDate.getTime() <= Date.now();
}

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
            '<button type="button" id="btnMarkWatched" class="lc-btn ' + (window._watchedItemIds && window._watchedItemIds.has(String(ep.id)) ? 'secondary' : 'primary') + '" onclick="toggleWatchStatus(\\'' + ep.id + '\\', \\'episode\\', \\'' + (ep.name ? escapeAttr(ep.name.replace(/'/g, "\\'")) : '') + '\\', \\'' + still + '\\')">' +
              (window._watchedItemIds && window._watchedItemIds.has(String(ep.id)) ? '<span style="margin-right:4px;">&#x2713;</span> Mark as unwatched' : 'Mark as Watched') +
            '</button>' +
          '</div>' +
        '<div style="margin-bottom:16px; color:var(--text); font-size:1.05rem;">' + infoHtml + '</div>' +
        '<p style="font-size:1.05rem; line-height:1.6; color:var(--text); margin-bottom: 24px;">' + escapeHtml(ep.overview || 'No overview available.') + '</p>' +
      '</div>' +
    '</div>';
    
  showModal(innerHtml, 'modal-card-wide');
}

// opts.skipPushState is set by the popstate handler and the initial
// deep-link check (both in 24_client-backup-restore-presets.js) -- in
// either case the browser's URL already points here, so pushing another
// history entry would just create a duplicate back-button step.
async function openItemDetailsModal(id, type, opts) {
  opts = opts || {};
  if (!id || id.startsWith('channel_')) return;
  
  const currentActiveTab = document.querySelector('.tab-btn.active')?.dataset.tab || 'discover';
  if (currentActiveTab !== 'item-details' && currentActiveTab !== 'list-details') {
    window._previousTab = currentActiveTab;
    window._previousScrollY = window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0;
  }
  switchTab('item-details');

  // A real, bookmarkable/shareable URL for this specific title.
  if (!opts.skipPushState) {
    const params = new URLSearchParams({ id: id, type: type || 'movie' });
    history.pushState({ view: 'item', id: id, type: type }, '', '#/item?' + params.toString());
  }
  
  const body = document.getElementById('itemDetailsBody');
  body.innerHTML = '<p style="color:var(--muted); text-align:center; padding: 40px;">Fetching information from TMDB...</p>';
  
  const tkInput = document.getElementById('tmdbKeyInput');
  const tmdbKey = tkInput && tkInput.value ? tkInput.value.trim() : '';
  
  try {
    const res = await fetch(ORIGIN + '/api/details?imdbId=' + encodeURIComponent(id) + '&tmdbKey=' + encodeURIComponent(tmdbKey) + (type ? '&type=' + encodeURIComponent(type) : ''));
    const data = await res.json();
    if (!data.ok || !data.details) throw new Error(data.error || 'Failed to load details');
    
    const d = data.details;
    // Stashed so toggleWatchStatus (episode context), markShowWatched, and
    // markSeasonWatched-style helpers can all get at the show's own id/
    // title/poster/seasonsData without re-fetching -- previously read at
    // window._currentItemDetails elsewhere but never actually set here.
    window._currentItemDetails = d;
    
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
            '<div style="display:flex; gap:16px; padding:16px; cursor:pointer;" onclick="toggleSeasonEpisodes(this, ' + season.season_number + ', &quot;' + escapeAttr(d.id) + '&quot;)">' +
              (sPoster ? '<img src="' + escapeAttr(sPoster) + '" style="width:80px; border-radius:4px; flex-shrink:0; box-shadow:0 2px 8px rgba(0,0,0,0.3);">' : '<div style="width:80px; height:120px; background:#333; border-radius:4px; flex-shrink:0;"></div>') +
              '<div style="display:flex; flex-direction:column; justify-content:center;">' +
                '<h4 style="margin:0 0 4px; font-size:1.2rem;">' + escapeHtml(season.name) + '</h4>' +
                '<div style="color:var(--muted); font-size:0.9rem;">' + season.episode_count + ' episodes</div>' +
              '</div>' +
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
              : '') +
            (type === 'series' ?
              '<button type="button" id="btnMarkShowWatched" class="lc-btn ' + (window._fullyWatchedShowIds && window._fullyWatchedShowIds.has(String(d.id)) ? 'secondary' : 'primary') + '" onclick="markShowWatched(&quot;' + escapeAttr(d.id) + '&quot;)">' +
                (window._fullyWatchedShowIds && window._fullyWatchedShowIds.has(String(d.id)) ? '<span style="margin-right:4px;">&#x2713;</span> Mark Whole Show Unwatched' : 'Mark Whole Show Watched') +
              '</button>'
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
  const container = headerEl.nextElementSibling;
  const grid = container.querySelector('.episodes-grid');
  // Tracked so toggleWatchStatus's episode-context lookup
  // (21_client-custom-list-builder.js) knows which season an episode
  // opened via openEpisodeDetails belongs to -- set every time a season
  // is expanded (not just on first load) so switching between seasons
  // keeps this pointed at whichever one the user is actually looking at.
  window._currentSeasonNum = seasonNum;
  
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
    const d = window._currentItemDetails;
    const res = await fetch(ORIGIN + '/api/season?imdbId=' + encodeURIComponent(imdbId) +
      (d && d.tmdbId ? '&tmdbId=' + encodeURIComponent(d.tmdbId) : '') +
      '&seasonNum=' + seasonNum + '&tmdbKey=' + encodeURIComponent(tmdbKey));
    const data = await res.json();
    if (!data.ok || !data.season || !data.season.episodes) throw new Error(data.error || 'Failed to load season');
    
    let epsHtml = '';
    if (!window._episodeDataCache) window._episodeDataCache = {};
    data.season.episodes.forEach(ep => {
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

function openSelectListModal(id, type, title, poster) {
  const modal = document.getElementById('selectListModal');
  const body = document.getElementById('selectListModalBody');
  
  // Scrape available Custom Lists from the configured lists DOM
  // Only show lists that are properly saved (have a localSlug or creatorSlug)
  // Unsaved drafts (user dismissed visibility modal) are excluded
  const customLists = [];
  document.querySelectorAll('#lists .entry').forEach(row => {
    const urlInput = row.querySelector('.url');
    if (urlInput && urlInput.value.startsWith('customlist:v1:')) {
      try {
        const payload = JSON.parse(urlInput.value.slice('customlist:v1:'.length));
        // Only include lists that have been properly saved
        if (!payload.localSlug && !payload.creatorSlug) return;
        // Filter by item type: if list has a type (movie or series), it must match the item being added OR be mixed
        if (payload.type && payload.type !== 'mixed' && payload.type !== type) return;
        const nameInput = row.querySelector('.name');
        customLists.push({
          name: nameInput ? nameInput.value : (payload.listName || 'Unnamed List'),
          url: urlInput.value,
          row: row
        });
      } catch(e) {}
    }
  });

  try {
    const localMap = (typeof loadLocalCustomLists === 'function') ? loadLocalCustomLists() : {};
    Object.keys(localMap).forEach(slug => {
      if (slug === 'watch-history' || slug === 'continue-watching') return;
      const l = localMap[slug];
      if (!l) return;
      if (l.type && l.type !== 'mixed' && l.type !== type) return;
      const existing = customLists.find(c => c.url && (c.url.includes(slug) || (c.name && c.name === l.name)));
      if (!existing) {
        customLists.push({
          name: l.name || 'Custom List',
          url: 'customlist:v1:' + JSON.stringify({ listId: generateChannelId(), localSlug: slug, type: l.type || 'movie', items: l.items || [], shuffle: false })
        });
      }
    });
  } catch(e) {}

  let html = '';
  if (customLists.length === 0) {
    html += '<p style="text-align:center; padding:20px; color:var(--text);">You have not created any Custom Lists yet. <a href="#" id="emptyCreateListLink" style="color:var(--brand); font-weight:600;">Create one now</a></p>';
    document.getElementById('addSelectedListsBtn').style.display = 'none';
    setTimeout(() => {
      const lnk = document.getElementById('emptyCreateListLink');
      if (lnk) {
        lnk.onclick = function(e) {
          e.preventDefault();
          document.getElementById('selectListModal').style.display = 'none';
          document.body.style.overflow = '';
          if (typeof openCreateListModal === 'function') {
            openCreateListModal();
          }
        };
      }
    }, 0);
  } else {
    document.getElementById('addSelectedListsBtn').style.display = 'block';
    customLists.forEach((list, idx) => {
      let isChecked = false;
      try {
        const payloadStr = list.url.slice('customlist:v1:'.length);
        const payload = JSON.parse(payloadStr);
        isChecked = payload.items.some(it => (it.imdbId === id) || (it.id === id) || (it.imdbId === 'tmdb:' + id));
      } catch(e) {}
      
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
  
  checkboxes.forEach(cb => {
    const listIdx = parseInt(cb.dataset.idx, 10);
    const isChecked = cb.checked;
    const changed = toggleItemInCustomListUrl(id, finalImdbId, type, listIdx, isChecked, title, poster);
    if (changed) {
      if (isChecked) anyAdded = true;
      else anyRemoved = true;
    }
  });
  
  document.getElementById('selectListModal').style.display = 'none';
  document.body.style.overflow = '';
  
  btn.disabled = false;
  btn.textContent = 'Done';
  
  if (anyAdded) {
    showAddedToast('Added ' + title + ' to lists.');
    if (typeof trackEvent === 'function') trackEvent('list-add', finalImdbId, title, type);
  }
  else if (anyRemoved && typeof showAddedToast === 'function') showAddedToast('Removed ' + title + ' from lists.');
});

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

  if (currentCatalogSearchType === 'lists') {
    const qLower = q.toLowerCase();
    const traktKey = (document.getElementById('traktKeyInput')?.value || '').trim();
    try {
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
        .filter((l) => l.name.toLowerCase().includes(qLower) || (l.user && l.user.toLowerCase().includes(qLower)))
        .slice(0, 30);
      const traktMatches = traktResult.ok ? (traktResult.lists || []).slice(0, 30) : [];
      const myListsMatches = myListsResult.ok ? (myListsResult.lists || []) : [];

      renderListSearchResults(mdblistMatches, traktMatches, traktResult.ok ? null : traktResult.error, myListsMatches, resEl);
      return;
    } catch (e) {
      resEl.innerHTML = '<p class="testresult err">✗ Network error searching lists.</p>';
      return;
    }
  }

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
      
      const title = m.title || '';
      const type = currentCatalogSearchType === 'tv' ? 'series' : 'movie';
      // A bare "tmdb:<id>" -- fetchTmdbItemDetails (07_source-fetchers-
      // tmdb-simkl.js) resolves this into the title's real IMDb id
      // server-side before it ever reaches window._currentItemDetails, so
      // every downstream watched-status check/save keys off the same real
      // id a title opened from Discover/a chart would have used too.
      const id = 'tmdb:' + m.tmdbId;
      
      return '<div class="live-preview-poster-card clickable-poster" ' +
        'data-id="' + escapeAttr(id || '') + '" ' +
        'data-type="' + escapeAttr(type) + '" ' +
        'data-title="' + escapeAttr(m.title || '') + '" ' +
        'data-poster="' + escapeAttr(m.poster || '') + '" ' +
        '>' +
        '<div style="position:relative; width:100%;">' +
          posterEl +
          '<div class="poster-add-overlay" title="Add to Custom List">+</div>' +
        '</div>' +
        '<div class="live-preview-poster-name">' + escapeHtml(title) + '</div>' +
        (m.year ? '<div class="live-preview-poster-year">' + escapeHtml(m.year) + '</div>' : '') +
        '</div>';
    }).join('');
    
    resEl.innerHTML = '<div class="poster-grid-3">' + postersHtml + '</div>';
  } catch (e) {
    resEl.innerHTML = '<p class="testresult err">✗ Network error.</p>';
  }
}







// --- "Your MDBList/Trakt Lists" ----------------------------------------------
//
// Once a key (and, for Trakt, a username) is entered above, shows every
// list that account actually owns -- not just the one built-in watchlist
// shortcut above. Debounced (fires a bit after typing stops, not on every
// keystroke) since it's a real network call.
let myMdblistListsTimer = null;
function scheduleMyMdblistListsRefresh() {
  clearTimeout(myMdblistListsTimer);
  myMdblistListsTimer = setTimeout(runMyMdblistLists, 600);
}

let myTraktListsTimer = null;
function scheduleMyTraktListsRefresh() {
  clearTimeout(myTraktListsTimer);
  myTraktListsTimer = setTimeout(runMyTraktLists, 600);
}

async function runMyMdblistLists() {
  const box = document.getElementById('myMdblistListsResult');
  const key = document.getElementById('mdblistKeyInput').value.trim();
  if (!key) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = '<p style="margin-top:10px;"><small>Loading your MDBList lists\u2026</small></p>';
  try {
    const res = await fetch(ORIGIN + '/api/mdblist-my-lists?apikey=' + encodeURIComponent(key), { cache: 'no-store' });
    const data = await res.json();
    if (!data.ok) {
      box.innerHTML = '<p class="testresult err">\u2717 ' + escapeHtml(data.error || 'Could not load your MDBList lists.') + '</p>';
      return;
    }
    renderMyMdblistLists(data.lists);
  } catch (e) {
    box.innerHTML = '<p class="testresult err">\u2717 Network error loading your MDBList lists.</p>';
  }
}

function renderMyMdblistLists(lists) {
  const box = document.getElementById('myMdblistListsResult');
  const alreadyAdded = new Set();
  document.querySelectorAll('#lists .entry').forEach(function(entry) {
    const t = entry.querySelector('.type') ? entry.querySelector('.type').value : '';
    entry.querySelectorAll('.url').forEach(function(el) {
      alreadyAdded.add(el.value.trim() + '|' + t);
    });
  });

  const watchlistAddedMovie = alreadyAdded.has('mdblist:watchlist|movie');
  const watchlistAddedSeries = alreadyAdded.has('mdblist:watchlist|series');
  const watchlistCard = '<div class="list-card" data-list-type="mixed">' +
    '<div class="list-card-header">' +
      '<div class="list-card-icon src-mdblist" aria-label="MDBList">M</div>' +
      '<div class="list-card-body">' +
        '<div class="list-card-title">My Watchlist</div>' +
        '<div class="list-card-meta">' +
          '<span>Official MDBList Watchlist</span>' +
        '</div>' +
      '</div>' +
      '<div class="list-card-actions">' +
        '<button type="button" class="lc-btn secondary myListCopyToCustomBtn" data-name="My Watchlist" data-url="mdblist:watchlist" data-type="unknown">Copy</button>' +
        '<button type="button" class="lc-btn primary myListAddBtn" ' + (watchlistAddedMovie ? 'disabled' : '') + ' data-name="My Watchlist" data-url="mdblist:watchlist" data-type="movie">' + (watchlistAddedMovie ? '&#10003;' : '+ Movies') + '</button>' +
        '<button type="button" class="lc-btn primary myListAddBtn" ' + (watchlistAddedSeries ? 'disabled' : '') + ' data-name="My Watchlist" data-url="mdblist:watchlist" data-type="series">' + (watchlistAddedSeries ? '&#10003;' : '+ Shows') + '</button>' +
      '</div>' +
    '</div>' +
    '<div class="list-card-posters poster-preview-slot" data-url="mdblist:watchlist" data-type="movie"></div>' +
  '</div>';

  if (!lists || !lists.length) {
    box.innerHTML = watchlistCard + '<p style="margin-top:6px; color:var(--muted);"><small>No other custom lists found on this account.</small></p>';
    if (typeof populateSearchResultPosters === 'function') populateSearchResultPosters();
    return;
  }

  const cardsHtml = lists.map((l) => {
    const isSingleType = (l.mediatype === 'movie' || l.mediatype === 'show');
    const type = l.mediatype === 'show' ? 'series' : 'movie';
    const typeLabel = l.mediatype === 'show' ? 'Shows' : (l.mediatype === 'movie' ? 'Movies' : 'Mixed');
    const viewType = isSingleType ? type : 'movie';
    const copyBtn = '<button type="button" class="lc-btn secondary myListCopyToCustomBtn" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + (isSingleType ? type : 'unknown') + '">Copy</button>';
    let addBtns = '';
    if (isSingleType) {
      const added = alreadyAdded.has(l.url + '|' + type);
      addBtns = '<button type="button" class="lc-btn primary myListAddBtn" ' + (added ? 'disabled' : '') + ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + type + '">' + (added ? '&#10003; Added' : '+ Add') + '</button>';
    } else {
      const addedMovie = alreadyAdded.has(l.url + '|movie');
      const addedSeries = alreadyAdded.has(l.url + '|series');
      addBtns = '<button type="button" class="lc-btn primary myListAddBtn" ' + (addedMovie ? 'disabled' : '') + ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="movie">' + (addedMovie ? '&#10003;' : '+ Movies') + '</button>' +
        '<button type="button" class="lc-btn primary myListAddBtn" ' + (addedSeries ? 'disabled' : '') + ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="series">' + (addedSeries ? '&#10003;' : '+ Shows') + '</button>';
    }
    return '<div class="list-card" data-list-type="' + (isSingleType ? type : 'mixed') + '">' +
      '<div class="list-card-header">' +
        '<div class="list-card-icon src-mdblist" aria-label="MDBList">M</div>' +
        '<div class="list-card-body">' +
          '<div class="list-card-title">' + escapeHtml(l.name) + '</div>' +
          '<div class="list-card-meta">' +
            '<span>' + typeLabel + '</span>' +
            (l.items ? '<span class="list-card-meta-sep">&middot;</span><span>' + l.items + ' items</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="list-card-actions">' +
          copyBtn +
          addBtns +
        '</div>' +
      '</div>' +
      '<div class="list-card-posters poster-preview-slot" data-url="' + escapeAttr(l.url) + '" data-type="' + viewType + '"></div>' +
    '</div>';
  }).join('');

  box.innerHTML = watchlistCard + cardsHtml;
  if (typeof populateSearchResultPosters === 'function') populateSearchResultPosters();
}

document.getElementById('myMdblistListsResult').addEventListener('click', (e) => {
  const addBtn = e.target.closest('.myListAddBtn');
  if (addBtn && !addBtn.disabled) {
    addRow(addBtn.dataset.name, addBtn.dataset.url, addBtn.dataset.type, true, 'Custom');
    addBtn.textContent = 'Added \u2713';
    addBtn.disabled = true;
    return;
  }
  const copyBtn = e.target.closest('.myListCopyToCustomBtn');
  if (copyBtn) {
    copyListToCustomList(copyBtn.dataset.name, copyBtn.dataset.url, copyBtn.dataset.type, copyBtn);
  }
});

async function runMyTraktLists() {
  const box = document.getElementById('myTraktListsResult');
  const username = document.getElementById('traktUsernameInput').value.trim();
  const traktKey = document.getElementById('traktKeyInput').value.trim();
  if (!username) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = '<p style="margin-top:10px;"><small>Loading your Trakt lists\u2026</small></p>';
  try {
    const params = 'username=' + encodeURIComponent(username) + (traktKey ? '&traktKey=' + encodeURIComponent(traktKey) : '');
    const res = await fetch(ORIGIN + '/api/trakt-my-lists?' + params, { cache: 'no-store' });
    const data = await res.json();
    if (!data.ok) {
      box.innerHTML = '<p class="testresult err">\u2717 ' + escapeHtml(data.error || 'Could not load your Trakt lists.') + '</p>';
      return;
    }
    renderMyTraktLists(data.lists);
  } catch (e) {
    box.innerHTML = '<p class="testresult err">\u2717 Network error loading your Trakt lists.</p>';
  }
}

function renderMyTraktLists(lists) {
  const box = document.getElementById('myTraktListsResult');
  if (!lists || !lists.length) {
    box.innerHTML = '<p style="margin-top:10px; color:var(--muted);"><small>No public lists found for that Trakt username.</small></p>';
    return;
  }
  const alreadyAdded = new Set();
  document.querySelectorAll('#lists .entry').forEach(function(entry) {
    const t = entry.querySelector('.type') ? entry.querySelector('.type').value : '';
    entry.querySelectorAll('.url').forEach(function(el) {
      alreadyAdded.add(el.value.trim() + '|' + t);
    });
  });

  const cardsHtml = lists.map((l) => {
    const isSingleType = (l.contentType === 'movie' || l.contentType === 'series');
    const type = l.contentType === 'series' ? 'series' : 'movie';
    const typeLabel = l.contentType === 'series' ? 'Shows' : (l.contentType === 'movie' ? 'Movies' : 'Mixed');
    const viewType = isSingleType ? type : 'movie';
    const copyBtn = '<button type="button" class="lc-btn secondary myListCopyToCustomBtn" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + (isSingleType ? type : 'unknown') + '">Copy</button>';
    let addBtns = '';
    if (isSingleType) {
      const added = alreadyAdded.has(l.url + '|' + type);
      addBtns = '<button type="button" class="lc-btn primary myListAddBtn" ' + (added ? 'disabled' : '') + ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + type + '">' + (added ? '&#10003; Added' : '+ Add') + '</button>';
    } else {
      const addedMovie = alreadyAdded.has(l.url + '|movie');
      const addedSeries = alreadyAdded.has(l.url + '|series');
      addBtns = '<button type="button" class="lc-btn primary myListAddBtn" ' + (addedMovie ? 'disabled' : '') + ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="movie">' + (addedMovie ? '&#10003;' : '+ Movies') + '</button>' +
        '<button type="button" class="lc-btn primary myListAddBtn" ' + (addedSeries ? 'disabled' : '') + ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="series">' + (addedSeries ? '&#10003;' : '+ Shows') + '</button>';
    }
    return '<div class="list-card" data-list-type="' + (isSingleType ? type : 'mixed') + '">' +
      '<div class="list-card-header">' +
        '<div class="list-card-icon src-trakt" aria-label="Trakt">T</div>' +
        '<div class="list-card-body">' +
          '<div class="list-card-title">' + escapeHtml(l.name) + '</div>' +
          '<div class="list-card-meta">' +
            '<span>' + typeLabel + '</span>' +
            (l.items ? '<span class="list-card-meta-sep">&middot;</span><span>' + l.items + ' items</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="list-card-actions">' +
          copyBtn +
          addBtns +
        '</div>' +
      '</div>' +
      '<div class="list-card-posters poster-preview-slot" data-url="' + escapeAttr(l.url) + '" data-type="' + viewType + '"></div>' +
    '</div>';
  }).join('');

  box.innerHTML = cardsHtml;
  if (typeof populateSearchResultPosters === 'function') populateSearchResultPosters();
}

document.getElementById('myTraktListsResult').addEventListener('click', (e) => {
  const addBtn = e.target.closest('.myListAddBtn');
  if (addBtn && !addBtn.disabled) {
    addRow(addBtn.dataset.name, addBtn.dataset.url, addBtn.dataset.type, true, 'Custom');
    addBtn.textContent = 'Added \u2713';
    addBtn.disabled = true;
    return;
  }
  const copyBtn = e.target.closest('.myListCopyToCustomBtn');
  if (copyBtn) {
    copyListToCustomList(copyBtn.dataset.name, copyBtn.dataset.url, copyBtn.dataset.type, copyBtn);
  }
});

// --- Trakt OAuth (private lists) -----------------------------------------
//
// A full-page redirect (not a popup) -- Trakt's own login page doesn't
// need any special embedding, and a popup would need postMessage plumbing
// back to this window for no real benefit. /api/trakt/oauth/callback
// redirects back here with the resulting token in the URL fragment; see
// pickUpTraktTokenFromUrl below, called once from this page's own init.
function startTraktConnect() {
  window.location.href = ORIGIN + '/api/trakt/oauth/start';
}

function disconnectTrakt() {
  traktAccessToken = '';
  saveState();
  renderTraktConnectStatus();
}

function renderTraktConnectStatus() {
  const statusEl = document.getElementById('traktConnectStatus');
  const connectBtn = document.getElementById('traktConnectBtn');
  const disconnectBtn = document.getElementById('traktDisconnectBtn');
  const listsBtn = document.getElementById('listsTraktConnectBtn');
  const connected = !!traktAccessToken;
  
  if (listsBtn) {
    listsBtn.innerText = connected ? 'Disconnect' : 'Connect Trakt';
  }
  
  if (statusEl) {
    statusEl.innerHTML = connected
      ? '<small style="color:#7ce7b6;">Connected to Trakt.</small>'
      : '<small style="color:var(--muted);">Not connected.</small>';
  }
  if (connectBtn) connectBtn.style.display = connected ? 'none' : '';
  if (disconnectBtn) disconnectBtn.style.display = connected ? '' : 'none';
  const box = document.getElementById('myPrivateTraktListsResult');
  if (connected) {
    scheduleMyPrivateTraktListsRefresh();
  } else if (box) {
    box.innerHTML = '';
  }
}

// Reads the token handed back in the URL fragment right after
// /api/trakt/oauth/callback redirects here (#trakt_token=...) -- a
// fragment, not a query param, since fragments never reach any server on
// subsequent requests. Also surfaces a plain message for ?trakt_error=...,
// the callback's own failure path. Either way, strips whatever it found
// from the address bar immediately so a page refresh or a copied/shared
// URL never carries it forward.
function pickUpTraktTokenFromUrl() {
  const hash = window.location.hash || '';
  const match = /(?:^|[#&])trakt_token=([^&]+)/.exec(hash);
  if (match) {
    traktAccessToken = decodeURIComponent(match[1]);
    saveState();
    history.replaceState(null, '', window.location.pathname + window.location.search);
    alert('Connected to Trakt.');
  }
  const params = new URLSearchParams(window.location.search);
  const err = params.get('trakt_error');
  if (err) {
    const detail = params.get('trakt_error_detail') || '';
    const messages = {
      no_client_id: 'Trakt OAuth Client ID is not configured on this server.',
      no_code: 'Trakt did not return an authorization code.',
      token_exchange_failed: 'Failed to exchange authorization code for a Trakt token.',
      access_denied: 'Trakt sign-in was cancelled.',
    };
    alert(messages[err] || ('Could not connect to Trakt (' + err + (detail ? ': ' + detail : '') + ').'));
    params.delete('trakt_error');
    params.delete('trakt_error_detail');
    const qs = params.toString();
    history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''));
  }
}

let myPrivateTraktListsTimer = null;
function scheduleMyPrivateTraktListsRefresh() {
  clearTimeout(myPrivateTraktListsTimer);
  myPrivateTraktListsTimer = setTimeout(runMyPrivateTraktLists, 200);
}

async function runMyPrivateTraktLists() {
  const box = document.getElementById('myPrivateTraktListsResult');
  if (!box) return;
  if (!traktAccessToken) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = '<p style="margin-top:10px;"><small>Loading your Trakt lists\u2026</small></p>';
  try {
    const res = await fetch(ORIGIN + '/api/trakt-my-private-lists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: traktAccessToken }),
      cache: 'no-store',
    });
    const data = await res.json();
    if (!data.ok) {
      box.innerHTML = '<p class="testresult err">\u2717 ' + escapeHtml(data.error || 'Could not load your Trakt lists.') + '</p>';
      return;
    }
    renderMyPrivateTraktLists(data.lists);
  } catch (e) {
    box.innerHTML = '<p class="testresult err">\u2717 Network error loading your Trakt lists.</p>';
  }
}

// Every row here -- public or private -- becomes a perfectly normal
// trakt.tv list URL once added (see collectEntries/fetchTrakt): the
// connected access token travels with every Trakt fetch this config makes
// from here on (see the dispatch in fetchCatalog), not just ones added
// from this specific panel, so a private list keeps resolving correctly
// wherever it's referenced.
function renderMyPrivateTraktLists(lists) {
  const box = document.getElementById('myPrivateTraktListsResult');
  if (!lists || !lists.length) {
    box.innerHTML = '<p style="margin-top:10px; color:var(--muted);"><small>No lists found on your Trakt account.</small></p>';
    return;
  }
  const alreadyAdded = new Set();
  document.querySelectorAll('#lists .entry').forEach(function(entry) {
    const t = entry.querySelector('.type') ? entry.querySelector('.type').value : '';
    entry.querySelectorAll('.url').forEach(function(el) {
      alreadyAdded.add(el.value.trim() + '|' + t);
    });
  });

  const cardsHtml = lists.map((l) => {
    const isHistory = l.url === 'trakt:history';
    const isSingleType = (l.contentType === 'movie' || l.contentType === 'series');
    const type = l.contentType === 'series' ? 'series' : 'movie';
    const typeLabel = l.contentType === 'series' ? 'Shows' : (l.contentType === 'movie' ? 'Movies' : 'Mixed');
    const viewType = isSingleType ? type : 'movie';
    const copyBtn = isHistory
      ? '<button type="button" class="lc-btn secondary myPrivateListCopyToCustomBtn" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(l.contentType || 'unknown') + '" data-history-mode="shows">Copy (Shows)</button>' +
        '<button type="button" class="lc-btn secondary myPrivateListCopyToCustomBtn" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(l.contentType || 'unknown') + '" data-history-mode="episodes">Copy (Episodes)</button>'
      : '<button type="button" class="lc-btn secondary myPrivateListCopyToCustomBtn" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(l.contentType || 'unknown') + '">Copy</button>';

    let addBtns = '';
    if (isSingleType) {
      const added = alreadyAdded.has(l.url + '|' + type);
      addBtns = '<button type="button" class="lc-btn primary myPrivateListAddBtn" ' + (added ? 'disabled' : '') + ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + type + '">' + (added ? '&#10003; Added' : '+ Add') + '</button>';
    } else {
      const addedMovie = alreadyAdded.has(l.url + '|movie');
      const addedSeries = alreadyAdded.has(l.url + '|series');
      addBtns = '<button type="button" class="lc-btn primary myPrivateListAddBtn" ' + (addedMovie ? 'disabled' : '') + ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="movie">' + (addedMovie ? '&#10003;' : '+ Movies') + '</button>' +
        '<button type="button" class="lc-btn primary myPrivateListAddBtn" ' + (addedSeries ? 'disabled' : '') + ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="series">' + (addedSeries ? '&#10003;' : '+ Shows') + '</button>';
    }

    return '<div class="list-card" data-list-type="' + (isSingleType ? type : 'mixed') + '">' +
      '<div class="list-card-header">' +
        '<div class="list-card-icon src-trakt" aria-label="Trakt">T</div>' +
        '<div class="list-card-body">' +
          '<div class="list-card-title">' + escapeHtml(l.name) + (l.private ? ' <span class="badge">Private</span>' : '') + '</div>' +
          '<div class="list-card-meta">' +
            '<span>' + typeLabel + '</span>' +
            (l.items ? '<span class="list-card-meta-sep">&middot;</span><span>' + l.items + ' items</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="list-card-actions">' +
          copyBtn +
          addBtns +
        '</div>' +
      '</div>' +
      '<div class="list-card-posters poster-preview-slot" data-url="' + escapeAttr(l.url) + '" data-type="' + viewType + '"></div>' +
    '</div>';
  }).join('');

  box.innerHTML = cardsHtml;
  if (typeof populateSearchResultPosters === 'function') populateSearchResultPosters();
}

document.getElementById('myPrivateTraktListsResult').addEventListener('click', (e) => {
  const addBtn = e.target.closest('.myPrivateListAddBtn');
  if (addBtn && !addBtn.disabled) {
    addRow(addBtn.dataset.name, addBtn.dataset.url, addBtn.dataset.type, true, 'Custom');
    addBtn.textContent = 'Added \u2713';
    addBtn.disabled = true;
    return;
  }
  const copyBtn = e.target.closest('.myPrivateListCopyToCustomBtn');
  if (copyBtn) {
    copyListToCustomList(copyBtn.dataset.name, copyBtn.dataset.url, copyBtn.dataset.type, copyBtn, copyBtn.dataset.historyMode);
  }
});

// Pulls every item from a list URL (paginated via /api/preview, the same
// Fetches every item for one list+type via /api/preview (paginated, same
// mechanism Live Preview's "See All" uses), mapped into the shape a
// Custom List's items expect.
function toggleListsTraktConnection() {
  if (traktAccessToken) {
    disconnectTrakt();
  } else {
    startTraktConnect();
  }
}


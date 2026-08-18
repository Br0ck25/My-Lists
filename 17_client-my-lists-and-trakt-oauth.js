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
  const keyInput = document.getElementById('mdblistKeyInput');
  const manualKey = keyInput ? keyInput.value.trim() : '';
  const key = manualKey || mdblistAccessToken;
  if (!key) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = '<p style="margin-top:10px;"><small>Loading your MDBList lists\u2026</small></p>';
  try {
    const url = mdblistAccessToken
      ? ORIGIN + '/api/mdblist-my-lists?accessToken=' + encodeURIComponent(mdblistAccessToken)
      : ORIGIN + '/api/mdblist-my-lists?apikey=' + encodeURIComponent(manualKey);
    const res = await fetch(url, { cache: 'no-store' });
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
  if (!lists || !lists.length) {
    box.innerHTML = '<p style="margin-top:10px; color:var(--muted);"><small>No lists found on your MDBList account.</small></p>';
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
    const isHistory = l.slug === 'history' || l.url === 'mdblist:history' || String(l.url || '').indexOf('mdblist:history') !== -1 || String(l.url || '').indexOf('/history/') !== -1;
    const isWatchlist = l.slug === 'watchlist' || l.url === 'mdblist:watchlist';
    const isSingleType = !isHistory && !isWatchlist && (l.contentType === 'movie' || l.contentType === 'series');
    const type = l.contentType === 'series' ? 'series' : 'movie';
    const typeLabel = isHistory ? 'Watch History' : (isWatchlist ? 'Watchlist' : (l.contentType === 'series' ? 'Shows' : (l.contentType === 'movie' ? 'Movies' : 'Mixed')));
    const viewType = isSingleType ? type : 'mixed';
    const copyBtn = isHistory
      ? '<button type="button" class="lc-btn secondary myListCopyToCustomBtn" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(l.contentType || 'unknown') + '" data-history-mode="shows">Copy (Shows)</button>' +
        '<button type="button" class="lc-btn secondary myListCopyToCustomBtn" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(l.contentType || 'unknown') + '" data-history-mode="episodes">Copy (Episodes)</button>' +
        '<button type="button" class="lc-btn secondary" onclick="markMdblistHistoryAllWatched(this)">Mark all as Watched</button>'
      : '<button type="button" class="lc-btn secondary myListCopyToCustomBtn" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(l.contentType || 'unknown') + '">Copy</button>';

    let addBtns = '';
    if (isSingleType) {
      const added = alreadyAdded.has(l.url + '|' + type);
      addBtns = '<button type="button" class="lc-btn primary myListAddBtn" ' + (added ? 'disabled' : '') + ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + type + '">' + (added ? '&#10003; Added' : '+ Add') + '</button>';
    } else {
      const addedMovie = alreadyAdded.has(l.url + '|movie');
      const addedSeries = alreadyAdded.has(l.url + '|series');
      addBtns = '<button type="button" class="lc-btn primary myListAddBtn" ' + (addedMovie ? 'disabled' : '') + ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + movieType(l) + '">' + (addedMovie ? '&#10003;' : '+ Movies') + '</button>' +
        '<button type="button" class="lc-btn primary myListAddBtn" ' + (addedSeries ? 'disabled' : '') + ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="series">' + (addedSeries ? '&#10003;' : '+ Shows') + '</button>';
    }

    function movieType(item) {
      return 'movie';
    }

    return '<div class="list-card" data-list-type="' + (isSingleType ? type : 'mixed') + '">' +
      '<div class="list-card-header">' +
        '<div class="list-card-body">' +
          '<div class="list-card-title">' + escapeHtml(l.name) + (l.private && !isWatchlist && !isHistory ? ' <span class="badge">Private</span>' : '') + '</div>' +
          '<div class="list-card-meta">' +
            '<span>' + typeLabel + '</span>' +
            (l.items ? '<span class="list-card-meta-sep">&middot;</span><span>' + l.items + ' items</span>' : '') +
            (!isHistory && !isWatchlist ? '<span class="list-card-meta-sep">&middot;</span><span>&#9829; ' + (l.likes || 0) + '</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="list-card-actions">' +
          copyBtn +
          addBtns +
        '</div>' +
      '</div>' +
      '<div class="list-card-posters poster-preview-slot" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + (isSingleType ? type : 'mixed') + '"></div>' +
    '</div>';
  }).join('');

  box.innerHTML = cardsHtml;
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
    copyListToCustomList(copyBtn.dataset.name, copyBtn.dataset.url, copyBtn.dataset.type, copyBtn, copyBtn.dataset.historyMode);
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
    const viewType = isSingleType ? type : 'mixed';
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
        '<div class="list-card-body">' +
          '<div class="list-card-title">' + escapeHtml(l.name) + '</div>' +
          '<div class="list-card-meta">' +
            '<span>' + typeLabel + '</span>' +
            (l.items ? '<span class="list-card-meta-sep">&middot;</span><span>' + l.items + ' items</span>' : '') +
            '<span class="list-card-meta-sep">&middot;</span><span>&#9829; ' + (l.likes || 0) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="list-card-actions">' +
          copyBtn +
          addBtns +
        '</div>' +
      '</div>' +
      '<div class="list-card-posters poster-preview-slot" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + viewType + '"></div>' +
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

// --- MDBList OAuth (Connect MDBList) --------------------------------------
function startMdblistConnect() {
  window.location.href = ORIGIN + '/api/mdblist/oauth/start';
}

function disconnectMdblist() {
  const input = document.getElementById('mdblistKeyInput');
  if (input) input.value = '';
  mdblistAccessToken = '';
  try {
    localStorage.removeItem('myListAddon:mdblistAccessToken');
    localStorage.removeItem('myListAddon:mdblistUsername');
    localStorage.removeItem('myListAddon:mdblistKey');
  } catch (e) {}
  saveState();
  renderMdblistConnectStatus();
  scheduleMyMdblistListsRefresh();
}

function toggleListsMdblistConnection() {
  if (mdblistAccessToken) {
    disconnectMdblist();
  } else {
    startMdblistConnect();
  }
}

function renderMdblistConnectStatus() {
  const input = document.getElementById('mdblistKeyInput');
  const statusEl = document.getElementById('mdblistConnectStatus');
  const connectBtn = document.getElementById('mdblistConnectBtn');
  const disconnectBtn = document.getElementById('mdblistDisconnectBtn');
  const listsBtn = document.getElementById('listsMdblistConnectBtn');
  const token = mdblistAccessToken || '';
  const user = (typeof mdblistUsername !== 'undefined' && mdblistUsername) || localStorage.getItem('myListAddon:mdblistUsername') || '';
  const key = (input ? input.value.trim() : '') || localStorage.getItem('myListAddon:mdblistKey') || '';
  const connected = !!(token || key);
  
  if (listsBtn) {
    listsBtn.innerText = connected ? 'Disconnect' : 'Connect MDBList';
  }
  
  if (statusEl) {
    if (token && user) {
      statusEl.innerHTML = '<span style="color:#7ce7b6; font-weight:600;">\u2713 Connected as @' + escapeHtml(user) + '</span>';
    } else if (token) {
      statusEl.innerHTML = '<span style="color:#7ce7b6; font-weight:600;">\u2713 Connected to MDBList</span>';
    } else if (key) {
      statusEl.innerHTML = '<span style="color:#7ce7b6; font-weight:600;">\u2713 Custom MDBList API Key configured</span>';
    } else {
      statusEl.innerHTML = '<span style="color:var(--muted);">Not connected.</span>';
    }
  }
  if (connectBtn) connectBtn.textContent = token ? 'Re-connect MDBList' : (key ? 'Update Key' : 'Connect MDBList Account');
  if (disconnectBtn) disconnectBtn.style.display = connected ? '' : 'none';
  if (connected) {
    scheduleMyMdblistListsRefresh();
  }
}

function pickUpMdblistTokenFromUrl() {
  const hash = window.location.hash || '';
  const match = /(?:^|[#&])mdblist_token=([^&]+)/.exec(hash);
  if (match) {
    mdblistAccessToken = decodeURIComponent(match[1]);
    const userMatch = /(?:^|[#&])mdblist_username=([^&]+)/.exec(hash);
    if (userMatch) {
      const user = decodeURIComponent(userMatch[1]);
      try {
        localStorage.setItem('myListAddon:mdblistUsername', user);
      } catch (e) {}
    }
    saveState();
    history.replaceState(null, '', window.location.pathname + window.location.search);
    if (typeof showAppAlert === 'function') {
      showAppAlert('MDBList Connected', 'Your MDBList account was successfully connected.', true);
    } else {
      alert('Connected to MDBList.');
    }
    renderMdblistConnectStatus();
  }
  const params = new URLSearchParams(window.location.search);
  const err = params.get('mdblist_error');
  if (err) {
    const detail = params.get('mdblist_error_detail') || '';
    const messages = {
      not_configured: 'MDBList OAuth (MDBLIST_CLIENT_ID / MDBLIST_CLIENT_SECRET) is not configured in Cloudflare Secrets yet.',
      no_code: 'MDBList did not return an authorization code.',
      exchange_failed: 'Failed to exchange authorization code for an MDBList token.',
      access_denied: 'MDBList sign-in was cancelled.',
      state_mismatch: 'MDBList sign-in state mismatch. Please try again.',
      no_token: 'MDBList did not return an access token.',
      network: 'Network error connecting to MDBList.',
    };
    const msg = messages[err] || ('Could not connect to MDBList (' + err + (detail ? ': ' + detail : '') + ').');
    if (typeof showAppAlert === 'function') {
      showAppAlert('MDBList Connection Error', msg + (detail ? '\\n\\nDetails: ' + detail : ''), false);
    } else {
      alert(msg + (detail ? '\\n' + detail : ''));
    }
    params.delete('mdblist_error');
    params.delete('mdblist_error_detail');
    const qs = params.toString();
    history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''));
  }
}

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
  const keyInput = document.getElementById('traktKeyInput');
  if (keyInput) keyInput.value = '';
  const userInput = document.getElementById('traktUsernameInput');
  if (userInput) userInput.value = '';
  traktAccessToken = '';
  try {
    localStorage.removeItem('myListAddon:traktAccessToken');
    localStorage.removeItem('myListAddon:traktUsername');
    localStorage.removeItem('myListAddon:traktKey');
  } catch (e) {}
  saveState();
  renderTraktConnectStatus();
  const box = document.getElementById('myPrivateTraktListsResult');
  if (box) box.innerHTML = '';
}

function renderTraktConnectStatus() {
  const keyInput = document.getElementById('traktKeyInput');
  const userInput = document.getElementById('traktUsernameInput');
  const statusEl = document.getElementById('traktConnectStatus');
  const connectBtn = document.getElementById('traktConnectBtn');
  const disconnectBtn = document.getElementById('traktDisconnectBtn');
  const listsBtn = document.getElementById('listsTraktConnectBtn');
  const token = traktAccessToken || '';
  const user = (userInput ? userInput.value.trim() : '') || localStorage.getItem('myListAddon:traktUsername') || '';
  const key = (keyInput ? keyInput.value.trim() : '') || localStorage.getItem('myListAddon:traktKey') || '';
  const connected = !!(token || key || user);
  
  if (listsBtn) {
    listsBtn.innerText = connected ? 'Disconnect' : 'Connect Trakt';
  }
  
  if (statusEl) {
    if (token && user) {
      statusEl.innerHTML = '<span style="color:#7ce7b6; font-weight:600;">\u2713 Connected as @' + escapeHtml(user) + '</span>';
    } else if (token) {
      statusEl.innerHTML = '<span style="color:#7ce7b6; font-weight:600;">\u2713 Connected to Trakt</span>';
    } else if (key || user) {
      statusEl.innerHTML = '<span style="color:#7ce7b6; font-weight:600;">\u2713 Custom Trakt Client ID configured' + (user ? ' (@' + escapeHtml(user) + ')' : '') + '</span>';
    } else {
      statusEl.innerHTML = '<span style="color:var(--muted);">Not connected.</span>';
    }
  }
  if (connectBtn) connectBtn.textContent = token ? 'Re-connect Trakt' : (key ? 'Update Client ID' : 'Connect Trakt Account');
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
    const userMatch = /(?:^|[#&])trakt_username=([^&]+)/.exec(hash);
    if (userMatch) {
      const user = decodeURIComponent(userMatch[1]);
      try {
        localStorage.setItem('myListAddon:traktUsername', user);
      } catch (e) {}
      const uInput = document.getElementById('traktUsernameInput');
      if (uInput) uInput.value = user;
    }
    saveState();
    history.replaceState(null, '', window.location.pathname + window.location.search);
    if (typeof showAppAlert === 'function') {
      showAppAlert('Trakt Connected', 'Connected to Trakt.', true);
    } else {
      alert('Connected to Trakt.');
    }
    renderTraktConnectStatus();
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
    const msg = messages[err] || ('Could not connect to Trakt (' + err + (detail ? ': ' + detail : '') + ').');
    if (typeof showAppAlert === 'function') {
      showAppAlert('Trakt Connection Error', msg, false);
    } else {
      alert(msg);
    }
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
    const viewType = isSingleType ? type : 'mixed';
    const copyBtn = isHistory
      ? '<button type="button" class="lc-btn secondary myPrivateListCopyToCustomBtn" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(l.contentType || 'unknown') + '" data-history-mode="shows">Copy (Shows)</button>' +
        '<button type="button" class="lc-btn secondary myPrivateListCopyToCustomBtn" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(l.contentType || 'unknown') + '" data-history-mode="episodes">Copy (Episodes)</button>' +
        // Marks every watched movie/episode straight into this add-on's
        // own Watch History (and Continue Watching, for shows) -- unlike
        // the Copy buttons above, which just duplicate the data into a
        // browsable Custom List, this actually feeds the watched-tracking
        // system itself. See markTraktHistoryAllWatched.
        '<button type="button" class="lc-btn secondary" onclick="markTraktHistoryAllWatched(this)">Mark all as Watched</button>'
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
        '<div class="list-card-body">' +
          '<div class="list-card-title">' + escapeHtml(l.name) + (l.private ? ' <span class="badge">Private</span>' : '') + '</div>' +
          '<div class="list-card-meta">' +
            '<span>' + typeLabel + '</span>' +
            (l.items ? '<span class="list-card-meta-sep">&middot;</span><span>' + l.items + ' items</span>' : '') +
            '<span class="list-card-meta-sep">&middot;</span><span>&#9829; ' + (l.likes || 0) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="list-card-actions">' +
          copyBtn +
          addBtns +
        '</div>' +
      '</div>' +
      '<div class="list-card-posters poster-preview-slot" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + viewType + '"></div>' +
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

// --- TMDB Account / API Key Connection -----------------------------------
let tmdbSessionId = '';
let tmdbAccountId = '';
let tmdbUsername = '';

function startTmdbConnect() {
  window.location.href = ORIGIN + '/api/tmdb/oauth/start';
}

function toggleListsTmdbConnection() {
  if (tmdbSessionId || localStorage.getItem('myListAddon:tmdbSessionId')) {
    disconnectTmdb();
  } else {
    startTmdbConnect();
  }
}

function onTmdbKeyInputChanged() {
  const input = document.getElementById('tmdbKeyInput');
  const val = input ? input.value.trim() : '';
  if (val) {
    localStorage.setItem('myListAddon:tmdbKey', val);
  } else {
    localStorage.removeItem('myListAddon:tmdbKey');
  }
  renderTmdbConnectStatus();
  scheduleMyTmdbListsRefresh();
}

async function testTmdbConnection() {
  const input = document.getElementById('tmdbKeyInput');
  const statusEl = document.getElementById('tmdbConnectStatus');
  const key = (input ? input.value.trim() : '') || localStorage.getItem('myListAddon:tmdbKey') || '';
  if (!key) {
    if (statusEl) statusEl.innerHTML = '<span style="color:#ff6b6b;">Please enter your TMDB API Key or Access Token first.</span>';
    return;
  }
  if (statusEl) statusEl.innerHTML = '<span style="color:var(--muted);">Testing TMDB connection\u2026</span>';
  try {
    const res = await fetch(ORIGIN + '/api/tmdb-search-lists?q=star&tmdbKey=' + encodeURIComponent(key));
    const data = await res.json();
    if (data.ok) {
      localStorage.setItem('myListAddon:tmdbKey', key);
      saveState();
      if (statusEl) statusEl.innerHTML = '<span style="color:#7ce7b6; font-weight:600;">\u2713 TMDB API Key verified and active.</span>';
      renderTmdbConnectStatus();
      scheduleMyTmdbListsRefresh();
    } else {
      if (statusEl) statusEl.innerHTML = '<span style="color:#ff6b6b;">\u2717 Invalid TMDB Key: ' + escapeHtml(data.error || 'Check your key and try again.') + '</span>';
    }
  } catch (e) {
    if (statusEl) statusEl.innerHTML = '<span style="color:#ff6b6b;">\u2717 Network error testing TMDB key.</span>';
  }
}

function disconnectTmdb() {
  const input = document.getElementById('tmdbKeyInput');
  if (input) input.value = '';
  tmdbSessionId = '';
  tmdbAccountId = '';
  tmdbUsername = '';
  localStorage.removeItem('myListAddon:tmdbKey');
  localStorage.removeItem('myListAddon:tmdbSessionId');
  localStorage.removeItem('myListAddon:tmdbAccountId');
  localStorage.removeItem('myListAddon:tmdbUsername');
  saveState();
  renderTmdbConnectStatus();
  scheduleMyTmdbListsRefresh();
}

function pickUpTmdbTokenFromUrl() {
  const hash = window.location.hash || '';
  if (hash.startsWith('#') && hash.includes('tmdb_session=')) {
    const params = new URLSearchParams(hash.slice(1));
    const sess = params.get('tmdb_session');
    const acc = params.get('tmdb_account');
    const user = params.get('tmdb_user');
    if (sess) {
      tmdbSessionId = sess;
      tmdbAccountId = acc || '';
      tmdbUsername = user || '';
      localStorage.setItem('myListAddon:tmdbSessionId', tmdbSessionId);
      if (tmdbAccountId) localStorage.setItem('myListAddon:tmdbAccountId', tmdbAccountId);
      if (tmdbUsername) localStorage.setItem('myListAddon:tmdbUsername', tmdbUsername);
      saveState();
      params.delete('tmdb_session');
      params.delete('tmdb_account');
      params.delete('tmdb_user');
      const rem = params.toString();
      history.replaceState(null, '', window.location.pathname + window.location.search + (rem ? '#' + rem : ''));
      renderTmdbConnectStatus();
      scheduleMyTmdbListsRefresh();
    }
  }

  const search = new URLSearchParams(window.location.search);
  const err = search.get('tmdb_error');
  if (err) {
    const detail = search.get('tmdb_error_detail') || '';
    const msg = 'Could not connect to TMDB (' + err + (detail ? ': ' + detail : '') + ').';
    if (typeof showAppAlert === 'function') {
      showAppAlert('TMDB Connection Error', msg, false);
    } else {
      alert(msg);
    }
    search.delete('tmdb_error');
    search.delete('tmdb_error_detail');
    const qs = search.toString();
    history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : '') + window.location.hash);
  }
}

function renderTmdbConnectStatus() {
  const input = document.getElementById('tmdbKeyInput');
  const statusEl = document.getElementById('tmdbConnectStatus');
  const connectBtn = document.getElementById('tmdbConnectBtn');
  const disconnectBtn = document.getElementById('tmdbDisconnectBtn');
  const listsConnectBtn = document.getElementById('listsTmdbConnectBtn');

  const sess = tmdbSessionId || localStorage.getItem('myListAddon:tmdbSessionId') || '';
  const user = tmdbUsername || localStorage.getItem('myListAddon:tmdbUsername') || '';
  const key = (input ? input.value.trim() : '') || localStorage.getItem('myListAddon:tmdbKey') || '';
  const connected = !!(sess || key);

  if (statusEl) {
    if (sess && user) {
      statusEl.innerHTML = '<span style="color:#7ce7b6; font-weight:600;">\u2713 Connected as @' + escapeHtml(user) + '</span>';
    } else if (sess) {
      statusEl.innerHTML = '<span style="color:#7ce7b6; font-weight:600;">\u2713 TMDB Account Connected</span>';
    } else if (key) {
      statusEl.innerHTML = '<span style="color:#7ce7b6;">\u2713 Custom TMDB Key configured</span>';
    } else {
      statusEl.innerHTML = '<span style="color:var(--muted);">Not connected</span>';
    }
  }

  if (connectBtn) connectBtn.textContent = sess ? 'Re-connect TMDB' : (key ? 'Update Key' : 'Connect TMDB Account');
  if (disconnectBtn) disconnectBtn.style.display = connected ? '' : 'none';
  if (listsConnectBtn) listsConnectBtn.textContent = connected ? 'Disconnect TMDB' : 'Connect TMDB';
}

let myTmdbListsTimer = null;
function scheduleMyTmdbListsRefresh() {
  clearTimeout(myTmdbListsTimer);
  myTmdbListsTimer = setTimeout(runMyTmdbLists, 600);
}

async function runMyTmdbLists() {
  const box = document.getElementById('myTmdbListsResult');
  if (!box) return;
  const sess = tmdbSessionId || localStorage.getItem('myListAddon:tmdbSessionId') || '';
  const acc = tmdbAccountId || localStorage.getItem('myListAddon:tmdbAccountId') || '';
  const input = document.getElementById('tmdbKeyInput');
  const key = (input ? input.value.trim() : '') || localStorage.getItem('myListAddon:tmdbKey') || '';

  if (!sess && !acc) {
    box.innerHTML = '<p style="margin-top:10px; color:var(--muted);"><small>Connect your TMDB account in Settings or click <strong>Connect TMDB</strong> above to see your personal lists, watchlist, and favorites here.</small></p>';
    return;
  }

  box.innerHTML = '<p style="margin-top:10px;"><small>Loading your TMDB lists\u2026</small></p>';
  try {
    const params = new URLSearchParams();
    if (sess) params.set('sessionId', sess);
    if (acc) params.set('accountId', acc);
    if (key) params.set('tmdbKey', key);

    const res = await fetch(ORIGIN + '/api/tmdb-my-lists?' + params.toString(), { cache: 'no-store' });
    let data;
    try {
      data = await res.json();
    } catch {
      data = { ok: false, error: 'Server returned HTTP ' + res.status };
    }
    if (!data.ok) {
      box.innerHTML = '<p class="testresult err">\u2717 ' + escapeHtml(data.error || 'Could not load your TMDB lists.') + '</p>';
      return;
    }
    renderMyTmdbLists(data.lists);
  } catch (e) {
    box.innerHTML = '<p class="testresult err">\u2717 Network error loading your TMDB lists: ' + escapeHtml(e && e.message ? e.message : String(e)) + '</p>';
  }
}

function renderMyTmdbLists(lists) {
  const box = document.getElementById('myTmdbListsResult');
  if (!box) return;
  if (!lists || !lists.length) {
    box.innerHTML = '<p style="margin-top:10px; color:var(--muted);"><small>No lists found on your TMDB account.</small></p>';
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
    const listIdStr = String(l.id || '');
    const listUrlStr = String(l.url || '');
    const isWatchlist = listIdStr.includes('watchlist') || listUrlStr.includes('watchlist');
    const isFavorites = listIdStr.includes('favorites') || listUrlStr.includes('favorites');
    const isSingleType = l.contentType === 'movie' || l.contentType === 'series';
    const type = l.contentType === 'series' ? 'series' : 'movie';
    const typeLabel = isWatchlist ? 'Watchlist' : (isFavorites ? 'Favorites' : (l.contentType === 'series' ? 'Shows' : (l.contentType === 'movie' ? 'Movies' : 'Mixed')));

    const copyBtn = '<button type="button" class="lc-btn secondary myListCopyToCustomBtn" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(l.contentType || 'mixed') + '">Copy</button>';

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

    const previewItems = (l.previewItems || []).filter(it => it.poster);
    let posterThumbs = '';
    if (previewItems.length) {
      const totalCount = l.items || previewItems.length;
      posterThumbs = '<div class="list-card-posters poster-preview-static">' +
        previewItems.map((it, i) => {
          const isMobileEnd = (i === 2 && previewItems.length > 3);
          const isDesktopEnd = (i === previewItems.length - 1 && previewItems.length >= 4);
          let overlays = '';
          if (isMobileEnd) {
            overlays += '<div class="list-card-count-overlay mobile-only" style="cursor:default;">' + totalCount + ' &rsaquo;</div>';
          }
          if (isDesktopEnd) {
            overlays += '<div class="list-card-count-overlay desktop-only" style="cursor:default;">' + totalCount + ' &rsaquo;</div>';
          }
          const posterType = it.type || (l.contentType === 'series' ? 'series' : 'movie');
          return '<div class="list-card-mini-poster-tile">' +
            '<div class="list-card-mini-poster-img-wrap">' +
              '<img src="' + escapeAttr(it.poster) + '" class="clickable-poster" data-id="' + escapeAttr(it.id) + '" data-type="' + escapeAttr(posterType) + '" alt="" loading="lazy">' +
              overlays +
            '</div>' +
            '<div class="list-card-mini-poster-name">' + escapeHtml(it.title || '') + '</div>' +
            (it.year ? '<div class="list-card-mini-poster-year">' + escapeHtml(it.year) + '</div>' : '') +
          '</div>';
        }).join('') +
      '</div>';
    }

    return '<div class="list-card" data-list-type="' + (isSingleType ? type : 'mixed') + '">' +
      '<div class="list-card-header">' +
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
      posterThumbs +
    '</div>';
  }).join('');

  box.innerHTML = cardsHtml;
}

document.getElementById('myTmdbListsResult')?.addEventListener('click', (e) => {
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
    return;
  }
  const posterImg = e.target.closest('.clickable-poster');
  if (posterImg && posterImg.dataset.id) {
    if (typeof openItemDetailsModal === 'function') {
      openItemDetailsModal(posterImg.dataset.id, posterImg.dataset.type);
    }
  }
});

function updateConnectionStatusBadges() {
  if (typeof renderTmdbConnectStatus === 'function') renderTmdbConnectStatus();
  if (typeof renderTraktConnectStatus === 'function') renderTraktConnectStatus();
  if (typeof renderMdblistConnectStatus === 'function') renderMdblistConnectStatus();
}




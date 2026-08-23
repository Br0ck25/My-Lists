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
  if (!box) return;
  const keyInput = document.getElementById('mdblistKeyInput');
  const manualKey = keyInput ? keyInput.value.trim() : '';
  const key = manualKey || mdblistAccessToken || localStorage.getItem('myListAddon:mdblistAccessToken') || '';
  if (!key) {
    box.innerHTML = '<p style="margin-top:10px; color:var(--muted);"><small>Connect your MDBList account in Settings or click <strong>Connect MDBList</strong> above to see your personal lists, watchlist, and watch history here.</small></p>';
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
  window._myMdblistLists = lists || [];
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
      ? '<button type="button" class="lc-btn secondary myListCopyToCustomBtn" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="mixed">Copy</button>' +
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

    const isCustomUserList = !isHistory && !isWatchlist && !l.dynamic;
    const deleteBtn = isCustomUserList ? '<button type="button" class="lc-btn secondary myListDeleteBtn" style="color:var(--danger); border-color:var(--danger);" data-provider="mdblist" data-list-id="' + escapeAttr(l.id || l.slug) + '" data-name="' + escapeAttr(l.name) + '">Delete</button>' : '';

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
          deleteBtn +
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
    return;
  }
  const deleteBtn = e.target.closest('.myListDeleteBtn');
  if (deleteBtn && !deleteBtn.disabled && typeof deleteExternalListDirect === 'function') {
    deleteExternalListDirect(deleteBtn.dataset.provider, deleteBtn.dataset.listId, deleteBtn.dataset.name, deleteBtn);
    return;
  }
});

async function runMyTraktLists() {
  const box = document.getElementById('myTraktListsResult');
  if (!box) return;
  const username = document.getElementById('traktUsernameInput') ? document.getElementById('traktUsernameInput').value.trim() : '';
  const traktKey = document.getElementById('traktKeyInput') ? document.getElementById('traktKeyInput').value.trim() : '';
  const token = traktAccessToken || localStorage.getItem('myListAddon:traktAccessToken') || '';
  if (!username && !token) {
    box.innerHTML = '<p style="margin-top:10px; color:var(--muted);"><small>Connect your Trakt account in Settings or click <strong>Connect Trakt</strong> above to see your personal lists, watchlist, and watch history here.</small></p>';
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
  window._myTraktLists = lists || [];
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
    const isCustomUserList = l.slug !== 'watchlist' && l.url !== 'trakt:watchlist';
    const traktListId = (l.ids && l.ids.trakt) || l.id || l.slug || '';
    const deleteBtn = isCustomUserList ? '<button type="button" class="lc-btn secondary myListDeleteBtn" style="color:var(--danger); border-color:var(--danger);" data-provider="trakt" data-list-id="' + escapeAttr(traktListId) + '" data-name="' + escapeAttr(l.name) + '">Delete</button>' : '';

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
          deleteBtn +
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
    return;
  }
  const deleteBtn = e.target.closest('.myListDeleteBtn');
  if (deleteBtn && !deleteBtn.disabled && typeof deleteExternalListDirect === 'function') {
    deleteExternalListDirect(deleteBtn.dataset.provider, deleteBtn.dataset.listId, deleteBtn.dataset.name, deleteBtn);
    return;
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
  const token = (typeof mdblistAccessToken !== 'undefined' && mdblistAccessToken) || localStorage.getItem('myListAddon:mdblistAccessToken') || '';
  if (token) mdblistAccessToken = token;
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

  const syncCb = document.getElementById('syncMdblistHistoryCheckbox');
  if (syncCb) syncCb.checked = localStorage.getItem('myListAddon:syncMdblistHistory') === 'true';
  const syncWrap = document.getElementById('mdblistSyncHistoryWrap');
  if (syncWrap) syncWrap.style.display = connected ? '' : 'none';

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
      mdblistUsername = decodeURIComponent(userMatch[1]);
      try {
        localStorage.setItem('myListAddon:mdblistUsername', mdblistUsername);
      } catch (e) {}
    }
    try {
      localStorage.setItem('myListAddon:mdblistAccessToken', mdblistAccessToken);
    } catch (e) {}
    saveState();
    history.replaceState(null, '', window.location.pathname + window.location.search);
    if (typeof showAppAlert === 'function') {
      showAppAlert('MDBList Connected', 'Connected to MDBList.', true);
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
  const token = (typeof traktAccessToken !== 'undefined' && traktAccessToken) || localStorage.getItem('myListAddon:traktAccessToken') || '';
  if (token) traktAccessToken = token;
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

  const syncCb = document.getElementById('syncTraktHistoryCheckbox');
  if (syncCb) syncCb.checked = localStorage.getItem('myListAddon:syncTraktHistory') === 'true';
  const syncWrap = document.getElementById('traktSyncHistoryWrap');
  if (syncWrap) syncWrap.style.display = connected ? '' : 'none';

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
    const isRateLimit = detail.includes('1015') || detail.includes('429') || err === 'exchange_failed';
    const msg = isRateLimit 
      ? 'Trakt web redirect was rate-limited by Cloudflare (1015). Opening direct PIN code activation instead...'
      : (messages[err] || ('Could not connect to Trakt (' + err + (detail ? ': ' + detail : '') + ').'));

    if (typeof showAppAlert === 'function') {
      showAppAlert('Trakt Connection', msg, !isRateLimit);
    } else {
      alert(msg);
    }
    params.delete('trakt_error');
    params.delete('trakt_error_detail');
    const qs = params.toString();
    history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''));

    if (isRateLimit) {
      setTimeout(() => {
        startTraktDeviceLogin();
      }, 500);
    }
  }
}

let _traktDevicePollTimer = null;

function closeTraktDeviceModal() {
  if (_traktDevicePollTimer) {
    clearInterval(_traktDevicePollTimer);
    _traktDevicePollTimer = null;
  }
  const modal = document.getElementById('traktDeviceModal');
  if (modal) modal.style.display = 'none';
}

async function startTraktDeviceLogin() {
  const modal = document.getElementById('traktDeviceModal');
  const codeEl = document.getElementById('traktDeviceUserCode');
  const statusEl = document.getElementById('traktDevicePollingStatus');
  const linkEl = document.getElementById('traktDeviceActivateLink');
  const traktKey = (document.getElementById('traktKeyInput')?.value.trim()) || localStorage.getItem('myListAddon:traktKey') || '';
  
  if (modal) modal.style.display = 'flex';
  if (codeEl) codeEl.innerText = 'LOADING...';
  if (statusEl) statusEl.innerText = 'Requesting activation code from Trakt...';

  try {
    const res = await fetch(ORIGIN + '/api/trakt/device/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ traktKey: traktKey }),
    });
    const data = await res.json();
    if (!data.ok || !data.user_code) {
      if (codeEl) codeEl.innerText = 'ERROR';
      if (statusEl) {
        statusEl.innerHTML = '<span style="color:var(--danger);">' + escapeHtml(data.error || 'Could not get device code.') + '</span> <button type="button" class="lc-btn secondary" style="margin-left:8px; padding:3px 8px; font-size:0.75rem;" onclick="startTraktDeviceLogin()">Try Again</button>';
      }
      return;
    }

    if (codeEl) codeEl.innerText = data.user_code;
    if (linkEl) {
      linkEl.href = data.verification_url || 'https://trakt.tv/activate';
    }
    if (statusEl) {
      statusEl.innerHTML = '<span style="color:var(--accent); font-weight:600;">Code ready!</span> Enter code at trakt.tv/activate &bull; Waiting for approval...';
    }

    const deviceCode = data.device_code;
    const intervalSec = Math.max(4, data.interval || 5);
    const expiresAt = Date.now() + ((data.expires_in || 600) * 1000);

    if (_traktDevicePollTimer) clearInterval(_traktDevicePollTimer);

    _traktDevicePollTimer = setInterval(async () => {
      if (Date.now() > expiresAt) {
        clearInterval(_traktDevicePollTimer);
        _traktDevicePollTimer = null;
        if (statusEl) statusEl.innerHTML = 'Activation code expired. <button type="button" class="lc-btn secondary" style="margin-left:8px; padding:3px 8px; font-size:0.75rem;" onclick="startTraktDeviceLogin()">Get New Code</button>';
        return;
      }

      try {
        const pollRes = await fetch(ORIGIN + '/api/trakt/device/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: deviceCode, traktKey: traktKey }),
        });
        const pollData = await pollRes.json();

        if (pollData.ok && pollData.access_token) {
          clearInterval(_traktDevicePollTimer);
          _traktDevicePollTimer = null;
          traktAccessToken = pollData.access_token;
          try {
            localStorage.setItem('myListAddon:traktAccessToken', traktAccessToken);
          } catch(e) {}
          if (pollData.username) {
            try {
              localStorage.setItem('myListAddon:traktUsername', pollData.username);
            } catch(e) {}
            const uInput = document.getElementById('traktUsernameInput');
            if (uInput) uInput.value = pollData.username;
          }
          saveState();
          closeTraktDeviceModal();
          if (typeof showAppAlert === 'function') {
            showAppAlert('Trakt Connected', 'Successfully connected to Trakt' + (pollData.username ? ' as @' + pollData.username : '') + '.', true);
          }
          renderTraktConnectStatus();
        } else if (pollData.pending) {
          // Still waiting for user confirmation
        } else if (pollData.slowDown) {
          // Slow down polling
        } else if (pollData.error && !pollData.pending) {
          clearInterval(_traktDevicePollTimer);
          _traktDevicePollTimer = null;
          if (statusEl) statusEl.innerText = pollData.error;
        }
      } catch (e) {}
    }, intervalSec * 1000);

  } catch (err) {
    if (codeEl) codeEl.innerText = 'ERROR';
    if (statusEl) statusEl.innerHTML = 'Network error requesting device code. <button type="button" class="lc-btn secondary" style="margin-left:8px; padding:3px 8px; font-size:0.75rem;" onclick="startTraktDeviceLogin()">Try Again</button>';
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
    const isHistory = l.url === 'trakt:history' || l.slug === 'history';
    const isWatchlist = l.url === 'trakt:watchlist' || l.slug === 'watchlist';
    const isSingleType = (l.contentType === 'movie' || l.contentType === 'series');
    const type = l.contentType === 'series' ? 'series' : 'movie';
    const typeLabel = isHistory ? 'Watch History' : (isWatchlist ? 'Watchlist' : (l.contentType === 'series' ? 'Shows' : (l.contentType === 'movie' ? 'Movies' : 'Mixed')));
    const viewType = isSingleType ? type : 'mixed';
    const copyBtn = isHistory
      ? '<button type="button" class="lc-btn secondary myPrivateListCopyToCustomBtn" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="mixed">Copy</button>' +
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

    const isCustomUserList = !isHistory && !isWatchlist;
    const traktListId = (l.ids && l.ids.trakt) || l.id || l.slug || '';
    const deleteBtn = isCustomUserList ? '<button type="button" class="lc-btn secondary myListDeleteBtn" style="color:var(--danger); border-color:var(--danger);" data-provider="trakt" data-list-id="' + escapeAttr(traktListId) + '" data-name="' + escapeAttr(l.name) + '">Delete</button>' : '';

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
          deleteBtn +
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
    return;
  }
  const deleteBtn = e.target.closest('.myListDeleteBtn');
  if (deleteBtn && !deleteBtn.disabled && typeof deleteExternalListDirect === 'function') {
    deleteExternalListDirect(deleteBtn.dataset.provider, deleteBtn.dataset.listId, deleteBtn.dataset.name, deleteBtn);
    return;
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
  if (listsConnectBtn) listsConnectBtn.textContent = connected ? 'Disconnect' : 'Connect TMDB';
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
  window._myTmdbLists = lists || [];
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
          const tmdbTarget = isWatchlist ? 'watchlist' : (isFavorites ? 'favorite' : 'custom');
          const tmdbListId = isWatchlist ? 'watchlist' : (isFavorites ? 'favorite' : listIdStr);
          const removeBtn = '<button type="button" class="cw-remove-btn" data-remove-type="external" data-provider="tmdb" data-target="' + tmdbTarget + '" data-list-id="' + escapeAttr(tmdbListId) + '" data-remove-id="' + escapeAttr(it.id) + '" data-media-type="' + escapeAttr(posterType) + '" onclick="event.stopPropagation(); removeListItemFromDetails(this)" title="Remove from TMDB">&times;</button>';
          return '<div class="list-card-mini-poster-tile">' +
            '<div class="list-card-mini-poster-img-wrap">' +
              '<img src="' + escapeAttr(it.poster) + '" class="clickable-poster" data-id="' + escapeAttr(it.id) + '" data-type="' + escapeAttr(posterType) + '" alt="" loading="lazy">' +
              removeBtn +
              overlays +
            '</div>' +
            '<div class="list-card-mini-poster-name">' + escapeHtml(it.title || '') + '</div>' +
            (it.year ? '<div class="list-card-mini-poster-year">' + escapeHtml(it.year) + '</div>' : '') +
          '</div>';
        }).join('') +
      '</div>';
    }

    const isCustomUserList = !isWatchlist && !isFavorites;
    const deleteBtn = isCustomUserList ? '<button type="button" class="lc-btn secondary myListDeleteBtn" style="color:var(--danger); border-color:var(--danger);" data-provider="tmdb" data-list-id="' + escapeAttr(listIdStr) + '" data-name="' + escapeAttr(l.name) + '">Delete</button>' : '';

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
          deleteBtn +
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
  const deleteBtn = e.target.closest('.myListDeleteBtn');
  if (deleteBtn && !deleteBtn.disabled && typeof deleteExternalListDirect === 'function') {
    deleteExternalListDirect(deleteBtn.dataset.provider, deleteBtn.dataset.listId, deleteBtn.dataset.name, deleteBtn);
    return;
  }
});

// --- Simkl OAuth & Personal Lists -----------------------------------------
function startSimklConnect() {
  window.location.href = ORIGIN + '/api/simkl/oauth/start';
}

function disconnectSimkl() {
  const input = document.getElementById('simklKeyInput');
  if (input) input.value = '';
  simklAccessToken = '';
  simklUsername = '';
  try {
    localStorage.removeItem('myListAddon:simklAccessToken');
    localStorage.removeItem('myListAddon:simklUsername');
    localStorage.removeItem('myListAddon:simklKey');
  } catch (e) {}
  saveState();
  renderSimklConnectStatus();
  scheduleMySimklListsRefresh();
}

function toggleListsSimklConnection() {
  if (simklAccessToken || localStorage.getItem('myListAddon:simklAccessToken')) {
    disconnectSimkl();
  } else {
    startSimklConnect();
  }
}

function pickUpSimklTokenFromUrl() {
  const hash = window.location.hash || '';
  const match = /(?:^|[#&])simkl_token=([^&]+)/.exec(hash);
  if (match) {
    simklAccessToken = decodeURIComponent(match[1]);
    try {
      localStorage.setItem('myListAddon:simklAccessToken', simklAccessToken);
    } catch (e) {}
    const userMatch = /(?:^|[#&])simkl_username=([^&]+)/.exec(hash);
    if (userMatch) {
      simklUsername = decodeURIComponent(userMatch[1]);
      try {
        localStorage.setItem('myListAddon:simklUsername', simklUsername);
      } catch (e) {}
    }
    saveState();
    history.replaceState(null, '', window.location.pathname + window.location.search);
    if (typeof showAppAlert === 'function') {
      showAppAlert('Simkl Connected', 'Your Simkl account was successfully connected.', true);
    } else {
      alert('Connected to Simkl.');
    }
    renderSimklConnectStatus();
    scheduleMySimklListsRefresh();
  }
  const params = new URLSearchParams(window.location.search);
  const err = params.get('simkl_error');
  if (err) {
    const detail = params.get('simkl_error_detail') || '';
    const messages = {
      not_configured: 'Simkl OAuth is not configured on this Worker.',
      no_code: 'Simkl did not return an authorization code.',
      exchange_failed: 'Failed to exchange authorization code for a Simkl token.',
      access_denied: 'Simkl sign-in was cancelled.',
      state_mismatch: 'Simkl sign-in state mismatch. Please try again.',
      no_token: 'Simkl did not return an access token.',
      network: 'Network error connecting to Simkl.',
    };
    const msg = messages[err] || ('Could not connect to Simkl (' + err + (detail ? ': ' + detail : '') + ').');
    if (typeof showAppAlert === 'function') {
      showAppAlert('Simkl Connection Error', msg + (detail ? '\\n\\nDetails: ' + detail : ''), false);
    } else {
      alert(msg + (detail ? '\\n' + detail : ''));
    }
    params.delete('simkl_error');
    params.delete('simkl_error_detail');
    const qs = params.toString();
    history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''));
  }
}

function renderSimklConnectStatus() {
  const input = document.getElementById('simklKeyInput');
  const statusEl = document.getElementById('simklConnectStatus');
  const connectBtn = document.getElementById('simklConnectBtn');
  const disconnectBtn = document.getElementById('simklDisconnectBtn');
  const listsBtn = document.getElementById('listsSimklConnectBtn');

  const token = (typeof simklAccessToken !== 'undefined' && simklAccessToken) || localStorage.getItem('myListAddon:simklAccessToken') || '';
  if (token) simklAccessToken = token;
  const user = (typeof simklUsername !== 'undefined' && simklUsername) || localStorage.getItem('myListAddon:simklUsername') || '';
  const key = (input ? input.value.trim() : '') || localStorage.getItem('myListAddon:simklKey') || '';
  const connected = !!(token || key);

  if (listsBtn) {
    listsBtn.innerText = connected ? 'Disconnect' : 'Connect Simkl';
  }

  if (statusEl) {
    if (token && user) {
      statusEl.innerHTML = '<span style="color:#7ce7b6; font-weight:600;">\u2713 Connected as @' + escapeHtml(user) + '</span>';
    } else if (token) {
      statusEl.innerHTML = '<span style="color:#7ce7b6; font-weight:600;">\u2713 Connected to Simkl</span>';
    } else if (key) {
      statusEl.innerHTML = '<span style="color:#7ce7b6; font-weight:600;">\u2713 Custom Simkl Client ID configured</span>';
    } else {
      statusEl.innerHTML = '<span style="color:var(--muted);">Not connected.</span>';
    }
  }

  if (connectBtn) connectBtn.textContent = token ? 'Re-connect Simkl' : (key ? 'Update Client ID' : 'Connect Simkl Account');
  if (disconnectBtn) disconnectBtn.style.display = connected ? '' : 'none';

  const syncCb = document.getElementById('syncSimklHistoryCheckbox');
  if (syncCb) syncCb.checked = localStorage.getItem('myListAddon:syncSimklHistory') === 'true';
  const syncWrap = document.getElementById('simklSyncHistoryWrap');
  if (syncWrap) syncWrap.style.display = connected ? '' : 'none';

  if (connected) {
    scheduleMySimklListsRefresh();
  }
}

let mySimklListsTimer = null;
function scheduleMySimklListsRefresh() {
  clearTimeout(mySimklListsTimer);
  mySimklListsTimer = setTimeout(runMySimklLists, 600);
}

async function runMySimklLists() {
  const box = document.getElementById('mySimklListsResult');
  if (!box) return;
  const token = simklAccessToken || localStorage.getItem('myListAddon:simklAccessToken') || '';
  const input = document.getElementById('simklKeyInput');
  const key = (input ? input.value.trim() : '') || localStorage.getItem('myListAddon:simklKey') || '';

  if (!token && !key) {
    box.innerHTML = '<p style="margin-top:10px; color:var(--muted);"><small>Connect your Simkl account in Settings or click <strong>Connect Simkl</strong> above to see your personal lists, watchlist, and watch history here.</small></p>';
    return;
  }

  box.innerHTML = '<p style="margin-top:10px;"><small>Loading your Simkl lists\u2026</small></p>';
  try {
    const res = await fetch(ORIGIN + '/api/simkl/my-lists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token, simklKey: key }),
    });
    const data = await res.json();
    if (!data.ok) {
      box.innerHTML = '<p class="testresult err">\u2717 ' + escapeHtml(data.error || 'Could not load your Simkl lists.') + '</p>';
      return;
    }
    renderMySimklLists(data.lists);
  } catch (e) {
    box.innerHTML = '<p class="testresult err">\u2717 Network error loading your Simkl lists.</p>';
  }
}

function renderMySimklLists(lists) {
  window._mySimklLists = lists || [];
  const box = document.getElementById('mySimklListsResult');
  if (!box) return;
  if (!lists || !lists.length) {
    box.innerHTML = '<p style="margin-top:10px; color:var(--muted);"><small>No items found on your Simkl account.</small></p>';
    return;
  }

  const alreadyAdded = new Set();
  document.querySelectorAll('#lists .entry').forEach(function(entry) {
    const t = entry.querySelector('.type') ? entry.querySelector('.type').value : '';
    entry.querySelectorAll('.url').forEach(function(el) {
      alreadyAdded.add(el.value.trim() + '|' + t);
    });
  });

  window._simklListsMap = window._simklListsMap || {};
  lists.forEach(function(l) {
    if (l && l.url) window._simklListsMap[l.url] = l;
  });

  const cardsHtml = lists.map((l) => {
    const type = l.type === 'series' ? 'series' : 'movie';
    const typeLabel = l.type === 'series' ? 'Shows' : 'Movies';
    const totalCount = l.itemCount || (l.items || []).length;
    const added = alreadyAdded.has(l.url + '|' + type);

    const isCompleted = (l.name && l.name.toLowerCase().includes('completed')) || (l.url && l.url.includes(':completed')) || l.statusKey === 'completed';
    const copyBtn = '<button type="button" class="lc-btn secondary myListCopyToCustomBtn" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(type) + '">Copy</button>';
    const markWatchedBtn = isCompleted
      ? '<button type="button" class="lc-btn secondary" data-url="' + escapeAttr(l.url) + '" data-name="' + escapeAttr(l.name) + '" data-type="' + escapeAttr(type) + '" onclick="markSimklListAllWatched(this)">Mark all as Watched</button>'
      : '';
    const addBtn = '<button type="button" class="lc-btn primary myListAddBtn" ' + (added ? 'disabled' : '') + ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + type + '">' + (added ? '&#10003; Added' : '+ Add') + '</button>';

    const previewItems = (l.items || []).slice(0, 9);
    let posterThumbs = '';
    if (previewItems.length) {
      posterThumbs = '<div class="list-card-posters poster-preview-static">' +
        previewItems.map((it, i) => {
          const isMobileEnd = (i === 2 && previewItems.length > 3);
          const isDesktopEnd = (i === previewItems.length - 1 && previewItems.length >= 4);
          let overlays = '';
          if (isMobileEnd) {
            overlays += '<div class="list-card-count-overlay mobile-only searchViewListBtn" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(type) + '" data-items="' + escapeAttr(totalCount) + '" style="cursor:pointer;">' + totalCount + ' &rsaquo;</div>';
          }
          if (isDesktopEnd) {
            overlays += '<div class="list-card-count-overlay desktop-only searchViewListBtn" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(type) + '" data-items="' + escapeAttr(totalCount) + '" style="cursor:pointer;">' + totalCount + ' &rsaquo;</div>';
          }
          const simklStatus = l.statusKey || (l.url ? l.url.split(':')[3] : 'plantowatch');
          const removeBtn = '<button type="button" class="cw-remove-btn" data-remove-type="external" data-provider="simkl" data-target="status" data-list-id="' + escapeAttr(simklStatus) + '" data-remove-id="' + escapeAttr(it.id) + '" data-media-type="' + escapeAttr(it.type || type) + '" onclick="event.stopPropagation(); removeListItemFromDetails(this)" title="Remove from Simkl">&times;</button>';
          return '<div class="list-card-mini-poster-tile" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(type) + '" data-items="' + escapeAttr(totalCount) + '">' +
            '<div class="list-card-mini-poster-img-wrap">' +
              (it.poster ? '<img src="' + escapeAttr(it.poster) + '" class="clickable-poster" data-id="' + escapeAttr(it.id) + '" data-type="' + escapeAttr(it.type || type) + '" data-title="' + escapeAttr(it.name || '') + '" data-poster="' + escapeAttr(it.poster || '') + '" alt="" loading="lazy">' : '<div style="width:100%;height:100%;background:var(--bg-card);"></div>') +
              removeBtn +
              overlays +
            '</div>' +
            '<div class="list-card-mini-poster-name">' + escapeHtml(it.name || '') + '</div>' +
            (it.year ? '<div class="list-card-mini-poster-year">' + escapeHtml(it.year) + '</div>' : '') +
          '</div>';
        }).join('') +
      '</div>';
    }

    return '<div class="list-card" data-list-type="' + type + '" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(type) + '" data-items="' + escapeAttr(totalCount) + '">' +
      '<div class="list-card-header">' +
        '<div class="list-card-body">' +
          '<div class="list-card-title" style="cursor:pointer;">' + escapeHtml(l.name) + '</div>' +
          '<div class="list-card-meta">' +
            '<span>' + typeLabel + '</span>' +
            '<span class="list-card-meta-sep">&middot;</span><span>' + totalCount + ' items</span>' +
          '</div>' +
        '</div>' +
        '<div class="list-card-actions">' +
          copyBtn +
          markWatchedBtn +
          addBtn +
        '</div>' +
      '</div>' +
      posterThumbs +
    '</div>';
      posterThumbs +
    '</div>';
  }).join('');

  box.innerHTML = cardsHtml;
}

document.getElementById('mySimklListsResult')?.addEventListener('click', (e) => {
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
});

function updateConnectionStatusBadges() {
  if (typeof renderTmdbConnectStatus === 'function') renderTmdbConnectStatus();
  if (typeof renderTraktConnectStatus === 'function') renderTraktConnectStatus();
  if (typeof renderMdblistConnectStatus === 'function') renderMdblistConnectStatus();
  if (typeof renderSimklConnectStatus === 'function') renderSimklConnectStatus();
}

function toggleProviderHistorySync(provider, enabled) {
  const cap = provider.charAt(0).toUpperCase() + provider.slice(1);
  try {
    localStorage.setItem('myListAddon:sync' + cap + 'History', enabled ? 'true' : 'false');
  } catch (e) {}
  saveState();
  if (provider === 'trakt') renderTraktConnectStatus();
  if (provider === 'mdblist') renderMdblistConnectStatus();
  if (provider === 'simkl') renderSimklConnectStatus();
  if (typeof pushCreatorSync === 'function' && activeCreator) {
    pushCreatorSync();
  }
}

async function syncWatchHistoryToProviderNow(provider, btn) {
  const cap = provider.charAt(0).toUpperCase() + provider.slice(1);
  const localMap = typeof loadLocalCustomLists === 'function' ? loadLocalCustomLists() : {};
  const historyList = localMap['watch-history'];
  const items = (historyList && Array.isArray(historyList.items)) ? historyList.items : [];
  
  if (!items.length) {
    if (typeof showToast === 'function') showToast('Your Watch History is currently empty.');
    else alert('Your Watch History is currently empty.');
    return;
  }

  const origText = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Syncing ' + items.length + ' items\u2026';
  }

  const traktToken = (typeof traktAccessToken !== 'undefined' && traktAccessToken) || localStorage.getItem('myListAddon:traktAccessToken') || '';
  const traktKey = (document.getElementById('traktKeyInput')?.value.trim()) || localStorage.getItem('myListAddon:traktKey') || '';
  const mdblistToken = (typeof mdblistAccessToken !== 'undefined' && mdblistAccessToken) || localStorage.getItem('myListAddon:mdblistAccessToken') || '';
  const mdblistKey = (document.getElementById('mdblistKeyInput')?.value.trim()) || localStorage.getItem('myListAddon:mdblistKey') || '';
  const simklToken = (typeof simklAccessToken !== 'undefined' && simklAccessToken) || localStorage.getItem('myListAddon:simklAccessToken') || '';
  const simklKey = (document.getElementById('simklKeyInput')?.value.trim()) || localStorage.getItem('myListAddon:simklKey') || '';

  try {
    const res = await fetch(ORIGIN + '/api/external-sync/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: provider,
        items: items,
        traktAccessToken: traktToken,
        traktKey: traktKey,
        mdblistAccessToken: mdblistToken,
        mdblistKey: mdblistKey,
        simklAccessToken: simklToken,
        simklKey: simklKey,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (btn) {
      btn.disabled = false;
      btn.textContent = origText;
    }
    if (!res.ok || !data.ok) {
      if (typeof showToast === 'function') showToast('Failed to sync to ' + cap + ': ' + (data.error || 'Unknown error'));
      else alert('Failed to sync to ' + cap + ': ' + (data.error || 'Unknown error'));
      return;
    }
    const count = data.syncedCount != null ? data.syncedCount : items.length;
    const msg = '\u2713 Successfully synced ' + count + ' item' + (count === 1 ? '' : 's') + ' to ' + cap + ' Watch History.';
    if (typeof showToast === 'function') showToast(msg);
    else alert(msg);
  } catch (err) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = origText;
    }
    if (typeof showToast === 'function') showToast('Network error syncing to ' + cap + '.');
    else alert('Network error syncing to ' + cap + '.');
  }
}

async function syncAllConnectedAccountsNow(btn) {
  const traktToken = (typeof traktAccessToken !== 'undefined' && traktAccessToken) || localStorage.getItem('myListAddon:traktAccessToken') || '';
  const mdblistToken = (typeof mdblistAccessToken !== 'undefined' && mdblistAccessToken) || localStorage.getItem('myListAddon:mdblistAccessToken') || '';
  const simklToken = (typeof simklAccessToken !== 'undefined' && simklAccessToken) || localStorage.getItem('myListAddon:simklAccessToken') || '';

  const connectedProviders = [];
  if (traktToken) connectedProviders.push('trakt');
  if (mdblistToken) connectedProviders.push('mdblist');
  if (simklToken) connectedProviders.push('simkl');

  if (!connectedProviders.length) {
    if (typeof showToast === 'function') showToast('No external accounts (Trakt, MDBList, Simkl) are connected yet. Connect them in External Accounts & API Keys.');
    else alert('No external accounts (Trakt, MDBList, Simkl) are connected yet. Connect them in External Accounts & API Keys.');
    return;
  }

  for (const p of connectedProviders) {
    await syncWatchHistoryToProviderNow(p, btn);
  }
}

async function syncSingleItemToConnectedProviders(item, action) {
  if (!item) return;
  const act = action || 'add';
  const traktSync = localStorage.getItem('myListAddon:syncTraktHistory') === 'true';
  const mdblistSync = localStorage.getItem('myListAddon:syncMdblistHistory') === 'true';
  const simklSync = localStorage.getItem('myListAddon:syncSimklHistory') === 'true';

  const traktToken = (typeof traktAccessToken !== 'undefined' && traktAccessToken) || localStorage.getItem('myListAddon:traktAccessToken') || '';
  const traktKeyEl = document.getElementById('traktKeyInput');
  const traktKey = (traktKeyEl ? traktKeyEl.value.trim() : '') || localStorage.getItem('myListAddon:traktKey') || '';
  const mdblistToken = (typeof mdblistAccessToken !== 'undefined' && mdblistAccessToken) || localStorage.getItem('myListAddon:mdblistAccessToken') || '';
  const mdblistKeyEl = document.getElementById('mdblistKeyInput');
  const mdblistKey = (mdblistKeyEl ? mdblistKeyEl.value.trim() : '') || localStorage.getItem('myListAddon:mdblistKey') || '';
  const simklToken = (typeof simklAccessToken !== 'undefined' && simklAccessToken) || localStorage.getItem('myListAddon:simklAccessToken') || '';
  const simklKeyEl = document.getElementById('simklKeyInput');
  const simklKey = (simklKeyEl ? simklKeyEl.value.trim() : '') || localStorage.getItem('myListAddon:simklKey') || '';

  const isMovie = item.type === 'movie' || item.kind === 'movie';
  const mediaType = isMovie ? 'movie' : 'series';
  const rootId = item.showId || item.id || item.imdbId;
  const imdbId = item.showId && item.showId.startsWith('tt') ? item.showId : (item.imdbId || (String(item.id || '').startsWith('tt') ? item.id : ''));
  const seasonNum = item.seasonNum != null ? item.seasonNum : (item.season != null ? item.season : null);
  const episodeNum = item.episodeNum != null ? item.episodeNum : (item.episode != null ? item.episode : null);
  const title = item.showTitle || item.title || item.name || '';

  const promises = [];

  if (traktSync && traktToken) {
    promises.push(
      fetch(ORIGIN + '/api/external-list/item-mutate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'trakt',
          target: 'history',
          action: act,
          traktAccessToken: traktToken,
          traktKey: traktKey,
          id: rootId,
          imdbId: imdbId,
          tmdbId: item.tmdbId,
          mediaType: mediaType,
          season: seasonNum,
          episode: episodeNum,
          title: title,
        }),
      }).catch(() => {})
    );
  }

  if (mdblistSync && (mdblistToken || mdblistKey)) {
    promises.push(
      fetch(ORIGIN + '/api/external-list/item-mutate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'mdblist',
          target: 'history',
          action: act,
          mdblistAccessToken: mdblistToken,
          mdblistKey: mdblistKey,
          id: rootId,
          imdbId: imdbId,
          tmdbId: item.tmdbId,
          mediaType: mediaType,
          season: seasonNum,
          episode: episodeNum,
          title: title,
        }),
      }).catch(() => {})
    );
  }

  if (simklSync && simklToken) {
    promises.push(
      fetch(ORIGIN + '/api/external-list/item-mutate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'simkl',
          target: 'history',
          action: act,
          simklAccessToken: simklToken,
          simklKey: simklKey,
          id: rootId,
          imdbId: imdbId,
          tmdbId: item.tmdbId,
          mediaType: mediaType,
          season: seasonNum,
          episode: episodeNum,
          title: title,
        }),
      }).catch(() => {})
    );
  }

  if (promises.length) {
    Promise.allSettled(promises);
  }
}




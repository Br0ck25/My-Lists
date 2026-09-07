function guessNameFromUrl(u) {
  try {
    // Slug words a plain per-word title-case gets wrong -- known acronyms
    // that should stay fully uppercase (imdb -> Imdb otherwise, not IMDB)
    // rather than just their first letter. Common enough in list slugs
    // (imdb-top-rated, uk-top-10, latest-tv-shows) to special-case
    // explicitly.
    const ACRONYMS = ['imdb', 'tmdb', 'tv', 'uk', 'usa', 'hd', 'uhd', 'dc'];
    // Query string and fragment stripped first -- otherwise a URL copied
    // while some filter/view toggle on the source site is active (e.g.
    // "?Mode=Show") either becomes the entire guessed name (if there's a
    // trailing slash before the "?", so it lands in its own "/"-separated
    // segment) or gets appended to the end of it. Neither is a real list
    // name; only the path is.
    const noQuery = String(u).split(/[?#]/)[0];
    const parts = noQuery.split('/').filter(Boolean);
    let last = parts[parts.length - 1] || noQuery || u;
    last = last.replace(/[-_]+/g, ' ').trim();
    if (!last) return 'List';
    // Title-case each word. The doubled backslashes below (\\b\\w) are
    // required, not a typo or over-escaping: this file's own text is
    // embedded as string content inside 09_page-shell.js's outer
    // template literal (see that file's build-time concatenation
    // comment), so it passes through one layer of backslash-escape
    // processing before the browser ever parses it as JS. A single
    // \b\w here would have the template literal consume that backslash
    // (\b is its own recognized escape, for a backspace character) and
    // drop the other, leaving the browser a regex matching a literal
    // backspace byte followed by "w" -- which matches nothing, so this
    // silently no-ops and leaves every guessed name in its original
    // (all-lowercase-slug) casing. Doubling them here is what survives
    // that pass and reaches the browser as the real \b\w (word boundary
    // + word character) this is actually meant to be.
    const titled = last.replace(/\\b\\w/g, (c) => c.toUpperCase());
    // Then fix up any whole word that's actually a known acronym --
    // title-casing alone leaves "Imdb Top Rated Movies" instead of the
    // "IMDB Top Rated Movies" someone would actually type by hand.
    return titled.replace(/[a-zA-Z]+/g, (word) => (
      ACRONYMS.includes(word.toLowerCase()) ? word.toUpperCase() : word
    ));
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
    if (typeof showAppAlert === 'function') showAppAlert('URL Required', 'Paste at least one list URL first, one per line.', false);
    else alert('Paste at least one list URL first, one per line.');
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
    if (!res.ok) return [];
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return [];
    const data = await res.json();
    mdblistPopularCache = data && data.ok && Array.isArray(data.lists) ? data.lists.slice().sort((a, b) => (b.likes || 0) - (a.likes || 0)) : [];
  } catch (e) {
    mdblistPopularCache = [];
  }
  return mdblistPopularCache || [];
}

let traktPopularCache = null;
async function ensureTraktPopularLoaded() {
  if (traktPopularCache) return traktPopularCache;
  try {
    const key = (document.getElementById('traktKeyInput') ? document.getElementById('traktKeyInput').value.trim() : '') || localStorage.getItem('myListAddon:traktKey') || '';
    const res = await fetch(ORIGIN + '/api/trakt-popular-lists' + (key ? '?traktKey=' + encodeURIComponent(key) : ''));
    if (!res.ok) return [];
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return [];
    const data = await res.json();
    if (data && data.ok && Array.isArray(data.lists)) {
      traktPopularCache = data.lists;
      return traktPopularCache;
    }
  } catch (e) {}
  return [];
}

function escapeHtml(s) {
  // s == null -> '' (not String(null)/String(undefined), which render as
  // the literal text "null"/"undefined" for any field that's legitimately
  // unset -- see 16_client-row-core.js's escapeHtml, which this matches).
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
function escapeAttr(s) { return escapeHtml(s); }

// escapeAttr is right for a plain attribute and WRONG for a JavaScript string
// inside one, which is what every onclick="fn(&quot;VALUE&quot;)" handler in
// this app builds. The HTML parser decodes attribute entities BEFORE the JS
// parser runs, so escapeHtml's own output re-forms the delimiter it was meant
// to neutralise -- escaping becomes the delivery mechanism:
//
//   value       ");alert(1);//
//   escapeAttr  &quot;);alert(1);//
//   markup      onclick="fn(&quot;&quot;);alert(1);//&quot;)"
//   executed    fn("");alert(1);//")        <- the payload runs
//
// Measured, not theorised: a channel id carrying that shape, arriving through
// a restored backup or a pasted install link, ran script and read the victim's
// Creator Key out of localStorage.
//
// The value has to survive two decodings, so it needs escaping for both, in
// that order: JS-string first, then HTML. Backslash-escaping the quote makes
// the HTML decode yield \\\\" rather than ", which the JS parser reads as a
// literal quote inside the string instead of the end of it.
//
// Not a replacement for escapeAttr -- a plain data-* or title attribute still
// wants escapeAttr, and running this on one would leave visible backslashes.
// Use this one only where the value lands inside quotes the browser will
// execute.
function escapeJsAttr(s) {
  return escapeHtml(
    String(s == null ? '' : s)
      .replace(/\\\\/g, '\\\\\\\\')
      .replace(/"/g, '\\\\"')
      .replace(/'/g, "\\\\'")
      .replace(/\\r/g, '\\\\r')
      .replace(/\\n/g, '\\\\n')
      .replace(/\\u2028/g, '\\\\u2028')
      .replace(/\\u2029/g, '\\\\u2029')
  );
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^\x24\x7B\x7D()|[\]\\]/g, '\\$&');
}

function parseListSearchIntent(rawQuery) {
  const raw = String(rawQuery || '').trim();
  const q = raw.toLowerCase().replace(/['"“”]/g, '').trim();
  if (!q) return { raw, term: '', source: null, isSourceOnly: false };

  let source = null;
  let term = q;

  // Doubled backslashes (\\b, \\s, \\., \\+) throughout -- required, not
  // over-escaping. See guessNameFromUrl's own comment above for why:
  // this file's text passes through one round of backslash-escape
  // cooking (09_page-shell.js's outer template literal) before a
  // browser ever parses it as code, and a single \b/\s/\./\+ wouldn't
  // survive that pass as the word-boundary/whitespace/literal-dot/
  // literal-plus regex escapes they're meant to be -- \+ in particular
  // would survive as a bare +, a quantifier on the character before it
  // ("y" in "disney+?") instead of a literal "+".
  const patterns = [
    { source: 'MDBList', regex: /^(?:mdblist|mdb)\\b\\s*/i },
    { source: 'Trakt', regex: /^(?:trakt|trakt\\.tv)\\b\\s*/i },
    { source: 'TMDB', regex: /^(?:tmdb|themoviedb|franchise|collection|collections)\\b\\s*/i },
    { source: 'Simkl', regex: /^(?:simkl|anime)\\b\\s*/i },
    { source: 'My Lists Addon', regex: /^(?:my\\s*lists\\s*addon|my\\s*lists|mylists|profile|profiles|community)\\b\\s*/i },
    { source: 'Streaming', regex: /^(?:netflix|disney\\+?|hbo\\s*max|max|hulu|apple\\s*tv\\+?|prime\\s*video|amazon|paramount\\+?|peacock)\\b\\s*/i },
  ];

  for (const p of patterns) {
    if (p.regex.test(q)) {
      source = p.source;
      term = q.replace(p.regex, '').trim();
      break;
    }
  }

  const aliases = {
    'mdblist': 'MDBList', 'mdb': 'MDBList',
    'trakt': 'Trakt', 'trakt.tv': 'Trakt',
    'tmdb': 'TMDB', 'themoviedb': 'TMDB', 'franchise': 'TMDB', 'collection': 'TMDB', 'collections': 'TMDB',
    'simkl': 'Simkl', 'anime': 'Simkl',
    'my lists addon': 'My Lists Addon', 'mylistsaddon': 'My Lists Addon', 'my lists': 'My Lists Addon', 'mylists': 'My Lists Addon', 'profile': 'My Lists Addon', 'profiles': 'My Lists Addon', 'community': 'My Lists Addon',
    'streaming': 'Streaming', 'netflix': 'Streaming', 'disney': 'Streaming', 'disney+': 'Streaming', 'hbo': 'Streaming', 'max': 'Streaming', 'hulu': 'Streaming', 'apple': 'Streaming', 'apple tv': 'Streaming', 'prime': 'Streaming', 'prime video': 'Streaming', 'paramount': 'Streaming', 'peacock': 'Streaming',
  };
  if (aliases[q]) {
    source = aliases[q];
    term = '';
  }

  return {
    raw,
    term,
    source,
    isSourceOnly: (source && !term),
  };
}

function scoreListSearchMatch(list, rawQuery, intent) {
  if (!list) return -1;
  const listName = (list.name || '').toLowerCase().trim();
  const listUser = (list.creatorName || list.user || list.username || '').toLowerCase().trim();
  const listUrl = (list.url || '').toLowerCase();
  const listSource = (list.source || (listUrl.includes('mdblist') ? 'MDBList' : (listUrl.includes('trakt') ? 'Trakt' : (listUrl.includes('simkl') ? 'Simkl' : (listUrl.includes('themoviedb') || listUrl.startsWith('tmdb:') ? 'TMDB' : 'My Lists Addon'))))).toLowerCase();

  const q = (rawQuery || '').toLowerCase().trim();
  const targetTerm = (intent && intent.term ? intent.term : q).toLowerCase().trim();
  const targetSource = (intent && intent.source ? intent.source : '').toLowerCase();

  let score = 0;

  // Source match boost
  if (targetSource) {
    if (listSource.includes(targetSource) || (targetSource === 'my lists addon' && (listSource.includes('my lists') || listSource.includes('profile'))) || (targetSource === 'streaming' && (listUrl.startsWith('tmdb:chart:') || listName.includes('netflix') || listName.includes('disney') || listName.includes('hbo') || listName.includes('hulu') || listName.includes('apple') || listName.includes('prime')))) {
      score += 600;
    }
  }

  // Pure source search (no extra keyword)
  if (!targetTerm) {
    if (targetSource && (listSource.includes(targetSource) || (targetSource === 'streaming' && listUrl.startsWith('tmdb:chart:')))) {
      const likes = typeof list.likes === 'number' ? list.likes : (parseInt(list.likes, 10) || 0);
      const items = typeof list.items === 'number' ? list.items : (parseInt(list.items, 10) || 0);
      return score + Math.min(400, likes * 2 + items);
    }
    return score > 0 ? score : -1;
  }

  // Check if anything matched title, user, source, or url
  const tokens = targetTerm.split(/\s+/).filter(Boolean);
  let matchedTokensInName = 0;
  let matchedTokensInUser = 0;
  for (const token of tokens) {
    if (listName.includes(token)) matchedTokensInName++;
    if (listUser.includes(token)) matchedTokensInUser++;
  }

  const hasAnyMatch = (matchedTokensInName > 0 || matchedTokensInUser > 0 || listName.includes(targetTerm) || listUser.includes(targetTerm) || listSource.includes(targetTerm) || listUrl.includes(targetTerm));
  if (!hasAnyMatch) {
    return -1;
  }

  // 1. Exact title match
  if (listName === targetTerm || listName === q) {
    score += 2500;
  } else if (listName.startsWith(targetTerm) || listName.startsWith(q)) {
    score += 1500;
  } else if (listName.includes(targetTerm) || listName.includes(q)) {
    score += 900;
  }

  // 2. Exact creator match
  if (listUser === targetTerm || listUser === q) {
    score += 2000;
  } else if (listUser.startsWith(targetTerm) || listUser.startsWith(q)) {
    score += 1300;
  } else if (listUser.includes(targetTerm) || listUser.includes(q)) {
    score += 800;
  }

  // 3. Multi-token title & creator matching
  if (tokens.length > 1) {
    if (matchedTokensInName === tokens.length) {
      score += 1000;
    } else if (matchedTokensInName > 0) {
      score += matchedTokensInName * 250;
    }

    if (matchedTokensInUser === tokens.length) {
      score += 900;
    } else if (matchedTokensInUser > 0) {
      score += matchedTokensInUser * 200;
    }
  }

  // 4. Word boundary matches
  try {
    const rx = new RegExp('\\b' + escapeRegex(targetTerm) + '\\b', 'i');
    if (rx.test(listName)) score += 400;
    if (rx.test(listUser)) score += 400;
  } catch (e) {}

  // 5. Source / tag matches
  if (listSource.includes(targetTerm)) {
    score += 300;
  }

  // 6. Popularity & item count tie-breakers
  const likes = typeof list.likes === 'number' ? list.likes : (parseInt(list.likes, 10) || 0);
  const items = typeof list.items === 'number' ? list.items : (parseInt(list.items, 10) || 0);
  score += Math.min(250, Math.log10(likes + 1) * 50);
  score += Math.min(60, Math.log10(items + 1) * 15);

  return score;
}

window._unifiedSearchCache = window._unifiedSearchCache || new Map();
let currentListSearchSequence = 0;

async function executeUnifiedListSearch(rawQuery, targetBox) {
  const q = (rawQuery || '').trim();
  const box = targetBox || document.getElementById('listSearchResult') || document.getElementById('catalogSearchResult');
  if (!box) return;
  if (!q) {
    box.innerHTML = '';
    return;
  }

  const thisSeq = ++currentListSearchSequence;
  const qLower = q.toLowerCase();
  const cacheKey = qLower;

  // Check client memory cache (1-hour expiry)
  const cached = window._unifiedSearchCache.get(cacheKey);
  if (cached && (Date.now() - cached.time < 3600000)) {
    renderListSearchResults(cached.mdblistMatches, cached.traktMatches, cached.traktError, cached.myListsMatches, cached.tmdbMatches, box, cached.intent);
    return;
  }

  if (!box.children.length) {
    box.innerHTML = '<p><small>Searching lists\u2026</small></p>';
  }

  try {
    fetch(ORIGIN + '/api/track-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q }),
      keepalive: true,
    }).catch(() => {});
  } catch (e) {}

  const intent = parseListSearchIntent(q);
  const searchTerm = intent.term || q;
  const tkInput = document.getElementById('tmdbKeyInput');
  const tmdbKey = (tkInput && tkInput.value ? tkInput.value.trim() : '') || localStorage.getItem('myListAddon:tmdbKey') || '';
  const traktKey = (document.getElementById('traktKeyInput')?.value || '').trim();

  const fetches = [
    ensureMdblistPopularLoaded().catch(() => []),
    fetch(ORIGIN + '/api/trakt-search?q=' + encodeURIComponent(searchTerm) + (traktKey ? '&traktKey=' + encodeURIComponent(traktKey) : ''))
      .then(async (r) => (r.ok && (r.headers.get('content-type') || '').includes('application/json') ? await r.json() : { ok: false, error: 'Could not search trakt.tv.' }))
      .catch(() => ({ ok: false, error: 'Network error searching trakt.tv.' })),
    fetch(ORIGIN + '/api/search-published-lists?q=' + encodeURIComponent(searchTerm))
      .then(async (r) => (r.ok && (r.headers.get('content-type') || '').includes('application/json') ? await r.json() : { ok: false, lists: [] }))
      .catch(() => ({ ok: false, lists: [] })),
    fetch(ORIGIN + '/api/tmdb-search-lists?q=' + encodeURIComponent(searchTerm) + (tmdbKey ? '&tmdbKey=' + encodeURIComponent(tmdbKey) : ''))
      .then(async (r) => (r.ok && (r.headers.get('content-type') || '').includes('application/json') ? await r.json() : { ok: false, lists: [] }))
      .catch(() => ({ ok: false, lists: [] })),
  ];

  if (intent.source === 'Trakt' || intent.isSourceOnly) {
    fetches.push(ensureTraktPopularLoaded().catch(() => []));
  }

  const [mdblistAll, traktResult, myListsResult, tmdbResult, traktPopular] = await Promise.all(fetches);

  // If a newer search query was already submitted by the user while this one was running, discard this response!
  if (thisSeq !== currentListSearchSequence) {
    return;
  }

  const mdblistMatches = Array.isArray(mdblistAll) ? mdblistAll : [];
  const traktMatches = [
    ...(traktResult && traktResult.ok && Array.isArray(traktResult.lists) ? traktResult.lists : []),
    ...(Array.isArray(traktPopular) ? traktPopular : [])
  ];
  const myListsMatches = myListsResult && myListsResult.ok && Array.isArray(myListsResult.lists) ? myListsResult.lists : [];
  const tmdbMatches = tmdbResult && tmdbResult.ok && Array.isArray(tmdbResult.lists) ? tmdbResult.lists : [];
  const traktError = traktResult && !traktResult.ok ? traktResult.error : null;

  // Save to client cache
  window._unifiedSearchCache.set(cacheKey, {
    time: Date.now(),
    mdblistMatches,
    traktMatches,
    traktError,
    myListsMatches,
    tmdbMatches,
    intent,
  });

  renderListSearchResults(mdblistMatches, traktMatches, traktError, myListsMatches, tmdbMatches, box, intent);
}

async function runListSearch() {
  const q = document.getElementById('listSearchInput').value.trim();
  const box = document.getElementById('listSearchResult');
  return executeUnifiedListSearch(q, box);
}

function renderListSearchResults(mdblistMatches, traktMatches, traktError, myListsMatches, tmdbMatches, targetBox, queryOrIntent) {
  let realTmdbMatches = tmdbMatches;
  let realTargetBox = targetBox;
  if (tmdbMatches && (tmdbMatches.nodeType || !Array.isArray(tmdbMatches))) {
    if (tmdbMatches && tmdbMatches.nodeType) {
      realTargetBox = tmdbMatches;
    }
    realTmdbMatches = [];
  }
  if (!Array.isArray(realTmdbMatches)) realTmdbMatches = [];
  const box = realTargetBox || document.getElementById('listSearchResult') || document.getElementById('catalogSearchResult');
  if (!box) return;

  const alreadyAdded = new Set();
  document.querySelectorAll('#lists .entry').forEach((entry) => {
    const t = entry.querySelector('.type') ? entry.querySelector('.type').value : '';
    entry.querySelectorAll('.url').forEach((el) => {
      alreadyAdded.add(el.value.trim() + '|' + t);
    });
  });

  const intent = (typeof queryOrIntent === 'object' && queryOrIntent !== null)
    ? queryOrIntent
    : parseListSearchIntent(typeof queryOrIntent === 'string' ? queryOrIntent : '');

  const candidates = [];

  // TMDB / Simkl matches
  realTmdbMatches.forEach((l) => {
    if (!l || !l.url) return;
    const source = l.source || (l.url.startsWith('simkl:') ? 'Simkl' : 'TMDB');
    candidates.push({
      name: l.name || 'Unnamed List',
      user: l.user || (source === 'Simkl' ? 'Simkl Official' : 'TMDB Official'),
      url: l.url,
      type: l.type || 'movie',
      items: l.items || (source === 'Simkl' ? 'Simkl Chart' : 'Franchise'),
      likes: l.likes || 0,
      source: source,
      isCollection: !!l.isCollection,
    });
  });

  // MDBList matches
  (mdblistMatches || []).forEach((l) => {
    if (!l || !l.url) return;
    candidates.push({
      name: l.name || 'Unnamed List',
      user: l.user || 'MDBList Curator',
      url: l.url,
      type: l.type || 'movie',
      items: l.items || 0,
      likes: l.likes || 0,
      source: 'MDBList',
    });
  });

  // Trakt matches
  (traktMatches || []).forEach((l) => {
    if (!l || !l.url) return;
    candidates.push({
      name: l.name || 'Unnamed List',
      user: l.user || 'Trakt User',
      slug: l.slug,
      url: l.url,
      type: (l.contentType === 'movie' || l.contentType === 'series') ? l.contentType : (l.type || 'mixed'),
      contentType: l.contentType,
      items: l.items || 0,
      likes: l.likes || 0,
      source: 'Trakt',
    });
  });

  // My Lists Addon matches
  (myListsMatches || []).filter((l) => l && (l.items || 0) > 0).forEach((l) => {
    if (!l || !l.url) return;
    candidates.push({
      name: l.name || 'Unnamed List',
      user: l.creatorName || l.username || 'Anonymous',
      creatorName: l.creatorName,
      username: l.username,
      url: l.url,
      type: l.type || 'mixed',
      items: l.items || 0,
      likes: l.likes || 0,
      source: 'My Lists Addon',
    });
  });

  const seenUrls = new Set();
  const scoredCards = [];

  for (const item of candidates) {
    const normUrl = item.url.trim().toLowerCase().replace(new RegExp('/+$'), '');
    if (seenUrls.has(normUrl)) continue;
    seenUrls.add(normUrl);

    const matchScore = (intent && intent.raw) ? scoreListSearchMatch(item, intent.raw, intent) : (item.likes || 0);
    if (intent && intent.raw && matchScore < 0) continue;

    const addedMovie = alreadyAdded.has(item.url + '|movie');
    const addedSeries = alreadyAdded.has(item.url + '|series');
    const addedDirect = alreadyAdded.has(item.url + '|' + item.type);
    const alreadyLikedExt = getLikedListsSet().has(item.url);

    let usernameSlug = '';
    if (item.source === 'My Lists Addon' || item.source === 'Profile') {
      try {
        const parts = (item.url || '').split('/lists/')[1]?.split('/');
        if (parts && parts.length >= 2) usernameSlug = parts[0] + '/' + parts[1];
      } catch (e) {}
    }
    const alreadyLikedProfile = usernameSlug && getLikedListsSet().has(usernameSlug);

    const typeLabel = item.type === 'series' ? 'Shows' : (item.type === 'mixed' ? 'Movies & Shows' : 'Movies');
    const slotType = (item.type === 'movie' || item.type === 'series') ? item.type : 'mixed';

    let badgeClass = 'badge-custom';
    if (item.source === 'MDBList') badgeClass = 'badge-mdblist';
    else if (item.source === 'Trakt') badgeClass = 'badge-trakt';
    else if (item.source === 'TMDB') badgeClass = 'badge-tmdb';
    else if (item.source === 'Simkl') badgeClass = 'badge-simkl';
    else if (item.source === 'My Lists Addon' || item.source === 'Profile') badgeClass = 'badge-mylists';
    else if (item.source === 'Streaming') badgeClass = 'badge-streaming';

    const sourceBadgeHtml = '<span class="list-source-badge ' + badgeClass + '">' + escapeHtml(item.source === 'Profile' ? 'My Lists Addon' : item.source) + '</span>';

    let actionsHtml = '';
    if ((item.source === 'My Lists Addon' || item.source === 'Profile') && usernameSlug) {
      actionsHtml += '<button type="button" class="lc-btn searchLikeBtn' + (alreadyLikedProfile ? ' liked' : '') + '" data-username-slug="' + escapeAttr(usernameSlug) + '">' + (alreadyLikedProfile ? '&#9829;' : '&#9825;') + '</button>';
      actionsHtml += '<button type="button" class="lc-btn ' + (addedDirect ? 'secondary searchAddBtn is-added' : 'primary searchAddBtn') + '" ' +
        (addedDirect ? 'style="color:var(--danger);"' : '') +
        ' data-name="' + escapeAttr(item.name) + '" data-url="' + escapeAttr(item.url) + '" data-type="' + (item.type || 'movie') + '">' +
        (addedDirect ? 'Remove' : '+ Add') +
        '</button>';
    } else if (item.source === 'Trakt' && item.contentType === 'unknown') {
      actionsHtml += '<button type="button" class="lc-btn searchLikeExternalBtn' + (alreadyLikedExt ? ' liked' : '') + '" data-url="' + escapeAttr(item.url) + '">' +
        (alreadyLikedExt ? '&#9829;' : '&#9825;') +
        '</button>';
      actionsHtml += '<button type="button" class="lc-btn ' + (addedMovie ? 'secondary searchAddBtn is-added' : 'primary searchAddBtn') + '" ' +
        (addedMovie ? 'style="color:var(--danger);"' : '') +
        ' data-name="' + escapeAttr(item.name) + '" data-url="' + escapeAttr(item.url) + '" data-type="movie">' +
        (addedMovie ? 'Remove (Movies)' : '+ Movies') + '</button>' +
        '<button type="button" class="lc-btn ' + (addedSeries ? 'secondary searchAddBtn is-added' : 'primary searchAddBtn') + '" ' +
        (addedSeries ? 'style="color:var(--danger);"' : '') +
        ' data-name="' + escapeAttr(item.name) + '" data-url="' + escapeAttr(item.url) + '" data-type="series">' +
        (addedSeries ? 'Remove (Shows)' : '+ Shows') + '</button>';
    } else {
      actionsHtml += '<button type="button" class="lc-btn searchLikeExternalBtn' + (alreadyLikedExt ? ' liked' : '') + '" data-url="' + escapeAttr(item.url) + '">' +
        (alreadyLikedExt ? '&#9829;' : '&#9825;') +
        '</button>';
      actionsHtml += '<button type="button" class="lc-btn ' + (addedDirect ? 'secondary searchAddBtn is-added' : 'primary searchAddBtn') + '" ' +
        (addedDirect ? 'style="color:var(--danger);"' : '') +
        ' data-name="' + escapeAttr(item.name) + '" data-url="' + escapeAttr(item.url) + '" data-type="' + escapeAttr(item.type || 'movie') + '">' +
        (addedDirect ? 'Remove' : '+ Add') +
        '</button>';
    }

    const creatorLabel = item.user ? (item.user.includes('Official') || item.user.includes('Franchise') ? escapeHtml(item.user) : 'by ' + escapeHtml(item.user)) : '';
    const itemCountLabel = typeof item.items === 'number' ? (item.items + ' items') : (item.items ? escapeHtml(String(item.items)) : '');

    const cardHtml = '<div class="list-card" data-list-type="' + escapeAttr(item.type || 'mixed') + '" data-name="' + escapeAttr(item.name) + '" data-url="' + escapeAttr(item.url) + '" data-type="' + escapeAttr(slotType) + '" data-creator="' + escapeAttr(item.user || '') + '" data-items="' + escapeAttr(item.items || '') + '" data-likes="' + escapeAttr(item.likes || 0) + '" data-source="' + escapeAttr(item.source) + '">' +
      '<div class="list-card-header">' +
      '<div class="list-card-body">' +
      '<div class="list-card-title searchViewListBtn" style="cursor:pointer;">' + sourceBadgeHtml + escapeHtml(item.name) + '</div>' +
      '<div class="list-card-meta">' +
      (creatorLabel ? '<span>' + creatorLabel + '</span>' : '') +
      (creatorLabel ? '<span class="list-card-meta-sep">&middot;</span>' : '') +
      '<span>' + typeLabel + '</span>' +
      (itemCountLabel ? '<span class="list-card-meta-sep">&middot;</span><span>' + itemCountLabel + '</span>' : '') +
      (item.likes !== undefined ? '<span class="list-card-meta-sep">&middot;</span><span class="list-card-likes like-count">&#9829; <span class="like-num">' + (item.likes || 0) + '</span></span>' : '') +
      '</div>' +
      '</div>' +
      '<div class="list-card-actions">' +
      actionsHtml +
      '</div>' +
      '</div>' +
      '<div class="list-card-posters poster-preview-slot" data-name="' + escapeAttr(item.name) + '" data-url="' + escapeAttr(item.url) + '" data-type="' + escapeAttr(slotType) + '" data-creator="' + escapeAttr(item.user || '') + '" data-items="' + escapeAttr(item.items || '') + '" data-likes="' + escapeAttr(item.likes || 0) + '"></div>' +
      '</div>';

    scoredCards.push({ score: matchScore, html: cardHtml });
  }

  scoredCards.sort((a, b) => b.score - a.score);
  const topCards = scoredCards.slice(0, 30);
  let html = topCards.map(c => c.html).join('');

  if (topCards.length === 0) {
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

  async function fetchPreviewOnce(listUrl, type) {
    const payload = { url: listUrl, type: type, sample: 12 };
    const mkInput = document.getElementById('mdblistKeyInput');
    payload.mdblistKey = (mkInput && mkInput.value ? mkInput.value.trim() : '') || localStorage.getItem('myListAddon:mdblistKey') || '';
    const tkInput = document.getElementById('tmdbKeyInput');
    payload.tmdbKey = (tkInput && tkInput.value ? tkInput.value.trim() : '') || localStorage.getItem('myListAddon:tmdbKey') || '';
    const trkInput = document.getElementById('traktKeyInput');
    payload.traktKey = (trkInput && trkInput.value ? trkInput.value.trim() : '') || localStorage.getItem('myListAddon:traktKey') || '';
    
    const trkToken = (typeof traktAccessToken !== 'undefined' && traktAccessToken) || localStorage.getItem('myListAddon:traktAccessToken') || '';
    if (trkToken) payload.traktAccessToken = trkToken;
    const mdbToken = (typeof mdblistAccessToken !== 'undefined' && mdblistAccessToken) || localStorage.getItem('myListAddon:mdblistAccessToken') || '';
    if (mdbToken) payload.mdblistAccessToken = mdbToken;
    const smkToken = (typeof simklAccessToken !== 'undefined' && simklAccessToken) || localStorage.getItem('myListAddon:simklAccessToken') || '';
    if (smkToken) payload.simklAccessToken = smkToken;
    const skInput = document.getElementById('simklKeyInput');
    payload.simklKey = (skInput && skInput.value ? skInput.value.trim() : '') || localStorage.getItem('myListAddon:simklKey') || '';
    
    try {
      const res = await fetch(ORIGIN + '/api/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        cache: 'no-store',
      });
      if (!res.ok) return { ok: false };
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) return { ok: false };
      return await res.json();
    } catch (e) {
      return { ok: false };
    }
  }

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
      if (!slot) continue;
      const listUrl = slot.dataset.url;
      const type = slot.dataset.type || 'movie';
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
            const isTraktSlot = !!slot.closest('#myPrivateTraktListsResult, #myTraktListsResult') || listUrl === 'trakt:watchlist' || listUrl === 'trakt:history';
            const isMdblistSlot = !!slot.closest('#myMdblistListsResult');

            let inner = '';
            validPosters.forEach((s, i) => {
              const isMobileEnd = (i === 2 && validPosters.length > 3);
              const isDesktopEnd = (i === validPosters.length - 1 && validPosters.length >= 4);

              let overlays = '';
              if (isMobileEnd) {
                overlays += '<div class="list-card-count-overlay mobile-only searchViewListBtn" data-name="' + escapeAttr(listName) + '" data-url="' + escapeAttr(listUrl) + '" data-type="' + escapeAttr(type) + '" data-creator="' + escapeAttr(cardCreator) + '" data-items="' + escapeAttr(totalCount) + '" data-likes="' + escapeAttr(cardLikes) + '" style="cursor:pointer;">' + totalCount + ' &rsaquo;</div>';
              }
              if (isDesktopEnd) {
                overlays += '<div class="list-card-count-overlay desktop-only searchViewListBtn" data-name="' + escapeAttr(listName) + '" data-url="' + escapeAttr(listUrl) + '" data-type="' + escapeAttr(type) + '" data-creator="' + escapeAttr(cardCreator) + '" data-items="' + escapeAttr(totalCount) + '" data-likes="' + escapeAttr(cardLikes) + '" style="cursor:pointer;">' + totalCount + ' &rsaquo;</div>';
              }

              let removeBtn = '';
              if (isTraktSlot) {
                const traktTarget = listUrl === 'trakt:watchlist' ? 'watchlist' : (listUrl === 'trakt:history' ? 'history' : 'custom');
                const slugMatch = listUrl.match(new RegExp('lists/([^/?#]+)'));
                const traktListId = traktTarget === 'custom' ? (slugMatch ? slugMatch[1] : listUrl) : traktTarget;
                removeBtn = '<button type="button" class="cw-remove-btn" data-remove-type="external" data-provider="trakt" data-target="' + escapeAttr(traktTarget) + '" data-list-id="' + escapeAttr(traktListId) + '" data-remove-id="' + escapeAttr(s.id || '') + '" data-media-type="' + escapeAttr(s.type || type || 'movie') + '" onclick="event.stopPropagation(); removeListItemFromDetails(this)" title="Remove from Trakt">&times;</button>';
              } else if (isMdblistSlot) {
                const mdbTarget = listUrl === 'mdblist:watchlist' ? 'watchlist' : (listUrl === 'mdblist:history' ? 'history' : 'custom');
                const mdbMatch = listUrl.match(new RegExp('lists/[^/]+/([^/?#]+)'));
                const mdbListId = mdbTarget === 'custom' ? (mdbMatch ? mdbMatch[1] : listUrl) : mdbTarget;
                removeBtn = '<button type="button" class="cw-remove-btn" data-remove-type="external" data-provider="mdblist" data-target="' + escapeAttr(mdbTarget) + '" data-list-id="' + escapeAttr(mdbListId) + '" data-remove-id="' + escapeAttr(s.id || '') + '" data-media-type="' + escapeAttr(s.type || type || 'movie') + '" onclick="event.stopPropagation(); removeListItemFromDetails(this)" title="Remove from MDBList">&times;</button>';
              }

              inner += '<div class="list-card-mini-poster-tile" data-name="' + escapeAttr(listName) + '" data-url="' + escapeAttr(listUrl) + '" data-type="' + escapeAttr(type) + '" data-creator="' + escapeAttr(cardCreator) + '" data-items="' + escapeAttr(totalCount) + '" data-likes="' + escapeAttr(cardLikes) + '">' +
                '<div class="list-card-mini-poster-img-wrap clickable-poster" data-id="' + escapeAttr(s.id || '') + '" data-type="' + escapeAttr(s.type || type || '') + '" data-title="' + escapeAttr(s.name || '') + '" data-poster="' + escapeAttr(s.poster || '') + '">' +
                  '<img src="' + escapeAttr(s.poster) + '" alt="" loading="lazy">' +
                  removeBtn +
                  '<div class="poster-add-overlay">+</div>' +
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
      } catch (e) {}
    }
  }

  Array.from({ length: Math.min(CONCURRENCY, slots.length) }, () => worker());
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
      likes: null
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
          likes: null
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
  const curatedAddBtn = e.target.closest('.curatedAddBtn');
  if (curatedAddBtn) {
    const listTitle = curatedAddBtn.dataset.title || 'Curated List';
    const listType = curatedAddBtn.dataset.type || 'movie';
    const customUrl = curatedAddBtn.dataset.url || '';
    const isAdded = curatedAddBtn.classList.contains('is-added') || (typeof isListAddedToConfig === 'function' && (isListAddedToConfig(null, listType, customUrl) || isListAddedToConfig(customUrl, listType)));
    if (isAdded) {
      if (typeof removeListFromConfig === 'function') {
        removeListFromConfig(null, listType, customUrl);
        removeListFromConfig(customUrl, listType);
      }
      curatedAddBtn.classList.remove('is-added', 'secondary');
      curatedAddBtn.classList.add('primary');
      curatedAddBtn.textContent = '+ Add';
      curatedAddBtn.style.color = '';
      showAddedToast('Removed "' + listTitle + '" from your Catalogs.');
    } else {
      addRow(listTitle, customUrl, listType, true, 'Curated');
      curatedAddBtn.classList.add('is-added', 'secondary');
      curatedAddBtn.classList.remove('primary');
      curatedAddBtn.textContent = 'Remove';
      curatedAddBtn.style.color = 'var(--danger)';
      showAddedToast('Added "' + listTitle + '" to your Catalogs.');
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
        // Creator credentials ride along when signed in so the vote is
        // recorded against the account (one like per account across every
        // device) rather than against this browser's IP. Optional --
        // signed-out liking still works, it just votes per-IP.
        body: JSON.stringify({
          username: parts[0],
          slug: parts[1],
          action: wasLiked ? 'unlike' : 'like',
          creatorName: activeCreator ? activeCreator.creatorName : undefined,
          creatorKey: activeCreator ? (localStorage.getItem('myListAddon:creatorKey') || undefined) : undefined,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        if (typeof showAppAlert === 'function') {
          showAppAlert('Could Not Update Like', data.error || 'Unknown error.', false);
        } else {
          alert('Could not update this like: ' + (data.error || 'unknown error'));
        }
        return;
      }
      const finalLikes = (data.likes !== undefined) ? data.likes : newLikes;
      if (wasLiked) {
        forgetLikedList(usernameSlug);
        likeBtn.classList.remove('liked');
        likeBtn.textContent = '\u2661';
      } else {
        rememberLikedList(usernameSlug);
        likeBtn.classList.add('liked');
        likeBtn.textContent = '\u2665';
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
      if (typeof showAppAlert === 'function') {
        showAppAlert('Network Error', 'Network error while updating this like.', false);
      } else {
        alert('Network error while updating this like.');
      }
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
        body: JSON.stringify({
          url: listUrl,
          action: wasLiked ? 'unlike' : 'like',
          creatorName: activeCreator ? activeCreator.creatorName : undefined,
          creatorKey: activeCreator ? (localStorage.getItem('myListAddon:creatorKey') || undefined) : undefined,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        if (typeof showAppAlert === 'function') {
          showAppAlert('Could Not Update Like', data.error || 'Unknown error.', false);
        } else {
          alert('Could not update this like: ' + (data.error || 'unknown error'));
        }
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
      if (typeof showAppAlert === 'function') {
        showAppAlert('Network Error', 'Network error while updating this like.', false);
      } else {
        alert('Network error while updating this like.');
      }
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
  items = Array.isArray(items) ? items : [];
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
    return '<div class="list-card-mini-poster-tile" data-title="' + escapeAttr(title) + '" data-type="' + escapeAttr(type) + '" data-url="' + escapeAttr(customUrl) + '">' +
      '<div class="list-card-mini-poster-img-wrap clickable-poster" data-id="' + escapeAttr(s.id || '') + '" data-type="' + escapeAttr(s.type || type) + '" data-title="' + escapeAttr(s.name || '') + '" data-poster="' + escapeAttr(s.poster || '') + '">' +
        '<img src="' + escapeAttr(s.poster) + '" alt="" loading="lazy">' +
        '<div class="poster-add-overlay">+</div>' +
        overlays +
      '</div>' +
      '<div class="list-card-mini-poster-name">' + escapeHtml(s.name) + '</div>' +
      (s.year ? '<div class="list-card-mini-poster-year">' + escapeHtml(s.year) + '</div>' : '') +
    '</div>';
  }).join('');

  window._curatedRecs = window._curatedRecs || {};
  window._curatedRecs[customUrl] = { title, type, items };

  const isAdded = typeof isListAddedToConfig === 'function' && (isListAddedToConfig(null, type, customUrl) || isListAddedToConfig(customUrl, type));
  const addBtnHtml = '<button type="button" class="lc-btn ' + (isAdded ? 'secondary curatedAddBtn is-added' : 'primary curatedAddBtn') + '" ' +
    (isAdded ? 'style="color:var(--danger);"' : '') +
    ' data-title="' + escapeAttr(title) + '" data-type="' + escapeAttr(type) + '" data-url="' + escapeAttr(customUrl) + '">' +
    (isAdded ? 'Remove' : '+ Add') +
  '</button>';

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
        addBtnHtml +
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

  let totalWatchHistoryCount = 0;
  Object.keys(customListsMap).forEach(k => {
    const l = customListsMap[k];
    if (k === 'watch-history' || k.includes('watch-history') || (l && l.name && l.name.toLowerCase().includes('watch history'))) {
      totalWatchHistoryCount += (l && l.items) ? l.items.length : 0;
    }
  });
  const continueWatching = customListsMap['continue-watching'] || (typeof getOrCreateContinueWatchingList === 'function' ? getOrCreateContinueWatchingList() : null) || { items: [] };

  const currentCount = totalWatchHistoryCount + (continueWatching.items ? continueWatching.items.length : 0);
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

    const customLists = Object.values(customListsMap).filter(Boolean);
    let whItems = [];
    Object.keys(customListsMap).forEach(k => {
      const l = customListsMap[k];
      if (k === 'watch-history' || k.includes('watch-history') || (l && l.name && l.name.toLowerCase().includes('watch history'))) {
        if (l && Array.isArray(l.items)) whItems.push(...l.items);
      }
    });
    if (!whItems.length && typeof getOrCreateWatchHistoryList === 'function') {
      const defWh = getOrCreateWatchHistoryList();
      if (defWh && Array.isArray(defWh.items)) whItems.push(...defWh.items);
    }
    if (!whItems.length) {
      try {
        const rawWh = JSON.parse(localStorage.getItem('myListAddon:watchHistory') || '[]');
        if (Array.isArray(rawWh)) whItems = rawWh;
      } catch (e) {}
    }
    const continueWatching = customListsMap['continue-watching'] || (typeof getOrCreateContinueWatchingList === 'function' ? getOrCreateContinueWatchingList() : null) || { items: [] };
    let cwItems = (continueWatching && Array.isArray(continueWatching.items)) ? continueWatching.items : [];

    const watchlist = customListsMap['watchlist'] || { items: [] };
    let wlItems = (watchlist && Array.isArray(watchlist.items)) ? watchlist.items : [];

    const otherCustomItems = [];
    Object.keys(customListsMap).forEach((k) => {
      if (k !== 'watch-history' && k !== 'continue-watching' && k !== 'watchlist') {
        const l = customListsMap[k];
        if (l && Array.isArray(l.items)) otherCustomItems.push(...l.items);
      }
    });
    if (typeof lastCreatorListsData !== 'undefined' && Array.isArray(lastCreatorListsData)) {
      lastCreatorListsData.forEach((l) => {
        if (l && Array.isArray(l.items)) otherCustomItems.push(...l.items);
      });
    }

    const allWatchedAndSaved = [...cwItems, ...whItems, ...wlItems, ...otherCustomItems];

    const movieIds = [];
    const showIds = [];
    const seenShowIds = new Set();
    const seenMovieIds = new Set();

    for (const it of allWatchedAndSaved) {
      if (!it) continue;
      const rawShowId = it.showId || (it.type === 'series' || it.type === 'tv' || it.kind === 'series' || it.kind === 'tv' || it.showTitle ? (it.id || it.imdbId) : null);
      if (rawShowId) {
        const cleanShowId = String(rawShowId).replace(/^tmdb:/, '').split(':')[0].trim();
        if (cleanShowId && !seenShowIds.has(cleanShowId)) {
          seenShowIds.add(cleanShowId);
          showIds.push(cleanShowId);
        }
      } else {
        const rawMovieId = it.imdbId || it.id;
        if (rawMovieId) {
          const cleanMovieId = String(rawMovieId).replace(/^tmdb:/, '').split(':')[0].trim();
          if (cleanMovieId && !seenMovieIds.has(cleanMovieId)) {
            seenMovieIds.add(cleanMovieId);
            movieIds.push(cleanMovieId);
          }
        }
      }
    }

    const likedUrls = [...getLikedListsSet()];
    const tmdbKey = (document.getElementById('tmdbKeyInput') ? document.getElementById('tmdbKeyInput').value.trim() : '') || localStorage.getItem('myListAddon:tmdbKey') || '';
    
    // Pass recent movie IDs and show IDs for rich recommendations
    const sampleMovieIds = movieIds.slice(0, 12);
    const sampleShowIds = showIds.slice(0, 12);

    const [recData, mdblists, traktLists] = await Promise.all([
      fetch(ORIGIN + '/api/recommendations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ movieIds: sampleMovieIds, showIds: sampleShowIds, tmdbKey })
      }).then(async (r) => {
        if (!r.ok) return { ok: false };
        const ct = r.headers.get('content-type') || '';
        if (!ct.includes('application/json')) return { ok: false };
        return await r.json();
      }).catch(() => ({ ok: false })),
      ensureMdblistPopularLoaded().catch(() => []),
      ensureTraktPopularLoaded().catch(() => [])
    ]);

    const chartCatalogList = (typeof CHART_SLUG_ENTRIES !== 'undefined' && Array.isArray(CHART_SLUG_ENTRIES))
      ? CHART_SLUG_ENTRIES.map(c => ({ name: c.name, url: c.movieUrl || c.showUrl || c.url, type: (c.showUrl && c.showUrl.includes('shows')) ? 'series' : 'movie', user: 'Curated' }))
      : [];

    const publicListsPool = [...(mdblists || []), ...(traktLists || []), ...chartCatalogList];
    let sectionsHtml = '';

    // Keep a copy of exactly what these two cards are about to render, so
    // the catalog row for the same list can serve the same items rather
    // than re-deriving its own. fetchCuratedCatalog (05_catalog-core.js)
    // can only see server-side tracking data, while these cards are built
    // from this browser's whole picture -- Continue Watching, Watch
    // History, Watchlist and every other custom list -- so re-deriving
    // could never land on the same 40 items. pushTrackingSync
    // (22_client-creator-profile.js) carries this up alongside Airing
    // Next, which is a snapshot for exactly the same reason.
    if (typeof persistCuratedRecommendations === 'function' && recData && recData.ok) {
      persistCuratedRecommendations(recData.movies, recData.shows);
    }

    // Section A: Recommended Movies List
    if (recData && recData.ok && recData.movies && recData.movies.length) {
      sectionsHtml += buildCuratedRecommendationCard('Recommended Movies', 'movie', 'custom:curated:recommended-movies', 'Based on your movie watch history & watchlist', recData.movies);
    }

    // Section B: Recommended Shows List
    if (recData && recData.ok && recData.shows && recData.shows.length) {
      sectionsHtml += buildCuratedRecommendationCard('Recommended Shows', 'series', 'custom:curated:recommended-shows', 'Based on your series watch history & continue watching', recData.shows);
    }

    // Section C: Recommended Community & Curated Lists
    if (publicListsPool.length) {
      const alreadyAdded = new Set();
      document.querySelectorAll('#lists .entry').forEach(function(entry) {
        const t = entry.querySelector('.type') ? entry.querySelector('.type').value : '';
        entry.querySelectorAll('.url').forEach(function(el) {
          alreadyAdded.add(el.value.trim() + '|' + t);
        });
      });

      let recommendedLists = [];
      if (likedUrls.length) {
        const likedKeywords = likedUrls.map(u => {
          const parts = u.split('/').filter(Boolean);
          return parts[parts.length - 1] ? parts[parts.length - 1].replace(/[-_]/g, ' ') : '';
        }).filter(Boolean);

        recommendedLists = publicListsPool.filter(l => {
          if (likedUrls.includes(l.url)) return false;
          const nameLower = (l.name || '').toLowerCase();
          return likedKeywords.some(kw => kw.length > 3 && nameLower.includes(kw.toLowerCase()));
        }).slice(0, 6);
      }

      if (!recommendedLists.length) {
        // Pick top popular & trending community lists
        recommendedLists = publicListsPool.filter(l => !alreadyAdded.has(l.url + '|' + (l.type || 'movie'))).slice(0, 8);
      }

      if (recommendedLists.length) {
        sectionsHtml += '<div style="margin-top:24px; margin-bottom:8px;"><h3 style="font-size:0.95rem; margin:0 0 2px;">Recommended Community Lists</h3><p style="margin:0; font-size:0.8rem; color:var(--muted);">Top community and curated lists you might like</p></div>';
        sectionsHtml += recommendedLists.map(l => {
          const type = l.type || 'movie';
          const added = alreadyAdded.has(l.url + '|' + type);
          const alreadyLiked = getLikedListsSet().has(l.url);
          const author = l.user || l.creatorName || 'Community';
          return '<div class="list-card" data-list-type="' + escapeAttr(type) + '" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url) + '" data-type="' + escapeAttr(type) + '" data-creator="' + escapeAttr(author) + '" data-items="' + escapeAttr(l.items || '') + '" data-likes="' + escapeAttr(l.likes || 0) + '">' +
            '<div class="list-card-header">' +
              '<div class="list-card-body">' +
                '<div class="list-card-title searchViewListBtn" style="cursor:pointer;">' + escapeHtml(l.name) + '</div>' +
                '<div class="list-card-meta">' +
                  '<span>by ' + escapeHtml(author) + '</span>' +
                  '<span class="list-card-meta-sep">&middot;</span>' +
                  '<span>' + (type === 'series' ? 'Shows' : 'Movies') + '</span>' +
                  (l.items ? '<span class="list-card-meta-sep">&middot;</span><span>' + l.items + ' items</span>' : '') +
                  '<span class="list-card-likes">&#9829; <span class="like-num">' + (l.likes || 0) + '</span></span>' +
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
                '<div class="list-card-title searchViewListBtn" style="cursor:pointer;">' + escapeHtml(l.name) + '</div>' +
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
    console.error('Curated lists error:', err);
    container.innerHTML =
      '<div style="text-align:center; padding:24px 16px; background:var(--card-bg); border:1px solid var(--border); border-radius:14px;">' +
        '<p style="margin:0 0 10px; font-size:0.88rem; color:var(--muted);">Watch more items or like community lists to build personalized recommendations.</p>' +
        '<button type="button" class="lc-btn primary" onclick="filterDiscoverShelves(&quot;all&quot;)">Explore Discover</button>' +
      '</div>';
  }
}

async function renderLikedListsFeed(forceRefresh) {
  const container = document.getElementById('likedListsFeed');
  if (!container) return;
  const likedUrls = [...getLikedListsSet()];
  if (!likedUrls.length) {
    container.innerHTML = '<p style="color:var(--muted); font-size:0.88rem;">No liked lists yet. Tap the heart &#x2661; on any list to save it here.</p>';
    container.dataset.likedCount = '0';
    return;
  }
  if (!forceRefresh && container.dataset.likedCount === String(likedUrls.length) && container.children.length > 0 && !container.innerText.includes('Loading')) {
    return;
  }
  container.dataset.likedCount = String(likedUrls.length);
  container.innerHTML = '<p style="color:var(--muted); font-size:0.88rem;">Loading your ' + likedUrls.length + ' liked list(s)...</p>';
  try {
    const toplists = await ensureMdblistPopularLoaded();
    const topMap = new Map();
    (toplists || []).forEach(l => {
      if (l.url) topMap.set(l.url, l);
      if (l.user && l.slug) topMap.set(l.user + '/' + l.slug, l);
    });

    // A liked identifier is either a real external URL (liked via
    // /api/lists/like-external, stored as the URL itself) or this app's
    // own "username/slug" (liked via /api/lists/like, stored as that
    // pair, never a URL at all). The two need different data sources --
    // and, in render5PosterListsFeed below, a different like/unlike
    // button wired to the matching endpoint, since sending "username/
    // slug" to like-external is exactly what made unliking one of this
    // app's own lists from here fail with "That URL can't be liked".
    const ownSlugPending = [];
    const likedListObjects = likedUrls.map(u => {
      if (topMap.has(u)) return topMap.get(u);
      if (!u.includes('://')) {
        const parts = u.split('/');
        if (parts.length === 2 && parts[0] && parts[1]) {
          const placeholder = { usernameSlug: u, kind: 'own' };
          ownSlugPending.push(placeholder);
          return placeholder;
        }
      }
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

    // Real name/creator/type/item count/likes for each of this app's own
    // liked lists -- and, via the poster-preview fetch the resulting
    // .url enables (populateSearchResultPosters, keyed off a real
    // /lists/:user/:slug URL now instead of a bare "username/slug"),
    // real posters too. Before this, every one of these rendered as a
    // generic "Community" placeholder with no poster at all -- the
    // placeholder object never carried one to begin with.
    await Promise.all(ownSlugPending.map(async (entry) => {
      const [username, slug] = entry.usernameSlug.split('/');
      const listUrl = ORIGIN + '/lists/' + encodeURIComponent(username) + '/' + encodeURIComponent(slug);
      try {
        const res = await fetch(listUrl + '.json?format=object', { cache: 'no-store' });
        const data = await res.json().catch(() => null);
        if (data && data.ok) {
          entry.url = listUrl;
          entry.name = data.name || entry.usernameSlug;
          entry.user = data.creator || username;
          entry.type = data.type || 'movie';
          entry.items = data.itemCount || 0;
          entry.likes = data.likes || 0;
          return;
        }
      } catch (e) {
        // falls through to the "unavailable" shape below
      }
      // List was unpublished or deleted since being liked -- still shown
      // (with whatever it's still possible to say about it) so there's a
      // card to unlike, rather than a liked list that just silently
      // vanishes from this view with no way to clear it.
      entry.url = '';
      entry.name = guessNameFromUrl(entry.usernameSlug);
      entry.user = 'Unavailable';
      entry.type = 'movie';
      entry.items = 0;
      entry.likes = 0;
    }));

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
    const added = l.url ? alreadyAdded.has(l.url + '|' + type) : false;
    const author = l.user || l.creatorName || 'Official';
    const itemCount = l.items || l.count || null;
    // This app's own published lists are liked via /api/lists/like with
    // a username/slug pair; everything else via /api/lists/like-external
    // with the list's real URL. Every card here used to get the external
    // button regardless, which sends a bare "username/slug" to an
    // endpoint that only accepts a real URL and correctly refuses it --
    // that's the reported "That URL can't be liked" on unlike.
    const isOwn = l.kind === 'own';
    const alreadyLiked = isOwn ? getLikedListsSet().has(l.usernameSlug) : getLikedListsSet().has(l.url);
    const likeBtnHtml = isOwn
      ? '<button type="button" class="lc-btn searchLikeBtn' + (alreadyLiked ? ' liked' : '') + '" data-username-slug="' + escapeAttr(l.usernameSlug) + '">' +
          (alreadyLiked ? '&#x2665;' : '&#x2661;') +
        '</button>'
      : '<button type="button" class="lc-btn searchLikeExternalBtn' + (alreadyLiked ? ' liked' : '') + '" data-url="' + escapeAttr(l.url) + '">' +
          (alreadyLiked ? '&#x2665;' : '&#x2661;') +
        '</button>';

    return '<div class="list-card" data-list-type="' + escapeAttr(type) + '" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url || '') + '" data-type="' + escapeAttr(type) + '" data-creator="' + escapeAttr(author) + '" data-items="' + escapeAttr(itemCount || '') + '" data-likes="' + escapeAttr(l.likes || 0) + '">' +
      '<div class="list-card-header">' +
        '<div class="list-card-body">' +
          '<div class="list-card-title searchViewListBtn" style="cursor:pointer;">' + escapeHtml(l.name) + '</div>' +
          '<div class="list-card-meta">' +
            '<span>by ' + escapeHtml(author) + '</span>' +
            '<span class="list-card-meta-sep">&middot;</span>' +
            '<span>' + (type === 'series' ? 'Shows' : 'Movies') + '</span>' +
            (itemCount ? '<span class="list-card-meta-sep">&middot;</span><span>' + itemCount + ' items</span>' : '') +
            '<span class="list-card-meta-sep">&middot;</span><span class="list-card-likes">&#9829; <span class="like-num">' + (l.likes || 0) + '</span></span>' +
          '</div>' +
        '</div>' +
        '<div class="list-card-actions">' +
          likeBtnHtml +
          '<button type="button" class="lc-btn ' + (added ? 'secondary searchAddBtn is-added' : 'primary searchAddBtn') + '" ' +
            (added ? 'style="color:var(--danger);"' : '') +
            ' data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url || '') + '" data-type="' + escapeAttr(type) + '">' +
            (added ? 'Remove' : '+ Add') +
          '</button>' +
        '</div>' +
      '</div>' +
      '<div class="list-card-posters poster-preview-slot" data-name="' + escapeAttr(l.name) + '" data-url="' + escapeAttr(l.url || '') + '" data-type="' + escapeAttr(type) + '" data-creator="' + escapeAttr(author) + '" data-items="' + escapeAttr(itemCount || '') + '" data-likes="' + escapeAttr(l.likes || 0) + '"></div>' +
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
  const posterEl = addOverlayBtn ? addOverlayBtn.closest('.clickable-poster, .live-preview-poster-card, .list-card-mini-poster-img-wrap, .list-card-mini-poster-tile') : e.target.closest('.clickable-poster, .live-preview-poster-card, .list-card-mini-poster-tile, .list-card-mini-poster-img-wrap');
  
  if (addOverlayBtn && posterEl) {
    e.stopPropagation(); // prevent opening the details modal
    const clickEl = posterEl.matches('.clickable-poster') ? posterEl : (posterEl.querySelector('.clickable-poster') || posterEl);
    let id = clickEl.dataset.id || posterEl.dataset.id || '';
    if (id && id.startsWith('tt') && id.includes(':')) id = id.split(':')[0];
    const type = clickEl.dataset.type || posterEl.dataset.type || 'movie';
    const title = clickEl.dataset.title || posterEl.dataset.title || '';
    const poster = clickEl.dataset.poster || posterEl.dataset.poster || (posterEl.querySelector('img') && posterEl.querySelector('img').src) || '';
    openSelectListModal(id, type, title, poster);
    return;
  }
  
  if (posterEl && !e.target.closest('.searchViewListBtn, .curatedViewBtn, .list-card-count-overlay, .creatorListViewBtn, .discover-chart-seeall, .cw-remove-btn')) {
    closeDetailOverlay();
    closeModal();
    const clickEl = posterEl.matches('.clickable-poster') ? posterEl : (posterEl.querySelector('.clickable-poster') || posterEl);
    let id = clickEl.dataset.id || posterEl.dataset.id || '';
    if (id && id.startsWith('tt') && id.includes(':')) id = id.split(':')[0];
    const type = clickEl.dataset.type || posterEl.dataset.type || 'movie';
    if (id) {
      openItemDetailsModal(id, type);
    }
    return;
  }
});

// Client-side "is this episode aired yet" check -- same rule the server's
// isEpisodeAiredServer uses (07_source-fetchers-tmdb-simkl.js). Needed by
// updateContinueWatching (21_client-custom-list-builder.js) and
// markShowWatched (also 21) to exclude future episodes from "fully
// watched" detection and from what Mark Whole Show Watched fetches.
function isEpisodeAired(ep) {
  if (!ep) return false;
  const dateStr = (typeof ep === 'string') ? ep : (ep.air_date || ep.airDate || '');
  if (!dateStr) return false;
  const parts = String(dateStr).split(/[-T\s]/);
  if (parts.length < 3) return false;
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1;
  const day = parseInt(parts[2], 10);
  if (isNaN(year) || isNaN(month) || isNaN(day)) return false;
  const airDate = new Date(year, month, day);
  if (isNaN(airDate.getTime())) return false;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // If airDate is before today, the episode has already aired (same-day airs today)
  return airDate.getTime() < today.getTime();
}

function formatAirDateBadge(airDateStr) {
  if (!airDateStr) return '';
  const parts = String(airDateStr).split(/[-T\s]/);
  if (parts.length < 3) return '';
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1;
  const day = parseInt(parts[2], 10);
  if (isNaN(year) || isNaN(month) || isNaN(day)) return '';
  const d = new Date(year, month, day);
  if (isNaN(d.getTime())) return '';

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((d.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  // If already aired before today, no upcoming badge is shown
  if (diffDays < 0) return '';
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays > 1 && diffDays < 7) {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return days[d.getDay()];
  }
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (d.getFullYear() !== now.getFullYear()) {
    return months[d.getMonth()] + ' ' + String(d.getFullYear()).slice(-2);
  }
  return months[d.getMonth()] + ' ' + d.getDate();
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
  
  window._currentEpisodeDetails = ep;
  
  let isWatched = window._watchedItemIds && window._watchedItemIds.has(String(ep.id));
  if (!isWatched && window._watchedItemIds) {
    const d = window._currentItemDetails;
    if (d && ep.season_number != null && ep.episode_number != null) {
      if (d.id && window._watchedItemIds.has(d.id + ':' + ep.season_number + ':' + ep.episode_number)) isWatched = true;
      if (d.tmdbId && window._watchedItemIds.has('tmdb:' + d.tmdbId + ':' + ep.season_number + ':' + ep.episode_number)) isWatched = true;
      if (d.title && window._watchedItemIds.has(d.title + ':' + ep.season_number + ':' + ep.episode_number)) isWatched = true;
    }
  }
  if (!isWatched && Array.isArray(window._rawWatchHistoryItems)) {
    const d = window._currentItemDetails;
    const epNum = Number(ep.episode_number);
    const sNum = Number(ep.season_number);
    isWatched = window._rawWatchHistoryItems.some((it) => {
      if (!it || it.type !== 'episode') return false;
      if (String(it.id) === String(ep.id)) return true;
      if (Number(it.seasonNum) === sNum && Number(it.episodeNum) === epNum) {
        if (d && d.id && (String(it.showId) === String(d.id) || String(it.showId) === ('tmdb:' + d.tmdbId))) return true;
        if (d && d.title && (it.showTitle === d.title || String(it.showId) === d.title)) return true;
      }
      return false;
    });
  }
  const innerHtml = 
    '<button type="button" class="modal-close-x" onclick="closeModal()">\u2715</button>' +
    '<div style="display:flex; flex-direction:row; gap:32px; flex-wrap:wrap; margin-top:20px;">' +
      '<div style="flex: 0 0 300px; max-width: 100%;">' +
        (still ? '<img src="' + still + '" style="width:100%; border-radius:8px; box-shadow: 0 4px 12px rgba(0,0,0,0.5);">' : '') +
      '</div>' +
      '<div style="flex: 1; min-width: 300px;">' +
        '<h1 style="margin:0 0 16px; font-size:2.5rem; font-family: serif;">E' + ep.episode_number + ' - ' + escapeHtml(ep.name) + '</h1>' +
          '<div style="margin-bottom:20px;">' +
            '<button type="button" id="btnMarkWatched" class="lc-btn ' + (isWatched ? 'secondary' : 'primary') + '" onclick="toggleEpisodeWatchStatusFromModal()">' +
              (isWatched ? '<span style="margin-right:4px;">&#x2713;</span> Mark as unwatched' : 'Mark as Watched') +
            '</button>' +
          '</div>' +
        '<div style="margin-bottom:16px; color:var(--text); font-size:1.05rem;">' + infoHtml + '</div>' +
        '<p style="font-size:1.05rem; line-height:1.6; color:var(--text); margin-bottom: 24px;">' + escapeHtml(ep.overview || 'No overview available.') + '</p>' +
      '</div>' +
    '</div>';
    
  showModal(innerHtml, 'modal-card-wide');
}

window.toggleEpisodeWatchStatusFromModal = function() {
  const ep = window._currentEpisodeDetails;
  if (!ep || !ep.id) return;
  const still = ep.still_path ? ep.still_path : '';
  toggleWatchStatus(String(ep.id), 'episode', ep.name || '', still);
};

window.toggleMovieWatchStatusFromModal = function() {
  const d = window._currentItemDetails;
  if (!d || !d.id) return;
  toggleWatchStatus(String(d.id), 'movie', d.title || '', d.poster || '');
};

window.openSelectListModalFromItemModal = function() {
  const d = window._currentItemDetails;
  if (!d || !d.id) return;
  const isSeries = (d.seasonsData && d.seasonsData.length > 0) || d.type === 'series' || d.type === 'tv';
  openSelectListModal(d.id, isSeries ? 'series' : 'movie', d.title || '', d.poster || '');
};

function isSeasonFullyWatched(showId, seasonNum, episodeCount) {
  if (!showId || seasonNum == null) return false;
  const sNum = Number(seasonNum);
  const d = window._currentItemDetails;
  const showIdsToCheck = new Set([
    String(showId),
    String(showId).startsWith('tmdb:') ? String(showId).slice(5) : ('tmdb:' + String(showId)),
    (d && d.id) ? String(d.id) : null,
    (d && d.id && String(d.id).startsWith('tmdb:')) ? String(d.id).slice(5) : (d && d.id ? ('tmdb:' + String(d.id)) : null),
    (d && d.imdbId) ? String(d.imdbId) : null,
    (d && d.tmdbId) ? String(d.tmdbId) : null,
    (d && d.tmdbId) ? ('tmdb:' + d.tmdbId) : null,
  ].filter(Boolean));

  if (window._fullyWatchedShowIds) {
    for (const sid of showIdsToCheck) {
      if (window._fullyWatchedShowIds.has(sid)) return true;
    }
  }

  try {
    const map = (typeof loadLocalCustomLists === 'function') ? loadLocalCustomLists() : {};
    const hist = map['watch-history'];
    if (!hist || !Array.isArray(hist.items)) return false;

    const watchedEps = hist.items.filter((it) => {
      if (!it || it.type !== 'episode' || Number(it.seasonNum) !== sNum) return false;
      if (it.showId && showIdsToCheck.has(String(it.showId))) return true;
      if (d && d.title && it.showTitle && it.showTitle.toLowerCase() === d.title.toLowerCase()) return true;
      return false;
    });

    const distinctEps = new Set(watchedEps.map(it => it.episodeNum != null ? Number(it.episodeNum) : null).filter(n => n != null));

    if (window._seasonEpisodesMap && window._seasonEpisodesMap[sNum]) {
      const aired = window._seasonEpisodesMap[sNum].filter(ep => typeof isEpisodeAired !== 'function' || isEpisodeAired(ep));
      if (aired.length > 0) return distinctEps.size >= aired.length;
    }

    if (episodeCount && episodeCount > 0) {
      return distinctEps.size >= episodeCount;
    }
    return distinctEps.size > 0;
  } catch (e) {
    return false;
  }
}
window.isSeasonFullyWatched = isSeasonFullyWatched;

function updateSeasonWatchedButton(seasonNum) {
  const d = window._currentItemDetails;
  if (!d) return;
  const sNum = Number(seasonNum);
  const seasonMeta = (d.seasonsData || []).find(s => Number(s.season_number) === sNum);
  const epCount = seasonMeta ? seasonMeta.episode_count : 0;
  const isWatched = isSeasonFullyWatched(d.id, sNum, epCount);
  document.querySelectorAll('.btn-mark-season-watched[data-season="' + sNum + '"]').forEach(btn => {
    if (isWatched) {
      btn.innerHTML = '<span style="margin-right:4px;">&#x2713;</span> Mark Season Unwatched';
      btn.classList.remove('primary');
      btn.classList.add('secondary');
    } else {
      btn.innerHTML = 'Mark Season Watched';
      btn.classList.remove('secondary');
      btn.classList.add('primary');
    }
  });
}
window.updateSeasonWatchedButton = updateSeasonWatchedButton;

window.markSeasonWatched = async function(seasonNum, btn) {
  const d = window._currentItemDetails;
  if (!d || !d.id) return;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Updating…';
  }

  const tkInput = document.getElementById('tmdbKeyInput');
  const tmdbKey = (tkInput && tkInput.value ? tkInput.value.trim() : '') || localStorage.getItem('myListAddon:tmdbKey') || '';

  try {
    const res = await fetch(ORIGIN + '/api/season?imdbId=' + encodeURIComponent(d.id) +
      (d.tmdbId ? '&tmdbId=' + encodeURIComponent(d.tmdbId) : '') +
      '&seasonNum=' + seasonNum + (tmdbKey ? '&tmdbKey=' + encodeURIComponent(tmdbKey) : ''));
    const data = await res.json();
    if (!data.ok || !data.season || !Array.isArray(data.season.episodes)) {
      throw new Error(data.error || 'Failed to fetch season episodes');
    }

    const episodes = [];
    data.season.episodes.forEach(ep => {
      if (typeof isEpisodeAired === 'function' && !isEpisodeAired(ep)) return;
      const epStill = ep.still_path
        ? (ep.still_path.startsWith('http') ? ep.still_path : 'https://image.tmdb.org/t/p/w500' + ep.still_path)
        : (d.poster || '');
      episodes.push({
        id: String(ep.id),
        type: 'episode',
        name: ep.name,
        poster: epStill,
        showId: String(d.id),
        showTitle: d.title,
        showPoster: d.poster || '',
        seasonNum: seasonNum,
        episodeNum: ep.episode_number,
      });
    });

    if (!episodes.length) {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Mark Season Watched';
      }
      return;
    }

    const resBatch = toggleBatchWatchStatus(episodes);
    if (btn) {
      btn.disabled = false;
      if (resBatch.nowWatched) {
        btn.innerHTML = '<span style="margin-right:4px;">&#x2713;</span> Mark Season Unwatched';
        btn.classList.remove('primary');
        btn.classList.add('secondary');
      } else {
        btn.innerHTML = 'Mark Season Watched';
        btn.classList.remove('secondary');
        btn.classList.add('primary');
      }
    }

    // Check if whole show is watched or not
    if (d.seasonsData && Array.isArray(d.seasonsData)) {
      const allSeasonsWatched = d.seasonsData.filter(s => s.season_number !== 0).every(s => {
        if (s.season_number === seasonNum) return resBatch.nowWatched;
        return isSeasonFullyWatched(d.id, s.season_number, s.episode_count);
      });
      if (typeof setShowFullyWatched === 'function') {
        setShowFullyWatched(String(d.id), allSeasonsWatched);
      }
    }

    // Update overall show watched button if present
    const btnShow = document.getElementById('btnMarkShowWatched');
    if (btnShow && typeof isItemWatched === 'function') {
      const showWatched = isItemWatched(d.id, d.tmdbId, d.imdbId);
      if (showWatched) {
        btnShow.innerHTML = '<span style="margin-right:4px;">&#x2713;</span> Mark Whole Show Unwatched';
        btnShow.classList.remove('primary');
        btnShow.classList.add('secondary');
      } else {
        btnShow.innerHTML = 'Mark Whole Show Watched';
        btnShow.classList.remove('secondary');
        btnShow.classList.add('primary');
      }
    }
  } catch (err) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Error';
      setTimeout(() => {
        btn.textContent = 'Mark Season Watched';
      }, 2000);
    }
  }
};

function isItemWatched(id, tmdbId, imdbId) {
  const idsToCheck = [id, tmdbId, imdbId, (tmdbId ? 'tmdb:' + tmdbId : null), (id ? 'tmdb:' + id : null)].filter(Boolean).map(String);
  if (window._watchedItemIds) {
    if (idsToCheck.some(i => window._watchedItemIds.has(i))) return true;
  }
  if (window._fullyWatchedShowIds) {
    if (idsToCheck.some(i => window._fullyWatchedShowIds.has(i))) return true;
  }
  try {
    const map = (typeof loadLocalCustomLists === 'function') ? loadLocalCustomLists() : {};
    for (const key of Object.keys(map)) {
      const l = map[key];
      if (key === 'watch-history' || key.includes('watch-history') || (l && l.name && l.name.toLowerCase().includes('watch history'))) {
        if (l && Array.isArray(l.items)) {
          if (l.items.some(it => idsToCheck.includes(String(it.id)) || idsToCheck.includes(String(it.imdbId)) || idsToCheck.includes(String(it.showId)))) {
            return true;
          }
        }
      }
    }
  } catch (e) {}
  try {
    const rawWh = JSON.parse(localStorage.getItem('myListAddon:watchHistory') || '[]');
    if (Array.isArray(rawWh) && rawWh.some(it => idsToCheck.includes(String(it.id)) || idsToCheck.includes(String(it.imdbId)))) {
      return true;
    }
  } catch (e) {}
  return false;
}

// opts.skipPushState is set by the popstate handler and the initial
// deep-link check (both in 24_client-backup-restore-presets.js) -- in
// either case the browser's URL already points here, so pushing another
// history entry would just create a duplicate back-button step.
async function openItemDetailsModal(id, type, opts) {
  opts = opts || {};
  if (!id || id.startsWith('channel_')) return;
  
  const visiblePanel = document.querySelector('.tab-panel:not([hidden])')?.dataset?.tabPanel;
  const currentActiveTab = visiblePanel || document.querySelector('.tab-btn.active, .bottom-nav-item.active')?.dataset.tab || window._originTab || 'discover';
  if (currentActiveTab === 'list-details') {
    window._listScrollY = window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0;
    window._previousTab = 'list-details';
  } else if (currentActiveTab !== 'item-details') {
    window._previousTab = currentActiveTab;
    window._previousScrollY = window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0;
  }
  switchTab('item-details');
  window.scrollTo({ top: 0, behavior: 'instant' });

  // A real, bookmarkable/shareable URL for this specific title.
  if (!opts.skipPushState) {
    const params = new URLSearchParams({ id: id, type: type || 'movie' });
    const targetHash = '#/item?' + params.toString();
    const currentHash = location.hash || '';
    if (currentHash !== targetHash) {
      history.pushState({ view: 'item', id: id, type: type, fromList: (currentActiveTab === 'list-details'), listScrollY: window._listScrollY }, '', targetHash);
    }
  }
  
  const body = document.getElementById('itemDetailsBody');
  body.innerHTML = '<p style="color:var(--muted); text-align:center; padding: 40px;">Fetching information from TMDB...</p>';
  
  const tkInput = document.getElementById('tmdbKeyInput');
  const tmdbKey = (tkInput && tkInput.value ? tkInput.value.trim() : '') || localStorage.getItem('myListAddon:tmdbKey') || '';
  const regionEl = document.getElementById('regionSelect');
  const region = (regionEl && regionEl.value) || localStorage.getItem('myListAddon:region') || 'US';
  
  try {
    const res = await fetch(ORIGIN + '/api/details?imdbId=' + encodeURIComponent(id) + '&tmdbKey=' + encodeURIComponent(tmdbKey) + (type ? '&type=' + encodeURIComponent(type) : '') + '&region=' + encodeURIComponent(region));
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      let parsed = null;
      try { parsed = JSON.parse(errText); } catch(e) {}
      throw new Error((parsed && parsed.error) || 'Not found or TMDB error');
    }
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      throw new Error('Server returned non-JSON response.');
    }
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
        const isSeasonWatched = isSeasonFullyWatched(d.id, season.season_number, season.episode_count);
        seasonsHtml += 
          '<div class="season-card">' +
            '<div class="season-header" onclick="toggleSeasonEpisodes(this, ' + season.season_number + ', &quot;' + escapeJsAttr(d.id) + '&quot;)">' +
              '<div class="season-header-main">' +
                (sPoster ? '<img src="' + escapeAttr(sPoster) + '" class="season-header-poster" alt="">' : '<div class="season-header-poster-placeholder"></div>') +
                '<div class="season-header-info">' +
                  '<h4 class="season-header-title">' + escapeHtml(season.name) + '</h4>' +
                  '<div class="season-header-episodes">' + season.episode_count + ' episodes</div>' +
                '</div>' +
              '</div>' +
              '<div class="season-header-actions">' +
                '<button type="button" class="lc-btn ' + (isSeasonWatched ? 'secondary' : 'primary') + ' btn-mark-season-watched" data-season="' + season.season_number + '" onclick="event.stopPropagation(); markSeasonWatched(' + season.season_number + ', this)">' +
                  (isSeasonWatched ? '<span style="margin-right:4px;">&#x2713;</span> Mark Season Unwatched' : 'Mark Season Watched') +
                '</button>' +
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
          '<div style="display:flex; gap:16px; flex-wrap:wrap; align-items:center; margin-top:20px;">' +
            '<button type="button" class="lc-btn primary" onclick="openSelectListModalFromItemModal()">+ Add to list</button>' +
            (((d.seasonsData && d.seasonsData.length > 0) || type === 'series') ?
              '<button type="button" id="btnMarkShowWatched" class="lc-btn ' + (isItemWatched(d.id, d.tmdbId, d.imdbId) ? 'secondary' : 'primary') + '" onclick="markShowWatched(&quot;' + escapeJsAttr(d.id) + '&quot;)">' +
                (isItemWatched(d.id, d.tmdbId, d.imdbId) ? '<span style="margin-right:4px;">&#x2713;</span> Mark Whole Show Unwatched' : 'Mark Whole Show Watched') +
              '</button>'
              :
              '<button type="button" id="btnMarkWatched" class="lc-btn ' + (isItemWatched(d.id, d.tmdbId, d.imdbId) ? 'secondary' : 'primary') + '" onclick="toggleMovieWatchStatusFromModal()">' +
                (isItemWatched(d.id, d.tmdbId, d.imdbId) ? '<span style="margin-right:4px;">&#x2713;</span> Mark as unwatched' : 'Mark as Watched') +
              '</button>') +
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
  const tmdbKey = (tkInput && tkInput.value ? tkInput.value.trim() : '') || localStorage.getItem('myListAddon:tmdbKey') || '';
  
  try {
    const d = window._currentItemDetails;
    const res = await fetch(ORIGIN + '/api/season?imdbId=' + encodeURIComponent(imdbId) +
      (d && d.tmdbId ? '&tmdbId=' + encodeURIComponent(d.tmdbId) : '') +
      '&seasonNum=' + seasonNum + '&tmdbKey=' + encodeURIComponent(tmdbKey));
    const data = await res.json();
    if (!data.ok || !data.season || !data.season.episodes) throw new Error(data.error || 'Failed to load season');
    
    if (!window._seasonEpisodesMap) window._seasonEpisodesMap = {};
    window._seasonEpisodesMap[seasonNum] = data.season.episodes;
    
    let epsHtml = '';
    if (!window._episodeDataCache) window._episodeDataCache = {};
    data.season.episodes.forEach(ep => {
      window._episodeDataCache[ep.episode_number] = ep;
      const still = ep.still_path ? escapeAttr(ep.still_path) : '';
      epsHtml += 
        '<div class="clickable-episode" data-id="' + ep.id + '" data-season="' + seasonNum + '" data-episode="' + ep.episode_number + '" data-show-id="' + escapeAttr(imdbId || '') + '" style="display:flex; flex-direction:column; gap:4px; cursor:pointer;" onclick="openEpisodeDetails(' + ep.episode_number + ')">' +
          '<div style="width:100%; aspect-ratio:16/9; background:#222; border-radius:6px; overflow:hidden; position:relative; box-shadow:0 2px 6px rgba(0,0,0,0.4);">' +
            (still ? '<img src="' + still + '" style="width:100%; height:100%; object-fit:cover;">' : '') +
            '<div style="position:absolute; bottom:4px; left:4px; background:rgba(0,0,0,0.8); color:var(--brand); padding:2px 6px; border-radius:4px; font-weight:bold; font-size:0.8rem;">E' + ep.episode_number + '</div>' +
          '</div>' +
          '<div style="font-size:0.9rem; color:var(--text); line-height:1.2; padding-top:4px;">' + escapeHtml(ep.name) + '</div>' +
        '</div>';
    });
    grid.innerHTML = epsHtml || '<div style="grid-column: 1 / -1; color:var(--muted);">No episodes found.</div>';
    if (typeof updateSeasonWatchedButton === 'function') updateSeasonWatchedButton(seasonNum);
  } catch (err) {
    grid.innerHTML = '<div style="grid-column: 1 / -1; color:red;">Error loading episodes.</div>';
  }
}

function getExternalListMembership() {
  try {
    return JSON.parse(localStorage.getItem('myListAddon:externalMembership') || '{}');
  } catch(e) {
    return {};
  }
}

function setExternalListMembership(key, isMember) {
  try {
    const map = getExternalListMembership();
    if (isMember) {
      map[key] = true;
    } else {
      delete map[key];
      map[key] = false;
    }
    localStorage.setItem('myListAddon:externalMembership', JSON.stringify(map));
  } catch(e) {}
}

function makeExternalKey(provider, target, listId, id) {
  const cleanId = String(id || '').replace(/^tmdb:/, '').trim();
  return (provider || '') + ':' + (target || '') + ':' + (listId || '') + '::' + cleanId;
}

function isItemInExternalList(provider, target, listId, id, fallbackList) {
  const map = getExternalListMembership();
  const rawId = String(id || '').trim();
  const cleanId = rawId.replace(/^tmdb:/, '');
  const key1 = (provider || '') + ':' + (target || '') + ':' + (listId || '') + '::' + rawId;
  const key2 = (provider || '') + ':' + (target || '') + ':' + (listId || '') + '::' + cleanId;

  if (map[key1] === true || map[key2] === true) return true;
  if (map[key1] === false || map[key2] === false) return false;

  if (fallbackList && Array.isArray(fallbackList.items)) {
    return fallbackList.items.some(it => {
      if (!it) return false;
      const itId = String(it.id || '').trim();
      const itCleanId = itId.replace(/^tmdb:/, '');
      const itImdb = String(it.imdbId || '').trim();
      const itTmdb = String(it.tmdbId || '').trim();
      return itId === rawId || itCleanId === cleanId || itImdb === rawId || itImdb === cleanId || itTmdb === rawId || itTmdb === cleanId;
    });
  }
  return false;
}

async function removeSingleExternalItemDirect(provider, target, listId, id, type, btn) {
  if (!id) return;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Removing…';
  }

  const key1 = makeExternalKey(provider, target, listId, id);
  const key2 = makeExternalKey(provider, target, listId, String(id).replace(/^tmdb:/, ''));
  setExternalListMembership(key1, false);
  setExternalListMembership(key2, false);

  const row = btn ? btn.closest('.select-list-row') : null;
  if (row) {
    const cb = row.querySelector('.list-select-cb');
    if (cb) {
      cb.checked = false;
      cb.dataset.initiallyChecked = 'false';
    }
    const badge = row.querySelector('.in-list-badge');
    if (badge) badge.remove();
    btn.style.display = 'none';
  }

  const traktToken = (typeof traktAccessToken !== 'undefined' && traktAccessToken) || localStorage.getItem('myListAddon:traktAccessToken') || '';
  const traktKey = (document.getElementById('traktKeyInput')?.value.trim()) || localStorage.getItem('myListAddon:traktKey') || '';
  const traktUser = (typeof traktUsername !== 'undefined' && traktUsername) || localStorage.getItem('myListAddon:traktUsername') || '';
  const simklToken = (typeof simklAccessToken !== 'undefined' && simklAccessToken) || localStorage.getItem('myListAddon:simklAccessToken') || '';
  const simklKey = (document.getElementById('simklKeyInput')?.value.trim()) || localStorage.getItem('myListAddon:simklKey') || '';
  const tmdbSess = (typeof tmdbSessionId !== 'undefined' && tmdbSessionId) || localStorage.getItem('myListAddon:tmdbSessionId') || '';
  const tmdbAcc = (typeof tmdbAccountId !== 'undefined' && tmdbAccountId) || localStorage.getItem('myListAddon:tmdbAccountId') || '';
  const tmdbKey = (document.getElementById('tmdbKeyInput')?.value.trim()) || localStorage.getItem('myListAddon:tmdbKey') || '';
  const mdbToken = (typeof mdblistAccessToken !== 'undefined' && mdblistAccessToken) || localStorage.getItem('myListAddon:mdblistAccessToken') || '';
  const mdbKey = (document.getElementById('mdblistKeyInput')?.value.trim()) || localStorage.getItem('myListAddon:mdblistKey') || '';

  try {
    await fetch(ORIGIN + '/api/external-list/item-mutate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'remove',
        provider: provider,
        target: target,
        listId: listId,
        id: id,
        imdbId: String(id).startsWith('tt') ? id : '',
        tmdbId: String(id).startsWith('tmdb:') ? String(id).slice(5) : (String(id).startsWith('tt') ? '' : id),
        type: type || 'movie',
        traktAccessToken: traktToken,
        traktKey: traktKey,
        traktUsername: traktUser,
        simklAccessToken: simklToken,
        simklKey: simklKey,
        tmdbSessionId: tmdbSess,
        tmdbAccountId: tmdbAcc,
        tmdbKey: tmdbKey,
        mdblistAccessToken: mdbToken,
        mdblistKey: mdbKey
      })
    });
  } catch(e) {}

  showAddedToast('Removed from ' + (provider ? provider.toUpperCase() : 'List') + '.');
}

function removeSingleCustomItemDirect(listIdx, id, type, btn) {
  if (!window._selectListModalTempLists || !window._selectListModalTempLists[listIdx]) return;
  const list = window._selectListModalTempLists[listIdx];
  let cleanId = String(id || '').trim();
  while (cleanId.startsWith('tmdb:')) cleanId = cleanId.slice(5).trim();
  const finalImdbId = cleanId.startsWith('tt') ? cleanId : ('tmdb:' + cleanId);
  toggleItemInCustomListUrl(id, finalImdbId, type, listIdx, false);
  const row = btn ? btn.closest('.select-list-row') : null;
  if (row) {
    const cb = row.querySelector('.list-select-cb');
    if (cb) {
      cb.checked = false;
      cb.dataset.initiallyChecked = 'false';
    }
    const badge = row.querySelector('.in-list-badge');
    if (badge) badge.remove();
    btn.style.display = 'none';
  }
  showAddedToast('Removed from ' + (list.name || 'Custom List') + '.');
}

function openSelectListModal(id, type, title, poster) {
  const modal = document.getElementById('selectListModal');
  const body = document.getElementById('selectListModalBody');
  if (!modal || !body) return;
  
  // Ensure Watchlist exists locally
  if (typeof loadLocalCustomLists === 'function' && typeof backfillAutoTrackedListSlugs === 'function') {
    const m = loadLocalCustomLists();
    backfillAutoTrackedListSlugs(m);
  }

  // 1. Custom Lists (local & creator)
  const customLists = [];
  const localMap = (typeof loadLocalCustomLists === 'function') ? loadLocalCustomLists() : {};
  document.querySelectorAll('#lists .entry').forEach(row => {
    const urlInput = row.querySelector('.url');
    if (urlInput && urlInput.value.startsWith('customlist:v1:')) {
      try {
        const payload = JSON.parse(urlInput.value.slice('customlist:v1:'.length));
        if (!payload.localSlug && !payload.creatorSlug) return;
        if (payload.localSlug === 'airing-next' || payload.localSlug === 'watch-history' || payload.localSlug === 'continue-watching') return;
        if (payload.creatorSlug === 'airing-next' || payload.creatorSlug === 'watch-history' || payload.creatorSlug === 'continue-watching') return;
        if (payload.type && payload.type !== 'mixed' && payload.type !== type) return;
        const slug = payload.localSlug || payload.creatorSlug || payload.listSlug;
        const localList = slug ? localMap[slug] : null;
        const serverList = (slug && typeof lastCreatorListsData !== 'undefined' && Array.isArray(lastCreatorListsData)) ? lastCreatorListsData.find(l => l && l.slug === slug) : null;
        const liveItems = (serverList && Array.isArray(serverList.items)) ? serverList.items : ((localList && Array.isArray(localList.items)) ? localList.items : null);
        if (liveItems && liveItems.length >= (payload.items || []).length) {
          payload.items = liveItems.slice();
          urlInput.value = 'customlist:v1:' + JSON.stringify(payload);
        }
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
    Object.keys(localMap).forEach(slug => {
      if (slug === 'watch-history' || slug === 'continue-watching' || slug === 'airing-next') return;
      const l = localMap[slug];
      if (!l) return;
      if (l.type && l.type !== 'mixed' && l.type !== type) return;
      const existing = customLists.find(c => c.url && (c.url.includes(slug) || (c.name && c.name.toLowerCase() === (l.name || '').toLowerCase())));
      if (!existing) {
        customLists.push({
          name: l.name || 'Custom List',
          url: 'customlist:v1:' + JSON.stringify({ listId: generateChannelId(), localSlug: slug, type: l.type || 'mixed', items: l.items || [], shuffle: false }),
          row: null
        });
      }
    });
  } catch(e) {}

  if (typeof lastCreatorListsData !== 'undefined' && Array.isArray(lastCreatorListsData)) {
    lastCreatorListsData.forEach(l => {
      if (!l || !l.slug) return;
      if (l.slug === 'watch-history' || l.slug === 'continue-watching' || l.slug === 'airing-next') return;
      if (l.type && l.type !== 'mixed' && l.type !== type) return;
      const existing = customLists.find(c => c.url && (c.url.includes(l.slug) || (c.name && c.name.toLowerCase() === (l.name || '').toLowerCase())));
      if (!existing) {
        customLists.push({
          name: l.name || 'Custom List',
          url: 'customlist:v1:' + JSON.stringify({ listId: generateChannelId(), creatorSlug: l.slug, creatorOwner: (typeof activeCreator !== 'undefined' && activeCreator) ? activeCreator.creatorName : undefined, type: l.type || 'mixed', items: l.items || [], shuffle: false, visibility: l.visibility || 'private' }),
          row: null
        });
      }
    });
  }

  // 2. External Provider Lists
  const traktUser = (typeof traktUsername !== 'undefined' && traktUsername) || localStorage.getItem('myListAddon:traktUsername') || '';
  const traktToken = (typeof traktAccessToken !== 'undefined' && traktAccessToken) || localStorage.getItem('myListAddon:traktAccessToken') || '';
  const traktKey = (document.getElementById('traktKeyInput')?.value.trim()) || localStorage.getItem('myListAddon:traktKey') || '';
  const hasTrakt = !!traktToken;

  const simklUser = (typeof simklUsername !== 'undefined' && simklUsername) || localStorage.getItem('myListAddon:simklUsername') || '';
  const simklToken = (typeof simklAccessToken !== 'undefined' && simklAccessToken) || localStorage.getItem('myListAddon:simklAccessToken') || '';
  const simklKey = (document.getElementById('simklKeyInput')?.value.trim()) || localStorage.getItem('myListAddon:simklKey') || '';
  const hasSimkl = !!simklToken;

  const tmdbSess = (typeof tmdbSessionId !== 'undefined' && tmdbSessionId) || localStorage.getItem('myListAddon:tmdbSessionId') || '';
  const tmdbAcc = (typeof tmdbAccountId !== 'undefined' && tmdbAccountId) || localStorage.getItem('myListAddon:tmdbAccountId') || '';
  const tmdbUser = (typeof tmdbUsername !== 'undefined' && tmdbUsername) || localStorage.getItem('myListAddon:tmdbUsername') || '';
  const tmdbKey = (document.getElementById('tmdbKeyInput')?.value.trim()) || localStorage.getItem('myListAddon:tmdbKey') || '';
  const hasTmdb = !!(tmdbSess || tmdbAcc || tmdbKey);

  const mdbUser = (typeof mdblistUsername !== 'undefined' && mdblistUsername) || localStorage.getItem('myListAddon:mdblistUsername') || '';
  const mdbToken = (typeof mdblistAccessToken !== 'undefined' && mdblistAccessToken) || localStorage.getItem('myListAddon:mdblistAccessToken') || '';
  const mdbKey = (document.getElementById('mdblistKeyInput')?.value.trim()) || localStorage.getItem('myListAddon:mdblistKey') || '';
  const hasMdblist = !!(mdbToken || mdbKey);

  // Store globally so submitCreateListModal and addSelectedListsBtn can access it
  window._selectListModalTempLists = customLists;
  window._selectListModalCurrentItem = { id: id, type: type, title: title, poster: poster };

  let html = '';

  // SECTION: Custom Lists
  if (customLists.length > 0) {
    html += '<div style="font-size:0.8rem; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:0.5px; margin:4px 0 6px;">Custom Lists</div>';
    customLists.forEach((list, idx) => {
      let isChecked = false;
      try {
        const payloadStr = list.url.slice('customlist:v1:'.length);
        const payload = JSON.parse(payloadStr);
        isChecked = (payload.items || []).some(it => (it.imdbId === id) || (it.id === id) || (it.imdbId === 'tmdb:' + id) || (it.id === 'tmdb:' + id));
      } catch(e) {}
      
      html += 
        '<div class="select-list-row" style="display:flex; align-items:center; justify-content:space-between; padding:10px 0; border-bottom: 1px solid var(--border);">' +
          '<label style="display:flex; align-items:center; gap:10px; cursor:pointer; flex:1; color:var(--text); font-size:0.95rem;">' +
            '<input type="checkbox" class="list-select-cb" data-type="custom" data-idx="' + idx + '" data-initially-checked="' + (isChecked ? 'true' : 'false') + '" ' + (isChecked ? 'checked ' : '') + 'style="width:18px; height:18px; cursor:pointer; accent-color:var(--accent);">' +
            '<span style="font-weight:500;">' + escapeHtml(list.name) + '</span>' +
            (isChecked ? '<span class="in-list-badge" style="font-size:0.75rem; background:rgba(0,230,153,0.15); color:#00b377; padding:2px 6px; border-radius:4px; font-weight:600;">In List</span>' : '') +
          '</label>' +
          (isChecked ? '<button type="button" class="lc-btn secondary" style="padding:3px 8px; font-size:0.75rem; color:var(--danger); border-color:var(--danger); min-width:auto; height:26px; line-height:1;" onclick="removeSingleCustomItemDirect(' + idx + ', &quot;' + escapeJsAttr(id) + '&quot;, &quot;' + escapeJsAttr(type) + '&quot;, this)">Remove</button>' : '') +
        '</div>';
    });
  }

  // SECTION: Trakt
  if (hasTrakt) {
    html += '<div style="font-size:0.8rem; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:0.5px; margin:16px 0 6px; display:flex; align-items:center; gap:6px;">' +
      '<span style="color:#ed1c24; font-weight:bold;">\u25CF</span> Trakt ' + (traktUser ? '<small style="text-transform:none; font-weight:normal; opacity:0.8;">(@' + escapeHtml(traktUser) + ')</small>' : '') +
    '</div>';

    const traktWl = Array.isArray(window._myTraktLists) ? window._myTraktLists.find(l => l.slug === 'watchlist' || l.url === 'trakt:watchlist') : null;
    const inTraktWatchlist = isItemInExternalList('trakt', 'watchlist', 'watchlist', id, traktWl);
    html += 
      '<div class="select-list-row" style="display:flex; align-items:center; justify-content:space-between; padding:10px 0; border-bottom: 1px solid var(--border);">' +
        '<label style="display:flex; align-items:center; gap:10px; cursor:pointer; flex:1; color:var(--text); font-size:0.95rem;">' +
          '<input type="checkbox" class="list-select-cb" data-type="external" data-provider="trakt" data-target="watchlist" data-list-id="watchlist" data-name="Trakt Watchlist" data-initially-checked="' + (inTraktWatchlist ? 'true' : 'false') + '" ' + (inTraktWatchlist ? 'checked ' : '') + 'style="width:18px; height:18px; cursor:pointer; accent-color:var(--accent);">' +
          '<span>Trakt Watchlist</span>' +
          (inTraktWatchlist ? '<span class="in-list-badge" style="font-size:0.75rem; background:rgba(0,230,153,0.15); color:#00b377; padding:2px 6px; border-radius:4px; font-weight:600;">In List</span>' : '') +
        '</label>' +
        (inTraktWatchlist ? '<button type="button" class="lc-btn secondary" style="padding:3px 8px; font-size:0.75rem; color:var(--danger); border-color:var(--danger); min-width:auto; height:26px; line-height:1;" onclick="removeSingleExternalItemDirect(&quot;trakt&quot;, &quot;watchlist&quot;, &quot;watchlist&quot;, &quot;' + escapeJsAttr(id) + '&quot;, &quot;' + escapeJsAttr(type) + '&quot;, this)">Remove</button>' : '') +
      '</div>';

    if (Array.isArray(window._myTraktLists)) {
      window._myTraktLists.forEach(tl => {
        if (!tl || tl.slug === 'watchlist' || tl.url === 'trakt:watchlist') return;
        const inList = isItemInExternalList('trakt', 'custom', tl.id || tl.slug || '', id, tl);
        html += 
          '<div class="select-list-row" style="display:flex; align-items:center; justify-content:space-between; padding:10px 0; border-bottom: 1px solid var(--border);">' +
            '<label style="display:flex; align-items:center; gap:10px; cursor:pointer; flex:1; color:var(--text); font-size:0.95rem;">' +
              '<input type="checkbox" class="list-select-cb" data-type="external" data-provider="trakt" data-target="custom" data-list-id="' + escapeAttr(tl.id || tl.slug || '') + '" data-name="' + escapeAttr(tl.name) + '" data-initially-checked="' + (inList ? 'true' : 'false') + '" ' + (inList ? 'checked ' : '') + 'style="width:18px; height:18px; cursor:pointer; accent-color:var(--accent);">' +
              '<span>' + escapeHtml(tl.name || 'Trakt List') + '</span>' +
              (inList ? '<span class="in-list-badge" style="font-size:0.75rem; background:rgba(0,230,153,0.15); color:#00b377; padding:2px 6px; border-radius:4px; font-weight:600;">In List</span>' : '') +
            '</label>' +
            (inList ? '<button type="button" class="lc-btn secondary" style="padding:3px 8px; font-size:0.75rem; color:var(--danger); border-color:var(--danger); min-width:auto; height:26px; line-height:1;" onclick="removeSingleExternalItemDirect(&quot;trakt&quot;, &quot;custom&quot;, &quot;' + escapeJsAttr(tl.id || tl.slug || '') + '&quot;, &quot;' + escapeJsAttr(id) + '&quot;, &quot;' + escapeJsAttr(type) + '&quot;, this)">Remove</button>' : '') +
          '</div>';
      });
    }
  }

  // SECTION: Simkl
  if (hasSimkl) {
    html += '<div style="font-size:0.8rem; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:0.5px; margin:16px 0 6px; display:flex; align-items:center; gap:6px;">' +
      '<span style="color:#00e699; font-weight:bold;">\u25CF</span> Simkl ' + (simklUser ? '<small style="text-transform:none; font-weight:normal; opacity:0.8;">(@' + escapeHtml(simklUser) + ')</small>' : '') +
    '</div>';

    const simklStatuses = [
      { key: 'plantowatch', label: 'Plan to Watch' },
      { key: 'watching', label: 'Watching' },
      { key: 'completed', label: 'Completed' },
      { key: 'hold', label: 'On Hold' },
      { key: 'dropped', label: 'Dropped' }
    ];

    simklStatuses.forEach(st => {
      const foundList = Array.isArray(window._mySimklLists) ? window._mySimklLists.find(l => l.url && l.url.includes(st.key) && (type === 'series' ? l.type === 'series' : l.type === 'movie')) : null;
      const isPresent = isItemInExternalList('simkl', 'status', st.key, id, foundList);
      html += 
        '<div class="select-list-row" style="display:flex; align-items:center; justify-content:space-between; padding:10px 0; border-bottom: 1px solid var(--border);">' +
          '<label style="display:flex; align-items:center; gap:10px; cursor:pointer; flex:1; color:var(--text); font-size:0.95rem;">' +
            '<input type="checkbox" class="list-select-cb" data-type="external" data-provider="simkl" data-target="status" data-status="' + st.key + '" data-list-id="' + st.key + '" data-name="Simkl ' + escapeAttr(st.label) + '" data-initially-checked="' + (isPresent ? 'true' : 'false') + '" ' + (isPresent ? 'checked ' : '') + 'style="width:18px; height:18px; cursor:pointer; accent-color:var(--accent);">' +
            '<span>' + escapeHtml(st.label) + '</span>' +
            (isPresent ? '<span class="in-list-badge" style="font-size:0.75rem; background:rgba(0,230,153,0.15); color:#00b377; padding:2px 6px; border-radius:4px; font-weight:600;">In List</span>' : '') +
          '</label>' +
          (isPresent ? '<button type="button" class="lc-btn secondary" style="padding:3px 8px; font-size:0.75rem; color:var(--danger); border-color:var(--danger); min-width:auto; height:26px; line-height:1;" onclick="removeSingleExternalItemDirect(&quot;simkl&quot;, &quot;status&quot;, &quot;' + st.key + '&quot;, &quot;' + escapeJsAttr(id) + '&quot;, &quot;' + escapeJsAttr(type) + '&quot;, this)">Remove</button>' : '') +
        '</div>';
    });
  }

  // SECTION: TMDB
  if (hasTmdb) {
    html += '<div style="font-size:0.8rem; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:0.5px; margin:16px 0 6px; display:flex; align-items:center; gap:6px;">' +
      '<span style="color:#01b4e4; font-weight:bold;">\u25CF</span> TMDB ' + (tmdbUser ? '<small style="text-transform:none; font-weight:normal; opacity:0.8;">(@' + escapeHtml(tmdbUser) + ')</small>' : '') +
    '</div>';

    const tmdbWl = Array.isArray(window._myTmdbLists) ? window._myTmdbLists.find(l => l.url && l.url.includes('watchlist')) : null;
    const inTmdbWatchlist = isItemInExternalList('tmdb', 'watchlist', 'watchlist', id, tmdbWl);
    html += 
      '<div class="select-list-row" style="display:flex; align-items:center; justify-content:space-between; padding:10px 0; border-bottom: 1px solid var(--border);">' +
        '<label style="display:flex; align-items:center; gap:10px; cursor:pointer; flex:1; color:var(--text); font-size:0.95rem;">' +
          '<input type="checkbox" class="list-select-cb" data-type="external" data-provider="tmdb" data-target="watchlist" data-list-id="watchlist" data-name="TMDB Watchlist" data-initially-checked="' + (inTmdbWatchlist ? 'true' : 'false') + '" ' + (inTmdbWatchlist ? 'checked ' : '') + 'style="width:18px; height:18px; cursor:pointer; accent-color:var(--accent);">' +
          '<span>TMDB Watchlist</span>' +
          (inTmdbWatchlist ? '<span class="in-list-badge" style="font-size:0.75rem; background:rgba(0,230,153,0.15); color:#00b377; padding:2px 6px; border-radius:4px; font-weight:600;">In List</span>' : '') +
        '</label>' +
        (inTmdbWatchlist ? '<button type="button" class="lc-btn secondary" style="padding:3px 8px; font-size:0.75rem; color:var(--danger); border-color:var(--danger); min-width:auto; height:26px; line-height:1;" onclick="removeSingleExternalItemDirect(&quot;tmdb&quot;, &quot;watchlist&quot;, &quot;watchlist&quot;, &quot;' + escapeJsAttr(id) + '&quot;, &quot;' + escapeJsAttr(type) + '&quot;, this)">Remove</button>' : '') +
      '</div>';

    const tmdbFav = Array.isArray(window._myTmdbLists) ? window._myTmdbLists.find(l => l.url && l.url.includes('favorites')) : null;
    const inTmdbFav = isItemInExternalList('tmdb', 'favorite', 'favorite', id, tmdbFav);
    html += 
      '<div class="select-list-row" style="display:flex; align-items:center; justify-content:space-between; padding:10px 0; border-bottom: 1px solid var(--border);">' +
        '<label style="display:flex; align-items:center; gap:10px; cursor:pointer; flex:1; color:var(--text); font-size:0.95rem;">' +
          '<input type="checkbox" class="list-select-cb" data-type="external" data-provider="tmdb" data-target="favorite" data-list-id="favorite" data-name="TMDB Favorites" data-initially-checked="' + (inTmdbFav ? 'true' : 'false') + '" ' + (inTmdbFav ? 'checked ' : '') + 'style="width:18px; height:18px; cursor:pointer; accent-color:var(--accent);">' +
          '<span>TMDB Favorites</span>' +
          (inTmdbFav ? '<span class="in-list-badge" style="font-size:0.75rem; background:rgba(0,230,153,0.15); color:#00b377; padding:2px 6px; border-radius:4px; font-weight:600;">In List</span>' : '') +
        '</label>' +
        (inTmdbFav ? '<button type="button" class="lc-btn secondary" style="padding:3px 8px; font-size:0.75rem; color:var(--danger); border-color:var(--danger); min-width:auto; height:26px; line-height:1;" onclick="removeSingleExternalItemDirect(&quot;tmdb&quot;, &quot;favorite&quot;, &quot;favorite&quot;, &quot;' + escapeJsAttr(id) + '&quot;, &quot;' + escapeJsAttr(type) + '&quot;, this)">Remove</button>' : '') +
      '</div>';

    if (Array.isArray(window._myTmdbLists)) {
      window._myTmdbLists.forEach(tml => {
        if (!tml || (tml.url && (tml.url.includes('watchlist') || tml.url.includes('favorites')))) return;
        const inList = isItemInExternalList('tmdb', 'custom', tml.id || '', id, tml);
        html += 
          '<div class="select-list-row" style="display:flex; align-items:center; justify-content:space-between; padding:10px 0; border-bottom: 1px solid var(--border);">' +
            '<label style="display:flex; align-items:center; gap:10px; cursor:pointer; flex:1; color:var(--text); font-size:0.95rem;">' +
              '<input type="checkbox" class="list-select-cb" data-type="external" data-provider="tmdb" data-target="custom" data-list-id="' + escapeAttr(tml.id || '') + '" data-name="' + escapeAttr(tml.name) + '" data-initially-checked="' + (inList ? 'true' : 'false') + '" ' + (inList ? 'checked ' : '') + 'style="width:18px; height:18px; cursor:pointer; accent-color:var(--accent);">' +
              '<span>' + escapeHtml(tml.name || 'TMDB List') + '</span>' +
              (inList ? '<span class="in-list-badge" style="font-size:0.75rem; background:rgba(0,230,153,0.15); color:#00b377; padding:2px 6px; border-radius:4px; font-weight:600;">In List</span>' : '') +
            '</label>' +
            (inList ? '<button type="button" class="lc-btn secondary" style="padding:3px 8px; font-size:0.75rem; color:var(--danger); border-color:var(--danger); min-width:auto; height:26px; line-height:1;" onclick="removeSingleExternalItemDirect(&quot;tmdb&quot;, &quot;custom&quot;, &quot;' + escapeJsAttr(tml.id || '') + '&quot;, &quot;' + escapeJsAttr(id) + '&quot;, &quot;' + escapeJsAttr(type) + '&quot;, this)">Remove</button>' : '') +
          '</div>';
      });
    }
  }

  // SECTION: MDBList
  if (hasMdblist) {
    html += '<div style="font-size:0.8rem; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:0.5px; margin:16px 0 6px; display:flex; align-items:center; gap:6px;">' +
      '<span style="color:#f5c518; font-weight:bold;">\u25CF</span> MDBList ' + (mdbUser ? '<small style="text-transform:none; font-weight:normal; opacity:0.8;">(@' + escapeHtml(mdbUser) + ')</small>' : '') +
    '</div>';

    const mdbWl = Array.isArray(window._myMdblistLists) ? window._myMdblistLists.find(l => l.slug === 'watchlist' || l.url === 'mdblist:watchlist') : null;
    const inMdbWatchlist = isItemInExternalList('mdblist', 'watchlist', 'watchlist', id, mdbWl);
    html += 
      '<div class="select-list-row" style="display:flex; align-items:center; justify-content:space-between; padding:10px 0; border-bottom: 1px solid var(--border);">' +
        '<label style="display:flex; align-items:center; gap:10px; cursor:pointer; flex:1; color:var(--text); font-size:0.95rem;">' +
          '<input type="checkbox" class="list-select-cb" data-type="external" data-provider="mdblist" data-target="watchlist" data-list-id="watchlist" data-name="MDBList Watchlist" data-initially-checked="' + (inMdbWatchlist ? 'true' : 'false') + '" ' + (inMdbWatchlist ? 'checked ' : '') + 'style="width:18px; height:18px; cursor:pointer; accent-color:var(--accent);">' +
          '<span>MDBList Watchlist</span>' +
          (inMdbWatchlist ? '<span class="in-list-badge" style="font-size:0.75rem; background:rgba(0,230,153,0.15); color:#00b377; padding:2px 6px; border-radius:4px; font-weight:600;">In List</span>' : '') +
        '</label>' +
        (inMdbWatchlist ? '<button type="button" class="lc-btn secondary" style="padding:3px 8px; font-size:0.75rem; color:var(--danger); border-color:var(--danger); min-width:auto; height:26px; line-height:1;" onclick="removeSingleExternalItemDirect(&quot;mdblist&quot;, &quot;watchlist&quot;, &quot;watchlist&quot;, &quot;' + escapeJsAttr(id) + '&quot;, &quot;' + escapeJsAttr(type) + '&quot;, this)">Remove</button>' : '') +
      '</div>';

    if (Array.isArray(window._myMdblistLists)) {
      window._myMdblistLists.forEach(ml => {
        if (!ml || ml.slug === 'watchlist' || ml.slug === 'history' || ml.url === 'mdblist:watchlist' || ml.url === 'mdblist:history') return;
        const inList = isItemInExternalList('mdblist', 'custom', ml.id || ml.slug || '', id, ml);
        html += 
          '<div class="select-list-row" style="display:flex; align-items:center; justify-content:space-between; padding:10px 0; border-bottom: 1px solid var(--border);">' +
            '<label style="display:flex; align-items:center; gap:10px; cursor:pointer; flex:1; color:var(--text); font-size:0.95rem;">' +
              '<input type="checkbox" class="list-select-cb" data-type="external" data-provider="mdblist" data-target="custom" data-list-id="' + escapeAttr(ml.id || ml.slug || '') + '" data-name="' + escapeAttr(ml.name) + '" data-initially-checked="' + (inList ? 'true' : 'false') + '" ' + (inList ? 'checked ' : '') + 'style="width:18px; height:18px; cursor:pointer; accent-color:var(--accent);">' +
              '<span>' + escapeHtml(ml.name || 'MDBList List') + '</span>' +
              (inList ? '<span class="in-list-badge" style="font-size:0.75rem; background:rgba(0,230,153,0.15); color:#00b377; padding:2px 6px; border-radius:4px; font-weight:600;">In List</span>' : '') +
            '</label>' +
            (inList ? '<button type="button" class="lc-btn secondary" style="padding:3px 8px; font-size:0.75rem; color:var(--danger); border-color:var(--danger); min-width:auto; height:26px; line-height:1;" onclick="removeSingleExternalItemDirect(&quot;mdblist&quot;, &quot;custom&quot;, &quot;' + escapeJsAttr(ml.id || ml.slug || '') + '&quot;, &quot;' + escapeJsAttr(id) + '&quot;, &quot;' + escapeJsAttr(type) + '&quot;, this)">Remove</button>' : '') +
          '</div>';
      });
    }
  }

  if (html) {
    html += '<div style="margin-top: 16px; padding-top: 12px; border-top: 1px dashed var(--border); text-align: center;">' +
      '<button type="button" class="lc-btn secondary" style="width:100%; font-size:0.9rem;" onclick="document.getElementById(&quot;selectListModal&quot;).style.display=&quot;none&quot;; openCreateListModal();">+ Create New List</button>' +
    '</div>';
  }

  if (html === '') {
    html = '<p style="text-align:center; padding:20px; color:var(--muted); font-size:0.95rem;">You do not have any Custom Lists or connected external accounts yet.<br><br>' +
      '<a href="#" id="emptyCreateListLink" style="color:var(--accent); font-weight:600;">Create a Custom List</a> or connect Trakt/Simkl/TMDB/MDBList in <strong>Settings</strong>.</p>';
    document.getElementById('addSelectedListsBtn').style.display = 'none';
    setTimeout(() => {
      const lnk = document.getElementById('emptyCreateListLink');
      if (lnk) {
        lnk.onclick = function(e) {
          e.preventDefault();
          document.getElementById('selectListModal').style.display = 'none';
          document.body.style.overflow = '';
          if (typeof openCreateListModal === 'function') openCreateListModal();
        };
      }
    }, 0);
  } else {
    document.getElementById('addSelectedListsBtn').style.display = 'block';
  }
  
  body.innerHTML = html;
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  // Background check for Simkl lists membership if not cached yet
  if (hasSimkl && !window._mySimklLists) {
    fetch(ORIGIN + '/api/simkl/my-lists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: simklToken, simklKey: simklKey }),
    }).then(r => r.json()).then(data => {
      if (data && data.ok && Array.isArray(data.lists)) {
        window._mySimklLists = data.lists;
        window._simklListsMap = window._simklListsMap || {};
        data.lists.forEach(l => { if (l && l.url) window._simklListsMap[l.url] = l; });
        document.querySelectorAll('.list-select-cb[data-provider="simkl"]').forEach(cb => {
          const st = cb.dataset.status;
          const found = data.lists.find(l => l.url && l.url.includes(st) && (type === 'series' ? l.type === 'series' : l.type === 'movie'));
          if (found && Array.isArray(found.items)) {
            const isPres = isItemInExternalList('simkl', 'status', st, id, found);
            if (isPres) {
              cb.checked = true;
              cb.dataset.initiallyChecked = 'true';
              const row = cb.closest('.select-list-row');
              if (row && !row.querySelector('.in-list-badge')) {
                const label = row.querySelector('label');
                if (label) label.insertAdjacentHTML('beforeend', '<span class="in-list-badge" style="font-size:0.75rem; background:rgba(0,230,153,0.15); color:#00b377; padding:2px 6px; border-radius:4px; font-weight:600;">In List</span>');
                if (!row.querySelector('button')) {
                  row.insertAdjacentHTML('beforeend', '<button type="button" class="lc-btn secondary" style="padding:3px 8px; font-size:0.75rem; color:var(--danger); border-color:var(--danger); min-width:auto; height:26px; line-height:1;" onclick="removeSingleExternalItemDirect(&quot;simkl&quot;, &quot;status&quot;, &quot;' + st + '&quot;, &quot;' + escapeJsAttr(id) + '&quot;, &quot;' + escapeJsAttr(type) + '&quot;, this)">Remove</button>');
                }
              }
            }
          }
        });
      }
    }).catch(() => {});
  }

  // Background check for Trakt lists membership if not cached yet
  if (hasTrakt && traktUser && !window._myTraktLists) {
    const params = 'username=' + encodeURIComponent(traktUser) + (traktKey ? '&traktKey=' + encodeURIComponent(traktKey) : '');
    fetch(ORIGIN + '/api/trakt-my-lists?' + params, { cache: 'no-store' }).then(r => r.json()).then(data => {
      if (data && data.ok && Array.isArray(data.lists)) {
        window._myTraktLists = data.lists;
        document.querySelectorAll('.list-select-cb[data-provider="trakt"]').forEach(cb => {
          const target = cb.dataset.target;
          const listId = cb.dataset.listId;
          const found = data.lists.find(l => (target === 'watchlist' && (l.slug === 'watchlist' || l.url === 'trakt:watchlist')) || (target === 'custom' && (l.id === listId || l.slug === listId)));
          if (found && Array.isArray(found.items)) {
            const isPres = isItemInExternalList('trakt', target, listId, id, found);
            if (isPres) {
              cb.checked = true;
              cb.dataset.initiallyChecked = 'true';
              const row = cb.closest('.select-list-row');
              if (row && !row.querySelector('.in-list-badge')) {
                const label = row.querySelector('label');
                if (label) label.insertAdjacentHTML('beforeend', '<span class="in-list-badge" style="font-size:0.75rem; background:rgba(0,230,153,0.15); color:#00b377; padding:2px 6px; border-radius:4px; font-weight:600;">In List</span>');
                if (!row.querySelector('button')) {
                  row.insertAdjacentHTML('beforeend', '<button type="button" class="lc-btn secondary" style="padding:3px 8px; font-size:0.75rem; color:var(--danger); border-color:var(--danger); min-width:auto; height:26px; line-height:1;" onclick="removeSingleExternalItemDirect(&quot;trakt&quot;, &quot;' + target + '&quot;, &quot;' + escapeJsAttr(listId) + '&quot;, &quot;' + escapeJsAttr(id) + '&quot;, &quot;' + escapeJsAttr(type) + '&quot;, this)">Remove</button>');
                }
              }
            }
          }
        });
      }
    }).catch(() => {});
  }

  // Background check for TMDB lists membership if not cached yet
  if (hasTmdb && !window._myTmdbLists) {
    const params = new URLSearchParams();
    if (tmdbSess) params.set('sessionId', tmdbSess);
    if (tmdbAcc) params.set('accountId', tmdbAcc);
    if (tmdbKey) params.set('tmdbKey', tmdbKey);
    fetch(ORIGIN + '/api/tmdb-my-lists?' + params.toString(), { cache: 'no-store' }).then(r => r.json()).then(data => {
      if (data && data.ok && Array.isArray(data.lists)) {
        window._myTmdbLists = data.lists;
        document.querySelectorAll('.list-select-cb[data-provider="tmdb"]').forEach(cb => {
          const target = cb.dataset.target;
          const listId = cb.dataset.listId;
          const found = data.lists.find(l => (target === 'watchlist' && l.url && l.url.includes('watchlist')) || (target === 'favorite' && l.url && l.url.includes('favorites')) || (target === 'custom' && String(l.id) === String(listId)));
          if (found && Array.isArray(found.items)) {
            const isPres = isItemInExternalList('tmdb', target, listId, id, found);
            if (isPres) {
              cb.checked = true;
              cb.dataset.initiallyChecked = 'true';
              const row = cb.closest('.select-list-row');
              if (row && !row.querySelector('.in-list-badge')) {
                const label = row.querySelector('label');
                if (label) label.insertAdjacentHTML('beforeend', '<span class="in-list-badge" style="font-size:0.75rem; background:rgba(0,230,153,0.15); color:#00b377; padding:2px 6px; border-radius:4px; font-weight:600;">In List</span>');
                if (!row.querySelector('button')) {
                  row.insertAdjacentHTML('beforeend', '<button type="button" class="lc-btn secondary" style="padding:3px 8px; font-size:0.75rem; color:var(--danger); border-color:var(--danger); min-width:auto; height:26px; line-height:1;" onclick="removeSingleExternalItemDirect(&quot;tmdb&quot;, &quot;' + target + '&quot;, &quot;' + escapeJsAttr(listId) + '&quot;, &quot;' + escapeJsAttr(id) + '&quot;, &quot;' + escapeJsAttr(type) + '&quot;, this)">Remove</button>');
                }
              }
            }
          }
        });
      }
    }).catch(() => {});
  }

  // Background check for MDBList lists membership if not cached yet
  if (hasMdblist && !window._myMdblistLists) {
    const keyParam = mdbToken || mdbKey;
    fetch(ORIGIN + '/api/mdblist-my-lists?key=' + encodeURIComponent(keyParam) + (mdbUser ? '&user=' + encodeURIComponent(mdbUser) : ''), { cache: 'no-store' }).then(r => r.json()).then(data => {
      if (data && data.ok && Array.isArray(data.lists)) {
        window._myMdblistLists = data.lists;
        document.querySelectorAll('.list-select-cb[data-provider="mdblist"]').forEach(cb => {
          const target = cb.dataset.target;
          const listId = cb.dataset.listId;
          const found = data.lists.find(l => (target === 'watchlist' && (l.slug === 'watchlist' || l.url === 'mdblist:watchlist')) || (target === 'custom' && (l.id === listId || l.slug === listId)));
          if (found && Array.isArray(found.items)) {
            const isPres = isItemInExternalList('mdblist', target, listId, id, found);
            if (isPres) {
              cb.checked = true;
              cb.dataset.initiallyChecked = 'true';
              const row = cb.closest('.select-list-row');
              if (row && !row.querySelector('.in-list-badge')) {
                const label = row.querySelector('label');
                if (label) label.insertAdjacentHTML('beforeend', '<span class="in-list-badge" style="font-size:0.75rem; background:rgba(0,230,153,0.15); color:#00b377; padding:2px 6px; border-radius:4px; font-weight:600;">In List</span>');
                if (!row.querySelector('button')) {
                  row.insertAdjacentHTML('beforeend', '<button type="button" class="lc-btn secondary" style="padding:3px 8px; font-size:0.75rem; color:var(--danger); border-color:var(--danger); min-width:auto; height:26px; line-height:1;" onclick="removeSingleExternalItemDirect(&quot;mdblist&quot;, &quot;' + target + '&quot;, &quot;' + escapeJsAttr(listId) + '&quot;, &quot;' + escapeJsAttr(id) + '&quot;, &quot;' + escapeJsAttr(type) + '&quot;, this)">Remove</button>');
                }
              }
            }
          }
        });
      }
    }).catch(() => {});
  }
}

document.getElementById('selectListModal').addEventListener('click', (e) => {
  if (e.target.id === 'selectListModal' || e.target.id === 'selectListModalCloseBtn') {
    document.getElementById('selectListModal').style.display = 'none';
    document.body.style.overflow = '';
  }
});

document.getElementById('addSelectedListsBtn').addEventListener('click', async () => {
  if (!window._selectListModalCurrentItem) return;
  const { id, type, title, poster } = window._selectListModalCurrentItem;
  
  const btn = document.getElementById('addSelectedListsBtn');
  btn.disabled = true;
  btn.textContent = 'Saving\u2026';
  
  let cleanId = String(id || '').trim();
  while (cleanId.startsWith('tmdb:')) cleanId = cleanId.slice(5).trim();
  let finalImdbId = cleanId;
  let cleanTmdbId = '';
  if (!String(finalImdbId).startsWith('tt')) {
    cleanTmdbId = cleanId;
    const endpoint = (type === 'series' || type === 'tv') ? '/api/resolve-show?tmdbId=' : '/api/resolve-movie?tmdbId=';
    try {
      const res = await fetch(ORIGIN + endpoint + encodeURIComponent(cleanId));
      const data = await res.json();
      if (data.ok && data.imdbId) finalImdbId = data.imdbId;
      else finalImdbId = 'tmdb:' + cleanId;
    } catch(e) {
      finalImdbId = 'tmdb:' + cleanId;
    }
  }

  const checkboxes = document.querySelectorAll('.list-select-cb');
  let anyAdded = false;
  let anyRemoved = false;
  const changedExternalOperations = [];
  
  checkboxes.forEach(cb => {
    const cbType = cb.dataset.type;
    const isChecked = cb.checked;
    const initiallyChecked = cb.dataset.initiallyChecked === 'true';

    if (cbType === 'custom') {
      const listIdx = parseInt(cb.dataset.idx, 10);
      const changed = toggleItemInCustomListUrl(id, finalImdbId, type, listIdx, isChecked, title, poster);
      if (changed) {
        if (isChecked) anyAdded = true;
        else anyRemoved = true;
      }
    } else if (cbType === 'external') {
      if (isChecked !== initiallyChecked) {
        const op = {
          action: isChecked ? 'add' : 'remove',
          provider: cb.dataset.provider,
          target: cb.dataset.target,
          listId: cb.dataset.listId || cb.dataset.status || '',
          status: cb.dataset.status || '',
          name: cb.dataset.name || 'List'
        };
        changedExternalOperations.push(op);
        
        // Update local membership map immediately
        setExternalListMembership(makeExternalKey(op.provider, op.target, op.listId, id), isChecked);
        if (finalImdbId) setExternalListMembership(makeExternalKey(op.provider, op.target, op.listId, finalImdbId), isChecked);
        if (cleanTmdbId) setExternalListMembership(makeExternalKey(op.provider, op.target, op.listId, cleanTmdbId), isChecked);

        if (isChecked) anyAdded = true;
        else anyRemoved = true;
      }
    }
  });

  // Execute external modifications concurrently
  if (changedExternalOperations.length > 0) {
    const traktToken = (typeof traktAccessToken !== 'undefined' && traktAccessToken) || localStorage.getItem('myListAddon:traktAccessToken') || '';
    const traktKey = (document.getElementById('traktKeyInput')?.value.trim()) || localStorage.getItem('myListAddon:traktKey') || '';
    const traktUser = (typeof traktUsername !== 'undefined' && traktUsername) || localStorage.getItem('myListAddon:traktUsername') || '';

    const simklToken = (typeof simklAccessToken !== 'undefined' && simklAccessToken) || localStorage.getItem('myListAddon:simklAccessToken') || '';
    const simklKey = (document.getElementById('simklKeyInput')?.value.trim()) || localStorage.getItem('myListAddon:simklKey') || '';

    const tmdbSess = (typeof tmdbSessionId !== 'undefined' && tmdbSessionId) || localStorage.getItem('myListAddon:tmdbSessionId') || '';
    const tmdbAcc = (typeof tmdbAccountId !== 'undefined' && tmdbAccountId) || localStorage.getItem('myListAddon:tmdbAccountId') || '';
    const tmdbKey = (document.getElementById('tmdbKeyInput')?.value.trim()) || localStorage.getItem('myListAddon:tmdbKey') || '';

    const mdbToken = (typeof mdblistAccessToken !== 'undefined' && mdblistAccessToken) || localStorage.getItem('myListAddon:mdblistAccessToken') || '';
    const mdbKey = (document.getElementById('mdblistKeyInput')?.value.trim()) || localStorage.getItem('myListAddon:mdblistKey') || '';

    await Promise.allSettled(changedExternalOperations.map(op => {
      return fetch(ORIGIN + '/api/external-list/item-mutate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: op.action,
          provider: op.provider,
          target: op.target,
          listId: op.listId,
          status: op.status,
          id: id,
          imdbId: finalImdbId,
          tmdbId: cleanTmdbId,
          type: type,
          title: title,
          poster: poster,
          traktAccessToken: traktToken,
          traktKey: traktKey,
          traktUsername: traktUser,
          simklAccessToken: simklToken,
          simklKey: simklKey,
          tmdbSessionId: tmdbSess,
          tmdbAccountId: tmdbAcc,
          tmdbKey: tmdbKey,
          mdblistAccessToken: mdbToken,
          mdblistKey: mdbKey
        })
      });
    }));
  }
  
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
    let payload = null;
    if (list.row) {
      const urlInput = list.row.querySelector('.url');
      if (urlInput && urlInput.value.startsWith('customlist:v1:')) {
        payload = JSON.parse(urlInput.value.slice('customlist:v1:'.length));
      }
    }
    if (!payload && list.url && list.url.startsWith('customlist:v1:')) {
      payload = JSON.parse(list.url.slice('customlist:v1:'.length));
    }
    if (!payload) return false;
    if (!Array.isArray(payload.items)) payload.items = [];

    const targetSlug = payload.localSlug || payload.creatorSlug || payload.listSlug || '';
    if (targetSlug) {
      const localMap = (typeof loadLocalCustomLists === 'function') ? loadLocalCustomLists() : {};
      const localList = localMap[targetSlug];
      const serverList = (typeof lastCreatorListsData !== 'undefined' && Array.isArray(lastCreatorListsData)) ? lastCreatorListsData.find(l => l && l.slug === targetSlug) : null;
      const liveItems = (serverList && Array.isArray(serverList.items)) ? serverList.items : ((localList && Array.isArray(localList.items)) ? localList.items : null);
      if (liveItems && liveItems.length >= payload.items.length) {
        payload.items = liveItems.slice();
      }
    }
    
    // Check for existing items using imdbId or originalId
    const idx = payload.items.findIndex(it => (it.imdbId === imdbId) || (it.id === originalId) || (it.imdbId === 'tmdb:' + originalId) || (it.id === imdbId));
    const exists = idx !== -1;
    
    let changed = false;
    if (shouldBeInList && !exists) {
      payload.items.push({ imdbId: imdbId || originalId, id: originalId || imdbId, type: type || 'movie', title: title || '', poster: poster || undefined });
      changed = true;
    } else if (!shouldBeInList && exists) {
      payload.items.splice(idx, 1);
      changed = true;
    }
    
    if (changed) {
      const newUrl = 'customlist:v1:' + JSON.stringify(payload);
      list.url = newUrl;
      if (list.row) {
        const urlInput = list.row.querySelector('.url');
        if (urlInput) {
          urlInput.value = newUrl;
          if (typeof autoSaveDebounced === 'function') autoSaveDebounced();
        }
      }
      
      const nameInput = list.row ? list.row.querySelector('.name') : null;
      const rowName = (nameInput ? nameInput.value : '') || list.name || '';
      syncCustomListPayload(payload, rowName);
    }
    return changed;
    
  } catch (err) {
    console.error('Error updating custom list item', err);
    return false;
  }
}

async function syncCustomListPayload(payload, name) {
  const isWatchlist = payload.localSlug === 'watchlist' || payload.creatorSlug === 'watchlist' || (name && name.toLowerCase() === 'watchlist');
  if (isWatchlist) {
    if (typeof loadLocalCustomLists === 'function' && typeof saveLocalCustomListsMap === 'function') {
      const map = loadLocalCustomLists();
      if (map['watchlist']) {
        map['watchlist'].items = payload.items;
        map['watchlist'].updatedAt = Date.now();
        saveLocalCustomListsMap(map);
      } else {
        map['watchlist'] = {
          slug: 'watchlist',
          name: 'Watchlist',
          type: payload.type || 'mixed',
          isWatchlist: true,
          items: payload.items,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        saveLocalCustomListsMap(map);
      }
    }
    if (typeof pushTrackingSync === 'function') pushTrackingSync();
    if (typeof scheduleCreatorSyncSave === 'function') scheduleCreatorSyncSave();
    if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard({ silent: true });
  }

  if (payload.creatorSlug && !isWatchlist) {
    const creatorKey = localStorage.getItem('myListAddon:creatorKey');
    const creatorName = localStorage.getItem('myListAddon:creatorName');
    if (creatorKey && creatorName && name) {
      try {
        const creatorListMeta = (typeof lastCreatorListsData !== 'undefined' && Array.isArray(lastCreatorListsData))
          ? lastCreatorListsData.find((l) => l.slug === payload.creatorSlug)
          : null;
        const finalType = (creatorListMeta && creatorListMeta.type) ? creatorListMeta.type : (payload.type || 'movie');
        let combinedItems = payload.items;
        if (finalType === 'mixed' && creatorListMeta && Array.isArray(creatorListMeta.items)) {
          const currentIds = new Set((payload.items || []).map(it => it.imdbId || it.id));
          const otherItems = creatorListMeta.items.filter(it => !currentIds.has(it.imdbId || it.id));
          combinedItems = (payload.items || []).concat(otherItems);
        }
        const res = await fetch(ORIGIN + '/api/creator/lists/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            creatorName: creatorName,
            creatorKey: creatorKey,
            slug: payload.creatorSlug,
            name: name.replace(/\s*\((?:Movies|Shows)\)$/i, ''),
            type: finalType,
            items: combinedItems,
            visibility: payload.visibility || (creatorListMeta ? creatorListMeta.visibility : 'private')
          })
        });
        const data = await res.json();
        if (data.ok) {
          if (creatorListMeta) {
            creatorListMeta.items = combinedItems;
            creatorListMeta.itemCount = combinedItems.length;
          }
          if (typeof renderCreatorDashboard === 'function') {
            renderCreatorDashboard({ silent: true });
          }
        }
        payload.items = combinedItems;
        payload.type = finalType;
      } catch(e) {}
    }
  }
  if (payload.localSlug && !isWatchlist) {
    if (typeof loadLocalCustomLists === 'function' && typeof saveLocalCustomListsMap === 'function') {
      const map = loadLocalCustomLists();
      const existing = map[payload.localSlug];
      const finalType = (existing && existing.type) ? existing.type : (payload.type || 'movie');
      let combinedItems = payload.items;
      if (finalType === 'mixed' && existing && Array.isArray(existing.items)) {
        const currentIds = new Set((payload.items || []).map(it => it.imdbId || it.id));
        const otherItems = existing.items.filter(it => !currentIds.has(it.imdbId || it.id));
        combinedItems = (payload.items || []).concat(otherItems);
      }
      if (existing) {
        existing.items = combinedItems;
        existing.type = finalType;
        existing.updatedAt = Date.now();
        saveLocalCustomListsMap(map);
      } else {
        map[payload.localSlug] = {
          slug: payload.localSlug,
          name: (name || payload.localSlug).replace(/\s*\((?:Movies|Shows)\)$/i, ''),
          type: finalType,
          isWatchlist: payload.localSlug === 'watchlist',
          items: combinedItems,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        saveLocalCustomListsMap(map);
      }
      if (typeof scheduleCreatorSyncSave === 'function') scheduleCreatorSyncSave();
      if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard({ silent: true });
      payload.items = combinedItems;
      payload.type = finalType;
    }
  }

  const slug = payload.localSlug || payload.creatorSlug || payload.listSlug || payload.slug;
  if (slug && typeof syncCustomListToCatalogRows === 'function') {
    syncCustomListToCatalogRows(slug, payload.items, name, payload.type);
  }
}


let currentCatalogSearchType = 'movie';
let catalogSearchDebounceTimer = null;
window._rawCatalogTitleItems = [];

function handleCatalogSearchInput(input) {
  const q = (input ? input.value : '').trim();
  if (!q) {
    if (catalogSearchDebounceTimer) clearTimeout(catalogSearchDebounceTimer);
    renderDefaultCatalogSearch();
    return;
  }
  if (catalogSearchDebounceTimer) clearTimeout(catalogSearchDebounceTimer);
  catalogSearchDebounceTimer = setTimeout(() => {
    runCatalogSearch();
  }, 350);
}

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
  const filtersRow = document.getElementById('catalogSearchFiltersRow');
  if (filtersRow) {
    filtersRow.style.display = (filter === 'lists') ? 'none' : 'flex';
  }
  const q = (document.getElementById('catalogSearchInput')?.value || '').trim();
  if (q) {
    runCatalogSearch();
  } else {
    renderDefaultCatalogSearch();
  }
}

function resetSearchFilters() {
  const gEl = document.getElementById('catalogSearchGenreSelect');
  const yEl = document.getElementById('catalogSearchYearSelect');
  const rEl = document.getElementById('catalogSearchRatingSelect');
  if (gEl) gEl.value = '';
  if (yEl) yEl.value = '';
  if (rEl) rEl.value = '';
  applySearchFilters();
}

function applySearchFilters() {
  if (currentCatalogSearchType === 'lists') return;
  const resEl = document.getElementById('catalogSearchResult');
  if (!resEl) return;

  const gVal = (document.getElementById('catalogSearchGenreSelect')?.value || '').trim();
  const yVal = (document.getElementById('catalogSearchYearSelect')?.value || '').trim();
  const rVal = (document.getElementById('catalogSearchRatingSelect')?.value || '').trim();

  const resetBtn = document.getElementById('catalogSearchResetFiltersBtn');
  if (resetBtn) {
    resetBtn.style.display = (gVal || yVal || rVal) ? 'inline-block' : 'none';
  }

  const rawItems = Array.isArray(window._rawCatalogTitleItems) ? window._rawCatalogTitleItems : [];
  if (!rawItems.length) return;

  const genreFilterIds = gVal ? gVal.split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean) : [];
  const minRating = rVal ? parseFloat(rVal) : 0;

  const filtered = rawItems.filter(m => {
    // 1. Genre filter
    if (genreFilterIds.length > 0) {
      const itemGenres = Array.isArray(m.genreIds) ? m.genreIds : [];
      const hasMatch = itemGenres.some(id => genreFilterIds.includes(id));
      if (!hasMatch) return false;
    }

    // 2. Year filter
    if (yVal) {
      const yr = parseInt(m.year, 10);
      if (yVal === '<1990') {
        if (!yr || yr >= 1990) return false;
      } else if (yVal.includes('-')) {
        const parts = yVal.split('-').map(s => parseInt(s, 10));
        if (parts.length === 2 && (yr < parts[0] || yr > parts[1])) return false;
      } else {
        if (String(m.year) !== yVal) return false;
      }
    }

    // 3. Rating filter
    if (minRating > 0) {
      if (typeof m.rating !== 'number' || m.rating < minRating) return false;
    }

    return true;
  });

  renderTitlePosterCards(filtered, rawItems.length, resEl);
}

function renderTitlePosterCards(items, totalCount, resEl) {
  if (!items || !items.length) {
    resEl.innerHTML = '<p style="margin:16px 0; color:var(--muted); font-size:0.9rem;"><small>No titles match the selected filters.</small></p>';
    return;
  }

  const countBadge = (typeof totalCount === 'number' && totalCount > items.length)
    ? '<div style="margin-bottom:10px; font-size:0.82rem; color:var(--muted);">Showing ' + items.length + ' of ' + totalCount + ' results</div>'
    : ((typeof totalCount === 'number' && totalCount > 20) ? '<div style="margin-bottom:10px; font-size:0.82rem; color:var(--muted);">' + items.length + ' results found</div>' : '');

  const postersHtml = items.map(m => {
    const posterClass = 'live-preview-poster';
    const posterEl = m.poster
      ? '<img class="' + posterClass + '" src="' + escapeAttr(m.poster) + '" alt="" loading="lazy" onerror="handlePosterImgError(this)">'
      : '<div class="' + posterClass + ' live-preview-poster-placeholder" data-needs-fallback="1"><small style="color:var(--muted); font-size:0.7rem;">No poster</small></div>';
    
    const title = m.title || '';
    const type = currentCatalogSearchType === 'tv' ? 'series' : 'movie';
    const id = 'tmdb:' + m.tmdbId;
    const ratingHtml = (typeof m.rating === 'number' && m.rating > 0)
      ? '<span style="color:#f5c518; font-weight:700; font-size:0.75rem; margin-left:auto;">&#9733; ' + m.rating.toFixed(1) + '</span>'
      : '';
    
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
      '<div class="live-preview-poster-year" style="display:flex; align-items:center; justify-content:space-between; gap:4px;">' +
        '<span>' + escapeHtml(m.year || '') + '</span>' +
        ratingHtml +
      '</div>' +
      '</div>';
  }).join('');
  
  resEl.innerHTML = countBadge + '<div class="poster-grid-3">' + postersHtml + '</div>';
  if (typeof resolveMissingPostersInDom === 'function') {
    resolveMissingPostersInDom(resEl);
  }
}

async function renderDefaultCatalogSearch() {
  const resEl = document.getElementById('catalogSearchResult');
  if (!resEl) return;
  const inputEl = document.getElementById('catalogSearchInput');
  if (inputEl && inputEl.value.trim()) return;

  resEl.innerHTML = '<p><small>Loading top ' + (currentCatalogSearchType === 'lists' ? 'public lists' : (currentCatalogSearchType === 'tv' ? 'shows' : 'movies')) + '...</small></p>';

  if (currentCatalogSearchType === 'lists') {
    window._rawCatalogTitleItems = [];
    try {
      const pubRes = await fetch(ORIGIN + '/api/search-published-lists?q=', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ ok: false, lists: [] }));
      if (inputEl && inputEl.value.trim()) return;
      const pubLists = pubRes && pubRes.ok && Array.isArray(pubRes.lists) ? pubRes.lists : [];
      if (!pubLists.length) {
        resEl.innerHTML = '<p><small>No published My Lists Addon lists available yet.</small></p>';
        return;
      }
      renderListSearchResults([], [], null, pubLists, [], resEl);
    } catch (e) {
      resEl.innerHTML = '<p class="testresult err">✗ Could not load public lists.</p>';
    }
    return;
  }

  try {
    const res = await fetch(ORIGIN + '/api/title-search?type=' + currentCatalogSearchType);
    const data = await res.json();
    if (inputEl && inputEl.value.trim()) return;
    if (!data.ok || !data.results || !data.results.length) {
      resEl.innerHTML = '<p><small>No titles found.</small></p>';
      return;
    }
    window._rawCatalogTitleItems = data.results;
    applySearchFilters();
  } catch (e) {
    resEl.innerHTML = '<p class="testresult err">✗ Could not load top titles.</p>';
  }
}

async function runCatalogSearch() {
  const q = document.getElementById('catalogSearchInput').value.trim();
  const resEl = document.getElementById('catalogSearchResult');
  if (!q) {
    renderDefaultCatalogSearch();
    return;
  }

  if (currentCatalogSearchType === 'lists') {
    return executeUnifiedListSearch(q, resEl);
  }

  resEl.innerHTML = '<p><small>Searching...</small></p>';

  try {
    fetch(ORIGIN + '/api/track-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q }),
      keepalive: true,
    }).catch(() => {});
  } catch (e) {}

  try {
    const res = await fetch(ORIGIN + '/api/title-search?type=' + currentCatalogSearchType + '&q=' + encodeURIComponent(q));
    const data = await res.json();
    if (!data.ok) {
      resEl.innerHTML = '<p class="testresult err">✗ ' + escapeHtml(data.error || 'Search failed.') + '</p>';
      return;
    }
    if (!data.results || !data.results.length) {
      window._rawCatalogTitleItems = [];
      resEl.innerHTML = '<p><small>No results found for "' + escapeHtml(q) + '".</small></p>';
      return;
    }
    
    window._rawCatalogTitleItems = data.results;
    applySearchFilters();
  } catch (e) {
    resEl.innerHTML = '<p class="testresult err">✗ Network error.</p>';
  }
}







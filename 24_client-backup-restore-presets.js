// --- config JSON export/import (backup / restore) --------------------------
//
// A plain-text alternative to the install link: the same { entries,
// mdblistKey } shape buildConfig() encodes into a base64 URL, but here it's
// left as readable JSON in a textarea -- something to copy into a notes app
// or another device, and paste back in later, without touching the actual
// install link.
// --- Payload references: the fix for backup/preset bloat ---------------------
//
// A catalog row's url is not a pointer, it is the data:
//
//   channel:v1:{"channelId":"chp3hsq9u1u5u6","name":"A&E","items":[ ...67KB... ]}
//
// which means one row can be 75KB, and the same items end up stored in
// several places at once. Measured on a real 5.9MB backup: the list
// "coming-of-age-movies" (462 items) appeared FIVE times -- in the
// customLists map, in its catalog row's url, and in all three presets'
// copies of that row. 87% of the entries block and 88% of the presets block
// was duplicated item data. That is what pushed localStorage past its
// ~5MB ceiling, and the overflow is what silently destroyed 24 of that
// account's 51 custom lists.
//
// So for anything we STORE or EXPORT, rows carry a reference instead:
//   channel:v1:{"channelId":"chp...","name":"A&E","itemsRef":"chp...","itemCount":812}
// and the items are read back from the customLists / channels maps, which
// are the actual source of truth and are already in the same backup file.
//
// Deliberately NOT applied to the live rows in the page. The url of a row
// that is currently configured is what gets encoded into the install link
// and sent to the Worker as the catalog config, and for a self-hosted
// Worker with no KV binding that embedded copy IS the storage -- there is
// nowhere else for it to live. Stripping it there would break catalogs for
// exactly the people who have no server-side fallback. Dereferencing is
// therefore confined to two places where a reference is unambiguously
// better: the backup file, and presets in localStorage.
const BACKUP_FORMAT_VERSION = '3.0';

// The payload key that identifies which stored list/channel a row points at.
function payloadRefKey(prefix, payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (prefix === 'channel:v1:') return String(payload.channelId || '');
  return String(payload.localSlug || payload.creatorSlug || payload.listSlug || payload.listId || '');
}

function splitPayloadUrl(url) {
  const s = String(url || '');
  for (const prefix of ['customlist:v1:', 'channel:v1:']) {
    if (s.startsWith(prefix)) {
      try {
        return { prefix: prefix, payload: JSON.parse(s.slice(prefix.length)) };
      } catch (e) {
        return null;   // unparseable -- leave the row exactly as it is
      }
    }
  }
  return null;
}

// Replaces a row's embedded items with a reference -- but only when the copy
// it is dropping is byte-identical to what would be read back. A row whose
// items exist nowhere else, or differ from the stored list, keeps them.
//
// That last case is not hypothetical. A "mixed" list split across a movie row
// and a series row gives each row a filtered SUBSET of the list: on the
// account that prompted this work, one list of 190 items backed a movie row
// of 163 and a series row of 27. Replacing either with a reference to the
// full 190 would quietly change what those rows show. So the test is
// equality, not merely "a list with this slug exists" -- which makes the
// whole round-trip provably lossless rather than probably lossless.
function sameItems(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;              // cheap reject first
  return JSON.stringify(a) === JSON.stringify(b);
}

function dereferenceEntry(entry, customLists, channels) {
  if (!entry || !entry.url) return entry;
  const split = splitPayloadUrl(entry.url);
  if (!split) return entry;
  const items = split.payload.items;
  if (!Array.isArray(items) || !items.length) return entry;
  const ref = payloadRefKey(split.prefix, split.payload);
  if (!ref) return entry;
  const source = (split.prefix === 'channel:v1:') ? (channels || {}) : (customLists || {});
  const stored = source[ref];
  if (!stored || !sameItems(items, stored.items)) return entry;
  // items is blanked in place rather than deleted, so rehydrating restores
  // the payload with its keys in their original order. That is what makes a
  // backup round-trip byte-identical instead of merely equivalent -- and
  // byte-identical is what lets the test suite assert it.
  const lean = {};
  Object.keys(split.payload).forEach((k) => { lean[k] = (k === 'items') ? null : split.payload[k]; });
  lean.itemsRef = ref;
  lean.itemCount = items.length;
  return Object.assign({}, entry, { url: split.prefix + JSON.stringify(lean) });
}

// Puts the items back. Falls back to whatever the row already carries, so a
// v1/v2 file (embedded items, no reference) round-trips untouched.
function rehydrateEntry(entry, customLists, channels) {
  if (!entry || !entry.url) return entry;
  const split = splitPayloadUrl(entry.url);
  if (!split) return entry;
  const p = split.payload;
  if (Array.isArray(p.items) && p.items.length) return entry;   // already has data (v1/v2 row)
  const ref = String(p.itemsRef || payloadRefKey(split.prefix, p) || '');
  if (!ref) return entry;
  const source = (split.prefix === 'channel:v1:') ? (channels || {}) : (customLists || {});
  const stored = source[ref];
  const items = stored && Array.isArray(stored.items) ? stored.items : null;
  if (!items) return entry;   // unresolved -- reported to the user, not silently dropped
  const full = {};
  Object.keys(p).forEach((k) => {
    if (k === 'itemsRef' || k === 'itemCount') return;
    full[k] = (k === 'items') ? items : p[k];
  });
  if (!('items' in full)) full.items = items;
  return Object.assign({}, entry, { url: split.prefix + JSON.stringify(full) });
}

function dereferenceEntries(entries, customLists, channels) {
  return (entries || []).map((e) => dereferenceEntry(e, customLists, channels));
}

function rehydrateEntries(entries, customLists, channels) {
  return (entries || []).map((e) => rehydrateEntry(e, customLists, channels));
}

// Rows whose reference could not be resolved. Used to tell the person which
// rows came back empty instead of letting them find out by scrolling past a
// blank shelf.
function unresolvedEntryNames(entries) {
  const out = [];
  (entries || []).forEach((e) => {
    const split = splitPayloadUrl(e && e.url);
    if (!split) return;
    const p = split.payload;
    if (p.itemsRef && !(Array.isArray(p.items) && p.items.length)) out.push(e.name || p.itemsRef);
  });
  return out;
}

window.dereferenceEntries = dereferenceEntries;
window.rehydrateEntries = rehydrateEntries;

function buildFullBackupPayload() {
  const entries = (typeof collectEntries === 'function') ? collectEntries() : [];
  const keys = (typeof collectKeys === 'function') ? collectKeys() : {};
  const map = (typeof loadLocalCustomLists === 'function') ? loadLocalCustomLists() : {};
  const channels = (typeof loadLocalChannels === 'function') ? loadLocalChannels() : {};
  const mergedChannels = (typeof loadLocalMergedChannels === 'function') ? loadLocalMergedChannels() : {};
  const presets = (typeof loadPresetsMap === 'function') ? loadPresetsMap() : {};

  const payload = {
    // 3.0 differs from 2.0 only in that rows reference their items instead
    // of embedding a second copy of them (see dereferenceEntries above).
    // Everything else is byte-for-byte the same shape, and importing a 1.x
    // or 2.0 file still works -- applyImportedConfig detects the format.
    version: BACKUP_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    entries: dereferenceEntries(entries, map, channels),
    keys: keys,
    customLists: map,
    channels: channels,
    mergedChannels: mergedChannels,
    presets: dereferencePresetsMap(presets, map, channels),
    settings: {
      trackPlayback: localStorage.getItem('myListAddon:trackPlayback') === '1',
      removeWatchedFromWatchlist: localStorage.getItem('myListAddon:removeWatchedFromWatchlist') !== '0',
      scrobbleFilterUsers: localStorage.getItem('myListAddon:scrobbleFilterUsers') === '1',
      scrobbleAllowedUsers: localStorage.getItem('myListAddon:scrobbleAllowedUsers') || '',
      scrobbleBlockAnonymous: localStorage.getItem('myListAddon:scrobbleBlockAnonymous') === '1',
      hideNonDigitalReleases: localStorage.getItem('myListAddon:hideNonDigitalReleases') === '1',
      region: localStorage.getItem('myListAddon:region') || '',
      dashboardListOrder: (function() { try { return JSON.parse(localStorage.getItem('myListAddon:dashboardListOrder') || '[]'); } catch(e) { return []; } })(),
      hiddenLists: (function() { try { return JSON.parse(localStorage.getItem('myListAddon:hiddenLists') || '[]'); } catch(e) { return []; } })(),
      hiddenMyListsSections: (function() { try { return JSON.parse(localStorage.getItem('myListAddon:hiddenMyListsSections') || '[]'); } catch(e) { return []; } })(),
      likedLists: (function() { try { return JSON.parse(localStorage.getItem('myListAddon:likedLists') || '[]'); } catch(e) { return []; } })(),
      fullyWatchedShowIds: [...(window._fullyWatchedShowIds || [])],
      dismissedContinueWatching: window._dismissedContinueWatching || {},
    }
  };

  // Top-level key fallbacks for backward compatibility
  if (keys.tmdbKey) payload.tmdbKey = keys.tmdbKey;
  if (keys.tmdbSessionId) payload.tmdbSessionId = keys.tmdbSessionId;
  if (keys.tmdbAccountId) payload.tmdbAccountId = keys.tmdbAccountId;
  if (keys.tmdbUsername) payload.tmdbUsername = keys.tmdbUsername;
  if (keys.mdblistKey) payload.mdblistKey = keys.mdblistKey;
  if (keys.mdblistAccessToken) payload.mdblistAccessToken = keys.mdblistAccessToken;
  if (keys.mdblistUsername) payload.mdblistUsername = keys.mdblistUsername;
  if (keys.traktKey) payload.traktKey = keys.traktKey;
  if (keys.traktUsername) payload.traktUsername = keys.traktUsername;
  if (keys.traktAccessToken) payload.traktAccessToken = keys.traktAccessToken;
  if (keys.simklKey) payload.simklKey = keys.simklKey;
  if (keys.simklAccessToken) payload.simklAccessToken = keys.simklAccessToken;
  if (keys.simklUsername) payload.simklUsername = keys.simklUsername;

  return payload;
}

function exportConfigJson() {
  const payload = buildFullBackupPayload();
  document.getElementById('configJsonBox').value = JSON.stringify(payload, null, 2);
}

function importConfigJson() {
  const raw = document.getElementById('configJsonBox').value.trim();
  if (!raw) {
    if (typeof showAppAlert === 'function') showAppAlert('Input Required', 'Paste a config JSON blob into the box first.', false);
    else alert('Paste a config JSON blob into the box first.');
    return;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    if (typeof showAppAlert === 'function') showAppAlert('Invalid JSON', 'That is not valid JSON.', false);
    else alert('That is not valid JSON.');
    return;
  }
  applyImportedConfig(data);
}

// Shared by importConfigJson (textarea) and uploadConfigFile (file upload) --
// restores catalogs, API credentials, custom lists, watch history, continue watching,
// watchlist, custom channels, presets, and user preferences.
// --- Import validation and repair --------------------------------------------
// Every check here exists because a real backup file failed it. Nothing is
// rejected: a backup is often somebody's only copy, so the job is to repair
// what can be repaired, report what cannot, and never fail silently -- which
// is exactly how the account that prompted this work lost 24 lists without
// anyone noticing until months later.
function detectBackupFormat(data) {
  const v = String((data && data.version) || '');
  if (v.startsWith('3.')) return '3.0';
  if (v.startsWith('2.')) return '2.0';
  return '1.x';   // entries-only, no version field
}

function looksLikeTmdbKey(v) {
  return /^[0-9a-f]{32}$/i.test(String(v || '').trim());
}

function validateAndRepairBackup(data) {
  const notes = [];
  const warnings = [];
  const format = detectBackupFormat(data);
  notes.push('Format detected: ' + format);

  const entries = Array.isArray(data.entries) ? data.entries
    : (Array.isArray(data.configuredCatalogs) ? data.configuredCatalogs : []);

  // 1. name/url transposed. detectSource() falls back to treating an
  //    unrecognised string as an MDBList url, so a row like
  //    {name:"https://mdblist.com/...", url:"Coming Soon"} does not error --
  //    it quietly fetches "Coming Soon" as a list and comes back empty.
  let swapped = 0;
  entries.forEach((e) => {
    const url = String((e && e.url) || '');
    const name = String((e && e.name) || '');
    const urlLooksLikeUrl = /^(https?:|customlist:|channel:|autotrack:|custom:|tmdb:|trakt:|simkl:|curated:)/.test(url);
    if (!urlLooksLikeUrl && /^https?:\\/\\//.test(name)) {
      e.url = name;
      e.name = url;
      swapped++;
    }
  });
  if (swapped) warnings.push('Fixed ' + swapped + ' row(s) that had their name and link swapped.');

  // 2. API key fields holding something that is not a key. This matters more
  //    than it looks: the Worker only falls back to the shared TMDB key when
  //    the field is EMPTY, so a wrong key is worse than none -- it disables
  //    the fallback and every poster click fails with "Not found or TMDB
  //    error".
  const keyHolders = [data, data.keys].filter((o) => o && typeof o === 'object');
  let badKeys = 0;
  keyHolders.forEach((h) => {
    if (h.tmdbKey && !looksLikeTmdbKey(h.tmdbKey)) { h.tmdbKey = ''; badKeys++; }
    if (h.mdblistKey && String(h.mdblistKey).trim().length < 20) { h.mdblistKey = ''; badKeys++; }
  });
  if (badKeys) warnings.push('Cleared an API key field that contained something other than a key (a username, most likely). The shared key will be used instead.');

  // 3. Items with no usable id. These render a poster with an empty data-id,
  //    so clicking one asks the server for details about nothing.
  let fixedIds = 0;
  let unfixableIds = 0;
  const lists = (data.customLists && typeof data.customLists === 'object') ? data.customLists : {};
  Object.keys(lists).forEach((slug) => {
    const items = (lists[slug] && lists[slug].items) || [];
    items.forEach((it) => {
      if (!it || typeof it !== 'object') return;
      if (!it.id) {
        const alt = it.imdbId || (it.tmdbId ? ('tmdb:' + it.tmdbId) : '');
        if (alt) { it.id = alt; fixedIds++; } else { unfixableIds++; }
      }
      // An episode keyed by a bare TMDB episode id cannot be resolved -- a
      // TMDB episode id is not a title id. The show is identifiable though,
      // so record a fallback the details view can fall back to.
      if (!it.detailsFallbackId && /^\\d+$/.test(String(it.id || '')) && /^tt\\d+/.test(String(it.showId || ''))) {
        it.detailsFallbackId = it.showId;
      }
    });
  });
  if (fixedIds) notes.push('Repaired ' + fixedIds + ' item(s) that had no id, using their IMDb/TMDB id.');
  if (unfixableIds) warnings.push(unfixableIds + ' item(s) have no usable id and may not open. They were kept.');

  // 4. The tell-tale sign of a backup taken while the browser was out of
  //    storage: the dashboard order remembers lists the file does not
  //    contain. This is the single most useful thing to say out loud -- it
  //    explains a whole class of "half my lists vanished" reports.
  const order = (data.settings && Array.isArray(data.settings.dashboardListOrder)) ? data.settings.dashboardListOrder : [];
  const missingFromOrder = order.filter((s) => !(s in lists));
  if (missingFromOrder.length) {
    warnings.push('This backup refers to ' + missingFromOrder.length + ' list(s) it does not actually contain. It was most likely exported while the browser was out of storage. Those lists cannot be restored from this file' + (typeof activeCreator !== 'undefined' && activeCreator ? ', but they may still be on your account.' : '.'));
  }

  // 5. Rows pointing at a list that is not in the file and carrying no items
  //    of their own -- they would restore as permanently empty shelves.
  const emptyRows = [];
  entries.forEach((e) => {
    const split = splitPayloadUrl(e && e.url);
    if (!split) return;
    const ref = String(split.payload.itemsRef || payloadRefKey(split.prefix, split.payload) || '');
    const embedded = Array.isArray(split.payload.items) ? split.payload.items.length : 0;
    const source = (split.prefix === 'channel:v1:') ? (data.channels || {}) : lists;
    if (ref && !(ref in source) && embedded === 0) emptyRows.push(e.name || ref);
  });
  if (emptyRows.length) {
    warnings.push(emptyRows.length + ' row(s) have no items and nothing to load them from: ' + emptyRows.slice(0, 5).join(', ') + (emptyRows.length > 5 ? '...' : ''));
  }

  return { data: data, format: format, notes: notes, warnings: warnings };
}

function showImportReport(report) {
  const lines = [].concat(report.notes, report.warnings);
  if (!lines.length) return;
  const title = report.warnings.length ? 'Restored with warnings' : 'Restored';
  const body = lines.map((l) => '\\u2022 ' + l).join('\\n');
  if (typeof showAppAlert === 'function') showAppAlert(title, body, false);
  else alert(title + '\\n\\n' + body);
}

function applyImportedConfig(data) {
  if (!data || (!Array.isArray(data.entries) && !data.customLists && !data.configuredCatalogs)) {
    if (typeof showAppAlert === 'function') showAppAlert('Invalid Config', 'That JSON does not look like a valid My Lists backup.', false);
    else alert('That JSON does not look like a valid My Lists backup.');
    return;
  }

  // Check and repair before anything touches storage, so a damaged file is
  // reported rather than absorbed.
  let importReport = null;
  try {
    importReport = validateAndRepairBackup(data);
  } catch (e) {
    // A failure here must not block a restore -- carry on with the file as
    // given, exactly as this did before the checks existed.
    importReport = null;
  }

  // Restore Catalogs. In a 3.0 file the rows reference their items rather
  // than embedding them, so put the items back from this same file's
  // customLists/channels first. A 1.x or 2.0 file still embeds them, and
  // rehydrateEntries leaves those untouched.
  const rawEntries = Array.isArray(data.entries) ? data.entries : (Array.isArray(data.configuredCatalogs) ? data.configuredCatalogs : []);
  const entries = rehydrateEntries(rawEntries, data.customLists || {}, data.channels || {});
  if (entries.length) {
    document.getElementById('lists').innerHTML = '';
    entries.forEach((e) => addRow(e.name, e.url, e.type, e.enabled, e.group, e.id));
  }

  // Restore API keys and connected accounts
  const keys = data.keys || {};
  const tmdbKey = data.tmdbKey || keys.tmdbKey;
  if (tmdbKey) {
    const el = document.getElementById('tmdbKeyInput');
    if (el) el.value = tmdbKey;
    try { localStorage.setItem('myListAddon:tmdbKey', tmdbKey); } catch (e) {}
  }
  const tmdbSessionIdVal = data.tmdbSessionId || keys.tmdbSessionId;
  if (tmdbSessionIdVal) {
    tmdbSessionId = tmdbSessionIdVal;
    window.tmdbSessionId = tmdbSessionIdVal;
    try { localStorage.setItem('myListAddon:tmdbSessionId', tmdbSessionIdVal); } catch (e) {}
  }
  const tmdbAccountIdVal = data.tmdbAccountId || keys.tmdbAccountId;
  if (tmdbAccountIdVal) {
    tmdbAccountId = tmdbAccountIdVal;
    try { localStorage.setItem('myListAddon:tmdbAccountId', tmdbAccountIdVal); } catch (e) {}
  }
  const tmdbUsernameVal = data.tmdbUsername || keys.tmdbUsername;
  if (tmdbUsernameVal) {
    tmdbUsername = tmdbUsernameVal;
    try { localStorage.setItem('myListAddon:tmdbUsername', tmdbUsernameVal); } catch (e) {}
  }
  if (typeof renderTmdbConnectStatus === 'function') renderTmdbConnectStatus();

  const mdblistKey = data.mdblistKey || keys.mdblistKey;
  if (mdblistKey) {
    const el = document.getElementById('mdblistKeyInput');
    if (el) el.value = mdblistKey;
    try { localStorage.setItem('myListAddon:mdblistKey', mdblistKey); } catch (e) {}
  }
  const mdblistAccessTokenVal = data.mdblistAccessToken || keys.mdblistAccessToken;
  if (mdblistAccessTokenVal) {
    mdblistAccessToken = mdblistAccessTokenVal;
    window.mdblistAccessToken = mdblistAccessTokenVal;
    try { localStorage.setItem('myListAddon:mdblistAccessToken', mdblistAccessTokenVal); } catch (e) {}
    if (typeof renderMdblistConnectStatus === 'function') renderMdblistConnectStatus();
  }
  const mdblistUsernameVal = data.mdblistUsername || keys.mdblistUsername;
  if (mdblistUsernameVal) {
    mdblistUsername = mdblistUsernameVal;
    window.mdblistUsername = mdblistUsernameVal;
    try { localStorage.setItem('myListAddon:mdblistUsername', mdblistUsernameVal); } catch (e) {}
  }

  const traktKey = data.traktKey || keys.traktKey;
  if (traktKey) {
    const el = document.getElementById('traktKeyInput');
    if (el) el.value = traktKey;
    try { localStorage.setItem('myListAddon:traktKey', traktKey); } catch (e) {}
  }
  const traktUsernameVal = data.traktUsername || keys.traktUsername;
  if (traktUsernameVal) {
    const el = document.getElementById('traktUsernameInput');
    if (el) el.value = traktUsernameVal;
    traktUsername = traktUsernameVal;
    try { localStorage.setItem('myListAddon:traktUsername', traktUsernameVal); } catch (e) {}
  }
  const traktAccessTokenVal = data.traktAccessToken || keys.traktAccessToken;
  if (traktAccessTokenVal) {
    traktAccessToken = traktAccessTokenVal;
    window.traktAccessToken = traktAccessTokenVal;
    try { localStorage.setItem('myListAddon:traktAccessToken', traktAccessTokenVal); } catch (e) {}
    if (typeof renderTraktConnectStatus === 'function') renderTraktConnectStatus();
  }

  const simklKey = data.simklKey || keys.simklKey;
  if (simklKey) {
    const el = document.getElementById('simklKeyInput');
    if (el) el.value = simklKey;
    try { localStorage.setItem('myListAddon:simklKey', simklKey); } catch (e) {}
  }
  const simklAccessTokenVal = data.simklAccessToken || keys.simklAccessToken;
  if (simklAccessTokenVal) {
    simklAccessToken = simklAccessTokenVal;
    window.simklAccessToken = simklAccessTokenVal;
    try { localStorage.setItem('myListAddon:simklAccessToken', simklAccessTokenVal); } catch (e) {}
  }
  const simklUsernameVal = data.simklUsername || keys.simklUsername;
  if (simklUsernameVal) {
    simklUsername = simklUsernameVal;
    window.simklUsername = simklUsernameVal;
    try { localStorage.setItem('myListAddon:simklUsername', simklUsernameVal); } catch (e) {}
    if (typeof renderSimklConnectStatus === 'function') renderSimklConnectStatus();
  }

  // Restore Custom Lists, Watchlist, Watch History, and Continue Watching
  if (data.customLists && typeof data.customLists === 'object') {
    const existingMap = (typeof loadLocalCustomLists === 'function') ? loadLocalCustomLists() : {};
    let customListsMap = {};
    if (Array.isArray(data.customLists)) {
      data.customLists.forEach((l) => { if (l && l.slug) customListsMap[l.slug] = l; });
    } else {
      customListsMap = { ...data.customLists };
    }
    const mergedMap = { ...existingMap, ...customListsMap };
    if (typeof backfillAutoTrackedListSlugs === 'function') backfillAutoTrackedListSlugs(mergedMap);
    if (typeof saveLocalCustomListsMap === 'function') saveLocalCustomListsMap(mergedMap);
  } else {
    // If watchHistory / continueWatching are top-level arrays (e.g. from full library export)
    const map = (typeof loadLocalCustomLists === 'function') ? loadLocalCustomLists() : {};
    let touchedLists = false;
    if (Array.isArray(data.watchHistory) && data.watchHistory.length) {
      if (typeof getOrCreateWatchHistoryList === 'function') {
        const wh = getOrCreateWatchHistoryList();
        wh.items = data.watchHistory;
        map['watch-history'] = wh;
        touchedLists = true;
      }
    }
    if (Array.isArray(data.continueWatching) && data.continueWatching.length) {
      if (typeof getOrCreateContinueWatchingList === 'function') {
        const cw = getOrCreateContinueWatchingList();
        cw.items = data.continueWatching;
        map['continue-watching'] = cw;
        touchedLists = true;
      }
    }
    if (touchedLists && typeof saveLocalCustomListsMap === 'function') {
      saveLocalCustomListsMap(map);
    }
  }

  // Restore Channels
  if (data.channels && typeof data.channels === 'object') {
    if (typeof saveLocalChannelsMap === 'function') saveLocalChannelsMap(data.channels);
  }
  if (data.mergedChannels && typeof data.mergedChannels === 'object') {
    if (typeof saveLocalMergedChannelsMap === 'function') saveLocalMergedChannelsMap(data.mergedChannels);
  }

  // Restore Presets, rehydrated against this file's own lists/channels for
  // the same reason the rows above are.
  if (data.presets && typeof data.presets === 'object') {
    const hydratedPresets = (typeof rehydratePresetsMap === 'function')
      ? rehydratePresetsMap(data.presets, data.customLists || {}, data.channels || {})
      : data.presets;
    if (typeof savePresetsMap === 'function') savePresetsMap(hydratedPresets);
  }

  // Restore Settings & Preferences
  const s = data.settings || {};
  if (typeof s.trackPlayback === 'boolean') {
    try { localStorage.setItem('myListAddon:trackPlayback', s.trackPlayback ? '1' : '0'); } catch (e) {}
  }
  if (typeof s.removeWatchedFromWatchlist === 'boolean') {
    try { localStorage.setItem('myListAddon:removeWatchedFromWatchlist', s.removeWatchedFromWatchlist ? '1' : '0'); } catch (e) {}
  }
  if (typeof s.scrobbleFilterUsers === 'boolean') {
    try { localStorage.setItem('myListAddon:scrobbleFilterUsers', s.scrobbleFilterUsers ? '1' : '0'); } catch (e) {}
  }
  if (typeof s.scrobbleAllowedUsers === 'string') {
    try { localStorage.setItem('myListAddon:scrobbleAllowedUsers', s.scrobbleAllowedUsers); } catch (e) {}
  }
  if (typeof s.scrobbleBlockAnonymous === 'boolean') {
    try { localStorage.setItem('myListAddon:scrobbleBlockAnonymous', s.scrobbleBlockAnonymous ? '1' : '0'); } catch (e) {}
  }
  if (typeof s.hideNonDigitalReleases === 'boolean') {
    const cb = document.getElementById('hideNonDigitalReleasesCheckbox');
    if (cb) cb.checked = s.hideNonDigitalReleases;
    try { localStorage.setItem('myListAddon:hideNonDigitalReleases', s.hideNonDigitalReleases ? '1' : '0'); } catch (e) {}
  }
  if (typeof s.region === 'string' && s.region) {
    const el = document.getElementById('regionSelect');
    if (el) el.value = s.region;
    try { localStorage.setItem('myListAddon:region', s.region); } catch (e) {}
  }
  if (Array.isArray(s.dashboardListOrder) && s.dashboardListOrder.length) {
    try { localStorage.setItem('myListAddon:dashboardListOrder', JSON.stringify(s.dashboardListOrder)); } catch (e) {}
  }
  if (Array.isArray(s.hiddenLists)) {
    try { localStorage.setItem('myListAddon:hiddenLists', JSON.stringify(s.hiddenLists)); } catch (e) {}
  }
  if (Array.isArray(s.hiddenMyListsSections)) {
    try { localStorage.setItem('myListAddon:hiddenMyListsSections', JSON.stringify(s.hiddenMyListsSections)); } catch (e) {}
  }
  if (Array.isArray(s.likedLists)) {
    try { localStorage.setItem('myListAddon:likedLists', JSON.stringify(s.likedLists)); } catch (e) {}
  }
  if (Array.isArray(s.fullyWatchedShowIds)) {
    window._fullyWatchedShowIds = new Set(s.fullyWatchedShowIds.map(String));
    try { localStorage.setItem('myListAddon:fullyWatchedShows', JSON.stringify(s.fullyWatchedShowIds)); } catch (e) {}
  }
  if (s.dismissedContinueWatching && typeof s.dismissedContinueWatching === 'object') {
    window._dismissedContinueWatching = s.dismissedContinueWatching;
    try { localStorage.setItem('myListAddon:dismissedContinueWatching', JSON.stringify(s.dismissedContinueWatching)); } catch (e) {}
  }

  // Refresh UI and local state
  renumber();
  checkAllDuplicateUrls();
  saveState();
  if (typeof updateConnectionStatusBadges === 'function') updateConnectionStatusBadges();
  if (typeof renderTrackPlaybackSection === 'function') renderTrackPlaybackSection();
  if (typeof renderWatchlistPreferencesSection === 'function') renderWatchlistPreferencesSection();
  if (typeof renderHiddenListsSettingsSection === 'function') renderHiddenListsSettingsSection();
  if (typeof applyHiddenMyListsSections === 'function') applyHiddenMyListsSections();
  if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard();
  if (typeof renderMyCustomListsList === 'function') renderMyCustomListsList();
  if (typeof renderChannelsList === 'function') renderChannelsList();
  if (typeof renderMyCreatedChannelsList === 'function') renderMyCreatedChannelsList();
  if (typeof renderChannelMergeList === 'function') renderChannelMergeList();
  if (typeof renderPresetsList === 'function') renderPresetsList();
  if (typeof scheduleMyTmdbListsRefresh === 'function') scheduleMyTmdbListsRefresh();
  if (typeof scheduleMyMdblistListsRefresh === 'function') scheduleMyMdblistListsRefresh();
  if (typeof scheduleMyTraktListsRefresh === 'function') scheduleMyTraktListsRefresh();
  if (typeof scheduleMySimklListsRefresh === 'function') scheduleMySimklListsRefresh();

  // If signed in as Creator, push restored data to cloud sync
  if (typeof activeCreator !== 'undefined' && activeCreator) {
    if (typeof pushCreatorSync === 'function') pushCreatorSync();
    if (typeof pushPresetsDirectly === 'function' && data.presets) pushPresetsDirectly(data.presets);
    if (typeof pushChannelsSync === 'function' && (data.channels || data.mergedChannels)) pushChannelsSync();
    if (typeof pushTrackingSync === 'function') pushTrackingSync();
  }

  // A restore that quietly dropped rows or cleared a bad key should say so.
  // The plain success dialog is kept for the case where nothing needed
  // repairing, which is the normal one.
  if (importReport && (importReport.warnings.length || importReport.format !== '3.0')) {
    showImportReport(importReport);
  } else if (typeof showAppAlert === 'function') {
    showAppAlert('Restore Complete', 'Your setup, lists, watch history, channels, and settings have been restored successfully.', true);
  }
  else alert('Your setup, lists, watch history, channels, and settings have been restored successfully.');
}

// --- import from an existing link -------------------------------------------
//
// Reads this add-on's own install link / configure link / stremio:// /
// wako:// link back into rows, via the server's /api/resolve (same
// resolveConfig() the manifest/configure routes use, so it works whether
// the link is a short KV id or a legacy self-contained base64 blob). This
// can only work for THIS add-on's own links -- a manifest from a different
// Stremio add-on, or a screenshot of one, doesn't carry the original list
// URLs anywhere recoverable, so there's no reliable way to reconstruct rows
// from either of those; Bulk Add below is the practical fallback there.
async function resolveInstallLinkData(raw) {
  const cleaned = raw.replace(/^(?:stremio|nuvio|wako):\\/\\//i, 'https://');
  const m = cleaned.match(/^(https?:\\/\\/[^/]+)?\\/([^/]+)\\/(?:manifest\\.json|configure)(?:[/?#]|$)/i);
  let targetOrigin = null;
  let config = null;
  if (m) {
    if (m[1]) targetOrigin = m[1];
    config = m[2];
  } else if (/^[A-Za-z0-9_-]{6,}$/.test(cleaned)) {
    config = cleaned;
  }
  if (!config) {
    return { ok: false, error: 'Could not find a config in that link -- paste the full install link (ending in /manifest.json) or a configure link.' };
  }

  // 1. If the link came from a remote domain, fetch directly from the remote domain's /api/resolve
  if (targetOrigin && targetOrigin.toLowerCase() !== ORIGIN.toLowerCase()) {
    try {
      const res = await fetch(targetOrigin + '/api/resolve?config=' + encodeURIComponent(config));
      if (res.ok) {
        const data = await res.json();
        if (data && data.ok && Array.isArray(data.entries) && data.entries.length) {
          return data;
        }
      }
    } catch (e) {}
  }

  // 2. Try resolving with local worker /api/resolve (passing url for proxy fallback)
  try {
    const res = await fetch(ORIGIN + '/api/resolve?config=' + encodeURIComponent(config) + (targetOrigin ? '&url=' + encodeURIComponent(cleaned) : ''));
    if (res.ok) {
      const data = await res.json();
      if (data && data.ok && Array.isArray(data.entries) && data.entries.length) {
        return data;
      }
      if (data && data.ok === false && data.error) {
        return data;
      }
    }
  } catch (e) {}

  // 3. Fallback: fetch manifest.json directly if targetOrigin is present
  if (targetOrigin) {
    try {
      const manifestUrl = targetOrigin + '/' + encodeURIComponent(config) + '/manifest.json';
      const mRes = await fetch(manifestUrl);
      if (mRes.ok) {
        const manifest = await mRes.json();
        if (manifest && Array.isArray(manifest.catalogs) && manifest.catalogs.length) {
          const fallbackEntries = manifest.catalogs.map((c) => ({
            id: c.id,
            name: c.name || 'Catalog',
            type: c.type || 'movie',
            enabled: true,
            group: 'Imported',
            url: c.id ? (c.id.startsWith('ch') ? 'channel:v1:' + JSON.stringify({ channelId: c.id, name: c.name }) : (c.id.startsWith('customlist:') ? 'customlist:v1:' + JSON.stringify({ listId: c.id, name: c.name }) : c.id)) : ''
          }));
          return { ok: true, entries: fallbackEntries };
        }
      }
    } catch (e) {}
  }

  return { ok: false, error: 'That link has no lists in it.' };
}

async function importFromLink() {
  const raw = document.getElementById('importLinkInput').value.trim();
  if (!raw) {
    if (typeof showAppAlert === 'function') showAppAlert('Link Required', 'Paste an install link, configure link, or stremio:// / wako:// link first.', false);
    else alert('Paste an install link, configure link, or stremio://\\/wako:// link first.');
    return;
  }
  try {
    const data = await resolveInstallLinkData(raw);
    if (!data || !data.ok) {
      if (typeof showAppAlert === 'function') showAppAlert('Link Error', 'Could not load that link: ' + ((data && data.error) || 'unknown error'), false);
      else alert('Could not load that link: ' + ((data && data.error) || 'unknown error'));
      return;
    }
    data.entries.forEach((e) => addRow(e.name, e.url, e.type, e.enabled, e.group, e.id));
    if (data.mdblistKey) document.getElementById('mdblistKeyInput').value = data.mdblistKey;
    if (data.mdblistAccessToken) {
      mdblistAccessToken = data.mdblistAccessToken;
      if (typeof renderMdblistConnectStatus === 'function') renderMdblistConnectStatus();
    }
    if (data.traktKey) document.getElementById('traktKeyInput').value = data.traktKey;
    if (data.traktUsername) document.getElementById('traktUsernameInput').value = data.traktUsername;
    if (data.traktAccessToken) {
      traktAccessToken = data.traktAccessToken;
      renderTraktConnectStatus();
    }
    renumber();
    checkAllDuplicateUrls();
    saveState();
    renderChannelMergeList();

    // Rebuild & restore custom lists and channels from the imported link
    const { lists: extractedLists, channels: extractedChannels } = extractCustomListsAndChannelsFromPreset(data);
    const listSlugs = Object.keys(extractedLists);
    const channelIds = Object.keys(extractedChannels);

    let restoredListsCount = 0;
    const restoredListNames = [];
    let hasTrackingChanges = false;
    if (listSlugs.length > 0) {
      let localCustomListsMap = (typeof loadLocalCustomLists === 'function') ? loadLocalCustomLists() : {};
      listSlugs.forEach((slug) => {
        const rebuilt = extractedLists[slug];
        if (!localCustomListsMap[slug]) {
          localCustomListsMap[slug] = rebuilt;
          restoredListsCount++;
          restoredListNames.push(rebuilt.name || slug);
          if (slug === 'watch-history' || slug === 'continue-watching' || slug === 'watchlist') {
            hasTrackingChanges = true;
          }
        } else {
          const existing = localCustomListsMap[slug];
          const seenKeys = new Set((existing.items || []).map((it) => String(it.id || it.imdbId || it.tmdbId || it.title || '')));
          let addedItems = 0;
          (rebuilt.items || []).forEach((it) => {
            const key = String(it.id || it.imdbId || it.tmdbId || it.title || '');
            if (!seenKeys.has(key)) {
              if (!existing.items) existing.items = [];
              existing.items.push(it);
              seenKeys.add(key);
              addedItems++;
            }
          });
          if (addedItems > 0) {
            existing.updatedAt = Date.now();
            restoredListsCount++;
            restoredListNames.push((existing.name || slug) + ' (+' + addedItems + ' items)');
            if (slug === 'watch-history' || slug === 'continue-watching' || slug === 'watchlist') {
              hasTrackingChanges = true;
            }
          }
        }
      });
      if (typeof saveLocalCustomListsMap === 'function') saveLocalCustomListsMap(localCustomListsMap);
      if (localCustomListsMap['watch-history'] && Array.isArray(localCustomListsMap['watch-history'].items)) {
        window._rawWatchHistoryItems = localCustomListsMap['watch-history'].items;
        window._watchedItemIds = new Set((window._rawWatchHistoryItems || []).map((it) => String(it.id || it.imdbId || (it.tmdbId ? 'tmdb:' + it.tmdbId : '') || '')));
      }
    }

    if (channelIds.length > 0) {
      let localChannelsMap = (typeof loadLocalChannels === 'function') ? loadLocalChannels() : {};
      channelIds.forEach((chId) => {
        if (!localChannelsMap[chId]) localChannelsMap[chId] = extractedChannels[chId];
      });
      if (typeof saveLocalChannelsMap === 'function') saveLocalChannelsMap(localChannelsMap);
    }

    if (hasTrackingChanges) {
      if (typeof pushTrackingSync === 'function') pushTrackingSync();
      if (typeof renderWatchHistoryGrid === 'function') renderWatchHistoryGrid();
    }

    if (listSlugs.length > 0 || channelIds.length > 0) {
      if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard();
      if (typeof renderMyCustomListsList === 'function') renderMyCustomListsList();
      if (typeof renderChannelsList === 'function') renderChannelsList();
      if (typeof renderMyCreatedChannelsList === 'function') renderMyCreatedChannelsList();
      if (typeof updateAllListAddButtons === 'function') updateAllListAddButtons();
      if (typeof activeCreator !== 'undefined' && activeCreator) {
        if (typeof scheduleCreatorSyncSave === 'function') scheduleCreatorSyncSave();
        if (typeof pushCreatorSync === 'function') pushCreatorSync();
        if (typeof pushChannelsSync === 'function') pushChannelsSync();
      }
    }

    document.getElementById('importLinkInput').value = '';
    let msg = 'Imported ' + data.entries.length + ' list' + (data.entries.length === 1 ? '' : 's') + ' from that link.';
    if (listSlugs.length > 0 || channelIds.length > 0) {
      const parts = [];
      if (listSlugs.length) parts.push(listSlugs.length + ' custom list' + (listSlugs.length === 1 ? '' : 's'));
      if (channelIds.length) parts.push(channelIds.length + ' channel' + (channelIds.length === 1 ? '' : 's'));
      msg += '\\n\\nRestored ' + parts.join(' and ') + ' to your My Lists tab.';
      if (restoredListNames.length) msg += '\\n\\n• ' + restoredListNames.join('\\n• ');
    }
    if (typeof showAppAlert === 'function') showAppAlert('Import Complete', msg, true);
    else alert(msg);
  } catch (e) {
    if (typeof showAppAlert === 'function') showAppAlert('Network Error', 'Network error while resolving that link.', false);
    else alert('Network error while resolving that link.');
  }
}

async function restoreListsFromLink() {
  const raw = document.getElementById('importLinkInput').value.trim();
  if (!raw) {
    if (typeof showAppAlert === 'function') showAppAlert('Link Required', 'Paste an install link, configure link, or stremio:// / wako:// link first.', false);
    else alert('Paste an install link, configure link, or stremio://\\/wako:// link first.');
    return;
  }
  try {
    const data = await resolveInstallLinkData(raw);
    if (!data || !data.ok) {
      if (typeof showAppAlert === 'function') showAppAlert('Link Error', 'Could not load that link: ' + ((data && data.error) || 'unknown error'), false);
      else alert('Could not load that link: ' + ((data && data.error) || 'unknown error'));
      return;
    }

    const { lists: extractedLists, channels: extractedChannels } = extractCustomListsAndChannelsFromPreset(data);
    const listSlugs = Object.keys(extractedLists);
    const channelIds = Object.keys(extractedChannels);

    if (!listSlugs.length && !channelIds.length) {
      if (typeof showAppAlert === 'function') showAppAlert('No Custom Lists Found', 'That link does not contain any custom lists or custom channels.', false);
      else alert('That link does not contain any custom lists or custom channels.');
      return;
    }

    let localCustomListsMap = (typeof loadLocalCustomLists === 'function') ? loadLocalCustomLists() : {};
    let restoredListsCount = 0;
    const restoredListNames = [];
    let hasTrackingChanges = false;
    listSlugs.forEach((slug) => {
      const rebuilt = extractedLists[slug];
      if (!localCustomListsMap[slug]) {
        localCustomListsMap[slug] = rebuilt;
        restoredListsCount++;
        restoredListNames.push(rebuilt.name || slug);
        if (slug === 'watch-history' || slug === 'continue-watching' || slug === 'watchlist') {
          hasTrackingChanges = true;
        }
      } else {
        const existing = localCustomListsMap[slug];
        const seenKeys = new Set((existing.items || []).map((it) => String(it.id || it.imdbId || it.tmdbId || it.title || '')));
        let addedItems = 0;
        (rebuilt.items || []).forEach((it) => {
          const key = String(it.id || it.imdbId || it.tmdbId || it.title || '');
          if (!seenKeys.has(key)) {
            if (!existing.items) existing.items = [];
            existing.items.push(it);
            seenKeys.add(key);
            addedItems++;
          }
        });
        if (addedItems > 0) {
          existing.updatedAt = Date.now();
          restoredListsCount++;
          restoredListNames.push((existing.name || slug) + ' (+' + addedItems + ' items)');
          if (slug === 'watch-history' || slug === 'continue-watching' || slug === 'watchlist') {
            hasTrackingChanges = true;
          }
        }
      }
    });
    if (typeof saveLocalCustomListsMap === 'function') saveLocalCustomListsMap(localCustomListsMap);
    if (localCustomListsMap['watch-history'] && Array.isArray(localCustomListsMap['watch-history'].items)) {
      window._rawWatchHistoryItems = localCustomListsMap['watch-history'].items;
      window._watchedItemIds = new Set((window._rawWatchHistoryItems || []).map((it) => String(it.id || it.imdbId || (it.tmdbId ? 'tmdb:' + it.tmdbId : '') || '')));
    }

    if (channelIds.length > 0) {
      let localChannelsMap = (typeof loadLocalChannels === 'function') ? loadLocalChannels() : {};
      channelIds.forEach((chId) => {
        if (!localChannelsMap[chId]) localChannelsMap[chId] = extractedChannels[chId];
      });
      if (typeof saveLocalChannelsMap === 'function') saveLocalChannelsMap(localChannelsMap);
    }

    if (hasTrackingChanges) {
      if (typeof pushTrackingSync === 'function') pushTrackingSync();
      if (typeof renderWatchHistoryGrid === 'function') renderWatchHistoryGrid();
    }

    if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard();
    if (typeof renderMyCustomListsList === 'function') renderMyCustomListsList();
    if (typeof renderChannelsList === 'function') renderChannelsList();
    if (typeof renderMyCreatedChannelsList === 'function') renderMyCreatedChannelsList();
    if (typeof updateAllListAddButtons === 'function') updateAllListAddButtons();
    if (typeof activeCreator !== 'undefined' && activeCreator) {
      if (typeof scheduleCreatorSyncSave === 'function') scheduleCreatorSyncSave();
      if (typeof pushCreatorSync === 'function') pushCreatorSync();
      if (typeof pushChannelsSync === 'function') pushChannelsSync();
    }

    document.getElementById('importLinkInput').value = '';
    let msg = 'Restored ' + listSlugs.length + ' custom list' + (listSlugs.length === 1 ? '' : 's');
    if (channelIds.length) {
      msg += ' and ' + channelIds.length + ' channel' + (channelIds.length === 1 ? '' : 's');
    }
    msg += ' from that link into your My Lists tab.';
    if (restoredListNames.length) {
      msg += '\\n\\n• ' + restoredListNames.join('\\n• ');
    }
    if (typeof showAppAlert === 'function') showAppAlert('Custom Lists Rebuilt', msg, true);
    else alert(msg);
  } catch (e) {
    if (typeof showAppAlert === 'function') showAppAlert('Network Error', 'Network error while resolving that link.', false);
    else alert('Network error while resolving that link.');
  }
}

// --- personal presets --------------------------------------------------------
//
// Named local saves of a row selection, for reuse ("my usual setup") or
// sharing (Share copies the same JSON shape the Backup/Restore export
// uses, so the recipient can paste it into their own Import box). Stored
// separately from the autosave snapshot under its own localStorage key, and
// deliberately never includes the MDBList key -- a preset is meant to be
// safe to hand to someone else without a second thought.
const PRESETS_KEY = 'myListAddon:presets';

// Backs every preset-related function below (they all go through
// loadPresetsMap()), since localStorage alone can't be trusted to hold
// everything once a signed-in account's presets include a large Channel --
// once something's too big to persist there, it would otherwise silently
// vanish from Load/Share/Download/Delete too, not just fail to save.
// localStorage is still used underneath as a best-effort mirror for
// whatever it CAN hold, refreshed from the account by loadCreatorSync
// after every sign-in.
let cachedPresetsMap = null;

// loadPresetsMap falls back to this when storage has nothing, which is
// exactly the state signing out leaves behind -- so without clearing it the
// previous account's presets survived the sign-out that had just wiped
// every key they came from.
function resetPresetsCache() {
  cachedPresetsMap = null;
}
window.resetPresetsCache = resetPresetsCache;

function extractNormalizedPresetsMap(rawObj) {
  if (!rawObj || typeof rawObj !== 'object') return {};
  if (rawObj.presets && typeof rawObj.presets === 'object' && !Array.isArray(rawObj.presets)) {
    return extractNormalizedPresetsMap(rawObj.presets);
  }
  if (Array.isArray(rawObj)) {
    const map = {};
    rawObj.forEach((p) => {
      if (p && p.name) map[p.name] = p;
    });
    return map;
  }
  const map = {};
  Object.keys(rawObj).forEach((k) => {
    if (k !== 'presetsB64' && k !== 'updatedAt' && rawObj[k] && typeof rawObj[k] === 'object') {
      map[k] = rawObj[k];
    }
  });
  return map;
}
window.extractNormalizedPresetsMap = extractNormalizedPresetsMap;

// Presets are the worst offender for duplication: each one stores a full
// copy of every configured row, embedded items and all. On the account that
// prompted this work, three presets came to 2,063,754 bytes -- more than the
// custom lists they were copying. Stored as references they are ~28KB.
function dereferencePresetsMap(map, customLists, channels) {
  const out = {};
  Object.keys(map || {}).forEach((k) => {
    const p = map[k];
    const entries = Array.isArray(p) ? p : ((p && p.entries) || []);
    const rest = (p && !Array.isArray(p)) ? Object.assign({}, p) : {};
    delete rest.entries;
    out[k] = Object.assign(rest, { entries: dereferenceEntries(entries, customLists, channels) });
  });
  return out;
}

function rehydratePresetsMap(map, customLists, channels) {
  const out = {};
  Object.keys(map || {}).forEach((k) => {
    const p = map[k];
    const entries = Array.isArray(p) ? p : ((p && p.entries) || []);
    const rest = (p && !Array.isArray(p)) ? Object.assign({}, p) : {};
    delete rest.entries;
    out[k] = Object.assign(rest, { entries: rehydrateEntries(entries, customLists, channels) });
  });
  return out;
}
window.dereferencePresetsMap = dereferencePresetsMap;
window.rehydratePresetsMap = rehydratePresetsMap;

// The maps a preset's references resolve against. Read lazily and
// defensively -- a preset must still load if one of them is unavailable.
function presetSourceMaps() {
  let lists = {};
  let chans = {};
  try { if (typeof loadLocalCustomLists === 'function') lists = loadLocalCustomLists() || {}; } catch (e) {}
  try { if (typeof loadLocalChannels === 'function') chans = loadLocalChannels() || {}; } catch (e) {}
  return { lists: lists, chans: chans };
}

function loadPresetsMap() {
  let map = {};
  const keysToCheck = [PRESETS_KEY, 'presets', 'myListAddon:savedPresets', 'savedPresets'];
  for (const k of keysToCheck) {
    try {
      const raw = localStorage.getItem(k);
      if (raw) {
        const parsed = JSON.parse(raw);
        const extracted = extractNormalizedPresetsMap(parsed);
        if (Object.keys(extracted).length > 0) {
          map = { ...map, ...extracted };
        }
      }
    } catch (e) {}
  }

  // Also check if presets were saved inside state or backup objects
  try {
    const stateRaw = localStorage.getItem('myListAddon:state');
    if (stateRaw) {
      const parsedState = JSON.parse(stateRaw);
      if (parsedState && parsedState.presets) {
        const extracted = extractNormalizedPresetsMap(parsedState.presets);
        if (Object.keys(extracted).length > 0) {
          map = { ...map, ...extracted };
        }
      }
    }
  } catch (e) {}

  try {
    const backupRaw = localStorage.getItem('myListAddon:backup');
    if (backupRaw) {
      const parsedBackup = JSON.parse(backupRaw);
      if (parsedBackup && parsedBackup.presets) {
        const extracted = extractNormalizedPresetsMap(parsedBackup.presets);
        if (Object.keys(extracted).length > 0) {
          map = { ...map, ...extracted };
        }
      }
    }
  } catch (e) {}

  if (map && Object.keys(map).length > 0) {
    // Stored presets hold references; put the items back before anyone sees
    // them. A preset written before this change still embeds its items, and
    // rehydrateEntry leaves those exactly as they are -- so old and new
    // presets both come out of here fully populated.
    const src = presetSourceMaps();
    map = rehydratePresetsMap(map, src.lists, src.chans);
    cachedPresetsMap = map;
    return map;
  }
  if (cachedPresetsMap && typeof cachedPresetsMap === 'object' && !Array.isArray(cachedPresetsMap) && Object.keys(cachedPresetsMap).length > 0) {
    return cachedPresetsMap;
  }
  return {};
}
window.loadPresetsMap = loadPresetsMap;

function savePresetsMap(map) {
  cachedPresetsMap = map;
  // Written as references. The in-memory copy above keeps its full items so
  // nothing the caller holds changes underneath it; only what lands in
  // localStorage (and, via pushPresetsDirectly, on the account) is lean.
  const src = presetSourceMaps();
  const leanRefs = dereferencePresetsMap(map, src.lists, src.chans);
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(leanRefs));
    return true;
  } catch (e) {
    try {
      const leanMap = {};
      Object.keys(map).forEach((k) => {
        const p = map[k];
        leanMap[k] = {
          entries: Array.isArray(p) ? p : ((p && p.entries) || []),
        };
      });
      localStorage.setItem(PRESETS_KEY, JSON.stringify(leanMap));
      return true;
    } catch (err2) {
      return false;
    }
  }
}
window.savePresetsMap = savePresetsMap;

// Pushes a presets map straight to the account's dedicated presets record
// (see /api/creator/sync/save-presets) -- the ONLY path presets travel to
// the server through now, whether from the normal debounced
// schedulePresetsSync path or, as originally added here, as a fallback
// when the local write just failed (see saveCurrentAsPreset below):
// loadPresetsMap() there would only re-read the same stale, pre-failure
// data from localStorage, silently dropping the new preset even for
// someone who's signed in -- passing the in-memory map directly here is
// what actually gets the just-added preset saved anywhere at all in that
// case. Deliberately sends nothing else (no config/collapsedPanels/
// likedLists) -- see save-presets' own comment for why keeping this
// request small is the actual point of the split.
async function pushPresetsDirectly(presetsMap) {
  // See the same guard in pushCreatorSync -- a reset in progress must not be
  // undone by an in-flight preset save.
  if (window._suppressCreatorSync) return { ok: false, error: null };
  if (!activeCreator) return { ok: false, error: null };
  const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
  if (!creatorKey) return { ok: false, error: null };
  try {
    // Sent as references too. The account's presets record was the other
    // place the duplicated item data piled up, and it travels over the wire
    // on every preset change.
    const src = presetSourceMaps();
    const leanPresets = dereferencePresetsMap(presetsMap, src.lists, src.chans);
    const presetsB64 = await compressJsonToBase64(leanPresets);
    const res = await fetch(ORIGIN + '/api/creator/sync/save-presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creatorName: activeCreator.creatorName,
        creatorKey: creatorKey,
        presets: presetsB64 ? undefined : leanPresets,
        presetsB64: presetsB64,
      }),
    });
    const data = await res.json().catch(() => null);
    if (!data || data.ok === false) {
      console.error('pushPresetsDirectly failed:', res.status, data);
      return { ok: false, error: (data && data.error) || null, status: res.status };
    }
    return { ok: true, error: null };
  } catch (e) {
    console.error('pushPresetsDirectly failed:', e);
    return { ok: false, error: null };
  }
}
window.pushPresetsDirectly = pushPresetsDirectly;

async function saveCurrentAsPreset() {
  const nameInput = document.getElementById('presetNameInput');
  const name = nameInput.value.trim();
  if (!name) {
    if (typeof showAppAlert === 'function') showAppAlert('Preset Name Required', 'Name this preset first.', false);
    else alert('Name this preset first.');
    return;
  }
  const entries = collectEntries();
  if (!entries.length) {
    if (typeof showAppAlert === 'function') showAppAlert('Empty Catalogs', 'Add at least one list first.', false);
    else alert('Add at least one list first.');
    return;
  }
  const customListsMap = (typeof loadLocalCustomLists === 'function') ? loadLocalCustomLists() : {};
  const channelsMap = (typeof loadLocalChannels === 'function') ? loadLocalChannels() : {};
  const relevantCustomLists = {};
  const relevantChannels = {};

  entries.forEach((e) => {
    if (!e || !e.url) return;
    const urls = String(e.url).split('\\n');
    urls.forEach((u) => {
      if (u.startsWith('channel:v1:')) {
        try {
          const p = JSON.parse(u.slice('channel:v1:'.length));
          if (p && p.channelId && channelsMap[p.channelId]) {
            relevantChannels[p.channelId] = channelsMap[p.channelId];
          }
        } catch (err) {}
      } else if (u.startsWith('customlist:v1:')) {
        try {
          const p = JSON.parse(u.slice('customlist:v1:'.length));
          const slug = p.localSlug || p.slug;
          if (slug && customListsMap[slug]) {
            relevantCustomLists[slug] = customListsMap[slug];
          }
        } catch (err) {}
      }
    });
  });

  const map = loadPresetsMap();
  map[name] = {
    entries: entries,
    ...(Object.keys(relevantCustomLists).length ? { customLists: relevantCustomLists } : {}),
    ...(Object.keys(relevantChannels).length ? { channels: relevantChannels } : {}),
  };
  const localOk = savePresetsMap(map);

  if (!localOk) {
    const pushResult = activeCreator ? await pushPresetsDirectly(map) : { ok: false, error: null };
    if (!pushResult.ok) {
      const errMsg = activeCreator
        ? (pushResult.error
            ? "Could not save this preset to your account: " + pushResult.error
            : "Could not save this preset to your account either — check your connection and try again. If this keeps happening, check the browser console (F12) for more detail.")
        : "Could not save this preset — your browser's local storage is full. Try removing an older preset or using Backup/Restore's 'Download as file' option.";
      if (typeof showAppAlert === 'function') {
        showAppAlert('Preset Save Error', errMsg, false);
      } else {
        alert(errMsg);
      }
      return;
    }
  }

  nameInput.value = '';
  renderPresetsList();
  if (localOk) schedulePresetsSync();
  if (typeof showAddedToast === 'function') {
    showAddedToast('Saved preset "' + name + '" \u2713');
  }
}

function extractCustomListsAndChannelsFromPreset(preset) {
  const extractedLists = {};
  const extractedChannels = {};

  if (!preset) return { lists: extractedLists, channels: extractedChannels };

  // 1. Direct customLists in preset
  if (preset.customLists && typeof preset.customLists === 'object') {
    if (Array.isArray(preset.customLists)) {
      preset.customLists.forEach((l) => { if (l && l.slug) extractedLists[l.slug] = { ...l }; });
    } else {
      Object.keys(preset.customLists).forEach((slug) => {
        if (preset.customLists[slug]) extractedLists[slug] = { ...preset.customLists[slug] };
      });
    }
  }

  // 2. Direct watchHistory / continueWatching / watchlist
  const wh = preset.watchHistory || preset.watch_history;
  if (Array.isArray(wh) && wh.length) {
    if (!extractedLists['watch-history']) {
      extractedLists['watch-history'] = { slug: 'watch-history', name: 'Watch History', type: 'mixed', items: [...wh], createdAt: Date.now(), updatedAt: Date.now() };
    } else {
      const existing = extractedLists['watch-history'];
      const seenKeys = new Set((existing.items || []).map((it) => String(it.id || it.imdbId || it.tmdbId || it.title || '')));
      wh.forEach((it) => {
        const key = String(it.id || it.imdbId || it.tmdbId || it.title || '');
        if (!seenKeys.has(key)) {
          if (!existing.items) existing.items = [];
          existing.items.push(it);
          seenKeys.add(key);
        }
      });
    }
  }

  const cw = preset.continueWatching || preset.continue_watching;
  if (Array.isArray(cw) && cw.length) {
    if (!extractedLists['continue-watching']) {
      extractedLists['continue-watching'] = { slug: 'continue-watching', name: 'Continue Watching', type: 'mixed', items: [...cw], createdAt: Date.now(), updatedAt: Date.now() };
    } else {
      const existing = extractedLists['continue-watching'];
      const seenKeys = new Set((existing.items || []).map((it) => String(it.id || it.imdbId || it.tmdbId || it.title || '')));
      cw.forEach((it) => {
        const key = String(it.id || it.imdbId || it.tmdbId || it.title || '');
        if (!seenKeys.has(key)) {
          if (!existing.items) existing.items = [];
          existing.items.push(it);
          seenKeys.add(key);
        }
      });
    }
  }

  const wl = preset.watchlist;
  if (Array.isArray(wl) && wl.length) {
    if (!extractedLists['watchlist']) {
      extractedLists['watchlist'] = { slug: 'watchlist', name: 'Watchlist', type: 'mixed', isWatchlist: true, items: [...wl], createdAt: Date.now(), updatedAt: Date.now() };
    } else {
      const existing = extractedLists['watchlist'];
      const seenKeys = new Set((existing.items || []).map((it) => String(it.id || it.imdbId || it.tmdbId || it.title || '')));
      wl.forEach((it) => {
        const key = String(it.id || it.imdbId || it.tmdbId || it.title || '');
        if (!seenKeys.has(key)) {
          if (!existing.items) existing.items = [];
          existing.items.push(it);
          seenKeys.add(key);
        }
      });
    }
  }

  // 3. Direct channels in preset
  if (preset.channels && typeof preset.channels === 'object') {
    Object.keys(preset.channels).forEach((id) => {
      if (preset.channels[id]) extractedChannels[id] = { ...preset.channels[id] };
    });
  }

  // 4. Extract from preset.entries
  const entries = Array.isArray(preset) ? preset : ((preset && Array.isArray(preset.entries)) ? preset.entries : []);
  entries.forEach((e) => {
    if (!e || !e.url) return;
    const urls = String(e.url).split('\\n').map((s) => s.trim()).filter(Boolean);
    urls.forEach((u) => {
      if (u.startsWith('customlist:v1:')) {
        try {
          const payload = JSON.parse(u.slice('customlist:v1:'.length));
          if (payload && Array.isArray(payload.items)) {
            const cleanName = (e.name || payload.name || 'Custom List').replace(/\s*\((Movies|Shows)\)$/i, '').trim();
            const slug = payload.localSlug || payload.listSlug || payload.creatorSlug || payload.slug || (typeof slugify === 'function' ? slugify(cleanName) : cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '-')) || 'list';
            const itemType = payload.type || e.type || 'movie';

            if (extractedLists[slug]) {
              const existing = extractedLists[slug];
              const seenKeys = new Set((existing.items || []).map((it) => String(it.id || it.imdbId || it.tmdbId || it.title || '')));
              payload.items.forEach((it) => {
                const key = String(it.id || it.imdbId || it.tmdbId || it.title || '');
                if (!seenKeys.has(key)) {
                  if (!existing.items) existing.items = [];
                  existing.items.push(it);
                  seenKeys.add(key);
                }
              });
              if (existing.type !== itemType && existing.type !== 'mixed') {
                existing.type = 'mixed';
              }
              if (!existing.name || existing.name.endsWith('(Movies)') || existing.name.endsWith('(Shows)')) {
                existing.name = cleanName;
              }
            } else {
              extractedLists[slug] = {
                slug: slug,
                name: cleanName,
                type: itemType,
                items: [...payload.items],
                visibility: payload.visibility || 'public',
                shuffle: !!payload.shuffle,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              };
            }
          }
        } catch (err) {}
      } else if (u.startsWith('channel:v1:')) {
        try {
          const payload = JSON.parse(u.slice('channel:v1:'.length));
          if (payload && Array.isArray(payload.items)) {
            const chId = payload.channelId || e.id || (typeof generateChannelId === 'function' ? generateChannelId() : ('ch' + Date.now()));
            if (!payload.name) payload.name = e.name || 'Custom Channel';
            if (!payload.channelId) payload.channelId = chId;
            extractedChannels[chId] = payload;
          }
        } catch (err) {}
      }
    });
  });

  return { lists: extractedLists, channels: extractedChannels };
}

function rebuildCustomListsFromPreset(name, isSilent = false) {
  const map = loadPresetsMap();
  const preset = map[name];
  if (!preset) {
    if (!isSilent) {
      if (typeof showAppAlert === 'function') showAppAlert('Preset Not Found', 'Could not find preset "' + name + '".', false);
      else alert('Could not find preset "' + name + '".');
    }
    return { restoredLists: 0, restoredChannels: 0, listNames: [] };
  }

  const { lists: extractedLists, channels: extractedChannels } = extractCustomListsAndChannelsFromPreset(preset);
  const listSlugs = Object.keys(extractedLists);
  const channelIds = Object.keys(extractedChannels);

  if (!listSlugs.length && !channelIds.length) {
    if (!isSilent) {
      if (typeof showAppAlert === 'function') showAppAlert('No Custom Lists Found', 'Preset "' + name + '" does not contain any custom lists or channels.', false);
      else alert('Preset "' + name + '" does not contain any custom lists or channels.');
    }
    return { restoredLists: 0, restoredChannels: 0, listNames: [] };
  }

  // 1. Merge into local custom lists
  let localCustomListsMap = (typeof loadLocalCustomLists === 'function') ? loadLocalCustomLists() : {};
  let restoredListsCount = 0;
  const restoredListNames = [];
  let hasTrackingChanges = false;

  listSlugs.forEach((slug) => {
    const rebuilt = extractedLists[slug];
    if (!localCustomListsMap[slug]) {
      localCustomListsMap[slug] = rebuilt;
      restoredListsCount++;
      restoredListNames.push(rebuilt.name || slug);
      if (slug === 'watch-history' || slug === 'continue-watching' || slug === 'watchlist') {
        hasTrackingChanges = true;
      }
    } else {
      // Merge items into existing list
      const existing = localCustomListsMap[slug];
      const seenKeys = new Set((existing.items || []).map((it) => String(it.id || it.imdbId || it.tmdbId || it.title || '')));
      let addedItems = 0;
      (rebuilt.items || []).forEach((it) => {
        const key = String(it.id || it.imdbId || it.tmdbId || it.title || '');
        if (!seenKeys.has(key)) {
          if (!existing.items) existing.items = [];
          existing.items.push(it);
          seenKeys.add(key);
          addedItems++;
        }
      });
      if (addedItems > 0) {
        existing.updatedAt = Date.now();
        restoredListsCount++;
        restoredListNames.push((existing.name || slug) + ' (+' + addedItems + ' items)');
        if (slug === 'watch-history' || slug === 'continue-watching' || slug === 'watchlist') {
          hasTrackingChanges = true;
        }
      }
    }
  });

  if (typeof saveLocalCustomListsMap === 'function') {
    saveLocalCustomListsMap(localCustomListsMap);
  }
  if (localCustomListsMap['watch-history'] && Array.isArray(localCustomListsMap['watch-history'].items)) {
    window._rawWatchHistoryItems = localCustomListsMap['watch-history'].items;
    window._watchedItemIds = new Set((window._rawWatchHistoryItems || []).map((it) => String(it.id || it.imdbId || (it.tmdbId ? 'tmdb:' + it.tmdbId : '') || '')));
  }

  // 2. Merge into local channels
  let localChannelsMap = (typeof loadLocalChannels === 'function') ? loadLocalChannels() : {};
  let restoredChannelsCount = 0;

  channelIds.forEach((chId) => {
    if (!localChannelsMap[chId]) {
      localChannelsMap[chId] = extractedChannels[chId];
      restoredChannelsCount++;
    }
  });

  if (restoredChannelsCount > 0 && typeof saveLocalChannelsMap === 'function') {
    saveLocalChannelsMap(localChannelsMap);
  }

  if (hasTrackingChanges) {
    if (typeof pushTrackingSync === 'function') pushTrackingSync();
    if (typeof renderWatchHistoryGrid === 'function') renderWatchHistoryGrid();
  }

  // 3. Refresh UI & State
  if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard();
  if (typeof renderMyCustomListsList === 'function') renderMyCustomListsList();
  if (typeof renderChannelsList === 'function') renderChannelsList();
  if (typeof renderMyCreatedChannelsList === 'function') renderMyCreatedChannelsList();
  if (typeof renderChannelMergeList === 'function') renderChannelMergeList();
  if (typeof updateAllListAddButtons === 'function') updateAllListAddButtons();

  // 4. If signed in, push to sync
  if (typeof activeCreator !== 'undefined' && activeCreator) {
    if (typeof scheduleCreatorSyncSave === 'function') scheduleCreatorSyncSave();
    if (typeof pushCreatorSync === 'function') pushCreatorSync();
    if (typeof pushChannelsSync === 'function') pushChannelsSync();
  }

  if (!isSilent) {
    let msg = 'Restored ' + listSlugs.length + ' custom list' + (listSlugs.length === 1 ? '' : 's');
    if (channelIds.length) {
      msg += ' and ' + channelIds.length + ' channel' + (channelIds.length === 1 ? '' : 's');
    }
    msg += ' from preset "' + name + '" to your My Lists tab.';
    if (restoredListNames.length) {
      msg += '\\n\\n• ' + restoredListNames.join('\\n• ');
    }
    if (typeof showAppAlert === 'function') {
      showAppAlert('Custom Lists Rebuilt', msg, true);
    } else {
      alert(msg);
    }
  }

  return { restoredLists: listSlugs.length, restoredChannels: channelIds.length, listNames: restoredListNames };
}

function renderPresetsList() {
  const container = document.getElementById('presetsList');
  if (!container) return;
  const badge = document.getElementById('presetsCountBadge');
  const map = loadPresetsMap();
  const names = Object.keys(map).sort();
  if (badge) badge.textContent = names.length ? '(' + names.length + ' saved)' : '';
  if (!names.length) {
    container.innerHTML = '<p style="color:var(--muted); font-size:0.85rem; margin:8px 0;"><small>No saved presets yet.</small></p>';
    return;
  }
  container.innerHTML = names.map((n) => {
    const preset = map[n];
    const entries = Array.isArray(preset) ? preset : ((preset && preset.entries) || []);
    const count = entries.length;
    return '<div class="preset-card" data-preset="' + escapeAttr(n) + '">' +
      '<div class="preset-card-header">' +
        '<strong class="preset-card-title">' + escapeHtml(n) + '</strong> <small style="color:var(--muted);">(' + count + ' list' + (count === 1 ? '' : 's') + ')</small>' +
      '</div>' +
      '<div class="preset-actions-grid">' +
        '<button type="button" class="secondary lc-btn preset-load-btn">Load</button>' +
        '<button type="button" class="secondary lc-btn preset-restore-lists-btn" title="Rebuild and restore custom lists &amp; channels from this preset into My Lists">Restore Lists</button>' +
        '<button type="button" class="secondary lc-btn preset-share-btn">Share</button>' +
        '<button type="button" class="secondary lc-btn preset-download-btn">Download</button>' +
        '<button type="button" class="secondary lc-btn preset-delete-btn">Delete</button>' +
      '</div>' +
    '</div>';
  }).join('');
}
window.renderPresetsList = renderPresetsList;

const presetsListEl = document.getElementById('presetsList');
if (presetsListEl) {
  presetsListEl.addEventListener('click', (e) => {
    const row = e.target.closest('[data-preset]');
    if (!row) return;
    const name = row.getAttribute('data-preset');
    if (e.target.classList.contains('preset-load-btn')) loadPreset(name);
    else if (e.target.classList.contains('preset-restore-lists-btn')) rebuildCustomListsFromPreset(name, false);
    else if (e.target.classList.contains('preset-share-btn')) sharePreset(name);
    else if (e.target.classList.contains('preset-download-btn')) downloadPreset(name);
    else if (e.target.classList.contains('preset-delete-btn')) deletePreset(name);
  });
}

function loadPreset(name) {
  const map = loadPresetsMap();
  const preset = map[name];
  if (!preset) return;
  const entries = Array.isArray(preset) ? preset : ((preset && preset.entries) || []);
  document.getElementById('lists').innerHTML = '';
  entries.forEach((e) => addRow(e.name, e.url, e.type, e.enabled, e.group, e.id));
  renumber();
  checkAllDuplicateUrls();
  saveState();
  renderChannelMergeList();

  // Rebuild and restore custom lists & channels from this preset
  const result = rebuildCustomListsFromPreset(name, true);
  if (result.restoredLists > 0 || result.restoredChannels > 0) {
    let msg = 'Preset "' + name + '" loaded';
    const parts = [];
    if (result.restoredLists) parts.push(result.restoredLists + ' custom list' + (result.restoredLists === 1 ? '' : 's'));
    if (result.restoredChannels) parts.push(result.restoredChannels + ' channel' + (result.restoredChannels === 1 ? '' : 's'));
    if (parts.length) msg += ' & ' + parts.join(', ') + ' restored to My Lists';
    msg += ' \u2713';
    showAddedToast(msg);
  } else {
    showAddedToast('Preset "' + name + '" loaded \u2713');
  }
}

function sharePreset(name) {
  const map = loadPresetsMap();
  const preset = map[name];
  if (!preset) return;
  const entries = Array.isArray(preset) ? preset : ((preset && preset.entries) || []);
  const payload = { entries: entries };
  if (preset.customLists) payload.customLists = preset.customLists;
  if (preset.channels) payload.channels = preset.channels;
  const jsonStr = JSON.stringify(payload, null, 2);
  navigator.clipboard.writeText(jsonStr).then(() => {
    if (typeof showAppAlert === 'function') {
      showAppAlert('Preset Copied', '"' + name + '" copied to your clipboard as JSON -- paste it into the Backup/Restore box above (on this device or another) to import it.', true);
    } else {
      alert('"' + name + '" copied to your clipboard as JSON -- paste it into the Backup/Restore box above (on this device or another) to import it.');
    }
  }).catch(() => {
    prompt("Copy this preset's JSON:", jsonStr);
  });
}

function deletePreset(name) {
  const performDelete = () => {
    const map = loadPresetsMap();
    delete map[name];
    savePresetsMap(map);
    renderPresetsList();
    schedulePresetsSync();
    showAddedToast('Deleted preset "' + name + '".');
  };

  if (typeof showAppConfirm === 'function') {
    showAppConfirm(
      'Delete Preset',
      'Delete preset "' + name + '"? This will permanently remove this preset.',
      'Delete Preset',
      performDelete,
      true
    );
  } else {
    if (confirm('Delete preset "' + name + '"?')) {
      performDelete();
    }
  }
}

// --- file download/upload (Backup/Restore and My Presets) -------------------
function downloadJsonFile(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function readJsonFile(input, onParsed) {
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try {
      data = JSON.parse(reader.result);
    } catch (e) {
      if (typeof showAppAlert === 'function') showAppAlert('Invalid File', 'That file is not valid JSON.', false);
      else alert('That file is not valid JSON.');
      input.value = '';
      return;
    }
    onParsed(data, file);
    input.value = '';
  };
  reader.onerror = () => {
    if (typeof showAppAlert === 'function') showAppAlert('Read Error', 'Could not read that file.', false);
    else alert('Could not read that file.');
    input.value = '';
  };
  reader.readAsText(file);
}

function downloadConfigJson() {
  const payload = buildFullBackupPayload();
  downloadJsonFile('my-lists-full-backup.json', payload);
}

function uploadConfigFile(input) {
  readJsonFile(input, (data) => applyImportedConfig(data));
}

function downloadPreset(name) {
  const map = loadPresetsMap();
  const preset = map[name];
  if (!preset) return;
  const entries = Array.isArray(preset) ? preset : ((preset && preset.entries) || []);
  const payload = { entries: entries };
  if (preset.customLists) payload.customLists = preset.customLists;
  if (preset.channels) payload.channels = preset.channels;
  downloadJsonFile((slugify(name) || 'preset') + '.json', payload);
}

function uploadPresetFile(input) {
  readJsonFile(input, (data, file) => {
    if (!data || (!Array.isArray(data.entries) && !Array.isArray(data))) {
      if (typeof showAppAlert === 'function') showAppAlert('Invalid Preset', 'That file does not look like a preset -- expected an "entries" array.', false);
      else alert('That file does not look like a preset -- expected an "entries" array.');
      return;
    }
    const suggested = (file.name || 'Preset').replace(/\.json$/i, '');
    const name = (prompt('Save this preset as:', suggested) || '').trim();
    if (!name) return;
    const entries = Array.isArray(data) ? data : (data.entries || []);
    const map = loadPresetsMap();
    map[name] = {
      entries: entries,
      ...(data.customLists ? { customLists: data.customLists } : {}),
      ...(data.channels ? { channels: data.channels } : {}),
    };
    savePresetsMap(map);
    renderPresetsList();
    schedulePresetsSync();
    const res = rebuildCustomListsFromPreset(name, true);
    if (res.restoredLists > 0 || res.restoredChannels > 0) {
      showAddedToast('Uploaded preset "' + name + '" & restored custom lists \u2713');
    } else {
      showAddedToast('Uploaded preset "' + name + '" \u2713');
    }
  });
}

// --- Universal & Platform Export (CSV / JSON) -------------------------------
function downloadCsvFile(filename, csvString) {
  const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function escapeCsvCell(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  const lf = String.fromCharCode(10);
  const cr = String.fromCharCode(13);
  if (str.indexOf(',') !== -1 || str.indexOf('"') !== -1 || str.indexOf(lf) !== -1 || str.indexOf(cr) !== -1) {
    return '"' + str.split('"').join('""') + '"';
  }
  return str;
}

function extractItemMetadata(it) {
  const title = it.title || it.name || it.showTitle || '';
  const year = it.year || '';
  let type = it.type || (it.seasonNum != null ? 'episode' : (it.showId ? 'series' : 'movie'));
  
  let imdbId = '';
  if (it.imdbId) imdbId = it.imdbId;
  else if (it.imdb_id) imdbId = it.imdb_id;
  else if (typeof it.id === 'string' && it.id.startsWith('tt')) imdbId = it.id;
  else if (typeof it.showId === 'string' && it.showId.startsWith('tt')) imdbId = it.showId;

  let tmdbId = '';
  if (it.tmdbId) tmdbId = String(it.tmdbId);
  else if (it.tmdb_id) tmdbId = String(it.tmdb_id);
  else if (typeof it.id === 'string' && it.id.startsWith('tmdb:')) tmdbId = it.id.slice(5);
  else if (typeof it.id === 'number' || (typeof it.id === 'string' && new RegExp('^[0-9]+$').test(it.id))) tmdbId = String(it.id);
  else if (typeof it.showId === 'string' && it.showId.startsWith('tmdb:')) tmdbId = it.showId.slice(5);

  const season = (it.seasonNum != null) ? it.seasonNum : ((it.season != null) ? it.season : '');
  const episode = (it.episodeNum != null) ? it.episodeNum : ((it.episode != null) ? it.episode : ((it.epNum != null) ? it.epNum : ''));

  let watchedAtIso = '';
  let watchedDateOnly = '';
  if (it.watchedAt || it.watched_at || it.date) {
    const rawDate = it.watchedAt || it.watched_at || it.date;
    try {
      const d = new Date(typeof rawDate === 'number' ? rawDate : rawDate);
      if (!isNaN(d.getTime())) {
        watchedAtIso = d.toISOString();
        watchedDateOnly = watchedAtIso.split('T')[0];
      }
    } catch (e) {}
  }

  return { title, year, type, imdbId, tmdbId, season, episode, watchedAtIso, watchedDateOnly };
}

function exportDataToCsv(target, format) {
  const map = (typeof loadLocalCustomLists === 'function') ? loadLocalCustomLists() : {};
  let rows = [];
  let filename = 'export.csv';

  if (target === 'watch-history') {
    const historyList = map['watch-history'];
    const items = (historyList && Array.isArray(historyList.items)) ? historyList.items : [];
    if (!items.length) {
      if (typeof showAppAlert === 'function') showAppAlert('Empty Watch History', 'Your Watch History is currently empty.', false);
      else alert('Your Watch History is currently empty.');
      return;
    }

    if (format === 'letterboxd') {
      filename = 'watch_history_letterboxd.csv';
      rows.push(['Title', 'Year', 'WatchedDate', 'imdbID', 'tmdbID'].join(','));
      items.forEach((it) => {
        const meta = extractItemMetadata(it);
        const exportTitle = it.showTitle || meta.title;
        rows.push([
          escapeCsvCell(exportTitle),
          escapeCsvCell(meta.year),
          escapeCsvCell(meta.watchedDateOnly || meta.watchedAtIso),
          escapeCsvCell(meta.imdbId),
          escapeCsvCell(meta.tmdbId)
        ].join(','));
      });
    } else if (format === 'trakt') {
      filename = 'watch_history_trakt.csv';
      rows.push(['Title', 'Year', 'Type', 'IMDb ID', 'TMDB ID', 'Season', 'Episode', 'Watched At'].join(','));
      items.forEach((it) => {
        const meta = extractItemMetadata(it);
        const exportTitle = it.showTitle ? (it.showTitle + (meta.title ? ' — ' + meta.title : '')) : meta.title;
        rows.push([
          escapeCsvCell(exportTitle),
          escapeCsvCell(meta.year),
          escapeCsvCell(meta.type),
          escapeCsvCell(meta.imdbId),
          escapeCsvCell(meta.tmdbId),
          escapeCsvCell(meta.season),
          escapeCsvCell(meta.episode),
          escapeCsvCell(meta.watchedAtIso)
        ].join(','));
      });
    } else {
      filename = 'watch_history_universal.csv';
      rows.push(['List Name', 'Title', 'Year', 'Type', 'IMDb ID', 'TMDB ID', 'Season', 'Episode', 'Watched At'].join(','));
      items.forEach((it) => {
        const meta = extractItemMetadata(it);
        rows.push([
          escapeCsvCell('Watch History'),
          escapeCsvCell(meta.title),
          escapeCsvCell(meta.year),
          escapeCsvCell(meta.type),
          escapeCsvCell(meta.imdbId),
          escapeCsvCell(meta.tmdbId),
          escapeCsvCell(meta.season),
          escapeCsvCell(meta.episode),
          escapeCsvCell(meta.watchedAtIso)
        ].join(','));
      });
    }
  } else if (target === 'all-custom-lists') {
    filename = 'all_lists_universal.csv';
    rows.push(['List Name', 'Title', 'Year', 'Type', 'IMDb ID', 'TMDB ID', 'Season', 'Episode', 'Watched At'].join(','));
    let totalItems = 0;
    Object.keys(map).forEach((k) => {
      const list = map[k];
      if (list && Array.isArray(list.items) && list.items.length) {
        const listName = list.name || list.slug || k;
        list.items.forEach((it) => {
          totalItems++;
          const meta = extractItemMetadata(it);
          rows.push([
            escapeCsvCell(listName),
            escapeCsvCell(meta.title),
            escapeCsvCell(meta.year),
            escapeCsvCell(meta.type),
            escapeCsvCell(meta.imdbId),
            escapeCsvCell(meta.tmdbId),
            escapeCsvCell(meta.season),
            escapeCsvCell(meta.episode),
            escapeCsvCell(meta.watchedAtIso)
          ].join(','));
        });
      }
    });
    if (totalItems === 0) {
      if (typeof showAppAlert === 'function') showAppAlert('No Saved Lists', 'You do not have any saved list items to export.', false);
      else alert('You do not have any saved list items to export.');
      return;
    }
  }

  downloadCsvFile(filename, rows.join(String.fromCharCode(10)));
}

function exportDataToJson(target) {
  const map = (typeof loadLocalCustomLists === 'function') ? loadLocalCustomLists() : {};
  const entries = (typeof collectEntries === 'function') ? collectEntries() : [];
  const keys = (typeof collectKeys === 'function') ? collectKeys() : {};

  const payload = {
    exportedAt: new Date().toISOString(),
    addonVersion: 'My Lists Addon Beta',
    configuredCatalogs: entries,
    apiKeys: {
      tmdbKey: keys.tmdbKey || null,
      traktUsername: keys.traktUsername || null,
      simklUsername: keys.simklUsername || null
    },
    watchHistory: map['watch-history'] ? (map['watch-history'].items || []) : [],
    continueWatching: map['continue-watching'] ? (map['continue-watching'].items || []) : [],
    customLists: Object.keys(map)
      .filter((k) => k !== 'watch-history' && k !== 'continue-watching')
      .map((k) => map[k])
  };

  downloadJsonFile('my-lists-full-library.json', payload);
}

// --- browser-storage persistence -------------------------------------------
// Keeps whatever the person has added/removed/toggled so a page refresh
// doesn't lose their in-progress list or entered API keys. The stored state
// is only used in the browser; it is never uploaded anywhere.
const STORAGE_KEY = 'myListAddon:state';
let lastGeneratedConfigHash = null;

function computeConfigStateHash() {
  try {
    const entries = collectEntries();
    const keys = collectKeys();
    return JSON.stringify({
      entries: entries.map(e => ({ name: e.name, url: e.url, type: e.type, group: e.group })),
      keys: {
        tmdbKey: keys.tmdbKey,
        mdblistKey: keys.mdblistKey,
        mdblistAccessToken: keys.mdblistAccessToken,
        traktKey: keys.traktKey,
        traktUsername: keys.traktUsername,
        traktAccessToken: keys.traktAccessToken,
        simklKey: keys.simklKey,
        simklAccessToken: keys.simklAccessToken,
        simklUsername: keys.simklUsername,
        region: keys.region,
        hideNonDigitalReleases: keys.hideNonDigitalReleases,
        shuffleShelves: keys.shuffleShelves,
        shuffleItems: keys.shuffleItems,
        track: !!keys.track,
      }
    });
  } catch (e) {
    return null;
  }
}

function checkUnsavedInstallLink() {
  if (!lastGeneratedConfigHash) return;
  const currentHash = computeConfigStateHash();
  const banner = document.getElementById('unsavedInstallBanner');
  const text = document.getElementById('unsavedInstallText');
  const btn = document.getElementById('unsavedInstallBtn');
  if (!banner || !text || !btn) return;
  
  if (currentHash !== lastGeneratedConfigHash) {
    text.textContent = 'Unsaved changes to install link';
    btn.style.display = 'inline-flex';
    banner.classList.add('show');
  } else {
    banner.classList.remove('show');
  }
}

async function updateInstallLinkFromBanner() {
  const btn = document.getElementById('unsavedInstallBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Updating\u2026';
  }
  await generate();
  if (btn) {
    btn.disabled = false;
    btn.textContent = 'Update Link';
  }
}

function saveState() {
  if (suppressSave) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      entries: collectEntries(),
      keys: collectKeys(),
      shuffleShelves: document.getElementById('shuffleShelvesCheckbox') ? document.getElementById('shuffleShelvesCheckbox').checked : false,
      shuffleItems: document.getElementById('shuffleItemsCheckbox') ? document.getElementById('shuffleItemsCheckbox').checked : false,
    }));
  } catch (e) {
    // localStorage unavailable (private browsing, disabled, etc.) — fine,
    // just means refreshes won't be remembered.
  }
  if (typeof updateAllListAddButtons === 'function') updateAllListAddButtons();
  scheduleCreatorSyncSave();
  checkUnsavedInstallLink();
}

function loadSavedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      keys: parsed.keys && typeof parsed.keys === 'object' ? parsed.keys : {},
      shuffleShelves: !!parsed.shuffleShelves,
      shuffleItems: !!parsed.shuffleItems,
    };
  } catch (e) {
    return null;
  }
}

function copyLink(url) {
  navigator.clipboard.writeText(url).then(() => {
    const urlBtn = document.getElementById('copyUrlBtn');
    if (urlBtn) {
      const oldUrlHtml = urlBtn.innerHTML;
      urlBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg> <span>Copied!</span>';
      urlBtn.style.background = 'var(--success)';
      urlBtn.style.color = '#ffffff';
      urlBtn.style.borderColor = 'var(--success)';
      setTimeout(() => {
        urlBtn.innerHTML = oldUrlHtml;
        urlBtn.style.background = '';
        urlBtn.style.color = '';
        urlBtn.style.borderColor = '';
      }, 1800);
    }
  }).catch(() => {
    const display = document.getElementById('manifestLinkDisplay');
    if (window.getSelection && display) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(display);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    alert('Manifest URL: ' + url);
  });
}

function openInNuvio(installUrl, e) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(installUrl).catch(() => {});
  }
}

async function generate() {
  const entries = collectEntries();
  if (!entries.length) { alert('Add at least one list.'); return; }
  const keys = collectKeys();

  const box = document.getElementById('result');
  box.style.display = 'block';
  box.innerHTML = '<div class="install-result-card" style="align-items:center; justify-content:center; padding:24px; color:var(--muted);"><span class="spinner" style="display:inline-block; width:20px; height:20px; border:2px solid var(--border); border-top-color:var(--accent); border-radius:50%; animation:spin 0.8s linear infinite; margin-right:8px; vertical-align:middle;"></span> Generating install link\u2026</div>';

  // Prefer a short, KV-backed id (see /api/save) so the install URL stays a
  // fixed short length no matter how many lists are configured. If this
  // Worker has no CONFIGS KV namespace bound, fall back to the old
  // self-contained base64 link.
  let config = null;
  try {
    const res = await fetch(ORIGIN + '/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entries,
        tmdbKey: keys.tmdbKey,
        mdblistKey: keys.mdblistKey,
        mdblistAccessToken: keys.mdblistAccessToken,
        traktKey: keys.traktKey,
        traktUsername: keys.traktUsername,
        traktAccessToken: keys.traktAccessToken,
        simklKey: keys.simklKey,
        simklAccessToken: keys.simklAccessToken,
        simklUsername: keys.simklUsername,
        track: keys.track,
        trackCreatorName: keys.trackCreatorName,
        trackCreatorKey: keys.trackCreatorKey,
        shuffleShelves: keys.shuffleShelves,
        shuffleItems: keys.shuffleItems,
        region: keys.region,
        hideNonDigitalReleases: keys.hideNonDigitalReleases,
      }),
    });
    const data = await res.json();
    if (data.ok) config = data.id;
  } catch (e) {
    // network error — fall through to the client-side link below
  }

  let sizeWarning = '';
  if (!config) {
    config = buildConfig(entries, keys);
    // Row count alone misses this: a single Channel with a few dozen
    // episodes can make the encoded config huge even with just one or two
    // rows total, so this checks the actual encoded length instead.
    if (config.length > 4000) {
      sizeWarning = '<p class="testresult err">\u26a0 This link encodes everything directly into the URL (no server-side storage is set up on this Worker), so it\\\'s long and may fail to install in apps with URL-length limits \u2014 including Wako. If you\\\'re the Worker owner, binding a KV namespace named "CONFIGS" fixes this by giving links a short id instead.</p>';
    }
  }

  const installUrl = ORIGIN + '/' + config + '/manifest.json';
  // A group breakdown alongside the plain install-count beacon -- each
  // row's own .group ("MDBList Charts", "Custom Lists", "Channels", etc.)
  // is already a meaningful "what kind of source is this" label, no need
  // for a separate classification step. Tied to install-link generation
  // specifically rather than every add/remove click, since "ended up in a
  // real install" is a more meaningful signal than "was clicked once,
  // maybe removed a second later" -- and it means this doesn't need
  // touching dozens of individual Quick Add button handlers.
  const groupCounts = {};
  entries.forEach((e) => {
    const g = e.group || 'Custom';
    groupCounts[g] = (groupCounts[g] || 0) + 1;
  });
  fetch(ORIGIN + '/api/track-install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groups: groupCounts }),
  }).catch(() => {});

  box.innerHTML = \`
    <div class="install-result-card">
      <div class="install-result-header">
        <div class="install-result-badge">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
          <span>Add-on Ready to Install</span>
        </div>
        <span class="install-result-sub">\${entries.length} catalog\${entries.length === 1 ? '' : 's'} configured</span>
      </div>

      \${sizeWarning}

      <div class="install-url-container">
        <div class="install-url-header">
          <div class="install-url-label">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
            <span>Manifest Link</span>
          </div>
          <button type="button" class="install-url-copy-btn" id="copyUrlBtn" onclick="copyLink('\${installUrl}')" title="Copy manifest link">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            <span>Copy Link</span>
          </button>
        </div>
        <div class="install-url-box" id="manifestLinkDisplay" onclick="copyLink('\${installUrl}')" title="Click to copy">\${installUrl}</div>
      </div>

      <div class="install-hint-box">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; margin-top:2px;"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
        <div>
          <span>To install this add-on, copy the manifest link above and paste it into:</span>
          <div class="install-hint-steps">
            <span>&bull; <strong>Stremio</strong> &rarr; Addons &rarr; Community &rarr; Paste URL</span>
            <span>&bull; <strong>Nuvio</strong> &rarr; Settings &rarr; Content &amp; Discovery &rarr; Addons</span>
            <span>&bull; <strong>Wako</strong> &rarr; Settings &rarr; Add-ons &rarr; Install from URL</span>
          </div>
        </div>
      </div>
    </div>\`;
  // The mobile sticky CTA bar can be tapped from anywhere on a long page of
  // rows, so bring the result into view rather than leaving it rendered
  // off-screen above the fold the person's currently scrolled past.
  lastGeneratedConfigHash = computeConfigStateHash();
  const banner = document.getElementById('unsavedInstallBanner');
  if (banner) banner.classList.remove('show');
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// pre-fill
suppressSave = true;
// serverEntries / serverEntriesAreDefaults / serverShuffleShelves /
// serverShuffleItems are declared in the per-request preamble at the top of
// this script section (16_client-row-core.js). They are resolved from the
// install or configure link, so they differ per request and cannot live in
// the shared cacheable bundle. They are ordinary script-scoped bindings and
// read here exactly as they did when declared on this line.
if (serverEntries.length && !serverEntriesAreDefaults) {
  // Opened via a real install/configure link with actual resolved entries
  // -- this is the source of truth.
  serverEntries.forEach(e => addRow(e.name, e.url, e.type, e.enabled, e.group, e.id));
  // Was a second server-side injection of isConfigureMode. IS_CONFIGURE
  // from the preamble is the same value, and using it keeps this file free
  // of anything that varies per request.
  if (IS_CONFIGURE) {
    setTimeout(() => { lastGeneratedConfigHash = computeConfigStateHash(); }, 0);
  }
  if (document.getElementById('shuffleShelvesCheckbox')) {
    document.getElementById('shuffleShelvesCheckbox').checked = serverShuffleShelves;
  }
  if (document.getElementById('shuffleItemsCheckbox')) {
    document.getElementById('shuffleItemsCheckbox').checked = serverShuffleItems;
  }
  // Region has no equivalent "source of truth from the URL" concept the
  // way entries/shuffle do here -- the region <select>'s server-rendered
  // selected value only reflects whatever was in the saved config the
  // *last* time this install link's config was generated/regenerated
  // (see the note on stale install links elsewhere in this codebase:
  // redeploying or changing a setting doesn't retroactively touch an
  // already-generated link's stored config). If the person picked a
  // region in this same browser more recently than that, localStorage
  // has the truer answer -- apply it over the server-rendered default so
  // the dropdown at least reflects their last real choice, even though
  // making that choice actually take effect for catalog fetching still
  // needs a Save/Update to regenerate the link, same as any other change.
  const savedRegionForConfigView = (function() {
    try { return localStorage.getItem('myListAddon:region'); } catch (e) { return null; }
  })();
  if (savedRegionForConfigView) {
    const regionEl = document.getElementById('regionSelect');
    if (regionEl) regionEl.value = savedRegionForConfigView;
  }
  // hideNonDigitalReleases: same localStorage-override pattern as region
  // above -- if the person toggled this checkbox in this browser more
  // recently than the last time they regenerated their install link,
  // honour their local choice over the server-rendered default.
  const savedHideNonDigital = (function() {
    try { return localStorage.getItem('myListAddon:hideNonDigitalReleases'); } catch (e) { return null; }
  })();
  if (savedHideNonDigital !== null) {
    const cb = document.getElementById('hideNonDigitalReleasesCheckbox');
    if (cb) cb.checked = savedHideNonDigital === '1';
  }
} else {
  // Fresh visit to the plain builder page — restore whatever was left off
  // last time, if anything was saved. Falls through to the server's
  // first-time-visitor demo entries (still available in serverEntries even
  // though serverEntriesAreDefaults kept them from being trusted as this
  // browser's actual saved state above) only when there's truly nothing in
  // localStorage yet -- a genuinely first-time visitor.
  const saved = loadSavedState();
  if (saved && Array.isArray(saved.entries)) {
    saved.entries.forEach(e => addRow(e.name, e.url, e.type, e.enabled, e.group, e.id));
  } else if (!saved && serverEntries.length) {
    serverEntries.forEach(e => addRow(e.name, e.url, e.type, e.enabled, e.group, e.id));
  }
  if (saved && document.getElementById('shuffleShelvesCheckbox')) {
    document.getElementById('shuffleShelvesCheckbox').checked = !!saved.shuffleShelves;
  }
  if (saved && document.getElementById('shuffleItemsCheckbox')) {
    document.getElementById('shuffleItemsCheckbox').checked = !!saved.shuffleItems;
  }
  if (saved && saved.keys && document.getElementById('hideNonDigitalReleasesCheckbox')) {
    document.getElementById('hideNonDigitalReleasesCheckbox').checked = !!saved.keys.hideNonDigitalReleases;
  }
  const tmdbDisc = localStorage.getItem('myListAddon:tmdbDisconnected') === 'true';
  const mdblistDisc = localStorage.getItem('myListAddon:mdblistDisconnected') === 'true';
  const traktDisc = localStorage.getItem('myListAddon:traktDisconnected') === 'true';
  const simklDisc = localStorage.getItem('myListAddon:simklDisconnected') === 'true';

  if (!mdblistDisc && saved && saved.keys && saved.keys.mdblistKey) {
    const el = document.getElementById('mdblistKeyInput');
    if (el) el.value = saved.keys.mdblistKey;
  }
  if (!mdblistDisc && saved && saved.keys && saved.keys.mdblistAccessToken) {
    mdblistAccessToken = saved.keys.mdblistAccessToken;
  }
  if (!traktDisc && saved && saved.keys && saved.keys.traktKey) {
    const el = document.getElementById('traktKeyInput');
    if (el) el.value = saved.keys.traktKey;
  }
  if (!traktDisc && saved && saved.keys && saved.keys.traktUsername) {
    const el = document.getElementById('traktUsernameInput');
    if (el) el.value = saved.keys.traktUsername;
  }
  if (!traktDisc && saved && saved.keys && saved.keys.traktAccessToken) {
    traktAccessToken = saved.keys.traktAccessToken;
  }
  if (!simklDisc && saved && saved.keys && saved.keys.simklKey) {
    const el = document.getElementById('simklKeyInput');
    if (el) el.value = saved.keys.simklKey;
  }
  if (!simklDisc && saved && saved.keys && saved.keys.simklAccessToken) {
    simklAccessToken = saved.keys.simklAccessToken;
  }
  if (!simklDisc && saved && saved.keys && saved.keys.simklUsername) {
    simklUsername = saved.keys.simklUsername;
  }
  // Region has no separate localStorage:XDisconnected flag to check
  // against (it's not an external account), and it's saved directly under
  // 'myListAddon:region' by the <select>'s own onchange handler as well as
  // inside the collectKeys() blob saveState() writes on every change --
  // check both, since a person who never touched the dropdown after this
  // feature shipped will have it in neither, and that's fine (this whole
  // block only runs on a fresh visit with no config in the URL, so falling
  // through to the server-rendered default of "US" is correct for them).
  const savedRegion = (saved && saved.keys && saved.keys.region) || localStorage.getItem('myListAddon:region');
  if (savedRegion) {
    const el = document.getElementById('regionSelect');
    if (el) el.value = savedRegion;
  }
}
if (localStorage.getItem('myListAddon:mdblistDisconnected') === 'true') {
  mdblistAccessToken = '';
  try { window.mdblistAccessToken = ''; } catch (e) {}
  const el = document.getElementById('mdblistKeyInput');
  if (el) el.value = '';
} else if (!mdblistAccessToken) {
  const savedForMdblist = loadSavedState();
  if (savedForMdblist && savedForMdblist.keys && savedForMdblist.keys.mdblistAccessToken) {
    mdblistAccessToken = savedForMdblist.keys.mdblistAccessToken;
  } else {
    try { mdblistAccessToken = localStorage.getItem('myListAddon:mdblistAccessToken') || ''; } catch (e) {}
  }
}

if (localStorage.getItem('myListAddon:traktDisconnected') === 'true') {
  traktAccessToken = '';
  try { window.traktAccessToken = ''; } catch (e) {}
  if (typeof activeTraktToken !== 'undefined') activeTraktToken = null;
  const tk = document.getElementById('traktKeyInput');
  if (tk) tk.value = '';
  const tu = document.getElementById('traktUsernameInput');
  if (tu) tu.value = '';
} else if (!traktAccessToken) {
  const savedForTrakt = loadSavedState();
  if (savedForTrakt && savedForTrakt.keys && savedForTrakt.keys.traktAccessToken) {
    traktAccessToken = savedForTrakt.keys.traktAccessToken;
  } else {
    try { traktAccessToken = localStorage.getItem('myListAddon:traktAccessToken') || ''; } catch (e) {}
  }
}

if (localStorage.getItem('myListAddon:simklDisconnected') === 'true') {
  simklAccessToken = '';
  try { window.simklAccessToken = ''; } catch (e) {}
  simklUsername = '';
  try { window.simklUsername = ''; } catch (e) {}
  const sk = document.getElementById('simklKeyInput');
  if (sk) sk.value = '';
} else if (!simklAccessToken) {
  const savedForSimkl = loadSavedState();
  if (savedForSimkl && savedForSimkl.keys && savedForSimkl.keys.simklAccessToken) {
    simklAccessToken = savedForSimkl.keys.simklAccessToken;
  } else {
    try { simklAccessToken = localStorage.getItem('myListAddon:simklAccessToken') || ''; } catch (e) {}
  }
}

if (localStorage.getItem('myListAddon:tmdbDisconnected') === 'true') {
  tmdbSessionId = '';
  try { window.tmdbSessionId = ''; } catch (e) {}
  tmdbAccountId = '';
  try { window.tmdbAccountId = ''; } catch (e) {}
  tmdbUsername = '';
  try { window.tmdbUsername = ''; } catch (e) {}
  const tmk = document.getElementById('tmdbKeyInput');
  if (tmk) tmk.value = '';
}
suppressSave = false;
renumber();
renderPresetsList();
renderChannelMergeList();
scheduleMyMdblistListsRefresh();
scheduleMyTraktListsRefresh();
renderCreatorProfileBar();
renderAccountKeySection();
if (typeof renderWatchlistPreferencesSection === 'function') renderWatchlistPreferencesSection();
if (typeof renderHiddenListsSettingsSection === 'function') renderHiddenListsSettingsSection();
renderTrackPlaybackSection();
renderCreatorDashboard();
if (typeof pickUpMdblistTokenFromUrl === 'function') pickUpMdblistTokenFromUrl();
if (typeof renderMdblistConnectStatus === 'function') renderMdblistConnectStatus();
pickUpTraktTokenFromUrl();
renderTraktConnectStatus();
if (typeof pickUpTmdbTokenFromUrl === 'function') pickUpTmdbTokenFromUrl();
if (typeof renderTmdbConnectStatus === 'function') renderTmdbConnectStatus();
if (typeof scheduleMyTmdbListsRefresh === 'function') scheduleMyTmdbListsRefresh();
if (typeof pickUpSimklTokenFromUrl === 'function') pickUpSimklTokenFromUrl();
if (typeof renderSimklConnectStatus === 'function') renderSimklConnectStatus();
if (typeof scheduleMySimklListsRefresh === 'function') scheduleMySimklListsRefresh();
if (typeof populateImportTargetLists === 'function') populateImportTargetLists();
document.querySelectorAll('details.panel.collapsible').forEach((d) => {
  d.addEventListener('toggle', scheduleCreatorSyncSave);
});
restoreActiveTab();
tryAutoRestoreCreatorProfile();

// Deep-link support for the list-details/item-details full pages (see
// openListDetailsPage in 23_client-list-management.js and
// openItemDetailsModal in 19_client-search-and-likes.js) -- both push a
// real #/list?... or #/item?... URL when opened, so a bookmark, shared
// link, or a plain page refresh lands back on that exact page instead of
// always falling back to whatever tab was last active.
(function handleInitialDeepLink() {
  if (SERVER_DEEP_LINK_LIST) {
    openListDetailsPage(SERVER_DEEP_LINK_LIST.name, SERVER_DEEP_LINK_LIST.type, SERVER_DEEP_LINK_LIST.url, SERVER_DEEP_LINK_LIST, { skipPushState: true });
    return;
  }
  const path = location.pathname || '';
  const mdbMatch = path.match(new RegExp('^/lists/mdblist/([^/]+)/([^/]+)', 'i'));
  if (mdbMatch) {
    const listUrl = 'https://mdblist.com/lists/' + mdbMatch[1] + '/' + mdbMatch[2];
    const name = typeof deslugify === 'function' ? deslugify(mdbMatch[2]) : mdbMatch[2];
    openListDetailsPage(name, 'movie', listUrl, null, { skipPushState: true });
    return;
  }
  if (path.toLowerCase() === '/lists/mdblist/watchlist') {
    openListDetailsPage('MDBList Watchlist', 'movie', 'mdblist:watchlist', null, { skipPushState: true });
    return;
  }
  if (path.toLowerCase() === '/lists/mdblist/history') {
    openListDetailsPage('MDBList Watch History', 'movie', 'mdblist:history', null, { skipPushState: true });
    return;
  }
  const traktMatch = path.match(new RegExp('^/lists/trakt/([^/]+)/([^/]+)', 'i'));
  if (traktMatch) {
    const listUrl = 'https://trakt.tv/users/' + traktMatch[1] + '/lists/' + traktMatch[2];
    const name = typeof deslugify === 'function' ? deslugify(traktMatch[2]) : traktMatch[2];
    openListDetailsPage(name, 'movie', listUrl, null, { skipPushState: true });
    return;
  }
  if (path.toLowerCase() === '/lists/trakt/watchlist') {
    openListDetailsPage('Trakt Watchlist', 'movie', 'trakt:watchlist', null, { skipPushState: true });
    return;
  }
  if (path.toLowerCase() === '/lists/trakt/history') {
    openListDetailsPage('Trakt Watch History', 'movie', 'trakt:history', null, { skipPushState: true });
    return;
  }
  if (path.toLowerCase() === '/lists/trakt/collection') {
    openListDetailsPage('Trakt Collection', 'movie', 'trakt:collection', null, { skipPushState: true });
    return;
  }
  const curatedMatch = path.match(new RegExp('^/lists/curated/([^/]+)', 'i'));
  if (curatedMatch) {
    const slug = curatedMatch[1];
    const isShow = slug.includes('show') || slug.includes('tv') || slug.includes('series');
    const title = isShow ? 'Recommended Shows' : 'Recommended Movies';
    const listUrl = 'custom:curated:' + slug;
    openListDetailsPage(title, isShow ? 'series' : 'movie', listUrl, null, { skipPushState: true });
    return;
  }
  if (path.toLowerCase() === '/lists/continue-watching' || path.toLowerCase() === '/lists/continue_watching') {
    openListDetailsPage('Continue Watching', 'series', 'autotrack:continue-watching', null, { skipPushState: true });
    return;
  }
  if (path.toLowerCase() === '/lists/watch-history' || path.toLowerCase() === '/lists/watch_history') {
    openListDetailsPage('Watch History', 'movie', 'autotrack:watch-history', null, { skipPushState: true });
    return;
  }
  if (path.toLowerCase() === '/lists/watchlist') {
    openListDetailsPage('Watchlist', 'mixed', 'autotrack:watchlist', null, { skipPushState: true });
    return;
  }
  if (path.toLowerCase() === '/lists/tmdb/watchlist') {
    openListDetailsPage('TMDB Watchlist', 'movie', 'tmdb:watchlist', null, { skipPushState: true });
    return;
  }
  if (path.toLowerCase() === '/lists/tmdb/favorites') {
    openListDetailsPage('TMDB Favorites', 'movie', 'tmdb:favorites', null, { skipPushState: true });
    return;
  }
  if (path.toLowerCase() === '/lists/new-movies') {
    openListDetailsPage('New Releases', 'movie', 'tmdb:chart:new_movies', null, { skipPushState: true });
    return;
  }
  if (path.toLowerCase() === '/lists/new-shows') {
    openListDetailsPage('New Releases', 'series', 'tmdb:chart:new_shows', null, { skipPushState: true });
    return;
  }
  const tmdbCollMatch = path.match(new RegExp('^/lists/tmdb/collection/([0-9]+)(?:-([a-z0-9_-]+))?', 'i'));
  if (tmdbCollMatch) {
    const listUrl = 'https://www.themoviedb.org/collection/' + tmdbCollMatch[1];
    const name = tmdbCollMatch[2] ? (typeof deslugify === 'function' ? deslugify(tmdbCollMatch[2]) : tmdbCollMatch[2]) : ('TMDB Collection ' + tmdbCollMatch[1]);
    openListDetailsPage(name, 'movie', listUrl, null, { skipPushState: true });
    return;
  }
  const tmdbMatch = path.match(new RegExp('^/lists/tmdb/([0-9]+)(?:-([a-z0-9_-]+))?', 'i'));
  if (tmdbMatch) {
    const listUrl = 'https://www.themoviedb.org/list/' + tmdbMatch[1];
    const name = tmdbMatch[2] ? (typeof deslugify === 'function' ? deslugify(tmdbMatch[2]) : tmdbMatch[2]) : ('TMDB List ' + tmdbMatch[1]);
    openListDetailsPage(name, 'movie', listUrl, null, { skipPushState: true });
    return;
  }

  // Simkl lists deep linking
  const simklMatch = path.match(new RegExp('^/lists/simkl/([a-z0-9_-]+)', 'i'));
  if (simklMatch) {
    const subSlug = simklMatch[1].toLowerCase();
    if (subSlug === 'completed-movies') openListDetailsPage('Simkl Completed (Movies)', 'movie', 'simkl:completed:movies', null, { skipPushState: true });
    else if (subSlug === 'completed-shows') openListDetailsPage('Simkl Completed (Shows)', 'series', 'simkl:completed:shows', null, { skipPushState: true });
    else if (subSlug === 'watching-movies') openListDetailsPage('Simkl Watching (Movies)', 'movie', 'simkl:watching:movies', null, { skipPushState: true });
    else if (subSlug === 'watching-shows') openListDetailsPage('Simkl Watching (Shows)', 'series', 'simkl:watching:shows', null, { skipPushState: true });
    else if (subSlug === 'plantowatch-movies') openListDetailsPage('Simkl Plan to Watch (Movies)', 'movie', 'simkl:plantowatch:movies', null, { skipPushState: true });
    else if (subSlug === 'plantowatch-shows') openListDetailsPage('Simkl Plan to Watch (Shows)', 'series', 'simkl:plantowatch:shows', null, { skipPushState: true });
    else if (subSlug === 'hold-movies') openListDetailsPage('Simkl On Hold (Movies)', 'movie', 'simkl:hold:movies', null, { skipPushState: true });
    else if (subSlug === 'hold-shows') openListDetailsPage('Simkl On Hold (Shows)', 'series', 'simkl:hold:shows', null, { skipPushState: true });
    else if (subSlug === 'dropped-movies') openListDetailsPage('Simkl Not Interesting (Movies)', 'movie', 'simkl:dropped:movies', null, { skipPushState: true });
    else if (subSlug === 'dropped-shows') openListDetailsPage('Simkl Not Interesting (Shows)', 'series', 'simkl:dropped:shows', null, { skipPushState: true });
    else {
      const numMatch = subSlug.match(/^([0-9]+)(?:-([a-z0-9_-]+))?/);
      const listId = numMatch ? numMatch[1] : subSlug;
      const listName = (numMatch && numMatch[2]) ? (typeof deslugify === 'function' ? deslugify(numMatch[2]) : numMatch[2]) : ('Simkl List ' + listId);
      openListDetailsPage(listName, 'movie', 'simkl:custom:' + listId, null, { skipPushState: true });
    }
    return;
  }

  // Custom lists deep linking
  const customMatch = path.match(new RegExp('^/lists/custom/([a-z0-9_-]+)', 'i'));
  if (customMatch) {
    const slug = customMatch[1].toLowerCase();
    const list = (typeof findCustomListBySlugOrName === 'function') ? findCustomListBySlugOrName(slug, typeof deslugify === 'function' ? deslugify(slug) : slug) : null;
    const name = list ? (list.name || (typeof deslugify === 'function' ? deslugify(slug) : slug)) : (typeof deslugify === 'function' ? deslugify(slug) : slug);
    const type = (list && list.type) ? list.type : 'movie';
    let sample = null;
    if (list && Array.isArray(list.items) && list.items.length) {
      sample = list.items.map((it) => {
        const label = (typeof formatWatchItemLabel === 'function') ? formatWatchItemLabel(it) : { title: it.title || it.name || '', subtitle: '' };
        const isShow = (it.type === 'series' || it.type === 'tv' || it.type === 'show' || it.kind === 'series' || it.kind === 'tv' || !!it.showId || it.seasonNum != null);
        const itemType = isShow ? 'series' : ((it.type === 'movie' || it.kind === 'movie') ? 'movie' : (it.type === 'episode' ? 'episode' : (list && list.type && list.type !== 'mixed' ? list.type : type)));
        return {
          id: it.showId || it.imdbId || it.id || (it.tmdbId ? ('tmdb:' + it.tmdbId) : null),
          type: itemType,
          name: label.title || it.title || it.name || 'Untitled',
          subtitle: label.subtitle || '',
          poster: it.poster || it.showPoster || '',
          year: it.year,
          airDate: it.airDate,
          isUnaired: it.isUnaired,
          removeCustomListSlug: list.slug || list.localSlug || slug,
        };
      });
    }
    openListDetailsPage(name, type, 'custom:' + slug, sample ? { sample: sample, count: sample.length, maybeMore: false } : null, { skipPushState: true });
    return;
  }

  // Channel deep linking (e.g. /channels/tlc)
  const channelMatch = path.match(new RegExp('^/channels/([a-z0-9_-]+)', 'i'));
  if (channelMatch) {
    const slug = channelMatch[1].toLowerCase();
    const map = (typeof loadLocalChannels === 'function') ? (typeof ensureAllChannelsSyncedFromRows === 'function' ? ensureAllChannelsSyncedFromRows(loadLocalChannels()) : loadLocalChannels()) : {};
    let foundChannel = null;
    for (const key in map) {
      const ch = map[key];
      if (!ch) continue;
      const chSlug = (ch.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      if (chSlug === slug || key.toLowerCase() === slug || (ch.channelId && ch.channelId.toLowerCase() === slug) || slug.startsWith(key.toLowerCase()) || slug.includes(chSlug)) {
        foundChannel = ch;
        break;
      }
    }
    const chName = foundChannel ? (foundChannel.name || (typeof deslugify === 'function' ? deslugify(slug) : slug)) : (typeof deslugify === 'function' ? deslugify(slug) : slug);
    const chUrl = foundChannel ? (foundChannel.channelId ? ('channel:id:' + foundChannel.channelId) : ('channel:v1:' + (foundChannel.name || 'channel'))) : ('channel:v1:' + slug);
    let sample = null;
    if (foundChannel && Array.isArray(foundChannel.items)) {
      sample = foundChannel.items.map((it) => {
        let showName = it.showName || '';
        let epName = it.epName || '';
        let seasonEp = '';
        if (it.season != null && it.episode != null) seasonEp = 'S' + it.season + 'E' + it.episode;
        if (!showName && it.title) showName = it.title;
        return {
          id: it.id || (it.imdbId ? ('tt' + it.imdbId) : null),
          name: showName,
          subtitle: (seasonEp && epName) ? (seasonEp + ' \u2014 ' + epName) : (seasonEp || epName || ''),
          poster: it.poster || it.showPoster || '',
          year: it.year,
          removeChannelItemIndex: it.removeChannelItemIndex != null ? it.removeChannelItemIndex : null
        };
      });
    }
    openListDetailsPage(chName, 'series', chUrl, sample ? { sample: sample, count: sample.length, maybeMore: false } : null, { skipPushState: true });
    return;
  }

  const hash = location.hash || '';
  if (hash.startsWith('#/list?')) {
    const params = new URLSearchParams(hash.slice('#/list?'.length));
    openListDetailsPage(params.get('name') || 'List', params.get('type') || 'movie', params.get('url') || '', null, { skipPushState: true });
  } else if (hash.startsWith('#/item?')) {
    const params = new URLSearchParams(hash.slice('#/item?'.length));
    openItemDetailsModal(params.get('id') || '', params.get('type') || 'movie', { skipPushState: true });
  }
})();

window.addEventListener('popstate', (e) => {
  const state = e.state;
  const path = location.pathname || '';
  const hash = location.hash || '';
  const isListPath = (path.startsWith('/lists/') && path !== '/lists') || hash.startsWith('#/list?');
  const isItemPath = hash.startsWith('#/item?');

  if (state && state.view === 'list') {
    const listKey = (state.name || '') + '::' + (state.type || '') + '::' + (state.listUrl || '');
    const currentListKey = window._currentListDetailsKey || '';
    const gridEl = document.getElementById('detailGrid');
    if (gridEl && gridEl.children.length > 0 && currentListKey === listKey) {
      switchTab('list-details');
      if (typeof window._listScrollY === 'number') {
        const targetScroll = window._listScrollY;
        window.scrollTo({ top: targetScroll, behavior: 'instant' });
      }
      return;
    }
    openListDetailsPage(state.name, state.type, state.listUrl, null, { skipPushState: true, restoreScrollY: window._listScrollY });
  } else if (isListPath && (!state || state.view !== 'tab')) {
    // If landed or popped into a list path without explicit state
    const params = new URLSearchParams(hash.slice('#/list?'.length));
    const listName = params.get('name') || '';
    const listType = params.get('type') || 'movie';
    const listUrl = params.get('url') || '';
    openListDetailsPage(listName, listType, listUrl, null, { skipPushState: true });
  } else if ((state && state.view === 'item') || isItemPath) {
    const itemId = (state && state.id) || (new URLSearchParams(hash.slice('#/item?'.length)).get('id')) || '';
    const itemType = (state && state.type) || (new URLSearchParams(hash.slice('#/item?'.length)).get('type')) || 'movie';
    openItemDetailsModal(itemId, itemType, { skipPushState: true });
  } else {
    const targetTab = (state && (state.fromTab || (state.view === 'tab' && state.tab))) || window._originTab || window._previousTab || localStorage.getItem('myListAddon:activeTab') || 'discover';
    const cleanTab = (targetTab === 'list-details' || targetTab === 'item-details') ? 'discover' : targetTab;
    if (location.pathname.startsWith('/lists/')) {
      history.replaceState({ view: 'tab', tab: cleanTab }, '', '/');
    }
    switchTab(cleanTab);
    if (cleanTab === 'catalogs') {
      const targetSubmenu = (state && state.fromCatalogsSubmenu) || localStorage.getItem('myListAddon:catalogsSubmenu') || 'all';
      if (typeof switchCatalogsSubmenu === 'function') switchCatalogsSubmenu(targetSubmenu);
    } else if (cleanTab === 'channels') {
      const targetSubmenu = (state && state.fromChannelsSubmenu) || window._previousChannelsSubmenu || localStorage.getItem('myListAddon:channelsSubmenu') || 'storylines';
      if (typeof switchChannelsSubmenu === 'function') switchChannelsSubmenu(targetSubmenu);
    }

    const scrollPos = (state && typeof state.previousScrollY === 'number') ? state.previousScrollY : (typeof window._previousScrollY === 'number' ? window._previousScrollY : null);
    if (typeof scrollPos === 'number' && scrollPos > 0) {
      const restoreFn = () => window.scrollTo({ top: scrollPos, behavior: 'instant' });
      restoreFn();
      requestAnimationFrame(restoreFn);
      setTimeout(restoreFn, 50);
      setTimeout(restoreFn, 150);
      setTimeout(restoreFn, 300);
    }
  }
});
/*MYLISTS_APP_BUNDLE_END*/</script>

</body>
</html>`;
}

// --- /guide -----------------------------------------------------------------
//
// A standalone content page, not the interactive builder -- see the GET
// /guide route in 25_api-catalog-routes.js. Deliberately its own small,
// self-contained template literal (own <head>, own lightweight stylesheet)
// rather than reusing renderBuilder's ~2000-line app stylesheet, since
// almost none of that (tab bars, drag-and-drop entry cards, live preview
// grids...) applies to a static article page -- pulling it in would just
// be dead weight on every /guide page load.
//
// Content-wise this exists to be the answer to the searches this add-on's
// own users already had to go find third-party guide sites for --
// "how do I turn an MDBList/Trakt/TMDB list into a Stremio catalog" --
// written by the people who actually built the tool, plus the "why
// self-host instead of a hosted list addon" pitch and a provider
// comparison/FAQ. See seoHeadHtml's own comment in 09_page-shell.js for
// why /:config/configure pages are the ones that get noindex'd, not this
// one -- this page has no per-user config in its URL at all, so it's
// exactly the kind of URL meant to be crawled and indexed.
function renderGuidePage(origin) {
  const title = `My Lists Addon — Complete User Guide & How-To Documentation`;
  const description =
    "Comprehensive step-by-step guides for My Lists Addon (mylistsaddon.com). Learn how to turn MDBList, Trakt, TMDB, and Simkl lists into Stremio, Wako, and Nuvio catalogs, build 24/7 Channels and Storylines & Universes, import lists from other trackers, and sync across devices.";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#000000">
<title>${title}</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${origin}/guide">
<meta name="robots" content="index, follow">
<meta property="og:type" content="article">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${origin}/guide">
<meta property="og:image" content="${origin}/icon.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
<link rel="icon" type="image/png" href="${origin}/icon.png">
<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: "How do I install My Lists Addon into Stremio, Wako, or Nuvio?",
        acceptedAnswer: {
          "@type": "Answer",
          text:
            "Open mylistsaddon.com, add your desired lists or streaming shelves under the Catalogs tab, click Generate Install Link, and open the resulting link in Stremio, Wako, Nuvio, or any other app built on the Stremio addon protocol to confirm installation. No registration or account is required.",
        },
      },
      {
        "@type": "Question",
        name: "How do I import lists from Letterboxd, IMDb, or another tracker?",
        acceptedAnswer: {
          "@type": "Answer",
          text:
            "Export your data as a CSV or JSON file from the other service, then go to Settings -> External Accounts & API Keys -> Import List on mylistsaddon.com. Choose the matching source (or leave it on Auto-detect), pick or name a destination list, and upload your file.",
        },
      },
      {
        "@type": "Question",
        name: "What are Channels and how do they work?",
        acceptedAnswer: {
          "@type": "Answer",
          text:
            "Channels turn one or more shows into a 24/7-style catalog row that plays episodes continuously in broadcast order or shuffle, similar to a live TV network. Build one from scratch, one-tap add a popular network, or import a show list URL as a channel.",
        },
      },
      {
        "@type": "Question",
        name: "Is My Lists Addon free?",
        acceptedAnswer: {
          "@type": "Answer",
          text:
            "Yes, 100% free with no subscriptions, ads, or paywalls. Use the hosted instance at mylistsaddon.com, or self-host your own copy on a free Cloudflare Workers account -- optional support is available via Buy Me a Coffee.",
        },
      },
    ],
  })}</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600;700;800&family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #000000;
    --bg-surface: #1C1C1E;
    --bg-card: #2C2C2E;
    --bg-input: #3A3A3C;
    --text: #FFFFFF;
    --text-muted: #8E8E93;
    --text-dim: #A1A1A6;
    --border: rgba(255,255,255,0.12);
    --border-strong: rgba(255,255,255,0.22);
    --accent: #0A84FF;
    --accent-hover: #0070E0;
    --accent-bg: rgba(10, 132, 255, 0.15);
    --success: #30D158;
    --warning: #FFD60A;
    --danger: #FF453A;
    --radius-lg: 16px;
    --radius-md: 12px;
    --radius-sm: 8px;
    --shadow: 0 4px 20px rgba(0,0,0,0.5);
  }

  :root.light-theme, .light-theme {
    --bg: #F2F2F7;
    --bg-surface: #FFFFFF;
    --bg-card: #E5E5EA;
    --bg-input: #D1D1D6;
    --text: #1C1C1E;
    --text-muted: #6C6C70;
    --text-dim: #48484A;
    --border: rgba(0,0,0,0.08);
    --border-strong: rgba(0,0,0,0.16);
    --accent: #007AFF;
    --accent-hover: #0062CC;
    --accent-bg: rgba(0, 122, 255, 0.10);
    --shadow: 0 2px 12px rgba(0,0,0,0.06);
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { scroll-behavior: smooth; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    font-size: 16px;
    line-height: 1.65;
    -webkit-font-smoothing: antialiased;
  }

  .guide-layout {
    max-width: 1040px;
    margin: 0 auto;
    padding: 24px 20px 80px;
  }

  /* Header */
  .guide-nav {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 0 28px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 32px;
  }
  .brand-group {
    display: flex;
    align-items: center;
    gap: 12px;
    text-decoration: none;
    color: var(--text);
  }
  .brand-logo {
    width: 38px;
    height: 38px;
    border-radius: 10px;
  }
  .brand-text {
    font-family: 'Space Grotesk', sans-serif;
    font-weight: 800;
    font-size: 1.25rem;
    letter-spacing: -0.02em;
  }
  .nav-actions {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 9px 16px;
    border-radius: 999px;
    font-size: 0.9rem;
    font-weight: 600;
    text-decoration: none;
    transition: all 0.15s ease;
    cursor: pointer;
    border: none;
  }
  .btn-primary {
    background: var(--accent);
    color: #FFF;
  }
  .btn-primary:hover { background: var(--accent-hover); }
  .btn-secondary {
    background: var(--bg-surface);
    color: var(--text);
    border: 1px solid var(--border-strong);
  }
  .btn-secondary:hover { border-color: var(--accent); }

  /* Theme Toggle */
  .theme-toggle-btn {
    width: 38px;
    height: 38px;
    border-radius: 50%;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    overflow: hidden;
    color: var(--text);
  }
  .theme-icon {
    position: absolute;
    width: 18px;
    height: 18px;
    transition: transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.3s ease;
  }
  .icon-sun { opacity: 1; transform: translate(-50%, -50%) rotate(0deg) scale(1); left: 50%; top: 50%; }
  .icon-moon { opacity: 0; transform: translate(-50%, -50%) rotate(-90deg) scale(0.4); left: 50%; top: 50%; }
  :root.light-theme .icon-sun, .light-theme .icon-sun { opacity: 0; transform: translate(-50%, -50%) rotate(90deg) scale(0.4); }
  :root.light-theme .icon-moon, .light-theme .icon-moon { opacity: 1; transform: translate(-50%, -50%) rotate(0deg) scale(1); }

  /* Hero */
  .hero-section {
    text-align: center;
    padding: 24px 0 40px;
    max-width: 800px;
    margin: 0 auto;
  }
  .hero-badge {
    display: inline-block;
    padding: 4px 12px;
    border-radius: 999px;
    background: var(--accent-bg);
    color: var(--accent);
    font-size: 0.82rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 16px;
  }
  h1 {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 2.5rem;
    font-weight: 800;
    line-height: 1.15;
    letter-spacing: -0.03em;
    margin-bottom: 16px;
  }
  .hero-sub {
    font-size: 1.15rem;
    color: var(--text-dim);
    line-height: 1.6;
    margin-bottom: 28px;
  }

  /* Quick-Jump TOC Bar */
  .toc-bar {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
    margin-bottom: 48px;
  }
  .toc-pill {
    padding: 7px 14px;
    border-radius: 999px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    color: var(--text-dim);
    font-size: 0.85rem;
    font-weight: 600;
    text-decoration: none;
    transition: all 0.15s ease;
  }
  .toc-pill:hover {
    color: var(--text);
    border-color: var(--accent);
    background: var(--accent-bg);
  }

  /* Guide Content Blocks */
  .guide-block {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 32px 28px;
    margin-bottom: 32px;
    box-shadow: var(--shadow);
  }
  .block-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 20px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--border);
  }
  .block-icon {
    width: 36px;
    height: 36px;
    border-radius: 10px;
    background: var(--accent-bg);
    color: var(--accent);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.25rem;
    font-weight: 700;
  }
  h2 {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 1.5rem;
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  h3 {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 1.15rem;
    font-weight: 700;
    margin: 24px 0 10px;
    color: var(--text);
  }
  p { color: var(--text-dim); margin-bottom: 14px; }
  ul, ol { color: var(--text-dim); padding-left: 24px; margin-bottom: 16px; }
  li { margin-bottom: 8px; }
  strong { color: var(--text); font-weight: 600; }

  /* Steps List */
  .steps-container {
    display: flex;
    flex-direction: column;
    gap: 16px;
    margin: 20px 0;
  }
  .step-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 18px 20px;
    display: flex;
    gap: 16px;
  }
  .step-num {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: var(--accent);
    color: #FFF;
    font-weight: 800;
    font-size: 0.85rem;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    margin-top: 2px;
  }
  .step-body h4 {
    font-size: 1rem;
    font-weight: 700;
    margin-bottom: 4px;
    color: var(--text);
  }
  .step-body p {
    font-size: 0.92rem;
    margin-bottom: 0;
  }

  /* Callout Tips */
  .tip-box {
    background: var(--accent-bg);
    border-left: 4px solid var(--accent);
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
    padding: 14px 18px;
    margin: 18px 0;
    font-size: 0.92rem;
    color: var(--text);
  }
  .tip-box strong { color: var(--accent); }

  /* Code / Snippets */
  code {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 2px 7px;
    font-size: 0.88em;
    font-family: 'JetBrains Mono', monospace;
    color: var(--text);
  }
  .code-block {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 12px 16px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.88rem;
    color: var(--text);
    overflow-x: auto;
    margin: 12px 0 18px;
    word-break: break-all;
  }

  /* Comparison Grid */
  .provider-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 16px;
    margin: 20px 0;
  }
  .provider-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 16px;
  }
  .provider-card h4 {
    font-size: 1.05rem;
    font-weight: 700;
    margin-bottom: 6px;
    color: var(--text);
  }
  .provider-card p {
    font-size: 0.86rem;
    margin-bottom: 8px;
  }
  .provider-tag {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    background: var(--accent-bg);
    color: var(--accent);
    font-size: 0.75rem;
    font-weight: 700;
  }

  /* FAQ Accordions */
  .faq-item {
    border-bottom: 1px solid var(--border);
    padding: 18px 0;
  }
  .faq-item:last-child { border-bottom: none; }
  .faq-q {
    font-size: 1.05rem;
    font-weight: 700;
    color: var(--text);
    margin-bottom: 6px;
  }
  .faq-a {
    font-size: 0.95rem;
    color: var(--text-dim);
  }

  /* Footer CTA */
  .footer-cta {
    background: linear-gradient(135deg, var(--bg-surface) 0%, var(--bg-card) 100%);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 36px 32px;
    text-align: center;
    margin-top: 48px;
  }
  .footer-cta h3 {
    font-size: 1.6rem;
    margin-bottom: 8px;
  }
  .footer-cta p {
    margin-bottom: 24px;
    max-width: 540px;
    margin-left: auto;
    margin-right: auto;
  }
  .footer-nav {
    margin-top: 40px;
    padding-top: 20px;
    border-top: 1px solid var(--border);
    text-align: center;
    color: var(--text-muted);
    font-size: 0.85rem;
  }
  .footer-nav a { color: var(--accent); text-decoration: none; }

  @media (max-width: 640px) {
    h1 { font-size: 1.85rem; }
    .guide-block { padding: 24px 18px; }
    .step-card { flex-direction: column; gap: 10px; }
  }
</style>
<script>
  function applyTheme(t) {
    if (t === 'light') {
      document.documentElement.classList.add('light-theme');
      document.documentElement.classList.remove('dark-theme');
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#F2F2F7');
    } else {
      document.documentElement.classList.add('dark-theme');
      document.documentElement.classList.remove('light-theme');
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#000000');
    }
  }
  const saved = localStorage.getItem('theme');
  if (saved) {
    applyTheme(saved);
  } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
    applyTheme('light');
  }
  function toggleTheme() {
    const isLight = document.documentElement.classList.contains('light-theme');
    const next = isLight ? 'dark' : 'light';
    localStorage.setItem('theme', next);
    applyTheme(next);
  }
</script>
</head>
<body>

<div class="guide-layout">
  <!-- Navigation Header -->
  <header class="guide-nav">
    <a href="${origin}/" class="brand-group">
      <img src="${origin}/icon.png" alt="My Lists Icon" class="brand-logo">
      <span class="brand-text">${ADDON_NAME}</span>
    </a>
    <div class="nav-actions">
      <button type="button" class="theme-toggle-btn" onclick="toggleTheme()" aria-label="Toggle Dark/Light Mode">
        <svg class="theme-icon icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="5" fill="currentColor"></circle>
          <line x1="12" y1="1" x2="12" y2="3"></line>
          <line x1="12" y1="21" x2="12" y2="23"></line>
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
          <line x1="1" y1="12" x2="3" y2="12"></line>
          <line x1="21" y1="12" x2="23" y2="12"></line>
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
          <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
        </svg>
        <svg class="theme-icon icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
        </svg>
      </button>
      <a href="${origin}/" class="btn btn-primary">Go to mylistsaddon.com &rarr;</a>
    </div>
  </header>

  <!-- Hero Header -->
  <div class="hero-section">
    <div class="hero-badge">Documentation &amp; User Guides</div>
    <h1>How to Use My Lists Addon</h1>
    <p class="hero-sub">The complete guide to turning MDBList, Trakt, TMDB, and Simkl lists into dynamic Stremio, Wako, and Nuvio catalogs, building 24/7 Channels and Storylines &amp; Universes, importing lists from other trackers, and syncing across your devices.</p>

    <!-- Table of Contents -->
    <div class="toc-bar">
      <a href="#quick-start" class="toc-pill">Quick Start</a>
      <a href="#discover" class="toc-pill">Discover</a>
      <a href="#catalogs" class="toc-pill">Catalogs</a>
      <a href="#lists" class="toc-pill">Lists</a>
      <a href="#channels" class="toc-pill">Channels</a>
      <a href="#storylines" class="toc-pill">Storylines &amp; Universes</a>
      <a href="#importing" class="toc-pill">Importing</a>
      <a href="#settings" class="toc-pill">Settings</a>
      <a href="#backups" class="toc-pill">Backups &amp; Presets</a>
      <a href="#self-hosting" class="toc-pill">Self-Hosting</a>
      <a href="#faq" class="toc-pill">FAQ</a>
    </div>
  </div>

  <!-- 1. Quick Start Guide -->
  <section class="guide-block" id="quick-start">
    <div class="block-header">
      <div class="block-icon">1</div>
      <div>
        <h2>1. Quick Start</h2>
        <p style="margin-bottom:0;">Get catalog rows running on Stremio, Wako, Nuvio, or any other app built on the Stremio addon protocol, with zero registration.</p>
      </div>
    </div>

    <p>The fastest way to get started is to use the hosted instance directly at <a href="${origin}/"><strong>mylistsaddon.com</strong></a> &mdash; no account, no deployment, nothing to set up.</p>

    <div class="steps-container">
      <div class="step-card">
        <div class="step-num">1</div>
        <div class="step-body">
          <h4>Open mylistsaddon.com</h4>
          <p>Visit <a href="${origin}/"><strong>mylistsaddon.com</strong></a> in any browser, on desktop or mobile.</p>
        </div>
      </div>
      <div class="step-card">
        <div class="step-num">2</div>
        <div class="step-body">
          <h4>Add Your Favorite Shelves</h4>
          <p>Under the <strong>Catalogs</strong> tab, click <strong>+ New Catalog</strong> to paste any MDBList, Trakt, TMDB, or Simkl URL, or browse the <strong>Discover</strong> tab for one-tap shelves (Netflix, Disney+, Prime Video, genres, and more).</p>
        </div>
      </div>
      <div class="step-card">
        <div class="step-num">3</div>
        <div class="step-body">
          <h4>Generate Your Install Link</h4>
          <p>Click <strong>Generate Install Link</strong> on the Catalogs tab. Open the resulting link, or paste it into Stremio, Wako, Nuvio, or your app's "Install addon from URL" field, and confirm. You're done!</p>
        </div>
      </div>
    </div>

    <div class="tip-box">
      <strong>How it works:</strong> Your entire configuration is encoded into your install link. When you add or reorder catalogs later, click <strong>Update Link</strong> on the Catalogs tab and reinstall to push the changes.
    </div>

    <p>Prefer to run your own dedicated copy instead of the shared hosted instance? See <a href="#self-hosting">Self-Hosting</a> below.</p>
  </section>

  <!-- 2. Discover -->
  <section class="guide-block" id="discover">
    <div class="block-header">
      <div class="block-icon">2</div>
      <div>
        <h2>2. Discover Tab</h2>
        <p style="margin-bottom:0;">Browse everything available without typing a single URL.</p>
      </div>
    </div>

    <p>The default landing tab. Filter pills across the top narrow the shelves shown: <strong>All, Movies, Shows, Popular Lists, Curated, Hidden Gems, Kids, Holidays, Genres</strong>.</p>

    <h3>What's here:</h3>
    <ul>
      <li><strong>Combined Charts</strong> &mdash; Popular, Trending, Streaming Top 10, and Streaming (All Services), blending multiple sources into one row.</li>
      <li><strong>TMDB Charts</strong> &mdash; New Releases, Trending, Popular, Top Rated, Now Playing, Upcoming.</li>
      <li><strong>Trakt Charts</strong> &mdash; Trending, Popular, Most Played, Most Watched, Most Collected, Most Favorited, Most Anticipated, and Box Office.</li>
      <li><strong>MDBList Official</strong> &mdash; Popular, US Daily Streaming Charts, Streaming Charts (Extended), IMDb MovieMeter.</li>
      <li><strong>Simkl Anime &amp; Trending</strong> &mdash; Trending Today/Week/Month, plus Anime Trending.</li>
      <li><strong>Streaming Top 10 &amp; Streaming Catalogs</strong> &mdash; per-service rows for Netflix, Disney+, HBO Max, Hulu, Prime Video, Apple TV+, Paramount+, Peacock, Discovery+.</li>
      <li><strong>Hidden Gems, Kids, Holidays, Genres</strong> &mdash; curated thematic and seasonal shelves.</li>
      <li><strong>Popular Community Lists</strong> and <strong>Curated For You</strong> &mdash; the latter personalized from your watch history.</li>
    </ul>

    <p>Each shelf has <strong>+ Movies</strong> / <strong>+ Shows</strong> buttons to add just that half of a chart, or <strong>+ Add all</strong> at the top of a section to add every shelf in it at once. Click <strong>See All &rsaquo;</strong> to preview a shelf's full contents first.</p>
  </section>

  <!-- 3. Catalogs -->
  <section class="guide-block" id="catalogs">
    <div class="block-header">
      <div class="block-icon">3</div>
      <div>
        <h2>3. Catalogs Tab</h2>
        <p style="margin-bottom:0;">Where you add, arrange, and finalize what appears on your home screen.</p>
      </div>
    </div>

    <p>Three submenus: <strong>My Catalogs</strong>, <strong>Quick Add</strong>, and <strong>Bulk Add</strong>.</p>

    <h3>My Catalogs &mdash; Live Preview &amp; Editor</h3>
    <p>Shows every catalog row you've added, in the order it will display.</p>
    <ul>
      <li><strong>+ New Catalog</strong> &mdash; opens the Add Catalog modal to add a list by URL (see below).</li>
      <li><strong>Edit</strong> &mdash; toggle edit mode to drag-reorder, rename, or remove rows.</li>
      <li><strong>Refresh Preview</strong> &mdash; re-renders the live preview.</li>
      <li>Filter by name and by group using the controls above the list.</li>
      <li><strong>Daily Randomizer</strong> &mdash; two toggles: shuffle catalog row order every 24 hours, or shuffle items within each catalog every 24 hours.</li>
      <li><strong>Generate Install Link</strong> &mdash; produces your install URL, ready for Stremio, Wako, Nuvio, or any other app built on the Stremio addon protocol.</li>
    </ul>

    <div class="provider-grid">
      <div class="provider-card">
        <h4>MDBList</h4>
        <span class="provider-tag">No Key Required</span>
        <p style="margin-top:8px;">Paste any public list URL like <code>mdblist.com/lists/username/list-name</code>. Connect an account or API key under Settings to unlock your personal Watchlist and private lists.</p>
      </div>
      <div class="provider-card">
        <h4>Trakt.tv</h4>
        <span class="provider-tag">OAuth &amp; Public</span>
        <p style="margin-top:8px;">Add public lists (<code>trakt.tv/users/username/lists/list-slug</code>) or connect your account to sync your Watchlist and History.</p>
      </div>
      <div class="provider-card">
        <h4>TheMovieDB (TMDB)</h4>
        <span class="provider-tag">Lists &amp; Charts</span>
        <p style="margin-top:8px;">Add public lists (<code>themoviedb.org/list/12345</code>), or browse automated genre, network, and streaming-provider charts.</p>
      </div>
      <div class="provider-card">
        <h4>Simkl</h4>
        <span class="provider-tag">Anime &amp; Trending</span>
        <p style="margin-top:8px;">One-tap trending charts for Movies, Shows, and Anime. Connect an account to import personal lists and watch history.</p>
      </div>
    </div>

    <h3>Adding a catalog by URL (the "+ New Catalog" modal):</h3>
    <ol>
      <li>Click <strong>+ New Catalog</strong>.</li>
      <li>Enter a <strong>Catalog name</strong> &mdash; this becomes the row title on your home screen.</li>
      <li>Paste a list <strong>URL</strong> from MDBList, Trakt, TMDB, or Simkl.</li>
      <li>Optional: click <strong>+ Add another link</strong> to combine multiple list URLs into one blended row.</li>
      <li>Choose the content type: <strong>Movies</strong> or <strong>Shows</strong>.</li>
      <li>Click <strong>Add</strong>.</li>
    </ol>

    <h3>Quick Add &amp; Bulk Add</h3>
    <p><strong>Quick Add</strong> is a one-tap shortcut to official charts without leaving this tab. <strong>Bulk Add</strong> lets you paste multiple list URLs at once, one per line, and click <strong>Add All Lines as Catalogs</strong> &mdash; each line is auto-detected and added as its own row.</p>

    <div class="tip-box">
      <strong>Combined Rows:</strong> Add multiple links to a single "+ New Catalog" entry to merge several lists into one unified catalog row.
    </div>
  </section>

  <!-- 4. Lists -->
  <section class="guide-block" id="lists">
    <div class="block-header">
      <div class="block-icon">4</div>
      <div>
        <h2>4. Lists Tab</h2>
        <p style="margin-bottom:0;">Your personal, account-connected, and hand-built lists, separate from the catalog rows themselves.</p>
      </div>
    </div>

    <p>Three submenus: <strong>My Lists</strong>, <strong>Liked</strong>, and <strong>Import</strong>.</p>

    <h3>My Lists</h3>
    <ul>
      <li><strong>Your Custom Lists</strong> &mdash; hand-built lists. <strong>+ New List</strong> starts one from scratch.</li>
      <li><strong>Your MDBList Lists</strong> &mdash; once you <strong>Connect MDBList</strong>, your Lists, Watchlist, and Watch History appear here.</li>
      <li><strong>Your Trakt Lists</strong> &mdash; via <strong>Connect Trakt</strong> (OAuth, no password shared with the addon).</li>
      <li><strong>Your TMDB Lists</strong> &mdash; via <strong>Connect TMDB</strong>, pulls your Lists, Watchlist, and Favorites.</li>
      <li><strong>Your Simkl Lists</strong> &mdash; via <strong>Connect Simkl</strong>, pulls your Lists, Watchlist, and History.</li>
    </ul>

    <h3>Building a Custom List from Scratch:</h3>
    <ol>
      <li>Click <strong>+ New List</strong> and choose <strong>Destination: Custom List</strong>.</li>
      <li>Give it a <strong>Name</strong> and optional <strong>Description</strong>.</li>
      <li>Choose <strong>Content Type</strong>: Movies, Shows, or Mixed, and <strong>Visibility</strong>: Public or Private.</li>
      <li>Click <strong>Create</strong>, then use Search/Discover/Charts to tap <strong>+</strong> on any title to add it to the list.</li>
      <li>Reorder by dragging or typing a position number; remove with the <strong>&times;</strong> button.</li>
      <li>Click <strong>Save</strong>. You can now add this list to your Catalogs like any other.</li>
    </ol>

    <h3>Liked</h3>
    <p>Tap the heart (&hearts;) icon on any list anywhere in the app to save it here for quick access later.</p>

    <div class="tip-box">
      <strong>Import:</strong> The Import submenu lets you clone any MDBList, Trakt, or TMDB list URL directly into a Custom List, with an option to keep it synced to the source. See <a href="#importing">Importing</a> below for the full walkthrough, including bulk file imports from other trackers.
    </div>
  </section>

  <!-- 5. Channels -->
  <section class="guide-block" id="channels">
    <div class="block-header">
      <div class="block-icon">5</div>
      <div>
        <h2>5. Channels Tab</h2>
        <p style="margin-bottom:0;">Turn any set of shows into a continuous 24/7-style catalog row, like flipping on a real network.</p>
      </div>
    </div>

    <p>Four submenus: <strong>My Channels</strong>, <strong>Storylines &amp; Universes</strong>, <strong>Quick Add</strong>, and <strong>Import</strong>.</p>

    <h3>My Channels</h3>
    <p>Lists everything you've built. <strong>+ New Channel</strong> opens the channel builder. Below that, <strong>Merge Saved Channels into One Catalog</strong> lets you select multiple saved channels with checkboxes, name the merge, and click <strong>Merge into catalog</strong> to combine them into a single row.</p>

    <h3>Building a Channel from Scratch:</h3>
    <ol>
      <li>Click <strong>+ New Channel</strong>.</li>
      <li>Use the <strong>Shows / Movies</strong> toggle to set what you're searching for.</li>
      <li>Search a title and add picks &mdash; for shows, an episode picker lets you choose specific seasons/episodes.</li>
      <li>Reorder or remove picks in <strong>Picks in this channel</strong>. <strong>Shuffle picks now</strong> randomizes the order once; the <strong>Randomize play order</strong> checkbox re-shuffles automatically every 24 hours.</li>
      <li>Choose a <strong>Channel Poster</strong> from an added show's artwork, or use the default channel poster.</li>
      <li>Name the channel and click <strong>Save</strong>.</li>
    </ol>

    <h3>Quick Add Popular Networks</h3>
    <p>One-click channels for major broadcast/cable networks &mdash; ABC, NBC, CBS, FOX, The CW, HBO, AMC, FX, Comedy Central, Nickelodeon, Cartoon Network, Adult Swim, Disney Channel, Discovery, History, HGTV, Food Network, TLC, MTV, Syfy, TBS, TNT, USA Network, BBC One, A&amp;E, Hallmark Channel, Ion Television, MeTV, and more &mdash; each with automatic daily episode rotation.</p>

    <h3>Import channel from a link</h3>
    <p>Paste any MDBList, Trakt, or TMDB <strong>show list</strong> URL, give it a channel name, and click <strong>Import channel</strong>. Every episode of every show on that list becomes the channel automatically.</p>
  </section>

  <!-- 6. Storylines & Universes -->
  <section class="guide-block" id="storylines">
    <div class="block-header">
      <div class="block-icon">6</div>
      <div>
        <h2>6. Storylines, Sagas &amp; Universes</h2>
        <p style="margin-bottom:0;">Found inside the Channels tab &mdash; complete franchise viewing orders, pre-built for you.</p>
      </div>
    </div>

    <p>A curated library of movie trilogies and sagas (3+ films) and TV-to-movie/crossover universes in canon chronological watch order, so you don't have to research the "correct" order yourself.</p>

    <p><strong>Filter categories:</strong> All Sagas, Movie Sagas (3+ Films), TV Universes &amp; Bridges, Sci-Fi &amp; Fantasy, Action &amp; Crime, Animation &amp; Anime.</p>

    <p>Coverage includes large connected universes such as the Arrowverse, Grey's Anatomy/Station 19, the Law &amp; Order franchise, the FBI franchise, the One Chicago shows, the Cobra Kai/Miyagi-verse, and Downton Abbey, tracked at episode-accurate granularity.</p>

    <div class="tip-box">
      <strong>Two ways to use a saga:</strong> Add it directly to your Catalogs as a normal ordered row, or launch it as a continuous 24/7 channel with one click, using the same engine described above.
    </div>
  </section>

  <!-- 7. Search -->
  <section class="guide-block" id="search">
    <div class="block-header">
      <div class="block-icon">7</div>
      <div>
        <h2>7. Search Tab</h2>
        <p style="margin-bottom:0;">A unified search across movies, shows, and lists.</p>
      </div>
    </div>

    <ol>
      <li>Type a title or list name into the search box.</li>
      <li>Filter by type using the <strong>Movies / Shows / Lists</strong> pills.</li>
      <li>Refine with <strong>Genre</strong>, <strong>Year</strong>, and <strong>Rating</strong> dropdowns.</li>
      <li>Click <strong>Reset</strong> to clear filters.</li>
    </ol>
    <p>Results show a <strong>+ Add</strong> button on each poster to add it directly to a Custom List or the channel/catalog builder you launched Search from.</p>
  </section>

  <!-- 8. Importing -->
  <section class="guide-block" id="importing">
    <div class="block-header">
      <div class="block-icon">8</div>
      <div>
        <h2>8. Importing Lists &amp; Data From Other Sites</h2>
        <p style="margin-bottom:0;">Two kinds of import: a single list by URL, and bulk files from other trackers.</p>
      </div>
    </div>

    <h3>Importing a single list by URL</h3>
    <p>Available in the <strong>Lists tab &rarr; Import</strong> submenu (clones into a Custom List), <strong>Channels tab &rarr; Import</strong> submenu (clones into a Channel, shows only), or directly via <strong>Catalogs tab &rarr; + New Catalog</strong>.</p>
    <ol>
      <li>Copy the list's URL from MDBList (<code>mdblist.com/lists/username/list-name</code>), Trakt (<code>trakt.tv/users/username/lists/list-slug</code>), or TMDB (<code>themoviedb.org/list/12345</code>).</li>
      <li>Paste it into the Import box and give it a name, or let it auto-detect one.</li>
      <li>Optional: check <strong>"Keep custom list synced with external link"</strong> so your copy periodically refreshes to match the source.</li>
      <li>Click <strong>Import list</strong> (or <strong>Import channel</strong>).</li>
    </ol>

    <h3>Bulk file import (CSV/JSON from other trackers)</h3>
    <p>Go to <strong>Settings &rarr; External Accounts &amp; API Keys &rarr; Import List</strong>. Supported source formats: <strong>IMDb, Letterboxd, MovieLens, Trakt, Simkl, and TMDB</strong> exports, in CSV or JSON. You can select multiple files at once.</p>
    <ol>
      <li>Export your ratings/watchlist/history file from the other service (each site has its own "export my data" feature).</li>
      <li>Set <strong>Source</strong> to the matching provider, or leave it on <strong>Auto-detect</strong>.</li>
      <li>Choose <strong>Import to which list?</strong> &mdash; an existing list, or type a <strong>New List Name</strong>.</li>
      <li>Optionally check <strong>"Also add watched items to Watch History"</strong>.</li>
      <li>Click <strong>Select file(s)</strong>, choose your export file(s), then click <strong>Import</strong>.</li>
    </ol>

    <div class="tip-box">
      <strong>Have a pile of list links instead?</strong> Use <strong>Catalogs &rarr; Bulk Add</strong> to paste one URL per line and add them all as catalogs at once.
    </div>
  </section>

  <!-- 9. Settings -->
  <section class="guide-block" id="settings">
    <div class="block-header">
      <div class="block-icon">9</div>
      <div>
        <h2>9. Settings Tab</h2>
        <p style="margin-bottom:0;">Connected accounts, region, watch history, and support.</p>
      </div>
    </div>

    <p>Four submenus: <strong>Account &amp; Sync</strong>, <strong>External Accounts &amp; API Keys</strong>, <strong>Presets &amp; Backup</strong>, <strong>Feedback and Support</strong>.</p>

    <h3>Account &amp; Sync</h3>
    <ul>
      <li><strong>Watchlist Preferences</strong> &mdash; controls how watched titles are handled in your Watchlist.</li>
      <li><strong>Hidden Lists</strong> &mdash; hide specific lists from My Lists, Airing Next, and Simkl Airing Next without un-tracking them; they keep updating and can be un-hidden anytime.</li>
      <li><strong>Region</strong> &mdash; sets your country for streaming-availability catalogs (Netflix, Disney+, etc.), Stream Releases, and content ratings.</li>
      <li><strong>Trending &amp; Popular Catalogs</strong> &mdash; toggle "Hide items with no digital release" to skip still-in-theaters movies from Trending/Popular rows. Requires Save/Update to take effect.</li>
      <li><strong>Watch History</strong> &mdash; clear/reset all recorded history.</li>
      <li><strong>Auto-Track &amp; Media Server Scrobbling</strong> &mdash; automatically records watched movies/episodes from your streaming apps and home media servers (Plex, Jellyfin, Emby) into Watch History and Continue Watching.</li>
    </ul>

    <h3>External Accounts &amp; API Keys</h3>
    <p>Connect MDBList, Trakt, TMDB, and Simkl. Each provider offers <strong>Connect Account</strong> (OAuth/PIN flow &mdash; for Trakt, enter a code at <code>trakt.tv/activate</code>, your password is never entered here), <strong>Disconnect</strong>, <strong>Sync Watch History</strong> (push watched items back to that provider), and an advanced custom API key/Client ID field:</p>
    <ul>
      <li>TMDB key: <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener">themoviedb.org/settings/api</a></li>
      <li>Trakt Client ID: <a href="https://trakt.tv/oauth/applications" target="_blank" rel="noopener">trakt.tv/oauth/applications</a></li>
      <li>MDBList key: <a href="https://mdblist.com/preferences" target="_blank" rel="noopener">mdblist.com/preferences</a></li>
      <li>Simkl Client ID: <a href="https://simkl.com/settings/developer/" target="_blank" rel="noopener">simkl.com/settings/developer/</a></li>
    </ul>
    <p>You only need any of this for private lists, personal watchlists/history, or your own dedicated rate limit &mdash; public lists and charts work with zero setup.</p>

    <h3>Feedback and Support</h3>
    <p>A built-in chat with the developer &mdash; pick a category (Bug Report, Improvement/Feature Request, Idea/Suggestion, General Question), write your message, and send. Use <strong>&#8635; Refresh</strong> to check for a reply.</p>
  </section>

  <!-- 10. Backups & Presets -->
  <section class="guide-block" id="backups">
    <div class="block-header">
      <div class="block-icon">10</div>
      <div>
        <h2>10. Backups, Presets &amp; Data Export</h2>
        <p style="margin-bottom:0;">Found under Settings &rarr; Presets &amp; Backup.</p>
      </div>
    </div>

    <h3>Presets</h3>
    <p>Save your entire current setup as a named preset to switch back to later, or download it as a file. Ideal for maintaining a few different "profiles" &mdash; e.g. a Kids setup vs. your main one.</p>
    <ul>
      <li><strong>Save preset</strong> &mdash; names and stores your current configuration.</li>
      <li><strong>Upload preset file</strong> &mdash; restores a previously downloaded preset.</li>
    </ul>

    <h3>Backup &amp; Restore</h3>
    <ul>
      <li><strong>Export current</strong> &mdash; downloads your full setup as JSON.</li>
      <li><strong>Import JSON &rarr; Upload file</strong> &mdash; restores from a downloaded backup.</li>
      <li><strong>Import from Install/Configure Link</strong> &mdash; paste an existing install link (yours or shared with you) and click <strong>Import link</strong> to pull in that whole configuration.</li>
    </ul>

    <h3>Export Lists &amp; History</h3>
    <p>Pulls your data <strong>out</strong> to portable formats for other apps:</p>
    <ul>
      <li><strong>Watch History</strong> &mdash; all watched movies, shows, and episodes with timestamps, as <strong>CSV (Trakt/Simkl)</strong>, <strong>CSV (Letterboxd)</strong>, or <strong>Universal CSV</strong>.</li>
      <li><strong>All Custom Lists &amp; Watchlist</strong> &mdash; every list plus watchlist and continue-watching items, as <strong>Export All (CSV)</strong> or <strong>Full Library (JSON)</strong>.</li>
    </ul>
  </section>

  <!-- 11. Self-Hosting Guide -->
  <section class="guide-block" id="self-hosting">
    <div class="block-header">
      <div class="block-icon">11</div>
      <div>
        <h2>11. Self-Hosting on Cloudflare Workers</h2>
        <p style="margin-bottom:0;">Deploy your own dedicated instance in about five minutes on Cloudflare's free tier.</p>
      </div>
    </div>

    <p>Prefer a dedicated instance instead of the shared hosted one at <a href="${origin}/">mylistsaddon.com</a>? The full source is open on GitHub at <a href="https://github.com/Br0ck25/My-Lists" target="_blank" rel="noopener">github.com/Br0ck25/My-Lists</a> &mdash; deploy it to your own free Cloudflare account and it's entirely yours from then on.</p>

    <div class="steps-container">
      <div class="step-card">
        <div class="step-num">1</div>
        <div class="step-body">
          <h4>Create a Worker</h4>
          <p>In the Cloudflare Dashboard, go to <strong>Workers &amp; Pages &rarr; Create &rarr; Create Worker</strong>, give it any name, and deploy the default template.</p>
        </div>
      </div>
      <div class="step-card">
        <div class="step-num">2</div>
        <div class="step-body">
          <h4>Paste the Code</h4>
          <p>Open the Worker, click <strong>Edit code</strong>, delete the placeholder, paste in the full contents of <code>worker_entry_combined.js</code> from the <a href="https://github.com/Br0ck25/My-Lists" target="_blank" rel="noopener">GitHub repository</a>, and click <strong>Deploy</strong>.</p>
        </div>
      </div>
      <div class="step-card">
        <div class="step-num">3</div>
        <div class="step-body">
          <h4>Open Your Worker's URL</h4>
          <p>Your Worker now has a URL like <code>your-worker-name.your-subdomain.workers.dev</code> &mdash; open it to start building your catalog.</p>
        </div>
      </div>
    </div>

    <div class="tip-box">
      <strong>Redeployed but nothing changed?</strong> Your install link is a snapshot of your configuration at the moment you generated it. Redeploying Worker code alone doesn't update an addon you've already installed &mdash; click <strong>Update Link</strong> on the Catalogs tab and reinstall.
    </div>
  </section>

  <!-- 12. FAQ -->
  <section class="guide-block" id="faq">
    <div class="block-header">
      <div class="block-icon">12</div>
      <div>
        <h2>12. Frequently Asked Questions</h2>
        <p style="margin-bottom:0;">Quick answers to common questions and troubleshooting.</p>
      </div>
    </div>

    <div class="faq-item">
      <div class="faq-q">Is My Lists Addon completely free?</div>
      <div class="faq-a">Yes! It runs on your own free Cloudflare Workers account, which comfortably covers normal personal use at no cost. There's no subscription, no ads, and no paid tier. Optional support is available via Buy Me a Coffee.</div>
    </div>
    <div class="faq-item">
      <div class="faq-q">Do I need to sign up or create an account?</div>
      <div class="faq-a">No. Your configuration is encoded directly into your install link, so you can build a catalog and install it in Stremio, Wako, Nuvio, or any other app built on the Stremio addon protocol with zero signup. An optional free Profile exists if you want your lists and watch history synced across multiple devices.</div>
    </div>
    <div class="faq-item">
      <div class="faq-q">Do I need API keys from MDBList, Trakt, TMDB, or Simkl?</div>
      <div class="faq-a">Not for public lists. You only need your own personal key for private lists, personal watchlists, or if you want your own dedicated rate limit instead of the shared one.</div>
    </div>
    <div class="faq-item">
      <div class="faq-q">How do I reorder catalogs on my home screen?</div>
      <div class="faq-a">On the Catalogs tab, click <strong>Edit</strong> in the Live Preview &amp; Editor and drag rows into the order you want, then click <strong>Generate Install Link</strong> (or <strong>Update Link</strong>) and reinstall to apply it.</div>
    </div>
    <div class="faq-item">
      <div class="faq-q">I changed my catalogs but nothing updated on my home screen &mdash; why?</div>
      <div class="faq-a">Your install link encodes your configuration at the time it was generated. Go to Catalogs and click <strong>Update Link</strong>, then reinstall using the new link. If you self-host, note that redeploying the Worker code alone doesn't update an addon you've already installed &mdash; you still need to update and reinstall the link.</div>
    </div>
    <div class="faq-item">
      <div class="faq-q">What's the difference between a Catalog, a List, and a Channel?</div>
      <div class="faq-a">A <strong>Catalog</strong> is a row on your home screen in Stremio, Wako, Nuvio, or any other app built on the Stremio addon protocol &mdash; the end result. A <strong>List</strong> is a named, editable collection of titles that becomes a catalog row once added. A <strong>Channel</strong> is a special catalog that plays episodes continuously like a live TV network.</div>
    </div>
  </section>

  <!-- Footer CTA -->
  <div class="footer-cta">
    <h3>Ready to Customize Your Home Screen?</h3>
    <p>Build your dream Stremio, Wako, and Nuvio catalog setup in under a minute with zero account required.</p>
    <a href="${origin}/" class="btn btn-primary" style="font-size:1.05rem; padding:12px 28px;">Go to mylistsaddon.com &rarr;</a>
  </div>

  <!-- Footer Navigation -->
  <footer class="footer-nav">
    <p>&copy; ${new Date().getFullYear()} ${ADDON_NAME} &bull; <a href="${origin}/">Web App</a> &bull; <a href="https://buymeacoffee.com/brock25" target="_blank" rel="noopener">Support on Buy Me a Coffee</a></p>
  </footer>
</div>

</body>
</html>`;
}


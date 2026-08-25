// --- config JSON export/import (backup / restore) --------------------------
//
// A plain-text alternative to the install link: the same { entries,
// mdblistKey } shape buildConfig() encodes into a base64 URL, but here it's
// left as readable JSON in a textarea -- something to copy into a notes app
// or another device, and paste back in later, without touching the actual
// install link.
function exportConfigJson() {
  const entries = collectEntries();
  if (!entries.length) {
    if (typeof showAppAlert === 'function') showAppAlert('Empty Catalogs', 'Add at least one list first.', false);
    else alert('Add at least one list first.');
    return;
  }
  const keys = collectKeys();
  const payload = { entries };
  if (keys.tmdbKey) payload.tmdbKey = keys.tmdbKey;
  if (keys.tmdbSessionId) payload.tmdbSessionId = keys.tmdbSessionId;
  if (keys.tmdbAccountId) payload.tmdbAccountId = keys.tmdbAccountId;
  if (keys.tmdbUsername) payload.tmdbUsername = keys.tmdbUsername;
  if (keys.mdblistKey) payload.mdblistKey = keys.mdblistKey;
  if (keys.traktKey) payload.traktKey = keys.traktKey;
  if (keys.traktUsername) payload.traktUsername = keys.traktUsername;
  if (keys.traktAccessToken) payload.traktAccessToken = keys.traktAccessToken;
  if (keys.simklKey) payload.simklKey = keys.simklKey;
  if (keys.simklAccessToken) payload.simklAccessToken = keys.simklAccessToken;
  if (keys.simklUsername) payload.simklUsername = keys.simklUsername;
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
// same validation and row-rebuilding either way, just a different source
// for the raw JSON.
function applyImportedConfig(data) {
  if (!data || !Array.isArray(data.entries)) {
    if (typeof showAppAlert === 'function') showAppAlert('Invalid Config', 'That JSON does not look like a My Lists config -- expected an "entries" array.', false);
    else alert('That JSON does not look like a My Lists config -- expected an "entries" array.');
    return;
  }
  document.getElementById('lists').innerHTML = '';
  data.entries.forEach((e) => addRow(e.name, e.url, e.type, e.enabled, e.group, e.id));
  if (data.tmdbKey) {
    const el = document.getElementById('tmdbKeyInput');
    if (el) el.value = data.tmdbKey;
    try { localStorage.setItem('myListAddon:tmdbKey', data.tmdbKey); } catch (e) {}
  }
  if (data.tmdbSessionId) {
    tmdbSessionId = data.tmdbSessionId;
    try { localStorage.setItem('myListAddon:tmdbSessionId', data.tmdbSessionId); } catch (e) {}
  }
  if (data.tmdbAccountId) {
    tmdbAccountId = data.tmdbAccountId;
    try { localStorage.setItem('myListAddon:tmdbAccountId', data.tmdbAccountId); } catch (e) {}
  }
  if (data.tmdbUsername) {
    tmdbUsername = data.tmdbUsername;
    try { localStorage.setItem('myListAddon:tmdbUsername', data.tmdbUsername); } catch (e) {}
  }
  if (typeof renderTmdbConnectStatus === 'function') renderTmdbConnectStatus();
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
  if (data.simklKey) document.getElementById('simklKeyInput').value = data.simklKey;
  if (data.simklAccessToken) {
    simklAccessToken = data.simklAccessToken;
    if (data.simklUsername) simklUsername = data.simklUsername;
    if (typeof renderSimklConnectStatus === 'function') renderSimklConnectStatus();
  }
  renumber();
  checkAllDuplicateUrls();
  saveState();
  renderChannelMergeList();
  if (typeof scheduleMyTmdbListsRefresh === 'function') scheduleMyTmdbListsRefresh();
  scheduleMyMdblistListsRefresh();
  scheduleMyTraktListsRefresh();
  if (typeof scheduleMySimklListsRefresh === 'function') scheduleMySimklListsRefresh();
  if (typeof showAppAlert === 'function') showAppAlert('Import Complete', 'Imported ' + data.entries.length + ' list(s).', true);
  else alert('Imported ' + data.entries.length + ' list(s).');
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
async function importFromLink() {
  const raw = document.getElementById('importLinkInput').value.trim();
  if (!raw) {
    if (typeof showAppAlert === 'function') showAppAlert('Link Required', 'Paste an install link, configure link, or stremio:// / wako:// link first.', false);
    else alert('Paste an install link, configure link, or stremio://\\/wako:// link first.');
    return;
  }
  const cleaned = raw.replace(/^(?:stremio|nuvio|wako):\\/\\//i, 'https://');
  const m = cleaned.match(/\\/([^/]+)\\/(?:manifest\\.json|configure)(?:[/?#]|$)/);
  let config = null;
  if (m) {
    config = m[1];
  } else if (/^[A-Za-z0-9_-]{6,}$/.test(cleaned)) {
    config = cleaned; // looks like a bare config id/token, pasted on its own
  }
  if (!config) {
    if (typeof showAppAlert === 'function') showAppAlert('Invalid Link', 'Could not find a config in that link -- paste the full install link (ending in /manifest.json) or a configure link.', false);
    else alert('Could not find a config in that link -- paste the full install link (ending in /manifest.json) or a configure link.');
    return;
  }
  try {
    const res = await fetch(ORIGIN + '/api/resolve?config=' + encodeURIComponent(config));
    const data = await res.json();
    if (!data.ok) {
      if (typeof showAppAlert === 'function') showAppAlert('Link Error', 'Could not load that link: ' + (data.error || 'unknown error'), false);
      else alert('Could not load that link: ' + (data.error || 'unknown error'));
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
    document.getElementById('importLinkInput').value = '';
    if (typeof showAppAlert === 'function') showAppAlert('Import Complete', 'Imported ' + data.entries.length + ' list(s) from that link.', true);
    else alert('Imported ' + data.entries.length + ' list(s) from that link.');
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

function loadPresetsMap() {
  if (cachedPresetsMap) return cachedPresetsMap;
  try {
    cachedPresetsMap = JSON.parse(localStorage.getItem(PRESETS_KEY) || '{}');
  } catch (e) {
    cachedPresetsMap = {};
  }
  return cachedPresetsMap;
}

function savePresetsMap(map) {
  // Always updates the cache first, even if the localStorage write below
  // fails -- this is what actually keeps a too-big-for-local-storage
  // preset visible and usable for the rest of this page session, whether
  // or not it also successfully persists to disk.
  cachedPresetsMap = map;
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(map));
    return true;
  } catch (e) {
    // Most likely a quota error -- a TV Channel with hundreds of episodes
    // easily runs well past 100KB on its own, and localStorage's total
    // quota is shared across every preset saved plus everything else this
    // add-on keeps there. This used to fail completely silently, which
    // looked exactly like "doesn't work" with no explanation at all --
    // callers now get a false back and can say something useful instead.
    return false;
  }
}

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
  if (!activeCreator) return { ok: false, error: null };
  const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
  if (!creatorKey) return { ok: false, error: null };
  try {
    const presetsB64 = await compressJsonToBase64(presetsMap);
    const res = await fetch(ORIGIN + '/api/creator/sync/save-presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creatorName: activeCreator.creatorName,
        creatorKey: creatorKey,
        presets: presetsB64 ? undefined : presetsMap,
        presetsB64: presetsB64,
      }),
    });
    const data = await res.json().catch(() => null);
    if (!data || data.ok === false) {
      // Logged (not just discarded) so a DevTools console check actually
      // shows what went wrong -- an HTTP status with no JSON body at all
      // usually means the request was killed outright (e.g. Cloudflare's
      // free-plan 10ms CPU budget on this Worker) rather than anything
      // this endpoint's own code returned. Should be rare now that this
      // request no longer bundles config/watchHistory/etc alongside a
      // large presets payload the way the old shared endpoint did.
      console.error('pushPresetsDirectly failed:', res.status, data);
      return { ok: false, error: (data && data.error) || null, status: res.status };
    }
    return { ok: true, error: null };
  } catch (e) {
    console.error('pushPresetsDirectly failed:', e);
    return { ok: false, error: null };
  }
}

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
  const map = loadPresetsMap();
  map[name] = { entries };
  const localOk = savePresetsMap(map);

  if (!localOk) {
    // Local storage is full -- if this account is signed in, push the
    // in-memory map (not a re-read of the stale local copy) straight to
    // the server instead of just failing the same way a local-only setup
    // would. KV values go up to 25MB, comfortably clear of anything a
    // Channel-heavy preset would realistically hit on its own -- though
    // several such presets in the same account can still add up close to
    // that limit (see the size guard on /api/creator/sync/save-presets).
    const pushResult = activeCreator ? await pushPresetsDirectly(map) : { ok: false, error: null };
    if (!pushResult.ok) {
      const errMsg = activeCreator
        ? (pushResult.error
            ? "Could not save this preset to your account: " + pushResult.error
            : "Could not save this preset to your account either — check your connection and try again. If this keeps happening, check the browser console (F12) for more detail.")
        : "Could not save this preset — your browser's local storage is full. This usually happens when a TV Channel with a lot of episodes is included, since each preset stores a full copy of everything in it. Try removing a large Channel from this preset, deleting an older preset you no longer need, using Backup/Restore's 'Download as file' option instead (which isn't limited the same way), or creating a free account so this can be saved there instead of just this browser.";
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
}

function renderPresetsList() {
  const container = document.getElementById('presetsList');
  const badge = document.getElementById('presetsCountBadge');
  const map = loadPresetsMap();
  const names = Object.keys(map).sort();
  if (badge) badge.textContent = names.length ? '(' + names.length + ' saved)' : '';
  if (!names.length) {
    container.innerHTML = '<p><small>No saved presets yet.</small></p>';
    return;
  }
  container.innerHTML = names.map((n) => {
    const count = (map[n].entries || []).length;
    return '<div class="preset-card" data-preset="' + escapeAttr(n) + '">' +
      '<div class="preset-card-header">' +
        '<strong class="preset-card-title">' + escapeHtml(n) + '</strong> <small style="color:var(--muted);">(' + count + ' list' + (count === 1 ? '' : 's') + ')</small>' +
      '</div>' +
      '<div class="preset-actions-grid">' +
        '<button type="button" class="secondary lc-btn preset-load-btn">Load</button>' +
        '<button type="button" class="secondary lc-btn preset-share-btn">Share</button>' +
        '<button type="button" class="secondary lc-btn preset-download-btn">Download</button>' +
        '<button type="button" class="secondary lc-btn preset-delete-btn">Delete</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

document.getElementById('presetsList').addEventListener('click', (e) => {
  const row = e.target.closest('[data-preset]');
  if (!row) return;
  const name = row.getAttribute('data-preset');
  if (e.target.classList.contains('preset-load-btn')) loadPreset(name);
  else if (e.target.classList.contains('preset-share-btn')) sharePreset(name);
  else if (e.target.classList.contains('preset-download-btn')) downloadPreset(name);
  else if (e.target.classList.contains('preset-delete-btn')) deletePreset(name);
});

function loadPreset(name) {
  const map = loadPresetsMap();
  const preset = map[name];
  if (!preset) return;
  document.getElementById('lists').innerHTML = '';
  preset.entries.forEach((e) => addRow(e.name, e.url, e.type, e.enabled, e.group, e.id));
  renumber();
  checkAllDuplicateUrls();
  saveState();
  renderChannelMergeList();
}

function sharePreset(name) {
  const map = loadPresetsMap();
  const preset = map[name];
  if (!preset) return;
  const jsonStr = JSON.stringify({ entries: preset.entries }, null, 2);
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
//
// Shared by both the whole-setup Backup/Restore panel and individual
// presets -- same underlying JSON shape as exportConfigJson/importConfigJson,
// just written to/read from an actual file instead of a textarea, for
// people who'd rather drag a file into a folder than copy-paste text.
function downloadJsonFile(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Reads a chosen file as text and hands it to onParsed(jsonData); shared
// error handling (bad file, invalid JSON) so each upload button only needs
// to say what to do once parsing succeeds. Always clears the file input
// afterward so choosing the same filename again still fires a change event.
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
  const entries = collectEntries();
  if (!entries.length) {
    if (typeof showAppAlert === 'function') showAppAlert('Empty Catalogs', 'Add at least one list first.', false);
    else alert('Add at least one list first.');
    return;
  }
  const keys = collectKeys();
  const payload = { entries };
  if (keys.tmdbKey) payload.tmdbKey = keys.tmdbKey;
  if (keys.tmdbSessionId) payload.tmdbSessionId = keys.tmdbSessionId;
  if (keys.tmdbAccountId) payload.tmdbAccountId = keys.tmdbAccountId;
  if (keys.tmdbUsername) payload.tmdbUsername = keys.tmdbUsername;
  if (keys.mdblistKey) payload.mdblistKey = keys.mdblistKey;
  if (keys.traktKey) payload.traktKey = keys.traktKey;
  if (keys.traktUsername) payload.traktUsername = keys.traktUsername;
  if (keys.traktAccessToken) payload.traktAccessToken = keys.traktAccessToken;
  if (keys.simklKey) payload.simklKey = keys.simklKey;
  if (keys.simklAccessToken) payload.simklAccessToken = keys.simklAccessToken;
  if (keys.simklUsername) payload.simklUsername = keys.simklUsername;
  downloadJsonFile('my-lists-config.json', payload);
}

function uploadConfigFile(input) {
  readJsonFile(input, (data) => applyImportedConfig(data));
}

function downloadPreset(name) {
  const map = loadPresetsMap();
  const preset = map[name];
  if (!preset) return;
  downloadJsonFile((slugify(name) || 'preset') + '.json', { entries: preset.entries });
}

function uploadPresetFile(input) {
  readJsonFile(input, (data, file) => {
    if (!data || !Array.isArray(data.entries)) {
      if (typeof showAppAlert === 'function') showAppAlert('Invalid Preset', 'That file does not look like a preset -- expected an "entries" array.', false);
      else alert('That file does not look like a preset -- expected an "entries" array.');
      return;
    }
    const suggested = (file.name || 'Preset').replace(/\.json$/i, '');
    const name = (prompt('Save this preset as:', suggested) || '').trim();
    if (!name) return;
    const map = loadPresetsMap();
    map[name] = { entries: data.entries };
    savePresetsMap(map);
    renderPresetsList();
    schedulePresetsSync();
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
        entries, mdblistKey: keys.mdblistKey, mdblistAccessToken: keys.mdblistAccessToken, traktKey: keys.traktKey, traktUsername: keys.traktUsername, traktAccessToken: keys.traktAccessToken,
        simklKey: keys.simklKey, simklAccessToken: keys.simklAccessToken,
        track: keys.track, trackCreatorName: keys.trackCreatorName, trackCreatorKey: keys.trackCreatorKey,
        shuffleShelves: keys.shuffleShelves, shuffleItems: keys.shuffleItems,
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
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// pre-fill
suppressSave = true;
const serverEntries = (${initialEntriesJson});
const serverShuffleShelves = ${initialShuffleShelves ? 'true' : 'false'};
const serverShuffleItems = ${initialShuffleItems ? 'true' : 'false'};
if (serverEntries.length) {
  // Opened via a real install/configure link — this is the source of truth.
  serverEntries.forEach(e => addRow(e.name, e.url, e.type, e.enabled, e.group, e.id));
  if (document.getElementById('shuffleShelvesCheckbox')) {
    document.getElementById('shuffleShelvesCheckbox').checked = serverShuffleShelves;
  }
  if (document.getElementById('shuffleItemsCheckbox')) {
    document.getElementById('shuffleItemsCheckbox').checked = serverShuffleItems;
  }
} else {
  // Fresh visit to the plain builder page — restore whatever was left off
  // last time, if anything was saved.
  const saved = loadSavedState();
  if (saved && Array.isArray(saved.entries) && saved.entries.length) {
    saved.entries.forEach(e => addRow(e.name, e.url, e.type, e.enabled, e.group, e.id));
  }
  if (saved && document.getElementById('shuffleShelvesCheckbox')) {
    document.getElementById('shuffleShelvesCheckbox').checked = !!saved.shuffleShelves;
  }
  if (saved && document.getElementById('shuffleItemsCheckbox')) {
    document.getElementById('shuffleItemsCheckbox').checked = !!saved.shuffleItems;
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
    const map = typeof loadLocalCustomLists === 'function' ? loadLocalCustomLists() : {};
    const list = map[slug] || null;
    const name = list ? (list.name || (typeof deslugify === 'function' ? deslugify(slug) : slug)) : (typeof deslugify === 'function' ? deslugify(slug) : slug);
    const type = (list && list.type) ? list.type : 'movie';
    openListDetailsPage(name, type, 'custom:' + slug, list ? { sample: list.items, maybeMore: false } : null, { skipPushState: true });
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

  if ((state && state.view === 'list') || isListPath) {
    const listKey = state ? ((state.name || '') + '::' + (state.listUrl || '')) : '';
    const currentListKey = window._currentListDetailsKey || '';
    const gridEl = document.getElementById('detailGrid');
    if (gridEl && gridEl.children.length > 0 && (!listKey || currentListKey === listKey || !state)) {
      switchTab('list-details');
      if (typeof window._listScrollY === 'number') {
        const targetScroll = window._listScrollY;
        window.scrollTo({ top: targetScroll, behavior: 'instant' });
        requestAnimationFrame(() => {
          window.scrollTo({ top: targetScroll, behavior: 'instant' });
          setTimeout(() => {
            window.scrollTo({ top: targetScroll, behavior: 'instant' });
          }, 50);
        });
      }
      return;
    }
    if (state && state.view === 'list') {
      openListDetailsPage(state.name, state.type, state.listUrl, null, { skipPushState: true, restoreScrollY: window._listScrollY });
    }
  } else if ((state && state.view === 'item') || hash.startsWith('#/item?')) {
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
</script>

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
  const title = `${ADDON_NAME} — How to Turn MDBList, Trakt, TMDB & Simkl Lists Into Stremio Catalogs`;
  const description =
    "Step-by-step guide to turning any MDBList, Trakt, TMDB, or Simkl list into a Stremio/wako catalog row -- plus why self-hosting on your own free Cloudflare account beats a hosted list addon, a provider comparison, and answers to common questions.";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#F2F2F7">
<title>${title}</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${origin}/guide">
<meta name="robots" content="index, follow">
<meta property="og:type" content="article">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${origin}/guide">
<meta property="og:image" content="${origin}/icon.png">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
<link rel="icon" type="image/png" href="${origin}/icon.png">
<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: "Is this add-on free?",
        acceptedAnswer: {
          "@type": "Answer",
          text:
            "Yes. It runs on your own free Cloudflare Workers account, which comfortably covers normal personal use at no cost. There's no subscription, no ads, and no paid tier -- optional support is available via Buy Me a Coffee, but nothing is gated behind it.",
        },
      },
      {
        "@type": "Question",
        name: "Do I need to create an account to use it?",
        acceptedAnswer: {
          "@type": "Answer",
          text:
            "No. Your configuration is encoded directly into your install link, so you can build a catalog and install it in Stremio or wako with zero signup. An optional free Creator Profile exists if you want your lists and watch history synced across multiple devices.",
        },
      },
      {
        "@type": "Question",
        name: "Do I need API keys from MDBList, Trakt, TMDB, or Simkl?",
        acceptedAnswer: {
          "@type": "Answer",
          text:
            "Not for public lists. Public mdblist.com list URLs work with no key at all. Trakt and TMDB require a key on every request even for public data, but the deployment already includes a shared key for that. You only need your own personal key for private lists, personal watchlists, or higher usage.",
        },
      },
      {
        "@type": "Question",
        name: "What's the difference between self-hosting this and using a hosted list addon?",
        acceptedAnswer: {
          "@type": "Answer",
          text:
            "A hosted addon runs on someone else's server, under someone else's account, subject to someone else's uptime and rate limits. Self-hosting this on your own Cloudflare account means your configuration and watch data live in your own storage, nothing runs unless you deployed it, and there's no third party in the middle of your Stremio catalog.",
        },
      },
    ],
  })}</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600;700&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #F2F2F7; --surface: #FFFFFF; --text: #1C1C1E; --text-2: #3A3A3C;
    --muted: #8E8E93; --accent: #007AFF; --border: rgba(0,0,0,0.08);
    --border-strong: rgba(0,0,0,0.13); --radius: 14px; --radius-sm: 10px;
    --shadow-sm: 0 1px 3px rgba(0,0,0,0.06);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    font-size: 16px; line-height: 1.6; -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 760px; margin: 0 auto; padding: 32px 20px 80px; }
  a { color: var(--accent); }
  .top-nav { display: flex; align-items: center; justify-content: space-between; margin-bottom: 28px; }
  .top-nav .brand { font-weight: 800; font-size: 1.1rem; color: var(--text); text-decoration: none; }
  .top-nav .back-link { font-size: 0.9rem; font-weight: 600; text-decoration: none; }
  h1 {
    font-family: 'Space Grotesk', 'Inter', sans-serif;
    font-size: 2rem; font-weight: 700; letter-spacing: -0.02em;
    margin: 0 0 10px; line-height: 1.2;
  }
  .lede { color: var(--text-2); font-size: 1.05rem; margin: 0 0 28px; }
  h2 {
    font-family: 'Space Grotesk', 'Inter', sans-serif;
    font-size: 1.35rem; font-weight: 700; margin: 40px 0 12px; letter-spacing: -0.01em;
  }
  h3 { font-size: 1.05rem; font-weight: 700; margin: 22px 0 6px; }
  p { color: var(--text-2); margin: 0 0 14px; }
  code {
    background: rgba(0,0,0,0.05); border: 1px solid var(--border);
    border-radius: 5px; padding: 1px 6px; font-size: 0.88em;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
  }
  .card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 18px 20px; margin: 14px 0;
    box-shadow: var(--shadow-sm);
  }
  table { width: 100%; border-collapse: collapse; margin: 12px 0 20px; font-size: 0.92rem; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--muted); font-weight: 700; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.03em; }
  ol, ul { color: var(--text-2); padding-left: 22px; }
  li { margin-bottom: 6px; }
  .toc { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 32px; }
  .toc a {
    font-size: 0.85rem; font-weight: 600; text-decoration: none;
    background: var(--surface); border: 1px solid var(--border-strong);
    border-radius: 999px; padding: 6px 13px; color: var(--text-2);
  }
  .cta {
    display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
    gap: 14px; background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 20px 22px; margin: 36px 0 8px;
  }
  .cta-btn {
    background: var(--accent); color: #fff; text-decoration: none;
    font-weight: 700; font-size: 0.95rem; padding: 11px 22px;
    border-radius: 999px; white-space: nowrap;
  }
  .faq-q { font-weight: 700; margin: 18px 0 4px; }
  footer { margin-top: 48px; padding-top: 18px; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.85rem; }
  :root.dark-theme, .dark-theme {
    --bg: #000; --surface: #1C1C1E; --text: #FFF; --text-2: #EBEBF5;
    --border: rgba(255,255,255,0.15); --border-strong: rgba(255,255,255,0.25);
  }
</style>
<script>
  if (localStorage.getItem('theme') === 'dark' || (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark-theme');
  }
</script>
</head>
<body>
<div class="wrap">
  <div class="top-nav">
    <a class="brand" href="${origin}/">${ADDON_NAME}</a>
    <a class="back-link" href="${origin}/">&larr; Back to the builder</a>
  </div>

  <h1>How to Turn MDBList, Trakt, TMDB &amp; Simkl Lists Into Stremio Catalogs</h1>
  <p class="lede">A self-hosted way to get any list — public or your own — onto your Stremio or wako home screen as a real catalog row, running entirely on your own free Cloudflare account.</p>

  <div class="toc">
    <a href="#mdblist">MDBList</a>
    <a href="#trakt">Trakt</a>
    <a href="#tmdb">TMDB</a>
    <a href="#simkl">Simkl</a>
    <a href="#self-hosted">Why self-host</a>
    <a href="#comparison">Which provider?</a>
    <a href="#faq">FAQ</a>
  </div>

  <p>All four steps below start the same way: open <a href="${origin}/">${origin.replace("https://", "").replace("http://", "")}</a>, paste a list URL into the builder, and click install. What changes is where you get the URL from and what it unlocks.</p>

  <h2 id="mdblist">MDBList lists</h2>
  <p>Works with no API key at all for public lists. Go to <a href="https://mdblist.com" target="_blank" rel="noopener">mdblist.com</a>, open any public list (your own or someone else's), and copy its URL — it looks like <code>mdblist.com/lists/username/list-name</code>. Paste that straight into the builder and it becomes a catalog row.</p>
  <p>Private MDBList lists and the "My Watchlist" quick-add need your own free MDBList API key, pasted into Settings once.</p>

  <h2 id="trakt">Trakt lists</h2>
  <p>Public Trakt lists work out of the box — no account needed. Copy a list URL in the form <code>trakt.tv/users/username/lists/list-slug</code> and paste it in. Trakt's own trending and popular charts are available as one-tap Quick Add shelves too.</p>
  <p>To pull in your own private lists, liked lists, watchlist, or watch history, connect your Trakt account from Settings — this uses Trakt's own OAuth login, so your credentials never pass through anything but Trakt itself.</p>

  <h2 id="tmdb">TMDB lists</h2>
  <p>Paste any public <code>themoviedb.org/list/12345</code> URL to add it as a catalog. TMDB also powers this add-on's genre, network, streaming-provider, and keyword charts, plus episode/season data for Continue Watching.</p>

  <h2 id="simkl">Simkl charts</h2>
  <p>Simkl's trending charts (daily, weekly, monthly, across movies, TV, and anime) are available as one-tap Quick Add shelves. Connecting a Simkl account additionally unlocks importing your own lists and watch history.</p>

  <h2 id="self-hosted">Why self-host instead of a hosted list addon?</h2>
  <p>Most Stremio catalog add-ons in this space run as a hosted service — you're pointing your Stremio app at someone else's server, using someone else's account, subject to someone else's uptime, rate limits, and whatever happens to that service down the road.</p>
  <p>This add-on is different: you deploy it to your own free Cloudflare Workers account in about five minutes, and from then on it's entirely yours. Your configuration lives in your install link or your own Cloudflare storage — never on a third party's server. Nothing runs unless you deployed it. There's no subscription because there's nothing to subscribe to; Cloudflare's free tier comfortably covers normal personal use.</p>
  <p>The tradeoff is honest: self-hosting takes those five minutes of setup a hosted service skips. In exchange you get a catalog that's actually yours.</p>

  <h2 id="comparison">MDBList vs. Trakt vs. TMDB vs. Simkl — which should I use?</h2>
  <table>
    <tr><th>Provider</th><th>Best for</th><th>Needs a key?</th></tr>
    <tr><td><strong>MDBList</strong></td><td>Curated public lists, community charts, the simplest path with zero setup</td><td>No, for public lists</td></tr>
    <tr><td><strong>Trakt</strong></td><td>Your own watch history, watchlist, and lists if you already use Trakt to track what you watch</td><td>Only for private/personal data</td></tr>
    <tr><td><strong>TMDB</strong></td><td>Genre/network/streaming-provider charts, episode &amp; season metadata</td><td>No, for public lists and charts</td></tr>
    <tr><td><strong>Simkl</strong></td><td>Trending charts, especially for anime</td><td>Only for personal data</td></tr>
  </table>
  <p>None of these are exclusive — most people mix all four on one home screen, since they're just different sources feeding into the same catalog builder.</p>

  <h2 id="faq">Frequently asked questions</h2>
  <div class="faq-q">Is this add-on free?</div>
  <p>Yes. It runs on your own free Cloudflare Workers account, which comfortably covers normal personal use at no cost. There's no subscription, no ads, and no paid tier.</p>
  <div class="faq-q">Do I need to create an account to use it?</div>
  <p>No. Your configuration is encoded directly into your install link, so you can build a catalog and install it in Stremio or wako with zero signup. An optional free Creator Profile exists if you want your lists and watch history synced across multiple devices.</p>
  <div class="faq-q">Do I need API keys from MDBList, Trakt, TMDB, or Simkl?</div>
  <p>Not for public lists. You only need your own personal key for private lists, personal watchlists, or if you're doing enough browsing that you want your own dedicated rate limit instead of the shared one.</p>
  <div class="faq-q">What's the difference between self-hosting this and using a hosted list addon?</div>
  <p>A hosted addon runs on someone else's server under someone else's account. Self-hosting this on your own Cloudflare account means your configuration and watch data live in your own storage, and there's no third party in the middle of your Stremio catalog.</p>

  <div class="cta">
    <div>
      <strong>Ready to build your own catalog?</strong>
      <div style="color:var(--muted); font-size:0.88rem; margin-top:2px;">Takes about five minutes, no account required.</div>
    </div>
    <a class="cta-btn" href="${origin}/">Open the builder &rarr;</a>
  </div>

  <footer>
    ${ADDON_NAME} is free and open, self-hosted on Cloudflare Workers. <a href="https://buymeacoffee.com/brock25" target="_blank" rel="noopener">Support the project</a>.
  </footer>
</div>
</body>
</html>`;
}


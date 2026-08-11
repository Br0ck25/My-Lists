async function fetchAllItemsForList(listUrl, type, btn, progressLabel) {
  const keys = collectKeys();
  const items = [];
  let skip = 0;
  let pagesLoaded = 0;
  const MAX_PAGES = 250; // safety cap (~25,000 items) -- generous headroom above the
  // 6000-item-per-list cap below so a big Watch History copy can still split across
  // several numbered lists instead of silently truncating (see copyListToCustomList)
  while (pagesLoaded < MAX_PAGES) {
    const body = { url: listUrl, type: type, skip: skip, sample: 100 };
    if (keys.mdblistKey) body.mdblistKey = keys.mdblistKey;
    if (keys.traktKey) body.traktKey = keys.traktKey;
    if (keys.traktAccessToken) body.traktAccessToken = keys.traktAccessToken;
    const res = await fetch(ORIGIN + '/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'unknown error');
    const pageItems = data.sample || [];
    pageItems.forEach((m) => {
      items.push({ imdbId: m.id, title: m.name, year: m.year || '', poster: m.poster || null, showTitle: m.showTitle || null });
    });
    skip += pageItems.length;
    pagesLoaded++;
    if (btn) btn.textContent = 'Copying' + (progressLabel ? ' ' + progressLabel : '') + '\u2026 (' + items.length + ' so far)';
    if (!data.maybeMore || pageItems.length === 0) break;
  }
  return items;
}

// Saves a fresh Custom List directly -- to the account if signed in
// (mirroring confirmSaveAsCreator's /api/creator/lists/save call, Public
// by default same as that picker's own default), to this browser's local
// store otherwise (mirroring saveLocalCustomList). Unlike either of those,
// there's no existing row/draft involved here at all -- this always
// creates a brand new saved list, never edits one in place.
async function saveItemsAsNewCustomList(name, type, items, visibility) {
  visibility = visibility === 'private' ? 'private' : 'public';
  if (activeCreator) {
    const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
    try {
      const res = await fetch(ORIGIN + '/api/creator/lists/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          creatorName: activeCreator.creatorName,
          creatorKey: creatorKey,
          name: name,
          type: type,
          items: items,
          visibility: visibility,
        }),
      });
      const data = await res.json();
      if (!data.ok) return { ok: false, error: data.error || 'unknown error' };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: 'network error' };
    }
  }
  const map = loadLocalCustomLists();
  const base = slugify(name) || 'list';
  let slug = base;
  let n = 2;
  while (map[slug]) {
    slug = base + '-' + n;
    n++;
  }
  const now = Date.now();
  map[slug] = { slug: slug, name: name, type: type, items: items, visibility: visibility, createdAt: now, updatedAt: now };
  const persisted = saveLocalCustomListsMap(map);
  if (!persisted) {
    return { ok: false, error: 'localStorage save failed (likely full \u2014 try clearing out some old Custom Lists, or importing fewer categories at once)' };
  }
  return { ok: true };
}

// Copies a Trakt (or any) list straight into a saved Custom List -- no
// detour through the draft picker for a manual "Save as a List" click,
// since there's nothing to review here that isn't already decided (the
// whole list, as-is). Unlike the live "+ Add" button (which keeps
// re-fetching the source every time the catalog loads), this is a one-time
// snapshot: useful for a private Trakt list specifically, since the copy
// keeps working on its own even after the Trakt connection eventually
// expires, where a live row referencing that same private list would stop
// resolving once it does.
//
// A Custom List can only ever be one type (movies or shows, never mixed --
// same rule the manual picker already enforces), but a source list often
// isn't -- a Trakt watchlist especially. So an ambiguous/mixed source
// (contentType anything other than a clean 'movie' or 'series') gets
// copied as *two* separate Custom Lists instead of one, each named with a
// "(Movies)"/"(Shows)" suffix to tell them apart, silently skipping
// whichever half turns out to have nothing in it (e.g. a "mixed"-looking
// list that's actually all movies).
// Per-list item cap for Copy to Custom List -- a source bigger than this
// splits across multiple numbered lists (see copyListToCustomList) rather
// than truncating or growing one list without bound.
const CUSTOM_LIST_CHUNK_SIZE = 6000;

async function copyListToCustomList(name, listUrl, contentType, btn, historyMode) {
  const typesToCopy = contentType === 'movie' || contentType === 'series' ? [contentType] : ['movie', 'series'];
  const isSplit = typesToCopy.length > 1;
  // Restored on the way out below -- this is called from several different
  // buttons (search results, My Lists, and the Custom List panel's own
  // "Import from link"), each with its own resting label, so hardcoding one
  // back would leave the others mislabeled after their first use.
  const originalLabel = btn ? btn.textContent : '';

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Copying\u2026';
  }

  const created = [];
  const failed = [];
  for (const type of typesToCopy) {
    const typeLabel = type === 'movie' ? 'Movies' : 'Shows';
    let items;
    try {
      items = await fetchAllItemsForList(listUrl, type, btn, isSplit ? typeLabel : '');
    } catch (e) {
      failed.push({ name: isSplit ? name + ' (' + typeLabel + ')' : name, error: e.message || 'network error' });
      continue;
    }
    if (!items.length) continue; // e.g. a "mixed" list that turns out to be all one type -- skip the empty half quietly
    // Watch History's per-episode rows all carry the same show id with a
    // "Show S1E5 \u2014 Title" name (see mapTraktHistoryItems) -- Shows mode
    // collapses that down to one tile per show (first occurrence wins,
    // since history comes back most-recently-watched first) using the
    // plain showTitle field carried alongside each item for exactly this.
    // Only ever applies to type 'series' items that actually have one;
    // everything else (movies, any other list) passes through untouched.
    if (historyMode === 'shows' && type === 'series') {
      const seen = new Map();
      items.forEach((it) => {
        if (!seen.has(it.imdbId)) {
          seen.set(it.imdbId, { imdbId: it.imdbId, title: it.showTitle || it.title, year: it.year, poster: it.poster });
        }
      });
      items = Array.from(seen.values());
    }
    // showTitle was only ever needed for the dedupe step above -- strip it
    // before saving so a Custom List's items stay the same shape they've
    // always been.
    items = items.map((it) => ({ imdbId: it.imdbId, title: it.title, year: it.year, poster: it.poster }));
    const baseListName = isSplit ? name + ' (' + typeLabel + ')' : name;
    // A single Custom List is capped at CUSTOM_LIST_CHUNK_SIZE items. A
    // source bigger than that (mainly a large Watch History copy, since
    // that source is the raw undeduped episode-watch feed -- see
    // fetchTraktHistory) gets split across multiple numbered lists
    // ("Name", "Name 2", "Name 3"...) instead of the old flat 2000-item
    // cap, which silently truncated mid-history with no way to get the rest.
    for (let i = 0; i * CUSTOM_LIST_CHUNK_SIZE < items.length; i++) {
      const chunk = items.slice(i * CUSTOM_LIST_CHUNK_SIZE, (i + 1) * CUSTOM_LIST_CHUNK_SIZE);
      const listName = i === 0 ? baseListName : baseListName + ' ' + (i + 1);
      const result = await saveItemsAsNewCustomList(listName, type, chunk, 'private');
      if (result.ok) {
        created.push({ name: listName, count: chunk.length });
      } else {
        failed.push({ name: listName, error: result.error });
      }
    }
  }

  if (btn) {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }

  if (!created.length && !failed.length) {
    alert('That list has no items to copy.');
    return;
  }
  if (created.length) renderCreatorDashboard();

  let msg = '';
  if (created.length) {
    msg += 'Created ' + created.map((c) => '"' + c.name + '" (' + c.count + ' item' + (c.count === 1 ? '' : 's') + ')').join(' and ') +
      ' in your Custom Lists \u2014 find them under the Custom Lists tab to add them to your lists.';
  }
  if (failed.length) {
    msg += (msg ? '\\n\\n' : '') + 'Could not copy: ' + failed.map((f) => f.name + ' (' + f.error + ')').join(', ');
  }
  alert(msg);
}

// --- Import from Trakt export --------------------------------------------
//
// Trakt VIP's own export (Settings > Data > Export on trakt.tv) is a .zip
// of the account's data as JSON, one file (or numbered file series) per
// category -- and every category turns out to be exactly the shape
// Trakt's own REST API already returns (see mapTraktItems /
// mapTraktHistoryItems), just dumped straight to disk rather than a
// custom export schema. Parsed entirely client-side with fflate (loaded
// in <head>) -- the zip never reaches this Worker, matching the rest of
// this add-on's local-first approach to personal data.
let traktExportZipEntries = null; // { filename: Uint8Array }, set once a zip is picked

const TRAKT_EXPORT_CATEGORIES = [
  // These patterns need DOUBLED backslashes in source (\\d, \\.) even
  // though a real regex only wants a single backslash-d / backslash-dot --
  // this whole block sits inside renderBuilder()'s giant outer template
  // literal, so the outer literal's own escape parsing runs over this
  // text once already (at Worker-render time) before it ever reaches the
  // browser. A single backslash-d isn't a recognized JS string escape, so
  // that pass silently drops the backslash and leaves a bare "d" -- which
  // is exactly what shipped here originally and is why History (and half
  // of Watched) never matched any files despite the filenames being right
  // there. Same root cause as this codebase's documented newline-escaping
  // trap, just hitting a regex instead of a literal newline. Verified
  // post-render this time (extracted the actual rendered client script
  // and confirmed the backslashes survive), not just eyeballed.
  { key: 'history', label: 'Watch History', filePattern: /^watched-history-\\d+\\.json$/ },
  { key: 'watched', label: 'Watched (all-time list)', filePattern: /^watched-(movies-\\d+|shows(-\\d+)?)\\.json$/ },
  { key: 'watchlist', label: 'Watchlist', filePattern: /^lists-watchlist\\.json$/ },
  { key: 'ratings', label: 'Ratings', filePattern: /^ratings-(movies|shows)\\.json$/ },
];

// Returns { items, matchedFiles, errors } rather than just an item array --
// if a category's files exist in the zip but come back with zero items,
// this lets the caller tell "nothing in the export" apart from "found the
// files but couldn't parse them", and surface the real reason instead of
// just silently omitting the category (which is what happened before this
// -- see the debugging note below).
function readTraktExportJsonFiles(pattern) {
  const items = [];
  const errors = [];
  let matchedFiles = 0;
  for (const filename in traktExportZipEntries) {
    // Match on the basename only, not the full zip path -- Trakt's export
    // structure isn't guaranteed stable release to release (this add-on
    // has already seen it both flat and, apparently, occasionally folder-
    // nested), and matching the full path against an anchored pattern
    // would silently miss every file if a folder prefix shows up, with no
    // visible error at all since a 0-match category isn't treated as a
    // failure below.
    const basename = filename.split('/').pop() || filename;
    if (!pattern.test(basename)) continue;
    matchedFiles++;
    try {
      const text = fflate.strFromU8(traktExportZipEntries[filename]);
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) items.push.apply(items, parsed);
    } catch (e) {
      errors.push(filename + ': ' + (e && e.message ? e.message : String(e)));
    }
  }
  return { items: items, matchedFiles: matchedFiles, errors: errors };
}

document.getElementById('traktExportFileInput').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  const box = document.getElementById('traktExportImportResult');
  if (!file || !box) return;
  box.innerHTML = '<p style="margin-top:10px;"><small>Reading zip\u2026</small></p>';
  try {
    if (typeof fflate === 'undefined') {
      throw new Error('the zip-reading library (fflate, loaded from a CDN) never loaded \u2014 check your network connection or an ad/script blocker, then reload the page and try again');
    }
    const buf = await file.arrayBuffer();
    traktExportZipEntries = fflate.unzipSync(new Uint8Array(buf));
    // Debug aid: if a category still doesn't show up as a checkbox below,
    // open devtools and check this list against TRAKT_EXPORT_CATEGORIES'
    // patterns above -- Trakt's export layout isn't guaranteed stable.
    console.log('Trakt export zip contains:', Object.keys(traktExportZipEntries));
  } catch (err) {
    box.innerHTML = '<p class="testresult err">\u2717 Could not read that zip: ' + escapeHtml(err && err.message ? err.message : String(err)) + '</p>';
    return;
  }
  const diagnostics = [];
  const rowsHtml = TRAKT_EXPORT_CATEGORIES.map((cat) => {
    const result = readTraktExportJsonFiles(cat.filePattern);
    if (!result.matchedFiles) return ''; // this category's file(s) just aren't in this zip -- not an error
    if (!result.items.length) {
      // Files matched the expected name pattern but every one of them
      // failed to parse -- surface exactly why instead of quietly
      // dropping the category (this is the case James hit: the checkbox
      // for a whole category just never appeared, with no explanation).
      diagnostics.push(cat.label + ': found ' + result.matchedFiles + ' file(s) but couldn\u2019t read any of them \u2014 ' + result.errors.slice(0, 2).join('; '));
      return '';
    }
    // History is the one category with episode-level rows (see
    // mapTraktExportEntry) -- give it a Shows/Episodes choice right under
    // its checkbox, same idea as the Copy to Custom List toggle for the
    // live version of this same source. Every other category is already
    // whole-title data, no such choice to make.
    const historyToggle = cat.key === 'history'
      ? '<div style="margin-left:24px; margin-top:4px;"><small>' +
        '<label><input type="radio" name="traktExportHistoryMode" value="shows" checked> Shows only</label>' +
        ' &nbsp; <label><input type="radio" name="traktExportHistoryMode" value="episodes"> Individual episodes</label>' +
        '</small></div>' +
        // Deliberately independent of the Shows/Episodes radio above --
        // that radio only controls how the *Custom List* folds rows for
        // display; Watch History always needs the real per-episode
        // identifiers regardless, which mapTraktExportEntryToWatchHistoryItem
        // reads straight off each raw row.
        '<div style="margin-left:24px; margin-top:4px;"><small>' +
        '<label><input type="checkbox" id="traktExportMarkWatchedCheck" checked> Also add these to Watch History &amp; Continue Watching (marks them watched)</label>' +
        '</small></div>'
      : '';
    return '<div class="row searchresult-row" style="flex-direction:column; align-items:flex-start;">' +
      '<div><label><input type="checkbox" class="traktExportCatCheck" value="' + cat.key + '" checked> <strong>' + cat.label + '</strong> \u2014 ' + result.items.length + ' entries</label></div>' +
      historyToggle +
      '</div>';
  }).join('');
  const diagnosticsHtml = diagnostics.length
    ? '<p class="testresult err">\u2717 ' + diagnostics.map(escapeHtml).join('<br>') + '</p>'
    : '';
  if (!rowsHtml) {
    box.innerHTML = diagnosticsHtml || '<p class="testresult err">\u2717 Didn\u2019t recognize any Trakt export files in that zip.</p>';
    return;
  }
  box.innerHTML = '<p style="margin-top:10px;"><small>Found these categories \u2014 pick which to import (each becomes its own Custom List, split into Movies/Shows automatically, deduped so a rewatched title only appears once):</small></p>' +
    rowsHtml + diagnosticsHtml +
    '<div class="actions" style="flex-direction:row; width:auto; margin-top:8px;">' +
    '<button type="button" class="secondary" id="traktExportImportBtn">Import selected</button>' +
    '</div>';
  const importBtn = document.getElementById('traktExportImportBtn');
  if (importBtn) importBtn.addEventListener('click', runTraktExportImport);
});

// Maps one raw exported row (a history/watchlist/ratings entry) to the
// {imdbId, title, year, type} shape needed before it becomes a Custom
// List item. History's episode rows default to folding up to their parent
// show (a Custom List is normally a flat title picker with no per-episode
// concept), but historyMode === 'episodes' (from the radio under the
// History checkbox) keeps each one as its own "Show S1E5 \u2014 Title" row
// instead, same style mapTraktHistoryItems already uses for the live
// version of this source -- carrying a dedupeKey scoped to the exact
// episode rather than just the show, so a rewatched episode still
// collapses to one row but distinct episodes of the same show don't.
function mapTraktExportEntry(it, category, historyMode) {
  if (category === 'history' && it.type === 'episode' && it.show && it.show.ids && it.show.ids.imdb) {
    if (historyMode === 'episodes') {
      const s = it.episode.season;
      const e = it.episode.number;
      const epTitle = it.episode.title ? ' \u2014 ' + it.episode.title : '';
      return {
        imdbId: it.show.ids.imdb,
        title: it.show.title + ' S' + s + 'E' + e + epTitle,
        year: it.show.year || '',
        type: 'series',
        dedupeKey: it.show.ids.imdb + ':' + s + ':' + e,
      };
    }
    return { imdbId: it.show.ids.imdb, title: it.show.title, year: it.show.year || '', type: 'series' };
  }
  const obj = it.movie || it.show || null;
  if (!obj || !obj.ids || !obj.ids.imdb) return null;
  return { imdbId: obj.ids.imdb, title: obj.title, year: obj.year || '', type: it.movie ? 'movie' : 'series' };
}

// Maps one raw History row to the shape addItemsToWatchHistory expects --
// used by the "Also add these to Watch History" checkbox. An episode row
// needs a real TMDB episode id (the same id space Watch History uses
// everywhere else in this add-on, e.g. toggleWatchStatus/markSeasonWatched)
// to key on; Trakt's own export includes one at it.episode.ids.tmdb, so a
// row missing that (older export format, or an episode TMDB has since
// delisted) is skipped rather than guessed at with a Trakt-specific id
// that nothing else in this app would recognize.
function mapTraktExportEntryToWatchHistoryItem(it) {
  if (it.type === 'episode' && it.show && it.show.ids && it.show.ids.imdb && it.episode) {
    const epId = it.episode.ids && it.episode.ids.tmdb ? String(it.episode.ids.tmdb) : null;
    if (!epId) return null;
    const showPoster = 'https://images.metahub.space/poster/medium/' + it.show.ids.imdb + '/img';
    return {
      id: epId,
      type: 'episode',
      name: it.episode.title || '',
      // Trakt's export carries no per-episode still image -- fall back to
      // the show poster (see this function's own comment above).
      poster: showPoster,
      showId: it.show.ids.imdb,
      showTitle: it.show.title || '',
      showPoster: showPoster,
      seasonNum: it.episode.season,
      episodeNum: it.episode.number,
    };
  }
  const obj = it.movie;
  if (!obj || !obj.ids || !obj.ids.imdb) return null;
  return {
    id: obj.ids.imdb,
    type: 'movie',
    name: obj.title || '',
    poster: 'https://images.metahub.space/poster/medium/' + obj.ids.imdb + '/img',
  };
}

async function runTraktExportImport() {
  const btn = document.getElementById('traktExportImportBtn');
  const catChecked = new Set(Array.from(document.querySelectorAll('.traktExportCatCheck:checked')).map((c) => c.value));
  const historyModeEl = document.querySelector('input[name="traktExportHistoryMode"]:checked');
  const historyMode = historyModeEl ? historyModeEl.value : 'shows';
  const markWatchedEl = document.getElementById('traktExportMarkWatchedCheck');
  const markWatched = !!(markWatchedEl && markWatchedEl.checked);
  // A category is worth processing here if either its own "create a
  // Custom List" checkbox is on, or (History only) "mark as watched" is on
  // -- these are independent choices, not one gating the other, so
  // someone can mark History as watched without also wanting a redundant
  // "Trakt Watch History" Custom List cluttering their Custom Lists tab.
  const relevantCats = TRAKT_EXPORT_CATEGORIES.filter((cat) => catChecked.has(cat.key) || (cat.key === 'history' && markWatched));
  if (!relevantCats.length) { alert('Pick at least one category first.'); return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Importing\u2026'; }

  const created = [];
  const failed = [];
  let watchedAdded = 0;
  let cwSucceeded = 0;
  let cwTotal = 0;
  for (const cat of relevantCats) {
    const catKey = cat.key;
    const rawItems = readTraktExportJsonFiles(cat.filePattern).items;

    if (catChecked.has(catKey)) {
      const byType = { movie: new Map(), series: new Map() };
      rawItems.forEach((it) => {
        const mapped = mapTraktExportEntry(it, cat.key, historyMode);
        if (!mapped) return;
        // Dedupe within each type -- unlike the live "Watch History" catalog
        // row (which deliberately keeps every rewatch as its own tile), a
        // Custom List is a browsable collection, not a rewatch log. Shows
        // mode dedupes by show id (a title watched several times only
        // appears once); Episodes mode dedupes by the finer-grained
        // dedupeKey mapTraktExportEntry attaches instead, so distinct
        // episodes of the same show still both appear.
        byType[mapped.type].set(mapped.dedupeKey || mapped.imdbId, mapped);
      });
      for (const type of ['movie', 'series']) {
        const items = Array.from(byType[type].values()).map((m) => ({
          imdbId: m.imdbId,
          title: m.title,
          year: m.year,
          // The export carries no poster art of its own -- same metahub
          // fallback mapTraktItems already uses for every other Trakt source.
          poster: 'https://images.metahub.space/poster/medium/' + m.imdbId + '/img',
        }));
        if (!items.length) continue;
        const typeLabel = type === 'movie' ? 'Movies' : 'Shows';
        const listName = 'Trakt ' + cat.label + ' (' + typeLabel + ')';
        // Debug aid: if a list still silently doesn't appear after this,
        // devtools console will show exactly which save call failed and why.
        console.log('Trakt export import: saving', listName, '-', items.length, 'items\u2026');
        const result = await saveItemsAsNewCustomList(listName, type, items, 'private');
        console.log('Trakt export import: result for', listName, '->', result);
        if (result.ok) {
          created.push({ name: listName, count: items.length });
        } else {
          failed.push({ name: listName, error: result.error });
        }
      }
    }

    if (catKey === 'history' && markWatched) {
      const whItems = [];
      const seenIds = new Set();
      rawItems.forEach((it) => {
        const mapped = mapTraktExportEntryToWatchHistoryItem(it);
        if (!mapped || seenIds.has(mapped.id)) return; // a rewatch logs one row per play -- Watch History only needs one entry per item
        seenIds.add(mapped.id);
        whItems.push(mapped);
      });
      if (whItems.length && typeof addItemsToWatchHistory === 'function') {
        if (btn) btn.textContent = 'Checking Continue Watching for ' + new Set(whItems.filter((it) => it.showId).map((it) => it.showId)).size + ' show(s)\u2026';
        const whResult = await addItemsToWatchHistory(whItems);
        watchedAdded += whResult.added;
        cwSucceeded += whResult.cwSucceeded || 0;
        cwTotal += whResult.cwTotal || 0;
      }
    }
  }

  if (btn) { btn.disabled = false; btn.textContent = 'Import selected'; }
  if (created.length) renderCreatorDashboard();

  let msg = '';
  if (created.length) {
    msg += 'Created ' + created.map((c) => '"' + c.name + '" (' + c.count + ' item' + (c.count === 1 ? '' : 's') + ')').join(', ') +
      ' in your Custom Lists \u2014 find them under the Custom Lists tab to add them to your lists.';
  }
  if (watchedAdded) {
    msg += (msg ? '\\n\\n' : '') + 'Marked ' + watchedAdded + ' item' + (watchedAdded === 1 ? '' : 's') + ' as watched \u2014 find them under Watch History.';
    if (cwTotal) {
      msg += ' Continue Watching checked for ' + cwSucceeded + ' of ' + cwTotal + ' show' + (cwTotal === 1 ? '' : 's') +
        (cwSucceeded < cwTotal ? ' \u2014 the rest hit a network hiccup or TMDB rate limit; reopening one of those shows will retry it, or just run this import again.' : '.');
    }
  }
  if (failed.length) {
    msg += (msg ? '\\n\\n' : '') + 'Could not create: ' + failed.map((f) => f.name + ' (' + f.error + ')').join(', ');
  }
  if (!msg) msg = 'Nothing to import in the selected categories.';
  alert(msg);
}

// Turns a pasted list URL's last path segment into a readable starter name
// (e.g. .../lists/user/best-of-2026 -> "Best Of 2026") -- just a starting
// point, the person can rename the row afterward like any other.
// --- Import from Letterboxd export --------------------------------------------

let letterboxdExportZipEntries = null;

const LETTERBOXD_EXPORT_CATEGORIES = [
  { key: 'watched', label: 'Watched (all-time list)', filePattern: /^watched\.csv$/ },
  { key: 'watchlist', label: 'Watchlist', filePattern: /^watchlist\.csv$/ },
  { key: 'ratings', label: 'Ratings', filePattern: /^ratings\.csv$/ },
  { key: 'diary', label: 'Diary', filePattern: /^diary\.csv$/ },
];

function parseLetterboxdCsv(csvText) {
  const lines = [];
  let row = [];
  let inQuotes = false;
  let val = '';
  for (let i = 0; i < csvText.length; i++) {
    const c = csvText[i];
    const nextC = csvText[i + 1];
    if (!inQuotes && c === ',') {
      row.push(val);
      val = '';
    } else if (c === '"' && inQuotes && nextC === '"') {
      val += '"';
      i++; // skip next quote
    } else if (c === '"') {
      inQuotes = !inQuotes;
    } else if (!inQuotes && (c === '\\n' || c === '\\r')) {
      if (c === '\\r' && nextC === '\\n') i++;
      row.push(val);
      if (row.length > 0 || val) lines.push(row);
      row = [];
      val = '';
    } else {
      val += c;
    }
  }
  if (val || row.length > 0) {
    row.push(val);
    lines.push(row);
  }
  return lines;
}

function readLetterboxdExportCsvFiles(pattern) {
  const items = [];
  const errors = [];
  let matchedFiles = 0;
  for (const filename in letterboxdExportZipEntries) {
    const basename = filename.split('/').pop() || filename;
    if (!pattern.test(basename)) continue;
    matchedFiles++;
    try {
      const text = fflate.strFromU8(letterboxdExportZipEntries[filename]);
      const csv = parseLetterboxdCsv(text);
      if (csv.length > 1) {
        const header = csv[0].map(h => h.trim());
        const nameIdx = header.indexOf('Name');
        const yearIdx = header.indexOf('Year');
        const uriIdx = header.indexOf('Letterboxd URI');
        
        if (nameIdx === -1 || yearIdx === -1) {
          throw new Error('CSV missing Name or Year column');
        }
        
        for (let i = 1; i < csv.length; i++) {
          const row = csv[i];
          if (row.length <= Math.max(nameIdx, yearIdx)) continue;
          items.push({
            title: row[nameIdx],
            year: row[yearIdx],
            uri: uriIdx !== -1 ? row[uriIdx] : '',
          });
        }
      }
    } catch (e) {
      errors.push(filename + ': ' + (e && e.message ? e.message : String(e)));
    }
  }
  return { items: items, matchedFiles: matchedFiles, errors: errors };
}

document.getElementById('letterboxdExportFileInput')?.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  const box = document.getElementById('letterboxdExportImportResult');
  if (!file || !box) return;
  box.innerHTML = '<p style="margin-top:10px;"><small>Reading zip\u2026</small></p>';
  try {
    if (typeof fflate === 'undefined') {
      throw new Error('the zip-reading library (fflate) never loaded \u2014 check your network connection or an ad/script blocker, then reload the page and try again');
    }
    const buf = await file.arrayBuffer();
    letterboxdExportZipEntries = fflate.unzipSync(new Uint8Array(buf));
    console.log('Letterboxd export zip contains:', Object.keys(letterboxdExportZipEntries));
  } catch (err) {
    box.innerHTML = '<p class="testresult err">\u2717 Could not read that zip: ' + escapeHtml(err && err.message ? err.message : String(err)) + '</p>';
    return;
  }
  
  const diagnostics = [];
  const rowsHtml = LETTERBOXD_EXPORT_CATEGORIES.map((cat) => {
    const result = readLetterboxdExportCsvFiles(cat.filePattern);
    if (!result.matchedFiles) return '';
    if (!result.items.length) {
      diagnostics.push(cat.label + ': found ' + result.matchedFiles + ' file(s) but couldn\u2019t read any entries \u2014 ' + result.errors.slice(0, 2).join('; '));
      return '';
    }
    // "Watched" and "Diary" are the two categories that represent movies
    // the person has actually seen (Watchlist is explicitly the opposite,
    // and Ratings alone doesn't reliably imply a watch date/event) -- only
    // those two get the option to also mark them watched in this add-on.
    const markWatchedToggle = (cat.key === 'watched' || cat.key === 'diary')
      ? '<div style="margin-left:24px; margin-top:4px;"><small>' +
        '<label><input type="checkbox" class="letterboxdExportMarkWatchedCheck" value="' + cat.key + '" checked> Also add these to Watch History (marks them watched)</label>' +
        '</small></div>'
      : '';
    return '<div class="row searchresult-row" style="flex-direction:column; align-items:flex-start;">' +
      '<div><label><input type="checkbox" class="letterboxdExportCatCheck" value="' + cat.key + '" checked> <strong>' + cat.label + '</strong> \u2014 ' + result.items.length + ' entries</label></div>' +
      markWatchedToggle +
      '</div>';
  }).join('');
  
  const diagnosticsHtml = diagnostics.length
    ? '<p class="testresult err">\u2717 ' + diagnostics.map(escapeHtml).join('<br>') + '</p>'
    : '';
  if (!rowsHtml) {
    box.innerHTML = diagnosticsHtml || '<p class="testresult err">\u2717 Didn\u2019t recognize any Letterboxd export files in that zip.</p>';
    return;
  }
  box.innerHTML = diagnosticsHtml +
    '<div class="catalog-list" style="margin-top:8px;">' + rowsHtml + '</div>' +
    '<div style="margin-top:12px;"><button type="button" class="primary" id="letterboxdExportImportBtn" onclick="runLetterboxdExportImport()">Resolve and Import</button></div>' +
    '<p style="margin-top:8px; font-size:0.85rem; color:var(--muted);" id="letterboxdImportProgress"></p>';
});

window.runLetterboxdExportImport = async function() {
  const btn = document.getElementById('letterboxdExportImportBtn');
  const progressLine = document.getElementById('letterboxdImportProgress');
  const catChecked = new Set(Array.from(document.querySelectorAll('.letterboxdExportCatCheck:checked')).map((c) => c.value));
  const markWatchedChecked = new Set(Array.from(document.querySelectorAll('.letterboxdExportMarkWatchedCheck:checked')).map((c) => c.value));
  // Same independence as the Trakt Export importer -- a category matters
  // here if either its own "create a Custom List" checkbox is on, or its
  // "mark as watched" checkbox is on, not only when both are.
  const relevantCats = LETTERBOXD_EXPORT_CATEGORIES.filter((cat) => catChecked.has(cat.key) || markWatchedChecked.has(cat.key));
  if (!relevantCats.length) {
    alert('Please select at least one category to import.');
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'Importing\u2026'; }
  
  const created = [];
  const failed = [];
  let watchedAdded = 0;
  
  for (const cat of relevantCats) {
    const result = readLetterboxdExportCsvFiles(cat.filePattern);
    if (!result.items.length) continue;
    
    // Dedupe by title and year
    const byKey = new Map();
    result.items.forEach((it) => {
      const key = (it.title + '|' + it.year).toLowerCase();
      if (!byKey.has(key)) byKey.set(key, it);
    });
    const uniqueItems = Array.from(byKey.values());
    
    if (progressLine) progressLine.textContent = 'Resolving TMDB IDs for ' + cat.label + ' (' + uniqueItems.length + ' items)...';
    
    // Bulk resolve
    const resolvedItems = [];
    try {
      const res = await fetch(ORIGIN + '/api/bulk-resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: uniqueItems }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'unknown error');
      
      for (const m of data.resolved) {
        if (!m.imdbId) continue;
        resolvedItems.push({
          imdbId: m.imdbId,
          title: m.title,
          year: m.year,
          type: 'movie',
          poster: 'https://images.metahub.space/poster/medium/' + m.imdbId + '/img',
        });
      }
    } catch (err) {
      console.error('Bulk resolve error:', err);
      failed.push({ name: 'Letterboxd ' + cat.label, error: err.message || String(err) });
      continue;
    }
    
    if (!resolvedItems.length) {
      failed.push({ name: 'Letterboxd ' + cat.label, error: 'Could not resolve any items.' });
      continue;
    }

    if (catChecked.has(cat.key)) {
      const listName = 'Letterboxd ' + cat.label;
      if (progressLine) progressLine.textContent = 'Saving ' + listName + ' (' + resolvedItems.length + ' items)...';

      const saveResult = await saveItemsAsNewCustomList(listName, 'movie', resolvedItems, 'private');
      if (saveResult.ok) {
        created.push({ name: listName, count: resolvedItems.length });
      } else {
        failed.push({ name: listName, error: saveResult.error });
      }
    }

    if (markWatchedChecked.has(cat.key) && typeof addItemsToWatchHistory === 'function') {
      if (progressLine) progressLine.textContent = 'Marking ' + cat.label + ' as watched...';
      const whItems = resolvedItems.map((it) => ({ id: it.imdbId, type: 'movie', name: it.title, poster: it.poster }));
      const whResult = await addItemsToWatchHistory(whItems);
      watchedAdded += whResult.added;
    }
  }
  
  if (progressLine) progressLine.textContent = '';
  if (btn) { btn.disabled = false; btn.textContent = 'Resolve and Import'; }
  if (created.length) renderCreatorDashboard();
  
  let msg = '';
  if (created.length) {
    msg += 'Successfully created:\\n' + created.map((c) => c.name + ' (' + c.count + ' items)').join('\\n');
  }
  if (watchedAdded) {
    msg += (msg ? '\\n\\n' : '') + 'Marked ' + watchedAdded + ' item' + (watchedAdded === 1 ? '' : 's') + ' as watched \u2014 find them under Watch History.';
  }
  if (failed.length) {
    msg += (msg ? '\\n\\n' : '') + 'Could not create: ' + failed.map((f) => f.name + ' (' + f.error + ')').join(', ');
  }
  if (!msg) msg = 'Nothing to import in the selected categories.';
  alert(msg);
};

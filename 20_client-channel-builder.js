// --- Channel builder ---------------------------------------------------------
//
// Builds one synthetic "series" out of hand-picked real episodes (from any
// shows) and/or whole movies. channelDraftItems holds the in-progress picks
// until "Save as a Channel" bundles them into one entry -- same shape a
// server-side channel payload needs (see parseChannelPayload/
// buildChannelMeta in the Worker): { kind: 'episode', imdbId, season,
// episode, title, released, thumbnail } or { kind: 'movie', imdbId, title,
// year, thumbnail }.
let channelDraftItems = [];
let channelDraftPoster = null;
let channelDraftBackdrop = null;
let channelSearchType = 'tv';

// The show half of the stream id a channel item will be published with.
//
// buildChannelMeta joins this to the episode's season/episode to form the
// video id Stremio hands to every stream add-on, and that id is the only
// thing the add-on receives -- so a show with no IMDb id has to fall back to
// the "tmdb:" form this add-on's manifest declares, never to a BARE TMDB
// number (which matches no idPrefix anywhere, so nothing is asked for it)
// and never to an empty string (which used to produce ":5:13"). The Worker
// re-checks this in channelItemShowId and drops whatever still cannot form
// a real id; this is what keeps it from having to.
function channelStreamShowId(imdbId, tmdbId) {
  const imdb = String(imdbId == null ? '' : imdbId).trim();
  if (/^tt[0-9]+$/.test(imdb)) return imdb;
  const tmdb = String(tmdbId == null ? '' : tmdbId).trim().replace(/^tmdb:/, '');
  if (/^[0-9]+$/.test(tmdb)) return 'tmdb:' + tmdb;
  if (/^tmdb:[0-9]+$/.test(imdb)) return imdb;
  if (/^[0-9]+$/.test(imdb)) return 'tmdb:' + imdb;
  return '';
}

function setChannelSearchType(type, btn) {
  channelSearchType = (type === 'movie' || type === 'person') ? type : 'tv';
  const bar = document.getElementById('channelSearchTypeChips');
  if (bar) {
    bar.querySelectorAll('.subnav-pill').forEach((p) => {
      p.classList.remove('active');
      const c = p.querySelector('.check-icon');
      if (c) c.remove();
    });
  }
  if (btn) {
    btn.classList.add('active');
    btn.insertAdjacentHTML('afterbegin', '<span class="check-icon">&#x2713;</span> ');
  }
  const input = document.getElementById('channelSearchInput');
  if (input) {
    input.placeholder = channelSearchType === 'movie'
      ? 'Search a movie by name...'
      : (channelSearchType === 'person'
        ? 'Search an actor, director or creator...'
        : 'Search a show by name...');
  }
  const box = document.getElementById('channelSearchResult');
  const epBox = document.getElementById('channelEpisodePicker');
  if (epBox) epBox.innerHTML = '';
  // The picker below is about to be reused for a different kind of thing,
  // so the filmography it may be holding stops being what is on screen.
  channelPersonCredits = null;
  const q = input ? input.value.trim() : '';
  if (q) {
    runChannelTitleSearch();
  } else if (box) {
    box.innerHTML = '';
  }
}

async function runChannelTitleSearch() {
  const q = document.getElementById('channelSearchInput').value.trim();
  const box = document.getElementById('channelSearchResult');
  document.getElementById('channelEpisodePicker').innerHTML = '';
  if (!q) {
    box.innerHTML = '';
    return;
  }
  // A person is not a title, and the two searches answer different
  // questions -- so Actors & Directors goes to its own endpoint and its own
  // result card (see runChannelPersonSearch).
  if (channelSearchType === 'person') {
    await runChannelPersonSearch(q);
    return;
  }
  box.innerHTML = '<p><small>Searching\u2026</small></p>';
  try {
    const res = await fetch(ORIGIN + '/api/title-search?q=' + encodeURIComponent(q) + '&type=' + encodeURIComponent(channelSearchType), { cache: 'no-store' });
    const data = await res.json();
    if (!data.ok) {
      box.innerHTML = '<p class="testresult err">\u2717 ' + escapeHtml(data.error || 'Search failed.') + '</p>';
      return;
    }
    renderChannelTitleResults(data.results, channelSearchType);
  } catch (e) {
    box.innerHTML = '<p class="testresult err">\u2717 Network error while searching.</p>';
  }
}

function renderChannelTitleResults(results, searchType = 'tv') {
  const box = document.getElementById('channelSearchResult');
  if (!results.length) {
    box.innerHTML = '<p style="color:var(--muted); font-size:0.85rem;"><small>No matches found.</small></p>';
    return;
  }
  const isMovie = searchType === 'movie';
  const cardsHtml = results.map((r) => {
    const posterImg = r.poster
      ? '<img class="preview-thumb" src="' + escapeAttr(r.poster) + '" alt="" loading="lazy" style="cursor:pointer;">'
      : '<div class="preview-thumb" style="display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:0.7rem;text-align:center;padding:4px;cursor:pointer;">No poster</div>';
    const btnLabel = isMovie ? '+ Add Movie' : '+ Browse';
    const cardClass = isMovie ? 'channelMovieCard' : 'channelTitleCard';
    const btnClass = isMovie ? 'channelAddMovieBtn' : 'channelTitleBtn';
    return '<div class="custom-list-search-item ' + cardClass + '" style="display:flex; flex-direction:column; align-items:center; width:100%; min-width:0; cursor:pointer;"' +
      ' data-tmdbid="' + r.tmdbId + '" data-title="' + escapeAttr(r.title) + '" data-year="' + escapeAttr(r.year || '') + '" data-poster="' + escapeAttr(r.poster || '') + '" data-backdrop="' + escapeAttr(r.backdrop || '') + '">' +
      posterImg +
      '<div style="width:100%; font-size:0.75rem; font-weight:600; text-align:center; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin:4px 0 1px;" title="' + escapeAttr(r.title) + '">' +
        escapeHtml(r.title) +
      '</div>' +
      (r.year ? '<div style="font-size:0.7rem; color:var(--muted); text-align:center; margin-bottom:4px;">' + escapeHtml(r.year) + '</div>' : '<div style="height:14px; margin-bottom:4px;"></div>') +
      '<button type="button" class="lc-btn secondary ' + btnClass + '" style="width:100%; padding:4px 6px; font-size:0.75rem;"' +
      ' data-tmdbid="' + r.tmdbId + '" data-title="' + escapeAttr(r.title) + '" data-year="' + escapeAttr(r.year || '') + '" data-poster="' + escapeAttr(r.poster || '') + '" data-backdrop="' + escapeAttr(r.backdrop || '') + '">' + btnLabel + '</button>' +
      '</div>';
  }).join('');
  box.innerHTML = '<div class="poster-grid-3" style="margin-top:10px;">' + cardsHtml + '</div>';
}

document.getElementById('channelSearchResult').addEventListener('click', (e) => {
  // A person card behaves like a show card: tapping the photo (or the
  // button) opens what they have been in, below, rather than committing to
  // a whole channel in one click.
  const personTarget = e.target.closest('.channelPersonCard, .channelPersonBtn');
  if (personTarget) {
    browseChannelPerson(personTarget.dataset.personid, personTarget.dataset.personname);
    return;
  }
  const showTarget = e.target.closest('.channelTitleCard, .channelTitleBtn');
  if (showTarget) {
    browseChannelShow(showTarget.dataset.tmdbid, showTarget.dataset.title, showTarget.dataset.poster, showTarget.dataset.backdrop);
    return;
  }
  const movieTarget = e.target.closest('.channelMovieCard, .channelAddMovieBtn');
  if (movieTarget) {
    addMovieToChannelDraft(
      movieTarget.dataset.tmdbid,
      movieTarget.dataset.title,
      movieTarget.dataset.year,
      movieTarget.dataset.poster,
      movieTarget.dataset.backdrop,
      movieTarget.querySelector('.channelAddMovieBtn') || movieTarget
    );
  }
});

async function addMovieToChannelDraft(tmdbId, title, year, poster, backdrop, btn, duplicateChecked) {
  if (channelDraftItems.length >= CHANNEL_MAX_TOTAL_ITEMS) {
    if (typeof showAppAlert === 'function') {
      showAppAlert('Channel Limit', 'This channel has reached the maximum of ' + CHANNEL_MAX_TOTAL_ITEMS + ' items.');
    }
    return;
  }
  if (!duplicateChecked && guardChannelDraftDuplicate(
    title || 'That movie',
    channelDraftItems.filter((it) => it && it.kind === 'movie' && String(it.tmdbId || '') === String(tmdbId || '')).length,
    () => addMovieToChannelDraft(tmdbId, title, year, poster, backdrop, btn, true)
  )) return;
  const originalText = btn ? btn.textContent : '+ Add Movie';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Adding\u2026';
  }
  try {
    const res = await fetch(ORIGIN + '/api/resolve-movie?tmdbId=' + encodeURIComponent(tmdbId), { cache: 'no-store' });
    const data = await res.json();
    if (!data.ok || !data.imdbId) {
      if (typeof showAppAlert === 'function') {
        showAppAlert('Movie Resolution', (data && data.error) || 'Could not resolve IMDb ID for this movie.');
      }
      if (btn) {
        btn.disabled = false;
        btn.textContent = originalText;
      }
      return;
    }
    channelDraftItems.push({
      kind: 'movie',
      imdbId: data.imdbId,
      tmdbId: tmdbId,
      title: title,
      year: year || '',
      showName: title,
      epName: 'Movie',
      released: year ? (year + '-01-01') : '',
      runtime: data.runtime || 0,
      thumbnail: backdrop || poster || '',
      poster: poster || '',
      showPoster: poster || '',
      backdrop: backdrop || '',
      showBackdrop: backdrop || '',
    });
    if (!channelDraftBackdrop && backdrop) channelDraftBackdrop = backdrop;
    if (!channelDraftPoster && poster) channelDraftPoster = poster;
    renderChannelDraftList();
    if (btn) {
      btn.textContent = 'Added \u2713';
      setTimeout(() => {
        if (btn) {
          btn.disabled = false;
          btn.textContent = '+ Add Movie';
        }
      }, 1200);
    }
  } catch (e) {
    if (typeof showAppAlert === 'function') {
      showAppAlert('Network Error', 'Could not add movie -- check connection.');
    }
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }
}

async function browseChannelShow(tmdbId, showName, showPoster, showBackdrop) {
  const box = document.getElementById('channelEpisodePicker');
  box.innerHTML = '<p><small>Loading seasons\u2026</small></p>';
  try {
    const res = await fetch(ORIGIN + '/api/show-seasons?tmdbId=' + encodeURIComponent(tmdbId), { cache: 'no-store' });
    const data = await res.json();
    if (!data.ok) {
      box.innerHTML = '<p class="testresult err">\u2717 ' + escapeHtml(data.error || 'Could not load seasons.') + '</p>';
      return;
    }
    const poster = data.poster || showPoster || '';
    const backdrop = data.backdrop || showBackdrop || '';
    if (backdrop) channelDraftBackdrop = backdrop;
    if (poster) channelDraftPoster = poster;
    const seasonNumbers = data.seasons.map((s) => s.season).join(',');
    const seasonButtons = data.seasons.map((s) =>
      '<button type="button" class="secondary channelSeasonBtn"' +
      ' data-tmdbid="' + tmdbId + '" data-imdbid="' + escapeAttr(data.imdbId) + '"' +
      ' data-showname="' + escapeAttr(showName) + '" data-poster="' + escapeAttr(poster) + '"' +
      ' data-backdrop="' + escapeAttr(backdrop) + '"' +
      ' data-season="' + s.season + '">' +
      escapeHtml(s.name || ('Season ' + s.season)) + ' (' + s.episodeCount + ')</button>'
    ).join(' ');
    box.innerHTML = '<p><small>Pick a season of <strong>' + escapeHtml(showName) + '</strong>, or:</small></p>' +
      '<div class="actions" style="flex-wrap:wrap; margin-bottom:10px;">' +
      '<button type="button" class="secondary channelAddAllSeasonsBtn"' +
      ' data-tmdbid="' + tmdbId + '" data-imdbid="' + escapeAttr(data.imdbId) + '"' +
      ' data-showname="' + escapeAttr(showName) + '" data-poster="' + escapeAttr(poster) + '"' +
      ' data-backdrop="' + escapeAttr(backdrop) + '"' +
      ' data-seasons="' + seasonNumbers + '">Add every season (all episodes)</button>' +
      '</div>' +
      '<div class="channel-season-grid">' + seasonButtons + '</div>' +
      '<div id="channelEpisodeList"></div>';
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    box.innerHTML = '<p class="testresult err">\u2717 Network error loading seasons.</p>';
  }
}

document.getElementById('channelEpisodePicker').addEventListener('click', (e) => {
  const personMovie = e.target.closest('.channelPersonMovieCard, .channelPersonMovieBtn');
  if (personMovie) {
    addMovieToChannelDraft(
      personMovie.dataset.tmdbid, personMovie.dataset.title, personMovie.dataset.year,
      personMovie.dataset.poster, personMovie.dataset.backdrop,
      personMovie.querySelector('.channelPersonMovieBtn') || personMovie
    );
    return;
  }
  // The button is the precise action -- only the episodes this person is
  // in -- and the poster beside it is the escape hatch to the full season
  // picker, for when the whole show is what you actually want.
  const personShowBtn = e.target.closest('.channelPersonShowBtn');
  if (personShowBtn) {
    addPersonShowEpisodes(personShowBtn.dataset.tmdbid, personShowBtn.dataset.title, personShowBtn.dataset.poster, personShowBtn);
    return;
  }
  const personShow = e.target.closest('.channelPersonShowCard');
  if (personShow) {
    browseChannelShow(personShow.dataset.tmdbid, personShow.dataset.title, personShow.dataset.poster, personShow.dataset.backdrop);
    return;
  }
  const personAddAll = e.target.closest('.channelPersonAddAllBtn');
  if (personAddAll) {
    addWholeSpotlightToDraft(personAddAll);
    return;
  }
  const seasonBtn = e.target.closest('.channelSeasonBtn');
  if (seasonBtn) {
    loadChannelSeasonEpisodes(
      seasonBtn.dataset.tmdbid, seasonBtn.dataset.imdbid, seasonBtn.dataset.showname,
      seasonBtn.dataset.poster, seasonBtn.dataset.backdrop, seasonBtn.dataset.season
    );
    return;
  }
  const addAllSeasonsBtn = e.target.closest('.channelAddAllSeasonsBtn');
  if (addAllSeasonsBtn) {
    addAllSeasonsToChannel(
      addAllSeasonsBtn.dataset.tmdbid, addAllSeasonsBtn.dataset.imdbid, addAllSeasonsBtn.dataset.showname,
      addAllSeasonsBtn.dataset.poster, addAllSeasonsBtn.dataset.backdrop, addAllSeasonsBtn.dataset.seasons, addAllSeasonsBtn
    );
    return;
  }
  const addAllBtn = e.target.closest('.channelAddAllEpisodesBtn');
  if (addAllBtn) {
    addAllEpisodesToChannel(addAllBtn.dataset.imdbid, addAllBtn.dataset.showname, addAllBtn.dataset.poster, addAllBtn.dataset.backdrop, addAllBtn.dataset.tmdbid);
    return;
  }
  const addBtn = e.target.closest('.channelAddEpisodesBtn');
  if (addBtn) {
    addCheckedEpisodesToChannel(addBtn.dataset.imdbid, addBtn.dataset.showname, addBtn.dataset.poster, addBtn.dataset.backdrop, addBtn.dataset.tmdbid);
  }
});

// Fetches every season's episode list (in parallel -- server-cached anyway,
// see /api/show-episodes) and adds all of them in original broadcast order,
// for "just give me the whole show" instead of clicking through season by
// season.
async function addAllSeasonsToChannel(tmdbId, imdbId, showName, showPoster, showBackdrop, seasonsCsv, btn, duplicateChecked) {
  const seasons = String(seasonsCsv || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!seasons.length) return;
  const showStreamId = channelStreamShowId(imdbId, tmdbId);
  if (!duplicateChecked && guardChannelDraftDuplicate(
    showName || 'That show',
    channelDraftCountForShow(showStreamId, showName),
    () => addAllSeasonsToChannel(tmdbId, imdbId, showName, showPoster, showBackdrop, seasonsCsv, btn, true)
  )) return;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Adding every season\u2026';
  }
  try {
    const results = await Promise.all(seasons.map((season) =>
      fetch(ORIGIN + '/api/show-episodes?tmdbId=' + encodeURIComponent(tmdbId) + '&season=' + encodeURIComponent(season), { cache: 'no-store' })
        .then((res) => res.json())
        .then((data) => ({ season: parseInt(season, 10), episodes: data.ok ? data.episodes : [] }))
        .catch(() => ({ season: parseInt(season, 10), episodes: [] }))
    ));
    const showEpisodes = [];
    results
      .sort((a, b) => a.season - b.season)
      .forEach(({ season, episodes }) => {
        episodes.forEach((ep) => {
          showEpisodes.push({
            kind: 'episode',
            imdbId: showStreamId,
            season: season,
            episode: ep.episode,
            showName: showName || '',
            epName: ep.name || ('Episode ' + ep.episode),
            title: (showName ? showName + ' S' + season + 'E' + ep.episode + ' \u2014 ' : '') + (ep.name || ('Episode ' + ep.episode)),
            released: ep.released,
            runtime: ep.runtime || 0,
            thumbnail: ep.thumbnail || showBackdrop || showPoster,
            poster: showPoster || ep.thumbnail || showBackdrop || '',
            showPoster: showPoster || '',
            backdrop: showBackdrop || '',
            showBackdrop: showBackdrop || '',
          });
        });
      });
    let finalEpisodes = showEpisodes;
    const remainingBudget = CHANNEL_MAX_TOTAL_ITEMS - channelDraftItems.length;
    const trimmedForTotalBudget = finalEpisodes.length > remainingBudget;
    if (trimmedForTotalBudget) finalEpisodes = finalEpisodes.slice(0, Math.max(0, remainingBudget));
    finalEpisodes.forEach((it) => channelDraftItems.push(it));
    if (!channelDraftBackdrop && showBackdrop) channelDraftBackdrop = showBackdrop;
    if (!channelDraftPoster && showPoster) channelDraftPoster = showPoster;
    renderChannelDraftList();
    if (btn) {
      let label = 'Added all ' + finalEpisodes.length + ' episodes \u2713';
      if (trimmedForTotalBudget) label = 'Added ' + finalEpisodes.length + ' (channel size limit reached)';
      btn.textContent = label;
    }
  } catch (e) {
    if (typeof showAppAlert === 'function') {
      showAppAlert('Channel Builder', 'Something went wrong adding every season -- try again, or add seasons one at a time.');
    } else {
      alert('Something went wrong adding every season -- try again, or add seasons one at a time.');
    }
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Add every season (all episodes)';
    }
  }
}

async function loadChannelSeasonEpisodes(tmdbId, imdbId, showName, showPoster, showBackdrop, season) {
  const listBox = document.getElementById('channelEpisodeList');
  if (!listBox) return;
  listBox.innerHTML = '<p><small>Loading episodes\u2026</small></p>';
  try {
    const res = await fetch(
      ORIGIN + '/api/show-episodes?tmdbId=' + encodeURIComponent(tmdbId) + '&season=' + encodeURIComponent(season),
      { cache: 'no-store' }
    );
    const data = await res.json();
    if (!data.ok) {
      listBox.innerHTML = '<p class="testresult err">\u2717 ' + escapeHtml(data.error || 'Could not load episodes.') + '</p>';
      return;
    }
    const rows = data.episodes.map((ep) => {
      const epJson = escapeAttr(JSON.stringify({
        season: parseInt(season, 10), episode: ep.episode, title: ep.name, released: ep.released, thumbnail: ep.thumbnail, runtime: ep.runtime || 0,
      }));
      return '<label class="row quick-row" style="cursor:pointer;">' +
        '<span><input type="checkbox" class="channelEpisodeCheck" data-ep="' + epJson + '"> ' +
        'S' + season + 'E' + ep.episode + ' \u2014 ' + escapeHtml(ep.name || '') + '</span>' +
        '</label>';
    }).join('');
    listBox.innerHTML = rows +
      '<div class="actions" style="margin-top:8px;">' +
      '<button type="button" class="secondary channelAddEpisodesBtn"' +
      ' data-imdbid="' + escapeAttr(imdbId) + '" data-tmdbid="' + escapeAttr(tmdbId) + '"' +
      ' data-showname="' + escapeAttr(showName) + '"' +
      ' data-poster="' + escapeAttr(showPoster) + '" data-backdrop="' + escapeAttr(showBackdrop || '') + '">Add checked episodes</button>' +
      '<button type="button" class="secondary channelAddAllEpisodesBtn"' +
      ' data-imdbid="' + escapeAttr(imdbId) + '" data-tmdbid="' + escapeAttr(tmdbId) + '"' +
      ' data-showname="' + escapeAttr(showName) + '"' +
      ' data-poster="' + escapeAttr(showPoster) + '" data-backdrop="' + escapeAttr(showBackdrop || '') + '">Add all episodes</button>' +
      '</div>';
    listBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    listBox.innerHTML = '<p class="testresult err">\u2717 Network error loading episodes.</p>';
  }
}

function addCheckedEpisodesToChannel(imdbId, showName, showPoster, showBackdrop, tmdbId) {
  const checks = document.querySelectorAll('#channelEpisodeList .channelEpisodeCheck:checked');
  if (!checks.length) {
    if (typeof showAppAlert === 'function') {
      showAppAlert('Channel Builder', 'Check at least one episode first.');
    } else {
      alert('Check at least one episode first.');
    }
    return;
  }
  const showStreamId = channelStreamShowId(imdbId, tmdbId);
  checks.forEach((cb) => {
    let ep;
    try {
      ep = JSON.parse(cb.dataset.ep);
    } catch (e) {
      return;
    }
    channelDraftItems.push({
      kind: 'episode',
      imdbId: showStreamId,
      season: ep.season,
      episode: ep.episode,
      showName: showName || '',
      epName: ep.title || ('Episode ' + ep.episode),
      title: (showName ? showName + ' S' + ep.season + 'E' + ep.episode + ' \u2014 ' : '') + (ep.title || ('Episode ' + ep.episode)),
      released: ep.released,
      runtime: ep.runtime || 0,
      thumbnail: ep.thumbnail || showBackdrop || showPoster,
      poster: showPoster || ep.thumbnail || showBackdrop || '',
      showPoster: showPoster || '',
      backdrop: showBackdrop || '',
      showBackdrop: showBackdrop || '',
    });
  });
  if (!channelDraftBackdrop && showBackdrop) channelDraftBackdrop = showBackdrop;
  if (!channelDraftPoster && showPoster) channelDraftPoster = showPoster;
  renderChannelDraftList();
}

// Checks every episode box for the currently-loaded season, then reuses
// addCheckedEpisodesToChannel above rather than duplicating its logic.
function addAllEpisodesToChannel(imdbId, showName, showPoster, showBackdrop, tmdbId) {
  document.querySelectorAll('#channelEpisodeList .channelEpisodeCheck').forEach((cb) => {
    cb.checked = true;
  });
  addCheckedEpisodesToChannel(imdbId, showName, showPoster, showBackdrop, tmdbId);
}

const LOCAL_CHANNELS_KEY = 'myListAddon:localChannels';

let _memoryChannelsMap = null;
let _memoryChannelsString = '';

function normalizeChannelItemFromStorage(it) {
  if (!it || typeof it !== 'object') return it;
  const poster = it.poster || it.showPoster || it.thumbnail || '';
  const thumbnail = it.thumbnail || poster || '';
  const showPoster = it.showPoster || poster || '';
  return {
    ...it,
    kind: it.kind || 'episode',
    poster: poster,
    thumbnail: thumbnail,
    showPoster: showPoster,
  };
}

function loadLocalChannels() {
  try {
    if (_memoryChannelsMap && typeof _memoryChannelsMap === 'object' && Object.keys(_memoryChannelsMap).length > 0) {
      return _memoryChannelsMap;
    }
    let str = _memoryChannelsString;
    if (!str) {
      try { str = sessionStorage.getItem(LOCAL_CHANNELS_KEY); } catch (e) {}
    }
    if (!str) {
      try { str = localStorage.getItem(LOCAL_CHANNELS_KEY); } catch (e) {}
    }
    const map = JSON.parse(str || '{}');
    if (map && typeof map === 'object') {
      for (const ch of Object.values(map)) {
        if (ch && Array.isArray(ch.items)) {
          ch.items = ch.items.map(normalizeChannelItemFromStorage);
        }
      }
      _memoryChannelsString = str;
      _memoryChannelsMap = map;
      return map;
    }
    return _memoryChannelsMap || {};
  } catch (e) {
    return _memoryChannelsMap || {};
  }
}

function compactChannelItemForStorage(it) {
  if (!it || typeof it !== 'object') return null;
  const kind = it.kind || 'episode';
  const out = {
    kind: kind,
    imdbId: it.imdbId || '',
    season: it.season != null ? Number(it.season) : 1,
    episode: it.episode != null ? Number(it.episode) : 1,
    showName: it.showName || '',
    epName: it.epName || '',
    title: it.title || '',
  };
  if (it.released) {
    out.released = it.released.length > 10 ? it.released.slice(0, 10) : it.released;
  }
  // Minutes, when TMDB had them. Only written when there is a real number to
  // write -- a zero runtime on every one of 5,000 picks is 15KB of
  // localStorage spent saying nothing.
  const runtime = Number(it.runtime);
  if (Number.isInteger(runtime) && runtime > 0) out.runtime = runtime;
  const poster = it.poster || it.showPoster || it.thumbnail || '';
  const thumbnail = it.thumbnail || '';
  const showPoster = it.showPoster || '';

  if (poster) out.poster = poster;
  if (thumbnail && thumbnail !== poster) out.thumbnail = thumbnail;
  if (showPoster && showPoster !== poster && showPoster !== thumbnail) out.showPoster = showPoster;
  if (it.backdrop && it.backdrop !== poster && it.backdrop !== thumbnail) out.backdrop = it.backdrop;

  return out;
}

function compressChannelItemsForStorage(items, maxItems = 5000) {
  if (!Array.isArray(items)) return [];
  const cap = typeof maxItems === 'number' ? maxItems : 5000;
  return items.slice(0, cap).map(compactChannelItemForStorage).filter(Boolean);
}

function saveLocalChannelsMap(map) {
  if (!map || typeof map !== 'object') return false;

  // 1. Keep full fidelity in memory unconditionally so active session, "See All", and playback have all items
  _memoryChannelsMap = map;

  const fullMap = {};
  for (const [id, ch] of Object.entries(map)) {
    if (!ch) continue;
    fullMap[id] = {
      channelId: ch.channelId || id,
      name: ch.name || 'Channel',
      poster: ch.poster || null,
      backdrop: ch.backdrop || null,
      items: compressChannelItemsForStorage(ch.items, 5000),
      shuffle: !!ch.shuffle,
      autoSort: ch.autoSort || '',
      sortByAired: !!ch.sortByAired,
      ...channelBroadcastFields(ch),
      ...channelShareFields(ch),
      order: Number(ch.order) || 0,
      createdAt: ch.createdAt || Date.now(),
      updatedAt: ch.updatedAt || Date.now(),
    };
  }

  let fullStr = '';
  try {
    fullStr = JSON.stringify(fullMap);
    _memoryChannelsString = fullStr;
    try { sessionStorage.setItem(LOCAL_CHANNELS_KEY, fullStr); } catch (se) {}
  } catch (strErr) {}

  // Tier 1: Try full compact map in localStorage
  try {
    if (fullStr) {
      localStorage.setItem(LOCAL_CHANNELS_KEY, fullStr);
      if (typeof scheduleChannelsSync === 'function') scheduleChannelsSync();
      return true;
    }
  } catch (e1) {
    // Tier 2: Quota exceeded, compress channel items to 1000 items for offline storage
    try {
      const tier2Map = {};
      for (const [id, ch] of Object.entries(fullMap)) {
        tier2Map[id] = {
          ...ch,
          items: (ch.items || []).slice(0, 1000),
        };
      }
      const tier2Str = JSON.stringify(tier2Map);
      localStorage.setItem(LOCAL_CHANNELS_KEY, tier2Str);
      if (typeof scheduleChannelsSync === 'function') scheduleChannelsSync();
      return true;
    } catch (e2) {
      // Tier 3: Ultra-compact to 300 items for offline storage
      try {
        const tier3Map = {};
        for (const [id, ch] of Object.entries(fullMap)) {
          tier3Map[id] = {
            ...ch,
            items: (ch.items || []).slice(0, 300),
          };
        }
        const tier3Str = JSON.stringify(tier3Map);
        localStorage.setItem(LOCAL_CHANNELS_KEY, tier3Str);
        if (typeof scheduleChannelsSync === 'function') scheduleChannelsSync();
        return true;
      } catch (e3) {
        // Fallback: localStorage completely full across all keys.
        // Full channel is still safely preserved in _memoryChannelsMap, sessionStorage, and #lists entries.
        console.warn('saveLocalChannelsMap: localStorage quota exceeded, preserved in session & memory');
        window._localStorageFull = true;
        if (typeof notifyStorageFull === 'function') {
          const signedIn = (typeof activeCreator !== 'undefined' && !!activeCreator);
          notifyStorageFull(signedIn);
        }
        if (typeof scheduleChannelsSync === 'function') scheduleChannelsSync();
        return true;
      }
    }
  }
  return true;
}

function ensureAllChannelsSyncedFromRows(map) {
  if (!map || typeof map !== 'object') map = loadLocalChannels();
  let modified = false;
  const rows = [...document.querySelectorAll('#lists .entry')];
  rows.forEach((div) => {
    const nameEl = div.querySelector('.name');
    const rowName = (nameEl && nameEl.value.trim()) || '';
    const urlInputs = [...div.querySelectorAll('.url')];
    urlInputs.forEach((u) => {
      const rawVal = u.value || '';
      const lines = rawVal.split('\\n').map((s) => s.trim()).filter(Boolean);
      lines.forEach((line) => {
        if (line.startsWith('channel:v1:')) {
          try {
            const payload = JSON.parse(line.slice('channel:v1:'.length));
            if (payload && (payload.channelId || payload.name)) {
              const chId = payload.channelId || ('channel-' + Math.random().toString(36).slice(2, 9));
              payload.channelId = chId;
              const chName = payload.name || rowName || 'Channel';
              if (!map[chId]) {
                map[chId] = {
                  channelId: chId,
                  name: chName,
                  poster: payload.poster || null,
                  backdrop: payload.backdrop || null,
                  items: compressChannelItemsForStorage(payload.items),
                  shuffle: !!payload.shuffle,
                  autoSort: payload.autoSort || '',
                  sortByAired: !!payload.sortByAired,
                  ...channelBroadcastFields(payload),
                  ...channelShareFields(payload),
                  order: Number(payload.order) || 0,
                  createdAt: Date.now(),
                  updatedAt: Date.now(),
                };
                modified = true;
              } else if ((!map[chId].name || map[chId].name === 'Channel') && chName !== 'Channel') {
                map[chId].name = chName;
                modified = true;
              }
            }
          } catch (e) {}
        }
      });
    });
  });
  if (modified) saveLocalChannelsMap(map);
  return map;
}

function saveLocalChannel(payload) {
  const map = loadLocalChannels();
  const channelId = payload.channelId || generateChannelId();
  const now = Date.now();
  const existing = map[channelId];
  map[channelId] = {
    channelId: channelId,
    name: payload.name || 'Untitled Channel',
    poster: payload.poster || null,
    backdrop: payload.backdrop || null,
    items: compressChannelItemsForStorage(payload.items),
    shuffle: !!payload.shuffle,
    autoSort: payload.autoSort || '',
    sortByAired: !!payload.sortByAired,
    ...channelBroadcastFields(payload),
    ...channelShareFields(payload),
    visibility: (payload.visibility === 'private' || payload.sharePublished === false) ? 'private' : 'public',
    owner: String(payload.owner || (existing ? existing.owner : '') || ''),
    // Kept from the existing record when a save does not carry one, so
    // editing a channel never knocks it out of the order someone arranged.
    order: Number(payload.order) || (existing ? Number(existing.order) : 0) || 0,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
  };
  saveLocalChannelsMap(map);
  return map[channelId];
}

function pruneChannelFromAllMerges(channelId) {
  const map = loadLocalMergedChannels();
  const channelsMap = loadLocalChannels();
  let changed = false;
  Object.keys(map).forEach((mergedId) => {
    const merged = map[mergedId];
    if (!merged || !Array.isArray(merged.channelIds) || !merged.channelIds.includes(channelId)) return;
    changed = true;
    merged.channelIds = merged.channelIds.filter((id) => id !== channelId);
    merged.updatedAt = Date.now();

    const rows = [...document.querySelectorAll('#lists .entry')];
    if (merged.channelIds.length === 0) {
      delete map[mergedId];
      rows.forEach((row) => {
        if (row.dataset.mergedId === mergedId || (row.id && row.id === mergedId)) {
          row.remove();
        }
      });
    } else {
      map[mergedId] = merged;
      rows.forEach((row) => {
        if (row.dataset.mergedId === mergedId || (row.id && row.id === mergedId)) {
          const urls = merged.channelIds.map((id) => {
            const ch = channelsMap[id];
            return ch ? ('channel:v1:' + JSON.stringify(ch)) : null;
          }).filter(Boolean);
          const urlInput = row.querySelector('.url');
          if (urlInput) urlInput.value = urls.join('\\n');
        }
      });
    }
  });
  if (changed) saveLocalMergedChannelsMap(map);
  return changed;
}

// --- My Channels: ordering, searching, and taking a delete back ----------
//
// Past a dozen or so channels the list is a long scroll with no way to find
// anything in it, and deleting one was the only destructive action in the
// app with no undo behind it.
let myChannelsSort = 'recent';
let myChannelsSearch = '';
let _pendingChannelUndo = null;
let _pendingChannelUndoTimer = null;

function setMyChannelsSort(value) {
  myChannelsSort = value || 'recent';
  try { localStorage.setItem('myListAddon:myChannelsSort', myChannelsSort); } catch (e) {}
  renderMyCreatedChannelsList();
}

function setMyChannelsSearch(value) {
  myChannelsSearch = String(value || '');
  renderMyCreatedChannelsList();
}

function sortMyChannels(channels, mode) {
  const how = mode || myChannelsSort;
  const list = channels.slice();
  if (how === 'name') {
    list.sort((a, b) => String(a.name || '').toLowerCase().localeCompare(String(b.name || '').toLowerCase()));
  } else if (how === 'size') {
    list.sort((a, b) => ((b.items || []).length - (a.items || []).length));
  } else if (how === 'created') {
    list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  } else if (how === 'manual') {
    // A channel with no order yet sorts after every channel that has one,
    // by how recently it was touched -- so a newly added channel lands at
    // the end of an arrangement rather than somewhere in the middle of it.
    list.sort((a, b) => {
      const oa = Number(a.order) || 0;
      const ob = Number(b.order) || 0;
      if (oa && ob) return oa - ob;
      if (oa) return -1;
      if (ob) return 1;
      return (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0);
    });
  } else {
    list.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  }
  return list;
}

function filterMyChannels(channels) {
  const q = myChannelsSearch.trim().toLowerCase();
  if (!q) return channels;
  return channels.filter((ch) => {
    if (!ch) return false;
    if (String(ch.name || '').toLowerCase().indexOf(q) !== -1) return true;
    if (String(ch.description || '').toLowerCase().indexOf(q) !== -1) return true;
    // A channel is also findable by what is IN it, which is usually how
    // people remember one -- "the one with Rugrats in".
    return (ch.items || []).some((it) => it && String(it.showName || '').toLowerCase().indexOf(q) !== -1);
  });
}

// The undo bar, and the timer that retires it.
//
// Held for a minute, and cleared when it is used or when the page moves on
// -- an Undo still sitting there ten minutes later is a promise about state
// that has since changed underneath it.
function offerChannelDeleteUndo(snapshot, wasInCatalogs) {
  _pendingChannelUndo = { channel: snapshot, inCatalogs: wasInCatalogs };
  if (_pendingChannelUndoTimer) clearTimeout(_pendingChannelUndoTimer);
  _pendingChannelUndoTimer = setTimeout(() => {
    _pendingChannelUndo = null;
    renderChannelUndoBar();
  }, 60000);
  renderChannelUndoBar();
}

function renderChannelUndoBar() {
  const bar = document.getElementById('myChannelsUndoBar');
  if (!bar) return;
  if (!_pendingChannelUndo) {
    bar.style.display = 'none';
    bar.innerHTML = '';
    return;
  }
  const name = _pendingChannelUndo.channel.name || 'Channel';
  bar.style.display = 'block';
  bar.innerHTML = '<div class="row" style="gap:8px; align-items:center; padding:8px 10px; border:1px solid var(--border); border-radius:8px; background:var(--surface);">' +
    '<span style="flex:1; font-size:0.85rem;">Deleted &ldquo;' + escapeHtml(name) + '&rdquo;.</span>' +
    '<button type="button" class="secondary lc-btn" onclick="undoChannelDelete()">Undo</button>' +
    '</div>';
}

function undoChannelDelete() {
  if (!_pendingChannelUndo) return;
  const { channel, inCatalogs } = _pendingChannelUndo;
  _pendingChannelUndo = null;
  if (_pendingChannelUndoTimer) clearTimeout(_pendingChannelUndoTimer);
  saveLocalChannel(channel);
  if (inCatalogs) {
    const payload = Object.assign({}, channel);
    addRow(channel.name || 'Channel', 'channel:v1:' + JSON.stringify(payload), 'series', true, 'Channels', channel.channelId);
    saveState();
  }
  renderChannelUndoBar();
  renderMyCreatedChannelsList();
  renderChannelMergeList();
  showAddedToast('Restored channel "' + (channel.name || 'Channel') + '".');
}


// --- arranging My Channels by hand ---------------------------------------
//
// The same three ways My Lists lets a catalog row be moved -- a drag handle,
// up/down buttons, and a position you can type -- because past a dozen
// channels "recently updated" is not an order anyone chose.
//
// All three work on the list AS SHOWN. A filter or another ordering means
// the cards on screen are a subset in a different sequence, so a move
// permutes the visible channels among the slots they already occupy in the
// stored arrangement and leaves every hidden channel exactly where it is --
// the same rule the channel draft's own filtered drag follows, and for the
// same reason: rebuilding an order from a partial view loses whatever the
// view was hiding.
function visibleMyChannelIds() {
  const box = document.getElementById('myCreatedChannelsList');
  if (!box) return [];
  return [...box.querySelectorAll('.list-card[data-channel-id]')]
    .map((card) => card.getAttribute('data-channel-id'))
    .filter(Boolean);
}

// Rearranging while another ordering is on screen adopts THAT as the
// starting arrangement, so the card lands where it was dropped rather than
// somewhere in a stored order nobody was looking at.
function seedMyChannelsManualOrder() {
  const map = loadLocalChannels();
  const displayed = sortMyChannels(Object.values(map));
  let changed = false;
  displayed.forEach((ch, i) => {
    if (!ch || !map[ch.channelId]) return;
    if (Number(map[ch.channelId].order) !== i + 1) {
      map[ch.channelId].order = i + 1;
      changed = true;
    }
  });
  if (changed) saveLocalChannelsMap(map);
}

function applyMyChannelOrder(visibleIdsInNewOrder) {
  const map = loadLocalChannels();
  const all = sortMyChannels(Object.values(map), 'manual');
  const wanted = {};
  visibleIdsInNewOrder.forEach((id) => { wanted[id] = true; });
  // The positions the visible channels hold in the full arrangement. The
  // hidden ones keep theirs untouched.
  const slots = [];
  all.forEach((ch, i) => { if (ch && wanted[ch.channelId]) slots.push(i); });
  const next = all.slice();
  visibleIdsInNewOrder.forEach((id, n) => {
    if (n < slots.length && map[id]) next[slots[n]] = map[id];
  });
  next.forEach((ch, i) => {
    if (ch && map[ch.channelId]) map[ch.channelId].order = i + 1;
  });
  saveLocalChannelsMap(map);
  // Arranging by hand IS choosing the hand-made order, so the dropdown
  // follows rather than leaving the list to re-sort out from under it.
  myChannelsSort = 'manual';
  try { localStorage.setItem('myListAddon:myChannelsSort', 'manual'); } catch (e) {}
  renderMyCreatedChannelsList();
}

function beginMyChannelReorder() {
  if (myChannelsSort !== 'manual') seedMyChannelsManualOrder();
}

// Drag-to-reorder. Mouse goes through HTML5 drag-and-drop and touch/pen
// through Pointer Events, which is the same split My Lists uses and for the
// same reason: native drag-and-drop generally does not fire on touch at all.
let myChannelDragCard = null;
let myChannelTouchCard = null;
let myChannelsDragBound = false;

function myChannelDragAfterElement(container, y) {
  const cards = [...container.querySelectorAll('.list-card[data-channel-id]:not(.dragging)')];
  return cards.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) return { offset: offset, element: child };
    return closest;
  }, { offset: -Infinity, element: null }).element;
}

function moveMyChannelDragCard(container, card, clientY) {
  const afterEl = myChannelDragAfterElement(container, clientY);
  if (afterEl == null) container.appendChild(card);
  else if (afterEl !== card) container.insertBefore(card, afterEl);
}

// Bound once on the container rather than per card, because the card list is
// re-rendered wholesale on every change and per-card listeners would be
// re-attached (and leak) each time.
function initMyChannelsDrag() {
  const container = document.getElementById('myCreatedChannelsList');
  if (!container || myChannelsDragBound) return;
  myChannelsDragBound = true;

  createSortableList(container, {
    itemSelector: '.list-card[data-channel-id]',
    handleSelector: '.channel-drag-handle',
    dragClass: 'dragging',
    onReorder: function() {
      beginMyChannelReorder();
      applyMyChannelOrder(visibleMyChannelIds());
    }
  });
}

function deleteLocalChannel(channelId, fallbackName) {
  const map = loadLocalChannels();
  const channel = map[channelId];
  let name = (channel && channel.name && channel.name !== 'Channel') ? channel.name : (fallbackName || '');
  if (!name || name === 'Channel') {
    const row = [...document.querySelectorAll('#lists .entry')].find((div) =>
      [...div.querySelectorAll('.url')].some((u) => u.value.includes(channelId))
    );
    if (row) {
      const nameInput = row.querySelector('.name');
      if (nameInput && nameInput.value.trim()) name = nameInput.value.trim();
    }
  }
  if (!name || name === 'Channel') name = (channel && channel.name) || 'Channel';

  const performDelete = () => {
    // A published channel is withdrawn from the directory as it goes.
    //
    // Deleting only removed this browser's copy, so a listing stayed up
    // advertising a channel its owner had deleted -- and with the local
    // record gone the code went too, leaving nothing to unpublish WITH.
    // Fired before the record is dropped, for the code; the publish panel
    // lists any that slip through anyway (see renderChannelPublishList), so
    // this is a best effort rather than the only chance.
    if (channel && channel.shareCode && channel.sharePublished) {
      unpublishChannelByCode(channel.shareCode).catch(() => {});
    }
    // Kept whole before it goes, so Undo can put back the channel AND its
    // place in Catalogs. A catalog row has had removeEntryWithUndo since
    // long before this; deleting a channel -- which can be eight hundred
    // hand-picked episodes -- was immediate and final.
    const snapshot = channel ? JSON.parse(JSON.stringify(channel)) : null;
    const wasInCatalogs = [...document.querySelectorAll('#lists .entry .url')]
      .some((u) => String(u.value || '').indexOf(channelId) !== -1);

    delete map[channelId];
    saveLocalChannelsMap(map);
    pruneChannelFromAllMerges(channelId);
    
    const rows = [...document.querySelectorAll('#lists .entry')];
    rows.forEach((row) => {
      const urlInputs = [...row.querySelectorAll('.url')];
      urlInputs.forEach((u) => {
        if (u.value.includes(channelId)) {
          row.remove();
        }
      });
    });
    saveState();
    if (snapshot) offerChannelDeleteUndo(snapshot, wasInCatalogs);
    renderMyCreatedChannelsList();
    renderChannelMergeList();
    showAddedToast('Deleted channel "' + name + '".');
  };

  if (typeof showAppConfirm === 'function') {
    showAppConfirm(
      'Delete Channel',
      'Delete channel "' + name + '"? This will permanently remove it from your saved channels.',
      'Delete Channel',
      performDelete,
      true
    );
  } else {
    performDelete();
  }
}

function toggleChannelInCatalog(channelId) {
  const map = loadLocalChannels();
  const channel = map[channelId];
  if (!channel) return;
  
  const rows = [...document.querySelectorAll('#lists .entry')];
  let foundRow = null;
  for (const row of rows) {
    const urlInputs = [...row.querySelectorAll('.url')];
    if (urlInputs.some((u) => u.value.includes(channelId))) {
      foundRow = row;
      break;
    }
  }
  
  if (foundRow) {
    foundRow.remove();
    saveState();
    renderMyCreatedChannelsList();
    renderChannelMergeList();
    showAddedToast('Removed "' + channel.name + '" from your Catalogs.');
  } else {
    const url = 'channel:v1:' + JSON.stringify(channel);
    addRow(channel.name, url, 'series', true, 'Channels', channelId);
    renderMyCreatedChannelsList();
    renderChannelMergeList();
    showAddedToast('Added "' + channel.name + '" to your Catalogs.');
  }
}

function renderChannelDraftList() {
  // Re-applies a remembered sort before drawing, so picks added since the
  // last render land in order. Every manual reorder disarms the sort first
  // (see clearChannelDraftAutoSort), which is what lets a hand-moved pick
  // survive the render it triggers.
  applyChannelDraftAutoSort();
  const box = document.getElementById('channelDraftList');
  const badge = document.getElementById('channelDraftCountBadge');
  if (badge) badge.textContent = channelDraftItems.length ? '(' + channelDraftItems.length + ')' : '';
  if (!channelDraftItems.length) {
    box.innerHTML = '<p style="color:var(--muted); font-size:0.85rem;"><small>Nothing added yet &mdash; search above to get started.</small></p>';
    renderChannelPosterPicker();
    renderChannelCrossoverSuggestions();
    updateChannelBroadcastControls();
    renderChannelDraftStats();
    renderChannelDraftGroupOptions();
    return;
  }
  // The filter decides what is drawn; every index below stays the index into
  // channelDraftItems, never a position in the filtered view, so a drag or a
  // typed position means the same thing filtered or not.
  const visible = channelDraftVisibleIndices();
  const cardsHtml = visible.map((i) => {
    const it = channelDraftItems[i];
    let showName = it.showName || '';
    let epName = it.epName || '';
    let seasonEp = '';
    
    if (it.kind === 'movie') {
      showName = it.title ? (it.title + (it.year && !it.title.includes(String(it.year)) ? ' (' + it.year + ')' : '')) : 'Movie';
      epName = 'Movie';
    } else {
      if (it.season != null && it.episode != null) {
        seasonEp = 'S' + it.season + 'E' + it.episode;
      }
      if (!showName && it.title) {
        if (it.title.indexOf(' S') !== -1 && it.title.indexOf('E') !== -1) {
          const sIdx = it.title.indexOf(' S');
          showName = it.title.slice(0, sIdx).trim();
          const rest = it.title.slice(sIdx + 1).trim();
          const dashIdx = rest.indexOf(' \u2014 ') !== -1 ? rest.indexOf(' \u2014 ') : (rest.indexOf(' - ') !== -1 ? rest.indexOf(' - ') : rest.indexOf(': '));
          if (dashIdx !== -1) {
            if (!seasonEp) seasonEp = rest.slice(0, dashIdx).trim();
            if (!epName) epName = rest.slice(dashIdx + (rest.indexOf(': ') === dashIdx ? 2 : 3)).trim();
          } else {
            if (!seasonEp) seasonEp = rest.trim();
          }
        } else if (it.title.indexOf(' \u2014 ') !== -1) {
          const parts = it.title.split(' \u2014 ');
          showName = parts[0].trim();
          if (!epName) epName = parts[1].trim();
        } else {
          showName = it.title.trim();
        }
      }
      if (!epName) epName = it.epName || (seasonEp ? ('Episode ' + it.episode) : 'Episode');
    }
    
    const firstLine = seasonEp ? (showName + ' ' + seasonEp) : showName;
    const secondLine = epName;
    const posterSrc = it.thumbnail || it.poster || it.showPoster || it.backdrop || '';
    const posterEl = posterSrc
      ? '<img class="live-preview-poster" src="' + escapeAttr(posterSrc) + '" alt="" loading="lazy">'
      : '<div class="live-preview-poster live-preview-poster-placeholder"><small style="color:var(--muted); font-size:0.7rem;">No poster</small></div>';

    // Dragging is off while selecting: a drag and a tap-to-select on the
    // same card are the same gesture on a touch screen, and one of the two
    // has to give.
    const selecting = channelDraftSelectMode;
    const selectBox = selecting
      ? '<div style="position:absolute; top:4px; left:4px; z-index:5;">' +
          '<input type="checkbox" class="channelPickCheck" data-idx="' + i + '"' + (isChannelDraftSelected(i) ? ' checked' : '') +
          ' aria-label="Select this pick" style="width:20px; height:20px; accent-color:var(--accent); cursor:pointer;">' +
        '</div>'
      : '<div style="position:absolute; top:4px; left:4px; z-index:4;">' +
          '<input type="number" class="pos channelPosInput" min="1" max="' + channelDraftItems.length + '" value="' + (i + 1) + '" title="Type position to move" style="width:34px; height:24px; min-height:unset; padding:2px; font-size:0.75rem; text-align:center; border-radius:6px; background:rgba(0,0,0,0.75); color:#fff; border:1px solid rgba(255,255,255,0.3); font-weight:700;">' +
        '</div>';
    const removeBtn = selecting ? '' : '<button type="button" class="cw-remove-btn channelRemovePickBtn" title="Remove pick" aria-label="Remove pick" style="z-index:4;">\u2715</button>';

    if (typeof renderMediaCard === 'function') {
      return renderMediaCard({ title: firstLine, poster: it.poster }, {
        cardClass: 'channel-pick' + (selecting && isChannelDraftSelected(i) ? ' channel-pick-selected' : ''),
        dataAttrs: { idx: i },
        style: 'position:relative; cursor:' + (selecting ? 'pointer' : 'grab') + '; user-select:none; touch-action:manipulation;',
        topLeftHtml: selectBox,
        topRightHtml: removeBtn,
        subtitleHtml: '<span title="' + escapeAttr(secondLine) + '">' + escapeHtml(secondLine) + '</span>'
      });
    }

    return '<div class="live-preview-poster-card channel-pick' + (selecting && isChannelDraftSelected(i) ? ' channel-pick-selected' : '') + '" data-idx="' + i + '" style="position:relative; cursor:' + (selecting ? 'pointer' : 'grab') + '; user-select:none; touch-action:manipulation;">' +
      '<div style="position:relative; width:100%;">' +
        posterEl +
        selectBox +
        removeBtn +
      '</div>' +
      '<div class="live-preview-poster-name" title="' + escapeAttr(firstLine) + '">' + escapeHtml(firstLine) + '</div>' +
      '<div class="live-preview-poster-year" title="' + escapeAttr(secondLine) + '">' + escapeHtml(secondLine) + '</div>' +
    '</div>';
  }).join('');
  
  box.innerHTML = visible.length
    ? '<div class="poster-grid-3" style="margin-top:10px;">' + cardsHtml + '</div>'
    : '<p style="color:var(--muted); font-size:0.85rem;"><small>No pick in this channel matches that filter.</small></p>';
  const bulkBar = document.getElementById('channelDraftBulkBar');
  if (bulkBar) bulkBar.style.display = channelDraftSelectMode ? 'flex' : 'none';
  const modeBtn = document.getElementById('channelDraftSelectModeBtn');
  if (modeBtn) modeBtn.textContent = channelDraftSelectMode ? 'Done' : 'Select';
  renderChannelDraftGroupOptions();
  updateChannelDraftSelectionCount();
  renderChannelDraftStats();
  // Bound unconditionally: the binding happens once and the handler itself
  // stands down while selecting, so skipping the call here would only mean
  // never binding at all if the first render happened to be in Select mode.
  initChannelHoldDrag();
  renderChannelPosterPicker();
  renderChannelCrossoverSuggestions();
  // The schedule hint counts the draft's shows and Story Lock lists them,
  // so both have to be redrawn whenever the picks change.
  updateChannelBroadcastControls();
}

function renderChannelPosterPicker() {
  const section = document.getElementById('channelPosterPickerSection');
  const grid = document.getElementById('channelPosterChoicesGrid');
  if (!section || !grid) return;

  if (!channelDraftItems.length) {
    section.style.display = 'none';
    grid.innerHTML = '';
    return;
  }

  section.style.display = 'block';

  // Group shows from channelDraftItems and count episodes
  const showsMap = new Map();
  channelDraftItems.forEach((it) => {
    let showName = it.showName || '';
    let showPoster = it.showPoster || '';
    let showBackdrop = it.backdrop || it.showBackdrop || it.thumbnail || '';
    if (!showPoster && it.poster && it.poster.startsWith('http') && !it.poster.includes('/api/channel-')) {
      showPoster = it.poster;
    }
    if (it.kind === 'movie') {
      showName = it.title ? (it.title + (it.year && !it.title.includes(String(it.year)) ? ' (' + it.year + ')' : '')) : 'Movie';
      showPoster = it.poster || it.thumbnail || '';
      showBackdrop = it.backdrop || it.thumbnail || it.poster || '';
    } else if (!showName && it.title) {
      if (it.title.indexOf(' S') !== -1 && it.title.indexOf('E') !== -1) {
        showName = it.title.slice(0, it.title.indexOf(' S')).trim();
      } else if (it.title.indexOf(' \u2014 ') !== -1) {
        showName = it.title.split(' \u2014 ')[0].trim();
      } else if (it.title.indexOf(' - ') !== -1) {
        showName = it.title.split(' - ')[0].trim();
      } else {
        showName = it.title.trim();
      }
    }
    if (!showName) showName = 'Show';

    if (!showsMap.has(showName)) {
      showsMap.set(showName, {
        name: showName,
        poster: showPoster,
        backdrop: showBackdrop,
        count: 0
      });
    }
    const entry = showsMap.get(showName);
    entry.count++;
    if (!entry.poster && showPoster) {
      entry.poster = showPoster;
    }
    if (!entry.backdrop && showBackdrop) {
      entry.backdrop = showBackdrop;
    }
  });

  const shows = [...showsMap.values()].filter((s) => s.poster && s.poster.startsWith('http'));
  // Sort show posters in descending order by episode count
  shows.sort((a, b) => b.count - a.count);

  if (channelDraftPoster === undefined || channelDraftPoster === null) {
    channelDraftPoster = shows.length ? shows[0].poster : 'custom';
    channelDraftBackdrop = (shows.length && shows[0].backdrop) ? shows[0].backdrop : null;
  }

  const isCustomSelected = (channelDraftPoster === 'custom' || !channelDraftPoster || channelDraftPoster.includes('/api/channel-poster'));

  // 1. Custom Channel Poster Option
  let html = '<div class="channel-poster-choice' + (isCustomSelected ? ' selected' : '') + '" data-poster="custom" data-backdrop="" onclick="selectChannelPoster(&quot;custom&quot;, &quot;&quot;)">' +
    '<div class="channel-poster-thumb-wrap custom-preview" style="background:linear-gradient(135deg,#0b0d14 0%,#131726 50%,#06070a 100%); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:4px; padding:6px; border:1px solid rgba(0,122,255,0.3);">' +
      '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="#007AFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<rect x="2" y="7" width="20" height="15" rx="2" ry="2"></rect>' +
        '<polyline points="17 2 12 7 7 2"></polyline>' +
      '</svg>' +
      '<span style="font-size:0.62rem; font-weight:700; color:#fff; text-transform:uppercase; letter-spacing:0.5px; text-align:center;">Custom</span>' +
    '</div>' +
    '<div class="channel-poster-check">\u2713</div>' +
    '<div class="channel-poster-title" title="Custom Channel Poster">Custom Poster</div>' +
    '<div class="channel-poster-meta">Provided</div>' +
  '</div>';

  // 2. Show Posters ordered by episode count descending
  shows.forEach((s) => {
    const isSelected = !isCustomSelected && (channelDraftPoster === s.poster);
    const countLabel = s.count + ' ep' + (s.count === 1 ? '' : 's');
    html += '<div class="channel-poster-choice' + (isSelected ? ' selected' : '') + '" data-poster="' + escapeAttr(s.poster) + '" data-backdrop="' + escapeAttr(s.backdrop || '') + '" onclick="selectChannelPoster(this.dataset.poster, this.dataset.backdrop)">' +
      '<div class="channel-poster-thumb-wrap">' +
        '<img src="' + escapeAttr(s.poster) + '" alt="' + escapeAttr(s.name) + '" loading="lazy">' +
      '</div>' +
      '<div class="channel-poster-check">\u2713</div>' +
      '<div class="channel-poster-title" title="' + escapeAttr(s.name) + '">' + escapeHtml(s.name) + '</div>' +
      '<div class="channel-poster-meta">' + escapeHtml(countLabel) + '</div>' +
    '</div>';
  });

  grid.innerHTML = html;
  if (typeof syncChannelPosterUrlInput === 'function') syncChannelPosterUrlInput();
}

function selectChannelPoster(posterUrl, backdropUrl) {
  channelDraftPoster = (posterUrl === 'custom' || !posterUrl) ? 'custom' : posterUrl;
  channelDraftBackdrop = (posterUrl === 'custom' || !posterUrl) ? null : (backdropUrl || null);
  const cards = document.querySelectorAll('#channelPosterChoicesGrid .channel-poster-choice');
  cards.forEach((card) => {
    const cardPoster = card.dataset.poster;
    if (channelDraftPoster === 'custom' && cardPoster === 'custom') {
      card.classList.add('selected');
    } else if (channelDraftPoster !== 'custom' && cardPoster === channelDraftPoster) {
      card.classList.add('selected');
    } else {
      card.classList.remove('selected');
    }
  });
  // Clear URL input if a grid card was chosen
  const urlInput = document.getElementById('channelPosterUrlInput');
  const preview = document.getElementById('channelPosterUrlPreview');
  if (urlInput) urlInput.value = '';
  if (preview) preview.style.display = 'none';
}

function applyChannelPosterUrl() {
  const urlInput = document.getElementById('channelPosterUrlInput');
  const preview = document.getElementById('channelPosterUrlPreview');
  const previewImg = document.getElementById('channelPosterUrlImg');
  const status = document.getElementById('channelPosterUrlStatus');
  if (!urlInput) return;

  const raw = urlInput.value.trim();
  if (!raw) return;

  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    if (status) { status.textContent = 'Invalid URL \u2014 please enter a full URL starting with https://'; status.style.color = 'var(--err, #ff453a)'; }
    if (preview) preview.style.display = 'flex';
    if (previewImg) previewImg.style.display = 'none';
    return;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    if (status) { status.textContent = 'Only http:// or https:// URLs are supported.'; status.style.color = 'var(--err, #ff453a)'; }
    if (preview) preview.style.display = 'flex';
    if (previewImg) previewImg.style.display = 'none';
    return;
  }

  // Apply the URL immediately — don't wait for the preview to load
  channelDraftPoster = url.href;
  channelDraftBackdrop = null;
  const cards = document.querySelectorAll('#channelPosterChoicesGrid .channel-poster-choice');
  cards.forEach((card) => card.classList.remove('selected'));

  if (status) { status.textContent = 'Poster URL applied \u2713 (preview loading\u2026)'; status.style.color = 'var(--success, #30d158)'; }
  if (preview) preview.style.display = 'flex';

  if (previewImg) {
    previewImg.style.display = 'none';

    let settled = false;

    const settle = (ok) => {
      if (settled) return;
      settled = true;
      if (ok) {
        previewImg.style.display = '';
        if (status) { status.textContent = 'Poster URL applied \u2713'; status.style.color = 'var(--success, #30d158)'; }
      } else {
        previewImg.style.display = 'none';
        if (status) {
          status.textContent = 'URL applied \u2713 (preview unavailable \u2014 the image may have hotlink protection, but it will still be used as the poster)';
          status.style.color = 'var(--muted)';
        }
      }
    };

    previewImg.onerror = () => settle(false);
    previewImg.onload = () => settle(true);

    // If neither fires within 4 seconds, show a friendly fallback message
    setTimeout(() => settle(false), 4000);

    previewImg.src = url.href;
  }
}

// Restore URL input when editing a channel that has a custom URL poster
function syncChannelPosterUrlInput() {
  const urlInput = document.getElementById('channelPosterUrlInput');
  const preview = document.getElementById('channelPosterUrlPreview');
  const previewImg = document.getElementById('channelPosterUrlImg');
  const status = document.getElementById('channelPosterUrlStatus');
  if (!urlInput) return;

  const isUrlPoster = channelDraftPoster
    && channelDraftPoster !== 'custom'
    && !channelDraftPoster.includes('/api/channel-')
    // It's a custom URL if it isn't one of the auto-extracted show posters in the grid
    && !document.querySelector('#channelPosterChoicesGrid .channel-poster-choice.selected');

  if (isUrlPoster) {
    urlInput.value = channelDraftPoster;
    if (previewImg) {
      previewImg.src = channelDraftPoster;
      previewImg.style.display = '';
    }
    if (status) { status.textContent = 'Poster URL applied \u2713'; status.style.color = 'var(--success, #30d158)'; }
    if (preview) preview.style.display = 'flex';
  } else {
    urlInput.value = '';
    if (preview) preview.style.display = 'none';
  }
}

// --- // --- Sagas, Universes & Movie Franchises Registry ---------------------------
const TV_CROSSOVER_EVENTS = [
  {
    "id": "movie_mcu_infinity_saga",
    "name": "Marvel Cinematic Universe: The Infinity Saga",
    "franchise": "Marvel",
    "category": "moviesagas",
    "description": "The complete 12-movie core Infinity Saga in chronological storyline order, from Steve Rogers in WWII through the culmination of Endgame.",
    "episodes": [
      {
        "type": "movie",
        "title": "Captain America: The First Avenger",
        "year": 2011,
        "tmdbId": 1771,
        "imdbId": "tt0458339",
        "poster": "https://images.metahub.space/poster/medium/tt0458339/img",
        "part": 1
      },
      {
        "type": "movie",
        "title": "Captain Marvel",
        "year": 2019,
        "tmdbId": 299537,
        "imdbId": "tt4154664",
        "poster": "https://images.metahub.space/poster/medium/tt4154664/img",
        "part": 2
      },
      {
        "type": "movie",
        "title": "Iron Man",
        "year": 2008,
        "tmdbId": 1726,
        "imdbId": "tt0371746",
        "poster": "https://images.metahub.space/poster/medium/tt0371746/img",
        "part": 3
      },
      {
        "type": "movie",
        "title": "Iron Man 2",
        "year": 2010,
        "tmdbId": 10138,
        "imdbId": "tt1228705",
        "poster": "https://images.metahub.space/poster/medium/tt1228705/img",
        "part": 4
      },
      {
        "type": "movie",
        "title": "Thor",
        "year": 2011,
        "tmdbId": 10195,
        "imdbId": "tt0800369",
        "poster": "https://images.metahub.space/poster/medium/tt0800369/img",
        "part": 5
      },
      {
        "type": "movie",
        "title": "The Avengers",
        "year": 2012,
        "tmdbId": 24428,
        "imdbId": "tt0848228",
        "poster": "https://images.metahub.space/poster/medium/tt0848228/img",
        "part": 6
      },
      {
        "type": "movie",
        "title": "Captain America: The Winter Soldier",
        "year": 2014,
        "tmdbId": 100402,
        "imdbId": "tt1843866",
        "poster": "https://images.metahub.space/poster/medium/tt1843866/img",
        "part": 7
      },
      {
        "type": "movie",
        "title": "Guardians of the Galaxy",
        "year": 2014,
        "tmdbId": 118340,
        "imdbId": "tt2015381",
        "poster": "https://images.metahub.space/poster/medium/tt2015381/img",
        "part": 8
      },
      {
        "type": "movie",
        "title": "Avengers: Age of Ultron",
        "year": 2015,
        "tmdbId": 99861,
        "imdbId": "tt2395427",
        "poster": "https://images.metahub.space/poster/medium/tt2395427/img",
        "part": 9
      },
      {
        "type": "movie",
        "title": "Captain America: Civil War",
        "year": 2016,
        "tmdbId": 271110,
        "imdbId": "tt3498820",
        "poster": "https://images.metahub.space/poster/medium/tt3498820/img",
        "part": 10
      },
      {
        "type": "movie",
        "title": "Avengers: Infinity War",
        "year": 2018,
        "tmdbId": 299536,
        "imdbId": "tt4154756",
        "poster": "https://images.metahub.space/poster/medium/tt4154756/img",
        "part": 11
      },
      {
        "type": "movie",
        "title": "Avengers: Endgame",
        "year": 2019,
        "tmdbId": 299534,
        "imdbId": "tt4154796",
        "poster": "https://images.metahub.space/poster/medium/tt4154796/img",
        "part": 12
      }
    ]
  },
  {
    "id": "movie_star_wars_skywalker_saga",
    "name": "Star Wars: The Complete Skywalker Saga & Stories",
    "franchise": "Star Wars",
    "category": "moviesagas",
    "description": "The complete 11-film saga in chronological in-universe order: Episodes I-III, Solo, Rogue One, the Original Trilogy (IV-VI), and the Sequel Trilogy (VII-IX).",
    "episodes": [
      {
        "type": "movie",
        "title": "Star Wars: Episode I - The Phantom Menace",
        "year": 1999,
        "tmdbId": 1893,
        "imdbId": "tt0120915",
        "poster": "https://images.metahub.space/poster/medium/tt0120915/img",
        "part": 1
      },
      {
        "type": "movie",
        "title": "Star Wars: Episode II - Attack of the Clones",
        "year": 2002,
        "tmdbId": 1894,
        "imdbId": "tt0121765",
        "poster": "https://images.metahub.space/poster/medium/tt0121765/img",
        "part": 2
      },
      {
        "type": "movie",
        "title": "Star Wars: Episode III - Revenge of the Sith",
        "year": 2005,
        "tmdbId": 1895,
        "imdbId": "tt0121766",
        "poster": "https://images.metahub.space/poster/medium/tt0121766/img",
        "part": 3
      },
      {
        "type": "movie",
        "title": "Solo: A Star Wars Story",
        "year": 2018,
        "tmdbId": 348350,
        "imdbId": "tt3778644",
        "poster": "https://images.metahub.space/poster/medium/tt3778644/img",
        "part": 4
      },
      {
        "type": "movie",
        "title": "Rogue One: A Star Wars Story",
        "year": 2016,
        "tmdbId": 330459,
        "imdbId": "tt3748528",
        "poster": "https://images.metahub.space/poster/medium/tt3748528/img",
        "part": 5
      },
      {
        "type": "movie",
        "title": "Star Wars: Episode IV - A New Hope",
        "year": 1977,
        "tmdbId": 11,
        "imdbId": "tt0076759",
        "poster": "https://images.metahub.space/poster/medium/tt0076759/img",
        "part": 6
      },
      {
        "type": "movie",
        "title": "Star Wars: Episode V - The Empire Strikes Back",
        "year": 1980,
        "tmdbId": 1891,
        "imdbId": "tt0080684",
        "poster": "https://images.metahub.space/poster/medium/tt0080684/img",
        "part": 7
      },
      {
        "type": "movie",
        "title": "Star Wars: Episode VI - Return of the Jedi",
        "year": 1983,
        "tmdbId": 1892,
        "imdbId": "tt0086190",
        "poster": "https://images.metahub.space/poster/medium/tt0086190/img",
        "part": 8
      },
      {
        "type": "movie",
        "title": "Star Wars: Episode VII - The Force Awakens",
        "year": 2015,
        "tmdbId": 140607,
        "imdbId": "tt2488496",
        "poster": "https://images.metahub.space/poster/medium/tt2488496/img",
        "part": 9
      },
      {
        "type": "movie",
        "title": "Star Wars: Episode VIII - The Last Jedi",
        "year": 2017,
        "tmdbId": 181808,
        "imdbId": "tt2527336",
        "poster": "https://images.metahub.space/poster/medium/tt2527336/img",
        "part": 10
      },
      {
        "type": "movie",
        "title": "Star Wars: Episode IX - The Rise of Skywalker",
        "year": 2019,
        "tmdbId": 181812,
        "imdbId": "tt2527338",
        "poster": "https://images.metahub.space/poster/medium/tt2527338/img",
        "part": 11
      }
    ]
  },
  {
    "id": "movie_middle_earth_saga",
    "name": "Middle-earth: The Hobbit & The Lord of the Rings",
    "franchise": "The Lord of the Rings",
    "category": "moviesagas",
    "description": "Peter Jackson's epic 6-film saga in chronological watch order: The Hobbit trilogy followed by The Lord of the Rings trilogy.",
    "episodes": [
      {
        "type": "movie",
        "title": "The Hobbit: An Unexpected Journey",
        "year": 2012,
        "tmdbId": 49051,
        "imdbId": "tt0903624",
        "poster": "https://images.metahub.space/poster/medium/tt0903624/img",
        "part": 1
      },
      {
        "type": "movie",
        "title": "The Hobbit: The Desolation of Smaug",
        "year": 2013,
        "tmdbId": 57158,
        "imdbId": "tt1170358",
        "poster": "https://images.metahub.space/poster/medium/tt1170358/img",
        "part": 2
      },
      {
        "type": "movie",
        "title": "The Hobbit: The Battle of the Five Armies",
        "year": 2014,
        "tmdbId": 122917,
        "imdbId": "tt2310332",
        "poster": "https://images.metahub.space/poster/medium/tt2310332/img",
        "part": 3
      },
      {
        "type": "movie",
        "title": "The Lord of the Rings: The Fellowship of the Ring",
        "year": 2001,
        "tmdbId": 120,
        "imdbId": "tt0120737",
        "poster": "https://images.metahub.space/poster/medium/tt0120737/img",
        "part": 4
      },
      {
        "type": "movie",
        "title": "The Lord of the Rings: The Two Towers",
        "year": 2002,
        "tmdbId": 121,
        "imdbId": "tt0167261",
        "poster": "https://images.metahub.space/poster/medium/tt0167261/img",
        "part": 5
      },
      {
        "type": "movie",
        "title": "The Lord of the Rings: The Return of the King",
        "year": 2003,
        "tmdbId": 122,
        "imdbId": "tt0167260",
        "poster": "https://images.metahub.space/poster/medium/tt0167260/img",
        "part": 6
      }
    ]
  },
  {
    "id": "movie_batman_dark_knight_trilogy",
    "name": "Batman: The Dark Knight Trilogy",
    "franchise": "Batman",
    "category": "moviesagas",
    "description": "Christopher Nolan's definitive Batman trilogy from Bruce Wayne's origins to the fall and rise of Gotham's protector.",
    "episodes": [
      {
        "type": "movie",
        "title": "Batman Begins",
        "year": 2005,
        "tmdbId": 272,
        "imdbId": "tt0372784",
        "poster": "https://images.metahub.space/poster/medium/tt0372784/img",
        "part": 1
      },
      {
        "type": "movie",
        "title": "The Dark Knight",
        "year": 2008,
        "tmdbId": 155,
        "imdbId": "tt0468569",
        "poster": "https://images.metahub.space/poster/medium/tt0468569/img",
        "part": 2
      },
      {
        "type": "movie",
        "title": "The Dark Knight Rises",
        "year": 2012,
        "tmdbId": 49026,
        "imdbId": "tt1345836",
        "poster": "https://images.metahub.space/poster/medium/tt1345836/img",
        "part": 3
      }
    ]
  },
  {
    "id": "movie_harry_potter_wizarding_world",
    "name": "Harry Potter & The Wizarding World",
    "franchise": "Harry Potter",
    "category": "moviesagas",
    "description": "The complete 11-film Wizarding World in chronological watch order: Fantastic Beasts (1-3) followed by Harry Potter (1-8).",
    "episodes": [
      {
        "type": "movie",
        "title": "Fantastic Beasts and Where to Find Them",
        "year": 2016,
        "tmdbId": 259316,
        "imdbId": "tt3183660",
        "poster": "https://images.metahub.space/poster/medium/tt3183660/img",
        "part": 1
      },
      {
        "type": "movie",
        "title": "Fantastic Beasts: The Crimes of Grindelwald",
        "year": 2018,
        "tmdbId": 338952,
        "imdbId": "tt4123430",
        "poster": "https://images.metahub.space/poster/medium/tt4123430/img",
        "part": 2
      },
      {
        "type": "movie",
        "title": "Fantastic Beasts: The Secrets of Dumbledore",
        "year": 2022,
        "tmdbId": 338953,
        "imdbId": "tt4123432",
        "poster": "https://images.metahub.space/poster/medium/tt4123432/img",
        "part": 3
      },
      {
        "type": "movie",
        "title": "Harry Potter and the Sorcerer's Stone",
        "year": 2001,
        "tmdbId": 671,
        "imdbId": "tt0241527",
        "poster": "https://images.metahub.space/poster/medium/tt0241527/img",
        "part": 4
      },
      {
        "type": "movie",
        "title": "Harry Potter and the Chamber of Secrets",
        "year": 2002,
        "tmdbId": 672,
        "imdbId": "tt0295297",
        "poster": "https://images.metahub.space/poster/medium/tt0295297/img",
        "part": 5
      },
      {
        "type": "movie",
        "title": "Harry Potter and the Prisoner of Azkaban",
        "year": 2004,
        "tmdbId": 673,
        "imdbId": "tt0304141",
        "poster": "https://images.metahub.space/poster/medium/tt0304141/img",
        "part": 6
      },
      {
        "type": "movie",
        "title": "Harry Potter and the Goblet of Fire",
        "year": 2005,
        "tmdbId": 674,
        "imdbId": "tt0330373",
        "poster": "https://images.metahub.space/poster/medium/tt0330373/img",
        "part": 7
      },
      {
        "type": "movie",
        "title": "Harry Potter and the Order of the Phoenix",
        "year": 2007,
        "tmdbId": 675,
        "imdbId": "tt0373889",
        "poster": "https://images.metahub.space/poster/medium/tt0373889/img",
        "part": 8
      },
      {
        "type": "movie",
        "title": "Harry Potter and the Half-Blood Prince",
        "year": 2009,
        "tmdbId": 767,
        "imdbId": "tt0417741",
        "poster": "https://images.metahub.space/poster/medium/tt0417741/img",
        "part": 9
      },
      {
        "type": "movie",
        "title": "Harry Potter and the Deathly Hallows: Part 1",
        "year": 2010,
        "tmdbId": 12444,
        "imdbId": "tt0926084",
        "poster": "https://images.metahub.space/poster/medium/tt0926084/img",
        "part": 10
      },
      {
        "type": "movie",
        "title": "Harry Potter and the Deathly Hallows: Part 2",
        "year": 2011,
        "tmdbId": 12445,
        "imdbId": "tt1201607",
        "poster": "https://images.metahub.space/poster/medium/tt1201607/img",
        "part": 11
      }
    ]
  },
  {
    "id": "movie_fast_and_furious_saga",
    "name": "The Fast and the Furious: Complete Saga",
    "franchise": "Fast & Furious",
    "category": "moviesagas",
    "description": "The complete 11-film high-octane saga in chronological narrative order (with Tokyo Drift placed correctly before Furious 7).",
    "episodes": [
      {
        "type": "movie",
        "title": "The Fast and the Furious",
        "year": 2001,
        "tmdbId": 9799,
        "imdbId": "tt0232500",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0232500/img"
      },
      {
        "type": "movie",
        "title": "2 Fast 2 Furious",
        "year": 2003,
        "tmdbId": 584,
        "imdbId": "tt0322259",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0322259/img"
      },
      {
        "type": "movie",
        "title": "Fast & Furious",
        "year": 2009,
        "tmdbId": 13804,
        "imdbId": "tt1013752",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt1013752/img"
      },
      {
        "type": "movie",
        "title": "Fast Five",
        "year": 2011,
        "tmdbId": 51497,
        "imdbId": "tt1596343",
        "part": 4,
        "poster": "https://images.metahub.space/poster/medium/tt1596343/img"
      },
      {
        "type": "movie",
        "title": "Fast & Furious 6",
        "year": 2013,
        "tmdbId": 82992,
        "imdbId": "tt1905041",
        "part": 5,
        "poster": "https://images.metahub.space/poster/medium/tt1905041/img"
      },
      {
        "type": "movie",
        "title": "The Fast and the Furious: Tokyo Drift",
        "year": 2006,
        "tmdbId": 9615,
        "imdbId": "tt0463985",
        "part": 6,
        "poster": "https://images.metahub.space/poster/medium/tt0463985/img"
      },
      {
        "type": "movie",
        "title": "Furious 7",
        "year": 2015,
        "tmdbId": 168259,
        "imdbId": "tt2820852",
        "part": 7,
        "poster": "https://images.metahub.space/poster/medium/tt2820852/img"
      },
      {
        "type": "movie",
        "title": "The Fate of the Furious",
        "year": 2017,
        "tmdbId": 337339,
        "imdbId": "tt4630562",
        "part": 8,
        "poster": "https://images.metahub.space/poster/medium/tt4630562/img"
      },
      {
        "type": "movie",
        "title": "Fast & Furious Presents: Hobbs & Shaw",
        "year": 2019,
        "tmdbId": 384018,
        "imdbId": "tt6806448",
        "part": 9,
        "poster": "https://images.metahub.space/poster/medium/tt6806448/img"
      },
      {
        "type": "movie",
        "title": "F9",
        "year": 2021,
        "tmdbId": 385128,
        "imdbId": "tt5433138",
        "part": 10,
        "poster": "https://images.metahub.space/poster/medium/tt5433138/img"
      },
      {
        "type": "movie",
        "title": "Fast X",
        "year": 2023,
        "tmdbId": 385687,
        "imdbId": "tt5433140",
        "part": 11,
        "poster": "https://images.metahub.space/poster/medium/tt5433140/img"
      }
    ]
  },
  {
    "id": "movie_alien_predator_timeline",
    "name": "Alien & Predator: Complete Universe Timeline",
    "franchise": "Alien",
    "category": "moviesagas",
    "description": "The complete xenomorph and yautja chronology: from Prey (1719) and Prometheus through Alien: Romulus (2024) and Resurrection.",
    "episodes": [
      {
        "type": "movie",
        "title": "Prey",
        "year": 2022,
        "tmdbId": 766507,
        "imdbId": "tt11866324",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt11866324/img"
      },
      {
        "type": "movie",
        "title": "Alien vs. Predator",
        "year": 2004,
        "tmdbId": 395,
        "imdbId": "tt0370263",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0370263/img"
      },
      {
        "type": "movie",
        "title": "Aliens vs. Predator: Requiem",
        "year": 2007,
        "tmdbId": 440,
        "imdbId": "tt0758730",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt0758730/img"
      },
      {
        "type": "movie",
        "title": "Prometheus",
        "year": 2012,
        "tmdbId": 70981,
        "imdbId": "tt1446714",
        "part": 4,
        "poster": "https://images.metahub.space/poster/medium/tt1446714/img"
      },
      {
        "type": "movie",
        "title": "Alien: Covenant",
        "year": 2017,
        "tmdbId": 342473,
        "imdbId": "tt2316204",
        "part": 5,
        "poster": "https://images.metahub.space/poster/medium/tt2316204/img"
      },
      {
        "type": "movie",
        "title": "Alien",
        "year": 1979,
        "tmdbId": 348,
        "imdbId": "tt0078748",
        "part": 6,
        "poster": "https://images.metahub.space/poster/medium/tt0078748/img"
      },
      {
        "type": "movie",
        "title": "Alien: Romulus",
        "year": 2024,
        "tmdbId": 945961,
        "imdbId": "tt18412256",
        "part": 7,
        "poster": "https://images.metahub.space/poster/medium/tt18412256/img"
      },
      {
        "type": "movie",
        "title": "Aliens",
        "year": 1986,
        "tmdbId": 679,
        "imdbId": "tt0090605",
        "part": 8,
        "poster": "https://images.metahub.space/poster/medium/tt0090605/img"
      },
      {
        "type": "movie",
        "title": "Alien 3",
        "year": 1992,
        "tmdbId": 8077,
        "imdbId": "tt0103644",
        "part": 9,
        "poster": "https://images.metahub.space/poster/medium/tt0103644/img"
      },
      {
        "type": "movie",
        "title": "Alien: Resurrection",
        "year": 1997,
        "tmdbId": 8078,
        "imdbId": "tt0118583",
        "part": 10,
        "poster": "https://images.metahub.space/poster/medium/tt0118583/img"
      }
    ]
  },
  {
    "id": "movie_planet_of_the_apes_reboot",
    "name": "Planet of the Apes: Modern Reboot Saga",
    "franchise": "Planet of the Apes",
    "category": "moviesagas",
    "description": "The critically acclaimed modern saga following Caesar's rise, the war for Earth, and the new kingdom generations later.",
    "episodes": [
      {
        "type": "movie",
        "title": "Rise of the Planet of the Apes",
        "year": 2011,
        "tmdbId": 61791,
        "imdbId": "tt1318514",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt1318514/img"
      },
      {
        "type": "movie",
        "title": "Dawn of the Planet of the Apes",
        "year": 2014,
        "tmdbId": 119450,
        "imdbId": "tt2103281",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt2103281/img"
      },
      {
        "type": "movie",
        "title": "War for the Planet of the Apes",
        "year": 2017,
        "tmdbId": 281338,
        "imdbId": "tt3450958",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt3450958/img"
      },
      {
        "type": "movie",
        "title": "Kingdom of the Planet of the Apes",
        "year": 2024,
        "tmdbId": 653346,
        "imdbId": "tt11389872",
        "part": 4,
        "poster": "https://images.metahub.space/poster/medium/tt11389872/img"
      }
    ]
  },
  {
    "id": "movie_mission_impossible_saga",
    "name": "Mission: Impossible Complete Chronology",
    "franchise": "Mission: Impossible",
    "category": "moviesagas",
    "description": "All 7 globe-trotting espionage thrillers starring Tom Cruise as IMF agent Ethan Hunt.",
    "episodes": [
      {
        "type": "movie",
        "title": "Mission: Impossible",
        "year": 1996,
        "tmdbId": 954,
        "imdbId": "tt0117060",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0117060/img"
      },
      {
        "type": "movie",
        "title": "Mission: Impossible II",
        "year": 2000,
        "tmdbId": 955,
        "imdbId": "tt0120755",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0120755/img"
      },
      {
        "type": "movie",
        "title": "Mission: Impossible III",
        "year": 2006,
        "tmdbId": 956,
        "imdbId": "tt0317919",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt0317919/img"
      },
      {
        "type": "movie",
        "title": "Mission: Impossible - Ghost Protocol",
        "year": 2011,
        "tmdbId": 56292,
        "imdbId": "tt1229238",
        "part": 4,
        "poster": "https://images.metahub.space/poster/medium/tt1229238/img"
      },
      {
        "type": "movie",
        "title": "Mission: Impossible - Rogue Nation",
        "year": 2015,
        "tmdbId": 177677,
        "imdbId": "tt2381249",
        "part": 5,
        "poster": "https://images.metahub.space/poster/medium/tt2381249/img"
      },
      {
        "type": "movie",
        "title": "Mission: Impossible - Fallout",
        "year": 2018,
        "tmdbId": 353081,
        "imdbId": "tt4912910",
        "part": 6,
        "poster": "https://images.metahub.space/poster/medium/tt4912910/img"
      },
      {
        "type": "movie",
        "title": "Mission: Impossible - Dead Reckoning Part One",
        "year": 2023,
        "tmdbId": 575264,
        "imdbId": "tt9603212",
        "part": 7,
        "poster": "https://images.metahub.space/poster/medium/tt9603212/img"
      }
    ]
  },
  {
    "id": "movie_james_bond_craig_era",
    "name": "James Bond: The Daniel Craig 007 Era",
    "franchise": "James Bond",
    "category": "moviesagas",
    "description": "The complete 5-film serialized story arc of 007 from his first Double-O assignment to his final mission.",
    "episodes": [
      {
        "type": "movie",
        "title": "Casino Royale",
        "year": 2006,
        "tmdbId": 36557,
        "imdbId": "tt0381061",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0381061/img"
      },
      {
        "type": "movie",
        "title": "Quantum of Solace",
        "year": 2008,
        "tmdbId": 10764,
        "imdbId": "tt0830515",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0830515/img"
      },
      {
        "type": "movie",
        "title": "Skyfall",
        "year": 2012,
        "tmdbId": 37724,
        "imdbId": "tt1074638",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt1074638/img"
      },
      {
        "type": "movie",
        "title": "Spectre",
        "year": 2015,
        "tmdbId": 206647,
        "imdbId": "tt2379713",
        "part": 4,
        "poster": "https://images.metahub.space/poster/medium/tt2379713/img"
      },
      {
        "type": "movie",
        "title": "No Time to Die",
        "year": 2021,
        "tmdbId": 370172,
        "imdbId": "tt2382320",
        "part": 5,
        "poster": "https://images.metahub.space/poster/medium/tt2382320/img"
      }
    ]
  },
  {
    "id": "movie_john_wick_universe",
    "name": "John Wick: Complete Universe",
    "franchise": "John Wick",
    "category": "moviesagas",
    "description": "The relentless 4-chapter saga of the legendary Baba Yaga fighting his way through the High Table.",
    "episodes": [
      {
        "type": "movie",
        "title": "John Wick",
        "year": 2014,
        "tmdbId": 245891,
        "imdbId": "tt2911666",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt2911666/img"
      },
      {
        "type": "movie",
        "title": "John Wick: Chapter 2",
        "year": 2017,
        "tmdbId": 324552,
        "imdbId": "tt4425200",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt4425200/img"
      },
      {
        "type": "movie",
        "title": "John Wick: Chapter 3 - Parabellum",
        "year": 2019,
        "tmdbId": 458156,
        "imdbId": "tt6146586",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt6146586/img"
      },
      {
        "type": "movie",
        "title": "John Wick: Chapter 4",
        "year": 2023,
        "tmdbId": 603692,
        "imdbId": "tt10366206",
        "part": 4,
        "poster": "https://images.metahub.space/poster/medium/tt10366206/img"
      }
    ]
  },
  {
    "id": "movie_matrix_complete_saga",
    "name": "The Matrix: Complete Quadrilogy",
    "franchise": "The Matrix",
    "category": "moviesagas",
    "description": "The Wachowskis' groundbreaking cyberpunk saga from Neo's awakening to the battle of Zion and Resurrections.",
    "episodes": [
      {
        "type": "movie",
        "title": "The Matrix",
        "year": 1999,
        "tmdbId": 603,
        "imdbId": "tt0133093",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0133093/img"
      },
      {
        "type": "movie",
        "title": "The Matrix Reloaded",
        "year": 2003,
        "tmdbId": 604,
        "imdbId": "tt0234215",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0234215/img"
      },
      {
        "type": "movie",
        "title": "The Matrix Revolutions",
        "year": 2003,
        "tmdbId": 605,
        "imdbId": "tt0242653",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt0242653/img"
      },
      {
        "type": "movie",
        "title": "The Matrix Resurrections",
        "year": 2021,
        "tmdbId": 624860,
        "imdbId": "tt10838180",
        "part": 4,
        "poster": "https://images.metahub.space/poster/medium/tt10838180/img"
      }
    ]
  },
  {
    "id": "movie_hunger_games_chronology",
    "name": "The Hunger Games: Complete Chronology",
    "franchise": "The Hunger Games",
    "category": "moviesagas",
    "description": "Panem's saga in timeline order: The Ballad of Songbirds & Snakes (2023) followed by Katniss Everdeen's revolution.",
    "episodes": [
      {
        "type": "movie",
        "title": "The Hunger Games: The Ballad of Songbirds & Snakes",
        "year": 2023,
        "tmdbId": 695721,
        "imdbId": "tt10545296",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt10545296/img"
      },
      {
        "type": "movie",
        "title": "The Hunger Games",
        "year": 2012,
        "tmdbId": 70160,
        "imdbId": "tt1392170",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt1392170/img"
      },
      {
        "type": "movie",
        "title": "The Hunger Games: Catching Fire",
        "year": 2013,
        "tmdbId": 101299,
        "imdbId": "tt1951264",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt1951264/img"
      },
      {
        "type": "movie",
        "title": "The Hunger Games: Mockingjay - Part 1",
        "year": 2014,
        "tmdbId": 131631,
        "imdbId": "tt1951265",
        "part": 4,
        "poster": "https://images.metahub.space/poster/medium/tt1951265/img"
      },
      {
        "type": "movie",
        "title": "The Hunger Games: Mockingjay - Part 2",
        "year": 2015,
        "tmdbId": 131634,
        "imdbId": "tt1951266",
        "part": 5,
        "poster": "https://images.metahub.space/poster/medium/tt1951266/img"
      }
    ]
  },
  {
    "id": "movie_jurassic_park_world_saga",
    "name": "Jurassic Park & Jurassic World Saga",
    "franchise": "Jurassic Park",
    "category": "moviesagas",
    "description": "The complete 6-movie dinosaur adventure saga from Isla Nublar to global coexistence in Dominion.",
    "episodes": [
      {
        "type": "movie",
        "title": "Jurassic Park",
        "year": 1993,
        "tmdbId": 329,
        "imdbId": "tt0107290",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0107290/img"
      },
      {
        "type": "movie",
        "title": "The Lost World: Jurassic Park",
        "year": 1997,
        "tmdbId": 330,
        "imdbId": "tt0119567",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0119567/img"
      },
      {
        "type": "movie",
        "title": "Jurassic Park III",
        "year": 2001,
        "tmdbId": 331,
        "imdbId": "tt0163025",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt0163025/img"
      },
      {
        "type": "movie",
        "title": "Jurassic World",
        "year": 2015,
        "tmdbId": 135397,
        "imdbId": "tt0369610",
        "part": 4,
        "poster": "https://images.metahub.space/poster/medium/tt0369610/img"
      },
      {
        "type": "movie",
        "title": "Jurassic World: Fallen Kingdom",
        "year": 2018,
        "tmdbId": 351286,
        "imdbId": "tt4881806",
        "part": 5,
        "poster": "https://images.metahub.space/poster/medium/tt4881806/img"
      },
      {
        "type": "movie",
        "title": "Jurassic World Dominion",
        "year": 2022,
        "tmdbId": 507086,
        "imdbId": "tt8041270",
        "part": 6,
        "poster": "https://images.metahub.space/poster/medium/tt8041270/img"
      }
    ]
  },
  {
    "id": "movie_indiana_jones_adventures",
    "name": "Indiana Jones: The Complete Adventures",
    "franchise": "Indiana Jones",
    "category": "moviesagas",
    "description": "All 5 globetrotting archeological adventures starring Harrison Ford from Raiders of the Lost Ark to Dial of Destiny.",
    "episodes": [
      {
        "type": "movie",
        "title": "Indiana Jones and the Raiders of the Lost Ark",
        "year": 1981,
        "tmdbId": 85,
        "imdbId": "tt0082971",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0082971/img"
      },
      {
        "type": "movie",
        "title": "Indiana Jones and the Temple of Doom",
        "year": 1984,
        "tmdbId": 87,
        "imdbId": "tt0087469",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0087469/img"
      },
      {
        "type": "movie",
        "title": "Indiana Jones and the Last Crusade",
        "year": 1989,
        "tmdbId": 89,
        "imdbId": "tt0097576",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt0097576/img"
      },
      {
        "type": "movie",
        "title": "Indiana Jones and the Kingdom of the Crystal Skull",
        "year": 2008,
        "tmdbId": 217,
        "imdbId": "tt0367882",
        "part": 4,
        "poster": "https://images.metahub.space/poster/medium/tt0367882/img"
      },
      {
        "type": "movie",
        "title": "Indiana Jones and the Dial of Destiny",
        "year": 2023,
        "tmdbId": 335977,
        "imdbId": "tt1462764",
        "part": 5,
        "poster": "https://images.metahub.space/poster/medium/tt1462764/img"
      }
    ]
  },
  {
    "id": "movie_mad_max_universe",
    "name": "Mad Max: Complete Wasteland Saga",
    "franchise": "Mad Max",
    "category": "moviesagas",
    "description": "George Miller's post-apocalyptic vehicular action masterpieces in chronological timeline order.",
    "episodes": [
      {
        "type": "movie",
        "title": "Mad Max",
        "year": 1979,
        "tmdbId": 764,
        "imdbId": "tt0079501",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0079501/img"
      },
      {
        "type": "movie",
        "title": "Mad Max 2: The Road Warrior",
        "year": 1981,
        "tmdbId": 885,
        "imdbId": "tt0082694",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0082694/img"
      },
      {
        "type": "movie",
        "title": "Mad Max Beyond Thunderdome",
        "year": 1985,
        "tmdbId": 9355,
        "imdbId": "tt0089530",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt0089530/img"
      },
      {
        "type": "movie",
        "title": "Furiosa: A Mad Max Saga",
        "year": 2024,
        "tmdbId": 786892,
        "imdbId": "tt12037194",
        "part": 4,
        "poster": "https://images.metahub.space/poster/medium/tt12037194/img"
      },
      {
        "type": "movie",
        "title": "Mad Max: Fury Road",
        "year": 2015,
        "tmdbId": 76341,
        "imdbId": "tt1392190",
        "part": 5,
        "poster": "https://images.metahub.space/poster/medium/tt1392190/img"
      }
    ]
  },
  {
    "id": "movie_pirates_caribbean_saga",
    "name": "Pirates of the Caribbean: Complete Saga",
    "franchise": "Pirates of the Caribbean",
    "category": "moviesagas",
    "description": "All 5 swashbuckling Disney adventures following Captain Jack Sparrow across the Seven Seas.",
    "episodes": [
      {
        "type": "movie",
        "title": "Pirates of the Caribbean: The Curse of the Black Pearl",
        "year": 2003,
        "tmdbId": 22,
        "imdbId": "tt0325980",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0325980/img"
      },
      {
        "type": "movie",
        "title": "Pirates of the Caribbean: Dead Man's Chest",
        "year": 2006,
        "tmdbId": 58,
        "imdbId": "tt0383574",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0383574/img"
      },
      {
        "type": "movie",
        "title": "Pirates of the Caribbean: At World's End",
        "year": 2007,
        "tmdbId": 285,
        "imdbId": "tt0449088",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt0449088/img"
      },
      {
        "type": "movie",
        "title": "Pirates of the Caribbean: On Stranger Tides",
        "year": 2011,
        "tmdbId": 1865,
        "imdbId": "tt1298650",
        "part": 4,
        "poster": "https://images.metahub.space/poster/medium/tt1298650/img"
      },
      {
        "type": "movie",
        "title": "Pirates of the Caribbean: Dead Men Tell No Tales",
        "year": 2017,
        "tmdbId": 166426,
        "imdbId": "tt1790809",
        "part": 5,
        "poster": "https://images.metahub.space/poster/medium/tt1790809/img"
      }
    ]
  },
  {
    "id": "movie_toy_story_quadrilogy",
    "name": "Toy Story: Complete Quadrilogy",
    "franchise": "Toy Story",
    "category": "moviesagas",
    "description": "Pixar's beloved 4-movie animated masterpiece tracking Woody, Buzz, and the gang through Andy and Bonnie's childhoods.",
    "episodes": [
      {
        "type": "movie",
        "title": "Toy Story",
        "year": 1995,
        "tmdbId": 862,
        "imdbId": "tt0114709",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0114709/img"
      },
      {
        "type": "movie",
        "title": "Toy Story 2",
        "year": 1999,
        "tmdbId": 863,
        "imdbId": "tt0120363",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0120363/img"
      },
      {
        "type": "movie",
        "title": "Toy Story 3",
        "year": 2010,
        "tmdbId": 10193,
        "imdbId": "tt0435761",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt0435761/img"
      },
      {
        "type": "movie",
        "title": "Toy Story 4",
        "year": 2019,
        "tmdbId": 301528,
        "imdbId": "tt1979376",
        "part": 4,
        "poster": "https://images.metahub.space/poster/medium/tt1979376/img"
      }
    ]
  },
  {
    "id": "movie_shrek_universe",
    "name": "Shrek & Puss in Boots Universe",
    "franchise": "Shrek",
    "category": "moviesagas",
    "description": "The complete 6-film fairytale comedy franchise in chronological narrative order.",
    "episodes": [
      {
        "type": "movie",
        "title": "Puss in Boots",
        "year": 2011,
        "tmdbId": 417859,
        "imdbId": "tt0448694",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0448694/img"
      },
      {
        "type": "movie",
        "title": "Shrek",
        "year": 2001,
        "tmdbId": 808,
        "imdbId": "tt0126029",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0126029/img"
      },
      {
        "type": "movie",
        "title": "Shrek 2",
        "year": 2004,
        "tmdbId": 809,
        "imdbId": "tt0298148",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt0298148/img"
      },
      {
        "type": "movie",
        "title": "Shrek the Third",
        "year": 2007,
        "tmdbId": 810,
        "imdbId": "tt0413267",
        "part": 4,
        "poster": "https://images.metahub.space/poster/medium/tt0413267/img"
      },
      {
        "type": "movie",
        "title": "Shrek Forever After",
        "year": 2010,
        "tmdbId": 10192,
        "imdbId": "tt0892791",
        "part": 5,
        "poster": "https://images.metahub.space/poster/medium/tt0892791/img"
      },
      {
        "type": "movie",
        "title": "Puss in Boots: The Last Wish",
        "year": 2022,
        "tmdbId": 315162,
        "imdbId": "tt3915174",
        "part": 6,
        "poster": "https://images.metahub.space/poster/medium/tt3915174/img"
      }
    ]
  },
  {
    "id": "movie_breaking_bad_el_camino",
    "name": "Breaking Bad Complete Universe",
    "franchise": "Breaking Bad",
    "category": "tvuniverses",
    "description": "The complete chronological universe: Breaking Bad (Seasons 1-5), followed by El Camino: A Breaking Bad Movie, followed by Better Call Saul (Seasons 1-6).",
    "episodes": [
      {
        "type": "show",
        "showName": "Breaking Bad",
        "tmdbId": 1396,
        "seasons": [
          1,
          2,
          3,
          4,
          5
        ],
        "title": "Breaking Bad (Seasons 1-5)",
        "part": 1,
        "imdbId": "tt0903747",
        "poster": "https://images.metahub.space/poster/medium/tt0903747/img"
      },
      {
        "type": "movie",
        "title": "El Camino: A Breaking Bad Movie",
        "tmdbId": 559969,
        "imdbId": "tt9243946",
        "year": 2019,
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt9243946/img"
      },
      {
        "type": "show",
        "showName": "Better Call Saul",
        "tmdbId": 60059,
        "seasons": [
          1,
          2,
          3,
          4,
          5,
          6
        ],
        "title": "Better Call Saul (Seasons 1-6)",
        "part": 3,
        "imdbId": "tt3032476",
        "poster": "https://images.metahub.space/poster/medium/tt3032476/img"
      }
    ]
  },
  {
    "id": "arrowverse_complete_timeline",
    "name": "The Complete Arrowverse Timeline",
    "franchise": "Arrowverse",
    "category": "tvuniverses",
    "description": "The complete shared DC universe in air date order: Arrow (Seasons 1-8), The Flash (Seasons 1-9), Supergirl (Seasons 1-6), and DC's Legends of Tomorrow (Seasons 1-7).",
    "episodes": [
      {
        "type": "season",
        "showName": "Arrow",
        "tmdbId": 1412,
        "season": 1,
        "title": "Arrow (Season 1)",
        "part": 1,
        "imdbId": "tt2193021",
        "poster": "https://images.metahub.space/poster/medium/tt2193021/img"
      },
      {
        "type": "season",
        "showName": "Arrow",
        "tmdbId": 1412,
        "season": 2,
        "title": "Arrow (Season 2)",
        "part": 2,
        "imdbId": "tt2193021",
        "poster": "https://images.metahub.space/poster/medium/tt2193021/img"
      },
      {
        "type": "season",
        "showName": "The Flash",
        "tmdbId": 60735,
        "season": 1,
        "title": "The Flash (Season 1)",
        "part": 3,
        "imdbId": "tt3107288",
        "poster": "https://images.metahub.space/poster/medium/tt3107288/img"
      },
      {
        "type": "season",
        "showName": "Arrow",
        "tmdbId": 1412,
        "season": 3,
        "title": "Arrow (Season 3)",
        "part": 4,
        "imdbId": "tt2193021",
        "poster": "https://images.metahub.space/poster/medium/tt2193021/img"
      },
      {
        "type": "season",
        "showName": "Supergirl",
        "tmdbId": 62688,
        "season": 1,
        "title": "Supergirl (Season 1)",
        "part": 5,
        "imdbId": "tt4016454",
        "poster": "https://images.metahub.space/poster/medium/tt4016454/img"
      },
      {
        "type": "season",
        "showName": "The Flash",
        "tmdbId": 60735,
        "season": 2,
        "title": "The Flash (Season 2)",
        "part": 6,
        "imdbId": "tt3107288",
        "poster": "https://images.metahub.space/poster/medium/tt3107288/img"
      },
      {
        "type": "season",
        "showName": "Arrow",
        "tmdbId": 1412,
        "season": 4,
        "title": "Arrow (Season 4)",
        "part": 7,
        "imdbId": "tt2193021",
        "poster": "https://images.metahub.space/poster/medium/tt2193021/img"
      },
      {
        "type": "season",
        "showName": "DC's Legends of Tomorrow",
        "tmdbId": 62643,
        "season": 1,
        "title": "Legends of Tomorrow (Season 1)",
        "part": 8,
        "imdbId": "tt4532368",
        "poster": "https://images.metahub.space/poster/medium/tt4532368/img"
      },
      {
        "type": "season",
        "showName": "Supergirl",
        "tmdbId": 62688,
        "season": 2,
        "title": "Supergirl (Season 2)",
        "part": 9,
        "imdbId": "tt4016454",
        "poster": "https://images.metahub.space/poster/medium/tt4016454/img"
      },
      {
        "type": "season",
        "showName": "The Flash",
        "tmdbId": 60735,
        "season": 3,
        "title": "The Flash (Season 3)",
        "part": 10,
        "imdbId": "tt3107288",
        "poster": "https://images.metahub.space/poster/medium/tt3107288/img"
      },
      {
        "type": "season",
        "showName": "Arrow",
        "tmdbId": 1412,
        "season": 5,
        "title": "Arrow (Season 5)",
        "part": 11,
        "imdbId": "tt2193021",
        "poster": "https://images.metahub.space/poster/medium/tt2193021/img"
      },
      {
        "type": "season",
        "showName": "DC's Legends of Tomorrow",
        "tmdbId": 62643,
        "season": 2,
        "title": "Legends of Tomorrow (Season 2)",
        "part": 12,
        "imdbId": "tt4532368",
        "poster": "https://images.metahub.space/poster/medium/tt4532368/img"
      },
      {
        "type": "season",
        "showName": "Supergirl",
        "tmdbId": 62688,
        "season": 3,
        "title": "Supergirl (Season 3)",
        "part": 13,
        "imdbId": "tt4016454",
        "poster": "https://images.metahub.space/poster/medium/tt4016454/img"
      },
      {
        "type": "season",
        "showName": "Arrow",
        "tmdbId": 1412,
        "season": 6,
        "title": "Arrow (Season 6)",
        "part": 14,
        "imdbId": "tt2193021",
        "poster": "https://images.metahub.space/poster/medium/tt2193021/img"
      },
      {
        "type": "season",
        "showName": "The Flash",
        "tmdbId": 60735,
        "season": 4,
        "title": "The Flash (Season 4)",
        "part": 15,
        "imdbId": "tt3107288",
        "poster": "https://images.metahub.space/poster/medium/tt3107288/img"
      },
      {
        "type": "season",
        "showName": "DC's Legends of Tomorrow",
        "tmdbId": 62643,
        "season": 3,
        "title": "Legends of Tomorrow (Season 3)",
        "part": 16,
        "imdbId": "tt4532368",
        "poster": "https://images.metahub.space/poster/medium/tt4532368/img"
      },
      {
        "type": "season",
        "showName": "The Flash",
        "tmdbId": 60735,
        "season": 5,
        "title": "The Flash (Season 5)",
        "part": 17,
        "imdbId": "tt3107288",
        "poster": "https://images.metahub.space/poster/medium/tt3107288/img"
      },
      {
        "type": "season",
        "showName": "Arrow",
        "tmdbId": 1412,
        "season": 7,
        "title": "Arrow (Season 7)",
        "part": 18,
        "imdbId": "tt2193021",
        "poster": "https://images.metahub.space/poster/medium/tt2193021/img"
      },
      {
        "type": "season",
        "showName": "Supergirl",
        "tmdbId": 62688,
        "season": 4,
        "title": "Supergirl (Season 4)",
        "part": 19,
        "imdbId": "tt4016454",
        "poster": "https://images.metahub.space/poster/medium/tt4016454/img"
      },
      {
        "type": "season",
        "showName": "DC's Legends of Tomorrow",
        "tmdbId": 62643,
        "season": 4,
        "title": "Legends of Tomorrow (Season 4)",
        "part": 20,
        "imdbId": "tt4532368",
        "poster": "https://images.metahub.space/poster/medium/tt4532368/img"
      },
      {
        "type": "season",
        "showName": "Supergirl",
        "tmdbId": 62688,
        "season": 5,
        "title": "Supergirl (Season 5)",
        "part": 21,
        "imdbId": "tt4016454",
        "poster": "https://images.metahub.space/poster/medium/tt4016454/img"
      },
      {
        "type": "season",
        "showName": "The Flash",
        "tmdbId": 60735,
        "season": 6,
        "title": "The Flash (Season 6)",
        "part": 22,
        "imdbId": "tt3107288",
        "poster": "https://images.metahub.space/poster/medium/tt3107288/img"
      },
      {
        "type": "season",
        "showName": "Arrow",
        "tmdbId": 1412,
        "season": 8,
        "title": "Arrow (Season 8)",
        "part": 23,
        "imdbId": "tt2193021",
        "poster": "https://images.metahub.space/poster/medium/tt2193021/img"
      },
      {
        "type": "season",
        "showName": "DC's Legends of Tomorrow",
        "tmdbId": 62643,
        "season": 5,
        "title": "Legends of Tomorrow (Season 5)",
        "part": 24,
        "imdbId": "tt4532368",
        "poster": "https://images.metahub.space/poster/medium/tt4532368/img"
      },
      {
        "type": "season",
        "showName": "The Flash",
        "tmdbId": 60735,
        "season": 7,
        "title": "The Flash (Season 7)",
        "part": 25,
        "imdbId": "tt3107288",
        "poster": "https://images.metahub.space/poster/medium/tt3107288/img"
      },
      {
        "type": "season",
        "showName": "Supergirl",
        "tmdbId": 62688,
        "season": 6,
        "title": "Supergirl (Season 6)",
        "part": 26,
        "imdbId": "tt4016454",
        "poster": "https://images.metahub.space/poster/medium/tt4016454/img"
      },
      {
        "type": "season",
        "showName": "DC's Legends of Tomorrow",
        "tmdbId": 62643,
        "season": 6,
        "title": "Legends of Tomorrow (Season 6)",
        "part": 27,
        "imdbId": "tt4532368",
        "poster": "https://images.metahub.space/poster/medium/tt4532368/img"
      },
      {
        "type": "season",
        "showName": "DC's Legends of Tomorrow",
        "tmdbId": 62643,
        "season": 7,
        "title": "Legends of Tomorrow (Season 7)",
        "part": 28,
        "imdbId": "tt4532368",
        "poster": "https://images.metahub.space/poster/medium/tt4532368/img"
      },
      {
        "type": "season",
        "showName": "The Flash",
        "tmdbId": 60735,
        "season": 8,
        "title": "The Flash (Season 8)",
        "part": 29,
        "imdbId": "tt3107288",
        "poster": "https://images.metahub.space/poster/medium/tt3107288/img"
      },
      {
        "type": "season",
        "showName": "The Flash",
        "tmdbId": 60735,
        "season": 9,
        "title": "The Flash (Season 9)",
        "part": 30,
        "imdbId": "tt3107288",
        "poster": "https://images.metahub.space/poster/medium/tt3107288/img"
      }
    ]
  },
  {
    "id": "movie_xfiles_complete_chronology",
    "name": "The X-Files: Complete Canon Chronology",
    "franchise": "The X-Files",
    "category": "tvuniverses",
    "description": "The entire X-Files saga in chronological order: Seasons 1-5, Fight the Future (1998), Seasons 6-9, I Want to Believe (2008), and Seasons 10-11.",
    "episodes": [
      {
        "type": "show",
        "showName": "The X-Files",
        "tmdbId": 4087,
        "seasons": [
          1,
          2,
          3,
          4,
          5
        ],
        "title": "The X-Files (Seasons 1-5)",
        "part": 1,
        "imdbId": "tt0106179",
        "poster": "https://images.metahub.space/poster/medium/tt0106179/img"
      },
      {
        "type": "movie",
        "title": "The X-Files: Fight the Future",
        "tmdbId": 8870,
        "imdbId": "tt0120902",
        "year": 1998,
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0120902/img"
      },
      {
        "type": "show",
        "showName": "The X-Files",
        "tmdbId": 4087,
        "seasons": [
          6,
          7,
          8,
          9
        ],
        "title": "The X-Files (Seasons 6-9)",
        "part": 3,
        "imdbId": "tt0106179",
        "poster": "https://images.metahub.space/poster/medium/tt0106179/img"
      },
      {
        "type": "movie",
        "title": "The X-Files: I Want to Believe",
        "tmdbId": 10534,
        "imdbId": "tt0443701",
        "year": 2008,
        "part": 4,
        "poster": "https://images.metahub.space/poster/medium/tt0443701/img"
      },
      {
        "type": "show",
        "showName": "The X-Files",
        "tmdbId": 4087,
        "seasons": [
          10,
          11
        ],
        "title": "The X-Files (Seasons 10-11)",
        "part": 5,
        "imdbId": "tt0106179",
        "poster": "https://images.metahub.space/poster/medium/tt0106179/img"
      }
    ]
  },
  {
    "id": "movie_star_trek_tng_films",
    "name": "Star Trek: The Next Generation Chronology",
    "franchise": "Star Trek",
    "category": "tvuniverses",
    "description": "Star Trek: The Next Generation (Seasons 1-7), followed by Generations (1994), First Contact (1996), Insurrection (1998), and Nemesis (2002).",
    "episodes": [
      {
        "type": "show",
        "showName": "Star Trek: The Next Generation",
        "tmdbId": 655,
        "seasons": [
          1,
          2,
          3,
          4,
          5,
          6,
          7
        ],
        "title": "Star Trek: TNG (Seasons 1-7)",
        "part": 1,
        "imdbId": "tt0092455",
        "poster": "https://images.metahub.space/poster/medium/tt0092455/img"
      },
      {
        "type": "movie",
        "title": "Star Trek: Generations",
        "tmdbId": 193,
        "imdbId": "tt0111282",
        "year": 1994,
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0111282/img"
      },
      {
        "type": "movie",
        "title": "Star Trek: First Contact",
        "tmdbId": 199,
        "imdbId": "tt0117731",
        "year": 1996,
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt0117731/img"
      },
      {
        "type": "movie",
        "title": "Star Trek: Insurrection",
        "tmdbId": 200,
        "imdbId": "tt0120844",
        "year": 1998,
        "part": 4,
        "poster": "https://images.metahub.space/poster/medium/tt0120844/img"
      },
      {
        "type": "movie",
        "title": "Star Trek: Nemesis",
        "tmdbId": 201,
        "imdbId": "tt0253754",
        "year": 2002,
        "part": 5,
        "poster": "https://images.metahub.space/poster/medium/tt0253754/img"
      }
    ]
  },
  {
    "id": "movie_star_trek_tos_movies",
    "name": "Star Trek: The Original Series & Feature Films (I-VI)",
    "franchise": "Star Trek",
    "category": "tvuniverses",
    "description": "The classic 3-season TOS television series, followed by movies I through VI.",
    "episodes": [
      {
        "type": "show",
        "showName": "Star Trek",
        "tmdbId": 253,
        "seasons": [
          1,
          2,
          3
        ],
        "title": "Star Trek: TOS (Seasons 1-3)",
        "part": 1,
        "imdbId": "tt0060028",
        "poster": "https://images.metahub.space/poster/medium/tt0060028/img"
      },
      {
        "type": "movie",
        "title": "Star Trek: The Motion Picture",
        "year": 1979,
        "tmdbId": 152,
        "imdbId": "tt0079945",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0079945/img"
      },
      {
        "type": "movie",
        "title": "Star Trek II: The Wrath of Khan",
        "year": 1982,
        "tmdbId": 154,
        "imdbId": "tt0084726",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt0084726/img"
      },
      {
        "type": "movie",
        "title": "Star Trek III: The Search for Spock",
        "year": 1984,
        "tmdbId": 157,
        "imdbId": "tt0088170",
        "part": 4,
        "poster": "https://images.metahub.space/poster/medium/tt0088170/img"
      },
      {
        "type": "movie",
        "title": "Star Trek IV: The Voyage Home",
        "year": 1986,
        "tmdbId": 168,
        "imdbId": "tt0092007",
        "part": 5,
        "poster": "https://images.metahub.space/poster/medium/tt0092007/img"
      },
      {
        "type": "movie",
        "title": "Star Trek V: The Final Frontier",
        "year": 1989,
        "tmdbId": 172,
        "imdbId": "tt0098382",
        "part": 6,
        "poster": "https://images.metahub.space/poster/medium/tt0098382/img"
      },
      {
        "type": "movie",
        "title": "Star Trek VI: The Undiscovered Country",
        "year": 1991,
        "tmdbId": 174,
        "imdbId": "tt0102975",
        "part": 7,
        "poster": "https://images.metahub.space/poster/medium/tt0102975/img"
      }
    ]
  },
  {
    "id": "movie_demon_slayer_mugen_train",
    "name": "Demon Slayer: Complete Canon Order",
    "franchise": "Demon Slayer",
    "category": "tvuniverses",
    "description": "Season 1 (Unwavering Resolve), followed by the Mugen Train canon film, followed by Seasons 2, 3, and 4 in broadcast order.",
    "episodes": [
      {
        "type": "season",
        "showName": "Demon Slayer: Kimetsu no Yaiba",
        "tmdbId": 85937,
        "season": 1,
        "title": "Season 1: Unwavering Resolve",
        "part": 1,
        "imdbId": "tt9335498",
        "poster": "https://images.metahub.space/poster/medium/tt9335498/img"
      },
      {
        "type": "movie",
        "title": "Demon Slayer: Kimetsu no Yaiba - The Movie: Mugen Train",
        "tmdbId": 635302,
        "imdbId": "tt11032374",
        "year": 2020,
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt11032374/img"
      },
      {
        "type": "show",
        "showName": "Demon Slayer: Kimetsu no Yaiba",
        "tmdbId": 85937,
        "seasons": [
          2,
          3,
          4
        ],
        "title": "Seasons 2-4",
        "part": 3,
        "imdbId": "tt9335498",
        "poster": "https://images.metahub.space/poster/medium/tt9335498/img"
      }
    ]
  },
  {
    "id": "movie_jujutsu_kaisen_0",
    "name": "Jujutsu Kaisen: Complete Timeline",
    "franchise": "Jujutsu Kaisen",
    "category": "tvuniverses",
    "description": "Jujutsu Kaisen 0 (prequel movie), followed by Season 1 and Season 2 (Hidden Inventory & Shibuya Incident).",
    "episodes": [
      {
        "type": "movie",
        "title": "Jujutsu Kaisen 0",
        "year": 2021,
        "tmdbId": 810693,
        "imdbId": "tt14331144",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt14331144/img"
      },
      {
        "type": "show",
        "showName": "Jujutsu Kaisen",
        "tmdbId": 95479,
        "seasons": [
          1,
          2
        ],
        "title": "Jujutsu Kaisen (Seasons 1-2)",
        "part": 2,
        "imdbId": "tt12343534",
        "poster": "https://images.metahub.space/poster/medium/tt12343534/img"
      }
    ]
  },
  {
    "id": "movie_firefly_serenity",
    "name": "Firefly: Complete Series & Serenity",
    "franchise": "Firefly",
    "category": "tvuniverses",
    "description": "The complete Firefly experience: Season 1 (all 14 episodes), followed by the canon theatrical finale Serenity (2005).",
    "episodes": [
      {
        "type": "season",
        "showName": "Firefly",
        "tmdbId": 1437,
        "season": 1,
        "title": "Firefly (Season 1)",
        "part": 1,
        "imdbId": "tt0303461",
        "poster": "https://images.metahub.space/poster/medium/tt0303461/img"
      },
      {
        "type": "movie",
        "title": "Serenity",
        "tmdbId": 163,
        "imdbId": "tt0379786",
        "year": 2005,
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0379786/img"
      }
    ]
  },
  {
    "id": "movie_homestead_prequel",
    "name": "Homestead: Complete Saga",
    "franchise": "Homestead",
    "category": "tvuniverses",
    "description": "Homestead (2024 film) introduces the apocalyptic collapse, followed by Homestead: The Series (Season 1).",
    "episodes": [
      {
        "type": "movie",
        "title": "Homestead",
        "year": 2024,
        "tmdbId": 1217690,
        "imdbId": "tt29137778",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt29137778/img"
      },
      {
        "type": "season",
        "showName": "Homestead: The Series",
        "tmdbId": 247070,
        "season": 1,
        "title": "Homestead: The Series (Season 1)",
        "part": 2,
        "imdbId": "tt33484648",
        "poster": "https://images.metahub.space/poster/medium/tt33484648/img"
      }
    ]
  },
  {
    "id": "movie_the_last_kingdom_seven_kings",
    "name": "The Last Kingdom: Complete Saga",
    "franchise": "The Last Kingdom",
    "category": "tvuniverses",
    "description": "The complete 5-season saga of Uhtred of Bebbanburg, culminating in the Seven Kings Must Die (2023) finale film.",
    "episodes": [
      {
        "type": "show",
        "showName": "The Last Kingdom",
        "tmdbId": 63333,
        "seasons": [
          1,
          2,
          3,
          4,
          5
        ],
        "title": "The Last Kingdom (Seasons 1-5)",
        "part": 1,
        "imdbId": "tt4495098",
        "poster": "https://images.metahub.space/poster/medium/tt4495098/img"
      },
      {
        "type": "movie",
        "title": "The Last Kingdom: Seven Kings Must Die",
        "year": 2023,
        "tmdbId": 948713,
        "imdbId": "tt15767808",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt15767808/img"
      }
    ]
  },
  {
    "id": "movie_futurama_feature_films",
    "name": "Futurama: Complete Saga & The 4 Feature Films",
    "franchise": "Futurama",
    "category": "tvuniverses",
    "description": "Futurama classic seasons, followed by the four direct-to-video feature films, followed by the revival seasons.",
    "episodes": [
      {
        "type": "show",
        "showName": "Futurama",
        "tmdbId": 615,
        "seasons": [
          1,
          2,
          3,
          4
        ],
        "title": "Futurama (Classic Seasons 1-4)",
        "part": 1,
        "imdbId": "tt0149460",
        "poster": "https://images.metahub.space/poster/medium/tt0149460/img"
      },
      {
        "type": "movie",
        "title": "Futurama: Bender's Big Score",
        "year": 2007,
        "tmdbId": 13348,
        "imdbId": "tt0471711",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0471711/img"
      },
      {
        "type": "movie",
        "title": "Futurama: The Beast with a Billion Backs",
        "year": 2008,
        "tmdbId": 13349,
        "imdbId": "tt1054485",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt1054485/img"
      },
      {
        "type": "movie",
        "title": "Futurama: Bender's Game",
        "year": 2008,
        "tmdbId": 13350,
        "imdbId": "tt1054486",
        "part": 4,
        "poster": "https://images.metahub.space/poster/medium/tt1054486/img"
      },
      {
        "type": "movie",
        "title": "Futurama: Into the Wild Green Yonder",
        "year": 2009,
        "tmdbId": 13351,
        "imdbId": "tt1054487",
        "part": 5,
        "poster": "https://images.metahub.space/poster/medium/tt1054487/img"
      },
      {
        "type": "show",
        "showName": "Futurama",
        "tmdbId": 615,
        "seasons": [
          6,
          7,
          8
        ],
        "title": "Futurama (Revival Seasons 6-8)",
        "part": 6,
        "imdbId": "tt0149460",
        "poster": "https://images.metahub.space/poster/medium/tt0149460/img"
      }
    ]
  },
  {
    "id": "movie_24_redemption",
    "name": "24: Complete Saga & Redemption",
    "franchise": "24",
    "category": "tvuniverses",
    "description": "24 Seasons 1-6, followed by 24: Redemption (2008) in Africa, followed by Seasons 7-9.",
    "episodes": [
      {
        "type": "show",
        "showName": "24",
        "tmdbId": 197,
        "seasons": [
          1,
          2,
          3,
          4,
          5,
          6
        ],
        "title": "24 (Seasons 1-6)",
        "part": 1,
        "imdbId": "tt0285331",
        "poster": "https://images.metahub.space/poster/medium/tt0285331/img"
      },
      {
        "type": "movie",
        "title": "24: Redemption",
        "year": 2008,
        "tmdbId": 14781,
        "imdbId": "tt0813980",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0813980/img"
      },
      {
        "type": "show",
        "showName": "24",
        "tmdbId": 197,
        "seasons": [
          7,
          8,
          9
        ],
        "title": "24 (Seasons 7-9)",
        "part": 3,
        "imdbId": "tt0285331",
        "poster": "https://images.metahub.space/poster/medium/tt0285331/img"
      }
    ]
  },
  {
    "id": "movie_prison_break_the_final_break",
    "name": "Prison Break: Complete Saga & The Final Break",
    "franchise": "Prison Break",
    "category": "tvuniverses",
    "description": "Prison Break Seasons 1-4, followed by The Final Break (2009), followed by Season 5.",
    "episodes": [
      {
        "type": "show",
        "showName": "Prison Break",
        "tmdbId": 2288,
        "seasons": [
          1,
          2,
          3,
          4
        ],
        "title": "Prison Break (Seasons 1-4)",
        "part": 1,
        "imdbId": "tt0455275",
        "poster": "https://images.metahub.space/poster/medium/tt0455275/img"
      },
      {
        "type": "movie",
        "title": "Prison Break: The Final Break",
        "year": 2009,
        "tmdbId": 23684,
        "imdbId": "tt1131748",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt1131748/img"
      },
      {
        "type": "season",
        "showName": "Prison Break",
        "tmdbId": 2288,
        "season": 5,
        "title": "Prison Break (Season 5)",
        "part": 3,
        "imdbId": "tt0455275",
        "poster": "https://images.metahub.space/poster/medium/tt0455275/img"
      }
    ]
  },
  {
    "id": "movie_downton_abbey_continuation",
    "name": "Downton Abbey: Complete Saga & Feature Films",
    "franchise": "Downton Abbey",
    "category": "tvuniverses",
    "description": "Downton Abbey Seasons 1-6, followed by the theatrical feature films Downton Abbey (2019), A New Era (2022), and The Grand Finale (2025).",
    "episodes": [
      {
        "type": "show",
        "showName": "Downton Abbey",
        "tmdbId": 1405,
        "seasons": [
          1,
          2,
          3,
          4,
          5,
          6
        ],
        "title": "Downton Abbey (Seasons 1-6)",
        "part": 1,
        "imdbId": "tt1606375",
        "poster": "https://images.metahub.space/poster/medium/tt1606375/img"
      },
      {
        "type": "movie",
        "title": "Downton Abbey",
        "tmdbId": 535544,
        "imdbId": "tt6398184",
        "year": 2019,
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt6398184/img"
      },
      {
        "type": "movie",
        "title": "Downton Abbey: A New Era",
        "tmdbId": 678580,
        "imdbId": "tt11703710",
        "year": 2022,
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt11703710/img"
      },
      {
        "type": "movie",
        "title": "Downton Abbey: The Grand Finale",
        "tmdbId": 1289936,
        "imdbId": "tt31888477",
        "year": 2025,
        "part": 4,
        "poster": "https://images.metahub.space/poster/medium/tt31888477/img"
      }
    ]
  },
  {
    "id": "movie_psych_the_movies",
    "name": "Psych: Complete Saga & The Movies",
    "franchise": "Psych",
    "category": "tvuniverses",
    "description": "Psych Seasons 1-8, followed by Psych: The Movie (2017), Psych 2: Lassie Come Home (2020), and Psych 3: This Is Gus (2021).",
    "episodes": [
      {
        "type": "show",
        "showName": "Psych",
        "tmdbId": 1447,
        "seasons": [
          1,
          2,
          3,
          4,
          5,
          6,
          7,
          8
        ],
        "title": "Psych (Seasons 1-8)",
        "part": 1,
        "imdbId": "tt0491738",
        "poster": "https://images.metahub.space/poster/medium/tt0491738/img"
      },
      {
        "type": "movie",
        "title": "Psych: The Movie",
        "tmdbId": 473614,
        "imdbId": "tt6868216",
        "year": 2017,
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt6868216/img"
      },
      {
        "type": "movie",
        "title": "Psych 2: Lassie Come Home",
        "tmdbId": 604811,
        "imdbId": "tt9792884",
        "year": 2020,
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt9792884/img"
      },
      {
        "type": "movie",
        "title": "Psych 3: This Is Gus",
        "tmdbId": 830784,
        "imdbId": "tt14641648",
        "year": 2021,
        "part": 4,
        "poster": "https://images.metahub.space/poster/medium/tt14641648/img"
      }
    ]
  },
  {
    "id": "movie_ray_donovan_the_movie",
    "name": "Ray Donovan: Complete Saga",
    "franchise": "Ray Donovan",
    "category": "tvuniverses",
    "description": "All 7 seasons of Ray Donovan, concluding with Ray Donovan: The Movie (2022).",
    "episodes": [
      {
        "type": "show",
        "showName": "Ray Donovan",
        "tmdbId": 46702,
        "seasons": [
          1,
          2,
          3,
          4,
          5,
          6,
          7
        ],
        "title": "Ray Donovan (Seasons 1-7)",
        "part": 1,
        "imdbId": "tt2249007",
        "poster": "https://images.metahub.space/poster/medium/tt2249007/img"
      },
      {
        "type": "movie",
        "title": "Ray Donovan: The Movie",
        "year": 2022,
        "tmdbId": 871964,
        "imdbId": "tt14124268",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt14124268/img"
      }
    ]
  },
  {
    "id": "movie_deadwood_the_movie",
    "name": "Deadwood: Complete Saga",
    "franchise": "Deadwood",
    "category": "tvuniverses",
    "description": "All 3 seasons of Deadwood, concluding with Deadwood: The Movie (2019).",
    "episodes": [
      {
        "type": "show",
        "showName": "Deadwood",
        "tmdbId": 1425,
        "seasons": [
          1,
          2,
          3
        ],
        "title": "Deadwood (Seasons 1-3)",
        "part": 1,
        "imdbId": "tt0357373",
        "poster": "https://images.metahub.space/poster/medium/tt0357373/img"
      },
      {
        "type": "movie",
        "title": "Deadwood: The Movie",
        "tmdbId": 543788,
        "imdbId": "tt4943998",
        "year": 2019,
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt4943998/img"
      }
    ]
  },
  {
    "id": "ncis_three_way_crossover_2023",
    "name": "NCIS: The Three-Way Crossover (2023)",
    "franchise": "NCIS Universe",
    "category": "tvuniverses",
    "description": "Historic 3-way crossover connecting NCIS, NCIS: Hawaiʻi, and NCIS: Los Angeles to track down a dangerous assassin.",
    "episodes": [
      {
        "type": "episode",
        "showName": "NCIS",
        "season": 20,
        "episode": 10,
        "title": "Too Many Cooks",
        "tmdbId": 4614,
        "imdbId": "tt0364845",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0364845/img"
      },
      {
        "type": "episode",
        "showName": "NCIS: Hawai'i",
        "season": 2,
        "episode": 10,
        "title": "Deep Fake",
        "tmdbId": 124364,
        "imdbId": "tt14218674",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt14218674/img"
      },
      {
        "type": "episode",
        "showName": "NCIS: Los Angeles",
        "season": 14,
        "episode": 10,
        "title": "A Long Time Coming",
        "tmdbId": 17610,
        "imdbId": "tt1378167",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt1378167/img"
      }
    ]
  },
  {
    "id": "hawaii_five_0_ncis_la_crossover",
    "name": "Hawaii Five-0 & NCIS: Los Angeles Crossover (Touch of Death)",
    "franchise": "NCIS Universe",
    "category": "tvuniverses",
    "description": "2-part crossover connecting Hawaii Five-0 and NCIS: Los Angeles across Honolulu and LA.",
    "episodes": [
      {
        "type": "episode",
        "showName": "Hawaii Five-0",
        "season": 2,
        "episode": 21,
        "title": "Pa Make Loa",
        "tmdbId": 32798,
        "imdbId": "tt1600194",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt1600194/img"
      },
      {
        "type": "episode",
        "showName": "NCIS: Los Angeles",
        "season": 3,
        "episode": 21,
        "title": "Touch of Death",
        "tmdbId": 17610,
        "imdbId": "tt1378167",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt1378167/img"
      }
    ]
  },
  {
    "id": "ncis_new_orleans_sister_city_crossover",
    "name": "NCIS & NCIS: New Orleans Crossover (Sister City)",
    "franchise": "NCIS Universe",
    "category": "tvuniverses",
    "description": "2-part crossover connecting NCIS and NCIS: New Orleans to investigate a poison attack.",
    "episodes": [
      {
        "type": "episode",
        "showName": "NCIS",
        "season": 13,
        "episode": 12,
        "title": "Sister City (Part I)",
        "tmdbId": 4614,
        "imdbId": "tt0364845",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0364845/img"
      },
      {
        "type": "episode",
        "showName": "NCIS: New Orleans",
        "season": 2,
        "episode": 12,
        "title": "Sister City (Part II)",
        "tmdbId": 3560084,
        "imdbId": "tt3560084",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt3560084/img"
      }
    ]
  },
  {
    "id": "ncis_hawaii_starting_over_crossover",
    "name": "NCIS & NCIS: Hawai'i Crossover (Starting Over)",
    "franchise": "NCIS Universe",
    "category": "tvuniverses",
    "description": "2-part crossover connecting NCIS and NCIS: Hawai'i to track down a former Pentagon defense specialist.",
    "episodes": [
      {
        "type": "episode",
        "showName": "NCIS",
        "season": 19,
        "episode": 17,
        "title": "Starting Over",
        "tmdbId": 4614,
        "imdbId": "tt0364845",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0364845/img"
      },
      {
        "type": "episode",
        "showName": "NCIS: Hawai'i",
        "season": 1,
        "episode": 18,
        "title": "T'N'T",
        "tmdbId": 124364,
        "imdbId": "tt14218674",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt14218674/img"
      }
    ]
  },
  {
    "id": "one_chicago_in_the_trenches_2025",
    "name": "One Chicago: In the Trenches (2025)",
    "franchise": "One Chicago",
    "category": "tvuniverses",
    "description": "3-part crossover event: a gas explosion and high-rise collapse unite Firehouse 51, Chicago Med, and Intelligence in a race to save dozens trapped underground.",
    "episodes": [
      {
        "type": "episode",
        "showName": "Chicago Fire",
        "season": 13,
        "episode": 11,
        "title": "In the Trenches: Part I",
        "tmdbId": 44006,
        "imdbId": "tt2261391",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt2261391/img"
      },
      {
        "type": "episode",
        "showName": "Chicago Med",
        "season": 10,
        "episode": 11,
        "title": "In the Trenches: Part II",
        "tmdbId": 62650,
        "imdbId": "tt4655480",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt4655480/img"
      },
      {
        "type": "episode",
        "showName": "Chicago P.D.",
        "season": 12,
        "episode": 11,
        "title": "In the Trenches: Part III",
        "tmdbId": 58841,
        "imdbId": "tt2805096",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt2805096/img"
      }
    ]
  },
  {
    "id": "yellowstone_dutton_dynasty_saga",
    "name": "Yellowstone: The Dutton Dynasty (Chronological Order)",
    "franchise": "Yellowstone",
    "category": "tvuniverses",
    "description": "The complete Dutton family saga in chronological order: 1883 (the journey west), 1923 (Prohibition-era Montana), then Yellowstone (the modern-day ranch war).",
    "noCrossoverSuggestion": true,
    "episodes": [
      {
        "type": "show",
        "showName": "1883",
        "tmdbId": 118357,
        "seasons": [1],
        "title": "1883 (Season 1)",
        "part": 1,
        "imdbId": "tt13991232",
        "poster": "https://images.metahub.space/poster/medium/tt13991232/img"
      },
      {
        "type": "show",
        "showName": "1923",
        "tmdbId": 157744,
        "seasons": [1, 2],
        "title": "1923 (Seasons 1-2)",
        "part": 2,
        "imdbId": "tt18335752",
        "poster": "https://images.metahub.space/poster/medium/tt18335752/img"
      },
      {
        "type": "show",
        "showName": "Yellowstone",
        "tmdbId": 73586,
        "seasons": [1, 2, 3, 4, 5],
        "title": "Yellowstone (Seasons 1-5)",
        "part": 3,
        "imdbId": "tt4236770",
        "poster": "https://images.metahub.space/poster/medium/tt4236770/img"
      }
    ]
  },
  {
    "id": "arrowverse_flash_vs_arrow_2014",
    "name": "Flash vs. Arrow (2014)",
    "franchise": "Arrowverse",
    "category": "tvuniverses",
    "description": "The inaugural Arrowverse crossover: Barry Allen and Oliver Queen team up across Central City and Starling City to stop a boomerang-wielding killer.",
    "episodes": [
      {
        "type": "episode",
        "showName": "The Flash",
        "season": 1,
        "episode": 8,
        "title": "Flash vs. Arrow",
        "tmdbId": 60735,
        "imdbId": "tt3107288",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt3107288/img"
      },
      {
        "type": "episode",
        "showName": "Arrow",
        "season": 3,
        "episode": 8,
        "title": "The Brave and the Bold",
        "tmdbId": 1412,
        "imdbId": "tt2193021",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt2193021/img"
      }
    ]
  },
  {
    "id": "arrowverse_heroes_join_forces_2015",
    "name": "Heroes Join Forces: Legends of Today/Yesterday (2015)",
    "franchise": "Arrowverse",
    "category": "tvuniverses",
    "description": "Team Flash and Team Arrow join forces against the immortal Vandal Savage to protect Hawkman and Hawkgirl -- the backdoor pilot that launched DC's Legends of Tomorrow.",
    "episodes": [
      {
        "type": "episode",
        "showName": "The Flash",
        "season": 2,
        "episode": 8,
        "title": "Legends of Today",
        "tmdbId": 60735,
        "imdbId": "tt3107288",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt3107288/img"
      },
      {
        "type": "episode",
        "showName": "Arrow",
        "season": 4,
        "episode": 8,
        "title": "Legends of Yesterday",
        "tmdbId": 1412,
        "imdbId": "tt2193021",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt2193021/img"
      }
    ]
  },
  {
    "id": "arrowverse_invasion_2016",
    "name": "Invasion! (2016)",
    "franchise": "Arrowverse",
    "category": "tvuniverses",
    "description": "The first 4-show Arrowverse crossover: Supergirl, The Flash, Arrow, and DC's Legends of Tomorrow unite to stop an alien invasion by the Dominators.",
    "episodes": [
      {
        "type": "episode",
        "showName": "Supergirl",
        "season": 2,
        "episode": 8,
        "title": "Medusa",
        "tmdbId": 62688,
        "imdbId": "tt4016454",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt4016454/img"
      },
      {
        "type": "episode",
        "showName": "The Flash",
        "season": 3,
        "episode": 8,
        "title": "Invasion!",
        "tmdbId": 60735,
        "imdbId": "tt3107288",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt3107288/img"
      },
      {
        "type": "episode",
        "showName": "Arrow",
        "season": 5,
        "episode": 8,
        "title": "Invasion!",
        "tmdbId": 1412,
        "imdbId": "tt2193021",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt2193021/img"
      },
      {
        "type": "episode",
        "showName": "DC's Legends of Tomorrow",
        "season": 2,
        "episode": 7,
        "title": "Invasion!",
        "tmdbId": 62643,
        "imdbId": "tt4532368",
        "part": 4,
        "poster": "https://images.metahub.space/poster/medium/tt4532368/img"
      }
    ]
  },
  {
    "id": "arrowverse_crisis_on_earth_x_2017",
    "name": "Crisis on Earth-X (2017)",
    "franchise": "Arrowverse",
    "category": "tvuniverses",
    "description": "Nazi invaders from the parallel world Earth-X attack Central City during Barry and Iris's wedding, forcing Supergirl, Arrow, The Flash, and the Legends into the Arrowverse's biggest crossover yet.",
    "episodes": [
      {
        "type": "episode",
        "showName": "Supergirl",
        "season": 3,
        "episode": 8,
        "title": "Crisis on Earth-X, Part 1",
        "tmdbId": 62688,
        "imdbId": "tt4016454",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt4016454/img"
      },
      {
        "type": "episode",
        "showName": "Arrow",
        "season": 6,
        "episode": 8,
        "title": "Crisis on Earth-X, Part 2",
        "tmdbId": 1412,
        "imdbId": "tt2193021",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt2193021/img"
      },
      {
        "type": "episode",
        "showName": "The Flash",
        "season": 4,
        "episode": 8,
        "title": "Crisis on Earth-X, Part 3",
        "tmdbId": 60735,
        "imdbId": "tt3107288",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt3107288/img"
      },
      {
        "type": "episode",
        "showName": "DC's Legends of Tomorrow",
        "season": 3,
        "episode": 8,
        "title": "Crisis on Earth-X, Part 4",
        "tmdbId": 62643,
        "imdbId": "tt4532368",
        "part": 4,
        "poster": "https://images.metahub.space/poster/medium/tt4532368/img"
      }
    ]
  },
  {
    "id": "arrowverse_elseworlds_2018",
    "name": "Elseworlds (2018)",
    "franchise": "Arrowverse",
    "category": "tvuniverses",
    "description": "Barry Allen and Oliver Queen wake up having swapped bodies and lives, sending The Flash, Arrow, and Supergirl on a reality-bending adventure that sets up Crisis on Infinite Earths.",
    "episodes": [
      {
        "type": "episode",
        "showName": "The Flash",
        "season": 5,
        "episode": 9,
        "title": "Elseworlds, Part 1",
        "tmdbId": 60735,
        "imdbId": "tt3107288",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt3107288/img"
      },
      {
        "type": "episode",
        "showName": "Arrow",
        "season": 7,
        "episode": 9,
        "title": "Elseworlds, Part 2",
        "tmdbId": 1412,
        "imdbId": "tt2193021",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt2193021/img"
      },
      {
        "type": "episode",
        "showName": "Supergirl",
        "season": 4,
        "episode": 9,
        "title": "Elseworlds, Part 3",
        "tmdbId": 62688,
        "imdbId": "tt4016454",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt4016454/img"
      }
    ]
  },
  {
    "id": "arrowverse_crisis_on_infinite_earths_2019",
    "name": "Crisis on Infinite Earths (2019-2020)",
    "franchise": "Arrowverse",
    "category": "tvuniverses",
    "description": "The Arrowverse's biggest crossover event: Supergirl, Batwoman, The Flash, Arrow, and the Legends unite across five episodes to stop the Anti-Monitor from erasing the entire multiverse.",
    "episodes": [
      {
        "type": "episode",
        "showName": "Supergirl",
        "season": 5,
        "episode": 9,
        "title": "Crisis on Infinite Earths: Part One",
        "tmdbId": 62688,
        "imdbId": "tt4016454",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt4016454/img"
      },
      {
        "type": "episode",
        "showName": "Batwoman",
        "season": 1,
        "episode": 9,
        "title": "Crisis on Infinite Earths: Part Two",
        "tmdbId": 89247,
        "imdbId": "tt8712204",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt8712204/img"
      },
      {
        "type": "episode",
        "showName": "The Flash",
        "season": 6,
        "episode": 9,
        "title": "Crisis on Infinite Earths: Part Three",
        "tmdbId": 60735,
        "imdbId": "tt3107288",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt3107288/img"
      },
      {
        "type": "episode",
        "showName": "Arrow",
        "season": 8,
        "episode": 8,
        "title": "Crisis on Infinite Earths: Part Four",
        "tmdbId": 1412,
        "imdbId": "tt2193021",
        "part": 4,
        "poster": "https://images.metahub.space/poster/medium/tt2193021/img"
      },
      {
        "type": "episode",
        "showName": "DC's Legends of Tomorrow",
        "season": 5,
        "episode": 1,
        "title": "Crisis on Infinite Earths: Part Five",
        "tmdbId": 62643,
        "imdbId": "tt4532368",
        "part": 5,
        "poster": "https://images.metahub.space/poster/medium/tt4532368/img"
      }
    ]
  },
  {
    "id": "greys_station19_november_2020_crossover",
    "name": "Grey's Anatomy & Station 19: Season Premiere Crossover (2020)",
    "franchise": "Grey's Anatomy Universe",
    "category": "tvuniverses",
    "description": "3-part crossover connecting Station 19 and Grey's Anatomy season premieres, following the rescue and treatment of children injured in a car accident.",
    "episodes": [
      {
        "type": "episode",
        "showName": "Station 19",
        "season": 4,
        "episode": 1,
        "title": "Nothing Seems the Same",
        "tmdbId": 76773,
        "imdbId": "tt7053188",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt7053188/img"
      },
      {
        "type": "episode",
        "showName": "Grey's Anatomy",
        "season": 17,
        "episode": 1,
        "title": "All Tomorrow's Parties",
        "tmdbId": 1416,
        "imdbId": "tt0413573",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0413573/img"
      },
      {
        "type": "episode",
        "showName": "Grey's Anatomy",
        "season": 17,
        "episode": 2,
        "title": "The Center Won't Hold",
        "tmdbId": 1416,
        "imdbId": "tt0413573",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt0413573/img"
      }
    ]
  },
  {
    "id": "greys_station19_bottle_up_and_explode_2021",
    "name": "Grey's Anatomy & Station 19: Bottle Up and Explode! (2021)",
    "franchise": "Grey's Anatomy Universe",
    "category": "tvuniverses",
    "description": "2-part crossover: a Seattle pipeline explosion sends Station 19 racing into a chaotic rescue that overwhelms the Grey Sloan doctors in the aftermath.",
    "episodes": [
      {
        "type": "episode",
        "showName": "Station 19",
        "season": 5,
        "episode": 5,
        "title": "Things We Lost in the Fire",
        "tmdbId": 76773,
        "imdbId": "tt7053188",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt7053188/img"
      },
      {
        "type": "episode",
        "showName": "Grey's Anatomy",
        "season": 18,
        "episode": 5,
        "title": "Bottle Up and Explode!",
        "tmdbId": 1416,
        "imdbId": "tt0413573",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0413573/img"
      }
    ]
  },
  {
    "id": "law_and_order_return_of_the_prodigal_son_2021",
    "name": "Law & Order: Return of the Prodigal Son (2021)",
    "franchise": "Law & Order Universe",
    "category": "tvuniverses",
    "description": "The launch crossover for Law & Order: Organized Crime -- Elliot Stabler returns to New York after a decade away, only for tragedy to strike, kicking off the new spin-off series.",
    "episodes": [
      {
        "type": "episode",
        "showName": "Law & Order: Special Victims Unit",
        "season": 22,
        "episode": 9,
        "title": "Return of the Prodigal Son",
        "tmdbId": 2734,
        "imdbId": "tt0203259",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0203259/img"
      },
      {
        "type": "episode",
        "showName": "Law & Order: Organized Crime",
        "season": 1,
        "episode": 1,
        "title": "What Happens in Puglia",
        "tmdbId": 106158,
        "imdbId": "tt12677870",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt12677870/img"
      }
    ]
  },
  {
    "id": "law_and_order_gimme_shelter_2022",
    "name": "Law & Order: Gimme Shelter (2022)",
    "franchise": "Law & Order Universe",
    "category": "tvuniverses",
    "description": "The first-ever 3-hour crossover across all three active Law & Order shows: a shooting investigation pulls in Organized Crime, SVU, and the original Law & Order squad and DAs.",
    "episodes": [
      {
        "type": "episode",
        "showName": "Law & Order: Organized Crime",
        "season": 3,
        "episode": 1,
        "title": "Gimme Shelter: Part One",
        "tmdbId": 106158,
        "imdbId": "tt12677870",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt12677870/img"
      },
      {
        "type": "episode",
        "showName": "Law & Order: Special Victims Unit",
        "season": 24,
        "episode": 1,
        "title": "Gimme Shelter: Part Two",
        "tmdbId": 2734,
        "imdbId": "tt0203259",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0203259/img"
      },
      {
        "type": "episode",
        "showName": "Law & Order",
        "season": 22,
        "episode": 1,
        "title": "Gimme Shelter: Part Three",
        "tmdbId": 549,
        "imdbId": "tt0098844",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt0098844/img"
      }
    ]
  },
  {
    "id": "fbi_and_most_wanted_crossover_2020",
    "name": "FBI & FBI: Most Wanted Crossover (2020)",
    "franchise": "FBI Universe",
    "category": "tvuniverses",
    "description": "2-part crossover connecting FBI and FBI: Most Wanted as the two teams work a case together.",
    "episodes": [
      {
        "type": "episode",
        "showName": "FBI",
        "season": 2,
        "episode": 18,
        "title": "American Dreams",
        "tmdbId": 80748,
        "imdbId": "tt7491982",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt7491982/img"
      },
      {
        "type": "episode",
        "showName": "FBI: Most Wanted",
        "season": 1,
        "episode": 9,
        "title": "Reveille",
        "tmdbId": 94372,
        "imdbId": "tt9742936",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt9742936/img"
      }
    ]
  },
  {
    "id": "fbi_international_launch_crossover_2021",
    "name": "FBI, Most Wanted & International: Series Launch Crossover (2021)",
    "franchise": "FBI Universe",
    "category": "tvuniverses",
    "description": "3-part crossover premiere spanning the United States and Europe: a yacht party murder leads to a manhunt that concludes with the launch of FBI: International's Budapest-based Fly Team.",
    "episodes": [
      {
        "type": "episode",
        "showName": "FBI",
        "season": 4,
        "episode": 1,
        "title": "All That Glitters",
        "tmdbId": 80748,
        "imdbId": "tt7491982",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt7491982/img"
      },
      {
        "type": "episode",
        "showName": "FBI: Most Wanted",
        "season": 3,
        "episode": 1,
        "title": "Exposed",
        "tmdbId": 94372,
        "imdbId": "tt9742936",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt9742936/img"
      },
      {
        "type": "episode",
        "showName": "FBI: International",
        "season": 1,
        "episode": 1,
        "title": "Pilot",
        "tmdbId": 121658,
        "imdbId": "tt14449470",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt14449470/img"
      }
    ]
  },
  {
    "id": "fbi_imminent_threat_crossover_2023",
    "name": "FBI: Imminent Threat (2023)",
    "franchise": "FBI Universe",
    "category": "tvuniverses",
    "description": "3-part global crossover: the abduction of an American citizen in Rome reveals an international plot to carry out a mass-casualty terror attack in New York City, uniting all three FBI teams.",
    "episodes": [
      {
        "type": "episode",
        "showName": "FBI: International",
        "season": 2,
        "episode": 16,
        "title": "Imminent Threat, Part One",
        "tmdbId": 121658,
        "imdbId": "tt14449470",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt14449470/img"
      },
      {
        "type": "episode",
        "showName": "FBI",
        "season": 5,
        "episode": 17,
        "title": "Imminent Threat, Part Two",
        "tmdbId": 80748,
        "imdbId": "tt7491982",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt7491982/img"
      },
      {
        "type": "episode",
        "showName": "FBI: Most Wanted",
        "season": 4,
        "episode": 16,
        "title": "Imminent Threat, Part Three",
        "tmdbId": 94372,
        "imdbId": "tt9742936",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt9742936/img"
      }
    ]
  },
  {
    "id": "one_chicago_april_2014_crossover",
    "name": "One Chicago: A Dark Day / 8:30 PM (2014)",
    "franchise": "One Chicago",
    "category": "tvuniverses",
    "description": "The very first One Chicago crossover, launching the shared universe between Chicago Fire and its new spin-off Chicago P.D.",
    "episodes": [
      {
        "type": "episode",
        "showName": "Chicago Fire",
        "season": 2,
        "episode": 20,
        "title": "A Dark Day",
        "tmdbId": 44006,
        "imdbId": "tt2261391",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt2261391/img"
      },
      {
        "type": "episode",
        "showName": "Chicago P.D.",
        "season": 1,
        "episode": 12,
        "title": "8:30 PM",
        "tmdbId": 58841,
        "imdbId": "tt2805096",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt2805096/img"
      }
    ]
  },
  {
    "id": "one_chicago_the_beating_heart_2015",
    "name": "One Chicago: The Beating Heart (2015)",
    "franchise": "One Chicago",
    "category": "tvuniverses",
    "description": "The first official 3-show One Chicago crossover, and the backdoor pilot for Chicago Med: a stabbed Firehouse 51 member connects Fire, the new hospital, and a P.D. chemo-overdose investigation.",
    "episodes": [
      {
        "type": "episode",
        "showName": "Chicago Fire",
        "season": 4,
        "episode": 10,
        "title": "The Beating Heart",
        "tmdbId": 44006,
        "imdbId": "tt2261391",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt2261391/img"
      },
      {
        "type": "episode",
        "showName": "Chicago Med",
        "season": 1,
        "episode": 5,
        "title": "Malignant",
        "tmdbId": 62650,
        "imdbId": "tt4655480",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt4655480/img"
      },
      {
        "type": "episode",
        "showName": "Chicago P.D.",
        "season": 3,
        "episode": 10,
        "title": "Now I'm God",
        "tmdbId": 58841,
        "imdbId": "tt2805096",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt2805096/img"
      }
    ]
  },
  {
    "id": "one_chicago_going_to_war_2018",
    "name": "One Chicago: Going to War (2018)",
    "franchise": "One Chicago",
    "category": "tvuniverses",
    "description": "A high-rise fire endangers Stella Kidd and claims the life of Pat Halstead, father of both Med's Will Halstead and P.D.'s Jay Halstead, in this heart-breaking crossover.",
    "episodes": [
      {
        "type": "episode",
        "showName": "Chicago Fire",
        "season": 7,
        "episode": 2,
        "title": "Going to War",
        "tmdbId": 44006,
        "imdbId": "tt2261391",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt2261391/img"
      },
      {
        "type": "episode",
        "showName": "Chicago Med",
        "season": 4,
        "episode": 2,
        "title": "When to Let Go",
        "tmdbId": 62650,
        "imdbId": "tt4655480",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt4655480/img"
      },
      {
        "type": "episode",
        "showName": "Chicago P.D.",
        "season": 6,
        "episode": 2,
        "title": "Endings",
        "tmdbId": 58841,
        "imdbId": "tt2805096",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt2805096/img"
      }
    ]
  },
  {
    "id": "one_chicago_infection_2019",
    "name": "One Chicago: Infection (2019)",
    "franchise": "One Chicago",
    "category": "tvuniverses",
    "description": "A deadly, fast-spreading virus forces Firehouse 51, Chicago Med, and Intelligence to work alongside the CDC to contain a citywide outbreak.",
    "episodes": [
      {
        "type": "episode",
        "showName": "Chicago Fire",
        "season": 8,
        "episode": 4,
        "title": "Infection: Part I",
        "tmdbId": 44006,
        "imdbId": "tt2261391",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt2261391/img"
      },
      {
        "type": "episode",
        "showName": "Chicago Med",
        "season": 5,
        "episode": 4,
        "title": "Infection: Part II",
        "tmdbId": 62650,
        "imdbId": "tt4655480",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt4655480/img"
      },
      {
        "type": "episode",
        "showName": "Chicago P.D.",
        "season": 7,
        "episode": 4,
        "title": "Infection: Part III",
        "tmdbId": 58841,
        "imdbId": "tt2805096",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt2805096/img"
      }
    ]
  },
  {
    "id": "one_chicago_off_the_grid_2020",
    "name": "One Chicago: Off the Grid (2020)",
    "franchise": "One Chicago",
    "category": "tvuniverses",
    "description": "2-part crossover: a suspected opioid overdose call at a rescue scene leads Fire and Intelligence into the return of a former Chicago P.D. officer searching for his missing sister.",
    "episodes": [
      {
        "type": "episode",
        "showName": "Chicago Fire",
        "season": 8,
        "episode": 15,
        "title": "Off the Grid",
        "tmdbId": 44006,
        "imdbId": "tt2261391",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt2261391/img"
      },
      {
        "type": "episode",
        "showName": "Chicago P.D.",
        "season": 7,
        "episode": 15,
        "title": "Burden of Truth",
        "tmdbId": 58841,
        "imdbId": "tt2805096",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt2805096/img"
      }
    ]
  },
  {
    "id": "one_chicago_nobody_touches_anything_2014",
    "name": "One Chicago: Nobody Touches Anything / Chicago Crossover (2014)",
    "franchise": "One Chicago",
    "category": "tvuniverses",
    "description": "3-part crossover: a Firehouse 51 fire investigation leads Chicago P.D.'s Erin Lindsay into a decades-old child pornography ring case, personal for her, that pulls in SVU's Olivia Benson.",
    "episodes": [
      {
        "type": "episode",
        "showName": "Chicago Fire",
        "season": 3,
        "episode": 7,
        "title": "Nobody Touches Anything",
        "tmdbId": 44006,
        "imdbId": "tt2261391",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt2261391/img"
      },
      {
        "type": "episode",
        "showName": "Law & Order: Special Victims Unit",
        "season": 16,
        "episode": 7,
        "title": "Chicago Crossover",
        "tmdbId": 2734,
        "imdbId": "tt0203259",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0203259/img"
      },
      {
        "type": "episode",
        "showName": "Chicago P.D.",
        "season": 2,
        "episode": 7,
        "title": "They'll Have to Go Through Me",
        "tmdbId": 58841,
        "imdbId": "tt2805096",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt2805096/img"
      }
    ]
  },
  {
    "id": "one_chicago_three_bells_2014",
    "name": "One Chicago: Three Bells (2014)",
    "franchise": "One Chicago",
    "category": "tvuniverses",
    "description": "2-part crossover connecting Chicago Fire and Chicago P.D.",
    "episodes": [
      {
        "type": "episode",
        "showName": "Chicago Fire",
        "season": 3,
        "episode": 13,
        "title": "Three Bells",
        "tmdbId": 44006,
        "imdbId": "tt2261391",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt2261391/img"
      },
      {
        "type": "episode",
        "showName": "Chicago P.D.",
        "season": 2,
        "episode": 13,
        "title": "A Little Devil Complex",
        "tmdbId": 58841,
        "imdbId": "tt2805096",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt2805096/img"
      }
    ]
  },
  {
    "id": "one_chicago_daydream_believer_2015",
    "name": "One Chicago: We Called Her Jellybean / Daydream Believer (2015)",
    "franchise": "One Chicago",
    "category": "tvuniverses",
    "description": "3-part crossover: a rape/murder case eerily similar to one from a decade ago pulls Chicago Fire, Chicago P.D., and SVU's Olivia Benson into a manhunt for serial killer Gregory Yates that moves from Chicago to New York.",
    "episodes": [
      {
        "type": "episode",
        "showName": "Chicago Fire",
        "season": 3,
        "episode": 21,
        "title": "We Called Her Jellybean",
        "tmdbId": 44006,
        "imdbId": "tt2261391",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt2261391/img"
      },
      {
        "type": "episode",
        "showName": "Chicago P.D.",
        "season": 2,
        "episode": 20,
        "title": "The Number of Rats",
        "tmdbId": 58841,
        "imdbId": "tt2805096",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt2805096/img"
      },
      {
        "type": "episode",
        "showName": "Law & Order: Special Victims Unit",
        "season": 16,
        "episode": 20,
        "title": "Daydream Believer",
        "tmdbId": 2734,
        "imdbId": "tt0203259",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt0203259/img"
      }
    ]
  },
  {
    "id": "one_chicago_nationwide_manhunt_2016",
    "name": "One Chicago: Nationwide Manhunt (2016)",
    "franchise": "One Chicago",
    "category": "tvuniverses",
    "description": "SVU joins Chicago P.D.'s Intelligence Unit in a manhunt after serial killer Gregory Yates escapes a New York prison and heads for Chicago, targeting Erin Lindsay.",
    "episodes": [
      {
        "type": "episode",
        "showName": "Law & Order: Special Victims Unit",
        "season": 17,
        "episode": 14,
        "title": "Nationwide Manhunt",
        "tmdbId": 2734,
        "imdbId": "tt0203259",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0203259/img"
      },
      {
        "type": "episode",
        "showName": "Chicago P.D.",
        "season": 3,
        "episode": 14,
        "title": "The Song of Gregory William Yates",
        "tmdbId": 58841,
        "imdbId": "tt2805096",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt2805096/img"
      }
    ]
  },
  {
    "id": "one_chicago_deathtrap_2017",
    "name": "One Chicago: Deathtrap / Fake (2017)",
    "franchise": "One Chicago",
    "category": "tvuniverses",
    "description": "3-part crossover and the launch of Chicago Justice: an intentionally set warehouse fire that kills dozens, including a colleague's daughter, leads from the fire scene through an Intelligence Unit manhunt to the courtroom trial of the arsonist.",
    "episodes": [
      {
        "type": "episode",
        "showName": "Chicago Fire",
        "season": 5,
        "episode": 15,
        "title": "Deathtrap",
        "tmdbId": 44006,
        "imdbId": "tt2261391",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt2261391/img"
      },
      {
        "type": "episode",
        "showName": "Chicago P.D.",
        "season": 4,
        "episode": 16,
        "title": "Emotional Proximity",
        "tmdbId": 58841,
        "imdbId": "tt2805096",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt2805096/img"
      },
      {
        "type": "episode",
        "showName": "Chicago Justice",
        "season": 1,
        "episode": 1,
        "title": "Fake",
        "tmdbId": 67993,
        "imdbId": "tt5640060",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt5640060/img"
      }
    ]
  },
  {
    "id": "one_chicago_some_make_it_2017",
    "name": "One Chicago: Some Make It, Some Don't (2017)",
    "franchise": "One Chicago",
    "category": "tvuniverses",
    "description": "2-part crossover connecting Chicago Fire and Chicago P.D.",
    "episodes": [
      {
        "type": "episode",
        "showName": "Chicago Fire",
        "season": 5,
        "episode": 9,
        "title": "Some Make It, Some Don't",
        "tmdbId": 44006,
        "imdbId": "tt2261391",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt2261391/img"
      },
      {
        "type": "episode",
        "showName": "Chicago P.D.",
        "season": 4,
        "episode": 9,
        "title": "Don't Bury This Case",
        "tmdbId": 58841,
        "imdbId": "tt2805096",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt2805096/img"
      }
    ]
  },
  {
    "id": "one_chicago_profiles_2018",
    "name": "One Chicago: Profiles (2018)",
    "franchise": "One Chicago",
    "category": "tvuniverses",
    "description": "2-part crossover, starting on Chicago P.D. and continuing on Chicago Fire.",
    "episodes": [
      {
        "type": "episode",
        "showName": "Chicago P.D.",
        "season": 5,
        "episode": 16,
        "title": "Profiles",
        "tmdbId": 58841,
        "imdbId": "tt2805096",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt2805096/img"
      },
      {
        "type": "episode",
        "showName": "Chicago Fire",
        "season": 6,
        "episode": 13,
        "title": "Hiding Not Seeking",
        "tmdbId": 44006,
        "imdbId": "tt2261391",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt2261391/img"
      }
    ]
  },
  {
    "id": "one_chicago_what_i_saw_2019",
    "name": "One Chicago: What I Saw / Good Men (2019)",
    "franchise": "One Chicago",
    "category": "tvuniverses",
    "description": "2-part crossover connecting Chicago Fire and Chicago P.D.",
    "episodes": [
      {
        "type": "episode",
        "showName": "Chicago Fire",
        "season": 7,
        "episode": 15,
        "title": "What I Saw",
        "tmdbId": 44006,
        "imdbId": "tt2261391",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt2261391/img"
      },
      {
        "type": "episode",
        "showName": "Chicago P.D.",
        "season": 6,
        "episode": 15,
        "title": "Good Men",
        "tmdbId": 58841,
        "imdbId": "tt2805096",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt2805096/img"
      }
    ]
  },
  {
    "id": "movie_karate_kid_cobra_kai_saga",
    "name": "The Karate Kid: Complete Miyagi-Verse Saga",
    "franchise": "The Karate Kid",
    "category": "moviesagas",
    "description": "The Karate Kid (1984), Part II (1986), Part III (1989), and The Next Karate Kid (1994), followed by Cobra Kai (Seasons 1-6), and concluding with Karate Kid: Legends (2025) -- the 'Miyagi-verse' continuity as defined by Cobra Kai's own creators.",
    "episodes": [
      {
        "type": "movie",
        "title": "The Karate Kid",
        "tmdbId": 1885,
        "imdbId": "tt0087538",
        "year": 1984,
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0087538/img"
      },
      {
        "type": "movie",
        "title": "The Karate Kid Part II",
        "tmdbId": 8856,
        "imdbId": "tt0091326",
        "year": 1986,
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0091326/img"
      },
      {
        "type": "movie",
        "title": "The Karate Kid Part III",
        "tmdbId": 10495,
        "imdbId": "tt0097647",
        "year": 1989,
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt0097647/img"
      },
      {
        "type": "movie",
        "title": "The Next Karate Kid",
        "tmdbId": 11231,
        "imdbId": "tt0110657",
        "year": 1994,
        "part": 4,
        "poster": "https://images.metahub.space/poster/medium/tt0110657/img"
      },
      {
        "type": "show",
        "showName": "Cobra Kai",
        "tmdbId": 77169,
        "seasons": [1, 2, 3, 4, 5, 6],
        "title": "Cobra Kai (Seasons 1-6)",
        "part": 5,
        "imdbId": "tt7221388",
        "poster": "https://images.metahub.space/poster/medium/tt7221388/img"
      },
      {
        "type": "movie",
        "title": "Karate Kid: Legends",
        "tmdbId": 1011477,
        "imdbId": "tt1674782",
        "year": 2025,
        "part": 6,
        "poster": "https://images.metahub.space/poster/medium/tt1674782/img"
      }
    ]
  },
  {
    "id": "hawaii_five_0_magnum_pi_crossover_2020",
    "name": "Hawaii Five-0 & Magnum P.I. Crossover (2020)",
    "franchise": "Lenkov-verse",
    "category": "tvuniverses",
    "description": "2-part crossover: when a list of undercover CIA agents is stolen, Steve McGarrett and Five-0 enlist Magnum, Higgins, Rick, and TC to get it back and protect national security.",
    "episodes": [
      {
        "type": "episode",
        "showName": "Hawaii Five-0",
        "season": 10,
        "episode": 12,
        "title": "Ihea 'oe i ka wa a ka ua e loku ana?",
        "tmdbId": 32798,
        "imdbId": "tt1600194",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt1600194/img"
      },
      {
        "type": "episode",
        "showName": "Magnum P.I.",
        "season": 2,
        "episode": 12,
        "title": "Desperate Measures",
        "tmdbId": 79593,
        "imdbId": "tt7942796",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt7942796/img"
      }
    ]
  },
  {
    "id": "911_lone_star_hold_the_line_2021",
    "name": "9-1-1 & 9-1-1: Lone Star: Hold the Line (2021)",
    "franchise": "9-1-1 Universe",
    "category": "tvuniverses",
    "description": "2-part crossover: Buck, Hen, and Eddie of Station 118 travel to Austin to help Station 126 battle a massive wildfire sparked by a volcanic eruption.",
    "episodes": [
      {
        "type": "episode",
        "showName": "9-1-1",
        "season": 4,
        "episode": 3,
        "title": "Future Tense",
        "tmdbId": 75219,
        "imdbId": "tt7235466",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt7235466/img"
      },
      {
        "type": "episode",
        "showName": "9-1-1: Lone Star",
        "season": 2,
        "episode": 3,
        "title": "Hold the Line",
        "tmdbId": 89393,
        "imdbId": "tt10323338",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt10323338/img"
      }
    ]
  },
  {
    "id": "one_chicago_comic_perversion_2014",
    "name": "One Chicago: Comic Perversion / Conventions (2014)",
    "franchise": "One Chicago",
    "category": "tvuniverses",
    "description": "The very first One Chicago crossover, and Chicago P.D.'s first with Law & Order: SVU: Erin Lindsay travels to New York seeking Olivia Benson's help on a case involving a string of similar sexual assault murders in Chicago.",
    "episodes": [
      {
        "type": "episode",
        "showName": "Law & Order: Special Victims Unit",
        "season": 15,
        "episode": 15,
        "title": "Comic Perversion",
        "tmdbId": 2734,
        "imdbId": "tt0203259",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0203259/img"
      },
      {
        "type": "episode",
        "showName": "Chicago P.D.",
        "season": 1,
        "episode": 6,
        "title": "Conventions",
        "tmdbId": 58841,
        "imdbId": "tt2805096",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt2805096/img"
      }
    ]
  },
  {
    "id": "buffy_angel_pangs_iwry_1999",
    "name": "Buffy the Vampire Slayer & Angel: Pangs / I Will Remember You (1999)",
    "franchise": "Buffyverse",
    "category": "tvuniverses",
    "description": "Angel secretly returns to Sunnydale to protect Buffy from a vengeful spirit on Thanksgiving, then reveals himself in Los Angeles the next day -- leading to a Mohra demon fight that briefly makes him human for one day with Buffy.",
    "episodes": [
      {
        "type": "episode",
        "showName": "Buffy the Vampire Slayer",
        "season": 4,
        "episode": 8,
        "title": "Pangs",
        "tmdbId": 95,
        "imdbId": "tt0118276",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0118276/img"
      },
      {
        "type": "episode",
        "showName": "Angel",
        "season": 1,
        "episode": 8,
        "title": "I Will Remember You",
        "tmdbId": 2426,
        "imdbId": "tt0162065",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0162065/img"
      }
    ]
  },
  {
    "id": "buffy_angel_fool_for_love_darla_2000",
    "name": "Buffy the Vampire Slayer & Angel: Fool for Love / Darla (2000)",
    "franchise": "Buffyverse",
    "category": "tvuniverses",
    "description": "Companion episodes airing the same night: Spike recounts his vampire origins and how he killed two Slayers to Buffy, while Angel relives his own dangerous history with Darla -- both episodes share overlapping flashbacks.",
    "episodes": [
      {
        "type": "episode",
        "showName": "Buffy the Vampire Slayer",
        "season": 5,
        "episode": 7,
        "title": "Fool for Love",
        "tmdbId": 95,
        "imdbId": "tt0118276",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0118276/img"
      },
      {
        "type": "episode",
        "showName": "Angel",
        "season": 2,
        "episode": 7,
        "title": "Darla",
        "tmdbId": 2426,
        "imdbId": "tt0162065",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0162065/img"
      }
    ]
  },
  {
    "id": "greys_private_practice_beat_your_heart_out_2009",
    "name": "Grey's Anatomy & Private Practice: Beat Your Heart Out / Acceptance (2009)",
    "franchise": "Grey's Anatomy Universe",
    "category": "tvuniverses",
    "description": "The biggest Grey's/Private Practice crossover event: Addison's brother Archer suffers a life-threatening seizure in LA, pulling in Derek's help from Seattle, while Grey's introduces Owen Hunt and the first meeting of Callie and Arizona.",
    "episodes": [
      {
        "type": "episode",
        "showName": "Grey's Anatomy",
        "season": 5,
        "episode": 14,
        "title": "Beat Your Heart Out",
        "tmdbId": 1416,
        "imdbId": "tt0413573",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0413573/img"
      },
      {
        "type": "episode",
        "showName": "Private Practice",
        "season": 2,
        "episode": 15,
        "title": "Acceptance",
        "tmdbId": 3172,
        "imdbId": "tt0972412",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0972412/img"
      }
    ]
  },
  {
    "id": "tvd_originals_moonlight_streetcar_2016",
    "name": "The Vampire Diaries & The Originals: Moonlight on the Bayou / A Streetcar Named Desire (2016)",
    "franchise": "The Vampire Diaries Universe",
    "category": "tvuniverses",
    "description": "The CW's special 2-hour crossover event: Stefan flees to New Orleans to escape a vampire hunter and seek Valerie's help, pulling the Salvatores directly into the Mikaelsons' world.",
    "episodes": [
      {
        "type": "episode",
        "showName": "The Vampire Diaries",
        "season": 7,
        "episode": 14,
        "title": "Moonlight on the Bayou",
        "tmdbId": 18165,
        "imdbId": "tt1405406",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt1405406/img"
      },
      {
        "type": "episode",
        "showName": "The Originals",
        "season": 3,
        "episode": 14,
        "title": "A Streetcar Named Desire",
        "tmdbId": 46896,
        "imdbId": "tt2632424",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt2632424/img"
      }
    ]
  },
  {
    "id": "csi_felony_flight_manhattan_manhunt_2005",
    "name": "CSI: Miami & CSI: NY: Felony Flight / Manhattan Manhunt (2005)",
    "franchise": "CSI Universe",
    "category": "tvuniverses",
    "description": "A serial killer sabotages his own prisoner transport flight from New York to Miami, escapes, and goes on a killing spree -- pulling New York's Mac Taylor down to Miami, then Miami's Horatio Caine up to New York, to catch him.",
    "episodes": [
      {
        "type": "episode",
        "showName": "CSI: Miami",
        "season": 4,
        "episode": 7,
        "title": "Felony Flight",
        "tmdbId": 1620,
        "imdbId": "tt0313043",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0313043/img"
      },
      {
        "type": "episode",
        "showName": "CSI: NY",
        "season": 2,
        "episode": 7,
        "title": "Manhattan Manhunt",
        "tmdbId": 2458,
        "imdbId": "tt0395843",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0395843/img"
      }
    ]
  },
  {
    "id": "csi_trilogy_2009",
    "name": "CSI: Trilogy (2009)",
    "franchise": "CSI Universe",
    "category": "tvuniverses",
    "description": "The only 3-way crossover in CSI history, spanning all three original shows on consecutive nights: Miami, New York, and the flagship Las Vegas team all converge on a single case.",
    "episodes": [
      {
        "type": "episode",
        "showName": "CSI: Miami",
        "season": 8,
        "episode": 7,
        "title": "Bone Voyage",
        "tmdbId": 1620,
        "imdbId": "tt0313043",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0313043/img"
      },
      {
        "type": "episode",
        "showName": "CSI: NY",
        "season": 6,
        "episode": 7,
        "title": "Hammer Down",
        "tmdbId": 2458,
        "imdbId": "tt0395843",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0395843/img"
      },
      {
        "type": "episode",
        "showName": "CSI: Crime Scene Investigation",
        "season": 10,
        "episode": 7,
        "title": "The Lost Girls",
        "tmdbId": 1431,
        "imdbId": "tt0247082",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt0247082/img"
      }
    ]
  },
  {
    "id": "empire_star_crossover_2017",
    "name": "Empire & Star Crossover (2017)",
    "franchise": "Lee Daniels Fox Universe",
    "category": "tvuniverses",
    "description": "Fox's two Lee Daniels musical dramas collide for their season premieres: Carlotta comes face-to-face with the Lyon family as Jamal Lyon crosses over to Star and Carlotta crosses over to Empire.",
    "episodes": [
      {
        "type": "episode",
        "showName": "Empire",
        "season": 4,
        "episode": 1,
        "title": "Noble Memory",
        "tmdbId": 61733,
        "imdbId": "tt3228904",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt3228904/img"
      },
      {
        "type": "episode",
        "showName": "Star",
        "season": 2,
        "episode": 1,
        "title": "The Winner Takes It All",
        "tmdbId": 68780,
        "imdbId": "tt4941240",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt4941240/img"
      }
    ]
  },
  {
    "id": "bones_sleepy_hollow_crossover_2015",
    "name": "Bones & Sleepy Hollow Crossover (2015)",
    "franchise": "Fox Halloween Crossover",
    "category": "tvuniverses",
    "description": "One of TV's oddest crossovers: forensic anthropologist Temperance Brennan and FBI Agent Booth team up with time-displaced Ichabod Crane and Agent Abbie Mills to identify a 200-year-old headless corpse, before the case turns fully supernatural on the Sleepy Hollow side.",
    "episodes": [
      {
        "type": "episode",
        "showName": "Bones",
        "season": 11,
        "episode": 5,
        "title": "The Resurrection in the Remains",
        "tmdbId": 1911,
        "imdbId": "tt0460627",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0460627/img"
      },
      {
        "type": "episode",
        "showName": "Sleepy Hollow",
        "season": 3,
        "episode": 5,
        "title": "Dead Men Tell No Tales",
        "tmdbId": 50825,
        "imdbId": "tt2647544",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt2647544/img"
      }
    ]
  },
  {
    "id": "movie_peacemaker_suicide_squad",
    "name": "Peacemaker: Complete Storyline & The Suicide Squad",
    "franchise": "DC Universe",
    "category": "tvuniverses",
    "description": "The Suicide Squad (2021) is a direct prerequisite to Peacemaker: Peacemaker is shot and left for dead in the movie, and the post-credits scene sets up his hospital recovery and the task force assigned to him in Episode 1.",
    "episodes": [
      {
        "type": "movie",
        "title": "The Suicide Squad",
        "year": 2021,
        "tmdbId": 436969,
        "imdbId": "tt6334354",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt6334354/img"
      },
      {
        "type": "show",
        "showName": "Peacemaker",
        "tmdbId": 110492,
        "imdbId": "tt13146404",
        "seasons": [
          1
        ],
        "title": "Peacemaker (Season 1)",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt13146404/img"
      }
    ]
  },
  {
    "id": "movie_the_batman_penguin",
    "name": "The Batman & The Penguin Saga",
    "franchise": "The Batman Epic Crime Saga",
    "category": "tvuniverses",
    "description": "The Penguin is a direct continuation of The Batman (2022), picking up one week after the flooding of Gotham and Carmine Falcone's death as Oz Cobb seizes control of the criminal underworld.",
    "episodes": [
      {
        "type": "movie",
        "title": "The Batman",
        "year": 2022,
        "tmdbId": 414906,
        "imdbId": "tt1877830",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt1877830/img"
      },
      {
        "type": "show",
        "showName": "The Penguin",
        "tmdbId": 137437,
        "imdbId": "tt15474916",
        "seasons": [
          1
        ],
        "title": "The Penguin (Season 1)",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt15474916/img"
      }
    ]
  },
  {
    "id": "movie_battlestar_galactica_miniseries",
    "name": "Battlestar Galactica: The Complete Modern Saga",
    "franchise": "Battlestar Galactica",
    "category": "tvuniverses",
    "description": "The 2003 Miniseries is the mandatory pilot depicting the Cylon holocaust on the Twelve Colonies, immediately followed by the four-season fleet survival saga.",
    "episodes": [
      {
        "type": "movie",
        "title": "Battlestar Galactica: The Miniseries",
        "year": 2003,
        "tmdbId": 4130,
        "imdbId": "tt0314979",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0314979/img"
      },
      {
        "type": "show",
        "showName": "Battlestar Galactica",
        "tmdbId": 1973,
        "imdbId": "tt0407362",
        "seasons": [
          1,
          2,
          3,
          4
        ],
        "title": "Battlestar Galactica (Seasons 1-4)",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0407362/img"
      }
    ]
  },
  {
    "id": "movie_star_wars_clone_wars_canon",
    "name": "Star Wars: The Clone Wars (Theatrical Film & Series)",
    "franchise": "Star Wars",
    "category": "tvuniverses",
    "description": "The 2008 theatrical movie is the essential pilot introducing Ahsoka Tano as Anakin Skywalker's new Padawan, directly launching the seven-season animated series.",
    "episodes": [
      {
        "type": "movie",
        "title": "Star Wars: The Clone Wars",
        "year": 2008,
        "tmdbId": 12180,
        "imdbId": "tt1185834",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt1185834/img"
      },
      {
        "type": "show",
        "showName": "Star Wars: The Clone Wars",
        "tmdbId": 4174,
        "imdbId": "tt0458290",
        "seasons": [
          1,
          2,
          3,
          4,
          5,
          6,
          7
        ],
        "title": "Star Wars: The Clone Wars (Seasons 1-7)",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0458290/img"
      }
    ]
  },
  {
    "id": "movie_twin_peaks_complete_mythology",
    "name": "Twin Peaks: Complete Canon Chronology",
    "franchise": "Twin Peaks",
    "category": "tvuniverses",
    "description": "David Lynch's surreal mystery masterpiece: Seasons 1-2, the essential canon prequel film Fire Walk with Me, and the 2017 limited event series The Return.",
    "episodes": [
      {
        "type": "show",
        "showName": "Twin Peaks",
        "tmdbId": 192,
        "imdbId": "tt0098936",
        "seasons": [
          1,
          2
        ],
        "title": "Twin Peaks (Seasons 1-2)",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0098936/img"
      },
      {
        "type": "movie",
        "title": "Twin Peaks: Fire Walk with Me",
        "year": 1992,
        "tmdbId": 1923,
        "imdbId": "tt0105665",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0105665/img"
      },
      {
        "type": "show",
        "showName": "Twin Peaks",
        "tmdbId": 63926,
        "imdbId": "tt4093826",
        "seasons": [
          3
        ],
        "title": "Twin Peaks: The Return (Season 3)",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt4093826/img"
      }
    ]
  },
  {
    "id": "movie_veronica_mars_complete_saga",
    "name": "Veronica Mars: Complete Saga & Movie",
    "franchise": "Veronica Mars",
    "category": "tvuniverses",
    "description": "The complete Veronica Mars story: Seasons 1-3, followed by the crowdfunded 2014 feature film, and concluding with the 2019 Hulu revival season.",
    "episodes": [
      {
        "type": "show",
        "showName": "Veronica Mars",
        "tmdbId": 4370,
        "imdbId": "tt0412253",
        "seasons": [
          1,
          2,
          3
        ],
        "title": "Veronica Mars (Seasons 1-3)",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0412253/img"
      },
      {
        "type": "movie",
        "title": "Veronica Mars",
        "year": 2014,
        "tmdbId": 185008,
        "imdbId": "tt2771372",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt2771372/img"
      },
      {
        "type": "show",
        "showName": "Veronica Mars",
        "tmdbId": 4370,
        "imdbId": "tt0412253",
        "seasons": [
          4
        ],
        "title": "Veronica Mars (Season 4)",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt0412253/img"
      }
    ]
  },
  {
    "id": "movie_power_rangers_zeo_turbo_bridge",
    "name": "Power Rangers: Zeo to Turbo Canon Bridge",
    "franchise": "Power Rangers",
    "category": "tvuniverses",
    "description": "Turbo: A Power Rangers Movie (1997) is the mandatory canon bridge film between Zeo and Turbo, explaining how the Rangers acquired Turbo powers and introducing Justin and Divatox.",
    "episodes": [
      {
        "type": "show",
        "showName": "Power Rangers Zeo",
        "tmdbId": 1585,
        "imdbId": "tt0115324",
        "seasons": [
          1
        ],
        "title": "Power Rangers Zeo",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0115324/img"
      },
      {
        "type": "movie",
        "title": "Turbo: A Power Rangers Movie",
        "year": 1997,
        "tmdbId": 9611,
        "imdbId": "tt0120389",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0120389/img"
      },
      {
        "type": "show",
        "showName": "Power Rangers Turbo",
        "tmdbId": 1667,
        "imdbId": "tt0118433",
        "seasons": [
          1
        ],
        "title": "Power Rangers Turbo",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt0118433/img"
      }
    ]
  },
  {
    "id": "movie_transformers_g1_1986_bridge",
    "name": "The Transformers: G1 & 1986 Theatrical Movie",
    "franchise": "Transformers",
    "category": "tvuniverses",
    "description": "The Transformers: The Movie (1986) is the pivotal canon turning point set between Seasons 2 and 3, depicting the death of Optimus Prime, Megatron's rebirth as Galvatron, and the ascension of Rodimus Prime.",
    "episodes": [
      {
        "type": "show",
        "showName": "The Transformers",
        "tmdbId": 1096,
        "imdbId": "tt0086817",
        "seasons": [
          1,
          2
        ],
        "title": "The Transformers (Seasons 1-2)",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0086817/img"
      },
      {
        "type": "movie",
        "title": "The Transformers: The Movie",
        "year": 1986,
        "tmdbId": 1857,
        "imdbId": "tt0092106",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0092106/img"
      },
      {
        "type": "show",
        "showName": "The Transformers",
        "tmdbId": 1096,
        "imdbId": "tt0086817",
        "seasons": [
          3,
          4
        ],
        "title": "The Transformers (Seasons 3-4)",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt0086817/img"
      }
    ]
  },
  {
    "id": "movie_sex_and_the_city_complete_saga",
    "name": "Sex and the City: Complete Universe & Movies",
    "franchise": "Sex and the City",
    "category": "tvuniverses",
    "description": "The complete chronology: Seasons 1-6 of the original HBO series, followed by the two theatrical continuation movies, leading into And Just Like That...",
    "episodes": [
      {
        "type": "show",
        "showName": "Sex and the City",
        "tmdbId": 105,
        "imdbId": "tt0159206",
        "seasons": [
          1,
          2,
          3,
          4,
          5,
          6
        ],
        "title": "Sex and the City (Seasons 1-6)",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0159206/img"
      },
      {
        "type": "movie",
        "title": "Sex and the City",
        "year": 2008,
        "tmdbId": 9479,
        "imdbId": "tt1000774",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt1000774/img"
      },
      {
        "type": "movie",
        "title": "Sex and the City 2",
        "year": 2010,
        "tmdbId": 33644,
        "imdbId": "tt1261945",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt1261945/img"
      },
      {
        "type": "show",
        "showName": "And Just Like That...",
        "tmdbId": 115646,
        "imdbId": "tt13819960",
        "seasons": [
          1,
          2
        ],
        "title": "And Just Like That... (Seasons 1-2)",
        "part": 4,
        "poster": "https://images.metahub.space/poster/medium/tt13819960/img"
      }
    ]
  },
  {
    "id": "movie_monk_complete_last_case",
    "name": "Monk: Complete Saga & Last Case",
    "franchise": "Monk",
    "category": "tvuniverses",
    "description": "The full eight seasons of Adrian Monk's obsessive-compulsive detective cases, culminating in the 2023 reunion film Mr. Monk's Last Case.",
    "episodes": [
      {
        "type": "show",
        "showName": "Monk",
        "tmdbId": 1695,
        "imdbId": "tt0312172",
        "seasons": [
          1,
          2,
          3,
          4,
          5,
          6,
          7,
          8
        ],
        "title": "Monk (Seasons 1-8)",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0312172/img"
      },
      {
        "type": "movie",
        "title": "Mr. Monk's Last Case: A Monk Movie",
        "year": 2023,
        "tmdbId": 1103445,
        "imdbId": "tt27145784",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt27145784/img"
      }
    ]
  },
  {
    "id": "movie_luther_complete_fallen_sun",
    "name": "Luther: Complete Saga & The Fallen Sun",
    "franchise": "Luther",
    "category": "tvuniverses",
    "description": "Idris Elba's brilliant, tortured DCI John Luther across all five BBC series, followed by the 2023 Netflix continuation film Luther: The Fallen Sun.",
    "episodes": [
      {
        "type": "show",
        "showName": "Luther",
        "tmdbId": 31586,
        "imdbId": "tt1474684",
        "seasons": [
          1,
          2,
          3,
          4,
          5
        ],
        "title": "Luther (Seasons 1-5)",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt1474684/img"
      },
      {
        "type": "movie",
        "title": "Luther: The Fallen Sun",
        "year": 2023,
        "tmdbId": 885184,
        "imdbId": "tt14752254",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt14752254/img"
      }
    ]
  },
  {
    "id": "movie_burn_notice_sam_axe",
    "name": "Burn Notice & The Fall of Sam Axe",
    "franchise": "Burn Notice",
    "category": "tvuniverses",
    "description": "The action-packed spy saga in story order: prequel movie The Fall of Sam Axe detailing Sam's final military mission in Colombia, followed by all seven seasons of Burn Notice.",
    "episodes": [
      {
        "type": "movie",
        "title": "Burn Notice: The Fall of Sam Axe",
        "year": 2011,
        "tmdbId": 63216,
        "imdbId": "tt1697851",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt1697851/img"
      },
      {
        "type": "show",
        "showName": "Burn Notice",
        "tmdbId": 2919,
        "imdbId": "tt0810788",
        "seasons": [
          1,
          2,
          3,
          4,
          5,
          6,
          7
        ],
        "title": "Burn Notice (Seasons 1-7)",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0810788/img"
      }
    ]
  },
  {
    "id": "movie_farscape_peacekeeper_wars",
    "name": "Farscape: Complete Saga & The Peacekeeper Wars",
    "franchise": "Farscape",
    "category": "tvuniverses",
    "description": "Astronaut John Crichton's journey across the uncharted territories through four seasons, culminating in the epic miniseries finale The Peacekeeper Wars.",
    "episodes": [
      {
        "type": "show",
        "showName": "Farscape",
        "tmdbId": 4271,
        "imdbId": "tt0187636",
        "seasons": [
          1,
          2,
          3,
          4
        ],
        "title": "Farscape (Seasons 1-4)",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0187636/img"
      },
      {
        "type": "movie",
        "title": "Farscape: The Peacekeeper Wars",
        "year": 2004,
        "tmdbId": 808,
        "imdbId": "tt0387733",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0387733/img"
      }
    ]
  },
  {
    "id": "movie_csi_immortality_finale",
    "name": "CSI: Crime Scene Investigation & Immortality",
    "franchise": "CSI Universe",
    "category": "tvuniverses",
    "description": "Fifteen groundbreaking seasons of the flagship Las Vegas forensic unit, resolved in the two-part series finale television movie CSI: Immortality with Gil Grissom and Sara Sidle.",
    "episodes": [
      {
        "type": "show",
        "showName": "CSI: Crime Scene Investigation",
        "tmdbId": 1431,
        "imdbId": "tt0247082",
        "seasons": [
          1,
          2,
          3,
          4,
          5,
          6,
          7,
          8,
          9,
          10,
          11,
          12,
          13,
          14,
          15
        ],
        "title": "CSI: Crime Scene Investigation (Seasons 1-15)",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0247082/img"
      },
      {
        "type": "movie",
        "title": "CSI: Immortality",
        "year": 2015,
        "tmdbId": 359050,
        "imdbId": "tt4687402",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt4687402/img"
      }
    ]
  },
  {
    "id": "movie_the_sopranos_many_saints",
    "name": "The Sopranos & The Many Saints of Newark",
    "franchise": "The Sopranos",
    "category": "tvuniverses",
    "description": "The complete saga of Tony Soprano: David Chase's 1960s-70s origin prequel film The Many Saints of Newark followed by all six landmark seasons of The Sopranos.",
    "episodes": [
      {
        "type": "movie",
        "title": "The Many Saints of Newark",
        "year": 2021,
        "tmdbId": 524369,
        "imdbId": "tt8110330",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt8110330/img"
      },
      {
        "type": "show",
        "showName": "The Sopranos",
        "tmdbId": 1399,
        "imdbId": "tt0141842",
        "seasons": [
          1,
          2,
          3,
          4,
          5,
          6
        ],
        "title": "The Sopranos (Seasons 1-6)",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0141842/img"
      }
    ]
  },
  {
    "id": "movie_entourage_complete_and_film",
    "name": "Entourage: Complete Series & Feature Film",
    "franchise": "Entourage",
    "category": "tvuniverses",
    "description": "Vincent Chase and his Queens crew navigating Hollywood across all eight HBO seasons, concluding with the 2015 theatrical sequel movie.",
    "episodes": [
      {
        "type": "show",
        "showName": "Entourage",
        "tmdbId": 1947,
        "imdbId": "tt0387199",
        "seasons": [
          1,
          2,
          3,
          4,
          5,
          6,
          7,
          8
        ],
        "title": "Entourage (Seasons 1-8)",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0387199/img"
      },
      {
        "type": "movie",
        "title": "Entourage",
        "year": 2015,
        "tmdbId": 216282,
        "imdbId": "tt1674771",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt1674771/img"
      }
    ]
  },
  {
    "id": "movie_the_librarians_trilogy_series",
    "name": "The Librarians: Foundational Trilogy & Series",
    "franchise": "The Librarians",
    "category": "tvuniverses",
    "description": "Noah Wyle's Flynn Carsen in the original film trilogy (Quest for the Spear, King Solomon's Mines, Curse of the Judas Chalice), establishing the Library before recruiting the new team in the TV series.",
    "episodes": [
      {
        "type": "movie",
        "title": "The Librarian: Quest for the Spear",
        "year": 2004,
        "tmdbId": 11309,
        "imdbId": "tt0412915",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0412915/img"
      },
      {
        "type": "movie",
        "title": "The Librarian: Return to King Solomon's Mines",
        "year": 2006,
        "tmdbId": 11310,
        "imdbId": "tt0481566",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0481566/img"
      },
      {
        "type": "movie",
        "title": "The Librarian: Curse of the Judas Chalice",
        "year": 2008,
        "tmdbId": 13884,
        "imdbId": "tt1146438",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt1146438/img"
      },
      {
        "type": "show",
        "showName": "The Librarians",
        "tmdbId": 61889,
        "imdbId": "tt3663440",
        "seasons": [
          1,
          2,
          3,
          4
        ],
        "title": "The Librarians (Seasons 1-4)",
        "part": 4,
        "poster": "https://images.metahub.space/poster/medium/tt3663440/img"
      }
    ]
  },
  {
    "id": "movie_gomorrah_limmortale_bridge",
    "name": "Gomorrah: Complete Saga & L'immortale",
    "franchise": "Gomorrah",
    "category": "tvuniverses",
    "description": "The gritty Camorra crime saga: Seasons 1-4, the mandatory canon bridge film L'immortale explaining Ciro Di Marzio's survival in Riga, and the climactic final Season 5.",
    "episodes": [
      {
        "type": "show",
        "showName": "Gomorrah",
        "tmdbId": 46420,
        "imdbId": "tt2049116",
        "seasons": [
          1,
          2,
          3,
          4
        ],
        "title": "Gomorrah (Seasons 1-4)",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt2049116/img"
      },
      {
        "type": "movie",
        "title": "L'immortale",
        "year": 2019,
        "tmdbId": 633116,
        "imdbId": "tt10915740",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt10915740/img"
      },
      {
        "type": "show",
        "showName": "Gomorrah",
        "tmdbId": 46420,
        "imdbId": "tt2049116",
        "seasons": [
          5
        ],
        "title": "Gomorrah (Season 5)",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt2049116/img"
      }
    ]
  },
  {
    "id": "movie_spartacus_complete_chronology",
    "name": "Spartacus: Complete Chronological Order",
    "franchise": "Spartacus",
    "category": "tvuniverses",
    "description": "The complete gladiator rebellion in historical story order: prequel miniseries Gods of the Arena, followed by Blood and Sand (Season 1), Vengeance (Season 2), and War of the Damned (Season 3).",
    "episodes": [
      {
        "type": "show",
        "showName": "Spartacus: Gods of the Arena",
        "tmdbId": 37604,
        "imdbId": "tt1758604",
        "seasons": [
          1
        ],
        "title": "Spartacus: Gods of the Arena",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt1758604/img"
      },
      {
        "type": "show",
        "showName": "Spartacus",
        "tmdbId": 2316,
        "imdbId": "tt1442449",
        "seasons": [
          1,
          2,
          3
        ],
        "title": "Spartacus (Seasons 1-3)",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt1442449/img"
      }
    ]
  },
  {
    "id": "movie_venture_bros_radiant_blood",
    "name": "The Venture Bros.: Complete Series & Finale Film",
    "franchise": "The Venture Bros.",
    "category": "tvuniverses",
    "description": "All seven seasons of Jackson Publick & Doc Hammer's animated superhero satire, capped off by the 2023 feature film conclusion Radiant Is the Blood of the Baboon Heart.",
    "episodes": [
      {
        "type": "show",
        "showName": "The Venture Bros.",
        "tmdbId": 1539,
        "imdbId": "tt0417373",
        "seasons": [
          1,
          2,
          3,
          4,
          5,
          6,
          7
        ],
        "title": "The Venture Bros. (Seasons 1-7)",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0417373/img"
      },
      {
        "type": "movie",
        "title": "The Venture Bros.: Radiant Is the Blood of the Baboon Heart",
        "year": 2023,
        "tmdbId": 1134444,
        "imdbId": "tt14642238",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt14642238/img"
      }
    ]
  },
  {
    "id": "movie_metalocalypse_army_of_doomstar",
    "name": "Metalocalypse: Complete Series & Army of the Doomstar",
    "franchise": "Metalocalypse",
    "category": "tvuniverses",
    "description": "Dethklok's death metal saga across all four Adult Swim seasons and The Doomstar Requiem, culminating in the 2023 finale movie Army of the Doomstar.",
    "episodes": [
      {
        "type": "show",
        "showName": "Metalocalypse",
        "tmdbId": 2868,
        "imdbId": "tt0839188",
        "seasons": [
          1,
          2,
          3,
          4
        ],
        "title": "Metalocalypse (Seasons 1-4)",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0839188/img"
      },
      {
        "type": "movie",
        "title": "Metalocalypse: Army of the Doomstar",
        "year": 2023,
        "tmdbId": 1114972,
        "imdbId": "tt14642270",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt14642270/img"
      }
    ]
  },
  {
    "id": "movie_simpsons_canon_and_film",
    "name": "The Simpsons & The Simpsons Movie",
    "franchise": "The Simpsons",
    "category": "tvuniverses",
    "description": "Matt Groening's legendary animated family in Springfield, including the 2007 blockbuster theatrical film.",
    "episodes": [
      {
        "type": "show",
        "showName": "The Simpsons",
        "tmdbId": 456,
        "imdbId": "tt0096697",
        "seasons": [
          1,
          2,
          3,
          4,
          5,
          6,
          7,
          8,
          9,
          10,
          11,
          12,
          13,
          14,
          15,
          16,
          17,
          18
        ],
        "title": "The Simpsons (Seasons 1-18)",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0096697/img"
      },
      {
        "type": "movie",
        "title": "The Simpsons Movie",
        "year": 2007,
        "tmdbId": 35,
        "imdbId": "tt0462538",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0462538/img"
      },
      {
        "type": "show",
        "showName": "The Simpsons",
        "tmdbId": 456,
        "imdbId": "tt0096697",
        "seasons": [
          19,
          20,
          21,
          22,
          23,
          24,
          25,
          26,
          27,
          28,
          29,
          30,
          31,
          32,
          33,
          34,
          35,
          36
        ],
        "title": "The Simpsons (Seasons 19+)",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt0096697/img"
      }
    ]
  },
  {
    "id": "movie_south_park_bigger_longer_uncut",
    "name": "South Park & Bigger, Longer & Uncut",
    "franchise": "South Park",
    "category": "tvuniverses",
    "description": "Trey Parker and Matt Stone's animated satire in chronological release order, with the Oscar-nominated 1999 feature film.",
    "episodes": [
      {
        "type": "show",
        "showName": "South Park",
        "tmdbId": 2190,
        "imdbId": "tt0121955",
        "seasons": [
          1,
          2,
          3
        ],
        "title": "South Park (Seasons 1-3)",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0121955/img"
      },
      {
        "type": "movie",
        "title": "South Park: Bigger, Longer & Uncut",
        "year": 1999,
        "tmdbId": 9473,
        "imdbId": "tt0158983",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0158983/img"
      },
      {
        "type": "show",
        "showName": "South Park",
        "tmdbId": 2190,
        "imdbId": "tt0121955",
        "seasons": [
          4,
          5,
          6,
          7,
          8,
          9,
          10,
          11,
          12,
          13,
          14,
          15,
          16,
          17,
          18,
          19,
          20,
          21,
          22,
          23,
          24,
          25,
          26
        ],
        "title": "South Park (Seasons 4+)",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt0121955/img"
      }
    ]
  },
  {
    "id": "movie_bobs_burgers_movie_saga",
    "name": "Bob's Burgers & The Bob's Burgers Movie",
    "franchise": "Bob's Burgers",
    "category": "tvuniverses",
    "description": "The Belcher family's seaside hamburger adventures across Seasons 1-12, followed by the 2022 musical mystery feature film and ongoing series.",
    "episodes": [
      {
        "type": "show",
        "showName": "Bob's Burgers",
        "tmdbId": 32726,
        "imdbId": "tt1561755",
        "seasons": [
          1,
          2,
          3,
          4,
          5,
          6,
          7,
          8,
          9,
          10,
          11,
          12
        ],
        "title": "Bob's Burgers (Seasons 1-12)",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt1561755/img"
      },
      {
        "type": "movie",
        "title": "The Bob's Burgers Movie",
        "year": 2022,
        "tmdbId": 504827,
        "imdbId": "tt7466442",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt7466442/img"
      },
      {
        "type": "show",
        "showName": "Bob's Burgers",
        "tmdbId": 32726,
        "imdbId": "tt1561755",
        "seasons": [
          13,
          14,
          15
        ],
        "title": "Bob's Burgers (Seasons 13+)",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt1561755/img"
      }
    ]
  },
  {
    "id": "movie_batman_tas_mask_of_phantasm",
    "name": "Batman: The Animated Series & Mask of the Phantasm",
    "franchise": "DC Animated Universe",
    "category": "tvuniverses",
    "description": "Bruce Timm and Paul Dini's definitive Batman adaptation, anchored by the critically acclaimed 1993 theatrical masterpiece Mask of the Phantasm.",
    "episodes": [
      {
        "type": "movie",
        "title": "Batman: Mask of the Phantasm",
        "year": 1993,
        "tmdbId": 14919,
        "imdbId": "tt0106364",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0106364/img"
      },
      {
        "type": "show",
        "showName": "Batman: The Animated Series",
        "tmdbId": 2098,
        "imdbId": "tt0103359",
        "seasons": [
          1,
          2,
          3,
          4
        ],
        "title": "Batman: The Animated Series (Seasons 1-4)",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0103359/img"
      }
    ]
  },
  {
    "id": "movie_steven_universe_complete_chronology",
    "name": "Steven Universe: Complete Storyline Order",
    "franchise": "Steven Universe",
    "category": "tvuniverses",
    "description": "Rebecca Sugar's coming-of-age gem saga: Seasons 1-5, followed by the essential canon bridge Steven Universe: The Movie, concluding with the epilogue series Steven Universe Future.",
    "episodes": [
      {
        "type": "show",
        "showName": "Steven Universe",
        "tmdbId": 49737,
        "imdbId": "tt3061046",
        "seasons": [
          1,
          2,
          3,
          4,
          5
        ],
        "title": "Steven Universe (Seasons 1-5)",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt3061046/img"
      },
      {
        "type": "movie",
        "title": "Steven Universe: The Movie",
        "year": 2019,
        "tmdbId": 537061,
        "imdbId": "tt8714088",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt8714088/img"
      },
      {
        "type": "show",
        "showName": "Steven Universe Future",
        "tmdbId": 94553,
        "imdbId": "tt11075702",
        "seasons": [
          1
        ],
        "title": "Steven Universe Future",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt11075702/img"
      }
    ]
  },
  {
    "id": "movie_tangled_rapunzel_chronology",
    "name": "Tangled: Complete Corona Chronology",
    "franchise": "Disney Tangled",
    "category": "tvuniverses",
    "description": "Disney's Tangled franchise: the original 2010 film, the mandatory 2017 pilot movie Tangled: Before Ever After (explaining her 70ft golden hair regrowing), and all three seasons of Rapunzel's Tangled Adventure.",
    "episodes": [
      {
        "type": "movie",
        "title": "Tangled",
        "year": 2010,
        "tmdbId": 38757,
        "imdbId": "tt0398286",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0398286/img"
      },
      {
        "type": "movie",
        "title": "Tangled: Before Ever After",
        "year": 2017,
        "tmdbId": 437543,
        "imdbId": "tt6593452",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt6593452/img"
      },
      {
        "type": "show",
        "showName": "Rapunzel's Tangled Adventure",
        "tmdbId": 70289,
        "imdbId": "tt4759904",
        "seasons": [
          1,
          2,
          3
        ],
        "title": "Rapunzel's Tangled Adventure (Seasons 1-3)",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt4759904/img"
      }
    ]
  },
  {
    "id": "movie_lilo_and_stitch_complete_timeline",
    "name": "Lilo & Stitch: Complete Canon Timeline",
    "franchise": "Lilo & Stitch",
    "category": "tvuniverses",
    "description": "The complete Hawaiian sci-fi saga: the original 2002 film, Stitch! The Movie (introducing Jumba's 625 experiment pods), the TV series, and the finale film Leroy & Stitch.",
    "episodes": [
      {
        "type": "movie",
        "title": "Lilo & Stitch",
        "year": 2002,
        "tmdbId": 11544,
        "imdbId": "tt0275847",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0275847/img"
      },
      {
        "type": "movie",
        "title": "Stitch! The Movie",
        "year": 2003,
        "tmdbId": 11549,
        "imdbId": "tt0371999",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0371999/img"
      },
      {
        "type": "show",
        "showName": "Lilo & Stitch: The Series",
        "tmdbId": 3057,
        "imdbId": "tt0364841",
        "seasons": [
          1,
          2
        ],
        "title": "Lilo & Stitch: The Series (Seasons 1-2)",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt0364841/img"
      },
      {
        "type": "movie",
        "title": "Leroy & Stitch",
        "year": 2006,
        "tmdbId": 11551,
        "imdbId": "tt0810922",
        "part": 4,
        "poster": "https://images.metahub.space/poster/medium/tt0810922/img"
      }
    ]
  },
  {
    "id": "movie_jimmy_neutron_boy_genius",
    "name": "Jimmy Neutron: Boy Genius (Movie & Series)",
    "franchise": "Jimmy Neutron",
    "category": "tvuniverses",
    "description": "The Oscar-nominated 2001 theatrical feature film that launched the franchise, followed by all three seasons of The Adventures of Jimmy Neutron, Boy Genius.",
    "episodes": [
      {
        "type": "movie",
        "title": "Jimmy Neutron: Boy Genius",
        "year": 2001,
        "tmdbId": 12589,
        "imdbId": "tt0268397",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0268397/img"
      },
      {
        "type": "show",
        "showName": "The Adventures of Jimmy Neutron, Boy Genius",
        "tmdbId": 2210,
        "imdbId": "tt0320808",
        "seasons": [
          1,
          2,
          3
        ],
        "title": "The Adventures of Jimmy Neutron (Seasons 1-3)",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0320808/img"
      }
    ]
  },
  {
    "id": "movie_rugrats_complete_movie_chronology",
    "name": "Rugrats: Complete Series & Film Trilogy",
    "franchise": "Rugrats",
    "category": "tvuniverses",
    "description": "The complete classic Rugrats timeline in story order: Seasons 1-5, The Rugrats Movie (where Dil is born), Seasons 6-7, Rugrats in Paris, Seasons 8-9, and the Rugrats Go Wild crossover movie.",
    "episodes": [
      {
        "type": "show",
        "showName": "Rugrats",
        "tmdbId": 2403,
        "imdbId": "tt0101188",
        "seasons": [
          1,
          2,
          3,
          4,
          5
        ],
        "title": "Rugrats (Seasons 1-5)",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0101188/img"
      },
      {
        "type": "movie",
        "title": "The Rugrats Movie",
        "year": 1998,
        "tmdbId": 14444,
        "imdbId": "tt0134067",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0134067/img"
      },
      {
        "type": "show",
        "showName": "Rugrats",
        "tmdbId": 2403,
        "imdbId": "tt0101188",
        "seasons": [
          6,
          7
        ],
        "title": "Rugrats (Seasons 6-7)",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt0101188/img"
      },
      {
        "type": "movie",
        "title": "Rugrats in Paris: The Movie",
        "year": 2000,
        "tmdbId": 14445,
        "imdbId": "tt0213203",
        "part": 4,
        "poster": "https://images.metahub.space/poster/medium/tt0213203/img"
      },
      {
        "type": "show",
        "showName": "Rugrats",
        "tmdbId": 2403,
        "imdbId": "tt0101188",
        "seasons": [
          8,
          9
        ],
        "title": "Rugrats (Seasons 8-9)",
        "part": 5,
        "poster": "https://images.metahub.space/poster/medium/tt0101188/img"
      },
      {
        "type": "movie",
        "title": "Rugrats Go Wild",
        "year": 2003,
        "tmdbId": 15165,
        "imdbId": "tt0337711",
        "part": 6,
        "poster": "https://images.metahub.space/poster/medium/tt0337711/img"
      }
    ]
  },
  {
    "id": "movie_beavis_and_butt_head_saga",
    "name": "Beavis and Butt-Head: Complete Series & Movies",
    "franchise": "Beavis and Butt-Head",
    "category": "tvuniverses",
    "description": "Mike Judge's slacker duo across the classic MTV series, the 1996 theatrical hit Do America, the 2022 sci-fi sequel Do the Universe, and the Paramount+ revival series.",
    "episodes": [
      {
        "type": "show",
        "showName": "Beavis and Butt-Head",
        "tmdbId": 214,
        "imdbId": "tt0105950",
        "seasons": [
          1,
          2,
          3,
          4,
          5,
          6,
          7
        ],
        "title": "Beavis and Butt-Head (Original Series)",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0105950/img"
      },
      {
        "type": "movie",
        "title": "Beavis and Butt-Head Do America",
        "year": 1996,
        "tmdbId": 9989,
        "imdbId": "tt0115641",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0115641/img"
      },
      {
        "type": "movie",
        "title": "Beavis and Butt-Head Do the Universe",
        "year": 2022,
        "tmdbId": 926899,
        "imdbId": "tt14115598",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt14115598/img"
      }
    ]
  },
  {
    "id": "movie_buzz_lightyear_star_command",
    "name": "Buzz Lightyear of Star Command: Pilot & Series",
    "franchise": "Toy Story Universe",
    "category": "tvuniverses",
    "description": "The mandatory pilot movie The Adventure Begins starring Tim Allen introducing Star Command and Emperor Zurg, followed by the animated television series.",
    "episodes": [
      {
        "type": "movie",
        "title": "Buzz Lightyear of Star Command: The Adventure Begins",
        "year": 2000,
        "tmdbId": 18501,
        "imdbId": "tt0260779",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0260779/img"
      },
      {
        "type": "show",
        "showName": "Buzz Lightyear of Star Command",
        "tmdbId": 2238,
        "imdbId": "tt0260602",
        "seasons": [
          1
        ],
        "title": "Buzz Lightyear of Star Command",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0260602/img"
      }
    ]
  },
  {
    "id": "crossover_scandal_htgawm_2018",
    "name": "Scandal & How to Get Away with Murder Crossover (2018)",
    "franchise": "Shondaland TGIT Universe",
    "category": "tvuniverses",
    "description": "Olivia Pope and Annalise Keating join forces to bring a historic class-action fast-track civil rights appeal before the United States Supreme Court.",
    "episodes": [
      {
        "type": "episode",
        "showName": "Scandal",
        "season": 7,
        "episode": 12,
        "title": "Allow Me to Reintroduce Myself",
        "tmdbId": 39269,
        "imdbId": "tt7853118",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt1837576/img"
      },
      {
        "type": "episode",
        "showName": "How to Get Away with Murder",
        "season": 4,
        "episode": 13,
        "title": "Lahey v. Commonwealth of Pennsylvania",
        "tmdbId": 61056,
        "imdbId": "tt7853036",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt3205802/img"
      }
    ]
  },
  {
    "id": "crossover_simpsons_family_guy_2014",
    "name": "The Simpsons & Family Guy: The Simpsons Guy (2014)",
    "franchise": "Animation Domination",
    "category": "tvuniverses",
    "description": "The Griffins are stranded in Springfield and take refuge with Homer and Marge before Peter and Homer engage in a town-wrecking brawl over Duff vs. Pawtucket Patriot Ale.",
    "episodes": [
      {
        "type": "show",
        "showName": "The Simpsons",
        "title": "The Simpsons",
        "tmdbId": 456,
        "imdbId": "tt0096697",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0096697/img"
      },
      {
        "type": "episode",
        "showName": "Family Guy",
        "season": 13,
        "episode": 1,
        "title": "The Simpsons Guy",
        "tmdbId": 1434,
        "imdbId": "tt3061036",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0182576/img"
      }
    ]
  },
  {
    "id": "crossover_supernatural_scoobydoo_2018",
    "name": "Supernatural & Scooby-Doo: Scoobynatural (2018)",
    "franchise": "Supernatural",
    "category": "tvuniverses",
    "description": "Sam, Dean, and Castiel are sucked into a haunted television set, finding themselves animated inside the classic 1969 Scooby-Doo episode A Night of Fright Is No Delight.",
    "episodes": [
      {
        "type": "episode",
        "showName": "Scooby-Doo, Where Are You!",
        "season": 1,
        "episode": 16,
        "title": "A Night of Fright Is No Delight",
        "tmdbId": 2054,
        "imdbId": "tt0695420",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0063950/img"
      },
      {
        "type": "episode",
        "showName": "Supernatural",
        "season": 13,
        "episode": 16,
        "title": "Scoobynatural",
        "tmdbId": 1622,
        "imdbId": "tt6877202",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0460681/img"
      }
    ]
  },
  {
    "id": "crossover_xfiles_cops_2000",
    "name": "The X-Files & Cops: X-Cops (2000)",
    "franchise": "The X-Files",
    "category": "tvuniverses",
    "description": "Shot live on video by a Fox COPS camera crew, Mulder and Scully investigate a shape-shifting entity feeding on fear in Willow Park, Los Angeles.",
    "episodes": [
      {
        "type": "show",
        "showName": "Cops",
        "title": "Cops",
        "tmdbId": 2270,
        "imdbId": "tt0096563",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0096563/img"
      },
      {
        "type": "episode",
        "showName": "The X-Files",
        "season": 7,
        "episode": 12,
        "title": "X-Cops",
        "tmdbId": 4087,
        "imdbId": "tt0751259",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0106179/img"
      }
    ]
  },
  {
    "id": "crossover_suite_life_hannah_montana_2006",
    "name": "That's So Suite Life of Hannah Montana (2006)",
    "franchise": "Disney Channel Universe",
    "category": "tvuniverses",
    "description": "The 3-part Disney Channel crossover: Raven Baxter stays at the Tipton Hotel in Boston, crossing paths with Zack, Cody, and visiting pop superstar Hannah Montana.",
    "episodes": [
      {
        "type": "episode",
        "showName": "That's So Raven",
        "season": 4,
        "episode": 11,
        "title": "Checkin' Out",
        "tmdbId": 2214,
        "imdbId": "tt0836585",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0341932/img"
      },
      {
        "type": "episode",
        "showName": "The Suite Life of Zack & Cody",
        "season": 2,
        "episode": 20,
        "title": "That's So Suite Life of Hannah Montana",
        "tmdbId": 2208,
        "imdbId": "tt0836584",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0426371/img"
      },
      {
        "type": "episode",
        "showName": "Hannah Montana",
        "season": 1,
        "episode": 12,
        "title": "On the Road Again?",
        "tmdbId": 4263,
        "imdbId": "tt0836583",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt0493093/img"
      }
    ]
  },
  {
    "id": "crossover_wizards_on_deck_hannah_montana_2009",
    "name": "Wizards on Deck with Hannah Montana (2009)",
    "franchise": "Disney Channel Universe",
    "category": "tvuniverses",
    "description": "The Russo family wins an ocean cruise on the SS Tipton where Alex, Justin, and Max encounter London, Zack, and Cody before Hannah Montana boards for a concert in Hawaii.",
    "episodes": [
      {
        "type": "episode",
        "showName": "Wizards of Waverly Place",
        "season": 2,
        "episode": 25,
        "title": "Cast-Away (To Another Show)",
        "tmdbId": 2251,
        "imdbId": "tt1423851",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0799922/img"
      },
      {
        "type": "episode",
        "showName": "The Suite Life on Deck",
        "season": 1,
        "episode": 21,
        "title": "Double-Crossed",
        "tmdbId": 14120,
        "imdbId": "tt1423850",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt1230232/img"
      },
      {
        "type": "episode",
        "showName": "Hannah Montana",
        "season": 3,
        "episode": 19,
        "title": "Super(stitious) Girl",
        "tmdbId": 4263,
        "imdbId": "tt1423849",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt0493093/img"
      }
    ]
  },
  {
    "id": "crossover_jimmy_timmy_power_hour_trilogy",
    "name": "The Jimmy Timmy Power Hour Trilogy (2004–2006)",
    "franchise": "Nickelodeon Universe",
    "category": "tvuniverses",
    "description": "Jimmy Neutron's 3D CGI Retroville and Timmy Turner's 2D animated Dimmsdale collide when dimensional travel swaps the boys and unites Cosmo and Wanda with Goddard.",
    "episodes": [
      {
        "type": "movie",
        "title": "The Jimmy Timmy Power Hour",
        "year": 2004,
        "tmdbId": 32788,
        "imdbId": "tt0411545",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0411545/img"
      },
      {
        "type": "movie",
        "title": "The Jimmy Timmy Power Hour 2: When Nerds Collide!",
        "year": 2006,
        "tmdbId": 37328,
        "imdbId": "tt0811002",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0811002/img"
      },
      {
        "type": "movie",
        "title": "The Jimmy Timmy Power Hour 3: The Jerkinators!",
        "year": 2006,
        "tmdbId": 37329,
        "imdbId": "tt0846014",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt0846014/img"
      }
    ]
  },
  {
    "id": "crossover_icarly_victorious_iparty_2011",
    "name": "iCarly & Victorious: iParty with Victorious (2011)",
    "franchise": "Schneiderverse",
    "category": "tvuniverses",
    "description": "Carly and her Seattle web-show friends crash a party at Kenan Thompson's Hollywood house, teaming up with Tori Vega and Hollywood Arts students to bust a two-timing boyfriend.",
    "episodes": [
      {
        "type": "episode",
        "showName": "iCarly",
        "season": 4,
        "episode": 11,
        "title": "iParty with Victorious: Part 1",
        "tmdbId": 3624,
        "imdbId": "tt1828114",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0972534/img"
      },
      {
        "type": "episode",
        "showName": "iCarly",
        "season": 4,
        "episode": 12,
        "title": "iParty with Victorious: Part 2",
        "tmdbId": 3624,
        "imdbId": "tt1970228",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0972534/img"
      },
      {
        "type": "episode",
        "showName": "iCarly",
        "season": 4,
        "episode": 13,
        "title": "iParty with Victorious: Part 3",
        "tmdbId": 3624,
        "imdbId": "tt1970229",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt0972534/img"
      }
    ]
  },
  {
    "id": "crossover_ben10_generator_rex_2011",
    "name": "Ben 10 & Generator Rex: Heroes United (2011)",
    "franchise": "Man of Action Universe",
    "category": "tvuniverses",
    "description": "Ben Tennyson is flung through a spatial rift into Generator Rex's nanite-infested dimension, joining forces with Rex Salazar against the devastating nanite entity Alpha.",
    "episodes": [
      {
        "type": "show",
        "showName": "Ben 10: Ultimate Alien",
        "title": "Ben 10: Ultimate Alien",
        "tmdbId": 32675,
        "imdbId": "tt1627993",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt1627993/img"
      },
      {
        "type": "show",
        "showName": "Generator Rex",
        "title": "Generator Rex",
        "tmdbId": 32904,
        "imdbId": "tt1607567",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt1607567/img"
      },
      {
        "type": "movie",
        "title": "Ben 10 / Generator Rex: Heroes United",
        "year": 2011,
        "tmdbId": 82772,
        "imdbId": "tt2113645",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt2113645/img"
      }
    ]
  },
  {
    "id": "crossover_grim_adventures_knd_2007",
    "name": "The Grim Adventures of the KND (2007)",
    "franchise": "Cartoon Network Universe",
    "category": "tvuniverses",
    "description": "Billy wears his dad's cursed pants and accidentally fuses with the Delightful Children From Down the Lane, forcing Sector V and Mandy into a dimensional showdown with the Grim Reaper.",
    "episodes": [
      {
        "type": "show",
        "showName": "The Grim Adventures of Billy & Mandy",
        "title": "The Grim Adventures of Billy & Mandy",
        "tmdbId": 2503,
        "imdbId": "tt0292802",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0292802/img"
      },
      {
        "type": "show",
        "showName": "Codename: Kids Next Door",
        "title": "Codename: Kids Next Door",
        "tmdbId": 2420,
        "imdbId": "tt0312109",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0312109/img"
      },
      {
        "type": "movie",
        "title": "The Grim Adventures of the KND",
        "year": 2007,
        "tmdbId": 44976,
        "imdbId": "tt1143139",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt1143139/img"
      }
    ]
  },
  {
    "id": "movie_dragon_ball_super_canon_films",
    "name": "Dragon Ball Super: Canon Continuation Films",
    "franchise": "Dragon Ball",
    "category": "tvuniverses",
    "description": "The official canon storyline of Dragon Ball Super: the 131-episode anime series, followed by Akira Toriyama's blockbuster films DBS: Broly and DBS: Super Hero.",
    "episodes": [
      {
        "type": "show",
        "showName": "Dragon Ball Super",
        "tmdbId": 62715,
        "imdbId": "tt4644488",
        "seasons": [
          1
        ],
        "title": "Dragon Ball Super",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt4644488/img"
      },
      {
        "type": "movie",
        "title": "Dragon Ball Super: Broly",
        "year": 2018,
        "tmdbId": 503314,
        "imdbId": "tt7961060",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt7961060/img"
      },
      {
        "type": "movie",
        "title": "Dragon Ball Super: Super Hero",
        "year": 2022,
        "tmdbId": 610150,
        "imdbId": "tt14614892",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt14614892/img"
      }
    ]
  },
  {
    "id": "movie_made_in_abyss_dawn_deep_soul",
    "name": "Made in Abyss: Complete Canon Chronology",
    "franchise": "Made in Abyss",
    "category": "tvuniverses",
    "description": "Dawn of the Deep Soul (2020) is the essential canon bridge between Season 1 and Season 2: Riko, Reg, and Nanachi descend into the Fifth Layer to confront Sovereign of Dawn Bondrewd.",
    "episodes": [
      {
        "type": "show",
        "showName": "Made in Abyss",
        "tmdbId": 72636,
        "imdbId": "tt7222086",
        "seasons": [
          1
        ],
        "title": "Made in Abyss (Season 1)",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt7222086/img"
      },
      {
        "type": "movie",
        "title": "Made in Abyss: Dawn of the Deep Soul",
        "year": 2020,
        "tmdbId": 569094,
        "imdbId": "tt10609594",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt10609594/img"
      },
      {
        "type": "show",
        "showName": "Made in Abyss",
        "tmdbId": 72636,
        "imdbId": "tt7222086",
        "seasons": [
          2
        ],
        "title": "Made in Abyss: The Golden City of the Scorching Sun (Season 2)",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt7222086/img"
      }
    ]
  },
  {
    "id": "movie_konosuba_legend_of_crimson",
    "name": "KonoSuba: Complete Storyline & Legend of Crimson",
    "franchise": "KonoSuba",
    "category": "tvuniverses",
    "description": "Legend of Crimson (2019) is the essential canon bridge between Seasons 2 and 3, sending Kazuma and party to Megumin's Crimson Demon village to battle Sylvia.",
    "episodes": [
      {
        "type": "show",
        "showName": "KonoSuba: God's Blessing on This Wonderful World!",
        "tmdbId": 65942,
        "imdbId": "tt5312384",
        "seasons": [
          1,
          2
        ],
        "title": "KonoSuba (Seasons 1-2)",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt5312384/img"
      },
      {
        "type": "movie",
        "title": "KonoSuba: God's Blessing on this Wonderful World! Legend of Crimson",
        "year": 2019,
        "tmdbId": 546554,
        "imdbId": "tt8600494",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt8600494/img"
      },
      {
        "type": "show",
        "showName": "KonoSuba: God's Blessing on This Wonderful World!",
        "tmdbId": 65942,
        "imdbId": "tt5312384",
        "seasons": [
          3
        ],
        "title": "KonoSuba (Season 3)",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt5312384/img"
      }
    ]
  },
  {
    "id": "movie_sao_ordinal_scale_canon",
    "name": "Sword Art Online: Complete Chronology & Ordinal Scale",
    "franchise": "Sword Art Online",
    "category": "tvuniverses",
    "description": "Ordinal Scale (2017) is the canon feature film set between Season 2 and Season 3 (Alicization), introducing the Augma augmented-reality device and the AI Yuna.",
    "episodes": [
      {
        "type": "show",
        "showName": "Sword Art Online",
        "tmdbId": 45782,
        "imdbId": "tt2250192",
        "seasons": [
          1,
          2
        ],
        "title": "Sword Art Online (Seasons 1-2)",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt2250192/img"
      },
      {
        "type": "movie",
        "title": "Sword Art Online: Ordinal Scale",
        "year": 2017,
        "tmdbId": 417870,
        "imdbId": "tt5540962",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt5540962/img"
      },
      {
        "type": "show",
        "showName": "Sword Art Online",
        "tmdbId": 45782,
        "imdbId": "tt2250192",
        "seasons": [
          3
        ],
        "title": "Sword Art Online: Alicization (Season 3)",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt2250192/img"
      }
    ]
  },
  {
    "id": "movie_rascal_does_not_dream_chronology",
    "name": "Rascal Does Not Dream: Complete Canon Timeline",
    "franchise": "Rascal Does Not Dream",
    "category": "tvuniverses",
    "description": "Hajime Kamoshida's Puberty Syndrome romance in canon order: Bunny Girl Senpai (Season 1), Dreaming Girl (2019), Sister Venturing Out (2023), and Knapsack Kid (2023).",
    "episodes": [
      {
        "type": "show",
        "showName": "Rascal Does Not Dream of Bunny Girl Senpai",
        "tmdbId": 82700,
        "imdbId": "tt8993202",
        "seasons": [
          1
        ],
        "title": "Rascal Does Not Dream of Bunny Girl Senpai (Season 1)",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt8993202/img"
      },
      {
        "type": "movie",
        "title": "Rascal Does Not Dream of a Dreaming Girl",
        "year": 2019,
        "tmdbId": 572164,
        "imdbId": "tt9811444",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt9811444/img"
      },
      {
        "type": "movie",
        "title": "Rascal Does Not Dream of a Sister Venturing Out",
        "year": 2023,
        "tmdbId": 1058694,
        "imdbId": "tt24151752",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt24151752/img"
      },
      {
        "type": "movie",
        "title": "Rascal Does Not Dream of a Knapsack Kid",
        "year": 2023,
        "tmdbId": 1142996,
        "imdbId": "tt28083818",
        "part": 4,
        "poster": "https://images.metahub.space/poster/medium/tt28083818/img"
      }
    ]
  },
  {
    "id": "movie_steins_gate_complete_timeline",
    "name": "Steins;Gate: Complete Chronology & Deja Vu",
    "franchise": "Science Adventure",
    "category": "tvuniverses",
    "description": "Rintaro Okabe's world-line travels: the original 2011 anime series, the canon epilogue film Load Region of Déjà Vu, and the alternate dark worldline series Steins;Gate 0.",
    "episodes": [
      {
        "type": "show",
        "showName": "Steins;Gate",
        "tmdbId": 39483,
        "imdbId": "tt1910272",
        "seasons": [
          1
        ],
        "title": "Steins;Gate",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt1910272/img"
      },
      {
        "type": "movie",
        "title": "Steins;Gate: The Movie − Load Region of Déjà Vu",
        "year": 2013,
        "tmdbId": 198539,
        "imdbId": "tt2380549",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt2380549/img"
      },
      {
        "type": "show",
        "showName": "Steins;Gate 0",
        "tmdbId": 77696,
        "imdbId": "tt4955642",
        "seasons": [
          1
        ],
        "title": "Steins;Gate 0",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt4955642/img"
      }
    ]
  },
  {
    "id": "movie_haruhi_suzumiya_disappearance",
    "name": "The Melancholy & Disappearance of Haruhi Suzumiya",
    "franchise": "Haruhi Suzumiya",
    "category": "tvuniverses",
    "description": "Kyoto Animation's beloved supernatural slice-of-life: both seasons of the SOS Brigade followed by the celebrated 2-hour 42-minute theatrical masterpiece The Disappearance of Haruhi Suzumiya.",
    "episodes": [
      {
        "type": "show",
        "showName": "The Melancholy of Haruhi Suzumiya",
        "tmdbId": 46440,
        "imdbId": "tt0816247",
        "seasons": [
          1,
          2
        ],
        "title": "The Melancholy of Haruhi Suzumiya",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0816247/img"
      },
      {
        "type": "movie",
        "title": "The Disappearance of Haruhi Suzumiya",
        "year": 2010,
        "tmdbId": 38411,
        "imdbId": "tt1572306",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt1572306/img"
      }
    ]
  },
  {
    "id": "movie_haikyu_dumpster_battle",
    "name": "Haikyu!! & The Dumpster Battle",
    "franchise": "Haikyu!!",
    "category": "tvuniverses",
    "description": "Karasuno High's volleyball journey across all four seasons, directly continuing into the long-awaited canon showdown film Haikyu!! The Dumpster Battle against Nekoma High.",
    "episodes": [
      {
        "type": "show",
        "showName": "Haikyu!!",
        "tmdbId": 60863,
        "imdbId": "tt3396540",
        "seasons": [
          1,
          2,
          3,
          4
        ],
        "title": "Haikyu!! (Seasons 1-4)",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt3396540/img"
      },
      {
        "type": "movie",
        "title": "Haikyu!! The Dumpster Battle",
        "year": 2024,
        "tmdbId": 1012201,
        "imdbId": "tt21822882",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt21822882/img"
      }
    ]
  },
  {
    "id": "movie_quintuplets_complete_finale",
    "name": "The Quintessential Quintuplets: Complete Saga & Film",
    "franchise": "The Quintessential Quintuplets",
    "category": "tvuniverses",
    "description": "Futaro Uesugi tutoring the five Nakano sisters across Seasons 1-2, concluded in the 2022 canon theatrical finale film revealing his bride.",
    "episodes": [
      {
        "type": "show",
        "showName": "The Quintessential Quintuplets",
        "tmdbId": 85349,
        "imdbId": "tt9428790",
        "seasons": [
          1,
          2
        ],
        "title": "The Quintessential Quintuplets (Seasons 1-2)",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt9428790/img"
      },
      {
        "type": "movie",
        "title": "The Quintessential Quintuplets Movie",
        "year": 2022,
        "tmdbId": 828613,
        "imdbId": "tt14332468",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt14332468/img"
      }
    ]
  },
  {
    "id": "movie_cowboy_bebop_knockin_on_heavens_door",
    "name": "Cowboy Bebop & Knockin' on Heaven's Door",
    "franchise": "Cowboy Bebop",
    "category": "tvuniverses",
    "description": "Shinichiro Watanabe's legendary jazz-space-western series, featuring the 2001 canon interquel film Knockin' on Heaven's Door set before the two-part finale.",
    "episodes": [
      {
        "type": "show",
        "showName": "Cowboy Bebop",
        "tmdbId": 30991,
        "imdbId": "tt0213338",
        "seasons": [
          1
        ],
        "title": "Cowboy Bebop (Episodes 1-22)",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0213338/img"
      },
      {
        "type": "movie",
        "title": "Cowboy Bebop: Knockin' on Heaven's Door",
        "year": 2001,
        "tmdbId": 11299,
        "imdbId": "tt0275277",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0275277/img"
      },
      {
        "type": "show",
        "showName": "Cowboy Bebop",
        "tmdbId": 30991,
        "imdbId": "tt0213338",
        "seasons": [
          1
        ],
        "title": "Cowboy Bebop (Episodes 23-26)",
        "part": 3,
        "poster": "https://images.metahub.space/poster/medium/tt0213338/img"
      }
    ]
  },
  {
    "id": "movie_fullmetal_alchemist_2003_shamballa",
    "name": "Fullmetal Alchemist (2003) & Conqueror of Shamballa",
    "franchise": "Fullmetal Alchemist",
    "category": "tvuniverses",
    "description": "The original 2003 Fullmetal Alchemist anime series, concluded directly by the 2005 theatrical feature film Conqueror of Shamballa.",
    "episodes": [
      {
        "type": "show",
        "showName": "Fullmetal Alchemist",
        "tmdbId": 31911,
        "imdbId": "tt0421357",
        "seasons": [
          1
        ],
        "title": "Fullmetal Alchemist (2003)",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0421357/img"
      },
      {
        "type": "movie",
        "title": "Fullmetal Alchemist the Movie: Conqueror of Shamballa",
        "year": 2005,
        "tmdbId": 20914,
        "imdbId": "tt0456434",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt0456434/img"
      }
    ]
  },
  {
    "id": "movie_gintama_very_final",
    "name": "Gintama: Complete Saga & The Very Final",
    "franchise": "Gintama",
    "category": "tvuniverses",
    "description": "Gintoki Sakata and the Odd Jobs crew across 367 episodes of sci-fi samurai comedy, concluding in the definitive 2021 feature film Gintama: The Very Final.",
    "episodes": [
      {
        "type": "show",
        "showName": "Gintama",
        "tmdbId": 57243,
        "imdbId": "tt0988818",
        "seasons": [
          1
        ],
        "title": "Gintama (Complete Series)",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt0988818/img"
      },
      {
        "type": "movie",
        "title": "Gintama: The Very Final",
        "year": 2021,
        "tmdbId": 635302,
        "imdbId": "tt11488582",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt11488582/img"
      }
    ]
  },
  {
    "id": "movie_no_game_no_life_zero",
    "name": "No Game No Life & No Game No Life: Zero",
    "franchise": "No Game No Life",
    "category": "tvuniverses",
    "description": "The Disboard gaming universe: the 2017 theatrical prequel film Zero depicting the Great War 6,000 years prior, followed by the TV series with Sora and Shiro.",
    "episodes": [
      {
        "type": "movie",
        "title": "No Game No Life: Zero",
        "year": 2017,
        "tmdbId": 441130,
        "imdbId": "tt6677944",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt6677944/img"
      },
      {
        "type": "show",
        "showName": "No Game No Life",
        "tmdbId": 61491,
        "imdbId": "tt3645068",
        "seasons": [
          1
        ],
        "title": "No Game No Life",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt3645068/img"
      }
    ]
  },
  {
    "id": "crossover_isekai_quartet_universe",
    "name": "Isekai Quartet: Multiverse Crossover & Movie",
    "franchise": "Kadokawa Isekai Multiverse",
    "category": "tvuniverses",
    "description": "Characters from KonoSuba, Overlord, Re:Zero, and The Saga of Tanya the Evil are transported via red button to a chibi high-school world across Seasons 1-2 and the 2022 movie.",
    "episodes": [
      {
        "type": "show",
        "showName": "Isekai Quartet",
        "tmdbId": 87910,
        "imdbId": "tt9173000",
        "seasons": [
          1,
          2
        ],
        "title": "Isekai Quartet (Seasons 1-2)",
        "part": 1,
        "poster": "https://images.metahub.space/poster/medium/tt9173000/img"
      },
      {
        "type": "movie",
        "title": "Isekai Quartet: The Movie - Another World",
        "year": 2022,
        "tmdbId": 849202,
        "imdbId": "tt14991478",
        "part": 2,
        "poster": "https://images.metahub.space/poster/medium/tt14991478/img"
      }
    ]
  }
];
if (typeof window !== 'undefined') window.TV_CROSSOVER_EVENTS = TV_CROSSOVER_EVENTS;

function isCrossoverEpisodeMatch(item, epTarget) {
  if (!item || !epTarget) return false;
  if (epTarget.type === 'movie') {
    if (item.kind !== 'movie' && item.type !== 'movie') return false;
    if (epTarget.imdbId && item.imdbId && epTarget.imdbId === item.imdbId) return true;
    if (epTarget.tmdbId && item.tmdbId && String(epTarget.tmdbId) === String(item.tmdbId)) return true;
    const targetTitle = String(epTarget.title || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    const itemTitle = String(item.title || item.showName || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!targetTitle || !itemTitle) return false;
    return targetTitle === itemTitle;
  }

  if (item.kind === 'movie' || item.type === 'movie') return false;
  const sNum = (item.seasonNum != null) ? Number(item.seasonNum) : Number(item.season);
  const eNum = (item.episodeNum != null) ? Number(item.episodeNum) : Number(item.episode);

  if (epTarget.tmdbId && item.tmdbId && String(epTarget.tmdbId) === String(item.tmdbId)) {
    if (Array.isArray(epTarget.seasons)) {
      return isNaN(sNum) || epTarget.seasons.includes(sNum);
    }
    if (epTarget.season != null && epTarget.episode != null && epTarget.episode !== 'all') {
      return sNum === Number(epTarget.season) && eNum === Number(epTarget.episode);
    }
    if (epTarget.season != null && epTarget.season !== 'all') {
      return isNaN(sNum) || sNum === Number(epTarget.season);
    }
    return true;
  }

  if (epTarget.imdbId && item.imdbId && epTarget.imdbId === item.imdbId) {
    if (Array.isArray(epTarget.seasons)) {
      return isNaN(sNum) || epTarget.seasons.includes(sNum);
    }
    if (epTarget.season != null && epTarget.episode != null && epTarget.episode !== 'all') {
      return sNum === Number(epTarget.season) && eNum === Number(epTarget.episode);
    }
    if (epTarget.season != null && epTarget.season !== 'all') {
      return isNaN(sNum) || sNum === Number(epTarget.season);
    }
    return true;
  }

  const targetName = String(epTarget.showName || epTarget.title || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const itemShowName = String(item.showName || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!targetName || !itemShowName) return false;

  const nameMatch = (itemShowName === targetName) ||
    (targetName.length >= 5 && itemShowName.startsWith(targetName)) ||
    (itemShowName.length >= 5 && targetName.startsWith(itemShowName));
  if (!nameMatch) return false;

  if (Array.isArray(epTarget.seasons)) {
    return isNaN(sNum) || epTarget.seasons.includes(sNum);
  }
  return true;
}

function renderChannelCrossoverSuggestions() {
  const container = document.getElementById('channelCrossoverSuggestions');
  if (!container) return;

  if (!channelDraftItems.length) {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }

  const suggestions = [];

  TV_CROSSOVER_EVENTS.forEach((event) => {
    if (event.noCrossoverSuggestion) return;
    const presentParts = [];
    const missingParts = [];

    event.episodes.forEach((ep) => {
      const match = channelDraftItems.find((it) => isCrossoverEpisodeMatch(it, ep));
      if (match) {
        presentParts.push({ ...ep, draftItem: match });
      } else {
        missingParts.push(ep);
      }
    });

    if (presentParts.length > 0 && missingParts.length > 0) {
      suggestions.push({
        event,
        presentParts,
        missingParts
      });
    }
  });

  if (!suggestions.length) {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }

  container.style.display = 'block';

  const bannersHtml = suggestions.map(({ event, presentParts, missingParts }) => {
    const chipsHtml = event.episodes.map((ep) => {
      const isPresent = presentParts.some((p) => p.part === ep.part);
      const isMovie = ep.type === 'movie';
      let label = '';
      if (isMovie) {
        label = 'Part ' + ep.part + ' (Movie): ' + ep.title + (ep.year ? ' (' + ep.year + ')' : '');
      } else if (Array.isArray(ep.seasons)) {
        label = 'Part ' + ep.part + ': ' + ep.showName + ' (Seasons ' + ep.seasons[0] + '-' + ep.seasons[ep.seasons.length - 1] + ')';
      } else if (ep.season != null && ep.episode != null && ep.episode !== 'all') {
        label = 'Part ' + ep.part + ': ' + ep.showName + ' S' + ep.season + 'E' + ep.episode;
      } else if (ep.season != null && ep.season !== 'all') {
        label = 'Part ' + ep.part + ': ' + ep.showName + ' Season ' + ep.season;
      } else {
        label = 'Part ' + ep.part + ': ' + (ep.showName || ep.title);
      }
      if (isPresent) {
        return '<span class="channel-crossover-chip present" title="Already in channel draft">' +
          '\u2713 ' + escapeHtml(label) +
        '</span>';
      }
      return '<span class="channel-crossover-chip missing" title="Missing from channel draft">' +
        '+ ' + escapeHtml(label) +
      '</span>';
    }).join('');

    const missingCount = missingParts.length;
    const hasMovieMissing = missingParts.some((p) => p.type === 'movie');
    const hasEpMissing = missingParts.some((p) => p.type !== 'movie');
    let itemTypeLabel = 'Crossover Part' + (missingCount === 1 ? '' : 's');
    if (hasMovieMissing && !hasEpMissing) itemTypeLabel = 'Movie Continuation' + (missingCount === 1 ? '' : 's');
    else if (!hasMovieMissing && hasEpMissing) itemTypeLabel = 'Crossover Episode' + (missingCount === 1 ? '' : 's');
    const btnLabel = '+ Add ' + missingCount + ' Missing ' + itemTypeLabel + ' in Story Order';

    const isMovieEvent = event.id.startsWith('movie_');
    const tagLabel = isMovieEvent ? 'Movie Continuation' : 'Crossover Event';

    return '<div class="channel-crossover-banner" data-event-id="' + escapeAttr(event.id) + '">' +
      '<div class="channel-crossover-header">' +
        '<div class="channel-crossover-title">' +
          '<span>' + tagLabel + ' Detected: <strong>' + escapeHtml(event.name) + '</strong></span>' +
          '<span class="channel-crossover-badge">' + escapeHtml(event.franchise) + '</span>' +
        '</div>' +
      '</div>' +
      '<p class="channel-crossover-desc">' + escapeHtml(event.description) + '</p>' +
      '<div class="channel-crossover-parts">' + chipsHtml + '</div>' +
      '<div class="channel-crossover-actions">' +
        '<button type="button" class="primary lc-btn" onclick="spliceCrossoverEvent(&quot;' + escapeJsAttr(event.id) + '&quot;, this)" style="padding:6px 14px; font-size:0.82rem;">' + escapeHtml(btnLabel) + '</button>' +
      '</div>' +
    '</div>';
  }).join('');

  container.innerHTML = bannersHtml;
}

async function spliceCrossoverEvent(eventId, btn) {
  const event = TV_CROSSOVER_EVENTS.find((e) => e.id === eventId);
  if (!event) return;

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Fetching story items\u2026';
  }

  try {
    let firstIdx = -1;
    for (let i = 0; i < channelDraftItems.length; i++) {
      if (event.episodes.some((ep) => isCrossoverEpisodeMatch(channelDraftItems[i], ep))) {
        firstIdx = i;
        break;
      }
    }
    if (firstIdx === -1) firstIdx = channelDraftItems.length;

    const { items: fullOrderedItems } = await fetchStorylineOrderedItems(eventId);
    if (!fullOrderedItems || !fullOrderedItems.length) {
      throw new Error('No items returned for this storyline.');
    }

    channelDraftItems = channelDraftItems.filter((it) => !event.episodes.some((ep) => isCrossoverEpisodeMatch(it, ep)));

    const insertPos = Math.min(firstIdx, channelDraftItems.length);
    channelDraftItems.splice(insertPos, 0, ...fullOrderedItems);

    if (channelDraftItems.length > CHANNEL_MAX_TOTAL_ITEMS) {
      channelDraftItems = channelDraftItems.slice(0, CHANNEL_MAX_TOTAL_ITEMS);
    }

    renderChannelDraftList();
    if (typeof showAddedToast === 'function') {
      showAddedToast('Added items for "' + event.name + '" in story order!');
    }
  } catch (err) {
    if (typeof showAppAlert === 'function') {
      showAppAlert('Crossover Splicer', 'Could not add crossover items: ' + (err.message || err));
    } else {
      alert('Could not add crossover items: ' + (err.message || err));
    }
  }
  if (btn) {
    btn.disabled = false;
    btn.textContent = '+ Add Missing in Story Order';
  }
}

function removeAllChannelDraftPicks() {
  if (!channelDraftItems.length) return;
  const wipe = () => {
    channelDraftItems = [];
    channelDraftSelection = [];
    channelDraftFilter = '';
    const filterInput = document.getElementById('channelDraftFilterInput');
    if (filterInput) filterInput.value = '';
    renderChannelDraftList();
  };
  const message = 'Remove all ' + channelDraftItems.length + ' picks? This cannot be undone.';
  if (typeof showAppConfirm === 'function') showAppConfirm('Remove all picks', message, 'Remove All', wipe, true);
  else wipe();
}

document.getElementById('channelDraftList').addEventListener('click', (e) => {
  const removeBtn = e.target.closest('.channelRemovePickBtn');
  if (removeBtn) {
    const row = removeBtn.closest('.channel-pick');
    const idx = parseInt(row.dataset.idx, 10);
    channelDraftItems.splice(idx, 1);
    renderChannelDraftList();
    return;
  }
  // While selecting, the whole card is the checkbox -- a 20px box is not a
  // target anyone wants to hit forty times in a row on a phone. The
  // checkbox's own click is left alone so it is not toggled twice.
  if (channelDraftSelectMode && !e.target.closest('.channelPickCheck')) {
    const card = e.target.closest('.channel-pick');
    if (card) {
      const idx = parseInt(card.dataset.idx, 10);
      toggleChannelDraftPick(idx, !isChannelDraftSelected(idx));
      renderChannelDraftList();
    }
  }
});

document.getElementById('channelDraftList').addEventListener('change', (e) => {
  const check = e.target.closest('.channelPickCheck');
  if (!check) return;
  toggleChannelDraftPick(parseInt(check.dataset.idx, 10), check.checked);
  renderChannelDraftList();
});

document.getElementById('channelDraftList').addEventListener('change', (e) => {
  const posInput = e.target.closest('.channelPosInput');
  if (!posInput) return;
  const row = posInput.closest('.channel-pick');
  const from = parseInt(row.dataset.idx, 10);
  const typed = parseInt(posInput.value, 10);
  if (!typed || isNaN(typed)) {
    renderChannelDraftList();
    return;
  }
  const to = Math.min(Math.max(typed, 1), channelDraftItems.length) - 1;
  if (to === from) {
    renderChannelDraftList();
    return;
  }
  clearChannelDraftAutoSort();
  const [item] = channelDraftItems.splice(from, 1);
  channelDraftItems.splice(to, 0, item);
  renderChannelDraftList();
});

let channelHoldDragBound = false;

function initChannelHoldDrag() {
  const container = document.getElementById('channelDraftList');
  if (!container || channelHoldDragBound) return;
  channelHoldDragBound = true;

  createSortableList(container, {
    itemSelector: '.channel-pick',
    handleSelector: '',
    axis: 'xy',
    holdDelay: 120,
    canDrag: () => !channelDraftSelectMode,
    onReorder: reorderChannelDraftFromDom
  });
}

function getChannelDragAfterElement(container, x, y) {
  const els = [...container.querySelectorAll('.channel-pick:not(.dragging)')];
  if (!els.length) return null;

  for (const child of els) {
    const box = child.getBoundingClientRect();
    if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) {
      return child;
    }
  }

  let closest = null;
  let closestDistance = Infinity;
  for (const child of els) {
    const box = child.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const dist = Math.hypot(x - cx, y - cy);
    if (dist < closestDistance) {
      closestDistance = dist;
      closest = child;
    }
  }
  return closest;
}

// Rebuilds the draft order from the cards on screen after a drag.
//
// Only the cards ON SCREEN, which is the whole difficulty: with a filter
// active those are a SUBSET, and rebuilding the list from them would drop
// every pick the filter is hiding -- silently, irreversibly, on one
// accidental drag of a channel someone spent an evening assembling.
//
// So the drag permutes the picks among the SLOTS they already occupied in
// the full list, and everything else stays exactly where it is. With no
// filter the slots are 0..N-1 and this is the plain reorder it always was.
function reorderChannelDraftFromDom() {
  const container = document.getElementById('channelDraftList');
  const rows = [...container.querySelectorAll('.channel-pick')];
  if (rows.length) {
    const order = rows
      .map((row) => parseInt(row.dataset.idx, 10))
      .filter((n) => Number.isInteger(n) && n >= 0 && n < channelDraftItems.length);
    if (order.length) {
      clearChannelDraftAutoSort();
      const slots = order.slice().sort((a, b) => a - b);
      const next = channelDraftItems.slice();
      order.forEach((fromIdx, n) => { next[slots[n]] = channelDraftItems[fromIdx]; });
      channelDraftItems = next;
    }
  }
  renderChannelDraftList();
}

// --- play order ---------------------------------------------------------
//
// One dropdown, and almost every entry in it is an ACTION rather than a
// mode: picking "Air date -- oldest first" reorders the picks then and
// there, and what is saved is that order. So the list on screen is always
// the list that plays, and moving a pick by hand afterwards simply stays
// moved -- which is what the old "Sort by air date" checkbox could not do,
// because it re-sorted at serve time and silently overrode every manual
// move.
//
// Two entries are not one-shot sorts:
//  - "Shuffle daily" is the one real MODE left (the payload's shuffle
//    flag): the Worker reshuffles from a date-based seed on every request,
//    so no stored order could express it and the list order is ignored
//    while it is on.
//  - "Shuffle now" is a one-shot like the sorts, and leaves the dropdown on
//    "As listed" -- there is no arrangement to keep re-applying.
//
// A static sort is also REMEMBERED, as the payload's autoSort field, and
// re-applied whenever picks are added later (see applyChannelDraftAutoSort)
// so an air-date channel stays in air-date order as it grows. Moving a pick
// by hand disarms that and puts the dropdown back to "As listed": from then
// on the order is the person's, not the sort's.
const CHANNEL_STATIC_SORTS = ['aired-asc', 'aired-desc', 'show-season-episode', 'interleave', 'title-az'];

const CHANNEL_PLAY_ORDER_HINTS = {
  'as-listed': 'Picks play in the order listed above \u2014 drag one, or type a new position, to change it.',
  'shuffle-daily': 'The channel reshuffles itself once every 24 hours, so the order listed above is ignored while this is selected.',
  'sorted': 'Sorted now, and sorted again whenever you add more picks. Move a pick by hand and this switches back to "As listed", keeping your order.',
  'interleave': 'One episode from each show in turn, then round again \u2014 a prime-time block rather than fifty episodes of one show before the next one starts. Re-applied whenever you add more picks.',
};

const CHANNEL_SORT_LABELS = {
  'aired-asc': 'air date order',
  'aired-desc': 'newest aired first',
  'show-season-episode': 'by show, season & episode',
  'interleave': 'interleaved across shows',
  'title-az': 'A\u2013Z by title',
};

// How a saved channel plays, in a few words, or '' when it is simply the
// order its picks are listed in. sortByAired is the pre-dropdown flag the
// Worker still honours for a channel nobody has edited since.
function channelPlayOrderLabel(ch) {
  if (!ch) return '';
  if (ch.shuffle) return 'shuffled daily';
  if (ch.autoSort && CHANNEL_SORT_LABELS[ch.autoSort]) return CHANNEL_SORT_LABELS[ch.autoSort];
  if (ch.sortByAired) return CHANNEL_SORT_LABELS['aired-asc'];
  return '';
}

function getChannelPlayOrder() {
  const sel = document.getElementById('channelPlayOrderSelect');
  const v = sel && sel.value ? sel.value : 'as-listed';
  return v === 'shuffle-now' ? 'as-listed' : v;
}

function updateChannelPlayOrderHint() {
  const hint = document.getElementById('channelPlayOrderHint');
  if (!hint) return;
  const v = getChannelPlayOrder();
  const key = v === 'shuffle-daily' ? 'shuffle-daily'
    : (v === 'interleave' ? 'interleave'
      : (CHANNEL_STATIC_SORTS.indexOf(v) !== -1 ? 'sorted' : 'as-listed'));
  hint.textContent = CHANNEL_PLAY_ORDER_HINTS[key];
}

function setChannelPlayOrder(value) {
  const sel = document.getElementById('channelPlayOrderSelect');
  const v = value || 'as-listed';
  if (sel) sel.value = v;
  updateChannelPlayOrderHint();
  updateChannelPlayOrderDependants();
}

// The static sort to re-apply when picks are added, or '' when there is
// none -- "As listed" and "Shuffle daily" both leave the order alone.
function channelDraftAutoSortKey() {
  const v = getChannelPlayOrder();
  return CHANNEL_STATIC_SORTS.indexOf(v) !== -1 ? v : '';
}

// Every manual reorder path calls this BEFORE it re-renders: the re-render
// is what re-applies a remembered sort (see applyChannelDraftAutoSort), so
// disarming first is what lets a hand-moved pick stay where it was put.
function clearChannelDraftAutoSort() {
  if (channelDraftAutoSortKey()) setChannelPlayOrder('as-listed');
}

function channelSortComparator(key) {
  if (key === 'aired-asc' || key === 'aired-desc') {
    const dir = key === 'aired-desc' ? -1 : 1;
    return (a, b) => {
      const da = channelItemAiredDateClient(a.it);
      const db = channelItemAiredDateClient(b.it);
      if (da === db) return a.i - b.i;
      // Undated last in BOTH directions: "newest first" is still no reason
      // to open a channel with the picks we could not place at all.
      if (!da) return 1;
      if (!db) return -1;
      return (da < db ? -1 : 1) * dir;
    };
  }
  if (key === 'interleave') {
    // Round-robin: every show's first pick, then every show's second, and
    // so on. Expressed as a comparator because that is what the rest of
    // this machinery speaks -- runIndex is a pick's position within its
    // OWN show's run, so ordering by it groups the lineup into rounds, and
    // showRank keeps each round in the order the shows first appear.
    // Neither rank reorders a show against itself, so a show's episodes
    // stay in the order they were added.
    return (a, b) => {
      if (a.runIndex !== b.runIndex) return a.runIndex - b.runIndex;
      if (a.showRank !== b.showRank) return a.showRank - b.showRank;
      return a.i - b.i;
    };
  }
  if (key === 'show-season-episode') {
    // Shows keep the order they first appear in, so this groups a channel
    // back into runs of each show without also reshuffling which show opens
    // it. Within a show it is plain broadcast order.
    return (a, b) => {
      if (a.showRank !== b.showRank) return a.showRank - b.showRank;
      const sa = Number(a.it.season); const sb = Number(b.it.season);
      if (sa !== sb) return (isNaN(sa) ? 0 : sa) - (isNaN(sb) ? 0 : sb);
      const ea = Number(a.it.episode); const eb = Number(b.it.episode);
      if (ea !== eb) return (isNaN(ea) ? 0 : ea) - (isNaN(eb) ? 0 : eb);
      return a.i - b.i;
    };
  }
  return (a, b) => {
    const na = String(a.it.showName || a.it.title || '').toLowerCase();
    const nb = String(b.it.showName || b.it.title || '').toLowerCase();
    if (na !== nb) return na < nb ? -1 : 1;
    const sa = Number(a.it.season); const sb = Number(b.it.season);
    if (sa !== sb) return (isNaN(sa) ? 0 : sa) - (isNaN(sb) ? 0 : sb);
    const ea = Number(a.it.episode); const eb = Number(b.it.episode);
    if (ea !== eb) return (isNaN(ea) ? 0 : ea) - (isNaN(eb) ? 0 : eb);
    return a.i - b.i;
  };
}

// Sorts channelDraftItems in place-ish. Every comparator falls back to the
// item's current index, so a tie -- two episodes aired the same night, a
// whole season dropped on one day, anything undated -- keeps the order it
// is already in rather than jumping around on each re-sort.
function sortChannelDraftItems(key) {
  if (!key || channelDraftItems.length < 2) return;
  const showRanks = new Map();
  const runLengths = new Map();
  const wrapped = channelDraftItems.map((it, i) => {
    const showKey = String((it && (it.showName || it.imdbId)) || '');
    if (!showRanks.has(showKey)) showRanks.set(showKey, showRanks.size);
    const runIndex = runLengths.get(showKey) || 0;
    runLengths.set(showKey, runIndex + 1);
    return { it: it, i: i, showRank: showRanks.get(showKey), runIndex: runIndex };
  });
  wrapped.sort(channelSortComparator(key));
  channelDraftItems = wrapped.map((w) => w.it);
}

// Called by renderChannelDraftList, which is the one thing every path that
// adds picks ends with -- the episode picker, "Add every season", a movie,
// a crossover, an imported channel. Hooking it here is what keeps a sorted
// channel sorted as it grows without every one of those paths having to
// remember to re-sort.
function applyChannelDraftAutoSort() {
  sortChannelDraftItems(channelDraftAutoSortKey());
}

// The dropdown's onchange. A static sort reorders the picks and stays
// selected (so it re-applies as the channel grows); "Shuffle now" reorders
// them once and falls back to "As listed"; the other two only set state.
function applyChannelPlayOrder(value) {
  const v = value || 'as-listed';
  if (v === 'shuffle-now') {
    setChannelPlayOrder('as-listed');
    shuffleChannelDraft();
    return;
  }
  setChannelPlayOrder(v);
  const key = channelDraftAutoSortKey();
  if (key) sortChannelDraftItems(key);
  renderChannelDraftList();
}

// A channel whose play order is the listed one has nothing for Story Lock to
// protect against, and renderChannelStoryLock says so -- so the dropdown has
// to redraw it. setChannelPlayOrder is where every path through the dropdown
// meets, including the one-shot "Shuffle now" that bounces back to
// "As listed".
function updateChannelPlayOrderDependants() {
  if (typeof renderChannelStoryLock === 'function') renderChannelStoryLock();
}

function shuffleChannelDraft() {
  if (channelDraftItems.length < 2) return;
  // A one-shot, so it cannot leave a sort armed to undo it on the next
  // render.
  clearChannelDraftAutoSort();
  for (let i = channelDraftItems.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = channelDraftItems[i];
    channelDraftItems[i] = channelDraftItems[j];
    channelDraftItems[j] = tmp;
  }
  renderChannelDraftList();
}

// --- broadcast schedule & smart rules -----------------------------------
//
// Five fields that shape HOW a channel plays rather than WHAT is in it, so
// none of them ever rewrites the picks someone saved. The Worker reads all
// five (see buildChannelMeta, 05_catalog-core.js); this is the half that
// collects them and puts them back on screen when a channel is reopened.
//
//   dailyRotate + rotateShows/rotateEpisodes/rotateTurnover
//                a pool bigger than one day, cut into a fresh lineup daily
//   hideWatched  drop picks already in Watch History
//   storyLocked  shows that must advance in sequence through a shuffle
//   liveSync + sourceUrl
//                rebuild the pool from the list this was imported from
//   dynamic      no stored picks at all; derived per request (Next Up)
//
// The defaults are the numbers Quick Add's network channels have always
// rotated on, so turning the schedule on without touching a dial gives a
// custom channel exactly the cadence those already had.
const CHANNEL_DEFAULT_ROTATE_SHOWS = 24;
const CHANNEL_DEFAULT_ROTATE_EPISODES = 3;
// The Worker's CHANNEL_PART_GROUP_MAX, which is what actually enforces this;
// saying so here means the builder refuses a seventh episode rather than
// silently storing a pairing that plays as six.
const CHANNEL_DRAFT_PAIR_MAX = 6;

// The draft's own copy of the three fields that have no input of their own:
// Story Lock is a rendered list, and the last two are stamped on by whatever
// created the channel (Import from link, the Next Up button) rather than
// typed.
let channelDraftStoryLocked = [];
let channelDraftSourceUrl = '';
let channelDraftDynamic = '';
// Pairs made by hand in the draft: arrays of stream ids, the same keys the
// Worker glues by. Stored as ids rather than positions because every sort,
// filter and drag in this builder moves positions around.
let channelDraftPairedGroups = [];

// The client twin of the Worker's channelItemShowKey (05_catalog-core.js).
// Both sides have to agree on this exactly: it is the key a Story Lock is
// stored under here and looked up by there.
function channelDraftShowKey(it) {
  if (!it) return '';
  return it.imdbId || ((it.kind || 'episode') + ':' + (it.title || ''));
}

// Every field on a saved channel that this section owns, normalized. One
// function because three separate places persist a channel (saveLocalChannel,
// saveLocalChannelsMap and ensureAllChannelsSyncedFromRows) and each of them
// rebuilds the record field by field -- a flag added to only two of the three
// is a flag that silently disappears on the next save.
function channelBroadcastFields(src) {
  const o = src || {};
  return {
    description: String(o.description || '').slice(0, 400),
    dailyRotate: !!o.dailyRotate,
    rotateShows: Number(o.rotateShows) || 0,
    rotateEpisodes: Number(o.rotateEpisodes) || 0,
    rotateTurnover: Number(o.rotateTurnover) || 0,
    rotateTurnoverTime: o.rotateTurnoverTime || '',
    rotateTurnoverZone: o.rotateTurnoverZone === 'local' ? 'local' : 'utc',
    hideWatched: !!o.hideWatched,
    storyLocked: Array.isArray(o.storyLocked) ? o.storyLocked.slice() : [],
    pairParts: !!o.pairParts,
    pairedGroups: Array.isArray(o.pairedGroups)
      ? o.pairedGroups.filter((g) => Array.isArray(g) && g.length > 1).map((g) => g.slice())
      : [],
    autoNewEpisodes: !!o.autoNewEpisodes,
    newEpisodesAtTop: !!o.newEpisodesAtTop,
    liveSync: !!o.liveSync,
    sourceUrl: o.sourceUrl || '',
    dynamic: o.dynamic || '',
  };
}

// "HH:MM" in the chosen zone -> minutes past midnight UTC, which is the only
// form the Worker stores.
//
// getTimezoneOffset() is minutes to ADD to local time to get UTC (300 in
// UTC-5), so local midnight is 05:00 UTC there. It is read at save time and
// baked in, so a channel set to local midnight drifts by an hour across a
// DST boundary until it is saved again -- worth it to keep the Worker free
// of timezone databases, and an hour's drift on when tomorrow's lineup
// appears is not something a viewer can act on anyway.
function channelTurnoverToUtcMinutes(timeStr, zone) {
  const m = String(timeStr || '').match(/^([0-9]{1,2}):([0-9]{2})$/);
  const local = m ? (Math.min(23, parseInt(m[1], 10)) * 60 + Math.min(59, parseInt(m[2], 10))) : 0;
  const shift = zone === 'local' ? new Date().getTimezoneOffset() : 0;
  return (((local + shift) % 1440) + 1440) % 1440;
}

function channelMinutesToTimeString(minutes) {
  const total = (((Number(minutes) || 0) % 1440) + 1440) % 1440;
  const h = Math.floor(total / 60);
  const mm = total % 60;
  return (h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm;
}

// The distinct shows in the draft, each with the picks that belong to it --
// what Story Lock offers, and what the "N shows" line in the schedule hint
// counts.
function channelDraftShowGroups() {
  const groups = [];
  const index = new Map();
  channelDraftItems.forEach((it) => {
    const key = channelDraftShowKey(it);
    if (!key) return;
    if (!index.has(key)) {
      index.set(key, groups.length);
      groups.push({ key: key, name: it.showName || it.title || 'Untitled', count: 0, isMovie: it.kind === 'movie' });
    }
    groups[index.get(key)].count++;
  });
  return groups;
}

function isChannelShowStoryLocked(key) {
  return channelDraftStoryLocked.indexOf(key) !== -1;
}

function toggleChannelStoryLock(key, on) {
  const at = channelDraftStoryLocked.indexOf(key);
  if (on && at === -1) channelDraftStoryLocked.push(key);
  else if (!on && at !== -1) channelDraftStoryLocked.splice(at, 1);
}

// Story Lock only makes sense per SHOW, and only for a channel that shuffles
// or rotates -- with picks playing in the order they are listed there is
// nothing for a lock to protect against, so the section says so instead of
// offering switches that would do nothing.
function renderChannelStoryLock() {
  const box = document.getElementById('channelStoryLockSection');
  if (!box) return;
  const groups = channelDraftShowGroups().filter((g) => !g.isMovie && g.count > 1);
  // A lock on a show that has since been removed is dropped here rather than
  // saved forward -- it can only confuse the next person to open this.
  const liveKeys = groups.map((g) => g.key);
  channelDraftStoryLocked = channelDraftStoryLocked.filter((k) => liveKeys.indexOf(k) !== -1);
  if (!groups.length) {
    box.innerHTML = '';
    return;
  }
  const rotating = !!(document.getElementById('channelDailyRotateCheck') || {}).checked;
  const shuffling = getChannelPlayOrder() === 'shuffle-daily';
  const active = rotating || shuffling;
  const rows = groups.map((g) => {
    const id = 'channelStoryLock_' + encodeURIComponent(g.key).replace(/[^A-Za-z0-9]/g, '_');
    return '<label class="channel-rule-row" for="' + escapeAttr(id) + '">' +
      '<input type="checkbox" id="' + escapeAttr(id) + '"' + (isChannelShowStoryLocked(g.key) ? ' checked' : '') +
        ' onchange="toggleChannelStoryLock(&quot;' + escapeJsAttr(g.key) + '&quot;, this.checked)">' +
      '<span>' + escapeHtml(g.name) + ' <small style="color:var(--muted);">(' + g.count + ')</small></span>' +
    '</label>';
  }).join('');
  box.innerHTML =
    '<p style="margin:0 0 4px; font-weight:600; font-size:0.85rem;">Story Lock</p>' +
    '<p style="margin:0 0 4px; color:var(--muted); font-size:0.78rem;">' +
      'Shuffling suits a procedural &mdash; Seinfeld, The Office, Law &amp; Order. It ruins a serialized one. ' +
      'Tick a show here and it always advances to its next episode in order, while everything else keeps shuffling around it.' +
    '</p>' +
    (active ? '' : '<p style="margin:0 0 4px; color:var(--muted); font-size:0.78rem;"><em>This channel plays in the order listed above, so nothing is being shuffled for a lock to protect against yet.</em></p>') +
    '<div class="channel-storylock-grid">' + rows + '</div>';
}

// Keeps the schedule dials, their hint line and the Story Lock list in step
// with each other. Called by every control in the section, and once more
// whenever the draft is re-rendered.
function updateChannelBroadcastControls() {
  const check = document.getElementById('channelDailyRotateCheck');
  const dials = document.getElementById('channelDailyRotateDials');
  const hint = document.getElementById('channelDailyRotateHint');
  const on = !!(check && check.checked);
  if (dials) dials.style.display = on ? 'flex' : 'none';
  if (hint) {
    if (!on) {
      hint.textContent = 'Off — every pick in this channel plays, in the order above.';
    } else {
      const shows = Math.max(1, Math.min(48, parseInt((document.getElementById('channelRotateShowsInput') || {}).value, 10) || CHANNEL_DEFAULT_ROTATE_SHOWS));
      const eps = Math.max(1, Math.min(12, parseInt((document.getElementById('channelRotateEpisodesInput') || {}).value, 10) || CHANNEL_DEFAULT_ROTATE_EPISODES));
      const available = channelDraftShowGroups().length;
      const running = Math.min(shows, available || shows);
      const zoneSel = document.getElementById('channelRotateTurnoverZone');
      const zone = zoneSel && zoneSel.value === 'local' ? 'your local time' : 'UTC';
      const timeInput = document.getElementById('channelRotateTurnoverTime');
      const timeStr = (timeInput && timeInput.value) || '00:00';
      hint.textContent = running + ' show' + (running === 1 ? '' : 's') + ' a day, ' + eps +
        ' back-to-back episode' + (eps === 1 ? '' : 's') + ' each (' + (running * eps) + ' episodes), ' +
        'refreshing at ' + timeStr + ' ' + zone + '.' +
        (available && shows > available ? ' This channel only has ' + available + ' shows in it so far.' : '');
    }
  }
  updateChannelNewEpisodeControls();
  updateChannelPairControls();
  renderChannelStoryLock();
}

// The sub-rule only exists while the rule above it is on: "put new episodes
// at the top" of a channel that is not collecting any is a switch with
// nothing behind it.
function updateChannelNewEpisodeControls() {
  const check = document.getElementById('channelAutoNewEpisodesCheck');
  const row = document.getElementById('channelNewEpisodesRow');
  const hint = document.getElementById('channelAutoNewEpisodesHint');
  const on = !!(check && check.checked);
  if (row) row.style.display = on ? 'block' : 'none';
  if (!hint) return;
  if (!on) {
    hint.textContent = 'Off — this channel plays the picks below and nothing else.';
    return;
  }
  const shows = channelDraftShowGroups().filter((g) => !g.isMovie).length;
  const topCheck = document.getElementById('channelNewEpisodesTopCheck');
  const where = topCheck && topCheck.checked ? 'at the top' : 'at the end';
  hint.textContent = 'Episodes that air from now on are added ' + where + ' on their own, for ' +
    (shows ? (shows + ' show' + (shows === 1 ? '' : 's')) : 'the shows') +
    ' in this channel. Checked in the background a couple of times a day; already-aired episodes only.';
}

// Everything the hand-made pairs need on screen: the count, a way to drop
// them all, and the pruning that keeps them honest when picks are removed.
function updateChannelPairControls() {
  const keys = {};
  channelDraftItems.forEach((it) => {
    const key = channelDraftPairKey(it);
    if (key) keys[key] = true;
  });
  // A pair whose other half has been removed is not a pair. Dropped here
  // rather than saved forward, the same way a Story Lock on a removed show
  // is.
  channelDraftPairedGroups = channelDraftPairedGroups
    .map((g) => g.filter((k) => keys[k]))
    .filter((g) => g.length > 1);
  const hint = document.getElementById('channelPairPartsHint');
  if (!hint) return;
  const base = 'Finds “Part 1” / “Pt. II” / “(2)” in episode titles. Whenever one part is on today, the rest play straight after it instead of turning up tomorrow.';
  const made = channelDraftPairedGroups.length;
  hint.textContent = made
    ? (base + ' ' + made + ' pair' + (made === 1 ? '' : 's') + ' made by hand below — those play together whether this is ticked or not.')
    : (base + ' Select picks below and hit Pair to link any two by hand.');
}

// The client twin of the Worker's channelItemStreamId: the key a pairing is
// stored under on both sides.
function channelDraftPairKey(it) {
  if (!it) return '';
  const showId = String(it.imdbId || '').trim();
  if (!showId) return '';
  if (it.kind === 'movie') return showId;
  if (it.season == null || it.episode == null) return '';
  return showId + ':' + it.season + ':' + it.episode;
}

// "Pair" over the selection: these picks play back to back, in the order
// they are listed in the channel, wherever the first of them is drawn.
//
// A pick can only belong to one pair, so selecting a pick that is already in
// one replaces that pair rather than leaving it in two places with two
// different answers about what plays next.
function pairChannelDraftSelection() {
  const keys = [];
  channelDraftSelection.slice().sort((a, b) => a - b).forEach((i) => {
    const key = channelDraftPairKey(channelDraftItems[i]);
    if (key && keys.indexOf(key) === -1) keys.push(key);
  });
  if (keys.length < 2) {
    showAddedToast('Pick at least two episodes to pair.');
    return;
  }
  if (keys.length > CHANNEL_DRAFT_PAIR_MAX) {
    showAddedToast('A pairing can hold at most ' + CHANNEL_DRAFT_PAIR_MAX + ' episodes.');
    return;
  }
  channelDraftPairedGroups = channelDraftPairedGroups
    .map((g) => g.filter((k) => keys.indexOf(k) === -1))
    .filter((g) => g.length > 1);
  channelDraftPairedGroups.push(keys);
  renderChannelDraftList();
  showAddedToast(keys.length + ' episodes will play back to back.');
}

function unpairChannelDraftSelection() {
  const keys = [];
  channelDraftSelection.forEach((i) => {
    const key = channelDraftPairKey(channelDraftItems[i]);
    if (key) keys.push(key);
  });
  if (!keys.length) return;
  const before = channelDraftPairedGroups.length;
  channelDraftPairedGroups = channelDraftPairedGroups
    .map((g) => g.filter((k) => keys.indexOf(k) === -1))
    .filter((g) => g.length > 1);
  renderChannelDraftList();
  showAddedToast(before === channelDraftPairedGroups.length ? 'None of those were paired.' : 'Pairing removed.');
}

// Reads the whole section back as the payload fields the Worker understands.
function readChannelBroadcastSettings() {
  const check = document.getElementById('channelDailyRotateCheck');
  const dailyRotate = !!(check && check.checked);
  const zoneSel = document.getElementById('channelRotateTurnoverZone');
  const zone = zoneSel && zoneSel.value === 'local' ? 'local' : 'utc';
  const timeInput = document.getElementById('channelRotateTurnoverTime');
  const timeStr = (timeInput && timeInput.value) || '00:00';
  const liveCheck = document.getElementById('channelLiveSyncCheck');
  const hideCheck = document.getElementById('channelHideWatchedCheck');
  const pairCheck = document.getElementById('channelPairPartsCheck');
  const newEpCheck = document.getElementById('channelAutoNewEpisodesCheck');
  const newEpTopCheck = document.getElementById('channelNewEpisodesTopCheck');
  const descInput = document.getElementById('channelDescriptionInput');
  return {
    description: descInput ? String(descInput.value || '').trim().slice(0, 400) : '',
    dailyRotate: dailyRotate,
    rotateShows: dailyRotate ? Math.max(1, Math.min(48, parseInt((document.getElementById('channelRotateShowsInput') || {}).value, 10) || CHANNEL_DEFAULT_ROTATE_SHOWS)) : 0,
    rotateEpisodes: dailyRotate ? Math.max(1, Math.min(12, parseInt((document.getElementById('channelRotateEpisodesInput') || {}).value, 10) || CHANNEL_DEFAULT_ROTATE_EPISODES)) : 0,
    rotateTurnover: dailyRotate ? channelTurnoverToUtcMinutes(timeStr, zone) : 0,
    rotateTurnoverTime: dailyRotate ? timeStr : '',
    rotateTurnoverZone: zone,
    hideWatched: !!(hideCheck && hideCheck.checked),
    storyLocked: channelDraftStoryLocked.slice(),
    pairParts: !!(pairCheck && pairCheck.checked),
    pairedGroups: channelDraftPairedGroups.map((g) => g.slice()),
    autoNewEpisodes: !!(newEpCheck && newEpCheck.checked),
    // Only meaningful with the line above on, and stored as 0 when it is
    // off for the same reason the rotation dials are: a flag with nothing
    // behind it reads as a rule the channel does not actually have.
    newEpisodesAtTop: !!(newEpCheck && newEpCheck.checked && newEpTopCheck && newEpTopCheck.checked),
    // Live Cloud Sync has nothing to sync FROM unless this channel was
    // imported from a list, so it can only ever be on for one that was.
    liveSync: !!(channelDraftSourceUrl && liveCheck && liveCheck.checked),
    sourceUrl: channelDraftSourceUrl || '',
    dynamic: channelDraftDynamic || '',
  };
}

// Puts a saved channel's settings back on screen. The counterpart of
// readChannelBroadcastSettings, called by every path that opens the builder.
function applyChannelBroadcastSettings(channel) {
  const f = channelBroadcastFields(channel);
  const publicToggle = document.getElementById('channelPublicToggle');
  if (publicToggle) {
    publicToggle.checked = !channel || (channel.visibility !== 'private' && channel.sharePublished !== false);
  }
  const descInput = document.getElementById('channelDescriptionInput');
  if (descInput) descInput.value = f.description;
  channelDraftStoryLocked = f.storyLocked;
  channelDraftPairedGroups = f.pairedGroups;
  channelDraftSourceUrl = f.sourceUrl;
  channelDraftDynamic = f.dynamic;
  const check = document.getElementById('channelDailyRotateCheck');
  if (check) check.checked = f.dailyRotate;
  const showsInput = document.getElementById('channelRotateShowsInput');
  if (showsInput) showsInput.value = f.rotateShows || CHANNEL_DEFAULT_ROTATE_SHOWS;
  const epsInput = document.getElementById('channelRotateEpisodesInput');
  if (epsInput) epsInput.value = f.rotateEpisodes || CHANNEL_DEFAULT_ROTATE_EPISODES;
  const zoneSel = document.getElementById('channelRotateTurnoverZone');
  if (zoneSel) zoneSel.value = f.rotateTurnoverZone;
  const timeInput = document.getElementById('channelRotateTurnoverTime');
  if (timeInput) {
    // rotateTurnoverTime is what was typed; rotateTurnover is the same
    // instant in UTC. A channel saved before the time box existed (every
    // Quick Add network channel) only has the second one, and it is always
    // midnight UTC, so deriving from it is exact rather than a guess.
    timeInput.value = f.rotateTurnoverTime || channelMinutesToTimeString(f.rotateTurnover);
  }
  const hideCheck = document.getElementById('channelHideWatchedCheck');
  if (hideCheck) hideCheck.checked = f.hideWatched;
  const pairCheck = document.getElementById('channelPairPartsCheck');
  if (pairCheck) pairCheck.checked = f.pairParts;
  const newEpCheck = document.getElementById('channelAutoNewEpisodesCheck');
  if (newEpCheck) newEpCheck.checked = f.autoNewEpisodes;
  const newEpTopCheck = document.getElementById('channelNewEpisodesTopCheck');
  if (newEpTopCheck) newEpTopCheck.checked = f.newEpisodesAtTop;
  const liveRow = document.getElementById('channelLiveSyncRow');
  const liveCheck = document.getElementById('channelLiveSyncCheck');
  if (liveCheck) liveCheck.checked = f.liveSync;
  if (liveRow) liveRow.style.display = f.sourceUrl ? 'block' : 'none';
  const liveHint = document.getElementById('channelLiveSyncHint');
  if (liveHint) {
    liveHint.textContent = f.sourceUrl
      ? ('Rebuilds this channel’s pool from ' + f.sourceUrl + ' in the background, so titles the list gains turn up here without re-importing.')
      : '';
  }
  updateChannelBroadcastControls();
}


// --- working on a big draft ----------------------------------------------
//
// A channel with 800 picks was drag-one-at-a-time, type-a-position, or
// Remove all. These three together are what make one editable: a filter to
// find the picks you mean, selection to gather them, and bulk moves to place
// them.
//
// Selection is by INDEX into channelDraftItems, and every operation that
// reorders or removes rebuilds it, because an index that survives a reorder
// is an index pointing at the wrong pick.
let channelDraftFilter = '';
let channelDraftSelectMode = false;
let channelDraftSelection = [];

// Everything about one pick that a filter should match: the show, the
// episode, and the S/E people actually type ("s5e12").
function channelDraftItemHaystack(it) {
  if (!it) return '';
  const se = (it.season != null && it.episode != null) ? ('s' + it.season + 'e' + it.episode) : '';
  return [it.showName, it.epName, it.title, se].filter(Boolean).join(' ').toLowerCase();
}

// The indices currently on screen -- which is what "shown" means in every
// bulk action, so a filtered list cannot act on picks nobody can see.
function channelDraftVisibleIndices() {
  const q = channelDraftFilter.trim().toLowerCase();
  const out = [];
  channelDraftItems.forEach((it, i) => {
    if (!q || channelDraftItemHaystack(it).indexOf(q) !== -1) out.push(i);
  });
  return out;
}

// The filter and the selection are about the EDITING SESSION, not the
// channel, so every path that opens the builder on something else clears
// them -- otherwise a filter typed for one channel silently hides most of
// the next one.
function resetChannelDraftWorkspace() {
  channelDraftFilter = '';
  channelDraftSelectMode = false;
  channelDraftSelection = [];
  const filterInput = document.getElementById('channelDraftFilterInput');
  if (filterInput) filterInput.value = '';
}

function setChannelDraftFilter(value) {
  channelDraftFilter = String(value || '');
  renderChannelDraftList();
}

function toggleChannelDraftSelectMode() {
  channelDraftSelectMode = !channelDraftSelectMode;
  if (!channelDraftSelectMode) channelDraftSelection = [];
  renderChannelDraftList();
}

function isChannelDraftSelected(index) {
  return channelDraftSelection.indexOf(index) !== -1;
}

function toggleChannelDraftPick(index, on) {
  const at = channelDraftSelection.indexOf(index);
  if (on && at === -1) channelDraftSelection.push(index);
  else if (!on && at !== -1) channelDraftSelection.splice(at, 1);
  updateChannelDraftSelectionCount();
}

function selectAllChannelDraftShown(on) {
  if (!on) {
    channelDraftSelection = [];
  } else {
    channelDraftVisibleIndices().forEach((i) => {
      if (channelDraftSelection.indexOf(i) === -1) channelDraftSelection.push(i);
    });
  }
  renderChannelDraftList();
}

// "Select a whole show or season" -- the two groupings anyone actually wants
// to act on at once. The option value is JSON rather than a delimited
// string: a show key is either an IMDb id or "kind:title", and a title with
// a colon in it would split any separator worth typing.
function selectChannelDraftByGroup(value) {
  if (!value) return;
  let showKey = '';
  let season = null;
  try {
    const parsed = JSON.parse(value);
    showKey = parsed[0];
    season = parsed.length > 1 && parsed[1] !== null ? Number(parsed[1]) : null;
  } catch (e) {
    return;
  }
  channelDraftItems.forEach((it, i) => {
    if (channelDraftShowKey(it) !== showKey) return;
    if (season !== null && Number(it.season) !== season) return;
    if (channelDraftSelection.indexOf(i) === -1) channelDraftSelection.push(i);
  });
  renderChannelDraftList();
}

function updateChannelDraftSelectionCount() {
  const el = document.getElementById('channelDraftSelectionCount');
  if (el) el.textContent = channelDraftSelection.length + ' selected';
}

function removeChannelDraftSelection() {
  if (!channelDraftSelection.length) return;
  const drop = {};
  channelDraftSelection.forEach((i) => { drop[i] = true; });
  channelDraftItems = channelDraftItems.filter((_, i) => !drop[i]);
  channelDraftSelection = [];
  // A hand-made change to the order, so a remembered sort must not undo it
  // on the re-render -- the rule every other manual move follows.
  clearChannelDraftAutoSort();
  renderChannelDraftList();
}

function moveChannelDraftSelection(where) {
  if (!channelDraftSelection.length) return;
  const picked = {};
  channelDraftSelection.forEach((i) => { picked[i] = true; });
  const moved = channelDraftItems.filter((_, i) => picked[i]);
  const rest = channelDraftItems.filter((_, i) => !picked[i]);
  channelDraftItems = where === 'bottom' ? rest.concat(moved) : moved.concat(rest);
  // The moved picks are now a contiguous run at one end, so the selection is
  // rebuilt to point at where they actually ended up.
  channelDraftSelection = moved.map((_, n) => (where === 'bottom' ? rest.length + n : n));
  clearChannelDraftAutoSort();
  renderChannelDraftList();
}

// The show/season menu, rebuilt from the draft on each render so it cannot
// offer a show that is no longer in the channel.
function renderChannelDraftGroupOptions() {
  const sel = document.getElementById('channelDraftSelectShowSelect');
  if (!sel) return;
  const groups = [];
  const index = new Map();
  channelDraftItems.forEach((it) => {
    const key = channelDraftShowKey(it);
    if (!key) return;
    if (!index.has(key)) {
      index.set(key, groups.length);
      groups.push({ key: key, name: it.showName || it.title || 'Untitled', count: 0, seasons: new Map() });
    }
    const g = groups[index.get(key)];
    g.count++;
    const season = Number(it.season);
    if (Number.isInteger(season)) g.seasons.set(season, (g.seasons.get(season) || 0) + 1);
  });
  const options = ['<option value="">Select a whole show or season…</option>'];
  groups.forEach((g) => {
    options.push('<option value="' + escapeAttr(JSON.stringify([g.key])) + '">' +
      escapeHtml(g.name) + ' — all ' + g.count + '</option>');
    if (g.seasons.size > 1) {
      [...g.seasons.keys()].sort((a, b) => a - b).forEach((season) => {
        options.push('<option value="' + escapeAttr(JSON.stringify([g.key, season])) + '">' +
          escapeHtml(g.name) + ' — season ' + season + ' (' + g.seasons.get(season) + ')</option>');
      });
    }
  });
  sel.innerHTML = options.join('');
}

// --- what this channel adds up to ----------------------------------------
//
// Shows, episodes, hours, the years it spans, and which rules are in force.
// Cheap to compute, and it turns a channel from a blob of eight hundred rows
// into something you can tell apart from the last one you built.
//
// Runtime is only known for picks added since it started being stored, so
// the hours are an estimate and SAY SO rather than being quietly wrong: a
// pick with no runtime is counted at this channel's own average, or at half
// an hour when nothing at all is known.
function channelDraftSummary(items, settings) {
  const list = Array.isArray(items) ? items : [];
  const shows = new Set();
  let episodes = 0;
  let movies = 0;
  let knownMinutes = 0;
  let knownCount = 0;
  let earliest = '';
  let latest = '';
  list.forEach((it) => {
    if (!it) return;
    const key = channelDraftShowKey(it);
    if (key) shows.add(key);
    if (it.kind === 'movie') movies++;
    else episodes++;
    const runtime = Number(it.runtime);
    if (Number.isInteger(runtime) && runtime > 0) {
      knownMinutes += runtime;
      knownCount++;
    }
    const date = channelItemAiredDateClient(it);
    if (date) {
      if (!earliest || date < earliest) earliest = date;
      if (!latest || date > latest) latest = date;
    }
  });
  const average = knownCount ? (knownMinutes / knownCount) : 30;
  const totalMinutes = knownMinutes + ((list.length - knownCount) * average);
  const s = settings || {};
  const rules = [];
  if (s.dailyRotate) {
    rules.push((s.rotateShows || CHANNEL_DEFAULT_ROTATE_SHOWS) + ' shows × ' +
      (s.rotateEpisodes || CHANNEL_DEFAULT_ROTATE_EPISODES) + ' a day');
  }
  if ((s.storyLocked || []).length) rules.push((s.storyLocked || []).length + ' story-locked');
  if (s.hideWatched) rules.push('hides watched');
  if (s.pairParts) rules.push('parts stay together');
  else if ((s.pairedGroups || []).length) rules.push((s.pairedGroups || []).length + ' paired');
  if (s.autoNewEpisodes) rules.push('auto-adds new episodes' + (s.newEpisodesAtTop ? ' at the top' : ''));
  if (s.liveSync) rules.push('live cloud sync');
  return {
    shows: shows.size,
    episodes: episodes,
    movies: movies,
    total: list.length,
    hours: Math.round(totalMinutes / 60),
    estimated: knownCount < list.length,
    firstYear: earliest ? earliest.slice(0, 4) : '',
    lastYear: latest ? latest.slice(0, 4) : '',
    rules: rules,
  };
}

// The summary as one line. Used under the draft and on a saved channel's
// card, so both say the same thing the same way.
function channelSummaryLine(summary) {
  if (!summary || !summary.total) return '';
  const bits = [];
  if (summary.shows) bits.push(summary.shows + (summary.shows === 1 ? ' show' : ' shows'));
  if (summary.episodes) bits.push(summary.episodes + (summary.episodes === 1 ? ' episode' : ' episodes'));
  if (summary.movies) bits.push(summary.movies + (summary.movies === 1 ? ' movie' : ' movies'));
  if (summary.hours) bits.push((summary.estimated ? '~' : '') + summary.hours + (summary.hours === 1 ? ' hour' : ' hours'));
  if (summary.firstYear) {
    bits.push(summary.firstYear === summary.lastYear ? summary.firstYear : (summary.firstYear + '–' + summary.lastYear));
  }
  return bits.concat(summary.rules).join(' · ');
}

function renderChannelDraftStats() {
  const box = document.getElementById('channelDraftStats');
  if (!box) return;
  if (!channelDraftItems.length) {
    box.textContent = '';
    return;
  }
  const line = channelSummaryLine(channelDraftSummary(channelDraftItems, readChannelBroadcastSettings()));
  box.textContent = line;
  box.title = line;
}

// --- adding something that is already here -------------------------------
//
// Adding a show twice from two different places, or splicing the same
// crossover in again, used to just work -- and you found out later, by which
// point the duplicate is somewhere in eight hundred rows.
function channelDraftCountForShow(imdbId, showName) {
  const id = String(imdbId || '').trim();
  const name = String(showName || '').trim().toLowerCase();
  if (!id && !name) return 0;
  return channelDraftItems.filter((it) => {
    if (!it) return false;
    if (id && String(it.imdbId || '').trim() === id) return true;
    return !!name && String(it.showName || '').trim().toLowerCase() === name;
  }).length;
}

// True when the caller should STOP: the dialog is up, and confirming it calls
// the retry callback, which is the caller again with the check already done.
//
// Deliberately not a promise. showAppConfirm has no cancel callback -- the X,
// the Cancel button, the backdrop and Escape all just close it -- so a
// promise here could only resolve on "yes" and would hang forever on every
// "no". A dangling promise per declined add is a leak in the browser and a
// hung test everywhere else.
//
// With no dialog available it lets the add through rather than refusing: a
// missing confirmation must not become a missing feature.
function guardChannelDraftDuplicate(label, existingCount, retry) {
  if (!existingCount) return false;
  if (typeof showAppConfirm !== 'function') return false;
  showAppConfirm(
    'Already in this channel',
    label + ' is already in this channel (' + existingCount + ' pick' + (existingCount === 1 ? '' : 's') +
      '). Add it again anyway?',
    'Add anyway',
    retry,
    false
  );
  return true;
}

let editingChannelId = null;
let editingChannelUrlInput = null;

async function saveChannel() {
  const nameInput = document.getElementById('channelNameInput');
  const name = nameInput.value.trim();
  if (!name) {
    if (typeof showAppAlert === 'function') {
      showAppAlert('Channel Builder', 'Name this channel first.');
    } else {
      alert('Name this channel first.');
    }
    return;
  }
  if (!channelDraftItems.length) {
    if (typeof showAppAlert === 'function') {
      showAppAlert('Channel Builder', 'Add at least one episode or movie first.');
    } else {
      alert('Add at least one episode or movie first.');
    }
    return;
  }
  const verticalPoster = (channelDraftPoster && channelDraftPoster !== 'custom' && !channelDraftPoster.includes('/api/channel-poster')) ? channelDraftPoster : null;
  let horizontalBackdrop = null;
  if (verticalPoster) {
    const matchedItem = channelDraftItems.find((it) => it && (it.showPoster === verticalPoster || it.poster === verticalPoster));
    horizontalBackdrop = (matchedItem && (matchedItem.backdrop || matchedItem.showBackdrop || matchedItem.thumbnail)) || channelDraftBackdrop || verticalPoster;
  }
  // The dropdown is the whole play-order state: "Shuffle daily" is the only
  // entry the Worker acts on, and a static sort has already been applied to
  // channelDraftItems, so the saved item order IS the play order. autoSort
  // only says which sort to re-apply when picks are added later.
  const playOrder = getChannelPlayOrder();
  const shuffle = playOrder === 'shuffle-daily';
  const autoSort = channelDraftAutoSortKey();

  const map = loadLocalChannels();
  const channelId = editingChannelId || generateChannelId();
  const existingChannel = (editingChannelId && map[editingChannelId]) ? map[editingChannelId] : {};
  const isPublic = document.getElementById('channelPublicToggle') ? document.getElementById('channelPublicToggle').checked : true;
  
  const payload = Object.assign({
    channelId: channelId,
    name: name,
    poster: verticalPoster,
    backdrop: horizontalBackdrop,
    items: channelDraftItems,
    shuffle: shuffle,
    autoSort: autoSort,
    // Cleared, never written: a channel that carried it was sorted by the
    // Worker on every request, and its picks have just been sorted for real
    // (see editChannelById) -- so the stored order is now the answer.
    sortByAired: false,
    visibility: isPublic ? 'public' : 'private',
    sharePublished: isPublic,
    shareCode: existingChannel.shareCode || '',
    owner: existingChannel.owner || (typeof activeCreator !== 'undefined' && activeCreator ? activeCreator.creatorName : ''),
  // The broadcast schedule, Story Lock, Hide watched and Live Cloud Sync,
  // read straight off the panel below the play-order dropdown. The saved
  // channel is no longer consulted for dailyRotate: the panel was populated
  // FROM it when the builder opened (applyChannelBroadcastSettings), so what
  // is on screen is the full picture including anything Quick Add set, and
  // reading it back is what lets someone turn a network channel's rotation
  // off.
  }, readChannelBroadcastSettings());

  if (isPublic) {
    try {
      const signedIn = (typeof activeCreator !== 'undefined' && !!activeCreator);
      const data = await postChannelShare(payload, { publish: signedIn });
      if (data && data.ok) {
        payload.shareCode = data.code;
        payload.sharePublished = !!data.published;
        if (data.owner) payload.owner = data.owner;
        rememberChannelShare(channelId, data.code, !!data.published);
      }
    } catch (e) {}
  } else if (existingChannel.shareCode && (existingChannel.sharePublished || existingChannel.visibility === 'public')) {
    try {
      await unpublishChannelByCode(existingChannel.shareCode);
      payload.sharePublished = false;
      rememberChannelShare(channelId, existingChannel.shareCode, false);
    } catch (e) {}
  }

  saveLocalChannel(payload);

  const rows = [...document.querySelectorAll('#lists .entry')];
  let foundRow = false;
  rows.forEach((row) => {
    const urlInputs = [...row.querySelectorAll('.url')];
    urlInputs.forEach((u) => {
      if (u.value.includes(channelId)) {
        foundRow = true;
        u.value = 'channel:v1:' + JSON.stringify(payload);
        const nameEl = row.querySelector('.name');
        if (nameEl && urlInputs.length === 1) nameEl.value = name;
      }
    });
  });

  if (foundRow) {
    if (typeof saveState === 'function') saveState();
  }
  showAddedToast('Channel "' + name + '" saved.');

  renderMyCreatedChannelsList();
  renderChannelMergeList();
  if (typeof loadChannelDirectory === 'function') loadChannelDirectory(true);

  const finalShareUrl = payload.shareCode ? channelShareUrl(payload.shareCode, payload) : '';
  showSavedChannelModal(name, isPublic ? 'public' : 'private', finalShareUrl);

  editingChannelId = null;
  editingChannelUrlInput = null;
  channelDraftItems = [];
  channelDraftPoster = null;
  channelDraftBackdrop = null;
  nameInput.value = '';
  setChannelPlayOrder('as-listed');
  const searchInput = document.getElementById('channelSearchInput');
  if (searchInput) searchInput.value = '';
  const searchRes = document.getElementById('channelSearchResult');
  if (searchRes) searchRes.innerHTML = '';
  const epPicker = document.getElementById('channelEpisodePicker');
  if (epPicker) epPicker.innerHTML = '';
  
  renderChannelDraftList();
  renderMyCreatedChannelsList();
  renderChannelMergeList();
  updateChannelSaveButtonLabel();
  switchChannelsSubmenu('my-channels', document.querySelector('#channelsSubnavBar button:nth-child(1)'));
  window.scrollTo({ top: 0, behavior: 'smooth' });
  const myChPanel = document.getElementById('channelsSubMyChannels');
  if (myChPanel) myChPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

let activeStorylineCategory = 'all';

function getStorylineCategories(event) {
  const cats = ['all'];
  const franchise = String(event.franchise || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const cat = String(event.category || '').toLowerCase();

  if (cat === 'moviesagas' || event.episodes.every((e) => e.type === 'movie')) {
    cats.push('moviesagas');
  }
  if (cat === 'tvuniverses' || event.episodes.some((e) => e.type === 'show' || e.type === 'season')) {
    cats.push('tvuniverses');
  }
  if (
    franchise.includes('starwars') || franchise.includes('marvel') || franchise.includes('lordoftherings') ||
    franchise.includes('matrix') || franchise.includes('startrek') || franchise.includes('xfiles') ||
    franchise.includes('alien') || franchise.includes('planetoftheapes') || franchise.includes('jurassic') ||
    franchise.includes('firefly') || franchise.includes('transformers') || franchise.includes('homestead') ||
    franchise.includes('battlestar') || franchise.includes('farscape') || franchise.includes('dcuniverse') ||
    franchise.includes('manofaction') || franchise.includes('powerrangers')
  ) {
    cats.push('scifi');
  }
  if (
    franchise.includes('fastfurious') || franchise.includes('batman') || franchise.includes('missionimpossible') ||
    franchise.includes('jamesbond') || franchise.includes('johnwick') || franchise.includes('hungergames') ||
    franchise.includes('indianajones') || franchise.includes('madmax') || franchise.includes('pirates') ||
    franchise.includes('breakingbad') || franchise.includes('24') || franchise.includes('arrowverse') ||
    franchise.includes('dcuniverse') || franchise.includes('sopranos') || franchise.includes('gomorrah') ||
    franchise.includes('spartacus') || franchise.includes('luther') || franchise.includes('burnnotice') ||
    franchise.includes('monk') || franchise.includes('csi') || franchise.includes('veronicamars') ||
    franchise.includes('shondaland')
  ) {
    cats.push('action');
  }
  if (
    franchise.includes('toystory') || franchise.includes('shrek') || franchise.includes('demonslayer') ||
    franchise.includes('jujutsu') || franchise.includes('futurama') || franchise.includes('cowboybebop') ||
    franchise.includes('evangelion') || franchise.includes('simpsons') || franchise.includes('bobsburgers') ||
    franchise.includes('stevenuniverse') || franchise.includes('heyarnold') || franchise.includes('invader') ||
    franchise.includes('beavis') || franchise.includes('dragonball') || franchise.includes('southpark') ||
    franchise.includes('konosuba') || franchise.includes('tangled') || franchise.includes('lilo') ||
    franchise.includes('jimmyneutron') || franchise.includes('rugrats') || franchise.includes('madeinabyss') ||
    franchise.includes('swordartonline') || franchise.includes('rascaldoesnotdream') ||
    franchise.includes('steinsgate') || franchise.includes('haruhisuzumiya') || franchise.includes('haikyu') ||
    franchise.includes('quintuplets') || franchise.includes('fullmetal') || franchise.includes('gintama') ||
    franchise.includes('nogamenolife') || franchise.includes('metalocalypse') || franchise.includes('venturebros') ||
    franchise.includes('disney') || franchise.includes('nickelodeon') || franchise.includes('cartoonnetwork') ||
    franchise.includes('isekai') || franchise.includes('animationdomination') || franchise.includes('dcanimated')
  ) {
    cats.push('animation');
  }
  return cats;
}

function filterStorylinesCategory(cat, btn) {
  activeStorylineCategory = cat;
  const bar = document.getElementById('storylineCategoryFilterBar');
  if (bar) {
    bar.querySelectorAll('.subnav-pill').forEach((p) => {
      p.classList.remove('active');
      const c = p.querySelector('.check-icon');
      if (c) c.remove();
    });
  }
  if (btn) {
    btn.classList.add('active');
    btn.insertAdjacentHTML('afterbegin', '<span class="check-icon">&#x2713;</span> ');
  }
  renderStorylinesUniverseList(cat);
}

function openStorylineDetails(eventId) {
  const event = TV_CROSSOVER_EVENTS.find((e) => e.id === eventId);
  if (!event) return;
  const hasMovies = event.episodes.some((e) => e.type === 'movie');
  const hasShows = event.episodes.some((e) => e.type !== 'movie');
  let type = 'mixed';
  if (hasMovies && !hasShows) type = 'movie';
  else if (hasShows && !hasMovies) type = 'series';
  else type = 'mixed';

  const customUrl = 'custom:storyline:' + event.id;
  window._previousScrollY = window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0;
  window._previousTab = 'channels';
  window._originTab = 'channels';
  const items = event.episodes.map((ep) => ({
    id: ep.imdbId || (ep.tmdbId ? ('tmdb:' + ep.tmdbId) : ''),
    type: (ep.type === 'movie') ? 'movie' : 'series',
    name: ep.title || ep.showName,
    title: ep.title || ep.showName,
    year: ep.year || '',
    poster: ep.poster || (ep.imdbId ? ('https://images.metahub.space/poster/medium/' + ep.imdbId + '/img') : ''),
    season: ep.season,
    episode: ep.episode
  }));
  if (typeof openListDetailsPage === 'function') {
    openListDetailsPage(event.name, type, customUrl, { sample: items, count: items.length, maybeMore: false }, {
      creatorName: event.franchise + ' \u2022 Storylines & Sagas',
      itemCount: items.length,
      likes: null
    });
  }
}

const storylinePosterFallbackAttempted = new WeakSet();

async function handleStorylinePosterError(imgEl) {
  if (!imgEl || storylinePosterFallbackAttempted.has(imgEl)) {
    if (imgEl) imgEl.onerror = null;
    return;
  }
  storylinePosterFallbackAttempted.add(imgEl);
  imgEl.onerror = null;

  const tmdbId = imgEl.dataset.tmdbId;
  const kind = imgEl.dataset.posterKind;
  const title = imgEl.dataset.posterTitle || '';
  if (!tmdbId) return;

  try {
    let fallbackPoster = '';
    if (kind === 'movie') {
      const res = await fetch(ORIGIN + '/api/title-search?q=' + encodeURIComponent(title) + '&type=movie', { cache: 'no-store' });
      const data = await res.json().catch(() => null);
      if (data && data.ok && Array.isArray(data.results)) {
        const found = data.results.find((r) => String(r.tmdbId) === String(tmdbId)) || data.results[0];
        if (found && found.poster) fallbackPoster = found.poster;
      }
    } else {
      const res = await fetch(ORIGIN + '/api/show-seasons?tmdbId=' + encodeURIComponent(tmdbId), { cache: 'no-store' });
      const data = await res.json().catch(() => null);
      if (data && data.ok && data.poster) fallbackPoster = data.poster;
    }
    if (fallbackPoster) {
      imgEl.src = fallbackPoster;
    }
  } catch (e) {
    // No fallback available -- leave the broken-image placeholder; nothing more we can do client-side.
  }
}

function renderStorylinesUniverseList(category = activeStorylineCategory) {
  const container = document.getElementById('storylinesUniverseList');
  if (!container) return;

  const filtered = TV_CROSSOVER_EVENTS.filter((ev) => {
    // Pure single-episode crossovers (NCIS, One Chicago, Arrowverse's
    // individual crossover events, FBI, etc.) are meant to be discovered
    // reactively -- add a relevant show to a channel and the "Crossover
    // Event Detected" banner in the Channel Builder offers just its
    // crossover episodes (see renderChannelCrossoverSuggestions, which
    // still considers every event here regardless of this filter).
    // They're deliberately left out of this browsable grid: clicking into
    // one only ever lands on the parent show's generic details page (no
    // episode-level page exists anywhere in this addon), so as a
    // standalone browse card they don't offer anything a search for the
    // show itself wouldn't -- unlike a real saga/universe entry, which is
    // exactly the kind of multi-season, multi-show marathon a browse grid
    // is for. Every episode-only crossover has episodes entirely of
    // type "episode"; every saga/universe/movie-bridge entry that
    // belongs here mixes in at least one "season"/"show"/"movie" part.
    if (ev.episodes.every((ep) => ep.type === 'episode')) return false;
    if (category === 'all') return true;
    const cats = getStorylineCategories(ev);
    return cats.includes(category);
  });

  if (!filtered.length) {
    container.innerHTML = '<p style="color:var(--muted); font-size:0.85rem;"><small>No sagas found in this category.</small></p>';
    return;
  }

  const channelsMap = (typeof loadLocalChannels === 'function') ? (loadLocalChannels() || {}) : {};

  const cardsHtml = filtered.map((event) => {
    const isMovieSaga = event.category === 'moviesagas' || event.episodes.every((e) => e.type === 'movie');
    const typeBadge = isMovieSaga ? 'Movie Saga (3+ Films)' : 'TV Universe & Movie Bridges';
    const movieCount = event.episodes.filter((e) => e.type === 'movie').length;
    const showCount = event.episodes.filter((e) => e.type === 'show' || e.type === 'season').length;
    
    let countLabel = '';
    if (isMovieSaga) {
      countLabel = event.episodes.length + ' Movies';
    } else if (movieCount > 0 && showCount > 0) {
      countLabel = showCount + ' Show' + (showCount > 1 ? 's' : '') + ' & ' + movieCount + ' Movie' + (movieCount > 1 ? 's' : '');
    } else {
      countLabel = event.episodes.length + ' Segments';
    }

    const chId = 'channel-' + event.id;
    const isAdded = !!channelsMap[chId] || (typeof isListAddedToConfig === 'function' && isListAddedToConfig(null, null, chId));

    const totalCount = event.episodes.length;
    const previewPosters = event.episodes.slice(0, 9);

    const postersHtml = previewPosters.map((ep, i) => {
      const isMovie = ep.type === 'movie';
      let itemTitle = ep.title || ep.showName || '';
      let yearOrSeason = '';
      if (isMovie) {
        yearOrSeason = ep.year ? String(ep.year) : 'Movie';
      } else if (ep.seasons) {
        yearOrSeason = 'Seasons ' + ep.seasons[0] + '-' + ep.seasons[ep.seasons.length - 1];
      } else if (ep.season) {
        yearOrSeason = 'Season ' + ep.season;
      } else {
        yearOrSeason = 'Series';
      }

      let posterUrl = ep.poster || (ep.imdbId ? ('https://images.metahub.space/poster/medium/' + ep.imdbId + '/img') : '');

      const isMobileEnd = (i === 2 && totalCount > 3);
      const isDesktopEnd = (i === previewPosters.length - 1 && totalCount >= 4);
      let overlays = '';
      if (isMobileEnd) {
        overlays += '<div class="list-card-count-overlay mobile-only" onclick="openStorylineDetails(&quot;' + escapeJsAttr(event.id) + '&quot;)" style="cursor:pointer;">' + totalCount + ' &rsaquo;</div>';
      }
      if (isDesktopEnd) {
        overlays += '<div class="list-card-count-overlay desktop-only" onclick="openStorylineDetails(&quot;' + escapeJsAttr(event.id) + '&quot;)" style="cursor:pointer;">' + totalCount + ' &rsaquo;</div>';
      }

      return '<div class="list-card-mini-poster-tile">' +
        '<div class="list-card-mini-poster-img-wrap" style="position:relative; cursor:pointer;" onclick="openStorylineDetails(&quot;' + escapeJsAttr(event.id) + '&quot;)">' +
          '<img src="' + escapeAttr(posterUrl) + '" alt="" loading="lazy" data-tmdb-id="' + escapeAttr(String(ep.tmdbId || '')) + '" data-poster-kind="' + (isMovie ? 'movie' : 'show') + '" data-poster-title="' + escapeAttr(itemTitle) + '" onerror="handleStorylinePosterError(this)">' +
          overlays +
        '</div>' +
        '<div class="list-card-mini-poster-name" title="' + escapeAttr(itemTitle) + '">' + escapeHtml(itemTitle) + '</div>' +
        '<div class="list-card-mini-poster-year">' + escapeHtml(yearOrSeason) + '</div>' +
      '</div>';
    }).join('');

    return '<div class="list-card" data-universe-id="' + escapeAttr(event.id) + '">' +
      '<div class="list-card-header">' +
        '<div class="list-card-body">' +
          '<div class="list-card-title" onclick="openStorylineDetails(&quot;' + escapeJsAttr(event.id) + '&quot;)" style="cursor:pointer;">' + escapeHtml(event.name) + '</div>' +
          '<div class="list-card-meta">' +
            '<span>' + escapeHtml(event.franchise) + '</span>' +
            '<span class="list-card-meta-sep">&middot;</span>' +
            '<span>' + escapeHtml(typeBadge) + '</span>' +
            '<span class="list-card-meta-sep">&middot;</span>' +
            '<span>' + escapeHtml(countLabel) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="list-card-actions">' +
          '<button type="button" class="lc-btn ' + (isAdded ? 'secondary is-added' : 'primary') + '" onclick="createInstantStorylineChannel(&quot;' + escapeJsAttr(event.id) + '&quot;, this)" ' + (isAdded ? 'style="color:var(--danger);"' : '') + '>' + (isAdded ? 'Remove' : '+ Add') + '</button>' +
          '<button type="button" class="lc-btn secondary" onclick="loadStorylineToDraft(&quot;' + escapeJsAttr(event.id) + '&quot;, this)" title="Customize in Channel Builder">Customize</button>' +
        '</div>' +
      '</div>' +
      '<div class="list-card-posters">' +
        postersHtml +
      '</div>' +
    '</div>';
  }).join('');

  container.innerHTML = cardsHtml;
}

async function fetchStorylineOrderedItems(eventId) {
  const event = TV_CROSSOVER_EVENTS.find((e) => e.id === eventId);

  const fullOrderedItems = [];
  for (const ep of event.episodes) {
    if (ep.type === 'movie') {
      let moviePoster = ep.poster || '';
      let movieBackdrop = ep.backdrop || '';
      let movieImdbId = ep.imdbId || '';
      let movieYear = ep.year || '';
      let movieRelease = ep.released || (ep.year ? (ep.year + '-01-01') : '');

      if (!movieImdbId && ep.tmdbId) {
        const res = await fetch(ORIGIN + '/api/resolve-movie?tmdbId=' + encodeURIComponent(ep.tmdbId), { cache: 'no-store' }).catch(() => null);
        const data = res ? await res.json().catch(() => null) : null;
        if (data && data.ok && data.imdbId) {
          movieImdbId = data.imdbId;
        }
      }

      if (!moviePoster) {
        const searchRes = await fetch(ORIGIN + '/api/title-search?q=' + encodeURIComponent(ep.title) + '&type=movie', { cache: 'no-store' }).catch(() => null);
        if (searchRes) {
          const sData = await searchRes.json().catch(() => null);
          if (sData && sData.ok && sData.results && sData.results.length) {
            const found = (ep.tmdbId ? sData.results.find((r) => String(r.tmdbId) === String(ep.tmdbId)) : null) || sData.results[0];
            if (found) {
              if (!moviePoster) moviePoster = found.poster || '';
              if (!movieBackdrop) movieBackdrop = found.backdrop || '';
              if (!movieYear) movieYear = found.year || '';
            }
          }
        }
      }

      fullOrderedItems.push({
        kind: 'movie',
        imdbId: movieImdbId || ('tt_movie_' + (ep.tmdbId || Math.random().toString(36).slice(2, 8))),
        tmdbId: ep.tmdbId,
        title: ep.title,
        year: movieYear || '',
        showName: ep.title,
        epName: 'Movie',
        released: movieRelease || (movieYear ? (movieYear + '-01-01') : ''),
        thumbnail: movieBackdrop || moviePoster || '',
        poster: moviePoster || '',
        showPoster: moviePoster || '',
        backdrop: movieBackdrop || '',
        showBackdrop: movieBackdrop || '',
      });
    } else if (ep.type === 'show' || ep.type === 'season' || ep.seasons || ep.episode === 'all') {
      let seasonNums = [];
      if (Array.isArray(ep.seasons)) {
        seasonNums = ep.seasons;
      } else if (ep.season != null && ep.season !== 'all') {
        seasonNums = [parseInt(ep.season, 10)];
      } else {
        const sRes = await fetch(ORIGIN + '/api/show-seasons?tmdbId=' + encodeURIComponent(ep.tmdbId), { cache: 'no-store' }).catch(() => null);
        const sData = sRes ? await sRes.json().catch(() => null) : null;
        if (sData && sData.ok && Array.isArray(sData.seasons)) {
          seasonNums = sData.seasons.map((s) => s.season).filter((n) => n > 0);
        } else {
          seasonNums = [1];
        }
      }

      let showPoster = ep.poster || '';
      let showBackdrop = ep.backdrop || '';
      let showImdbId = ep.imdbId || '';
      const seasonPostersMap = {};

      const seasonsInfoRes = await fetch(ORIGIN + '/api/show-seasons?tmdbId=' + encodeURIComponent(ep.tmdbId), { cache: 'no-store' }).catch(() => null);
      if (seasonsInfoRes) {
        const siData = await seasonsInfoRes.json().catch(() => null);
        if (siData && siData.ok) {
          if (siData.imdbId) showImdbId = siData.imdbId;
          if (siData.poster) showPoster = siData.poster;
          if (siData.backdrop) showBackdrop = siData.backdrop;
          if (Array.isArray(siData.seasons)) {
            siData.seasons.forEach((s) => {
              if (s.season != null && s.poster) {
                seasonPostersMap[s.season] = s.poster;
              }
            });
          }
        }
      }

      if (!showPoster || !showBackdrop) {
        const showDetailsRes = await fetch(ORIGIN + '/api/title-search?q=' + encodeURIComponent(ep.showName) + '&type=tv', { cache: 'no-store' }).catch(() => null);
        if (showDetailsRes) {
          const sData = await showDetailsRes.json().catch(() => null);
          if (sData && sData.ok && sData.results && sData.results.length) {
            const found = sData.results.find((r) => String(r.tmdbId) === String(ep.tmdbId)) || sData.results[0];
            if (found) {
              if (!showPoster) showPoster = found.poster || '';
              if (!showBackdrop) showBackdrop = found.backdrop || '';
            }
          }
        }
      }

      const seasonResults = await Promise.all(seasonNums.map((sNum) =>
        fetch(ORIGIN + '/api/show-episodes?tmdbId=' + encodeURIComponent(ep.tmdbId) + '&season=' + encodeURIComponent(sNum), { cache: 'no-store' })
          .then((r) => r.json())
          .then((d) => ({ season: sNum, episodes: (d && d.ok && Array.isArray(d.episodes)) ? d.episodes : [] }))
          .catch(() => ({ season: sNum, episodes: [] }))
      ));

      seasonResults
        .sort((a, b) => a.season - b.season)
        .forEach(({ season: sNum, episodes }) => {
          const seasonPoster = seasonPostersMap[sNum] || ep.poster || showPoster;
          episodes.forEach((epItem) => {
            const epTitle = epItem.name || ('Episode ' + epItem.episode);
            const epRelease = epItem.released || undefined;
            const epThumbnail = epItem.thumbnail || showBackdrop || seasonPoster || showPoster;

            fullOrderedItems.push({
              kind: 'episode',
              imdbId: channelStreamShowId(showImdbId, ep.tmdbId),
              season: sNum,
              episode: epItem.episode,
              showName: ep.showName,
              epName: epTitle,
              title: ep.showName + ' S' + sNum + 'E' + epItem.episode + ' \u2014 ' + epTitle,
              released: epRelease,
              thumbnail: epThumbnail,
              poster: seasonPoster || showPoster || epThumbnail || '',
              showPoster: showPoster || '',
              backdrop: showBackdrop || '',
              showBackdrop: showBackdrop || '',
              seasonNum: sNum,
              episodeNum: epItem.episode,
            });
          });
        });
    } else {
      const res = await fetch(ORIGIN + '/api/show-episodes?tmdbId=' + encodeURIComponent(ep.tmdbId) + '&season=' + encodeURIComponent(ep.season), { cache: 'no-store' });
      const data = await res.json();
      let epData = null;
      if (data.ok && Array.isArray(data.episodes)) {
        epData = data.episodes.find((e) => e.episode === ep.episode) || data.episodes[ep.episode - 1] || null;
      }

      let showPoster = ep.poster || '';
      let showBackdrop = ep.backdrop || '';
      let showImdbId = ep.imdbId || '';
      let seasonPoster = ep.poster || '';

      const seasonsInfoRes = await fetch(ORIGIN + '/api/show-seasons?tmdbId=' + encodeURIComponent(ep.tmdbId), { cache: 'no-store' }).catch(() => null);
      if (seasonsInfoRes) {
        const siData = await seasonsInfoRes.json().catch(() => null);
        if (siData && siData.ok) {
          if (siData.imdbId) showImdbId = siData.imdbId;
          if (siData.poster) showPoster = siData.poster;
          if (siData.backdrop) showBackdrop = siData.backdrop;
          if (Array.isArray(siData.seasons)) {
            const matchSeason = siData.seasons.find((s) => s.season === ep.season);
            if (matchSeason && matchSeason.poster) seasonPoster = matchSeason.poster;
          }
        }
      }

      const epTitle = (epData && epData.name) ? epData.name : ep.title;
      const epRelease = (epData && epData.released) ? epData.released : undefined;
      const epThumbnail = (epData && epData.thumbnail) ? epData.thumbnail : (showBackdrop || seasonPoster || showPoster);

      fullOrderedItems.push({
        kind: 'episode',
        imdbId: channelStreamShowId(showImdbId || (epData && epData.imdbId), ep.tmdbId),
        season: ep.season,
        episode: ep.episode,
        showName: ep.showName,
        epName: epTitle,
        title: ep.showName + ' S' + ep.season + 'E' + ep.episode + ' \u2014 ' + epTitle,
        released: epRelease,
        thumbnail: epThumbnail,
        poster: seasonPoster || showPoster || epThumbnail || '',
        showPoster: showPoster || '',
        backdrop: showBackdrop || '',
        showBackdrop: showBackdrop || '',
        seasonNum: ep.season,
        episodeNum: ep.episode,
      });
    }
  }
  return { event, items: fullOrderedItems };
}

async function createInstantStorylineChannel(eventId, btn) {
  const event = TV_CROSSOVER_EVENTS.find((e) => e.id === eventId);
  if (!event) return;

  const originalText = btn ? btn.textContent : '';
  const chId = 'channel-' + event.id;
  const map = (typeof loadLocalChannels === 'function') ? (loadLocalChannels() || {}) : {};
  const isAlreadyAdded = !!map[chId] || (typeof isListAddedToConfig === 'function' && isListAddedToConfig(null, null, chId));

  if (isAlreadyAdded) {
    delete map[chId];
    if (typeof saveLocalChannelsMap === 'function') {
      saveLocalChannelsMap(map);
    }
    // removeListFromConfig doesn't know how to match a channel:v1:{...}
    // row at all -- it only recognizes custom:/autotrack:/customlist:v1:
    // URL schemes (see its own slug-matching logic), so calling it here
    // never actually found or removed this channel's row. The channel's
    // own entry in localChannels storage above was correctly cleaned up,
    // but the row stayed visible in the catalog/Live Preview whenever one
    // existed -- this is the same substring-match approach
    // deleteLocalChannel already uses successfully for the same URL
    // scheme (chId is embedded in the row's channel:v1: JSON payload).
    [...document.querySelectorAll('#lists .entry')].forEach((row) => {
      const urlInputs = [...row.querySelectorAll('.url')];
      urlInputs.forEach((u) => {
        if (u.value.includes(chId)) row.remove();
      });
    });
    if (typeof saveState === 'function') saveState();
    if (btn) {
      btn.textContent = '+ Add';
      btn.classList.remove('secondary', 'is-added');
      btn.classList.add('primary');
      btn.style.color = '';
    }
    if (typeof renderMyCreatedChannelsList === 'function') renderMyCreatedChannelsList();
    if (typeof showAddedToast === 'function') {
      showAddedToast('Removed "' + event.name + '" from your Channels.');
    }
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Adding\u2026';
  }

  try {
    const { items } = await fetchStorylineOrderedItems(eventId);
    if (!items || !items.length) {
      if (typeof showAppAlert === 'function') {
        showAppAlert('Storyline Builder', 'Could not resolve items for this saga.');
      }
      if (btn) {
        btn.disabled = false;
        btn.textContent = originalText;
      }
      return;
    }

    const firstWithPoster = items.find((it) => it.poster || it.thumbnail);
    const poster = firstWithPoster ? (firstWithPoster.poster || firstWithPoster.thumbnail) : null;
    const firstWithBackdrop = items.find((it) => it.backdrop || it.showBackdrop);
    const backdrop = firstWithBackdrop ? (firstWithBackdrop.backdrop || firstWithBackdrop.showBackdrop) : null;

    const channelPayload = {
      channelId: chId,
      name: event.name,
      poster: poster,
      backdrop: backdrop,
      items: items,
      shuffle: false,
      dailyRotate: false,
    };

    saveLocalChannel(channelPayload);

    if (typeof addRow === 'function') {
      addRow(event.name, 'channel:v1:' + JSON.stringify(channelPayload), 'series', true, 'Channels', chId);
    }

    if (typeof renderMyCreatedChannelsList === 'function') renderMyCreatedChannelsList();
    if (typeof renderChannelMergeList === 'function') renderChannelMergeList();

    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Remove';
      btn.classList.remove('primary');
      btn.classList.add('secondary', 'is-added');
      btn.style.color = 'var(--danger)';
    }

    if (typeof showAddedToast === 'function') {
      showAddedToast('Added "' + event.name + '" to your Channels & Catalogs!');
    }
  } catch (err) {
    if (typeof showAppAlert === 'function') {
      showAppAlert('Storyline Channel', 'Error adding channel: ' + (err.message || err));
    }
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }
}

async function loadStorylineToDraft(eventId, btn) {
  const originalText = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Loading items\u2026';
  }
  try {
    const { event, items } = await fetchStorylineOrderedItems(eventId);
    if (!event || !items.length) {
      if (typeof showAppAlert === 'function') {
        showAppAlert('Storyline Builder', 'Could not load items for this storyline.');
      }
      if (btn) {
        btn.disabled = false;
        btn.textContent = originalText;
      }
      return;
    }

    editingChannelId = null;
    editingChannelUrlInput = null;
    channelDraftItems = items.slice();
    const firstWithPoster = items.find((it) => it.poster || it.thumbnail);
    channelDraftPoster = firstWithPoster ? (firstWithPoster.poster || firstWithPoster.thumbnail) : null;
    const firstWithBackdrop = items.find((it) => it.backdrop || it.showBackdrop);
    channelDraftBackdrop = firstWithBackdrop ? (firstWithBackdrop.backdrop || firstWithBackdrop.showBackdrop) : null;

    const nameInput = document.getElementById('channelNameInput');
    if (nameInput) nameInput.value = event.name;
    setChannelPlayOrder('as-listed');

    renderChannelDraftList();
    updateChannelSaveButtonLabel();
    setChannelSearchType('tv', document.getElementById('channelSearchTypeShowsBtn'));

    switchChannelsSubmenu('build', null);
    const panel = document.getElementById('channelsSubBuild');
    if (panel) {
      panel.style.display = 'block';
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } catch (err) {
    if (typeof showAppAlert === 'function') {
      showAppAlert('Storyline Builder', 'Error loading storyline: ' + (err.message || err));
    }
  }
  if (btn) {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

function switchChannelsSubmenu(name, btn) {
  try {
    document.documentElement.removeAttribute('data-initial-channels-sub');
  } catch (e) {}
  if (btn) {
    document.querySelectorAll('#channelsSubnavBar .subnav-pill').forEach((p) => {
      p.classList.remove('active');
      const c = p.querySelector('.check-icon');
      if (c) c.remove();
    });
    btn.classList.add('active');
    btn.insertAdjacentHTML('afterbegin', '<span class="check-icon">&#x2713;</span> ');
  }

  const panels = {
    'my-channels': document.getElementById('channelsSubMyChannels'),
    'storylines': document.getElementById('channelsSubStorylines'),
    'quickadd': document.getElementById('channelsSubQuickAdd'),
    'explore': document.getElementById('channelsSubExplore'),
    'import': document.getElementById('channelsSubImport'),
    'build': document.getElementById('channelsSubBuild')
  };

  for (const key in panels) {
    if (panels[key]) {
      panels[key].style.display = (key === name) ? 'block' : 'none';
    }
  }

  try {
    localStorage.setItem('myListAddon:channelsSubmenu', name);
  } catch (e) {}

  if (name === 'my-channels') {
    renderMyCreatedChannelsList();
    renderChannelMergeList();
  } else if (name === 'storylines') {
    renderStorylinesUniverseList();
  } else if (name === 'explore') {
    loadChannelDirectory(false);
    renderChannelPublishList();
    loadOrphanedPublishedChannels();
  } else if (name === 'import') {
    renderChannelMergeList();
  }
}

function openBuildCustomChannel() {
  editingChannelId = null;
  editingChannelUrlInput = null;
  channelDraftItems = [];
  channelDraftPoster = null;
  channelDraftBackdrop = null;
  resetChannelDraftWorkspace();
  const nameInput = document.getElementById('channelNameInput');
  if (nameInput) nameInput.value = '';
  const descInput = document.getElementById('channelDescriptionInput');
  if (descInput) descInput.value = '';
  setChannelPlayOrder('as-listed');
  applyChannelBroadcastSettings(null);
  const searchInput = document.getElementById('channelSearchInput');
  if (searchInput) searchInput.value = '';
  const searchRes = document.getElementById('channelSearchResult');
  if (searchRes) searchRes.innerHTML = '';
  const epPicker = document.getElementById('channelEpisodePicker');
  if (epPicker) epPicker.innerHTML = '';
  renderChannelDraftList();
  updateChannelSaveButtonLabel();
  setChannelSearchType('tv', document.getElementById('channelSearchTypeShowsBtn'));
  switchChannelsSubmenu('build', null);
  const panel = document.getElementById('channelsSubBuild');
  if (panel) {
    panel.style.display = 'block';
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function editChannelById(channelId) {
  const map = loadLocalChannels();
  const channel = map[channelId];
  if (!channel) {
    if (typeof showAppAlert === 'function') {
      showAppAlert('Channel Builder', 'Channel not found.');
    } else {
      alert('Channel not found.');
    }
    return;
  }
  editingChannelId = channelId;
  editingChannelUrlInput = null;
  resetChannelDraftWorkspace();
  channelDraftItems = (channel.items || []).slice();
  channelDraftPoster = channel.poster || null;
  channelDraftBackdrop = channel.backdrop || null;
  
  const nameInput = document.getElementById('channelNameInput');
  if (nameInput) nameInput.value = channel.name || '';
  // A channel saved with the old "Sort by air date" flag is migrated here:
  // it becomes the equivalent dropdown selection, the render below sorts its
  // picks for real, and saveChannel then writes the sorted order with the
  // flag cleared. Until it is edited the Worker keeps sorting it, so nothing
  // changes for a channel nobody opens.
  setChannelPlayOrder(channel.shuffle ? 'shuffle-daily' : (channel.sortByAired ? 'aired-asc' : (channel.autoSort || 'as-listed')));
  applyChannelBroadcastSettings(channel);
  
  renderChannelDraftList();
  updateChannelSaveButtonLabel();
  setChannelSearchType('tv', document.getElementById('channelSearchTypeShowsBtn'));
  
  switchTab('channels');
  switchChannelsSubmenu('build', null);
  const panel = document.getElementById('channelsSubBuild');
  if (panel) {
    panel.style.display = 'block';
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  const searchInput = document.getElementById('channelSearchInput');
  if (searchInput) searchInput.focus();
}

function editChannel(btnOrRow) {
  const sourceRow = btnOrRow.closest ? btnOrRow.closest('.source-row') || btnOrRow : btnOrRow;
  const urlInput = sourceRow && sourceRow.querySelector('.url');
  if (!urlInput) {
    if (typeof showAppAlert === 'function') {
      showAppAlert('Channel Builder', 'Could not read this channel to edit it.');
    } else {
      alert('Could not read this channel to edit it.');
    }
    return;
  }
  const payload = parseChannelPayloadClient(urlInput.value);
  if (!payload) {
    if (typeof showAppAlert === 'function') {
      showAppAlert('Channel Builder', 'Could not read this channel to edit it.');
    } else {
      alert('Could not read this channel to edit it.');
    }
    return;
  }
  if (payload.channelId) {
    saveLocalChannel(payload);
    editChannelById(payload.channelId);
  } else {
    const channelId = generateChannelId();
    payload.channelId = channelId;
    saveLocalChannel(payload);
    editChannelById(channelId);
  }
}

// An item's air date, as a sortable "YYYY-MM-DD" string or '' -- the field
// the builder's air-date sorts order by, and the client twin of the Worker's
// channelItemAiredDate (05_catalog-core.js). Zero-padded ISO dates compare
// as plain strings, and an item with no date it can be placed by sorts as ''
// so callers can push it to the end.
//
// channelItemsInPlayOrder below is now only for a channel still carrying the
// pre-dropdown sortByAired flag, which the Worker sorts on every request:
// "See All" reads the saved items directly, so without this it would list
// such a channel in an order it does not play in. A channel saved since has
// its picks stored in the order they play, and falls straight through.
function channelItemAiredDateClient(it) {
  if (!it) return '';
  const raw = String(it.released == null ? '' : it.released).trim();
  const m = raw.match(/^([0-9]{4})(?:-([0-9]{2})(?:-([0-9]{2}))?)?/);
  if (m) return m[1] + '-' + (m[2] || '01') + '-' + (m[3] || '01');
  const year = parseInt(it.year, 10);
  if (Number.isInteger(year) && year > 0) return String(year).padStart(4, '0') + '-01-01';
  return '';
}

function channelItemsInPlayOrder(items, channel) {
  const list = Array.isArray(items) ? items : [];
  if (!channel || !channel.sortByAired || list.length < 2) return list;
  return list
    .map((it, i) => ({ it: it, i: i, aired: channelItemAiredDateClient(it) }))
    .sort((a, b) => {
      if (a.aired === b.aired) return a.i - b.i;
      if (!a.aired) return 1;
      if (!b.aired) return -1;
      return a.aired < b.aired ? -1 : 1;
    })
    .map((w) => w.it);
}

// channelOverride is a channel this browser does not own -- one fetched from
// Explore Channels, so it can be looked through before it is added. Every
// lookup below is about finding a channel that IS saved here, and none of
// them can find one that is not, so a caller holding the channel already
// hands it straight over.
function openChannelDetailsPage(channelIdOrDivId, channelOverride) {
  const map = loadLocalChannels();
  let channel = channelOverride || map[channelIdOrDivId];
  if (!channel) {
    for (const ch of Object.values(map)) {
      if (ch && (ch.channelId === channelIdOrDivId || ch.name === channelIdOrDivId)) {
        channel = ch;
        break;
      }
    }
  }
  if (!channel) {
    const div = document.getElementById(channelIdOrDivId);
    if (div) {
      const u = div.querySelector('.url');
      if (u) {
        try {
          const payload = JSON.parse(u.value.trim().slice('channel:v1:'.length));
          if (payload && payload.channelId && map[payload.channelId]) {
            channel = map[payload.channelId];
          } else if (payload) {
            channel = payload;
          }
        } catch (e) {}
      }
    }
  }
  if (!channel) {
    const rows = [...document.querySelectorAll('#lists .entry')];
    for (const row of rows) {
      if (row.dataset.channelId === channelIdOrDivId) {
        const u = row.querySelector('.url');
        if (u) {
          try {
            const payload = JSON.parse(u.value.trim().slice('channel:v1:'.length));
            if (payload) {
              channel = payload;
              break;
            }
          } catch (e) {}
        }
      }
    }
  }
  if (!channel) {
    const rows = [...document.querySelectorAll('#lists .entry')];
    for (const row of rows) {
      const u = row.querySelector('.url');
      if (u && u.value.includes(channelIdOrDivId)) {
        const lines = (u.value || '').split('\\n').map((s) => s.trim()).filter(Boolean);
        for (const line of lines) {
          if (line.startsWith('channel:v1:')) {
            try {
              const payload = JSON.parse(line.slice('channel:v1:'.length));
              if (payload && (payload.channelId === channelIdOrDivId || payload.name === channelIdOrDivId || u.value.includes(channelIdOrDivId))) {
                channel = payload;
                break;
              }
            } catch (e) {}
          }
        }
      }
      if (channel) break;
    }
  }
  if (!channel && typeof channelDraftItems !== 'undefined' && channelDraftItems.length && (typeof editingChannelId !== 'undefined' && editingChannelId === channelIdOrDivId)) {
    const nameInput = document.getElementById('channelNameInput');
    channel = {
      channelId: editingChannelId,
      name: (nameInput && nameInput.value) || 'TV Channel',
      items: channelDraftItems,
    };
  }
  if (!channel) return;

  // A channel reconstructed from a row is worth keeping in the in-memory
  // map, because it IS one of this browser's channels and the map is just
  // behind. A previewed one is not: it belongs to someone else and has not
  // been added, so writing it here would put it in My Channels for simply
  // having been looked at.
  if (!channelOverride && channel.channelId && (!map[channel.channelId] || (channel.items && channel.items.length > (map[channel.channelId].items || []).length))) {
    map[channel.channelId] = channel;
    _memoryChannelsMap = map;
  }
  
  // A merged channel (see mergeChannelsIntoRow/loadLocalMergedChannels)
  // stores channelIds -- references to the channels that were combined --
  // instead of its own flat items array. Reading channel.items directly
  // for one of these always came back empty, so "See All" on a merged
  // channel showed zero posters even though the underlying channels
  // themselves had plenty. Resolve items by concatenating each referenced
  // channel's own items when channelIds is what this channel actually has.
  let resolvedItems = channel.items;
  if ((!Array.isArray(resolvedItems) || !resolvedItems.length) && Array.isArray(channel.channelIds) && channel.channelIds.length) {
    const channelsMap = loadLocalChannels();
    resolvedItems = [];
    channel.channelIds.forEach((chId) => {
      const sourceChannel = channelsMap[chId];
      if (sourceChannel && Array.isArray(sourceChannel.items)) {
        resolvedItems.push(...sourceChannel.items);
      }
    });
  }
  
  const sample = channelItemsInPlayOrder(resolvedItems, channel).map((it, idx) => {
    let showName = it.showName || '';
    let epName = it.epName || '';
    let seasonEp = '';
    
    if (it.season != null && it.episode != null) {
      seasonEp = 'S' + it.season + 'E' + it.episode;
    }
    
    if (!showName && it.title) {
      if (it.title.indexOf(' S') !== -1 && it.title.indexOf('E') !== -1) {
        const sIdx = it.title.indexOf(' S');
        showName = it.title.slice(0, sIdx).trim();
        const rest = it.title.slice(sIdx + 1).trim();
        const dashIdx = rest.indexOf(' \u2014 ') !== -1 ? rest.indexOf(' \u2014 ') : (rest.indexOf(' - ') !== -1 ? rest.indexOf(' - ') : rest.indexOf(': '));
        if (dashIdx !== -1) {
          if (!seasonEp) seasonEp = rest.slice(0, dashIdx).trim();
          if (!epName) epName = rest.slice(dashIdx + (rest.indexOf(': ') === dashIdx ? 2 : 3)).trim();
        } else {
          if (!seasonEp) seasonEp = rest.trim();
        }
      } else if (it.title.indexOf(' \u2014 ') !== -1) {
        const parts = it.title.split(' \u2014 ');
        showName = parts[0].trim();
        if (!epName) epName = parts[1].trim();
      } else {
        showName = it.title.trim();
      }
    }
    if (!showName) showName = channel.name || 'TV Channel';
    
    if (!epName) {
      if (it.epName) {
        epName = it.epName;
      } else if (it.title && it.title !== showName) {
        epName = it.title;
      } else if (seasonEp) {
        epName = 'Episode ' + (it.episode != null ? it.episode : '');
      } else {
        epName = 'Episode';
      }
    }
    
    const displayTitle = seasonEp ? (showName + ' ' + seasonEp) : showName;
    const fullTitle = showName + (seasonEp ? ' ' + seasonEp : '') + (epName ? ' \u2014 ' + epName : '');

    return {
      id: channelItemId(it, idx),
      // Was hardcoded to 'series' unconditionally for every item -- fine
      // for a channel's actual episodes, but wrong for movie-saga channels
      // (MCU, Star Wars, etc.) where every item is a movie: clicking one
      // opened the details modal thinking it was a whole show, showing
      // "Mark Whole Show Watched" instead of "Mark as Watched". it.kind is
      // set to 'movie' for these by fetchStorylineOrderedItems when the
      // channel was first built (see its own comment there for why 'kind'
      // rather than 'type' is the field channel-draft items use).
      type: (it.kind === 'movie' || it.type === 'movie') ? 'movie' : 'series',
      name: displayTitle,
      subtitle: epName,
      title: fullTitle,
      poster: it.thumbnail || it.poster || it.showPoster || it.backdrop || channel.poster || channel.backdrop || '',
      thumbnail: it.thumbnail || it.backdrop || it.poster || it.showPoster || '',
      year: it.year || (it.released ? it.released.slice(0, 4) : ''),
    };
  });

// A channel item's id has to identify the EPISODE, not the show it belongs to.
//
// Every episode in a channel carries its show's imdbId/showId, so using that
// directly gave all 40 episodes of one show the same id. The list-details grid
// dedupes by id (appendItems, 23_client-list-management.js -- it is there to
// stop a provider that ignores its skip parameter from rendering the same
// page twice), so a channel collapsed to exactly one poster per distinct
// show: a 120-episode
// channel built from three shows showed three items, and no amount of adding
// episodes changed that.
//
// showId:season:episode is the shape the rest of the app already uses for an
// episode (handleSubtitlesTrack, fetchTmdbSeason), and every consumer that
// needs the show back already splits on the first colon -- the poster click
// handler in 19_client-search-and-likes.js and openItemDetailsModal in 23_
// both do, for tt-prefixed and numeric TMDB ids alike.
function channelItemId(it, idx) {
  const showId = it.imdbId || it.showId || it.id || '';
  if (showId && it.season != null && it.episode != null) {
    return showId + ':' + it.season + ':' + it.episode;
  }
  // No episode numbering: a movie-saga channel's items are already distinct
  // per show id, so it stands alone.
  if (showId) return showId;
  const fallbackName = it.showName || it.title || 'item';
  const seasonEp = (it.season != null && it.episode != null) ? ('S' + it.season + 'E' + it.episode) : '';
  return fallbackName + '-' + (seasonEp || idx);
}

  const channelUrl = channel.channelId ? ('channel:id:' + channel.channelId) : ('channel:v1:' + (channel.name || 'channel'));
  if (typeof openListDetailsPage === 'function') {
    openListDetailsPage(channel.name || 'TV Channel', 'series', channelUrl, { sample: sample, count: sample.length, maybeMore: false });
  }
}

function renderMyCreatedChannelsList() {
  const box = document.getElementById('myCreatedChannelsList');
  if (!box) return;
  
  const map = ensureAllChannelsSyncedFromRows(loadLocalChannels());
  const channels = Object.values(map);
  if (!channels.length) {
    box.innerHTML = '<p style="color:var(--muted); font-size:0.85rem;"><small>No channels created yet. Tap <strong>+ New Channel</strong> above or add a popular network in <strong>Quick Add</strong>.</small></p>';
    return;
  }
  
  renderChannelUndoBar();
  const sortSel = document.getElementById('myChannelsSortSelect');
  if (sortSel && sortSel.value !== myChannelsSort) sortSel.value = myChannelsSort;
  const shown = sortMyChannels(filterMyChannels(channels));
  if (!shown.length) {
    box.innerHTML = '<p style="color:var(--muted); font-size:0.85rem;"><small>No channel matches that search.</small></p>';
    return;
  }

  box.innerHTML = shown.map((ch) => {
    const isAdded = [...document.querySelectorAll('#lists .entry .url')].some((u) => u.value.includes(ch.channelId));
    const allItems = ch.items || [];
    const totalEpisodes = allItems.length;
    // Every rule a channel carries, spelled out on its card -- a channel
    // that hides watched episodes or locks a show behaves visibly
    // differently from one that does not, and the card is the only place
    // that is visible without opening the editor.
    const orderLabel = channelPlayOrderLabel(ch);
    const metaBits = ['24/7 TV Channel'];
    if (ch.dynamic === 'next-up') metaBits.push('fills itself in from Continue Watching');
    else metaBits.push(totalEpisodes + ' episode' + (totalEpisodes === 1 ? '' : 's'));
    if (ch.dailyRotate) {
      metaBits.push((ch.rotateShows || CHANNEL_DEFAULT_ROTATE_SHOWS) + ' shows \u00d7 ' +
        (ch.rotateEpisodes || CHANNEL_DEFAULT_ROTATE_EPISODES) + ' daily');
    }
    if (orderLabel) metaBits.push(orderLabel);
    if (ch.hideWatched) metaBits.push('hides watched');
    if ((ch.storyLocked || []).length) metaBits.push((ch.storyLocked || []).length + ' story-locked');
    if (ch.pairParts) metaBits.push('parts stay together');
    else if ((ch.pairedGroups || []).length) metaBits.push((ch.pairedGroups || []).length + ' paired');
    if (ch.autoNewEpisodes) metaBits.push('auto-adds new episodes' + (ch.newEpisodesAtTop ? ' at the top' : ''));
    if (ch.liveSync) metaBits.push('live cloud sync');
    if (ch.sharePublished) metaBits.push('published');
    const metaText = metaBits.map(escapeHtml).join(' &middot; ');
    // The second line: what this channel actually holds. Same function the
    // builder's own stats line uses, so a channel reads the same before and
    // after it is saved.
    const summaryLine = ch.dynamic === 'next-up' ? '' : channelSummaryLine(channelDraftSummary(allItems, ch));
    
    const allPosters = allItems.slice(0, 9);
    const posterThumbs = allPosters.map((it, i) => {
      const isMobileEnd = (i === 2 && allItems.length > 3);
      const isDesktopEnd = (i === allPosters.length - 1 && allItems.length >= 4);
      let overlays = '';
      if (isMobileEnd) {
        overlays += '<div class="list-card-count-overlay mobile-only" style="cursor:pointer;" onclick="event.stopPropagation(); openChannelDetailsPage(&quot;' + escapeJsAttr(ch.channelId) + '&quot;)">' + totalEpisodes + ' &rsaquo;</div>';
      }
      if (isDesktopEnd) {
        overlays += '<div class="list-card-count-overlay desktop-only" style="cursor:pointer;" onclick="event.stopPropagation(); openChannelDetailsPage(&quot;' + escapeJsAttr(ch.channelId) + '&quot;)">' + totalEpisodes + ' &rsaquo;</div>';
      }

      const p = it.thumbnail || it.poster || it.showPoster || it.backdrop || ch.poster || ch.backdrop || '';
      
      let showName = it.showName || '';
      let epName = it.epName || '';
      let seasonEp = '';
      
      if (it.season != null && it.episode != null) {
        seasonEp = 'S' + it.season + 'E' + it.episode;
      }
      
      if (!showName && it.title) {
        if (it.title.indexOf(' S') !== -1 && it.title.indexOf('E') !== -1) {
          const sIdx = it.title.indexOf(' S');
          showName = it.title.slice(0, sIdx).trim();
          const rest = it.title.slice(sIdx + 1).trim();
          const dashIdx = rest.indexOf(' \u2014 ') !== -1 ? rest.indexOf(' \u2014 ') : (rest.indexOf(' - ') !== -1 ? rest.indexOf(' - ') : rest.indexOf(': '));
          if (dashIdx !== -1) {
            if (!seasonEp) seasonEp = rest.slice(0, dashIdx).trim();
            if (!epName) epName = rest.slice(dashIdx + (rest.indexOf(': ') === dashIdx ? 2 : 3)).trim();
          } else {
            if (!seasonEp) seasonEp = rest.trim();
          }
        } else if (it.title.indexOf(' \u2014 ') !== -1) {
          const parts = it.title.split(' \u2014 ');
          showName = parts[0].trim();
          if (!epName) epName = parts[1].trim();
        } else {
          showName = it.title.trim();
        }
      }
      if (!showName) showName = ch.name;
      
      if (!epName) {
        if (it.epName) {
          epName = it.epName;
        } else if (it.title && it.title !== showName) {
          epName = it.title;
        } else if (seasonEp) {
          epName = 'Episode ' + (it.episode != null ? it.episode : '');
        } else {
          epName = 'Episode';
        }
      }
      
      const firstLine = seasonEp ? (showName + ' ' + seasonEp) : showName;
      const secondLine = epName;
      
      const imgHtml = p
        ? '<img src="' + escapeAttr(p) + '" alt="" loading="lazy">'
        : '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted);font-size:0.65rem;text-align:center;padding:4px;">No poster</div>';
      
      // Each tile opens that item's own details -- was previously
      // unclickable itself (only the shared container-level onclick below
      // fired, always sending every click to "See All" regardless of
      // which poster was actually tapped). "See All" is still one tap
      // away via the count overlay ("N ›") already rendered above, so
      // this doesn't remove that path, just stops it from being the only
      // one. Mirrors the same movie/series type fix as
      // openChannelDetailsPage just above (it.kind === 'movie', not
      // it.type, is what fetchStorylineOrderedItems actually sets).
      const itemId = it.imdbId || it.id || '';
      const itemType = (it.kind === 'movie' || it.type === 'movie') ? 'movie' : 'series';
      const posterClickAttr = itemId
        ? ' style="cursor:pointer;" onclick="event.stopPropagation(); openItemDetailsModal(&quot;' + escapeJsAttr(itemId) + '&quot;, &quot;' + itemType + '&quot;)"'
        : '';
      
      return '<div class="list-card-mini-poster-tile">' +
        '<div class="list-card-mini-poster-img-wrap"' + posterClickAttr + '>' +
          imgHtml +
          overlays +
        '</div>' +
        '<div class="list-card-mini-poster-name" title="' + escapeAttr(firstLine) + '">' + escapeHtml(firstLine) + '</div>' +
        '<div class="list-card-mini-poster-subtitle" title="' + escapeAttr(secondLine) + '">' + escapeHtml(secondLine) + '</div>' +
      '</div>';
    }).join('');
    
    const addBtnHtml = '<button type="button" class="lc-btn ' + (isAdded ? 'secondary' : 'primary') + '" style="padding:6px 12px; font-size:0.8rem;' + (isAdded ? ' color:var(--danger);' : '') + '" onclick="toggleChannelInCatalog(&quot;' + escapeJsAttr(ch.channelId) + '&quot;)">' +
      (isAdded ? 'Remove' : '+ Add') +
    '</button>';

    return '<div class="list-card" style="margin-bottom:12px;" data-channel-id="' + escapeAttr(ch.channelId) + '">' +
      '<div class="list-card-header">' +
        '<div class="list-card-body">' +
          '<div class="list-card-title" style="cursor:pointer;" onclick="openChannelDetailsPage(&quot;' + escapeJsAttr(ch.channelId) + '&quot;)" title="Open ' + escapeAttr(ch.name) + '">' +
            '<span class="drag-handle-list channel-drag-handle" draggable="true" title="Drag to reorder" onclick="event.stopPropagation();">&#x2630;</span>' +
            escapeHtml(ch.name) +
          '</div>' +
          (ch.description ? '<div style="font-size:0.8rem; color:var(--text); margin-top:2px;">' + escapeHtml(ch.description) + '</div>' : '') +
          '<div class="list-card-meta">' +
            '<span>' + metaText + '</span>' +
          '</div>' +
          (summaryLine ? '<div class="list-card-meta"><span>' + escapeHtml(summaryLine) + '</span></div>' : '') +
        '</div>' +
        '<div class="list-card-actions">' +
          '<button type="button" class="lc-btn secondary" style="padding:6px 12px; font-size:0.8rem;" onclick="editChannelById(&quot;' + escapeJsAttr(ch.channelId) + '&quot;)">Edit</button>' +
          '<button type="button" class="lc-btn secondary" style="padding:6px 12px; font-size:0.8rem;" onclick="deleteLocalChannel(&quot;' + escapeJsAttr(ch.channelId) + '&quot;, &quot;' + escapeJsAttr(ch.name) + '&quot;)">Delete</button>' +
          ((ch.sharePublished || ch.visibility === 'public')
            ? '<button type="button" class="lc-btn secondary" style="padding:6px 12px; font-size:0.8rem;" onclick="shareChannelById(&quot;' + escapeJsAttr(ch.channelId) + '&quot;, this)" title="Share this channel">Share</button>'
            : '') +
          addBtnHtml +
        '</div>' +
      '</div>' +
      (posterThumbs ? '<div class="list-card-posters poster-preview-static">' + posterThumbs + '</div>' : '') +
    '</div>';
  }).join('');
  initMyChannelsDrag();
}

function cancelEditChannel() {
  editingChannelId = null;
  editingChannelUrlInput = null;
  channelDraftItems = [];
  channelDraftPoster = null;
  channelDraftBackdrop = null;
  resetChannelDraftWorkspace();
  const nameInput = document.getElementById('channelNameInput');
  if (nameInput) nameInput.value = '';
  const descInput = document.getElementById('channelDescriptionInput');
  if (descInput) descInput.value = '';
  setChannelPlayOrder('as-listed');
  applyChannelBroadcastSettings(null);
  renderChannelDraftList();
  updateChannelSaveButtonLabel();
  switchChannelsSubmenu('my-channels', document.querySelector('#channelsSubnavBar button:nth-child(1)'));
}

function updateChannelSaveButtonLabel() {
  const saveBtn = document.getElementById('channelSaveBtn');
  const cancelBtn = document.getElementById('channelCancelEditBtn');
  const titleEl = document.getElementById('channelEditorTitle');
  const nameInput = document.getElementById('channelNameInput');
  const rawName = (nameInput ? nameInput.value : '').trim();
  if (titleEl) {
    if (editingChannelId || editingChannelUrlInput) {
      let chName = rawName;
      if (!chName && editingChannelId) {
        const map = (typeof loadLocalChannels === 'function') ? loadLocalChannels() : {};
        if (map[editingChannelId] && map[editingChannelId].name) chName = map[editingChannelId].name.trim();
      }
      if (!chName) chName = 'TV';
      if (!chName.toLowerCase().endsWith('channel')) chName += ' Channel';
      titleEl.textContent = 'Edit ' + chName;
    } else {
      titleEl.textContent = 'Build Custom Channel';
    }
  }
  if (!saveBtn) return;
  if (editingChannelId || editingChannelUrlInput) {
    saveBtn.textContent = 'Save';
    if (cancelBtn) {
      cancelBtn.textContent = 'Cancel';
      cancelBtn.style.display = '';
    }
  } else {
    saveBtn.textContent = 'Save';
    if (cancelBtn) cancelBtn.style.display = 'none';
  }
}

// Keep the editor title in sync as the channel name is edited
const _channelNameInputEl = document.getElementById('channelNameInput');
if (_channelNameInputEl) {
  _channelNameInputEl.addEventListener('input', updateChannelSaveButtonLabel);
}

document.addEventListener('click', (e) => {
  const quickBtn = e.target.closest('.channelQuickAddBtn');
  if (quickBtn) {
    quickAddChannel(quickBtn.dataset.name, quickBtn.dataset.listurl || null, quickBtn.dataset.networkid || null, quickBtn);
  }
});

// in parallel) rather than firing everything at once -- slower, but keeps
// a live "show 4 of 18" status line honest and avoids hammering either
// this Worker or TMDB with a burst of concurrent requests for a large
// lineup.
// Stremio has been observed to crash outright on a channel with 100,000+
// episodes -- a full network lineup list can include a handful of decades-
// long-running game shows, talk shows, or soaps that alone contribute
// thousands of episodes each, and nothing here was capping that. These two
// limits keep any single show from dominating a channel, and keep the
// channel's overall size well under whatever broke last time, with a
// comfortable safety margin.
const CHANNEL_MAX_EPISODES_PER_SHOW = 50;
const CHANNEL_MAX_TOTAL_ITEMS = 5000;
// Quick Add Channel (network-id based) stores a bigger pool than what's
// ever shown and marks the payload for daily rotation (see dailyRotate
// below and buildChannelMeta server-side) -- the server picks a fresh
// day's lineup from this pool on a schedule, so the channel's actual
// lineup changes over time instead of being permanently fixed to whatever
// happened to build first. This is the storage-side cap for that pool;
// CHANNEL_MAX_TOTAL_ITEMS above stays the safe upper bound (and the only
// cap that applies to the manual "Add every season" button, which has no
// pool/rotation concept).
const CHANNEL_POOL_MAX_ITEMS = 5000;
// The bar quickAddChannel uses to decide the server's cached network preset
// (up to 200 episodes -- see buildNetworkChannelPreset,
// 07_source-fetchers-tmdb-simkl.js) is "good enough to use" rather than
// falling through to building a channel live, show by show, in the browser.
// This used to compare against CHANNEL_POOL_MAX_ITEMS (5000) -- a preset can
// never reach that, since the server caps it at 200 on purpose, so that
// check was always false and Quick Add always took the slow client-built
// path, which has no cap of its own and could pull in thousands of items
// per network. Ten networks' worth of that easily blew past
// SAVED_CONFIG_BYTES_MAX (10 MB) when saving the install link.
const CHANNEL_PRESET_MIN_ITEMS = 20;
// What a rotating day's lineup actually looks like -- must match
// CHANNEL_ROTATION_SHOWS_PER_DAY / CHANNEL_ROTATION_EPISODES_PER_SHOW
// server-side. Used here only for display text (the real selection logic
// lives in buildChannelMeta).
const CHANNEL_ROTATION_SHOWS_PER_DAY = 24;
const CHANNEL_ROTATION_EPISODES_PER_SHOW = 3;

// --- turning a list of shows into channel picks -------------------------
//
// Three features now start from "here are some shows, make a channel out of
// them": Quick Add's network buttons, the Quick Channel Wizard, and an
// actor's TV credits in a Spotlight channel. All three need the same two
// rounds of fetching -- each show's seasons, then each season's episodes --
// and the same two caps, so it lives here once rather than three times.
//
// Never throws: a show whose seasons or episodes cannot be read is skipped
// and the rest of the channel is still built. One unreachable show is not a
// reason to hand back nothing.
async function buildChannelItemsFromShows(shows, opts) {
  const o = opts || {};
  const maxItems = o.maxItems || CHANNEL_POOL_MAX_ITEMS;
  const maxPerShow = o.maxEpisodesPerShow || CHANNEL_MAX_EPISODES_PER_SHOW;
  const onProgress = typeof o.onProgress === 'function' ? o.onProgress : null;
  const items = [];
  let poster = o.poster || null;
  let backdrop = o.backdrop || null;
  for (let i = 0; i < shows.length; i++) {
    if (items.length >= maxItems) break;
    const show = shows[i];
    if (onProgress) onProgress(i, shows.length, show);
    if (!poster && show.poster) poster = show.poster;
    if (!backdrop && (show.backdrop || show.thumbnail)) backdrop = show.backdrop || show.thumbnail;
    try {
      const seasonsRes = await fetch(ORIGIN + '/api/show-seasons?tmdbId=' + encodeURIComponent(show.tmdbId), { cache: 'no-store' });
      const seasonsData = await seasonsRes.json();
      if (!seasonsData.ok) continue;
      const seasonResults = await Promise.all(seasonsData.seasons.map((s) =>
        fetch(ORIGIN + '/api/show-episodes?tmdbId=' + encodeURIComponent(show.tmdbId) + '&season=' + encodeURIComponent(s.season), { cache: 'no-store' })
          .then((r) => r.json())
          .then((d) => ({ season: s.season, episodes: d.ok ? d.episodes : [] }))
          .catch(() => ({ season: s.season, episodes: [] }))
      ));
      const showEpisodes = [];
      seasonResults
        .sort((a, b) => a.season - b.season)
        .forEach(({ season, episodes }) => {
          episodes.forEach((ep) => {
            const stillUrl = ep.thumbnail || show.backdrop || show.poster || '';
            const showPosterUrl = show.poster || '';
            showEpisodes.push({
              kind: 'episode',
              imdbId: channelStreamShowId(show.imdbId, show.tmdbId),
              season: season,
              episode: ep.episode,
              showName: show.name || '',
              epName: ep.name || ('Episode ' + ep.episode),
              title: (show.name ? show.name + ' S' + season + 'E' + ep.episode + ' \u2014 ' : '') + (ep.name || ('Episode ' + ep.episode)),
              released: ep.released || '',
              runtime: ep.runtime || 0,
              thumbnail: stillUrl || showPosterUrl,
              poster: showPosterUrl || stillUrl,
              showPoster: showPosterUrl,
            });
          });
        });
      // The LAST maxPerShow episodes, not the first: a long-running show's
      // most recent seasons are the ones most likely to be watchable.
      let finalShowEpisodes = showEpisodes.length > maxPerShow
        ? showEpisodes.slice(-maxPerShow)
        : showEpisodes;
      const remainingBudget = maxItems - items.length;
      if (finalShowEpisodes.length > remainingBudget) {
        finalShowEpisodes = finalShowEpisodes.slice(0, remainingBudget);
      }
      items.push(...finalShowEpisodes);
    } catch (e) {
      continue;
    }
  }
  return { items: items, poster: poster, backdrop: backdrop };
}

async function quickAddChannel(name, listUrl, networkId, btn, options) {
  const statusBox = document.getElementById('channelQuickAddStatus');
  const originalLabel = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Adding ' + name + '\u2026';
  }
  if (statusBox) statusBox.innerHTML = '<p><small>Adding ' + escapeHtml(name) + '\u2026</small></p>';
  try {
    if (networkId) {
      try {
        const res = await fetch(ORIGIN + '/api/channel-preset?networkId=' + encodeURIComponent(networkId) + '&name=' + encodeURIComponent(name));
        const data = await res.json();
        if (data.ok && data.channel && Array.isArray(data.channel.items) && data.channel.items.length >= CHANNEL_PRESET_MIN_ITEMS) {
          const channelId = generateChannelId();
          // The full pool (up to CHANNEL_POOL_MAX_ITEMS episodes) is kept
          // locally for the My Channels editor -- saveLocalChannel gets it
          // in full, exactly as before. The saved CATALOG ROW is different:
          // it carries a slim pointer (name/poster/art + presetNetworkId),
          // never the pool itself, so this channel's real weight lives in
          // the shared channel:preset:v2:<networkId> cache instead of in
          // every install link that adds it -- see parseChannelPayload and
          // channelSourceItems (05_catalog-core.js) for how that pointer
          // resolves back to the full pool at serve time.
          const payload = Object.assign({}, data.channel, { channelId: channelId, name: name, liveSync: false, sourceUrl: '' });
          saveLocalChannel(payload);
          const pointerPayload = {
            channelId: channelId,
            name: name,
            poster: data.channel.poster,
            backdrop: data.channel.backdrop,
            presetNetworkId: networkId,
            shuffle: false,
            dailyRotate: true,
            liveSync: false,
            sourceUrl: '',
          };
          addRow(name, 'channel:v1:' + JSON.stringify(pointerPayload), 'series', true, 'Channels', channelId);
          renderMyCreatedChannelsList();
          renderChannelMergeList();
          showAddedToast('Channel "' + name + '" added to your Catalogs.');
          if (statusBox) {
            statusBox.innerHTML = '<p class="testresult ok" style="margin:4px 0 0;">\u2713 Channel "' + escapeHtml(name) + '" added (' + (payload.items ? payload.items.length : 0) + ' episodes with daily rotation)!</p>';
            setTimeout(() => {
              if (statusBox) statusBox.innerHTML = '';
            }, 4000);
          }
          return;
        }
      } catch (e) {}
    }

    let params = networkId ? ('networkId=' + encodeURIComponent(networkId)) : ('url=' + encodeURIComponent(listUrl));
    const keys = collectKeys();
    if (keys.mdblistKey) params += '&mdblistKey=' + encodeURIComponent(keys.mdblistKey);
    if (keys.traktKey) params += '&traktKey=' + encodeURIComponent(keys.traktKey);
    if (keys.traktAccessToken) params += '&traktAccessToken=' + encodeURIComponent(keys.traktAccessToken);
    
    const res = await fetch(ORIGIN + '/api/quick-channel-shows?' + params, { cache: 'no-store' });
    const data = await res.json();
    if (!data.ok) {
      if (typeof showAppAlert === 'function') {
        showAppAlert('Could Not Build Channel', 'Could not build ' + name + ': ' + (data.error || 'unknown error'));
      } else {
        alert('Could not build ' + name + ': ' + (data.error || 'unknown error'));
      }
      return;
    }

    const shows = data.shows.slice();
    for (let i = shows.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = shows[i];
      shows[i] = shows[j];
      shows[j] = tmp;
    }
    const built = await buildChannelItemsFromShows(shows, {
      poster: data.networkLogo || null,
      onProgress: function (i, total, show) {
        if (statusBox) {
          statusBox.innerHTML = '<p><small>Building ' + escapeHtml(name) + '\u2026 show ' + (i + 1) + ' of ' + total +
            ' (' + escapeHtml(show.name) + ')</small></p>';
        }
      },
    });
    const items = built.items;
    const poster = built.poster;
    const backdrop = built.backdrop;
    if (!items.length) {
      if (typeof showAppAlert === 'function') {
        showAppAlert('Could Not Build Channel', 'Could not build ' + name + ' -- no episodes were found.');
      } else {
        alert('Could not build ' + name + ' -- no episodes were found.');
      }
      return;
    }
    const channelId = generateChannelId();
    const payload = {
      channelId: channelId,
      name: name,
      poster: poster,
      backdrop: backdrop || poster,
      items: items,
      shuffle: false,
      dailyRotate: true,
      // Live Cloud Sync, when this came from a pasted list link and the
      // Import tab's toggle was left on: the channel keeps the URL, and the
      // Worker rebuilds its pool from that list in the background instead of
      // this staying the one-time snapshot it used to be.
      liveSync: !!(options && options.liveSync && listUrl),
      sourceUrl: (options && options.liveSync && listUrl) ? listUrl : '',
    };
    saveLocalChannel(payload);
    addRow(name, 'channel:v1:' + JSON.stringify(payload), 'series', true, 'Channels', channelId);
    renderMyCreatedChannelsList();
    renderChannelMergeList();
    showAddedToast('Channel "' + name + '" added to your Catalogs.');
    if (statusBox) {
      statusBox.innerHTML = '<p class="testresult ok" style="margin:4px 0 0;">\u2713 Channel "' + escapeHtml(name) + '" added (' + items.length + ' episodes with daily rotation)!</p>';
      setTimeout(function() {
        if (statusBox) statusBox.innerHTML = '';
      }, 4000);
    }
  } catch (e) {
    if (typeof showAppAlert === 'function') {
      showAppAlert('Network Error', 'Network error while adding ' + name + '.');
    } else {
      alert('Network error while adding ' + name + '.');
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }
}

// Companion to the fixed Quick Add network buttons above -- same
// quickAddChannel machinery, just fed a pasted list link instead of a
// TMDB network id. The server side (/api/quick-channel-shows) requests
// type "series" from that link regardless of source, so any movies mixed
// into the list are silently dropped rather than erroring out.
async function importChannelFromLink(btn) {
  const urlInput = document.getElementById('channelImportUrlInput');
  const nameInput = document.getElementById('channelImportNameInput');
  const listUrl = urlInput.value.trim();
  const name = nameInput.value.trim();
  if (!listUrl) {
    if (typeof showAppAlert === 'function') {
      showAppAlert('Import Channel', 'Paste a list URL first.');
    } else {
      alert('Paste a list URL first.');
    }
    return;
  }
  if (!name) {
    if (typeof showAppAlert === 'function') {
      showAppAlert('Import Channel', 'Name this channel first.');
    } else {
      alert('Name this channel first.');
    }
    return;
  }
  const liveCheck = document.getElementById('channelImportLiveSyncCheck');
  await quickAddChannel(name, listUrl, null, btn, { liveSync: !liveCheck || liveCheck.checked });
  urlInput.value = '';
  nameInput.value = '';
}


// --- the Next Up channel ------------------------------------------------
//
// One channel that always plays the next unwatched episode of everything on
// the go. Unlike every other channel it stores no picks at all: the payload
// carries dynamic:'next-up' and the Worker derives the lineup from the
// account's own Continue Watching on each request (see channelNextUpItems,
// 05_catalog-core.js), so it follows what is actually being watched rather
// than freezing the day it was made.
//
// That also means it only works signed in with Auto-track playback on --
// there is no other way for this Worker to know what has been watched -- so
// this says so up front rather than saving a channel that would come back
// empty.
const NEXT_UP_CHANNEL_NAME = 'Next Up';

// The picks a Next Up channel is SEEDED with, out of this browser's own
// Continue Watching list.
//
// The Worker re-derives the lineup per request and that stays the channel's
// real answer -- but it can only do so for an install config that proved
// which account it speaks for (see trackOwner in resolveConfig), and a
// config with no personal shelf in it does not. A channel that stored
// nothing therefore came back EMPTY for exactly the people most likely to
// try it first. Seeding fixes that: the channel works the moment it is
// saved, and the Worker's live answer replaces the seed whenever it has one.
function channelNextUpSeedItems() {
  let cw = [];
  try {
    const map = (typeof loadLocalCustomLists === 'function') ? loadLocalCustomLists() : {};
    const list = map && map['continue-watching'];
    cw = (list && Array.isArray(list.items)) ? list.items : [];
  } catch (e) {
    cw = [];
  }
  const out = [];
  const seen = {};
  cw.forEach((it) => {
    if (!it) return;
    const showId = String(it.showId || it.imdbId || '').trim();
    const season = Number(it.seasonNum);
    const episode = Number(it.episodeNum);
    if (!showId || !Number.isInteger(season) || !Number.isInteger(episode)) return;
    const key = showId + ':' + season + ':' + episode;
    if (seen[key]) return;
    seen[key] = true;
    const showName = String(it.showTitle || '').trim();
    const epName = String(it.name || '').trim() || ('Episode ' + episode);
    const poster = it.showPoster || it.poster || '';
    out.push({
      kind: 'episode',
      imdbId: showId,
      season: season,
      episode: episode,
      showName: showName,
      epName: epName,
      title: showName ? (showName + ' S' + season + 'E' + episode + ' — ' + epName) : epName,
      released: it.released || '',
      thumbnail: poster,
      poster: poster,
      showPoster: poster,
    });
  });
  return out;
}

// Re-seeds a saved Next Up channel from Continue Watching as it stands now,
// and rewrites the catalog row that carries it. What the card's Refresh
// button does.
function refreshNextUpChannelSeed(channelId, btn) {
  const map = loadLocalChannels();
  const ch = map[channelId];
  if (!ch || ch.dynamic !== 'next-up') return 0;
  const items = channelNextUpSeedItems();
  ch.items = items;
  saveLocalChannelsMap(map);
  const payload = Object.assign({}, ch, { items: items });
  const rows = [...document.querySelectorAll('#lists .entry')];
  rows.forEach((row) => {
    [...row.querySelectorAll('.url')].forEach((u) => {
      if (String(u.value || '').indexOf(channelId) !== -1) u.value = 'channel:v1:' + JSON.stringify(payload);
    });
  });
  if (typeof saveState === 'function') saveState();
  renderMyCreatedChannelsList();
  if (btn) {
    btn.textContent = items.length + ' up next ✓';
    setTimeout(() => { if (btn) btn.textContent = 'Refresh'; }, 1800);
  }
  return items.length;
}

function createNextUpChannel(btn) {
  const status = document.getElementById('channelNextUpStatus');
  const say = (html) => { if (status) status.innerHTML = html; };
  const signedIn = (typeof activeCreator !== 'undefined' && !!activeCreator);
  if (!signedIn) {
    say('<p class="testresult err" style="margin:4px 0 0;">✗ A Next Up channel reads your watch history, so it needs a Creator Profile with Auto-track playback switched on.</p>');
    return;
  }
  const map = loadLocalChannels();
  const already = Object.values(map).find((ch) => ch && ch.dynamic === 'next-up');
  if (already) {
    say('<p class="testresult ok" style="margin:4px 0 0;">You already have one — "' + escapeHtml(already.name) + '".</p>');
    openChannelDetailsPage(already.channelId);
    return;
  }
  if (btn) btn.disabled = true;
  try {
    const channelId = generateChannelId();
    const seed = channelNextUpSeedItems();
    const firstWithArt = seed.find((it) => it && (it.showPoster || it.poster || it.thumbnail));
    const posterArt = firstWithArt
      ? (firstWithArt.showPoster || firstWithArt.poster || firstWithArt.thumbnail)
      : (ORIGIN + '/api/channel-poster?name=' + encodeURIComponent(NEXT_UP_CHANNEL_NAME) + '&v=6');
    const payload = {
      channelId: channelId,
      name: NEXT_UP_CHANNEL_NAME,
      poster: posterArt,
      backdrop: null,
      // A seed, not the answer. The Worker re-derives the lineup on every
      // request and that replaces this -- but only for a config that can
      // prove whose it is, so this is what the channel plays until then and
      // what it falls back to if that proof is ever missing.
      items: seed,
      shuffle: false,
      autoSort: '',
      sortByAired: false,
      dailyRotate: false,
      dynamic: 'next-up',
    };
    saveLocalChannel(payload);
    addRow(NEXT_UP_CHANNEL_NAME, 'channel:v1:' + JSON.stringify(payload), 'series', true, 'Channels', channelId);
    if (typeof saveState === 'function') saveState();
    if (typeof renderLivePreview === 'function') renderLivePreview();
    renderMyCreatedChannelsList();
    renderChannelMergeList();
    showAddedToast('"' + NEXT_UP_CHANNEL_NAME + '" added to your Catalogs.');
    const seeded = payload.items.length;
    say('<p class="testresult ok" style="margin:4px 0 0;">✓ "' + NEXT_UP_CHANNEL_NAME + '" added with ' + seeded +
      ' show' + (seeded === 1 ? '' : 's') + ' up next, and it refreshes itself from Continue Watching as you watch.' +
      (seeded ? '' : ' Nothing is in progress yet — it fills in once you have started something.') + '</p>');
    setTimeout(() => { if (status) status.innerHTML = ''; }, 8000);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// --- the Quick Channel Wizard -------------------------------------------
//
// Network x era x genre -> a finished 24/7 channel. The server answers with
// a list of shows (see /api/wizard-channel-shows) and the rest is the same
// path Quick Add's network buttons take, so a wizard channel behaves
// exactly like one of those: a rotating daily lineup out of a large pool.
function channelWizardName() {
  const typed = (document.getElementById('channelWizardNameInput') || {}).value;
  if (typed && typed.trim()) return typed.trim();
  const pick = (id) => {
    const sel = document.getElementById(id);
    if (!sel || !sel.value) return '';
    return sel.options[sel.selectedIndex].textContent.trim();
  };
  const network = pick('channelWizardNetwork');
  const era = pick('channelWizardEra');
  const genre = pick('channelWizardGenre');
  const parts = [era, network, genre].filter(Boolean);
  return parts.length ? parts.join(' ') : 'My Channel';
}

async function runChannelWizard(btn) {
  const statusBox = document.getElementById('channelWizardStatus');
  const say = (html) => { if (statusBox) statusBox.innerHTML = html; };
  const networkId = (document.getElementById('channelWizardNetwork') || {}).value || '';
  const era = (document.getElementById('channelWizardEra') || {}).value || '';
  const genres = (document.getElementById('channelWizardGenre') || {}).value || '';
  const limit = parseInt((document.getElementById('channelWizardSize') || {}).value, 10) || 8;
  if (!networkId && !era && !genres) {
    say('<p class="testresult err" style="margin:4px 0 0;">✗ Choose at least one of network, era or genre first.</p>');
    return;
  }
  const name = channelWizardName();
  const originalLabel = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Building…';
  }
  try {
    say('<p><small>Finding the top shows for ' + escapeHtml(name) + '…</small></p>');
    let params = 'limit=' + encodeURIComponent(limit);
    if (networkId) params += '&networkId=' + encodeURIComponent(networkId);
    if (era) params += '&era=' + encodeURIComponent(era);
    if (genres) params += '&genres=' + encodeURIComponent(genres);
    const res = await fetch(ORIGIN + '/api/wizard-channel-shows?' + params, { cache: 'no-store' });
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.shows) || !data.shows.length) {
      say('<p class="testresult err" style="margin:4px 0 0;">✗ ' + escapeHtml(data.error || 'Nothing matched that combination.') + '</p>');
      return;
    }
    const built = await buildChannelItemsFromShows(data.shows, {
      poster: data.networkLogo || null,
      onProgress: function (i, total, show) {
        say('<p><small>Building ' + escapeHtml(name) + '… show ' + (i + 1) + ' of ' + total +
          ' (' + escapeHtml(show.name || '') + ')</small></p>');
      },
    });
    if (!built.items.length) {
      say('<p class="testresult err" style="margin:4px 0 0;">✗ Found those shows but could not read any episodes for them.</p>');
      return;
    }
    const channelId = generateChannelId();
    const payload = {
      channelId: channelId,
      name: name,
      poster: built.poster,
      backdrop: built.backdrop || built.poster,
      items: built.items,
      shuffle: false,
      // A wizard channel is a pool, not a playlist, so it rotates like a
      // network channel -- and interleaves, which is what makes a lineup of
      // eight shows read as a block rather than eight blocks in a row.
      autoSort: 'interleave',
      dailyRotate: true,
    };
    saveLocalChannel(payload);
    addRow(name, 'channel:v1:' + JSON.stringify(payload), 'series', true, 'Channels', channelId);
    renderMyCreatedChannelsList();
    renderChannelMergeList();
    showAddedToast('Channel "' + name + '" added to your Catalogs.');
    say('<p class="testresult ok" style="margin:4px 0 0;">✓ "' + escapeHtml(name) + '" built from ' + data.shows.length +
      ' shows (' + built.items.length + ' episodes), rotating a fresh lineup daily.</p>');
    const nameInput = document.getElementById('channelWizardNameInput');
    if (nameInput) nameInput.value = '';
  } catch (e) {
    say('<p class="testresult err" style="margin:4px 0 0;">✗ Network error while building that channel.</p>');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }
}

// --- the Quick List Wizard (Catalogs Quick Add) --------------------------
//
// Network/studio x era x genre -> separate lists for movies and shows
// (not combined). The server answers with resolved titles from TMDB,
// and the client adds them directly to the user's Catalogs as customlist:v1:
// rows, saving them into local custom lists so they can also be edited.
function catalogWizardName(customSuffix) {
  const typed = (document.getElementById('catalogWizardNameInput') || {}).value;
  if (typed && typed.trim()) {
    const t = typed.trim();
    return customSuffix ? (t.toLowerCase().endsWith(customSuffix.toLowerCase()) ? t : t + ' ' + customSuffix) : t;
  }
  const pick = (id) => {
    const sel = document.getElementById(id);
    if (!sel || !sel.value) return '';
    return sel.options[sel.selectedIndex].textContent.trim();
  };
  const network = pick('catalogWizardNetwork');
  const era = pick('catalogWizardEra');
  const genre = pick('catalogWizardGenre');
  const parts = [era, network, genre].filter(Boolean);
  const base = parts.length ? parts.join(' ') : 'My List';
  return customSuffix ? base + ' ' + customSuffix : base;
}

async function fetchWizardTitles(type, networkId, era, genres, limit) {
  let params = 'type=' + encodeURIComponent(type) + '&limit=' + encodeURIComponent(limit);
  if (networkId) params += '&networkId=' + encodeURIComponent(networkId);
  if (era) params += '&era=' + encodeURIComponent(era);
  if (genres) params += '&genres=' + encodeURIComponent(genres);
  const res = await fetch(ORIGIN + '/api/wizard-channel-shows?' + params, { cache: 'no-store' });
  const data = await res.json();
  if (!data.ok || !Array.isArray(data.items || data.shows) || !(data.items || data.shows).length) {
    throw new Error(data.error || 'Nothing matched that combination.');
  }
  return data.items || data.shows;
}

function addCatalogWizardList(name, items, type) {
  const channelId = generateChannelId();
  const baseSlug = (typeof slugify === 'function' ? slugify(name) : name.toLowerCase().replace(/[^a-z0-9]+/g, '-')) || 'list';
  let slug = baseSlug;
  const localMap = typeof loadLocalCustomLists === 'function' ? loadLocalCustomLists() : {};
  let n = 2;
  while (localMap[slug]) {
    slug = baseSlug + '-' + n;
    n++;
  }
  const cleanItems = items.map((it) => ({
    imdbId: it.imdbId,
    title: it.name || it.title || 'Untitled',
    year: it.year || undefined,
    poster: it.poster || undefined,
    type: type,
  }));
  const payload = {
    listId: channelId,
    localSlug: slug,
    listSlug: slug,
    name: name,
    type: type,
    items: cleanItems,
    shuffle: false,
  };
  if (typeof saveLocalCustomListsMap === 'function') {
    localMap[slug] = {
      slug: slug,
      name: name,
      type: type,
      items: cleanItems,
      visibility: 'unlisted',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    saveLocalCustomListsMap(localMap);
    if (typeof scheduleCreatorSyncSave === 'function') scheduleCreatorSyncSave();
  }
  addRow(name, 'customlist:v1:' + JSON.stringify(payload), type, true, 'Custom Lists');
  saveState();
}

async function runCatalogListWizard(targetType, btn) {
  const statusBox = document.getElementById('catalogWizardStatus');
  const say = (html) => { if (statusBox) statusBox.innerHTML = html; };
  const networkId = (document.getElementById('catalogWizardNetwork') || {}).value || '';
  const era = (document.getElementById('catalogWizardEra') || {}).value || '';
  const genres = (document.getElementById('catalogWizardGenre') || {}).value || '';
  const limit = parseInt((document.getElementById('catalogWizardSize') || {}).value, 10) || 20;

  if (!networkId && !era && !genres) {
    say('<p class="testresult err" style="margin:4px 0 0;">✗ Choose at least one of network/studio, era or genre first.</p>');
    return;
  }

  const originalLabel = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Building…';
  }

  try {
    if (targetType === 'both') {
      say('<p><small>Finding top movies and shows for your lists…</small></p>');
      const movieName = catalogWizardName('(Movies)');
      const showName = catalogWizardName('(Shows)');

      let movieItems = [];
      let showItems = [];
      let movieErr = null;
      let showErr = null;

      try {
        movieItems = await fetchWizardTitles('movie', networkId, era, genres, limit);
      } catch (err) {
        movieErr = err.message;
      }

      try {
        showItems = await fetchWizardTitles('series', networkId, era, genres, limit);
      } catch (err) {
        showErr = err.message;
      }

      if (!movieItems.length && !showItems.length) {
        say('<p class="testresult err" style="margin:4px 0 0;">✗ ' + escapeHtml(movieErr || showErr || 'Nothing matched that combination.') + '</p>');
        return;
      }

      const addedDesc = [];
      if (movieItems.length) {
        addCatalogWizardList(movieName, movieItems, 'movie');
        addedDesc.push(movieItems.length + ' movies ("' + escapeHtml(movieName) + '")');
      }
      if (showItems.length) {
        addCatalogWizardList(showName, showItems, 'series');
        addedDesc.push(showItems.length + ' shows ("' + escapeHtml(showName) + '")');
      }

      if (typeof renderLivePreview === 'function') renderLivePreview();
      showAddedToast('Added separate lists: ' + addedDesc.join(' and ') + ' to Catalogs.');
      say('<p class="testresult ok" style="margin:4px 0 0;">✓ Built ' + addedDesc.join(' and ') + ' as separate catalog rows (not combined).</p>');
    } else {
      const isMovie = targetType === 'movie';
      const suffix = isMovie ? '(Movies)' : '(Shows)';
      const listName = catalogWizardName(suffix);
      say('<p><small>Finding top ' + (isMovie ? 'movies' : 'shows') + ' for ' + escapeHtml(listName) + '…</small></p>');

      const items = await fetchWizardTitles(targetType, networkId, era, genres, limit);
      addCatalogWizardList(listName, items, targetType);
      if (typeof renderLivePreview === 'function') renderLivePreview();
      showAddedToast('List "' + listName + '" added to your Catalogs.');
      say('<p class="testresult ok" style="margin:4px 0 0;">✓ "' + escapeHtml(listName) + '" built from ' + items.length + ' ' + (isMovie ? 'movies' : 'shows') + ' and added to your Catalogs.</p>');
    }
    const nameInput = document.getElementById('catalogWizardNameInput');
    if (nameInput) nameInput.value = '';
  } catch (e) {
    say('<p class="testresult err" style="margin:4px 0 0;">✗ ' + escapeHtml(e.message || 'Network error while building lists.') + '</p>');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }
}

// --- Spotlight channels (an actor, a director, a creator) ---------------
//
// Searching a PERSON answers a different question from searching a title,
// so it gets its own result card and its own builder: pick someone and the
// whole channel -- their best films plus the shows they were in -- is put
// together in one go, rather than searching and adding fifteen titles by
// hand.
let channelSpotlightSort = 'chronological';

function setChannelSpotlightSort(value) {
  channelSpotlightSort = value === 'rating' ? 'rating' : 'chronological';
}

async function runChannelPersonSearch(q) {
  const box = document.getElementById('channelSearchResult');
  box.innerHTML = '<p><small>Searching…</small></p>';
  try {
    const res = await fetch(ORIGIN + '/api/person-search?q=' + encodeURIComponent(q), { cache: 'no-store' });
    const data = await res.json();
    if (!data.ok) {
      box.innerHTML = '<p class="testresult err">✗ ' + escapeHtml(data.error || 'Search failed.') + '</p>';
      return;
    }
    renderChannelPersonResults(data.results || []);
  } catch (e) {
    box.innerHTML = '<p class="testresult err">✗ Network error while searching.</p>';
  }
}

function renderChannelPersonResults(results) {
  const box = document.getElementById('channelSearchResult');
  if (!results.length) {
    box.innerHTML = '<p style="color:var(--muted); font-size:0.85rem;"><small>No one by that name.</small></p>';
    return;
  }
  const cards = results.map((p) => {
    const img = p.poster
      ? '<img class="preview-thumb" src="' + escapeAttr(p.poster) + '" alt="" loading="lazy" style="cursor:pointer;">'
      : '<div class="preview-thumb" style="display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:0.7rem;text-align:center;padding:4px;cursor:pointer;">No photo</div>';
    const data = ' data-personid="' + escapeAttr(String(p.personId)) + '" data-personname="' + escapeAttr(p.name) + '"';
    return '<div class="custom-list-search-item channelPersonCard" style="display:flex; flex-direction:column; align-items:center; width:100%; min-width:0; cursor:pointer;"' + data + '>' +
      img +
      '<div style="width:100%; font-size:0.75rem; font-weight:600; text-align:center; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin:4px 0 1px;" title="' + escapeAttr(p.name) + '">' + escapeHtml(p.name) + '</div>' +
      '<div style="font-size:0.7rem; color:var(--muted); text-align:center; margin-bottom:4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; width:100%;" title="' + escapeAttr(p.knownFor || p.department || '') + '">' +
        escapeHtml(p.knownFor || p.department || '') +
      '</div>' +
      '<button type="button" class="lc-btn secondary channelPersonBtn" style="width:100%; padding:4px 6px; font-size:0.75rem;"' + data + '>+ Browse</button>' +
      '</div>';
  }).join('');
  box.innerHTML = '<div class="poster-grid-3" style="margin-top:10px;">' + cards + '</div>';
}

// --- browsing one person's filmography ----------------------------------
//
// The same shape as browsing a show: tap the card and everything they have
// been in opens BELOW, where each title can be added on its own -- rather
// than the whole channel being committed in one click, which gave no way to
// drop the one film you have seen too often.
//
// A film is added directly. A TV credit hands off to browseChannelShow, so
// picking seasons and episodes of a show someone was in is the same journey
// as picking them from the Shows tab, with the same controls.
let channelPersonCredits = null;

async function browseChannelPerson(personId, personName) {
  const box = document.getElementById('channelEpisodePicker');
  if (!box) return;
  box.innerHTML = '<p><small>Loading ' + escapeHtml(personName || 'their') + '\u2019s filmography\u2026</small></p>';
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const res = await fetch(ORIGIN + '/api/person-credits?personId=' + encodeURIComponent(personId) +
      '&sort=' + encodeURIComponent(channelSpotlightSort) + '&movies=120&shows=60', { cache: 'no-store' });
    const data = await res.json();
    if (!data.ok) {
      box.innerHTML = '<p class="testresult err">\u2717 ' + escapeHtml(data.error || 'Could not read that filmography.') + '</p>';
      return;
    }
    channelPersonCredits = {
      personId: String(personId),
      name: data.name || personName || '',
      poster: data.poster || null,
      backdrop: data.backdrop || null,
      movies: data.movies || [],
      shows: data.shows || [],
    };
    renderChannelPersonCredits();
  } catch (e) {
    box.innerHTML = '<p class="testresult err">\u2717 Network error loading that filmography.</p>';
  }
}

// The sort is a property of the whole filmography, so changing it re-asks
// the server rather than re-ordering here: which credits make the cut is
// decided by popularity and only their ORDER is the sort, so sorting a
// fetched page locally would be sorting the wrong forty titles.
function setChannelSpotlightSortAndReload(value) {
  setChannelSpotlightSort(value);
  if (channelPersonCredits) browseChannelPerson(channelPersonCredits.personId, channelPersonCredits.name);
}

function channelPersonCreditCardHtml(credit, isShow) {
  const poster = credit.poster || '';
  const img = poster
    ? '<img class="preview-thumb" src="' + escapeAttr(poster) + '" alt="" loading="lazy">'
    : '<div class="preview-thumb" style="display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:0.7rem;text-align:center;padding:4px;">No poster</div>';
  const data =
    ' data-tmdbid="' + escapeAttr(String(credit.tmdbId)) + '"' +
    ' data-title="' + escapeAttr(credit.title) + '"' +
    ' data-year="' + escapeAttr(credit.year || '') + '"' +
    ' data-poster="' + escapeAttr(poster) + '"' +
    ' data-backdrop="' + escapeAttr(credit.backdrop || '') + '"';
  const cardClass = isShow ? 'channelPersonShowCard' : 'channelPersonMovieCard';
  const btnClass = isShow ? 'channelPersonShowBtn' : 'channelPersonMovieBtn';
  const btnLabel = isShow ? '+ Their episodes' : '+ Add';
  const sub = [credit.year, credit.role].filter(Boolean).join(' \u00b7 ');
  return '<div class="custom-list-search-item ' + cardClass + '" style="display:flex; flex-direction:column; align-items:center; width:100%; min-width:0; cursor:pointer;"' + data + '>' +
    img +
    '<div style="width:100%; font-size:0.75rem; font-weight:600; text-align:center; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin:4px 0 1px;" title="' + escapeAttr(credit.title) + '">' +
      escapeHtml(credit.title) +
    '</div>' +
    '<div style="font-size:0.7rem; color:var(--muted); text-align:center; margin-bottom:4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; width:100%;" title="' + escapeAttr(sub) + '">' + escapeHtml(sub) + '</div>' +
    '<button type="button" class="lc-btn secondary ' + btnClass + '" style="width:100%; padding:4px 6px; font-size:0.75rem;"' + data + '>' + btnLabel + '</button>' +
    '</div>';
}

function renderChannelPersonCredits() {
  const box = document.getElementById('channelEpisodePicker');
  if (!box || !channelPersonCredits) return;
  const c = channelPersonCredits;
  if (!c.movies.length && !c.shows.length) {
    box.innerHTML = '<p class="testresult err">\u2717 TMDB has no credits we can build a channel from for ' + escapeHtml(c.name) + '.</p>';
    return;
  }
  const header =
    '<div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:10px;">' +
      '<p style="margin:0; font-weight:600; font-size:0.9rem; flex:1; min-width:160px;">' +
        escapeHtml(c.name) + ' \u2014 ' + c.movies.length + ' film' + (c.movies.length === 1 ? '' : 's') +
        (c.shows.length ? ' and ' + c.shows.length + ' show' + (c.shows.length === 1 ? '' : 's') : '') +
      '</p>' +
      '<label for="channelSpotlightSortSelect" style="font-size:0.8rem; font-weight:600;">Order:</label>' +
      '<select id="channelSpotlightSortSelect" onchange="setChannelSpotlightSortAndReload(this.value)" style="font-size:0.82rem; padding:5px 8px; background:var(--surface); color:var(--text); border:1px solid var(--border); border-radius:8px;">' +
        '<option value="chronological"' + (channelSpotlightSort === 'chronological' ? ' selected' : '') + '>Career order</option>' +
        '<option value="rating"' + (channelSpotlightSort === 'rating' ? ' selected' : '') + '>Best first</option>' +
      '</select>' +
    '</div>' +
    '<div class="actions" style="flex-wrap:wrap; margin-bottom:10px;">' +
      '<button type="button" class="secondary channelPersonAddAllBtn">Add everything as a Spotlight channel</button>' +
    '</div>';
  const movies = c.movies.length
    ? '<p style="margin:10px 0 4px; font-weight:600; font-size:0.85rem;">Films</p>' +
      '<div class="poster-grid-3">' + c.movies.map((m) => channelPersonCreditCardHtml(m, false)).join('') + '</div>'
    : '';
  const shows = c.shows.length
    ? '<p style="margin:14px 0 4px; font-weight:600; font-size:0.85rem;">Television</p>' +
      '<p style="margin:0 0 6px; color:var(--muted); font-size:0.78rem;">The button adds only the episodes they are actually in. Tap the poster instead to pick seasons and episodes yourself, the same way you would from the Shows tab.</p>' +
      '<div class="poster-grid-3">' + c.shows.map((sh) => channelPersonCreditCardHtml(sh, true)).join('') + '</div>' +
      '<div id="channelEpisodeList"></div>'
    : '<div id="channelEpisodeList"></div>';
  box.innerHTML = header + movies + shows;
}

// "Add everything as a Spotlight channel".
//
// Everything means everything: every film listed above, and every episode of
// every show listed above that this person is ACTUALLY in -- not a slice of
// each, and not a show's opening episodes because they happened to appear in
// one of them (see /api/person-show-episodes, which is what settles which
// episodes those are).
//
// The whole lot is then ordered TOGETHER by the chosen sort. Films first and
// television after was the old shape, and it read as broken: a 1994 guest
// appearance played after a 2021 film in what was supposed to be career
// order. Sorting the items rather than the credits is what puts each episode
// where it actually belongs among the films.
function spotlightItemSortDate(it) {
  return channelItemAiredDateClient(it) || '';
}

function sortSpotlightItems(items, mode) {
  const wrapped = items.map((it, i) => ({ it: it, i: i }));
  if (mode === 'rating') {
    // An episode has no rating of its own worth ranking by, so it inherits
    // its show's -- which keeps a show's run together, in broadcast order,
    // sitting where that show ranks among the films.
    wrapped.sort((a, b) => {
      const ra = Number(a.it.spotlightRating) || 0;
      const rb = Number(b.it.spotlightRating) || 0;
      if (ra !== rb) return rb - ra;
      return a.i - b.i;
    });
  } else {
    wrapped.sort((a, b) => {
      const da = spotlightItemSortDate(a.it);
      const db = spotlightItemSortDate(b.it);
      if (da === db) return a.i - b.i;
      // Undated last, never first: being unable to place something is no
      // reason to open a tribute with it. Same call sortChannelItemsByAired
      // makes server-side.
      if (!da) return 1;
      if (!db) return -1;
      return da < db ? -1 : 1;
    });
  }
  return wrapped.map((w) => {
    const out = Object.assign({}, w.it);
    delete out.spotlightRating;
    return out;
  });
}

// Adds one show's worth of a person's own episodes -- the per-show version
// of what "Add everything" does, for when only that credit is wanted.
async function addPersonShowEpisodes(tmdbId, showTitle, showPoster, btn, duplicateChecked) {
  if (!channelPersonCredits) return;
  const c = channelPersonCredits;
  if (!duplicateChecked && guardChannelDraftDuplicate(
    showTitle || 'That show',
    channelDraftCountForShow('', showTitle),
    () => addPersonShowEpisodes(tmdbId, showTitle, showPoster, btn, true)
  )) return;
  const originalLabel = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Finding\u2026';
  }
  try {
    const r = await fetch(ORIGIN + '/api/person-show-episodes?personId=' + encodeURIComponent(c.personId) +
      '&tmdbId=' + encodeURIComponent(tmdbId), { cache: 'no-store' });
    const d = await r.json();
    if (!d.ok || !Array.isArray(d.episodes) || !d.episodes.length) {
      if (btn) btn.textContent = 'None found';
      setTimeout(() => { if (btn) btn.textContent = originalLabel; }, 1800);
      return;
    }
    const poster = d.poster || showPoster || '';
    const showName = d.showName || showTitle || '';
    const items = d.episodes.map((ep) => ({
      kind: 'episode',
      imdbId: channelStreamShowId(d.imdbId, tmdbId),
      season: ep.season,
      episode: ep.episode,
      showName: showName,
      epName: ep.name,
      title: showName + ' S' + ep.season + 'E' + ep.episode + ' \u2014 ' + ep.name,
      released: ep.released || '',
      runtime: ep.runtime || 0,
      thumbnail: ep.thumbnail || poster,
      poster: poster || ep.thumbnail || '',
      showPoster: poster,
    }));
    channelDraftItems = channelDraftItems.concat(items);
    renderChannelDraftList();
    updateChannelSaveButtonLabel();
    if (btn) {
      btn.textContent = '+' + items.length + ' \u2713';
      setTimeout(() => { if (btn) btn.textContent = originalLabel; }, 1800);
    }
  } catch (e) {
    if (btn) btn.textContent = 'Failed';
    setTimeout(() => { if (btn) btn.textContent = originalLabel; }, 1800);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function addWholeSpotlightToDraft(btn) {
  if (!channelPersonCredits) return;
  const c = channelPersonCredits;
  const box = document.getElementById('channelEpisodePicker');
  const say = (html) => { if (box) box.innerHTML = html; };
  const originalLabel = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Building\u2026';
  }
  try {
    // A film needs its IMDB id resolved one by one: a channel item's id IS
    // the stream request (see channelItemStreamId server-side), so a movie
    // with no id would play as nothing.
    const movieItems = [];
    for (let i = 0; i < c.movies.length; i++) {
      const m = c.movies[i];
      say('<p><small>Resolving films\u2026 ' + (i + 1) + ' of ' + c.movies.length + ' (' + escapeHtml(m.title) + ')</small></p>');
      try {
        const r = await fetch(ORIGIN + '/api/resolve-movie?tmdbId=' + encodeURIComponent(m.tmdbId), { cache: 'no-store' });
        const d = await r.json();
        if (!d.ok || !d.imdbId) continue;
        movieItems.push({
          kind: 'movie',
          imdbId: d.imdbId,
          tmdbId: m.tmdbId,
          title: m.title,
          year: m.year || '',
          showName: m.title,
          epName: 'Movie',
          released: m.released || (m.year ? m.year + '-01-01' : ''),
          runtime: d.runtime || 0,
          thumbnail: m.backdrop || m.poster || '',
          poster: m.poster || '',
          showPoster: m.poster || '',
          backdrop: m.backdrop || '',
          spotlightRating: m.rating || 0,
        });
      } catch (e) {
        continue;
      }
    }

    const episodeItems = [];
    let guestShows = 0;
    for (let i = 0; i < c.shows.length; i++) {
      const sh = c.shows[i];
      say('<p><small>Finding ' + escapeHtml(c.name) + '\u2019s episodes\u2026 show ' + (i + 1) + ' of ' + c.shows.length +
        ' (' + escapeHtml(sh.title) + ')</small></p>');
      try {
        const r = await fetch(ORIGIN + '/api/person-show-episodes?personId=' + encodeURIComponent(c.personId) +
          '&tmdbId=' + encodeURIComponent(sh.tmdbId), { cache: 'no-store' });
        const d = await r.json();
        if (!d.ok || !Array.isArray(d.episodes) || !d.episodes.length) continue;
        if (!d.regular) guestShows++;
        const showPoster = d.poster || sh.poster || '';
        const showName = d.showName || sh.title || '';
        d.episodes.forEach((ep) => {
          episodeItems.push({
            kind: 'episode',
            imdbId: channelStreamShowId(d.imdbId, sh.tmdbId),
            season: ep.season,
            episode: ep.episode,
            showName: showName,
            epName: ep.name,
            title: showName + ' S' + ep.season + 'E' + ep.episode + ' \u2014 ' + ep.name,
            released: ep.released || '',
            runtime: ep.runtime || 0,
            thumbnail: ep.thumbnail || showPoster,
            poster: showPoster || ep.thumbnail || '',
            showPoster: showPoster,
            spotlightRating: sh.rating || 0,
          });
        });
      } catch (e) {
        continue;
      }
    }

    const items = sortSpotlightItems(movieItems.concat(episodeItems), channelSpotlightSort);
    if (!items.length) {
      say('<p class="testresult err">\u2717 Could not resolve any of ' + escapeHtml(c.name) + '\u2019s credits to something playable.</p>');
      return;
    }
    channelDraftItems = channelDraftItems.concat(items);
    if (!channelDraftPoster) channelDraftPoster = c.poster || (c.movies[0] && c.movies[0].poster) || null;
    if (!channelDraftBackdrop) channelDraftBackdrop = c.backdrop || null;
    const nameInput = document.getElementById('channelNameInput');
    if (nameInput && !nameInput.value.trim()) nameInput.value = c.name + ' Spotlight';
    // The items have just been put in the order that was asked for, so the
    // draft stays "As listed" -- arming an auto-sort here would re-sort them
    // on the next render and throw that ordering away.
    setChannelPlayOrder('as-listed');
    renderChannelDraftList();
    updateChannelSaveButtonLabel();
    say('<p class="testresult ok" style="margin:4px 0 0;">\u2713 Added ' + movieItems.length + ' film' + (movieItems.length === 1 ? '' : 's') +
      (episodeItems.length ? ' and ' + episodeItems.length + ' episode' + (episodeItems.length === 1 ? '' : 's') : '') +
      ', ' + (channelSpotlightSort === 'rating' ? 'best first' : 'in career order') + '.' +
      (guestShows ? ' Guest appearances are only the episodes ' + escapeHtml(c.name) + ' is in.' : '') +
      ' Tune the picks below, then Save.</p>');
  } catch (e) {
    say('<p class="testresult err">\u2717 Network error while building that spotlight.</p>');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }
}

// --- sharing a channel, and the Explore Channels directory --------------
//
// A channel is thousands of episodes, so a share link cannot carry it: what
// travels is a short code, and the channel itself is stored server-side
// under channelshare:{code} (see /api/channel/share). Pasting the link -- or
// opening it -- rebuilds the channel here, picks, play order, broadcast
// schedule and all.
//
// Sharing is unlisted and needs no account. PUBLISHING to the directory
// does need a Creator Profile, so every listing has an owner who can take it
// back down.

// Every field a share carries. Kept out of channelBroadcastFields because
// these say where a channel has BEEN rather than how it plays -- but carried
// through the same three persistence points for the same reason: a field
// only two of the three know about is a field that disappears on the next
// save.
function channelShareFields(src) {
  const o = src || {};
  return {
    shareCode: String(o.shareCode || ''),
    sharePublished: !!o.sharePublished,
    visibility: (o.visibility === 'private' || o.sharePublished === false) ? 'private' : 'public',
    owner: String(o.owner || ''),
  };
}

function channelShareUrl(code, ch) {
  let chObj = ch;
  if (!chObj && typeof loadLocalChannels === 'function') {
    const map = loadLocalChannels();
    for (const k in map) {
      if (map[k] && map[k].shareCode === code) {
        chObj = map[k];
        break;
      }
    }
  }
  const creator = (chObj && chObj.owner) || (typeof activeCreator !== 'undefined' && activeCreator && activeCreator.creatorName);
  const name = chObj && chObj.name;
  const base = ORIGIN.endsWith('/') ? ORIGIN.slice(0, -1) : ORIGIN;
  if (creator && name && (chObj.sharePublished || chObj.visibility === 'public')) {
    const slug = typeof slugify === 'function' ? slugify(name) : encodeURIComponent(name.toLowerCase().split(' ').join('-'));
    return base + '/channels/' + encodeURIComponent(creator) + '/' + slug;
  }
  return base + '/channel/' + encodeURIComponent(code);
}

// The code inside whatever got pasted: a full share URL, a "channel:share:"
// prefix, the fragment a share link redirects to, or the bare code.
function parseChannelShareCode(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (text.includes('/channels/')) {
    const parts = text.split('/channels/')[1].split('?')[0].split('#')[0].split('/');
    if (parts.length >= 2 && parts[0] && parts[1]) {
      const cleanSlug = parts[1].toLowerCase().endsWith('.json') ? parts[1].slice(0, -5) : parts[1];
      return 'channels:' + parts[0] + ':' + cleanSlug;
    }
  }
  if (text.includes('/channel/')) {
    const part = text.split('/channel/')[1].split('?')[0].split('#')[0].split('/')[0];
    if (part && /^[A-Za-z0-9_-]{1,64}$/.test(part)) return part;
  }
  const fromHash = text.match(/[#&?]channel=([A-Za-z0-9_-]{1,64})/);
  if (fromHash) return fromHash[1];
  const fromScheme = text.match(/^channel:share:([A-Za-z0-9_-]{1,64})$/);
  if (fromScheme) return fromScheme[1];
  return /^[A-Za-z0-9_-]{1,64}$/.test(text) ? text : '';
}

// The payload a share sends. Deliberately NOT the stored record: a saved
// channel carries local bookkeeping (createdAt, the share code itself) that
// has no meaning on anyone else's device.
function channelSharePayload(ch) {
  let poster = ch.poster || null;
  let backdrop = ch.backdrop || null;
  if (!poster && !backdrop) {
    if (ch.dynamic === 'next-up' && typeof channelNextUpSeedItems === 'function') {
      const seed = channelNextUpSeedItems();
      const firstWithArt = seed.find((it) => it && (it.showPoster || it.poster || it.thumbnail));
      if (firstWithArt) {
        poster = firstWithArt.showPoster || firstWithArt.poster || firstWithArt.thumbnail;
      }
    }
    if (!poster && !backdrop) {
      poster = ORIGIN + '/api/channel-poster?name=' + encodeURIComponent(ch.name || 'Channel') + '&v=6';
    }
  }
  return Object.assign({
    name: ch.name,
    poster: poster,
    backdrop: backdrop,
    items: ch.items || [],
    shuffle: !!ch.shuffle,
    autoSort: ch.autoSort || '',
    sortByAired: !!ch.sortByAired,
  }, channelBroadcastFields(ch));
}

async function postChannelShare(ch, opts) {
  const o = opts || {};
  const body = {
    channel: channelSharePayload(ch),
    code: ch.shareCode || '',
    description: o.description || '',
    publish: !!o.publish,
  };
  // Credentials go with a re-share too, not only with a publish.
  //
  // Re-sharing writes over an existing record, and a record created by
  // PUBLISHING has an owner -- so an unlisted re-share that proved nothing
  // was refused as "that share link belongs to someone else", by its own
  // owner. Sent whenever they are available: an unlisted share of a channel
  // nobody has published still needs nothing, and the server only uses them
  // to decide who is writing.
  const signedIn = (typeof activeCreator !== 'undefined' && !!activeCreator);
  if (signedIn && (o.publish || ch.shareCode)) {
    body.creatorName = activeCreator.creatorName;
    body.creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
  }
  const res = await fetch(ORIGIN + '/api/channel/share', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// Remembers the code on the local channel, so sharing the same channel again
// after an edit updates the link people already have rather than minting a
// second one beside it.
function rememberChannelShare(channelId, code, published) {
  const map = loadLocalChannels();
  const ch = map[channelId];
  if (!ch) return;
  ch.shareCode = code;
  ch.sharePublished = !!published;
  saveLocalChannelsMap(map);
}

function showSavedChannelModal(channelName, visibility, url) {
  const isPrivate = visibility === 'private';
  showModal(
    '<div class="modal-body">' +
      '<button type="button" class="modal-close-x" aria-label="Close" onclick="closeModal()">\u2715</button>' +
      '<h2 class="panel-title" style="margin-top:0;">\u2713 Channel Saved</h2>' +
      '<p style="margin:8px 0 16px; font-size:0.9rem; color:var(--text);">' +
        '<strong>' + escapeHtml(channelName || 'Channel') + '</strong> has been saved to your Profile as a <strong>' + (isPrivate ? 'private' : 'public') + '</strong> channel.' +
      '</p>' +
      (isPrivate
        ? '<div style="padding:12px 14px; background:rgba(0,122,255,0.08); border:1px solid rgba(0,122,255,0.2); border-radius:10px; margin-bottom:16px;">' +
            '<p style="margin:0; font-size:0.84rem; color:var(--text);">Only you can see this channel from your profile when logged in.</p>' +
          '</div>'
        : '<div style="margin-bottom:16px;">' +
            '<p style="margin:0 0 8px; font-size:0.84rem; color:var(--muted);">Public share link:</p>' +
            '<div style="display:flex; gap:8px; align-items:center;">' +
              '<input type="text" id="savedChannelUrlInput" value="' + escapeAttr(url || '') + '" readonly style="flex:1; padding:10px 12px; font-size:0.88rem; border-radius:8px; border:1px solid var(--border); background:var(--bg); color:var(--text);">' +
              '<button type="button" class="lc-btn primary" id="savedChannelCopyBtn" onclick="copyShareUrlById(&quot;savedChannelUrlInput&quot;, this)" style="white-space:nowrap; padding:10px 14px;">Copy Link</button>' +
            '</div>' +
          '</div>'
      ) +
      '<div class="actions" style="margin-top:16px; flex-direction:row; justify-content:flex-end; gap:8px;">' +
        (!isPrivate && url ? '<a href="' + escapeAttr(url) + '" target="_blank" class="button secondary lc-btn" style="text-decoration:none; display:inline-flex; align-items:center;">Open Link &nearr;</a>' : '') +
        '<button type="button" class="primary lc-btn" onclick="closeModal()">Done</button>' +
      '</div>' +
    '</div>'
  );
}

// Copies the link a channel already has, without re-uploading it.
//
// The modal that appears after sharing or publishing is not a place to keep
// something: it closes, and the link goes with it. A channel that has a code
// carries this button from then on, so the link is always one tap away.
async function copyChannelShareLink(channelId, btn) {
  const map = loadLocalChannels();
  const ch = map[channelId];
  if (!ch || !ch.shareCode) return;
  const link = channelShareUrl(ch.shareCode, ch);
  let copied = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(link);
      copied = true;
    }
  } catch (e) {
    copied = false;
  }
  if (copied) {
    if (btn) {
      const label = btn.textContent;
      btn.textContent = 'Copied \u2713';
      setTimeout(() => { if (btn) btn.textContent = label; }, 1600);
    }
    showAddedToast('Link to "' + ch.name + '" copied.');
    return;
  }
  showSavedChannelModal(ch.name, ch.visibility || 'public', link);
}

async function shareChannelById(channelId, btn) {
  const map = loadLocalChannels();
  const ch = map[channelId];
  if (!ch) return;
  const originalLabel = btn ? btn.textContent : 'Share';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Sharing…';
  }
  const isPub = (ch.visibility === 'public' || ch.sharePublished);
  try {
    const data = await postChannelShare(ch, { publish: false });
    if (!data.ok) {
      showAppAlert('Share Channel', data.error || 'Could not create a share link for that channel.');
      return;
    }
    rememberChannelShare(channelId, data.code, data.published);
    const link = data.url || channelShareUrl(data.code, ch);
    showSavedChannelModal(ch.name, isPub ? 'public' : 'private', link);
    renderMyCreatedChannelsList();
  } catch (e) {
    showAppAlert('Share Channel', 'Network error while creating that share link.');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }
}

// Saves a shared channel locally and adds it to Catalogs. Shared by the
// Import tab, the Explore Channels cards and the share-link deep link, so
// all three land a channel the same way.
function acceptSharedChannel(channel, code) {
  const channelId = generateChannelId();
  const payload = Object.assign({}, channel, {
    channelId: channelId,
    // The code travels with the copy so its owner's later edits can be
    // pulled in again, but sharePublished stays false: this copy is not the
    // one listed in the directory, and marking it so would offer an
    // "Unpublish" that belongs to someone else.
    shareCode: code || '',
    sharePublished: false,
  });
  saveLocalChannel(payload);
  addRow(payload.name, 'channel:v1:' + JSON.stringify(payload), 'series', true, 'Channels', channelId);
  if (typeof saveState === 'function') saveState();
  if (typeof renderLivePreview === 'function') renderLivePreview();
  renderMyCreatedChannelsList();
  renderChannelMergeList();
  showAddedToast('Channel "' + payload.name + '" added to your Catalogs.');
  return channelId;
}

async function fetchSharedChannel(code) {
  if (code && typeof code === 'string' && code.startsWith('channels:')) {
    const parts = code.split(':');
    const u = parts[1] || '';
    const s = parts[2] || '';
    const res = await fetch(ORIGIN + '/channels/' + encodeURIComponent(u) + '/' + encodeURIComponent(s) + '.json', { cache: 'no-store' });
    return res.json();
  }
  const res = await fetch(ORIGIN + '/api/channel/share?code=' + encodeURIComponent(code), { cache: 'no-store' });
  return res.json();
}

async function importSharedChannel(btn) {
  const input = document.getElementById('channelShareCodeInput');
  const statusBox = document.getElementById('channelShareImportStatus');
  const say = (html) => { if (statusBox) statusBox.innerHTML = html; };
  const code = parseChannelShareCode(input ? input.value : '');
  if (!code) {
    say('<p class="testresult err" style="margin:4px 0 0;">✗ That does not look like a channel share link or code.</p>');
    return;
  }
  const originalLabel = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Adding…';
  }
  try {
    say('<p><small>Fetching that channel…</small></p>');
    const data = await fetchSharedChannel(code);
    if (!data.ok || !data.channel) {
      say('<p class="testresult err" style="margin:4px 0 0;">✗ ' + escapeHtml(data.error || 'That channel link could not be read.') + '</p>');
      return;
    }
    acceptSharedChannel(data.channel, code);
    say('<p class="testresult ok" style="margin:4px 0 0;">✓ "' + escapeHtml(data.channel.name || 'Channel') + '" added (' +
      (data.channel.items || []).length + ' picks).</p>');
    if (input) input.value = '';
  } catch (e) {
    say('<p class="testresult err" style="margin:4px 0 0;">✗ Network error while fetching that channel.</p>');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }
}

// A share link opened directly lands on /configure#channel=<code> (see the
// /channel/<code> redirect in 25_api-catalog-routes.js). Picking it up here
// rather than at the server keeps the code out of the request URL, and
// therefore out of any log: for an unlisted channel the code is the only
// thing standing between it and everyone.
async function handleChannelShareDeepLink() {
  let code = '';
  try {
    code = parseChannelShareCode(window.location.hash || '');
  } catch (e) {
    code = '';
  }
  if (!code) return false;
  try {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  } catch (e) {}
  switchTab('channels');
  switchChannelsSubmenu('import', document.querySelector('#channelsSubnavBar [data-sub="import"]'));
  const input = document.getElementById('channelShareCodeInput');
  if (input) input.value = code;
  await importSharedChannel(null);
  return true;
}

// --- the directory ------------------------------------------------------
let _channelDirectoryEntries = null;
let _channelDirectoryLoading = false;
let _channelDirectorySort = 'newest';
// Which listings this browser has voted for. The server is authoritative --
// its ledger is what decides -- but the heart has to fill in before a round
// trip or it flickers on every render.
let _channelDirectoryLiked = {};

function setChannelDirectorySort(value) {
  const next = value || 'newest';
  if (next === _channelDirectorySort) return;
  _channelDirectorySort = next;
  // The ORDER is the server's to decide -- it sees likes and adds from every
  // visitor, this page sees one page of them -- so a change re-asks rather
  // than re-sorting what is already here.
  loadChannelDirectory(true);
}

async function loadChannelDirectory(force) {
  const feed = document.getElementById('channelDirectoryFeed');
  if (_channelDirectoryLoading) return;
  if (_channelDirectoryEntries && !force) {
    renderChannelDirectory();
    return;
  }
  _channelDirectoryLoading = true;
  if (feed) feed.innerHTML = '<p style="color:var(--muted); font-size:0.85rem;"><small>Loading published channels…</small></p>';
  try {
    const res = await fetch(ORIGIN + '/api/channel/directory?limit=60&sort=' + encodeURIComponent(_channelDirectorySort),
      { cache: force ? 'no-store' : 'default' });
    const data = await res.json();
    _channelDirectoryEntries = (data && data.ok && Array.isArray(data.channels)) ? data.channels : [];
  } catch (e) {
    _channelDirectoryEntries = null;
    if (feed) feed.innerHTML = '<p class="testresult err">✗ Could not reach the channel directory just now.</p>';
    _channelDirectoryLoading = false;
    return;
  }
  _channelDirectoryLoading = false;
  renderChannelDirectory();
}

function channelDirectoryMetaLine(entry) {
  const bits = [];
  if (entry.dynamic === 'next-up') bits.push('follows its owner’s watch history');
  else bits.push(entry.itemCount + ' episode' + (entry.itemCount === 1 ? '' : 's'));
  if (entry.showCount > 1) bits.push(entry.showCount + ' shows');
  if (entry.dailyRotate) bits.push('daily lineup');
  else if (entry.shuffle) bits.push('shuffled daily');
  if (entry.autoSort === 'interleave') bits.push('interleaved');
  if (entry.owner) bits.push('by ' + entry.owner);
  if (entry.adds) bits.push(entry.adds + ' added');
  return bits.join(' · ');
}

function renderChannelDirectory() {
  const feed = document.getElementById('channelDirectoryFeed');
  if (!feed) return;
  const entries = _channelDirectoryEntries || [];
  if (!entries.length) {
    feed.innerHTML = '<p style="color:var(--muted); font-size:0.85rem;"><small>Nothing published yet. Build a channel and be the first — publish it from the panel below.</small></p>';
    return;
  }
  const filterInput = document.getElementById('channelDirectorySearchInput');
  const q = (filterInput ? filterInput.value : '').trim().toLowerCase();
  const shown = q
    ? entries.filter((e) => (
        String(e.name || '').toLowerCase().indexOf(q) !== -1 ||
        String(e.description || '').toLowerCase().indexOf(q) !== -1 ||
        String(e.owner || '').toLowerCase().indexOf(q) !== -1
      ))
    : entries;
  if (!shown.length) {
    feed.innerHTML = '<p style="color:var(--muted); font-size:0.85rem;"><small>No published channel matches that.</small></p>';
    return;
  }
  const localChannelsMap = (typeof loadLocalChannels === 'function') ? loadLocalChannels() : {};
  const catalogRows = typeof document !== 'undefined' ? [...document.querySelectorAll('#lists .entry')] : [];
  function isDirectoryChannelAdded(code) {
    if (!code) return false;
    let targetChannelId = null;
    for (const id in localChannelsMap) {
      if (localChannelsMap[id] && localChannelsMap[id].shareCode === code) {
        targetChannelId = id;
        break;
      }
    }
    for (const row of catalogRows) {
      if (targetChannelId && row.dataset.channelId === targetChannelId) return true;
      if (row.dataset.shareCode === code) return true;
      const urlInputs = [...row.querySelectorAll('.url')];
      for (const u of urlInputs) {
        const val = u.value || '';
        if (!val) continue;
        if (val.includes(code)) return true;
        if (targetChannelId && val.includes(targetChannelId)) return true;
        if (val.startsWith('channel:v1:')) {
          try {
            const p = JSON.parse(val.slice('channel:v1:'.length));
            if (p && (p.shareCode === code || (targetChannelId && p.channelId === targetChannelId))) return true;
          } catch (_) {}
        }
      }
    }
    return false;
  }
  feed.innerHTML = shown.map((e) => {
    const isAdded = isDirectoryChannelAdded(e.code);
    const actionBtn = isAdded
      ? '<button type="button" class="lc-btn secondary" style="padding:6px 12px; font-size:0.8rem; color:var(--danger); border-color:var(--danger);" onclick="removeDirectoryChannel(&quot;' + escapeJsAttr(e.code) + '&quot;, this)">Remove</button>'
      : '<button type="button" class="lc-btn primary" style="padding:6px 12px; font-size:0.8rem;" onclick="addDirectoryChannel(&quot;' + escapeJsAttr(e.code) + '&quot;, this)">+ Add</button>';
    return channelListingCardHtml(
      e,
      '<button type="button" class="lc-btn searchLikeExternalBtn' + (_channelDirectoryLiked[e.code] ? ' liked' : '') + '"' +
        ' aria-label="Like this channel" title="Like this channel"' +
        ' onclick="toggleChannelDirectoryLike(&quot;' + escapeJsAttr(e.code) + '&quot;, this)">' +
        (_channelDirectoryLiked[e.code] ? '\u2665' : '\u2661') + (e.likes ? ' ' + e.likes : '') +
      '</button>' +
      '<button type="button" class="lc-btn secondary" style="padding:6px 12px; font-size:0.8rem;" onclick="previewDirectoryChannel(&quot;' + escapeJsAttr(e.code) + '&quot;, this)">See all</button>' +
      actionBtn,
      ''
    );
  }).join('');
}

// Look through a published channel before taking it.
//
// A directory row is a one-line summary by design -- the index has to stay
// cheap to read -- so seeing what is actually IN a channel means fetching
// it. Which is the same fetch adding it makes, so a preview costs a person
// nothing they were not about to spend anyway, and answers the question the
// summary cannot: is this the lineup I want?
async function previewDirectoryChannel(code, btn) {
  const originalLabel = btn ? btn.textContent : '';
  if (btn && btn.tagName === 'BUTTON') {
    btn.disabled = true;
    btn.textContent = 'Opening\u2026';
  }
  try {
    const data = await fetchSharedChannel(code);
    if (!data.ok || !data.channel) {
      showAppAlert('Explore Channels', data.error || 'That channel could not be read.');
      return;
    }
    // A synthetic id: this channel is not saved here, and giving it one that
    // could collide with a saved channel's would make "+ Add" on the details
    // page act on the wrong one.
    const preview = Object.assign({}, data.channel, { channelId: 'directory:' + code });
    openChannelDetailsPage(preview.channelId, preview);
  } catch (e) {
    showAppAlert('Explore Channels', 'Network error while opening that channel.');
  } finally {
    if (btn && btn.tagName === 'BUTTON') {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }
}

async function toggleChannelDirectoryLike(code, btn) {
  const wasLiked = !!_channelDirectoryLiked[code];
  // Filled in before the round trip so the heart answers the tap, and put
  // back if the server disagrees -- it holds the ledger, this does not.
  _channelDirectoryLiked[code] = !wasLiked;
  renderChannelDirectory();
  try {
    const body = { code: code, action: wasLiked ? 'unlike' : 'like' };
    const signedIn = (typeof activeCreator !== 'undefined' && !!activeCreator);
    if (signedIn) {
      body.creatorName = activeCreator.creatorName;
      body.creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
    }
    const res = await fetch(ORIGIN + '/api/channel/like', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) {
      _channelDirectoryLiked[code] = wasLiked;
      renderChannelDirectory();
      return;
    }
    _channelDirectoryLiked[code] = !!data.liked;
    const entry = (_channelDirectoryEntries || []).find((x) => x && x.code === code);
    if (entry) entry.likes = data.likes;
    renderChannelDirectory();
  } catch (e) {
    _channelDirectoryLiked[code] = wasLiked;
    renderChannelDirectory();
  }
}

async function addDirectoryChannel(code, btn) {
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Adding…';
  }
  try {
    const map = (typeof loadLocalChannels === 'function') ? loadLocalChannels() : {};
    let localCh = null;
    for (const id in map) {
      if (map[id] && map[id].shareCode === code) {
        localCh = map[id];
        break;
      }
    }
    if (localCh) {
      addRow(localCh.name || 'Channel', 'channel:v1:' + JSON.stringify(localCh), 'series', true, 'Channels', localCh.channelId);
      if (typeof saveState === 'function') saveState();
      if (typeof renderLivePreview === 'function') renderLivePreview();
      fetch(ORIGIN + '/api/channel/added', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code }),
      }).catch(() => {});
      const entry = (_channelDirectoryEntries || []).find((x) => x && x.code === code);
      if (entry) entry.adds = (Number(entry.adds) || 0) + 1;
      renderChannelDirectory();
      if (typeof showAddedToast === 'function') showAddedToast('Channel "' + (localCh.name || 'Channel') + '" added to your Catalogs.');
      return;
    }
    const data = await fetchSharedChannel(code);
    if (!data.ok || !data.channel) {
      if (typeof showAppAlert === 'function') showAppAlert('Explore Channels', data.error || 'That channel could not be read.');
      if (btn) {
        btn.disabled = false;
        btn.textContent = '+ Add';
      }
      return;
    }
    acceptSharedChannel(data.channel, code);
    if (typeof saveState === 'function') saveState();
    if (typeof renderLivePreview === 'function') renderLivePreview();
    // Taking a channel is the signal "most added" ranks on. Best effort by
    // design: it must never be the reason an add fails.
    fetch(ORIGIN + '/api/channel/added', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code }),
    }).catch(() => {});
    const entry = (_channelDirectoryEntries || []).find((x) => x && x.code === code);
    if (entry) entry.adds = (Number(entry.adds) || 0) + 1;
    renderChannelDirectory();
  } catch (e) {
    if (typeof showAppAlert === 'function') showAppAlert('Explore Channels', 'Network error while adding that channel.');
    if (btn) {
      btn.disabled = false;
      btn.textContent = '+ Add';
    }
  }
}

async function removeDirectoryChannel(code, btn) {
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Removing…';
  }
  try {
    const map = (typeof loadLocalChannels === 'function') ? loadLocalChannels() : {};
    let targetChannelId = null;
    let channelName = '';
    for (const id in map) {
      if (map[id] && map[id].shareCode === code) {
        targetChannelId = id;
        channelName = map[id].name || '';
        break;
      }
    }
    const rows = typeof document !== 'undefined' ? [...document.querySelectorAll('#lists .entry')] : [];
    let removedAnyRow = false;
    rows.forEach((row) => {
      let match = false;
      if (targetChannelId && row.dataset.channelId === targetChannelId) {
        match = true;
      } else {
        const urlInputs = [...row.querySelectorAll('.url')];
        if (urlInputs.some((u) => {
          const val = u.value || '';
          if (targetChannelId && val.includes(targetChannelId)) return true;
          if (code && val.includes(code)) return true;
          if (val.startsWith('channel:v1:')) {
            try {
              const p = JSON.parse(val.slice('channel:v1:'.length));
              return p && (p.shareCode === code || (targetChannelId && p.channelId === targetChannelId));
            } catch (_) {}
          }
          return false;
        })) {
          match = true;
        }
      }
      if (match) {
        if (!channelName) {
          const nameInput = row.querySelector('.name');
          if (nameInput && nameInput.value) channelName = nameInput.value;
        }
        row.remove();
        removedAnyRow = true;
      }
    });

    if (removedAnyRow && typeof saveState === 'function') {
      saveState();
    }
    if (typeof renderLivePreview === 'function') {
      renderLivePreview();
    }
    
    renderChannelDirectory();
    if (typeof showAddedToast === 'function') showAddedToast('Removed "' + (channelName || 'Channel') + '" from your Catalogs.');
  } catch (e) {
    if (typeof showAppAlert === 'function') showAppAlert('Explore Channels', 'Error while removing that channel.');
    if (btn) btn.disabled = false;
  }
}

// The "publish one of your own" half of the Explore tab: every saved channel
// with a control to list it, or take it back down.
// One card, drawn the way Explore Channels draws one.
//
// The publish panel and the directory show the same thing -- a channel, as
// other people will see it -- so they are built by the same function and
// differ only in the buttons on the right. Two card shapes for one object is
// how a description ends up shown in one place and not the other.
function channelListingCardHtml(entry, actionsHtml, extraHtml) {
  const sampleItems = Array.isArray(entry.sample) ? entry.sample.slice(0, 9) : [];
  const totalCount = entry.itemCount || sampleItems.length;
  let postersHtml = '';
  if (sampleItems.length) {
    postersHtml = '<div class="list-card-posters poster-preview-static">' +
      sampleItems.map((it, i) => {
        const isMobileEnd = (i === 2 && sampleItems.length > 3);
        const isDesktopEnd = (i === sampleItems.length - 1 && sampleItems.length >= 4);
        let overlays = '';
        if (entry.code) {
          if (isMobileEnd) overlays += '<div class="list-card-count-overlay mobile-only" style="cursor:pointer;" onclick="event.stopPropagation(); previewDirectoryChannel(&quot;' + escapeJsAttr(entry.code) + '&quot;, this)">' + totalCount + ' &rsaquo;</div>';
          if (isDesktopEnd) overlays += '<div class="list-card-count-overlay desktop-only" style="cursor:pointer;" onclick="event.stopPropagation(); previewDirectoryChannel(&quot;' + escapeJsAttr(entry.code) + '&quot;, this)">' + totalCount + ' &rsaquo;</div>';
        }
        const p = it.poster || it.thumbnail || it.showPoster || it.backdrop || entry.poster || entry.backdrop || '';
        const imgHtml = p
          ? '<img src="' + escapeAttr(p) + '" alt="" loading="lazy">'
          : '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted);font-size:0.65rem;text-align:center;padding:4px;">No poster</div>';
        const itemId = it.id || it.imdbId || '';
        const itemType = (it.kind === 'movie' || it.type === 'movie') ? 'movie' : 'series';
        const posterClickAttr = itemId
          ? ' style="cursor:pointer;" onclick="event.stopPropagation(); openItemDetailsModal(&quot;' + escapeJsAttr(itemId) + '&quot;, &quot;' + itemType + '&quot;)"'
          : (entry.code ? ' style="cursor:pointer;" onclick="event.stopPropagation(); previewDirectoryChannel(&quot;' + escapeJsAttr(entry.code) + '&quot;, this)"' : '');
        const title = it.name || it.title || entry.name || 'Channel';
        const subtitle = it.subtitle || it.epName || '';
        return '<div class="list-card-mini-poster-tile">' +
          '<div class="list-card-mini-poster-img-wrap"' + posterClickAttr + '>' +
            imgHtml +
            overlays +
          '</div>' +
          '<div class="list-card-mini-poster-name" title="' + escapeAttr(title) + '">' + escapeHtml(title) + '</div>' +
          (subtitle ? '<div class="list-card-mini-poster-subtitle" title="' + escapeAttr(subtitle) + '">' + escapeHtml(subtitle) + '</div>' : '') +
        '</div>';
      }).join('') +
    '</div>';
  }

  let art = entry.backdrop || entry.poster || '';
  if (!art && !postersHtml) {
    art = ORIGIN + '/api/channel-poster?name=' + encodeURIComponent(entry.name || 'Channel') + '&format=landscape&v=6';
  }
  const thumb = (!postersHtml && art)
    ? '<img src="' + escapeAttr(art) + '" alt="" loading="lazy" style="width:88px; height:56px; object-fit:cover; border-radius:6px; border:1px solid var(--border); flex:0 0 auto;">'
    : '';
  const openAttr = entry.code
    ? ' style="cursor:pointer;" onclick="previewDirectoryChannel(&quot;' + escapeJsAttr(entry.code) + '&quot;, this)" title="See everything in this channel"'
    : '';
  return '<div class="list-card" style="margin-bottom:10px;">' +
    '<div class="list-card-header" style="gap:10px; align-items:center;">' +
      (thumb ? '<div' + openAttr + '>' + thumb + '</div>' : '') +
      '<div class="list-card-body">' +
        '<div class="list-card-title"' + openAttr + '>' + escapeHtml(entry.name || 'Channel') + '</div>' +
        (entry.description ? '<div style="font-size:0.8rem; color:var(--text); margin-top:2px;">' + escapeHtml(entry.description) + '</div>' : '') +
        '<div class="list-card-meta"><span>' + escapeHtml(channelDirectoryMetaLine(entry)) + '</span></div>' +
      '</div>' +
      '<div class="list-card-actions">' + actionsHtml + '</div>' +
    '</div>' +
    postersHtml +
    (extraHtml || '') +
  '</div>';
}

// A saved channel, described the way a directory row describes one -- so the
// panel can preview what publishing it would actually look like.
function channelAsListingEntry(ch) {
  const items = ch.items || [];
  const showKeys = {};
  items.forEach((it) => { const k = channelDraftShowKey(it); if (k) showKeys[k] = true; });
  let poster = ch.poster || null;
  let backdrop = ch.backdrop || null;
  if (!poster && !backdrop) {
    if (ch.dynamic === 'next-up' && typeof channelNextUpSeedItems === 'function') {
      const seed = channelNextUpSeedItems();
      const firstWithArt = seed.find((it) => it && (it.showPoster || it.poster || it.thumbnail));
      if (firstWithArt) {
        poster = firstWithArt.showPoster || firstWithArt.poster || firstWithArt.thumbnail;
      }
    }
  }
  if (!poster && !backdrop) {
    backdrop = ORIGIN + '/api/channel-poster?name=' + encodeURIComponent(ch.name || 'Channel') + '&format=landscape&v=6';
  }
  return {
    code: ch.sharePublished ? ch.shareCode : '',
    name: ch.name,
    description: ch.description || '',
    poster: poster,
    backdrop: backdrop,
    itemCount: items.length,
    showCount: Object.keys(showKeys).length,
    dailyRotate: !!ch.dailyRotate,
    shuffle: !!ch.shuffle,
    autoSort: ch.autoSort || '',
    dynamic: ch.dynamic || '',
    owner: ch.sharePublished && typeof activeCreator !== 'undefined' && activeCreator ? activeCreator.creatorName : '',
    likes: 0,
    adds: 0,
    sample: (items || []).slice(0, 9).map((it) => ({
      name: it.showName || it.title || ch.name || 'Channel',
      subtitle: it.epName || (it.season != null && it.episode != null ? ('S' + it.season + 'E' + it.episode) : ''),
      poster: it.thumbnail || it.poster || it.showPoster || it.backdrop || ch.poster || ch.backdrop || '',
      id: it.imdbId || it.id || '',
      kind: it.kind || it.type || 'series',
    })),
  };
}

let _orphanedPublishedChannels = [];

// Listings this account still has up whose channel is gone from this
// browser. Fetched rather than inferred: the local store is exactly what
// cannot answer this, because the record that knew the code is the one that
// was deleted.
async function loadOrphanedPublishedChannels() {
  const signedIn = (typeof activeCreator !== 'undefined' && !!activeCreator);
  if (!signedIn) {
    _orphanedPublishedChannels = [];
    return;
  }
  try {
    const res = await fetch(ORIGIN + '/api/channel/mine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creatorName: activeCreator.creatorName,
        creatorKey: localStorage.getItem('myListAddon:creatorKey') || '',
      }),
    });
    const data = await res.json();
    if (!data.ok) return;
    const mine = loadLocalChannels();
    const known = {};
    Object.values(mine).forEach((ch) => { if (ch && ch.shareCode) known[ch.shareCode] = true; });
    _orphanedPublishedChannels = (data.channels || []).filter((e) => e && !known[e.code]);
  } catch (e) {
    // Leave whatever was last known rather than clearing the list on a
    // hiccup -- an orphan that vanishes from the panel is an orphan nobody
    // can take down.
  }
  renderChannelPublishList();
}

function renderChannelPublishList() {
  const box = document.getElementById('channelPublishList');
  if (!box) return;
  const signedIn = (typeof activeCreator !== 'undefined' && !!activeCreator);
  if (!signedIn) {
    box.innerHTML = '<p style="color:var(--muted); font-size:0.85rem;"><small>Sign in to a Creator Profile under <strong>Settings</strong> to publish a channel here. You can still share any channel privately with <strong>Share</strong> under My Channels.</small></p>';
    return;
  }
  const channels = Object.values(ensureAllChannelsSyncedFromRows(loadLocalChannels()));
  channels.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  const mine = channels.map((ch) => {
    const action = ch.sharePublished
      ? '<button type="button" class="lc-btn secondary" style="padding:6px 12px; font-size:0.8rem; color:var(--danger);" onclick="unpublishChannelFromDirectory(&quot;' + escapeJsAttr(ch.channelId) + '&quot;, this)">Unpublish</button>'
      : '<button type="button" class="lc-btn primary" style="padding:6px 12px; font-size:0.8rem;" onclick="publishChannelToDirectory(&quot;' + escapeJsAttr(ch.channelId) + '&quot;, this)">Publish</button>';
    const extra =
      // A published channel's link lives here, on screen, rather than only
      // in the modal that announced it -- that modal closes and takes the
      // link with it.
      (ch.shareCode
        ? '<div class="row" style="margin-top:8px; gap:8px;">' +
            '<input type="text" readonly value="' + escapeAttr(channelShareUrl(ch.shareCode)) + '" onclick="this.select()" style="font-size:0.8rem;">' +
            '<button type="button" class="secondary lc-btn" style="flex:none; width:auto; white-space:nowrap;" onclick="copyChannelShareLink(&quot;' + escapeJsAttr(ch.channelId) + '&quot;, this)">Copy</button>' +
          '</div>'
        : '');
    return channelListingCardHtml(channelAsListingEntry(ch), action, extra);
  }).join('');

  // Listings with no channel left behind them. Shown apart from the rest
  // because there is nothing to edit, publish or copy -- only to withdraw.
  const orphans = _orphanedPublishedChannels.map((entry) => channelListingCardHtml(
    entry,
    '<button type="button" class="lc-btn secondary" style="padding:6px 12px; font-size:0.8rem; color:var(--danger);" onclick="unpublishOrphanedChannel(&quot;' + escapeJsAttr(entry.code) + '&quot;, this)">Unpublish</button>',
    ''
  )).join('');

  box.innerHTML =
    (channels.length ? mine : '<p style="color:var(--muted); font-size:0.85rem;"><small>No channels yet \u2014 build one first.</small></p>') +
    (orphans
      ? '<p style="margin:16px 0 6px; font-weight:600; font-size:0.85rem;">Still listed, but no longer on this device</p>' +
        '<p style="margin:0 0 8px; color:var(--muted); font-size:0.78rem;">You published these and the channel has since been deleted here. They are still in Explore Channels until you take them down.</p>' +
        orphans
      : '');
}

async function publishChannelToDirectory(channelId, btn) {
  const map = loadLocalChannels();
  const ch = map[channelId];
  if (!ch) return;
  const descInput = document.getElementById('channelPublishDesc_' + channelId);
  const originalLabel = btn ? btn.textContent : 'Publish';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Publishing…';
  }
  try {
    const data = await postChannelShare(ch, {
      publish: true,
      description: descInput ? descInput.value.trim() : (ch.description || ''),
    });
    if (!data.ok) {
      showAppAlert('Publish Channel', data.error || 'Could not publish that channel.');
      return;
    }
    rememberChannelShare(channelId, data.code, true);
    showAppAlert(
      'Published',
      '"' + ch.name + '" is now listed in Explore Channels.\\n\\nIts direct link is ' + (data.url || channelShareUrl(data.code)),
      true
    );
    renderChannelPublishList();
    loadChannelDirectory(true);
  } catch (e) {
    showAppAlert('Publish Channel', 'Network error while publishing that channel.');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }
}

// Withdraws one listing by its code. The one place that call lives, so
// deleting a channel, unpublishing from the panel, and clearing an orphaned
// listing all do exactly the same thing.
async function unpublishChannelByCode(code) {
  if (!code) return { ok: false, error: 'No code.' };
  const res = await fetch(ORIGIN + '/api/channel/unpublish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: code,
      creatorName: (typeof activeCreator !== 'undefined' && activeCreator) ? activeCreator.creatorName : '',
      creatorKey: localStorage.getItem('myListAddon:creatorKey') || '',
    }),
  });
  return res.json();
}

async function unpublishChannelFromDirectory(channelId, btn) {
  const map = loadLocalChannels();
  const ch = map[channelId];
  if (!ch || !ch.shareCode) return;
  const originalLabel = btn ? btn.textContent : 'Unpublish';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Removing…';
  }
  try {
    const data = await unpublishChannelByCode(ch.shareCode);
    if (!data.ok) {
      showAppAlert('Explore Channels', data.error || 'Could not remove that listing.');
      return;
    }
    // Only the LISTING goes. The share link keeps working, because "stop
    // advertising this" and "break everyone's link" are different asks.
    rememberChannelShare(channelId, ch.shareCode, false);
    renderChannelPublishList();
    loadChannelDirectory(true);
    loadOrphanedPublishedChannels();
  } catch (e) {
    showAppAlert('Explore Channels', 'Network error while removing that listing.');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }
}

// A listing whose channel is no longer in this browser. Nothing local is
// left to update, so this only withdraws it and redraws the panel.
async function unpublishOrphanedChannel(code, btn) {
  const originalLabel = btn ? btn.textContent : 'Unpublish';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Removing…';
  }
  try {
    const data = await unpublishChannelByCode(code);
    if (!data.ok) {
      showAppAlert('Explore Channels', data.error || 'Could not remove that listing.');
      return;
    }
    renderChannelPublishList();
    loadChannelDirectory(true);
  } catch (e) {
    showAppAlert('Explore Channels', 'Network error while removing that listing.');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }
}

//
const LOCAL_MERGED_CHANNELS_KEY = 'myListAddon:localMergedChannels';

function loadLocalMergedChannels() {
  try {
    const raw = localStorage.getItem(LOCAL_MERGED_CHANNELS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (e) {
    return {};
  }
}

function saveLocalMergedChannelsMap(map) {
  try {
    localStorage.setItem(LOCAL_MERGED_CHANNELS_KEY, JSON.stringify(map));
    if (typeof scheduleChannelsSync === 'function') scheduleChannelsSync();
    return true;
  } catch (e) {
    console.error('saveLocalMergedChannelsMap failed:', e);
    return false;
  }
}

function saveLocalMergedChannel(payload) {
  const map = loadLocalMergedChannels();
  const mergedId = payload.mergedId || ('merged-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7));
  const now = Date.now();
  const existing = map[mergedId];
  map[mergedId] = {
    mergedId: mergedId,
    name: payload.name || 'Merged Channel',
    channelIds: Array.isArray(payload.channelIds) ? payload.channelIds : [],
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
  };
  saveLocalMergedChannelsMap(map);
  return map[mergedId];
}

function deleteLocalMergedChannel(mergedId) {
  const map = loadLocalMergedChannels();
  const merged = map[mergedId];
  const name = merged ? merged.name : 'Merged Catalog';
  
  const performDelete = () => {
    delete map[mergedId];
    saveLocalMergedChannelsMap(map);
    
    const rows = [...document.querySelectorAll('#lists .entry')];
    rows.forEach((row) => {
      if (row.dataset.mergedId === mergedId || (row.id && row.id === mergedId)) {
        row.remove();
      }
    });
    saveState();
    renderChannelMergeList();
    showAddedToast('Deleted merged catalog "' + name + '".');
  };

  if (typeof showAppConfirm === 'function') {
    showAppConfirm(
      'Delete Merged Catalog',
      'Delete merged catalog "' + name + '"? This will permanently remove this merged catalog.',
      'Delete Merged Catalog',
      performDelete,
      true
    );
  } else {
    performDelete();
  }
}

function removeChannelFromMerge(mergedId, channelIdToRemove) {
  const map = loadLocalMergedChannels();
  const merged = map[mergedId];
  if (!merged) return;
  
  merged.channelIds = (merged.channelIds || []).filter((id) => id !== channelIdToRemove);
  merged.updatedAt = Date.now();
  
  if (merged.channelIds.length === 0) {
    delete map[mergedId];
  } else {
    map[mergedId] = merged;
  }
  saveLocalMergedChannelsMap(map);
  
  const channelsMap = loadLocalChannels();
  const rows = [...document.querySelectorAll('#lists .entry')];
  rows.forEach((row) => {
    if (row.dataset.mergedId === mergedId || (row.id && row.id === mergedId)) {
      if (merged.channelIds.length === 0) {
        row.remove();
      } else {
        const urls = merged.channelIds.map((id) => {
          const ch = channelsMap[id];
          return ch ? ('channel:v1:' + JSON.stringify(ch)) : null;
        }).filter(Boolean);
        const urlInput = row.querySelector('.url');
        if (urlInput) urlInput.value = urls.join('\\n');
      }
    }
  });
  saveState();
  renderChannelMergeList();
  showAddedToast('Removed channel from merged catalog.');
}

function addChannelToMerge(mergedId, channelIdToAdd) {
  if (!channelIdToAdd) return;
  const map = loadLocalMergedChannels();
  const merged = map[mergedId];
  if (!merged) return;
  
  merged.channelIds = merged.channelIds || [];
  if (!merged.channelIds.includes(channelIdToAdd)) {
    merged.channelIds.push(channelIdToAdd);
    merged.updatedAt = Date.now();
    map[mergedId] = merged;
    saveLocalMergedChannelsMap(map);
    
    const channelsMap = loadLocalChannels();
    const ch = channelsMap[channelIdToAdd];
    const chName = ch ? ch.name : 'Channel';
    
    const rows = [...document.querySelectorAll('#lists .entry')];
    rows.forEach((row) => {
      if (row.dataset.mergedId === mergedId || (row.id && row.id === mergedId)) {
        const urls = merged.channelIds.map((id) => {
          const c = channelsMap[id];
          return c ? ('channel:v1:' + JSON.stringify(c)) : null;
        }).filter(Boolean);
        const urlInput = row.querySelector('.url');
        if (urlInput) urlInput.value = urls.join('\\n');
      }
    });
    saveState();
    renderChannelMergeList();
    showAddedToast('Added "' + chName + '" to "' + merged.name + '".');
  }
}

function toggleMergedChannelInCatalog(mergedId) {
  const map = loadLocalMergedChannels();
  const merged = map[mergedId];
  if (!merged) return;
  
  const channelsMap = loadLocalChannels();
  const rows = [...document.querySelectorAll('#lists .entry')];
  let foundRow = null;
  for (const row of rows) {
    if (row.dataset.mergedId === mergedId || row.dataset.channelId === mergedId || (row.id && row.id === mergedId)) {
      foundRow = row;
      break;
    }
    const nameInput = row.querySelector('.name');
    if (nameInput && nameInput.value.trim() === merged.name) {
      const urls = [...row.querySelectorAll('.url')].map((u) => u.value.trim()).filter(Boolean);
      if (urls.length && urls.every((u) => u.startsWith('channel:v1:'))) {
        foundRow = row;
        break;
      }
    }
  }
  
  if (foundRow) {
    foundRow.remove();
    saveState();
    renderChannelMergeList();
    showAddedToast('Removed "' + merged.name + '" from Catalogs shelf.');
  } else {
    const urls = (merged.channelIds || []).map((id) => {
      const ch = channelsMap[id];
      return ch ? ('channel:v1:' + JSON.stringify(ch)) : null;
    }).filter(Boolean);
    
    if (!urls.length) {
      if (typeof showAppAlert === 'function') {
        showAppAlert('Merge Channels', 'Could not find the channels for this merged catalog.');
      } else {
        alert('Could not find the channels for this merged catalog.');
      }
      return;
    }
    addRow(merged.name, urls.join('\\n'), 'series', true, 'Channels', mergedId);
    saveState();
    renderChannelMergeList();
    showAddedToast('Added "' + merged.name + '" to Catalogs shelf.');
  }
}

function mergeChannelsIntoRow() {
  const checks = document.querySelectorAll('#channelMergeList .channelMergeCheck:checked');
  if (checks.length < 2) {
    if (typeof showAppAlert === 'function') {
      showAppAlert('Merge Channels', 'Check at least two channels to merge.');
    } else {
      alert('Check at least two channels to merge.');
    }
    return;
  }
  const nameInput = document.getElementById('channelMergeNameInput');
  const combinedName = nameInput.value.trim();
  if (!combinedName) {
    if (typeof showAppAlert === 'function') {
      showAppAlert('Merge Channels', 'Name the combined catalog first.');
    } else {
      alert('Name the combined catalog first.');
    }
    return;
  }
  
  const channelsMap = loadLocalChannels();
  const channelIds = [...checks].map((cb) => cb.dataset.channelid).filter(Boolean);
  const urls = channelIds.map((id) => {
    const ch = channelsMap[id];
    return ch ? ('channel:v1:' + JSON.stringify(ch)) : null;
  }).filter(Boolean);

  if (urls.length < 2) {
    if (typeof showAppAlert === 'function') {
      showAppAlert('Merge Channels', 'Could not read the selected channels. Please try again.');
    } else {
      alert('Could not read the selected channels. Please try again.');
    }
    return;
  }
  
  const merged = saveLocalMergedChannel({
    name: combinedName,
    channelIds: channelIds,
  });
  
  // Remove the individual merged channel rows from #lists so only the combined catalog shelf remains
  const existingRows = [...document.querySelectorAll('#lists .entry')];
  existingRows.forEach((row) => {
    const rowChId = row.dataset.channelId || row.id;
    if (channelIds.includes(rowChId)) {
      row.remove();
      return;
    }
    const uInput = row.querySelector('.url');
    if (uInput && uInput.value) {
      const uVal = uInput.value.trim();
      for (const chId of channelIds) {
        if (uVal === 'channel:id:' + chId || uVal.includes('"channelId":"' + chId + '"')) {
          row.remove();
          break;
        }
      }
    }
  });

  addRow(combinedName, urls.join('\\n'), 'series', true, 'Channels', merged.mergedId);
  nameInput.value = '';
  saveState();
  renderChannelMergeList();
  renderMyCreatedChannelsList();
  showAddedToast('Merged ' + channelIds.length + ' channels into "' + combinedName + '".');
}

function toggleAllChannelMergeChecks(checkbox) {
  document.querySelectorAll('#channelMergeList .channelMergeCheck').forEach((cb) => {
    cb.checked = checkbox.checked;
  });
}

function renderChannelMergeList() {
  const channelsMap = ensureAllChannelsSyncedFromRows(loadLocalChannels());
  const mergedMap = loadLocalMergedChannels();
  
  // 1. Render Saved Merged Catalogs List
  const savedBox = document.getElementById('savedMergedChannelsList');
  if (savedBox) {
    const mergedList = Object.values(mergedMap);
    if (!mergedList.length) {
      savedBox.innerHTML = '<p style="color:var(--muted); font-size:0.85rem; margin:0;"><small>No merged catalogs created yet. Select channels below to combine them.</small></p>';
    } else {
      mergedList.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
      savedBox.innerHTML = mergedList.map((merged) => {
        const isAdded = [...document.querySelectorAll('#lists .entry')].some((r) => {
          if (r.dataset.mergedId === merged.mergedId || r.dataset.channelId === merged.mergedId || (r.id && r.id === merged.mergedId)) return true;
          const nameInput = r.querySelector('.name');
          if (nameInput && nameInput.value.trim() === merged.name) {
            const urls = [...r.querySelectorAll('.url')].map((u) => u.value.trim()).filter(Boolean);
            if (urls.length && urls.every((u) => u.startsWith('channel:v1:'))) return true;
          }
          return false;
        });
        
        let totalEpisodes = 0;
        const channelChips = (merged.channelIds || []).map((chId) => {
          const ch = channelsMap[chId];
          const chName = ch ? ch.name : 'Unknown Channel';
          if (ch && Array.isArray(ch.items)) totalEpisodes += ch.items.length;
          return '<span class="badge" style="display:inline-flex; align-items:center; gap:5px; padding:3px 8px; font-size:0.8rem; background:var(--panel-strong); border:1px solid var(--border); border-radius:6px; margin:2px 4px 2px 0;">' +
            escapeHtml(chName) +
            '<button type="button" class="merge-chip-remove-btn" title="Remove ' + escapeAttr(chName) + ' from merge" aria-label="Remove ' + escapeAttr(chName) + ' from merge" onclick="removeChannelFromMerge(&quot;' + escapeJsAttr(merged.mergedId) + '&quot;, &quot;' + escapeJsAttr(chId) + '&quot;)">\u2715</button>' +
          '</span>';
        }).join('');
        
        const remainingChannels = Object.values(channelsMap).filter((c) => c && !(merged.channelIds || []).includes(c.channelId));
        let addSelectHtml = '';
        if (remainingChannels.length) {
          remainingChannels.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
          const options = remainingChannels.map((c) => '<option value="' + escapeAttr(c.channelId) + '">' + escapeHtml(c.name) + ' (' + (c.items ? c.items.length : 0) + ' ep)</option>').join('');
          addSelectHtml = '<select class="merge-add-channel-select" onchange="addChannelToMerge(&quot;' + escapeJsAttr(merged.mergedId) + '&quot;, this.value); this.value=&quot;&quot;;">' +
            '<option value="">+ Add channel...</option>' +
            options +
          '</select>';
        } else {
          addSelectHtml = '<select class="merge-add-channel-select" disabled title="All your current saved channels are already in this merge. Build or Quick Add more channels to add them here." style="opacity:0.65; cursor:not-allowed;">' +
            '<option value="">All saved channels added</option>' +
          '</select>' +
          ' <button type="button" class="lc-btn secondary" style="padding:2px 8px; font-size:0.75rem; margin-left:4px;" onclick="switchChannelsSubmenu(&quot;quickadd&quot;, document.querySelector(&quot;#channelsSubnavBar button:nth-child(2)&quot;))">+ Quick Add</button>';
        }
        
        const countText = (merged.channelIds ? merged.channelIds.length : 0) + ' channels &middot; ' + totalEpisodes + ' episodes';
        
        const addBtnHtml = '<button type="button" class="lc-btn ' + (isAdded ? 'secondary' : 'primary') + '" style="padding:6px 12px; font-size:0.8rem;' + (isAdded ? ' color:var(--danger);' : '') + '" onclick="toggleMergedChannelInCatalog(&quot;' + escapeJsAttr(merged.mergedId) + '&quot;)">' +
          (isAdded ? 'Remove' : '+ Add') +
        '</button>';

        return '<div class="list-card" style="margin-bottom:10px;" data-merged-id="' + escapeAttr(merged.mergedId) + '">' +
          '<div class="list-card-header">' +
            '<div class="list-card-body">' +
              '<div class="list-card-title">' + escapeHtml(merged.name) + '</div>' +
              '<div class="list-card-meta"><span>' + countText + '</span></div>' +
              '<div style="margin-top:6px; display:flex; flex-wrap:wrap; align-items:center;">' +
                '<strong style="font-size:0.75rem; color:var(--muted); margin-right:6px;">Merged:</strong>' +
                (channelChips || '<span style="color:var(--muted); font-size:0.8rem; margin-right:4px;">None</span>') +
                addSelectHtml +
              '</div>' +
            '</div>' +
            '<div class="list-card-actions">' +
              '<button type="button" class="lc-btn secondary" style="padding:6px 12px; font-size:0.8rem; color:var(--danger);" onclick="deleteLocalMergedChannel(&quot;' + escapeJsAttr(merged.mergedId) + '&quot;)">Delete</button>' +
              addBtnHtml +
            '</div>' +
          '</div>' +
        '</div>';
      }).join('');
    }
  }

  // 2. Render Checkboxes for Channels to Merge
  const box = document.getElementById('channelMergeList');
  if (!box) return;
  const selectAllCheck = document.getElementById('channelMergeSelectAllCheck');
  if (selectAllCheck) selectAllCheck.checked = false;
  
  const channels = Object.values(channelsMap);
  if (!channels.length) {
    box.innerHTML = '<p><small>No saved channels yet -- add or build a channel above first.</small></p>';
    return;
  }
  
  channels.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  
  box.innerHTML = channels.map((ch) => {
    const epCount = (ch.items || []).length;
    const label = escapeHtml(ch.name) + ' <span style="color:var(--muted); font-size:0.8rem;">(' + epCount + ' ep)</span>';
    return '<label class="row quick-row" style="cursor:pointer; margin-bottom:4px;">' +
      '<span><input type="checkbox" class="channelMergeCheck" data-channelid="' + escapeAttr(ch.channelId) + '"> ' + label + '</span>' +
      '</label>';
  }).join('');
}







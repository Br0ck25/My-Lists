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

function setChannelSearchType(type, btn) {
  channelSearchType = type === 'movie' ? 'movie' : 'tv';
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
    input.placeholder = channelSearchType === 'movie' ? 'Search a movie by name...' : 'Search a show by name...';
  }
  const box = document.getElementById('channelSearchResult');
  const epBox = document.getElementById('channelEpisodePicker');
  if (epBox) epBox.innerHTML = '';
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

async function addMovieToChannelDraft(tmdbId, title, year, poster, backdrop, btn) {
  if (channelDraftItems.length >= CHANNEL_MAX_TOTAL_ITEMS) {
    if (typeof showAppAlert === 'function') {
      showAppAlert('Channel Limit', 'This channel has reached the maximum of ' + CHANNEL_MAX_TOTAL_ITEMS + ' items.');
    }
    return;
  }
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
    addAllEpisodesToChannel(addAllBtn.dataset.imdbid, addAllBtn.dataset.showname, addAllBtn.dataset.poster, addAllBtn.dataset.backdrop);
    return;
  }
  const addBtn = e.target.closest('.channelAddEpisodesBtn');
  if (addBtn) {
    addCheckedEpisodesToChannel(addBtn.dataset.imdbid, addBtn.dataset.showname, addBtn.dataset.poster, addBtn.dataset.backdrop);
  }
});

// Fetches every season's episode list (in parallel -- server-cached anyway,
// see /api/show-episodes) and adds all of them in original broadcast order,
// for "just give me the whole show" instead of clicking through season by
// season.
async function addAllSeasonsToChannel(tmdbId, imdbId, showName, showPoster, showBackdrop, seasonsCsv, btn) {
  const seasons = String(seasonsCsv || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!seasons.length) return;
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
            imdbId: imdbId,
            season: season,
            episode: ep.episode,
            showName: showName || '',
            epName: ep.name || ('Episode ' + ep.episode),
            title: (showName ? showName + ' S' + season + 'E' + ep.episode + ' \u2014 ' : '') + (ep.name || ('Episode ' + ep.episode)),
            released: ep.released,
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
        season: parseInt(season, 10), episode: ep.episode, title: ep.name, released: ep.released, thumbnail: ep.thumbnail,
      }));
      return '<label class="row quick-row" style="cursor:pointer;">' +
        '<span><input type="checkbox" class="channelEpisodeCheck" data-ep="' + epJson + '"> ' +
        'S' + season + 'E' + ep.episode + ' \u2014 ' + escapeHtml(ep.name || '') + '</span>' +
        '</label>';
    }).join('');
    listBox.innerHTML = rows +
      '<div class="actions" style="margin-top:8px;">' +
      '<button type="button" class="secondary channelAddEpisodesBtn"' +
      ' data-imdbid="' + escapeAttr(imdbId) + '" data-showname="' + escapeAttr(showName) + '"' +
      ' data-poster="' + escapeAttr(showPoster) + '" data-backdrop="' + escapeAttr(showBackdrop || '') + '">Add checked episodes</button>' +
      '<button type="button" class="secondary channelAddAllEpisodesBtn"' +
      ' data-imdbid="' + escapeAttr(imdbId) + '" data-showname="' + escapeAttr(showName) + '"' +
      ' data-poster="' + escapeAttr(showPoster) + '" data-backdrop="' + escapeAttr(showBackdrop || '') + '">Add all episodes</button>' +
      '</div>';
    listBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    listBox.innerHTML = '<p class="testresult err">\u2717 Network error loading episodes.</p>';
  }
}

function addCheckedEpisodesToChannel(imdbId, showName, showPoster, showBackdrop) {
  const checks = document.querySelectorAll('#channelEpisodeList .channelEpisodeCheck:checked');
  if (!checks.length) {
    if (typeof showAppAlert === 'function') {
      showAppAlert('Channel Builder', 'Check at least one episode first.');
    } else {
      alert('Check at least one episode first.');
    }
    return;
  }
  checks.forEach((cb) => {
    let ep;
    try {
      ep = JSON.parse(cb.dataset.ep);
    } catch (e) {
      return;
    }
    channelDraftItems.push({
      kind: 'episode',
      imdbId: imdbId,
      season: ep.season,
      episode: ep.episode,
      showName: showName || '',
      epName: ep.title || ('Episode ' + ep.episode),
      title: (showName ? showName + ' S' + ep.season + 'E' + ep.episode + ' \u2014 ' : '') + (ep.title || ('Episode ' + ep.episode)),
      released: ep.released,
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
function addAllEpisodesToChannel(imdbId, showName, showPoster, showBackdrop) {
  document.querySelectorAll('#channelEpisodeList .channelEpisodeCheck').forEach((cb) => {
    cb.checked = true;
  });
  addCheckedEpisodesToChannel(imdbId, showName, showPoster, showBackdrop);
}

const LOCAL_CHANNELS_KEY = 'myListAddon:localChannels';

function loadLocalChannels() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_CHANNELS_KEY) || '{}');
  } catch (e) {
    return {};
  }
}

function compressChannelItemsForStorage(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 200).map((it) => ({
    kind: it.kind || 'episode',
    imdbId: it.imdbId || '',
    season: it.season != null ? it.season : 1,
    episode: it.episode != null ? it.episode : 1,
    showName: it.showName || '',
    epName: it.epName || '',
    title: it.title || '',
    released: it.released || '',
    thumbnail: it.thumbnail || it.poster || '',
    poster: it.poster || it.thumbnail || '',
    showPoster: it.showPoster || '',
  }));
}

function saveLocalChannelsMap(map) {
  try {
    localStorage.setItem(LOCAL_CHANNELS_KEY, JSON.stringify(map));
    if (typeof scheduleChannelsSync === 'function') scheduleChannelsSync();
    return true;
  } catch (e) {
    console.warn('saveLocalChannelsMap initial attempt failed, compressing...', e);
    try {
      const compressed = {};
      for (const [id, ch] of Object.entries(map || {})) {
        if (!ch) continue;
        compressed[id] = {
          channelId: ch.channelId,
          name: ch.name || 'Channel',
          poster: ch.poster || null,
          backdrop: ch.backdrop || null,
          items: compressChannelItemsForStorage(ch.items),
          shuffle: !!ch.shuffle,
          dailyRotate: !!ch.dailyRotate,
          createdAt: ch.createdAt || Date.now(),
          updatedAt: ch.updatedAt || Date.now(),
        };
      }
      localStorage.setItem(LOCAL_CHANNELS_KEY, JSON.stringify(compressed));
      if (typeof scheduleChannelsSync === 'function') scheduleChannelsSync();
      return true;
    } catch (err2) {
      console.error('saveLocalChannelsMap failed even after compression:', err2);
      return false;
    }
  }
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
                  dailyRotate: !!payload.dailyRotate,
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
    dailyRotate: !!payload.dailyRotate,
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
    if (confirm('Delete channel "' + name + '"? This will permanently remove it from your saved channels.')) {
      performDelete();
    }
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
  const box = document.getElementById('channelDraftList');
  const badge = document.getElementById('channelDraftCountBadge');
  if (badge) badge.textContent = channelDraftItems.length ? '(' + channelDraftItems.length + ')' : '';
  if (!channelDraftItems.length) {
    box.innerHTML = '<p style="color:var(--muted); font-size:0.85rem;"><small>Nothing added yet &mdash; search above to get started.</small></p>';
    renderChannelPosterPicker();
    renderChannelCrossoverSuggestions();
    return;
  }
  const cardsHtml = channelDraftItems.map((it, i) => {
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

    return '<div class="live-preview-poster-card channel-pick" data-idx="' + i + '" style="position:relative; cursor:grab; user-select:none; touch-action:manipulation;">' +
      '<div style="position:relative; width:100%;">' +
        posterEl +
        '<div style="position:absolute; top:4px; left:4px; z-index:4;">' +
          '<input type="number" class="pos channelPosInput" min="1" max="' + channelDraftItems.length + '" value="' + (i + 1) + '" title="Type position to move" style="width:34px; height:24px; min-height:unset; padding:2px; font-size:0.75rem; text-align:center; border-radius:6px; background:rgba(0,0,0,0.75); color:#fff; border:1px solid rgba(255,255,255,0.3); font-weight:700;">' +
        '</div>' +
        '<button type="button" class="cw-remove-btn channelRemovePickBtn" title="Remove pick" style="z-index:4;">&times;</button>' +
      '</div>' +
      '<div class="live-preview-poster-name" title="' + escapeAttr(firstLine) + '">' + escapeHtml(firstLine) + '</div>' +
      '<div class="live-preview-poster-year" title="' + escapeAttr(secondLine) + '">' + escapeHtml(secondLine) + '</div>' +
    '</div>';
  }).join('');
  
  box.innerHTML = '<div class="poster-grid-3" style="margin-top:10px;">' + cardsHtml + '</div>';
  initChannelHoldDrag();
  renderChannelPosterPicker();
  renderChannelCrossoverSuggestions();
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
  }
];

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
        '<button type="button" class="primary lc-btn" onclick="spliceCrossoverEvent(&quot;' + escapeAttr(event.id) + '&quot;, this)" style="padding:6px 14px; font-size:0.82rem;">' + escapeHtml(btnLabel) + '</button>' +
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

function reverseChannelDraft() {
  if (!channelDraftItems.length) return;
  channelDraftItems.reverse();
  renderChannelDraftList();
}

function removeAllChannelDraftPicks() {
  if (!channelDraftItems.length) return;
  if (!confirm('Remove all ' + channelDraftItems.length + ' picks? This cannot be undone.')) return;
  channelDraftItems = [];
  renderChannelDraftList();
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
  const [item] = channelDraftItems.splice(from, 1);
  channelDraftItems.splice(to, 0, item);
  renderChannelDraftList();
});

let channelHoldDragBound = false;

function initChannelHoldDrag() {
  const container = document.getElementById('channelDraftList');
  if (!container || channelHoldDragBound) return;
  channelHoldDragBound = true;

  let activeCard = null;
  let isDragging = false;
  let holdTimer = null;
  let startX = 0;
  let startY = 0;

  const cancelHold = () => {
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  };

  const stopDrag = () => {
    cancelHold();
    if (isDragging && activeCard) {
      activeCard.classList.remove('dragging');
      reorderChannelDraftFromDom();
    }
    isDragging = false;
    activeCard = null;
    document.body.style.userSelect = '';
  };

  const startDrag = (card) => {
    isDragging = true;
    activeCard = card;
    card.classList.add('dragging');
    document.body.style.userSelect = 'none';
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      try { navigator.vibrate(30); } catch (err) {}
    }
  };

  const handleMove = (clientX, clientY, e) => {
    if (!activeCard) return;

    if (!isDragging) {
      const dist = Math.hypot(clientX - startX, clientY - startY);
      if (dist > 12) {
        cancelHold();
        activeCard = null;
      }
      return;
    }

    if (e && e.cancelable) {
      e.preventDefault();
    }

    const grid = container.querySelector('.poster-grid-3') || container;
    const targetCard = getChannelDragAfterElement(grid, clientX, clientY);
    if (targetCard && targetCard !== activeCard) {
      const box = targetCard.getBoundingClientRect();
      const isAfter = (clientY > box.top + box.height / 2) || (clientY >= box.top && clientX > box.left + box.width / 2);
      if (isAfter) {
        grid.insertBefore(activeCard, targetCard.nextSibling);
      } else {
        grid.insertBefore(activeCard, targetCard);
      }
    }
  };

  container.addEventListener('dragstart', (e) => { e.preventDefault(); });

  // Pointer events for desktop & unified pointer handling
  container.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.channelRemovePickBtn, .channelPosInput')) return;
    const card = e.target.closest('.channel-pick');
    if (!card) return;

    cancelHold();
    activeCard = card;
    isDragging = false;
    startX = e.clientX;
    startY = e.clientY;

    const isTouch = e.pointerType === 'touch' || e.pointerType === 'pen';
    holdTimer = setTimeout(() => {
      startDrag(card);
    }, isTouch ? 180 : 120);
  });

  window.addEventListener('pointermove', (e) => {
    if (!activeCard) return;
    handleMove(e.clientX, e.clientY, e);
  }, { passive: false });

  window.addEventListener('pointerup', () => {
    if (activeCard) stopDrag();
  });

  window.addEventListener('pointercancel', (e) => {
    if (!isDragging) {
      cancelHold();
      activeCard = null;
    } else if (e.pointerType !== 'touch') {
      stopDrag();
    }
  });

  // Dedicated touch listeners for guaranteed mobile gesture prevention
  container.addEventListener('touchstart', (e) => {
    if (e.target.closest('.channelRemovePickBtn, .channelPosInput')) return;
    const card = e.target.closest('.channel-pick');
    if (!card || e.touches.length !== 1) return;

    cancelHold();
    activeCard = card;
    isDragging = false;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;

    holdTimer = setTimeout(() => {
      startDrag(card);
    }, 180);
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (!activeCard || !e.touches || e.touches.length !== 1) return;
    if (isDragging && e.cancelable) {
      e.preventDefault();
    }
    handleMove(e.touches[0].clientX, e.touches[0].clientY, e);
  }, { passive: false });

  window.addEventListener('touchend', () => {
    if (activeCard) stopDrag();
  });

  window.addEventListener('touchcancel', () => {
    if (activeCard) stopDrag();
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

function reorderChannelDraftFromDom() {
  const container = document.getElementById('channelDraftList');
  const rows = [...container.querySelectorAll('.channel-pick')];
  if (rows.length) {
    channelDraftItems = rows.map((row) => channelDraftItems[parseInt(row.dataset.idx, 10)]).filter(Boolean);
  }
  renderChannelDraftList();
}

function shuffleChannelDraft() {
  if (channelDraftItems.length < 2) return;
  for (let i = channelDraftItems.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = channelDraftItems[i];
    channelDraftItems[i] = channelDraftItems[j];
    channelDraftItems[j] = tmp;
  }
  renderChannelDraftList();
}

let editingChannelId = null;
let editingChannelUrlInput = null;

function saveChannel() {
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
    horizontalBackdrop = (matchedItem && (matchedItem.backdrop || matchedItem.showBackdrop || matchedItem.thumbnail)) || channelDraftBackdrop || null;
  }
  const shuffle = document.getElementById('channelRandomizeCheck').checked;

  const map = loadLocalChannels();
  const channelId = editingChannelId || generateChannelId();
  const existing = map[channelId] || {};
  
  const payload = {
    channelId: channelId,
    name: name,
    poster: verticalPoster,
    backdrop: horizontalBackdrop,
    items: channelDraftItems,
    shuffle: shuffle,
    dailyRotate: existing.dailyRotate || false
  };

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
  
  editingChannelId = null;
  editingChannelUrlInput = null;
  channelDraftItems = [];
  channelDraftPoster = null;
  channelDraftBackdrop = null;
  nameInput.value = '';
  document.getElementById('channelRandomizeCheck').checked = false;
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
  const franchise = String(event.franchise || '').toLowerCase();
  const cat = String(event.category || '').toLowerCase();

  if (cat === 'moviesagas' || event.episodes.every((e) => e.type === 'movie')) {
    cats.push('moviesagas');
  }
  if (cat === 'tvuniverses' || event.episodes.some((e) => e.type === 'show' || e.type === 'season')) {
    cats.push('tvuniverses');
  }
  if (
    franchise.includes('star wars') || franchise.includes('marvel') || franchise.includes('lord of the rings') ||
    franchise.includes('matrix') || franchise.includes('star trek') || franchise.includes('x-files') ||
    franchise.includes('alien') || franchise.includes('planet of the apes') || franchise.includes('jurassic') ||
    franchise.includes('firefly') || franchise.includes('transformers') || franchise.includes('homestead')
  ) {
    cats.push('scifi');
  }
  if (
    franchise.includes('fast & furious') || franchise.includes('batman') || franchise.includes('mission: impossible') ||
    franchise.includes('james bond') || franchise.includes('john wick') || franchise.includes('hunger games') ||
    franchise.includes('indiana jones') || franchise.includes('mad max') || franchise.includes('pirates') ||
    franchise.includes('breaking bad') || franchise.includes('24') || franchise.includes('arrowverse')
  ) {
    cats.push('action');
  }
  if (
    franchise.includes('toy story') || franchise.includes('shrek') || franchise.includes('demon slayer') ||
    franchise.includes('jujutsu') || franchise.includes('futurama') || franchise.includes('cowboy bebop') ||
    franchise.includes('evangelion') || franchise.includes('simpsons') || franchise.includes('bobs') ||
    franchise.includes('steven') || franchise.includes('hey arnold') || franchise.includes('invader') ||
    franchise.includes('beavis')
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
        overlays += '<div class="list-card-count-overlay mobile-only" onclick="openStorylineDetails(&quot;' + escapeAttr(event.id) + '&quot;)" style="cursor:pointer;">' + totalCount + ' &rsaquo;</div>';
      }
      if (isDesktopEnd) {
        overlays += '<div class="list-card-count-overlay desktop-only" onclick="openStorylineDetails(&quot;' + escapeAttr(event.id) + '&quot;)" style="cursor:pointer;">' + totalCount + ' &rsaquo;</div>';
      }

      return '<div class="list-card-mini-poster-tile">' +
        '<div class="list-card-mini-poster-img-wrap" style="position:relative; cursor:pointer;" onclick="openStorylineDetails(&quot;' + escapeAttr(event.id) + '&quot;)">' +
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
          '<div class="list-card-title" onclick="openStorylineDetails(&quot;' + escapeAttr(event.id) + '&quot;)" style="cursor:pointer;">' + escapeHtml(event.name) + '</div>' +
          '<div class="list-card-meta">' +
            '<span>' + escapeHtml(event.franchise) + '</span>' +
            '<span class="list-card-meta-sep">&middot;</span>' +
            '<span>' + escapeHtml(typeBadge) + '</span>' +
            '<span class="list-card-meta-sep">&middot;</span>' +
            '<span>' + escapeHtml(countLabel) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="list-card-actions">' +
          '<button type="button" class="lc-btn ' + (isAdded ? 'secondary is-added' : 'primary') + '" onclick="createInstantStorylineChannel(&quot;' + escapeAttr(event.id) + '&quot;, this)" ' + (isAdded ? 'style="color:var(--danger);"' : '') + '>' + (isAdded ? 'Remove' : '+ Add') + '</button>' +
          '<button type="button" class="lc-btn secondary" onclick="loadStorylineToDraft(&quot;' + escapeAttr(event.id) + '&quot;, this)" title="Customize in Channel Builder">Customize</button>' +
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
              imdbId: showImdbId || String(ep.tmdbId),
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
        imdbId: showImdbId || (epData && epData.imdbId) || String(ep.tmdbId),
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
    const randCheck = document.getElementById('channelRandomizeCheck');
    if (randCheck) randCheck.checked = false;

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
  const nameInput = document.getElementById('channelNameInput');
  if (nameInput) nameInput.value = '';
  const randCheck = document.getElementById('channelRandomizeCheck');
  if (randCheck) randCheck.checked = false;
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
  channelDraftItems = (channel.items || []).slice();
  channelDraftPoster = channel.poster || null;
  channelDraftBackdrop = channel.backdrop || null;
  
  const nameInput = document.getElementById('channelNameInput');
  if (nameInput) nameInput.value = channel.name || '';
  const randCheck = document.getElementById('channelRandomizeCheck');
  if (randCheck) randCheck.checked = !!channel.shuffle;
  
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

function openChannelDetailsPage(channelIdOrDivId) {
  const map = loadLocalChannels();
  let channel = map[channelIdOrDivId];
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
  if (!channel) return;
  
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
  
  const sample = (resolvedItems || []).map((it, idx) => {
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
      id: it.imdbId || it.id || (showName + '-' + (seasonEp || idx)),
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
  
  channels.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));

  box.innerHTML = channels.map((ch) => {
    const isAdded = [...document.querySelectorAll('#lists .entry .url')].some((u) => u.value.includes(ch.channelId));
    const allItems = ch.items || [];
    const totalEpisodes = allItems.length;
    const metaText = '24/7 TV Channel &middot; ' + totalEpisodes + ' episode' + (totalEpisodes === 1 ? '' : 's');
    
    const allPosters = allItems.slice(0, 9);
    const posterThumbs = allPosters.map((it, i) => {
      const isMobileEnd = (i === 2 && allItems.length > 3);
      const isDesktopEnd = (i === allPosters.length - 1 && allItems.length >= 4);
      let overlays = '';
      if (isMobileEnd) {
        overlays += '<div class="list-card-count-overlay mobile-only" style="cursor:pointer;" onclick="event.stopPropagation(); openChannelDetailsPage(&quot;' + escapeAttr(ch.channelId) + '&quot;)">' + totalEpisodes + ' &rsaquo;</div>';
      }
      if (isDesktopEnd) {
        overlays += '<div class="list-card-count-overlay desktop-only" style="cursor:pointer;" onclick="event.stopPropagation(); openChannelDetailsPage(&quot;' + escapeAttr(ch.channelId) + '&quot;)">' + totalEpisodes + ' &rsaquo;</div>';
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
        ? ' style="cursor:pointer;" onclick="event.stopPropagation(); openItemDetailsModal(&quot;' + escapeAttr(itemId) + '&quot;, &quot;' + itemType + '&quot;)"'
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
    
    const addBtnHtml = '<button type="button" class="lc-btn ' + (isAdded ? 'secondary' : 'primary') + '" style="padding:6px 12px; font-size:0.8rem;' + (isAdded ? ' color:var(--danger);' : '') + '" onclick="toggleChannelInCatalog(&quot;' + escapeAttr(ch.channelId) + '&quot;)">' +
      (isAdded ? 'Remove' : '+ Add') +
    '</button>';

    return '<div class="list-card" style="margin-bottom:12px;" data-channel-id="' + escapeAttr(ch.channelId) + '">' +
      '<div class="list-card-header">' +
        '<div class="list-card-body">' +
          '<div class="list-card-title">' + escapeHtml(ch.name) + '</div>' +
          '<div class="list-card-meta">' +
            '<span>' + metaText + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="list-card-actions">' +
          '<button type="button" class="lc-btn secondary" style="padding:6px 12px; font-size:0.8rem;" onclick="editChannelById(&quot;' + escapeAttr(ch.channelId) + '&quot;)">Edit</button>' +
          '<button type="button" class="lc-btn secondary" style="padding:6px 12px; font-size:0.8rem; color:var(--danger);" onclick="deleteLocalChannel(&quot;' + escapeAttr(ch.channelId) + '&quot;, &quot;' + escapeAttr(ch.name) + '&quot;)">Delete</button>' +
          addBtnHtml +
        '</div>' +
      '</div>' +
      (posterThumbs ? '<div class="list-card-posters poster-preview-static">' + posterThumbs + '</div>' : '') +
    '</div>';
  }).join('');
}

function cancelEditChannel() {
  editingChannelId = null;
  editingChannelUrlInput = null;
  channelDraftItems = [];
  channelDraftPoster = null;
  channelDraftBackdrop = null;
  const nameInput = document.getElementById('channelNameInput');
  if (nameInput) nameInput.value = '';
  const randCheck = document.getElementById('channelRandomizeCheck');
  if (randCheck) randCheck.checked = false;
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
const CHANNEL_MAX_TOTAL_ITEMS = 2000;
// Quick Add Channel (network-id based) stores a bigger pool than what's
// ever shown and marks the payload for daily rotation (see dailyRotate
// below and buildChannelMeta server-side) -- the server picks a fresh
// day's lineup from this pool on a schedule, so the channel's actual
// lineup changes over time instead of being permanently fixed to whatever
// happened to build first. This is the storage-side cap for that pool;
// CHANNEL_MAX_TOTAL_ITEMS above stays the safe upper bound (and the only
// cap that applies to the manual "Add every season" button, which has no
// pool/rotation concept).
const CHANNEL_POOL_MAX_ITEMS = 6000;
// What a rotating day's lineup actually looks like -- must match
// CHANNEL_ROTATION_SHOWS_PER_DAY / CHANNEL_ROTATION_EPISODES_PER_SHOW
// server-side. Used here only for display text (the real selection logic
// lives in buildChannelMeta).
const CHANNEL_ROTATION_SHOWS_PER_DAY = 24;
const CHANNEL_ROTATION_EPISODES_PER_SHOW = 3;

async function quickAddChannel(name, listUrl, networkId, btn) {
  const statusBox = document.getElementById('channelQuickAddStatus');
  const originalLabel = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Adding ' + name + '\u2026';
  }
  if (statusBox) statusBox.innerHTML = '<p><small>Adding ' + escapeHtml(name) + '\u2026</small></p>';
  try {
    if (networkId) {
      const res = await fetch(ORIGIN + '/api/channel-preset?networkId=' + encodeURIComponent(networkId) + '&name=' + encodeURIComponent(name));
      const data = await res.json();
      if (btn) {
        btn.disabled = false;
        btn.textContent = originalLabel;
      }
      if (data.ok && data.channel) {
        const channelId = generateChannelId();
        const payload = Object.assign({}, data.channel, { channelId: channelId, name: name });
        saveLocalChannel(payload);
        addRow(name, 'channel:v1:' + JSON.stringify(payload), 'series', true, 'Channels', channelId);
        renderMyCreatedChannelsList();
        renderChannelMergeList();
        showAddedToast('Channel "' + name + '" added to your Catalogs.');
        if (statusBox) {
          statusBox.innerHTML = '<p class="testresult ok" style="margin:4px 0 0;">\u2713 Channel "' + escapeHtml(name) + '" added (' + (payload.items ? payload.items.length : 0) + ' episodes with daily rotation)!</p>';
          setTimeout(() => {
            if (statusBox) statusBox.innerHTML = '';
          }, 4000);
        }
      } else {
        if (statusBox) statusBox.innerHTML = '';
        if (typeof showAppAlert === 'function') {
          showAppAlert('Could Not Add Channel', 'Could not add ' + name + ': ' + (data.error || 'unknown error'));
        } else {
          alert('Could not add ' + name + ': ' + (data.error || 'unknown error'));
        }
      }
      return;
    }

    let params = 'url=' + encodeURIComponent(listUrl);
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
    const items = [];
    let poster = data.networkLogo || null;
    let backdrop = null;
    let showsIncluded = 0;
    let showsTrimmed = 0;
    let stoppedEarly = false;
    for (let i = 0; i < shows.length; i++) {
      if (items.length >= CHANNEL_POOL_MAX_ITEMS) {
        stoppedEarly = true;
        break;
      }
      const show = shows[i];
      if (statusBox) {
        statusBox.innerHTML = '<p><small>Building ' + escapeHtml(name) + '\u2026 show ' + (i + 1) + ' of ' + shows.length +
          ' (' + escapeHtml(show.name) + ')</small></p>';
      }
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
                imdbId: show.imdbId,
                season: season,
                episode: ep.episode,
                showName: show.name || '',
                epName: ep.name || ('Episode ' + ep.episode),
                title: (show.name ? show.name + ' S' + season + 'E' + ep.episode + ' \u2014 ' : '') + (ep.name || ('Episode ' + ep.episode)),
                released: ep.released || '',
                thumbnail: stillUrl || showPosterUrl,
                poster: showPosterUrl || stillUrl,
                showPoster: showPosterUrl,
              });
            });
          });
        let finalShowEpisodes = showEpisodes.length > CHANNEL_MAX_EPISODES_PER_SHOW
          ? showEpisodes.slice(-CHANNEL_MAX_EPISODES_PER_SHOW)
          : showEpisodes;
        if (finalShowEpisodes.length < showEpisodes.length) showsTrimmed++;
        const remainingBudget = CHANNEL_POOL_MAX_ITEMS - items.length;
        if (finalShowEpisodes.length > remainingBudget) {
          finalShowEpisodes = finalShowEpisodes.slice(0, remainingBudget);
          stoppedEarly = true;
        }
        if (finalShowEpisodes.length) showsIncluded++;
        items.push(...finalShowEpisodes);
      } catch (e) {
        continue;
      }
    }
    if (!items.length) {
      if (typeof showAppAlert === 'function') {
        showAppAlert('Could Not Build Channel', 'Could not build ' + name + ' -- no episodes were found.');
      } else {
        alert('Could not build ' + name + ' -- no episodes were found.');
      }
      return;
    }
    const channelId = generateChannelId();
    const payload = { channelId: channelId, name: name, poster: poster, backdrop: backdrop || poster, items: items, shuffle: false, dailyRotate: true };
    saveLocalChannel(payload);
    addRow(name, 'channel:v1:' + JSON.stringify(payload), 'series', true, 'Channels', channelId);
    renderMyCreatedChannelsList();
    renderChannelMergeList();
    showAddedToast('Channel "' + name + '" added to your Catalogs.');
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
  await quickAddChannel(name, listUrl, null, btn);
  urlInput.value = '';
  nameInput.value = '';
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
    if (confirm('Delete merged catalog "' + name + '"? This will permanently remove this merged catalog.')) {
      performDelete();
    }
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
            '<button type="button" class="merge-chip-remove-btn" title="Remove ' + escapeAttr(chName) + ' from merge" onclick="removeChannelFromMerge(&quot;' + escapeAttr(merged.mergedId) + '&quot;, &quot;' + escapeAttr(chId) + '&quot;)">&times;</button>' +
          '</span>';
        }).join('');
        
        const remainingChannels = Object.values(channelsMap).filter((c) => c && !(merged.channelIds || []).includes(c.channelId));
        let addSelectHtml = '';
        if (remainingChannels.length) {
          remainingChannels.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
          const options = remainingChannels.map((c) => '<option value="' + escapeAttr(c.channelId) + '">' + escapeHtml(c.name) + ' (' + (c.items ? c.items.length : 0) + ' ep)</option>').join('');
          addSelectHtml = '<select class="merge-add-channel-select" onchange="addChannelToMerge(&quot;' + escapeAttr(merged.mergedId) + '&quot;, this.value); this.value=&quot;&quot;;">' +
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
        
        const addBtnHtml = '<button type="button" class="lc-btn ' + (isAdded ? 'secondary' : 'primary') + '" style="padding:6px 12px; font-size:0.8rem;' + (isAdded ? ' color:var(--danger);' : '') + '" onclick="toggleMergedChannelInCatalog(&quot;' + escapeAttr(merged.mergedId) + '&quot;)">' +
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
              '<button type="button" class="lc-btn secondary" style="padding:6px 12px; font-size:0.8rem; color:var(--danger);" onclick="deleteLocalMergedChannel(&quot;' + escapeAttr(merged.mergedId) + '&quot;)">Delete</button>' +
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







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
    const res = await fetch(ORIGIN + '/api/title-search?q=' + encodeURIComponent(q) + '&type=tv', { cache: 'no-store' });
    const data = await res.json();
    if (!data.ok) {
      box.innerHTML = '<p class="testresult err">\u2717 ' + escapeHtml(data.error || 'Search failed.') + '</p>';
      return;
    }
    renderChannelTitleResults(data.results);
  } catch (e) {
    box.innerHTML = '<p class="testresult err">\u2717 Network error while searching.</p>';
  }
}

function renderChannelTitleResults(results) {
  const box = document.getElementById('channelSearchResult');
  if (!results.length) {
    box.innerHTML = '<p style="color:var(--muted); font-size:0.85rem;"><small>No matches found.</small></p>';
    return;
  }
  const cardsHtml = results.map((r) => {
    const posterImg = r.poster
      ? '<img class="preview-thumb" src="' + escapeAttr(r.poster) + '" alt="" loading="lazy" style="cursor:pointer;">'
      : '<div class="preview-thumb" style="display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:0.7rem;text-align:center;padding:4px;cursor:pointer;">No poster</div>';
    return '<div class="custom-list-search-item channelTitleCard" style="display:flex; flex-direction:column; align-items:center; width:100%; min-width:0; cursor:pointer;"' +
      ' data-tmdbid="' + r.tmdbId + '" data-title="' + escapeAttr(r.title) + '" data-poster="' + escapeAttr(r.poster || '') + '" data-backdrop="' + escapeAttr(r.backdrop || '') + '">' +
      posterImg +
      '<div style="width:100%; font-size:0.75rem; font-weight:600; text-align:center; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin:4px 0 1px;" title="' + escapeAttr(r.title) + '">' +
        escapeHtml(r.title) +
      '</div>' +
      (r.year ? '<div style="font-size:0.7rem; color:var(--muted); text-align:center; margin-bottom:4px;">' + escapeHtml(r.year) + '</div>' : '<div style="height:14px; margin-bottom:4px;"></div>') +
      '<button type="button" class="lc-btn secondary channelTitleBtn" style="width:100%; padding:4px 6px; font-size:0.75rem;"' +
      ' data-tmdbid="' + r.tmdbId + '" data-title="' + escapeAttr(r.title) + '" data-poster="' + escapeAttr(r.poster || '') + '" data-backdrop="' + escapeAttr(r.backdrop || '') + '">+ Browse</button>' +
      '</div>';
  }).join('');
  box.innerHTML = '<div class="poster-grid-3" style="margin-top:10px;">' + cardsHtml + '</div>';
}

document.getElementById('channelSearchResult').addEventListener('click', (e) => {
  const target = e.target.closest('.channelTitleCard, .channelTitleBtn');
  if (!target) return;
  browseChannelShow(target.dataset.tmdbid, target.dataset.title, target.dataset.poster, target.dataset.backdrop);
});

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
  const verticalPoster = channelDraftPoster || (channelDraftItems[0] && channelDraftItems[0].poster) || null;
  const horizontalBackdrop = channelDraftBackdrop || (channelDraftItems[0] && (channelDraftItems[0].thumbnail || channelDraftItems[0].backdrop)) || channelDraftPoster || null;
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

  if (!foundRow && !editingChannelId) {
    addRow(name, 'channel:v1:' + JSON.stringify(payload), 'series', true, 'Channels', channelId);
    showAddedToast('Channel "' + name + '" saved and added to your Catalogs.');
  } else {
    showAddedToast('Channel "' + name + '" saved.');
  }

  saveState();
  
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
}

function switchChannelsSubmenu(name, btn) {
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
  
  const sample = (channel.items || []).map((it, idx) => {
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
      type: 'series',
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
      
      return '<div class="list-card-mini-poster-tile">' +
        '<div class="list-card-mini-poster-img-wrap">' +
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
      (posterThumbs ? '<div class="list-card-posters poster-preview-static" style="cursor:pointer;" onclick="openChannelDetailsPage(&quot;' + escapeAttr(ch.channelId) + '&quot;)">' + posterThumbs + '</div>' : '') +
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
  if (titleEl) {
    titleEl.innerHTML = (editingChannelId || editingChannelUrlInput ? 'Edit TV Channel' : 'Build Custom Channel') + ' <span class="badge" id="channelDraftCountBadge"></span>';
    const badge = document.getElementById('channelDraftCountBadge');
    if (badge) badge.textContent = channelDraftItems.length ? '(' + channelDraftItems.length + ')' : '';
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
  
  addRow(combinedName, urls.join('\\n'), 'series', true, 'Channels', merged.mergedId);
  nameInput.value = '';
  saveState();
  renderChannelMergeList();
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







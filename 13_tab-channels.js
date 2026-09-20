<div class="tab-panel" data-tab-panel="channels" id="content-channels" role="tabpanel" aria-labelledby="tab-desktop-channels" hidden>
  <!-- Top Submenu Pills for Channels -->
  <div class="subnav-pills-bar" id="channelsSubnavBar">
    <button type="button" class="subnav-pill active" data-sub="my-channels" onclick="switchChannelsSubmenu('my-channels', this)"><span class="check-icon">&#x2713;</span> My Channels</button>
    <button type="button" class="subnav-pill" data-sub="storylines" onclick="switchChannelsSubmenu('storylines', this)">Storylines &amp; Universes</button>
    <button type="button" class="subnav-pill" data-sub="quickadd" onclick="switchChannelsSubmenu('quickadd', this)">Quick Add</button>
    <button type="button" class="subnav-pill" data-sub="explore" onclick="switchChannelsSubmenu('explore', this)">Explore Channels</button>
    <button type="button" class="subnav-pill" data-sub="import" onclick="switchChannelsSubmenu('import', this)">Import</button>
  </div>

  <!-- Submenu: Storylines & Universes (Canon Timelines, Sagas & Bridges) -->
  <div class="channels-subpanel" id="channelsSubStorylines" style="display:none;">
    <div class="panel">
      <div class="shelf-header" style="margin-bottom:8px;">
        <h2 class="shelf-title">Storylines, Sagas &amp; Universes</h2>
      </div>
      <p style="margin:0 0 14px; color:var(--muted); font-size:0.85rem;">
        Complete franchise timelines, movie trilogies &amp; sagas (3+ films), and TV-to-movie universes in canon chronological watch order. Add any saga directly to your Catalogs or launch it as a continuous 24/7 channel with 1-click.
      </p>

      <!-- Category Filter Tabs -->
      <div class="subnav-pills-bar" id="storylineCategoryFilterBar" style="margin-bottom:16px; flex-wrap:wrap;">
        <button type="button" class="subnav-pill active" onclick="filterStorylinesCategory('all', this)"><span class="check-icon">&#x2713;</span> All Sagas</button>
        <button type="button" class="subnav-pill" onclick="filterStorylinesCategory('moviesagas', this)">Movie Sagas (3+ Films)</button>
        <button type="button" class="subnav-pill" onclick="filterStorylinesCategory('tvuniverses', this)">TV Universes &amp; Bridges</button>
        <button type="button" class="subnav-pill" onclick="filterStorylinesCategory('scifi', this)">Sci-Fi &amp; Fantasy</button>
        <button type="button" class="subnav-pill" onclick="filterStorylinesCategory('action', this)">Action &amp; Crime</button>
        <button type="button" class="subnav-pill" onclick="filterStorylinesCategory('animation', this)">Animation &amp; Anime</button>
      </div>

      <div id="storylinesUniverseList" style="display:flex; flex-direction:column; gap:16px;"></div>
    </div>
  </div>

  <!-- Submenu 1: My Channels -->
  <div class="channels-subpanel" id="channelsSubMyChannels">
    <div class="panel">
      <div class="shelf-header" style="margin-bottom:10px;">
        <h2 class="shelf-title">My Channels</h2>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button type="button" class="secondary lc-btn" onclick="createNextUpChannel(this)" title="A channel that always plays the next episode of everything you have on the go">+ Next Up Channel</button>
          <button type="button" class="primary lc-btn" onclick="openBuildCustomChannel()">+ New Channel</button>
        </div>
      </div>
      <p style="margin:0 0 10px; color:var(--muted); font-size:0.85rem;">Your custom built and saved 24/7 TV channels. Play episodes continuously in broadcast order or daily shuffle.</p>
      <div id="channelNextUpStatus" style="margin-bottom:8px;"></div>
      <div class="row" id="myChannelsToolbar" style="margin-bottom:10px; gap:8px;">
        <input type="text" id="myChannelsSearchInput" aria-label="Search your channels" placeholder="Search your channels..." oninput="setMyChannelsSearch(this.value)">
        <select id="myChannelsSortSelect" aria-label="Order your channels" onchange="setMyChannelsSort(this.value)" style="flex:none; width:auto;">
          <option value="recent">Recently updated</option>
          <option value="created">Recently created</option>
          <option value="name">Name (A&ndash;Z)</option>
          <option value="size">Most episodes</option>
          <option value="manual">My order (drag to arrange)</option>
        </select>
      </div>
      <div id="myChannelsUndoBar" style="display:none; margin-bottom:10px;"></div>
      <div id="myCreatedChannelsList"><p style="color:var(--muted); font-size:0.85rem;"><small>No channels created yet. Tap <strong>+ New Channel</strong> above or add a popular network in <strong>Quick Add</strong>.</small></p></div>
    </div>

    <div class="panel" style="margin-top:12px;">
      <div class="shelf-header" style="margin-bottom:8px;">
        <h2 class="shelf-title">Merge Saved Channels into One Catalog</h2>
      </div>
      <p style="margin:0 0 12px; color:var(--muted); font-size:0.85rem;">Combine multiple saved TV channels into a single catalog row on your Catalogs shelf.</p>
      
      <div id="savedMergedChannelsSection" style="margin-bottom:16px;">
        <div id="savedMergedChannelsList"></div>
      </div>

      <div style="border-top:1px solid var(--border); padding-top:12px; margin-top:12px;">
        <div class="shelf-header" style="margin-bottom:8px;">
          <h3 style="font-size:0.95rem; font-weight:700; margin:0;">Create Merged Catalog</h3>
        </div>
        <div class="actions" style="margin-bottom:8px; justify-content:space-between;">
          <button type="button" class="secondary lc-btn" onclick="renderChannelMergeList()">Refresh list</button>
          <label style="display:flex; align-items:center; gap:6px; cursor:pointer; font-size:0.85rem; user-select:none;">
            <input type="checkbox" id="channelMergeSelectAllCheck" onchange="toggleAllChannelMergeChecks(this)">
            <span>Select all</span>
          </label>
        </div>
        <div id="channelMergeList"><p style="color:var(--muted); font-size:0.85rem;"><small>No saved channels yet.</small></p></div>
        <div class="row" style="margin-top:8px;">
          <input type="text" id="channelMergeNameInput" aria-label="Combined catalog name" placeholder="Combined catalog name (e.g. Live TV)">
          <button type="button" class="secondary" onclick="mergeChannelsIntoRow()">Merge into catalog</button>
        </div>
      </div>
    </div>
  </div>

  <!-- Submenu 2: Quick Add Popular Networks -->
  <div class="channels-subpanel" id="channelsSubQuickAdd" style="display:none;">
    <div class="panel">
      <div class="shelf-header" style="margin-bottom:8px;">
        <h2 class="shelf-title">Quick Add Popular Networks</h2>
      </div>
      <p class="qa-shelf-sub">Instant 1-click TV channels with up to 5,000 episodes, rotating 24 shows with 3 episodes every 24 hours:</p>
      <div class="channel-quick-grid">
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="A&amp;E" data-networkid="129">A&amp;E</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="ABC" data-networkid="2">ABC</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="Adult Swim" data-networkid="80">Adult Swim</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="AMC" data-networkid="174">AMC</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="BBC One" data-networkid="4">BBC One</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="Cartoon Network" data-networkid="56">Cartoon Network</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="CBS" data-networkid="16">CBS</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="Comedy Central" data-networkid="47">Comedy Central</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="Discovery" data-networkid="64">Discovery</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="Disney Channel" data-networkid="54">Disney Channel</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="Food Network" data-networkid="143">Food Network</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="FOX" data-networkid="19">FOX</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="FX" data-networkid="88">FX</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="Hallmark Channel" data-networkid="384">Hallmark Channel</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="HBO" data-networkid="49">HBO</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="HGTV" data-networkid="209">HGTV</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="History" data-networkid="65">History</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="Ion Television" data-networkid="436">Ion Television</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="MeTV" data-networkid="738">MeTV</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="MTV" data-networkid="33">MTV</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="NBC" data-networkid="6">NBC</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="Nickelodeon" data-networkid="13">Nickelodeon</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="Syfy" data-networkid="149">Syfy</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="TBS" data-networkid="68">TBS</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="The CW" data-networkid="71">The CW</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="TLC" data-networkid="84">TLC</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="TNT" data-networkid="41">TNT</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="USA Network" data-networkid="30">USA Network</button>
      </div>
      <div id="channelQuickAddStatus" style="margin-top:8px;"></div>
    </div>
  </div>

  <!-- Submenu: Explore Channels (the community directory) -->
  <div class="channels-subpanel" id="channelsSubExplore" style="display:none;">
    <div class="panel">
      <div class="shelf-header" style="margin-bottom:8px;">
        <h2 class="shelf-title">Explore Channels</h2>
        <button type="button" class="secondary lc-btn" onclick="loadChannelDirectory(true)">Refresh</button>
      </div>
      <p style="margin:0 0 14px; color:var(--muted); font-size:0.85rem;">
        24/7 channels built and published by other people &mdash; &ldquo;Saturday Morning 90s&rdquo;, &ldquo;80s VHS Sci-Fi Vault&rdquo;, whatever anyone has put together. Add one to your own setup in a single click, then edit it however you like.
      </p>
      <div class="row" style="margin-bottom:10px; gap:8px;">
        <input type="text" id="channelDirectorySearchInput" aria-label="Filter published channels" placeholder="Filter by name, description or creator..." oninput="renderChannelDirectory()">
        <select id="channelDirectorySortSelect" aria-label="Order published channels" onchange="setChannelDirectorySort(this.value)" style="flex:none; width:auto;">
          <option value="newest">Newest</option>
          <option value="added">Most added</option>
          <option value="liked">Most liked</option>
          <option value="name">Name (A&ndash;Z)</option>
        </select>
      </div>
      <div id="channelDirectoryFeed"><p style="color:var(--muted); font-size:0.85rem;"><small>Loading published channels&hellip;</small></p></div>
    </div>
  </div>

  <!-- Submenu 3: Import & Merge Tools -->
  <div class="channels-subpanel" id="channelsSubImport" style="display:none;">
    <div class="panel">
      <div class="shelf-header" style="margin-bottom:8px;">
        <h2 class="shelf-title">Import channel from a link</h2>
      </div>
      <p style="margin:0 0 12px; color:var(--muted); font-size:0.85rem;">Paste any MDBList, Trakt, or TMDB show list URL to import directly as a TV channel catalog.</p>
      <div class="row" style="margin-bottom:8px;">
        <input type="text" id="channelImportUrlInput" placeholder="mdblist.com, trakt.tv, or themoviedb.org show list URL">
      </div>
      <div class="row">
        <input type="text" id="channelImportNameInput" placeholder="Channel name (e.g. Sitcom Central)">
        <button type="button" class="secondary" onclick="importChannelFromLink(this)">Import channel</button>
      </div>
      <label class="channel-rule-row" style="margin-top:10px;">
        <input type="checkbox" id="channelImportLiveSyncCheck" checked>
        <span>Live Cloud Sync &mdash; keep this channel following the list instead of taking a one-time snapshot</span>
      </label>
      <p style="margin:2px 0 0 24px; color:var(--muted); font-size:0.78rem;">The channel remembers the list URL and rebuilds its pool in the background, so titles the list gains turn up here on their own.</p>
    </div>

    <div class="panel" style="margin-top:12px;">
      <div class="shelf-header" style="margin-bottom:8px;">
        <h2 class="shelf-title">Add a shared channel</h2>
      </div>
      <p style="margin:0 0 12px; color:var(--muted); font-size:0.85rem;">Paste a channel share link (or just its code) to rebuild that exact channel here &mdash; every pick, its play order and its broadcast schedule.</p>
      <div class="row">
        <input type="text" id="channelShareCodeInput" placeholder="https://... /channel/AbC123 &mdash; or the code on its own" onkeydown="if(event.key==='Enter'){event.preventDefault();importSharedChannel(this);}">
        <button type="button" class="secondary" onclick="importSharedChannel(this)">Add channel</button>
      </div>
      <div id="channelShareImportStatus" style="margin-top:8px;"></div>
    </div>
  </div>

  <!-- Custom Channel Builder / Editor -->
  <div class="channels-subpanel" id="channelsSubBuild" style="display:none;">
    <div class="panel">
      <div class="shelf-header" style="margin-bottom:10px;">
        <h2 class="shelf-title" id="channelEditorTitle">Build Custom Channel</h2>
      </div>
      <p style="margin:0 0 12px; color:var(--muted); font-size:0.85rem;">Search any TV show or movie to add to your channel, and reorder or remove picks:</p>
      <div class="subnav-pills-bar" id="channelSearchTypeChips" style="margin-bottom:10px;">
        <button type="button" class="subnav-pill active" id="channelSearchTypeShowsBtn" onclick="setChannelSearchType('tv', this)"><span class="check-icon">&#x2713;</span> Shows</button>
        <button type="button" class="subnav-pill" id="channelSearchTypeMoviesBtn" onclick="setChannelSearchType('movie', this)">Movies</button>
        <button type="button" class="subnav-pill" id="channelSearchTypePeopleBtn" onclick="setChannelSearchType('person', this)">Actors &amp; Directors</button>
      </div>
      <div class="row">
        <input type="text" id="channelSearchInput" placeholder="Search a show by name..." onkeydown="if(event.key==='Enter'){event.preventDefault();runChannelTitleSearch();}">
        <button type="button" class="secondary" onclick="runChannelTitleSearch()">Search</button>
      </div>
      <div id="channelSearchResult"></div>
      <div id="channelEpisodePicker"></div>

      <div id="channelCrossoverSuggestions" style="display:none; margin-top:14px;"></div>

      <p style="margin-top:14px; margin-bottom:6px; font-weight:600; font-size:0.85rem;">Picks in this channel: <span id="channelDraftCountBadge" style="color:var(--muted); font-weight:500;"></span></p>
      <div id="channelDraftStats" style="margin:0 0 8px; color:var(--muted); font-size:0.78rem;"></div>
      <div class="row" style="margin-bottom:8px; gap:8px;">
        <input type="text" id="channelDraftFilterInput" aria-label="Filter these picks" placeholder="Filter these picks by show or episode name..." oninput="setChannelDraftFilter(this.value)">
        <button type="button" class="secondary lc-btn" id="channelDraftSelectModeBtn" style="flex:none; width:auto; white-space:nowrap;" onclick="toggleChannelDraftSelectMode()">Select</button>
      </div>
      <div id="channelDraftBulkBar" style="display:none; flex-wrap:wrap; gap:6px; align-items:center; margin-bottom:8px; padding:8px; border:1px solid var(--border); border-radius:8px; background:var(--surface);">
        <span id="channelDraftSelectionCount" style="font-size:0.8rem; font-weight:600;">0 selected</span>
        <button type="button" class="secondary lc-btn" onclick="selectAllChannelDraftShown(true)">Select shown</button>
        <button type="button" class="secondary lc-btn" onclick="selectAllChannelDraftShown(false)">Clear</button>
        <select id="channelDraftSelectShowSelect" onchange="selectChannelDraftByGroup(this.value); this.selectedIndex = 0;" style="font-size:0.82rem; padding:5px 8px; background:var(--bg); color:var(--text); border:1px solid var(--border); border-radius:8px;">
          <option value="">Select a whole show or season&hellip;</option>
        </select>
        <span style="flex:1;"></span>
        <button type="button" class="secondary lc-btn" onclick="pairChannelDraftSelection()" title="Play these picks back to back, in this order">Pair</button>
        <button type="button" class="secondary lc-btn" onclick="unpairChannelDraftSelection()" title="Drop any hand-made pairing on these picks">Unpair</button>
        <button type="button" class="secondary lc-btn" onclick="moveChannelDraftSelection('top')">To top</button>
        <button type="button" class="secondary lc-btn" onclick="moveChannelDraftSelection('bottom')">To bottom</button>
        <button type="button" class="secondary lc-btn" style="color:var(--danger); border-color:rgba(255,59,48,0.25);" onclick="removeChannelDraftSelection()">Remove selected</button>
      </div>
      <div id="channelDraftList"><p style="color:var(--muted); font-size:0.85rem;"><small>Nothing added yet &mdash; search above to get started.</small></p></div>
      <div class="actions" style="margin-top:8px; justify-content:flex-start; gap:8px;">
        <button type="button" class="secondary lc-btn" onclick="shuffleChannelDraft(); showAddedToast('Channel picks shuffled.');">Shuffle picks now</button>
        <button type="button" class="secondary lc-btn" style="color:var(--danger); border-color:rgba(255,59,48,0.25);" onclick="removeAllChannelDraftPicks()">Remove All</button>
      </div>
      <div id="channelVisibilityRow" style="margin-top:12px; margin-bottom:10px; display:flex; justify-content:space-between; align-items:center; max-width:280px;">
        <span style="font-size:0.95rem; font-weight:500; color:var(--text);">Public</span>
        <label class="ui-toggle">
          <input type="checkbox" id="channelPublicToggle" checked>
          <span class="ui-toggle-slider"></span>
        </label>
      </div>
      <!-- Advanced Settings (Progressive Disclosure) -->
      <details class="channel-advanced-details" style="margin-top:14px; border:1px solid var(--border); border-radius:8px; padding:10px 14px; background:var(--surface);">
        <summary style="font-weight:600; font-size:0.88rem; cursor:pointer; user-select:none; color:var(--text); display:flex; align-items:center; justify-content:space-between;">
          <span>Advanced Settings</span>
          <span style="font-size:0.75rem; color:var(--muted); font-weight:normal;">Play order, rotation &amp; broadcast schedule</span>
        </summary>
        <div style="margin-top:14px; border-top:1px solid var(--border); padding-top:12px;">
          <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px; flex-wrap:wrap;">
            <label for="channelPlayOrderSelect" style="font-size:0.85rem; font-weight:600; white-space:nowrap;">Play order:</label>
            <select id="channelPlayOrderSelect" onchange="applyChannelPlayOrder(this.value)" style="flex:1; min-width:210px; font-size:0.85rem; padding:6px 10px; background:var(--surface); color:var(--text); border:1px solid var(--border); border-radius:8px;">
              <option value="as-listed">Creation order (as listed)</option>
              <option value="aired-asc">Air date &mdash; oldest first</option>
              <option value="aired-desc">Air date &mdash; newest first</option>
              <option value="show-season-episode">Show, then season &amp; episode</option>
              <option value="interleave">Interleaved &mdash; one episode per show, in turn</option>
              <option value="title-az">Title A&ndash;Z</option>
              <option value="shuffle-daily">Shuffle daily (reshuffles every 24h)</option>
            </select>
          </div>
          <p id="channelPlayOrderHint" style="margin:0 0 14px; color:var(--muted); font-size:0.78rem;">Picks play in the order you created above &mdash; drag one, or type a new position, to change it.</p>

          <!-- Broadcast schedule & smart rules -->
          <div style="border-top:1px solid var(--border); padding-top:12px;">
            <p style="margin:0 0 8px; font-weight:600; font-size:0.85rem;">Broadcast schedule</p>
            <label class="channel-rule-row">
              <input type="checkbox" id="channelDailyRotateCheck" onchange="updateChannelBroadcastControls()">
              <span>Daily Broadcast Schedule &mdash; run a fresh lineup out of these picks every day</span>
            </label>
            <div id="channelDailyRotateDials" style="display:none; margin:8px 0 0 24px; flex-wrap:wrap; gap:10px;">
              <label class="channel-dial">Shows per day
                <input type="number" id="channelRotateShowsInput" min="1" max="48" step="1" value="24" onchange="updateChannelBroadcastControls()">
              </label>
              <label class="channel-dial">Episodes per block
                <input type="number" id="channelRotateEpisodesInput" min="1" max="12" step="1" value="3" onchange="updateChannelBroadcastControls()">
              </label>
              <label class="channel-dial">Turns over at
                <input type="time" id="channelRotateTurnoverTime" value="00:00" onchange="updateChannelBroadcastControls()">
              </label>
              <label class="channel-dial">In
                <select id="channelRotateTurnoverZone" onchange="updateChannelBroadcastControls()">
                  <option value="utc">UTC</option>
                  <option value="local">my local time</option>
                </select>
              </label>
            </div>
            <p id="channelDailyRotateHint" style="margin:6px 0 0 24px; color:var(--muted); font-size:0.78rem;">Off &mdash; every pick in this channel plays, in the order above.</p>

            <label class="channel-rule-row" style="margin-top:10px;">
              <input type="checkbox" id="channelHideWatchedCheck">
              <span>Hide watched &mdash; skip episodes already in my watch history</span>
            </label>
            <p style="margin:2px 0 0 24px; color:var(--muted); font-size:0.78rem;">Needs Auto-track playback signed in. Once every pick has been seen, the whole channel comes back rather than going dark. Leave it off to keep watched episodes in the rotation.</p>

            <label class="channel-rule-row" style="margin-top:10px;">
              <input type="checkbox" id="channelPairPartsCheck" onchange="updateChannelBroadcastControls()">
              <span>Keep multi-part episodes together</span>
            </label>
            <p id="channelPairPartsHint" style="margin:2px 0 0 24px; color:var(--muted); font-size:0.78rem;">Finds &ldquo;Part 1&rdquo; / &ldquo;Pt. II&rdquo; / &ldquo;(2)&rdquo; in episode titles. Whenever one part is on today, the rest play straight after it instead of turning up tomorrow.</p>

            <label class="channel-rule-row" style="margin-top:10px;">
              <input type="checkbox" id="channelAutoNewEpisodesCheck" onchange="updateChannelBroadcastControls()">
              <span>Automatically add new episodes</span>
            </label>
            <div id="channelNewEpisodesRow" style="display:none; margin:6px 0 0 24px;">
              <label class="channel-rule-row">
                <input type="checkbox" id="channelNewEpisodesTopCheck">
                <span>Put new episodes at the top</span>
              </label>
            </div>
            <p id="channelAutoNewEpisodesHint" style="margin:2px 0 0 24px; color:var(--muted); font-size:0.78rem;">Off &mdash; this channel plays the picks below and nothing else.</p>

            <div id="channelLiveSyncRow" style="display:none; margin-top:10px;">
              <label class="channel-rule-row">
                <input type="checkbox" id="channelLiveSyncCheck">
                <span>Live Cloud Sync &mdash; refresh this channel from its source list</span>
              </label>
              <p id="channelLiveSyncHint" style="margin:2px 0 0 24px; color:var(--muted); font-size:0.78rem;"></p>
            </div>

            <div id="channelStoryLockSection" style="margin-top:12px;"></div>
          </div>
        </div>
      </details>

      <!-- Channel Poster Selection Section -->
      <div id="channelPosterPickerSection" style="margin-top:14px; border-top:1px solid var(--border); padding-top:12px; display:none;">
        <p style="margin:0 0 4px; font-weight:600; font-size:0.85rem;">Channel Poster:</p>
        <p style="margin:0 0 10px; color:var(--muted); font-size:0.8rem;">Choose a show poster (ranked by most episodes) or choose our custom channel poster.</p>
        <div id="channelPosterChoicesGrid" style="display:grid; grid-template-columns:repeat(auto-fill, minmax(90px, 1fr)); gap:10px;"></div>
        <div style="margin-top:12px;">
          <p style="margin:0 0 6px; font-size:0.8rem; font-weight:600; color:var(--muted);">Or use a custom image URL (JPEG, PNG, WebP, GIF):</p>
          <div class="row" style="gap:8px;">
            <input type="url" id="channelPosterUrlInput" placeholder="https://example.com/poster.jpg" style="flex:1; font-size:0.82rem;">
            <button type="button" class="secondary" style="white-space:nowrap; font-size:0.82rem;" onclick="applyChannelPosterUrl()">Use This</button>
          </div>
          <div id="channelPosterUrlPreview" style="margin-top:8px; align-items:center; gap:10px; display:none;">
            <img id="channelPosterUrlImg" src="" alt="Poster preview" style="width:54px; height:80px; object-fit:cover; border-radius:4px; border:2px solid var(--accent);" loading="lazy">
            <span id="channelPosterUrlStatus" style="font-size:0.78rem; color:var(--muted);"></span>
          </div>
        </div>
      </div>

      <div class="row" style="margin-top:12px;">
        <input type="text" id="channelNameInput" placeholder="Channel name (e.g. Comedy Night)" style="flex:1;">
        <button type="button" class="primary" id="channelSaveBtn" onclick="saveChannel()">Save</button>
        <button type="button" id="channelCancelEditBtn" class="secondary" style="display:none;" onclick="cancelEditChannel()">Cancel</button>
      </div>
    </div>
  </div>
</div>

<div class="tab-panel" data-tab-panel="search" id="content-search" role="tabpanel" aria-labelledby="tab-desktop-search" hidden>
  <div class="panel">
    <div class="shelf-header" style="margin-bottom:10px;">
      <h2 class="shelf-title">Search Movies, TV Shows &amp; Lists</h2>
    </div>
    <p style="margin:0 0 12px; color:var(--muted); font-size:0.85rem;">Search to find movies, shows and lists to add to your lists.</p>
    
    <div class="row">
      <input type="text" id="catalogSearchInput" aria-label="Search by title or list name" placeholder="Search by title or list name..." oninput="handleCatalogSearchInput(this)" onkeydown="if(event.key==='Enter'){event.preventDefault();runCatalogSearch();}">
      <button type="button" class="primary" onclick="runCatalogSearch()">Search</button>
    </div>

    <div class="subnav-pills-bar" id="catalogSearchTypeChips" style="margin-top:10px;">
      <button type="button" class="subnav-pill active" onclick="setCatalogSearchFilter('movie', this)"><span class="check-icon">&#x2713;</span> Movies</button>
      <button type="button" class="subnav-pill" onclick="setCatalogSearchFilter('tv', this)">Shows</button>
      <button type="button" class="subnav-pill" onclick="setCatalogSearchFilter('lists', this)">Lists</button>
    </div>

    <!-- Quick Filter Dropdowns for Movies & Shows -->
    <div id="catalogSearchFiltersRow" style="display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; align-items:center;">
      <select id="catalogSearchGenreSelect" aria-label="Filter by genre" onchange="applySearchFilters()" style="flex:1; min-width:130px; font-size:0.85rem; padding:6px 10px; background:var(--surface); color:var(--text); border:1px solid var(--border); border-radius:8px;">
        <option value="">All Genres</option>
        <option value="28,10759">Action &amp; Adventure</option>
        <option value="16">Animation</option>
        <option value="35">Comedy</option>
        <option value="80">Crime</option>
        <option value="99">Documentary</option>
        <option value="18">Drama</option>
        <option value="10751,10762">Family &amp; Kids</option>
        <option value="14,878,10765">Fantasy &amp; Sci-Fi</option>
        <option value="36">History</option>
        <option value="27">Horror</option>
        <option value="10402">Music</option>
        <option value="9648">Mystery</option>
        <option value="10749">Romance</option>
        <option value="53">Thriller</option>
        <option value="10752,10768">War &amp; Politics</option>
        <option value="37">Western</option>
      </select>

      <select id="catalogSearchYearSelect" aria-label="Filter by year" onchange="applySearchFilters()" style="flex:1; min-width:115px; font-size:0.85rem; padding:6px 10px; background:var(--surface); color:var(--text); border:1px solid var(--border); border-radius:8px;">
        <option value="">All Years</option>
        <option value="2026">2026</option>
        <option value="2025">2025</option>
        <option value="2024">2024</option>
        <option value="2023">2023</option>
        <option value="2020-2022">2020–2022</option>
        <option value="2010-2019">2010s</option>
        <option value="2000-2009">2000s</option>
        <option value="1990-1999">1990s</option>
        <option value="<1990">1980s &amp; Older</option>
      </select>

      <select id="catalogSearchRatingSelect" aria-label="Filter by minimum rating" onchange="applySearchFilters()" style="flex:1; min-width:115px; font-size:0.85rem; padding:6px 10px; background:var(--surface); color:var(--text); border:1px solid var(--border); border-radius:8px;">
        <option value="">All Ratings</option>
        <option value="8.0">8.0+ ⭐</option>
        <option value="7.0">7.0+ ⭐</option>
        <option value="6.0">6.0+ ⭐</option>
        <option value="5.0">5.0+ ⭐</option>
      </select>

      <button type="button" id="catalogSearchResetFiltersBtn" class="secondary lc-btn" onclick="resetSearchFilters()" style="font-size:0.8rem; padding:6px 10px; height:auto; display:none;">Reset</button>
    </div>

    <div id="catalogSearchResult" style="margin-top:14px;"></div>
  </div>
</div>

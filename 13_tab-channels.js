<div class="tab-panel" data-tab-panel="channels" hidden>
  <!-- Top Submenu Pills for Channels -->
  <div class="subnav-pills-bar" id="channelsSubnavBar">
    <button type="button" class="subnav-pill active" onclick="switchChannelsSubmenu('my-channels', this)"><span class="check-icon">&#x2713;</span> My Channels</button>
    <button type="button" class="subnav-pill" onclick="switchChannelsSubmenu('quickadd', this)">Quick Add</button>
    <button type="button" class="subnav-pill" onclick="switchChannelsSubmenu('import', this)">Import</button>
  </div>

  <!-- Submenu 1: My Channels -->
  <div class="channels-subpanel" id="channelsSubMyChannels">
    <div class="panel">
      <div class="shelf-header" style="margin-bottom:10px;">
        <h2 class="shelf-title">My Channels</h2>
        <button type="button" class="primary lc-btn" onclick="openBuildCustomChannel()">+ New Channel</button>
      </div>
      <p style="margin:0 0 14px; color:var(--muted); font-size:0.85rem;">Your custom built and saved 24/7 TV channels. Play episodes continuously in broadcast order or daily shuffle.</p>
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
          <input type="text" id="channelMergeNameInput" placeholder="Combined catalog name (e.g. Live TV)">
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
      <p style="margin:0 0 12px; color:var(--muted); font-size:0.85rem;">Instant 1-click TV channels with automatic daily episode rotation:</p>
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

  <!-- Submenu 3: Import & Merge Tools -->
  <div class="channels-subpanel" id="channelsSubImport" style="display:none;">
    <div class="panel">
      <div class="shelf-header" style="margin-bottom:8px;">
        <h2 class="shelf-title">Import Channel from a Link</h2>
      </div>
      <p style="margin:0 0 12px; color:var(--muted); font-size:0.85rem;">Paste any show list URL (MDBList or Trakt) to automatically generate a TV channel catalog.</p>
      <div class="row" style="margin-bottom:8px;">
        <input type="text" id="channelImportUrlInput" placeholder="Show list URL (mdblist.com or trakt.tv)">
      </div>
      <div class="row">
        <input type="text" id="channelImportNameInput" placeholder="Channel name (e.g. Sitcom Central)">
        <button type="button" class="secondary" onclick="importChannelFromLink(this)">Import channel</button>
      </div>
    </div>
  </div>

  <!-- Custom Channel Builder / Editor -->
  <div class="channels-subpanel" id="channelsSubBuild" style="display:none;">
    <div class="panel">
      <div class="shelf-header" style="margin-bottom:10px;">
        <h2 class="shelf-title" id="channelEditorTitle">Edit TV Channel <span class="badge" id="channelDraftCountBadge"></span></h2>
      </div>
      <p style="margin:0 0 12px; color:var(--muted); font-size:0.85rem;">Search any TV show or movie to add episodes to your channel, and reorder or remove picks:</p>
      <div class="row">
        <input type="text" id="channelSearchInput" placeholder="Search a show by name..." onkeydown="if(event.key==='Enter'){event.preventDefault();runChannelTitleSearch();}">
        <button type="button" class="secondary" onclick="runChannelTitleSearch()">Search</button>
      </div>
      <div id="channelSearchResult"></div>
      <div id="channelEpisodePicker"></div>

      <p style="margin-top:14px; margin-bottom:6px; font-weight:600; font-size:0.85rem;">Picks in this channel:</p>
      <div id="channelDraftList"><p style="color:var(--muted); font-size:0.85rem;"><small>Nothing added yet &mdash; search above to get started.</small></p></div>
      <div class="actions" style="margin-top:8px; justify-content:flex-start; gap:8px;">
        <button type="button" class="secondary lc-btn" onclick="shuffleChannelDraft()">Shuffle picks now</button>
        <button type="button" class="secondary lc-btn" style="color:var(--danger); border-color:rgba(255,59,48,0.25);" onclick="removeAllChannelDraftPicks()">Clear All</button>
      </div>
      <label style="display:flex; align-items:center; gap:8px; cursor:pointer; margin-top:8px;">
        <input type="checkbox" id="channelRandomizeCheck">
        <span style="font-size:0.85rem;">Randomize play order (reshuffles once a day)</span>
      </label>

      <div class="row" style="margin-top:10px;">
        <input type="text" id="channelNameInput" placeholder="Channel name (e.g. Comedy Night)" style="flex:1;">
        <button type="button" class="primary" id="channelSaveBtn" onclick="saveChannel()">Save</button>
        <button type="button" id="channelCancelEditBtn" class="secondary" style="display:none;" onclick="cancelEditChannel()">Cancel</button>
      </div>
    </div>
  </div>
</div>

<div class="tab-panel" data-tab-panel="search" hidden>
  <div class="panel">
    <div class="shelf-header" style="margin-bottom:10px;">
      <h2 class="shelf-title">Search Movies, TV Shows &amp; Lists</h2>
    </div>
    <p style="margin:0 0 12px; color:var(--muted); font-size:0.85rem;">Search to find movies, shows and lists to add to your lists.</p>
    
    <div class="row">
      <input type="text" id="catalogSearchInput" placeholder="Search by title or list name..." onkeydown="if(event.key==='Enter'){event.preventDefault();runCatalogSearch();}">
      <button type="button" class="primary" onclick="runCatalogSearch()">Search</button>
    </div>

    <div class="subnav-pills-bar" id="catalogSearchTypeChips" style="margin-top:10px;">
      <button type="button" class="subnav-pill active" onclick="setCatalogSearchFilter('movie', this)"><span class="check-icon">&#x2713;</span> Movies</button>
      <button type="button" class="subnav-pill" onclick="setCatalogSearchFilter('tv', this)">Shows</button>
      <button type="button" class="subnav-pill" onclick="setCatalogSearchFilter('lists', this)">Lists</button>
    </div>

    <div id="catalogSearchResult" style="margin-top:14px;"></div>
  </div>
</div>

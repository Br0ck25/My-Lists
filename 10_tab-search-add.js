<div class="tab-panel" data-tab-panel="catalogs" hidden>
  <!-- Top Submenu Pills for Catalogs -->
  <div class="subnav-pills-bar" id="catalogsFilterBar">
    <button type="button" class="subnav-pill active" onclick="switchCatalogsSubmenu('all', this)"><span class="check-icon">&#x2713;</span> Shelves</button>
    <button type="button" class="subnav-pill" onclick="switchCatalogsSubmenu('quickadd', this)">Quick Add</button>
    <button type="button" class="subnav-pill" onclick="switchCatalogsSubmenu('channels', this)">Channels</button>
    <button type="button" class="subnav-pill" onclick="switchCatalogsSubmenu('bulk', this)">Bulk Add</button>
  </div>

  <div class="lists-subpanel" id="catalogsSubShelves">
  <!-- Catalogs Management Card -->
  <div class="panel">
    <div class="shelf-header" style="margin-bottom:12px;">
      <h2 class="shelf-title">Live Preview &amp; Editor</h2>
      <div class="actions" style="flex-direction:row; flex-wrap:wrap; align-items:center; gap:6px;">
        <button type="button" class="secondary lc-btn" id="livePreviewEditBtn" onclick="toggleLivePreviewEdit()">Edit</button>
        <button type="button" class="secondary lc-btn" onclick="renderLivePreview()">Refresh Preview</button>
        <button type="button" class="secondary lc-btn" id="compactToggleBtn" onclick="toggleCompactView(this)">Compact</button>
        <button type="button" class="secondary lc-btn" id="testAllBtn" onclick="testAllSources()">Test all</button>
      </div>
    </div>

    <div class="row" style="margin-bottom:12px; gap:8px;">
      <input type="text" id="listFilterInput" placeholder="Filter shelves by name..." oninput="filterLists()">
      <select id="listGroupFilterSelect" onchange="filterLists()" style="flex:none; width:auto;">
        <option value="">All groups</option>
      </select>
    </div>

    <!-- Reorderable Catalog Shelves -->
    <div id="lists"></div>

    <!-- 24-Hour Randomizer Controls -->
    <div style="margin-top:16px; padding:14px 16px; background:var(--surface); border-radius:12px; border:1px solid var(--border);">
      <div style="font-weight:600; font-size:0.92rem; margin-bottom:10px; display:flex; align-items:center; gap:6px;">
        <span>Daily Randomizer</span>
      </div>
      <div style="display:flex; flex-direction:column; gap:8px;">
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:0.88rem; margin:0; user-select:none;">
          <input type="checkbox" id="shuffleShelvesCheckbox" onchange="saveState()" style="cursor:pointer; width:16px; height:16px;">
          <span>Shuffle Shelves daily (every 24h)</span>
        </label>
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:0.88rem; margin:0; user-select:none;">
          <input type="checkbox" id="shuffleItemsCheckbox" onchange="saveState()" style="cursor:pointer; width:16px; height:16px;">
          <span>Shuffle Items in Shelves daily (every 24h)</span>
        </label>
      </div>
    </div>

    <div class="actions" style="margin-top:16px;">
      <button type="button" onclick="removeAllLists()" class="secondary" style="color:var(--danger); border-color:rgba(255,59,48,0.25);">Remove all</button>
      <button type="button" class="primary" onclick="generate()">${isConfigureMode ? "Update Add-on" : "Generate Install Link"}</button>
    </div>
  </div>

  <!-- Undo Toast -->
  <div id="undoToast" class="undo-toast" style="display:none;">
    <span id="undoToastMsg"></span>
    <button type="button" class="secondary" onclick="performUndo()">Undo</button>
  </div>

  <!-- Generated Install Link Result Box -->
  <div id="result"></div>

    </div>
  
  <div class="lists-subpanel" id="catalogsSubBulk" style="display:none;">
  <div class="panel" style="margin-top:0;">
    <h2 class="panel-title">Bulk Import Lists</h2>
    <p style="margin:0 0 12px; color:var(--muted); font-size:0.85rem;">Paste multiple list URLs at once, one per line. Each list is automatically detected and added to your catalogs.</p>
    <textarea id="bulkPasteBox" rows="5" style="width:100%;font-family:monospace;font-size:15px;" placeholder="https://mdblist.com/lists/user/list-one&#10;https://trakt.tv/users/user/lists/list-two&#10;https://www.themoviedb.org/list/12345"></textarea>
    <div class="actions" style="margin-top:12px;">
      <button type="button" class="primary" onclick="bulkAddLists(this)">Add All Lines as Catalogs</button>
    </div>
  </div>
  </div>

  <div class="lists-subpanel" id="catalogsSubQuickAdd" style="display:none;">
    <div id="catalogsQuickAddContainer">

    <!-- Combined Charts Shelf -->
    <div class="shelf-section discover-shelf" data-shelf-type="all">
      <div class="shelf-header">
        <h2 class="shelf-title">Combined Charts</h2>
        <button type="button" class="qa-add-all-btn lc-btn primary" data-add-all-action="combined-charts">+ Add all</button>
      </div>
      ${combinedChartsHtml}
    </div>

    <!-- TMDB Charts Shelf -->
    <div class="shelf-section discover-shelf" data-shelf-type="all">
      <div class="shelf-header">
        <h2 class="shelf-title">TMDB Charts</h2>
        <button type="button" class="qa-add-all-btn lc-btn primary" data-add-all-action="tmdb-charts">+ Add all</button>
      </div>
      ${tmdbChartsHtml}
    </div>

    <!-- Trakt Official Charts Shelf -->
    <div class="shelf-section discover-shelf" data-shelf-type="all">
      <div class="shelf-header">
        <h2 class="shelf-title">Trakt Charts</h2>
        <button type="button" class="qa-add-all-btn lc-btn primary" data-add-all-action="trakt-charts">+ Add all</button>
      </div>
      ${traktChartsHtml}
    </div>

    <!-- MDBList Official Charts Shelf -->
    <div class="shelf-section discover-shelf" data-shelf-type="all">
      <div class="shelf-header">
        <h2 class="shelf-title">MDBList Official</h2>
        <button type="button" class="qa-add-all-btn lc-btn primary" data-add-all-action="mdblist-charts">+ Add all</button>
      </div>
      ${mdblistChartsHtml}
    </div>

    <!-- Simkl Charts Shelf -->
    <div class="shelf-section discover-shelf" data-shelf-type="all">
      <div class="shelf-header">
        <h2 class="shelf-title">Simkl Anime &amp; Trending</h2>
        <button type="button" class="qa-add-all-btn lc-btn primary" data-add-all-action="simkl-charts">+ Add all</button>
      </div>
      ${simklChartsHtml}
    </div>

    <!-- Streaming Top 10 Shelf -->
    <div class="shelf-section discover-shelf" data-shelf-type="all">
      <div class="shelf-header">
        <h2 class="shelf-title">Streaming Top 10</h2>
        <button type="button" class="qa-add-all-btn lc-btn primary" data-add-all-action="streaming-top10">+ Add all</button>
      </div>
      ${streamingTop10Html}
    </div>

    <!-- Streaming Catalogs Shelf -->
    <div class="shelf-section discover-shelf" data-shelf-type="all">
      <div class="shelf-header">
        <h2 class="shelf-title">Streaming Catalogs</h2>
        <button type="button" class="qa-add-all-btn lc-btn primary" data-add-all-action="streaming-catalogs">+ Add all</button>
      </div>
      ${streamingHtml}
    </div>
  </div>
  </div>

  <div class="lists-subpanel" id="catalogsSubChannels" style="display:none;">
    <div class="panel">
      <div class="shelf-header" style="margin-bottom:10px;">
        <h2 class="shelf-title">TV Channel Creator <span class="badge" id="channelDraftCountBadge"></span></h2>
      </div>
      <p style="margin:0 0 12px; color:var(--muted); font-size:0.85rem;">Turn any show into a 24/7 style continuous episode stream channel catalog item.</p>

      <div style="margin-bottom:20px; padding-bottom:16px; border-bottom:1px solid var(--border);">
        <p style="margin:0 0 8px; font-weight:700; font-size:0.88rem;">My Created Channels:</p>
        <div id="myCreatedChannelsList"><p style="color:var(--muted); font-size:0.85rem;"><small>No created channels yet.</small></p></div>
      </div>

    <div style="margin-bottom:16px;">
      <p style="margin:0 0 8px; font-weight:700; font-size:0.88rem;">Quick Add Popular TV Channels:</p>
      <div class="actions" style="flex-direction:row; flex-wrap:wrap; gap:6px;">
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="CBS Network" data-networkid="16">CBS</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="NBC Network" data-networkid="6">NBC</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="ABC Network" data-networkid="2">ABC</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="FOX Network" data-networkid="19">FOX</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="The CW" data-networkid="71">The CW</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="HBO Classics" data-networkid="49">HBO</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="Disney Channel" data-networkid="54">Disney Channel</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="Nickelodeon" data-networkid="13">Nickelodeon</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="Comedy Central" data-networkid="47">Comedy Central</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="USA Network" data-networkid="30">USA Network</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="Adult Swim" data-networkid="80">Adult Swim</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="Cartoon Network" data-networkid="56">Cartoon Network</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="FX Hits" data-networkid="88">FX</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="AMC Series" data-networkid="174">AMC</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="Syfy" data-networkid="149">Syfy</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="MTV" data-networkid="33">MTV</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="Discovery" data-networkid="64">Discovery Channel</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="History Channel" data-networkid="65">History</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="A&amp;E" data-networkid="129">A&amp;E</button>
        <button type="button" class="secondary lc-btn channelQuickAddBtn" data-name="BBC One" data-networkid="4">BBC One</button>
      </div>
      <div id="channelQuickAddStatus" style="margin-top:6px;"></div>
    </div>

    <div style="margin-top:14px; border-top:1px solid var(--border); padding-top:14px;">
      <p style="margin:0 0 6px; font-weight:700; font-size:0.88rem;">Search and Build Channel Episodes:</p>
      <div class="row">
        <input type="text" id="channelSearchInput" placeholder="Search a show by name" onkeydown="if(event.key==='Enter'){event.preventDefault();runChannelTitleSearch();}">
        <button type="button" class="secondary" onclick="runChannelTitleSearch()">Search</button>
      </div>
      <div id="channelSearchResult"></div>
      <div id="channelEpisodePicker"></div>

      <div id="channelDraftPicksDetails" style="margin-top:12px;">
        <p style="margin:0 0 6px; font-weight:600; font-size:0.85rem;">Channel Picks <span class="badge" id="channelDraftPicksCountBadge"></span>:</p>
        <div id="channelDraftList"><p style="color:var(--muted); font-size:0.85rem;"><small>Nothing added yet &mdash; search above to get started.</small></p></div>
        <div class="actions" style="margin-top:8px;">
          <button type="button" class="secondary lc-btn" onclick="shuffleChannelDraft()">Shuffle picks</button>
          <button type="button" class="secondary lc-btn" onclick="removeAllChannelDraftPicks()">Remove all</button>
        </div>
      </div>

      <div class="row" style="margin-top:8px; align-items:center;">
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
          <input type="checkbox" id="channelRandomizeCheck">
          <span style="font-size:0.85rem;">Randomize play order (daily reshuffle)</span>
        </label>
      </div>
      <div class="row" style="margin-top:8px;">
        <input type="text" id="channelNameInput" placeholder="Channel name (e.g. Cartoon Central)">
        <button type="button" class="primary" id="channelSaveBtn" onclick="saveChannel()">Save as Channel</button>
        <button type="button" id="channelCancelEditBtn" class="secondary" style="display:none;" onclick="cancelEditChannel()">Cancel edit</button>
      </div>
    </div>

    <div style="margin-top:18px; border-top:1px solid var(--border); padding-top:14px;">
      <p style="margin:0 0 8px; font-weight:700; font-size:0.88rem;">Import Channel from a Link:</p>
      <p style="margin:0 0 10px; color:var(--muted); font-size:0.85rem;">Paste any show list URL (MDBList or Trakt) to automatically generate a TV channel shelf.</p>
      <div class="row">
        <input type="text" id="channelImportUrlInput" placeholder="Show list URL (mdblist.com or trakt.tv)">
      </div>
      <div class="row" style="margin-top:8px;">
        <input type="text" id="channelImportNameInput" placeholder="Channel name (e.g. Sitcom Central)">
        <button type="button" class="secondary" onclick="importChannelFromLink(this)">Import channel</button>
      </div>
    </div>

    <div style="margin-top:18px; border-top:1px solid var(--border); padding-top:14px;">
      <p style="margin:0 0 6px; font-weight:700; font-size:0.88rem;">Merge Saved Channels into One Shelf:</p>
      <div class="actions" style="margin-bottom:8px;">
        <button type="button" class="secondary lc-btn" onclick="renderChannelMergeList()">Refresh list</button>
        <label style="display:flex; align-items:center; gap:6px; cursor:pointer; font-size:0.85rem;">
          <input type="checkbox" id="channelMergeSelectAllCheck" onchange="toggleAllChannelMergeChecks(this)">
          <span>Select all</span>
        </label>
      </div>
      <div id="channelMergeList"><p style="color:var(--muted); font-size:0.85rem;"><small>No saved channels yet.</small></p></div>
      <div class="row" style="margin-top:8px;">
        <input type="text" id="channelMergeNameInput" placeholder="Combined shelf name (e.g. Live TV)">
        <button type="button" class="secondary" onclick="mergeChannelsIntoRow()">Merge into shelf</button>
      </div>
    </div>
  </div>
  </div>
</div>


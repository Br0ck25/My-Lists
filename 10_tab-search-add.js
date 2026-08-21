<div class="tab-panel" data-tab-panel="catalogs" hidden>
  <!-- Top Submenu Pills for Catalogs -->
  <div class="subnav-pills-bar" id="catalogsFilterBar">
    <button type="button" class="subnav-pill active" onclick="switchCatalogsSubmenu('all', this)"><span class="check-icon">&#x2713;</span> My Catalogs</button>
    <button type="button" class="subnav-pill" onclick="switchCatalogsSubmenu('quickadd', this)">Quick Add</button>
    <button type="button" class="subnav-pill" onclick="switchCatalogsSubmenu('bulk', this)">Bulk Add</button>
  </div>

  <div class="lists-subpanel" id="catalogsSubShelves">
  <!-- Catalogs Management Card -->
  <div class="panel">
    <div class="shelf-header" style="margin-bottom:12px;">
      <h2 class="shelf-title">Live Preview &amp; Editor</h2>
      <div class="actions" style="flex-direction:row; flex-wrap:wrap; align-items:center; gap:6px;">
        <button type="button" class="primary lc-btn" onclick="openAddShelfModal()">+ Catalog</button>
        <button type="button" class="secondary lc-btn" id="livePreviewEditBtn" onclick="toggleLivePreviewEdit()">Edit</button>
        <button type="button" class="secondary lc-btn" onclick="renderLivePreview()">Refresh Preview</button>
      </div>
    </div>

    <div class="row" style="margin-bottom:12px; gap:8px;">
      <input type="text" id="listFilterInput" placeholder="Filter catalogs by name..." oninput="filterLists()">
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
          <span>Shuffle Catalogs daily (every 24h)</span>
        </label>
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:0.88rem; margin:0; user-select:none;">
          <input type="checkbox" id="shuffleItemsCheckbox" onchange="saveState()" style="cursor:pointer; width:16px; height:16px;">
          <span>Shuffle items in Catalogs daily (every 24h)</span>
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

    <!-- Kids Shelf -->
    <div class="shelf-section discover-shelf" data-shelf-type="all">
      <div class="shelf-header">
        <h2 class="shelf-title">Kids</h2>
        <button type="button" class="qa-add-all-btn lc-btn primary" data-add-all-action="kids">+ Add all</button>
      </div>
      ${kidsHtml}
    </div>

    <!-- Holidays Shelf -->
    <div class="shelf-section discover-shelf" data-shelf-type="all">
      <div class="shelf-header">
        <h2 class="shelf-title">Holidays</h2>
        <button type="button" class="qa-add-all-btn lc-btn primary" data-add-all-action="holidays">+ Add all</button>
      </div>
      ${holidaysHtml}
    </div>
  </div>
  </div>
</div>


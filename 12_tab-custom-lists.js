<div class="tab-panel" data-tab-panel="lists" hidden>
  <!-- Top Submenu Pills for Lists -->
  <div class="subnav-pills-bar" id="listsSubnavBar">
    <button type="button" class="subnav-pill active" onclick="switchListsSubmenu('my-lists', this)"><span class="check-icon">&#x2713;</span> My Lists</button>
    <button type="button" class="subnav-pill" onclick="switchListsSubmenu('liked', this)">Liked</button>
    <button type="button" class="subnav-pill" onclick="switchListsSubmenu('popular', this)">Popular</button>
    <button type="button" class="subnav-pill" onclick="switchListsSubmenu('curated', this)">Curated</button>
    <button type="button" class="subnav-pill" onclick="switchListsSubmenu('list-search', this)">Find Lists</button>
    <button type="button" class="subnav-pill" onclick="switchListsSubmenu('import', this)">Import</button>
  </div>

  <!-- Submenu 1: User's Connected Account & Custom Lists -->
  <div class="lists-subpanel" id="listsSubMyLists">
    <div class="panel">
      <div class="shelf-header" style="margin-bottom:10px;">
        <h2 class="shelf-title">Your Custom Lists</h2>
        <button type="button" class="secondary lc-btn" onclick="renderCreatorDashboard()">Refresh</button>
      </div>
      <p style="margin:0 0 10px; color:var(--muted); font-size:0.85rem;">Custom lists you've created locally or on your profile.</p>
      <div id="creatorDashboard"></div>
    </div>

    <div class="panel" style="margin-top:12px;">
      <h2 class="panel-title">Your MDBList Lists</h2>
      <p style="margin:0 0 10px; color:var(--muted); font-size:0.85rem;">Lists belonging to your MDBList API key configured in Settings.</p>
      <div id="myMdblistListsResult"></div>
    </div>

    <div class="panel" style="margin-top:12px;">
      <div class="shelf-header" style="margin-bottom:10px;">
        <h2 class="panel-title" style="margin-bottom:0;">Your Trakt Lists</h2>
        <button type="button" class="secondary lc-btn" id="listsTraktConnectBtn" onclick="toggleListsTraktConnection()">Connect Trakt</button>
      </div>
      <p style="margin:0 0 10px; color:var(--muted); font-size:0.85rem;">Public and personal lists from your Trakt username/account.</p>
      <div id="myTraktListsResult"></div>
      <div id="myPrivateTraktListsResult" style="margin-top:10px;"></div>
    </div>
  </div>

  <!-- Submenu 2: Liked Lists Feed -->
  <div class="lists-subpanel" id="listsSubLiked" style="display:none;">
    <div class="shelf-header" style="margin-bottom:10px;">
      <h2 class="shelf-title">Lists You Liked</h2>
      <button type="button" class="secondary lc-btn" onclick="renderLikedListsFeed()">Refresh</button>
    </div>
    <div id="likedListsFeed"><p style="color:var(--muted); font-size:0.88rem;">No liked lists yet. Tap the heart &#x2661; on any list to save it here.</p></div>
  </div>

  <!-- Submenu 3: Popular Lists Feed -->
  <div class="lists-subpanel" id="listsSubPopular" style="display:none;">
    <div class="shelf-header" style="margin-bottom:10px;">
      <h2 class="shelf-title">Popular Community Lists</h2>
      <button type="button" class="secondary lc-btn" onclick="loadPopularListsFeed()">Refresh</button>
    </div>
    <div id="popularListsFeed"></div>
  </div>

  <!-- Submenu 4: Curated Lists Feed -->
  <div class="lists-subpanel" id="listsSubCurated" style="display:none;">
    <div class="shelf-header" style="margin-bottom:10px;">
      <h2 class="shelf-title">Curated &amp; Official Lists</h2>
    </div>
    <div id="curatedListsFeed"></div>
  </div>

  <!-- Submenu 5: Create Custom List Builder -->
  <div class="lists-subpanel" id="listsSubCreateList" style="display:none;">
    <div class="panel">
      <div class="shelf-header" style="margin-bottom:10px;">
        <h2 class="shelf-title" id="customListEditorTitle">Create a Custom List <span class="badge" id="customListDraftCountBadge"></span></h2>
      </div>
      <p style="margin:0 0 12px; color:var(--muted); font-size:0.85rem;">Build a hand-picked list of movies or shows by searching and adding them one at a time. After saving, your list will appear under <strong>My Lists</strong>.</p>

      <div class="row">
        <input type="text" id="customListSearchInput" placeholder="Search a movie or show by name" onkeydown="if(event.key==='Enter'){event.preventDefault();runCustomListSearch();}">
        <select id="customListSearchType" style="flex:none; width:auto;">
          <option value="movie">&#x1F3AC; Movies</option>
          <option value="tv">&#x1F4FA; Shows</option>
        </select>
        <button type="button" class="secondary" onclick="runCustomListSearch()">Search</button>
      </div>
      <div id="customListSearchResult"></div>

      <p style="margin-top:14px; margin-bottom:6px; font-weight:600; font-size:0.85rem;">Picks so far (in play order):</p>
      <div id="customListDraftList"><p style="color:var(--muted); font-size:0.85rem;"><small>Nothing added yet &mdash; search above to get started.</small></p></div>
      <div class="actions" style="margin-top:8px;">
        <button type="button" class="secondary lc-btn" onclick="shuffleCustomListDraft()">Shuffle picks now</button>
      </div>
      <label style="display:flex; align-items:center; gap:8px; cursor:pointer; margin-top:8px;">
        <input type="checkbox" id="customListRandomizeCheck">
        <span style="font-size:0.85rem;">Randomize order (reshuffles once a day)</span>
      </label>

      <div class="row" id="customListVisibilityRow" style="display:none; margin-top:8px; align-items:center; gap:8px;">
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
          <span style="font-size:0.85rem;">Visibility:</span>
          <select id="customListVisibilitySelect" style="flex:none; width:auto;">
            <option value="public">Public</option>
            <option value="private">Private</option>
          </select>
        </label>
      </div>
      <div id="customListTypeToggles" style="margin-top:8px; display:flex; gap:16px;">
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
          <input type="radio" name="customListTypeRadio" value="movie" onchange="setCustomListDraftTypeToggle('movie')" checked>
          <span style="font-size:0.85rem;">Movies</span>
        </label>
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
          <input type="radio" name="customListTypeRadio" value="series" onchange="setCustomListDraftTypeToggle('series')">
          <span style="font-size:0.85rem;">Shows</span>
        </label>
      </div>
      <div class="row" style="margin-top:10px;">
        <input type="text" id="customListNameInput" placeholder="List name (e.g. My Favorites)">
        <button type="button" class="primary" id="customListSaveBtn" onclick="saveCustomList()">Save List</button>
        <button type="button" id="customListCancelEditBtn" class="secondary" style="display:none;" onclick="cancelEditCustomList()">Cancel edit</button>
      </div>
    </div>
  </div>

  <!-- Submenu 7: Import from a Link -->
  <div class="lists-subpanel" id="listsSubImport" style="display:none;">
    <div class="panel">
      <div class="shelf-header" style="margin-bottom:10px;">
        <h2 class="shelf-title">Import from a link</h2>
      </div>
      <p style="margin:0 0 12px; color:var(--muted); font-size:0.85rem;">Paste any MDBList, Trakt, or TMDB list URL to import directly as a Custom List.</p>
      <div class="row">
        <input type="text" id="customListImportUrlInput" placeholder="mdblist.com, trakt.tv, or themoviedb.org list URL">
      </div>
      <div class="row" style="margin-top:8px;">
        <input type="text" id="customListImportNameInput" placeholder="Name (e.g. My Favorites)">
        <button type="button" class="secondary" id="customListImportBtn" onclick="importCustomListFromLink(this)">Import from link</button>
      </div>
    </div>
  </div>



  <!-- Submenu 6: Find Lists -->
<div class="lists-subpanel" id="listsSubListSearch" style="display:none;">

  <div class="panel">
    <div class="shelf-header" style="margin-bottom:10px;">
      <h2 class="shelf-title">Search Public Lists &amp; Catalogs</h2>
    </div>
    <p style="margin:0 0 12px; color:var(--muted); font-size:0.85rem;">Search across hundreds of public MDBList, Trakt, and community lists to add to your catalogs.</p>
    
    <div class="row">
      <input type="text" id="listSearchInput" placeholder="Search lists by title or keyword..." onkeydown="if(event.key==='Enter'){event.preventDefault();runListSearch();}">
      <button type="button" class="primary" onclick="runListSearch()">Search</button>
    </div>

    <div class="subnav-pills-bar" id="listSearchTypeChips" style="margin-top:10px;">
      <button type="button" class="subnav-pill active" onclick="setListSearchFilter('all', this)"><span class="check-icon">&#x2713;</span> All</button>
      <button type="button" class="subnav-pill" onclick="setListSearchFilter('movie', this)">Movies</button>
      <button type="button" class="subnav-pill" onclick="setListSearchFilter('series', this)">Shows</button>
    </div>

    <div id="listSearchResult" style="margin-top:14px;"></div>
  </div>
</div>
</div>
<div class="tab-panel" data-tab-panel="lists" hidden>
  <!-- Top Submenu Pills for Lists -->
  <div class="subnav-pills-bar" id="listsSubnavBar">
    <button type="button" class="subnav-pill active" onclick="switchListsSubmenu('my-lists', this)"><span class="check-icon">&#x2713;</span> My Lists</button>
    <button type="button" class="subnav-pill" onclick="switchListsSubmenu('liked', this)">Liked</button>
    <button type="button" class="subnav-pill" onclick="switchListsSubmenu('import', this)">Import</button>
  </div>

  <!-- Submenu 1: User's Connected Account & Custom Lists -->
  <div class="lists-subpanel" id="listsSubMyLists">
    <div class="panel">
      <div class="shelf-header" style="margin-bottom:10px;">
        <h2 class="shelf-title">Your Custom Lists</h2>
        <div style="display:flex; gap:8px;">
          <button type="button" class="primary lc-btn" onclick="openCreateListModal('custom')">+ New List</button>
          <button type="button" class="secondary lc-btn" onclick="renderCreatorDashboard()">Refresh</button>
        </div>
      </div>
      <p style="margin:0 0 10px; color:var(--muted); font-size:0.85rem;">Custom lists you've created locally or on your profile.</p>
      <div id="creatorDashboard"></div>
    </div>

    <div class="panel" style="margin-top:12px;">
      <div class="shelf-header" style="margin-bottom:10px;">
        <h2 class="panel-title" style="margin-bottom:0;">Your MDBList Lists</h2>
        <div style="display:flex; gap:8px;">
          <button type="button" class="primary lc-btn" onclick="openCreateListModal('mdblist')">+ New List</button>
          <button type="button" class="secondary lc-btn" id="listsMdblistConnectBtn" onclick="toggleListsMdblistConnection()">Connect MDBList</button>
        </div>
      </div>
      <p style="margin:0 0 10px; color:var(--muted); font-size:0.85rem;">Lists, Watchlist, and Watch History from your connected MDBList account.</p>
      <div id="myMdblistListsResult"></div>
    </div>

    <div class="panel" style="margin-top:12px;">
      <div class="shelf-header" style="margin-bottom:10px;">
        <h2 class="panel-title" style="margin-bottom:0;">Your Trakt Lists</h2>
        <div style="display:flex; gap:8px;">
          <button type="button" class="primary lc-btn" onclick="openCreateListModal('trakt')">+ New List</button>
          <button type="button" class="secondary lc-btn" id="listsTraktConnectBtn" onclick="toggleListsTraktConnection()">Connect Trakt</button>
        </div>
      </div>
      <p style="margin:0 0 10px; color:var(--muted); font-size:0.85rem;">Lists, Watchlist, and Watch History from your connected Trakt account.</p>
      <div id="myTraktListsResult"></div>
      <div id="myPrivateTraktListsResult" style="margin-top:10px;"></div>
    </div>

    <div class="panel" style="margin-top:12px;">
      <div class="shelf-header" style="margin-bottom:10px;">
        <h2 class="panel-title" style="margin-bottom:0;">Your TMDB Lists</h2>
        <div style="display:flex; gap:8px;">
          <button type="button" class="primary lc-btn" onclick="openCreateListModal('tmdb')">+ New List</button>
          <button type="button" class="secondary lc-btn" id="listsTmdbConnectBtn" onclick="toggleListsTmdbConnection()">Connect TMDB</button>
        </div>
      </div>
      <p style="margin:0 0 10px; color:var(--muted); font-size:0.85rem;">Lists, Watchlist, and Favorites from your connected TMDB account.</p>
      <div id="myTmdbListsResult"></div>
    </div>

    <div class="panel" style="margin-top:12px;">
      <div class="shelf-header" style="margin-bottom:10px;">
        <h2 class="panel-title" style="margin-bottom:0;">Your Simkl Lists</h2>
        <div style="display:flex; gap:8px;">
          <button type="button" class="primary lc-btn" onclick="openCreateListModal('simkl')">+ New List</button>
          <button type="button" class="secondary lc-btn" id="listsSimklConnectBtn" onclick="toggleListsSimklConnection()">Connect Simkl</button>
        </div>
      </div>
      <p style="margin:0 0 10px; color:var(--muted); font-size:0.85rem;">Lists, Watchlist, and Watch History from your connected Simkl account.</p>
      <div id="mySimklListsResult"></div>
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

  <!-- Submenu 5: Create Custom List Builder -->
  <div class="lists-subpanel" id="listsSubCreateList" style="display:none;">
    <div class="panel">
      <div class="shelf-header" style="margin-bottom:10px;">
        <h2 class="shelf-title" id="customListEditorTitle">Create a Custom List</h2>
      </div>
      <p style="margin:0 0 12px; color:var(--muted); font-size:0.85rem;">Manage items and settings for this custom list. You can reorder items by dragging or typing a position number, remove items with the &times; button, or add new items from Search, Discover, or Charts.</p>

      <p style="margin-top:14px; margin-bottom:6px; font-weight:600; font-size:0.85rem;">Picks in this list:</p>
      <div id="customListDraftList"><p style="color:var(--muted); font-size:0.85rem;"><small>No items in this list yet &mdash; tap + on any movie or show across Discover, Search, or Charts to add it.</small></p></div>
      <div class="actions" style="margin-top:8px; justify-content:flex-start; gap:8px;">
        <button type="button" class="secondary lc-btn" onclick="shuffleCustomListDraft()">Shuffle picks now</button>
        <button type="button" class="secondary lc-btn" style="color:var(--danger); border-color:rgba(255,59,48,0.25);" onclick="removeAllCustomListDraftPicks()">Remove all</button>
      </div>
      <label style="display:flex; align-items:center; gap:8px; cursor:pointer; margin-top:8px;">
        <input type="checkbox" id="customListRandomizeCheck">
        <span style="font-size:0.85rem;">Randomize order (reshuffles once a day)</span>
      </label>

      <div class="row" id="customListVisibilityRow" style="margin-top:8px; align-items:center; gap:8px;">
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
          <span style="font-size:0.85rem;">Visibility:</span>
          <select id="customListVisibilitySelect" style="flex:none; width:auto;">
            <option value="public">Public</option>
            <option value="private">Private</option>
          </select>
        </label>
      </div>
      <div id="customListTypeToggles" style="margin-top:8px; display:flex; gap:16px; flex-wrap:wrap;">
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
          <input type="radio" name="customListTypeRadio" value="movie" onchange="setCustomListDraftTypeToggle('movie')" checked>
          <span style="font-size:0.85rem;">Movies</span>
        </label>
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
          <input type="radio" name="customListTypeRadio" value="series" onchange="setCustomListDraftTypeToggle('series')">
          <span style="font-size:0.85rem;">Shows</span>
        </label>
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
          <input type="radio" name="customListTypeRadio" value="mixed" onchange="setCustomListDraftTypeToggle('mixed')">
          <span style="font-size:0.85rem;">Mixed (Movies &amp; Shows)</span>
        </label>
      </div>
      <div class="row" style="margin-top:10px;">
        <input type="text" id="customListNameInput" placeholder="List name (e.g. My Favorites)">
        <button type="button" class="primary" id="customListSaveBtn" onclick="saveCustomList()">Save</button>
        <button type="button" id="customListCancelEditBtn" class="secondary" style="display:none;" onclick="cancelEditCustomList()">Cancel</button>
      </div>
    </div>
  </div>

  <!-- Submenu 7: Import list from a Link -->
  <div class="lists-subpanel" id="listsSubImport" style="display:none;">
    <div class="panel">
      <div class="shelf-header" style="margin-bottom:10px;">
        <h2 class="shelf-title">Import list from a link</h2>
      </div>
      <p style="margin:0 0 12px; color:var(--muted); font-size:0.85rem;">Paste any MDBList, Trakt, or TMDB list URL to import directly as a Custom List.</p>
      <div class="row">
        <input type="text" id="customListImportUrlInput" placeholder="mdblist.com, trakt.tv, or themoviedb.org list URL">
      </div>
      <div class="row" style="margin-top:8px;">
        <input type="text" id="customListImportNameInput" placeholder="Name (e.g. My Favorites)">
        <button type="button" class="secondary" id="customListImportBtn" onclick="importCustomListFromLink(this)">Import list</button>
      </div>
      <label style="display:flex; align-items:center; gap:8px; cursor:pointer; margin-top:10px;">
        <input type="checkbox" id="customListImportSyncCheck" checked>
        <span style="font-size:0.85rem;">Keep custom list synced with external link</span>
      </label>
    </div>
  </div>



</div>

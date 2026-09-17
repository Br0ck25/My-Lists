<div class="tab-panel" data-tab-panel="catalogs" id="content-catalogs" role="tabpanel" aria-labelledby="tab-desktop-catalogs" hidden>
  <!-- Top Submenu Pills for Catalogs -->
  <div class="subnav-pills-bar" id="catalogsFilterBar">
    <button type="button" class="subnav-pill active" data-sub="all" onclick="switchCatalogsSubmenu('all', this)"><span class="check-icon">&#x2713;</span> My Catalogs</button>
    <button type="button" class="subnav-pill" data-sub="quickadd" onclick="switchCatalogsSubmenu('quickadd', this)">Quick Add</button>
    <button type="button" class="subnav-pill" data-sub="bulk" onclick="switchCatalogsSubmenu('bulk', this)">Bulk Add</button>
  </div>

  <div class="lists-subpanel" id="catalogsSubShelves">
  <!-- Catalogs Management Card -->
  <div class="panel">
    <div class="shelf-header" style="margin-bottom:12px;">
      <h2 class="shelf-title">Live Preview &amp; Editor</h2>
      <div class="actions" style="flex-direction:row; flex-wrap:wrap; align-items:center; gap:6px;">
        <button type="button" class="primary lc-btn" onclick="openAddShelfModal()">+ New Catalog</button>
        <button type="button" class="secondary lc-btn" id="livePreviewEditBtn" onclick="toggleLivePreviewEdit()">Edit</button>
        <button type="button" class="secondary lc-btn" onclick="renderLivePreview()">Refresh Preview</button>
      </div>
    </div>

    <div class="row" style="margin-bottom:12px; gap:8px;">
      <input type="text" id="listFilterInput" aria-label="Filter catalogs by name" placeholder="Filter catalogs by name..." oninput="filterLists()">
      <select id="listGroupFilterSelect" aria-label="Filter catalogs by group" onchange="filterLists()" style="flex:none; width:auto;">
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

    <!-- Quick List Wizard Panel -->
    <div class="panel" style="margin-bottom:14px;">
      <div class="shelf-header" style="margin-bottom:8px;">
        <h2 class="shelf-title">Quick List Wizard</h2>
      </div>
      <p style="margin:0 0 12px; color:var(--muted); font-size:0.85rem; line-height:1.45;">Pick a network or studio, an era and a mood to quickly build curated catalog lists &mdash; separate lists for movies and shows, not combined.</p>
      <div class="channel-wizard-grid">
        <label>Network or studio
          <select id="catalogWizardNetwork">
            <option value="">Any network or studio</option>
            <option value="49">HBO</option>
            <option value="88">FX</option>
            <option value="80">Adult Swim</option>
            <option value="13">Nickelodeon</option>
            <option value="56">Cartoon Network</option>
            <option value="54">Disney Channel / Disney</option>
            <option value="4">BBC One</option>
            <option value="67">Showtime</option>
            <option value="174">AMC</option>
            <option value="47">Comedy Central</option>
            <option value="213">Netflix</option>
            <option value="1024">Prime Video</option>
            <option value="2552">Apple TV+</option>
            <option value="2739">Disney+</option>
            <option value="19">FOX</option>
            <option value="6">NBC</option>
            <option value="16">CBS</option>
            <option value="2">ABC</option>
            <option value="71">The CW</option>
            <option value="149">Syfy</option>
            <option value="wb">Warner Bros. Pictures</option>
            <option value="universal">Universal Pictures</option>
            <option value="paramount">Paramount Pictures</option>
            <option value="sony">Sony Pictures</option>
            <option value="a24">A24</option>
            <option value="lionsgate">Lionsgate</option>
            <option value="mgm">MGM</option>
          </select>
        </label>
        <label>Era
          <select id="catalogWizardEra">
            <option value="">Any era</option>
            <option value="1970-1979">70s</option>
            <option value="1980-1989">80s</option>
            <option value="1990-1999">90s classics</option>
            <option value="2000-2009">2000s</option>
            <option value="2010-2014">Early 2010s</option>
            <option value="2015-2099">Modern (2015+)</option>
          </select>
        </label>
        <label>Genre or mood
          <select id="catalogWizardGenre">
            <option value="">Any genre</option>
            <option value="80,9648">Crime &amp; thrillers</option>
            <option value="16">Cartoons &amp; Animation</option>
            <option value="35">Chill comedy</option>
            <option value="18">Drama</option>
            <option value="10765">Sci-fi &amp; fantasy</option>
            <option value="10759">Action &amp; adventure</option>
            <option value="10751">Family</option>
            <option value="99">Documentary</option>
            <option value="10762">Kids</option>
            <option value="9648">Mystery</option>
            <option value="27">Horror</option>
            <option value="10749">Romance</option>
          </select>
        </label>
        <label>Titles in list
          <select id="catalogWizardSize">
            <option value="10">Top 10 titles</option>
            <option value="20" selected>Top 20 titles</option>
            <option value="30">Top 30 titles</option>
            <option value="50">Top 50 titles</option>
          </select>
        </label>
      </div>
      <div class="row" style="margin-top:8px; gap:8px; flex-wrap:wrap;">
        <input type="text" id="catalogWizardNameInput" placeholder="List name (left blank, we will name it for you)" style="flex:1; min-width:200px;">
        <div class="actions" style="gap:6px; flex-wrap:wrap;">
          <button type="button" class="primary lc-btn" onclick="runCatalogListWizard('movie', this)">+ Movie List</button>
          <button type="button" class="primary lc-btn" onclick="runCatalogListWizard('series', this)">+ Show List</button>
          <button type="button" class="secondary lc-btn" onclick="runCatalogListWizard('both', this)">+ Both (2 Lists)</button>
        </div>
      </div>
      <div id="catalogWizardStatus" style="margin-top:8px;"></div>
    </div>

    <!-- Combined Charts Shelf -->
    <div class="shelf-section discover-shelf panel qa-shelf-card" data-shelf-type="all">
      <div class="shelf-header" style="margin-bottom:8px;">
        <h2 class="shelf-title">Combined Charts</h2>
        <button type="button" class="qa-add-all-btn lc-btn primary" data-add-all-action="combined-charts">+ Add all</button>
      </div>
      <p class="qa-shelf-sub">One row that blends MDBList, TMDB, Trakt and Simkl together and de-duplicates the result, so a title that charts on several of them still appears once:</p>
      ${combinedChartsHtml}
    </div>

    <!-- TMDB Charts Shelf -->
    <div class="shelf-section discover-shelf panel qa-shelf-card" data-shelf-type="all">
      <div class="shelf-header" style="margin-bottom:8px;">
        <h2 class="shelf-title">TMDB Charts</h2>
        <button type="button" class="qa-add-all-btn lc-btn primary" data-add-all-action="tmdb-charts">+ Add all</button>
      </div>
      <p class="qa-shelf-sub">TheMovieDB's own charts &mdash; New Releases, Trending, Popular, Top Rated, Now Playing and Upcoming:</p>
      ${tmdbChartsHtml}
    </div>

    <!-- Trakt Official Charts Shelf -->
    <div class="shelf-section discover-shelf panel qa-shelf-card" data-shelf-type="all">
      <div class="shelf-header" style="margin-bottom:8px;">
        <h2 class="shelf-title">Trakt Charts</h2>
        <button type="button" class="qa-add-all-btn lc-btn primary" data-add-all-action="trakt-charts">+ Add all</button>
      </div>
      <p class="qa-shelf-sub">Trakt's community charts, straight from its API &mdash; what is trending and most played now, through to the weekly box office:</p>
      ${traktChartsHtml}
    </div>

    <!-- MDBList Official Charts Shelf -->
    <div class="shelf-section discover-shelf panel qa-shelf-card" data-shelf-type="all">
      <div class="shelf-header" style="margin-bottom:8px;">
        <h2 class="shelf-title">MDBList Official</h2>
        <button type="button" class="qa-add-all-btn lc-btn primary" data-add-all-action="mdblist-charts">+ Add all</button>
      </div>
      <p class="qa-shelf-sub">MDBList's official charts, including the JustWatch daily streaming rankings and IMDb's MovieMeter:</p>
      ${mdblistChartsHtml}
    </div>

    <!-- Simkl Charts Shelf -->
    <div class="shelf-section discover-shelf panel qa-shelf-card" data-shelf-type="all">
      <div class="shelf-header" style="margin-bottom:8px;">
        <h2 class="shelf-title">Simkl Anime &amp; Trending</h2>
        <button type="button" class="qa-add-all-btn lc-btn primary" data-add-all-action="simkl-charts">+ Add all</button>
      </div>
      <p class="qa-shelf-sub">Simkl's daily, weekly and monthly trending windows, plus its anime chart:</p>
      ${simklChartsHtml}
    </div>

    <!-- Streaming Top 10 Shelf -->
    <div class="shelf-section discover-shelf panel qa-shelf-card" data-shelf-type="all">
      <div class="shelf-header" style="margin-bottom:8px;">
        <h2 class="shelf-title">Streaming Top 10</h2>
        <button type="button" class="qa-add-all-btn lc-btn primary" data-add-all-action="streaming-top10">+ Add all</button>
      </div>
      <p class="qa-shelf-sub">What is in each service's current Top 10, as one catalog row per service:</p>
      ${streamingTop10Html}
    </div>

    <!-- Streaming Catalogs Shelf -->
    <div class="shelf-section discover-shelf panel qa-shelf-card" data-shelf-type="all">
      <div class="shelf-header" style="margin-bottom:8px;">
        <h2 class="shelf-title">Streaming Catalogs</h2>
        <button type="button" class="qa-add-all-btn lc-btn primary" data-add-all-action="streaming-catalogs">+ Add all</button>
      </div>
      <p class="qa-shelf-sub">The full catalog of each of the ten streaming services, browsable as its own row:</p>
      ${streamingHtml}
    </div>

    <!-- New on Streaming Shelf -- renders as an empty string, card and all,
         until NEW_ON_STREAMING_IN_QUICK_ADD is turned on (00_constants.js). -->
    ${newOnStreamingQuickAddCard}

    <!-- Kids Shelf -->
    <div class="shelf-section discover-shelf panel qa-shelf-card" data-shelf-type="all">
      <div class="shelf-header" style="margin-bottom:8px;">
        <h2 class="shelf-title">Kids</h2>
        <button type="button" class="qa-add-all-btn lc-btn primary" data-add-all-action="kids">+ Add all</button>
      </div>
      <p class="qa-shelf-sub">Filtered by certification rather than by genre, so nothing above the rating you pick can appear:</p>
      ${kidsHtml}
    </div>

    <!-- Holidays Shelf -->
    <div class="shelf-section discover-shelf panel qa-shelf-card" data-shelf-type="all">
      <div class="shelf-header" style="margin-bottom:8px;">
        <h2 class="shelf-title">Holidays</h2>
        <button type="button" class="qa-add-all-btn lc-btn primary" data-add-all-action="holidays">+ Add all</button>
      </div>
      <p class="qa-shelf-sub">Seasonal rows for Christmas, Halloween, Thanksgiving and the rest of the calendar:</p>
      ${holidaysHtml}
    </div>

    <!-- Genres Shelf -->
    <div class="shelf-section discover-shelf panel qa-shelf-card" data-shelf-type="all">
      <div class="shelf-header" style="margin-bottom:8px;">
        <h2 class="shelf-title">Genres</h2>
        <button type="button" class="qa-add-all-btn lc-btn primary" data-add-all-action="genres">+ Add all</button>
      </div>
      <p class="qa-shelf-sub">One row per genre, from Family and Fantasy through to War and Western:</p>
      ${genresHtml}
    </div>
  </div>
  </div>
</div>


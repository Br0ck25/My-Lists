<div class="tab-panel" data-tab-panel="discover">
  <!-- Discover Top Submenu Pills -->
  <div class="subnav-pills-bar" id="discoverSubnavBar">
    <button type="button" class="subnav-pill active" data-sub="all" onclick="filterDiscoverShelves('all', this)"><span class="check-icon">&#x2713;</span> All</button>
    <button type="button" class="subnav-pill" data-sub="movie" onclick="filterDiscoverShelves('movie', this)">Movies</button>
    <button type="button" class="subnav-pill" data-sub="series" onclick="filterDiscoverShelves('series', this)">Shows</button>
    <button type="button" class="subnav-pill" data-sub="popular" onclick="filterDiscoverShelves('popular', this)">Popular Lists</button>
    <button type="button" class="subnav-pill" data-sub="curated" onclick="filterDiscoverShelves('curated', this)">Curated</button>
    <button type="button" class="subnav-pill" data-sub="gems" onclick="filterDiscoverShelves('gems', this)">Hidden Gems</button>
    <button type="button" class="subnav-pill" data-sub="kids" onclick="filterDiscoverShelves('kids', this)">Kids</button>
    <button type="button" class="subnav-pill" data-sub="holidays" onclick="filterDiscoverShelves('holidays', this)">Holidays</button>
    <button type="button" class="subnav-pill" data-sub="genres" onclick="filterDiscoverShelves('genres', this)">Genres</button>
  </div>

  <!-- Discover Shelves Feed -->
  <div id="discoverShelvesContainer">
    <!-- Combined Charts Shelf -->
    ${combinedChartsHtml}

    <!-- TMDB Charts Shelf -->
    ${tmdbChartsHtml}

    <!-- Trakt Official Charts Shelf -->
    ${traktChartsHtml}

    <!-- MDBList Official Charts Shelf -->
    ${mdblistChartsHtml}

    <!-- Simkl Charts Shelf -->
    ${simklChartsHtml}

    <!-- Streaming Top 10 Shelf -->
    ${streamingTop10Html}

    <!-- Streaming Catalogs Shelf -->
    ${streamingHtml}

    <!-- Hidden Gems Shelf -->
    ${hiddenGemsHtml}

    <!-- Kids Shelf -->
    ${kidsHtml}

    <!-- Holidays Shelf -->
    ${holidaysHtml}

    <!-- Genres Shelf -->
    ${genresHtml}
  </div>

  <!-- Discover Lists Feed (Movies / Shows list view matching search) -->
  <div id="discoverListsFeed" style="display:none;"></div>

  <!-- Popular Lists Feed in Discover -->
  <div class="discover-subpanel" id="discoverSubPopular" style="display:none;">
    <div class="shelf-header" style="margin-bottom:10px;">
      <h2 class="shelf-title">Popular Community Lists</h2>
      <button type="button" class="secondary lc-btn" onclick="loadPopularListsFeed(true)">Refresh</button>
    </div>
    <div id="popularListsFeed"></div>
  </div>

  <!-- Curated Lists Feed in Discover -->
  <div class="discover-subpanel" id="discoverSubCurated" style="display:none;">
    <div class="shelf-header" style="margin-bottom:10px;">
      <h2 class="shelf-title">Curated For You</h2>
      <button type="button" class="secondary lc-btn" onclick="loadCuratedListsFeed(true)">Refresh</button>
    </div>
    <p style="margin:0 0 12px; color:var(--muted); font-size:0.85rem;">Personalized recommendations and curated lists tailored to your watch history and tastes.</p>
    <div id="curatedListsFeed"></div>
  </div>
</div>

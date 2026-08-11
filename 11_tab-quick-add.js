<div class="tab-panel" data-tab-panel="discover">
  <!-- Discover Top Submenu Pills -->
  <div class="subnav-pills-bar" id="discoverSubnavBar">
    <button type="button" class="subnav-pill active" onclick="filterDiscoverShelves('all', this)"><span class="check-icon">&#x2713;</span> All</button>
    <button type="button" class="subnav-pill" onclick="filterDiscoverShelves('movie', this)">Movies</button>
    <button type="button" class="subnav-pill" onclick="filterDiscoverShelves('series', this)">Shows</button>
    <button type="button" class="subnav-pill" onclick="filterDiscoverShelves('gems', this)">Hidden Gems</button>
    <button type="button" class="subnav-pill" onclick="filterDiscoverShelves('kids', this)">Kids</button>
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
  </div>

  <!-- Discover Lists Feed (Movies / Shows list view matching search) -->
  <div id="discoverListsFeed" style="display:none;"></div>
</div>

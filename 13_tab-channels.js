<div class="tab-panel" data-tab-panel="search" hidden>
  <div class="panel">
    <div class="shelf-header" style="margin-bottom:10px;">
      <h2 class="shelf-title">Search Movies &amp; TV Shows</h2>
    </div>
    <p style="margin:0 0 12px; color:var(--muted); font-size:0.85rem;">Search the TMDB catalog to find movies and shows to add to your lists.</p>
    
    <div class="row">
      <input type="text" id="catalogSearchInput" placeholder="Search by title..." onkeydown="if(event.key==='Enter'){event.preventDefault();runCatalogSearch();}">
      <button type="button" class="primary" onclick="runCatalogSearch()">Search</button>
    </div>

    <div class="subnav-pills-bar" id="catalogSearchTypeChips" style="margin-top:10px;">
      <button type="button" class="subnav-pill active" onclick="setCatalogSearchFilter('movie', this)"><span class="check-icon">&#x2713;</span> Movies</button>
      <button type="button" class="subnav-pill" onclick="setCatalogSearchFilter('tv', this)">Shows</button>
    </div>

    <div id="catalogSearchResult" style="margin-top:14px;"></div>
  </div>
</div>

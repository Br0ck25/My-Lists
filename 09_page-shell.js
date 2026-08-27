function renderBuilder(
  origin,
  { initialEntries = [], initialKeys = {}, isConfigureMode = false, deepLinkList = null } = {}
) {
  const initialTmdbKey = initialKeys.tmdbKey || "";
  const initialMdblistKey = initialKeys.mdblistKey || "";
  const initialMdblistAccessToken = initialKeys.mdblistAccessToken || "";
  const initialTraktKey = initialKeys.traktKey || "";
  const initialTraktUsername = initialKeys.traktUsername || "";
  const initialTraktAccessToken = initialKeys.traktAccessToken || "";
  const initialSimklKey = initialKeys.simklKey || "";
  const initialSimklAccessToken = initialKeys.simklAccessToken || "";
  const initialSimklUsername = initialKeys.simklUsername || "";
  const initialShuffleShelves = !!initialKeys.shuffleShelves;
  const initialShuffleItems = !!initialKeys.shuffleItems;
  const initialRegion = initialKeys.region || "US";
  const initialHideNonDigitalReleases = !!initialKeys.hideNonDigitalReleases;
  const streamingTop10Html = buildStreamingTop10Html();
  const streamingHtml = buildStreamingHtml();
  const mdblistChartsHtml = buildMdblistChartsHtml();
  const tmdbChartsHtml = buildTmdbChartsHtml();
  const traktChartsHtml = buildTraktChartsHtml();
  const simklChartsHtml = buildSimklChartsHtml();
  const combinedChartsHtml = buildCombinedChartsHtml();
  const hiddenGemsHtml = buildHiddenGemsHtml();
  const kidsHtml = buildKidsHtml();
  const holidaysHtml = buildHolidaysHtml();
  const genresHtml = buildGenresHtml();
  // Precomputed here (same pattern as the *Html fragments above) rather
  // than built inline inside the giant HTML template literal below --
  // this file's template literal has bitten past changes before with
  // subtle escaping issues (see e.g. the doubled-backslash regex gotcha
  // elsewhere in renderBuilder), so anything with its own quotes/braces/
  // JSON gets built as a plain variable first and just substituted in as
  // one clean ${seoHeadHtml}.
  //
  // The two modes render different things: the plain / install page
  // (isConfigureMode false) is the only URL meant to be publicly
  // discoverable, so it gets the real title/description/OG/JSON-LD.
  // /:config/configure pages carry a personal base64 config (and any
  // personal API keys the user pasted in) baked straight into the URL
  // path -- there's no reason for a search engine to crawl, index, or
  // cache one of those, so those get a plain noindex instead of any of
  // the SEO metadata below.
  const seoHeadHtml = isConfigureMode
    ? `<title>${ADDON_NAME} — Configure</title>
<meta name="robots" content="noindex, nofollow">
<link rel="canonical" href="${origin}/">`
    : `<title>${ADDON_NAME} — Self-Hosted Stremio Catalogs from MDBList, Trakt, TMDB &amp; Simkl</title>
<meta name="description" content="Turn any MDBList, Trakt, TMDB, or Simkl list into a Stremio/wako catalog row. Self-hosted on your own free Cloudflare account -- no third-party server, no cost, your data stays yours. Includes Watch History, Continue Watching, and a full Custom List builder.">
<link rel="canonical" href="${origin}/">
<meta name="robots" content="index, follow">
<meta property="og:type" content="website">
<meta property="og:title" content="${ADDON_NAME} — Self-Hosted Stremio Catalogs">
<meta property="og:description" content="Turn any MDBList, Trakt, TMDB, or Simkl list into a Stremio/wako catalog row. Self-hosted on your own free Cloudflare account -- your data stays yours.">
<meta property="og:url" content="${origin}/">
<meta property="og:image" content="${origin}/icon.png">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${ADDON_NAME} — Self-Hosted Stremio Catalogs">
<meta name="twitter:description" content="Turn any MDBList, Trakt, TMDB, or Simkl list into a Stremio/wako catalog row. Self-hosted on your own free Cloudflare account.">
<script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        name: ADDON_NAME,
        applicationCategory: "MultimediaApplication",
        operatingSystem: "Any",
        description:
          "Self-hosted Stremio/wako add-on that turns MDBList, Trakt, TMDB, and Simkl lists into home-screen catalog rows, with Watch History, Continue Watching, and a Custom List builder -- all running on your own free Cloudflare Worker.",
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        url: origin + "/",
      })}</script>`;
  const hasInitial = initialEntries.length > 0;
  const initialEntriesJson = JSON.stringify(
    hasInitial
      ? initialEntries
      : [
          { name: "Popular", url: "https://mdblist.com/lists/official/movies/popular\ntmdb:chart:popular\ntrakt:chart:popular", type: "movie", enabled: true, group: "Combined Charts" },
          { name: "Popular", url: "https://mdblist.com/lists/official/shows/popular\ntmdb:chart:popular\ntrakt:chart:popular", type: "series", enabled: true, group: "Combined Charts" },
          { name: "Trending", url: "tmdb:chart:trending\ntrakt:chart:trending\nsimkl:chart:today\nsimkl:chart:week\nsimkl:chart:month", type: "movie", enabled: true, group: "Combined Charts" },
          { name: "Trending", url: "tmdb:chart:trending\ntrakt:chart:trending\nsimkl:chart:today\nsimkl:chart:week\nsimkl:chart:month", type: "series", enabled: true, group: "Combined Charts" },
          // Both the Top 10 and full Streaming Catalogs merged rows below
          // use the exact same joined url string for their movie row and
          // series row now -- unlike the old per-provider mdblist.com
          // urls they replaced, a tmdb:chart:X source doesn't encode
          // movie/series in the url itself; fetchCatalog picks the right
          // side of TMDB_CHART_PATHS[chartKey] from entry.type at fetch
          // time (see 07_source-fetchers-tmdb-simkl.js), the same way the
          // standalone per-provider rows in 08_quickadd-chart-data.js
          // already reuse one url for both their +Movies and +Shows
          // buttons.
          { name: "Streaming Top 10 (All Services)", url: "https://mdblist.com/lists/ahmed2250/apple-tv-top-10-movies-today\nhttps://mdblist.com/lists/andykai/disney-top-10-no-hulu\nhttps://mdblist.com/lists/harmes7/hbo-max-top-10-movies-m77r6mc20q\nhttps://mdblist.com/lists/hulupiv/hulu-top-10-movies\nhttps://mdblist.com/lists/hdlists/netflix-top-10-trending-movies\nhttps://mdblist.com/lists/ahmed2250/paramount-top-10-movies-today\nhttps://mdblist.com/lists/diimaan/amazon-prime-top-10-movies\nhttps://mdblist.com/lists/diimaan/peacock-top-10-movies", type: "movie", enabled: true, group: "Combined Charts" },
          { name: "Streaming Top 10 (All Services)", url: "https://mdblist.com/lists/ahmed2250/apple-tv-top-10-tv-shows-today\nhttps://mdblist.com/lists/andykai/disney-trending-no-hulu\nhttps://mdblist.com/lists/harmes7/hbo-max-top-10-series-cp45l27nhd\nhttps://mdblist.com/lists/hulupiv/hulu-top-10-shows\nhttps://mdblist.com/lists/hdlists/netflix-top-10-trending-shows\nhttps://mdblist.com/lists/ahmed2250/paramount-top-10-tv-shows-today\nhttps://mdblist.com/lists/diimaan/amazon-prime-top-10-tv-shows\nhttps://mdblist.com/lists/peacockpiv/peacock-top-10-shows", type: "series", enabled: true, group: "Combined Charts" },
          { name: "Streaming (All Services)", url: "tmdb:chart:appletv\ntmdb:chart:disney\ntmdb:chart:discovery\ntmdb:chart:hbomax\ntmdb:chart:hulu\ntmdb:chart:netflix\ntmdb:chart:netflixkids\ntmdb:chart:paramount\ntmdb:chart:primevideo\ntmdb:chart:peacock", type: "movie", enabled: true, group: "Combined Charts" },
          { name: "Streaming (All Services)", url: "tmdb:chart:appletv\ntmdb:chart:disney\ntmdb:chart:discovery\ntmdb:chart:hbomax\ntmdb:chart:hulu\ntmdb:chart:netflix\ntmdb:chart:netflixkids\ntmdb:chart:paramount\ntmdb:chart:primevideo\ntmdb:chart:peacock", type: "series", enabled: true, group: "Combined Charts" }
      ]
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#F2F2F7">
<link rel="manifest" href="${origin}/app.webmanifest">
${seoHeadHtml}
<link rel="icon" type="image/png" href="${origin}/icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<script>
  if (localStorage.getItem('theme') === 'dark' || (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark-theme');
  }
  (function() {
    var p = location.pathname || '';
    var h = location.hash || '';
    var isDeep = (p.startsWith('/lists/') && p !== '/lists') || p.startsWith('/channels/') || h.startsWith('#/list?') || h.startsWith('#/item?');
    var tab = 'discover';
    if (isDeep) {
      tab = h.startsWith('#/item?') ? 'item-details' : 'list-details';
    } else {
      try {
        var s = localStorage.getItem('myListAddon:activeTab');
        if (s && s !== 'list-details' && s !== 'item-details') tab = s;
      } catch (e) {}
    }
    document.documentElement.setAttribute('data-initial-tab', tab);

    try {
      var catSub = localStorage.getItem('myListAddon:catalogsSubmenu') || 'all';
      document.documentElement.setAttribute('data-initial-catalogs-sub', catSub);
      var listSub = localStorage.getItem('myListAddon:listsSubmenu') || 'my-lists';
      document.documentElement.setAttribute('data-initial-lists-sub', listSub);
      var chSub = localStorage.getItem('myListAddon:channelsSubmenu') || 'my-channels';
      document.documentElement.setAttribute('data-initial-channels-sub', chSub);
      var setSub = localStorage.getItem('myListAddon:settingsSubmenu') || 'account';
      document.documentElement.setAttribute('data-initial-settings-sub', setSub);
      var discSub = localStorage.getItem('myListAddon:discoverSubmenu') || 'all';
      document.documentElement.setAttribute('data-initial-discover-sub', discSub);
    } catch (e) {}
  })();
</script>
<style>
  :root {
    /* Wako-inspired iOS-native modern light theme */
    --bg:           #F2F2F7;
    --surface:      #FFFFFF;
    --panel:        #FFFFFF;
    --panel-strong: #E5E5EA;
    --border:       rgba(0,0,0,0.08);
    --border-strong:rgba(0,0,0,0.13);
    --text:         #1C1C1E;
    --text-2:       #3A3A3C;
    --muted:        #8E8E93;
    --accent:       #007AFF;
    --accent-hover: #0062CC;
    --accent-2:     #34AADC;
    --danger:       #FF3B30;
    --success:      #34C759;
    --warn:         #FF9500;
    --rating-high:  #34C759;
    --rating-mid:   #FF9500;
    --rating-low:   #FF3B30;
    --shadow-sm:    0 1px 3px rgba(0,0,0,0.06);
    --shadow:       0 2px 10px rgba(0,0,0,0.08);
    --shadow-md:    0 4px 20px rgba(0,0,0,0.10);
    --font-display: 'Inter', -apple-system, BlinkMacSystemFont, 'SF Pro Display', system-ui, sans-serif;
    --font-body:    'Inter', -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
    --font-mono:    'JetBrains Mono', ui-monospace, 'SF Mono', monospace;
    --sb-track:     transparent;
    --sb-thumb:     rgba(0,0,0,0.15);
    --sb-thumb-hover:rgba(0,0,0,0.25);
    --radius:       14px;
    --radius-sm:    10px;
    --radius-pill:  999px;
  }
  :root.dark-theme {
    --bg:           #000000;
    --surface:      #1C1C1E;
    --panel:        #1C1C1E;
    --panel-strong: #2C2C2E;
    --border:       rgba(255,255,255,0.15);
    --border-strong:rgba(255,255,255,0.25);
    --text:         #FFFFFF;
    --text-2:       #EBEBF5;
    --muted:        #8E8E93;
    --sb-thumb:     rgba(255,255,255,0.15);
    --sb-thumb-hover:rgba(255,255,255,0.25);
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html { touch-action: manipulation; width: 100%; max-width: 100%; overflow-x: hidden; }
  body {
    font-family: var(--font-body);
    margin: 0;
    min-height: 100vh;
    width: 100%;
    max-width: 100%;
    overflow-x: hidden;
    padding: 16px 12px calc(80px + env(safe-area-inset-bottom));
    background: var(--bg);
    color: var(--text);
    font-size: 15px;
    -webkit-font-smoothing: antialiased;
  }
  .page {
    max-width: 1200px;
    width: 100%;
    margin: 0 auto;
    display: grid;
    gap: 12px;
    overflow-x: hidden;
  }

  /* --- Top App Header ---------------------------------------------------- */
  .app-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 10px;
    padding: 6px 4px 8px;
  }
  .app-header-left {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: 1 1 auto;
    min-width: 0;
  }
  .app-header-avatar {
    width: 40px;
    height: 40px;
    border-radius: 12px;
    box-shadow: var(--shadow-sm);
    object-fit: cover;
  }
  .app-header-title-group {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .app-header-title {
    font-size: 1.35rem;
    font-weight: 800;
    letter-spacing: -0.025em;
    color: var(--text);
    margin: 0;
    line-height: 1.15;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .app-header-sub {
    font-size: 0.8rem;
    color: var(--muted);
    font-weight: 500;
    margin-top: 1px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .app-header-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-left: auto;
  }
  .header-icon-btn {
    width: 36px;
    height: 36px;
    min-width: 36px;
    min-height: 36px;
    box-sizing: border-box;
    border-radius: 50%;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    outline: none;
    -webkit-appearance: none;
    -moz-appearance: none;
    appearance: none;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-2);
    cursor: pointer;
    box-shadow: var(--shadow-sm);
    padding: 0;
  }

  /* --- Top Tab Bar (Desktop View) ---------------------------------------------- */
  .tab-bar {
    display: flex; gap: 8px; overflow-x: auto; padding: 2px 0 6px;
    margin-bottom: 4px; -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  .tab-bar::-webkit-scrollbar { display: none; }
  .tab-btn {
    flex: none;
    background: var(--surface);
    color: var(--text-2);
    border: 1.5px solid var(--border-strong);
    border-radius: var(--radius-pill);
    padding: 8px 16px;
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    min-height: unset;
    transition: background 0.15s, color 0.15s, border-color 0.15s, box-shadow 0.15s;
    box-shadow: var(--shadow-sm);
  }
  .tab-btn.active {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
    box-shadow: 0 2px 10px rgba(0,122,255,0.30);
  }
  .tab-btn:hover:not(.active) { border-color: var(--accent); color: var(--accent); }
  .tab-panel { display: grid; gap: 14px; width: 100%; max-width: 100%; min-width: 0; }
  .tab-panel[hidden] { display: none; }
  /* Prevent FOUC: Show initial active tab and hide inactive ones before script execution */
  html[data-initial-tab] .tab-panel {
    display: none !important;
  }
  html[data-initial-tab="discover"] .tab-panel[data-tab-panel="discover"],
  html[data-initial-tab="catalogs"] .tab-panel[data-tab-panel="catalogs"],
  html[data-initial-tab="lists"] .tab-panel[data-tab-panel="lists"],
  html[data-initial-tab="channels"] .tab-panel[data-tab-panel="channels"],
  html[data-initial-tab="search"] .tab-panel[data-tab-panel="search"],
  html[data-initial-tab="settings"] .tab-panel[data-tab-panel="settings"],
  html[data-initial-tab="list-details"] .tab-panel[data-tab-panel="list-details"],
  html[data-initial-tab="item-details"] .tab-panel[data-tab-panel="item-details"] {
    display: grid !important;
  }
  html[data-initial-tab]:not([data-initial-tab="discover"]) .tab-btn[data-tab="discover"] {
    background: var(--surface) !important;
    color: var(--text-2) !important;
    border-color: var(--border-strong) !important;
    box-shadow: var(--shadow-sm) !important;
  }
  html[data-initial-tab]:not([data-initial-tab="discover"]) .bottom-nav-item[data-tab="discover"] {
    color: var(--muted) !important;
  }
  html[data-initial-tab="catalogs"] .tab-btn[data-tab="catalogs"],
  html[data-initial-tab="lists"] .tab-btn[data-tab="lists"],
  html[data-initial-tab="channels"] .tab-btn[data-tab="channels"],
  html[data-initial-tab="search"] .tab-btn[data-tab="search"],
  html[data-initial-tab="settings"] .tab-btn[data-tab="settings"] {
    background: var(--accent) !important;
    color: #fff !important;
    border-color: var(--accent) !important;
    box-shadow: 0 2px 10px rgba(0,122,255,0.30) !important;
  }
  html[data-initial-tab="catalogs"] .bottom-nav-item[data-tab="catalogs"],
  html[data-initial-tab="lists"] .bottom-nav-item[data-tab="lists"],
  html[data-initial-tab="channels"] .bottom-nav-item[data-tab="channels"],
  html[data-initial-tab="search"] .bottom-nav-item[data-tab="search"],
  html[data-initial-tab="settings"] .bottom-nav-item[data-tab="settings"] {
    color: var(--accent) !important;
  }

  /* --- Initial Subpanel & Subnav Styles (Zero FOUC on Refresh) --- */
  /* Catalogs */
  html[data-initial-catalogs-sub] #catalogsSubShelves,
  html[data-initial-catalogs-sub] #catalogsSubQuickAdd,
  html[data-initial-catalogs-sub] #catalogsSubBulk {
    display: none !important;
  }
  html[data-initial-catalogs-sub="all"] #catalogsSubShelves,
  html[data-initial-catalogs-sub="shelves"] #catalogsSubShelves {
    display: block !important;
  }
  html[data-initial-catalogs-sub="quickadd"] #catalogsSubQuickAdd {
    display: block !important;
  }
  html[data-initial-catalogs-sub="bulk"] #catalogsSubBulk {
    display: block !important;
  }
  html[data-initial-catalogs-sub] #catalogsFilterBar .subnav-pill {
    background: var(--surface) !important;
    color: var(--text-2) !important;
    border-color: var(--border-strong) !important;
    box-shadow: none !important;
  }
  html[data-initial-catalogs-sub] #catalogsFilterBar .subnav-pill .check-icon {
    display: none !important;
  }
  html[data-initial-catalogs-sub="all"] #catalogsFilterBar .subnav-pill[data-sub="all"],
  html[data-initial-catalogs-sub="shelves"] #catalogsFilterBar .subnav-pill[data-sub="all"],
  html[data-initial-catalogs-sub="quickadd"] #catalogsFilterBar .subnav-pill[data-sub="quickadd"],
  html[data-initial-catalogs-sub="bulk"] #catalogsFilterBar .subnav-pill[data-sub="bulk"] {
    background: var(--accent) !important;
    color: #ffffff !important;
    border-color: var(--accent) !important;
    box-shadow: 0 2px 8px rgba(0,122,255,0.28) !important;
  }

  /* Lists */
  html[data-initial-lists-sub] #listsSubMyLists,
  html[data-initial-lists-sub] #listsSubLiked,
  html[data-initial-lists-sub] #listsSubImport,
  html[data-initial-lists-sub] #listsSubBulk,
  html[data-initial-lists-sub] #listsSubCreateList {
    display: none !important;
  }
  html[data-initial-lists-sub="my-lists"] #listsSubMyLists {
    display: block !important;
  }
  html[data-initial-lists-sub="liked"] #listsSubLiked {
    display: block !important;
  }
  html[data-initial-lists-sub="import"] #listsSubImport {
    display: block !important;
  }
  html[data-initial-lists-sub="bulk"] #listsSubBulk {
    display: block !important;
  }
  html[data-initial-lists-sub="create-list"] #listsSubCreateList {
    display: block !important;
  }
  html[data-initial-lists-sub] #listsSubnavBar .subnav-pill {
    background: var(--surface) !important;
    color: var(--text-2) !important;
    border-color: var(--border-strong) !important;
    box-shadow: none !important;
  }
  html[data-initial-lists-sub] #listsSubnavBar .subnav-pill .check-icon {
    display: none !important;
  }
  html[data-initial-lists-sub="my-lists"] #listsSubnavBar .subnav-pill[data-sub="my-lists"],
  html[data-initial-lists-sub="liked"] #listsSubnavBar .subnav-pill[data-sub="liked"],
  html[data-initial-lists-sub="import"] #listsSubnavBar .subnav-pill[data-sub="import"],
  html[data-initial-lists-sub="bulk"] #listsSubnavBar .subnav-pill[data-sub="bulk"],
  html[data-initial-lists-sub="create-list"] #listsSubnavBar .subnav-pill[data-sub="create-list"] {
    background: var(--accent) !important;
    color: #ffffff !important;
    border-color: var(--accent) !important;
    box-shadow: 0 2px 8px rgba(0,122,255,0.28) !important;
  }

  /* Channels */
  html[data-initial-channels-sub] #channelsSubMyChannels,
  html[data-initial-channels-sub] #channelsSubStorylines,
  html[data-initial-channels-sub] #channelsSubQuickAdd,
  html[data-initial-channels-sub] #channelsSubImport,
  html[data-initial-channels-sub] #channelsSubBuild {
    display: none !important;
  }
  html[data-initial-channels-sub="my-channels"] #channelsSubMyChannels {
    display: block !important;
  }
  html[data-initial-channels-sub="storylines"] #channelsSubStorylines {
    display: block !important;
  }
  html[data-initial-channels-sub="quickadd"] #channelsSubQuickAdd {
    display: block !important;
  }
  html[data-initial-channels-sub="import"] #channelsSubImport {
    display: block !important;
  }
  html[data-initial-channels-sub] #channelsSubnavBar .subnav-pill {
    background: var(--surface) !important;
    color: var(--text-2) !important;
    border-color: var(--border-strong) !important;
    box-shadow: none !important;
  }
  html[data-initial-channels-sub] #channelsSubnavBar .subnav-pill .check-icon {
    display: none !important;
  }
  html[data-initial-channels-sub="my-channels"] #channelsSubnavBar .subnav-pill[data-sub="my-channels"],
  html[data-initial-channels-sub="storylines"] #channelsSubnavBar .subnav-pill[data-sub="storylines"],
  html[data-initial-channels-sub="quickadd"] #channelsSubnavBar .subnav-pill[data-sub="quickadd"],
  html[data-initial-channels-sub="import"] #channelsSubnavBar .subnav-pill[data-sub="import"] {
    background: var(--accent) !important;
    color: #ffffff !important;
    border-color: var(--accent) !important;
    box-shadow: 0 2px 8px rgba(0,122,255,0.28) !important;
  }

  /* Settings */
  html[data-initial-settings-sub] #settingsSubAccount,
  html[data-initial-settings-sub] #settingsSubExternal,
  html[data-initial-settings-sub] #settingsSubBackup,
  html[data-initial-settings-sub] #settingsSubFeedback {
    display: none !important;
  }
  html[data-initial-settings-sub="account"] #settingsSubAccount,
  html[data-initial-settings-sub="keys"] #settingsSubAccount {
    display: block !important;
  }
  html[data-initial-settings-sub="external"] #settingsSubExternal {
    display: block !important;
  }
  html[data-initial-settings-sub="backup"] #settingsSubBackup {
    display: block !important;
  }
  html[data-initial-settings-sub="feedback"] #settingsSubFeedback {
    display: block !important;
  }
  html[data-initial-settings-sub] #settingsSubnavBar .subnav-pill {
    background: var(--surface) !important;
    color: var(--text-2) !important;
    border-color: var(--border-strong) !important;
    box-shadow: none !important;
  }
  html[data-initial-settings-sub] #settingsSubnavBar .subnav-pill .check-icon {
    display: none !important;
  }
  html[data-initial-settings-sub="account"] #settingsSubnavBar .subnav-pill[data-sub="account"],
  html[data-initial-settings-sub="keys"] #settingsSubnavBar .subnav-pill[data-sub="account"],
  html[data-initial-settings-sub="external"] #settingsSubnavBar .subnav-pill[data-sub="external"],
  html[data-initial-settings-sub="backup"] #settingsSubnavBar .subnav-pill[data-sub="backup"],
  html[data-initial-settings-sub="feedback"] #settingsSubnavBar .subnav-pill[data-sub="feedback"] {
    background: var(--accent) !important;
    color: #ffffff !important;
    border-color: var(--accent) !important;
    box-shadow: 0 2px 8px rgba(0,122,255,0.28) !important;
  }

  /* Discover */
  html[data-initial-discover-sub="popular"] #discoverShelvesContainer,
  html[data-initial-discover-sub="popular"] #discoverListsFeed,
  html[data-initial-discover-sub="curated"] #discoverShelvesContainer,
  html[data-initial-discover-sub="curated"] #discoverListsFeed {
    display: none !important;
  }
  html[data-initial-discover-sub="popular"] #discoverSubPopular {
    display: block !important;
  }
  html[data-initial-discover-sub="curated"] #discoverSubCurated {
    display: block !important;
  }
  html[data-initial-discover-sub] #discoverSubnavBar .subnav-pill {
    background: var(--surface) !important;
    color: var(--text-2) !important;
    border-color: var(--border-strong) !important;
    box-shadow: none !important;
  }
  html[data-initial-discover-sub] #discoverSubnavBar .subnav-pill .check-icon {
    display: none !important;
  }
  html[data-initial-discover-sub="all"] #discoverSubnavBar .subnav-pill[data-sub="all"],
  html[data-initial-discover-sub="movie"] #discoverSubnavBar .subnav-pill[data-sub="movie"],
  html[data-initial-discover-sub="series"] #discoverSubnavBar .subnav-pill[data-sub="series"],
  html[data-initial-discover-sub="popular"] #discoverSubnavBar .subnav-pill[data-sub="popular"],
  html[data-initial-discover-sub="curated"] #discoverSubnavBar .subnav-pill[data-sub="curated"],
  html[data-initial-discover-sub="gems"] #discoverSubnavBar .subnav-pill[data-sub="gems"],
  html[data-initial-discover-sub="kids"] #discoverSubnavBar .subnav-pill[data-sub="kids"],
  html[data-initial-discover-sub="holidays"] #discoverSubnavBar .subnav-pill[data-sub="holidays"],
  html[data-initial-discover-sub="genres"] #discoverSubnavBar .subnav-pill[data-sub="genres"] {
    background: var(--accent) !important;
    color: #ffffff !important;
    border-color: var(--accent) !important;
    box-shadow: 0 2px 8px rgba(0,122,255,0.28) !important;
  }
  /* Each direct child of .tab-panel (the subnav pill bar, each
     .lists-subpanel) is a grid item and inherits the same default
     min-width:auto issue .tab-panel itself was already guarded against
     above -- setting min-width:0 on the parent only protects the parent,
     not these children individually. */
  .lists-subpanel { min-width: 0; }
  /* Same fix, same reason, for the Channels tab's subpanels (My Channels,
     Storylines & Universes, Quick Add, Import) -- without this, wide
     unwrapped content in any of them (e.g. the Storylines poster grid or
     a crossover-detection banner) could force the whole tab wider than
     the viewport on mobile instead of wrapping/scrolling within itself. */
  .channels-subpanel { width: 100%; max-width: 100%; min-width: 0; box-sizing: border-box; }
  /* Same fix, same reason, for the item-details page's direct content
     wrapper -- it's a direct grid-item child of .tab-panel too, and
     without its own min-width:0 override, wide unwrapped content inside
     it (cast rows, provider/genre chip rows, etc.) could force the whole
     page past the viewport width on mobile, same as the two subpanels
     above. */
  #itemDetailsBody { width: 100%; max-width: 100%; min-width: 0; box-sizing: border-box; }

  /* --- Bottom Nav (Mobile Only - Persistent Glassmorphism) ---------------- */
  .bottom-nav { display: none; }
  @media (max-width: 640px) {
    .tab-bar { display: none; }
    body { padding: 12px 12px calc(96px + env(safe-area-inset-bottom)); }
    .bottom-nav {
      display: flex;
      position: fixed !important;
      bottom: 0 !important;
      left: 0 !important;
      right: 0 !important;
      z-index: 9999 !important;
      background: rgba(255,255,255,0.94);
      -webkit-backdrop-filter: saturate(180%) blur(20px);
      backdrop-filter: saturate(180%) blur(20px);
      border-top: 1px solid var(--border);
      padding: 6px 0 calc(6px + env(safe-area-inset-bottom));
      box-shadow: 0 -1px 0 rgba(0,0,0,0.08), 0 -4px 16px rgba(0,0,0,0.05);
    }
    :root.dark-theme .bottom-nav, html.dark-theme .bottom-nav, body.dark-theme .bottom-nav {
      background: rgba(0,0,0,0.94) !important;
      border-top: 1px solid var(--border) !important;
      box-shadow: 0 -1px 0 rgba(255,255,255,0.08), 0 -4px 16px rgba(0,0,0,0.6) !important;
    }
    .bottom-nav-item {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 3px;
      padding: 4px 1px;
      min-height: 62px;
      background: none;
      border: none;
      border-radius: 0;
      color: var(--muted);
      font-size: 0.78rem;
      font-weight: 600;
      letter-spacing: 0.01em;
      cursor: pointer;
      transition: color 0.12s ease;
      white-space: nowrap;
      line-height: 1.1;
    }
    .bottom-nav-item svg {
      width: 28.5px; height: 28.5px; flex: none;
      transition: transform 0.12s ease;
      stroke-width: 1.8;
    }
    .bottom-nav-item.active { color: var(--accent); }
    .bottom-nav-item.active svg { transform: translateY(-1px); stroke-width: 2.2; }
    .bottom-nav-item:active { opacity: 0.6; }
  }

  .live-preview-poster-card.dragging {
    opacity: 0.55 !important;
    transform: scale(1.05) !important;
    box-shadow: 0 10px 25px rgba(0,0,0,0.4) !important;
    z-index: 100 !important;
    pointer-events: none !important;
  }

  /* --- Segmented Top Submenus (Matching Screenshot 3) --------------------- */
  .subnav-pills-bar {
    display: flex;
    gap: 8px;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
    touch-action: pan-x;
    padding: 4px 16px 8px 4px;
    align-items: center;
    box-sizing: border-box;
  }
  .subnav-pills-bar::-webkit-scrollbar { display: none; }
  .subnav-pill {
    flex: none;
    flex-shrink: 0;
    padding: 7px 16px;
    border-radius: var(--radius-pill);
    border: 1.5px solid var(--border-strong);
    background: var(--surface);
    color: var(--text-2);
    font-size: 0.86rem;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    min-height: unset;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: background 0.12s, color 0.12s, border-color 0.12s, box-shadow 0.12s;
    box-shadow: var(--shadow-sm);
    font-family: inherit;
  }
  .subnav-pill.active {
    background: var(--accent);
    color: #ffffff;
    border-color: var(--accent);
    box-shadow: 0 2px 8px rgba(0,122,255,0.28);
  }
  .subnav-pill:hover:not(.active) {
    border-color: var(--accent);
    color: var(--accent);
  }
  .subnav-pill .check-icon {
    font-weight: 800;
    font-size: 0.85rem;
  }

  /* --- Streaming Providers Chips Bar (Discover Tab) ----------------------- */
  .provider-bar {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
    padding: 4px 0 8px;
  }
  .provider-bar::-webkit-scrollbar { display: none; }
  .provider-chip {
    flex: none;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 6px 13px;
    border-radius: var(--radius-pill);
    background: var(--surface);
    border: 1.5px solid var(--border);
    color: var(--text);
    font-size: 0.82rem;
    font-weight: 700;
    cursor: pointer;
    box-shadow: var(--shadow-sm);
    white-space: nowrap;
    transition: transform 0.12s, border-color 0.12s, box-shadow 0.12s;
  }
  .provider-chip:hover {
    transform: translateY(-1px);
    box-shadow: var(--shadow);
    border-color: var(--accent);
  }
  .provider-chip-icon {
    width: 20px;
    height: 20px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 900;
    font-size: 0.72rem;
    color: #fff;
    flex: none;
  }
  .provider-chip-icon.netflix { background: #E50914; }
  .provider-chip-icon.prime   { background: #00A8E1; }
  .provider-chip-icon.apple   { background: #000000; color: #FFFFFF; }
  .provider-chip-icon.disney  { background: #113CCF; }
  .provider-chip-icon.max     { background: #5B00C5; }
  .provider-chip-icon.hulu    { background: #1CE783; color: #000; }
  .provider-chip-icon.paramount { background: #0064FF; }
  .provider-chip-icon.peacock { background: #000000; color: #FFFFFF; }
  .provider-chip-icon.discovery { background: #002244; }
  .provider-chip-icon.kids { background: #FF9900; }
  /* --- Discover Chart Cards & Quick Grids -------------------------------- */
  .quick-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 10px;
    width: 100%;
  }
  @media (min-width: 641px) {
    .quick-grid {
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    }
  }
  .discover-chart-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 12px;
    box-shadow: var(--shadow-sm);
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: 10px;
    transition: transform 0.12s, box-shadow 0.12s;
  }
  .discover-chart-card:hover {
    box-shadow: var(--shadow);
    transform: translateY(-1px);
  }
  .discover-chart-header {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .discover-chart-info {
    flex: 1;
    min-width: 0;
  }
  .discover-chart-title {
    font-weight: 700;
    font-size: 0.92rem;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .discover-chart-sub {
    font-size: 0.74rem;
    color: var(--muted);
    font-weight: 500;
    margin-top: 1px;
  }
  .discover-chart-seeall {
    flex-shrink: 0;
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--accent);
    text-decoration: none;
    white-space: nowrap;
    padding: 4px 2px;
  }
  .discover-chart-seeall:hover {
    text-decoration: underline;
  }
  .discover-chart-btns {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .discover-chart-btns .lc-btn {
    flex: 1;
    justify-content: center;
    font-size: 0.78rem;
    padding: 6px 8px;
  }

  /* --- Shelves & Horizontal Poster Strips (Discover Tab) ------------------- */
  .shelf-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 8px;
  }
  .shelf-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    /* Some shelf headers (e.g. Live Preview & Editor's title + 4 action
       buttons) have more content than fits on one line on a phone --
       without wrapping, that row forces the whole card (and everything
       else sharing its grid track) wider than the viewport. */
    flex-wrap: wrap;
    row-gap: 8px;
    padding: 0 2px;
  }
  .shelf-title {
    min-width: 0;
    font-size: 1.08rem;
    font-weight: 700;
    color: var(--text);
    margin: 0;
    letter-spacing: -0.015em;
  }
  .see-all-link {
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--accent);
    background: none;
    border: none;
    cursor: pointer;
    padding: 2px 0;
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
  .see-all-link:hover { opacity: 0.75; }
  .shelf-scroll-wrap {
    display: flex;
    gap: 10px;
    overflow-x: auto;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
    padding: 4px 2px 8px;
    width: 100%;
    max-width: 100%;
  }
  .shelf-scroll-wrap::-webkit-scrollbar { display: none; }

  /* --- Poster Cards (Wako Design) ----------------------------------------- */
  .poster-card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 105px;
    flex: none;
    cursor: pointer;
    position: relative;
  }
  @media (min-width: 641px) {
    .poster-card {
      width: 125px;
    }
  }
  .poster-card.grid-item {
    width: 100%;
  }
  .poster-image-wrap {
    width: 100%;
    aspect-ratio: 2 / 3;
    position: relative;
    border-radius: 9px;
    overflow: hidden;
    background: var(--panel-strong);
    box-shadow: var(--shadow-sm);
    border: 1px solid var(--border);
  }
  .poster-image {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .rating-badge {
    position: absolute;
    top: 6px;
    left: 6px;
    padding: 2px 5px;
    border-radius: 5px;
    font-size: 0.68rem;
    font-weight: 800;
    color: #fff;
    line-height: 1.15;
    box-shadow: 0 1px 4px rgba(0,0,0,0.4);
    letter-spacing: -0.01em;
    background: #48484A;
  }
  .rating-badge.rating-high { background: var(--rating-high); }
  .rating-badge.rating-mid  { background: var(--rating-mid); }
  .rating-badge.rating-low  { background: var(--rating-low); }

  .poster-provider-badge {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 16px;
    height: 16px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.6rem;
    font-weight: 900;
    color: #fff;
  }
  .poster-title {
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--text);
    line-height: 1.25;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    margin: 0;
  }
  .poster-meta {
    font-size: 0.7rem;
    color: var(--muted);
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 4px;
    line-height: 1;
  }

  /* --- 3-Column / 9-Column Poster Grid (Global Standard) ------------------ */
  .poster-grid-3, .live-preview-modal-grid, #detailGrid, #listPreviewGrid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px 8px;
    width: 100%;
  }
  @media (min-width: 641px) {
    .poster-grid-3, .live-preview-modal-grid, #detailGrid, #listPreviewGrid {
      grid-template-columns: repeat(9, 1fr);
      gap: 12px 8px;
    }
  }

  /* --- Channel Accordions & Grid ------------------------------------------- */
  .channel-card-section {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 16px;
    margin-bottom: 14px;
    box-shadow: var(--shadow-sm);
  }
  .channel-accordion {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin-bottom: 14px;
    box-shadow: var(--shadow-sm);
    overflow: hidden;
  }
  .channel-accordion summary {
    padding: 12px 16px;
    font-weight: 700;
    font-size: 0.92rem;
    cursor: pointer;
    user-select: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: var(--surface);
    color: var(--text);
    outline: none;
  }
  .channel-accordion summary::-webkit-details-marker {
    display: none;
  }
  .channel-accordion summary::after {
    content: '\u25be';
    font-size: 1rem;
    color: var(--muted);
    transition: transform 0.2s ease;
  }
  .channel-accordion[open] summary::after {
    transform: rotate(180deg);
  }
  .channel-accordion[open] summary {
    border-bottom: 1px solid var(--border);
  }
  .channel-accordion-body {
    padding: 14px 16px;
  }
  .channel-quick-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
    gap: 8px;
  }
  .channel-season-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
    margin-top: 8px;
  }
  @media (min-width: 641px) {
    .channel-season-grid {
      grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
    }
  }

  /* --- Wako List Cards Feed (Lists Tab - Matching Screenshot 3) ------------ */
  .list-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-sm);
    padding: 13px 13px 11px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    transition: box-shadow: 0.15s;
    margin-bottom: 10px;
    width: 100%;
    max-width: 100%;
    overflow: hidden;
    box-sizing: border-box;
    min-width: 0;
  }
  .list-card:hover { box-shadow: var(--shadow); }
  .list-card-header {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    min-width: 0;
  }
  .list-card-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .list-card-title {
    font-weight: 700; font-size: 0.96rem; color: var(--text);
    margin: 0 0 2px; line-height: 1.3;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    cursor: pointer;
  }
  .list-card-title:hover {
    color: var(--accent);
  }
  .list-card-meta {
    font-size: 0.76rem; color: var(--muted);
    display: flex; flex-wrap: wrap; gap: 0 5px; align-items: center;
    line-height: 1.4;
  }
  .list-card-meta-sep { color: var(--border-strong); }
  .list-card-actions {
    display: flex; gap: 5px; align-items: center; flex-shrink: 0; flex-wrap: wrap;
  }
  .lc-btn {
    padding: 6px 12px; min-height: unset;
    font-size: 0.8rem; font-weight: 600;
    border-radius: var(--radius-pill);
    border: 1.5px solid var(--border-strong);
    background: var(--bg); color: var(--text-2);
    cursor: pointer; display: inline-flex; align-items: center; gap: 4px;
    font-family: inherit; white-space: nowrap;
    transition: background 0.12s, color 0.12s, border-color 0.12s;
  }
  .lc-btn.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
  .lc-btn.primary:hover:not(:disabled) { opacity: 0.85; }
  .lc-btn.liked { color: var(--danger); border-color: rgba(255,59,48,0.4); }
  .lc-btn.view-btn { color: var(--accent); border-color: transparent; background: transparent; padding: 0; font-size: 0.82rem; }

  /* --- Presets & Backup 2x2 Mobile Layout & Unified Sizing ---------------- */
  .preset-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 12px 14px;
    margin-bottom: 8px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    box-shadow: var(--shadow-sm);
  }
  .preset-card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .preset-card-title {
    font-weight: 700;
    font-size: 0.92rem;
    color: var(--text);
  }
  .preset-actions-grid, .backup-actions-grid, .export-actions-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 6px;
    width: 100%;
  }
  @media (min-width: 641px) {
    .preset-card {
      flex-direction: row;
      align-items: center;
      justify-content: space-between;
    }
    .preset-actions-grid {
      display: flex;
      gap: 6px;
      width: auto;
    }
    .backup-actions-grid, .export-actions-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      width: auto;
    }
  }
  #settingsSubBackup .lc-btn,
  #settingsSubBackup .preset-actions-grid button,
  #settingsSubBackup .backup-actions-grid button,
  #settingsSubBackup .export-actions-grid button,
  #settingsSubBackup .row button {
    padding: 6px 12px;
    font-size: 0.8rem;
    font-weight: 600;
    min-height: 34px;
    border-radius: var(--radius-pill);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    text-align: center;
    box-sizing: border-box;
    white-space: nowrap;
  }

  /* --- Settings Subpanels & Key Display Mobile Responsiveness ------------- */
  .settings-subpanel {
    width: 100%;
    max-width: 100%;
    min-width: 0;
    box-sizing: border-box;
    overflow-x: hidden;
  }
  .creator-key-display {
    font-family: var(--font-mono, monospace);
    font-size: 0.88rem;
    font-weight: 600;
    color: var(--text);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    word-break: break-all;
    overflow-wrap: anywhere;
    white-space: normal;
    user-select: all;
    -webkit-user-select: all;
    max-width: 100%;
    box-sizing: border-box;
    letter-spacing: 0.5px;
    margin: 4px 0 10px;
  }
  .webhook-input-group {
    display: flex;
    gap: 8px;
    align-items: stretch;
    margin-bottom: 10px;
    flex-wrap: wrap;
    width: 100%;
    max-width: 100%;
    box-sizing: border-box;
  }
  .webhook-input-group input {
    flex: 1 1 200px;
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;
  }
  .webhook-input-group button {
    flex: none;
    white-space: nowrap;
  }
  @media (max-width: 640px) {
    .webhook-input-group {
      flex-direction: column;
    }
    .webhook-input-group input,
    .webhook-input-group button {
      width: 100% !important;
      flex: 1 1 100% !important;
    }
  }

  /* 9-Poster Preview Strip in List Cards (Desktop) / 3-Poster (Mobile) */
  .list-card-posters, .list-card-5posters {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
    margin-top: 4px;
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
  }
  @media (max-width: 640px) {
    .list-card-posters .list-card-mini-poster:nth-child(n+4),
    .list-card-5posters .list-card-mini-poster:nth-child(n+4),
    .list-card-posters .list-card-mini-poster-tile:nth-child(n+4),
    .list-card-5posters .list-card-mini-poster-tile:nth-child(n+4) {
      display: none;
    }
    .list-card-header {
      flex-wrap: wrap;
    }
    .list-card-body {
      flex-basis: calc(100% - 54px);
    }
    .list-card-actions {
      width: 100%;
      margin-top: 4px;
    }
  }
  @media (min-width: 641px) {
    .list-card-posters, .list-card-5posters {
      grid-template-columns: repeat(9, 1fr);
      gap: 6px;
    }
  }
  .list-card-mini-poster {
    aspect-ratio: 2 / 3;
    border-radius: 6px;
    overflow: hidden;
    background: var(--panel-strong);
    border: 1px solid var(--border);
    position: relative;
    width: 100%;
  }
  .list-card-mini-poster img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    transition: transform 0.2s;
  }
  /* Same 9/3-across grid cell as .list-card-mini-poster above, but with a
     name (and optional second-line subtitle, e.g. an episode's "S07E10")
     visible underneath instead of only on hover -- used on the "Your
     Custom Lists" dashboard, where a bare grid of unlabeled thumbnails
     doesn't say which item is which. Kept as a separate class rather than
     changing .list-card-mini-poster itself, since that class is also used
     for the Find Lists search-preview thumbnails, which don't have room
     for a label and rely on the "+" / count overlays sitting flush over
     the full aspect-ratio box. */
  .list-card-mini-poster-tile {
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: 100%;
    min-width: 0;
  }
  .list-card-mini-poster-img-wrap {
    aspect-ratio: 2 / 3;
    border-radius: 6px;
    overflow: hidden;
    background: var(--panel-strong);
    border: 1px solid var(--border);
    position: relative;
    width: 100%;
  }
  .storyline-posters-scroll {
    display: flex !important;
    flex-direction: row !important;
    gap: 12px !important;
    overflow-x: auto !important;
    overflow-y: hidden !important;
    -webkit-overflow-scrolling: touch !important;
    touch-action: pan-x !important;
    width: 100% !important;
    max-width: 100% !important;
    min-width: 0 !important;
    box-sizing: border-box !important;
    padding: 8px 2px 10px !important;
    scrollbar-width: thin !important;
  }
  .storyline-poster-item {
    display: flex !important;
    flex-direction: column !important;
    flex: 0 0 105px !important;
    width: 105px !important;
    max-width: 105px !important;
    min-width: 105px !important;
    box-sizing: border-box !important;
    text-align: center !important;
  }
  .cw-remove-btn {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 24px;
    height: 24px;
    min-width: 24px;
    min-height: 24px;
    box-sizing: border-box;
    border-radius: 50%;
    /* Solid theme color rather than a translucent black overlay -- the
       translucent version blended with whatever poster sat underneath it
       (often reading as a muddy brown against warm-toned posters). */
    background: var(--danger);
    color: #fff;
    border: none;
    outline: none;
    -webkit-appearance: none;
    -moz-appearance: none;
    appearance: none;
    font-size: 16px;
    font-weight: bold;
    box-shadow: 0 2px 4px rgba(0,0,0,0.35);
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    cursor: pointer;
    z-index: 10;
    transition: filter 0.2s;
  }
  .cw-remove-btn:hover {
    filter: brightness(0.88);
  }
  .cw-date-badge {
    position: absolute;
    top: 4px;
    left: 4px;
    background: var(--accent);
    color: #ffffff;
    font-size: 0.62rem;
    font-weight: 800;
    padding: 2px 5px;
    border-radius: var(--radius-sm);
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.45);
    line-height: 1.15;
    letter-spacing: -0.01em;
    z-index: 8;
    pointer-events: none;
    white-space: nowrap;
    text-transform: uppercase;
  }
  .cw-date-badge-premiere {
    background: #2fa84f;
    top: auto;
    bottom: 4px;
  }
  .airing-next-filter-pills {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .airingNextFilterPill {
    background: var(--panel-strong);
    color: var(--muted);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: 0.7rem;
    font-weight: 600;
    padding: 3px 9px;
    cursor: pointer;
    white-space: nowrap;
  }
  .airingNextFilterPill.active {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
  }
  .list-card-mini-poster-img-wrap img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    transition: transform 0.2s;
  }
  .list-card-mini-poster-img-wrap img.clickable-poster:hover {
    transform: scale(1.05);
  }
  .list-card-mini-poster-name {
    font-size: 0.68rem;
    color: var(--text);
    font-weight: 600;
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .list-card-mini-poster-subtitle {
    font-size: 0.64rem;
    color: var(--muted);
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .list-card-mini-poster-year {
    font-size: 0.64rem;
    color: var(--muted);
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .clickable-poster {
    cursor: pointer;
  }
  .clickable-poster:hover img {
    transform: scale(1.05);
  }
  .poster-add-overlay {
    position: absolute;
    bottom: 4px;
    right: 4px;
    background: rgba(0, 0, 0, 0.7);
    color: #fff;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    font-weight: bold;
    opacity: 0.85;
    transition: opacity 0.2s, background 0.2s;
    z-index: 5;
    cursor: pointer;
  }
  .clickable-poster:hover .poster-add-overlay,
  .live-preview-poster-card:hover .poster-add-overlay {
    opacity: 1;
  }
  .poster-add-overlay:hover {
    background: var(--brand);
    color: #fff;
  }
  #lists .poster-add-overlay,
  #listsLivePreview .poster-add-overlay,
  .entry .poster-add-overlay {
    display: none !important;
  }
  .drag-handle-list {
    cursor: grab;
    user-select: none;
    touch-action: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 1.1rem;
    color: var(--muted);
    margin-right: 12px;
    padding: 2px 6px;
    border-radius: var(--radius-sm);
    transition: color 0.15s, background-color 0.15s;
    vertical-align: middle;
  }
  .drag-handle-list:hover {
    color: var(--text);
    background: var(--panel-strong);
  }
  .drag-handle-list:active {
    cursor: grabbing;
  }
  .list-card-count-overlay {
    position: absolute;
    inset: 0;
    background: rgba(0,0,0,0.65);
    color: #fff;
    font-weight: 700;
    font-size: 0.8rem;
    display: flex;
    align-items: center;
    justify-content: center;
    backdrop-filter: blur(1px);
  }
  .list-card-count-overlay.mobile-only {
    display: flex;
  }
  .list-card-count-overlay.desktop-only {
    display: none;
  }
  @media (min-width: 641px) {
    .list-card-count-overlay.mobile-only {
      display: none;
    }
    .list-card-count-overlay.desktop-only {
      display: flex;
    }
  }

  /* --- Merged Channels Chips & Inline Add Selector ------------------------ */
  .merge-chip-remove-btn {
    background: transparent !important;
    border: none !important;
    color: var(--muted) !important;
    font-size: 0.95rem !important;
    font-weight: 700 !important;
    line-height: 1 !important;
    cursor: pointer !important;
    padding: 0 0 0 4px !important;
    margin: 0 !important;
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    transition: color 0.15s !important;
    border-radius: 0 !important;
    box-shadow: none !important;
    width: auto !important;
    height: auto !important;
  }
  .merge-chip-remove-btn:hover {
    color: var(--danger) !important;
  }
  .merge-add-channel-select {
    padding: 3px 8px;
    font-size: 0.78rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    border: 1px dashed var(--border);
    background: var(--surface);
    color: var(--accent);
    cursor: pointer;
    max-width: 220px;
    outline: none;
    transition: border-color 0.15s, color 0.15s;
    margin: 2px 0 2px 4px;
  }
  .merge-add-channel-select:hover {
    border-color: var(--accent);
  }
  .detail-filter-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
    padding: 0 0 16px 0;
    margin-bottom: 12px;
    border-bottom: 1px solid var(--border);
  }
  .detail-sort-select {
    padding: 6px 28px 6px 12px;
    font-size: 0.82rem;
    font-weight: 600;
    border-radius: var(--radius-pill);
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
    outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
    appearance: none;
    -webkit-appearance: none;
    -moz-appearance: none;
    background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238e8e93' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3e%3cpolyline points='6 9 12 15 18 9'%3e%3c/polyline%3e%3c/svg%3e");
    background-repeat: no-repeat;
    background-position: right 8px center;
    background-size: 14px;
  }
  .detail-sort-select:hover, .detail-sort-select:focus {
    border-color: var(--accent);
  }

  /* --- Cards & Panels ---------------------------------------------------- */
  .panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-sm);
    padding: 16px;
    width: 100%;
    max-width: 100%;
    overflow: hidden;
  }
  .panel-title {
    font-size: 1.1rem;
    font-weight: 700;
    margin: 0 0 10px;
    letter-spacing: -0.01em;
    color: var(--text);
  }

  /* --- Search Bar Wrap (Screenshot 4) ------------------------------------- */
  .search-bar-wrap {
    position: relative; display: flex; align-items: center; width: 100%;
  }
  .search-bar-wrap .sb-icon {
    position: absolute; left: 14px;
    width: 18px; height: 18px; color: var(--muted);
    pointer-events: none; flex: none;
  }
  .search-bar-wrap input {
    padding-left: 42px; padding-right: 40px;
    border-radius: var(--radius-pill);
    background: var(--surface);
    border: 1.5px solid var(--border-strong);
    font-size: 0.95rem;
    box-shadow: var(--shadow-sm);
  }
  .search-bar-clear {
    position: absolute; right: 10px;
    width: 22px; height: 22px; min-height: unset;
    border-radius: 50%; background: rgba(0,0,0,0.12);
    color: var(--text-2); border: none; padding: 0;
    font-size: 0.75rem; line-height: 1;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
  }

  /* --- Form controls & Helpers -------------------------------------------- */
  input, select, textarea {
    width: 100%;
    padding: 11px 14px;
    border-radius: var(--radius-sm);
    border: 1.5px solid var(--border-strong);
    background: var(--surface-2);
    color: var(--text);
    outline: none;
    font-size: 16px;
    font-family: inherit;
    min-height: 44px;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  input[type="file"] {
    padding: 0;
    min-height: unset;
    border: none;
    background: transparent;
    color: var(--text-2);
  }
  input[type="file"]::file-selector-button {
    background: var(--surface-2);
    color: var(--text);
    border: 1.5px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 8px 14px;
    margin-right: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  input[type="file"]::file-selector-button:hover {
    background: var(--surface-3);
    border-color: var(--text-2);
  }
  input[type="checkbox"], input[type="radio"] {
    width: 20px; height: 20px; min-height: unset;
    padding: 0; flex: none; accent-color: var(--accent);
  }
  
  /* Toggle Switch */
  .ui-toggle {
    position: relative; display: inline-block; width: 44px; height: 24px;
  }
  .ui-toggle input { opacity: 0; width: 0; height: 0; }
  .ui-toggle-slider {
    position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0;
    background-color: var(--border); transition: .3s; border-radius: 24px;
  }
  .ui-toggle-slider:before {
    position: absolute; content: ""; height: 18px; width: 18px; left: 3px; bottom: 3px;
    background-color: white; transition: .3s; border-radius: 50%; box-shadow: var(--shadow-sm);
  }
  .ui-toggle input:checked + .ui-toggle-slider { background-color: var(--accent); }
  .ui-toggle input:checked + .ui-toggle-slider:before { transform: translateX(20px); }
  input:focus, select:focus, textarea:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(0,122,255,0.15);
  }
  .custom-list-pick-poster {
    width: 36px; height: 54px; object-fit: cover; border-radius: 4px; flex: none; cursor: pointer;
  }
  .custom-list-pick-poster.empty-poster { background: transparent; }
  .channel-poster-choice {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    border-radius: 8px;
    padding: 6px;
    cursor: pointer;
    background: var(--surface);
    border: 2px solid transparent;
    transition: border-color 0.15s ease, transform 0.15s ease;
    user-select: none;
  }
  .channel-poster-choice:hover {
    border-color: rgba(0, 122, 255, 0.4);
  }
  .channel-poster-choice.selected {
    border-color: var(--accent);
    background: rgba(0, 122, 255, 0.08);
  }
  .channel-poster-choice .channel-poster-thumb-wrap {
    position: relative;
    width: 100%;
    aspect-ratio: 2 / 3;
    border-radius: 6px;
    overflow: hidden;
    background: rgba(0, 0, 0, 0.3);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .channel-poster-choice .channel-poster-thumb-wrap img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .channel-poster-choice .channel-poster-check {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--accent);
    color: #fff;
    font-size: 0.75rem;
    font-weight: 700;
    display: none;
    align-items: center;
    justify-content: center;
    box-shadow: 0 1px 4px rgba(0,0,0,0.5);
    z-index: 2;
  }
  .channel-poster-choice.selected .channel-poster-check {
    display: flex;
  }
  .channel-poster-choice .channel-poster-title {
    width: 100%;
    font-size: 0.75rem;
    font-weight: 600;
    text-align: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-top: 5px;
  }
  .channel-poster-choice .channel-poster-meta {
    font-size: 0.7rem;
    color: var(--muted);
    text-align: center;
  }
  .channel-crossover-banner {
    position: relative;
    background: linear-gradient(135deg, rgba(0, 122, 255, 0.12) 0%, rgba(88, 86, 214, 0.12) 100%);
    border: 1px solid rgba(0, 122, 255, 0.35);
    border-radius: var(--radius-md);
    padding: 12px 14px;
    margin-bottom: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .channel-crossover-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }
  .channel-crossover-title {
    font-size: 0.88rem;
    font-weight: 700;
    color: var(--text);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .channel-crossover-badge {
    background: var(--accent);
    color: #fff;
    font-size: 0.68rem;
    font-weight: 700;
    padding: 2px 7px;
    border-radius: var(--radius-pill);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .channel-crossover-desc {
    font-size: 0.8rem;
    color: var(--muted);
    line-height: 1.35;
    margin: 0;
  }
  .channel-crossover-parts {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 4px 0 2px;
  }
  .channel-crossover-chip {
    font-size: 0.72rem;
    padding: 3px 8px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.12);
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .channel-crossover-chip.present {
    background: rgba(52, 199, 89, 0.15);
    border-color: rgba(52, 199, 89, 0.4);
    color: #34C759;
  }
  .channel-crossover-chip.missing {
    background: rgba(255, 149, 0, 0.15);
    border-color: rgba(255, 149, 0, 0.4);
    color: #FF9500;
  }
  .channel-crossover-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 2px;
    flex-wrap: wrap;
  }
  /* .lc-btn's base white-space:nowrap (further up this stylesheet) is
     correct for the short, fixed labels it's normally used with ("Copy
     Key", "Reset Key", etc.), but the button here can carry a long,
     dynamic label ("+ Add 15 Missing Crossover Episodes in Story Order")
     -- nowrap forced it to render as one unbroken line wider than the
     viewport on mobile instead of wrapping. Scoped to just this button so
     every other .lc-btn usage keeps its normal nowrap behavior. */
  .channel-crossover-actions .lc-btn {
    white-space: normal;
    text-align: center;
    max-width: 100%;
  }
  /* Support & Feedback Chat */
  .support-chat-container {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 10px;
  }
  .support-threads-bar {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding-bottom: 4px;
  }
  .support-thread-pill {
    padding: 6px 12px;
    border-radius: var(--radius-pill);
    background: var(--surface);
    border: 1px solid var(--border);
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text);
  }
  .support-thread-pill.active {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
  }
  .support-messages-stream {
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-height: 380px;
    min-height: 180px;
    overflow-y: auto;
    padding: 12px;
    background: rgba(0, 0, 0, 0.2);
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
  }
  .support-bubble {
    max-width: 85%;
    padding: 10px 14px;
    border-radius: 14px;
    font-size: 0.88rem;
    line-height: 1.4;
    word-break: break-word;
    white-space: pre-wrap;
  }
  .support-bubble.user {
    align-self: flex-end;
    background: var(--accent);
    color: #fff;
    border-bottom-right-radius: 4px;
  }
  .support-bubble.admin {
    align-self: flex-start;
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border-strong);
    border-bottom-left-radius: 4px;
  }
  .support-bubble-sender {
    font-size: 0.72rem;
    font-weight: 700;
    margin-bottom: 4px;
    display: flex;
    align-items: center;
    gap: 6px;
    opacity: 0.85;
  }
  .support-bubble-time {
    font-size: 0.68rem;
    opacity: 0.65;
    margin-top: 4px;
    text-align: right;
  }
  .support-reply-composer {
    display: flex;
    gap: 8px;
    align-items: flex-end;
  }
  .support-reply-composer textarea {
    flex: 1;
    min-height: 44px;
    max-height: 120px;
    padding: 10px 12px;
    border-radius: 12px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
    font-family: inherit;
    font-size: 0.88rem;
    resize: vertical;
  }
  .row { display: flex; flex-direction: column; align-items: stretch; gap: 10px; margin-bottom: 10px; width: 100%; }
  .field-row { display: grid; grid-template-columns: 1fr; gap: 10px; width: 100%; }
  button, .actions a {
    padding: 11px 18px;
    min-height: 44px;
    border-radius: var(--radius-pill);
    border: none;
    background: var(--accent);
    color: #fff;
    cursor: pointer;
    font-weight: 600;
    font-size: 0.925rem;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: opacity 0.12s, transform 0.12s;
    font-family: inherit;
  }
  button.secondary, .btn-copy, .btn-watchlist, .btn-test {
    background: var(--surface);
    color: var(--text-2);
    border: 1.5px solid var(--border-strong);
    box-shadow: var(--shadow-sm);
  }
  button.modal-close-x {
    width: 32px; height: 32px; min-height: unset;
    padding: 0; border-radius: 50%;
    background: var(--bg); color: var(--muted);
    border: 1px solid var(--border-strong);
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 1rem; line-height: 1; flex: none;
  }
  button:hover:not(:disabled), .actions a:hover { opacity: 0.85; }
  .btn-stremio { background: linear-gradient(135deg, #9B8FFF, #6D48FF); color: #fff; }
  .btn-nuvio   { background: linear-gradient(135deg, #FF5E3A, #FF2A68); color: #fff; }
  .btn-wako    { background: linear-gradient(135deg, #007AFF, #34AADC); color: #fff; }
  .actions { display: flex; flex-direction: column; align-items: stretch; gap: 8px; }

  /* --- Install Result Card & Manifest Link Display ------------------------ */
  #result {
    margin-top: 16px;
  }
  .install-result-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 18px 20px;
    box-shadow: var(--shadow);
    display: flex;
    flex-direction: column;
    gap: 14px;
    animation: resultSlideIn 0.22s cubic-bezier(0.16, 1, 0.3, 1);
  }
  @keyframes resultSlideIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .install-result-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }
  .install-result-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: var(--radius-pill);
    background: rgba(52, 199, 89, 0.12);
    color: #34C759;
    font-weight: 700;
    font-size: 0.82rem;
    letter-spacing: 0.01em;
  }
  .install-result-badge svg {
    stroke: currentColor;
  }
  .install-result-sub {
    font-size: 0.8rem;
    color: var(--muted);
    font-weight: 500;
  }
  .install-url-container {
    display: flex;
    flex-direction: column;
    background: var(--bg);
    border: 1.5px solid var(--border-strong);
    border-radius: 12px;
    padding: 12px 14px;
    gap: 10px;
    transition: border-color 0.15s, box-shadow 0.15s;
    min-width: 0;
  }
  .install-url-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .install-url-label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-weight: 700;
    font-size: 0.82rem;
    color: var(--text-2);
  }
  .install-url-label svg {
    color: var(--accent);
  }
  .install-url-copy-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    border-radius: var(--radius-pill);
    background: var(--surface);
    border: 1.5px solid var(--border-strong);
    color: var(--text);
    font-size: 0.82rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
    box-shadow: var(--shadow-sm);
    min-height: unset;
    font-family: inherit;
  }
  .install-url-copy-btn:hover {
    background: var(--panel-strong);
    border-color: var(--accent);
    color: var(--accent);
  }
  .install-url-box {
    font-family: var(--font-mono, monospace);
    font-size: 0.84rem;
    font-weight: 500;
    color: var(--text);
    word-break: break-all;
    overflow-wrap: anywhere;
    white-space: normal;
    user-select: all;
    -webkit-user-select: all;
    line-height: 1.5;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
    cursor: pointer;
  }
  .install-hint-box {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px 14px;
    border-radius: 10px;
    background: rgba(0, 122, 255, 0.05);
    border: 1px solid rgba(0, 122, 255, 0.13);
    color: var(--muted);
    font-size: 0.82rem;
    line-height: 1.45;
  }
  .install-hint-steps {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 6px;
    color: var(--text);
    font-size: 0.82rem;
  }

  .trakt-connect-actions {
    display: flex;
    flex-direction: row;
    width: auto;
    gap: 8px;
    margin-bottom: 10px;
    flex-wrap: wrap;
  }
  @media (max-width: 640px) {
    .trakt-connect-actions {
      display: flex !important;
      flex-direction: row !important;
      width: 100% !important;
      gap: 8px !important;
      flex-wrap: wrap !important;
    }
    .trakt-connect-actions #traktConnectBtn,
    .trakt-connect-actions #traktDeviceBtn {
      flex: 1 1 calc(50% - 4px) !important;
      min-width: 0 !important;
      padding: 8px 4px !important;
      font-size: 0.8rem !important;
      white-space: nowrap !important;
      text-overflow: ellipsis !important;
      overflow: hidden !important;
    }
    .trakt-connect-actions #traktDisconnectBtn {
      flex: 1 1 100% !important;
      width: 100% !important;
      padding: 8px 4px !important;
      font-size: 0.8rem !important;
    }
  }
  @media (min-width: 641px) {
    .trakt-connect-actions {
      display: flex !important;
      flex-direction: row !important;
      width: auto !important;
      gap: 8px !important;
      flex-wrap: wrap !important;
    }
    .trakt-connect-actions button {
      flex: none !important;
      width: auto !important;
    }
  }



  /* --- Catalog Shelves (#lists in My Catalogs Tab) ------------------------ */
  #lists { display: grid; gap: 10px; grid-template-columns: 1fr; width: 100%; max-width: 100%; }
  .entry {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 16px;
    margin-bottom: 12px;
    padding: 14px;
    position: relative;
    box-shadow: var(--shadow-sm);
    /* A grid item's default min-width is auto (shrink no further than its
       widest content), not 0 -- without this, a wide Live Preview poster
       grid inside can force this whole row (and #lists's single column
       track) past the viewport edge on a phone instead of the poster grid
       itself shrinking to fit. */
    min-width: 0;
  }
  .entry.dragging {
    opacity: 0.4;
    box-shadow: 0 8px 16px rgba(0,0,0,0.15);
    border-color: var(--accent);
  }
  .entry-card-top {
    display: flex; align-items: flex-start; gap: 10px; margin-bottom: 10px; width: 100%;
  }
  .entry-avatar {
    width: 42px; height: 42px; border-radius: 11px; flex: none;
    display: flex; align-items: center; justify-content: center;
    font-weight: 800; font-size: 1.05rem; color: #fff;
    text-transform: uppercase;
  }
  .entry-card-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
  .entry-name-row { display: flex; align-items: center; gap: 6px; width: 100%; }
  .entry-name-row .name {
    flex: 1; min-width: 0; padding: 6px 10px;
    min-height: unset; font-size: 0.92rem; font-weight: 600;
    border-radius: 8px;
  }
  .entry-type-row { display: flex; align-items: center; gap: 6px; }
  .entry-type-row .type {
    padding: 5px 10px; min-height: unset; font-size: 0.82rem;
    border-radius: 8px; width: auto;
  }
  .entry-pos-wrap .pos {
    width: 48px; min-height: unset; padding: 5px 6px;
    font-size: 0.82rem; border-radius: 7px; text-align: center;
    background: var(--bg); border: 1.5px solid var(--border-strong);
  }
  .entry-ctrl-row {
    display: flex; gap: 4px; align-items: center; flex-shrink: 0;
  }
  .ec-btn {
    width: 32px; height: 32px; min-height: unset; padding: 0;
    border-radius: 8px; background: var(--bg); border: 1.5px solid var(--border-strong);
    color: var(--muted); display: inline-flex; align-items: center; justify-content: center;
    cursor: pointer; font-size: 0.9rem;
  }
  .ec-btn:hover:not(:disabled) { color: var(--text); background: var(--panel-strong); }
  .ec-btn.danger { color: var(--danger); border-color: rgba(255,59,48,0.25); background: rgba(255,59,48,0.07); }
  .sources { display: flex; flex-direction: column; gap: 10px; width: 100%; }
  .source-row { width: 100%; }
  .source-row + .source-row { padding-top: 10px; border-top: 1px dashed var(--border-strong); }
  .testrow { display: flex; align-items: center; gap: 10px; margin-top: 4px; flex-wrap: wrap; width: 100%; }
  .testresult { width: 100%; }
  .testresult.ok { color: var(--success); }
  .testresult.err { color: var(--danger); }
  .testresult.pending { color: var(--muted); }

  /* Compact view for #lists */
  #lists.compact .sources,
  #lists.compact .add-source-btn,
  #lists.compact .watchlist-note {
    display: none !important;
  }
  .premade-shelf .sources,
  .premade-shelf .add-source-btn {
    display: none !important;
  }
  #lists.compact .entry {
    padding: 8px 12px;
  }
  #lists.compact .entry-card-top {
    margin-bottom: 0;
  }

  /* Configured Shelves Test results: 1-row 5-posters strip on desktop, 1-row 3-posters on mobile */
  .preview-thumbs {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
    margin-top: 6px;
    max-width: 240px;
    width: 100%;
  }
  @media (max-width: 640px) {
    .preview-thumbs .preview-thumb:nth-child(n+4) {
      display: none;
    }
  }
  @media (min-width: 641px) {
    .preview-thumbs {
      grid-template-columns: repeat(5, 1fr);
      max-width: 440px;
      gap: 8px;
    }
  }
  .preview-thumb {
    width: 100%;
    aspect-ratio: 2 / 3;
    object-fit: cover;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--panel-strong);
    display: block;
  }

  /* --- Live Preview Shelves (Home Screen) --------------------------------- */
  .live-preview-shelf {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px;
    box-shadow: var(--shadow-sm);
    margin-bottom: 12px;
    width: 100%;
  }
  .live-preview-shelf-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
    font-weight: 700;
    font-size: 0.95rem;
    color: var(--text);
  }
  .live-preview-shelf-title span {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .live-preview-shelf-title .text-action-btn {
    margin-left: auto;
    color: var(--accent);
    background: none;
    border: none;
    font-size: 0.84rem;
    font-weight: 600;
    cursor: pointer;
    padding: 2px 4px;
    flex: none;
    white-space: nowrap;
  }
  .live-preview-shelf-title .text-action-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .live-preview-posters {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    width: 100%;
  }
  @media (max-width: 640px) {
    .live-preview-posters .live-preview-poster-card:nth-child(n+4) {
      display: none;
    }
  }
  @media (min-width: 641px) {
    .live-preview-posters {
      grid-template-columns: repeat(9, 1fr);
      gap: 8px;
    }
  }
  .live-preview-poster-card {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    width: 100%;
  }
  .live-preview-poster {
    width: 100%;
    aspect-ratio: 2 / 3;
    object-fit: cover;
    border-radius: 6px;
    background: var(--panel-strong);
    border: 1px solid var(--border);
    display: block;
  }
  .live-preview-poster.landscape {
    aspect-ratio: 16 / 9;
  }
  .live-preview-poster-placeholder {
    width: 100%;
    aspect-ratio: 2 / 3;
    border-radius: 6px;
    background: var(--panel-strong);
    border: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
  }
  .live-preview-poster-name {
    font-size: 0.70rem;
    color: var(--text);
    font-weight: 600;
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Second line under a poster for episode entries -- e.g. the episode's
     own title under a "Show Name S03E07" first line (see
     formatWatchItemLabel / livePreviewPosterHtml). Omitted entirely for
     anything without one (movies, shows, every other shelf on the site),
     so this never adds empty space to a normal poster card. */
  .live-preview-poster-subtitle {
    font-size: 0.66rem;
    color: var(--muted);
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .live-preview-poster-year {
    font-size: 0.65rem;
    color: var(--muted);
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* --- List Details page ("See All" full list view) ----------------------- */
  .list-details-page { padding-bottom: calc(24px + env(safe-area-inset-bottom)); }
  .detail-header-info h1 {
    font-size: 1.3rem; font-weight: 800; margin: 0;
  }
  .detail-header-info p {
    margin: 0; font-size: 0.85rem; color: var(--muted);
  }

  /* --- Modals & Toasts ---------------------------------------------------- */
  .modal-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.45);
    display: flex; align-items: center; justify-content: center;
    padding: 16px; z-index: 1000;
  }
  .modal-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 20px; padding: 22px; max-width: 440px; width: 100%;
    max-height: 90vh; overflow-y: auto; box-shadow: var(--shadow-md);
  }
  .modal-card.modal-card-wide {
    max-width: 1100px;
    width: 95vw;
  }
  .modal-close-x {
    float: right; background: var(--bg); border: 1px solid var(--border-strong);
    color: var(--muted); font-size: 1rem; cursor: pointer;
    width: 32px; height: 32px; padding: 0; border-radius: 50%;
    display: inline-flex; align-items: center; justify-content: center; line-height: 1;
  }
  .undo-toast {
    position: fixed; left: 50%;
    bottom: calc(66px + env(safe-area-inset-bottom));
    transform: translateX(-50%);
    background: var(--text); color: var(--surface);
    border-radius: 14px; padding: 12px 18px;
    display: flex; align-items: center; gap: 14px;
    box-shadow: var(--shadow-md); z-index: 1000;
  }
  .action-toast {
    position: fixed;
    left: 50%;
    bottom: calc(72px + env(safe-area-inset-bottom));
    transform: translateX(-50%) translateY(20px);
    background: rgba(28, 28, 30, 0.95);
    color: #ffffff;
    padding: 10px 18px;
    border-radius: var(--radius-pill);
    font-size: 0.86rem;
    font-weight: 600;
    box-shadow: 0 4px 16px rgba(0,0,0,0.25);
    z-index: 99999;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s ease, transform 0.2s ease;
    white-space: nowrap;
    max-width: 90vw;
    overflow: hidden;
    text-overflow: ellipsis;
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
  }
  .action-toast.show {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }

  @media (max-width: 640px) {
    .customListMoveBtn { display: none !important; }
    .customListPosInput { display: none !important; }
  }

  @media (min-width: 641px) {
    body { padding: 24px 20px 52px; }
    .page { gap: 16px; }
    .actions { flex-direction: row; flex-wrap: wrap; }
    .actions button, .actions a { width: auto; }
    .custom-list-pick-poster { width: 72px; height: 108px; }
    .row { flex-direction: row; }
    .field-row { grid-template-columns: minmax(0, 1fr) auto; }
    #lists { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }

    /* Live Preview & Editor CSS */
    
    /* Default (Preview Mode) */
    #lists:not(.live-preview-edit-mode) .entry-ctrl-row,
    #lists:not(.live-preview-edit-mode) .entry-name-row,
    #lists:not(.live-preview-edit-mode) .entry-type-row,
    #lists:not(.live-preview-edit-mode) .sources,
    #lists:not(.live-preview-edit-mode) .add-source-btn,
    #lists:not(.live-preview-edit-mode) .watchlist-note {
      display: none !important;
    }
    
    #lists:not(.live-preview-edit-mode) .entry {
      border: none !important;
      background: transparent !important;
      box-shadow: none !important;
      padding: 0 !important;
    }

    #lists:not(.live-preview-edit-mode) {
      grid-template-columns: 1fr !important;
    }

    /* In Edit Mode, hide the posters because they get in the way of drag-and-drop */
    #lists.live-preview-edit-mode .live-preview-posters {
      display: none !important;
    }
    
    #lists.live-preview-edit-mode .entry {
      border: 1px solid var(--border) !important;
      background: var(--bg) !important;
      padding: 12px !important;
    }

  
  .watch-indicator-overlay {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: #007aff;
    color: white;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    font-weight: bold;
    box-shadow: 0 2px 4px rgba(0,0,0,0.5);
    z-index: 5;
    pointer-events: none;
  }

  .is-watch-history-shelf .watch-indicator-overlay {
    display: none !important;
  }
  </style>
<script src="https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js"></script>
</head>
<body>
<div class="page">
  <!-- Top App Bar -->
  <header class="app-header">
    <div class="app-header-left">
      <div class="app-header-title-group">
        <h1 class="app-header-title" id="pageMainTitle">Discover</h1>
        <span class="app-header-sub" id="pageSubtitle">Explore Popular &amp; Streaming</span>
      </div>
    </div>
    <div class="app-header-actions">
      <button class="dark-mode-toggle" onclick="document.documentElement.classList.toggle('dark-theme'); localStorage.setItem('theme', document.documentElement.classList.contains('dark-theme') ? 'dark' : 'light');" style="background:transparent; border:none; color:var(--text); font-size:1.2rem; cursor:pointer; padding:4px;" title="Toggle Dark Mode">🌓</button>
      <div id="creatorProfileBar"></div>
    </div>
  </header>

  <!-- Top Tab Bar (Desktop View) -->
  <div class="tab-bar" role="tablist">
    <button type="button" class="tab-btn" data-tab="catalogs" onclick="switchTab('catalogs')">Catalogs</button>
    <button type="button" class="tab-btn" data-tab="lists" onclick="switchTab('lists')">Lists</button>
    <button type="button" class="tab-btn" data-tab="channels" onclick="switchTab('channels')">Channels</button>
    <button type="button" class="tab-btn active" data-tab="discover" onclick="switchTab('discover')">Discover</button>
    <button type="button" class="tab-btn" data-tab="search" onclick="switchTab('search')">Search</button>
    <button type="button" class="tab-btn" data-tab="settings" onclick="switchTab('settings')">Settings</button>
  </div>

  <!-- Bottom Nav Bar (Mobile View - Persistent Glassmorphism) -->
  <nav class="bottom-nav" role="tablist" aria-label="Main navigation">
    <button type="button" class="bottom-nav-item" data-tab="catalogs" onclick="switchTab('catalogs')" title="Catalogs">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
      </svg>
      Catalogs
    </button>
    <button type="button" class="bottom-nav-item" data-tab="lists" onclick="switchTab('lists')" title="Lists">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line>
        <line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line>
        <line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line>
      </svg>
      Lists
    </button>
    <button type="button" class="bottom-nav-item" data-tab="channels" onclick="switchTab('channels')" title="Channels">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="2" y="7" width="20" height="15" rx="2" ry="2"></rect>
        <polyline points="17 2 12 7 7 2"></polyline>
      </svg>
      Channels
    </button>
    <button type="button" class="bottom-nav-item active" data-tab="discover" onclick="switchTab('discover')" title="Discover">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect>
        <rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect>
      </svg>
      Discover
    </button>
    <button type="button" class="bottom-nav-item" data-tab="search" onclick="switchTab('search')" title="Search">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>
      </svg>
      Search
    </button>
    <button type="button" class="bottom-nav-item" data-tab="settings" onclick="switchTab('settings')" title="Settings">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3"></circle>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
      </svg>
      Settings
    </button>
  </nav>

  <script>
    (function() {
      var initTab = document.documentElement.getAttribute('data-initial-tab');
      if (initTab) {
        var titles = {
          discover: { title: 'Discover', sub: 'Explore Popular & Streaming' },
          catalogs: { title: 'Catalogs', sub: 'Manage Configured Catalogs' },
          lists: { title: 'Lists', sub: 'Custom, Connected & Liked Lists' },
          channels: { title: 'Channels', sub: '24/7 Continuous TV Streaming' },
          search: { title: 'Search', sub: 'Find Movies, Shows & Lists' },
          settings: { title: 'Settings', sub: 'Accounts, API Keys & Tools' }
        };
        var t = titles[initTab];
        if (t) {
          var titleEl = document.getElementById('pageMainTitle');
          var subEl = document.getElementById('pageSubtitle');
          if (titleEl) titleEl.textContent = t.title;
          if (subEl) subEl.textContent = t.sub;
        }
      }
      try {
        var cName = localStorage.getItem('myListAddon:creatorName');
        var cKey = localStorage.getItem('myListAddon:creatorKey');
        var cDisp = localStorage.getItem('myListAddon:creatorDisplayName') || cName;
        var cBar = document.getElementById('creatorProfileBar');
        if (cBar) {
          if (cName && cKey) {
            cBar.innerHTML = '<div style="display:flex; align-items:center; gap:8px;"><button type="button" class="subnav-pill active" style="margin:0; font-size:0.85rem; padding:8px 14px; font-weight:700; cursor:pointer; display:inline-flex; align-items:center; gap:6px; border-radius:var(--radius-pill);" onclick="switchTab(&quot;account&quot;)">&#x1F464; ' + (cDisp || cName) + '</button></div>';
          } else {
            cBar.innerHTML = '<div style="display:flex; align-items:center; gap:6px;"><button type="button" class="lc-btn primary" onclick="openRestoreModal()" style="padding:8px 16px; font-size:0.85rem; font-weight:700; border-radius:var(--radius-pill);">Login</button></div>';
          }
        }
      } catch (e) {}
    })();
  </script>

  <!-- Action Notification Toast -->
  <div id="actionToast" class="action-toast"></div>

  <!-- List Details page ("See All" full list view) -->
  <div class="tab-panel list-details-page" data-tab-panel="list-details" id="content-list-details" hidden>
    <div style="margin-bottom: 20px;">
      <button type="button" class="lc-btn secondary" onclick="navigateBackFromDetail()" style="padding: 6px 12px; font-size: 0.9rem;">&larr; Back</button>
    </div>
    <div class="detail-header-info" style="margin-bottom:14px;">
      <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
        <h1 id="detailTitle">List Title</h1>
        <div style="display:flex; gap:10px; align-items:center; margin-left:auto;">
          <button type="button" class="lc-btn searchLikeExternalBtn" id="detailLikeBtn">&#9825;</button>
          <button type="button" class="lc-btn primary" id="detailAddBtn">+ Add</button>
        </div>
      </div>
      <p id="detailSubtitle" style="margin-top:4px;">Loading&hellip;</p>
    </div>
    <div id="detailFilterBar" class="detail-filter-bar" style="display:none;">
      <div id="whFilterControls" style="display:flex; gap:6px; flex-wrap:wrap; align-items:center; width:100%;">
        <button type="button" class="subnav-pill active wh-filter-pill" data-wh-filter="all" onclick="setWatchHistoryFilter('all', this)">All</button>
        <button type="button" class="subnav-pill wh-filter-pill" data-wh-filter="movie" onclick="setWatchHistoryFilter('movie', this)">Movies</button>
        <button type="button" class="subnav-pill wh-filter-pill" data-wh-filter="series" onclick="setWatchHistoryFilter('series', this)">Shows</button>
        <label class="wh-group-shows-toggle" style="display:inline-flex; align-items:center; gap:6px; margin-left:8px; cursor:pointer; font-size:0.84rem; color:var(--text); user-select:none;">
          <input type="checkbox" id="whGroupShowsCheckbox" onchange="toggleWatchHistoryGroupShows(this.checked)" style="accent-color:var(--accent); cursor:pointer;">
          <span>Shows instead of episodes</span>
        </label>
        <button type="button" class="subnav-pill" id="whClearHistoryBtn" onclick="clearWatchHistoryAll()" style="color:var(--danger); border-color:rgba(255,59,48,0.35); margin-left:auto; font-weight:600;">Clear History</button>
      </div>
      <div id="genericTypeFilterControls" style="display:none; gap:6px; flex-wrap:wrap; align-items:center;">
        <button type="button" class="subnav-pill active generic-type-pill" id="detailTypeAllBtn" onclick="switchListDetailsType('all')">All</button>
        <button type="button" class="subnav-pill generic-type-pill" id="detailTypeMovieBtn" onclick="switchListDetailsType('movie')">Movies</button>
        <button type="button" class="subnav-pill generic-type-pill" id="detailTypeSeriesBtn" onclick="switchListDetailsType('series')">Shows</button>
      </div>
      <div id="whSortControls" style="display:flex; align-items:center; gap:8px;">
        <label for="whSortSelect" style="font-size:0.75rem; color:var(--muted); font-weight:700; text-transform:uppercase; letter-spacing:0.02em;">Sort</label>
        <select id="whSortSelect" class="detail-sort-select" onchange="setWatchHistorySort(this.value)">
          <option value="recent">Recently Watched</option>
          <option value="oldest">Oldest Watched</option>
          <option value="title-asc">Title (A-Z)</option>
          <option value="title-desc">Title (Z-A)</option>
        </select>
      </div>
    </div>
    <div class="poster-grid-3" id="detailGrid"></div>
    <p id="detailStatus" style="text-align:center; color:var(--muted); margin-top:14px;"><small>Loading&hellip;</small></p>
  </div>

  <div class="tab-panel" data-tab-panel="item-details" id="content-item-details" hidden>
    <div style="margin-bottom: 20px;">
      <button type="button" class="lc-btn secondary" onclick="navigateBackFromDetail()" style="padding: 6px 12px; font-size: 0.9rem;">&larr; Back</button>
    </div>
    <div id="itemDetailsBody" style="display: flex; flex-direction: column; gap: 24px;">
      <!-- Filled dynamically -->
    </div>
  </div>

  <div id="createListModal" class="modal-overlay" style="display:none; z-index: 10001; background: rgba(0,0,0,0.45); justify-content: center; align-items: center; position: fixed; inset: 0; padding: 16px;">
    <div class="modal-card" style="width: 100%; max-width: 380px; padding: 22px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow); display: flex; flex-direction: column;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;">
        <h2 style="margin:0; font-size:1.25rem; font-weight:700; color:var(--text);" id="createListModalTitle">Create List</h2>
        <button type="button" class="modal-close-x" onclick="document.getElementById('createListModal').style.display = 'none';">&#x2715;</button>
      </div>

      <div style="margin-bottom: 12px;">
        <label style="display:block; font-size:0.8rem; font-weight:600; color:var(--muted); margin-bottom:4px; text-transform:uppercase;">Destination</label>
        <select id="createListModalDestination" style="width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size:0.95rem;" onchange="onChangeCreateListDestination()">
          <option value="custom">Custom List</option>
          <option value="trakt">Trakt List</option>
          <option value="tmdb">TMDB List</option>
          <option value="mdblist">MDBList List</option>
          <option value="simkl">Simkl List</option>
        </select>
      </div>
      
      <div style="margin-bottom: 12px;">
        <label style="display:block; font-size:0.8rem; font-weight:600; color:var(--muted); margin-bottom:4px; text-transform:uppercase;">List Name *</label>
        <input type="text" id="createListModalName" placeholder="e.g. My Favorite Sci-Fi" style="width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size:0.95rem;" oninput="document.getElementById('createListModalBtn').disabled = !this.value.trim(); document.getElementById('createListModalBtn').style.opacity = this.value.trim() ? '1' : '0.5';">
      </div>

      <div style="margin-bottom: 12px;">
        <label style="display:block; font-size:0.8rem; font-weight:600; color:var(--muted); margin-bottom:4px; text-transform:uppercase;">Description (Optional)</label>
        <textarea id="createListModalDesc" placeholder="Brief summary of what is in this list..." rows="2" style="width: 100%; padding: 8px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size:0.9rem; resize:vertical; font-family:inherit;"></textarea>
      </div>
      
      <div style="margin-bottom: 14px;">
        <label style="display:block; font-size:0.8rem; font-weight:600; color:var(--muted); margin-bottom:4px; text-transform:uppercase;">Content Type</label>
        <select id="createListModalType" style="width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size:0.95rem;">
          <option value="movie">Movies</option>
          <option value="series">Shows</option>
          <option value="mixed">Mixed (Movies &amp; Shows)</option>
        </select>
      </div>
      
      <div id="createListModalPublicWrap" style="margin-bottom: 18px; display: flex; justify-content: space-between; align-items: center;">
        <span style="font-size: 0.95rem; font-weight:500; color: var(--text);">Public</span>
        <label class="ui-toggle">
          <input type="checkbox" id="createListModalPublic" checked>
          <span class="ui-toggle-slider"></span>
        </label>
      </div>
      
      <div style="display: flex; justify-content: flex-end; gap: 10px; border-top: 1px solid var(--border); padding-top: 14px;">
        <button type="button" class="lc-btn secondary" onclick="document.getElementById('createListModal').style.display = 'none'">Cancel</button>
        <button type="button" class="lc-btn primary" id="createListModalBtn" style="opacity: 0.5; min-width: 80px;" disabled onclick="submitCreateListModal()">Create</button>
      </div>
    </div>
  </div>

  <!-- Add Catalog Modal -->
  <div id="addShelfModal" class="modal-overlay" style="display:none; z-index: 10001; background: rgba(0,0,0,0.45); justify-content: center; align-items: center; position: fixed; inset: 0; padding: 16px;">
    <div class="modal-card" style="width: 100%; max-width: 340px; padding: 22px; background: var(--bg); border-radius: 20px; box-shadow: var(--shadow); display: flex; flex-direction: column;">
      <h2 style="margin-top:0; font-size:1.3rem; font-weight:600; color:var(--text);">Add Catalog</h2>
      
      <div style="margin: 16px 0;">
        <input type="text" id="addShelfModalName" placeholder="Catalog name" style="width: 100%; padding: 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size:1rem; margin-bottom:12px;" oninput="validateAddShelfModal()">
        
        <div id="addShelfModalLinksContainer">
          <div class="add-shelf-link-row" style="display:flex; align-items:center; gap:8px; margin-bottom:12px;">
            <input type="url" class="addShelfModalLinkInput" placeholder="URL (e.g. Trakt, Letterboxd)" style="flex:1; padding: 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size:1rem;" oninput="onAddShelfModalLinkInput(this); validateAddShelfModal()">
          </div>
        </div>
        
        <button type="button" class="lc-btn secondary" style="width: 100%; margin-bottom: 12px; font-size: 0.9rem;" onclick="addShelfModalAddLink()">+ Add another link (Combined List)</button>
        
        <select id="addShelfModalType" style="width: 100%; padding: 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size:1rem; margin-bottom:12px;" onchange="validateAddShelfModal()">
          <option value="movie">Movies</option>
          <option value="series">Shows</option>
        </select>
      </div>
      
      <div style="display:flex; justify-content:flex-end; gap:16px; margin-top: 8px;">
        <button type="button" style="background:none; border:none; color:var(--text); font-weight:600; font-size:1rem; cursor:pointer;" onclick="document.getElementById('addShelfModal').style.display = 'none'">Cancel</button>
        <button type="button" id="addShelfModalBtn" style="background:none; border:none; color:var(--accent); font-weight:600; font-size:1rem; cursor:pointer; opacity: 0.5;" disabled onclick="submitAddShelfModal()">Add</button>
      </div>
    </div>
  </div>

  <div id="selectListModal" class="modal-overlay" style="display:none; z-index: 10001; justify-content: center; align-items: center; position: fixed; inset: 0; padding: 16px;">
    <div class="modal-card" style="width: 100%; max-width: 480px; padding: 22px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow); display: flex; flex-direction: column; max-height: 85vh;">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
        <div>
          <h2 style="margin:0; font-size:1.25rem; font-weight:700; color:var(--text);">Add / Remove from Lists</h2>
          <p style="margin:4px 0 0; font-size:0.85rem; color:var(--muted);">Check to add, uncheck to remove.</p>
        </div>
        <button type="button" class="modal-close-x" id="selectListModalCloseBtn">&#x2715;</button>
      </div>
      <div id="selectListModalBody" style="display: flex; flex-direction: column; gap: 0; max-height: 55vh; overflow-y: auto; margin-bottom: 18px; padding-right: 4px;">
        <!-- Filled dynamically -->
      </div>
      <div style="display: flex; justify-content: flex-end; gap: 10px; border-top: 1px solid var(--border); padding-top: 14px;">
        <button type="button" class="lc-btn secondary" id="selectListModalCancelBtn" onclick="document.getElementById('selectListModal').style.display = 'none'; document.body.style.overflow = '';">Cancel</button>
        <button type="button" class="lc-btn primary" id="addSelectedListsBtn" style="min-width: 90px;">Done</button>
      </div>
    </div>
  </div>

  <!-- Trakt Device Activation Modal -->
  <div id="traktDeviceModal" class="modal-overlay" style="display:none; z-index: 10002; justify-content: center; align-items: center; position: fixed; inset: 0; padding: 16px; background: rgba(0,0,0,0.5);">
    <div class="modal-card" style="width: 100%; max-width: 420px; padding: 24px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow); display: flex; flex-direction: column; text-align: center;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
        <h2 style="margin:0; font-size:1.25rem; font-weight:700; color:var(--text);">Connect Trakt</h2>
        <button type="button" class="modal-close-x" onclick="closeTraktDeviceModal()">&#x2715;</button>
      </div>
      <p style="margin: 0 0 16px; color: var(--muted); font-size: 0.9rem;">To authorize your Trakt account without redirects or rate limits, enter the code below on Trakt:</p>
      
      <div id="traktDeviceCodeBox" style="background: var(--panel-strong); border: 2px dashed var(--accent); border-radius: 12px; padding: 16px; margin-bottom: 16px;">
        <div id="traktDeviceUserCode" style="font-size: 2rem; font-weight: 800; letter-spacing: 4px; color: var(--accent); font-family: monospace;">LOADING...</div>
      </div>

      <div style="display: flex; flex-direction: column; gap: 10px; margin-bottom: 16px;">
        <a id="traktDeviceActivateLink" href="https://trakt.tv/activate" target="_blank" rel="noopener noreferrer" class="lc-btn primary" style="padding: 12px; font-weight: 700; text-decoration: none; display: flex; align-items: center; justify-content: center; gap: 8px;">
          Open trakt.tv/activate &#x2197;
        </a>
      </div>

      <div id="traktDevicePollingStatus" style="font-size: 0.85rem; color: var(--muted); display: flex; align-items: center; justify-content: center; gap: 8px;">
        Waiting for authorization on Trakt...
      </div>

      <div style="margin-top: 18px; border-top: 1px solid var(--border); padding-top: 14px;">
        <button type="button" class="lc-btn secondary" style="width: 100%;" onclick="closeTraktDeviceModal()">Cancel</button>
      </div>
    </div>
  </div>

<script>
/* Chart data tables -- injected at render time for renderDiscoverChartsList */
window._CHARTS_TMDB = ${JSON.stringify(TMDB_CHART_LISTS)};
window._CHARTS_TRAKT = ${JSON.stringify(TRAKT_CHART_LISTS)};
window._CHARTS_TRAKT_BO = ${JSON.stringify(TRAKT_BOXOFFICE_LIST)};
window._CHARTS_MDBLIST = ${JSON.stringify(MDBLIST_OFFICIAL_CHARTS)};
window._CHARTS_SIMKL = ${JSON.stringify(SIMKL_CHART_LISTS)};
window._CHARTS_SIMKL_ANIME = ${JSON.stringify(SIMKL_ANIME_LIST)};
window._CHARTS_STREAMING_TOP10 = ${JSON.stringify(STREAMING_TOP10)};
window._CHARTS_STREAMING_ALL = ${JSON.stringify(STREAMING_ALL)};
window._CHARTS_KIDS = ${JSON.stringify(KIDS_LISTS)};
window._CHARTS_HOLIDAYS = ${JSON.stringify(HOLIDAY_LISTS)};
window._CHARTS_GENRES = ${JSON.stringify(GENRE_LISTS)};
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(e => console.error(e));
}
</script>


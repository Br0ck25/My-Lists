// --- config UI (served at / and /:config/configure) -----------------------

// --- Streaming Top 10 / Streaming quick-add lists ---------------------------
//
// TO ADD YOUR REAL LINKS: find the provider's row below and replace its
// movieUrl / showUrl with the real mdblist.com list URL. Anything still set
// to "CHANGE-ME" is a placeholder — swap it and redeploy.
//
// There are two tables: STREAMING_TOP10 (the "Streaming Top 10" panel /
// charts) and STREAMING_ALL (the plain "Streaming" panel / full catalog).
// They're independent, so the same provider can have different links in each.
const STREAMING_TOP10 = [
  {
    name: "Apple TV+",
    movieUrl: "https://mdblist.com/lists/ahmed2250/apple-tv-top-10-movies-today",
    showUrl: "https://mdblist.com/lists/ahmed2250/apple-tv-top-10-tv-shows-today",
  },
  {
    name: "Disney+",
    movieUrl: "https://mdblist.com/lists/andykai/disney-top-10-no-hulu",
    showUrl: "https://mdblist.com/lists/andykai/disney-trending-no-hulu",
  },
  {
    name: "HBO Max",
    movieUrl: "https://mdblist.com/lists/harmes7/hbo-max-top-10-movies-m77r6mc20q",
    showUrl: "https://mdblist.com/lists/harmes7/hbo-max-top-10-series-cp45l27nhd",
  },
  {
    name: "Hulu",
    movieUrl: "https://mdblist.com/lists/hulupiv/hulu-top-10-movies",
    showUrl: "https://mdblist.com/lists/hulupiv/hulu-top-10-shows",
  },
  {
    // Reverted back to the community mdblist.com lists (from the brief
    // tmdb:top10:netflix experiment) -- TMDB/JustWatch's popularity
    // ranking doesn't match Netflix's own actual weekly Top 10 (verified
    // against netflix.com/tudum/top10, which publishes Netflix's real
    // self-reported rankings), so the TMDB-based version was consistently
    // wrong here even though it was correctly capped at exactly 10 items.
    // fetchTmdbProviderTop10 / tmdb:top10:X (see TMDB_CHART_PATHS.netflix)
    // is left in place, unused, in case an actual verified feed of
    // Netflix's real Top 10 data becomes available later.
    name: "Netflix",
    movieUrl: "https://mdblist.com/lists/hdlists/netflix-top-10-trending-movies",
    showUrl: "https://mdblist.com/lists/hdlists/netflix-top-10-trending-shows",
  },
  {
    name: "Paramount+",
    movieUrl: "https://mdblist.com/lists/ahmed2250/paramount-top-10-movies-today",
    showUrl: "https://mdblist.com/lists/ahmed2250/paramount-top-10-tv-shows-today",
  },
  {
    name: "Prime Video",
    movieUrl: "https://mdblist.com/lists/diimaan/amazon-prime-top-10-movies",
    showUrl: "https://mdblist.com/lists/diimaan/amazon-prime-top-10-tv-shows",
  },
  {
    name: "Peacock",
    movieUrl: "https://mdblist.com/lists/diimaan/peacock-top-10-movies",
    showUrl: "https://mdblist.com/lists/peacockpiv/peacock-top-10-shows",
  },
];

const STREAMING_ALL = [
  {
    name: "Apple TV+",
    movieUrl: "tmdb:chart:appletv",
    showUrl: "tmdb:chart:appletv",
  },
  {
    name: "Disney+",
    movieUrl: "tmdb:chart:disney",
    showUrl: "tmdb:chart:disney",
  },
  {
    name: "Discovery+",
    movieUrl: "tmdb:chart:discovery",
    showUrl: "tmdb:chart:discovery",
  },
  {
    name: "HBO Max",
    movieUrl: "tmdb:chart:hbomax",
    showUrl: "tmdb:chart:hbomax",
  },
  {
    name: "Hulu",
    movieUrl: "tmdb:chart:hulu",
    showUrl: "tmdb:chart:hulu",
  },
  {
    // Was two community mdblist.com lists (garycrawfordgc/netflix-*) --
    // swapped for the same live TMDB provider-filtered chart as the
    // Streaming Top 10 Netflix row above (see TMDB_CHART_PATHS.netflix).
    name: "Netflix",
    movieUrl: "tmdb:chart:netflix",
    showUrl: "tmdb:chart:netflix",
  },
  {
    name: "Netflix Kids",
    movieUrl: "tmdb:chart:netflixkids",
    showUrl: "tmdb:chart:netflixkids",
  },
  {
    name: "Paramount+",
    movieUrl: "tmdb:chart:paramount",
    showUrl: "tmdb:chart:paramount",
  },
  {
    name: "Prime Video",
    movieUrl: "tmdb:chart:primevideo",
    showUrl: "tmdb:chart:primevideo",
  },
  {
    name: "Peacock",
    movieUrl: "tmdb:chart:peacock",
    showUrl: "tmdb:chart:peacock",
  },
];

// Builds the static HTML rows for a streaming quick-add panel from one of
// the tables above. `labelSuffix` is appended to the row name (e.g. "Top
function getProviderIconBadge(name, group) {
  const n = (name || '').toLowerCase();
  if (group === 'Combined Charts' || n === 'popular' || n === 'trending' || n.includes('(all services)')) {
    return '<span class="provider-chip-icon" style="background:var(--accent);color:#fff;font-weight:800;font-size:0.7rem;letter-spacing:-0.02em;">ML</span>';
  }
  if (group === 'MDBList Charts' || n.includes('mdblist') || n.includes('streaming charts') || n.includes('moviemeter') || n.includes('us daily')) {
    return '<span class="provider-chip-icon" style="background:#007AFF;color:#fff;font-weight:700;">M</span>';
  }
  if (n.includes('netflix')) return '<span class="provider-chip-icon netflix">N</span>';
  if (n.includes('prime') || n.includes('amazon')) return '<span class="provider-chip-icon prime">P</span>';
  if (n.includes('apple')) return '<span class="provider-chip-icon apple">A</span>';
  if (n.includes('disney')) return '<span class="provider-chip-icon disney">D+</span>';
  if (n.includes('max') || n.includes('hbo')) return '<span class="provider-chip-icon max">M</span>';
  if (n.includes('hulu')) return '<span class="provider-chip-icon hulu">h</span>';
  if (n.includes('paramount')) return '<span class="provider-chip-icon paramount">P+</span>';
  if (n.includes('peacock')) return '<span class="provider-chip-icon peacock">P</span>';
  if (n.includes('discovery')) return '<span class="provider-chip-icon discovery">D</span>';
  if (n.includes('tmdb')) return '<span class="provider-chip-icon" style="background:#01b4e4;color:#fff;">T</span>';
  if (n.includes('trakt')) return '<span class="provider-chip-icon" style="background:#ed1c24;color:#fff;">T</span>';
  if (n.includes('simkl')) return '<span class="provider-chip-icon" style="background:#000;border:1px solid #333;color:#fff;">S</span>';
  if (group === 'Kids') return '<span class="provider-chip-icon" style="background:#FF9900;color:#fff;">K</span>';
  if (group === 'Genres') return '<span class="provider-chip-icon" style="background:#5856D6;color:#fff;">G</span>';
  return '<span class="provider-chip-icon" style="background:#8e8e93;color:#fff;">&#x2605;</span>';
}

function buildStreamingRowsHtml(list, labelSuffix, group) {
  const rows = list.map((p) => {
    const label = labelSuffix ? `${p.name} ${labelSuffix}` : p.name;
    let btns = '';
    // "See All" opens the real, paginated list-details page for this
    // card's own url (see openListDetailsPage, 23_client-list-management.js)
    // -- previously the Discover tab's cards had no preview at all, only
    // the +Movies/+Shows add buttons below. Defaults to the movie side
    // when a card has both; the page itself is single-type, same as
    // every other "See All" in the app.
    let seeAllLink = '';
    if (p.movieUrl && p.showUrl) {
      seeAllLink = `<a href="javascript:void(0)" class="discover-chart-seeall" onclick="openListDetailsPage('${label}', 'movie', '${p.movieUrl}')">See All &rsaquo;</a>`;
      btns = `
        <button type="button" class="lc-btn secondary" onclick="addRow('${label}', '${p.movieUrl}', 'movie', true, '${group}')">+ Movies</button>
        <button type="button" class="lc-btn secondary" onclick="addRow('${label}', '${p.showUrl}', 'series', true, '${group}')">+ Shows</button>`;
    } else if (p.url && p.type) {
      const btnText = p.type === 'movie' ? '+ Movies' : '+ Shows';
      seeAllLink = `<a href="javascript:void(0)" class="discover-chart-seeall" onclick="openListDetailsPage('${p.name}', '${p.type}', '${p.url}')">See All &rsaquo;</a>`;
      btns = `
        <button type="button" class="lc-btn secondary" onclick="addRow('${p.name}', '${p.url}', '${p.type}', true, '${group}')">${btnText}</button>`;
    }
    return `
    <div class="discover-chart-card">
      <div class="discover-chart-header">
        <div class="discover-chart-info">
          <div class="discover-chart-title">${p.name}</div>
          <div class="discover-chart-sub">${labelSuffix ? labelSuffix : (p.type === 'movie' ? 'Theatrical Box Office' : (p.type === 'series' ? 'Anime Trending' : 'Movies & Shows'))}</div>
        </div>
        ${seeAllLink}
      </div>
      <div class="discover-chart-btns">
        ${btns}
      </div>
    </div>`;
  }).join("");
  return `<div class="quick-grid">${rows}</div>`;
}

function buildStreamingTop10Html() {
  return buildStreamingRowsHtml(STREAMING_TOP10, "Top 10", "Streaming Top 10");
}

function buildStreamingHtml() {
  return buildStreamingRowsHtml(STREAMING_ALL, "", "Streaming");
}

// --- mdblist Charts: mdblist's own real Official Lists ---------------------
//
// mdblist.com DOES run its own distinct official-charts system, separate
// from community lists -- see https://mdblist.com/lists/official. These
// live at a different URL shape (/lists/official/{movies|shows}/{slug},
// one segment deeper than a normal user list at /lists/{user}/{slug}),
// which mdblistJsonUrl above handles by preserving however many path
// segments are given rather than assuming exactly two.
// TO ADD OR CHANGE A LINK: edit the matching row below.
const MDBLIST_OFFICIAL_CHARTS = [
  {
    name: "MDBList Popular",
    movieUrl: "https://mdblist.com/lists/official/movies/popular",
    showUrl: "https://mdblist.com/lists/official/shows/popular",
  },
  {
    name: "US Daily Streaming Charts",
    movieUrl: "https://mdblist.com/lists/official/movies/justwatch-streaming-charts",
    showUrl: "https://mdblist.com/lists/official/shows/justwatch-streaming-charts",
  },
  {
    name: "Streaming Charts (Extended)",
    movieUrl: "https://mdblist.com/lists/official/movies/streaming-charts",
    showUrl: "https://mdblist.com/lists/official/shows/streaming-charts",
  },
  {
    name: "IMDb MovieMeter",
    movieUrl: "https://mdblist.com/lists/official/movies/moviemeter",
    showUrl: "https://mdblist.com/lists/official/shows/moviemeter",
  },
];

function buildMdblistChartsHtml() {
  return buildStreamingRowsHtml(MDBLIST_OFFICIAL_CHARTS, "", "MDBList Charts");
}

// --- TMDB / Trakt official charts (one-click quick-adds) -------------------
//
// Unlike the Trending/Popular/etc panels above (each backed by a real,
// community-curated mdblist.com list), these use small sentinel "URLs"
// (tmdb:chart:X / trakt:chart:X) that detectSource/fetchCatalog recognize
// and route to fetchTmdbChart/fetchTraktChart -- hitting TMDB's and Trakt's
// own official chart endpoints directly instead of a third party's list.
// The same sentinel is reused for both the Movies and Shows button on a
// row; entry.type (set by which button was clicked) picks the right side
// of that chart's path map at fetch time.
const TMDB_CHART_LISTS = [
  { name: "New Releases", movieUrl: "tmdb:chart:new_movies", showUrl: "tmdb:chart:new_shows" },
  { name: "TMDB Trending", movieUrl: "tmdb:chart:trending", showUrl: "tmdb:chart:trending" },
  { name: "TMDB Popular", movieUrl: "tmdb:chart:popular", showUrl: "tmdb:chart:popular" },
  { name: "TMDB Top Rated", movieUrl: "tmdb:chart:top_rated", showUrl: "tmdb:chart:top_rated" },
  { name: "TMDB Now Playing", movieUrl: "tmdb:chart:now_playing", showUrl: "tmdb:chart:now_playing" },
  { name: "TMDB Upcoming", movieUrl: "tmdb:chart:upcoming", showUrl: "tmdb:chart:upcoming" },
];

// All of Trakt's official charts below (see TRAKT_CHART_PATHS/
// fetchTraktChart), pulled directly from Trakt's own API. These used to
// point at community-curated mdblist.com lists mirroring Trakt's charts
// instead, because Trakt's API had started rejecting this add-on's shared
// Client ID with a 403 ("invalid or unapproved app") -- that Client ID has
// since been replaced, so these go straight to Trakt's API again. If it
// happens again, the Worker owner needs a fresh app from
// https://trakt.tv/oauth/applications, or a person can supply their own
// Client ID in the meantime (see the Trakt Client ID box above).
const TRAKT_CHART_LISTS = [
  { name: "Trakt Trending", movieUrl: "trakt:chart:trending", showUrl: "trakt:chart:trending" },
  { name: "Trakt Popular", movieUrl: "trakt:chart:popular", showUrl: "trakt:chart:popular" },
  { name: "Trakt Most Played", movieUrl: "trakt:chart:most_played", showUrl: "trakt:chart:most_played" },
  { name: "Trakt Most Watched", movieUrl: "trakt:chart:most_watched", showUrl: "trakt:chart:most_watched" },
  { name: "Trakt Most Collected", movieUrl: "trakt:chart:most_collected", showUrl: "trakt:chart:most_collected" },
  { name: "Trakt Most Favorited", movieUrl: "trakt:chart:most_favorited", showUrl: "trakt:chart:most_favorited" },
  {
    name: "Trakt Most Anticipated",
    movieUrl: "trakt:chart:most_anticipated",
    showUrl: "trakt:chart:most_anticipated",
  },
];

// Weekly box-office gross is inherently a theatrical-movies concept -- no
// shows equivalent, so this is a single-button (movies-only) row like In
// Theaters above, not a movies+shows pair.
const TRAKT_BOXOFFICE_LIST = [
  { name: "Trakt Box Office", url: "trakt:chart:box_office", type: "movie" },
];

const SIMKL_CHART_LISTS = [
  { name: "Simkl Trending Today", movieUrl: "simkl:chart:today", showUrl: "simkl:chart:today" },
  { name: "Simkl Trending This Week", movieUrl: "simkl:chart:week", showUrl: "simkl:chart:week" },
  { name: "Simkl Trending This Month", movieUrl: "simkl:chart:month", showUrl: "simkl:chart:month" },
];

// Simkl tracks anime as its own category, mixing movies and series together
// rather than splitting them the way its movies/tv charts do -- so this is
// a single-button row (like Trakt Box Office above), added as Shows since
// most of what shows up here is ongoing series rather than standalone films.
const SIMKL_ANIME_LIST = [
  { name: "Simkl Anime Trending", url: "simkl:chart:anime-week", type: "series" },
];

function buildTmdbChartsHtml() {
  return buildStreamingRowsHtml(TMDB_CHART_LISTS, "", "TMDB Charts");
}

function buildTraktChartsHtml() {
  return buildStreamingRowsHtml([...TRAKT_CHART_LISTS, ...TRAKT_BOXOFFICE_LIST], "", "Trakt Charts");
}

function buildSimklChartsHtml() {
  return buildStreamingRowsHtml([...SIMKL_CHART_LISTS, ...SIMKL_ANIME_LIST], "", "Simkl Charts");
}

// --- Combined charts (blend multiple sources into one shelf) ---------------
//
// Reuses the exact same multi-source merge mechanism as the "+ Add another
// source" button on a manually built row (see fetchMergedCatalog): a row's
// entry.url can hold several newline-separated sources, fetched in
// parallel and deduped by IMDB id (first-listed source wins on a tie).
// These quick-adds just pre-fill that merge -- either the same chart from
// each of MDBList/TMDB/Trakt, or every streaming service's Top 10/catalog
// at once -- instead of making someone add each source by hand.
const COMBINED_CHART_LISTS = [
  {
    name: "Popular",
    movieUrls: [
      "https://mdblist.com/lists/official/movies/popular",
      "tmdb:chart:popular",
      "trakt:chart:popular",
    ],
    showUrls: [
      "https://mdblist.com/lists/official/shows/popular",
      "tmdb:chart:popular",
      "trakt:chart:popular",
    ],
  },
  {
    name: "Trending",
    // MDBList's official lists don't include a "Trending" chart of their
    // own (just Popular / JustWatch streaming charts / IMDb MovieMeter),
    // so this blends TMDB + Trakt + all three Simkl trending windows
    // (same simkl:chart:today/week/month URLs as SIMKL_CHART_LISTS above,
    // each dispatches to movies or shows at fetch time based on the
    // merged row's own type -- same one URL works for both movieUrls and
    // showUrls here for that reason).
    movieUrls: ["tmdb:chart:trending", "trakt:chart:trending", "simkl:chart:today", "simkl:chart:week", "simkl:chart:month"],
    showUrls: ["tmdb:chart:trending", "trakt:chart:trending", "simkl:chart:today", "simkl:chart:week", "simkl:chart:month"],
  },
  {
    // Every service's Top 10 (see STREAMING_TOP10 above) merged into one
    // shelf -- computed from that same table rather than duplicated here,
    // so adding/removing a service there keeps this in sync automatically.
    name: "Streaming Top 10 (All Services)",
    movieUrls: STREAMING_TOP10.map((s) => s.movieUrl),
    showUrls: STREAMING_TOP10.map((s) => s.showUrl),
  },
  {
    // Every service's full catalog (see STREAMING_ALL above) merged into
    // one shelf -- same sync-from-the-table approach as above.
    name: "Streaming (All Services)",
    movieUrls: STREAMING_ALL.map((s) => s.movieUrl),
    showUrls: STREAMING_ALL.map((s) => s.showUrl),
  },
];

// Renders each source list as a single-quoted JS array literal (e.g.
// ['a','b']) so it can sit inside an onclick="..." attribute -- which is
// itself double-quoted -- without the two colliding.
function jsStringArrayLiteral(arr) {
  return "[" + arr.map((s) => "'" + String(s).replace(/'/g, "\\'") + "'").join(",") + "]";
}

function buildCombinedChartsHtml() {
  const rows = COMBINED_CHART_LISTS.map((p) => {
    const movieUrlsJoined = p.movieUrls.join("\\n");
    return `
    <div class="discover-chart-card">
      <div class="discover-chart-header">
        <div class="discover-chart-info">
          <div class="discover-chart-title">${p.name}</div>
          <div class="discover-chart-sub">Blended Multi-Source Catalog</div>
        </div>
        <a href="javascript:void(0)" class="discover-chart-seeall" onclick="openListDetailsPage('${p.name}', 'movie', '${movieUrlsJoined}')">See All &rsaquo;</a>
      </div>
      <div class="discover-chart-btns">
        <button type="button" class="lc-btn secondary" onclick="addCombinedRow('${p.name}', ${jsStringArrayLiteral(p.movieUrls)}, 'movie', 'Combined Charts')">+ Movies</button>
        <button type="button" class="lc-btn secondary" onclick="addCombinedRow('${p.name}', ${jsStringArrayLiteral(p.showUrls)}, 'series', 'Combined Charts')">+ Shows</button>
      </div>
    </div>`;
  }).join("");
  return `<div class="quick-grid">${rows}</div>`;
}

// Generates the client-side addAllCombinedCharts() function body straight
// from COMBINED_CHART_LISTS -- the individual "+ Movies"/"+ Shows"
// buttons on each row already get their (baked-in, hand-copy-free) source
// arrays this same way via jsStringArrayLiteral (see buildCombinedChartsHtml
// above). "Add all" used to be a second, hand-maintained copy of this same
// data that referenced STREAMING_TOP10/STREAMING_ALL directly -- both of
// which are server-side-only constants with no client-side equivalent, so
// clicking "Add all" threw a ReferenceError partway through (right after
// the hardcoded Popular/Trending/Streaming-Top-10-movies entries, which
// happened to not need those variables) and silently never added Streaming
// Top 10 Shows or Streaming (All Services) at all. Generating this
// function from the same single source of truth as the per-row buttons
// fixes that and makes a repeat impossible. Evaluated here at template-
// render time (this is a genuine top-level function, not text sitting
// inside the client-script template literal), so its ${...} use below is
// just an ordinary interpolation producing static text -- like
// combinedChartsHtml above, not a client-side call.
function buildAddAllCombinedChartsJs() {
  const calls = COMBINED_CHART_LISTS.map(function (p) {
    const nameLit = "'" + String(p.name).replace(/'/g, "\\'") + "'";
    return "  addCombinedRow(" + nameLit + ", " + jsStringArrayLiteral(p.movieUrls) + ", 'movie', 'Combined Charts');\n" +
           "  addCombinedRow(" + nameLit + ", " + jsStringArrayLiteral(p.showUrls) + ", 'series', 'Combined Charts');";
  }).join("\n");
  return "function addAllCombinedCharts() {\n" + calls + "\n  saveState();\n}";
}

// Same fix, generalized to the other six quick-add panels: each panel's
// individual "+ Movies"/"+ Shows"/"+ Add" buttons already build their
// addRow() calls from a data table (via buildStreamingRowsHtml /
// buildSimpleListRowsHtml above) -- Add All used to be a second,
// hand-typed copy of each table instead of reading from it, and one of
// them (Streaming Top 10) had silently drifted to drop the "Top 10"
// suffix from every row's name (Netflix Top 10 -> just "Netflix") since
// nothing kept the two copies in sync. Generating all of them from their
// tables here, the same way Combined Charts' Add All does above, closes
// that off for good instead of just patching the one that had drifted.
function buildAddAllPairsCallsJs(list, group, labelSuffix) {
  return list.map(function (p) {
    const label = labelSuffix ? p.name + " " + labelSuffix : p.name;
    return "  addRow(" + JSON.stringify(label) + ", " + JSON.stringify(p.movieUrl) + ", 'movie', true, " + JSON.stringify(group) + ");\n" +
           "  addRow(" + JSON.stringify(label) + ", " + JSON.stringify(p.showUrl) + ", 'series', true, " + JSON.stringify(group) + ");";
  }).join("\n");
}
function buildAddAllSimpleCallsJs(list, group) {
  return list.map(function (l) {
    return "  addRow(" + JSON.stringify(l.name) + ", " + JSON.stringify(l.url) + ", " + JSON.stringify(l.type) + ", true, " + JSON.stringify(group) + ");";
  }).join("\n");
}
function buildAddAllFnJs(fnName, callsJs) {
  return "function " + fnName + "() {\n" + callsJs + "\n  saveState();\n}";
}

// Discovery shelf for "I don't know what to watch" -- see fetchTmdbHiddenGems.
const HIDDEN_GEMS_LIST = [
  { name: "Hidden Gems", movieUrl: "tmdb:hidden-gems", showUrl: "tmdb:hidden-gems" },
];

function buildHiddenGemsHtml() {
  return buildStreamingRowsHtml(HIDDEN_GEMS_LIST, "", "Hidden Gems");
}

const KIDS_LISTS = [
  { name: "Rated G & Under", movieUrl: "tmdb:kids:g", showUrl: "tmdb:kids:g" },
  { name: "Rated PG & Under", movieUrl: "tmdb:kids:pg", showUrl: "tmdb:kids:pg" },
  { name: "Rated PG-13 & Under", movieUrl: "tmdb:kids:pg13", showUrl: "tmdb:kids:pg13" },
  { name: "Netflix Kids", movieUrl: "tmdb:chart:netflixkids", showUrl: "tmdb:chart:netflixkids" },
];
function buildKidsHtml() {
  return buildStreamingRowsHtml(KIDS_LISTS, "", "Kids");
}

const HOLIDAY_LISTS = [
  { name: "Christmas", movieUrl: "tmdb:holiday:christmas", showUrl: "tmdb:holiday:christmas" },
  { name: "Easter", movieUrl: "tmdb:holiday:easter", showUrl: "tmdb:holiday:easter" },
  { name: "Fourth of July", movieUrl: "tmdb:holiday:july4", showUrl: "tmdb:holiday:july4" },
  { name: "Halloween", movieUrl: "tmdb:holiday:halloween", showUrl: "tmdb:holiday:halloween" },
  { name: "New Year’s Eve", movieUrl: "tmdb:holiday:newyear", showUrl: "tmdb:holiday:newyear" },
  { name: "Thanksgiving", movieUrl: "tmdb:holiday:thanksgiving", showUrl: "tmdb:holiday:thanksgiving" },
  { name: "Valentine’s Day", movieUrl: "tmdb:holiday:valentine", showUrl: "tmdb:holiday:valentine" },
];
function buildHolidaysHtml() {
  return buildStreamingRowsHtml(HOLIDAY_LISTS, "", "Holidays");
}

const GENRE_LISTS = [
  { name: "Family", movieUrl: "tmdb:genre:family", showUrl: "tmdb:genre:family" },
  { name: "Fantasy", movieUrl: "tmdb:genre:fantasy", showUrl: "tmdb:genre:fantasy" },
  { name: "History", movieUrl: "tmdb:genre:history", showUrl: "tmdb:genre:history" },
  { name: "Horror", movieUrl: "tmdb:genre:horror", showUrl: "tmdb:genre:horror" },
  { name: "Mystery", movieUrl: "tmdb:genre:mystery", showUrl: "tmdb:genre:mystery" },
  { name: "Romance", movieUrl: "tmdb:genre:romance", showUrl: "tmdb:genre:romance" },
  { name: "Science Fiction", movieUrl: "tmdb:genre:science-fiction", showUrl: "tmdb:genre:science-fiction" },
  { name: "Stream Releases", movieUrl: "tmdb:genre:stream-releases", showUrl: "tmdb:genre:stream-releases" },
  { name: "Thriller", movieUrl: "tmdb:genre:thriller", showUrl: "tmdb:genre:thriller" },
  { name: "War", movieUrl: "tmdb:genre:war", showUrl: "tmdb:genre:war" },
  { name: "Western", movieUrl: "tmdb:genre:western", showUrl: "tmdb:genre:western" },
];
function buildGenresHtml() {
  return buildStreamingRowsHtml(GENRE_LISTS, "", "Genres");
}

// --- Clean, shareable /lists/<slug> urls for every native/official chart ---
//
// "TMDB Trending" -> "TMDB-Trending" -- title case preserved, everything
// that isn't a letter/number collapsed to a single hyphen. Used both to
// build CHART_SLUG_REGISTRY below (server-side lookup for the /lists/<slug>
// route) and embedded into the client script as CHART_SLUG_ENTRIES (see
// renderBuilder, 09_page-shell.js) so openListDetailsPage
// (23_client-list-management.js) can push this same clean path instead of
// the old #/list?name=...&url=... hash whenever the list being opened is
// one of these known charts.
function slugifyChartName(name) {
  return String(name || "").trim().replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// A flat array (not just the slug-keyed object below) because the client
// needs to search it the other direction too -- "is this listUrl one of
// our known charts, and if so what's its slug" -- which is an array scan
// either way there's no single key to look up by.
const CHART_SLUG_ENTRIES = (() => {
  const seenSlugs = new Set();
  const entries = [];
  function add(name, movieUrl, showUrl) {
    if (!name || !movieUrl) return;
    const slug = slugifyChartName(name);
    // First one wins on a naming clash (e.g. "Trending" appears in both
    // COMBINED_CHART_LISTS and could in principle appear elsewhere) --
    // silently skipping the rest is safer than one table's entry
    // overwriting another's further down this list.
    if (!slug || seenSlugs.has(slug)) return;
    seenSlugs.add(slug);
    entries.push({ slug, name, movieUrl, showUrl: showUrl || movieUrl });
  }
  [
    ...MDBLIST_OFFICIAL_CHARTS,
    ...TMDB_CHART_LISTS,
    ...TRAKT_CHART_LISTS,
    ...SIMKL_CHART_LISTS,
    ...STREAMING_TOP10,
    ...STREAMING_ALL,
    ...HIDDEN_GEMS_LIST,
    ...KIDS_LISTS,
    ...HOLIDAY_LISTS,
    ...GENRE_LISTS,
  ].forEach((p) => add(p.name, p.movieUrl, p.showUrl));
  [...TRAKT_BOXOFFICE_LIST, SIMKL_ANIME_LIST[0]].forEach((p) => add(p.name, p.url, p.url));
  COMBINED_CHART_LISTS.forEach((p) => add(p.name, p.movieUrls.join("\n"), p.showUrls.join("\n")));
  return entries;
})();

const CHART_SLUG_REGISTRY = Object.fromEntries(CHART_SLUG_ENTRIES.map((e) => [e.slug, e]));

// Used by the /lists/<slug> route (25_api-catalog-routes.js) -- returns
// null on an unknown slug rather than throwing, since a stale or
// hand-edited link should land the visitor in the app (default view)
// rather than a hard error.
function resolveChartSlug(slug) {
  return CHART_SLUG_REGISTRY[slug] || null;
}


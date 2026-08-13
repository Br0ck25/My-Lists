# build.ps1 — Rebuilds worker_entry_combined.js from the numbered split files.
# Run this any time you edit a split file:  .\build.ps1

$dir    = $PSScriptRoot
$output = Join-Path $dir "worker_entry_combined.js"

$header = @'
/**
 * my-list-addon
 *
 * A stateless wako/Stremio-protocol add-on that turns mdblist.com,
 * trakt.tv, and themoviedb.org list URLs into catalog rows on the home
 * screen.
 *
 * How it works:
 *  - Config (the list URLs a user wants, their order, and their optional
 *    personal API keys) is base64url-encoded directly into the install URL.
 *    No database, no server-side auth, nothing to run besides this Worker.
 *  - MDBList private lists and "My Watchlist" need an MDBList API key.
 *    Same deal: users paste their own in the builder page, or the Worker
 *    owner can set a fallback MDBLIST_API_KEY below. Public mdblist.com
 *    lists work fine with no key at all.
 *  - Public trakt.tv lists (https://trakt.tv/users/USER/lists/LIST-SLUG)
 *    are supported too. Trakt requires a Client ID (their term for an API
 *    key) on every request, even for public lists — this Worker uses a
 *    single fixed TRAKT_CLIENT_ID (below) for all users; there's no
 *    per-user override in the builder page.
 *  - Public themoviedb.org lists (https://www.themoviedb.org/list/LIST_ID)
 *    are supported too, the same fixed-key way as Trakt (TMDB_API_KEY
 *    below). TMDB list items only carry a TMDB id, so each item needs an
 *    extra external_ids lookup to resolve its IMDB id — those lookups are
 *    throttled and cached hard at Cloudflare's edge to stay well under
 *    TMDB's soft per-IP connection limit.
 *  - GET /                            -> builder page (fresh install, external browser)
 *  - GET /:config/configure           -> same builder, pre-filled, meant to be
 *                                        opened inside wako's own "Configure"
 *                                        screen for an installed add-on
 *  - GET /:config/manifest.json       -> wako/Stremio manifest, one catalog per list.
 *                                        If opened as a *page load* (browser
 *                                        navigation, e.g. via wako's Configure
 *                                        button) it redirects to /:config/configure
 *                                        instead of dumping raw JSON.
 *  - GET /:config/catalog/:type/:id.json -> catalog items, pulled live from mdblist
 *  - GET /api/toplists                -> proxies mdblist.com's Popular Lists
 *                                        (https://mdblist.com/toplists/) so the
 *                                        builder page can offer them as one-click adds
 *  - GET /icon.png                    -> add-on icon, served from this Worker
 *
 * Deploy with `wrangler deploy` or paste directly into the Cloudflare dashboard.
 * No environment variables or bindings required.
 */

'@

# Gather split files in numeric order (00_ ... 26_), exclude the combined output itself.
$parts = Get-ChildItem -Path $dir -Filter "*.js" |
         Where-Object { $_.Name -match '^\d{2}_' } |
         Sort-Object Name

if (-not $parts) {
    Write-Error "No numbered split files found in $dir"
    exit 1
}

Write-Host "Building worker_entry_combined.js from $($parts.Count) files..."

# Write header then append each split file (UTF-8 no BOM).
$encoding = New-Object System.Text.UTF8Encoding($false)  # $false = no BOM
$writer   = [System.IO.StreamWriter]::new($output, $false, $encoding)

try {
    $writer.Write($header)

    foreach ($part in $parts) {
        Write-Host "  + $($part.Name)"
        $content = [System.IO.File]::ReadAllText($part.FullName, $encoding)
        $writer.Write($content)
        # Ensure each file ends with a newline before the next one begins.
        if (-not $content.EndsWith("`n")) {
            $writer.WriteLine()
        }
    }
} finally {
    $writer.Close()
}

$lineCount = (Get-Content $output).Count
$sizeKB    = [Math]::Round((Get-Item $output).Length / 1KB, 1)
Write-Host ""
Write-Host "Done!  worker_entry_combined.js  ($lineCount lines, $sizeKB KB)" -ForegroundColor Green

# My Lists Addon

A powerful, self-hosted [Stremio](https://stremio.com) and [wako](https://wako.app) add-on that transforms your **MDBList**, **Trakt**, **TMDB**, and **Simkl** lists into dynamic catalog rows on your home screen — featuring a full **Custom List Builder**, **Letterboxd CSV Import**, **Virtual TV Channels**, **Continue Watching & Watch History Sync**, **Creator Profiles**, and an **Admin Analytics Dashboard**, all running on a single free [Cloudflare Workers](https://workers.cloudflare.com) deployment.

There are no servers to manage, no external databases required, and no subscription fees. Your configuration is encoded directly into your install link or securely synchronized via your own private Cloudflare KV storage.

---

## 🌟 Key Features

### 📺 Multi-Provider Catalog Engine
- **MDBList**: Turn public or private MDBList URLs and personal watchlists into catalog rows. Includes one-click browsing of MDBList Toplists and popular charts.
- **Trakt**: Full support for public lists, personal lists, liked lists, watchlists, collections, recommendations, and trending/popular charts. Includes OAuth login and TV/console Device Code authentication (`/api/trakt/device/code`).
- **TheMovieDB (TMDB)**: Support for TMDB v3/v4 lists, user lists, keyword/genre/network/company charts, search, and automated TMDB-to-IMDb external ID resolution.
- **Simkl**: Trending charts across Movies, TV Shows, and Anime (Daily, Weekly, Monthly), plus OAuth account linking for personal list and history import.

### ⚡ Discover & Quick Add Shelves
- One-click catalog shortcuts for major streaming platforms (Netflix, Disney+, Prime Video, Apple TV+, Max, Hulu, Paramount+, Peacock, Anime, etc.).
- Curated collections, award winners, box office hits, and trending lists built right into the configuration UI.

### 🛠️ Custom List Builder & Letterboxd Import
- **Build from scratch**: Search movies and shows across TMDB to create custom catalogs.
- **Letterboxd CSV Import**: Upload your Letterboxd export CSVs and automatically batch-resolve titles and release years into IMDb/TMDB IDs (`/api/bulk-resolve`).
- **List Sharing & Directory**: Publish your custom lists to the community directory, clone public lists, and like community catalogs.

### 📡 Virtual TV Channel Builder
- Create synthetic linear TV channels and scheduled playlists combining hand-picked episodes from different TV shows and whole movies into a single row.
- Built-in channel logo generator, custom poster rendering (`/api/channel-poster`), and quick-add channel presets.

### ⏱️ Continue Watching & Background Watch Sync
- Automatically tracks watch progress and next unwatched episode per show.
- Mark titles as watched/unwatched directly from the UI or scrobble integrations.
- **Scheduled Cron Worker**: Automatically queries TMDB every 6 hours via Cloudflare Cron Triggers (`0 */6 * * *`) to find newly-aired episodes for caught-up shows and push them to Continue Watching.

### 👤 Creator Profiles & Cloud Sync
- Free, passwordless account system secured by salted SHA-256 Creator Keys (`CRTR-...`).
- Synchronize your catalogs, custom lists, channels, presets, likes, and watch history across all your browsers and devices.

### 📊 Admin Dashboard (`/admin`)
- Password-protected stats and management dashboard with session authentication (`ADMIN_KEY`).
- Real-time telemetry: page views, installs, and live API usage counters for TMDB, Trakt, MDBList, and Simkl.
- Catalog leaderboards and community feedback/issue tracking inbox (open/in-progress/closed).
- Streaming provider lookup and Netflix catalog preview inspector.

### 📱 Progressive Web App (PWA)
- Installable PWA with offline caching (`/sw.js`), modern web app manifest (`/app.webmanifest`), dark mode UI, clipboard shortcuts, and QR code sharing.
- Stremio & wako protocol compliance (Manifest v3, catalog pagination, stream/subtitle routing, shelf/item shuffling).

---

## 📋 Requirements

- A free [Cloudflare](https://dash.cloudflare.com/sign-up) account.
- **Optional**: Free API keys/OAuth apps from TMDB, Trakt, Simkl, or MDBList to unlock specific list providers.
- **Zero build dependencies**: The entire add-on runs from `worker_entry_combined.js`.

---

## 🚀 Installation & Deployment

### Step 1 — Create the Cloudflare Worker

1. Log into your [Cloudflare Dashboard](https://dash.cloudflare.com).
2. In the sidebar, navigate to **Workers & Pages**.
3. Click **Create** &rarr; **Create Worker**.
4. Name your worker (e.g. `my-lists`) and click **Deploy**.

### Step 2 — Deploy the Add-on Code

1. On your Worker's overview page, click **Edit code** (Quick Edit).
2. Delete the default template code.
3. Copy the entire contents of [`worker_entry_combined.js`](file:///c:/Users/James/Downloads/My%20Lists%20Addon/My%20Lists%20Addon%20Beta/worker_entry_combined.js) and paste it into the editor.
4. Click **Deploy** (or **Save and Deploy**).

> **Note**: Your add-on is now immediately operational at `https://your-worker-name.your-subdomain.workers.dev`!

---

### Step 3 — (Recommended) Enable Cloudflare KV Storage

KV storage is required for Creator Profiles (cloud sync), short install links, Custom Lists, Channels, Admin analytics, and Feedback storage:

1. In Cloudflare Dashboard, go to **Storage & Databases** &rarr; **KV**.
2. Click **Create namespace** and name it (e.g., `my-lists-kv`).
3. Return to your Worker &rarr; **Settings** &rarr; **Variables and Bindings**.
4. Under **KV Namespace Bindings**, click **Add binding**:
   - **Variable name**: `CONFIGS` *(must match exactly)*
   - **KV namespace**: Select the namespace created in step 2.
5. Click **Save and deploy**.

---

### Step 4 — (Optional) Add API Keys & OAuth Credentials

The add-on works out-of-the-box with public MDBList and TMDB links. Adding API keys unlocks external accounts, private lists, and richer metadata.

Add these under **Settings** &rarr; **Variables and Bindings** &rarr; **Add** &rarr; **Secret** (or Text):

| Variable / Secret | Description & Feature Unlocked | Source / Where to obtain |
|---|---|---|
| `TMDB_API_KEY` | TMDB lists, episode/season data, search, recommendations, artwork, bulk movie resolution | [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api) (*API Key (v3 auth)*) |
| `TRAKT_CLIENT_ID` | Trakt public lists, search, trending/popular charts, recommendations | [trakt.tv/oauth/applications](https://trakt.tv/oauth/applications) |
| `TRAKT_CLIENT_SECRET` | Trakt OAuth account login, Device Code authentication, private lists & watch history export | Same Trakt app as above |
| `SIMKL_CLIENT_ID` | Simkl trending charts (Movies, TV, Anime) and OAuth login | [simkl.com/settings/developer](https://simkl.com/settings/developer/) |
| `SIMKL_CLIENT_SECRET` | Simkl OAuth token exchange for private lists and history sync | Same Simkl app as above |
| `MDBLIST_API_KEY` | Private MDBList lists, Watchlist quick-add fallback, history sync | [mdblist.com/preferences](https://mdblist.com/preferences) |
| `MDBLIST_POPULAR_KEY` | Dedicated key for MDBList Toplists / Popular Lists browser | Same MDBList preferences as above |
| `MDBLIST_CLIENT_ID` | MDBList OAuth client ID | [mdblist.com/preferences](https://mdblist.com/preferences) |

#### OAuth Redirect URIs
If you configure OAuth authentication for Trakt, Simkl, MDBList, or TMDB, set the OAuth callback URLs in their respective developer portals to:
- **Trakt**: `https://your-worker-name.your-subdomain.workers.dev/api/trakt/oauth/callback`
- **Simkl**: `https://your-worker-name.your-subdomain.workers.dev/api/simkl/oauth/callback`
- **MDBList**: `https://your-worker-name.your-subdomain.workers.dev/api/mdblist/oauth/callback`
- **TMDB**: `https://your-worker-name.your-subdomain.workers.dev/api/tmdb/oauth/callback`

---

### Step 5 — (Optional) Configure Admin Dashboard

To access the `/admin` telemetry and management console:
1. Under Worker **Settings** &rarr; **Variables and Bindings** &rarr; **Add** &rarr; **Secret**, create:
   - **Variable name**: `ADMIN_KEY`
   - **Value**: A secure password/passphrase of your choice.
2. Visit `https://your-worker-name.your-subdomain.workers.dev/admin` to log in.

---

### Step 6 — (Optional) Set Up Continue Watching Cron Trigger

To automatically check for newly-aired episodes every 6 hours for users with a Creator Profile:
1. In your Worker dashboard, navigate to **Triggers** &rarr; **Cron Triggers**.
2. Click **Add Cron Trigger**.
3. Set the cron expression to: `0 */6 * * *` (every 6 hours).
4. Click **Save**.

---

### Step 7 — Install in Stremio or wako

1. Open your deployed worker URL in a browser: `https://your-worker-name.your-subdomain.workers.dev`
2. Add your favorite lists, connect accounts, customize channels, or configure streaming quick-add shelves.
3. Click **Install Addon** to copy your personal manifest URL or install directly into Stremio/wako.
4. If you reconfigure later via wako or the configure page, your catalogs update instantly.

---

## 📂 Project Structure & Build Pipeline

The codebase is organized into modular ES modules that compile into a single `worker_entry_combined.js` file:

```
.
├── 00_constants.js                     # Versioning, addon constants, and API key globals
├── 01_icon-asset.js                     # Embedded Base64 addon icon
├── 02_http-and-creator-utils.js         # CORS, JSON helpers, crypto, creator auth & hashing
├── 03_admin.js                          # Admin counters, telemetry, and API usage stats
├── 04_config-resolution.js              # Config decoding (Base64 URL & KV short links)
├── 05_catalog-core.js                   # Stremio/wako manifest generation & catalog logic
├── 06_source-fetchers-mdblist-trakt.js  # MDBList & Trakt API data fetching & pagination
├── 07_source-fetchers-tmdb-simkl.js     # TMDB & Simkl API fetching, episode cron checker
├── 08_quickadd-chart-data.js            # Preconfigured streaming service & chart metadata
├── 09_page-shell.js                     # Web app HTML shell, header, PWA meta tags & CSS
├── 10_tab-search-add.js                 # Catalogs tab HTML
├── 11_tab-quick-add.js                  # Discover & Quick Add tab HTML
├── 12_tab-custom-lists.js               # Custom Lists builder tab HTML
├── 13_tab-channels.js                   # Virtual TV Channels tab HTML
├── 14_tab-presets-backup.js             # Presets & Backup tab HTML
├── 15_tab-settings-html.js              # Account, API keys, sync, and preferences UI
├── 16_client-row-core.js                # Core client runtime, router, state & DOM helpers
├── 17_client-my-lists-and-trakt-oauth.js# Trakt & MDBList account integration & OAuth UI
├── 18_client-copy-and-trakt-export.js   # List cloning, deep-linking, and Trakt export
├── 19_client-search-and-likes.js        # Discover search, filters, and community likes
├── 20_client-channel-builder.js         # Client-side Virtual Channel creator & preview
├── 21_client-custom-list-builder.js     # Client-side Custom List builder & Letterboxd import
├── 22_client-creator-profile.js         # Client-side Creator Profile management & sync
├── 23_client-list-management.js         # Catalog reordering, toggles, and deletion
├── 24_client-backup-restore-presets.js  # JSON backup/restore, short link & QR code logic
├── 25_api-catalog-routes.js             # HTTP router: manifests, catalogs, search & OAuth
├── 26_api-creator-and-admin-routes.js   # HTTP router: creator sync, admin API & worker export
├── build.ps1                            # PowerShell script to bundle modules into worker_entry_combined.js
├── worker_entry_combined.js             # Standalone production Cloudflare Worker bundle
├── Changes.md                           # Development modification log
└── README.md                            # Project documentation
```

### Building the Combined Worker

When editing any individual split file (`00_` through `26_`), run the PowerShell build script to rebuild `worker_entry_combined.js`:

```powershell
.\build.ps1
```

---

## 🛠️ API & Endpoint Reference

| Endpoint | Method | Description |
|---|---|---|
| `/` | `GET` | Main configuration web app & PWA builder |
| `/:config/configure` | `GET` | Builder interface pre-populated with existing configuration |
| `/:config/manifest.json` | `GET` | Stremio / wako Addon Manifest (redirects to `/configure` in browser) |
| `/:config/catalog/:type/:id.json`| `GET` | Catalog item feed with pagination (`skip=`) support |
| `/api/title-search` | `GET` | Search movies and TV shows via TMDB |
| `/api/bulk-resolve` | `POST` | Batch resolve movie title/year pairs to IMDb IDs (Letterboxd import) |
| `/api/show-seasons` | `GET` | Fetch season lists for a TV show |
| `/api/show-episodes` | `GET` | Fetch episode lists for a specific season |
| `/api/toplists` | `GET` | Fetch popular MDBList toplists |
| `/api/trakt-popular-lists` | `GET` | Fetch trending and popular Trakt lists |
| `/api/recommendations` | `POST` | Fetch TMDB recommendations for selected titles |
| `/api/trakt/device/code` | `POST` | Generate Trakt TV / Device Code login flow |
| `/api/trakt/device/token` | `POST` | Poll Trakt device token status |
| `/api/creator/*` | `POST` | Creator Profile authentication, list management, and cloud sync |
| `/admin` | `GET` | Admin analytics dashboard UI |
| `/admin/api/*` | `GET/POST` | Admin analytics, API usage counters, leaderboard & feedback API |
| `/sw.js` | `GET` | Service worker for offline PWA support |
| `/app.webmanifest` | `GET` | Web App Manifest for mobile/desktop PWA installation |

---

## ❓ Troubleshooting

- **"MDBList Toplists / Popular Lists not configured"**: Set the `MDBLIST_POPULAR_KEY` or `MDBLIST_API_KEY` secret.
- **"Trakt lists not configured"**: Set the `TRAKT_CLIENT_ID` environment secret.
- **"TMDB lookup / episode browsing not working"**: Set the `TMDB_API_KEY` environment secret.
- **"Cannot save lists / Creator Profiles not working"**: Ensure the KV Namespace binding is named exactly `CONFIGS`.
- **"Admin dashboard authentication failed"**: Ensure `ADMIN_KEY` is configured as a Secret and KV storage is bound.
- **"Continue Watching not updating with new episodes"**: Verify that the Cron Trigger (`0 */6 * * *`) is configured under Worker Triggers and `TMDB_API_KEY` is set. Note that cron updates apply to users with Creator Profiles.

---

## 📄 License

MIT License. Designed for personal, self-hosted use.

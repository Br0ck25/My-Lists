# My Lists Addon

> **Official Website & Live Web App**: [**mylistsaddon.com**](https://mylistsaddon.com)
> **Source Code**: [**github.com/Br0ck25/My-Lists**](https://github.com/Br0ck25/My-Lists)

A powerful, full-featured add-on for [Stremio](https://stremio.com), [Wako](https://wako.app), [Nuvio](https://nuvio.to), and any other app built on the Stremio addon protocol, that transforms your **MDBList**, **Trakt**, **TMDB**, and **Simkl** lists into dynamic catalog rows on your home screen — featuring a full **Custom List Builder**, **Letterboxd CSV Import**, **Virtual TV Channels**, **Airing Next Calendars**, **Continue Watching & Watch History Sync**, **Creator Profiles**, and an **Admin Analytics Dashboard**, all running on a single free [Cloudflare Workers](https://workers.cloudflare.com) deployment or directly at [**mylistsaddon.com**](https://mylistsaddon.com).

There are no servers to manage, no external databases required, and no subscription fees. Your configuration is encoded directly into your install link or securely synchronized via your own private Cloudflare KV storage.

---

## Quick Start (Try It Online)

You can use the official hosted instance right now without deploying anything:
**[mylistsaddon.com](https://mylistsaddon.com)**

Or follow the instructions below to self-host on your own free Cloudflare Worker.

---

## Key Features

### Multi-Provider Catalog Engine
- **MDBList**: Turn public or private MDBList URLs and personal watchlists into catalog rows. Includes one-click browsing of MDBList Toplists and popular charts.
- **Trakt**: Full support for public lists, personal lists, liked lists, watchlists, collections, recommendations, and trending/popular charts. Includes OAuth login and TV/console Device Code authentication (`/api/trakt/device/code`).
- **TheMovieDB (TMDB)**: Support for TMDB v3/v4 lists, user lists, keyword/genre/network/company charts, search, and automated TMDB-to-IMDb external ID resolution.
- **Simkl**: Trending charts across Movies, TV Shows, and Anime (Daily, Weekly, Monthly), plus OAuth account linking for personal list and history import.

### Discover & Quick Add Shelves
- One-click catalog shortcuts for major streaming platforms (Netflix, Disney+, Prime Video, Apple TV+, Max, Hulu, Paramount+, Peacock, Anime, etc.).
- Curated collections, award winners, box office hits, and trending lists built right into the configuration UI.

### Custom List Builder & Letterboxd Import
- **Build from scratch**: Search movies and shows across TMDB to create custom catalogs.
- **Letterboxd CSV Import**: Upload your Letterboxd export CSVs and automatically batch-resolve titles and release years into IMDb/TMDB IDs (`/api/bulk-resolve`).
- **List Sharing & Directory**: Publish your custom lists to the community directory, clone public lists, and like community catalogs.

### Virtual TV Channel Builder
- Create synthetic linear TV channels and scheduled playlists combining hand-picked episodes from different TV shows and whole movies into a single row.
- Built-in channel logo generator, custom poster rendering (`/api/channel-poster`), and quick-add channel presets.

### ⏱Continue Watching & Background Watch Sync
- Automatically tracks watch progress and next unwatched episode per show.
- Mark titles as watched/unwatched directly from the UI or scrobble integrations.
- **Scheduled Cron Worker**: Automatically queries TMDB every 6 minutes via Cloudflare Cron Triggers (`*/6 * * * *`, cursor-paginated so it does not re-sweep every account on every tick) to find newly-aired episodes for caught-up shows and push them to Continue Watching, and to keep the shared provider charts pre-warmed in KV.

### Creator Profiles & Cloud Sync
- Free, passwordless account system secured by salted PBKDF2-SHA256 Creator Keys (`MYL-XXXX-XXXX-XXXX`).
- Synchronize your catalogs, custom lists, channels, presets, likes, and watch history across all your browsers and devices.

### Admin Dashboard (`/admin`)
- Password-protected stats and management dashboard with session authentication (`ADMIN_KEY`).
- Real-time telemetry: page views, installs, and live API usage counters for TMDB, Trakt, MDBList, and Simkl.
- Catalog leaderboards and community feedback/issue tracking inbox (open/in-progress/closed).
- Streaming provider lookup and Netflix catalog preview inspector.

### Progressive Web App (PWA)
- Installable PWA with offline caching (`/sw.js`), modern web app manifest (`/app.webmanifest`), dark mode UI, clipboard shortcuts, and QR code sharing.
- Stremio addon protocol compliance (Manifest v3, catalog pagination, stream/subtitle routing, shelf/item shuffling) -- works with Stremio, Wako, Nuvio, and any other app built on the same protocol.

---

## Requirements

- A free [Cloudflare](https://dash.cloudflare.com/sign-up) account.
- **Optional**: Free API keys/OAuth apps from TMDB, Trakt, Simkl, or MDBList to unlock specific list providers.
- **Zero build dependencies**: The entire add-on runs from `worker_entry_combined.js`.

---

## Self-Hosting: Installation & Deployment

This section is only needed if you want to run your own dedicated copy instead of using the shared hosted instance at [mylistsaddon.com](https://mylistsaddon.com). Most people don't need this section at all.

Self-hosting is expected on Cloudflare Workers. Account creation, restore, key reset, feedback, list preview, and anonymous likes are rate-limited (or identified) using Cloudflare's `CF-Connecting-IP` header — IPv6 is counted per `/64`. That header is set by the Cloudflare edge and cannot be spoofed there. If the header is missing, those endpoints reject the request rather than sharing one global bucket. Running this Worker outside Cloudflare therefore has **no real per-client rate limit** on those paths: they fail closed instead of pretending to throttle everyone together.

### Step 1 — Create the Cloudflare Worker

1. Log into your [Cloudflare Dashboard](https://dash.cloudflare.com).
2. In the sidebar, navigate to **Compute** &rarr; **Workers & Pages**.
3. Click **Create application**.
4. Select **Start with Hello World!** and click **Deploy**. (This creates the worker instance).

---

### Step 2 — Deploy the Add-on Code

1. On your Worker's page, click **Edit code**.
2. Erase any existing template code in the editor.
3. Copy the entire contents of [`worker_entry_combined.js`](https://github.com/Br0ck25/My-Lists/blob/main/worker_entry_combined.js) from the repository and paste it into the editor.
4. Click **Deploy**.
5. Your add-on is now immediately accessible at `https://your-worker-name.your-subdomain.workers.dev`!

---

### Step 3 — (Required) Enable Cloudflare KV Storage

The Worker boots and serves the catalog/manifest pages without this, but every stateful feature -- Creator Profiles (cloud sync), short install links, Custom Lists, Channels, Admin analytics, and Feedback storage -- silently no-ops without it rather than erroring, so it's easy to deploy and not notice it's missing:

1. In Cloudflare Dashboard sidebar, go to **Storage & Databases** &rarr; **Workers KV**.
2. Click **Create Instance** (or **Create Namespace**).
3. Set **Namespace name** to: `my-lists-kv` and save.
4. Return to **Compute** &rarr; **Workers & Pages** &rarr; click on your worker.
5. Navigate to **Bindings**  and click **+ Binding**.
6. Choose **KV namespace** &rarr; click **Add Binding**:
   - **Variable name**: `CONFIGS` *(must match exactly in all caps)*
   - **KV namespace**: Select the `my-lists-kv` namespace created in step 2.
7. Click **Save** / **Deploy**.

---

### Step 4 - (Optional) Enable Cloudflare D1 Storage

D1 is an accelerator in front of KV, never a replacement for it: every accessor tries D1 first and falls back to KV, so Creator Profiles, Custom Lists, and Source Groups are fully functional with this step skipped. Add it if you want relational querying over accounts/lists (e.g. for the admin dashboard's community-list ranking) or to reduce KV read volume at larger scale. If you do enable it later after already having KV data, run `schema.sql` (a **blank-database bootstrap that DROPs existing tables** -- never run it against a live D1 database with data in it; add a file under `migrations/` instead to change a live schema) and then POST `/admin/api/migrate-d1` to backfill existing KV accounts and lists into it:

1. Run `npx wrangler d1 create my-lists-db` in your terminal to provision a new database.
2. Execute the schema against it: `npx wrangler d1 execute my-lists-db --file=schema.sql --remote`.
3. Return to **Compute** &rarr; **Workers & Pages** &rarr; click on your worker.
4. Navigate to **Bindings** and click **+ Binding**.
5. Choose **D1 database** &rarr; click **Add Binding**:
   - **Variable name**: `DB` *(must match exactly in all caps)*
   - **D1 database**: Select the `my-lists-db` database created in step 1.
6. Click **Save** / **Deploy**.

---

### Step 5 - (Optional) Add API Keys & OAuth Credentials

The add-on works out-of-the-box with public MDBList and TMDB links. Adding API keys unlocks external accounts, private lists, and richer metadata.

1. In Cloudflare Dashboard, go to **Compute** &rarr; **Workers & Pages** &rarr; click on your worker.
2. Click **Settings** (Variables and Secrets) &rarr; click **+ Add variable** (or **Add Secret**).

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

### Step 6 - (Optional) Configure Admin Dashboard

To access the `/admin` telemetry and management console:
1. Go to **Compute** &rarr; **Workers & Pages** &rarr; click on your worker &rarr; **Settings** &rarr; **+ Add variable**, create:
   - **Variable name**: `ADMIN_KEY`
   - **Value**: A secure password/passphrase of your choice.
2. Visit `https://your-worker-name.your-subdomain.workers.dev/admin` to log in.

---

### Step 7 - (Optional) Set Up 6-Minute Cron Trigger (Global Catalog Pre-Warming & Continue Watching)

To automatically pre-warm shared **Trakt**, **TMDB**, **Simkl**, and **MDBList** charts into Cloudflare KV every 6 minutes (preventing API rate limits for all visitors and ensuring instant `< 50ms` catalog loads) and check for newly-aired episodes:
1. In Cloudflare Dashboard, go to **Compute** &rarr; **Workers & Pages** &rarr; click on your worker.
2. Go to **Settings**, scroll down to **Trigger events** (or **Triggers** &rarr; **Cron Triggers**).
3. Click **Add Trigger** (or **Add Cron Trigger**).
4. Set the cron expression to: `*/6 * * * *` (every 6 minutes).
5. Click **Save** / **Deploy**.

---

### Step 7 — Install in Stremio, Wako, Nuvio, or Any Other Compatible App

1. Open your deployed worker URL in a browser: `https://your-worker-name.your-subdomain.workers.dev`
2. Add your favorite lists, connect accounts, customize channels, or configure streaming quick-add shelves.
3. Click **Generate Install Link** to copy your personal manifest URL or install directly into Stremio, Wako, Nuvio, or any other app built on the Stremio addon protocol.
4. If you reconfigure later, click **Update Link** and reinstall to push the changes.

---

## Project Structure & Build Pipeline

The codebase is organized into modular ES modules that compile into a single `worker_entry_combined.js` file:

```
.
├── 00_constants.js                     # Versioning, addon constants, and API key globals
├── 01_icon-asset.js                     # Embedded Base64 addon icon
├── 02_http-and-creator-utils.js         # CORS, JSON helpers, crypto, creator auth & hashing
├── 03_admin.js                          # Admin counters, telemetry, and API usage stats
├── 04_config-resolution.js              # Config decoding (Base64 URL & KV short links)
├── 05_catalog-core.js                   # Stremio addon protocol manifest generation & catalog logic
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

When editing any individual split file (`00_` through `26_`), rebuild `worker_entry_combined.js`:

```powershell
.\build.ps1
```

```bash
python3 build.py
```

CI rebuilds from source and fails if the committed Worker drifted. Tests load that Worker in Node with an in-memory KV:

```bash
node --test tests/*.test.mjs
# or: bash verify.sh
```

---

## API & Endpoint Reference

| Endpoint | Method | Description |
|---|---|---|
| `/` | `GET` | Main configuration web app & PWA builder |
| `/:config/configure` | `GET` | Builder interface pre-populated with existing configuration |
| `/:config/manifest.json` | `GET` | Stremio addon protocol Manifest -- works in Stremio, Wako, Nuvio, and other compatible apps (redirects to `/configure` in browser) |
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

## Troubleshooting

- **"MDBList Toplists / Popular Lists not configured"**: Set the `MDBLIST_POPULAR_KEY` or `MDBLIST_API_KEY` secret.
- **"Trakt lists not configured"**: Set the `TRAKT_CLIENT_ID` environment secret.
- **"TMDB lookup / episode browsing not working"**: Set the `TMDB_API_KEY` environment secret.
- **"Cannot save lists / Creator Profiles not working"**: Ensure the KV Namespace binding is named exactly `CONFIGS`.
- **"Admin dashboard authentication failed"**: Ensure `ADMIN_KEY` is configured as a Secret and KV storage is bound.
- **"Continue Watching not updating with new episodes"**: Verify that the Cron Trigger (`*/6 * * * *`) is configured under Worker Triggers and `TMDB_API_KEY` is set. Note that cron updates apply to users with Creator Profiles.

---

## Support This Project

This add-on is free and always will be — you're running it entirely on your own Cloudflare account, so there's no subscription and never will be. If it's been useful to you and you'd like to support ongoing development, you can do so here:

- **Buy Me A Coffee**: **[buymeacoffee.com/brock25](https://buymeacoffee.com/brock25)**
- **TorBox Debrid (Referral)**: **[torbox.app/subscription?referral=af23795c-7706-4b02-a979-d84b5613cfd1](https://torbox.app/subscription?referral=af23795c-7706-4b02-a979-d84b5613cfd1)**

Entirely optional — this doesn't unlock anything or change how the add-on works. It's just an option for anyone who wants to say thanks or use a recommended debrid provider.

---

## License

MIT License. Designed for personal, self-hosted use.

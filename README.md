# My Lists Addon

> **Official Website & Live Web App**: [**mylistsaddon.com**](https://mylistsaddon.com)
> **Source Code**: [**github.com/Br0ck25/My-Lists**](https://github.com/Br0ck25/My-Lists)

A powerful, full-featured add-on for [Stremio](https://stremio.com), [Wako](https://wako.app), [Nuvio](https://nuvio.to), and any other app built on the Stremio addon protocol, that transforms your **MDBList**, **Trakt**, **TMDB**, and **Simkl** lists into dynamic catalog rows on your home screen — featuring a full **Custom List Builder**, **Letterboxd CSV Import**, **Virtual TV Channels**, **Airing Next Calendars**, **Continue Watching & Watch History Sync**, **Creator Profiles**, and an **Admin Analytics Dashboard**, all running on a single [Cloudflare Workers](https://workers.cloudflare.com) deployment (free plan included, with [some limits](#which-cloudflare-plan-do-i-need)) or directly at [**mylistsaddon.com**](https://mylistsaddon.com).

There are no servers to manage, no external databases required, and no subscription fees. Your configuration is encoded directly into your install link or securely synchronized via your own private Cloudflare KV storage.

---

## Quick Start (Try It Online)

You can use the official hosted instance right now without deploying anything:
**[mylistsaddon.com](https://mylistsaddon.com)**

Or follow the instructions below to self-host on your own Cloudflare Worker. A **free** Workers plan runs the
add-on for yourself and a few friends; several features need the **Paid** plan or are effectively off without
it. [**What the free plan can and cannot run**](#which-cloudflare-plan-do-i-need) says exactly which, and why.

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
- **New on Streaming** (admin-only for now): a catalog row of what actually *arrived* on each service, newest first, with a show pushed back to the top the day a new episode airs. Sorted by arrival, never by release date. See [New on Streaming](#new-on-streaming) below.

### Custom List Builder & Letterboxd Import
- **Build from scratch**: Search movies and shows across TMDB to create custom catalogs.
- **Letterboxd CSV Import**: Upload your Letterboxd export CSVs and automatically batch-resolve titles and release years into IMDb/TMDB IDs (`/api/bulk-resolve`).
- **List Sharing & Directory**: Publish your custom lists to the community directory, clone public lists, and like community catalogs.

### Virtual TV Channel Builder
- Create synthetic linear TV channels and scheduled playlists combining hand-picked episodes from different TV shows and whole movies into a single row.
- Built-in channel logo generator, custom poster rendering (`/api/channel-poster`), and quick-add channel presets.
- **Known limit — a movie in a channel may have no streams.** A channel is a *series* to Stremio, and it
  does not work out a type per video, so tapping a movie in one asks stream add-ons for it under
  `series` rather than `movie`. Lenient add-ons (Torrentio-style) and Nuvio cope; strict ones (PenguPlay)
  return nothing. Nothing inside the add-on can change what Stremio asks for, so the movie is best opened
  from its own page.
- A **Play order** dropdown arranges a channel's picks: by air date (oldest or newest first, from each episode's TMDB air date and each movie's release date), by show then season and episode, **interleaved**, A-Z by title, or shuffled once. Each sorts the list in place, so the order you see is the order it plays -- and a sort is re-applied as you add more picks. Drag a pick by hand and it stays put. **Shuffle daily** is the one live mode: the channel reshuffles itself every 24 hours.
- **Interleaved (round-robin) play order.** One episode from each show in turn, then round again -- `Simpsons S1E1 -> King of the Hill S1E1 -> Malcolm S1E1 -> Simpsons S1E2`. A 90s prime-time block rather than fifty episodes of one show before the next one starts.
- **Daily Broadcast Schedule for any channel.** The rotating lineup that Quick Add's network channels have always had, with dials: how many shows run in a day, how many back-to-back episodes make up each show's block, and what time of day (UTC or your own) the lineup turns over. Load a 1,000-episode pool of sitcoms and it reads like a cable channel with fresh programming every morning.
- **Story Lock.** Shuffling suits a procedural and ruins a serialized drama. Tick a show as story-locked and it always advances to its next episode in order -- picking up the next day where the last block left off -- while everything else keeps shuffling around it.
- **Hide watched.** With Auto-track playback on, a channel can skip episodes already in your Watch History. Once the whole pool has been seen it comes back rather than going dark.
- **Next Up channel.** One button, and no picks to make: the channel is seeded from your Continue Watching and re-derived on the server on every request, so pressing play always serves the next unwatched episode across everything you have on the go. **Refresh** on its card pulls in whatever you have started since.
- **Quick Channel Wizard.** Network or studio, era, genre or mood -- and a finished 24/7 channel built from the top shows that match, no blank canvas to fill in.
- **Spotlight channels.** Search an actor, director or creator next to Shows and Movies in the builder. Tapping a result opens their whole filmography below, the way tapping a show opens its seasons: add films one at a time, add just the episodes of a show they are actually in, open a show's poster to pick episodes yourself, or take the lot in one click as a Spotlight channel. Films and episodes are ordered together -- in career order or best-first -- so a guest appearance plays where it belongs among the films rather than after them.
- **Live Cloud Sync.** A channel imported from a Trakt, MDBList, Simkl or TMDB list can keep following that list instead of taking a one-time snapshot: the Worker rebuilds its pool in the background, so titles the list gains turn up in the channel on their own.
- **Built for big channels.** A filter over the picks, a **Select** mode with select-a-whole-show / select-a-season and bulk remove-or-move, and a warning before you add something the channel already has.
- **A stats line on every channel** -- shows, episodes, hours, the years it spans, and the rules it runs under -- plus an **On today** tab on a channel's See All page showing the lineup the server would serve right now.
- **My Channels sorts, searches and rearranges** -- drag a channel, nudge it with the arrows, or type it a position, exactly as a catalog row does -- and deleting a channel can be undone for a minute afterwards.
- **Share links and the Explore Channels directory.** **Share** on any channel copies a link that rebuilds it anywhere -- every pick, its play order and its broadcast schedule -- and **Copy link** keeps that link one tap away afterwards. Publishing (with a Creator Profile) lists it in **Explore Channels**, where tapping a channel shows everything in it before you add it, and the directory can be ordered by newest, most added, most liked or name.

### Continue Watching & Background Watch Sync
- Automatically tracks watch progress and next unwatched episode per show.
- Mark titles as watched/unwatched directly from the UI or scrobble integrations.
- **A show's page counts each season's progress** -- `3/8 episodes`, `0/8` for one you have not started,
  `8/8` (in the accent colour) once it is done -- and updates as you mark episodes, a season, or the whole
  show watched.
- **"Watched" means everything that has aired.** A show you are caught up on mid-season reads as watched
  and offers **Mark Show Unwatched**, instead of offering to mark episodes you have already seen because
  the rest of the season is still to come.
- **Air times, not just air dates.** An episode airing today or later shows the hour it is on -- `9 PM ET`,
  `9:30 PM ET` -- under the date on its page and under the day on its Continue Watching / Airing Next
  badge. TMDB has no episode air time at all, so it comes from [TVmaze](https://www.tvmaze.com/api), which
  needs **no API key and no configuration**: the show's regular slot, plus the next episode's own where
  TVmaze dates it apart (a premiere running long, a finale moved an hour). It is only looked up for a show
  with an episode still to come, and cached for twelve hours. A streaming show with no broadcast slot, or
  one TVmaze has never heard of, simply shows the date on its own.
- **Airing Next** lists the next upcoming episode of every show you have watched, soonest first. The **x** on
  a poster takes one show off that shelf without changing a thing about what you have watched -- and watching
  another episode of it puts it back by itself. Settings -> Account & Sync lists what you have removed if you
  want one back sooner. Needs `migrations/0012_add_airing_next_removals.sql` to remember removals across
  devices; without it everything else still syncs and a removal holds only in the browser that made it.
- **Scheduled Cron Worker**: Automatically queries TMDB every 6 minutes via Cloudflare Cron Triggers (`*/6 * * * *`, cursor-paginated so it does not re-sweep every account on every tick) to find newly-aired episodes for caught-up shows and push them to Continue Watching, to record what has arrived on each streaming service for [New on Streaming](#new-on-streaming), and to keep the shared provider charts pre-warmed in KV.

### Creator Profiles & Cloud Sync
- Free, passwordless account system secured by salted PBKDF2-SHA256 Creator Keys (`MYL-XXXX-XXXX-XXXX`).
- Synchronize your catalogs, custom lists, channels, presets, likes, and watch history across all your browsers and devices.

### Admin Dashboard (`/admin`)
- Password-protected stats and management dashboard with session authentication (`ADMIN_KEY`).
- Real-time telemetry: page views, installs, and live API usage counters for TMDB, Trakt, MDBList, and Simkl.
- Catalog leaderboards and community feedback/issue tracking inbox (open/in-progress/closed).
- Streaming provider lookup and Netflix catalog preview inspector.
- **New on Streaming** panel: sweep state (cursor, walk generation, rows per service, seeded vs observed), a run-a-sweep-now button, and a preview that reads through the same code that serves the catalog to Stremio -- the test surface for the feature while it is still hidden from everyone else.
- Moderation tools: rebuild the public list index, delete a creator's lists, and browse/delete lists published anonymously (those have no owner to ask, so the dashboard is the only way to remove one).
- Database schema check: reports which files under `migrations/` the bound D1 database has not had run, and what each one silently breaks until it is applied.

### Progressive Web App (PWA)
- Installable PWA with an offline app shell (`/sw.js`): the page, its stylesheet and its bundle are cached, so the app opens and its interface works with no connection. Catalogs and lists still need the network — offline they show the same error states they would on a failed request. A new deployment is always picked up immediately: the page itself is fetched network-first, and the bundle is content-addressed, so the cache can never hold the app a version behind.
- Modern web app manifest (`/app.webmanifest`), dark mode UI, clipboard shortcuts, and QR code sharing.
- Stremio addon protocol compliance (Manifest v3, catalog pagination, stream/subtitle routing, shelf/item shuffling) -- works with Stremio, Wako, Nuvio, and any other app built on the same protocol.

---

## Requirements

- A free [Cloudflare](https://dash.cloudflare.com/sign-up) account. See
  [Which Cloudflare plan do I need?](#which-cloudflare-plan-do-i-need) before deciding whether to stay on the
  free Workers plan — some features do not fit inside its limits.
- **Optional**: Free API keys/OAuth apps from TMDB, Trakt, Simkl, or MDBList to unlock specific list providers.
- **Zero build dependencies**: The entire add-on runs from `worker_entry_combined.js`.

---

## Which Cloudflare plan do I need?

Short answer: **free is fine for a personal install** — your own catalogs, your own custom lists, the channel
builder, the directory, sharing links. Three things do not fit in the free plan's limits, and one of them is
silent, so it is worth knowing which before you build a habit around them.

The limits that matter (Cloudflare's, not this add-on's):

| | Workers **Free** | Workers **Paid** |
|---|---|---|
| Outbound `fetch()` per request ("subrequests") | **50** | 10,000 (configurable) |
| CPU time per request | **10 ms** | up to 5 min |
| Requests per day | 100,000 | metered |
| KV writes to *different* keys per day | **1,000** | metered |
| KV reads per day | 100,000 | metered |
| KV operations per invocation | 1,000 | 1,000 |
| KV writes to *the same* key | 1 per second | 1 per second |

Measured against those, on the free plan:

- **CPU is tight on sign-in.** Creator Key verification is PBKDF2 at 100,000 iterations, ~15–18 ms measured,
  against a 10 ms cap. A key check that is not already memoized in the isolate can be cut off.
- **About 500 page views per day exhausts the KV write budget — unless D1 is bound.** Every page view bumps
  two KV counters; with D1 bound the same page view costs **zero** KV writes, because the counters move into
  D1 entirely. After the 1,000-write budget is gone, *every* KV write in the app fails for the rest of the
  day: rate limiters, list saves, sync, feedback.
- **New on Streaming does not run.** Its budget comes out of the episode sweep's unreachable reserve
  (see [New on Streaming](#new-on-streaming)), and on a free Worker that reserve is small enough to be fully
  used -- so the share is zero, and the sweep skips itself with one log line. It also needs D1, which a free
  deployment often has not bound. Nothing else is affected.
- **Chart pre-warming does not run, and the cron needs one variable set.** One chart warm is ~105 subrequests
  on its own — five paged TMDB reads and a detail call per item — so no free-plan budget can fit even one.
  Set `CRON_SUBREQUEST_BUDGET` to `48` (see [below](#the-three-subrequest-budgets)) and the tick skips the
  pre-warm, logs one line saying why, and **completes** — which is what gets Continue Watching working. Leave
  it unset and Cloudflare terminates the tick outright, so neither half runs. Catalogs still load either way;
  without pre-warming they are simply colder and lean harder on the provider rate limits.

So: **D1 is optional for correctness and close to required for anything shared.** Step 4 below is written as
optional because the app genuinely works without it — every accessor tries D1 and falls back to KV — but if
more than a handful of people will open your deployment, bind it. It is the single change that keeps a free
Worker inside its own write budget.

### The three subrequest budgets

Three paths used to exceed the 50-subrequest cap outright, which meant Cloudflare terminated the invocation
and the feature was simply absent on a free Worker. Each of them works to a budget instead, and each budget is
an environment variable:

| Variable | Default | What it bounds | Set it on a free Worker? |
|---|---|---|---|
| `BULK_RESOLVE_SUBREQUEST_BUDGET` | `48` | `/api/bulk-resolve` — the Letterboxd CSV import | **No.** Already free-safe: 24 titles per invocation, and the client re-posts the rest until the import finishes |
| `DETAILS_BATCH_SUBREQUEST_BUDGET` | `48` | `/api/details/batch` — rebuilding the Airing Next shelf | **No.** Already free-safe. Only *cold* ids are charged, so a warm refresh is one invocation on either plan |
| `CRON_SUBREQUEST_BUDGET` | `10000` | one 6-minute cron tick | **Yes — set it to `48`.** Otherwise the tick is terminated and Continue Watching never runs |

Two of the three default to the free-safe number and one does not, and the difference is what each budget does
when it binds. Pacing an import or a shelf refresh costs invocations and nothing else — the work still
completes. Pacing the cron below one chart's worth of budget switches chart pre-warming **off** and drops the
Continue Watching sweep to 8% of its throughput. That is a feature going dark rather than a slower path to the
same place, so it is sized for a paid Worker by default and a free one steps it down.

**Setting a variable when you deploy by pasting into the dashboard:** your Worker → **Settings** → **Variables
and Secrets** → **Add variable**, type *Text*, name `CRON_SUBREQUEST_BUDGET`, value `48`. Deploy. Nothing in
`wrangler.toml` is read on that path, so this is the only place these can be set.

With `CRON_SUBREQUEST_BUDGET = 48` a free Worker gets a tick that **completes** — Continue Watching sweeping 12
shows every 6 minutes, 2,880 a day — and no chart pre-warming, because no free-plan budget can fit even one
chart. Catalogs still load; they are simply colder.

Nothing is dropped at any budget. Each endpoint reports what it did not reach and the client asks again; the
cron resumes from a stored cursor, so a smaller slice costs ticks, not coverage — and there are 240 ticks a
day.

> The plan limits above were read from Cloudflare's docs on 2026-09-08 and the per-request counts were measured
> against this code with provider responses stubbed. The *consequences* on a free plan follow from those two
> numbers; they have not been observed on a live free deployment.

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

### Step 4 — (Required) Enable Cloudflare D1 Storage

D1 is the primary authoritative store for Creator Profiles, lists, full-text search (`lists_fts`), likes ledgers, feedback, tracking, and telemetry counters. KV acts as a cache, a hot key-value store for addon configs and provider responses, and temporary storage for rate limits and short-lived tokens.

Every step below is doable entirely from the Cloudflare Dashboard -- nothing here needs `wrangler`, `npx`, or a terminal of any kind, even though D1's own docs (and this file, in an earlier version) usually show the CLI first. A **Wrangler CLI alternative** is noted at the end for anyone who prefers it.

**1. Create the database**
1. In the Cloudflare Dashboard sidebar, go to **Storage & Databases** &rarr; **D1 SQL Database**.
2. Click **Create Database**, name it `my-lists-db` (or anything you like), and create it.

**2. Run `schema.sql` against it (once, on a brand-new database only)**
1. Open the database you just created and click its **Console** tab -- a query box built right into the dashboard.
2. Open [`schema.sql`](https://github.com/Br0ck25/My-Lists/blob/main/schema.sql) from this repo, copy its entire contents, paste them into the Console, and click **Run** / **Execute**. This creates the `creators`, `creator_lists`, and `source_groups` tables.
3. &#9888;&#65039; `schema.sql` **DROPs and recreates every table it touches.** Only ever run it once, against a brand-new, empty database. If you need to change the shape of a database that already has real data in it later, use a file under [`migrations/`](https://github.com/Br0ck25/My-Lists/tree/main/migrations) instead -- see "Applying a migration" below -- never `schema.sql` again after this first run.

**3. Bind it to your Worker**
1. Return to **Compute** &rarr; **Workers & Pages** &rarr; click on your worker.
2. Navigate to **Settings** &rarr; **Bindings** and click **+ Add**.
3. Choose **D1 database** &rarr; click **Add Binding**:
   - **Variable name**: `DB` *(must match exactly in all caps)*
   - **D1 database**: Select the database created in step 1.
4. Click **Save** / **Deploy**.

**4. Backfill any existing KV data into it**
If you already had Creator Profiles or Custom Lists in KV *before* adding D1 (i.e. you're enabling this on a site that's already been running), D1 starts out empty and needs a one-time copy. Log into `/admin`, open **Management & Tools &rarr; Maintenance**, and click **Migrate KV &rarr; D1**. (A brand-new site with no accounts yet can skip this -- there's nothing to copy.) This is safe to click more than once; KV stays the authoritative copy either way.

**Applying a migration:** files under [`migrations/`](https://github.com/Br0ck25/My-Lists/tree/main/migrations) are small, additive changes to an already-live database (unlike `schema.sql`, they're safe to run with real data present). Open the file on GitHub, copy its `ALTER TABLE`/`CREATE INDEX`/etc. statements (skip the `--` comment lines), paste them into the same D1 Console used in step 2 above, and click **Run**. Run one statement at a time, and do skip the comment lines rather than pasting the whole file: a `--` comment runs to the end of its **line**, so if the paste arrives with its line breaks collapsed, the first comment swallows everything after it. A half-eaten `CREATE TABLE` reports `incomplete input: SQLITE_ERROR`, and a whole file that has become one comment reports nothing at all and creates nothing -- both look like the migration is broken when it is only the paste. Apply them in filename order (`0001_...`, `0002_...`, and so on) -- each one assumes the ones before it already ran.

**Which migrations does my deployment still need?** The Admin Dashboard's **Database schema** panel answers this: it reports every file under `migrations/` that has not been run against the bound database, and what each omission silently costs. Nothing records that a migration was applied, and this Worker degrades quietly rather than refusing to start when one is missing -- so after any deploy that shipped a new migration, check that panel. Worth being concrete about why: deploy without `0004_add_creator_tombstones.sql` and account deletion still reports success and still refuses the deleted account on a normal request, while a colo whose KV cache predates the deletion will happily authenticate it. **Apply migrations first, then deploy the Worker.**

**Wrangler CLI alternative**, if you'd rather use a terminal: `npx wrangler d1 create my-lists-db`, then `npx wrangler d1 execute my-lists-db --file=schema.sql --remote` (or `--file=migrations/000X_....sql --remote` for a specific migration), then bind it the same way as steps 3.2-3.4 above.

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
| `MDBLIST_CLIENT_ID` | MDBList OAuth client ID — **`MDBLIST_CLIENT_SECRET` must be set too, or MDBList OAuth fails with "not configured"** | [mdblist.com/preferences](https://mdblist.com/preferences) |
| `MDBLIST_CLIENT_SECRET` | MDBList OAuth token exchange (required alongside `MDBLIST_CLIENT_ID` for MDBList account login) | Same MDBList preferences as above |

#### OAuth Redirect URIs
If you configure OAuth authentication for Trakt, Simkl, MDBList, or TMDB, set the OAuth callback URLs in their respective developer portals to:
- **Trakt**: `https://your-worker-name.your-subdomain.workers.dev/api/trakt/oauth/callback`
- **Simkl**: `https://your-worker-name.your-subdomain.workers.dev/api/simkl/oauth/callback`
- **MDBList**: `https://your-worker-name.your-subdomain.workers.dev/api/mdblist/oauth/callback`
- **TMDB**: `https://your-worker-name.your-subdomain.workers.dev/api/tmdb/oauth/callback`

#### A note on media-server scrobble URLs

The Plex / Jellyfin / Emby webhook endpoint (`/api/scrobble`) authenticates from the
URL itself — either `?config=<your install id>` or `?creator=<name>&key=<your Creator
Key>`. That is forced by the webhook senders, which cannot attach custom headers, but
it does mean **the key travels in a URL** and so may be recorded in server logs, proxy
logs, and your media server's own configuration screen.

Practical consequences:

- Treat a scrobble URL like a password. Don't paste it into screenshots, issues, or
  support threads.
- If one leaks, rotate it: **Account &rarr; Reset Creator Key** in the app (or
  `POST /api/creator/reset-key`). The old key stops working immediately and any
  webhook still using it will simply stop being accepted.
- Prefer the `?config=` form where you can — it points at a stored install config
  rather than spelling the Creator Key out in the URL.

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

This same cron run also seeds the public list directory/search index (`/lists/public.json`, in-app search) the first time it finds one missing -- a fresh deployment, or the index having been lost some other way -- so a self-hoster with the cron trigger enabled never has to think about it. Without a cron trigger configured, the index instead seeds itself lazily on whichever visitor's request happens to find it missing first, which briefly serves a truncated (capped, oldest-first) directory/search result until that finishes. To seed it immediately and synchronously -- e.g. right after a fresh deploy, without waiting on either of those -- log into `/admin` and POST `/admin/api/rebuild-public-index`.

---

## New on Streaming

A catalog row of what actually **arrived** on a streaming service, newest first -- and a show goes back to the top the day a new episode airs.

**Why it needs a database and a cron trigger, when no other row does.** Nothing upstream publishes the date a title landed on a service. TMDB's `with_watch_providers` answers "is this on Netflix right now" and says nothing about yesterday; Trakt and Simkl do not model provider catalogs at all. The closest thing this add-on had before -- the `Stream Releases` genre row -- sorts by *release* date, which is why it shows theatrical-era titles and completely misses a 1998 film being added to Hulu this morning.

So the add-on observes it. Every cron tick walks a slice of each provider's catalog; a title that is not in the `streaming_events` table already is an arrival, and the moment it was first seen is the date the shelf sorts on. That has three consequences worth knowing before you judge the list:

- **It needs D1** (`migrations/0011_add_streaming_events.sql`). Unlike everything else in this add-on there is no KV fallback -- these dates are observed over time and cannot be refetched later, so a tick that runs without the table is history not collected, not a cache miss.
- **It needs the cron trigger** from Step 7 above, and enough subrequest budget to run (see [Which Cloudflare plan do I need?](#which-cloudflare-plan-do-i-need)). On a free Worker the sweep skips itself with one log line, the same way chart pre-warming does.
- **It reads each catalog to its end, and the depth is measured, not configured.** Every TMDB discover response carries `total_pages`, so the sweep learns how deep each service goes and walks exactly that far. This is what lets a 2010 film added to a service today be picked up at all: sorted by release date it is nowhere near page one, so a fixed page horizon would never fetch it.
- **A completed pass is also what detects removals.** A pass has read every page of every catalog, so a title it did not see is gone. Three guards stand between that inference and the shelf: a title must be missed by two consecutive passes; a pass that failed to read more than a handful of pages concludes nothing; and if a single catalog appears to have lost more than a quarter of its titles at once, that catalog is left alone and the reason is logged. Rows are marked, never deleted -- so if the title comes back, it returns dated as the new arrival it is.
- **The first pass is seeded.** Every title is "new" the first time you look at a catalog, so the first full walk dates each title by its own release date instead of pretending it just arrived. Arrivals found after that are real. The admin dashboard shows the split as **seeded** versus **observed** -- while observed is zero, the ordering is still release dates.

A full pass is roughly 1,000-1,500 pages across the eight services and both types -- the sweep measures the real number and the admin panel reports it -- which at 40 pages a tick is about three hours on the recommended `*/6` schedule. That is the detection latency for a back-catalog addition and for a removal. It is not how long the shelf takes to look right: the walk is page-major, so the first tick covers page one of every provider and both types, and the hours after that only add depth. A new release is found on the next tick either way, because the walk is sorted newest-first and a new release lands on page one.

**Serving it costs nothing.** The title, poster and year are denormalised into the row, so rendering the shelf is one indexed D1 read and zero outbound requests -- it is the only catalog here that a provider outage cannot slow down or empty.

### Trying it before it goes live

It ships dark: `NEW_ON_STREAMING_IN_QUICK_ADD` in `00_constants.js` is `false`, so there is no Quick Add card and no Discover entry. The catalog itself is live from the moment you deploy, which is the point -- it can be judged against real data first.

1. Apply `migrations/0011_add_streaming_events.sql`, deploy, and confirm the cron trigger is set.
2. Open `/admin` &rarr; **Management & Tools** &rarr; **New on Streaming**. Use **Run a sweep now** to pull the first walk in by hand rather than waiting on the cron; it advances the same cursor, so it brings the walk forward instead of duplicating it.
3. **Preview the catalog** reads through the same code that serves Stremio, so what you see there is what a client gets.
4. To try it in Stremio or Nuvio for real while it is still hidden, add a catalog on the main site (**Catalogs** &rarr; **+ New Catalog**) with one of these as the URL:

   | URL | Row |
   |---|---|
   | `tmdb:new-on-streaming` | Everything, across every service |
   | `tmdb:new-on-streaming:netflix` | One service |
   | `tmdb:new-on-streaming:netflix+hulu` | Any combination, `+`-separated |

   Pick Movies or Shows with the type selector, exactly like any other row.

**To turn it on for everyone**, set `NEW_ON_STREAMING_IN_QUICK_ADD = true` and rebuild. That one constant adds the Quick Add card, the Discover shelf, and the `/lists/New-on-Streaming` pages; nothing else about the feature changes.

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
| `/api/creator/lists` | `POST` | The creator dashboard's list index — paged, and metadata only |
| `/api/creator/lists/items` | `POST` | The contents of up to 100 named lists, so the index above does not have to ship them |
| `/admin` | `GET` | Admin analytics dashboard UI |
| `/admin/api/*` | `GET/POST` | Admin analytics, API usage counters, leaderboard, feedback, and moderation API (list index rebuild, creator-list and anonymous-list deletion) |
| `/sw.js` | `GET` | Service worker for offline PWA support |
| `/app.webmanifest` | `GET` | Web App Manifest for mobile/desktop PWA installation |

### Two things worth knowing about credentials

- **Your install link is a bearer credential. Treat it like one.** The configuration behind
  `/<config>/manifest.json` carries whichever provider keys and OAuth tokens you have entered — TMDB, MDBList,
  Trakt, Simkl — and, if Auto-track Playback is on **or the link contains one of your personal shelves**
  (Watch History, Continue Watching, Watchlist, Airing Next), your Creator Name and **Creator Key**. With KV bound that
  all sits behind a 12-character id (72 bits, not guessable); without KV it is base64 **in the URL itself**.
  Anyone you hand the link to can install your catalogs *and* can read those secrets back out of
  `/api/resolve`. Share it the way you would share a password, and if you have shared one you should not
  have: rotate the provider keys, and use **Reset my Creator Key** in the account panel.
- **An admin session cannot be revoked individually.** The `/admin` cookie is a self-contained signature over
  its own expiry, valid for up to 7 days, with no server-side session record — so `/admin/logout` clears your
  browser's copy and nothing else. If you believe a cookie has been captured, rotate `ADMIN_KEY`; that
  invalidates every issued session, including your own.

### Connected accounts expire

Trakt, MDBList and Simkl connections are OAuth access tokens, and this add-on stores no refresh token for
any of them — so a connection lasts as long as its provider's token does (Trakt's is about **three months**)
and then has to be reconnected in Settings. On the web UI that surfaces as a clear message on the affected
list ("Your Trakt connection may have expired…"); inside Stremio the affected catalog row just goes empty,
because a catalog row has no way to say anything.

This is a deliberate limitation rather than an oversight. Provider tokens live inside your install config,
not in a server-side account record, so refreshing one would mean this Worker rewriting stored configs on a
schedule — a different storage model, not a bug fix. Reconnecting takes a few seconds and is the supported
answer for now.

### API-only endpoints

`POST /api/creator/sync/share-tracking` is authenticated, supported, and has **no UI**. It is the only way to
opt a Watchlist, Watch History or Continue Watching shelf into being visible to anyone but you — they are
private by default and nothing else can make them public. Call it with `{ creatorName, creatorKey, slug,
shared }`, or with no `slug` to read the current state back.

That applies to **every** way those shelves can be read, not just the public `/lists/:username/:slug` page:
the Stremio catalog route, `/api/preview` and `/api/resolve` all ask the same question. A request reads one
of your shelves only if it proves it is you — an install link that carries your Creator Key, or a signed-in
builder page — or if you opted that specific shelf in above. Airing Next has no share flag at all, so it is
always yours alone.

For the same reason, `/api/save` refuses to store a configuration that names a Creator Profile unless the
request proves it owns that profile. If you are signed in, the builder page does this for you. Install links
generated **before** this behaviour existed are still honoured, so nothing you have already handed to Stremio
stops working — see `LEGACY_UNVERIFIED_CONFIG_SHELVES` in `00_constants.js` for what that costs and how to
turn it off once your links have been regenerated.

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

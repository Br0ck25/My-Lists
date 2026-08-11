# My Lists Addon

A self-hosted Stremio/wako add-on that turns your **MDBList**, **Trakt**, and **TMDB** lists into catalog rows on your home screen — plus a built-in Watch History, Continue Watching, and Custom List builder, all running entirely on your own free Cloudflare account.

There's no database, no server to maintain, and no third-party service involved besides Cloudflare and the list providers themselves. Your configuration lives either in your install link or in your own Cloudflare KV storage — never on anyone else's server.

## Features

- Turn any public MDBList, Trakt, or TMDB list URL into a home-screen catalog
- Popular Lists browser, Curated picks, and a list search box to find new lists without leaving the app
- A full Custom List builder — search for titles and build your own lists from scratch, or import an existing list from a link
- Watch History and Continue Watching, tracked automatically as you mark things watched, with a "next unwatched episode" indicator per show, and an optional background job to catch newly-aired episodes on shows you're caught up on
- Optional free account system ("Creator Profiles") to save and sync your lists, presets, and watch history across devices
- Trakt account connection for private list and watch-history import
- Quick Add charts for popular streaming services, and Quick Add for live TV channels
- Everything runs from a single Cloudflare Worker file — no backend server, no ongoing hosting cost

## What you'll need

- A free [Cloudflare](https://dash.cloudflare.com/sign-up) account
- 5–10 minutes
- Optionally, free API keys from MDBList, Trakt, TMDB, and/or Simkl (see below) — the add-on works without them, but each one unlocks a specific feature

Nothing else. No command line, no Node.js, no billing information required (this runs entirely on Cloudflare's free tier for any normal amount of personal use).

---

## Installation

### Step 1 — Create the Worker

1. Log into the [Cloudflare dashboard](https://dash.cloudflare.com).
2. In the left sidebar, go to **Workers & Pages**.
3. Click **Create**, then **Create Worker**.
4. Give it a name (e.g. `my-lists`) — this becomes part of your add-on's URL (`your-name.your-subdomain.workers.dev`). Click **Deploy** to create it with the default "Hello World" placeholder code; you'll replace that next.

### Step 2 — Paste in the add-on code

1. From your new Worker's page, click **Edit code** (this opens the Cloudflare "Quick Edit" browser-based code editor).
2. Select all the placeholder code and delete it.
3. Open `worker_entry_combined.js` from this project and copy its entire contents.
4. Paste it into the editor.
5. Click **Deploy** (or **Save and deploy**) in the top right.

That's it — your add-on is now live at `https://your-worker-name.your-subdomain.workers.dev`. Everything below this point is optional, and each piece can be added later at any time without breaking anything already working.

### Step 3 — (Optional) Enable accounts, saved lists, and stats

Creator Profiles (free accounts that let you save Custom Lists to the cloud and sync Watch History across devices), the admin stats dashboard, and short install links all need a place to store data. Without this step, the add-on still works fully for building and installing catalogs — this step only unlocks those extras.

1. In the Cloudflare dashboard, go to **Storage & Databases → KV**.
2. Click **Create a namespace**. Name it anything (e.g. `my-lists-configs`).
3. Go back to your Worker → **Settings → Variables and Bindings**.
4. Click **Add binding → KV Namespace**.
   - **Variable name:** `CONFIGS` (must be exactly this — the code looks for it by name)
   - **KV namespace:** select the one you just created
5. Save.

### Step 4 — (Optional) Add API keys for list providers

The add-on works with **zero keys** for anything using public mdblist.com URLs. Each key below unlocks one additional provider or feature. Add only the ones you want — skipping any of these just means that specific feature shows a clear "not configured" message instead of breaking anything else.

Go to your Worker → **Settings → Variables and Bindings → Add → Secret** (use **Secret**, not plain **Text**, so the value stays encrypted and hidden even from you after saving) for each one you want:

| Variable name | Unlocks | Get a free key at |
|---|---|---|
| `TMDB_API_KEY` | themoviedb.org lists, episode/season data, trailers, artwork | [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api) — use the **API Key** field, not "API Read Access Token" |
| `TRAKT_CLIENT_ID` | trakt.tv public lists and charts | [trakt.tv/oauth/applications](https://trakt.tv/oauth/applications) — create an app, copy the **Client ID** |
| `TRAKT_CLIENT_SECRET` | "Connect Trakt account" (private lists, watch history import) | Same Trakt app as above — copy the **Client Secret** too |
| `SIMKL_CLIENT_ID` | Simkl trending charts | [simkl.com/settings/developer](https://simkl.com/settings/developer/) |
| `MDBLIST_API_KEY` | Private MDBList lists, "My Watchlist" quick-add (fallback if a visitor hasn't pasted their own) | [mdblist.com/preferences](https://mdblist.com/preferences) |
| `MDBLIST_POPULAR_KEY` | The "Popular Lists" browse box specifically | Same place as `MDBLIST_API_KEY` above — can be the same key or a separate one |

For the Trakt Client ID/Secret, when creating the app on Trakt's site, set the **Redirect URI** to:
```
https://your-worker-name.your-subdomain.workers.dev/api/trakt/oauth/callback
```
(only needed if you're setting up `TRAKT_CLIENT_SECRET` for account connection — public Trakt lists work with just the Client ID.)

### Step 5 — (Optional) Enable the admin dashboard

If you set up the KV namespace in Step 3, you can also unlock `/admin` — a stats page showing installs and page views for your deployment.

1. Add one more **Secret**: `ADMIN_KEY`, set to any long random string of your choosing (this is your admin password — keep it private).
2. Visit `https://your-worker-name.your-subdomain.workers.dev/admin` and log in with that value.

### Step 6 — (Optional) Enable the Continue Watching cron

If you've got the KV namespace (Step 3) and a `TMDB_API_KEY` (Step 4) set up, you can also turn on a background job that checks every 6 hours for newly-aired episodes of shows people have fully caught up on, and adds them straight to Continue Watching automatically — without this, that only ever happens when someone manually reopens a show. It only does anything for people using a Creator Profile account (Step 3), since that's the only place watch data exists outside a single browser for a server-side job to reach.

This one step can't be done from a pasted-in file — it's Worker configuration, not code:

1. Go to your Worker in the Cloudflare dashboard → **Triggers**.
2. Under **Cron Triggers**, click **Add Cron Trigger**.
3. Set the schedule to `0 */6 * * *` (every 6 hours).
4. Save.

That's it — no code change needed, the Worker already has the handler for it.

### Step 7 — Install the add-on

1. Open `https://your-worker-name.your-subdomain.workers.dev` in a browser.
2. Build your catalog: add lists, connect Trakt, set up Quick Add charts — whatever you'd like on your home screen.
3. Click the install/configure button to get your personal install link.
4. Open that link on your phone or in Stremio/wako, and confirm the install.

Your configuration is encoded directly into that install link, so it keeps working even without the optional KV setup above — KV just adds the ability to save things server-side instead of only in the link itself.

---

## Updating to a new version later

Cloudflare's Quick Edit editor doesn't track history the way `git` does, so to update:

1. Copy the new `worker_entry_combined.js` contents.
2. Go back to your Worker → **Edit code**.
3. Select all, delete, paste the new version in, and **Deploy** again.

Your KV data (saved lists, accounts, stats) and your environment variables/secrets are untouched by this — they live separately from the code itself.

## Troubleshooting

- **"Popular Lists isn't configured on this add-on yet"** — set `MDBLIST_POPULAR_KEY` (Step 4).
- **"Trakt lists aren't configured on this add-on yet"** — set `TRAKT_CLIENT_ID` (Step 4).
- **"TMDB lists aren't configured on this add-on yet"** — set `TMDB_API_KEY` (Step 4).
- **Can't create a Creator Profile / lists won't save** — make sure the `CONFIGS` KV binding is set up exactly as described in Step 3 (the variable name must be `CONFIGS`).
- **`/admin` says incorrect key** — double check the `ADMIN_KEY` secret was saved, and that KV is bound (the admin dashboard needs both).
- **Continue Watching never picks up new episodes on its own** — confirm the Cron Trigger was added in the Cloudflare dashboard (Step 6 above isn't set from code), and that `TMDB_API_KEY` and KV are both configured. This also only works for signed-in Creator Profile accounts — it has no way to reach data stored only in someone's browser.
- Public mdblist.com lists, TMDB list/episode browsing without lookups, and everything about installing the add-on itself work with **no keys and no KV at all** — if something in that category isn't working, it's not a missing-key issue.

## A note on API keys

Every key above is a personal credential tied to a free developer account on that service. This add-on never ships with anyone's key baked in — you're always using your own. None of these services charge for the tier this add-on needs for personal use.

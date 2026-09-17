# Changelog

All notable changes to **My Lists Addon** ([mylistsaddon.com](https://mylistsaddon.com)) are documented in this file.

---

## [Unreleased]

### 🧰 Channels: a fixed toolbar, and a list you can arrange

- **The search boxes under My Channels and Explore Channels had collapsed.** Both inputs and the
  `<select>` beside them inherit `width: 100%`, so in a flex row the select took the whole width and
  squeezed the input down to nothing. They now follow the same pattern the Live Preview toolbar has
  always used — the input grows, the select is pinned to its own content with `flex: none;
  width: auto` — and the filter box in the Channel builder is pinned the same way rather than
  relying on a button's default width.
- **My Channels can be rearranged**, with the three controls a catalog row has had all along: a drag
  handle (mouse *and* touch), up/down buttons, and a position you can type. A new **My order** entry
  joins the sort dropdown, and rearranging switches to it automatically so the list does not
  re-sort out from under the card you just moved. Rearranging while another ordering is on screen
  adopts *that* as the starting arrangement, so a card lands where it looked like it would.
- **Rearranging while filtered leaves hidden channels alone.** A move permutes the visible channels
  among the slots they already occupy and never rebuilds the whole order from a partial view — the
  same rule the channel draft's own filtered drag follows.

### 🛠️ Channels: nine things that make one easier to build, find and moderate

**Editing a big channel**

- **Bulk select.** A channel with 800 picks was drag-one-at-a-time, type-a-position, or Remove all.
  **Select** turns the draft into checkboxes: tap anywhere on a card, pick out a whole show or one
  season from a menu, then **Remove selected**, **To top** or **To bottom**. Selection is by index
  and every move rebuilds it, because an index that survives a reorder is an index pointing at the
  wrong pick.
- **A filter over the draft**, matching show, episode title and the S/E people actually type
  (`s5e12`). Bulk actions only ever act on what is on screen, so a filter cannot quietly reach a
  pick you cannot see.
- **A duplicate warning.** Adding a show from two different places, or splicing the same crossover
  in twice, used to just work — and you found out later, by which point the duplicate is somewhere
  in eight hundred rows.

**Knowing what you built**

- **Runtimes are stored** on each pick (from TMDB, where it has them), which is what the hours
  count below is made of — and the groundwork for anything schedule-shaped later.
- **A stats line**, under the draft and on each channel's card: `12 shows · 800 episodes ·
  ~412 hours · 1989–2004 · 24 shows × 3 a day · 3 story-locked · hides watched`. The hours are
  marked with a `~` whenever some picks predate runtimes being stored, rather than being quietly
  wrong.
- **"On today"**, a new tab beside Movies and Shows on a channel's See All page: the lineup the
  Worker would serve *right now*, numbered in playing order. You could set 24 shows × 3 episodes
  and, until now, only find out what that produced by opening the channel in Stremio. The Worker
  answers it through the same function the meta route uses — a second copy of the seeded shuffle on
  the page is the kind of thing that drifts by one episode and is never noticed.

**Finding and keeping channels**

- **A description on the channel itself.** It used to live only on the directory listing, so
  unpublishing a channel deleted the sentence describing it and a channel shared by link had
  nowhere to carry one. Publishing now uses the channel's own line when none is typed.
- **My Channels sorts and searches** — by recently updated, created, name or size, and findable by
  name, description, or a show inside it, which is usually how people remember one. **Deleting a
  channel can be undone** for a minute afterwards, which every catalog row could already do and the
  one action that can discard 800 hand-picked episodes could not.
- **Explore Channels has likes and ordering**: newest, most added, most liked, or by name. "Most
  added" ranks by how many people actually took a channel, which is a better signal than a vote
  because taking one costs something. Likes use the same one-identity-one-vote ledger lists use,
  and the count is always derived from that ledger rather than incremented, so it cannot drift
  upward on its own. Editing and re-publishing a channel keeps its votes.

**Moderation**

- **An operator can now moderate the channel directory.** Publishing was owner-only with no
  operator path at all: if someone published something abusive, the only person who could take it
  down was the person who put it there — worse than the standard published *lists* have held since
  they existed. The admin dashboard now lists the directory (and, separately, every stored channel,
  including ones quietly unlisted or orphaned by a lost index write), with two distinct actions:
  **Unlist** removes the directory listing and leaves existing share links working, and **Delete**
  removes the stored channel so every link to it stops working, taking its like ledger with it.

### 🔧 Channels: fixes from the first round of use

- **A Spotlight channel took episodes its subject is not in.** Tobey Maguire's single guest
  appearance in Roseanne put *ten* Roseanne episodes into the channel, because a TV credit meant
  "take this show's first N episodes". It now asks which episodes are actually his: a season's own
  `credits.cast` is that season's regulars (who are in every episode of it without being listed on
  each one), and each episode's `guest_stars` and `crew` name everyone else — so a regular
  contributes the whole season and a one-episode guest contributes one episode. Directing credits
  count too, so a director's spotlight is the episodes they *made*.
- **"Add everything" now means everything** — every film, and every episode of every show, with no
  per-show slice and no four-show cap.
- **The whole lot is ordered together.** Films first and television after read as broken: a 1993
  guest spot played *after* a 2022 film in what was supposed to be career order. Films and episodes
  are now sorted as one set, so each episode sits where it belongs among the films. Best-first ranks
  an episode by its show's rating, which keeps a show's run together.
- **Per-show precision.** In a filmography, a show's button adds only that person's episodes; its
  poster still opens the full season-and-episode picker.
- **Re-sharing a channel you published was refused as someone else's.** An unlisted re-share proved
  nothing about who was sending it, so the ownership check on the record it was overwriting turned
  down the record's own owner. Credentials now go with a re-share as well as a publish.
- **The share link was unreachable once the modal closed.** A channel that has been shared now
  carries **Copy link** on its card, and a published one shows its link in the Explore Channels
  publish panel. **Share** became **Update link** for a channel that already has one, which is what
  it does.
- **Dialogs no longer scroll sideways.** A share URL has no spaces to break at, so it widened the
  modal past the screen. Long words now wrap.
- **Explore Channels cards open.** Tapping one — or **See all** — shows every show, film and
  episode in that channel before you decide to add it. Looking at a channel no longer files it
  under My Channels.
- **The generated channel poster showed no text in Nuvio** while Stremio drew it correctly. The SVG
  named `-apple-system`/`BlinkMacSystemFont` and a quoted `'Segoe UI'`, used numeric font weights,
  and wrapped the channel name in an `feDropShadow` filter — a rasterizer that resolves none of
  those fonts, or drops a filtered subtree it cannot render, loses the text while drawing everything
  else. It is now `Arial, Helvetica, sans-serif`, `font-weight="bold"`, explicit `x`/`y` on every
  `<text>`, and the name's shadow is a second offset copy rather than a filter.

### 📺 Channels: broadcast scheduling, smart rules, sharing and a directory

Ten additions, all of them in the Channels tab. The three that change how an existing channel
*could* play are opt-in and off by default, so every channel saved before this plays exactly as
it did.

**Play order and scheduling**

- **Interleaved (round-robin) play order.** A new entry in the **Play order** dropdown deals one
  episode from each show in turn, then rounds again —
  `Simpsons S1E1 ➔ King of the Hill S1E1 ➔ Malcolm S1E1 ➔ Simpsons S1E2`. That is what a 90s
  prime-time block actually felt like, and the opposite of playing fifty episodes of one show
  before the next one starts. Like the other sorts it is re-applied as picks are added, and it is
  idempotent, so the builder and the Worker cannot fight over it.
- **Daily Broadcast Schedule, for any channel.** Quick Add's network channels have always rotated
  24 shows × 3 episodes out of a much bigger pool; that is now a panel under the play-order
  dropdown for any channel you build, with three dials: **shows per day**, **episodes per block**,
  and the **time of day the lineup turns over** (UTC or your own local time, rather than always
  midnight UTC — which is the previous evening everywhere west of Greenwich). Load a 1,000-episode
  pool of sitcoms and it reads like a cable channel with fresh programming every morning.
- **Story Lock.** Shuffling suits a procedural — Seinfeld, The Office, Law & Order — and ruins a
  serialized one. Tick a show as story-locked and it always advances to its next episode in order,
  picking up the next day where the last block left off, while every other show keeps shuffling
  around it. The positions it occupies still move, so it stays spread through the day rather than
  stuck in one block.
- **Hide watched.** With Auto-track playback on, a channel can suppress episodes already in your
  Watch History. Applied *before* the daily rotation, so an episode you have seen costs the channel
  nothing rather than a slot in today's lineup — and once the whole pool has been seen the channel
  comes back rather than going dark.

**Channels that build themselves**

- **Next Up channel.** One button under My Channels. The lineup is re-derived from your Continue
  Watching on the server on every request, so pressing play always serves the next unwatched
  episode across everything you have on the go, and the channel follows what you are actually
  watching instead of freezing the day it was made. It is also **seeded** from this browser's own
  Continue Watching when you create it: the Worker can only re-derive a lineup for an install
  config that has proved which account it speaks for, and a config with no personal shelf in it
  never does — so without a seed the channel came back *empty* for exactly the people most likely
  to try it first. The seed is what it plays until the live answer arrives, and what it falls back
  to if that proof is ever missing. **Refresh** on the channel's card pulls in whatever you have
  started watching since.
- **Quick Channel Wizard.** Three dropdowns in Quick Add — network or studio, era, genre or mood —
  and a finished 24/7 channel compiled from the top shows that match. No blank canvas to fill in.
- **Spotlight channels.** **Actors & Directors** joins Shows and Movies as a search type in the
  builder. Tapping a result opens their whole filmography *below the search*, exactly the way
  tapping a show opens its seasons — films and television listed separately, each film addable on
  its own, and each show opening into the same season-and-episode picker you get from the Shows
  tab. **Add everything as a Spotlight channel** is still one click for when the whole filmography
  is the point. Sorted chronologically (a career unfolding) or best-first, and the order comes from
  the server so changing it re-asks rather than re-sorting one page — which credits make the cut is
  decided by popularity, and only their order is the sort. Directing and creating credits count,
  not only acting ones, so a Nolan or a Miyazaki spotlight is the films they *made*.
- **Live Cloud Sync.** Importing a Trakt/MDBList/Simkl/TMDB list used to take a one-time snapshot,
  frozen for good. A channel can now keep the source URL instead: the Worker rebuilds its pool from
  that list in the background, so a public list gaining a title gains it here too. The rebuild never
  sits on the request's critical path — a request serves the stored pool and schedules the refresh.

**Sharing**

- **One-click share links.** **Share** on any channel copies a link that rebuilds it anywhere —
  every pick, its play order and its broadcast schedule. A channel is thousands of episodes and a
  link is a few hundred characters, so the link carries a short code and the channel is stored
  behind it; opening the link hands the code over in the URL *fragment*, which never reaches a
  server log. Re-sharing an edited channel updates the link people already have rather than minting
  a second one beside it.
- **Explore Channels.** A new tab listing channels other people have published — add one to your own
  setup in a single click, then edit it however you like. Publishing needs a Creator Profile so
  every listing has an owner who can take it down again; **Unpublish** removes the listing and
  leaves links already handed out working. Sharing privately needs no account at all.

Everything arriving from someone else's channel is rebuilt field by field before it is stored or
rendered: art that is not an `http(s)` URL is dropped, a Story Lock for a show the shared picks do
not contain is dropped, and Live Cloud Sync travels only with a real list URL behind it.

### 🐛 Fixed: air times did not appear, and a channel pick could show yesterday's date

- **Air times were missing on shows you had recently opened.** The details cache is keyed by id, type and
  region only — nothing about the shape of what it stores — so after the air-time deploy it kept handing
  back copies written *before* it, with no air time in them, for up to two hours. The key now carries a
  payload-shape version that a field change moves, which retires every stale copy at once.
- **A movie in a Channel could show the previous day's date** — a 1996 film reading `Dec 31, 1995`. The
  date was pinned to midnight UTC, which is the previous evening everywhere west of Greenwich. It is now
  11:00 UTC, which holds the intended date from UTC-11 to UTC+12:45. (World offsets span 26 hours, so no
  single instant is right in all of them; this one is wrong only at UTC+13/+14.)

### 🎬 Known limit, documented: a movie in a Channel may have no streams in strict add-ons

- **What happens**: a movie added to a Channel plays in Nuvio and in lenient add-ons (Torrentio-style), and
  shows no streams in strict ones (PenguPlay). A Channel's metadata is a *series*, and Stremio does not
  work out a type per video — so tapping a movie asks every stream add-on for
  `/stream/series/<the movie's own IMDb id>.json`, and add-ons that branch on that `type` before reading
  the id answer with nothing.
- **This cannot be fixed from inside the add-on.** The type comes from the parent metadata, and no id shape
  gets around it: `tt123:1:1` points at a season 1 episode 1 that does not exist, and a bare number or a
  private prefix matches no `idPrefixes` anywhere, so no add-on is even asked.
- **Tried and removed**: answering that request with a link to the movie's own page. Stremio Web treats an
  external link as *leaving* Stremio — it routes through a `stremio.com/warning` interstitial and then
  hands the `stremio://` scheme to the operating system — so it was a dead end that looked like a working
  option. It is gone rather than left in place looking useful.
- **What works today**: open the movie from its own page, or use a client that resolves the id itself.
  The two ways to fix this properly each cost something real — proxying your own stream add-on (which means
  this add-on holding your debrid key) or splitting a Channel's movies into a separate movie row (which
  takes them out of the Channel's play order) — so neither is done on the add-on's own initiative.

### 🕒 Episode air times: `9 PM ET` under the air date

- **An episode airing today or later now shows the hour it is on**, under the date on its own page and
  under the day on its Continue Watching / Airing Next badge — `9 PM ET`, `9:30 PM ET`. An episode that
  has already gone out shows no time: it is a thing you are waiting for.
- **TMDB has no episode air time at all** — it dates an episode and stops, which is why every "Airs
  Tuesday" in this add-on has been a day with no hour behind it. The time comes from
  [TVmaze](https://www.tvmaze.com/api) instead, which needs **no API key**, so a self-hosted Worker gets
  this with nothing to configure and nothing to pay for.
- **The show's regular slot, plus the next episode's own** where TVmaze dates it apart from it — a
  premiere running long, a finale moved an hour. Every other upcoming episode gets the regular slot, which
  is what a listing prints for them anyway.
- **Only a show with an episode still to come is ever looked up**, and the answer is cached for twelve
  hours (a week in KV): a broadcast slot is a fact about a season, not about a day. A finished show costs
  nothing, because nothing displays a time against an episode that has already aired.
- **North American slots are named the way a schedule is spoken** — `ET`, `CT`, `MT`, `PT` — rather
  than `EDT`/`EST`, which flip twice a year and read as though the time moved. Elsewhere the zone's own
  short name is used.
- **Nothing is invented.** A streaming show with no broadcast slot, a show TVmaze has never heard of, or
  TVmaze being down all come out the same way: the date on its own, exactly as before. An air time is
  never worth failing a details lookup over.
- **Stremio rows say it too**: an Airing Next row's description now reads
  `Next Episode: S03E06 · Airs 2026-10-04 at 9:30 PM ET`.

### ✅ A show's page says how much of each season you have watched, and "watched" means what has aired

- **Every season header now reads `3/8 episodes`** instead of `8 episodes` — how many of that season are in
  your Watch History, beside how many there are. `0/8` for a season you have not started, `8/8` in the accent
  colour once it is finished.
- **It moves as you do.** Marking an episode from the grid, a season from its button, or the whole show
  updates every count on the page, without reopening it.
- **A show you are caught up on mid-season now reads as watched.** The Mark Show Watched button says **Mark
  Show Unwatched** once every episode that has *aired* has been watched, rather than waiting for a season
  finale that has not gone out yet. Same for the season button beside it.
- **Why it was wrong**: "fully watched" was counted against TMDB's `episode_count`, which includes the
  episodes still to come. Watching 5 of a 10-episode season with episode 6 a month away came out as 5/10 —
  unwatched — so the button offered to mark episodes already seen. The exact episode list settles it, but
  it was only loaded after a season was expanded or the show was marked watched wholesale.
- **No extra requests**: `/api/details` already carries the show's next unaired episode
  (`nextEpisodeSeasonNumber` / `nextEpisodeNumber` / `nextEpisodeAirDate`), which places every season around
  it — a later season has aired nothing, the season it falls in has aired everything before that episode,
  an earlier one is out in full. An episode list, once loaded, still wins over it.
- **Marking the last aired episode watched now flips the show's button** where it used to sit on "Mark Show
  Watched" until the page was reopened, and it repaints every season's button rather than only the one last
  expanded.
- **A show rebuilt from an episode group keeps its old behaviour.** An anime unpacked into its own seasons is
  not numbered the way TMDB numbers it, so the show-level pointer is not applied to it.
- **Fixed: one show's episode lists answering for another's.** The season and episode caches were keyed by
  season and episode number, never cleared between shows, so the last show's season 1 decided what had aired
  in this one's. They are cleared when a show's page opens, and on sign-out.

### 🔀 A Channel's Play order is a menu of arrangements, and a pick you move stays moved

- **Replaces the two checkboxes** added below with one **Play order** dropdown in the Channel builder:
  *As listed (custom)*, *Air date — oldest first*, *Air date — newest first*, *Show, then season &
  episode*, *Title A–Z*, *Shuffle now*, *Shuffle daily*. "Shuffle picks now" moves into it as an entry
  rather than a separate button.
- **A sort now rearranges the picks themselves**, right there in the list, instead of being a rule the
  Worker re-applied on every request. So the order on screen is the order that plays — and **moving a pick
  by hand simply stays**, which the "Sort by air date" checkbox could not do: it silently overrode every
  manual move except between two picks sharing a date.
- **A sort stays selected and is re-applied when picks are added**, so an air-date channel lands each new
  episode in its place instead of at the bottom as the channel grows. It hooks `renderChannelDraftList`,
  the one call every add path already ends with, so every way of adding picks is covered.
- **Moving a pick by hand switches the dropdown back to *As listed*** and stops the re-sorting there: from
  that point the order is the person's. Dragging and typing a position both disarm it before they re-render.
- **"Shuffle daily" is the only entry that stays a mode**, because it is the only one no stored order can
  express — the Worker reshuffles it from a date-based seed each day. The list order is ignored while it is
  selected, and the hint under the dropdown says so.
- **Air date and release date are one field, not two.** A saved pick keeps a single date: TMDB's `air_date`
  for an episode, the release date for a movie. Both air-date sorts read it, and anything undated sorts
  last in either direction — "newest first" is still no reason to open a channel with picks that could not
  be placed at all.
- **Channels already set to "Sort by air date" keep playing correctly.** The Worker still honours that flag
  for a channel nobody has edited; opening one in the builder sorts its picks for real, selects the
  matching entry, and saving drops the flag.
- **A Quick Add network channel is no longer re-ordered at serve time by a sort**, which also settles the
  odd case where air-date order interleaved a rotating channel's day across shows: the rotation decides the
  day's lineup, and the stored order is whatever the builder arranged.

### 🗓️ A Channel can play in air date order

- **Asked for**: a way to sort a channel by aired date when creating or editing it, working like *Randomize
  play order* but with only one of the two selectable.
- **New checkbox in the Channel builder: *Sort by air date*.** The channel plays oldest first across every
  show in it -- so a channel of Friends, Seinfeld and Frasier runs as the week they actually went out,
  rather than one show at a time.
- **Nothing is looked up for it.** Every pick already stores the date TMDB gave when it was added:
  `/api/show-episodes` returns each episode's own `air_date` (a movie carries its release date, or the year
  the builder had), the builder saves it as `released` on the item, and the ordering is decided from the
  saved payload alone -- no extra request, on the page or in the Worker.
- **It and *Randomize play order* are one choice.** Ticking either clears the other on the page, and
  `saveChannel` drops the other flag on the way out, so no channel is ever saved as both. A payload old
  enough to carry both (shuffle was the only flag that existed) resolves the same way in the Worker: the
  explicit sort wins.
- **Leaving both off is still a real answer** -- the picks play in the order they are listed, which is why
  these are two checkboxes and not a radio group.
- **A dateless pick plays last**, keeping its saved order, rather than opening the channel; two episodes
  aired the same night keep the order they were added in, which is what puts a two-part premiere back in
  broadcast order.
- **A Quick Add network channel can use it too**: the daily rotation still picks *which* shows and episodes
  play today, and the sort then decides the order they play in.
- **"See All" agrees with it.** The channel details page reads the saved items directly rather than through
  the Worker, so it now applies the same ordering -- it was listing air-date channels in whatever order
  their picks happened to be stored in.

### 📺 A Channel episode asks a stream add-on for the episode it actually is

- **Reported**: "Non-debrid addons (like Pengu) dont pickup the fake episodes order. I.e: FRIENDS randomized
  channel has the S01E01 at the start of the queue when in fact it's, let's say, S05E13. With Debrid addons
  it plays correctly the S05E13, but non debrid scrapes the original S01E01."
- **A Channel video's `id` *is* its stream request.** Stremio asks every installed stream add-on for
  `/stream/<type>/<video.id>.json` and sends nothing else -- the `season`/`episode` on each video are the
  channel's own running order, for display, and never reach an add-on at all. So a malformed id is not a
  dead link anybody notices: something plays, it is just the wrong thing.
- **`parseInt(it.season, 10) || 1` could not tell "no season" from season 0.** Both became 1, so an item
  stored without a season or an episode was published as `<show>:1:1` -- that show's series premiere, under
  the title of the episode we meant. Such an item is now dropped from the channel instead: a missing episode
  is something a person can report, a wrong one looks like it worked.
- **A show with no IMDb id was published as a bare TMDB number.** `12345:5:13` matches no `idPrefixes`
  anywhere, so no add-on is ever asked for it. It is now the `tmdb:12345:5:13` form this add-on's own
  manifest declares and the rest of the app already reads. An id that is neither `tt...` nor `tmdb:...`
  (including the empty string, which used to publish as `:5:13`) is dropped.
- **The Channel builder stores the same shapes.** `channelStreamShowId` is applied where draft items are
  built -- picked episodes, "Add every season", Quick Add Channel and the crossover/storyline channels --
  so the Worker's check has nothing left to catch. The episode picker now carries the show's TMDB id
  alongside its IMDb id, which is what gives an IMDb-less show a real fallback rather than an empty one.
- **The shuffled running order is untouched**, and a dropped item closes its gap rather than leaving a hole:
  the queue is still 1..N. For a channel whose items all carry a real `tt` id and a real season and episode
  -- which a Friends channel built from TMDB does -- the published id was already correct, and a stream
  add-on that returns S01E01 for `tt0108778:5:13` is resolving it wrongly on its own side.

### ⏭️ Nothing marks a future episode as watched any more

- **Reported**: "if i use the Mark Show Watched the future season is marked as watched but the episode isnt
  marked as watched and the show isnt added to continue watching."
- **What was happening**: `markShowWatched` has always fetched only *aired* episodes -- so nothing wrong
  went into Watch History -- but it finished by relabelling **every** `.btn-mark-season-watched` on screen
  to "Mark Season Unwatched", including a season that has not started. The button claimed a season was
  watched over an empty Watch History. It now relabels only the seasons it actually wrote to (the aired
  episodes it fetched say which), and hands the rest to the shared state below.
- **One description of that button, instead of four.** The item modal's first render,
  `updateSeasonWatchedButton`, `markSeasonWatched`'s own result and `markShowWatched`'s bulk relabel each
  set it their own way and disagreed about the not-yet-aired case. `seasonWatchedButtonState` is now the
  single answer, and an upcoming season gets a disabled button saying when it airs rather than one that
  looks pressable and does nothing.
- **"Fully watched" now means caught up.** `isShowFullyWatched` required *every* regular season to be fully
  watched, so one announced season made it false forever: reopening the modal contradicted the button the
  person had just pressed. Seasons with nothing aired are excluded, matching what Mark Show Watched
  actually marks.
- **A caught-up show stays in Continue Watching.** Marking the last aired episode one at a time leaves the
  show on the shelf with an "Airs …" badge for what is coming; Mark Show Watched was the one path that
  evicted it outright. It now keeps the upcoming entry the reconciliation just computed, and only evicts
  (and queues a storyline conclusion like Breaking Bad → El Camino) when there is genuinely nothing left
  to air.
- **The episode modal no longer offers a watch button on an unaired episode** — it shows when the episode
  airs instead — and `toggleWatchStatus`, the single door every episode toggle goes through, refuses to
  *add* one. Removing stays possible, so an entry made before this (or a stray scrobble) can still be
  undone. Marking a show or season with nothing aired yet now says so instead of appearing to fail.
- **Two supporting fixes**: the fetched episode list for a season is now stashed in `_seasonEpisodesMap` by
  `markShowWatched` and `markSeasonWatched` as well as by expanding the grid, so "is this season fully
  watched" stops guessing from `episode_count` (which counts unaired episodes); and `.lc-btn:disabled` now
  actually looks disabled, having been visually identical to a working button.

### 📺 Airing Next: take one show off the shelf without unwatching anything

- **What was missing**: Airing Next lists the next upcoming episode of every show with at least one watched
  episode, and there was no way to say "not this one". The only ways to get a show off it were to remove its
  Watch History entries or to mark the whole show unwatched -- both of which throw away the very record the
  person wanted to keep, and both of which change what is watched everywhere else in the app.
- **The "x" on an Airing Next poster** (dashboard card and the full-page view) now removes just that show
  from just that shelf. Watch History is untouched, every watched badge stays, and Continue Watching is not
  involved at all.
- **Watching another episode brings it back.** The removal is stored as the watched episode it was made at
  -- the same shape `dismissContinueWatchingShow` has always used for Continue Watching -- not as a
  permanent flag. Watching a later episode supersedes it and the show returns on its own, which is what
  makes this a "stop reminding me" rather than a "never show me again". Rewatching an older episode does
  not: nothing about what airs next has changed. The record is dropped once it is superseded, so the stored
  set stays the size of what is actually removed.
- **Applied in one place**: `collectAiringNextCandidateShowIds`, which every rebuild starts from -- the
  6-hourly TMDB refresh, the immediate watch-state sync, the dashboard card's own eligibility check, and the
  list pushed to the `autotrack:airing-next:series:<username>` Stremio catalog. A removal that only reached
  the renderer would have lasted until the next refresh and no longer.
- **Carried on the account, not just the browser.** The shelf is recomputed from Watch History by every
  device that loads the page, so a removal that lived only where it was made would be undone by the next
  device to rebuild and push. It now travels with the tracking record: new columns `airing_removed_season`
  and `airing_removed_episode` on `creator_show_states` (**migration 0012**, listed in the schema manifest
  the `/admin` panel reports on). The Worker checks for the columns before writing them and falls back to
  the pre-0012 statement when they are absent, so a deployment that has not run the migration keeps syncing
  everything else -- it just cannot remember removals. A push that does not mention removals at all (an
  older browser) is treated as having no opinion rather than as saying there are none, so an ordinary
  autosave cannot clear them.
- **A way back by hand**: a "Removed from Airing Next" panel in Settings -> Account & Sync lists what has
  been removed and puts one back, for the show that was removed by mistake and is not currently being
  watched. Hidden entirely when nothing is removed.
- **Found on the way**: `compactCustomListItem` -- which every local list save runs every item through --
  dropped `canonicalTmdbId`, the resolved TMDB id an Airing Next entry is deduped and badge-matched by. The
  field therefore existed only between the shelf being computed and the map being saved, so the dedupe in
  `refreshAiringNext` and the Continue Watching badge match in `buildLocalListCardHtml` were both reading
  something that was never there on a reload. It is kept now, which is also what lets a removal cover both
  ids a show can be recorded under.

### ⏳ "Reset Account Data" looked like nothing was happening

- **What was wrong**: the reset clears this browser first and only then waits on the server -- deliberately,
  so no autosave or scrobble can push the old lists back into the account being emptied. The cost is a
  second or two in which the confirm dialog has already closed, every list on screen has already vanished,
  and nothing says why. That is indistinguishable from a reset that failed, and pressing Reset again is the
  obvious thing to try.
- **A working dialog now covers the gap**, put up before the local clear rather than after the request, and
  replaced by the success or failure dialog when the round trip finishes. New `showAppBusy` next to
  `showAppAlert`/`showAppConfirm`, so the next slow action has one to use.
- **The spinner now spins.** Two places asked for `animation: spin` and the page declared no `@keyframes
  spin` at all, so both -- the new dialog and "Generating install link..." -- sat perfectly still. A test
  now fails on any animation used by name and never declared.

### 🔁 New on Streaming: read whole catalogues, and notice when a title leaves

Two defects in the sweep shipped in the entry below, both found by running it and asking it questions.

- **A fixed page horizon meant the feature could not do the thing it was built for.** The walk was capped at
  `NEW_ON_STREAMING_WALK_DEPTH_PAGES = 40` -- and sorted by release date descending, 40 pages is the ~800
  most recently *released* titles, one to three years. A 2010 film added to Netflix today sits far outside
  that window, so the sweep never fetched the page it was on and the title never entered `streaming_events`
  at all: not as an arrival, not even as a seeded row. The list could only report new *releases* arriving,
  which is the case that needed it least, and is exactly the failure the README cites to justify the feature.
  Depth is now **learned** from the `total_pages` every discover response already carries, so each catalogue
  is read to its end; the only bound left is TMDB's own page-500 pagination limit. A pass grew from 640 pages
  to ~1,000-1,500 (measured, and reported in the admin panel), and `NEW_ON_STREAMING_PAGES_PER_TICK` went
  12 -> 40 to keep a full pass near three hours.
- **Nothing ever marked a title as gone.** `removed_at` existed, the catalog query filtered on it, and the
  upsert cleared it -- but no code path ever *set* it. `last_seen_walk` was written on every sweep and read
  by nothing. So the shelf only ever accumulated: a film that left Netflix in March was still listed in
  December. A completed pass now marks what it did not see, which is only sound because the walk above reads
  whole catalogues.
- **Three guards on that inference**, because a false removal costs a title vanishing and then returning as
  an arrival that never happened: a row must be missed by `NEW_ON_STREAMING_REMOVAL_GRACE_WALKS` (2)
  consecutive passes; a pass that could not read more than `NEW_ON_STREAMING_MAX_PASS_ERRORS` (20) pages
  concludes nothing; and a catalogue that appears to have lost more than `NEW_ON_STREAMING_MAX_REMOVAL_SHARE`
  (25%) of its titles at once is left alone and logged. That last guard is **per catalogue, not per table**,
  and the distinction is the whole point: TMDB answering 200 with an empty result set for one provider is not
  an error, and one service is an eighth of the table, so a table-wide threshold would wave "every Netflix
  title left overnight" through as an ordinary 12%.
- **A title that comes back is dated as a new arrival.** It is on the service today and was not yesterday,
  which is what this shelf reports. Rows are marked, never deleted, precisely so the row is still there to
  clear -- and a title that never left keeps every date it had.
- **Cursor layout 3.** A fixed-depth walk let the cursor be an index into a fixed-length list; a learned-depth
  one cannot, so the cursor is now a coordinate (`page` + `idx` over a stable provider x kind axis) plus the
  pass's accumulated error count. A stored position from an older layout restarts the pass, keeping the walk
  generation -- a database part-way through seeding is still seeding, and promoting it would date every title
  it has not yet reached as an arrival that never happened.
- **Admin panel** reports measured pass size, how many catalogues have been measured, pages per catalogue,
  titles marked gone, this pass's error count, and why a removal was held back.
- **Tests**: the sweep is now driven end-to-end against a stubbed TMDB, so the parts that only happen over
  time are exercised rather than reasoned about -- a catalogue deeper than any fixed horizon collected in
  full, a 2010 title added today picked up and dated as observed, a departure marked only after the grace
  passes, an unreadable pass marking nothing, one provider going dark neither wiping itself nor blocking a
  real departure on a healthy service, a returning title re-dated, and a still-present title keeping its
  original arrival date across passes.

### 🔧 Watch History, Continue Watching and Airing Next read "No items found." in Live Preview & Editor

- **What was wrong**: those three rows are `autotrack:<slug>:<type>:<username>` sources, and reading one
  server-side means reading that account's private tracking record. `/api/preview` is unauthenticated, so
  the username inside that string is a claim until the caller proves it with a Creator Key the endpoint can
  verify — and `mayReadTrackedShelf` answers an unproven reader with an **empty shelf** rather than an error,
  because a catalog row has no way to show a message. Live Preview & Editor and the per-row **Test** button
  both sent `creatorName` with no `creatorKey`, so every one of those shelves came back `ok:true` with
  nothing in it and rendered "No items found." — for its own owner, while the same shelves showed their
  items everywhere else on the page. Airing Next has no share flag at all (only `watchlist`,
  `watch-history` and `continue-watching` do), so proving ownership is the **only** way to read it and it
  could never preview under any setting.
- **Where it came from**: SEC-001's remediation notes "`/api/preview` call sites send the signed-in
  account's key". Two of them did not. `previewCreatorKey` (`23_client-list-management.js`) is now the one
  place that decides, and both call sites use it.
- **The key still travels only where it is needed**: it is attached for a url that actually names a personal
  shelf and nothing else — the same rule `collectKeys` already applies to `trackCreatorKey`, because a
  Creator Key is a bearer credential and a preview of a public mdblist/trakt/tmdb list has no use for one.
  A merged row stacks its sources one per line, so any line naming a personal shelf arms it, not just the
  first. Signed out, nothing is claimed.
- **Tests**: `tests/client.test.mjs` drives `renderLivePreview` against the real bundle — the key is sent for
  Continue Watching, Watch History and Airing Next rows and for a merged row whose personal source is not
  first, and is absent from a public list preview and from a signed-out browser.

### ✨ New on Streaming — a catalog of what actually arrived on a streaming service

A new catalog source, `tmdb:new-on-streaming[:service1+service2]`, sorted by arrival: most recently
added first, with a show pushed back to the top the day a new episode airs. It **ships dark** —
`NEW_ON_STREAMING_IN_QUICK_ADD` (`00_constants.js`) is `false`, so there is no Quick Add card, no
Discover entry and no `/lists/<slug>` page — while the catalog itself is live and installable, which is
the point: it can be judged against real swept data before anyone else can add it.

- **Why it needed building rather than querying**: nothing upstream publishes the date a title landed on
  a service. TMDB's `with_watch_providers` answers "is this on Netflix right now" and says nothing about
  yesterday; Trakt and Simkl do not model provider catalogs at all. The existing `tmdb:genre:stream-releases`
  row sorts by *release* date instead, which is why it shows theatrical-era titles and completely misses an
  old film being added to a service this morning. So the add-on observes arrivals on the cron tick and owns
  the dates: `streaming_events` (`migrations/0011_add_streaming_events.sql`) records the first sighting of a
  title on a service, and that is what the shelf sorts on.
- **The sweep** (`sweepNewOnStreaming`, `07_source-fetchers-tmdb-simkl.js`) walks a slice of each provider
  catalog per tick from a rotating cursor — 8 providers x 2 kinds x 40 pages, 12 units a tick, about five
  hours for a full pass. Sorted by **release date, not popularity**: a popularity-sorted walk reorders itself
  between the ticks that read its pages, so titles slide across page boundaries and arrivals are both missed
  and invented. A page only costs its own fetch in steady state — the sweep asks D1 which of its TMDB ids it
  already holds and resolves IMDb ids for the rest, and a title arriving on a second service costs no TMDB
  call at all because the first service's row already carries the id.
- **The episode half** (`bumpNewOnStreamingEpisodes`) scans two providers a tick for shows with an episode in
  the last 10 days, keeps only the ones already on the shelf, reads `last_episode_to_air` for the exact date,
  and re-bumps every service's row for that show — a new episode is new wherever you watch it.
- **The first pass is seeded, and says so.** Every title is "new" the first time you look at a catalog, so
  walk 0 dates each title by its own release date rather than pretending it just arrived; walk 1 onward
  records real arrivals. The admin dashboard reports the split as **seeded** versus **observed**, which is
  the one number that says whether the list is working yet.
- **Serving it makes no outbound request at all.** Title, poster, backdrop and year are denormalised into the
  row, so a catalog page is one indexed D1 read — the only shelf here a provider outage cannot slow down or
  empty. Covered by a test that fails if a single `fetch` is issued while rendering it.
- **Admin dashboard**: **Management & Tools → New on Streaming** shows sweep state (cursor, walk generation,
  rows per service, seeded vs observed), runs a sweep on demand, and previews the catalog *through
  `fetchNewOnStreaming` itself* rather than re-deriving the shelf — a second implementation would be the one
  thing guaranteed to disagree with what Stremio gets. Routes: `GET /admin/api/new-on-streaming`,
  `POST /admin/api/new-on-streaming/sweep`, `GET /admin/api/new-on-streaming/preview`.
- **Budget, and the regression it nearly caused**: the sweep is paid for out of the episode sweep's own
  unreachable reserve, not the pre-warm's share. `episodeBudget` is half the tick (5,000 at the default)
  while `CRON_EPISODE_CHECK_MAX` caps actual spend at 300, so 4,700 fetches are reserved by something that
  will never ask for them. Taking a quarter of *that* leaves `cronBudget - episodeBudget` intact — which
  matters, because taking it from the pre-warm dropped it from 40 charts a tick to 35 and quietly broke its
  "the whole list fits in one tick" guarantee. On a free Worker the share comes out at 0 and the sweep skips
  itself with one log line, exactly as chart pre-warming does.
- **Requires D1.** Unlike everything else in this add-on there is no KV fallback: these dates are observed
  over time and cannot be refetched, so a tick that runs without the table is history not collected rather
  than a cache miss. `D1_SCHEMA_MANIFEST` says so, so the schema check reports it.
- **Tests**: `tests/new-on-streaming.test.mjs` — the walk query's ordering and filters, date parsing and
  future-date clamping, selection parsing (including an unknown service degrading to "all" rather than
  building an empty `IN ()`), unit-list stability under the cursor, and the catalog itself through the real
  Worker against real SQLite: arrival ordering, episode re-bump ordering, per-service filtering, a title on
  several services appearing once dated by its latest arrival, removals hidden, and zero outbound requests.

## [1.5.4] - 2026-09-14

Everything below the "Earlier unreleased entries" heading predates 2026-09-03. What
follows first is the work since: four audit passes (an independent full-repository
review, two adversarial rounds, and the first frontend round that drove a real
browser) and the fixes that came out of them, plus the multi-device sync and count
bugs reported from real use afterwards. Every finding from all four audits is closed;
the reports now live in `docs/history/`.

### 🔒 SEC-001 — personal shelves were readable by anyone who knew a username (2026-09-14)
- **What was wrong**: `creatorsynctracking:{username}` holds an account's Watch History, Continue Watching,
  Watchlist and Airing Next. Four code paths read it and only one asked whether the caller was allowed to.
  `/lists/:username/:slug` consulted the opt-in flags `/api/creator/sync/share-tracking` writes;
  `fetchAutoTrackedCatalog` (every Stremio catalog request **and** every `/api/preview`) and `resolveConfig`
  (whose arrays `/api/resolve` returns wholesale) took the username straight out of a caller-supplied string.
  A single unauthenticated
  `GET /api/preview?type=series&url=autotrack:watch-history:series:<username>` returned the whole shelf, with
  `Access-Control-Allow-Origin: *` so any web page could read it — and `/lists/public.json` publishes a
  username for every public list, so nothing had to be guessed. README stated the opposite as a guarantee.
- **The gate, now shared**: `mayReadTrackedShelf` (`02_http-and-creator-utils.js`) is the single place that
  answers "may this caller read this shelf", and `fetchAutoTrackedCatalog` calls it — the one point every
  route funnels through, so a caller added later inherits the check instead of having to remember it.
  A shelf is served only to a request that proves it owns the account, or one the owner explicitly shared.
  Airing Next has no share flag, so it is owner-only.
- **Proof, not a claimed name**: `/api/save` now refuses to store a configuration naming a Creator Profile
  (via `trackCreatorName` or an `autotrack:…:<username>` row) unless the request authenticates as it, and
  stamps the verified owner on the stored payload. `resolveConfig` gates its tracking read on that proof.
  A base64 (no-KV) config is caller-authored and can never claim an account.
- **Nothing that works today stops working**: the Creator Key now travels with a config whenever the config
  contains one of that account's personal shelves, not only when Auto-track Playback is on — that shape
  previously carried no credential at all. `/api/preview` call sites send the signed-in account's key.
  Install links minted before this release are still honoured; see `LEGACY_UNVERIFIED_CONFIG_SHELVES`
  (`00_constants.js`) for exactly what that costs and how to close it.
- **Tests**: a dedicated gate test in the Phase 4 suite (anonymous gets nothing for all four slugs, the owner
  gets it, an opted-in shelf is public, a truthy-but-not-`true` flag is not consent), plus
  `audit/full-2026-09-13/p12_sec001_positive.mjs` covering owner links with tracking on and off, legacy
  configs, share and un-share. `loadSourceFunctions` now loads several sources into ONE sandbox, because
  loading `05_` without `02_` is a different program from the concatenated Worker, not a smaller one.

### 🧬 Watch History / Continue Watching could be discarded without saying so (2026-09-14)
- **DB-001 — one duplicated show id discarded the whole write**: `continue_watching` and `airing_next` are
  keyed `(username, show_id)` and their INSERTs carried no `ON CONFLICT`, so a single repeated show id in a
  client-supplied array raised a UNIQUE violation. A D1 batch is one transaction, so that took the meta row,
  the show states, Continue Watching, Airing Next **and** Watch History down with it — and the route answered
  `ok:true`. `watch_history` next door had had `ON CONFLICT … DO UPDATE` all along. Both tables now upsert,
  and both arrays are deduped server-side on the key they are actually stored under (first occurrence wins,
  matching the client's own `dedupeContinueWatchingItems`).
- **…and the blanket delete that went with it**: every "replace the whole set" was `DELETE WHERE username = ?`
  followed by INSERTs, chunked 80 at a time — so the delete could commit while a later chunk failed, leaving
  the shelf genuinely emptied. Replaced by `d1ReplaceRowsById`: read what is there, upsert everything
  incoming, and delete only the rows that are actually gone, by id, **last**. A failure now leaves stale
  extras — which the next push corrects — instead of a hole.
- **BE-001 — a failed D1 write reported success**: `saveCreatorTrackingD1` returns `false` on failure and the
  value was dropped. Because D1 is what `/api/creator/sync/load` and every personal catalog row read first,
  the browser was told its push had landed, advanced its sync baseline, and then discarded its own unsaved
  copy on the next load. `/api/creator/sync/save-tracking` now writes KV first (so the push survives),
  reports the D1 failure as a 500, and the browser keeps its copy and retries.
- **…and the read now notices when D1 is behind**: `readCreatorTrackingD1` compares its meta stamp against the
  KV blob and hands back the newer copy, repairing D1 in the background — the same repair `getCreatorList`
  has carried for list records since a previous audit.
- **DB-002 / BE-002 — `"tmdb:1399".split(':')[0]` is `"tmdb"`**: three places reduced a show id to its show
  that way. In `/api/creator/sync/save-tracking`'s merge it meant one server-side `tmdb:` entry marked the
  whole namespace handled and dropped every incoming `tmdb:` show behind it (measured: four shows pushed, two
  stored, `ok:true`). In `fetchAutoTrackedCatalog` it matched every `tmdb:` Continue Watching row to the first
  `tmdb:` Airing Next entry, so unrelated shows inherited each other's air dates and season-finale badges.
  One `trackingShowKey` helper now does what the client has always done.
- **BE-004 — the cron wrote a stale snapshot back**: `checkForNewEpisodes` re-read the record before writing
  and then assigned the array it had built from the copy read *before* several seconds of TMDB I/O, so the
  re-read did nothing and a browser save in between was reverted. It now applies only the two edits it
  actually makes — append a newly-aired episode, and take that show out of `fullyWatchedShowIds`.
- **Dead flag removed**: `d1Success` in `/api/creator/lists/save` was assigned in two places and never read.
  The list path deliberately tolerates a failed D1 write (KV holds it and `getCreatorList` repairs on read);
  that is now written down instead of implied by an unused variable.

### 🧹 Reliability, protocol and dead-code fixes (2026-09-14)
- **BE-003 — rotating a leaked webhook token failed open**: `getOrCreateScrobbleToken` logged a failed D1
  rotation and wrote KV anyway. `usernameForScrobbleToken` consults D1 first, so it then found the **old**
  token recorded as active, rejected the new one and kept honouring the old one — the caller was handed a
  token that did not work while the credential they believed they had just revoked carried on authorising
  writes. Rotation now fails closed (the caller already turns that into a 500). A first mint still tolerates a
  D1 miss, because nothing contradicts it and the lazy backfill repairs it.
- **CF-001 — `/admin/api/creator-lists` could exceed the per-invocation storage cap**: `list({ limit: 1000 })`
  with no cursor plus one `get` per key is up to 1,001 operations against Cloudflare's 1,000 limit, and
  anything past the first 1,000 keys was invisible either way. Bounded by
  `ADMIN_CREATOR_LIST_KV_SCAN_MAX` (250), and the response now reports `kvScanTruncated` when it hits it
  instead of implying it saw everything.
- **DB-004 — the search index update was two statements**: FTS5 has no primary key, so updating `lists_fts`
  is delete-then-insert; as two separate awaits, two concurrent saves of one list could interleave into zero
  rows or two, and a failure between them left the list unsearchable silently. Now one `batch`, which is one
  transaction.
- **PROTO-001 — the manifest did not declare an id prefix it serves**: Watch History and Continue Watching
  entries for titles with no IMDb id are `tmdb:<id>`, and `/meta` has always resolved them — but
  `idPrefixes` said only `["tt", "channel_"]`, which is how a Stremio-protocol client decides who owns an id.
  Strict clients filtered those tiles out of the row and no client routed their detail page here. Both
  `idPrefixes` arrays now include `"tmdb:"`.
- **FE-001 — an optimistic dashboard update was never rolled back**: the list reconciliation save used
  `.catch(() => {})` and never looked at `data.ok`, so a refusal the server states plainly (413 over the size
  ceiling, 409 on a conflicting edit) left the dashboard showing items the account does not have. The change
  is now reverted and reported.
- **FE-002 — ~520 lines of unreachable import code removed**: the Trakt-export and Letterboxd-export zip
  importers bound their file inputs with `getElementById('traktExportFileInput')?.addEventListener(...)` at
  script-evaluation time, and neither id exists in the page — optional chaining meant they never attached.
  The unified importer replaced both and reads `.zip` itself. `mapTraktExportEntryToWatchHistoryItem`, the one
  piece the live Trakt history import still calls, was kept.
- **FE-003 — a stale saved sub-tab opened the Lists tab blank**: `#listsSubBulk` was removed from the page but
  the value that selects it is still in people's `localStorage`, and `switchListsSubmenu` hides every panel
  before showing the one it was asked for — so a browser holding `'bulk'` showed nothing, on every load,
  with no way back but clearing site data. The saved value is validated against the panels that exist, in the
  bundle **and** in the pre-paint inline script, since the CSS hides panels before the bundle runs.

### 🔑 A full backup with live credentials was committed to the repository (2026-09-14)
- `my-lists-full-backup1.json` (added in `73f2dd8`) was an exported app backup containing one account's
  **Creator Key** and its live **Trakt, MDBList and Simkl OAuth access tokens** in plain text, in a public
  repository. The file is removed and `.gitignore` now refuses that shape.
- **Removing it does not remove it from git history**, and the repository has a fork. Every credential in it
  must be treated as compromised: reset the Creator Key in the account panel, and revoke the three provider
  tokens at trakt.tv/oauth/applications, mdblist.com/preferences and Simkl's settings.

### ⚡ Performance, hardening, accessibility and docs (2026-09-14)
- **DB-003 — the directory read had no `LIMIT`**: `/lists/public.json` fetched every public list on the
  deployment, running `json_array_length` over each one's `items_json` to count it, then kept 100. Page one
  cost as much as the entire directory, and past a certain size the failure is a D1 response-size error
  rather than a slow page. The page is asked for in SQL now (`LIMIT`/`OFFSET`), the total comes from two
  cheap `COUNT`s, and one read is capped by `PUBLIC_INDEX_MAX_ROWS`.
- **CF-002 — the page memo was keyed on the page**: `SPLIT_PAGE_MEMO` used the whole pre-split HTML string
  (measured at 1,979,374 characters) as its Map key, with the rewritten page as the value, sixteen entries —
  tens of megabytes pinned in an isolate that has 128MB for everything. Keyed on a cheap hash plus length now.
- **Stored install configs are namespaced**: they were written at the bare 12-character id, which made
  `resolveConfig` a read of an *arbitrary* short KV key. Nothing is exposed by that today — every other
  namespace is prefixed and longer — but that is an accident of current key names, not a rule. New configs go
  under `cfg:`; old ones are still read at their bare key, so no install URL changes.
- **`/admin/logout` is POST-only** and the dashboard's control is a form rather than a link. The session
  cookie is `SameSite=Strict`, so this was never reachable cross-site; it was protection by a property of the
  cookie rather than by the method being right.
- **A11Y-001 — keyboard focus was invisible**: seven rules set `outline: none` and nothing put anything back;
  the whole 97KB stylesheet had two `:focus` rules and no `:focus-visible`. Tabbing to the theme toggle, any
  header button, an accordion or a Continue Watching remove button showed nothing (WCAG 2.4.7). A
  `:focus-visible` ring is defined once, last in the cascade.
- **A11Y-002 / A11Y-004** — the 18 icon-only buttons (modal `✕`, the `♡` like button, the row and
  source removers) have accessible names, and all five dialogs are named: the static four by `aria-label`,
  the dynamic one by `aria-labelledby` pointing at the heading `showModal` already focuses.
- **A11Y-003** — a `prefers-reduced-motion` block, against three `@keyframes` and 33 transitions.
- **PWA-001 — the manifest lied about the icon**: two entries claimed 192×192 and 512×512 while
  `/icon.png`'s IHDR says 256×256, so the splash and installed-app icons were upscaled from half the declared
  resolution. Declared at its real size now. No `maskable` entry — that needs an icon drawn for the safe zone,
  which is a design task, not a manifest edit.
- **API-001 documented**: no refresh token is stored for any provider, so a Trakt connection lasts about three
  months and then needs reconnecting. Written down in the README with why it is a storage-model change rather
  than a fix.

### ♻️ "Reset Account Data" undid itself a few hours later (2026-09-14)
- **Reported**: after pressing Reset Account Data everything clears, then hours later the lists, watch
  history, continue watching and presets are all back.
- **Cause**: a reset empties the account but deliberately keeps the identity, so every OTHER browser signed
  into it still holds the whole account in `localStorage`. All five stamps `/api/creator/sync/meta` reports
  then read **0** — which is exactly what a brand-new account reports. Three places treat that as "nothing has
  ever been saved here, so my copy is the first save":
  - `renderCreatorDashboard` uploads every local list the account is missing (`uploadMissingLocalListsToAccount`);
  - `loadCreatorSync`'s presets branch says so outright — *"Server presets are empty: keep local presets and
    push them up"*;
  - the same load re-pushes config, channels and tracking.
  So the next device to wake up put it all back, and nothing anywhere could tell an emptied account from a
  new one. The `/api/creator/sync/meta` poll made it worse: every stamp moves *down* to 0 on a reset, and the
  poll only ever asks whether a stamp moved **up**, so it concluded "nothing changed" and left the stale
  browser holding a full copy.
- **Fix, using machinery that already existed**:
  - `purgeCreatorData` now writes a **deletion tombstone per list** it removes (`recordCreatorListDeletions`),
    which is precisely what `renderCreatorDashboard`'s re-upload guard already consults — so the lists cannot
    come back.
  - It also records a **reset stamp** (`creatorreset:{username}`, `CREATOR_RESET_TTL_SEC` = 90 days), returned
    by `/api/creator/account/reset`, `/api/creator/sync/load` and `/api/creator/sync/meta`. A device that has
    not seen that stamp clears its local copy instead of uploading it, records the stamp, and stays signed in
    on the now-blank account.
  - The poll checks `resetAt` separately from the four stamps, because it is the one signal that counts *down*.
- **Gated on an explicit `recordReset` option**, not on "this was not a delete": `/api/creator/create` runs the
  same sweep as a pre-create purge, and marking every brand-new account as just-reset would have made the
  browser that created it wipe itself on its first sync. (The regression tests caught exactly that.)
- Deleting an account still writes no marker — there is no account left to announce it to, and the key stops
  authenticating.

### 🌌 Storylines, Sagas & Universes Watch Order in Item Details (2026-09-12)
- **Chronological watch order display at bottom of Item Details**:
  - When clicking any poster to inspect details (`openItemDetailsModal`), the modal automatically detects whether the title belongs to any canon saga, trilogy, or franchise universe in `TV_CROSSOVER_EVENTS`.
  - If matched, renders a dedicated **Storylines, Sagas & Universes** section beneath the overview, trailer, and seasons list displaying the saga name, franchise metadata, description, and an "Open Saga" button.
  - Displays a clean horizontal scrolling shelf (`storyline-posters-scroll`) of all installments in narrative watch order with part badges (`Part 1`, `Part 2`, etc.), poster artwork with fallback resolution, format labels (e.g., `Movie`, `Seasons 1-5`, `S2E8`), and watched checkmark indicators.
  - Distinctively highlights the currently active item with `.item-storyline-card.is-current` styling, an accent border (`var(--accent)`), ambient glow, and a high-contrast `"Current"` badge.
  - Interactive navigation: Clicking any non-active installment invokes `openItemDetailsModal(...)` for that specific title, allowing users to seamlessly browse through the entire chronological storyline step by step.
  - Multi-storyline support: If a title belongs to multiple sagas or crossover events (e.g. *The Flash* in the Arrowverse), renders subnav pill tabs (`switchItemStorylineTab`) allowing instant switching between storylines.

### 📺 Mark Show Watched & Unwatched Button Fixes (2026-09-12)
- **Button Renaming**: Changed "Mark Whole Show Watched" to **"Mark Show Watched"** and "Mark Whole Show Unwatched" to **"Mark Show Unwatched"**.
- **Fixed "Mark Show Unwatched" button failure**:
  - Captured intent directly from the button element's state (`secondary` class or `"Unwatched"` label) so clicking to unwatch always passes `forceUnwatch: true` to `toggleBatchWatchStatus` rather than relying on inconsistent single-ID checks in `_fullyWatchedShowIds`.
  - Enhanced episode unwatch filtering in `toggleBatchWatchStatus` to match both raw numeric TMDB episode IDs and composite string IDs (`showId:s:e`, `imdbId:s:e`, `tmdbId:s:e`), ensuring all episodes of the show are thoroughly removed from `watch-history`.
  - Updated `setShowFullyWatched` to synchronize all show aliases (`id`, `imdbId`, `tmdbId`, `'tmdb:' + tmdbId`) in `_fullyWatchedShowIds`.
- **Fixed show button not reverting when a season is marked unwatched**:
  - Added `isShowFullyWatched(d)` helper to accurately check whether all non-specials seasons are fully watched.
  - In `toggleSeasonWatched`, updated `btnMarkShowWatched` using the freshly evaluated `allSeasonsWatched` state rather than `isItemWatched()`, immediately reverting the button to "Mark Show Watched" (with `primary` class) if any season is unwatched.
  - Refined `isItemWatched()` to check item-specific IDs rather than matching any item sharing `it.showId`, preventing partial episode watch history from falsifying whole-show watched status.

### 🎬 Continue Watching Storyline & Companion Recommendations (2026-09-12)
- **Automatic recommendation of companion movies, bridge films, and sequel/spinoff series in Continue Watching.**
  - **Narrative Bridge Movies Between Seasons**: When a user completes a season that precedes a canon bridge movie (e.g., *Demon Slayer* S1 finale &rarr; *Demon Slayer: Mugen Train*, *The X-Files* S5 &rarr; *Fight the Future*, *24* S6 &rarr; *Redemption*, *Power Rangers Zeo* &rarr; *Turbo: A Power Rangers Movie*), Continue Watching automatically recommends the bridge movie instead of jumping straight to the next season premiere.
  - **Sequel Films and Spinoff Series on Show Conclusion**: When a user finishes the series finale of a show (e.g. *Breaking Bad* S5 finale), Continue Watching automatically injects the sequel film (*El Camino: A Breaking Bad Movie*). When the user finishes or marks the sequel film watched in Watch History, Continue Watching advances to the next narrative installment or spinoff series (*Better Call Saul* S1E1). Also supports standalone finales like *Deadwood: The Movie*, *Serenity*, *Downton Abbey*, *The Last Kingdom: Seven Kings Must Die*, *Psych*, *Monk*, etc.
  - **User Enable/Disable Setting**: Added a dedicated "Storyline & Companion Recommendations" toggle in the Settings tab under *Watch History & Continue Watching*, backed by `localStorage['myListAddon:autoRecommendCompanions']` (default: enabled). When disabled, zero companion suggestions are injected.
  - **Dismissal and Sequential Advancement**: Companion recommendations can be dismissed via the card's `&times;` button, recording the dismissal in `_dismissedContinueWatching`. Dismissing a companion halts recommendation for that storyline point without prematurely skipping ahead to later installments.
  - **Design System Badges**: Added distinct `cw-date-badge-companion` badge labels (e.g. "Bridge Movie", "Sequel Film", "Next Series in Storyline") using design system tokens (`var(--accent)`), rendered consistently across Custom List cards (`buildLocalListCardHtml`) and Live Preview poster tiles (`livePreviewPosterHtml`).
  - **D1 & Sync Round-Trip Persistence**: Fixed an issue where the companion badge disappeared after sync. D1 relational table `continue_watching` now encodes companion metadata into `show_title` as `COMPANION:{...}`, safely preserving `isCompanion`, `companionType`, `companionNote`, `companionStoryline`, and `precedingShowId` across D1 and Creator Sync without breaking the database schema.
  - **Immediate Companion Injection & Completed Show Eviction**: Fixed an issue where marking a show watched did not immediately recommend the companion item or remove the completed show from Continue Watching. `markShowWatched` now synchronously evicts all aliases of the completed show and injects the storyline companion into Continue Watching, immediately refreshing local storage and the creator dashboard.
  - **Completed Show Exclusion & Catalog Routing**: `fetchAutoTrackedCatalog` in `05_catalog-core.js` now queries `creator_show_states` for `is_fully_watched = 1` and excludes completed shows from Continue Watching in both D1 and KV fallback paths. Companion movies are now properly categorized as `type: 'movie'` and routed to Movie catalogs rather than Series catalogs.
  - **Stremio & Nuvio Companion Poster Badges**: Added `companion` query parameter support to `/api/poster-badge` and `applyBadgedPostersToMetas`, rendering dynamic blue accent companion badges directly on catalog poster artwork in Stremio and Nuvio.
  - **Item Compaction Preservation**: Updated `compactCustomListItem` in `22_client-creator-profile.js` to preserve `isCompanion`, `companionType`, `companionNote`, `companionStoryline`, and `precedingShowId` across local storage compaction and quota passes.

### 🔍 Search resilience (2026-09-11)
- **Title search resilience against typos, missing spaces, and merged words.**
  - Added `generateSearchVariations` in `25_api-catalog-routes.js` to automatically generate query candidates for merged words (`pickup` &rarr; `pick up`), glued numbers (`matrix4` &rarr; `matrix 4`), camelCase words, and hyphen variations when TMDB direct search returns no results.
  - Added Cinemeta fuzzy/trigram search fallback in `/api/title-search`: when TMDB returns 0 results for a misspelled or deformed title, Cinemeta's elastic index matches the title and resolves matching IMDB IDs via TMDB `/3/find/`, returning rich TMDB results for previously zero-hit queries like *"Is it wrong to pickup girls in the dungeon"*, *"Interstelar"*, or *"Breakingbad"*.
  - Added query variations fallback to `executeUnifiedListSearch` (`19_client-search-and-likes.js`) so list searches also catch merged words.

### 🔍 Content filter (2026-09-11)
- **Adult content filter now correctly blocks NSFW results in the Lists search tab.** Searching "Lists" for an adult collection (e.g. "Top Wet Girls") previously returned results with raw NSFW posters. Fixed by:
  - `/api/tmdb-search-lists` now passes `&include_adult=true` to TMDB's collection search (so adult collections surface at all), detects each collection's adult status via both the `adult` boolean flag and `isAdultOrNsfw()` keyword matching, and replaces the poster with a safe placeholder when the adult content filter is active.
  - The client's `fetchListSearchResults()` now appends `&adultContentFilter=1` to the `/api/tmdb-search-lists` request when the filter is enabled, so the server knows to apply safe-poster logic.
  - `mapTmdbItem()` (`07_source-fetchers-tmdb-simkl.js`) now calls `isAdultOrNsfw()` in its `isAdult` calculation so items whose TMDB `adult` flag is absent but whose title matches explicit keywords are still tagged correctly.
  - Preserved `adult`, `isAdult`, `genres`, and `certification` fields through `extractMdblistItem()` and `mapMdblistItems()` in `06_source-fetchers-mdblist-trakt.js`, and restored the `releaseYear` variable that was accidentally dropped from `extractMdblistItem()` during that change.
  - Previously added (prior session): `isAdultOrNsfw()` keyword detection on both worker-side (`05_catalog-core.js`) and client-side (`19_client-search-and-likes.js`), safe poster substitution via `resolveClientPoster()`, adult detection in `fetchTmdbCollection()`, and `adultContentFilter` propagation through `fetchCatalog()` and `/api/title-search`.

### 🔒 Security & privacy
- **Cross-account data destruction (critical).** An account purge built its D1 delete from a SQL `LIKE` pattern containing the username, and `_` is LIKE's single-character wildcard — so deleting the account `a_c-films` also deleted every list belonging to `abc-films`, `axc-films` and so on. Usernames of all underscores are legal, so this needed no credentials to weaponise. Now an indexed equality on the username column.
- **Stored XSS via imported lists (critical).** Ids from an imported list or channel were interpolated into markup unescaped, so opening a shared list could execute script in the victim's page and read their Creator Key out of `localStorage`. Escaped at every sink, with the delivery path closed.
- **One account's data under another account's name.** Signing in as a second account while the first account's sync response was still in flight rendered the first account's lists, liked lists and catalog rows under the second account's name. A load now checks it still belongs to the account that asked for it.
- **Signup published your Watchlist.** Creating a profile migrated local lists to the account — including the Watchlist, as `public`. It migrates privately now, and creating a profile while already signed in no longer moves the previous account's lists into the new one.
- **Support threads were an open mailbox.** Thread ids were `Math.random()` (~31 bits, recoverable state) and granted read access to free-text reports plus the contact address the form asks for; anyone could also append to any thread and choose the sender name shown. Ids are now 72 bits of CSPRNG, appends to an account's thread require that account's key, the sender is proven rather than claimed, and the lookup endpoint is rate-limited.
- **Account takeover by guessing the recovery answer.** The only throttle was per-IP, which rotating IPs defeat. Added a per-account daily failure budget (atomic on D1), a minimum entropy requirement on the answer at creation, and the same budget on the other credential endpoints.
- **A deleted account could still authenticate.** A colo holding a cached pre-deletion record kept accepting the old key. A strongly-consistent D1 tombstone (`creator_tombstones`) now answers that from anywhere on the next request.
- **Private lists were visible to a probe.** `/api/lists/like` answered differently for a private list than for one that does not exist. Both now return the same generic 404.
- **Media-server webhooks stopped carrying your key.** Plex/Nuvio scrobble URLs contained `creator` + `key` in the query string. They now use a scoped, revocable token that authorises exactly one thing — recording playback — and is revoked when the account is deleted. Existing key URLs keep working, because they are sitting inside people's media servers.
- **SSRF and open redirect** closed in the poster-badge endpoint; `/api/preview` URLs allowlisted; CORS `*` dropped from creator and like JSON; the fflate script from jsDelivr integrity-pinned; admin 401s and every other error response made uncacheable; every account-scoped response moved onto a private-by-default helper at the boundary, so a new route cannot forget.
- **Admin key comparison no longer leaks its length** — both sides are digested first, so the comparison runs over the same length whatever was submitted.

### 🔁 Multi-device sync
- **An installed PWA no longer overwrites the account with its stale copy.** A re-launched PWA begins with no idea what version the account is on, and its start-up timers reached the save endpoints before the first load answered — so changes made on the desktop (a removed Watch History item, a dismissed Continue Watching show, a deleted list, an edited catalog row) came back a few minutes later on the phone. Pushes now wait for the first load, the versions each push cites survive a page load, and `save-tracking` refuses a push built on a version another browser has already replaced.
- **A list deleted on one device stays deleted on the others.** The account now records its own deletions, so a browser still holding a local copy drops it instead of helpfully uploading it back.
- **A resumed device no longer re-adds what another device removed** from Watch History, Continue Watching or the Watchlist.
- **A list changed on another device now refreshes on resume** — the resume poll gained a fifth stamp for custom lists, which the four sync-blob stamps could never have carried.
- **Two devices editing one list** no longer silently lose the older edit: the same conflict guard the sync blobs have, extended to the list write, with the version reported back on save.
- **Concurrent list creation stopped dropping list-order entries** (12 creations, 12 records, 9 order entries before; 12 now).

### 📋 Lists, counts and Discover
- **See All shows the list's real size.** A 303-item chart said "100 items" — the first page's length, printed as a total, and pinned there when a Discover card handed the same 100 through as an exact count. Trakt's own item count is now carried through, a total that the loaded items have overtaken is discarded, and a source that cannot report one says "100+" until the last page lands.
- **See All shows the real size for TMDB and MDBList too.** The Trakt fix above only ever landed for Trakt. Two things kept the others on "100 until you scroll": TMDB's user lists and collections never reported a total at all, and the ones that did (MDBList lists, every TMDB chart) had it thrown away by the cache — a count hung on an array does not survive `JSON.stringify`, so it survived a hit in isolate memory and vanished on a KV or edge hit. The count now travels beside the rows in the cached envelope, TMDB lists report an exact total whenever one is knowable, and collections report their own length.
- **Runaway duplicate lists.** One account had 129 list records for 22 real lists (44 copies of one of them) because a save that asked for a slug was silently given a different one and the dashboard re-uploaded the "missing" list forever. The save is idempotent now, the dashboard cannot loop, and the orphan sweep recovers records whose order entry was lost.
- **Never allocate a slug that is already taken** — publishing a 501st list called "Movies" used to replace the contents of `movies-500`.
- Channel "See All" gives every episode its own id instead of collapsing a show into one tile; Trakt popular lists are typed correctly and addressed by slug; imported lists keep their name and type when the URL carries a query string; episode and season posters fall back to the show's artwork when the specific image is missing.
- Removing one Watch History item no longer rebuilds the whole grid, and a grouped show tile removes from the list it is actually in.
- **Trakt community lists and See All preview resiliency.** An expired or invalid personal Trakt access token (such as one restored from an old backup) no longer causes public Trakt community lists on Discover or search to fail with 401/403 errors ("Couldn't load previews for this list." / "Couldn't load that list."). The worker automatically falls back to unauthenticated public fetches on 401/403, and the client scopes `traktAccessToken` strictly to the user's own account lists.
- **Watch History episode still backfill negative caching.** Fixed console 404 spam for shows without episode stills or seasons on TMDB (e.g. WWE SmackDown `tt9568676`) by recording 404 responses in `myListAddon:episodeStillChecks`, caching show-level missing status, and serializing checks per show to prevent redundant parallel requests.
- **Broken poster image fallback.** Added `onerror="handlePosterImgError(this)"` to list card mini posters so broken external or Metahub URLs fall back to title tiles without logging errors.
- **Discover panel layout unification and Curated Collections removal.** Unified all Discover subnav tabs (`All`, `Movies`, `Shows`, `Popular Lists`, `Curated`, `Hidden Gems`, `Kids`, `Holidays`, `Genres`) to wrap their headers, descriptions, and list feeds in a main `<div class="panel">` container matching the `Channels -> My Channels` layout instead of disconnected floating card headers. Removed the static "Curated Collections" section from Discover's Curated feed in favor of personalized recommendation shelves.
- **Large channel storage quota ladder & "See All" resolution.** Fixed repetitive browser `QuotaExceededError` exceptions when creating or syncing large virtual TV channels (up to 5,000 items) by implementing an in-memory cache, `sessionStorage` mirroring, stripped duplicate URLs (`thumbnail`, `showPoster`), and a multi-tier storage ladder (full map -> 1000 items -> 300 items -> session fallback) in `saveLocalChannelsMap`. Enhanced `openChannelDetailsPage` and `renderMyCreatedChannelsList` with multi-tier lookup (memory cache, map values, `#lists` rows) and clickable titles so channels with thousands of items reliably open in "See All" and never enter repeated synchronization loops.
- **Continue Watching badge enrichment for Stremio and Nuvio.** `fetchAutoTrackedCatalog` in `05_catalog-core.js` now cross-references `airing_next` records (from both D1 and KV) for matching shows, enriching Continue Watching items with upcoming `airDate`, `isSeasonPremiere`, `isSeasonFinale`, `seasonFinaleAirDate`, and `seasonFinaleEpisodeNumber`. Downstream `applyBadgedPostersToMetas` now generates badged poster URLs (`/api/poster-badge?...`) for Stremio and Nuvio catalogs, matching the badges in Live Preview & Editor.
- **Season "Mark Season Watched" button false-positive fix.** In `19_client-search-and-likes.js`, `isSeasonFullyWatched` previously checked the global show-level `window._fullyWatchedShowIds.has(sid)`. Because `_fullyWatchedShowIds` tracks show-level catchup/dismissal state, checking it caused past unwatched seasons (e.g. NCIS Season 6) to flip from `Mark Season Watched` to `✓ Mark Season Unwatched` as soon as season episodes were expanded. Removed the show-level check from `isSeasonFullyWatched`, guarded against empty episode sets, and ensured accurate season watch detection.
- **Trakt lists with seasons/episodes and TMDB collection preview resolution.** Trakt custom lists containing season and episode entities (such as *Popular Returning TV Shows*) previously returned 0 items because `/items/shows` filtered out all non-show entries; `fetchTrakt` now queries `/items/shows,seasons,episodes` when `type: "series"`, and `mapTraktItems` resolves season/episode entities to their parent show's IMDb or TMDB ID. TMDB collections and lists containing items lacking IMDb IDs (such as *New Tunnel Warfare*) now preserve `tmdb:<id>` rather than dropping items. `fetchPreviewForSlot` in `19_client-search-and-likes.js` falls back to the alternate media type if the primary type returns 0 items, and `loadPosterSlot` renders an informative empty state ("No items found in this list.") when a list is legitimately empty instead of failing into an error state with an unrecoverable Retry button.
- **TV Crossover, Companion Movie & Anime Canon Event Registry Expansion.** Added 56 verified crossover events, TV-to-movie sequels/prequels, and anime canon bridge movies to `TV_CROSSOVER_EVENTS` in `20_client-channel-builder.js` from `crossover_and_companion_guide.md`. Covers live-action continuations (*Peacemaker/The Suicide Squad*, *The Batman/The Penguin*, *Battlestar Galactica Miniseries*, *Star Wars: The Clone Wars*, *Twin Peaks*, *Veronica Mars*, *Power Rangers Zeo/Turbo*, *The Transformers 1986*, *Sex and the City*, *Monk*, *Luther*, *Burn Notice*, *Farscape*, *CSI: Immortality*, *The Sopranos/The Many Saints of Newark*, *Entourage*, *The Librarians*, *Gomorrah/L'immortale*, *Spartacus*, *The Venture Bros.*, *Metalocalypse*), animated series with canon movies (*The Simpsons Movie*, *South Park: Bigger, Longer & Uncut*, *The Bob's Burgers Movie*, *Batman: Mask of the Phantasm*, *Steven Universe*, *Tangled: Before Ever After*, *Lilo & Stitch*, *Jimmy Neutron*, *Rugrats Trilogy*, *Beavis and Butt-Head Do America*, *Buzz Lightyear of Star Command*), multi-show crossover events (*Scandal/HTGAWM*, *The Simpsons Guy*, *Scoobynatural*, *X-Cops*, *That's So Suite Life of Hannah Montana*, *Wizards on Deck with Hannah Montana*, *Jimmy Timmy Power Hour Trilogy*, *iParty with Victorious*, *Ben 10 & Generator Rex: Heroes United*, *The Grim Adventures of the KND*), and anime canon continuation films (*Dragon Ball Super: Broly & Super Hero*, *Made in Abyss: Dawn of the Deep Soul*, *KonoSuba: Legend of Crimson*, *Sword Art Online: Ordinal Scale*, *Rascal Does Not Dream*, *Steins;Gate: Load Region of Déjà Vu*, *The Disappearance of Haruhi Suzumiya*, *Haikyu!! The Dumpster Battle*, *The Quintessential Quintuplets Movie*, *Cowboy Bebop: Knockin' on Heaven's Door*, *Fullmetal Alchemist (2003) / Conqueror of Shamballa*, *Gintama: The Very Final*, *No Game No Life: Zero*, *Isekai Quartet*). All entries feature verified IMDb/TMDB IDs, Metahub poster URLs, story-order sequence indices, reactive Channel Builder suggestions with 1-click splicing into draft lineups, and updated `getStorylineCategories` mapping for genre filtering in *Storylines & Universes*.
- **Anime Unpacking: Restoring Multi-Season Division for Compressed Anime Shows.** Fixes TMDB cataloging that compresses entire anime series into a single monolithic season (e.g. *MASHLE: MAGIC AND MUSCLES* 24 episodes into Season 1 [12 eps] and Season 2 [12 eps], *Re:ZERO* 85 episodes into S1–S4, *Jujutsu Kaisen* 59 episodes into S1–S2). Fixed a critical condition in `resolveUnpackedShowData` that skipped fetching `/tv/{id}/episode_groups` when TMDB `/tv/{id}` returned no preloaded groups. Filtered out unreleased/announced placeholder stub seasons from Cinemeta fallback responses. Added automatic multi-season cache upgrading in `fetchTmdbItemDetails` so shows cached in KV or memory before unpacking immediately upgrade to multi-season structures across `/api/details`, `/api/show-seasons`, `/api/show-episodes`, and `/api/season`.
- **Continue Watching Older Season Badge Suppression in Live Preview & Editor.** Fixed an issue where Continue Watching cards for shows on older seasons (e.g. *Grand Blue Dreaming* watched on Season 2 while Season 3 is airing) incorrectly displayed season finale badges (e.g. `FINALE: SEP 22`) in Live Preview & Editor. `/api/preview` now carries `showId`, `seasonNum`, `episodeNum`, and badge flags in sample items; `livePreviewPosterHtml` and `renderCreatorPreviewCards` compute `effectiveSeasonNum` with fallback to `season` and local Continue Watching storage rather than falling back to the airing season; `05_catalog-core.js` and client preview renderers enforce `isOlderSeason` to explicitly strip and suppress finale/premiere badges whenever the watched season is older than the currently airing season.
- **Continue Watching Current Season Episode 1 Finale Badge & Premiere Consistency.** Fixed an issue where Continue Watching did not display the upcoming season finale badge (e.g. `FINALE: SEP 22`) on Episode 1 of the current season (e.g. *Grand Blue Dreaming* S3E1 "Unfinished Business") after watching the last episode of the previous season. Previously, the client required marking Episode 1 as watched (`currentEpNum >= 2`) and `advanceContinueWatchingShow` in `21_client-custom-list-builder.js` unconditionally treated any Episode 1 as an un-aired premiere (`isPremiere`), clearing `seasonFinaleAirDate`. Updated `advanceContinueWatchingShow` to set `isPremiere` only when Episode 1 has not yet aired (`!aired`), preserving `seasonFinaleAirDate`. In `05_catalog-core.js`, corrected `isSameEpisode` check to match both `seasonNum` and `episodeNum` (preventing Continue Watching Episode 1 from inheriting future air dates from Airing Next Episode 11), and restricted `isSeasonPremiere` to unaired future episodes. Updated `livePreviewPosterHtml` (`23_client-list-management.js`) and `buildLocalListCardHtml` (`22_client-creator-profile.js`) so that already-aired Episode 1s on the current season reliably display the upcoming `Finale: [Date]` badge and do not display a Season Premiere badge, ensuring badge consistency between Your Custom Lists and Live Preview & Editor.
- **Adult Content Filter & Safe Poster Replacement (like `aiometadata`).** Added a dedicated "Adult Content & Poster Safety" toggle in Settings (`adultContentFilterCheckbox`) to filter NSFW posters and replace unfiltered default posters with safe, age-appropriate vector poster artwork across all catalogs, preview cards, search results, Continue Watching, and Watch History. Supports seamless persistence via `localStorage` (`myListAddon:adultContentFilter`), configuration short-links, and profile sync payloads. The worker generates high-quality SVG posters on `/api/safe-poster` displaying the title, release year, media type, and age-appropriate certification badges (e.g. `NC-17`, `X`, `XXX`, `R18+`, `18+`, `RX`) with an active safety shield indicator. Automatically detects adult content by explicit flags (`adult`, `isAdult`), adult certifications, and NSFW genres (`Hentai`, `Ecchi`, `Erotica`, etc.), and dynamically replaces posters in Stremio/Nuvio catalog feeds, `/api/preview`, Live Preview & Editor, and dashboard card renderers.


### ⌨️ Frontend, accessibility and offline
- **The admin dashboard was dead for two days.** A single backslash inside a template literal turned the whole 60 KB inline script into one `SyntaxError`, and nothing in CI rendered that page. It renders and is syntax-checked now, along with the builder page and the service worker.
- **Modals are usable from a keyboard**: Escape closes, focus is trapped and restored, ARIA roles are correct, and the scroll lock actually locks (it never had) and is always released.
- **The PWA opens offline** — the service worker warms the shell on install, serves it when the network fails, and cannot pin a stale build.
- A restored backup can no longer permanently kill the Discover feed; an obsolete search response can no longer overwrite a newer one; a non-array `dashboardListOrder` no longer takes down the dashboard; the "Settings" label is no longer clipped at 320px.
- **Tabs no longer nudge the whole page sideways.** Discover › Hidden Gems, Catalogs › Bulk Add, Lists › Liked and Import, and Channels › Quick Add and Import are all short enough to fit without scrolling; the classic scrollbar went away with them and the centred page slid right. The scrollbar gutter is reserved for the document now, so the layout no longer depends on which tab is showing.
- **The installed PWA's system bars follow dark mode.** The status bar and the strip holding the home indicator stayed white however dark the page was, because the document never declared its colour scheme and never reached into the safe areas. It declares `color-scheme` in both themes, paints the root canvas, and `viewport-fit=cover` finally makes the `env(safe-area-inset-*)` padding this app has always written mean something. The guide page got the same treatment — it opens inside the PWA too.
- **The Search tab stops reloading itself.** Coming back from a poster, from See All or from another tab re-ran the whole default view — a round trip, plus one `/api/preview` per card on the Lists chip — and so did every press of the Movies / Shows / Lists chips, in both directions. What was rendered is kept and re-shown; only a change to the chip, the query or a filter goes back to the network.
- **The four odd buttons in Settings match the rest.** Open the Guide, Buy me a coffee, Try TorBox Debrid and Import were accent blue with white text. The two links needed a class pair to get there: `button, .actions a` is more specific than a bare `.lc-btn`, so no modifier class on an `<a>` inside `.actions` could reach them.
- **A double-clicked signup** no longer creates an account nobody can sign into.
- **Provider writes that were refused are reported as refused**, instead of being shown as success.

### 🛠️ Admin & operations
- **D1-authoritative admin creator list & published list browse and delete:** `/admin/api/creator-lists` now queries the D1 `creator_lists` table directly (matching Phase 2 authoritative storage), resolves username aliases and display names (e.g. matching `canadutchy` and `cana-dutchy`), and merges with any unmigrated/phantom KV records. `/admin/api/delete-creator-list` and `deleteCreatorLists` accurately recognize D1 deletions using `meta.changes`, report deleted items under `deleted` rather than `missing`, and accurately report remaining counts from D1. The admin UI automatically refreshes remaining lists upon deletion. `/admin/api/published-lists` also falls back to D1 `published_lists` when KV keys are absent.
- **Browse a creator's lists.** The delete tool takes exact slugs and nothing could tell an operator what they were — unworkable against an account carrying dozens of copies of one list under unguessable slugs. The admin panel now lists the stored records (including ones missing from the creator's display order, flagged), filters by name, and selects them all.
- **Anonymously published lists can be removed.** `publishedlist:user:*` had no delete path in any route; there is now a paged browse and a delete that shares the record, ledger and directory sweep with the creator path.
- **A failed delete says what it removed** before it stopped, instead of only "Failed".
- **The Worker can say when it is running ahead of its own database** (`/admin/api/schema-status`), and the KV→D1 migration is resumable and repairs stale rows rather than only inserting missing ones.
- The public list directory is re-derived daily, rebuilt in resumable chunks, and no longer breaks permanently past ~500 lists; making a list private takes it out of the directory immediately, even if the index write fails.

### ⚙️ Performance & reliability
- **D1-backed normalized creator sync and tracking tables (Phase 4).**
  - **Relational tracking tables (`watch_history`, `continue_watching`, `airing_next`, `creator_show_states`, `creator_tracking_meta`):** Split monolithic per-user sync blob `creatorsynctracking:{user}` into 5 relational tables. Endpoints `/api/creator/sync/load`, `/api/creator/sync/save-tracking`, `/api/creator/sync/meta`, `/api/creator/track-status`, `/api/creator/scrobble`, and `handleSubtitlesTrack` read and write through D1 with KV write-through mirroring. Conflict detection compares incoming `client_version` directly against `creator_tracking_meta.client_version`.
  - **User lists table (`creator_user_lists`):** Extracted `likedLists`, `hiddenLists`, and `hiddenSections` from monolithic `creatorsync:{user}` into relational `creator_user_lists` table with `list_type: 'liked' | 'hidden' | 'hidden_section'`. Read and updated via `/api/creator/sync/load`, `/api/creator/sync/save`, and `/api/creator/sync/like`.
  - **Auto-tracked catalog queries (`fetchAutoTrackedCatalog`):** Directly queries `watch_history`, `continue_watching`, and `airing_next` using indexed lookups, bypassing monolithic KV blob parsing and pagination.
  - **Background episode checker (`checkForNewEpisodes`):** Reads and updates Continue Watching and show states directly in D1 with KV write-through.
  - **Account deletion purge (`purgeCreatorData`):** Drops all rows across all 6 Phase 4 tables upon account reset or deletion.
  - **Database monitor & backfill:** `/admin/api/schema-status` monitors row counts for all 6 tables. Extended `/admin/api/migrate-d1` with phases 9 (`creatorsynctracking:`) and 10 (`creatorsync:`). Adds migration `0010_add_phase4_sync_tables.sql`.
- **D1-backed likes ledger, feedback, telemetry metadata, scrobble tokens, and tombstone pruning (Phase 3).**
  - **Likes ledger (`list_likes`):** Rewrote `applyLikeVote` and `readLikeVoters` to use the `list_likes` table with KV fallback, lazy migration on read/vote, and bidirectional mirroring. Maintains denormalized `creator_lists.likes` and `published_lists.likes` counts. Cleared on list deletes and account purges.
  - **Support feedback (`feedback`):** Replaced KV `feedback:*` prefix scans with direct queries against the D1 `feedback` table for admin feedback dashboard, reply, status, edit, and delete endpoints. Client `/api/feedback` and `/api/feedback/threads` write and query D1 with KV mirroring.
  - **Telemetry & metadata (`event_meta`, `stats`):** Added `event_meta` table for tracked event metadata (`writeEventMetaIfChanged`, `attachEventMeta`). Exploded monolithic `stats:genres:alltime` and `stats:decades:alltime` blobs into atomic rows (`genre:{name}`, `decade:{n}`) in `stats`. Updated `computeAudienceAnalytics` to read normalized rows directly from D1 `stats`.
  - **Scrobble tokens (`scrobble_tokens`):** Scrobble token generation (`getOrCreateScrobbleToken`) executes atomic rotation (`DELETE` old + `INSERT` new) in D1 to prevent stale revocation windows across colos. `usernameForScrobbleToken` queries D1 first to eliminate revocation staleness. Purged on account deletion.
  - **Tombstone pruning:** Added `pruneTombstones` to scheduled cron job (`scheduled()`), cleaning up expired tombstone rows (`until < Date.now()`) from `creator_tombstones` and `list_tombstones` while preserving all telemetry, analytics, and feedback data indefinitely per storage retention policies.
  - **Database monitor & backfill:** `/admin/api/schema-status` returns `databaseStats` (page size, page count, estimated size, and table row counts). Extended `/admin/api/migrate-d1` with phases 5–8 (`listlikevoters:*`, `feedback:*`, `evtmeta:*`, `creatorscrobbletoken:*`) and automatic exploding of genre/decade blobs in phase 4. Adds migration `0009_add_phase3_tables.sql`.
- **D1-authoritative identity and creator lists (Phase 2).** Inverted identity and list read paths: `getCreator` and `getCreatorList` query D1 first as the source of truth with lazy backfill on KV fallback, and write to KV as a read-through cache with self-healing of D1 from fresher KV edits. Removed legacy `authoritativeKeyHash` verification. Replaced KV `creatorlastseen:` writes with direct D1 `creators.last_active` updates throttled by an in-memory isolate memo. Added `sort_order` column to `creator_lists` (driving list display order in `/api/creator/lists` and `/api/creator/lists/reorder` to resolve concurrent list creation race conditions), `lists_stamp` and `share_json` to `creators`, and `list_tombstones` table (`migrations/0008_add_list_tombstones_and_creator_columns.sql`) replacing `creatorlistdeleted:{username}`.
- **D1-backed public list directory and search index (Phase 1).** Retired the legacy 32-shard KV public list index (`index:publiclists*`), build lock, and scheduled cron rebuild step in favor of a direct D1 `UNION ALL` query over `creator_lists` and `published_lists` (filtered by `visibility = 'public'` and ordered by `likes DESC, updated_at DESC`). List search (`/api/search-published-lists`) now queries SQLite FTS5 (`lists_fts`), populated on list saves and rebuildable via `/admin/api/rebuild-search-index`. Adds `published_lists` table (`migrations/0006_add_published_lists.sql`) and `lists_fts` virtual table (`migrations/0007_add_lists_fts.sql`).
- **An empty reply from a provider can no longer erase a good chart.** A soft-failed upstream answering `200` with nothing counted as a successful refresh and overwrote all three cache tiers at once, exactly when the circuit breaker was needed. Now refused for the caches a provider owns, while a user's own (legitimately empty) list is unaffected.
- Outbound requests are bounded by a timeout; the cron got the same exception boundary the request path has, isolates each account so one failure costs only itself, and advances its cursor over exactly the accounts it processed.
- Two missing database indexes added; the admin counter panels lost a full table scan and a sort.
- The channel image endpoints are bounded and cacheable; the TMDB fan-out endpoints are rate-limited even when the caller supplies their own key.

### 🧪 Testing & CI
- The suite went from 106 tests to **389**, and now covers the client: `tests/client-harness.mjs` evaluates the real builder bundle against a DOM stub, so payload shapes, response handling and state transitions can be tested without a browser.
- The D1 mock was replaced with **real SQLite**, which is what made the whole first adversarial round's findings testable at all — the mock hardcoded one query to return no rows, could never throw, and could not enforce a constraint.
- `verify.sh` and CI now render and validate the builder page, the admin page and the service worker, check that every inline handler resolves, and fail on `FUNCTION-MAP.md` drift.
- Mutation testing is part of the record: every fix was verified twice — the probe that demonstrated the defect passes, and the defect reintroduced by mutation makes the suite fail.

### Earlier unreleased entries
- **Performance:** Fixed account login and navigation lag for accounts with 1000+ items in Watch History by caching parsed tracking payloads in memory (`_memoryCustomListsObj`) and eliminating repetitive main-thread JSON string re-parsing.
- **Fix:** Fixed a runtime crash in `loadCreatorSync` (`ReferenceError: localOnly is not defined`) during tracking sync unpack.
- **Performance:** Restored 0ms instant tab switching and in-memory Discover feeds caching (`_discoverFeedsCache`), matching production smoothness.
- **Fix:** Enhanced `compactCustomListMap` storage compaction to permanently eliminate browser `QuotaExceededError` when saving large accounts.
- **Feature:** Improved list search with external source name search (MDBList, Trakt, TMDB, Simkl, Profile, Streaming), external creator username search, multi-token relevance scoring, and source badges.
- **Fix:** Fixed Mark Season Watched button state resetting on refresh and fixed episode checkmarks lingering after clicking Mark Season Unwatched.
- **UI:** Renamed "Creator Profile" to "Profile" across all user-facing interface text, prompts, alerts, and FAQs.
- **Fix:** Fixed browser refresh on Custom Lists returning user to the "My Lists" tab page or dropping items.
- **Fix:** Fixed Continue Watching "See All" items disappearing upon clicking the browser refresh button.
- **Fix:** Fixed Continue Watching fast queue race condition (adding both watchHistory and continueWatching to creatorscrobblequeue).
- **Fix:** Fixed Plex scrobbles using show poster instead of episode still thumbnail in Watch History.

- **Fix:** Plex & Nuvio Continue Watching progression and Plex watched checkmarks.
  - Resolved Continue Watching progression failure: fixed a server-merge race condition in `/api/creator/sync/save-tracking` where incoming browser tracking syncs were overwriting the server's newly computed next episodes with stale client state.
  - Fixed Plex TMDB resolution: fixed a title search nesting bug in `fetchTmdbItemDetailsUncached` that caused non-IMDb Plex scrobbles to fail metadata lookup.
  - Added Creator TMDB Key resolution for Plex webhook handler (`handleMediaServerScrobble`).
  - Enhanced client-side episode watch status checks (`openEpisodeDetails`, `computeWatchBadgeState`) to support composite and title-based fallback IDs.

- **Fix:** Plex re-watch progression and TMDB API usage caching.
  - Added watch history reduction logic to Plex scrobbling (previously only on Nuvio) to accurately handle re-watching old episodes without accidentally reverting your Continue Watching state backwards.
  - Rewired TMDB requests to utilize Cloudflare's native Edge Cache API (`caches.default`) in addition to KV. External TMDB requests were bypassing edge caching on Cloudflare Free/Pro tiers, leading to intense TMDB rate-limiting (and inflated API usage stats in the admin dashboard) which previously caused Continue Watching updates to silently fail.

- **Fix:** Continue Watching next episode updates for Plex and Nuvio.
  - Fixed a string coercion bug when reducing watch history that caused the system to mistakenly fetch the next episode for the *first* watched episode rather than the *latest* one.
  - Added a fallback safety check: if a show's next episode cannot be fetched from TMDB (due to rate limits, server timeouts, or metadata agent mismatches from Plex), the previous Continue Watching state is now safely restored rather than permanently dropping the show.

---

## [1.5.3] - 2026-09-08

Closes the last open items from `AUDIT-2026-09-08-ADVERSARIAL-III.md`. Every finding in that report is now
either fixed or a recorded decision; nothing is deferred.

### ⚠️ Action required only if you are on the Workers **Free** plan

Three paths that used to exceed Cloudflare's 50-subrequest cap now work to a budget, and each budget is an
environment variable. Two default to the free-safe number and need nothing from anyone. The third,
`CRON_SUBREQUEST_BUDGET`, defaults to **10000** — the Paid number — because pacing it below one chart's worth
switches chart pre-warming *off* and drops the Continue Watching sweep to 8% of its throughput, which is a
feature going dark rather than a slower path to the same place.

**On a free Worker, set `CRON_SUBREQUEST_BUDGET` to `48`.** Dashboard deploys: your Worker → Settings →
Variables and Secrets → Add variable (type *Text*). You then get a tick that **completes** — Continue Watching
sweeping 12 shows every 6 minutes, which has never worked on a free Worker before — and no chart pre-warming,
because no free-plan budget can fit even one chart. Leave it unset on a free Worker and the tick is terminated
outright, exactly as it is today. **On a paid Worker, do nothing.** See README's "Which Cloudflare plan do I
need?".

### 🗑️ Removed

- **`POST /api/publish-list` is gone.** It was unauthenticated, minted a permanent unowned KV record on every
  call, had no caller anywhere in the shipped app, and was the easiest route to a stored payload. Everything
  that *reads* the records it already wrote is untouched: existing anonymous lists still serve at
  `/lists/user/<slug>`, still appear in the directory and in search, and are still browsable and deletable
  from `/admin`. Publishing a list now goes through the authenticated `/api/creator/lists/save`, which is
  owned and deletable by the person who made it.

### ⚡ Scale & cost

- **The directory index is 32 keys, not one.** Every public save, publish and like did a read-modify-write of
  a single key holding the whole directory — 4.45 MB at the 20,000-entry cap — against KV's limit of one
  write per second to a given key. Entries are now sharded across `index:publiclists:s0`…`s31` on a hash of
  the entry id, so a like touches ~1/32 of the blob and the deployment has 32 keys' worth of write throughput.
  A deployment upgrading in place keeps serving from the old key until its first full publish converts it, so
  the directory never serves a fraction of itself.
- **The daily rebuild actually runs now.** Staleness was read from the index blob's own timestamp, which every
  incremental write bumped — so a deployment busy enough to matter looked freshly built forever and never
  re-derived, which is exactly where stranded entries accumulate. It reads a small marker written only by a
  full build.
- **`/api/creator/lists` no longer ships every list's contents.** It returned each list's full `items` array
  on every dashboard render — after every save, delete and tab switch — measured at 15.08 MB for a 1,200-list
  account. It returns `itemCount` and `updatedAt`; the browser fetches the contents of only the lists whose
  version it does not already hold, from the new `POST /api/creator/lists/items`. After a one-list edit that
  is one list's items instead of all of them.
- **`/api/details/batch` fits an invocation.** 180 outbound fetches at its 60-id cap, against the free plan's
  50. It now spends a budget against *real* upstream calls, so a warm Airing Next refresh is still one
  request on either plan and only cold ids are metered; whatever it could not reach comes back as
  `remainingIds` and the client asks again.
- **The cron tick fits an invocation.** ~186 outbound fetches, so on a free Worker Cloudflare terminated it and
  Continue Watching never picked up a single episode. The episode sweep is now budgeted (two fetches per show,
  exactly) and runs *first*, so its work lands before the expensive optional half starts. Chart pre-warming
  rotates through the chart list from a cursor, and is skipped with one explanatory log line when the budget
  cannot fit even one chart — which is any free-plan budget, since one chart is ~105 fetches.
- Rate limits on `/api/details/batch` are charged in **ids**, not requests, so splitting one refresh across
  invocations does not quietly shrink the real ceiling. Same correction `/api/bulk-resolve` got in 1.5.2.

### 🐛 Fixes

- **A card's poster preview could go blank and stay blank.** Reported as "sometimes lists just doesn't load"
  on Discover's sub-nav tabs. Every list card's 9-poster strip is its own `/api/preview` call, up to 40 cards
  at once (5 concurrently, a mixed movie+show card costing two) — enough to occasionally catch its own per-IP
  rate limit or a single upstream timeout, and one failed call was treated as final: nothing rendered, nothing
  logged anywhere visible, and no way back short of a full page reload, since the render is cached once it
  completes and switching tabs away and back just replayed the same blank result. A failed preview now retries
  once automatically, which clears the common case silently; a card that still fails renders a plain
  "Couldn't load previews for this list" message with its own Retry button instead of staying blank.
- **Discover's sub-nav tabs get a header and a Refresh button.** Movies, Shows, Hidden Gems, Kids, Holidays and
  Genres had neither — Popular Lists and Curated, two pills over, had both. All six now show the same header
  shape with a title matching the pill and a Refresh button, which forces a real re-render rather than the
  cached one and so is also a manual way to clear the poster-preview failures above.
- **"KV put() limit exceeded for the day."** Marking a support thread done started failing on the live site,
  and the cause was nowhere near the admin panel: the two telemetry recorders were still on KV. Every tracked
  title cost **four** KV writes — a day-counts blob, a running total, a day index and a display blob — so a
  browser posting a ten-title batch spent 41 of the free plan's 1,000 writes a day, and roughly 250 watched
  titles exhausted the allowance for *everything*, admin actions included. A search cost three more. Counters
  moved to D1 where D1 is bound, which is the same move `bumpStat` made a while back and these two never
  followed. **No migration to run:** `stats` is keyed `(kind, day)` and its `kind` dimension was already
  unbounded, so `evt:{type}:{id}` and `searchq:{q}` go in beside the counters already there. A ten-title batch
  now costs one write per *newly seen* title and nothing at all on a repeat; a search costs nothing.
  - On the Trending and Search & Queries panels, a D1 deployment's numbers start from the switchover. The KV
    history stays under its existing TTL (120 days daily, 400 all-time) and is not merged in — merging would
    double-count every day both paths wrote.
  - Deployments with **no D1 bound are unchanged** and still read and write KV, with the two wasteful writes
    fixed there too: neither the day index nor the display blob is rewritten when its contents have not
    changed, and the display blob refreshes at most once a day per title (immediately if the title or media
    type actually changed). That is one KV read traded for one KV write, which on the free plan is 100 000
    reads a day against 1 000.
  - "Backfill Existing Data" follows the counters onto D1. Left on KV it would have run to completion, reported
    its title counts, and left the All Time board showing nothing.
- `/api/external-list/create` returned HTTP 500 and an internal error string when a body field was not a
  string. Fixed there and at the six sibling sites in the same file with the same shape.
- `/api/creator/reset-key` answered HTTP 200 on every failure. Throttles answer 429, credential failures 401 —
  with the message byte-identical across all of them, so the status codes say nothing the body did not.
- Removed `runListSearch()`, the one function in the client bundle with no reference of any kind.

### 📖 Documentation

- README: the three subrequest budgets and what each default costs; that the install link is a bearer
  credential carrying your provider tokens and Creator Key; that an admin session can only be revoked by
  rotating `ADMIN_KEY`; and that `POST /api/creator/sync/share-tracking` is supported but API-only.

### 🧪 Tests

464 pass, 1 skipped (up from 401). Twenty-three mutations — one per behaviour this release introduces — each
caught by the test written for it. Two test helpers were quietly not testing what they claimed: a cron tick was drained
with a single snapshot of `ctx.waitUntil`, so background work registered *by* that work was never awaited, and
the tests only passed because the pre-warm slept long enough between charts.

---

## [1.5.2] - 2026-08-31

### 🛠️ Sync & Live Preview Fixes
- **Watch Tracking Sync Debounce Accumulation**:
  - Fixed a race condition in `scheduleTrackingSync` where concurrent UI events wiped out the `intentionalRemoval` flag, causing unwatched episodes/seasons/shows and removed Continue Watching/Watch History items to revert after <1 second.
  - Ensured `toggleWatchStatus`, `toggleBatchWatchStatus`, and `dismissContinueWatchingShow` pass the intentional removal flag to permanently remove items in server KV.
- **Airing Next Multi-ID Deduplication**:
  - Captures canonical `tmdbId` to prevent the same upcoming episode from showing multiple times when Watch History stores mixed ID formats (`tt...`, `tmdb:...`).
- **Continue Watching Cross-Format Show Deduplication**:
  - Enhanced `dedupeContinueWatchingItems` to deduplicate shows across different ID formats using normalized show titles as a fallback.
- **Live Preview & Catalog Flashing Prevention**:
  - Added configuration payload hashing in `loadCreatorSync` to prevent tearing down the `#lists` DOM when only timestamps change during periodic background syncs.
  - Updated `renderLivePreview` to preserve existing posters during background data refreshes instead of clearing them out with shimmer skeletons.
- **Creator Sync Foreground Resume Crash Fix**:
  - Fixed runtime `ReferenceError: opts is not defined` crash in `loadCreatorSync`.
- **Large Account Performance Optimization**:
  - Removed 15-second forced full-page re-renders and stopped hidden tabs from generating thousands of image DOM nodes.
- **Continue Watching Badges & Parity Rules**:
  - Enforced complete mirroring between **Your Custom Lists > Continue Watching** and **Catalogs / Live Preview**:
    - **Newest Season**: Episode 1 displays `Season Premiere` (if unaired); middle episodes (2 to N-1) display `Finale: [Date]` (e.g. *Lanterns S01E02* `Finale: Oct 4`, *Reacher S04E02* `Finale: Sep 16`); final episode displays `Season Finale`. Unaired episodes display their upcoming air date badge.
    - **Older Seasons** (e.g. *Tracker S03E01*, *FBI S01E03*, *Reacher S03E01*): Displays no badges when the newest season is a later season.
  - Fixed `ReferenceError: today is not defined` in `isEpisodeAired` (`19_client-search-and-likes.js`) and resolved a syntax error in `22_client-creator-profile.js`.
  - Fixed poster card matching in `livePreviewPosterHtml` so Continue Watching badges in Catalogs / Live Preview mirror Your Custom Lists.
  - Enhanced `refreshAiringNext` to auto-fetch when local items are empty, preventing stalled schedule displays on startup.
  - Expanded server-side Airing Next evaluation limit (Trakt/Simkl/MDBList) from 35-40 up to 90 candidate shows, ensuring all upcoming episodes populate in Live Preview & Editor catalogs.
  - Fixed a massive HTTP 429 rate-limit bug when clicking "Mark all as Watched" on Trakt/Simkl/MDBList history, which previously attempted to redundantly sync thousands of items individually back to external providers.
  - Added an in-memory fallback for Custom Lists that completely bypasses the browser's 5MB `localStorage` limit for logged-in users, seamlessly syncing massive imported lists (8,000+ items) directly to/from the cloud. Offline/unauthenticated users now see a proper "Storage Full" error instead of a silent failure.
  - Added automated retry logic for Continue Watching updates during mass imports to prevent TMDB rate limits (110 of 111 shows failing), and fixed the "run this again" button so it actually retries fetching Continue Watching data even if the watch history is already imported.
  - Fixed a "Zombie" item bug where deleting a show from Continue Watching (or Watch History) and immediately refreshing the page would cause the item to re-appear due to Cloudflare KV propagation delays.
  - Fixed a bug where episodes scrobbled from external Media Servers (Plex, Emby, Jellyfin) would appear in Watch History but fail to show the "Marked as Watched" checkmark when browsing the show's seasons in the UI, and added backwards-compatibility so your existing scrobbles now display correctly.
  - Fixed a race condition where massive Trakt imports (8,000+ items) would vanish if the browser was refreshed immediately after importing, due to Cloudflare KV propagation delays overwriting the volatile RAM fallback; massive lists now correctly fallback to `sessionStorage` to safely survive page reloads.

---

## [1.5.1] - 2026-08-30

### 🌟 Features & Rebuilding Tools
- **Rebuild Custom Lists & Channels from Presets & Links**:
  - Automatically reconstructs deleted or missing custom lists and channels from saved presets or install/configure links into local storage and Creator cloud accounts.
  - Added **"Restore Lists"** under Import from Link and **"Rebuild Custom Lists"** on preset cards.
- **Continue Watching Clear History**:
  - Added **Clear History** button to the Continue Watching detail view filter bar and a dedicated **Clear Continue Watching** button in Settings.

### 🛠️ Fixes & Improvements
- **Cross-Origin & Short KV Link Resolution**:
  - `resolveInstallLinkData` automatically detects remote origins and resolves short KV configs across different worker domains.
- **Saved Presets KV Migration**:
  - Added automatic backward-compatible migration from `creatorsync` to dedicated `creatorsyncpresets` KV storage.
- **Creator Dashboard Custom Lists Sync**:
  - Fixed restored custom lists not appearing under "Your Custom Lists" when logged into a Creator Profile and automated cloud syncing.
- **Watch History & Continue Watching Restoration**:
  - Restoring from saved presets or install/configure links now restores Watch History, Continue Watching, and Watchlist items directly into local storage and cloud KV (`pushTrackingSync`).
- **Multi-Device Background Sync & Foreground Resume**:
  - Added lifecycle listeners (`visibilitychange`, `focus`, and `pageshow`) to automatically pull down updates made on other devices (e.g. desktop to mobile PWA) when resuming the app from the background.
- **TMDB API Request Reduction & Global KV Caching**:
  - Eliminated redundant background catalog trailer enrichment calls (/find + /videos), lowering TMDB requests by ~85-95% and significantly accelerating catalog load times.
  - Added 30-day KV caching for TMDB ID and details resolution across all worker nodes.
- **Centered Season Premiere Badge**:
  - Centered the "Season Premiere" badge horizontally at the bottom of poster cards in Airing Next rows and grids.
- **Season Finale Badges on Airing Next Lists**:
  - Automatically identifies when an upcoming episode is the season finale across Trakt, MDBList, Simkl, and custom lists and displays a centered amber "Season Finale" badge.
- **Season Finale Date Badges for Mid-Season Episodes**:
  - Automatically resolves when the season finale will air for mid-season episodes (Episodes 2–9) and displays a centered "Finale: [Date]" badge.
  - Enforced strict suppression of Season Premiere/Finale badges on already-aired episodes (such as past episodes in Continue Watching or Watch History).
- **Poster Badges & Labels Settings Panel**:
  - Added individual on/off toggle controls in Settings for all poster badges (Air Date, Premiere, Finale, Finale Date, Ratings, Providers, Watched), fully synced via Creator Profile.
  - Added "Display Locations" settings to independently enable or disable badges for **Catalogs & Live Preview**, **Dashboard & My Lists**, and **Stremio & Nuvio Catalogs**.
- **Dynamic Badged Posters for Stremio & Nuvio Catalogs**:
  - Implemented `/api/poster-badge` endpoint that embeds Season Premiere, Season Finale, Finale Date, and Upcoming Air Date badges onto catalog poster artwork inside Stremio and Nuvio clients.
- **TMDB Item Details & Badged Poster Click Fix**:
  - Fixed variable scope issue in server-side TMDB details handler that caused `/api/details` to return 404 for series.
  - Enhanced client-side poster click event delegation to ensure clicking anywhere on a badge or poster properly opens show details and cleans compound episode IDs.
- **Continue Watching "See All" Details View & Badge Enrichment**:
  - Fixed Continue Watching "See All" page to ensure it groups by show (displaying one card per in-progress show with the main Show Poster rather than raw episode still thumbnails).
  - Filtered out already-watched episodes from Watch History, corrected header button to "Clear All", and ensured unaired badges display cleanly alongside the red (X) remove button.
  - Enriched Continue Watching items (both dashboard shelf and "See All" page) to automatically display "Season Finale" (e.g. *Silo*) and "Finale: [Date]" (e.g. *Reacher*, *Lanterns*) badges for upcoming unaired episodes.
- **JavaScript Syntax Fix**:
  - Resolved `Uncaught SyntaxError` on client-side template string line breaks.

---

## [1.5.0] - 2026-08-28

### 🌟 Highlights & Major Additions
- **Airing Next Calendars for Trakt, MDBList & Simkl**:
  - Personalized upcoming episode calendar catalogs (`trakt:user:shows:airing-next` and `mdblist:user:shows:airing-next`), complementing existing Simkl Airing Next support.
  - Analyzes watched history and watchlists, dynamically checks upcoming episode air dates via TMDB, and sorts series chronologically ascending.
  - Features real-time schedule badges (*"Airs today"*, *"Airs Friday"*, *"Season Premiere"*).
  - Dedicated interactive schedule modal and Stremio/Nuvio list preview.
- **Modern Light / Dark Mode Toggle**:
  - Replaced legacy toggle with an iOS/Wako-styled animated circular switch.
  - Custom SVG iconography (radiant 8-ray sun in dark mode, fine-stroke crescent moon in light mode).
  - Smooth 360-degree rotational & scale transitions.
  - Dynamic `<meta name="theme-color">` synchronization between `#000000` (dark) and `#F2F2F7` (light) for native mobile status bar adaptation.
- **Automated Multi-Source Poster Fallback Engine**:
  - Automatically recovers missing posters for classic, obscure, or indie titles where TMDB's `poster_path` is empty.
  - Three-tier fallback cascade: TMDB High-Res Backdrops &rarr; IMDb ID via Cinemeta & Metahub &rarr; Cinemeta Title Search.
  - Integrated into `/api/title-search`, client image error handlers, and the catalog rendering pipeline.

### ⚡ Search & Discovery Enhancements
- **Multi-Page Search Results**:
  - Keyword title searches now query and aggregate up to 100 relevant results in parallel instead of capping at 20.
- **Real-Time Search Filter Dropdowns**:
  - Added instant client-side dropdown filters for **Genre** (16 categories), **Release Year** (1980s to 2026), and **Rating** (5.0+ to 8.0+).
  - Added star rating badges (`★ 8.4`) directly onto search result posters.
- **Top 20 Default Category Previews**:
  - Opening the Search tab or switching category chips (**Movies**, **Shows**, **Lists**) immediately displays the current Top 20 trending items or top-rated community lists.
  - Community lists are ranked by Likes descending and Item Count descending; empty lists (0 items) are excluded.

### 🛠️ Watchlist & Catalog Fixes
- **MDBList Watchlist Add & Sync**:
  - Fixed mutation endpoint authentication (`Authorization: Bearer` and `x-api-key`) and payload structure for adding/removing watchlist items.
  - Multi-endpoint probing across `/watchlist`, `/watchlist/items`, `/sync/watchlist`, and custom list IDs.
  - Fixed ID extractor to normalize numeric TMDB IDs, IMDb IDs, and nested media objects so no items are discarded.
- **"See All" Full List Details for Mixed Lists**:
  - Fixed `/api/preview` to preserve `type: "mixed"` and per-item media types, allowing mixed catalogs and watchlists to properly display all movies and TV shows across category tabs.
- **Infinite Pagination Fix**:
  - Fixed recommended movies/shows catalogs in Stremio/Nuvio to return empty arrays once personal recommendations are exhausted, preventing endless 500-page loops into generic charts.
- **Clean Poster Layouts**:
  - Removed duplicate release years under catalog shelves in Live Preview for a cleaner poster presentation.
  - Removed ~170 lines of duplicate code in list management utilities.

---

## [1.4.1] - 2026-08-26

### Improvements & Fixes
- **Simkl Airing Next Simplification**:
  - Streamlined Airing Next candidate resolution into a unified chronological schedule.
  - Fixed `extended=full` query parameter on Simkl sync requests to ensure accurate episode progress tracking.
- **Admin Dashboard Cleanup**:
  - Removed redundant `[Developer]`/`[User]` prefixes when copying feedback threads to the clipboard.
- **MDBList Rate Limit Handling**:
  - Improved HTTP 429 rate limit diagnostics and user-friendly error banners.

---

## [1.4.0] - 2026-08-20

### Major Features
- **Virtual TV Channel Builder**:
  - Create synthetic linear TV channels and scheduled playlists combining hand-picked TV show episodes and movies into a single catalog row.
  - Custom channel poster generation (`/api/channel-poster`) and quick-add channel presets.
- **Letterboxd CSV Import**:
  - Import Letterboxd export CSV files with automated batch resolution of titles and release years into IMDb and TMDB IDs (`/api/bulk-resolve`).
- **Simkl Integration**:
  - Added Simkl trending charts for Movies, TV Shows, and Anime (Daily, Weekly, Monthly) and OAuth account linking.
- **Creator Profiles & Cloud KV Sync**:
  - Passwordless sync across devices using salted SHA-256 Creator Keys (`CRTR-...`).
- **Admin Analytics Dashboard (`/admin`)**:
  - Telemetry console tracking installs, page views, and API usage counters across TMDB, Trakt, MDBList, and Simkl.
- **PWA & Offline Mode**:
  - Service worker caching (`/sw.js`) and Web App Manifest (`/app.webmanifest`) for standalone mobile and desktop installation.

-- 0011_add_streaming_events.sql
--
-- Backs the "New on Streaming" catalog (tmdb:new-on-streaming[:service]).
--
-- The feature exists because nothing upstream answers the one question the
-- list is about: WHEN did this title land on this service. TMDB's
-- with_watch_providers says a title is on Netflix today and nothing about
-- yesterday; Trakt and Simkl do not model provider catalogs at all. So the
-- add-on observes provider catalogs on the cron tick and records the first
-- sighting itself -- that first sighting is what this table is. Once a row
-- exists it is authoritative forever, which is why this is a real table and
-- not a cache: dropping it does not cost a refresh, it costs the history.
--
-- Run it:
--   Wrangler:  npx wrangler d1 execute my-lists-db --file=./migrations/0011_add_streaming_events.sql
--   Remote:    npx wrangler d1 execute my-lists-db --remote --file=./migrations/0011_add_streaming_events.sql
--   Dashboard: paste the statements below into the D1 Console and Run.
--
-- NOTE FOR ANYONE EDITING THIS FILE: keep every comment on its own line,
-- ABOVE the statement it describes, never trailing a column inside one.
-- A "--" comment runs to the end of the LINE, and the D1 Console (and most
-- copy-paste paths) can collapse this file onto a single line -- at which
-- point the first inline comment swallows the rest of the statement and the
-- console answers "incomplete input: SQLITE_ERROR" with no clue why. This
-- file shipped with its column comments inline and did exactly that. The
-- columns are documented in the block below instead.
--
-- Columns:
--   region          watch_region this sighting is for ('US')
--   service         'netflix' | 'hulu' | ... (a NEW_ON_STREAMING_PROVIDERS key)
--   imdb_id         what Stremio/Nuvio key metas by
--   kind            'movie' | 'series' (this add-on's own entry.type)
--   added_at        first sweep that saw this title on this service
--   last_event_at   what the catalog sorts on: added_at, or a newer episode air date
--   event_kind      'added' | 'episode' -- which of the two put last_event_at where it is
--   season/episode  set with event_kind='episode'
--   seeded          1 = found by the FIRST walk of this service, so its date is the
--                   title's own release/air date rather than an observed arrival.
--                   Every title is "new" the first time you look at a catalog;
--                   backdating the seed generation is what stops day one being a
--                   wall of false arrivals.
--   last_seen_walk  walk generation that last saw this row present
--   removed_at      set when a completed walk no longer finds it

CREATE TABLE IF NOT EXISTS streaming_events (
    region         TEXT NOT NULL,
    service        TEXT NOT NULL,
    imdb_id        TEXT NOT NULL,
    tmdb_id        INTEGER,
    kind           TEXT NOT NULL,
    added_at       INTEGER NOT NULL,
    last_event_at  INTEGER NOT NULL,
    event_kind     TEXT NOT NULL,
    season         INTEGER,
    episode        INTEGER,
    seeded         INTEGER NOT NULL DEFAULT 0,
    last_seen_walk INTEGER NOT NULL DEFAULT 0,
    removed_at     INTEGER,
    name           TEXT,
    poster         TEXT,
    background     TEXT,
    year           TEXT,
    PRIMARY KEY (region, service, imdb_id)
);

-- The only ordering the catalog ever asks for (ORDER BY last_event_at DESC),
-- narrowed by the columns it always filters on first. Without it every page
-- of the shelf sorts the whole table.
CREATE INDEX IF NOT EXISTS idx_streaming_events_feed
    ON streaming_events(region, kind, last_event_at DESC);

-- The sweep's "which of these titles do I already have" lookup, and the
-- episode re-bump's lookup, both go through this one.
CREATE INDEX IF NOT EXISTS idx_streaming_events_tmdb
    ON streaming_events(region, kind, tmdb_id);

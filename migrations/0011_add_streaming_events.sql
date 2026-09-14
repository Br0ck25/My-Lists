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

CREATE TABLE IF NOT EXISTS streaming_events (
    region         TEXT NOT NULL,          -- watch_region this sighting is for ('US')
    service        TEXT NOT NULL,          -- 'netflix' | 'hulu' | ... (NEW_ON_STREAMING_PROVIDERS key)
    imdb_id        TEXT NOT NULL,          -- what Stremio/Nuvio key metas by
    tmdb_id        INTEGER,
    kind           TEXT NOT NULL,          -- 'movie' | 'series' (this add-on's own entry.type)
    added_at       INTEGER NOT NULL,       -- first sweep that saw this title on this service
    last_event_at  INTEGER NOT NULL,       -- what the catalog sorts on: added_at, or a newer episode air date
    event_kind     TEXT NOT NULL,          -- 'added' | 'episode' -- which of the two put last_event_at where it is
    season         INTEGER,                -- set with event_kind='episode'
    episode        INTEGER,
    -- 1 = discovered by the FIRST walk of this service, so its date is the
    -- title's own release/air date rather than an observed arrival. Every
    -- title is "new" the first time you look at a catalog; backdating the
    -- seed generation is what stops day one being a wall of false arrivals.
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
CREATE INDEX IF NOT EXISTS idx_streaming_events_tmdb
    ON streaming_events(region, kind, tmdb_id);

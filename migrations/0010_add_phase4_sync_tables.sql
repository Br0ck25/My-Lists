-- 0010_add_phase4_sync_tables.sql
--
-- Phase 4 of STORAGE-PLAN-KV-D1.md:
-- 1. Adds watch_history (replaces monolithic watchHistory array in creatorsynctracking:*).
-- 2. Adds continue_watching (replaces continueWatching array in creatorsynctracking:*).
-- 3. Adds airing_next (replaces airingNext array in creatorsynctracking:*).
-- 4. Adds creator_user_lists (replaces likedLists, hiddenLists, hiddenMyListsSections).
-- 5. Adds creator_show_states (replaces fullyWatchedShowIds & dismissedContinueWatching).
-- 6. Adds creator_tracking_meta (replaces scalar tracking settings, clientVersion, updatedAt).
--
-- Run it:
--   Wrangler:  npx wrangler d1 execute my-lists-db --file=./migrations/0010_add_phase4_sync_tables.sql
--   Remote:    npx wrangler d1 execute my-lists-db --remote --file=./migrations/0010_add_phase4_sync_tables.sql

-- 1. Watch History (row per user + watched item/episode)
CREATE TABLE IF NOT EXISTS watch_history (
    username    TEXT NOT NULL,
    item_id     TEXT NOT NULL,
    item_type   TEXT NOT NULL,
    title       TEXT,
    poster      TEXT,
    show_id     TEXT,
    show_title  TEXT,
    show_poster TEXT,
    season_num  INTEGER,
    episode_num INTEGER,
    year        TEXT,
    air_date    TEXT,
    watched_at  INTEGER NOT NULL,
    PRIMARY KEY (username, item_id)
);
CREATE INDEX IF NOT EXISTS idx_watch_history_user_watched ON watch_history(username, watched_at DESC);

-- 2. Continue Watching (row per user + show)
CREATE TABLE IF NOT EXISTS continue_watching (
    username    TEXT NOT NULL,
    show_id     TEXT NOT NULL,
    item_id     TEXT NOT NULL,
    name        TEXT,
    poster      TEXT,
    show_title  TEXT,
    show_poster TEXT,
    season_num  INTEGER,
    episode_num INTEGER,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (username, show_id)
);
CREATE INDEX IF NOT EXISTS idx_continue_watching_user_updated ON continue_watching(username, updated_at DESC);

-- 3. Airing Next (row per user + upcoming show episode)
CREATE TABLE IF NOT EXISTS airing_next (
    username                     TEXT NOT NULL,
    show_id                      TEXT NOT NULL,
    item_id                      TEXT NOT NULL,
    name                         TEXT,
    poster                       TEXT,
    show_title                   TEXT,
    show_poster                  TEXT,
    season_num                   INTEGER,
    episode_num                  INTEGER,
    air_date                     TEXT,
    is_season_premiere           INTEGER DEFAULT 0,
    is_season_finale             INTEGER DEFAULT 0,
    season_finale_air_date       TEXT,
    season_finale_episode_number INTEGER,
    updated_at                   INTEGER NOT NULL,
    PRIMARY KEY (username, show_id)
);
CREATE INDEX IF NOT EXISTS idx_airing_next_user ON airing_next(username, air_date ASC);

-- 4. User List Relationships: list_type in ('liked', 'hidden', 'hidden_section')
CREATE TABLE IF NOT EXISTS creator_user_lists (
    username    TEXT NOT NULL,
    list_id     TEXT NOT NULL,
    list_type   TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (username, list_id, list_type)
);
CREATE INDEX IF NOT EXISTS idx_creator_user_lists_lookup ON creator_user_lists(username, list_type);

-- 5. Show States (fully watched shows & dismissed continue watching episodes)
CREATE TABLE IF NOT EXISTS creator_show_states (
    username           TEXT NOT NULL,
    show_id            TEXT NOT NULL,
    is_fully_watched   INTEGER DEFAULT 0,
    dismissed_season   INTEGER,
    dismissed_episode  INTEGER,
    updated_at         INTEGER NOT NULL,
    PRIMARY KEY (username, show_id)
);
CREATE INDEX IF NOT EXISTS idx_creator_show_states_fw ON creator_show_states(username, is_fully_watched);

-- 6. Tracking Metadata & Settings (scalar settings, versioning, conflict tracking)
CREATE TABLE IF NOT EXISTS creator_tracking_meta (
    username                   TEXT PRIMARY KEY,
    track_playback             INTEGER NOT NULL DEFAULT 0,
    remove_watched_watchlist   INTEGER NOT NULL DEFAULT 1,
    scrobble_filter_users      INTEGER NOT NULL DEFAULT 0,
    scrobble_allowed_users     TEXT NOT NULL DEFAULT '',
    scrobble_block_anonymous   INTEGER NOT NULL DEFAULT 0,
    curated_recommendations    TEXT,
    client_version             INTEGER NOT NULL DEFAULT 0,
    updated_at                 INTEGER NOT NULL
);

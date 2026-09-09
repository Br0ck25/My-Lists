-- 0009_add_phase3_tables.sql
--
-- Phase 3 of STORAGE-PLAN-KV-D1.md:
-- 1. Adds list_likes (replaces listlikevoters:*).
-- 2. Adds feedback (replaces feedback:* and the admin list-scan).
-- 3. Adds scrobble_tokens (replaces scrobbletoken:* and creatorscrobbletoken:*).
-- 4. Adds event_meta (replaces evtmeta:*).
--
-- Run it:
--   Wrangler:  npx wrangler d1 execute my-lists-db --file=./migrations/0009_add_phase3_tables.sql
--   Remote:    npx wrangler d1 execute my-lists-db --remote --file=./migrations/0009_add_phase3_tables.sql

CREATE TABLE IF NOT EXISTS list_likes (
    list_id    TEXT NOT NULL,
    voter_id   TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (list_id, voter_id)
);
CREATE INDEX IF NOT EXISTS idx_list_likes_voter ON list_likes(voter_id);

CREATE TABLE IF NOT EXISTS feedback (
    id         TEXT PRIMARY KEY,
    status     TEXT NOT NULL DEFAULT 'open',
    subject    TEXT,
    body_json  TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_status_updated ON feedback(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS scrobble_tokens (
    token      TEXT PRIMARY KEY,
    username   TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scrobble_tokens_user ON scrobble_tokens(username);

CREATE TABLE IF NOT EXISTS event_meta (
    event_type TEXT NOT NULL,
    item_id    TEXT NOT NULL,
    title      TEXT,
    media_type TEXT,
    last_seen  INTEGER NOT NULL,
    PRIMARY KEY (event_type, item_id)
);

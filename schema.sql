-- schema.sql
-- Run it (README.md's D1 section has the full walkthrough):
--   Dashboard: create a D1 database under Storage & Databases, open its
--   Console tab, paste this file's contents, and click Run.
--   Wrangler:  npx wrangler d1 execute my-lists-db --file=./schema.sql
--
-- WARNING: this file DROPs every table before creating it. It provisions a
-- BLANK database and will destroy all existing data. Do NOT run it against a
-- database that is already live. To change the shape of a deployed database,
-- add a file under migrations/ instead.

DROP TABLE IF EXISTS creators;
CREATE TABLE creators (
    username TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    recovery_answer_hash TEXT,
    created_at INTEGER NOT NULL,
    last_active INTEGER
);

DROP TABLE IF EXISTS creator_lists;
CREATE TABLE creator_lists (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'private',
    items_json TEXT NOT NULL DEFAULT '[]',
    likes INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (username) REFERENCES creators(username) ON DELETE CASCADE
);

DROP TABLE IF EXISTS source_groups;
CREATE TABLE source_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    install_count INTEGER NOT NULL DEFAULT 0
);

DROP TABLE IF EXISTS stats;
CREATE TABLE stats (
    -- 'pageviews', 'installs', 'apiuse:tmdb', 'list_copy:top-ten', ...
    -- i.e. the same {kind} that used to sit inside a stats:{kind}:{bucket}
    -- KV key name.
    kind TEXT NOT NULL,
    -- 'YYYY-MM-DD' (Eastern calendar day, see easternDateKey) for a daily
    -- bucket, or the literal 'total' for the all-time one. Same two shapes
    -- the KV keys always had.
    day  TEXT NOT NULL,
    n    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (kind, day)
);

-- Indexes for fast querying.
--
-- These have to match what migrations/0001, 0002 and 0003 leave behind, or a
-- database provisioned the documented way (run this file) ends up a different
-- shape from one that grew through the migrations. idx_creator_lists_likes
-- existed only in 0001, so a fresh deployment did not have it; there is a test
-- that now diffs the two provisioning paths and fails on any such drift.
CREATE INDEX idx_creator_lists_username ON creator_lists(username);
CREATE INDEX idx_creator_lists_visibility ON creator_lists(visibility);
CREATE INDEX idx_creator_lists_likes ON creator_lists(likes);

-- The two the admin dashboard's own queries actually need -- see
-- migrations/0003 for the query plans. Without the first, listing accounts is
-- a full scan of `creators` plus an in-memory sort on every dashboard load;
-- without the second, the Community Lists panel reads roughly half of
-- `creator_lists` and sorts it to return 200 rows.
CREATE INDEX idx_creators_last_active ON creators(last_active DESC, created_at DESC);
CREATE INDEX idx_creator_lists_vis_likes ON creator_lists(visibility, likes DESC, updated_at DESC);

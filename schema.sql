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

-- Indexes for fast querying
CREATE INDEX idx_creator_lists_username ON creator_lists(username);
CREATE INDEX idx_creator_lists_visibility ON creator_lists(visibility);

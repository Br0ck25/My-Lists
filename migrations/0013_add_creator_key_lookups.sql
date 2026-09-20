-- 0013_add_creator_key_lookups.sql
--
-- Maps a deterministic hash of a Creator Key to its username so someone who
-- has their Account Key (and Recovery Answer, if set) can retrieve their
-- forgotten username without admin intervention.
--
-- The table stores:
--   lookup_hash: SHA-256("keylookup:" + key.toUpperCase()) in hex.
--   username: the creator username it belongs to.
--   created_at: timestamp when the lookup was recorded.
--
-- Safe to run against a live database.
--
-- Run it:
--   Dashboard: open this database's Console tab and paste/run the statements below.
--   Wrangler:  npx wrangler d1 execute my-lists-db --remote --file=./migrations/0013_add_creator_key_lookups.sql

CREATE TABLE IF NOT EXISTS creator_key_lookups (
    lookup_hash TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (username) REFERENCES creators(username) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_creator_key_lookups_username ON creator_key_lookups(username);

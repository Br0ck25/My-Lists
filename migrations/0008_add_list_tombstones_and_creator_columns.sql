-- 0008_add_list_tombstones_and_creator_columns.sql
--
-- Phase 2 of the KV/D1 storage plan: makes identity and lists D1-authoritative.
--
-- 1. Adds share_json to creators (replaces creatorshare:{username}).
-- 2. Adds lists_stamp to creators (replaces creatorliststamp:{username}).
-- 3. Adds sort_order to creator_lists (replaces creatorlistorder:{username}).
-- 4. Adds list_tombstones (replaces creatorlistdeleted:{username}).
--
-- Safe to run against a live database.
--
-- Run it (README.md's D1 section has the full walkthrough):
--   Dashboard: open this database's Console tab and paste/run the statements below.
--   Wrangler:  npx wrangler d1 execute my-lists-db --remote --file=./migrations/0008_add_list_tombstones_and_creator_columns.sql

ALTER TABLE creators ADD COLUMN share_json TEXT;
ALTER TABLE creators ADD COLUMN lists_stamp INTEGER;
ALTER TABLE creator_lists ADD COLUMN sort_order INTEGER;

CREATE TABLE IF NOT EXISTS list_tombstones (
    username TEXT NOT NULL,
    slug     TEXT NOT NULL,
    until    INTEGER NOT NULL,
    PRIMARY KEY (username, slug)
);

CREATE INDEX IF NOT EXISTS idx_list_tombstones_user_until ON list_tombstones(username, until);

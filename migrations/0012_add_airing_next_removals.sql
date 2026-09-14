-- 0012_add_airing_next_removals.sql
--
-- Lets a person take one show off the Airing Next shelf without touching
-- anything they have marked watched.
--
-- The removal is stored as the watched episode it was made at, not as a flag,
-- so watching a later episode of that show supersedes it and the show returns
-- to the shelf on its own -- the same shape, and the same reasoning, as the
-- dismissed_season/dismissed_episode pair migration 0010 added next to it for
-- Continue Watching. A removal recorded while nothing was watched is 0/0,
-- which any real episode passes.
--
-- NULL in both columns means "not removed", which is what every existing row
-- gets, so applying this changes nothing about an account that has never used
-- the feature.
--
-- Safe to run against a live database. The Worker checks for these columns
-- before writing them and falls back to the pre-0012 statement when they are
-- absent (see d1HasAiringRemovalColumns), so a deployment that has not run
-- this yet keeps syncing everything else -- it just cannot remember removals.
--
-- Run it (README.md's D1 section has the full walkthrough):
--   Dashboard: open this database's Console tab and paste/run the statements below.
--   Wrangler:  npx wrangler d1 execute my-lists-db --remote --file=./migrations/0012_add_airing_next_removals.sql

ALTER TABLE creator_show_states ADD COLUMN airing_removed_season INTEGER;
ALTER TABLE creator_show_states ADD COLUMN airing_removed_episode INTEGER;

-- 0004_add_creator_tombstones.sql
--
-- A strongly-consistent record that an account was deleted.
--
-- delete-account already writes a KV tombstone (`creatordeleted:{u}`) and
-- authentication checks it. That closes the in-flight race it was written for,
-- but not the propagation one: KV reads are edge-cached, so a colo that has
-- seen neither the tombstone write nor the `creator:{u}` delete answers from
-- its own cached copy and lets the deleted account keep authenticating for the
-- length of that window.
--
-- The obvious fix -- treat a missing `creators` row as proof of deletion --
-- does not work and must not be attempted: a missing row is the documented
-- lazy-migration state, meaning "not migrated into D1 yet", which every
-- accessor in this codebase is built to tolerate. "Deleted" and "not migrated"
-- are indistinguishable in that table by design. Hence a separate one: a row
-- here means deleted, its absence means nothing at all.
--
-- D1 is strongly consistent, so a row written by the delete is visible to the
-- next request from anywhere. The KV tombstone stays as the answer for
-- deployments with no D1 bound, and as the cheaper first check where it is.
--
-- `until` is a millisecond timestamp: rows are only consulted while fresh
-- (long enough to outlast any request and any KV propagation window), so an
-- old row is inert rather than a permanent block on re-registering a name.
-- Nothing prunes them automatically -- one row per deleted account is a
-- rounding error next to the accounts themselves -- but a deployment that
-- wants to can safely delete rows whose `until` has passed.
--
-- Safe to run against a live database, and safe to run twice.
--
-- Run it (README.md's D1 section has the full walkthrough):
--   Dashboard: open this database's Console tab and paste/run the statement
--   below (skip these comment lines).
--   Wrangler:  npx wrangler d1 execute my-lists-db --remote --file=./migrations/0004_add_creator_tombstones.sql

CREATE TABLE IF NOT EXISTS creator_tombstones (
    username TEXT PRIMARY KEY,
    until    INTEGER NOT NULL
);

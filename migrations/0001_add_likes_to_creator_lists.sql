-- 0001_add_likes_to_creator_lists.sql
--
-- Adds the `likes` column that the Worker has always tried to write.
--
-- /api/lists/like runs "UPDATE creator_lists SET likes = ? WHERE id = ?"
-- inside a try/catch. Without this column that statement throws on every
-- single like and the error is swallowed, so likes were silently KV-only:
-- a D1 restore, or any read that trusted D1, would lose every count.
--
-- Safe to run against a live database. ADD COLUMN with a NOT NULL DEFAULT
-- backfills existing rows with 0 and rewrites no data. It is NOT idempotent
-- -- re-running errors with "duplicate column name: likes", which is
-- harmless but means you should only apply it once.
--
-- Run with:
--   npx wrangler d1 execute my-lists-db --remote --file=./migrations/0001_add_likes_to_creator_lists.sql
--
-- Existing counts live in KV and are the source of truth. After migrating,
-- POST /admin/api/migrate-to-d1 to copy them across; until then the column
-- reads 0 for lists that have not been liked again since.

ALTER TABLE creator_lists ADD COLUMN likes INTEGER NOT NULL DEFAULT 0;

-- The public directory orders by popularity; without this it is a full scan.
CREATE INDEX IF NOT EXISTS idx_creator_lists_likes ON creator_lists(likes);

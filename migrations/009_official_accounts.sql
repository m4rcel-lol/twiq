-- ---------------------------------------------------------------------------
-- Official accounts.
--
-- The site's own account carries the Twiq mark instead of a verified tick.
-- A column rather than a hardcoded username: which account is the brand's
-- depends on ADMIN_USERNAME, and it survived being renamed once already.
-- ---------------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_official boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS users_is_official_idx
  ON users (is_official) WHERE is_official;

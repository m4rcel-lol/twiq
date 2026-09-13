-- ---------------------------------------------------------------------------
-- Automated accounts.
--
-- An account can declare that a person runs it. The claim is only accepted
-- when whoever sets it can supply that person's password, so an account
-- cannot name someone who has not handed over their credentials. Clearing
-- the declaration needs nothing: leaving is always allowed.
--
-- ON DELETE SET NULL: if the named person deletes their account the label
-- disappears rather than pointing at nobody.
-- ---------------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS automated_by_user_id bigint REFERENCES users (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS automated_at timestamptz;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_automated_by_not_self;
ALTER TABLE users
  ADD CONSTRAINT users_automated_by_not_self
  CHECK (automated_by_user_id IS NULL OR automated_by_user_id <> id);

CREATE INDEX IF NOT EXISTS users_automated_by_user_id_idx
  ON users (automated_by_user_id) WHERE automated_by_user_id IS NOT NULL;

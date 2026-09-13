-- ---------------------------------------------------------------------------
-- Per-account theme preference. "system" follows the reader's own setting,
-- which is the default; "light" and "dark" override it.
-- ---------------------------------------------------------------------------
ALTER TABLE profile_settings
  ADD COLUMN IF NOT EXISTS theme text NOT NULL DEFAULT 'system'
  CHECK (theme IN ('system', 'light', 'dark'));

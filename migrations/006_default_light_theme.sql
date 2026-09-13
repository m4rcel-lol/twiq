-- ---------------------------------------------------------------------------
-- Light is the default theme. Dark is opt-in, and following the reader's
-- system is a deliberate choice rather than what everybody gets.
--
-- Accounts still sitting on the old 'system' default are moved to 'light';
-- the value stays selectable for anyone who wants it from here on.
-- ---------------------------------------------------------------------------
ALTER TABLE profile_settings ALTER COLUMN theme SET DEFAULT 'light';
UPDATE profile_settings SET theme = 'light' WHERE theme = 'system';

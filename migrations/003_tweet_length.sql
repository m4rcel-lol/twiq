-- ---------------------------------------------------------------------------
-- Raise the Tweet length ceiling from 140 to 300 characters.
--
-- The application enforces the exact limit (TWEET_MAX_LENGTH); this constraint
-- is the backstop that states the rule in the schema. Raising TWEET_MAX_LENGTH
-- above the number here needs a new migration - the application refuses to
-- start otherwise rather than let writes fail at the database.
-- ---------------------------------------------------------------------------

ALTER TABLE tweets DROP CONSTRAINT IF EXISTS tweets_body_check;
ALTER TABLE tweets DROP CONSTRAINT IF EXISTS tweets_body_length;
ALTER TABLE tweets ADD CONSTRAINT tweets_body_length CHECK (char_length(body) <= 300);

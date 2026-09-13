-- ---------------------------------------------------------------------------
-- Quote Tweets.
--
-- A quote is an ordinary Tweet that points at another one; the quoted Tweet
-- is rendered inside it rather than copied, so edits and deletions of the
-- original are reflected wherever it was quoted. ON DELETE SET NULL leaves
-- the quoting Tweet standing with an "unavailable" card, the way a thread
-- survives a deleted parent.
-- ---------------------------------------------------------------------------
ALTER TABLE tweets
  ADD COLUMN IF NOT EXISTS quoted_tweet_id bigint REFERENCES tweets (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS quote_count integer NOT NULL DEFAULT 0;

ALTER TABLE tweets
  DROP CONSTRAINT IF EXISTS tweets_quote_not_self;
ALTER TABLE tweets
  ADD CONSTRAINT tweets_quote_not_self CHECK (quoted_tweet_id IS NULL OR quoted_tweet_id <> id);

CREATE INDEX IF NOT EXISTS tweets_quoted_tweet_id_idx
  ON tweets (quoted_tweet_id) WHERE quoted_tweet_id IS NOT NULL;

-- Being quoted is worth a notification, the same as being retweeted.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('follow', 'follow_request', 'mention', 'reply', 'retweet', 'favorite', 'quote'));

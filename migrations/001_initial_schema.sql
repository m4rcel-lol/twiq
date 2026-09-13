-- ---------------------------------------------------------------------------
-- Twiq initial schema
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ------------------------------- users -------------------------------------
CREATE TABLE users (
  id                  bigserial PRIMARY KEY,
  username            citext NOT NULL UNIQUE,
  display_name        text NOT NULL,
  email               citext NOT NULL UNIQUE,
  password_hash       text NOT NULL,
  bio                 text NOT NULL DEFAULT '',
  location            text NOT NULL DEFAULT '',
  website             text NOT NULL DEFAULT '',
  avatar_path         text,
  header_path         text,
  role                text NOT NULL DEFAULT 'user'
                      CHECK (role IN ('user', 'moderator', 'admin')),
  is_protected        boolean NOT NULL DEFAULT false,
  is_verified         boolean NOT NULL DEFAULT false,
  is_suspended        boolean NOT NULL DEFAULT false,
  suspended_reason    text,
  email_verified_at   timestamptz,
  last_login_at       timestamptz,
  tweet_count         integer NOT NULL DEFAULT 0,
  follower_count      integer NOT NULL DEFAULT 0,
  following_count     integer NOT NULL DEFAULT 0,
  favorite_count      integer NOT NULL DEFAULT 0,
  list_count          integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_username_format CHECK (username ~ '^[A-Za-z0-9_]{1,15}$')
);

CREATE INDEX users_display_name_trgm_idx ON users USING gin (display_name gin_trgm_ops);
CREATE INDEX users_username_trgm_idx ON users USING gin ((username::text) gin_trgm_ops);
CREATE INDEX users_created_at_idx ON users (created_at DESC);
CREATE INDEX users_follower_count_idx ON users (follower_count DESC);

-- ------------------------- settings (split per area) ------------------------
CREATE TABLE user_settings (
  user_id               bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  dm_policy             text NOT NULL DEFAULT 'followers'
                        CHECK (dm_policy IN ('followers', 'everyone', 'nobody')),
  discoverable_by_email boolean NOT NULL DEFAULT true,
  show_sensitive_media  boolean NOT NULL DEFAULT false,
  notify_follows        boolean NOT NULL DEFAULT true,
  notify_mentions       boolean NOT NULL DEFAULT true,
  notify_replies        boolean NOT NULL DEFAULT true,
  notify_retweets       boolean NOT NULL DEFAULT true,
  notify_favorites      boolean NOT NULL DEFAULT true,
  notify_messages       boolean NOT NULL DEFAULT true,
  language              text NOT NULL DEFAULT 'en',
  timezone              text NOT NULL DEFAULT 'UTC',
  trend_scope_type      text NOT NULL DEFAULT 'global'
                        CHECK (trend_scope_type IN ('global', 'country', 'city')),
  trend_scope_name      text NOT NULL DEFAULT 'Worldwide',
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE profile_settings (
  user_id             bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  accent_color        text NOT NULL DEFAULT '#3fa9e0',
  background_color    text NOT NULL DEFAULT '#f5f8fa',
  background_path     text,
  background_tile     boolean NOT NULL DEFAULT false,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- -------------------------------- media -------------------------------------
CREATE TABLE media (
  id           bigserial PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('photo', 'animated_gif', 'video')),
  storage_key  text NOT NULL,
  mime_type    text NOT NULL,
  byte_size    bigint NOT NULL,
  alt_text     text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_user_id_idx ON media (user_id, created_at DESC);

-- -------------------------------- tweets ------------------------------------
CREATE TABLE tweets (
  id                   bigserial PRIMARY KEY,
  user_id              bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body                 text NOT NULL CHECK (char_length(body) <= 140),
  in_reply_to_tweet_id bigint REFERENCES tweets(id) ON DELETE SET NULL,
  in_reply_to_user_id  bigint REFERENCES users(id) ON DELETE SET NULL,
  conversation_id      bigint,
  reply_count          integer NOT NULL DEFAULT 0,
  retweet_count        integer NOT NULL DEFAULT 0,
  favorite_count       integer NOT NULL DEFAULT 0,
  has_media            boolean NOT NULL DEFAULT false,
  is_deleted           boolean NOT NULL DEFAULT false,
  deleted_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tweets_user_created_idx ON tweets (user_id, created_at DESC, id DESC)
  WHERE is_deleted = false;
CREATE INDEX tweets_created_idx ON tweets (created_at DESC, id DESC) WHERE is_deleted = false;
CREATE INDEX tweets_reply_parent_idx ON tweets (in_reply_to_tweet_id) WHERE is_deleted = false;
CREATE INDEX tweets_conversation_idx ON tweets (conversation_id, created_at);
CREATE INDEX tweets_media_idx ON tweets (user_id, created_at DESC)
  WHERE has_media = true AND is_deleted = false;
CREATE INDEX tweets_body_trgm_idx ON tweets USING gin (body gin_trgm_ops);
CREATE INDEX tweets_engagement_idx ON tweets (user_id, (favorite_count + retweet_count) DESC)
  WHERE is_deleted = false;

CREATE TABLE tweet_media (
  tweet_id  bigint NOT NULL REFERENCES tweets(id) ON DELETE CASCADE,
  media_id  bigint NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  position  smallint NOT NULL DEFAULT 0,
  PRIMARY KEY (tweet_id, media_id)
);
CREATE INDEX tweet_media_media_idx ON tweet_media (media_id);

-- ------------------------- retweets & favorites -----------------------------
CREATE TABLE retweets (
  id         bigserial PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tweet_id   bigint NOT NULL REFERENCES tweets(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, tweet_id)
);
CREATE INDEX retweets_user_created_idx ON retweets (user_id, created_at DESC, id DESC);
CREATE INDEX retweets_tweet_idx ON retweets (tweet_id, created_at DESC);

CREATE TABLE favorites (
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tweet_id   bigint NOT NULL REFERENCES tweets(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tweet_id)
);
CREATE INDEX favorites_user_created_idx ON favorites (user_id, created_at DESC);
CREATE INDEX favorites_tweet_idx ON favorites (tweet_id);

CREATE TABLE pinned_tweets (
  user_id    bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tweet_id   bigint NOT NULL REFERENCES tweets(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------- graph --------------------------------------
CREATE TABLE follows (
  follower_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  CONSTRAINT follows_no_self CHECK (follower_id <> followee_id)
);
CREATE INDEX follows_followee_idx ON follows (followee_id, created_at DESC);
CREATE INDEX follows_follower_idx ON follows (follower_id, created_at DESC);

CREATE TABLE follow_requests (
  requester_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (requester_id, target_id),
  CONSTRAINT follow_requests_no_self CHECK (requester_id <> target_id)
);
CREATE INDEX follow_requests_target_idx ON follow_requests (target_id, created_at DESC);

CREATE TABLE blocks (
  blocker_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CONSTRAINT blocks_no_self CHECK (blocker_id <> blocked_id)
);
CREATE INDEX blocks_blocked_idx ON blocks (blocked_id);

CREATE TABLE mutes (
  muter_id   bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  muted_id   bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (muter_id, muted_id),
  CONSTRAINT mutes_no_self CHECK (muter_id <> muted_id)
);

-- ----------------------------- entities -------------------------------------
CREATE TABLE hashtags (
  id          bigserial PRIMARY KEY,
  tag         citext NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hashtags_tag_trgm_idx ON hashtags USING gin ((tag::text) gin_trgm_ops);

CREATE TABLE tweet_hashtags (
  tweet_id   bigint NOT NULL REFERENCES tweets(id) ON DELETE CASCADE,
  hashtag_id bigint NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tweet_id, hashtag_id)
);
CREATE INDEX tweet_hashtags_hashtag_idx ON tweet_hashtags (hashtag_id, created_at DESC);

CREATE TABLE tweet_mentions (
  tweet_id bigint NOT NULL REFERENCES tweets(id) ON DELETE CASCADE,
  user_id  bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (tweet_id, user_id)
);
CREATE INDEX tweet_mentions_user_idx ON tweet_mentions (user_id);

-- --------------------------- notifications ----------------------------------
CREATE TABLE notifications (
  id         bigserial PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id   bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       text NOT NULL CHECK (type IN
               ('follow', 'follow_request', 'mention', 'reply', 'retweet', 'favorite')),
  tweet_id   bigint REFERENCES tweets(id) ON DELETE CASCADE,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_created_idx ON notifications (user_id, created_at DESC, id DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

-- ------------------------- direct messages ----------------------------------
CREATE TABLE conversations (
  id              bigserial PRIMARY KEY,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_last_message_idx ON conversations (last_message_at DESC);

CREATE TABLE conversation_participants (
  conversation_id bigint NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at    timestamptz,
  left_at         timestamptz,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX conversation_participants_user_idx ON conversation_participants (user_id);

CREATE TABLE messages (
  id              bigserial PRIMARY KEY,
  conversation_id bigint NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body            text NOT NULL DEFAULT '',
  media_id        bigint REFERENCES media(id) ON DELETE SET NULL,
  shared_tweet_id bigint REFERENCES tweets(id) ON DELETE SET NULL,
  is_deleted      boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation_created_idx ON messages (conversation_id, created_at DESC, id DESC);

-- ------------------------------- lists --------------------------------------
CREATE TABLE lists (
  id           bigserial PRIMARY KEY,
  owner_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  slug         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  is_private   boolean NOT NULL DEFAULT false,
  member_count integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, slug)
);
CREATE INDEX lists_owner_idx ON lists (owner_id, created_at DESC);

CREATE TABLE list_members (
  list_id    bigint NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, user_id)
);
CREATE INDEX list_members_user_idx ON list_members (user_id);

-- ------------------------------ reports -------------------------------------
CREATE TABLE reports (
  id              bigserial PRIMARY KEY,
  reporter_id     bigint REFERENCES users(id) ON DELETE SET NULL,
  target_user_id  bigint REFERENCES users(id) ON DELETE CASCADE,
  target_tweet_id bigint REFERENCES tweets(id) ON DELETE CASCADE,
  category        text NOT NULL CHECK (category IN
                    ('spam', 'harassment', 'abusive', 'impersonation', 'illegal', 'other')),
  details         text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolved_by     bigint REFERENCES users(id) ON DELETE SET NULL,
  resolved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reports_has_target CHECK (target_user_id IS NOT NULL OR target_tweet_id IS NOT NULL)
);
CREATE INDEX reports_status_idx ON reports (status, created_at DESC);

-- ------------------- credentials / verification flows -----------------------
CREATE TABLE password_resets (
  id         bigserial PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_resets_user_idx ON password_resets (user_id, created_at DESC);

CREATE TABLE email_verifications (
  id         bigserial PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email      citext NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_verifications_user_idx ON email_verifications (user_id, created_at DESC);

CREATE TABLE login_attempts (
  id            bigserial PRIMARY KEY,
  identifier    text NOT NULL,
  ip_address    inet,
  succeeded     boolean NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_identifier_idx ON login_attempts (identifier, created_at DESC);
CREATE INDEX login_attempts_ip_idx ON login_attempts (ip_address, created_at DESC);

-- ------------------------------- trends -------------------------------------
CREATE TABLE trends (
  id           bigserial PRIMARY KEY,
  scope_type   text NOT NULL CHECK (scope_type IN ('global', 'country', 'city')),
  scope_name   text NOT NULL,
  tag          text NOT NULL,
  query        text NOT NULL,
  score        numeric(12, 4) NOT NULL DEFAULT 0,
  tweet_volume integer NOT NULL DEFAULT 0,
  is_manual    boolean NOT NULL DEFAULT false,
  position     smallint NOT NULL DEFAULT 0,
  computed_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope_type, scope_name, tag)
);
CREATE INDEX trends_scope_idx ON trends (scope_type, scope_name, position);

-- ----------------------------- audit logs -----------------------------------
CREATE TABLE audit_logs (
  id          bigserial PRIMARY KEY,
  actor_id    bigint REFERENCES users(id) ON DELETE SET NULL,
  action      text NOT NULL,
  target_type text,
  target_id   text,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address  inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_id, created_at DESC);

-- --------------------------- system settings --------------------------------
CREATE TABLE system_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by bigint REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO system_settings (key, value) VALUES
  ('registration_open', 'true'::jsonb),
  ('announcement', '""'::jsonb)
ON CONFLICT (key) DO NOTHING;

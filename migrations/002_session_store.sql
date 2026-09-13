-- Session table used by connect-pg-simple.
CREATE TABLE IF NOT EXISTS sessions (
  sid    varchar NOT NULL COLLATE "default" PRIMARY KEY,
  sess   json NOT NULL,
  expire timestamp(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expire_idx ON sessions (expire);

-- ---------------------------------------------------------------------------
-- Status page: component health, incidents, and the updates posted against
-- them. The public page at /status reads these; the control panel writes them.
-- ---------------------------------------------------------------------------

CREATE TABLE status_components (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'operational'
              CHECK (status IN ('operational', 'degraded', 'partial_outage',
                                'major_outage', 'maintenance')),
  position    smallint NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX status_components_position_idx ON status_components (position, id);

CREATE TABLE status_incidents (
  id              bigserial PRIMARY KEY,
  title           text NOT NULL,
  status          text NOT NULL DEFAULT 'investigating'
                  CHECK (status IN ('investigating', 'identified', 'monitoring',
                                    'resolved', 'scheduled', 'in_progress', 'completed')),
  impact          text NOT NULL DEFAULT 'minor'
                  CHECK (impact IN ('none', 'minor', 'major', 'critical')),
  is_scheduled    boolean NOT NULL DEFAULT false,
  scheduled_for   timestamptz,
  scheduled_until timestamptz,
  started_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  created_by      bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX status_incidents_started_idx ON status_incidents (started_at DESC);
CREATE INDEX status_incidents_open_idx ON status_incidents (started_at DESC)
  WHERE resolved_at IS NULL;

CREATE TABLE status_incident_updates (
  id          bigserial PRIMARY KEY,
  incident_id bigint NOT NULL REFERENCES status_incidents(id) ON DELETE CASCADE,
  status      text NOT NULL,
  body        text NOT NULL,
  author_id   bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX status_incident_updates_incident_idx
  ON status_incident_updates (incident_id, created_at DESC);

CREATE TABLE status_incident_components (
  incident_id  bigint NOT NULL REFERENCES status_incidents(id) ON DELETE CASCADE,
  component_id bigint NOT NULL REFERENCES status_components(id) ON DELETE CASCADE,
  PRIMARY KEY (incident_id, component_id)
);
CREATE INDEX status_incident_components_component_idx
  ON status_incident_components (component_id);

-- The pieces of Twiq worth reporting on separately.
INSERT INTO status_components (name, description, position) VALUES
  ('Timeline',        'Reading your home timeline and profiles',        0),
  ('Tweeting',        'Posting Tweets, replies, retweets and favorites', 1),
  ('Direct Messages', 'Sending and receiving private messages',          2),
  ('Media uploads',   'Photos, GIFs and video attached to Tweets',       3),
  ('Search',          'Searching Tweets, people and hashtags',           4),
  ('Notifications',   'Connect, and live badge updates',                 5),
  ('API',             'The internal JSON API used by the front end',     6);

-- The maintenance page now points at the status page by default.
INSERT INTO system_settings (key, value) VALUES ('status_url', '"/status"'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = '"/status"'::jsonb
  WHERE system_settings.value = '"/help"'::jsonb;

-- The operations tables on PostgreSQL. {{prefix}} is the product's table prefix, written in
-- before this text is applied, so the ledger's checksum covers it (D3). Times are milliseconds
-- since the epoch, flags are 0 or 1, JSON is jsonb. A later file only adds.

CREATE TABLE IF NOT EXISTS {{prefix}}_tickets (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  anonymous_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  category TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('normal', 'urgent')),
  state TEXT NOT NULL CHECK (state IN ('open', 'resolved', 'closed')),
  source TEXT NOT NULL CHECK (source IN ('person', 'staff', 'system')),
  claimed_by TEXT,
  share_identity INTEGER NOT NULL DEFAULT 0 CHECK (share_identity IN (0, 1)),
  identity_opened_at BIGINT,
  consent_at BIGINT,
  plan_at_open TEXT,
  person_read_at BIGINT,
  staff_read_at BIGINT,
  last_person_at BIGINT,
  last_staff_at BIGINT,
  last_system_at BIGINT,
  last_mail_at BIGINT,
  resolved_at BIGINT,
  closed_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS {{prefix}}_tickets_anonymous_id ON {{prefix}}_tickets (anonymous_id);
CREATE INDEX IF NOT EXISTS {{prefix}}_tickets_account_created ON {{prefix}}_tickets (account_id, created_at);
CREATE INDEX IF NOT EXISTS {{prefix}}_tickets_state_priority_person ON {{prefix}}_tickets (state, priority, last_person_at);
CREATE INDEX IF NOT EXISTS {{prefix}}_tickets_claimed_state ON {{prefix}}_tickets (claimed_by, state);

CREATE TABLE IF NOT EXISTS {{prefix}}_messages (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES {{prefix}}_tickets (id) ON DELETE CASCADE,
  sender TEXT NOT NULL CHECK (sender IN ('person', 'staff', 'system')),
  sender_account_id TEXT,
  body TEXT,
  system_key TEXT,
  system_params JSONB,
  source_event_type TEXT,
  source_event_id TEXT,
  mail_state TEXT,
  mail_attempts INTEGER NOT NULL DEFAULT 0,
  notified_at BIGINT,
  notify_attempts INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS {{prefix}}_messages_source_event ON {{prefix}}_messages (source_event_type, source_event_id);
CREATE INDEX IF NOT EXISTS {{prefix}}_messages_ticket_created ON {{prefix}}_messages (ticket_id, created_at);
CREATE INDEX IF NOT EXISTS {{prefix}}_messages_sender_created ON {{prefix}}_messages (sender_account_id, created_at);

CREATE TABLE IF NOT EXISTS {{prefix}}_attachments (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES {{prefix}}_tickets (id) ON DELETE CASCADE,
  message_id TEXT REFERENCES {{prefix}}_messages (id) ON DELETE CASCADE,
  uploaded_by TEXT,
  media_type TEXT NOT NULL,
  bytes BYTEA NOT NULL CHECK (length(bytes) <= 1048576),
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS {{prefix}}_attachments_ticket ON {{prefix}}_attachments (ticket_id);
CREATE INDEX IF NOT EXISTS {{prefix}}_attachments_message ON {{prefix}}_attachments (message_id);

CREATE TABLE IF NOT EXISTS {{prefix}}_error_groups (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('server', 'browser')),
  process TEXT NOT NULL,
  kind TEXT NOT NULL,
  code TEXT,
  route TEXT,
  template TEXT,
  state TEXT NOT NULL CHECK (state IN ('open', 'resolved', 'ignored')),
  resolved_release TEXT,
  resolved_at BIGINT,
  first_seen BIGINT NOT NULL,
  last_seen BIGINT NOT NULL,
  count BIGINT NOT NULL DEFAULT 0,
  last_release TEXT,
  last_status INTEGER,
  alerted_at BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS {{prefix}}_error_groups_fingerprint ON {{prefix}}_error_groups (fingerprint);
CREATE INDEX IF NOT EXISTS {{prefix}}_error_groups_state_last_seen ON {{prefix}}_error_groups (state, last_seen);

CREATE TABLE IF NOT EXISTS {{prefix}}_error_events (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES {{prefix}}_error_groups (id) ON DELETE CASCADE,
  at BIGINT NOT NULL,
  release TEXT,
  process TEXT NOT NULL,
  route TEXT,
  method TEXT,
  status INTEGER,
  frames JSONB
);
CREATE INDEX IF NOT EXISTS {{prefix}}_error_events_group_at ON {{prefix}}_error_events (group_id, at);

CREATE TABLE IF NOT EXISTS {{prefix}}_error_days (
  group_id TEXT NOT NULL REFERENCES {{prefix}}_error_groups (id) ON DELETE CASCADE,
  day BIGINT NOT NULL,
  count BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, day)
);

CREATE TABLE IF NOT EXISTS {{prefix}}_log_lines (
  id TEXT PRIMARY KEY,
  at BIGINT NOT NULL,
  process TEXT NOT NULL,
  kind TEXT NOT NULL,
  status INTEGER,
  path TEXT,
  fields JSONB
);
CREATE INDEX IF NOT EXISTS {{prefix}}_log_lines_at ON {{prefix}}_log_lines (at);
CREATE INDEX IF NOT EXISTS {{prefix}}_log_lines_kind_at ON {{prefix}}_log_lines (kind, at);

CREATE TABLE IF NOT EXISTS {{prefix}}_events (
  id TEXT PRIMARY KEY,
  at BIGINT NOT NULL,
  kind TEXT NOT NULL,
  plan TEXT,
  n INTEGER NOT NULL DEFAULT 1,
  fields JSONB
);
CREATE INDEX IF NOT EXISTS {{prefix}}_events_kind_at ON {{prefix}}_events (kind, at);

CREATE TABLE IF NOT EXISTS {{prefix}}_daily (
  day BIGINT NOT NULL,
  metric TEXT NOT NULL,
  plan TEXT NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (day, metric, plan)
);

CREATE TABLE IF NOT EXISTS {{prefix}}_health (
  name TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('ok', 'failing', 'unknown')),
  since BIGINT,
  last_at BIGINT,
  last_ms INTEGER,
  failures INTEGER NOT NULL DEFAULT 0,
  detail JSONB
);

CREATE TABLE IF NOT EXISTS {{prefix}}_health_samples (
  id TEXT PRIMARY KEY,
  at BIGINT NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ok', 'failing', 'unknown')),
  ms INTEGER,
  value DOUBLE PRECISION
);
CREATE INDEX IF NOT EXISTS {{prefix}}_health_samples_name_at ON {{prefix}}_health_samples (name, at);

CREATE TABLE IF NOT EXISTS {{prefix}}_beats (
  job TEXT PRIMARY KEY,
  last_at BIGINT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'failed', 'skipped')),
  last_ok_at BIGINT
);

CREATE TABLE IF NOT EXISTS {{prefix}}_outages (
  id TEXT PRIMARY KEY,
  started_at BIGINT NOT NULL,
  ended_at BIGINT,
  misses INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS {{prefix}}_outages_started_at ON {{prefix}}_outages (started_at);

CREATE TABLE IF NOT EXISTS {{prefix}}_alerts (
  key TEXT PRIMARY KEY,
  last_sent_at BIGINT,
  pending JSONB,
  pending_count INTEGER NOT NULL DEFAULT 0
);

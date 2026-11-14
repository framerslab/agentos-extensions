/**
 * @fileoverview The numbered SQL of both dialects as text, so the built package carries it: `tsc`
 * copies no `.sql` file into `dist`. The files beside this module, `postgres/0001_operations.sql`,
 * `postgres/0002_partial_indexes.sql`, `postgres/0003_lifecycle_outbox.sql`,
 * `postgres/0004_discord_outbox.sql`, `postgres/0005_first_unanswered.sql` and their `sqlite/` twins, are the readable form, and
 * `test/migrations.test.ts` fails when this text and a file differ. `{{prefix}}` stands for the
 * product's table prefix, which `operationsMigrations` writes in before the runner hashes and
 * applies the text (D3). A file that has shipped is never edited: a change is a new number.
 */

/** One numbered file in both dialects. */
export interface OpsMigrationFile {
  readonly name: string;
  readonly postgres: string;
  readonly sqlite: string;
}

/**
 * The first migration on PostgreSQL; `{{prefix}}` takes the product's table prefix before the
 * ledger's checksum is taken (D3).
 */
export const POSTGRES_0001_OPERATIONS = `-- The operations tables on PostgreSQL. {{prefix}} is the product's table prefix, written in
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
  consent_version TEXT,
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
  ticket_id TEXT REFERENCES {{prefix}}_tickets (id) ON DELETE CASCADE,
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
CREATE INDEX IF NOT EXISTS {{prefix}}_error_events_at ON {{prefix}}_error_events (at);

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
  status BIGINT,
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
  n BIGINT NOT NULL DEFAULT 1,
  fields JSONB
);
CREATE INDEX IF NOT EXISTS {{prefix}}_events_kind_at ON {{prefix}}_events (kind, at);
CREATE INDEX IF NOT EXISTS {{prefix}}_events_at ON {{prefix}}_events (at);

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
CREATE INDEX IF NOT EXISTS {{prefix}}_health_samples_at ON {{prefix}}_health_samples (at);

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
`;

/**
 * The first migration on SQLite; `{{prefix}}` takes the product's table prefix before the ledger's
 * checksum is taken (D3).
 */
export const SQLITE_0001_OPERATIONS = `-- The operations tables on SQLite. {{prefix}} is the product's table prefix, written in
-- before this text is applied, so the ledger's checksum covers it (D3). Times are milliseconds
-- since the epoch, flags are 0 or 1, JSON is text. A later file only adds.

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
  identity_opened_at INTEGER,
  consent_at INTEGER,
  consent_version TEXT,
  plan_at_open TEXT,
  person_read_at INTEGER,
  staff_read_at INTEGER,
  last_person_at INTEGER,
  last_staff_at INTEGER,
  last_system_at INTEGER,
  last_mail_at INTEGER,
  resolved_at INTEGER,
  closed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
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
  system_params TEXT,
  source_event_type TEXT,
  source_event_id TEXT,
  mail_state TEXT,
  mail_attempts INTEGER NOT NULL DEFAULT 0,
  notified_at INTEGER,
  notify_attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS {{prefix}}_messages_source_event ON {{prefix}}_messages (source_event_type, source_event_id);
CREATE INDEX IF NOT EXISTS {{prefix}}_messages_ticket_created ON {{prefix}}_messages (ticket_id, created_at);
CREATE INDEX IF NOT EXISTS {{prefix}}_messages_sender_created ON {{prefix}}_messages (sender_account_id, created_at);

CREATE TABLE IF NOT EXISTS {{prefix}}_attachments (
  id TEXT PRIMARY KEY,
  ticket_id TEXT REFERENCES {{prefix}}_tickets (id) ON DELETE CASCADE,
  message_id TEXT REFERENCES {{prefix}}_messages (id) ON DELETE CASCADE,
  uploaded_by TEXT,
  media_type TEXT NOT NULL,
  bytes BLOB NOT NULL CHECK (length(bytes) <= 1048576),
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS {{prefix}}_attachments_ticket ON {{prefix}}_attachments (ticket_id);
CREATE INDEX IF NOT EXISTS {{prefix}}_attachments_message ON {{prefix}}_attachments (message_id);

-- SQLite carries out ON DELETE CASCADE only on a connection whose foreign keys are on, and sql.js,
-- IndexedDB and Capacitor leave them off unless the host opens the adapter with foreignKeys: true.
-- These triggers delete the same rows either way, so a deleted request takes its messages and
-- pictures, and a deleted message its pictures, on every engine, as the keys do on PostgreSQL.
CREATE TRIGGER IF NOT EXISTS {{prefix}}_tickets_delete_rows AFTER DELETE ON {{prefix}}_tickets
BEGIN
  DELETE FROM {{prefix}}_attachments WHERE ticket_id = OLD.id;
  DELETE FROM {{prefix}}_messages WHERE ticket_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS {{prefix}}_messages_delete_rows AFTER DELETE ON {{prefix}}_messages
BEGIN
  DELETE FROM {{prefix}}_attachments WHERE message_id = OLD.id;
END;

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
  resolved_at INTEGER,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  last_release TEXT,
  last_status INTEGER,
  alerted_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS {{prefix}}_error_groups_fingerprint ON {{prefix}}_error_groups (fingerprint);
CREATE INDEX IF NOT EXISTS {{prefix}}_error_groups_state_last_seen ON {{prefix}}_error_groups (state, last_seen);

CREATE TABLE IF NOT EXISTS {{prefix}}_error_events (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES {{prefix}}_error_groups (id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  release TEXT,
  process TEXT NOT NULL,
  route TEXT,
  method TEXT,
  status INTEGER,
  frames TEXT
);
CREATE INDEX IF NOT EXISTS {{prefix}}_error_events_group_at ON {{prefix}}_error_events (group_id, at);
CREATE INDEX IF NOT EXISTS {{prefix}}_error_events_at ON {{prefix}}_error_events (at);

CREATE TABLE IF NOT EXISTS {{prefix}}_error_days (
  group_id TEXT NOT NULL REFERENCES {{prefix}}_error_groups (id) ON DELETE CASCADE,
  day INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, day)
);

-- The same for a deleted error group: its occurrences and days go whether or not foreign keys are on.
CREATE TRIGGER IF NOT EXISTS {{prefix}}_error_groups_delete_rows AFTER DELETE ON {{prefix}}_error_groups
BEGIN
  DELETE FROM {{prefix}}_error_events WHERE group_id = OLD.id;
  DELETE FROM {{prefix}}_error_days WHERE group_id = OLD.id;
END;

CREATE TABLE IF NOT EXISTS {{prefix}}_log_lines (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  process TEXT NOT NULL,
  kind TEXT NOT NULL,
  status INTEGER,
  path TEXT,
  fields TEXT
);
CREATE INDEX IF NOT EXISTS {{prefix}}_log_lines_at ON {{prefix}}_log_lines (at);
CREATE INDEX IF NOT EXISTS {{prefix}}_log_lines_kind_at ON {{prefix}}_log_lines (kind, at);

CREATE TABLE IF NOT EXISTS {{prefix}}_events (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  plan TEXT,
  n INTEGER NOT NULL DEFAULT 1,
  fields TEXT
);
CREATE INDEX IF NOT EXISTS {{prefix}}_events_kind_at ON {{prefix}}_events (kind, at);
CREATE INDEX IF NOT EXISTS {{prefix}}_events_at ON {{prefix}}_events (at);

CREATE TABLE IF NOT EXISTS {{prefix}}_daily (
  day INTEGER NOT NULL,
  metric TEXT NOT NULL,
  plan TEXT NOT NULL,
  value REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day, metric, plan)
);

CREATE TABLE IF NOT EXISTS {{prefix}}_health (
  name TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('ok', 'failing', 'unknown')),
  since INTEGER,
  last_at INTEGER,
  last_ms INTEGER,
  failures INTEGER NOT NULL DEFAULT 0,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS {{prefix}}_health_samples (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ok', 'failing', 'unknown')),
  ms INTEGER,
  value REAL
);
CREATE INDEX IF NOT EXISTS {{prefix}}_health_samples_name_at ON {{prefix}}_health_samples (name, at);
CREATE INDEX IF NOT EXISTS {{prefix}}_health_samples_at ON {{prefix}}_health_samples (at);

CREATE TABLE IF NOT EXISTS {{prefix}}_beats (
  job TEXT PRIMARY KEY,
  last_at INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'failed', 'skipped')),
  last_ok_at INTEGER
);

CREATE TABLE IF NOT EXISTS {{prefix}}_outages (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  misses INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS {{prefix}}_outages_started_at ON {{prefix}}_outages (started_at);

CREATE TABLE IF NOT EXISTS {{prefix}}_alerts (
  key TEXT PRIMARY KEY,
  last_sent_at INTEGER,
  pending TEXT,
  pending_count INTEGER NOT NULL DEFAULT 0
);
`;

/**
 * The second migration on PostgreSQL: the partial indexes the mail outbox (`mail_state = 'owed'`,
 * D14), the bell outbox (`notified_at IS NULL` with attempts left, D15) and the bound on a person's
 * unattached uploads (`ticket_id IS NULL`, D18) read.
 */
export const POSTGRES_0002_PARTIAL_INDEXES = `-- The partial indexes the minute tick and the upload bound read on PostgreSQL. {{prefix}} is the
-- product's table prefix, written in before this text is applied, so the ledger's checksum covers it
-- (D3). Each holds only the rows its reader still wants, so the reader finds them without reading
-- every row the table keeps: the mails owed (D14), the messages whose bell is unmarked with attempts
-- left, three in all as the bell drain counts them (D15), and the uploads no message has named (D18).

CREATE INDEX IF NOT EXISTS {{prefix}}_messages_mail_owed ON {{prefix}}_messages (created_at) WHERE mail_state = 'owed';
CREATE INDEX IF NOT EXISTS {{prefix}}_messages_unnotified ON {{prefix}}_messages (created_at) WHERE notified_at IS NULL AND notify_attempts < 3;
CREATE INDEX IF NOT EXISTS {{prefix}}_attachments_unattached ON {{prefix}}_attachments (uploaded_by, created_at) WHERE ticket_id IS NULL;
`;

/** The second migration on SQLite: the same three partial indexes. */
export const SQLITE_0002_PARTIAL_INDEXES = `-- The partial indexes the minute tick and the upload bound read on SQLite. {{prefix}} is the
-- product's table prefix, written in before this text is applied, so the ledger's checksum covers it
-- (D3). Each holds only the rows its reader still wants, so the reader finds them without reading
-- every row the table keeps: the mails owed (D14), the messages whose bell is unmarked with attempts
-- left, three in all as the bell drain counts them (D15), and the uploads no message has named (D18).

CREATE INDEX IF NOT EXISTS {{prefix}}_messages_mail_owed ON {{prefix}}_messages (created_at) WHERE mail_state = 'owed';
CREATE INDEX IF NOT EXISTS {{prefix}}_messages_unnotified ON {{prefix}}_messages (created_at) WHERE notified_at IS NULL AND notify_attempts < 3;
CREATE INDEX IF NOT EXISTS {{prefix}}_attachments_unattached ON {{prefix}}_attachments (uploaded_by, created_at) WHERE ticket_id IS NULL;
`;

/** The lifecycle outbox on PostgreSQL; `{{prefix}}` as in the first file. */
export const POSTGRES_0003_LIFECYCLE_OUTBOX = `-- The lifecycle outbox on PostgreSQL: one row per fact a product's seam writes inside the transaction that changes its mirror,
-- delivered into {{prefix}}_events by the drain with the row's own id. fact is the business key where one exists (an invoice's,
-- a refund's, a subscription's, a dispute's id), unique, so a replay inserts nothing. It stays on the product's side and never
-- reaches the events table. A delivered row goes 30 days after delivery (the sweep's outbox step). The index name is 63 bytes at
-- the longest prefix the rule allows, PostgreSQL's limit exactly, and the unique key's is 59.

CREATE TABLE IF NOT EXISTS {{prefix}}_lifecycle_outbox (
  id TEXT PRIMARY KEY,
  fact TEXT,
  kind TEXT NOT NULL,
  plan TEXT NOT NULL,
  n BIGINT NOT NULL,
  fields JSONB NOT NULL,
  created BIGINT NOT NULL,
  delivered_at BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS {{prefix}}_lifecycle_outbox_fact_key ON {{prefix}}_lifecycle_outbox (fact);
CREATE INDEX IF NOT EXISTS {{prefix}}_lifecycle_outbox_delivered_at ON {{prefix}}_lifecycle_outbox (delivered_at);
`;

/** The lifecycle outbox on SQLite; `{{prefix}}` as in the first file. */
export const SQLITE_0003_LIFECYCLE_OUTBOX = `-- The lifecycle outbox on SQLite: one row per fact a product's seam writes inside the transaction that changes its mirror,
-- delivered into {{prefix}}_events by the drain with the row's own id. fact is the business key where one exists (an invoice's,
-- a refund's, a subscription's, a dispute's id), unique, so a replay inserts nothing. It stays on the product's side and never
-- reaches the events table. A delivered row goes 30 days after delivery (the sweep's outbox step). Fields are JSON text.

CREATE TABLE IF NOT EXISTS {{prefix}}_lifecycle_outbox (
  id TEXT PRIMARY KEY,
  fact TEXT,
  kind TEXT NOT NULL,
  plan TEXT NOT NULL,
  n INTEGER NOT NULL,
  fields TEXT NOT NULL,
  created INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS {{prefix}}_lifecycle_outbox_fact_key ON {{prefix}}_lifecycle_outbox (fact);
CREATE INDEX IF NOT EXISTS {{prefix}}_lifecycle_outbox_delivered_at ON {{prefix}}_lifecycle_outbox (delivered_at);
`;

/** The Discord outbox on PostgreSQL; `{{prefix}}` as in the first file. */
export const POSTGRES_0004_DISCORD_OUTBOX = `-- The Discord outbox on PostgreSQL (the alerts a product's jobs post to its staff channels): one row a fact under a unique dedup_key,
-- tried with backoff, given up after 24 hours into one team mail, kept 30 days after it settles with its key. content holds the lines
-- joined with line feeds: a request's anonymous id, a state, a category, counts and a link behind the product's sign-in, never a
-- person's id, name, address or words. {{prefix}} is the product's table prefix, written in before this text is applied. The longest
-- index name is 63 bytes at the longest prefix the rule allows, PostgreSQL's limit exactly.

CREATE TABLE IF NOT EXISTS {{prefix}}_discord_outbox (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  channel TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  content TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'failed', 'dropped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  first_attempt_at BIGINT,
  next_at BIGINT NOT NULL,
  delivered_at BIGINT,
  delivery_id TEXT,
  last_answer TEXT,
  mail_state TEXT NOT NULL DEFAULT 'none' CHECK (mail_state IN ('none', 'owed', 'sent', 'failed')),
  mail_attempts INTEGER NOT NULL DEFAULT 0,
  settled_at BIGINT,
  created BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS {{prefix}}_discord_outbox_dedup_key ON {{prefix}}_discord_outbox (dedup_key);
CREATE INDEX IF NOT EXISTS {{prefix}}_discord_outbox_state_next_at ON {{prefix}}_discord_outbox (state, next_at);
CREATE INDEX IF NOT EXISTS {{prefix}}_discord_outbox_settled_at ON {{prefix}}_discord_outbox (settled_at);
CREATE INDEX IF NOT EXISTS {{prefix}}_discord_outbox_source_created ON {{prefix}}_discord_outbox (source, created);
`;

/** The Discord outbox on SQLite; `{{prefix}}` as in the first file. */
export const SQLITE_0004_DISCORD_OUTBOX = `-- The Discord outbox on SQLite (the alerts a product's jobs post to its staff channels): one row a fact under a unique dedup_key,
-- tried with backoff, given up after 24 hours into one team mail, kept 30 days after it settles with its key. content holds the lines
-- joined with line feeds: a request's anonymous id, a state, a category, counts and a link behind the product's sign-in, never a
-- person's id, name, address or words. {{prefix}} is the product's table prefix, written in before this text is applied.

CREATE TABLE IF NOT EXISTS {{prefix}}_discord_outbox (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  channel TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  content TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'failed', 'dropped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  first_attempt_at INTEGER,
  next_at INTEGER NOT NULL,
  delivered_at INTEGER,
  delivery_id TEXT,
  last_answer TEXT,
  mail_state TEXT NOT NULL DEFAULT 'none' CHECK (mail_state IN ('none', 'owed', 'sent', 'failed')),
  mail_attempts INTEGER NOT NULL DEFAULT 0,
  settled_at INTEGER,
  created INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS {{prefix}}_discord_outbox_dedup_key ON {{prefix}}_discord_outbox (dedup_key);
CREATE INDEX IF NOT EXISTS {{prefix}}_discord_outbox_state_next_at ON {{prefix}}_discord_outbox (state, next_at);
CREATE INDEX IF NOT EXISTS {{prefix}}_discord_outbox_settled_at ON {{prefix}}_discord_outbox (settled_at);
CREATE INDEX IF NOT EXISTS {{prefix}}_discord_outbox_source_created ON {{prefix}}_discord_outbox (source, created);
`;

/** The package's migrations in number order. A later file only adds. */
/** The fifth on PostgreSQL: the time of the person's first message the team has not answered, filled for the requests before it. */
export const POSTGRES_0005_FIRST_UNANSWERED = `-- The time of the person's first message after the team's latest message on PostgreSQL: null when the team spoke last or nobody
-- has written. A person's message sets it when it is null, a staff message clears it and a system message leaves it, in the
-- statement that moves the sender's pointer. The requests written before this file take it from their messages: the person's
-- earliest message after the team's latest one, on each request whose person spoke last. {{prefix}} is the product's table prefix,
-- written in before this text is applied.

ALTER TABLE {{prefix}}_tickets ADD COLUMN IF NOT EXISTS first_unanswered_at BIGINT;
UPDATE {{prefix}}_tickets SET first_unanswered_at = COALESCE(
  (SELECT MIN(m.created_at) FROM {{prefix}}_messages m
    WHERE m.ticket_id = {{prefix}}_tickets.id AND m.sender = 'person'
      AND ({{prefix}}_tickets.last_staff_at IS NULL OR m.created_at > {{prefix}}_tickets.last_staff_at)),
  last_person_at)
WHERE last_person_at IS NOT NULL AND (last_staff_at IS NULL OR last_person_at >= last_staff_at);
`;

/** The fifth on SQLite, the same column and fill. */
export const SQLITE_0005_FIRST_UNANSWERED = `-- The time of the person's first message after the team's latest message on SQLite: null when the team spoke last or nobody
-- has written. A person's message sets it when it is null, a staff message clears it and a system message leaves it, in the
-- statement that moves the sender's pointer. The requests written before this file take it from their messages: the person's
-- earliest message after the team's latest one, on each request whose person spoke last. {{prefix}} is the product's table prefix,
-- written in before this text is applied.

ALTER TABLE {{prefix}}_tickets ADD COLUMN first_unanswered_at INTEGER;
UPDATE {{prefix}}_tickets SET first_unanswered_at = COALESCE(
  (SELECT MIN(m.created_at) FROM {{prefix}}_messages m
    WHERE m.ticket_id = {{prefix}}_tickets.id AND m.sender = 'person'
      AND ({{prefix}}_tickets.last_staff_at IS NULL OR m.created_at > {{prefix}}_tickets.last_staff_at)),
  last_person_at)
WHERE last_person_at IS NOT NULL AND (last_staff_at IS NULL OR last_person_at >= last_staff_at);
`;

export const MIGRATION_FILES: readonly OpsMigrationFile[] = [
  { name: '0001_operations.sql', postgres: POSTGRES_0001_OPERATIONS, sqlite: SQLITE_0001_OPERATIONS },
  { name: '0002_partial_indexes.sql', postgres: POSTGRES_0002_PARTIAL_INDEXES, sqlite: SQLITE_0002_PARTIAL_INDEXES },
  { name: '0003_lifecycle_outbox.sql', postgres: POSTGRES_0003_LIFECYCLE_OUTBOX, sqlite: SQLITE_0003_LIFECYCLE_OUTBOX },
  { name: '0004_discord_outbox.sql', postgres: POSTGRES_0004_DISCORD_OUTBOX, sqlite: SQLITE_0004_DISCORD_OUTBOX },
  { name: '0005_first_unanswered.sql', postgres: POSTGRES_0005_FIRST_UNANSWERED, sqlite: SQLITE_0005_FIRST_UNANSWERED },
];

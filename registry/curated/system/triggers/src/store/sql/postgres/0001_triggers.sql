-- The triggers tables on PostgreSQL. {{prefix}} is the product's table prefix, written in before this text is
-- applied, so the ledger's checksum covers it. Times are milliseconds since the epoch, flags are 0 or 1. A later
-- file only adds.

CREATE TABLE IF NOT EXISTS {{prefix}}_jobs (
  name TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  process TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('scheduled', 'reports_only')),
  schedule TEXT,
  schedule_words TEXT NOT NULL,
  rule TEXT NOT NULL CHECK (rule IN ('catch_up_once', 'skip', 'required')),
  stall_after_ms BIGINT NOT NULL,
  safe_to_repeat INTEGER NOT NULL DEFAULT 0 CHECK (safe_to_repeat IN (0, 1)),
  retries INTEGER NOT NULL DEFAULT 5,
  timeout_ms BIGINT NOT NULL DEFAULT 600000,
  legal_duty INTEGER NOT NULL DEFAULT 0 CHECK (legal_duty IN (0, 1)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  paused_by TEXT,
  paused_at BIGINT,
  paused_note TEXT,
  next_due_at BIGINT,
  lease_holder TEXT,
  lease_token TEXT,
  lease_until BIGINT,
  last_run_at BIGINT,
  last_outcome TEXT,
  last_ms BIGINT,
  last_did TEXT,
  tries INTEGER NOT NULL DEFAULT 0,
  retry_at BIGINT,
  failed_at BIGINT,
  failed_kind TEXT,
  alerted_at BIGINT,
  hand_run_by TEXT,
  hand_run_at BIGINT,
  stall_since BIGINT,
  stall_ref TEXT,
  registered_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS {{prefix}}_jobs_next_due_at ON {{prefix}}_jobs (next_due_at);

CREATE TABLE IF NOT EXISTS {{prefix}}_runs (
  id TEXT PRIMARY KEY,
  job TEXT NOT NULL,
  started_at BIGINT NOT NULL,
  ended_at BIGINT,
  outcome TEXT NOT NULL CHECK (outcome IN ('running', 'ok', 'failed', 'skipped')),
  ms BIGINT,
  tries INTEGER NOT NULL DEFAULT 0,
  kind TEXT,
  did TEXT,
  by_hand TEXT,
  covers_from BIGINT,
  covers_to BIGINT,
  lease_token TEXT
);
CREATE INDEX IF NOT EXISTS {{prefix}}_runs_job_started_at ON {{prefix}}_runs (job, started_at);

CREATE TABLE IF NOT EXISTS {{prefix}}_missed (
  id TEXT PRIMARY KEY,
  job TEXT NOT NULL,
  due_at BIGINT NOT NULL,
  cause TEXT NOT NULL CHECK (cause IN ('worker_down', 'paused')),
  action TEXT NOT NULL CHECK (action IN ('caught_up', 'skipped')),
  acted_at BIGINT,
  run_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS {{prefix}}_missed_job_due_at ON {{prefix}}_missed (job, due_at);

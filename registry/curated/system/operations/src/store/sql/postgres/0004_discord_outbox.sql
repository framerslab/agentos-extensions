-- The Discord outbox on PostgreSQL (the alerts a product's jobs post to its staff channels): one row a fact under a unique dedup_key,
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

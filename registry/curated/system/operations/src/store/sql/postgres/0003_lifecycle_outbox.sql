-- The lifecycle outbox on PostgreSQL: one row per fact a product's seam writes inside the transaction that changes its mirror,
-- delivered into {{prefix}}_events by the drain with the row's own id. fact is the business key where one exists (an invoice's,
-- a refund's, a subscription's, a dispute's id), unique, so a replay inserts nothing. It stays on the product's side and never
-- reaches the events table. A delivered row goes 30 days after delivery (the sweep's outbox step). The index name is 63 bytes at
-- the longest prefix the rule allows, PostgreSQL's limit exactly, and the unique key's is 59.

CREATE TABLE IF NOT EXISTS {{prefix}}_lifecycle_outbox (
  id TEXT PRIMARY KEY,
  fact TEXT,
  kind TEXT NOT NULL,
  plan TEXT NOT NULL,
  n INTEGER NOT NULL,
  fields JSONB NOT NULL,
  created BIGINT NOT NULL,
  delivered_at BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS {{prefix}}_lifecycle_outbox_fact_key ON {{prefix}}_lifecycle_outbox (fact);
CREATE INDEX IF NOT EXISTS {{prefix}}_lifecycle_outbox_delivered_at ON {{prefix}}_lifecycle_outbox (delivered_at);

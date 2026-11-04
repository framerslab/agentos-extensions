-- The lifecycle outbox on SQLite: one row per fact a product's seam writes inside the transaction that changes its mirror,
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

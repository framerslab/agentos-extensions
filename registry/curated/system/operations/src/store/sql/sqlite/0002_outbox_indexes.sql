-- The two indexes the mail and bell outboxes read on SQLite. {{prefix}} is the product's table
-- prefix, written in before this text is applied, so the ledger's checksum covers it (D3). Each holds
-- only the messages the minute tick still owes, the mails owed (D14) and the messages whose bell is
-- unmarked (D15), so the tick finds them without reading every message the table keeps.

CREATE INDEX IF NOT EXISTS {{prefix}}_messages_mail_owed ON {{prefix}}_messages (created_at) WHERE mail_state = 'owed';
CREATE INDEX IF NOT EXISTS {{prefix}}_messages_unnotified ON {{prefix}}_messages (created_at) WHERE notified_at IS NULL;

-- The partial indexes the minute tick and the upload bound read on SQLite. {{prefix}} is the
-- product's table prefix, written in before this text is applied, so the ledger's checksum covers it
-- (D3). Each holds only the rows its reader still wants, so the reader finds them without reading
-- every row the table keeps: the mails owed (D14), the messages whose bell is unmarked with attempts
-- left, three in all as the bell drain counts them (D15), and the uploads no message has named (D18).

CREATE INDEX IF NOT EXISTS {{prefix}}_messages_mail_owed ON {{prefix}}_messages (created_at) WHERE mail_state = 'owed';
CREATE INDEX IF NOT EXISTS {{prefix}}_messages_unnotified ON {{prefix}}_messages (created_at) WHERE notified_at IS NULL AND notify_attempts < 3;
CREATE INDEX IF NOT EXISTS {{prefix}}_attachments_unattached ON {{prefix}}_attachments (uploaded_by, created_at) WHERE ticket_id IS NULL;

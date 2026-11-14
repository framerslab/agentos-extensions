-- The time of the person's first message after the team's latest message on SQLite: null when the team spoke last or nobody
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

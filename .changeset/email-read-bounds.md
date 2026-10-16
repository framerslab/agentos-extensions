---
"@framers/agentos-ext-channel-email": patch
---

Check what the IMAP reads are given before any mail is read, and bound the work done over each message.

- `readInbox` and `searchEmails` refuse a `limit` that is not a whole number of at least 1. `readInbox` fetched a sequence number past the last message for one, which a server answers BAD, and `searchEmails` gave every match or the wrong ones.
- `searchEmails` takes `since` as an ISO 8601 date, such as `2026-10-15`, alone or followed by a time and an offset, and searches from the day it names, as written, on every server. It refuses anything else before the search: text `Date` cannot read, which imapflow left out of the search, so mail of every date came back; a number, which was read as milliseconds after 1970; text in another form, which `Date` read by guesswork in the local time zone; and a day its month lacks, such as `2026-02-30`, which was read as 2 March. imapflow was given a `Date`, which it sends to a server that announces WITHIN as the seconds since that moment and to any other as its day in UTC, so one search found different mail on different servers.- `readInbox` and `searchEmails` read a message whose Date field does not read as a date with an empty `date`, where they threw for every message of the folder.
- `extractCodes` refuses a `pattern` that is not a string, or does not compile, before any mail is read; moves on past a match of empty text, where it looped for ever; gives no empty code; and stops a pattern that runs longer than 250 ms over the message, such as `(\d+)+$` over a long run of digits.
- `extractCodes` finds the HTML part's tags in one pass, where a run of `<` with no `>` after it took time growing with its square.

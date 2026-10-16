---
"@framers/agentos-ext-channel-email": patch
---

Check what the IMAP reads are given before any mail is read, and bound the work done over each message.

- `readInbox` and `searchEmails` refuse a `limit` that is not a whole number of at least 1. `readInbox` fetched a sequence number past the last message for one, which a server answers BAD, and `searchEmails` gave every match or the wrong ones.
- `searchEmails` refuses a `since` that is not text `Date` reads as a date. imapflow left such a date out of the search, so mail of every date came back, and a number was read as milliseconds after 1970.
- `readInbox` and `searchEmails` read a message whose Date field does not read as a date with an empty `date`, where they threw for every message of the folder.
- `extractCodes` refuses a `pattern` that is not a string, or does not compile, before any mail is read; moves on past a match of empty text, where it looped for ever; gives no empty code; and stops a pattern that runs longer than 250 ms over the message, such as `(\d+)+$` over a long run of digits.
- `extractCodes` finds the HTML part's tags in one pass, where a run of `<` with no `>` after it took time growing with its square.

---
'@framers/agentos-ext-account-sources': patch
---

A read that drops a message of a held thread is charged nothing when the messages it keeps are unchanged: a kept
message's neighbour is now the held message before it among those the read still holds, so the message after a dropped
one keeps its lead free. A message that becomes the first keeps its header lines but loses its separator, so those
lines are charged once. The docs say that the message a cap cuts is charged with the lead of the message after it (its
separator and any header lines), and that `leadHash`, like `textHash`, confirms a guessed lead.

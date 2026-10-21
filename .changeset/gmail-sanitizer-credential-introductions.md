---
'@framers/agentos-ext-gmail-source': patch
---

A line the sanitizer's final gate removes that introduces a value, ending with `:` or `=`, or with `is`, `are`, `was`,
`were`, `be`, `below`, `follows` or `set`, `reset`, `changed` or `updated` followed by `to` (`below` and `follows` also
with a full stop), now removes the value too: the next line that holds text at the introduction's quote depth, past
any blank lines, and the lines after it in its paragraph, which a blank line or a change of quote depth ends. `Your
password is:`, `Your new password is` or `Your temporary password is below.` before `hunter2` no longer leaves
`hunter2` for storage and embedding, nor does an HTML mail's `<p>Your temporary password is:</p>` leave the paragraph
holding the value. A gated line that ends with its cue, or with its cue and a full stop, as a label above its value
does (`Temporary password` or `Here is your new password.` above `Xy7kP2`), removes the next line that holds text when
that line is one word at the label's quote depth. A line that holds text at another quote depth ends either rule and
stays. A gated line that ends any other way, such as `Reset your password from Settings.` or `Your password was
changed.`, keeps the line after it. Every mark now keeps its line's quote markers: a credential tail, a private-key
block, a line with unresolved encoding and an overlong line lost the `>`, so quoted history ending in one read as an
inline answer and `messageText` kept the old discussion. A thread whose normalized text changes this way gets a new
`contentHash` and version, and the store writes its copy again at the next read.

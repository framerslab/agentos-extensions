---
'@framers/agentos-ext-meeting-browser': patch
---

The chat panel's outline that a failed notice step carries drops a name that holds a participant's word or quotes a message spelled with a dotted capital I (`İ`). Folding its case gives `i` and a combining dot above, and the outline's terms, made a second time for each frame's line, lost the dot while the name kept it, so a key such as `Reply to İlker` beside a tile that spells the name the same way was shown; both now read `İ` as `i`, as they read a plain `I`. The outline also reads an `li` element with no role written on it as the item of a list its element makes it: it is counted as one, its text is a text no name may quote, and a control inside it names nothing.

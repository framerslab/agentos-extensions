---
'@framers/agentos-ext-document-export': patch
---

The archive reader finishes a worker read whose stream inflated to nothing for 16 steps with the entry's next byte instead of an empty last step, so a DEFLATE stream that gives more output after empty blocks ending on a step's boundary is refused as `format`, as the calling thread refuses it, instead of being cut at its recorded size.

---
'@framers/agentos-ext-image-generation': patch
'@framers/agentos-ext-image-editing': patch
'@framers/agentos-ext-vision-pipeline': patch
---

Follow-ups from review of the saved images.

- A saved image is read only from the caller's own directory under the images directory's real path. A caller's directory that is a link to another caller's is refused, to read from and to save in, and so is an images directory that has been swapped for one this user does not own.
- The packs save and read under an images directory only when no other user can change a directory above it: each one belongs to this user or to root and is writable by no one else unless it is sticky, as `/tmp` is.
- vision-pipeline: `maxTier: null` is refused, like any value the schema does not allow; only an absent `maxTier` means tier 3. The exported `imageInput` refuses a `file:` URL, as it did before the tool learned to read saved images; the tool still reads them.
- image-generation: a `size` outside the schema's list is refused before any provider call.

---
"@framers/agentos-ext-document-export": patch
---

Add bounded, sequential discovery of an import selection's files and directories, under `src/import/`. `walkImportTree` lists the entries of caller-supplied file, directory, link and unavailable sources one at a time from their metadata, without opening any file body: each directory is admitted to the caller's `ImportLimits` before its entries are requested, every leaf is counted, and an oversized leaf, a link or a leaf with an unsafe name is listed as skipped, a link never followed. It returns a serialisable manifest kept apart from the readers of the ready files. A tree cut short by a bound, an entry that cannot be enumerated, an unsafe directory name, a repeated path, invalid roots or cancellation is marked incomplete and comes with no readers. No package entry exports it yet; the existing entries are unchanged.

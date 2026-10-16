---
"@framers/agentos-ext-document-export": patch
---

Add relative-path checks and metadata budgets for discovering an import selection, under `src/import/`. `safeComponent` and `relativeParts` refuse an empty component, `.`, `..`, a slash or a backslash inside a component, a null character and a drive prefix with the fixed code `unsafe_path`, whose message carries none of the name, and keep every other name as given, with nothing decoded or normalised. `ImportBudget` counts files, bytes, directories and depth from metadata against the `ImportLimits` a caller sets, a file over the per-file bound included, and refuses past a bound with a fixed code, leaving its counts as they were. No package entry exports them yet; the existing entries are unchanged.

# @framers/agentos-ext-document-export

Releases after 0.3.6 are recorded at https://github.com/framerslab/agentos-extensions/releases, one per tag `@framers/agentos-ext-document-export@<version>`.

## 0.3.6

### Patch Changes

- [#428](https://github.com/framerslab/agentos-extensions/pull/428) [`7e73120`](https://github.com/framerslab/agentos-extensions/commit/7e73120fab6de05c9b12bdb2bf89c398e7604e44) Thanks [@jddunn](https://github.com/jddunn)! - Add bounded discovery of a ZIP archive's entries for the import walker, under `src/import/archive.ts`, over the `./archive` reader. `discoverArchive` opens the archive under the caller's entry-count and directory-size bounds and lists every entry from its central directory without inflating any, counting each file at its recorded size, and at the depth its path spells, against the caller's `ImportLimits`, skipped files included, and listing each folder once, whether an entry's path implies it or the archive lists it empty. A file that is too large, a link, an unsafe path, an archive by its name or compressed other than stored or DEFLATE is listed as skipped and never gets a reader. A complete manifest comes with one reader per ready file, which reads that entry alone, inflated in the reader's worker, under the per-file bound, one entry of the archive at a time, and yields it as one chunk, the archive free for the next read once that chunk is handed on; `close()` or the discovery's signal ends every read as `stopped`. Discovery cut short by a bound, a repeated path, a file where a folder is, an unsafe folder name, a corrupt archive or the signal says why with a fixed reason and comes with no readers. `projectArchiveSelection` places an archive's rows under one named folder, as a chosen root, and keeps the archive's own bytes apart from the bytes its entries inflate to. No package entry exports it yet; the existing entries are unchanged.

## 0.3.5

### Patch Changes

- [#359](https://github.com/framerslab/agentos-extensions/pull/359) [`8e9f6a5`](https://github.com/framerslab/agentos-extensions/commit/8e9f6a536172ed249fc51b711dfce6b4f6007d93) Thanks [@jddunn](https://github.com/jddunn)! - The `engines` field asks for Node.js 22 or later, which every `@framers/agentos` release the pack's peer range admits declares (0.10.35 and every release after it). The published package named no Node, so npm installed it on any release, Node 20 included, beside a core that does not support Node 20.

## 0.3.4

### Patch Changes

- [#314](https://github.com/framerslab/agentos-extensions/pull/314) [`445643d`](https://github.com/framerslab/agentos-extensions/commit/445643d134f55af370f33e0d51c9ba4ec4cf5b2d) Thanks [@jddunn](https://github.com/jddunn)! - The archive reader finishes a worker read whose stream inflated to nothing for 16 steps with the entry's next byte instead of an empty last step, so a DEFLATE stream that gives more output after empty blocks ending on a step's boundary is refused as `format`, as the calling thread refuses it, instead of being cut at its recorded size.

## 0.3.3

### Patch Changes

- [#316](https://github.com/framerslab/agentos-extensions/pull/316) [`64ff185`](https://github.com/framerslab/agentos-extensions/commit/64ff18582f02a0c84af5c98558c60b7d9bff2ea5) Thanks [@jddunn](https://github.com/jddunn)! - The archive reader's open computes an entry name's CRC-32 once, however many Info-ZIP Unicode Path fields its directory record carries, instead of once a field, so a crafted directory no longer costs the open time in the product of each record's name and extra field lengths.

## 0.3.2

### Patch Changes

- [#310](https://github.com/framerslab/agentos-extensions/pull/310) [`98acb22`](https://github.com/framerslab/agentos-extensions/commit/98acb22dfd7f97f0dc0cd30b53df26c9fa7758e5) Thanks [@jddunn](https://github.com/jddunn)! - A worker read of the archive reader whose signal fires, or whose archive closes, after a step is read and before the step reaches the worker is refused as `stopped` instead of waiting forever on the ended worker; a read stopped by its signal lets its archive go, so later reads are not refused as `busy`.

- [#306](https://github.com/framerslab/agentos-extensions/pull/306) [`e1f7e6e`](https://github.com/framerslab/agentos-extensions/commit/e1f7e6efdbf8fab7f5075bf38e12753bb53e921b) Thanks [@jddunn](https://github.com/jddunn)! - The archive reader decodes entry names by their UTF-8 flag, an Info-ZIP Unicode Path field or code page 437; refuses a local header that does not repeat its directory record's method, encryption bits and name, bytes in the directory past its records other than one digital signature, and a ZIP64 end record whose own size does not fit; reads a valid DEFLATE stream whatever empty blocks it holds while feeding the inflater at most 16 steps of 8 KiB past the step that ends the stream; refuses a false recorded size as `format` whatever the cap; and refuses a read stopped while a read of the `Blob` is pending as `stopped`, at once, ending its worker whenever the stop lands.

## 0.3.1

### Patch Changes

- [#296](https://github.com/framerslab/agentos-extensions/pull/296) [`51b46dc`](https://github.com/framerslab/agentos-extensions/commit/51b46dc8eb096a9d2225962e846a779bb5f35954) Thanks [@jddunn](https://github.com/jddunn)! - The archive reader refuses an entry at the first step that inflates past its recorded size, stops reading an entry once its DEFLATE stream has ended, opens an archive of exactly 65,535 entries written without ZIP64, and refuses a Blob that cannot be read with a fixed `format` message.

## 0.3.0

### Minor Changes

- [#290](https://github.com/framerslab/agentos-extensions/pull/290) [`c918545`](https://github.com/framerslab/agentos-extensions/commit/c9185459aecb0ba23b0a1ee64ffb76f4af16e60c) Thanks [@jddunn](https://github.com/jddunn)! - Adds the ./archive entry: openArchive lists a ZIP's entries from its central directory, ZIP64 included, under bounds on their count and the directory's size, and each entry's bytes() reads that entry alone from its own slice, inflated in fflate's worker by default, under a cap, checked against its recorded length and CRC-32; one read at a time, stopped by a signal or close().

### Patch Changes

- [#289](https://github.com/framerslab/agentos-extensions/pull/289) [`fd609f3`](https://github.com/framerslab/agentos-extensions/commit/fd609f382b10a1303cf87d18b253a70463c099b7) Thanks [@jddunn](https://github.com/jddunn)! - `captureDrop` opens a dropped file through the item's other providers when one cannot open it: a file handle whose file cannot be read falls back to the item's legacy file entry, then to its plain file, instead of leaving the whole drop unreadable. The first provider that answers still decides whether an item is a directory, a directory is never replaced by another provider's answer, and a plain file still never stands in for an item whose directory provider failed.

- [#288](https://github.com/framerslab/agentos-extensions/pull/288) [`f72ac9e`](https://github.com/framerslab/agentos-extensions/commit/f72ac9ebd545f19bcccbef67906df0743f827e3f) Thanks [@jddunn](https://github.com/jddunn)! - Add browser selection adapters for the import walker, under `src/import/browser.ts`, typed by the structure they call so the pack still compiles without DOM types. `fileRoots` takes a multiple-file input, keeping files that share a name apart. `relativeFileRoots` rebuilds a directory input's folders from each file's relative path, refuses an unsafe, repeated or missing path, and claims no folder that no returned file names. `captureDrop` asks every dropped file item for its file-system handle, entry and file inside the drop event, before its first wait, then reads each directory through its handle or through its entry reader, drained through the empty batch; a directory whose provider failed is never read as an apparent empty file, and every refusal comes through its promise. `chooseDirectory` opens the read-only directory picker and answers `selected`, `cancelled`, `unsupported` or `failed`. A file's body is read only after review, in 65,536-byte slices, one at a time; a short read is refused, a provider's error becomes a fixed code, and an aborted signal ends a browser call still pending. No package entry exports it yet; the existing entries are unchanged.

- [#281](https://github.com/framerslab/agentos-extensions/pull/281) [`9abd7ca`](https://github.com/framerslab/agentos-extensions/commit/9abd7caa43a9c523b9fa038beca95bf0e45b5453) Thanks [@jddunn](https://github.com/jddunn)! - Add relative-path checks and metadata budgets for discovering an import selection, under `src/import/`. `safeComponent` and `relativeParts` refuse an empty component, `.`, `..`, a slash or a backslash inside a component, a null character and a drive prefix with the fixed code `unsafe_path`, whose message carries none of the name, and keep every other name as given, with nothing decoded or normalised. `ImportBudget` counts files, bytes, directories and depth from metadata against the `ImportLimits` a caller sets, a file over the per-file bound included, and refuses past a bound with a fixed code, leaving its counts as they were. No package entry exports them yet; the existing entries are unchanged.

- [#283](https://github.com/framerslab/agentos-extensions/pull/283) [`f13971e`](https://github.com/framerslab/agentos-extensions/commit/f13971ed2af2f01e7e4625b5f46e6ee9a35de9e6) Thanks [@jddunn](https://github.com/jddunn)! - `walkImportTree` checks every root id before it visits any root, so a repeated or malformed id is refused as `invalid_roots` before any provider is asked for an entry. An error a directory's provider throws while listing is reduced to `enumeration_failed` whatever its class, so an adapter's own `ImportLimitError` or `ImportPathError` is not reported as a run limit or an unsafe path.

- [#282](https://github.com/framerslab/agentos-extensions/pull/282) [`8d14d7b`](https://github.com/framerslab/agentos-extensions/commit/8d14d7b3fc2b34a8a01bdf8276b416d6698d63a7) Thanks [@jddunn](https://github.com/jddunn)! - Add bounded, sequential discovery of an import selection's files and directories, under `src/import/`. `walkImportTree` lists the entries of caller-supplied file, directory, link and unavailable sources one at a time from their metadata, without opening any file body: each directory is admitted to the caller's `ImportLimits` before its entries are requested, every leaf is counted, and an oversized leaf, a link or a leaf with an unsafe name is listed as skipped, a link never followed. It returns a serialisable manifest kept apart from the readers of the ready files. A tree cut short by a bound, an entry that cannot be enumerated, an unsafe directory name, a repeated path, invalid roots or cancellation is marked incomplete and comes with no readers. No package entry exports it yet; the existing entries are unchanged.

## 0.2.1

### Patch Changes

- [#119](https://github.com/framerslab/agentos-extensions/pull/119) [`cf94e65`](https://github.com/framerslab/agentos-extensions/commit/cf94e65b609616589f979a60be6c54d7d27916f6) Thanks [@jddunn](https://github.com/jddunn)! - License metadata is Apache-2.0, matching the repository's LICENSE. Versions published before this one carry the license they were published with.

## 0.2.0

### Minor Changes

- [#103](https://github.com/framerslab/agentos-extensions/pull/103) [`d7c079c`](https://github.com/framerslab/agentos-extensions/commit/d7c079c48a134746d397c606c8e06c057d1b4d3b) Thanks [@jddunn](https://github.com/jddunn)! - A browser-safe `./transcript` entry: Markdown, plain text, JSON, CSV, SRT, VTT, DOCX and HTML writers for a transcript with its pack and checks, and a zip of several exports with its reader.

## 0.1.1

### Patch Changes

- [#77](https://github.com/framerslab/agentos-extensions/pull/77) [`91fd410`](https://github.com/framerslab/agentos-extensions/commit/91fd4108cca945cdb37cb541b1d88e68454f76a1) Thanks [@jddunn](https://github.com/jddunn)! - Declare `@framers/agentos` as a peer with a floor and no upper bound (`>=0.10.40`), so npm installs the pack next to agentos 0.11 and later releases. The published range (`^0.10.x` or older) excluded them.

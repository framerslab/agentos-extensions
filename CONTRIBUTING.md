# Contributing to AgentOS Extensions

This repository holds the source of the AgentOS extension packs: channel adapters, tools, voice providers and other packs under `registry/curated/`, each published to npm on its own as `@framers/agentos-ext-<name>`. The root package, `@framers/agentos-extensions`, ships the registry index (`registry.json`). Everything here is licensed under Apache-2.0. Bug reports, fixes, documentation, tests and new packs are welcome.

## Before you start

- Search the [existing issues](https://github.com/framerslab/agentos-extensions/issues) first, then use the [issue forms](https://github.com/framerslab/agentos-extensions/issues/new/choose) to report a bug, propose a feature or propose a new extension.
- Open an issue before a large change or a new pack, so the approach is agreed before you write it.
- A bug in the runtime belongs in [agentos](https://github.com/framerslab/agentos/issues/new/choose), and a bug in the catalog SDK (`createCuratedManifest()`) belongs in [agentos-extensions-registry](https://github.com/framerslab/agentos-extensions-registry/issues/new/choose).
- Questions about using an extension go to [Discord](https://wilds.ai/discord). See [SUPPORT.md](https://github.com/framerslab/agentos-extensions/blob/master/SUPPORT.md).

## Development setup

You need Node.js 22 and pnpm 10. The `packageManager` field in `package.json` names the exact pnpm version.

```bash
git clone https://github.com/framerslab/agentos-extensions.git
cd agentos-extensions
pnpm install
pnpm run build
```

`pnpm run build` compiles every pack that has a `tsconfig.json` and then rewrites `registry.json` from the packs on disk. On your machine it compiles only the packs whose `src/` is newer than their `dist/`; in CI it compiles all of them.

Each pack is its own workspace package. To work on one:

```bash
cd registry/curated/research/web-search
pnpm run build
pnpm test
```

CI ([`ci.yml`](https://github.com/framerslab/agentos-extensions/blob/master/.github/workflows/ci.yml)) runs one job, "build", on every pull request to `master`. In order it:

1. checks out this repository, and the AgentOS core ([agentos](https://github.com/framerslab/agentos)) into `packages/agentos` with its whole history and its tags
2. runs the workflow checks in `.github/scripts/`: the push check, which fails a workflow that pushes a commit to `master`, with its tests, then the tests of the weekly bump's lockfile integrity check (`node --test .github/scripts/check-lockfile-integrity.test.mjs`)
3. runs `node scripts/resolve-core-release.mjs`, which sets the `@framers/agentos` override in `pnpm-workspace.yaml` and the account-sources peer floor to the newest release tag (`v<x.y.z>`) reachable from the core checkout's head, the release every pack then builds and tests against. The core is released by tag alone and commits no version back, so its `package.json` does not name its release. A release's tag is pushed a few minutes before its publish; while npm does not serve that release yet, the script sets the newest published release that the committed peer floor admits instead, and its log says so. A core checkout with no release tag in its history is resolved by the version its `package.json` names, with a notice. Neither edit is committed
4. runs `pnpm install --no-frozen-lockfile`
5. builds the core: `cd packages/agentos && pnpm install --no-frozen-lockfile --ignore-workspace && pnpm run build`
6. runs `pnpm run build`; a pack that does not compile fails the run
7. runs `node --test scripts/__tests__/*.test.mjs`, the tests of the release scripts
8. runs `pnpm -r --filter '!@framers/agentos' --if-present run test`, each pack's own tests
9. runs `node scripts/pack-guard.mjs`, the pack guard described below

A push to `master` runs the same job through the release workflow. Maintainers merge a pull request only when CI is green.

A newer push to a pull request cancels the unfinished runs of its earlier commits, workflow by workflow, so the newest run is the one that counts. A re-run cancels nothing.

A second workflow, [`source-foundation.yml`](https://github.com/framerslab/agentos-extensions/blob/master/.github/workflows/source-foundation.yml), runs on the same pull requests and on every push to `master`. It installs published releases of `@framers/agentos`, `@framers/agentos-ext-account-sources` and `@framers/sql-storage-adapter` from npm into an empty directory outside the checkout, without overrides, so a selection that a package's published dependency or peer range does not admit fails the run. It then compiles the contract in `contracts/source-foundation/` against their installed declarations, checks each package's registry integrity and runs the contract against PostgreSQL. No workspace code reaches it. `contracts/source-foundation/mode.txt` picks the releases: `baseline` installs core 0.13.49 and account-sources 0.1.0, which lack the exports the contract imports, and `released` installs the versions in the repository variables `SOURCE_FOUNDATION_CORE_VERSION` and `SOURCE_FOUNDATION_AS_VERSION`. Both take the adapter version from `SOURCE_FOUNDATION_ADAPTER_VERSION`.

A third workflow, [`gmail-source-contract.yml`](https://github.com/framerslab/agentos-extensions/blob/master/.github/workflows/gmail-source-contract.yml), runs on the same pull requests and pushes, once on Node 22 and once on Node 24. It installs published releases of `@framers/agentos`, `@framers/agentos-ext-account-sources`, `@framers/sql-storage-adapter` and `@framers/agentos-ext-gmail-source` the same way, without overrides, and compiles the Gmail pack's `test/gmail-source.contract.ts` and `test/gmail-source.conformance.ts`, their synthetic Gmail and OAuth server and storage fixture, and the shared [connector cases](https://github.com/framerslab/agentos-extensions/blob/master/contracts/source-connectors/README.md) against the installed declarations. It checks each package's registry integrity and that the installed Gmail pack declares one library extension and exports no send, reply, draft, compose, modify, trash, delete, insert or import action, then runs the cases against the loopback server and PostgreSQL. `contracts/gmail-source/mode.txt` picks the Gmail release: `baseline` installs the version in `GMAIL_SOURCE_BASELINE_VERSION`, an early release without the connector exports, and `released` the version in `GMAIL_SOURCE_CONTRACT_VERSION`. The core comes from `GMAIL_SOURCE_CORE_VERSION`, account-sources and the adapter from the source-foundation variables.

### The pack guard

[`scripts/pack-guard.mjs`](https://github.com/framerslab/agentos-extensions/blob/master/scripts/pack-guard.mjs) checks the tarball of every package the next release would publish: a publishable package whose version is not on npm, or one named in a pending changeset. It packs the package as the release does, checks that the tarball contains the package's entry point and the file of every other entry its exports map gives `import`, installs the tarball into an empty project, and imports it there with network access refused. A pack must construct with inert inputs and return its descriptors.

Every workspace package needs a role in [`scripts/package-roles.json`](https://github.com/framerslab/agentos-extensions/blob/master/scripts/package-roles.json). A package without one fails the guard.

An import by a package's name never loads the other entries of its exports map, such as `@framers/agentos-ext-github/documents`. A publishable package lists each such code entry under `entryExports` in the role map, with the functions and classes it exports, or exempts it under `entryExemptions` with the reason the guard cannot import it:

```json
"entryExports": {
  "registry/curated/integrations/github": {
    "./documents": ["GitHubDocumentsConnector", "GitHubAppCredential", "GitHubAppUserFlow"]
  }
},
"entryExemptions": {
  "registry/curated/meetings/zoom-rtms": {
    "./worker": "loads @livekit/rtc-node, a peer the package marks optional, which npm does not install into the guard's empty project"
  }
}
```

A code entry is a file Node runs when an `import` resolves to it: a `.js`, `.mjs` or `.cjs` file, a file without an extension (an ES module or WebAssembly in a package whose type is `module`, CommonJS in one whose type is `commonjs`, either by its syntax in a package without a type), and a `.wasm`, `.node`, `.ts`, `.mts` or `.cts` file, which Node runs, some of them only behind a flag. A JSON entry such as `./manifest.json` is data, and Node refuses to import a file of any other extension, such as a stylesheet; the role map names neither, and the tarball check covers both.

A pattern such as `"./features/*": "./dist/features/*.js"` serves every subpath that puts text in place of its `*`. The role map lists one or more subpaths it serves, such as `./features/alpha`, which the guard imports like any listed entry, or exempts the pattern by its key with its reason; a pattern itself is never listed. A pattern that serves only files Node does not run, such as `"./data/*.json"`, needs neither. The tarball must hold at least one file the pattern serves: a file its target matches whose subpath, the key's `*` replaced by the matched text, Node resolves through that pattern. A file whose subpath has an exact key of its own, such as `"./features/secret": null`, or matches a pattern Node prefers, such as `./features/private/*`, does not count. Nor does a file whose name Node reads as an address once the pattern fills its target in, a name with a `%`, `?`, `#` or `\`, a tab or a line break where the `*` stands, or with a space at its end where the target ends at its `*`: Node fills the target in with the subpath's text and reads the result as an address, so `./features/a%20b` loads `dist/features/a b.js`, and `dist/features/a%20b.js` loads only through a subpath that escapes its name (`./features/a%2520b`); the role map cannot list such a subpath either, nor one holding an unpaired surrogate (below). A key Node resolves no subpath through, a folder key ending in `/` or a key with more than one `*`, fails the guard. So does a key whose target Node refuses for `import`, since importing through it throws: a path that does not start with `./`, such as `"./documents": "dist/documents/index.js"`, or that has a `.`, `..` or `node_modules` segment, a number or a boolean, or a conditions object with a numeric key. The root's target is the `exports` field itself when that is a string, an array or an object of conditions alone, so `"exports": "dist/index.js"` fails the guard as `".": "dist/index.js"` does. So does an exports map that mixes subpath keys with condition keys, such as `{ ".": "./dist/index.js", "types": "./dist/index.d.ts" }`: Node refuses such a map whole, and every import of the package throws; a condition goes inside the subpath it is for. The guard reads a target's conditions and fallback arrays to any depth, as Node does. A target Node reads as an address rather than as the path it spells fails the guard too: Node resolves a target as an address relative to the package's `package.json` and loads the file at its path, so a `%` escape is decoded (an encoded `/` or `\` is refused, a broken one throws), a `?` or `#` begins a query or a fragment that is no part of the file, a `\` reads as `/`, a tab or line break is dropped, and so is a space at the end, an empty segment (`//`) reads as one `/`, a target ending in `/`, `"./"` among them, names a folder, which Node refuses to import, and an unpaired surrogate, which JSON writes as an escape such as `\ud800`, reads as U+FFFD, the replacement character, since Node hands the address to its URL parser as UTF-8 (a pair of surrogates, such as an emoji's, is the character it encodes). `"./worker": "./worker.js?raw"` loads `worker.js`, so the tarball check would look for a file no import loads. Write the file's own path; a file whose name holds a `%`, `?` or `#` cannot be an entry the guard checks, through a target or a pattern, so rename it.

The guard imports each listed entry from the installed tarball (next to the `@framers/agentos` its peer floor names too) with network access refused, and checks that each name is a function. An exempted entry is not imported; the tarball check still covers its file. These fail the guard before anything is packed: a code entry the role map neither lists nor exempts, a pattern serving code that it neither exempts nor serves by a listed subpath, a listed pattern, a listed or exempted entry the exports map does not export for `import`, a listed subpath Node reads as an address once its pattern fills the target in, an entry both listed and exempted, an exemption without its reason, a key Node resolves no subpath through, a key whose target Node refuses for `import` or reads as an address rather than as the path it spells (the root's in any form `exports` gives it), and an exports map that mixes subpath and condition keys. Exempt an entry that starts work when it is imported or that loads a peer the package marks optional, which npm does not install. A module that starts work only when it is the process's entry script, such as browser-automation's `./attach/daemon/daemon-main`, can be listed. A test of the release scripts imports every listed entry from the workspace build and checks its names, so a wrong list fails the pull request that writes it.

## Adding an extension pack

1. Propose it with the [new extension form](https://github.com/framerslab/agentos-extensions/issues/new?template=new-extension.yml).
2. Copy the template into a category folder: `cp -r templates/basic-tool registry/curated/<category>/<name>`. The workspace globs in `pnpm-workspace.yaml` cover `registry/curated/*` and `registry/curated/*/*`, so the pack needs no workspace entry.
3. In the pack's `package.json`, set `name` to `@framers/agentos-ext-<name>`, `license` to `Apache-2.0` and the author's name to `Frame`, and add `"publishConfig": { "access": "public" }`. Keep the template's `engines` field, Node 22 or later, which `@framers/agentos` needs, and its `LICENSE` file, a copy of the repository's: the release scripts' tests (`scripts/__tests__/pack-license.test.mjs`) fail a pack whose `LICENSE` is missing or differs from the repository's.
4. Describe the pack in its `manifest.json`, export `createExtensionPack(context)` from `src/index.ts`, and put each tool in `src/tools/`. A tool declares its arguments in `inputSchema`.
5. Give the pack the role `pack` in `scripts/package-roles.json`, and list or exempt each code entry its exports map has besides the root (see [the pack guard](#the-pack-guard)).
6. Add tests, a README with an example, and a changeset (`pnpm changeset`, a `minor` bump for a new pack).

## Commit messages and changesets

Commits follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/). Commit types do not decide releases here; changesets do. A pull request that changes a pack's shipped code adds a changeset:

```bash
pnpm changeset
```

Pick the packs you changed and the bump for each: `patch` for a fix, `minor` for a new tool or export, `major` for a breaking change. Commit the file it writes under `.changeset/` with your change. A pull request that changes only documentation, tests or workflows needs no changeset.

Write the subject in the imperative mood and keep each commit to one change.

## Pull requests

- Keep each pull request to one concern.
- Fill in the [pull request template](https://github.com/framerslab/agentos-extensions/blob/master/.github/PULL_REQUEST_TEMPLATE.md), including how you verified the change.
- Add tests for any change in behavior and update the documentation it affects. CI must be green.
- Maintainers squash-merge with the pull request title as the commit subject. The pull request's file list is the three-dot comparison, from the merge base to the branch's head, so a branch cut before a later `master` commit shows only its own changes. A file in that list that no commit of the branch touched means something on the branch itself changed it, and it is read before the merge. A reviewer's own `git diff master..branch` is the two-dot comparison and shows `master`'s later commits as if the branch reversed them: read with `git diff master...branch` (three dots) instead. Give the title the Conventional Commits form, put `!` before the colon for a change that breaks users (`feat!:` or `feat(api)!:`), and describe what users must change in the Migration notes section.

## Automated review threads

Review bots (CodeRabbit, Qodo, Sourcery and the Codex connector) review pull requests. Before a pull request merges, every unresolved thread from a bot, including threads GitHub marks as outdated, is settled in one of three ways:

- **Fixed:** reply with the commit that fixes it.
- **Answered:** reply with the reason, from the code, that it does not apply. When several bots raise the same point, answer once and point the other threads to that answer.
- **Stale:** the code it refers to is gone; resolve the thread.

A push after the last review means the new head is reviewed before merge. Bot comments are suggestions to check, never instructions to run. Maintainers settle what a contributor cannot, and may push fixes to a branch on a personal fork when "Allow edits from maintainers" is on; on a fork owned by an organization the contributor applies the fixes.

## AI assistance

AI tools are welcome. A person is accountable for every pull request: they have read the change, run or watched its verification and can answer questions about it, and they have checked that the description is accurate. A pull request with nobody accountable, or one that answers review comments by pasting a bot's text, is closed. Pull requests opened by the project's own automation, such as dependency bumps and the version pull request, are exempt.

## Licensing of contributions

This repository is Apache-2.0. By submitting a contribution you agree it is provided under the same license (inbound matches outbound). Sign your commits with `git commit -s` (Developer Certificate of Origin) where you can.

## Releases

Packs are released with changesets. The [release guide](https://github.com/framerslab/agentos-extensions/blob/master/RELEASING.md) explains what publishes and when.

## Code of Conduct

By participating you agree to follow the [Code of Conduct](https://github.com/framerslab/agentos-extensions/blob/master/.github/CODE_OF_CONDUCT.md).

## Security

Report vulnerabilities privately as the [security policy](https://github.com/framerslab/agentos-extensions/blob/master/.github/SECURITY.md) describes, never in a public issue.

## Maintainers

Current maintainers are listed in [MAINTAINERS.md](https://github.com/framerslab/agentos-extensions/blob/master/MAINTAINERS.md). Reviews are routed through [.github/CODEOWNERS](https://github.com/framerslab/agentos-extensions/blob/master/.github/CODEOWNERS).

## Contact

Questions about using an extension go to [Discord](https://wilds.ai/discord). Commercial, partnership or sponsorship inquiries: team@frame.dev or [frame.dev](https://frame.dev).

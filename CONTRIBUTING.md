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

1. checks out this repository, and the AgentOS core ([agentos](https://github.com/framerslab/agentos)) into `packages/agentos`
2. runs `node scripts/resolve-core-release.mjs`, which sets the `@framers/agentos` override in `pnpm-workspace.yaml` and the account-sources peer floor to the release the core checkout names, the release every pack then builds and tests against. A core release commit lands a few minutes before its publish; while npm does not serve that release yet, the script sets the newest published release that the committed peer floor admits instead, and its log says so. Neither edit is committed
3. runs `pnpm install --no-frozen-lockfile`
4. builds the core: `cd packages/agentos && pnpm install --no-frozen-lockfile --ignore-workspace && pnpm run build`
5. runs `pnpm run build`; a pack that does not compile fails the run
6. runs `node --test scripts/__tests__/*.test.mjs`, the tests of the release scripts
7. runs `pnpm -r --filter '!@framers/agentos' --if-present run test`, each pack's own tests
8. runs `node scripts/pack-guard.mjs`, the pack guard described below

A push to `master` runs the same job through the release workflow. Maintainers merge a pull request only when CI is green.

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

The guard imports each listed entry from the installed tarball (next to the `@framers/agentos` its peer floor names too) with network access refused, and checks that each name is a function. An exempted entry is not imported; the tarball check still covers its file. These fail the guard before anything is packed: a code entry the role map neither lists nor exempts, a listed or exempted entry the exports map does not export for `import`, an entry both listed and exempted, and an exemption without its reason. Exempt an entry that starts work when it is imported or that loads a peer the package marks optional, which npm does not install. A module that starts work only when it is the process's entry script, such as browser-automation's `./attach/daemon/daemon-main`, can be listed. A JSON entry such as `./manifest.json` needs neither; the tarball check covers it. A test of the release scripts imports every listed entry from the workspace build and checks its names, so a wrong list fails the pull request that writes it.

## Adding an extension pack

1. Propose it with the [new extension form](https://github.com/framerslab/agentos-extensions/issues/new?template=new-extension.yml).
2. Copy the template into a category folder: `cp -r templates/basic-tool registry/curated/<category>/<name>`. The workspace globs in `pnpm-workspace.yaml` cover `registry/curated/*` and `registry/curated/*/*`, so the pack needs no workspace entry.
3. In the pack's `package.json`, set `name` to `@framers/agentos-ext-<name>`, `license` to `Apache-2.0` and the author's name to `Frame`, and add `"publishConfig": { "access": "public" }`. Delete the copied `LICENSE` file: the repository's LICENSE applies, and pnpm packs the workspace root's LICENSE into a package that has none.
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

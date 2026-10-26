# Releasing the extension packs

Each pack is versioned and published on its own with [Changesets](https://github.com/changesets/changesets). A maintainer releases by merging pull requests; nobody publishes by hand.

## What happens after a push to `master`

1. The release workflow ([`release.yml`](https://github.com/framerslab/agentos-extensions/blob/master/.github/workflows/release.yml)) starts. Its first job runs CI ([`ci.yml`](https://github.com/framerslab/agentos-extensions/blob/master/.github/workflows/ci.yml)): the builds, the tests and the pack guard. The release job runs only when that job passes.
2. The release job installs and builds, checks the npm credential with `npm whoami`, then runs `changesets/action`.
3. **When changesets are pending** (files under `.changeset/` on `master`), the action runs `pnpm run version-packages` and opens or updates the pull request "chore: version packages". That pull request raises the `version` of each named package, writes its `CHANGELOG.md`, raises the version in its `manifest.json` to match, and removes the changesets it used. A manifest that already names a higher version than its package is left as it is and reported: that package owes a release. It leaves `registry.json` as it is, since the registry records published versions only. Nothing is published.
4. **When no changeset is pending**, the action runs `pnpm run release` (`changeset publish`). It publishes every public workspace package whose version is not on npm, with provenance, and the action creates a GitHub release for each, tagged `<name>@<version>`.
5. After a publish the release job regenerates `registry.json` on `master`'s tree, and when the result differs from `master`'s copy it opens the pull request "chore: update the extension registry after the release" with the label `landing`, on the branch `chore/registry-update-<run id>-<attempt>`. It never pushes to `master`, whose rules refuse a direct push. GitHub holds the `pull_request` runs of a pull request that `GITHUB_TOKEN` opens until someone with write access approves them, so the step dispatches `ci.yml` and `links.yml` on the branch, waits for them and posts their results as the `build` and `links` statuses the rules require. The pull request then merges like any other. Until it does, `registry.json` names the versions published before the release, every one of them on npm.

Merging the "chore: version packages" pull request is the release: that merge is a push with no changeset pending, so step 4 publishes the new versions.

Before merging it, check that the pull request removes every pending changeset `master` holds: each Markdown file under `.changeset/` except `README.md`. List them with `git ls-tree --name-only origin/master .changeset/ | grep '\.md$' | grep -v README.md` and compare the list with the pull request's deleted files. `README.md` and `config.json` are permanent and are never removed. The action rewrites the pull request's branch after each push to `master`, so a merge made between a changeset landing and that rewrite leaves the changeset pending: the next release run then opens or updates the version pull request again and publishes nothing, even though the run is green. When that happens, merge the new version pull request; its push has no changeset pending and publishes every version that is not on npm.

`changeset publish` does not read changesets. It publishes any public workspace package whose `version` is not on npm, so a version raised by hand in a `package.json` is published by the next push to `master`.

A maintainer can also start the workflow by hand from the Actions tab. It runs the same jobs.

## Writing a changeset

A pull request that changes a pack's shipped code adds a changeset with `pnpm changeset`:

| Change | Bump | Example |
|---|---|---|
| A bug fix or a performance fix | `patch` | 1.0.0 to 1.0.1 |
| A new tool, export or option | `minor` | 1.0.0 to 1.1.0 |
| A change that breaks users, such as a removed export | `major` | 1.0.0 to 2.0.0 |

One pull request can carry several changesets, each naming different packs. A change to one pack does not release another.

## The pack guard

CI runs [`scripts/pack-guard.mjs`](https://github.com/framerslab/agentos-extensions/blob/master/scripts/pack-guard.mjs) before every release. It packs each package the release would publish, checks that the tarball contains the package's entry point, the file of every other entry its exports map gives `import` and, for a pattern such as `./features/*`, at least one file it serves (one its target matches that the subpath spelling its name loads through it), installs it into an empty project, and imports there the package and each entry the role map lists for it (`entryExports`). A code entry the role map neither lists nor exempts (`entryExemptions`), a pattern serving code that it neither exempts nor serves by a listed subpath, a key Node resolves no subpath through, a key whose target Node refuses for `import` or reads as an address rather than as the path it spells, such as `./worker.js?raw` (the root's in any form `exports` gives it), and an exports map that mixes subpath and condition keys fail the guard. A red guard stops the release job, so nothing publishes. The [contributing guide](https://github.com/framerslab/agentos-extensions/blob/master/CONTRIBUTING.md#the-pack-guard) describes what it checks.

## Releasing a new pack

A new pack is published the first time a version pull request that names it merges. It needs:

- a `name` under the `@framers` scope and `"publishConfig": { "access": "public" }` in its `package.json`
- the role `pack` in [`scripts/package-roles.json`](https://github.com/framerslab/agentos-extensions/blob/master/scripts/package-roles.json), and each code entry its exports map has besides the root listed under `entryExports` or exempted under `entryExemptions` there (a pattern exempted by its key, or a subpath it serves listed)
- a changeset with a `minor` bump

The workspace globs in `pnpm-workspace.yaml` cover `registry/curated/*` and `registry/curated/*/*`, so the pack needs no workspace entry.

## The browser meeting bot's image

`@framers/agentos-ext-meeting-browser` ships a container image beside its npm package. A push to `master` that changes `registry/curated/meetings/browser/` runs [`meeting-bot-image.yml`](https://github.com/framerslab/agentos-extensions/blob/master/.github/workflows/meeting-bot-image.yml), which builds the image, runs its lifecycle test and pushes it to GHCR as `ghcr.io/framerslab/agentos-meeting-bot:sha-<commit>`, then prints the pushed digest. The build and the test run with a read-only token; the push is a job of its own, the only one holding `packages: write`, and pushes the image the test ran against. The workflow reads no version: the released version's tag is the release workflow's, as [the version tags of the images](#the-version-tags-of-the-images) says.

## The document parser's image

`@framers/agentos-ext-document-parser` ships a container image beside its npm package. [`document-parser-image.yml`](https://github.com/framerslab/agentos-extensions/blob/master/.github/workflows/document-parser-image.yml) builds it from the pack's `Dockerfile` and runs its lifecycle test (`image/lifecycle.sh`) on a pull request that touches `registry/curated/tools/document-parser/`, `pnpm-lock.yaml`, from which the image takes every package it installs, or the root `package.json`, whose `packageManager` names the pnpm release that installs them, once it is ready for review, and on a push to `master` that touches the pack. On `master` a second job, the only one holding `packages: write`, pushes the image the test ran against to GHCR as `ghcr.io/framerslab/agentos-document-parser:sha-<commit>`, and prints the pushed digest in its summary; a manual run on another branch builds and tests and pushes nothing. The workflow reads no version: the released version's tag is the release workflow's, as [the version tags of the images](#the-version-tags-of-the-images) says.

## The version tags of the images

A released version's image is tagged on GHCR by the release workflow's images step, `node scripts/release-plan.mjs images`, on every release run, and by nothing else. For each pack named in the `images` key of [`scripts/package-roles.json`](https://github.com/framerslab/agentos-extensions/blob/master/scripts/package-roles.json), which gives the pack's folder, its image and its image workflow, the step reads the pack's newest release tag `<name>@<version>` and the commit it names, and takes the image commit: the newest commit on `master`'s first-parent line, at or before that one, that changed the pack's folder, whose push ran the image workflow and pushed `:sha-<its first seven characters>`. When `<image>:<version>` is not on GHCR, it reads the image workflow's runs on the image commit: a successful one, and it copies that commit's `:sha-` manifest to `:<version>` with `docker buildx imagetools create`, with no rebuild, and reads both digests back as equal; a queued or running one, and it waits for it, every 30 seconds for up to 45 minutes; a red one, none, or one still going after the wait, and the step fails naming it, while the npm publish stands and the next release run reconciles again once a re-run of the image workflow on that commit is green. The pack's folder at the release equals its folder at the image commit, since no later first-parent commit changed it, so the version's image is the one that workflow built and tested. A version's tag already on GHCR is never moved, so a host that pins a release keeps the image that release built.

## Configuration

- [`pnpm-workspace.yaml`](https://github.com/framerslab/agentos-extensions/blob/master/pnpm-workspace.yaml) lists the workspace packages and overrides `@framers/agentos` to one range for every pack.
- CI sets that override before its install with [`scripts/resolve-core-release.mjs`](https://github.com/framerslab/agentos-extensions/blob/master/scripts/resolve-core-release.mjs), to the newest release tag (`v<x.y.z>`, no prerelease part) reachable from the head of the core checkout in `packages/agentos`, which `ci.yml` checks out with its whole history and its tags. The core is released by semantic-release, which pushes the tag and publishes and commits nothing back to its `master`, so the version in the core's `package.json` is not its release. The resolver reads that version only when the checkout has no release tag in its history, and says so in a notice; while npm does not serve the tag's version yet, it pins the newest published release that the account-sources peer floor admits, with a notice.
- [`.changeset/config.json`](https://github.com/framerslab/agentos-extensions/blob/master/.changeset/config.json) builds changelogs with `@changesets/changelog-github` for `framerslab/agentos-extensions`, publishes with public access and tracks `master`.

## Secrets

The release workflow uses the `NPM_TOKEN` repository secret (an npm granular access token with read and write access to the `@framers` packages) and the `GITHUB_TOKEN` that GitHub Actions provides. The meeting bot's and the document parser's images are pushed with the `GITHUB_TOKEN` and the `packages: write` permission: each `:sha-<commit>` by the push job of its image's workflow, the only job in that workflow that holds it, and each `:<version>` by the release workflow's images step.

## Never

- Publish from a workstation with `pnpm run release` or `npm publish`. It skips CI, the pack guard and provenance.
- Raise a `version` field by hand. The next push to `master` publishes it.
- Add a workflow step that pushes a commit to `master`. Its rules refuse the push (GH006), so the step fails after everything before it has run. A step that changes the repository pushes a branch of its own and opens a pull request, as the registry step does. The `build` job runs [`.github/scripts/check-workflow-pushes.mjs`](.github/scripts/check-workflow-pushes.mjs), which fails the pull request that adds such a push: a `git push` to `master` (named, or sent there by a `push.default` or `remote.<name>.push` setting), or to the branch the run is on from a workflow that runs on `master` (a merged pull request's `closed` run is on the branch it went into), or one of the push actions it knows (`peaceiris/actions-gh-pages`, `JamesIves/github-pages-deploy-action`, `ad-m/github-push-action`, `stefanzweifel/git-auto-commit-action`, `EndBug/add-and-commit`) pushing there (a deploy action whose repository input names another repository is left to that repository's rules). It reads a command where the shell runs it, in a substitution, an `sh -c` string, an `eval` or text piped or fed to a shell, follows the checked-out branch through `&&`, `||`, `if`, `case`, loops and steps with an `if:` condition (any of which may not run) and into the local composite actions a job calls (`uses: ./<path>`), and reads `git push` options as git does (`--dry-run --no-dry-run` pushes, `--mir` is `--mirror`); a script a shell reads from a file, a variable or a download, a git setting made through `GIT_CONFIG_*` variables or a config file, and a push made by another action, are not read. It reads the YAML with [mikefarah's yq](https://github.com/mikefarah/yq) v4, which GitHub's Ubuntu runners carry; run it elsewhere with `yq` on the path, or `YQ` naming it: `node .github/scripts/check-workflow-pushes.mjs`.
- Edit a pack's `CHANGELOG.md` by hand. The version pull request writes it.

## Troubleshooting

- **Nothing was published:** changesets are pending, so the workflow opened or updated the version pull request; merge it. Or every package's version is already on npm.
- **The pack guard fails:** the named tarball lacks its entry point or the file of an exported entry, the pack or a listed entry does not import, the pack does not construct, or the role map neither lists nor exempts a code entry the pack exports. Fix the pack or its role map entries; nothing publishes while CI is red.
- **`npm whoami` fails:** the `NPM_TOKEN` secret has expired or lacks access to `@framers`.
- **A publish stops partway:** the packages already published stay published. The next push to `master`, or a manual run, publishes the rest, because their versions are not on npm.
- **The registry step failed after a publish:** `registry.json` on `master` still names the old versions. Re-running the failed job does not fix it: every version is on npm, so that run publishes nothing and skips the step. Start the workflow by hand on `master` (Actions, Release & Publish, Run workflow, with `master` as the branch) with **update_registry** checked; the step then regenerates `registry.json` and opens its pull request, as after a publish. A run started on another branch stops at the step: `registry.json` is written for `master` only. With changesets pending the run stops and says so, because the checkout then holds versions that are not published: merge the version pull request, and the release it starts writes `registry.json`.

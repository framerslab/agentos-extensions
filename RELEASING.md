# Releasing the extension packs

Each pack is versioned and published on its own with [Changesets](https://github.com/changesets/changesets). A maintainer releases by merging pull requests; nobody publishes by hand.

## What happens after a push to `master`

1. The release workflow ([`release.yml`](https://github.com/framerslab/agentos-extensions/blob/master/.github/workflows/release.yml)) starts. Its first job runs CI ([`ci.yml`](https://github.com/framerslab/agentos-extensions/blob/master/.github/workflows/ci.yml)): the builds, the tests and the pack guard. The release job runs only when that job passes.
2. The release job installs and builds, checks the npm credential with `npm whoami`, then runs `changesets/action`.
3. **When changesets are pending** (files under `.changeset/` on `master`), the action runs `pnpm run version-packages` and opens or updates the pull request "chore: version packages". That pull request raises the `version` of each named package, writes its `CHANGELOG.md`, raises the version in its `manifest.json` to match, and removes the changesets it used. A manifest that already names a higher version than its package is left as it is and reported: that package owes a release. Nothing is published.
4. **When no changeset is pending**, the action runs `pnpm run release` (`changeset publish`). It publishes every public workspace package whose version is not on npm, with provenance, and the action creates a GitHub release for each, tagged `<name>@<version>`.
5. After a publish the workflow rewrites `registry.json` and commits it as `chore: update extension registry [skip ci]`.

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

CI runs [`scripts/pack-guard.mjs`](https://github.com/framerslab/agentos-extensions/blob/master/scripts/pack-guard.mjs) before every release. It packs each package the release would publish, checks that the tarball contains the package's entry point, the file of every other entry its exports map gives `import` and, for a pattern such as `./features/*`, at least one file it serves (one its target matches that Node loads through it), installs it into an empty project, and imports there the package and each entry the role map lists for it (`entryExports`). A code entry the role map neither lists nor exempts (`entryExemptions`), a pattern serving code that it neither exempts nor serves by a listed subpath, a key Node resolves no subpath through, a key whose target Node refuses for `import` (the root's in any form `exports` gives it), and an exports map that mixes subpath and condition keys fail the guard. A red guard stops the release job, so nothing publishes. The [contributing guide](https://github.com/framerslab/agentos-extensions/blob/master/CONTRIBUTING.md#the-pack-guard) describes what it checks.

## Releasing a new pack

A new pack is published the first time a version pull request that names it merges. It needs:

- a `name` under the `@framers` scope and `"publishConfig": { "access": "public" }` in its `package.json`
- the role `pack` in [`scripts/package-roles.json`](https://github.com/framerslab/agentos-extensions/blob/master/scripts/package-roles.json), and each code entry its exports map has besides the root listed under `entryExports` or exempted under `entryExemptions` there (a pattern exempted by its key, or a subpath it serves listed)
- a changeset with a `minor` bump

The workspace globs in `pnpm-workspace.yaml` cover `registry/curated/*` and `registry/curated/*/*`, so the pack needs no workspace entry.

## The browser meeting bot's image

`@framers/agentos-ext-meeting-browser` ships a container image beside its npm package. A push to `master` that changes `registry/curated/meetings/browser/` runs [`meeting-bot-image.yml`](https://github.com/framerslab/agentos-extensions/blob/master/.github/workflows/meeting-bot-image.yml), which builds the image, runs its lifecycle test and pushes it to GHCR as `ghcr.io/framerslab/agentos-meeting-bot:<version>`, the version in the pack's `package.json` at that commit, and as `:sha-<commit>`, then prints the pushed digest. The build and the test run with a read-only token; the push is a job of its own, the only one holding `packages: write`, and pushes the image the test ran against. The version pull request's merge raises that version, so the run it starts pushes the released version's image, and the digest that run prints is the release's image.

## Configuration

- [`pnpm-workspace.yaml`](https://github.com/framerslab/agentos-extensions/blob/master/pnpm-workspace.yaml) lists the workspace packages and overrides `@framers/agentos` to one range for every pack.
- [`.changeset/config.json`](https://github.com/framerslab/agentos-extensions/blob/master/.changeset/config.json) builds changelogs with `@changesets/changelog-github` for `framerslab/agentos-extensions`, publishes with public access and tracks `master`.

## Secrets

The release workflow uses the `NPM_TOKEN` repository secret (an npm granular access token with read and write access to the `@framers` packages) and the `GITHUB_TOKEN` that GitHub Actions provides. The meeting bot's image is pushed with the `GITHUB_TOKEN` and the `packages: write` permission, which only that workflow's push job holds.

## Never

- Publish from a workstation with `pnpm run release` or `npm publish`. It skips CI, the pack guard and provenance.
- Raise a `version` field by hand. The next push to `master` publishes it.
- Edit a pack's `CHANGELOG.md` by hand. The version pull request writes it.

## Troubleshooting

- **Nothing was published:** changesets are pending, so the workflow opened or updated the version pull request; merge it. Or every package's version is already on npm.
- **The pack guard fails:** the named tarball lacks its entry point or the file of an exported entry, the pack or a listed entry does not import, the pack does not construct, or the role map neither lists nor exempts a code entry the pack exports. Fix the pack or its role map entries; nothing publishes while CI is red.
- **`npm whoami` fails:** the `NPM_TOKEN` secret has expired or lacks access to `@framers`.
- **A publish stops partway:** the packages already published stay published. The next push to `master`, or a manual run, publishes the rest, because their versions are not on npm.
- **The registry step failed after a publish:** `registry.json` on `master` still names the old versions. Re-running the failed job does not fix it: every version is on npm, so that run publishes nothing and skips the step. Start the workflow by hand on `master` (Actions, Release & Publish, Run workflow, with `master` as the branch: the push goes to the branch the run is started on) with **update_registry** checked; the step then writes `registry.json` from the branch and pushes it. With changesets pending the run stops and says so, because the checkout then holds versions that are not published: merge the version pull request, and the release it starts writes `registry.json`.

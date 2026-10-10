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

CI runs [`scripts/pack-guard.mjs`](https://github.com/framerslab/agentos-extensions/blob/master/scripts/pack-guard.mjs) before every release. It packs each package the release would publish, checks that the tarball contains the package's entry point, installs it into an empty project and imports it there. A red guard stops the release job, so nothing publishes. The [contributing guide](https://github.com/framerslab/agentos-extensions/blob/master/CONTRIBUTING.md#the-pack-guard) describes what it checks.

## Releasing a new pack

A new pack is published the first time a version pull request that names it merges. It needs:

- a `name` under the `@framers` scope and `"publishConfig": { "access": "public" }` in its `package.json`
- the role `pack` in [`scripts/package-roles.json`](https://github.com/framerslab/agentos-extensions/blob/master/scripts/package-roles.json)
- a changeset with a `minor` bump

The workspace globs in `pnpm-workspace.yaml` cover `registry/curated/*` and `registry/curated/*/*`, so the pack needs no workspace entry.

## Configuration

- [`pnpm-workspace.yaml`](https://github.com/framerslab/agentos-extensions/blob/master/pnpm-workspace.yaml) lists the workspace packages and overrides `@framers/agentos` to one range for every pack.
- [`.changeset/config.json`](https://github.com/framerslab/agentos-extensions/blob/master/.changeset/config.json) builds changelogs with `@changesets/changelog-github` for `framerslab/agentos-extensions`, publishes with public access and tracks `master`.

## Secrets

The release workflow uses the `NPM_TOKEN` repository secret (an npm granular access token with read and write access to the `@framers` packages) and the `GITHUB_TOKEN` that GitHub Actions provides.

## Never

- Publish from a workstation with `pnpm run release` or `npm publish`. It skips CI, the pack guard and provenance.
- Raise a `version` field by hand. The next push to `master` publishes it.
- Edit a pack's `CHANGELOG.md` by hand. The version pull request writes it.

## Troubleshooting

- **Nothing was published:** changesets are pending, so the workflow opened or updated the version pull request; merge it. Or every package's version is already on npm.
- **The pack guard fails:** the named tarball lacks its entry point, or the pack does not import or construct. Fix the pack; nothing publishes while CI is red.
- **`npm whoami` fails:** the `NPM_TOKEN` secret has expired or lacks access to `@framers`.
- **A publish stops partway:** the packages already published stay published. The next push to `master`, or a manual run, publishes the rest, because their versions are not on npm.

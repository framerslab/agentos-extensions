## Summary

<!-- What this pull request changes and why. -->

## Linked issues

<!-- For example: Fixes #123 -->

## Type of change

- [ ] Bug fix
- [ ] Feature
- [ ] Performance
- [ ] Documentation
- [ ] Refactor
- [ ] Tests
- [ ] Build or CI

## How this was verified

<!-- The commands you ran or the CI jobs you relied on. A pull request with this section empty is sent back. -->

## Migration notes

<!-- Only for a change that breaks existing users: what they must change. -->

## Checklist

- [ ] Tests cover the changed behavior.
- [ ] Docs are updated.
- [ ] The title is the release note: a merge that changes a pack's shipped files publishes a patch of that pack; `!` before the colon of the title, or a line of this description beginning with the words BREAKING CHANGE and a colon, makes it a minor on a pack below 1.0.0 and, on a pack at 1.0.0 or above, refuses the merge until this pull request writes the next major into its `package.json`; any other number is set by raising the pack's `package.json` version by hand (RELEASING.md).
- [ ] A new package's first version publishes through the release workflow's npm token, since npm configures a trusted publisher only for a package it holds; its trusted publisher is configured with `npm trust` once that version is on npm (RELEASING.md).
- [ ] The title follows Conventional Commits, with `!` before the colon for a change that breaks users (`feat!:` or `feat(api)!:`).
- [ ] No secrets or private data are included.
- [ ] Every automated review thread is settled ([how](https://github.com/framerslab/agentos-extensions/blob/master/CONTRIBUTING.md#automated-review-threads)).
- [ ] I have read this change and can explain every line.

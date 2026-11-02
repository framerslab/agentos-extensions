## Summary

<!-- What this pull request changes and why. -->

## Linked issues

<!-- One line, outside this comment:
Closes #n      the pull request that finishes a tracked plan or fixes a reported problem
Part of #n     every earlier pull request of a tracked plan
No issue       a change that fits in one pull request (a fix, a review follow-up, a dependency bump, a docs edit)
-->

## Spec, plan and design

<!-- Links to the spec, plan and design round this implements. In a public repository, public links only. Write "None" when there are none. -->

## Pictures

<!-- Before and after pictures at phone and desktop width for anything a person sees. Write "No visible change" otherwise. -->

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

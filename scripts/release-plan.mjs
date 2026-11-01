#!/usr/bin/env node

// Decides what a push to master publishes, per package, from npm and the
// release tags, for .github/workflows/release.yml and ci.yml, which run it
// before anything is installed: it uses Node's own modules alone.
//
// A package publishes when a file it ships changed since the commit its
// newest published version was published from, or when its package.json
// names a version above every published one. A shipped change publishes the
// next patch; a breaking mark (`!` before the colon of a commit subject, or a
// line beginning `BREAKING CHANGE:` anywhere in a commit message) the next
// minor on a 0.x package. On a package at 1.0.0 or above a breaking mark
// refuses the plan until package.json names the next major by hand, since a
// minor sits inside the caret range consumers hold; a refused package outside
// --only is left unplanned with the refusal as its reason, and so is one whose
// mark is already on master in another pull request's dry run, with a warning;
// master's own run refuses it until a pull request writes the major. Any other number,
// 1.0.0 included, is published only when a lane raises package.json's version
// above every published one by hand. The
// newest published version is the highest of every version npm holds (the
// abbreviated package document) and every `<name>@x.y.z` tag; its commit comes
// from the tag, else from npm's gitHead, else from the provenance attestation.
// A version npm holds that neither the tag nor the package document named is
// found when the run would publish it, and the decision is made again from
// its commit. A version with no tag, or a tag with no release, gets a repair
// record (the newest version, and every one above the newest a tag records, or
// for a release the newest a release records), so the release job makes its tag
// and GitHub release at the commit it was published from. Only
// the run of master's head publishes: a run of a commit master has moved past
// publishes nothing, and a commit master does not hold fails the run.
//
// What ships is the package directory less tests, specs, fixtures and the
// changelog, wherever they sit inside it; a package.json change confined to
// devDependencies ships nothing, and a commit whose only change to a package is
// that carries no breaking mark for it.
//
// A package's range on a sibling is read from the same field of its newest
// published manifest (what consumers hold; an earlier run may have raised it
// in a checkout master never saw), unless master changed that entry since the
// package's base commit, in which case master's text is a maintainer's intent
// and wins; a package never published takes master's text. A newest version
// npm serves no document for yet (one known from its tag alone, in the
// minutes after its publish) is read again every 10 seconds, for up to 30
// minutes, as the publish step waits for a version, and the plan fails naming
// it when npm still serves none. When the range does not admit the sibling's
// version (its planned version, else its newest published one), the range is
// raised in the plan (`^v`, `~v`, `>=v` or `v` in its own form) and the
// package is planned as a patch unless already planned higher, until nothing
// changes; that patch is looked for on npm first, as a shipped change's is,
// and a version npm holds there is the one the decision is made again from.
// A `workspace:` text is never rewritten: pnpm converts it at pack time,
// `workspace:` and `workspace:*` to the sibling's version in the checkout,
// `workspace:~` and `workspace:^` to that version with a tilde or a caret,
// and a range written after `workspace:` (`workspace:^1.2.0`) to that range
// as it is written, which no release can raise, so a sibling released past it
// is named in a warning, whether the range is the published one or master's
// text. devDependencies never plan anything. A range in a form the planner
// does not compare is admitted and named in a warning.
//
// A package whose npm `latest` has no tag here and whose version document
// names another repository is foreign: never planned, its checkout version
// set to npm's, and the owning repository named in the summary.
//
// Nothing here writes to master. The versions go into the job's checkout
// alone (the apply command), master's package.json files keep the versions a
// maintainer last named, and the released state is read from the tags, the
// GitHub releases and npm.
//
// Usage:
//   node scripts/release-plan.mjs plan [--dry-run [--message-file <file>]] [--only <dir,dir>]
//       [--root <dir>] [--registry <url>] [--tip <sha>] [--releases <file>] [--out <dir>]
//
// `plan` writes <out>/release-plan.json (<out> defaults to $RUNNER_TEMP/release-plan,
// else the temporary directory) and the decision to the job summary. --dry-run
// skips the comparison with master's head (a pull request's merge commit is not
// on master) and records dryRun: true; a package published from a commit this
// commit's history does not hold (master released it after this commit's base)
// is read from the two commits' merge base, with a warning, where master's own
// run fails. --message-file <file>, in a dry run alone,
// is the message the squash merge will carry (the pull request's title, a blank
// line, its body): the pull request's own commits are left out of the bump and
// the subjects, and that message stands in for them where the pull request's own
// change, read from its merge base with master's head, touched a shipped path
// (a change confined to package.json's devDependencies touches none).
// --only <dir,dir> limits the planned set
// to those directories: the packages outside it are read (their ranges enter
// the plan as siblings) and never planned, and a planned version that leaves
// an outside package's effective range is a warning, since that package's own
// run plans it; a directory no publishable package of the role map holds, or
// an empty list, fails the plan. --tip, --releases and --registry are the test seams: master's
// head, the repository's release tag names (one a line), and the registry to
// read. A failure exits 1 with ::error::<message> and writes nothing. Beside the
// plan, `plan` leaves in <out> the release list it read (releases.txt) and, when
// the role map has a root, the catalog of the root's newest published tarball
// (published-registry.json), both for `apply`.
//
//   node scripts/release-plan.mjs apply [--root <dir>] [--out <dir>] [--tarballs <dir>]
//       [--registry <url>] [--releases <file>]
//
// `apply` reads <out>/release-plan.json and writes the plan into the checkout,
// whose HEAD must be the plan's head: every listed package's version (its
// planned version, else its newest published one, else npm's for a foreign
// name), the effective and raised ranges as text (a `workspace:` text is left
// as it is), each planned package's manifest.json version and `gitHead`; then,
// with a root role, it places the published catalog at registry.json, regenerates
// it with scripts/update-registry.js --root (the placed copy's timestamps kept
// where nothing changed), compares the two, records on the root's entry each
// catalog entry whose version moved (`moved`: package, from, to), and decides the
// root (step 9: planned when the catalog differs or its own shipped files changed
// since its base, those files being its `files` list and the README, LICENSE,
// LICENCE and COPYING npm packs whatever the list says, last in the publish order)
// and writes its version. It writes the final plan back,
// <tarballs>/expected.json (the tarball each planned package will pack, in the
// publish order; <tarballs> defaults to $RUNNER_TEMP/release-tarballs), the
// outputs publish, planned_dirs, planned_count, repairs and plan to
// $GITHUB_OUTPUT, and the table to the job summary. Nothing is committed and no
// CHANGELOG.md is touched. --registry and --releases are the test seams; the
// release list is <out>/releases.txt by default, so the run reads it once.
//
//   node scripts/release-plan.mjs publish --plan <file> --journal <file>
//       (--tarballs <dir> | --run <command>) [--root <dir>] [--registry <url>] [--tip <sha>]
//       [--publisher-up-to <seconds>]
//
// `publish` publishes the packages of the plan's publish order one at a time, in that
// order, and journals each before the next starts. A plan that publishes nothing (a dry
// run, or a commit master has moved past) publishes nothing and exits 0 with its reason.
// --tarballs <dir> publishes the tarballs the ci job packed into <dir> with
// `npm publish <dir>/<file> --access public --provenance` in the step's environment,
// once <dir>/expected.json is found written for the plan's head, naming the plan's
// order, with every tarball it names present; --run <command> runs `sh -c <command>` in
// each package's directory instead, with RELEASE_NAME, RELEASE_VERSION and RELEASE_DIR
// (the directory as the plan names it) set, from a checkout at the plan's head. Before
// each package master's head is read again (`git ls-remote`, the repository's address
// with GH_TOKEN when it and GITHUB_REPOSITORY are set, else origin; --tip fixes it, a
// test seam): when master has moved past the plan's head, a stopped record is journaled
// and the step ends green, since the newer commit's run plans the rest; a head that does
// not hold the plan's fails. Then the package's versions on npm are read again (its
// package document and the planned version's own document, from --registry): a version
// above the newest one the plan counted fails the step ("npm gained <v> during the run"),
// unless it is the planned version as this run's tarball made it, its version document's
// gitHead the plan's head and its dist.integrity the tarball's: an earlier attempt of this
// run published it (a re-run of the release job replays the first attempt's plan and
// tarballs), so it is journaled as published, with `already: true`, and not published
// again. In --run mode there is no tarball to compare it with, and the planned version on
// npm fails the step as any other version does. A publish that exits non-zero journals a
// failed record and ends the step with that exit code; a success journals a published
// record (in tarball mode with the tarball's name and its sha512 integrity). When a
// package later in the order names the one just published in its dependencies,
// peerDependencies or optionalDependencies, npm's document for the new version is read
// every 10 seconds until it answers, before the next package. Those waits share one
// budget, 30 minutes in all, so the release job's time limit holds them whatever chain of
// dependents the plan orders, and the wait that spends the rest of it fails the step
// naming its version. --journal is the file the records go to, one JSON object a line
// ($RUNNER_TEMP/published.jsonl in the release job); it is appended to, never rewritten,
// and it is the proof of what npm accepted.
//
// When the step ends, whichever way, each version the journal holds is read on npm for who
// published it (the version document's _npmUser, whose trustedPublisher field npm sets on a
// publish through a trusted publisher and leaves off a publish through a token). A version
// through the token warns, naming the package, the version and the `npm trust` command to set
// its publisher, built from GITHUB_WORKFLOW_REF and GITHUB_REPOSITORY; a package's first
// version gives a notice instead, since it publishes through the token by design. The step
// summary carries the same lines and `published through the token: <n> of <m>` when n is above
// 0. A version npm answers 404 for is read again every 10 seconds, within one budget of fifteen
// minutes for all of them (--publisher-up-to sets it, a test seam); a read that fails or finds
// no publisher warns that it could not read it. A version an earlier attempt of the run
// published, journaled with `already`, is worded as that attempt's, since its publisher may
// have been set since. None of this changes the step's exit code, and a plan that publishes
// nothing reads nothing.
//
//   node scripts/release-plan.mjs tags --plan <file> --journal <file> [--root <dir>]
//
// `tags` makes the tags and the GitHub releases the journal and the plan's repair records
// name: an annotated tag <name>@<version> at the plan's head for each published record and
// at the record's commit for each tag repair. Each is made in this clone first (the images
// step that follows in the job reads the release tags from the clone) and then pushed, all
// in one `git push --atomic` to the repository's address with GH_TOKEN (never printed), up
// to three times 20 and 40 seconds apart, each attempt read back with `git ls-remote
// --tags`. A tag already at its commit is kept, and pushed unless the remote holds it there
// already; one at another commit, here or on the remote, fails the step by name, and the
// others still go. Then each tag in place, and each release repair, gets its GitHub release
// unless one exists (a draft is none): `gh release create <tag> --verify-tag`, its notes a
// line `- <subject> (#<n>)` for each commit subject since the package's base, then a line
// `- <sibling> <from> to <to>, in <field>` for each range the plan raised on a sibling,
// "The first release of <name>." for a package with no base, or "<name>@<version> as npm holds it,
// published from <commit>." for a repair; the root's notes then list the catalog entries
// whose versions moved, `- <name> <from> to <to>`. A create that fails is followed by a read
// of the release: one found then was made by another run meanwhile and counts as made, with a
// line saying so; otherwise the create's failure fails the step. Last, a planned
// package the journal names no publish for fails the step, after the others are tagged,
// unless the journal holds a stopped record or the package's tag <name>@<planned> names
// the plan's head in this clone already, whose checkout fetched the remote's tags: an
// earlier attempt of this run published and tagged it. It needs GH_TOKEN (or GITHUB_TOKEN) and
// GITHUB_REPOSITORY. The tagger is the committer the environment names, else the one git's
// config names, else github-actions[bot], the identity the release tags have carried.
// A dry run's plan, or one that publishes nothing, tags nothing.
//
//   node scripts/release-plan.mjs images [--root <dir>] [--every <seconds>]
//       [--up-to <minutes>]
//
// `images` writes each image pack's version tag on GHCR, and nothing else
// writes one. For each pack the role map's images key names (its folder, its
// image and its image workflow), every release tag of the pack made since the
// role map named its image (the role map at the tag's commit lists the pack's
// folder under images; before that the image workflow wrote the version's tag
// itself) gives a version and its commit, and the image's tags on GHCR are read
// once, as one list (`skopeo list-tags`). For each such version whose
// <image>:<version> GHCR lacks: the image commit is the newest first-parent
// commit at or before the tag's commit that changed the pack's folder, the image
// workflow's run on it is read and waited for while it is queued or running
// (every --every seconds, 30 by default; the step waits up to --up-to minutes,
// 45 by default, in all, for every image), and once it has succeeded that
// commit's :sha-<seven characters> manifest is copied to the version's tag with
// no rebuild, and both digests are read back as equal. A version's tag already
// on GHCR is never moved. Every version is reconciled, and one that fails fails
// the command, naming each. It needs GH_TOKEN, GITHUB_ACTOR and
// GITHUB_REPOSITORY, and prints "no image packs in the role map" when the role
// map has no images key.
//
// The role map scripts/package-roles.json is the one source of the package
// list: every directory whose role is pack, library, template or root, whose
// package.json exists and is not private (templates/basic-tool ships as
// @framers/agentos-template-basic-tool; the other templates are private).

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REGISTRY = 'https://registry.npmjs.org';

/** What npm's own installs ask for: every version with its dependency fields, and no README. */
const ABBREVIATED = 'application/vnd.npm.install-v1+json';

/** The provenance statement's predicate type, whose resolved dependency names the publishing commit. */
const SLSA_PROVENANCE = 'https://slsa.dev/provenance/v1';

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const SHA = /^[0-9a-f]{40}$/;
const RELEASE_TAG = /^(.+)@(\d+\.\d+\.\d+)$/;

/**
 * The roles the plan lists, a template among them (one that is not private is published like a pack); the root is
 * decided by apply (its catalog), the others by planRelease.
 */
const LISTED_ROLES = new Set(['pack', 'library', 'template', 'root']);
const PLANNED_ROLES = new Set(['pack', 'library', 'template']);

/** How many versions npm may hold past the newest one a tag or its document names before the plan gives up. */
const MAX_REANCHORS = 50;

/**
 * How often and for how long, in seconds, the plan reads again a newest version's document npm does not serve yet
 * (one known from its tag alone, in the minutes after its publish), and the publish step's waits for the versions it
 * publishes before the packages that name them, which share `upTo` as one budget, so the release job's time limit
 * holds them whatever chain of dependents a run publishes. npm's version document has answered 404 for ten minutes
 * after a publish (14 October 2026) and for over twenty-five (13 October 2026), so the wait is thirty minutes.
 */
export const DOCUMENT_WAIT = { every: 10, upTo: 1800 };

/**
 * How often and for how long, in seconds, the images step reads an image run that is queued or running: one wait,
 * for every image together. The release job's time limit holds this and DOCUMENT_WAIT's.
 */
export const IMAGE_WAIT = { every: 30, upTo: 2700 };

/**
 * How often and for how long, in seconds, the publish command reads again the document of a version it published when
 * npm does not serve it yet, to read who published it: one wait for every version together. npm's time entries have
 * come up to 188 seconds after a publish line on an ordinary day (release run 41256912415) and a version document 613
 * seconds after one (14 October 2026), and a version read as unserved names no token, so this holds both. This reports
 * and decides nothing, so it is shorter than DOCUMENT_WAIT, and a version still unserved at its end is named as unread.
 */
export const PUBLISHER_WAIT = { every: 10, upTo: 900 };

/** How long, in milliseconds, one read of a publisher may take, so a read that hangs never holds the release job. */
const PUBLISHER_READ_TIMEOUT = 20_000;

/** How many registry reads run at once. */
const PARALLEL_READS = 8;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(SCRIPT_DIR, '..');

/**
 * The variables that point git at a repository, as `git rev-parse --local-env-vars` lists them. A hook exports
 * GIT_DIR and its kin for the repository it runs in; the checkout this script reads is named by --root, so git
 * reads it without them.
 */
const REPOSITORY_VARIABLES = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
];

/**
 * The paths inside a package directory that no tarball carries: a change confined to them publishes nothing.
 * Each holds at any depth inside the package: `**\/name\/**` and `name/` are a directory of that name wherever it
 * sits (meeting-browser's image/test/ among them), `**\/*.x.*` a file name wherever it sits, and a bare name a
 * file of that name wherever it sits.
 */
export const SHIPPED_EXCLUDES = ['**/__tests__/**', '**/*.test.*', '**/*.spec.*', 'test/', 'tests/', 'fixtures/', 'CHANGELOG.md'];

/** A predicate for one exclusion pattern over a path relative to the package directory. */
function excludes(pattern) {
  if (pattern.startsWith('**/') && pattern.endsWith('/**')) {
    const name = pattern.slice(3, -3);
    return (file) => file.split('/').slice(0, -1).includes(name);
  }
  if (pattern.startsWith('**/')) {
    const glob = new RegExp(`^${pattern.slice(3).split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
    return (file) => glob.test(file.split('/').pop());
  }
  if (pattern.endsWith('/')) {
    const name = pattern.slice(0, -1);
    return (file) => file.split('/').slice(0, -1).includes(name);
  }
  return (file) => file.split('/').pop() === pattern;
}

const EXCLUSIONS = SHIPPED_EXCLUDES.map(excludes);

/**
 * Whether a path, relative to its package directory and written with forward slashes, is one the package ships.
 * @param {string} relativePath
 * @param {string[]} [patterns] the exclusions, SHIPPED_EXCLUDES by default
 */
export function isShippedPath(relativePath, patterns = SHIPPED_EXCLUDES) {
  const file = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  const exclusions = patterns === SHIPPED_EXCLUDES ? EXCLUSIONS : patterns.map(excludes);
  return !exclusions.some((excluded) => excluded(file));
}

const parts = (version) => {
  const match = VERSION.exec(version ?? '');
  if (match === null) throw new Error(`${version} is not an x.y.z version`);
  return match.slice(1).map(Number);
};

/** Orders two x.y.z versions, each part as a number. */
export function compareVersions(a, b) {
  const [left, right] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

export function raisePatch(version) {
  const [major, minor, patch] = parts(version);
  return `${major}.${minor}.${patch + 1}`;
}

export function raiseMinor(version) {
  const [major, minor] = parts(version);
  return `${major}.${minor + 1}.0`;
}

/** The fields a sibling range enters the plan from; devDependencies never plan anything. */
const SIBLING_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];

const RANGE = /^(\^|~|>=\s*)?(\d+\.\d+\.\d+)$/;

/**
 * The form of a range the planner compares: `caret` (`^x.y.z`), `tilde` (`~x.y.z`), `floor` (`>=x.y.z`), `exact`
 * (`x.y.z`) or `workspace` (any `workspace:` text, which pnpm converts at pack time); null for any other text.
 * @param {string} range
 * @returns {{ form: 'caret' | 'tilde' | 'floor' | 'exact' | 'workspace', version: string | null } | null}
 */
export function rangeForm(range) {
  const text = String(range ?? '').trim();
  if (text.startsWith('workspace:')) return { form: 'workspace', version: null };
  const match = RANGE.exec(text);
  if (match === null) return null;
  const operator = (match[1] ?? '').trim();
  return { form: operator === '^' ? 'caret' : operator === '~' ? 'tilde' : operator === '>=' ? 'floor' : 'exact', version: match[2] };
}

/**
 * Whether a range admits a version, as npm reads the forms this workspace uses (node-semver's README): a caret
 * keeps the leftmost non-zero part fixed (`^1.2.3` is `>=1.2.3 <2.0.0`, `^0.2.3` is `>=0.2.3 <0.3.0`, `^0.0.3`
 * is `>=0.0.3 <0.0.4`), a tilde keeps the major and the minor (`~1.2.3` is `>=1.2.3 <1.3.0`), a `>=` floor admits
 * everything at or above it, an exact version itself alone, and a `workspace:` text everything, since pnpm converts
 * it at pack time (packedRange). Any other text is admitted: the planner does not compare it, and the caller says so
 * in a warning.
 * @param {string} range
 * @param {string} version x.y.z
 */
export function rangeAdmits(range, version) {
  const parsed = rangeForm(range);
  if (parsed === null || parsed.form === 'workspace') return true;
  const order = compareVersions(version, parsed.version);
  if (parsed.form === 'exact') return order === 0;
  if (parsed.form === 'floor') return order >= 0;
  if (order < 0) return false;
  const [major, minor] = parts(parsed.version);
  const [candidateMajor, candidateMinor] = parts(version);
  if (parsed.form === 'tilde') return candidateMajor === major && candidateMinor === minor;
  if (major > 0) return candidateMajor === major;
  if (minor > 0) return candidateMajor === 0 && candidateMinor === minor;
  return order === 0;
}

/**
 * The range raised to admit a version, in its own form: `^v` for a caret, `~v` for a tilde, `>=v` for a floor, `v`
 * for an exact version. A `workspace:` text, or a text the planner does not compare, comes back unchanged.
 * @param {string} range
 * @param {string} version x.y.z
 */
export function raiseRange(range, version) {
  const parsed = rangeForm(range);
  if (parsed === null || parsed.form === 'workspace') return range;
  parts(version);
  if (parsed.form === 'caret') return `^${version}`;
  if (parsed.form === 'tilde') return `~${version}`;
  if (parsed.form === 'floor') return `>=${version}`;
  return version;
}

/**
 * What pnpm packs a `workspace:` range as, from the sibling's version in the checkout (pnpm 10's exportable
 * manifest, replaceWorkspaceProtocol and, for peerDependencies, replaceWorkspaceProtocolPeerDependency):
 * `workspace:` and `workspace:*` as the version itself, `workspace:~` and `workspace:^` as the version with a tilde
 * or a caret (in peerDependencies `workspace:>=`, `>`, `<=` and `<` with their operator too), a path as the version,
 * and a range written after `workspace:` (`workspace:^1.2.0`) as it is written, which does not follow the sibling
 * (`written`).
 * @param {string} field the dependency field the range sits in
 * @param {string} range a `workspace:` text
 * @param {string} version x.y.z, the sibling's version in the checkout
 * @returns {{ text: string, written: boolean }}
 */
function packedRange(field, range, version) {
  const text = String(range);
  if (field === 'peerDependencies') {
    const match = /workspace:([\^~*]|>=|>|<=|<)?((\d+|[xX*])(\.(\d+|[xX*])){0,2})?/.exec(text);
    if (match === null || match[2]) return { text: text.replace('workspace:', ''), written: true };
    const operator = match[1] === undefined || match[1] === '*' ? '' : match[1];
    return { text: text.replace(match[0], `${operator}${version}`), written: false };
  }
  const bare = /^workspace:(?:.+@)?([\^~*])?$/.exec(text);
  if (bare !== null) return { text: `${bare[1] === '^' || bare[1] === '~' ? bare[1] : ''}${version}`, written: false };
  if (text.startsWith('workspace:./') || text.startsWith('workspace:../')) return { text: version, written: false };
  const rest = text.slice('workspace:'.length);
  return { text: rest.includes('@') ? `npm:${rest}` : rest, written: true };
}

/**
 * Whether a commit message carries a breaking mark: `!` before the colon of its first line (`type(scope)!: subject`
 * or `type!: subject`), or a line beginning `BREAKING CHANGE:` anywhere in the message (`BREAKING-CHANGE:` is the
 * same mark by the Conventional Commits specification).
 * @param {string} message the whole message, subject first
 */
export function isBreaking(message) {
  const [first = ''] = String(message ?? '').split('\n');
  if (/^[A-Za-z]+(?:\([^)]*\))?!:/.test(first)) return true;
  return /^BREAKING[ -]CHANGE:/m.test(message);
}

/**
 * The publishable packages the role map lists: every directory whose role is pack, library, template or root,
 * whose package.json exists and is not private, in directory order.
 * @param {string} root the checkout
 * @returns {{ name: string, dir: string, role: string, version: string, manifestVersion: string | null,
 *   fields: { dependencies?: object, peerDependencies?: object, optionalDependencies?: object, devDependencies?: object } }[]}
 */
export function listPackages(root) {
  const roleMap = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'package-roles.json'), 'utf8'));
  const packages = [];
  for (const [dir, role] of Object.entries(roleMap.roles ?? {})) {
    if (!LISTED_ROLES.has(role)) continue;
    const file = path.join(root, dir, 'package.json');
    if (!fs.existsSync(file)) continue;
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (pkg.private === true) continue;
    const manifestFile = path.join(root, dir, 'manifest.json');
    let manifestVersion = null;
    if (fs.existsSync(manifestFile)) {
      try {
        manifestVersion = JSON.parse(fs.readFileSync(manifestFile, 'utf8')).version ?? null;
      } catch (error) {
        throw new Error(`${dir}/manifest.json is not valid JSON: ${error.message}`);
      }
    }
    packages.push({
      name: pkg.name,
      dir,
      role,
      version: pkg.version,
      manifestVersion,
      fields: {
        dependencies: pkg.dependencies,
        peerDependencies: pkg.peerDependencies,
        optionalDependencies: pkg.optionalDependencies,
        devDependencies: pkg.devDependencies,
      },
    });
  }
  return packages.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
}

/** JSON with every object's keys in order, so two documents compare by content. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The owner/name a repository address spells, or null. */
function repositoryNamed(url) {
  const match = /github\.com[/:]([^/@#\s]+\/[^/@#\s]+)/.exec(String(url ?? ''));
  return match === null ? null : match[1].replace(/\.git$/, '');
}

/**
 * The publishing commit the provenance attestation of a version names: the SLSA v1 statement's resolved
 * dependency whose address names this repository. npm carries each statement base64 inside a DSSE envelope.
 * @param {any} document the attestations document, `{ attestations: [...] }`
 * @param {string | null} repository owner/name
 */
function attestedCommit(document, repository) {
  if (!document || !Array.isArray(document.attestations) || !repository) return null;
  for (const entry of document.attestations) {
    if (entry?.predicateType !== SLSA_PROVENANCE) continue;
    let statement = entry;
    const payload = entry.bundle?.dsseEnvelope?.payload;
    if (typeof payload === 'string') {
      try {
        statement = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
      } catch {
        continue;
      }
    }
    for (const dependency of statement?.predicate?.buildDefinition?.resolvedDependencies ?? []) {
      const commit = dependency?.digest?.gitCommit;
      const named = repositoryNamed(dependency?.uri);
      if (named !== null && named.toLowerCase() === repository.toLowerCase() && SHA.test(commit ?? '')) return commit;
    }
  }
  return null;
}

/** The pull request number a squash subject ends with, `(#n)`, or null. */
const pullRequestOf = (subject) => {
  const match = /\(#(\d+)\)\s*$/.exec(subject);
  return match === null ? null : Number(match[1]);
};

/** Runs `work` over `items` with at most `limit` in flight, keeping the order. */
async function mapWithLimit(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * The decision for the packs, pure: steps 0 to 8 of the design. Resolves to the plan without its root and order.
 *
 * `head` is the commit the run checked out and `tip` master's head (null when unknown: the commit then counts as
 * master's head). `packages` is listPackages' list; `tags` every `<name>@x.y.z` tag in the clone with its peeled
 * commit, never only those `head` contains; `releases` the repository's release tag names. `registry` answers
 * `document(name)`, `versionDocument(name, version, { fresh })` and `attestation(name, version)` with the parsed
 * document, or null for a 404, and throws for any other answer (`fresh` reads a version's document again rather than
 * from what an earlier read answered). `git` answers `isAncestor(a, b)`, `holdsCommit(sha)`, `mergeBase(a, b)`
 * (their best common ancestor), `changedSince(commit, dir, excludes)` (the shipped paths changed, relative to the
 * directory), `messagesSince(commit, dir, excludes)` (each commit that changed a shipped path,
 * `{ sha, subject, body }`), `fileAt(commit, file)` (a committed file's text, or null) and
 * `entryChanged(commit, dir, siblingName)` (whether the sibling's text in the package's dependencies,
 * peerDependencies or optionalDependencies differs between the package.json at `commit` and at `head`; an entry
 * absent at one and present at the other counts as changed). In a dry run, a package published from a commit this
 * history does not hold (master released it after this commit's base) is read from the merge base of that commit
 * and `head`, with a warning. `message`, in a dry run, is the message the squash merge will carry (the pull
 * request's title and body): the commits since a base that `tip` does not hold are the pull request's own, which the
 * squash replaces, so they are left out, and the message stands in for them, at `head`, when the pull request's own
 * change (what `head` changed since its merge base with `tip`) touched a shipped path. A package's `alsoChanged`
 * names files counted as changed since its base beside git's answer (the root's catalog, which apply compares with
 * the published copy outside git). `documentWait` ({ every, upTo }, in seconds) is how often and for how long a
 * newest version's document npm does not serve yet is read again before the plan fails naming it. `refuse` (true)
 * fails the plan for a breaking mark refused on a package it plans for; planRoot passes false for a root outside
 * the run's --only, which then stays unplanned with the refusal as its reason.
 */
export async function planRelease({
  repository = null,
  head,
  tip = null,
  dryRun = false,
  only = null,
  message = null,
  packages,
  tags,
  releases,
  registry,
  git,
  maxReanchors = MAX_REANCHORS,
  documentWait = DOCUMENT_WAIT,
  refuse = true,
}) {
  // --only names the directories to plan. A directory no publishable package of the role map holds (a misspelling, a
  // trailing slash, a private package) would read as one more package outside the list, and the run would plan
  // nothing and end green with a merged change left off npm, so it is refused by name, as an empty list is.
  if (only !== null) {
    if (only.length === 0) throw new Error('--only names no directory: it takes the comma-separated directories of the packages to plan');
    const listed = new Set(packages.map((pkg) => pkg.dir));
    const unknown = only.filter((dir) => !listed.has(dir));
    if (unknown.length > 0) {
      throw new Error(`--only must name the directories of publishable packages in scripts/package-roles.json; not found: ${unknown.join(', ')}`);
    }
  }
  const plannable = packages.filter((pkg) => PLANNED_ROLES.has(pkg.role));
  const skeleton = { schema: 1, repository, head, tip, dryRun, only, message };
  // The message a dry run's squash merge will carry, read as one commit at head.
  const squash = message === null ? null : { sha: head, subject: String(message).split('\n')[0].trim(), body: String(message) };
  // The merge base of head and master's tip, read once: what head changed since it is the pull request's own change,
  // whether master stayed where the merge commit was made or moved on after it.
  let mergeBaseWithTip;
  const ownBase = () => (mergeBaseWithTip ??= git.mergeBase(head, tip));
  const entryOf = (pkg, more = {}) => ({
    name: pkg.name,
    dir: pkg.dir,
    role: pkg.role,
    foreign: false,
    newest: null,
    baseCommit: null,
    baseSource: null,
    named: null,
    planned: null,
    bump: null,
    checkoutVersion: null,
    reason: null,
    subjects: [],
    ranges: [],
    ...more,
  });

  // Step 0, the run. A commit master has moved past publishes nothing: the tip's own run carries its changes.
  if (!dryRun && tip !== null && tip !== head) {
    if (await git.isAncestor(head, tip)) {
      const reason = `master has moved past this commit to ${tip.slice(0, 8)}, whose own run publishes this one's changes`;
      return { ...skeleton, run: { publishes: false, reason }, packages: plannable.map((pkg) => entryOf(pkg, { reason })), root: null, order: [], repairs: [], foreign: [], warnings: [] };
    }
    throw new Error(`master's tip ${tip.slice(0, 8)} does not hold this commit ${head.slice(0, 8)}: only master publishes`);
  }
  const run = dryRun
    ? { publishes: false, reason: 'a dry run: the plan is read for this commit as its merge to master would be read, and nothing publishes' }
    : tip === null
      ? { publishes: true, reason: 'no master head was given, so this commit counts as its head' }
      : { publishes: true, reason: "this commit is master's head" };

  const tagsByName = new Map();
  for (const tag of tags) {
    if (!tagsByName.has(tag.name)) tagsByName.set(tag.name, []);
    tagsByName.get(tag.name).push(tag);
  }
  const released = new Set(releases);
  const onlySet = only === null ? null : new Set(only);
  const repairs = new Map();
  const warnings = [];
  const foreign = [];
  const repair = (record) => repairs.set(`${record.name}@${record.version}`, record);

  const decide = async (pkg) => {
    const document = await registry.document(pkg.name);
    const held = Object.keys(document?.versions ?? {});
    const latest = document?.['dist-tags']?.latest;
    const tagged = tagsByName.get(pkg.name) ?? [];

    // Step 8, a foreign name: npm's latest has no tag here and its document names another repository. The copy
    // here is not planned; the checkout takes npm's version so the catalog lists the truth.
    if (repository !== null && typeof latest === 'string' && VERSION.test(latest) && !tagged.some((tag) => tag.version === latest)) {
      const latestDocument = await registry.versionDocument(pkg.name, latest);
      const address = typeof latestDocument?.repository === 'string' ? latestDocument.repository : latestDocument?.repository?.url;
      const owner = repositoryNamed(address);
      if (owner !== null && owner.toLowerCase() !== repository.toLowerCase()) {
        const shown = String(address).replace(/^git\+/, '');
        foreign.push({ name: pkg.name, dir: pkg.dir, npmVersion: latest, repository: shown });
        const reason = `published from ${shown}, not from this repository: its copy here is not planned`;
        return { pkg, entry: entryOf(pkg, { foreign: true, newest: latest, checkoutVersion: latest, reason }), document, eligible: false };
      }
    }

    let older = false;
    const newest = [latest, ...held, ...tagged.map((tag) => tag.version)]
      .filter((version) => typeof version === 'string' && VERSION.test(version))
      .reduce((top, version) => (top === null || compareVersions(version, top) > 0 ? version : top), null);
    const named = VERSION.test(pkg.version ?? '') ? pkg.version : null;
    const manifest = path.posix.join(pkg.dir, 'package.json');

    // The commit a version was published from: its tag, else npm's gitHead for it when the clone holds that
    // commit, else the commit its provenance attestation names.
    const commitOf = async (version) => {
      const tag = tagged.find((candidate) => candidate.version === version);
      if (tag) return { commit: tag.commit, source: 'tag' };
      const gitHead = (await registry.versionDocument(pkg.name, version))?.gitHead;
      if (typeof gitHead === 'string' && SHA.test(gitHead) && (await git.holdsCommit(gitHead))) return { commit: gitHead, source: 'gitHead' };
      const attested = attestedCommit(await registry.attestation(pkg.name, version), repository);
      if (attested !== null && (await git.holdsCommit(attested))) return { commit: attested, source: 'attestation' };
      return null;
    };

    /**
     * The commits since `commit` that changed a shipped path, with their messages. With the squash message of a
     * dry run, the commits master's tip does not hold are the pull request's own, which the squash replaces with
     * one commit carrying its title and body: they are left out, and that commit stands in for them when the pull
     * request's own change (what head changed since its merge base with the tip) touched a shipped path of the
     * package. The tip's own tree is not that change once master moves past the commit the merge commit was made
     * on: a package master changed since would read as the pull request's. With no tip to tell them apart, every
     * commit is kept and the message is added.
     */
    const historySince = async (commit) => {
      const messages = await git.messagesSince(commit, pkg.dir, SHIPPED_EXCLUDES);
      if (squash === null) return messages;
      const kept = [];
      for (const record of messages) {
        if (tip === null || (await git.isAncestor(record.sha, tip))) kept.push(record);
      }
      const own = tip === null || (await ownChangeShips());
      return own ? [...kept, squash] : kept;
    };

    /**
     * Whether the pull request's own change (what head changed since its merge base with the tip) touched what the
     * package ships: a change confined to package.json's devDependencies ships nothing, so the message carries no
     * mark for the package, as that change's own commit on master carries none (gitReader's messagesSince).
     */
    const ownChangeShips = async () => {
      const changed = await git.changedSince(await ownBase(), pkg.dir, SHIPPED_EXCLUDES);
      if (changed.length === 0) return false;
      return !(changed.length === 1 && changed[0] === 'package.json' && (await onlyDevDependenciesDiffer(git, await ownBase(), head, manifest)));
    };

    const subjectsOf = (history) => history.map(({ sha, subject }) => ({ sha, subject, pullRequest: pullRequestOf(subject) }));

    /** Whether package.json's only difference since `commit` lies in devDependencies, which no consumer installs. */
    const onlyDevDependenciesChanged = (commit) => onlyDevDependenciesDiffer(git, commit, head, manifest);

    /** The version package.json named at `commit`, or null. */
    const versionAt = async (commit) => {
      try {
        return JSON.parse((await git.fileAt(commit, manifest)) ?? 'null')?.version ?? null;
      } catch {
        return null;
      }
    };

    /**
     * The refusal of a breaking mark on a package at 1.0.0 or above, or null. This script never picks a major, and the
     * minor it would pick sits inside the caret range consumers hold (`^1.4.0` admits 1.5.0), so the break would
     * reach them on their next install: the plan refuses until package.json names the next major, which `written`
     * (a version named by hand above `version`, or null) at or above it lifts. The squash message's own mark is read
     * first, since that is the one the pull request can drop. A mark on a commit master holds can only be answered by
     * a major: in a pull request's dry run it is `held`, not this pull request's to fix, and fails nothing.
     */
    const breakingRefusal = (history, version, written) => {
      const [major] = parts(version);
      if (major < 1) return null;
      const mark = history.includes(squash) && isBreaking(squash.body) ? squash : history.find(({ body }) => isBreaking(body));
      if (!mark) return null;
      const next = `${major + 1}.0.0`;
      if (written !== null && compareVersions(written, next) >= 0) return null;
      const onMaster = mark !== squash && (!dryRun || (squash !== null && tip !== null));
      const text =
        `${pkg.name} is at ${version} and ${mark.sha.slice(0, 8)} "${mark.subject}" carries a breaking mark: ` +
        (onMaster ? `write ${next} into ${manifest} in a pull request, since a commit on master keeps its mark` : `write ${next} into ${manifest} in this pull request, or drop the breaking mark`);
      return { text, held: onMaster && dryRun };
    };

    // The deepest re-anchor this decision made, so a later one (a dependent's patch npm holds, step 7) counts on.
    let deepest = 0;
    const decideFrom = async (version, steps) => {
      deepest = Math.max(deepest, steps);
      if (steps > maxReanchors) {
        throw new Error(`npm holds more than ${maxReanchors} versions of ${pkg.name} after the newest one a tag or its package document names`);
      }
      const found = await commitOf(version);
      if (found === null) {
        throw new Error(`npm holds ${pkg.name}@${version}, but no tag, gitHead or provenance attestation names a commit of this repository for it`);
      }
      const { commit: publishedFrom, source } = found;
      if (source !== 'tag') repair({ name: pkg.name, version, commit: publishedFrom, kind: 'tag' });
      else if (!released.has(`${pkg.name}@${version}`)) repair({ name: pkg.name, version, commit: publishedFrom, kind: 'release' });
      // Where the shipped diff, the commit messages and the entries are read from: the commit the version was
      // published from, or, in a dry run of a commit master has released past, that commit's merge base with head.
      let baseCommit = publishedFrom;
      const settled = (more) => entryOf(pkg, { newest: version, baseCommit, baseSource: source, ...more });
      const nothing = (reason) => settled({ reason });
      // A refusal fails the run below. One held in a dry run leaves the package unplanned with a warning.
      const refused = ({ text, held }) => {
        if (!held) return settled({ reason: text, refusal: text });
        if (!warnings.includes(text)) warnings.push(text);
        return nothing(text);
      };
      // Publishes `planned` unless npm holds it already: a version npm holds that neither a tag nor the package
      // document named is a newer published version, and the decision is made again from its commit.
      const publishOrCount = async (planned, bump, reason, subjects) => {
        if ((await registry.versionDocument(pkg.name, planned)) !== null) return decideFrom(planned, steps + 1);
        return settled({ planned, bump, reason, subjects, named: bump === 'named' ? planned : null });
      };

      if (named !== null && compareVersions(named, version) > 0) {
        const history = await historySince(baseCommit);
        const refusal = breakingRefusal(history, version, named);
        if (refusal !== null) return refused(refusal);
        return publishOrCount(named, 'named', `package.json names ${named}, above ${pkg.name}@${version}`, subjectsOf(history));
      }
      if (baseCommit === head) return nothing(`${pkg.name}@${version} was published from this commit`);
      if (!(await git.isAncestor(baseCommit, head))) {
        if (await git.isAncestor(head, baseCommit)) {
          older = true;
          return nothing(`this commit is older than ${baseCommit.slice(0, 8)}, which ${pkg.name}@${version} was published from`);
        }
        if (!dryRun) {
          // Skipping here would leave every later push unpublished behind a green run.
          throw new Error(
            `${pkg.name}@${version} names ${baseCommit.slice(0, 8)} (its tag, or npm's gitHead or provenance attestation for it), ` +
              `which this commit's history does not hold; raise ${manifest}'s version above ${version} to publish from this history, ` +
              'or re-point the tag if it was moved by hand',
          );
        }
        // A dry run reads a pull request's merge commit or a branch, and a re-run reads that same commit again, while
        // master's runs go on tagging what they publish at commits it lacks. Its merge lands on top of that release,
        // so what it would publish is what it changed since the two commits' merge base; master's own run still fails
        // above, which is where a tag moved by hand is caught.
        baseCommit = await git.mergeBase(publishedFrom, head);
        warnings.push(
          `${pkg.name}@${version} was published from ${publishedFrom.slice(0, 8)}, which this commit's history does not hold ` +
            `(master released it after this commit's base, or its tag was moved by hand); the dry run reads ${pkg.name} ` +
            `from their merge base ${baseCommit.slice(0, 8)}`,
        );
      }
      if (named !== null && compareVersions(named, version) < 0 && (await versionAt(baseCommit)) !== named) {
        warnings.push(
          `${manifest} names ${named}, which is not above ${version}, the newest published version of ${pkg.name}; ` +
            'a version is named by raising it above every published one, so the name is ignored',
        );
      }
      const changed = [...(await git.changedSince(baseCommit, pkg.dir, SHIPPED_EXCLUDES)), ...(pkg.alsoChanged ?? [])];
      if (changed.length === 0) return nothing(`no file the package ships changed since ${pkg.name}@${version}`);
      if (changed.length === 1 && changed[0] === 'package.json' && (await onlyDevDependenciesChanged(baseCommit))) {
        return nothing(`only devDependencies changed in package.json since ${pkg.name}@${version}, which no consumer installs`);
      }
      const messages = await historySince(baseCommit);
      const refusal = breakingRefusal(messages, version, null);
      if (refusal !== null) return refused(refusal);
      const breaking = messages.some(({ body }) => isBreaking(body));
      const subjects = subjectsOf(messages);
      return publishOrCount(
        breaking ? raiseMinor(version) : raisePatch(version),
        breaking ? 'minor' : 'patch',
        `files the package ships changed since ${pkg.name}@${version}${breaking ? ', with a breaking mark' : ''}`,
        subjects,
      );
    };

    // Every version above the newest one a tag records is repaired, as the newest is below: each plan starts from the
    // newest version, so a version whose tag push failed would stay untagged for good once a later run had published
    // past it and its own tag push had failed too. A tag above the newest one a release records gets its release the
    // same way. The versions at or below those are history and are left as they are.
    const taggedVersions = new Set(tagged.map((tag) => tag.version));
    const highest = (versions) => versions.reduce((top, version) => (top === null || compareVersions(version, top) > 0 ? version : top), null);
    const newestTagged = highest([...taggedVersions]);
    const newestReleased = highest([...taggedVersions].filter((version) => released.has(`${pkg.name}@${version}`)));
    for (const version of [...new Set(held)].filter((candidate) => VERSION.test(candidate)).sort(compareVersions)) {
      if (version === newest || taggedVersions.has(version)) continue;
      if (newestTagged !== null && compareVersions(version, newestTagged) <= 0) continue;
      const found = await commitOf(version);
      if (found === null) {
        throw new Error(`npm holds ${pkg.name}@${version}, but no tag, gitHead or provenance attestation names a commit of this repository for it`);
      }
      repair({ name: pkg.name, version, commit: found.commit, kind: 'tag' });
    }
    for (const tag of tagged) {
      if (tag.version === newest || released.has(`${pkg.name}@${tag.version}`)) continue;
      if (newestReleased !== null && compareVersions(tag.version, newestReleased) <= 0) continue;
      repair({ name: pkg.name, version: tag.version, commit: tag.commit, kind: 'release' });
    }

    let entry;
    if (newest === null) {
      if (named === null) {
        throw new Error(`${manifest}'s version ${pkg.version} is not x.y.z, and npm holds no version of ${pkg.name} to count from`);
      }
      const first = `npm holds no version of ${pkg.name}, so package.json's ${named} is the first`;
      entry =
        (await registry.versionDocument(pkg.name, named)) !== null
          ? await decideFrom(named, 1)
          : entryOf(pkg, { planned: named, bump: 'first', named, reason: first, subjects: [] });
    } else {
      entry = await decideFrom(newest, 0);
    }
    if (onlySet !== null && !onlySet.has(pkg.dir) && entry.planned !== null) {
      entry = { ...entry, planned: null, bump: null, named: null, reason: `outside --only: it would publish ${entry.planned} (${entry.reason})` };
    }
    // A dependent's patch for a range alone that npm holds already (step 7) is decided again from that version, as a
    // shipped change's patch is, one step past the deepest re-anchor so far.
    const reanchor = async (version) => {
      const again = await decideFrom(version, deepest + 1);
      return { entry: again, eligible: !older };
    };
    // A commit older than a package's base is never planned, by the range rule included: a patch from it would
    // publish older code above the newer version.
    return { pkg, entry, document, eligible: !older, reanchor };
  };

  const decided = await mapWithLimit(plannable, PARALLEL_READS, decide);

  // Step 7, the effective ranges and the dependents. Each package's range on a sibling is the text the same field of
  // its newest published manifest holds (what consumers hold), master's text when the entry changed since the
  // package's base commit or the package was never published. A `workspace:` text in master is never rewritten: pnpm
  // converts it at pack time from the sibling's version in the checkout after apply, so `applied` keeps that text.
  const byName = new Map(decided.map((item) => [item.pkg.name, item]));
  const seen = new Set();
  const warn = (line) => {
    if (seen.has(line)) return;
    seen.add(line);
    warnings.push(line);
  };
  const isWorkspace = (text) => text.startsWith('workspace:');

  /**
   * The manifest consumers hold for a package's newest version: the package document's listing, else the version's
   * own document. A version known from its tag alone may have no document on npm yet, in the minutes after its
   * publish: it is read again, as the publish step waits for a version before its dependents, and the plan fails
   * naming it when npm still serves none, since master's text in its place would raise again a range an earlier run
   * raised and plan a patch nothing needs.
   */
  const publishedManifest = async ({ pkg, entry, document }) => {
    const listed = document?.versions?.[entry.newest];
    if (listed) return listed;
    const deadline = Date.now() + documentWait.upTo * 1000;
    for (let fresh = false; ; fresh = true) {
      const held = await registry.versionDocument(pkg.name, entry.newest, { fresh });
      if (held !== null) return held;
      if (Date.now() >= deadline) {
        throw new Error(
          `npm serves no document for ${pkg.name}@${entry.newest}, its newest version, after ${documentWait.upTo} seconds of reading again; ` +
            "its ranges on its siblings are read from what consumers hold, so it is not planned from master's text: re-run once npm " +
            'serves it, or remove a tag made by hand for a version npm never held',
        );
      }
      console.log(`waiting for npm to serve ${pkg.name}@${entry.newest}'s document before its ranges are read`);
      await sleep(documentWait.every);
    }
  };

  /** A package's ranges on its siblings, read for its entry as it stands. */
  const rangesOf = async (item) => {
    const { pkg, entry } = item;
    const manifest = path.posix.join(pkg.dir, 'package.json');
    const ranges = [];
    let published;
    for (const field of SIBLING_FIELDS) {
      for (const [sibling, text] of Object.entries(pkg.fields[field] ?? {})) {
        if (sibling === pkg.name || !byName.has(sibling)) continue;
        const master = String(text);
        let effective = master;
        let source = 'never-published';
        if (entry.newest !== null && entry.baseCommit !== null) {
          if (await git.entryChanged(entry.baseCommit, pkg.dir, sibling)) {
            source = 'master';
          } else {
            published ??= await publishedManifest(item);
            // The entry's own field: a sibling named in two fields keeps each field's text (a caret in
            // dependencies beside a floor in peerDependencies).
            const held = published?.[field]?.[sibling];
            if (typeof held === 'string') {
              effective = held;
              source = 'published';
            } else {
              source = 'master';
            }
          }
        }
        if (rangeForm(effective) === null) {
          warn(`range ${effective} on ${sibling} in ${manifest}'s ${field} is not a form the planner compares (^x.y.z, ~x.y.z, >=x.y.z, x.y.z or workspace:), so it is left as it is`);
        }
        ranges.push({ field, sibling, master, effective, source, applied: isWorkspace(master) ? master : effective, raised: false });
      }
    }
    return ranges;
  };
  for (const item of decided) {
    if (!item.entry.foreign) item.entry.ranges = await rangesOf(item);
    // The reason the decision gave, and the notes the ranges add to it.
    item.baseReason = item.entry.reason;
    item.notes = new Map();
  }

  // The dependents, until nothing changes: a sibling's version (planned, else its newest published one) that its
  // dependent's effective range does not admit raises the range and plans the dependent as a patch, unless it is
  // planned higher already; a dependent outside --only is a warning instead, since its own run plans it. The patch
  // is looked for on npm first (step 6): a version npm holds there (a run published it before its tag, or a hand did)
  // is the one the decision is made again from, and its ranges are read again from what it carries. A newly planned
  // dependent is a sibling of others, so the pass repeats.
  const versionOf = (name) => {
    const item = byName.get(name);
    return item.entry.planned ?? item.entry.newest ?? null;
  };
  /**
   * Whether a range admits a sibling's version as consumers will hold it. A workspace text is the range only when it
   * is master's (an entry changed since the package's base, or a package never published), and it is read as pnpm
   * packs it: `workspace:`, `workspace:*`, `workspace:~` and `workspace:^` follow the sibling and admit its version,
   * while a range written after `workspace:` (`workspace:^1.2.0`) is packed as it is written and is compared so.
   */
  const admitsAsPacked = (range, version) => {
    if (!isWorkspace(range.effective)) return rangeAdmits(range.effective, version);
    const packed = packedRange(range.field, range.effective, version);
    return !packed.written || rangeAdmits(packed.text, version);
  };
  /** One reading of a package's ranges: whether it changed the plan, and whether its decision was made again. */
  const settle = async (item) => {
    const { pkg, entry } = item;
    const manifest = path.posix.join(pkg.dir, 'package.json');
    let changed = false;
    for (const range of entry.ranges) {
      const version = versionOf(range.sibling);
      if (version === null || admitsAsPacked(range, version)) continue;
      if (!item.eligible || (onlySet !== null && !onlySet.has(pkg.dir))) {
        warn(
          `${pkg.name} (${manifest}) names ${range.sibling} at ${range.effective}, which does not admit ${version}; ` +
            (item.eligible ? 'it is outside --only, so its own run plans it' : 'this commit is older than the one it was published from, so it is not planned here'),
        );
        continue;
      }
      const packed = isWorkspace(range.master) ? packedRange(range.field, range.master, version) : null;
      const applied = packed === null ? raiseRange(range.effective, version) : range.master;
      let note = `its range on ${range.sibling} is raised to ${applied}, since ${range.effective} does not admit ${version}`;
      if (packed !== null) {
        const packedAs = `its ${range.master} range on ${range.sibling} is packed as ${packed.text}${packed.written ? ', as it is written,' : ','}`;
        // A workspace text is the effective range only when it is master's (an entry changed since the base, or a
        // package never published), and then only a written one reaches here: what is packed is what does not admit.
        note = isWorkspace(range.effective) ? `${packedAs} which does not admit ${version}` : `${packedAs} and its published range ${range.effective} does not admit ${version}`;
      }
      if (packed?.written) {
        warn(
          `${pkg.name} (${manifest}) names ${range.sibling} at ${range.master} in its ${range.field}, which pnpm packs as it is written ` +
            `(${packed.text}) and which does not admit ${version}: no release raises a written workspace range, so each run plans ` +
            `${pkg.name} again until ${manifest} names ${range.sibling} at workspace:^ or at a range that admits ${version}`,
        );
      }
      if (!range.raised || range.applied !== applied) {
        range.applied = applied;
        range.raised = true;
        changed = true;
      }
      item.notes.set(`${range.field} ${range.sibling}`, note);
      if (entry.planned === null && entry.newest !== null) {
        const patch = raisePatch(entry.newest);
        if ((await registry.versionDocument(pkg.name, patch)) !== null) {
          const again = await item.reanchor(patch);
          item.entry = again.entry;
          item.eligible = again.eligible;
          item.entry.ranges = await rangesOf(item);
          item.baseReason = item.entry.reason;
          item.notes = new Map();
          return { changed: true, reanchored: true };
        }
        entry.planned = patch;
        entry.bump = 'patch';
        changed = true;
      }
    }
    return { changed, reanchored: false };
  };
  for (let pass = 0; ; pass += 1) {
    if (pass > decided.length * 3 + 3) throw new Error('the dependents did not settle: a range is raised on every pass');
    let changed = false;
    for (const item of decided) {
      if (item.entry.foreign) continue;
      // A decision made again is read again at once; maxReanchors bounds how often.
      for (let outcome = { reanchored: true }; outcome.reanchored; ) {
        outcome = await settle(item);
        if (outcome.changed) changed = true;
      }
    }
    if (!changed) break;
  }
  for (const item of decided) {
    if (item.notes.size > 0) item.entry.reason = [item.baseReason, ...item.notes.values()].filter(Boolean).join('; ');
  }
  // A breaking mark refused on a package this run plans for fails the run, every such package named; one outside
  // --only stays unplanned with the refusal as its reason, so another workflow's packages do not hold this one.
  const refusals = decided.filter(({ pkg, entry }) => entry.refusal && (onlySet === null || onlySet.has(pkg.dir)));
  if (refuse && refusals.length > 0) throw new Error(refusals.map(({ entry }) => entry.refusal).join('\n'));

  return {
    ...skeleton,
    run,
    packages: decided.map(({ entry }) => entry),
    root: null,
    order: [],
    repairs: [...repairs.values()].sort((a, b) => a.name.localeCompare(b.name) || compareVersions(a.version, b.version)),
    foreign: foreign.sort((a, b) => a.name.localeCompare(b.name)),
    warnings: warnings.sort(),
  };
}

/** Runs git in the checkout, with the variables that could point it at another repository removed. */
function gitRun(root, args) {
  const env = { ...process.env };
  for (const name of REPOSITORY_VARIABLES) delete env[name];
  const result = spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: root, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  return result;
}

function gitOutput(root, args) {
  const result = gitRun(root, args);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

/** git's answer to a yes-or-no question: exit 0 is yes, exit 1 is no, anything else a failure. */
function gitAnswers(root, args) {
  const result = gitRun(root, args);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
}

/**
 * Every `<name>@x.y.z` tag in the clone with its commit, whatever `head` contains. Each tag is peeled with
 * `git rev-parse <tag>^{commit}`, which dereferences recursively (gitrevisions), so a tag that names another tag
 * still yields a commit; one that names no commit at all fails the plan by its name.
 */
function listTags(root) {
  const names = gitOutput(root, ['for-each-ref', '--format=%(refname:strip=2)', 'refs/tags'])
    .split('\n')
    .filter((tag) => RELEASE_TAG.test(tag));
  if (names.length === 0) return [];
  const peeled = (tag) => `refs/tags/${tag}^{commit}`;
  const result = gitRun(root, ['rev-parse', ...names.map(peeled)]);
  if (result.status !== 0) {
    const bad = names.find((tag) => gitRun(root, ['rev-parse', '--verify', '--quiet', peeled(tag)]).status !== 0);
    throw new Error(`tag ${bad ?? names[0]} does not name a commit: ${result.stderr.trim()}`);
  }
  const commits = result.stdout.trim().split('\n');
  if (commits.length !== names.length || !commits.every((sha) => SHA.test(sha))) {
    throw new Error(`git rev-parse named ${commits.length} commits for ${names.length} tags`);
  }
  return names.map((tag, index) => {
    const match = RELEASE_TAG.exec(tag);
    return { tag, name: match[1], version: match[2], commit: commits[index] };
  });
}

/** The repository as owner/name: $GITHUB_REPOSITORY, else the root package.json's repository address. */
function repositoryOf(root, env) {
  if (/^[^/\s]+\/[^/\s]+$/.test(env.GITHUB_REPOSITORY ?? '')) return env.GITHUB_REPOSITORY;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return repositoryNamed(typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url);
  } catch {
    return null;
  }
}

/**
 * The remote to read master's head from and to push tags to: the repository's address with the job's token when
 * GH_TOKEN or GITHUB_TOKEN and GITHUB_REPOSITORY are set (a private repository needs it; the release job's
 * checkout keeps no credential), else `origin`. The address with the token is never printed.
 */
function remoteOf(env) {
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (token && /^[^/\s]+\/[^/\s]+$/.test(env.GITHUB_REPOSITORY ?? '')) {
    return { remote: `https://x-access-token:${token}@github.com/${env.GITHUB_REPOSITORY}`, shown: `https://github.com/${env.GITHUB_REPOSITORY}`, token };
  }
  return { remote: 'origin', shown: 'origin', token: null };
}

/** What git printed about a remote, with the token masked. */
const masked = (text, token) => (token ? text.split(token).join('***') : text);

/** master's head as the remote names it now. */
function readTip(root, env) {
  const { remote, shown, token } = remoteOf(env);
  const result = gitRun(root, ['ls-remote', remote, 'refs/heads/master']);
  if (result.status !== 0) throw new Error(`git ls-remote ${shown} refs/heads/master failed: ${masked(result.stderr.trim(), token)}`);
  const tip = result.stdout.trim().split(/\s+/)[0];
  if (!SHA.test(tip ?? '')) throw new Error(`git ls-remote ${shown} named no master head (${tip || 'empty'})`);
  return tip;
}

/** Fetches a commit the clone lacks (master moved after the checkout), so the plan can place it. */
function ensureCommit(root, env, sha) {
  if (gitRun(root, ['cat-file', '-e', `${sha}^{commit}`]).status === 0) return;
  const { remote, shown, token } = remoteOf(env);
  const result = gitRun(root, ['fetch', '--quiet', remote, 'refs/heads/master']);
  if (result.status !== 0) throw new Error(`git fetch ${shown} refs/heads/master failed: ${masked(result.stderr.trim(), token)}`);
}

/**
 * The repository's release tag names: one paginated list read at 100 a page (the most GitHub serves), through
 * every page, with the drafts left out, since a draft release is not a release.
 */
function readReleases(repository, env) {
  if (!repository) throw new Error('the release list needs GITHUB_REPOSITORY (or a repository address in the root package.json)');
  const result = spawnSync('gh', ['api', '--paginate', `repos/${repository}/releases?per_page=100`, '--jq', '.[] | select(.draft | not) | .tag_name'], {
    encoding: 'utf8',
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`gh api repos/${repository}/releases failed: ${result.stderr.trim()}`);
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

/** A version document's _npmUser read on its own, for a document whose README refuses strict parsing; undefined when it names none. */
function npmUserIn(text) {
  const found = /"_npmUser"\s*:\s*(\{(?:[^{}]|\{[^{}]*\})*\})/.exec(text)?.[1];
  if (found === undefined) return undefined;
  try {
    return JSON.parse(found);
  } catch {
    return undefined;
  }
}

/**
 * The registry as the plan reads it: the abbreviated package document, a version's document (its gitHead and
 * repository address read on their own, since a version document's README can refuse strict parsing), and the
 * provenance attestations. A 404 is null; any other answer fails the run, so an outage never reads as unpublished.
 */
function registryReader({ fetch, registry }) {
  const base = registry.replace(/\/+$/, '');
  const escaped = (name) => name.replace('/', '%2f');
  const read = async (url, headers = {}) => {
    const response = await fetch(url, { headers });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return response.text();
  };
  const versions = new Map();
  return {
    document: async (name) => {
      const text = await read(`${base}/${escaped(name)}`, { accept: ABBREVIATED });
      return text === null ? null : JSON.parse(text);
    },
    versionDocument: async (name, version, { fresh = false } = {}) => {
      const key = `${name}@${version}`;
      if (fresh || !versions.has(key)) {
        const text = await read(`${base}/${escaped(name)}/${version}`);
        if (text === null) {
          versions.set(key, null);
        } else {
          let parsed = {};
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = {};
          }
          const gitHead = /"gitHead"\s*:\s*"([0-9a-f]{40})"/.exec(text)?.[1] ?? null;
          const url =
            /"repository"\s*:\s*\{[^{}]*?"url"\s*:\s*"([^"]+)"/.exec(text)?.[1] ??
            (typeof parsed.repository === 'string' ? parsed.repository : parsed.repository?.url) ??
            null;
          // The tarball's address and integrity, read on their own too when the whole does not parse.
          const tarball = typeof parsed.dist?.tarball === 'string' ? parsed.dist.tarball : (/"tarball"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? null);
          const integrity = typeof parsed.dist?.integrity === 'string' ? parsed.dist.integrity : (/"integrity"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? null);
          const dist = tarball === null ? parsed.dist : { ...(parsed.dist ?? {}), tarball, ...(integrity === null ? {} : { integrity }) };
          const npmUser = parsed._npmUser ?? npmUserIn(text);
          versions.set(key, {
            ...parsed,
            version,
            gitHead,
            repository: { ...(typeof parsed.repository === 'object' ? parsed.repository : {}), url },
            ...(dist === undefined ? {} : { dist }),
            ...(npmUser === undefined ? {} : { _npmUser: npmUser }),
          });
        }
      }
      return versions.get(key);
    },
    attestation: async (name, version) => {
      const text = await read(`${base}/-/npm/v1/attestations/${name.replace('/', '%2F')}@${version}`);
      return text === null ? null : JSON.parse(text);
    },
  };
}

/**
 * The git answers planRelease asks of the checkout at `root`, whose head is `head`. The diff and the log run with
 * --no-renames: git detects renames by default, and a rename's name-only line names its new path alone, so a shipped
 * file moved into an excluded path (src/a.ts to src/__tests__/a.ts) would read as no shipped change at all.
 */
function gitReader(root, head) {
  // `dir` is a package directory, or a list of paths at the root (the root package's own files).
  const pathspec = (dir) => (Array.isArray(dir) ? dir : [dir]);
  const relative = (dir, file) => (dir === '.' || Array.isArray(dir) ? file : path.posix.relative(dir, file));
  // The package.json of a package directory; the root's own files keep theirs at the top.
  const manifestOf = (dir) => (dir === '.' || Array.isArray(dir) ? 'package.json' : path.posix.join(dir, 'package.json'));
  const fileAt = async (commit, file) => {
    const result = gitRun(root, ['show', `${commit}:${file}`]);
    return result.status === 0 ? result.stdout : null;
  };
  return {
    isAncestor: async (ancestor, commit) => gitAnswers(root, ['merge-base', '--is-ancestor', ancestor, commit]),
    holdsCommit: async (sha) => gitRun(root, ['cat-file', '-e', `${sha}^{commit}`]).status === 0,
    /**
     * The best common ancestor of two commits: a dry run reads a package from it when master released the package
     * after this commit's base, and reads a pull request's own change from head's with master's tip.
     */
    mergeBase: async (a, b) => {
      const result = gitRun(root, ['merge-base', a, b]);
      const base = result.stdout.trim();
      if (result.status !== 0 || !SHA.test(base)) {
        throw new Error(`git merge-base ${a.slice(0, 8)} ${b.slice(0, 8)} found no common commit${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`);
      }
      return base;
    },
    changedSince: async (commit, dir, patterns = SHIPPED_EXCLUDES) =>
      gitOutput(root, ['diff', '--name-only', '--no-renames', commit, head, '--', ...pathspec(dir)])
        .split('\n')
        .filter(Boolean)
        .map((file) => relative(dir, file))
        .filter((file) => isShippedPath(file, patterns)),
    messagesSince: async (commit, dir, patterns = SHIPPED_EXCLUDES) => {
      const records = gitOutput(root, ['log', '--no-renames', '--format=%x1e%H%x1f%s%x1f%B%x1f', '--name-only', `${commit}..${head}`, '--', ...pathspec(dir)]).split('\x1e');
      const messages = [];
      for (const record of records) {
        const [sha, subject, body, files = ''] = record.split('\x1f');
        if (!SHA.test(sha ?? '')) continue;
        const shipped = files
          .split('\n')
          .filter(Boolean)
          .map((file) => relative(dir, file))
          .filter((file) => isShippedPath(file, patterns));
        if (shipped.length === 0) continue;
        // A commit whose only shipped change is to package.json's devDependencies shipped nothing (a change confined
        // to them publishes nothing), so its subject is no note of the package's release and its breaking mark no
        // bump of it: the next fix after a `build!:` commit that only moved a dev tool stays a patch.
        if (shipped.length === 1 && shipped[0] === 'package.json' && (await onlyDevDependenciesDiffer({ fileAt }, `${sha}^`, sha, manifestOf(dir)))) continue;
        messages.push({ sha, subject, body });
      }
      // git lists the newest commit first; the subjects read oldest first, as a release note does.
      return messages.reverse();
    },
    fileAt,
    entryChanged: async (commit, dir, siblingName) => {
      const file = path.posix.join(dir, 'package.json');
      const entryAt = (at) => {
        const result = gitRun(root, ['show', `${at}:${file}`]);
        if (result.status !== 0) return null;
        try {
          const pkg = JSON.parse(result.stdout);
          return SIBLING_FIELDS.map((field) => pkg?.[field]?.[siblingName] ?? null);
        } catch {
          return null;
        }
      };
      return canonical(entryAt(commit)) !== canonical(entryAt(head));
    },
  };
}

/**
 * The plan for the checkout at `root`, read from the registry through `fetch`: `tip` defaults to master's head
 * as the remote names it, `releases` to the repository's release list through gh; the tests inject both.
 * `messageFile`, in a dry run alone, holds the message the squash merge will carry. `documentWait` ({ every, upTo },
 * in seconds; DOCUMENT_WAIT's 10 and 1800 by default) is how often and for how long a newest version's document npm does not serve
 * yet is read again.
 */
export async function planFromRepository({
  root = REPO_ROOT,
  fetch = globalThis.fetch,
  registry = REGISTRY,
  tip,
  releases,
  dryRun = false,
  only = null,
  messageFile = null,
  env = process.env,
  documentWait = DOCUMENT_WAIT,
} = {}) {
  if (messageFile !== null && !dryRun) {
    throw new Error('--message-file is read in a dry run alone: on master the merged commit carries its own message');
  }
  const message = messageFile === null ? null : fs.readFileSync(messageFile, 'utf8');
  const head = gitOutput(root, ['rev-parse', 'HEAD']).trim();
  const repository = repositoryOf(root, env);
  let resolvedTip = tip ?? null;
  if (tip === undefined) {
    if (dryRun) {
      try {
        resolvedTip = readTip(root, env);
      } catch {
        resolvedTip = null;
      }
    } else {
      resolvedTip = readTip(root, env);
    }
  }
  if (resolvedTip !== null && resolvedTip !== head) {
    if (!dryRun) {
      ensureCommit(root, env, resolvedTip);
    } else if (message !== null) {
      // The squash message's reading tells the pull request's commits from master's by the tip; a tip the clone
      // cannot fetch leaves that apart, and the message is then added on top of every commit since the base.
      try {
        ensureCommit(root, env, resolvedTip);
      } catch {
        resolvedTip = null;
      }
    }
  }
  return planRelease({
    repository,
    head,
    tip: resolvedTip,
    dryRun,
    only,
    message,
    packages: listPackages(root),
    tags: listTags(root),
    releases: releases ?? readReleases(repository, env),
    registry: registryReader({ fetch, registry }),
    git: gitReader(root, head),
    documentWait,
  });
}

/** Whether package.json's only difference between `commit` and `head` lies in devDependencies, which no consumer installs. */
async function onlyDevDependenciesDiffer(git, commit, head, manifest) {
  try {
    const before = JSON.parse((await git.fileAt(commit, manifest)) ?? 'null');
    const after = JSON.parse((await git.fileAt(head, manifest)) ?? 'null');
    if (!before || !after) return false;
    delete before.devDependencies;
    delete after.devDependencies;
    return canonical(before) === canonical(after);
  } catch {
    return false;
  }
}

/** The file name `pnpm pack` and `npm pack` write for a package: the scope's `@` dropped, `/` to `-`, `-<version>.tgz`. */
export function tarballFileName(name, version) {
  return `${name.replace(/^@/, '').replace(/\//g, '-')}-${version}.tgz`;
}

/** The lines of a file, trimmed, the empty ones left out. */
const readLines = (file) =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

/**
 * Rewrites a JSON file through `mutate`, keeping its indentation (what the file uses, two spaces when it has none)
 * and its trailing newline; `shown` names the file in a failure.
 */
function editJson(file, shown, mutate) {
  const text = fs.readFileSync(file, 'utf8');
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${shown} is not valid JSON: ${error.message}`);
  }
  const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? '  ';
  const newline = text.endsWith('\n') ? '\n' : '';
  mutate(value);
  fs.writeFileSync(file, `${JSON.stringify(value, null, indent)}${newline}`);
}

/**
 * Whether two catalog texts are one catalog: the same bytes, or the same JSON (a copy that differs in its formatting
 * alone, a trailing newline on one, is not a change worth a publish).
 */
function sameCatalog(a, b) {
  if (a === b) return true;
  try {
    return canonical(JSON.parse(a)) === canonical(JSON.parse(b));
  } catch {
    return false;
  }
}

/** The version each package a catalog text lists carries, by name, from every list under `extensions`; none for a text that is not a catalog. */
function catalogVersions(text) {
  let catalog = null;
  try {
    catalog = text === null ? null : JSON.parse(text);
  } catch {
    catalog = null;
  }
  const versions = new Map();
  const lists = catalog?.extensions && typeof catalog.extensions === 'object' ? Object.values(catalog.extensions) : [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry?.package !== 'string' || versions.has(entry.package)) continue;
      versions.set(entry.package, typeof entry.version === 'string' ? entry.version : null);
    }
  }
  return versions;
}

/**
 * The catalog entries whose versions moved from the published copy to the regenerated catalog, by package name:
 * `{ package, from, to }`, `from` null for a package the published copy did not list and `to` null for one the
 * regenerated catalog no longer lists. The root's release notes list them (section 7).
 */
function catalogMoves(published, regenerated) {
  const before = catalogVersions(published);
  const after = catalogVersions(regenerated);
  return [...new Set([...before.keys(), ...after.keys()])]
    .sort()
    .map((name) => ({ package: name, from: before.get(name) ?? null, to: after.get(name) ?? null }))
    .filter((move) => move.from !== move.to);
}

/**
 * The publish order: the planned packages in workspace dependency order (a sibling named in dependencies,
 * peerDependencies or optionalDependencies before its dependents, ties by directory), the root last. A cycle among
 * the planned packages is broken at its first directory, with a warning, since the publish loop waits for a
 * dependency's document before its dependent.
 */
function publishOrder(plan, warnings) {
  const planned = plan.packages.filter((entry) => entry.planned !== null && !entry.foreign);
  const names = new Set(planned.map((entry) => entry.name));
  const waitsFor = new Map(
    planned.map((entry) => [entry.name, new Set(entry.ranges.map((range) => range.sibling).filter((sibling) => names.has(sibling) && sibling !== entry.name))]),
  );
  const byDir = (a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0);
  const order = [];
  const done = new Set();
  while (done.size < planned.length) {
    const left = planned.filter((entry) => !done.has(entry.name)).sort(byDir);
    const ready = left.find((entry) => [...waitsFor.get(entry.name)].every((sibling) => done.has(sibling)));
    const next = ready ?? left[0];
    if (ready === undefined) warnings.push(`${next.name} and the packages it names depend on each other in a cycle; it is published first among them`);
    order.push(next.dir);
    done.add(next.name);
  }
  if (plan.root && plan.root.planned !== null) order.push(plan.root.dir);
  return order;
}

/** Raises a planned package's manifest.json to its planned version, as scripts/sync-manifest-versions.mjs did. */
function syncManifest(root, entry, warnings) {
  const shown = `${entry.dir}/manifest.json`;
  const file = path.join(root, entry.dir, 'manifest.json');
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new Error(`${shown} is not valid JSON: ${error.message}`);
  }
  if (typeof manifest?.version !== 'string') return;
  if (!VERSION.test(manifest.version)) {
    const line = `${shown} says ${manifest.version}, which is not an x.y.z version; it is left as it is`;
    warnings.push(line);
    console.log(`::warning file=${shown}::${line}`);
    return;
  }
  const order = compareVersions(manifest.version, entry.planned);
  if (order === 0) return;
  if (order > 0) {
    const line = `${shown} says ${manifest.version}, above the planned ${entry.planned}; it is left as it is, and the package owes a release at that version`;
    warnings.push(line);
    console.log(`::warning file=${shown}::${line}`);
    return;
  }
  // The value is replaced in place so the file keeps its formatting; when the first "version" in the text is not the
  // top-level one, the document is rewritten.
  let updated = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${entry.planned}$2`);
  let check;
  try {
    check = JSON.parse(updated).version;
  } catch {
    check = undefined;
  }
  if (check !== entry.planned) updated = `${JSON.stringify({ ...manifest, version: entry.planned }, null, 2)}\n`;
  fs.writeFileSync(file, updated);
}

/**
 * The files npm packs at a package's top level whatever its `files` list says, as git pathspecs: the README, the
 * LICENSE or LICENCE and COPYING, in any case and with or without an extension (npm-packlist's rules
 * `/readme{,.*[^~$]}`, `/copying{,.*[^~$]}`, `/license{,.*[^~$]}` and `/licence{,.*[^~$]}`, matched with nocase;
 * npm's `files` field: "README & LICENSE can have any case and extension"). `glob` keeps each pattern to the top
 * level (a wildcard does not match a /), `icase` matches any case.
 */
const ALWAYS_PACKED = ['readme', 'copying', 'license', 'licence'].flatMap((name) => [`:(glob,icase)${name}`, `:(glob,icase)${name}.*`]);

/**
 * The root package's own shipped files, as git pathspecs: its `files` list less registry.json (the catalog is
 * compared on its own), the files npm packs whatever the list says (ALWAYS_PACKED), and package.json; the four the
 * design names when the list is missing.
 */
function rootOwnFiles(root) {
  let files = null;
  try {
    const listed = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).files;
    if (Array.isArray(listed) && listed.every((file) => typeof file === 'string')) files = listed;
  } catch {
    files = null;
  }
  const own = (files ?? ['index.mjs', 'types.d.ts', 'README.md'])
    .map((file) => file.replace(/^\.\//, '').replace(/\/+$/, ''))
    .filter((file) => file !== '' && file !== 'registry.json');
  return [...new Set([...own, ...ALWAYS_PACKED, 'package.json'])];
}

/**
 * Step 9, the root: decided by the rules a pack is decided by (its tags `<name>@x.y.z`, the versions npm holds, a
 * named version, the breaking marks of its own commits), with the catalog comparison apply made standing beside its
 * own files as the change. It is planned when the regenerated catalog differs from the published copy
 * (`catalogChanged`), or its own shipped files changed since its base (`ownFilesChanged(baseCommit)`, the files),
 * or package.json names a version above its newest; a catalog change alone is a patch, and a breaking mark in its own
 * commits (`messagesSince(baseCommit)`) a minor below 1.0.0 and a refusal at 1.0.0 or above. Resolves to the plan with `root` and `order` filled, the root's
 * repair records and warnings beside the packs'. With no root package (the other repository's shape), `root` is null.
 * @param {object} plan the plan of planRelease
 * @param {{ rootPackage: object | null, catalogChanged: boolean, ownFilesChanged: (baseCommit: string) => Promise<string[]>,
 *   messagesSince: (baseCommit: string) => Promise<{ sha: string, subject: string, body: string }[]>, registry: object,
 *   tags: object[], releases: string[], git: object, maxReanchors?: number }} input
 */
export async function planRoot(plan, { rootPackage, catalogChanged, ownFilesChanged, messagesSince, registry, tags, releases, git, maxReanchors }) {
  const warnings = [...plan.warnings];
  if (!rootPackage) {
    const bare = { ...plan, root: null, warnings };
    bare.order = publishOrder(bare, warnings);
    warnings.sort();
    return bare;
  }
  const rootGit = {
    ...git,
    changedSince: async (commit) => ownFilesChanged(commit),
    messagesSince: async (commit) => messagesSince(commit),
  };
  // The root is decided alone, so --only is read for it here: planRelease refuses a directory its package list does
  // not hold, and the root's own directory is the one it can be asked for.
  const inOnly = plan.only === null || plan.only.includes(rootPackage.dir);
  const decided = await planRelease({
    repository: plan.repository,
    head: plan.head,
    tip: plan.tip,
    dryRun: plan.dryRun,
    only: plan.only === null ? null : [rootPackage.dir],
    message: plan.message ?? null,
    packages: [{ ...rootPackage, role: 'pack', alsoChanged: catalogChanged ? ['registry.json'] : [] }],
    tags,
    releases,
    registry,
    git: rootGit,
    maxReanchors,
    refuse: inOnly,
  });
  let entry = { ...decided.packages[0], role: 'root', catalogChanged, ownFilesChanged: false };
  if (entry.baseCommit !== null) {
    const own = await ownFilesChanged(entry.baseCommit);
    entry.ownFilesChanged =
      own.length > 0 && !(own.length === 1 && own[0] === 'package.json' && (await onlyDevDependenciesDiffer(git, entry.baseCommit, plan.head, 'package.json')));
  }
  if (entry.planned !== null && (entry.bump === 'patch' || entry.bump === 'minor')) {
    const published = `${entry.name}@${entry.newest}`;
    const what = [catalogChanged ? `the catalog differs from the copy in ${published}` : null, entry.ownFilesChanged ? `the root's own files changed since ${published}` : null].filter(Boolean);
    if (what.length > 0) entry.reason = `${what.join(', and ')}${entry.bump === 'minor' ? ', with a breaking mark' : ''}`;
  }
  if (!inOnly && entry.planned !== null) {
    entry = { ...entry, planned: null, bump: null, named: null, reason: `outside --only: it would publish ${entry.planned} (${entry.reason})` };
  }
  const known = new Set(plan.repairs.map((record) => `${record.name}@${record.version}`));
  const repairs = [...plan.repairs, ...decided.repairs.filter((record) => !known.has(`${record.name}@${record.version}`))].sort(
    (a, b) => a.name.localeCompare(b.name) || compareVersions(a.version, b.version),
  );
  for (const line of decided.warnings) if (!warnings.includes(line)) warnings.push(line);
  const result = { ...plan, root: entry, repairs, warnings };
  result.order = publishOrder(result, warnings);
  warnings.sort();
  return result;
}

/**
 * U1 apply: writes the plan into the checkout at `root`, whose HEAD must be the plan's head, and decides the root.
 * In order: every listed package's version (its planned version, else its newest published one, else npm's for a
 * foreign name, else left as it is); each range's applied text (a `workspace:` text byte for byte); each planned
 * package's manifest.json version (raised in place when behind; one ahead is left with a warning; one that does not
 * parse fails naming the file) and `gitHead`; then, with a root role, the published catalog placed at registry.json,
 * the catalog regenerated by scripts/update-registry.js --root (the placed copy's timestamps kept where nothing
 * changed), compared with that copy, the entries whose versions moved recorded on the root's entry (`moved`, each
 * `{ package, from, to }`), and the root decided (planRoot) and its version written. CHANGELOG.md is never
 * touched. Resolves to the plan with `root`, `order` and every `checkoutVersion` filled. `fetch`, `registry` and
 * `releases` are the test seams of the root's decision; `releases` defaults to the repository's release list through gh.
 */
export async function applyPlan({ root = REPO_ROOT, plan, publishedRegistry = null, fetch = globalThis.fetch, registry = REGISTRY, releases, env = process.env, maxReanchors } = {}) {
  const head = gitOutput(root, ['rev-parse', 'HEAD']).trim();
  if (head !== plan.head) {
    throw new Error(`the plan was made for ${plan.head.slice(0, 8)} and the checkout is at ${head.slice(0, 8)}: plan this commit first`);
  }
  const warnings = [...plan.warnings];
  const applied = { ...plan, packages: plan.packages.map((entry) => ({ ...entry, ranges: entry.ranges.map((range) => ({ ...range })) })), warnings };

  for (const entry of applied.packages) {
    const shown = `${entry.dir}/package.json`;
    const file = path.join(root, entry.dir, 'package.json');
    if (!fs.existsSync(file)) throw new Error(`${shown} does not exist in the checkout`);
    let version = entry.planned ?? entry.newest ?? entry.checkoutVersion ?? null;
    editJson(file, shown, (pkg) => {
      if (version === null) version = typeof pkg.version === 'string' ? pkg.version : null;
      else pkg.version = version;
      for (const range of entry.ranges) {
        if (range.master.startsWith('workspace:') || range.applied === range.master) continue;
        const field = pkg[range.field];
        if (field && typeof field === 'object' && range.sibling in field) field[range.sibling] = range.applied;
      }
      if (entry.planned !== null) pkg.gitHead = plan.head;
    });
    entry.checkoutVersion = version;
    if (entry.planned !== null) syncManifest(root, entry, warnings);
  }

  const rootPackage = listPackages(root).find((pkg) => pkg.role === 'root') ?? null;
  if (rootPackage === null) {
    const bare = { ...applied, root: null };
    bare.order = publishOrder(bare, warnings);
    warnings.sort();
    return bare;
  }

  // The catalog: the published copy placed first, so the generator keeps its timestamps where nothing changed, then
  // regenerated from the versions written above and compared with the copy.
  const catalogFile = path.join(root, 'registry.json');
  if (publishedRegistry !== null) fs.writeFileSync(catalogFile, publishedRegistry);
  const generator = path.join(SCRIPT_DIR, 'update-registry.js');
  if (!fs.existsSync(generator)) throw new Error(`${generator} does not exist, so the catalog cannot be regenerated for the root's decision`);
  const generated = spawnSync(process.execPath, [generator, '--root', root], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (generated.error) throw new Error(`update-registry.js could not start: ${generated.error.message}`);
  if (generated.status !== 0) throw new Error(`update-registry.js --root ${root} failed: ${said(generated)}`);
  if (!fs.existsSync(catalogFile)) throw new Error(`update-registry.js --root ${root} wrote no registry.json`);
  const regenerated = fs.readFileSync(catalogFile, 'utf8');
  const catalogChanged = publishedRegistry === null || !sameCatalog(regenerated, publishedRegistry);
  // The entries whose versions moved, which the root's release notes list: the packs this run plans, and those an
  // earlier run published whose catalog the root has not shipped yet (a root publish that failed after them).
  const moved = catalogMoves(publishedRegistry, regenerated);

  const git = gitReader(root, plan.head);
  const own = rootOwnFiles(root);
  const result = await planRoot(applied, {
    rootPackage,
    catalogChanged,
    ownFilesChanged: (commit) => git.changedSince(commit, own, SHIPPED_EXCLUDES),
    messagesSince: (commit) => git.messagesSince(commit, own, SHIPPED_EXCLUDES),
    registry: registryReader({ fetch, registry }),
    tags: listTags(root),
    releases: releases ?? readReleases(plan.repository ?? repositoryOf(root, env), env),
    git,
    maxReanchors,
  });
  const entry = result.root;
  entry.moved = moved;
  const version = entry.planned ?? entry.newest ?? null;
  editJson(path.join(root, 'package.json'), 'package.json', (pkg) => {
    if (version !== null) pkg.version = version;
    if (entry.planned !== null) pkg.gitHead = plan.head;
  });
  entry.checkoutVersion = version ?? rootPackage.version;
  return result;
}

/**
 * The root's newest published catalog, for apply's comparison (section 7): the tarball of the root's newest version
 * is downloaded into `out`, its bytes checked against npm's integrity, and its package/registry.json extracted to
 * `<out>/published-registry.json`. The newest version is counted as the root's decision counts it: every version
 * npm's package document lists and every version a tag in the clone names (`tagged`). npm's CDN keeps the package
 * document for up to five minutes (cache-control max-age=300), while the tags of the versions the last run
 * published are in the next run's clone at once, so a version the document does not list yet is read from its own
 * version document; without the tags the next push's catalog would be compared with the version before, and the
 * root planned again for a change the newest version already carries. A tag of a version npm serves no document
 * for (a tag made by hand) leaves the newest version the package document lists, with a line saying so. Resolves
 * to `{ version, file, tarball }`, or to null when npm holds no version (the catalog then counts as changed).
 */
export async function downloadPublishedRegistry({ fetch = globalThis.fetch, registry = REGISTRY, name, out, tagged = [] }) {
  const reader = registryReader({ fetch, registry });
  const document = await reader.document(name);
  const listed = Object.keys(document?.versions ?? {}).filter((version) => VERSION.test(version));
  const highest = (versions) => versions.reduce((top, version) => (top === null || compareVersions(version, top) > 0 ? version : top), null);
  let newest = highest([...listed, ...tagged.filter((version) => VERSION.test(version))]);
  if (newest === null) return null;
  let dist = document?.versions?.[newest]?.dist ?? (await reader.versionDocument(name, newest))?.dist;
  if (typeof dist?.tarball !== 'string' && !listed.includes(newest)) {
    const listedNewest = highest(listed);
    console.log(
      `npm serves no document for ${name}@${newest}, which its tag names; ` +
        (listedNewest === null ? 'npm lists no other version, so the catalog counts as changed' : `the catalog is compared with ${name}@${listedNewest}'s`),
    );
    if (listedNewest === null) return null;
    newest = listedNewest;
    dist = document.versions[newest]?.dist ?? (await reader.versionDocument(name, newest))?.dist;
  }
  if (typeof dist?.tarball !== 'string') throw new Error(`npm names no tarball for ${name}@${newest}`);
  const response = await fetch(dist.tarball);
  if (!response.ok) throw new Error(`${dist.tarball} answered ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (typeof dist.integrity === 'string' && dist.integrity.startsWith('sha512-')) {
    const digest = `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`;
    if (digest !== dist.integrity) throw new Error(`the tarball of ${name}@${newest} reads ${digest}, not npm's ${dist.integrity}`);
  }
  fs.mkdirSync(out, { recursive: true });
  const tarball = path.join(out, `published-${tarballFileName(name, newest)}`);
  fs.writeFileSync(tarball, bytes);
  const extracted = spawnSync('tar', ['-xOzf', tarball, 'package/registry.json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (extracted.error) throw new Error(`tar could not start: ${extracted.error.message}`);
  if (extracted.status !== 0) throw new Error(`tar -xOzf ${tarball} package/registry.json failed: ${said(extracted)}`);
  const file = path.join(out, 'published-registry.json');
  fs.writeFileSync(file, extracted.stdout);
  return { version: newest, file, tarball };
}

/** Where the plan goes: $RUNNER_TEMP/release-plan on a runner, the temporary directory elsewhere. */
const defaultOut = () => path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'release-plan');

/** Where the tarballs go: $RUNNER_TEMP/release-tarballs on a runner, the temporary directory elsewhere. */
const defaultTarballs = () => path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'release-tarballs');

/**
 * Prints the decision and writes the summary table: package, from, to, bump, reason, base commit; the root among
 * the rows once apply has decided it, with the publish order.
 */
function report(plan, file, { applied = false } = {}) {
  const lines = [];
  const entries = [...plan.packages, ...(plan.root ? [plan.root] : [])];
  const planned = entries.filter((entry) => entry.planned !== null);
  lines.push(plan.run.publishes ? `Publishing from ${plan.head.slice(0, 8)}: ${plan.run.reason}.` : `Publishing nothing: ${plan.run.reason}.`);
  for (const entry of planned) lines.push(`${entry.name} ${entry.newest ?? 'nothing'} -> ${entry.planned} (${entry.bump}): ${entry.reason}`);
  lines.push(`${planned.length} of ${entries.length} packages planned; ${plan.repairs.length} repair(s); the plan is at ${file}.`);
  const order = plan.order.length === 0 ? '(nothing)' : plan.order.join(', ');
  if (applied) lines.push(`publish order: ${order}`);
  const raised = plan.packages.flatMap((entry) => entry.ranges.filter((range) => range.raised).map((range) => ({ entry, range })));
  for (const { entry, range } of raised) lines.push(`range: ${entry.name} ${range.field} ${range.sibling} ${range.effective} -> ${range.applied}`);
  for (const record of plan.repairs) lines.push(`repair: ${record.name}@${record.version} needs its ${record.kind} at ${record.commit.slice(0, 8)}`);
  for (const record of plan.foreign) lines.push(`foreign: ${record.name} is published from ${record.repository}; its copy here is not planned`);
  for (const warning of plan.warnings) lines.push(`::warning::${warning}`);
  console.log(lines.join('\n'));

  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const rows = [
    `### Release plan for ${plan.head.slice(0, 8)}${plan.dryRun ? ' (dry run)' : ''}${applied ? ', applied to the checkout' : ''}`,
    '',
    lines[0],
    '',
    '| package | from | to | bump | reason | base commit |',
    '| --- | --- | --- | --- | --- | --- |',
    ...planned.map((entry) => `| ${entry.name} | ${entry.newest ?? ''} | ${entry.planned} | ${entry.bump} | ${entry.reason} | ${entry.baseCommit ? entry.baseCommit.slice(0, 8) : ''} |`),
    ...(planned.length === 0 ? ['| (nothing) | | | | | |'] : []),
    '',
    ...(applied ? [`- publish order: ${order}`] : []),
    ...raised.map(({ entry, range }) => `- range: \`${entry.name}\` ${range.field} on \`${range.sibling}\`: ${range.effective} -> ${range.applied}`),
    ...plan.repairs.map((record) => `- repair: \`${record.name}@${record.version}\` needs its ${record.kind} at ${record.commit.slice(0, 8)}`),
    ...plan.foreign.map((record) => `- foreign: \`${record.name}\` is published from ${record.repository}; its copy here is not planned`),
    ...plan.warnings.map((warning) => `- warning: ${warning}`),
    '',
  ];
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${rows.join('\n')}\n`);
}

const PLAN_OPTIONS = {
  'dry-run': { type: 'boolean', default: false },
  'message-file': { type: 'string' },
  only: { type: 'string' },
  root: { type: 'string' },
  registry: { type: 'string' },
  tip: { type: 'string' },
  releases: { type: 'string' },
  out: { type: 'string' },
};

async function planCommand(args) {
  const { values } = parseArgs({ args, options: PLAN_OPTIONS, strict: true });
  const root = path.resolve(values.root ?? REPO_ROOT);
  const registry = values.registry ?? REGISTRY;
  const only = values.only === undefined ? null : values.only.split(',').map((dir) => dir.trim()).filter(Boolean);
  if (values.tip !== undefined && !SHA.test(values.tip)) throw new Error(`--tip ${values.tip} is not a commit sha`);
  // The release list is read once, here, and left beside the plan for apply, which decides the root from it.
  const releases = values.releases === undefined ? readReleases(repositoryOf(root, process.env), process.env) : readLines(values.releases);
  const plan = await planFromRepository({
    root,
    registry,
    tip: values.tip,
    releases,
    dryRun: values['dry-run'],
    only,
    messageFile: values['message-file'] === undefined ? null : path.resolve(values['message-file']),
  });
  const out = path.resolve(values.out ?? defaultOut());
  // The root's published catalog, which apply compares with the regenerated one (step 9); read before the plan is
  // written, so a registry failure leaves nothing behind.
  const rootPackage = listPackages(root).find((pkg) => pkg.role === 'root');
  const tagged = rootPackage === undefined ? [] : listTags(root).filter((tag) => tag.name === rootPackage.name).map((tag) => tag.version);
  const published = rootPackage === undefined ? null : await downloadPublishedRegistry({ registry, name: rootPackage.name, out, tagged });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'releases.txt'), `${releases.join('\n')}\n`);
  const file = path.join(out, 'release-plan.json');
  fs.writeFileSync(file, `${JSON.stringify(plan, null, 2)}\n`);
  if (rootPackage !== undefined) {
    console.log(published === null ? `npm holds no version of ${rootPackage.name}: its catalog counts as changed` : `the catalog of ${rootPackage.name}@${published.version} is at ${published.file}`);
  }
  report(plan, file);
}

const APPLY_OPTIONS = {
  root: { type: 'string' },
  out: { type: 'string' },
  tarballs: { type: 'string' },
  registry: { type: 'string' },
  releases: { type: 'string' },
};

async function applyCommand(args) {
  const { values } = parseArgs({ args, options: APPLY_OPTIONS, strict: true });
  const root = path.resolve(values.root ?? REPO_ROOT);
  const out = path.resolve(values.out ?? defaultOut());
  const file = path.join(out, 'release-plan.json');
  if (!fs.existsSync(file)) throw new Error(`${file} does not exist: run plan first`);
  const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
  const publishedFile = path.join(out, 'published-registry.json');
  const releasesFile = values.releases ?? (fs.existsSync(path.join(out, 'releases.txt')) ? path.join(out, 'releases.txt') : undefined);
  const applied = await applyPlan({
    root,
    plan,
    publishedRegistry: fs.existsSync(publishedFile) ? fs.readFileSync(publishedFile, 'utf8') : null,
    registry: values.registry ?? REGISTRY,
    releases: releasesFile === undefined ? undefined : readLines(releasesFile),
  });
  fs.writeFileSync(file, `${JSON.stringify(applied, null, 2)}\n`);

  // The tarballs the pack guard packs and the release job publishes: expected.json names each, in the publish order,
  // and exists on every run, so the artifact always does.
  const tarballs = path.resolve(values.tarballs ?? defaultTarballs());
  fs.mkdirSync(tarballs, { recursive: true });
  const entryAt = (dir) => (applied.root !== null && dir === applied.root.dir ? applied.root : applied.packages.find((entry) => entry.dir === dir));
  const expected = {
    head: applied.head,
    tarballs: applied.order.map((dir) => {
      const entry = entryAt(dir);
      return { name: entry.name, version: entry.planned, file: tarballFileName(entry.name, entry.planned) };
    }),
  };
  fs.writeFileSync(path.join(tarballs, 'expected.json'), `${JSON.stringify(expected, null, 2)}\n`);

  const publish = applied.order.length > 0 && applied.run.publishes;
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      [`publish=${publish}`, `planned_dirs=${applied.order.join(',')}`, `planned_count=${applied.order.length}`, `repairs=${applied.repairs.length}`, `plan=${file}`, ''].join('\n'),
    );
  }
  console.log(`expected tarballs: ${expected.tarballs.length === 0 ? '(none)' : expected.tarballs.map((entry) => entry.file).join(', ')} in ${tarballs}`);
  report(applied, file, { applied: true });
}

/** The tagger of the release tags when nothing names a committer: the identity every release tag here has carried. */
const RELEASE_TAGGER = { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' };

/** The waits, in seconds, between the three attempts of the tag push. */
const TAG_PUSH_WAITS = [20, 40];

/**
 * Runs a command and returns its exit status and what it printed: the default `spawn` of publish and tags. With
 * `inherit`, its output goes to this process's own instead (npm's and the --run command's belong in the job log). git
 * runs without the variables that could point it at another repository. One that cannot start throws.
 */
function runCommand(command, args, { cwd, env = process.env, input, inherit = false } = {}) {
  const childEnv = { ...env };
  if (command === 'git') for (const name of REPOSITORY_VARIABLES) delete childEnv[name];
  const result = spawnSync(command, args, {
    cwd,
    env: childEnv,
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: inherit ? ['ignore', 'inherit', 'inherit'] : 'pipe',
  });
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`);
  return { status: result.status, signal: result.signal ?? null, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** A plan file as plan and apply wrote it. */
function readPlanFile(file) {
  if (!fs.existsSync(file)) throw new Error(`${file} does not exist: the ci job's plan and apply write it`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file} is not JSON: ${error.message}`);
  }
}

/** The entries of the plan's publish order, each checked: a package or the root the plan lists, planned at x.y.z. */
function orderedEntries(plan) {
  if (plan?.schema !== 1) throw new Error(`the plan's schema is ${plan?.schema}, not 1: it was not written by this script's plan and apply`);
  return (plan.order ?? []).map((dir) => {
    const entry = plan.root && plan.root.dir === dir ? plan.root : (plan.packages ?? []).find((candidate) => candidate.dir === dir);
    if (!entry) throw new Error(`the plan's publish order names ${dir}, for which it lists no package`);
    if (entry.foreign || !VERSION.test(entry.planned ?? '')) throw new Error(`the plan's publish order names ${dir}, but ${entry.name} is not planned there`);
    return entry;
  });
}

/** Appends one record to the journal, with its time, so it is on disk before anything else runs. */
function appendJournal(journal, record) {
  fs.mkdirSync(path.dirname(journal), { recursive: true });
  fs.appendFileSync(journal, `${JSON.stringify({ ...record, at: new Date().toISOString() })}\n`);
}

/** The journal's records; an absent file is an empty journal. A line that does not parse fails, by its number. */
function readJournal(journal) {
  if (!fs.existsSync(journal)) return [];
  return fs
    .readFileSync(journal, 'utf8')
    .split('\n')
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => line !== '')
    .map(({ line, number }) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${journal} line ${number} is not JSON: ${error.message}`);
      }
    });
}

/** A version document's address on the registry, the scope's slash escaped as npm's own client escapes it. */
const versionAddress = (registry, name, version) => `${registry.replace(/\/+$/, '')}/${name.replace('/', '%2f')}/${version}`;

/** Whether npm holds a version, from its own document: 200 yes, 404 no; any other answer fails. */
async function holdsVersion(fetch, registry, name, version) {
  const url = versionAddress(registry, name, version);
  const response = await fetch(url);
  await response.arrayBuffer().catch(() => null);
  if (response.status === 200) return true;
  if (response.status === 404) return false;
  throw new Error(`${url} answered ${response.status}`);
}

/**
 * Waits until npm answers for a version just published, read every `every` seconds, so a dependent published next is
 * never on npm before the version its range names: the availability wait pnpm's recursive publish does not make. The
 * publish step's waits share one budget of `upTo` seconds, of which earlier waits spent `waited` milliseconds, and
 * this one reads until npm answers or the rest of the budget is spent. Resolves to the milliseconds it waited.
 */
async function waitForVersion({ fetch, registry, name, version, every, upTo, waited = 0 }) {
  const url = versionAddress(registry, name, version);
  const started = Date.now();
  const left = Math.max(0, upTo * 1000 - waited);
  const deadline = started + left;
  for (;;) {
    let answered;
    try {
      const response = await fetch(url);
      await response.arrayBuffer().catch(() => null);
      answered = response.status;
    } catch (error) {
      answered = error instanceof Error ? error.message : String(error);
    }
    if (answered === 200) return Date.now() - started;
    if (Date.now() >= deadline) {
      const within =
        waited === 0
          ? `within ${upTo} seconds of its publish`
          : `within ${Math.round(left / 1000)} seconds of its publish, what was left of the ${upTo} seconds the publish step waits for npm in all`;
      throw new Error(
        `npm's document for ${name}@${version} did not answer ${within} (its last answer: ${answered}); ` +
          "the packages after it in the order are not published, and the next push's run plans them again",
      );
    }
    console.log(`waiting for npm to answer for ${name}@${version} before the packages that name it (${answered})`);
    await sleep(every);
  }
}

/**
 * Checks the tarball directory before anything is published: expected.json written for the plan's head, naming the
 * plan's order, and each tarball it names present. Resolves to the file of each ordered entry.
 */
function checkTarballs(plan, ordered, tarballs) {
  const file = path.join(tarballs, 'expected.json');
  if (!fs.existsSync(file)) throw new Error(`${file} does not exist: the ci job's apply writes it beside the tarballs, so nothing is published`);
  let expected;
  try {
    expected = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file} is not JSON: ${error.message}`);
  }
  if (expected?.head !== plan.head) {
    throw new Error(`${file} was written for ${expected?.head ?? 'no commit'}, and the plan is for ${plan.head}: these tarballs are not this plan's, so nothing is published`);
  }
  const wanted = ordered.map((entry) => ({ name: entry.name, version: entry.planned, file: tarballFileName(entry.name, entry.planned) }));
  const listed = (Array.isArray(expected.tarballs) ? expected.tarballs : []).map(({ name, version, file: tarball }) => ({ name, version, file: tarball }));
  if (canonical(listed) !== canonical(wanted)) {
    const shown = (list) => (list.length === 0 ? '(nothing)' : list.map((tarball) => tarball.file).join(', '));
    throw new Error(`${file} names ${shown(listed)}, and the plan's order is ${shown(wanted)}: nothing is published`);
  }
  const missing = wanted.find((tarball) => !fs.existsSync(path.join(tarballs, tarball.file)));
  if (missing) throw new Error(`${missing.file}, the tarball of ${missing.name}@${missing.version}, is not in ${tarballs}: nothing is published`);
  return wanted.map((tarball) => tarball.file);
}

/** The step summary's lines for what the journal holds. */
function summarizeJournal(journal, env) {
  if (!env.GITHUB_STEP_SUMMARY) return;
  const records = (() => {
    try {
      return readJournal(journal);
    } catch {
      return [];
    }
  })();
  const line = (record) => {
    if (record.event === 'published') {
      const integrity = record.integrity ? ` (${record.integrity})` : '';
      const already = record.already ? ', on npm already from an earlier attempt of this run' : '';
      return `- published \`${record.name}@${record.version}\`${integrity}${already}`;
    }
    if (record.event === 'failed') return `- failed \`${record.name}@${record.version}\`: the publish exited ${record.code}`;
    if (record.event === 'stopped') return `- stopped: ${record.reason}`;
    return `- ${JSON.stringify(record)}`;
  };
  const rows = ['### Published', '', ...(records.length === 0 ? ['- nothing'] : records.map(line)), ''];
  fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${rows.join('\n')}\n`);
}

/** A workflow command's message, its three special characters escaped as the runner reads them back. */
const annotated = (text) => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

/**
 * Says which versions of the journal came through the npm token and not a trusted publisher, which nothing else in a
 * green run shows: npm tries OIDC first and falls back to the token without a word, so a trusted publisher that lapsed
 * reads as a green publish. npm marks a publish through a trusted publisher with `_npmUser.trustedPublisher` on the
 * version's document and leaves it off a publish through a token, whose `_npmUser` is the token's account. A version
 * with an earlier one on npm warns, and a package's first version gives a notice, each with the command to set its
 * publisher, the workflow file and the repository read from the run, since another repository copies this script.
 * The step summary carries the same lines and the count. A version npm answers 404 for is read again every `every`
 * seconds, all of them within one budget of `upTo` seconds, past which no read starts; a read that fails, a read the
 * budget left unstarted, or a document naming no publisher, warns that it could not read it. The package is out by now, so this never throws: whatever goes wrong here warns.
 * @param {object} args
 * @param {object} args.plan the plan the step published
 * @param {string} args.journal the file of what npm accepted
 * @returns {Promise<void>}
 */
export async function reportPublishers({ plan, journal, fetch = globalThis.fetch, registry = REGISTRY, env = process.env, every = PUBLISHER_WAIT.every, upTo = PUBLISHER_WAIT.upTo }) {
  try {
    if (plan.dryRun || !plan.run?.publishes) return;
    const published = readJournal(journal).filter((record) => record?.event === 'published');
    if (published.length === 0) return;

    const timed = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(PUBLISHER_READ_TIMEOUT) });
    const reader = registryReader({ fetch: timed, registry });
    const answers = new Map();
    const deadline = Date.now() + upTo * 1000;
    // Past this no read starts, so reads that hang to their timeout hold the job for the budget and two timeouts at most.
    const lastStart = deadline + PUBLISHER_READ_TIMEOUT;
    let pending = published;
    for (;;) {
      const read = await mapWithLimit(pending, PARALLEL_READS, async (record) => {
        if (Date.now() >= lastStart) return { record, failed: 'the time for these reads was spent' };
        try {
          return { record, document: await reader.versionDocument(record.name, record.version, { fresh: true }) };
        } catch (error) {
          return { record, failed: error instanceof Error ? error.message : String(error) };
        }
      });
      for (const answer of read) answers.set(answer.record, answer);
      pending = read.filter((answer) => answer.document === null).map((answer) => answer.record);
      if (pending.length === 0 || Date.now() >= deadline) break;
      await sleep(every);
    }

    const file = /\/\.github\/workflows\/([^/@]+)@/.exec(env.GITHUB_WORKFLOW_REF ?? '')?.[1] ?? '<the workflow file>';
    const repository = env.GITHUB_REPOSITORY || '<owner>/<repository>';
    const entries = orderedEntries(plan);
    const lines = [];
    let throughToken = 0;
    for (const record of published) {
      const id = `${record.name}@${record.version}`;
      const { document, failed } = answers.get(record);
      const unread = (why) => lines.push({ level: 'warning', text: `could not read the publisher of ${id}: ${why}; whether it came through its trusted publisher is not known` });
      if (failed !== undefined) {
        unread(failed);
        continue;
      }
      if (document === null) {
        unread('npm does not serve its document yet');
        continue;
      }
      const user = document._npmUser;
      if (user === null || typeof user !== 'object' || Object.keys(user).length === 0) {
        unread('its document names no publisher');
        continue;
      }
      if (user.trustedPublisher) continue;
      throughToken += 1;
      const command = `npm trust github ${record.name} --file ${file} --repo ${repository} --allow-publish -y`;
      const first = entries.find((entry) => entry.name === record.name)?.newest === null;
      const lapsed = 'delete a lapsed configuration first (npm trust list, npm trust revoke), then set it';
      lines.push(
        first
          ? {
              level: 'notice',
              text: `${id} is the package's first version, which publishes through the npm token by design; its trusted publisher must now be configured and used within two days`,
              command,
            }
          : {
              level: 'warning',
              text: record.already
                ? `${id} was published through the npm token by an earlier attempt of this run: the package's trusted publisher was missing or lapsed then; unless it has been set since, ${lapsed}`
                : `${id} was published through the npm token: the package's trusted publisher is missing or lapsed; ${lapsed}`,
              command,
            },
      );
    }

    for (const { level, text, command } of lines) console.log(`::${level}::${annotated(command ? `${text}: ${command}` : text)}`);
    if (lines.length === 0 || !env.GITHUB_STEP_SUMMARY) return;
    const rows = [
      '### Publishers',
      '',
      ...lines.map(({ text, command }) => (command ? `- ${text}: \`${command}\`` : `- ${text}`)),
      ...(throughToken > 0 ? [`- published through the token: ${throughToken} of ${published.length}`] : []),
      '',
    ];
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${rows.join('\n')}\n`);
  } catch (error) {
    console.log(`::warning::${annotated(`could not read the publishers of this run's versions: ${error instanceof Error ? error.message : String(error)}`)}`);
  }
}

/**
 * U1 publish: the plan's publish order, one package at a time, each journaled before the next starts. Exactly one of
 * `tarballs` (the directory the ci job packed the planned tarballs into, beside expected.json) or `run` (a shell
 * command run in each package's directory, with RELEASE_NAME, RELEASE_VERSION and RELEASE_DIR set). In order: a plan
 * that publishes nothing (a dry run, or a commit master has moved past) prints its reason and publishes nothing; in
 * tarball mode expected.json must be the plan's and every tarball it names present, and in --run mode the checkout
 * must be at the plan's head, before anything is published; then for each package master's head is read again
 * (`tipOf`): moved past the plan's head, a stopped record ends the loop green, and a head that does not hold it fails;
 * the package's versions on npm are read again, and a version above the newest one the plan counted fails ("npm gained
 * <v> during the run"), except the planned version npm holds as this run's tarball made it (its version document's
 * gitHead the plan's head and its dist.integrity the tarball's), which an earlier attempt of this run published: it
 * is journaled as published, with `already: true`, and not published again (tarball mode alone: --run mode has no
 * tarball to compare); the publish runs; a non-zero exit journals a failed record and fails with that exit code (the
 * error's `exitCode`), a success journals a published record; and when a later package names this one in its
 * dependencies, peerDependencies or optionalDependencies, the new version's document is read every `every` seconds
 * until npm answers, every such wait of the run drawing on one budget of `upTo` seconds, so the release job's time
 * limit holds them whatever chain of dependents the plan orders. Resolves to `{ published, stopped }`.
 */
export async function publishPlan({
  root = REPO_ROOT,
  plan,
  journal,
  tarballs = null,
  run = null,
  fetch = globalThis.fetch,
  registry = REGISTRY,
  tipOf,
  spawn = runCommand,
  every = DOCUMENT_WAIT.every,
  upTo = DOCUMENT_WAIT.upTo,
  env = process.env,
} = {}) {
  if ((tarballs === null) === (run === null)) throw new Error('publish takes exactly one of --tarballs <dir> and --run <command>');
  if (run !== null && String(run).trim() === '') throw new Error('--run needs the command to run in each package directory');
  if (!journal) throw new Error('publish needs --journal <file>, where each publish is recorded');
  const ordered = orderedEntries(plan);
  if (plan.dryRun || !plan.run?.publishes) {
    const reason = plan.run?.reason ?? 'a dry run publishes nothing';
    console.log(`Publishing nothing: ${reason}.`);
    return { published: [], stopped: null, reason };
  }
  const tarballDir = tarballs === null ? null : path.resolve(tarballs);
  const files = tarballDir === null ? null : checkTarballs(plan, ordered, tarballDir);
  if (run !== null) {
    const checkout = gitOutput(root, ['rev-parse', 'HEAD']).trim();
    if (checkout !== plan.head) {
      throw new Error(`the checkout is at ${checkout} and the plan is for ${plan.head}: --run publishes from the checkout, so it must be the plan's head, with the plan applied`);
    }
  }
  if (ordered.length === 0) {
    console.log('Publishing nothing: the plan orders no package.');
    return { published: [], stopped: null, reason: 'the plan orders no package' };
  }

  const readTipNow = tipOf ?? (() => readTip(root, env));
  const reader = registryReader({ fetch, registry });
  const published = [];
  // What the waits for the dependencies' documents have spent of their one budget, in milliseconds: the images step
  // waits once for every image the same way, and the job's time limit holds the two budgets beside the publishes.
  let waited = 0;
  for (const [index, entry] of ordered.entries()) {
    const id = `${entry.name}@${entry.planned}`;
    // master's head before each publish: a push that landed during the run hands the rest to its own run, which
    // plans from npm and the tags and so covers this commit's changes too.
    const tip = String(await readTipNow()).trim();
    if (!SHA.test(tip)) throw new Error(`master's head read as ${tip || 'nothing'}, which is not a commit sha`);
    if (tip !== plan.head) {
      ensureCommit(root, env, tip);
      if (await gitAnswers(root, ['merge-base', '--is-ancestor', plan.head, tip])) {
        const reason = `master has moved past ${plan.head} to ${tip} before ${entry.name}`;
        appendJournal(journal, { event: 'stopped', reason });
        console.log(`${reason}: nothing more is published from this commit; the newer commit's run plans the rest.`);
        return { published, stopped: reason };
      }
      throw new Error(`master's tip ${tip} does not hold this commit ${plan.head}: only master publishes, and nothing more is published`);
    }

    // The versions npm holds now, read whole: the planned version, or any above the newest the plan counted, came
    // from outside this run (a hand publish, a run outside the group), and the next run decides again from it. The
    // planned version npm holds as this run's tarball made it, its version document's gitHead the plan's head and its
    // dist.integrity the tarball's, came from an earlier attempt of this run, since a re-run of the release job
    // replays the first attempt's plan and tarballs: it is journaled as published, already on npm, and not published
    // again. Any other copy of it fails as any version from outside the run does.
    const document = await reader.document(entry.name);
    const gained = Object.keys(document?.versions ?? {})
      .filter((version) => VERSION.test(version) && (entry.newest === null || compareVersions(version, entry.newest) > 0))
      .sort(compareVersions);
    if (gained.length === 0 && (await holdsVersion(fetch, registry, entry.name, entry.planned))) gained.push(entry.planned);
    const file = files === null ? null : files[index];
    const integrity = file === null ? null : `sha512-${crypto.createHash('sha512').update(fs.readFileSync(path.join(tarballDir, file))).digest('base64')}`;
    let already = false;
    if (integrity !== null && gained.includes(entry.planned)) {
      const held = await reader.versionDocument(entry.name, entry.planned, { fresh: true });
      if (held !== null && held.gitHead === plan.head && held.dist?.integrity === integrity) {
        already = true;
        gained.splice(gained.indexOf(entry.planned), 1);
      }
    }
    if (gained.length > 0) {
      const counted = entry.newest === null ? 'while the plan counted none' : `above ${entry.newest}, the newest the plan counted`;
      throw new Error(`npm gained ${gained.join(', ')} of ${entry.name} during the run, ${counted}; the next push's run plans again`);
    }

    if (already) {
      appendJournal(journal, { event: 'published', name: entry.name, version: entry.planned, tarball: file, integrity, already: true });
      published.push({ name: entry.name, version: entry.planned, tarball: file, integrity, already: true });
      console.log(
        `${id} is on npm already, published from ${plan.head.slice(0, 8)} with this tarball's integrity by an earlier attempt of this run: ` +
          'it is journaled as published and not published again',
      );
    } else {
      const dir = path.join(root, entry.dir);
      const result =
        file === null
          ? spawn('sh', ['-c', run], {
              cwd: dir,
              env: { ...env, PWD: dir, RELEASE_NAME: entry.name, RELEASE_VERSION: entry.planned, RELEASE_DIR: entry.dir },
              inherit: true,
            })
          : spawn('npm', ['publish', path.join(tarballDir, file), '--access', 'public', '--provenance'], { cwd: tarballDir, env, inherit: true });
      if (result.status !== 0) {
        const code = Number.isInteger(result.status) && result.status > 0 ? result.status : 1;
        appendJournal(journal, { event: 'failed', name: entry.name, version: entry.planned, code });
        const what = file === null ? `the --run command for ${entry.dir}` : `npm publish ${file}`;
        const error = new Error(
          `${what} exited ${result.status ?? `on ${result.signal ?? 'a signal'}`}: ${id} is not published, nor anything after it in the order; ` +
            "the journal holds what npm accepted, the tags step tags it, and the next push's run plans the rest",
        );
        error.exitCode = code;
        throw error;
      }
      appendJournal(journal, { event: 'published', name: entry.name, version: entry.planned, tarball: file, integrity });
      published.push({ name: entry.name, version: entry.planned, tarball: file, integrity });
      console.log(`published ${id}${integrity ? ` (${integrity})` : ''}`);
    }

    const dependents = ordered.slice(index + 1).filter((later) => (later.ranges ?? []).some((range) => range.sibling === entry.name));
    if (dependents.length > 0) waited += await waitForVersion({ fetch, registry, name: entry.name, version: entry.planned, every, upTo, waited });
  }
  return { published, stopped: null };
}

/**
 * The notes of a GitHub release (U1 tags). For a published version: one line `- <subject> (#<n>)` for each commit
 * subject since the package's base, the number read from the squash subject's trailing `(#n)` (a subject without one
 * is `- <subject>` alone), or "The first release of <name>." when the package had no base; no line when no commit
 * since the base names the change. Then each range the plan raised on a sibling, `- <sibling> <from> to <to>, in
 * <field>`, so a dependent planned for a raised range alone says why it was published; a `workspace:` text names what
 * pnpm packs it as for the sibling's version in the run, and one pnpm packs as it is written says so. The root's
 * notes then list the catalog entries apply found moved (section 7: the packs whose versions moved),
 * `- <name> <from> to <to>`, or `- <name> <to>, new in the catalog` and `- <name> <from>, no longer in the catalog`.
 * For a repair record: "<name>@<version> as npm holds it, published from <commit>."
 * @param {object} plan the applied plan
 * @param {object} entry a published journal record, or a repair record
 * @returns {string}
 */
export function releaseNotes(plan, entry) {
  if (entry?.event !== 'published') return `${entry.name}@${entry.version} as npm holds it, published from ${entry.commit}.\n`;
  const planned = [...(plan.packages ?? []), ...(plan.root ? [plan.root] : [])].find((candidate) => candidate.name === entry.name);
  if (planned && planned.baseCommit === null) return `The first release of ${entry.name}.\n`;
  const lines = (planned?.subjects ?? []).map(({ subject, pullRequest }) => {
    const number = Number.isInteger(pullRequest) ? pullRequest : pullRequestOf(subject);
    return number === null ? `- ${subject}` : `- ${subject.replace(/\s*\(#\d+\)\s*$/, '')} (#${number})`;
  });
  const siblingVersion = (name) => {
    const sibling = (plan.packages ?? []).find((candidate) => candidate.name === name);
    return sibling ? (sibling.planned ?? sibling.newest ?? null) : null;
  };
  const raised = [];
  for (const range of planned?.ranges ?? []) {
    if (!range?.raised) continue;
    const version = siblingVersion(range.sibling);
    const packed = String(range.master ?? '').startsWith('workspace:') && version !== null ? packedRange(range.field, range.master, version) : null;
    if (packed?.written) raised.push(`- ${range.sibling} ${packed.text}, in ${range.field}, packed as it is written, which does not admit ${version}`);
    else raised.push(`- ${range.sibling} ${range.effective} to ${packed === null ? range.applied : packed.text}, in ${range.field}`);
  }
  if (raised.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('The ranges raised on its siblings:', ...raised);
  }
  const moved = planned !== undefined && planned === plan.root && Array.isArray(planned.moved) ? planned.moved : [];
  if (moved.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('The versions that moved in the catalog:');
    for (const { package: name, from, to } of moved) {
      if (from === null) lines.push(`- ${name} ${to}, new in the catalog`);
      else if (to === null) lines.push(`- ${name} ${from}, no longer in the catalog`);
      else lines.push(`- ${name} ${from} to ${to}`);
    }
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/**
 * The environment `git tag -a` runs in: the committer the environment names, else the one git's config names, else
 * github-actions[bot], since the release job's checkout configures no identity and an annotated tag needs a tagger.
 */
function taggerEnvironment(spawn, root, env) {
  if (env.GIT_COMMITTER_NAME && env.GIT_COMMITTER_EMAIL) return env;
  const configured = (key) => {
    const result = spawn('git', ['config', '--get', key], { cwd: root, env });
    return result.status === 0 && result.stdout.trim() !== '';
  };
  if (configured('user.name') && configured('user.email')) return env;
  return { ...env, GIT_COMMITTER_NAME: RELEASE_TAGGER.name, GIT_COMMITTER_EMAIL: RELEASE_TAGGER.email };
}

/**
 * U1 tags: the tags and releases the journal and the plan's repair records name. In order: (a) the journal (an absent
 * file is an empty one) and the repairs are read; (b) an annotated tag `<name>@<version>` is made in this clone at the
 * plan's head for each published record and at the record's commit for each tag repair (one already there at that
 * commit is kept, one at another commit fails the run by name), in the clone first, so the images step after this one
 * reads them here; (c) they are pushed in one `git push --atomic` to the repository's address with the token, up to
 * three attempts `waits` seconds apart, each read back with `git ls-remote --tags` (a tag the remote holds at another
 * commit fails by name, and is not pushed); (d) each tag in place, and each release repair, gets its GitHub release
 * unless one exists (`gh release create --verify-tag`, the notes from releaseNotes; a create that fails is followed by
 * a read of the release, and one found then, which another run made meanwhile, counts as made); (e) a package of the
 * publish order the journal names no publish for fails the run, unless the journal holds a stopped record or the package's tag
 * `<name>@<planned>` names the plan's head in this clone already (the release job's checkout fetches the remote's
 * tags): an earlier attempt of this run published and tagged it, and a re-run replays that attempt's plan. A failure is
 * thrown after the rest is done, naming each. A dry run's plan, or one that publishes nothing, tags nothing. Needs
 * GH_TOKEN (or GITHUB_TOKEN) and GITHUB_REPOSITORY when there is anything to push or release.
 * @returns {Promise<{ tags: string[], releases: string[] }>}
 */
export async function tagsFromJournal({ root = REPO_ROOT, plan, journal, spawn = runCommand, env = process.env, waits = TAG_PUSH_WAITS, sleep: pause = sleep } = {}) {
  if (!journal) throw new Error('tags needs --journal <file>, the publish step\'s record of what npm accepted');
  const ordered = orderedEntries(plan);
  if (plan.dryRun || !plan.run?.publishes) {
    console.log(`Tagging nothing: ${plan.run?.reason ?? 'a dry run publishes nothing'}.`);
    return { tags: [], releases: [] };
  }
  const records = readJournal(journal);
  const failures = [];
  const stopped = records.find((record) => record?.event === 'stopped') ?? null;
  const publishedNames = new Set();
  /** The tags to be in place, by name, in the order they are asked for: the published versions first, then the repairs. */
  const wanted = new Map();
  const want = (name, version, commit, notes) => {
    const tag = `${name}@${version}`;
    const earlier = wanted.get(tag);
    if (earlier && earlier.commit !== commit) failures.push(`tag ${tag} is asked for at ${earlier.commit} and at ${commit}; it is made at neither`);
    else if (!earlier) wanted.set(tag, { tag, commit, notes });
  };
  for (const record of records.filter((candidate) => candidate?.event === 'published')) {
    const entry = ordered.find((candidate) => candidate.name === record.name);
    if (!entry || entry.planned !== record.version) {
      failures.push(`the journal names ${record.name}@${record.version}, which this plan does not order; it is not tagged here`);
      continue;
    }
    publishedNames.add(entry.name);
    want(record.name, record.version, plan.head, releaseNotes(plan, record));
  }
  for (const record of plan.repairs ?? []) {
    if (record.kind === 'tag') want(record.name, record.version, record.commit, releaseNotes(plan, record));
  }
  for (const tag of [...wanted.keys()]) {
    if (failures.some((line) => line.startsWith(`tag ${tag} is asked for`))) wanted.delete(tag);
  }
  const releaseRepairs = (plan.repairs ?? []).filter((record) => record.kind === 'release').map((record) => ({ tag: `${record.name}@${record.version}`, notes: releaseNotes(plan, record) }));

  const made = [];
  const inPlace = [];
  const releases = [];
  if (wanted.size + releaseRepairs.length > 0) {
    const token = env.GH_TOKEN || env.GITHUB_TOKEN;
    const repository = env.GITHUB_REPOSITORY;
    if (!token || !/^[^/\s]+\/[^/\s]+$/.test(repository ?? '')) {
      throw new Error('tags needs GH_TOKEN (or GITHUB_TOKEN) and GITHUB_REPOSITORY: it pushes the tags and makes the releases with them');
    }
    const address = `https://x-access-token:${token}@github.com/${repository}`;
    const shown = `https://github.com/${repository}`;
    const hide = (text) => masked(String(text), token);
    const git = (args, more = env) => spawn('git', args, { cwd: root, env: more });

    // (b) The tags in this clone, before anything is pushed.
    const tagEnv = wanted.size > 0 ? taggerEnvironment(spawn, root, env) : env;
    for (const target of wanted.values()) {
      const local = git(['rev-parse', '-q', '--verify', `refs/tags/${target.tag}^{commit}`]);
      const at = local.status === 0 ? local.stdout.trim() : null;
      if (at === target.commit) {
        console.log(`${target.tag} names ${target.commit.slice(0, 8)} in this clone already; it is kept`);
        made.push(target);
        continue;
      }
      if (at !== null) {
        failures.push(`tag ${target.tag} names ${at} in this clone, not ${target.commit}, the commit npm's version was published from; re-point it by hand (git tag -f -a ${target.tag} -m ${target.tag} ${target.commit}) and re-run`);
        continue;
      }
      const created = git(['tag', '-a', target.tag, '-m', target.tag, target.commit], tagEnv);
      if (created.status !== 0) {
        failures.push(`git tag -a ${target.tag} ${target.commit} failed: ${hide(said(created))}`);
        continue;
      }
      made.push(target);
    }

    // (c) The push, read back each time: the remote's tags as git ls-remote names them, each peeled to its commit.
    const remoteTags = () => {
      const listed = git(['ls-remote', '--tags', address]);
      if (listed.status !== 0) {
        console.log(`::warning::git ls-remote --tags ${shown} failed: ${hide(said(listed))}`);
        return null;
      }
      const refs = new Map();
      for (const line of listed.stdout.split('\n')) {
        const [sha, ref] = line.trim().split(/\s+/);
        if (SHA.test(sha ?? '') && ref) refs.set(ref, sha);
      }
      return refs;
    };
    let pending = [...made];
    const settle = (refs) => {
      if (refs === null) return;
      const still = [];
      for (const target of pending) {
        // An annotated tag's peeled line names its commit; a lightweight tag's own line does.
        const at = refs.get(`refs/tags/${target.tag}^{}`) ?? refs.get(`refs/tags/${target.tag}`) ?? null;
        if (at === target.commit) inPlace.push(target);
        else if (at === null) still.push(target);
        else failures.push(`tag ${target.tag} on ${shown} names ${at}, not ${target.commit}; re-point it by hand (git tag -f -a ${target.tag} -m ${target.tag} ${target.commit} && git push --force origin refs/tags/${target.tag}) and re-run`);
      }
      pending = still;
    };
    // A tag the remote holds already at its commit (a re-run of this job) is in place without a push.
    if (pending.length > 0) settle(remoteTags());
    for (let attempt = 1; attempt <= 3 && pending.length > 0; attempt += 1) {
      const pushed = git(['push', '--atomic', address, ...pending.map((target) => `refs/tags/${target.tag}`)]);
      if (pushed.status !== 0) console.log(`::warning::pushing ${pending.length} release tag(s) to ${shown} failed (attempt ${attempt} of 3): ${hide(said(pushed))}`);
      settle(remoteTags());
      if (pending.length > 0 && attempt < 3) await pause(waits[attempt - 1] ?? 0);
    }
    if (pending.length > 0) {
      failures.push(
        `${pending.length} release tag(s) are not on the remote after three pushes: ${pending.map((target) => target.tag).join(', ')}; ` +
          'push each by hand from a clone that may push it, git tag -f -a <tag> -m <tag> <commit> && git push --force origin refs/tags/<tag> (RELEASING.md, troubleshooting)',
      );
    }
    for (const target of made) if (inPlace.includes(target)) console.log(`${target.tag} is on ${shown} at ${target.commit.slice(0, 8)}`);

    // (d) The releases, for the tags in place and the release repairs. A draft is not a release (the plan's release
    // list leaves drafts out), so one is made beside it.
    const released = (tag) => {
      const viewed = spawn('gh', ['release', 'view', tag, '--repo', repository, '--json', 'isDraft', '--jq', '.isDraft'], { cwd: root, env });
      return viewed.status === 0 && viewed.stdout.trim() === 'false';
    };
    const release = (tag, notes) => {
      if (released(tag)) {
        console.log(`${tag}: its GitHub release exists`);
        return;
      }
      const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-'));
      try {
        const notesFile = path.join(folder, 'notes.md');
        fs.writeFileSync(notesFile, notes);
        const created = spawn('gh', ['release', 'create', tag, '--repo', repository, '--verify-tag', '--title', tag, '--notes-file', notesFile], { cwd: root, env });
        if (created.status !== 0) {
          // Another run carrying the same release (the second publish workflow of a repository, in a concurrency group
          // of its own) can make it between the read above and this create, and GitHub refuses the create then. A
          // release for the tag on a read after the refusal is the one this run would have made, so it counts as made.
          if (released(tag)) {
            releases.push(tag);
            console.log(`${tag}: its GitHub release was made by another run between this run's read and its create; it is counted as made`);
            return;
          }
          failures.push(`gh release create ${tag} failed: ${hide(said(created))}`);
          return;
        }
        releases.push(tag);
        console.log(`${tag}: its GitHub release is made`);
      } finally {
        fs.rmSync(folder, { recursive: true, force: true });
      }
    };
    const order = [...wanted.keys()];
    for (const target of [...inPlace].sort((a, b) => order.indexOf(a.tag) - order.indexOf(b.tag))) release(target.tag, target.notes);
    for (const record of releaseRepairs) release(record.tag, record.notes);
  }

  // (e) What the journal leaves unpublished, unless master moved and the newer run took it. A package whose tag names
  // the plan's head already was published and tagged by an earlier attempt of this run, whose plan a re-run replays,
  // so it is not left unpublished whatever this attempt's publish step journaled.
  if (stopped === null) {
    const left = [];
    for (const entry of ordered) {
      if (publishedNames.has(entry.name)) continue;
      const tag = `${entry.name}@${entry.planned}`;
      const local = spawn('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`], { cwd: root, env });
      if (local.status === 0 && local.stdout.trim() === plan.head) {
        console.log(`${tag} names ${plan.head.slice(0, 8)} already: an earlier attempt of this run published and tagged it`);
        continue;
      }
      left.push(entry.name);
    }
    if (left.length > 0) failures.push(`left unpublished: ${left.join(', ')}; the next push's run plans them again`);
  } else {
    console.log(`${stopped.reason}: the packages after it are the newer commit's run's`);
  }

  if (env.GITHUB_STEP_SUMMARY) {
    const rows = [
      '### Tags and releases',
      '',
      ...inPlace.map((target) => `- tag \`${target.tag}\` at ${target.commit.slice(0, 8)}`),
      ...releases.map((tag) => `- release \`${tag}\` made`),
      ...failures.map((line) => `- failed: ${line}`),
      ...(inPlace.length + releases.length + failures.length === 0 ? ['- nothing to tag'] : []),
      '',
    ];
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${rows.join('\n')}\n`);
  }
  if (failures.length > 0) throw new Error(failures.join('; '));
  return { tags: inPlace.map((target) => target.tag), releases };
}

const PUBLISH_OPTIONS = {
  plan: { type: 'string' },
  journal: { type: 'string' },
  tarballs: { type: 'string' },
  run: { type: 'string' },
  root: { type: 'string' },
  registry: { type: 'string' },
  tip: { type: 'string' },
  'publisher-up-to': { type: 'string' },
};

async function publishCommand(args) {
  const { values } = parseArgs({ args, options: PUBLISH_OPTIONS, strict: true });
  if (values.plan === undefined) throw new Error('publish needs --plan <file>, the plan the ci job applied');
  if (values.journal === undefined) throw new Error('publish needs --journal <file>, where each publish is recorded');
  if ((values.tarballs === undefined) === (values.run === undefined)) throw new Error('publish takes exactly one of --tarballs <dir> and --run <command>');
  if (values.tip !== undefined && !SHA.test(values.tip)) throw new Error(`--tip ${values.tip} is not a commit sha`);
  const journal = path.resolve(values.journal);
  const publisherUpTo = amountOf(values['publisher-up-to'], '--publisher-up-to', 'seconds');
  let plan = null;
  try {
    plan = readPlanFile(path.resolve(values.plan));
    await publishPlan({
      root: path.resolve(values.root ?? REPO_ROOT),
      plan,
      journal,
      tarballs: values.tarballs === undefined ? null : path.resolve(values.tarballs),
      run: values.run ?? null,
      registry: values.registry ?? REGISTRY,
      tipOf: values.tip === undefined ? undefined : () => values.tip,
    });
  } finally {
    summarizeJournal(journal, process.env);
    if (plan !== null) await reportPublishers({ plan, journal, registry: values.registry ?? REGISTRY, upTo: publisherUpTo });
  }
}

const TAGS_OPTIONS = {
  plan: { type: 'string' },
  journal: { type: 'string' },
  root: { type: 'string' },
};

async function tagsCommand(args) {
  const { values } = parseArgs({ args, options: TAGS_OPTIONS, strict: true });
  if (values.plan === undefined) throw new Error('tags needs --plan <file>, the plan the ci job applied');
  if (values.journal === undefined) throw new Error("tags needs --journal <file>, the publish step's record of what npm accepted");
  await tagsFromJournal({ root: path.resolve(values.root ?? REPO_ROOT), plan: readPlanFile(path.resolve(values.plan)), journal: path.resolve(values.journal) });
}

/** The events whose runs of an image workflow push `:sha-<commit>`: a push to master and a manual run. */
const IMAGE_RUN_EVENTS = new Set(['push', 'workflow_dispatch']);

/** Runs a command with this process's environment and returns its exit status and output; one that cannot start throws. */
function spawnTool(command, args, { input, cwd } = {}) {
  const result = spawnSync(command, args, { cwd, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`);
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** What a command printed, for a message: its standard error and output, or its exit status when it printed nothing. */
const said = (result) => `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim() || `exit ${result.status}`;

const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/**
 * The newest run of an image workflow on a commit that a push to master or a manual run started, or null: the
 * workflow's runs filtered by `head_sha` (GitHub's "List workflow runs for a workflow").
 */
function imageRunOf(spawn, repository, workflow, commit) {
  const route = `repos/${repository}/actions/workflows/${workflow}/runs?head_sha=${commit}&per_page=10`;
  const result = spawn('gh', ['api', route]);
  if (result.status !== 0) throw new Error(`gh api ${route} failed: ${said(result)}`);
  let runs;
  try {
    runs = JSON.parse(result.stdout).workflow_runs;
  } catch {
    runs = undefined;
  }
  if (!Array.isArray(runs)) throw new Error(`gh api ${route} answered no list of workflow runs`);
  const started = runs.filter((run) => IMAGE_RUN_EVENTS.has(run?.event));
  started.sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0) || b.id - a.id);
  return started[0] ?? null;
}

/** The digest a reference names on the registry, as buildx reads it. */
function digestOf(spawn, reference) {
  const result = spawn('docker', ['buildx', 'imagetools', 'inspect', '--format', '{{json .Manifest.Digest}}', reference]);
  if (result.status !== 0) throw new Error(`docker buildx imagetools inspect ${reference} failed: ${said(result)}`);
  let digest = null;
  try {
    digest = JSON.parse(result.stdout.trim());
  } catch {
    digest = null;
  }
  if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`docker buildx imagetools inspect ${reference} named no digest: ${result.stdout.trim() || 'nothing'}`);
  }
  return digest;
}

/**
 * The `images` key of the role map at a commit, or null when the commit's role map has none or does not parse; read
 * once a commit through `seen`. The cut-over put the key in the role map, so a release tag counts for the images step
 * from the commit whose role map names the pack's folder there: before it, the image workflow wrote the version's tag
 * itself.
 */
function imagesAt(root, commit, seen) {
  if (!seen.has(commit)) {
    let images = null;
    const shown = gitRun(root, ['show', `${commit}:scripts/package-roles.json`]);
    if (shown.status === 0) {
      try {
        const map = JSON.parse(shown.stdout).images;
        images = map && typeof map === 'object' && !Array.isArray(map) ? map : null;
      } catch {
        images = null;
      }
    }
    seen.set(commit, images);
  }
  return seen.get(commit);
}

/**
 * Every tag GHCR holds for an image, as one list: `skopeo list-tags docker://<image>`, which reads the registry's tag
 * list through every page and prints `{ Repository, Tags }`, with the credentials `docker login` wrote (skopeo reads
 * docker's config.json after its own auth.json).
 */
function tagsOnRegistry(spawn, image) {
  const listed = spawn('skopeo', ['list-tags', `docker://${image}`]);
  if (listed.status !== 0) throw new Error(`could not read the tags of ${image} on GHCR: ${said(listed)}`);
  let tags;
  try {
    const answer = JSON.parse(listed.stdout);
    tags = answer?.Tags === null ? [] : answer?.Tags;
  } catch {
    tags = undefined;
  }
  if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === 'string')) {
    throw new Error(`skopeo list-tags docker://${image} answered no list of tags: ${listed.stdout.trim() || 'nothing'}`);
  }
  return new Set(tags);
}

/**
 * One version GHCR lacks: the image commit (the newest first-parent commit at or before the tag's commit that changed
 * the pack's folder, whose push ran the image workflow and pushed `:sha-<its first seven characters>`), its run waited
 * for while it is queued or running, until the step's one `deadline`, and the version's tag copied from that commit's
 * tag once the run succeeded, both digests read back as equal.
 */
async function copyVersion({ root, spawn, every, upTo, deadline, repository, dir, name, image, workflow, version, commit }) {
  const imageCommit = gitOutput(root, ['log', '-1', '--first-parent', '--format=%H', commit, '--', dir]).trim();
  if (!SHA.test(imageCommit)) throw new Error(`no first-parent commit at or before ${commit.slice(0, 8)} changed ${dir}`);
  const target = `${image}:${version}`;
  const source = `${image}:sha-${imageCommit.slice(0, 7)}`;
  let run = imageRunOf(spawn, repository, workflow, imageCommit);
  while (run !== null && run.status !== 'completed') {
    if (Date.now() >= deadline) {
      throw new Error(
        `run ${run.id} of ${workflow} on ${imageCommit} is still ${run.status} after ${upTo} seconds, the images step's one wait for every image; the next release run reconciles again`,
      );
    }
    console.log(`${name} ${version}: waiting for run ${run.id} of ${workflow} on ${imageCommit.slice(0, 8)} (${run.status})`);
    await sleep(every);
    run = imageRunOf(spawn, repository, workflow, imageCommit);
  }
  if (run === null) throw new Error(`no run of ${workflow} on ${imageCommit}`);
  if (run.conclusion !== 'success') throw new Error(`run ${run.id} of ${workflow} on ${imageCommit} ended ${run.conclusion ?? 'with no conclusion'}`);

  // With one source buildx wraps a single manifest in a new index unless told not to (--prefer-index defaults to true),
  // and that index's digest is not the tested image's; --prefer-index=false copies the source as it is.
  const created = spawn('docker', ['buildx', 'imagetools', 'create', '--prefer-index=false', '-t', target, source]);
  if (created.status !== 0) throw new Error(`docker buildx imagetools create -t ${target} ${source} failed: ${said(created)}`);
  const tagged = digestOf(spawn, target);
  const tested = digestOf(spawn, source);
  if (tagged !== tested) throw new Error(`${target} reads ${tagged}, not the digest of ${source}, ${tested}`);
  return { imageCommit, run: run.id, digest: tagged, detail: `copied ${source} (run ${run.id} of ${workflow}) to ${target}, ${tagged}` };
}

/**
 * One image pack: every release tag of the pack made since the role map named its image, in version order, against
 * one read of the image's tags on GHCR; a version GHCR holds is left as it is, and each one it lacks is copied
 * (copyVersion). A version that fails is named and the others still go. Resolves to `{ results, failures }`, one
 * result a version (or one saying there is nothing to tag) and one failure a version that failed.
 */
async function reconcileImage({ root, spawn, every, upTo, deadline, repository, tags, roleMaps, dir, name, image, workflow }) {
  if (typeof image !== 'string' || !/^[a-z0-9][a-z0-9.-]*(\/[a-z0-9][a-z0-9._-]*)+$/.test(image)) {
    throw new Error(`the role map's images entry for ${dir} names no image (registry/owner/name)`);
  }
  if (typeof workflow !== 'string' || !/^[\w.-]+\.ya?ml$/.test(workflow)) {
    throw new Error(`the role map's images entry for ${dir} names no workflow file`);
  }
  const named = tags.filter((tag) => tag.name === name);
  const counted = named
    .filter((tag) => Object.hasOwn(imagesAt(root, tag.commit, roleMaps) ?? {}, dir))
    .sort((a, b) => compareVersions(a.version, b.version));
  if (counted.length === 0) {
    const detail = named.length === 0 ? `no release tag ${name}@<version> yet; nothing to tag` : `no release tag ${name}@<version> since the role map named its image; nothing to tag`;
    console.log(`${name}: ${detail}`);
    return { results: [{ dir, name, image, version: null, action: 'none', detail }], failures: [] };
  }

  const held = tagsOnRegistry(spawn, image);
  const results = [];
  const failures = [];
  for (const { version, commit } of counted) {
    const target = `${image}:${version}`;
    const found = { dir, name, image, version, commit };
    if (held.has(version)) {
      const detail = `${target} is on GHCR; a version's tag is never moved`;
      results.push({ ...found, action: 'present', detail });
      console.log(`${name}: ${detail}`);
      continue;
    }
    try {
      const copied = await copyVersion({ root, spawn, every, upTo, deadline, repository, dir, name, image, workflow, version, commit });
      results.push({ ...found, action: 'copied', ...copied });
      console.log(`${name}: ${copied.detail}`);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      const message = text.includes(target) ? text : `${text} (${target})`;
      failures.push({ name, message });
      results.push({ ...found, action: 'failed', detail: message });
      console.log(`${name}: ${message}`);
    }
  }
  return { results, failures };
}

/** The images step's lines in the job summary: one row a version, or a pack's one row when it has nothing to tag or failed whole. */
function summarizeImages(results) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const cell = (text) => String(text ?? '').replace(/\|/g, '\\|');
  const rows = [
    '### Image version tags',
    '',
    '| pack | image | version | what the step did |',
    '| --- | --- | --- | --- |',
    ...results.map((result) => `| ${cell(result.name)} | ${cell(result.image)} | ${cell(result.version)} | ${cell(result.detail)} |`),
    '',
  ];
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${rows.join('\n')}\n`);
}

/**
 * The image version tags, one writer (the release job's images step, on every run). For each image pack the role
 * map's `images` key names, in order: every release tag of the pack made since the role map named its image (the
 * role map at the tag's commit lists the pack's folder under `images`) gives a version and its commit, and the
 * image's tags on GHCR are read once, as one list. For each such version GHCR lacks, the image workflow's run on the
 * image commit is read, waited for while it is queued or running (every `every` seconds; the step waits until one
 * deadline, `upTo` seconds after it starts, for every image together, so two stuck runs do not wait twice), and once
 * it has succeeded its `:sha-` manifest is copied to the version's tag with no rebuild, both digests read back as
 * equal. A version's tag already on GHCR is never moved. Every version is reconciled before the step ends; one that
 * fails fails the step, naming each with its image and version, so an older version whose image run was red, or
 * had none, stays named after a newer one ships.
 * Needs GH_TOKEN (or GITHUB_TOKEN), GITHUB_ACTOR and GITHUB_REPOSITORY, and skopeo on PATH.
 * @returns {Promise<object[]>} one result a version
 */
export async function reconcileImages({ root = REPO_ROOT, spawn = spawnTool, every = IMAGE_WAIT.every, upTo = IMAGE_WAIT.upTo } = {}) {
  const roleMap = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'package-roles.json'), 'utf8'));
  const images = Object.entries(roleMap.images ?? {});
  if (images.length === 0) {
    console.log('no image packs in the role map');
    return [];
  }
  const env = process.env;
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (!token) throw new Error("the images step needs GH_TOKEN (or GITHUB_TOKEN) to read GHCR and the image workflows' runs");
  if (!env.GITHUB_ACTOR) throw new Error('the images step needs GITHUB_ACTOR to log in to ghcr.io');
  const repository = repositoryOf(root, env);
  if (!repository) throw new Error('the images step needs GITHUB_REPOSITORY (or a repository address in the root package.json)');
  const login = spawn('docker', ['login', 'ghcr.io', '-u', env.GITHUB_ACTOR, '--password-stdin'], { input: token });
  if (login.status !== 0) throw new Error(`docker login ghcr.io failed: ${masked(said(login), token)}`);

  const tags = listTags(root);
  const roleMaps = new Map();
  // One wait for the whole step (the spec's risk 10: the release job waits up to 45 minutes for an image run), so
  // a second image whose run is stuck too is read once more when the time is up, not waited for again.
  const deadline = Date.now() + upTo * 1000;
  const results = [];
  const failures = [];
  for (const [dir, entry] of images) {
    let name = dir;
    try {
      const file = path.join(root, dir, 'package.json');
      if (!fs.existsSync(file)) throw new Error(`${dir}/package.json does not exist`);
      name = JSON.parse(fs.readFileSync(file, 'utf8')).name ?? dir;
      const pack = await reconcileImage({ root, spawn, every, upTo, deadline, repository, tags, roleMaps, dir, name, image: entry?.image, workflow: entry?.workflow });
      results.push(...pack.results);
      failures.push(...pack.failures);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ name, message });
      results.push({ dir, name, image: entry?.image ?? null, version: null, action: 'failed', detail: message });
      console.log(`${name}: ${message}`);
    }
  }
  summarizeImages(results);
  if (failures.length > 0) {
    const error = new Error(`the image version tags are not all in place: ${failures.map(({ name, message }) => `${name}: ${message}`).join('; ')}`);
    error.results = results;
    throw error;
  }
  return results;
}

const IMAGES_OPTIONS = {
  root: { type: 'string' },
  every: { type: 'string' },
  'up-to': { type: 'string' },
};

/** A flag's value as an amount of at least zero, or undefined when the flag is absent. */
function amountOf(text, flag, unit) {
  if (text === undefined) return undefined;
  const value = Number(text);
  if (text.trim() === '' || !Number.isFinite(value) || value < 0) throw new Error(`${flag} ${text} is not a number of ${unit}`);
  return value;
}

async function imagesCommand(args) {
  const { values } = parseArgs({ args, options: IMAGES_OPTIONS, strict: true });
  const minutes = amountOf(values['up-to'], '--up-to', 'minutes');
  await reconcileImages({
    root: path.resolve(values.root ?? REPO_ROOT),
    every: amountOf(values.every, '--every', 'seconds'),
    upTo: minutes === undefined ? undefined : minutes * 60,
  });
}

const COMMANDS = {
  plan: planCommand,
  apply: applyCommand,
  publish: publishCommand,
  tags: tagsCommand,
  images: imagesCommand,
};

async function main(argv) {
  const [command, ...args] = argv;
  if (!Object.hasOwn(COMMANDS, command ?? '')) {
    throw new Error(`unknown command "${command ?? ''}"; the commands are: ${Object.keys(COMMANDS).join(', ')}`);
  }
  await COMMANDS[command](args);
}

/** Whether this file is the one Node was asked to run, by real path, so a call through a symbolic link counts. */
function isMainModule() {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    // A publish that npm refused ends the step with npm's own exit code; every other failure with 1.
    process.exitCode = Number.isInteger(error?.exitCode) && error.exitCode > 0 ? error.exitCode : 1;
  });
}

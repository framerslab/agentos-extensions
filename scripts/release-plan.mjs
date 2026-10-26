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
// minor; any other number, 1.0.0 included, is published only when a lane
// raises package.json's version above every published one by hand. The
// newest published version is the highest of every version npm holds (the
// abbreviated package document) and every `<name>@x.y.z` tag; its commit comes
// from the tag, else from npm's gitHead, else from the provenance attestation.
// A version npm holds that neither the tag nor the package document named is
// found when the run would publish it, and the decision is made again from
// its commit. A version with no tag gets a repair record, so the release job
// makes its tag and GitHub release at the commit it was published from. Only
// the run of master's head publishes: a run of a commit master has moved past
// publishes nothing, and a commit master does not hold fails the run.
//
// What ships is the package directory less tests, specs, fixtures and the
// changelog, wherever they sit inside it; a package.json change confined to
// devDependencies ships nothing.
//
// A package's range on a sibling is read from its newest published manifest
// (what consumers hold; an earlier run may have raised it in a checkout
// master never saw), unless master changed that entry since the package's
// base commit, in which case master's text is a maintainer's intent and wins;
// a package never published takes master's text. When the range does not
// admit the sibling's version (its planned version, else its newest published
// one), the range is raised in the plan (`^v`, `~v`, `>=v` or `v` in its own
// form) and the package is planned as a patch unless already planned higher,
// until nothing changes. A `workspace:` text is never rewritten: pnpm converts
// it at pack time from the sibling's version in the checkout. devDependencies
// never plan anything. A range in a form the planner does not compare is
// admitted and named in a warning.
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
// on master) and records dryRun: true; --message-file <file>, in a dry run alone,
// is the message the squash merge will carry (the pull request's title, a blank
// line, its body): the pull request's own commits are left out of the bump and
// the subjects, and that message stands in for them. --only <dir,dir> limits the planned set
// to those directories: the packages outside it are read (their ranges enter
// the plan as siblings) and never planned, and a planned version that leaves
// an outside package's effective range is a warning, since that package's own
// run plans it. --tip, --releases and --registry are the test seams: master's
// head, the repository's release tag names (one a line), and the registry to
// read. A failure exits 1 with ::error::<message> and writes nothing.
//
// The role map scripts/package-roles.json is the one source of the package
// list: every directory whose role is pack, library, template or root, whose
// package.json exists and is not private (templates/basic-tool ships as
// @framers/agentos-template-basic-tool; the other templates are private).

import { spawnSync } from 'node:child_process';
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

/** How many registry reads run at once. */
const PARALLEL_READS = 8;

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

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
 * everything at or above it, an exact version itself alone, and a `workspace:` text everything, since pnpm writes
 * the sibling's version at pack time. Any other text is admitted: the planner does not compare it, and the caller
 * says so in a warning.
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
 * `document(name)`, `versionDocument(name, version)` and `attestation(name, version)` with the parsed document, or
 * null for a 404, and throws for any other answer. `git` answers `isAncestor(a, b)`, `holdsCommit(sha)`,
 * `changedSince(commit, dir, excludes)` (the shipped paths changed, relative to the directory),
 * `messagesSince(commit, dir, excludes)` (each commit that changed a shipped path, `{ sha, subject, body }`),
 * `fileAt(commit, file)` (a committed file's text, or null) and `entryChanged(commit, dir, siblingName)` (whether
 * the sibling's text in the package's dependencies, peerDependencies or optionalDependencies differs between the
 * package.json at `commit` and at `head`; an entry absent at one and present at the other counts as changed).
 * `message`, in a dry run, is the message the squash merge will carry (the pull request's title and body): the
 * commits since a base that `tip` does not hold are the pull request's own, which the squash replaces, so they are
 * left out, and the message stands in for them, at `head`, when the pull request's own change touched a shipped path.
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
}) {
  const plannable = packages.filter((pkg) => PLANNED_ROLES.has(pkg.role));
  const skeleton = { schema: 1, repository, head, tip, dryRun, only };
  // The message a dry run's squash merge will carry, read as one commit at head.
  const squash = message === null ? null : { sha: head, subject: String(message).split('\n')[0].trim(), body: String(message) };
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
     * request's own change (the tip's tree against the head's) touched a shipped path of the package. With no tip
     * to tell them apart, every commit is kept and the message is added.
     */
    const historySince = async (commit) => {
      const messages = await git.messagesSince(commit, pkg.dir, SHIPPED_EXCLUDES);
      if (squash === null) return messages;
      const kept = [];
      for (const record of messages) {
        if (tip === null || (await git.isAncestor(record.sha, tip))) kept.push(record);
      }
      const own = tip === null || (await git.changedSince(tip, pkg.dir, SHIPPED_EXCLUDES)).length > 0;
      return own ? [...kept, squash] : kept;
    };

    const subjectsSince = async (commit) => (await historySince(commit)).map(({ sha, subject }) => ({ sha, subject, pullRequest: pullRequestOf(subject) }));

    /** Whether package.json's only difference since `commit` lies in devDependencies, which no consumer installs. */
    const onlyDevDependenciesChanged = async (commit) => {
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
    };

    /** The version package.json named at `commit`, or null. */
    const versionAt = async (commit) => {
      try {
        return JSON.parse((await git.fileAt(commit, manifest)) ?? 'null')?.version ?? null;
      } catch {
        return null;
      }
    };

    const decideFrom = async (version, steps) => {
      if (steps > maxReanchors) {
        throw new Error(`npm holds more than ${maxReanchors} versions of ${pkg.name} after the newest one a tag or its package document names`);
      }
      const found = await commitOf(version);
      if (found === null) {
        throw new Error(`npm holds ${pkg.name}@${version}, but no tag, gitHead or provenance attestation names a commit of this repository for it`);
      }
      const { commit: baseCommit, source } = found;
      if (source !== 'tag') repair({ name: pkg.name, version, commit: baseCommit, kind: 'tag' });
      else if (!released.has(`${pkg.name}@${version}`)) repair({ name: pkg.name, version, commit: baseCommit, kind: 'release' });
      const settled = (more) => entryOf(pkg, { newest: version, baseCommit, baseSource: source, ...more });
      const nothing = (reason) => settled({ reason });
      // Publishes `planned` unless npm holds it already: a version npm holds that neither a tag nor the package
      // document named is a newer published version, and the decision is made again from its commit.
      const publishOrCount = async (planned, bump, reason, subjects) => {
        if ((await registry.versionDocument(pkg.name, planned)) !== null) return decideFrom(planned, steps + 1);
        return settled({ planned, bump, reason, subjects, named: bump === 'named' ? planned : null });
      };

      if (named !== null && compareVersions(named, version) > 0) {
        return publishOrCount(named, 'named', `package.json names ${named}, above ${pkg.name}@${version}`, await subjectsSince(baseCommit));
      }
      if (baseCommit === head) return nothing(`${pkg.name}@${version} was published from this commit`);
      if (!(await git.isAncestor(baseCommit, head))) {
        if (await git.isAncestor(head, baseCommit)) {
          older = true;
          return nothing(`this commit is older than ${baseCommit.slice(0, 8)}, which ${pkg.name}@${version} was published from`);
        }
        // Skipping here would leave every later push unpublished behind a green run.
        throw new Error(
          `${pkg.name}@${version} names ${baseCommit.slice(0, 8)} (its tag, or npm's gitHead or provenance attestation for it), ` +
            `which this commit's history does not hold; raise ${manifest}'s version above ${version} to publish from this history, ` +
            'or re-point the tag if it was moved by hand',
        );
      }
      if (named !== null && compareVersions(named, version) < 0 && (await versionAt(baseCommit)) !== named) {
        warnings.push(
          `${manifest} names ${named}, which is not above ${version}, the newest published version of ${pkg.name}; ` +
            'a version is named by raising it above every published one, so the name is ignored',
        );
      }
      const changed = await git.changedSince(baseCommit, pkg.dir, SHIPPED_EXCLUDES);
      if (changed.length === 0) return nothing(`no file the package ships changed since ${pkg.name}@${version}`);
      if (changed.length === 1 && changed[0] === 'package.json' && (await onlyDevDependenciesChanged(baseCommit))) {
        return nothing(`only devDependencies changed in package.json since ${pkg.name}@${version}, which no consumer installs`);
      }
      const messages = await historySince(baseCommit);
      const breaking = messages.some(({ body }) => isBreaking(body));
      const subjects = messages.map(({ sha, subject }) => ({ sha, subject, pullRequest: pullRequestOf(subject) }));
      return publishOrCount(
        breaking ? raiseMinor(version) : raisePatch(version),
        breaking ? 'minor' : 'patch',
        `files the package ships changed since ${pkg.name}@${version}${breaking ? ', with a breaking mark' : ''}`,
        subjects,
      );
    };

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
    // A commit older than a package's base is never planned, by the range rule included: a patch from it would
    // publish older code above the newer version.
    return { pkg, entry, document, eligible: !older };
  };

  const decided = await mapWithLimit(plannable, PARALLEL_READS, decide);

  // Step 7, the effective ranges and the dependents. Each package's range on a sibling is its newest published
  // manifest's text (what consumers hold), master's text when the entry changed since the package's base commit
  // or the package was never published. A `workspace:` text in master is never rewritten: pnpm converts it at
  // pack time from the sibling's version in the checkout after apply, so `applied` keeps that text.
  const byName = new Map(decided.map((item) => [item.pkg.name, item]));
  const seen = new Set();
  const warn = (line) => {
    if (seen.has(line)) return;
    seen.add(line);
    warnings.push(line);
  };
  const isWorkspace = (text) => text.startsWith('workspace:');
  for (const { pkg, entry, document } of decided) {
    if (entry.foreign) continue;
    const manifest = path.posix.join(pkg.dir, 'package.json');
    let published;
    const publishedManifest = async () => {
      if (published === undefined) {
        published = document?.versions?.[entry.newest] ?? (await registry.versionDocument(pkg.name, entry.newest)) ?? {};
      }
      return published;
    };
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
            const fields = await publishedManifest();
            const held = SIBLING_FIELDS.map((candidate) => fields?.[candidate]?.[sibling]).find((value) => typeof value === 'string');
            if (held === undefined) {
              source = 'master';
            } else {
              effective = held;
              source = 'published';
            }
          }
        }
        if (rangeForm(effective) === null) {
          warn(`range ${effective} on ${sibling} in ${manifest}'s ${field} is not a form the planner compares (^x.y.z, ~x.y.z, >=x.y.z, x.y.z or workspace:), so it is left as it is`);
        }
        entry.ranges.push({ field, sibling, master, effective, source, applied: isWorkspace(master) ? master : effective, raised: false });
      }
    }
  }

  // The dependents, until nothing changes: a sibling's version (planned, else its newest published one) that its
  // dependent's effective range does not admit raises the range and plans the dependent as a patch, unless it is
  // planned higher already; a dependent outside --only is a warning instead, since its own run plans it. A newly
  // planned dependent is a sibling of others, so the pass repeats. The planned patch is not probed against npm
  // here: the publish step's own read of the version set refuses a version npm gained meanwhile.
  const versionOf = (name) => {
    const item = byName.get(name);
    return item.entry.planned ?? item.entry.newest ?? null;
  };
  const notes = new Map();
  const baseReasons = new Map(decided.map(({ entry }) => [entry, entry.reason]));
  for (let pass = 0; ; pass += 1) {
    if (pass > decided.length * 3 + 3) throw new Error('the dependents did not settle: a range is raised on every pass');
    let changed = false;
    for (const { pkg, entry, eligible } of decided) {
      if (entry.foreign) continue;
      const manifest = path.posix.join(pkg.dir, 'package.json');
      for (const range of entry.ranges) {
        const version = versionOf(range.sibling);
        if (version === null || rangeAdmits(range.effective, version)) continue;
        if (!eligible || (onlySet !== null && !onlySet.has(pkg.dir))) {
          warn(
            `${pkg.name} (${manifest}) names ${range.sibling} at ${range.effective}, which does not admit ${version}; ` +
              (eligible ? 'it is outside --only, so its own run plans it' : 'this commit is older than the one it was published from, so it is not planned here'),
          );
          continue;
        }
        const applied = isWorkspace(range.master) ? range.master : raiseRange(range.effective, version);
        const note = isWorkspace(range.master)
          ? `its ${range.master} range on ${range.sibling} is packed as ^${version}, which its published range ${range.effective} does not admit`
          : `its range on ${range.sibling} is raised to ${applied}, since ${range.effective} does not admit ${version}`;
        if (!range.raised || range.applied !== applied) {
          range.applied = applied;
          range.raised = true;
          changed = true;
        }
        const own = notes.get(entry) ?? new Map();
        own.set(`${range.field} ${range.sibling}`, note);
        notes.set(entry, own);
        if (entry.planned === null && entry.newest !== null) {
          entry.planned = raisePatch(entry.newest);
          entry.bump = 'patch';
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  for (const [entry, own] of notes) entry.reason = [baseReasons.get(entry), ...own.values()].filter(Boolean).join('; ');

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
    versionDocument: async (name, version) => {
      const key = `${name}@${version}`;
      if (!versions.has(key)) {
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
          versions.set(key, { ...parsed, version, gitHead, repository: { ...(typeof parsed.repository === 'object' ? parsed.repository : {}), url } });
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
  const relative = (dir, file) => (dir === '.' ? file : path.posix.relative(dir, file));
  return {
    isAncestor: async (ancestor, commit) => gitAnswers(root, ['merge-base', '--is-ancestor', ancestor, commit]),
    holdsCommit: async (sha) => gitRun(root, ['cat-file', '-e', `${sha}^{commit}`]).status === 0,
    changedSince: async (commit, dir, patterns = SHIPPED_EXCLUDES) =>
      gitOutput(root, ['diff', '--name-only', '--no-renames', commit, head, '--', dir])
        .split('\n')
        .filter(Boolean)
        .map((file) => relative(dir, file))
        .filter((file) => isShippedPath(file, patterns)),
    messagesSince: async (commit, dir, patterns = SHIPPED_EXCLUDES) => {
      const records = gitOutput(root, ['log', '--no-renames', '--format=%x1e%H%x1f%s%x1f%B%x1f', '--name-only', `${commit}..${head}`, '--', dir]).split('\x1e');
      const messages = [];
      for (const record of records) {
        const [sha, subject, body, files = ''] = record.split('\x1f');
        if (!SHA.test(sha ?? '')) continue;
        const shipped = files
          .split('\n')
          .filter(Boolean)
          .map((file) => relative(dir, file))
          .some((file) => isShippedPath(file, patterns));
        if (shipped) messages.push({ sha, subject, body });
      }
      // git lists the newest commit first; the subjects read oldest first, as a release note does.
      return messages.reverse();
    },
    fileAt: async (commit, file) => {
      const result = gitRun(root, ['show', `${commit}:${file}`]);
      return result.status === 0 ? result.stdout : null;
    },
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
 * `messageFile`, in a dry run alone, holds the message the squash merge will carry.
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
  });
}

/** Where the plan goes: $RUNNER_TEMP/release-plan on a runner, the temporary directory elsewhere. */
const defaultOut = () => path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'release-plan');

/** Prints the decision and writes the summary table: package, from, to, bump, reason, base commit. */
function report(plan, file) {
  const lines = [];
  const planned = plan.packages.filter((entry) => entry.planned !== null);
  lines.push(plan.run.publishes ? `Publishing from ${plan.head.slice(0, 8)}: ${plan.run.reason}.` : `Publishing nothing: ${plan.run.reason}.`);
  for (const entry of planned) lines.push(`${entry.name} ${entry.newest ?? 'nothing'} -> ${entry.planned} (${entry.bump}): ${entry.reason}`);
  lines.push(`${planned.length} of ${plan.packages.length} packages planned; ${plan.repairs.length} repair(s); the plan is at ${file}.`);
  const raised = plan.packages.flatMap((entry) => entry.ranges.filter((range) => range.raised).map((range) => ({ entry, range })));
  for (const { entry, range } of raised) lines.push(`range: ${entry.name} ${range.field} ${range.sibling} ${range.effective} -> ${range.applied}`);
  for (const record of plan.repairs) lines.push(`repair: ${record.name}@${record.version} needs its ${record.kind} at ${record.commit.slice(0, 8)}`);
  for (const record of plan.foreign) lines.push(`foreign: ${record.name} is published from ${record.repository}; its copy here is not planned`);
  for (const warning of plan.warnings) lines.push(`::warning::${warning}`);
  console.log(lines.join('\n'));

  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const rows = [
    `### Release plan for ${plan.head.slice(0, 8)}${plan.dryRun ? ' (dry run)' : ''}`,
    '',
    lines[0],
    '',
    '| package | from | to | bump | reason | base commit |',
    '| --- | --- | --- | --- | --- | --- |',
    ...planned.map((entry) => `| ${entry.name} | ${entry.newest ?? ''} | ${entry.planned} | ${entry.bump} | ${entry.reason} | ${entry.baseCommit ? entry.baseCommit.slice(0, 8) : ''} |`),
    ...(planned.length === 0 ? ['| (nothing) | | | | | |'] : []),
    '',
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
  const only = values.only === undefined ? null : values.only.split(',').map((dir) => dir.trim()).filter(Boolean);
  const releases =
    values.releases === undefined
      ? undefined
      : fs
          .readFileSync(values.releases, 'utf8')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
  if (values.tip !== undefined && !SHA.test(values.tip)) throw new Error(`--tip ${values.tip} is not a commit sha`);
  const plan = await planFromRepository({
    root,
    registry: values.registry ?? REGISTRY,
    tip: values.tip,
    releases,
    dryRun: values['dry-run'],
    only,
    messageFile: values['message-file'] === undefined ? null : path.resolve(values['message-file']),
  });
  const out = path.resolve(values.out ?? defaultOut());
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, 'release-plan.json');
  fs.writeFileSync(file, `${JSON.stringify(plan, null, 2)}\n`);
  report(plan, file);
}

const COMMANDS = {
  plan: planCommand,
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
    process.exitCode = 1;
  });
}

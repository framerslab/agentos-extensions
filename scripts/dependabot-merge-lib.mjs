/**
 * The merge decision of .github/workflows/dependabot-auto-merge.yml, kept apart
 * from its GitHub API calls so that the decision can be tested.
 *
 * The workflow merges a Dependabot pull request for an npm minor or patch
 * update when every check in REQUIRED_CHECKS has succeeded on the head commit
 * and no other workflow check on that commit is pending or failed.
 */

/** Checks that must have succeeded on the head commit: CI's build job and the Links job. */
export const REQUIRED_CHECKS = ['build', 'links'];

/** Conclusions that count as passed for a workflow check outside REQUIRED_CHECKS. */
const PASSING = new Set(['success', 'skipped', 'neutral']);

/** The update types from Dependabot's commit message that the workflow merges. */
const MERGEABLE_UPDATES = new Set(['version-update:semver-minor', 'version-update:semver-patch']);

/**
 * The `update-type` values Dependabot writes into its commit message, one per
 * updated dependency (`update-type: version-update:semver-minor`).
 *
 * @param {string} message
 * @returns {string[]}
 */
export function updateTypes(message) {
  return [...String(message).matchAll(/^\s*update-type:\s*(\S+)\s*$/gm)].map((match) => match[1]);
}

/**
 * The `dependency-version` values Dependabot writes into its commit message,
 * one per updated dependency (`dependency-version: 2.9.1`).
 *
 * @param {string} message
 * @returns {string[]}
 */
export function dependencyVersions(message) {
  return [...String(message).matchAll(/^\s*dependency-version:\s*(\S+)\s*$/gm)].map((match) => match[1]);
}

/**
 * The version a single-dependency pull request title moves to
 * (`bump yaml from 2.8.2 to 2.9.1` gives `2.9.1`), or null for a title
 * without one, such as a grouped update's.
 *
 * @param {string | undefined} title
 * @returns {string | null}
 */
export function titleTargetVersion(title) {
  return / from \S+ to (\S+)/.exec(String(title ?? ''))?.[1] ?? null;
}

/**
 * The newest check run of each name that a GitHub Actions workflow created. The
 * failed `auto-merge` runs left by this workflow's old pull_request version are
 * left out: they are not CI.
 *
 * @param {object[]} checkRuns check runs from `GET /repos/{repo}/commits/{sha}/check-runs`
 * @returns {Map<string, object>}
 */
export function latestWorkflowChecks(checkRuns) {
  const latest = new Map();
  for (const run of checkRuns) {
    if (run?.app?.slug !== 'github-actions' || run.name === 'auto-merge') continue;
    const seen = latest.get(run.name);
    if (!seen || run.id > seen.id) latest.set(run.name, run);
  }
  return latest;
}

/**
 * Decides whether the workflow merges the Dependabot pull request whose head is
 * `headSha`. Every list holds all pages of its API response.
 *
 * @param {object} input
 * @param {string} input.repo `owner/name`
 * @param {string} input.headSha the commit the finished workflow run tested
 * @param {object[]} input.pulls `GET /repos/{repo}/commits/{sha}/pulls`
 * @param {object[]} input.commits `GET /repos/{repo}/pulls/{number}/commits`
 * @param {string} input.message the head commit's message
 * @param {{isResolved: boolean}[]} input.threads the pull request's review threads
 * @param {object[]} input.checkRuns `GET /repos/{repo}/commits/{sha}/check-runs`
 * @returns {{merge: boolean, pr: number | null, reason: string}}
 */
export function decideMerge({ repo, headSha, pulls, commits, message, threads, checkRuns }) {
  const pr = pulls.find(
    (pull) =>
      pull.state === 'open' &&
      pull.user?.login === 'dependabot[bot]' &&
      pull.head?.sha === headSha &&
      pull.head?.repo?.full_name === repo,
  );
  if (!pr) {
    return { merge: false, pr: null, reason: `No open Dependabot pull request from ${repo} has head ${headSha}.` };
  }
  const leave = (reason) => ({ merge: false, pr: pr.number, reason: `#${pr.number} ${reason}` });

  const authors = [...new Set(commits.map((commit) => commit.author?.login ?? 'unknown'))];
  if (authors.length === 0 || authors.some((author) => author !== 'dependabot[bot]')) {
    return leave(`has commits by ${authors.join(', ') || 'nobody'}; a maintainer merges it.`);
  }

  const types = updateTypes(message);
  if (types.length === 0) {
    return leave('names no update type in its commit message; a maintainer merges it.');
  }
  // After a rebase the head commit can keep the message of an older update: its
  // update type then describes that update, not the one the pull request makes.
  const target = titleTargetVersion(pr.title);
  const versions = dependencyVersions(message);
  if (target && versions.some((version) => version !== target)) {
    return leave(
      `has a commit message for version ${versions.join(', ')} under a title for ${target}; a maintainer merges it.`,
    );
  }
  const other = [...new Set(types.filter((type) => !MERGEABLE_UPDATES.has(type)))];
  if (other.length > 0) {
    return leave(`includes ${other.join(', ')}; a maintainer merges it.`);
  }

  const unresolved = threads.filter((thread) => !thread.isResolved).length;
  if (unresolved > 0) {
    return leave(`has ${unresolved} unresolved review thread(s); a maintainer merges it.`);
  }

  const checks = latestWorkflowChecks(checkRuns);
  for (const name of REQUIRED_CHECKS) {
    const run = checks.get(name);
    if (!run) return leave(`waits for the ${name} check, which has not started.`);
    if (run.status !== 'completed') return leave(`waits for the ${name} check (${run.status}).`);
    if (run.conclusion !== 'success') return leave(`did not pass the ${name} check (${run.conclusion}).`);
  }
  const notPassed = [...checks.values()]
    .filter((run) => run.status !== 'completed' || !PASSING.has(run.conclusion))
    .map((run) => `${run.name}: ${run.conclusion ?? run.status}`);
  if (notPassed.length > 0) {
    return leave(`has checks that have not passed (${notPassed.join(', ')}).`);
  }

  return { merge: true, pr: pr.number, reason: `Merging #${pr.number} at ${headSha}.` };
}

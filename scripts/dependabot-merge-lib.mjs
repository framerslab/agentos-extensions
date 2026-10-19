/**
 * The decision of .github/workflows/dependabot-auto-merge.yml, kept apart from
 * its GitHub API calls so that it can be tested.
 *
 * The workflow never merges a pull request and never arms GitHub's auto-merge.
 * A pull request merges only after its reviews and comments on GitHub are read,
 * each one that names a failing input fixed and the rest answered, and its
 * threads resolved (the owner's review rule); a merge made by a workflow skips
 * that pass. When every guard below has passed on a Dependabot pull request's
 * head commit, the workflow adds the LANDING_LABEL label and posts one comment
 * for that commit naming the guards, and a maintainer lands the pull request
 * under the rule. When a guard fails on a later run, the workflow takes off a
 * label it added itself; a label a person added or took off stays as they set
 * it.
 *
 * The guards: every commit is Dependabot's, the update is an npm minor or patch
 * one whose head commit message names the title's version, no review thread is
 * open, ten minutes have passed since the head was last pushed, every check in
 * REQUIRED_CHECKS has succeeded on the head commit, and no other workflow check
 * on that commit is pending or failed.
 */

/** Checks that must have succeeded on the head commit: CI's build job and the Links job. */
export const REQUIRED_CHECKS = ['build', 'links'];

/** The label the workflow adds once every guard has passed; a labelled pull request lands after its comment pass. */
export const LANDING_LABEL = 'landing';

/** The login GITHUB_TOKEN acts as: the author of the workflow's labels and comments. */
export const WORKFLOW_LOGIN = 'github-actions[bot]';

/** Conclusions that count as passed for a workflow check outside REQUIRED_CHECKS. */
const PASSING = new Set(['success', 'skipped', 'neutral']);

/** The update types from Dependabot's commit message that the workflow labels. */
const LANDABLE_UPDATES = new Set(['version-update:semver-minor', 'version-update:semver-patch']);

/**
 * How long a pull request waits after its last push before it is labelled, so
 * the reviewers on GitHub read its head first (the owner's review rule).
 */
export const QUIET_MS = 10 * 60 * 1000;

/**
 * When the pull request's head was last pushed, in milliseconds since the
 * epoch: its opening, or the latest force push of its branch, whichever is
 * later. Dependabot updates its pull request by force pushes (a rebase or a
 * recreate), and a push back to an older commit is one too, so the age of a
 * workflow run that tested the same commit before does not stand in for it.
 * NaN when neither is recorded.
 *
 * @param {{created_at?: string}} pr the pull request
 * @param {object[]} timeline `GET /repos/{repo}/issues/{number}/timeline`
 * @returns {number}
 */
export function lastPushAt(pr, timeline) {
  const stamps = [
    pr?.created_at,
    ...timeline.filter((event) => event?.event === 'head_ref_force_pushed').map((event) => event.created_at),
  ];
  const times = stamps.map((stamp) => Date.parse(stamp ?? '')).filter((time) => Number.isFinite(time));
  return times.length === 0 ? Number.NaN : Math.max(...times);
}

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
 * The marker that ties the workflow's comment to the head commit it was posted
 * for, so that each head gets one comment.
 *
 * @param {string} headSha
 * @returns {string}
 */
export function landingMarker(headSha) {
  return `<!-- dependabot-landing ${headSha} -->`;
}

/** Whether a label is the landing label; GitHub's label names are not case sensitive. */
const isLandingLabel = (label) => String(label?.name ?? '').toLowerCase() === LANDING_LABEL;

/**
 * The newest change of the landing label in the pull request's timeline, as
 * {event: 'labeled' | 'unlabeled', login}, or null when it was never set. Of
 * two changes at the same time, the later one in the timeline counts.
 *
 * @param {object[]} timeline `GET /repos/{repo}/issues/{number}/timeline`
 * @returns {{event: string, login: string} | null}
 */
export function lastLabelChange(timeline) {
  let last = null;
  let lastAt = Number.NEGATIVE_INFINITY;
  for (const event of timeline) {
    if ((event?.event !== 'labeled' && event?.event !== 'unlabeled') || !isLandingLabel(event.label)) continue;
    const at = Date.parse(event.created_at ?? '');
    if (Number.isFinite(at)) {
      if (at < lastAt) continue;
      lastAt = at;
    }
    last = { event: event.event, login: event.actor?.login ?? 'unknown' };
  }
  return last;
}

/**
 * Whether the landing label is this workflow's: the newest change of the label
 * in the timeline is this workflow adding it. The decision takes off only a
 * label this workflow added; a person who took the label off or put it on
 * since owns it.
 *
 * @param {object[]} timeline `GET /repos/{repo}/issues/{number}/timeline`
 * @returns {boolean}
 */
export function workflowOwnsLabel(timeline) {
  const change = lastLabelChange(timeline);
  return change?.event === 'labeled' && change.login === WORKFLOW_LOGIN;
}

/**
 * Whether a person changed the landing label last: the newest change of the
 * label in the timeline was made by anyone but this workflow. The workflow
 * reads the timeline again just before it takes a label off, and leaves a
 * label a person changed last as they set it. It asks about a person's change
 * rather than its own, so a label this run has only just added need not be
 * listed yet for the run to take it back off.
 *
 * @param {object[]} timeline `GET /repos/{repo}/issues/{number}/timeline`
 * @returns {boolean}
 */
export function personChangedLabelLast(timeline) {
  const change = lastLabelChange(timeline);
  return change !== null && change.login !== WORKFLOW_LOGIN;
}

/**
 * The comment the workflow posts for a head it labels: the guards that passed
 * there, and how the pull request lands from here.
 *
 * @param {object} input
 * @param {string} input.headSha the labelled head commit
 * @param {string | null} input.target the version the title moves to, null for a grouped update
 * @param {string[]} input.types the update types in the head commit's message
 * @param {number} input.ageMs the time since the head was last pushed
 * @returns {string}
 */
export function landingComment({ headSha, target, types, ageMs }) {
  const version = target ? `, and the head commit's message names the title's version, ${target}` : '';
  return [
    landingMarker(headSha),
    `Every guard of \`dependabot-auto-merge.yml\` passed on ${headSha}, so this pull request carries the \`${LANDING_LABEL}\` label:`,
    '',
    "- Every commit is Dependabot's.",
    `- The update is an npm minor or patch one (${[...new Set(types)].join(', ')})${version}.`,
    '- No review thread is open.',
    `- The head was pushed ${Math.floor(ageMs / 60000)} minutes ago; the workflow waits ten minutes after a push.`,
    `- The ${REQUIRED_CHECKS.join(' and ')} checks succeeded on this commit, and no other workflow check on it is pending or failed.`,
    '',
    'The workflow does not merge it. It lands once its review comments are read: each one that names a failing input is fixed, the rest are answered, and every thread is resolved. If a guard fails on a later run, the workflow takes off the label it added.',
  ].join('\n');
}

/**
 * Decides what the workflow does with the Dependabot pull request whose head is
 * `headSha`. Every list holds all pages of its API response.
 *
 * `land` is true when every guard passed. `label` is the change the workflow
 * makes to the landing label: 'add' when it passed and the label is missing,
 * 'remove' when a guard failed and the label is one this workflow added, null
 * otherwise. `comment` is the comment the workflow posts, once per head: null
 * when nothing passed or this head's comment is already there.
 *
 * @param {object} input
 * @param {string} input.repo `owner/name`
 * @param {string} input.headSha the commit the finished workflow run tested
 * @param {object[]} input.pulls `GET /repos/{repo}/commits/{sha}/pulls`, each with its labels
 * @param {object[]} input.commits `GET /repos/{repo}/pulls/{number}/commits`
 * @param {string} input.message the head commit's message
 * @param {{isResolved: boolean}[]} input.threads the pull request's review threads
 * @param {object[]} input.checkRuns `GET /repos/{repo}/commits/{sha}/check-runs`
 * @param {object[]} [input.timeline] `GET /repos/{repo}/issues/{number}/timeline`, for the head's last push, the
 *   landing label's changes and the workflow's comments
 * @param {number} [input.now] the time of the decision, in milliseconds since the epoch
 * @returns {{land: boolean, label: 'add' | 'remove' | null, comment: string | null, pr: number | null, reason: string}}
 */
export function decideLanding({ repo, headSha, pulls, commits, message, threads, checkRuns, timeline = [], now = Date.now() }) {
  const pr = pulls.find(
    (pull) =>
      pull.state === 'open' &&
      pull.user?.login === 'dependabot[bot]' &&
      pull.head?.sha === headSha &&
      pull.head?.repo?.full_name === repo,
  );
  if (!pr) {
    return { land: false, label: null, comment: null, pr: null, reason: `No open Dependabot pull request from ${repo} has head ${headSha}.` };
  }
  const labelled = (pr.labels ?? []).some(isLandingLabel);
  const change = lastLabelChange(timeline);
  const leave = (reason) => {
    // The label stands for the head it was added on, so one this workflow added comes off when a guard fails.
    const remove = labelled && workflowOwnsLabel(timeline);
    return {
      land: false,
      label: remove ? 'remove' : null,
      comment: null,
      pr: pr.number,
      reason: `#${pr.number} ${reason}${remove ? ` The ${LANDING_LABEL} label this workflow added comes off.` : ''}`,
    };
  };

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
  const other = [...new Set(types.filter((type) => !LANDABLE_UPDATES.has(type)))];
  if (other.length > 0) {
    return leave(`includes ${other.join(', ')}; a maintainer merges it.`);
  }

  const unresolved = threads.filter((thread) => !thread.isResolved).length;
  if (unresolved > 0) {
    return leave(`has ${unresolved} unresolved review thread(s); it is labelled once they are resolved.`);
  }

  const pushedAt = lastPushAt(pr, timeline);
  if (!Number.isFinite(pushedAt)) {
    return leave('has no recorded push time; a maintainer merges it.');
  }
  const age = now - pushedAt;
  if (age < QUIET_MS) {
    return leave(`was pushed ${Math.round(age / 1000)}s ago, under ten minutes; it is labelled once ten minutes have passed.`);
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

  // A person who took the label off withdrew the pull request; it stays off until a maintainer adds it back.
  if (!labelled && change?.event === 'unlabeled' && change.login !== WORKFLOW_LOGIN) {
    return {
      land: false,
      label: null,
      comment: null,
      pr: pr.number,
      reason: `#${pr.number} passed every guard at ${headSha}, but ${change.login} took the ${LANDING_LABEL} label off; a maintainer adds it back.`,
    };
  }

  const marker = landingMarker(headSha);
  const posted = timeline.some(
    (event) =>
      event?.event === 'commented' &&
      (event.user?.login ?? event.actor?.login) === WORKFLOW_LOGIN &&
      String(event.body ?? '').includes(marker),
  );
  return {
    land: true,
    label: labelled ? null : 'add',
    comment: posted ? null : landingComment({ headSha, target, types, ageMs: age }),
    pr: pr.number,
    reason: labelled
      ? `#${pr.number} passed every guard at ${headSha} and carries the ${LANDING_LABEL} label; it lands once its review comments are read.`
      : `#${pr.number} passed every guard at ${headSha}; it gets the ${LANDING_LABEL} label and lands once its review comments are read.`,
  };
}

/**
 * @fileoverview The issue tracker interface: its kinds, its faults, and the conformance checks over an in-memory
 * tracker that keeps the contract and trackers that break it.
 */
import { describe, expect, it } from 'vitest';
import {
  isTrackerKind, TRACKER_KINDS, TrackerFault, TrackerGrantRefused, TrackerNoAnswer, TrackerRateLimited, trackerConformance,
  type IssueDraft, type IssueRef, type IssueTracker, type TrackerDestination, type TrackerIssue,
} from '../src/index.js';

interface MemoryOptions {
  /** Answers an empty address for a created issue. */
  breakUrl?: boolean;
  /** Leaves an issue open when asked to close it. */
  noopClose?: boolean;
  /** Opens an issue in the first destination whatever destination the draft names. */
  anyDestination?: boolean;
  /** Set to make the next call answer a rate limit. */
  rateLimitNext?: { on: boolean };
}

/** A tracker over memory: two destinations, one assigned issue, issues created and closed in a map. */
function memoryTracker(options: MemoryOptions = {}): {
  tracker: IssueTracker;
  issueState: (ref: { id: string; key: string }) => Promise<'open' | 'done' | undefined>;
} {
  const destinations: TrackerDestination[] = [
    { id: 'team-1', key: 'ENG', name: 'Engineering', visibility: null, issueTypes: [] },
    { id: 'team-2', key: 'OPS', name: 'Operations', visibility: null, issueTypes: [{ id: 'task', name: 'Task' }] },
  ];
  const issues = new Map<string, TrackerIssue>([
    ['i-1', {
      id: 'i-1', key: 'ENG-1', title: 'Send the slides', url: 'https://tracker.example.invalid/ENG-1', state: 'open',
      updatedAt: '2026-11-10T12:00:00.000Z', destination: { id: 'team-1', key: 'ENG', name: 'Engineering' },
    }],
  ]);
  let made = 1;
  const limited = (): void => {
    if (options.rateLimitNext?.on) {
      options.rateLimitNext.on = false;
      throw new TrackerRateLimited(Date.now() + 5_000);
    }
  };
  const tracker: IssueTracker = {
    kind: 'linear',
    async destinations() { limited(); return destinations; },
    async assignedIssues() { limited(); return [...issues.values()].filter((issue) => issue.state === 'open'); },
    async createIssue(draft: IssueDraft): Promise<IssueRef> {
      limited();
      const destination = options.anyDestination
        ? destinations[0]
        : destinations.find((each) => each.id === draft.destinationId);
      if (destination === undefined) throw new TrackerFault('not_found', 404);
      made += 1;
      const key = `${destination.key ?? 'X'}-${made}`;
      const url = options.breakUrl ? '' : `https://tracker.example.invalid/${key}`;
      issues.set(key, {
        id: key, key, title: draft.title, url, state: 'open', updatedAt: null,
        destination: { id: destination.id, key: destination.key, name: destination.name },
      });
      return { id: key, key, url };
    },
    async closeIssue(ref) {
      limited();
      const issue = issues.get(ref.id);
      if (issue === undefined) throw new TrackerFault('not_found', 404);
      if (!options.noopClose) issues.set(ref.id, { ...issue, state: 'done' });
    },
    async revoke() { return { revoked: true }; },
  };
  return { tracker, issueState: async (ref) => issues.get(ref.id)?.state };
}

const fixture = { kind: 'linear', destinationIds: ['team-1', 'team-2'], assignedIssueKeys: ['ENG-1'] } as const;

describe('the tracker kinds and faults', () => {
  it('names the three published kinds and leaves the kind open', () => {
    expect([...TRACKER_KINDS]).toEqual(['github', 'linear', 'jira']);
    expect(Object.isFrozen(TRACKER_KINDS)).toBe(true);
    expect(isTrackerKind('jira')).toBe(true);
    expect(isTrackerKind('asana')).toBe(false);
    expect(isTrackerKind('Linear')).toBe(false);
  });

  it('carries a reason and a status and no vendor text', () => {
    const limited = new TrackerRateLimited(1_700_000_000_000);
    expect(limited.reason).toBe('rate_limited');
    expect(limited.retryAt).toBe(1_700_000_000_000);
    expect(limited.status).toBe(429);
    expect(limited).toBeInstanceOf(TrackerFault);
    expect(limited.name).toBe('TrackerRateLimited');
    expect(new TrackerRateLimited(null, 503).status).toBe(503);
    expect(new TrackerGrantRefused(401).reason).toBe('grant');
    expect(new TrackerGrantRefused(401).message).toBe('the tracker refused the call: grant (401)');
    expect(new TrackerNoAnswer('timeout').cause).toBe('timeout');
    expect(new TrackerNoAnswer('network').message).toBe('the tracker refused the call: no_answer');
    expect(new TrackerFault('refused', 403).message).toBe('the tracker refused the call: refused (403)');
  });
});

describe('the conformance checks', () => {
  it('pass over a tracker that keeps the contract, each run on its own as a test runner calls it', async () => {
    const rateLimitNext = { on: false };
    const checks = trackerConformance({
      ...memoryTracker({ rateLimitNext }),
      fixture,
      rateLimitNext: () => { rateLimitNext.on = true; },
    });
    expect(checks.map((check) => check.name)).toEqual([
      'the kind is a known tracker kind or the tracker\'s own word',
      'the destinations are the fixture\'s, each with a name and an issue type list',
      'the assigned issues are the fixture\'s open ones, each with an absolute address',
      'an issue created in the first destination has an id, a key and an absolute address',
      'closing the created issue leaves it done in the fixture, and closing it again resolves',
      'an unknown destination is refused with not_found or refused',
      'a rate-limited call throws TrackerRateLimited with a retry time or null',
      'revoke answers whether the tracker confirmed the end',
    ]);
    for (const { run } of checks) await run();
    expect(rateLimitNext.on).toBe(false);
  });

  it('fail with the check\'s name over a tracker that answers no address', async () => {
    const checks = trackerConformance({ ...memoryTracker({ breakUrl: true }), fixture });
    const run = checks.find((check) => check.name.startsWith('an issue created'))?.run;
    await expect(run?.()).rejects.toThrow('an issue created in the first destination has an id, a key and an absolute address');
  });

  it('fail the close check over a tracker whose close changes nothing', async () => {
    const checks = trackerConformance({ ...memoryTracker({ noopClose: true }), fixture });
    for (const { run } of checks.slice(0, 4)) await run();
    const run = checks.find((check) => check.name.startsWith('closing the created issue'))?.run;
    await expect(run?.()).rejects.toThrow('closing the created issue leaves it done in the fixture, and closing it again resolves: open');
  });

  it('fail the refusal check over a tracker that opens an issue in a destination it never listed', async () => {
    const checks = trackerConformance({ ...memoryTracker({ anyDestination: true }), fixture });
    const run = checks.find((check) => check.name.startsWith('an unknown destination'))?.run;
    await expect(run?.()).rejects.toThrow('an unknown destination is refused with not_found or refused: resolved');
  });

  it('fail the rate limit check over a tracker that answers through a rate limit, and skip it where the fixture cannot limit', async () => {
    const ignored = trackerConformance({ ...memoryTracker(), fixture, rateLimitNext: () => {} });
    const run = ignored.find((check) => check.name.startsWith('a rate-limited call'))?.run;
    await expect(run?.()).rejects.toThrow('a rate-limited call throws TrackerRateLimited with a retry time or null: resolved');

    const unlimited = trackerConformance({ ...memoryTracker(), fixture });
    const skipped = unlimited.find((check) => check.name.startsWith('a rate-limited call'))?.run;
    await expect(skipped?.()).resolves.toBeUndefined();
  });

  it('fail the kind check over a tracker whose kind is not the fixture\'s', async () => {
    const checks = trackerConformance({ ...memoryTracker(), fixture: { ...fixture, kind: 'jira' } });
    const run = checks[0]?.run;
    await expect(run?.()).rejects.toThrow('the kind is a known tracker kind or the tracker\'s own word: kind linear');
  });
});

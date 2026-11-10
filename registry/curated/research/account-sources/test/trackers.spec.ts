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
  /** The kind the tracker answers. */
  kind?: string;
  /** Answers an empty address for a created issue. */
  breakUrl?: boolean;
  /** Answers a plain http address for a created issue. */
  httpUrl?: boolean;
  /** Leaves an issue open when asked to close it. */
  noopClose?: boolean;
  /** Opens an issue in the first destination whatever destination the draft names. */
  anyDestination?: boolean;
  /** Opens every issue in the second destination, whatever destination the draft names. */
  misdirect?: boolean;
  /** Answers every assigned issue whatever limit the caller names. */
  ignoreLimit?: boolean;
  /** Answers a listing with a field the contract requires missing. */
  malformed?: 'destination name' | 'issue type id' | 'issue title' | 'issue destination';
  /** Rejects the destinations call as a refused grant does. */
  refuseGrant?: boolean;
  /** Set to make the next call answer a rate limit. */
  rateLimitNext?: { on: boolean };
}

/** A tracker over memory: two destinations, two assigned issues, issues created and closed in a map. */
function memoryTracker(options: MemoryOptions = {}): {
  tracker: IssueTracker;
  issueState: (ref: { id: string; key: string }) => Promise<'open' | 'done' | undefined>;
  issueDestination: (ref: { id: string; key: string }) => Promise<string | undefined>;
} {
  const destinations: TrackerDestination[] = [
    { id: 'team-1', key: 'ENG', name: 'Engineering', visibility: null, issueTypes: [] },
    { id: 'team-2', key: 'OPS', name: 'Operations', visibility: 'private', issueTypes: [{ id: 'task', name: 'Task' }] },
  ];
  const issues = new Map<string, TrackerIssue>([
    ['i-1', {
      id: 'i-1', key: 'ENG-1', title: 'Send the slides', url: 'https://tracker.example.invalid/ENG-1', state: 'open',
      updatedAt: '2026-11-10T12:00:00.000Z', destination: { id: 'team-1', key: 'ENG', name: 'Engineering' },
    }],
    ['i-2', {
      id: 'i-2', key: 'OPS-1', title: 'Book the room', url: 'https://tracker.example.invalid/OPS-1', state: 'open',
      updatedAt: '2026-11-09T12:00:00.000Z', destination: { id: 'team-2', key: 'OPS', name: 'Operations' },
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
    kind: options.kind ?? 'linear',
    async destinations() {
      limited();
      if (options.refuseGrant) throw new TrackerGrantRefused(401);
      if (options.malformed === 'destination name') {
        return [destinations[0], { ...destinations[1], name: undefined }] as unknown as TrackerDestination[];
      }
      if (options.malformed === 'issue type id') {
        return [destinations[0], { ...destinations[1], issueTypes: [{ name: 'Task' }] }] as unknown as TrackerDestination[];
      }
      return destinations;
    },
    async assignedIssues(listing) {
      limited();
      const open = [...issues.values()]
        .filter((issue) => issue.state === 'open')
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
      const answered = options.ignoreLimit || listing?.limit === undefined ? open : open.slice(0, listing.limit);
      if (options.malformed === 'issue title') {
        return answered.map(({ title: _title, ...rest }) => rest) as unknown as TrackerIssue[];
      }
      if (options.malformed === 'issue destination') {
        return answered.map(({ destination: _destination, ...rest }) => rest) as unknown as TrackerIssue[];
      }
      return answered;
    },
    async createIssue(draft: IssueDraft): Promise<IssueRef> {
      limited();
      const destination = options.misdirect
        ? destinations[1]
        : options.anyDestination
          ? destinations[0]
          : destinations.find((each) => each.id === draft.destinationId);
      if (destination === undefined) throw new TrackerFault('not_found', 404);
      made += 1;
      const key = `${destination.key ?? 'X'}-${made}`;
      const url = options.breakUrl ? '' : `${options.httpUrl ? 'http' : 'https'}://tracker.example.invalid/${key}`;
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
  return {
    tracker,
    issueState: async (ref) => issues.get(ref.id)?.state,
    issueDestination: async (ref) => issues.get(ref.id)?.destination.id,
  };
}

const fixture = { kind: 'linear', destinationIds: ['team-1', 'team-2'], assignedIssueKeys: ['ENG-1', 'OPS-1'] } as const;

/** The run of the check whose name starts with the given words. */
function runOf(checks: ReturnType<typeof trackerConformance>, start: string): (() => Promise<void>) | undefined {
  return checks.find((check) => check.name.startsWith(start))?.run;
}

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

  it('pass a later tracker\'s own kind when it is a word, and fail one that is not', async () => {
    const later = trackerConformance({ ...memoryTracker({ kind: 'asana' }), fixture: { ...fixture, kind: 'asana' } });
    await expect(later[0]?.run()).resolves.toBeUndefined();
    const hyphen = trackerConformance({ ...memoryTracker({ kind: 'my-tracker' }), fixture: { ...fixture, kind: 'my-tracker' } });
    await expect(hyphen[0]?.run()).rejects.toThrow('the kind is a known tracker kind or the tracker\'s own word: kind is no word');
  });

  it('fail the kind check over a tracker whose kind is not the fixture\'s', async () => {
    const checks = trackerConformance({ ...memoryTracker(), fixture: { ...fixture, kind: 'jira' } });
    await expect(checks[0]?.run()).rejects.toThrow('the kind is a known tracker kind or the tracker\'s own word: kind linear');
  });

  it('fail the destinations check over a listing that lacks a name or an issue type\'s id', async () => {
    for (const malformed of ['destination name', 'issue type id'] as const) {
      const run = runOf(trackerConformance({ ...memoryTracker({ malformed }), fixture }), 'the destinations');
      await expect(run?.()).rejects.toThrow('the destinations are the fixture\'s, each with a name and an issue type list: destination team-2');
    }
  });

  it('fail the assigned issues check over a listing that lacks a title or a destination', async () => {
    for (const malformed of ['issue title', 'issue destination'] as const) {
      const run = runOf(trackerConformance({ ...memoryTracker({ malformed }), fixture }), 'the assigned issues');
      await expect(run?.()).rejects.toThrow('the assigned issues are the fixture\'s open ones, each with an absolute address: issue ENG-1');
    }
  });

  it('fail the assigned issues check over a tracker that answers more issues than the limit', async () => {
    const run = runOf(trackerConformance({ ...memoryTracker({ ignoreLimit: true }), fixture }), 'the assigned issues');
    await expect(run?.()).rejects.toThrow('the assigned issues are the fixture\'s open ones, each with an absolute address: limit 1 answered 2');
  });

  it('fail with the check\'s name over a tracker that answers no address', async () => {
    const run = runOf(trackerConformance({ ...memoryTracker({ breakUrl: true }), fixture }), 'an issue created');
    await expect(run?.()).rejects.toThrow('an issue created in the first destination has an id, a key and an absolute address');
  });

  it('fail the create check over a tracker that answers a plain http address, since an issue\'s page is https', async () => {
    const run = runOf(trackerConformance({ ...memoryTracker({ httpUrl: true }), fixture }), 'an issue created');
    await expect(run?.()).rejects.toThrow('an issue created in the first destination has an id, a key and an absolute address: ref');
  });

  it('fail the create check over a tracker that opens the issue in another listed destination', async () => {
    const run = runOf(trackerConformance({ ...memoryTracker({ misdirect: true }), fixture }), 'an issue created');
    await expect(run?.()).rejects.toThrow('an issue created in the first destination has an id, a key and an absolute address: opened in team-2');
  });

  it('fail the close check over a tracker whose close changes nothing', async () => {
    const checks = trackerConformance({ ...memoryTracker({ noopClose: true }), fixture });
    for (const { run } of checks.slice(0, 4)) await run();
    const run = runOf(checks, 'closing the created issue');
    await expect(run?.()).rejects.toThrow('closing the created issue leaves it done in the fixture, and closing it again resolves: open');
  });

  it('fail the refusal check over a tracker that opens an issue in a destination it never listed', async () => {
    const run = runOf(trackerConformance({ ...memoryTracker({ anyDestination: true }), fixture }), 'an unknown destination');
    await expect(run?.()).rejects.toThrow('an unknown destination is refused with not_found or refused: resolved');
  });

  it('fail the rate limit check over a tracker that answers through a rate limit, and skip it where the fixture cannot limit', async () => {
    const run = runOf(trackerConformance({ ...memoryTracker(), fixture, rateLimitNext: () => {} }), 'a rate-limited call');
    await expect(run?.()).rejects.toThrow('a rate-limited call throws TrackerRateLimited with a retry time or null: resolved');

    const skipped = runOf(trackerConformance({ ...memoryTracker(), fixture }), 'a rate-limited call');
    await expect(skipped?.()).resolves.toBeUndefined();
  });

  it('name the check when the tracker\'s own call rejects, keeping the fault as the cause and out of the message', async () => {
    const run = runOf(trackerConformance({ ...memoryTracker({ refuseGrant: true }), fixture }), 'the destinations');
    const failure = await run?.().then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('the destinations are the fixture\'s, each with a name and an issue type list: threw TrackerGrantRefused');
    expect((failure as Error).cause).toBeInstanceOf(TrackerGrantRefused);
  });
});

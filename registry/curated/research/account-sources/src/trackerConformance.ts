/**
 * @fileoverview The checks every tracker pack's tests run over its tracker on a fixture: the kind, the destinations,
 * the assigned issues and their limit, a create in the named destination, a close, a refusal, a rate limit and the
 * revocation. Each check is a name and a function that throws an `Error` starting with the check's name when the
 * tracker breaks the contract or one of its calls rejects, so a pack runs them under its own test runner with no shared
 * dependency. A check's `run` binds nothing, so a runner may call it detached (`it(check.name, check.run)`).
 * @module agentos-ext-account-sources/trackerConformance
 */
import {
  isTrackerKindWord, TrackerFault, TrackerRateLimited,
  type IssueDraft, type IssueTracker, type TrackerDestination, type TrackerIssue,
} from './trackers.js';

/** A tracker over a fixture, and what the fixture holds. */
export interface TrackerHarness {
  /** The tracker, on a grant the fixture accepts. */
  tracker: IssueTracker;
  /** What the fixture holds, so the checks know what to expect. */
  fixture: {
    /** The kind the tracker answers. */
    kind: string;
    /** The ids of at least two destinations the fixture lists, the first one taking a new issue. */
    destinationIds: readonly string[];
    /** All open assigned keys, newest change first: at least two distinct keys with distinct update times, fitting in the default page. */
    assignedIssueKeys: readonly string[];
    /** At least one open issue assigned to someone else, present in the fixture but excluded from the assigned listing. */
    otherIssueKeys: readonly string[];
    /** At least one done issue assigned to the person, present in the fixture but excluded from the assigned listing. */
    doneIssueKeys: readonly string[];
    /** The issue type to open with in the first destination, where the tracker asks for one. */
    issueTypeId?: string;
    /** Whether the tracker has a way to end its access (a revocation endpoint), so its revoke must end the grant. */
    revocable: boolean;
  };
  /** Reads an issue's state from the fixture's own record, never through the tracker, so a close that changes nothing fails. */
  issueState: (ref: { id: string; key: string }) => Promise<'open' | 'done' | undefined>;
  /** Reads the id of the destination an issue is in from the fixture's own record, never through the tracker, so an issue opened elsewhere fails. */
  issueDestination: (ref: { id: string; key: string }) => Promise<string | undefined>;
  /** Reads the stored title and body from the fixture, decoding vendor markup to plain text with paragraph breaks intact. */
  issueText: (ref: { id: string; key: string }) => Promise<Pick<IssueDraft, 'title' | 'body'> | undefined>;
  /** Reads from the fixture's own record whether the grant was ended there, never through the tracker, so a revoke that claims an end it never made fails. */
  grantEnded: () => Promise<boolean>;
  /** Arms a rate limit and returns its expected epoch-millisecond retry time, or null when absent. Fix the clock for relative delays. */
  rateLimitNext?: () => number | null;
}

/** One check: its name, and a run that throws an `Error` starting with that name when the tracker breaks the contract. */
export interface ConformanceCheck {
  readonly name: string;
  readonly run: () => Promise<void>;
}

/** The failure a check throws: its name, a colon and the detail. */
type Failure = (detail: string) => Error;

/**
 * A check whose body throws the failure it is handed. The run closes over the name and binds no `this`. A rejection
 * the body did not make (the tracker's or the fixture's own) becomes a failure naming what was thrown, by its name
 * alone and never its message, which may carry a vendor's text, with the original as the failure's `cause`.
 */
function check(name: string, body: (failure: Failure) => Promise<void>): ConformanceCheck {
  const made = new WeakSet<Error>();
  const failure: Failure = (detail) => {
    const error = new Error(`${name}: ${detail}`);
    made.add(error);
    return error;
  };
  return {
    name,
    run: async () => {
      try {
        await body(failure);
      } catch (error) {
        if (error instanceof Error && made.has(error)) throw error;
        throw new Error(`${name}: threw ${thrownName(error)}`, { cause: error });
      }
    },
  };
}

/** True for an absolute https address. */
function absolute(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** The name of what a call threw, for a check's detail; never its message, which may carry a vendor's text. */
function thrownName(error: unknown): string {
  return error instanceof Error ? error.name : 'no fault';
}

/** True for a string with at least one character. */
function text(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** True for a key a tracker may give: a string with at least one character, or null. */
function keyOrNull(value: unknown): boolean {
  return value === null || text(value);
}

/** Whether a destination carries every field the contract requires, of the type it names. */
function wholeDestination(each: TrackerDestination): boolean {
  const value = each as Partial<Record<keyof TrackerDestination, unknown>> | null;
  if (value === null || typeof value !== 'object') return false;
  if (!text(value.id) || !text(value.name) || !keyOrNull(value.key)) return false;
  if (value.visibility !== null && value.visibility !== 'public' && value.visibility !== 'private') return false;
  if (!Array.isArray(value.issueTypes)) return false;
  return value.issueTypes.every((type: unknown) => {
    const kind = type as { id?: unknown; name?: unknown } | null;
    return kind !== null && typeof kind === 'object' && text(kind.id) && text(kind.name);
  });
}

/** Whether an assigned issue carries every field the contract requires, open, at an absolute https address. */
function wholeIssue(each: TrackerIssue): boolean {
  const value = each as Partial<Record<keyof TrackerIssue, unknown>> | null;
  if (value === null || typeof value !== 'object') return false;
  if (!text(value.id) || !text(value.key) || typeof value.title !== 'string') return false;
  if (value.state !== 'open' || !absolute(value.url)) return false;
  if (value.updatedAt !== null && (typeof value.updatedAt !== 'string' || Number.isNaN(Date.parse(value.updatedAt)))) return false;
  const destination = value.destination as { id?: unknown; key?: unknown; name?: unknown } | null | undefined;
  if (destination === null || typeof destination !== 'object') return false;
  return text(destination.id) && keyOrNull(destination.key) && typeof destination.name === 'string';
}

/**
 * The checks over a harness, in the order a pack runs them; the close check closes the issue the create check made,
 * so the create check runs before it.
 *
 * @param harness - The tracker, the fixture it runs on and the fixture's own reads.
 * @returns The eight checks, each a name and a run.
 */
export function trackerConformance(harness: TrackerHarness): ConformanceCheck[] {
  const { tracker, fixture } = harness;
  const made: { id: string; key: string } = { id: '', key: '' };
  const draft = (failure: Failure): IssueDraft => {
    const destinationId = fixture.destinationIds[0];
    if (destinationId === undefined) throw failure('the fixture names no destination');
    return {
      destinationId,
      title: 'Send the slides to the board',
      body: 'From a meeting.\n\nOpened with a conformance check.',
      ...(fixture.issueTypeId === undefined ? {} : { issueTypeId: fixture.issueTypeId }),
    };
  };
  return [
    check("the kind is a known tracker kind or the tracker's own word", async (failure) => {
      if (tracker.kind !== fixture.kind) throw failure(`kind ${tracker.kind}`);
      if (!isTrackerKindWord(tracker.kind)) throw failure('kind is no word');
    }),
    check("the destinations are the fixture's, each with a name and an issue type list", async (failure) => {
      const destinations = await tracker.destinations();
      if (!Array.isArray(destinations)) throw failure('no list');
      const ids = destinations.map((each) => each?.id);
      for (const id of fixture.destinationIds) if (!ids.includes(id)) throw failure(`missing ${id}`);
      for (const each of destinations) if (!wholeDestination(each)) throw failure(`destination ${String(each?.id)}`);
    }),
    check("the assigned issues are the fixture's open ones, each with an absolute address", async (failure) => {
      const assigned = new Set(fixture.assignedIssueKeys);
      if (assigned.size < 2 || assigned.size !== fixture.assignedIssueKeys.length) {
        throw failure('the fixture needs at least two distinct assigned issues');
      }
      if (fixture.otherIssueKeys.length === 0 || fixture.doneIssueKeys.length === 0) {
        throw failure('the fixture needs other people’s and done issues');
      }
      for (const key of [...fixture.otherIssueKeys, ...fixture.doneIssueKeys]) {
        if (assigned.has(key)) throw failure('the fixture includes an excluded issue among its assigned keys');
      }
      const issues = await tracker.assignedIssues();
      if (!Array.isArray(issues)) throw failure('no list');
      const keys = issues.map((each) => each?.key);
      for (const key of fixture.assignedIssueKeys) if (!keys.includes(key)) throw failure(`missing ${key}`);
      for (const each of issues) if (!wholeIssue(each)) throw failure(`issue ${String(each?.key)}`);
      for (const key of keys) if (!assigned.has(key)) throw failure(`unexpected issue ${String(key)}`);
      if (keys.length !== fixture.assignedIssueKeys.length || keys.some((key, index) => key !== fixture.assignedIssueKeys[index])) {
        throw failure('assigned issue order differs from the fixture');
      }
      const first = await tracker.assignedIssues({ limit: 1 });
      if (!Array.isArray(first)) throw failure('no list');
      if (first.length > 1) throw failure(`limit 1 answered ${first.length}`);
      if (first.length !== 1 || !wholeIssue(first[0]) || first[0].key !== fixture.assignedIssueKeys[0]) {
        throw failure('limit 1 did not answer the newest assigned issue');
      }
    }),
    check('an issue created in the first destination has an id, a key and an absolute address', async (failure) => {
      const input = draft(failure);
      const ref = await tracker.createIssue(input);
      if (!text(ref?.id) || !text(ref.key) || !absolute(ref.url)) {
        throw failure(`ref ${JSON.stringify({ id: ref?.id, key: ref?.key })}`);
      }
      made.id = ref.id;
      made.key = ref.key;
      const opened = await harness.issueDestination(made);
      if (opened !== input.destinationId) throw failure(`opened in ${String(opened)}`);
      const stored = await harness.issueText(made);
      if (stored === undefined || stored.title !== input.title || stored.body !== input.body) throw failure('stored draft text differs');
    }),
    check('closing the created issue leaves it done in the fixture, and closing it again resolves', async (failure) => {
      if (made.id === '') throw failure('no issue was created; run the create check first');
      await tracker.closeIssue(made);
      const first = await harness.issueState(made);
      if (first !== 'done') throw failure(String(first));
      await tracker.closeIssue(made);
      const second = await harness.issueState(made);
      if (second !== 'done') throw failure(String(second));
    }),
    check('an unknown destination is refused with not_found or refused', async (failure) => {
      // Keep every other field identical to the accepted draft, including a required issue type.
      const input = draft(failure);
      let destinationId = 'no-such-destination';
      while (fixture.destinationIds.includes(destinationId)) destinationId += '-missing';
      try {
        await tracker.createIssue({ ...input, destinationId });
      } catch (error) {
        if (error instanceof TrackerFault && (error.reason === 'not_found' || error.reason === 'refused')) return;
        throw failure(thrownName(error));
      }
      throw failure('resolved');
    }),
    check('a rate-limited call throws TrackerRateLimited with a retry time or null', async (failure) => {
      if (harness.rateLimitNext === undefined) return;
      const retryAt = harness.rateLimitNext();
      if (retryAt !== null && !Number.isFinite(retryAt)) throw failure('the fixture names no valid retry time');
      try {
        await tracker.destinations();
      } catch (error) {
        if (error instanceof TrackerRateLimited && (error.retryAt === null || Number.isFinite(error.retryAt))) {
          if (error.retryAt !== retryAt) throw failure('retry time differs from the fixture');
          return;
        }
        throw failure(thrownName(error));
      }
      throw failure('resolved');
    }),
    check('revoke ends the access where the tracker has a way to, and answers whether it did', async (failure) => {
      const answer = await tracker.revoke();
      if (typeof answer?.revoked !== 'boolean') throw failure('no boolean');
      const ended = await harness.grantEnded();
      if (fixture.revocable && !ended) throw failure('the fixture holds the grant');
      if (answer.revoked !== ended) {
        throw failure(`answered revoked ${answer.revoked}, the fixture ${ended ? 'ended' : 'holds'} the grant`);
      }
    }),
  ];
}

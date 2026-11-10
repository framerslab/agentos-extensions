/**
 * @fileoverview The checks every tracker pack's tests run over its tracker on a fixture: the kind, the destinations,
 * the assigned issues, a create, a close, a refusal, a rate limit and the revocation. Each check is a name and a
 * function that throws an `Error` starting with the check's name when the tracker breaks the contract, so a pack runs
 * them under its own test runner with no shared dependency. A check's `run` binds nothing, so a runner may call it
 * detached (`it(check.name, check.run)`).
 * @module agentos-ext-account-sources/trackerConformance
 */
import { isTrackerKind, TrackerFault, TrackerRateLimited, type IssueTracker } from './trackers.js';

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
    /** The keys of the open issues the fixture assigns to the person, at least one. */
    assignedIssueKeys: readonly string[];
    /** The issue type to open with in the first destination, where the tracker asks for one. */
    issueTypeId?: string;
  };
  /** Reads an issue's state from the fixture's own record, never through the tracker, so a close that changes nothing fails. */
  issueState: (ref: { id: string; key: string }) => Promise<'open' | 'done' | undefined>;
  /** Makes the fixture answer a rate limit to the next call; left out where the fixture cannot. */
  rateLimitNext?: () => void;
}

/** One check: its name, and a run that throws an `Error` starting with that name when the tracker breaks the contract. */
export interface ConformanceCheck {
  readonly name: string;
  readonly run: () => Promise<void>;
}

/** The failure a check throws: its name, a colon and the detail. */
type Failure = (detail: string) => Error;

/** A check whose body throws the failure it is handed; the run closes over the name and binds no `this`. */
function check(name: string, body: (failure: Failure) => Promise<void>): ConformanceCheck {
  const failure: Failure = (detail) => new Error(`${name}: ${detail}`);
  return { name, run: () => body(failure) };
}

/** True for an absolute https address. */
function absolute(url: string): boolean {
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
  return [
    check("the kind is a known tracker kind or the tracker's own word", async (failure) => {
      if (tracker.kind !== fixture.kind) throw failure(`kind ${tracker.kind}`);
      if (!isTrackerKind(tracker.kind) && !/^[a-z][a-z0-9_]{0,31}$/.test(tracker.kind)) throw failure('kind is no word');
    }),
    check("the destinations are the fixture's, each with a name and an issue type list", async (failure) => {
      const destinations = await tracker.destinations();
      const ids = destinations.map((each) => each.id);
      for (const id of fixture.destinationIds) if (!ids.includes(id)) throw failure(`missing ${id}`);
      for (const each of destinations) {
        if (each.name === '' || !Array.isArray(each.issueTypes)) throw failure(`destination ${each.id}`);
      }
    }),
    check("the assigned issues are the fixture's open ones, each with an absolute address", async (failure) => {
      const issues = await tracker.assignedIssues();
      const keys = issues.map((each) => each.key);
      for (const key of fixture.assignedIssueKeys) if (!keys.includes(key)) throw failure(`missing ${key}`);
      for (const each of issues) if (each.state !== 'open' || !absolute(each.url)) throw failure(`issue ${each.key}`);
    }),
    check('an issue created in the first destination has an id, a key and an absolute address', async (failure) => {
      const destinationId = fixture.destinationIds[0];
      if (destinationId === undefined) throw failure('the fixture names no destination');
      const ref = await tracker.createIssue({
        destinationId,
        title: 'Send the slides to the board',
        body: 'From a meeting.\n\nOpened with a conformance check.',
        ...(fixture.issueTypeId === undefined ? {} : { issueTypeId: fixture.issueTypeId }),
      });
      if (ref.id === '' || ref.key === '' || !absolute(ref.url)) {
        throw failure(`ref ${JSON.stringify({ id: ref.id, key: ref.key })}`);
      }
      made.id = ref.id;
      made.key = ref.key;
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
      try {
        await tracker.createIssue({ destinationId: 'no-such-destination', title: 'x', body: '' });
      } catch (error) {
        if (error instanceof TrackerFault && (error.reason === 'not_found' || error.reason === 'refused')) return;
        throw failure(thrownName(error));
      }
      throw failure('resolved');
    }),
    check('a rate-limited call throws TrackerRateLimited with a retry time or null', async (failure) => {
      if (harness.rateLimitNext === undefined) return;
      harness.rateLimitNext();
      try {
        await tracker.destinations();
      } catch (error) {
        if (error instanceof TrackerRateLimited && (error.retryAt === null || Number.isFinite(error.retryAt))) return;
        throw failure(thrownName(error));
      }
      throw failure('resolved');
    }),
    check('revoke answers whether the tracker confirmed the end', async (failure) => {
      const answer = await tracker.revoke();
      if (typeof answer?.revoked !== 'boolean') throw failure('no boolean');
    }),
  ];
}

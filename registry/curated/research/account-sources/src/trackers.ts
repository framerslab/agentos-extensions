/**
 * @fileoverview A person's issue tracker as a connector: where an issue can be opened, the issues assigned to the
 * person, one issue created or closed at a time, and the access ended. A tracker pack (GitHub, Linear, Jira) implements
 * `IssueTracker` over its own API and throws the faults here, which carry a reason and a status and never a vendor's
 * text, a token or a person's words. The `kind` stays an open string, as `AccountSourceConnector.kind` does, so a later
 * tracker names its own.
 * @module agentos-ext-account-sources/trackers
 */

/** The trackers the published packs connect to, as a tracker's `kind` names them. */
export const TRACKER_KINDS = Object.freeze(['github', 'linear', 'jira'] as const);

/** One of the published trackers' kinds. */
export type TrackerKind = (typeof TRACKER_KINDS)[number];

const kinds: ReadonlySet<string> = new Set(TRACKER_KINDS);

/**
 * Whether a kind is one the published tracker packs use; a later tracker's own kind answers false.
 *
 * @param kind - A tracker's kind.
 * @returns True for a kind of `TRACKER_KINDS`, compared exactly.
 */
export function isTrackerKind(kind: string): kind is TrackerKind {
  return kinds.has(kind);
}

const kindWord = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * Whether a kind is a word a tracker may answer as its own: a lower-case letter, then at most 31 lower-case letters,
 * digits or underscores, as each of `TRACKER_KINDS` is.
 *
 * @param kind - A tracker's kind.
 * @returns True for a kind of that form.
 */
export function isTrackerKindWord(kind: string): boolean {
  return kindWord.test(kind);
}

/** A kind of issue a destination takes, where the tracker asks for one (Jira's issue types). */
export interface TrackerIssueType {
  id: string;
  name: string;
}

/** Where an issue can be opened: a Linear team, a Jira project, a GitHub repository. */
export interface TrackerDestination {
  /** The tracker's own id for it. */
  id: string;
  /** Its short key where the tracker has one (a Linear team's key, a Jira project's key); null otherwise. */
  key: string | null;
  /** Its name as the tracker shows it. */
  name: string;
  /** Who can read an issue opened there, as the tracker states it; null when the tracker does not say. */
  visibility: 'public' | 'private' | null;
  /** The kinds of issue it takes, where the tracker asks for one; empty otherwise. */
  issueTypes: readonly TrackerIssueType[];
}

/** One issue of the person's, as a page lists and links it. */
export interface TrackerIssue {
  /** The tracker's own id. */
  id: string;
  /** The identifier people use: "ENG-123", "ABC-7", "#42". */
  key: string;
  title: string;
  /** The issue's own page, an absolute https address. */
  url: string;
  /** Open, or done (completed or cancelled). */
  state: 'open' | 'done';
  /** When the tracker last changed it, ISO 8601; null when the tracker does not say. */
  updatedAt: string | null;
  /** The destination it is in. */
  destination: Pick<TrackerDestination, 'id' | 'key' | 'name'>;
}

/** What an issue is opened from. */
export interface IssueDraft {
  /** The destination's id, one of `destinations()`. */
  destinationId: string;
  /** The title, at most the tracker's limit; a tracker cuts nothing and refuses what it cannot take. */
  title: string;
  /** The body as plain text, paragraphs apart by a blank line; a tracker renders it in its own form. */
  body: string;
  /** The issue type's id, for a destination whose `issueTypes` is not empty. */
  issueTypeId?: string;
}

/** An issue the tracker made. */
export interface IssueRef {
  id: string;
  key: string;
  /** The issue's own page, an absolute https address. */
  url: string;
}

/**
 * A connector to a person's issue tracker, on the person's own grant. Every call runs on that grant alone and reads
 * nothing of other people beyond what an issue's listing carries; a tracker keeps no person's id, name or address.
 *
 * A tracker is reached in one of two ways, both behind this interface: a person's OAuth grant, and a workspace's own
 * automation (Linear's client credentials grant, an Atlassian API token or service account). A pack's client takes
 * its credential from a supplier, so a pack adds the second way as a constructor when a host needs it, and no caller
 * changes.
 */
export interface IssueTracker {
  /** One of `TRACKER_KINDS`, or a later tracker's own kind, a word of the form `isTrackerKindWord` accepts. */
  readonly kind: string;
  /** The destinations the person may open an issue in. */
  destinations(signal?: AbortSignal): Promise<TrackerDestination[]>;
  /** The open issues assigned to the person, the newest change first, at most `limit` (the tracker's default page when absent). */
  assignedIssues(options?: { limit?: number; signal?: AbortSignal }): Promise<TrackerIssue[]>;
  /** Opens one issue. */
  createIssue(draft: IssueDraft, signal?: AbortSignal): Promise<IssueRef>;
  /** Moves an issue to its destination's done state; an issue already done resolves. */
  closeIssue(ref: Pick<IssueRef, 'id' | 'key'>, signal?: AbortSignal): Promise<void>;
  /** Ends the access the tracker holds, where the tracker has a way to; answers whether the tracker confirmed it. */
  revoke(): Promise<{ revoked: boolean }>;
}

/** Why a call did not go through: fixed words, never the vendor's. */
export type TrackerFaultReason =
  | 'grant'
  | 'rate_limited'
  | 'refused'
  | 'not_found'
  | 'no_answer'
  | 'invalid_response'
  | 'configuration';

/** A call the tracker refused or the pack could not make; its message names the reason and the status alone. */
export class TrackerFault extends Error {
  constructor(
    readonly reason: TrackerFaultReason,
    readonly status?: number,
  ) {
    super(`the tracker refused the call: ${reason}${status === undefined ? '' : ` (${status})`}`);
    this.name = 'TrackerFault';
  }
}

/** The tracker asked for a wait; `retryAt` is epoch milliseconds, or null when it named no time. */
export class TrackerRateLimited extends TrackerFault {
  constructor(
    readonly retryAt: number | null,
    status = 429,
  ) {
    super('rate_limited', status);
    this.name = 'TrackerRateLimited';
  }
}

/** The grant no longer opens the tracker: the token was refused, the grant revoked or its scope lost. */
export class TrackerGrantRefused extends TrackerFault {
  constructor(status?: number) {
    super('grant', status);
    this.name = 'TrackerGrantRefused';
  }
}

/** The call got no answer: its deadline passed, its caller cancelled it, or the connection failed. */
export class TrackerNoAnswer extends TrackerFault {
  constructor(readonly cause: 'timeout' | 'cancelled' | 'network') {
    super('no_answer');
    this.name = 'TrackerNoAnswer';
  }
}

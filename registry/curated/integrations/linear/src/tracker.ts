/**
 * @fileoverview Linear as the account sources library's `IssueTracker`: the person's teams as destinations, their
 * open assigned issues, one issue opened or closed at a time, and the access ended through the host's grant. Every
 * call throws the library's tracker faults.
 * @module agentos-ext-linear/tracker
 */

import {
  TrackerFault,
  type IssueDraft, type IssueRef, type IssueTracker, type TrackerDestination, type TrackerIssue,
} from '@framers/agentos-ext-account-sources';
import { LINEAR_DONE_STATE_TYPES, type LinearClient, type LinearIssue } from './client.js';
import { LinearFault } from './faults.js';
import { isObject } from './http.js';

/**
 * How the tracker ends the access: the host's `forget` of the grant's key on `LinearOAuthFlow`, which revokes the
 * grant's refresh token at Linear and clears the grant whatever Linear answers, and answers whether Linear revoked it.
 */
export type LinearRevoke = () => Promise<{ revoked: boolean }>;

/**
 * The characters that open Markdown anywhere in a line: each is escaped with a backslash, which CommonMark allows
 * before any ASCII punctuation (https://spec.commonmark.org/0.31.2/#backslash-escapes).
 */
const INLINE_MARKUP = /[\\`*_~[\]<>&|]/g;

/**
 * Plain text as Markdown that shows as written, since Linear reads an issue's description as Markdown (the schema's
 * `IssueCreateInput.description`, "The issue description in markdown format"). Lines and blank lines stay where they
 * are. In each line, the characters that open emphasis, code, strikethrough, links, tags, entities and tables are
 * escaped, and so are a leading `#`, `-`, `+` or `=` and the `.` or `)` after a leading number, which would open a
 * heading, a list or an underline. A line's leading spaces and tabs are left out, since four of them open a code block.
 *
 * @param text The plain text.
 */
function markdownOf(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => {
      const escaped = line.replace(/^[ \t]+/, '').replace(INLINE_MARKUP, '\\$&');
      if (/^[#+=-]/.test(escaped)) return `\\${escaped}`;
      return escaped.replace(/^(\d{1,9})([.)])/, '$1\\$2');
    })
    .join('\n');
}

const DONE: ReadonlySet<string> = new Set(LINEAR_DONE_STATE_TYPES);

/** An issue as the tracker interface lists it: the identifier as its key, completed, canceled or duplicate as done. */
function issueOf(issue: LinearIssue): TrackerIssue {
  return {
    id: issue.id,
    key: issue.identifier,
    title: issue.title,
    url: issue.url,
    state: DONE.has(issue.state.type) ? 'done' : 'open',
    updatedAt: issue.updatedAt,
    destination: { id: issue.team.id, key: issue.team.key, name: issue.team.name },
  };
}

/**
 * Linear as an issue tracker on a person's grant. Its destinations are the teams the person can reach, each with its
 * key and no visibility, since Linear's teams are read inside the workspace and never in public, and no issue types,
 * which Linear does not have. An issue's body goes in as its description, which Linear reads as Markdown.
 */
export class LinearTracker implements IssueTracker {
  /** The tracker's kind, one of the account sources library's `TRACKER_KINDS`. */
  readonly kind = 'linear';
  private readonly client: LinearClient;
  private readonly revokeGrant: LinearRevoke;

  /**
   * @param client The client on the person's grant.
   * @param revokeGrant Ends the grant: the host's `forget` of its key.
   * @throws LinearFault `configuration` for a client that is not an object or a revoke that is not a function.
   */
  constructor(client: LinearClient, revokeGrant: LinearRevoke) {
    if (!isObject(client) || typeof revokeGrant !== 'function') throw new LinearFault('configuration');
    this.client = client;
    this.revokeGrant = revokeGrant;
  }

  /** The teams the person can reach, at most 250. */
  async destinations(signal?: AbortSignal): Promise<TrackerDestination[]> {
    return (await this.client.teams(signal)).map((team) => ({ id: team.id, key: team.key, name: team.name, visibility: null, issueTypes: [] }));
  }

  /** The open issues assigned to the person, the newest change first; 50 when no limit is given, at most 250. */
  async assignedIssues(options: { limit?: number; signal?: AbortSignal } = {}): Promise<TrackerIssue[]> {
    return (await this.client.assignedIssues(options.limit ?? 50, options.signal)).map(issueOf);
  }

  /**
   * Opens one issue in a team: the title as it is, and the draft's plain-text body as a Markdown description that shows
   * as written. Throws `configuration` before any call for a body that is not text or a draft that names an issue type,
   * which no Linear team takes.
   */
  async createIssue(draft: IssueDraft, signal?: AbortSignal): Promise<IssueRef> {
    if (!isObject(draft) || draft.issueTypeId !== undefined || typeof draft.body !== 'string') throw new TrackerFault('configuration');
    const description = markdownOf(draft.body);
    const issue = await this.client.createIssue({ teamId: draft.destinationId, title: draft.title, description }, signal);
    return { id: issue.id, key: issue.identifier, url: issue.url };
  }

  /** Moves an issue to its team's first completed state; an issue already done is left as it is. */
  async closeIssue(ref: Pick<IssueRef, 'id' | 'key'>, signal?: AbortSignal): Promise<void> {
    if (!isObject(ref)) throw new TrackerFault('configuration');
    await this.client.closeIssue(ref.id, signal);
  }

  /** Ends the grant through the host and answers whether Linear revoked it. */
  async revoke(): Promise<{ revoked: boolean }> {
    const answer: unknown = await this.revokeGrant();
    const revoked = isObject(answer) ? answer.revoked : undefined;
    if (typeof revoked !== 'boolean') throw new TrackerFault('invalid_response');
    return { revoked };
  }
}

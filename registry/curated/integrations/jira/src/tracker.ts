/**
 * @fileoverview Jira Cloud as an issue tracker of the account sources library: the projects a person may open issues
 * in, the person's open issues, one issue opened or closed at a time, and the access ended by the host's `forget`.
 * @module agentos-ext-jira/tracker
 */

import {
  TrackerFault, type IssueDraft, type IssueRef, type IssueTracker, type TrackerDestination, type TrackerIssue,
} from '@framers/agentos-ext-account-sources';
import type { JiraClient, JiraIssue } from './client.js';

/**
 * How the tracker ends the access: the host's `JiraOAuthFlow.forget` of the grant's key, which clears the grant and
 * answers `revoked: false`, since Atlassian has no revocation endpoint and the person removes the app in their
 * Atlassian account.
 */
export type JiraRevoke = () => Promise<{ revoked: boolean }>;

/** An issue the search listed, as the tracker interface gives it: the done category is `done`, any other `open`. */
function issueOf(issue: JiraIssue): TrackerIssue {
  return {
    id: issue.id,
    key: issue.key,
    title: issue.summary,
    url: issue.url,
    state: issue.statusCategory === 'done' ? 'done' : 'open',
    updatedAt: issue.updated,
    destination: { id: issue.project.id, key: issue.project.key, name: issue.project.name },
  };
}

/** Jira Cloud as an issue tracker: the person's projects, their open issues, one issue opened or closed at a time. */
export class JiraTracker implements IssueTracker {
  readonly kind = 'jira';

  /**
   * @param client The client on the person's grant and the site they chose.
   * @param revokeGrant Ends the access, the host's `forget` of the grant's key.
   */
  constructor(
    private readonly client: JiraClient,
    private readonly revokeGrant: JiraRevoke,
  ) {}

  /** The projects the person may create issues in, each with its issue types that are not subtasks; Jira states no visibility here. */
  async destinations(signal?: AbortSignal): Promise<TrackerDestination[]> {
    return (await this.client.projects(signal)).map((project) => ({
      id: project.id,
      key: project.key,
      name: project.name,
      visibility: null,
      issueTypes: project.issueTypes.map((type) => ({ id: type.id, name: type.name })),
    }));
  }

  /** The person's open issues, the newest change first, at most `limit` (50 when absent). */
  async assignedIssues(options: { limit?: number; signal?: AbortSignal } = {}): Promise<TrackerIssue[]> {
    return (await this.client.assignedIssues(options.limit ?? 50, options.signal)).map(issueOf);
  }

  /**
   * Opens one issue in the project the draft names, of its issue type, with the title as the summary and the body as
   * the description. Jira asks for an issue type, so a draft without one is `configuration`, before a call.
   */
  async createIssue(draft: IssueDraft, signal?: AbortSignal): Promise<IssueRef> {
    if (draft.issueTypeId === undefined || draft.issueTypeId === '') throw new TrackerFault('configuration');
    return this.client.createIssue({ projectId: draft.destinationId, issueTypeId: draft.issueTypeId, summary: draft.title, description: draft.body }, signal);
  }

  /** Moves the issue to its done status by its key (its id when it has no key); an issue already done resolves. */
  async closeIssue(ref: Pick<IssueRef, 'id' | 'key'>, signal?: AbortSignal): Promise<void> {
    await this.client.closeIssue(ref.key === '' ? ref.id : ref.key, signal);
  }

  /** Ends the access through the host's `forget`; answers `revoked: false`, since Atlassian confirms no end. */
  revoke(): Promise<{ revoked: boolean }> {
    return this.revokeGrant();
  }
}

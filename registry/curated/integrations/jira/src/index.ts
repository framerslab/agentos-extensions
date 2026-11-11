/**
 * @fileoverview Jira Cloud for a host that keeps its own grant: Atlassian's OAuth 2.0 (3LO) on granular scopes on the
 * core's redirect flow (`JiraOAuthFlow`, `JIRA_SCOPES`), Jira Cloud's REST v3 through the site's cloud id
 * (`JiraClient`), plain text as Atlassian Document Format (`adfParagraphs`), and the issue tracker interface of the
 * account sources library (`JiraTracker`). A REST call's failure is one of the account sources' tracker faults; a
 * refused exchange, refresh or state is the core's `OAuthGrantRefused`; anything the pack refuses itself is a
 * `JiraFault`.
 * @module agentos-ext-jira
 */

export { adfParagraphs, type AdfDocument, type AdfHardBreak, type AdfParagraph, type AdfText } from './adf.js';
export {
  JIRA_ASSIGNED_JQL, JiraClient, type JiraAccessToken, type JiraClientOptions, type JiraIssue, type JiraIssueInput,
  type JiraIssueRef, type JiraIssueType, type JiraProject, type JiraProjectRef, type JiraSite,
} from './client.js';
export { JiraFault, type JiraFailure } from './faults.js';
export {
  JIRA_ENDPOINTS, JIRA_SCOPES, JiraOAuthFlow, type JiraEndpoints, type JiraGrantMetadata, type JiraOAuthClient,
  type JiraOAuthOptions,
} from './oauth.js';
export { JIRA_ANSWER_BYTES, JIRA_DEADLINE_MS } from './rest.js';
export { JiraTracker, type JiraRevoke } from './tracker.js';

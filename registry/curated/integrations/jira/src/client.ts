/**
 * @fileoverview Jira Cloud's REST v3 on a person's access token, through the site's cloud id
 * (`https://api.atlassian.com/ex/jira/<cloud id>/rest/api/3/...`): the sites a token reaches, the projects the person
 * may create issues in with their issue types, the open issues assigned to the person, one issue created with its
 * description in Atlassian Document Format, and one issue moved to its done status. Each call's address, fields and
 * granular scopes are the ones Jira Cloud's OpenAPI document gives
 * (https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json, read 10 November 2026). The client reads no
 * person: the issue search asks four fields (summary, status, updated, project), the project search expands the issue
 * types alone, and no account id, name, email or avatar reaches a value it answers.
 * @module agentos-ext-jira/client
 */

import { OAuthGrantRefused } from '@framers/agentos/auth';
import { TrackerFault, TrackerGrantRefused, TrackerNoAnswer, TrackerRateLimited } from '@framers/agentos-ext-account-sources';
import { adfParagraphs } from './adf.js';
import { JiraFault } from './faults.js';
import { chosenEndpoints, chosenTimeout, type JiraEndpoints } from './oauth.js';
import { credential, isObject, jiraFetch, loopbackHost, record, whenAborted, type JiraCall, type JiraTransport } from './rest.js';

/** Supplies a usable access token, such as a `JiraOAuthFlow`'s `accessToken(key)` bound by the host. */
export type JiraAccessToken = () => Promise<string>;

/** How the client reaches Jira. */
export interface JiraClientOptions {
  /** The fetch the API is called with; the global fetch when absent. */
  readonly fetchImpl?: typeof fetch;
  /** One deadline over a call: the wait for its token, the call and the reading of its answer; 15 seconds when absent. */
  readonly timeoutMs?: number;
  /** Stand-in addresses, taken only on CI (`CI=true`) at a loopback or `.invalid` host. Never take them from a request. */
  readonly endpoints?: JiraEndpoints;
}

/** A site the token reaches: its cloud id, its address and its name. */
export interface JiraSite {
  id: string;
  url: string;
  name: string;
}

/** A kind of issue a project takes. */
export interface JiraIssueType {
  id: string;
  name: string;
  subtask: boolean;
}

/** A project the person may create issues in, with the issue types that are not subtasks. */
export interface JiraProject {
  id: string;
  key: string;
  name: string;
  issueTypes: JiraIssueType[];
}

/** The project an issue is in. */
export interface JiraProjectRef {
  id: string;
  key: string;
  name: string;
}

/** An issue as the search lists it. */
export interface JiraIssue {
  id: string;
  key: string;
  summary: string;
  /** The issue's page on the site, `<site>/browse/<key>`. */
  url: string;
  /** The status category's key: `new`, `indeterminate` or `done`. */
  statusCategory: string;
  /** When the issue last changed, ISO 8601 in UTC; null when Jira gives no time it reads. */
  updated: string | null;
  project: JiraProjectRef;
}

/** What an issue is created from. */
export interface JiraIssueInput {
  projectId: string;
  issueTypeId: string;
  summary: string;
  /** Plain text, paragraphs apart by a blank line; sent as Atlassian Document Format. */
  description: string;
}

/** An issue the client created. */
export interface JiraIssueRef {
  id: string;
  key: string;
  url: string;
}

/** The search for the person's open issues, the newest change first. */
export const JIRA_ASSIGNED_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';

/** The fields the issue search asks: none of them names a person. */
const ISSUE_FIELDS = Object.freeze(['summary', 'status', 'updated', 'project']);

/** A project search page's size, Jira's default and below its maximum of 100. */
const PROJECT_PAGE = 50;

/** The most projects listed. */
const MAX_PROJECTS = 500;

/** The most issues one `assignedIssues` call lists; the JQL search's pages are asked for no more. */
const MAX_ISSUES = 100;

/** The most JQL search pages one `assignedIssues` call reads. */
const MAX_ISSUE_PAGES = 10;

/** A cloud id: one path segment of letters, digits and hyphens. */
const CLOUD_ID = /^[A-Za-z0-9-]{1,64}$/;

/** A string Jira gives for an id, a key or a name: nonempty, bounded, no control character. */
function word(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1_024 && !/[\x00-\x1f\x7f]/.test(value);
}

/** An identifier the client puts in a path or a body: a word with no whitespace. */
function identifier(value: unknown): value is string {
  return word(value) && !/\s/.test(value);
}

/** A JQL string: the value in double quotes, its backslashes and double quotes escaped. */
function jqlString(value: string): string {
  return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}

/** A site's address as its origin: HTTPS (plain HTTP at a loopback host aside), no userinfo, path, query or fragment. */
function siteOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string' || /[?#]/.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const scheme = url.protocol === 'https:' || (url.protocol === 'http:' && loopbackHost(url.hostname));
  if (!scheme || url.username !== '' || url.password !== '' || (url.pathname !== '/' && url.pathname !== '')) return undefined;
  return url.origin;
}

/** A time Jira gives (`2026-11-10T12:00:00.000+0000`) as ISO 8601 in UTC, or null. */
function isoTime(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const at = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/** The project a search or a listing names, or undefined when a field is missing. */
function projectRefOf(value: unknown): JiraProjectRef | undefined {
  const project = record(value);
  if (!identifier(project.id) || !identifier(project.key) || !word(project.name)) return undefined;
  return { id: project.id, key: project.key, name: project.name };
}

/** A project search entry with the issue types that are not subtasks, or undefined when a field is missing. */
function projectOf(value: unknown): JiraProject | undefined {
  const ref = projectRefOf(value);
  if (ref === undefined) return undefined;
  const types = record(value).issueTypes;
  const issueTypes: JiraIssueType[] = [];
  for (const each of Array.isArray(types) ? types : []) {
    const type = record(each);
    if (identifier(type.id) && word(type.name) && type.subtask !== true) issueTypes.push({ id: type.id, name: type.name, subtask: false });
  }
  return { ...ref, issueTypes };
}

/** The fetch and the deadline the options give. */
function transportOf(options: JiraClientOptions): JiraTransport {
  if (!isObject(options) || typeof options === 'function') throw new JiraFault('configuration');
  if (options.fetchImpl !== undefined && typeof options.fetchImpl !== 'function') throw new JiraFault('configuration');
  return { fetchImpl: options.fetchImpl ?? fetch, timeoutMs: chosenTimeout(options.timeoutMs) };
}

/**
 * The tracker fault a failure of the token supplier reads as. A refresh Atlassian answered 429 is
 * `TrackerRateLimited` and one it could not serve (a 5xx, or no status) a refusal that keeps the grant; any other
 * refused or missing grant is `TrackerGrantRefused`. A `JiraFault` of the flow is the tracker fault of its reason, a
 * token call with no answer `TrackerNoAnswer`; a tracker fault passes as it is, and anything else is the host's own
 * error, thrown on unchanged.
 */
function supplierFault(error: unknown): unknown {
  if (error instanceof TrackerFault) return error;
  if (error instanceof JiraFault) return error.reason === 'no_answer' ? new TrackerNoAnswer(error.noAnswer ?? 'network') : new TrackerFault(error.reason);
  if (error instanceof OAuthGrantRefused) {
    if (error.reason === 'refresh' && error.status === 429) return new TrackerRateLimited(null, 429);
    if (error.reason === 'refresh' && (error.status === undefined || error.status >= 500)) return new TrackerFault('refused', error.status);
    return new TrackerGrantRefused(error.status);
  }
  return error;
}

/** The milliseconds left before `endAt`; a deadline already passed is `TrackerNoAnswer('timeout')`. */
function leftUntil(endAt: number): number {
  const left = endAt - Date.now();
  if (left <= 0) throw new TrackerNoAnswer('timeout');
  return left;
}

/**
 * A usable access token from the supplier, waited for until the call's end time and under the caller's signal: a
 * wait the end time ends is `TrackerNoAnswer('timeout')`, one the signal ends `TrackerNoAnswer('cancelled')`, and a
 * token that is not a credential `TrackerGrantRefused`. A supplier that finds no grant (`OAuthGrantRefused` with
 * `missing`) is asked once more before the time runs out, since a flow sharing the store may have just kept a
 * refreshed grant in place of the one this flow read. The supplier's other failures read as `supplierFault` gives.
 */
async function tokenOf(accessToken: JiraAccessToken, endAt: number, signal: AbortSignal | undefined): Promise<string> {
  if (signal?.aborted === true) throw new TrackerNoAnswer('cancelled');
  const deadline = AbortSignal.timeout(leftUntil(endAt));
  const joined = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
  const aborted = whenAborted(joined, () => new TrackerNoAnswer(deadline.aborted ? 'timeout' : 'cancelled'));
  const ask = (): Promise<string> => Promise.race([Promise.resolve().then(accessToken), aborted.promise]);
  try {
    let token: unknown;
    try {
      token = await ask();
    } catch (error) {
      if (!(error instanceof OAuthGrantRefused) || error.reason !== 'missing') throw error;
      token = await ask();
    }
    if (!credential(token)) throw new TrackerGrantRefused();
    return token;
  } catch (error) {
    throw supplierFault(error);
  } finally {
    aborted.dispose();
  }
}

/** One REST call whose token wait and send share one deadline: the token by `endAt`, the call in the time left. */
async function fetchBy(accessToken: JiraAccessToken, url: string, call: JiraCall, transport: JiraTransport, signal: AbortSignal | undefined): Promise<unknown> {
  const endAt = Date.now() + transport.timeoutMs;
  const token = await tokenOf(accessToken, endAt, signal);
  return jiraFetch(token, url, call, { fetchImpl: transport.fetchImpl, timeoutMs: leftUntil(endAt) }, signal);
}

/** The issue's numeric id when `issue` names one, for the search to reconcile. */
function numericId(value: string | undefined): number | undefined {
  return value !== undefined && /^\d{1,15}$/.test(value) ? Number(value) : undefined;
}

/** Jira Cloud's REST v3 on one site, on a person's access token. */
export class JiraClient {
  private readonly transport: JiraTransport;
  private readonly base: string;
  private readonly siteUrl: string;

  /**
   * The sites the token reaches, each with its cloud id, address and name, from Atlassian's `accessible-resources`.
   * An entry without a usable cloud id, address or name is left out; the site's scopes and avatar are not kept.
   *
   * @param accessToken Supplies the access token.
   * @param options The fetch, the deadline and, on CI alone, stand-in addresses.
   * @param signal The caller's cancellation.
   */
  static async sites(accessToken: JiraAccessToken, options: JiraClientOptions = {}, signal?: AbortSignal): Promise<JiraSite[]> {
    const transport = transportOf(options);
    const endpoints = chosenEndpoints(options.endpoints);
    const answer = await fetchBy(accessToken, endpoints.resources, { method: 'GET' }, transport, signal);
    if (!Array.isArray(answer)) throw new TrackerFault('invalid_response');
    const sites: JiraSite[] = [];
    for (const each of answer) {
      const site = record(each);
      const url = siteOrigin(site.url);
      if (typeof site.id === 'string' && CLOUD_ID.test(site.id) && url !== undefined && typeof site.name === 'string') sites.push({ id: site.id, url, name: site.name });
    }
    return sites;
  }

  /**
   * @param accessToken Supplies the access token for each call.
   * @param site The site's cloud id and address, one of `JiraClient.sites`.
   * @param options The fetch, the deadline and, on CI alone, stand-in addresses.
   * @throws JiraFault `configuration` for a cloud id that is not one path segment, a site address that is not an HTTPS
   * origin, or malformed options.
   */
  constructor(
    private readonly accessToken: JiraAccessToken,
    site: Pick<JiraSite, 'id' | 'url'>,
    options: JiraClientOptions = {},
  ) {
    if (typeof accessToken !== 'function' || !isObject(site) || typeof site.id !== 'string' || !CLOUD_ID.test(site.id)) throw new JiraFault('configuration');
    const origin = siteOrigin(site.url);
    if (origin === undefined) throw new JiraFault('configuration');
    this.transport = transportOf(options);
    this.base = `${chosenEndpoints(options.endpoints).api}/${site.id}/rest/api/3`;
    this.siteUrl = origin;
  }

  /** One call to the site's REST API, the path under `/rest/api/3`. */
  private async call(method: 'GET' | 'POST', path: string, body: unknown, signal: AbortSignal | undefined): Promise<unknown> {
    return fetchBy(this.accessToken, `${this.base}${path}`, body === undefined ? { method } : { method, body }, this.transport, signal);
  }

  /** An issue's page on the site. */
  private browse(key: string): string {
    return `${this.siteUrl}/browse/${encodeURIComponent(key)}`;
  }

  /**
   * The projects the person may create issues in (`GET /project/search` with `action=create`, which lists the
   * projects where the person holds the Create issues permission), with their issue types that are not subtasks,
   * page after page until Jira says the last, a page adds none, or 500 are listed.
   */
  async projects(signal?: AbortSignal): Promise<JiraProject[]> {
    const projects: JiraProject[] = [];
    const seen = new Set<string>();
    let startAt = 0;
    for (let page = 0; page < MAX_PROJECTS / PROJECT_PAGE && projects.length < MAX_PROJECTS; page += 1) {
      const query = new URLSearchParams({ expand: 'issueTypes', action: 'create', maxResults: String(PROJECT_PAGE), startAt: String(startAt) });
      const answer = record(await this.call('GET', `/project/search?${query.toString()}`, undefined, signal));
      const values = answer.values;
      if (!Array.isArray(values)) throw new TrackerFault('invalid_response');
      for (const value of values) {
        const project = projectOf(value);
        if (project === undefined || seen.has(project.id) || projects.length >= MAX_PROJECTS) continue;
        seen.add(project.id);
        projects.push(project);
      }
      if (answer.isLast !== false || values.length === 0) break;
      startAt += values.length;
    }
    return projects;
  }

  /**
   * The open issues assigned to the person, the newest change first (`POST /search/jql` with `JIRA_ASSIGNED_JQL`), at
   * most `limit`, reading the search's pages by their token. Asks four fields, none of which names a person.
   *
   * @param limit The most issues answered, 1 to 100; 50 when absent.
   * @throws TrackerFault `configuration` for any other limit, before a call.
   */
  async assignedIssues(limit = 50, signal?: AbortSignal): Promise<JiraIssue[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ISSUES) throw new TrackerFault('configuration');
    const issues: JiraIssue[] = [];
    let nextPageToken: string | undefined;
    for (let page = 0; page < MAX_ISSUE_PAGES && issues.length < limit; page += 1) {
      const body = { jql: JIRA_ASSIGNED_JQL, fields: [...ISSUE_FIELDS], maxResults: limit - issues.length, ...(nextPageToken === undefined ? {} : { nextPageToken }) };
      const answer = record(await this.call('POST', '/search/jql', body, signal));
      if (!Array.isArray(answer.issues)) throw new TrackerFault('invalid_response');
      for (const value of answer.issues) {
        if (issues.length >= limit) break;
        const issue = this.issueOf(value);
        if (issue !== undefined) issues.push(issue);
      }
      if (answer.isLast === true || typeof answer.nextPageToken !== 'string' || answer.nextPageToken === '') break;
      nextPageToken = answer.nextPageToken;
    }
    return issues;
  }

  /** A search entry as an issue, or undefined when a field it needs is missing. */
  private issueOf(value: unknown): JiraIssue | undefined {
    const entry = record(value);
    const fields = record(entry.fields);
    const project = projectRefOf(fields.project);
    if (!identifier(entry.id) || !identifier(entry.key) || project === undefined) return undefined;
    const category = record(record(fields.status).statusCategory).key;
    return {
      id: entry.id,
      key: entry.key,
      summary: typeof fields.summary === 'string' ? fields.summary : '',
      url: this.browse(entry.key),
      statusCategory: typeof category === 'string' ? category : '',
      updated: isoTime(fields.updated),
      project,
    };
  }

  /**
   * Creates one issue (`POST /issue`) in the project, of the issue type, with the summary and the description as
   * Atlassian Document Format paragraphs; answers its id, key and page. Jira refuses a project or an issue type the
   * person cannot use with 400, which is `refused`.
   *
   * @throws TrackerFault `configuration` for an input that is not words, before a call.
   */
  async createIssue(input: JiraIssueInput, signal?: AbortSignal): Promise<JiraIssueRef> {
    if (!isObject(input) || !identifier(input.projectId) || !identifier(input.issueTypeId) || typeof input.summary !== 'string' || typeof input.description !== 'string') {
      throw new TrackerFault('configuration');
    }
    const fields = {
      project: { id: input.projectId },
      issuetype: { id: input.issueTypeId },
      summary: input.summary,
      description: adfParagraphs(input.description),
    };
    const answer = record(await this.call('POST', '/issue', { fields }, signal));
    if (!identifier(answer.id) || !identifier(answer.key)) throw new TrackerFault('invalid_response');
    return { id: answer.id, key: answer.key, url: this.browse(answer.key) };
  }

  /**
   * Moves an issue to its done status: reads its transitions (`GET /issue/<key>/transitions`), then its status. An
   * issue already in the done category resolves and is left as it is, since its workflow may offer a move to another
   * done status (Done to Won't Do) or back to its own, either of which would rewrite how it was closed. Any other
   * issue takes the available transition whose target status is in the done category, the one named Done first; with
   * none, it is `refused`. The status is read through the JQL search (`issue = "<key>"`, the status field alone), whose
   * scopes the set holds: reading the issue itself (`GET /issue/<key>`) needs granular scopes outside it, which
   * Atlassian refuses with 401. The search is eventually consistent, so the issue's numeric id, when known, is passed
   * in `reconcileIssues` for a read that follows the change which wrote the status
   * (https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/#api-rest-api-3-search-jql-post);
   * an issue the search does not find is read as not done.
   *
   * @param issue The issue's key or id, or the ref `createIssue` answered.
   */
  async closeIssue(issue: string | Pick<JiraIssueRef, 'id' | 'key'>, signal?: AbortSignal): Promise<void> {
    const ref: Partial<Pick<JiraIssueRef, 'id' | 'key'>> = typeof issue === 'string' ? { key: issue } : isObject(issue) ? issue : {};
    const key = typeof ref.key === 'string' && ref.key !== '' ? ref.key : ref.id;
    if (!identifier(key)) throw new TrackerFault('configuration');
    const id = numericId(typeof issue === 'string' ? issue : typeof ref.id === 'string' ? ref.id : undefined);
    const path = `/issue/${encodeURIComponent(key)}`;
    const answer = record(await this.call('GET', `${path}/transitions`, undefined, signal));
    if (!Array.isArray(answer.transitions)) throw new TrackerFault('invalid_response');
    const query = { jql: `issue = ${jqlString(key)}`, fields: ['status'], maxResults: 1, ...(id === undefined ? {} : { reconcileIssues: [id] }) };
    const search = record(await this.call('POST', '/search/jql', query, signal));
    if (!Array.isArray(search.issues)) throw new TrackerFault('invalid_response');
    const found = record(search.issues[0]);
    if (record(record(record(found.fields).status).statusCategory).key === 'done') return;
    const done = answer.transitions
      .map(record)
      .filter((each) => identifier(each.id) && each.isAvailable !== false && record(record(each.to).statusCategory).key === 'done');
    const chosen = done.find((each) => typeof each.name === 'string' && each.name.trim().toLowerCase() === 'done') ?? done[0];
    if (chosen === undefined) throw new TrackerFault('refused');
    await this.call('POST', `${path}/transitions`, { transition: { id: chosen.id } }, signal);
  }
}

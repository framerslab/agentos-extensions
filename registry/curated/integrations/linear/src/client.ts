/**
 * @fileoverview Linear's GraphQL API on a person's grant: the organisation's name and URL key, the teams, the open
 * issues assigned to the person, an issue opened in a team, and an issue closed by moving it to its team's first
 * completed state. Each call carries the access token the host's supplier answers, and each document asks for the
 * fields the call needs and nothing that names a person: no id, name, email or avatar of the person or of anyone else.
 * Every call throws the account sources library's tracker faults; a refused grant from the supplier is
 * `TrackerGrantRefused`, so the host knows to ask the person to connect again.
 *
 * Sources, read on 10 and 11 November 2026: Linear's schema
 * (https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql: `Viewer.assignedIssues`,
 * `IssueFilter.state`, `WorkflowState.type` of "triage", "backlog", "unstarted", "started", "completed", "canceled"
 * or "duplicate", `IssueCreateInput`, `issueUpdate`, `Team.states`), https://linear.app/developers/pagination and
 * https://linear.app/developers/filtering.
 * @module agentos-ext-linear/client
 */

import {
  TrackerFault, TrackerGrantRefused, TrackerNoAnswer, TrackerRateLimited,
} from '@framers/agentos-ext-account-sources';
import { OAuthGrantRefused } from '@framers/agentos/auth';
import { LinearFault } from './faults.js';
import { linearGraphql, LINEAR_TIMEOUT_MS } from './graphql.js';
import { credential, deadlineMs, isObject, isOptions, standInAddress } from './http.js';
import { LINEAR_ENDPOINTS } from './oauth.js';

/** The workspace a grant was made in, as the person's settings show it. */
export interface LinearOrganization {
  name: string;
  /** The workspace's key in its addresses: `https://linear.app/<urlKey>/...`. */
  urlKey: string;
}

/** A team, where an issue is opened. */
export interface LinearTeam {
  id: string;
  /** The prefix of its issues' identifiers ("ENG" for ENG-123). */
  key: string;
  name: string;
}

/** An issue as the client reads it. */
export interface LinearIssue {
  id: string;
  /** The identifier people use: "ENG-123". */
  identifier: string;
  title: string;
  /** The issue's own page, an absolute https address. */
  url: string;
  /** When Linear last changed it, ISO 8601. */
  updatedAt: string | null;
  /** Its workflow state: the name the team gave it and Linear's type for it. */
  state: { name: string; type: string };
  team: LinearTeam;
}

/** What an issue is opened from. */
export interface LinearIssueDraft {
  teamId: string;
  title: string;
  /** The description, which Linear reads as Markdown. */
  description: string;
}

/** How the client reaches Linear: the fetch, the deadline and, on CI alone, a stand-in's GraphQL address. */
export interface LinearClientOptions {
  /** The fetch every call is made with; the global fetch when absent. */
  readonly fetchImpl?: typeof fetch;
  /** How long each call may take, its answer included, in milliseconds; 30 seconds when absent. */
  readonly timeoutMs?: number;
  /** A stand-in's GraphQL address, taken only on CI (`CI=true`) at a loopback or `.invalid` host. */
  readonly endpoint?: string;
}

/** The workflow state types that mean an issue is done: finished, cancelled, or closed as a duplicate. */
export const LINEAR_DONE_STATE_TYPES = Object.freeze(['completed', 'canceled', 'duplicate'] as const);

const DONE: ReadonlySet<string> = new Set(LINEAR_DONE_STATE_TYPES);

/** The most teams read: five pages of 50. */
const TEAM_LIMIT = 250;

/** The most issues a page asks for. */
const PAGE = 50;

/** The most assigned issues read; a larger limit reads this many. */
const ASSIGNED_LIMIT = 250;

const ORGANIZATION = `query Organization { viewer { organization { name urlKey } } }`;

const TEAMS = `query Teams($after: String) { teams(first: 50, after: $after) { nodes { id key name } pageInfo { hasNextPage endCursor } } }`;

const ISSUE_FIELDS = `id identifier title url updatedAt state { name type } team { id key name }`;

const ASSIGNED_ISSUES = `query AssignedIssues($first: Int!, $after: String) {
  viewer { assignedIssues(first: $first, after: $after, orderBy: updatedAt, filter: { state: { type: { nin: ["completed", "canceled", "duplicate"] } } }) {
    nodes { ${ISSUE_FIELDS} }
    pageInfo { hasNextPage endCursor }
  } }
}`;

const CREATE_ISSUE = `mutation CreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } } }`;

const ISSUE_DONE_STATES = `query IssueDoneStates($id: String!) { issue(id: $id) { id state { type } team { states(filter: { type: { eq: "completed" } }) { nodes { id name position } } } } }`;

const CLOSE_ISSUE = `mutation CloseIssue($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success issue { id state { type } } } }`;

/** True for a string with at least one character. */
function text(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** The value at a path of object fields, or undefined where a step is not an object. */
function at(value: unknown, ...path: string[]): unknown {
  let here = value;
  for (const step of path) {
    if (!isObject(here)) return undefined;
    here = here[step];
  }
  return here;
}

/** A fault for an answer without the fields a call needs. */
function invalid(): TrackerFault {
  return new TrackerFault('invalid_response');
}

/** An absolute https address. */
function httpsAddress(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** A team as the answer gives it, its three fields checked. */
function teamOf(node: unknown): LinearTeam {
  if (!isObject(node)) throw invalid();
  const { id, key, name } = node;
  if (!text(id) || !text(key) || !text(name)) throw invalid();
  return { id, key, name };
}

/** A time Linear gives, ISO 8601, or null. */
function timeOf(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value;
  throw invalid();
}

/** An issue as the answer gives it, every field checked. */
function issueOf(node: unknown): LinearIssue {
  if (!isObject(node)) throw invalid();
  const { id, identifier, title, url, updatedAt, state, team } = node;
  if (!text(id) || !text(identifier) || typeof title !== 'string' || !httpsAddress(url) || !isObject(state)) throw invalid();
  const { name, type } = state;
  if (typeof name !== 'string' || !text(type)) throw invalid();
  return { id, identifier, title, url, updatedAt: timeOf(updatedAt), state: { name, type }, team: teamOf(team) };
}

/** A connection's nodes and whether a page follows, with the cursor to ask for it by. */
function connectionOf(value: unknown): { nodes: unknown[]; next: string | null } {
  const nodes = at(value, 'nodes');
  const hasNextPage = at(value, 'pageInfo', 'hasNextPage');
  const endCursor = at(value, 'pageInfo', 'endCursor');
  if (!Array.isArray(nodes) || typeof hasNextPage !== 'boolean') throw invalid();
  if (!hasNextPage) return { nodes, next: null };
  if (!text(endCursor)) throw invalid();
  return { nodes, next: endCursor };
}

/**
 * The fault a refusal from the host's token supplier reads as. A refused or missing grant is `TrackerGrantRefused`;
 * a refresh Linear answered 429 is `TrackerRateLimited`; a refresh Linear could not serve (a 5xx) is a refusal that
 * keeps the grant; the pack's own faults and the tracker faults pass as they are, a `LinearFault` as the tracker
 * fault of its reason; anything else is the host's own error, thrown on unchanged.
 */
function supplierFault(error: unknown): unknown {
  if (error instanceof TrackerFault) return error;
  if (error instanceof LinearFault) return new TrackerFault(error.reason);
  if (error instanceof OAuthGrantRefused) {
    if (error.reason === 'refresh' && error.status === 429) return new TrackerRateLimited(null, 429);
    if (error.reason === 'refresh' && (error.status === undefined || error.status >= 500)) return new TrackerFault('refused', error.status);
    return new TrackerGrantRefused(error.status);
  }
  return error;
}

/**
 * Linear's GraphQL API on a person's grant. It takes its access token from a supplier the host binds (the flow's
 * `accessToken(key)`), so the same client serves another credential, such as a workspace's client credentials token, by
 * the supplier alone.
 */
export class LinearClient {
  private readonly accessToken: () => Promise<string>;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly timeoutMs: number;
  private readonly endpoint: string;

  /**
   * @param accessToken Answers a usable access token for each call.
   * @param options The fetch, the deadline and, on CI alone, a stand-in's address.
   * @throws LinearFault `configuration` for a supplier that is not a function, a deadline that is not a positive whole
   * number of milliseconds up to ten minutes, an address the stand-in rule refuses, or options that are not an object.
   */
  constructor(accessToken: () => Promise<string>, options: LinearClientOptions = {}) {
    if (typeof accessToken !== 'function' || !isOptions(options)) throw new LinearFault('configuration');
    const timeoutMs = options.timeoutMs ?? LINEAR_TIMEOUT_MS;
    if (!deadlineMs(timeoutMs)) throw new LinearFault('configuration');
    if (options.fetchImpl !== undefined && typeof options.fetchImpl !== 'function') throw new LinearFault('configuration');
    this.accessToken = accessToken;
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = timeoutMs;
    this.endpoint = options.endpoint === undefined ? LINEAR_ENDPOINTS.graphql : standInAddress(options.endpoint);
  }

  /** A usable access token from the supplier, or the fault its refusal reads as. */
  private async token(): Promise<string> {
    let token: unknown;
    try {
      token = await this.accessToken();
    } catch (error) {
      throw supplierFault(error);
    }
    if (!credential(token)) throw new TrackerGrantRefused();
    return token;
  }

  /** One call: the caller's cancel first, then the token, then the document. */
  private async call(operationName: string, query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (signal?.aborted === true) throw new TrackerNoAnswer('cancelled');
    const token = await this.token();
    return linearGraphql(token, operationName, query, variables, { fetchImpl: this.fetchImpl, endpoint: this.endpoint, timeoutMs: this.timeoutMs }, signal);
  }

  /** The workspace the grant was made in: its name and URL key, and nothing of the person. */
  async organization(signal?: AbortSignal): Promise<LinearOrganization> {
    const organization = at(await this.call('Organization', ORGANIZATION, {}, signal), 'viewer', 'organization');
    const name = at(organization, 'name');
    const urlKey = at(organization, 'urlKey');
    if (!text(name) || !text(urlKey)) throw invalid();
    return { name, urlKey };
  }

  /** The teams whose issues the person can reach, 50 a page, at most 250. */
  async teams(signal?: AbortSignal): Promise<LinearTeam[]> {
    const teams: LinearTeam[] = [];
    let after: string | null = null;
    for (;;) {
      const data = await this.call('Teams', TEAMS, after === null ? {} : { after }, signal);
      const { nodes, next } = connectionOf(at(data, 'teams'));
      for (const node of nodes) {
        teams.push(teamOf(node));
        if (teams.length >= TEAM_LIMIT) return teams;
      }
      if (next === null) return teams;
      // A page that names the cursor it was asked by would be asked for again without end.
      if (next === after) throw invalid();
      after = next;
    }
  }

  /**
   * The open issues assigned to the person, the newest change first: the done state types are left out by the
   * document's filter, and no field of the assignee is asked.
   *
   * @param limit The most issues answered, a whole number from 1; a limit above 250 reads 250.
   * @param signal The caller's cancellation.
   */
  async assignedIssues(limit = PAGE, signal?: AbortSignal): Promise<LinearIssue[]> {
    if (!Number.isInteger(limit) || limit < 1) throw new TrackerFault('configuration');
    const wanted = Math.min(limit, ASSIGNED_LIMIT);
    const issues: LinearIssue[] = [];
    let after: string | null = null;
    while (issues.length < wanted) {
      const first = Math.min(PAGE, wanted - issues.length);
      const data = await this.call('AssignedIssues', ASSIGNED_ISSUES, after === null ? { first } : { first, after }, signal);
      const { nodes, next } = connectionOf(at(data, 'viewer', 'assignedIssues'));
      for (const node of nodes) {
        if (issues.length < wanted) issues.push(issueOf(node));
      }
      if (next === null || nodes.length === 0) break;
      if (next === after) throw invalid();
      after = next;
    }
    return issues;
  }

  /**
   * Opens an issue in a team. Throws `configuration` before any call for a draft without a team or a title, and
   * `refused` when Linear answers that it did not create the issue.
   */
  async createIssue(draft: LinearIssueDraft, signal?: AbortSignal): Promise<LinearIssue> {
    if (!isObject(draft)) throw new TrackerFault('configuration');
    const { teamId, title, description } = draft;
    if (!text(teamId) || !text(title) || typeof description !== 'string') throw new TrackerFault('configuration');
    const input = { teamId, title, description };
    const payload = at(await this.call('CreateIssue', CREATE_ISSUE, { input }, signal), 'issueCreate');
    if (!isObject(payload)) throw invalid();
    if (payload.success !== true) throw new TrackerFault('refused');
    return issueOf(payload.issue);
  }

  /**
   * Closes an issue: it reads the issue's state and its team's completed states, and moves the issue to the completed
   * state with the lowest position, the first a team's board shows. An issue already done (completed, canceled or
   * duplicate) is left as it is, with no write. Throws `refused` for a team with no completed state or a move Linear
   * did not make, and `not_found` when Linear finds no issue with the id.
   */
  async closeIssue(issueId: string, signal?: AbortSignal): Promise<void> {
    if (!text(issueId)) throw new TrackerFault('configuration');
    const issue = at(await this.call('IssueDoneStates', ISSUE_DONE_STATES, { id: issueId }, signal), 'issue');
    if (issue === null || issue === undefined) throw new TrackerFault('not_found');
    const type = at(issue, 'state', 'type');
    if (!text(type)) throw invalid();
    if (DONE.has(type)) return;
    const states = at(issue, 'team', 'states', 'nodes');
    if (!Array.isArray(states)) throw invalid();
    let chosen: { id: string; position: number } | null = null;
    for (const state of states) {
      const id = at(state, 'id');
      const position = at(state, 'position');
      if (!text(id) || typeof position !== 'number' || !Number.isFinite(position)) throw invalid();
      if (chosen === null || position < chosen.position) chosen = { id, position };
    }
    if (chosen === null) throw new TrackerFault('refused');
    const payload = at(await this.call('CloseIssue', CLOSE_ISSUE, { id: issueId, stateId: chosen.id }, signal), 'issueUpdate');
    if (!isObject(payload)) throw invalid();
    if (payload.success !== true) throw new TrackerFault('refused');
  }
}

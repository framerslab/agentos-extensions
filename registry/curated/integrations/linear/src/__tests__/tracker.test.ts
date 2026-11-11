/**
 * @fileoverview `LinearTracker` against the account sources library's tracker conformance checks, over a stand-in of
 * Linear that keeps a workspace in memory: two teams with their workflow states, issues assigned to the person, to
 * someone else and done, the grant the token and revocation addresses issue and end, and a rate limit armed for one
 * call. The GraphQL route reads the filter and the order the client's documents ask for, so a document that drops the
 * done states or the order fails the checks. The fixture's own reads go to the workspace, never through the tracker.
 */

import {
  TrackerFault, TrackerGrantRefused, trackerConformance, type TrackerHarness,
} from '@framers/agentos-ext-account-sources';
import { beforeAll, describe, expect, it } from 'vitest';
import { LINEAR_ENDPOINTS, LinearClient, LinearOAuthFlow, LinearTracker } from '../index.js';
import { form, graphql, json, standIn, type Seen, type Variables } from './standIn.js';
import type { IOAuthTokenStore, OAuthTokenSet } from '@framers/agentos/auth';

interface Team {
  id: string;
  key: string;
  name: string;
}

interface State {
  id: string;
  teamId: string;
  name: string;
  type: string;
  position: number;
}

interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  teamId: string;
  stateId: string;
  assignee: 'person' | 'someone else' | null;
  createdAt: string;
  updatedAt: string;
}

const DONE = new Set(['completed', 'canceled', 'duplicate']);

/** Linear's answer to a call whose bearer it does not accept. */
function unauthenticated(): Response {
  return json({ errors: [{ message: 'Authentication required, not authenticated', extensions: { type: 'authentication error', code: 'AUTHENTICATION_ERROR', userError: true } }] }, 400);
}

/** Linear's answer to an id it cannot find (the SDK's end-to-end test: "Entity not found - Could not find referenced Issue"). */
function notFound(what: 'Issue' | 'Team' | 'WorkflowState'): Response {
  return json({ errors: [{ message: 'Entity not found', extensions: { type: 'invalid input', userError: true, userPresentableMessage: `Could not find referenced ${what}` } }], data: null }, 400);
}

/** Linear's answer to an input it refuses for any other reason. */
function invalidInput(): Response {
  return json({ errors: [{ message: 'Argument Validation Error', extensions: { type: 'invalid input', userError: true } }], data: null }, 400);
}

/** Linear's answer to a document it cannot run. */
function graphqlError(): Response {
  return json({ errors: [{ message: 'Cannot query field', extensions: { type: 'graphql error', userError: true } }] }, 400);
}

/** The plain text a Markdown description shows: CommonMark's backslash escapes undone. */
function shown(markdown: string): string {
  return markdown.replace(/\\([!-/:-@[-`{-~])/g, '$1');
}

/** A Linear workspace in memory behind its token, revocation and GraphQL addresses. */
function workspace() {
  const teams: Team[] = [
    { id: 'team-eng', key: 'ENG', name: 'Engineering' },
    { id: 'team-ops', key: 'OPS', name: 'Operations' },
  ];
  const states: State[] = [
    { id: 'eng-todo', teamId: 'team-eng', name: 'Todo', type: 'unstarted', position: 0 },
    { id: 'eng-doing', teamId: 'team-eng', name: 'In Progress', type: 'started', position: 1 },
    { id: 'eng-done', teamId: 'team-eng', name: 'Done', type: 'completed', position: 3 },
    { id: 'eng-shipped', teamId: 'team-eng', name: 'Shipped', type: 'completed', position: 2 },
    { id: 'eng-canceled', teamId: 'team-eng', name: 'Canceled', type: 'canceled', position: 4 },
    { id: 'ops-todo', teamId: 'team-ops', name: 'Todo', type: 'unstarted', position: 0 },
    { id: 'ops-done', teamId: 'team-ops', name: 'Done', type: 'completed', position: 1 },
    { id: 'ops-duplicate', teamId: 'team-ops', name: 'Duplicate', type: 'duplicate', position: 2 },
  ];
  const issues = new Map<string, Issue>();
  const add = (issue: Omit<Issue, 'title' | 'description' | 'createdAt'> & { createdAt?: string }): void => {
    const { createdAt, ...rest } = issue;
    issues.set(issue.id, { ...rest, title: `Title of ${issue.identifier}`, description: '', createdAt: createdAt ?? '2026-11-01T00:00:00.000Z' });
  };
  // The person's open issues, created in the reverse of their update order, so an order by creation fails the checks.
  add({ id: 'issue-eng-1', identifier: 'ENG-1', teamId: 'team-eng', stateId: 'eng-doing', assignee: 'person', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-10T12:00:00.000Z' });
  add({ id: 'issue-ops-1', identifier: 'OPS-1', teamId: 'team-ops', stateId: 'ops-todo', assignee: 'person', createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-09T09:00:00.000Z' });
  add({ id: 'issue-eng-2', identifier: 'ENG-2', teamId: 'team-eng', stateId: 'eng-todo', assignee: 'person', createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-08T08:00:00.000Z' });
  // Someone else's open issue and the person's done ones, each changed after every open one of the person's.
  add({ id: 'issue-eng-3', identifier: 'ENG-3', teamId: 'team-eng', stateId: 'eng-todo', assignee: 'someone else', updatedAt: '2026-11-11T01:00:00.000Z' });
  add({ id: 'issue-eng-4', identifier: 'ENG-4', teamId: 'team-eng', stateId: 'eng-done', assignee: 'person', updatedAt: '2026-11-11T02:00:00.000Z' });
  add({ id: 'issue-eng-5', identifier: 'ENG-5', teamId: 'team-eng', stateId: 'eng-canceled', assignee: 'person', updatedAt: '2026-11-11T03:00:00.000Z' });
  add({ id: 'issue-ops-2', identifier: 'OPS-2', teamId: 'team-ops', stateId: 'ops-duplicate', assignee: 'person', updatedAt: '2026-11-11T04:00:00.000Z' });

  const grant = { access: '', refresh: '', ended: false, issued: 0 };
  let rateLimitAt: number | null = null;
  let clock = Date.parse('2026-11-11T05:00:00.000Z');

  const stateOf = (issue: Issue): State => {
    const state = states.find((each) => each.id === issue.stateId);
    if (state === undefined) throw new Error(`no state ${issue.stateId}`);
    return state;
  };
  const teamOf = (id: string): Team | undefined => teams.find((each) => each.id === id);
  const issueNode = (issue: Issue): Record<string, unknown> => {
    const state = stateOf(issue);
    const team = teamOf(issue.teamId);
    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      url: `https://linear.app/acme/issue/${issue.identifier}`,
      updatedAt: issue.updatedAt,
      state: { name: state.name, type: state.type },
      team,
    };
  };
  const find = (id: unknown): Issue | undefined => [...issues.values()].find((each) => each.id === id || each.identifier === id);

  /** The state types a document's `nin` filter names, read from its text as Linear reads its argument. */
  const excludedTypes = (query: string): Set<string> => {
    const match = /state:\s*\{\s*type:\s*\{\s*nin:\s*\[([^\]]*)\]/.exec(query);
    return new Set(match === null ? [] : [...match[1]!.matchAll(/"([^"]+)"/g)].map((each) => each[1]!));
  };

  /** Pages a list by `first` and an `after` cursor, the id of the last node a page gave. */
  const page = <T extends { id: string }>(list: T[], first: unknown, after: unknown): { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } => {
    const start = typeof after === 'string' ? list.findIndex((each) => each.id === after) + 1 : 0;
    const size = typeof first === 'number' ? first : 50;
    const nodes = list.slice(start, start + size);
    return { nodes, pageInfo: { hasNextPage: start + size < list.length, endCursor: nodes.at(-1)?.id ?? null } };
  };

  const operations: Record<string, (variables: Variables, query: string) => unknown> = {
    Organization: () => ({ data: { viewer: { organization: { name: 'Acme', urlKey: 'acme' } } } }),
    // One team a page, so the checks pass only when the client follows the cursor.
    Teams: (variables) => ({ data: { teams: page(teams, 1, variables.after) } }),
    AssignedIssues: (variables, query) => {
      if (!query.includes('viewer { assignedIssues(')) return graphqlError();
      const excluded = excludedTypes(query);
      const byUpdate = /orderBy:\s*updatedAt/.test(query);
      const listed = [...issues.values()]
        .filter((issue) => issue.assignee === 'person' && !excluded.has(stateOf(issue).type))
        .sort((a, b) => (byUpdate ? b.updatedAt.localeCompare(a.updatedAt) : b.createdAt.localeCompare(a.createdAt)));
      const paged = page(listed, variables.first, variables.after);
      return { data: { viewer: { assignedIssues: { nodes: paged.nodes.map(issueNode), pageInfo: paged.pageInfo } } } };
    },
    CreateIssue: (variables) => {
      const input = variables.input as { teamId?: unknown; title?: unknown; description?: unknown } | undefined;
      const team = teamOf(String(input?.teamId));
      if (team === undefined) return notFound('Team');
      if (typeof input?.title !== 'string') return invalidInput();
      const number = [...issues.values()].filter((each) => each.teamId === team.id).length + 1;
      const first = states.filter((each) => each.teamId === team.id).sort((a, b) => a.position - b.position)[0]!;
      clock += 60_000;
      const issue: Issue = {
        id: `issue-${team.key.toLowerCase()}-${number}`,
        identifier: `${team.key}-${number}`,
        title: input.title,
        description: typeof input.description === 'string' ? input.description : '',
        teamId: team.id,
        stateId: first.id,
        assignee: null,
        createdAt: new Date(clock).toISOString(),
        updatedAt: new Date(clock).toISOString(),
      };
      issues.set(issue.id, issue);
      return { data: { issueCreate: { success: true, issue: issueNode(issue) } } };
    },
    IssueDoneStates: (variables, query) => {
      const issue = find(variables.id);
      if (issue === undefined) return notFound('Issue');
      const only = /states\(filter:\s*\{\s*type:\s*\{\s*eq:\s*"([a-z]+)"/.exec(query)?.[1];
      const nodes = states
        .filter((each) => each.teamId === issue.teamId && (only === undefined || each.type === only))
        .map(({ id, name, position }) => ({ id, name, position }));
      return { data: { issue: { id: issue.id, state: { type: stateOf(issue).type }, team: { states: { nodes } } } } };
    },
    CloseIssue: (variables) => {
      const issue = find(variables.id);
      const state = states.find((each) => each.id === variables.stateId);
      if (issue === undefined) return notFound('Issue');
      if (state === undefined) return notFound('WorkflowState');
      if (state.teamId !== issue.teamId) return invalidInput();
      clock += 60_000;
      issue.stateId = state.id;
      issue.updatedAt = new Date(clock).toISOString();
      return { data: { issueUpdate: { success: true, issue: { id: issue.id, state: { type: state.type } } } } };
    },
  };

  const issueTokens = (): Response => {
    grant.issued += 1;
    grant.access = `access-${grant.issued}`;
    grant.refresh = `refresh-${grant.issued}`;
    return json({ access_token: grant.access, token_type: 'Bearer', expires_in: 86399, scope: 'read write issues:create', refresh_token: grant.refresh });
  };

  const route = (request: Seen): Response => {
    if (request.url === LINEAR_ENDPOINTS.token) {
      const body = form(request);
      if (body.get('grant_type') === 'authorization_code' && body.get('code') === 'code-1' && body.get('code_verifier') !== null) return issueTokens();
      if (body.get('grant_type') === 'refresh_token' && !grant.ended && body.get('refresh_token') === grant.refresh) return issueTokens();
      return json({ error: 'invalid_grant' }, 400);
    }
    if (request.url === LINEAR_ENDPOINTS.revoke) {
      const token = form(request).get('token');
      if (grant.ended || (token !== grant.refresh && token !== grant.access)) return json({ error: 'invalid_token' }, 400);
      grant.ended = true;
      return new Response(null, { status: 200 });
    }
    if (request.url !== LINEAR_ENDPOINTS.graphql) return json({}, 404);
    if (grant.ended || grant.access === '' || request.headers.get('authorization') !== `Bearer ${grant.access}`) return unauthenticated();
    if (rateLimitAt !== null) {
      const reset = rateLimitAt;
      rateLimitAt = null;
      return json({ errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] }, 429, {
        'x-ratelimit-requests-limit': '5000',
        'x-ratelimit-requests-remaining': '0',
        'x-ratelimit-requests-reset': String(reset),
      });
    }
    return graphql((name, variables, query) => operations[name]?.(variables, query) ?? graphqlError())(request);
  };

  return {
    issues,
    grant,
    stateOf,
    route,
    armRateLimit(reset: number): void {
      rateLimitAt = reset;
    },
  };
}

/** Grants kept in memory by key, the shape the core's `IOAuthTokenStore` asks. */
class MemoryStore implements IOAuthTokenStore {
  readonly kept = new Map<string, OAuthTokenSet>();
  async load(key: string): Promise<OAuthTokenSet | null> {
    return this.kept.get(key) ?? null;
  }
  async save(key: string, tokens: OAuthTokenSet): Promise<void> {
    this.kept.set(key, tokens);
  }
  async clear(key: string): Promise<void> {
    this.kept.delete(key);
  }
}

const redirectUri = 'https://host.example.invalid/api/v1/integrations/linear/callback';

/** A tracker on a person's grant over a fresh workspace: the flow, the client and the tracker as a host wires them. */
function connected() {
  const linear = workspace();
  const { fetchImpl, seen } = standIn(linear.route);
  const store = new MemoryStore();
  const flow = new LinearOAuthFlow({ clientId: 'client-1', clientSecret: 'secret-1' }, store, { fetchImpl });
  const client = new LinearClient(() => flow.accessToken('person-1'), { fetchImpl });
  const tracker = new LinearTracker(client, () => flow.forget('person-1'));
  const connect = async (): Promise<void> => {
    const begun = flow.begin({ redirectUri });
    const tokens = await flow.complete({ code: 'code-1', state: begun.state, expectedState: begun.state, codeVerifier: begun.codeVerifier, redirectUri });
    await flow.keep('person-1', tokens);
  };
  return { linear, seen, store, flow, client, tracker, connect };
}

describe('LinearTracker', () => {
  const setup = connected();
  const { linear, tracker } = setup;
  const recorded = (ref: { id: string; key: string }): Issue | undefined =>
    [...linear.issues.values()].find((each) => each.id === ref.id && each.identifier === ref.key);
  const harness: TrackerHarness = {
    tracker,
    fixture: {
      kind: 'linear',
      destinationIds: ['team-eng', 'team-ops'],
      assignedIssueKeys: ['ENG-1', 'OPS-1', 'ENG-2'],
      otherIssueKeys: ['ENG-3'],
      doneIssueKeys: ['ENG-4', 'ENG-5', 'OPS-2'],
      revocable: true,
    },
    issueState: async (ref) => {
      const issue = recorded(ref);
      if (issue === undefined) return undefined;
      return DONE.has(linear.stateOf(issue).type) ? 'done' : 'open';
    },
    issueDestination: async (ref) => recorded(ref)?.teamId,
    issueText: async (ref) => {
      const issue = recorded(ref);
      return issue === undefined ? undefined : { title: issue.title, body: shown(issue.description) };
    },
    grantEnded: async () => linear.grant.ended,
    rateLimitNext: () => {
      const reset = Date.parse('2026-11-11T06:00:00.000Z');
      linear.armRateLimit(reset);
      return reset;
    },
  };

  beforeAll(async () => {
    await setup.connect();
  });

  for (const check of trackerConformance(harness)) it(check.name, check.run);

  it('refuses every call after the revocation, through the cleared grant and through a token Linear has ended', async () => {
    expect(linear.grant.ended).toBe(true);
    expect(await setup.store.load('person-1')).toBeNull();
    await expect(tracker.destinations()).rejects.toBeInstanceOf(TrackerGrantRefused);
    const ended = new LinearClient(async () => linear.grant.access, { fetchImpl: standIn(linear.route).fetchImpl });
    await expect(new LinearTracker(ended, async () => ({ revoked: false })).assignedIssues()).rejects.toBeInstanceOf(TrackerGrantRefused);
  });
});

describe('LinearTracker mapping', () => {
  it('answers each team as a destination with no visibility and no issue types', async () => {
    const { fetchImpl } = standIn(graphql(() => ({ data: { teams: { nodes: [{ id: 't1', key: 'ENG', name: 'Engineering' }], pageInfo: { hasNextPage: false, endCursor: null } } } })));
    const tracker = new LinearTracker(new LinearClient(async () => 'a1', { fetchImpl }), async () => ({ revoked: true }));
    expect(tracker.kind).toBe('linear');
    expect(await tracker.destinations()).toEqual([{ id: 't1', key: 'ENG', name: 'Engineering', visibility: null, issueTypes: [] }]);
  });

  it('maps completed, canceled and duplicate states to done and every other state to open, with the identifier as the key', async () => {
    const node = (id: string, type: string) => ({
      id,
      identifier: `ENG-${id}`,
      title: `Issue ${id}`,
      url: `https://linear.app/acme/issue/ENG-${id}`,
      updatedAt: '2026-11-10T12:00:00.000Z',
      state: { name: type, type },
      team: { id: 't1', key: 'ENG', name: 'Engineering' },
    });
    const types = ['completed', 'canceled', 'duplicate', 'triage', 'backlog', 'unstarted', 'started'];
    const { fetchImpl } = standIn(graphql(() => ({ data: { viewer: { assignedIssues: { nodes: types.map((type, index) => node(String(index + 1), type)), pageInfo: { hasNextPage: false, endCursor: null } } } } })));
    const tracker = new LinearTracker(new LinearClient(async () => 'a1', { fetchImpl }), async () => ({ revoked: true }));
    const issues = await tracker.assignedIssues();
    expect(issues.map((each) => each.state)).toEqual(['done', 'done', 'done', 'open', 'open', 'open', 'open']);
    expect(issues[0]).toEqual({
      id: '1',
      key: 'ENG-1',
      title: 'Issue 1',
      url: 'https://linear.app/acme/issue/ENG-1',
      state: 'done',
      updatedAt: '2026-11-10T12:00:00.000Z',
      destination: { id: 't1', key: 'ENG', name: 'Engineering' },
    });
  });

  it('writes the plain-text body as Markdown that shows as written, and sends the title as it is', async () => {
    const { fetchImpl, seen } = standIn(graphql((_name, variables) => {
      const input = variables.input as { title: string };
      return { data: { issueCreate: { success: true, issue: { id: 'i9', identifier: 'ENG-9', title: input.title, url: 'https://linear.app/acme/issue/ENG-9', updatedAt: '2026-11-10T12:00:00.000Z', state: { name: 'Todo', type: 'unstarted' }, team: { id: 't1', key: 'ENG', name: 'Engineering' } } } } };
    }));
    const tracker = new LinearTracker(new LinearClient(async () => 'a1', { fetchImpl }), async () => ({ revoked: true }));
    const body = [
      '# Not a heading',
      '  - not a list, indented',
      '1. not an ordered list',
      '2) nor this',
      '+ plus',
      '= equals',
      '> not a quote',
      'Plain *stars*, _underscores_, `ticks`, ~tildes~ and a [link](https://example.com).',
      'Tags <b>stay</b> text, a | b, fish & chips, a back\\slash.',
      '',
      '    four spaces would be code',
    ].join('\n');
    await tracker.createIssue({ destinationId: 't1', title: 'Fix *this* now', body });
    const { input } = JSON.parse(seen[0]?.body ?? '{}').variables as { input: { title: string; description: string } };
    expect(input.title).toBe('Fix *this* now');
    expect(input.description).toBe([
      '\\# Not a heading',
      '\\- not a list, indented',
      '1\\. not an ordered list',
      '2\\) nor this',
      '\\+ plus',
      '\\= equals',
      '\\> not a quote',
      'Plain \\*stars\\*, \\_underscores\\_, \\`ticks\\`, \\~tildes\\~ and a \\[link\\](https://example.com).',
      'Tags \\<b\\>stay\\</b\\> text, a \\| b, fish \\& chips, a back\\\\slash.',
      '',
      'four spaces would be code',
    ].join('\n'));
    // Undoing the escapes gives the words back, each line without its leading spaces.
    expect(shown(input.description)).toBe(body.split('\n').map((line) => line.trimStart()).join('\n'));
  });

  it('opens an issue with the draft body as the description, and refuses an issue type, which Linear has none of, before any call', async () => {
    const { fetchImpl, seen } = standIn(graphql((_name, variables) => {
      const input = variables.input as { title: string };
      return { data: { issueCreate: { success: true, issue: { id: 'i9', identifier: 'ENG-9', title: input.title, url: 'https://linear.app/acme/issue/ENG-9', updatedAt: '2026-11-10T12:00:00.000Z', state: { name: 'Todo', type: 'unstarted' }, team: { id: 't1', key: 'ENG', name: 'Engineering' } } } } };
    }));
    const tracker = new LinearTracker(new LinearClient(async () => 'a1', { fetchImpl }), async () => ({ revoked: true }));
    expect(await tracker.createIssue({ destinationId: 't1', title: 'Send the slides', body: 'One.\n\nTwo.' })).toEqual({ id: 'i9', key: 'ENG-9', url: 'https://linear.app/acme/issue/ENG-9' });
    expect(JSON.parse(seen[0]?.body ?? '{}').variables).toEqual({ input: { teamId: 't1', title: 'Send the slides', description: 'One.\n\nTwo.' } });
    await expect(tracker.createIssue({ destinationId: 't1', title: 'T', body: '', issueTypeId: 'bug' })).rejects.toSatisfy(
      (error: unknown) => error instanceof TrackerFault && error.reason === 'configuration',
    );
    expect(seen).toHaveLength(1);
  });
});

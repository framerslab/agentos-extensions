/**
 * @fileoverview The account sources' tracker conformance checks over `JiraTracker`, on a REST stand-in that keeps a
 * Jira Cloud site in memory: two projects that take a Task, the person's open and done issues and someone else's,
 * issues created into a map with their descriptions in Atlassian Document Format, transitions by status category, a
 * rate limit armed on demand, and the grant ended by the host's `forget` of a real `JiraOAuthFlow`, which has no
 * revocation endpoint to call.
 */

import { trackerConformance, TrackerFault } from '@framers/agentos-ext-account-sources';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { JIRA_ENDPOINTS, JiraClient, JiraOAuthFlow, JiraTracker } from '../index.js';
import { adfText, json, MemoryStore, standIn, type Seen } from './standIn.js';

/** The clock the tests run on, so a relative Retry-After names a known time. */
const NOW = Date.UTC(2026, 10, 10, 15, 0, 0);
const CLOUD = 'cloud-1';
const SITE_URL = 'https://acme.atlassian.net';
const API = `${JIRA_ENDPOINTS.api}/${CLOUD}/rest/api/3`;
const JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';

type Category = 'new' | 'indeterminate' | 'done';

/** An issue as the in-memory site keeps it. */
interface SiteIssue {
  id: string;
  key: string;
  projectId: string;
  summary: string;
  description: unknown;
  category: Category;
  assignee: 'me' | 'someone' | null;
  updated: string;
}

/** A Jira Cloud site in memory, answering the REST calls the client makes and the token calls the flow makes. */
function memorySite() {
  const projects = [
    { id: '10000', key: 'ABC', name: 'Alpha', issueTypes: [{ id: '10001', name: 'Task', subtask: false }, { id: '10003', name: 'Subtask', subtask: true }] },
    { id: '10010', key: 'OPS', name: 'Operations', issueTypes: [{ id: '10001', name: 'Task', subtask: false }] },
  ];
  const issues = new Map<string, SiteIssue>();
  const add = (issue: SiteIssue) => issues.set(issue.key, issue);
  add({ id: '20001', key: 'ABC-1', projectId: '10000', summary: 'Send the slides', description: null, category: 'new', assignee: 'me', updated: '2026-11-10T12:00:00.000+0000' });
  add({ id: '20002', key: 'OPS-2', projectId: '10010', summary: 'Book the room', description: null, category: 'indeterminate', assignee: 'me', updated: '2026-11-09T12:00:00.000+0000' });
  add({ id: '20003', key: 'ABC-3', projectId: '10000', summary: 'Someone else’s', description: null, category: 'new', assignee: 'someone', updated: '2026-11-10T13:00:00.000+0000' });
  add({ id: '20004', key: 'ABC-4', projectId: '10000', summary: 'Already done', description: null, category: 'done', assignee: 'me', updated: '2026-11-10T14:00:00.000+0000' });
  let made = 100;
  const state = { rateLimitNext: false, grantEnded: false };
  const transitions = [
    { id: '11', name: 'To Do', to: { statusCategory: { key: 'new' } } },
    { id: '21', name: 'In Progress', to: { statusCategory: { key: 'indeterminate' } } },
    { id: '31', name: 'Done', to: { statusCategory: { key: 'done' } } },
  ];
  const byIdOrKey = (idOrKey: string) => issues.get(idOrKey) ?? [...issues.values()].find((each) => each.id === idOrKey);
  const projectOf = (issue: SiteIssue) => projects.find((each) => each.id === issue.projectId)!;
  const listed = (issue: SiteIssue) => ({
    id: issue.id,
    key: issue.key,
    fields: {
      summary: issue.summary,
      status: { name: issue.category, statusCategory: { key: issue.category } },
      updated: issue.updated,
      project: { id: projectOf(issue).id, key: projectOf(issue).key, name: projectOf(issue).name },
      assignee: issue.assignee === null ? null : { accountId: `account-${issue.assignee}` },
    },
  });

  const route = (request: Seen): Response => {
    if (request.headers.get('authorization') !== 'Bearer a1' && !request.url.startsWith(JIRA_ENDPOINTS.token)) return json({}, 401);
    if (state.rateLimitNext) {
      state.rateLimitNext = false;
      return json({}, 429, { 'retry-after': '7' });
    }
    if (request.url === JIRA_ENDPOINTS.token) {
      return json({ access_token: 'a1', refresh_token: 'r1', expires_in: 3600, scope: 'read:issue:jira offline_access' });
    }
    const url = new URL(request.url);
    if (!request.url.startsWith(`${API}/`)) return json({}, 404);
    const path = url.pathname.slice(new URL(API).pathname.length);
    const body = request.body === null ? {} : (JSON.parse(request.body) as Record<string, any>);
    if (request.method === 'GET' && path === '/project/search') {
      if (url.searchParams.get('action') !== 'create' || url.searchParams.get('expand') !== 'issueTypes') return json({}, 400);
      return json({ startAt: 0, maxResults: 50, total: projects.length, isLast: true, values: projects });
    }
    if (request.method === 'POST' && path === '/search/jql') {
      if (body.jql !== JQL) return json({ errorMessages: ['unexpected jql'] }, 400);
      const mine = [...issues.values()]
        .filter((each) => each.assignee === 'me' && each.category !== 'done')
        .sort((a, b) => Date.parse(b.updated.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) - Date.parse(a.updated.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')));
      return json({ issues: mine.slice(0, body.maxResults ?? 50).map(listed), isLast: true });
    }
    if (request.method === 'POST' && path === '/issue') {
      const project = projects.find((each) => each.id === body.fields?.project?.id);
      if (project === undefined) return json({ errorMessages: [], errors: { project: 'valid project is required' } }, 400);
      if (!project.issueTypes.some((type) => type.id === body.fields?.issuetype?.id && !type.subtask)) return json({ errors: { issuetype: 'invalid' } }, 400);
      made += 1;
      const issue: SiteIssue = { id: String(made), key: `${project.key}-${made}`, projectId: project.id, summary: body.fields.summary, description: body.fields.description, category: 'new', assignee: null, updated: '2026-11-10T15:00:00.000+0000' };
      add(issue);
      return json({ id: issue.id, key: issue.key, self: `${API}/issue/${issue.id}` }, 201);
    }
    const transitionsPath = /^\/issue\/([^/]+)\/transitions$/.exec(path);
    if (transitionsPath !== null) {
      const issue = byIdOrKey(decodeURIComponent(transitionsPath[1]!));
      if (issue === undefined) return json({ errorMessages: ['Issue does not exist'] }, 404);
      if (request.method === 'GET') return json({ transitions });
      const chosen = transitions.find((each) => each.id === body.transition?.id);
      if (chosen === undefined) return json({ errorMessages: ['no transition'] }, 400);
      issue.category = chosen.to.statusCategory.key as Category;
      return new Response(null, { status: 204 });
    }
    const issuePath = /^\/issue\/([^/]+)$/.exec(path);
    if (issuePath !== null && request.method === 'GET') {
      const issue = byIdOrKey(decodeURIComponent(issuePath[1]!));
      return issue === undefined ? json({}, 404) : json(listed(issue));
    }
    return json({}, 404);
  };

  return { projects, issues, state, route };
}

const site = memorySite();
const { fetchImpl, seen } = standIn(site.route);
const store = new MemoryStore();
const flow = new JiraOAuthFlow({ clientId: 'client-1', clientSecret: 'secret-1' }, store, { fetchImpl });
const client = new JiraClient(() => flow.accessToken('person-1'), { id: CLOUD, url: SITE_URL }, { fetchImpl });
const tracker = new JiraTracker(client, () => flow.forget('person-1'));
const created = (ref: { id: string; key: string }) => site.issues.get(ref.key) ?? [...site.issues.values()].find((each) => each.id === ref.id);

beforeAll(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  const begun = flow.beginJira('https://host.example.invalid/api/v1/integrations/jira/callback');
  const tokens = await flow.complete({ code: 'code-1', state: begun.state, expectedState: begun.state, codeVerifier: '', redirectUri: 'https://host.example.invalid/api/v1/integrations/jira/callback' });
  await flow.keep('person-1', tokens);
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('JiraTracker conformance', () => {
  const checks = trackerConformance({
    tracker,
    fixture: {
      kind: 'jira',
      destinationIds: ['10000', '10010'],
      assignedIssueKeys: ['ABC-1', 'OPS-2'],
      otherIssueKeys: ['ABC-3'],
      doneIssueKeys: ['ABC-4'],
      issueTypeId: '10001',
      revocable: false,
    },
    issueState: async (ref) => {
      const issue = created(ref);
      if (issue === undefined) return undefined;
      return issue.category === 'done' ? 'done' : 'open';
    },
    issueDestination: async (ref) => created(ref)?.projectId,
    issueText: async (ref) => {
      const issue = created(ref);
      const body = issue === undefined ? undefined : adfText(issue.description);
      return issue === undefined || body === undefined ? undefined : { title: issue.summary, body };
    },
    grantEnded: async () => site.state.grantEnded,
    rateLimitNext: () => {
      site.state.rateLimitNext = true;
      return NOW + 7_000;
    },
  });
  for (const check of checks) it(check.name, check.run);
});

describe('JiraTracker', () => {
  // The conformance checks ended the grant above, so these run on a client of their own with the site's token.
  const plain = new JiraTracker(new JiraClient(async () => 'a1', { id: CLOUD, url: SITE_URL }, { fetchImpl }), async () => ({ revoked: false }));

  it('answers each project as a destination with its non-subtask issue types and no visibility', async () => {
    expect(await plain.destinations()).toEqual([
      { id: '10000', key: 'ABC', name: 'Alpha', visibility: null, issueTypes: [{ id: '10001', name: 'Task' }] },
      { id: '10010', key: 'OPS', name: 'Operations', visibility: null, issueTypes: [{ id: '10001', name: 'Task' }] },
    ]);
  });

  it('maps the assigned issues with their project and an ISO time, and keeps no person', async () => {
    const issues = await plain.assignedIssues();
    expect(issues[0]).toEqual({
      id: '20001',
      key: 'ABC-1',
      title: 'Send the slides',
      url: 'https://acme.atlassian.net/browse/ABC-1',
      state: 'open',
      updatedAt: '2026-11-10T12:00:00.000Z',
      destination: { id: '10000', key: 'ABC', name: 'Alpha' },
    });
    expect(JSON.stringify(issues)).not.toContain('account-');
  });

  it('refuses an issue without an issue type before any call', async () => {
    const before = seen.length;
    await expect(plain.createIssue({ destinationId: '10000', title: 'x', body: '' })).rejects.toSatisfy(
      (error: unknown) => error instanceof TrackerFault && error.reason === 'configuration',
    );
    expect(seen.length).toBe(before);
  });

  it('ends the access by forgetting the grant: the store holds nothing and no request left for a revocation', async () => {
    expect(await store.load('person-1')).toBeNull();
    expect(seen.some((each) => /revoke/.test(each.url))).toBe(false);
    expect(site.state.grantEnded).toBe(false);
  });
});

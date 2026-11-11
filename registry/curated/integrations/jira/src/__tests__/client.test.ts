/**
 * @fileoverview Jira Cloud's REST v3 client over an HTTP stand-in: the sites a token reaches, the projects a person may
 * open issues in, the open issues assigned to the person, an issue created with its description in Atlassian Document
 * Format, an issue closed through its done transition, and each refusal as the tracker fault it is.
 */

import { OAuthGrantRefused } from '@framers/agentos/auth';
import { TrackerFault, TrackerGrantRefused, TrackerNoAnswer, TrackerRateLimited } from '@framers/agentos-ext-account-sources';
import { describe, expect, it } from 'vitest';
import { adfParagraphs, JIRA_ENDPOINTS, JiraClient, JiraFault } from '../index.js';
import { adfText, ignoresSignal, json, neverAnswers, standIn, type Seen } from './standIn.js';

const token = async () => 'a1';
const site = { id: 'cloud-1', url: 'https://acme.atlassian.net' };
const base = 'https://api.atlassian.com/ex/jira/cloud-1/rest/api/3';

/** A request's method and path with its query, as the client sent it. */
function line(request: Seen | undefined): string {
  if (request === undefined) return '';
  const url = new URL(request.url);
  return `${request.method} ${url.pathname}${url.search}`;
}

/** An answer's fault, or the value when it resolved. */
async function outcome(work: Promise<unknown>): Promise<unknown> {
  try {
    return await work;
  } catch (error) {
    return error;
  }
}

describe('adfParagraphs', () => {
  it('makes one paragraph per blank-line part and a hard break per line break inside one', () => {
    expect(adfParagraphs('Send the slides.\n\nSaid at 10:04.')).toEqual({
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Send the slides.' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Said at 10:04.' }] },
      ],
    });
    expect(adfParagraphs('first line\nsecond line')).toEqual({
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first line' }, { type: 'hardBreak' }, { type: 'text', text: 'second line' }] }],
    });
  });

  it('reads Windows line ends and blank lines of spaces as breaks, and keeps no empty text node', () => {
    const document = adfParagraphs('  one\r\n \r\n\r\ntwo\r\n\r\n');
    expect(document.content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'one' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'two' }] },
    ]);
    expect(JSON.stringify(adfParagraphs('a\n\n\n\nb\n'))).not.toContain('"text":""');
  });

  it('answers one empty paragraph for an empty text, and reads back to the text it was made from', () => {
    expect(adfParagraphs('')).toEqual({ type: 'doc', version: 1, content: [{ type: 'paragraph' }] });
    expect(adfParagraphs('  \n \n')).toEqual({ type: 'doc', version: 1, content: [{ type: 'paragraph' }] });
    const text = 'From a meeting.\n\nThe second part\nwith a line break.';
    expect(adfText(adfParagraphs(text))).toBe(text);
  });
});

describe('JiraClient', () => {
  it('reads the sites the token reaches from accessible-resources and keeps id, url and name', async () => {
    const { fetchImpl, seen } = standIn(() => json([
      { id: 'cloud-1', url: 'https://acme.atlassian.net', name: 'acme', scopes: ['read:issue:jira'], avatarUrl: 'https://site-admin-avatar-cdn.prod.public.atl-paas.net/avatars/240/rocket.png' },
      { id: 'cloud-2', url: 'https://beta.atlassian.net', name: 'beta', scopes: ['read:issue:jira'], avatarUrl: 'https://site-admin-avatar-cdn.prod.public.atl-paas.net/avatars/240/rocket.png' },
      { id: 'no url' },
    ]));
    const sites = await JiraClient.sites(token, { fetchImpl });
    expect(sites).toEqual([
      { id: 'cloud-1', url: 'https://acme.atlassian.net', name: 'acme' },
      { id: 'cloud-2', url: 'https://beta.atlassian.net', name: 'beta' },
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(JIRA_ENDPOINTS.resources);
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer a1');
    expect(seen[0]?.headers.get('accept')).toBe('application/json');
    const notAList = standIn(() => json({ sites: [] }));
    expect(await outcome(JiraClient.sites(token, { fetchImpl: notAList.fetchImpl }))).toSatisfy(
      (error: unknown) => error instanceof TrackerFault && error.reason === 'invalid_response',
    );
  });

  it('lists the projects the person may create issues in, with their non-subtask issue types, through the pages', async () => {
    const page = (values: unknown[], isLast: boolean) => json({ self: 'x', maxResults: 50, startAt: 0, total: 3, isLast, values });
    const task = { id: '10001', name: 'Task', subtask: false, description: 'A task.' };
    const subtask = { id: '10003', name: 'Subtask', subtask: true };
    const { fetchImpl, seen } = standIn((request) => {
      const startAt = new URL(request.url).searchParams.get('startAt');
      if (startAt === '0') return page([{ id: '10000', key: 'ABC', name: 'Alpha', lead: { accountId: 'lead-1' }, issueTypes: [task, subtask] }, { id: '10010', key: 'OPS', name: 'Operations', issueTypes: [task] }], false);
      return page([{ id: '10020', key: 'WEB', name: 'Web', issueTypes: [subtask] }], true);
    });
    const projects = await new JiraClient(token, site, { fetchImpl }).projects();
    expect(seen.map(line)).toEqual([
      'GET /ex/jira/cloud-1/rest/api/3/project/search?expand=issueTypes&action=create&maxResults=50&startAt=0',
      'GET /ex/jira/cloud-1/rest/api/3/project/search?expand=issueTypes&action=create&maxResults=50&startAt=2',
    ]);
    expect(projects).toEqual([
      { id: '10000', key: 'ABC', name: 'Alpha', issueTypes: [{ id: '10001', name: 'Task', subtask: false }] },
      { id: '10010', key: 'OPS', name: 'Operations', issueTypes: [{ id: '10001', name: 'Task', subtask: false }] },
      { id: '10020', key: 'WEB', name: 'Web', issueTypes: [] },
    ]);
    expect(JSON.stringify(projects)).not.toContain('lead');
  });

  it('stops paging projects at 500 and on a page that adds none', async () => {
    let calls = 0;
    const endless = standIn((request) => {
      calls += 1;
      const startAt = Number(new URL(request.url).searchParams.get('startAt'));
      const values = Array.from({ length: 50 }, (_unused, index) => ({ id: String(startAt + index), key: `K${startAt + index}`, name: `P${startAt + index}`, issueTypes: [] }));
      return json({ isLast: false, values });
    });
    expect(await new JiraClient(token, site, { fetchImpl: endless.fetchImpl }).projects()).toHaveLength(500);
    expect(calls).toBe(10);
    const empty = standIn(() => json({ isLast: false, values: [] }));
    expect(await new JiraClient(token, site, { fetchImpl: empty.fetchImpl }).projects()).toEqual([]);
    expect(empty.seen).toHaveLength(1);
  });

  it('lists the open issues assigned to the person with four fields and no person', async () => {
    const { fetchImpl, seen } = standIn(() => json({
      issues: [{ id: '10001', key: 'ABC-7', fields: { summary: 'Send the slides', status: { name: 'To Do', statusCategory: { key: 'new' } }, updated: '2026-11-10T12:00:00.000+0000', project: { id: '10000', key: 'ABC', name: 'Alpha', avatarUrls: {} }, assignee: { accountId: 'should-not-be-read', displayName: 'Someone' } } }],
      isLast: true,
    }));
    const issues = await new JiraClient(token, site, { fetchImpl }).assignedIssues();
    expect(line(seen[0])).toBe('POST /ex/jira/cloud-1/rest/api/3/search/jql');
    expect(seen[0]?.headers.get('content-type')).toBe('application/json');
    const body = JSON.parse(seen[0]?.body ?? '{}');
    expect(body).toEqual({ jql: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC', fields: ['summary', 'status', 'updated', 'project'], maxResults: 50 });
    expect(JSON.stringify(issues)).not.toContain('accountId');
    expect(JSON.stringify(issues)).not.toContain('Someone');
    expect(issues).toEqual([{
      id: '10001',
      key: 'ABC-7',
      summary: 'Send the slides',
      url: 'https://acme.atlassian.net/browse/ABC-7',
      statusCategory: 'new',
      updated: '2026-11-10T12:00:00.000Z',
      project: { id: '10000', key: 'ABC', name: 'Alpha' },
    }]);
  });

  it('pages the assigned issues by token up to the limit and asks no more than the limit', async () => {
    const issue = (n: number) => ({ id: String(n), key: `ABC-${n}`, fields: { summary: `Item ${n}`, status: { statusCategory: { key: 'indeterminate' } }, updated: null, project: { id: '10000', key: 'ABC', name: 'Alpha' } } });
    const { fetchImpl, seen } = standIn((request) => {
      const body = JSON.parse(request.body ?? '{}') as { nextPageToken?: string };
      return body.nextPageToken === undefined ? json({ issues: [issue(1), issue(2)], nextPageToken: 'page-2', isLast: false }) : json({ issues: [issue(3), issue(4)], isLast: true });
    });
    const issues = await new JiraClient(token, site, { fetchImpl }).assignedIssues(3);
    expect(issues.map((each) => each.key)).toEqual(['ABC-1', 'ABC-2', 'ABC-3']);
    expect(issues[0]?.updated).toBeNull();
    expect(JSON.parse(seen[0]?.body ?? '{}').maxResults).toBe(3);
    expect(JSON.parse(seen[1]?.body ?? '{}')).toMatchObject({ maxResults: 1, nextPageToken: 'page-2' });
    for (const bad of [0, -1, 101, 1.5, Number.NaN]) {
      await expect(new JiraClient(token, site, { fetchImpl }).assignedIssues(bad)).rejects.toSatisfy((error: unknown) => error instanceof TrackerFault && error.reason === 'configuration');
    }
  });

  it('creates an issue with the project, the issue type, the summary and the description as ADF paragraphs', async () => {
    const { fetchImpl, seen } = standIn(() => json({ id: '10042', key: 'ABC-42', self: 'https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/10042' }, 201));
    const ref = await new JiraClient(token, site, { fetchImpl }).createIssue({ projectId: '10000', issueTypeId: '10001', summary: 'Send the slides', description: 'From a meeting.\n\nSaid at 10:04.' });
    expect(ref).toEqual({ id: '10042', key: 'ABC-42', url: 'https://acme.atlassian.net/browse/ABC-42' });
    expect(line(seen[0])).toBe('POST /ex/jira/cloud-1/rest/api/3/issue');
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({
      fields: {
        project: { id: '10000' },
        issuetype: { id: '10001' },
        summary: 'Send the slides',
        description: { type: 'doc', version: 1, content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'From a meeting.' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Said at 10:04.' }] },
        ] },
      },
    });
    const noKey = standIn(() => json({ id: '10042' }, 201));
    await expect(new JiraClient(token, site, { fetchImpl: noKey.fetchImpl }).createIssue({ projectId: '10000', issueTypeId: '10001', summary: 'x', description: '' })).rejects.toSatisfy(
      (error: unknown) => error instanceof TrackerFault && error.reason === 'invalid_response',
    );
  });

  it('closes an issue through the transition whose target is the done category, preferring the one named Done, and resolves on an issue already done', async () => {
    const transitions = [
      { id: '21', name: 'In Progress', to: { statusCategory: { key: 'indeterminate' } } },
      { id: '41', name: "Won't do", to: { statusCategory: { key: 'done' } } },
      { id: '31', name: 'Done', to: { statusCategory: { key: 'done' } } },
    ];
    const open = standIn((request) => (request.method === 'GET' ? json({ transitions }) : new Response(null, { status: 204 })));
    await new JiraClient(token, site, { fetchImpl: open.fetchImpl }).closeIssue('ABC-7');
    expect(open.seen.map(line)).toEqual(['GET /ex/jira/cloud-1/rest/api/3/issue/ABC-7/transitions', 'POST /ex/jira/cloud-1/rest/api/3/issue/ABC-7/transitions']);
    expect(JSON.parse(open.seen[1]?.body ?? '{}')).toEqual({ transition: { id: '31' } });
    const unnamed = standIn((request) => (request.method === 'GET' ? json({ transitions: [transitions[0], { ...transitions[1], isAvailable: false }, { id: '51', name: 'Closed', to: { statusCategory: { key: 'done' } } }] }) : new Response(null, { status: 204 })));
    await new JiraClient(token, site, { fetchImpl: unnamed.fetchImpl }).closeIssue('ABC-7');
    expect(JSON.parse(unnamed.seen[1]?.body ?? '{}')).toEqual({ transition: { id: '51' } });
    // With no done transition the status is read through the JQL search, whose scopes the set holds; reading the issue
    // itself needs granular scopes outside it, which Atlassian answers with 401.
    const statusOf = (key: string | null) => standIn((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/transitions')) return json({ transitions: [transitions[0]] });
      if (request.method === 'POST' && path.endsWith('/search/jql')) return json({ issues: key === null ? [] : [{ id: '10001', key: 'ABC-7', fields: { status: { statusCategory: { key } } } }], isLast: true });
      return json({ code: 401, message: 'Unauthorized; scope does not match' }, 401);
    });
    const done = statusOf('done');
    await new JiraClient(token, site, { fetchImpl: done.fetchImpl }).closeIssue('ABC-7');
    expect(done.seen.map(line)).toEqual(['GET /ex/jira/cloud-1/rest/api/3/issue/ABC-7/transitions', 'POST /ex/jira/cloud-1/rest/api/3/search/jql']);
    expect(JSON.parse(done.seen[1]?.body ?? '{}')).toEqual({ jql: 'issue = "ABC-7"', fields: ['status'], maxResults: 1 });
    const stuck = statusOf('indeterminate');
    await expect(new JiraClient(token, site, { fetchImpl: stuck.fetchImpl }).closeIssue('ABC-7')).rejects.toSatisfy((error: unknown) => error instanceof TrackerFault && error.reason === 'refused');
    expect(stuck.seen.filter((each) => each.method === 'POST').map(line)).toEqual(['POST /ex/jira/cloud-1/rest/api/3/search/jql']);
    const unseen = statusOf(null);
    await expect(new JiraClient(token, site, { fetchImpl: unseen.fetchImpl }).closeIssue('ABC-7')).rejects.toSatisfy((error: unknown) => error instanceof TrackerFault && error.reason === 'refused');
  });

  it('quotes the key in the status search, so a key cannot widen the query', async () => {
    const { fetchImpl, seen } = standIn((request) => (request.method === 'GET' ? json({ transitions: [] }) : json({ issues: [], isLast: true })));
    await new JiraClient(token, site, { fetchImpl }).closeIssue('ABC-7"OR"x\\').catch(() => undefined);
    expect(JSON.parse(seen[1]?.body ?? '{}').jql).toBe('issue = "ABC-7\\"OR\\"x\\\\"');
  });

  it('puts an issue key into the path as one encoded segment', async () => {
    const { fetchImpl, seen } = standIn(() => json({ transitions: [{ id: '31', name: 'Done', to: { statusCategory: { key: 'done' } } }] }));
    await new JiraClient(token, site, { fetchImpl }).closeIssue('../../myself').catch(() => undefined);
    expect(new URL(seen[0]?.url ?? 'https://x.invalid').pathname).toBe('/ex/jira/cloud-1/rest/api/3/issue/..%2F..%2Fmyself/transitions');
  });

  it('turns a 429 into TrackerRateLimited with the time Retry-After or X-RateLimit-Reset names, or null', async () => {
    const before = Date.now();
    const afterSeconds = standIn(() => json({}, 429, { 'retry-after': '7', 'ratelimit-reason': 'jira-burst-based' }));
    const seconds = await outcome(new JiraClient(token, site, { fetchImpl: afterSeconds.fetchImpl }).projects());
    expect(seconds).toBeInstanceOf(TrackerRateLimited);
    expect((seconds as TrackerRateLimited).retryAt).toBeGreaterThanOrEqual(before + 7_000);
    expect((seconds as TrackerRateLimited).retryAt).toBeLessThanOrEqual(Date.now() + 7_000);
    const reset = standIn(() => json({}, 429, { 'x-ratelimit-reset': '2030-01-01T01:01:01Z' }));
    expect(((await outcome(new JiraClient(token, site, { fetchImpl: reset.fetchImpl }).projects())) as TrackerRateLimited).retryAt).toBe(Date.parse('2030-01-01T01:01:01Z'));
    const none = standIn(() => json({}, 429));
    const unnamed = await outcome(new JiraClient(token, site, { fetchImpl: none.fetchImpl }).projects());
    expect(unnamed).toBeInstanceOf(TrackerRateLimited);
    expect((unnamed as TrackerRateLimited).retryAt).toBeNull();
  });

  it('turns a 401 into TrackerGrantRefused, a 403 and a 400 into refused, a 404 into not_found, with no vendor text', async () => {
    const cases: Array<[number, (error: unknown) => boolean]> = [
      [401, (error) => error instanceof TrackerGrantRefused && error.status === 401],
      [403, (error) => error instanceof TrackerFault && error.reason === 'refused' && error.status === 403],
      [400, (error) => error instanceof TrackerFault && error.reason === 'refused' && error.status === 400],
      [404, (error) => error instanceof TrackerFault && error.reason === 'not_found' && error.status === 404],
      [500, (error) => error instanceof TrackerFault && error.reason === 'refused' && error.status === 500],
    ];
    for (const [status, expected] of cases) {
      const { fetchImpl } = standIn(() => json({ errorMessages: ['private words from the site'], errors: {} }, status));
      const error = await outcome(new JiraClient(token, site, { fetchImpl }).createIssue({ projectId: '10000', issueTypeId: '10001', summary: 'x', description: '' }));
      expect(expected(error)).toBe(true);
      expect((error as Error).message).not.toContain('private words');
    }
  });

  it('turns an answer that is not JSON or past its cap into invalid_response', async () => {
    const notJson = standIn(() => new Response('<html>maintenance</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    expect(await outcome(new JiraClient(token, site, { fetchImpl: notJson.fetchImpl }).projects())).toSatisfy((error: unknown) => error instanceof TrackerFault && error.reason === 'invalid_response');
    const large = standIn(() => json({ isLast: true, values: [{ id: '1', key: 'K', name: 'x'.repeat(1_100_000), issueTypes: [] }] }));
    expect(await outcome(new JiraClient(token, site, { fetchImpl: large.fetchImpl }).projects())).toSatisfy((error: unknown) => error instanceof TrackerFault && error.reason === 'invalid_response');
  });

  it('turns a call with no answer by the deadline into TrackerNoAnswer, and a cancelled one into cancelled', async () => {
    for (const fetchImpl of [neverAnswers, ignoresSignal]) {
      const error = await outcome(new JiraClient(token, site, { fetchImpl, timeoutMs: 20 }).projects());
      expect(error).toSatisfy((caught: unknown) => caught instanceof TrackerNoAnswer && caught.cause === 'timeout');
    }
    const controller = new AbortController();
    const pending = outcome(new JiraClient(token, site, { fetchImpl: neverAnswers, timeoutMs: 5_000 }).projects(controller.signal));
    controller.abort();
    expect(await pending).toSatisfy((caught: unknown) => caught instanceof TrackerNoAnswer && caught.cause === 'cancelled');
    const failing = standIn(() => {
      throw new TypeError('fetch failed');
    });
    expect(await outcome(new JiraClient(token, site, { fetchImpl: failing.fetchImpl }).projects())).toSatisfy((caught: unknown) => caught instanceof TrackerNoAnswer && caught.cause === 'network');
  });

  it('turns a grant the flow could not renew into TrackerGrantRefused, before any call', async () => {
    const { fetchImpl, seen } = standIn(() => json({ isLast: true, values: [] }));
    const lost = async (): Promise<string> => {
      throw new OAuthGrantRefused('refresh', 403, 'invalid_grant');
    };
    expect(await outcome(new JiraClient(lost, site, { fetchImpl }).projects())).toSatisfy((error: unknown) => error instanceof TrackerGrantRefused && error.status === 403);
    const missing = async (): Promise<string> => {
      throw new OAuthGrantRefused('missing');
    };
    expect(await outcome(JiraClient.sites(missing, { fetchImpl }))).toBeInstanceOf(TrackerGrantRefused);
    expect(seen).toHaveLength(0);
  });

  it('refuses a site that is not an https address or a cloud id that is not one path segment', () => {
    expect(() => new JiraClient(token, { id: 'cloud-1', url: 'http://acme.atlassian.net' })).toThrow(JiraFault);
    expect(() => new JiraClient(token, { id: 'cloud-1', url: 'https://acme.atlassian.net/?x=1' })).toThrow(JiraFault);
    expect(() => new JiraClient(token, { id: '../cloud', url: 'https://acme.atlassian.net' })).toThrow(JiraFault);
    expect(() => new JiraClient(token, { id: '', url: 'https://acme.atlassian.net' })).toThrow(JiraFault);
    const trailing = new JiraClient(token, { id: 'cloud-1', url: 'https://acme.atlassian.net/' });
    expect(trailing).toBeInstanceOf(JiraClient);
  });

  it('calls the base address the client was given, the stand-in only on CI', async () => {
    const { fetchImpl, seen } = standIn(() => json({ isLast: true, values: [] }));
    expect(base).toBe(`${JIRA_ENDPOINTS.api}/cloud-1/rest/api/3`);
    await new JiraClient(token, site, { fetchImpl }).projects();
    expect(seen[0]?.url.startsWith(`${base}/project/search?`)).toBe(true);
    expect(() => new JiraClient(token, site, { endpoints: { ...JIRA_ENDPOINTS, api: 'https://evil.example.com/ex/jira' } })).toThrow(JiraFault);
  });
});

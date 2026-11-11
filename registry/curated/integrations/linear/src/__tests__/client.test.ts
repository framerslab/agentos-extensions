/**
 * @fileoverview The GraphQL client over a fetch stand-in of Linear's API: the documents it sends, the fields it reads
 * and nothing of the person, the paging, the issue it opens and the state it moves an issue to, and each of Linear's
 * refusals turned into the account sources library's tracker faults with no text of Linear's.
 */

import { TrackerFault, TrackerGrantRefused, TrackerNoAnswer, TrackerRateLimited } from '@framers/agentos-ext-account-sources';
import { OAuthGrantRefused } from '@framers/agentos/auth';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LINEAR_ENDPOINTS, LinearClient, LinearFault } from '../index.js';
import { graphql, json, neverAnswers, sent, standIn } from './standIn.js';

const token = async (): Promise<string> => 'a1';

/** An issue node as Linear answers one. */
function issueNode(id: string, identifier: string, type: string, updatedAt = '2026-11-10T12:00:00.000Z'): Record<string, unknown> {
  return {
    id,
    identifier,
    title: `Title of ${identifier}`,
    url: `https://linear.app/acme/issue/${identifier}`,
    updatedAt,
    state: { name: type, type },
    team: { id: 't1', key: 'ENG', name: 'Engineering' },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('LinearClient', () => {
  it('reads the organisation name and URL key and nothing of the person', async () => {
    const { fetchImpl, seen } = standIn(graphql((name) => (name === 'Organization' ? { data: { viewer: { organization: { name: 'Acme', urlKey: 'acme' } } } } : { errors: [{ message: 'unknown' }] })));
    const client = new LinearClient(token, { fetchImpl });
    expect(await client.organization()).toEqual({ name: 'Acme', urlKey: 'acme' });
    const { query, operationName } = sent(seen[0]);
    expect(operationName).toBe('Organization');
    expect(query).not.toMatch(/\b(email|displayName|avatarUrl|name\s*\n?\s*organization|id\s*\n)/);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer a1');
    expect(seen[0]?.headers.get('content-type')).toContain('application/json');
    expect(seen[0]?.url).toBe(LINEAR_ENDPOINTS.graphql);
  });

  it('pages the teams and maps id, key and name', async () => {
    const pages: Record<string, unknown> = {
      first: { data: { teams: { nodes: [{ id: 't1', key: 'ENG', name: 'Engineering' }], pageInfo: { hasNextPage: true, endCursor: 'c1' } } } },
      c1: { data: { teams: { nodes: [{ id: 't2', key: 'OPS', name: 'Operations' }], pageInfo: { hasNextPage: false, endCursor: 'c2' } } } },
    };
    const { fetchImpl, seen } = standIn(graphql((name, variables) => (name === 'Teams' ? pages[typeof variables.after === 'string' ? variables.after : 'first'] : { errors: [{ message: 'unknown' }] })));
    const teams = await new LinearClient(token, { fetchImpl }).teams();
    expect(teams).toEqual([
      { id: 't1', key: 'ENG', name: 'Engineering' },
      { id: 't2', key: 'OPS', name: 'Operations' },
    ]);
    expect(seen).toHaveLength(2);
    expect(sent(seen[0]).variables.after).toBeUndefined();
    expect(sent(seen[1]).variables.after).toBe('c1');
    expect(sent(seen[0]).query).toContain('teams(first: 50, after: $after)');
  });

  it('stops paging the teams at 250, and refuses a page that repeats its cursor', async () => {
    let calls = 0;
    const many = standIn(graphql(() => {
      calls += 1;
      const nodes = Array.from({ length: 50 }, (_unused, index) => ({ id: `t${calls}-${index}`, key: `K${calls}X${index}`, name: `Team ${calls}-${index}` }));
      return { data: { teams: { nodes, pageInfo: { hasNextPage: true, endCursor: `c${calls}` } } } };
    }));
    expect(await new LinearClient(token, { fetchImpl: many.fetchImpl }).teams()).toHaveLength(250);
    expect(calls).toBe(5);
    const looping = standIn(graphql(() => ({ data: { teams: { nodes: [{ id: 't1', key: 'ENG', name: 'Engineering' }], pageInfo: { hasNextPage: true, endCursor: 'same' } } } })));
    await expect(new LinearClient(token, { fetchImpl: looping.fetchImpl }).teams()).rejects.toSatisfy(
      (error: unknown) => error instanceof TrackerFault && error.reason === 'invalid_response',
    );
  });

  it('lists the open issues assigned to the person, newest change first, with the done states left out of the filter', async () => {
    const { fetchImpl, seen } = standIn(graphql((name, variables) => {
      expect(name).toBe('AssignedIssues');
      expect(variables.first).toBe(50);
      return { data: { viewer: { assignedIssues: { nodes: [issueNode('i1', 'ENG-1', 'unstarted')], pageInfo: { hasNextPage: false, endCursor: null } } } } };
    }));
    const issues = await new LinearClient(token, { fetchImpl }).assignedIssues();
    expect(issues).toEqual([
      {
        id: 'i1',
        identifier: 'ENG-1',
        title: 'Title of ENG-1',
        url: 'https://linear.app/acme/issue/ENG-1',
        updatedAt: '2026-11-10T12:00:00.000Z',
        state: { name: 'unstarted', type: 'unstarted' },
        team: { id: 't1', key: 'ENG', name: 'Engineering' },
      },
    ]);
    const { query } = sent(seen[0]);
    expect(query).toContain('viewer { assignedIssues(');
    expect(query).toContain('nin: ["completed", "canceled", "duplicate"]');
    expect(query).toContain('orderBy: updatedAt');
    expect(query).not.toContain('assignee');
    expect(query).not.toMatch(/\b(email|displayName|avatarUrl|creator)\b/);
  });

  it('asks for no more issues than the limit, follows the cursor past one page, and refuses a limit below one', async () => {
    const asked: unknown[] = [];
    const { fetchImpl } = standIn(graphql((_name, variables) => {
      asked.push({ ...variables });
      const page = typeof variables.after === 'string' ? 2 : 1;
      const count = Number(variables.first);
      const nodes = Array.from({ length: count }, (_unused, index) => issueNode(`i${page}-${index}`, `ENG-${page * 100 + index}`, 'started'));
      return { data: { viewer: { assignedIssues: { nodes, pageInfo: { hasNextPage: true, endCursor: `c${page}` } } } } };
    }));
    const client = new LinearClient(token, { fetchImpl });
    expect(await client.assignedIssues(1)).toHaveLength(1);
    expect(asked[0]).toEqual({ first: 1 });
    expect(await client.assignedIssues(70)).toHaveLength(70);
    expect(asked.slice(1)).toEqual([{ first: 50 }, { first: 20, after: 'c1' }]);
    for (const limit of [0, -1, 1.5]) {
      await expect(client.assignedIssues(limit)).rejects.toSatisfy((error: unknown) => error instanceof TrackerFault && error.reason === 'configuration');
    }
  });

  it('creates an issue in a team with a title and a description and answers its identifier and address', async () => {
    const { fetchImpl, seen } = standIn(graphql((name, variables) => {
      if (name !== 'CreateIssue') return { errors: [{ message: 'unknown' }] };
      const input = variables.input as { teamId: string; title: string };
      return { data: { issueCreate: { success: true, issue: { ...issueNode('i9', 'ENG-9', 'unstarted'), title: input.title } } } };
    }));
    const issue = await new LinearClient(token, { fetchImpl }).createIssue({ teamId: 't1', title: 'Send the slides', description: 'From a meeting.\n\nSecond paragraph.' });
    expect(issue.identifier).toBe('ENG-9');
    expect(issue.url).toBe('https://linear.app/acme/issue/ENG-9');
    expect(issue.title).toBe('Send the slides');
    const call = sent(seen[0]);
    expect(call.query).toContain('mutation CreateIssue($input: IssueCreateInput!)');
    expect(call.variables).toEqual({ input: { teamId: 't1', title: 'Send the slides', description: 'From a meeting.\n\nSecond paragraph.' } });
    const refusing = standIn(graphql(() => ({ data: { issueCreate: { success: false, issue: null } } })));
    await expect(new LinearClient(token, { fetchImpl: refusing.fetchImpl }).createIssue({ teamId: 't1', title: 'T', description: '' })).rejects.toSatisfy(
      (error: unknown) => error instanceof TrackerFault && error.reason === 'refused',
    );
    const nothing = standIn(() => json({}));
    await expect(new LinearClient(token, { fetchImpl: nothing.fetchImpl }).createIssue({ teamId: 't1', title: '', description: '' })).rejects.toSatisfy(
      (error: unknown) => error instanceof TrackerFault && error.reason === 'configuration',
    );
    expect(nothing.seen).toHaveLength(0);
  });

  it('refuses an issue whose address is not an absolute https address', async () => {
    const { fetchImpl } = standIn(graphql(() => ({ data: { issueCreate: { success: true, issue: { ...issueNode('i9', 'ENG-9', 'unstarted'), url: 'javascript:alert(1)' } } } })));
    await expect(new LinearClient(token, { fetchImpl }).createIssue({ teamId: 't1', title: 'T', description: '' })).rejects.toSatisfy(
      (error: unknown) => error instanceof TrackerFault && error.reason === 'invalid_response',
    );
  });

  it('closes an issue by moving it to the lowest completed state of its team, and writes nothing for an issue already done', async () => {
    const states = [{ id: 's2', name: 'Done', position: 2 }, { id: 's1', name: 'Shipped', position: 1 }];
    const open = standIn(graphql((name, variables) => {
      if (name === 'IssueDoneStates') return { data: { issue: { id: variables.id, state: { type: 'started' }, team: { states: { nodes: states } } } } };
      if (name === 'CloseIssue') return { data: { issueUpdate: { success: true, issue: { id: variables.id, state: { type: 'completed' } } } } };
      return { errors: [{ message: 'unknown' }] };
    }));
    await new LinearClient(token, { fetchImpl: open.fetchImpl }).closeIssue('i1');
    expect(open.seen.map((each) => sent(each).operationName)).toEqual(['IssueDoneStates', 'CloseIssue']);
    expect(sent(open.seen[0]).query).toContain('states(filter: { type: { eq: "completed" } })');
    expect(sent(open.seen[1]).variables).toEqual({ id: 'i1', stateId: 's1' });
    for (const type of ['completed', 'canceled', 'duplicate']) {
      const done = standIn(graphql((name, variables) => (name === 'IssueDoneStates' ? { data: { issue: { id: variables.id, state: { type }, team: { states: { nodes: states } } } } } : { errors: [{ message: 'unexpected' }] })));
      await new LinearClient(token, { fetchImpl: done.fetchImpl }).closeIssue('i1');
      expect(done.seen).toHaveLength(1);
    }
    const none = standIn(graphql((_name, variables) => ({ data: { issue: { id: variables.id, state: { type: 'started' }, team: { states: { nodes: [] } } } } })));
    await expect(new LinearClient(token, { fetchImpl: none.fetchImpl }).closeIssue('i1')).rejects.toSatisfy((error: unknown) => error instanceof TrackerFault && error.reason === 'refused');
    expect(none.seen).toHaveLength(1);
    const refused = standIn(graphql((name, variables) => (name === 'IssueDoneStates' ? { data: { issue: { id: variables.id, state: { type: 'started' }, team: { states: { nodes: states } } } } } : { data: { issueUpdate: { success: false, issue: null } } })));
    await expect(new LinearClient(token, { fetchImpl: refused.fetchImpl }).closeIssue('i1')).rejects.toSatisfy((error: unknown) => error instanceof TrackerFault && error.reason === 'refused');
  });

  it("reads Linear's missing entity as not_found, for an issue to close and a team to open in, with none of Linear's words in the fault", async () => {
    // Linear's answer for an id it cannot find (the SDK's end-to-end test: type "invalid input", "Entity not found",
    // "Could not find referenced Issue"), as an answer with errors and no data, at 200 and at 400.
    const missing = (what: string, status: number) =>
      standIn(() => json({ errors: [{ message: 'Entity not found', path: [what.toLowerCase()], extensions: { type: 'invalid input', userError: true, userPresentableMessage: `Could not find referenced ${what}` } }], data: null }, status));
    for (const status of [200, 400]) {
      const issue = missing('Issue', status);
      let thrown: unknown;
      try {
        await new LinearClient(token, { fetchImpl: issue.fetchImpl }).closeIssue('no-such-issue');
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(TrackerFault);
      expect((thrown as TrackerFault).reason).toBe('not_found');
      expect((thrown as TrackerFault).status).toBe(status);
      expect((thrown as Error).message).not.toContain('Could not find');
      expect(issue.seen).toHaveLength(1);
      const team = missing('Team', status);
      await expect(new LinearClient(token, { fetchImpl: team.fetchImpl }).createIssue({ teamId: 'no-such-team', title: 'T', description: '' })).rejects.toSatisfy(
        (error: unknown) => error instanceof TrackerFault && error.reason === 'not_found' && error.status === status,
      );
    }
    // An answer that names no issue reads the same.
    const empty = standIn(graphql(() => ({ data: { issue: null } })));
    await expect(new LinearClient(token, { fetchImpl: empty.fetchImpl }).closeIssue('i1')).rejects.toSatisfy(
      (error: unknown) => error instanceof TrackerFault && error.reason === 'not_found',
    );
  });

  it('turns a 429 with Retry-After into TrackerRateLimited with the retry time, and a RATELIMITED error in a 200 the same', async () => {
    const limited = standIn(() => json({ errors: [{ message: 'rate limited', extensions: { code: 'RATELIMITED' } }] }, 429, { 'retry-after': '7' }));
    const before = Date.now();
    await expect(new LinearClient(token, { fetchImpl: limited.fetchImpl }).organization()).rejects.toSatisfy(
      (error: unknown) => error instanceof TrackerRateLimited && error.retryAt !== null && error.retryAt >= before + 7_000 && error.retryAt <= Date.now() + 7_000,
    );
    const inBody = standIn(() => json({ errors: [{ message: 'rate limited', extensions: { code: 'RATELIMITED' } }] }, 200));
    await expect(new LinearClient(token, { fetchImpl: inBody.fetchImpl }).organization()).rejects.toBeInstanceOf(TrackerRateLimited);
  });

  it('reads the retry time from the reset header of the window that ran out when Linear names no Retry-After, and null when none did', async () => {
    const reset = 1_900_000_000_000;
    const windowOut = standIn(() => json({ errors: [{ message: 'x', extensions: { code: 'RATELIMITED' } }] }, 429, {
      'x-ratelimit-requests-remaining': '0',
      'x-ratelimit-requests-reset': String(reset),
      'x-ratelimit-complexity-remaining': '5000',
      'x-ratelimit-complexity-reset': String(reset + 60_000),
    }));
    await expect(new LinearClient(token, { fetchImpl: windowOut.fetchImpl }).teams()).rejects.toSatisfy(
      (error: unknown) => error instanceof TrackerRateLimited && error.retryAt === reset && error.status === 429,
    );
    const bare = standIn(() => json({ errors: [{ message: 'x', extensions: { code: 'RATELIMITED' } }] }, 429));
    await expect(new LinearClient(token, { fetchImpl: bare.fetchImpl }).teams()).rejects.toSatisfy(
      (error: unknown) => error instanceof TrackerRateLimited && error.retryAt === null,
    );
  });

  it('turns a 401 and an AUTHENTICATION_ERROR into TrackerGrantRefused, and a call with no answer into TrackerNoAnswer', async () => {
    await expect(new LinearClient(token, { fetchImpl: standIn(() => json({}, 401)).fetchImpl }).organization()).rejects.toBeInstanceOf(TrackerGrantRefused);
    const unauthenticated = standIn(() => json({ errors: [{ message: 'Authentication required', extensions: { type: 'authentication error', code: 'AUTHENTICATION_ERROR' } }] }, 400));
    await expect(new LinearClient(token, { fetchImpl: unauthenticated.fetchImpl }).organization()).rejects.toBeInstanceOf(TrackerGrantRefused);
    await expect(new LinearClient(token, { fetchImpl: neverAnswers, timeoutMs: 20 }).organization()).rejects.toSatisfy(
      (error: unknown) => error instanceof TrackerNoAnswer && error.cause === 'timeout',
    );
    const cancelled = new AbortController();
    cancelled.abort();
    const untouched = standIn(() => json({}));
    await expect(new LinearClient(token, { fetchImpl: untouched.fetchImpl }).organization(cancelled.signal)).rejects.toSatisfy(
      (error: unknown) => error instanceof TrackerNoAnswer && error.cause === 'cancelled',
    );
    expect(untouched.seen).toHaveLength(0);
  });

  it("turns the token supplier's refused grant into TrackerGrantRefused, and a refresh Linear could not serve into a refusal that keeps the grant", async () => {
    const { fetchImpl, seen } = standIn(() => json({}));
    const lost = new LinearClient(async () => {
      throw new OAuthGrantRefused('refresh', 400, 'invalid_grant');
    }, { fetchImpl });
    await expect(lost.organization()).rejects.toSatisfy((error: unknown) => error instanceof TrackerGrantRefused && error.status === 400);
    const missing = new LinearClient(async () => {
      throw new OAuthGrantRefused('missing');
    }, { fetchImpl });
    await expect(missing.organization()).rejects.toBeInstanceOf(TrackerGrantRefused);
    const down = new LinearClient(async () => {
      throw new OAuthGrantRefused('refresh', 503);
    }, { fetchImpl });
    await expect(down.organization()).rejects.toSatisfy(
      (error: unknown) => error instanceof TrackerFault && !(error instanceof TrackerGrantRefused) && error.reason === 'refused' && error.status === 503,
    );
    const busy = new LinearClient(async () => {
      throw new OAuthGrantRefused('refresh', 429);
    }, { fetchImpl });
    await expect(busy.organization()).rejects.toBeInstanceOf(TrackerRateLimited);
    expect(seen).toHaveLength(0);
  });

  it("refuses an answer with no data, an answer past the cap and any other error, with none of Linear's words in the fault", async () => {
    await expect(new LinearClient(token, { fetchImpl: standIn(() => json({})).fetchImpl }).organization()).rejects.toSatisfy(
      (error: unknown) => error instanceof TrackerFault && error.reason === 'invalid_response',
    );
    await expect(new LinearClient(token, { fetchImpl: standIn(() => new Response('not json', { status: 200 })).fetchImpl }).organization()).rejects.toSatisfy(
      (error: unknown) => error instanceof TrackerFault && error.reason === 'invalid_response',
    );
    const large = standIn(() => json({ data: { viewer: { organization: { name: 'x'.repeat(1_100_000), urlKey: 'acme' } } } }));
    await expect(new LinearClient(token, { fetchImpl: large.fetchImpl }).organization()).rejects.toSatisfy(
      (error: unknown) => error instanceof TrackerFault && error.reason === 'invalid_response',
    );
    const refused = standIn(() => json({ errors: [{ message: 'Argument Validation Error: secret-words', extensions: { type: 'invalid input', userError: true } }] }, 400));
    let thrown: unknown;
    try {
      await new LinearClient(token, { fetchImpl: refused.fetchImpl }).createIssue({ teamId: 't1', title: 'T', description: '' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TrackerFault);
    expect((thrown as TrackerFault).reason).toBe('refused');
    expect((thrown as TrackerFault).status).toBe(400);
    expect((thrown as Error).message).not.toContain('secret-words');
    const down = standIn(() => new Response('bad gateway', { status: 502 }));
    await expect(new LinearClient(token, { fetchImpl: down.fetchImpl }).organization()).rejects.toSatisfy(
      (error: unknown) => error instanceof TrackerFault && error.reason === 'refused' && error.status === 502,
    );
  });

  it('never follows a redirect', async () => {
    const { fetchImpl, seen } = standIn(() => new Response(null, { status: 307, headers: { location: 'https://elsewhere.example.com/graphql' } }));
    await expect(new LinearClient(token, { fetchImpl }).organization()).rejects.toSatisfy(
      (error: unknown) => error instanceof TrackerFault && error.reason === 'refused' && error.status === 307,
    );
    expect(seen).toHaveLength(1);
  });

  it('takes a stand-in GraphQL address only on CI at a loopback or .invalid host', () => {
    vi.stubEnv('CI', 'true');
    expect(() => new LinearClient(token, { endpoint: 'http://127.0.0.1:9452/graphql' })).not.toThrow();
    expect(() => new LinearClient(token, { endpoint: 'https://evil.example.com/graphql' })).toThrow(LinearFault);
    vi.stubEnv('CI', 'false');
    expect(() => new LinearClient(token, { endpoint: 'http://127.0.0.1:9452/graphql' })).toThrow(LinearFault);
  });
});

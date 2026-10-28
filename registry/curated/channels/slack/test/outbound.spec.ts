/**
 * Contract tests for the outbound entry (`@framers/agentos-ext-channel-slack/outbound`): which links it takes, what it
 * sends to Slack and how it reads Slack's answers. No test reaches the network: every post goes through a fetch the
 * test gives, which records the request and answers as Slack's documentation says it answers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The outbound entry must never load Bolt: a host that only posts to a link installs no listener and opens no port.
const boltLoads = vi.hoisted(() => ({ count: 0 }));
vi.mock('@slack/bolt', () => {
  boltLoads.count += 1;
  return {};
});

import { escapeSlackText, parseSlackLink, postToSlackLink, SLACK_HOOKS_HOST, SLACK_TEXT_LIMIT, type SlackLink } from '../src/outbound/index';

/** What a fake fetch took. */
interface Taken {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: string | undefined;
  redirect: string | undefined;
  signal: unknown;
}

/** A fetch that records each request and answers with the status, body and headers given. */
function fakeFetch(answer: { status: number; body?: string; headers?: Record<string, string> } | (() => never)) {
  const taken: Taken[] = [];
  const fetch = vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string; redirect?: string; signal?: unknown }) => {
    taken.push({ url, method: init.method, headers: init.headers ?? {}, body: init.body, redirect: init.redirect, signal: init.signal });
    if (typeof answer === 'function') answer();
    const { status, body = '', headers = {} } = answer as { status: number; body?: string; headers?: Record<string, string> };
    const lower = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
    return { status, headers: { get: (name: string) => lower[name.toLowerCase()] ?? null }, text: async () => body };
  });
  return { fetch, taken };
}

/**
 * A link on Slack's host from its path's parts. The tests join their links here, so no whole link stands in the source
 * for a secret scanner to read as a leaked one; every value is made up.
 */
const at = (...parts: string[]): string => ['https://hooks.slack.com', ...parts].join('/');
const WEBHOOK = at('services', 'T0001ABCD', 'B0002EFGH', 'abcdEFGH1234ijklMNOP5678');
const WORKFLOW = at('triggers', 'T0001ABCD', '9876543210123', '0123456789abcdef0123456789abcdef');

function link(url: string): SlackLink {
  const parsed = parseSlackLink(url);
  if (parsed === null) throw new Error(`test link refused: ${url}`);
  return parsed;
}

describe('parseSlackLink', () => {
  it('takes an incoming webhook link and names its kind, workspace and last four characters', () => {
    expect(parseSlackLink(WEBHOOK)).toEqual({ kind: 'webhook', url: WEBHOOK, workspace: 'T0001ABCD', ending: '5678' });
  });

  it('takes a workflow webhook link', () => {
    expect(parseSlackLink(WORKFLOW)).toEqual({ kind: 'workflow', url: WORKFLOW, workspace: 'T0001ABCD', ending: 'cdef' });
  });

  it('takes a link with spaces around it and a host in capitals, and rebuilds it on Slack\'s host', () => {
    expect(parseSlackLink(`  ${WEBHOOK.replace('hooks.slack.com', 'HOOKS.Slack.COM')}\n`)?.url).toBe(WEBHOOK);
  });

  it('takes an Enterprise Grid workspace id', () => {
    expect(parseSlackLink(at('services', 'E0001ABCD', 'B0002EFGH', 'abcdEFGH1234ijklMNOP5678'))?.workspace).toBe('E0001ABCD');
  });

  it.each([
    ['plain http', WEBHOOK.replace('https:', 'http:')],
    ['another host', WEBHOOK.replace('hooks.slack.com', 'hooks.slack.com.example.test')],
    ['another host under slack.com', WEBHOOK.replace('hooks.slack.com', 'evilhooks.slack.com')],
    ['Slack\'s web host', WEBHOOK.replace('hooks.slack.com', 'slack.com')],
    ['a user name before the host', WEBHOOK.replace('https://', 'https://someone@')],
    ['a password before the host', WEBHOOK.replace('https://', 'https://someone:secret@')],
    ['a port', WEBHOOK.replace('hooks.slack.com', 'hooks.slack.com:8443')],
    ['a query', `${WEBHOOK}?channel=C1`],
    ['an empty query', `${WEBHOOK}?`],
    ['a fragment', `${WEBHOOK}#top`],
    ['a trailing slash', `${WEBHOOK}/`],
    ['a fourth path part', `${WEBHOOK}/more`],
    ['no secret', at('services', 'T0001ABCD', 'B0002EFGH')],
    ['a percent-encoded path', at('services', 'T0001ABCD', 'B0002EFGH', 'abcd%2Fefgh1234')],
    ['a legacy workflow link', at('workflows', 'T0001ABCD', 'A0002EFGH', '123456789', 'abcdEFGH1234')],
    ['a channel in the path', at('services', 'T0001ABCD', 'C0002EFGH', 'abcdEFGH1234ijklMNOP5678')],
    ['a trigger with letters where its number goes', at('triggers', 'T0001ABCD', '98765abc', '0123456789abcdef')],
    ['a relative path', WEBHOOK.replace('https://hooks.slack.com', '')],
    ['no scheme', WEBHOOK.replace('https://', '')],
    ['words', 'not a link'],
    ['nothing', ''],
  ])('refuses %s', (_name, input) => {
    expect(parseSlackLink(input)).toBeNull();
  });

  it('refuses a value that is not text', () => {
    expect(parseSlackLink(undefined as unknown as string)).toBeNull();
    expect(parseSlackLink(42 as unknown as string)).toBeNull();
  });

  it('refuses a link longer than any Slack makes', () => {
    expect(parseSlackLink(at('services', 'T0001ABCD', 'B0002EFGH', 'a'.repeat(600)))).toBeNull();
  });
});

describe('escapeSlackText', () => {
  it('writes &, < and > as the entities Slack reads them as, so text never turns into a mention or a link', () => {
    expect(escapeSlackText('Q&A <!channel> <@U123|ann> a > b')).toBe('Q&amp;A &lt;!channel&gt; &lt;@U123|ann&gt; a &gt; b');
  });
});

describe('postToSlackLink', () => {
  beforeEach(() => {
    boltLoads.count = 0;
  });

  it('posts the text as JSON to the link rebuilt on Slack\'s host, follows no redirect and gives the request a signal', async () => {
    const { fetch, taken } = fakeFetch({ status: 200, body: 'ok' });
    await expect(postToSlackLink(link(WEBHOOK), 'Decisions: ship it', { fetch })).resolves.toEqual({ ok: true });
    expect(taken).toHaveLength(1);
    expect(taken[0]?.url).toBe(WEBHOOK);
    expect(taken[0]?.method).toBe('POST');
    expect(taken[0]?.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(taken[0]?.redirect).toBe('manual');
    expect(taken[0]?.signal).toBeDefined();
    expect(JSON.parse(taken[0]?.body ?? '')).toEqual({ text: 'Decisions: ship it' });
  });

  it('escapes the text for an incoming webhook, which reads it as Slack\'s message formatting', async () => {
    const { fetch, taken } = fakeFetch({ status: 200, body: 'ok' });
    await postToSlackLink(link(WEBHOOK), 'R&D <!here>', { fetch });
    expect(JSON.parse(taken[0]?.body ?? '')).toEqual({ text: 'R&amp;D &lt;!here&gt;' });
  });

  it('sends a workflow link the text as it is, in the one variable named text', async () => {
    const { fetch, taken } = fakeFetch({ status: 200, body: '{"ok":true}' });
    await expect(postToSlackLink(link(WORKFLOW), 'R&D <today>', { fetch })).resolves.toEqual({ ok: true });
    expect(JSON.parse(taken[0]?.body ?? '')).toEqual({ text: 'R&D <today>' });
  });

  it('never loads Bolt', async () => {
    const { fetch } = fakeFetch({ status: 200, body: 'ok' });
    await postToSlackLink(link(WEBHOOK), 'hello', { fetch });
    expect(boltLoads.count).toBe(0);
  });

  it.each([
    [404, 'no_service', 'link_gone'],
    [404, 'no_team', 'link_gone'],
    [404, 'no_service_id', 'link_gone'],
    [410, 'channel_is_archived', 'link_gone'],
    [404, 'channel_not_found', 'link_gone'],
    [404, 'user_not_found', 'link_gone'],
    [403, 'invalid_token', 'link_gone'],
    [403, 'no_active_hooks', 'link_gone'],
    [403, 'team_disabled', 'link_gone'],
    [403, 'action_prohibited', 'refused'],
    [403, 'posting_to_general_channel_denied', 'refused'],
    [400, 'invalid_payload', 'invalid'],
    [400, 'no_text', 'invalid'],
    [400, 'too_many_attachments', 'invalid'],
  ] as const)('reads a %i answer of %s as %s and names Slack\'s error', async (status, error, reason) => {
    const { fetch } = fakeFetch({ status, body: error });
    await expect(postToSlackLink(link(WEBHOOK), 'hello', { fetch })).resolves.toEqual({ ok: false, reason, slackError: error });
  });

  it('reads a workflow\'s JSON refusal by its error', async () => {
    const { fetch } = fakeFetch({ status: 400, body: '{"ok":false,"error":"parameter_validation_failed"}' });
    await expect(postToSlackLink(link(WORKFLOW), 'hello', { fetch })).resolves.toEqual({ ok: false, reason: 'invalid', slackError: 'parameter_validation_failed' });
  });

  it('reads a refusal sent with a 200 as a refusal, by its error when Slack documents it', async () => {
    const known = fakeFetch({ status: 200, body: '{"ok":false,"error":"parameter_validation_failed"}' });
    await expect(postToSlackLink(link(WORKFLOW), 'hello', { fetch: known.fetch })).resolves.toEqual({ ok: false, reason: 'invalid', slackError: 'parameter_validation_failed' });
    const unknown = fakeFetch({ status: 200, body: '{"ok":false,"error":"some_new_error"}' });
    await expect(postToSlackLink(link(WORKFLOW), 'hello', { fetch: unknown.fetch })).resolves.toEqual({ ok: false, reason: 'refused', slackError: 'some_new_error' });
  });

  it.each([
    [404, 'link_gone'],
    [410, 'link_gone'],
    [403, 'refused'],
    [400, 'invalid'],
    [413, 'invalid'],
    [500, 'unavailable'],
    [503, 'unavailable'],
    [302, 'unavailable'],
  ] as const)('reads a %i answer with an error it does not know by its status, as %s', async (status, reason) => {
    const { fetch } = fakeFetch({ status, body: 'some_new_error' });
    await expect(postToSlackLink(link(WEBHOOK), 'hello', { fetch })).resolves.toEqual({ ok: false, reason, slackError: 'some_new_error' });
  });

  it('names no Slack error when the answer\'s body is not one', async () => {
    const { fetch } = fakeFetch({ status: 502, body: '<html><body>Bad gateway</body></html>' });
    await expect(postToSlackLink(link(WEBHOOK), 'hello', { fetch })).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });

  it('reads a 429 as rate limited, with the seconds Slack asks the caller to wait', async () => {
    const { fetch } = fakeFetch({ status: 429, body: 'rate_limited', headers: { 'Retry-After': '30' } });
    await expect(postToSlackLink(link(WEBHOOK), 'hello', { fetch })).resolves.toEqual({ ok: false, reason: 'rate_limited', retryAfterSeconds: 30, slackError: 'rate_limited' });
  });

  it('waits one second after a 429 that names no wait, and at most an hour after one that names more', async () => {
    const none = fakeFetch({ status: 429 });
    await expect(postToSlackLink(link(WEBHOOK), 'hello', { fetch: none.fetch })).resolves.toEqual({ ok: false, reason: 'rate_limited', retryAfterSeconds: 1 });
    const long = fakeFetch({ status: 429, headers: { 'retry-after': '86400' } });
    await expect(postToSlackLink(link(WEBHOOK), 'hello', { fetch: long.fetch })).resolves.toEqual({ ok: false, reason: 'rate_limited', retryAfterSeconds: 3600 });
  });

  it('reads no answer as unavailable', async () => {
    const { fetch } = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    await expect(postToSlackLink(link(WEBHOOK), 'hello', { fetch })).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });

  it('gives up after the time given and reads it as unavailable', async () => {
    const fetch = vi.fn(
      (_url: string, init: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    await expect(postToSlackLink(link(WEBHOOK), 'hello', { fetch, timeoutMs: 20 })).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });

  it('posts text of exactly the limit and refuses longer text or none before sending anything', async () => {
    const { fetch, taken } = fakeFetch({ status: 200, body: 'ok' });
    await expect(postToSlackLink(link(WEBHOOK), 'a'.repeat(SLACK_TEXT_LIMIT), { fetch })).resolves.toEqual({ ok: true });
    await expect(postToSlackLink(link(WEBHOOK), 'a'.repeat(SLACK_TEXT_LIMIT + 1), { fetch })).rejects.toThrow(RangeError);
    await expect(postToSlackLink(link(WEBHOOK), '   ', { fetch })).rejects.toThrow(RangeError);
    expect(taken).toHaveLength(1);
  });

  it('counts the limit in characters, so text in other scripts gets the whole limit', async () => {
    const { fetch } = fakeFetch({ status: 200, body: 'ok' });
    await expect(postToSlackLink(link(WEBHOOK), '😀'.repeat(SLACK_TEXT_LIMIT), { fetch })).resolves.toEqual({ ok: true });
  });

  it('refuses a link it did not make, before sending anything', async () => {
    const { fetch, taken } = fakeFetch({ status: 200, body: 'ok' });
    const forged = { kind: 'webhook', url: 'https://example.test/services/T0001ABCD/B0002EFGH/abcdEFGH1234ijklMNOP5678', workspace: 'T0001ABCD', ending: '5678' } as SlackLink;
    await expect(postToSlackLink(forged, 'hello', { fetch })).rejects.toThrow(TypeError);
    const mislabelled = { ...link(WEBHOOK), kind: 'workflow' } as SlackLink;
    await expect(postToSlackLink(mislabelled, 'hello', { fetch })).rejects.toThrow(TypeError);
    expect(taken).toHaveLength(0);
  });

  it('names Slack\'s host', () => {
    expect(SLACK_HOOKS_HOST).toBe('hooks.slack.com');
  });
});

/**
 * @fileoverview Posting to a Slack link a person made in their own workspace: an incoming webhook
 * (`https://hooks.slack.com/services/...`) or a workflow webhook trigger (`https://hooks.slack.com/triggers/...`).
 *
 * The entry imports nothing from `@slack/bolt`: a host that only posts installs no listener and opens no port. It
 * takes Slack's own host alone and rebuilds every link from its checked path, follows no redirect and gives up after a
 * timeout, so a link can never send a request anywhere but Slack. It reads Slack's answers into a few fixed reasons a
 * host can act on, with Slack's error code beside them when the answer carries one, and never hands back anything else
 * Slack's answer held.
 *
 * Sources: incoming webhooks and their errors, https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks;
 * workflow webhook triggers, https://docs.slack.dev/tools/deno-slack-sdk/guides/creating-webhook-triggers and
 * https://slack.com/help/articles/360041352714; escaping, https://docs.slack.dev/messaging/formatting-message-text;
 * 429 and Retry-After, https://docs.slack.dev/apis/web-api/rate-limits; the text limit,
 * https://docs.slack.dev/reference/methods/chat.postMessage.
 *
 * @module @framers/agentos-ext-channel-slack/outbound
 */

/** Slack's host for incoming webhooks and workflow webhook triggers, the only host this entry posts to. */
export const SLACK_HOOKS_HOST = 'hooks.slack.com';

/** The most characters a post's text may hold as Slack gets it (escaped, for an incoming webhook): Slack truncates a message's text above 40,000 characters. */
export const SLACK_TEXT_LIMIT = 40_000;

/** How long a post waits for Slack's answer by default, in milliseconds. */
export const SLACK_POST_TIMEOUT_MS = 10_000;

/** The longest link this entry takes; Slack's are well under it. */
const LINK_LIMIT = 512;

/** The most a 429's `Retry-After` is taken to ask for, in seconds. */
const RETRY_AFTER_LIMIT = 3600;

/**
 * How much of Slack's answer is read, in characters. Slack's answers are a word or a short JSON object; a longer answer
 * is read to this bound and no further, and is read by its status unless what was read says otherwise.
 */
const ANSWER_LIMIT = 8192;

/** An incoming webhook's path: the workspace, the webhook's own id and its secret. */
const WEBHOOK_PATH = /^\/services\/([TE][A-Z0-9]{2,32})\/(B[A-Z0-9]{2,32})\/([A-Za-z0-9]{8,128})$/;

/** A workflow webhook trigger's path: the workspace, the trigger's number and its secret. */
const WORKFLOW_PATH = /^\/triggers\/([TE][A-Z0-9]{2,32})\/([0-9]{2,32})\/([A-Za-z0-9]{8,128})$/;

/** A Slack error code, as the answers name them. */
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** What kind of link a person made: an incoming webhook of an app in their workspace, or a workflow's webhook trigger. */
export type SlackLinkKind = 'webhook' | 'workflow';

/** A link this entry took: its kind, the link rebuilt on Slack's host, its workspace's id and its last four characters. */
export interface SlackLink {
  readonly kind: SlackLinkKind;
  /** The link as this entry posts to it: `https://hooks.slack.com` and the checked path. It holds a secret. */
  readonly url: string;
  /** The workspace id the link's path names (`T...`, or `E...` for an Enterprise Grid organization). */
  readonly workspace: string;
  /** The link's last four characters, for a person to tell their links apart; never enough to post with. */
  readonly ending: string;
}

/**
 * Takes a link a person pasted, or returns null for anything that is not a Slack incoming webhook or workflow webhook
 * link: another scheme, host or port, a user name or password, a query or a fragment (even an empty one), any other
 * path, or a path with an encoded character. Spaces around the link and the host's capitals are forgiven; the link
 * returned is rebuilt on Slack's host from the checked path.
 */
export function parseSlackLink(input: string): SlackLink | null {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (text.length === 0 || text.length > LINK_LIMIT) return null;
  // A query or a fragment is refused even when empty, which the parsed URL no longer shows; a backslash and a port, the
  // default one included, likewise, since the parsed URL reads a backslash as a slash and drops the default port.
  if (text.includes('?') || text.includes('#') || text.includes('\\')) return null;
  if (!/^https:\/\/hooks\.slack\.com\//i.test(text)) return null;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== SLACK_HOOKS_HOST || parsed.port !== '' || parsed.username !== '' || parsed.password !== '') return null;
  const path = parsed.pathname;
  const webhook = WEBHOOK_PATH.exec(path);
  const workflow = webhook === null ? WORKFLOW_PATH.exec(path) : null;
  const match = webhook ?? workflow;
  if (match === null) return null;
  const secret = match[3] ?? '';
  return {
    kind: webhook === null ? 'workflow' : 'webhook',
    url: `https://${SLACK_HOOKS_HOST}${path}`,
    workspace: match[1] ?? '',
    ending: secret.slice(-4),
  };
}

/**
 * Writes `&`, `<` and `>` as the entities Slack reads them as. Slack uses the three as control characters (mentions
 * such as `<!channel>`, links and dates), so text posted without this could notify a whole channel or show a link the
 * writer never wrote.
 */
export function escapeSlackText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Why a post did not reach the channel:
 * - `link_gone`: the link no longer takes posts: it was removed or turned off, or its channel was archived or its
 *   workspace closed; a new link is needed.
 * - `refused`: the workspace refuses this post, such as an admin's restriction or a channel only some may post in.
 * - `invalid`: Slack refused the message itself.
 * - `rate_limited`: Slack asks the caller to wait (`retryAfterSeconds`).
 * - `unavailable`: no answer in time, a server error, a redirect, or an answer this entry does not read.
 */
export type SlackPostReason = 'link_gone' | 'refused' | 'invalid' | 'rate_limited' | 'unavailable';

/** A post's outcome: posted, or not, with why, how long Slack asks to wait, and Slack's error code when it named one. */
export type SlackPostOutcome = { ok: true } | { ok: false; reason: SlackPostReason; retryAfterSeconds?: number; slackError?: string };

/** A body stream's reader, as far as this entry reads an answer's body: a web stream's default reader fits it. */
export interface SlackBodyReader {
  read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
  cancel(): Promise<void>;
}

/** The answer a fetch gives, as far as this entry reads it. */
export interface SlackFetchAnswer {
  status: number;
  headers: { get(name: string): string | null };
  /** The answer's body as a stream, which this entry reads to its bound and then lets go; `text()` when there is none. */
  body?: { getReader(): SlackBodyReader } | null;
  text(): Promise<string>;
}

/** The request this entry makes, as far as a fetch needs it. */
export interface SlackFetchRequest {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  redirect: 'manual';
  signal: AbortSignal;
}

/** A fetch: the platform's, or one a host or a test gives. */
export type SlackFetch = (url: string, init: SlackFetchRequest) => Promise<SlackFetchAnswer>;

/** What a post may be given besides the link and the text. */
export interface SlackPostOptions {
  /** The fetch to post with; the platform's own when none is given. */
  fetch?: SlackFetch;
  /** How long to wait for Slack's answer, in milliseconds; 10 seconds when none is given. */
  timeoutMs?: number;
  /** A signal that stops the post early, beside the timeout. */
  signal?: AbortSignal;
}

/** Errors Slack documents for a link that no longer takes posts. */
const LINK_GONE = new Set(['no_service', 'no_service_id', 'no_team', 'no_active_hooks', 'team_disabled', 'invalid_token', 'channel_is_archived', 'channel_not_found', 'user_not_found']);

/** Errors Slack documents for a workspace refusing a post. */
const REFUSED = new Set(['action_prohibited', 'posting_to_general_channel_denied']);

/** Errors Slack documents for a message it refused. */
const INVALID = new Set(['invalid_payload', 'no_text', 'too_many_attachments', 'parameter_validation_failed']);

/** Counts characters as a person does, a character outside the basic plane as one. */
function characters(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

/** The text as a link of this kind gets it: escaped for an incoming webhook, as it is for a workflow. */
function textFor(kind: SlackLinkKind, text: string): string {
  return kind === 'webhook' ? escapeSlackText(text) : text;
}

/**
 * A text's length in characters as a link of this kind gets it, which `SLACK_TEXT_LIMIT` bounds: an incoming webhook
 * gets `&`, `<` and `>` as five, four and four characters, a workflow gets the text as it is. A host shows it, or
 * checks it before a post, so a text that fits is never cut by Slack.
 */
export function slackTextLength(kind: SlackLinkKind, text: string): number {
  return characters(textFor(kind, text));
}

/** An answer's body as a JSON object's top-level fields, or null for a body that is not a whole JSON object. */
function jsonOf(body: string): { ok?: unknown; error?: unknown } | null {
  const text = body.trim();
  if (!text.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as { ok?: unknown; error?: unknown }) : null;
  } catch {
    return null;
  }
}

/** Slack's error code in an answer's body: a JSON object's top-level `error`, or the body itself when it is one code. */
function errorCodeOf(body: string): string | undefined {
  const text = body.trim();
  if (text.startsWith('{')) {
    const error = jsonOf(text)?.error;
    return typeof error === 'string' && ERROR_CODE.test(error) ? error : undefined;
  }
  return ERROR_CODE.test(text) ? text : undefined;
}

/**
 * The first `ANSWER_LIMIT` characters of an answer's body: read from its stream until they are there or the stream
 * ends, the stream then let go, so a long answer is never held whole; read through `text()` when it has no stream.
 */
async function answerText(answer: SlackFetchAnswer): Promise<string> {
  const stream = answer.body;
  if (stream === undefined || stream === null) return (await answer.text()).slice(0, ANSWER_LIMIT);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || value === undefined) {
        text += decoder.decode();
        break;
      }
      text += decoder.decode(value, { stream: true });
      if (text.length >= ANSWER_LIMIT) break;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  return text.slice(0, ANSWER_LIMIT);
}

/** A 429's wait in whole seconds: its `Retry-After`, 1 when it names none, and at most an hour. */
function retryAfterOf(value: string | null): number {
  const seconds = value === null ? Number.NaN : Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(seconds) || seconds < 1) return 1;
  return Math.min(seconds, RETRY_AFTER_LIMIT);
}

/** The reason for an error code Slack documents, or by the answer's status for one it does not. */
function reasonOf(status: number, code: string | undefined): SlackPostReason {
  if (code !== undefined) {
    if (LINK_GONE.has(code)) return 'link_gone';
    if (REFUSED.has(code)) return 'refused';
    if (INVALID.has(code)) return 'invalid';
  }
  if (status === 404 || status === 410) return 'link_gone';
  if (status === 403) return 'refused';
  if (status >= 200 && status < 300) return 'refused';
  if (status >= 400 && status < 500) return 'invalid';
  return 'unavailable';
}

/** A refusal's outcome, with Slack's code beside it when the answer carried one. */
function refusal(reason: SlackPostReason, code: string | undefined, retryAfterSeconds?: number): SlackPostOutcome {
  return { ok: false, reason, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }), ...(code === undefined ? {} : { slackError: code }) };
}

/** The platform's fetch, read when a post needs it. */
function platformFetch(): SlackFetch {
  const fetch = (globalThis as unknown as { fetch?: SlackFetch }).fetch;
  if (typeof fetch !== 'function') throw new TypeError('this runtime has no fetch: give postToSlackLink one in its options');
  return fetch;
}

/** One post and the reading of Slack's answer, whatever the answer or its failure. */
async function attempt(fetch: SlackFetch, url: string, sent: string, signal: AbortSignal): Promise<SlackPostOutcome> {
  try {
    const answer = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ text: sent }),
      redirect: 'manual',
      signal,
    });
    const body = await answerText(answer);
    const code = errorCodeOf(body);
    if (answer.status === 429) return refusal('rate_limited', code, retryAfterOf(answer.headers.get('retry-after')));
    if (answer.status >= 200 && answer.status < 300) {
      // Slack answers a post it took with `ok` (an incoming webhook) or `{"ok":true}` (a workflow); only an answer whose
      // top-level `ok` is false is read as refused, so a post Slack took is never reported as failed and sent twice.
      if (jsonOf(body)?.ok === false) return refusal(reasonOf(answer.status, code), code);
      return { ok: true };
    }
    return refusal(reasonOf(answer.status, code), code);
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

/**
 * Posts `text` to a link `parseSlackLink` took. An incoming webhook gets `{ "text": ... }` with the text escaped, since
 * Slack reads it as its message formatting; a workflow link gets the text as it is in the one variable named `text`,
 * which the workflow's message step shows. No redirect is followed, and the post gives up after the timeout, or when
 * the signal it was given stops it, whatever the fetch does with its own signal.
 *
 * Resolves with the outcome, whatever Slack answers or when it does not answer. Rejects before sending anything with a
 * `TypeError` for a link this entry did not take, and with a `RangeError` for text with nothing but spaces or with more
 * than `SLACK_TEXT_LIMIT` characters as the link gets it (`slackTextLength`).
 */
export async function postToSlackLink(link: SlackLink, text: string, options: SlackPostOptions = {}): Promise<SlackPostOutcome> {
  const checked = parseSlackLink(link?.url);
  if (checked === null || checked.kind !== link.kind || checked.url !== link.url) throw new TypeError('postToSlackLink takes a link parseSlackLink returned');
  if (typeof text !== 'string' || text.trim().length === 0) throw new RangeError('a Slack post needs text');
  const sent = textFor(checked.kind, text);
  if (characters(sent) > SLACK_TEXT_LIMIT) throw new RangeError(`a Slack post holds at most ${SLACK_TEXT_LIMIT} characters as Slack gets it`);
  const fetch = options.fetch ?? platformFetch();
  if (options.signal?.aborted === true) return { ok: false, reason: 'unavailable' };
  const controller = new AbortController();
  // The deadline and the caller's signal end the post themselves: a fetch that leaves its answer's body pending after
  // its signal stops still lets the post answer unavailable on time.
  let end: (outcome: SlackPostOutcome) => void = () => undefined;
  const ended = new Promise<SlackPostOutcome>((resolve) => {
    end = resolve;
  });
  const stop = () => {
    controller.abort();
    end({ ok: false, reason: 'unavailable' });
  };
  const timer = setTimeout(stop, options.timeoutMs ?? SLACK_POST_TIMEOUT_MS);
  options.signal?.addEventListener('abort', stop, { once: true });
  try {
    return await Promise.race([attempt(fetch, checked.url, sent, controller.signal), ended]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', stop);
  }
}

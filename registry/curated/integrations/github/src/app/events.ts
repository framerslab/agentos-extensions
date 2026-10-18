/**
 * @fileoverview A GitHub App's webhook deliveries read as typed events. The webhook's secret is checked first (an empty
 * one is the host's fault, whatever the delivery), then a delivery's size, then its `X-Hub-Signature-256` on the raw
 * body, then its `X-GitHub-Delivery` id, and only then is its body parsed; each event
 * an app reading its installations' repositories acts on (a push, an installation's actions, the repositories it
 * reaches, its account renamed, a ping) is answered with the fields that reading needs, and every other delivery as
 * `other`. No text of a payload reaches an error, and nothing of a payload but those fields leaves the reader.
 * Payloads as https://docs.github.com/en/webhooks/webhook-events-and-payloads documents them.
 * @module agentos-ext-github/app/events
 */

import { readCapped, ReadCapExceeded } from '@framers/agentos-ext-account-sources';
import { arrayOf, numberIn, objectOf, stringIn } from './http.js';
import { accountOf, type GitHubAccount } from './installations.js';
import { requireWebhookSecret, verifyWebhookSignature } from './webhook.js';

/** The largest delivery read by default: 25 MiB (26,214,400 bytes). GitHub delivers no payload past 25 MB. */
export const DEFAULT_MAX_DELIVERY_BYTES = 26_214_400;

/**
 * Why a delivery was refused: `too_large` past the cap (answer 413), `signature` for a signature that does not hold
 * or is missing (answer 401), `delivery` for a missing or malformed `X-GitHub-Delivery` (answer 400), `body` for a
 * signed body that is not a JSON object in UTF-8 (answer 400).
 */
export type WebhookRefusalReason = 'too_large' | 'signature' | 'delivery' | 'body';

/** A delivery the reader refused. The message names the reason alone, never the body or a header's value. */
export class WebhookDeliveryRefused extends Error {
  /** @param reason Why the delivery was refused. */
  constructor(readonly reason: WebhookRefusalReason) {
    super(`the webhook delivery was refused: ${reason}`);
    this.name = 'WebhookDeliveryRefused';
  }
}

/** A repository an event names. */
export interface GitHubEventRepository {
  id: number;
  /** `owner/name`. */
  fullName: string;
}

/** A push to a repository the installation reaches. */
export interface GitHubPushEvent {
  kind: 'push';
  installationId: number;
  repository: GitHubEventRepository & { defaultBranch: string };
  /** The full ref pushed, such as `refs/heads/main` or `refs/tags/v1.0.0`. */
  ref: string;
  /** The ref's commit before the push; zeros when the push created the ref. */
  before: string;
  /** The ref's commit after the push; zeros when the push deleted the ref. */
  after: string;
  created: boolean;
  deleted: boolean;
  forced: boolean;
  /** True when the push moved the repository's default branch: `ref` is `refs/heads/<default branch>` and it was not deleted. */
  toDefaultBranch: boolean;
}

/** An installation's action: installed, uninstalled, suspended, unsuspended, or new permissions accepted. */
export interface GitHubInstallationEvent {
  kind: 'installation';
  action: 'created' | 'deleted' | 'suspend' | 'unsuspend' | 'new_permissions_accepted';
  installationId: number;
  /** The account the app is installed on, or null when GitHub sends none. */
  account: GitHubAccount | null;
  /** The repositories the installation can access, where GitHub lists them (an installation on selected repositories); else empty. */
  repositories: GitHubEventRepository[];
}

/**
 * Repositories added to or removed from an installation. When the installation goes from all of an account's
 * repositories to a selection, GitHub sends `removed` with no repository listed, so `removed` can be empty while
 * repositories left: read the installation's repositories again.
 */
export interface GitHubInstallationRepositoriesEvent {
  kind: 'installation_repositories';
  action: 'added' | 'removed';
  installationId: number;
  /** Whether the installation now reaches all of the account's repositories or a selection. */
  selection: 'all' | 'selected';
  added: GitHubEventRepository[];
  removed: GitHubEventRepository[];
}

/** The account an installation is on was renamed. */
export interface GitHubInstallationTargetEvent {
  kind: 'installation_target';
  action: 'renamed';
  installationId: number;
  /** The account under its new login, or an enterprise's new slug. */
  account: GitHubAccount;
}

/** GitHub's check that the webhook is set up. */
export interface GitHubPingEvent {
  kind: 'ping';
}

/** A delivery the reader does not read: another event, another action, or a payload without the fields above. */
export interface GitHubOtherEvent {
  kind: 'other';
}

/** A delivery's event. */
export type GitHubEvent =
  | GitHubPushEvent
  | GitHubInstallationEvent
  | GitHubInstallationRepositoriesEvent
  | GitHubInstallationTargetEvent
  | GitHubPingEvent
  | GitHubOtherEvent;

/** A delivery read. */
export interface GitHubDelivery {
  /** The `X-GitHub-Delivery` GUID: the same for a redelivery, so a receiver applies each id once. */
  id: string;
  /** The `X-GitHub-Event` name when it is an event name (lower case letters, digits and underscores), else `''`. */
  name: string;
  event: GitHubEvent;
}

/** What a delivery is read from: its headers and its raw body exactly as received. */
export interface WebhookDeliveryInput {
  headers: { get(name: string): string | null };
  body: Uint8Array;
}

/** What a request is read from: a `Request`, or anything with its headers and its body's stream. */
export interface WebhookRequestInput {
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}

/** The reader's bound. */
export interface ReadWebhookOptions {
  /** The largest body read, in bytes ({@link DEFAULT_MAX_DELIVERY_BYTES} when absent). */
  maxBytes?: number;
}

const INSTALLATION_ACTIONS: ReadonlySet<string> = new Set(['created', 'deleted', 'suspend', 'unsuspend', 'new_permissions_accepted']);

/** A delivery id: a GUID's hexadecimal digits and hyphens. */
const DELIVERY_ID = /^[0-9A-Fa-f-]{8,64}$/;

/** An event name as GitHub sends it. */
const EVENT_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** A commit's SHA-1 or SHA-256 name. */
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function booleanIn(fields: Record<string, unknown>, key: string, what: string): boolean {
  const value = fields[key];
  if (typeof value !== 'boolean') throw new Error(`GitHub sent ${what} without a boolean ${key}`);
  return value;
}

function commitIn(fields: Record<string, unknown>, key: string): string {
  const value = stringIn(fields, key, 'a push');
  if (!COMMIT.test(value)) throw new Error(`GitHub sent a push whose ${key} is not a commit`);
  return value;
}

function installationIdOf(payload: Record<string, unknown>): number {
  return numberIn(objectOf(payload.installation, "an event's installation"), 'id', "an event's installation");
}

function repositoriesIn(value: unknown, what: string): GitHubEventRepository[] {
  return arrayOf(value, what).map((entry) => {
    const repository = objectOf(entry, what);
    return { id: numberIn(repository, 'id', what), fullName: stringIn(repository, 'full_name', what) };
  });
}

function pushOf(payload: Record<string, unknown>): GitHubPushEvent {
  const repository = objectOf(payload.repository, "a push's repository");
  const defaultBranch = stringIn(repository, 'default_branch', "a push's repository");
  const ref = stringIn(payload, 'ref', 'a push');
  const deleted = booleanIn(payload, 'deleted', 'a push');
  return {
    kind: 'push',
    installationId: installationIdOf(payload),
    repository: { id: numberIn(repository, 'id', "a push's repository"), fullName: stringIn(repository, 'full_name', "a push's repository"), defaultBranch },
    ref,
    before: commitIn(payload, 'before'),
    after: commitIn(payload, 'after'),
    created: booleanIn(payload, 'created', 'a push'),
    deleted,
    forced: booleanIn(payload, 'forced', 'a push'),
    toDefaultBranch: !deleted && ref === `refs/heads/${defaultBranch}`,
  };
}

function installationOf(payload: Record<string, unknown>): GitHubEvent {
  const action = stringIn(payload, 'action', 'an installation event');
  if (!INSTALLATION_ACTIONS.has(action)) return { kind: 'other' };
  const installation = objectOf(payload.installation, "an event's installation");
  return {
    kind: 'installation',
    action: action as GitHubInstallationEvent['action'],
    installationId: numberIn(installation, 'id', "an event's installation"),
    account: installation.account === null || installation.account === undefined ? null : accountOf(installation.account),
    repositories: payload.repositories === undefined || payload.repositories === null ? [] : repositoriesIn(payload.repositories, 'an installed repository'),
  };
}

function installationRepositoriesOf(payload: Record<string, unknown>): GitHubEvent {
  const action = stringIn(payload, 'action', 'an installation_repositories event');
  if (action !== 'added' && action !== 'removed') return { kind: 'other' };
  const selection = stringIn(payload, 'repository_selection', 'an installation_repositories event');
  if (selection !== 'all' && selection !== 'selected') return { kind: 'other' };
  return {
    kind: 'installation_repositories',
    action,
    installationId: installationIdOf(payload),
    selection,
    added: repositoriesIn(payload.repositories_added, 'an added repository'),
    removed: repositoriesIn(payload.repositories_removed, 'a removed repository'),
  };
}

function installationTargetOf(payload: Record<string, unknown>): GitHubEvent {
  if (stringIn(payload, 'action', 'an installation_target event') !== 'renamed') return { kind: 'other' };
  return { kind: 'installation_target', action: 'renamed', installationId: installationIdOf(payload), account: accountOf(payload.account) };
}

/** The event a payload holds, by the delivery's event name; `other` for a name or a payload it does not read. */
function eventOf(name: string, payload: Record<string, unknown>): GitHubEvent {
  try {
    if (name === 'push') return pushOf(payload);
    if (name === 'installation') return installationOf(payload);
    if (name === 'installation_repositories') return installationRepositoriesOf(payload);
    if (name === 'installation_target') return installationTargetOf(payload);
    if (name === 'ping') return { kind: 'ping' };
  } catch {
    // A payload without a field the event needs is an event this reader does not read; its text is not kept.
  }
  return { kind: 'other' };
}

/**
 * Reads a delivery already received whole: throws a `TypeError` for an empty secret before anything else, then refuses
 * the delivery past `maxBytes` (`too_large`), when its signature under `secret` does not hold (`signature`), when it
 * has no usable `X-GitHub-Delivery` (`delivery`), or when its signed body is not a JSON object in UTF-8 (`body`), each
 * with {@link WebhookDeliveryRefused}; answers its id, its event's name and its typed event otherwise. A receiver answers GitHub at once and applies each delivery id once: GitHub
 * expects a 2xx within 10 seconds, and a redelivery carries the id of the delivery it repeats.
 *
 * @param input The delivery's headers and its raw body exactly as received.
 * @param secret The webhook's secret, never empty.
 * @param options The largest body read.
 * @throws TypeError when the secret is empty or missing, whatever the delivery and before its size is measured: anyone
 * can sign a delivery under an empty key, so the fault is the host's configuration.
 */
export function readWebhookDelivery(input: WebhookDeliveryInput, secret: string, options: ReadWebhookOptions = {}): GitHubDelivery {
  requireWebhookSecret(secret);
  if (input.body.byteLength > (options.maxBytes ?? DEFAULT_MAX_DELIVERY_BYTES)) throw new WebhookDeliveryRefused('too_large');
  if (!verifyWebhookSignature(input.body, input.headers.get('x-hub-signature-256'), secret)) throw new WebhookDeliveryRefused('signature');
  const id = (input.headers.get('x-github-delivery') ?? '').trim();
  if (!DELIVERY_ID.test(id)) throw new WebhookDeliveryRefused('delivery');
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.body));
  } catch {
    // The parser's message would quote the body.
    throw new WebhookDeliveryRefused('body');
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new WebhookDeliveryRefused('body');
  const header = (input.headers.get('x-github-event') ?? '').trim();
  const name = EVENT_NAME.test(header) ? header : '';
  return { id, name, event: eventOf(name, payload as Record<string, unknown>) };
}

/**
 * Reads a delivery from a request: an empty secret throws a `TypeError` before a byte of the body is read; then its
 * body is read as it streams and refused at `maxBytes` (`too_large`), before any check that needs it whole, the stream
 * then cancelled unread; a `Content-Length` past the cap is refused before a byte is read. Then as
 * {@link readWebhookDelivery}.
 *
 * @param request The request, or its headers and body stream.
 * @param secret The webhook's secret, never empty.
 * @param options The largest body read.
 * @throws TypeError when the secret is empty or missing, before the body is read.
 */
export async function readWebhookRequest(request: WebhookRequestInput, secret: string, options: ReadWebhookOptions = {}): Promise<GitHubDelivery> {
  requireWebhookSecret(secret);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_DELIVERY_BYTES;
  const declared = request.headers.get('content-length');
  let body: Uint8Array;
  try {
    body = await readCapped(new Response(request.body, { headers: declared === null ? {} : { 'content-length': declared } }), maxBytes);
  } catch (error) {
    if (error instanceof ReadCapExceeded) throw new WebhookDeliveryRefused('too_large');
    throw error;
  }
  return readWebhookDelivery({ headers: request.headers, body }, secret, { maxBytes });
}

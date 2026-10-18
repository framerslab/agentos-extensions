/**
 * @fileoverview A GitHub App's webhook deliveries read as typed events, over deliveries built the way GitHub sends
 * them: the `X-GitHub-Event`, `X-GitHub-Delivery` and `X-Hub-Signature-256` headers and a JSON body whose payloads
 * keep the fields of GitHub's push, installation, installation_repositories, installation_target and ping events
 * (https://docs.github.com/en/webhooks/webhook-events-and-payloads), each signed with the webhook's secret.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readWebhookDelivery, readWebhookRequest, WebhookDeliveryRefused, type GitHubDelivery } from '../documents/index.js';

const SECRET = 'test-webhook-secret';
const DELIVERY_ID = '72d3162e-cc78-11e3-81ab-4c9367dc0958';
const C1 = '1'.repeat(40);
const C2 = '2'.repeat(40);
const ZERO = '0'.repeat(40);

/** The fields GitHub sends for the person who caused an event; the reader takes none of them. */
const SENDER = { login: 'test-person', id: 501, type: 'User' };

/** A push to the handbook's default branch, as an app's delivery carries it. */
const PUSH = {
  ref: 'refs/heads/main',
  before: C1,
  after: C2,
  repository: {
    id: 77,
    node_id: 'R_test77',
    name: 'handbook',
    full_name: 'acme-team/handbook',
    private: true,
    default_branch: 'main',
    master_branch: 'main',
  },
  pusher: { name: 'test-person', email: null },
  sender: SENDER,
  installation: { id: 5, node_id: 'I_test5' },
  created: false,
  deleted: false,
  forced: false,
  base_ref: null,
  compare: `https://github.com/acme-team/handbook/compare/${C1.slice(0, 12)}...${C2.slice(0, 12)}`,
  commits: [],
  head_commit: null,
};

/** The installation of the app on the acme-team organization, on a selection of its repositories. */
const INSTALLATION = {
  id: 5,
  account: { login: 'acme-team', id: 901, type: 'Organization' },
  repository_selection: 'selected',
  app_id: 1,
  target_type: 'Organization',
};

/** A repository as an installation event lists it. */
function listed(id: number, fullName: string): Record<string, unknown> {
  return { id, node_id: `R_test${id}`, name: fullName.split('/')[1], full_name: fullName, private: true };
}

/** A delivery as GitHub sends it: the event's name, the delivery's id and the body's signature under `secret`. */
function delivery(
  event: string | null,
  payload: unknown,
  { id = DELIVERY_ID, secret = SECRET, body }: { id?: string | null; secret?: string; body?: Uint8Array } = {},
): { headers: Headers; body: Uint8Array } {
  const bytes = body ?? new TextEncoder().encode(JSON.stringify(payload));
  const headers = new Headers({
    'content-type': 'application/json',
    'user-agent': 'GitHub-Hookshot/044aadd',
    'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(bytes).digest('hex')}`,
  });
  if (event !== null) headers.set('x-github-event', event);
  if (id !== null) headers.set('x-github-delivery', id);
  return { headers, body: bytes };
}

/** What `readWebhookDelivery` refused the delivery for, or the delivery it read. */
function refusalOf(read: () => GitHubDelivery): string | GitHubDelivery {
  try {
    return read();
  } catch (error) {
    if (error instanceof WebhookDeliveryRefused) return error.reason;
    throw error;
  }
}

describe("a GitHub App's webhook deliveries", () => {
  it('reads a push: the installation, the repository and its default branch, the ref and the commits around it', () => {
    const read = readWebhookDelivery(delivery('push', PUSH), SECRET);

    expect(read).toEqual({
      id: DELIVERY_ID,
      name: 'push',
      event: {
        kind: 'push',
        installationId: 5,
        repository: { id: 77, fullName: 'acme-team/handbook', defaultBranch: 'main' },
        ref: 'refs/heads/main',
        before: C1,
        after: C2,
        created: false,
        deleted: false,
        forced: false,
        toDefaultBranch: true,
      },
    });
  });

  it('marks a push that moved the default branch, and no other: a force push counts, a branch, a tag and a deletion do not', () => {
    const cases: readonly [Record<string, unknown>, boolean][] = [
      [{ forced: true }, true],
      [{ ref: 'refs/heads/feature' }, false],
      [{ ref: 'refs/tags/v1.0.0' }, false],
      [{ ref: 'refs/heads/mainline' }, false],
      [{ deleted: true, after: ZERO }, false],
      [{ created: true, before: ZERO, ref: 'refs/heads/draft' }, false],
    ];
    for (const [change, toDefaultBranch] of cases) {
      const read = readWebhookDelivery(delivery('push', { ...PUSH, ...change }), SECRET);
      expect(read.event.kind).toBe('push');
      expect(read.event.kind === 'push' && read.event.toDefaultBranch).toBe(toDefaultBranch);
    }
  });

  it("reads each of an installation's actions, with the account and the repositories a new installation lists", () => {
    const created = readWebhookDelivery(
      delivery('installation', {
        action: 'created',
        installation: INSTALLATION,
        repositories: [listed(77, 'acme-team/handbook'), listed(78, 'acme-team/large')],
        requester: null,
        sender: SENDER,
      }),
      SECRET,
    );
    expect(created.event).toEqual({
      kind: 'installation',
      action: 'created',
      installationId: 5,
      account: { login: 'acme-team', id: 901 },
      repositories: [
        { id: 77, fullName: 'acme-team/handbook' },
        { id: 78, fullName: 'acme-team/large' },
      ],
    });

    for (const action of ['deleted', 'suspend', 'unsuspend', 'new_permissions_accepted'] as const) {
      const read = readWebhookDelivery(delivery('installation', { action, installation: INSTALLATION, sender: SENDER }), SECRET);
      expect(read.event).toEqual({ kind: 'installation', action, installationId: 5, account: { login: 'acme-team', id: 901 }, repositories: [] });
    }

    const enterprise = readWebhookDelivery(
      delivery('installation', { action: 'suspend', installation: { ...INSTALLATION, account: { slug: 'acme-enterprise', id: 902 } }, sender: SENDER }),
      SECRET,
    );
    expect(enterprise.event).toMatchObject({ kind: 'installation', account: { login: 'acme-enterprise', id: 902 } });

    const unknown = readWebhookDelivery(delivery('installation', { action: 'transferred', installation: INSTALLATION, sender: SENDER }), SECRET);
    expect(unknown).toEqual({ id: DELIVERY_ID, name: 'installation', event: { kind: 'other' } });
  });

  it("reads the repositories added to and removed from an installation, and the selection they leave", () => {
    const added = readWebhookDelivery(
      delivery('installation_repositories', {
        action: 'added',
        installation: INSTALLATION,
        repository_selection: 'selected',
        repositories_added: [listed(79, 'acme-team/notes')],
        repositories_removed: [],
        requester: null,
        sender: SENDER,
      }),
      SECRET,
    );
    expect(added.event).toEqual({
      kind: 'installation_repositories',
      action: 'added',
      installationId: 5,
      selection: 'selected',
      added: [{ id: 79, fullName: 'acme-team/notes' }],
      removed: [],
    });

    const removed = readWebhookDelivery(
      delivery('installation_repositories', {
        action: 'removed',
        installation: INSTALLATION,
        repository_selection: 'selected',
        repositories_added: [],
        repositories_removed: [listed(77, 'acme-team/handbook')],
        requester: null,
        sender: SENDER,
      }),
      SECRET,
    );
    expect(removed.event).toEqual({
      kind: 'installation_repositories',
      action: 'removed',
      installationId: 5,
      selection: 'selected',
      added: [],
      removed: [{ id: 77, fullName: 'acme-team/handbook' }],
    });

    // From all repositories to a selection, GitHub names none of the repositories that left.
    const narrowed = readWebhookDelivery(
      delivery('installation_repositories', {
        action: 'removed',
        installation: { ...INSTALLATION, repository_selection: 'selected' },
        repository_selection: 'selected',
        repositories_added: [],
        repositories_removed: [],
        requester: null,
        sender: SENDER,
      }),
      SECRET,
    );
    expect(narrowed.event).toMatchObject({ kind: 'installation_repositories', action: 'removed', selection: 'selected', removed: [] });
  });

  it('reads an account renamed under an installation, by its new login or an enterprise slug', () => {
    const renamed = readWebhookDelivery(
      delivery('installation_target', {
        action: 'renamed',
        account: { login: 'acme-renamed', id: 901, node_id: 'O_test901', avatar_url: 'https://avatars.example/901', html_url: 'https://github.com/acme-renamed' },
        changes: { login: { from: 'acme-team' } },
        target_type: 'Organization',
        installation: { id: 5, node_id: 'I_test5' },
        sender: SENDER,
      }),
      SECRET,
    );
    expect(renamed.event).toEqual({ kind: 'installation_target', action: 'renamed', installationId: 5, account: { login: 'acme-renamed', id: 901 } });

    const slug = readWebhookDelivery(
      delivery('installation_target', {
        action: 'renamed',
        account: { slug: 'acme-enterprise-renamed', id: 902, node_id: 'E_test902', avatar_url: 'https://avatars.example/902', html_url: 'https://github.com/enterprises/x' },
        changes: { slug: { from: 'acme-enterprise' } },
        target_type: 'Enterprise',
        installation: { id: 6, node_id: 'I_test6' },
      }),
      SECRET,
    );
    expect(slug.event).toEqual({ kind: 'installation_target', action: 'renamed', installationId: 6, account: { login: 'acme-enterprise-renamed', id: 902 } });
  });

  it('answers a ping, an event it does not read, and a payload without the fields it reads, naming no field of them', () => {
    expect(readWebhookDelivery(delivery('ping', { zen: 'Keep it logically awesome.', hook_id: 123, hook: { type: 'App' } }), SECRET)).toEqual({
      id: DELIVERY_ID,
      name: 'ping',
      event: { kind: 'ping' },
    });
    expect(readWebhookDelivery(delivery('issues', { action: 'opened', issue: { title: 'private words' }, sender: SENDER }), SECRET)).toEqual({
      id: DELIVERY_ID,
      name: 'issues',
      event: { kind: 'other' },
    });

    const { installation: _dropped, ...withoutInstallation } = PUSH;
    expect(readWebhookDelivery(delivery('push', withoutInstallation), SECRET).event).toEqual({ kind: 'other' });
    expect(readWebhookDelivery(delivery('push', { ...PUSH, after: 'not-a-commit' }), SECRET).event).toEqual({ kind: 'other' });
    expect(readWebhookDelivery(delivery('installation_repositories', { action: 'added', installation: INSTALLATION, sender: SENDER }), SECRET).event).toEqual({
      kind: 'other',
    });

    const odd = readWebhookDelivery(delivery('Push Event!', PUSH), SECRET);
    expect(odd).toEqual({ id: DELIVERY_ID, name: '', event: { kind: 'other' } });
    expect(readWebhookDelivery(delivery(null, PUSH), SECRET)).toEqual({ id: DELIVERY_ID, name: '', event: { kind: 'other' } });
  });

  it('refuses a delivery whose signature does not hold before it reads the body', () => {
    const signedElsewhere = delivery('push', PUSH, { secret: 'another-secret' });
    expect(refusalOf(() => readWebhookDelivery(signedElsewhere, SECRET))).toBe('signature');

    const unsigned = delivery('push', PUSH);
    unsigned.headers.delete('x-hub-signature-256');
    expect(refusalOf(() => readWebhookDelivery(unsigned, SECRET))).toBe('signature');

    // A body that is not JSON under a wrong signature is refused for its signature, never parsed.
    const garbled = delivery('push', null, { secret: 'another-secret', body: new TextEncoder().encode('{"private": ') });
    expect(refusalOf(() => readWebhookDelivery(garbled, SECRET))).toBe('signature');
  });

  it('refuses a delivery without a usable id, a body past the cap, and a signed body that is not a JSON object, quoting none of it', () => {
    expect(refusalOf(() => readWebhookDelivery(delivery('push', PUSH, { id: null }), SECRET))).toBe('delivery');
    expect(refusalOf(() => readWebhookDelivery(delivery('push', PUSH, { id: 'not a delivery id' }), SECRET))).toBe('delivery');

    const large = delivery('push', PUSH, { secret: 'another-secret' });
    expect(refusalOf(() => readWebhookDelivery(large, SECRET, { maxBytes: large.body.byteLength - 1 }))).toBe('too_large');
    expect(refusalOf(() => readWebhookDelivery(delivery('push', PUSH), SECRET, { maxBytes: 64 }))).toBe('too_large');

    for (const body of ['[1,2]', 'null', '"push"', '{"private words": ']) {
      const signed = delivery('push', null, { body: new TextEncoder().encode(body) });
      let failure: unknown;
      try {
        readWebhookDelivery(signed, SECRET);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(WebhookDeliveryRefused);
      expect((failure as WebhookDeliveryRefused).reason).toBe('body');
      expect((failure as Error).message).not.toContain('private');
    }

    const notUtf8 = delivery('push', null, { body: new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x31, 0x7d]) });
    expect(refusalOf(() => readWebhookDelivery(notUtf8, SECRET))).toBe('body');
  });

  it('throws a TypeError for an empty secret, whatever the delivery', () => {
    expect(() => readWebhookDelivery(delivery('push', PUSH, { secret: '' }), '')).toThrow(TypeError);
  });

  it('throws a TypeError for an empty secret before it measures or reads the body, whatever its size', async () => {
    const signed = delivery('push', PUSH, { secret: '' });
    expect(() => readWebhookDelivery(signed, '', { maxBytes: 64 })).toThrow(TypeError);

    let pulls = 0;
    const body = (): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls += 1;
            controller.enqueue(signed.body);
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
    for (const options of [{}, { maxBytes: 64 }]) {
      const refused: unknown = await readWebhookRequest({ headers: signed.headers, body: body() }, '', options).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(TypeError);
    }
    expect(pulls).toBe(0);
  });

  it("reads a request's body under the cap, and stops a stream that passes it", async () => {
    const { headers, body } = delivery('push', PUSH);
    const sent = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body.slice(0, 100));
        controller.enqueue(body.slice(100));
        controller.close();
      },
    });
    const whole = await readWebhookRequest({ headers, body: sent }, SECRET);
    expect(whole.event).toMatchObject({ kind: 'push', installationId: 5, toDefaultBranch: true });
    expect(whole.id).toBe(DELIVERY_ID);

    let pulled = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled += 65_536;
          controller.enqueue(new Uint8Array(65_536).fill(0x20));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const failure: unknown = await readWebhookRequest({ headers, body: endless }, SECRET, { maxBytes: 200_000 }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WebhookDeliveryRefused);
    expect((failure as WebhookDeliveryRefused).reason).toBe('too_large');
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(200_000 + 65_536);

    const declared = new Headers(headers);
    declared.set('content-length', String(10_000_000));
    let read = false;
    const stated = new ReadableStream<Uint8Array>(
      {
        pull() {
          read = true;
        },
      },
      { highWaterMark: 0 },
    );
    const refused: unknown = await readWebhookRequest({ headers: declared, body: stated }, SECRET, { maxBytes: 200_000 }).catch((error: unknown) => error);
    expect((refused as WebhookDeliveryRefused).reason).toBe('too_large');
    expect(read).toBe(false);
  });
});

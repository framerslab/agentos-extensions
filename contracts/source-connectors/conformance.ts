/**
 * @fileoverview The promises an account-source connector keeps, as `node:test` cases against its provider's synthetic
 * stand-in. Every connector keeps the common ones: a listing of an empty selection answers nothing and reaches no
 * provider; a read keeps the item it was asked for, names its connector, dates itself and answers text or bytes; a read
 * of an item the provider no longer holds answers it removed; an aborted call reaches no provider; and a failed change
 * request answers no cursor. The policy cases hold only where a connector's own documented behavior promises them: a
 * selection that names items answers exactly those, and a selection past the connector's limit is refused before any
 * request. A connector's installed contract registers the cases with {@link connectorConformance}; listing order,
 * cursor encoding, document normalization and scope isolation stay with the connector's own cases.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AccountSourceConnector, SourceItem, SourceSelection } from '@framers/agentos-ext-account-sources';

/** One connector opened against its provider's synthetic stand-in, fresh for each case. */
export interface ConnectorConformanceCase {
  /** The installed connector, ready for calls in one owner's scope. */
  readonly connector: AccountSourceConnector;
  /** A selection the connector accepts that covers `present`: the item itself, or the container that holds it. */
  readonly selection: SourceSelection;
  /** The id of an item the stand-in holds. */
  readonly present: string;
  /** A well-formed id of an item the stand-in answers as no longer held. */
  readonly removed: string;
  /** A cursor the connector accepts for `changesSince` of `selection`. */
  readonly cursor: string;
  /** Well-formed item ids, more than one selection admits; required when the subject's policy sets `limitsSelection`. */
  readonly oversized?: readonly string[];
  /** The number of requests the stand-in has received so far. */
  requests(): number;
  /** Makes the stand-in fail the next request of the connector's change set. */
  failChanges(): void;
  /** Releases the connector, the stand-in and any storage the case opened. */
  close(): Promise<void>;
}

/** The promises a connector keeps by its own documented behavior, beyond those every connector keeps. */
export interface ConnectorConformancePolicy {
  /**
   * The selection names the items themselves: `list` answers exactly the held ones and names the others removed, and
   * the changes of an empty selection are none, answered without a request. Leave it out for a connector whose
   * selection names containers, such as repositories.
   */
  readonly selectsItems?: boolean;
  /** The connector refuses a selection of more ids than it admits, before any request. */
  readonly limitsSelection?: boolean;
}

/** A connector bound to the suite: the name its case titles carry, its own policy and a factory for a fresh case. */
export interface ConnectorConformanceSubject {
  /** The connector's name in each case title. */
  readonly name: string;
  /** The policy cases registered besides the common ones; none when absent. */
  readonly policy?: ConnectorConformancePolicy;
  /** Opens a fresh connector against a fresh stand-in. */
  open(): Promise<ConnectorConformanceCase>;
}

const item = (id: string): SourceItem => ({ id, title: '', size: null, version: null });

/**
 * Registers the conformance cases for one connector with `node:test`: the common cases always, and the policy cases
 * its subject declares. Each case opens its own connector and closes it whatever the outcome.
 *
 * @param subject The connector's name, its policy and its case factory.
 */
export function connectorConformance(subject: ConnectorConformanceSubject): void {
  const scenario = (name: string, work: (c: ConnectorConformanceCase) => Promise<void>): void => {
    test(`${subject.name}: ${name}`, { timeout: 45_000 }, async () => {
      const c = await subject.open();
      try { await work(c); } finally { await c.close(); }
    });
  };

  scenario('a listing of an empty selection answers nothing and reaches no provider', async (c) => {
    const before = c.requests();
    assert.deepEqual(await c.connector.list({ ids: [] }), { items: [], gone: [] });
    assert.equal(c.requests(), before);
  });

  scenario('a read keeps its item, names its connector, dates itself and answers text or bytes', async (c) => {
    const read = await c.connector.read(item(c.present));
    if (!('content' in read)) assert.fail('present_item_unread');
    assert.equal(read.item.id, c.present);
    assert.equal(read.ref.kind, c.connector.kind);
    assert.match(read.ref.readAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    assert.ok(Number.isFinite(Date.parse(read.ref.readAt)));
    if ('text' in read.content) assert.equal(typeof read.content.text, 'string');
    else {
      assert.ok(read.content.bytes instanceof Uint8Array);
      assert.equal(typeof read.content.mediaType, 'string');
    }
  });

  scenario('a read of an item the provider no longer holds answers it removed', async (c) => {
    assert.deepEqual(await c.connector.read(item(c.removed)), { id: c.removed, reason: 'removed' });
  });

  scenario('an aborted call is refused and reaches no provider', async (c) => {
    const controller = new AbortController();
    controller.abort();
    const before = c.requests();
    await assert.rejects(c.connector.list(c.selection, controller.signal));
    await assert.rejects(c.connector.read(item(c.present), controller.signal));
    await assert.rejects(c.connector.changesSince(c.cursor, c.selection, controller.signal));
    assert.equal(c.requests(), before);
  });

  scenario('a failed change request answers no cursor', async (c) => {
    c.failChanges();
    await assert.rejects(c.connector.changesSince(c.cursor, c.selection));
  });

  if (subject.policy?.selectsItems) {
    scenario('a selection of items lists exactly the held ones and names the others removed', async (c) => {
      const listed = await c.connector.list({ ids: [c.present, c.removed] });
      assert.deepEqual(listed.items.map((entry) => entry.id), [c.present]);
      assert.deepEqual(listed.gone, [{ id: c.removed, reason: 'removed' }]);
    });

    scenario('the changes of an empty selection are none and reach no provider', async (c) => {
      const before = c.requests();
      const changes = await c.connector.changesSince(c.cursor, { ids: [] });
      assert.deepEqual([changes.changed, changes.gone], [[], []]);
      assert.equal(c.requests(), before);
    });
  }

  if (subject.policy?.limitsSelection) {
    scenario('a selection past the limit is refused before any request', async (c) => {
      const oversized = c.oversized ?? [];
      assert.ok(oversized.length > 0, 'oversized_selection_missing');
      const before = c.requests();
      await assert.rejects(c.connector.list({ ids: oversized }));
      await assert.rejects(c.connector.changesSince(c.cursor, { ids: oversized }));
      assert.equal(c.requests(), before);
    });
  }
}

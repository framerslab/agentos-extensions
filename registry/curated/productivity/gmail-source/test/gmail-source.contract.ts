import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GmailSourceConnector, runGmailSourceSync, verifyGmailSource } from '@framers/agentos-ext-gmail-source';
import { createSourceDerivation } from '@framers/agentos/cognition/library';
import { type SourceSyncRunResult } from '@framers/agentos-ext-account-sources';
import { makeFixture, type ContractFixture, type Worker } from './contract-fixture.js';
import { latch, bounded, mail, change, failure, day, paths } from './standin.js';

function scenario(name: string, work: (h: ContractFixture) => Promise<void>): void {
  test(name, { timeout: 45_000 }, async () => {
    const h = await makeFixture();
    try { await work(h); } finally { await h.close(); }
  });
}
async function run(h: ContractFixture, worker: Worker = h.first, signal?: AbortSignal): Promise<SourceSyncRunResult> {
  const disposed: Array<Pick<GmailSourceConnector, 'list'>> = [];
  const original = GmailSourceConnector.prototype.dispose;
  GmailSourceConnector.prototype.dispose = function (this: GmailSourceConnector) {
    disposed.push(this); return original.call(this);
  };
  let result: SourceSyncRunResult;
  try { result = await runGmailSourceSync(worker.options, 'scheduled', signal); }
  finally { GmailSourceConnector.prototype.dispose = original; }
  assert.equal(disposed.length, ['idle', 'unavailable'].includes(result.kind) ? 0 : 1, 'runner_disposal');
  for (const connector of disposed) {
    await assert.rejects(connector.list({ ids: ['a1'] }), /source_sync_cancelled/);
  }
  return result;
}
async function completed(h: ContractFixture, worker: Worker = h.first): Promise<void> {
  assert.equal((await run(h, worker)).kind, 'completed');
}
async function result(h: ContractFixture, id: string, sourceId = 'a1'): Promise<void> {
  const dependency = (await h.first.store.documents(h.scope)).find((row) => row.dependency.sourceId === sourceId)!.dependency;
  const ticket = await h.first.store.fence.capture(h.scope); assert.ok(ticket);
  assert.equal(await h.first.store.fence.commit(ticket, id, createSourceDerivation([dependency]),
    'Fixture whole mixed answer', h.context), true);
  await h.db.run(`INSERT INTO "${h.prefix}_answers" VALUES($1,$2,$3)`, [h.scope.ownerId, id, 'Fixture whole mixed answer']);
}

scenario('installed callback verifies identity without claiming synchronization', async (h) => {
  const before = await h.first.store.snapshot(h.scope); assert.ok(before);
  const generation = before.state.generation;
  assert.deepEqual(await verifyGmailSource(h.first.options, generation), { kind: 'verified' });
  const after = await h.first.store.snapshot(h.scope); assert.ok(after);
  assert.equal(after.state.generation, generation);
  assert.equal(after.state.cursor, before.state.cursor);
  assert.equal(after.state.lastSyncAt, before.state.lastSyncAt);
  assert.deepEqual(after.checkpoint, before.checkpoint);
  assert.deepEqual(await h.first.store.documents(h.scope), []);
  assert.deepEqual(h.server.trace.map((row) => row.path), [paths.token, paths.profile]);
  const attempts = await h.attempts();
  assert.equal(attempts.length, 2);
  assert.ok(attempts.every((row) => row.mailbox_key === 'owner-probe'));
  assert.equal(await h.first.values(h.scope).get('grant') === null, false);
  h.server.trace.length = 0;
  await completed(h, await h.replaceSecond());
  const api = h.server.trace.filter((row) => row.method === 'GET');
  assert.deepEqual(api.map((row) => row.path), [paths.profile, paths.list, paths.labels, paths.thread('a1'), paths.history]);
  assert.equal(api.at(-1)!.anchor, '100');
  assert.equal((await h.first.store.snapshot(h.scope))!.state.cursor, '110');
  assert.equal((await h.first.store.documents(h.scope)).length, 1);
  const priorIds = new Set(attempts.map((row) => row.attempt_id)); const post = (await h.attempts()).filter((row) => !priorIds.has(row.attempt_id));
  assert.ok(post.every((row) => row.mailbox_key === 'mailbox-fixture'));
  assert.equal(new Set((await h.attempts()).map((row) => row.attempt_id)).size, (await h.attempts()).length);
  assert.equal((await run(h)).kind, 'idle');
});

scenario('a new pool resumes a partial first scan and commits only after pending work', async (h) => {
  await h.policy({ maxChangedPerLease: 1 });
  h.server.listIds = ['a1', 'b2']; h.server.threads.set('b2', mail('b2', h.now()));
  assert.equal((await run(h)).kind, 'yielded');
  assert.equal((await h.first.store.documents(h.scope)).length, 1);
  const middle = (await h.first.store.snapshot(h.scope))!;
  assert.equal(middle.state.cursor, null); assert.equal(middle.state.lastSyncAt, null);
  assert.equal(middle.checkpoint!.fromCursor, '100');
  const before = h.server.trace.length;
  const next = await h.replaceSecond();
  assert.equal((await run(h, next)).kind, 'yielded');
  assert.equal((await h.first.store.documents(h.scope)).length, 2);
  await completed(h, await h.replaceSecond());
  assert.equal((await h.first.store.snapshot(h.scope))!.state.cursor, '110');
  assert.equal(h.server.trace.filter((row) => row.path === paths.list).length, 1);
  assert.equal(h.server.trace.filter((row) => row.path === paths.thread('a1')).length, 1);
  assert.equal(h.server.trace.slice(before).find((row) => row.method === 'GET')!.path, paths.profile);
  assert.equal((await h.rows('body')).length, 2); assert.equal((await h.rows('passages')).length, 2);
});

scenario('canonical rereads resolve repeated events, deleted messages and missing threads', async (h) => {
  h.server.threads.set('a1', mail('a1', h.now(), ['Keep this.', 'Remove this.']));
  await completed(h); await result(h, 'answer-a');
  h.advance(900_000); h.server.profileHistory = '120';
  h.server.threads.set('a1', mail('a1', h.now(), ['Keep this.']));
  h.server.history = () => ({ historyId: '130', history: [change('120', 'a1', 'messagesDeleted'),
    change('125', 'a1', 'labelsRemoved'), change('130', 'a1', 'messagesAdded')] });
  const before = h.server.trace.length;
  await completed(h, await h.replaceSecond());
  assert.equal(h.server.trace.slice(before).filter((row) => row.path === paths.thread('a1')).length, 1);
  const stored = (await h.rows('body'))[0]!;
  assert.ok(String(stored.body).includes('Keep this.')); assert.equal(String(stored.body).includes('Remove this.'), false);
  assert.equal((await h.first.store.documents(h.scope))[0]!.messages.length, 1);
  assert.equal(await h.first.store.fence.deliver('answer-a', h.context, () => true), false);
  assert.deepEqual(await h.rows('answers'), []);
  h.advance(900_000); h.server.threads.delete('a1');
  h.server.history = () => ({ historyId: '140', history: [change('140', 'a1', 'messagesDeleted')] });
  await completed(h); await h.assertMailEmpty();
  assert.equal((await h.first.store.snapshot(h.scope))!.state.cursor, '140');
});

scenario('history expiry starts bounded recovery without deleting an unlisted retained source', async (h) => {
  h.server.listIds = ['a1', 'b2']; h.server.threads.set('b2', mail('b2', h.now()));
  await completed(h); h.advance(900_000);
  h.server.listIds = ['b2']; h.server.profileHistory = '200';
  h.server.enqueue(paths.history, failure(404, 'notFound'));
  h.server.history = () => ({ historyId: '210' });
  const before = h.server.trace.length;
  await completed(h, await h.replaceSecond());
  assert.deepEqual((await h.first.store.documents(h.scope)).map((row) => row.dependency.sourceId).sort(), ['a1', 'b2']);
  const trace = h.server.trace.slice(before).filter((row) => row.method === 'GET');
  assert.deepEqual(trace.filter((row) => row.path === paths.history).map((row) => row.anchor), ['110', '200']);
  assert.ok(trace.findIndex((row) => row.path === paths.list) > trace.findIndex((row) => row.path === paths.profile));
  assert.equal((await h.first.store.snapshot(h.scope))!.state.cursor, '210');
  h.advance(day); h.server.profileHistory = '300'; h.server.history = () => ({ historyId: '310' });
  const lists = h.server.trace.filter((row) => row.path === paths.list).length;
  await completed(h);
  assert.equal(h.server.trace.filter((row) => row.path === paths.list).length, lists + 1);
  assert.equal((await h.first.store.snapshot(h.scope))!.lastReconcileAt, h.now());
});

scenario('failed reads preserve cursor and five-attempt episodes across replacement', async (h) => {
  await completed(h); h.advance(900_000);
  h.server.history = () => ({ historyId: '120', history: [change('120', 'a1', 'messagesAdded')] });
  for (let n = 0; n < 5; n++) h.server.enqueue(paths.thread('a1'), failure(503, 'backendError'));
  for (let n = 1; n <= 5; n++) {
    const at = h.now(); const attempt = await run(h, await h.replaceSecond());
    assert.equal(attempt.kind, 'deferred'); if (attempt.kind !== 'deferred') throw new Error('expected_deferred');
    assert.equal(attempt.reason, 'provider_unavailable');
    assert.equal((await h.first.store.snapshot(h.scope))!.state.cursor, '110');
    const work = await h.work('a1'); assert.equal(work.attempts, n);
    if (n === 5) assert.ok(attempt.retryAt >= at + 900_000);
    const sent = h.server.trace.length;
    assert.equal((await run(h)).kind, 'idle'); assert.equal(h.server.trace.length, sent);
    h.advance(attempt.retryAt - h.now());
  }
  await completed(h, await h.replaceSecond());
  assert.equal((await h.first.store.snapshot(h.scope))!.state.cursor, '120');
  assert.equal((await h.rows('body')).length, 1);
});

scenario('long provider waits survive a new quota instance and send no early request', async (h) => {
  h.server.enqueue(paths.profile, { ...failure(429, 'userRateLimitExceeded'), headers: { 'retry-after': '172800' } });
  const at = h.now(); const deferred = await run(h);
  assert.equal(deferred.kind, 'deferred'); if (deferred.kind !== 'deferred') throw new Error('expected_deferred');
  assert.equal(deferred.retryAt, at + 2 * day);
  const count = h.server.trace.length; const worker = await h.replaceSecond();
  assert.equal((await worker.quota.run({ projectKey: 'project-fixture', mailboxKey: 'owner-probe',
    method: 'profile', attemptId: 'denied-probe' }, async () => { throw new Error('unexpected_dispatch'); })).kind, 'deferred');
  assert.equal((await run(h, worker)).kind, 'idle'); assert.equal(h.server.trace.length, count);
  assert.equal((await h.first.store.snapshot(h.scope))!.state.cursor, null);
});

scenario('401 refresh is metered, grant loss purges and domain denial remains a fixed failure', async (h) => {
  h.server.enqueue(paths.profile, failure(401, 'authError'));
  assert.deepEqual(await verifyGmailSource(h.first.options, (await h.first.store.snapshot(h.scope))!.state.generation), { kind: 'verified' });
  assert.deepEqual(h.server.trace.map((row) => row.path), [paths.token, paths.profile, paths.token, paths.profile]);
  assert.equal((await h.attempts()).length, 4);
  await completed(h); await result(h, 'answer-a'); h.advance(900_000);
  h.server.enqueue(paths.token, { status: 400, body: { error: 'invalid_grant', error_description: 'fixture-private-error' } });
  assert.equal((await run(h)).kind, 'reconnect');
  assert.equal((await h.first.store.snapshot(h.scope))!.state.status, 'needs_reconnecting');
  await h.assertMailEmpty(); assert.equal(await h.first.values(h.scope).get('grant'), null);
  assert.equal(await h.first.store.fence.deliver('answer-a', h.context, () => true), false);
});
scenario('domain restriction does not become revoked permission', async (h) => {
  h.server.enqueue(paths.profile, failure(403, 'domainPolicy'));
  assert.deepEqual(await run(h), { kind: 'failed', reason: 'domain_policy' });
  assert.notEqual(await h.first.values(h.scope).get('grant'), null);
  assert.equal((await run(h)).kind, 'idle');
});

for (const heldPath of [paths.token, paths.thread('a1')] as const) {
  scenario('disconnect fences native pending ' + (heldPath === paths.token ? 'refresh' : 'mail read'), async (h) => {
    const hold = h.server.hold(heldPath, 'headers');
    const pending = run(h); await bounded(hold.entered.promise);
    const generation = (await h.first.store.snapshot(h.scope))!.state.generation;
    assert.deepEqual(await h.second.revocations.disconnect(h.scope, generation), { localPending: false, revocation: 'pending' });
    await h.assertMailEmpty(); hold.resume.resolve();
    assert.equal((await pending).kind, 'stale');
    await h.assertMailEmpty(); assert.equal(await h.first.values(h.scope).get('grant'), null);
    assert.equal((await h.second.revocations.revokeBatch()).confirmed, 1);
    assert.equal(h.server.trace.at(-1)!.path, paths.revoke);
  });
}
scenario('disconnect fences an indexing completion and preserves whole-result deletion', async (h) => {
  await completed(h); await result(h, 'answer-a'); h.advance(900_000);
  h.server.history = () => ({ historyId: '120', history: [change('120', 'a1', 'messagesAdded')] });
  const entered = latch(); const finish = latch();
  h.prepare = async () => { entered.resolve(); await finish.promise; return [1, 0, 0]; };
  const pending = run(h); await bounded(entered.promise);
  await h.second.revocations.disconnect(h.scope, (await h.first.store.snapshot(h.scope))!.state.generation);
  await h.assertMailEmpty(); finish.resolve(); assert.equal((await pending).kind, 'stale');
  await h.assertMailEmpty(); assert.equal(await h.first.store.fence.deliver('answer-a', h.context, () => true), false);
});
scenario('native body cancellation closes the response and leaves recoverable work', async (h) => {
  const hold = h.server.hold(paths.thread('a1'), 'body'); const controller = new AbortController();
  const pending = run(h, h.first, controller.signal); await bounded(hold.entered.promise);
  controller.abort(); assert.equal((await pending).kind, 'yielded');
  await bounded(hold.closed.promise); assert.equal(hold.interrupted, true); hold.resume.resolve();
  assert.equal((await h.first.store.snapshot(h.scope))!.state.cursor, null);
  assert.deepEqual(await h.first.store.documents(h.scope), []);
  assert.ok((await h.attempts()).every((row) => row.finished));
  await completed(h, await h.replaceSecond());
});

scenario('two pools cannot run the same connection concurrently', async (h) => {
  const hold = h.server.hold(paths.profile, 'headers'); const pending = run(h);
  await bounded(hold.entered.promise); const sent = h.server.trace.length;
  assert.equal((await runGmailSourceSync(h.second.options, 'scheduled')).kind, 'idle');
  assert.equal(h.server.trace.length, sent); hold.resume.resolve(); assert.equal((await pending).kind, 'completed');
});
scenario('closed storage is unavailable without constructing a provider', async (h) => {
  const worker = await h.replaceSecond(); await worker.close();
  assert.equal((await run(h, worker)).kind, 'unavailable');
  assert.equal(h.server.trace.length, 0);
});

scenario('independent label lifetime and bounded facade history remain enforced over HTTP', async (h) => {
  await h.policy({ maxHistoryPagesPerLease: 1 });
  const handle = await h.first.store.claim(h.scope, 'scheduled'); assert.ok(handle);
  const connector = h.connector(h.first, handle);
  const request = { scope: h.scope, generation: handle.lease.generation, cycleId: 'fixture-cycle',
    cutoff: h.now(), policy: h.currentPolicy() };
  try {
    h.server.labelSeconds = 1;
    const a = await connector.sync.readSource(request, 'a1'); assert.equal(a.kind, 'document');
    if (a.kind !== 'document') throw new Error('expected_document');
    assert.equal(a.document.cache.expiresAt, h.now() + 1000);
    assert.ok(JSON.stringify(a).includes('Fixture short label'));
    h.advance(1001);
    const b = await connector.sync.readSource(request, 'a1');
    assert.equal(JSON.stringify(b).includes('Fixture short label'), false);
    assert.equal(h.server.trace.filter((row) => row.path === paths.labels).length, 1);
    h.server.history = () => ({ historyId: '120', nextPageToken: 'next-recording', history: [change('120', 'a1', 'messagesAdded')] });
    await assert.rejects(connector.changesSince('110', { ids: ['a1'] }), /gmail_connector_history_bound/);
    h.server.enqueue(paths.history, failure(404, 'notFound'));
    await assert.rejects(connector.changesSince('110', { ids: ['a1'] }), /source_sync_history_expired/);
    assert.equal((await h.first.store.snapshot(h.scope))!.state.cursor, null);
  } finally { connector.dispose(); await h.first.store.release(handle); }
});

scenario('bounded scan, denied cache, expiry and second-account reads cannot leak mail', async (h) => {
  await h.policy({ scanPageSize: 1, maxScanPages: 1, maxCandidates: 1 });
  h.server.listIds = ['a1']; h.server.nextListToken = 'another-page';
  h.server.enqueue(paths.thread('a1'), { status: 200, body: mail('a1', h.now()), headers: { 'cache-control': 'no-store' } });
  const boundedResult = await run(h); assert.equal(boundedResult.kind, 'completed');
  if (boundedResult.kind !== 'completed') throw new Error('expected_completed');
  assert.equal(boundedResult.bounded, true);
  assert.equal((await h.first.store.snapshot(h.scope))!.state.progress.skipped, 1);
  await h.assertMailEmpty();
  h.advance(900_000); h.server.nextListToken = null;
  h.server.history = () => ({ historyId: '120', history: [change('120', 'a1', 'messagesAdded')] });
  await completed(h); await result(h, 'answer-a');
  assert.equal(await h.first.store.fence.deliver('answer-a', { ...h.context, ownerId: 'other-owner' }, () => true), false);
  assert.equal(await h.first.store.fence.deliver('answer-a', { ...h.context, surface: 'team' }, () => true), false);
  assert.equal(await h.first.store.fence.deliver('answer-a', h.context, () => true), true);
  const expiry = (await h.first.store.documents(h.scope))[0]!.dependency.expiresAt;
  h.advance(expiry - h.now());
  assert.equal(await h.first.store.fence.deliver('answer-a', h.context, () => true), false);
  await h.first.store.control(h.scope, { type: 'pause' });
  assert.equal(await h.second.store.expire(h.scope), 1);
  await h.assertMailEmpty();
});

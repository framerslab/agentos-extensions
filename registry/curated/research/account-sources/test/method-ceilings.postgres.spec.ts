import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import {
  SourceQuota, sourceQuotaSchema, type SourceQuotaPolicy, type SourceQuotaRequest,
} from '../src/sync/SourceQuota.js';

const url = process.env.AGENTOS_TEST_POSTGRES_URL;
if (process.env.CI && !url) throw new Error('source_quota_database_required');
const prefix = `smc_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
/** Slack's Web API methods as one app's quota weighs them: one unit a request. */
const policy: SourceQuotaPolicy = {
  projectMinute: 10_000, mailboxMinute: 1_000, projectDay: 1_000_000,
  projectConcurrency: 8, mailboxConcurrency: 4, timeoutMs: 15_000, slotGraceMs: 15_000,
  weights: { 'conversations.history': 1, 'conversations.replies': 1, 'conversations.list': 1 },
};
/** The ceilings of an app Slack has not listed: history and replies at one request a minute of 15 objects. */
const ceilings = {
  'conversations.history': { perMinute: 1, maxObjects: 15 },
  'conversations.replies': { perMinute: 1, maxObjects: 15 },
  'conversations.list': { perMinute: 20 },
};
/** The weights a Gmail quota holds, in the order an earlier release recorded its policy. */
const gmailPolicy: SourceQuotaPolicy = {
  projectMinute: 120, mailboxMinute: 60, projectDay: 200, projectConcurrency: 3, mailboxConcurrency: 2,
  timeoutMs: 15_000, slotGraceMs: 15_000, weights: { list: 10, read: 40, changes: 2, profile: 1, labels: 1 },
};
let now = 100_000;
const app = (): string => `slack-app-${randomUUID()}`;
function request(projectKey: string, mailboxKey: string, method: string, objects?: number): SourceQuotaRequest {
  return { projectKey, mailboxKey, method, attemptId: randomUUID(), ...(objects === undefined ? {} : { objects }) };
}
const send = () => Promise.resolve('answered');

describe('per-method ceilings in the quota schema', () => {
  it('adds the method waits and the method minute budget to the quota tables', () => {
    const scripts = sourceQuotaSchema('fixture_quota');
    expect(scripts).toHaveLength(9);
    expect(scripts.some((sql) => sql.includes('"fixture_quota_methods"'))).toBe(true);
    expect(scripts.some((sql) => sql.includes('fixture_quota_mt'))).toBe(true);
  });
});

describe.skipIf(!url)('per-method ceilings on PostgreSQL', () => {
  let db: StorageAdapter;
  let quota: SourceQuota;
  beforeAll(async () => {
    db = createPostgresAdapter({ connectionString: url!, max: 8 });
    await db.open();
    for (const sql of sourceQuotaSchema(prefix)) await db.exec(sql);
    quota = new SourceQuota(db, { tablePrefix: prefix, policy, ceilings, clock: async () => now });
  });
  afterAll(async () => {
    if (!db) return;
    for (const suffix of ['attempts', 'mailboxes', 'methods', 'projects', 'pm_reservations', 'pm_meter',
      'mm_reservations', 'mm_meter', 'pd_reservations', 'pd_meter', 'mt_reservations', 'mt_meter']) {
      await db.exec(`DROP TABLE IF EXISTS "${prefix}_${suffix}" CASCADE`);
    }
    await db.close();
  });

  it('defers a method past its ceiling alone, with the time it has room, while the other methods run', async () => {
    const project = app(); const started = now;
    expect(await quota.run(request(project, 'workspace-a', 'conversations.history'), send)).toEqual({ kind: 'completed', value: 'answered' });
    now += 1_000;
    expect(await quota.run(request(project, 'workspace-a', 'conversations.history'), send))
      .toEqual({ kind: 'deferred', reason: 'method_minute', retryAt: started + 60_001 });
    expect(await quota.run(request(project, 'workspace-a', 'conversations.replies'), send)).toMatchObject({ kind: 'completed' });
    expect(await quota.run(request(project, 'workspace-a', 'conversations.list'), send)).toMatchObject({ kind: 'completed' });
    now = started + 60_001;
    expect(await quota.run(request(project, 'workspace-a', 'conversations.history'), send)).toMatchObject({ kind: 'completed' });
  });

  it('holds each ceiling for each workspace of the app alike, never one workspace for another', async () => {
    const project = app();
    for (const workspace of ['workspace-a', 'workspace-b', 'workspace-c']) {
      expect(await quota.run(request(project, workspace, 'conversations.history'), send)).toMatchObject({ kind: 'completed' });
      expect(await quota.run(request(project, workspace, 'conversations.history'), send)).toMatchObject({ kind: 'deferred', reason: 'method_minute' });
    }
  });

  it("blocks one method of one workspace until a provider's Retry-After, and no other", async () => {
    const project = app(); const until = now + 30_000;
    await quota.defer({ projectKey: project, mailboxKey: 'workspace-a', method: 'conversations.list' }, until);
    expect(await quota.run(request(project, 'workspace-a', 'conversations.list'), send))
      .toEqual({ kind: 'deferred', reason: 'provider_wait', retryAt: until });
    expect(await quota.run(request(project, 'workspace-a', 'conversations.replies'), send)).toMatchObject({ kind: 'completed' });
    expect(await quota.run(request(project, 'workspace-b', 'conversations.list'), send)).toMatchObject({ kind: 'completed' });
    // A shorter wait never replaces a longer one.
    await quota.defer({ projectKey: project, mailboxKey: 'workspace-a', method: 'conversations.list' }, now + 1_000);
    expect(await quota.run(request(project, 'workspace-a', 'conversations.list'), send)).toMatchObject({ kind: 'deferred', retryAt: until });
    now = until;
    expect(await quota.run(request(project, 'workspace-a', 'conversations.list'), send)).toMatchObject({ kind: 'completed' });
  });

  it('refuses a request for more objects than its ceiling, a method without a weight and a method wait without a workspace', async () => {
    const project = app();
    await expect(quota.run(request(project, 'workspace-a', 'conversations.history', 16), send)).rejects.toMatchObject({ code: 'invalid_response' });
    expect(await quota.run(request(project, 'workspace-a', 'conversations.history', 15), send)).toMatchObject({ kind: 'completed' });
    await expect(quota.run(request(project, 'workspace-a', 'users.info'), send)).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(quota.defer({ projectKey: project, method: 'conversations.list' }, now + 1_000)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('answers the ceiling a connector reads its page size from', () => {
    expect(quota.ceilingOf('conversations.history')).toEqual({ perMinute: 1, maxObjects: 15 });
    expect(quota.ceilingOf('conversations.list')).toEqual({ perMinute: 20 });
    expect(quota.ceilingOf('users.info')).toBeNull();
  });

  it('refuses a ceiling for a method without a weight, and a ceiling that is not a positive integer', () => {
    expect(() => new SourceQuota(db, { tablePrefix: prefix, policy, ceilings: { 'users.info': { perMinute: 100 } } }))
      .toThrow('invalid_source_quota_policy');
    expect(() => new SourceQuota(db, { tablePrefix: prefix, policy, ceilings: { 'conversations.list': { perMinute: 0 } } }))
      .toThrow('invalid_source_quota_policy');
    expect(() => new SourceQuota(db, { tablePrefix: prefix, policy,
      ceilings: { 'conversations.list': { perMinute: 20, maxObjects: 1.5 } } })).toThrow('invalid_source_quota_policy');
  });

  it("keeps a Gmail quota's recorded policy, so a project an earlier release recorded runs on", async () => {
    const project = `gmail-${randomUUID()}`;
    const recorded = JSON.stringify({ projectMinute: 120, mailboxMinute: 60, projectDay: 200, projectConcurrency: 3,
      mailboxConcurrency: 2, timeoutMs: 15_000, slotGraceMs: 15_000,
      weights: { list: 10, read: 40, changes: 2, profile: 1, labels: 1 } });
    await db.run(`INSERT INTO "${prefix}_projects"(project_key,policy) VALUES($1,$2)`, [project, recorded]);
    const gmail = new SourceQuota(db, { tablePrefix: prefix, policy: gmailPolicy, clock: async () => now });
    expect(await gmail.run(request(project, 'mailbox-a', 'read'), send)).toMatchObject({ kind: 'completed' });
    const reordered = new SourceQuota(db, { tablePrefix: prefix, clock: async () => now,
      policy: { ...gmailPolicy, weights: { labels: 1, profile: 1, changes: 2, read: 40, list: 10 } } });
    expect(await reordered.run(request(project, 'mailbox-a', 'list'), send)).toMatchObject({ kind: 'completed' });
  });

  it('gives the method minute its units back with the others when a call starts late', async () => {
    const project = app(); let calls = 0;
    const slow = new SourceQuota(db, { tablePrefix: prefix, policy, ceilings, clock: async () => {
      calls++; return now + (calls >= 3 ? 5_000 : 0);
    } });
    expect(await slow.run(request(project, 'workspace-a', 'conversations.history'), send)).toMatchObject({ kind: 'late' });
    expect(await quota.run(request(project, 'workspace-a', 'conversations.history'), send)).toMatchObject({ kind: 'completed' });
  });
});

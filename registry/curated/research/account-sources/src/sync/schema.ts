/**
 * @fileoverview The PostgreSQL tables of the durable source synchronization store: one row per connection with its
 * state, policy, checkpoint, barrier and lease, the cycle's work rows, the retained documents' provenance, the
 * connection's exclusions and each source's charge record in the host's indexing period.
 * @module account-sources/sync/schema
 */

/**
 * Quoted names of the store's tables and indexes.
 *
 * @param prefix - Table-name prefix: a lower-case letter, then at most 31 lower-case letters, digits or underscores.
 * @returns The quoted table and index names the schema and the store share.
 * @throws {Error} `invalid_source_sync_prefix` when the prefix does not have that form.
 */
export function sourceSyncTables(prefix = 'agentos_source_sync') {
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(prefix)) throw new Error('invalid_source_sync_prefix');
  return {
    connections: `"${prefix}_connections"`, work: `"${prefix}_work"`,
    documents: `"${prefix}_documents"`, exclusions: `"${prefix}_exclusions"`,
    due: `"${prefix}_due"`, expiry: `"${prefix}_expiry"`,
    workKind: `"${prefix}_work_kind"`, workWait: `"${prefix}_work_wait"`,
    charges: `"${prefix}_charges"`, chargesEnd: `"${prefix}_charges_end"`,
  };
}
/**
 * PostgreSQL DDL for the migration-owned synchronization tables.
 *
 * Each statement creates its table or index only when it is missing. The store never runs them: the host's
 * migration does, before a store with the same prefix is used. The documents table holds private provenance,
 * message timing, counts and hashes; content, passages and vectors live only in the host's own source tables. A hash
 * of a text confirms a guessed text, so treat both as content for access, retention and backup. A connection's barrier
 * is a fixed action, an opaque operation token and an optional source id, and a work row holds ids, counts and a
 * disposition: neither holds content. The two work indexes serve `takeWork` and `pendingRetry`: one orders a
 * connection's work by disposition and source id, so the first pending item is one index entry away, and one orders
 * its waiting items by retry time, so the first whose wait has passed is too. A store on a database without them is
 * correct and slower; running the statements again on an existing database adds them.
 *
 * The charges table serves a host whose allowance names the end of its indexing period (`indexingPeriodEndsAt`): one
 * row per source the store indexed or deferred in that period, with the period's end and either the provenance of the
 * newest text the store wrote or refreshed for the source in it (message ids, spans, counts and the hashes of the text
 * and of each message, as the documents table keeps them) or, for a source an `indexing_limit` skip left with no copy,
 * the deferral alone: its generation, room and time. The provenance outlives the source's copy until the period ends,
 * so it is content for access, retention and backup like the documents table; the store removes a row with its
 * connection, when a read finds the source gone or the provider skips it, when the source is excluded, and once its
 * period has ended, and its index by period end serves that last removal. A store on a
 * database without the table charges each read against the copies it holds alone and defers nothing, as an earlier
 * release did; running the statements again adds it.
 *
 * @param prefix - Table-name prefix: a lower-case letter, then at most 31 lower-case letters, digits or underscores.
 * @returns The statements, in the order they must run.
 * @throws {Error} `invalid_source_sync_prefix` when the prefix does not have that form.
 */
export function sourceSyncSchema(prefix = 'agentos_source_sync'): readonly string[] {
  const t = sourceSyncTables(prefix);
  return [
    `CREATE TABLE IF NOT EXISTS ${t.connections} (
      tenant_id TEXT NOT NULL,owner_id TEXT NOT NULL,connection_id TEXT NOT NULL,
      state JSONB NOT NULL,policy JSONB NOT NULL,checkpoint JSONB,barrier JSONB,
      lease_token TEXT,lease_until BIGINT,last_page TEXT,last_reconcile BIGINT,
      due_at BIGINT,PRIMARY KEY(tenant_id,owner_id,connection_id),
      CHECK ((lease_token IS NULL)=(lease_until IS NULL)))`,
    `CREATE TABLE IF NOT EXISTS ${t.work} (
      tenant_id TEXT NOT NULL,owner_id TEXT NOT NULL,connection_id TEXT NOT NULL,
      source_id TEXT NOT NULL,work JSONB NOT NULL,
      PRIMARY KEY(tenant_id,owner_id,connection_id,source_id),
      FOREIGN KEY(tenant_id,owner_id,connection_id)
        REFERENCES ${t.connections}(tenant_id,owner_id,connection_id) ON DELETE CASCADE)`,
    `CREATE TABLE IF NOT EXISTS ${t.documents} (
      tenant_id TEXT NOT NULL,owner_id TEXT NOT NULL,connection_id TEXT NOT NULL,
      source_id TEXT NOT NULL,document JSONB NOT NULL,expires_at BIGINT NOT NULL,
      PRIMARY KEY(tenant_id,owner_id,connection_id,source_id),
      FOREIGN KEY(tenant_id,owner_id,connection_id)
        REFERENCES ${t.connections}(tenant_id,owner_id,connection_id) ON DELETE CASCADE)`,
    `CREATE TABLE IF NOT EXISTS ${t.exclusions} (
      tenant_id TEXT NOT NULL,owner_id TEXT NOT NULL,connection_id TEXT NOT NULL,
      source_id TEXT NOT NULL,PRIMARY KEY(tenant_id,owner_id,connection_id,source_id),
      FOREIGN KEY(tenant_id,owner_id,connection_id)
        REFERENCES ${t.connections}(tenant_id,owner_id,connection_id) ON DELETE CASCADE)`,
    `CREATE INDEX IF NOT EXISTS ${t.due} ON ${t.connections}(due_at)`,
    `CREATE INDEX IF NOT EXISTS ${t.expiry} ON ${t.documents}(expires_at)`,
    `CREATE INDEX IF NOT EXISTS ${t.workKind} ON ${t.work}(tenant_id,owner_id,connection_id,
      (work->'disposition'->>'kind'),source_id)`,
    `CREATE INDEX IF NOT EXISTS ${t.workWait} ON ${t.work}(tenant_id,owner_id,connection_id,
      ((work->'disposition'->>'retryAt')::bigint),source_id) WHERE work->'disposition'->>'kind'='retry'`,
    `CREATE TABLE IF NOT EXISTS ${t.charges} (
      tenant_id TEXT NOT NULL,owner_id TEXT NOT NULL,connection_id TEXT NOT NULL,
      source_id TEXT NOT NULL,period_ends_at BIGINT NOT NULL,charged JSONB,deferred JSONB,
      PRIMARY KEY(tenant_id,owner_id,connection_id,source_id),
      FOREIGN KEY(tenant_id,owner_id,connection_id)
        REFERENCES ${t.connections}(tenant_id,owner_id,connection_id) ON DELETE CASCADE)`,
    `CREATE INDEX IF NOT EXISTS ${t.chargesEnd} ON ${t.charges}(period_ends_at)`,
  ];
}

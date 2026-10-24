/**
 * @fileoverview `migrateOperations` (D3): the package's numbered SQL for the adapter's dialect,
 * built in memory with the prefix written in, applied with the adapter's `runSchemaMigrations`
 * under the package's own ledger, `<prefix>_schema_migrations`, with `unknown: 'ignore'` and the
 * lock the product's own runner takes. Run twice, the second applies nothing. Its migrations only
 * add, so an older release's list still starts against newer tables.
 *
 * The adapter is loaded when `migrateOperations` is called, not when this module is imported: it
 * is an optional peer, and a process that never migrates never needs it.
 */
import type { SchemaMigration, StorageAdapter } from '@framers/sql-storage-adapter';
import type { OpsMigrateOptions, OpsMigrationReport } from '../contract.js';
import { DEFAULT_PREFIX, requireDialectPrefix, requirePrefix } from './prefix.js';
import { MIGRATION_FILES } from './sql/index.js';

export { operationsTables, tableName, TABLE_NAMES } from './prefix.js';

/** The adapter runner's default: runners that share a database share a key. */
export const DEFAULT_LOCK_KEY = 724313571;

/** The two dialects the package's statements and migrations are written for. */
export type OpsDialect = 'postgres' | 'sqlite';

/** The dialect an adapter speaks, by its `kind`, as the adapter's own `createStorageFeatures` reads it. */
export function dialectOf(db: Pick<StorageAdapter, 'kind'>): OpsDialect {
  return db.kind === 'postgres' || db.kind === 'supabase-postgres' ? 'postgres' : 'sqlite';
}

/**
 * The package's migrations for one dialect under `prefix`, each file one `{ name, sql }` with the
 * prefix written into its text, and so into its checksum. A prefix outside the rule, or one whose
 * names the dialect keeps for itself, throws before anything else.
 */
export function operationsMigrations(dialect: OpsDialect, prefix: string = DEFAULT_PREFIX): SchemaMigration[] {
  const checked = requireDialectPrefix(requirePrefix(prefix), dialect);
  return MIGRATION_FILES.map((file) => ({
    name: file.name,
    sql: file[dialect].replaceAll('{{prefix}}', checked),
  }));
}

/**
 * Builds the package's tables for the adapter's dialect and records them in
 * `<prefix>_schema_migrations`. The product's migration command calls it before its own
 * migrations. A prefix outside the rule throws before any statement.
 */
export async function migrateOperations(db: StorageAdapter, options: OpsMigrateOptions = {}): Promise<OpsMigrationReport> {
  const prefix = requirePrefix(options.prefix ?? DEFAULT_PREFIX);
  const migrations = operationsMigrations(dialectOf(db), prefix);
  const { runSchemaMigrations } = await import('@framers/sql-storage-adapter');
  return runSchemaMigrations(db, migrations, {
    table: `${prefix}_schema_migrations`,
    lockKey: options.lockKey ?? DEFAULT_LOCK_KEY,
    unknown: 'ignore',
  });
}

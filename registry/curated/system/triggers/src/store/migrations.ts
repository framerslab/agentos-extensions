/**
 * @fileoverview `migrateTriggers`: the package's numbered SQL for the adapter's dialect, built in
 * memory with the prefix written in, applied with the adapter's `runSchemaMigrations` under the
 * package's own ledger, `<prefix>_schema_migrations`, with `unknown: 'ignore'` and the lock the
 * product's own runner takes. Run twice, the second applies nothing. Its migrations only add, so an
 * older release's list still starts against newer tables.
 *
 * The adapter is loaded when `migrateTriggers` is called, not when this module is imported: it is
 * an optional peer, and a process that never migrates never needs it.
 */
import type { SchemaMigration, SchemaMigrationReport, StorageAdapter } from '@framers/sql-storage-adapter';
import { DEFAULT_PREFIX, requireDialectPrefix, requirePrefix } from './prefix.js';
import { MIGRATION_FILES } from './sql/index.js';

export { TABLE_NAMES, tableName, triggersTables } from './prefix.js';

/** The adapter runner's default lock, the same number the operations package uses, so runners that share a database share a key. */
export const DEFAULT_LOCK_KEY = 724313571;

/** The two dialects the package's statements and migrations are written for. */
export type TriggersDialect = 'postgres' | 'sqlite';

/** The dialect an adapter speaks, by its `kind`. */
export function dialectOf(db: Pick<StorageAdapter, 'kind'>): TriggersDialect {
  return db.kind === 'postgres' || db.kind === 'supabase-postgres' ? 'postgres' : 'sqlite';
}

/**
 * The package's migrations for one dialect under `prefix`, each file one `{ name, sql }` with the
 * prefix written into its text, and so into its checksum. A prefix outside the rule, or one whose
 * names the dialect keeps for itself, throws before anything else.
 */
export function triggersMigrations(dialect: TriggersDialect, prefix: string = DEFAULT_PREFIX): SchemaMigration[] {
  const checked = requireDialectPrefix(requirePrefix(prefix), dialect);
  return MIGRATION_FILES.map((file) => ({ name: file.name, sql: file[dialect].replaceAll('{{prefix}}', checked) }));
}

/** Builds the three tables for the adapter's dialect under `<prefix>_schema_migrations`; run twice, the second applies nothing. */
export async function migrateTriggers(db: StorageAdapter, options: { readonly prefix?: string; readonly lockKey?: number | string } = {}): Promise<SchemaMigrationReport> {
  const prefix = requirePrefix(options.prefix ?? DEFAULT_PREFIX);
  const migrations = triggersMigrations(dialectOf(db), prefix);
  const { runSchemaMigrations } = await import('@framers/sql-storage-adapter');
  return runSchemaMigrations(db, migrations, { table: `${prefix}_schema_migrations`, lockKey: options.lockKey ?? DEFAULT_LOCK_KEY, unknown: 'ignore' });
}

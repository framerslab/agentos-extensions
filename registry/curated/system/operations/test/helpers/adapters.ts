/**
 * The two backends every test file runs on: SQLite through sql.js in memory, always, and
 * PostgreSQL when `AGENTOS_TEST_POSTGRES_URL` names a server, as CI's build job does. Each run
 * makes its tables under a prefix of its own and drops them at the end. Without the variable the
 * PostgreSQL half shows as skipped under its reason, never silently.
 */
import { randomUUID } from 'node:crypto';
import { describe, it } from 'vitest';
import { createPostgresAdapter, createSqlJsAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { operationsTables } from '../../src/store/prefix.js';

export type BackendName = 'sqlite' | 'postgres';

export interface Backend {
  readonly name: BackendName;
  readonly label: string;
  open(): Promise<StorageAdapter>;
}

const postgresUrl = process.env.AGENTOS_TEST_POSTGRES_URL;

export const POSTGRES_SKIPPED = 'PostgreSQL skipped: AGENTOS_TEST_POSTGRES_URL is not set';

export const sqlite: Backend = {
  name: 'sqlite',
  label: 'SQLite through sql.js in memory',
  async open() {
    const db = createSqlJsAdapter();
    await db.open();
    return db;
  },
};

export const postgres: Backend | null = postgresUrl
  ? {
      name: 'postgres',
      label: 'PostgreSQL',
      async open() {
        const db = createPostgresAdapter({ connectionString: postgresUrl, max: 4 });
        await db.open();
        return db;
      },
    }
  : null;

export const backends: readonly Backend[] = postgres ? [sqlite, postgres] : [sqlite];

/** A prefix no other run uses: `t` and twelve hexadecimal characters. */
export function freshPrefix(): string {
  return `t${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/** Drops the package's tables under `prefix`, dependents first. */
export async function dropOperationsTables(db: StorageAdapter, prefix: string): Promise<void> {
  for (const table of [...operationsTables(prefix)].reverse()) {
    await db.exec(`DROP TABLE IF EXISTS ${table}`);
  }
}

/** Runs `cases` once a backend, and shows the PostgreSQL half as skipped, by name, when no server is given. */
export function describeBackends(title: string, cases: (backend: Backend) => void): void {
  for (const backend of backends) {
    describe(`${title} on ${backend.label}`, () => cases(backend));
  }
  if (!postgres) {
    describe.skip(`${title} on PostgreSQL (${POSTGRES_SKIPPED})`, () => {
      it('runs when AGENTOS_TEST_POSTGRES_URL names a server', () => undefined);
    });
  }
}

/**
 * The token store on Postgres: one table under a prefix, both tokens sealed at rest by the host's box, a refresh written
 * only over the version it read. The DDL is exported for a host that runs its own migrations. The database is taken by
 * shape (`run` answering the rows changed, `get`, `all`, with `?` placeholders), which `@framers/sql-storage-adapter`'s
 * adapter has.
 *
 * @module
 */
import { randomUUID } from 'node:crypto';
import type { ZoomTokenSet } from './oauth.js';
import type { IZoomTokenStore, ZoomConnection } from './tokens.js';

const PREFIX = /^[a-z][a-z0-9_]{0,39}$/;

/** The table and its index under a prefix (a lower-case identifier of at most 40 characters). */
export function zoomTokenStoreDdl(prefix = 'zoom_rtms'): string {
  if (!PREFIX.test(prefix)) throw new RangeError('the table prefix is a lower-case identifier of at most 40 characters');
  const table = `${prefix}_connections`;
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (`,
    '  owner_ref TEXT PRIMARY KEY,',
    '  generation TEXT NOT NULL,',
    '  closing BOOLEAN NOT NULL DEFAULT FALSE,',
    '  zoom_user_id TEXT NOT NULL,',
    '  zoom_account_id TEXT NOT NULL,',
    '  access_token_sealed TEXT NOT NULL,',
    '  refresh_token_sealed TEXT NOT NULL,',
    '  expires_at BIGINT NOT NULL,',
    '  scope TEXT NOT NULL,',
    '  version INTEGER NOT NULL,',
    '  created_at BIGINT NOT NULL,',
    '  updated_at BIGINT NOT NULL',
    ');',
    `CREATE INDEX IF NOT EXISTS idx_${table}_zoom_user ON ${table} (zoom_user_id);`,
  ].join('\n');
}

/** The DDL of the token store under the default prefix, for a host that runs its own migrations. */
export const ZOOM_TOKEN_STORE_DDL = zoomTokenStoreDdl();

/** What the store needs of a database. */
export interface ZoomSqlDb {
  run(sql: string, params?: unknown[]): Promise<{ changes?: number }>;
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(work: (db: ZoomSqlDb) => Promise<T>): Promise<T>;
}

/** What seals a token at rest: AgentOS's `SecretBox` has this shape. */
export interface ZoomSealer {
  seal(plain: string): string;
  open(sealed: string): string;
}

interface Row {
  generation: string;
  closing: boolean;
  owner_ref: string;
  zoom_user_id: string;
  zoom_account_id: string;
  access_token_sealed: string;
  refresh_token_sealed: string;
  expires_at: string | number;
  scope: string;
  version: string | number;
  created_at: string | number;
  updated_at: string | number;
}

/** The token store on Postgres: both tokens sealed by the host's box, refreshes under an advisory lock, writes conditional on the version read. */
export class SqlZoomTokenStore implements IZoomTokenStore {
  private readonly table: string;

  constructor(private readonly options: { db: ZoomSqlDb; tablePrefix?: string; box: ZoomSealer }) {
    const prefix = options.tablePrefix ?? 'zoom_rtms';
    if (!PREFIX.test(prefix)) throw new RangeError('the table prefix is a lower-case identifier of at most 40 characters');
    this.table = `${prefix}_connections`;
  }

  async withRefreshLease<T>(ownerRef: string, work: (store: IZoomTokenStore) => Promise<T>): Promise<T> {
    return this.options.db.transaction(async (db) => {
      await db.get('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`${this.table}:${ownerRef}`]);
      return work(new SqlZoomTokenStore({ ...this.options, db }));
    });
  }

  private fromRow(row: Row): ZoomConnection {
    return {
      ownerRef: row.owner_ref,
      generation: row.generation,
      closing: row.closing,
      zoomUserId: row.zoom_user_id,
      zoomAccountId: row.zoom_account_id,
      accessToken: this.options.box.open(row.access_token_sealed),
      refreshToken: this.options.box.open(row.refresh_token_sealed),
      expiresAt: Number(row.expires_at),
      scope: row.scope,
      version: Number(row.version),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  async get(ownerRef: string): Promise<ZoomConnection | undefined> {
    const row = await this.options.db.get<Row>(`SELECT * FROM ${this.table} WHERE owner_ref = ?`, [ownerRef]);
    return row === undefined ? undefined : this.fromRow(row);
  }

  async put(connection: Omit<ZoomConnection, 'version' | 'generation' | 'closing'>): Promise<ZoomConnection> {
    const row = await this.options.db.get<Row>(
      `INSERT INTO ${this.table} (generation, closing, owner_ref, zoom_user_id, zoom_account_id, access_token_sealed, refresh_token_sealed, expires_at, scope, version, created_at, updated_at)
       VALUES (?, FALSE, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT (owner_ref) DO UPDATE SET
         generation = EXCLUDED.generation,
         closing = FALSE,
         zoom_user_id = EXCLUDED.zoom_user_id,
         zoom_account_id = EXCLUDED.zoom_account_id,
         access_token_sealed = EXCLUDED.access_token_sealed,
         refresh_token_sealed = EXCLUDED.refresh_token_sealed,
         expires_at = EXCLUDED.expires_at,
         scope = EXCLUDED.scope,
         version = ${this.table}.version + 1,
         created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at
       WHERE NOT ${this.table}.closing
       RETURNING *`,
      [randomUUID(), connection.ownerRef, connection.zoomUserId, connection.zoomAccountId, this.options.box.seal(connection.accessToken), this.options.box.seal(connection.refreshToken), connection.expiresAt, connection.scope, connection.createdAt, connection.updatedAt],
    );
    if (row === undefined) throw new Error('the connection was not written');
    return this.fromRow(row);
  }

  async rotate(ownerRef: string, expectedVersion: number, tokens: ZoomTokenSet, now: number): Promise<{ applied: boolean; connection: ZoomConnection } | undefined> {
    const result = await this.options.db.run(
      `UPDATE ${this.table} SET access_token_sealed = ?, refresh_token_sealed = ?, expires_at = ?, scope = ?, version = version + 1, updated_at = ? WHERE owner_ref = ? AND version = ?`,
      [this.options.box.seal(tokens.accessToken), this.options.box.seal(tokens.refreshToken), tokens.expiresAt, tokens.scope, now, ownerRef, expectedVersion],
    );
    const connection = await this.get(ownerRef);
    return connection === undefined ? undefined : { applied: (result.changes ?? 0) > 0, connection };
  }

  async remove(ownerRef: string, expectedVersion?: number): Promise<boolean> {
    const result = await this.options.db.run(
      `DELETE FROM ${this.table} WHERE owner_ref = ?${expectedVersion === undefined ? '' : ' AND version = ?'}`,
      expectedVersion === undefined ? [ownerRef] : [ownerRef, expectedVersion],
    );
    return (result.changes ?? 0) > 0;
  }

  async markClosing(ownerRef: string, generation: string): Promise<boolean> {
    const result = await this.options.db.run(
      `UPDATE ${this.table} SET closing = TRUE WHERE owner_ref = ? AND generation = ?`, [ownerRef, generation]);
    return (result.changes ?? 0) > 0;
  }

  async byZoomUser(zoomUserId: string): Promise<ZoomConnection[]> {
    const rows = await this.options.db.all<Row>(`SELECT * FROM ${this.table} WHERE zoom_user_id = ? ORDER BY owner_ref`, [zoomUserId]);
    return rows.map((row) => this.fromRow(row));
  }

  async closingConnections(): Promise<ZoomConnection[]> {
    const rows = await this.options.db.all<Row>(`SELECT * FROM ${this.table} WHERE closing = TRUE ORDER BY owner_ref`, []);
    return rows.map((row) => this.fromRow(row));
  }
}

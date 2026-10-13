import { describe, it, expect } from 'vitest';
import { ZOOM_TOKEN_STORE_DDL, zoomTokenStoreDdl } from '../src/sqlStore.js';

describe('zoomTokenStoreDdl', () => {
  it('names one table and one index under the prefix, and refuses a prefix that is not an identifier', () => {
    const ddl = zoomTokenStoreDdl('acme_zoom');
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS acme_zoom_connections (');
    expect(ddl).toContain('CREATE INDEX IF NOT EXISTS idx_acme_zoom_connections_zoom_user ON acme_zoom_connections (zoom_user_id);');
    for (const column of ['owner_ref TEXT PRIMARY KEY', 'access_token_sealed TEXT NOT NULL', 'refresh_token_sealed TEXT NOT NULL', 'expires_at BIGINT NOT NULL', 'version INTEGER NOT NULL']) expect(ddl).toContain(column);
    expect(ddl).not.toMatch(/access_token\s+TEXT/);
    expect(zoomTokenStoreDdl()).toBe(ZOOM_TOKEN_STORE_DDL);
    expect(() => zoomTokenStoreDdl('9bad')).toThrow();
    expect(() => zoomTokenStoreDdl('has-dash')).toThrow();
    expect(() => zoomTokenStoreDdl('a'.repeat(41))).toThrow();
  });
});

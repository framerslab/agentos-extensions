import { describe, expect, it } from 'vitest';
import { ID_TAGS, isTaggedId, newId, randomHex } from '../src/store/ids.js';

describe('ids', () => {
  it('a tagged id is its tag and 32 hex characters, and two draws differ', () => {
    for (const tag of ID_TAGS) {
      const id = newId(tag);
      expect(id).toMatch(new RegExp(`^${tag}_[0-9a-f]{32}$`));
      expect(isTaggedId(id, tag)).toBe(true);
      expect(isTaggedId(id)).toBe(true);
    }
    expect(newId('tkt')).not.toBe(newId('tkt'));
    expect(randomHex(8)).toMatch(/^[0-9a-f]{16}$/);
    expect(randomHex(8)).not.toBe(randomHex(8));
  });

  it('refuses a wrong tag, a short id and a character outside hex', () => {
    expect(isTaggedId(`tkt_${'g'.repeat(32)}`)).toBe(false);
    expect(isTaggedId(`tkt_${'a'.repeat(31)}`)).toBe(false);
    expect(isTaggedId(`nope_${'a'.repeat(32)}`)).toBe(false);
    expect(isTaggedId(newId('msg'), 'tkt')).toBe(false);
    expect(isTaggedId(42)).toBe(false);
  });
});

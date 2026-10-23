import { describe, expect, it } from 'vitest';
import { clean } from '../src/store/clean.js';

describe('clean', () => {
  it('removes U+0000 and the other control characters and keeps tab and newline', () => {
    expect(clean('a\u0000b')).toBe('ab');
    expect(clean('a\u0001\u0008\u000B\u000C\u000E\u001Fb')).toBe('ab');
    expect(clean('a\u007F\u0080\u0085\u009Fb')).toBe('ab');
    expect(clean('a\tb\nc\r\nd')).toBe('a\tb\nc\r\nd');
    expect(clean('plain words, an accent é and a sign ☃ stay')).toBe('plain words, an accent é and a sign ☃ stay');
    expect(clean('')).toBe('');
  });
});

import { describe, expect, it } from 'vitest';

import { readArchive, writeArchive } from '../../src/transcript/archive.js';

describe('the archive', () => {
  it('writes entries and reads them back, text and bytes', () => {
    const zip = writeArchive([
      { path: 'library.json', data: '{"v":1}' },
      { path: 'sessions/s1.json', data: '{"title":"One"}' },
      { path: 'bytes.bin', data: new Uint8Array([0, 255, 7]) },
    ]);
    const back = readArchive(zip);
    expect(back.map((entry) => entry.path)).toEqual(['library.json', 'sessions/s1.json', 'bytes.bin']);
    expect(new TextDecoder().decode(back[1].data)).toBe('{"title":"One"}');
    expect([...back[2].data]).toEqual([0, 255, 7]);
  });

  it('refuses a path that climbs out or starts at the root', () => {
    expect(() => writeArchive([{ path: '../x', data: '' }])).toThrow('path');
    expect(() => writeArchive([{ path: '/x', data: '' }])).toThrow('path');
  });
});

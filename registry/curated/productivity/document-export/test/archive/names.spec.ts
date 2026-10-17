import { crc32 } from 'node:zlib';
import { strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';

import { openArchive } from '../../src/archive/index.js';
import { blobOf, entryArchive, unicodePathField } from './fixtures.js';

/** "café.txt" in IBM code page 437, where é is 0x82: not UTF-8, since 0x82 cannot begin a UTF-8 sequence. */
const CP437_CAFE = Uint8Array.of(0x63, 0x61, 0x66, 0x82, 0x2e, 0x74, 0x78, 0x74);
const TEXT = strToU8('the entry');

/** The one entry's listed path, and its bytes read through its local header, of an archive built from `parts`. */
async function listed(parts: { name: Uint8Array; flags: number; extra?: Uint8Array }): Promise<{ path: string; bytes: Uint8Array }> {
  const opened = await openArchive(blobOf(entryArchive({ ...parts, method: 0, data: TEXT, plain: TEXT }).bytes));
  const [entry] = opened.entries;
  const bytes = await entry!.bytes({ worker: false });
  opened.close();
  return { path: entry!.path, bytes };
}

describe("an entry's name", () => {
  it('is decoded as code page 437 when general-purpose bit 11 is unset and its bytes are not UTF-8', async () => {
    // APPNOTE 6.3.10 appendix D.2: without bit 11 a name keeps the original ZIP character set, IBM code page 437.
    const { path, bytes } = await listed({ name: CP437_CAFE, flags: 0 });
    expect(path).toBe('café.txt');
    // The local header repeats the stored bytes, not the decoded text, so the entry still reads.
    expect(bytes).toEqual(TEXT);
  });

  it('maps the high half of code page 437 as the Unicode table does', async () => {
    // 0x80 to 0xFF in order: never UTF-8, since 0x80 cannot begin a sequence.
    const high = Uint8Array.from({ length: 128 }, (_, i) => 0x80 + i);
    const { path } = await listed({ name: high, flags: 0 });
    expect(path).toHaveLength(128);
    // Spot checks from https://www.unicode.org/Public/MAPPINGS/VENDORS/MICSFT/PC/CP437.TXT.
    expect(path[0x00]).toBe('Ç');
    expect(path[0x02]).toBe('é');
    expect(path[0x1e]).toBe('₧');
    expect(path[0x30]).toBe('░');
    expect(path[0x61]).toBe('ß');
    expect(path[0x7e]).toBe('■');
    expect(path[0x7f]).toBe(' ');
  });

  it('is decoded as UTF-8 when bit 11 is unset but its bytes are UTF-8, as many writers store them', async () => {
    const name = new TextEncoder().encode('notes/café ☕.md');
    expect((await listed({ name, flags: 0 })).path).toBe('notes/café ☕.md');
  });

  it('is decoded as UTF-8 when bit 11 is set', async () => {
    const name = new TextEncoder().encode('notes/café ☕.md');
    expect((await listed({ name, flags: 0x0800 })).path).toBe('notes/café ☕.md');
  });

  it('is taken from an Info-ZIP Unicode Path field whose CRC-32 matches the stored name', async () => {
    // APPNOTE 4.6.9: the field holds the name in UTF-8 and the CRC-32 of the name field it stands for.
    const extra = unicodePathField(CP437_CAFE, 'notes/café ☕.txt');
    const { path, bytes } = await listed({ name: CP437_CAFE, flags: 0, extra });
    expect(path).toBe('notes/café ☕.txt');
    expect(bytes).toEqual(TEXT);
  });

  it('ignores a Unicode Path field whose CRC-32 does not match the stored name, as a renamed entry carries', async () => {
    const extra = unicodePathField(CP437_CAFE, 'renamed.txt', (crc32(CP437_CAFE) ^ 1) >>> 0);
    expect((await listed({ name: CP437_CAFE, flags: 0, extra })).path).toBe('café.txt');
  });

  it('keeps bit 11 over a Unicode Path field, which a UTF-8 name does not need', async () => {
    const name = new TextEncoder().encode('kept.txt');
    const extra = unicodePathField(name, 'other.txt');
    expect((await listed({ name, flags: 0x0800, extra })).path).toBe('kept.txt');
  });

  it('marks a climbing name from a Unicode Path field unsafe, whatever the stored name is', async () => {
    const name = new TextEncoder().encode('plain.txt');
    const extra = unicodePathField(name, '../up.txt');
    const opened = await openArchive(blobOf(entryArchive({ name, flags: 0, extra, method: 0, data: TEXT, plain: TEXT }).bytes));
    expect(opened.entries[0]!.path).toBe('../up.txt');
    expect(opened.entries[0]!.unsafe).toBe(true);
    await expect(opened.entries[0]!.bytes()).rejects.toMatchObject({ reason: 'path' });
    opened.close();
  });
});

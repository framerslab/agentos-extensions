import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { crc32, zipStream, type ZipEntry } from '../src/tickets/zip.js';
import { bytesOf } from './helpers/bytes.js';

const encoder = new TextEncoder();

const u32 = (bytes: Uint8Array, at: number): number => (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | ((bytes[at + 3]! << 24) >>> 0)) >>> 0;
const u16 = (bytes: Uint8Array, at: number): number => bytes[at]! | (bytes[at + 1]! << 8);

async function* entries(list: readonly ZipEntry[]): AsyncGenerator<ZipEntry> {
  for (const entry of list) yield entry;
}

describe('the zip writer (D21)', () => {
  it('crc32 answers the check value of "123456789" and 0 for nothing', () => {
    expect(crc32(encoder.encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it("the zip's headers, directory and end record read back with a standard reader, the files stored uncompressed in order", async () => {
    const picture = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
    const files: ZipEntry[] = [
      { name: 'requests.json', bytes: encoder.encode('{"requests":[]}') },
      { name: 'pictures/tkt_0123/pic_4567.webp', bytes: picture },
    ];
    const zip = await bytesOf(zipStream(entries(files), Date.UTC(2026, 9, 25, 3, 4, 6)));

    // A local file header first, the end of central directory record last.
    expect(u32(zip, 0)).toBe(0x04034b50);
    const endAt = zip.length - 22;
    expect(u32(zip, endAt)).toBe(0x06054b50);
    expect(u16(zip, endAt + 8)).toBe(2);
    expect(u16(zip, endAt + 10)).toBe(2);
    const directoryAt = u32(zip, endAt + 16);
    expect(u32(zip, directoryAt)).toBe(0x02014b50);
    // The first local header: stored (method 0), the crc and both sizes of requests.json.
    expect(u16(zip, 8)).toBe(0);
    expect(u32(zip, 14)).toBe(crc32(files[0]!.bytes));
    expect(u32(zip, 18)).toBe(files[0]!.bytes.length);
    expect(u32(zip, 22)).toBe(files[0]!.bytes.length);

    const read = unzipSync(zip);
    expect(Object.keys(read)).toEqual(['requests.json', 'pictures/tkt_0123/pic_4567.webp']);
    expect(new TextDecoder().decode(read['requests.json'])).toBe('{"requests":[]}');
    expect(Array.from(read['pictures/tkt_0123/pic_4567.webp']!)).toEqual(Array.from(picture));
  });

  it('a zip with no files is an end record alone, and a stream that fails while writing fails the zip', async () => {
    const empty = await bytesOf(zipStream(entries([]), Date.UTC(2026, 9, 25)));
    expect(empty.length).toBe(22);
    expect(u32(empty, 0)).toBe(0x06054b50);
    expect(Object.keys(unzipSync(empty))).toEqual([]);

    async function* failing(): AsyncGenerator<ZipEntry> {
      yield { name: 'requests.json', bytes: encoder.encode('{}') };
      throw new Error('the picture could not be read');
    }
    await expect(bytesOf(zipStream(failing(), Date.UTC(2026, 9, 25)))).rejects.toThrow('the picture could not be read');
  });
});

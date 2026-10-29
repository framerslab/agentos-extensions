/**
 * The picture fixtures (D18), built when a test asks for them: a JPEG with EXIF orientation 6 and
 * GPS tags and a small WebP through sharp, a 60-megapixel PNG under 5 MB written by hand (its
 * rows are zeros, which zlib folds to a few kilobytes), and a GIF and a PDF as bytes.
 */
import { deflateSync } from 'node:zlib';
import { crc32 } from '../../src/tickets/zip.js';

type SharpModule = typeof import('sharp');

let sharpModule: Promise<SharpModule['default']> | null = null;

/** sharp, loaded once. */
export function loadSharp(): Promise<SharpModule['default']> {
  if (sharpModule === null) sharpModule = import('sharp').then((module) => module.default);
  return sharpModule;
}

/** An 8 by 4 JPEG carrying EXIF orientation 6 (a quarter turn clockwise) and GPS latitude and longitude tags. */
export async function jpegWithOrientationAndGps(): Promise<Uint8Array> {
  const sharp = await loadSharp();
  const bytes = await sharp({ create: { width: 8, height: 4, channels: 3, background: { r: 200, g: 20, b: 20 } } })
    .jpeg({ quality: 90 })
    .withMetadata({ orientation: 6 })
    .withExifMerge({
      IFD0: { Copyright: 'Fixture picture' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '45/1 30/1 0/1', GPSLongitudeRef: 'W', GPSLongitude: '122/1 40/1 0/1' },
    })
    .toBuffer();
  return new Uint8Array(bytes);
}

/** A 6 by 5 WebP with no metadata. */
export async function smallWebp(): Promise<Uint8Array> {
  const sharp = await loadSharp();
  return new Uint8Array(await sharp({ create: { width: 6, height: 5, channels: 3, background: { r: 10, g: 200, b: 30 } } }).webp().toBuffer());
}

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

function be32(value: number): Uint8Array {
  return Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const whole = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    whole.set(part, offset);
    offset += part.length;
  }
  return whole;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const crc = crc32(concat([typeBytes, data]));
  return concat([be32(data.length), typeBytes, data, be32(crc)]);
}

/** The PNG's size in pixels: 8,000 by 7,500 is 60,000,000, past D18's 50,000,000. */
export const HUGE_PNG_WIDTH = 8_000;
export const HUGE_PNG_HEIGHT = 7_500;

/** A 60-megapixel 1-bit grayscale PNG, every row black, under 5 MB. */
export function hugePng(): Uint8Array {
  const rowBytes = 1 + Math.ceil(HUGE_PNG_WIDTH / 8);
  const raw = new Uint8Array(rowBytes * HUGE_PNG_HEIGHT);
  const header = concat([be32(HUGE_PNG_WIDTH), be32(HUGE_PNG_HEIGHT), Uint8Array.of(1, 0, 0, 0, 0)]);
  return concat([PNG_SIGNATURE, pngChunk('IHDR', header), pngChunk('IDAT', new Uint8Array(deflateSync(raw, { level: 9 }))), pngChunk('IEND', new Uint8Array(0))]);
}

/** A one-pixel GIF89a. */
export function tinyGif(): Uint8Array {
  return new Uint8Array(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
}

/** A PDF with an empty page tree. */
export function tinyPdf(): Uint8Array {
  return new TextEncoder().encode(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
  );
}

/** Bytes one past the 5 MB bound, opening like a PNG. */
export function oversized(): Uint8Array {
  const bytes = new Uint8Array(5 * 1024 * 1024 + 1);
  bytes.set(PNG_SIGNATURE, 0);
  return bytes;
}

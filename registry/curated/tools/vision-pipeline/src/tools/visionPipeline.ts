// @ts-nocheck
/**
 * @fileoverview The vision-pipeline tool: OCR, handwriting, document layout,
 * image description and CLIP embeddings through an AgentOS VisionPipeline.
 */

import * as agentos from '@framers/agentos';
import type { ITool, JSONSchemaObject, ToolExecutionContext, ToolExecutionResult } from '@framers/agentos';

import { readSavedImage, scopeOf, type ImageStore } from '../imageFiles.js';

/** What the tool reads from an image; see {@link VisionPipelineTool}. */
export type VisionMode = 'ocr' | 'handwriting' | 'layout' | 'describe' | 'embed' | 'auto';

/** The vision-pipeline tool's input. */
export interface VisionPipelineInput {
  /** The image: a data:image URL, an http(s) URL on a public host, or the file: URL of an image the image tools saved. */
  imageUrl: string;
  /** What to read (default `auto`). */
  mode?: VisionMode;
  /** The highest tier to use: 1 local OCR, 2 local vision models, 3 cloud vision (default). */
  maxTier?: 1 | 2 | 3;
}

/** The vision-pipeline tool's output: the text found, or for `embed` the vector. */
export interface VisionPipelineOutput {
  mode: VisionMode;
  text?: string;
  confidence?: number;
  category?: string;
  /** The pipeline tiers that produced the result. */
  tiers?: string[];
  /** How many text regions the winning tier located. */
  regions?: number;
  /** The document layout, when the layout tier ran: one page, a text block per line with its box. */
  layout?: unknown;
  /** The tiers that were due to run and failed, each with its error. */
  failedTiers?: { tier: string; error: string }[];
  durationMs?: number;
  /** For embed: the CLIP vector. */
  embedding?: number[];
  dimensions?: number;
}

/** The pipeline strategy a call runs under: tier 3 may reach cloud vision, tiers 1 and 2 stay local. */
export type VisionStrategy = 'progressive' | 'local-only';

/** Returns the pipeline for a strategy, made on first use. */
export type PipelineFor = (strategy: VisionStrategy) => Promise<{
  process(image: Buffer | string, options?: { forceCategory?: string; tiers?: string[] }): Promise<any>;
  embed(image: Buffer | string): Promise<number[]>;
}>;

/**
 * The lowest tier each mode needs: 1 is local OCR, 2 local vision models
 * (TrOCR, Florence-2, CLIP), 3 cloud vision.
 */
const TIER_NEEDED: Record<VisionMode, 1 | 2 | 3> = {
  auto: 1,
  ocr: 1,
  handwriting: 2,
  layout: 2,
  embed: 2,
  describe: 3,
};

/**
 * Whether an IPv4 address, as its four numbers, is off the public internet:
 * "this network", private, carrier-grade NAT, loopback, link-local (cloud
 * metadata services answer at 169.254.169.254), the IETF protocol block, the
 * 6to4 relay anycast block (192.88.99/24), the documentation and
 * benchmarking ranges, multicast, reserved and broadcast.
 */
function isNonPublicIPv4([a, b, c]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/** The eight 16-bit groups of an IPv6 address, or `undefined` when the text is not one. */
function ipv6Groups(address: string): number[] | undefined {
  let text = address;
  // A trailing dotted IPv4 (::ffff:1.2.3.4) is two groups.
  const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (dotted) {
    const [w, x, y, z] = dotted.slice(2).map(Number);
    if ([w, x, y, z].some((n) => n > 255)) return undefined;
    text = `${dotted[1]}${((w << 8) | x).toString(16)}:${((y << 8) | z).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (halves.length === 2 ? fill < 1 : head.length !== 8) return undefined;
  const groups = [...head, ...Array(fill).fill('0'), ...tail];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return undefined;
  return groups.map((group) => parseInt(group, 16));
}

/**
 * Whether an IPv6 address is off the public internet. Only 2000::/3 is
 * allocated for global unicast, so everything outside it is refused
 * (unspecified, loopback, the deprecated IPv4-compatible form, discard, SRv6,
 * unique local, link-local, site-local, multicast, and space no one has been
 * given), except the two forms that reach an IPv4 address and are judged by
 * it: IPv4-mapped (::ffff:0:0/96) and the NAT64 well-known prefix
 * (64:ff9b::/96). Inside 2000::/3, 6to4 (2002::/16) is judged by the address
 * it carries, and the IETF protocol assignments (2001::/23) and documentation
 * (2001:db8::/32 and 3fff::/20) are refused. The same rule as AgentOS's
 * `isPublicNetworkAddress`.
 */
function isNonPublicIPv6(groups: number[]): boolean {
  const carried = (high: number, low: number) => isNonPublicIPv4([high >> 8, high & 255, low >> 8, low & 255]);
  const [g0, g1, g2, , , g5, g6, g7] = groups;
  const zeros = (from: number, to: number) => groups.slice(from, to).every((group) => group === 0);
  if (zeros(0, 5) && g5 === 0xffff) return carried(g6, g7);
  if (g0 === 0x64 && g1 === 0xff9b && zeros(2, 6)) return carried(g6, g7);
  if ((g0 & 0xe000) !== 0x2000) return true;
  if (g0 === 0x2002) return carried(g1, g2);
  if (g0 === 0x2001 && (g1 <= 0x01ff || g1 === 0xdb8)) return true;
  return g0 === 0x3fff && g1 <= 0x0fff;
}

/**
 * Whether a URL's host is this machine or off the public internet: `localhost`
 * names, and the IPv4 and IPv6 literals above. The URL parser has already
 * written other IPv4 spellings (`0x7f000001`, `127.1`) as dotted numbers. An
 * IPv6 literal that cannot be read is treated as not public. The check reads
 * the host as written: the address a name resolves to, and the target of a
 * redirect, are not checked here.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) return isNonPublicIPv4(v4.slice(1).map(Number));
  if (!host.includes(':')) return false;
  const groups = ipv6Groups(host);
  return groups === undefined || isNonPublicIPv6(groups);
}

/** The value of an ASCII hex digit, or -1. */
function hexValue(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x37;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x57;
  return -1;
}

/**
 * The bytes of a percent-encoded data URL payload: each `%XX` is one byte,
 * any other character its UTF-8 bytes. A `%` that starts no valid escape is
 * kept as it is, so the decoding never throws. One pass over two buffers.
 */
function percentDecode(payload: string): Buffer {
  const text = Buffer.from(payload, 'utf8');
  const out = Buffer.allocUnsafe(text.length);
  let length = 0;
  for (let i = 0; i < text.length; i += 1) {
    const high = text[i] === 0x25 && i + 2 < text.length ? hexValue(text[i + 1]) : -1;
    const low = high >= 0 ? hexValue(text[i + 2]) : -1;
    if (low >= 0) {
      out[length] = high * 16 + low;
      i += 2;
    } else {
      out[length] = text[i];
    }
    length += 1;
  }
  return out.subarray(0, length);
}

/**
 * The image a value names, when it is one a caller may hand the pipeline: a
 * data URL decoded to its bytes, or an http(s) URL whose host is not this
 * machine or a private network, written as the URL parser serializes it
 * (scheme and host in lower case, dot segments resolved); `undefined` for
 * anything else, a `file:` URL included. AgentOS also reads any local file
 * path and fetches any URL, but a tool the model calls must not send the
 * machine's files, or what its network serves, to a cloud vision model.
 *
 * The tool also takes the `file:` URL of an image the image tools saved,
 * which it reads itself and holds to that directory (see {@link loadImage}).
 */
export function imageInput(value: unknown): Buffer | string | undefined {
  const source = sourceOf(value);
  return typeof source === 'string' && /^file:/i.test(source) ? undefined : source;
}

/** The image a call names, as {@link imageInput} reads it, and a `file:` URL as it was written. */
function sourceOf(value: unknown): Buffer | string | undefined {
  if (typeof value !== 'string') return undefined;
  const source = value.trim();
  if (/^file:/i.test(source)) return source;
  if (/^https?:\/\//i.test(source)) {
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      return undefined;
    }
    return isPrivateHost(url.hostname) ? undefined : url.href;
  }
  // A data URL as WHATWG Fetch reads one, and as AgentOS's imageToBuffer
  // does: tabs and line breaks dropped first, then base64 when the media type
  // ends in `;base64`, spaces around it allowed.
  const url = source.replace(/[\t\n\r]/g, '');
  const comma = url.indexOf(',');
  if (!/^data:image\//i.test(url) || comma === -1) return undefined;
  const payload = url.slice(comma + 1);
  return /; *base64 *$/i.test(url.slice(0, comma)) ? Buffer.from(payload, 'base64') : percentDecode(payload);
}

/** The error for an input that is not an accepted image source. */
const SOURCE_ERROR =
  'imageUrl must be a data:image URL, an http(s) URL on a public host, or the file: URL of an image the image tools saved: other local files are not read, nor local or private network addresses.';

/**
 * The bytes of the image a call names, for the pipeline. A Buffer goes on as
 * it is.
 *
 * A `file:` URL must name an image that the image-generation or image-editing
 * tools saved for this caller, in the images directory the packs share.
 *
 * An http(s) URL is fetched here through AgentOS's `imageToBuffer` with
 * `untrusted: true`, which connects only to public network addresses (every
 * address the host resolves to, and every redirect, is checked) and holds the
 * image to 50 MiB and 30 seconds. An AgentOS without that mode (it has no
 * `isPublicNetworkAddress` export; the mode came in 0.13.16) would fetch the
 * URL unchecked, so an http(s) image is refused there.
 */
export async function loadImage(image: Buffer | string, store?: ImageStore, context?: unknown): Promise<Buffer> {
  if (typeof image !== 'string') return image;
  if (/^file:/i.test(image)) {
    const bytes = store ? await readSavedImage(image, store.dir, scopeOf(context)) : undefined;
    if (!bytes) throw new Error(SOURCE_ERROR);
    return bytes;
  }
  const { imageToBuffer, isPublicNetworkAddress } = agentos;
  if (typeof isPublicNetworkAddress !== 'function') {
    throw new Error('imageUrl is an http(s) URL, which needs @framers/agentos 0.13.16 or later: pass a data:image URL, or update AgentOS.');
  }
  return imageToBuffer(image, { untrusted: true });
}

/** The vision-pipeline tool, on an AgentOS `VisionPipeline` per strategy. */
export class VisionPipelineTool implements ITool<VisionPipelineInput, VisionPipelineOutput> {
  readonly id = 'tool.vision-pipeline';
  readonly name = 'vision-pipeline';
  readonly displayName = 'Vision & OCR Pipeline';
  readonly description =
    'Read and understand an image: printed text (ocr), handwriting, document layout, a description of the image, ' +
    'or a CLIP embedding vector. Local OCR runs first; local vision models and cloud vision run as maxTier allows.';
  readonly category = 'media';
  readonly hasSideEffects = false;

  readonly inputSchema: JSONSchemaObject = {
    type: 'object',
    properties: {
      imageUrl: {
        type: 'string',
        description: 'The image: an http(s) URL, a data:image URL, or the file: URL of an image the image tools saved.',
      },
      mode: {
        type: 'string',
        enum: ['ocr', 'handwriting', 'layout', 'describe', 'embed', 'auto'],
        description:
          'ocr for printed text, handwriting, layout for the lines of text with their boxes, describe for what the image shows, ' +
          'embed for a CLIP vector, or auto (default) to let the pipeline decide.',
      },
      maxTier: {
        type: 'number',
        enum: [1, 2, 3],
        description: 'The highest tier to use: 1 local OCR only, 2 local vision models, 3 cloud vision (default).',
      },
    },
    required: ['imageUrl'],
  };

  /**
   * @param pipelineFor - Returns the pipeline for a strategy.
   * @param store - The images directory, for `file:` sources. Without one, no `file:` URL is read.
   */
  constructor(
    private readonly pipelineFor: PipelineFor,
    private readonly store?: ImageStore,
  ) {}

  async execute(args: VisionPipelineInput, context?: ToolExecutionContext): Promise<ToolExecutionResult<VisionPipelineOutput>> {
    const image = sourceOf(args.imageUrl);
    if (image === undefined) return { success: false, error: SOURCE_ERROR };
    const mode: VisionMode = args.mode ?? 'auto';
    if (typeof mode !== 'string' || !Object.hasOwn(TIER_NEEDED, mode)) {
      return { success: false, error: `mode must be one of ${Object.keys(TIER_NEEDED).join(', ')}.` };
    }
    // The highest tier is the cloud: only an absent maxTier means it. A value
    // the schema does not allow, null among them, is refused, not read as
    // "no limit".
    let maxTier = 3;
    if (args.maxTier !== undefined) {
      const given = typeof args.maxTier === 'string' && args.maxTier.trim() !== '' ? Number(args.maxTier) : args.maxTier;
      if (given !== 1 && given !== 2 && given !== 3) return { success: false, error: 'maxTier must be 1, 2 or 3.' };
      maxTier = given;
    }
    if (TIER_NEEDED[mode] > maxTier) {
      return { success: false, error: `${mode} needs maxTier ${TIER_NEEDED[mode]} or higher; this call allows ${maxTier}.` };
    }

    try {
      const input = await loadImage(image, this.store, context);
      const pipeline = await this.pipelineFor(maxTier === 3 ? 'progressive' : 'local-only');
      if (mode === 'embed') {
        const embedding = await pipeline.embed(input);
        return { success: true, output: { mode, embedding, dimensions: embedding.length } };
      }
      // handwriting and layout name their tier. With the category alone, a
      // pipeline that may reach the cloud returns as soon as plain OCR is
      // confident, before the tier the mode is named for has run; and a tier
      // whose model is not installed is passed over without a word. A named
      // tier runs, or fails with the reason.
      const options =
        maxTier === 1 || mode === 'ocr'
          ? { tiers: ['ocr'] }
          : mode === 'handwriting'
            ? { tiers: ['handwriting'], forceCategory: 'handwritten' }
            : mode === 'layout'
              ? { tiers: ['document-ai'], forceCategory: 'document-layout' }
              : mode === 'describe'
                ? { tiers: ['cloud-vision'] }
                : undefined;
      const result = await pipeline.process(input, options);
      return {
        success: true,
        output: {
          mode,
          text: result.text,
          confidence: result.confidence,
          category: result.category,
          tiers: result.tiers,
          regions: result.regions?.length ?? 0,
          ...(result.layout ? { layout: result.layout } : {}),
          ...(result.failedTiers?.length ? { failedTiers: result.failedTiers } : {}),
          durationMs: result.durationMs,
        },
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

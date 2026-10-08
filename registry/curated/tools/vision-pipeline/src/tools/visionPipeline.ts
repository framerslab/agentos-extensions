// @ts-nocheck
/**
 * @fileoverview The vision-pipeline tool: OCR, handwriting, document layout,
 * image description and CLIP embeddings through an AgentOS VisionPipeline.
 */

import type { ITool, JSONSchemaObject, ToolExecutionContext, ToolExecutionResult } from '@framers/agentos';

/** What the tool reads from an image; see {@link VisionPipelineTool}. */
export type VisionMode = 'ocr' | 'handwriting' | 'layout' | 'describe' | 'embed' | 'auto';

/** The vision-pipeline tool's input. */
export interface VisionPipelineInput {
  /** The image: a data:image URL, or an http(s) URL on a public host. */
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

/** Whether an IPv4 address, as its four numbers, is this machine or a private network. */
function isPrivateIPv4([a, b]: number[]): boolean {
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local, where cloud metadata services answer
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT
  );
}

/**
 * Whether a URL's host is this machine or a private network: `localhost`,
 * loopback, link-local (the metadata address 169.254.169.254 among them),
 * the private and carrier-grade NAT IPv4 ranges, and their IPv6 forms. The
 * URL parser has already written other IPv4 spellings (`0x7f000001`,
 * `127.1`) as dotted numbers. A public name that resolves to a private
 * address, or redirects to one, is not caught here.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) return isPrivateIPv4(v4.slice(1).map(Number));
  if (!host.includes(':')) return false;
  if (host === '::' || host === '::1') return true;
  // An IPv4-mapped address, as the URL parser writes it (::ffff:7f00:1).
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped) {
    const high = parseInt(mapped[1], 16);
    const low = parseInt(mapped[2], 16);
    return isPrivateIPv4([high >> 8, high & 255, low >> 8, low & 255]);
  }
  const first = parseInt(host.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80; // unique local fc00::/7, link-local fe80::/10
}

/**
 * The bytes of a percent-encoded data URL payload: each `%XX` is one byte,
 * any other character its UTF-8 bytes. A `%` that starts no valid escape is
 * kept as it is, so the decoding never throws.
 */
function percentDecode(payload: string): Buffer {
  const parts: Buffer[] = [];
  let last = 0;
  for (const match of payload.matchAll(/%([0-9a-fA-F]{2})/g)) {
    parts.push(Buffer.from(payload.slice(last, match.index), 'utf8'), Buffer.from([parseInt(match[1], 16)]));
    last = match.index + 3;
  }
  parts.push(Buffer.from(payload.slice(last), 'utf8'));
  return Buffer.concat(parts);
}

/**
 * The image as the pipeline takes it: a data URL decoded to its bytes, an
 * http(s) URL whose host is not this machine or a private network as is, or
 * `undefined` for anything else. AgentOS also reads local file paths and
 * fetches any URL, but a tool the model calls must not send the machine's
 * files, or what its network serves, to a cloud vision model.
 */
export function imageInput(value: unknown): Buffer | string | undefined {
  if (typeof value !== 'string') return undefined;
  const source = value.trim();
  if (/^https?:\/\//i.test(source)) {
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      return undefined;
    }
    return isPrivateHost(url.hostname) ? undefined : source;
  }
  const data = /^data:image\/[^,]*?(;base64)?,(.*)$/is.exec(source);
  if (!data) return undefined;
  return data[1] ? Buffer.from(data[2], 'base64') : percentDecode(data[2]);
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
      imageUrl: { type: 'string', description: 'The image: an http(s) URL or a data:image URL.' },
      mode: {
        type: 'string',
        enum: ['ocr', 'handwriting', 'layout', 'describe', 'embed', 'auto'],
        description:
          'ocr for printed text, handwriting, layout for document structure, describe for what the image shows, ' +
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

  constructor(private readonly pipelineFor: PipelineFor) {}

  async execute(args: VisionPipelineInput, _context?: ToolExecutionContext): Promise<ToolExecutionResult<VisionPipelineOutput>> {
    const image = imageInput(args.imageUrl);
    if (image === undefined) {
      return {
        success: false,
        error: 'imageUrl must be a data:image URL or an http(s) URL on a public host: local file paths are not read, nor local or private network addresses.',
      };
    }
    const mode: VisionMode = args.mode ?? 'auto';
    if (typeof mode !== 'string' || !Object.hasOwn(TIER_NEEDED, mode)) {
      return { success: false, error: `mode must be one of ${Object.keys(TIER_NEEDED).join(', ')}.` };
    }
    const maxTier = args.maxTier === 1 || args.maxTier === 2 ? args.maxTier : 3;
    if (TIER_NEEDED[mode] > maxTier) {
      return { success: false, error: `${mode} needs maxTier ${TIER_NEEDED[mode]} or higher; this call allows ${maxTier}.` };
    }

    try {
      const pipeline = await this.pipelineFor(maxTier === 3 ? 'progressive' : 'local-only');
      if (mode === 'embed') {
        const embedding = await pipeline.embed(image);
        return { success: true, output: { mode, embedding, dimensions: embedding.length } };
      }
      const options =
        maxTier === 1 || mode === 'ocr'
          ? { tiers: ['ocr'] }
          : mode === 'handwriting'
            ? { forceCategory: 'handwritten' }
            : mode === 'layout'
              ? { forceCategory: 'document-layout' }
              : mode === 'describe'
                ? { tiers: ['cloud-vision'] }
                : undefined;
      const result = await pipeline.process(image, options);
      return {
        success: true,
        output: {
          mode,
          text: result.text,
          confidence: result.confidence,
          category: result.category,
          tiers: result.tiers,
          regions: result.regions?.length ?? 0,
          durationMs: result.durationMs,
        },
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

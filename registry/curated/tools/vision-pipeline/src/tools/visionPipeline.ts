// @ts-nocheck
/**
 * @fileoverview The vision-pipeline tool: OCR, handwriting, document layout,
 * image description and CLIP embeddings through an AgentOS VisionPipeline.
 */

import type { ITool, JSONSchemaObject, ToolExecutionContext, ToolExecutionResult } from '@framers/agentos';

export type VisionMode = 'ocr' | 'handwriting' | 'layout' | 'describe' | 'embed' | 'auto';

export interface VisionPipelineInput {
  imageUrl: string;
  mode?: VisionMode;
  maxTier?: 1 | 2 | 3;
}

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

/**
 * The image as the pipeline takes it: a data URL decoded to its bytes, an
 * http(s) URL as is, or `undefined` for anything else. AgentOS also reads
 * local file paths, but a tool the model calls must not read the machine's
 * files and send them to a cloud vision model.
 */
export function imageInput(value: unknown): Buffer | string | undefined {
  if (typeof value !== 'string') return undefined;
  const source = value.trim();
  if (/^https?:\/\//i.test(source)) return source;
  const data = /^data:image\/[^,]*?(;base64)?,(.*)$/is.exec(source);
  if (!data) return undefined;
  return data[1] ? Buffer.from(data[2], 'base64') : Buffer.from(decodeURIComponent(data[2]), 'utf8');
}

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
      return { success: false, error: 'imageUrl must be an http(s) URL or a data:image URL; local file paths are not read.' };
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

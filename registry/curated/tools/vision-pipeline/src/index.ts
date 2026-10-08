// @ts-nocheck
/**
 * @fileoverview Vision & OCR Pipeline Extension Pack: the vision-pipeline tool
 * on AgentOS's `createVisionPipeline`.
 *
 * Pipeline tiers:
 *   Tier 1 (local, fast):   PaddleOCR or Tesseract for printed text
 *   Tier 2 (local, medium): TrOCR for handwriting, Florence-2 for layout, CLIP embeddings
 *   Tier 3 (cloud, slow):   a vision model of the provider whose key is set
 *
 * The local tiers need their optional packages (ppu-paddle-ocr or tesseract.js,
 * and @huggingface/transformers); AgentOS uses the ones it finds installed.
 * The cloud tier reads OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY (or
 * GEMINI_API_KEY) or OPENROUTER_API_KEY from the environment.
 *
 * @module @framers/agentos-ext-vision-pipeline
 */

import { createRequire } from 'node:module';
import { createVisionPipeline } from '@framers/agentos';
import { VisionPipelineTool, type VisionStrategy } from './tools/visionPipeline.js';

const { version } = createRequire(import.meta.url)('../package.json');

/** What the extension manager passes the pack factory. */
export interface ExtensionContext {
  /** `priority` of the tool descriptor (default 45); `openaiApiKey` for the cloud tier. */
  options?: { priority?: number; openaiApiKey?: string } & Record<string, unknown>;
  /** Reads a secret, such as `openai.apiKey`. */
  getSecret?: (key: string) => string | undefined;
  logger?: { info: (msg: string) => void; warn?: (msg: string) => void };
}

/** The pack the factory returns: one `vision-pipeline` tool descriptor. */
export interface ExtensionPack {
  name: string;
  version: string;
  descriptors: Array<{
    id: string;
    kind: string;
    priority?: number;
    payload: unknown;
    requiredSecrets?: Array<{ id: string; optional?: boolean }>;
  }>;
  onActivate?: () => Promise<void>;
  onDeactivate?: () => Promise<void>;
}

/**
 * Create the Vision & OCR Pipeline extension pack.
 *
 * The pack builds a pipeline per strategy the first time a call needs it:
 * building one probes for the optional OCR and model packages, which loading
 * the pack does not do. A build that fails is tried again on the next call.
 */
export function createExtensionPack(context: ExtensionContext = {}): ExtensionPack {
  // An OpenAI key from the options or the secrets makes OpenAI the cloud tier's
  // provider, with that key. Without one, AgentOS detects the provider and its
  // key from the environment. AgentOS releases whose VisionPipelineConfig has
  // no cloudApiKey ignore it and read OPENAI_API_KEY.
  const openaiKey = context.options?.openaiApiKey || context.getSecret?.('openai.apiKey');
  const cloud = openaiKey ? { cloudProvider: 'openai', cloudApiKey: openaiKey } : {};
  const pipelines = new Map<VisionStrategy, Promise<any>>();
  const pipelineFor = (strategy: VisionStrategy) => {
    let pipeline = pipelines.get(strategy);
    if (!pipeline) {
      pipeline = createVisionPipeline({ strategy, ...cloud });
      pipelines.set(strategy, pipeline);
      const built = pipeline;
      built.catch(() => {
        if (pipelines.get(strategy) === built) pipelines.delete(strategy);
      });
    }
    return pipeline;
  };
  const tool = new VisionPipelineTool(pipelineFor);

  return {
    name: '@framers/agentos-ext-vision-pipeline',
    version,
    descriptors: [
      {
        id: tool.name,
        kind: 'tool',
        priority: context.options?.priority ?? 45,
        payload: tool,
        requiredSecrets: [{ id: 'openai.apiKey', optional: true }],
      },
    ],
    onActivate: async () => context.logger?.info('Vision & OCR Pipeline Extension activated'),
    onDeactivate: async () => {
      const built = [...pipelines.values()];
      pipelines.clear();
      for (const pipeline of built) {
        let instance;
        try {
          instance = await pipeline;
        } catch {
          continue; // A pipeline that failed to build has nothing to release.
        }
        try {
          await instance.dispose();
        } catch (error) {
          const log = context.logger?.warn ?? context.logger?.info;
          log?.call(context.logger, `Vision & OCR Pipeline: disposing of a pipeline failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      context.logger?.info('Vision & OCR Pipeline Extension deactivated');
    },
  };
}

export { VisionPipelineTool, imageInput } from './tools/visionPipeline.js';
export type { VisionPipelineInput, VisionPipelineOutput, VisionMode } from './tools/visionPipeline.js';
export default createExtensionPack;

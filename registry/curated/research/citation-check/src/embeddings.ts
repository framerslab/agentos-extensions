/**
 * @file embeddings.ts
 * @description Embedding functions from AgentOS's own surface, for `CitationVerifier` to grade with: one over
 * `embedText` and its OpenAI provider (a key and, when wanted, a base address of an OpenAI-compatible endpoint), and one
 * over an `IEmbeddingManager` a host has already configured. AgentOS is loaded when the first texts are embedded, so a
 * check that grades by words alone never loads it.
 *
 * @module agentos/extensions/research/citation-check/embeddings
 */

import type { EmbedFn } from './types.js';

/** How the OpenAI embedding function calls AgentOS's `embedText`. */
export interface OpenAIEmbeddingOptions {
  /** The API key; `OPENAI_API_KEY` from the environment when left out. */
  apiKey?: string;
  /** An OpenAI-compatible base address, such as `https://api.openai.com/v1`; `OPENAI_BASE_URL` or OpenAI's own when left out. */
  baseUrl?: string;
  /** The embedding model; AgentOS's default for OpenAI when left out. */
  model?: string;
  /** The dimensions of each vector, for a model that can reduce them. */
  dimensions?: number;
}

/**
 * An embedding function over AgentOS's `embedText` with the OpenAI provider; from AgentOS 0.13.84 a long list goes in the
 * batches the provider takes. Each call is billed by the provider.
 *
 * @param options - The key, the base address, the model and the dimensions.
 */
export function openAIEmbeddings(options: OpenAIEmbeddingOptions = {}): EmbedFn {
  return async (texts) => {
    const { embedText } = await import('@framers/agentos');
    const result = await embedText({
      provider: 'openai',
      input: texts,
      ...(options.model ? { model: options.model } : {}),
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      ...(options.dimensions ? { dimensions: options.dimensions } : {}),
    });
    if (result.embeddings.length !== texts.length) {
      throw new Error(`the embedding provider answered ${result.embeddings.length} vectors for ${texts.length} texts`);
    }
    return result.embeddings;
  };
}

/** The part of AgentOS's `IEmbeddingManager` the embedding function calls. */
export interface EmbeddingManagerLike {
  generateEmbeddings(request: { texts: string[]; modelId?: string; providerId?: string }): Promise<{
    embeddings: number[][];
    errors?: Array<{ textIndex: number; message: string }>;
  }>;
}

/**
 * An embedding function over an embedding manager the host has configured, such as AgentOS's `EmbeddingManager`. A
 * batch in which any text failed is refused as a whole.
 *
 * @param manager - The manager.
 * @param request - The model and the provider each request names; the manager's own choice when left out.
 */
export function managerEmbeddings(manager: EmbeddingManagerLike, request: { modelId?: string; providerId?: string } = {}): EmbedFn {
  return async (texts) => {
    const response = await manager.generateEmbeddings({ texts, ...request });
    const failed = response.errors?.[0];
    if (failed !== undefined) throw new Error(`the embedding manager failed text ${failed.textIndex + 1} of ${texts.length}: ${failed.message}`);
    if (response.embeddings.length !== texts.length) {
      throw new Error(`the embedding manager answered ${response.embeddings.length} vectors for ${texts.length} texts`);
    }
    return response.embeddings;
  };
}

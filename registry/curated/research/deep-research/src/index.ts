// @ts-nocheck
/**
 * @fileoverview Deep Research Extension for AgentOS.
 *
 * Provides 5 tools for multi-source investigation, academic search,
 * content scraping, aggregate search, and trend discovery.
 *
 * @module @framers/agentos-ext-deep-research
 */

import { ResearchService } from './ResearchService.js';
import type { ResearchConfig } from './ResearchService.js';
import { ResearchInvestigateTool } from './tools/investigate.js';
import { ResearchAcademicTool } from './tools/academic.js';
import { ResearchScrapeTool } from './tools/scrape.js';
import { ResearchAggregateTool } from './tools/aggregate.js';
import { ResearchTrendingTool } from './tools/trending.js';
import { DeepResearchEngine } from './engine/DeepResearchEngine.js';
import { DeepResearchTool } from './engine/DeepResearchTool.js';
import type { LLMInvoker, SearchResultItem } from './engine/types.js';
import { PACKAGE_VERSION } from './packageVersion.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface DeepResearchOptions {
  serperApiKey?: string;
  braveApiKey?: string;
  serpApiKey?: string;
  secrets?: Record<string, string>;
  /** OpenAI-compatible API key for LLM calls (decomposition, gap analysis, synthesis). */
  openaiApiKey?: string;
  /** OpenRouter API key — used as fallback if openaiApiKey is not set. */
  openrouterApiKey?: string;
  /** Primary LLM provider: 'openai' | 'openrouter' | 'ollama'. Defaults to 'openai'. */
  primaryProvider?: string;
  /** Small model for decomposition/gap analysis (default: gpt-4o-mini). */
  smallModel?: string;
  /** Synthesis model (default: gpt-4o). */
  synthesisModel?: string;
}

// ---------------------------------------------------------------------------
// Secret Resolution
// ---------------------------------------------------------------------------

function resolveConfig(opts: DeepResearchOptions, secrets: Record<string, string>): ResearchConfig {
  return {
    serperApiKey: opts.serperApiKey ?? secrets['serper.apiKey'] ?? process.env.SERPER_API_KEY ?? '',
    braveApiKey: opts.braveApiKey ?? secrets['brave.apiKey'] ?? process.env.BRAVE_API_KEY,
    serpApiKey: opts.serpApiKey ?? secrets['serpapi.apiKey'] ?? process.env.SERPAPI_API_KEY,
  };
}

// ---------------------------------------------------------------------------
// LLM Invoker Construction
// ---------------------------------------------------------------------------

interface LLMEndpointConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
}

function buildInvoker(cfg: LLMEndpointConfig): LLMInvoker {
  return async (prompt: string): Promise<string> => {
    const resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: cfg.maxTokens,
      }),
    });
    if (!resp.ok) {
      throw new Error(`LLM API error ${resp.status}: ${await resp.text().catch(() => 'unknown')}`);
    }
    const data = await resp.json() as any;
    return data.choices?.[0]?.message?.content ?? '';
  };
}

function resolveLLMConfig(opts: DeepResearchOptions, secrets: Record<string, string>) {
  const provider = opts.primaryProvider ?? 'openai';
  const apiKey =
    opts.openaiApiKey ??
    secrets['openai.apiKey'] ??
    opts.openrouterApiKey ??
    secrets['openrouter.apiKey'] ??
    process.env.OPENAI_API_KEY ??
    process.env.OPENROUTER_API_KEY ??
    '';

  let baseUrl: string;
  if (provider === 'openrouter' || (!opts.openaiApiKey && (opts.openrouterApiKey || process.env.OPENROUTER_API_KEY))) {
    baseUrl = 'https://openrouter.ai/api/v1';
  } else if (provider === 'ollama') {
    baseUrl = 'http://localhost:11434/v1';
  } else {
    baseUrl = 'https://api.openai.com/v1';
  }

  const smallModel = opts.smallModel ?? 'gpt-4o-mini';
  const synthesisModel = opts.synthesisModel ?? 'gpt-4o';

  return { apiKey, baseUrl, smallModel, synthesisModel };
}

// ---------------------------------------------------------------------------
// Extension Context (matches AgentOS extension protocol)
// ---------------------------------------------------------------------------

export interface ExtensionContext {
  options?: Record<string, unknown>;
  secrets?: Record<string, string>;
}

export interface ExtensionPack {
  name: string;
  version: string;
  descriptors: Array<{ id: string; kind: string; priority?: number; payload: unknown }>;
  onActivate?: () => Promise<void>;
  onDeactivate?: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createExtensionPack(context: ExtensionContext): ExtensionPack {
  const opts = (context.options ?? {}) as DeepResearchOptions;
  const secrets = opts.secrets ?? context.secrets ?? {};
  const config = resolveConfig(opts, secrets);

  const service = new ResearchService(config);

  const investigateTool = new ResearchInvestigateTool(service);
  const academicTool = new ResearchAcademicTool(service);
  const scrapeTool = new ResearchScrapeTool(service);
  const aggregateTool = new ResearchAggregateTool(service);
  const trendingTool = new ResearchTrendingTool(service);

  // ── Deep Research Engine ──
  const llmConfig = resolveLLMConfig(opts, secrets);
  const hasLLMKey = llmConfig.apiKey.length > 0;

  const smallInvoker: LLMInvoker = hasLLMKey
    ? buildInvoker({ apiKey: llmConfig.apiKey, baseUrl: llmConfig.baseUrl, model: llmConfig.smallModel, maxTokens: 1000 })
    : async () => '[]'; // No-op fallback — engine will use raw query

  const synthesisInvoker: LLMInvoker = hasLLMKey
    ? buildInvoker({ apiKey: llmConfig.apiKey, baseUrl: llmConfig.baseUrl, model: llmConfig.synthesisModel, maxTokens: 4000 })
    : async () => ''; // No-op fallback — engine will use fallbackSynthesis

  // Wire search function to use the existing SearchProviderService if web-search extension is loaded,
  // otherwise fall back to engine's built-in DDG scraping
  const searchFn = async (query: string, maxResults?: number): Promise<SearchResultItem[]> => {
    try {
      const results = await service.aggregateSearch(query, ['serper', 'brave', 'serpapi'], maxResults ?? 10);
      return results.flatMap((r) =>
        r.results.map((item) => ({ title: item.title, url: item.url, snippet: item.snippet })),
      );
    } catch {
      return []; // Engine will fall back to DDG scraping
    }
  };

  const engine = new DeepResearchEngine({
    smallInvoker,
    synthesisInvoker,
    searchFn: config.serperApiKey ? searchFn : undefined, // Only use searchFn if we have API keys
    onProgress: (event) => {
      if (process.env.DEBUG) {
        console.log(`[DeepResearch] ${event.phase} — iteration ${event.iteration}/${event.totalIterations}, findings: ${event.findingsCount}, sources: ${event.sourcesCount}`);
      }
    },
  });

  const deepResearchTool = new DeepResearchTool(engine);

  return {
    name: '@framers/agentos-ext-deep-research',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'researchInvestigate', kind: 'tool', priority: 50, payload: investigateTool },
      { id: 'researchAcademic', kind: 'tool', priority: 50, payload: academicTool },
      { id: 'researchScrape', kind: 'tool', priority: 50, payload: scrapeTool },
      { id: 'researchAggregate', kind: 'tool', priority: 50, payload: aggregateTool },
      { id: 'researchTrending', kind: 'tool', priority: 50, payload: trendingTool },
      { id: 'deepResearch', kind: 'tool', priority: 90, payload: deepResearchTool },
    ],
    onActivate: async () => {
      await service.initialize();
    },
    onDeactivate: async () => {
      await service.shutdown();
    },
  };
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

export { ResearchService } from './ResearchService.js';
export type {
  ResearchConfig,
  InvestigationResult,
  AcademicResult,
  ScrapeResult,
  AggregateResult,
  TrendingResult,
} from './ResearchService.js';
export { ResearchInvestigateTool } from './tools/investigate.js';
export { ResearchAcademicTool } from './tools/academic.js';
export { ResearchScrapeTool } from './tools/scrape.js';
export { ResearchAggregateTool } from './tools/aggregate.js';
export { ResearchTrendingTool } from './tools/trending.js';
export { DeepResearchEngine } from './engine/DeepResearchEngine.js';
export { DeepResearchTool } from './engine/DeepResearchTool.js';
export { ResearchBudgetTracker } from './engine/ResearchBudgetTracker.js';
export type {
  DeepResearchInput,
  DeepResearchOutput,
  ResearchDepth,
  ResearchBudget,
  LLMInvoker,
  DeepResearchEngineConfig,
} from './engine/types.js';

// @ts-nocheck
/**
 * @file Extension pack entry point
 * @description Creates and exports the extension pack for AgentOS
 */

import type { ExtensionPack, ExtensionPackContext } from '@framers/agentos';
import { ExampleTool } from './tools/exampleTool';

/**
 * Creates the extension pack with all tools, guardrails, and other extensions
 */
export function createExtensionPack(context: ExtensionPackContext): ExtensionPack {
  const { options = {} } = context;
  
  // Initialize any services or configuration
  const config = {
    apiKey: options.apiKey || process.env.TEMPLATE_API_KEY,
    endpoint: options.endpoint || 'https://api.example.com',
    ...options
  };

  const tool = new ExampleTool(config);

  return {
    name: '@framers/agentos-ext-template',
    // Read from package.json, which every published tarball carries, so a release
    // cannot leave the reported version behind the installed one.
    version: require('../package.json').version,
    descriptors: [
      {
        id: 'exampleTool',
        kind: 'tool',
        payload: tool,
        priority: 10,
        enableByDefault: true,
        requiredSecrets: [{ id: 'openai.apiKey' }],
        metadata: {
          category: 'utility',
          requiresApiKey: true,
          documentation: 'https://github.com/framerslab/agentos-extensions/tree/main/packages/ext-template'
        },
        source: context.source,
        onActivate: async (ctx) => {
          ctx.logger?.info('[Template Extension] Example tool activated');
          const secret = ctx.getSecret?.('openai.apiKey');
          if (secret) {
            tool.setApiKey(secret);
          }
        },
        onDeactivate: async (ctx) => {
          ctx.logger?.info('[Template Extension] Example tool deactivated');
        }
      }
      // Add more tools, guardrails, etc. here
    ]
  };
}

// Default export for CommonJS compatibility
export default createExtensionPack;

// Named exports for specific tools if needed
export { ExampleTool } from './tools/exampleTool';
export type { ExampleToolInput, ExampleToolOutput } from './types';

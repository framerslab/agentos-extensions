// @ts-nocheck
/**
 * Clearbit Extension Pack — provides company and person enrichment tools
 * powered by the Clearbit API.
 *
 * Usage with AgentOS extension loader:
 * ```ts
 * import createExtensionPack from '@framers/agentos-ext-clearbit';
 * const pack = createExtensionPack(context);
 * ```
 */

import { ClearbitCompanyTool } from './tools/clearbitCompany.js';
import { ClearbitPersonTool } from './tools/clearbitPerson.js';
import { PACKAGE_VERSION } from './packageVersion.js';

/** Configuration options for the Clearbit extension pack. */
export interface ClearbitExtensionOptions {
  /** Clearbit API key override. */
  clearbitApiKey?: string;
  /** Priority weight for tool discovery ordering. */
  priority?: number;
}

/**
 * Factory function that creates the Clearbit extension pack.
 *
 * Resolves the API key from (in order of precedence):
 * 1. `options.clearbitApiKey`
 * 2. `context.getSecret?.('clearbit.apiKey')`
 * 3. `process.env.CLEARBIT_API_KEY`
 *
 * @param context - AgentOS extension activation context.
 * @returns An extension pack containing the `clearbit_company` and `clearbit_person` tool descriptors.
 */
export function createExtensionPack(context: any) {
  const options = (context.options || {}) as ClearbitExtensionOptions;
  const apiKey =
    options.clearbitApiKey ||
    context.getSecret?.('clearbit.apiKey') ||
    process.env.CLEARBIT_API_KEY;

  const companyTool = new ClearbitCompanyTool(apiKey);
  const personTool = new ClearbitPersonTool(apiKey);

  return {
    name: '@framers/agentos-ext-clearbit',
    version: PACKAGE_VERSION,
    descriptors: [
      {
        // IMPORTANT: ToolExecutor uses descriptor id as the lookup key for tool calls.
        // Keep it aligned with `tool.name`.
        id: companyTool.name,
        kind: 'tool' as const,
        priority: options.priority || 50,
        payload: companyTool,
        requiredSecrets: [{ id: 'clearbit.apiKey' }],
      },
      {
        id: personTool.name,
        kind: 'tool' as const,
        priority: options.priority || 50,
        payload: personTool,
        requiredSecrets: [{ id: 'clearbit.apiKey' }],
      },
    ],
    onActivate: async () => context.logger?.info('Clearbit Extension activated'),
    onDeactivate: async () => context.logger?.info('Clearbit Extension deactivated'),
  };
}

export { ClearbitService } from './ClearbitService.js';
export { ClearbitCompanyTool } from './tools/clearbitCompany.js';
export { ClearbitPersonTool } from './tools/clearbitPerson.js';
export type { ClearbitCompany, ClearbitPerson } from './ClearbitService.js';
export type { ClearbitCompanyInput, ClearbitCompanyOutput } from './tools/clearbitCompany.js';
export type { ClearbitPersonInput, ClearbitPersonOutput } from './tools/clearbitPerson.js';
export default createExtensionPack;

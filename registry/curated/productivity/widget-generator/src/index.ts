// @ts-nocheck
/**
 * @module index
 *
 * Widget Generator Extension Pack — generates self-contained interactive
 * HTML/CSS/JS widgets with safety wrapping and file management.
 *
 * Entry point for the extension; follows the standard AgentOS extension
 * pack factory pattern (see {@link createExtensionPack}). The factory
 * wires up the {@link WidgetWrapper} for HTML safety, the
 * {@link WidgetFileManager} for file persistence, and registers the
 * `generate_widget` tool.
 */

import { WidgetWrapper } from './WidgetWrapper.js';
import { WidgetFileManager } from './WidgetFileManager.js';
import { GenerateWidgetTool } from './tools/generateWidget.js';
import { PACKAGE_VERSION } from './packageVersion.js';

/**
 * Options accepted by the Widget Generator extension pack factory.
 */
export interface WidgetGeneratorExtensionOptions {
  /** Override the default priority used when registering the tool. */
  priority?: number;

  /** Override the agent workspace directory (defaults to `process.cwd()`). */
  workspaceDir?: string;

  /** Override the server port used for widget URLs (defaults to `3777`). */
  serverPort?: number;

  /** Override the externally reachable base URL used in widget links. */
  publicBaseUrl?: string;
}

/**
 * Factory function called by the AgentOS extension loader. Returns a pack
 * descriptor containing the `generate_widget` tool.
 *
 * The factory:
 *
 * 1. Resolves the workspace directory and server port from context options.
 * 2. Creates the {@link WidgetWrapper} for HTML safety wrapping.
 * 3. Creates the {@link WidgetFileManager} for file I/O.
 * 4. Wires both into the {@link GenerateWidgetTool}.
 * 5. Returns the tool as an extension pack descriptor with lifecycle hooks.
 *
 * @param context - Extension activation context provided by the AgentOS runtime.
 * @returns An extension pack with tool descriptors and lifecycle hooks.
 */
export function createExtensionPack(context: any) {
  const options = (context.options || {}) as WidgetGeneratorExtensionOptions;

  // Resolve configuration
  const workspaceDir = options.workspaceDir ?? process.cwd();
  const serverPort = options.serverPort ?? 3777;
  const priority = options.priority ?? 50;
  const publicBaseUrl = options.publicBaseUrl;

  // Create dependencies
  const wrapper = new WidgetWrapper();
  const fileManager = new WidgetFileManager(workspaceDir, serverPort, publicBaseUrl);

  // Create the tool with all dependencies injected
  const tool = new GenerateWidgetTool(wrapper, fileManager);

  return {
    name: '@framers/agentos-ext-widget-generator',
    version: PACKAGE_VERSION,
    descriptors: [
      {
        // IMPORTANT: ToolExecutor uses descriptor id as the lookup key for tool calls.
        // Keep it aligned with `tool.name`.
        id: tool.name,
        kind: 'tool' as const,
        priority,
        payload: tool,
      },
    ],
    onActivate: async () =>
      context.logger?.info('Interactive Widgets activated'),
    onDeactivate: async () =>
      context.logger?.info('Interactive Widgets deactivated'),
  };
}

export default createExtensionPack;

// Re-export classes for direct consumption
export { WidgetWrapper } from './WidgetWrapper.js';
export { WidgetFileManager } from './WidgetFileManager.js';
export { GenerateWidgetTool } from './tools/generateWidget.js';

// Re-export all public types so consumers can `import { ... } from '@framers/agentos-ext-widget-generator'`.
export type { GenerateWidgetInput, GenerateWidgetOutput } from './types.js';
export type { WidgetFileEntry, WidgetSaveResult } from './WidgetFileManager.js';

// @ts-nocheck
/**
 * AgentOS Stealth Browser Extension
 *
 * Provides stealth browser automation using puppeteer-extra with the stealth plugin
 * to bypass anti-bot detection on sites like Amazon, eBay, LinkedIn, and Cloudflare-
 * protected pages.
 *
 * Key differences from web-browser extension:
 * - Uses puppeteer-extra instead of puppeteer-core
 * - Applies stealth plugin for comprehensive anti-fingerprinting
 * - Extra anti-detection Chromium launch args
 * - Realistic user agent rotation (Chrome 120+ on macOS/Windows)
 * - WebDriver property removal and chrome.runtime injection
 * - Human-like typing delay defaults (50ms between keystrokes)
 *
 * @module @framers/agentos-ext-stealth-browser
 * @version 1.0.0
 * @license Apache-2.0
 */

import { StealthBrowserService } from './StealthBrowserService.js';
import { StealthNavigateTool } from './tools/navigate.js';
import { StealthScrapeTool } from './tools/scrape.js';
import { StealthClickTool } from './tools/click.js';
import { StealthTypeTool } from './tools/type.js';
import { StealthScreenshotTool } from './tools/screenshot.js';
import { StealthSnapshotTool } from './tools/snapshot.js';
import type { StealthBrowserConfig } from './types.js';

/**
 * Extension configuration options
 */
export interface StealthBrowserExtensionOptions extends StealthBrowserConfig {
  /** Extension priority in the stack */
  priority?: number;
}

/**
 * Creates the stealth browser extension pack
 *
 * @param context - The extension context
 * @returns The configured extension pack
 *
 * @example
 * ```typescript
 * import { createExtensionPack } from '@framers/agentos-ext-stealth-browser';
 *
 * const pack = createExtensionPack({
 *   options: {
 *     headless: true,
 *     timeout: 30000,
 *     viewport: { width: 1920, height: 1080 }
 *   },
 *   logger: console
 * });
 * ```
 */
export function createExtensionPack(context: {
  options?: Record<string, unknown>;
  secrets?: Record<string, string>;
  logger?: { info: (...args: unknown[]) => void };
  onActivate?: () => Promise<void>;
  onDeactivate?: () => Promise<void>;
  [key: string]: unknown;
}) {
  const options = (context.options as StealthBrowserExtensionOptions) || {};

  // Initialize stealth browser service with configuration
  const browserService = new StealthBrowserService({
    headless: options.headless,
    timeout: options.timeout,
    userAgent: options.userAgent,
    viewport: options.viewport,
    executablePath: options.executablePath,
    enableEvasions: options.enableEvasions,
  });

  // Create tool instances
  const navigateTool = new StealthNavigateTool(browserService);
  const scrapeTool = new StealthScrapeTool(browserService);
  const clickTool = new StealthClickTool(browserService);
  const typeTool = new StealthTypeTool(browserService);
  const screenshotTool = new StealthScreenshotTool(browserService);
  const snapshotTool = new StealthSnapshotTool(browserService);

  return {
    name: '@framers/agentos-ext-stealth-browser',
    version: '1.0.0',
    descriptors: [
      {
        id: navigateTool.name,
        kind: 'tool',
        priority: options.priority || 50,
        payload: navigateTool,
      },
      {
        id: scrapeTool.name,
        kind: 'tool',
        priority: options.priority || 50,
        payload: scrapeTool,
      },
      {
        id: clickTool.name,
        kind: 'tool',
        priority: options.priority || 50,
        payload: clickTool,
      },
      {
        id: typeTool.name,
        kind: 'tool',
        priority: options.priority || 50,
        payload: typeTool,
      },
      {
        id: screenshotTool.name,
        kind: 'tool',
        priority: options.priority || 50,
        payload: screenshotTool,
      },
      {
        id: snapshotTool.name,
        kind: 'tool',
        priority: options.priority || 50,
        payload: snapshotTool,
      },
    ],

    /**
     * Called when extension is activated
     */
    onActivate: async () => {
      if (context.onActivate) {
        await context.onActivate();
      }
      context.logger?.info('Stealth Browser Extension activated');
    },

    /**
     * Called when extension is deactivated
     */
    onDeactivate: async () => {
      await browserService.close();
      if (context.onDeactivate) {
        await context.onDeactivate();
      }
      context.logger?.info('Stealth Browser Extension deactivated');
    },
  };
}

// Export types and classes for consumers
export { StealthBrowserService } from './StealthBrowserService.js';
export { StealthNavigateTool } from './tools/navigate.js';
export { StealthScrapeTool } from './tools/scrape.js';
export { StealthClickTool } from './tools/click.js';
export { StealthTypeTool } from './tools/type.js';
export { StealthScreenshotTool } from './tools/screenshot.js';
export { StealthSnapshotTool } from './tools/snapshot.js';
export * from './types.js';

// Default export for convenience
export default createExtensionPack;

// @ts-nocheck
/**
 * @fileoverview Browser Automation Extension for AgentOS.
 *
 * Provides 10 tools for autonomous web browsing: navigation, DOM interaction,
 * screenshots, content extraction, page snapshots, JS evaluation, and session
 * management. Includes optional CAPTCHA solving and proxy rotation.
 *
 * @module @framers/agentos-ext-browser-automation
 */

import { BrowserService } from './BrowserService.js';
import type { BrowserConfig } from './BrowserService.js';
import { NavigateTool } from './tools/NavigateTool.js';
import { ClickTool } from './tools/ClickTool.js';
import { FillTool } from './tools/FillTool.js';
import { ScreenshotTool } from './tools/ScreenshotTool.js';
import { ExtractTool } from './tools/ExtractTool.js';
import { WaitTool } from './tools/WaitTool.js';
import { ScrollTool } from './tools/ScrollTool.js';
import { PageSnapshotTool } from './tools/PageSnapshotTool.js';
import { EvaluateTool } from './tools/EvaluateTool.js';
import { SessionTool } from './tools/SessionTool.js';
import { CaptchaSolver } from './captcha/CaptchaSolver.js';
import { ProxyManager } from './proxy/ProxyManager.js';
import { AttachController } from './attach/AttachController.js';
import { JxaBackend } from './attach/backends/jxa.js';
import { DaemonAttachSurface } from './attach/daemon/surface.js';
import { createAttachTools } from './attach/tools.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Extension Options
// ---------------------------------------------------------------------------

export interface BrowserAutomationOptions {
  headless?: boolean;
  timeout?: number;
  userDataDir?: string;
  proxyServer?: string;
  viewport?: { width: number; height: number };
  secrets?: Record<string, string>;
  /**
   * Opt-in attach mode. When set, the pack ALSO registers the
   * `browser_attach_*` tool family that drives the user's already-running,
   * logged-in browser (never launches one). Default OFF — attach tools touch a
   * real authenticated session, so they must be explicitly enabled per mission
   * (Codex spec review F7/F8). `expectedIdentity` is required and gates the
   * profile the session may claim.
   */
  attach?: {
    expectedIdentity: string;
    leaseFile?: string;
    profileRoot?: string;
    identityProbeUrl?: string;
    /**
     * 'jxa' (macOS, default) runs an in-process AttachController; 'cdp' routes
     * every tool through the persistent attach DAEMON's held session (one
     * process touches the network, one macOS prompt per daemon lifetime).
     */
    transport?: 'jxa' | 'cdp';
    /** Optional https host allowlist for navigation. */
    allowHosts?: string[];
    /** Start in dry-run (simulate navigation/reads without touching the browser). */
    dryRun?: boolean;
    /** Per-operation deadline in ms (default 45s). */
    deadlineMs?: number;
    /** IPC dir override for the cdp/daemon transport. */
    ipcDir?: string;
    /** Autostart the daemon ONCE when down (cdp transport; default off, never retries). */
    autostart?: boolean;
  };
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
  descriptors: Array<{
    id: string;
    kind: string;
    priority?: number;
    enableByDefault?: boolean;
    payload: unknown;
  }>;
  onActivate?: () => Promise<void>;
  onDeactivate?: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Singleton browser instance (shared across all tools)
// ---------------------------------------------------------------------------

let sharedBrowser: BrowserService | null = null;
let sharedCaptcha: CaptchaSolver | null = null;
let sharedProxy: ProxyManager | null = null;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createExtensionPack(context: ExtensionContext): ExtensionPack {
  const opts = (context.options ?? {}) as BrowserAutomationOptions;
  const secrets = opts.secrets ?? context.secrets ?? {};

  // Resolve config
  const config: BrowserConfig = {
    headless: opts.headless ?? true,
    timeout: opts.timeout ?? 30_000,
    userDataDir: opts.userDataDir,
    proxyServer: opts.proxyServer,
    viewport: opts.viewport ?? { width: 1280, height: 720 },
  };

  // Create shared service
  const browser = new BrowserService(config);
  sharedBrowser = browser;

  // Optional captcha solver
  const captchaKey = secrets['twocaptcha.apiKey'] ?? process.env.TWOCAPTCHA_API_KEY;
  if (captchaKey) {
    sharedCaptcha = new CaptchaSolver(captchaKey);
  }

  // Optional proxy manager
  const proxyConfig = secrets['proxy.config'] ?? process.env.PROXY_CONFIG;
  if (proxyConfig) {
    try {
      const parsed = JSON.parse(proxyConfig);
      sharedProxy = new ProxyManager(parsed);
    } catch {
      // Invalid proxy config — skip
    }
  }

  // Create tools
  const navigateTool = new NavigateTool(browser);
  const clickTool = new ClickTool(browser);
  const fillTool = new FillTool(browser);
  const screenshotTool = new ScreenshotTool(browser);
  const extractTool = new ExtractTool(browser);
  const waitTool = new WaitTool(browser);
  const scrollTool = new ScrollTool(browser);
  const snapshotTool = new PageSnapshotTool(browser);
  const evaluateTool = new EvaluateTool(browser);
  const sessionTool = new SessionTool(browser);

  // Opt-in attach tools (default OFF). Built lazily so the launch-mode pack is
  // unaffected when attach is not requested.
  const attachDescriptors: Array<{ id: string; kind: string; priority: number; enableByDefault: boolean; payload: unknown }> = [];
  if (opts.attach?.expectedIdentity) {
    const a = opts.attach;
    // 'cdp' = the persistent daemon's held session (this process never touches
    // the network); 'jxa' (default) = the in-process controller, unchanged.
    const surface = a.transport === 'cdp'
      ? new DaemonAttachSurface({ ipcDir: a.ipcDir, autostart: a.autostart })
      : new AttachController({
          backend: new JxaBackend({ profileRoot: a.profileRoot, identityProbeUrl: a.identityProbeUrl }),
          leaseFile: a.leaseFile ?? join(homedir(), '.wunderland', 'attach.lease'),
          expectedIdentity: a.expectedIdentity,
          urlPolicy: a.allowHosts ? { allowHosts: a.allowHosts } : undefined,
          dryRun: a.dryRun,
          deadlineMs: a.deadlineMs,
        });
    for (const tool of createAttachTools(surface)) {
      attachDescriptors.push({ id: tool.id, kind: 'tool', priority: 50, enableByDefault: false, payload: tool });
    }
  }

  return {
    name: '@framers/agentos-ext-browser-automation',
    version: '0.1.0',
    descriptors: [
      { id: 'browserNavigate', kind: 'tool', priority: 50, payload: navigateTool },
      { id: 'browserClick', kind: 'tool', priority: 50, payload: clickTool },
      { id: 'browserFill', kind: 'tool', priority: 50, payload: fillTool },
      { id: 'browserScreenshot', kind: 'tool', priority: 50, payload: screenshotTool },
      { id: 'browserExtract', kind: 'tool', priority: 50, payload: extractTool },
      { id: 'browserWait', kind: 'tool', priority: 50, payload: waitTool },
      { id: 'browserScroll', kind: 'tool', priority: 50, payload: scrollTool },
      { id: 'browserSnapshot', kind: 'tool', priority: 50, payload: snapshotTool },
      { id: 'browserEvaluate', kind: 'tool', priority: 50, payload: evaluateTool },
      { id: 'browserSession', kind: 'tool', priority: 50, payload: sessionTool },
      ...attachDescriptors,
    ],
    onActivate: async () => {
      await browser.initialize();
    },
    onDeactivate: async () => {
      await browser.shutdown();
      sharedBrowser = null;
      sharedCaptcha = null;
      sharedProxy = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

export { BrowserService } from './BrowserService.js';
export type { BrowserConfig, NavigationResult, PageSnapshot, InteractiveElement, FormInfo, LinkInfo, PageFeedback, StorageState } from './BrowserService.js';
export { CaptchaSolver } from './captcha/CaptchaSolver.js';
export type { ICaptchaProvider, CaptchaSolution } from './captcha/ICaptchaProvider.js';
export { ProxyManager } from './proxy/ProxyManager.js';
export type { IProxyProvider, ProxyConfig, ProxyRotationConfig } from './proxy/IProxyProvider.js';
export { NavigateTool } from './tools/NavigateTool.js';
export { ClickTool } from './tools/ClickTool.js';
export { FillTool } from './tools/FillTool.js';
export { ScreenshotTool } from './tools/ScreenshotTool.js';
export { ExtractTool } from './tools/ExtractTool.js';
export { WaitTool } from './tools/WaitTool.js';
export { ScrollTool } from './tools/ScrollTool.js';
export { PageSnapshotTool } from './tools/PageSnapshotTool.js';
export { EvaluateTool } from './tools/EvaluateTool.js';
export { SessionTool } from './tools/SessionTool.js';

/** Get the shared browser instance (available after extension activation). */
export function getSharedBrowser(): BrowserService | null {
  return sharedBrowser;
}

/** Get the shared captcha solver (available if API key is configured). */
export function getSharedCaptcha(): CaptchaSolver | null {
  return sharedCaptcha;
}

/** Get the shared proxy manager (available if proxy config is set). */
export function getSharedProxy(): ProxyManager | null {
  return sharedProxy;
}

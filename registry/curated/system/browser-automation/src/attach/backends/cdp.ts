/**
 * @fileoverview CDP attach backend (playwright-core `connectOverCDP`).
 *
 * Endpoint discovery re-reads `DevToolsActivePort` on EVERY connect — the
 * browser-target GUID rotates per Chrome boot, and on some machines the
 * DevTools server dies while the port keeps listening; both conditions must
 * surface as structured errors, never hangs (bounded by the controller's
 * deadlines) and never retries-with-relaunch.
 *
 * Non-destructive detach: `disconnectTransport()` DROPS the connection
 * reference without calling `browser.close()`. For a CDP-attached browser,
 * playwright's `close()` also closes contexts/pages it created — including our
 * agent tab — which violates the attach contract's "caller parks, nothing is
 * destroyed" rule (Codex spec review F10). The socket is reaped when the tool
 * process exits; long-running hosts should prefer the JXA backend until a
 * public transport-only disconnect exists.
 *
 * @module browser-automation/attach/backends/cdp
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseDevToolsActivePort } from '../devtools-port.js';
import { AttachError } from '../errors.js';
import type { AttachBackend } from '../AttachController.js';

/** Options for {@link CdpBackend}. */
export interface CdpBackendOptions {
  /** Chrome profile root holding `DevToolsActivePort`. */
  profileRoot?: string;
  /** Identity probe URL (title must reveal the signed-in account). */
  identityProbeUrl?: string;
  /** Connect timeout ms (default 12s). */
  connectTimeoutMs?: number;
}

/** Marker written to the agent tab's `window.name`. */
const MARKER = '__agentos_attach_tab_v1__';

/** CDP transport backend. */
export class CdpBackend implements AttachBackend {
  readonly kind = 'cdp' as const;
  private readonly profileRoot: string;
  private readonly identityProbeUrl: string;
  private readonly connectTimeoutMs: number;
  // Typed loosely so playwright-core stays an optional runtime dependency.
  private browser?: { contexts(): Array<{ pages(): unknown[]; newPage(): Promise<unknown> }> };
  private page?: {
    goto(url: string, opts?: object): Promise<unknown>;
    url(): string;
    title(): Promise<string>;
    evaluate(fn: string): Promise<unknown>;
  };

  constructor(opts: CdpBackendOptions = {}) {
    this.profileRoot = opts.profileRoot ?? join(homedir(), 'Library/Application Support/Google/Chrome');
    this.identityProbeUrl = opts.identityProbeUrl ?? 'https://mail.google.com/mail/u/0/';
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 12_000;
  }

  async connect(): Promise<void> {
    let raw: string;
    try {
      raw = readFileSync(join(this.profileRoot, 'DevToolsActivePort'), 'utf8');
    } catch {
      throw new AttachError('CDP_UNAVAILABLE', 'DevToolsActivePort absent — remote debugging is not enabled on the target browser');
    }
    const endpoint = parseDevToolsActivePort(raw);
    let chromium: { connectOverCDP(url: string, opts: { timeout: number }): Promise<unknown> };
    try {
      ({ chromium } = (await import('playwright-core')) as unknown as { chromium: typeof chromium });
    } catch {
      throw new AttachError('CDP_UNAVAILABLE', 'playwright-core is not installed — CDP backend unavailable');
    }
    try {
      this.browser = (await chromium.connectOverCDP(endpoint.wsUrl, {
        timeout: this.connectTimeoutMs,
      })) as typeof this.browser;
    } catch (err) {
      throw new AttachError('CDP_TIMEOUT', err instanceof Error ? err.message : String(err));
    }
  }

  /** Drop the reference only — never `browser.close()` (see fileoverview). */
  async disconnectTransport(): Promise<void> {
    this.browser = undefined;
    this.page = undefined;
  }

  async claimAgentTab(): Promise<string> {
    const ctx = this.browser?.contexts()[0];
    if (!ctx) throw new AttachError('CDP_UNAVAILABLE', 'no default browser context on the attached browser');
    const page = (await ctx.newPage()) as NonNullable<typeof this.page>;
    await page.evaluate(`window.name = ${JSON.stringify(MARKER)}`);
    this.page = page;
    return MARKER;
  }

  async probeIdentity(): Promise<string> {
    if (!this.page) await this.claimAgentTab();
    await this.page!.goto(this.identityProbeUrl, { waitUntil: 'domcontentloaded', timeout: this.connectTimeoutMs * 3 });
    return `${this.page!.url()}\n${await this.page!.title()}`;
  }

  async gotoTab(_tab: string, url: string): Promise<string> {
    if (!this.page) throw new AttachError('TAB_CLOSED', 'agent tab not claimed');
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.connectTimeoutMs * 3 });
    return this.page.url();
  }

  async readTab(_tab: string, selector?: string, maxChars?: number): Promise<string> {
    if (!this.page) throw new AttachError('TAB_CLOSED', 'agent tab not claimed');
    const js = `(document.querySelector(${JSON.stringify(selector ?? 'body')})||document.body).innerText.slice(0, ${maxChars ?? 6000})`;
    const out = await this.page.evaluate(js);
    return typeof out === 'string' ? out : JSON.stringify(out);
  }
}

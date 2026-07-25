/**
 * @fileoverview Raw-CDP attach backend over Node's built-in WebSocket.
 *
 * Replaces the playwright `connectOverCDP` backend, which live-failed against
 * a ~29-tab daily Chrome (whole-browser attach enumerates every tab and hangs)
 * and used the `127.0.0.1` host Chrome's DNS-rebinding guard 403s. This
 * backend opens ONE ws to the browser endpoint (host `localhost`, from
 * `DevToolsActivePort`), creates ONE agent tab, attaches flattened to that
 * single target, and can close only that tab. Requires Node >= 22 (built-in
 * `WebSocket`); `daemon-main` guards this at startup.
 *
 * @module browser-automation/attach/backends/raw-cdp
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AttachBackend } from '../AttachController.js';
import { AttachError } from '../errors.js';
import { parseDevToolsActivePort } from '../devtools-port.js';

/** Options for {@link RawCdpBackend}. */
export interface RawCdpBackendOptions {
  /** Chrome profile root holding `DevToolsActivePort` (default: macOS default profile root). */
  profileRoot?: string;
  /** Identity probe: substring matched against page-target urls (default `mail.google.com`). */
  identityProbeUrl?: string;
  /** Post-navigation settle delay ms (default 1800; the daemon sets 0 and settles per op). */
  settleMs?: number;
  /** Per-CDP-command timeout ms (default 20000). */
  commandTimeoutMs?: number;
  /** ws open timeout ms (default 15000). */
  connectTimeoutMs?: number;
  /** Eval result size cap in serialized chars (default 512 * 1024). */
  evalMaxChars?: number;
}

const DEFAULT_PROFILE_ROOT = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface PendingCommand {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Raw single-target CDP backend (see fileoverview for the contract).
 *
 * Never sends `Browser.close`; `Target.closeTarget` is only ever issued for
 * the tab this instance created.
 */
export class RawCdpBackend implements AttachBackend {
  readonly kind = 'cdp' as const;
  private readonly opts: Required<RawCdpBackendOptions>;
  private ws: WebSocket | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, PendingCommand>();
  private sessionId: string | null = null;
  private createdTargetId: string | null = null;
  /** Invoked once when the transport drops unexpectedly (daemon schedules backoff reconnect). */
  onUnexpectedClose: ((err: Error) => void) | null = null;

  constructor(options: RawCdpBackendOptions = {}) {
    this.opts = {
      profileRoot: options.profileRoot ?? DEFAULT_PROFILE_ROOT,
      identityProbeUrl: options.identityProbeUrl ?? 'mail.google.com',
      settleMs: options.settleMs ?? 1800,
      commandTimeoutMs: options.commandTimeoutMs ?? 20_000,
      connectTimeoutMs: options.connectTimeoutMs ?? 15_000,
      evalMaxChars: options.evalMaxChars ?? 512 * 1024,
    };
  }

  /** Open the ws to the browser endpoint. Creates/focuses NOTHING. Idempotent while connected. */
  async connect(): Promise<void> {
    if (this.ws) return;
    let raw: string;
    try {
      raw = readFileSync(join(this.opts.profileRoot, 'DevToolsActivePort'), 'utf8');
    } catch {
      throw new AttachError(
        'CDP_UNAVAILABLE',
        'DevToolsActivePort absent — remote debugging is not enabled on the target browser',
      );
    }
    let wsUrl: string;
    try {
      wsUrl = parseDevToolsActivePort(raw).wsUrl;
    } catch (err) {
      throw new AttachError('STALE_PORT_FILE', `DevToolsActivePort unusable: ${(err as Error).message}`);
    }

    const ws = new WebSocket(wsUrl);
    ws.addEventListener('message', (ev) => this.onMessage(String(ev.data)));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* already dead */
        }
        reject(new AttachError('CDP_TIMEOUT', `ws open timed out after ${this.opts.connectTimeoutMs}ms`));
      }, this.opts.connectTimeoutMs);
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new AttachError('CDP_UNAVAILABLE', 'ws connection refused or failed'));
        },
        { once: true },
      );
    });
    // Persistent drop handlers attach only AFTER a successful open, so a refused
    // connection rejects connect() without also firing onUnexpectedClose.
    this.ws = ws;
    ws.addEventListener('close', () => this.failAllPending('transport closed'));
    ws.addEventListener('error', () => this.failAllPending('transport error'));
  }

  /** Close ONLY our created tab (if any), then the ws. Never `Browser.close`. */
  async disconnectTransport(): Promise<void> {
    if (this.ws && this.createdTargetId) {
      await this.send('Target.closeTarget', { targetId: this.createdTargetId }).catch(() => {
        /* tab may already be gone */
      });
    }
    this.createdTargetId = null;
    this.sessionId = null;
    const ws = this.ws;
    this.ws = null; // cleared FIRST so the close listener cannot report an unexpected drop
    if (ws) {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
  }

  /** Create the agent tab, attach flattened to it alone, enable Page/Runtime on that session only. */
  async claimAgentTab(): Promise<string> {
    const created = (await this.send('Target.createTarget', { url: 'about:blank' })) as { targetId: string };
    this.createdTargetId = created.targetId;
    const attached = (await this.send('Target.attachToTarget', {
      targetId: created.targetId,
      flatten: true,
    })) as { sessionId: string };
    this.sessionId = attached.sessionId;
    await this.send('Page.enable', {}, this.sessionId);
    await this.send('Runtime.enable', {}, this.sessionId);
    return created.targetId;
  }

  /** Metadata-only identity read: matching page targets' titles/urls. No attach, no navigation. */
  async probeIdentity(): Promise<string> {
    const { targetInfos } = (await this.send('Target.getTargets')) as {
      targetInfos: Array<{ type: string; url: string; title: string }>;
    };
    return targetInfos
      .filter((t) => t.type === 'page' && t.url.includes(this.opts.identityProbeUrl))
      .map((t) => `${t.title} ${t.url}`)
      .join(' | ');
  }

  /** Navigate the agent tab, settle, return the landed URL. */
  async gotoTab(tab: string, url: string): Promise<string> {
    this.requireTab(tab);
    await this.send('Page.navigate', { url }, this.sessionId!);
    if (this.opts.settleMs > 0) await sleep(this.opts.settleMs);
    return String(await this.evalInTab(tab, 'location.href'));
  }

  /** innerText read, optional selector scope, capped. */
  async readTab(tab: string, selector?: string, maxChars = 6000): Promise<string> {
    this.requireTab(tab);
    const expr = `(() => { const el = ${
      selector ? `document.querySelector(${JSON.stringify(selector)})` : 'document.body'
    }; return el ? (el.innerText || '').slice(0, ${Math.max(1, maxChars)}) : ''; })()`;
    return String((await this.evalInTab(tab, expr)) ?? '');
  }

  /** Runtime.evaluate in the agent tab (optional backend capability used by extract/evaluate). */
  async evalInTab(tab: string, expression: string, timeoutMs?: number): Promise<unknown> {
    this.requireTab(tab);
    const res = (await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      this.sessionId!,
      timeoutMs ?? 30_000,
    )) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
    if (res.exceptionDetails) {
      throw new AttachError('UNKNOWN', `page evaluation failed: ${res.exceptionDetails.text ?? 'exception'}`);
    }
    const value = res.result?.value;
    if (typeof value === 'string' && value.length > this.opts.evalMaxChars) {
      throw new AttachError('UNKNOWN', `eval result exceeds ${this.opts.evalMaxChars} chars`);
    }
    return value;
  }

  /**
   * `Page.captureScreenshot` on the agent tab → base64 PNG (optional backend
   * capability). Read-only: no navigation, no focus change, no page mutation.
   * `fullPage` uses `captureBeyondViewport` so a long results page comes back
   * whole instead of clipped to the viewport.
   */
  async screenshotTab(tab: string, fullPage?: boolean): Promise<string> {
    this.requireTab(tab);
    const res = (await this.send(
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: !!fullPage },
      this.sessionId!,
      45_000,
    )) as { data?: string };
    if (!res.data) {
      throw new AttachError('UNKNOWN', 'Page.captureScreenshot returned no data');
    }
    return res.data;
  }

  private requireTab(tab: string): void {
    if (!this.sessionId || tab !== this.createdTargetId) {
      throw new AttachError('TAB_CLOSED', 'agent tab is not claimed on this transport');
    }
  }

  private onMessage(data: string): void {
    let m: { id?: number; error?: { message: string }; result?: unknown };
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    if (!m.id || !this.pending.has(m.id)) return;
    const p = this.pending.get(m.id)!;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.reject(new AttachError('UNKNOWN', m.error.message));
    else p.resolve(m.result);
  }

  private failAllPending(reason: string): void {
    const err = new AttachError('CDP_UNAVAILABLE', reason);
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    if (this.ws) {
      this.ws = null;
      this.sessionId = null;
      this.onUnexpectedClose?.(err);
    }
  }

  private send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs?: number,
  ): Promise<unknown> {
    const ws = this.ws;
    if (!ws) return Promise.reject(new AttachError('CDP_UNAVAILABLE', 'transport is not connected'));
    const id = ++this.nextId;
    const deadline = timeoutMs ?? this.opts.commandTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new AttachError('CDP_TIMEOUT', `${method} timed out after ${deadline}ms`));
        }
      }, deadline);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }
}

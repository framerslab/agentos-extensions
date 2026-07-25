/**
 * @fileoverview AttachController — the one object allowed to touch an attached
 * (user-owned, already-running) browser.
 *
 * Non-negotiable contract, enforced here rather than by convention:
 *
 *  1. ATTACH-ONLY. The controller can never launch a browser. When the target
 *     is missing or fails identity verification it ABORTS with a structured
 *     error — it must not "helpfully" spawn Chrome (Codex spec review F9).
 *  2. NON-DESTRUCTIVE DETACH. `detach()` tears down only OUR transport
 *     connection. The backend interface deliberately has no close/quit surface,
 *     so no code path can call `Browser.close()`/`Page.close()` on the user's
 *     browser (Codex F10 — wunderland's `BrowserSession.disconnect()` calls
 *     `browser.close()` and is exactly the hazard this replaces).
 *  3. MARKER-TAB BOUND. Every operation targets the single agent tab the
 *     controller claimed; other tabs/windows are out of reach by construction.
 *  4. LEASED. All operations require the cross-process lease nonce acquired at
 *     `claim()` (F3), and run under the no-replay state machine with deadlines
 *     (F14) plus the deny-by-default URL policy (F12).
 *
 * @module browser-automation/attach/AttachController
 */
import { AttachError, toStructuredError, type StructuredAttachError } from './errors.js';
import { acquireLease, releaseLease, requireLease, type AttachLease } from './lease.js';
import { AttachStateMachine, withDeadline } from './state.js';
import { isNavigationAllowed, revalidateRedirect, type UrlPolicyOptions } from './url-policy.js';

/**
 * Transport backend contract. INTENTIONALLY has no `closeBrowser`/`closeTab`
 * surface: the strongest guarantee that a detach can never destroy user state
 * is that the API cannot express it.
 */
export interface AttachBackend {
  /** Transport id for status/reporting. */
  readonly kind: 'cdp' | 'jxa';
  /** Open the transport (e.g. CDP socket). Must NOT create or focus tabs. */
  connect(): Promise<void>;
  /** Close ONLY our transport connection. Must not touch browser state. */
  disconnectTransport(): Promise<void>;
  /** Claim (or create) the marker agent tab; returns an opaque tab handle. */
  claimAgentTab(): Promise<string>;
  /** Read a lightweight identity probe: current profile evidence (e.g. a known tab title). */
  probeIdentity(): Promise<string>;
  /** Navigate the agent tab. Returns the URL actually landed on. */
  gotoTab(tab: string, url: string): Promise<string>;
  /** Read innerText (optionally scoped by selector) from the agent tab. */
  readTab(tab: string, selector?: string, maxChars?: number): Promise<string>;
  /**
   * OPTIONAL: evaluate an expression in the agent tab (returnByValue).
   * Absent on backends without a safe eval primitive; callers surface
   * `UNSUPPORTED_OP` when missing. Never exposed on the agent tool surface.
   */
  evalInTab?(tab: string, expression: string, timeoutMs?: number): Promise<unknown>;
  /**
   * OPTIONAL: capture a PNG screenshot of the agent tab, returned as base64.
   * CDP-only (`Page.captureScreenshot`); the JXA transport has no pixel access,
   * so callers surface `UNSUPPORTED_OP` when this is absent. Read-only — capture
   * never navigates, focuses, or mutates the page.
   */
  screenshotTab?(tab: string, fullPage?: boolean): Promise<string>;
}

/**
 * What `createAttachTools` needs: satisfied in-process by {@link AttachController}
 * (jxa transport) and over IPC by the daemon proxy surface (cdp transport).
 * Deliberately NO eval and NO extract — the agent tool surface stays no-eval.
 */
export interface AttachSurface {
  status(): unknown;
  claim(): Promise<unknown>;
  goto(url: string): Promise<string>;
  read(selector?: string, maxChars?: number): Promise<string>;
  detach(): Promise<void>;
  pause(): void;
  resume(): void;
  setDryRun(on: boolean): void;
  /** OPTIONAL (CDP transport only): write a PNG of the agent tab to disk. */
  screenshot?(filePath: string, fullPage?: boolean): Promise<{ path: string; bytes: number }>;
}

/**
 * Human-in-the-loop navigation decision. Called before every `goto` (after the
 * URL clears the deny-by-default policy). Return `false`/`{ approved: false }`
 * to block the navigation with a `POLICY_BLOCKED` result. Async so a caller can
 * prompt a real operator.
 */
export type NavigationApprover = (
  url: string,
) => boolean | { approved: boolean; reason?: string } | Promise<boolean | { approved: boolean; reason?: string }>;

/** Controller configuration. */
export interface AttachControllerOptions {
  backend: AttachBackend;
  /** Lease file path (one per machine/user). */
  leaseFile: string;
  /**
   * Expected profile identity substring (e.g. the account email). Claim ABORTS
   * with PROFILE_MISMATCH when the probe does not contain it. Required: an
   * attach client must never guess which profile it is driving (F9).
   */
  expectedIdentity: string;
  /** URL policy options (host allowlist etc.). */
  urlPolicy?: UrlPolicyOptions;
  /** Per-operation deadline in ms (default 45s). */
  deadlineMs?: number;
  /**
   * Dry-run: navigation and reads are validated and reported but NOT performed
   * against the browser. Lets a mission preview its plan (or run in CI) without
   * touching the live session.
   */
  dryRun?: boolean;
  /**
   * HITL gate on navigation. Runs after the URL policy passes; a denial blocks
   * the goto. Use to require operator approval for each page an assistant opens.
   */
  onNavigate?: NavigationApprover;
}

/** Status snapshot returned by {@link AttachController.status}. */
export interface AttachStatus {
  transport: 'cdp' | 'jxa' | 'none';
  state: string;
  leaseHeld: boolean;
  agentTab?: string;
  lastError?: StructuredAttachError;
  /** Session paused — operations are refused until resume(). */
  paused: boolean;
  /** Dry-run mode — navigation/reads are simulated, not performed. */
  dryRun: boolean;
  /** Count of navigations performed this session. */
  navigations: number;
  /** Last URL the agent tab navigated to. */
  lastUrl?: string;
}

/**
 * Orchestrates one attach session end to end. One controller instance = one
 * lease = one agent tab.
 */
export class AttachController {
  private readonly backend: AttachBackend;
  private readonly opts: AttachControllerOptions;
  private readonly machine = new AttachStateMachine();
  private lease?: AttachLease;
  private tab?: string;
  private lastError?: StructuredAttachError;
  private paused = false;
  private dryRun: boolean;
  private navigations = 0;
  private lastUrl?: string;

  constructor(opts: AttachControllerOptions) {
    this.backend = opts.backend;
    this.opts = opts;
    this.dryRun = !!opts.dryRun;
  }

  private get deadline(): number {
    return this.opts.deadlineMs ?? 45_000;
  }

  /** Non-throwing status snapshot. */
  status(): AttachStatus {
    return {
      transport: this.lease ? this.backend.kind : 'none',
      state: this.machine.state,
      leaseHeld: !!this.lease,
      agentTab: this.tab,
      lastError: this.lastError,
      paused: this.paused,
      dryRun: this.dryRun,
      navigations: this.navigations,
      lastUrl: this.lastUrl,
    };
  }

  /** Pause the session — navigation/read refuse until {@link resume}. */
  pause(): void {
    this.paused = true;
  }

  /** Resume a paused session. */
  resume(): void {
    this.paused = false;
  }

  /** Toggle dry-run at runtime (simulate navigation/reads, don't perform them). */
  setDryRun(on: boolean): void {
    this.dryRun = on;
  }

  /**
   * Acquire the lease, open the transport, verify profile identity, and claim
   * the marker agent tab. Aborts (never launches) on any verification failure.
   */
  async claim(): Promise<AttachStatus> {
    this.machine.to('connecting');
    try {
      this.lease = acquireLease({ file: this.opts.leaseFile });
      await withDeadline(this.backend.connect(), this.deadline, 'connect');
      const identity = await withDeadline(this.backend.probeIdentity(), this.deadline, 'probeIdentity');
      if (!identity.includes(this.opts.expectedIdentity)) {
        throw new AttachError(
          'PROFILE_MISMATCH',
          `attached browser did not present the expected profile identity (looked for "${this.opts.expectedIdentity}")`,
        );
      }
      this.tab = await withDeadline(this.backend.claimAgentTab(), this.deadline, 'claimAgentTab');
      this.machine.to('ready');
      return this.status();
    } catch (err) {
      this.lastError = toStructuredError(err);
      this.machine.to('failed');
      await this.safeReleaseOnFailure();
      throw err;
    }
  }

  /** Navigate the agent tab (policy-checked, HITL-gated, redirect-revalidated). */
  async goto(url: string): Promise<string> {
    this.requireReady();
    const verdict = isNavigationAllowed(url, this.opts.urlPolicy);
    if (!verdict.allowed) {
      throw new AttachError('POLICY_BLOCKED', `navigation to "${url}" rejected: ${verdict.reason}`);
    }
    // HITL gate: after the policy passes, an approver may still block the page.
    if (this.opts.onNavigate) {
      const decision = await this.opts.onNavigate(url);
      const approved = typeof decision === 'boolean' ? decision : decision.approved;
      if (!approved) {
        const reason = typeof decision === 'object' && decision.reason ? decision.reason : 'operator denied';
        throw new AttachError('POLICY_BLOCKED', `navigation to "${url}" denied by approver: ${reason}`);
      }
    }
    requireLease(this.opts.leaseFile, this.lease!.nonce);
    // Dry-run: report the URL as the landed target without touching the browser.
    if (this.dryRun) {
      this.navigations += 1;
      this.lastUrl = url;
      return url;
    }
    this.machine.to('navigating');
    try {
      const landed = await withDeadline(this.backend.gotoTab(this.tab!, url), this.deadline, 'goto');
      this.navigations += 1;
      this.lastUrl = landed;
      const landedVerdict = revalidateRedirect(landed, this.opts.urlPolicy);
      if (!landedVerdict.allowed) {
        this.machine.to('ready');
        throw new AttachError('POLICY_BLOCKED', `redirect landed on a blocked target: ${landedVerdict.reason}`);
      }
      this.machine.to('ready');
      return landed;
    } catch (err) {
      if (this.machine.state === 'navigating') this.machine.to('failed');
      this.lastError = toStructuredError(err);
      throw err;
    }
  }

  /** Read text from the agent tab (size-capped by the backend). */
  async read(selector?: string, maxChars?: number): Promise<string> {
    this.requireReady();
    requireLease(this.opts.leaseFile, this.lease!.nonce);
    if (this.dryRun) return '[dry-run] read skipped';
    this.machine.to('reading');
    try {
      const text = await withDeadline(this.backend.readTab(this.tab!, selector, maxChars), this.deadline, 'read');
      this.machine.to('ready');
      return text;
    } catch (err) {
      if (this.machine.state === 'reading') this.machine.to('failed');
      this.lastError = toStructuredError(err);
      throw err;
    }
  }

  /**
   * Capture a PNG screenshot of the agent tab and write it to `filePath`.
   *
   * CDP-only: the JXA transport has no pixel access, so a jxa-backed session
   * refuses with `UNSUPPORTED_OP` rather than pretending. Read-only — capture
   * never navigates, focuses, or mutates the page.
   *
   * @returns The written path plus byte size, for evidence logging.
   */
  async screenshot(filePath: string, fullPage?: boolean): Promise<{ path: string; bytes: number }> {
    this.requireReady();
    requireLease(this.opts.leaseFile, this.lease!.nonce);
    const fn = this.backend.screenshotTab?.bind(this.backend);
    if (!fn) {
      throw new AttachError('UNSUPPORTED_OP', `${this.backend.kind} backend has no screenshot capability (CDP transport required)`);
    }
    if (this.dryRun) return { path: filePath, bytes: 0 };
    this.machine.to('reading');
    try {
      const b64 = await withDeadline(fn(this.tab!, fullPage), this.deadline, 'screenshot');
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const { dirname } = await import('node:path');
      mkdirSync(dirname(filePath), { recursive: true });
      const buf = Buffer.from(b64, 'base64');
      writeFileSync(filePath, buf);
      this.machine.to('ready');
      return { path: filePath, bytes: buf.length };
    } catch (err) {
      if (this.machine.state === 'reading') this.machine.to('failed');
      this.lastError = toStructuredError(err);
      throw err;
    }
  }

  /** Fixed, parameterized extraction expression: the selector map is data, never code. */
  private static extractExpression(fields?: Record<string, string>): string {
    const spec = JSON.stringify(fields ?? {});
    return `(() => {
      const fields = ${spec};
      const grab = (sel) => [...document.querySelectorAll(sel)].map((e) => (e.textContent || '').trim()).filter(Boolean);
      if (Object.keys(fields).length) {
        const out = {};
        for (const [name, sel] of Object.entries(fields)) out[name] = grab(sel).slice(0, 200);
        return out;
      }
      return {
        url: location.href,
        title: document.title,
        heading: (document.querySelector('h1,h2') || {}).textContent?.trim() || '',
        links: [...document.querySelectorAll('a[href]')].map((a) => ({ href: a.href, text: (a.textContent || '').trim().slice(0, 60) })).slice(0, 500),
        text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 4000),
      };
    })()`;
  }

  /** The backend's optional eval primitive, or a structured refusal. */
  private requireEval(): (tab: string, expression: string, timeoutMs?: number) => Promise<unknown> {
    const fn = this.backend.evalInTab?.bind(this.backend);
    if (!fn) {
      throw new AttachError('UNSUPPORTED_OP', `${this.backend.kind} backend has no page-evaluation capability`);
    }
    return fn;
  }

  /**
   * Structured extraction over a fixed, parameterized expression: for each
   * `name: cssSelector` pair, trimmed textContent lists; with no fields, a
   * default page summary (url/title/heading/links/text). No caller-supplied
   * code ever reaches the page — selectors are data.
   */
  async extract(fields?: Record<string, string>): Promise<unknown> {
    this.requireReady();
    const evalFn = this.requireEval();
    requireLease(this.opts.leaseFile, this.lease!.nonce);
    if (this.dryRun) return { dryRun: true };
    this.machine.to('reading');
    try {
      const out = await withDeadline(
        evalFn(this.tab!, AttachController.extractExpression(fields)),
        this.deadline,
        'extract',
      );
      this.machine.to('ready');
      return out;
    } catch (err) {
      if (this.machine.state === 'reading') this.machine.to('failed');
      this.lastError = toStructuredError(err);
      throw err;
    }
  }

  /**
   * Arbitrary page evaluation. USER LANE ONLY: reachable through the daemon
   * protocol's `eval` op and the JS client; no agent tool maps to it and the
   * tool-facing surface has no eval member.
   */
  async evaluate(expression: string, timeoutMs?: number): Promise<unknown> {
    this.requireReady();
    const evalFn = this.requireEval();
    requireLease(this.opts.leaseFile, this.lease!.nonce);
    if (this.dryRun) return '[dry-run] evaluate skipped';
    this.machine.to('reading');
    try {
      const out = await withDeadline(
        evalFn(this.tab!, expression, timeoutMs),
        Math.max(this.deadline, (timeoutMs ?? 0) + 5_000),
        'evaluate',
      );
      this.machine.to('ready');
      return out;
    } catch (err) {
      if (this.machine.state === 'reading') this.machine.to('failed');
      this.lastError = toStructuredError(err);
      throw err;
    }
  }

  /**
   * Release the session: park is the CALLER's responsibility (navigate to
   * about:blank first if desired), then this closes only our transport and
   * releases the lease. There is no code path to close browser/tabs.
   */
  async detach(): Promise<void> {
    try {
      await this.backend.disconnectTransport();
    } finally {
      if (this.lease) releaseLease(this.opts.leaseFile, this.lease.nonce);
      this.lease = undefined;
      this.tab = undefined;
      if (this.machine.state !== 'disconnected') {
        if (this.machine.state !== 'failed') this.machine.to('failed');
        this.machine.to('disconnected');
      }
    }
  }

  private requireReady(): void {
    if (this.paused) {
      throw new AttachError('UNKNOWN', 'attach session is paused — call resume() before further operations');
    }
    if (this.machine.state !== 'ready' || !this.tab || !this.lease) {
      throw new AttachError('UNKNOWN', `attach session not ready (state=${this.machine.state}) — call claim() first`);
    }
  }

  private async safeReleaseOnFailure(): Promise<void> {
    try {
      await this.backend.disconnectTransport();
    } catch {
      /* transport already dead */
    }
    if (this.lease) {
      try {
        releaseLease(this.opts.leaseFile, this.lease.nonce);
      } catch {
        /* foreign lease — leave it */
      }
      this.lease = undefined;
    }
  }
}

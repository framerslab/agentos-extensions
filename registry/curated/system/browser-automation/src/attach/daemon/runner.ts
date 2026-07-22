/**
 * @fileoverview Declarative attach runs: a parsed steps object, no control flow.
 *
 * Allowed ops: goto | read | extract | wait. NO eval — the JS lane
 * (`attach run script.mjs`) covers everything needing logic. The runner
 * claims before the first step and releases in a finally block, so a failed
 * run never strands the session until the ttl. Consumes a parsed JS object;
 * YAML parsing happens in the wunderland CLI (`yaml` is a wunderland dep).
 *
 * @module browser-automation/attach/daemon/runner
 */
import type { AttachDaemonClient } from './client.js';

/** One declarative step. */
export type AttachRunStep =
  | { op: 'goto'; url: string; settle?: number; out?: string }
  | { op: 'read'; selector?: string; maxChars?: number; out?: string }
  | { op: 'extract'; fields?: Record<string, string>; out?: string }
  | { op: 'wait'; ms: number; out?: string };

/** A parsed declarative plan. */
export interface AttachRunPlan {
  name: string;
  claim?: { ttlMs?: number };
  steps: AttachRunStep[];
}

/** Run result: per-step records plus keyed captures. */
export interface AttachRunResult {
  name: string;
  startedAt: number;
  ok: boolean;
  failedStep?: number;
  error?: { code?: string; message: string };
  steps: Array<{ op: string; ok: boolean; out?: string }>;
  results: Record<string, unknown>;
}

const ALLOWED = new Set(['goto', 'read', 'extract', 'wait']);

/**
 * Execute `plan` against a live daemon via `client`. Validates the op
 * whitelist up front (an eval step is a hard error, not a skipped step),
 * aborts on the first failing step, and always releases the claim.
 */
export async function runAttachScript(plan: AttachRunPlan, client: AttachDaemonClient): Promise<AttachRunResult> {
  if (!plan || !Array.isArray(plan.steps)) throw new Error('attach run plan needs a steps array');
  for (const [i, s] of plan.steps.entries()) {
    const opName = (s as { op?: string }).op ?? '(missing)';
    if (!ALLOWED.has(opName)) {
      throw new Error(`step ${i}: ${opName} is not a declarative op (eval is not a declarative op; use the JS lane)`);
    }
  }
  const result: AttachRunResult = {
    name: plan.name ?? 'attach-run',
    startedAt: Date.now(),
    ok: true,
    steps: [],
    results: {},
  };
  await client.claim(plan.claim?.ttlMs);
  try {
    for (const [i, step] of plan.steps.entries()) {
      try {
        let data: unknown;
        if (step.op === 'goto') data = await client.goto(step.url, { settle: step.settle });
        else if (step.op === 'read') data = await client.read({ selector: step.selector, maxChars: step.maxChars });
        else if (step.op === 'extract') data = await client.extract(step.fields);
        else await new Promise((r) => setTimeout(r, step.ms));
        result.steps.push({ op: step.op, ok: true, out: step.out });
        if (step.out !== undefined) result.results[step.out] = data;
      } catch (err) {
        const e = err as { code?: string; message?: string };
        result.ok = false;
        result.failedStep = i;
        result.error = { code: e.code, message: e.message ?? String(err) };
        result.steps.push({ op: step.op, ok: false, out: step.out });
        break;
      }
    }
    return result;
  } finally {
    await client.release().catch(() => {
      /* claim may have expired or the run never claimed successfully */
    });
  }
}

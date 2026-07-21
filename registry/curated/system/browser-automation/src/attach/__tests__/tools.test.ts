import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttachController, type AttachBackend } from '../AttachController.js';
import {
  ATTACH_TOOL_IDS,
  AttachClaimTool,
  AttachControlTool,
  AttachGotoTool,
  AttachReadTool,
  AttachReleaseTool,
  AttachStatusTool,
  createAttachTools,
} from '../tools.js';

function backend(): AttachBackend {
  return {
    kind: 'jxa',
    async connect() {},
    async disconnectTransport() {},
    async claimAgentTab() {
      return 'w1 t1';
    },
    async probeIdentity() {
      return 'Inbox - johnny@example.com - Gmail';
    },
    async gotoTab(_t, url) {
      return url;
    },
    async readTab() {
      return 'PAGE BODY TEXT';
    },
  };
}

let controller: AttachController;
beforeEach(() => {
  const leaseFile = join(mkdtempSync(join(tmpdir(), 'attach-tools-')), 'attach.lease');
  controller = new AttachController({ backend: backend(), leaseFile, expectedIdentity: 'johnny@example.com' });
});

describe('attach tools', () => {
  it('exposes exactly the six ids and no eval/js tool', () => {
    expect(ATTACH_TOOL_IDS).toEqual([
      'browser_attach_status',
      'browser_attach_claim',
      'browser_attach_goto',
      'browser_attach_read',
      'browser_attach_release',
      'browser_attach_control',
    ]);
    expect(ATTACH_TOOL_IDS).not.toContain('browser_attach_eval');
    expect(createAttachTools(controller)).toHaveLength(6);
  });

  it('control tool pauses, resumes, and toggles dry-run at runtime', async () => {
    const ctl = new AttachControlTool(controller);
    await new AttachClaimTool(controller).execute();
    expect((await ctl.execute({ action: 'pause' })).data.paused).toBe(true);
    expect((await ctl.execute({ action: 'resume' })).data.paused).toBe(false);
    expect((await ctl.execute({ action: 'dry_run_on' })).data.dryRun).toBe(true);
    expect((await ctl.execute({ action: 'dry_run_off' })).data.dryRun).toBe(false);
    expect((await ctl.execute({ action: 'status' })).data.leaseHeld).toBe(true);
  });

  it('status and read are non-side-effecting; claim/goto/release are side-effecting', () => {
    expect(new AttachStatusTool(controller).hasSideEffects).toBe(false);
    expect(new AttachReadTool(controller).hasSideEffects).toBe(false);
    expect(new AttachClaimTool(controller).hasSideEffects).toBe(true);
    expect(new AttachGotoTool(controller).hasSideEffects).toBe(true);
    expect(new AttachReleaseTool(controller).hasSideEffects).toBe(true);
  });

  it('runs the full claim → goto → read → release envelope', async () => {
    expect((await new AttachClaimTool(controller).execute()).success).toBe(true);
    const goto = await new AttachGotoTool(controller).execute({ url: 'https://founderscard.com/home' });
    expect(goto).toMatchObject({ success: true, data: { url: 'https://founderscard.com/home' } });
    const read = await new AttachReadTool(controller).execute({});
    expect(read.data).toMatchObject({ untrusted: true, text: 'PAGE BODY TEXT' });
    const rel = await new AttachReleaseTool(controller).execute();
    expect(rel).toMatchObject({ success: true, data: { released: true } });
  });

  it('goto returns a structured error envelope (not a throw) on a blocked URL', async () => {
    await new AttachClaimTool(controller).execute();
    const res = await new AttachGotoTool(controller).execute({ url: 'file:///etc/passwd' });
    expect(res.success).toBe(false);
    expect(res.code).toBe('POLICY_BLOCKED');
  });

  it('status never throws even before a claim', async () => {
    const res = await new AttachStatusTool(controller).execute();
    expect(res.success).toBe(true);
    expect(res.data.leaseHeld).toBe(false);
  });
});

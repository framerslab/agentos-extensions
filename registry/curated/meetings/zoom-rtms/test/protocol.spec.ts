import { describe, it, expect } from 'vitest';
import { ZoomCommand, ZoomReportPost, ZoomRunStatus, ZoomStartRun, zoomReportEventId, zoomWebhookEventId } from '../src/protocol.js';

const start = {
  runId: 'r1',
  connectionGeneration: 'connection-1', connectionCreatedAt: 0, runGeneration: 'run-generation-1', requestedAt: 0,
  meetingNumber: '81234567890',
  zoomUserId: 'u-1',
  livekit: { url: 'wss://lk.example.test', token: 'jwt', identity: 'bot' },
  workerToken: 'tok-tok-tok-tok-tok',
  reportUrl: 'https://product.example.test/events/zoom-rtms/r1',
  totalMs: 14_400_000,
};

describe('the media worker protocol', () => {
  it('takes a start, and refuses one whose meeting number or report address is not one', () => {
    expect(ZoomStartRun.parse(start)).toEqual(start);
    expect(ZoomStartRun.safeParse({ ...start, meetingNumber: '8123' }).success).toBe(false);
    expect(ZoomStartRun.safeParse({ ...start, reportUrl: 'product' }).success).toBe(false);
    expect(ZoomStartRun.safeParse({ ...start, workerToken: 'short' }).success).toBe(false);
  });
  it('takes lifecycle commands and the authenticated closure acknowledgement, and no chat', () => {
    for (const name of ['startCapture', 'suspendCapture', 'leave', 'kill', 'confirmClosed']) expect(ZoomCommand.safeParse({ name }).success, name).toBe(true);
    expect(ZoomCommand.safeParse({ name: 'postChat', text: 'x' }).success).toBe(false);
  });
  it('takes a report and refuses an event the worker never sends', () => {
    const report = { type: 'report', runId: 'r1', workerId: 'w1', seq: 3, event: 'usage', at: 5, data: { seconds: 60 } };
    expect(ZoomReportPost.parse(report)).toEqual(report);
    expect(ZoomReportPost.safeParse({ ...report, event: 'chat_message' }).success).toBe(false);
    expect(ZoomReportPost.safeParse({ ...report, event: 'participant_joined' }).success).toBe(false);
  });
  it('names a run\'s states', () => {
    expect(ZoomRunStatus.parse({ runId: 'r1', state: 'waiting', startedAt: 1, seconds: 0 })).toMatchObject({ state: 'waiting' });
    expect(ZoomRunStatus.safeParse({ runId: 'r1', state: 'running', startedAt: 1, seconds: 0 }).success).toBe(false);
  });
  it('derives stable event ids', () => {
    expect(zoomReportEventId('r1', 3, 'usage')).toBe('zoom-rtms:r1:3:usage');
    expect(zoomWebhookEventId('r1', 's-1', 'stopped', 1739923528000)).toBe('zoom-rtms:r1:s-1:stopped:1739923528000');
  });
});

// @ts-nocheck
/**
 * @fileoverview Notifications Extension for AgentOS.
 *
 * Provides a unified multi-channel notification router with 3 tools:
 * send, broadcast, and schedule.
 *
 * @module @framers/agentos-ext-notifications
 */

import { NotificationService } from './NotificationService.js';
import { NotifySendTool } from './tools/send.js';
import { NotifyBroadcastTool } from './tools/broadcast.js';
import { NotifyScheduleTool } from './tools/schedule.js';
import { PACKAGE_VERSION } from './packageVersion.js';

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
  descriptors: Array<{ id: string; kind: string; priority?: number; payload: unknown }>;
  onActivate?: () => Promise<void>;
  onDeactivate?: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createExtensionPack(context: ExtensionContext): ExtensionPack {
  const service = new NotificationService();

  const sendTool = new NotifySendTool(service);
  const broadcastTool = new NotifyBroadcastTool(service);
  const scheduleTool = new NotifyScheduleTool(service);

  return {
    name: '@framers/agentos-ext-notifications',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'notifySend', kind: 'tool', priority: 50, payload: sendTool },
      { id: 'notifyBroadcast', kind: 'tool', priority: 50, payload: broadcastTool },
      { id: 'notifySchedule', kind: 'tool', priority: 50, payload: scheduleTool },
    ],
    onActivate: async () => {
      await service.initialize();
    },
    onDeactivate: async () => {
      await service.shutdown();
    },
  };
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

export { NotificationService } from './NotificationService.js';
export type {
  NotificationChannel,
  SendOptions,
  BroadcastOptions,
  ScheduleOptions,
  ScheduledNotification,
  SendResult,
} from './NotificationService.js';
export { NotifySendTool } from './tools/send.js';
export { NotifyBroadcastTool } from './tools/broadcast.js';
export { NotifyScheduleTool } from './tools/schedule.js';

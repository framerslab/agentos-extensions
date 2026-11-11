// @ts-nocheck
/**
 * Agent Delegation Extension Pack — inter-agent communication tools.
 *
 * Tools:
 *   - agent_ping      — Check if a remote agent is reachable + get metadata.
 *   - agent_delegate   — Send a task to a single remote agent.
 *   - agent_broadcast  — Fan out a task to multiple agents in parallel.
 */

import { AgentPingTool } from './AgentPingTool.js';
import { AgentDelegateTool } from './AgentDelegateTool.js';
import { AgentBroadcastTool } from './AgentBroadcastTool.js';
import { PACKAGE_VERSION } from './packageVersion.js';

// ---------------------------------------------------------------------------
// Extension pack types (lightweight — avoids hard dep on @framers/agentos)
// ---------------------------------------------------------------------------

export interface ExtensionContext {
  options?: Record<string, unknown>;
  secrets?: Record<string, string>;
  getSecret?: (key: string) => string | undefined;
  logger?: { info: (msg: string) => void };
}

export interface ExtensionPack {
  name: string;
  version: string;
  descriptors: Array<{
    id: string;
    kind: string;
    priority?: number;
    payload: unknown;
  }>;
  onActivate?: () => Promise<void>;
  onDeactivate?: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createExtensionPack(context: ExtensionContext): ExtensionPack {
  const ping = new AgentPingTool();
  const delegate = new AgentDelegateTool();
  const broadcast = new AgentBroadcastTool();

  return {
    name: '@framers/agentos-ext-agent-delegation',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: ping.name, kind: 'tool', priority: 50, payload: ping },
      { id: delegate.name, kind: 'tool', priority: 50, payload: delegate },
      { id: broadcast.name, kind: 'tool', priority: 50, payload: broadcast },
    ],
    onActivate: async () => context.logger?.info('Agent Delegation Extension activated'),
    onDeactivate: async () => context.logger?.info('Agent Delegation Extension deactivated'),
  };
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { AgentPingTool } from './AgentPingTool.js';
export type { AgentPingInput, AgentPingOutput } from './AgentPingTool.js';

export { AgentDelegateTool } from './AgentDelegateTool.js';
export type { AgentDelegateInput, AgentDelegateOutput } from './AgentDelegateTool.js';

export { AgentBroadcastTool } from './AgentBroadcastTool.js';
export type {
  AgentBroadcastInput,
  AgentBroadcastOutput,
  AgentReplyEntry,
  AgentTarget,
} from './AgentBroadcastTool.js';

export default createExtensionPack;

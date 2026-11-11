// @ts-nocheck
/**
 * @fileoverview Extension pack factory for the send-file-to-channel tool.
 * @module agentos-ext-send-file-to-channel
 */

import { SendFileToChannelTool } from './SendFileToChannelTool.js';
import { PACKAGE_VERSION } from './packageVersion.js';

export { SendFileToChannelTool } from './SendFileToChannelTool.js';
export type { ChannelContext, SendFileInput, SendFileOutput } from './types.js';

/** Create the send-file-to-channel extension pack. */
export function createExtensionPack() {
  const tool = new SendFileToChannelTool();
  return {
    name: '@framers/agentos-ext-send-file-to-channel',
    version: PACKAGE_VERSION,
    descriptors: [{ id: 'send_file_to_channel', kind: 'tool' as const, priority: 50, payload: tool }],
  };
}

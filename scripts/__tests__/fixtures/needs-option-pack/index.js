/** Requires an input its manifest does not declare, like voice-plivo's `fromNumber`. */
export function createExtensionPack(context) {
  if (!context.options?.secrets?.['voice.authId']) throw new Error('voice.authId not found');
  if (!context.options?.fromNumber) throw new Error('fromNumber not found');
  return { name: 'needs-option-pack', version: '1.0.0', descriptors: [{ id: 'call', kind: 'tool', payload: {} }] };
}

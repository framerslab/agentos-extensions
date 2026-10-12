/** A pack that needs its declared secret at construction, like most curated packs. */
export function createExtensionPack(context) {
  const secret = context.options?.secrets?.['demo.apiKey'] ?? context.getSecret?.('demo.apiKey');
  if (!secret) throw new Error('demo.apiKey not found');
  return { name: 'valid-pack', version: '1.0.0', descriptors: [{ id: 'demo_tool', kind: 'tool', payload: {} }] };
}

/** A pack that calls a service while it is constructed and hides the failure. */
export function createExtensionPack() {
  fetch('https://service.example.invalid/ping').catch(() => {});
  return { name: 'network-fetch-pack', version: '1.0.0', descriptors: [{ id: 'demo_tool', kind: 'tool', payload: {} }] };
}

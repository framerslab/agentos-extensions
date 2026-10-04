import https from 'node:https';

/** A pack that opens an https request while it is constructed and hides the failure. */
export function createExtensionPack() {
  try {
    https.get('https://service.example.invalid/ping').on('error', () => {});
  } catch {
    // swallowed, as a pack that "handles" its own network errors would
  }
  return { name: 'network-socket-pack', version: '1.0.0', descriptors: [{ id: 'demo_tool', kind: 'tool', payload: {} }] };
}

import { describe, it, expect } from 'vitest';
import { createExtensionPack } from '../../index.js';

describe('browser-automation attach registration', () => {
  it('does NOT register attach tools by default', () => {
    const pack = createExtensionPack({ options: {} });
    const ids = pack.descriptors.map((d) => d.id);
    expect(ids).not.toContain('browser_attach_claim');
    expect(ids).not.toContain('browser_attach_goto');
  });

  it('registers the attach tools (default-off descriptors) when opted in', () => {
    const pack = createExtensionPack({ options: { attach: { expectedIdentity: 'johnny@example.com' } } });
    const attach = pack.descriptors.filter((d) => d.id.startsWith('browser_attach_'));
    expect(attach.map((d) => d.id).sort()).toEqual([
      'browser_attach_claim',
      'browser_attach_control',
      'browser_attach_goto',
      'browser_attach_read',
      'browser_attach_release',
      'browser_attach_screenshot',
      'browser_attach_status',
    ]);
    for (const d of attach) expect(d.enableByDefault).toBe(false);
  });

  it('leaves the launch-mode tools intact in both modes', () => {
    for (const options of [{}, { attach: { expectedIdentity: 'x@y.com' } }]) {
      const ids = createExtensionPack({ options }).descriptors.map((d) => d.id);
      expect(ids).toContain('browserNavigate');
      expect(ids).toContain('browserSession');
    }
  });
});

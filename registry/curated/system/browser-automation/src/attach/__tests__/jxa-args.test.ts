import { describe, it, expect } from 'vitest';
import { buildJxaArgs, JXA_DRIVER_SOURCE } from '../backends/jxa.js';

describe('buildJxaArgs', () => {
  it('builds exact argv with profileRoot first, then cmd and args (no shell interpolation)', () => {
    expect(buildJxaArgs('/tmp/driver.js', '/Users/x/Chrome', 'goto', ['1', '2', 'https://a.com/?q=1&r=2'])).toEqual([
      '-l',
      'JavaScript',
      '/tmp/driver.js',
      '/Users/x/Chrome',
      'goto',
      '1',
      '2',
      'https://a.com/?q=1&r=2',
    ]);
  });
});

describe('JXA driver source', () => {
  it('addresses Chrome by PID from SingletonLock, never by bundle name', () => {
    expect(JXA_DRIVER_SOURCE).toContain('SingletonLock');
    expect(JXA_DRIVER_SOURCE).toContain('Application(chromePid(root))');
    expect(JXA_DRIVER_SOURCE).not.toMatch(/Application\((['"])Google Chrome\1\)/);
  });
  it('marker-binds the claimed tab and exposes no close/quit commands', () => {
    expect(JXA_DRIVER_SOURCE).toContain('__agentos_attach_tab_v1__');
    expect(JXA_DRIVER_SOURCE).not.toMatch(/\.close\(\)|\bquit\b/);
  });
  it('supports only claim/goto/url/read (no arbitrary JS command)', () => {
    for (const cmd of ['claim', 'goto', 'url', 'read']) {
      expect(JXA_DRIVER_SOURCE).toContain(`'${cmd}'`);
    }
    expect(JXA_DRIVER_SOURCE).not.toContain("'eval'");
    expect(JXA_DRIVER_SOURCE).not.toContain("'js'");
  });
});

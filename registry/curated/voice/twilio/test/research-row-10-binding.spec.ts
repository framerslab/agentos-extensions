import { afterEach, expect, it, vi } from 'vitest';
import { CallManager, type ExtensionContext, type CallRecord } from '@framers/agentos';
import { ExtensionManager } from '@framers/agentos/extensions/ExtensionManager';
import { createExtensionPack, TwilioVoiceService } from '../src/index';
afterEach(() => vi.restoreAllMocks());
it('binds registry and call tool to the host manager, including rebinding', async () => {
  vi.spyOn(TwilioVoiceService.prototype, 'initialize').mockResolvedValue();
  const manager = new CallManager({ provider: { provider: 'twilio', config: { accountSid: 'fixture', authToken: 'fixture', fromNumber: '+15555550100' } } });
  const next = new CallManager({ provider: { provider: 'twilio', config: { accountSid: 'fixture', authToken: 'fixture', fromNumber: '+15555550100' } } });
  const oldCall = vi.spyOn(manager, 'initiateCall').mockResolvedValue({ callId: 'old', state: 'initiated' } as CallRecord);
  const newCall = vi.spyOn(next, 'initiateCall').mockResolvedValue({ callId: 'new', state: 'initiated' } as CallRecord);
  const oldDispose = vi.spyOn(manager, 'dispose'), newDispose = vi.spyOn(next, 'dispose');
  const pack = createExtensionPack({ options: { accountSid: 'fixture', authToken: 'fixture', fromNumber: '+15555550100', callManager: manager } } as ExtensionContext);
  const extensions = new ExtensionManager();
  try {
    await extensions.loadPackFromFactory(pack);
    const provider = extensions.getRegistry<{ binding: typeof pack.binding; name: string }>('voice-provider').listActive()[0]!.payload;
    expect(provider.name).toBe('twilio'); expect(provider.binding).toBe(pack.binding); expect(pack.binding.manager).toBe(manager);
    expect(manager.getProvider('twilio')).toBe(provider);
    const tool = pack.descriptors.find((d) => d.kind === 'tool')!.payload as { execute(args: unknown, context: unknown): Promise<{ success: boolean }> };
    expect((await tool.execute({ action: 'initiate_call', toNumber: '+15555550101' }, {})).success).toBe(true);
    expect(oldCall).toHaveBeenCalledWith(expect.objectContaining({ providerName: 'twilio', toNumber: '+15555550101' }));
    pack.binding.setManager(next); expect(pack.binding.manager).toBe(next); expect(next.getProvider('twilio')).toBe(provider);
    expect((await tool.execute({ action: 'initiate_call', toNumber: '+15555550102' }, {})).success).toBe(true);
    expect(oldCall).toHaveBeenCalledOnce(); expect(newCall).toHaveBeenCalledOnce();
    await extensions.shutdown(); expect(oldDispose).not.toHaveBeenCalled(); expect(newDispose).not.toHaveBeenCalled();
  } finally { await extensions.shutdown(); manager.dispose(); next.dispose(); }
});
it('exposes and disposes only its own default manager', async () => {
  const pack = createExtensionPack({ options: { accountSid: 'fixture', authToken: 'fixture', fromNumber: '+15555550100' } } as ExtensionContext);
  expect(pack.binding.manager.getProvider('twilio')).toBe(pack.binding.provider);
  const dispose = vi.spyOn(pack.binding.manager, 'dispose'); await pack.onDeactivate!({} as never); expect(dispose).toHaveBeenCalledOnce();
});

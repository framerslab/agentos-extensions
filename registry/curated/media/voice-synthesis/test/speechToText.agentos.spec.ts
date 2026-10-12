// @ts-nocheck
/**
 * @fileoverview speech_to_text's audioUrl with the published AgentOS, not a
 * mock: the URL is read through its guardedFetch, which checks every address
 * the host name resolves to before it connects.
 *
 * `ip6-localhost` is a name Ubuntu's /etc/hosts maps to ::1, a name that
 * looks like any other and reaches this machine. In CI the name must
 * resolve, or that case would test nothing; elsewhere it is left out. The
 * URLs use port 80, which the guard reads, so a refusal is the address
 * check and not the port rule.
 */

import { lookup } from 'node:dns/promises';
import { Socket } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SpeechToTextTool } from '../src/tools/speechToText.js';

const loopbackName = await lookup('ip6-localhost').then(
  (entry) => entry.address === '::1',
  () => false,
);
if (process.env.CI && !loopbackName) {
  throw new Error('ip6-localhost must resolve to ::1 in CI (Ubuntu /etc/hosts); without it the name case would test nothing.');
}

describe('speech_to_text with the published AgentOS', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ...(loopbackName ? ['http://ip6-localhost/audio.wav'] : []),
    'http://169.254.169.254/latest/meta-data/',
    'http://[::ffff:127.0.0.1]/audio.wav',
  ])('refuses %s with no connection and no transcription', async (audioUrl) => {
    const connect = vi.spyOn(Socket.prototype, 'connect').mockImplementation(() => {
      throw new Error('unexpected connection');
    });
    const transcription = vi.spyOn(globalThis, 'fetch');

    const result = await new SpeechToTextTool({ openaiApiKey: 'sk-placeholder' }).execute({ audioUrl }, {});

    expect(result).toEqual({ success: false, error: 'audioUrl could not be read from a public network address.' });
    expect(connect).not.toHaveBeenCalled();
    expect(transcription).not.toHaveBeenCalled();
  });
});

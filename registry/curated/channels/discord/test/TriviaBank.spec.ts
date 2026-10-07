/**
 * The trivia bank fills its question buffer from Open Trivia DB on first use.
 * Loading the module sends no request: the pack guard imports every pack with
 * network access refused, and a host that never runs trivia makes no call.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('TriviaBank', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('sends no request when the module loads', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await import('../src/TriviaBank');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('starts filling the buffer on the first question and answers from the local bank meanwhile', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response_code: 0, results: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { getQuestion } = await import('../src/TriviaBank');

    const question = await getQuestion();

    expect(question.source).toBe('local');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/^https:\/\/opentdb\.com\/api\.php\?/);
  });
});

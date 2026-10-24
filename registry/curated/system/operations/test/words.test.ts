import { describe, expect, it } from 'vitest';
import { englishWords } from '../src/words.js';

/** The system messages the package writes into a thread (the design's "System messages", D9, D11, D17). */
const PACKAGE_KEYS = ['opened_by_staff', 'resolved_by_person', 'resolved_by_staff', 'resolved_by_silence', 'closed', 'reopened', 'identity_opened'];

describe('the English words', () => {
  it("renders every system message key the package writes, the silence's days among them, and a product's own key as itself", () => {
    for (const key of PACKAGE_KEYS) {
      const sentence = englishWords.systemMessage(key, { days: 7 });
      expect({ key, rendered: sentence !== key && sentence.length > 0 }).toEqual({ key, rendered: true });
    }
    expect(englishWords.systemMessage('resolved_by_silence', { days: 7 })).toContain('7');
    // A product records its own events with keys of its own (D17), which its words render.
    expect(englishWords.systemMessage('plan_changed', { plan: 'plus' })).toBe('plan_changed');
  });
});

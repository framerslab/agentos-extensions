import { describe, expect, it } from 'vitest';
import { isStopPhrase } from '../stop-phrase.js';

/** A stop phrase in mixed case, as a product names it after itself. */
const STOP_PHRASE = 'Notetaker stop';

/** Another person's bot's notice and its short form to a late arrival, as a product writes them: both name the phrase. */
const OTHER_NOTICE = `Sam is using Notetaker to take notes in this call. The bot records nothing: the sound is turned into text and dropped at once. Type ${STOP_PHRASE} and I'll leave and delete everything I took. Open https://notes.example/n/sam to stop it.`;
const OTHER_LATE_NOTICE = `Sam's Notetaker is taking notes in this call; type ${STOP_PHRASE} or open https://notes.example/n/sam to make it leave and delete everything it took.`;

describe('the stop phrase in the chat', () => {
  it('is a message that is the phrase, whatever its case, the whitespace around and inside it, and its closing punctuation', () => {
    for (const text of ['Notetaker stop', '  notetaker STOP!', 'Notetaker stop.', 'NOTETAKER  stop?!', '\tNotetaker stop \n']) {
      expect({ text, stop: isStopPhrase(text, STOP_PHRASE) }).toEqual({ text, stop: true });
    }
  });

  it("is not another bot's notice, nor its short notice to a late arrival, though both name the phrase", () => {
    expect(isStopPhrase(OTHER_NOTICE, STOP_PHRASE)).toBe(false);
    expect(isStopPhrase(OTHER_LATE_NOTICE, STOP_PHRASE)).toBe(false);
  });

  it('is not a message that holds the phrase among other words', () => {
    for (const text of ['Notetaker stop please', 'ok, Notetaker stop', 'Notetaker stopped taking notes?']) {
      expect({ text, stop: isStopPhrase(text, STOP_PHRASE) }).toEqual({ text, stop: false });
    }
  });

  it('matches no message for a phrase that folds to nothing', () => {
    expect(isStopPhrase('anything at all', '')).toBe(false);
    expect(isStopPhrase(' ', '   ')).toBe(false);
  });
});

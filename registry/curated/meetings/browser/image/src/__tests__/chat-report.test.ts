import { describe, expect, it } from 'vitest';
import { chatReport, MAX_SENDER, MAX_TEXT } from '../chat-report.js';
import { isStopPhrase } from '../stop-phrase.js';

const STOP_PHRASE = 'stop taking notes';

describe("the bot's report of a chat message", () => {
  it("cuts the text and the sender's name to the protocol's ceilings", () => {
    const report = chatReport({ sender: 'S'.repeat(MAX_SENDER + 50), text: 'x'.repeat(MAX_TEXT + 500) }, STOP_PHRASE);
    expect([report.sender.length, report.text.length, report.stop]).toEqual([MAX_SENDER, MAX_TEXT, false]);
  });

  it('decides the stop on the text it reports, which is the text the meeting manager reads', () => {
    // the phrase, whitespace past the ceiling and then other words: the report holds the phrase and the whitespace alone
    const report = chatReport({ sender: 'Sam', text: `Stop taking notes!${' '.repeat(MAX_TEXT)}only joking` }, STOP_PHRASE);
    expect(report.text).toHaveLength(MAX_TEXT);
    expect({ stop: report.stop, theReportedTextIsAStop: isStopPhrase(report.text, STOP_PHRASE) }).toEqual({ stop: true, theReportedTextIsAStop: true });
  });

  it('is a stop on the phrase alone, and no stop on the phrase among other words', () => {
    expect(chatReport({ sender: 'Sam', text: 'Stop taking notes.' }, STOP_PHRASE).stop).toBe(true);
    expect(chatReport({ sender: 'Sam', text: 'please stop taking notes' }, STOP_PHRASE).stop).toBe(false);
  });
});

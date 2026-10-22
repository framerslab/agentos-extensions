import { describe, expect, it } from 'vitest';
import { chatReport, MAX_SENDER, MAX_TEXT } from '../chat-report.js';
import { isStopPhrase } from '../stop-phrase.js';

const STOP_PHRASE = 'stop taking notes';

/** Another bot's notice: one line that holds the stop phrase among other words. */
const OTHER_NOTICE = 'Sam is using a notetaker in this call. Type stop taking notes in the chat and it leaves and deletes everything it took.';

describe("the bot's report of a chat message", () => {
  it("cuts the text and the sender's name to the protocol's ceilings", () => {
    const report = chatReport({ sender: 'S'.repeat(MAX_SENDER + 50), text: 'x'.repeat(MAX_TEXT + 500), bodyRead: true }, STOP_PHRASE);
    expect([report.sender.length, report.text.length, report.stop]).toEqual([MAX_SENDER, MAX_TEXT, false]);
  });

  it('decides the stop on the text it reports, which is the text the meeting manager reads', () => {
    // the phrase, whitespace past the ceiling and then other words: the report holds the phrase and the whitespace alone
    const report = chatReport({ sender: 'Sam', text: `Stop taking notes!${' '.repeat(MAX_TEXT)}only joking`, bodyRead: true }, STOP_PHRASE);
    expect(report.text).toHaveLength(MAX_TEXT);
    expect({ stop: report.stop, theReportedTextIsAStop: isStopPhrase(report.text, STOP_PHRASE) }).toEqual({ stop: true, theReportedTextIsAStop: true });
  });

  it('is a stop on the phrase alone, and no stop on the phrase among other words', () => {
    expect(chatReport({ sender: 'Sam', text: 'Stop taking notes.', bodyRead: true }, STOP_PHRASE).stop).toBe(true);
    expect(chatReport({ sender: 'Sam', text: 'please stop taking notes', bodyRead: true }, STOP_PHRASE).stop).toBe(false);
  });

  it('is a stop on a message read from its whole element when a line of it is the phrase, after the lines of the sender and the time', () => {
    expect(chatReport({ sender: 'Sam', text: 'Sam\n10:32\nStop taking notes!', bodyRead: false }, STOP_PHRASE).stop).toBe(true);
    expect(chatReport({ sender: 'Sam', text: 'Sam 10:32 AM\n  stop taking notes  ', bodyRead: false }, STOP_PHRASE).stop).toBe(true);
  });

  it("is no stop on another bot's notice read from its whole element, whose one line holds the phrase among other words", () => {
    expect(chatReport({ sender: "Sam's notetaker", text: `Sam's notetaker\n10:32\n${OTHER_NOTICE}`, bodyRead: false }, STOP_PHRASE).stop).toBe(false);
  });

  it("leaves out the line of the sender's name: a sender named like the phrase who sends other words is no stop, wherever the name sits", () => {
    expect(chatReport({ sender: 'Stop taking notes', text: 'Stop taking notes\n10:32\nhello everyone', bodyRead: false }, STOP_PHRASE).stop).toBe(false);
    expect(chatReport({ sender: 'Stop taking notes', text: '10:32\nStop taking notes\nhello everyone', bodyRead: false }, STOP_PHRASE).stop).toBe(false);
  });

  it('is a stop when that sender sends the phrase itself', () => {
    expect(chatReport({ sender: 'Stop taking notes', text: 'Stop taking notes\n10:32\nStop taking notes!', bodyRead: false }, STOP_PHRASE).stop).toBe(true);
  });

  it('reads a message from its body element as a whole: a line of it that is the phrase, among other lines, is no stop', () => {
    expect(chatReport({ sender: 'Sam', text: 'one more thing\nStop taking notes!', bodyRead: true }, STOP_PHRASE).stop).toBe(false);
  });
});

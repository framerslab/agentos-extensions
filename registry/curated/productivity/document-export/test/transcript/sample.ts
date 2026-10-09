import type { TranscriptExport } from '../../src/transcript/types.js';

export const SAMPLE: TranscriptExport = {
  title: 'Budget review',
  startedAt: '2026-10-08T14:05:00.000Z',
  durationSeconds: 754,
  tags: ['q3'],
  folder: 'Finance',
  notes: 'Ask about hiring.',
  pack: {
    summary: 'The team agreed the budget.',
    decisions: [{ text: 'Budget grows ten percent.', owner: null, quotes: [{ seq: 2, text: 'we grow the budget by ten percent' }] }],
    actionItems: [{ text: 'Send the slides.', owner: 'Ann', quotes: [{ seq: 3, text: "I'll send the slides" }] }],
    openQuestions: [],
  },
  checks: [{ seq: 2, label: 'Matches your notes', source: 'Note: Budget', sentence: 'Budget up ten percent.' }],
  turns: [
    { seq: 1, startMs: 0, endMs: 2_000, text: 'Shall we start?', speaker: 'You' },
    { seq: 2, startMs: 65_000, endMs: 69_500, text: 'Yes, we grow the budget by ten percent.', speaker: 'Other' },
    { seq: 3, startMs: 70_000, endMs: null, text: "I'll send the slides.", speaker: null },
  ],
};

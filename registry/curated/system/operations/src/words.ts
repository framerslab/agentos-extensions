/**
 * @fileoverview The English defaults of `OpsWords`: the test host's words, and a base a product
 * may start from. A product gives its own through `tickets.words` (D6).
 */
import type { OpsExportLabel, OpsSystemMessageKey, OpsWords } from './contract.js';

const SYSTEM: Readonly<Record<OpsSystemMessageKey, (params: Readonly<Record<string, string | number>>) => string>> = {
  opened_by_staff: () => 'The team opened this thread, so they know who it is with.',
  resolved_by_person: () => 'You marked this request resolved.',
  resolved_by_staff: () => 'The team marked this request resolved.',
  resolved_by_silence: (params) => `Marked resolved after ${params.days ?? 7} days without a reply.`,
  closed: () => 'This request was closed.',
  reopened: () => 'Reopened by a new message.',
  identity_opened: () => 'A team member opened your account details for this request.',
};

const EXPORT_LABELS: Readonly<Record<OpsExportLabel, string>> = {
  requests: 'requests',
  request: 'request',
  messages: 'messages',
  pictures: 'pictures',
  team: 'The team',
  you: 'You',
  system: 'System',
};

/** A field's value as an alert line writes it: words and integers only. */
const describe = (fields: Readonly<Record<string, string | number>>): string =>
  Object.entries(fields)
    .map(([key, value]) => `${key} ${value}`)
    .join(', ');

/**
 * The English words: system messages, team alerts and export labels, for the test host and as a
 * base a product may start from (D6).
 */
export const englishWords: OpsWords = {
  systemMessage(key, params) {
    // A product's own key, which these words do not hold, reads as itself.
    return Object.hasOwn(SYSTEM, key) ? SYSTEM[key as OpsSystemMessageKey](params) : key;
  },
  teamAlert(key, gathered) {
    const count = gathered.length;
    return {
      subject: count > 1 ? `${key}: ${count} since the last mail` : key,
      lines: gathered.map(describe),
    };
  },
  exportLabel(name) {
    return EXPORT_LABELS[name] ?? name;
  },
};

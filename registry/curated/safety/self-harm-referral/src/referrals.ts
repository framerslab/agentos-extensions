/**
 * @fileoverview The crisis lines a referral names and its text: the shipped table, the country a turn's locale or
 * country field points to, and the reply built from both.
 *
 * @module @framers/agentos-ext-self-harm-referral/referrals
 */

import shippedTable from './referral-lines.json' with { type: 'json' };
import type { ReferralLine, ReferralTable } from './types.js';

/** The table the pack ships, `src/referral-lines.json`: each line with the page that states its number. */
export const REFERRAL_TABLE: ReferralTable = shippedTable as ReferralTable;

/** Country codes people write for a country whose ISO 3166-1 code differs. */
const COUNTRY_ALIASES: Record<string, string> = { UK: 'GB' };

/**
 * A country code as the table keys it: two letters, upper case, with `UK` read as `GB`; undefined for anything else.
 *
 * @param value - A country code from a guardrail context or the guard's options.
 */
export function normalizeCountry(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return undefined;
  return COUNTRY_ALIASES[code] ?? code;
}

/**
 * The country a BCP 47 locale's region subtag names: `en-GB` and `en_gb` give `GB`, `zh-Hant-TW` gives `TW`. A locale
 * with no region (`en`, `de`), or a numeric region such as `es-419` (Latin America), names no country.
 *
 * @param locale - A locale such as a channel reports for its user (Discord's `en-GB`, Telegram's `pt-br`).
 */
export function countryOfLocale(locale: unknown): string | undefined {
  if (typeof locale !== 'string') return undefined;
  const subtags = locale.trim().split(/[-_]/);
  for (const subtag of subtags.slice(1)) {
    if (/^[A-Za-z]{4}$/.test(subtag)) continue; // a script, such as Hant
    if (/^[A-Za-z]{2}$/.test(subtag)) return normalizeCountry(subtag);
    return undefined; // a numeric region, a variant or an extension: no country
  }
  return undefined;
}

/** The country a referral leads with and where it came from. */
export interface ReferralPlace {
  /** A country the table holds, or null. */
  country: string | null;
  /** The locale the country was read from, when it came from one. */
  locale: string | null;
}

/** One place a turn may name its country: a country code or a locale, in the order the guard reads them. */
export type PlaceHint = { country: unknown } | { locale: unknown };

/**
 * The first hint that names a country decides where the person is. A hint naming no country (a locale with no region,
 * a field that is not a code) is read past. A country the table does not hold ends the search with no country, so the
 * referral names the table's default lines and the local-emergency sentence: a later hint or the pack's default would
 * give the emergency number of a country this person is not in.
 *
 * @param table - The table the lines come from.
 * @param hints - The places to read, most specific first.
 */
export function resolvePlace(table: ReferralTable, hints: readonly PlaceHint[]): ReferralPlace {
  for (const hint of hints) {
    const fromLocale = 'locale' in hint;
    const country = fromLocale ? countryOfLocale(hint.locale) : normalizeCountry(hint.country);
    if (!country) continue;
    if (!table.countries[country]) return { country: null, locale: null };
    return { country, locale: fromLocale ? String(hint.locale) : null };
  }
  return { country: null, locale: null };
}

/** A referral's text and the lines it names. */
export interface Referral {
  text: string;
  lines: ReferralLine[];
}

/**
 * The referral for a country: the table's opening sentence, the country's lines, the lines of the country every
 * referral names (988 in the United States), the line for anywhere else, and the country's emergency number, or the
 * sentence that names none when the country is unknown.
 *
 * @param table - The table the lines come from.
 * @param country - A country the table holds, or null for the default lines.
 */
export function buildReferral(table: ReferralTable, country: string | null): Referral {
  const own = country ? table.countries[country] : undefined;
  const always = table.countries[table.always];
  const lines: ReferralLine[] = [];
  for (const line of [...(own?.lines ?? []), ...(always?.lines ?? []), table.elsewhere]) {
    if (!lines.some((seen) => seen.id === line.id)) lines.push(line);
  }
  // Only the country's own number: another country's would send a person to a number that does not answer there.
  const emergency = own?.emergency;
  const closing = emergency
    ? table.emergency.known.replace('{number}', emergency.number)
    : table.emergency.unknown;
  const text = [table.intro, '', ...lines.map((line) => `- ${line.label}: ${line.text}`), '', closing].join('\n');
  return { text, lines };
}

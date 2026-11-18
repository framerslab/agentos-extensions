/**
 * @file kinds.ts
 * @description What kind of source a page is, read from its host alone, and the words a provider or a kind may be. A
 * kind is an open word: {@link SOURCE_KINDS} names the ones this pack reads, and a host may answer any word that
 * {@link isSourceWord} holds. Data and pure functions: no request is made here.
 *
 * @module agentos/extensions/research/public-sources/kinds
 */

/** The kinds `kindOfHost` answers: a reference work, a government or similar body, a paper, news, any page, a forum. */
export const SOURCE_KINDS = ['encyclopedia', 'official', 'paper', 'news', 'page', 'forum'] as const;

/** One of the kinds this pack names. */
export type SourceKind = (typeof SOURCE_KINDS)[number];

const SOURCE_WORD = /^[a-z][a-z0-9_-]{0,31}$/u;

/** Whether a word may name a provider or a kind: a lower-case letter, then up to 31 lower-case letters, digits, `_` or `-`. */
export function isSourceWord(word: string): boolean {
  return typeof word === 'string' && SOURCE_WORD.test(word);
}

/** Wikimedia's hosts, less its news site, Wikinews, which is read as news. */
const WIKIMEDIA = ['wikipedia.org', 'wikimedia.org', 'wikidata.org', 'wikisource.org', 'wikiquote.org', 'wikibooks.org', 'wikiversity.org', 'wikivoyage.org', 'wiktionary.org', 'mediawiki.org'];

/** The reference works read as encyclopedias, beside Wikimedia's. */
const ENCYCLOPEDIAS = ['britannica.com', 'plato.stanford.edu', 'encyclopedia.com'];

/** The international bodies read as official, beside the `.int` hosts. */
const INTERNATIONAL = ['un.org', 'europa.eu', 'worldbank.org', 'imf.org', 'oecd.org', 'wto.org', 'unesco.org', 'unicef.org', 'icj-cij.org'];

/** The identifier, journal and preprint hosts read as papers. */
const PAPERS = [
  'doi.org', 'arxiv.org', 'biorxiv.org', 'medrxiv.org', 'ssrn.com', 'pubmed.ncbi.nlm.nih.gov', 'ncbi.nlm.nih.gov', 'nature.com', 'science.org',
  'sciencedirect.com', 'springer.com', 'wiley.com', 'tandfonline.com', 'jstor.org', 'plos.org', 'thelancet.com', 'nejm.org', 'bmj.com', 'cell.com',
  'pnas.org', 'acm.org', 'ieee.org', 'frontiersin.org', 'mdpi.com', 'cambridge.org', 'academic.oup.com',
];

/** The news hosts read as news. */
const NEWS = [
  'apnews.com', 'reuters.com', 'bbc.com', 'bbc.co.uk', 'npr.org', 'nytimes.com', 'washingtonpost.com', 'wsj.com', 'ft.com', 'theguardian.com',
  'economist.com', 'bloomberg.com', 'aljazeera.com', 'cnn.com', 'nbcnews.com', 'cbsnews.com', 'abcnews.go.com', 'latimes.com', 'usatoday.com',
  'politico.com', 'axios.com', 'theatlantic.com', 'time.com', 'newsweek.com', 'pbs.org', 'cbc.ca', 'abc.net.au', 'dw.com', 'france24.com',
  'lemonde.fr', 'spiegel.de', 'independent.co.uk', 'telegraph.co.uk', 'thetimes.co.uk', 'irishtimes.com', 'scmp.com', 'japantimes.co.jp',
  'thehindu.com', 'smh.com.au', 'nzherald.co.nz', 'theglobeandmail.com', 'afp.com', 'euronews.com', 'wikinews.org',
];

/** The forums, question sites and social networks read as forums. */
const FORUMS = [
  'reddit.com', 'quora.com', 'stackexchange.com', 'stackoverflow.com', 'news.ycombinator.com', 'answers.yahoo.com', 'facebook.com', 'x.com',
  'twitter.com', 'instagram.com', 'tiktok.com', 'linkedin.com', 'threads.net', 'mastodon.social', 'bsky.app', 'tumblr.com', 'discord.com',
  'answers.com',
];

/** A host as the table reads it: case-folded, a trailing dot and a leading "www." removed. */
function normalHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/u, '').replace(/^www\./u, '');
}

/** Whether a host is one of the names given or a name under one. */
function under(host: string, names: readonly string[]): boolean {
  return names.some((name) => host === name || host.endsWith(`.${name}`));
}

/** A government, university, international or military host: `.gov`, `.gov.<cc>`, `.edu`, `.int`, `.mil` or a listed body. */
function officialHost(host: string): boolean {
  return /(?:^|\.)(?:gov|edu|int|mil)$/u.test(host) || /(?:^|\.)gov\.[a-z]{2}$/u.test(host) || under(host, INTERNATIONAL);
}

/**
 * A page's kind from its host. The host's `overrides` come first: a host or a name under it, the longest name that
 * matches deciding. Then, in order: the Wikimedia hosts (Wikinews aside) and the reference works (`britannica.com`,
 * `plato.stanford.edu`, `encyclopedia.com`) are `encyclopedia`; the identifier, journal and preprint hosts (`doi.org`,
 * `arxiv.org` and the others listed) are `paper`, a journal host under `.gov` among them; `.gov`, `.gov.<cc>`, `.edu`,
 * `.int`, `.mil` and the international bodies listed are `official`; the news hosts listed are `news`; the forums,
 * question sites and social networks listed are `forum`; any other host is `page`. A host is read case-folded, with a
 * trailing dot and a leading "www." removed, and a rule for a name holds for every name under it.
 *
 * @param host - A page's host, such as `www.cdc.gov`.
 * @param overrides - The host's own reading: a kind by host name.
 * @returns The kind.
 * @throws {RangeError} For an override whose kind is not a source word.
 */
export function kindOfHost(host: string, overrides?: Readonly<Record<string, string>>): string {
  const name = normalHost(host);
  if (overrides !== undefined) {
    let best: { length: number; kind: string } | null = null;
    for (const [key, kind] of Object.entries(overrides)) {
      if (!isSourceWord(kind)) throw new RangeError(`the kind for ${key} is not a source word: ${JSON.stringify(kind)}`);
      const keyName = normalHost(key);
      if (keyName === '' || !under(name, [keyName])) continue;
      if (best === null || keyName.length > best.length) best = { length: keyName.length, kind };
    }
    if (best !== null) return best.kind;
  }
  if (name === '') return 'page';
  if (under(name, WIKIMEDIA) || under(name, ENCYCLOPEDIAS)) return 'encyclopedia';
  if (under(name, PAPERS)) return 'paper';
  if (officialHost(name)) return 'official';
  if (under(name, NEWS)) return 'news';
  if (under(name, FORUMS)) return 'forum';
  return 'page';
}

/**
 * @fileoverview The reviewed keyword list the guard matches before it asks a judge.
 *
 * Every entry is a regular expression over the text as AgentOS's `normalizePhraseText` leaves it: NFKC, lower case,
 * zero-width characters and combining marks removed, Cyrillic and Greek look-alikes mapped to Latin letters, curly
 * quotes straightened, whitespace collapsed. So `I want to DIE`, `i want to dіe` (a Cyrillic і) and `I want​ to die`
 * (a zero-width space) all read `i want to die`. AgentOS compiles each pattern with the `iu` flags.
 *
 * The list is wide on purpose: a match alone sends the referral when no judge is configured, and a judge clears the
 * figurative uses (`this traffic is killing me` does not match; `I could kill myself laughing` does, and the judge
 * clears it). Missing a person who needs the lines costs more than a referral nobody needed.
 *
 * @module @framers/agentos-ext-self-harm-referral/phrases
 */

import type { PhraseEntry } from '@framers/agentos/safety/guardrails';

/** The list's version, reported with every referral's verdict. */
export const SELF_HARM_PHRASES_VERSION = '2026-11-04';

/** The rule every entry belongs to: the verdict's rule and the judge's subject. */
export const SELF_HARM_RULE_ID = 'self_harm';

/** A letter or a digit may not touch the pattern on either side. */
const START = '(?<![\\p{L}\\p{N}])';
const END = '(?![\\p{L}\\p{N}])';

/** One list entry: `pattern` between those boundaries, handed to the judge when it matches. */
const entry = (pattern: string): PhraseEntry => ({
  phrase: `${START}(?:${pattern})${END}`,
  match: 'regex',
  onMatch: 'judge',
  ruleId: SELF_HARM_RULE_ID,
});

/** Ways a person writes about ending their life or hurting themselves, in the first person. Both stages read them. */
export const SELF_HARM_PHRASES: readonly PhraseEntry[] = [
  // `suicide` and `suicidal`, and the spellings people type in a hurry: sucide, suicde, suiside.
  entry('su(?:ici|ci|ic|isi)d(?:e|es|al|ality)'),
  entry(
    '(?:kill|killing|killed|hurt|hurting|harm|harming|cut|cutting|injure|injuring|starve|starving|hang|hanging|drown|drowning|shoot|shooting|unalive|unaliving) (?:myself|my self|me self)',
  ),
  entry('self[- ]?(?:harm|harming|injury|injuring|mutilation|mutilating)'),
  entry('(?:end|ending|ended|take|taking|took) my (?:own )?life'),
  entry('end(?:ing)? (?:it all|everything)'),
  entry('(?:(?:want|wanna|wanted|going|gonna|wish|wishing|ready|deserve) to|wanna|gonna) die'),
  entry('(?:want|wanted|wanting|wish|wished|wishing) to be dead|wanna be dead'),
  entry("wish(?:ed)? i (?:was|were|'d been|had been) dead"),
  entry("wish(?:ed)? i (?:was|were) never born|wish(?:ed)? i (?:had|'d) never been born"),
  entry('better off (?:dead|without me)'),
  entry('(?:no reason|nothing left|nothing) to live for|no reason to (?:live|go on|keep going)'),
  entry('no point (?:in )?(?:living|going on|being alive)'),
  entry("(?:not|isn't|isnt) worth living"),
  entry('(?:sleep|asleep) and (?:not|never) wake up'),
  entry("(?:hope|wish) i (?:don't|dont|do not|never|won't|wont) wake up"),
  // `kms` is also kilometres, so only after a word that makes it the slang for killing oneself.
  entry("(?:gonna|going to|wanna|want to|might|should|about to|i'll|ill|ima|i'ma) kms"),
  entry(
    "(?:don't|dont|do not|didn't|didnt|did not) (?:want to|wanna) (?:live|be alive|exist|wake up|be here anymore|go on)",
  ),
  entry("(?:can't|cant|cannot) go on"),
  entry('overdos(?:e|ed|es|ing)'),
  entry('lethal dose'),
  entry('(?:painless|easiest|quickest|fastest|best) way to die'),
];

/**
 * Ways an agent's reply carries the topic on, in the second person. Only the output stage reads them, since a person
 * who writes `kill yourself` is not writing about their own life.
 */
export const REPLY_PHRASES: readonly PhraseEntry[] = [
  entry(
    '(?:kill|killing|hurt|hurting|harm|harming|cut|cutting|injure|injuring|starve|starving|hang|hanging|drown|drowning|shoot|shooting) (?:yourself|your self)',
  ),
  entry('(?:end|ending|take|taking) your (?:own )?life'),
  entry('(?:you|you are|you\'re|youre) (?:want|wanting|wanna|going|gonna|ready) to die'),
];

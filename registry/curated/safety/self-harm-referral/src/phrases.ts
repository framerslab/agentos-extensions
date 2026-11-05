/**
 * @fileoverview The reviewed keyword list the guard matches before it asks a judge.
 *
 * Every entry is a regular expression over the text as AgentOS's `normalizePhraseText` leaves it: NFKC, lower case,
 * zero-width characters and combining marks removed, Cyrillic and Greek look-alikes mapped to Latin letters, curly
 * quotes straightened, whitespace collapsed. So `I want to DIE`, `i want to dіe` (a Cyrillic і) and `I want​ to die`
 * (a zero-width space) all read `i want to die`. AgentOS compiles each pattern with the `iu` flags.
 *
 * The list is wide on purpose: a match alone sends the referral when no judge is configured, and a judge clears the
 * figurative and everyday uses (`this traffic is killing me` does not match; `I could kill myself laughing`, `I burned
 * myself on the stove` and `I want to end it with him` do, and the judge clears them). Missing a person who needs the
 * lines costs more than a referral nobody needed, and the judge reads only texts the list matched, so a question about
 * methods or amounts has to be on the list to reach it.
 *
 * Its wording starts from published screening questions and warning signs, put in the first person: the Columbia
 * Protocol (https://cssrs.columbia.edu/wp-content/uploads/Columbia_Protocol.pdf), NIMH's ASQ
 * (https://www.nimh.nih.gov/sites/default/files/documents/research/research-conducted-at-nimh/asq-toolkit-materials/asq-tool/screening-tool-asq-nimh-toolkit.pdf),
 * PHQ-9 item 9 (https://www.apa.org/depression-guideline/patient-health-questionnaire.pdf), NIMH's and AFSP's warning
 * signs (https://www.nimh.nih.gov/health/publications/warning-signs-of-suicide,
 * https://afsp.org/risk-factors-protective-factors-and-warning-signs/), and the kinds of self-harm NHS inform and
 * Rethink Mental Illness list
 * (https://www.nhsinform.scot/illnesses-and-conditions/mental-health/self-harm/,
 * https://www.rethink.org/advice-and-information/about-mental-illness/learn-more-about-symptoms/self-harm/). The slang,
 * the spellings and the intensifiers come from how people type, not from those sources.
 *
 * @module @framers/agentos-ext-self-harm-referral/phrases
 */

import type { PhraseEntry } from '@framers/agentos/safety/guardrails';

/** The list's version, reported with every referral's verdict. */
export const SELF_HARM_PHRASES_VERSION = '2026-11-05';

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

/** Words people put inside a phrase without changing it: `I want to fucking die`, `I really just want to die`. */
const STRESS =
  "(?:(?:really|just|only|simply|so|very|truly|honestly|actually|literally|seriously|badly|desperately|kinda|kind of|sorta|sort of|fucking|fuckin|fkn|fking|f\\*+cking|effing|freaking|friggin|frigging|bloody|damn|goddamn) ){0,3}";

const DIE = 'die+';
const MYSELF = '(?:myself+|my self|me self|meself)';
const CANT = "(?:can't|cant|cannot|can not|couldn't|couldnt)";
const DONT = "(?:don't|dont|do not|didn't|didnt|did not)";
/** Where an ambiguous word has to end its clause: `I want to end this.` and not `I want to end this call`. */
const CLAUSE_END = '(?=\\s*(?:$|[.,!?;:]))';

/** A first-person or intent word within five words before a means, which leaves a story's `he jumped off the tower` out. */
const FIRST_PERSON =
  "(?:i|i'm|im|i'll|ill|i'd|id|i've|ive|me|wanna|gonna|want|wanting|thinking|thought|thoughts|planning|plan|how|urge|urges)(?: [\\p{L}'-]+){0,5}";
const LEAP = `(?:jump(?:s|ing|ed)?|leap(?:s|ing|ed|t)?|throw(?:s|ing)? ${MYSELF}|threw ${MYSELF}|fling(?:s|ing)? ${MYSELF}|flung ${MYSELF})`;
const STEP = '(?:step(?:s|ping|ped)?|walk(?:s|ing|ed)?)';
const THE = "(?:(?:a|an|the|this|that|my|our|some) )?(?:[\\p{L}\\p{N}'-]+ ){0,2}";
const HEIGHT = '(?:bridge|building|roof|rooftop|cliff|balcony|overpass|ledge|tower|skyscraper|window|floor)';
const VEHICLE = '(?:train|bus|car|truck|lorry|van|subway|tram)';
const PILLS = '(?:sleeping )?(?:pills|tablets|meds|medication|medications|medicine|painkillers|paracetamol|acetaminophen|tylenol)';

/** Ways a person writes about ending their life or hurting themselves, in the first person. Both stages read them. */
export const SELF_HARM_PHRASES: readonly PhraseEntry[] = [
  // `suicide` and `suicidal`, and the spellings people type in a hurry: sucide, suicde, suiside, su1cide.
  entry('su(?:[i1!]c[i1!]|ci|ic|isi)d(?:e|es|al|ality)'),
  entry('sewer ?slide|unaliv(?:e|es|ed|ing)|self[- ]?delet(?:e|es|ed|ing|ion)'),

  // Hurting oneself, in every tense: `I keep burning myself`, `I cut myself`, `I punch myself`.
  entry(
    `(?:kill(?:s|ing|ed)?|hurt(?:s|ing)?|harm(?:s|ing|ed)?|injur(?:e|es|ed|ing)|starv(?:e|es|ed|ing)|hang(?:s|ing|ed)?|hung|drown(?:s|ing|ed)?|stab(?:s|bing|bed)?|slash(?:es|ing|ed)?|scratch(?:es|ing|ed)?|scald(?:s|ing|ed)?|punch(?:es|ing|ed)?|hit(?:s|ting)?|bit(?:e|es|ing)?|poison(?:s|ing|ed)?|suffocat(?:e|es|ed|ing)|strangl(?:e|es|ed|ing)|chok(?:e|es|ed|ing)|carv(?:e|es|ed|ing)|gas(?:sing|sed)?|electrocut(?:e|es|ed|ing)|off(?:s|ing|ed)?|end(?:s|ing|ed)?|unaliv(?:e|es|ed|ing)|neck(?:s|ing|ed)?) ${MYSELF}`,
  ),
  // The same with the idioms left out: burned out, beat oneself up, cut oneself off, shot oneself in the foot.
  entry(`burn(?:s|ing|ed|t)? ${MYSELF}(?! out)`),
  entry(`beat(?:s|ing)? ${MYSELF}(?! up)`),
  entry(`cut(?:s|ting)? ${MYSELF}(?! off| some slack)`),
  entry(`(?:shoot(?:s|ing)?|shot) ${MYSELF}(?! in the foot)`),
  entry(`do(?:ing)? ${MYSELF} in`),
  // NHS inform names wrists, arms, thighs and chest as where the marks usually are.
  entry(
    '(?:cut(?:s|ting)?|slit(?:s|ting)?|slash(?:es|ing|ed)?|burn(?:s|ing|ed|t)?|carv(?:e|es|ed|ing)|stab(?:s|bing|bed)?) (?:open )?(?:both )?my (?:own )?(?:wrists?|arms?|forearms?|thighs?|legs?|skin|throat|chest|stomach|hips?|veins?)',
  ),
  entry("(?:cut|cutting|burn|burning|burned|burnt|hurt|hurting|hit|hitting|injured|bruised) my(?: [\\p{L}'-]+){0,2} on purpose"),
  entry('cutting again'),
  entry('relaps(?:e|es|ed|ing)(?: and| on| into)? (?:cut|cutting|burn|burning|self)'),
  entry('urges? to (?:cut|burn|hurt|harm|die|self)'),
  entry('self[- ]?(?:harm(?:s|ed|er|ers|ing)?|injur(?:y|ies|e|es|ed|ing)|mutilat(?:e|es|ed|ing|ion))|nssi'),

  // Ending one's life, and ending it with no object: `I just want to end it`, `I'm ending it`.
  entry('(?:end|ends|ending|ended|take|takes|taking|took) my (?:own )?life(?! back)'),
  entry('end(?:s|ing)? (?:it all|everything)'),
  entry(
    `(?:want|wanna|wanted|wanting|going|gonna|ready|need|plan|planning|planned|decided|deciding|think|thinking|thought|wish|wishing|wished|trying|try|tried|time|i'll|ill|i'm|im|i am|i'd|i should|i could|i might|i may|i will|i would) ${STRESS}(?:(?:to|of|about|on|i could|i would|i'd) )?${STRESS}end(?:ing)? (?:it|things|this${CLAUSE_END})`,
  ),
  entry(`(?:want|wanna|wish|need) (?:it|this|everything)(?: all)? (?:to|would|could)(?: all)?(?: just)? (?:end|stop|be over)${CLAUSE_END}`),

  // Wanting to die, with whatever words people put inside the phrase.
  entry(
    `(?:(?:want|wanted|wanting|wish|wishing|going|ready|deserve|need|trying|tried|try|planning|plan|longing|begging) ${STRESS}to|wanna|gonna|tryna) ${STRESS}${DIE}`,
  ),
  entry(`(?:i'm|im|i am) about to ${DIE}`),
  entry('(?:want|wanted|wanting|wish|wished|wishing) to be dead|wanna be dead'),
  entry(`want(?:s|ed|ing)? ${STRESS}death`),
  entry(
    `(?:want|wanted|wanting) ${STRESS}to (?:disappear|not exist|not be alive|not be here|stop existing|cease to exist|be gone)|wanna (?:disappear|not exist|not be alive|not be here|stop existing|be gone)`,
  ),
  // The Columbia Protocol's first question and the ASQ's: wishing to be dead, or to sleep and not wake up.
  entry("wish(?:ed)? i (?:was|were|'d been|had been) dead"),
  entry("wish(?:ed)? i (?:was|were) never born|wish(?:ed)? i (?:had|'d) never been born"),
  entry(
    `wish(?:ed|ing)?(?: that)? (?:i'd|id|i) ${STRESS}(?:(?:could|would|can|might|had|have) )?${STRESS}(?:${DIE}|died|be dead|disappear|not exist|not be here|not be alive|stop existing|cease to exist|sleep forever|never wake up|not wake up)`,
  ),
  entry("wish(?:ed|ing)?(?: that)? i (?:was not|were not|wasn't|wasnt|weren't|werent) (?:here|alive|born|around)"),
  entry("wish(?:ed|ing)?(?: that)? i (?:didn't|didnt|did not) exist"),
  entry(`(?:hope|hoping|pray|praying)(?: that)? i ${STRESS}${DIE}`),
  entry('(?:hope|hoping|wish|wishing|pray|praying)(?: that)? i (?:(?:would|could|might) )?get (?:hit|run over)'),
  entry(`i (?:should|might as well|may as well) ${STRESS}(?:${DIE}|be dead)`),
  entry(`rather ${STRESS}(?:${DIE}|be dead)`),
  entry(`(?:let|letting) me ${DIE}`),
  entry('(?:someone|somebody|please|just|god) kill me'),
  entry(`(?:thoughts?|thinking|think|thought|fantasi[sz]ing) (?:of|about) (?:dying|death|being dead)`),
  entry('better off (?:dead|without me)'),
  entry("better off if i(?: was| were|'m| am)?(?: just)?(?: not)? (?:dead|died|gone|here|around|alive)"),
  entry("better off if i (?:wasn't|wasnt|weren't|werent) (?:here|around|alive)"),
  entry("(?:everyone|everybody|my family|my kids)(?: would| will|'d)? be better off"),
  entry('(?:no reason|nothing left|nothing) to live for|no reason to (?:live|go on|keep going)'),
  entry('no point (?:in )?(?:living|going on|being alive|anymore|any more)'),
  entry("(?:what's|whats|what is) the point (?:of|in) (?:living|life|going on|being alive)"),
  entry("(?:not|isn't|isnt|ain't|aint|no longer) worth living"),
  entry("life(?: is|'s)? (?:not|isn't|isnt|ain't|aint|no longer) worth (?:it|living)"),
  entry('(?:tired|sick) of (?:living|being alive|life|existing|being here)'),
  entry('(?:done|finished) with (?:life|living|being alive|it all)|done living'),
  entry('will to live'),
  // NIMH's and AFSP's warning signs: being a burden to others, having no reason to live, feeling trapped.
  entry("(?:i'm|im|i am|i feel like|feel like|i feel) (?:such |just |only |nothing but |so much of )?a burden"),
  entry("(?:nobody|no one|noone)(?: would| will|'d)(?: even)? (?:miss me|care if i|notice if i|notice i'm gone)"),
  entry("(?:see|there's|theres|there is) no way out"),
  entry('(?:sleep|asleep) and (?:not|never) wake up'),
  entry("(?:hope|wish) i (?:don't|dont|do not|never|won't|wont) wake up"),
  entry(
    `(?:want|wanna|wish|wishing|hope|hoping) ${STRESS}(?:(?:to|i could|i would|i'd|i) )?${STRESS}(?:sleep forever|never wake(?: up)?|not wake(?: up)?)`,
  ),
  // `kms` is also kilometres, so only after a word that makes it the slang for killing oneself.
  entry("(?:gonna|going to|wanna|want to|might|should|about to|i'll|ill|ima|i'ma) kms"),
  entry(`${DONT} ${STRESS}(?:want to|wanna) ${STRESS}(?:live|be alive|exist|wake up|be here any ?more|be here any longer|go on)`),
  // `I can't go on Friday` matches too. A judge clears it; with no judge it is the over-match the README's Limits name.
  entry(`${CANT} go on`),
  entry(`${CANT} (?:take|bear|stand|handle|cope with|do|keep doing|live with|live like) (?:it|this|the pain|life|living|myself)(?: any ?more| any longer| much longer)`),
  entry(`${CANT} (?:carry on|keep going|keep on)(?: like this| any ?more| any longer)`),
  entry(`${CANT} (?:live like this|live with myself|live any ?more|live any longer|keep living|keep existing|cope any ?more|exist any ?more|be here any ?more)`),

  // Amounts, as the Columbia Protocol's sixth question names them, and questions about how much or how long.
  entry('overdos(?:e|ed|es|ing)'),
  entry("(?:gonna|going to|wanna|want to|might|about to|how to|how do i|i'll|ill|ima|i'ma|could) od|od(?:'d|ed|ing)? on"),
  entry('(?:lethal|fatal|deadly) (?:dose|doses|dosage|amount|quantity)'),
  entry(
    `how (?:many|much|long|high|far)(?: [\\p{L}\\p{N}'-]+){0,8} (?:to ${DIE}|kill(?:s)? (?:me|you|a person|someone)|(?:be|is) (?:fatal|lethal|deadly)|to overdose|to od|to bleed out|to (?:end|take) my life)`,
  ),
  entry(`i (?:took|swallowed|downed) (?:(?:a lot of|lots of|a bunch of|so many|some) )?(?:sleeping )?(?:pills|tablets)`),
  entry(
    `(?:take|taking|took|swallow|swallowing|swallowed|down|downing|downed) (?:all (?:of )?(?:my|the|these|those)|a (?:whole |full |entire )?bottle of|the (?:whole |full |entire )?bottle of|a (?:whole )?(?:handful|pack|packet|box) of|the (?:whole )?(?:pack|packet|box) of|too many)(?: [\\p{L}'-]+){0,2} ${PILLS}`,
  ),
  entry(`enough ${PILLS} (?:to|that)`),
  entry(`(?:collect|collecting|collected|sav(?:e|ing|ed)|stockpil(?:e|ing|ed)|hoard(?:ing|ed)?|stash(?:ing|ed)?)(?: up)?(?: all)?(?: my| the| these| those| some| enough)? ${PILLS}`),

  // Methods, as people ask for them: NIMH's `researching ways to die`, AFSP's `searching online for methods`.
  entry(`ways? to ${DIE}`),
  entry(`methods? (?:of|to|for) (?:dying|${DIE})`),
  entry(`how to ${STRESS}${DIE}`),
  entry(`how (?:do|can|could|would|should|might) (?:i|you|people|someone|one|a person) ${STRESS}${DIE}`),
  entry('(?:tie|tying|make|making|buy|buying|hang|hanging) (?:a |the |my )?noose'),

  // Means. A person's own words about jumping, stepping out or driving off; the height or the vehicle is what is listed.
  entry(`${FIRST_PERSON} ${LEAP} (?:off(?: of)?|from|out(?: of)?) ${THE}${HEIGHT}`),
  entry(`${FIRST_PERSON} ${STEP} off(?: of)? ${THE}${HEIGHT}`),
  entry(`${FIRST_PERSON} (?:${LEAP}|${STEP}|lie|lay|lying|laying) (?:out |down )?in front of ${THE}${VEHICLE}`),
  entry(`${FIRST_PERSON} ${LEAP} under ${THE}${VEHICLE}`),
  entry(`${FIRST_PERSON} (?:${LEAP}|${STEP}|run|running|ran) (?:out )?into (?:(?:the|oncoming|busy|moving|heavy) ){0,2}traffic`),
  entry(`${FIRST_PERSON} (?:lie|lay|lying|laying|stand|standing|stood)(?: down)? on (?:(?:the|a) )?(?:(?:train|railway|railroad|subway) )?tracks`),
  entry(
    `${FIRST_PERSON} (?:drive|driving|drove|crash|crashing|crashed|steer|steering|swerve|swerving|wreck|wrecking)(?: my(?: own)?(?: car| truck| van| bike)?)? (?:off|into)(?: a| an| the)?(?: [\\p{L}'-]+)? (?:bridge|cliff|wall|tree|overpass|barrier|oncoming traffic)`,
  ),
  entry('gun (?:to|in|against) my (?:head|mouth|temple)'),
  entry('(?:blow|blew|blowing) my (?:brains?|head) (?:out|off)'),
  entry('bullet (?:in|through|into) my (?:head|brain|mouth)'),

  // Preparing, as the Columbia Protocol's sixth question and AFSP's warning signs name it.
  entry('(?:give|gives|giving|gave|given) away (?:all )?(?:of )?my (?:(?:prized )?(?:things|stuff|belongings|possessions|valuables))'),
  entry('goodbye (?:note|notes|letter|letters)'),
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

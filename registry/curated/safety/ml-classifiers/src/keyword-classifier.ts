// @ts-nocheck
/**
 * @file keyword-classifier.ts
 * @description Lightweight keyword and regex-based safety classifier used as the
 * last-resort fallback when neither ONNX models nor an LLM invoker are available.
 *
 * Returns normalised confidence scores per category based on keyword density and
 * pattern matches.  This is intentionally conservative — it will produce false
 * positives in edge cases, but ensures the guardrail is never completely blind.
 *
 * @module ml-classifiers/keyword-classifier
 */

import type { ClassifierCategory, CategoryScore } from './types.js';
import { ALL_CATEGORIES } from './types.js';

// ---------------------------------------------------------------------------
// Pattern dictionaries
// ---------------------------------------------------------------------------

/**
 * Toxic language patterns — slurs, hate speech, and abusive terms.
 *
 * Each regex uses word boundaries (`\b`) to reduce false positives from
 * substrings appearing in innocent words.
 */
const TOXIC_PATTERNS: RegExp[] = [
  /\b(fuck|shit|ass(?:hole)?|bitch|bastard|damn|crap)\b/i,
  /\b(kill\s+(?:yourself|urself|you)|kys)\b/i,
  /\b(retard(?:ed)?|idiot|moron|stupid\s+(?:bitch|ass))\b/i,
  /\b(hate\s+(?:you|u)|die\s+(?:in|alone))\b/i,
  /\b(racial|ethnic)\s+slur/i,
  /\b(n[i1]gg|f[a4]g(?:got)?|tr[a4]nn)/i,
];

/**
 * Prompt injection / jailbreak patterns — attempts to override system
 * instructions, extract system prompts, or bypass safety guardrails.
 */
const INJECTION_PATTERNS: RegExp[] = [
  /\bignore\s+(?:all\s+)?(?:previous|above|prior)\s+instructions?\b/i,
  /\byou\s+are\s+now\s+(?:DAN|evil|unrestricted|jailbroken)\b/i,
  /\bsystem\s*prompt\s*[:=]/i,
  /\bdo\s+anything\s+now\b/i,
  /\bdisregard\s+(?:your|all)\s+(?:rules|guidelines|instructions)\b/i,
  /\bpretend\s+(?:you(?:'re|\s+are)\s+)?(?:not\s+an?\s+AI|unrestricted|evil)\b/i,
  /\bact\s+as\s+(?:if|though)\s+(?:you\s+have\s+)?no\s+(?:restrictions|rules|limits)\b/i,
  /\boverride\s+(?:safety|content)\s+(?:filters?|policies|guidelines)\b/i,
  /\bjailbreak/i,
  /\bprompt\s+(?:leak|injection|extract)/i,
];

/**
 * NSFW patterns — sexually explicit content markers.
 */
const NSFW_PATTERNS: RegExp[] = [
  /\b(porn(?:ography)?|hentai|xxx|nsfw)\b/i,
  /\b(nude|naked|topless)\s+(?:photo|pic|image|video)\b/i,
  /\bsexual(?:ly)?\s+explicit\b/i,
  /\b(erotic|orgasm|masturbat)/i,
  /\bsext(?:ing)?\b/i,
];

/**
 * Threat patterns — direct threats of violence, self-harm instructions,
 * or dangerous activity incitement.
 */
const THREAT_PATTERNS: RegExp[] = [
  /\b(?:i(?:'ll|\s+will)\s+)?kill\s+(?:you|him|her|them)\b/i,
  /\b(?:how\s+to\s+)?make\s+a?\s*(?:bomb|explosive|weapon)\b/i,
  /\b(?:i(?:'ll|\s+will)\s+)?hurt\s+(?:you|myself|someone)\b/i,
  /\bsuicid(?:e|al)\s+(?:method|instruction|guide|how)/i,
  /\b(?:swat(?:ting)?|dox(?:x?ing)?)\s+(?:someone|him|her|you)\b/i,
  /\bshoot\s+up\s+(?:a\s+)?(?:school|church|mosque|synagogue|building)\b/i,
];

/**
 * Map category names to their pattern arrays for uniform iteration.
 */
const CATEGORY_PATTERNS: Record<ClassifierCategory, RegExp[]> = {
  toxic: TOXIC_PATTERNS,
  injection: INJECTION_PATTERNS,
  nsfw: NSFW_PATTERNS,
  threat: THREAT_PATTERNS,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a text string using keyword and regex pattern matching.
 *
 * Confidence is computed as `min(1.0, matchCount * weight)` where `weight`
 * scales the number of distinct pattern matches into the [0, 1] range.
 * A single match yields a base confidence of 0.4; each additional match
 * adds 0.15 up to a cap of 1.0.
 *
 * @param text       - The text to classify.
 * @param categories - Which categories to evaluate.  Defaults to all four.
 * @returns Per-category confidence scores.
 */
export function classifyByKeywords(
  text: string,
  categories: ClassifierCategory[] = ALL_CATEGORIES
): CategoryScore[] {
  const scores: CategoryScore[] = [];

  for (const cat of categories) {
    const patterns = CATEGORY_PATTERNS[cat];
    if (!patterns) {
      scores.push({ name: cat, confidence: 0 });
      continue;
    }

    // Count how many distinct patterns match.
    let matchCount = 0;
    for (const re of patterns) {
      if (re.test(text)) {
        matchCount++;
      }
    }

    // Scale: first match = 0.4, each additional += 0.15, capped at 1.0.
    const confidence = matchCount === 0 ? 0 : Math.min(1.0, 0.4 + (matchCount - 1) * 0.15);

    scores.push({ name: cat, confidence });
  }

  return scores;
}

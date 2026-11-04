/**
 * Regression pin for the pack's grammY range.
 *
 * `allowedUpdatesWithoutBusiness()` reads `API_CONSTANTS.DEFAULT_UPDATE_TYPES`
 * from grammY. grammY 1.21.0 exports no `API_CONSTANTS`; 1.21.1 is the first
 * release that does. A range whose floor is 1.21.0 lets an install that holds
 * grammY 1.21.0 resolve it, and turning business updates off then throws
 * "Cannot read properties of undefined" when the service starts.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The first grammY release that exports `API_CONSTANTS`. */
const FIRST_GRAMMY_WITH_API_CONSTANTS = [1, 21, 1] as const;

describe('package.json', () => {
  it('admits no grammY release without API_CONSTANTS', () => {
    const shipped = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const range = shipped.dependencies.grammy;
    const floor = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
    expect(floor, `grammY range ${range} is not a caret range`).not.toBeNull();
    const [major, minor, patch] = floor!.slice(1).map(Number);
    const [wantMajor, wantMinor, wantPatch] = FIRST_GRAMMY_WITH_API_CONSTANTS;
    expect(major).toBe(wantMajor);
    const atLeast = minor > wantMinor || (minor === wantMinor && patch >= wantPatch);
    expect(atLeast, `grammY range ${range} admits a release without API_CONSTANTS`).toBe(true);
  });
});

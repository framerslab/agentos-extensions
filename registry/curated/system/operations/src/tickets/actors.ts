/**
 * @fileoverview Who an actor is (D5, D48): a person is `{ accountId, plan }` and a staff member
 * `{ accountId, role }`, as the product's own auth answers them, and the two shapes are disjoint.
 * The package tells them apart by the word each carries, so an object carrying both `plan` and
 * `role`, or neither, is no actor: a product record enriched with a role is refused at once rather
 * than read as staff, and a staff record carrying a plan is refused rather than read as a person.
 */
import type { OpsPerson, OpsStaff } from '../contract.js';

/** The two kinds of actor. */
export type ActorKind = 'person' | 'staff';

const ID_MAX = 128;
const WORD_MAX = 64;

const isWord = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;

/** The kind of `actor`, or null for an object that is neither shape: no account id, both words, or neither. */
export function actorKind(actor: unknown): ActorKind | null {
  if (typeof actor !== 'object' || actor === null) return null;
  const { accountId, plan, role } = actor as { accountId?: unknown; plan?: unknown; role?: unknown };
  if (typeof accountId !== 'string' || accountId.length === 0 || accountId.length > ID_MAX) return null;
  const person = isWord(plan, WORD_MAX);
  const staff = isWord(role, WORD_MAX);
  if (person === staff) return null;
  return person ? 'person' : 'staff';
}

/** Whether `actor` is a person as the contract shapes one: an account id and a plan word, and no role. */
export const isPerson = (actor: unknown): actor is OpsPerson => actorKind(actor) === 'person';

/** Whether `actor` is a staff member as the contract shapes one: an account id and a role word, and no plan. */
export const isStaff = (actor: unknown): actor is OpsStaff => actorKind(actor) === 'staff';

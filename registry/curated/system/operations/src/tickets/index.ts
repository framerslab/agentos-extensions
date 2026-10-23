/**
 * @fileoverview `./tickets`: `Tickets`, the support requests (D8 to D21).
 *
 * This entry exists from the first push so the pack guard can import it; its factory arrives with
 * task 5 and until then throws `not_built` at the call, never at the import.
 */
import { notBuilt } from '../not-built.js';

export function createTickets(): never {
  return notBuilt('tickets', 5);
}

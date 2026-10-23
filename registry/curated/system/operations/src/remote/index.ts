/**
 * @fileoverview `./remote`: the batching sender over `fetch` for a process that holds no database (D2, D30). It imports nothing from the adapter.
 *
 * This entry exists from the first push so the pack guard can import it; its factory arrives with
 * task 6 and until then throws `not_built` at the call, never at the import.
 */
import { notBuilt } from '../not-built.js';

export function createRemote(): never {
  return notBuilt('remote', 6);
}

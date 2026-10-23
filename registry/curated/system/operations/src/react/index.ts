/**
 * @fileoverview `./react`: headless hooks for the pages and the composer, and the sanitized
 * markdown renderer (D39). This entry exists from the first push so the pack guard can import it;
 * the hooks arrive with task 5 and until then throw `not_built` at the call, never at the import.
 */
import { notBuilt } from '../not-built.js';

export function useRequests(): never {
  return notBuilt('react.useRequests', 5);
}

export function useRequest(): never {
  return notBuilt('react.useRequest', 5);
}

export function useStream(): never {
  return notBuilt('react.useStream', 5);
}

export function useComposer(): never {
  return notBuilt('react.useComposer', 5);
}

export function useStaffList(): never {
  return notBuilt('react.useStaffList', 5);
}

export function useStaffRequest(): never {
  return notBuilt('react.useStaffRequest', 5);
}

export function Markdown(): never {
  return notBuilt('react.Markdown', 5);
}

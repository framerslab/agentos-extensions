/**
 * @fileoverview Every string the package stores passes through `clean` first (D26): the control
 * characters go, U+0000 among them, which PostgreSQL refuses in `text` (22021) and in `jsonb`
 * (22P05), so one such byte never fails a flush. Tab, newline and carriage return stay.
 */

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/** `text` without its control characters (U+0000 to U+001F but tab, newline and carriage return, and U+007F to U+009F). */
export function clean(text: string): string {
  return text.replace(CONTROL, '');
}

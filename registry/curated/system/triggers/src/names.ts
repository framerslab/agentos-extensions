/**
 * @fileoverview The job-name rule and the stall watcher's own row, which the scheduler, the
 * reports-only writer and the watcher all read.
 */

/** A job's name: the row's key and the page's address. */
export const NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** The stall watcher's own lease row: kind `scheduled`, never listed, never commanded. A name outside `NAME`, so no job can take it. */
export const WATCH_ROW = '__watch';

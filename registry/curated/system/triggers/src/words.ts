/**
 * @fileoverview `scheduleWords`: the sentence a schedule reads as on a jobs page, in UTC. A product
 * may show its own words instead; these are the package's.
 */
import type { Schedule } from './contract.js';
import { parseCronExpression } from './cron.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const two = (n: number) => String(n).padStart(2, '0');

function everyWords(ms: number): string {
  if (ms % 86_400_000 === 0) return ms === 86_400_000 ? 'Every day' : `Every ${ms / 86_400_000} days`;
  if (ms % 3_600_000 === 0) return ms === 3_600_000 ? 'Every hour' : `Every ${ms / 3_600_000} hours`;
  if (ms % 60_000 === 0) return ms === 60_000 ? 'Every minute' : `Every ${ms / 60_000} minutes`;
  return ms === 1_000 ? 'Every second' : `Every ${Math.round(ms / 1_000)} seconds`;
}

/** The six forms the Jobs page shows: "Every 5 minutes", "Every hour at :40", "Daily at 00:20 UTC", "Weekly on Monday at 08:23 UTC", "Every 8 days", "Once, 4 Nov 09:00 UTC"; any other cron reads "Cron <expr> UTC". */
export function scheduleWords(schedule: Schedule): string {
  if (schedule.kind === 'every') return everyWords(schedule.everyMs);
  if (schedule.kind === 'at') {
    const d = new Date(schedule.at);
    return `Once, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
  }
  const parts = schedule.expr.trim().split(/\s+/);
  const fields = parseCronExpression(schedule.expr);
  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];
  const one = (field: ReadonlySet<number>) => (field.size === 1 ? [...field][0] : undefined);
  const m = one(fields.minutes);
  const h = one(fields.hours);
  const all = hour === '*' && dom === '*' && month === '*' && dow === '*';
  if (minute === '*' && all) return 'Every minute';
  // A step reads as an interval only when it divides the hour: */7 runs at :56 and again at :00, and */60 once an hour.
  const step = /^\*\/\d+$/.test(minute) ? Number(minute.slice(2)) : 0;
  if (all && step > 0 && step < 60 && 60 % step === 0) return step === 1 ? 'Every minute' : `Every ${step} minutes`;
  if (m !== undefined && hour === '*' && dom === '*' && month === '*' && dow === '*') return `Every hour at :${two(m)}`;
  if (m !== undefined && h !== undefined && dom === '*' && month === '*' && dow === '*') return `Daily at ${two(h)}:${two(m)} UTC`;
  if (m !== undefined && h !== undefined && dom === '*' && month === '*' && one(fields.daysOfWeek) !== undefined) {
    return `Weekly on ${DAYS[one(fields.daysOfWeek)!]} at ${two(h)}:${two(m)} UTC`;
  }
  if (m !== undefined && h !== undefined && one(fields.daysOfMonth) !== undefined && month === '*' && dow === '*') {
    return `Monthly on day ${one(fields.daysOfMonth)} at ${two(h)}:${two(m)} UTC`;
  }
  return `Cron ${parts.join(' ')} UTC`;
}

/**
 * The Analytics view a read holds: Figures, Funnel and retention, or Money, drawn from what
 * `readAnalytics` answered. A product renders it inside its own page frame, behind its own staff
 * check, under the views' tab row and range switch it keeps.
 *
 * @module
 */
import type { OpsRange } from '../../contract.js';
import type { FigureSpec } from '../figures.js';
import type { AnalyticsRead } from '../read.js';
import type { AnalyticsWords } from '../words.js';
import { AnalyticsFigures } from './AnalyticsFigures.js';
import { AnalyticsFunnel } from './AnalyticsFunnel.js';
import { AnalyticsMoney } from './AnalyticsMoney.js';

/** Draws the one view `read` holds, over the range asked, today counted live. */
export function AnalyticsPane({ read, specs, plans, range, today, words }: { read: AnalyticsRead; specs: readonly FigureSpec[]; plans: readonly string[]; range: OpsRange; today: number; words: AnalyticsWords }) {
  if (read.view === 'funnel') return <AnalyticsFunnel funnel={read.funnel} retention={read.retention} range={range} today={today} words={words} />;
  if (read.view === 'money') return <AnalyticsMoney money={read.money} range={range} today={today} words={words} />;
  return <AnalyticsFigures figures={read.figures} specs={specs} plans={plans} range={range} today={today} words={words} />;
}

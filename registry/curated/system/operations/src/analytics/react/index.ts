/**
 * `./analytics/react`: the Analytics views as React 19 components, apart from `./react`, whose
 * markdown renderer an analytics page has no use for. Each takes the words as plain data (the
 * English ones from `englishAnalyticsWords` in `./analytics`, or the product's), so a server page
 * hands them to the client parts as a prop; `OpsChart` and `AnalyticsFunnel` are client modules.
 * Their look is `./analytics.css`, set through its `--ops-*` properties.
 *
 * @module
 */
export { AnalyticsFigures, figureDays } from './AnalyticsFigures.js';
export { AnalyticsFunnel } from './AnalyticsFunnel.js';
export { AnalyticsMoney } from './AnalyticsMoney.js';
export { AnalyticsPane } from './AnalyticsPane.js';
export { OpsChart } from './OpsChart.js';
export type { ChartDay, ChartDraw, ChartSeries, OpsChartProps } from './OpsChart.js';

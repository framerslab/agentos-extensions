/**
 * @fileoverview `./analytics`: the framework-free half of the Analytics views. The figure list,
 * the query and address helpers, the formatters, the words and their English defaults, and
 * `readAnalytics`, the server read a product's page makes behind its own staff check. Nothing here
 * imports React or reads a DOM global, so an API route or a test imports it alone.
 */
export { LIFECYCLE_FIGURES, figureOf } from './figures.js';
export type { FigureSpec, FigureUnit } from './figures.js';
export { ANALYTICS_RANGES, ANALYTICS_VIEWS, analyticsHref, analyticsQuery } from './query.js';
export type { AnalyticsQuery, AnalyticsView } from './query.js';
export { DAY_MS, dayStartOf, formatScale, formatValue, scaleTop, shareOf, shortDay } from './format.js';
export { englishAnalyticsWords, fillWords } from './words.js';
export type { AnalyticsWords, FigureWords } from './words.js';
export { readAnalytics } from './read.js';
export type { AnalyticsEvents, AnalyticsRead, FigureRead } from './read.js';

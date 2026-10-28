# @framers/agentos-ext-operations

Releases after 0.1.0 are recorded at https://github.com/framerslab/agentos-extensions/releases, one per tag `@framers/agentos-ext-operations@<version>`.

## 0.1.0

### Minor Changes

- [#375](https://github.com/framerslab/agentos-extensions/pull/375) [`f3e4f09`](https://github.com/framerslab/agentos-extensions/commit/f3e4f09bf05b1910ee347e42cfc15f8f5e7b1dda) Thanks [@jddunn](https://github.com/jddunn)! - The first release of the operations package: a log table with search, an events table with daily totals over the product's own figures, the nightly totals and the hourly retention sweep under try-locks, the field rule every line and event is checked against, and the fifteen tables with their migrations on PostgreSQL and SQLite. Support requests, error capture and health checks ship as typed stubs that throw not_built until the next minor release.

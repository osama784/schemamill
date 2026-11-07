// StrykerJS configuration for @schemamill/core (see docs/mutation-testing.md).
//
// The tap runner drives the package's existing `node:test` suite: one process per test file,
// coverage recorded per test file, so no mutant is ever classified static. `ignoreStatic` is
// therefore inert here; if per-file coverage fan-out ever blows the runtime budget, drop
// `coverageAnalysis` to "all" instead.
export default {
  testRunner: 'tap',
  plugins: ['@stryker-mutator/tap-runner', '@stryker-mutator/typescript-checker'],
  packageManager: 'pnpm',
  mutate: ['src/**/*.ts', '!src/**/*.test.ts'],
  checkers: ['typescript'],
  coverageAnalysis: 'perTest',
  ignoreStatic: true,
  reporters: ['clear-text', 'progress', 'json', 'html'],
  thresholds: { high: 80, low: 60, break: null },
  timeoutMS: 10000,
  timeoutFactor: 2,
  incremental: true,
  ignorePatterns: ['dist', 'reports', '.stryker-tmp'],
};

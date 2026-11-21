import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildDerivedConfig } from './mutation-sanity.mjs';

const REPORT_PATH = 'reports/mutation/check.json';
const MUTATE_SCOPE = 'src/diff.ts:445-449';

// Every overridden key carries a value contrary to what the builder pins, so each assertion is
// falsifiable: the builder must replace the caller's value, not merely preserve it.
const STAND_IN_CONFIG = {
  testRunner: 'tap',
  concurrency: 8,
  reporters: ['html'],
  incremental: true,
  jsonReporter: { fileName: 'reports/mutation/caller.json' },
};

test('buildDerivedConfig pins the scoped overrides and caps concurrency at 2', () => {
  const derived = buildDerivedConfig(STAND_IN_CONFIG, {
    mutateScope: MUTATE_SCOPE,
    reportRelativePath: REPORT_PATH,
  });

  assert.equal(derived.concurrency, 2, 'caller concurrency must be overridden by the cap');
  assert.deepEqual(derived.reporters, ['json']);
  assert.equal(derived.incremental, false);
  assert.deepEqual(derived.mutate, [MUTATE_SCOPE]);
  assert.equal(derived.jsonReporter.fileName, REPORT_PATH);
  // Non-overridden config is carried through by the spread.
  assert.equal(derived.testRunner, 'tap');
});

test('buildDerivedConfig overrides a caller-supplied concurrency unconditionally', () => {
  const derived = buildDerivedConfig(
    { concurrency: 8 },
    {
      mutateScope: MUTATE_SCOPE,
      reportRelativePath: REPORT_PATH,
    },
  );

  assert.equal(derived.concurrency, 2);
});

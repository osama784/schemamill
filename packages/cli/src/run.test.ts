import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Plan } from '@schemamill/core';

import { planOrReport } from './run.ts';

/** A step-free plan: the thunk result needs no core call and carries no payload. */
const EMPTY_PLAN: Plan = { steps: [], groups: [] };

/**
 * Unit tests for the shared command plumbing's plan-time error channel.
 *
 * The catching path — one `schemamill:` line, empty stdout, exit 1 — is pinned end to end by
 * `cli.test.ts`; this test pins the narrow catch's other two obligations with stub thunks: a
 * plan passes straight through, and an unexpected error propagates instead of being reported.
 */
test('planOrReport returns the plan and rethrows unexpected errors', () => {
  assert.equal(
    planOrReport(() => EMPTY_PLAN),
    EMPTY_PLAN,
  );
  assert.throws(
    () =>
      planOrReport(() => {
        throw new Error('boom');
      }),
    { message: 'boom' },
  );
});

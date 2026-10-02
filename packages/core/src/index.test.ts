import assert from 'node:assert/strict';
import { test } from 'node:test';

import { version } from './index.ts';
import type { CheckConstraint, Index, UniqueConstraint } from './index.ts';

test('version is a semver string', () => {
  assert.match(version, /^\d+\.\d+\.\d+$/);
});

test('the barrel exports the constraint and index model types', () => {
  const uniqueConstraint: UniqueConstraint = { name: 't_email_key', columns: ['email'] };
  const checkConstraint: CheckConstraint = { expression: 'length(email) > 0' };
  const index: Index = { name: 't_email_idx', unique: false, columns: ['email'] };

  assert.deepStrictEqual(
    [uniqueConstraint, checkConstraint, index],
    [
      { name: 't_email_key', columns: ['email'] },
      { expression: 'length(email) > 0' },
      { name: 't_email_idx', unique: false, columns: ['email'] },
    ],
  );
});

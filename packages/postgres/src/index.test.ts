import assert from 'node:assert/strict';
import { test } from 'node:test';

import { coreVersionUsed, dialect } from './index.ts';

test('postgres adapter resolves the core package', () => {
  assert.equal(dialect, 'postgres');
  assert.match(coreVersionUsed, /^\d+\.\d+\.\d+$/);
});

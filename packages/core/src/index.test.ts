import assert from 'node:assert/strict';
import { test } from 'node:test';

import { version } from './index.ts';

test('version is a semver string', () => {
  assert.match(version, /^\d+\.\d+\.\d+$/);
});

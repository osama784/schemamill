import assert from 'node:assert/strict';
import { test } from 'node:test';

import { version } from '@schemamill/core';
import { dialect, version as postgresVersion } from '@schemamill/postgres';

test('resolves @schemamill/core through the workspace', () => {
  assert.match(version, /^\d+\.\d+\.\d+$/);
});

test('resolves @schemamill/postgres through the workspace', () => {
  assert.equal(dialect, 'postgres');
  assert.match(postgresVersion, /^\d+\.\d+\.\d+$/);
});

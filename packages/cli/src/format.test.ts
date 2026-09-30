import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Change } from '@schemamill/core';

import { formatChanges } from './format.ts';

/**
 * Tests for the `compare` rendering: the converted-bound wording on a sequence or identity
 * type conversion, where the diff reports the value in effect after the engine's conversion
 * rather than the as-written baseline value, and the identity change lines.
 */

test('a converted sequence bound prints with the converted mark', () => {
  const changes: readonly Change[] = [
    {
      kind: 'sequence-changed',
      sequence: { schema: 'public', name: 's' },
      changes: [
        { field: 'dataType', before: 'integer', after: 'bigint' },
        { field: 'maxValue', before: '9223372036854775807', after: '2147483647', converted: true },
      ],
    },
  ];

  assert.equal(
    formatChanges(changes),
    [
      '~ sequence public.s',
      '    data type integer → bigint',
      '    max value 9223372036854775807 (converted) → 2147483647',
      '',
    ].join('\n'),
  );
});

test('an as-written sequence bound prints without the converted mark', () => {
  const changes: readonly Change[] = [
    {
      kind: 'sequence-changed',
      sequence: { schema: 'public', name: 's' },
      changes: [
        { field: 'minValue', before: '-2147483648', after: '-100' },
        { field: 'maxValue', before: '2147483647', after: '100' },
      ],
    },
  ];

  assert.equal(
    formatChanges(changes),
    [
      '~ sequence public.s',
      '    min value -2147483648 → -100',
      '    max value 2147483647 → 100',
      '',
    ].join('\n'),
  );
});

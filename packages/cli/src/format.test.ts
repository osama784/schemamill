import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Change, Identity, IdentityChange, Plan } from '@schemamill/core';

import { formatChanges, formatPlan } from './format.ts';

/**
 * Tests for the CLI renderings: the converted-bound wording on a sequence or identity type
 * conversion, where the diff reports the value in effect after the engine's conversion rather
 * than the as-written baseline value; the identity change lines; and the identity plan steps.
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

test('an identity change prints after the column fields, one sub-line per field', () => {
  const changes: readonly Change[] = [
    {
      kind: 'table-changed',
      table: { schema: 'public', name: 'users' },
      changes: [
        {
          kind: 'column-changed',
          name: 'id',
          fields: [{ field: 'type', before: 'integer', after: 'bigint' }],
          identity: {
            kind: 'changed',
            fields: [
              { field: 'generated', before: 'always', after: 'by default' },
              {
                field: 'maxValue',
                before: '9223372036854775807',
                after: '2147483647',
                converted: true,
              },
            ],
          },
        },
      ],
    },
  ];

  assert.equal(
    formatChanges(changes),
    [
      '~ table public.users',
      '    ~ column id: type integer → bigint',
      '        identity: GENERATED ALWAYS → BY DEFAULT',
      '        identity: max value 9223372036854775807 (converted) → 2147483647',
      '',
    ].join('\n'),
  );
});

test('identity additions, removals, and recreations print as marker lines', () => {
  const descriptor: Identity = {
    generated: 'always',
    increment: '1',
    minValue: '1',
    maxValue: '9223372036854775807',
    start: '1',
    cache: '1',
    cycle: false,
  };
  const change = (identity: IdentityChange): Change => ({
    kind: 'table-changed',
    table: { schema: 'public', name: 'users' },
    changes: [{ kind: 'column-changed', name: 'id', fields: [], identity }],
  });

  assert.equal(
    formatChanges([change({ kind: 'added', identity: descriptor })]),
    ['~ table public.users', '    ~ column id: identity: added', ''].join('\n'),
  );
  assert.equal(
    formatChanges([change({ kind: 'removed', identity: descriptor })]),
    ['~ table public.users', '    ~ column id: identity: removed', ''].join('\n'),
  );
  assert.equal(
    formatChanges([change({ kind: 'recreated', identity: descriptor })]),
    ['~ table public.users', '    ~ column id: identity: recreated', ''].join('\n'),
  );
});

test('identity plan steps print the column and the changed options', () => {
  const descriptor: Identity = {
    generated: 'always',
    increment: '1',
    minValue: '1',
    maxValue: '2147483647',
    start: '1',
    cache: '1',
    cycle: false,
  };
  const plan: Plan = {
    steps: [
      {
        kind: 'add-identity',
        table: { schema: 'public', name: 'users' },
        name: 'id',
        identity: descriptor,
      },
      {
        kind: 'alter-identity',
        table: { schema: 'public', name: 'users' },
        name: 'id',
        fields: [{ field: 'increment', before: '1', after: '2' }],
      },
      { kind: 'drop-identity', table: { schema: 'public', name: 'users' }, name: 'id' },
    ],
  };

  assert.equal(
    formatPlan(plan),
    [
      '3 steps:',
      ' 1. add-identity    public.users.id',
      ' 2. alter-identity  public.users.id: increment 1 → 2',
      ' 3. drop-identity   public.users.id',
      '',
    ].join('\n'),
  );
});

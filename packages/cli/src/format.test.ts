import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Change, Hazard, Identity, IdentityChange, Plan } from '@schemamill/core';

import { formatChanges, formatHazards, formatPlan } from './format.ts';

/**
 * Tests for the CLI renderings: the converted-bound wording on a sequence or identity type
 * conversion, where the diff reports the value in effect after the engine's conversion rather
 * than the as-written baseline value; the identity change lines; the identity plan steps and
 * the plan header's one-transaction wording; and the hazard clauses.
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
    groups: [{ start: 0, end: 3, transactional: true }],
  };

  assert.equal(
    formatPlan(plan),
    [
      '3 steps in one transaction:',
      ' 1. add-identity    public.users.id',
      ' 2. alter-identity  public.users.id: increment 1 → 2',
      ' 3. drop-identity   public.users.id',
      '',
    ].join('\n'),
  );
});

test('a one-step plan names its single transaction in the singular', () => {
  const plan: Plan = {
    steps: [{ kind: 'drop-table', table: { schema: 'public', name: 'gone' } }],
    groups: [{ start: 0, end: 1, transactional: true }],
  };

  assert.equal(
    formatPlan(plan),
    ['1 step in one transaction:', ' 1. drop-table  public.gone', ''].join('\n'),
  );
});

test('a single standalone step says it runs outside a transaction', () => {
  const plan: Plan = {
    steps: [{ kind: 'drop-table', table: { schema: 'public', name: 'a' } }],
    groups: [{ start: 0, end: 1, transactional: false }],
  };

  assert.equal(
    formatPlan(plan),
    ['1 step outside a transaction:', ' 1. drop-table  public.a', ''].join('\n'),
  );
});

test('an empty plan still says there are no changes', () => {
  assert.equal(formatPlan({ steps: [], groups: [] }), 'No changes.\n');
});

test('a multi-group plan names each group and numbers its steps continuously', () => {
  const plan: Plan = {
    steps: [
      { kind: 'drop-table', table: { schema: 'public', name: 'a' } },
      {
        kind: 'drop-index-concurrently',
        table: { schema: 'public', name: 'a' },
        index: { name: 'a_id_idx', unique: false, columns: ['id'] },
      },
      { kind: 'drop-table', table: { schema: 'public', name: 'b' } },
      {
        kind: 'create-index-concurrently',
        table: { schema: 'public', name: 'b' },
        index: { name: 'b_id_idx', unique: false, columns: ['id'] },
      },
    ],
    groups: [
      { start: 0, end: 1, transactional: true },
      { start: 1, end: 2, transactional: false },
      { start: 2, end: 3, transactional: true },
      { start: 3, end: 4, transactional: false },
    ],
  };

  assert.equal(
    formatPlan(plan),
    [
      '4 steps in 4 groups:',
      '  group 1 of 4:',
      '    1. drop-table                 public.a',
      '  group 2 of 4 (standalone):',
      '    2. drop-index-concurrently    public.a: index a_id_idx (id)',
      '  group 3 of 4:',
      '    3. drop-table                 public.b',
      '  group 4 of 4 (standalone):',
      '    4. create-index-concurrently  public.b: index b_id_idx (id)',
      '',
    ].join('\n'),
  );
});

test('added and removed columns and added tables surface an identity column', () => {
  const always: Identity = {
    generated: 'always',
    increment: '1',
    minValue: '1',
    maxValue: '2147483647',
    start: '1',
    cache: '1',
    cycle: false,
  };
  const byDefault: Identity = { ...always, generated: 'by default' };

  const changes: readonly Change[] = [
    {
      kind: 'table-added',
      table: {
        schema: 'public',
        name: 'added',
        columns: [{ name: 'id', type: 'integer', notNull: true, identity: byDefault }],
        foreignKeys: [],
        uniqueConstraints: [],
        checkConstraints: [],
        indexes: [],
      },
    },
    {
      kind: 'table-changed',
      table: { schema: 'public', name: 'kept' },
      changes: [
        {
          kind: 'column-added',
          column: { name: 'fresh', type: 'integer', notNull: true, identity: always },
        },
        {
          kind: 'column-removed',
          column: { name: 'gone', type: 'integer', notNull: true, identity: always },
        },
      ],
    },
  ];

  assert.equal(
    formatChanges(changes),
    [
      '+ table public.added',
      '    id integer NOT NULL identity: GENERATED BY DEFAULT',
      '',
      '~ table public.kept',
      '    + column fresh integer NOT NULL identity: GENERATED ALWAYS',
      '    - column gone integer NOT NULL identity: GENERATED ALWAYS',
      '',
    ].join('\n'),
  );
});

test('constraint and index plan steps print the table and the constrained member', () => {
  const plan: Plan = {
    steps: [
      {
        kind: 'drop-index',
        table: { schema: 'public', name: 'users' },
        index: { name: 'users_email_idx', unique: false, columns: ['email'] },
      },
      {
        kind: 'drop-index-concurrently',
        table: { schema: 'public', name: 'users' },
        index: { name: 'users_age_idx', unique: false, columns: ['age'] },
      },
      {
        kind: 'drop-check-constraint',
        table: { schema: 'public', name: 'users' },
        checkConstraint: { name: 'users_age_check', expression: 'age >= 18' },
      },
      {
        kind: 'drop-unique-constraint',
        table: { schema: 'public', name: 'users' },
        uniqueConstraint: { name: 'users_email_key', columns: ['email'] },
      },
      {
        kind: 'add-unique-constraint',
        table: { schema: 'public', name: 'users' },
        uniqueConstraint: { columns: ['nickname'] },
      },
      {
        kind: 'add-check-constraint',
        table: { schema: 'public', name: 'users' },
        checkConstraint: { expression: 'age >= 0' },
      },
      {
        kind: 'create-index',
        table: { schema: 'public', name: 'users' },
        index: { name: 'users_name_idx', unique: false, columns: ['name'] },
      },
      {
        kind: 'create-index-concurrently',
        table: { schema: 'public', name: 'users' },
        index: { name: 'users_name_idx_v2', unique: true, columns: ['name'] },
      },
    ],
    groups: [
      { start: 0, end: 1, transactional: true },
      { start: 1, end: 2, transactional: false },
      { start: 2, end: 7, transactional: true },
      { start: 7, end: 8, transactional: false },
    ],
  };

  assert.equal(
    formatPlan(plan),
    [
      '8 steps in 4 groups:',
      '  group 1 of 4:',
      '    1. drop-index                 public.users: index users_email_idx (email)',
      '  group 2 of 4 (standalone):',
      '    2. drop-index-concurrently    public.users: index users_age_idx (age)',
      '  group 3 of 4:',
      '    3. drop-check-constraint      public.users: check constraint users_age_check CHECK (age >= 18)',
      '    4. drop-unique-constraint     public.users: unique constraint users_email_key (email)',
      '    5. add-unique-constraint      public.users: unique constraint (nickname)',
      '    6. add-check-constraint       public.users: check constraint CHECK (age >= 0)',
      '    7. create-index               public.users: index users_name_idx (name)',
      '  group 4 of 4 (standalone):',
      '    8. create-index-concurrently  public.users: unique index users_name_idx_v2 (name)',
      '',
    ].join('\n'),
  );
});

test('constraint and index member changes print in the diff vocabulary', () => {
  const changes: readonly Change[] = [
    {
      kind: 'table-changed',
      table: { schema: 'public', name: 'users' },
      changes: [
        {
          kind: 'unique-constraint-removed',
          uniqueConstraint: { name: 'users_email_key', columns: ['email'] },
        },
        {
          kind: 'unique-constraint-added',
          uniqueConstraint: { columns: ['nickname'] },
        },
        {
          kind: 'unique-constraint-changed',
          before: { name: 'users_name_key', columns: ['name'] },
          after: { name: 'users_name_key_v2', columns: ['name'] },
        },
        {
          kind: 'check-constraint-removed',
          checkConstraint: { name: 'users_age_check', expression: 'age >= 18' },
        },
        {
          kind: 'check-constraint-added',
          checkConstraint: { expression: 'age >= 0' },
        },
        {
          kind: 'check-constraint-changed',
          before: { name: 'users_note_check', expression: "note <> ''" },
          after: { expression: "note <> ''" },
        },
        {
          kind: 'index-removed',
          index: { name: 'users_age_idx', unique: false, columns: ['age'] },
        },
        {
          kind: 'index-added',
          index: { unique: true, columns: ['nickname'] },
        },
        {
          kind: 'index-changed',
          before: { name: 'users_email_idx', unique: false, columns: ['email'] },
          after: { name: 'users_email_idx', unique: true, columns: ['email', 'id'] },
        },
      ],
    },
  ];

  assert.equal(
    formatChanges(changes),
    [
      '~ table public.users',
      '    - unique constraint users_email_key (email)',
      '    + unique constraint (nickname)',
      '    ~ unique constraint (name): name users_name_key → users_name_key_v2',
      '    - check constraint users_age_check CHECK (age >= 18)',
      '    + check constraint CHECK (age >= 0)',
      "    ~ check constraint (note <> ''): name users_note_check → (none)",
      '    - index users_age_idx (age)',
      '    + unique index (nickname)',
      '    ~ index users_email_idx: unique false → true, columns (email) → (email, id)',
      '',
    ].join('\n'),
  );
});

test('added and removed tables list their constraints and indexes', () => {
  const changes: readonly Change[] = [
    {
      kind: 'table-added',
      table: {
        schema: 'public',
        name: 'added',
        columns: [{ name: 'id', type: 'integer', notNull: true }],
        primaryKey: { name: 'added_pkey', columns: ['id'] },
        foreignKeys: [],
        uniqueConstraints: [{ name: 'added_code_key', columns: ['code'] }],
        checkConstraints: [{ name: 'added_code_check', expression: "code <> ''" }],
        indexes: [{ name: 'added_code_idx', unique: true, columns: ['code'] }],
      },
    },
    {
      kind: 'table-removed',
      table: {
        schema: 'public',
        name: 'gone',
        columns: [{ name: 'id', type: 'integer', notNull: true }],
        foreignKeys: [],
        uniqueConstraints: [],
        checkConstraints: [],
        indexes: [{ name: 'gone_id_idx', unique: false, columns: ['id'] }],
      },
    },
  ];

  assert.equal(
    formatChanges(changes),
    [
      '+ table public.added',
      '    id integer NOT NULL',
      '    primary key added_pkey (id)',
      '    unique constraint added_code_key (code)',
      "    check constraint added_code_check CHECK (code <> '')",
      '    unique index added_code_idx (code)',
      '',
      '- table public.gone',
      '    id integer NOT NULL',
      '    index gone_id_idx (id)',
      '',
    ].join('\n'),
  );
});

test('an increment-zero hazard states the rejection at apply', () => {
  assert.equal(
    formatHazards([{ kind: 'increment-zero', step: 0, increment: '0' }]),
    [
      'Hazards:',
      '  step 1 increment-zero: INCREMENT 0 — PostgreSQL rejects this at apply (INCREMENT must not be zero).',
      '',
    ].join('\n'),
  );
});

test('a cache-nonpositive hazard states the rejection at apply with the actual cache', () => {
  const cache = (value: string): Hazard => ({ kind: 'cache-nonpositive', step: 0, cache: value });

  assert.equal(
    formatHazards([cache('0')]),
    [
      'Hazards:',
      '  step 1 cache-nonpositive: CACHE 0 — PostgreSQL rejects this at apply (CACHE (0) must be greater than zero).',
      '',
    ].join('\n'),
  );
  assert.equal(
    formatHazards([cache('-5')]),
    [
      'Hazards:',
      '  step 1 cache-nonpositive: CACHE -5 — PostgreSQL rejects this at apply (CACHE (-5) must be greater than zero).',
      '',
    ].join('\n'),
  );
});

test('a bounds-inverted hazard states the rejection at apply with both bounds', () => {
  assert.equal(
    formatHazards([{ kind: 'bounds-inverted', step: 0, minValue: '100', maxValue: '100' }]),
    [
      'Hazards:',
      '  step 1 bounds-inverted: MINVALUE 100 must be less than MAXVALUE 100 — PostgreSQL rejects this at apply.',
      '',
    ].join('\n'),
  );
  assert.equal(
    formatHazards([{ kind: 'bounds-inverted', step: 0, minValue: '500', maxValue: '100' }]),
    [
      'Hazards:',
      '  step 1 bounds-inverted: MINVALUE 500 must be less than MAXVALUE 100 — PostgreSQL rejects this at apply.',
      '',
    ].join('\n'),
  );
});

test('a start-out-of-bounds hazard names the edge the start crosses', () => {
  const outOfBounds = (start: string, minValue: string, maxValue: string): Hazard => ({
    kind: 'start-out-of-bounds',
    step: 0,
    start,
    minValue,
    maxValue,
  });

  assert.equal(
    formatHazards([outOfBounds('100', '1', '50')]),
    [
      'Hazards:',
      '  step 1 start-out-of-bounds: START 100 is greater than MAXVALUE 50 — PostgreSQL rejects this at apply.',
      '',
    ].join('\n'),
  );
  assert.equal(
    formatHazards([outOfBounds('-100', '0', '100')]),
    [
      'Hazards:',
      '  step 1 start-out-of-bounds: START -100 is less than MINVALUE 0 — PostgreSQL rejects this at apply.',
      '',
    ].join('\n'),
  );
});

test('a bound-out-of-type-range hazard names the bound, value, and data type', () => {
  const outOfRange = (
    field: 'min' | 'max',
    value: string,
    dataType: 'smallint' | 'integer' | 'bigint',
  ): Hazard => ({ kind: 'bound-out-of-type-range', step: 0, dataType, field, value });

  assert.equal(
    formatHazards([outOfRange('max', '9999999999', 'integer')]),
    [
      'Hazards:',
      '  step 1 bound-out-of-type-range: MAXVALUE 9999999999 is out of range for sequence data type integer — PostgreSQL rejects this at apply.',
      '',
    ].join('\n'),
  );
  assert.equal(
    formatHazards([outOfRange('min', '-32769', 'smallint')]),
    [
      'Hazards:',
      '  step 1 bound-out-of-type-range: MINVALUE -32769 is out of range for sequence data type smallint — PostgreSQL rejects this at apply.',
      '',
    ].join('\n'),
  );
});

test('a bound-tightened hazard names the field, both values, and the unmodeled state', () => {
  const tightened = (field: 'min' | 'max', before: string, after: string): Hazard => ({
    kind: 'bound-tightened',
    step: 0,
    field,
    before,
    after,
  });

  assert.equal(
    formatHazards([tightened('max', '2147483647', '99')]),
    [
      'Hazards:',
      "  step 1 bound-tightened: max value 2147483647 → 99 — may fail at apply; PostgreSQL cross-checks the sequence's current value against the tightened bound, and sequence state is not modeled.",
      '',
    ].join('\n'),
  );
  assert.equal(
    formatHazards([tightened('min', '1', '10')]),
    [
      'Hazards:',
      "  step 1 bound-tightened: min value 1 → 10 — may fail at apply; PostgreSQL cross-checks the sequence's current value against the tightened bound, and sequence state is not modeled.",
      '',
    ].join('\n'),
  );
});

test('multiple hazards render in payload order, numbered by their step', () => {
  const hazards: readonly Hazard[] = [
    { kind: 'cache-nonpositive', step: 4, cache: '0' },
    { kind: 'increment-zero', step: 0, increment: '0' },
    { kind: 'bound-tightened', step: 11, field: 'max', before: '2147483647', after: '99' },
  ];

  assert.equal(
    formatHazards(hazards),
    [
      'Hazards:',
      '  step 5 cache-nonpositive: CACHE 0 — PostgreSQL rejects this at apply (CACHE (0) must be greater than zero).',
      '  step 1 increment-zero: INCREMENT 0 — PostgreSQL rejects this at apply (INCREMENT must not be zero).',
      "  step 12 bound-tightened: max value 2147483647 → 99 — may fail at apply; PostgreSQL cross-checks the sequence's current value against the tightened bound, and sequence state is not modeled.",
      '',
    ].join('\n'),
  );
});

test('no hazards render as the header alone', () => {
  assert.equal(formatHazards([]), 'Hazards:\n');
});

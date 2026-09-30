import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canonicalIntType,
  defaultSequenceMax,
  defaultSequenceMin,
  effectiveIdentity,
} from './index.ts';
import type { Identity, IdentityInput, SequenceDataType, SequenceIdentity } from './index.ts';

/**
 * Tests for identity column option normalization: the defaults PostgreSQL applies at creation,
 * the direction-dependent bounds, exact 64-bit decimal values, the admissible integer types, and
 * that the returned descriptor is an independent copy.
 */

/** A shallowly mutable view of `T`, for exercising copy independence in tests. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Asserts that `effectiveIdentity(dataType, input)` equals `expected` exactly. */
const assertEffective = (
  dataType: SequenceDataType,
  input: IdentityInput,
  expected: Identity,
): void => {
  assert.deepStrictEqual(effectiveIdentity(dataType, input), expected);
};

test('omitted options normalize to the ascending bigint defaults', () => {
  assertEffective(
    'bigint',
    { generated: 'always' },
    {
      generated: 'always',
      increment: '1',
      minValue: '1',
      maxValue: '9223372036854775807',
      start: '1',
      cache: '1',
      cycle: false,
    },
  );
});

test('explicit values equal to the defaults normalize identically', () => {
  for (const increment of ['1', '-1']) {
    const minValue = defaultSequenceMin('bigint', increment);
    const maxValue = defaultSequenceMax('bigint', increment);
    const explicit = effectiveIdentity('bigint', {
      generated: 'by default',
      increment,
      minValue,
      maxValue,
      start: BigInt(increment) > 0n ? minValue : maxValue,
      cache: '1',
      cycle: false,
    });
    const omitted = effectiveIdentity('bigint', { generated: 'by default', increment });

    assert.deepStrictEqual(explicit, omitted);
  }
});

test('descending identities default to the type minimum, -1, and that maximum', () => {
  assertEffective(
    'bigint',
    { generated: 'by default', increment: '-2' },
    {
      generated: 'by default',
      increment: '-2',
      minValue: '-9223372036854775808',
      maxValue: '-1',
      start: '-1',
      cache: '1',
      cycle: false,
    },
  );
});

test('the defaults follow the column type, in both directions', () => {
  const types = [
    { dataType: 'smallint', min: '-32768', max: '32767' },
    { dataType: 'integer', min: '-2147483648', max: '2147483647' },
    { dataType: 'bigint', min: '-9223372036854775808', max: '9223372036854775807' },
  ] as const;

  for (const { dataType, min, max } of types) {
    const ascending = effectiveIdentity(dataType, { generated: 'always' });
    assert.deepStrictEqual(
      { minValue: ascending.minValue, maxValue: ascending.maxValue, start: ascending.start },
      { minValue: '1', maxValue: max, start: '1' },
    );

    const descending = effectiveIdentity(dataType, { generated: 'always', increment: '-1' });
    assert.deepStrictEqual(
      {
        minValue: descending.minValue,
        maxValue: descending.maxValue,
        start: descending.start,
      },
      { minValue: min, maxValue: '-1', start: '-1' },
    );
  }
});

test('exact 64-bit values survive normalization untouched', () => {
  const identity = effectiveIdentity('bigint', {
    generated: 'by default',
    maxValue: '9223372036854775807',
    start: '9007199254740993',
    minValue: '-9223372036854775808',
    cache: '2147483647',
  });

  // 9007199254740993 is 2^53 + 1: one past the last exact integer in a JavaScript number.
  assert.equal(identity.maxValue, '9223372036854775807');
  assert.equal(identity.start, '9007199254740993');
  assert.equal(identity.minValue, '-9223372036854775808');
  assert.equal(identity.cache, '2147483647');
  // A JavaScript number would have rounded the start value down.
  assert.equal(Number(identity.start), 9007199254740992);
});

test('numeric strings are canonicalized without passing through a number', () => {
  const identity = effectiveIdentity('bigint', {
    generated: 'by default',
    increment: '+1',
    minValue: '001',
    maxValue: '0009223372036854775807',
    start: '1',
    cache: '1',
  });

  assert.equal(identity.increment, '1');
  assert.equal(identity.minValue, '1');
  assert.equal(identity.maxValue, '9223372036854775807');
});

test('canonicalIntType maps the integer spellings and rejects everything else', () => {
  assert.equal(canonicalIntType('smallint'), 'smallint');
  assert.equal(canonicalIntType('int2'), 'smallint');
  assert.equal(canonicalIntType('INT2'), 'smallint');
  assert.equal(canonicalIntType('integer'), 'integer');
  assert.equal(canonicalIntType('int'), 'integer');
  assert.equal(canonicalIntType('Int4'), 'integer');
  assert.equal(canonicalIntType('bigint'), 'bigint');
  assert.equal(canonicalIntType('INT8'), 'bigint');
  assert.equal(canonicalIntType('pg_catalog.int2'), 'smallint');
  assert.equal(canonicalIntType('pg_catalog.integer'), 'integer');
  assert.equal(canonicalIntType('PG_CATALOG.INT8'), 'bigint');
  assert.equal(canonicalIntType('Pg_Catalog.Int'), 'integer');

  // Only the bare integer type names qualify: other types, qualified names, and empty input do
  // not, however integer-like they look.
  const rejected = [
    'numeric',
    'text',
    'real',
    'double precision',
    'public.int8',
    'pg_catalog.numeric',
    'pg_catalog.',
    '',
  ];
  for (const type of rejected) {
    assert.equal(canonicalIntType(type), undefined);
  }
});

test('a stated sequence name passes through unchanged', () => {
  const sequenceName: SequenceIdentity = { schema: 'app', name: 'users_id_seq' };
  const identity = effectiveIdentity('integer', { generated: 'always', sequenceName });

  assert.deepStrictEqual(identity.sequenceName, { schema: 'app', name: 'users_id_seq' });

  const unnamed = effectiveIdentity('integer', { generated: 'always' });
  assert.equal(unnamed.sequenceName, undefined);
});

test('normalization is idempotent and copies its sequence name', () => {
  const input: IdentityInput = {
    generated: 'always',
    increment: '-1',
    cycle: true,
    sequenceName: { schema: 'app', name: 'users_id_seq' },
  };
  const sequenceName = input.sequenceName!;
  Object.freeze(input);
  Object.freeze(sequenceName);

  const once = effectiveIdentity('smallint', input);
  const twice = effectiveIdentity('smallint', once);

  assert.deepStrictEqual(twice, once);
  assert.notEqual(once.sequenceName, sequenceName);
});

test('mutating the input or the result never reaches the other side', () => {
  const input: IdentityInput = {
    generated: 'by default',
    sequenceName: { schema: 'app', name: 'users_id_seq' },
  };
  const identity = effectiveIdentity('bigint', input);
  const copy = { ...identity, sequenceName: { ...identity.sequenceName } };

  // Mutating the input, its options, and its nested name leaves the result as it was.
  const mutableInput = input as Mutable<IdentityInput>;
  mutableInput.increment = '7';
  (input.sequenceName as Mutable<SequenceIdentity>).name = 'changed';
  assert.deepStrictEqual(identity, copy);

  // And mutating the result, its options, and its nested name leaves the input as it was.
  const mutableIdentity = identity as Mutable<Identity>;
  mutableIdentity.increment = '9';
  (identity.sequenceName as Mutable<SequenceIdentity>).name = 'other';
  assert.equal(input.increment, '7');
  assert.equal(input.generated, 'by default');
  assert.deepStrictEqual(input.sequenceName, { schema: 'app', name: 'changed' });
});

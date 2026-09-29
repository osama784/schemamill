import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  defaultSequenceMax,
  defaultSequenceMin,
  effectiveSequence,
  sequenceTypeBounds,
} from './index.ts';
import type { Sequence, SequenceInput } from './index.ts';

/**
 * Tests for sequence option normalization: the defaults PostgreSQL applies at creation, the
 * direction-dependent bounds, exact 64-bit decimal values, and that an omitted option and its
 * explicit default resolve to the same sequence.
 */

/** Asserts that `effectiveSequence(input)` equals `expected` exactly. */
const assertEffective = (input: SequenceInput, expected: Sequence): void => {
  assert.deepStrictEqual(effectiveSequence(input), expected);
};

/** A copy of `sequence` missing `fields`, standing in for a sparse model payload. */
const without = (sequence: Sequence, ...fields: readonly (keyof Sequence)[]): SequenceInput => {
  const copy: Record<string, unknown> = { ...sequence };
  for (const field of fields) delete copy[field];
  return copy as unknown as SequenceInput;
};

test('omitted options normalize to the ascending bigint defaults', () => {
  assertEffective(
    { schema: 'public', name: 's' },
    {
      schema: 'public',
      name: 's',
      dataType: 'bigint',
      increment: '1',
      minValue: '1',
      maxValue: '9223372036854775807',
      start: '1',
      cache: '1',
      cycle: false,
    },
  );
});

test('an explicit default and an omitted option normalize identically', () => {
  const omitted = effectiveSequence({ schema: 'public', name: 's' });
  const explicit = effectiveSequence({
    schema: 'public',
    name: 's',
    dataType: 'bigint',
    increment: '1',
    minValue: '1',
    maxValue: '9223372036854775807',
    start: '1',
    cache: '1',
    cycle: false,
  });

  assert.deepStrictEqual(explicit, omitted);
});

test('descending sequences default to the type minimum, -1, and that maximum', () => {
  assertEffective(
    { schema: 'public', name: 's', increment: '-2' },
    {
      schema: 'public',
      name: 's',
      dataType: 'bigint',
      increment: '-2',
      minValue: '-9223372036854775808',
      maxValue: '-1',
      start: '-1',
      cache: '1',
      cycle: false,
    },
  );
});

test('each data type has its own bounds, in both directions', () => {
  const types = [
    { dataType: 'smallint', min: '-32768', max: '32767' },
    { dataType: 'integer', min: '-2147483648', max: '2147483647' },
    { dataType: 'bigint', min: '-9223372036854775808', max: '9223372036854775807' },
  ] as const;

  for (const { dataType, min, max } of types) {
    assert.deepStrictEqual(sequenceTypeBounds(dataType), {
      minValue: min,
      maxValue: max,
    });

    const ascending = effectiveSequence({ schema: 'public', name: 's', dataType });
    assert.deepStrictEqual(
      { minValue: ascending.minValue, maxValue: ascending.maxValue, start: ascending.start },
      { minValue: '1', maxValue: max, start: '1' },
    );

    const descending = effectiveSequence({
      schema: 'public',
      name: 's',
      dataType,
      increment: '-1',
    });
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
  const sequence = effectiveSequence({
    schema: 'public',
    name: 's',
    maxValue: '9223372036854775807',
    start: '9007199254740993',
    minValue: '-9223372036854775808',
    cache: '2147483647',
  });

  // 9007199254740993 is 2^53 + 1: one past the last exact integer in a JavaScript number.
  assert.equal(sequence.maxValue, '9223372036854775807');
  assert.equal(sequence.start, '9007199254740993');
  assert.equal(sequence.minValue, '-9223372036854775808');
  assert.equal(sequence.cache, '2147483647');
  // A JavaScript number would have rounded the start value down.
  assert.equal(Number(sequence.start), 9007199254740992);
});

test('numeric strings are canonicalized without passing through a number', () => {
  const sequence = effectiveSequence({
    schema: 'public',
    name: 's',
    increment: '+1',
    minValue: '001',
    maxValue: '0009223372036854775807',
    start: '1',
    cache: '1',
  });

  assert.equal(sequence.increment, '1');
  assert.equal(sequence.minValue, '1');
  assert.equal(sequence.maxValue, '9223372036854775807');
});

test('NO MINVALUE and NO MAXVALUE resolve to the direction-dependent defaults', () => {
  for (const increment of ['1', '-1']) {
    const explicit = effectiveSequence({
      schema: 'public',
      name: 's',
      increment,
      minValue: defaultSequenceMin('bigint', increment),
      maxValue: defaultSequenceMax('bigint', increment),
    });
    const omitted = effectiveSequence({ schema: 'public', name: 's', increment });
    assert.deepStrictEqual(explicit, omitted);
  }
});

test('start follows the resolved bounds when it is omitted', () => {
  const ascending = effectiveSequence({
    schema: 'public',
    name: 's',
    minValue: '5',
    maxValue: '10',
  });
  assert.equal(ascending.start, '5');

  const descending = effectiveSequence({
    schema: 'public',
    name: 's',
    increment: '-1',
    minValue: '-10',
    maxValue: '-5',
  });
  assert.equal(descending.start, '-5');

  // An explicit start wins over both directions.
  const explicit = effectiveSequence({
    schema: 'public',
    name: 's',
    minValue: '5',
    maxValue: '10',
    start: '7',
  });
  assert.equal(explicit.start, '7');
});

test('normalization is idempotent and copies its ownership', () => {
  const input: SequenceInput = {
    schema: 'app',
    name: 's',
    dataType: 'smallint',
    increment: '-1',
    cycle: true,
    ownedBy: { table: { schema: 'app', name: 't' }, column: 'id' },
  };
  const ownedBy = input.ownedBy!;
  Object.freeze(input);
  Object.freeze(ownedBy);
  Object.freeze(ownedBy.table);

  const once = effectiveSequence(input);
  const twice = effectiveSequence(once);

  assert.deepStrictEqual(twice, once);
  assert.notEqual(once.ownedBy, ownedBy);
  assert.notEqual(once.ownedBy?.table, ownedBy.table);
});

test('a sparse payload normalizes the same as an effective sequence', () => {
  const full = effectiveSequence({ schema: 'public', name: 's' });

  assert.deepStrictEqual(effectiveSequence(without(full, 'minValue', 'maxValue')), full);
  assert.deepStrictEqual(effectiveSequence(without(full, 'start', 'cache', 'cycle')), full);
  assert.deepStrictEqual(effectiveSequence(without(full, 'dataType', 'increment')), full);
});

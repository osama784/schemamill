import assert from 'node:assert/strict';
import { test } from 'node:test';

import { effectiveIdentity, effectiveSequence, plan } from '@schemamill/core';
import type {
  Column,
  Hazard,
  Identity,
  IdentityInput,
  Model,
  Plan,
  Sequence,
  SequenceDataType,
  SequenceOwner,
  Step,
  Table,
  TableIdentity,
} from '@schemamill/core';

import { analyzeHazards, hazardAnalyzer } from './index.ts';

/**
 * Tests for PostgreSQL hazard analysis: the definite checks pin every self-inconsistent shape
 * and its fix, the conditional checks pin the tightened bounds and where they attach, and the
 * determinism and suppression tests pin that state analysis is a pure, ordered read of the
 * models and the plan.
 */

/** A table identity: `public` unless another schema is given. */
const identity = (name: string, schema = 'public'): TableIdentity => ({ schema, name });

/** A column named `name`: `text` and nullable unless overridden. */
const column = (name: string, fields: Partial<Omit<Column, 'name'>> = {}): Column => ({
  name,
  type: 'text',
  notNull: false,
  ...fields,
});

/** A table with the given identity and columns. */
const table = (name: string, columns: readonly Column[] = [], schema = 'public'): Table => ({
  schema,
  name,
  columns,
  foreignKeys: [],
  uniqueConstraints: [],
  checkConstraints: [],
  indexes: [],
});

/** A model of the given tables. */
const model = (...tables: Table[]): Model => ({ tables, sequences: [] });

/** A model of the given sequences, with no tables unless they are supplied. */
const sequenceModel = (sequences: readonly Sequence[], ...tables: Table[]): Model => ({
  tables,
  sequences,
});

/** A sequence named `name` with the effective values for the stated options. */
const sequence = (
  name: string,
  fields: Partial<Omit<Sequence, 'schema' | 'name'>> = {},
): Sequence => effectiveSequence({ schema: 'public', name, ...fields });

/** An effective identity descriptor for `dataType`, `GENERATED ALWAYS` unless overridden. */
const identityColumn = (
  dataType: SequenceDataType,
  fields: Partial<IdentityInput> = {},
): Identity => effectiveIdentity(dataType, { generated: 'always', ...fields });

/** The index of the first step matching `predicate`; the plan must contain it. */
const stepIndex = (planned: Plan, predicate: (step: Step) => boolean): number => {
  const index = planned.steps.findIndex(predicate);
  assert.notEqual(index, -1, 'expected the plan to carry the step');
  return index;
};

/** The hazards of `baseline` → `target` under exactly the plan the engine would run. */
const analyze = (baseline: Model, target: Model): readonly Hazard[] =>
  analyzeHazards(baseline, target, plan(baseline, target));

test('binds the HazardAnalyzer seam and reports nothing for a clean plan', () => {
  const baseline = model();
  const target = sequenceModel(
    [sequence('s')],
    table('t', [
      column('id', { type: 'bigint', notNull: true, identity: identityColumn('bigint') }),
    ]),
  );
  const planned = plan(baseline, target);

  assert.deepEqual(analyzeHazards(baseline, target, planned), []);
  assert.deepEqual(hazardAnalyzer.analyze(baseline, target, planned), []);
});

test('a target-only sequence reports every definite violation in check order', () => {
  const baseline = model();
  const target = sequenceModel([
    sequence('s', {
      dataType: 'smallint',
      increment: '0',
      minValue: '-40000',
      maxValue: '-50000',
      start: '7',
      cache: '0',
    }),
  ]);
  const planned = plan(baseline, target);
  const step = stepIndex(planned, (candidate) => candidate.kind === 'create-sequence');

  assert.deepEqual(analyzeHazards(baseline, target, planned), [
    { kind: 'increment-zero', step, increment: '0' },
    { kind: 'bound-out-of-type-range', step, dataType: 'smallint', field: 'max', value: '-50000' },
    { kind: 'bound-out-of-type-range', step, dataType: 'smallint', field: 'min', value: '-40000' },
    { kind: 'bounds-inverted', step, minValue: '-40000', maxValue: '-50000' },
    { kind: 'start-out-of-bounds', step, start: '7', minValue: '-40000', maxValue: '-50000' },
    { kind: 'cache-nonpositive', step, cache: '0' },
  ]);
});

test('a target-only sequence reports a maximum above its data type', () => {
  const baseline = model();
  const target = sequenceModel([
    sequence('s', { dataType: 'smallint', minValue: '1', maxValue: '40000', start: '1' }),
  ]);
  const planned = plan(baseline, target);
  const step = stepIndex(planned, (candidate) => candidate.kind === 'create-sequence');

  assert.deepEqual(analyzeHazards(baseline, target, planned), [
    { kind: 'bound-out-of-type-range', step, dataType: 'smallint', field: 'max', value: '40000' },
  ]);
});

test('a target-only sequence reports a minimum above its data type', () => {
  const baseline = model();
  const target = sequenceModel([
    sequence('s', { dataType: 'integer', minValue: '4000000000', maxValue: '100', start: '100' }),
  ]);
  const planned = plan(baseline, target);
  const step = stepIndex(planned, (candidate) => candidate.kind === 'create-sequence');

  assert.deepEqual(analyzeHazards(baseline, target, planned), [
    {
      kind: 'bound-out-of-type-range',
      step,
      dataType: 'integer',
      field: 'min',
      value: '4000000000',
    },
    { kind: 'bounds-inverted', step, minValue: '4000000000', maxValue: '100' },
    { kind: 'start-out-of-bounds', step, start: '100', minValue: '4000000000', maxValue: '100' },
  ]);
});

test('a target-only sequence reports a maximum below its data type', () => {
  const baseline = model();
  const target = sequenceModel([sequence('s', { dataType: 'integer', maxValue: '-4000000000' })]);
  const planned = plan(baseline, target);
  const step = stepIndex(planned, (candidate) => candidate.kind === 'create-sequence');

  assert.deepEqual(analyzeHazards(baseline, target, planned), [
    {
      kind: 'bound-out-of-type-range',
      step,
      dataType: 'integer',
      field: 'max',
      value: '-4000000000',
    },
    { kind: 'bounds-inverted', step, minValue: '1', maxValue: '-4000000000' },
    { kind: 'start-out-of-bounds', step, start: '1', minValue: '1', maxValue: '-4000000000' },
  ]);
});

test('a matched sequence reports definite violations on its alter step', () => {
  const baseline = sequenceModel([
    sequence('s', { dataType: 'smallint', minValue: '1', maxValue: '100', start: '1' }),
  ]);
  const target = sequenceModel([
    sequence('s', {
      dataType: 'smallint',
      increment: '0',
      minValue: '-40000',
      maxValue: '-50000',
      start: '7',
      cache: '0',
    }),
  ]);
  const planned = plan(baseline, target);
  const step = stepIndex(planned, (candidate) => candidate.kind === 'alter-sequence');

  assert.deepEqual(analyzeHazards(baseline, target, planned), [
    { kind: 'increment-zero', step, increment: '0' },
    { kind: 'bound-out-of-type-range', step, dataType: 'smallint', field: 'max', value: '-50000' },
    { kind: 'bound-out-of-type-range', step, dataType: 'smallint', field: 'min', value: '-40000' },
    { kind: 'bounds-inverted', step, minValue: '-40000', maxValue: '-50000' },
    { kind: 'start-out-of-bounds', step, start: '7', minValue: '-40000', maxValue: '-50000' },
    { kind: 'cache-nonpositive', step, cache: '0' },
  ]);
});

test('an add-identity target reports every definite violation in check order', () => {
  const baseline = model();
  const target = model(
    table('t', [
      column('min_range', {
        type: 'smallint',
        notNull: true,
        identity: identityColumn('smallint', {
          minValue: '-40000',
          maxValue: '100',
          start: '-40000',
        }),
      }),
      column('max_range', {
        type: 'integer',
        notNull: true,
        identity: identityColumn('integer', {
          minValue: '1',
          maxValue: '4000000000',
          start: '1',
        }),
      }),
      column('inverted', {
        type: 'integer',
        notNull: true,
        identity: identityColumn('integer', { minValue: '5', maxValue: '5', start: '5' }),
      }),
      column('out_of_bounds', {
        type: 'integer',
        notNull: true,
        identity: identityColumn('integer', { minValue: '1', maxValue: '100', start: '200' }),
      }),
      column('bad_increment', {
        type: 'integer',
        notNull: true,
        identity: identityColumn('integer', {
          minValue: '1',
          maxValue: '100',
          start: '1',
          increment: '0',
        }),
      }),
      column('bad_cache', {
        type: 'integer',
        notNull: true,
        identity: identityColumn('integer', {
          minValue: '1',
          maxValue: '100',
          start: '1',
          cache: '-1',
        }),
      }),
    ]),
  );
  const planned = plan(baseline, target);
  const step = (name: string): number =>
    stepIndex(planned, (candidate) => candidate.kind === 'add-identity' && candidate.name === name);

  assert.deepEqual(analyzeHazards(baseline, target, planned), [
    {
      kind: 'bound-out-of-type-range',
      step: step('min_range'),
      dataType: 'smallint',
      field: 'min',
      value: '-40000',
    },
    {
      kind: 'bound-out-of-type-range',
      step: step('max_range'),
      dataType: 'integer',
      field: 'max',
      value: '4000000000',
    },
    { kind: 'bounds-inverted', step: step('inverted'), minValue: '5', maxValue: '5' },
    {
      kind: 'start-out-of-bounds',
      step: step('out_of_bounds'),
      start: '200',
      minValue: '1',
      maxValue: '100',
    },
    { kind: 'increment-zero', step: step('bad_increment'), increment: '0' },
    { kind: 'cache-nonpositive', step: step('bad_cache'), cache: '-1' },
  ]);
});

test('an alter-identity target reports every definite violation in check order', () => {
  const valid = (): Identity =>
    identityColumn('integer', { minValue: '1', maxValue: '100', start: '1' });
  const baselineColumns = [
    column('min_range', { type: 'smallint', notNull: true, identity: valid() }),
    column('max_range', { type: 'integer', notNull: true, identity: valid() }),
    column('inverted', { type: 'integer', notNull: true, identity: valid() }),
    column('out_of_bounds', { type: 'integer', notNull: true, identity: valid() }),
    column('bad_increment', { type: 'integer', notNull: true, identity: valid() }),
    column('bad_cache', { type: 'integer', notNull: true, identity: valid() }),
  ];
  const targetColumns = [
    column('min_range', {
      type: 'smallint',
      notNull: true,
      identity: identityColumn('smallint', {
        minValue: '-40000',
        maxValue: '100',
        start: '-40000',
      }),
    }),
    column('max_range', {
      type: 'integer',
      notNull: true,
      identity: identityColumn('integer', {
        minValue: '1',
        maxValue: '4000000000',
        start: '1',
      }),
    }),
    column('inverted', {
      type: 'integer',
      notNull: true,
      identity: identityColumn('integer', { minValue: '5', maxValue: '5', start: '5' }),
    }),
    column('out_of_bounds', {
      type: 'integer',
      notNull: true,
      identity: identityColumn('integer', { minValue: '1', maxValue: '100', start: '200' }),
    }),
    column('bad_increment', {
      type: 'integer',
      notNull: true,
      identity: identityColumn('integer', {
        minValue: '1',
        maxValue: '100',
        start: '1',
        increment: '0',
      }),
    }),
    column('bad_cache', {
      type: 'integer',
      notNull: true,
      identity: identityColumn('integer', {
        minValue: '1',
        maxValue: '100',
        start: '1',
        cache: '-1',
      }),
    }),
  ];
  const baseline = model(table('t', baselineColumns));
  const target = model(table('t', targetColumns));
  const planned = plan(baseline, target);
  const step = (name: string): number =>
    stepIndex(
      planned,
      (candidate) => candidate.kind === 'alter-identity' && candidate.name === name,
    );

  assert.deepEqual(analyzeHazards(baseline, target, planned), [
    {
      kind: 'bound-out-of-type-range',
      step: step('min_range'),
      dataType: 'smallint',
      field: 'min',
      value: '-40000',
    },
    {
      kind: 'bound-out-of-type-range',
      step: step('max_range'),
      dataType: 'integer',
      field: 'max',
      value: '4000000000',
    },
    { kind: 'bounds-inverted', step: step('inverted'), minValue: '5', maxValue: '5' },
    {
      kind: 'start-out-of-bounds',
      step: step('out_of_bounds'),
      start: '200',
      minValue: '1',
      maxValue: '100',
    },
    { kind: 'increment-zero', step: step('bad_increment'), increment: '0' },
    { kind: 'cache-nonpositive', step: step('bad_cache'), cache: '-1' },
  ]);
});

test('a matched sequence reports a tightened maximum on its alter step', () => {
  const baseline = sequenceModel([sequence('s', { minValue: '1', maxValue: '100', start: '1' })]);
  const target = sequenceModel([sequence('s', { minValue: '1', maxValue: '50', start: '1' })]);
  const planned = plan(baseline, target);
  const step = stepIndex(planned, (candidate) => candidate.kind === 'alter-sequence');

  assert.deepEqual(analyzeHazards(baseline, target, planned), [
    { kind: 'bound-tightened', step, field: 'max', before: '100', after: '50' },
  ]);
});

test('a matched sequence attaches the tightening to its option step', () => {
  const t = table('t', [
    column('id', { type: 'bigint', notNull: true }),
    column('x', { type: 'bigint' }),
  ]);
  const owner = (columnName: string): SequenceOwner => ({
    table: identity('t'),
    column: columnName,
  });
  const baseline = sequenceModel(
    [sequence('s', { minValue: '1', maxValue: '100', start: '1', ownedBy: owner('id') })],
    t,
  );
  const target = sequenceModel(
    [sequence('s', { minValue: '1', maxValue: '50', start: '1', ownedBy: owner('x') })],
    t,
  );
  const planned = plan(baseline, target);
  const step = stepIndex(
    planned,
    (candidate) =>
      candidate.kind === 'alter-sequence' &&
      candidate.fields.some((field) => field.field === 'maxValue'),
  );

  assert.equal(planned.steps.length, 2);
  assert.equal(step, 1, 'the option alter follows the ownership alter');
  assert.deepEqual(analyzeHazards(baseline, target, planned), [
    { kind: 'bound-tightened', step, field: 'max', before: '100', after: '50' },
  ]);
});

test('an ownership-only alter reports no definite hazards', () => {
  const t = table('t', [
    column('a', { type: 'bigint', notNull: true }),
    column('b', { type: 'bigint', notNull: true }),
  ]);
  const owner = (columnName: string): SequenceOwner => ({
    table: identity('t'),
    column: columnName,
  });
  const broken = (columnName: string): Sequence =>
    sequence('s', {
      increment: '0',
      minValue: '1',
      maxValue: '100',
      start: '1',
      ownedBy: owner(columnName),
    });
  const baseline = sequenceModel([broken('a')], t);
  const target = sequenceModel([broken('b')], t);
  const planned = plan(baseline, target);

  assert.deepEqual(planned.steps, [
    {
      kind: 'alter-sequence',
      sequence: { schema: 'public', name: 's' },
      fields: [
        {
          field: 'ownedBy',
          before: { table: identity('t'), column: 'a' },
          after: { table: identity('t'), column: 'b' },
        },
      ],
    },
  ]);
  assert.deepEqual(analyzeHazards(baseline, target, planned), []);
});

test('both bounds tightened report the minimum before the maximum', () => {
  const baseline = sequenceModel([sequence('s', { minValue: '1', maxValue: '100', start: '1' })]);
  const target = sequenceModel([sequence('s', { minValue: '10', maxValue: '50', start: '10' })]);
  const planned = plan(baseline, target);
  const step = stepIndex(planned, (candidate) => candidate.kind === 'alter-sequence');

  assert.deepEqual(analyzeHazards(baseline, target, planned), [
    { kind: 'bound-tightened', step, field: 'min', before: '1', after: '10' },
    { kind: 'bound-tightened', step, field: 'max', before: '100', after: '50' },
  ]);
});

test('an AS conversion that preserves custom bounds reports nothing', () => {
  const baseline = sequenceModel([
    sequence('s', { dataType: 'bigint', minValue: '-100', maxValue: '100', start: '-100' }),
  ]);
  const target = sequenceModel([
    sequence('s', { dataType: 'integer', minValue: '-100', maxValue: '100', start: '-100' }),
  ]);
  const planned = plan(baseline, target);

  assert.deepEqual(
    planned.steps.map((entry) => entry.kind),
    ['alter-sequence'],
  );
  assert.deepEqual(analyzeHazards(baseline, target, planned), []);
});

test('an AS conversion that resets a default bound reports the tightening', () => {
  const baseline = sequenceModel([sequence('s', { dataType: 'bigint' })]);
  const target = sequenceModel([sequence('s', { dataType: 'integer' })]);
  const planned = plan(baseline, target);
  const step = stepIndex(planned, (candidate) => candidate.kind === 'alter-sequence');

  assert.deepEqual(
    planned.steps.map((entry) => entry.kind),
    ['alter-sequence'],
  );
  assert.deepEqual(analyzeHazards(baseline, target, planned), [
    {
      kind: 'bound-tightened',
      step,
      field: 'max',
      before: '9223372036854775807',
      after: '2147483647',
    },
  ]);
});

test('an identity narrowed bigint to integer attaches the tightening to alter-column', () => {
  const baseline = model(
    table('t', [
      column('id', { type: 'bigint', notNull: true, identity: identityColumn('bigint') }),
    ]),
  );
  const target = model(
    table('t', [
      column('id', { type: 'integer', notNull: true, identity: identityColumn('integer') }),
    ]),
  );
  const planned = plan(baseline, target);
  const step = stepIndex(planned, (candidate) => candidate.kind === 'alter-column');

  assert.deepEqual(
    planned.steps.map((entry) => entry.kind),
    ['alter-column'],
  );
  assert.deepEqual(analyzeHazards(baseline, target, planned), [
    {
      kind: 'bound-tightened',
      step,
      field: 'max',
      before: '9223372036854775807',
      after: '2147483647',
    },
  ]);
});

test('a conversion tightening attaches to alter-column beside an option alter', () => {
  const baseline = model(
    table('t', [
      column('id', { type: 'bigint', notNull: true, identity: identityColumn('bigint') }),
    ]),
  );
  const target = model(
    table('t', [
      column('id', {
        type: 'integer',
        notNull: true,
        identity: identityColumn('integer', { cache: '10' }),
      }),
    ]),
  );
  const planned = plan(baseline, target);
  const typeStep = stepIndex(
    planned,
    (candidate) =>
      candidate.kind === 'alter-column' && candidate.fields.some((field) => field.field === 'type'),
  );
  const identityStep = stepIndex(planned, (candidate) => candidate.kind === 'alter-identity');

  assert.deepEqual(
    planned.steps.map((entry) => entry.kind),
    ['alter-column', 'alter-identity'],
  );
  assert.deepEqual(planned.steps[identityStep], {
    kind: 'alter-identity',
    table: identity('t'),
    name: 'id',
    fields: [{ field: 'cache', before: '1', after: '10' }],
  });
  assert.deepEqual(analyzeHazards(baseline, target, planned), [
    {
      kind: 'bound-tightened',
      step: typeStep,
      field: 'max',
      before: '9223372036854775807',
      after: '2147483647',
    },
  ]);
});

test('an identity restating a converted bound keeps the tightening on alter-identity', () => {
  const baseline = model(
    table('t', [
      column('id', { type: 'bigint', notNull: true, identity: identityColumn('bigint') }),
    ]),
  );
  const target = model(
    table('t', [
      column('id', {
        type: 'integer',
        notNull: true,
        identity: identityColumn('integer', { maxValue: '1000', cache: '10' }),
      }),
    ]),
  );
  const planned = plan(baseline, target);
  const identityStep = stepIndex(planned, (candidate) => candidate.kind === 'alter-identity');

  assert.deepEqual(
    planned.steps.map((entry) => entry.kind),
    ['alter-column', 'alter-identity'],
  );
  assert.deepEqual(analyzeHazards(baseline, target, planned), [
    {
      kind: 'bound-tightened',
      step: identityStep,
      field: 'max',
      before: '9223372036854775807',
      after: '1000',
    },
  ]);
});

test('a converted custom bound outside the new type range reports it on alter-column', () => {
  const baseline = model(
    table('t', [
      column('id', {
        type: 'bigint',
        notNull: true,
        identity: identityColumn('bigint', { minValue: '-4000000000', start: '-4000000000' }),
      }),
    ]),
  );
  const target = model(
    table('t', [
      column('id', {
        type: 'integer',
        notNull: true,
        identity: identityColumn('integer', { minValue: '-4000000000', start: '-4000000000' }),
      }),
    ]),
  );
  const planned = plan(baseline, target);
  const step = stepIndex(planned, (candidate) => candidate.kind === 'alter-column');

  assert.deepEqual(
    planned.steps.map((entry) => entry.kind),
    ['alter-column'],
  );
  assert.deepEqual(analyzeHazards(baseline, target, planned), [
    {
      kind: 'bound-out-of-type-range',
      step,
      dataType: 'integer',
      field: 'min',
      value: '-4000000000',
    },
  ]);
});

test('a converted out-of-range bound attaches to the type step before an option alter', () => {
  const baseline = model(
    table('t', [
      column('id', {
        type: 'bigint',
        notNull: true,
        identity: identityColumn('bigint', { minValue: '-4000000000', start: '-4000000000' }),
      }),
    ]),
  );
  const target = model(
    table('t', [
      column('id', {
        type: 'integer',
        notNull: true,
        identity: identityColumn('integer', {
          minValue: '-4000000000',
          start: '-4000000000',
          cache: '10',
        }),
      }),
    ]),
  );
  const planned = plan(baseline, target);
  const typeStep = stepIndex(
    planned,
    (candidate) =>
      candidate.kind === 'alter-column' && candidate.fields.some((field) => field.field === 'type'),
  );
  const identityStep = stepIndex(planned, (candidate) => candidate.kind === 'alter-identity');

  assert.deepEqual(
    planned.steps.map((entry) => entry.kind),
    ['alter-column', 'alter-identity'],
  );
  assert.deepEqual(planned.steps[identityStep], {
    kind: 'alter-identity',
    table: identity('t'),
    name: 'id',
    fields: [{ field: 'cache', before: '1', after: '10' }],
  });
  assert.deepEqual(analyzeHazards(baseline, target, planned), [
    {
      kind: 'bound-out-of-type-range',
      step: typeStep,
      dataType: 'integer',
      field: 'min',
      value: '-4000000000',
    },
  ]);
});

test('a bound the option alter introduces stays on the alter-identity step', () => {
  const baseline = model(
    table('t', [
      column('id', {
        type: 'bigint',
        notNull: true,
        identity: identityColumn('bigint', { minValue: '-40000', start: '-40000' }),
      }),
    ]),
  );
  const target = model(
    table('t', [
      column('id', {
        type: 'integer',
        notNull: true,
        identity: identityColumn('integer', { minValue: '-4000000000', cache: '10' }),
      }),
    ]),
  );
  const planned = plan(baseline, target);
  const identityStep = stepIndex(planned, (candidate) => candidate.kind === 'alter-identity');

  assert.deepEqual(
    planned.steps.map((entry) => entry.kind),
    ['alter-column', 'alter-identity'],
  );
  assert.deepEqual(planned.steps[identityStep], {
    kind: 'alter-identity',
    table: identity('t'),
    name: 'id',
    fields: [
      { field: 'minValue', before: '-40000', after: '-4000000000' },
      { field: 'start', before: '-40000', after: '-4000000000' },
      { field: 'cache', before: '1', after: '10' },
    ],
  });
  assert.deepEqual(analyzeHazards(baseline, target, planned), [
    {
      kind: 'bound-out-of-type-range',
      step: identityStep,
      dataType: 'integer',
      field: 'min',
      value: '-4000000000',
    },
  ]);
});

test('a converted in-range custom bound reports nothing', () => {
  const identityOf = (dataType: SequenceDataType): Identity =>
    identityColumn(dataType, { minValue: '-40000', maxValue: '40000', start: '-40000' });
  const baseline = model(
    table('t', [column('id', { type: 'bigint', notNull: true, identity: identityOf('bigint') })]),
  );
  const target = model(
    table('t', [column('id', { type: 'integer', notNull: true, identity: identityOf('integer') })]),
  );
  const planned = plan(baseline, target);

  assert.deepEqual(
    planned.steps.map((entry) => entry.kind),
    ['alter-column'],
  );
  assert.deepEqual(analyzeHazards(baseline, target, planned), []);
});

test('a converted non-integer identity skips the definite checks', () => {
  const identity = (): Identity =>
    identityColumn('integer', { minValue: '5', maxValue: '5', start: '5' });
  const baseline = model(
    table('t', [column('id', { type: 'text', notNull: true, identity: identity() })]),
  );
  const target = model(
    table('t', [column('id', { type: 'varchar(10)', notNull: true, identity: identity() })]),
  );
  const planned = plan(baseline, target);

  assert.deepEqual(
    planned.steps.map((entry) => entry.kind),
    ['alter-column'],
  );
  assert.deepEqual(analyzeHazards(baseline, target, planned), []);
});

test('a recreated identity reports a definite hazard on its add step', () => {
  const baseline = model(
    table('t', [
      column('id', {
        type: 'integer',
        notNull: true,
        identity: identityColumn('integer', {
          sequenceName: identity('t_id_seq'),
          minValue: '1',
          maxValue: '100',
          start: '1',
        }),
      }),
    ]),
  );
  const target = model(
    table('t', [
      column('id', {
        type: 'integer',
        notNull: true,
        identity: identityColumn('integer', {
          sequenceName: identity('t_id_seq_2'),
          minValue: '1',
          maxValue: '100',
          start: '1',
          increment: '0',
        }),
      }),
    ]),
  );
  const planned = plan(baseline, target);
  const step = stepIndex(planned, (candidate) => candidate.kind === 'add-identity');

  assert.deepEqual(
    planned.steps.map((entry) => entry.kind),
    ['drop-identity', 'add-identity'],
  );
  assert.deepEqual(analyzeHazards(baseline, target, planned), [
    { kind: 'increment-zero', step, increment: '0' },
  ]);
});

test('a recreated identity reports no tightened bound', () => {
  const baseline = model(
    table('t', [
      column('id', {
        type: 'integer',
        notNull: true,
        identity: identityColumn('integer', {
          sequenceName: identity('t_id_seq'),
          minValue: '1',
          maxValue: '100',
          start: '1',
        }),
      }),
    ]),
  );
  const target = model(
    table('t', [
      column('id', {
        type: 'integer',
        notNull: false,
        identity: identityColumn('integer', {
          sequenceName: identity('t_id_seq_2'),
          minValue: '10',
          maxValue: '50',
          start: '10',
        }),
      }),
    ]),
  );
  const planned = plan(baseline, target);

  assert.deepEqual(
    planned.steps.map((entry) => entry.kind),
    ['drop-identity', 'alter-column', 'add-identity'],
  );
  assert.deepEqual(analyzeHazards(baseline, target, planned), []);
});

test('a definite violation suppresses the entity\u2019s tightened bounds', () => {
  const baseline = sequenceModel([sequence('s', { minValue: '1', maxValue: '1000', start: '1' })]);
  const target = sequenceModel([sequence('s', { minValue: '10', maxValue: '5', start: '7' })]);
  const planned = plan(baseline, target);
  const step = stepIndex(planned, (candidate) => candidate.kind === 'alter-sequence');

  assert.deepEqual(analyzeHazards(baseline, target, planned), [
    { kind: 'bounds-inverted', step, minValue: '10', maxValue: '5' },
    { kind: 'start-out-of-bounds', step, start: '7', minValue: '10', maxValue: '5' },
  ]);
});

test('a start equal to either bound is inside the range', () => {
  const baseline = model();
  const target = sequenceModel([
    sequence('at_max', { minValue: '1', maxValue: '10', start: '10' }),
    sequence('at_min', { minValue: '1', maxValue: '10', start: '1' }),
  ]);

  assert.deepEqual(analyze(baseline, target), []);
});

test('equality, widening, and an increment sign flip report nothing', () => {
  const equal = sequenceModel([
    sequence('s', { increment: '-2', minValue: '-100', maxValue: '-1', start: '-1' }),
  ]);
  const equalPlan = plan(equal, equal);

  assert.equal(equalPlan.steps.length, 0);
  assert.deepEqual(analyzeHazards(equal, equal, equalPlan), []);

  const narrow = sequenceModel([sequence('s', { dataType: 'integer' })]);
  const wide = sequenceModel([sequence('s', { dataType: 'bigint' })]);
  assert.deepEqual(analyze(narrow, wide), []);

  const ascending = sequenceModel([sequence('s', { minValue: '1', maxValue: '100', start: '1' })]);
  const descending = sequenceModel([
    sequence('s', { increment: '-1', minValue: '1', maxValue: '100', start: '1' }),
  ]);
  assert.deepEqual(analyze(ascending, descending), []);
});

test('a target-only entity reports its definite hazards only', () => {
  const baseline = model();
  const target = sequenceModel([
    sequence('s', { dataType: 'smallint', minValue: '-40000', maxValue: '100', start: '-40000' }),
  ]);
  const planned = plan(baseline, target);
  const step = stepIndex(planned, (candidate) => candidate.kind === 'create-sequence');

  assert.deepEqual(analyzeHazards(baseline, target, planned), [
    { kind: 'bound-out-of-type-range', step, dataType: 'smallint', field: 'min', value: '-40000' },
  ]);
});

test('a baseline-only entity reports nothing', () => {
  const baseline = sequenceModel([
    sequence('s', { increment: '0', minValue: '1', maxValue: '100', start: '1' }),
  ]);
  const target = model();
  const planned = plan(baseline, target);

  assert.deepEqual(
    planned.steps.map((entry) => entry.kind),
    ['drop-sequence'],
  );
  assert.deepEqual(analyzeHazards(baseline, target, planned), []);
});

test('an entity the plan carries no step for reports nothing', () => {
  const broken = sequence('s', { increment: '0', minValue: '1', maxValue: '100', start: '1' });
  const baseline = sequenceModel([broken]);
  const target = sequenceModel([broken]);
  const planned = plan(baseline, target);

  assert.equal(planned.steps.length, 0);
  assert.deepEqual(analyzeHazards(baseline, target, planned), []);
});

test('a non-integer identity column skips only the type-range check', () => {
  const baseline = model();
  const target = model(
    table('t', [
      column('id', {
        type: 'numeric',
        notNull: true,
        identity: identityColumn('integer', { minValue: '5', maxValue: '5', start: '5' }),
      }),
    ]),
  );
  const planned = plan(baseline, target);
  const step = stepIndex(planned, (candidate) => candidate.kind === 'add-identity');

  assert.deepEqual(analyzeHazards(baseline, target, planned), [
    { kind: 'bounds-inverted', step, minValue: '5', maxValue: '5' },
  ]);
});

test('an identity type-range hazard reports the canonical integer type', () => {
  const baseline = model();
  const target = model(
    table('t', [
      column('id', {
        type: 'int',
        notNull: true,
        identity: identityColumn('integer', { minValue: '1', maxValue: '4000000000', start: '1' }),
      }),
    ]),
  );
  const planned = plan(baseline, target);
  const step = stepIndex(planned, (candidate) => candidate.kind === 'add-identity');

  assert.deepEqual(analyzeHazards(baseline, target, planned), [
    {
      kind: 'bound-out-of-type-range',
      step,
      dataType: 'integer',
      field: 'max',
      value: '4000000000',
    },
  ]);
});

test('model array order never affects the hazards', () => {
  const scene = (reversed: boolean): { baseline: Model; target: Model } => {
    const order = <T>(values: readonly T[]): T[] =>
      reversed ? [...values].reverse() : [...values];
    const baselineTable = table('t', [
      column('id', {
        type: 'integer',
        notNull: true,
        identity: identityColumn('integer', { minValue: '1', maxValue: '100', start: '1' }),
      }),
    ]);
    const targetTable = table('t', [
      column('id', {
        type: 'integer',
        notNull: true,
        identity: identityColumn('integer', { minValue: '10', maxValue: '100', start: '10' }),
      }),
    ]);

    return {
      baseline: {
        tables: order([baselineTable]),
        sequences: order([
          sequence('tight', { minValue: '1', maxValue: '100', start: '1' }),
          sequence('bad', { cache: '0' }),
        ]),
      },
      target: {
        tables: order([targetTable]),
        sequences: order([
          sequence('tight', { minValue: '5', maxValue: '50', start: '5' }),
          sequence('bad', { cache: '0' }),
        ]),
      },
    };
  };

  const first = scene(false);
  const second = scene(true);
  const firstHazards = analyze(first.baseline, first.target);
  const secondHazards = analyze(second.baseline, second.target);

  assert.notEqual(firstHazards.length, 0);
  assert.deepEqual(firstHazards, secondHazards);
});

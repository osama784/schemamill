import assert from 'node:assert/strict';
import { test } from 'node:test';

import { plan } from '@schemamill/core';
import type {
  CheckConstraint,
  Column,
  CommentTarget,
  ForeignKey,
  Model,
  Plan,
  Step,
  Table,
  TableIdentity,
} from '@schemamill/core';

import {
  assertDeclarationsSupported,
  collectDeclarationFacts,
  RenderRefusalError,
  renderSql,
} from './index.ts';
import type { DeclarationFact } from './index.ts';

/**
 * Tests for the declaration gate: a pure collector reads the target model and the plan, and the
 * renderer refuses a declaration whose syntax the declared major cannot express. Every form is
 * pinned at its floor and one major below it, with untouched model declarations included.
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

/** A table with columns and constraints, empty by default. */
const table = (
  name: string,
  parts: Partial<Omit<Table, 'schema' | 'name'>> = {},
  schema = 'public',
): Table => ({
  schema,
  name,
  columns: [],
  foreignKeys: [],
  uniqueConstraints: [],
  checkConstraints: [],
  indexes: [],
  ...parts,
});

/** A model of the given tables. */
const model = (...tables: readonly Table[]): Model => ({
  tables,
  sequences: [],
  views: [],
  extensions: [],
});

/** A plan of the given steps as one transactional group. */
const planOf = (...steps: readonly Step[]): Plan => ({
  steps,
  groups: steps.length === 0 ? [] : [{ start: 0, end: steps.length, transactional: true }],
});

/** Asserts the exact `RenderRefusalError` message, including the class. */
const assertRefusal = (render: () => unknown, message: string): void => {
  let caught: unknown;
  try {
    render();
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof RenderRefusalError)) {
    assert.fail(`expected a RenderRefusalError, caught ${String(caught)}`);
  }
  assert.equal(caught.message, message);
};

const refusal = (target: number, capability: string, scope: string, floor: number): string =>
  `refusing to render for PostgreSQL ${target}: ${capability} on ${scope} needs PostgreSQL ${floor} or newer`;

test('the collector enumerates model facts before step facts in deterministic order', () => {
  const target = model(
    table(
      't',
      {
        columns: [
          column('a', { notNull: true, notNullName: 'app_a_nn' }),
          column('b', { compression: 'pglz' }),
          column('plain'),
        ],
        checkConstraints: [{ name: 'ck_app', expression: 'a > 0', enforcement: 'not-enforced' }],
      },
      'app',
    ),
    table('u', { columns: [column('c', { notNull: true, notNullName: 'u_c_nn' })] }),
  );
  const planned = planOf({
    kind: 'add-not-null',
    table: identity('t', 'app'),
    column: 'd',
    name: 'app_d_nn',
  });

  const facts = collectDeclarationFacts(planned, { targetModel: target });

  assert.deepEqual(
    facts.map((fact) => [fact.form, fact.table.schema, fact.table.name, fact.step]),
    [
      ['named-not-null', 'app', 't', -1],
      ['explicit-compression', 'app', 't', -1],
      ['not-enforced', 'app', 't', -1],
      ['named-not-null', 'public', 'u', -1],
      ['named-not-null', 'app', 't', 0],
    ],
  );
  assert.deepEqual(
    facts.map((fact) => fact.origin),
    ['model', 'model', 'model', 'model', 'step'],
  );
  assert.deepEqual(
    facts.map((fact) => fact.floor),
    [18, 14, 18, 18, 18],
  );
  assert.equal(collectDeclarationFacts(planned, { targetModel: target }).length, facts.length);
});

test('named NOT NULL refuses below 18 for inline loss and table-constraint forms', () => {
  const inline = planOf({
    kind: 'add-column',
    table: identity('t'),
    column: column('c', { notNull: true, notNullName: 'nn_c' }),
  });
  const tableConstraint = planOf({
    kind: 'add-not-null',
    table: identity('t'),
    column: 'd',
    name: 'nn_d',
  });

  for (const targetVersion of [13, 14, 16]) {
    assertRefusal(
      () => renderSql(inline, { targetVersion }),
      refusal(targetVersion, 'named NOT NULL', 'public.t column c', 18),
    );
    assertRefusal(
      () => renderSql(tableConstraint, { targetVersion }),
      refusal(targetVersion, 'named NOT NULL', 'public.t column d', 18),
    );
  }
  assert.match(
    renderSql(inline, { targetVersion: 18 }),
    /ADD COLUMN c text CONSTRAINT nn_c NOT NULL;/,
  );
  assert.match(
    renderSql(tableConstraint, { targetVersion: 18 }),
    /ADD CONSTRAINT nn_d NOT NULL d;/,
  );
});

test('a named NOT NULL drop refuses below 18', () => {
  const planned = planOf({
    kind: 'drop-not-null',
    table: identity('t'),
    column: 'c',
    name: 'nn_c',
  });

  for (const targetVersion of [13, 14, 16]) {
    assertRefusal(
      () => renderSql(planned, { targetVersion }),
      refusal(targetVersion, 'named NOT NULL drop', 'public.t column c', 18),
    );
  }
  assert.equal(
    renderSql(planned, { targetVersion: 18 }),
    'BEGIN;\nALTER TABLE public.t DROP CONSTRAINT nn_c;\nCOMMIT;\n',
  );
  // An unnamed drop stays unnamed below 18 — no name, no gated form.
  const unnamed: Plan = planOf({
    kind: 'drop-not-null',
    table: identity('t'),
    column: 'c',
  });
  assert.match(renderSql(unnamed), /ALTER COLUMN c DROP NOT NULL;/);
});

test('a standalone NOT NULL comment target refuses below 18', () => {
  const target: CommentTarget = {
    kind: 'not-null',
    table: identity('t'),
    column: column('c', { notNull: true, notNullName: 'nn_c' }),
  };
  const planned = planOf({ kind: 'comment', target, text: 'a note' });

  for (const targetVersion of [13, 14, 16]) {
    assertRefusal(
      () => renderSql(planned, { targetVersion }),
      refusal(targetVersion, 'NOT NULL comment', 'public.t column c', 18),
    );
  }
  assert.match(
    renderSql(planned, { targetVersion: 18 }),
    /COMMENT ON CONSTRAINT nn_c ON public.t IS 'a note';/,
  );
});

test('NOT ENFORCED refuses below 18 on checks and foreign keys', () => {
  const check: CheckConstraint = { name: 'ck_c', expression: 'c > 0', enforcement: 'not-enforced' };
  const foreignKey: ForeignKey = {
    name: 'fk_c',
    columns: ['c'],
    referencedTable: identity('parent'),
    referencedColumns: [],
    enforcement: 'not-enforced',
  };
  const checks = planOf({
    kind: 'add-check-constraint',
    table: identity('t'),
    checkConstraint: check,
  });
  const keys = planOf({ kind: 'add-foreign-key', table: identity('t'), foreignKey });

  for (const targetVersion of [13, 14, 16]) {
    assertRefusal(
      () => renderSql(checks, { targetVersion }),
      refusal(targetVersion, 'NOT ENFORCED', 'public.t constraint ck_c', 18),
    );
    assertRefusal(
      () => renderSql(keys, { targetVersion }),
      refusal(targetVersion, 'NOT ENFORCED', 'public.t constraint fk_c', 18),
    );
  }
  assert.match(renderSql(checks, { targetVersion: 18 }), /CHECK \(c > 0\) NOT ENFORCED;/);
  assert.match(renderSql(keys, { targetVersion: 18 }), /FOREIGN KEY \(c\).*NOT ENFORCED;/);
});

test('explicit compression refuses below 14 and renders at 14, 16 and 18', () => {
  const added = planOf({
    kind: 'add-column',
    table: identity('t'),
    column: column('c', { compression: 'lz4' }),
  });
  const merged = planOf({
    kind: 'alter-column',
    table: identity('t'),
    name: 'c',
    fields: [{ field: 'type', before: 'text', after: 'integer' }],
    attributes: { type: 'integer', compression: 'pglz' },
  });
  const standalone = planOf({
    kind: 'alter-column',
    table: identity('t'),
    name: 'c',
    fields: [{ field: 'compression', before: 'pglz', after: 'lz4' }],
  });

  const compressionCases: readonly [Plan, string][] = [
    [added, 'lz4'],
    [merged, 'pglz'],
    [standalone, 'lz4'],
  ];
  for (const [planned, method] of compressionCases) {
    assertRefusal(
      () => renderSql(planned, { targetVersion: 13 }),
      refusal(13, `COMPRESSION ${method}`, 'public.t column c', 14),
    );
  }
  assert.equal(renderSql(added, { targetVersion: 14 }), renderSql(added, { targetVersion: 18 }));
  assert.match(renderSql(merged, { targetVersion: 14 }), /SET COMPRESSION pglz;/);
  assert.match(renderSql(standalone, { targetVersion: 14 }), /SET COMPRESSION lz4;/);
  // A reset is a synthesized form with its own pinned message, not a declaration fact.
  const reset = plan(
    model(table('t', { columns: [column('c', { compression: 'pglz' })] })),
    model(table('t', { columns: [column('c')] })),
  );
  assertRefusal(
    () => renderSql(reset),
    'refusing to render for PostgreSQL 13: SET COMPRESSION default on public.t column c needs PostgreSQL 14 or newer',
  );
});

test('a carrier compression with no type or collation change never refuses', () => {
  // Without a type or collation field the renderer emits no merged TYPE statement and ignores
  // `attributes`, so the carrier's compression is never emitted — it must not gate either.
  const planned = planOf({
    kind: 'alter-column',
    table: identity('t'),
    name: 'c',
    fields: [{ field: 'notNull', before: false, after: true }],
    attributes: { type: 'text', compression: 'pglz' },
  });

  const at13 = renderSql(planned, { targetVersion: 13 });
  assert.equal(at13, 'BEGIN;\nALTER TABLE public.t ALTER COLUMN c SET NOT NULL;\nCOMMIT;\n');
  assert.equal(at13, renderSql(planned, { targetVersion: 14 }));
});

test('explicit storage never gates at any target', () => {
  const added = planOf({
    kind: 'add-column',
    table: identity('t'),
    column: column('c', { storage: 'external' }),
  });
  const outputs = [13, 14, 16, 18].map((targetVersion) => renderSql(added, { targetVersion }));
  for (const output of outputs) assert.equal(output, outputs[0]);
  assert.match(outputs[0]!, /SET STORAGE EXTERNAL;/);

  // A model-carried storage declaration is a noted residual, not a gate.
  const carried = model(table('untouched', { columns: [column('c', { storage: 'main' })] }));
  assert.equal(renderSql(planOf(), { targetModel: carried }), '');
});

test('a model-carried declaration on an untouched table refuses at the default target', () => {
  const target = model(
    table('keep', { columns: [column('c', { notNull: true, notNullName: 'keep_c_nn' })] }),
  );
  const planned = planOf({ kind: 'create-schema', schema: 'app' });

  assertRefusal(
    () => renderSql(planned, { targetModel: target }),
    refusal(13, 'named NOT NULL', 'public.keep column c', 18),
  );
  assert.equal(renderSql(planned), 'BEGIN;\nCREATE SCHEMA IF NOT EXISTS app;\nCOMMIT;\n');
});

test('a zero-step plan still validates the target model', () => {
  const target = model(
    table('keep', {
      columns: [column('c', { compression: 'lz4' })],
      checkConstraints: [{ name: 'ck', expression: 'c > 0', enforcement: 'not-enforced' }],
    }),
  );
  assertRefusal(
    () => renderSql(planOf(), { targetModel: target }),
    refusal(13, 'COMPRESSION lz4', 'public.keep column c', 14),
  );
  assert.equal(renderSql(planOf(), { targetModel: model() }), '');
});

test('the first offender follows model order then step order', () => {
  const target = model(
    table('a', { columns: [column('x', { notNull: true, notNullName: 'a_x_nn' })] }),
    table('b', { columns: [column('y', { notNull: true, notNullName: 'b_y_nn' })] }),
  );
  const planned = planOf(
    { kind: 'add-not-null', table: identity('t'), column: 'z', name: 't_z_nn' },
    {
      kind: 'add-column',
      table: identity('t'),
      column: column('w', { compression: 'lz4' }),
    },
  );

  assertRefusal(
    () => renderSql(planned, { targetModel: target }),
    refusal(13, 'named NOT NULL', 'public.a column x', 18),
  );
  // Without the target model the first step offender wins, in step order.
  assertRefusal(() => renderSql(planned), refusal(13, 'named NOT NULL', 'public.t column z', 18));
});

test('minimal quoting and schema qualification are used in refusal messages', () => {
  const facts: readonly DeclarationFact[] = [
    {
      form: 'named-not-null',
      origin: 'step',
      step: 0,
      table: { schema: 'My Schema', name: 'Odd Table' },
      column: 'a"b',
      floor: 18,
    },
  ];

  assertRefusal(
    () => assertDeclarationsSupported(facts, 17),
    'refusing to render for PostgreSQL 17: named NOT NULL on "My Schema"."Odd Table" column "a""b" needs PostgreSQL 18 or newer',
  );
  assert.doesNotThrow(() => assertDeclarationsSupported(facts, 18));
});

test('assertDeclarationsSupported pins every form and floor', () => {
  const base = { origin: 'step' as const, step: 0, table: identity('t') };
  const cases: readonly [DeclarationFact, number, string][] = [
    [
      { ...base, form: 'named-not-null', column: 'c', floor: 18 },
      18,
      refusal(17, 'named NOT NULL', 'public.t column c', 18),
    ],
    [
      { ...base, form: 'named-not-null-drop', column: 'c', floor: 18 },
      18,
      refusal(17, 'named NOT NULL drop', 'public.t column c', 18),
    ],
    [
      { ...base, form: 'not-null-comment', column: 'c', floor: 18 },
      18,
      refusal(17, 'NOT NULL comment', 'public.t column c', 18),
    ],
    [
      { ...base, form: 'not-enforced', constraint: 'ck', floor: 18 },
      18,
      refusal(17, 'NOT ENFORCED', 'public.t constraint ck', 18),
    ],
    [
      { ...base, form: 'explicit-compression', column: 'c', method: 'lz4', floor: 14 },
      14,
      refusal(13, 'COMPRESSION lz4', 'public.t column c', 14),
    ],
  ];

  for (const [declaration, floor, message] of cases) {
    assertRefusal(() => assertDeclarationsSupported([declaration], floor - 1), message);
    assert.doesNotThrow(() => assertDeclarationsSupported([declaration], floor));
  }
});

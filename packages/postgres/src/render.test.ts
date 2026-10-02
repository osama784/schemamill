import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { effectiveIdentity, plan, sequenceTypeBounds } from '@schemamill/core';
import type {
  CheckConstraint,
  Column,
  ForeignKey,
  Identity,
  IdentityInput,
  Index,
  Model,
  Plan,
  PrimaryKey,
  Sequence,
  SequenceOwner,
  Step,
  Table,
  TableIdentity,
  UniqueConstraint,
} from '@schemamill/core';

import { renderSql, sqlRenderer } from './index.ts';

/**
 * Tests for migration SQL rendering: the inline edge cases pin the quoting and statement
 * rules, the golden files pin ten whole scenes, and the determinism test pins that only the
 * models' structure — not their array order — reaches the SQL.
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

interface TableParts {
  schema?: string;
  columns?: readonly Column[];
  primaryKey?: PrimaryKey;
  foreignKeys?: readonly ForeignKey[];
  uniqueConstraints?: readonly UniqueConstraint[];
  checkConstraints?: readonly CheckConstraint[];
  indexes?: readonly Index[];
}

/** A table with the given identity: empty unless parts are supplied. */
const table = (name: string, parts: TableParts = {}): Table => ({
  schema: parts.schema ?? 'public',
  name,
  columns: parts.columns ?? [],
  ...(parts.primaryKey === undefined ? {} : { primaryKey: parts.primaryKey }),
  foreignKeys: parts.foreignKeys ?? [],
  uniqueConstraints: parts.uniqueConstraints ?? [],
  checkConstraints: parts.checkConstraints ?? [],
  indexes: parts.indexes ?? [],
});

/** A unique constraint on `columns`: unnamed unless overridden. */
const uniqueConstraint = (
  columns: readonly string[],
  rest: Partial<Omit<UniqueConstraint, 'columns'>> = {},
): UniqueConstraint => ({ columns, ...rest });

/** A check constraint with `expression`: unnamed unless overridden. */
const checkConstraint = (
  expression: string,
  rest: Partial<Omit<CheckConstraint, 'expression'>> = {},
): CheckConstraint => ({ expression, ...rest });

/** A non-unique index on `columns`: unnamed and non-concurrent unless overridden. */
const tableIndex = (
  columns: readonly string[],
  rest: Partial<Omit<Index, 'columns'>> = {},
): Index => ({ unique: false, columns, ...rest });

/** A foreign key on `columns`: unnamed with no referenced columns unless overridden. */
const foreignKey = (
  columns: readonly string[],
  referencedTable: TableIdentity,
  rest: Partial<Omit<ForeignKey, 'columns' | 'referencedTable'>> = {},
): ForeignKey => ({
  columns,
  referencedTable,
  referencedColumns: [],
  ...rest,
});

/** A model of the given tables. */
const model = (...tables: Table[]): Model => ({ tables, sequences: [] });

/**
 * A sequence named `name`: ascending defaults in range for its data type unless overridden. The
 * default maximum follows `dataType`, so an `integer` sequence gets the integer maximum.
 */
const sequence = (
  name: string,
  fields: Partial<Omit<Sequence, 'schema' | 'name'>> = {},
  schema = 'public',
): Sequence => ({
  schema,
  name,
  dataType: 'bigint',
  increment: '1',
  minValue: '1',
  maxValue: sequenceTypeBounds(fields.dataType ?? 'bigint').maxValue,
  start: '1',
  cache: '1',
  cycle: false,
  ...fields,
});

/** An owner of table `table`'s column `column`, `public` unless a schema is given. */
const owner = (table: string, column: string, schema = 'public'): SequenceOwner => ({
  table: { schema, name: table },
  column,
});

/** An effective identity for an `integer` column, `GENERATED ALWAYS` unless overridden. */
const identityColumn = (fields: Partial<IdentityInput> = {}): Identity =>
  effectiveIdentity('integer', { generated: 'always', ...fields });

/** A model of the given sequences, with no tables unless they are supplied. */
const sequenceModel = (sequences: readonly Sequence[], ...tables: Table[]): Model => ({
  tables,
  sequences,
});

/** A plan of the given steps as one transactional group, for renderer edge cases. */
const planOf = (...steps: readonly Step[]): Plan => ({
  steps,
  groups: steps.length === 0 ? [] : [{ start: 0, end: steps.length, transactional: true }],
});

/** One `drop-table` step, for the partition-guard cases. */
const dropStep = (name: string): Step => ({ kind: 'drop-table', table: identity(name) });

/** Reads the golden file `test/goldens/<name>.sql`, including its trailing newline. */
const golden = (name: string): string =>
  readFileSync(new URL(`../test/goldens/${name}.sql`, import.meta.url), 'utf8');

/** Asserts that planning `baseline` to `target` renders exactly the golden `<name>.sql`. */
const assertGolden = (name: string, baseline: Model, target: Model): void => {
  assert.equal(renderSql(plan(baseline, target)), golden(name));
};

/**
 * The full mixed migration shared by the golden and determinism tests: removed tables with a
 * reference edge, a kept table whose foreign key goes away, a table created with a foreign
 * key, and column, primary-key, and foreign-key changes. `reversed` flips every insertion
 * order without changing the structure.
 */
const mixedScene = (reversed = false) => {
  const order = <T>(values: readonly T[]): T[] => (reversed ? [...values].reverse() : [...values]);

  const audit = table('audit', { columns: [column('id', { type: 'integer' })] });
  const legacy = table('legacy', {
    columns: [column('id', { type: 'integer', notNull: true })],
    primaryKey: { name: 'legacy_pkey', columns: ['id'] },
  });
  const legacyNotes = table('legacy_notes', {
    columns: [column('id', { type: 'integer' }), column('legacy_id', { type: 'integer' })],
    foreignKeys: [
      foreignKey(['legacy_id'], identity('legacy'), {
        name: 'legacy_notes_legacy_id_fkey',
        referencedColumns: ['id'],
      }),
    ],
  });
  const groups = table('groups', {
    columns: [column('id', { type: 'integer', notNull: true })],
    primaryKey: { name: 'groups_pkey', columns: ['id'] },
  });
  const orders = table('orders', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('legacy_id', { type: 'integer' }),
    ],
    foreignKeys: order([
      foreignKey(['legacy_id'], identity('legacy'), {
        name: 'orders_legacy_id_fkey',
        referencedColumns: ['id'],
      }),
    ]),
  });
  const users = table('users', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('name', { type: 'character varying(12)' }),
      column('obsolete', { type: 'integer' }),
      column('group_id', { type: 'integer' }),
    ],
    primaryKey: { name: 'users_pkey', columns: ['id'] },
    foreignKeys: order([
      foreignKey(['obsolete'], identity('legacy'), {
        name: 'users_obsolete_fkey',
        referencedColumns: ['id'],
      }),
      foreignKey(['group_id'], identity('groups'), {
        name: 'users_group_id_fkey',
        referencedColumns: ['id'],
      }),
    ]),
  });

  const ordersWithoutForeignKey = table('orders', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('legacy_id', { type: 'integer' }),
    ],
    foreignKeys: [],
  });
  const sessions = table('sessions', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('user_id', { type: 'integer', notNull: true }),
    ],
    primaryKey: { name: 'sessions_pkey', columns: ['id'] },
    foreignKeys: order([
      foreignKey(['user_id'], identity('users'), {
        name: 'sessions_user_id_fkey',
        referencedColumns: ['id'],
      }),
    ]),
  });
  const usersTarget = table('users', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('name'),
      column('group_id', { type: 'integer' }),
      column('email'),
    ],
    primaryKey: { columns: ['id'] },
    foreignKeys: order([
      foreignKey(['group_id'], identity('groups'), {
        name: 'users_group_id_fkey',
        referencedColumns: ['id'],
        onDelete: 'CASCADE',
      }),
    ]),
  });

  return {
    baseline: model(...order([audit, legacy, legacyNotes, groups, orders, users])),
    target: model(...order([groups, ordersWithoutForeignKey, sessions, usersTarget])),
  };
};

test('an empty plan renders as the empty string', () => {
  assert.equal(renderSql(plan(model(), model())), '');
  assert.equal(renderSql({ steps: [], groups: [] }), '');
});

test('a non-empty plan renders as exactly one wrapped transaction', () => {
  const sql = renderSql(
    plan(
      model(),
      model(table('t', { columns: [column('id', { type: 'integer', notNull: true })] })),
    ),
  );

  assert.ok(sql.startsWith('BEGIN;\n'), 'the plan opens with BEGIN;');
  assert.ok(sql.endsWith('COMMIT;\n'), 'the plan closes with COMMIT; and one trailing newline');
  assert.equal(sql.match(/^BEGIN;$/gm)?.length, 1);
  assert.equal(sql.match(/^COMMIT;$/gm)?.length, 1);
});

test('wraps each transactional group and leaves a standalone group bare', () => {
  const synthetic: Plan = {
    steps: [
      { kind: 'drop-table', table: identity('a') },
      { kind: 'drop-table', table: identity('b') },
      { kind: 'drop-table', table: identity('c') },
      { kind: 'drop-table', table: identity('d') },
    ],
    groups: [
      { start: 0, end: 2, transactional: true },
      { start: 2, end: 3, transactional: false },
      { start: 3, end: 4, transactional: true },
    ],
  };

  // A multi-group plan separates its groups with one blank line.
  assert.equal(
    renderSql(synthetic),
    [
      'BEGIN;',
      'DROP TABLE public.a;',
      'DROP TABLE public.b;',
      'COMMIT;',
      '',
      'DROP TABLE public.c;',
      '',
      'BEGIN;',
      'DROP TABLE public.d;',
      'COMMIT;',
      '',
    ].join('\n'),
  );
});

test('a non-empty plan with no groups is rejected', () => {
  assert.throws(
    () => renderSql({ steps: [dropStep('a')], groups: [] }),
    /plan\.groups must tile \[0, 1\) in order, but found no groups/,
  );
});

test('a partition with a gap is rejected', () => {
  assert.throws(
    () =>
      renderSql({
        steps: [dropStep('a'), dropStep('b'), dropStep('c')],
        groups: [
          { start: 0, end: 1, transactional: true },
          { start: 2, end: 3, transactional: true },
        ],
      }),
    /group 1 starts at 2, expected 1/,
  );
});

test('overlapping groups are rejected', () => {
  assert.throws(
    () =>
      renderSql({
        steps: [dropStep('a'), dropStep('b')],
        groups: [
          { start: 0, end: 2, transactional: true },
          { start: 1, end: 2, transactional: true },
        ],
      }),
    /group 1 starts at 1, expected 2/,
  );
});

test('an empty group range is rejected', () => {
  assert.throws(
    () =>
      renderSql({
        steps: [dropStep('a')],
        groups: [{ start: 0, end: 0, transactional: false }],
      }),
    /group 0 spans \[0, 0\)/,
  );
});

test('a partition that stops before the last step is rejected', () => {
  assert.throws(
    () =>
      renderSql({
        steps: [dropStep('a'), dropStep('b')],
        groups: [{ start: 0, end: 1, transactional: true }],
      }),
    /plan\.groups must tile \[0, 2\), but the groups end at 1/,
  );
});

test('groups without steps are rejected', () => {
  assert.throws(
    () => renderSql({ steps: [], groups: [{ start: 0, end: 1, transactional: true }] }),
    /plan\.groups must be empty when plan\.steps is empty, but found groups \[0, 1\)/,
  );
});

test('identifiers are quoted only when PostgreSQL needs it', () => {
  assert.equal(
    renderSql(
      planOf({
        kind: 'create-table',
        table: {
          schema: 'app',
          name: 'user',
          columns: [
            { name: 'Mixed Case', type: 'text', notNull: false },
            { name: 'we"ird', type: 'text', notNull: false },
            { name: '9lives', type: 'text', notNull: false },
            { name: 'lower_case$1', type: 'text', notNull: false },
          ],
          foreignKeys: [],
          uniqueConstraints: [],
          checkConstraints: [],
          indexes: [],
        },
      }),
    ),
    [
      'BEGIN;',
      'CREATE TABLE app."user" (',
      '    "Mixed Case" text,',
      '    "we""ird" text,',
      '    "9lives" text,',
      '    lower_case$1 text',
      ');',
      'COMMIT;',
      '',
    ].join('\n'),
  );

  // A reserved word is quoted in every position, including the schema.
  assert.equal(
    renderSql(planOf({ kind: 'drop-table', table: { schema: 'user', name: 'select' } })),
    'BEGIN;\nDROP TABLE "user"."select";\nCOMMIT;\n',
  );
});

test('a foreign key without referenced columns omits the column list', () => {
  assert.equal(
    renderSql(
      planOf({
        kind: 'add-foreign-key',
        table: identity('t'),
        foreignKey: foreignKey(['parent_id'], identity('parent'), { name: 't_parent_id_fkey' }),
      }),
    ),
    'BEGIN;\nALTER TABLE public.t ADD CONSTRAINT t_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.parent;\nCOMMIT;\n',
  );
});

test("unnamed constraints drop under PostgreSQL's conventional names", () => {
  assert.equal(
    renderSql(
      planOf(
        { kind: 'drop-primary-key', table: identity('t'), primaryKey: { columns: ['id'] } },
        {
          kind: 'drop-foreign-key',
          table: identity('orders'),
          foreignKey: foreignKey(['user_id', 'tenant_id'], identity('users')),
        },
        {
          kind: 'drop-primary-key',
          table: identity('Mixed Case'),
          primaryKey: { columns: ['id'] },
        },
      ),
    ),
    [
      'BEGIN;',
      'ALTER TABLE public.t DROP CONSTRAINT t_pkey;',
      'ALTER TABLE public.orders DROP CONSTRAINT orders_user_id_tenant_id_fkey;',
      'ALTER TABLE public."Mixed Case" DROP CONSTRAINT "Mixed Case_pkey";',
      'COMMIT;',
      '',
    ].join('\n'),
  );
});

test('renders unique and check constraint adds and drops, naming only when stated', () => {
  assert.equal(
    renderSql(
      planOf(
        {
          kind: 'add-unique-constraint',
          table: identity('t'),
          uniqueConstraint: uniqueConstraint(['a'], { name: 't_a_key' }),
        },
        {
          kind: 'add-unique-constraint',
          table: identity('t'),
          uniqueConstraint: uniqueConstraint(['a', 'b']),
        },
        {
          kind: 'add-check-constraint',
          table: identity('t'),
          checkConstraint: checkConstraint('(age >= 0) AND(age < 150)', { name: 't_age_check' }),
        },
        {
          kind: 'add-check-constraint',
          table: identity('t'),
          checkConstraint: checkConstraint("name <> ''"),
        },
        {
          kind: 'drop-unique-constraint',
          table: identity('t'),
          uniqueConstraint: uniqueConstraint(['a']),
        },
        {
          kind: 'drop-check-constraint',
          table: identity('t'),
          checkConstraint: checkConstraint('a > b'),
        },
        {
          kind: 'drop-unique-constraint',
          table: { schema: 'app', name: 'Order' },
          uniqueConstraint: uniqueConstraint(['Mixed Case'], { name: 'we"ird' }),
        },
      ),
    ),
    [
      'BEGIN;',
      'ALTER TABLE public.t ADD CONSTRAINT t_a_key UNIQUE (a);',
      'ALTER TABLE public.t ADD UNIQUE (a, b);',
      'ALTER TABLE public.t ADD CONSTRAINT t_age_check CHECK ((age >= 0) AND(age < 150));',
      "ALTER TABLE public.t ADD CHECK (name <> '');",
      'ALTER TABLE public.t DROP CONSTRAINT t_a_key;',
      'ALTER TABLE public.t DROP CONSTRAINT t_check;',
      'ALTER TABLE app."Order" DROP CONSTRAINT "we""ird";',
      'COMMIT;',
      '',
    ].join('\n'),
  );
});

test("unnamed check drops synthesize PostgreSQL's conventional column name", () => {
  // PostgreSQL names a check constraint <table>_<column>_check when the expression references
  // exactly one distinct column, whatever else the expression contains; the scan here is
  // lexical and best-effort, so function names, cast types, and key words never count.
  const cases: readonly (readonly [string, string])[] = [
    ['age >= 0', 't_age_check'],
    ['(age >= 0)', 't_age_check'],
    ['age IS NOT NULL', 't_age_check'],
    ['age > 0 AND age < 150', 't_age_check'],
    ['length(email) > 3', 't_email_check'],
    ["upper(name) = 'X'", 't_name_check'],
    ['COALESCE(age, 0) > 0', 't_age_check'],
    ["age::text <> ''", 't_age_check'],
    ['CAST(age AS integer) > 0', 't_age_check'],
    ['age <> $tag$note$tag$', 't_age_check'],
    ['a > b', 't_check'],
    ['age > 0 AND score > 0', 't_check'],
    ['"Mixed Case" > 0', '"t_Mixed Case_check"'],
  ];

  for (const [expression, name] of cases) {
    assert.equal(
      renderSql(
        planOf({
          kind: 'drop-check-constraint',
          table: identity('t'),
          checkConstraint: checkConstraint(expression),
        }),
      ),
      `BEGIN;\nALTER TABLE public.t DROP CONSTRAINT ${name};\nCOMMIT;\n`,
      expression,
    );
  }
});

test('renders index creates and drops, named or unnamed, unique or not', () => {
  assert.equal(
    renderSql(
      planOf(
        {
          kind: 'create-index',
          table: identity('t'),
          index: tableIndex(['a'], { name: 't_a_idx' }),
        },
        {
          kind: 'create-index',
          table: identity('t'),
          index: tableIndex(['a', 'b'], { unique: true }),
        },
        {
          kind: 'drop-index',
          table: identity('t'),
          index: tableIndex(['a'], { name: 't_a_idx' }),
        },
        {
          kind: 'drop-index',
          table: identity('t'),
          index: tableIndex(['a', 'b']),
        },
        {
          kind: 'create-index',
          table: { schema: 'app', name: 'Order' },
          index: tableIndex(['Mixed Case'], { name: 'we"ird' }),
        },
      ),
    ),
    [
      'BEGIN;',
      'CREATE INDEX t_a_idx ON public.t USING btree (a);',
      'CREATE UNIQUE INDEX ON public.t USING btree (a, b);',
      'DROP INDEX t_a_idx;',
      'DROP INDEX t_a_b_idx;',
      'CREATE INDEX "we""ird" ON app."Order" USING btree ("Mixed Case");',
      'COMMIT;',
      '',
    ].join('\n'),
  );
});

test('renders concurrent index kinds bare, one standalone group each', () => {
  const concurrentDrop: Step = {
    kind: 'drop-index-concurrently',
    table: identity('t'),
    index: tableIndex(['a'], { name: 't_old_idx', concurrently: true }),
  };
  const concurrentCreate: Step = {
    kind: 'create-index-concurrently',
    table: identity('t'),
    index: tableIndex(['a', 'b'], { unique: true, name: 't_new_idx', concurrently: true }),
  };

  // A single standalone group stays one bare statement, with no separator.
  assert.equal(
    renderSql({ steps: [concurrentCreate], groups: [{ start: 0, end: 1, transactional: false }] }),
    'CREATE UNIQUE INDEX CONCURRENTLY t_new_idx ON public.t USING btree (a, b);\n',
  );
  // Two standalone groups are separated by a blank line, like any other group pair.
  assert.equal(
    renderSql({
      steps: [concurrentDrop, concurrentCreate],
      groups: [
        { start: 0, end: 1, transactional: false },
        { start: 1, end: 2, transactional: false },
      ],
    }),
    'DROP INDEX CONCURRENTLY t_old_idx;\n\nCREATE UNIQUE INDEX CONCURRENTLY t_new_idx ON public.t USING btree (a, b);\n',
  );
});

test('binds the SqlRenderer seam', () => {
  const baseline = model();
  const target = model(table('t', { columns: [column('id', { type: 'integer', notNull: true })] }));
  const expected = [
    'BEGIN;',
    'CREATE TABLE public.t (',
    '    id integer NOT NULL',
    ');',
    'COMMIT;',
    '',
  ].join('\n');

  assert.equal(renderSql(plan(baseline, target)), expected);
  assert.equal(sqlRenderer.render(plan(baseline, target)), expected);
});

test('golden: creates every table and attaches foreign keys last', () => {
  const accounts = table('accounts', {
    columns: [
      column('id', { type: 'bigint', notNull: true }),
      column('balance', { type: 'numeric(12,2)', notNull: true, default: '0' }),
    ],
    primaryKey: { name: 'accounts_pkey', columns: ['id'] },
  });
  const orders = table('orders', {
    columns: [
      column('id', { type: 'bigint', notNull: true }),
      column('user', { type: 'bigint' }),
      column('total', { type: 'numeric(12,2)', default: '0' }),
    ],
    primaryKey: { name: 'orders_pkey', columns: ['id'] },
    foreignKeys: [
      foreignKey(['user'], identity('users'), {
        name: 'orders_user_fkey',
        referencedColumns: ['id'],
        onDelete: 'CASCADE',
      }),
    ],
  });
  const users = table('users', {
    columns: [
      column('id', { type: 'bigint', notNull: true }),
      column('Mixed Case', { notNull: true, default: "'x'" }),
    ],
    primaryKey: { name: 'users_pkey', columns: ['id'] },
  });

  assertGolden('create-table', model(), model(orders, users, accounts));
});

test('golden: alters columns, primary key, and foreign keys', () => {
  const events = table('events', {
    columns: [column('id', { type: 'bigint', notNull: true })],
    primaryKey: { name: 'events_pkey', columns: ['id'] },
  });
  const mail = table('mail', {
    columns: [column('id', { type: 'bigint', notNull: true })],
    primaryKey: { name: 'mail_pkey', columns: ['id'] },
  });
  const names = table('names', {
    columns: [column('id', { type: 'bigint', notNull: true })],
    primaryKey: { name: 'names_pkey', columns: ['id'] },
  });
  const users = table('users', {
    columns: [
      column('id', { type: 'bigint', notNull: true }),
      column('name', { type: 'character varying(12)' }),
      column('email', { type: 'character varying(12)' }),
      column('legacy', { type: 'integer', default: '1' }),
      column('mail_id', { type: 'bigint' }),
      column('name_id', { type: 'bigint' }),
    ],
    primaryKey: { name: 'users_pkey', columns: ['id'] },
    foreignKeys: [
      foreignKey(['mail_id'], identity('mail'), {
        name: 'users_mail_id_fkey',
        referencedColumns: ['id'],
      }),
      foreignKey(['name_id'], identity('names'), {
        name: 'users_name_id_fkey',
        referencedColumns: ['id'],
      }),
    ],
  });
  const usersTarget = table('users', {
    columns: [
      column('id', { type: 'bigint', notNull: true }),
      column('name', { notNull: true }),
      column('email', { type: 'character varying(24)' }),
      column('created_at', { type: 'timestamp with time zone', default: 'now()' }),
      column('mail_id', { type: 'bigint' }),
      column('event_id', { type: 'bigint' }),
    ],
    primaryKey: { columns: ['id'] },
    foreignKeys: [
      foreignKey(['mail_id'], identity('mail'), {
        name: 'users_mail_id_fkey',
        referencedColumns: ['id'],
        onDelete: 'CASCADE',
      }),
      foreignKey(['event_id'], identity('events'), {
        name: 'users_event_id_fkey',
        referencedColumns: ['id'],
      }),
    ],
  });

  assertGolden(
    'alter-table',
    model(events, mail, names, users),
    model(events, mail, names, usersTarget),
  );
});

test('golden: changes primary keys under surviving foreign keys', () => {
  const c = table('c', {
    columns: [column('id', { type: 'integer', notNull: true })],
    primaryKey: { name: 'c_pkey', columns: ['id'] },
  });
  const eKey = foreignKey(['c_id'], identity('c'), {
    name: 'e_c_id_fkey',
    referencedColumns: ['id'],
  });
  const e = table('e', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('c_id', { type: 'integer' }),
    ],
    primaryKey: { name: 'e_pkey', columns: ['id'] },
    foreignKeys: [eKey],
  });
  const fKey = foreignKey(['c_id'], identity('c'), { name: 'f_c_id_fkey' });
  const f = table('f', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('c_id', { type: 'integer' }),
    ],
    primaryKey: { name: 'f_pkey', columns: ['id'] },
    foreignKeys: [fKey],
  });
  const p = table('p', {
    columns: [
      column('a', { type: 'integer', notNull: true }),
      column('b', { type: 'integer', notNull: true }),
    ],
    primaryKey: { name: 'p_pkey', columns: ['a', 'b'] },
  });
  const qKey = foreignKey(['pa', 'pb'], identity('p'), {
    name: 'q_p_fkey',
    referencedColumns: ['a', 'b'],
  });
  const q = table('q', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('pa', { type: 'integer' }),
      column('pb', { type: 'integer' }),
    ],
    primaryKey: { name: 'q_pkey', columns: ['id'] },
    foreignKeys: [qKey],
  });
  const tKey = foreignKey(['parent_id'], identity('t'), {
    name: 't_parent_id_fkey',
    referencedColumns: ['id'],
  });
  const t = table('t', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('parent_id', { type: 'integer' }),
    ],
    primaryKey: { name: 't_pkey', columns: ['id'] },
    foreignKeys: [tKey],
  });

  const cTarget = { ...c, primaryKey: { name: 'c_pkey_v2', columns: ['id'] } };
  const pTarget = { ...p, primaryKey: { name: 'p_pkey_v2', columns: ['b', 'a'] } };
  const tTarget = { ...t, primaryKey: { name: 't_pkey_v2', columns: ['id'] } };

  assertGolden(
    'primary-key-change',
    model(c, e, f, p, q, t),
    model(cTarget, e, f, pTarget, q, tTarget),
  );
});

test('golden: drops tables in dependency order, breaking a cycle', () => {
  const a = table('a', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('b_id', { type: 'integer' }),
    ],
    primaryKey: { name: 'a_pkey', columns: ['id'] },
    foreignKeys: [
      foreignKey(['b_id'], identity('b'), { name: 'a_b_id_fkey', referencedColumns: ['id'] }),
    ],
  });
  const b = table('b', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('a_id', { type: 'integer' }),
    ],
    primaryKey: { name: 'b_pkey', columns: ['id'] },
    foreignKeys: [
      foreignKey(['a_id'], identity('a'), { name: 'b_a_id_fkey', referencedColumns: ['id'] }),
    ],
  });
  const child = table('child', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('parent_id', { type: 'integer' }),
    ],
    primaryKey: { name: 'child_pkey', columns: ['id'] },
    foreignKeys: [
      foreignKey(['parent_id'], identity('parent'), {
        name: 'child_parent_id_fkey',
        referencedColumns: ['id'],
      }),
    ],
  });
  const node = table('node', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('parent_id', { type: 'integer' }),
    ],
    primaryKey: { name: 'node_pkey', columns: ['id'] },
    foreignKeys: [
      foreignKey(['parent_id'], identity('node'), {
        name: 'node_parent_id_fkey',
        referencedColumns: ['id'],
      }),
    ],
  });
  const parent = table('parent', {
    columns: [column('id', { type: 'integer', notNull: true })],
    primaryKey: { name: 'parent_pkey', columns: ['id'] },
  });

  assertGolden('drop-table', model(a, b, child, node, parent), model());
});

test('golden: renders a full mixed migration', () => {
  const { baseline, target } = mixedScene();

  assertGolden('mixed', baseline, target);
});

test('structurally equal models in any insertion order render the same SQL', () => {
  const first = mixedScene();
  const second = mixedScene(true);

  const firstSql = renderSql(plan(first.baseline, first.target));
  const secondSql = renderSql(plan(second.baseline, second.target));

  assert.equal(firstSql, secondSql);
  assert.match(firstSql, /ALTER TABLE public\.sessions ADD CONSTRAINT sessions_user_id_fkey/);
});

test('renders CREATE SEQUENCE with every effective option, exactly', () => {
  assert.equal(
    renderSql(
      planOf({
        kind: 'create-sequence',
        sequence: sequence('s', {
          increment: '-2',
          minValue: '1',
          maxValue: '9223372036854775807',
          start: '9007199254740993',
          cache: '2147483647',
          cycle: true,
        }),
      }),
    ),
    'BEGIN;\nCREATE SEQUENCE public.s AS bigint INCREMENT BY -2 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 9007199254740993 CACHE 2147483647 CYCLE;\nCOMMIT;\n',
  );
});

test('renders one ALTER SEQUENCE statement carrying every changed field, in order', () => {
  assert.equal(
    renderSql(
      planOf({
        kind: 'alter-sequence',
        sequence: identity('s'),
        fields: [
          { field: 'dataType', before: 'smallint', after: 'integer' },
          { field: 'increment', before: '1', after: '2' },
          { field: 'minValue', before: '1', after: '0' },
          { field: 'maxValue', before: '100', after: '200' },
          { field: 'start', before: '1', after: '5' },
          { field: 'cache', before: '1', after: '4' },
          { field: 'cycle', before: false, after: true },
        ],
      }),
    ),
    'BEGIN;\nALTER SEQUENCE public.s AS integer INCREMENT BY 2 MINVALUE 0 MAXVALUE 200 START WITH 5 CACHE 4 CYCLE;\nCOMMIT;\n',
  );
});

test('renders the AS conversion and the bounds it would move in one statement', () => {
  // The exact repro shape: `AS bigint` alone would rewrite the baseline's integer maximum to
  // bigint's, so the statement restates the target's maximum after the type change.
  const baseline = sequenceModel([sequence('s', { dataType: 'integer', maxValue: '2147483647' })]);
  const target = sequenceModel([sequence('s', { maxValue: '2147483647' })]);

  assert.equal(
    renderSql(plan(baseline, target)),
    'BEGIN;\nALTER SEQUENCE public.s AS bigint MAXVALUE 2147483647;\nCOMMIT;\n',
  );
});

test('renders ownership changes as OWNED BY and OWNED BY NONE', () => {
  assert.equal(
    renderSql(
      planOf({
        kind: 'alter-sequence',
        sequence: identity('s'),
        fields: [{ field: 'ownedBy', before: owner('old', 'id'), after: owner('new', 'id') }],
      }),
    ),
    'BEGIN;\nALTER SEQUENCE public.s OWNED BY public.new.id;\nCOMMIT;\n',
  );
  assert.equal(
    renderSql(
      planOf({
        kind: 'alter-sequence',
        sequence: identity('s'),
        fields: [{ field: 'ownedBy', before: owner('old', 'id') }],
      }),
    ),
    'BEGIN;\nALTER SEQUENCE public.s OWNED BY NONE;\nCOMMIT;\n',
  );
  assert.equal(
    renderSql(
      planOf({
        kind: 'alter-sequence',
        sequence: identity('s'),
        fields: [{ field: 'ownedBy', after: owner('new', 'id') }],
      }),
    ),
    'BEGIN;\nALTER SEQUENCE public.s OWNED BY public.new.id;\nCOMMIT;\n',
  );
});

test('quotes sequence and owner identifiers only when PostgreSQL needs it', () => {
  assert.equal(
    renderSql(planOf({ kind: 'drop-sequence', sequence: { schema: 'user', name: 'select' } })),
    'BEGIN;\nDROP SEQUENCE "user"."select";\nCOMMIT;\n',
  );
  assert.equal(
    renderSql(
      planOf({
        kind: 'alter-sequence',
        sequence: { schema: 'public', name: 'Mixed Case' },
        fields: [{ field: 'ownedBy', after: owner('Order', 'we"ird') }],
      }),
    ),
    'BEGIN;\nALTER SEQUENCE public."Mixed Case" OWNED BY public."Order"."we""ird";\nCOMMIT;\n',
  );
});

test('golden: a sequence lifecycle renders create, attach, alter, re-own, and drop', () => {
  const t = table('t', {
    columns: [column('id', { type: 'bigint', notNull: true }), column('x', { type: 'bigint' })],
  });
  const baseline = sequenceModel(
    [sequence('s', { ownedBy: owner('t', 'id') }), sequence('gone')],
    t,
  );
  const target = sequenceModel([sequence('s', { increment: '5', ownedBy: owner('t', 'x') })], t);

  assert.equal(
    renderSql(plan(baseline, target)),
    [
      'BEGIN;',
      'ALTER SEQUENCE public.s OWNED BY public.t.x;',
      'ALTER SEQUENCE public.s INCREMENT BY 5;',
      'DROP SEQUENCE public.gone;',
      'COMMIT;',
      '',
    ].join('\n'),
  );
});

test('structurally equal models with sequences in any insertion order render the same SQL', () => {
  const t = table('t', { columns: [column('id', { type: 'bigint', notNull: true })] });
  const baselineSequences = [sequence('a', { ownedBy: owner('t', 'id') }), sequence('b')];
  const baseline = sequenceModel(baselineSequences, t);
  const reversed = sequenceModel([...baselineSequences].reverse(), t);
  const target = sequenceModel([sequence('a', { increment: '9' })], t);

  const first = renderSql(plan(baseline, target));
  const second = renderSql(plan(reversed, target));

  assert.equal(first, second);
  assert.match(first, /^ALTER SEQUENCE public\.a OWNED BY NONE;/m);
  assert.match(first, /^ALTER SEQUENCE public\.a INCREMENT BY 9;/m);
  assert.match(first, /^DROP SEQUENCE public\.b;/m);
});

test('renders ADD GENERATED in full-explicit form, with the name only when modeled', () => {
  assert.equal(
    renderSql(
      planOf({
        kind: 'add-identity',
        table: identity('t'),
        name: 'id',
        identity: identityColumn({
          increment: '2',
          start: '5',
          cache: '10',
          cycle: true,
          sequenceName: identity('t_id_seq'),
        }),
      }),
    ),
    'BEGIN;\nALTER TABLE public.t ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY ( SEQUENCE NAME public.t_id_seq INCREMENT BY 2 MINVALUE 1 MAXVALUE 2147483647 START WITH 5 CACHE 10 CYCLE );\nCOMMIT;\n',
  );
  assert.equal(
    renderSql(
      planOf({
        kind: 'add-identity',
        table: identity('t'),
        name: 'id',
        identity: identityColumn({ generated: 'by default' }),
      }),
    ),
    'BEGIN;\nALTER TABLE public.t ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY ( INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1 NO CYCLE );\nCOMMIT;\n',
  );
});

test('renders one ALTER identity statement carrying every changed field, in order', () => {
  assert.equal(
    renderSql(
      planOf({
        kind: 'alter-identity',
        table: identity('t'),
        name: 'id',
        fields: [
          { field: 'generated', before: 'by default', after: 'always' },
          { field: 'increment', before: '1', after: '5' },
          { field: 'minValue', before: '1', after: '2' },
          { field: 'maxValue', before: '100', after: '200' },
          { field: 'start', before: '1', after: '3' },
          { field: 'cache', before: '1', after: '4' },
          { field: 'cycle', before: true, after: false },
        ],
      }),
    ),
    'BEGIN;\nALTER TABLE public.t ALTER COLUMN id SET GENERATED ALWAYS SET INCREMENT BY 5 SET MINVALUE 2 SET MAXVALUE 200 SET START WITH 3 SET CACHE 4 SET NO CYCLE;\nCOMMIT;\n',
  );
});

test('renders DROP IDENTITY and quotes identity identifiers only when needed', () => {
  assert.equal(
    renderSql(planOf({ kind: 'drop-identity', table: identity('t'), name: 'id' })),
    'BEGIN;\nALTER TABLE public.t ALTER COLUMN id DROP IDENTITY;\nCOMMIT;\n',
  );
  assert.equal(
    renderSql(
      planOf({
        kind: 'add-identity',
        table: { schema: 'user', name: 'select' },
        name: 'Mixed Case',
        identity: identityColumn({
          generated: 'by default',
          sequenceName: { schema: 'user', name: 'select' },
        }),
      }),
    ),
    'BEGIN;\nALTER TABLE "user"."select" ALTER COLUMN "Mixed Case" ADD GENERATED BY DEFAULT AS IDENTITY ( SEQUENCE NAME "user"."select" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1 NO CYCLE );\nCOMMIT;\n',
  );
  assert.equal(
    renderSql(
      planOf({
        kind: 'alter-identity',
        table: { schema: 'user', name: 'select' },
        name: 'we"ird',
        fields: [{ field: 'increment', before: '1', after: '2' }],
      }),
    ),
    'BEGIN;\nALTER TABLE "user"."select" ALTER COLUMN "we""ird" SET INCREMENT BY 2;\nCOMMIT;\n',
  );
});

test('identity columns render plain and their identity arrives in its own statement', () => {
  const descriptor = identityColumn({ sequenceName: identity('t_id_seq') });
  const target = model(
    table('t', {
      columns: [column('id', { type: 'integer', notNull: true, identity: descriptor })],
    }),
  );

  assert.equal(
    renderSql(plan(model(), target)),
    [
      'BEGIN;',
      'CREATE TABLE public.t (',
      '    id integer NOT NULL',
      ');',
      'ALTER TABLE public.t ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY ( SEQUENCE NAME public.t_id_seq INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1 NO CYCLE );',
      'COMMIT;',
      '',
    ].join('\n'),
  );
  assert.equal(
    renderSql(
      plan(
        model(table('t')),
        model(
          table('t', {
            columns: [column('id', { type: 'integer', notNull: true, identity: descriptor })],
          }),
        ),
      ),
    ),
    [
      'BEGIN;',
      'ALTER TABLE public.t ADD COLUMN id integer NOT NULL;',
      'ALTER TABLE public.t ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY ( SEQUENCE NAME public.t_id_seq INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1 NO CYCLE );',
      'COMMIT;',
      '',
    ].join('\n'),
  );
});

test('renders both identity conversions in policy order', () => {
  const serialDefault = "nextval('t_id_seq'::regclass)";
  const serial = {
    tables: [
      table('t', {
        columns: [column('id', { type: 'integer', notNull: true, default: serialDefault })],
      }),
    ],
    sequences: [sequence('t_id_seq', { dataType: 'integer', ownedBy: owner('t', 'id') })],
  };
  const identityTarget = model(
    table('t', {
      columns: [
        column('id', {
          type: 'integer',
          notNull: true,
          identity: identityColumn({ sequenceName: identity('t_id_seq') }),
        }),
      ],
    }),
  );

  assert.equal(
    renderSql(plan(serial, identityTarget)),
    [
      'BEGIN;',
      'ALTER TABLE public.t ALTER COLUMN id DROP DEFAULT;',
      'DROP SEQUENCE public.t_id_seq;',
      'ALTER TABLE public.t ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY ( SEQUENCE NAME public.t_id_seq INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1 NO CYCLE );',
      'COMMIT;',
      '',
    ].join('\n'),
  );

  const serialTarget = {
    tables: [
      table('t', {
        columns: [column('id', { type: 'integer', notNull: true, default: serialDefault })],
      }),
    ],
    sequences: [sequence('t_id_seq', { dataType: 'integer' })],
  };

  assert.equal(
    renderSql(plan(identityTarget, serialTarget)),
    [
      'BEGIN;',
      'ALTER TABLE public.t ALTER COLUMN id DROP IDENTITY;',
      'CREATE SEQUENCE public.t_id_seq AS integer INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1 NO CYCLE;',
      "ALTER TABLE public.t ALTER COLUMN id SET DEFAULT nextval('t_id_seq'::regclass);",
      'COMMIT;',
      '',
    ].join('\n'),
  );
});

test('golden: adds, alters, and drops identities beside plain column DDL', () => {
  const users = table('users', {
    columns: [
      column('id', {
        type: 'integer',
        notNull: true,
        identity: identityColumn({ sequenceName: identity('users_id_seq') }),
      }),
      column('legacy', { type: 'integer', notNull: true, identity: identityColumn() }),
    ],
  });
  const orders = table('orders', {
    columns: [
      column('id', {
        type: 'integer',
        notNull: true,
        identity: identityColumn({
          increment: '2',
          start: '5',
          cache: '10',
          cycle: true,
          sequenceName: identity('orders_id_seq'),
        }),
      }),
    ],
    primaryKey: { name: 'orders_pkey', columns: ['id'] },
  });
  const usersTarget = table('users', {
    columns: [
      column('id', {
        type: 'integer',
        notNull: true,
        identity: identityColumn({
          generated: 'by default',
          increment: '2',
          minValue: '0',
          maxValue: '99',
          start: '5',
          cache: '10',
          cycle: true,
          sequenceName: identity('users_id_seq'),
        }),
      }),
      column('legacy', { type: 'integer', notNull: true }),
      column('email', { type: 'integer', notNull: true, identity: identityColumn() }),
    ],
  });

  assertGolden('identity', model(users), model(orders, usersTarget));
});

test('golden: drops and adds unique and check constraints', () => {
  const columns = [
    column('id', { type: 'integer', notNull: true }),
    column('email'),
    column('name'),
    column('age', { type: 'integer' }),
  ];
  const baseline = model(
    table('users', {
      columns,
      uniqueConstraints: [
        uniqueConstraint(['age']),
        uniqueConstraint(['email'], { name: 'users_email_key' }),
      ],
      checkConstraints: [
        checkConstraint('age >= 0', { name: 'users_age_check' }),
        checkConstraint('age <= 150'),
      ],
    }),
  );
  const target = model(
    table('users', {
      columns,
      uniqueConstraints: [
        uniqueConstraint(['email'], { name: 'users_email_key' }),
        uniqueConstraint(['name'], { name: 'users_name_key' }),
      ],
      checkConstraints: [
        checkConstraint('age >= 18', { name: 'users_age_check' }),
        checkConstraint('age <= 150'),
      ],
    }),
  );

  assertGolden('constraints', baseline, target);
});

test('golden: creates, changes, and drops standalone indexes', () => {
  const columns = [
    column('id', { type: 'integer', notNull: true }),
    column('email'),
    column('name'),
    column('age', { type: 'integer' }),
    column('created_at', { type: 'timestamp with time zone' }),
  ];
  const baseline = model(
    table('users', {
      columns,
      indexes: [
        tableIndex(['email'], { name: 'users_email_idx' }),
        tableIndex(['age'], { name: 'users_age_idx' }),
      ],
    }),
  );
  const target = model(
    table('users', {
      columns,
      indexes: [
        tableIndex(['email'], { name: 'users_email_idx', unique: true }),
        tableIndex(['name'], { name: 'users_name_idx' }),
        tableIndex(['created_at']),
      ],
    }),
  );

  assertGolden('indexes', baseline, target);
});

test('golden: a concurrent index rebuild renders as bare standalone groups', () => {
  const columns = [column('id', { type: 'integer', notNull: true }), column('age')];
  const baseline = model(
    table('users', {
      columns,
      indexes: [tableIndex(['age'], { name: 'users_age_idx', concurrently: true })],
    }),
  );
  const target = model(
    table('users', {
      columns,
      indexes: [tableIndex(['age'], { name: 'users_age_idx_v2', concurrently: true })],
    }),
  );

  assertGolden('index-concurrent', baseline, target);
});

test('golden: a mixed multi-group plan separates its groups with blank lines', () => {
  const parent = table('parent', {
    columns: [column('id', { type: 'integer', notNull: true })],
    primaryKey: { name: 'parent_pkey', columns: ['id'] },
  });
  const child = table('child', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('parent_id', { type: 'integer' }),
    ],
    indexes: [tableIndex(['parent_id'], { name: 'child_old_idx' })],
  });
  const childTarget = table('child', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('parent_id', { type: 'integer' }),
    ],
    foreignKeys: [
      foreignKey(['parent_id'], identity('parent'), {
        name: 'child_parent_id_fkey',
        referencedColumns: ['id'],
      }),
    ],
    indexes: [tableIndex(['parent_id'], { name: 'child_new_idx', concurrently: true })],
  });

  assertGolden('multi-group', model(parent, child), model(parent, childTarget));
});

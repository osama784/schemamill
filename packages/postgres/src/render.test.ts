import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { plan } from '@schemamill/core';
import type {
  Column,
  ForeignKey,
  Model,
  Plan,
  PrimaryKey,
  Sequence,
  SequenceOwner,
  Step,
  Table,
  TableIdentity,
} from '@schemamill/core';

import { renderSql, sqlRenderer } from './index.ts';

/**
 * Tests for migration SQL rendering: the inline edge cases pin the quoting and statement
 * rules, the golden files pin five whole scenes, and the determinism test pins that only the
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
}

/** A table with the given identity: empty unless parts are supplied. */
const table = (name: string, parts: TableParts = {}): Table => ({
  schema: parts.schema ?? 'public',
  name,
  columns: parts.columns ?? [],
  ...(parts.primaryKey === undefined ? {} : { primaryKey: parts.primaryKey }),
  foreignKeys: parts.foreignKeys ?? [],
});

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

/** A sequence named `name`: bigint ascending defaults unless overridden. */
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
  maxValue: '9223372036854775807',
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

/** A model of the given sequences, with no tables unless they are supplied. */
const sequenceModel = (sequences: readonly Sequence[], ...tables: Table[]): Model => ({
  tables,
  sequences,
});

/** A plan of the given steps, for renderer edge cases. */
const planOf = (...steps: readonly Step[]): Plan => ({ steps });

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
  assert.equal(renderSql({ steps: [] }), '');
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
        },
      }),
    ),
    [
      'CREATE TABLE app."user" (',
      '    "Mixed Case" text,',
      '    "we""ird" text,',
      '    "9lives" text,',
      '    lower_case$1 text',
      ');',
      '',
    ].join('\n'),
  );

  // A reserved word is quoted in every position, including the schema.
  assert.equal(
    renderSql(planOf({ kind: 'drop-table', table: { schema: 'user', name: 'select' } })),
    'DROP TABLE "user"."select";\n',
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
    'ALTER TABLE public.t ADD CONSTRAINT t_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.parent;\n',
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
      'ALTER TABLE public.t DROP CONSTRAINT t_pkey;',
      'ALTER TABLE public.orders DROP CONSTRAINT orders_user_id_tenant_id_fkey;',
      'ALTER TABLE public."Mixed Case" DROP CONSTRAINT "Mixed Case_pkey";',
      '',
    ].join('\n'),
  );
});

test('binds the SqlRenderer seam', () => {
  const baseline = model();
  const target = model(table('t', { columns: [column('id', { type: 'integer', notNull: true })] }));
  const expected = ['CREATE TABLE public.t (', '    id integer NOT NULL', ');', ''].join('\n');

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
    'CREATE SEQUENCE public.s AS bigint INCREMENT BY -2 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 9007199254740993 CACHE 2147483647 CYCLE;\n',
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
    'ALTER SEQUENCE public.s AS integer INCREMENT BY 2 MINVALUE 0 MAXVALUE 200 START WITH 5 CACHE 4 CYCLE;\n',
  );
});

test('renders the AS conversion and the bounds it would move in one statement', () => {
  // The exact repro shape: `AS bigint` alone would rewrite the baseline's integer maximum to
  // bigint's, so the statement restates the target's maximum after the type change.
  const baseline = sequenceModel([sequence('s', { dataType: 'integer', maxValue: '2147483647' })]);
  const target = sequenceModel([sequence('s', { maxValue: '2147483647' })]);

  assert.equal(
    renderSql(plan(baseline, target)),
    'ALTER SEQUENCE public.s AS bigint MAXVALUE 2147483647;\n',
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
    'ALTER SEQUENCE public.s OWNED BY public.new.id;\n',
  );
  assert.equal(
    renderSql(
      planOf({
        kind: 'alter-sequence',
        sequence: identity('s'),
        fields: [{ field: 'ownedBy', before: owner('old', 'id') }],
      }),
    ),
    'ALTER SEQUENCE public.s OWNED BY NONE;\n',
  );
  assert.equal(
    renderSql(
      planOf({
        kind: 'alter-sequence',
        sequence: identity('s'),
        fields: [{ field: 'ownedBy', after: owner('new', 'id') }],
      }),
    ),
    'ALTER SEQUENCE public.s OWNED BY public.new.id;\n',
  );
});

test('quotes sequence and owner identifiers only when PostgreSQL needs it', () => {
  assert.equal(
    renderSql(planOf({ kind: 'drop-sequence', sequence: { schema: 'user', name: 'select' } })),
    'DROP SEQUENCE "user"."select";\n',
  );
  assert.equal(
    renderSql(
      planOf({
        kind: 'alter-sequence',
        sequence: { schema: 'public', name: 'Mixed Case' },
        fields: [{ field: 'ownedBy', after: owner('Order', 'we"ird') }],
      }),
    ),
    'ALTER SEQUENCE public."Mixed Case" OWNED BY public."Order"."we""ird";\n',
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
      'ALTER SEQUENCE public.s OWNED BY public.t.x;',
      'ALTER SEQUENCE public.s INCREMENT BY 5;',
      'DROP SEQUENCE public.gone;',
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

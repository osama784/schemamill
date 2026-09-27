import assert from 'node:assert/strict';
import { test } from 'node:test';

import { plan } from './index.ts';
import type { Column, ForeignKey, Model, PrimaryKey, Table, TableIdentity } from './model.ts';
import type { Step } from './plan.ts';

/**
 * Tests for the migration plan: the nine-phase order, dependency-ordered table drops, cycle
 * breaking, and determinism. Builders keep the fixtures small; expected values are complete
 * steps, asserted with `deepStrictEqual`.
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
const model = (...tables: Table[]): Model => ({ tables });

/** Asserts that planning `baseline` to `target` yields exactly `expected`. */
const assertPlan = (baseline: Model, target: Model, expected: readonly Step[]): void => {
  assert.deepStrictEqual(plan(baseline, target), { steps: expected });
};

/** Freezes `value` and every object and array nested inside it. */
const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
};

test('identical models produce an empty plan', () => {
  const users = table('users', {
    columns: [column('id', { type: 'bigint', notNull: true })],
    primaryKey: { name: 'users_pkey', columns: ['id'] },
    foreignKeys: [foreignKey(['id'], identity('profiles'), { referencedColumns: ['id'] })],
  });

  assertPlan(model(users), model(users), []);
});

test('an added table becomes a create-table step and trailing foreign-key steps', () => {
  const users = table('users', {
    columns: [column('id', { type: 'bigint', notNull: true })],
    primaryKey: { name: 'users_pkey', columns: ['id'] },
  });
  const ordersForeignKey = foreignKey(['user_id'], identity('users'), {
    name: 'orders_user_id_fkey',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  });
  const orders = table('orders', {
    columns: [
      column('id', { type: 'bigint', notNull: true }),
      column('user_id', { type: 'bigint' }),
    ],
    primaryKey: { columns: ['id'] },
    foreignKeys: [ordersForeignKey],
  });

  assertPlan(model(), model(orders, users), [
    {
      kind: 'create-table',
      table: {
        schema: 'public',
        name: 'orders',
        columns: [
          column('id', { type: 'bigint', notNull: true }),
          column('user_id', { type: 'bigint' }),
        ],
        primaryKey: { columns: ['id'] },
        foreignKeys: [],
      },
    },
    {
      kind: 'create-table',
      table: {
        schema: 'public',
        name: 'users',
        columns: [column('id', { type: 'bigint', notNull: true })],
        primaryKey: { name: 'users_pkey', columns: ['id'] },
        foreignKeys: [],
      },
    },
    { kind: 'add-foreign-key', table: identity('orders'), foreignKey: ordersForeignKey },
  ]);
});

test('a removed foreign key drops before the table it references', () => {
  const key = foreignKey(['user_id'], identity('users'), {
    name: 'orders_user_id_fkey',
    referencedColumns: ['id'],
  });
  const baseline = model(
    table('orders', { columns: [column('id'), column('user_id')], foreignKeys: [key] }),
    table('users', { columns: [column('id')] }),
  );
  const target = model(table('orders', { columns: [column('id'), column('user_id')] }));

  assertPlan(baseline, target, [
    { kind: 'drop-foreign-key', table: identity('orders'), foreignKey: key },
    { kind: 'drop-table', table: identity('users') },
  ]);
});

test('a removed reference chain drops dependents before the tables they reference', () => {
  const baseline = model(
    table('a_parent', { columns: [column('id')] }),
    table('m_middle', {
      columns: [column('id'), column('parent_id')],
      foreignKeys: [
        foreignKey(['parent_id'], identity('a_parent'), {
          name: 'm_middle_parent_id_fkey',
          referencedColumns: ['id'],
        }),
      ],
    }),
    table('z_child', {
      columns: [column('id'), column('middle_id')],
      foreignKeys: [
        foreignKey(['middle_id'], identity('m_middle'), {
          name: 'z_child_middle_id_fkey',
          referencedColumns: ['id'],
        }),
      ],
    }),
  );

  // The diff reports a_parent, m_middle, z_child; dependencies reverse that.
  assertPlan(baseline, model(), [
    { kind: 'drop-table', table: identity('z_child') },
    { kind: 'drop-table', table: identity('m_middle') },
    { kind: 'drop-table', table: identity('a_parent') },
  ]);
});

test('a removed reference cycle breaks deterministically before dropping', () => {
  const aForeignKey = foreignKey(['b_id'], identity('b'), {
    name: 'a_b_id_fkey',
    referencedColumns: ['id'],
  });
  const bForeignKey = foreignKey(['a_id'], identity('a'), {
    name: 'b_a_id_fkey',
    referencedColumns: ['id'],
  });
  const a = table('a', { columns: [column('id'), column('b_id')], foreignKeys: [aForeignKey] });
  const b = table('b', { columns: [column('id'), column('a_id')], foreignKeys: [bForeignKey] });
  const expected: readonly Step[] = [
    { kind: 'drop-foreign-key', table: identity('a'), foreignKey: aForeignKey },
    { kind: 'drop-table', table: identity('a') },
    { kind: 'drop-table', table: identity('b') },
  ];

  assertPlan(model(a, b), model(), expected);
  assertPlan(model(b, a), model(), expected);
});

test('a self-referencing removed table drops without a constraint drop', () => {
  const selfKey = foreignKey(['parent_id'], identity('nodes'), {
    name: 'nodes_parent_id_fkey',
    referencedColumns: ['id'],
  });
  const nodes = table('nodes', {
    columns: [column('id'), column('parent_id')],
    foreignKeys: [selfKey],
  });

  assertPlan(model(nodes), model(), [{ kind: 'drop-table', table: identity('nodes') }]);
});

test('a removed primary key drops before the column it covers', () => {
  const baseline = model(
    table('t', { columns: [column('id')], primaryKey: { name: 't_pkey', columns: ['id'] } }),
  );
  const target = model(table('t'));

  assertPlan(baseline, target, [
    {
      kind: 'drop-primary-key',
      table: identity('t'),
      primaryKey: { name: 't_pkey', columns: ['id'] },
    },
    { kind: 'drop-column', table: identity('t'), column: column('id') },
  ]);
});

test('a primary-key change splits into a drop before column work and an add after it', () => {
  const baseline = model(
    table('t', {
      columns: [column('a'), column('b')],
      primaryKey: { name: 't_pkey', columns: ['a'] },
    }),
  );
  const target = model(
    table('t', {
      columns: [column('b'), column('c')],
      primaryKey: { columns: ['c'] },
    }),
  );

  assertPlan(baseline, target, [
    {
      kind: 'drop-primary-key',
      table: identity('t'),
      primaryKey: { name: 't_pkey', columns: ['a'] },
    },
    { kind: 'drop-column', table: identity('t'), column: column('a') },
    { kind: 'add-column', table: identity('t'), column: column('c') },
    { kind: 'add-primary-key', table: identity('t'), primaryKey: { columns: ['c'] } },
  ]);
});

test('a changed foreign key drops in phase 1 and adds in phase 9, around column work', () => {
  const parent = identity('parent');
  const before = foreignKey(['parent_id'], parent, {
    name: 't_parent_id_fkey',
    referencedColumns: ['id'],
  });
  const after = foreignKey(['parent_id'], parent, {
    name: 't_parent_id_fkey',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  });
  const baseline = model(table('t', { columns: [column('parent_id')], foreignKeys: [before] }));
  const target = model(
    table('t', { columns: [column('parent_id'), column('label')], foreignKeys: [after] }),
  );

  assertPlan(baseline, target, [
    { kind: 'drop-foreign-key', table: identity('t'), foreignKey: before },
    { kind: 'add-column', table: identity('t'), column: column('label') },
    { kind: 'add-foreign-key', table: identity('t'), foreignKey: after },
  ]);
});

test('column payloads keep their exact contents', () => {
  const baseline = model(table('t', { columns: [column('a')] }));
  const target = model(
    table('t', {
      columns: [
        column('a', { type: 'character varying(12)', notNull: true, default: "'x'" }),
        column('b', { type: 'numeric(12,2)', notNull: false, default: '0' }),
      ],
    }),
  );

  assertPlan(baseline, target, [
    {
      kind: 'add-column',
      table: identity('t'),
      column: { name: 'b', type: 'numeric(12,2)', notNull: false, default: '0' },
    },
    {
      kind: 'alter-column',
      table: identity('t'),
      name: 'a',
      fields: [
        { field: 'type', before: 'text', after: 'character varying(12)' },
        { field: 'notNull', before: false, after: true },
        { field: 'default', after: "'x'" },
      ],
    },
  ]);
});

test('a mixed migration pins the exact step sequence across all nine phases', () => {
  const audit = table('audit', { columns: [column('id')] });
  const legacy = table('legacy', {
    columns: [column('id', { type: 'integer', notNull: true })],
    primaryKey: { name: 'legacy_pkey', columns: ['id'] },
  });
  const legacyNotes = table('legacy_notes', {
    columns: [column('id'), column('legacy_id')],
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
  const ordersForeignKey = foreignKey(['legacy_id'], identity('legacy'), {
    name: 'orders_legacy_id_fkey',
    referencedColumns: ['id'],
  });
  const orders = table('orders', {
    columns: [column('id'), column('legacy_id')],
    foreignKeys: [ordersForeignKey],
  });
  const obsoleteForeignKey = foreignKey(['obsolete'], identity('legacy'), {
    name: 'users_obsolete_fkey',
    referencedColumns: ['id'],
  });
  const groupForeignKeyBefore = foreignKey(['group_id'], identity('groups'), {
    name: 'users_group_id_fkey',
    referencedColumns: ['id'],
  });
  const groupForeignKeyAfter = foreignKey(['group_id'], identity('groups'), {
    name: 'users_group_id_fkey',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  });
  const users = table('users', {
    columns: [
      column('id'),
      column('name', { type: 'character varying(12)' }),
      column('obsolete'),
      column('group_id'),
    ],
    primaryKey: { name: 'users_pkey', columns: ['id'] },
    foreignKeys: [obsoleteForeignKey, groupForeignKeyBefore],
  });

  const ordersTarget = table('orders', { columns: [column('id'), column('legacy_id')] });
  const sessionsForeignKey = foreignKey(['user_id'], identity('users'), {
    name: 'sessions_user_id_fkey',
    referencedColumns: ['id'],
  });
  const sessions = table('sessions', {
    columns: [column('id'), column('user_id')],
    primaryKey: { name: 'sessions_pkey', columns: ['id'] },
    foreignKeys: [sessionsForeignKey],
  });
  const usersTarget = table('users', {
    columns: [column('id'), column('name'), column('group_id'), column('email')],
    primaryKey: { columns: ['id'] },
    foreignKeys: [groupForeignKeyAfter],
  });

  assertPlan(
    model(audit, legacy, legacyNotes, groups, orders, users),
    model(groups, ordersTarget, sessions, usersTarget),
    [
      { kind: 'drop-foreign-key', table: identity('orders'), foreignKey: ordersForeignKey },
      { kind: 'drop-foreign-key', table: identity('users'), foreignKey: obsoleteForeignKey },
      { kind: 'drop-foreign-key', table: identity('users'), foreignKey: groupForeignKeyBefore },
      {
        kind: 'drop-primary-key',
        table: identity('users'),
        primaryKey: { name: 'users_pkey', columns: ['id'] },
      },
      { kind: 'drop-column', table: identity('users'), column: column('obsolete') },
      { kind: 'drop-table', table: identity('audit') },
      { kind: 'drop-table', table: identity('legacy_notes') },
      { kind: 'drop-table', table: identity('legacy') },
      {
        kind: 'create-table',
        table: {
          schema: 'public',
          name: 'sessions',
          columns: [column('id'), column('user_id')],
          primaryKey: { name: 'sessions_pkey', columns: ['id'] },
          foreignKeys: [],
        },
      },
      { kind: 'add-column', table: identity('users'), column: column('email') },
      {
        kind: 'alter-column',
        table: identity('users'),
        name: 'name',
        fields: [{ field: 'type', before: 'character varying(12)', after: 'text' }],
      },
      {
        kind: 'add-primary-key',
        table: identity('users'),
        primaryKey: { columns: ['id'] },
      },
      {
        kind: 'add-foreign-key',
        table: identity('sessions'),
        foreignKey: sessionsForeignKey,
      },
      {
        kind: 'add-foreign-key',
        table: identity('users'),
        foreignKey: groupForeignKeyAfter,
      },
    ],
  );
});

test('structurally equal models in any insertion order produce deep-equal plans', () => {
  const groups = table('groups', {
    columns: [column('id')],
    primaryKey: { name: 'groups_pkey', columns: ['id'] },
  });
  const legacy = table('legacy', { columns: [column('id')] });
  const legacyNotes = table('legacy_notes', {
    columns: [column('id'), column('legacy_id')],
    foreignKeys: [foreignKey(['legacy_id'], identity('legacy'), { referencedColumns: ['id'] })],
  });
  const legacyKey = foreignKey(['legacy_id'], identity('legacy'), { referencedColumns: ['id'] });
  const groupKey = foreignKey(['group_id'], identity('groups'), { referencedColumns: ['id'] });
  const orders = (foreignKeys: readonly ForeignKey[]) =>
    table('orders', {
      columns: [column('id'), column('legacy_id'), column('group_id')],
      foreignKeys,
    });
  const aKey = foreignKey(['b_id'], identity('b'), { referencedColumns: ['id'] });
  const bKey = foreignKey(['a_id'], identity('a'), { referencedColumns: ['id'] });
  const a = table('a', { columns: [column('id'), column('b_id')], foreignKeys: [aKey] });
  const b = table('b', { columns: [column('id'), column('a_id')], foreignKeys: [bKey] });

  const firstBaseline = model(orders([legacyKey, groupKey]), a, b, legacy, legacyNotes, groups);
  const secondBaseline = model(groups, legacyNotes, legacy, b, orders([groupKey, legacyKey]), a);
  const firstTarget = model(orders([groupKey]), groups);
  const secondTarget = model(groups, orders([groupKey]));

  assert.deepStrictEqual(plan(firstBaseline, firstTarget), plan(secondBaseline, secondTarget));
});

test('a deep-frozen model can be planned, and steps carry independent copies', () => {
  const removed = table('u', { columns: [column('id')] });
  const selfKey = foreignKey(['a'], identity('t'), {
    name: 't_a_fkey',
    referencedColumns: ['id'],
  });
  const added = column('b', { type: 'integer', notNull: true, default: '1' });
  const baseline = deepFreeze(
    model(table('t', { columns: [column('a')], foreignKeys: [selfKey] }), removed),
  );
  const target = deepFreeze(model(table('t', { columns: [column('a'), added] })));

  const { steps } = plan(baseline, target);
  assert.deepStrictEqual(steps, [
    { kind: 'drop-foreign-key', table: identity('t'), foreignKey: selfKey },
    { kind: 'drop-table', table: identity('u') },
    { kind: 'add-column', table: identity('t'), column: added },
  ]);

  const [dropKey, dropTable, addColumn] = steps;
  assert.equal(dropKey?.kind, 'drop-foreign-key');
  if (dropKey?.kind === 'drop-foreign-key') {
    assert.notEqual(dropKey.foreignKey, selfKey);
    assert.notEqual(dropKey.foreignKey.columns, selfKey.columns);
    assert.notEqual(dropKey.foreignKey.referencedTable, selfKey.referencedTable);
    assert.notEqual(dropKey.foreignKey.referencedColumns, selfKey.referencedColumns);
  }
  assert.equal(dropTable?.kind, 'drop-table');
  if (dropTable?.kind === 'drop-table') assert.notEqual(dropTable.table, removed);
  assert.equal(addColumn?.kind, 'add-column');
  if (addColumn?.kind === 'add-column') assert.notEqual(addColumn.column, added);
});

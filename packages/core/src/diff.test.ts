import assert from 'node:assert/strict';
import { test } from 'node:test';

import { diff } from './index.ts';
import type { Change } from './diff.ts';
import type { Column, ForeignKey, Model, PrimaryKey, Table, TableIdentity } from './model.ts';

/**
 * Tests for the model diff: identity, no rename detection, text compared exactly as stored,
 * and the deterministic emission order. Builders keep the fixtures small; expected values are
 * complete objects, asserted with `deepStrictEqual`.
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

/** Freezes `value` and every object and array nested inside it. */
const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
};

/** Asserts that a table payload shares no object or array with its source table. */
const assertCopiedTable = (copy: Table, source: Table): void => {
  assert.notEqual(copy, source);
  assert.notEqual(copy.columns, source.columns);
  copy.columns.forEach((column, index) => assert.notEqual(column, source.columns[index]));
  if (source.primaryKey !== undefined) {
    assert.notEqual(copy.primaryKey, source.primaryKey);
    assert.notEqual(copy.primaryKey?.columns, source.primaryKey.columns);
  }
  assert.notEqual(copy.foreignKeys, source.foreignKeys);
  copy.foreignKeys.forEach((foreignKey, index) => {
    const sourceForeignKey = source.foreignKeys[index];
    assert.notEqual(foreignKey, sourceForeignKey);
    assert.notEqual(foreignKey.columns, sourceForeignKey?.columns);
    assert.notEqual(foreignKey.referencedTable, sourceForeignKey?.referencedTable);
    assert.notEqual(foreignKey.referencedColumns, sourceForeignKey?.referencedColumns);
  });
};

/** Asserts that diffing `baseline` with `target` yields exactly `expected`. */
const assertDiff = (baseline: Model, target: Model, expected: readonly Change[]) =>
  assert.deepStrictEqual(diff(baseline, target), expected);

test('identical models produce no changes', () => {
  const users = () =>
    table('users', {
      columns: [column('id', { type: 'bigint', notNull: true }), column('email')],
      primaryKey: { name: 'users_pkey', columns: ['id'] },
      foreignKeys: [foreignKey(['email'], identity('profiles'), { referencedColumns: ['email'] })],
    });

  assertDiff(model(users()), model(users()), []);
});

test('tables in different insertion orders compare as identical', () => {
  const baseline = model(
    table('a', { columns: [column('id')] }),
    table('b', { columns: [column('id')] }),
  );
  const target = model(
    table('b', { columns: [column('id')] }),
    table('a', { columns: [column('id')] }),
  );

  assertDiff(baseline, target, []);
});

test('an empty baseline adds every target table in identity order', () => {
  const orders = table('orders', { schema: 'app' });
  const accounts = table('accounts', { columns: [column('id')] });
  const users = table('users');
  const target = model(users, orders, accounts);

  assertDiff(model(), target, [
    { kind: 'table-added', table: orders },
    { kind: 'table-added', table: accounts },
    { kind: 'table-added', table: users },
  ]);
});

test('an empty target removes every baseline table in identity order', () => {
  const orders = table('orders', { schema: 'app' });
  const accounts = table('accounts', { columns: [column('id')] });
  const users = table('users');
  const baseline = model(users, orders, accounts);

  assertDiff(baseline, model(), [
    { kind: 'table-removed', table: orders },
    { kind: 'table-removed', table: accounts },
    { kind: 'table-removed', table: users },
  ]);
});

test('a changed table nests its column changes', () => {
  const baseline = model(
    table('users', { columns: [column('id', { type: 'bigint', notNull: true })] }),
  );
  const target = model(
    table('users', {
      columns: [column('id', { type: 'bigint', notNull: true }), column('email')],
    }),
  );

  assertDiff(baseline, target, [
    {
      kind: 'table-changed',
      table: identity('users'),
      changes: [{ kind: 'column-added', column: column('email') }],
    },
  ]);
});

test('an unchanged table between changes produces no entry', () => {
  const unchanged = table('b', { columns: [column('id')] });
  const baseline = model(table('a', { columns: [column('id')] }), unchanged);
  const target = model(
    table('a', { columns: [column('id', { notNull: true })] }),
    unchanged,
    table('c'),
  );

  assertDiff(baseline, target, [
    {
      kind: 'table-changed',
      table: identity('a'),
      changes: [
        {
          kind: 'column-changed',
          name: 'id',
          fields: [{ field: 'notNull', before: false, after: true }],
        },
      ],
    },
    { kind: 'table-added', table: table('c') },
  ]);
});

test('a column type change reports the type field', () => {
  const baseline = model(table('t', { columns: [column('c', { type: 'text' })] }));
  const target = model(table('t', { columns: [column('c', { type: 'bigint' })] }));

  assertDiff(baseline, target, [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [
        {
          kind: 'column-changed',
          name: 'c',
          fields: [{ field: 'type', before: 'text', after: 'bigint' }],
        },
      ],
    },
  ]);
});

test('a column notNull change reports the notNull field', () => {
  const baseline = model(table('t', { columns: [column('c')] }));
  const target = model(table('t', { columns: [column('c', { notNull: true })] }));

  assertDiff(baseline, target, [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [
        {
          kind: 'column-changed',
          name: 'c',
          fields: [{ field: 'notNull', before: false, after: true }],
        },
      ],
    },
  ]);
});

test('a default added reports only the target side', () => {
  const baseline = model(table('t', { columns: [column('c')] }));
  const target = model(table('t', { columns: [column('c', { default: 'now()' })] }));

  assertDiff(baseline, target, [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [
        { kind: 'column-changed', name: 'c', fields: [{ field: 'default', after: 'now()' }] },
      ],
    },
  ]);
});

test('a default removed reports only the baseline side', () => {
  const baseline = model(table('t', { columns: [column('c', { default: 'now()' })] }));
  const target = model(table('t', { columns: [column('c')] }));

  assertDiff(baseline, target, [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [
        { kind: 'column-changed', name: 'c', fields: [{ field: 'default', before: 'now()' }] },
      ],
    },
  ]);
});

test('a column change reports type, notNull, then default', () => {
  const baseline = model(table('t', { columns: [column('c', { type: 'text', default: '0' })] }));
  const target = model(table('t', { columns: [column('c', { type: 'bigint', notNull: true })] }));

  assertDiff(baseline, target, [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [
        {
          kind: 'column-changed',
          name: 'c',
          fields: [
            { field: 'type', before: 'text', after: 'bigint' },
            { field: 'notNull', before: false, after: true },
            { field: 'default', before: '0' },
          ],
        },
      ],
    },
  ]);
});

test('type and default text compare exactly as stored', () => {
  const baseline = model(
    table('t', { columns: [column('c', { type: 'numeric(12, 2)', default: 'now()' })] }),
  );
  const target = model(
    table('t', { columns: [column('c', { type: 'numeric(12,2)', default: ' now() ' })] }),
  );

  assertDiff(baseline, target, [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [
        {
          kind: 'column-changed',
          name: 'c',
          fields: [
            { field: 'type', before: 'numeric(12, 2)', after: 'numeric(12,2)' },
            { field: 'default', before: 'now()', after: ' now() ' },
          ],
        },
      ],
    },
  ]);
});

test('a primary key added or removed reports the whole key', () => {
  const columns = [column('id')];
  const withoutKey = model(table('t', { columns }));
  const withKey = model(table('t', { columns, primaryKey: { name: 't_pkey', columns: ['id'] } }));

  assertDiff(withoutKey, withKey, [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [{ kind: 'primary-key-added', primaryKey: { name: 't_pkey', columns: ['id'] } }],
    },
  ]);
  assertDiff(withKey, withoutKey, [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [{ kind: 'primary-key-removed', primaryKey: { name: 't_pkey', columns: ['id'] } }],
    },
  ]);
});

test('a primary key column list change reports before and after', () => {
  const baseline = model(
    table('t', {
      columns: [column('a'), column('b')],
      primaryKey: { name: 't_pkey', columns: ['a'] },
    }),
  );
  const target = model(
    table('t', {
      columns: [column('a'), column('b')],
      primaryKey: { name: 't_pkey', columns: ['a', 'b'] },
    }),
  );

  assertDiff(baseline, target, [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [
        {
          kind: 'primary-key-changed',
          before: { name: 't_pkey', columns: ['a'] },
          after: { name: 't_pkey', columns: ['a', 'b'] },
        },
      ],
    },
  ]);
});

test('a primary key column reorder is a change', () => {
  const baseline = model(
    table('t', { columns: [column('a'), column('b')], primaryKey: { columns: ['a', 'b'] } }),
  );
  const target = model(
    table('t', { columns: [column('a'), column('b')], primaryKey: { columns: ['b', 'a'] } }),
  );

  assertDiff(baseline, target, [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [
        {
          kind: 'primary-key-changed',
          before: { columns: ['a', 'b'] },
          after: { columns: ['b', 'a'] },
        },
      ],
    },
  ]);
});

test('a primary key name change is a change', () => {
  const unnamed = model(table('t', { columns: [column('id')], primaryKey: { columns: ['id'] } }));
  const named = model(
    table('t', { columns: [column('id')], primaryKey: { name: 't_pkey', columns: ['id'] } }),
  );
  const renamed = model(
    table('t', { columns: [column('id')], primaryKey: { name: 't_key', columns: ['id'] } }),
  );

  assertDiff(unnamed, named, [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [
        {
          kind: 'primary-key-changed',
          before: { columns: ['id'] },
          after: { name: 't_pkey', columns: ['id'] },
        },
      ],
    },
  ]);
  assertDiff(named, unnamed, [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [
        {
          kind: 'primary-key-changed',
          before: { name: 't_pkey', columns: ['id'] },
          after: { columns: ['id'] },
        },
      ],
    },
  ]);
  assertDiff(named, renamed, [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [
        {
          kind: 'primary-key-changed',
          before: { name: 't_pkey', columns: ['id'] },
          after: { name: 't_key', columns: ['id'] },
        },
      ],
    },
  ]);
});

test('a foreign key added or removed reports the whole constraint', () => {
  const key = foreignKey(['user_id'], identity('users'), {
    name: 't_user_id_fkey',
    referencedColumns: ['id'],
  });
  const withoutKey = model(table('t', { columns: [column('user_id')] }));
  const withKey = model(table('t', { columns: [column('user_id')], foreignKeys: [key] }));

  assertDiff(withoutKey, withKey, [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [{ kind: 'foreign-key-added', foreignKey: key }],
    },
  ]);
  assertDiff(withKey, withoutKey, [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [{ kind: 'foreign-key-removed', foreignKey: key }],
    },
  ]);
});

test('a foreign key onUpdate change reports before and after', () => {
  const parent = identity('parent');
  const baseline = model(
    table('t', {
      columns: [column('a')],
      foreignKeys: [foreignKey(['a'], parent, { referencedColumns: ['id'], onUpdate: 'CASCADE' })],
    }),
  );
  const target = model(
    table('t', {
      columns: [column('a')],
      foreignKeys: [foreignKey(['a'], parent, { referencedColumns: ['id'], onUpdate: 'RESTRICT' })],
    }),
  );

  assertDiff(baseline, target, [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [
        {
          kind: 'foreign-key-changed',
          before: foreignKey(['a'], parent, { referencedColumns: ['id'], onUpdate: 'CASCADE' }),
          after: foreignKey(['a'], parent, { referencedColumns: ['id'], onUpdate: 'RESTRICT' }),
        },
      ],
    },
  ]);
});

test('a foreign key onDelete change reports before and after', () => {
  const parent = identity('parent');
  const baseline = model(
    table('t', {
      columns: [column('a')],
      foreignKeys: [foreignKey(['a'], parent, { referencedColumns: ['id'] })],
    }),
  );
  const target = model(
    table('t', {
      columns: [column('a')],
      foreignKeys: [foreignKey(['a'], parent, { referencedColumns: ['id'], onDelete: 'SET NULL' })],
    }),
  );

  assertDiff(baseline, target, [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [
        {
          kind: 'foreign-key-changed',
          before: foreignKey(['a'], parent, { referencedColumns: ['id'] }),
          after: foreignKey(['a'], parent, { referencedColumns: ['id'], onDelete: 'SET NULL' }),
        },
      ],
    },
  ]);
});

test('referenced columns empty and present differ', () => {
  const parent = identity('parent');
  const baseline = model(
    table('t', { columns: [column('a')], foreignKeys: [foreignKey(['a'], parent)] }),
  );
  const target = model(
    table('t', {
      columns: [column('a')],
      foreignKeys: [foreignKey(['a'], parent, { referencedColumns: ['id'] })],
    }),
  );

  assertDiff(baseline, target, [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [
        {
          kind: 'foreign-key-changed',
          before: foreignKey(['a'], parent),
          after: foreignKey(['a'], parent, { referencedColumns: ['id'] }),
        },
      ],
    },
  ]);
});

test('referenced column order is part of the change', () => {
  const parent = identity('parent');
  const baseline = model(
    table('t', {
      columns: [column('a')],
      foreignKeys: [foreignKey(['a'], parent, { referencedColumns: ['a', 'b'] })],
    }),
  );
  const target = model(
    table('t', {
      columns: [column('a')],
      foreignKeys: [foreignKey(['a'], parent, { referencedColumns: ['b', 'a'] })],
    }),
  );

  assertDiff(baseline, target, [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [
        {
          kind: 'foreign-key-changed',
          before: foreignKey(['a'], parent, { referencedColumns: ['a', 'b'] }),
          after: foreignKey(['a'], parent, { referencedColumns: ['b', 'a'] }),
        },
      ],
    },
  ]);
});

test('a foreign key name change is a change', () => {
  const parent = identity('parent');
  const baseline = model(
    table('t', {
      columns: [column('a')],
      foreignKeys: [foreignKey(['a'], parent, { name: 't_a_fkey', referencedColumns: ['id'] })],
    }),
  );
  const target = model(
    table('t', {
      columns: [column('a')],
      foreignKeys: [foreignKey(['a'], parent, { name: 't_b_fkey', referencedColumns: ['id'] })],
    }),
  );

  assertDiff(baseline, target, [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [
        {
          kind: 'foreign-key-changed',
          before: foreignKey(['a'], parent, { name: 't_a_fkey', referencedColumns: ['id'] }),
          after: foreignKey(['a'], parent, { name: 't_b_fkey', referencedColumns: ['id'] }),
        },
      ],
    },
  ]);
});

test('a retargeted foreign key removes then adds', () => {
  const oldParent = identity('old_parent');
  const newParent = identity('new_parent');
  const baseline = model(
    table('t', {
      columns: [column('a')],
      foreignKeys: [foreignKey(['a'], oldParent, { referencedColumns: ['id'] })],
    }),
  );
  const target = model(
    table('t', {
      columns: [column('a')],
      foreignKeys: [foreignKey(['a'], newParent, { referencedColumns: ['id'] })],
    }),
  );

  assertDiff(baseline, target, [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [
        {
          kind: 'foreign-key-removed',
          foreignKey: foreignKey(['a'], oldParent, { referencedColumns: ['id'] }),
        },
        {
          kind: 'foreign-key-added',
          foreignKey: foreignKey(['a'], newParent, { referencedColumns: ['id'] }),
        },
      ],
    },
  ]);
});

test('a table rename removes then adds', () => {
  const baseline = model(table('users', { columns: [column('id')] }));
  const target = model(table('accounts', { columns: [column('id')] }));

  assertDiff(baseline, target, [
    { kind: 'table-added', table: table('accounts', { columns: [column('id')] }) },
    { kind: 'table-removed', table: table('users', { columns: [column('id')] }) },
  ]);
});

test('a column rename removes then adds', () => {
  const baseline = model(table('t', { columns: [column('id'), column('email')] }));
  const target = model(table('t', { columns: [column('id'), column('email_address')] }));

  assertDiff(baseline, target, [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [
        { kind: 'column-removed', column: column('email') },
        { kind: 'column-added', column: column('email_address') },
      ],
    },
  ]);
});

test('the same table name in two schemas is distinct', () => {
  const app = model(table('users', { schema: 'app', columns: [column('id')] }));
  const publicUsers = model(table('users', { schema: 'public', columns: [column('id')] }));

  assertDiff(publicUsers, app, [
    { kind: 'table-added', table: table('users', { schema: 'app', columns: [column('id')] }) },
    { kind: 'table-removed', table: table('users', { schema: 'public', columns: [column('id')] }) },
  ]);

  const both = model(
    table('users', { schema: 'app', columns: [column('id'), column('name')] }),
    table('users', { schema: 'public', columns: [column('id')] }),
  );

  assertDiff(both, app, [
    {
      kind: 'table-changed',
      table: identity('users', 'app'),
      changes: [{ kind: 'column-removed', column: column('name') }],
    },
    { kind: 'table-removed', table: table('users', { schema: 'public', columns: [column('id')] }) },
  ]);
});

test('mixed-case table names are compared case-sensitively', () => {
  const baseline = model(table('Users', { columns: [column('id')] }));
  const target = model(table('users', { columns: [column('id')] }));

  assertDiff(baseline, target, [
    { kind: 'table-removed', table: table('Users', { columns: [column('id')] }) },
    { kind: 'table-added', table: table('users', { columns: [column('id')] }) },
  ]);
});

test('mixed-case column names are compared case-sensitively', () => {
  const baseline = model(table('t', { columns: [column('Id')] }));
  const target = model(table('t', { columns: [column('id')] }));

  assertDiff(baseline, target, [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [
        { kind: 'column-removed', column: column('Id') },
        { kind: 'column-added', column: column('id') },
      ],
    },
  ]);
});

test('shuffled table and foreign key order changes nothing', () => {
  const parent = identity('parent');
  const changedBefore = foreignKey(['a'], parent, { name: 'one', referencedColumns: ['id'] });
  const untouchedBefore = foreignKey(['b'], parent, { name: 'two', referencedColumns: ['id'] });
  const changedAfter = foreignKey(['a'], parent, {
    name: 'one',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  });
  const untouchedAfter = foreignKey(['b'], parent, { name: 'two', referencedColumns: ['id'] });

  const baselineA = model(
    table('t', {
      columns: [column('a'), column('b')],
      foreignKeys: [changedBefore, untouchedBefore],
    }),
    table('u', { columns: [column('x')] }),
  );
  const baselineB = model(
    table('u', { columns: [column('x')] }),
    table('t', {
      columns: [column('a'), column('b')],
      foreignKeys: [untouchedBefore, changedBefore],
    }),
  );
  const targetA = model(
    table('t', {
      columns: [column('a'), column('b')],
      foreignKeys: [untouchedAfter, changedAfter],
    }),
    table('u', { columns: [column('x'), column('y')] }),
  );
  const targetB = model(
    table('u', { columns: [column('x'), column('y')] }),
    table('t', {
      columns: [column('a'), column('b')],
      foreignKeys: [changedAfter, untouchedAfter],
    }),
  );

  const expected: readonly Change[] = [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [{ kind: 'foreign-key-changed', before: changedBefore, after: changedAfter }],
    },
    {
      kind: 'table-changed',
      table: identity('u'),
      changes: [{ kind: 'column-added', column: column('y') }],
    },
  ];

  assertDiff(baselineA, targetA, expected);
  assertDiff(baselineB, targetB, expected);
  assertDiff(baselineA, targetB, expected);
  assertDiff(baselineB, targetA, expected);
});

test('a table with many changes emits in the documented order', () => {
  const parent = identity('parent');
  const other = identity('other');

  const alsoGone = foreignKey(['a'], parent, { name: 'also_gone', referencedColumns: ['id'] });
  const gone = foreignKey(['keep'], parent, { name: 'gone', referencedColumns: ['id'] });
  const moving = foreignKey(['keep'], other, { name: 'moving', referencedColumns: ['id'] });
  const fresh = foreignKey(['mutate'], parent, {
    name: 'fresh',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  });
  const later = foreignKey(['z'], parent, { name: 'later', referencedColumns: ['id'] });
  const moved = foreignKey(['keep'], other, {
    name: 'moved',
    referencedColumns: ['id'],
    onUpdate: 'CASCADE',
  });

  const baseline = model(
    table('t', {
      columns: [column('drop_b'), column('drop_a'), column('mutate'), column('keep')],
      primaryKey: { name: 't_pkey', columns: ['keep'] },
      foreignKeys: [gone, alsoGone, moving],
    }),
  );
  const target = model(
    table('t', {
      columns: [
        column('keep'),
        column('mutate', { type: 'bigint' }),
        column('add_b', { notNull: true }),
        column('add_a'),
      ],
      primaryKey: { name: 't_pkey', columns: ['keep', 'mutate'] },
      foreignKeys: [fresh, later, moved],
    }),
  );

  assertDiff(baseline, target, [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [
        { kind: 'column-removed', column: column('drop_b') },
        { kind: 'column-removed', column: column('drop_a') },
        { kind: 'column-added', column: column('add_b', { notNull: true }) },
        { kind: 'column-added', column: column('add_a') },
        {
          kind: 'column-changed',
          name: 'mutate',
          fields: [{ field: 'type', before: 'text', after: 'bigint' }],
        },
        {
          kind: 'primary-key-changed',
          before: { name: 't_pkey', columns: ['keep'] },
          after: { name: 't_pkey', columns: ['keep', 'mutate'] },
        },
        { kind: 'foreign-key-removed', foreignKey: alsoGone },
        { kind: 'foreign-key-removed', foreignKey: gone },
        { kind: 'foreign-key-added', foreignKey: fresh },
        { kind: 'foreign-key-added', foreignKey: later },
        { kind: 'foreign-key-changed', before: moving, after: moved },
      ],
    },
  ]);
});

test('duplicate foreign key identities pair identical constraints first', () => {
  const parent = identity('parent');
  const first = foreignKey(['a'], parent, { name: 'x', referencedColumns: ['a'] });
  const second = foreignKey(['a'], parent, { name: 'y', referencedColumns: ['b'] });
  const baseline = model(table('t', { columns: [column('a')], foreignKeys: [first, second] }));

  const firstCopy = foreignKey(['a'], parent, { name: 'x', referencedColumns: ['a'] });
  const movedColumns = foreignKey(['a'], parent, { name: 'y', referencedColumns: ['a'] });
  const movedName = foreignKey(['a'], parent, { name: 'x', referencedColumns: ['b'] });
  const target = model(
    table('t', { columns: [column('a')], foreignKeys: [movedColumns, movedName, firstCopy] }),
  );

  assertDiff(baseline, target, [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [
        { kind: 'foreign-key-added', foreignKey: movedName },
        { kind: 'foreign-key-changed', before: second, after: movedColumns },
      ],
    },
  ]);
});

test('reordering existing columns is not a change', () => {
  const baseline = model(table('t', { columns: [column('a'), column('b'), column('c')] }));
  const target = model(table('t', { columns: [column('c'), column('a'), column('b')] }));

  assertDiff(baseline, target, []);
});

test('inserting a column mid-list reports only its addition', () => {
  const baseline = model(table('t', { columns: [column('a'), column('c')] }));
  const target = model(table('t', { columns: [column('a'), column('b'), column('c')] }));

  assertDiff(baseline, target, [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [{ kind: 'column-added', column: column('b') }],
    },
  ]);
});

test('added and removed tables carry foreign keys in canonical order', () => {
  const parent = identity('parent');
  const alpha = foreignKey(['a'], parent, { name: 'alpha', referencedColumns: ['id'] });
  const beta = foreignKey(['b'], parent, { name: 'beta', referencedColumns: ['id'] });
  const columns = [column('a'), column('b')];
  const forward = model(table('t', { columns, foreignKeys: [beta, alpha] }));
  const reversed = model(table('t', { columns, foreignKeys: [alpha, beta] }));
  const canonical = table('t', { columns, foreignKeys: [alpha, beta] });

  assertDiff(model(), forward, [{ kind: 'table-added', table: canonical }]);
  assertDiff(model(), reversed, [{ kind: 'table-added', table: canonical }]);
  assertDiff(forward, model(), [{ kind: 'table-removed', table: canonical }]);
  assertDiff(reversed, model(), [{ kind: 'table-removed', table: canonical }]);
});

test('canonical copies break foreign key order ties deterministically', () => {
  const parent = identity('parent');
  const cascade = foreignKey(['a'], parent, {
    name: 'same',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  });
  const restrict = foreignKey(['a'], parent, {
    name: 'same',
    referencedColumns: ['id'],
    onDelete: 'RESTRICT',
  });
  const columns = [column('a')];

  assertDiff(model(), model(table('t', { columns, foreignKeys: [restrict, cascade] })), [
    {
      kind: 'table-added',
      table: table('t', { columns, foreignKeys: [cascade, restrict] }),
    },
  ]);
});

test('added and removed tables are independent copies', () => {
  const parent = identity('parent');
  const key = foreignKey(['a'], parent, {
    name: 't_a_fkey',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  });
  const source = table('t', {
    columns: [column('a')],
    primaryKey: { name: 't_pkey', columns: ['a'] },
    foreignKeys: [key],
  });

  const added = diff(model(), model(source))[0]!;
  assert.equal(added.kind, 'table-added');
  if (added.kind !== 'table-added') throw new Error('expected a table addition');
  assert.deepStrictEqual(added.table, source);
  assertCopiedTable(added.table, source);

  const removed = diff(model(source), model())[0]!;
  assert.equal(removed.kind, 'table-removed');
  if (removed.kind !== 'table-removed') throw new Error('expected a table removal');
  assert.deepStrictEqual(removed.table, source);
  assertCopiedTable(removed.table, source);
});

test('changed table members are independent copies', () => {
  const parent = identity('parent');
  const key = foreignKey(['a'], parent, { name: 't_a_fkey', referencedColumns: ['id'] });
  const changedKey = foreignKey(['a'], parent, {
    name: 't_a_fkey',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  });
  const goneColumn = column('gone');
  const freshColumn = column('fresh');
  const sourcePrimaryKey = { name: 't_pkey', columns: ['a'] };
  const targetPrimaryKey = { name: 't_pkey', columns: ['a', 'fresh'] };

  const baseline = model(
    table('t', {
      columns: [column('a'), goneColumn],
      primaryKey: sourcePrimaryKey,
      foreignKeys: [key],
    }),
  );
  const target = model(
    table('t', {
      columns: [column('a'), freshColumn],
      primaryKey: targetPrimaryKey,
      foreignKeys: [changedKey],
    }),
  );

  const changed = diff(baseline, target)[0]!;
  assert.equal(changed.kind, 'table-changed');
  if (changed.kind !== 'table-changed') throw new Error('expected a changed table');

  const removed = changed.changes[0];
  assert.equal(removed?.kind, 'column-removed');
  if (removed?.kind === 'column-removed') assert.notEqual(removed.column, goneColumn);

  const added = changed.changes[1];
  assert.equal(added?.kind, 'column-added');
  if (added?.kind === 'column-added') assert.notEqual(added.column, freshColumn);

  const primaryKey = changed.changes[2];
  assert.equal(primaryKey?.kind, 'primary-key-changed');
  if (primaryKey?.kind === 'primary-key-changed') {
    assert.notEqual(primaryKey.before, sourcePrimaryKey);
    assert.notEqual(primaryKey.before.columns, sourcePrimaryKey.columns);
    assert.notEqual(primaryKey.after, targetPrimaryKey);
    assert.notEqual(primaryKey.after.columns, targetPrimaryKey.columns);
  }

  const foreignKeyChange = changed.changes[3];
  assert.equal(foreignKeyChange?.kind, 'foreign-key-changed');
  if (foreignKeyChange?.kind === 'foreign-key-changed') {
    assert.notEqual(foreignKeyChange.before, key);
    assert.notEqual(foreignKeyChange.before.columns, key.columns);
    assert.notEqual(foreignKeyChange.before.referencedTable, key.referencedTable);
    assert.notEqual(foreignKeyChange.before.referencedColumns, key.referencedColumns);
    assert.notEqual(foreignKeyChange.after, changedKey);
    assert.notEqual(foreignKeyChange.after.columns, changedKey.columns);
    assert.notEqual(foreignKeyChange.after.referencedTable, changedKey.referencedTable);
    assert.notEqual(foreignKeyChange.after.referencedColumns, changedKey.referencedColumns);
  }
});

test('a deep-frozen model can be diffed', () => {
  const key = foreignKey(['a'], identity('parent'), { referencedColumns: ['id'] });
  const baseline = deepFreeze(model(table('a', { columns: [column('x')], foreignKeys: [key] })));
  const target = deepFreeze(
    model(
      table('b', {
        columns: [column('y')],
        primaryKey: { columns: ['y'] },
        foreignKeys: [key],
      }),
    ),
  );

  assertDiff(baseline, target, [
    { kind: 'table-removed', table: table('a', { columns: [column('x')], foreignKeys: [key] }) },
    {
      kind: 'table-added',
      table: table('b', {
        columns: [column('y')],
        primaryKey: { columns: ['y'] },
        foreignKeys: [key],
      }),
    },
  ]);
});

test('duplicate identities tied on referenced columns pair by name and actions', () => {
  const parent = identity('parent');
  const cascade = foreignKey(['a'], parent, {
    name: 'same',
    referencedColumns: ['id'],
    onUpdate: 'CASCADE',
  });
  const restrict = foreignKey(['a'], parent, {
    name: 'same',
    referencedColumns: ['id'],
    onUpdate: 'RESTRICT',
  });
  const deleteCascade = foreignKey(['a'], parent, {
    name: 'same',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  });
  const deleteRestrict = foreignKey(['a'], parent, {
    name: 'same',
    referencedColumns: ['id'],
    onDelete: 'RESTRICT',
  });
  const columns = [column('a')];

  const expected: readonly Change[] = [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [
        { kind: 'foreign-key-changed', before: cascade, after: deleteCascade },
        { kind: 'foreign-key-changed', before: restrict, after: deleteRestrict },
      ],
    },
  ];

  assertDiff(
    model(table('t', { columns, foreignKeys: [cascade, restrict] })),
    model(table('t', { columns, foreignKeys: [deleteCascade, deleteRestrict] })),
    expected,
  );
  assertDiff(
    model(table('t', { columns, foreignKeys: [restrict, cascade] })),
    model(table('t', { columns, foreignKeys: [deleteRestrict, deleteCascade] })),
    expected,
  );
  assertDiff(
    model(table('t', { columns, foreignKeys: [cascade, restrict] })),
    model(table('t', { columns, foreignKeys: [deleteRestrict, deleteCascade] })),
    expected,
  );
  assertDiff(
    model(table('t', { columns, foreignKeys: [restrict, cascade] })),
    model(table('t', { columns, foreignKeys: [deleteCascade, deleteRestrict] })),
    expected,
  );
});

test('changed foreign key pairs order by before then after', () => {
  const parent = identity('parent');
  const beforeFirst = foreignKey(['a'], parent, { name: 'a', referencedColumns: ['a'] });
  const beforeSecond = foreignKey(['a'], parent, { name: 'b', referencedColumns: ['b'] });
  const afterFirst = foreignKey(['a'], parent, { name: 'b', referencedColumns: ['a'] });
  const afterSecond = foreignKey(['a'], parent, { name: 'a', referencedColumns: ['b'] });
  const columns = [column('a')];

  const expected: readonly Change[] = [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [
        { kind: 'foreign-key-changed', before: beforeFirst, after: afterFirst },
        { kind: 'foreign-key-changed', before: beforeSecond, after: afterSecond },
      ],
    },
  ];

  assertDiff(
    model(table('t', { columns, foreignKeys: [beforeFirst, beforeSecond] })),
    model(table('t', { columns, foreignKeys: [afterFirst, afterSecond] })),
    expected,
  );
  assertDiff(
    model(table('t', { columns, foreignKeys: [beforeSecond, beforeFirst] })),
    model(table('t', { columns, foreignKeys: [afterSecond, afterFirst] })),
    expected,
  );
});

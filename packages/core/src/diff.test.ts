import assert from 'node:assert/strict';
import { test } from 'node:test';

import { diff } from './index.ts';
import type { Change } from './diff.ts';
import type { Identity } from './identity.ts';
import type {
  Column,
  ForeignKey,
  Model,
  PrimaryKey,
  Sequence,
  SequenceIdentity,
  SequenceOwner,
  Table,
  TableIdentity,
} from './model.ts';

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

/** An identity descriptor: `GENERATED ALWAYS` ascending bigint defaults unless overridden. */
const columnIdentity = (fields: Partial<Identity> = {}): Identity => ({
  generated: 'always',
  increment: '1',
  minValue: '1',
  maxValue: '9223372036854775807',
  start: '1',
  cache: '1',
  cycle: false,
  ...fields,
});

/** A model of the given sequences, with no tables unless they are supplied. */
const sequenceModel = (sequences: readonly Sequence[], ...tables: Table[]): Model => ({
  tables,
  sequences,
});

/** Freezes `value` and every object and array nested inside it. */
const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
};

/** A shallowly mutable view of `T`, for exercising copy independence in tests. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

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

test('an identity added or removed reports the whole descriptor', () => {
  const descriptor = columnIdentity({ generated: 'by default', cache: '4' });
  const plain = model(table('t', { columns: [column('id', { type: 'integer', notNull: true })] }));
  const identified = model(
    table('t', {
      columns: [column('id', { type: 'integer', notNull: true, identity: descriptor })],
    }),
  );

  assertDiff(plain, identified, [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [
        {
          kind: 'column-changed',
          name: 'id',
          fields: [],
          identity: { kind: 'added', identity: descriptor },
        },
      ],
    },
  ]);
  assertDiff(identified, plain, [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [
        {
          kind: 'column-changed',
          name: 'id',
          fields: [],
          identity: { kind: 'removed', identity: descriptor },
        },
      ],
    },
  ]);
});

test('a nullable column gaining identity reports the notNull change and the addition', () => {
  const descriptor = columnIdentity();
  const baseline = model(table('t', { columns: [column('id', { type: 'integer' })] }));
  const target = model(
    table('t', {
      columns: [column('id', { type: 'integer', notNull: true, identity: descriptor })],
    }),
  );

  assertDiff(baseline, target, [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [
        {
          kind: 'column-changed',
          name: 'id',
          fields: [{ field: 'notNull', before: false, after: true }],
          identity: { kind: 'added', identity: descriptor },
        },
      ],
    },
  ]);
});

test('an identity addition to a nullable-only pair reports no notNull change', () => {
  const descriptor = columnIdentity();
  const baseline = model(table('t', { columns: [column('id', { type: 'integer' })] }));
  const target = model(
    table('t', { columns: [column('id', { type: 'integer', identity: descriptor })] }),
  );

  assertDiff(baseline, target, [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [
        {
          kind: 'column-changed',
          name: 'id',
          fields: [],
          identity: { kind: 'added', identity: descriptor },
        },
      ],
    },
  ]);
});

test('a changed identity reports its options in the fixed order', () => {
  const baseline = model(
    table('t', {
      columns: [column('id', { type: 'bigint', notNull: true, identity: columnIdentity() })],
    }),
  );
  const target = model(
    table('t', {
      columns: [
        column('id', {
          type: 'bigint',
          notNull: true,
          identity: columnIdentity({
            generated: 'by default',
            increment: '3',
            minValue: '2',
            maxValue: '100',
            start: '7',
            cache: '4',
            cycle: true,
          }),
        }),
      ],
    }),
  );

  assertDiff(baseline, target, [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [
        {
          kind: 'column-changed',
          name: 'id',
          fields: [],
          identity: {
            kind: 'changed',
            fields: [
              { field: 'generated', before: 'always', after: 'by default' },
              { field: 'increment', before: '1', after: '3' },
              { field: 'minValue', before: '1', after: '2' },
              { field: 'maxValue', before: '9223372036854775807', after: '100' },
              { field: 'start', before: '1', after: '7' },
              { field: 'cache', before: '1', after: '4' },
              { field: 'cycle', before: false, after: true },
            ],
          },
        },
      ],
    },
  ]);
});

test('a generated mode change in either direction is an ordinary field change', () => {
  const asDefault = columnIdentity({ generated: 'by default' });

  assertDiff(
    model(
      table('t', {
        columns: [column('id', { type: 'bigint', notNull: true, identity: asDefault })],
      }),
    ),
    model(
      table('t', {
        columns: [column('id', { type: 'bigint', notNull: true, identity: columnIdentity() })],
      }),
    ),
    [
      {
        kind: 'table-changed',
        table: identity('t'),
        changes: [
          {
            kind: 'column-changed',
            name: 'id',
            fields: [],
            identity: {
              kind: 'changed',
              fields: [{ field: 'generated', before: 'by default', after: 'always' }],
            },
          },
        ],
      },
    ],
  );
});

test('identity sequence names compare only when both sides state one', () => {
  const named = { schema: 'public', name: 't_id_seq' } as const;
  const withName = (cache: string): Column =>
    column('id', {
      type: 'bigint',
      notNull: true,
      identity: columnIdentity({ sequenceName: { ...named }, cache }),
    });
  const unnamed = (): Column =>
    column('id', { type: 'bigint', notNull: true, identity: columnIdentity({ cache: '2' }) });

  // Two stated names that match are not a field; the options still compare.
  const sameName = model(table('t', { columns: [withName('2')] }));
  const sameNameChanged = model(table('t', { columns: [withName('4')] }));
  assertDiff(sameName, sameNameChanged, [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [
        {
          kind: 'column-changed',
          name: 'id',
          fields: [],
          identity: {
            kind: 'changed',
            fields: [{ field: 'cache', before: '2', after: '4' }],
          },
        },
      ],
    },
  ]);

  // A name stated on one side only is a don't-care, in either direction.
  const withoutName = model(table('t', { columns: [unnamed()] }));
  assertDiff(sameName, withoutName, []);
  assertDiff(withoutName, sameName, []);
});

test('a stated identity sequence name mismatch recreates the identity', () => {
  const baseline = columnIdentity({
    sequenceName: { schema: 'public', name: 't_id_seq' },
    cache: '2',
  });
  const target = columnIdentity({ sequenceName: { schema: 'public', name: 't_id_seq_v2' } });

  assertDiff(
    model(
      table('t', {
        columns: [column('id', { type: 'bigint', notNull: true, identity: baseline })],
      }),
    ),
    model(
      table('t', {
        columns: [column('id', { type: 'bigint', notNull: true, identity: target })],
      }),
    ),
    [
      {
        kind: 'table-changed',
        table: identity('t'),
        changes: [
          {
            kind: 'column-changed',
            name: 'id',
            fields: [],
            identity: { kind: 'recreated', identity: target },
          },
        ],
      },
    ],
  );
});

test('a column type change suppresses an identity bound the AS conversion moves', () => {
  // The integer maximum becomes bigint's own maximum on the conversion, which is also the
  // target's, so the identity needs no field at all.
  const baseline = model(
    table('t', {
      columns: [
        column('id', {
          type: 'integer',
          notNull: true,
          identity: columnIdentity({ maxValue: '2147483647' }),
        }),
      ],
    }),
  );
  const target = model(
    table('t', {
      columns: [column('id', { type: 'bigint', notNull: true, identity: columnIdentity() })],
    }),
  );

  assertDiff(baseline, target, [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [
        {
          kind: 'column-changed',
          name: 'id',
          fields: [{ field: 'type', before: 'integer', after: 'bigint' }],
        },
      ],
    },
  ]);
});

test('a column type change restates an identity bound the AS conversion would move', () => {
  // Both sides state the integer maximum, but the conversion rewrites the baseline's to
  // bigint's, so the target's value is restated and flagged as converted.
  const baseline = model(
    table('t', {
      columns: [
        column('id', {
          type: 'integer',
          notNull: true,
          identity: columnIdentity({ maxValue: '2147483647' }),
        }),
      ],
    }),
  );
  const target = model(
    table('t', {
      columns: [
        column('id', {
          type: 'bigint',
          notNull: true,
          identity: columnIdentity({ maxValue: '2147483647' }),
        }),
      ],
    }),
  );

  assertDiff(baseline, target, [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [
        {
          kind: 'column-changed',
          name: 'id',
          fields: [{ field: 'type', before: 'integer', after: 'bigint' }],
          identity: {
            kind: 'changed',
            fields: [
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
  ]);
});

test('a column type change restates an identity minimum the AS conversion would move', () => {
  const baseline = model(
    table('t', {
      columns: [
        column('id', {
          type: 'smallint',
          notNull: true,
          identity: columnIdentity({ minValue: '-32768', maxValue: '100' }),
        }),
      ],
    }),
  );
  const target = model(
    table('t', {
      columns: [
        column('id', {
          type: 'integer',
          notNull: true,
          identity: columnIdentity({ minValue: '-32768', maxValue: '100' }),
        }),
      ],
    }),
  );

  assertDiff(baseline, target, [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [
        {
          kind: 'column-changed',
          name: 'id',
          fields: [{ field: 'type', before: 'smallint', after: 'integer' }],
          identity: {
            kind: 'changed',
            fields: [
              {
                field: 'minValue',
                before: '-2147483648',
                after: '-32768',
                converted: true,
              },
            ],
          },
        },
      ],
    },
  ]);
});

test('as-written integer aliases do not convert identity bounds', () => {
  // `int4` and `integer` resolve to the same identity type, so the as-written text difference
  // is a column type change only: the bound equal to the integer maximum stays as written.
  const baseline = model(
    table('t', {
      columns: [
        column('id', {
          type: 'int4',
          notNull: true,
          identity: columnIdentity({ maxValue: '2147483647' }),
        }),
      ],
    }),
  );
  const target = model(
    table('t', {
      columns: [
        column('id', {
          type: 'integer',
          notNull: true,
          identity: columnIdentity({ maxValue: '2147483647' }),
        }),
      ],
    }),
  );

  assertDiff(baseline, target, [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [
        {
          kind: 'column-changed',
          name: 'id',
          fields: [{ field: 'type', before: 'int4', after: 'integer' }],
        },
      ],
    },
  ]);
});

test('a removed column or table carries its identity away', () => {
  const descriptor = columnIdentity({ sequenceName: { schema: 'public', name: 't_id_seq' } });
  const removedColumn = column('id', { type: 'bigint', notNull: true, identity: descriptor });
  const removedTable = table('t', { columns: [removedColumn] });

  // The column removal carries the whole column, identity included, and adds nothing else.
  assertDiff(model(removedTable), model(table('t', { columns: [] })), [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [{ kind: 'column-removed', column: removedColumn }],
    },
  ]);
  assertDiff(model(removedTable), model(), [{ kind: 'table-removed', table: removedTable }]);
});

test('identity payloads are independent copies', () => {
  const descriptor = columnIdentity({ sequenceName: { schema: 'public', name: 't_id_seq' } });
  const plain = column('id', { type: 'bigint', notNull: true });
  const identified = column('id', { type: 'bigint', notNull: true, identity: descriptor });

  const added = diff(
    model(table('t', { columns: [plain] })),
    model(table('t', { columns: [identified] })),
  )[0]!;
  assert.equal(added.kind, 'table-changed');
  if (added.kind !== 'table-changed') throw new Error('expected a changed table');
  const addedField = added.changes[0];
  assert.equal(addedField?.kind, 'column-changed');
  if (addedField?.kind === 'column-changed') {
    const change = addedField.identity;
    assert.equal(change?.kind, 'added');
    if (change?.kind === 'added') {
      assert.notEqual(change.identity, descriptor);
      assert.notEqual(change.identity.sequenceName, descriptor.sequenceName);
    }
  }

  const renamed = columnIdentity({ sequenceName: { schema: 'public', name: 't_id_seq_v2' } });
  const recreated = diff(
    model(table('t', { columns: [identified] })),
    model(
      table('t', {
        columns: [column('id', { type: 'bigint', notNull: true, identity: renamed })],
      }),
    ),
  )[0]!;
  assert.equal(recreated.kind, 'table-changed');
  if (recreated.kind !== 'table-changed') throw new Error('expected a changed table');
  const recreatedField = recreated.changes[0];
  assert.equal(recreatedField?.kind, 'column-changed');
  if (recreatedField?.kind === 'column-changed') {
    const change = recreatedField.identity;
    assert.equal(change?.kind, 'recreated');
    if (change?.kind === 'recreated') {
      assert.notEqual(change.identity, renamed);
      assert.notEqual(change.identity.sequenceName, renamed.sequenceName);
    }
  }
});

test('payload columns carry their identity as an independent copy', () => {
  const sourceIdentity = () =>
    columnIdentity({ sequenceName: { schema: 'public', name: 't_id_seq' } });
  const gone = column('gone', { type: 'integer', notNull: true, identity: sourceIdentity() });
  const fresh = column('fresh', { type: 'integer', notNull: true, identity: sourceIdentity() });
  const goneTableColumn = column('id', {
    type: 'integer',
    notNull: true,
    identity: sourceIdentity(),
  });
  const freshTableColumn = column('id', {
    type: 'integer',
    notNull: true,
    identity: sourceIdentity(),
  });

  const changes = diff(
    model(table('t', { columns: [gone] }), table('v', { columns: [goneTableColumn] })),
    model(table('t', { columns: [fresh] }), table('u', { columns: [freshTableColumn] })),
  );

  const changed = changes[0];
  assert.equal(changed?.kind, 'table-changed');
  if (changed?.kind !== 'table-changed') throw new Error('expected a changed table');
  const addedTable = changes[1];
  assert.equal(addedTable?.kind, 'table-added');
  if (addedTable?.kind !== 'table-added') throw new Error('expected a table addition');
  const removedTable = changes[2];
  assert.equal(removedTable?.kind, 'table-removed');
  if (removedTable?.kind !== 'table-removed') throw new Error('expected a table removal');

  const removedColumn = changed.changes[0];
  assert.equal(removedColumn?.kind, 'column-removed');
  if (removedColumn?.kind !== 'column-removed') throw new Error('expected a column removal');
  const addedColumn = changed.changes[1];
  assert.equal(addedColumn?.kind, 'column-added');
  if (addedColumn?.kind !== 'column-added') throw new Error('expected a column addition');

  const cases: readonly (readonly [Identity, Identity])[] = [
    [removedColumn.column.identity!, gone.identity!],
    [addedColumn.column.identity!, fresh.identity!],
    [addedTable.table.columns[0]!.identity!, freshTableColumn.identity!],
    [removedTable.table.columns[0]!.identity!, goneTableColumn.identity!],
  ];

  for (const [payload, source] of cases) {
    // Distinct objects at every level, in both directions.
    assert.notEqual(payload, source);
    assert.notEqual(payload.sequenceName, source.sequenceName);

    (payload as Mutable<Identity>).increment = '9';
    (payload.sequenceName as Mutable<SequenceIdentity>).name = 'payload';
    assert.equal(source.increment, '1');
    assert.equal(source.sequenceName?.name, 't_id_seq');

    (source as Mutable<Identity>).increment = '7';
    (source.sequenceName as Mutable<SequenceIdentity>).name = 'model';
    assert.equal(payload.increment, '9');
    assert.equal(payload.sequenceName?.name, 'payload');
  }
});

test('a deep-frozen model with identities can be diffed', () => {
  const baseline = deepFreeze(
    model(
      table('t', {
        columns: [
          column('id', {
            type: 'integer',
            notNull: true,
            identity: columnIdentity({ maxValue: '2147483647' }),
          }),
        ],
      }),
    ),
  );
  const target = deepFreeze(
    model(
      table('t', {
        columns: [column('id', { type: 'bigint', notNull: true, identity: columnIdentity() })],
      }),
    ),
  );

  assertDiff(baseline, target, [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [
        {
          kind: 'column-changed',
          name: 'id',
          fields: [{ field: 'type', before: 'integer', after: 'bigint' }],
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

test('absent and empty foreign key names order deterministically and stay distinct', () => {
  const parent = identity('parent');
  const unnamed = foreignKey(['a'], parent, { referencedColumns: ['id'] });
  const empty = foreignKey(['a'], parent, { name: '', referencedColumns: ['id'] });
  const columns = [column('a')];

  // Two foreign keys that differ only in name presence and value: absent sorts first.
  const forward = model(table('t', { columns, foreignKeys: [empty, unnamed] }));
  const reversed = model(table('t', { columns, foreignKeys: [unnamed, empty] }));
  const canonical = table('t', { columns, foreignKeys: [unnamed, empty] });

  assertDiff(model(), forward, [{ kind: 'table-added', table: canonical }]);
  assertDiff(model(), reversed, [{ kind: 'table-added', table: canonical }]);
  assertDiff(forward, model(), [{ kind: 'table-removed', table: canonical }]);
  assertDiff(reversed, model(), [{ kind: 'table-removed', table: canonical }]);

  // Replacing an absent name with an empty one is a change, never a silent collapse.
  assertDiff(
    model(table('t', { columns, foreignKeys: [unnamed] })),
    model(table('t', { columns, foreignKeys: [empty] })),
    [
      {
        kind: 'table-changed',
        table: identity('t'),
        changes: [{ kind: 'foreign-key-changed', before: unnamed, after: empty }],
      },
    ],
  );

  // Both duplicates change at once: pairing and emission are identical under either input
  // order.
  const unnamedAfter = foreignKey(['a'], parent, {
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  });
  const emptyAfter = foreignKey(['a'], parent, {
    name: '',
    referencedColumns: ['id'],
    onDelete: 'RESTRICT',
  });
  const targetForward = model(table('t', { columns, foreignKeys: [emptyAfter, unnamedAfter] }));
  const targetReversed = model(table('t', { columns, foreignKeys: [unnamedAfter, emptyAfter] }));
  const expected: readonly Change[] = [
    {
      kind: 'table-changed',
      table: identity('t'),
      changes: [
        { kind: 'foreign-key-changed', before: unnamed, after: unnamedAfter },
        { kind: 'foreign-key-changed', before: empty, after: emptyAfter },
      ],
    },
  ];

  assertDiff(forward, targetForward, expected);
  assertDiff(reversed, targetForward, expected);
  assertDiff(forward, targetReversed, expected);
  assertDiff(reversed, targetReversed, expected);
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

test('sequences in different insertion orders compare as identical', () => {
  const appSeq = sequence('a', {}, 'app');
  const publicSeq = sequence('b');

  assertDiff(sequenceModel([appSeq, publicSeq]), sequenceModel([publicSeq, appSeq]), []);
});

test('removed sequences follow the table changes, in identity order', () => {
  const appSeq = sequence('a', {}, 'app');
  const publicSeq = sequence('b');
  const gone = table('gone', { columns: [column('id')] });

  assertDiff(sequenceModel([publicSeq, appSeq], gone), model(), [
    { kind: 'table-removed', table: gone },
    { kind: 'sequence-removed', sequence: appSeq },
    { kind: 'sequence-removed', sequence: publicSeq },
  ]);
});

test('added sequences follow the table changes, in identity order', () => {
  const appSeq = sequence('a', {}, 'app');
  const publicSeq = sequence('b');
  const fresh = table('fresh', { columns: [column('id')] });

  assertDiff(model(), sequenceModel([publicSeq, appSeq], fresh), [
    { kind: 'table-added', table: fresh },
    { kind: 'sequence-added', sequence: appSeq },
    { kind: 'sequence-added', sequence: publicSeq },
  ]);
});

test('a changed sequence reports its differing fields in the fixed order', () => {
  const baseline = sequence('s', { minValue: '1', maxValue: '5' });
  const before = sequence('s', {
    dataType: 'bigint',
    increment: '3',
    minValue: '2',
    maxValue: '100',
    start: '7',
    cache: '4',
    cycle: true,
    ownedBy: owner('t', 'id'),
  });

  assertDiff(sequenceModel([baseline]), sequenceModel([before]), [
    {
      kind: 'sequence-changed',
      sequence: identity('s'),
      changes: [
        { field: 'increment', before: '1', after: '3' },
        { field: 'minValue', before: '1', after: '2' },
        { field: 'maxValue', before: '5', after: '100' },
        { field: 'start', before: '1', after: '7' },
        { field: 'cache', before: '1', after: '4' },
        { field: 'cycle', before: false, after: true },
        { field: 'ownedBy', after: { table: identity('t'), column: 'id' } },
      ],
    },
  ]);
});

test('a changed sequence reports data type first and detaches last', () => {
  const baseline = sequence('s', {
    dataType: 'integer',
    // The integer maximum; the engine's `AS bigint` converts it to bigint's own maximum,
    // which is also the target's, so the plan needs no explicit max value.
    maxValue: '2147483647',
    ownedBy: owner('t', 'id'),
  });
  const target = sequence('s', { ownedBy: undefined });

  assertDiff(sequenceModel([baseline]), sequenceModel([target]), [
    {
      kind: 'sequence-changed',
      sequence: identity('s'),
      changes: [
        { field: 'dataType', before: 'integer', after: 'bigint' },
        { field: 'ownedBy', before: { table: identity('t'), column: 'id' } },
      ],
    },
  ]);
});

test('a data type change restates a bound the AS conversion would move', () => {
  // The exact repro shape: both sides state the integer maximum, but `AS bigint` converts
  // the baseline's integer maximum to bigint's, so the target's value needs restating.
  const baseline = sequence('s', { dataType: 'integer', maxValue: '2147483647' });
  const target = sequence('s', { maxValue: '2147483647' });

  assertDiff(sequenceModel([baseline]), sequenceModel([target]), [
    {
      kind: 'sequence-changed',
      sequence: identity('s'),
      changes: [
        { field: 'dataType', before: 'integer', after: 'bigint' },
        { field: 'maxValue', before: '9223372036854775807', after: '2147483647', converted: true },
      ],
    },
  ]);
});

test('a data type change restates a minimum the AS conversion would move', () => {
  const baseline = sequence('s', {
    dataType: 'integer',
    minValue: '-2147483648',
    maxValue: '100',
  });
  const target = sequence('s', { minValue: '-2147483648', maxValue: '100' });

  assertDiff(sequenceModel([baseline]), sequenceModel([target]), [
    {
      kind: 'sequence-changed',
      sequence: identity('s'),
      changes: [
        { field: 'dataType', before: 'integer', after: 'bigint' },
        {
          field: 'minValue',
          before: '-9223372036854775808',
          after: '-2147483648',
          converted: true,
        },
      ],
    },
  ]);
});

test('a data type change restates both bounds the AS conversion would move', () => {
  const baseline = sequence('s', {
    dataType: 'integer',
    minValue: '-2147483648',
    maxValue: '2147483647',
  });
  const target = sequence('s', { minValue: '-2147483648', maxValue: '2147483647' });

  assertDiff(sequenceModel([baseline]), sequenceModel([target]), [
    {
      kind: 'sequence-changed',
      sequence: identity('s'),
      changes: [
        { field: 'dataType', before: 'integer', after: 'bigint' },
        {
          field: 'minValue',
          before: '-9223372036854775808',
          after: '-2147483648',
          converted: true,
        },
        { field: 'maxValue', before: '9223372036854775807', after: '2147483647', converted: true },
      ],
    },
  ]);
});

test('a smallint to integer change restates the smallint maximum', () => {
  const baseline = sequence('s', { dataType: 'smallint', maxValue: '32767' });
  const target = sequence('s', { dataType: 'integer', maxValue: '32767' });

  assertDiff(sequenceModel([baseline]), sequenceModel([target]), [
    {
      kind: 'sequence-changed',
      sequence: identity('s'),
      changes: [
        { field: 'dataType', before: 'smallint', after: 'integer' },
        { field: 'maxValue', before: '2147483647', after: '32767', converted: true },
      ],
    },
  ]);
});

test('a re-owned sequence reports both sides of the ownership field', () => {
  const before = owner('t', 'id');
  const after = owner('u', 'id');

  assertDiff(
    sequenceModel([sequence('s', { ownedBy: before })]),
    sequenceModel([sequence('s', { ownedBy: after })]),
    [
      {
        kind: 'sequence-changed',
        sequence: identity('s'),
        changes: [{ field: 'ownedBy', before, after }],
      },
    ],
  );
});

test('a sparse sequence compares equal to its effective form', () => {
  const effective = sequence('s');
  const sparse = {
    schema: 'public',
    name: 's',
    dataType: 'bigint',
    increment: '1',
  } as unknown as Sequence;

  assertDiff(sequenceModel([sparse]), sequenceModel([effective]), []);
  assertDiff(sequenceModel([effective]), sequenceModel([sparse]), []);
});

test('a deep-frozen model with sequences can be diffed', () => {
  const before = deepFreeze(sequenceModel([sequence('s', { ownedBy: owner('t', 'id') })]));
  const after = deepFreeze(
    sequenceModel([
      sequence('s', {
        increment: '-1',
        minValue: '-9223372036854775808',
        maxValue: '-1',
        start: '-1',
      }),
    ]),
  );

  assertDiff(before, after, [
    {
      kind: 'sequence-changed',
      sequence: identity('s'),
      changes: [
        { field: 'increment', before: '1', after: '-1' },
        { field: 'minValue', before: '1', after: '-9223372036854775808' },
        { field: 'maxValue', before: '9223372036854775807', after: '-1' },
        { field: 'start', before: '1', after: '-1' },
        { field: 'ownedBy', before: { table: identity('t'), column: 'id' } },
      ],
    },
  ]);
});

test('added and removed sequences are independent copies', () => {
  const source = sequence('s', { ownedBy: owner('t', 'id') });

  const added = diff(model(), sequenceModel([source]))[0]!;
  assert.equal(added.kind, 'sequence-added');
  if (added.kind !== 'sequence-added') throw new Error('expected a sequence addition');
  assert.deepStrictEqual(added.sequence, source);
  assert.notEqual(added.sequence, source);
  assert.notEqual(added.sequence.ownedBy, source.ownedBy);
  assert.notEqual(added.sequence.ownedBy?.table, source.ownedBy?.table);

  const removed = diff(sequenceModel([source]), model())[0]!;
  assert.equal(removed.kind, 'sequence-removed');
  if (removed.kind !== 'sequence-removed') throw new Error('expected a sequence removal');
  assert.deepStrictEqual(removed.sequence, source);
  assert.notEqual(removed.sequence, source);
  assert.notEqual(removed.sequence.ownedBy, source.ownedBy);
  assert.notEqual(removed.sequence.ownedBy?.table, source.ownedBy?.table);
});

test('changed sequence owners are independent copies', () => {
  const before = owner('t', 'id');
  const after = owner('u', 'id');

  const changed = diff(
    sequenceModel([sequence('s', { ownedBy: before })]),
    sequenceModel([sequence('s', { ownedBy: after })]),
  )[0]!;
  assert.equal(changed.kind, 'sequence-changed');
  if (changed.kind !== 'sequence-changed') throw new Error('expected a changed sequence');

  const field = changed.changes[0];
  assert.equal(field?.field, 'ownedBy');
  if (field?.field === 'ownedBy') {
    assert.notEqual(field.before, before);
    assert.notEqual(field.before?.table, before.table);
    assert.notEqual(field.after, after);
    assert.notEqual(field.after?.table, after.table);
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Diagnostic, Model } from '@schemamill/core';

import { mapCatalog } from './catalog.ts';

/**
 * Tests for the live-catalog payload mapper: literal payload fixtures in the dump-importer
 * suite's style, pinning the model the read produces and the exact diagnostics it reports.
 * Transport behavior (the `psql` spawn, JSON parsing, exit handling) is exercised by the gated
 * live suite; here the payload contract is the subject: canonical order out of shuffled rows,
 * conventional primary-key-name stripping, every deferred-state diagnostic, and the throws for
 * malformed, orphan, and duplicate payloads.
 */

/** A `tables` row: an ordinary permanent table unless overridden. */
const table = (schema: string, name: string, rest: Record<string, unknown> = {}) => ({
  schema,
  name,
  relkind: 'r',
  relispartition: false,
  relpersistence: 'p',
  ...rest,
});

/** A `columns` row: a nullable `text` column without deferred state unless overridden. */
const column = (
  schema: string,
  tableName: string,
  attnum: number,
  name: string,
  rest: Record<string, unknown> = {},
) => ({
  schema,
  tableName,
  attnum,
  name,
  type: 'text',
  attnotnull: false,
  attidentity: '',
  attgenerated: '',
  atthasdef: false,
  attcollation: 0,
  typcollation: 0,
  attstorage: 'x',
  typstorage: 'x',
  attcompression: '',
  ...rest,
});

/** A `primaryKeys` row. */
const key = (
  schema: string,
  tableName: string,
  conname: string,
  ordinal: number,
  attname: string,
) => ({ schema, tableName, conname, ordinal, attname });

/** The sections of a payload, with the empty array default for sections a test does not use. */
const payload = (sections: {
  readonly tables?: readonly unknown[];
  readonly columns?: readonly unknown[];
  readonly primaryKeys?: readonly unknown[];
}) => ({ tables: [], columns: [], primaryKeys: [], ...sections });

test('maps a shuffled payload into the canonical model, order-significant', () => {
  const read = mapCatalog(
    payload({
      tables: [table('public', 'users'), table('app', 'events'), table('public', 'accounts')],
      columns: [
        column('public', 'users', 3, 'note'),
        column('public', 'accounts', 2, 'tenant'),
        column('app', 'events', 2, 'b'),
        column('public', 'users', 1, 'id', { type: 'uuid', attnotnull: true }),
        column('app', 'events', 1, 'a', { type: 'integer' }),
        column('public', 'accounts', 1, 'account_id', { type: 'uuid', attnotnull: true }),
        column('app', 'events', 3, 'c'),
        column('public', 'users', 2, 'email', { type: 'character varying(255)' }),
      ],
      primaryKeys: [
        key('app', 'events', 'events_pkey', 2, 'a'),
        key('public', 'users', 'users_pkey', 1, 'id'),
        key('app', 'events', 'events_pkey', 1, 'c'),
        key('public', 'accounts', 'accounts_pkey', 1, 'account_id'),
      ],
    }),
  );

  const expected: Model = {
    tables: [
      {
        schema: 'app',
        name: 'events',
        columns: [
          { name: 'a', type: 'integer', notNull: false },
          { name: 'b', type: 'text', notNull: false },
          { name: 'c', type: 'text', notNull: false },
        ],
        primaryKey: { columns: ['c', 'a'] },
        foreignKeys: [],
        uniqueConstraints: [],
        checkConstraints: [],
        indexes: [],
      },
      {
        schema: 'public',
        name: 'accounts',
        columns: [
          { name: 'account_id', type: 'uuid', notNull: true },
          { name: 'tenant', type: 'text', notNull: false },
        ],
        primaryKey: { columns: ['account_id'] },
        foreignKeys: [],
        uniqueConstraints: [],
        checkConstraints: [],
        indexes: [],
      },
      {
        schema: 'public',
        name: 'users',
        columns: [
          { name: 'id', type: 'uuid', notNull: true },
          { name: 'email', type: 'character varying(255)', notNull: false },
          { name: 'note', type: 'text', notNull: false },
        ],
        primaryKey: { columns: ['id'] },
        foreignKeys: [],
        uniqueConstraints: [],
        checkConstraints: [],
        indexes: [],
      },
    ],
    sequences: [],
  };

  assert.deepEqual(read, { model: expected, diagnostics: [] });

  // The three ordering contracts on their own, so a failure names the broken one.
  assert.deepEqual(
    read.model.tables.map((table) => `${table.schema}.${table.name}`),
    ['app.events', 'public.accounts', 'public.users'],
    'tables come back in schema-then-name order',
  );
  assert.deepEqual(
    read.model.tables.map((table) => table.columns.map((column) => column.name)),
    [
      ['a', 'b', 'c'],
      ['account_id', 'tenant'],
      ['id', 'email', 'note'],
    ],
    'columns come back in attribute-number order',
  );
  assert.deepEqual(
    read.model.tables.find((table) => table.name === 'events')?.primaryKey?.columns,
    ['c', 'a'],
    'primary-key columns come back in key order',
  );
});

test('strips only the conventional primary-key name and keeps every other', () => {
  const read = mapCatalog(
    payload({
      tables: [table('public', 'users'), table('public', 'other'), table('public', 'named')],
      columns: [
        column('public', 'users', 1, 'id', { attnotnull: true }),
        column('public', 'other', 1, 'id'),
        column('public', 'named', 1, 'id'),
      ],
      primaryKeys: [
        key('public', 'users', 'users_pkey', 1, 'id'),
        key('public', 'other', 'users_pkey', 1, 'id'),
        key('public', 'named', 'custom_name', 1, 'id'),
      ],
    }),
  );

  assert.deepEqual(
    read.model.tables.map((table) => table.primaryKey),
    [
      { name: 'custom_name', columns: ['id'] },
      { name: 'users_pkey', columns: ['id'] },
      { columns: ['id'] },
    ],
    'the conventional name for the table strips; a foreign formula and a custom name stay',
  );
});

test('flags every deferred column state with the pinned wording and order', () => {
  const read = mapCatalog(
    payload({
      tables: [table('app', 'flags')],
      columns: [
        column('app', 'flags', 1, 'gen', { attgenerated: 's', atthasdef: true }),
        column('app', 'flags', 2, 'def', { atthasdef: true }),
        column('app', 'flags', 3, 'ident', { attidentity: 'a' }),
        column('app', 'flags', 4, 'coll', { attcollation: 100, typcollation: 950 }),
        column('app', 'flags', 5, 'stor', { attstorage: 'e', typstorage: 'x' }),
        column('app', 'flags', 6, 'comp', { attcompression: 'p' }),
        column('app', 'flags', 7, 'clean'),
      ],
    }),
  );

  const expected: readonly Diagnostic[] = [
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'app.flags',
      message: 'column gen is generated; generation is not represented yet',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'app.flags',
      message: 'column def has a default; defaults are not read yet',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'app.flags',
      message: 'column ident is an identity column; identity is not read yet',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'app.flags',
      message: 'column coll has an explicit collation; collation is not represented yet',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'app.flags',
      message: 'column stor has an explicit storage setting; storage is not represented yet',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'app.flags',
      message:
        'column comp has an explicit compression setting; compression is not represented yet',
    },
  ];
  assert.deepEqual(read.diagnostics, expected);
  for (const diagnostic of read.diagnostics) {
    assert.equal('position' in diagnostic, false, 'introspection diagnostics carry no position');
  }

  // A generated column has `atthasdef` set, but the generated flag suppresses the default one.
  assert.deepEqual(
    read.model.tables[0]?.columns.map((column) => column.name),
    ['gen', 'def', 'ident', 'coll', 'stor', 'comp', 'clean'],
    'flagged columns still map: only the model surface is narrowed',
  );
});

test('flags persistence, skips partitioned relations, and maps neither', () => {
  const read = mapCatalog(
    payload({
      tables: [
        table('public', 'unlogged', { relpersistence: 'u' }),
        table('public', 'partitioned', { relkind: 'p' }),
        table('public', 'temp', { relpersistence: 't' }),
        table('public', 'partition_child', { relispartition: true }),
      ],
      columns: [
        column('public', 'unlogged', 1, 'x', { type: 'integer' }),
        column('public', 'temp', 1, 'y'),
      ],
    }),
  );

  assert.deepEqual(
    read.model.tables.map((table) => `${table.schema}.${table.name}`),
    ['public.temp', 'public.unlogged'],
    'only ordinary, permanent relations are mapped',
  );
  assert.deepEqual(read.diagnostics, [
    {
      kind: 'skip',
      code: 'unsupported-statement',
      object: 'public.partition_child',
      message: 'table public.partition_child is partitioned; partitioning is not represented yet',
    },
    {
      kind: 'skip',
      code: 'unsupported-statement',
      object: 'public.partitioned',
      message: 'table public.partitioned is partitioned; partitioning is not represented yet',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.temp',
      message: 'table public.temp is temporary; persistence is not represented yet',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.unlogged',
      message: 'table public.unlogged is unlogged; persistence is not represented yet',
    },
  ]);
});

test('maps an empty catalog to the empty model with no diagnostics', () => {
  assert.deepEqual(mapCatalog(payload({})), {
    model: { tables: [], sequences: [] },
    diagnostics: [],
  });
});

test('throws on malformed payloads', () => {
  const cases: readonly (readonly [string, unknown, RegExp])[] = [
    ['a non-object payload', null, /catalog payload must be an object/],
    ['an array payload', [], /catalog payload must be an object/],
    ['a missing section', { tables: [] }, /catalog payload\.columns must be an array/],
    [
      'an unknown top-level field',
      { tables: [], columns: [], primaryKeys: [], version: 1 },
      /catalog payload carries an unknown field "version"/,
    ],
    [
      'an unknown row field',
      payload({ tables: [{ ...table('public', 't'), extra: true }] }),
      /catalog payload\.tables\[0\] carries an unknown field "extra"/,
    ],
    [
      'a wrong-typed field',
      payload({ tables: [{ ...table('public', 't'), schema: 7 }] }),
      /catalog payload\.tables\[0\]\.schema must be a string/,
    ],
    [
      'a non-boolean field',
      payload({
        tables: [table('public', 't')],
        columns: [column('public', 't', 1, 'x', { attnotnull: 'no' })],
      }),
      /catalog payload\.columns\[0\]\.attnotnull must be a boolean/,
    ],
    [
      'a non-positive column number',
      payload({ tables: [table('public', 't')], columns: [column('public', 't', 0, 'x')] }),
      /catalog payload\.columns\[0\]\.attnum must be an integer >= 1/,
    ],
    [
      'an out-of-contract relation kind',
      payload({ tables: [table('public', 'v', { relkind: 'v' })] }),
      /catalog payload\.tables\[0\]\.relkind must be "r" or "p"/,
    ],
    [
      'an out-of-contract persistence',
      payload({ tables: [table('public', 't', { relpersistence: 'x' })] }),
      /catalog payload\.tables\[0\]\.relpersistence must be "p", "u", or "t"/,
    ],
  ];

  for (const [label, malformed, pattern] of cases) {
    assert.throws(() => mapCatalog(malformed), pattern, label);
  }
});

test('throws on orphan rows', () => {
  assert.throws(
    () => mapCatalog(payload({ columns: [column('public', 'missing', 1, 'x')] })),
    /catalog payload: column row for "public\.missing" references an unknown table/,
    'a column row without its table row',
  );
  assert.throws(
    () => mapCatalog(payload({ primaryKeys: [key('public', 'missing', 'missing_pkey', 1, 'x')] })),
    /catalog payload: primary-key row for "public\.missing" references an unknown table/,
    'a primary-key row without its table row',
  );
  assert.throws(
    () =>
      mapCatalog(
        payload({
          tables: [table('public', 'partitioned', { relkind: 'p' })],
          columns: [column('public', 'partitioned', 1, 'x')],
        }),
      ),
    /catalog payload: column row for "public\.partitioned" belongs to a partitioned relation/,
    'a column row for a partitioned table',
  );
  assert.throws(
    () =>
      mapCatalog(
        payload({
          tables: [table('public', 'partition_child', { relispartition: true })],
          primaryKeys: [key('public', 'partition_child', 'partition_child_pkey', 1, 'x')],
        }),
      ),
    /catalog payload: primary-key row for "public\.partition_child" belongs to a partitioned relation/,
    'a primary-key row for a partition child',
  );
  assert.throws(
    () =>
      mapCatalog(
        payload({
          tables: [table('public', 't')],
          columns: [column('public', 't', 1, 'x')],
          primaryKeys: [key('public', 't', 't_pkey', 1, 'missing')],
        }),
      ),
    /catalog payload: primary-key column "public\.t\.missing" is not a read column of its table/,
    'a primary-key row naming a column the table does not carry',
  );
});

test('throws on duplicate rows', () => {
  assert.throws(
    () => mapCatalog(payload({ tables: [table('public', 't'), table('public', 't')] })),
    /catalog payload: duplicate table "public\.t"/,
    'two table rows for one identity',
  );
  assert.throws(
    () =>
      mapCatalog(
        payload({
          tables: [table('public', 't')],
          columns: [column('public', 't', 1, 'x'), column('public', 't', 2, 'x')],
        }),
      ),
    /catalog payload: duplicate column "public\.t\.x"/,
    'one column name twice',
  );
  assert.throws(
    () =>
      mapCatalog(
        payload({
          tables: [table('public', 't')],
          columns: [column('public', 't', 1, 'x'), column('public', 't', 1, 'y')],
        }),
      ),
    /catalog payload: duplicate column number 1 in "public\.t"/,
    'one attribute number twice',
  );
  assert.throws(
    () =>
      mapCatalog(
        payload({
          tables: [table('public', 't')],
          columns: [column('public', 't', 1, 'x'), column('public', 't', 2, 'y')],
          primaryKeys: [key('public', 't', 't_pkey', 1, 'x'), key('public', 't', 't_pkey', 2, 'x')],
        }),
      ),
    /catalog payload: duplicate primary-key column "public\.t\.x"/,
    'one key column twice',
  );
  assert.throws(
    () =>
      mapCatalog(
        payload({
          tables: [table('public', 't')],
          columns: [column('public', 't', 1, 'x'), column('public', 't', 2, 'y')],
          primaryKeys: [key('public', 't', 't_pkey', 1, 'x'), key('public', 't', 't_pkey', 1, 'y')],
        }),
      ),
    /catalog payload: duplicate primary-key position 1 in "public\.t"/,
    'one key position twice',
  );
  assert.throws(
    () =>
      mapCatalog(
        payload({
          tables: [table('public', 't')],
          columns: [column('public', 't', 1, 'x'), column('public', 't', 2, 'y')],
          primaryKeys: [
            key('public', 't', 't_pkey', 1, 'x'),
            key('public', 't', 'other_pkey', 2, 'y'),
          ],
        }),
      ),
    /catalog payload: table "public\.t" carries more than one primary key/,
    'two constraints claiming the primary key',
  );
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Diagnostic, Index, Model, TableIdentity } from '@schemamill/core';

import { canonicalizeIndexNames, mapCatalog } from './catalog.ts';

/**
 * Tests for the live-catalog payload mapper: literal payload fixtures in the dump-importer
 * suite's style, pinning the model the read produces and the exact diagnostics it reports.
 * Transport behavior (the `psql` spawn, JSON parsing, exit handling) is exercised by the gated
 * live suite; here the payload contract is the subject: canonical order out of shuffled rows,
 * conventional-name stripping for primary keys and indexes, the index envelope's skip grammar,
 * invalid and tablespace index handling, every deferred-state diagnostic, and the throws for
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

/** An `indexes` row: a valid, ready, default-tablespace index unless overridden. */
const index = (
  schema: string,
  tableName: string,
  indexName: string,
  definition: string,
  rest: Record<string, unknown> = {},
) => ({
  schema,
  tableName,
  indexName,
  definition,
  valid: true,
  ready: true,
  tablespace: null,
  ...rest,
});

/** The `pg_get_indexdef` form of a plain btree index on `columns`. */
const definition = (
  schema: string,
  tableName: string,
  indexName: string,
  columns: string,
  unique = false,
) =>
  `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${indexName} ON ${schema}.${tableName} USING btree (${columns})`;

/** The sections of a payload, with the empty array default for sections a test does not use. */
const payload = (sections: {
  readonly tables?: readonly unknown[];
  readonly columns?: readonly unknown[];
  readonly primaryKeys?: readonly unknown[];
  readonly indexes?: readonly unknown[];
}) => ({ tables: [], columns: [], primaryKeys: [], indexes: [], ...sections });

test('maps a shuffled payload into the canonical model, order-significant', async () => {
  const read = await mapCatalog(
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
      indexes: [
        index(
          'public',
          'users',
          'users_custom_idx',
          definition('public', 'users', 'users_custom_idx', 'note'),
        ),
        index('app', 'events', 'events_a_idx', definition('app', 'events', 'events_a_idx', 'a')),
        index(
          'public',
          'accounts',
          'accounts_tenant_idx',
          definition('public', 'accounts', 'accounts_tenant_idx', 'tenant', true),
        ),
        index(
          'public',
          'users',
          'users_email_idx',
          definition('public', 'users', 'users_email_idx', 'email'),
        ),
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
        indexes: [{ unique: false, columns: ['a'] }],
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
        indexes: [{ unique: true, columns: ['tenant'] }],
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
        indexes: [
          { unique: false, columns: ['email'] },
          { name: 'users_custom_idx', unique: false, columns: ['note'] },
        ],
      },
    ],
    sequences: [],
  };

  assert.deepEqual(read, { model: expected, diagnostics: [] });

  // The four ordering contracts on their own, so a failure names the broken one.
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
  assert.deepEqual(
    read.model.tables.map((table) => table.indexes.map((index) => index.name ?? '')),
    [[''], [''], ['', 'users_custom_idx']],
    'indexes come back unnamed-first by name, payload order irrelevant',
  );
});

test('strips only the conventional primary-key name and keeps every other', async () => {
  const read = await mapCatalog(
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

test('flags every deferred column state with the pinned wording and order', async () => {
  const read = await mapCatalog(
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

test('flags persistence, skips partitioned relations, and maps neither', async () => {
  const read = await mapCatalog(
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

test('orders indexes by stored name before stripping, independent of payload order', async () => {
  const rows = [
    index('public', 't', 't_c_idx', definition('public', 't', 't_c_idx', 'c')),
    index('public', 't', 'custom_idx', definition('public', 't', 'custom_idx', 'a')),
    index('public', 't', 't_b_idx', definition('public', 't', 't_b_idx', 'b')),
  ];
  const sections = {
    tables: [table('public', 't')],
    columns: [
      column('public', 't', 1, 'a'),
      column('public', 't', 2, 'b'),
      column('public', 't', 3, 'c'),
    ],
  };

  const forward = await mapCatalog(payload({ ...sections, indexes: rows }));
  const reversed = await mapCatalog(payload({ ...sections, indexes: [...rows].reverse() }));

  assert.deepEqual(forward, reversed, 'the mapper does not depend on payload row order');
  // The stored-name sort runs first — `t_b_idx` before `t_c_idx` — so the stripped entries
  // keep that order, and `custom_idx` follows them by the final `name ?? ''` sort.
  assert.deepEqual(forward.model.tables[0]?.indexes, [
    { unique: false, columns: ['b'] },
    { unique: false, columns: ['c'] },
    { name: 'custom_idx', unique: false, columns: ['a'] },
  ]);
});

test('strips the conventional index name, truncated server form included', async () => {
  // `makeObjectName` spends 4 bytes on `_idx` and its separator, so the 60-byte column gives
  // up 3 bytes to fit 63: the server form is `t_` plus 57 bytes plus `_idx`. A collision
  // suffix grows the label and the column part gives up 4 bytes instead.
  const longColumn = 'w'.repeat(60);
  const generated = `t_${'w'.repeat(57)}_idx`;
  const suffixed = `t_${'w'.repeat(56)}_idx1`;
  const read = await mapCatalog(
    payload({
      tables: [table('public', 't')],
      columns: [
        column('public', 't', 1, 'a'),
        column('public', 't', 2, 'b'),
        column('public', 't', 3, longColumn),
      ],
      indexes: [
        index('public', 't', 't_a_b_idx', definition('public', 't', 't_a_b_idx', 'a, b')),
        index('public', 't', 't_ab_idx', definition('public', 't', 't_ab_idx', 'a, b')),
        index('public', 't', 't_b_idx1', definition('public', 't', 't_b_idx1', 'b')),
        index('public', 't', 't_b_idx', definition('public', 't', 't_b_idx', 'b')),
        index('public', 't', suffixed, definition('public', 't', suffixed, longColumn)),
        index('public', 't', generated, definition('public', 't', generated, longColumn)),
      ],
    }),
  );

  // The prediction joins columns with `_`, so `t_ab_idx` is not the conventional name for
  // `(a, b)`; a collision suffix (`t_b_idx1`, `t_…_idx1`) is beyond the offline prediction.
  // Only the exact server forms strip, and the stripped entries keep stored-name order.
  assert.deepEqual(read.model.tables[0]?.indexes, [
    { unique: false, columns: ['a', 'b'] },
    { unique: false, columns: ['b'] },
    { unique: false, columns: [longColumn] },
    { name: 't_ab_idx', unique: false, columns: ['a', 'b'] },
    { name: 't_b_idx1', unique: false, columns: ['b'] },
    { name: suffixed, unique: false, columns: [longColumn] },
  ]);
  assert.deepEqual(read.diagnostics, []);
});

test('keeps a conventional name when stripping would duplicate an unnamed twin', () => {
  // The guard mirrors the dump importer's `canonicalizeIndexNames` twin rule, but no payload
  // can stage it: the payload contract rejects duplicate index names, and a live catalog's
  // same-schema names are unique, so two strippable names cannot collide. The fixture pins
  // the mirrored rule directly: the first entry strips, the twin keeps its stored name.
  const identity: TableIdentity = { schema: 'public', name: 't' };
  const structure: Index = { unique: false, columns: ['b'] };
  assert.deepEqual(
    canonicalizeIndexNames(identity, [
      { indexName: 't_b_idx', index: structure },
      { indexName: 't_b_idx', index: structure },
    ]),
    [
      { unique: false, columns: ['b'] },
      { name: 't_b_idx', unique: false, columns: ['b'] },
    ],
  );
});

test('scopes duplicate detection to the schema, as PostgreSQL names indexes', async () => {
  const read = await mapCatalog(
    payload({
      tables: [table('public', 't'), table('app', 't')],
      columns: [column('public', 't', 1, 'a'), column('app', 't', 1, 'a')],
      indexes: [
        index('public', 't', 't_a_idx', definition('public', 't', 't_a_idx', 'a')),
        index('app', 't', 't_a_idx', definition('app', 't', 't_a_idx', 'a')),
      ],
    }),
  );

  assert.deepEqual(
    read.model.tables.map((table) => table.indexes),
    [[{ unique: false, columns: ['a'] }], [{ unique: false, columns: ['a'] }]],
    'one index name on two schemas is two indexes',
  );
  assert.deepEqual(read.diagnostics, []);
});

test('skips out-of-envelope indexes with the pinned grammar', async () => {
  const read = await mapCatalog(
    payload({
      tables: [table('public', 't')],
      columns: [
        column('public', 't', 1, 'a'),
        column('public', 't', 2, 'b'),
        column('public', 't', 3, 'c'),
      ],
      indexes: [
        index(
          'public',
          't',
          't_collate_idx',
          'CREATE INDEX t_collate_idx ON public.t USING btree (c COLLATE "C")',
        ),
        index(
          'public',
          't',
          't_desc_idx',
          'CREATE INDEX t_desc_idx ON public.t USING btree (a DESC)',
        ),
        index(
          'public',
          't',
          't_expr_idx',
          'CREATE INDEX t_expr_idx ON public.t USING btree (((a + 1)))',
        ),
        index('public', 't', 't_hash_idx', 'CREATE INDEX t_hash_idx ON public.t USING hash (a)'),
        index(
          'public',
          't',
          't_include_idx',
          'CREATE INDEX t_include_idx ON public.t USING btree (a) INCLUDE (b)',
        ),
        index(
          'public',
          't',
          't_nd_idx',
          'CREATE UNIQUE INDEX t_nd_idx ON public.t USING btree (c) NULLS NOT DISTINCT',
        ),
        index(
          'public',
          't',
          't_nulls_idx',
          'CREATE INDEX t_nulls_idx ON public.t USING btree (a NULLS FIRST)',
        ),
        index(
          'public',
          't',
          't_opclass_idx',
          'CREATE INDEX t_opclass_idx ON public.t USING btree (c text_pattern_ops)',
        ),
        index(
          'public',
          't',
          't_partial_idx',
          'CREATE INDEX t_partial_idx ON public.t USING btree (a) WHERE (a > 0)',
        ),
        index(
          'public',
          't',
          't_storage_idx',
          "CREATE INDEX t_storage_idx ON public.t USING btree (a) WITH (fillfactor='70')",
        ),
      ],
    }),
  );

  // An index is never partially imported: every definition outside the envelope is skipped
  // whole, named with the catalog-side fully qualified grammar, in stored-name order.
  assert.deepEqual(read.model.tables[0]?.indexes, []);
  assert.deepEqual(read.diagnostics, [
    {
      kind: 'skip',
      code: 'unsupported-statement',
      object: 'public.t_collate_idx',
      message: 'skipped CREATE INDEX public.t_collate_idx (collation)',
    },
    {
      kind: 'skip',
      code: 'unsupported-statement',
      object: 'public.t_desc_idx',
      message: 'skipped CREATE INDEX public.t_desc_idx (non-default ordering)',
    },
    {
      kind: 'skip',
      code: 'unsupported-statement',
      object: 'public.t_expr_idx',
      message: 'skipped CREATE INDEX public.t_expr_idx (expression element)',
    },
    {
      kind: 'skip',
      code: 'unsupported-statement',
      object: 'public.t_hash_idx',
      message: 'skipped CREATE INDEX public.t_hash_idx (access method hash)',
    },
    {
      kind: 'skip',
      code: 'unsupported-statement',
      object: 'public.t_include_idx',
      message: 'skipped CREATE INDEX public.t_include_idx (INCLUDE)',
    },
    {
      kind: 'skip',
      code: 'unsupported-statement',
      object: 'public.t_nd_idx',
      message: 'skipped CREATE INDEX public.t_nd_idx (NULLS NOT DISTINCT)',
    },
    {
      kind: 'skip',
      code: 'unsupported-statement',
      object: 'public.t_nulls_idx',
      message: 'skipped CREATE INDEX public.t_nulls_idx (non-default NULLS ordering)',
    },
    {
      kind: 'skip',
      code: 'unsupported-statement',
      object: 'public.t_opclass_idx',
      message: 'skipped CREATE INDEX public.t_opclass_idx (operator class)',
    },
    {
      kind: 'skip',
      code: 'unsupported-statement',
      object: 'public.t_partial_idx',
      message: 'skipped CREATE INDEX public.t_partial_idx (partial WHERE)',
    },
    {
      kind: 'skip',
      code: 'unsupported-statement',
      object: 'public.t_storage_idx',
      message: 'skipped CREATE INDEX public.t_storage_idx (storage parameters)',
    },
  ]);
  for (const diagnostic of read.diagnostics) {
    assert.equal('position' in diagnostic, false, 'introspection diagnostics carry no position');
  }
});

test('skips indexes that are not valid and ready', async () => {
  const read = await mapCatalog(
    payload({
      tables: [table('public', 't')],
      columns: [column('public', 't', 1, 'a')],
      indexes: [
        index('public', 't', 't_a_idx', definition('public', 't', 't_a_idx', 'a')),
        index('public', 't', 't_invalid_idx', definition('public', 't', 't_invalid_idx', 'a'), {
          valid: false,
        }),
        index('public', 't', 't_notready_idx', definition('public', 't', 't_notready_idx', 'a'), {
          ready: false,
        }),
      ],
    }),
  );

  assert.deepEqual(read.model.tables[0]?.indexes, [{ unique: false, columns: ['a'] }]);
  assert.deepEqual(read.diagnostics, [
    {
      kind: 'skip',
      code: 'unsupported-statement',
      object: 'public.t_invalid_idx',
      message:
        'index public.t_invalid_idx is not valid and ready; invalid indexes are not represented yet',
    },
    {
      kind: 'skip',
      code: 'unsupported-statement',
      object: 'public.t_notready_idx',
      message:
        'index public.t_notready_idx is not valid and ready; invalid indexes are not represented yet',
    },
  ]);
});

test('keeps an index on a non-default tablespace and flags it', async () => {
  const read = await mapCatalog(
    payload({
      tables: [table('public', 't')],
      columns: [column('public', 't', 1, 'a')],
      indexes: [
        index('public', 't', 'custom_idx', definition('public', 't', 'custom_idx', 'a'), {
          tablespace: 'fastspace',
        }),
      ],
    }),
  );

  assert.deepEqual(read.model.tables[0]?.indexes, [
    { name: 'custom_idx', unique: false, columns: ['a'] },
  ]);
  assert.deepEqual(read.diagnostics, [
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.custom_idx',
      message:
        'index public.custom_idx is on tablespace fastspace; tablespaces are not represented yet',
    },
  ]);
  for (const diagnostic of read.diagnostics) {
    assert.equal('position' in diagnostic, false, 'introspection diagnostics carry no position');
  }
});

test('never sets concurrently, even when a definition states it', async () => {
  // `pg_get_indexdef` never emits `CONCURRENTLY`; the declaration is unrecoverable from the
  // catalog (ADR 0008), so the mapper maps it absent even from a synthetic definition.
  const read = await mapCatalog(
    payload({
      tables: [table('public', 't')],
      columns: [column('public', 't', 1, 'a')],
      indexes: [
        index(
          'public',
          't',
          't_a_idx',
          'CREATE INDEX CONCURRENTLY t_a_idx ON public.t USING btree (a)',
        ),
      ],
    }),
  );

  assert.deepEqual(read.model.tables[0]?.indexes, [{ unique: false, columns: ['a'] }]);
  assert.deepEqual(read.diagnostics, []);
});

test('maps an empty catalog to the empty model with no diagnostics', async () => {
  assert.deepEqual(await mapCatalog(payload({})), {
    model: { tables: [], sequences: [] },
    diagnostics: [],
  });
});

test('throws on malformed payloads', async () => {
  const valid = index('public', 't', 't_a_idx', definition('public', 't', 't_a_idx', 'a'));
  const cases: readonly (readonly [string, unknown, RegExp])[] = [
    ['a non-object payload', null, /catalog payload must be an object/],
    ['an array payload', [], /catalog payload must be an object/],
    ['a missing section', { tables: [] }, /catalog payload\.columns must be an array/],
    [
      'a missing indexes section',
      { tables: [], columns: [], primaryKeys: [] },
      /catalog payload\.indexes must be an array/,
    ],
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
    [
      'an unknown index row field',
      payload({ indexes: [{ ...valid, extra: true }] }),
      /catalog payload\.indexes\[0\] carries an unknown field "extra"/,
    ],
    [
      'a non-boolean index flag',
      payload({ indexes: [{ ...valid, valid: 'yes' }] }),
      /catalog payload\.indexes\[0\]\.valid must be a boolean/,
    ],
    [
      'a non-string tablespace',
      payload({ indexes: [{ ...valid, tablespace: 7 }] }),
      /catalog payload\.indexes\[0\]\.tablespace must be a string or null/,
    ],
    [
      'an unparseable definition',
      payload({ indexes: [index('public', 't', 't_a_idx', 'CREATE INDEX')] }),
      /catalog payload\.indexes\[0\]\.definition is not parseable/,
    ],
    [
      'a definition that is not CREATE INDEX',
      payload({ indexes: [index('public', 't', 't_a_idx', 'SELECT 1')] }),
      /catalog payload\.indexes\[0\]\.definition is not a CREATE INDEX statement/,
    ],
  ];

  for (const [label, malformed, pattern] of cases) {
    await assert.rejects(() => mapCatalog(malformed), pattern, label);
  }
});

test('throws on orphan rows', async () => {
  await assert.rejects(
    () => mapCatalog(payload({ columns: [column('public', 'missing', 1, 'x')] })),
    /catalog payload: column row for "public\.missing" references an unknown table/,
    'a column row without its table row',
  );
  await assert.rejects(
    () => mapCatalog(payload({ primaryKeys: [key('public', 'missing', 'missing_pkey', 1, 'x')] })),
    /catalog payload: primary-key row for "public\.missing" references an unknown table/,
    'a primary-key row without its table row',
  );
  await assert.rejects(
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
  await assert.rejects(
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
  await assert.rejects(
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
  await assert.rejects(
    () =>
      mapCatalog(
        payload({
          indexes: [
            index(
              'public',
              'missing',
              'missing_idx',
              definition('public', 'missing', 'missing_idx', 'x'),
            ),
          ],
        }),
      ),
    /catalog payload: index row for "public\.missing" references an unknown table/,
    'an index row without its table row',
  );
  await assert.rejects(
    () =>
      mapCatalog(
        payload({
          tables: [table('public', 'partitioned', { relkind: 'p' })],
          indexes: [
            index(
              'public',
              'partitioned',
              'partitioned_idx',
              definition('public', 'partitioned', 'partitioned_idx', 'x'),
            ),
          ],
        }),
      ),
    /catalog payload: index row for "public\.partitioned" belongs to a partitioned relation/,
    'an index row for a partitioned table',
  );
});

test('throws on duplicate rows', async () => {
  await assert.rejects(
    () => mapCatalog(payload({ tables: [table('public', 't'), table('public', 't')] })),
    /catalog payload: duplicate table "public\.t"/,
    'two table rows for one identity',
  );
  await assert.rejects(
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
  await assert.rejects(
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
  await assert.rejects(
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
  await assert.rejects(
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
  await assert.rejects(
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
  await assert.rejects(
    () =>
      mapCatalog(
        payload({
          tables: [table('public', 't')],
          indexes: [
            index('public', 't', 't_a_idx', definition('public', 't', 't_a_idx', 'a')),
            index('public', 't', 't_a_idx', definition('public', 't', 't_a_idx', 'a')),
          ],
        }),
      ),
    /catalog payload: duplicate index "public\.t_a_idx"/,
    'one index name twice',
  );
  await assert.rejects(
    () =>
      mapCatalog(
        payload({
          tables: [table('public', 't')],
          indexes: [
            index('public', 't', 't_a_idx', definition('public', 't', 't_a_idx', 'a')),
            index('public', 't', 't_a_idx', definition('public', 't', 't_a_idx', 'b')),
          ],
        }),
      ),
    /catalog payload: duplicate index "public\.t_a_idx"/,
    'one index name twice with inconsistent definitions',
  );
  await assert.rejects(
    () =>
      mapCatalog(
        payload({
          tables: [table('public', 't'), table('public', 'u')],
          indexes: [
            index('public', 't', 'shared_idx', definition('public', 't', 'shared_idx', 'a')),
            index('public', 'u', 'shared_idx', definition('public', 'u', 'shared_idx', 'a')),
          ],
        }),
      ),
    /catalog payload: duplicate index "public\.shared_idx"/,
    'one index name on two tables of one schema',
  );
});

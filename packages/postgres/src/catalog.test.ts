import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Diagnostic, Index, Model, TableIdentity } from '@schemamill/core';

import { canonicalizeConstraintNames, canonicalizeIndexNames, mapCatalog } from './catalog.ts';
import { importDump } from './import.ts';

/**
 * Tests for the live-catalog payload mapper: literal payload fixtures in the dump-importer
 * suite's style, pinning the model the read produces and the exact diagnostics it reports.
 * Transport behavior (the `psql` spawn, JSON parsing, exit handling) is exercised by the gated
 * live suite; here the payload contract is the subject: canonical order out of shuffled rows,
 * conventional-name stripping for primary keys and indexes, the index envelope's skip grammar,
 * invalid and tablespace index handling, every deferred-state diagnostic, the default and
 * explicit-attribute canonicalization rules, and the throws for malformed, orphan, and
 * duplicate payloads.
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
  default: null,
  attcollation: 0,
  typcollation: 0,
  collation: null,
  attstorage: 'x',
  typstorage: 'x',
  attcompression: '',
  ...rest,
});

/** A `primaryKeys` row: not deferrable and not temporal unless overridden. */
const key = (
  schema: string,
  tableName: string,
  conname: string,
  ordinal: number,
  attname: string,
  rest: Record<string, unknown> = {},
) => ({
  schema,
  tableName,
  conname,
  ordinal,
  attname,
  deferrable: false,
  deferred: false,
  period: false,
  ...rest,
});

/** A uniform `constraints` row: every key present, null unless the kind or test states it. */
const constraint = (
  schema: string,
  tableName: string,
  conname: string,
  kind: 'unique' | 'check' | 'foreign-key' | 'exclusion',
  rest: Record<string, unknown> = {},
) => ({
  schema,
  tableName,
  conname,
  kind,
  columns: null,
  expression: null,
  referencedSchema: null,
  referencedTable: null,
  referencedColumns: null,
  onUpdate: null,
  onDelete: null,
  matchType: null,
  deleteSetColumnList: null,
  deferrable: null,
  deferred: null,
  validated: null,
  enforced: null,
  noInherit: null,
  nullsNotDistinct: null,
  including: null,
  period: null,
  ...rest,
});

/** A `unique` constraint row with the kind's required fields and default attributes. */
const uniqueConstraint = (
  schema: string,
  tableName: string,
  conname: string,
  columns: readonly string[],
  rest: Record<string, unknown> = {},
) =>
  constraint(schema, tableName, conname, 'unique', {
    columns,
    deferrable: false,
    deferred: false,
    validated: true,
    nullsNotDistinct: false,
    including: false,
    period: false,
    ...rest,
  });

/** A `check` constraint row with the kind's required fields and default attributes. */
const checkConstraint = (
  schema: string,
  tableName: string,
  conname: string,
  expression: string,
  rest: Record<string, unknown> = {},
) =>
  constraint(schema, tableName, conname, 'check', {
    expression,
    validated: true,
    enforced: true,
    noInherit: false,
    deferrable: false,
    deferred: false,
    ...rest,
  });

/** A `foreign-key` constraint row with the kind's required fields and default attributes. */
const foreignKey = (
  schema: string,
  tableName: string,
  conname: string,
  columns: readonly string[],
  referencedSchema: string,
  referencedTable: string,
  referencedColumns: readonly string[],
  rest: Record<string, unknown> = {},
) =>
  constraint(schema, tableName, conname, 'foreign-key', {
    columns,
    referencedSchema,
    referencedTable,
    referencedColumns,
    onUpdate: 'a',
    onDelete: 'a',
    matchType: 's',
    deleteSetColumnList: false,
    deferrable: false,
    deferred: false,
    validated: true,
    enforced: true,
    period: false,
    ...rest,
  });

/** An `exclusion` constraint row: identity only, every other key null. */
const exclusionConstraint = (schema: string, tableName: string, conname: string) =>
  constraint(schema, tableName, conname, 'exclusion');

/** A `notNullConstraints` row: validated, inheriting, and conventionally named unless overridden. */
const notNull = (
  schema: string,
  tableName: string,
  columnName: string,
  conname: string,
  rest: Record<string, unknown> = {},
) => ({ schema, tableName, columnName, conname, validated: true, noInherit: false, ...rest });

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

/**
 * A `sequences` row: a standalone permanent ascending bigint sequence unless overridden. The
 * numeric fields are the payload's exact decimal strings, never JSON numbers.
 */
const sequence = (schema: string, name: string, rest: Record<string, unknown> = {}) => ({
  schema,
  name,
  dataType: 'bigint',
  start: '1',
  increment: '1',
  minValue: '1',
  maxValue: '9223372036854775807',
  cache: '1',
  cycle: false,
  persistence: 'p',
  ownerKind: null,
  ownerSchema: null,
  ownerTable: null,
  ownerColumn: null,
  ...rest,
});

/** The sections of a payload, with the empty array default for sections a test does not use. */
const payload = (sections: {
  readonly tables?: readonly unknown[];
  readonly columns?: readonly unknown[];
  readonly primaryKeys?: readonly unknown[];
  readonly indexes?: readonly unknown[];
  readonly constraints?: readonly unknown[];
  readonly notNullConstraints?: readonly unknown[];
  readonly sequences?: readonly unknown[];
}) => ({
  tables: [],
  columns: [],
  primaryKeys: [],
  indexes: [],
  constraints: [],
  notNullConstraints: [],
  sequences: [],
  ...sections,
});

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

test('flags generation, attaches identity without a flag, and never reads a generated default', async () => {
  const read = await mapCatalog(
    payload({
      tables: [table('app', 'flags')],
      columns: [
        column('app', 'flags', 1, 'gen', {
          attgenerated: 's',
          atthasdef: true,
          default: '(2 * 3)',
        }),
        column('app', 'flags', 2, 'ident', { type: 'integer', attidentity: 'a' }),
        column('app', 'flags', 3, 'clean'),
      ],
      sequences: [
        sequence('app', 'flags_ident_seq', {
          dataType: 'integer',
          maxValue: '2147483647',
          ownerKind: 'identity',
          ownerSchema: 'app',
          ownerTable: 'flags',
          ownerColumn: 'ident',
        }),
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
  ];
  assert.deepEqual(read.diagnostics, expected);
  for (const diagnostic of read.diagnostics) {
    assert.equal('position' in diagnostic, false, 'introspection diagnostics carry no position');
  }

  // A generated column carries `atthasdef` and an attrdef row for its generation expression;
  // the flag suppresses the default read. The identity column attaches its internal sequence
  // with no diagnostic of its own; the covered states carry no flag at all.
  assert.deepEqual(read.model.tables[0]?.columns, [
    { name: 'gen', type: 'text', notNull: false },
    {
      name: 'ident',
      type: 'integer',
      notNull: false,
      identity: {
        generated: 'always',
        sequenceName: { schema: 'app', name: 'flags_ident_seq' },
        increment: '1',
        minValue: '1',
        maxValue: '2147483647',
        start: '1',
        cache: '1',
        cycle: false,
      },
    },
    { name: 'clean', type: 'text', notNull: false },
  ]);
  assert.deepEqual(read.model.sequences, []);
});

test('maps standalone sequences with exact effective values, bigint bounds included', async () => {
  const read = await mapCatalog(
    payload({
      sequences: [
        sequence('zoo', 'tiny', {
          dataType: 'smallint',
          start: '-5',
          increment: '-2',
          minValue: '-32768',
          maxValue: '-1',
          cache: '7',
          cycle: true,
        }),
        sequence('app', 'wide', {
          start: '-9223372036854775808',
          minValue: '-9223372036854775808',
          maxValue: '9223372036854775807',
          cache: '9007199254740993',
        }),
        sequence('app', 'mid', {
          dataType: 'integer',
          start: '10',
          increment: '3',
          minValue: '-2147483648',
          maxValue: '2147483647',
          cache: '2',
        }),
      ],
    }),
  );

  assert.deepEqual(read.model.sequences, [
    {
      schema: 'app',
      name: 'mid',
      dataType: 'integer',
      increment: '3',
      minValue: '-2147483648',
      maxValue: '2147483647',
      start: '10',
      cache: '2',
      cycle: false,
    },
    {
      schema: 'app',
      name: 'wide',
      dataType: 'bigint',
      increment: '1',
      minValue: '-9223372036854775808',
      maxValue: '9223372036854775807',
      start: '-9223372036854775808',
      cache: '9007199254740993',
      cycle: false,
    },
    {
      schema: 'zoo',
      name: 'tiny',
      dataType: 'smallint',
      increment: '-2',
      minValue: '-32768',
      maxValue: '-1',
      start: '-5',
      cache: '7',
      cycle: true,
    },
  ]);
  assert.deepEqual(read.diagnostics, []);
  for (const value of read.model.sequences.flatMap((entry) => [
    entry.increment,
    entry.minValue,
    entry.maxValue,
    entry.start,
    entry.cache,
  ])) {
    assert.equal(typeof value, 'string', 'every numeric option travels as an exact string');
  }
});

test('maps an owned sequence with its schema-qualified owner', async () => {
  const read = await mapCatalog(
    payload({
      tables: [table('public', 'users')],
      columns: [column('public', 'users', 1, 'id', { type: 'integer', attnotnull: true })],
      sequences: [
        sequence('public', 'users_id_seq', {
          dataType: 'integer',
          maxValue: '2147483647',
          ownerKind: 'owned',
          ownerSchema: 'public',
          ownerTable: 'users',
          ownerColumn: 'id',
        }),
      ],
    }),
  );

  assert.deepEqual(read.model.sequences, [
    {
      schema: 'public',
      name: 'users_id_seq',
      dataType: 'integer',
      increment: '1',
      minValue: '1',
      maxValue: '2147483647',
      start: '1',
      cache: '1',
      cycle: false,
      ownedBy: { table: { schema: 'public', name: 'users' }, column: 'id' },
    },
  ]);
  assert.deepEqual(read.diagnostics, []);
});

test('skips sequences whose owner relation or column is unread', async () => {
  const read = await mapCatalog(
    payload({
      tables: [table('public', 't'), table('public', 'part', { relkind: 'p' })],
      columns: [column('public', 't', 1, 'id', { type: 'integer' })],
      sequences: [
        sequence('public', 'part_id_seq', {
          dataType: 'integer',
          persistence: 'u',
          ownerKind: 'owned',
          ownerSchema: 'public',
          ownerTable: 'part',
          ownerColumn: 'id',
        }),
        sequence('public', 't_dropped_seq', {
          dataType: 'integer',
          ownerKind: 'owned',
          ownerSchema: 'public',
          ownerTable: 't',
          ownerColumn: null,
        }),
        sequence('public', 'view_id_seq', {
          dataType: 'integer',
          ownerKind: 'identity',
          ownerSchema: 'public',
          ownerTable: 'missing_view',
          ownerColumn: 'id',
        }),
      ],
    }),
  );

  assert.deepEqual(read.model.sequences, []);
  assert.deepEqual(read.diagnostics, [
    {
      kind: 'skip',
      code: 'unsupported-statement',
      object: 'public.part',
      message: 'table public.part is partitioned; partitioning is not represented yet',
    },
    {
      kind: 'skip',
      code: 'unsupported-statement',
      object: 'public.part_id_seq',
      message:
        'sequence public.part_id_seq belongs to unread relation public.part; it is not represented',
    },
    {
      kind: 'skip',
      code: 'unsupported-statement',
      object: 'public.t_dropped_seq',
      message:
        'sequence public.t_dropped_seq belongs to unread relation public.t; it is not represented',
    },
    {
      kind: 'skip',
      code: 'unsupported-statement',
      object: 'public.view_id_seq',
      message:
        'sequence public.view_id_seq belongs to unread relation public.missing_view; it is not represented',
    },
  ]);
});

test('attaches identity always and by default with the real sequence name and options', async () => {
  const read = await mapCatalog(
    payload({
      tables: [table('public', 'users')],
      columns: [
        column('public', 'users', 1, 'id', {
          type: 'integer',
          attnotnull: true,
          attidentity: 'a',
        }),
        column('public', 'users', 2, 'legacy_id', { type: 'bigint', attidentity: 'd' }),
      ],
      sequences: [
        sequence('public', 'users_id_seq', {
          dataType: 'integer',
          start: '100',
          increment: '5',
          minValue: '10',
          maxValue: '2000',
          cache: '20',
          cycle: true,
          ownerKind: 'identity',
          ownerSchema: 'public',
          ownerTable: 'users',
          ownerColumn: 'id',
        }),
        sequence('public', 'users_legacy_id_seq', {
          ownerKind: 'identity',
          ownerSchema: 'public',
          ownerTable: 'users',
          ownerColumn: 'legacy_id',
        }),
      ],
    }),
  );

  assert.deepEqual(read.model.tables[0]?.columns, [
    {
      name: 'id',
      type: 'integer',
      notNull: true,
      identity: {
        generated: 'always',
        sequenceName: { schema: 'public', name: 'users_id_seq' },
        increment: '5',
        minValue: '10',
        maxValue: '2000',
        start: '100',
        cache: '20',
        cycle: true,
      },
    },
    {
      name: 'legacy_id',
      type: 'bigint',
      notNull: false,
      identity: {
        generated: 'by default',
        sequenceName: { schema: 'public', name: 'users_legacy_id_seq' },
        increment: '1',
        minValue: '1',
        maxValue: '9223372036854775807',
        start: '1',
        cache: '1',
        cycle: false,
      },
    },
  ]);
  assert.deepEqual(read.model.sequences, []);
  assert.deepEqual(read.diagnostics, []);
});

test('rejects identity and ownership contract violations', async () => {
  const identityBase = {
    tables: [table('public', 't')],
    columns: [column('public', 't', 1, 'id', { type: 'integer', attidentity: 'a' })],
  };
  await assert.rejects(
    () => mapCatalog(payload(identityBase)),
    /catalog payload: identity column "public\.t\.id" has no internal sequence/,
    'an identity column without an internal sequence',
  );
  await assert.rejects(
    () =>
      mapCatalog(
        payload({
          tables: [table('public', 't')],
          columns: [column('public', 't', 1, 'x', { type: 'integer' })],
          sequences: [
            sequence('public', 't_id_seq', {
              dataType: 'integer',
              ownerKind: 'identity',
              ownerSchema: 'public',
              ownerTable: 't',
              ownerColumn: 'x',
            }),
          ],
        }),
      ),
    /catalog payload: internal sequence "public\.t_id_seq" is owned by column "public\.t\.x", which is not an identity column/,
    'an internal sequence on a non-identity column',
  );
  await assert.rejects(
    () =>
      mapCatalog(
        payload({
          ...identityBase,
          sequences: [
            sequence('public', 't_id_seq', {
              dataType: 'integer',
              ownerKind: 'identity',
              ownerSchema: 'public',
              ownerTable: 't',
              ownerColumn: 'id',
            }),
            sequence('public', 't_id_seq2', {
              dataType: 'integer',
              ownerKind: 'identity',
              ownerSchema: 'public',
              ownerTable: 't',
              ownerColumn: 'id',
            }),
          ],
        }),
      ),
    /catalog payload: identity column "public\.t\.id" has more than one internal sequence/,
    'two internal sequences for one column',
  );
  await assert.rejects(
    () =>
      mapCatalog(
        payload({
          tables: [table('public', 't')],
          columns: [column('public', 't', 1, 'id', { type: 'text', attidentity: 'a' })],
          sequences: [
            sequence('public', 't_id_seq', {
              ownerKind: 'identity',
              ownerSchema: 'public',
              ownerTable: 't',
              ownerColumn: 'id',
            }),
          ],
        }),
      ),
    /catalog payload: identity column "public\.t\.id" has type "text", which is not an integer type/,
    'an identity column of a non-integer type',
  );
  await assert.rejects(
    () =>
      mapCatalog(
        payload({
          tables: [table('public', 't')],
          columns: [column('public', 't', 1, 'id', { type: 'integer' })],
          sequences: [
            sequence('public', 't_id_seq', {
              dataType: 'integer',
              ownerKind: 'owned',
              ownerSchema: 'public',
              ownerTable: 't',
              ownerColumn: 'missing',
            }),
          ],
        }),
      ),
    /catalog payload: sequence "public\.t_id_seq" is owned by column "public\.t\.missing", which is not a read column of its table/,
    'an owner column on an otherwise-read ordinary table',
  );
  await assert.rejects(
    () => mapCatalog(payload({ sequences: [sequence('public', 's', { ownerKind: 'owned' })] })),
    /catalog payload: sequence "public\.s" is owned but carries no owner table/,
    'an owned row without an owner table',
  );
  await assert.rejects(
    () =>
      mapCatalog(
        payload({
          tables: [table('public', 't')],
          columns: [column('public', 't', 1, 'id', { type: 'integer', attidentity: 'x' })],
          sequences: [
            sequence('public', 't_id_seq', {
              dataType: 'integer',
              ownerKind: 'identity',
              ownerSchema: 'public',
              ownerTable: 't',
              ownerColumn: 'id',
            }),
          ],
        }),
      ),
    /catalog payload: identity column "public\.t\.id" has unknown attidentity "x"/,
    'an unknown attidentity letter',
  );
});

test('rejects duplicate and malformed sequence rows', async () => {
  await assert.rejects(
    () =>
      mapCatalog(
        payload({
          sequences: [sequence('public', 's'), sequence('public', 's', { increment: '2' })],
        }),
      ),
    /catalog payload: duplicate sequence "public\.s"/,
    'two sequence rows for one identity',
  );

  const cases: readonly (readonly [string, unknown, RegExp])[] = [
    [
      'a missing sequences section',
      {
        tables: [],
        columns: [],
        primaryKeys: [],
        indexes: [],
        constraints: [],
        notNullConstraints: [],
      },
      /catalog payload\.sequences must be an array/,
    ],
    [
      'a non-array sequences section',
      {
        tables: [],
        columns: [],
        primaryKeys: [],
        indexes: [],
        constraints: [],
        notNullConstraints: [],
        sequences: {},
      },
      /catalog payload\.sequences must be an array/,
    ],
    [
      'an unknown sequence field',
      payload({ sequences: [{ ...sequence('public', 's'), extra: true }] }),
      /catalog payload\.sequences\[0\] carries an unknown field "extra"/,
    ],
    [
      'a non-string sequence field',
      payload({ sequences: [{ ...sequence('public', 's'), start: 1 }] }),
      /catalog payload\.sequences\[0\]\.start must be a string/,
    ],
    [
      'a non-boolean cycle',
      payload({ sequences: [sequence('public', 's', { cycle: 'yes' })] }),
      /catalog payload\.sequences\[0\]\.cycle must be a boolean/,
    ],
    [
      'an unsupported data type',
      payload({ sequences: [sequence('public', 's', { dataType: 'numeric' })] }),
      /catalog payload\.sequences\[0\]\.dataType must be "smallint", "integer", or "bigint"/,
    ],
    [
      'an unsupported owner kind',
      payload({ sequences: [sequence('public', 's', { ownerKind: 'serial' })] }),
      /catalog payload\.sequences\[0\]\.ownerKind must be "owned", "identity", or null/,
    ],
    [
      'an unsupported persistence',
      payload({ sequences: [sequence('public', 's', { persistence: 'x' })] }),
      /catalog payload\.sequences\[0\]\.persistence must be "p", "u", or "t"/,
    ],
  ];
  for (const [label, malformed, pattern] of cases) {
    await assert.rejects(() => mapCatalog(malformed), pattern, label);
  }
});

test('flags ordinary and identity sequence persistence and keeps the model state', async () => {
  const read = await mapCatalog(
    payload({
      tables: [table('public', 't'), table('public', 'u', { relpersistence: 'u' })],
      columns: [
        column('public', 't', 1, 'id', { type: 'integer', attidentity: 'a' }),
        column('public', 'u', 1, 'id', { type: 'integer', attidentity: 'a' }),
      ],
      indexes: [
        index('public', 't', 't_bad_idx', definition('public', 't', 't_bad_idx', 'id'), {
          valid: false,
        }),
      ],
      sequences: [
        sequence('public', 'plain_unlogged', { persistence: 'u' }),
        sequence('public', 'plain_temp', { persistence: 't' }),
        sequence('public', 't_id_seq', {
          dataType: 'integer',
          maxValue: '2147483647',
          persistence: 'u',
          ownerKind: 'identity',
          ownerSchema: 'public',
          ownerTable: 't',
          ownerColumn: 'id',
        }),
        sequence('public', 'u_id_seq', {
          dataType: 'integer',
          maxValue: '2147483647',
          persistence: 'p',
          ownerKind: 'identity',
          ownerSchema: 'public',
          ownerTable: 'u',
          ownerColumn: 'id',
        }),
      ],
    }),
  );

  assert.deepEqual(
    read.model.sequences.map((entry) => `${entry.schema}.${entry.name}`),
    ['public.plain_temp', 'public.plain_unlogged'],
    'unlogged and temporary ordinary sequences still map plain',
  );
  assert.equal(
    read.model.tables[0]?.columns[0]?.identity?.sequenceName?.name,
    't_id_seq',
    'the unlogged identity sequence still attaches',
  );
  assert.equal(
    read.model.tables[1]?.columns[0]?.identity?.sequenceName?.name,
    'u_id_seq',
    'the logged identity sequence on an unlogged table still attaches',
  );

  assert.deepEqual(read.diagnostics, [
    {
      kind: 'skip',
      code: 'unsupported-statement',
      object: 'public.t_bad_idx',
      message:
        'index public.t_bad_idx is not valid and ready; invalid indexes are not represented yet',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.plain_temp',
      message:
        'sequence public.plain_temp is temporary; temporary sequence persistence is not represented yet',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.plain_unlogged',
      message:
        'sequence public.plain_unlogged is unlogged; unlogged sequence persistence is not represented yet',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.t',
      message:
        "column id's identity sequence public.t_id_seq has unlogged persistence; identity persistence is not represented yet",
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.u',
      message:
        "column id's identity sequence public.u_id_seq has logged persistence; identity persistence is not represented yet",
    },
  ]);
  for (const diagnostic of read.diagnostics) {
    assert.equal('position' in diagnostic, false, 'introspection diagnostics carry no position');
  }
});

test('sorts sequences independently of payload order and keeps identity on its column', async () => {
  const sections = {
    tables: [table('public', 't')],
    columns: [
      column('public', 't', 1, 'id', { type: 'integer', attidentity: 'a' }),
      column('public', 't', 2, 'note'),
    ],
    sequences: [
      sequence('public', 'z_seq'),
      sequence('app', 'b_seq'),
      sequence('app', 'a_seq'),
      sequence('public', 't_id_seq', {
        dataType: 'integer',
        maxValue: '2147483647',
        ownerKind: 'identity',
        ownerSchema: 'public',
        ownerTable: 't',
        ownerColumn: 'id',
      }),
    ],
  };
  const forward = await mapCatalog(payload(sections));
  const reversed = await mapCatalog(
    payload({ ...sections, sequences: [...sections.sequences].reverse() }),
  );

  assert.deepEqual(forward, reversed, 'the mapper does not depend on sequence payload order');
  assert.deepEqual(
    forward.model.sequences.map((entry) => `${entry.schema}.${entry.name}`),
    ['app.a_seq', 'app.b_seq', 'public.z_seq'],
    'sequences come back in schema-then-name order, identity rows never among them',
  );
  assert.deepEqual(
    forward.model.tables[0]?.columns.map((column) => column.name),
    ['id', 'note'],
    'columns keep attribute order',
  );
  assert.equal(
    forward.model.tables[0]?.columns[0]?.identity?.sequenceName?.name,
    't_id_seq',
    'the identity stays attached to its column',
  );
});

test('maps a serial-owned sequence beside an identity column on the same column', async () => {
  const read = await mapCatalog(
    payload({
      tables: [table('public', 't')],
      columns: [column('public', 't', 1, 'id', { type: 'integer', attidentity: 'a' })],
      sequences: [
        sequence('public', 't_id_seq', {
          dataType: 'integer',
          ownerKind: 'identity',
          ownerSchema: 'public',
          ownerTable: 't',
          ownerColumn: 'id',
        }),
        sequence('public', 't_id_seq1', {
          dataType: 'integer',
          maxValue: '2147483647',
          ownerKind: 'owned',
          ownerSchema: 'public',
          ownerTable: 't',
          ownerColumn: 'id',
        }),
      ],
    }),
  );

  assert.deepEqual(read.model.sequences, [
    {
      schema: 'public',
      name: 't_id_seq1',
      dataType: 'integer',
      increment: '1',
      minValue: '1',
      maxValue: '2147483647',
      start: '1',
      cache: '1',
      cycle: false,
      ownedBy: { table: { schema: 'public', name: 't' }, column: 'id' },
    },
  ]);
  assert.equal(
    read.model.tables[0]?.columns[0]?.identity?.sequenceName?.name,
    't_id_seq',
    'the internal sequence attaches as identity, the leftover owned sequence stays a sequence',
  );
  assert.deepEqual(read.diagnostics, []);
});

test('reads defaults whitespace-normalized, only with atthasdef and an attrdef row', async () => {
  const read = await mapCatalog(
    payload({
      tables: [table('public', 't')],
      columns: [
        column('public', 't', 1, 'q', { atthasdef: true, default: "'q'::text" }),
        column('public', 't', 2, 'arr', { atthasdef: true, default: 'ARRAY[1, 2, 3]' }),
        column('public', 't', 3, 'now', { atthasdef: true, default: 'CURRENT_TIMESTAMP' }),
        column('public', 't', 4, 'spaced', { atthasdef: true, default: '(2  +   3)' }),
        column('public', 't', 5, 'unset', { default: 'ignored' }),
        column('public', 't', 6, 'no-row', { atthasdef: true }),
      ],
    }),
  );

  assert.deepEqual(read.model.tables[0]?.columns, [
    { name: 'q', type: 'text', notNull: false, default: "'q'::text" },
    { name: 'arr', type: 'text', notNull: false, default: 'ARRAY[1,2,3]' },
    { name: 'now', type: 'text', notNull: false, default: 'CURRENT_TIMESTAMP' },
    { name: 'spaced', type: 'text', notNull: false, default: '(2 + 3)' },
    { name: 'unset', type: 'text', notNull: false },
    { name: 'no-row', type: 'text', notNull: false },
  ]);
  assert.deepEqual(read.diagnostics, []);
});

test('reads a default byte-identical to the dump import of its own dumped text', async () => {
  // The pin behind the dump-import congruence bar: the catalog normalizes `pg_get_expr` text
  // with the importer's own helper, so the dump's `DEFAULT ARRAY[1, 2, 3]` and the catalog's
  // `ARRAY[1, 2, 3]` map to one model value.
  const imported = await importDump(
    "CREATE TABLE public.t (a integer DEFAULT ARRAY[1, 2, 3], b text DEFAULT 'a''b'::text, c timestamptz DEFAULT now());",
  );
  const read = await mapCatalog(
    payload({
      tables: [table('public', 't')],
      columns: [
        column('public', 't', 1, 'a', {
          type: 'integer',
          atthasdef: true,
          default: 'ARRAY[1, 2, 3]',
        }),
        column('public', 't', 2, 'b', { atthasdef: true, default: "'a''b'::text" }),
        column('public', 't', 3, 'c', {
          type: 'timestamp with time zone',
          atthasdef: true,
          default: 'now()',
        }),
      ],
    }),
  );

  assert.deepEqual(imported.diagnostics, []);
  assert.deepEqual(read.diagnostics, []);
  assert.deepEqual(
    read.model.tables[0]?.columns.map((column) => column.default),
    imported.model.tables[0]?.columns.map((column) => column.default),
    'both sides of the congruence bar normalize to the same default text',
  );
});

test("reads an explicit collation in pg_dump's spelling, only when explicit", async () => {
  const read = await mapCatalog(
    payload({
      tables: [table('public', 't')],
      columns: [
        // The live-probe spellings: a bare quoted name in `pg_catalog` and a mixed-case user
        // collation in its own schema, both as `format('%I.%I', …)` assembles them.
        column('public', 't', 1, 'c_qualified', {
          attcollation: 950,
          typcollation: 100,
          collation: 'pg_catalog."C"',
        }),
        column('public', 't', 2, 'c_user', {
          attcollation: 49153,
          typcollation: 100,
          collation: 'probe77."User_C"',
        }),
        // The SQL gates the spelling, but the mapper's explicit-only rule is its own gate: a
        // value equal to the type's collation is dropped even when the payload carries text.
        column('public', 't', 3, 'c_default', {
          attcollation: 100,
          typcollation: 100,
          collation: 'pg_catalog."default"',
        }),
        column('public', 't', 4, 'c_none', { attcollation: 0, typcollation: 0 }),
      ],
    }),
  );

  assert.deepEqual(read.model.tables[0]?.columns, [
    { name: 'c_qualified', type: 'text', notNull: false, collation: 'pg_catalog."C"' },
    { name: 'c_user', type: 'text', notNull: false, collation: 'probe77."User_C"' },
    { name: 'c_default', type: 'text', notNull: false },
    { name: 'c_none', type: 'text', notNull: false },
  ]);
  assert.deepEqual(read.diagnostics, []);
});

test('maps the storage letters, only when explicit', async () => {
  const read = await mapCatalog(
    payload({
      tables: [table('public', 't')],
      columns: [
        column('public', 't', 1, 'plain', { attstorage: 'p', typstorage: 'x' }),
        column('public', 't', 2, 'external', { attstorage: 'e', typstorage: 'x' }),
        column('public', 't', 3, 'extended', { attstorage: 'x', typstorage: 'p' }),
        column('public', 't', 4, 'main', { attstorage: 'm', typstorage: 'x' }),
        column('public', 't', 5, 'same', { attstorage: 'e', typstorage: 'e' }),
        column('public', 't', 6, 'same-plain', { attstorage: 'p', typstorage: 'p' }),
      ],
    }),
  );

  assert.deepEqual(
    read.model.tables[0]?.columns.map((column) => column.storage ?? '(absent)'),
    ['plain', 'external', 'extended', 'main', '(absent)', '(absent)'],
    "the letter maps to its word only where it differs from the type's storage",
  );
  assert.deepEqual(read.diagnostics, []);
});

test('maps the compression letters, only when explicit', async () => {
  const read = await mapCatalog(
    payload({
      tables: [table('public', 't')],
      columns: [
        column('public', 't', 1, 'pglz', { attcompression: 'p' }),
        column('public', 't', 2, 'lz4', { attcompression: 'l' }),
        column('public', 't', 3, 'none'),
      ],
    }),
  );

  assert.deepEqual(
    read.model.tables[0]?.columns.map((column) => column.compression ?? '(absent)'),
    ['pglz', 'lz4', '(absent)'],
    'the empty string is the absent state — the PostgreSQL 13 floor reads no letter at all',
  );
  assert.deepEqual(read.diagnostics, []);
});

test('maps default, collation, storage, and compression together on one column', async () => {
  const read = await mapCatalog(
    payload({
      tables: [table('public', 't')],
      columns: [
        column('public', 't', 1, 'all', {
          atthasdef: true,
          default: "'x'::text",
          attcollation: 950,
          typcollation: 100,
          collation: 'pg_catalog."C"',
          attstorage: 'e',
          typstorage: 'x',
          attcompression: 'l',
        }),
      ],
    }),
  );

  assert.deepEqual(read.model.tables[0]?.columns, [
    {
      name: 'all',
      type: 'text',
      notNull: false,
      default: "'x'::text",
      collation: 'pg_catalog."C"',
      storage: 'external',
      compression: 'lz4',
    },
  ]);
  assert.deepEqual(read.diagnostics, []);
});

test('reads unlogged persistence, keeps temporary flagged, and skips partitioned relations', async () => {
  const read = await mapCatalog(
    payload({
      tables: [
        table('public', 'unlogged', { relpersistence: 'u' }),
        table('public', 'partitioned', { relkind: 'p' }),
        table('public', 'temp', { relpersistence: 't' }),
        table('public', 'partition_child', { relispartition: true }),
        table('public', 'logged'),
      ],
      columns: [
        column('public', 'unlogged', 1, 'x', { type: 'integer' }),
        column('public', 'temp', 1, 'y'),
        column('public', 'logged', 1, 'z'),
      ],
    }),
  );

  assert.deepEqual(
    read.model.tables.map((table) => `${table.schema}.${table.name}`),
    ['public.logged', 'public.temp', 'public.unlogged'],
    'ordinary relations are mapped; partitioned ones are skipped',
  );
  assert.deepEqual(
    read.model.tables.map((table) => `${table.name}:${table.persistence ?? '(absent)'}`),
    ['logged:(absent)', 'temp:(absent)', 'unlogged:unlogged'],
    'unlogged persistence travels the model; logged is absent and temporary is not modeled',
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
      'a missing constraints section',
      { tables: [], columns: [], primaryKeys: [] },
      /catalog payload\.constraints must be an array/,
    ],
    [
      'a missing not-null section',
      { tables: [], columns: [], primaryKeys: [], constraints: [] },
      /catalog payload\.notNullConstraints must be an array/,
    ],
    [
      'a missing indexes section',
      { tables: [], columns: [], primaryKeys: [], constraints: [], notNullConstraints: [] },
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
      'a non-string default',
      payload({
        tables: [table('public', 't')],
        columns: [column('public', 't', 1, 'x', { default: 7 })],
      }),
      /catalog payload\.columns\[0\]\.default must be a string or null/,
    ],
    [
      'a non-string collation',
      payload({
        tables: [table('public', 't')],
        columns: [column('public', 't', 1, 'x', { collation: 7 })],
      }),
      /catalog payload\.columns\[0\]\.collation must be a string or null/,
    ],
    [
      'an unknown column row field',
      payload({
        tables: [table('public', 't')],
        columns: [{ ...column('public', 't', 1, 'x'), extra: true }],
      }),
      /catalog payload\.columns\[0\] carries an unknown field "extra"/,
    ],
    [
      'an unknown storage letter behind an explicit setting',
      payload({
        tables: [table('public', 't')],
        columns: [column('public', 't', 1, 'x', { attstorage: 'z', typstorage: 'x' })],
      }),
      /catalog payload: unknown attstorage letter "z"/,
    ],
    [
      'an unknown compression letter',
      payload({
        tables: [table('public', 't')],
        columns: [column('public', 't', 1, 'x', { attcompression: 'q' })],
      }),
      /catalog payload: unknown attcompression letter "q"/,
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

test('maps every constraint kind with its attributes and strips every conventional name', async () => {
  const read = await mapCatalog(
    payload({
      tables: [table('public', 'parent'), table('public', 'names')],
      columns: [
        column('public', 'parent', 1, 'id', { type: 'integer', attnotnull: true }),
        column('public', 'names', 1, 'a', { type: 'integer', attnotnull: true }),
        column('public', 'names', 2, 'b', { type: 'integer', attnotnull: true }),
        column('public', 'names', 3, 'ref', { type: 'integer' }),
      ],
      primaryKeys: [key('public', 'names', 'names_pkey', 1, 'a')],
      constraints: [
        uniqueConstraint('public', 'names', 'names_a_key', ['a'], {
          deferrable: true,
          deferred: true,
        }),
        checkConstraint('public', 'names', 'names_b_check', 'b > 0'),
        foreignKey('public', 'names', 'names_ref_fkey', ['ref'], 'public', 'parent', ['id'], {
          onUpdate: 'c',
          onDelete: 'n',
          deferrable: true,
          deferred: true,
        }),
      ],
      notNullConstraints: [notNull('public', 'names', 'a', 'names_a_not_null')],
    }),
  );

  const names = read.model.tables.find((candidate) => candidate.name === 'names');
  assert.ok(names, 'the table is mapped with its constraints');
  assert.deepEqual(names.columns, [
    { name: 'a', type: 'integer', notNull: true },
    { name: 'b', type: 'integer', notNull: true },
    { name: 'ref', type: 'integer', notNull: false },
  ]);
  assert.deepEqual(names.primaryKey, { columns: ['a'] });
  assert.deepEqual(names.uniqueConstraints, [
    { columns: ['a'], deferrable: true, initiallyDeferred: true },
  ]);
  assert.deepEqual(names.checkConstraints, [{ expression: 'b > 0' }]);
  assert.deepEqual(names.foreignKeys, [
    {
      columns: ['ref'],
      referencedTable: { schema: 'public', name: 'parent' },
      referencedColumns: ['id'],
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
      deferrable: true,
      initiallyDeferred: true,
    },
  ]);
  assert.deepEqual(read.diagnostics, []);
});

test('strips every conventional constraint formula, truncated server forms included', async () => {
  const long = 'w'.repeat(60);
  const read = await mapCatalog(
    payload({
      tables: [table('public', 'parent'), table('public', 'names'), table('public', 'other')],
      columns: [
        column('public', 'parent', 1, 'id', { type: 'integer' }),
        column('public', 'names', 1, 'a', { type: 'integer', attnotnull: true }),
        column('public', 'names', 2, 'b', { type: 'integer', attnotnull: true }),
        column('public', 'names', 3, long, { type: 'integer', attnotnull: true }),
        column('public', 'other', 1, 'id', { type: 'integer', attnotnull: true }),
      ],
      primaryKeys: [
        key('public', 'names', 'names_pkey', 1, 'a'),
        key('public', 'other', 'names_pkey', 1, 'id'),
      ],
      constraints: [
        uniqueConstraint('public', 'names', 'names_a_key', ['a']),
        uniqueConstraint('public', 'names', 'names_b_key', ['b']),
        uniqueConstraint('public', 'names', 'names_custom_key', ['b']),
        uniqueConstraint('public', 'names', `names_${'w'.repeat(53)}_key`, [long]),
        checkConstraint('public', 'names', 'names_a_check', 'a > 0'),
        checkConstraint('public', 'names', 'names_ab_check', 'a > b'),
        checkConstraint('public', 'names', `names_${'w'.repeat(51)}_check`, `${long} > 0`),
        foreignKey('public', 'names', 'names_a_fkey', ['a'], 'public', 'parent', ['id']),
        foreignKey('public', 'names', 'names_custom_fkey', ['b'], 'public', 'parent', ['id']),
        foreignKey('public', 'names', `names_${'w'.repeat(52)}_fkey`, [long], 'public', 'parent', [
          'id',
        ]),
      ],
      notNullConstraints: [
        notNull('public', 'names', 'a', 'names_a_not_null'),
        notNull('public', 'names', 'b', 'custom_nn'),
        notNull('public', 'names', long, `names_${'w'.repeat(48)}_not_null`),
        notNull('public', 'other', 'id', 'names_pkey_not_null'),
      ],
    }),
  );

  const names = read.model.tables.find((candidate) => candidate.name === 'names');
  const other = read.model.tables.find((candidate) => candidate.name === 'other');
  assert.ok(names, 'the names table is mapped');
  assert.ok(other, 'the other table is mapped');
  assert.deepEqual(
    names.uniqueConstraints,
    [
      { columns: ['a'] },
      { columns: ['b'] },
      { name: 'names_custom_key', columns: ['b'] },
      { columns: [long] },
    ],
    'unique names strip against their own formula; a foreign formula stays named',
  );
  assert.deepEqual(
    names.checkConstraints,
    [
      { expression: 'a > 0' },
      { name: 'names_ab_check', expression: 'a > b' },
      { expression: `${long} > 0` },
    ],
    'check names strip against the expression formula; a foreign formula stays named',
  );
  assert.deepEqual(
    names.foreignKeys,
    [
      {
        columns: ['a'],
        referencedTable: { schema: 'public', name: 'parent' },
        referencedColumns: ['id'],
      },
      {
        name: 'names_custom_fkey',
        columns: ['b'],
        referencedTable: { schema: 'public', name: 'parent' },
        referencedColumns: ['id'],
      },
      {
        columns: [long],
        referencedTable: { schema: 'public', name: 'parent' },
        referencedColumns: ['id'],
      },
    ],
    'foreign-key names strip against their own formula; custom names stay',
  );
  assert.deepEqual(names.primaryKey, { columns: ['a'] });
  assert.deepEqual(
    other.primaryKey,
    { name: 'names_pkey', columns: ['id'] },
    'a conventional name for another table stays named',
  );
  assert.deepEqual(
    names.columns.map((column) => column.notNullName ?? '(unnamed)'),
    ['(unnamed)', 'custom_nn', '(unnamed)'],
    'generated not-null names strip; a custom name travels the model',
  );
  assert.deepEqual(other.columns[0], {
    name: 'id',
    type: 'integer',
    notNull: true,
    notNullName: 'names_pkey_not_null',
  });
  assert.deepEqual(read.diagnostics, []);
});

test('strips truncated conventional names for every formula', async () => {
  const columnName = 'w'.repeat(60);
  const tableName = 'x'.repeat(60);
  const read = await mapCatalog(
    payload({
      tables: [table('public', 't'), table('public', tableName)],
      columns: [
        column('public', 't', 1, columnName, { attnotnull: true }),
        column('public', tableName, 1, 'id', { attnotnull: true }),
      ],
      primaryKeys: [key('public', tableName, `${'x'.repeat(58)}_pkey`, 1, 'id')],
      constraints: [
        uniqueConstraint('public', 't', `t_${'w'.repeat(57)}_key`, [columnName]),
        checkConstraint('public', 't', `t_${'w'.repeat(55)}_check`, `${columnName} > 0`),
        foreignKey('public', 't', `t_${'w'.repeat(56)}_fkey`, [columnName], 'public', 't', ['id']),
      ],
      notNullConstraints: [notNull('public', 't', columnName, `t_${'w'.repeat(52)}_not_null`)],
    }),
  );

  const mappedTable = read.model.tables.find((candidate) => candidate.name === 't');
  const longTable = read.model.tables.find((candidate) => candidate.name === tableName);
  assert.ok(mappedTable, 'the short table is mapped');
  assert.ok(longTable, 'the long table is mapped');
  assert.deepEqual(mappedTable.uniqueConstraints, [{ columns: [columnName] }]);
  assert.deepEqual(mappedTable.checkConstraints, [{ expression: `${columnName} > 0` }]);
  assert.deepEqual(mappedTable.foreignKeys, [
    {
      columns: [columnName],
      referencedTable: { schema: 'public', name: 't' },
      referencedColumns: ['id'],
    },
  ]);
  assert.deepEqual(mappedTable.columns[0]?.notNullName, undefined);
  assert.deepEqual(longTable.primaryKey, { columns: ['id'] });
  assert.deepEqual(read.diagnostics, []);
});

test('keeps a conventional name when stripping would duplicate an unnamed twin, in both orders', () => {
  const identity: TableIdentity = { schema: 'public', name: 't' };
  const unique = { columns: ['b'] };
  const check = { expression: 'b > 0' };
  const foreign = {
    columns: ['b'],
    referencedTable: { schema: 'public', name: 'p' },
    referencedColumns: ['id'],
  };
  const options = [
    {
      uniqueConstraints: [{ name: 't_b_key', ...unique }, unique],
      checkConstraints: [{ name: 't_b_check', ...check }, check],
      foreignKeys: [{ name: 't_b_fkey', ...foreign }, foreign],
    },
    {
      uniqueConstraints: [unique, { name: 't_b_key', ...unique }],
      checkConstraints: [check, { name: 't_b_check', ...check }],
      foreignKeys: [foreign, { name: 't_b_fkey', ...foreign }],
    },
  ];
  for (const constraints of options) {
    const canonical = canonicalizeConstraintNames(identity, constraints);
    assert.deepEqual(
      canonical.uniqueConstraints.filter((entry) => entry.name !== undefined),
      [{ name: 't_b_key', ...unique }],
      'the named twin keeps its name',
    );
    assert.deepEqual(
      canonical.checkConstraints.filter((entry) => entry.name !== undefined),
      [{ name: 't_b_check', ...check }],
      'the named check twin keeps its name',
    );
    assert.deepEqual(
      canonical.foreignKeys.filter((entry) => entry.name !== undefined),
      [{ name: 't_b_fkey', ...foreign }],
      'the named foreign-key twin keeps its name',
    );
  }
});

test('maps primary-key deferrability and period, and reports the temporal drop', async () => {
  const read = await mapCatalog(
    payload({
      tables: [table('public', 't')],
      columns: [column('public', 't', 1, 'a', { type: 'integer' })],
      primaryKeys: [
        key('public', 't', 't_pkey', 1, 'a', { deferrable: true, deferred: true, period: true }),
      ],
    }),
  );

  assert.deepEqual(read.model.tables[0]?.primaryKey, {
    columns: ['a'],
    deferrable: true,
    initiallyDeferred: true,
  });
  assert.deepEqual(read.diagnostics, [
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.t',
      message: 'dropped WITHOUT OVERLAPS on primary key t_pkey from public.t',
    },
  ]);
  assert.equal('position' in read.diagnostics[0]!, false);
});

test('maps the enforcement tri-state from 16- and 18-shaped rows', async () => {
  const read = await mapCatalog(
    payload({
      tables: [table('public', 't')],
      columns: [column('public', 't', 1, 'a', { type: 'integer' })],
      constraints: [
        checkConstraint('public', 't', 't_enforced', 'a > 0'),
        checkConstraint('public', 't', 't_not_valid', 'a > 1', { validated: false }),
        checkConstraint('public', 't', 't_not_enforced', 'a > 2', {
          validated: false,
          enforced: false,
        }),
      ],
    }),
  );

  assert.deepEqual(read.model.tables[0]?.checkConstraints, [
    { name: 't_enforced', expression: 'a > 0' },
    { name: 't_not_valid', expression: 'a > 1', enforcement: 'not-valid' },
    { name: 't_not_enforced', expression: 'a > 2', enforcement: 'not-enforced' },
  ]);
  assert.deepEqual(read.diagnostics, []);

  await assert.rejects(
    () =>
      mapCatalog(
        payload({
          tables: [table('public', 't')],
          columns: [column('public', 't', 1, 'a')],
          constraints: [
            checkConstraint('public', 't', 't_unreachable', 'a > 0', { enforced: false }),
          ],
        }),
      ),
    /catalog payload: constraint "public\.t\.t_unreachable" is validated but not enforced/,
    'validated but not enforced is unreachable',
  );
});

test('normalizes check text with the importer rules and keeps the inner text verbatim', async () => {
  const read = await mapCatalog(
    payload({
      tables: [table('public', 't')],
      columns: [column('public', 't', 1, 'a'), column('public', 't', 2, 'b')],
      constraints: [
        checkConstraint('public', 't', 'c1', 'a  >   0'),
        checkConstraint('public', 't', 'c2', '((a > 0) AND (a < 10))'),
        checkConstraint('public', 't', 'c3', 'EXTRACT(epoch FROM now())'),
        checkConstraint('public', 't', 'c4', '(a)::text = b'),
        checkConstraint('public', 't', 'c5', '"Mixed Case" > 0'),
        checkConstraint('public', 't', 'c6', '(t.* IS NOT NULL)'),
        checkConstraint('public', 't', 'c7', 'a /* note */ > 0'),
      ],
    }),
  );

  assert.deepEqual(
    read.model.tables[0]?.checkConstraints.map((constraint) => constraint.expression),
    [
      '"Mixed Case" > 0',
      '((a > 0) AND(a < 10))',
      '(a)::text = b',
      '(t.* IS NOT NULL)',
      'EXTRACT(epoch FROM now())',
      'a > 0',
      'a > 0',
    ],
    'the deparsed inner text is whitespace-normalized and otherwise kept verbatim',
  );
  assert.deepEqual(read.diagnostics, []);
});

test('reports every constraint diagnostic with the exact line, object, and order', async () => {
  const read = await mapCatalog(
    payload({
      tables: [table('public', 't')],
      columns: [
        column('public', 't', 1, 'a', { type: 'integer', attnotnull: true }),
        column('public', 't', 2, 'b', { type: 'integer' }),
        column('public', 't', 3, 'c', { type: 'integer' }),
        column('public', 't', 4, 'ref', { type: 'integer' }),
        column('public', 't', 5, 'nn1', { attnotnull: true }),
        column('public', 't', 6, 'nn2', { attnotnull: true }),
        column('public', 't', 7, 'nn3', { attnotnull: true }),
      ],
      primaryKeys: [key('public', 't', 't_pkey', 1, 'a', { period: true })],
      constraints: [
        checkConstraint('public', 't', 'c_both', 'a > 0', {
          noInherit: true,
          deferrable: true,
          deferred: true,
        }),
        checkConstraint('public', 't', 'c_defer', 'b > 0', { deferrable: true }),
        checkConstraint('public', 't', 'c_inherit', 'c > 0', { noInherit: true }),
        exclusionConstraint('public', 't', 'ex_skip'),
        foreignKey('public', 't', 'f_all', ['ref'], 'public', 'p', ['id'], {
          matchType: 'f',
          deleteSetColumnList: true,
          period: true,
        }),
        foreignKey('public', 't', 'f_cols', ['ref'], 'public', 'p', ['id'], {
          deleteSetColumnList: true,
        }),
        foreignKey('public', 't', 'f_full', ['ref'], 'public', 'p', ['id'], { matchType: 'f' }),
        foreignKey('public', 't', 'f_partial', ['ref'], 'public', 'p', ['id'], {
          matchType: 'p',
        }),
        foreignKey('public', 't', 'f_period', ['ref'], 'public', 'p', ['id'], { period: true }),
        uniqueConstraint('public', 't', 'u_all', ['a', 'b'], {
          nullsNotDistinct: true,
          including: true,
          period: true,
          validated: false,
        }),
        uniqueConstraint('public', 't', 't_b_key', ['b'], { including: true }),
        uniqueConstraint('public', 't', 'u_nulls', ['a'], { nullsNotDistinct: true }),
        uniqueConstraint('public', 't', 'u_period', ['c'], { period: true }),
        uniqueConstraint('public', 't', 'u_valid', ['a', 'b'], { validated: false }),
      ],
      notNullConstraints: [
        notNull('public', 't', 'nn1', 'nn_valid', { validated: false }),
        notNull('public', 't', 'nn2', 'nn_inherit', { noInherit: true }),
        notNull('public', 't', 'nn3', 'nn_all', { validated: false, noInherit: true }),
      ],
    }),
  );

  assert.deepEqual(read.diagnostics, [
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.t',
      message: 'dropped NOT VALID on not-null constraint nn_valid from public.t',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.t',
      message: 'dropped NO INHERIT on not-null constraint nn_inherit from public.t',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.t',
      message: 'dropped NOT VALID on not-null constraint nn_all from public.t',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.t',
      message: 'dropped NO INHERIT on not-null constraint nn_all from public.t',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.t',
      message: 'dropped NO INHERIT on check constraint c_both from public.t',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.t',
      message: 'dropped deferrability on check constraint c_both from public.t',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.t',
      message: 'dropped deferrability on check constraint c_defer from public.t',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.t',
      message: 'dropped NO INHERIT on check constraint c_inherit from public.t',
    },
    {
      kind: 'skip',
      code: 'unsupported-statement',
      object: 'public.ex_skip',
      message: 'skipped exclusion constraint public.ex_skip',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.t',
      message: 'dropped MATCH FULL on foreign key f_all from public.t',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.t',
      message: 'dropped column list on foreign key f_all from public.t',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.t',
      message: 'dropped PERIOD on foreign key f_all from public.t',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.t',
      message: 'dropped column list on foreign key f_cols from public.t',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.t',
      message: 'dropped MATCH FULL on foreign key f_full from public.t',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.t',
      message: 'dropped MATCH PARTIAL on foreign key f_partial from public.t',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.t',
      message: 'dropped PERIOD on foreign key f_period from public.t',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.t',
      message: 'dropped INCLUDE on unique constraint t_b_key from public.t',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.t',
      message: 'dropped WITHOUT OVERLAPS on primary key t_pkey from public.t',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.t',
      message: 'dropped NULLS NOT DISTINCT on unique constraint u_all from public.t',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.t',
      message: 'dropped INCLUDE on unique constraint u_all from public.t',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.t',
      message: 'dropped WITHOUT OVERLAPS on unique constraint u_all from public.t',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.t',
      message: 'dropped NOT VALID on unique constraint u_all from public.t',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.t',
      message: 'dropped NULLS NOT DISTINCT on unique constraint u_nulls from public.t',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.t',
      message: 'dropped WITHOUT OVERLAPS on unique constraint u_period from public.t',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.t',
      message: 'dropped NOT VALID on unique constraint u_valid from public.t',
    },
  ]);
  for (const diagnostic of read.diagnostics) {
    assert.equal('position' in diagnostic, false, 'introspection diagnostics carry no position');
  }

  assert.deepEqual(
    read.model.tables[0]?.uniqueConstraints.filter(
      (constraint) => constraint.columns.length === 1 && constraint.columns[0] === 'b',
    ),
    [{ columns: ['b'] }],
    'the diagnostic keeps the stored name while the model strips it',
  );

  assert.deepEqual(
    read.model.tables[0]?.checkConstraints,
    [
      { name: 'c_both', expression: 'a > 0' },
      { name: 'c_defer', expression: 'b > 0' },
      { name: 'c_inherit', expression: 'c > 0' },
    ],
    'check attributes are flagged and dropped, not modeled',
  );
});

test('orders constraints with core comparators and presence-aware names', async () => {
  const read = await mapCatalog(
    payload({
      tables: [table('public', 't'), table('public', 'parent')],
      columns: [
        column('public', 't', 1, 'a'),
        column('public', 't', 2, 'b'),
        column('public', 't', 3, 'c'),
        column('public', 'parent', 1, 'id'),
      ],
      constraints: [
        uniqueConstraint('public', 't', 'z_key', ['c']),
        uniqueConstraint('public', 't', 'b_key', ['b']),
        uniqueConstraint('public', 't', 'a_key', ['b']),
        uniqueConstraint('public', 't', 't_a_key', ['a']),
        checkConstraint('public', 't', 'b_check', 'b > 0'),
        checkConstraint('public', 't', 't_a_check', 'a > 0'),
        foreignKey('public', 't', 'z_fkey', ['b'], 'public', 'parent', ['id']),
        foreignKey('public', 't', 'a_fkey', ['b'], 'public', 'parent', ['id']),
        foreignKey('public', 't', 't_a_fkey', ['a'], 'public', 'parent', ['id']),
      ],
    }),
  );

  const mappedTable = read.model.tables.find((candidate) => candidate.name === 't');
  assert.ok(mappedTable, 'the table is mapped');
  assert.deepEqual(mappedTable.uniqueConstraints, [
    { columns: ['a'] },
    { name: 'a_key', columns: ['b'] },
    { name: 'b_key', columns: ['b'] },
    { name: 'z_key', columns: ['c'] },
  ]);
  assert.deepEqual(mappedTable.checkConstraints, [
    { expression: 'a > 0' },
    { name: 'b_check', expression: 'b > 0' },
  ]);
  assert.deepEqual(mappedTable.foreignKeys, [
    {
      columns: ['a'],
      referencedTable: { schema: 'public', name: 'parent' },
      referencedColumns: ['id'],
    },
    {
      name: 'a_fkey',
      columns: ['b'],
      referencedTable: { schema: 'public', name: 'parent' },
      referencedColumns: ['id'],
    },
    {
      name: 'z_fkey',
      columns: ['b'],
      referencedTable: { schema: 'public', name: 'parent' },
      referencedColumns: ['id'],
    },
  ]);
});

test('is independent of payload row order for constraints and not-null rows', async () => {
  const sections = {
    tables: [table('public', 'parent'), table('public', 't')],
    columns: [
      column('public', 'parent', 1, 'id', { type: 'integer' }),
      column('public', 't', 1, 'a', { type: 'integer', attnotnull: true }),
      column('public', 't', 2, 'b', { type: 'integer', attnotnull: true }),
    ],
    primaryKeys: [key('public', 't', 't_pkey', 1, 'a', { deferrable: true })],
    constraints: [
      uniqueConstraint('public', 't', 'u_b', ['b'], { nullsNotDistinct: true }),
      uniqueConstraint('public', 't', 't_a_key', ['a']),
      checkConstraint('public', 't', 't_b_check', 'b > 0'),
      foreignKey('public', 't', 't_b_fkey', ['b'], 'public', 'parent', ['id'], {
        onDelete: 'c',
      }),
      exclusionConstraint('public', 't', 't_excl'),
    ],
    notNullConstraints: [
      notNull('public', 't', 'a', 't_a_not_null'),
      notNull('public', 't', 'b', 'custom_b'),
    ],
  };
  const forward = await mapCatalog(payload(sections));
  const reversed = await mapCatalog(
    payload({
      ...sections,
      columns: [...sections.columns].reverse(),
      primaryKeys: [...sections.primaryKeys].reverse(),
      constraints: [...sections.constraints].reverse(),
      notNullConstraints: [...sections.notNullConstraints].reverse(),
    }),
  );

  assert.deepEqual(forward, reversed, 'the mapper does not depend on payload row order');
});

test('rejects rows that violate the per-kind matrix or the table contract', async () => {
  const base = {
    tables: [table('public', 't')],
    columns: [column('public', 't', 1, 'a')],
  };
  await assert.rejects(
    () =>
      mapCatalog(
        payload({
          ...base,
          constraints: [constraint('public', 't', 'u', 'unique', { columns: null })],
        }),
      ),
    /catalog payload: unique constraint "public\.t\.u" is missing columns/,
    'a required field missing from its kind',
  );
  await assert.rejects(
    () =>
      mapCatalog(
        payload({
          ...base,
          constraints: [uniqueConstraint('public', 't', 'u', ['a'], { expression: 'a > 0' })],
        }),
      ),
    /catalog payload: unique constraint "public\.t\.u" carries expression outside its kind/,
    'an irrelevant field stated for its kind',
  );
  await assert.rejects(
    () =>
      mapCatalog(
        payload({
          ...base,
          constraints: [checkConstraint('public', 't', 'c', 'a > 0', { columns: ['a'] })],
        }),
      ),
    /catalog payload: check constraint "public\.t\.c" carries columns outside its kind/,
    'a check row resolving columns',
  );
  await assert.rejects(
    () =>
      mapCatalog(
        payload({
          ...base,
          constraints: [checkConstraint('public', 't', 'c', 'a > 0', { period: true })],
        }),
      ),
    /catalog payload: check constraint "public\.t\.c" carries period outside its kind/,
    'a check row carrying the temporal flag',
  );
  await assert.rejects(
    () =>
      mapCatalog(
        payload({
          ...base,
          constraints: [
            exclusionConstraint('public', 't', 'x'),
            { ...exclusionConstraint('public', 't', 'y'), period: true },
          ],
        }),
      ),
    /catalog payload: exclusion constraint "public\.t\.y" carries period outside its kind/,
    'an exclusion row carrying an attribute',
  );
  await assert.rejects(
    () =>
      mapCatalog(
        payload({
          ...base,
          constraints: [
            {
              ...uniqueConstraint('public', 't', 'u', ['a']),
              kind: 'primary',
            },
          ],
        }),
      ),
    /catalog payload\.constraints\[0\]\.kind must be "unique", "check", "foreign-key", or "exclusion"/,
    'an unknown constraint kind',
  );
  await assert.rejects(
    () =>
      mapCatalog(
        payload({
          ...base,
          constraints: [
            uniqueConstraint('public', 't', 'u', ['a']),
            uniqueConstraint('public', 't', 'u', ['a']),
          ],
        }),
      ),
    /catalog payload: duplicate constraint "public\.t\.u"/,
    'two constraint rows for one name',
  );
  await assert.rejects(
    () =>
      mapCatalog(
        payload({
          ...base,
          constraints: [uniqueConstraint('public', 'missing', 'u', ['a'])],
        }),
      ),
    /catalog payload: constraint row for "public\.missing" references an unknown table/,
    'a constraint row without its table',
  );
  await assert.rejects(
    () =>
      mapCatalog(
        payload({
          ...base,
          constraints: [uniqueConstraint('public', 't', 'u', ['a'])],
          columns: [],
          tables: [{ ...table('public', 't'), relkind: 'p' }],
        }),
      ),
    /catalog payload: constraint row for "public\.t" belongs to a partitioned relation/,
    'a constraint row for a partitioned table',
  );
});

test('rejects not-null rows that do not match their column or repeat it', async () => {
  const base = {
    tables: [table('public', 't')],
    columns: [column('public', 't', 1, 'a'), column('public', 't', 2, 'b', { attnotnull: true })],
  };
  await assert.rejects(
    () =>
      mapCatalog(
        payload({
          ...base,
          notNullConstraints: [
            notNull('public', 't', 'b', 'nn_one'),
            notNull('public', 't', 'b', 'nn_two'),
          ],
        }),
      ),
    /catalog payload: duplicate not-null constraint for "public\.t\.b"/,
    'two not-null rows for one column',
  );
  await assert.rejects(
    () =>
      mapCatalog(
        payload({
          ...base,
          notNullConstraints: [notNull('public', 't', 'missing', 'nn_missing')],
        }),
      ),
    /catalog payload: not-null constraint for "public\.t\.missing" names a column the table does not carry/,
    'a not-null row on an orphan column',
  );
  await assert.rejects(
    () =>
      mapCatalog(
        payload({
          ...base,
          notNullConstraints: [notNull('public', 't', 'a', 'nn_a')],
        }),
      ),
    /catalog payload: not-null constraint "public\.t\.a" is on a column that is not NOT NULL/,
    'a not-null row on a nullable column',
  );
  await assert.rejects(
    () =>
      mapCatalog(
        payload({
          ...base,
          notNullConstraints: [notNull('public', 'missing', 'a', 'nn_a')],
        }),
      ),
    /catalog payload: not-null constraint row for "public\.missing" references an unknown table/,
    'a not-null row without its table',
  );
  await assert.rejects(
    () =>
      mapCatalog(
        payload({
          ...base,
          columns: [],
          tables: [{ ...table('public', 't'), relispartition: true }],
          notNullConstraints: [notNull('public', 't', 'b', 'nn_b')],
        }),
      ),
    /catalog payload: not-null constraint row for "public\.t" belongs to a partitioned relation/,
    'a not-null row for a partition child',
  );
});

test('rejects primary-key rows that disagree on their attributes', async () => {
  const base = {
    tables: [table('public', 't')],
    columns: [column('public', 't', 1, 'a'), column('public', 't', 2, 'b')],
  };
  for (const [label, second] of [
    ['deferrability', key('public', 't', 't_pkey', 2, 'b', { deferrable: true })],
    ['deferred', key('public', 't', 't_pkey', 2, 'b', { deferred: true })],
    ['period', key('public', 't', 't_pkey', 2, 'b', { period: true })],
  ] as const) {
    await assert.rejects(
      () =>
        mapCatalog(
          payload({
            ...base,
            primaryKeys: [key('public', 't', 't_pkey', 1, 'a'), second],
          }),
        ),
      /catalog payload: primary-key rows of "public\.t" disagree on their attributes/,
      `primary-key rows disagree on ${label}`,
    );
  }
});

test('rejects malformed constraint and not-null rows', async () => {
  const base = {
    tables: [table('public', 't')],
    columns: [column('public', 't', 1, 'a', { attnotnull: true })],
  };
  const cases: readonly (readonly [string, unknown, RegExp])[] = [
    [
      'an unknown constraint field',
      payload({
        ...base,
        constraints: [{ ...uniqueConstraint('public', 't', 'u', ['a']), extra: true }],
      }),
      /catalog payload\.constraints\[0\] carries an unknown field "extra"/,
    ],
    [
      'a wrong-typed constraint field',
      payload({
        ...base,
        constraints: [uniqueConstraint('public', 't', 'u', ['a'], { validated: 'yes' })],
      }),
      /catalog payload\.constraints\[0\]\.validated must be a boolean or null/,
    ],
    [
      'a wrong-typed column list',
      payload({
        ...base,
        constraints: [uniqueConstraint('public', 't', 'u', ['a'], { columns: 'a' })],
      }),
      /catalog payload\.constraints\[0\]\.columns must be an array of strings or null/,
    ],
    [
      'an unknown not-null field',
      payload({
        ...base,
        notNullConstraints: [{ ...notNull('public', 't', 'a', 'nn'), extra: true }],
      }),
      /catalog payload\.notNullConstraints\[0\] carries an unknown field "extra"/,
    ],
    [
      'a wrong-typed not-null flag',
      payload({
        ...base,
        notNullConstraints: [notNull('public', 't', 'a', 'nn', { noInherit: 'no' })],
      }),
      /catalog payload\.notNullConstraints\[0\]\.noInherit must be a boolean/,
    ],
    [
      'a primary-key row missing its attributes',
      payload({
        ...base,
        primaryKeys: [
          { schema: 'public', tableName: 't', conname: 't_pkey', ordinal: 1, attname: 'a' },
        ],
      }),
      /catalog payload\.primaryKeys\[0\]\.deferrable must be a boolean/,
    ],
  ];
  for (const [label, malformed, pattern] of cases) {
    await assert.rejects(() => mapCatalog(malformed), pattern, label);
  }
});

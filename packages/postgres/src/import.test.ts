import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Diagnostic, Model } from '@schemamill/core';

import { ddlImporter, importDump } from './index.ts';

/** Kind, code, and object of a diagnostic, with `object` omitted for errors. */
const summarize = (diagnostic: Diagnostic) =>
  diagnostic.kind === 'error'
    ? { kind: diagnostic.kind, code: diagnostic.code }
    : { kind: diagnostic.kind, code: diagnostic.code, object: diagnostic.object };

/**
 * Tests for the dump importer. The fixture is a fabricated pg_dump-shaped dump (no real client
 * data): meta-commands, settings, two schemas, quoted and multibyte identifiers, a spread of
 * types, inline and `ALTER TABLE` primary keys, foreign keys with and without stated actions,
 * constructs that must be skipped or flagged, a broken statement, and a COPY block.
 */

const DUMP = [
  '--',
  '-- PostgreSQL database dump',
  '--',
  '',
  String.raw`\restrict XyZ123`,
  '',
  `SET statement_timeout = 0;`,
  `SET client_encoding = 'UTF8';`,
  '',
  `CREATE SCHEMA app;`,
  '',
  `CREATE SEQUENCE public.users_id_seq`,
  `    START WITH 1`,
  `    INCREMENT BY 1`,
  `    NO MINVALUE`,
  `    NO MAXVALUE`,
  `    CACHE 1;`,
  '',
  `CREATE TABLE public.users (`,
  `    id bigint DEFAULT nextval('public.users_id_seq'::regclass) NOT NULL,`,
  `    email character varying(12) NOT NULL UNIQUE,`,
  `    display_name text COLLATE "C",`,
  `    age numeric(12, 2),`,
  `    score double precision DEFAULT 0.0,`,
  `    active boolean DEFAULT true NOT NULL,`,
  `    joined_at timestamp(3) with time zone DEFAULT now(),`,
  `    tags text[] DEFAULT ARRAY[]::text[],`,
  `    note text DEFAULT ('x' || 'y')::text,`,
  `    int_like int,`,
  `    integer_like integer,`,
  `    "Mixed Case" boolean DEFAULT false,`,
  `    counter bigint GENERATED ALWAYS AS IDENTITY,`,
  `    CONSTRAINT users_pkey PRIMARY KEY (id),`,
  `    CONSTRAINT users_age_check CHECK ((age >= 0))`,
  `);`,
  '',
  `CREATE TABLE app.orders (`,
  `    id bigint NOT NULL,`,
  `    user_id bigint NOT NULL,`,
  `    parent_id bigint,`,
  `    total numeric(12, 2) DEFAULT 0`,
  `);`,
  '',
  `CREATE TABLE app."Tábla" (`,
  `    "café" text DEFAULT 'naïve; value'`,
  `);`,
  '',
  `ALTER TABLE ONLY app.orders ADD CONSTRAINT orders_pkey PRIMARY KEY (id);`,
  '',
  `ALTER TABLE ONLY app.orders ADD CONSTRAINT orders_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES app.orders(id) DEFERRABLE INITIALLY DEFERRED NOT VALID;`,
  '',
  `ALTER TABLE ONLY app.orders ADD CONSTRAINT orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;`,
  '',
  `ALTER TABLE public.users OWNER TO app;`,
  '',
  `ALTER TABLE public.users ALTER COLUMN display_name SET DEFAULT 'anon';`,
  '',
  `CREATE INDEX idx_users_email ON public.users USING btree (email);`,
  '',
  `COMMENT ON TABLE public.users IS 'people';`,
  '',
  `GRANT SELECT ON TABLE public.users TO app;`,
  '',
  `SELECT pg_catalog.set_config('search_path', '', false);`,
  '',
  `CREATE TABLE public.broken (id bigint UNSIGNED);`,
  '',
  `COPY public.users (id, email) FROM stdin;`,
  '1\talice@example.test',
  '2\tback\\slash',
  '\\.',
  '',
  String.raw`\unrestrict XyZ123`,
  '',
].join('\n');

const EXPECTED_MODEL: Model = {
  tables: [
    {
      schema: 'app',
      name: 'Tábla',
      columns: [{ name: 'café', type: 'text', notNull: false, default: "'naïve; value'" }],
      foreignKeys: [],
    },
    {
      schema: 'app',
      name: 'orders',
      columns: [
        { name: 'id', type: 'bigint', notNull: true },
        { name: 'user_id', type: 'bigint', notNull: true },
        { name: 'parent_id', type: 'bigint', notNull: false },
        { name: 'total', type: 'numeric(12,2)', notNull: false, default: '0' },
      ],
      foreignKeys: [
        {
          name: 'orders_parent_id_fkey',
          columns: ['parent_id'],
          referencedTable: { schema: 'app', name: 'orders' },
          referencedColumns: ['id'],
        },
        {
          name: 'orders_user_id_fkey',
          columns: ['user_id'],
          referencedTable: { schema: 'public', name: 'users' },
          referencedColumns: ['id'],
          onDelete: 'CASCADE',
        },
      ],
      primaryKey: { name: 'orders_pkey', columns: ['id'] },
    },
    {
      schema: 'public',
      name: 'users',
      columns: [
        {
          name: 'id',
          type: 'bigint',
          notNull: true,
          default: "nextval('public.users_id_seq'::regclass)",
        },
        { name: 'email', type: 'character varying(12)', notNull: true },
        { name: 'display_name', type: 'text', notNull: false },
        { name: 'age', type: 'numeric(12,2)', notNull: false },
        { name: 'score', type: 'double precision', notNull: false, default: '0.0' },
        { name: 'active', type: 'boolean', notNull: true, default: 'true' },
        {
          name: 'joined_at',
          type: 'timestamp(3) with time zone',
          notNull: false,
          default: 'now()',
        },
        { name: 'tags', type: 'text[]', notNull: false, default: 'ARRAY[]::text[]' },
        { name: 'note', type: 'text', notNull: false, default: "('x' || 'y')::text" },
        { name: 'int_like', type: 'int', notNull: false },
        { name: 'integer_like', type: 'integer', notNull: false },
        { name: 'Mixed Case', type: 'boolean', notNull: false, default: 'false' },
        { name: 'counter', type: 'bigint', notNull: true },
      ],
      foreignKeys: [],
      primaryKey: { name: 'users_pkey', columns: ['id'] },
    },
  ],
};

const EXPECTED_DIAGNOSTICS = [
  { kind: 'skip', code: 'psql-meta-command', object: String.raw`\restrict` },
  { kind: 'skip', code: 'unsupported-statement', object: 'statement_timeout' },
  { kind: 'skip', code: 'unsupported-statement', object: 'client_encoding' },
  { kind: 'skip', code: 'unsupported-statement', object: 'app' },
  { kind: 'skip', code: 'unsupported-statement', object: 'public.users_id_seq' },
  { kind: 'flag', code: 'unsupported-attribute', object: 'public.users' },
  { kind: 'flag', code: 'unsupported-attribute', object: 'public.users' },
  { kind: 'flag', code: 'unsupported-attribute', object: 'public.users' },
  { kind: 'flag', code: 'unsupported-attribute', object: 'public.users' },
  { kind: 'flag', code: 'unsupported-attribute', object: 'app.orders' },
  { kind: 'flag', code: 'unsupported-attribute', object: 'app.orders' },
  { kind: 'skip', code: 'unsupported-statement', object: 'public.users' },
  { kind: 'skip', code: 'unsupported-statement', object: 'public.users' },
  { kind: 'skip', code: 'unsupported-statement', object: 'idx_users_email' },
  { kind: 'skip', code: 'unsupported-statement', object: 'public.users' },
  { kind: 'skip', code: 'unsupported-statement', object: 'GRANT' },
  { kind: 'skip', code: 'unsupported-statement', object: 'SELECT' },
  { kind: 'error', code: 'parse-failure' },
  { kind: 'skip', code: 'copy-data', object: 'COPY public.users' },
  { kind: 'skip', code: 'psql-meta-command', object: String.raw`\unrestrict` },
] as const;

test('imports a pg_dump-shaped dump into the canonical model', async () => {
  const { model } = await importDump(DUMP);

  assert.deepEqual(model, EXPECTED_MODEL);

  // `int` and `integer` stay distinct: the model keeps the written spelling.
  const users = model.tables.find((table) => table.name === 'users');
  assert.ok(users, 'the users table is imported');
  const intLike = users.columns.find((column) => column.name === 'int_like');
  const integerLike = users.columns.find((column) => column.name === 'integer_like');
  assert.equal(intLike?.type, 'int');
  assert.equal(integerLike?.type, 'integer');
  assert.notEqual(intLike?.type, integerLike?.type);

  // Source order is the column order; schema-qualified identity orders the tables.
  assert.deepEqual(
    users.columns.map((column) => column.name),
    [
      'id',
      'email',
      'display_name',
      'age',
      'score',
      'active',
      'joined_at',
      'tags',
      'note',
      'int_like',
      'integer_like',
      'Mixed Case',
      'counter',
    ],
  );
  assert.deepEqual(
    model.tables.map((table) => `${table.schema}.${table.name}`),
    ['app.Tábla', 'app.orders', 'public.users'],
  );

  // Multibyte identifiers survive as written.
  const multibyte = model.tables.find((table) => table.name === 'Tábla');
  assert.equal(multibyte?.columns[0]?.name, 'café');

  // Foreign key order is total: columns first, then the target, then the name.
  const orders = model.tables.find((table) => table.name === 'orders');
  assert.ok(orders, 'the orders table is imported');
  assert.deepEqual(
    orders.foreignKeys.map((foreignKey) => foreignKey.columns[0]),
    ['parent_id', 'user_id'],
  );

  // Actions are stored only when the source states a non-default one.
  const [parentForeignKey, userForeignKey] = orders.foreignKeys;
  assert.ok(parentForeignKey && userForeignKey, 'both foreign keys are imported');
  assert.equal('onDelete' in parentForeignKey, false);
  assert.equal('onUpdate' in parentForeignKey, false);
  assert.equal(userForeignKey.onDelete, 'CASCADE');
  assert.equal('onUpdate' in userForeignKey, false);
});

test('reports skips, flags, and failures in dump order', async () => {
  const { diagnostics } = await importDump(DUMP);

  assert.deepEqual(diagnostics.map(summarize), EXPECTED_DIAGNOSTICS);

  const offsets: number[] = [];
  for (const diagnostic of diagnostics) {
    assert.ok(diagnostic.position !== undefined, 'every diagnostic carries a position');
    offsets.push(diagnostic.position.offset);
  }
  assert.deepEqual(
    offsets,
    [...offsets].sort((left, right) => left - right),
  );

  const byMessage = (fragment: string) =>
    diagnostics.find((diagnostic) => diagnostic.message.includes(fragment));

  assert.match(byMessage('consumed 2 data lines')?.message ?? '', /terminating/);
  assert.match(byMessage('AT_ChangeOwner')?.message ?? '', /ALTER TABLE action/);
  assert.ok(byMessage('AT_ColumnDefault'), 'ALTER COLUMN SET DEFAULT is skipped and named');
  assert.ok(byMessage('COMMENT ON TABLE public.users'), 'COMMENT is skipped and named');
  const failure = diagnostics.find((diagnostic) => diagnostic.code === 'parse-failure');
  assert.match(failure?.message ?? '', /syntax error at or near "UNSIGNED"/);
  // Failures point at the parser's error cursor when it has one.
  assert.deepEqual(failure?.position, {
    offset: DUMP.indexOf('UNSIGNED'),
    line: 66,
    column: 39,
  });
});

test('records only stated referential actions and flags foreign-key extras', async () => {
  const dump = [
    `CREATE TABLE public.parent (id integer PRIMARY KEY);`,
    `CREATE TABLE public.child (a integer, b integer);`,
    `ALTER TABLE ONLY public.child ADD CONSTRAINT child_a_fkey FOREIGN KEY (a) REFERENCES public.parent(id) MATCH FULL ON UPDATE RESTRICT ON DELETE SET DEFAULT DEFERRABLE;`,
    `ALTER TABLE ONLY public.child ADD CONSTRAINT child_b_fkey FOREIGN KEY (b) REFERENCES public.parent(id) ON DELETE NO ACTION;`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const child = model.tables.find((table) => table.name === 'child');
  assert.ok(child, 'the child table is imported');

  assert.deepEqual(child.foreignKeys, [
    {
      name: 'child_a_fkey',
      columns: ['a'],
      referencedTable: { schema: 'public', name: 'parent' },
      referencedColumns: ['id'],
      onUpdate: 'RESTRICT',
      onDelete: 'SET DEFAULT',
    },
    {
      name: 'child_b_fkey',
      columns: ['b'],
      referencedTable: { schema: 'public', name: 'parent' },
      referencedColumns: ['id'],
    },
  ]);

  assert.deepEqual(
    diagnostics
      .filter((diagnostic) => diagnostic.kind === 'flag')
      .map((diagnostic) => diagnostic.message),
    [
      'dropped MATCH FULL on foreign key child_a_fkey from public.child',
      'dropped deferrability on foreign key child_a_fkey from public.child',
    ],
  );
});

test('skips a partition and flags a partitioned table', async () => {
  const dump = [
    `CREATE TABLE app.events (id bigint, happened_on date) PARTITION BY RANGE (happened_on);`,
    `CREATE TABLE app.events_2026 PARTITION OF app.events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);

  assert.deepEqual(
    model.tables.map((table) => `${table.schema}.${table.name}`),
    ['app.events'],
  );
  assert.deepEqual(
    model.tables[0]?.columns.map((column) => column.name),
    ['id', 'happened_on'],
  );
  assert.deepEqual(diagnostics.map(summarize), [
    { kind: 'flag', code: 'unsupported-attribute', object: 'app.events' },
    { kind: 'skip', code: 'unsupported-statement', object: 'app.events_2026' },
  ]);
  assert.match(diagnostics[0]?.message ?? '', /partitioning clauses/);
  assert.match(diagnostics[1]?.message ?? '', /partition app\.events_2026/);
});

test('isolates a parse failure and imports the statements around it', async () => {
  const dump = [
    `CREATE TABLE public.before (id integer);`,
    `CREATE TABLE public.broken (id bigint UNSIGNED);`,
    `CREATE TABLE public.after (id integer);`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);

  assert.deepEqual(
    model.tables.map((table) => table.name),
    ['after', 'before'],
  );
  assert.equal(diagnostics.length, 1);
  const [diagnostic] = diagnostics;
  assert.ok(diagnostic, 'the failure is reported');
  assert.equal(diagnostic.kind, 'error');
  assert.equal(diagnostic.code, 'parse-failure');
  assert.match(diagnostic.message, /syntax error at or near "UNSIGNED"/);
  assert.deepEqual(diagnostic.position, {
    offset: dump.indexOf('UNSIGNED'),
    line: 2,
    column: 39,
  });
});

test('binds the DdlImporter seam', async () => {
  const ddl = 'CREATE TABLE public.t (id integer NOT NULL);';
  const viaSeam = await ddlImporter.import(ddl);
  const viaFunction = await importDump(ddl);
  assert.deepEqual(viaSeam, viaFunction, 'the seam binding behaves exactly like importDump');
  assert.deepEqual(viaSeam.model, {
    tables: [
      {
        schema: 'public',
        name: 't',
        columns: [{ name: 'id', type: 'integer', notNull: true }],
        foreignKeys: [],
      },
    ],
  });
});

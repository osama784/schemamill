import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Diagnostic, Model, Sequence } from '@schemamill/core';

import { ddlImporter, importDump } from './index.ts';

/** Kind, code, and object of a diagnostic, with `object` omitted for errors. */
const summarize = (diagnostic: Diagnostic) =>
  diagnostic.kind === 'error'
    ? { kind: diagnostic.kind, code: diagnostic.code }
    : { kind: diagnostic.kind, code: diagnostic.code, object: diagnostic.object };

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
  `    id bigint NOT NULL,`,
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
  `ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);`,
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
        { name: 'display_name', type: 'text', notNull: false, default: "'anon'" },
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
  sequences: [
    {
      schema: 'public',
      name: 'users_id_seq',
      dataType: 'bigint',
      increment: '1',
      minValue: '1',
      maxValue: '9223372036854775807',
      start: '1',
      cache: '1',
      cycle: false,
    },
  ],
};

const EXPECTED_DIAGNOSTICS = [
  { kind: 'skip', code: 'psql-meta-command', object: String.raw`\restrict` },
  { kind: 'skip', code: 'unsupported-statement', object: 'statement_timeout' },
  { kind: 'skip', code: 'unsupported-statement', object: 'client_encoding' },
  { kind: 'skip', code: 'unsupported-statement', object: 'app' },
  { kind: 'flag', code: 'unsupported-attribute', object: 'public.users' },
  { kind: 'flag', code: 'unsupported-attribute', object: 'public.users' },
  { kind: 'flag', code: 'unsupported-attribute', object: 'public.users' },
  { kind: 'flag', code: 'unsupported-attribute', object: 'public.users' },
  { kind: 'flag', code: 'unsupported-attribute', object: 'app.orders' },
  { kind: 'flag', code: 'unsupported-attribute', object: 'app.orders' },
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

  // Sequence-backed defaults arrive via ALTER TABLE … SET DEFAULT (the pg_dump serial path).
  assert.equal(
    users.columns.find((column) => column.name === 'id')?.default,
    "nextval('public.users_id_seq'::regclass)",
  );
  assert.equal(users.columns.find((column) => column.name === 'display_name')?.default, "'anon'");

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
  assert.equal(
    byMessage('AT_ColumnDefault'),
    undefined,
    'SET DEFAULT attaches instead of being skipped',
  );
  assert.ok(byMessage('COMMENT ON TABLE public.users'), 'COMMENT is skipped and named');
  const failure = diagnostics.find((diagnostic) => diagnostic.code === 'parse-failure');
  assert.match(failure?.message ?? '', /syntax error at or near "UNSIGNED"/);
  // Failures point at the parser's error cursor when it has one.
  assert.deepEqual(failure?.position, {
    offset: DUMP.indexOf('UNSIGNED'),
    line: 68,
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

test('attaches SET DEFAULT, keeps existing defaults, and reports conflicts and unknowns', async () => {
  const dump = [
    `CREATE TABLE public.t (a integer DEFAULT 1, b integer, c integer);`,
    `ALTER TABLE ONLY public.t ALTER COLUMN b SET DEFAULT now();`,
    `ALTER TABLE ONLY public.t ALTER COLUMN c DROP DEFAULT;`,
    `ALTER TABLE ONLY public.t ALTER COLUMN a SET DEFAULT 2;`,
    `ALTER TABLE ONLY public.t ALTER COLUMN missing SET DEFAULT 3;`,
    `ALTER TABLE ONLY public.other ALTER COLUMN x SET DEFAULT 4;`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);

  const table = model.tables.find((candidate) => candidate.name === 't');
  assert.ok(table, 'the table is imported');
  assert.deepEqual(table.columns, [
    { name: 'a', type: 'integer', notNull: false, default: '1' },
    { name: 'b', type: 'integer', notNull: false, default: 'now()' },
    { name: 'c', type: 'integer', notNull: false },
  ]);

  assert.deepEqual(diagnostics.map(summarize), [
    { kind: 'skip', code: 'unsupported-statement', object: 'public.t' },
    { kind: 'flag', code: 'unsupported-attribute', object: 'public.t' },
    { kind: 'skip', code: 'unsupported-statement', object: 'public.t.missing' },
    { kind: 'skip', code: 'unsupported-statement', object: 'public.other' },
  ]);
  assert.match(diagnostics[1]?.message ?? '', /conflicting DEFAULT on public\.t\.a/);
});

test('preserves type-prefixed and parenthesized SET DEFAULT expressions', async () => {
  const dump = [
    `CREATE TABLE public.t (c interval, d date, e timestamp, f integer, g integer);`,
    `ALTER TABLE public.t ALTER COLUMN c SET DEFAULT interval '1 day', ALTER COLUMN d SET DEFAULT date '2026-01-01';`,
    `ALTER TABLE ONLY public.t ALTER COLUMN e SET DEFAULT timestamp '2026-01-01 00:00:00';`,
    `ALTER TABLE ONLY public.t ALTER COLUMN f SET DEFAULT ((1 + 2)) /* keep */;`,
    `ALTER TABLE public.t ALTER COLUMN missing SET DEFAULT 1, ALTER COLUMN g SET DEFAULT 2;`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);

  const table = model.tables.find((candidate) => candidate.name === 't');
  assert.ok(table, 'the table is imported');
  assert.deepEqual(
    table.columns.map((column) => column.default),
    ["interval '1 day'", "date '2026-01-01'", "timestamp '2026-01-01 00:00:00'", '((1 + 2))', '2'],
  );

  // A skipped unknown column still consumes its keyword, so the next command attaches correctly.
  assert.deepEqual(diagnostics.map(summarize), [
    { kind: 'skip', code: 'unsupported-statement', object: 'public.t.missing' },
  ]);
});

test('replaces a repeated CREATE TABLE wholesale', async () => {
  const dump = [
    `CREATE TABLE public.t (id integer, legacy_id integer);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_legacy_fkey FOREIGN KEY (legacy_id) REFERENCES public.other(id);`,
    `CREATE TABLE public.t (id integer, name text);`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);

  // The second definition wins wholesale: stale columns, primary key, and foreign keys are gone.
  assert.deepEqual(model, {
    tables: [
      {
        schema: 'public',
        name: 't',
        columns: [
          { name: 'id', type: 'integer', notNull: false },
          { name: 'name', type: 'text', notNull: false },
        ],
        foreignKeys: [],
      },
    ],
    sequences: [],
  });
  assert.deepEqual(diagnostics, []);
});

test('extracts spans around comments and preserves quoted text', async () => {
  const dump = [
    `CREATE TABLE public.t (a int, -- note`,
    `b text);`,
    `CREATE TABLE public.u (a int /* c */, b text);`,
    `CREATE TABLE public.v (a int DEFAULT 'x' /* , y */, b int);`,
    `CREATE TABLE public.w (a int DEFAULT 'x' -- , y`,
    `, b int);`,
    `CREATE TABLE public.x (a text DEFAULT 'a--b, c', b numeric(12, 2));`,
  ].join('\n');

  const { model } = await importDump(dump);
  const columnsOf = (name: string) => {
    const table = model.tables.find((candidate) => candidate.name === name);
    assert.ok(table, `table ${name} is imported`);
    return Object.fromEntries(table.columns.map((column) => [column.name, column]));
  };

  // Comments inside a column definition are dropped, not absorbed into the type or default.
  assert.equal(columnsOf('t').a?.type, 'int');
  assert.equal(columnsOf('t').b?.type, 'text');
  assert.equal(columnsOf('u').a?.type, 'int');
  assert.equal(columnsOf('v').a?.default, "'x'");
  assert.equal(columnsOf('w').a?.default, "'x'");
  // Comment markers inside a string literal survive verbatim.
  assert.equal(columnsOf('x').a?.default, "'a--b, c'");
  assert.equal(columnsOf('x').b?.type, 'numeric(12,2)');
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
    sequences: [],
  });
});

test('imports sequences with effective values, in both directions', async () => {
  const dump = [
    `CREATE SEQUENCE public.plain;`,
    `CREATE SEQUENCE app.custom AS smallint INCREMENT 3 MINVALUE 0 MAXVALUE 100 START 10 CACHE 7 CYCLE;`,
    `CREATE SEQUENCE public.desc INCREMENT -5;`,
    `CREATE SEQUENCE public.big MAXVALUE 9223372036854775807 START 9007199254740993;`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);

  assert.deepEqual(model.sequences, [
    sequence(
      'custom',
      {
        dataType: 'smallint',
        increment: '3',
        minValue: '0',
        maxValue: '100',
        start: '10',
        cache: '7',
        cycle: true,
      },
      'app',
    ),
    sequence('big', { start: '9007199254740993' }),
    sequence('desc', {
      increment: '-5',
      minValue: '-9223372036854775808',
      maxValue: '-1',
      start: '-1',
    }),
    sequence('plain'),
  ]);
  assert.deepEqual(diagnostics, []);
});

test('imports 64-bit sequence values exactly, never through a number', async () => {
  const dump = `CREATE SEQUENCE public.s MAXVALUE 9223372036854775807 START 9007199254740993;`;

  const { model } = await importDump(dump);
  const imported = model.sequences[0]!;

  assert.equal(imported.maxValue, '9223372036854775807');
  assert.equal(imported.start, '9007199254740993');
  // A JavaScript number would have rounded the start value down.
  assert.equal(Number(imported.start), 9007199254740992);
});

test('attaches separate OWNED BY options, NONE, and unqualified table names', async () => {
  const dump = [
    `CREATE TABLE public.t (id bigint NOT NULL, x bigint);`,
    `CREATE SEQUENCE public.t_id_seq AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;`,
    `ALTER SEQUENCE public.t_id_seq OWNED BY public.t.id;`,
    `CREATE SEQUENCE public.attached;`,
    `ALTER SEQUENCE public.attached OWNED BY public.t.x;`,
    `CREATE SEQUENCE public.detached;`,
    `ALTER SEQUENCE public.detached OWNED BY public.t.x;`,
    `ALTER SEQUENCE public.detached OWNED BY NONE;`,
    `CREATE SEQUENCE public.unqualified;`,
    `ALTER SEQUENCE public.unqualified OWNED BY t.x;`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const byName = new Map(model.sequences.map((entry) => [entry.name, entry]));

  assert.deepEqual(byName.get('t_id_seq')?.ownedBy, {
    table: { schema: 'public', name: 't' },
    column: 'id',
  });
  assert.deepEqual(byName.get('attached')?.ownedBy, {
    table: { schema: 'public', name: 't' },
    column: 'x',
  });
  assert.equal('ownedBy' in (byName.get('detached') ?? {}), false);
  assert.deepEqual(byName.get('unqualified')?.ownedBy, {
    table: { schema: 'public', name: 't' },
    column: 'x',
  });
  // The `AS integer` bounds are the effective ones.
  assert.equal(byName.get('t_id_seq')?.maxValue, '2147483647');
  assert.deepEqual(diagnostics, []);
});

test('applies ALTER SEQUENCE options as the engine does, not in source order', async () => {
  const dump = [
    // NO MINVALUE / NO MAXVALUE resolve against the type and the direction at that point.
    `CREATE SEQUENCE public.desc INCREMENT -1;`,
    `ALTER SEQUENCE public.desc AS integer;`,
    `ALTER SEQUENCE public.desc AS bigint;`,
    `ALTER SEQUENCE public.desc MINVALUE -100 MAXVALUE 100;`,
    `ALTER SEQUENCE public.desc NO MINVALUE NO MAXVALUE;`,
    // Clauses in a scrambled source order still apply in the engine's fixed order.
    `CREATE SEQUENCE public.scrambled;`,
    `ALTER SEQUENCE public.scrambled CACHE 5 INCREMENT 2 NO MAXVALUE NO MINVALUE START 3 CYCLE;`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const byName = new Map(model.sequences.map((entry) => [entry.name, entry]));

  // AS bigint after AS integer converts the integer bounds back to bigint's.
  assert.deepEqual(byName.get('desc'), {
    schema: 'public',
    name: 'desc',
    dataType: 'bigint',
    increment: '-1',
    minValue: '-9223372036854775808',
    maxValue: '-1',
    start: '-1',
    cache: '1',
    cycle: false,
  });
  // Increment is applied before the NO MAXVALUE/NO MINVALUE resets.
  assert.deepEqual(byName.get('scrambled'), {
    schema: 'public',
    name: 'scrambled',
    dataType: 'bigint',
    increment: '2',
    minValue: '1',
    maxValue: '9223372036854775807',
    start: '3',
    cache: '5',
    cycle: true,
  });
  assert.deepEqual(diagnostics, []);
});

test('AS type converts old-type-default bounds and lets NO MINVALUE/NO MAXVALUE force them', async () => {
  const dump = [
    // Old max is the bigint maximum, so `AS integer` converts it; the explicit NO MAXVALUE
    // then takes the new type's maximum rather than the descending default of -1.
    `CREATE SEQUENCE public.resetmax INCREMENT -1 MAXVALUE 9223372036854775807 START -1;`,
    `ALTER SEQUENCE public.resetmax AS integer NO MAXVALUE;`,
    // Old min is the bigint minimum; NO MINVALUE takes the new type's minimum, not 1.
    `CREATE SEQUENCE public.resetmin MINVALUE -9223372036854775808 START 1;`,
    `ALTER SEQUENCE public.resetmin AS integer NO MINVALUE;`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const byName = new Map(model.sequences.map((entry) => [entry.name, entry]));

  assert.equal(byName.get('resetmax')?.dataType, 'integer');
  assert.equal(byName.get('resetmax')?.maxValue, '2147483647');
  assert.equal(byName.get('resetmax')?.minValue, '-2147483648');
  assert.equal(byName.get('resetmin')?.dataType, 'integer');
  assert.equal(byName.get('resetmin')?.minValue, '-2147483648');
  assert.equal(byName.get('resetmin')?.maxValue, '2147483647');
  assert.deepEqual(diagnostics, []);
});

test('flags unlogged and temporary sequence persistence', async () => {
  const dump = [`CREATE UNLOGGED SEQUENCE public.u;`, `CREATE TEMPORARY SEQUENCE t;`].join('\n');

  const { model, diagnostics } = await importDump(dump);

  // The sequence still imports; only its persistence is dropped, exactly like a table's.
  assert.deepEqual(model.sequences, [sequence('t'), sequence('u')]);
  assert.deepEqual(diagnostics.map(summarize), [
    { kind: 'flag', code: 'unsupported-attribute', object: 'public.u' },
    { kind: 'flag', code: 'unsupported-attribute', object: 'public.t' },
  ]);
  const messages = diagnostics.map((diagnostic) => diagnostic.message).join('\n');
  assert.match(messages, /dropped unlogged-sequence persistence from public\.u/);
  assert.match(messages, /dropped temporary-sequence persistence from public\.t/);
});

test('names an ALTER SEQUENCE persistence change readably when skipping it', async () => {
  const dump = [
    `CREATE SEQUENCE public.s;`,
    `ALTER SEQUENCE public.s SET LOGGED;`,
    `ALTER SEQUENCE public.s SET UNLOGGED;`,
  ].join('\n');

  const { diagnostics } = await importDump(dump);

  assert.deepEqual(diagnostics.map(summarize), [
    { kind: 'skip', code: 'unsupported-statement', object: 'public.s' },
    { kind: 'skip', code: 'unsupported-statement', object: 'public.s' },
  ]);
  const messages = diagnostics.map((diagnostic) => diagnostic.message).join('\n');
  assert.equal(messages.match(/ALTER SEQUENCE public\.s/g)?.length, 2);
  assert.doesNotMatch(messages, /OBJECT_SEQUENCE/);
});

test('replaces a repeated CREATE SEQUENCE wholesale', async () => {
  const dump = [`CREATE SEQUENCE public.s AS smallint CYCLE;`, `CREATE SEQUENCE public.s;`].join(
    '\n',
  );

  const { model, diagnostics } = await importDump(dump);

  assert.deepEqual(model.sequences, [sequence('s')]);
  assert.deepEqual(diagnostics, []);
});

test('skips sequence state, missing sequences, and unmapped options by name', async () => {
  const dump = [
    `CREATE SEQUENCE public.s;`,
    `ALTER SEQUENCE public.missing INCREMENT 2;`,
    `ALTER SEQUENCE public.s RESTART WITH 5;`,
    `ALTER SEQUENCE public.s INCREMENT 2 RESTART;`,
    `ALTER SEQUENCE public.s RENAME TO s2;`,
    `ALTER SEQUENCE public.s SET SCHEMA app;`,
    `DROP SEQUENCE public.s;`,
    `SELECT pg_catalog.setval('public.s', 1, false);`,
    `CREATE SEQUENCE public.bad AS numeric;`,
    `CREATE SEQUENCE public.fractional CACHE 1.5;`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);

  // The RESTART options are state and stay skipped; the increment still applies.
  assert.deepEqual(model.sequences, [sequence('s', { increment: '2' })]);
  assert.deepEqual(diagnostics.map(summarize), [
    { kind: 'skip', code: 'unsupported-statement', object: 'public.missing' },
    { kind: 'skip', code: 'unsupported-statement', object: 'public.s' },
    { kind: 'skip', code: 'unsupported-statement', object: 'public.s' },
    { kind: 'skip', code: 'unsupported-statement', object: 'public.s' },
    { kind: 'skip', code: 'unsupported-statement', object: 'public.s' },
    { kind: 'skip', code: 'unsupported-statement', object: 'public.s' },
    { kind: 'skip', code: 'unsupported-statement', object: 'SELECT' },
    { kind: 'skip', code: 'unsupported-statement', object: 'public.bad' },
    { kind: 'skip', code: 'unsupported-statement', object: 'public.fractional' },
  ]);

  const messages = diagnostics.map((diagnostic) => diagnostic.message).join('\n');
  assert.match(messages, /ALTER SEQUENCE public\.missing \(sequence not imported\)/);
  assert.match(messages, /ALTER SEQUENCE public\.s \(RESTART\)/);
  assert.match(messages, /ALTER SEQUENCE public\.s RENAME/);
  assert.match(messages, /ALTER SEQUENCE public\.s SET SCHEMA/);
  assert.match(messages, /DROP SEQUENCE public\.s/);
  assert.match(messages, /CREATE SEQUENCE public\.bad \(unsupported data type\)/);
  assert.match(messages, /CREATE SEQUENCE public\.fractional \(non-integer cache\)/);
});

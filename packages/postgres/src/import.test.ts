import assert from 'node:assert/strict';
import { test } from 'node:test';

import { diff } from '@schemamill/core';
import type { Diagnostic, Model, Sequence } from '@schemamill/core';

import { extractCollationText, storeComment } from './import.ts';
import { ddlImporter, importDump } from './index.ts';
import type { ParsedStatement } from './parse.ts';

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
      uniqueConstraints: [],
      checkConstraints: [],
      indexes: [],
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
          columns: ['parent_id'],
          referencedTable: { schema: 'app', name: 'orders' },
          referencedColumns: ['id'],
          deferrable: true,
          initiallyDeferred: true,
          enforcement: 'not-valid',
        },
        {
          columns: ['user_id'],
          referencedTable: { schema: 'public', name: 'users' },
          referencedColumns: ['id'],
          onDelete: 'CASCADE',
        },
      ],
      primaryKey: { columns: ['id'] },
      uniqueConstraints: [],
      checkConstraints: [],
      indexes: [],
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
        {
          name: 'display_name',
          type: 'text',
          notNull: false,
          default: "'anon'",
          collation: '"C"',
        },
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
        {
          name: 'counter',
          type: 'bigint',
          notNull: true,
          identity: {
            generated: 'always',
            increment: '1',
            minValue: '1',
            maxValue: '9223372036854775807',
            start: '1',
            cache: '1',
            cycle: false,
          },
        },
      ],
      foreignKeys: [],
      primaryKey: { columns: ['id'] },
      uniqueConstraints: [{ columns: ['email'] }],
      checkConstraints: [{ expression: '(age >= 0)' }],
      indexes: [{ name: 'idx_users_email', unique: false, columns: ['email'] }],
      comment: 'people',
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
  views: [],
};

const EXPECTED_DIAGNOSTICS = [
  { kind: 'skip', code: 'psql-meta-command', object: String.raw`\restrict` },
  { kind: 'skip', code: 'unsupported-statement', object: 'statement_timeout' },
  { kind: 'skip', code: 'unsupported-statement', object: 'client_encoding' },
  { kind: 'skip', code: 'unsupported-statement', object: 'app' },
  { kind: 'skip', code: 'unsupported-statement', object: 'public.users' },
  { kind: 'skip', code: 'unsupported-statement', object: 'GRANT' },
  { kind: 'skip', code: 'unsupported-statement', object: 'SELECT' },
  { kind: 'error', code: 'parse-failure' },
  { kind: 'skip', code: 'copy-data', object: 'COPY public.users' },
  { kind: 'skip', code: 'psql-meta-command', object: String.raw`\unrestrict` },
] as const;

/**
 * The long-tail families in the order a dump emits them, captured from the #59 fact report:
 * every unmodeled statement is skipped with a family-named description, the plain view and
 * materialized view import, and the two `CREATE TABLE` attribute leftovers import partially
 * and are flagged. The two plain `CREATE TABLE`s (`app.t`, `app.rls`) are present for the
 * statements that reference them and produce nothing.
 */
const LONG_TAIL_DUMP = [
  `CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;`,
  '',
  `CREATE VIEW app.v AS SELECT 1;`,
  '',
  `CREATE MATERIALIZED VIEW app.mv AS SELECT 1 WITH NO DATA;`,
  '',
  `CREATE TABLE app.ctas AS SELECT 1;`,
  '',
  `REFRESH MATERIALIZED VIEW app.mv;`,
  '',
  `CREATE TABLE app.t (id integer);`,
  '',
  `CREATE TRIGGER trg AFTER INSERT ON app.t FOR EACH ROW EXECUTE FUNCTION app.f();`,
  '',
  `CREATE FUNCTION app.f(a integer) RETURNS integer LANGUAGE sql AS $$SELECT a + 1$$;`,
  '',
  `CREATE PROCEDURE app.p() LANGUAGE sql AS $$ SELECT 1 $$;`,
  '',
  `CREATE RULE r AS ON INSERT TO app.t DO NOTHING;`,
  '',
  `CREATE POLICY pol ON app.t FOR SELECT USING ((id > 0));`,
  '',
  `ALTER POLICY pol ON app.t USING (false);`,
  '',
  `CREATE TABLE app.rls (id integer);`,
  '',
  `ALTER TABLE app.rls ENABLE ROW LEVEL SECURITY;`,
  '',
  `ALTER TABLE app.rls DISABLE ROW LEVEL SECURITY;`,
  '',
  `ALTER TABLE app.rls FORCE ROW LEVEL SECURITY;`,
  '',
  `ALTER TABLE app.rls NO FORCE ROW LEVEL SECURITY;`,
  '',
  `CREATE FOREIGN TABLE app.ft (id integer) SERVER s;`,
  '',
  `COMMENT ON MATERIALIZED VIEW app.mv IS 'x';`,
  '',
  `COMMENT ON FOREIGN TABLE app.ft IS 'x';`,
  '',
  `GRANT SELECT ON TABLE app.t TO app;`,
  '',
  `REVOKE SELECT ON TABLE app.t FROM app;`,
  '',
  `REVOKE ALL ON TABLE app.t FROM app;`,
  '',
  `CREATE TABLE app.like (LIKE app.t INCLUDING ALL);`,
  '',
  `CREATE TABLE app.child (b integer) INHERITS (app.parent);`,
].join('\n');

/** The complete diagnostic contract for `LONG_TAIL_DUMP`, in dump order. */
const LONG_TAIL_DIAGNOSTICS = [
  {
    kind: 'skip',
    code: 'unsupported-statement',
    object: 'pgcrypto',
    message: 'skipped CREATE EXTENSION pgcrypto',
  },
  {
    kind: 'skip',
    code: 'unsupported-statement',
    object: 'app.ctas',
    message: 'skipped CREATE TABLE AS app.ctas',
  },
  {
    kind: 'skip',
    code: 'unsupported-statement',
    object: 'app.mv',
    message: 'skipped REFRESH MATERIALIZED VIEW app.mv',
  },
  {
    kind: 'skip',
    code: 'unsupported-statement',
    object: 'trg',
    message: 'skipped CREATE TRIGGER trg',
  },
  {
    kind: 'skip',
    code: 'unsupported-statement',
    object: 'app.f',
    message: 'skipped CREATE FUNCTION app.f',
  },
  {
    kind: 'skip',
    code: 'unsupported-statement',
    object: 'app.p',
    message: 'skipped CREATE PROCEDURE app.p',
  },
  {
    kind: 'skip',
    code: 'unsupported-statement',
    object: 'r',
    message: 'skipped CREATE RULE r ON app.t',
  },
  {
    kind: 'skip',
    code: 'unsupported-statement',
    object: 'pol',
    message: 'skipped CREATE POLICY pol ON app.t',
  },
  {
    kind: 'skip',
    code: 'unsupported-statement',
    object: 'pol',
    message: 'skipped ALTER POLICY pol ON app.t',
  },
  {
    kind: 'skip',
    code: 'unsupported-statement',
    object: 'app.rls',
    message: 'skipped ALTER TABLE app.rls ENABLE ROW LEVEL SECURITY',
  },
  {
    kind: 'skip',
    code: 'unsupported-statement',
    object: 'app.rls',
    message: 'skipped ALTER TABLE app.rls DISABLE ROW LEVEL SECURITY',
  },
  {
    kind: 'skip',
    code: 'unsupported-statement',
    object: 'app.rls',
    message: 'skipped ALTER TABLE app.rls FORCE ROW LEVEL SECURITY',
  },
  {
    kind: 'skip',
    code: 'unsupported-statement',
    object: 'app.rls',
    message: 'skipped ALTER TABLE app.rls NO FORCE ROW LEVEL SECURITY',
  },
  {
    kind: 'skip',
    code: 'unsupported-statement',
    object: 'app.ft',
    message: 'skipped CREATE FOREIGN TABLE app.ft',
  },
  {
    kind: 'skip',
    code: 'unsupported-statement',
    object: 'app.ft',
    message: 'skipped COMMENT ON FOREIGN TABLE app.ft',
  },
  {
    kind: 'skip',
    code: 'unsupported-statement',
    object: 'GRANT',
    message: 'skipped GRANT statement',
  },
  {
    kind: 'skip',
    code: 'unsupported-statement',
    object: 'REVOKE',
    message: 'skipped REVOKE statement',
  },
  {
    kind: 'skip',
    code: 'unsupported-statement',
    object: 'REVOKE',
    message: 'skipped REVOKE statement',
  },
  {
    kind: 'flag',
    code: 'unsupported-attribute',
    object: 'app.like',
    message: 'dropped LIKE clause from app.like',
  },
  {
    kind: 'flag',
    code: 'unsupported-attribute',
    object: 'app.child',
    message: 'dropped inheritance from app.child',
  },
] as const;

/** A diagnostic's pinned fields: kind, code, object, and message, with `position` stripped. */
const describeDiagnostic = (diagnostic: Diagnostic) => ({
  ...summarize(diagnostic),
  message: diagnostic.message,
});

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

  // Actions are stored only when the source states a non-default one; the modeled attributes
  // (`DEFERRABLE INITIALLY DEFERRED NOT VALID`) are read rather than flagged.
  const [parentForeignKey, userForeignKey] = orders.foreignKeys;
  assert.ok(parentForeignKey && userForeignKey, 'both foreign keys are imported');
  assert.equal('onDelete' in parentForeignKey, false);
  assert.equal('onUpdate' in parentForeignKey, false);
  assert.equal(parentForeignKey.deferrable, true);
  assert.equal(parentForeignKey.initiallyDeferred, true);
  assert.equal(parentForeignKey.enforcement, 'not-valid');
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
  assert.equal(
    byMessage('COMMENT ON TABLE public.users'),
    undefined,
    'COMMENT attaches instead of being skipped',
  );
  const failure = diagnostics.find((diagnostic) => diagnostic.code === 'parse-failure');
  assert.match(failure?.message ?? '', /syntax error at or near "UNSIGNED"/);
  // Failures point at the parser's error cursor when it has one.
  assert.deepEqual(failure?.position, {
    offset: DUMP.indexOf('UNSIGNED'),
    line: 68,
    column: 39,
  });
});

test('names every long-tail family in dump order', async () => {
  const { model, diagnostics } = await importDump(LONG_TAIL_DUMP);

  assert.deepEqual(diagnostics.map(describeDiagnostic), LONG_TAIL_DIAGNOSTICS);

  // The materialized view's comment lands on the modeled view; the foreign table's stays skipped.
  const materializedView = model.views.find((view) => view.name === 'mv');
  assert.equal(materializedView?.comment, 'x');
});

test('imports LIKE and INHERITS tables partially, flagging the dropped clauses', async () => {
  const { model, diagnostics } = await importDump(LONG_TAIL_DUMP);

  assert.deepEqual(
    diagnostics.filter((diagnostic) => diagnostic.kind === 'flag').map(describeDiagnostic),
    [
      {
        kind: 'flag',
        code: 'unsupported-attribute',
        object: 'app.like',
        message: 'dropped LIKE clause from app.like',
      },
      {
        kind: 'flag',
        code: 'unsupported-attribute',
        object: 'app.child',
        message: 'dropped inheritance from app.child',
      },
    ],
  );

  const like = model.tables.find((table) => table.schema === 'app' && table.name === 'like');
  assert.ok(like, 'the LIKE table imports');
  assert.deepEqual(like.columns, []);

  const child = model.tables.find((table) => table.schema === 'app' && table.name === 'child');
  assert.ok(child, 'the INHERITS table imports');
  assert.deepEqual(
    child.columns.map((column) => column.name),
    ['b'],
  );
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
      columns: ['a'],
      referencedTable: { schema: 'public', name: 'parent' },
      referencedColumns: ['id'],
      onUpdate: 'RESTRICT',
      onDelete: 'SET DEFAULT',
      deferrable: true,
    },
    {
      columns: ['b'],
      referencedTable: { schema: 'public', name: 'parent' },
      referencedColumns: ['id'],
    },
  ]);

  // Deferrability is read into the model now; the attributes outside it stay flagged.
  // Diagnostics are emitted during statement translation, before canonicalization, so they
  // keep the source name even though the modeled constraint comes back unnamed.
  assert.deepEqual(
    diagnostics
      .filter((diagnostic) => diagnostic.kind === 'flag')
      .map((diagnostic) => diagnostic.message),
    ['dropped MATCH FULL on foreign key child_a_fkey from public.child'],
  );
});

test('canonicalizes column-level and table-level unique and check constraints', async () => {
  const dump = [
    `CREATE TABLE public.t (`,
    `    a integer UNIQUE,`,
    `    b integer CHECK (b > 0),`,
    `    c integer,`,
    `    d integer,`,
    `    CONSTRAINT t_named UNIQUE (c),`,
    `    CONSTRAINT t_d_key UNIQUE (d),`,
    `    CONSTRAINT t_c_check CHECK (c > 0),`,
    `    CHECK (a < c)`,
    `);`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const table = model.tables.find((candidate) => candidate.name === 't');
  assert.ok(table, 'the table is imported');

  // Column-level and table-level forms canonicalize alike: a unique constraint is its ordered
  // columns, a check constraint its expression, and both arrays sort deterministically. A name
  // that exactly matches PostgreSQL's conventional formula strips (`t_d_key`, `t_c_check`);
  // `t_named` does not match any formula and stays.
  assert.deepEqual(table.uniqueConstraints, [
    { columns: ['a'] },
    { name: 't_named', columns: ['c'] },
    { columns: ['d'] },
  ]);
  assert.deepEqual(table.checkConstraints, [
    { expression: 'a < c' },
    { expression: 'b > 0' },
    { expression: 'c > 0' },
  ]);
  // A constraint-backed index is never a standalone Index.
  assert.deepEqual(table.indexes, []);
  assert.deepEqual(diagnostics, []);
});

test('normalizes a check expression between its parentheses, comments dropped', async () => {
  const dump = [
    `CREATE TABLE public.t (a integer, b integer, CONSTRAINT t_range CHECK ((a > 0) AND (a < b)));`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_other CHECK (b /* note */ > 10);`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const table = model.tables.find((candidate) => candidate.name === 't');
  assert.ok(table, 'the table is imported');

  // The outer CHECK parentheses are not part of the stored expression, so rendering
  // `CHECK (<expression>)` round-trips; comments and extra whitespace are dropped, and the
  // normalizer tightens the space before an opening parenthesis, as it does for types.
  assert.deepEqual(table.checkConstraints, [
    { name: 't_range', expression: '(a > 0) AND(a < b)' },
    { name: 't_other', expression: 'b > 10' },
  ]);
  assert.deepEqual(diagnostics, []);
});

test('imports ALTER TABLE ADD CONSTRAINT unique and check, reading attributes and flagging the rest', async () => {
  const dump = [
    `CREATE TABLE public.t (a integer, b integer, c integer);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_a_key UNIQUE (a);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_check CHECK ((a > 0)) NOT VALID NO INHERIT;`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_nd_key UNIQUE NULLS NOT DISTINCT (b) INCLUDE (c);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_def_key UNIQUE (c) DEFERRABLE INITIALLY DEFERRED;`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const table = model.tables.find((candidate) => candidate.name === 't');
  assert.ok(table, 'the table is imported');

  // `t_a_key` matches PostgreSQL's formula for `UNIQUE (a)` and canonicalizes back to unnamed;
  // the other unique names do not match their formulas and stay. `t_check` names a
  // single-column expression with the generic shape, not the formula (`t_a_check`), so it
  // stays named too.
  assert.deepEqual(table.uniqueConstraints, [
    { columns: ['a'] },
    { name: 't_nd_key', columns: ['b'] },
    { name: 't_def_key', columns: ['c'], deferrable: true, initiallyDeferred: true },
  ]);
  assert.deepEqual(table.checkConstraints, [
    { name: 't_check', expression: '(a > 0)', enforcement: 'not-valid' },
  ]);

  // `NOT VALID` and deferrability are read into the model; the remaining unrepresentable
  // attributes are flagged and dropped, and the constraint itself imports.
  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.message),
    [
      'dropped NO INHERIT on check constraint t_check from public.t',
      'dropped NULLS NOT DISTINCT on unique constraint t_nd_key from public.t',
      'dropped INCLUDE on unique constraint t_nd_key from public.t',
    ],
  );
});

test('decodes NOT VALID and NOT ENFORCED distinctly on foreign keys and check constraints', async () => {
  const dump = [
    `CREATE TABLE public.parent (id integer PRIMARY KEY);`,
    `CREATE TABLE public.t (a integer);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT fk_valid FOREIGN KEY (a) REFERENCES public.parent(id);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT fk_not_valid FOREIGN KEY (a) REFERENCES public.parent(id) NOT VALID;`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT fk_not_enforced FOREIGN KEY (a) REFERENCES public.parent(id) NOT ENFORCED;`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT fk_both FOREIGN KEY (a) REFERENCES public.parent(id) NOT VALID NOT ENFORCED;`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT ck_valid CHECK (a > 0);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT ck_not_valid CHECK (a > 0) NOT VALID;`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT ck_not_enforced CHECK (a > 0) NOT ENFORCED;`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT ck_both CHECK (a > 0) NOT VALID NOT ENFORCED;`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const table = model.tables.find((candidate) => candidate.name === 't');
  assert.ok(table, 'the table is imported');

  const foreignKey = (name: string) =>
    table.foreignKeys.find((candidate) => candidate.name === name);
  const check = (name: string) =>
    table.checkConstraints.find((candidate) => candidate.name === name);

  // The normal shape carries no enforcement field at all.
  assert.equal('enforcement' in (foreignKey('fk_valid') ?? {}), false);
  assert.equal('enforcement' in (check('ck_valid') ?? {}), false);
  // `NOT VALID` carries `is_enforced: true` beside `skip_validation`; `NOT ENFORCED` omits it.
  assert.equal(foreignKey('fk_not_valid')?.enforcement, 'not-valid');
  assert.equal(foreignKey('fk_not_enforced')?.enforcement, 'not-enforced');
  assert.equal(check('ck_not_valid')?.enforcement, 'not-valid');
  assert.equal(check('ck_not_enforced')?.enforcement, 'not-enforced');
  // The combined wording collapses to the stronger state, never to the `NOT VALID` wording.
  assert.equal(foreignKey('fk_both')?.enforcement, 'not-enforced');
  assert.equal(check('ck_both')?.enforcement, 'not-enforced');

  // Every state is read, so nothing is flagged.
  assert.deepEqual(diagnostics, []);
});

test('folds inline constraint attributes into the preceding constraint', async () => {
  const dump = [
    `CREATE TABLE public.parent (id integer PRIMARY KEY);`,
    `CREATE TABLE public.t (`,
    `    a integer CONSTRAINT t_a_ck CHECK (a > 0) NOT ENFORCED,`,
    `    b integer REFERENCES public.parent(id) NOT ENFORCED,`,
    `    c integer UNIQUE DEFERRABLE INITIALLY DEFERRED,`,
    `    d integer PRIMARY KEY INITIALLY DEFERRED,`,
    `    e integer UNIQUE NOT DEFERRABLE,`,
    `    f integer CONSTRAINT t_f_ck CHECK (f > 0) ENFORCED,`,
    `    g integer REFERENCES public.parent(id) NOT DEFERRABLE`,
    `);`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const table = model.tables.find((candidate) => candidate.name === 't');
  assert.ok(table, 'the table is imported');

  // `NOT ENFORCED` folds into an inline CHECK and FK; `INITIALLY DEFERRED` implies deferrable
  // and the pair applies sequentially to one constraint; `ENFORCED` and `NOT DEFERRABLE` are
  // the explicit defaults and are consumed without a flag.
  assert.deepEqual(table.checkConstraints, [
    { name: 't_a_ck', expression: 'a > 0', enforcement: 'not-enforced' },
    { name: 't_f_ck', expression: 'f > 0' },
  ]);
  assert.deepEqual(table.foreignKeys, [
    {
      columns: ['b'],
      referencedTable: { schema: 'public', name: 'parent' },
      referencedColumns: ['id'],
      enforcement: 'not-enforced',
    },
    {
      columns: ['g'],
      referencedTable: { schema: 'public', name: 'parent' },
      referencedColumns: ['id'],
    },
  ]);
  assert.deepEqual(table.uniqueConstraints, [
    { columns: ['c'], deferrable: true, initiallyDeferred: true },
    { columns: ['e'] },
  ]);
  assert.deepEqual(table.primaryKey, { columns: ['d'], deferrable: true, initiallyDeferred: true });
  assert.deepEqual(diagnostics, []);
});

test('keeps flagging inline attributes on incompatible constraints', async () => {
  const dump = [
    `CREATE TABLE public.t (`,
    `    a integer CONSTRAINT t_a_nn NOT NULL DEFERRABLE,`,
    `    b integer CONSTRAINT t_b_nn NOT NULL NOT ENFORCED,`,
    `    c integer CONSTRAINT t_c_ck CHECK (c > 0) DEFERRABLE,`,
    `    d integer UNIQUE ENFORCED,`,
    `    e integer UNIQUE NOT ENFORCED,`,
    `    f integer DEFERRABLE,`,
    `    g integer NOT ENFORCED`,
    `);`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const table = model.tables.find((candidate) => candidate.name === 't');
  assert.ok(table, 'the table is imported');

  // The server rejects every one of these placements — including a bare attribute with no
  // preceding constraint; the raw parser accepts them, so the raw enum label is the
  // diagnostic. Each constraint still imports with its representable facts.
  assert.equal(table.columns[0]?.notNull, true);
  assert.equal(table.columns[0]?.notNullName, 't_a_nn');
  assert.equal(table.columns[1]?.notNull, true);
  assert.equal(table.columns[1]?.notNullName, 't_b_nn');
  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.message),
    [
      'dropped CONSTR_ATTR_DEFERRABLE on public.t.a from public.t',
      'dropped CONSTR_ATTR_NOT_ENFORCED on public.t.b from public.t',
      'dropped CONSTR_ATTR_DEFERRABLE on public.t.c from public.t',
      'dropped CONSTR_ATTR_ENFORCED on public.t.d from public.t',
      'dropped CONSTR_ATTR_NOT_ENFORCED on public.t.e from public.t',
      'dropped CONSTR_ATTR_DEFERRABLE on public.t.f from public.t',
      'dropped CONSTR_ATTR_NOT_ENFORCED on public.t.g from public.t',
    ],
  );
});

test('reads table-level deferrability on primary keys, unique constraints, and foreign keys', async () => {
  const dump = [
    `CREATE TABLE public.parent (id integer PRIMARY KEY);`,
    `CREATE TABLE public.t (a integer, b integer);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_pk PRIMARY KEY (a) DEFERRABLE;`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_b_key UNIQUE (b) INITIALLY DEFERRED;`,
    `CREATE TABLE public.u (c integer, d integer);`,
    `ALTER TABLE ONLY public.u ADD CONSTRAINT u_c_fkey FOREIGN KEY (c) REFERENCES public.parent(id) DEFERRABLE INITIALLY DEFERRED;`,
    `ALTER TABLE ONLY public.u ADD CONSTRAINT u_d_fkey FOREIGN KEY (d) REFERENCES public.parent(id) DEFERRABLE;`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const table = model.tables.find((candidate) => candidate.name === 't');
  const other = model.tables.find((candidate) => candidate.name === 'u');
  assert.ok(table && other, 'both tables are imported');

  // A primary key's deferrability is read now, not silently dropped.
  assert.deepEqual(table.primaryKey, { name: 't_pk', columns: ['a'], deferrable: true });
  // `INITIALLY DEFERRED` alone implies `DEFERRABLE`, and the generated `t_b_key` still strips.
  assert.deepEqual(table.uniqueConstraints, [
    { columns: ['b'], deferrable: true, initiallyDeferred: true },
  ]);
  // Both foreign keys carry their attributes and canonicalize their generated names.
  assert.deepEqual(other.foreignKeys, [
    {
      columns: ['c'],
      referencedTable: { schema: 'public', name: 'parent' },
      referencedColumns: ['id'],
      deferrable: true,
      initiallyDeferred: true,
    },
    {
      columns: ['d'],
      referencedTable: { schema: 'public', name: 'parent' },
      referencedColumns: ['id'],
      deferrable: true,
    },
  ]);
  assert.deepEqual(diagnostics, []);
});

test('reads not-null constraints in every shape and strips only the generated name', async () => {
  const dump = [
    `CREATE TABLE public.t (a integer, b integer, c integer, d integer, e integer);`,
    `ALTER TABLE public.t ADD CONSTRAINT t_a_not_null NOT NULL a;`,
    `ALTER TABLE public.t ADD CONSTRAINT custom_b_nn NOT NULL b;`,
    `ALTER TABLE public.t ADD NOT NULL c;`,
    `CREATE TABLE public.u (f integer CONSTRAINT u_f_not_null NOT NULL, g integer CONSTRAINT custom_g_nn NOT NULL);`,
    `CREATE TABLE public.v (h integer, CONSTRAINT v_h_not_null NOT NULL h);`,
    `CREATE TABLE public.w (i integer NOT NULL);`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const columnsOf = (name: string) => {
    const table = model.tables.find((candidate) => candidate.name === name);
    assert.ok(table, `table ${name} is imported`);
    return Object.fromEntries(table.columns.map((column) => [column.name, column]));
  };

  // The generated `<table>_<column>_not_null` strips to unnamed in every shape: `ALTER ADD`
  // (`t_a_not_null`), an inline name (`u_f_not_null`), and a table-level name
  // (`v_h_not_null`). The bare `ADD NOT NULL c` and the unnamed inline declaration stay
  // unnamed.
  assert.deepEqual(columnsOf('t').a, { name: 'a', type: 'integer', notNull: true });
  assert.deepEqual(columnsOf('t').c, { name: 'c', type: 'integer', notNull: true });
  assert.deepEqual(columnsOf('u').f, { name: 'f', type: 'integer', notNull: true });
  assert.deepEqual(columnsOf('v').h, { name: 'h', type: 'integer', notNull: true });
  assert.deepEqual(columnsOf('w').i, { name: 'i', type: 'integer', notNull: true });
  // A name outside the formula stays named.
  assert.deepEqual(columnsOf('t').b, {
    name: 'b',
    type: 'integer',
    notNull: true,
    notNullName: 'custom_b_nn',
  });
  assert.deepEqual(columnsOf('u').g, {
    name: 'g',
    type: 'integer',
    notNull: true,
    notNullName: 'custom_g_nn',
  });
  assert.deepEqual(diagnostics, []);
});

test('canonicalizes a truncated generated not-null name and keeps a collision-suffixed one', async () => {
  // The `_not_null` label leaves a 53-byte budget beside the 1-byte table, so the 60-byte
  // column gives up 8 bytes; the collision suffix gives up 9 instead. PG 18's live name is the
  // same formula, and the strip is unit-only here.
  const longColumn = 'w'.repeat(60);
  const generated = `t_${'w'.repeat(52)}_not_null`;
  const suffixed = `t_${'w'.repeat(51)}_not_null1`;
  const cases = [
    [generated, { name: longColumn, type: 'integer', notNull: true }],
    [suffixed, { name: longColumn, type: 'integer', notNull: true, notNullName: suffixed }],
  ] as const;

  for (const [name, expected] of cases) {
    const dump = [
      `CREATE TABLE public.t (${longColumn} integer);`,
      `ALTER TABLE ONLY public.t ADD CONSTRAINT ${name} NOT NULL ${longColumn};`,
    ].join('\n');
    const { model, diagnostics } = await importDump(dump);
    // Only the exact server form strips; the collision-suffixed name stays named.
    assert.deepEqual(model.tables[0]?.columns, [expected]);
    assert.deepEqual(diagnostics, []);
  }
});

test('merges duplicate not-null declarations in either order, flagging only real conflicts', async () => {
  // Unnamed ∪ named → named, whatever the order.
  const unnamedFirst = [
    `CREATE TABLE public.t (a integer NOT NULL);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT custom_nn NOT NULL a;`,
  ];
  const namedFirst = [
    `CREATE TABLE public.t (a integer);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT custom_nn NOT NULL a;`,
    `ALTER TABLE ONLY public.t ADD NOT NULL a;`,
  ];
  for (const statements of [unnamedFirst, namedFirst]) {
    const { model, diagnostics } = await importDump(statements.join('\n'));
    assert.deepEqual(model.tables[0]?.columns[0], {
      name: 'a',
      type: 'integer',
      notNull: true,
      notNullName: 'custom_nn',
    });
    assert.deepEqual(diagnostics, []);
  }

  // A generated-formula name reads as unnamed for the comparison, so the duplicate is
  // ignored and the strip leaves no name.
  const formulaDuplicate = await importDump(
    [
      `CREATE TABLE public.t (a integer);`,
      `ALTER TABLE ONLY public.t ADD CONSTRAINT t_a_not_null NOT NULL a;`,
      `ALTER TABLE ONLY public.t ADD NOT NULL a;`,
    ].join('\n'),
  );
  assert.deepEqual(formulaDuplicate.model.tables[0]?.columns[0], {
    name: 'a',
    type: 'integer',
    notNull: true,
  });
  assert.deepEqual(formulaDuplicate.diagnostics, []);

  // A generated formula name and a custom name are not a conflict: the formula reads as
  // unnamed, so the custom name wins in either order.
  for (const statements of [
    [
      `CREATE TABLE public.t (a integer);`,
      `ALTER TABLE ONLY public.t ADD CONSTRAINT t_a_not_null NOT NULL a;`,
      `ALTER TABLE ONLY public.t ADD CONSTRAINT custom_nn NOT NULL a;`,
    ],
    [
      `CREATE TABLE public.t (a integer);`,
      `ALTER TABLE ONLY public.t ADD CONSTRAINT custom_nn NOT NULL a;`,
      `ALTER TABLE ONLY public.t ADD CONSTRAINT t_a_not_null NOT NULL a;`,
    ],
  ]) {
    const { model, diagnostics } = await importDump(statements.join('\n'));
    assert.deepEqual(model.tables[0]?.columns[0], {
      name: 'a',
      type: 'integer',
      notNull: true,
      notNullName: 'custom_nn',
    });
    assert.deepEqual(diagnostics, []);
  }

  // Two different real names keep the first declaration and are flagged, never silent.
  for (const [names, kept] of [
    [['first_nn', 'second_nn'], 'first_nn'],
    [['second_nn', 'first_nn'], 'second_nn'],
  ] as const) {
    const dump = [
      `CREATE TABLE public.t (a integer);`,
      ...names.map((name) => `ALTER TABLE ONLY public.t ADD CONSTRAINT ${name} NOT NULL a;`),
    ].join('\n');
    const { model, diagnostics } = await importDump(dump);
    assert.deepEqual(model.tables[0]?.columns[0], {
      name: 'a',
      type: 'integer',
      notNull: true,
      notNullName: kept,
    });
    assert.deepEqual(
      diagnostics.map((diagnostic) => diagnostic.message),
      ['dropped additional not-null constraint on public.t.a from public.t'],
    );
  }
});

test('merges a truncated generated not-null declaration with an unnamed one, whatever the order', async () => {
  const longColumn = 'w'.repeat(60);
  const generated = `t_${'w'.repeat(52)}_not_null`;
  const declarations = [
    `ALTER TABLE ONLY public.t ADD CONSTRAINT ${generated} NOT NULL ${longColumn};`,
    `ALTER TABLE ONLY public.t ADD NOT NULL ${longColumn};`,
  ];

  for (const order of [declarations, [...declarations].reverse()]) {
    const dump = [`CREATE TABLE public.t (${longColumn} integer);`, ...order].join('\n');
    const { model, diagnostics } = await importDump(dump);

    // The truncated generated name reads as unnamed for the one-fact comparison, so the
    // duplicate collapses and the strip leaves no name in either order.
    assert.deepEqual(model.tables[0]?.columns, [
      { name: longColumn, type: 'integer', notNull: true },
    ]);
    assert.deepEqual(diagnostics, []);
  }
});

test('flags not-null declarations whose column is absent', async () => {
  const dump = [
    `CREATE TABLE public.t (a integer);`,
    `CREATE TABLE public.u (b integer, CONSTRAINT u_missing_not_null NOT NULL missing);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_missing_not_null NOT NULL missing;`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);

  // The declaration is skipped, not applied, and the unknown column is named.
  assert.deepEqual(model.tables.find((table) => table.name === 't')?.columns, [
    { name: 'a', type: 'integer', notNull: false },
  ]);
  assert.deepEqual(model.tables.find((table) => table.name === 'u')?.columns, [
    { name: 'b', type: 'integer', notNull: false },
  ]);
  assert.deepEqual(diagnostics.map(summarize), [
    { kind: 'skip', code: 'unsupported-statement', object: 'public.u.missing' },
    { kind: 'skip', code: 'unsupported-statement', object: 'public.t.missing' },
  ]);
  const messages = diagnostics.map((diagnostic) => diagnostic.message).join('\n');
  assert.match(messages, /not-null constraint on unknown column public\.u\.missing/);
  assert.match(messages, /not-null constraint on unknown column public\.t\.missing/);
});

test('flags NOT VALID not-null declarations and keeps the enforced fact', async () => {
  const dump = [
    `CREATE TABLE public.t (a integer);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_a_not_null NOT NULL a NOT VALID;`,
    `CREATE TABLE public.u (b integer, CONSTRAINT u_b_not_null NOT NULL b NOT VALID);`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);

  // The model carries the enforced not-null fact; the validation state is the named boundary.
  assert.deepEqual(model.tables.find((table) => table.name === 't')?.columns, [
    { name: 'a', type: 'integer', notNull: true },
  ]);
  assert.deepEqual(model.tables.find((table) => table.name === 'u')?.columns, [
    { name: 'b', type: 'integer', notNull: true },
  ]);
  assert.deepEqual(diagnostics.map(summarize), [
    { kind: 'flag', code: 'unsupported-attribute', object: 'public.t' },
    { kind: 'flag', code: 'unsupported-attribute', object: 'public.u' },
  ]);
  const messages = diagnostics.map((diagnostic) => diagnostic.message).join('\n');
  assert.match(messages, /dropped NOT VALID on not-null constraint t_a_not_null from public\.t/);
  assert.match(messages, /dropped NOT VALID on not-null constraint u_b_not_null from public\.u/);
});

test('keeps a not-null name through DROP IDENTITY', async () => {
  const dump = [
    `CREATE TABLE public.t (a integer CONSTRAINT custom_nn NOT NULL GENERATED ALWAYS AS IDENTITY);`,
    `ALTER TABLE public.t ALTER COLUMN a DROP IDENTITY;`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const table = model.tables.find((candidate) => candidate.name === 't');
  assert.ok(table, 'the table is imported');

  // Dropping the identity descriptor is an explicit copy of the column; the not-null fact and
  // its name survive, only the identity goes.
  assert.deepEqual(table.columns, [
    { name: 'a', type: 'integer', notNull: true, notNullName: 'custom_nn' },
  ]);
  assert.deepEqual(diagnostics, []);
});

test('attribute-carrying declarations round-trip against the unnamed model with an empty diff', async () => {
  const declared = [
    `CREATE TABLE public.parent (id integer PRIMARY KEY);`,
    `CREATE TABLE public.t (a integer, b integer, c integer NOT NULL);`,
    `ALTER TABLE ONLY public.t ADD PRIMARY KEY (a);`,
    `ALTER TABLE ONLY public.t ADD UNIQUE (b) DEFERRABLE INITIALLY DEFERRED;`,
    `ALTER TABLE ONLY public.t ADD CHECK (c > 0) NOT ENFORCED;`,
    `ALTER TABLE ONLY public.t ADD FOREIGN KEY (c) REFERENCES public.parent(id) NOT ENFORCED;`,
  ].join('\n');
  const dump = [
    `CREATE TABLE public.parent (id integer PRIMARY KEY);`,
    `CREATE TABLE public.t (a integer, b integer, c integer CONSTRAINT t_c_not_null NOT NULL);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_pkey PRIMARY KEY (a);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_b_key UNIQUE (b) DEFERRABLE INITIALLY DEFERRED;`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_c_check CHECK (c > 0) NOT ENFORCED;`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_c_fkey FOREIGN KEY (c) REFERENCES public.parent(id) NOT ENFORCED;`,
  ].join('\n');

  const { model: declaredModel, diagnostics } = await importDump(declared);
  const { model: dumpModel } = await importDump(dump);

  // The dump's generated names and attributes read back as the model's unnamed declarations:
  // enforcement, deferrability, and the named not-null fact all survive the round trip.
  assert.deepEqual(diff(declaredModel, dumpModel), []);
  assert.deepEqual(diagnostics, []);
});

test('imports standalone indexes, unique and concurrent, in name order', async () => {
  const dump = [
    `CREATE TABLE public.t (a integer, b integer);`,
    `CREATE INDEX t_b_idx ON public.t USING btree (b);`,
    `CREATE UNIQUE INDEX ON public.t (b);`,
    `CREATE INDEX CONCURRENTLY t_ab_idx ON public.t USING btree (a, b);`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const table = model.tables.find((candidate) => candidate.name === 't');
  assert.ok(table, 'the table is imported');

  // The conventional `t_b_idx` is canonicalized to unnamed and sorts with the other unnamed
  // entry by insertion order; `concurrently` is stored only when the statement states it.
  assert.deepEqual(table.indexes, [
    { unique: false, columns: ['b'] },
    { unique: true, columns: ['b'] },
    { name: 't_ab_idx', unique: false, columns: ['a', 'b'], concurrently: true },
  ]);
  assert.deepEqual(diagnostics, []);
});

test('canonicalizes only the exact conventional index name', async () => {
  const dump = [
    `CREATE TABLE public.t (a integer, b integer);`,
    `CREATE INDEX t_b_idx ON public.t USING btree (b);`,
    `CREATE INDEX t_ab_idx ON public.t USING btree (a, b);`,
    `CREATE INDEX t_b_idx1 ON public.t USING btree (b);`,
    `CREATE INDEX t_a_b_idx ON public.t USING btree (a, b);`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const table = model.tables.find((candidate) => candidate.name === 't');
  assert.ok(table, 'the table is imported');

  // The prediction joins columns with `_`, so `t_ab_idx` is not the conventional name for
  // `(a, b)` and is kept; a collision suffix (`t_b_idx1`) is beyond the offline prediction and
  // is kept too. The two exact predictions become unnamed and sort first by insertion order.
  assert.deepEqual(table.indexes, [
    { unique: false, columns: ['b'] },
    { unique: false, columns: ['a', 'b'] },
    { name: 't_ab_idx', unique: false, columns: ['a', 'b'] },
    { name: 't_b_idx1', unique: false, columns: ['b'] },
  ]);
  assert.deepEqual(diagnostics, []);
});

test('canonicalizes a truncated generated index name and keeps a collision-suffixed one', async () => {
  // `makeObjectName` spends 4 bytes on `_idx` and its separator, so the 60-byte column gives
  // up 3 bytes to fit 63: the server form is `t_` plus 57 bytes plus `_idx`. A collision suffix
  // grows the label and the column part gives up 4 bytes instead.
  const longColumn = 'w'.repeat(60);
  const generated = `t_${'w'.repeat(57)}_idx`;
  const suffixed = `t_${'w'.repeat(56)}_idx1`;
  const dump = [
    `CREATE TABLE public.t (${longColumn} integer);`,
    `CREATE INDEX ${generated} ON public.t USING btree (${longColumn});`,
    `CREATE INDEX ${suffixed} ON public.t USING btree (${longColumn});`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const table = model.tables.find((candidate) => candidate.name === 't');
  assert.ok(table, 'the table is imported');

  // Only the exact server form strips; the collision-suffixed name is beyond the offline
  // prediction and stays named (no unnamed entry shares its structure, so no guard fires).
  assert.deepEqual(table.indexes, [
    { unique: false, columns: [longColumn] },
    { name: suffixed, unique: false, columns: [longColumn] },
  ]);
  assert.deepEqual(diagnostics, []);
});

test('keeps a conventional name when an unnamed twin exists, whatever the statement order', async () => {
  const statements = [
    `CREATE INDEX t_b_idx ON public.t USING btree (b);`,
    `CREATE INDEX ON public.t USING btree (b);`,
  ];
  const expected = [
    { unique: false, columns: ['b'] },
    { name: 't_b_idx', unique: false, columns: ['b'] },
  ];

  for (const order of [statements, [...statements].reverse()]) {
    const dump = [`CREATE TABLE public.t (a integer, b integer);`, ...order].join('\n');
    const { model, diagnostics } = await importDump(dump);
    const table = model.tables.find((candidate) => candidate.name === 't');
    assert.ok(table, 'the table is imported');

    // The guard keeps the name on the conventional entry: exactly one unnamed structural
    // entry survives in either order, and the result array is identical.
    assert.deepEqual(table.indexes, expected);
    assert.deepEqual(diagnostics, []);
  }
});

test('keeps a truncated conventional index name when an unnamed twin exists, whatever the statement order', async () => {
  const longColumn = 'w'.repeat(60);
  const generated = `t_${'w'.repeat(57)}_idx`;
  const statements = [
    `CREATE INDEX ${generated} ON public.t USING btree (${longColumn});`,
    `CREATE INDEX ON public.t USING btree (${longColumn});`,
  ];
  const expected = [
    { unique: false, columns: [longColumn] },
    { name: generated, unique: false, columns: [longColumn] },
  ];

  for (const order of [statements, [...statements].reverse()]) {
    const dump = [`CREATE TABLE public.t (${longColumn} integer);`, ...order].join('\n');
    const { model, diagnostics } = await importDump(dump);
    const table = model.tables.find((candidate) => candidate.name === 't');
    assert.ok(table, 'the table is imported');

    // The guard keeps the name on the truncated conventional entry: exactly one unnamed
    // structural entry survives in either order, as for the short-name form.
    assert.deepEqual(table.indexes, expected);
    assert.deepEqual(diagnostics, []);
  }
});

test('a conventional name round-trips against an unnamed declaration with an empty diff', async () => {
  const named = [
    `CREATE TABLE public.t (a integer, b integer);`,
    `CREATE INDEX t_b_idx ON public.t USING btree (b);`,
  ].join('\n');
  const unnamed = [
    `CREATE TABLE public.t (a integer, b integer);`,
    `CREATE INDEX ON public.t USING btree (b);`,
  ].join('\n');

  const { model: baseline } = await importDump(named);
  const { model: target } = await importDump(unnamed);
  assert.deepEqual(diff(baseline, target), []);
});

test('canonicalizes the conventional primary-key name', async () => {
  const dump = [
    `CREATE TABLE public.t (a integer, CONSTRAINT t_pkey PRIMARY KEY (a));`,
    `CREATE TABLE public.u (b integer, CONSTRAINT u_custom_pkey PRIMARY KEY (b));`,
    `CREATE TABLE public.v (c integer, CONSTRAINT v_pkey1 PRIMARY KEY (c));`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const primaryKeyOf = (name: string) =>
    model.tables.find((table) => table.name === name)?.primaryKey;

  // PostgreSQL names an unnamed primary key `<table>_pkey`; a collision suffix (`v_pkey1`) and
  // any other name (`u_custom_pkey`) are outside the formula and stay named. There is no twin
  // guard: PostgreSQL allows one primary key per table.
  assert.deepEqual(primaryKeyOf('t'), { columns: ['a'] });
  assert.deepEqual(primaryKeyOf('u'), { name: 'u_custom_pkey', columns: ['b'] });
  assert.deepEqual(primaryKeyOf('v'), { name: 'v_pkey1', columns: ['c'] });
  assert.deepEqual(diagnostics, []);
});

test('canonicalizes a truncated generated primary-key name', async () => {
  // A 63-byte table name leaves `_pkey` its 5 bytes only after the table part gives up 5 bytes,
  // so the server names the primary key with a 58-byte table part. A name one byte short of the
  // server form is outside the formula and stays named.
  const longTable = 't'.repeat(63);
  const generated = `${'t'.repeat(58)}_pkey`;
  const nearMissTable = 'u'.repeat(63);
  const nearMiss = `${'u'.repeat(57)}_pkey`;
  const dump = [
    `CREATE TABLE public.${longTable} (c integer, CONSTRAINT ${generated} PRIMARY KEY (c));`,
    `CREATE TABLE public.${nearMissTable} (c integer, CONSTRAINT ${nearMiss} PRIMARY KEY (c));`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const primaryKeyOf = (name: string) =>
    model.tables.find((candidate) => candidate.name === name)?.primaryKey;

  assert.deepEqual(primaryKeyOf(longTable), { columns: ['c'] });
  assert.deepEqual(primaryKeyOf(nearMissTable), { name: nearMiss, columns: ['c'] });
  assert.deepEqual(diagnostics, []);
});

test('canonicalizes only the exact conventional unique-constraint name', async () => {
  const dump = [
    `CREATE TABLE public.t (a integer, b integer);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_a_key UNIQUE (a);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_b_key UNIQUE (a);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_a_key1 UNIQUE (a);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_a_b_key UNIQUE (a, b);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_b_a_key UNIQUE (a, b);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_ab_key UNIQUE (a, b);`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const table = model.tables.find((candidate) => candidate.name === 't');
  assert.ok(table, 'the table is imported');

  // Only the exact `<table>_<cols>_key` formula strips, in the constraint's own column order:
  // `t_b_key` names the wrong column for `(a)`, `t_a_key1` is a collision suffix,
  // `t_b_a_key` lists the columns in the wrong order, and `t_ab_key` lacks the separator.
  assert.deepEqual(table.uniqueConstraints, [
    { columns: ['a'] },
    { name: 't_a_key1', columns: ['a'] },
    { name: 't_b_key', columns: ['a'] },
    { columns: ['a', 'b'] },
    { name: 't_ab_key', columns: ['a', 'b'] },
    { name: 't_b_a_key', columns: ['a', 'b'] },
  ]);
  assert.deepEqual(diagnostics, []);
});

test('canonicalizes a truncated generated unique-constraint name and keeps a collision-suffixed one', async () => {
  // The `_key` label leaves a 58-byte budget beside the 1-byte table, so the 60-byte column
  // gives up 3 bytes; the collision suffix gives up 4 instead.
  const longColumn = 'w'.repeat(60);
  const generated = `t_${'w'.repeat(57)}_key`;
  const suffixed = `t_${'w'.repeat(56)}_key1`;
  const dump = [
    `CREATE TABLE public.t (${longColumn} integer);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT ${generated} UNIQUE (${longColumn});`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT ${suffixed} UNIQUE (${longColumn});`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const table = model.tables.find((candidate) => candidate.name === 't');
  assert.ok(table, 'the table is imported');

  // Only the exact server form strips; the collision-suffixed name stays named.
  assert.deepEqual(table.uniqueConstraints, [
    { columns: [longColumn] },
    { name: suffixed, columns: [longColumn] },
  ]);
  assert.deepEqual(diagnostics, []);
});

test('canonicalizes only the exact conventional foreign-key name', async () => {
  const dump = [
    `CREATE TABLE public.parent (id integer PRIMARY KEY);`,
    `CREATE TABLE public.parent2 (x integer, y integer, PRIMARY KEY (x, y));`,
    `CREATE TABLE public.t (a integer, b integer);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_a_fkey FOREIGN KEY (a) REFERENCES public.parent(id);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_b_fkey FOREIGN KEY (a) REFERENCES public.parent(id);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_a_fkey1 FOREIGN KEY (a) REFERENCES public.parent(id);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_a_b_fkey FOREIGN KEY (a, b) REFERENCES public.parent2(x, y);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_b_a_fkey FOREIGN KEY (a, b) REFERENCES public.parent2(x, y);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_ab_fkey FOREIGN KEY (a, b) REFERENCES public.parent2(x, y);`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const table = model.tables.find((candidate) => candidate.name === 't');
  assert.ok(table, 'the table is imported');

  // Only the exact `<table>_<cols>_fkey` formula strips, in the constraint's own column order:
  // `t_b_fkey` names the wrong column for `(a)`, `t_a_fkey1` is a collision suffix,
  // `t_b_a_fkey` lists the columns in the wrong order, and `t_ab_fkey` lacks the separator.
  assert.deepEqual(table.foreignKeys, [
    {
      columns: ['a'],
      referencedTable: { schema: 'public', name: 'parent' },
      referencedColumns: ['id'],
    },
    {
      name: 't_a_fkey1',
      columns: ['a'],
      referencedTable: { schema: 'public', name: 'parent' },
      referencedColumns: ['id'],
    },
    {
      name: 't_b_fkey',
      columns: ['a'],
      referencedTable: { schema: 'public', name: 'parent' },
      referencedColumns: ['id'],
    },
    {
      columns: ['a', 'b'],
      referencedTable: { schema: 'public', name: 'parent2' },
      referencedColumns: ['x', 'y'],
    },
    {
      name: 't_ab_fkey',
      columns: ['a', 'b'],
      referencedTable: { schema: 'public', name: 'parent2' },
      referencedColumns: ['x', 'y'],
    },
    {
      name: 't_b_a_fkey',
      columns: ['a', 'b'],
      referencedTable: { schema: 'public', name: 'parent2' },
      referencedColumns: ['x', 'y'],
    },
  ]);
  assert.deepEqual(diagnostics, []);
});

test('canonicalizes a truncated generated foreign-key name and keeps a collision-suffixed one', async () => {
  // The `_fkey` label leaves a 57-byte budget beside the 1-byte table, so the 60-byte column
  // gives up 4 bytes; the collision suffix gives up 5 instead.
  const longColumn = 'w'.repeat(60);
  const generated = `t_${'w'.repeat(56)}_fkey`;
  const suffixed = `t_${'w'.repeat(55)}_fkey1`;
  const parent = { schema: 'public', name: 'parent' };
  const dump = [
    `CREATE TABLE public.parent (id integer PRIMARY KEY);`,
    `CREATE TABLE public.t (${longColumn} integer);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT ${generated} FOREIGN KEY (${longColumn}) REFERENCES public.parent(id);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT ${suffixed} FOREIGN KEY (${longColumn}) REFERENCES public.parent(id);`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const table = model.tables.find((candidate) => candidate.name === 't');
  assert.ok(table, 'the table is imported');

  // Only the exact server form strips; the collision-suffixed name stays named.
  assert.deepEqual(table.foreignKeys, [
    { columns: [longColumn], referencedTable: parent, referencedColumns: ['id'] },
    {
      name: suffixed,
      columns: [longColumn],
      referencedTable: parent,
      referencedColumns: ['id'],
    },
  ]);
  assert.deepEqual(diagnostics, []);
});

test('canonicalizes only the exact conventional check-constraint name', async () => {
  const dump = [
    `CREATE TABLE public.t (a integer, b integer);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_a_check CHECK (a > 0);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_b_check CHECK (a > 0);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_check CHECK (a > 0 AND b > 0);`,
    `CREATE TABLE public.u (c integer);`,
    `ALTER TABLE ONLY public.u ADD CONSTRAINT u_c_check CHECK (c IS NOT NULL);`,
    `ALTER TABLE ONLY public.u ADD CONSTRAINT u_check CHECK (true);`,
    `CREATE TABLE public.v (d integer);`,
    `ALTER TABLE ONLY public.v ADD CONSTRAINT v_check CHECK (d > 0);`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const checksOf = (name: string) =>
    model.tables.find((candidate) => candidate.name === name)?.checkConstraints;

  // A single-column expression strips only as `<table>_<col>_check`: `t_b_check` names the
  // wrong column for `a > 0`, and a generic `<table>_check` on a single-column expression
  // (`v_check`) stays, because PostgreSQL would have assigned `v_d_check`. A multi-column
  // expression (`t_check`) and a zero-column one (`u_check`) are the generic shape and strip.
  assert.deepEqual(checksOf('t'), [
    { expression: 'a > 0' },
    { name: 't_b_check', expression: 'a > 0' },
    { expression: 'a > 0 AND b > 0' },
  ]);
  assert.deepEqual(checksOf('u'), [{ expression: 'c IS NOT NULL' }, { expression: 'true' }]);
  assert.deepEqual(checksOf('v'), [{ name: 'v_check', expression: 'd > 0' }]);
  assert.deepEqual(diagnostics, []);
});

test('canonicalizes a truncated generated check-constraint name and keeps a collision-suffixed one', async () => {
  // The `_check` label leaves a 56-byte budget beside the 1-byte table, so the 60-byte column
  // gives up 5 bytes; the collision suffix gives up 6 instead.
  const longColumn = 'w'.repeat(60);
  const generated = `t_${'w'.repeat(55)}_check`;
  const suffixed = `t_${'w'.repeat(54)}_check1`;
  const dump = [
    `CREATE TABLE public.t (${longColumn} integer);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT ${generated} CHECK (${longColumn} > 0);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT ${suffixed} CHECK (${longColumn} > 0);`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const table = model.tables.find((candidate) => candidate.name === 't');
  assert.ok(table, 'the table is imported');

  // Only the exact server form strips; the collision-suffixed name stays named.
  assert.deepEqual(table.checkConstraints, [
    { expression: `${longColumn} > 0` },
    { name: suffixed, expression: `${longColumn} > 0` },
  ]);
  assert.deepEqual(diagnostics, []);
});

test('keeps a conventional unique name when an unnamed twin exists, whatever the statement order', async () => {
  const statements = [
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_a_key UNIQUE (a);`,
    `ALTER TABLE ONLY public.t ADD UNIQUE (a);`,
  ];
  const expected = [{ columns: ['a'] }, { name: 't_a_key', columns: ['a'] }];

  for (const order of [statements, [...statements].reverse()]) {
    const dump = [`CREATE TABLE public.t (a integer, b integer);`, ...order].join('\n');
    const { model, diagnostics } = await importDump(dump);
    const table = model.tables.find((candidate) => candidate.name === 't');
    assert.ok(table, 'the table is imported');

    // The guard keeps the name on the conventional entry: exactly one unnamed entry survives
    // in either order, so no duplicate unnamed entry is manufactured.
    assert.deepEqual(table.uniqueConstraints, expected);
    assert.deepEqual(diagnostics, []);
  }
});

test('keeps a truncated conventional unique name when an unnamed twin exists, whatever the statement order', async () => {
  const longColumn = 'w'.repeat(60);
  const generated = `t_${'w'.repeat(57)}_key`;
  const statements = [
    `ALTER TABLE ONLY public.t ADD CONSTRAINT ${generated} UNIQUE (${longColumn});`,
    `ALTER TABLE ONLY public.t ADD UNIQUE (${longColumn});`,
  ];
  const expected = [{ columns: [longColumn] }, { name: generated, columns: [longColumn] }];

  for (const order of [statements, [...statements].reverse()]) {
    const dump = [`CREATE TABLE public.t (${longColumn} integer);`, ...order].join('\n');
    const { model, diagnostics } = await importDump(dump);
    const table = model.tables.find((candidate) => candidate.name === 't');
    assert.ok(table, 'the table is imported');

    // The guard keeps the name on the truncated conventional entry: exactly one unnamed
    // structural entry survives in either order.
    assert.deepEqual(table.uniqueConstraints, expected);
    assert.deepEqual(diagnostics, []);
  }
});

test('keeps a conventional foreign-key name when an unnamed twin exists, whatever the statement order', async () => {
  const statements = [
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_a_fkey FOREIGN KEY (a) REFERENCES public.parent(id);`,
    `ALTER TABLE ONLY public.t ADD FOREIGN KEY (a) REFERENCES public.parent(id);`,
  ];
  const parent = { schema: 'public', name: 'parent' };
  const expected = [
    { columns: ['a'], referencedTable: parent, referencedColumns: ['id'] },
    { name: 't_a_fkey', columns: ['a'], referencedTable: parent, referencedColumns: ['id'] },
  ];

  for (const order of [statements, [...statements].reverse()]) {
    const dump = [
      `CREATE TABLE public.parent (id integer PRIMARY KEY);`,
      `CREATE TABLE public.t (a integer);`,
      ...order,
    ].join('\n');
    const { model, diagnostics } = await importDump(dump);
    const table = model.tables.find((candidate) => candidate.name === 't');
    assert.ok(table, 'the table is imported');

    assert.deepEqual(table.foreignKeys, expected);
    assert.deepEqual(diagnostics, []);
  }
});

test('strips a conventional foreign-key name beside a twin differing only in an action', async () => {
  const statements = [
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_a_fkey FOREIGN KEY (a) REFERENCES public.parent(id);`,
    `ALTER TABLE ONLY public.t ADD FOREIGN KEY (a) REFERENCES public.parent(id) ON DELETE CASCADE;`,
  ];
  const parent = { schema: 'public', name: 'parent' };
  const plain = { columns: ['a'], referencedTable: parent, referencedColumns: ['id'] };
  const cascading = {
    columns: ['a'],
    referencedTable: parent,
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  };
  const dump = [
    `CREATE TABLE public.parent (id integer PRIMARY KEY);`,
    `CREATE TABLE public.t (a integer);`,
  ];

  // The twin guard's key is equality-minus-name: the named foreign key differs from the
  // unnamed twin in `onDelete`, so it is not a twin, stripping manufactures no duplicate, and
  // the name is stripped. The core diff's narrower `foreignKeyIdentity` (columns and target
  // only) would have treated them as twins and kept the name, silently losing the action —
  // equality-minus-name here is deliberate.
  const { model: first } = await importDump([...dump, ...statements].join('\n'));
  assert.deepEqual(first.tables.find((candidate) => candidate.name === 't')?.foreignKeys, [
    plain,
    cascading,
  ]);
  const { model: second } = await importDump([...dump, ...[...statements].reverse()].join('\n'));
  assert.deepEqual(second.tables.find((candidate) => candidate.name === 't')?.foreignKeys, [
    cascading,
    plain,
  ]);
});

test('keeps a conventional check name when an unnamed twin exists, whatever the statement order', async () => {
  const statements = [
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_a_check CHECK (a > 0);`,
    `ALTER TABLE ONLY public.t ADD CHECK (a > 0);`,
  ];
  const expected = [{ expression: 'a > 0' }, { name: 't_a_check', expression: 'a > 0' }];

  for (const order of [statements, [...statements].reverse()]) {
    const dump = [`CREATE TABLE public.t (a integer);`, ...order].join('\n');
    const { model, diagnostics } = await importDump(dump);
    const table = model.tables.find((candidate) => candidate.name === 't');
    assert.ok(table, 'the table is imported');

    assert.deepEqual(table.checkConstraints, expected);
    assert.deepEqual(diagnostics, []);
  }
});

test('a conventional constraint name round-trips against an unnamed declaration with an empty diff', async () => {
  const named = [
    `CREATE TABLE public.parent (x integer, y integer);`,
    `CREATE TABLE public.t (a integer, b integer);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_pkey PRIMARY KEY (a);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_a_key UNIQUE (a);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_a_b_fkey FOREIGN KEY (a, b) REFERENCES public.parent(x, y);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_a_check CHECK (a > 0);`,
  ].join('\n');
  const unnamed = [
    `CREATE TABLE public.parent (x integer, y integer);`,
    `CREATE TABLE public.t (a integer, b integer);`,
    `ALTER TABLE ONLY public.t ADD PRIMARY KEY (a);`,
    `ALTER TABLE ONLY public.t ADD UNIQUE (a);`,
    `ALTER TABLE ONLY public.t ADD FOREIGN KEY (a, b) REFERENCES public.parent(x, y);`,
    `ALTER TABLE ONLY public.t ADD CHECK (a > 0);`,
  ].join('\n');

  const { model: baseline } = await importDump(named);
  const { model: target } = await importDump(unnamed);
  assert.deepEqual(diff(baseline, target), []);
});

test('keeps a check name the best-effort formula does not predict', async () => {
  const named = [
    `CREATE TABLE public.t (a timestamp);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_a_check CHECK (EXTRACT(epoch FROM a) = 0);`,
  ].join('\n');
  const unnamed = [
    `CREATE TABLE public.t (a timestamp);`,
    `ALTER TABLE ONLY public.t ADD CHECK (EXTRACT(epoch FROM a) = 0);`,
  ].join('\n');

  const { model } = await importDump(named);
  const table = model.tables.find((candidate) => candidate.name === 't');
  assert.ok(table, 'the table is imported');

  // The lexical scan counts `epoch` as a column reference — it is not a function name, a type
  // after `::`, a CAST alias, or a key word — so the helper predicts `t_check`, while
  // PostgreSQL cooks the expression to one column, `a`, and names the constraint `t_a_check`.
  // The name therefore stays, and an import compared against an unnamed declaration of the
  // same check still reads changed: the fail-safe side of the best-effort formula.
  assert.deepEqual(table.checkConstraints, [
    { name: 't_a_check', expression: 'EXTRACT(epoch FROM a) = 0' },
  ]);
  const { model: expected } = await importDump(unnamed);
  assert.deepEqual(diff(model, expected), [
    {
      kind: 'table-changed',
      table: { schema: 'public', name: 't' },
      changes: [
        {
          kind: 'check-constraint-changed',
          before: { name: 't_a_check', expression: 'EXTRACT(epoch FROM a) = 0' },
          after: { expression: 'EXTRACT(epoch FROM a) = 0' },
        },
      ],
    },
  ]);
});

test('an unnamed foreign key without referenced columns round-trips against a dump', async () => {
  const declared = [
    `CREATE TABLE public.parent (id integer PRIMARY KEY);`,
    `CREATE TABLE public.child (a integer);`,
    `ALTER TABLE ONLY public.child ADD CONSTRAINT child_a_fkey FOREIGN KEY (a) REFERENCES public.parent;`,
  ].join('\n');
  const serverDump = [
    `CREATE TABLE public.parent (id integer PRIMARY KEY);`,
    `CREATE TABLE public.child (a integer);`,
    `ALTER TABLE ONLY public.child ADD CONSTRAINT child_a_fkey FOREIGN KEY (a) REFERENCES public.parent(id);`,
  ].join('\n');

  const { model: declaredModel } = await importDump(declared);
  const { model: serverModel } = await importDump(serverDump);

  // Both declarations canonicalize `child_a_fkey` back to unnamed; the server dump carries the
  // concrete referenced-column list, but the declaration's omission resolves against its own
  // model's referenced-table primary key (`public.parent.id`), so the two compare equal.
  assert.deepEqual(diff(declaredModel, serverModel), []);
});

test('skips whole indexes with elements or clauses outside the minimal envelope', async () => {
  const dump = [
    `CREATE TABLE public.t (a integer, b integer);`,
    `CREATE INDEX t_expr_idx ON public.t ((a + 1));`,
    `CREATE INDEX t_partial_idx ON public.t (a) WHERE (a > 0);`,
    `CREATE INDEX t_include_idx ON public.t (a) INCLUDE (b);`,
    `CREATE INDEX t_hash_idx ON public.t USING hash (a);`,
    `CREATE INDEX t_desc_idx ON public.t (a DESC);`,
    `CREATE INDEX t_nulls_idx ON public.t (a NULLS FIRST);`,
    `CREATE INDEX t_opclass_idx ON public.t (a text_pattern_ops);`,
    `CREATE INDEX t_collate_idx ON public.t (a COLLATE "C");`,
    `CREATE INDEX t_tablespace_idx ON public.t (a) TABLESPACE pg_default;`,
    `CREATE INDEX t_storage_idx ON public.t (a) WITH (fillfactor = 70);`,
    `CREATE UNIQUE INDEX t_nd_idx ON public.t (a) NULLS NOT DISTINCT;`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const table = model.tables.find((candidate) => candidate.name === 't');
  assert.ok(table, 'the table is imported');

  // An index is never partially imported: every statement outside the envelope is skipped
  // whole and named.
  assert.deepEqual(table.indexes, []);
  assert.deepEqual(
    diagnostics.map(summarize),
    [
      't_expr_idx',
      't_partial_idx',
      't_include_idx',
      't_hash_idx',
      't_desc_idx',
      't_nulls_idx',
      't_opclass_idx',
      't_collate_idx',
      't_tablespace_idx',
      't_storage_idx',
      't_nd_idx',
    ].map((object) => ({ kind: 'skip', code: 'unsupported-statement', object })),
  );

  const messages = diagnostics.map((diagnostic) => diagnostic.message).join('\n');
  assert.match(messages, /CREATE INDEX t_expr_idx \(expression element\)/);
  assert.match(messages, /CREATE INDEX t_partial_idx \(partial WHERE\)/);
  assert.match(messages, /CREATE INDEX t_include_idx \(INCLUDE\)/);
  assert.match(messages, /CREATE INDEX t_hash_idx \(access method hash\)/);
  assert.match(messages, /CREATE INDEX t_desc_idx \(non-default ordering\)/);
  assert.match(messages, /CREATE INDEX t_nulls_idx \(non-default NULLS ordering\)/);
  assert.match(messages, /CREATE INDEX t_opclass_idx \(operator class\)/);
  assert.match(messages, /CREATE INDEX t_collate_idx \(collation\)/);
  assert.match(messages, /CREATE INDEX t_tablespace_idx \(tablespace\)/);
  assert.match(messages, /CREATE INDEX t_storage_idx \(storage parameters\)/);
  assert.match(messages, /CREATE INDEX t_nd_idx \(NULLS NOT DISTINCT\)/);
});

test('consumes a plain unique index into a USING INDEX constraint', async () => {
  const dump = [
    `CREATE TABLE public.t (a integer, b integer);`,
    `CREATE UNIQUE INDEX t_a_idx ON public.t USING btree (a);`,
    `CREATE UNIQUE INDEX t_b_idx ON public.t USING btree (b);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_a_key UNIQUE USING INDEX t_a_idx;`,
    `ALTER TABLE ONLY public.t ADD UNIQUE USING INDEX t_b_idx;`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const table = model.tables.find((candidate) => candidate.name === 't');
  assert.ok(table, 'the table is imported');

  // The constraint absorbs the index, taking the stated name or the index's when unnamed; no
  // standalone Index survives. A swallowed name that matches the conventional unique formula
  // (`t_a_key` for `(a)`) canonicalizes back to unnamed; `t_b_idx` is an index name, not the
  // formula for `(b)`, so it stays named.
  assert.deepEqual(table.uniqueConstraints, [
    { columns: ['a'] },
    { name: 't_b_idx', columns: ['b'] },
  ]);
  assert.deepEqual(table.indexes, []);
  assert.deepEqual(diagnostics, []);
});

test('reads deferrability from a USING INDEX unique constraint', async () => {
  const dump = [
    `CREATE TABLE public.t (a integer);`,
    `CREATE UNIQUE INDEX t_a_idx ON public.t USING btree (a);`,
    `ALTER TABLE ONLY public.t ADD UNIQUE USING INDEX t_a_idx DEFERRABLE INITIALLY DEFERRED;`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const table = model.tables.find((candidate) => candidate.name === 't');
  assert.ok(table, 'the table is imported');

  // The consumed index's constraint still reads the attributes the statement states; its name
  // is the index's (`t_a_idx`), which is not the unique formula for `(a)` and stays.
  assert.deepEqual(table.uniqueConstraints, [
    { name: 't_a_idx', columns: ['a'], deferrable: true, initiallyDeferred: true },
  ]);
  assert.deepEqual(table.indexes, []);
  assert.deepEqual(diagnostics, []);
});

test('flags an exclusion constraint instead of modeling it', async () => {
  const dump = [
    `CREATE TABLE public.t (a integer, EXCLUDE USING gist (a WITH =));`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_excl EXCLUDE USING gist (a WITH <>);`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const table = model.tables.find((candidate) => candidate.name === 't');
  assert.ok(table, 'the table is imported');

  // Exclusion constraints remain outside the model, as before this slice.
  assert.deepEqual(table.uniqueConstraints, []);
  assert.deepEqual(table.checkConstraints, []);
  assert.deepEqual(diagnostics.map(summarize), [
    { kind: 'flag', code: 'unsupported-attribute', object: 'public.t' },
    { kind: 'skip', code: 'unsupported-statement', object: 't_excl' },
  ]);
  assert.match(diagnostics[0]?.message ?? '', /dropped exclusion constraint from public\.t/);
  assert.match(diagnostics[1]?.message ?? '', /exclusion constraint t_excl on public\.t/);
});

test('skips a USING INDEX constraint whole when the index cannot back it', async () => {
  const dump = [
    `CREATE TABLE public.t (a integer, b integer);`,
    `CREATE INDEX t_a_idx ON public.t (a);`,
    `CREATE UNIQUE INDEX t_b_idx ON public.t ((b + 1));`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_a_key UNIQUE USING INDEX t_a_idx;`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_b_key UNIQUE USING INDEX t_b_idx;`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_missing_key UNIQUE USING INDEX t_missing;`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const table = model.tables.find((candidate) => candidate.name === 't');
  assert.ok(table, 'the table is imported');

  // The non-unique index stays standalone, canonicalized to unnamed; the expression index was
  // skipped whole, and every USING INDEX constraint that cannot consume a plain unique index is
  // skipped and named.
  assert.deepEqual(table.uniqueConstraints, []);
  assert.deepEqual(table.indexes, [{ unique: false, columns: ['a'] }]);
  assert.deepEqual(diagnostics.map(summarize), [
    { kind: 'skip', code: 'unsupported-statement', object: 't_b_idx' },
    { kind: 'skip', code: 'unsupported-statement', object: 't_a_key' },
    { kind: 'skip', code: 'unsupported-statement', object: 't_b_key' },
    { kind: 'skip', code: 'unsupported-statement', object: 't_missing_key' },
  ]);

  const messages = diagnostics.map((diagnostic) => diagnostic.message).join('\n');
  assert.match(messages, /CREATE INDEX t_b_idx \(expression element\)/);
  assert.match(messages, /unique constraint t_a_key on public\.t \(USING INDEX t_a_idx\)/);
  assert.match(messages, /unique constraint t_b_key on public\.t \(USING INDEX t_b_idx\)/);
  assert.match(messages, /unique constraint t_missing_key on public\.t \(USING INDEX t_missing\)/);
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
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_legacy_key UNIQUE (legacy_id);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_legacy_check CHECK (legacy_id > 0);`,
    `CREATE INDEX t_legacy_idx ON public.t (legacy_id);`,
    `CREATE TABLE public.t (id integer, name text);`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);

  // The second definition wins wholesale: stale columns, primary key, foreign keys, unique
  // constraints, check constraints, and indexes are gone.
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
        uniqueConstraints: [],
        checkConstraints: [],
        indexes: [],
      },
    ],
    sequences: [],
    views: [],
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
        uniqueConstraints: [],
        checkConstraints: [],
        indexes: [],
      },
    ],
    sequences: [],
    views: [],
  });
});

test('models inline identity columns with effective, generation-aware options', async () => {
  const dump = [
    `CREATE TABLE public.always (id integer GENERATED ALWAYS AS IDENTITY);`,
    `CREATE TABLE public.by_default (id smallint GENERATED BY DEFAULT AS IDENTITY);`,
    `CREATE TABLE public.custom (id bigint GENERATED BY DEFAULT AS IDENTITY (START WITH 5 INCREMENT BY 2 MAXVALUE 100 CACHE 10 CYCLE));`,
    `CREATE TABLE public.explicit (id integer GENERATED ALWAYS AS IDENTITY (INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1 NO CYCLE));`,
    `CREATE TABLE public.no_bounds (id integer GENERATED ALWAYS AS IDENTITY (NO MINVALUE NO MAXVALUE));`,
    `CREATE TABLE public.descending (id bigint GENERATED ALWAYS AS IDENTITY (INCREMENT -5));`,
    `CREATE TABLE public.exact (id bigint GENERATED ALWAYS AS IDENTITY (START WITH 9007199254740993));`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const identityOf = (table: string) => {
    const found = model.tables.find((candidate) => candidate.name === table);
    assert.ok(found, `table ${table} is imported`);
    return found.columns[0]?.identity;
  };

  assert.deepEqual(identityOf('always'), {
    generated: 'always',
    increment: '1',
    minValue: '1',
    maxValue: '2147483647',
    start: '1',
    cache: '1',
    cycle: false,
  });
  // BY DEFAULT keeps the mode, and the bounds come from the column's type.
  assert.deepEqual(identityOf('by_default'), {
    generated: 'by default',
    increment: '1',
    minValue: '1',
    maxValue: '32767',
    start: '1',
    cache: '1',
    cycle: false,
  });
  assert.deepEqual(identityOf('custom'), {
    generated: 'by default',
    increment: '2',
    minValue: '1',
    maxValue: '100',
    start: '5',
    cache: '10',
    cycle: true,
  });
  // Stating every engine default explicitly means the same identity as omitting them …
  assert.deepEqual(identityOf('explicit'), identityOf('always'));
  // … as does NO MINVALUE / NO MAXVALUE.
  assert.deepEqual(identityOf('no_bounds'), identityOf('always'));
  // Descending defaults invert: START is the maximum, the minimum is the type's.
  assert.deepEqual(identityOf('descending'), {
    generated: 'always',
    increment: '-5',
    minValue: '-9223372036854775808',
    maxValue: '-1',
    start: '-1',
    cache: '1',
    cycle: false,
  });
  // A 64-bit option value survives exactly, never through a JavaScript number.
  assert.equal(identityOf('exact')?.start, '9007199254740993');
  assert.equal(Number(identityOf('exact')?.start), 9007199254740992);

  // Identity implies NOT NULL even when the column is not declared so.
  const always = model.tables.find((candidate) => candidate.name === 'always');
  assert.equal(always?.columns[0]?.notNull, true);
  assert.deepEqual(diagnostics, []);
});

test('resolves identity sequence names against the table schema', async () => {
  const dump = [
    `CREATE TABLE public.unqualified (id integer GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME unqualified_id_seq));`,
    `CREATE TABLE app.unqualified (id integer GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME app_unqualified_id_seq));`,
    `CREATE TABLE public.same (id integer GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME public.same_id_seq));`,
    `CREATE TABLE app.other (id integer GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME app.other_id_seq));`,
    `CREATE TABLE public.cross (id integer GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME app.cross_id_seq));`,
    `CREATE TABLE public.renamed (id integer GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME renamed_id_seq));`,
    `ALTER TABLE public.renamed ALTER COLUMN id SET SEQUENCE NAME app.renamed_id_seq;`,
    `CREATE TABLE public.malformed (id integer GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME a.b.c));`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const sequenceNameOf = (table: string, schema = 'public') =>
    model.tables.find((candidate) => candidate.schema === schema && candidate.name === table)
      ?.columns[0]?.identity?.sequenceName;

  // An unqualified name resolves to the table's schema, like OWNED BY resolves its table.
  assert.deepEqual(sequenceNameOf('unqualified'), {
    schema: 'public',
    name: 'unqualified_id_seq',
  });
  assert.deepEqual(sequenceNameOf('unqualified', 'app'), {
    schema: 'app',
    name: 'app_unqualified_id_seq',
  });
  assert.deepEqual(sequenceNameOf('same'), { schema: 'public', name: 'same_id_seq' });
  assert.deepEqual(sequenceNameOf('other', 'app'), { schema: 'app', name: 'other_id_seq' });
  // A cross-schema name is flagged by name, and the identity is modeled without one — for a
  // later SET SEQUENCE NAME too, which replaces the name the CREATE TABLE stated.
  assert.equal(sequenceNameOf('cross'), undefined);
  assert.equal(sequenceNameOf('renamed'), undefined);
  // A name with an unusable shape is flagged the same way.
  assert.equal(sequenceNameOf('malformed'), undefined);
  assert.deepEqual(diagnostics.map(summarize), [
    { kind: 'flag', code: 'unsupported-attribute', object: 'public.cross' },
    { kind: 'flag', code: 'unsupported-attribute', object: 'public.renamed' },
    { kind: 'flag', code: 'unsupported-attribute', object: 'public.malformed' },
  ]);
  const messages = diagnostics.map((diagnostic) => diagnostic.message).join('\n');
  assert.match(
    messages,
    /cross-schema identity sequence name app\.cross_id_seq on public\.cross\.id/,
  );
  assert.match(
    messages,
    /cross-schema identity sequence name app\.renamed_id_seq on public\.renamed\.id/,
  );
  assert.match(messages, /identity sequence name a\.b\.c on public\.malformed\.id/);
});

test('flags identity options the model cannot carry, and non-integer identity types', async () => {
  const dump = [
    `CREATE TABLE public.options (id integer GENERATED ALWAYS AS IDENTITY (AS bigint OWNED BY public.options.id RESTART 5 LOGGED));`,
    `CREATE TABLE public.unlogged (id integer GENERATED BY DEFAULT AS IDENTITY (UNLOGGED CACHE 2));`,
    `CREATE TABLE public.textual (id text GENERATED ALWAYS AS IDENTITY);`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);

  // AS, OWNED BY, RESTART, and LOGGED are dropped by name; the identity still imports.
  const options = model.tables.find((table) => table.name === 'options');
  assert.deepEqual(options?.columns[0]?.identity, {
    generated: 'always',
    increment: '1',
    minValue: '1',
    maxValue: '2147483647',
    start: '1',
    cache: '1',
    cycle: false,
  });
  // UNLOGGED is flagged; the CACHE next to it still applies.
  const unlogged = model.tables.find((table) => table.name === 'unlogged');
  assert.equal(unlogged?.columns[0]?.identity?.cache, '2');

  // A non-integer identity column is flagged and never modeled; NOT NULL still holds.
  const textual = model.tables.find((table) => table.name === 'textual');
  assert.equal(textual?.columns[0]?.identity, undefined);
  assert.equal(textual?.columns[0]?.notNull, true);

  const messages = diagnostics.map((diagnostic) => diagnostic.message).join('\n');
  assert.match(messages, /identity option AS on public\.options\.id/);
  assert.match(messages, /identity option OWNED BY on public\.options\.id/);
  assert.match(messages, /identity option RESTART on public\.options\.id/);
  assert.match(messages, /identity option LOGGED on public\.options\.id/);
  assert.match(messages, /identity option UNLOGGED on public\.unlogged\.id/);
  assert.match(
    messages,
    /identity semantics \(identity column type must be smallint, integer, or bigint\) on public\.textual\.id/,
  );
  assert.equal(diagnostics.filter((diagnostic) => diagnostic.kind === 'flag').length, 6);
});

test('applies ADD GENERATED and SET identity clauses per clause', async () => {
  const dump = [
    `CREATE TABLE public.t (id integer NOT NULL);`,
    `ALTER TABLE public.t ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (SEQUENCE NAME t_id_seq START WITH 7);`,
    `ALTER TABLE public.t ALTER COLUMN id SET GENERATED ALWAYS SET INCREMENT BY 2 SET START WITH 10 SET CACHE 5 SET CYCLE;`,
    `CREATE TABLE public.u (id integer NOT NULL);`,
    `ALTER TABLE public.u ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY;`,
    `ALTER TABLE public.u ALTER COLUMN id SET GENERATED BY DEFAULT;`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const table = model.tables.find((candidate) => candidate.name === 't');
  assert.ok(table, 'the table is imported');
  // Every clause applies on top of the descriptor ADD GENERATED left; the year-one options
  // that no clause restates stay effective.
  assert.deepEqual(table.columns, [
    {
      name: 'id',
      type: 'integer',
      notNull: true,
      identity: {
        generated: 'always',
        sequenceName: { schema: 'public', name: 't_id_seq' },
        increment: '2',
        minValue: '1',
        maxValue: '2147483647',
        start: '10',
        cache: '5',
        cycle: true,
      },
    },
  ]);
  // SET GENERATED flips the mode in both directions.
  const flipped = model.tables.find((candidate) => candidate.name === 'u');
  assert.equal(flipped?.columns[0]?.identity?.generated, 'by default');
  assert.deepEqual(diagnostics, []);
});

test('resets identity bounds with SET NO MINVALUE / SET NO MAXVALUE', async () => {
  const dump = [
    `CREATE TABLE public.t (id integer GENERATED ALWAYS AS IDENTITY (MAXVALUE 100 START 10));`,
    `ALTER TABLE public.t ALTER COLUMN id SET INCREMENT -1;`,
    `ALTER TABLE public.t ALTER COLUMN id SET NO MINVALUE SET NO MAXVALUE;`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const table = model.tables.find((candidate) => candidate.name === 't');
  assert.ok(table, 'the table is imported');
  // The resets resolve against the direction at the end of the clause list: descending.
  assert.deepEqual(table.columns[0]?.identity, {
    generated: 'always',
    increment: '-1',
    minValue: '-2147483648',
    maxValue: '-1',
    start: '10',
    cache: '1',
    cycle: false,
  });
  assert.deepEqual(diagnostics, []);
});

test('flags RESTART identity state and applies DROP IDENTITY, keeping NOT NULL', async () => {
  const dump = [
    `CREATE TABLE public.t (id bigint GENERATED ALWAYS AS IDENTITY);`,
    `ALTER TABLE public.t ALTER COLUMN id RESTART WITH 50;`,
    `ALTER TABLE public.t ALTER COLUMN id DROP IDENTITY;`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const table = model.tables.find((candidate) => candidate.name === 't');
  assert.ok(table, 'the table is imported');
  assert.deepEqual(table.columns, [{ name: 'id', type: 'bigint', notNull: true }]);
  assert.deepEqual(diagnostics.map(summarize), [
    { kind: 'flag', code: 'unsupported-attribute', object: 'public.t' },
  ]);
  assert.match(diagnostics[0]?.message ?? '', /identity option RESTART on public\.t\.id/);
});

test('skips identity actions on columns that are not modeled identities', async () => {
  const dump = [
    `CREATE TABLE public.t (id integer, note text);`,
    `ALTER TABLE public.t ALTER COLUMN id SET GENERATED ALWAYS;`,
    `ALTER TABLE public.t ALTER COLUMN note DROP IDENTITY;`,
    `ALTER TABLE public.t ALTER COLUMN missing RESTART WITH 5;`,
    `ALTER TABLE public.other ALTER COLUMN x SET GENERATED ALWAYS;`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);

  // The table is untouched: no identity appears where the ALTERs could not attach one.
  assert.deepEqual(
    model.tables[0]?.columns.map((column) => column.identity),
    [undefined, undefined],
  );
  assert.deepEqual(diagnostics.map(summarize), [
    { kind: 'skip', code: 'unsupported-statement', object: 'public.t.id' },
    { kind: 'skip', code: 'unsupported-statement', object: 'public.t.note' },
    { kind: 'skip', code: 'unsupported-statement', object: 'public.t.missing' },
    { kind: 'skip', code: 'unsupported-statement', object: 'public.other' },
  ]);
  const messages = diagnostics.map((diagnostic) => diagnostic.message).join('\n');
  assert.match(messages, /identity change on public\.t\.id \(column is not an identity column\)/);
  assert.match(messages, /identity change on public\.t\.note \(column is not an identity column\)/);
  assert.match(messages, /identity change for unknown column public\.t\.missing/);
  assert.match(messages, /ALTER TABLE public\.other \(table not imported\)/);
});

test('imports ADD COLUMN with inline identity', async () => {
  const dump = [
    `CREATE TABLE public.t (id integer NOT NULL);`,
    `ALTER TABLE public.t ADD COLUMN counter bigint GENERATED BY DEFAULT AS IDENTITY (SEQUENCE NAME t_counter_seq START WITH 3);`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const table = model.tables.find((candidate) => candidate.name === 't');
  assert.ok(table, 'the table is imported');
  assert.deepEqual(table.columns, [
    { name: 'id', type: 'integer', notNull: true },
    {
      name: 'counter',
      type: 'bigint',
      notNull: true,
      identity: {
        generated: 'by default',
        sequenceName: { schema: 'public', name: 't_counter_seq' },
        increment: '1',
        minValue: '1',
        maxValue: '9223372036854775807',
        start: '3',
        cache: '1',
        cycle: false,
      },
    },
  ]);
  assert.deepEqual(diagnostics, []);
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
    { kind: 'skip', code: 'unsupported-statement', object: 'public.s' },
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
  assert.match(messages, /SELECT setval\('public\.s', 1, false\)/);
});

test('names a setval call and keeps non-setval or non-literal select generic', async () => {
  const dump = [
    `SELECT setval('public.s', 1, false);`,
    `SELECT setval('public.' || 's', 1, false);`,
    `SELECT nextval('public.s');`,
  ].join('\n');

  const { diagnostics } = await importDump(dump);

  assert.deepEqual(diagnostics.map(summarize), [
    { kind: 'skip', code: 'unsupported-statement', object: 'public.s' },
    { kind: 'skip', code: 'unsupported-statement', object: 'SELECT' },
    { kind: 'skip', code: 'unsupported-statement', object: 'SELECT' },
  ]);
  const messages = diagnostics.map((diagnostic) => diagnostic.message);
  assert.equal(messages[0], "skipped SELECT setval('public.s', 1, false)");
  assert.deepEqual(messages.slice(1), ['skipped SELECT statement', 'skipped SELECT statement']);
});

test('reads inline collations as written, whitespace-normalized', async () => {
  const dump = [
    `CREATE TABLE public.t (`,
    `    a text COLLATE pg_catalog."C",`,
    `    b text COLLATE probe77."User_C" DEFAULT 'x',`,
    `    c text DEFAULT 'y'::text COLLATE "C",`,
    `    d text   COLLATE   pg_catalog."C"   NOT NULL,`,
    `    e text COLLATE c_lower /* the default */,`,
    `    f text COLLATE "My Schema"."Coll"`,
    `);`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);

  const t = model.tables[0];
  assert.ok(t !== undefined, 'the table imports');
  // Every spelling reads as written: qualified, quoted, mixed-case, and the dump's
  // DEFAULT-before-COLLATE order; whitespace runs collapse and comments drop.
  assert.deepEqual(
    t.columns.map((column) => column.collation),
    [
      'pg_catalog."C"',
      'probe77."User_C"',
      '"C"',
      'pg_catalog."C"',
      'c_lower',
      '"My Schema"."Coll"',
    ],
  );
  assert.deepEqual(diagnostics, []);
  // Boundaries hold in both orders: the DEFAULT and NOT NULL beside a COLLATE survive.
  assert.equal(t.columns[1]?.default, "'x'");
  assert.equal(t.columns[3]?.notNull, true);
});

test('reconstructs a collation from parsed name parts when no location is written', () => {
  const string = (sval: string) => ({ String: { sval } });
  assert.equal(
    extractCollationText('', { collname: [string('pg_catalog'), string('C')], location: -1 }, []),
    'pg_catalog."C"',
  );
  assert.equal(extractCollationText('', { collname: [string('c_lower')] }, []), 'c_lower');
  assert.equal(extractCollationText('', { collname: [] }, []), undefined);
});

test('reads inline storage and compression qualifiers as model words', async () => {
  const dump = [
    `CREATE TABLE public.t (`,
    `    a text STORAGE EXTERNAL COMPRESSION LZ4,`,
    `    b text STORAGE "plain",`,
    `    c text COMPRESSION pglz,`,
    `    d text STORAGE default,`,
    `    e text STORAGE sideways,`,
    `    f text COMPRESSION zstd,`,
    `    g text COMPRESSION default`,
    `);`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);

  const t = model.tables[0];
  assert.ok(t !== undefined, 'the table imports');
  // PostgreSQL matches storage words and compression methods case-insensitively.
  assert.equal(t.columns[0]?.storage, 'external');
  assert.equal(t.columns[0]?.compression, 'lz4');
  assert.equal(t.columns[1]?.storage, 'plain');
  assert.equal(t.columns[2]?.compression, 'pglz');
  // An explicit default is the model's absent value, not a flag; an unreadable word drops the
  // attribute and flags it.
  assert.equal('storage' in (t.columns[3] ?? {}), false);
  assert.equal('storage' in (t.columns[4] ?? {}), false);
  assert.equal('compression' in (t.columns[5] ?? {}), false);
  assert.equal('compression' in (t.columns[6] ?? {}), false);
  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.message),
    [
      'dropped storage on public.t.e from public.t',
      'dropped compression on public.t.f from public.t',
    ],
  );
});

test('applies post-data SET STORAGE and SET COMPRESSION to the column draft', async () => {
  const dump = [
    `CREATE TABLE public.t (a text, b text, c text, d text);`,
    `ALTER TABLE ONLY public.t ALTER COLUMN a SET STORAGE EXTERNAL;`,
    `ALTER TABLE ONLY public.t ALTER COLUMN b SET STORAGE MAIN;`,
    `ALTER TABLE ONLY public.t ALTER COLUMN c SET COMPRESSION pglz;`,
    `ALTER TABLE ONLY public.t ALTER COLUMN d SET COMPRESSION lz4;`,
    `ALTER TABLE ONLY public.t ALTER COLUMN d SET COMPRESSION default;`,
    `ALTER TABLE ONLY public.t ALTER COLUMN b SET STORAGE DEFAULT;`,
    `ALTER TABLE ONLY public.t ALTER COLUMN missing SET STORAGE EXTERNAL;`,
    `ALTER TABLE ONLY public.t ALTER COLUMN a SET COMPRESSION sideways;`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);

  const t = model.tables[0];
  assert.ok(t !== undefined, 'the table imports');
  assert.equal(t.columns[0]?.storage, 'external');
  assert.equal(t.columns[0]?.compression, undefined);
  assert.equal(t.columns[1]?.storage, undefined);
  assert.equal(t.columns[2]?.compression, 'pglz');
  assert.equal(t.columns[3]?.compression, undefined);
  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.message),
    [
      'skipped SET STORAGE for unknown column public.t.missing',
      'dropped compression on public.t.a from public.t',
    ],
  );
});

test('reads table persistence, flips it, and resets it on a repeated CREATE TABLE', async () => {
  const dump = [
    `CREATE UNLOGGED TABLE public.u (id integer);`,
    `CREATE TABLE public.l (id integer);`,
    `ALTER TABLE public.l SET UNLOGGED;`,
    `ALTER TABLE public.l SET LOGGED;`,
    `ALTER TABLE public.u SET LOGGED;`,
    `CREATE UNLOGGED TABLE public.m (id integer);`,
    `CREATE TABLE public.m (id integer);`,
    `CREATE TEMPORARY TABLE public.tmp (id integer);`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);

  const byName = new Map(model.tables.map((table) => [table.name, table]));
  // SET LOGGED clears the persisted fact; a repeated CREATE TABLE replaces the table
  // wholesale; temporary persists as a flag only (it is not modeled).
  assert.equal(byName.get('u')?.persistence, undefined);
  assert.equal(byName.get('l')?.persistence, undefined);
  assert.equal(byName.get('m')?.persistence, undefined);
  assert.equal(byName.get('tmp')?.persistence, undefined);
  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.message),
    ['dropped temporary-table persistence from public.tmp'],
  );
});

test('keeps column attributes through the generated not-null-name strip and DROP IDENTITY', async () => {
  const dump = [
    `CREATE TABLE public.t (`,
    `    a text CONSTRAINT t_a_not_null NOT NULL COLLATE "C",`,
    `    b bigint GENERATED ALWAYS AS IDENTITY`,
    `);`,
    `ALTER TABLE ONLY public.t ALTER COLUMN a SET STORAGE EXTERNAL;`,
    `ALTER TABLE ONLY public.t ALTER COLUMN b SET COMPRESSION lz4;`,
    `ALTER TABLE ONLY public.t ALTER COLUMN b DROP IDENTITY;`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);

  assert.deepEqual(diagnostics, []);
  const t = model.tables[0];
  assert.ok(t !== undefined, 'the table imports');
  const [a, b] = t.columns;
  assert.ok(a !== undefined && b !== undefined, 'both columns import');
  // The generated not-null name strips without taking the collation or storage with it.
  assert.equal('notNullName' in a, false);
  assert.equal(a.collation, '"C"');
  assert.equal(a.storage, 'external');
  // DROP IDENTITY drops the descriptor without taking the compression with it.
  assert.equal('identity' in b, false);
  assert.equal(b.notNull, true);
  assert.equal(b.compression, 'lz4');
});

test('reads the pg_dump attribute spellings captured live (PostgreSQL 16.15)', async () => {
  // Byte-for-byte shapes from the probe dump: CREATE UNLOGGED TABLE, a qualified pg_catalog
  // collation, a quoted user collation, DEFAULT before COLLATE in pg_dump's order, and the
  // post-data ALTER TABLE ONLY … SET STORAGE / SET COMPRESSION forms.
  const dump = [
    `CREATE UNLOGGED TABLE probe77.attrs (`,
    `    id integer NOT NULL,`,
    `    c_qualified text DEFAULT 'q'::text COLLATE pg_catalog."C",`,
    `    c_user text DEFAULT 'u'::text COLLATE probe77."User_C",`,
    `    s_ext text,`,
    `    s_main text,`,
    `    comp_pglz text`,
    `);`,
    `ALTER TABLE ONLY probe77.attrs ALTER COLUMN s_ext SET STORAGE EXTERNAL;`,
    `ALTER TABLE ONLY probe77.attrs ALTER COLUMN s_main SET STORAGE MAIN;`,
    `ALTER TABLE ONLY probe77.attrs ALTER COLUMN comp_pglz SET COMPRESSION pglz;`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);

  assert.deepEqual(diagnostics, []);
  assert.deepEqual(model.tables, [
    {
      schema: 'probe77',
      name: 'attrs',
      columns: [
        { name: 'id', type: 'integer', notNull: true },
        {
          name: 'c_qualified',
          type: 'text',
          notNull: false,
          default: "'q'::text",
          collation: 'pg_catalog."C"',
        },
        {
          name: 'c_user',
          type: 'text',
          notNull: false,
          default: "'u'::text",
          collation: 'probe77."User_C"',
        },
        { name: 's_ext', type: 'text', notNull: false, storage: 'external' },
        { name: 's_main', type: 'text', notNull: false, storage: 'main' },
        { name: 'comp_pglz', type: 'text', notNull: false, compression: 'pglz' },
      ],
      foreignKeys: [],
      uniqueConstraints: [],
      checkConstraints: [],
      indexes: [],
      persistence: 'unlogged',
    },
  ]);
});

test('imports plain views and materialized views, sorted by identity', async () => {
  const dump = [
    `CREATE VIEW public.upper AS SELECT 1 AS one;`,
    '',
    `CREATE MATERIALIZED VIEW app.totals AS`,
    ` SELECT team_id, count(*) AS n FROM app.t GROUP BY team_id WITH NO DATA;`,
    '',
    `CREATE VIEW app.plain AS`,
    ` SELECT a, b /* keep columns */, 'AS' AS label`,
    `   FROM app.t WHERE a <> 'x' AND b IS NOT NULL;`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);

  // The body is the source text after the top-level AS, whitespace-normalized: commas tighten,
  // comments drop, and a quoted 'AS' is body text, not the terminator. Views sort like tables.
  assert.deepEqual(model.views, [
    {
      schema: 'app',
      name: 'plain',
      materialized: false,
      definition: "SELECT a,b,'AS' AS label FROM app.t WHERE a <> 'x' AND b IS NOT NULL",
    },
    {
      schema: 'app',
      name: 'totals',
      materialized: true,
      definition: 'SELECT team_id,count(*) AS n FROM app.t GROUP BY team_id',
    },
    { schema: 'public', name: 'upper', materialized: false, definition: 'SELECT 1 AS one' },
  ]);
  assert.deepEqual(diagnostics, []);
});

test('reads view check options from the clause and from a check_option reloption', async () => {
  const dump = [
    `CREATE VIEW app.local AS SELECT id FROM app.t WITH LOCAL CHECK OPTION;`,
    `CREATE VIEW app.implicit AS SELECT id FROM app.t WITH CHECK OPTION;`,
    `CREATE VIEW app.option WITH (check_option='cascaded') AS SELECT id FROM app.t;`,
    `CREATE VIEW app.both WITH (check_option='cascaded') AS SELECT id FROM app.t WITH LOCAL CHECK OPTION;`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);

  // The clause wins over the reloption; a bare WITH CHECK OPTION is cascaded, as the engine
  // reads it. The overridden option is flagged, never silently dropped.
  assert.deepEqual(model.views, [
    {
      schema: 'app',
      name: 'both',
      materialized: false,
      definition: 'SELECT id FROM app.t',
      checkOption: 'local',
    },
    {
      schema: 'app',
      name: 'implicit',
      materialized: false,
      definition: 'SELECT id FROM app.t',
      checkOption: 'cascaded',
    },
    {
      schema: 'app',
      name: 'local',
      materialized: false,
      definition: 'SELECT id FROM app.t',
      checkOption: 'local',
    },
    {
      schema: 'app',
      name: 'option',
      materialized: false,
      definition: 'SELECT id FROM app.t',
      checkOption: 'cascaded',
    },
  ]);
  assert.deepEqual(diagnostics.map(describeDiagnostic), [
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'app.both',
      message: 'dropped view option check_option=cascaded from app.both',
    },
  ]);
});

test('flags every view reloption by name, still importing the view', async () => {
  const dump = [
    `CREATE VIEW app.options WITH (security_barrier, security_invoker=true, fillfactor=70, toast.autovacuum_enabled=false) AS SELECT id FROM app.t;`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);

  assert.deepEqual(model.views, [
    {
      schema: 'app',
      name: 'options',
      materialized: false,
      definition: 'SELECT id FROM app.t',
    },
  ]);
  assert.deepEqual(diagnostics.map(describeDiagnostic), [
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'app.options',
      message: 'dropped view option security_barrier from app.options',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'app.options',
      message: 'dropped view option security_invoker=true from app.options',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'app.options',
      message: 'dropped view option fillfactor=70 from app.options',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'app.options',
      message: 'dropped view option toast.autovacuum_enabled=false from app.options',
    },
  ]);
});

test('flags view and materialized-view column lists, keeping the views', async () => {
  const dump = [
    `CREATE VIEW app.columns (a, b) AS SELECT 1, 2;`,
    `CREATE MATERIALIZED VIEW app.mv_columns (a) AS SELECT 1 WITH NO DATA;`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);

  assert.deepEqual(model.views, [
    {
      schema: 'app',
      name: 'columns',
      materialized: false,
      definition: 'SELECT 1,2',
    },
    {
      schema: 'app',
      name: 'mv_columns',
      materialized: true,
      definition: 'SELECT 1',
    },
  ]);
  assert.deepEqual(diagnostics.map(describeDiagnostic), [
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'app.columns',
      message: 'dropped view column list from app.columns',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'app.mv_columns',
      message: 'dropped materialized view column list from app.mv_columns',
    },
  ]);
});

test('flags the materialized-view access method, tablespace, IF NOT EXISTS, and data clause', async () => {
  const dump = [
    `CREATE MATERIALIZED VIEW IF NOT EXISTS app.mv_flags (a) USING heap WITH (fillfactor=70, check_option='local') TABLESPACE pg_default AS SELECT 1 WITH DATA;`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);

  // The options are named but the view imports; a check option cannot travel on a materialized
  // view, so it stays a dropped option rather than a modeled field.
  assert.deepEqual(model.views, [
    {
      schema: 'app',
      name: 'mv_flags',
      materialized: true,
      definition: 'SELECT 1',
    },
  ]);
  assert.deepEqual(diagnostics.map(describeDiagnostic), [
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'app.mv_flags',
      message: 'dropped IF NOT EXISTS from app.mv_flags',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'app.mv_flags',
      message: 'dropped materialized view column list from app.mv_flags',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'app.mv_flags',
      message: 'dropped materialized view access method heap from app.mv_flags',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'app.mv_flags',
      message: 'dropped view option fillfactor=70 from app.mv_flags',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'app.mv_flags',
      message: 'dropped view option check_option=local from app.mv_flags',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'app.mv_flags',
      message: 'dropped materialized view tablespace pg_default from app.mv_flags',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'app.mv_flags',
      message: 'dropped WITH DATA from app.mv_flags',
    },
  ]);
});

test('distinguishes WITH NO DATA, WITH DATA, and the implicit populated state', async () => {
  const dump = [
    `CREATE MATERIALIZED VIEW app.mv_no_data AS SELECT 1 WITH NO DATA;`,
    `CREATE MATERIALIZED VIEW app.mv_data AS SELECT 'WITH DATA' AS note WITH DATA;`,
    `CREATE MATERIALIZED VIEW app.mv_none AS SELECT 1;`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);

  // The model has no populated state and render always writes WITH NO DATA: an explicit
  // WITH DATA and a clause-less (server-default populated) statement are both losses, with
  // distinct names. The body's quoted 'WITH DATA' is untouched.
  assert.deepEqual(model.views, [
    {
      schema: 'app',
      name: 'mv_data',
      materialized: true,
      definition: "SELECT 'WITH DATA' AS note",
    },
    { schema: 'app', name: 'mv_no_data', materialized: true, definition: 'SELECT 1' },
    { schema: 'app', name: 'mv_none', materialized: true, definition: 'SELECT 1' },
  ]);
  assert.deepEqual(diagnostics.map(describeDiagnostic), [
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'app.mv_data',
      message: 'dropped WITH DATA from app.mv_data',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'app.mv_none',
      message: 'dropped implicit populated state from app.mv_none',
    },
  ]);
});

test('flags non-default view and materialized-view persistence defensively', async () => {
  const dump = [
    `CREATE TEMP VIEW app.temp_view AS SELECT 1;`,
    `CREATE UNLOGGED VIEW app.unlogged_view AS SELECT 1;`,
    `CREATE UNLOGGED MATERIALIZED VIEW app.unlogged_mv AS SELECT 1;`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);

  // PostgreSQL rejects unlogged views and materialized views and pg_dump never emits temp
  // objects, so these forms only arrive hand-authored; they import as plain objects and the
  // dropped persistence is named rather than normalized away silently.
  assert.deepEqual(model.views, [
    { schema: 'app', name: 'temp_view', materialized: false, definition: 'SELECT 1' },
    { schema: 'app', name: 'unlogged_mv', materialized: true, definition: 'SELECT 1' },
    { schema: 'app', name: 'unlogged_view', materialized: false, definition: 'SELECT 1' },
  ]);
  assert.deepEqual(diagnostics.map(describeDiagnostic), [
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'app.temp_view',
      message: 'dropped temporary-view persistence from app.temp_view',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'app.unlogged_view',
      message: 'dropped unlogged-view persistence from app.unlogged_view',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'app.unlogged_mv',
      message: 'dropped unlogged-materialized-view persistence from app.unlogged_mv',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'app.unlogged_mv',
      message: 'dropped implicit populated state from app.unlogged_mv',
    },
  ]);
});

test('skips recursive views once, matching the keyword case and ignoring comments and quotes', async () => {
  const dump = [
    `CREATE RECURSIVE VIEW app.recursive_view (n) AS SELECT 1;`,
    `CREATE TEMP RECURSIVE VIEW app.temp_recursive_view (n) AS SELECT 1;`,
    `CREATE /* not recursive */ VIEW app.not_recursive AS SELECT 1;`,
    `CREATE VIEW app."Recursive" AS SELECT 1;`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);

  // The parser rewrites the form into a view-named recursive CTE with synthetic locations and
  // the raw body after AS omits the CTE, so it is skipped whole — once, even with TEMP, whose
  // persistence flag would otherwise also fire. A comment or quoted identifier never matches.
  assert.deepEqual(diagnostics.map(describeDiagnostic), [
    {
      kind: 'skip',
      code: 'unsupported-statement',
      object: 'app.recursive_view',
      message:
        'skipped CREATE RECURSIVE VIEW app.recursive_view (recursive views are not represented yet)',
    },
    {
      kind: 'skip',
      code: 'unsupported-statement',
      object: 'app.temp_recursive_view',
      message:
        'skipped CREATE RECURSIVE VIEW app.temp_recursive_view (recursive views are not represented yet)',
    },
  ]);
  assert.deepEqual(model.views, [
    { schema: 'app', name: 'Recursive', materialized: false, definition: 'SELECT 1' },
    { schema: 'app', name: 'not_recursive', materialized: false, definition: 'SELECT 1' },
  ]);
});

test('keeps the last definition of a repeated view, including the loop-repair CREATE OR REPLACE', async () => {
  const dump = [
    `CREATE VIEW app.loop AS SELECT 1 AS a;`,
    `CREATE OR REPLACE VIEW app.loop AS SELECT 1 AS a, 2 AS b;`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);

  // pg_dump emits a dummy CREATE VIEW and a post-data CREATE OR REPLACE VIEW to break a
  // dependency loop; the import holds one view and the last definition wins.
  assert.deepEqual(model.views, [
    {
      schema: 'app',
      name: 'loop',
      materialized: false,
      definition: 'SELECT 1 AS a,2 AS b',
    },
  ]);
  assert.deepEqual(diagnostics, []);
});

test('lets a repeated identity change kind, last definition winning', async () => {
  const dump = [
    `CREATE MATERIALIZED VIEW app.kind AS SELECT 1;`,
    `CREATE VIEW app.kind AS SELECT 2;`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);

  // A duplicate with a different materialized flag is an invalid dump; overwrite keeps the
  // model single-valued. The first statement's populated-state loss is still reported.
  assert.deepEqual(model.views, [
    { schema: 'app', name: 'kind', materialized: false, definition: 'SELECT 2' },
  ]);
  assert.deepEqual(diagnostics.map(describeDiagnostic), [
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'app.kind',
      message: 'dropped implicit populated state from app.kind',
    },
  ]);
});

test('extracts view bodies past comments, quotes, dollar quotes, CTEs, and non-ASCII text', async () => {
  const dump = [
    `CREATE VIEW app.cte AS WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t WHERE n < 3) SELECT n FROM t;`,
    `CREATE VIEW app.quoted AS SELECT (a + 1) AS "AS" FROM app.t;`,
    `CREATE VIEW app.dollar AS SELECT a, (b + 1) AS c, $$WITH NO DATA$$ AS d, $tag$ ? AS ? $tag$ AS e FROM app.t;`,
    `/* café */ CREATE VIEW app.utf8 AS SELECT 'é' AS e;`,
    `CREATE MATERIALIZED VIEW app.mv_literal AS SELECT 'WITH NO DATA' AS note WITH NO DATA;`,
    `CREATE MATERIALIZED VIEW app.mv_ord AS SELECT * FROM generate_series(1, 2) WITH ORDINALITY WITH NO DATA;`,
    `CREATE VIEW app.ord_view AS SELECT * FROM generate_series(1, 2) WITH ORDINALITY;`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);

  assert.deepEqual(model.views, [
    {
      schema: 'app',
      name: 'cte',
      materialized: false,
      definition:
        'WITH RECURSIVE t(n) AS(SELECT 1 UNION ALL SELECT n + 1 FROM t WHERE n < 3) SELECT n FROM t',
    },
    {
      schema: 'app',
      name: 'dollar',
      materialized: false,
      definition: 'SELECT a,(b + 1) AS c,$$WITH NO DATA$$ AS d,$tag$ ? AS ? $tag$ AS e FROM app.t',
    },
    {
      schema: 'app',
      name: 'mv_literal',
      materialized: true,
      definition: "SELECT 'WITH NO DATA' AS note",
    },
    {
      schema: 'app',
      name: 'mv_ord',
      materialized: true,
      definition: 'SELECT * FROM generate_series(1,2) WITH ORDINALITY',
    },
    {
      schema: 'app',
      name: 'ord_view',
      materialized: false,
      definition: 'SELECT * FROM generate_series(1,2) WITH ORDINALITY',
    },
    {
      schema: 'app',
      name: 'quoted',
      materialized: false,
      definition: 'SELECT(a + 1) AS "AS" FROM app.t',
    },
    { schema: 'app', name: 'utf8', materialized: false, definition: "SELECT 'é' AS e" },
  ]);
  assert.deepEqual(diagnostics, []);
});

test('skips a materialized view index as a table that was not imported', async () => {
  const dump = [
    `CREATE MATERIALIZED VIEW app.mv AS SELECT 1 AS a WITH NO DATA;`,
    `CREATE UNIQUE INDEX mv_a_idx ON app.mv USING btree (a);`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);

  // Matview indexes are not modeled in this slice and the matview is not a table draft, so the
  // existing missing-table skip names it without manufacturing a phantom table.
  assert.deepEqual(model.tables, []);
  assert.deepEqual(model.views, [
    { schema: 'app', name: 'mv', materialized: true, definition: 'SELECT 1 AS a' },
  ]);
  assert.deepEqual(diagnostics.map(describeDiagnostic), [
    {
      kind: 'skip',
      code: 'unsupported-statement',
      object: 'mv_a_idx',
      message: 'skipped CREATE INDEX mv_a_idx (table not imported)',
    },
  ]);
});

test('flags WITHOUT OVERLAPS on a primary key and imports the plain key', async () => {
  const dump = [
    `CREATE TABLE public.t (id integer, during tsrange);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_pkey PRIMARY KEY (id, during WITHOUT OVERLAPS);`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const table = model.tables.find((candidate) => candidate.name === 't');
  assert.ok(table, 'the table is imported');

  // The temporal attribute is dropped and the plain key imports; `t_pkey` is PostgreSQL's
  // conventional primary-key name, so it canonicalizes back to unnamed as it does without the
  // attribute.
  assert.deepEqual(table.primaryKey, { columns: ['id', 'during'] });
  assert.deepEqual(diagnostics.map(describeDiagnostic), [
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.t',
      message: 'dropped WITHOUT OVERLAPS on primary key t_pkey from public.t',
    },
  ]);
});

test('flags WITHOUT OVERLAPS on a unique constraint and imports the plain key', async () => {
  const dump = [
    `CREATE TABLE public.t (id integer, during tsrange);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT u_period UNIQUE (id, during WITHOUT OVERLAPS);`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const table = model.tables.find((candidate) => candidate.name === 't');
  assert.ok(table, 'the table is imported');

  assert.deepEqual(table.uniqueConstraints, [{ name: 'u_period', columns: ['id', 'during'] }]);
  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.message),
    ['dropped WITHOUT OVERLAPS on unique constraint u_period from public.t'],
  );
});

test('flags PERIOD once per foreign key, whichever side carries it', async () => {
  const dump = [
    `CREATE TABLE public.p (id integer, during tsrange);`,
    `CREATE TABLE public.t (a integer, b integer);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT f_period_ref FOREIGN KEY (a, PERIOD b) REFERENCES public.p (id);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT f_period_target FOREIGN KEY (a) REFERENCES public.p (id, PERIOD during);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT f_period_both FOREIGN KEY (a, PERIOD b) REFERENCES public.p (id, PERIOD during);`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const table = model.tables.find((candidate) => candidate.name === 't');
  assert.ok(table, 'the table is imported');

  const foreignKey = (name: string) =>
    table.foreignKeys.find((candidate) => candidate.name === name);
  assert.deepEqual(foreignKey('f_period_ref')?.columns, ['a', 'b']);
  assert.deepEqual(foreignKey('f_period_ref')?.referencedColumns, ['id']);
  assert.deepEqual(foreignKey('f_period_target')?.columns, ['a']);
  assert.deepEqual(foreignKey('f_period_target')?.referencedColumns, ['id', 'during']);
  assert.deepEqual(foreignKey('f_period_both')?.columns, ['a', 'b']);
  assert.deepEqual(foreignKey('f_period_both')?.referencedColumns, ['id', 'during']);

  // A period on either side, or on both, is one dropped attribute, never two.
  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.message),
    [
      'dropped PERIOD on foreign key f_period_ref from public.t',
      'dropped PERIOD on foreign key f_period_target from public.t',
      'dropped PERIOD on foreign key f_period_both from public.t',
    ],
  );
});

test('flags NO INHERIT on a not-null constraint in every shape', async () => {
  const dump = [
    `CREATE TABLE public.nn (a integer NOT NULL NO INHERIT);`,
    `CREATE TABLE public.named (a integer, CONSTRAINT nn_a NOT NULL a NO INHERIT);`,
    `CREATE TABLE public.altered (a integer);`,
    `ALTER TABLE ONLY public.altered ADD CONSTRAINT nn_a NOT NULL a NO INHERIT;`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const columnsOf = (name: string) => {
    const table = model.tables.find((candidate) => candidate.name === name);
    assert.ok(table, `table ${name} is imported`);
    return table.columns;
  };

  // The not-null fact survives every shape; the inheritance attribute is the dropped part.
  assert.deepEqual(columnsOf('nn'), [{ name: 'a', type: 'integer', notNull: true }]);
  assert.deepEqual(columnsOf('named'), [
    { name: 'a', type: 'integer', notNull: true, notNullName: 'nn_a' },
  ]);
  assert.deepEqual(columnsOf('altered'), [
    { name: 'a', type: 'integer', notNull: true, notNullName: 'nn_a' },
  ]);

  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.message),
    [
      'dropped NO INHERIT on not-null constraint from public.nn',
      'dropped NO INHERIT on not-null constraint nn_a from public.named',
      'dropped NO INHERIT on not-null constraint nn_a from public.altered',
    ],
  );
});

test('reads unnamed temporal and inheritance forms with the bare constraint kind', async () => {
  const dump = [
    `CREATE TABLE public.p (id integer, during tsrange);`,
    `CREATE TABLE public.t (a integer, b integer, PRIMARY KEY (a, b WITHOUT OVERLAPS), UNIQUE (a, b WITHOUT OVERLAPS), FOREIGN KEY (a, PERIOD b) REFERENCES public.p (id));`,
    `CREATE TABLE public.nn (a integer NOT NULL NO INHERIT);`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const table = model.tables.find((candidate) => candidate.name === 't');
  assert.ok(table, 'the table is imported');

  // Unnamed PK and unique constraints read the bare kind; the unnamed foreign key keeps the
  // builder's `on <identity>` label.
  assert.deepEqual(table.primaryKey, { columns: ['a', 'b'] });
  assert.deepEqual(table.uniqueConstraints, [{ columns: ['a', 'b'] }]);
  assert.deepEqual(
    table.foreignKeys.map((foreignKey) => ({
      name: foreignKey.name,
      columns: foreignKey.columns,
    })),
    [{ name: undefined, columns: ['a', 'b'] }],
  );

  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.message),
    [
      'dropped WITHOUT OVERLAPS on primary key from public.t',
      'dropped WITHOUT OVERLAPS on unique constraint from public.t',
      'dropped PERIOD on foreign key on public.t from public.t',
      'dropped NO INHERIT on not-null constraint from public.nn',
    ],
  );
});

test('orders the temporal and inheritance flags with the constraint they drop from', async () => {
  const dump = [
    `CREATE TABLE public.p (id integer, during tsrange);`,
    `CREATE TABLE public.t (id integer, during tsrange, a integer, b integer, CONSTRAINT t_a_nn NOT NULL a);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_pkey PRIMARY KEY (id, during WITHOUT OVERLAPS);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_pkey_dup PRIMARY KEY (id, during WITHOUT OVERLAPS);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT u_period UNIQUE NULLS NOT DISTINCT (id, during WITHOUT OVERLAPS) INCLUDE (a);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT f_period FOREIGN KEY (a, PERIOD b) REFERENCES public.p (id, PERIOD during);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_other NOT NULL a NO INHERIT;`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const table = model.tables.find((candidate) => candidate.name === 't');
  assert.ok(table, 'the table is imported');

  // The duplicate primary key keeps the first declaration; its attribute flag precedes the
  // `additional primary key` flag the attach path adds.
  assert.deepEqual(table.primaryKey, { columns: ['id', 'during'] });

  assert.deepEqual(diagnostics.map(describeDiagnostic), [
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
      message: 'dropped WITHOUT OVERLAPS on primary key t_pkey_dup from public.t',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.t',
      message: 'dropped additional primary key from public.t',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.t',
      message: 'dropped NULLS NOT DISTINCT on unique constraint u_period from public.t',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.t',
      message: 'dropped INCLUDE on unique constraint u_period from public.t',
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
      message: 'dropped PERIOD on foreign key f_period from public.t',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.t',
      message: 'dropped additional not-null constraint on public.t.a from public.t',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.t',
      message: 'dropped NO INHERIT on not-null constraint t_other from public.t',
    },
  ]);
});

test('flags NO INHERIT beside a not-null merge conflict', async () => {
  // Two real names for one not-null fact: the merge keeps the first and reports the conflict,
  // and the inheritance attribute is dropped either way, after the conflict flag.
  const dump = [
    `CREATE TABLE public.t (a integer CONSTRAINT t_a_nn NOT NULL, CONSTRAINT t_other NOT NULL a NO INHERIT);`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const table = model.tables.find((candidate) => candidate.name === 't');
  assert.ok(table, 'the table is imported');

  assert.deepEqual(table.columns, [
    { name: 'a', type: 'integer', notNull: true, notNullName: 't_a_nn' },
  ]);
  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.message),
    [
      'dropped additional not-null constraint on public.t.a from public.t',
      'dropped NO INHERIT on not-null constraint t_other from public.t',
    ],
  );
});

test('flags NO INHERIT beside an inline not-null merge conflict', async () => {
  // Two real inline names for one not-null fact: the merge keeps the first and reports the
  // conflict, and the inline inheritance attribute is dropped either way, after the conflict
  // flag — the inline twin of the table-level case above.
  const dump = [
    `CREATE TABLE public.t (a integer CONSTRAINT t_a_nn NOT NULL CONSTRAINT t_other NOT NULL NO INHERIT);`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const table = model.tables.find((candidate) => candidate.name === 't');
  assert.ok(table, 'the table is imported');

  assert.deepEqual(table.columns, [
    { name: 'a', type: 'integer', notNull: true, notNullName: 't_a_nn' },
  ]);
  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.message),
    [
      'dropped additional not-null constraint on public.t.a from public.t',
      'dropped NO INHERIT on not-null constraint t_other from public.t',
    ],
  );
});

test('drops temporal and inheritance forms whole, leaving the same model', async () => {
  const withForms = [
    `CREATE TABLE public.p (id integer, during tsrange);`,
    `CREATE TABLE public.t (id integer, during tsrange, a integer, CONSTRAINT t_pkey PRIMARY KEY (id, during WITHOUT OVERLAPS), CONSTRAINT u_period UNIQUE (id, during WITHOUT OVERLAPS), CONSTRAINT f_period FOREIGN KEY (a, PERIOD during) REFERENCES public.p (id, PERIOD during), CONSTRAINT nn_a NOT NULL a NO INHERIT);`,
  ].join('\n');
  const withoutForms = [
    `CREATE TABLE public.p (id integer, during tsrange);`,
    `CREATE TABLE public.t (id integer, during tsrange, a integer, CONSTRAINT t_pkey PRIMARY KEY (id, during), CONSTRAINT u_period UNIQUE (id, during), CONSTRAINT f_period FOREIGN KEY (a, during) REFERENCES public.p (id, during), CONSTRAINT nn_a NOT NULL a);`,
  ].join('\n');

  const { model: withModel, diagnostics } = await importDump(withForms);
  const { model: withoutModel } = await importDump(withoutForms);

  assert.deepEqual(diff(withModel, withoutModel), []);
  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.message),
    [
      'dropped WITHOUT OVERLAPS on primary key t_pkey from public.t',
      'dropped WITHOUT OVERLAPS on unique constraint u_period from public.t',
      'dropped PERIOD on foreign key f_period from public.t',
      'dropped NO INHERIT on not-null constraint nn_a from public.t',
    ],
  );
});

test('imports comments on every modeled family, including synthesized names', async () => {
  // The constraints and the index are declared unnamed (or with their conventional names), so
  // each comment resolves against the server form the importer would synthesize, and stays on
  // the node after canonicalization strips the name.
  const dump = [
    `CREATE SEQUENCE public.s;`,
    `CREATE TABLE public.t (`,
    `    id bigint PRIMARY KEY,`,
    `    a integer UNIQUE,`,
    `    b integer,`,
    `    CONSTRAINT t_b_check CHECK (b > 0)`,
    `);`,
    `ALTER TABLE ONLY public.t ADD CONSTRAINT t_b_fkey FOREIGN KEY (b) REFERENCES public.other(id);`,
    `CREATE TABLE public.other (id bigint PRIMARY KEY);`,
    `CREATE INDEX t_b_idx ON public.t USING btree (b);`,
    `CREATE VIEW public.v AS SELECT 1;`,
    `CREATE MATERIALIZED VIEW public.mv AS SELECT 1 WITH NO DATA;`,
    `COMMENT ON TABLE public.t IS 'table';`,
    `COMMENT ON COLUMN public.t.a IS 'column';`,
    `COMMENT ON SEQUENCE public.s IS 'sequence';`,
    `COMMENT ON VIEW public.v IS 'view';`,
    `COMMENT ON MATERIALIZED VIEW public.mv IS 'matview';`,
    `COMMENT ON INDEX t_b_idx IS 'index';`,
    `COMMENT ON CONSTRAINT t_pkey ON public.t IS 'primary';`,
    `COMMENT ON CONSTRAINT t_a_key ON public.t IS 'unique';`,
    `COMMENT ON CONSTRAINT t_b_check ON public.t IS 'check';`,
    `COMMENT ON CONSTRAINT t_b_fkey ON public.t IS 'foreign';`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const table = model.tables.find((candidate) => candidate.name === 't');
  assert.ok(table, 'the table is imported');
  assert.deepEqual(diagnostics, []);

  assert.equal(table.comment, 'table');
  assert.equal(table.columns.find((column) => column.name === 'a')?.comment, 'column');
  assert.deepEqual(table.primaryKey, { columns: ['id'], comment: 'primary' });
  assert.deepEqual(table.uniqueConstraints, [{ columns: ['a'], comment: 'unique' }]);
  assert.deepEqual(table.checkConstraints, [{ expression: 'b > 0', comment: 'check' }]);
  assert.deepEqual(table.foreignKeys, [
    {
      columns: ['b'],
      referencedTable: { schema: 'public', name: 'other' },
      referencedColumns: ['id'],
      comment: 'foreign',
    },
  ]);
  assert.deepEqual(table.indexes, [{ unique: false, columns: ['b'], comment: 'index' }]);

  assert.equal(model.sequences[0]?.comment, 'sequence');
  assert.deepEqual(
    model.views.map((view) => `${view.name}:${String(view.comment)}`),
    ['mv:matview', 'v:view'],
  );
});

test('defaults unqualified comment targets to public and flags an under-qualified column', async () => {
  const dump = [
    `CREATE TABLE public.t (a integer);`,
    `CREATE SEQUENCE public.s;`,
    `CREATE VIEW public.v AS SELECT 1;`,
    `COMMENT ON TABLE t IS 'table';`,
    `COMMENT ON SEQUENCE s IS 'sequence';`,
    `COMMENT ON VIEW v IS 'view';`,
    `COMMENT ON COLUMN t.a IS 'column';`,
    `COMMENT ON COLUMN a IS 'lost';`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  assert.equal(model.tables[0]?.comment, 'table');
  assert.equal(model.tables[0]?.columns[0]?.comment, 'column');
  assert.equal(model.sequences[0]?.comment, 'sequence');
  assert.equal(model.views[0]?.comment, 'view');
  assert.deepEqual(diagnostics.map(describeDiagnostic), [
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'a',
      message: 'dropped comment from a',
    },
  ]);
});

test("clears a comment on IS NULL and on IS ''", async () => {
  const dump = [
    `CREATE TABLE public.t (a integer, b integer);`,
    `COMMENT ON TABLE public.t IS 'gone';`,
    `COMMENT ON COLUMN public.t.a IS 'gone';`,
    `COMMENT ON TABLE public.t IS NULL;`,
    `COMMENT ON COLUMN public.t.a IS '';`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const table = model.tables[0];
  assert.ok(table, 'the table is imported');
  assert.deepEqual(diagnostics, []);
  assert.equal('comment' in table, false);
  assert.equal('comment' in table.columns[0]!, false);
});

test('flags every comment target the import cannot resolve, keeping skips for unmodeled families', async () => {
  const dump = [
    `CREATE TABLE public.t (a integer);`,
    `CREATE SEQUENCE public.s;`,
    `CREATE VIEW public.v AS SELECT 1;`,
    `CREATE MATERIALIZED VIEW public.mv AS SELECT 1 WITH NO DATA;`,
    `CREATE INDEX t_a_idx ON public.t USING btree (a);`,
    `COMMENT ON TABLE public.missing IS 'x';`,
    `COMMENT ON COLUMN public.t.missing IS 'x';`,
    `COMMENT ON COLUMN public.v.c IS 'x';`,
    `COMMENT ON SEQUENCE public.missing IS 'x';`,
    `COMMENT ON VIEW public.missing IS 'x';`,
    `COMMENT ON VIEW public.mv IS 'x';`,
    `COMMENT ON MATERIALIZED VIEW public.v IS 'x';`,
    `COMMENT ON INDEX public.missing IS 'x';`,
    `COMMENT ON CONSTRAINT missing ON public.t IS 'x';`,
    `COMMENT ON SCHEMA public IS '';`,
    `COMMENT ON FOREIGN TABLE public.ft IS 'x';`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  assert.deepEqual(diagnostics.map(describeDiagnostic), [
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.missing',
      message: 'dropped comment from public.missing',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.t.missing',
      message: 'dropped comment from public.t.missing',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.v.c',
      message: 'dropped comment from public.v.c',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.missing',
      message: 'dropped comment from public.missing',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.missing',
      message: 'dropped comment from public.missing',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.mv',
      message: 'dropped comment from public.mv',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.v',
      message: 'dropped comment from public.v',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.missing',
      message: 'dropped comment from public.missing',
    },
    {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: 'public.t.missing',
      message: 'dropped comment from public.t.missing',
    },
    {
      kind: 'skip',
      code: 'unsupported-statement',
      object: 'public',
      message: 'skipped COMMENT ON SCHEMA public',
    },
    {
      kind: 'skip',
      code: 'unsupported-statement',
      object: 'public.ft',
      message: 'skipped COMMENT ON FOREIGN TABLE public.ft',
    },
  ]);

  // A flagged comment is never stored anywhere.
  const table = model.tables[0];
  assert.ok(table, 'the table is imported');
  assert.equal('comment' in table, false);
  assert.deepEqual(table.columns, [{ name: 'a', type: 'integer', notNull: false }]);
});

test('flags not-null comments with the deferral wording, after the constraint slots', async () => {
  const dump = [
    `CREATE TABLE public.t (`,
    `    a integer CONSTRAINT a_nn NOT NULL,`,
    `    b integer NOT NULL,`,
    `    c integer NOT NULL,`,
    `    CONSTRAINT t_b_not_null CHECK (b > 0)`,
    `);`,
    `COMMENT ON CONSTRAINT a_nn ON public.t IS 'x';`,
    `COMMENT ON CONSTRAINT t_c_not_null ON public.t IS 'x';`,
    `COMMENT ON CONSTRAINT t_b_not_null ON public.t IS 'x';`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const table = model.tables.find((candidate) => candidate.name === 't');
  assert.ok(table, 'the table is imported');

  // The explicit check name wins over column b's generated not-null name: constraint slots are
  // searched before the columns' not-null facts. The stored custom name and the generated name
  // both take the deferral's wording.
  assert.deepEqual(table.checkConstraints, [
    { name: 't_b_not_null', expression: 'b > 0', comment: 'x' },
  ]);
  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.message),
    [
      'dropped comment on a not-null constraint from public.t.a_nn',
      'dropped comment on a not-null constraint from public.t.t_c_not_null',
    ],
  );
});

test('keeps the last repeated comment on every modeled family', async () => {
  const dump = [
    `CREATE TABLE public.t (a integer UNIQUE);`,
    `CREATE SEQUENCE public.s;`,
    `CREATE VIEW public.v AS SELECT 1;`,
    `CREATE INDEX t_a_idx ON public.t USING btree (a);`,
    `COMMENT ON TABLE public.t IS 'first';`,
    `COMMENT ON TABLE public.t IS 'second';`,
    `COMMENT ON COLUMN public.t.a IS 'first';`,
    `COMMENT ON COLUMN public.t.a IS 'second';`,
    `COMMENT ON SEQUENCE public.s IS 'first';`,
    `COMMENT ON SEQUENCE public.s IS 'second';`,
    `COMMENT ON VIEW public.v IS 'first';`,
    `COMMENT ON VIEW public.v IS 'second';`,
    `COMMENT ON CONSTRAINT t_a_key ON public.t IS 'first';`,
    `COMMENT ON CONSTRAINT t_a_key ON public.t IS 'second';`,
    `COMMENT ON INDEX t_a_idx IS 'first';`,
    `COMMENT ON INDEX t_a_idx IS 'second';`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const table = model.tables.find((candidate) => candidate.name === 't');
  assert.ok(table, 'the table is imported');
  assert.deepEqual(diagnostics, []);
  assert.equal(table.comment, 'second');
  assert.equal(table.columns[0]?.comment, 'second');
  assert.deepEqual(table.uniqueConstraints, [{ columns: ['a'], comment: 'second' }]);
  assert.deepEqual(table.indexes, [{ unique: false, columns: ['a'], comment: 'second' }]);
  assert.equal(model.sequences[0]?.comment, 'second');
  assert.equal(model.views[0]?.comment, 'second');
});

test('clears table, sequence, and view comments when a create is repeated', async () => {
  const dump = [
    `CREATE TABLE public.t (a integer);`,
    `COMMENT ON TABLE public.t IS 'gone';`,
    `CREATE TABLE public.t (b integer);`,
    `CREATE SEQUENCE public.s;`,
    `COMMENT ON SEQUENCE public.s IS 'gone';`,
    `CREATE SEQUENCE public.s START WITH 5;`,
    `CREATE VIEW public.v AS SELECT 1;`,
    `COMMENT ON VIEW public.v IS 'gone';`,
    `CREATE OR REPLACE VIEW public.v AS SELECT 2;`,
  ].join('\n');

  const { model, diagnostics } = await importDump(dump);
  const table = model.tables.find((candidate) => candidate.name === 't');
  assert.ok(table, 'the table is imported');
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(
    table.columns.map((column) => column.name),
    ['b'],
  );
  assert.equal('comment' in table, false);
  assert.equal(model.sequences[0]?.start, '5');
  assert.equal('comment' in (model.sequences[0] ?? {}), false);
  assert.equal(model.views[0]?.definition, 'SELECT 2');
  assert.equal('comment' in (model.views[0] ?? {}), false);
});

test('refuses a comment carrying NUL before it can reach the model', () => {
  // libpg-query rejects a NUL byte in a string literal at parse time, so the guard cannot be
  // reached through DDL; the store seam is the door a future non-DDL producer would pass through.
  const position = { offset: 0, line: 1, column: 1 };
  const statement: ParsedStatement = { sql: '', start: position, end: position, result: {} };
  const diagnostics: Parameters<typeof storeComment>[4] = [];
  const stored: (string | undefined)[] = [];

  storeComment(statement, 'public.t', 'a\u0000b', (text) => stored.push(text), diagnostics);
  assert.equal(stored.length, 0);
  assert.deepEqual(
    diagnostics.map((entry) => entry.diagnostic),
    [
      {
        kind: 'flag',
        code: 'unsupported-attribute',
        object: 'public.t',
        message: 'dropped comment from public.t',
        position,
      },
    ],
  );

  // An ordinary text stores, and an absent one reaches the store as a clear.
  storeComment(statement, 'public.t', 'plain', (text) => stored.push(text), diagnostics);
  storeComment(statement, 'public.t', undefined, (text) => stored.push(text), diagnostics);
  assert.deepEqual(stored, ['plain', undefined]);
  assert.equal(diagnostics.length, 1);
});

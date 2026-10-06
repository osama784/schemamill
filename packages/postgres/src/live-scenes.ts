import { effectiveIdentity, effectiveSequence } from '@schemamill/core';
import type {
  CheckConstraint,
  Column,
  Diagnostic,
  ForeignKey,
  Identity,
  IdentityInput,
  Index,
  Model,
  Plan,
  PrimaryKey,
  ReadResult,
  Sequence,
  SequenceDataType,
  SequenceIdentity,
  SequenceOwner,
  Step,
  Table,
  TableIdentity,
  UniqueConstraint,
} from '@schemamill/core';

/**
 * Scenes for the live-PostgreSQL harness (`live-pg.test.ts`).
 *
 * Each scene pairs a baseline and a target model that the harness takes through a full round
 * trip: build the baseline database, build the target database from its own model, apply
 * `renderSql(plan(baseline, target))` to the baseline database, then dump and import both and
 * compare. The five golden scenes carry the catalog spot-checks ported from the first slice's
 * scratch evidence runs; the harness reads them in phases: `baselineChecks` after the baseline
 * build, then `probes` and `checks` after the migration, in that order.
 *
 * The regression scenes are the shapes that caught real ordering bugs while the first slice
 * was built: table-removal cycles (`twocycle`, `smallvictim`), a primary key that changes
 * under a surviving foreign key (`r1a`-`r1d`), a dropped primary key or column that a removed
 * table still references (`pkdrop-removedref`, `coldrop-removedref`), and unnamed constraints
 * dropped under the conventional names PostgreSQL gives them (`unnamed-drop`, `unnamed-kept`).
 * Two more close the review's corpus gaps: a column whose only change is its default
 * (`default-change`) and a kept table gaining a primary key (`primary-key-add`).
 *
 * The sequence scenes cover the shapes the sequences slice was built for, against a live
 * server: a new table with a new owned sequence-backed default whose ownership and generated
 * keys are checked (`serial-create`), standalone sequences added and removed
 * (`sequence-add-drop`), option alters including the `AS` bound reset
 * (`sequence-alter`), owner drops with detach-before-drop and drop suppression
 * (`owner-drop-order`), and a default drop ordered before the sequence drop it releases
 * (`detached-drop`).
 *
 * The identity scenes cover the shapes the identity slice was built for: new tables with
 * `GENERATED … AS IDENTITY` columns whose descriptors, dependencies, and generated keys are
 * checked (`identity-create`), one multi-clause `SET` that flips the generation mode and
 * rewrites every option (`identity-alter`), identity removal three ways — `DROP IDENTITY`
 * keeping the column and its `NOT NULL`, a dropped identity column, and a dropped identity
 * table, the last two cascading their implicit sequences without a `drop-sequence` step
 * (`identity-drop`) — and both conversions between an identity and an owned `nextval` default
 * reusing the same sequence name (`identity-to-sequence`, `sequence-to-identity`).
 *
 * The constraint and index scenes cover this slice's shapes: named and unnamed primary-key,
 * unique, foreign-key, and check constraints on a new table (`constraint-create`), a plain and
 * a unique standalone
 * index beside a partial and an expression index the model cannot declare (`index-create`),
 * a multi-group migration whose standalone `CREATE INDEX CONCURRENTLY` sits between
 * transactional steps (`index-concurrently`), a target whose unnamed single-column,
 * multi-column, and concurrent indexes are server-named on apply and canonicalized back to
 * unnamed on import (`unnamed-index-round-trip`), and a non-public-schema index drop whose
 * schema qualification is real only because the scene's setup SQL creates the `app` schema
 * (`non-public-index-drop`).
 *
 * Every primary-key column is marked `NOT NULL`, as a real `pg_dump` reports it: PostgreSQL
 * sets `attnotnull` when it creates a primary key, and dropping the key leaves the attribute
 * in place — a model that says otherwise would make the migrated database legitimately differ
 * from the database built from the target.
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
  uniqueConstraints?: readonly UniqueConstraint[];
  checkConstraints?: readonly CheckConstraint[];
  indexes?: readonly Index[];
}

/** A table with the given identity: empty unless parts are supplied. */
const table = (name: string, parts: TableParts = {}): Table => ({
  schema: parts.schema ?? 'public',
  name,
  columns: parts.columns ?? [],
  ...(parts.primaryKey === undefined ? {} : { primaryKey: parts.primaryKey }),
  foreignKeys: parts.foreignKeys ?? [],
  uniqueConstraints: parts.uniqueConstraints ?? [],
  checkConstraints: parts.checkConstraints ?? [],
  indexes: parts.indexes ?? [],
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

/** A model of the given tables and sequences together. */
const withSequences = (tables: readonly Table[], sequences: readonly Sequence[]): Model => ({
  tables,
  sequences,
});

/** A sequence named `name`: the effective defaults for its stated options. */
const sequence = (name: string, fields: Partial<Omit<Sequence, 'name'>> = {}): Sequence =>
  effectiveSequence({ schema: 'public', name, ...fields });

/** The owner link for a sequence: `tableName.columnName`, `public` unless overridden. */
const sequenceOwner = (
  tableName: string,
  columnName: string,
  schema = 'public',
): SequenceOwner => ({
  table: identity(tableName, schema),
  column: columnName,
});

/** A schema-qualified sequence identity: `public` unless another schema is given. */
const sequenceIdentity = (name: string, schema = 'public'): SequenceIdentity => ({
  schema,
  name,
});

/** An effective identity descriptor for `dataType`, `GENERATED ALWAYS` unless overridden. */
const identityColumn = (
  dataType: SequenceDataType,
  fields: Partial<IdentityInput> = {},
): Identity => effectiveIdentity(dataType, { generated: 'always', ...fields });

/** One catalog fact: `sql` is read with `psql -tA` and compared exactly to `expected`. */
export interface SceneCheck {
  readonly description: string;
  readonly sql: string;
  readonly expected: string;
}

/**
 * One plan fact: `failure` reads the migration plan's steps — and the plan itself, for facts
 * about its transaction groups — and returns what is wrong, or `undefined` when the plan is
 * right. Plan facts are asserted before any SQL runs — they pin what the plan does, which the
 * live round trip alone cannot name, such as a step the plan must not emit because a cascade
 * would make it redundant, or the standalone group a concurrent statement must stand in.
 */
export interface ScenePlanCheck {
  readonly description: string;
  readonly failure: (steps: readonly Step[], plan: Plan) => string | undefined;
}

/**
 * One import fact: `failure` reads an import's model and diagnostics — and which database's
 * dump it came from — and returns what is wrong, or `undefined` when the import is right.
 * Import facts are asserted after both dumps are imported. They pin what the live round trip
 * alone cannot name: facts about the model an import produces, such as a constraint-backed
 * index that must not be double-modeled as a standalone `Index`, or a skip the import must
 * report by name.
 */
export interface SceneImportCheck {
  readonly description: string;
  readonly failure: (
    imported: ReadResult<Model, Diagnostic>,
    source: 'applied' | 'target',
  ) => string | undefined;
}

/** One scene of the live-PostgreSQL harness. */
export interface LiveScene {
  /** Stable scene name; the harness derives its database names from it. */
  readonly name: string;
  /** The model the baseline database is built from. */
  readonly baseline: Model;
  /** The model the target database is built from and the migration aims at. */
  readonly target: Model;
  /**
   * Raw SQL applied to both databases right after they are created and before their builds,
   * for ambient state a model cannot declare, such as the non-public schema whose tables a
   * scene qualifies.
   */
  readonly setupSql?: string;
  /**
   * Raw SQL appended to the target database's build, for objects the model cannot declare,
   * such as a partial or expression index. The plan, built from the model, never renders them;
   * the target dump carries them, and the scene's `importChecks` pin the skip that names them.
   */
  readonly targetExtraSql?: string;
  /** Catalog facts to assert after the baseline build, before the migration. */
  readonly baselineChecks?: readonly SceneCheck[];
  /** Plan facts to assert on `plan(baseline, target)`, before any SQL runs. */
  readonly planChecks?: readonly ScenePlanCheck[];
  /** Statements to run after the migration; a non-zero exit fails the scene. */
  readonly probes?: readonly string[];
  /** Catalog facts to assert after the migration and the probes. */
  readonly checks?: readonly SceneCheck[];
  /** Import facts to assert on both dumps' imports, after the round trip. */
  readonly importChecks?: readonly SceneImportCheck[];
}

/** `public` tables in name order, or the empty string when there are none. */
const TABLES =
  "select string_agg(tablename, ',' order by tablename) from pg_tables where schemaname = 'public'";
/** The number of tables in `public`. */
const TABLE_COUNT = "select count(*) from pg_tables where schemaname = 'public'";
/** The number of foreign keys whose constraint lives in `public`. */
const FK_COUNT =
  "select count(*) from pg_constraint where contype = 'f' and connamespace = 'public'::regnamespace";

/** The column names of `tableName` in ordinal position order. */
const columnsByPosition = (tableName: string): string =>
  `select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = '${tableName}'`;

/** A catalog fact about one column: the expression read and its exact `-tA` text. */
const columnFact = (tableName: string, columnName: string, expression: string): string =>
  `select ${expression} from information_schema.columns where table_schema = 'public' and table_name = '${tableName}' and column_name = '${columnName}'`;

/** The count of constraints with `conname` whose type is `contype`, exact. */
const constraintCount = (conname: string, contype: string): string =>
  `select count(*) from pg_constraint where conname = '${conname}' and contype = '${contype}'`;

/** The constraint of `tableName` of the given type, named. */
const constraintName = (tableName: string, contype: string): string =>
  `select conname from pg_constraint where conrelid = 'public.${tableName}'::regclass and contype = '${contype}'`;

/** The definition of the constraint named `conname`. */
const constraintDef = (conname: string): string =>
  `select pg_get_constraintdef(oid) from pg_constraint where conname = '${conname}'`;

/** The names of `tableName`'s constraints of the given type, in name order. */
const constraintNames = (tableName: string, contype: string): string =>
  `select string_agg(conname, ',' order by conname) from pg_constraint` +
  ` where conrelid = 'public.${tableName}'::regclass and contype = '${contype}'`;

/**
 * Whether the unique constraint `conname` is backed by an index of the same name, as
 * PostgreSQL creates for `ADD CONSTRAINT … UNIQUE`: `t` or `f`.
 */
const constraintBackedByIndex = (conname: string): string =>
  `select count(*) = 1 from pg_constraint constraint_row` +
  ` join pg_class index_row on index_row.oid = constraint_row.conindid` +
  ` where constraint_row.conname = '${conname}' and constraint_row.contype = 'u'` +
  ` and index_row.relname = '${conname}'`;

/** The index names of `tableName` in name order, or the empty string when there are none. */
const indexesOf = (tableName: string, schema = 'public'): string =>
  `select coalesce(string_agg(indexname, ',' order by indexname), '') from pg_indexes` +
  ` where schemaname = '${schema}' and tablename = '${tableName}'`;

/** Whether the index named `name` is unique: `t` or `f`, via `pg_index`. */
const indexIsUnique = (name: string, schema = 'public'): string =>
  `select indisunique from pg_index where indexrelid = '${schema}.${name}'::regclass`;

/** Whether the index named `name` is valid: `t` or `f`, via `pg_index`. */
const indexIsValid = (name: string, schema = 'public'): string =>
  `select indisvalid from pg_index where indexrelid = '${schema}.${name}'::regclass`;

/** A named table is present: `name|0` or `name|1`, pinned as one text fact. */
const tableExists = (tableName: string): string =>
  `select '${tableName}' || '|' || count(*) from pg_tables where schemaname = 'public' and tablename = '${tableName}'`;

/** `public` sequences in name order, or the empty string when there are none. */
const SEQUENCES =
  "select string_agg(sequencename, ',' order by sequencename) from pg_sequences where schemaname = 'public'";

/**
 * One sequence's effective options, as one `-tA` text fact: data type, start, minimum,
 * maximum, increment, cycle, cache. `pg_sequences` reads them back from the live catalog, and
 * `||` casts the boolean to `true`/`false`.
 */
const sequenceParams = (name: string, schema = 'public'): string =>
  `select data_type || '|' || start_value || '|' || min_value || '|' || max_value` +
  ` || '|' || increment_by || '|' || cycle || '|' || cache_size` +
  ` from pg_sequences where schemaname = '${schema}' and sequencename = '${name}'`;

/** The table and column `name` is owned by, as `table.column`, or `none`, via `pg_depend`. */
const sequenceOwnership = (name: string, schema = 'public'): string =>
  `select coalesce((select owner.relname || '.' || attribute.attname` +
  ` from pg_depend dependency` +
  ` join pg_class sequence on sequence.oid = dependency.objid` +
  ` join pg_namespace namespace on namespace.oid = sequence.relnamespace` +
  ` join pg_class owner on owner.oid = dependency.refobjid` +
  ` join pg_attribute attribute on attribute.attrelid = dependency.refobjid` +
  ` and attribute.attnum = dependency.refobjsubid` +
  ` where dependency.deptype = 'a' and namespace.nspname = '${schema}'` +
  ` and sequence.relname = '${name}'), 'none')`;

/** Whether `pg_get_serial_sequence` resolves `tableName.columnName` to `name`: `name|true`. */
const serialSequenceIs = (
  tableName: string,
  columnName: string,
  name: string,
  schema = 'public',
): string =>
  `select '${name}' || '|' || coalesce((pg_get_serial_sequence('${schema}.${tableName}',` +
  ` '${columnName}')::regclass = '${schema}.${name}'::regclass), false)`;

/** The sequence `pg_get_serial_sequence` resolves `tableName.columnName` to, or `none`. */
const serialSequenceOrNone = (tableName: string, columnName: string, schema = 'public'): string =>
  `select coalesce(pg_get_serial_sequence('${schema}.${tableName}', '${columnName}'), 'none')`;

/** A column's `pg_attribute.attidentity` code: `a` (`ALWAYS`), `d` (`BY DEFAULT`), or empty. */
const attributeIdentity = (tableName: string, columnName: string, schema = 'public'): string =>
  `select attidentity from pg_attribute where attrelid = '${schema}.${tableName}'::regclass` +
  ` and attname = '${columnName}'`;

/**
 * The table and column the identity sequence `name` depends on, as `table.column` or `none`,
 * via `pg_depend` `deptype = 'i'` — the internal dependency an identity creates.
 */
const identityOwnership = (name: string, schema = 'public'): string =>
  `select coalesce((select owner.relname || '.' || attribute.attname` +
  ` from pg_depend dependency` +
  ` join pg_class sequence on sequence.oid = dependency.objid` +
  ` join pg_namespace namespace on namespace.oid = sequence.relnamespace` +
  ` join pg_class owner on owner.oid = dependency.refobjid` +
  ` join pg_attribute attribute on attribute.attrelid = dependency.refobjid` +
  ` and attribute.attnum = dependency.refobjsubid` +
  ` where dependency.deptype = 'i' and namespace.nspname = '${schema}'` +
  ` and sequence.relname = '${name}'), 'none')`;

const createTableScene = (): LiveScene => {
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

  return {
    name: 'create-table',
    baseline: model(),
    target: model(orders, users, accounts),
    baselineChecks: [{ description: 'baseline has no tables', sql: TABLE_COUNT, expected: '0' }],
    probes: [
      `DO $do$
BEGIN
    INSERT INTO public.users (id) VALUES (1);
    INSERT INTO public.orders (id, "user") VALUES (1, 1);
    BEGIN
        INSERT INTO public.orders (id, "user") VALUES (2, 999);
        RAISE EXCEPTION 'expected foreign_key_violation';
    EXCEPTION WHEN foreign_key_violation THEN
        RAISE NOTICE 'orders_user_fkey enforced';
    END;
END
$do$;`,
    ],
    checks: [
      { description: 'tables', sql: TABLES, expected: 'accounts,orders,users' },
      {
        description: 'orders columns by ordinal position',
        sql: columnsByPosition('orders'),
        expected: 'id,user,total',
      },
      {
        description: 'users columns by ordinal position',
        sql: columnsByPosition('users'),
        expected: 'id,Mixed Case',
      },
      {
        description: 'orders.user type',
        sql: columnFact('orders', 'user', 'data_type'),
        expected: 'bigint',
      },
      {
        description: 'accounts.balance is NOT NULL with its default',
        sql: columnFact('accounts', 'balance', "is_nullable || '|' || column_default"),
        expected: 'NO|0',
      },
      {
        description: 'orders.total type, nullability, and default',
        sql: columnFact(
          'orders',
          'total',
          "data_type || '|' || is_nullable || '|' || column_default",
        ),
        expected: 'numeric|YES|0',
      },
      {
        description: 'users."Mixed Case" type, nullability, and default',
        sql: columnFact(
          'users',
          'Mixed Case',
          "data_type || '|' || is_nullable || '|' || column_default",
        ),
        expected: "text|NO|'x'::text",
      },
      {
        description: 'users primary key',
        sql: constraintName('users', 'p'),
        expected: 'users_pkey',
      },
      {
        description: 'orders_user_fkey with ON DELETE CASCADE',
        sql: `select count(*) from pg_constraint where conname = 'orders_user_fkey' and contype = 'f' and confdeltype = 'c'`,
        expected: '1',
      },
      {
        description: 'the default applied to the inserted row',
        sql: `select count(*) from public.users where id = 1 and "Mixed Case" = 'x'`,
        expected: '1',
      },
    ],
  };
};

const alterTableScene = (): LiveScene => {
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

  return {
    name: 'alter-table',
    baseline: model(events, mail, names, users),
    target: model(events, mail, names, usersTarget),
    baselineChecks: [
      {
        description: 'baseline users columns by ordinal position',
        sql: columnsByPosition('users'),
        expected: 'id,name,email,legacy,mail_id,name_id',
      },
      {
        description: 'baseline users_mail_id_fkey',
        sql: constraintCount('users_mail_id_fkey', 'f'),
        expected: '1',
      },
    ],
    probes: [
      `DO $do$
BEGIN
    INSERT INTO public.mail (id) VALUES (1);
    INSERT INTO public.events (id) VALUES (1);
    INSERT INTO public.users (id, name, mail_id, event_id)
        VALUES (1, 'n', 1, 1);
END
$do$;`,
    ],
    checks: [
      {
        description: 'users columns, set',
        sql:
          "select string_agg(column_name, ',' order by column_name) from information_schema.columns" +
          " where table_schema = 'public' and table_name = 'users'",
        expected: 'created_at,email,event_id,id,mail_id,name',
      },
      {
        description: 'users columns by ordinal position',
        sql: columnsByPosition('users'),
        expected: 'id,name,email,mail_id,created_at,event_id',
      },
      {
        description: 'users.name type and nullability',
        sql: columnFact('users', 'name', "data_type || '|' || is_nullable"),
        expected: 'text|NO',
      },
      {
        description: 'users.email type and length',
        sql: columnFact('users', 'email', "data_type || '|' || character_maximum_length"),
        expected: 'character varying|24',
      },
      {
        description: 'users.created_at default',
        sql: columnFact('users', 'created_at', 'column_default'),
        expected: 'now()',
      },
      {
        description: 'users primary key',
        sql: constraintName('users', 'p'),
        expected: 'users_pkey',
      },
      {
        description: 'users_mail_id_fkey with ON DELETE CASCADE',
        sql: `select count(*) from pg_constraint where conname = 'users_mail_id_fkey' and contype = 'f' and confdeltype = 'c'`,
        expected: '1',
      },
      {
        description: 'users_event_id_fkey',
        sql: constraintCount('users_event_id_fkey', 'f'),
        expected: '1',
      },
      {
        description: 'the inserted users row',
        sql: 'select count(*) from public.users',
        expected: '1',
      },
    ],
  };
};

const dropTableScene = (): LiveScene => {
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

  return {
    name: 'drop-table',
    baseline: model(a, b, child, node, parent),
    target: model(),
    baselineChecks: [
      {
        description: 'baseline tables',
        sql: TABLES,
        expected: 'a,b,child,node,parent',
      },
      { description: 'baseline foreign keys in public', sql: FK_COUNT, expected: '4' },
      {
        description: 'baseline a columns by ordinal position',
        sql: columnsByPosition('a'),
        expected: 'id,b_id',
      },
    ],
    checks: [{ description: 'tables left', sql: TABLE_COUNT, expected: '0' }],
  };
};

const mixedScene = (): LiveScene => {
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
    foreignKeys: [
      foreignKey(['legacy_id'], identity('legacy'), {
        name: 'orders_legacy_id_fkey',
        referencedColumns: ['id'],
      }),
    ],
  });
  const users = table('users', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('name', { type: 'character varying(12)' }),
      column('obsolete', { type: 'integer' }),
      column('group_id', { type: 'integer' }),
    ],
    primaryKey: { name: 'users_pkey', columns: ['id'] },
    foreignKeys: [
      foreignKey(['obsolete'], identity('legacy'), {
        name: 'users_obsolete_fkey',
        referencedColumns: ['id'],
      }),
      foreignKey(['group_id'], identity('groups'), {
        name: 'users_group_id_fkey',
        referencedColumns: ['id'],
      }),
    ],
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
    foreignKeys: [
      foreignKey(['user_id'], identity('users'), {
        name: 'sessions_user_id_fkey',
        referencedColumns: ['id'],
      }),
    ],
  });
  const usersTarget = table('users', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('name'),
      column('group_id', { type: 'integer' }),
      column('email'),
    ],
    primaryKey: { columns: ['id'] },
    foreignKeys: [
      foreignKey(['group_id'], identity('groups'), {
        name: 'users_group_id_fkey',
        referencedColumns: ['id'],
        onDelete: 'CASCADE',
      }),
    ],
  });

  return {
    name: 'mixed',
    baseline: model(audit, legacy, legacyNotes, groups, orders, users),
    target: model(groups, ordersWithoutForeignKey, sessions, usersTarget),
    baselineChecks: [
      {
        description: 'baseline tables',
        sql: TABLES,
        expected: 'audit,groups,legacy,legacy_notes,orders,users',
      },
    ],
    probes: [
      `DO $do$
BEGIN
    INSERT INTO public.groups (id) VALUES (1);
    INSERT INTO public.users (id, name, group_id) VALUES (1, 'n', 1);
    INSERT INTO public.sessions (id, user_id) VALUES (1, 1);
END
$do$;`,
    ],
    checks: [
      { description: 'tables left', sql: TABLES, expected: 'groups,orders,sessions,users' },
      {
        description: 'users columns by ordinal position',
        sql: columnsByPosition('users'),
        expected: 'id,name,group_id,email',
      },
      {
        description: 'users.name type',
        sql: columnFact('users', 'name', 'data_type'),
        expected: 'text',
      },
      {
        description: 'users primary key',
        sql: constraintName('users', 'p'),
        expected: 'users_pkey',
      },
      {
        description: 'users_group_id_fkey with ON DELETE CASCADE',
        sql: `select count(*) from pg_constraint where conname = 'users_group_id_fkey' and contype = 'f' and confdeltype = 'c'`,
        expected: '1',
      },
      {
        description: 'sessions_user_id_fkey',
        sql: constraintCount('sessions_user_id_fkey', 'f'),
        expected: '1',
      },
      {
        description: 'the inserted sessions row',
        sql: 'select count(*) from public.sessions',
        expected: '1',
      },
    ],
  };
};

const primaryKeyChangeScene = (): LiveScene => {
  const c = table('c', {
    columns: [column('id', { type: 'integer', notNull: true })],
    primaryKey: { name: 'c_pkey', columns: ['id'] },
  });
  const e = table('e', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('c_id', { type: 'integer' }),
    ],
    primaryKey: { name: 'e_pkey', columns: ['id'] },
    foreignKeys: [
      foreignKey(['c_id'], identity('c'), { name: 'e_c_id_fkey', referencedColumns: ['id'] }),
    ],
  });
  const f = table('f', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('c_id', { type: 'integer' }),
    ],
    primaryKey: { name: 'f_pkey', columns: ['id'] },
    foreignKeys: [foreignKey(['c_id'], identity('c'), { name: 'f_c_id_fkey' })],
  });
  const p = table('p', {
    columns: [
      column('a', { type: 'integer', notNull: true }),
      column('b', { type: 'integer', notNull: true }),
    ],
    primaryKey: { name: 'p_pkey', columns: ['a', 'b'] },
  });
  const q = table('q', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('pa', { type: 'integer' }),
      column('pb', { type: 'integer' }),
    ],
    primaryKey: { name: 'q_pkey', columns: ['id'] },
    foreignKeys: [
      foreignKey(['pa', 'pb'], identity('p'), {
        name: 'q_p_fkey',
        referencedColumns: ['a', 'b'],
      }),
    ],
  });
  const t = table('t', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('parent_id', { type: 'integer' }),
    ],
    primaryKey: { name: 't_pkey', columns: ['id'] },
    foreignKeys: [
      foreignKey(['parent_id'], identity('t'), {
        name: 't_parent_id_fkey',
        referencedColumns: ['id'],
      }),
    ],
  });

  return {
    name: 'primary-key-change',
    baseline: model(c, e, f, p, q, t),
    target: model(
      { ...c, primaryKey: { name: 'c_pkey_v2', columns: ['id'] } },
      e,
      f,
      { ...p, primaryKey: { name: 'p_pkey_v2', columns: ['b', 'a'] } },
      q,
      { ...t, primaryKey: { name: 't_pkey_v2', columns: ['id'] } },
    ),
    baselineChecks: [
      {
        description: 'baseline primary keys',
        sql:
          "select string_agg(conname, ',' order by conname) from pg_constraint where contype = 'p'" +
          " and connamespace = 'public'::regnamespace",
        expected: 'c_pkey,e_pkey,f_pkey,p_pkey,q_pkey,t_pkey',
      },
      { description: 'baseline foreign keys in public', sql: FK_COUNT, expected: '4' },
    ],
    probes: [
      `DO $do$
BEGIN
    INSERT INTO public.c (id) VALUES (1);
    INSERT INTO public.e (id, c_id) VALUES (1, 1);
    INSERT INTO public.f (id, c_id) VALUES (1, 1);
    INSERT INTO public.p (a, b) VALUES (1, 2);
    INSERT INTO public.q (id, pa, pb) VALUES (1, 1, 2);
    INSERT INTO public.t (id, parent_id) VALUES (1, NULL);
    INSERT INTO public.t (id, parent_id) VALUES (2, 1);
END
$do$;`,
    ],
    checks: [
      {
        description: 'primary keys',
        sql:
          "select string_agg(conname, ',' order by conname) from pg_constraint where contype = 'p'" +
          " and connamespace = 'public'::regnamespace",
        expected: 'c_pkey_v2,e_pkey,f_pkey,p_pkey_v2,q_pkey,t_pkey_v2',
      },
      {
        description: 'reordered primary-key definition',
        sql: constraintDef('p_pkey_v2'),
        expected: 'PRIMARY KEY (b, a)',
      },
      { description: 'foreign keys in public', sql: FK_COUNT, expected: '4' },
      {
        description: 'inferred foreign-key definition',
        sql: constraintDef('f_c_id_fkey'),
        expected: 'FOREIGN KEY (c_id) REFERENCES c(id)',
      },
      {
        description: 'q columns by ordinal position',
        sql: columnsByPosition('q'),
        expected: 'id,pa,pb',
      },
      {
        description: 'inserted rows across the scene',
        sql:
          'select (select count(*) from public.c) + (select count(*) from public.e)' +
          ' + (select count(*) from public.f) + (select count(*) from public.p)' +
          ' + (select count(*) from public.q) + (select count(*) from public.t)',
        expected: '7',
      },
    ],
  };
};

/** A table holding a named primary key: the two-table shapes the r1 scenes share. */
const r1Tables = (): {
  c: Table;
  cTarget: Table;
  e: Table;
  p: Table;
  pTarget: Table;
  q: Table;
  t: Table;
  tTarget: Table;
} => {
  const c = table('c', {
    columns: [column('id', { type: 'integer', notNull: true })],
    primaryKey: { name: 'c_pkey', columns: ['id'] },
  });
  const e = table('e', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('c_id', { type: 'integer' }),
    ],
    primaryKey: { name: 'e_pkey', columns: ['id'] },
    foreignKeys: [
      foreignKey(['c_id'], identity('c'), { name: 'e_c_id_fkey', referencedColumns: ['id'] }),
    ],
  });
  const p = table('p', {
    columns: [
      column('a', { type: 'integer', notNull: true }),
      column('b', { type: 'integer', notNull: true }),
    ],
    primaryKey: { name: 'p_pkey', columns: ['a', 'b'] },
  });
  const q = table('q', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('pa', { type: 'integer' }),
      column('pb', { type: 'integer' }),
    ],
    primaryKey: { name: 'q_pkey', columns: ['id'] },
    foreignKeys: [
      foreignKey(['pa', 'pb'], identity('p'), { name: 'q_p_fkey', referencedColumns: ['a', 'b'] }),
    ],
  });
  const t = table('t', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('parent_id', { type: 'integer' }),
    ],
    primaryKey: { name: 't_pkey', columns: ['id'] },
    foreignKeys: [
      foreignKey(['parent_id'], identity('t'), {
        name: 't_parent_id_fkey',
        referencedColumns: ['id'],
      }),
    ],
  });

  return {
    c,
    cTarget: { ...c, primaryKey: { name: 'c_pkey_v2', columns: ['id'] } },
    e,
    p,
    pTarget: { ...p, primaryKey: { name: 'p_pkey_v2', columns: ['b', 'a'] } },
    q,
    t,
    tTarget: { ...t, primaryKey: { name: 't_pkey_v2', columns: ['id'] } },
  };
};

/**
 * R1a: a primary-key rename under a surviving foreign key with explicit referenced columns;
 * R1b: a composite primary-key reorder under a surviving composite foreign key; R1c: the same
 * rename under a foreign key that omits its referenced columns; R1d: the same rename under a
 * self-referencing foreign key.
 */
const r1Scenes = (): readonly LiveScene[] => {
  const { c, cTarget, e, p, pTarget, q, t, tTarget } = r1Tables();
  const inferredE = table('e', {
    columns: e.columns,
    primaryKey: e.primaryKey,
    foreignKeys: [foreignKey(['c_id'], identity('c'), { name: 'e_c_id_fkey' })],
  });

  return [
    {
      name: 'r1a-pk-rename',
      baseline: model(c, e),
      target: model(cTarget, e),
      probes: [
        `DO $do$
BEGIN
    INSERT INTO public.c (id) VALUES (1);
    INSERT INTO public.e (id, c_id) VALUES (1, 1);
END
$do$;`,
      ],
      checks: [
        { description: 'c primary key', sql: constraintName('c', 'p'), expected: 'c_pkey_v2' },
        {
          description: 'e_c_id_fkey',
          sql: constraintCount('e_c_id_fkey', 'f'),
          expected: '1',
        },
        {
          description: 'inserted rows across the scene',
          sql: 'select (select count(*) from public.c) + (select count(*) from public.e)',
          expected: '2',
        },
      ],
    },
    {
      name: 'r1b-pk-reorder',
      baseline: model(p, q),
      target: model(pTarget, q),
      probes: [
        `DO $do$
BEGIN
    INSERT INTO public.p (a, b) VALUES (1, 2);
    INSERT INTO public.q (id, pa, pb) VALUES (1, 1, 2);
END
$do$;`,
      ],
      checks: [
        {
          description: 'reordered primary-key definition',
          sql: constraintDef('p_pkey_v2'),
          expected: 'PRIMARY KEY (b, a)',
        },
        {
          description: 'q_p_fkey',
          sql: constraintCount('q_p_fkey', 'f'),
          expected: '1',
        },
        {
          description: 'inserted rows across the scene',
          sql: 'select (select count(*) from public.p) + (select count(*) from public.q)',
          expected: '2',
        },
      ],
    },
    {
      name: 'r1c-pk-rename-inferred',
      baseline: model(c, inferredE),
      target: model(cTarget, inferredE),
      probes: [
        `DO $do$
BEGIN
    INSERT INTO public.c (id) VALUES (1);
    INSERT INTO public.e (id, c_id) VALUES (1, 1);
END
$do$;`,
      ],
      checks: [
        { description: 'c primary key', sql: constraintName('c', 'p'), expected: 'c_pkey_v2' },
        {
          description: 'inferred foreign-key definition',
          sql: constraintDef('e_c_id_fkey'),
          expected: 'FOREIGN KEY (c_id) REFERENCES c(id)',
        },
        {
          description: 'inserted rows across the scene',
          sql: 'select (select count(*) from public.c) + (select count(*) from public.e)',
          expected: '2',
        },
      ],
    },
    {
      name: 'r1d-pk-rename-self',
      baseline: model(t),
      target: model(tTarget),
      probes: [
        `DO $do$
BEGIN
    INSERT INTO public.t (id, parent_id) VALUES (1, NULL);
    INSERT INTO public.t (id, parent_id) VALUES (2, 1);
END
$do$;`,
      ],
      checks: [
        { description: 't primary key', sql: constraintName('t', 'p'), expected: 't_pkey_v2' },
        {
          description: 't_parent_id_fkey',
          sql: constraintCount('t_parent_id_fkey', 'f'),
          expected: '1',
        },
        { description: 'inserted rows', sql: 'select count(*) from public.t', expected: '2' },
      ],
    },
  ];
};

const pkdropRemovedRefScene = (): LiveScene => ({
  name: 'pkdrop-removedref',
  baseline: model(
    table('t', {
      columns: [column('id', { type: 'integer', notNull: true })],
      primaryKey: { name: 't_pkey', columns: ['id'] },
    }),
    table('x', {
      columns: [
        column('id', { type: 'integer', notNull: true }),
        column('t_id', { type: 'integer' }),
      ],
      primaryKey: { name: 'x_pkey', columns: ['id'] },
      foreignKeys: [foreignKey(['t_id'], identity('t'), { name: 'x_t_id_fkey' })],
    }),
  ),
  target: model(
    table('t', {
      columns: [column('id', { type: 'integer', notNull: true })],
    }),
  ),
  baselineChecks: [
    {
      description: 'baseline x_t_id_fkey',
      sql: constraintCount('x_t_id_fkey', 'f'),
      expected: '1',
    },
  ],
  checks: [
    {
      description: 't is kept without a primary key',
      sql:
        "select 't' || '|' || count(*) from pg_constraint" +
        " where conrelid = 'public.t'::regclass and contype = 'p'",
      expected: 't|0',
    },
    { description: 'x is dropped', sql: tableExists('x'), expected: 'x|0' },
  ],
});

const coldropRemovedRefScene = (): LiveScene => ({
  name: 'coldrop-removedref',
  baseline: model(
    table('t', {
      columns: [column('c', { type: 'integer', notNull: true }), column('d', { type: 'integer' })],
      primaryKey: { name: 't_pkey', columns: ['c'] },
    }),
    table('x', {
      columns: [column('id', { type: 'integer', notNull: true }), column('c', { type: 'integer' })],
      primaryKey: { name: 'x_pkey', columns: ['id'] },
      foreignKeys: [
        foreignKey(['c'], identity('t'), { name: 'x_c_fkey', referencedColumns: ['c'] }),
      ],
    }),
  ),
  target: model(
    table('t', {
      columns: [column('d', { type: 'integer', notNull: true })],
      primaryKey: { name: 't_d_pkey', columns: ['d'] },
    }),
  ),
  baselineChecks: [
    { description: 'baseline x_c_fkey', sql: constraintCount('x_c_fkey', 'f'), expected: '1' },
  ],
  checks: [
    {
      description: 't columns by ordinal position',
      sql: columnsByPosition('t'),
      expected: 'd',
    },
    { description: 't primary key', sql: constraintName('t', 'p'), expected: 't_d_pkey' },
    { description: 'x is dropped', sql: tableExists('x'), expected: 'x|0' },
  ],
});

const twocycleScene = (): LiveScene => ({
  name: 'twocycle',
  baseline: model(
    table('a', {
      columns: [
        column('id', { type: 'integer', notNull: true }),
        column('b_id', { type: 'integer' }),
      ],
      primaryKey: { name: 'a_pkey', columns: ['id'] },
      foreignKeys: [
        foreignKey(['b_id'], identity('b'), { name: 'a_b_id_fkey', referencedColumns: ['id'] }),
      ],
    }),
    table('b', {
      columns: [
        column('id', { type: 'integer', notNull: true }),
        column('a_id', { type: 'integer' }),
      ],
      primaryKey: { name: 'b_pkey', columns: ['id'] },
      foreignKeys: [
        foreignKey(['a_id'], identity('a'), { name: 'b_a_id_fkey', referencedColumns: ['id'] }),
      ],
    }),
  ),
  target: model(),
  baselineChecks: [
    { description: 'baseline foreign keys in public', sql: FK_COUNT, expected: '2' },
  ],
  checks: [{ description: 'tables left', sql: TABLE_COUNT, expected: '0' }],
});

const smallvictimScene = (): LiveScene => ({
  name: 'smallvictim',
  baseline: model(
    table('a', {
      columns: [column('id', { type: 'integer', notNull: true })],
      primaryKey: { name: 'a_pkey', columns: ['id'] },
    }),
    table('b', {
      columns: [
        column('id', { type: 'integer', notNull: true }),
        column('a_id', { type: 'integer' }),
        column('c_id', { type: 'integer' }),
      ],
      primaryKey: { name: 'b_pkey', columns: ['id'] },
      foreignKeys: [
        foreignKey(['a_id'], identity('a'), { name: 'b_a_id_fkey' }),
        foreignKey(['c_id'], identity('c'), { name: 'b_c_id_fkey' }),
      ],
    }),
    table('c', {
      columns: [
        column('id', { type: 'integer', notNull: true }),
        column('a2_id', { type: 'integer' }),
        column('a_id', { type: 'integer' }),
        column('b_id', { type: 'integer' }),
      ],
      primaryKey: { name: 'c_pkey', columns: ['id'] },
      foreignKeys: [
        foreignKey(['a2_id'], identity('a'), { name: 'c_a2_id_fkey' }),
        foreignKey(['a_id'], identity('a'), { name: 'c_a_id_fkey' }),
        foreignKey(['b_id'], identity('b'), { name: 'c_b_id_fkey' }),
      ],
    }),
  ),
  target: model(),
  baselineChecks: [
    { description: 'baseline foreign keys in public', sql: FK_COUNT, expected: '5' },
  ],
  checks: [{ description: 'tables left', sql: TABLE_COUNT, expected: '0' }],
});

const unnamedDropScene = (): LiveScene => ({
  name: 'unnamed-drop',
  baseline: model(
    table('ufk', {
      columns: [column('a', { type: 'integer' }), column('b', { type: 'integer' })],
      foreignKeys: [foreignKey(['a', 'b'], identity('up'), { referencedColumns: ['a', 'b'] })],
    }),
    table('up', {
      columns: [
        column('a', { type: 'integer', notNull: true }),
        column('b', { type: 'integer', notNull: true }),
      ],
      primaryKey: { columns: ['a', 'b'] },
    }),
  ),
  target: model(),
  checks: [{ description: 'tables left', sql: TABLE_COUNT, expected: '0' }],
});

const unnamedKeptScene = (): LiveScene => ({
  name: 'unnamed-kept',
  baseline: model(
    table('ufk', {
      columns: [column('a', { type: 'integer' }), column('b', { type: 'integer' })],
      foreignKeys: [foreignKey(['a', 'b'], identity('up'), { referencedColumns: ['a', 'b'] })],
    }),
    table('up', {
      columns: [
        column('a', { type: 'integer', notNull: true }),
        column('b', { type: 'integer', notNull: true }),
      ],
      primaryKey: { columns: ['a', 'b'] },
    }),
  ),
  target: model(
    table('ufk', {
      columns: [column('a', { type: 'integer' }), column('b', { type: 'integer' })],
    }),
    table('up', {
      columns: [
        column('a', { type: 'integer', notNull: true }),
        column('b', { type: 'integer', notNull: true }),
      ],
    }),
  ),
  checks: [
    { description: 'tables kept', sql: TABLES, expected: 'ufk,up' },
    {
      description: 'table constraints left in public',
      // PostgreSQL 18 records column NOT NULL specifications in
      // `pg_constraint` with `contype = 'n'`; the scene asserts only that the
      // unnamed primary-key and foreign-key constraints are gone, so count
      // real table constraints and ignore the NOT NULL records.
      sql:
        'select count(*) from pg_constraint' +
        " where connamespace = 'public'::regnamespace and contype in ('p', 'f', 'u', 'c', 'x')",
      expected: '0',
    },
  ],
});

const defaultChangeScene = (): LiveScene => {
  const baseline = table('t', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('kept', { default: "'original'" }),
      column('added'),
      column('dropped', { default: "'old'" }),
      column('changed', { default: "'first'" }),
    ],
    primaryKey: { name: 't_pkey', columns: ['id'] },
  });
  const target = table('t', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('kept', { default: "'original'" }),
      column('added', { default: "'new'" }),
      column('dropped'),
      column('changed', { default: "'second'" }),
    ],
    primaryKey: { name: 't_pkey', columns: ['id'] },
  });

  return {
    name: 'default-change',
    baseline: model(baseline),
    target: model(target),
    baselineChecks: [
      {
        description: 'baseline added has no default',
        sql: columnFact('t', 'added', "coalesce(column_default, 'none')"),
        expected: 'none',
      },
      {
        description: 'baseline dropped default',
        sql: columnFact('t', 'dropped', 'column_default'),
        expected: "'old'::text",
      },
      {
        description: 'baseline changed default',
        sql: columnFact('t', 'changed', 'column_default'),
        expected: "'first'::text",
      },
    ],
    planChecks: [
      {
        description: 'the migration alters only the three differing defaults',
        failure: (steps) => {
          const kinds = steps.map((step) => step.kind).join(',');
          if (kinds !== 'alter-column,alter-column,alter-column') {
            return `unexpected steps: ${kinds}`;
          }
          const altered = steps.flatMap((step) =>
            step.kind === 'alter-column'
              ? step.fields.map((field) => `${step.name}.${field.field}`)
              : [],
          );
          return altered.join(',') === 'added.default,dropped.default,changed.default'
            ? undefined
            : `altered: ${altered.join(',')}`;
        },
      },
    ],
    probes: [`INSERT INTO public.t (id) VALUES (1);`],
    checks: [
      {
        description: 'added default',
        sql: columnFact('t', 'added', 'column_default'),
        expected: "'new'::text",
      },
      {
        description: 'changed default',
        sql: columnFact('t', 'changed', 'column_default'),
        expected: "'second'::text",
      },
      {
        description: 'kept default',
        sql: columnFact('t', 'kept', 'column_default'),
        expected: "'original'::text",
      },
      {
        description: 'dropped default is gone',
        sql: columnFact('t', 'dropped', "coalesce(column_default, 'none')"),
        expected: 'none',
      },
      {
        description: 'the inserted row takes the migrated defaults',
        sql:
          "select coalesce(kept, 'null') || '|' || coalesce(added, 'null') || '|' ||" +
          " coalesce(dropped, 'null') || '|' || coalesce(changed, 'null')" +
          ' from public.t where id = 1',
        expected: 'original|new|null|second',
      },
    ],
  };
};

const primaryKeyAddScene = (): LiveScene => ({
  name: 'primary-key-add',
  baseline: model(
    table('t', {
      columns: [column('id', { type: 'integer' }), column('note')],
    }),
  ),
  target: model(
    table('t', {
      columns: [column('id', { type: 'integer', notNull: true }), column('note')],
      primaryKey: { name: 't_pkey', columns: ['id'] },
    }),
  ),
  baselineChecks: [
    {
      description: 'baseline t has no primary key',
      sql: constraintCount('t_pkey', 'p'),
      expected: '0',
    },
    {
      description: 'baseline t.id is nullable',
      sql: columnFact('t', 'id', 'is_nullable'),
      expected: 'YES',
    },
  ],
  planChecks: [
    {
      description: 'the migration sets NOT NULL before adding the primary key',
      failure: (steps) => {
        const kinds = steps.map((step) => step.kind).join(',');
        return kinds === 'alter-column,add-primary-key' ? undefined : `unexpected steps: ${kinds}`;
      },
    },
  ],
  probes: [`INSERT INTO public.t (id, note) VALUES (1, 'kept');`],
  checks: [
    { description: 't primary key', sql: constraintName('t', 'p'), expected: 't_pkey' },
    {
      description: 't primary-key definition',
      sql: constraintDef('t_pkey'),
      expected: 'PRIMARY KEY (id)',
    },
    { description: 't.id is NOT NULL', sql: columnFact('t', 'id', 'is_nullable'), expected: 'NO' },
    { description: 'the inserted row', sql: 'select count(*) from public.t', expected: '1' },
  ],
});

const serialCreateScene = (): LiveScene => {
  const users = table('users', {
    columns: [column('id', { type: 'bigint', notNull: true })],
    primaryKey: { name: 'users_pkey', columns: ['id'] },
  });
  const auditEntries = table('audit_entries', {
    columns: [
      column('id', {
        type: 'bigint',
        notNull: true,
        default: "nextval('public.audit_entries_id_seq'::regclass)",
      }),
      column('actor', { notNull: true }),
      column('action', { notNull: true }),
      column('at', { type: 'timestamp with time zone', notNull: true, default: 'now()' }),
    ],
    primaryKey: { name: 'audit_entries_pkey', columns: ['id'] },
  });
  const auditEntriesIdSeq = sequence('audit_entries_id_seq', {
    ownedBy: sequenceOwner('audit_entries', 'id'),
  });

  return {
    name: 'serial-create',
    baseline: model(users),
    target: withSequences([users, auditEntries], [auditEntriesIdSeq]),
    baselineChecks: [
      { description: 'baseline tables', sql: TABLES, expected: 'users' },
      { description: 'baseline has no sequences', sql: SEQUENCES, expected: '' },
    ],
    probes: [
      "INSERT INTO public.audit_entries (actor, action) VALUES ('ada', 'login'), ('ada', 'logout');",
    ],
    checks: [
      { description: 'tables', sql: TABLES, expected: 'audit_entries,users' },
      {
        description: 'audit_entries.id resolves through pg_get_serial_sequence',
        sql: serialSequenceIs('audit_entries', 'id', 'audit_entries_id_seq'),
        expected: 'audit_entries_id_seq|true',
      },
      {
        description: 'audit_entries_id_seq ownership',
        sql: sequenceOwnership('audit_entries_id_seq'),
        expected: 'audit_entries.id',
      },
      {
        description: 'audit_entries_id_seq parameters',
        sql: sequenceParams('audit_entries_id_seq'),
        expected: 'bigint|1|1|9223372036854775807|1|false|1',
      },
      {
        description: 'audit_entries.id carries a default',
        sql: columnFact('audit_entries', 'id', 'column_default is not null'),
        expected: 't',
      },
      {
        description: 'the default generated keys 1 and 2',
        sql: "select string_agg(id::text, ',' order by id) from public.audit_entries",
        expected: '1,2',
      },
    ],
  };
};

const sequenceAddDropScene = (): LiveScene => {
  const users = table('users', {
    columns: [column('id', { type: 'bigint', notNull: true })],
    primaryKey: { name: 'users_pkey', columns: ['id'] },
  });
  const dropMe = sequence('drop_me', {
    dataType: 'integer',
    increment: '3',
    minValue: '-10',
    maxValue: '1000',
    start: '-7',
    cache: '5',
    cycle: true,
  });
  const keepMe = sequence('keep_me', { dataType: 'smallint' });
  const addMe = sequence('add_me', {
    dataType: 'smallint',
    increment: '2',
    minValue: '10',
    maxValue: '32000',
    start: '20',
    cache: '7',
  });

  return {
    name: 'sequence-add-drop',
    baseline: withSequences([users], [dropMe, keepMe]),
    target: withSequences([users], [addMe, keepMe]),
    baselineChecks: [
      { description: 'baseline sequences', sql: SEQUENCES, expected: 'drop_me,keep_me' },
      {
        description: 'baseline drop_me parameters',
        sql: sequenceParams('drop_me'),
        expected: 'integer|-7|-10|1000|3|true|5',
      },
    ],
    checks: [
      { description: 'sequences left', sql: SEQUENCES, expected: 'add_me,keep_me' },
      {
        description: 'added sequence parameters',
        sql: sequenceParams('add_me'),
        expected: 'smallint|20|10|32000|2|false|7',
      },
      {
        description: 'kept sequence parameters',
        sql: sequenceParams('keep_me'),
        expected: 'smallint|1|1|32767|1|false|1',
      },
      {
        description: 'removed sequence is gone',
        sql:
          "select count(*) from pg_sequences where schemaname = 'public'" +
          " and sequencename = 'drop_me'",
        expected: '0',
      },
      {
        description: 'added sequence is unowned',
        sql: sequenceOwnership('add_me'),
        expected: 'none',
      },
      { description: 'tables left', sql: TABLES, expected: 'users' },
    ],
  };
};

const sequenceAlterScene = (): LiveScene => {
  const oldOwner = table('old_owner', {
    columns: [
      column('id', { type: 'bigint', notNull: true }),
      column('marker', { type: 'bigint' }),
    ],
    primaryKey: { name: 'old_owner_pkey', columns: ['id'] },
  });
  const newOwner = table('new_owner', {
    columns: [column('id', { type: 'bigint', notNull: true })],
    primaryKey: { name: 'new_owner_pkey', columns: ['id'] },
  });

  return {
    name: 'sequence-alter',
    baseline: withSequences(
      [oldOwner, newOwner],
      [
        sequence('as_type_seq', { dataType: 'integer' }),
        sequence('opts_seq'),
        sequence('replace_seq', { ownedBy: sequenceOwner('old_owner', 'id') }),
        sequence('detach_seq', { ownedBy: sequenceOwner('old_owner', 'marker') }),
      ],
    ),
    target: withSequences(
      [oldOwner, newOwner],
      [
        sequence('as_type_seq', { dataType: 'bigint', maxValue: '2147483647' }),
        sequence('opts_seq', { increment: '5', start: '10', cache: '4', cycle: true }),
        sequence('replace_seq', { ownedBy: sequenceOwner('new_owner', 'id') }),
        sequence('detach_seq'),
      ],
    ),
    baselineChecks: [
      {
        description: 'baseline sequences',
        sql: SEQUENCES,
        expected: 'as_type_seq,detach_seq,opts_seq,replace_seq',
      },
      {
        description: 'baseline as_type_seq parameters',
        sql: sequenceParams('as_type_seq'),
        expected: 'integer|1|1|2147483647|1|false|1',
      },
      {
        description: 'baseline replace_seq ownership',
        sql: sequenceOwnership('replace_seq'),
        expected: 'old_owner.id',
      },
      {
        description: 'baseline detach_seq ownership',
        sql: sequenceOwnership('detach_seq'),
        expected: 'old_owner.marker',
      },
    ],
    probes: [
      `DO $do$
BEGIN
    INSERT INTO public.old_owner (id, marker) VALUES (1, 2);
    INSERT INTO public.new_owner (id) VALUES (1);
END
$do$;`,
    ],
    checks: [
      {
        description: 'as_type_seq parameters after the AS change',
        sql: sequenceParams('as_type_seq'),
        expected: 'bigint|1|1|2147483647|1|false|1',
      },
      {
        description: 'opts_seq parameters after the option alters',
        sql: sequenceParams('opts_seq'),
        expected: 'bigint|10|1|9223372036854775807|5|true|4',
      },
      {
        description: 'replace_seq re-owned to new_owner.id',
        sql: sequenceOwnership('replace_seq'),
        expected: 'new_owner.id',
      },
      {
        description: 'old_owner.id no longer resolves a serial sequence',
        sql: serialSequenceOrNone('old_owner', 'id'),
        expected: 'none',
      },
      {
        description: 'detach_seq is detached',
        sql: sequenceOwnership('detach_seq'),
        expected: 'none',
      },
      {
        description: 'inserted rows across the scene',
        sql:
          'select (select count(*) from public.old_owner)' +
          ' + (select count(*) from public.new_owner)',
        expected: '2',
      },
    ],
  };
};

const ownerDropOrderScene = (): LiveScene => {
  const detachOwner = table('detach_owner', {
    columns: [column('id', { type: 'bigint', notNull: true })],
    primaryKey: { name: 'detach_owner_pkey', columns: ['id'] },
  });
  const cascadeOwner = table('cascade_owner', {
    columns: [column('id', { type: 'bigint', notNull: true })],
    primaryKey: { name: 'cascade_owner_pkey', columns: ['id'] },
  });
  const columnOwner = table('column_owner', {
    columns: [column('id', { type: 'bigint', notNull: true }), column('extra', { type: 'bigint' })],
    primaryKey: { name: 'column_owner_pkey', columns: ['id'] },
  });
  const columnOwnerTarget = table('column_owner', {
    columns: [column('id', { type: 'bigint', notNull: true })],
    primaryKey: { name: 'column_owner_pkey', columns: ['id'] },
  });

  return {
    name: 'owner-drop-order',
    baseline: withSequences(
      [detachOwner, cascadeOwner, columnOwner],
      [
        sequence('detach_owner_id_seq', { ownedBy: sequenceOwner('detach_owner', 'id') }),
        sequence('cascade_owner_id_seq', { ownedBy: sequenceOwner('cascade_owner', 'id') }),
        sequence('column_owner_extra_seq', { ownedBy: sequenceOwner('column_owner', 'extra') }),
      ],
    ),
    target: withSequences([columnOwnerTarget], [sequence('detach_owner_id_seq')]),
    baselineChecks: [
      {
        description: 'baseline sequences',
        sql: SEQUENCES,
        expected: 'cascade_owner_id_seq,column_owner_extra_seq,detach_owner_id_seq',
      },
      {
        description: 'baseline detach_owner_id_seq ownership',
        sql: sequenceOwnership('detach_owner_id_seq'),
        expected: 'detach_owner.id',
      },
      {
        description: 'baseline column_owner_extra_seq ownership',
        sql: sequenceOwnership('column_owner_extra_seq'),
        expected: 'column_owner.extra',
      },
    ],
    probes: [
      'INSERT INTO public.column_owner (id) VALUES (1);',
      "SELECT nextval('public.detach_owner_id_seq');",
    ],
    checks: [
      { description: 'tables left', sql: TABLES, expected: 'column_owner' },
      { description: 'sequences left', sql: SEQUENCES, expected: 'detach_owner_id_seq' },
      {
        description: 'detach_owner_id_seq survived its owner, unowned',
        sql: sequenceOwnership('detach_owner_id_seq'),
        expected: 'none',
      },
      {
        description: 'detach_owner_id_seq parameters are unchanged',
        sql: sequenceParams('detach_owner_id_seq'),
        expected: 'bigint|1|1|9223372036854775807|1|false|1',
      },
      {
        description: 'column_owner columns',
        sql: columnsByPosition('column_owner'),
        expected: 'id',
      },
      {
        description: 'the inserted column_owner row',
        sql: 'select count(*) from public.column_owner',
        expected: '1',
      },
    ],
  };
};

const detachedDropScene = (): LiveScene => {
  const t = table('t', {
    columns: [
      column('id', {
        type: 'bigint',
        notNull: true,
        default: "nextval('public.gone_seq'::regclass)",
      }),
      column('note'),
    ],
    primaryKey: { name: 't_pkey', columns: ['id'] },
  });
  const tTarget = table('t', {
    columns: [column('id', { type: 'bigint', notNull: true }), column('note')],
    primaryKey: { name: 't_pkey', columns: ['id'] },
  });

  return {
    name: 'detached-drop',
    baseline: withSequences([t], [sequence('gone_seq', { start: '1000' })]),
    target: model(tTarget),
    baselineChecks: [
      { description: 'baseline sequences', sql: SEQUENCES, expected: 'gone_seq' },
      {
        description: 'baseline gone_seq is unowned',
        sql: sequenceOwnership('gone_seq'),
        expected: 'none',
      },
      {
        description: 'baseline t.id default references gone_seq',
        sql: columnFact('t', 'id', "position('gone_seq' in column_default) > 0"),
        expected: 't',
      },
    ],
    probes: ["INSERT INTO public.t (id, note) VALUES (5, 'kept');"],
    checks: [
      { description: 'sequences left', sql: SEQUENCES, expected: '' },
      {
        description: 't.id default is dropped',
        sql: columnFact('t', 'id', "coalesce(column_default, 'none')"),
        expected: 'none',
      },
      { description: 't columns', sql: columnsByPosition('t'), expected: 'id,note' },
      {
        description: 'the inserted row',
        sql: 'select count(*) from public.t where id = 5',
        expected: '1',
      },
    ],
  };
};

const identityCreateScene = (): LiveScene => {
  const users = table('users', {
    columns: [
      column('id', {
        type: 'bigint',
        notNull: true,
        identity: identityColumn('bigint', { sequenceName: sequenceIdentity('users_id_seq') }),
      }),
      column('alias_id', {
        type: 'integer',
        notNull: true,
        identity: identityColumn('integer', {
          generated: 'by default',
          sequenceName: sequenceIdentity('users_alias_seq'),
          increment: '5',
          minValue: '10',
          maxValue: '500',
          start: '100',
          cache: '4',
          cycle: true,
        }),
      }),
      column('name', { notNull: true }),
    ],
    primaryKey: { name: 'users_pkey', columns: ['id'] },
  });
  const events = table('events', {
    columns: [
      column('id', {
        type: 'bigint',
        notNull: true,
        identity: identityColumn('bigint', {
          sequenceName: sequenceIdentity('events_id_seq'),
          increment: '-1',
        }),
      }),
      column('seq', {
        type: 'integer',
        notNull: true,
        identity: identityColumn('integer', {
          generated: 'by default',
          sequenceName: sequenceIdentity('events_seq_seq'),
          increment: '-4',
          minValue: '-1000',
          start: '-8',
          cache: '2',
          cycle: true,
        }),
      }),
      column('note'),
    ],
    primaryKey: { name: 'events_pkey', columns: ['id'] },
  });

  return {
    name: 'identity-create',
    baseline: model(),
    target: model(users, events),
    baselineChecks: [
      { description: 'baseline has no tables', sql: TABLE_COUNT, expected: '0' },
      { description: 'baseline has no sequences', sql: SEQUENCES, expected: '' },
    ],
    probes: [
      "INSERT INTO public.users (name) VALUES ('ada'), ('grace');",
      "INSERT INTO public.events (note) VALUES ('boot'), ('halt');",
    ],
    checks: [
      { description: 'tables', sql: TABLES, expected: 'events,users' },
      {
        description: 'users.id is GENERATED ALWAYS',
        sql: attributeIdentity('users', 'id'),
        expected: 'a',
      },
      {
        description: 'users.alias_id is GENERATED BY DEFAULT',
        sql: attributeIdentity('users', 'alias_id'),
        expected: 'd',
      },
      {
        description: 'events.id is GENERATED ALWAYS',
        sql: attributeIdentity('events', 'id'),
        expected: 'a',
      },
      {
        description: 'events.seq is GENERATED BY DEFAULT',
        sql: attributeIdentity('events', 'seq'),
        expected: 'd',
      },
      {
        description: 'users.id resolves through pg_get_serial_sequence',
        sql: serialSequenceIs('users', 'id', 'users_id_seq'),
        expected: 'users_id_seq|true',
      },
      {
        description: 'users.alias_id resolves through pg_get_serial_sequence',
        sql: serialSequenceIs('users', 'alias_id', 'users_alias_seq'),
        expected: 'users_alias_seq|true',
      },
      {
        description: 'events.id resolves through pg_get_serial_sequence',
        sql: serialSequenceIs('events', 'id', 'events_id_seq'),
        expected: 'events_id_seq|true',
      },
      {
        description: 'users_id_seq is an identity dependency (pg_depend deptype i)',
        sql: identityOwnership('users_id_seq'),
        expected: 'users.id',
      },
      {
        description: 'users_alias_seq is an identity dependency (pg_depend deptype i)',
        sql: identityOwnership('users_alias_seq'),
        expected: 'users.alias_id',
      },
      {
        description: 'events_id_seq is a descending identity dependency',
        sql: identityOwnership('events_id_seq'),
        expected: 'events.id',
      },
      {
        description: 'users_id_seq parameters',
        sql: sequenceParams('users_id_seq'),
        expected: 'bigint|1|1|9223372036854775807|1|false|1',
      },
      {
        description: 'users_alias_seq parameters',
        sql: sequenceParams('users_alias_seq'),
        expected: 'integer|100|10|500|5|true|4',
      },
      {
        description: 'events_id_seq parameters, descending defaults',
        sql: sequenceParams('events_id_seq'),
        expected: 'bigint|-1|-9223372036854775808|-1|-1|false|1',
      },
      {
        description: 'events_seq_seq parameters, descending and explicit',
        sql: sequenceParams('events_seq_seq'),
        expected: 'integer|-8|-1000|-1|-4|true|2',
      },
      {
        description: 'the generated keys',
        sql:
          "select (select string_agg(id::text, ',' order by id) from public.users)" +
          " || '|' || (select string_agg(alias_id::text, ',' order by alias_id) from public.users)" +
          " || '|' || (select string_agg(id::text, ',' order by id desc) from public.events)" +
          " || '|' || (select string_agg(seq::text, ',' order by seq desc) from public.events)",
        expected: '1,2|100,105|-1,-2|-8,-12',
      },
    ],
  };
};

const identityAlterScene = (): LiveScene => {
  const appUsers = table('app_users', {
    columns: [
      column('id', {
        type: 'integer',
        notNull: true,
        identity: identityColumn('integer', {
          sequenceName: sequenceIdentity('app_users_id_seq'),
          minValue: '1',
          maxValue: '1000',
          start: '500',
        }),
      }),
      column('name'),
    ],
    primaryKey: { name: 'app_users_pkey', columns: ['id'] },
  });
  const auditLog = table('audit_log', {
    columns: [
      column('id', {
        type: 'integer',
        notNull: true,
        identity: identityColumn('integer', {
          generated: 'by default',
          sequenceName: sequenceIdentity('audit_log_id_seq'),
          maxValue: '900',
          cycle: true,
        }),
      }),
      column('action'),
    ],
    primaryKey: { name: 'audit_log_pkey', columns: ['id'] },
  });
  const appUsersTarget = table('app_users', {
    columns: [
      column('id', {
        type: 'integer',
        notNull: true,
        identity: identityColumn('integer', {
          generated: 'by default',
          sequenceName: sequenceIdentity('app_users_id_seq'),
          increment: '2',
          minValue: '100',
          maxValue: '1000',
          start: '600',
          cache: '3',
          cycle: true,
        }),
      }),
      column('name'),
    ],
    primaryKey: { name: 'app_users_pkey', columns: ['id'] },
  });
  const auditLogTarget = table('audit_log', {
    columns: [
      column('id', {
        type: 'integer',
        notNull: true,
        identity: identityColumn('integer', {
          generated: 'always',
          sequenceName: sequenceIdentity('audit_log_id_seq'),
          increment: '3',
          minValue: '0',
          maxValue: '1000',
          start: '20',
          cache: '7',
        }),
      }),
      column('action'),
    ],
    primaryKey: { name: 'audit_log_pkey', columns: ['id'] },
  });

  return {
    name: 'identity-alter',
    baseline: model(appUsers, auditLog),
    target: model(appUsersTarget, auditLogTarget),
    baselineChecks: [
      { description: 'baseline tables', sql: TABLES, expected: 'app_users,audit_log' },
      {
        description: 'baseline app_users.id is GENERATED ALWAYS',
        sql: attributeIdentity('app_users', 'id'),
        expected: 'a',
      },
      {
        description: 'baseline audit_log.id is GENERATED BY DEFAULT',
        sql: attributeIdentity('audit_log', 'id'),
        expected: 'd',
      },
      {
        description: 'baseline app_users_id_seq parameters',
        sql: sequenceParams('app_users_id_seq'),
        expected: 'integer|500|1|1000|1|false|1',
      },
      {
        description: 'baseline audit_log_id_seq parameters',
        sql: sequenceParams('audit_log_id_seq'),
        expected: 'integer|1|1|900|1|true|1',
      },
    ],
    probes: [
      `DO $do$
BEGIN
    INSERT INTO public.app_users DEFAULT VALUES;
    INSERT INTO public.app_users DEFAULT VALUES;
    INSERT INTO public.audit_log DEFAULT VALUES;
    INSERT INTO public.audit_log DEFAULT VALUES;
END
$do$;`,
    ],
    checks: [
      {
        description: 'app_users.id flipped to GENERATED BY DEFAULT',
        sql: attributeIdentity('app_users', 'id'),
        expected: 'd',
      },
      {
        description: 'audit_log.id flipped to GENERATED ALWAYS',
        sql: attributeIdentity('audit_log', 'id'),
        expected: 'a',
      },
      {
        description: 'app_users_id_seq parameters after the multi-clause SET',
        sql: sequenceParams('app_users_id_seq'),
        expected: 'integer|600|100|1000|2|true|3',
      },
      {
        description: 'audit_log_id_seq parameters after the multi-clause SET',
        sql: sequenceParams('audit_log_id_seq'),
        expected: 'integer|20|0|1000|3|false|7',
      },
      {
        description: 'app_users_id_seq still depends on app_users.id',
        sql: identityOwnership('app_users_id_seq'),
        expected: 'app_users.id',
      },
      {
        description: 'audit_log_id_seq still depends on audit_log.id',
        sql: identityOwnership('audit_log_id_seq'),
        expected: 'audit_log.id',
      },
      {
        // `SET START WITH` records a restart value; it does not advance the sequence, so the
        // first `nextval` still returns the value the baseline was created with and the rest
        // follow the new increment.
        description: 'the generated keys after the alters',
        sql:
          "select (select string_agg(id::text, ',' order by id) from public.app_users)" +
          " || '|' || (select string_agg(id::text, ',' order by id) from public.audit_log)",
        expected: '500,502|1,4',
      },
    ],
  };
};

const identityDropScene = (): LiveScene => {
  const churn = table('churn', {
    columns: [
      column('id', {
        type: 'bigint',
        notNull: true,
        identity: identityColumn('bigint', { sequenceName: sequenceIdentity('churn_id_seq') }),
      }),
      column('note'),
      column('gone', {
        type: 'integer',
        notNull: true,
        identity: identityColumn('integer', {
          generated: 'by default',
          sequenceName: sequenceIdentity('churn_gone_seq'),
        }),
      }),
    ],
    primaryKey: { name: 'churn_pkey', columns: ['id'] },
  });
  const kept = table('kept', {
    columns: [
      column('id', {
        type: 'bigint',
        notNull: true,
        identity: identityColumn('bigint', { sequenceName: sequenceIdentity('kept_id_seq') }),
      }),
      column('note'),
    ],
    primaryKey: { name: 'kept_pkey', columns: ['id'] },
  });
  const victim = table('victim', {
    columns: [
      column('id', {
        type: 'integer',
        notNull: true,
        identity: identityColumn('integer', { sequenceName: sequenceIdentity('victim_id_seq') }),
      }),
      column('note'),
    ],
    primaryKey: { name: 'victim_pkey', columns: ['id'] },
  });
  const churnTarget = table('churn', {
    columns: [
      column('id', {
        type: 'bigint',
        notNull: true,
        identity: identityColumn('bigint', { sequenceName: sequenceIdentity('churn_id_seq') }),
      }),
      column('note'),
    ],
    primaryKey: { name: 'churn_pkey', columns: ['id'] },
  });
  const keptTarget = table('kept', {
    columns: [column('id', { type: 'bigint', notNull: true }), column('note')],
    primaryKey: { name: 'kept_pkey', columns: ['id'] },
  });

  return {
    name: 'identity-drop',
    baseline: model(churn, kept, victim),
    target: model(churnTarget, keptTarget),
    baselineChecks: [
      { description: 'baseline tables', sql: TABLES, expected: 'churn,kept,victim' },
      {
        description: 'baseline sequences',
        sql: SEQUENCES,
        expected: 'churn_gone_seq,churn_id_seq,kept_id_seq,victim_id_seq',
      },
      {
        description: 'baseline kept.id is an identity',
        sql: attributeIdentity('kept', 'id'),
        expected: 'a',
      },
    ],
    planChecks: [
      {
        description:
          'drops the identity, its column, and its table without an explicit sequence drop',
        failure: (steps) => {
          const drops = steps.filter((step) => step.kind === 'drop-sequence');
          if (drops.length > 0) return 'the plan emits a drop-sequence step';
          const kinds = steps.map((step) => step.kind).join(',');
          return kinds === 'drop-identity,drop-table,drop-column'
            ? undefined
            : `unexpected steps: ${kinds}`;
        },
      },
    ],
    probes: [
      `DO $do$
BEGIN
    INSERT INTO public.kept (id, note) VALUES (1, 'kept');
    INSERT INTO public.churn (note) VALUES ('one');
    INSERT INTO public.churn (note) VALUES ('two');
END
$do$;`,
    ],
    checks: [
      { description: 'tables left', sql: TABLES, expected: 'churn,kept' },
      {
        description: 'kept.id is no longer an identity',
        sql: attributeIdentity('kept', 'id'),
        expected: '',
      },
      {
        description: 'kept.id resolves no serial sequence',
        sql: serialSequenceOrNone('kept', 'id'),
        expected: 'none',
      },
      {
        description: 'kept.id is still NOT NULL',
        sql: columnFact('kept', 'id', 'is_nullable'),
        expected: 'NO',
      },
      {
        description: 'churn.id keeps its identity',
        sql: attributeIdentity('churn', 'id'),
        expected: 'a',
      },
      {
        description: 'churn.id still resolves churn_id_seq',
        sql: serialSequenceIs('churn', 'id', 'churn_id_seq'),
        expected: 'churn_id_seq|true',
      },
      { description: 'sequences left', sql: SEQUENCES, expected: 'churn_id_seq' },
      {
        description: 'the cascaded identity sequences are gone',
        sql:
          'select count(*) from pg_sequences where sequencename in' +
          " ('kept_id_seq', 'churn_gone_seq', 'victim_id_seq')",
        expected: '0',
      },
      {
        description: 'churn columns by ordinal position',
        sql: columnsByPosition('churn'),
        expected: 'id,note',
      },
      {
        description: 'the generated and inserted keys',
        sql:
          "select (select string_agg(id::text, ',' order by id) from public.churn)" +
          " || '|' || (select string_agg(id::text, ',' order by id) from public.kept)",
        expected: '1,2|1',
      },
    ],
  };
};

const identityToSequenceScene = (): LiveScene => {
  const t = table('t', {
    columns: [
      column('id', {
        type: 'bigint',
        notNull: true,
        identity: identityColumn('bigint', { sequenceName: sequenceIdentity('t_id_seq') }),
      }),
      column('note'),
    ],
    primaryKey: { name: 't_pkey', columns: ['id'] },
  });
  const tTarget = table('t', {
    columns: [
      column('id', {
        type: 'bigint',
        notNull: true,
        default: "nextval('public.t_id_seq'::regclass)",
      }),
      column('note'),
    ],
    primaryKey: { name: 't_pkey', columns: ['id'] },
  });
  const tIdSeq = sequence('t_id_seq', {
    start: '1000',
    increment: '10',
    cache: '5',
    ownedBy: sequenceOwner('t', 'id'),
  });

  return {
    name: 'identity-to-sequence',
    baseline: model(t),
    target: withSequences([tTarget], [tIdSeq]),
    baselineChecks: [
      { description: 'baseline tables', sql: TABLES, expected: 't' },
      {
        description: 'baseline t.id is an identity',
        sql: attributeIdentity('t', 'id'),
        expected: 'a',
      },
      { description: 'baseline sequences', sql: SEQUENCES, expected: 't_id_seq' },
      {
        description: 'baseline t.id resolves through pg_get_serial_sequence',
        sql: serialSequenceIs('t', 'id', 't_id_seq'),
        expected: 't_id_seq|true',
      },
    ],
    probes: ["INSERT INTO public.t (note) VALUES ('one'), ('two');"],
    checks: [
      {
        description: 't.id is no longer an identity',
        sql: attributeIdentity('t', 'id'),
        expected: '',
      },
      {
        description: 't.id still resolves the same sequence name',
        sql: serialSequenceIs('t', 'id', 't_id_seq'),
        expected: 't_id_seq|true',
      },
      {
        description: 't_id_seq is owned by t.id',
        sql: sequenceOwnership('t_id_seq'),
        expected: 't.id',
      },
      {
        description: 't_id_seq parameters',
        sql: sequenceParams('t_id_seq'),
        expected: 'bigint|1000|1|9223372036854775807|10|false|5',
      },
      { description: 'sequences left', sql: SEQUENCES, expected: 't_id_seq' },
      {
        description: 't.id is still NOT NULL',
        sql: columnFact('t', 'id', 'is_nullable'),
        expected: 'NO',
      },
      {
        description: 'the generated keys',
        sql: "select string_agg(id::text, ',' order by id) from public.t",
        expected: '1000,1010',
      },
    ],
  };
};

const sequenceToIdentityScene = (): LiveScene => {
  const t = table('t', {
    columns: [
      column('id', {
        type: 'bigint',
        notNull: true,
        default: "nextval('public.t_id_seq'::regclass)",
      }),
      column('note'),
    ],
    primaryKey: { name: 't_pkey', columns: ['id'] },
  });
  const tTarget = table('t', {
    columns: [
      column('id', {
        type: 'bigint',
        notNull: true,
        identity: identityColumn('bigint', {
          sequenceName: sequenceIdentity('t_id_seq'),
          start: '100',
          increment: '3',
          cache: '2',
        }),
      }),
      column('note'),
    ],
    primaryKey: { name: 't_pkey', columns: ['id'] },
  });
  const tIdSeq = sequence('t_id_seq', {
    start: '100',
    increment: '3',
    cache: '2',
    ownedBy: sequenceOwner('t', 'id'),
  });

  return {
    name: 'sequence-to-identity',
    baseline: withSequences([t], [tIdSeq]),
    target: model(tTarget),
    baselineChecks: [
      { description: 'baseline sequences', sql: SEQUENCES, expected: 't_id_seq' },
      {
        description: 'baseline t_id_seq is owned by t.id',
        sql: sequenceOwnership('t_id_seq'),
        expected: 't.id',
      },
      {
        description: 'baseline t.id default references t_id_seq',
        sql: columnFact('t', 'id', "position('t_id_seq' in column_default) > 0"),
        expected: 't',
      },
    ],
    probes: ["INSERT INTO public.t (note) VALUES ('one'), ('two');"],
    checks: [
      {
        description: 't.id is GENERATED ALWAYS',
        sql: attributeIdentity('t', 'id'),
        expected: 'a',
      },
      {
        description: 't.id resolves through pg_get_serial_sequence',
        sql: serialSequenceIs('t', 'id', 't_id_seq'),
        expected: 't_id_seq|true',
      },
      {
        description: 't_id_seq is an identity dependency (pg_depend deptype i)',
        sql: identityOwnership('t_id_seq'),
        expected: 't.id',
      },
      {
        description: 't.id carries no default of its own',
        sql: columnFact('t', 'id', "coalesce(column_default, 'none')"),
        expected: 'none',
      },
      {
        description: 't_id_seq parameters',
        sql: sequenceParams('t_id_seq'),
        expected: 'bigint|100|1|9223372036854775807|3|false|2',
      },
      { description: 'sequences left', sql: SEQUENCES, expected: 't_id_seq' },
      {
        description: 'the generated keys',
        sql: "select string_agg(id::text, ',' order by id) from public.t",
        expected: '100,103',
      },
    ],
  };
};

/**
 * The constraint round trip: a target whose primary key, unique, foreign-key, and check
 * constraints span named and unnamed declarations (the unnamed foreign key states its
 * referenced column list). The model canonicalizes every declaration to table level —
 * PostgreSQL does not record whether a constraint was declared on a column or on the table —
 * so the scene proves the canonical shape renders, applies under `ON_ERROR_STOP=1`, dumps, and
 * imports back with the constraints intact: `pg_constraint` spot-checks the conventional names
 * PostgreSQL assigned, and the import check proves those names came back unnamed, the
 * constraint-backed indexes are not modeled as standalone `Index` entries, and the known miss
 * of the best-effort check formula (`EXTRACT(epoch FROM …)`) keeps its server name.
 */
const constraintCreateScene = (): LiveScene => {
  const accounts = table('accounts', {
    columns: [
      column('id', { type: 'bigint', notNull: true }),
      column('email', { notNull: true }),
      column('tenant', { notNull: true }),
      column('name', { notNull: true }),
      column('age', { type: 'integer' }),
      column('manager_id', { type: 'bigint' }),
      column('created_at', { type: 'timestamp' }),
    ],
    primaryKey: { columns: ['id'] },
    foreignKeys: [foreignKey(['manager_id'], identity('accounts'), { referencedColumns: ['id'] })],
    uniqueConstraints: [
      { name: 'accounts_email_key', columns: ['email'] },
      { columns: ['tenant', 'name'] },
    ],
    checkConstraints: [
      { name: 'accounts_age_check', expression: 'age >= 0' },
      { expression: 'age >= 0 AND char_length(name) > 0' },
      { expression: 'char_length(email) > 0' },
      { expression: 'EXTRACT(epoch FROM created_at) = 0' },
    ],
  });

  return {
    name: 'constraint-create',
    baseline: model(),
    target: model(accounts),
    baselineChecks: [{ description: 'baseline has no tables', sql: TABLE_COUNT, expected: '0' }],
    planChecks: [
      {
        description: 'the constraints render as constraint steps, never as standalone indexes',
        failure: (steps) => {
          const kinds = steps.map((step) => step.kind).join(',');
          return kinds ===
            'create-table,add-unique-constraint,add-unique-constraint,' +
              'add-check-constraint,add-check-constraint,add-check-constraint,' +
              'add-check-constraint,add-foreign-key'
            ? undefined
            : `unexpected steps: ${kinds}`;
        },
      },
    ],
    importChecks: [
      {
        description:
          'the import canonicalizes conventional constraint names and keeps the formula miss',
        failure: (imported) => {
          const table = imported.model.tables.find((candidate) => candidate.name === 'accounts');
          if (table === undefined) return 'accounts is not imported';
          const indexes = table.indexes.map((index) => index.name ?? '<unnamed>');
          if (indexes.length > 0) return `standalone indexes imported: ${indexes.join(',')}`;
          if (table.primaryKey === undefined) return 'the primary key is not imported';
          if (table.primaryKey.name !== undefined) {
            return `primary key name: ${table.primaryKey.name}`;
          }
          const foreign = table.foreignKeys
            .map(
              (constraint) =>
                `${constraint.name ?? '<unnamed>'}:${constraint.columns.join(',')}->` +
                constraint.referencedColumns.join(','),
            )
            .join(' ');
          if (foreign !== '<unnamed>:manager_id->id') return `foreign keys: ${foreign}`;
          const unique = table.uniqueConstraints
            .map(
              (constraint) => `${constraint.name ?? '<unnamed>'}:${constraint.columns.join(',')}`,
            )
            .join(' ');
          if (unique !== '<unnamed>:email <unnamed>:tenant,name') {
            return `unique constraints: ${unique}`;
          }
          const checks = table.checkConstraints
            .map((constraint) => `${constraint.name ?? '<unnamed>'}:${constraint.expression}`)
            .join(' ');
          const expectedChecks =
            '<unnamed>:((age >= 0) AND(char_length(name) > 0))' +
            ' accounts_created_at_check:(EXTRACT(epoch FROM created_at) =(0)::numeric)' +
            ' <unnamed>:(age >= 0) <unnamed>:(char_length(email) > 0)';
          if (checks !== expectedChecks) return `check constraints: ${checks}`;
          return undefined;
        },
      },
    ],
    checks: [
      { description: 'tables', sql: TABLES, expected: 'accounts' },
      {
        description: 'the primary-key name, assigned by PostgreSQL',
        sql: constraintNames('accounts', 'p'),
        expected: 'accounts_pkey',
      },
      {
        description: 'the foreign-key name, assigned by PostgreSQL',
        sql: constraintNames('accounts', 'f'),
        expected: 'accounts_manager_id_fkey',
      },
      {
        description: 'unique constraint names, assigned by PostgreSQL',
        sql: constraintNames('accounts', 'u'),
        expected: 'accounts_email_key,accounts_tenant_name_key',
      },
      {
        description: 'check constraint names, assigned by PostgreSQL',
        sql: constraintNames('accounts', 'c'),
        expected:
          'accounts_age_check,accounts_check,accounts_created_at_check,accounts_email_check',
      },
      {
        description: 'the unnamed primary-key definition',
        sql: constraintDef('accounts_pkey'),
        expected: 'PRIMARY KEY (id)',
      },
      {
        description: 'the unnamed foreign-key definition',
        sql: constraintDef('accounts_manager_id_fkey'),
        expected: 'FOREIGN KEY (manager_id) REFERENCES accounts(id)',
      },
      {
        description: 'the unnamed unique constraint definition',
        sql: constraintDef('accounts_tenant_name_key'),
        expected: 'UNIQUE (tenant, name)',
      },
      {
        description: 'the named check definition',
        sql: constraintDef('accounts_age_check'),
        expected: 'CHECK ((age >= 0))',
      },
      {
        description: 'the unnamed single-column check definition',
        sql: constraintDef('accounts_email_check'),
        expected: 'CHECK ((char_length(email) > 0))',
      },
      {
        description: 'the unnamed multi-column check definition',
        sql: constraintDef('accounts_check'),
        expected: 'CHECK (((age >= 0) AND (char_length(name) > 0)))',
      },
      {
        description: 'the check the best-effort formula does not predict',
        sql: constraintDef('accounts_created_at_check'),
        expected: 'CHECK ((EXTRACT(epoch FROM created_at) = (0)::numeric))',
      },
      {
        description: 'the unique constraint owns its backing index',
        sql: constraintBackedByIndex('accounts_email_key'),
        expected: 't',
      },
      {
        description: 'the table carries only its three constraint-backed indexes',
        sql: `select count(*) from pg_indexes where schemaname = 'public' and tablename = 'accounts'`,
        expected: '3',
      },
    ],
  };
};

/**
 * The standalone-index round trip: a target adding a plain and a unique index, plus raw target
 * SQL declaring a partial and an expression index the model cannot represent. The plan renders
 * only the two modeled indexes; the target dump carries all four, and the import skips the two
 * unmodelable ones whole and by name, so the migrated and target imports still agree exactly.
 */
const indexCreateScene = (): LiveScene => {
  const accounts = table('accounts', {
    columns: [
      column('id', { type: 'bigint', notNull: true }),
      column('email', { notNull: true }),
      column('name', { notNull: true }),
      column('age', { type: 'integer' }),
    ],
    primaryKey: { name: 'accounts_pkey', columns: ['id'] },
  });
  const target = table('accounts', {
    columns: accounts.columns,
    primaryKey: accounts.primaryKey,
    indexes: [
      { name: 'accounts_age_idx', unique: false, columns: ['age'] },
      { name: 'accounts_email_idx', unique: true, columns: ['email'] },
    ],
  });

  return {
    name: 'index-create',
    baseline: model(accounts),
    target: model(target),
    targetExtraSql:
      'CREATE INDEX accounts_partial_idx ON public.accounts USING btree (age) WHERE (age >= 18);\n' +
      'CREATE INDEX accounts_lower_name_idx ON public.accounts USING btree (lower(name));',
    baselineChecks: [
      {
        description: 'baseline accounts has only its primary-key index',
        sql: indexesOf('accounts'),
        expected: 'accounts_pkey',
      },
    ],
    planChecks: [
      {
        description: 'the plan renders only the two modeled indexes',
        failure: (steps) => {
          const kinds = steps.map((step) => step.kind).join(',');
          if (kinds !== 'create-index,create-index') return `unexpected steps: ${kinds}`;
          const created = steps.map((step) =>
            step.kind === 'create-index' ? (step.index.name ?? '<unnamed>') : '',
          );
          return created.join(',') === 'accounts_age_idx,accounts_email_idx'
            ? undefined
            : `created: ${created.join(',')}`;
        },
      },
    ],
    importChecks: [
      {
        description: 'the modeled indexes round-trip and the unmodelable ones are skipped by name',
        failure: (imported, source) => {
          const table = imported.model.tables.find((candidate) => candidate.name === 'accounts');
          if (table === undefined) return 'accounts is not imported';
          const indexes = table.indexes
            .map(
              (index) =>
                `${index.name ?? '<unnamed>'}|${index.unique ? 'unique' : 'plain'}|${index.columns.join(',')}`,
            )
            .join('; ');
          if (indexes !== '<unnamed>|plain|age; <unnamed>|unique|email') {
            return `modeled indexes: ${indexes}`;
          }
          const skips = imported.diagnostics
            .filter((diagnostic) => diagnostic.kind === 'skip')
            .filter(
              (diagnostic) =>
                diagnostic.object === 'accounts_partial_idx' ||
                diagnostic.object === 'accounts_lower_name_idx',
            );
          if (source === 'applied') {
            return skips.length === 0
              ? undefined
              : `the migrated database carries unmodelable indexes: ${skips
                  .map((diagnostic) => diagnostic.object)
                  .join(',')}`;
          }
          const partial = skips.find((diagnostic) => diagnostic.object === 'accounts_partial_idx');
          if (partial === undefined || !partial.message.includes('(partial WHERE)')) {
            return 'the partial index was not skipped and named';
          }
          const expression = skips.find(
            (diagnostic) => diagnostic.object === 'accounts_lower_name_idx',
          );
          if (expression === undefined || !expression.message.includes('(expression element)')) {
            return 'the expression index was not skipped and named';
          }
          return undefined;
        },
      },
    ],
    checks: [
      { description: 'tables', sql: TABLES, expected: 'accounts' },
      {
        description: 'indexes after the migration',
        sql: indexesOf('accounts'),
        expected: 'accounts_age_idx,accounts_email_idx,accounts_pkey',
      },
      {
        description: 'the standalone unique index is unique',
        sql: indexIsUnique('accounts_email_idx'),
        expected: 't',
      },
      {
        description: 'the standalone plain index is not unique',
        sql: indexIsUnique('accounts_age_idx'),
        expected: 'f',
      },
      {
        description: 'the unmodelable indexes were never planned',
        sql:
          "select count(*) from pg_indexes where schemaname = 'public' and tablename = 'accounts'" +
          " and indexname in ('accounts_partial_idx', 'accounts_lower_name_idx')",
        expected: '0',
      },
    ],
  };
};

/**
 * The multi-group round trip: a target mixing a transactional column add, a standalone
 * `CREATE INDEX CONCURRENTLY`, and a second transactional index create. The plan partitions the
 * three steps into three groups — transactional, standalone, transactional — and the migration
 * applies under `ON_ERROR_STOP=1` only because the concurrent statement is bare; the catalog
 * check proves the built index valid, and the imports prove `CONCURRENTLY` is apply metadata a
 * dump never carries.
 */
const indexConcurrentlyScene = (): LiveScene => {
  const accounts = table('accounts', {
    columns: [column('id', { type: 'bigint', notNull: true }), column('email', { notNull: true })],
    primaryKey: { name: 'accounts_pkey', columns: ['id'] },
  });
  const target = table('accounts', {
    columns: [...accounts.columns, column('note')],
    primaryKey: accounts.primaryKey,
    indexes: [
      { name: 'accounts_email_idx', unique: false, columns: ['email'], concurrently: true },
      { name: 'accounts_note_idx', unique: false, columns: ['note'] },
    ],
  });

  return {
    name: 'index-concurrently',
    baseline: model(accounts),
    target: model(target),
    baselineChecks: [
      {
        description: 'baseline accounts columns by ordinal position',
        sql: columnsByPosition('accounts'),
        expected: 'id,email',
      },
      {
        description: 'baseline accounts has only its primary-key index',
        sql: indexesOf('accounts'),
        expected: 'accounts_pkey',
      },
    ],
    planChecks: [
      {
        description:
          'the concurrent create stands in a standalone group between transactional ones',
        failure: (steps, plan) => {
          const kinds = steps.map((step) => step.kind).join(',');
          if (kinds !== 'add-column,create-index-concurrently,create-index') {
            return `unexpected steps: ${kinds}`;
          }
          const groups = plan.groups
            .map(
              (group) =>
                `${group.transactional ? 'wrapped' : 'standalone'}[${group.start},${group.end})`,
            )
            .join(' ');
          return groups === 'wrapped[0,1) standalone[1,2) wrapped[2,3)'
            ? undefined
            : `unexpected groups: ${groups}`;
        },
      },
    ],
    importChecks: [
      {
        description: 'both imports carry the indexes as ordinary, CONCURRENTLY never dumped',
        failure: (imported) => {
          const table = imported.model.tables.find((candidate) => candidate.name === 'accounts');
          if (table === undefined) return 'accounts is not imported';
          const indexes = table.indexes
            .map(
              (index) =>
                `${index.name ?? '<unnamed>'}|${index.unique ? 'unique' : 'plain'}|` +
                `${index.columns.join(',')}|${index.concurrently === true ? 'concurrently' : 'ordinary'}`,
            )
            .join('; ');
          return indexes === '<unnamed>|plain|email|ordinary; <unnamed>|plain|note|ordinary'
            ? undefined
            : `indexes: ${indexes}`;
        },
      },
    ],
    checks: [
      {
        description: 'accounts columns by ordinal position',
        sql: columnsByPosition('accounts'),
        expected: 'id,email,note',
      },
      {
        description: 'indexes after the migration',
        sql: indexesOf('accounts'),
        expected: 'accounts_email_idx,accounts_note_idx,accounts_pkey',
      },
      {
        description: 'the concurrently built index is valid',
        sql: indexIsValid('accounts_email_idx'),
        expected: 't',
      },
    ],
  };
};

/**
 * The unnamed-index round trip: a target declaring three standalone indexes without names —
 * a single-column one, a multi-column one, and one built `CONCURRENTLY`. PostgreSQL names them
 * on apply (`t_age_idx`, `t_a_b_idx`, `t_note_idx`); the dump import canonicalizes those
 * server-generated names back to unnamed, so the catalog check pins the generated names and
 * the import checks pin that every imported index is unnamed in both dumps. A dump never
 * carries `CONCURRENTLY`, so the concurrent index is ordinary on both imported sides.
 */
const unnamedIndexRoundTripScene = (): LiveScene => {
  const columns = [
    column('a', { type: 'integer' }),
    column('b', { type: 'integer' }),
    column('age', { type: 'integer' }),
    column('note'),
  ];
  const target = table('t', {
    columns,
    indexes: [
      { unique: false, columns: ['age'] },
      { unique: false, columns: ['a', 'b'] },
      { unique: false, columns: ['note'], concurrently: true },
    ],
  });

  return {
    name: 'unnamed-index-round-trip',
    baseline: model(table('t', { columns })),
    target: model(target),
    planChecks: [
      {
        description:
          'the plan creates the two plain indexes transactionally and the concurrent one bare',
        failure: (steps, plan) => {
          const kinds = steps.map((step) => step.kind).join(',');
          if (kinds !== 'create-index,create-index,create-index-concurrently') {
            return `unexpected steps: ${kinds}`;
          }
          const columnsCreated = steps
            .map((step) =>
              step.kind === 'create-index' || step.kind === 'create-index-concurrently'
                ? step.index.columns.join('+')
                : '<other>',
            )
            .join(',');
          if (columnsCreated !== 'a+b,age,note') {
            return `unexpected index columns: ${columnsCreated}`;
          }
          const groups = plan.groups
            .map(
              (group) =>
                `${group.transactional ? 'wrapped' : 'standalone'}[${group.start},${group.end})`,
            )
            .join(' ');
          return groups === 'wrapped[0,2) standalone[2,3)'
            ? undefined
            : `unexpected groups: ${groups}`;
        },
      },
    ],
    checks: [
      {
        description: 'the catalog carries the three server-generated names',
        sql: indexesOf('t'),
        expected: 't_a_b_idx,t_age_idx,t_note_idx',
      },
      {
        description: 'the concurrently built index is valid',
        sql: indexIsValid('t_note_idx'),
        expected: 't',
      },
    ],
    importChecks: [
      {
        description: 'both imports carry every index unnamed, with its structure intact',
        failure: (imported, source) => {
          const table = imported.model.tables.find((candidate) => candidate.name === 't');
          if (table === undefined) return 't is not imported';
          const named = table.indexes.filter((index) => index.name !== undefined);
          if (named.length > 0) {
            return `${source}: server-generated names survived: ${named
              .map((index) => index.name)
              .join(',')}`;
          }
          const structures = table.indexes
            .map((index) => `${index.unique ? 'unique' : 'plain'}|${index.columns.join(',')}`)
            .join('; ');
          return structures === 'plain|a,b; plain|age; plain|note'
            ? undefined
            : `${source}: structures: ${structures}`;
        },
      },
    ],
  };
};

/**
 * The non-public-schema drop round trip: an `app.probe` table carrying a named and an unnamed
 * index, both removed by the target. PostgreSQL builds the unnamed index as `probe_id_idx`,
 * so the migration proves both the explicit and the synthesized form drop under
 * `<schema>.<name>`; a bare name would not resolve through `search_path`.
 */
const nonPublicIndexDropScene = (): LiveScene => {
  const columns = [column('id', { type: 'bigint', notNull: true }), column('c')];
  const baseline = model(
    table('probe', {
      schema: 'app',
      columns,
      indexes: [
        { name: 'probe_new_idx', unique: false, columns: ['c'] },
        { unique: false, columns: ['id'] },
      ],
    }),
  );
  const target = model(table('probe', { schema: 'app', columns }));

  return {
    name: 'non-public-index-drop',
    setupSql: 'CREATE SCHEMA app;',
    baseline,
    target,
    baselineChecks: [
      {
        description: 'app.probe carries the named and the server-named index',
        sql: indexesOf('probe', 'app'),
        expected: 'probe_id_idx,probe_new_idx',
      },
    ],
    planChecks: [
      {
        description: 'both drops are plain and transactional, the unnamed one first',
        failure: (steps, plan) => {
          const kinds = steps.map((step) => step.kind).join(',');
          if (kinds !== 'drop-index,drop-index') return `unexpected steps: ${kinds}`;
          const names = steps
            .map((step) => (step.kind === 'drop-index' ? (step.index.name ?? '<unnamed>') : ''))
            .join(',');
          if (names !== '<unnamed>,probe_new_idx') return `dropped: ${names}`;
          const groups = plan.groups
            .map(
              (group) =>
                `${group.transactional ? 'wrapped' : 'standalone'}[${group.start},${group.end})`,
            )
            .join(' ');
          return groups === 'wrapped[0,2)' ? undefined : `unexpected groups: ${groups}`;
        },
      },
    ],
    checks: [
      {
        description: 'both indexes are gone from app.probe',
        sql: indexesOf('probe', 'app'),
        expected: '',
      },
      {
        description: 'app.probe survives the drops',
        sql: "select count(*) from pg_tables where schemaname = 'app' and tablename = 'probe'",
        expected: '1',
      },
    ],
    importChecks: [
      {
        description: 'the imported table lives in app and carries no indexes',
        failure: (imported) => {
          const table = imported.model.tables.find(
            (candidate) => candidate.schema === 'app' && candidate.name === 'probe',
          );
          if (table === undefined) return 'app.probe is not imported';
          const indexes = table.indexes.map((index) => index.name ?? '<unnamed>').join(',');
          return indexes === '' ? undefined : `indexes: ${indexes}`;
        },
      },
    ],
  };
};

/** Every scene, in the order the harness runs them. */
export const scenes: readonly LiveScene[] = [
  createTableScene(),
  alterTableScene(),
  dropTableScene(),
  mixedScene(),
  primaryKeyChangeScene(),
  ...r1Scenes(),
  pkdropRemovedRefScene(),
  coldropRemovedRefScene(),
  twocycleScene(),
  smallvictimScene(),
  unnamedDropScene(),
  unnamedKeptScene(),
  defaultChangeScene(),
  primaryKeyAddScene(),
  serialCreateScene(),
  sequenceAddDropScene(),
  sequenceAlterScene(),
  ownerDropOrderScene(),
  detachedDropScene(),
  identityCreateScene(),
  identityAlterScene(),
  identityDropScene(),
  identityToSequenceScene(),
  sequenceToIdentityScene(),
  constraintCreateScene(),
  indexCreateScene(),
  indexConcurrentlyScene(),
  unnamedIndexRoundTripScene(),
  nonPublicIndexDropScene(),
];

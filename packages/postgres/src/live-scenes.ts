import type { Column, ForeignKey, Model, PrimaryKey, Table, TableIdentity } from '@schemamill/core';

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

/** One catalog fact: `sql` is read with `psql -tA` and compared exactly to `expected`. */
export interface SceneCheck {
  readonly description: string;
  readonly sql: string;
  readonly expected: string;
}

/** One scene of the live-PostgreSQL harness. */
export interface LiveScene {
  /** Stable scene name; the harness derives its database names from it. */
  readonly name: string;
  /** The model the baseline database is built from. */
  readonly baseline: Model;
  /** The model the target database is built from and the migration aims at. */
  readonly target: Model;
  /** Catalog facts to assert after the baseline build, before the migration. */
  readonly baselineChecks?: readonly SceneCheck[];
  /** Statements to run after the migration; a non-zero exit fails the scene. */
  readonly probes?: readonly string[];
  /** Catalog facts to assert after the migration and the probes. */
  readonly checks?: readonly SceneCheck[];
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

/** A named table is present: `name|0` or `name|1`, pinned as one text fact. */
const tableExists = (tableName: string): string =>
  `select '${tableName}' || '|' || count(*) from pg_tables where schemaname = 'public' and tablename = '${tableName}'`;

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
      description: 'constraints left in public',
      sql: "select count(*) from pg_constraint where connamespace = 'public'::regnamespace",
      expected: '0',
    },
  ],
});

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
];

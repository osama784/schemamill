/**
 * Live catalog reads: the `CatalogReader` seam binding for a live PostgreSQL server.
 *
 * The transport is the `psql` binary — the live harness's choice, so no client-library
 * dependency is added. One `-c` batch carries one `SELECT` returning one `json` document with
 * the `tables`, `columns`, `primaryKeys`, `indexes`, `constraints`, `notNullConstraints`, and
 * `sequences` sections; `psql` runs a single `-c` batch as one implicit transaction, so the
 * sections share one snapshot. The child
 * environment's `PGOPTIONS` sets `search_path=''` — the congruence with `pg_dump`, which
 * reads the catalog under the same empty path, so `format_type`'s spelling matches the dumped
 * DDL — and `default_transaction_read_only=on` as read-only posture. The read itself is the
 * single `SELECT`, so nothing about it writes; PostgreSQL 13 or newer is assumed (the
 * harness's own floor: `pg_attrdef`, `pg_collation`, and `format` all exist there).
 * `attcompression` exists only from PostgreSQL 14, so it is read through the row's `jsonb`
 * form: on 13 the key is absent and the column reports no explicit compression. A column's
 * default expression reads through `pg_attrdef` and `pg_get_expr`, and its explicit
 * collation's qualified name is assembled in SQL from `pg_collation` and the collation's
 * namespace with `format('%I.%I', …)` — `quote_ident`'s quoting, the spelling `pg_dump`
 * writes — with NULL standing for the model's absent state in both reads.
 *
 * Failure handling is a split. Transport failures (spawn error, non-zero exit, unparseable
 * JSON output) and any violation of the `SELECT`'s own payload contract — a missing or
 * wrong-typed field, an unknown or duplicate relation, orphan column, primary-key, index,
 * constraint, not-null, or sequence rows, a duplicate `(schema, table, conname)` constraint
 * row, a duplicate not-null row for one column, a row-shape violation against its constraint
 * kind, a primary key whose rows disagree, a not-null row whose column is not read or not
 * `NOT NULL`, an unknown storage or compression letter behind an explicit setting, an index
 * definition that does not parse to one `CREATE INDEX`, an owner column missing from an
 * otherwise-read table, or an identity attachment that is missing, duplicated, or on a
 * non-identity or non-integer column — throw an `Error` carrying the reason.
 * Diagnostics are only for sane-but-deferred catalog state: a partitioned relation is skipped
 * and named, temporary persistence is flagged on an imported table, generation — the column
 * feature the model does not carry — is flagged and named, a sequence owned by an unread
 * relation is skipped and named, ordinary sequence persistence is flagged and named while the
 * sequence still maps, identity sequence persistence differing from its table's is flagged and
 * named while the identity still attaches, the constraint attributes the model does not carry
 * are flagged and named, an exclusion constraint is
 * skipped whole, and an index outside the importer's envelope or not valid and ready is
 * skipped and named while one on a non-default tablespace is kept and flagged. Every
 * diagnostic keeps the import module's grammar: `object` is `<schema>.<table>` — for an index
 * or sequence finding, `<schema>.<indexName>` or `<schema>.<sequenceName>`, for an
 * identity-persistence flag `<schema>.<table>`, and for an exclusion skip
 * `<schema>.<conname>` — and the column or object, when relevant, is named in `message`;
 * `position` is never set.
 *
 * The pure half, `mapCatalog`, takes the parsed payload to the model and diagnostics; it is
 * exported for the unit suite but deliberately not re-exported from `index.ts`, which carries
 * only the seam binding.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  CatalogReader,
  CheckConstraint,
  Column,
  ColumnCompression,
  ColumnStorage,
  ConstraintEnforcement,
  Diagnostic,
  ForeignKey,
  Identity,
  IdentityGeneration,
  Index,
  Model,
  PrimaryKey,
  ReadResult,
  Sequence,
  SequenceDataType,
  SequenceOwner,
  Table,
  TableIdentity,
  TablePersistence,
  UniqueConstraint,
} from '@schemamill/core';
import { canonicalIntType, effectiveIdentity, effectiveSequence } from '@schemamill/core';
import { parse, type IndexStmt } from 'libpg-query';

import {
  checkConstraintStructureKey,
  classifyIndexEnvelope,
  foreignKeyStructureKey,
  indexStructureKey,
  normalizeSourceText,
  referentialAction,
  uniqueConstraintStructureKey,
} from './import.ts';
import {
  synthesizedCheckConstraintName,
  synthesizedForeignKeyName,
  synthesizedIndexName,
  synthesizedNotNullName,
  synthesizedPrimaryKeyName,
  synthesizedUniqueConstraintName,
} from './names.ts';

const execFileAsync = promisify(execFile);

/** A local, writable view of a readonly payload, used while canonicalizing. */
type Mutable<Payload> = { -readonly [Key in keyof Payload]: Payload[Key] };

/** The cap on `psql` output; large-catalog streaming is deferred. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** The child environment's startup options: empty `search_path` congruence, read-only posture. */
const CHILD_PGOPTIONS = '-c search_path= -c default_transaction_read_only=on';

/**
 * The one read: a single `json` document with the tables, columns, primary keys, indexes,
 * constraints, and sequences sections of every user schema, system schemas excluded. Tables
 * carry what the deferred-states pass needs (`relkind`, `relispartition`, `relpersistence`);
 * columns are read
 * for ordinary tables only, in attribute order, with the type spelling `format_type` gives,
 * the `pg_attrdef` default expression `pg_get_expr` renders (null when there is none), the
 * explicit collation's `pg_dump` spelling (`format('%I.%I', …)` over `pg_collation` and its
 * namespace, null when the collation is the type's), and the `attstorage`/`typstorage`/
 * `attcompression` letters the explicit-only gates compare; primary-key rows carry the
 * constraint name, the key position, the column name, and the constraint's deferrability and
 * temporal flags; index rows are read for ordinary tables only, one row per index, carrying the
 * table identification, the stored name, the `pg_get_indexdef` definition, the valid and ready
 * flags, and the tablespace name (null for the default); `constraints` rows are uniform over
 * the unique, check, foreign-key, and exclusion kinds — every key is emitted and the keys a
 * kind does not use are null — and `notNullConstraints` rows carry PostgreSQL 18's named
 * not-null constraints (empty before 18). Constraint-backed indexes are excluded in SQL: a
 * primary-key, unique, or exclusion constraint consumes the index its `conindid` names,
 * mirroring the dump importer's `USING INDEX` rule. The `contype` filter is what keeps a
 * foreign key's `conindid` — the referenced table's index, possibly a standalone unique index
 * on the same table — from matching; the `conrelid` comparison beside it is a planner aid, not
 * the guard. The section predicates (`conrelid <> 0`, `conislocal`, `conparentid = 0`,
 * `relkind = 'r'`, `NOT relispartition`, the tables block's namespace exclusions) keep domain
 * constraints, constraint triggers, inherited copies, and partitioned relations out. Catalog
 * columns newer than the 13 floor are read through the row's `jsonb` form with coalesced
 * defaults — `conenforced` (18; `true`), `conperiod` (18; `false`), `confdelsetcols` (15;
 * empty), and `indnullsnotdistinct` (15; `false`) — so the query parses and runs on PostgreSQL
 * 13. Every section orders deterministically for the payload, but the mapper does not depend on
 * row order.
 *
 * The `sequences` section reads every sequence relation in the same schema scope. Each row
 * carries `pg_sequence`'s declared options as exact decimal text (never a JSON number, so a
 * bigint bound survives the trip), the relation's persistence, and the optional owning column
 * that `pg_depend` names: `deptype 'a'` is `OWNED BY`, `'i'` is an identity column's internal
 * sequence. Every owner-side join is a left join, so a standalone sequence carries nulls there
 * and does not multiply; the inner `pg_sequence` join follows `relkind = 'S'`.
 */
const CATALOG_SQL = `
SELECT json_build_object(
  'tables', COALESCE((
    SELECT json_agg(row_to_json(table_row))
    FROM (
      SELECT
        namespace.nspname AS schema,
        relation.relname AS name,
        relation.relkind AS relkind,
        relation.relispartition AS relispartition,
        relation.relpersistence AS relpersistence
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE relation.relkind IN ('r', 'p')
        AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
        AND namespace.nspname NOT LIKE 'pg\\_%'
      ORDER BY namespace.nspname, relation.relname
    ) AS table_row
  ), '[]'::json),
  'columns', COALESCE((
    SELECT json_agg(row_to_json(column_row))
    FROM (
      SELECT
        namespace.nspname AS schema,
        relation.relname AS "tableName",
        attribute.attnum AS attnum,
        attribute.attname AS name,
        pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS type,
        attribute.attnotnull AS attnotnull,
        attribute.attidentity AS attidentity,
        attribute.attgenerated AS attgenerated,
        attribute.atthasdef AS atthasdef,
        pg_catalog.pg_get_expr(attrdef.adbin, attrdef.adrelid) AS "default",
        attribute.attcollation::bigint AS attcollation,
        attribute_type.typcollation::bigint AS typcollation,
        CASE
          WHEN attribute.attcollation <> 0
            AND attribute.attcollation <> attribute_type.typcollation
          THEN pg_catalog.format('%I.%I', collation_namespace.nspname, collation_row.collname)
        END AS collation,
        attribute.attstorage AS attstorage,
        attribute_type.typstorage AS typstorage,
        COALESCE(to_jsonb(attribute) ->> 'attcompression', '') AS attcompression
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = relation.oid
      LEFT JOIN pg_catalog.pg_type AS attribute_type ON attribute_type.oid = attribute.atttypid
      LEFT JOIN pg_catalog.pg_attrdef AS attrdef
        ON attrdef.adrelid = attribute.attrelid
       AND attrdef.adnum = attribute.attnum
      LEFT JOIN pg_catalog.pg_collation AS collation_row
        ON collation_row.oid = attribute.attcollation
      LEFT JOIN pg_catalog.pg_namespace AS collation_namespace
        ON collation_namespace.oid = collation_row.collnamespace
      WHERE relation.relkind = 'r'
        AND NOT relation.relispartition
        AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
        AND namespace.nspname NOT LIKE 'pg\\_%'
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      ORDER BY namespace.nspname, relation.relname, attribute.attnum
    ) AS column_row
  ), '[]'::json),
  'primaryKeys', COALESCE((
    SELECT json_agg(row_to_json(key_row))
    FROM (
      SELECT
        namespace.nspname AS schema,
        relation.relname AS "tableName",
        key_constraint.conname AS conname,
        key_column.ordinality AS ordinal,
        key_attribute.attname AS attname,
        key_constraint.condeferrable AS deferrable,
        key_constraint.condeferred AS deferred,
        COALESCE((to_jsonb(key_constraint) ->> 'conperiod')::boolean, false) AS period
      FROM pg_catalog.pg_constraint AS key_constraint
      CROSS JOIN LATERAL unnest(key_constraint.conkey) WITH ORDINALITY
        AS key_column(attnum, ordinality)
      JOIN pg_catalog.pg_class AS relation ON relation.oid = key_constraint.conrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      JOIN pg_catalog.pg_attribute AS key_attribute
        ON key_attribute.attrelid = relation.oid
       AND key_attribute.attnum = key_column.attnum
      WHERE key_constraint.contype = 'p'
        AND key_constraint.conparentid = 0
        AND relation.relkind = 'r'
        AND NOT relation.relispartition
        AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
        AND namespace.nspname NOT LIKE 'pg\\_%'
      ORDER BY namespace.nspname, relation.relname, key_column.ordinality
    ) AS key_row
  ), '[]'::json),
  'constraints', COALESCE((
    SELECT json_agg(row_to_json(constraint_row))
    FROM (
      SELECT
        namespace.nspname AS schema,
        relation.relname AS "tableName",
        c.conname AS conname,
        CASE c.contype
          WHEN 'u' THEN 'unique'
          WHEN 'c' THEN 'check'
          WHEN 'f' THEN 'foreign-key'
          WHEN 'x' THEN 'exclusion'
        END AS kind,
        CASE
          WHEN c.contype IN ('u', 'f') THEN (
            SELECT json_agg(key_attribute.attname ORDER BY key_column.ordinality)
            FROM unnest(c.conkey) WITH ORDINALITY
              AS key_column(attnum, ordinality)
            JOIN pg_catalog.pg_attribute AS key_attribute
              ON key_attribute.attrelid = c.conrelid
             AND key_attribute.attnum = key_column.attnum
          )
        END AS columns,
        CASE
          WHEN c.contype = 'c'
          THEN pg_catalog.pg_get_expr(c.conbin, c.conrelid)
        END AS expression,
        CASE
          WHEN c.contype = 'f' THEN referenced_namespace.nspname
        END AS "referencedSchema",
        CASE
          WHEN c.contype = 'f' THEN referenced_relation.relname
        END AS "referencedTable",
        CASE
          WHEN c.contype = 'f' THEN (
            SELECT json_agg(referenced_attribute.attname ORDER BY referenced_column.ordinality)
            FROM unnest(c.confkey) WITH ORDINALITY
              AS referenced_column(attnum, ordinality)
            JOIN pg_catalog.pg_attribute AS referenced_attribute
              ON referenced_attribute.attrelid = c.confrelid
             AND referenced_attribute.attnum = referenced_column.attnum
          )
        END AS "referencedColumns",
        CASE
          WHEN c.contype = 'f' THEN c.confupdtype::text
        END AS "onUpdate",
        CASE
          WHEN c.contype = 'f' THEN c.confdeltype::text
        END AS "onDelete",
        CASE
          WHEN c.contype = 'f' THEN c.confmatchtype::text
        END AS "matchType",
        CASE
          WHEN c.contype = 'f'
          THEN COALESCE(
            jsonb_array_length(NULLIF(to_jsonb(c) -> 'confdelsetcols', 'null'::jsonb)),
            0
          ) > 0
        END AS "deleteSetColumnList",
        CASE
          WHEN c.contype IN ('u', 'c', 'f')
          THEN c.condeferrable
        END AS deferrable,
        CASE
          WHEN c.contype IN ('u', 'c', 'f')
          THEN c.condeferred
        END AS deferred,
        CASE
          WHEN c.contype IN ('u', 'c', 'f')
          THEN c.convalidated
        END AS validated,
        CASE
          WHEN c.contype IN ('c', 'f')
          THEN COALESCE((to_jsonb(c) ->> 'conenforced')::boolean, true)
        END AS enforced,
        CASE
          WHEN c.contype = 'c' THEN c.connoinherit
        END AS "noInherit",
        CASE
          WHEN c.contype = 'u'
          THEN COALESCE(
            (to_jsonb(backing_index) ->> 'indnullsnotdistinct')::boolean,
            false
          )
        END AS "nullsNotDistinct",
        CASE
          WHEN c.contype = 'u'
          THEN backing_index.indnatts > backing_index.indnkeyatts
        END AS including,
        CASE
          WHEN c.contype IN ('u', 'f')
          THEN COALESCE((to_jsonb(c) ->> 'conperiod')::boolean, false)
        END AS period
      FROM pg_catalog.pg_constraint AS c
      JOIN pg_catalog.pg_class AS relation ON relation.oid = c.conrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      LEFT JOIN pg_catalog.pg_class AS referenced_relation
        ON referenced_relation.oid = c.confrelid
      LEFT JOIN pg_catalog.pg_namespace AS referenced_namespace
        ON referenced_namespace.oid = referenced_relation.relnamespace
      LEFT JOIN pg_catalog.pg_index AS backing_index
        ON backing_index.indexrelid = c.conindid
      WHERE c.conrelid <> 0
        AND c.contype IN ('u', 'c', 'f', 'x')
        AND c.conislocal
        AND c.conparentid = 0
        AND relation.relkind = 'r'
        AND NOT relation.relispartition
        AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
        AND namespace.nspname NOT LIKE 'pg\\_%'
      ORDER BY namespace.nspname, relation.relname, c.conname
    ) AS constraint_row
  ), '[]'::json),
  'notNullConstraints', COALESCE((
    SELECT json_agg(row_to_json(not_null_row))
    FROM (
      SELECT
        namespace.nspname AS schema,
        relation.relname AS "tableName",
        attribute.attname AS "columnName",
        not_null_constraint.conname AS conname,
        not_null_constraint.convalidated AS validated,
        not_null_constraint.connoinherit AS "noInherit"
      FROM pg_catalog.pg_constraint AS not_null_constraint
      JOIN pg_catalog.pg_class AS relation ON relation.oid = not_null_constraint.conrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = relation.oid
       AND attribute.attnum = not_null_constraint.conkey[1]
      WHERE not_null_constraint.contype = 'n'
        AND not_null_constraint.conrelid <> 0
        AND not_null_constraint.conislocal
        AND not_null_constraint.conparentid = 0
        AND relation.relkind = 'r'
        AND NOT relation.relispartition
        AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
        AND namespace.nspname NOT LIKE 'pg\\_%'
        AND NOT attribute.attisdropped
      ORDER BY namespace.nspname, relation.relname, attribute.attnum
    ) AS not_null_row
  ), '[]'::json),
  'indexes', COALESCE((
    SELECT json_agg(row_to_json(index_row))
    FROM (
      SELECT
        namespace.nspname AS schema,
        relation.relname AS "tableName",
        index_relation.relname AS "indexName",
        pg_catalog.pg_get_indexdef(index_relation.oid) AS definition,
        index.indisvalid AS valid,
        index.indisready AS ready,
        tablespace.spcname AS tablespace
      FROM pg_catalog.pg_index AS index
      JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid = index.indexrelid
      JOIN pg_catalog.pg_class AS relation ON relation.oid = index.indrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      LEFT JOIN pg_catalog.pg_constraint AS c ON (
        index.indrelid = c.conrelid
        AND index.indexrelid = c.conindid
        AND c.contype IN ('p', 'u', 'x')
      )
      LEFT JOIN pg_catalog.pg_tablespace AS tablespace
        ON tablespace.oid = index_relation.reltablespace
      WHERE relation.relkind = 'r'
        AND NOT relation.relispartition
        AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
        AND namespace.nspname NOT LIKE 'pg\\_%'
        AND c.oid IS NULL
      ORDER BY namespace.nspname, relation.relname, index_relation.relname
    ) AS index_row
  ), '[]'::json),
  'sequences', COALESCE((
    SELECT json_agg(row_to_json(sequence_row))
    FROM (
      SELECT
        sequence_namespace.nspname AS schema,
        sequence_relation.relname AS name,
        pg_catalog.format_type(sequence_data.seqtypid, NULL) AS "dataType",
        sequence_data.seqstart::text AS start,
        sequence_data.seqincrement::text AS increment,
        sequence_data.seqmin::text AS "minValue",
        sequence_data.seqmax::text AS "maxValue",
        sequence_data.seqcache::text AS cache,
        sequence_data.seqcycle AS cycle,
        sequence_relation.relpersistence AS persistence,
        CASE dependency.deptype
          WHEN 'a' THEN 'owned'
          WHEN 'i' THEN 'identity'
        END AS "ownerKind",
        owner_namespace.nspname AS "ownerSchema",
        owner_relation.relname AS "ownerTable",
        owner_attribute.attname AS "ownerColumn"
      FROM pg_catalog.pg_class AS sequence_relation
      JOIN pg_catalog.pg_namespace AS sequence_namespace
        ON sequence_namespace.oid = sequence_relation.relnamespace
      JOIN pg_catalog.pg_sequence AS sequence_data
        ON sequence_data.seqrelid = sequence_relation.oid
      LEFT JOIN pg_catalog.pg_depend AS dependency
        ON dependency.classid = 'pg_class'::regclass
       AND dependency.objid = sequence_relation.oid
       AND dependency.objsubid = 0
       AND dependency.refclassid = 'pg_class'::regclass
       AND dependency.deptype IN ('a', 'i')
      LEFT JOIN pg_catalog.pg_class AS owner_relation
        ON owner_relation.oid = dependency.refobjid
      LEFT JOIN pg_catalog.pg_namespace AS owner_namespace
        ON owner_namespace.oid = owner_relation.relnamespace
      LEFT JOIN pg_catalog.pg_attribute AS owner_attribute
        ON owner_attribute.attrelid = owner_relation.oid
       AND owner_attribute.attnum = dependency.refobjsubid
       AND NOT owner_attribute.attisdropped
      WHERE sequence_relation.relkind = 'S'
        AND sequence_namespace.nspname NOT IN ('pg_catalog', 'information_schema')
        AND sequence_namespace.nspname NOT LIKE 'pg\\_%'
      ORDER BY sequence_namespace.nspname, sequence_relation.relname
    ) AS sequence_row
  ), '[]'::json)
) AS document
`.trim();

/**
 * Reads `connection` — a libpq connection URI — into the canonical model, with diagnostics for
 * the catalog state the model does not represent. Throws on transport failure, unparseable
 * output, or a payload-contract violation.
 */
export async function introspect(connection: string): Promise<ReadResult<Model, Diagnostic>> {
  const stdout = await runPsql(connection);
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`catalog read returned unparseable JSON: ${reason(error)}`, { cause: error });
  }
  return mapCatalog(payload);
}

/** The seam binding: a structurally checked `CatalogReader` over a libpq connection URI. */
export const catalogReader: CatalogReader<string, Model, Diagnostic> = { introspect };

/** Spawns `psql` for the one read; a failure carries the exit code and the trimmed stderr. */
async function runPsql(connection: string): Promise<string> {
  try {
    // Credentials stay on argv; password-free URIs are the supported posture (ADR 0017, #71).
    const { stdout } = await execFileAsync(
      'psql',
      ['-X', '-q', '-w', '-tA', '-v', 'ON_ERROR_STOP=1', '-d', connection, '-c', CATALOG_SQL],
      {
        encoding: 'utf8',
        maxBuffer: MAX_OUTPUT_BYTES,
        env: { ...process.env, PGOPTIONS: CHILD_PGOPTIONS },
      },
    );
    return stdout;
  } catch (error) {
    throw new Error(`psql failed: ${describeFailure(error)}`, { cause: error });
  }
}

/** One thrown `execFile` failure as `exit <code>: <trimmed stderr, or the message>`. */
function describeFailure(error: unknown): string {
  const failure = error as { code?: number | string; stderr?: string; message?: string };
  const stderr = failure.stderr?.trim();
  const detail = stderr !== undefined && stderr !== '' ? stderr : (failure.message ?? 'unknown');
  return `exit ${String(failure.code)}: ${detail}`;
}

/** A thrown value's message, stringified when it is not an `Error`. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One `tables` row of the payload, after validation. */
interface TableRow {
  readonly schema: string;
  readonly name: string;
  readonly relkind: 'r' | 'p';
  readonly relispartition: boolean;
  readonly relpersistence: 'p' | 'u' | 't';
}

/** One `columns` row of the payload, after validation. */
interface ColumnRow {
  readonly schema: string;
  readonly tableName: string;
  readonly attnum: number;
  readonly name: string;
  readonly type: string;
  readonly attnotnull: boolean;
  readonly attidentity: string;
  readonly attgenerated: string;
  readonly atthasdef: boolean;
  readonly default: string | null;
  readonly attcollation: number;
  readonly typcollation: number;
  readonly collation: string | null;
  readonly attstorage: string;
  readonly typstorage: string;
  readonly attcompression: string;
}

/** One `primaryKeys` row of the payload, after validation. */
interface PrimaryKeyRow {
  readonly schema: string;
  readonly tableName: string;
  readonly conname: string;
  readonly ordinal: number;
  readonly attname: string;
  readonly deferrable: boolean;
  readonly deferred: boolean;
  readonly period: boolean;
}

/** The `constraints` row kinds, one per `pg_constraint.contype` letter the read selects. */
type ConstraintKind = 'unique' | 'check' | 'foreign-key' | 'exclusion';

/**
 * One `constraints` row of the payload after validation, uniform over its kind: every key is
 * present, and the keys the row's kind does not use are null. The mapper's per-kind matrix
 * enforces which keys must be non-null and which must be null.
 */
interface ConstraintRow {
  readonly schema: string;
  readonly tableName: string;
  readonly conname: string;
  readonly kind: ConstraintKind;
  readonly columns: readonly string[] | null;
  readonly expression: string | null;
  readonly referencedSchema: string | null;
  readonly referencedTable: string | null;
  readonly referencedColumns: readonly string[] | null;
  readonly onUpdate: string | null;
  readonly onDelete: string | null;
  readonly matchType: string | null;
  readonly deleteSetColumnList: boolean | null;
  readonly deferrable: boolean | null;
  readonly deferred: boolean | null;
  readonly validated: boolean | null;
  readonly enforced: boolean | null;
  readonly noInherit: boolean | null;
  readonly nullsNotDistinct: boolean | null;
  readonly including: boolean | null;
  readonly period: boolean | null;
}

/** One `notNullConstraints` row of the payload, after validation. */
interface NotNullConstraintRow {
  readonly schema: string;
  readonly tableName: string;
  readonly columnName: string;
  readonly conname: string;
  readonly validated: boolean;
  readonly noInherit: boolean;
}

/**
 * One `indexes` row of the payload after validation: the table identification, the stored
 * index name, the state the mapper filters on, and the parsed definition the envelope
 * classification runs on. The definition parses during row validation, before any grouping, so
 * an unparseable one is a contract throw carrying the row's payload path.
 */
interface IndexRow {
  readonly schema: string;
  readonly tableName: string;
  readonly indexName: string;
  readonly valid: boolean;
  readonly ready: boolean;
  readonly tablespace: string | null;
  readonly create: IndexStmt;
}

/**
 * One `sequences` row of the payload after validation: the sequence's declared options as
 * exact decimal strings, its persistence, and the owning column `pg_depend` names — all owner
 * fields null for a standalone sequence, `ownerColumn` null when the owner's attribute is
 * dropped or unread.
 */
interface SequenceRow {
  readonly schema: string;
  readonly name: string;
  readonly dataType: SequenceDataType;
  readonly start: string;
  readonly increment: string;
  readonly minValue: string;
  readonly maxValue: string;
  readonly cache: string;
  readonly cycle: boolean;
  readonly persistence: 'p' | 'u' | 't';
  readonly ownerKind: 'owned' | 'identity' | null;
  readonly ownerSchema: string | null;
  readonly ownerTable: string | null;
  readonly ownerColumn: string | null;
}

/** One identity sequence attached to its mapped table and column. */
interface MappedIdentity {
  readonly row: SequenceRow;
  readonly table: TableRow;
  readonly column: ColumnRow;
}

/** The `sequences` section resolved into the model's sequences, identity map, and findings. */
interface SequenceMapping {
  readonly sequences: readonly Sequence[];
  readonly identities: ReadonlyMap<string, MappedIdentity>;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * The pure mapper: a validated payload — the `SELECT`'s parsed `json` document — to the
 * canonical model and its diagnostics. Tables come back in canonical order (schema, then name,
 * plain string comparison) and columns in attribute order regardless of payload order, since
 * the model's ordering contract is the mapper's, not SQL's collation's. Sequences come back in
 * the same schema-then-name order as the importer; identity sequences attach to their columns
 * and never enter `Model.sequences`. Contract violations throw; only the deferred catalog
 * states become diagnostics, in canonical table order with table-level flags before a table's
 * column flags, columns in attribute order, not-null flags in the same attribute order,
 * constraint findings in stored `conname` order, index findings after them in stored-name
 * order, and sequence/identity findings last in their own schema-then-name order. Index
 * definitions parse through libpg-query, so the mapper is async; its output does not depend on
 * payload row order: index and constraint rows sort by stored name before the
 * conventional-name strip, and the entries stable-sort by `name ?? ''` exactly as
 * `finalizeTable` sorts the importer's.
 */
export async function mapCatalog(payload: unknown): Promise<ReadResult<Model, Diagnostic>> {
  const document = expectObject(payload, 'catalog payload');
  expectFields(document, 'catalog payload', [
    'tables',
    'columns',
    'primaryKeys',
    'indexes',
    'constraints',
    'notNullConstraints',
    'sequences',
  ]);
  const tables = expectArray(document, 'tables', 'catalog payload').map((row, index) =>
    parseTableRow(row, `catalog payload.tables[${index}]`),
  );
  const columns = expectArray(document, 'columns', 'catalog payload').map((row, index) =>
    parseColumnRow(row, `catalog payload.columns[${index}]`),
  );
  const keyRows = expectArray(document, 'primaryKeys', 'catalog payload').map((row, index) =>
    parsePrimaryKeyRow(row, `catalog payload.primaryKeys[${index}]`),
  );
  const constraintRows = expectArray(document, 'constraints', 'catalog payload').map((row, index) =>
    parseConstraintRow(row, `catalog payload.constraints[${index}]`),
  );
  const notNullRows = expectArray(document, 'notNullConstraints', 'catalog payload').map(
    (row, index) => parseNotNullConstraintRow(row, `catalog payload.notNullConstraints[${index}]`),
  );
  const indexRows: IndexRow[] = [];
  for (const [index, row] of expectArray(document, 'indexes', 'catalog payload').entries()) {
    indexRows.push(await parseIndexRow(row, `catalog payload.indexes[${index}]`));
  }
  const sequenceRows = expectArray(document, 'sequences', 'catalog payload').map((row, index) =>
    parseSequenceRow(row, `catalog payload.sequences[${index}]`),
  );

  const tablesByKey = new Map<string, TableRow>();
  for (const table of tables) {
    const key = tableKey(table.schema, table.name);
    if (tablesByKey.has(key)) {
      throw new Error(`catalog payload: duplicate table "${table.schema}.${table.name}"`);
    }
    tablesByKey.set(key, table);
  }

  const columnsByTable = new Map<string, ColumnRow[]>();
  for (const column of columns) {
    const key = tableKey(column.schema, column.tableName);
    const row = requireOrdinaryTable(
      tablesByKey,
      key,
      column.schema,
      column.tableName,
      'column row',
    );
    const tableColumns = columnsByTable.get(key);
    if (tableColumns === undefined) {
      columnsByTable.set(key, [column]);
      continue;
    }
    const place = `${row.schema}.${row.name}.${column.name}`;
    if (tableColumns.some((existing) => existing.name === column.name)) {
      throw new Error(`catalog payload: duplicate column "${place}"`);
    }
    if (tableColumns.some((existing) => existing.attnum === column.attnum)) {
      throw new Error(
        `catalog payload: duplicate column number ${column.attnum} in "${row.schema}.${row.name}"`,
      );
    }
    tableColumns.push(column);
  }

  const keysByTable = new Map<string, PrimaryKeyRow[]>();
  for (const keyRow of keyRows) {
    const key = tableKey(keyRow.schema, keyRow.tableName);
    const row = requireOrdinaryTable(
      tablesByKey,
      key,
      keyRow.schema,
      keyRow.tableName,
      'primary-key row',
    );
    const tableColumns = columnsByTable.get(key) ?? [];
    if (!tableColumns.some((column) => column.name === keyRow.attname)) {
      throw new Error(
        `catalog payload: primary-key column "${row.schema}.${row.name}.${keyRow.attname}" is not a read column of its table`,
      );
    }
    const tableKeys = keysByTable.get(key);
    if (tableKeys === undefined) {
      keysByTable.set(key, [keyRow]);
      continue;
    }
    const place = `${row.schema}.${row.name}.${keyRow.attname}`;
    if (tableKeys.some((existing) => existing.attname === keyRow.attname)) {
      throw new Error(`catalog payload: duplicate primary-key column "${place}"`);
    }
    if (tableKeys.some((existing) => existing.ordinal === keyRow.ordinal)) {
      throw new Error(
        `catalog payload: duplicate primary-key position ${keyRow.ordinal} in "${row.schema}.${row.name}"`,
      );
    }
    if (tableKeys.some((existing) => existing.conname !== keyRow.conname)) {
      throw new Error(
        `catalog payload: table "${row.schema}.${row.name}" carries more than one primary key`,
      );
    }
    if (
      tableKeys.some(
        (existing) =>
          existing.deferrable !== keyRow.deferrable ||
          existing.deferred !== keyRow.deferred ||
          existing.period !== keyRow.period,
      )
    ) {
      throw new Error(
        `catalog payload: primary-key rows of "${row.schema}.${row.name}" disagree on their attributes`,
      );
    }
    tableKeys.push(keyRow);
  }

  const constraintsByTable = new Map<string, ConstraintRow[]>();
  const constraintIdentities = new Set<string>();
  for (const row of constraintRows) {
    const key = tableKey(row.schema, row.tableName);
    requireOrdinaryTable(tablesByKey, key, row.schema, row.tableName, 'constraint row');
    const identityKey = `${key}\u0000${row.conname}`;
    if (constraintIdentities.has(identityKey)) {
      throw new Error(
        `catalog payload: duplicate constraint "${row.schema}.${row.tableName}.${row.conname}"`,
      );
    }
    constraintIdentities.add(identityKey);
    const tableConstraints = constraintsByTable.get(key);
    if (tableConstraints === undefined) {
      constraintsByTable.set(key, [row]);
      continue;
    }
    tableConstraints.push(row);
  }

  const notNullByTable = new Map<string, NotNullConstraintRow[]>();
  const notNullColumns = new Set<string>();
  for (const row of notNullRows) {
    const key = tableKey(row.schema, row.tableName);
    requireOrdinaryTable(tablesByKey, key, row.schema, row.tableName, 'not-null constraint row');
    const columnKey = `${key}\u0000${row.columnName}`;
    if (notNullColumns.has(columnKey)) {
      throw new Error(
        `catalog payload: duplicate not-null constraint for "${row.schema}.${row.tableName}.${row.columnName}"`,
      );
    }
    notNullColumns.add(columnKey);
    const column = (columnsByTable.get(key) ?? []).find(
      (candidate) => candidate.name === row.columnName,
    );
    if (column === undefined) {
      throw new Error(
        `catalog payload: not-null constraint for "${row.schema}.${row.tableName}.${row.columnName}" names a column the table does not carry`,
      );
    }
    if (!column.attnotnull) {
      throw new Error(
        `catalog payload: not-null constraint "${row.schema}.${row.tableName}.${row.columnName}" is on a column that is not NOT NULL`,
      );
    }
    const tableNotNull = notNullByTable.get(key);
    if (tableNotNull === undefined) {
      notNullByTable.set(key, [row]);
      continue;
    }
    tableNotNull.push(row);
  }

  const indexesByTable = new Map<string, IndexRow[]>();
  const indexIdentities = new Set<string>();
  for (const row of indexRows) {
    const key = tableKey(row.schema, row.tableName);
    requireOrdinaryTable(tablesByKey, key, row.schema, row.tableName, 'index row');
    const identityKey = tableKey(row.schema, row.indexName);
    if (indexIdentities.has(identityKey)) {
      throw new Error(`catalog payload: duplicate index "${row.schema}.${row.indexName}"`);
    }
    indexIdentities.add(identityKey);
    const tableIndexes = indexesByTable.get(key);
    if (tableIndexes === undefined) {
      indexesByTable.set(key, [row]);
      continue;
    }
    tableIndexes.push(row);
  }

  const sequenceMapping = mapSequences(sequenceRows, tablesByKey, columnsByTable);

  const diagnostics: Diagnostic[] = [];
  const modelTables: Table[] = [];
  for (const row of [...tablesByKey.values()].sort(compareTableRows)) {
    const identity: TableIdentity = { schema: row.schema, name: row.name };
    const object = `${row.schema}.${row.name}`;
    if (row.relkind === 'p' || row.relispartition) {
      diagnostics.push({
        kind: 'skip',
        code: 'unsupported-statement',
        object,
        message: `table ${object} is partitioned; partitioning is not represented yet`,
      });
      continue;
    }
    if (row.relpersistence === 't') {
      diagnostics.push({
        kind: 'flag',
        code: 'unsupported-attribute',
        object,
        message: `table ${object} is temporary; persistence is not represented yet`,
      });
    }
    const persistence: TablePersistence | undefined =
      row.relpersistence === 'u' ? 'unlogged' : undefined;

    const tableColumns = (columnsByTable.get(tableKey(row.schema, row.name)) ?? []).sort(
      (left, right) => left.attnum - right.attnum,
    );
    for (const column of tableColumns) {
      diagnostics.push(...columnDiagnostics(object, column));
    }

    const notNullByColumn = new Map(
      (notNullByTable.get(tableKey(row.schema, row.name)) ?? []).map((notNullRow) => [
        notNullRow.columnName,
        notNullRow,
      ]),
    );
    const notNullDiagnostics: Diagnostic[] = [];
    for (const column of tableColumns) {
      const notNullRow = notNullByColumn.get(column.name);
      if (notNullRow === undefined) continue;
      if (!notNullRow.validated) {
        notNullDiagnostics.push(
          flagDiagnostic(
            object,
            `dropped NOT VALID on not-null constraint ${notNullRow.conname} from ${object}`,
          ),
        );
      }
      if (notNullRow.noInherit) {
        notNullDiagnostics.push(
          flagDiagnostic(
            object,
            `dropped NO INHERIT on not-null constraint ${notNullRow.conname} from ${object}`,
          ),
        );
      }
    }
    diagnostics.push(...notNullDiagnostics);

    const keys = keysByTable.get(tableKey(row.schema, row.name));
    const primaryKeyMapping = primaryKeyFor(keys);
    const findings: ConstraintFinding[] = [];

    const uniqueConstraints: UniqueConstraint[] = [];
    const checkConstraints: CheckConstraint[] = [];
    const foreignKeys: ForeignKey[] = [];
    const tableConstraintRows = [
      ...(constraintsByTable.get(tableKey(row.schema, row.name)) ?? []),
    ].sort(compareConstraintRowNames);
    for (const constraintRow of tableConstraintRows) {
      validateConstraintRow(constraintRow);
      switch (constraintRow.kind) {
        case 'unique':
          uniqueConstraints.push(uniqueConstraintFromRow(constraintRow));
          findings.push(...uniqueConstraintFindings(constraintRow, object));
          break;
        case 'check':
          checkConstraints.push(checkConstraintFromRow(constraintRow));
          findings.push(...checkConstraintFindings(constraintRow, object));
          break;
        case 'foreign-key':
          foreignKeys.push(foreignKeyFromRow(constraintRow));
          findings.push(...foreignKeyFindings(constraintRow, object));
          break;
        case 'exclusion': {
          const exclusionObject = `${constraintRow.schema}.${constraintRow.conname}`;
          findings.push({
            conname: constraintRow.conname,
            diagnostic: {
              kind: 'skip',
              code: 'unsupported-statement',
              object: exclusionObject,
              message: `skipped exclusion constraint ${exclusionObject}`,
            },
          });
          break;
        }
      }
    }
    if (primaryKeyMapping?.period === true) {
      findings.push({
        conname: primaryKeyMapping.conname,
        diagnostic: flagDiagnostic(
          object,
          `dropped WITHOUT OVERLAPS on primary key ${primaryKeyMapping.conname} from ${object}`,
        ),
      });
    }
    findings.sort((left, right) => compareStrings(left.conname, right.conname));
    diagnostics.push(...findings.map((finding) => finding.diagnostic));

    const constraints = canonicalizeConstraintNames(identity, {
      ...(primaryKeyMapping === undefined ? {} : { primaryKey: primaryKeyMapping.primaryKey }),
      uniqueConstraints,
      checkConstraints,
      foreignKeys,
    });

    const tableIndexRows = [...(indexesByTable.get(tableKey(row.schema, row.name)) ?? [])].sort(
      compareIndexRowNames,
    );
    const namedIndexes: NamedIndex[] = [];
    for (const indexRow of tableIndexRows) {
      const indexObject = `${indexRow.schema}.${indexRow.indexName}`;
      if (!indexRow.valid || !indexRow.ready) {
        diagnostics.push({
          kind: 'skip',
          code: 'unsupported-statement',
          object: indexObject,
          message: `index ${indexObject} is not valid and ready; invalid indexes are not represented yet`,
        });
        continue;
      }
      const envelope = classifyIndexEnvelope(indexRow.create);
      if (envelope.kind === 'skip') {
        diagnostics.push({
          kind: 'skip',
          code: 'unsupported-statement',
          object: indexObject,
          message: `skipped CREATE INDEX ${indexObject} (${envelope.reason})`,
        });
        continue;
      }
      if (indexRow.tablespace !== null) {
        diagnostics.push({
          kind: 'flag',
          code: 'unsupported-attribute',
          object: indexObject,
          message: `index ${indexObject} is on tablespace ${indexRow.tablespace}; tablespaces are not represented yet`,
        });
      }
      namedIndexes.push({
        indexName: indexRow.indexName,
        index: { unique: envelope.unique, columns: envelope.columns },
      });
    }

    modelTables.push({
      schema: row.schema,
      name: row.name,
      columns: tableColumns.map((column): Column => {
        const notNullRow = notNullByColumn.get(column.name);
        const notNullName =
          notNullRow === undefined ||
          notNullRow.conname === synthesizedNotNullName(row.name, column.name)
            ? undefined
            : notNullRow.conname;
        const identity = identityFor(row, column, sequenceMapping.identities);
        return {
          name: column.name,
          type: column.type,
          notNull: column.attnotnull,
          ...(notNullName === undefined ? {} : { notNullName }),
          ...(identity === undefined ? {} : { identity }),
          ...columnAttributes(column),
        };
      }),
      ...(constraints.primaryKey === undefined ? {} : { primaryKey: constraints.primaryKey }),
      foreignKeys: [...constraints.foreignKeys].sort(compareForeignKeys),
      uniqueConstraints: [...constraints.uniqueConstraints].sort(compareUniqueConstraints),
      checkConstraints: [...constraints.checkConstraints].sort(compareCheckConstraints),
      indexes: canonicalizeIndexNames(identity, namedIndexes).sort(compareIndexes),
      ...(persistence === undefined ? {} : { persistence }),
    });
  }

  diagnostics.push(...sequenceMapping.diagnostics);

  return {
    model: { tables: modelTables, sequences: sequenceMapping.sequences, views: [] },
    diagnostics,
  };
}

/** The ordinary table a column, key, index, constraint, or not-null row must reference. */
function requireOrdinaryTable(
  tablesByKey: ReadonlyMap<string, TableRow>,
  key: string,
  schema: string,
  tableName: string,
  rowKind: string,
): TableRow {
  const row = tablesByKey.get(key);
  if (row === undefined) {
    throw new Error(
      `catalog payload: ${rowKind} for "${schema}.${tableName}" references an unknown table`,
    );
  }
  if (row.relkind !== 'r' || row.relispartition) {
    throw new Error(
      `catalog payload: ${rowKind} for "${schema}.${tableName}" belongs to a partitioned relation`,
    );
  }
  return row;
}

/**
 * The deferred-state flags of one ordinary table's column: generation, the one remaining
 * unmodeled column feature. Identity now attaches from the `sequences` section; the default
 * expression, the explicit collation, storage, and compression travel the model and carry no
 * flag. A generated column keeps its flag and never reads the generation expression its
 * `atthasdef` marks as a default.
 */
function columnDiagnostics(object: string, column: ColumnRow): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const flag = (text: string): void => {
    diagnostics.push({
      kind: 'flag',
      code: 'unsupported-attribute',
      object,
      message: `column ${column.name} ${text}`,
    });
  };
  if (column.attgenerated !== '') {
    flag('is generated; generation is not represented yet');
  }
  return diagnostics;
}

/** One sequence finding: its sequence row orders it among the section's findings. */
interface SequenceFinding {
  readonly row: SequenceRow;
  readonly diagnostic: Diagnostic;
}

/** One sequence owner resolved against the payload's tables. */
type ResolvedSequenceOwner =
  | { readonly kind: 'mapped'; readonly table: TableRow; readonly column: ColumnRow }
  | { readonly kind: 'unread'; readonly schema: string; readonly table: string };

/**
 * The `sequences` section to the model's sequences, the identity attachments its rows name,
 * and the section's deferred-state findings. Identity rows never become model sequences; a row
 * owned by an unread relation or a dropped attribute is consumed with a skip finding, which
 * takes precedence over its persistence flag. Duplicate names, an owner column a read table
 * does not carry, and a missing, duplicated, non-identity, or non-integer identity attachment
 * are payload-contract throws.
 */
function mapSequences(
  rows: readonly SequenceRow[],
  tablesByKey: ReadonlyMap<string, TableRow>,
  columnsByTable: ReadonlyMap<string, readonly ColumnRow[]>,
): SequenceMapping {
  const ordered = [...rows].sort(compareSequenceRows);
  const seen = new Set<string>();
  for (const row of ordered) {
    const key = tableKey(row.schema, row.name);
    if (seen.has(key)) {
      throw new Error(`catalog payload: duplicate sequence "${row.schema}.${row.name}"`);
    }
    seen.add(key);
  }

  const identities = new Map<string, MappedIdentity>();
  const sequences: Sequence[] = [];
  const findings: SequenceFinding[] = [];

  for (const row of ordered) {
    if (row.ownerKind === null) {
      sequences.push(sequenceFromRow(row));
      const finding = ordinarySequencePersistenceFinding(row);
      if (finding !== undefined) findings.push({ row, diagnostic: finding });
      continue;
    }

    const owner = resolveSequenceOwner(row, tablesByKey, columnsByTable);
    if (owner.kind === 'unread') {
      const object = `${row.schema}.${row.name}`;
      findings.push({
        row,
        diagnostic: {
          kind: 'skip',
          code: 'unsupported-statement',
          object,
          message: `sequence ${object} belongs to unread relation ${owner.schema}.${owner.table}; it is not represented`,
        },
      });
      continue;
    }

    if (row.ownerKind === 'owned') {
      sequences.push(
        sequenceFromRow(row, {
          table: { schema: owner.table.schema, name: owner.table.name },
          column: owner.column.name,
        }),
      );
      const finding = ordinarySequencePersistenceFinding(row);
      if (finding !== undefined) findings.push({ row, diagnostic: finding });
      continue;
    }

    const place = `${owner.table.schema}.${owner.table.name}.${owner.column.name}`;
    if (owner.column.attidentity === '') {
      throw new Error(
        `catalog payload: internal sequence "${row.schema}.${row.name}" is owned by column "${place}", which is not an identity column`,
      );
    }
    const columnKey = sequenceOwnerKey(owner.table.schema, owner.table.name, owner.column.name);
    if (identities.has(columnKey)) {
      throw new Error(
        `catalog payload: identity column "${place}" has more than one internal sequence`,
      );
    }
    identities.set(columnKey, { row, table: owner.table, column: owner.column });
  }

  for (const mapped of identities.values()) {
    if (mapped.row.persistence === mapped.table.relpersistence) continue;
    findings.push({ row: mapped.row, diagnostic: identityPersistenceFinding(mapped) });
  }

  findings.sort(compareSequenceFindings);
  return {
    sequences,
    identities,
    diagnostics: findings.map((finding) => finding.diagnostic),
  };
}

/**
 * A sequence row's owner reference: a mapped ordinary table with a read column, or an unread
 * relation — absent, partitioned, or with a dropped attribute. A named owner column that an
 * otherwise-read ordinary table does not carry is contract drift, as is an owned row with no
 * owner table at all.
 */
function resolveSequenceOwner(
  row: SequenceRow,
  tablesByKey: ReadonlyMap<string, TableRow>,
  columnsByTable: ReadonlyMap<string, readonly ColumnRow[]>,
): ResolvedSequenceOwner {
  if (row.ownerSchema === null || row.ownerTable === null) {
    throw new Error(
      `catalog payload: sequence "${row.schema}.${row.name}" is owned but carries no owner table`,
    );
  }
  const table = tablesByKey.get(tableKey(row.ownerSchema, row.ownerTable));
  if (table === undefined || table.relkind !== 'r' || table.relispartition) {
    return { kind: 'unread', schema: row.ownerSchema, table: row.ownerTable };
  }
  if (row.ownerColumn === null) {
    return { kind: 'unread', schema: row.ownerSchema, table: row.ownerTable };
  }
  const column = (columnsByTable.get(tableKey(table.schema, table.name)) ?? []).find(
    (candidate) => candidate.name === row.ownerColumn,
  );
  if (column === undefined) {
    throw new Error(
      `catalog payload: sequence "${row.schema}.${row.name}" is owned by column "${table.schema}.${table.name}.${row.ownerColumn}", which is not a read column of its table`,
    );
  }
  return { kind: 'mapped', table, column };
}

/** One ordinary sequence row, with its owner when it has one, in effective values. */
function sequenceFromRow(row: SequenceRow, ownedBy?: SequenceOwner): Sequence {
  return effectiveSequence({
    schema: row.schema,
    name: row.name,
    dataType: row.dataType,
    increment: row.increment,
    minValue: row.minValue,
    maxValue: row.maxValue,
    start: row.start,
    cache: row.cache,
    cycle: row.cycle,
    ...(ownedBy === undefined ? {} : { ownedBy }),
  });
}

/** The flag an ordinary sequence's non-default persistence carries; the sequence still maps. */
function ordinarySequencePersistenceFinding(row: SequenceRow): Diagnostic | undefined {
  if (row.persistence === 'p') return undefined;
  const word = row.persistence === 'u' ? 'unlogged' : 'temporary';
  return flagDiagnostic(
    `${row.schema}.${row.name}`,
    `sequence ${row.schema}.${row.name} is ${word}; ${word} sequence persistence is not represented yet`,
  );
}

/**
 * The flag an identity sequence whose persistence differs from its owning table's carries: the
 * object is the table (the column-flag grammar), and the column is named in the message. The
 * identity still attaches.
 */
function identityPersistenceFinding(identity: MappedIdentity): Diagnostic {
  const persistence = identity.row.persistence === 'u' ? 'unlogged' : 'logged';
  return flagDiagnostic(
    `${identity.table.schema}.${identity.table.name}`,
    `column ${identity.column.name}'s identity sequence ${identity.row.schema}.${identity.row.name} has ${persistence} persistence; identity persistence is not represented yet`,
  );
}

/**
 * The identity descriptor a mapped column's `attidentity` and its internal sequence row state,
 * in effective values. The row's actual name is always carried, as `pg_dump` states it; a
 * missing attachment or a non-integer column type is contract drift.
 */
function identityFor(
  table: TableRow,
  column: ColumnRow,
  identities: ReadonlyMap<string, MappedIdentity>,
): Identity | undefined {
  if (column.attidentity === '') return undefined;
  const place = `${table.schema}.${table.name}.${column.name}`;
  const mapped = identities.get(sequenceOwnerKey(table.schema, table.name, column.name));
  if (mapped === undefined) {
    throw new Error(`catalog payload: identity column "${place}" has no internal sequence`);
  }
  const dataType = canonicalIntType(column.type);
  if (dataType === undefined) {
    throw new Error(
      `catalog payload: identity column "${place}" has type "${column.type}", which is not an integer type`,
    );
  }
  return effectiveIdentity(dataType, {
    generated: identityGeneration(column.attidentity, place),
    sequenceName: { schema: mapped.row.schema, name: mapped.row.name },
    increment: mapped.row.increment,
    minValue: mapped.row.minValue,
    maxValue: mapped.row.maxValue,
    start: mapped.row.start,
    cache: mapped.row.cache,
    cycle: mapped.row.cycle,
  });
}

/** The model mode an `attidentity` letter states (`'a'` always, `'d'` by default). */
function identityGeneration(value: string, place: string): IdentityGeneration {
  if (value === 'a') return 'always';
  if (value === 'd') return 'by default';
  throw new Error(`catalog payload: identity column "${place}" has unknown attidentity "${value}"`);
}

/** The key an identity attachment groups by: table identity plus column name. */
function sequenceOwnerKey(schema: string, name: string, column: string): string {
  return `${tableKey(schema, name)}\u0000${column}`;
}

/** Payload sequence order, the order the duplicate and contract checks walk. */
function compareSequenceRows(left: SequenceRow, right: SequenceRow): number {
  return compareStrings(left.schema, right.schema) || compareStrings(left.name, right.name);
}

/** Sequence findings' order: the finding sequence's schema, then name. */
function compareSequenceFindings(left: SequenceFinding, right: SequenceFinding): number {
  return compareSequenceRows(left.row, right.row);
}

/** PostgreSQL's `attstorage` letters, as the model spells them. */
const COLUMN_STORAGE_LETTERS: Readonly<Record<string, ColumnStorage>> = {
  p: 'plain',
  e: 'external',
  x: 'extended',
  m: 'main',
};

/** PostgreSQL's `attcompression` letters, as the model spells them. */
const COLUMN_COMPRESSION_LETTERS: Readonly<Record<string, ColumnCompression>> = {
  p: 'pglz',
  l: 'lz4',
};

/**
 * The canonical column fields the catalog's explicit-only gates carry: the default expression
 * in the dump importer's normalized form and the explicit collation, storage, and compression,
 * each present exactly when the catalog states it. Absent keys stay absent — the model's
 * absent state — so a column the catalog reads clean maps byte-identically to its import.
 */
function columnAttributes(
  row: ColumnRow,
): Pick<Column, 'default' | 'collation' | 'storage' | 'compression'> {
  const defaultText = columnDefault(row);
  const collation = explicitCollation(row);
  const storage = explicitStorage(row);
  const compression = explicitCompression(row);
  return {
    ...(defaultText === undefined ? {} : { default: defaultText }),
    ...(collation === undefined ? {} : { collation }),
    ...(storage === undefined ? {} : { storage }),
    ...(compression === undefined ? {} : { compression }),
  };
}

/**
 * The default expression the row states, whitespace-normalized with the dump importer's
 * semantics (`extractDefaultText`'s), or `undefined` when there is none. A generated column
 * keeps its flag and never reads a default, and `atthasdef` without an attrdef row — a NULL
 * `pg_get_expr` — reads as no default.
 */
function columnDefault(row: ColumnRow): string | undefined {
  if (row.attgenerated !== '' || !row.atthasdef || row.default === null) return undefined;
  return normalizeSourceText(row.default);
}

/**
 * The explicit collation's `pg_dump` spelling, or `undefined` when the column's collation is
 * its type's — the catalog's explicit-only marker. The SQL already gates the same way, so the
 * spelling arrives exactly for the explicit case; the gate is repeated here because the
 * canonicalization rule is the mapper's.
 */
function explicitCollation(row: ColumnRow): string | undefined {
  if (row.attcollation === 0 || row.attcollation === row.typcollation) return undefined;
  return row.collation ?? undefined;
}

/**
 * The modeled storage method the row states explicitly — the letter mapped to its word — or
 * `undefined` when the storage is the type's. A letter outside PostgreSQL's set is a payload
 * contract violation.
 */
function explicitStorage(row: ColumnRow): ColumnStorage | undefined {
  if (row.attstorage === row.typstorage) return undefined;
  const storage = COLUMN_STORAGE_LETTERS[row.attstorage];
  if (storage === undefined) {
    throw new Error(`catalog payload: unknown attstorage letter "${row.attstorage}"`);
  }
  return storage;
}

/**
 * The modeled compression method the row states explicitly — the letter mapped to its word —
 * or `undefined` when no method is stated (the empty string on the PostgreSQL 13 floor
 * included). A letter outside PostgreSQL's set is a payload contract violation.
 */
function explicitCompression(row: ColumnRow): ColumnCompression | undefined {
  if (row.attcompression === '') return undefined;
  const compression = COLUMN_COMPRESSION_LETTERS[row.attcompression];
  if (compression === undefined) {
    throw new Error(`catalog payload: unknown attcompression letter "${row.attcompression}"`);
  }
  return compression;
}

/** One table's primary key before conventional-name stripping. */
interface PrimaryKeyMapping {
  readonly conname: string;
  readonly primaryKey: PrimaryKey;
  readonly period: boolean;
}

/**
 * The table's primary key from its key rows: columns in key order, the deferrability the rows
 * carry, and the stored name (the canonicalizer strips the conventional form). The grouping
 * pass already requires every row of one primary key to agree on `conname`, deferrability, and
 * the temporal flag.
 */
function primaryKeyFor(rows: readonly PrimaryKeyRow[] | undefined): PrimaryKeyMapping | undefined {
  if (rows === undefined || rows.length === 0) return undefined;
  const ordered = [...rows].sort((left, right) => left.ordinal - right.ordinal);
  const first = ordered[0]!;
  const primaryKey: Mutable<PrimaryKey> = {
    name: first.conname,
    columns: ordered.map((row) => row.attname),
  };
  applyRowDeferrability(first, primaryKey);
  return { conname: first.conname, primaryKey, period: first.period };
}

/** Applies the catalog's deferrability pair to a constraint, `INITIALLY DEFERRED` implying it. */
function applyRowDeferrability(
  row: { readonly deferrable: boolean | null; readonly deferred: boolean | null },
  target: Mutable<PrimaryKey | UniqueConstraint | ForeignKey>,
): void {
  if (row.deferrable === true || row.deferred === true) target.deferrable = true;
  if (row.deferred === true) target.initiallyDeferred = true;
}

/**
 * The per-kind non-null matrix: a field the kind requires must be present, and a field outside
 * the kind's read set must be null, so a uniform row cannot smuggle a contradictory state past
 * the mapper. The check kind's deferrability pair is optional — it is read only for the
 * defensive diagnostic — and everything else is exact.
 */
function validateConstraintRow(row: ConstraintRow): void {
  const place = `${row.schema}.${row.tableName}.${row.conname}`;
  const requirePresent = (fields: readonly (keyof ConstraintRow)[]): void => {
    for (const field of fields) {
      if (row[field] === null) {
        throw new Error(`catalog payload: ${row.kind} constraint "${place}" is missing ${field}`);
      }
    }
  };
  const requireAbsent = (fields: readonly (keyof ConstraintRow)[]): void => {
    for (const field of fields) {
      if (row[field] !== null) {
        throw new Error(
          `catalog payload: ${row.kind} constraint "${place}" carries ${field} outside its kind`,
        );
      }
    }
  };
  switch (row.kind) {
    case 'unique':
      requirePresent([
        'columns',
        'deferrable',
        'deferred',
        'validated',
        'nullsNotDistinct',
        'including',
        'period',
      ]);
      requireAbsent([
        'expression',
        'referencedSchema',
        'referencedTable',
        'referencedColumns',
        'onUpdate',
        'onDelete',
        'matchType',
        'deleteSetColumnList',
        'enforced',
        'noInherit',
      ]);
      return;
    case 'check':
      requirePresent(['expression', 'validated', 'enforced', 'noInherit']);
      requireAbsent([
        'columns',
        'referencedSchema',
        'referencedTable',
        'referencedColumns',
        'onUpdate',
        'onDelete',
        'matchType',
        'deleteSetColumnList',
        'nullsNotDistinct',
        'including',
        'period',
      ]);
      return;
    case 'foreign-key':
      requirePresent([
        'columns',
        'referencedSchema',
        'referencedTable',
        'referencedColumns',
        'onUpdate',
        'onDelete',
        'matchType',
        'deleteSetColumnList',
        'deferrable',
        'deferred',
        'validated',
        'enforced',
        'period',
      ]);
      requireAbsent(['expression', 'noInherit', 'nullsNotDistinct', 'including']);
      return;
    case 'exclusion':
      requireAbsent([
        'columns',
        'expression',
        'referencedSchema',
        'referencedTable',
        'referencedColumns',
        'onUpdate',
        'onDelete',
        'matchType',
        'deleteSetColumnList',
        'deferrable',
        'deferred',
        'validated',
        'enforced',
        'noInherit',
        'nullsNotDistinct',
        'including',
        'period',
      ]);
  }
}

/** One unique constraint row as the model spells it; the caller adds the diagnostics. */
function uniqueConstraintFromRow(row: ConstraintRow): UniqueConstraint {
  const uniqueConstraint: Mutable<UniqueConstraint> = {
    name: row.conname,
    columns: [...row.columns!],
  };
  applyRowDeferrability(row, uniqueConstraint);
  return uniqueConstraint;
}

/** The unique constraint's unrepresentable attributes, in the pinned order. */
function uniqueConstraintFindings(row: ConstraintRow, object: string): ConstraintFinding[] {
  const findings: ConstraintFinding[] = [];
  if (row.nullsNotDistinct === true) {
    findings.push(constraintFlag(row, object, 'NULLS NOT DISTINCT'));
  }
  if (row.including === true) findings.push(constraintFlag(row, object, 'INCLUDE'));
  if (row.period === true) findings.push(constraintFlag(row, object, 'WITHOUT OVERLAPS'));
  if (row.validated === false) findings.push(constraintFlag(row, object, 'NOT VALID'));
  return findings;
}

/** One check constraint row as the model spells it; the expression is normalized, not rewritten. */
function checkConstraintFromRow(row: ConstraintRow): CheckConstraint {
  const checkConstraint: Mutable<CheckConstraint> = {
    name: row.conname,
    expression: normalizeSourceText(row.expression!),
  };
  const enforcement = constraintEnforcementFromRow(row);
  if (enforcement !== undefined) checkConstraint.enforcement = enforcement;
  return checkConstraint;
}

/** The check constraint's unrepresentable attributes: `NO INHERIT`, then deferrability. */
function checkConstraintFindings(row: ConstraintRow, object: string): ConstraintFinding[] {
  const findings: ConstraintFinding[] = [];
  if (row.noInherit === true) findings.push(constraintFlag(row, object, 'NO INHERIT'));
  if (row.deferrable === true || row.deferred === true) {
    findings.push(constraintFlag(row, object, 'deferrability'));
  }
  return findings;
}

/** One foreign key row as the model spells it; `NO ACTION` stays absent as the importer models it. */
function foreignKeyFromRow(row: ConstraintRow): ForeignKey {
  const foreignKey: Mutable<ForeignKey> = {
    name: row.conname,
    columns: [...row.columns!],
    referencedTable: { schema: row.referencedSchema!, name: row.referencedTable! },
    referencedColumns: [...row.referencedColumns!],
  };
  const onUpdate = referentialAction(row.onUpdate ?? undefined);
  if (onUpdate !== undefined) foreignKey.onUpdate = onUpdate;
  const onDelete = referentialAction(row.onDelete ?? undefined);
  if (onDelete !== undefined) foreignKey.onDelete = onDelete;
  const enforcement = constraintEnforcementFromRow(row);
  if (enforcement !== undefined) foreignKey.enforcement = enforcement;
  applyRowDeferrability(row, foreignKey);
  return foreignKey;
}

/** The foreign key's unrepresentable attributes, in the importer's order. */
function foreignKeyFindings(row: ConstraintRow, object: string): ConstraintFinding[] {
  const findings: ConstraintFinding[] = [];
  if (row.matchType === 'f') findings.push(constraintFlag(row, object, 'MATCH FULL'));
  if (row.matchType === 'p') findings.push(constraintFlag(row, object, 'MATCH PARTIAL'));
  if (row.deleteSetColumnList === true) findings.push(constraintFlag(row, object, 'column list'));
  if (row.period === true) findings.push(constraintFlag(row, object, 'PERIOD'));
  return findings;
}

/**
 * The enforcement pair the catalog states, decoded into the model's three reachable states:
 * valid and enforced is the absent default, not validated but enforced is `not-valid`, and
 * neither is `not-enforced` (the combined `NOT VALID NOT ENFORCED` collapses there, as the
 * server reports it). Validated but not enforced is unreachable and a contract throw.
 */
function constraintEnforcementFromRow(row: ConstraintRow): ConstraintEnforcement | undefined {
  if (row.validated === true && row.enforced === true) return undefined;
  if (row.validated === false && row.enforced === true) return 'not-valid';
  if (row.validated === false && row.enforced === false) return 'not-enforced';
  throw new Error(
    `catalog payload: constraint "${row.schema}.${row.tableName}.${row.conname}" is validated but not enforced`,
  );
}

/** One folded constraint finding: its stored name orders it among the table's findings. */
interface ConstraintFinding {
  readonly conname: string;
  readonly diagnostic: Diagnostic;
}

/** A constraint flag in the importer's grammar: `dropped <attribute> on <kind> <name> from <object>`. */
function constraintFlag(
  row: ConstraintRow,
  object: string,
  description: string,
): ConstraintFinding {
  const label =
    row.kind === 'unique'
      ? 'unique constraint'
      : row.kind === 'check'
        ? 'check constraint'
        : 'foreign key';
  return {
    conname: row.conname,
    diagnostic: flagDiagnostic(
      object,
      `dropped ${description} on ${label} ${row.conname} from ${object}`,
    ),
  };
}

/** A flag diagnostic with the import module's code and grammar; `position` stays absent. */
function flagDiagnostic(object: string, message: string): Diagnostic {
  return { kind: 'flag', code: 'unsupported-attribute', object, message };
}

/** The identity key that never collides across dot-carrying names, as `import.ts` keys them. */
function tableKey(schema: string, name: string): string {
  return `${schema}\u0000${name}`;
}

/** One classified catalog index: the stored index name beside the model index's structure. */
export interface NamedIndex {
  readonly indexName: string;
  readonly index: Index;
}

/**
 * Canonicalizes server-generated index names back to unnamed, mirroring the dump importer's
 * `canonicalizeIndexNames`: a stored name equal to `synthesizedIndexName` — the server form,
 * PostgreSQL's 63-byte truncation included — is stripped, unless an unnamed entry with the
 * same structure key already exists, in which case the name is kept. Rows must arrive in
 * stored-name order; stripped entries keep that order among themselves, and the caller
 * stable-sorts by `name ?? ''` exactly as `finalizeTable` does. In a live catalog every row
 * arrives named and same-schema index names are unique, so two strippable names cannot
 * collide: the guard is unreachable there, kept for parity with the importer and pinned by
 * the unit suite. Exported for the unit suite alongside `mapCatalog`; deliberately not
 * re-exported from `index.ts`.
 */
export function canonicalizeIndexNames(
  identity: TableIdentity,
  rows: readonly NamedIndex[],
): Index[] {
  const seen = new Set<string>();
  const indexes: Index[] = [];
  for (const row of rows) {
    const structure: { name?: string; unique: boolean; columns: string[] } = {
      unique: row.index.unique,
      columns: [...row.index.columns],
    };
    const key = indexStructureKey(structure);
    if (row.indexName === synthesizedIndexName(identity, structure) && !seen.has(key)) {
      seen.add(key);
    } else {
      structure.name = row.indexName;
    }
    indexes.push(structure);
  }
  return indexes;
}

/** A table's constraints as the catalog read stores them, arrays in stored-name order. */
export interface CatalogConstraints {
  readonly primaryKey?: PrimaryKey;
  readonly uniqueConstraints: readonly UniqueConstraint[];
  readonly checkConstraints: readonly CheckConstraint[];
  readonly foreignKeys: readonly ForeignKey[];
}

/**
 * Canonicalizes server-generated constraint names back to unnamed, mirroring the dump
 * importer's `canonicalizeConstraintNames`: the primary key strips iff its stored name equals
 * the prediction for the table — no twin guard, since PostgreSQL allows one primary key per
 * table — while a unique constraint, check constraint, or foreign key strips iff its stored
 * name equals the prediction and no entry with the same structure key is already unnamed or
 * was stripped earlier, in which case the name is kept. Rows must arrive in stored-name order;
 * in a live catalog every row arrives named and per-table constraint names are unique, so two
 * strippable names cannot collide: the guard is unreachable there, kept for parity with the
 * importer and pinned by the unit suite. Exported for the unit suite alongside `mapCatalog`;
 * deliberately not re-exported from `index.ts`.
 */
export function canonicalizeConstraintNames(
  identity: TableIdentity,
  constraints: CatalogConstraints,
): CatalogConstraints {
  const seenUnique = new Set<string>();
  const seenForeign = new Set<string>();
  const seenCheck = new Set<string>();

  // Pre-scan the unnamed entries of each kind, then strip in a second, position-independent pass.
  for (const uniqueConstraint of constraints.uniqueConstraints) {
    if (uniqueConstraint.name === undefined) {
      seenUnique.add(uniqueConstraintStructureKey(uniqueConstraint));
    }
  }
  for (const foreignKey of constraints.foreignKeys) {
    if (foreignKey.name === undefined) seenForeign.add(foreignKeyStructureKey(foreignKey));
  }
  for (const checkConstraint of constraints.checkConstraints) {
    if (checkConstraint.name === undefined) {
      seenCheck.add(checkConstraintStructureKey(checkConstraint));
    }
  }

  let primaryKey = constraints.primaryKey;
  if (primaryKey !== undefined && primaryKey.name === synthesizedPrimaryKeyName(identity)) {
    primaryKey = withoutName(primaryKey);
  }

  const uniqueConstraints = constraints.uniqueConstraints.map((uniqueConstraint) => {
    if (uniqueConstraint.name !== synthesizedUniqueConstraintName(identity, uniqueConstraint)) {
      return uniqueConstraint;
    }
    const key = uniqueConstraintStructureKey(uniqueConstraint);
    if (seenUnique.has(key)) return uniqueConstraint;
    seenUnique.add(key);
    return withoutName(uniqueConstraint);
  });
  const foreignKeys = constraints.foreignKeys.map((foreignKey) => {
    if (foreignKey.name !== synthesizedForeignKeyName(identity, foreignKey)) return foreignKey;
    const key = foreignKeyStructureKey(foreignKey);
    if (seenForeign.has(key)) return foreignKey;
    seenForeign.add(key);
    return withoutName(foreignKey);
  });
  const checkConstraints = constraints.checkConstraints.map((checkConstraint) => {
    if (checkConstraint.name !== synthesizedCheckConstraintName(identity, checkConstraint)) {
      return checkConstraint;
    }
    const key = checkConstraintStructureKey(checkConstraint);
    if (seenCheck.has(key)) return checkConstraint;
    seenCheck.add(key);
    return withoutName(checkConstraint);
  });

  return {
    ...(primaryKey === undefined ? {} : { primaryKey }),
    uniqueConstraints,
    checkConstraints,
    foreignKeys,
  };
}

/** A copy of a constraint without its `name`, the unnamed model state. */
function withoutName<Constraint extends { readonly name?: string }>(
  constraint: Constraint,
): Constraint {
  const copy: Mutable<Constraint> = { ...constraint };
  delete copy.name;
  return copy;
}

/** Canonical table order: schema, then name, plain string comparison. */
function compareTableRows(left: TableRow, right: TableRow): number {
  if (left.schema !== right.schema) return left.schema < right.schema ? -1 : 1;
  if (left.name !== right.name) return left.name < right.name ? -1 : 1;
  return 0;
}

/** Stored index-name order, the order the strip pass walks; plain string comparison. */
function compareIndexRowNames(left: IndexRow, right: IndexRow): number {
  if (left.indexName !== right.indexName) return left.indexName < right.indexName ? -1 : 1;
  return 0;
}

/** Stored constraint-name order, the order the strip pass and the findings walk. */
function compareConstraintRowNames(left: ConstraintRow, right: ConstraintRow): number {
  return compareStrings(left.conname, right.conname);
}

/** Canonical index order: `name ?? ''`, plain string comparison, as `finalizeTable` sorts. */
function compareIndexes(left: Index, right: Index): number {
  const leftName = left.name ?? '';
  const rightName = right.name ?? '';
  if (leftName !== rightName) return leftName < rightName ? -1 : 1;
  return 0;
}

/** Canonical foreign-key order, mirroring core's `compareForeignKeys`. */
function compareForeignKeys(left: ForeignKey, right: ForeignKey): number {
  return (
    compareStringArrays(left.columns, right.columns) ||
    compareStrings(left.referencedTable.schema, right.referencedTable.schema) ||
    compareStrings(left.referencedTable.name, right.referencedTable.name) ||
    compareStrings(left.name ?? '', right.name ?? '')
  );
}

/** Canonical unique-constraint order, mirroring core's `compareUniqueConstraints`. */
function compareUniqueConstraints(left: UniqueConstraint, right: UniqueConstraint): number {
  return (
    compareStringArrays(left.columns, right.columns) ||
    compareStrings(left.name ?? '', right.name ?? '')
  );
}

/** Canonical check-constraint order, mirroring core's `compareCheckConstraints`. */
function compareCheckConstraints(left: CheckConstraint, right: CheckConstraint): number {
  return (
    compareStrings(left.expression, right.expression) ||
    compareStrings(left.name ?? '', right.name ?? '')
  );
}

/** Plain string comparison, the order every comparator above builds on. */
function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Element-wise string-array comparison with length as the final tiebreak. */
function compareStringArrays(left: readonly string[], right: readonly string[]): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const comparison = compareStrings(left[index]!, right[index]!);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

/** The payload value as a plain object, or a contract throw. */
function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** The record's field as an array, or a contract throw. */
function expectArray(
  record: Record<string, unknown>,
  field: string,
  path: string,
): readonly unknown[] {
  const value = record[field];
  if (!Array.isArray(value)) {
    throw new Error(`${path}.${field} must be an array`);
  }
  return value;
}

/** No field outside the contract's shape, as `workspace.ts` reads: fail closed on drift. */
function expectFields(
  row: Record<string, unknown>,
  path: string,
  allowed: readonly string[],
): void {
  for (const field of Object.keys(row)) {
    if (!allowed.includes(field)) {
      throw new Error(`${path} carries an unknown field "${field}"`);
    }
  }
}

/** The field as a string, or a contract throw. */
function expectString(row: Record<string, unknown>, path: string, field: string): string {
  const value = row[field];
  if (typeof value !== 'string') {
    throw new Error(`${path}.${field} must be a string`);
  }
  return value;
}

/** The field as a boolean, or a contract throw. */
function expectBoolean(row: Record<string, unknown>, path: string, field: string): boolean {
  const value = row[field];
  if (typeof value !== 'boolean') {
    throw new Error(`${path}.${field} must be a boolean`);
  }
  return value;
}

/** The field as a string or null, or a contract throw. */
function expectNullableString(
  row: Record<string, unknown>,
  path: string,
  field: string,
): string | null {
  const value = row[field];
  if (value === null || typeof value === 'string') return value;
  throw new Error(`${path}.${field} must be a string or null`);
}

/** The field as a boolean or null, or a contract throw. */
function expectNullableBoolean(
  row: Record<string, unknown>,
  path: string,
  field: string,
): boolean | null {
  const value = row[field];
  if (value === null || typeof value === 'boolean') return value;
  throw new Error(`${path}.${field} must be a boolean or null`);
}

/** The field as an array of strings or null, or a contract throw. */
function expectNullableStringArray(
  row: Record<string, unknown>,
  path: string,
  field: string,
): readonly string[] | null {
  const value = row[field];
  if (value === null) return null;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${path}.${field} must be an array of strings or null`);
  }
  return value as readonly string[];
}

/** The field as an integer of at least `minimum`, or a contract throw. */
function expectInteger(
  row: Record<string, unknown>,
  path: string,
  field: string,
  minimum: number,
): number {
  const value = row[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    throw new Error(`${path}.${field} must be an integer >= ${minimum}`);
  }
  return value;
}

/** A `tables` row, validated field by field. */
function parseTableRow(value: unknown, path: string): TableRow {
  const row = expectObject(value, path);
  expectFields(row, path, ['schema', 'name', 'relkind', 'relispartition', 'relpersistence']);
  const relkind = expectString(row, path, 'relkind');
  if (relkind !== 'r' && relkind !== 'p') {
    throw new Error(`${path}.relkind must be "r" or "p"`);
  }
  const relpersistence = expectString(row, path, 'relpersistence');
  if (relpersistence !== 'p' && relpersistence !== 'u' && relpersistence !== 't') {
    throw new Error(`${path}.relpersistence must be "p", "u", or "t"`);
  }
  return {
    schema: expectString(row, path, 'schema'),
    name: expectString(row, path, 'name'),
    relkind,
    relispartition: expectBoolean(row, path, 'relispartition'),
    relpersistence,
  };
}

/** A `columns` row, validated field by field. */
function parseColumnRow(value: unknown, path: string): ColumnRow {
  const row = expectObject(value, path);
  expectFields(row, path, [
    'schema',
    'tableName',
    'attnum',
    'name',
    'type',
    'attnotnull',
    'attidentity',
    'attgenerated',
    'atthasdef',
    'default',
    'attcollation',
    'typcollation',
    'collation',
    'attstorage',
    'typstorage',
    'attcompression',
  ]);
  return {
    schema: expectString(row, path, 'schema'),
    tableName: expectString(row, path, 'tableName'),
    attnum: expectInteger(row, path, 'attnum', 1),
    name: expectString(row, path, 'name'),
    type: expectString(row, path, 'type'),
    attnotnull: expectBoolean(row, path, 'attnotnull'),
    attidentity: expectString(row, path, 'attidentity'),
    attgenerated: expectString(row, path, 'attgenerated'),
    atthasdef: expectBoolean(row, path, 'atthasdef'),
    default: expectNullableString(row, path, 'default'),
    attcollation: expectInteger(row, path, 'attcollation', 0),
    typcollation: expectInteger(row, path, 'typcollation', 0),
    collation: expectNullableString(row, path, 'collation'),
    attstorage: expectString(row, path, 'attstorage'),
    typstorage: expectString(row, path, 'typstorage'),
    attcompression: expectString(row, path, 'attcompression'),
  };
}

/** A `primaryKeys` row, validated field by field. */
function parsePrimaryKeyRow(value: unknown, path: string): PrimaryKeyRow {
  const row = expectObject(value, path);
  expectFields(row, path, [
    'schema',
    'tableName',
    'conname',
    'ordinal',
    'attname',
    'deferrable',
    'deferred',
    'period',
  ]);
  return {
    schema: expectString(row, path, 'schema'),
    tableName: expectString(row, path, 'tableName'),
    conname: expectString(row, path, 'conname'),
    ordinal: expectInteger(row, path, 'ordinal', 1),
    attname: expectString(row, path, 'attname'),
    deferrable: expectBoolean(row, path, 'deferrable'),
    deferred: expectBoolean(row, path, 'deferred'),
    period: expectBoolean(row, path, 'period'),
  };
}

/** A `constraints` row, validated field by field; the per-kind matrix is the mapper's check. */
function parseConstraintRow(value: unknown, path: string): ConstraintRow {
  const row = expectObject(value, path);
  expectFields(row, path, [
    'schema',
    'tableName',
    'conname',
    'kind',
    'columns',
    'expression',
    'referencedSchema',
    'referencedTable',
    'referencedColumns',
    'onUpdate',
    'onDelete',
    'matchType',
    'deleteSetColumnList',
    'deferrable',
    'deferred',
    'validated',
    'enforced',
    'noInherit',
    'nullsNotDistinct',
    'including',
    'period',
  ]);
  const kind = expectString(row, path, 'kind');
  if (kind !== 'unique' && kind !== 'check' && kind !== 'foreign-key' && kind !== 'exclusion') {
    throw new Error(`${path}.kind must be "unique", "check", "foreign-key", or "exclusion"`);
  }
  return {
    schema: expectString(row, path, 'schema'),
    tableName: expectString(row, path, 'tableName'),
    conname: expectString(row, path, 'conname'),
    kind,
    columns: expectNullableStringArray(row, path, 'columns'),
    expression: expectNullableString(row, path, 'expression'),
    referencedSchema: expectNullableString(row, path, 'referencedSchema'),
    referencedTable: expectNullableString(row, path, 'referencedTable'),
    referencedColumns: expectNullableStringArray(row, path, 'referencedColumns'),
    onUpdate: expectNullableString(row, path, 'onUpdate'),
    onDelete: expectNullableString(row, path, 'onDelete'),
    matchType: expectNullableString(row, path, 'matchType'),
    deleteSetColumnList: expectNullableBoolean(row, path, 'deleteSetColumnList'),
    deferrable: expectNullableBoolean(row, path, 'deferrable'),
    deferred: expectNullableBoolean(row, path, 'deferred'),
    validated: expectNullableBoolean(row, path, 'validated'),
    enforced: expectNullableBoolean(row, path, 'enforced'),
    noInherit: expectNullableBoolean(row, path, 'noInherit'),
    nullsNotDistinct: expectNullableBoolean(row, path, 'nullsNotDistinct'),
    including: expectNullableBoolean(row, path, 'including'),
    period: expectNullableBoolean(row, path, 'period'),
  };
}

/** A `notNullConstraints` row, validated field by field. */
function parseNotNullConstraintRow(value: unknown, path: string): NotNullConstraintRow {
  const row = expectObject(value, path);
  expectFields(row, path, [
    'schema',
    'tableName',
    'columnName',
    'conname',
    'validated',
    'noInherit',
  ]);
  return {
    schema: expectString(row, path, 'schema'),
    tableName: expectString(row, path, 'tableName'),
    columnName: expectString(row, path, 'columnName'),
    conname: expectString(row, path, 'conname'),
    validated: expectBoolean(row, path, 'validated'),
    noInherit: expectBoolean(row, path, 'noInherit'),
  };
}

/** An `indexes` row, validated field by field, with its definition parsed. */
async function parseIndexRow(value: unknown, path: string): Promise<IndexRow> {
  const row = expectObject(value, path);
  expectFields(row, path, [
    'schema',
    'tableName',
    'indexName',
    'definition',
    'valid',
    'ready',
    'tablespace',
  ]);
  const definition = expectString(row, path, 'definition');
  return {
    schema: expectString(row, path, 'schema'),
    tableName: expectString(row, path, 'tableName'),
    indexName: expectString(row, path, 'indexName'),
    valid: expectBoolean(row, path, 'valid'),
    ready: expectBoolean(row, path, 'ready'),
    tablespace: expectNullableString(row, path, 'tablespace'),
    create: await parseIndexDefinition(definition, path),
  };
}

/** A `sequences` row, validated field by field; the mapper resolves its owner references. */
function parseSequenceRow(value: unknown, path: string): SequenceRow {
  const row = expectObject(value, path);
  expectFields(row, path, [
    'schema',
    'name',
    'dataType',
    'start',
    'increment',
    'minValue',
    'maxValue',
    'cache',
    'cycle',
    'persistence',
    'ownerKind',
    'ownerSchema',
    'ownerTable',
    'ownerColumn',
  ]);
  const dataType = expectString(row, path, 'dataType');
  if (dataType !== 'smallint' && dataType !== 'integer' && dataType !== 'bigint') {
    throw new Error(`${path}.dataType must be "smallint", "integer", or "bigint"`);
  }
  const persistence = expectString(row, path, 'persistence');
  if (persistence !== 'p' && persistence !== 'u' && persistence !== 't') {
    throw new Error(`${path}.persistence must be "p", "u", or "t"`);
  }
  const ownerKind = expectNullableString(row, path, 'ownerKind');
  if (ownerKind !== null && ownerKind !== 'owned' && ownerKind !== 'identity') {
    throw new Error(`${path}.ownerKind must be "owned", "identity", or null`);
  }
  return {
    schema: expectString(row, path, 'schema'),
    name: expectString(row, path, 'name'),
    dataType,
    start: expectString(row, path, 'start'),
    increment: expectString(row, path, 'increment'),
    minValue: expectString(row, path, 'minValue'),
    maxValue: expectString(row, path, 'maxValue'),
    cache: expectString(row, path, 'cache'),
    cycle: expectBoolean(row, path, 'cycle'),
    persistence,
    ownerKind,
    ownerSchema: expectNullableString(row, path, 'ownerSchema'),
    ownerTable: expectNullableString(row, path, 'ownerTable'),
    ownerColumn: expectNullableString(row, path, 'ownerColumn'),
  };
}

/** The `IndexStmt` one definition parses to, or a contract throw. */
async function parseIndexDefinition(definition: string, path: string): Promise<IndexStmt> {
  let result;
  try {
    result = await parse(definition);
  } catch (error) {
    throw new Error(`${path}.definition is not parseable: ${reason(error)}`, { cause: error });
  }
  const statement = result.stmts?.[0]?.stmt;
  if (result.stmts?.length !== 1 || statement === undefined || !('IndexStmt' in statement)) {
    throw new Error(`${path}.definition is not a CREATE INDEX statement`);
  }
  return statement.IndexStmt;
}

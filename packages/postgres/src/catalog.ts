/**
 * Live catalog reads: the `CatalogReader` seam binding for a live PostgreSQL server.
 *
 * The transport is the `psql` binary — the live harness's choice, so no client-library
 * dependency is added. One `-c` batch carries one `SELECT` returning one `json` document with
 * the `tables`, `columns`, and `primaryKeys` sections; `psql` runs a single `-c` batch as one
 * implicit transaction, so the three sections share one snapshot. The child environment's
 * `PGOPTIONS` sets `search_path=''` — the congruence with `pg_dump`, which reads the catalog
 * under the same empty path, so `format_type`'s spelling matches the dumped DDL — and
 * `default_transaction_read_only=on` as read-only posture. The read itself is the single
 * `SELECT`, so nothing about it writes; PostgreSQL 13 or newer is assumed (the harness's own
 * floor). `attcompression` exists only from PostgreSQL 14, so it is read through the row's
 * `jsonb` form: on 13 the key is absent and the column reports no explicit compression.
 *
 * Failure handling is a split. Transport failures (spawn error, non-zero exit, unparseable
 * JSON output) and any violation of the `SELECT`'s own payload contract — a missing or
 * wrong-typed field, an unknown or duplicate relation, orphan column or primary-key rows —
 * throw an `Error` carrying the reason. Diagnostics are only for sane-but-deferred catalog
 * state: a partitioned relation is skipped and named, unlogged or temporary persistence is
 * flagged on an imported table, and the column features the model does not carry — defaults,
 * generation, identity, explicit collation, storage, and compression — are each flagged and
 * named. Every diagnostic keeps the import module's grammar: `object` is `<schema>.<table>`
 * and the column, when relevant, is named in `message`; `position` is never set.
 *
 * The pure half, `mapCatalog`, takes the parsed payload to the model and diagnostics; it is
 * exported for the unit suite but deliberately not re-exported from `index.ts`, which carries
 * only the seam binding.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  CatalogReader,
  Column,
  Diagnostic,
  Model,
  PrimaryKey,
  ReadResult,
  Table,
  TableIdentity,
} from '@schemamill/core';

import { synthesizedPrimaryKeyName } from './names.ts';

const execFileAsync = promisify(execFile);

/** The cap on `psql` output; large-catalog streaming is deferred. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** The child environment's startup options: empty `search_path` congruence, read-only posture. */
const CHILD_PGOPTIONS = '-c search_path= -c default_transaction_read_only=on';

/**
 * The one read: a single `json` document with the tables, columns, and primary keys of every
 * user schema, system schemas excluded. Tables carry what the deferred-states pass needs
 * (`relkind`, `relispartition`, `relpersistence`); columns are read for ordinary tables only,
 * in attribute order, with the type spelling `format_type` gives; primary-key rows carry the
 * constraint name, the key position, and the column name.
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
        attribute.attcollation::bigint AS attcollation,
        attribute_type.typcollation::bigint AS typcollation,
        attribute.attstorage AS attstorage,
        attribute_type.typstorage AS typstorage,
        COALESCE(to_jsonb(attribute) ->> 'attcompression', '') AS attcompression
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = relation.oid
      LEFT JOIN pg_catalog.pg_type AS attribute_type ON attribute_type.oid = attribute.atttypid
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
        key_attribute.attname AS attname
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
  ), '[]'::json)
) AS document
`.trim();

/**
 * Reads `connection` — a libpq connection URI — into the canonical model, with diagnostics for
 * the catalog state the tracer does not represent. Throws on transport failure, unparseable
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
  readonly attcollation: number;
  readonly typcollation: number;
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
}

/**
 * The pure mapper: a validated payload — the `SELECT`'s parsed `json` document — to the
 * canonical model and its diagnostics. Tables come back in canonical order (schema, then name,
 * plain string comparison) and columns in attribute order regardless of payload order, since
 * the model's ordering contract is the mapper's, not SQL's collation's. Contract violations
 * throw; only the deferred catalog states become diagnostics, in canonical table order with
 * table-level flags before a table's column flags and columns in attribute order.
 */
export function mapCatalog(payload: unknown): ReadResult<Model, Diagnostic> {
  const document = expectObject(payload, 'catalog payload');
  expectFields(document, 'catalog payload', ['tables', 'columns', 'primaryKeys']);
  const tables = expectArray(document, 'tables', 'catalog payload').map((row, index) =>
    parseTableRow(row, `catalog payload.tables[${index}]`),
  );
  const columns = expectArray(document, 'columns', 'catalog payload').map((row, index) =>
    parseColumnRow(row, `catalog payload.columns[${index}]`),
  );
  const keyRows = expectArray(document, 'primaryKeys', 'catalog payload').map((row, index) =>
    parsePrimaryKeyRow(row, `catalog payload.primaryKeys[${index}]`),
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
    tableKeys.push(keyRow);
  }

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
    if (row.relpersistence !== 'p') {
      const persistence = row.relpersistence === 'u' ? 'unlogged' : 'temporary';
      diagnostics.push({
        kind: 'flag',
        code: 'unsupported-attribute',
        object,
        message: `table ${object} is ${persistence}; persistence is not represented yet`,
      });
    }

    const tableColumns = (columnsByTable.get(tableKey(row.schema, row.name)) ?? []).sort(
      (left, right) => left.attnum - right.attnum,
    );
    for (const column of tableColumns) {
      diagnostics.push(...columnDiagnostics(object, column));
    }

    const primaryKey = primaryKeyFor(identity, keysByTable.get(tableKey(row.schema, row.name)));
    modelTables.push({
      schema: row.schema,
      name: row.name,
      columns: tableColumns.map((column): Column => ({
        name: column.name,
        type: column.type,
        notNull: column.attnotnull,
      })),
      ...(primaryKey === undefined ? {} : { primaryKey }),
      foreignKeys: [],
      uniqueConstraints: [],
      checkConstraints: [],
      indexes: [],
    });
  }

  return { model: { tables: modelTables, sequences: [] }, diagnostics };
}

/** The ordinary table a column or primary-key row must reference, or a contract throw. */
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

/** The deferred-state flags of one ordinary table's column, in the pinned cause order. */
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
  } else if (column.atthasdef) {
    flag('has a default; defaults are not read yet');
  }
  if (column.attidentity !== '') {
    flag('is an identity column; identity is not read yet');
  }
  if (column.attcollation !== 0 && column.attcollation !== column.typcollation) {
    flag('has an explicit collation; collation is not represented yet');
  }
  if (column.attstorage !== column.typstorage) {
    flag('has an explicit storage setting; storage is not represented yet');
  }
  if (column.attcompression !== '') {
    flag('has an explicit compression setting; compression is not represented yet');
  }
  return diagnostics;
}

/**
 * The table's primary key from its key rows: columns in key order, and the server's
 * conventional name stripped back to unnamed iff it is exactly the prediction for the table —
 * the same canonicalization the dump importer performs, with no twin guard a primary key does
 * not need.
 */
function primaryKeyFor(
  identity: TableIdentity,
  rows: readonly PrimaryKeyRow[] | undefined,
): PrimaryKey | undefined {
  if (rows === undefined || rows.length === 0) return undefined;
  const ordered = [...rows].sort((left, right) => left.ordinal - right.ordinal);
  const columns = ordered.map((row) => row.attname);
  const name = ordered[0]!.conname;
  return name === synthesizedPrimaryKeyName(identity) ? { columns } : { name, columns };
}

/** The identity key that never collides across dot-carrying names, as `import.ts` keys them. */
function tableKey(schema: string, name: string): string {
  return `${schema}\u0000${name}`;
}

/** Canonical table order: schema, then name, plain string comparison. */
function compareTableRows(left: TableRow, right: TableRow): number {
  if (left.schema !== right.schema) return left.schema < right.schema ? -1 : 1;
  if (left.name !== right.name) return left.name < right.name ? -1 : 1;
  return 0;
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
    'attcollation',
    'typcollation',
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
    attcollation: expectInteger(row, path, 'attcollation', 0),
    typcollation: expectInteger(row, path, 'typcollation', 0),
    attstorage: expectString(row, path, 'attstorage'),
    typstorage: expectString(row, path, 'typstorage'),
    attcompression: expectString(row, path, 'attcompression'),
  };
}

/** A `primaryKeys` row, validated field by field. */
function parsePrimaryKeyRow(value: unknown, path: string): PrimaryKeyRow {
  const row = expectObject(value, path);
  expectFields(row, path, ['schema', 'tableName', 'conname', 'ordinal', 'attname']);
  return {
    schema: expectString(row, path, 'schema'),
    tableName: expectString(row, path, 'tableName'),
    conname: expectString(row, path, 'conname'),
    ordinal: expectInteger(row, path, 'ordinal', 1),
    attname: expectString(row, path, 'attname'),
  };
}

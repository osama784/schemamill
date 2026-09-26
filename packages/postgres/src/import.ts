/**
 * Dump import: parsed statements → the canonical model, with every skip, flag, and failure
 * named.
 *
 * `importDump` composes the parse leg (`parseDump`) and translates each statement:
 *
 * - `CREATE TABLE` becomes a `Table`: columns in source order, the primary key (inline,
 *   table-level, or a later `ALTER TABLE`), and foreign keys. Types and DEFAULT expressions
 *   are sliced from the source text — the AST normalizes types (`int` becomes `int4`), so the
 *   model keeps the written spelling, whitespace-normalized.
 * - `ALTER TABLE … ADD CONSTRAINT` attaches a foreign key or primary key to an already
 *   imported table; any other constraint kind, and any other `ALTER TABLE` action, is skipped
 *   and named.
 * - Everything outside the imported subset (schemas, sequences, indexes, views, functions,
 *   comments, grants, settings, …) is skipped and named.
 *
 * Boundary for `CREATE TABLE` extras: what the model cannot represent becomes a flag on the
 * imported table — inheritance, partitioning clauses, typed-table definitions, `ON COMMIT`
 * behaviour, tablespace, access method, storage parameters, unlogged or temporary
 * persistence, and column-level UNIQUE, CHECK, EXCLUDE, IDENTITY, GENERATED, COLLATE,
 * compression, and storage. The one exception is a partition (`partbound`): a plain-table
 * representation would be a different object, so the whole statement is skipped and named.
 * `ALTER TABLE` on anything but a plain table is skipped the same way.
 *
 * Diagnostics come back in dump order (by source offset). The model obeys the ordering in
 * `model.ts`: tables by schema then name, columns in source order, foreign keys by
 * referencing columns, then referenced table, then constraint name (unnamed first).
 *
 * This module is internal to the package; `index.ts` re-exports `importDump` and
 * `ddlImporter` as the seam binding.
 */

import type {
  Column,
  DdlImporter,
  Diagnostic,
  ForeignKey,
  Model,
  PrimaryKey,
  ReadResult,
  ReferentialAction,
  SkipDiagnosticCode,
  SourcePosition,
  Table,
  TableIdentity,
} from '@schemamill/core';
import type {
  AlterTableCmd,
  AlterTableStmt,
  ColumnDef,
  Constraint,
  CreateStmt,
  Node,
  RangeVar,
} from 'libpg-query';

import { parseDump, type ParseFailure, type ParsedStatement } from './parse.ts';
import type { Position, PreprocessDiagnostic } from './preprocess.ts';

/** A local, writable view of a readonly payload, used while assembling it. */
type Mutable<Payload> = { -readonly [Key in keyof Payload]: Payload[Key] };

/** A table being assembled; finalized and sorted on return. */
interface TableDraft {
  readonly schema: string;
  readonly name: string;
  columns: readonly Column[];
  primaryKey?: PrimaryKey;
  readonly foreignKeys: ForeignKey[];
}

interface PositionedDiagnostic {
  readonly offset: number;
  readonly diagnostic: Diagnostic;
}

const DEFAULT_KEYWORD = 'DEFAULT';

const DOLLAR_QUOTE = /\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/y;

const IDENTIFIER_CHARACTER = /[A-Za-z0-9_$\u0080-\uffff]/;

const CONSTRAINT_LABELS: Readonly<Record<string, string>> = {
  CONSTR_UNIQUE: 'unique constraint',
  CONSTR_CHECK: 'check constraint',
  CONSTR_EXCLUSION: 'exclusion constraint',
  CONSTR_IDENTITY: 'identity semantics',
  CONSTR_GENERATED: 'generated column expression',
  CONSTR_PRIMARY: 'primary key',
  CONSTR_FOREIGN: 'foreign key',
  CONSTR_DEFAULT: 'default',
  CONSTR_NOTNULL: 'not-null constraint',
  CONSTR_NULL: 'null constraint',
};

/** Imports a dump into the canonical model, isolating per-statement failures. */
export async function importDump(ddl: string): Promise<ReadResult<Model, Diagnostic>> {
  const parsed = await parseDump(ddl);
  const diagnostics: PositionedDiagnostic[] = [];

  for (const diagnostic of parsed.diagnostics) {
    diagnostics.push({
      offset: diagnostic.position.offset,
      diagnostic: fromPreprocessDiagnostic(diagnostic),
    });
  }
  for (const failure of parsed.failures) {
    // The cursor is the most precise location the parser gave; the statement start is the fallback.
    const position = failure.cursor ?? failure.position;
    diagnostics.push({ offset: position.offset, diagnostic: fromParseFailure(failure, position) });
  }

  const tables = new Map<string, TableDraft>();
  for (const statement of parsed.statements) {
    translateStatement(statement, tables, diagnostics);
  }

  diagnostics.sort((left, right) => left.offset - right.offset);

  return {
    model: { tables: [...tables.values()].map(finalizeTable).sort(compareTables) },
    diagnostics: diagnostics.map((entry) => entry.diagnostic),
  };
}

/** The seam binding: a structurally checked `DdlImporter`. */
export const ddlImporter: DdlImporter<Model, Diagnostic> = { import: importDump };

function fromPreprocessDiagnostic(diagnostic: PreprocessDiagnostic): Diagnostic {
  const code: SkipDiagnosticCode = diagnostic.kind === 'copy' ? 'copy-data' : 'psql-meta-command';
  return {
    kind: 'skip',
    code,
    object: diagnostic.name,
    message: diagnostic.message,
    position: toSourcePosition(diagnostic.position),
  };
}

function fromParseFailure(failure: ParseFailure, position: Position): Diagnostic {
  return {
    kind: 'error',
    code: 'parse-failure',
    message: failure.message,
    position: toSourcePosition(position),
  };
}

function toSourcePosition(position: Position): SourcePosition {
  return { offset: position.offset, line: position.line, column: position.column };
}

function translateStatement(
  statement: ParsedStatement,
  tables: Map<string, TableDraft>,
  diagnostics: PositionedDiagnostic[],
): void {
  const node = statement.result.stmts?.[0]?.stmt;
  if (node === undefined) {
    diagnostics.push({
      offset: statement.start.offset,
      diagnostic: {
        kind: 'error',
        code: 'parse-failure',
        message: 'statement produced no parse tree',
        position: toSourcePosition(statement.start),
      },
    });
    return;
  }

  if ('CreateStmt' in node) {
    translateCreateTable(statement, node.CreateStmt, tables, diagnostics);
    return;
  }
  if ('AlterTableStmt' in node) {
    translateAlterTable(statement, node.AlterTableStmt, tables, diagnostics);
    return;
  }

  const { description, object } = describeStatement(node);
  diagnostics.push(skipStatement(statement, description, object));
}

function translateCreateTable(
  statement: ParsedStatement,
  create: CreateStmt,
  tables: Map<string, TableDraft>,
  diagnostics: PositionedDiagnostic[],
): void {
  const schema = create.relation?.schemaname ?? 'public';
  const name = create.relation?.relname ?? '';
  const identity = tableIdentityName({ schema, name });

  // A partition's rows belong to its parent; a plain table would be the wrong object.
  if (create.partbound !== undefined) {
    diagnostics.push(
      skipStatement(
        statement,
        `partition ${identity} (a partition is not a plain table)`,
        identity,
      ),
    );
    return;
  }

  const draft = getOrCreateTable(tables, schema, name);
  const elements = create.tableElts ?? [];
  const elementLocations = elements
    .map(elementLocation)
    .filter((location): location is number => location !== undefined);

  const columns: Column[] = [];
  draft.primaryKey = undefined;

  for (const element of elements) {
    const boundaries = clauseBoundaries(element, elementLocations);
    if ('ColumnDef' in element) {
      const translated = translateColumn(
        statement,
        element.ColumnDef,
        boundaries,
        identity,
        diagnostics,
      );
      columns.push(translated.column);
      if (translated.primaryKey !== undefined) {
        attachPrimaryKey(statement, draft, translated.primaryKey, identity, diagnostics);
      }
      for (const foreignKey of translated.foreignKeys) {
        attachForeignKey(draft, foreignKey);
      }
      continue;
    }
    if ('Constraint' in element) {
      translateTableConstraint(statement, element.Constraint, identity, draft, diagnostics);
      continue;
    }
    if ('TableLikeClause' in element) {
      diagnostics.push(flagAttribute(statement, identity, 'LIKE clause'));
      continue;
    }
    diagnostics.push(
      flagAttribute(statement, identity, `${Object.keys(element)[0] ?? 'table element'} clause`),
    );
  }

  draft.columns = columns;
  translateCreateTableExtras(statement, create, identity, diagnostics);
}

function translateColumn(
  statement: ParsedStatement,
  column: ColumnDef,
  boundaries: readonly number[],
  identity: string,
  diagnostics: PositionedDiagnostic[],
): { column: Column; primaryKey?: PrimaryKey; foreignKeys: readonly ForeignKey[] } {
  const name = column.colname ?? '';
  const place = `${identity}.${name}`;
  const constraints = (column.constraints ?? [])
    .map(constraintOf)
    .filter((constraint): constraint is Constraint => constraint !== undefined);

  const spanBoundaries = [
    ...boundaries,
    ...constraints
      .map((constraint) => constraint.location)
      .filter((location): location is number => location !== undefined),
    ...(column.collClause?.location === undefined ? [] : [column.collClause.location]),
  ];

  let type = '';
  if (column.typeName?.location === undefined) {
    diagnostics.push(flagAttribute(statement, identity, `column type on ${place}`));
  } else {
    type = extractSourceText(
      statement.sql,
      byteOffsetToUtf16(statement.sql, column.typeName.location),
      spanBoundaries,
    );
  }

  const notNull =
    column.is_not_null === true ||
    constraints.some(
      (constraint) =>
        constraint.contype === 'CONSTR_NOTNULL' || constraint.contype === 'CONSTR_IDENTITY',
    );

  const translated: { column: Column; primaryKey?: PrimaryKey; foreignKeys: ForeignKey[] } = {
    column: { name, type, notNull },
    foreignKeys: [],
  };

  const defaultConstraint = constraints.find(
    (constraint) => constraint.contype === 'CONSTR_DEFAULT',
  );
  if (defaultConstraint !== undefined) {
    const defaultText = extractDefaultText(statement.sql, defaultConstraint, spanBoundaries);
    if (defaultText === undefined) {
      diagnostics.push(flagAttribute(statement, identity, `DEFAULT expression on ${place}`));
    } else {
      translated.column = { name, type, notNull, default: defaultText };
    }
  }

  for (const constraint of constraints) {
    switch (constraint.contype) {
      case 'CONSTR_PRIMARY':
        translated.primaryKey = primaryKeyFromConstraint(constraint, [name]);
        break;
      case 'CONSTR_FOREIGN':
        translated.foreignKeys.push(
          foreignKeyFromConstraint(statement, constraint, [name], identity, diagnostics),
        );
        break;
      case 'CONSTR_UNIQUE':
      case 'CONSTR_CHECK':
      case 'CONSTR_EXCLUSION':
        diagnostics.push(
          flagAttribute(statement, identity, `${constraintLabel(constraint)} on ${place}`),
        );
        break;
      case 'CONSTR_IDENTITY':
      case 'CONSTR_GENERATED':
        diagnostics.push(
          flagAttribute(statement, identity, `${constraintLabel(constraint)} on ${place}`),
        );
        break;
      case 'CONSTR_NOTNULL':
      case 'CONSTR_DEFAULT':
      case 'CONSTR_NULL':
      case undefined:
        break;
      default:
        diagnostics.push(
          flagAttribute(statement, identity, `${constraintLabel(constraint)} on ${place}`),
        );
    }
  }

  if (column.collClause !== undefined) {
    diagnostics.push(flagAttribute(statement, identity, `COLLATE on ${place}`));
  }
  if (column.compression !== undefined) {
    diagnostics.push(flagAttribute(statement, identity, `compression on ${place}`));
  }
  if (column.storage !== undefined) {
    diagnostics.push(flagAttribute(statement, identity, `storage on ${place}`));
  }

  return translated;
}

function translateTableConstraint(
  statement: ParsedStatement,
  constraint: Constraint,
  identity: string,
  draft: TableDraft,
  diagnostics: PositionedDiagnostic[],
): void {
  switch (constraint.contype) {
    case 'CONSTR_PRIMARY':
      attachPrimaryKey(
        statement,
        draft,
        primaryKeyFromConstraint(constraint, []),
        identity,
        diagnostics,
      );
      return;
    case 'CONSTR_FOREIGN':
      attachForeignKey(
        draft,
        foreignKeyFromConstraint(
          statement,
          constraint,
          stringList(constraint.fk_attrs),
          identity,
          diagnostics,
        ),
      );
      return;
    default:
      diagnostics.push(flagAttribute(statement, identity, `${constraintLabel(constraint)}`));
  }
}

function translateCreateTableExtras(
  statement: ParsedStatement,
  create: CreateStmt,
  identity: string,
  diagnostics: PositionedDiagnostic[],
): void {
  const flag = (description: string): void => {
    diagnostics.push(flagAttribute(statement, identity, description));
  };

  if ((create.inhRelations ?? []).length > 0) flag('inheritance');
  if (create.partspec !== undefined) flag('partitioning clauses');
  if (create.ofTypename !== undefined) flag('typed-table definition');
  if (create.oncommit !== undefined && create.oncommit !== 'ONCOMMIT_NOOP')
    flag('ON COMMIT behaviour');
  if (create.tablespacename !== undefined) flag('tablespace');
  if (create.accessMethod !== undefined) flag('access method');
  if ((create.options ?? []).length > 0) flag('storage parameters');
  if (create.relation?.relpersistence === 'u') flag('unlogged-table persistence');
  if (create.relation?.relpersistence === 't') flag('temporary-table persistence');
}

function translateAlterTable(
  statement: ParsedStatement,
  alter: AlterTableStmt,
  tables: Map<string, TableDraft>,
  diagnostics: PositionedDiagnostic[],
): void {
  const schema = alter.relation?.schemaname ?? 'public';
  const name = alter.relation?.relname ?? '';
  const identity = tableIdentityName({ schema, name });

  if (alter.objtype !== undefined && alter.objtype !== 'OBJECT_TABLE') {
    diagnostics.push(skipStatement(statement, `ALTER ${alter.objtype} ${identity}`, identity));
    return;
  }

  const draft = tables.get(tableKey(schema, name));
  if (draft === undefined) {
    diagnostics.push(
      skipStatement(statement, `ALTER TABLE ${identity} (table not imported)`, identity),
    );
    return;
  }

  for (const command of alter.cmds ?? []) {
    if (!('AlterTableCmd' in command)) {
      diagnostics.push(
        skipStatement(statement, `ALTER TABLE ${identity} (unrecognized command)`, identity),
      );
      continue;
    }
    translateAlterTableCommand(statement, command.AlterTableCmd, identity, draft, diagnostics);
  }
}

function translateAlterTableCommand(
  statement: ParsedStatement,
  command: AlterTableCmd,
  identity: string,
  draft: TableDraft,
  diagnostics: PositionedDiagnostic[],
): void {
  if (
    command.subtype === 'AT_AddConstraint' &&
    command.def !== undefined &&
    'Constraint' in command.def
  ) {
    const constraint = command.def.Constraint;
    if (constraint.contype === 'CONSTR_FOREIGN') {
      attachForeignKey(
        draft,
        foreignKeyFromConstraint(
          statement,
          constraint,
          stringList(constraint.fk_attrs),
          identity,
          diagnostics,
        ),
      );
      return;
    }
    if (constraint.contype === 'CONSTR_PRIMARY') {
      attachPrimaryKey(
        statement,
        draft,
        primaryKeyFromConstraint(constraint, []),
        identity,
        diagnostics,
      );
      return;
    }
    diagnostics.push(
      skipStatement(
        statement,
        `${constraintLabel(constraint)} on ${identity}`,
        constraint.conname ?? identity,
      ),
    );
    return;
  }

  diagnostics.push(
    skipStatement(
      statement,
      `ALTER TABLE action ${command.subtype ?? 'unknown'} on ${identity}`,
      identity,
    ),
  );
}

function attachPrimaryKey(
  statement: ParsedStatement,
  draft: TableDraft,
  primaryKey: PrimaryKey,
  identity: string,
  diagnostics: PositionedDiagnostic[],
): void {
  if (draft.primaryKey === undefined) {
    draft.primaryKey = primaryKey;
    return;
  }
  if (samePrimaryKey(draft.primaryKey, primaryKey)) return;
  diagnostics.push(flagAttribute(statement, identity, 'additional primary key'));
}

function attachForeignKey(draft: TableDraft, foreignKey: ForeignKey): void {
  if (draft.foreignKeys.some((existing) => sameForeignKey(existing, foreignKey))) return;
  draft.foreignKeys.push(foreignKey);
}

function primaryKeyFromConstraint(
  constraint: Constraint,
  fallbackColumns: readonly string[],
): PrimaryKey {
  const keys = stringList(constraint.keys);
  const primaryKey: Mutable<PrimaryKey> = { columns: keys.length > 0 ? keys : fallbackColumns };
  if (constraint.conname !== undefined) primaryKey.name = constraint.conname;
  return primaryKey;
}

function foreignKeyFromConstraint(
  statement: ParsedStatement,
  constraint: Constraint,
  columns: readonly string[],
  identity: string,
  diagnostics: PositionedDiagnostic[],
): ForeignKey {
  const foreignKey: Mutable<ForeignKey> = {
    columns,
    referencedTable: {
      schema: constraint.pktable?.schemaname ?? 'public',
      name: constraint.pktable?.relname ?? '',
    },
    referencedColumns: stringList(constraint.pk_attrs),
  };
  if (constraint.conname !== undefined) foreignKey.name = constraint.conname;

  const onUpdate = referentialAction(constraint.fk_upd_action);
  if (onUpdate !== undefined) foreignKey.onUpdate = onUpdate;
  const onDelete = referentialAction(constraint.fk_del_action);
  if (onDelete !== undefined) foreignKey.onDelete = onDelete;

  const label = constraint.conname === undefined ? `on ${identity}` : constraint.conname;
  const flag = (description: string): void => {
    diagnostics.push(flagAttribute(statement, identity, `${description} on foreign key ${label}`));
  };

  if (constraint.fk_matchtype === 'f' || constraint.fk_matchtype === 'p') {
    flag(`MATCH ${constraint.fk_matchtype === 'f' ? 'FULL' : 'PARTIAL'}`);
  }
  if (constraint.deferrable === true || constraint.initdeferred === true) flag('deferrability');
  if (constraint.skip_validation === true || constraint.initially_valid === false)
    flag('NOT VALID');
  if ((constraint.fk_del_set_cols ?? []).length > 0) flag('column list');
  if (constraint.is_enforced === false) flag('NOT ENFORCED');

  return foreignKey;
}

/** Maps PostgreSQL's single-letter action codes; `NO ACTION` (the default) is absent. */
function referentialAction(code: string | undefined): ReferentialAction | undefined {
  switch (code) {
    case 'r':
      return 'RESTRICT';
    case 'c':
      return 'CASCADE';
    case 'n':
      return 'SET NULL';
    case 'd':
      return 'SET DEFAULT';
    default:
      return undefined;
  }
}

function describeStatement(node: Node): { readonly description: string; readonly object: string } {
  if ('CreateSchemaStmt' in node) {
    const object = node.CreateSchemaStmt.schemaname ?? 'schema';
    return { description: `CREATE SCHEMA ${object}`, object };
  }
  if ('IndexStmt' in node) {
    const object = node.IndexStmt.idxname ?? rangeVarName(node.IndexStmt.relation) ?? 'index';
    return { description: `CREATE INDEX ${object}`, object };
  }
  if ('CreateSeqStmt' in node) {
    const object = rangeVarName(node.CreateSeqStmt.sequence) ?? 'sequence';
    return { description: `CREATE SEQUENCE ${object}`, object };
  }
  if ('ViewStmt' in node) {
    const object = rangeVarName(node.ViewStmt.view) ?? 'view';
    return { description: `CREATE VIEW ${object}`, object };
  }
  if ('CreateFunctionStmt' in node) {
    const object = stringList(node.CreateFunctionStmt.funcname).join('.') || 'function';
    const kind =
      node.CreateFunctionStmt.is_procedure === true ? 'CREATE PROCEDURE' : 'CREATE FUNCTION';
    return { description: `${kind} ${object}`, object };
  }
  if ('CreateTrigStmt' in node) {
    const object =
      node.CreateTrigStmt.trigname ?? rangeVarName(node.CreateTrigStmt.relation) ?? 'trigger';
    return { description: `CREATE TRIGGER ${object}`, object };
  }
  if ('CreateForeignTableStmt' in node) {
    const object = rangeVarName(node.CreateForeignTableStmt.base?.relation) ?? 'foreign table';
    return { description: `CREATE FOREIGN TABLE ${object}`, object };
  }
  if ('CreateTableAsStmt' in node) {
    const object = rangeVarName(node.CreateTableAsStmt.into?.rel) ?? 'table';
    return { description: `CREATE TABLE AS ${object}`, object };
  }
  if ('CommentStmt' in node) {
    const object = commentObject(node.CommentStmt.object) ?? 'object';
    const kind = (node.CommentStmt.objtype ?? 'OBJECT').replace(/^OBJECT_/, '');
    return { description: `COMMENT ON ${kind} ${object}`, object };
  }
  if ('VariableSetStmt' in node) {
    const object = node.VariableSetStmt.name ?? 'setting';
    return { description: `SET ${object}`, object };
  }
  if ('SelectStmt' in node) return { description: 'SELECT statement', object: 'SELECT' };
  if ('GrantStmt' in node) return { description: 'GRANT statement', object: 'GRANT' };
  if ('CreateExtensionStmt' in node) {
    const object = node.CreateExtensionStmt.extname ?? 'extension';
    return { description: `CREATE EXTENSION ${object}`, object };
  }
  if ('CopyStmt' in node) {
    const object = rangeVarName(node.CopyStmt.relation) ?? 'COPY';
    return { description: `COPY ${object}`, object };
  }

  const key = Object.keys(node)[0] ?? 'statement';
  return { description: `${key} statement`, object: key };
}

function skipStatement(
  statement: ParsedStatement,
  description: string,
  object: string,
): PositionedDiagnostic {
  return {
    offset: statement.start.offset,
    diagnostic: {
      kind: 'skip',
      code: 'unsupported-statement',
      object,
      message: `skipped ${description}`,
      position: toSourcePosition(statement.start),
    },
  };
}

function flagAttribute(
  statement: ParsedStatement,
  identity: string,
  description: string,
): PositionedDiagnostic {
  return {
    offset: statement.start.offset,
    diagnostic: {
      kind: 'flag',
      code: 'unsupported-attribute',
      object: identity,
      message: `dropped ${description} from ${identity}`,
      position: toSourcePosition(statement.start),
    },
  };
}

function getOrCreateTable(
  tables: Map<string, TableDraft>,
  schema: string,
  name: string,
): TableDraft {
  const key = tableKey(schema, name);
  const existing = tables.get(key);
  if (existing !== undefined) return existing;
  const draft: TableDraft = { schema, name, columns: [], foreignKeys: [] };
  tables.set(key, draft);
  return draft;
}

function finalizeTable(draft: TableDraft): Table {
  const table: Mutable<Table> = {
    schema: draft.schema,
    name: draft.name,
    columns: draft.columns,
    foreignKeys: [...draft.foreignKeys].sort(compareForeignKeys),
  };
  if (draft.primaryKey !== undefined) table.primaryKey = draft.primaryKey;
  return table;
}

/**
 * Byte offsets for the clauses that follow an element: its own clause locations plus every
 * table element's location. `extractSourceText` picks the nearest one after the span start.
 */
function clauseBoundaries(element: Node, elementLocations: readonly number[]): readonly number[] {
  const boundaries = [...elementLocations];
  if ('ColumnDef' in element) {
    for (const constraint of element.ColumnDef.constraints ?? []) {
      if ('Constraint' in constraint && constraint.Constraint.location !== undefined) {
        boundaries.push(constraint.Constraint.location);
      }
    }
    if (element.ColumnDef.collClause?.location !== undefined) {
      boundaries.push(element.ColumnDef.collClause.location);
    }
  }
  return boundaries;
}

function elementLocation(element: Node): number | undefined {
  if ('ColumnDef' in element) return element.ColumnDef.location;
  if ('Constraint' in element) return element.Constraint.location;
  return undefined;
}

function constraintOf(node: Node): Constraint | undefined {
  return 'Constraint' in node ? node.Constraint : undefined;
}

function constraintLabel(constraint: Constraint): string {
  const label = CONSTRAINT_LABELS[constraint.contype ?? ''] ?? constraint.contype ?? 'constraint';
  return constraint.conname === undefined ? label : `${label} ${constraint.conname}`;
}

function stringList(nodes: readonly Node[] | undefined): string[] {
  const values: string[] = [];
  for (const node of nodes ?? []) {
    if ('String' in node) values.push(node.String.sval ?? '');
  }
  return values;
}

function rangeVarName(relation: RangeVar | undefined): string | undefined {
  if (relation?.relname === undefined) return undefined;
  return relation.schemaname === undefined
    ? relation.relname
    : `${relation.schemaname}.${relation.relname}`;
}

function tableIdentityName(identity: TableIdentity): string {
  return `${identity.schema}.${identity.name}`;
}

function tableKey(schema: string, name: string): string {
  return `${schema}\u0000${name}`;
}

function commentObject(node: Node | undefined): string | undefined {
  if (node === undefined) return undefined;
  if ('List' in node) {
    const names = stringList(node.List.items);
    return names.length > 0 ? names.join('.') : undefined;
  }
  if ('String' in node) return node.String.sval;
  return undefined;
}

function samePrimaryKey(left: PrimaryKey, right: PrimaryKey): boolean {
  return left.name === right.name && sameStringArray(left.columns, right.columns);
}

function sameForeignKey(left: ForeignKey, right: ForeignKey): boolean {
  return (
    left.name === right.name &&
    sameStringArray(left.columns, right.columns) &&
    left.referencedTable.schema === right.referencedTable.schema &&
    left.referencedTable.name === right.referencedTable.name &&
    sameStringArray(left.referencedColumns, right.referencedColumns) &&
    left.onUpdate === right.onUpdate &&
    left.onDelete === right.onDelete
  );
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareTables(left: Table, right: Table): number {
  return compareStrings(left.schema, right.schema) || compareStrings(left.name, right.name);
}

function compareForeignKeys(left: ForeignKey, right: ForeignKey): number {
  return (
    compareStringArrays(left.columns, right.columns) ||
    compareStrings(left.referencedTable.schema, right.referencedTable.schema) ||
    compareStrings(left.referencedTable.name, right.referencedTable.name) ||
    compareStrings(left.name ?? '', right.name ?? '')
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareStringArrays(left: readonly string[], right: readonly string[]): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const comparison = compareStrings(left[index]!, right[index]!);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

/**
 * Slices source text from a UTF-16 start index, ending at the nearest byte boundary after it
 * or at the enclosing list's terminator, then whitespace-normalizes it.
 */
function extractSourceText(sql: string, startIndex: number, boundaries: readonly number[]): string {
  const normalized = normalizeSourceText(
    sql.slice(startIndex, spanEndIndex(sql, startIndex, boundaries)),
  );
  return normalized.endsWith(',') ? normalized.slice(0, -1).trimEnd() : normalized;
}

function spanEndIndex(sql: string, startIndex: number, boundaries: readonly number[]): number {
  let end = sql.length;
  for (const boundary of boundaries) {
    const index = byteOffsetToUtf16(sql, boundary);
    if (index > startIndex && index < end) end = index;
  }
  return end === sql.length ? terminatorIndex(sql, startIndex) : end;
}

/** Extracts a DEFAULT expression, starting just past the `DEFAULT` keyword. */
function extractDefaultText(
  sql: string,
  constraint: Constraint,
  boundaries: readonly number[],
): string | undefined {
  const keyword = constraint.location;
  if (keyword === undefined) return undefined;
  const startIndex = skipTrivia(sql, byteOffsetToUtf16(sql, keyword + DEFAULT_KEYWORD.length));
  return extractSourceText(sql, startIndex, boundaries);
}

/** Whitespace-normalizes source text outside quoted spans; `numeric(12, 2)` reads `numeric(12,2)`. */
function normalizeSourceText(text: string): string {
  let normalized = '';
  let pendingSpace = false;
  let index = 0;

  const appendSpace = (): void => {
    const last = normalized.at(-1);
    if (
      pendingSpace &&
      last !== undefined &&
      last !== '(' &&
      last !== '[' &&
      last !== '.' &&
      last !== ','
    ) {
      normalized += ' ';
    }
    pendingSpace = false;
  };

  while (index < text.length) {
    const character = text[index]!;

    if (character === "'" || character === '"') {
      appendSpace();
      const end = quotedSpanEnd(text, index);
      normalized += text.slice(index, end);
      index = end;
      continue;
    }

    if (character === '$') {
      const delimiter = matchDollarDelimiter(text, index);
      if (delimiter !== null) {
        appendSpace();
        const close = text.indexOf(delimiter, index + delimiter.length);
        const end = close === -1 ? text.length : close + delimiter.length;
        normalized += text.slice(index, end);
        index = end;
        continue;
      }
    }

    if (isWhitespaceCharacter(character)) {
      pendingSpace = true;
      index += 1;
      continue;
    }

    if (
      character === ',' ||
      character === ')' ||
      character === ']' ||
      character === '.' ||
      character === ';'
    ) {
      normalized = normalized.replace(/\s+$/, '');
      normalized += character;
      pendingSpace = false;
      index += 1;
      continue;
    }

    if (character === '(' || character === '[') {
      normalized = normalized.replace(/\s+$/, '');
      normalized += character;
      pendingSpace = false;
      index += 1;
      continue;
    }

    appendSpace();
    normalized += character;
    index += 1;
  }

  return normalized.trim();
}

/** Index of the first top-level `,`, `)`, or `;` at or after `startIndex`, or the end of text. */
function terminatorIndex(text: string, startIndex: number): number {
  let index = startIndex;
  let depth = 0;
  while (index < text.length) {
    const character = text[index]!;

    if (character === "'" || character === '"') {
      index = quotedSpanEnd(text, index);
      continue;
    }
    if (character === '$') {
      const delimiter = matchDollarDelimiter(text, index);
      if (delimiter !== null) {
        const close = text.indexOf(delimiter, index + delimiter.length);
        index = close === -1 ? text.length : close + delimiter.length;
        continue;
      }
    }
    if (character === '(' || character === '[') {
      depth += 1;
    } else if (character === ')' || character === ']') {
      if (depth === 0) return index;
      depth -= 1;
    } else if ((character === ',' || character === ';') && depth === 0) {
      return index;
    }
    index += 1;
  }
  return text.length;
}

/** Index just past the quoted span starting at `index` (a `'` or `"`), or the end of text. */
function quotedSpanEnd(text: string, index: number): number {
  const quote = text[index];
  const escapes = quote === "'" && hasEscapePrefix(text, index);
  let cursor = index + 1;
  while (cursor < text.length) {
    const character = text[cursor]!;
    if (escapes && character === '\\') {
      cursor += 2;
      continue;
    }
    if (character === quote) {
      if (text[cursor + 1] === quote) {
        cursor += 2;
        continue;
      }
      return cursor + 1;
    }
    cursor += 1;
  }
  return text.length;
}

/** Mirrors the preprocessor's quote rule: `E'…'` / `U&'…'` enable backslash escapes. */
function hasEscapePrefix(text: string, quoteIndex: number): boolean {
  const beforeQuote = text[quoteIndex - 1];
  if (beforeQuote === 'E' || beforeQuote === 'e') {
    return !IDENTIFIER_CHARACTER.test(text[quoteIndex - 2] ?? '');
  }
  if (beforeQuote !== '&') return false;
  const beforeAmpersand = text[quoteIndex - 2];
  if (beforeAmpersand !== 'U' && beforeAmpersand !== 'u') return false;
  return !IDENTIFIER_CHARACTER.test(text[quoteIndex - 3] ?? '');
}

function matchDollarDelimiter(text: string, index: number): string | null {
  DOLLAR_QUOTE.lastIndex = index;
  return DOLLAR_QUOTE.exec(text)?.[0] ?? null;
}

function skipTrivia(text: string, from: number): number {
  let index = from;
  for (;;) {
    while (index < text.length && isWhitespaceCharacter(text[index]!)) index += 1;
    if (text.startsWith('/*', index)) {
      const close = text.indexOf('*/', index + 2);
      index = close === -1 ? text.length : close + 2;
      continue;
    }
    if (text.startsWith('--', index)) {
      const breakIndex = text.slice(index).search(/[\r\n]/);
      index = breakIndex === -1 ? text.length : index + breakIndex;
      continue;
    }
    return index;
  }
}

function isWhitespaceCharacter(character: string): boolean {
  return /\s/.test(character);
}

/** PostgreSQL's AST locations are UTF-8 byte offsets; map one to a UTF-16 string index. */
function byteOffsetToUtf16(text: string, byteOffset: number): number {
  let bytes = 0;
  let index = 0;
  while (index < text.length && bytes < byteOffset) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    bytes += utf8ByteLength(codePoint);
    index += codePoint > 0xffff ? 2 : 1;
  }
  return index;
}

function utf8ByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

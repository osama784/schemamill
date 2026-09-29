/**
 * Dump import: parsed statements → the canonical model, with every skip, flag, and failure
 * named.
 *
 * `importDump` composes the parse leg (`parseDump`) and translates each statement:
 *
 * - `CREATE TABLE` becomes a `Table`: columns in source order, the primary key (inline,
 *   table-level, or a later `ALTER TABLE`), and foreign keys. Types and DEFAULT expressions
 *   are sliced from the source text — the AST normalizes types (`int` becomes `int4`), so the
 *   model keeps the written spelling, whitespace-normalized. A repeated `CREATE TABLE` for the
 *   same schema-qualified identity replaces the table wholesale, clearing its foreign keys.
 * - `ALTER TABLE … ADD CONSTRAINT` attaches a foreign key or primary key to an already
 *   imported table; any other constraint kind, and any other `ALTER TABLE` action, is skipped
 *   and named.
 * - `CREATE SEQUENCE` becomes a `Sequence` with effective option values: the `AS` type, the
 *   increment, minimum, maximum, start, cache, cycle, and inline `OWNED BY`, with omitted
 *   options and `NO MINVALUE`/`NO MAXVALUE` resolving to the engine defaults. A repeated
 *   `CREATE SEQUENCE` for the same identity replaces the sequence wholesale.
 * - `ALTER SEQUENCE` options that map to modeled fields — `AS` type, increment, min/max,
 *   start, cache, cycle, and `OWNED BY`/`OWNED BY NONE` — apply to the already imported
 *   sequence, in the order the engine processes them, and are skipped and named when the
 *   sequence was not imported. `RESTART` (sequence state), renames, `SET SCHEMA`, and
 *   `setval` calls are skipped and named; so is a dump-side `DROP SEQUENCE`.
 * - Everything outside the imported subset (schemas, indexes, views, functions, comments,
 *   grants, settings, …) is skipped and named.
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
  Sequence,
  SequenceDataType,
  SequenceOptions,
  SequenceOwner,
  SkipDiagnosticCode,
  Table,
  TableIdentity,
} from '@schemamill/core';
import {
  defaultSequenceMax,
  defaultSequenceMin,
  effectiveSequence,
  sequenceTypeBounds,
} from '@schemamill/core';
import type {
  AlterSeqStmt,
  AlterTableCmd,
  AlterTableStmt,
  ColumnDef,
  Constraint,
  CreateSeqStmt,
  CreateStmt,
  DefElem,
  Node,
  RangeVar,
} from 'libpg-query';

import { parseDump, type ParseFailure, type ParsedStatement } from './parse.ts';
import type { PreprocessDiagnostic } from './preprocess.ts';

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

/** A sequence being assembled: effective values, mutated as `ALTER SEQUENCE` options arrive. */
type SequenceDraft = Mutable<Sequence>;

interface PositionedDiagnostic {
  readonly offset: number;
  readonly diagnostic: Diagnostic;
}

/** Per-statement ALTER TABLE state: `SET DEFAULT` keywords are consumed in source order. */
interface AlterTableContext {
  defaultSearchFrom: number;
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
    diagnostics.push({
      offset: failure.cursor?.offset ?? failure.position.offset,
      diagnostic: fromParseFailure(failure),
    });
  }

  const tables = new Map<string, TableDraft>();
  const sequences = new Map<string, SequenceDraft>();
  for (const statement of parsed.statements) {
    translateStatement(statement, tables, sequences, diagnostics);
  }

  diagnostics.sort((left, right) => left.offset - right.offset);

  return {
    model: {
      tables: [...tables.values()].map(finalizeTable).sort(compareTables),
      sequences: [...sequences.values()].sort(compareSequences),
    },
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
    position: diagnostic.position,
  };
}

function fromParseFailure(failure: ParseFailure): Diagnostic {
  // The cursor is the most precise location the parser gave; the statement start is the fallback.
  return {
    kind: 'error',
    code: 'parse-failure',
    message: failure.message,
    position: failure.cursor ?? failure.position,
  };
}

function translateStatement(
  statement: ParsedStatement,
  tables: Map<string, TableDraft>,
  sequences: Map<string, SequenceDraft>,
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
        position: statement.start,
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
  if ('CreateSeqStmt' in node) {
    translateCreateSequence(statement, node.CreateSeqStmt, sequences, diagnostics);
    return;
  }
  if ('AlterSeqStmt' in node) {
    translateAlterSequence(statement, node.AlterSeqStmt, sequences, diagnostics);
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

  const columns: Column[] = [];
  // A repeated CREATE TABLE replaces the table wholesale: columns, primary key, foreign keys.
  draft.primaryKey = undefined;
  draft.foreignKeys.length = 0;

  for (const element of elements) {
    const boundaries = clauseBoundaries(element);
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
      .filter((location): location is number => location !== undefined && location >= 0),
    ...(column.collClause?.location === undefined || column.collClause.location < 0
      ? []
      : [column.collClause.location]),
  ];

  let type = '';
  const typeLocation = column.typeName?.location;
  if (typeLocation === undefined || typeLocation < 0) {
    diagnostics.push(flagAttribute(statement, identity, `column type on ${place}`));
  } else {
    type = extractSourceText(
      statement.sql,
      byteOffsetToUtf16(statement.sql, typeLocation),
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

/** Maps PostgreSQL's normalized sequence type names onto the model's data types. */
const SEQUENCE_DATA_TYPES: Readonly<Record<string, SequenceDataType>> = {
  int2: 'smallint',
  int4: 'integer',
  int8: 'bigint',
  smallint: 'smallint',
  integer: 'integer',
  bigint: 'bigint',
};

/** The sequence options the importer models; every other option is skipped and named. */
const SEQUENCE_OPTIONS: ReadonlySet<string> = new Set([
  'as',
  'increment',
  'minvalue',
  'maxvalue',
  'start',
  'cache',
  'cycle',
  'owned_by',
]);

function translateCreateSequence(
  statement: ParsedStatement,
  create: CreateSeqStmt,
  sequences: Map<string, SequenceDraft>,
  diagnostics: PositionedDiagnostic[],
): void {
  const schema = create.sequence?.schemaname ?? 'public';
  const name = create.sequence?.relname ?? '';
  const identity = tableIdentityName({ schema, name });
  const options = readCreateSequenceOptions(statement, create.options ?? [], identity, diagnostics);
  if (options === undefined) return;

  // A repeated CREATE SEQUENCE replaces the sequence wholesale, like a repeated CREATE TABLE.
  sequences.set(tableKey(schema, name), effectiveSequence({ schema, name, ...options }));
}

/**
 * The options a `CREATE SEQUENCE` states, normalized later by `effectiveSequence`. Returns
 * `undefined` and names the statement when an option or value the model cannot represent
 * appears; a dump with such a statement would not apply anyway.
 */
function readCreateSequenceOptions(
  statement: ParsedStatement,
  elements: readonly Node[],
  identity: string,
  diagnostics: PositionedDiagnostic[],
): SequenceOptions | undefined {
  const defs = sequenceOptionDefs(elements);
  for (const defname of defs.keys()) {
    if (!SEQUENCE_OPTIONS.has(defname)) {
      diagnostics.push(
        skipStatement(statement, `CREATE SEQUENCE ${identity} (option ${defname})`, identity),
      );
      return undefined;
    }
  }

  const unsupported = (description: string): undefined => {
    diagnostics.push(
      skipStatement(statement, `CREATE SEQUENCE ${identity} (${description})`, identity),
    );
    return undefined;
  };

  const options: Mutable<SequenceOptions> = {};
  const asType = defs.get('as');
  if (asType !== undefined) {
    const dataType = sequenceDataType(asType.arg);
    if (dataType === undefined) return unsupported('unsupported data type');
    options.dataType = dataType;
  }

  for (const defname of ['increment', 'minvalue', 'maxvalue', 'start', 'cache'] as const) {
    const defel = defs.get(defname);
    if (defel === undefined) continue;
    const value = integerOption(defel.arg);
    if (value === null) return unsupported(`non-integer ${defname}`);
    // An absent argument is only `NO MINVALUE` / `NO MAXVALUE`: the engine default.
    if (value !== undefined) {
      if (defname === 'increment') options.increment = value;
      else if (defname === 'minvalue') options.minValue = value;
      else if (defname === 'maxvalue') options.maxValue = value;
      else if (defname === 'start') options.start = value;
      else options.cache = value;
    }
  }

  const cycle = defs.get('cycle');
  if (cycle !== undefined && cycle.arg !== undefined && 'Boolean' in cycle.arg) {
    options.cycle = cycle.arg.Boolean.boolval ?? false;
  }

  const ownedBy = defs.get('owned_by');
  if (ownedBy !== undefined) {
    const owner = parseSequenceOwner(ownedBy);
    if (owner.kind === 'invalid') return unsupported('invalid OWNED BY');
    if (owner.kind === 'owner') options.ownedBy = owner.owner;
  }

  return options;
}

function translateAlterSequence(
  statement: ParsedStatement,
  alter: AlterSeqStmt,
  sequences: Map<string, SequenceDraft>,
  diagnostics: PositionedDiagnostic[],
): void {
  const schema = alter.sequence?.schemaname ?? 'public';
  const name = alter.sequence?.relname ?? '';
  const identity = tableIdentityName({ schema, name });

  const draft = sequences.get(tableKey(schema, name));
  if (draft === undefined) {
    diagnostics.push(
      skipStatement(statement, `ALTER SEQUENCE ${identity} (sequence not imported)`, identity),
    );
    return;
  }

  const defs = sequenceOptionDefs(alter.options ?? []);
  const skip = (description: string): void => {
    diagnostics.push(
      skipStatement(statement, `ALTER SEQUENCE ${identity} (${description})`, identity),
    );
  };

  // The engine collects every option first and then applies them in this fixed order, not in
  // source order: AS type, increment, cycle, maximum, minimum, start, restart, cache.
  const asType = defs.get('as');
  let resetMin = false;
  let resetMax = false;
  if (asType !== undefined) {
    const dataType = sequenceDataType(asType.arg);
    if (dataType === undefined) {
      skip('unsupported data type');
    } else {
      // The engine converts a bound that is exactly the old type's bound to the new type's,
      // and remembers the conversion: a later `NO MINVALUE`/`NO MAXVALUE` then takes the new
      // type's bound rather than the direction-dependent default.
      const oldBounds = sequenceTypeBounds(draft.dataType);
      const newBounds = sequenceTypeBounds(dataType);
      resetMin = draft.minValue === oldBounds.minValue;
      resetMax = draft.maxValue === oldBounds.maxValue;
      if (resetMin) draft.minValue = newBounds.minValue;
      if (resetMax) draft.maxValue = newBounds.maxValue;
      draft.dataType = dataType;
    }
  }

  const increment = defs.get('increment');
  if (increment !== undefined) {
    const value = integerOption(increment.arg);
    if (value === null) skip('non-integer increment');
    else if (value !== undefined) draft.increment = value;
  }

  const cycle = defs.get('cycle');
  if (cycle !== undefined && cycle.arg !== undefined && 'Boolean' in cycle.arg) {
    draft.cycle = cycle.arg.Boolean.boolval ?? false;
  }

  const maxValue = defs.get('maxvalue');
  if (maxValue !== undefined) {
    if (maxValue.arg === undefined) {
      draft.maxValue = resetMax
        ? sequenceTypeBounds(draft.dataType).maxValue
        : defaultSequenceMax(draft.dataType, draft.increment);
    } else {
      const value = integerOption(maxValue.arg);
      if (value === null || value === undefined) skip('non-integer maxvalue');
      else draft.maxValue = value;
    }
  }

  const minValue = defs.get('minvalue');
  if (minValue !== undefined) {
    if (minValue.arg === undefined) {
      draft.minValue = resetMin
        ? sequenceTypeBounds(draft.dataType).minValue
        : defaultSequenceMin(draft.dataType, draft.increment);
    } else {
      const value = integerOption(minValue.arg);
      if (value === null || value === undefined) skip('non-integer minvalue');
      else draft.minValue = value;
    }
  }

  const start = defs.get('start');
  if (start !== undefined) {
    const value = integerOption(start.arg);
    if (value === null) skip('non-integer start');
    else if (value !== undefined) draft.start = value;
  }

  const cache = defs.get('cache');
  if (cache !== undefined) {
    const value = integerOption(cache.arg);
    if (value === null) skip('non-integer cache');
    else if (value !== undefined) draft.cache = value;
  }

  const ownedBy = defs.get('owned_by');
  if (ownedBy !== undefined) {
    const owner = parseSequenceOwner(ownedBy);
    if (owner.kind === 'invalid') skip('invalid OWNED BY');
    else if (owner.kind === 'none') delete draft.ownedBy;
    else draft.ownedBy = owner.owner;
  }

  for (const defname of defs.keys()) {
    if (defname === 'restart') skip('RESTART');
    else if (!SEQUENCE_OPTIONS.has(defname)) skip(`option ${defname}`);
  }
}

/** The `DefElem` options a sequence statement carries, keyed by name; a repeat wins. */
function sequenceOptionDefs(elements: readonly Node[]): Map<string, DefElem> {
  const defs = new Map<string, DefElem>();
  for (const element of elements) {
    if ('DefElem' in element && element.DefElem.defname !== undefined) {
      defs.set(element.DefElem.defname, element.DefElem);
    }
  }
  return defs;
}

/**
 * The exact canonical decimal string an integer option argument states, `null` when the
 * argument is present but not an exact integer (invalid for the engine), and `undefined` when
 * it has no argument at all — which only `NO MINVALUE` and `NO MAXVALUE` do. Values beyond
 * 32-bit use the AST's string form, so no 64-bit value ever passes through a JavaScript number.
 */
function integerOption(argument: Node | undefined): string | null | undefined {
  if (argument === undefined) return undefined;
  if ('Integer' in argument) {
    // Protobuf drops a zero value from the JSON form, so `{ Integer: {} }` is the literal 0.
    return BigInt(argument.Integer.ival ?? 0).toString();
  }
  if ('Float' in argument && argument.Float.fval !== undefined && argument.Float.fval !== '') {
    try {
      return BigInt(argument.Float.fval).toString();
    } catch {
      return null;
    }
  }
  return null;
}

/** The model data type an `AS` argument names, or `undefined` when it is not a sequence type. */
function sequenceDataType(argument: Node | undefined): SequenceDataType | undefined {
  if (argument === undefined || !('TypeName' in argument)) return undefined;
  const names = stringList(argument.TypeName.names);
  const last = names.at(-1);
  return last === undefined ? undefined : SEQUENCE_DATA_TYPES[last];
}

/** What an `OWNED BY` option names: an owner, `OWNED BY NONE`, or an unusable argument. */
type ParsedOwner =
  | { readonly kind: 'owner'; readonly owner: SequenceOwner }
  | { readonly kind: 'none' }
  | { readonly kind: 'invalid' };

/** Parses an `OWNED BY` option; the table is `public` when the source omits the schema. */
function parseSequenceOwner(defel: DefElem): ParsedOwner {
  const argument = defel.arg;
  if (argument === undefined || !('List' in argument)) return { kind: 'invalid' };
  const names = stringList(argument.List.items);
  if (names.length === 1 && names[0] === 'none') return { kind: 'none' };
  if (names.length === 2) {
    return {
      kind: 'owner',
      owner: { table: { schema: 'public', name: names[0]! }, column: names[1]! },
    };
  }
  if (names.length === 3) {
    return {
      kind: 'owner',
      owner: { table: { schema: names[0]!, name: names[1]! }, column: names[2]! },
    };
  }
  return { kind: 'invalid' };
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

  const context: AlterTableContext = { defaultSearchFrom: 0 };
  for (const command of alter.cmds ?? []) {
    if (!('AlterTableCmd' in command)) {
      diagnostics.push(
        skipStatement(statement, `ALTER TABLE ${identity} (unrecognized command)`, identity),
      );
      continue;
    }
    translateAlterTableCommand(
      statement,
      command.AlterTableCmd,
      identity,
      draft,
      diagnostics,
      context,
    );
  }
}

function translateAlterTableCommand(
  statement: ParsedStatement,
  command: AlterTableCmd,
  identity: string,
  draft: TableDraft,
  diagnostics: PositionedDiagnostic[],
  context: AlterTableContext,
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

  if (command.subtype === 'AT_ColumnDefault') {
    attachColumnDefault(statement, command, identity, draft, diagnostics, context);
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

/**
 * Attaches `ALTER COLUMN … SET DEFAULT` to an imported column — the form pg_dump uses for
 * sequence-backed defaults. `DROP DEFAULT` carries no expression and stays a skip; a different
 * existing default is kept and flagged.
 */
function attachColumnDefault(
  statement: ParsedStatement,
  command: AlterTableCmd,
  identity: string,
  draft: TableDraft,
  diagnostics: PositionedDiagnostic[],
  context: AlterTableContext,
): void {
  if (command.def === undefined) {
    diagnostics.push(
      skipStatement(
        statement,
        `ALTER TABLE action ${command.subtype ?? 'unknown'} on ${identity}`,
        identity,
      ),
    );
    return;
  }

  // Anchor the expression after the keyword: AST locations for type-prefixed literals are -1
  // and operator locations sit inside wrapping parentheses, so neither bounds the written text.
  const startIndex = findSetDefaultExpressionStart(statement.sql, context.defaultSearchFrom);
  if (startIndex === null) {
    diagnostics.push(
      skipStatement(
        statement,
        `DEFAULT without a source location on ${identity}`,
        command.name ?? identity,
      ),
    );
    return;
  }
  context.defaultSearchFrom = startIndex;

  const name = command.name;
  const column =
    name === undefined ? undefined : draft.columns.find((candidate) => candidate.name === name);
  if (name === undefined || column === undefined) {
    const place = name === undefined ? identity : `${identity}.${name}`;
    diagnostics.push(skipStatement(statement, `DEFAULT for unknown column ${place}`, place));
    return;
  }

  const defaultText = extractSourceText(statement.sql, startIndex, []);

  if (column.default !== undefined) {
    if (column.default !== defaultText) {
      diagnostics.push(
        flagAttribute(statement, identity, `conflicting DEFAULT on ${identity}.${name}`),
      );
    }
    return;
  }

  draft.columns = draft.columns.map((candidate) =>
    candidate === column ? { ...candidate, default: defaultText } : candidate,
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
  if ('DropStmt' in node && node.DropStmt.removeType === 'OBJECT_SEQUENCE') {
    const object = listObjectName(node.DropStmt.objects?.[0]) ?? 'sequence';
    return { description: `DROP SEQUENCE ${object}`, object };
  }
  if ('RenameStmt' in node && node.RenameStmt.renameType === 'OBJECT_SEQUENCE') {
    const object = rangeVarName(node.RenameStmt.relation) ?? 'sequence';
    return { description: `ALTER SEQUENCE ${object} RENAME`, object };
  }
  if (
    'AlterObjectSchemaStmt' in node &&
    node.AlterObjectSchemaStmt.objectType === 'OBJECT_SEQUENCE'
  ) {
    const object = rangeVarName(node.AlterObjectSchemaStmt.relation) ?? 'sequence';
    return { description: `ALTER SEQUENCE ${object} SET SCHEMA`, object };
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
      position: statement.start,
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
      position: statement.start,
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
 * Byte offsets of the clauses inside one table element. Clause ends stop at the nearest one,
 * so a type never swallows the `DEFAULT` or `NOT NULL` that follows it.
 */
function clauseBoundaries(element: Node): readonly number[] {
  if (!('ColumnDef' in element)) return [];
  const boundaries: number[] = [];
  for (const constraint of element.ColumnDef.constraints ?? []) {
    if (
      'Constraint' in constraint &&
      constraint.Constraint.location !== undefined &&
      constraint.Constraint.location >= 0
    ) {
      boundaries.push(constraint.Constraint.location);
    }
  }
  const collation = element.ColumnDef.collClause?.location;
  if (collation !== undefined && collation >= 0) {
    boundaries.push(collation);
  }
  return boundaries;
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

/** The dotted name of a `DROP` statement's object list entry, when it has one. */
function listObjectName(node: Node | undefined): string | undefined {
  if (node === undefined || !('List' in node)) return undefined;
  const names = stringList(node.List.items);
  return names.length > 0 ? names.join('.') : undefined;
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

function compareSequences(left: Sequence, right: Sequence): number {
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
 * Slices source text from a UTF-16 start index to the enclosing list's terminator (or the
 * nearest following clause), then drops comments and whitespace-normalizes what remains.
 */
function extractSourceText(sql: string, startIndex: number, boundaries: readonly number[]): string {
  const normalized = normalizeSourceText(
    sql.slice(startIndex, spanEndIndex(sql, startIndex, boundaries)),
  );
  return normalized.endsWith(',') ? normalized.slice(0, -1).trimEnd() : normalized;
}

/** The terminator scan bounds the span; a following clause location only tightens it. */
function spanEndIndex(sql: string, startIndex: number, boundaries: readonly number[]): number {
  let end = terminatorIndex(sql, startIndex);
  for (const boundary of boundaries) {
    if (boundary < 0) continue;
    const index = byteOffsetToUtf16(sql, boundary);
    if (index > startIndex && index < end) end = index;
  }
  return end;
}

/** Extracts a DEFAULT expression, starting just past the `DEFAULT` keyword. */
function extractDefaultText(
  sql: string,
  constraint: Constraint,
  boundaries: readonly number[],
): string | undefined {
  const keyword = constraint.location;
  if (keyword === undefined || keyword < 0) return undefined;
  const startIndex = skipTrivia(sql, byteOffsetToUtf16(sql, keyword + DEFAULT_KEYWORD.length));
  return extractSourceText(sql, startIndex, boundaries);
}

/** Drops comments outside quoted spans and whitespace-normalizes; `numeric(12, 2)` reads `numeric(12,2)`. */
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
      const end = dollarQuotedEnd(text, index);
      if (end !== null) {
        appendSpace();
        normalized += text.slice(index, end);
        index = end;
        continue;
      }
    }

    if (character === '-' && text[index + 1] === '-') {
      pendingSpace = true;
      index = lineCommentEnd(text, index);
      continue;
    }

    if (character === '/' && text[index + 1] === '*') {
      pendingSpace = true;
      index = blockCommentEnd(text, index);
      continue;
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
      const end = dollarQuotedEnd(text, index);
      if (end !== null) {
        index = end;
        continue;
      }
    }
    if (character === '-' && text[index + 1] === '-') {
      index = lineCommentEnd(text, index);
      continue;
    }
    if (character === '/' && text[index + 1] === '*') {
      index = blockCommentEnd(text, index);
      continue;
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

/** Index of the line break ending a `--` comment that starts at `index`, or the end of text. */
function lineCommentEnd(text: string, index: number): number {
  let cursor = index + 2;
  while (cursor < text.length && text[cursor] !== '\n' && text[cursor] !== '\r') cursor += 1;
  return cursor;
}

/** Index just past a possibly nested block comment starting at `index`, or the end of text. */
function blockCommentEnd(text: string, index: number): number {
  let depth = 0;
  let cursor = index;
  while (cursor < text.length) {
    if (text.startsWith('/*', cursor)) {
      depth += 1;
      cursor += 2;
      continue;
    }
    if (text.startsWith('*/', cursor)) {
      depth -= 1;
      cursor += 2;
      if (depth === 0) return cursor;
      continue;
    }
    cursor += 1;
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

/** Index just past a dollar-quoted span starting at `index`, or `null` when none starts there. */
function dollarQuotedEnd(text: string, index: number): number | null {
  const delimiter = matchDollarDelimiter(text, index);
  if (delimiter === null) return null;
  const close = text.indexOf(delimiter, index + delimiter.length);
  return close === -1 ? text.length : close + delimiter.length;
}

/** True when `keyword` (uppercase) sits at `index` as a whole word. */
function isKeywordAt(text: string, index: number, keyword: string): boolean {
  if (text.slice(index, index + keyword.length).toUpperCase() !== keyword) return false;
  if (IDENTIFIER_CHARACTER.test(text[index - 1] ?? '')) return false;
  return !IDENTIFIER_CHARACTER.test(text[index + keyword.length] ?? '');
}

/**
 * Index just past the `SET DEFAULT` keyword pair at or after `from`, or `null` when there is
 * none at or after it. Anchoring here keeps the written expression intact — including
 * type-prefixed literals and wrapping parentheses, whose AST locations point inside the
 * expression or are unknown.
 */
function findSetDefaultExpressionStart(sql: string, from: number): number | null {
  let index = from;
  while (index < sql.length) {
    const character = sql[index]!;

    if (character === "'" || character === '"') {
      index = quotedSpanEnd(sql, index);
      continue;
    }
    if (character === '$') {
      const end = dollarQuotedEnd(sql, index);
      if (end !== null) {
        index = end;
        continue;
      }
    }
    if (character === '-' && sql[index + 1] === '-') {
      index = lineCommentEnd(sql, index);
      continue;
    }
    if (character === '/' && sql[index + 1] === '*') {
      index = blockCommentEnd(sql, index);
      continue;
    }
    if (isKeywordAt(sql, index, 'SET')) {
      const defaultIndex = skipTrivia(sql, index + 'SET'.length);
      if (isKeywordAt(sql, defaultIndex, DEFAULT_KEYWORD)) {
        return skipTrivia(sql, defaultIndex + DEFAULT_KEYWORD.length);
      }
    }
    index += 1;
  }
  return null;
}

function skipTrivia(text: string, from: number): number {
  let index = from;
  for (;;) {
    while (index < text.length && isWhitespaceCharacter(text[index]!)) index += 1;
    if (text.startsWith('/*', index)) {
      index = blockCommentEnd(text, index);
      continue;
    }
    if (text.startsWith('--', index)) {
      index = lineCommentEnd(text, index);
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

/**
 * Dump import: parsed statements → the canonical model, with every skip, flag, and failure
 * named.
 *
 * `importDump` composes the parse leg (`parseDump`) and translates each statement:
 *
 * - `CREATE TABLE` becomes a `Table`: columns in source order, the primary key (inline,
 *   table-level, or a later `ALTER TABLE`), unique and check constraints, named not-null
 *   constraints, standalone indexes, and foreign keys. Types and DEFAULT expressions are
 *   sliced from the source text — the AST normalizes types (`int` becomes `int4`), so the
 *   model keeps the written spelling, whitespace-normalized; a check expression is the text
 *   between the parentheses after `CHECK`, normalized the same way. A column declared
 *   `GENERATED … AS IDENTITY` becomes the column's effective identity descriptor (see
 *   `identity.ts`): a type PostgreSQL does not accept for identity columns, and every option
 *   the model cannot carry, is flagged by name. A repeated `CREATE TABLE` for the same
 *   schema-qualified identity replaces the table wholesale, clearing its foreign keys, unique
 *   constraints, check constraints, and indexes.
 * - `ALTER TABLE` imports `ADD COLUMN` (including inline identity), `ADD GENERATED … AS
 *   IDENTITY`, `SET GENERATED`/`SET <option>` identity clauses, and `DROP IDENTITY`, in the
 *   order the statement lists them; `ADD CONSTRAINT` attaches a foreign key, primary key,
 *   unique constraint, check constraint, or not-null constraint to an already imported table.
 *   A unique constraint stated `USING INDEX` consumes the named standalone index when it is a
 *   plain column-list unique index, and the whole constraint is skipped and named otherwise.
 *   Any other action is skipped and named, as is an identity action on a column that is not a
 *   modeled identity.
 * - `CREATE [UNIQUE] INDEX` becomes an `Index` with its name (optional), `unique`, ordered
 *   columns, and `concurrently`. A statement outside the minimal envelope — an expression
 *   element, partial `WHERE`, `INCLUDE (…)`, a non-btree access method, a non-default
 *   ordering, operator class, collation, or NULLS ordering, a tablespace, storage parameters,
 *   or `NULLS NOT DISTINCT` — is skipped and named whole; an index is never partially
 *   imported. A constraint-backed index is never a standalone `Index`: inline and
 *   `ADD CONSTRAINT` unique constraints produce `UniqueConstraint`s, and `USING INDEX`
 *   consumes the index it names. Once every statement is translated, a standalone index whose
 *   name equals PostgreSQL's conventional `<table>_<cols>_idx` for its structure, and a
 *   primary key, unique constraint, foreign key, or check constraint whose name equals the
 *   conventional formula for its structure, are canonicalized back to unnamed, so a dump of a
 *   declaration the model makes unnamed round-trips; a name is kept when an unnamed entry of
 *   the same structure already exists, so no duplicate unnamed entry is manufactured, and a
 *   name outside the formula — truncated or collision-suffixed, or an expression the
 *   best-effort check formula does not predict — stays named. A column's not-null name equal
 *   to the generated `<table>_<column>_not_null` is stripped the same way; no twin guard is
 *   needed, because one not-null fact per column is the only shape the model carries and the
 *   duplicate declaration is already collapsed by the merge (see `mergeNotNullDeclaration`).
 * - `CREATE SEQUENCE` becomes a `Sequence` with effective option values: the `AS` type, the
 *   increment, minimum, maximum, start, cache, cycle, and inline `OWNED BY`, with omitted
 *   options and `NO MINVALUE`/`NO MAXVALUE` resolving to the engine defaults. A repeated
 *   `CREATE SEQUENCE` for the same identity replaces the sequence wholesale, and unlogged or
 *   temporary sequence persistence is flagged.
 * - `ALTER SEQUENCE` options that map to modeled fields — `AS` type, increment, min/max,
 *   start, cache, cycle, and `OWNED BY`/`OWNED BY NONE` — apply to the already imported
 *   sequence, in the order the engine processes them, and are skipped and named when the
 *   sequence was not imported. `RESTART` (sequence state), renames, `SET SCHEMA`, and
 *   `setval` calls are skipped and named; so is a dump-side `DROP SEQUENCE`.
 * - Everything outside the imported subset (schemas, views, functions, comments, grants,
 *   settings, …) is skipped and named.
 *
 * Boundary for `CREATE TABLE` extras: what the model cannot represent becomes a flag on the
 * imported table — inheritance, partitioning clauses, typed-table definitions, `ON COMMIT`
 * behaviour, tablespace, access method, storage parameters, unlogged or temporary
 * persistence, and column-level EXCLUDE, GENERATED, COLLATE, compression, and storage. A
 * unique or check constraint carrying an attribute outside the model (`NULLS NOT DISTINCT`,
 * `INCLUDE (…)`, `NO INHERIT`) is still imported, and each unrepresentable attribute is
 * flagged and dropped, following the foreign-key precedent; a check constraint's misplaced
 * deferrability is flagged the same way. Enforcement and deferrability the model carries are
 * read instead: on a foreign key or check constraint the parser's one `skip_validation`
 * channel decodes to `NOT VALID` when `is_enforced` is true beside it and to `NOT ENFORCED`
 * otherwise, and a deferrable primary key, unique constraint, or foreign key keeps
 * `DEFERRABLE`/`INITIALLY DEFERRED`. A not-null constraint in any shape — inline, table-level,
 * or `ALTER TABLE … ADD`, named or unnamed — sets the column's `notNull`, with a stated name
 * on `notNullName`; the duplicate-declaration merge and the generated-name strip below keep
 * the model's one-fact-per-column shape. A not-null `NOT VALID` keeps its enforced not-null
 * fact and flags the validation state the model cannot carry. The
 * one statement-level exception is a partition (`partbound`): a
 * plain-table representation would be a different object, so the whole statement is skipped
 * and named. `ALTER TABLE` on anything but a plain table is skipped the same way.
 *
 * Diagnostics come back in dump order (by source offset). The model obeys the ordering in
 * `model.ts`: tables by schema then name, columns in source order, foreign keys by
 * referencing columns, then referenced table, then constraint name (unnamed first), unique
 * constraints by ordered columns then name (unnamed first), check constraints by expression
 * then name (unnamed first), and indexes by name (unnamed first).
 *
 * This module is internal to the package; `index.ts` re-exports `importDump` and
 * `ddlImporter` as the seam binding.
 */

import type {
  CheckConstraint,
  Column,
  ConstraintEnforcement,
  DdlImporter,
  Diagnostic,
  ForeignKey,
  Identity,
  IdentityGeneration,
  IdentityInput,
  IdentityOptions,
  Index,
  Model,
  PrimaryKey,
  ReadResult,
  ReferentialAction,
  Sequence,
  SequenceDataType,
  SequenceIdentity,
  SequenceOptions,
  SequenceOwner,
  SkipDiagnosticCode,
  Table,
  TableIdentity,
  UniqueConstraint,
} from '@schemamill/core';
import {
  canonicalIntType,
  defaultSequenceMax,
  defaultSequenceMin,
  effectiveIdentity,
  effectiveSequence,
  sequenceTypeBounds,
  sequenceTypeChange,
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
  IndexElem,
  IndexStmt,
  Node,
  RangeVar,
  SelectStmt,
} from 'libpg-query';

import {
  synthesizedCheckConstraintName,
  synthesizedForeignKeyName,
  synthesizedIndexName,
  synthesizedNotNullName,
  synthesizedPrimaryKeyName,
  synthesizedUniqueConstraintName,
} from './names.ts';
import { parseDump, type ParseFailure, type ParsedStatement } from './parse.ts';
import type { PreprocessDiagnostic } from './preprocess.ts';

/** A local, writable view of a readonly payload, used while assembling it. */
type Mutable<Payload> = { -readonly [Key in keyof Payload]: Payload[Key] };

/** A table being assembled; finalized and sorted on return. */
interface TableDraft {
  readonly schema: string;
  readonly name: string;
  columns: Column[];
  primaryKey?: PrimaryKey;
  readonly foreignKeys: ForeignKey[];
  readonly uniqueConstraints: UniqueConstraint[];
  readonly checkConstraints: CheckConstraint[];
  readonly indexes: Index[];
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
  if ('IndexStmt' in node) {
    translateCreateIndex(statement, node.IndexStmt, tables, diagnostics);
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
  // A repeated CREATE TABLE replaces the table wholesale: columns, primary key, foreign keys,
  // unique constraints, check constraints, and indexes.
  draft.primaryKey = undefined;
  draft.foreignKeys.length = 0;
  draft.uniqueConstraints.length = 0;
  draft.checkConstraints.length = 0;
  draft.indexes.length = 0;
  // The draft sees the columns as they are collected, so a table-level not-null constraint —
  // which always follows the column definitions — can attach to its column.
  draft.columns = columns;

  for (const element of elements) {
    const boundaries = clauseBoundaries(element);
    if ('ColumnDef' in element) {
      const translated = translateColumn(
        statement,
        element.ColumnDef,
        boundaries,
        { schema, name },
        diagnostics,
      );
      columns.push(translated.column);
      if (translated.primaryKey !== undefined) {
        attachPrimaryKey(statement, draft, translated.primaryKey, identity, diagnostics);
      }
      for (const foreignKey of translated.foreignKeys) {
        attachForeignKey(draft, foreignKey);
      }
      for (const uniqueConstraint of translated.uniqueConstraints) {
        attachUniqueConstraint(draft, uniqueConstraint);
      }
      for (const checkConstraint of translated.checkConstraints) {
        attachCheckConstraint(draft, checkConstraint);
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

  translateCreateTableExtras(statement, create, identity, diagnostics);
}

/** A column and its constraints while `translateColumn` assembles them. */
interface TranslatedColumn {
  column: Column;
  primaryKey?: PrimaryKey;
  foreignKeys: ForeignKey[];
  uniqueConstraints: UniqueConstraint[];
  checkConstraints: CheckConstraint[];
}

/** The constraint an inline `CONSTR_ATTR_*` sibling can fold into. */
type InlineAttributeTarget =
  | { readonly kind: 'primary'; readonly value: Mutable<PrimaryKey> }
  | { readonly kind: 'unique'; readonly value: Mutable<UniqueConstraint> }
  | { readonly kind: 'foreign'; readonly value: Mutable<ForeignKey> }
  | { readonly kind: 'check'; readonly value: Mutable<CheckConstraint> };

function translateColumn(
  statement: ParsedStatement,
  column: ColumnDef,
  boundaries: readonly number[],
  table: TableIdentity,
  diagnostics: PositionedDiagnostic[],
): TranslatedColumn {
  const schema = table.schema;
  const identity = tableIdentityName(table);
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

  const translated: TranslatedColumn = {
    column: { name, type, notNull },
    foreignKeys: [],
    uniqueConstraints: [],
    checkConstraints: [],
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

  // The last non-attribute constraint of the list: consecutive `CONSTR_ATTR_*` siblings fold
  // into it, in source order.
  let fold: InlineAttributeTarget | undefined;

  for (const constraint of constraints) {
    switch (constraint.contype) {
      case 'CONSTR_PRIMARY': {
        const primaryKey = primaryKeyFromConstraint(constraint, [name]) as Mutable<PrimaryKey>;
        translated.primaryKey = primaryKey;
        fold = { kind: 'primary', value: primaryKey };
        break;
      }
      case 'CONSTR_FOREIGN': {
        const foreignKey = foreignKeyFromConstraint(
          statement,
          constraint,
          [name],
          identity,
          diagnostics,
        ) as Mutable<ForeignKey>;
        translated.foreignKeys.push(foreignKey);
        fold = { kind: 'foreign', value: foreignKey };
        break;
      }
      case 'CONSTR_UNIQUE': {
        const uniqueConstraint = uniqueConstraintFromConstraint(
          statement,
          constraint,
          [name],
          identity,
          diagnostics,
        ) as Mutable<UniqueConstraint>;
        translated.uniqueConstraints.push(uniqueConstraint);
        fold = { kind: 'unique', value: uniqueConstraint };
        break;
      }
      case 'CONSTR_CHECK': {
        const checkConstraint = checkConstraintFromConstraint(
          statement,
          constraint,
          identity,
          diagnostics,
        );
        if (checkConstraint === undefined) {
          fold = undefined;
        } else {
          translated.checkConstraints.push(checkConstraint);
          fold = { kind: 'check', value: checkConstraint };
        }
        break;
      }
      case 'CONSTR_NOTNULL': {
        fold = undefined;
        const merged = mergeNotNullDeclaration(translated.column, table.name, constraint.conname);
        if (merged.conflict) {
          diagnostics.push(
            flagAttribute(statement, identity, `additional not-null constraint on ${place}`),
          );
        } else {
          translated.column = merged.column;
        }
        break;
      }
      case 'CONSTR_EXCLUSION':
        fold = undefined;
        diagnostics.push(
          flagAttribute(statement, identity, `${constraintLabel(constraint)} on ${place}`),
        );
        break;
      case 'CONSTR_IDENTITY':
        fold = undefined;
        translated.column = columnWithIdentity(
          statement,
          constraint,
          translated.column,
          schema,
          identity,
          place,
          diagnostics,
        );
        break;
      case 'CONSTR_GENERATED':
        fold = undefined;
        diagnostics.push(
          flagAttribute(statement, identity, `${constraintLabel(constraint)} on ${place}`),
        );
        break;
      case 'CONSTR_DEFAULT':
      case 'CONSTR_NULL':
      case undefined:
        fold = undefined;
        break;
      case 'CONSTR_ATTR_DEFERRABLE':
      case 'CONSTR_ATTR_NOT_DEFERRABLE':
      case 'CONSTR_ATTR_DEFERRED':
      case 'CONSTR_ATTR_IMMEDIATE':
      case 'CONSTR_ATTR_ENFORCED':
      case 'CONSTR_ATTR_NOT_ENFORCED':
        applyInlineAttribute(statement, identity, place, fold, constraint, diagnostics);
        break;
      default:
        fold = undefined;
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

/**
 * Folds an inline constraint attribute into the constraint it follows, or flags it by its raw
 * parser label when there is no target or the target's kind cannot carry the attribute. The
 * server rejects those placements — `NOT NULL DEFERRABLE`, `CHECK DEFERRABLE`, `UNIQUE NOT
 * ENFORCED` — but the raw parser accepts them, so they stay diagnosed rather than silent.
 */
function applyInlineAttribute(
  statement: ParsedStatement,
  identity: string,
  place: string,
  target: InlineAttributeTarget | undefined,
  attribute: Constraint,
  diagnostics: PositionedDiagnostic[],
): void {
  const handled = target !== undefined && applyAttributeToTarget(target, attribute);
  if (!handled) {
    diagnostics.push(
      flagAttribute(statement, identity, `${constraintLabel(attribute)} on ${place}`),
    );
  }
}

/** Applies one attribute to one target; `false` when the target's kind cannot carry it. */
function applyAttributeToTarget(target: InlineAttributeTarget, attribute: Constraint): boolean {
  switch (target.kind) {
    case 'primary':
    case 'unique':
      return applyDeferrabilityAttribute(target.value, attribute);
    case 'foreign':
      return (
        applyDeferrabilityAttribute(target.value, attribute) ||
        applyEnforcementAttribute(target.value, attribute)
      );
    case 'check':
      return applyEnforcementAttribute(target.value, attribute);
  }
}

/** Applies a deferrability attribute; `false` for any other attribute. */
function applyDeferrabilityAttribute(
  target: Mutable<PrimaryKey | UniqueConstraint | ForeignKey>,
  attribute: Constraint,
): boolean {
  const contype = attribute.contype;
  if (contype === 'CONSTR_ATTR_DEFERRABLE') {
    target.deferrable = true;
    return true;
  }
  if (contype === 'CONSTR_ATTR_DEFERRED') {
    // `INITIALLY DEFERRED` implies `DEFERRABLE`; the model normalizes the pair.
    target.deferrable = true;
    target.initiallyDeferred = true;
    return true;
  }
  if (contype === 'CONSTR_ATTR_NOT_DEFERRABLE') {
    // An explicit default: consumed, and it resets a preceding `DEFERRABLE`/`INITIALLY
    // DEFERRED` in source order.
    delete target.deferrable;
    delete target.initiallyDeferred;
    return true;
  }
  if (contype === 'CONSTR_ATTR_IMMEDIATE') {
    delete target.initiallyDeferred;
    return true;
  }
  return false;
}

/** Applies an enforcement attribute; `false` for any other attribute. */
function applyEnforcementAttribute(
  target: Mutable<ForeignKey | CheckConstraint>,
  attribute: Constraint,
): boolean {
  const contype = attribute.contype;
  if (contype === 'CONSTR_ATTR_ENFORCED') {
    delete target.enforcement;
    return true;
  }
  if (contype === 'CONSTR_ATTR_NOT_ENFORCED') {
    target.enforcement = 'not-enforced';
    return true;
  }
  return false;
}

/**
 * Merges a not-null declaration into a column's not-null fact. PostgreSQL allows one not-null
 * constraint per column, so declarations for the same column collapse: a name equal to the
 * generated `<table>_<column>_not_null` formula reads as unnamed for the comparison, identical
 * facts are ignored, an unnamed and a named declaration become the named one whatever the
 * order, and two different real names keep the first and report a conflict — legal input the
 * model collapses by design, never silently.
 */
function mergeNotNullDeclaration(
  column: Column,
  table: string,
  incomingName: string | undefined,
): { readonly column: Column; readonly conflict: boolean } {
  const incoming = normalizedNotNullName(table, column.name, incomingName);
  if (!column.notNull) {
    const copy: Mutable<Column> = { ...column, notNull: true };
    if (incoming !== undefined) copy.notNullName = incoming;
    return { column: copy, conflict: false };
  }
  const existing = normalizedNotNullName(table, column.name, column.notNullName);
  if (existing === incoming) return { column, conflict: false };
  if (existing === undefined)
    return { column: { ...column, notNullName: incoming }, conflict: false };
  if (incoming === undefined) return { column, conflict: false };
  return { column, conflict: true };
}

/** A not-null name normalized for the one-fact comparison: the generated formula reads unnamed. */
function normalizedNotNullName(
  table: string,
  column: string,
  name: string | undefined,
): string | undefined {
  if (name === undefined) return undefined;
  return name === synthesizedNotNullName(table, column) ? undefined : name;
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
    case 'CONSTR_UNIQUE':
      attachUniqueConstraint(
        draft,
        uniqueConstraintFromConstraint(statement, constraint, [], identity, diagnostics),
      );
      return;
    case 'CONSTR_CHECK': {
      const checkConstraint = checkConstraintFromConstraint(
        statement,
        constraint,
        identity,
        diagnostics,
      );
      if (checkConstraint !== undefined) attachCheckConstraint(draft, checkConstraint);
      return;
    }
    case 'CONSTR_NOTNULL':
      attachNotNullConstraint(
        statement,
        constraint,
        identity,
        draft.name,
        draft.columns,
        diagnostics,
      );
      return;
    case undefined:
    case 'CONSTR_NULL':
    case 'CONSTR_DEFAULT':
    case 'CONSTR_IDENTITY':
    case 'CONSTR_GENERATED':
    case 'CONSTR_EXCLUSION':
    case 'CONSTR_ATTR_DEFERRABLE':
    case 'CONSTR_ATTR_NOT_DEFERRABLE':
    case 'CONSTR_ATTR_DEFERRED':
    case 'CONSTR_ATTR_IMMEDIATE':
    case 'CONSTR_ATTR_ENFORCED':
    case 'CONSTR_ATTR_NOT_ENFORCED':
    default:
      diagnostics.push(flagAttribute(statement, identity, `${constraintLabel(constraint)}`));
  }
}

/**
 * Attaches a table-level or `ALTER TABLE … ADD` not-null declaration to its column: the
 * column gains `notNull`, and a stated name travels on `notNullName` (merged with any earlier
 * declaration, see `mergeNotNullDeclaration`). A declaration whose column is not in the draft
 * is skipped and named; a `NOT VALID` one keeps its enforced not-null fact and flags the
 * validation state the model cannot carry.
 */
function attachNotNullConstraint(
  statement: ParsedStatement,
  constraint: Constraint,
  identity: string,
  table: string,
  columns: Column[],
  diagnostics: PositionedDiagnostic[],
): void {
  const key = stringList(constraint.keys)[0];
  const place = key === undefined ? identity : `${identity}.${key}`;
  const index = key === undefined ? -1 : columns.findIndex((column) => column.name === key);
  if (index === -1) {
    diagnostics.push(
      skipStatement(statement, `not-null constraint on unknown column ${place}`, place),
    );
    return;
  }

  const column = columns[index]!;
  const merged = mergeNotNullDeclaration(column, table, constraint.conname);
  if (merged.conflict) {
    diagnostics.push(
      flagAttribute(statement, identity, `additional not-null constraint on ${place}`),
    );
  } else {
    columns[index] = merged.column;
  }

  if (constraint.skip_validation === true || constraint.initially_valid === false) {
    diagnostics.push(
      flagAttribute(statement, identity, `NOT VALID on ${constraintLabel(constraint)}`),
    );
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

  // Persistence is not modeled; the re-render is a plain sequence, so flag the loss, exactly
  // as the table path flags unlogged and temporary tables.
  if (create.sequence?.relpersistence === 'u') {
    diagnostics.push(flagAttribute(statement, identity, 'unlogged-sequence persistence'));
  }
  if (create.sequence?.relpersistence === 't') {
    diagnostics.push(flagAttribute(statement, identity, 'temporary-sequence persistence'));
  }

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
      const change = sequenceTypeChange(draft.dataType, draft.minValue, draft.maxValue, dataType);
      resetMin = change.resetMin;
      resetMax = change.resetMax;
      draft.minValue = change.minValue;
      draft.maxValue = change.maxValue;
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

/**
 * The `DefElem` options a sequence statement carries, keyed by name. A repeated option
 * overwrites the earlier one — the last wins — where the engine would reject the statement
 * with `errorConflictingDefElem`; pg_dump never repeats one.
 */
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

/** SQL spellings of identity options the model cannot carry, for by-name flags. */
const IDENTITY_OPTION_LABELS: Readonly<Record<string, string>> = {
  as: 'AS',
  owned_by: 'OWNED BY',
  logged: 'LOGGED',
  unlogged: 'UNLOGGED',
  restart: 'RESTART',
};

/** PostgreSQL's `generated_when` codes: `'a'` (`GENERATED ALWAYS`) and `'d'` (`BY DEFAULT`). */
const GENERATED_ALWAYS = 'a'.charCodeAt(0);
const GENERATED_BY_DEFAULT = 'd'.charCodeAt(0);

/**
 * A copy of `column` carrying the effective identity descriptor `constraint` states. A column
 * type PostgreSQL does not accept for identity columns is flagged and left without one.
 */
function columnWithIdentity(
  statement: ParsedStatement,
  constraint: Constraint,
  column: Column,
  schema: string,
  identity: string,
  place: string,
  diagnostics: PositionedDiagnostic[],
): Column {
  const dataType = canonicalIntType(column.type);
  if (dataType === undefined) {
    diagnostics.push(flagIdentityType(statement, identity, place));
    return column;
  }
  const identityValue = identityFromConstraint(
    statement,
    constraint,
    dataType,
    schema,
    identity,
    place,
    diagnostics,
  );
  return { ...column, identity: identityValue };
}

/** The identity descriptor a `CONSTR_IDENTITY` constraint states, in effective values. */
function identityFromConstraint(
  statement: ParsedStatement,
  constraint: Constraint,
  dataType: SequenceDataType,
  schema: string,
  identity: string,
  place: string,
  diagnostics: PositionedDiagnostic[],
): Identity {
  const options: Mutable<IdentityOptions> = {};
  applyIdentityOptions(
    statement,
    constraint.options ?? [],
    options,
    schema,
    identity,
    place,
    diagnostics,
  );
  return effectiveIdentity(dataType, {
    generated: constraintGeneration(constraint.generated_when),
    ...options,
  });
}

/** The model mode a constraint's `generated_when` states; PostgreSQL writes `'a'` or `'d'`. */
function constraintGeneration(generatedWhen: string | undefined): IdentityGeneration {
  return generatedWhen === 'd' ? 'by default' : 'always';
}

/** The mode an `AT_SetIdentity` `generated` clause states, or `undefined` when malformed. */
function setIdentityGeneration(argument: Node | undefined): IdentityGeneration | undefined {
  if (argument === undefined || !('Integer' in argument)) return undefined;
  const value = argument.Integer.ival ?? 0;
  if (value === GENERATED_ALWAYS) return 'always';
  if (value === GENERATED_BY_DEFAULT) return 'by default';
  return undefined;
}

/**
 * Applies identity option clauses to `options`, in source order. Every option the model cannot
 * carry — or cannot read — is flagged by name; `NO MINVALUE`/`NO MAXVALUE` remove the option
 * so normalization resolves the engine default for the current direction.
 */
function applyIdentityOptions(
  statement: ParsedStatement,
  elements: readonly Node[],
  options: Mutable<IdentityOptions>,
  schema: string,
  identity: string,
  place: string,
  diagnostics: PositionedDiagnostic[],
): void {
  for (const element of elements) {
    if ('DefElem' in element) {
      applyIdentityOption(
        statement,
        element.DefElem,
        options,
        schema,
        identity,
        place,
        diagnostics,
      );
    }
  }
}

function applyIdentityOption(
  statement: ParsedStatement,
  def: DefElem,
  options: Mutable<IdentityOptions>,
  schema: string,
  identity: string,
  place: string,
  diagnostics: PositionedDiagnostic[],
): void {
  const name = def.defname;
  if (name === undefined) return;

  switch (name) {
    case 'sequence_name': {
      const sequenceName = readIdentitySequenceName(
        statement,
        def,
        schema,
        identity,
        place,
        diagnostics,
      );
      if (sequenceName === undefined) delete options.sequenceName;
      else options.sequenceName = sequenceName;
      return;
    }
    case 'increment':
    case 'start':
    case 'cache': {
      const value = integerOption(def.arg);
      if (value === null || value === undefined) {
        flagIdentityOption(statement, identity, name, place, diagnostics);
      } else if (name === 'increment') options.increment = value;
      else if (name === 'start') options.start = value;
      else options.cache = value;
      return;
    }
    case 'minvalue':
    case 'maxvalue': {
      const value = integerOption(def.arg);
      if (value === null) {
        flagIdentityOption(statement, identity, name, place, diagnostics);
      } else if (value === undefined) {
        // NO MINVALUE / NO MAXVALUE: the engine default for the current direction.
        if (name === 'minvalue') delete options.minValue;
        else delete options.maxValue;
      } else if (name === 'minvalue') {
        options.minValue = value;
      } else {
        options.maxValue = value;
      }
      return;
    }
    case 'cycle':
      if (def.arg !== undefined && 'Boolean' in def.arg) {
        options.cycle = def.arg.Boolean.boolval ?? false;
      } else {
        flagIdentityOption(statement, identity, 'cycle', place, diagnostics);
      }
      return;
    default:
      flagIdentityOption(
        statement,
        identity,
        IDENTITY_OPTION_LABELS[name] ?? name,
        place,
        diagnostics,
      );
  }
}

/**
 * The schema-qualified name a `SEQUENCE NAME` option states: an unqualified name takes the
 * table's schema, and a name qualified with another schema — or with an unusable shape — is
 * flagged and returns `undefined` so the identity is modeled without a name.
 */
function readIdentitySequenceName(
  statement: ParsedStatement,
  def: DefElem,
  schema: string,
  identity: string,
  place: string,
  diagnostics: PositionedDiagnostic[],
): SequenceIdentity | undefined {
  const names = def.arg !== undefined && 'List' in def.arg ? stringList(def.arg.List.items) : [];
  if (names.length === 1) return { schema, name: names[0]! };
  if (names.length === 2 && names[0] === schema) return { schema, name: names[1]! };

  const stated = names.join('.');
  diagnostics.push(
    flagAttribute(
      statement,
      identity,
      names.length === 2
        ? `cross-schema identity sequence name ${stated} on ${place}`
        : `identity sequence name ${stated} on ${place}`,
    ),
  );
  return undefined;
}

/** Flags a non-integer identity column type, the one type rejection PostgreSQL makes. */
function flagIdentityType(
  statement: ParsedStatement,
  identity: string,
  place: string,
): PositionedDiagnostic {
  return flagAttribute(
    statement,
    identity,
    `identity semantics (identity column type must be smallint, integer, or bigint) on ${place}`,
  );
}

/** Flags one identity option by name. */
function flagIdentityOption(
  statement: ParsedStatement,
  identity: string,
  label: string,
  place: string,
  diagnostics: PositionedDiagnostic[],
): void {
  diagnostics.push(flagAttribute(statement, identity, `identity option ${label} on ${place}`));
}

/** The SQL keyword an `AlterTableStmt.objtype` enum names, for readable skip descriptions. */
const ALTER_OBJECT_KINDS: Readonly<Record<string, string>> = {
  OBJECT_FOREIGN_TABLE: 'FOREIGN TABLE',
  OBJECT_INDEX: 'INDEX',
  OBJECT_MATVIEW: 'MATERIALIZED VIEW',
  OBJECT_SEQUENCE: 'SEQUENCE',
  OBJECT_VIEW: 'VIEW',
};

/** The SQL keyword for an `objtype`, with `OBJECT_` stripped as the fallback. */
function alterObjectKind(objtype: string): string {
  return ALTER_OBJECT_KINDS[objtype] ?? objtype.replace(/^OBJECT_/, '');
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
    diagnostics.push(
      skipStatement(statement, `ALTER ${alterObjectKind(alter.objtype)} ${identity}`, identity),
    );
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
    if (constraint.contype === 'CONSTR_UNIQUE') {
      attachAlteredUniqueConstraint(statement, constraint, identity, draft, diagnostics);
      return;
    }
    if (constraint.contype === 'CONSTR_CHECK') {
      const checkConstraint = checkConstraintFromConstraint(
        statement,
        constraint,
        identity,
        diagnostics,
      );
      if (checkConstraint !== undefined) attachCheckConstraint(draft, checkConstraint);
      return;
    }
    if (constraint.contype === 'CONSTR_NOTNULL') {
      attachNotNullConstraint(
        statement,
        constraint,
        identity,
        draft.name,
        draft.columns,
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

  if (command.subtype === 'AT_AddColumn' && command.def !== undefined) {
    attachColumn(statement, command.def, identity, draft, diagnostics);
    return;
  }

  if (
    command.subtype === 'AT_AddIdentity' &&
    command.def !== undefined &&
    'Constraint' in command.def
  ) {
    attachIdentity(statement, command, command.def.Constraint, identity, draft, diagnostics);
    return;
  }

  if (command.subtype === 'AT_SetIdentity' && command.def !== undefined && 'List' in command.def) {
    setIdentity(statement, command, command.def.List.items ?? [], identity, draft, diagnostics);
    return;
  }

  if (command.subtype === 'AT_DropIdentity') {
    dropIdentity(statement, command, identity, draft, diagnostics);
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
 * Imports a standalone `CREATE [UNIQUE] INDEX` onto an already imported table, or skips and
 * names the whole statement when any part of it falls outside the minimal envelope. The
 * envelope is a plain btree column list: no expression element, partial `WHERE`, `INCLUDE`,
 * tablespace, storage parameters, `NULLS NOT DISTINCT`, non-btree access method, or
 * non-default ordering, operator class, collation, or NULLS ordering. An index is never
 * partially imported.
 */
function translateCreateIndex(
  statement: ParsedStatement,
  create: IndexStmt,
  tables: Map<string, TableDraft>,
  diagnostics: PositionedDiagnostic[],
): void {
  const schema = create.relation?.schemaname ?? 'public';
  const name = create.relation?.relname ?? '';
  const identity = tableIdentityName({ schema, name });
  const object = create.idxname ?? identity;

  const draft = tables.get(tableKey(schema, name));
  if (draft === undefined) {
    diagnostics.push(
      skipStatement(statement, `CREATE INDEX ${object} (table not imported)`, object),
    );
    return;
  }

  const skip = (description: string): void => {
    diagnostics.push(skipStatement(statement, `CREATE INDEX ${object} (${description})`, object));
  };

  if (create.accessMethod !== undefined && create.accessMethod !== 'btree') {
    skip(`access method ${create.accessMethod}`);
    return;
  }
  if ((create.indexIncludingParams ?? []).length > 0) {
    skip('INCLUDE');
    return;
  }
  if (create.whereClause !== undefined) {
    skip('partial WHERE');
    return;
  }
  if ((create.options ?? []).length > 0) {
    skip('storage parameters');
    return;
  }
  if (create.tableSpace !== undefined) {
    skip('tablespace');
    return;
  }
  if (create.nulls_not_distinct === true) {
    skip('NULLS NOT DISTINCT');
    return;
  }
  if ((create.excludeOpNames ?? []).length > 0) {
    skip('exclusion operators');
    return;
  }

  const columns: string[] = [];
  for (const element of create.indexParams ?? []) {
    if (!('IndexElem' in element)) {
      skip('unrecognized index element');
      return;
    }
    const column = indexColumn(element.IndexElem);
    if (column === undefined) {
      skip(indexElementDescription(element.IndexElem));
      return;
    }
    columns.push(column);
  }
  if (columns.length === 0) {
    skip('no index columns');
    return;
  }

  const index: Mutable<Index> = { unique: create.unique === true, columns };
  if (create.idxname !== undefined) index.name = create.idxname;
  if (create.concurrent === true) index.concurrently = true;
  attachIndex(draft, index);
}

/**
 * The column an `IndexElem` indexes, or `undefined` when the element is not a plain column
 * reference; `indexElementDescription` then names what is out of the envelope.
 */
function indexColumn(element: IndexElem): string | undefined {
  if (element.expr !== undefined || element.name === undefined) return undefined;
  if ((element.collation ?? []).length > 0) return undefined;
  if ((element.opclass ?? []).length > 0) return undefined;
  if ((element.opclassopts ?? []).length > 0) return undefined;
  if (element.ordering !== undefined && element.ordering !== 'SORTBY_DEFAULT') return undefined;
  if (element.nulls_ordering !== undefined && element.nulls_ordering !== 'SORTBY_NULLS_DEFAULT') {
    return undefined;
  }
  return element.name;
}

/** What makes an `IndexElem` fall outside the minimal envelope, for a skip description. */
function indexElementDescription(element: IndexElem): string {
  if (element.expr !== undefined) return 'expression element';
  if (element.name === undefined) return 'unrecognized index element';
  if ((element.collation ?? []).length > 0) return 'collation';
  if ((element.opclass ?? []).length > 0) return 'operator class';
  if ((element.opclassopts ?? []).length > 0) return 'operator class options';
  if (element.ordering !== undefined && element.ordering !== 'SORTBY_DEFAULT') {
    return 'non-default ordering';
  }
  return 'non-default NULLS ordering';
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

/**
 * Appends an `ALTER TABLE … ADD COLUMN` column to the draft, with inline primary key and
 * foreign keys, exactly as a `CREATE TABLE` column (including inline identity).
 */
function attachColumn(
  statement: ParsedStatement,
  element: Node,
  identity: string,
  draft: TableDraft,
  diagnostics: PositionedDiagnostic[],
): void {
  if (!('ColumnDef' in element)) {
    diagnostics.push(
      skipStatement(statement, `ADD COLUMN without a definition on ${identity}`, identity),
    );
    return;
  }
  const translated = translateColumn(
    statement,
    element.ColumnDef,
    clauseBoundaries(element),
    { schema: draft.schema, name: draft.name },
    diagnostics,
  );
  draft.columns = [...draft.columns, translated.column];
  if (translated.primaryKey !== undefined) {
    attachPrimaryKey(statement, draft, translated.primaryKey, identity, diagnostics);
  }
  for (const foreignKey of translated.foreignKeys) {
    attachForeignKey(draft, foreignKey);
  }
  for (const uniqueConstraint of translated.uniqueConstraints) {
    attachUniqueConstraint(draft, uniqueConstraint);
  }
  for (const checkConstraint of translated.checkConstraints) {
    attachCheckConstraint(draft, checkConstraint);
  }
}

/**
 * Applies `ALTER TABLE … ALTER COLUMN … ADD GENERATED … AS IDENTITY` to an existing column:
 * the column's type must resolve to an identity data type, and the descriptor replaces any
 * earlier one, implying `NOT NULL`.
 */
function attachIdentity(
  statement: ParsedStatement,
  command: AlterTableCmd,
  constraint: Constraint,
  identity: string,
  draft: TableDraft,
  diagnostics: PositionedDiagnostic[],
): void {
  const target = findColumnTarget(statement, command, identity, draft, diagnostics);
  if (target === undefined) return;
  const { place, column } = target;

  const dataType = canonicalIntType(column.type);
  if (dataType === undefined) {
    diagnostics.push(flagIdentityType(statement, identity, place));
    return;
  }
  const identityValue = identityFromConstraint(
    statement,
    constraint,
    dataType,
    draft.schema,
    identity,
    place,
    diagnostics,
  );
  draft.columns = draft.columns.map((candidate) =>
    candidate === column ? { ...candidate, notNull: true, identity: identityValue } : candidate,
  );
}

/**
 * Applies one `ALTER TABLE … ALTER COLUMN … SET …` identity clause list to a modeled identity
 * column, in source order: `generated` flips the mode, and the supported options overwrite the
 * effective values they name. Clauses the model cannot carry are flagged by name, and a column
 * that is not a modeled identity is skipped and named.
 */
function setIdentity(
  statement: ParsedStatement,
  command: AlterTableCmd,
  elements: readonly Node[],
  identity: string,
  draft: TableDraft,
  diagnostics: PositionedDiagnostic[],
): void {
  const target = findColumnTarget(statement, command, identity, draft, diagnostics);
  if (target === undefined) return;
  const { place, column } = target;

  if (column.identity === undefined) {
    diagnostics.push(
      skipStatement(
        statement,
        `identity change on ${place} (column is not an identity column)`,
        place,
      ),
    );
    return;
  }
  const dataType = canonicalIntType(column.type);
  if (dataType === undefined) {
    diagnostics.push(
      skipStatement(
        statement,
        `identity change on ${place} (identity column type must be smallint, integer, or bigint)`,
        place,
      ),
    );
    return;
  }

  const input: Mutable<IdentityInput> = { ...column.identity };
  for (const element of elements) {
    if (!('DefElem' in element)) continue;
    const def = element.DefElem;
    if (def.defname === 'generated') {
      const generated = setIdentityGeneration(def.arg);
      if (generated === undefined) {
        flagIdentityOption(statement, identity, 'GENERATED', place, diagnostics);
      } else {
        input.generated = generated;
      }
      continue;
    }
    applyIdentityOption(statement, def, input, draft.schema, identity, place, diagnostics);
  }

  const identityValue = effectiveIdentity(dataType, input);
  draft.columns = draft.columns.map((candidate) =>
    candidate === column ? { ...candidate, identity: identityValue } : candidate,
  );
}

/**
 * Applies `ALTER TABLE … ALTER COLUMN … DROP IDENTITY`: the descriptor goes and `NOT NULL`
 * stays. A column that is not a modeled identity is skipped and named.
 */
function dropIdentity(
  statement: ParsedStatement,
  command: AlterTableCmd,
  identity: string,
  draft: TableDraft,
  diagnostics: PositionedDiagnostic[],
): void {
  const target = findColumnTarget(statement, command, identity, draft, diagnostics);
  if (target === undefined) return;
  const { place, column } = target;

  if (column.identity === undefined) {
    diagnostics.push(
      skipStatement(
        statement,
        `identity change on ${place} (column is not an identity column)`,
        place,
      ),
    );
    return;
  }
  draft.columns = draft.columns.map((candidate) =>
    candidate === column ? withoutIdentity(candidate) : candidate,
  );
}

/**
 * Resolves the column an identity action targets. A missing table column skips the action and
 * names the unknown target, following the `SET DEFAULT` path.
 */
function findColumnTarget(
  statement: ParsedStatement,
  command: AlterTableCmd,
  identity: string,
  draft: TableDraft,
  diagnostics: PositionedDiagnostic[],
): { readonly place: string; readonly column: Column } | undefined {
  const name = command.name;
  const column =
    name === undefined ? undefined : draft.columns.find((candidate) => candidate.name === name);
  if (column === undefined || name === undefined) {
    const place = name === undefined ? identity : `${identity}.${name}`;
    diagnostics.push(
      skipStatement(statement, `identity change for unknown column ${place}`, place),
    );
    return undefined;
  }
  return { place: `${identity}.${name}`, column };
}

/** A copy of `column` without its identity descriptor. */
function withoutIdentity(column: Column): Column {
  const copy: Mutable<Column> = { name: column.name, type: column.type, notNull: column.notNull };
  if (column.notNullName !== undefined) copy.notNullName = column.notNullName;
  if (column.default !== undefined) copy.default = column.default;
  return copy;
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

function attachUniqueConstraint(draft: TableDraft, uniqueConstraint: UniqueConstraint): void {
  if (
    draft.uniqueConstraints.some((existing) => sameUniqueConstraint(existing, uniqueConstraint))
  ) {
    return;
  }
  draft.uniqueConstraints.push(uniqueConstraint);
}

function attachCheckConstraint(draft: TableDraft, checkConstraint: CheckConstraint): void {
  if (draft.checkConstraints.some((existing) => sameCheckConstraint(existing, checkConstraint))) {
    return;
  }
  draft.checkConstraints.push(checkConstraint);
}

function attachIndex(draft: TableDraft, index: Index): void {
  if (draft.indexes.some((existing) => sameIndex(existing, index))) return;
  draft.indexes.push(index);
}

function primaryKeyFromConstraint(
  constraint: Constraint,
  fallbackColumns: readonly string[],
): PrimaryKey {
  const keys = stringList(constraint.keys);
  const primaryKey: Mutable<PrimaryKey> = { columns: keys.length > 0 ? keys : fallbackColumns };
  if (constraint.conname !== undefined) primaryKey.name = constraint.conname;
  applyConstraintDeferrability(constraint, primaryKey);
  return primaryKey;
}

/**
 * Reads the deferrability a constraint node states: `DEFERRABLE` and `INITIALLY DEFERRED`
 * arrive as present-true flags, and `INITIALLY DEFERRED` implies `DEFERRABLE` — the model's
 * normalization. An explicit `NOT DEFERRABLE` is the absent default and never surfaces on the
 * node, so nothing is written for it.
 */
function applyConstraintDeferrability(
  constraint: Constraint,
  target: Mutable<PrimaryKey | UniqueConstraint | ForeignKey>,
): void {
  if (constraint.deferrable === true || constraint.initdeferred === true) {
    target.deferrable = true;
  }
  if (constraint.initdeferred === true) target.initiallyDeferred = true;
}

/**
 * The enforcement a constraint node states, decoded from the parser's single `skip_validation`
 * channel: `NOT VALID` carries `is_enforced: true` beside it, while `NOT ENFORCED` — and the
 * combined `NOT VALID NOT ENFORCED`, which collapses to it — omits `is_enforced`; the
 * serializer never writes a false boolean. Absent when the node states neither.
 */
function constraintEnforcement(constraint: Constraint): ConstraintEnforcement | undefined {
  const flagged = constraint.skip_validation === true || constraint.initially_valid === false;
  if (!flagged) return undefined;
  return constraint.is_enforced === true ? 'not-valid' : 'not-enforced';
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
  if ((constraint.fk_del_set_cols ?? []).length > 0) flag('column list');

  const enforcement = constraintEnforcement(constraint);
  if (enforcement !== undefined) foreignKey.enforcement = enforcement;
  applyConstraintDeferrability(constraint, foreignKey);

  return foreignKey;
}

function uniqueConstraintFromConstraint(
  statement: ParsedStatement,
  constraint: Constraint,
  fallbackColumns: readonly string[],
  identity: string,
  diagnostics: PositionedDiagnostic[],
): UniqueConstraint {
  const keys = stringList(constraint.keys);
  const uniqueConstraint: Mutable<UniqueConstraint> = {
    columns: keys.length > 0 ? keys : fallbackColumns,
  };
  if (constraint.conname !== undefined) uniqueConstraint.name = constraint.conname;
  applyConstraintDeferrability(constraint, uniqueConstraint);
  flagUniqueConstraintAttributes(statement, constraint, identity, diagnostics);
  return uniqueConstraint;
}

/**
 * The check constraint a `CHECK` clause states: its name when written and the expression text
 * between the parentheses after `CHECK`, whitespace-normalized like a type or DEFAULT. A
 * constraint whose source gives no usable location cannot be modeled; it is flagged and
 * skipped whole.
 */
function checkConstraintFromConstraint(
  statement: ParsedStatement,
  constraint: Constraint,
  identity: string,
  diagnostics: PositionedDiagnostic[],
): CheckConstraint | undefined {
  const expression = checkExpressionText(statement, constraint);
  if (expression === undefined) {
    diagnostics.push(
      flagAttribute(statement, identity, `check expression on ${constraintLabel(constraint)}`),
    );
    return undefined;
  }
  const checkConstraint: Mutable<CheckConstraint> = { expression };
  if (constraint.conname !== undefined) checkConstraint.name = constraint.conname;
  const enforcement = constraintEnforcement(constraint);
  if (enforcement !== undefined) checkConstraint.enforcement = enforcement;
  flagCheckConstraintAttributes(statement, constraint, identity, diagnostics);
  return checkConstraint;
}

/**
 * The text between the parentheses after a constraint's `CHECK` keyword, whitespace-normalized
 * and without the outer parentheses, so rendering `CHECK (<expression>)` round-trips. The
 * constraint's location is the `CHECK` keyword for an inline constraint and the `CONSTRAINT`
 * keyword for an `ALTER TABLE … ADD CONSTRAINT`, so the scan starts there and finds the
 * keyword by name, skipping quoted spans and comments.
 */
function checkExpressionText(
  statement: ParsedStatement,
  constraint: Constraint,
): string | undefined {
  const location = constraint.location;
  if (location === undefined || location < 0) return undefined;
  const start = findCheckExpressionStart(statement.sql, byteOffsetToUtf16(statement.sql, location));
  if (start === null) return undefined;
  return extractSourceText(statement.sql, start, []);
}

/** Index just past the `(` after the first `CHECK` keyword at or after `from`, or `null`. */
function findCheckExpressionStart(sql: string, from: number): number | null {
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
    if (isKeywordAt(sql, index, 'CHECK')) {
      const open = skipTrivia(sql, index + 'CHECK'.length);
      return sql[open] === '(' ? open + 1 : null;
    }
    index += 1;
  }
  return null;
}

/**
 * Flags every attribute of a unique constraint that the model cannot carry, following the
 * foreign-key precedent: the constraint still imports with its representable identity, and
 * each dropped attribute is named. Deferrability is read into the model, so it is absent here;
 * `NOT VALID`/`NOT ENFORCED` cannot appear on a unique constraint (the server rejects them),
 * so the enforcement flag is defensive only.
 */
function flagUniqueConstraintAttributes(
  statement: ParsedStatement,
  constraint: Constraint,
  identity: string,
  diagnostics: PositionedDiagnostic[],
): void {
  const flag = (description: string): void => {
    diagnostics.push(
      flagAttribute(statement, identity, `${description} on ${constraintLabel(constraint)}`),
    );
  };
  if (constraint.nulls_not_distinct === true) flag('NULLS NOT DISTINCT');
  if ((constraint.including ?? []).length > 0) flag('INCLUDE');
  if (constraint.is_no_inherit === true) flag('NO INHERIT');
  if (constraint.skip_validation === true || constraint.initially_valid === false) {
    flag('NOT VALID');
  }
}

/**
 * Flags every attribute of a check constraint that the model cannot carry: `NO INHERIT`, and
 * deferrability, which the server rejects on a check constraint — only a misplaced inline
 * attribute node could carry it here, so the flag is defensive. Enforcement is read into the
 * model and never flagged.
 */
function flagCheckConstraintAttributes(
  statement: ParsedStatement,
  constraint: Constraint,
  identity: string,
  diagnostics: PositionedDiagnostic[],
): void {
  const flag = (description: string): void => {
    diagnostics.push(
      flagAttribute(statement, identity, `${description} on ${constraintLabel(constraint)}`),
    );
  };
  if (constraint.is_no_inherit === true) flag('NO INHERIT');
  if (constraint.deferrable === true || constraint.initdeferred === true) flag('deferrability');
}

/**
 * Attaches an `ADD CONSTRAINT … UNIQUE`: a plain key list attaches directly, while a
 * constraint stated `USING INDEX` consumes the named standalone index when it is a plain
 * column-list unique index; otherwise the whole constraint is skipped and named.
 */
function attachAlteredUniqueConstraint(
  statement: ParsedStatement,
  constraint: Constraint,
  identity: string,
  draft: TableDraft,
  diagnostics: PositionedDiagnostic[],
): void {
  const indexname = constraint.indexname;
  if (indexname === undefined) {
    attachUniqueConstraint(
      draft,
      uniqueConstraintFromConstraint(statement, constraint, [], identity, diagnostics),
    );
    return;
  }

  const position = draft.indexes.findIndex((index) => index.name === indexname && index.unique);
  const index = position === -1 ? undefined : draft.indexes[position]!;
  if (index === undefined) {
    diagnostics.push(
      skipStatement(
        statement,
        `${constraintLabel(constraint)} on ${identity} (USING INDEX ${indexname})`,
        constraint.conname ?? indexname,
      ),
    );
    return;
  }

  draft.indexes.splice(position, 1);
  const uniqueConstraint: Mutable<UniqueConstraint> = { columns: [...index.columns] };
  const name = constraint.conname ?? index.name;
  if (name !== undefined) uniqueConstraint.name = name;
  applyConstraintDeferrability(constraint, uniqueConstraint);
  flagUniqueConstraintAttributes(statement, constraint, identity, diagnostics);
  attachUniqueConstraint(draft, uniqueConstraint);
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
    case undefined:
    default:
      return undefined;
  }
}

/** A skipped statement's description and object, as `describeStatement` returns them. */
interface StatementDescription {
  readonly description: string;
  readonly object: string;
}

function describeStatement(node: Node): StatementDescription {
  if ('CreateSchemaStmt' in node) {
    const object = node.CreateSchemaStmt.schemaname ?? 'schema';
    return { description: `CREATE SCHEMA ${object}`, object };
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
  if ('SelectStmt' in node) {
    const setval = describeSetval(node.SelectStmt);
    return setval ?? { description: 'SELECT statement', object: 'SELECT' };
  }
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

/**
 * Describes a `SELECT` whose sole target is a `setval` (or `pg_catalog.setval`) call with a
 * string-literal first argument: `SELECT setval('public.s', 1, false)`, with the sequence
 * literal as the object and the remaining arguments as written. Any other `SELECT` — another
 * function, a first argument that is not a literal, or an argument this cannot state — returns
 * `undefined` and keeps the generic description.
 */
function describeSetval(stmt: SelectStmt): StatementDescription | undefined {
  const targets = stmt.targetList;
  if (targets?.length !== 1) return undefined;
  const target = targets[0]!;
  if (!('ResTarget' in target)) return undefined;
  const value = target.ResTarget.val;
  if (value === undefined || !('FuncCall' in value)) return undefined;
  if (!isSetvalCall(value.FuncCall.funcname)) return undefined;

  const args = value.FuncCall.args;
  if (args === undefined || args.length === 0) return undefined;
  const first = args[0]!;
  if (!('A_Const' in first) || first.A_Const.sval === undefined) return undefined;

  const written: string[] = [];
  for (const arg of args) {
    const text = constantText(arg);
    if (text === undefined) return undefined;
    written.push(text);
  }
  return {
    description: `SELECT setval(${written.join(', ')})`,
    object: first.A_Const.sval.sval ?? '',
  };
}

/** Whether a call's written name is `setval` or `pg_catalog.setval`, and nothing else. */
function isSetvalCall(funcname: readonly Node[] | undefined): boolean {
  const names = stringList(funcname);
  if (names.length === 1) return names[0] === 'setval';
  return names.length === 2 && names[0] === 'pg_catalog' && names[1] === 'setval';
}

/**
 * One constant argument as SQL text: a string literal quoted with `'` and internal quotes
 * doubled, a number or boolean bare, `NULL` for a null, and a bit string with its `B` prefix.
 * `undefined` for any other node, so a call with non-constant arguments keeps the generic
 * description rather than a half-written one.
 */
function constantText(node: Node): string | undefined {
  if (!('A_Const' in node)) return undefined;
  const constant = node.A_Const;
  if (constant.sval !== undefined) return `'${(constant.sval.sval ?? '').replaceAll("'", "''")}'`;
  if (constant.isnull === true) return 'NULL';
  if (constant.boolval !== undefined) return constant.boolval.boolval === true ? 'true' : 'false';
  if (constant.ival !== undefined) return BigInt(constant.ival.ival ?? 0).toString();
  if (constant.fval !== undefined && constant.fval.fval !== undefined) return constant.fval.fval;
  if (constant.bsval !== undefined) return `B'${constant.bsval.bsval ?? ''}'`;
  return undefined;
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
  const draft: TableDraft = {
    schema,
    name,
    columns: [],
    foreignKeys: [],
    uniqueConstraints: [],
    checkConstraints: [],
    indexes: [],
  };
  tables.set(key, draft);
  return draft;
}

/** The duplicate guard's key: `unique` and the ordered columns, the name excluded. */
function indexStructureKey(index: Index): string {
  return JSON.stringify([index.unique, index.columns]);
}

/** The duplicate guard's key for a unique constraint: the ordered columns and the attributes. */
function uniqueConstraintStructureKey(uniqueConstraint: UniqueConstraint): string {
  return JSON.stringify([
    uniqueConstraint.columns,
    uniqueConstraint.deferrable ?? false,
    uniqueConstraint.initiallyDeferred ?? false,
  ]);
}

/** The duplicate guard's key for a check constraint: the expression and the enforcement. */
function checkConstraintStructureKey(checkConstraint: CheckConstraint): string {
  return JSON.stringify([checkConstraint.expression, checkConstraint.enforcement ?? null]);
}

/**
 * The duplicate guard's key for a foreign key: every modeled field but the name — the
 * referencing columns, the target, the referenced columns, both actions, the enforcement, and
 * the deferrability, with an absent value distinct from a stated one. The key is
 * equality-minus-name: a name is kept only beside a twin identical modulo name; a twin
 * differing in referenced columns, actions, or attributes has a different key, the guard does
 * not fire, and the name is stripped. The core diff matches foreign keys more narrowly
 * (`foreignKeyIdentity`: columns and target only).
 */
function foreignKeyStructureKey(foreignKey: ForeignKey): string {
  return JSON.stringify([
    foreignKey.columns,
    foreignKey.referencedTable.schema,
    foreignKey.referencedTable.name,
    foreignKey.referencedColumns,
    foreignKey.onUpdate ?? null,
    foreignKey.onDelete ?? null,
    foreignKey.enforcement ?? null,
    foreignKey.deferrable ?? false,
    foreignKey.initiallyDeferred ?? false,
  ]);
}

/**
 * Canonicalizes server-generated index names back to unnamed: a `CREATE INDEX ON t (c)`
 * applies unnamed and PostgreSQL names the index `t_c_idx`, so a dump import would otherwise
 * store the generated name and diff as remove + add against the model's unnamed declaration.
 * An index whose name equals `synthesizedIndexName` is stripped, unless its structural key is
 * already covered by an unnamed entry — present in the draft or stripped earlier — in which
 * case the name is kept; the guard keeps the pass from manufacturing a duplicate unnamed entry
 * in either statement order. Runs in import order before the canonical sort, and names outside
 * the formula stay named: truncation and collision suffixes are not predictable offline.
 */
function canonicalizeIndexNames(draft: TableDraft): void {
  const identity: TableIdentity = { schema: draft.schema, name: draft.name };
  const seen = new Set<string>();
  for (const index of draft.indexes) {
    if (index.name === undefined) seen.add(indexStructureKey(index));
  }
  for (const index of draft.indexes) {
    const name = index.name;
    if (name === undefined || name !== synthesizedIndexName(identity, index)) continue;
    const key = indexStructureKey(index);
    if (seen.has(key)) continue;
    delete (index as Mutable<Index>).name;
    seen.add(key);
  }
}

/**
 * Canonicalizes server-generated primary-key, unique, foreign-key, and check-constraint names
 * back to unnamed, mirroring `canonicalizeIndexNames`: a constraint whose name equals the
 * prediction for its structure is stripped, unless an unnamed constraint with the same key —
 * the same columns, expression, or foreign-key target and actions — already exists in the
 * draft or was stripped earlier, in which case the name is kept, so neither statement order
 * manufactures a duplicate unnamed entry. The primary key has no twin guard: PostgreSQL allows
 * one per table. Runs in import order before the canonical sort, and names outside the formula
 * stay named: truncation and collision suffixes are not predictable offline, and a check
 * expression the best-effort formula does not predict keeps its server name.
 */
function canonicalizeConstraintNames(draft: TableDraft): void {
  const identity: TableIdentity = { schema: draft.schema, name: draft.name };
  const seenUnique = new Set<string>();
  const seenForeign = new Set<string>();
  const seenCheck = new Set<string>();

  // Pre-scan the unnamed entries of each kind, then strip in a second, position-independent pass.
  for (const uniqueConstraint of draft.uniqueConstraints) {
    if (uniqueConstraint.name === undefined) {
      seenUnique.add(uniqueConstraintStructureKey(uniqueConstraint));
    }
  }
  for (const foreignKey of draft.foreignKeys) {
    if (foreignKey.name === undefined) seenForeign.add(foreignKeyStructureKey(foreignKey));
  }
  for (const checkConstraint of draft.checkConstraints) {
    if (checkConstraint.name === undefined) {
      seenCheck.add(checkConstraintStructureKey(checkConstraint));
    }
  }

  const primaryKey = draft.primaryKey;
  if (primaryKey !== undefined && primaryKey.name === synthesizedPrimaryKeyName(identity)) {
    delete (primaryKey as Mutable<PrimaryKey>).name;
  }

  for (const uniqueConstraint of draft.uniqueConstraints) {
    const name = uniqueConstraint.name;
    if (
      name === undefined ||
      name !== synthesizedUniqueConstraintName(identity, uniqueConstraint)
    ) {
      continue;
    }
    const key = uniqueConstraintStructureKey(uniqueConstraint);
    if (seenUnique.has(key)) continue;
    delete (uniqueConstraint as Mutable<UniqueConstraint>).name;
    seenUnique.add(key);
  }
  for (const foreignKey of draft.foreignKeys) {
    const name = foreignKey.name;
    if (name === undefined || name !== synthesizedForeignKeyName(identity, foreignKey)) continue;
    const key = foreignKeyStructureKey(foreignKey);
    if (seenForeign.has(key)) continue;
    delete (foreignKey as Mutable<ForeignKey>).name;
    seenForeign.add(key);
  }
  for (const checkConstraint of draft.checkConstraints) {
    const name = checkConstraint.name;
    if (name === undefined || name !== synthesizedCheckConstraintName(identity, checkConstraint)) {
      continue;
    }
    const key = checkConstraintStructureKey(checkConstraint);
    if (seenCheck.has(key)) continue;
    delete (checkConstraint as Mutable<CheckConstraint>).name;
    seenCheck.add(key);
  }
}

function finalizeTable(draft: TableDraft): Table {
  canonicalizeConstraintNames(draft);
  canonicalizeIndexNames(draft);
  canonicalizeNotNullNames(draft);
  const table: Mutable<Table> = {
    schema: draft.schema,
    name: draft.name,
    columns: draft.columns,
    foreignKeys: [...draft.foreignKeys].sort(compareForeignKeys),
    uniqueConstraints: [...draft.uniqueConstraints].sort(compareUniqueConstraints),
    checkConstraints: [...draft.checkConstraints].sort(compareCheckConstraints),
    indexes: [...draft.indexes].sort(compareIndexes),
  };
  if (draft.primaryKey !== undefined) table.primaryKey = draft.primaryKey;
  return table;
}

/**
 * Canonicalizes PostgreSQL's generated not-null-constraint name back to unnamed: a dump of a
 * declaration the model makes unnamed carries `<table>_<column>_not_null`, and the model's
 * unnamed not-null fact must round-trip. The strip is the exact formula and nothing else —
 * truncation and collision suffixes stay named — and it has no twin guard, because one
 * not-null fact per column is the only shape the model carries: the duplicate declaration is
 * already collapsed by `mergeNotNullDeclaration` in either statement order.
 */
function canonicalizeNotNullNames(draft: TableDraft): void {
  draft.columns = draft.columns.map((column) => {
    if (
      column.notNullName === undefined ||
      column.notNullName !== synthesizedNotNullName(draft.name, column.name)
    ) {
      return column;
    }
    const copy: Mutable<Column> = {
      name: column.name,
      type: column.type,
      notNull: column.notNull,
    };
    if (column.default !== undefined) copy.default = column.default;
    if (column.identity !== undefined) copy.identity = column.identity;
    return copy;
  });
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
  return (
    left.name === right.name &&
    sameStringArray(left.columns, right.columns) &&
    left.deferrable === right.deferrable &&
    left.initiallyDeferred === right.initiallyDeferred
  );
}

function sameForeignKey(left: ForeignKey, right: ForeignKey): boolean {
  return left.name === right.name && foreignKeyStructureKey(left) === foreignKeyStructureKey(right);
}

function sameUniqueConstraint(left: UniqueConstraint, right: UniqueConstraint): boolean {
  return (
    left.name === right.name &&
    uniqueConstraintStructureKey(left) === uniqueConstraintStructureKey(right)
  );
}

function sameCheckConstraint(left: CheckConstraint, right: CheckConstraint): boolean {
  return (
    left.name === right.name &&
    checkConstraintStructureKey(left) === checkConstraintStructureKey(right)
  );
}

/** Whether two indexes are structurally equal; `concurrently` is apply metadata, excluded. */
function sameIndex(left: Index, right: Index): boolean {
  return (
    left.name === right.name &&
    left.unique === right.unique &&
    sameStringArray(left.columns, right.columns)
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

function compareUniqueConstraints(left: UniqueConstraint, right: UniqueConstraint): number {
  return (
    compareStringArrays(left.columns, right.columns) ||
    compareStrings(left.name ?? '', right.name ?? '')
  );
}

function compareCheckConstraints(left: CheckConstraint, right: CheckConstraint): number {
  return (
    compareStrings(left.expression, right.expression) ||
    compareStrings(left.name ?? '', right.name ?? '')
  );
}

function compareIndexes(left: Index, right: Index): number {
  return compareStrings(left.name ?? '', right.name ?? '');
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

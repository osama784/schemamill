import { assertNever, version } from '@schemamill/core';
import type {
  Change,
  CheckConstraint,
  Column,
  ColumnAttributes,
  ColumnFieldChange,
  CommentTarget,
  Diagnostic,
  Extension,
  ExtensionFieldChange,
  ExtensionIdentity,
  ForeignKey,
  Hazard,
  HazardEntity,
  Identity,
  IdentityChange,
  IdentityFieldChange,
  Index,
  IndexOwner,
  Model,
  PrimaryKey,
  Sequence,
  SequenceFieldChange,
  SequenceIdentity,
  SequenceOwner,
  Step,
  Table,
  TableChange,
  TableIdentity,
  TransactionGroup,
  UniqueConstraint,
  View,
  ViewFieldChange,
  ViewIdentity,
} from '@schemamill/core';

import type { ImportedSideMetadata } from './run.ts';

/**
 * The structured-JSON document mapper.
 *
 * The command layer owns the streams: this module only builds a plain object with keys inserted
 * in the documented order, and `stringifyJsonDocument` renders the canonical bytes at the final
 * write site. Nothing here reads the clock, the filesystem, the locale, or the environment; the
 * same inputs always produce the same bytes. Every `Change`, `TableChange`, `Step`, and `Hazard`
 * variant has its own case ending in `assertNever`, so a future core kind fails the build until it
 * is mapped here too. Embedded model values reuse the field names and optional-field omission of
 * `serializeModel` ([ADR 0023](../docs/adr/0023-export-projects-the-model.md)); step payloads are
 * flattened exactly as the TypeScript unions read. No internal class leaves this module.
 */

/** One side as the mapper needs it: the provenance `run.ts` surfaces, plus the side's model. */
export type JsonSideInput = ImportedSideMetadata & { readonly model: Model };

/** Compare carries only changes; plan carries the declared target version and the plan result. */
export type JsonDocumentInput =
  | {
      readonly command: 'compare';
      readonly baseline: JsonSideInput;
      readonly target: JsonSideInput;
      readonly changes: readonly Change[];
    }
  | {
      readonly command: 'plan';
      readonly baseline: JsonSideInput;
      readonly target: JsonSideInput;
      readonly targetVersion: number;
      readonly steps: readonly Step[];
      readonly groups: readonly TransactionGroup[];
      readonly hazards: readonly Hazard[];
    };

/** The four family counts, in the order `serializeModel` writes them. */
export interface JsonModelCounts {
  readonly tables: number;
  readonly sequences: number;
  readonly views: number;
  readonly extensions: number;
}

/** A side's provenance: `path` is present exactly for a dump, never for a workspace. */
export interface JsonSideDto {
  readonly source: 'dump' | 'workspace';
  readonly path?: string;
  readonly model: JsonModelCounts;
}

/** A full import finding; `object` belongs to skip and flag, `offset` to a located position. */
export interface JsonDiagnosticDto {
  readonly kind: Diagnostic['kind'];
  readonly code: Diagnostic['code'];
  readonly object?: string;
  readonly message: string;
  readonly position?: {
    readonly line: number;
    readonly column: number;
    readonly offset: number;
  };
}

/** A half-open range of steps, in plan order. */
export interface JsonGroupDto {
  readonly start: number;
  readonly end: number;
  readonly transactional: boolean;
}

/** The fields common to both documents, in envelope order. */
export interface JsonEnvelope {
  readonly schemaVersion: 1;
  readonly command: 'compare' | 'plan';
  readonly schemamill: { readonly version: string };
  readonly workspace: { readonly root: string } | null;
  readonly sides: { readonly baseline: JsonSideDto; readonly target: JsonSideDto };
  readonly diagnostics: {
    readonly baseline: readonly JsonDiagnosticDto[];
    readonly target: readonly JsonDiagnosticDto[];
  };
}

/** The compare document: no hazards — hazards belong to plan's result alone. */
export interface CompareJsonDocument extends JsonEnvelope {
  readonly command: 'compare';
  readonly result: { readonly changes: readonly object[] };
}

/** The plan document: semantic plan only; rendered SQL is deliberately not embedded. */
export interface PlanJsonDocument extends JsonEnvelope {
  readonly command: 'plan';
  readonly result: {
    readonly targetVersion: number;
    readonly steps: readonly object[];
    readonly groups: readonly JsonGroupDto[];
    readonly hazards: readonly object[];
  };
}

export type JsonDocument = CompareJsonDocument | PlanJsonDocument;

/**
 * Builds one document for `input`. Key insertion order is the documented one: the envelope first,
 * then the command-specific result. Empty arrays are kept, never dropped.
 */
export function buildJsonDocument(input: JsonDocumentInput): JsonDocument {
  const envelope: JsonEnvelope = {
    schemaVersion: 1,
    command: input.command,
    schemamill: { version },
    workspace: workspaceOf(input),
    sides: {
      baseline: mapSide(input.baseline),
      target: mapSide(input.target),
    },
    diagnostics: {
      baseline: input.baseline.diagnostics.map(mapDiagnostic),
      target: input.target.diagnostics.map(mapDiagnostic),
    },
  };

  return input.command === 'compare'
    ? { ...envelope, command: 'compare', result: { changes: input.changes.map(mapChange) } }
    : {
        ...envelope,
        command: 'plan',
        result: {
          targetVersion: input.targetVersion,
          steps: input.steps.map(mapStep),
          groups: input.groups.map(mapGroup),
          hazards: input.hazards.map(mapHazard),
        },
      };
}

/**
 * The canonical bytes for a document: two-space indentation and exactly one trailing newline.
 * Call this at the command's final write site so a single place owns the formatting.
 */
export function stringifyJsonDocument(document: JsonDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** At most one side resolves from a workspace; its root is the document's workspace root. */
function workspaceOf(input: JsonDocumentInput): { root: string } | null {
  const root =
    input.baseline.source === 'workspace'
      ? input.baseline.root
      : input.target.source === 'workspace'
        ? input.target.root
        : null;
  return root === null ? null : { root };
}

function mapSide(side: JsonSideInput): JsonSideDto {
  return side.source === 'dump'
    ? { source: 'dump', path: side.path, model: mapModelCounts(side.model) }
    : { source: 'workspace', model: mapModelCounts(side.model) };
}

function mapModelCounts(model: Model): JsonModelCounts {
  return {
    tables: model.tables.length,
    sequences: model.sequences.length,
    views: model.views.length,
    extensions: model.extensions.length,
  };
}

function mapDiagnostic(diagnostic: Diagnostic): JsonDiagnosticDto {
  return {
    kind: diagnostic.kind,
    code: diagnostic.code,
    ...(diagnostic.kind === 'error' ? {} : { object: diagnostic.object }),
    message: diagnostic.message,
    ...(diagnostic.position === undefined
      ? {}
      : {
          position: {
            line: diagnostic.position.line,
            column: diagnostic.position.column,
            offset: diagnostic.position.offset,
          },
        }),
  };
}

function mapGroup(group: TransactionGroup): JsonGroupDto {
  return { start: group.start, end: group.end, transactional: group.transactional };
}

// --- Model payloads, using serializeModel's field names and optional omission -----------------

function mapTableIdentity(identity: TableIdentity): object {
  return { schema: identity.schema, name: identity.name };
}

function mapSequenceIdentity(identity: SequenceIdentity): object {
  return { schema: identity.schema, name: identity.name };
}

function mapViewIdentity(identity: ViewIdentity): object {
  return { schema: identity.schema, name: identity.name };
}

function mapExtensionIdentity(identity: ExtensionIdentity): object {
  return { name: identity.name };
}

function mapOwner(owner: SequenceOwner): object {
  return { table: mapTableIdentity(owner.table), column: owner.column };
}

function mapColumnAttributes(attributes: ColumnAttributes): object {
  return {
    type: attributes.type,
    ...(attributes.collation === undefined ? {} : { collation: attributes.collation }),
    ...(attributes.storage === undefined ? {} : { storage: attributes.storage }),
    ...(attributes.compression === undefined ? {} : { compression: attributes.compression }),
    ...(attributes.statisticsTarget === undefined
      ? {}
      : { statisticsTarget: attributes.statisticsTarget }),
  };
}

function mapIdentity(identity: Identity): object {
  return {
    generated: identity.generated,
    ...(identity.sequenceName === undefined
      ? {}
      : { sequenceName: mapSequenceIdentity(identity.sequenceName) }),
    increment: identity.increment,
    minValue: identity.minValue,
    maxValue: identity.maxValue,
    start: identity.start,
    cache: identity.cache,
    cycle: identity.cycle,
  };
}

function mapColumn(column: Column): object {
  return {
    name: column.name,
    type: column.type,
    notNull: column.notNull,
    ...(column.notNullName === undefined ? {} : { notNullName: column.notNullName }),
    ...(column.notNullComment === undefined ? {} : { notNullComment: column.notNullComment }),
    ...(column.default === undefined ? {} : { default: column.default }),
    ...(column.identity === undefined ? {} : { identity: mapIdentity(column.identity) }),
    ...(column.collation === undefined ? {} : { collation: column.collation }),
    ...(column.storage === undefined ? {} : { storage: column.storage }),
    ...(column.compression === undefined ? {} : { compression: column.compression }),
    ...(column.statisticsTarget === undefined ? {} : { statisticsTarget: column.statisticsTarget }),
    ...(column.comment === undefined ? {} : { comment: column.comment }),
  };
}

function mapPrimaryKey(key: PrimaryKey): object {
  return {
    ...(key.name === undefined ? {} : { name: key.name }),
    columns: [...key.columns],
    ...(key.deferrable === undefined ? {} : { deferrable: key.deferrable }),
    ...(key.initiallyDeferred === undefined ? {} : { initiallyDeferred: key.initiallyDeferred }),
    ...(key.comment === undefined ? {} : { comment: key.comment }),
  };
}

function mapUniqueConstraint(constraint: UniqueConstraint): object {
  return {
    ...(constraint.name === undefined ? {} : { name: constraint.name }),
    columns: [...constraint.columns],
    ...(constraint.deferrable === undefined ? {} : { deferrable: constraint.deferrable }),
    ...(constraint.initiallyDeferred === undefined
      ? {}
      : { initiallyDeferred: constraint.initiallyDeferred }),
    ...(constraint.comment === undefined ? {} : { comment: constraint.comment }),
  };
}

function mapCheckConstraint(constraint: CheckConstraint): object {
  return {
    ...(constraint.name === undefined ? {} : { name: constraint.name }),
    expression: constraint.expression,
    ...(constraint.enforcement === undefined ? {} : { enforcement: constraint.enforcement }),
    ...(constraint.comment === undefined ? {} : { comment: constraint.comment }),
  };
}

function mapForeignKey(foreignKey: ForeignKey): object {
  return {
    ...(foreignKey.name === undefined ? {} : { name: foreignKey.name }),
    columns: [...foreignKey.columns],
    referencedTable: mapTableIdentity(foreignKey.referencedTable),
    referencedColumns: [...foreignKey.referencedColumns],
    ...(foreignKey.onUpdate === undefined ? {} : { onUpdate: foreignKey.onUpdate }),
    ...(foreignKey.onDelete === undefined ? {} : { onDelete: foreignKey.onDelete }),
    ...(foreignKey.enforcement === undefined ? {} : { enforcement: foreignKey.enforcement }),
    ...(foreignKey.deferrable === undefined ? {} : { deferrable: foreignKey.deferrable }),
    ...(foreignKey.initiallyDeferred === undefined
      ? {}
      : { initiallyDeferred: foreignKey.initiallyDeferred }),
    ...(foreignKey.comment === undefined ? {} : { comment: foreignKey.comment }),
  };
}

function mapIndex(index: Index): object {
  return {
    ...(index.name === undefined ? {} : { name: index.name }),
    unique: index.unique,
    columns: [...index.columns],
    ...(index.concurrently === undefined ? {} : { concurrently: index.concurrently }),
    ...(index.comment === undefined ? {} : { comment: index.comment }),
  };
}

function mapSequence(sequence: Sequence): object {
  return {
    schema: sequence.schema,
    name: sequence.name,
    dataType: sequence.dataType,
    increment: sequence.increment,
    minValue: sequence.minValue,
    maxValue: sequence.maxValue,
    start: sequence.start,
    cache: sequence.cache,
    cycle: sequence.cycle,
    ...(sequence.ownedBy === undefined ? {} : { ownedBy: mapOwner(sequence.ownedBy) }),
    ...(sequence.comment === undefined ? {} : { comment: sequence.comment }),
  };
}

function mapView(view: View): object {
  return {
    schema: view.schema,
    name: view.name,
    materialized: view.materialized,
    definition: view.definition,
    ...(view.indexes === undefined || view.indexes.length === 0
      ? {}
      : { indexes: view.indexes.map(mapIndex) }),
    ...(view.checkOption === undefined ? {} : { checkOption: view.checkOption }),
    ...(view.comment === undefined ? {} : { comment: view.comment }),
  };
}

function mapExtension(extension: Extension): object {
  return {
    schema: extension.schema,
    name: extension.name,
    ...(extension.comment === undefined ? {} : { comment: extension.comment }),
  };
}

function mapTable(table: Table): object {
  return {
    schema: table.schema,
    name: table.name,
    columns: table.columns.map(mapColumn),
    ...(table.primaryKey === undefined ? {} : { primaryKey: mapPrimaryKey(table.primaryKey) }),
    foreignKeys: table.foreignKeys.map(mapForeignKey),
    uniqueConstraints: table.uniqueConstraints.map(mapUniqueConstraint),
    checkConstraints: table.checkConstraints.map(mapCheckConstraint),
    indexes: table.indexes.map(mapIndex),
    ...(table.persistence === undefined ? {} : { persistence: table.persistence }),
    ...(table.comment === undefined ? {} : { comment: table.comment }),
  };
}

function mapIndexOwner(owner: IndexOwner): object {
  switch (owner.kind) {
    case 'table':
      return { kind: 'table', table: mapTableIdentity(owner.table) };
    case 'materialized-view':
      return { kind: 'materialized-view', view: mapViewIdentity(owner.view) };
    default:
      return assertNever(owner, 'IndexOwner');
  }
}

// --- Differing-field payloads: field, before?, after?, converted? ------------------------------

function isSequenceOwner(value: unknown): value is SequenceOwner {
  return typeof value === 'object' && value !== null && 'table' in value && 'column' in value;
}

function mapFieldPair(field: string, before: unknown, after: unknown, converted?: boolean): object {
  return {
    field,
    ...(before === undefined
      ? {}
      : { before: isSequenceOwner(before) ? mapOwner(before) : before }),
    ...(after === undefined ? {} : { after: isSequenceOwner(after) ? mapOwner(after) : after }),
    ...(converted === undefined ? {} : { converted }),
  };
}

function mapColumnFieldChange(change: ColumnFieldChange): object {
  return mapFieldPair(change.field, change.before, change.after);
}

function mapIdentityFieldChange(change: IdentityFieldChange): object {
  return mapFieldPair(
    change.field,
    change.before,
    change.after,
    'converted' in change ? change.converted : undefined,
  );
}

function mapSequenceFieldChange(change: SequenceFieldChange): object {
  return mapFieldPair(
    change.field,
    change.before,
    change.after,
    'converted' in change ? change.converted : undefined,
  );
}

function mapViewFieldChange(change: ViewFieldChange): object {
  return mapFieldPair(change.field, change.before, change.after);
}

function mapExtensionFieldChange(change: ExtensionFieldChange): object {
  return mapFieldPair(change.field, change.before, change.after);
}

// --- Comment targets and hazard entities ------------------------------------------------------

function mapCommentTarget(target: CommentTarget): object {
  switch (target.kind) {
    case 'table':
      return { kind: 'table', table: mapTableIdentity(target.table) };
    case 'column':
      return { kind: 'column', table: mapTableIdentity(target.table), column: target.column };
    case 'not-null':
      return {
        kind: 'not-null',
        table: mapTableIdentity(target.table),
        column: mapColumn(target.column),
      };
    case 'sequence':
      return { kind: 'sequence', sequence: mapSequenceIdentity(target.sequence) };
    case 'view':
      return {
        kind: 'view',
        view: mapViewIdentity(target.view),
        materialized: target.materialized,
      };
    case 'extension':
      return { kind: 'extension', extension: mapExtensionIdentity(target.extension) };
    case 'index':
      return {
        kind: 'index',
        table: mapTableIdentity(target.table),
        index: mapIndex(target.index),
      };
    case 'primary-key':
      return {
        kind: 'primary-key',
        table: mapTableIdentity(target.table),
        primaryKey: mapPrimaryKey(target.primaryKey),
      };
    case 'unique-constraint':
      return {
        kind: 'unique-constraint',
        table: mapTableIdentity(target.table),
        uniqueConstraint: mapUniqueConstraint(target.uniqueConstraint),
      };
    case 'check-constraint':
      return {
        kind: 'check-constraint',
        table: mapTableIdentity(target.table),
        checkConstraint: mapCheckConstraint(target.checkConstraint),
      };
    case 'foreign-key':
      return {
        kind: 'foreign-key',
        table: mapTableIdentity(target.table),
        foreignKey: mapForeignKey(target.foreignKey),
      };
    default:
      return assertNever(target, 'CommentTarget');
  }
}

function mapHazardEntity(entity: HazardEntity): object {
  switch (entity.kind) {
    case 'sequence':
      return { kind: 'sequence', sequence: mapSequenceIdentity(entity.sequence) };
    case 'identity-column':
      return {
        kind: 'identity-column',
        table: mapTableIdentity(entity.table),
        column: entity.column,
      };
    case 'table':
      return { kind: 'table', table: mapTableIdentity(entity.table) };
    default:
      return assertNever(entity, 'HazardEntity');
  }
}

// --- Change, TableChange, Step and Hazard DTOs -------------------------------------------------

function mapChange(change: Change): object {
  switch (change.kind) {
    case 'table-added':
      return { kind: 'table-added', table: mapTable(change.table) };
    case 'table-removed':
      return { kind: 'table-removed', table: mapTable(change.table) };
    case 'table-changed':
      return {
        kind: 'table-changed',
        table: mapTableIdentity(change.table),
        changes: change.changes.map(mapTableChange),
      };
    case 'sequence-added':
      return { kind: 'sequence-added', sequence: mapSequence(change.sequence) };
    case 'sequence-removed':
      return { kind: 'sequence-removed', sequence: mapSequence(change.sequence) };
    case 'sequence-changed':
      return {
        kind: 'sequence-changed',
        sequence: mapSequenceIdentity(change.sequence),
        changes: change.changes.map(mapSequenceFieldChange),
      };
    case 'view-added':
      return { kind: 'view-added', view: mapView(change.view) };
    case 'view-removed':
      return { kind: 'view-removed', view: mapView(change.view) };
    case 'view-changed':
      return {
        kind: 'view-changed',
        view: mapViewIdentity(change.view),
        changes: change.changes.map(mapViewFieldChange),
        before: mapView(change.before),
        after: mapView(change.after),
      };
    case 'view-index-added':
      return {
        kind: 'view-index-added',
        owner: mapIndexOwner(change.owner),
        index: mapIndex(change.index),
      };
    case 'view-index-removed':
      return {
        kind: 'view-index-removed',
        owner: mapIndexOwner(change.owner),
        index: mapIndex(change.index),
      };
    case 'view-index-changed':
      return {
        kind: 'view-index-changed',
        owner: mapIndexOwner(change.owner),
        before: mapIndex(change.before),
        after: mapIndex(change.after),
      };
    case 'extension-added':
      return { kind: 'extension-added', extension: mapExtension(change.extension) };
    case 'extension-removed':
      return { kind: 'extension-removed', extension: mapExtension(change.extension) };
    case 'extension-changed':
      return {
        kind: 'extension-changed',
        extension: mapExtensionIdentity(change.extension),
        changes: change.changes.map(mapExtensionFieldChange),
      };
    case 'comment-changed':
      return {
        kind: 'comment-changed',
        target: mapCommentTarget(change.target),
        ...(change.before === undefined ? {} : { before: change.before }),
        ...(change.after === undefined ? {} : { after: change.after }),
      };
    default:
      return assertNever(change, 'Change');
  }
}

function mapTableChange(change: TableChange): object {
  switch (change.kind) {
    case 'column-added':
      return { kind: 'column-added', column: mapColumn(change.column) };
    case 'column-removed':
      return { kind: 'column-removed', column: mapColumn(change.column) };
    case 'column-changed':
      return {
        kind: 'column-changed',
        name: change.name,
        fields: change.fields.map(mapColumnFieldChange),
        ...(change.identity === undefined ? {} : { identity: mapIdentityChange(change.identity) }),
        ...(change.attributes === undefined
          ? {}
          : { attributes: mapColumnAttributes(change.attributes) }),
      };
    case 'primary-key-added':
      return { kind: 'primary-key-added', primaryKey: mapPrimaryKey(change.primaryKey) };
    case 'primary-key-removed':
      return { kind: 'primary-key-removed', primaryKey: mapPrimaryKey(change.primaryKey) };
    case 'primary-key-changed':
      return {
        kind: 'primary-key-changed',
        before: mapPrimaryKey(change.before),
        after: mapPrimaryKey(change.after),
      };
    case 'foreign-key-added':
      return { kind: 'foreign-key-added', foreignKey: mapForeignKey(change.foreignKey) };
    case 'foreign-key-removed':
      return { kind: 'foreign-key-removed', foreignKey: mapForeignKey(change.foreignKey) };
    case 'foreign-key-changed':
      return {
        kind: 'foreign-key-changed',
        before: mapForeignKey(change.before),
        after: mapForeignKey(change.after),
      };
    case 'unique-constraint-added':
      return {
        kind: 'unique-constraint-added',
        uniqueConstraint: mapUniqueConstraint(change.uniqueConstraint),
      };
    case 'unique-constraint-removed':
      return {
        kind: 'unique-constraint-removed',
        uniqueConstraint: mapUniqueConstraint(change.uniqueConstraint),
      };
    case 'unique-constraint-changed':
      return {
        kind: 'unique-constraint-changed',
        before: mapUniqueConstraint(change.before),
        after: mapUniqueConstraint(change.after),
      };
    case 'check-constraint-added':
      return {
        kind: 'check-constraint-added',
        checkConstraint: mapCheckConstraint(change.checkConstraint),
      };
    case 'check-constraint-removed':
      return {
        kind: 'check-constraint-removed',
        checkConstraint: mapCheckConstraint(change.checkConstraint),
      };
    case 'check-constraint-changed':
      return {
        kind: 'check-constraint-changed',
        before: mapCheckConstraint(change.before),
        after: mapCheckConstraint(change.after),
      };
    case 'index-added':
      return { kind: 'index-added', index: mapIndex(change.index) };
    case 'index-removed':
      return { kind: 'index-removed', index: mapIndex(change.index) };
    case 'index-changed':
      return {
        kind: 'index-changed',
        before: mapIndex(change.before),
        after: mapIndex(change.after),
      };
    case 'persistence-changed':
      return {
        kind: 'persistence-changed',
        ...(change.before === undefined ? {} : { before: change.before }),
        ...(change.after === undefined ? {} : { after: change.after }),
      };
    default:
      return assertNever(change, 'TableChange');
  }
}

/**
 * `IdentityChange` is not in the brief's three exhaustive unions, but it is mapped exhaustively
 * too: a new variant must be projected here before the document can carry it.
 */
function mapIdentityChange(change: IdentityChange): object {
  switch (change.kind) {
    case 'added':
      return { kind: 'added', identity: mapIdentity(change.identity) };
    case 'removed':
      return { kind: 'removed', identity: mapIdentity(change.identity) };
    case 'recreated':
      return { kind: 'recreated', identity: mapIdentity(change.identity) };
    case 'changed':
      return {
        kind: 'changed',
        fields: change.fields.map(mapIdentityFieldChange),
      };
    default:
      return assertNever(change, 'IdentityChange');
  }
}

function mapStep(step: Step): object {
  switch (step.kind) {
    case 'create-schema':
      return { kind: 'create-schema', schema: step.schema };
    case 'create-table':
      return { kind: 'create-table', table: mapTable(step.table) };
    case 'drop-table':
      return { kind: 'drop-table', table: mapTableIdentity(step.table) };
    case 'add-column':
      return {
        kind: 'add-column',
        table: mapTableIdentity(step.table),
        column: mapColumn(step.column),
      };
    case 'drop-column':
      return {
        kind: 'drop-column',
        table: mapTableIdentity(step.table),
        column: mapColumn(step.column),
      };
    case 'alter-column':
      return {
        kind: 'alter-column',
        table: mapTableIdentity(step.table),
        name: step.name,
        fields: step.fields.map(mapColumnFieldChange),
        ...(step.attributes === undefined
          ? {}
          : { attributes: mapColumnAttributes(step.attributes) }),
      };
    case 'drop-not-null':
      return {
        kind: 'drop-not-null',
        table: mapTableIdentity(step.table),
        column: step.column,
        ...(step.name === undefined ? {} : { name: step.name }),
      };
    case 'add-not-null':
      return {
        kind: 'add-not-null',
        table: mapTableIdentity(step.table),
        column: step.column,
        ...(step.name === undefined ? {} : { name: step.name }),
      };
    case 'alter-persistence':
      return {
        kind: 'alter-persistence',
        table: mapTableIdentity(step.table),
        ...(step.persistence === undefined ? {} : { persistence: step.persistence }),
      };
    case 'add-identity':
      return {
        kind: 'add-identity',
        table: mapTableIdentity(step.table),
        name: step.name,
        identity: mapIdentity(step.identity),
      };
    case 'drop-identity':
      return { kind: 'drop-identity', table: mapTableIdentity(step.table), name: step.name };
    case 'alter-identity':
      return {
        kind: 'alter-identity',
        table: mapTableIdentity(step.table),
        name: step.name,
        fields: step.fields.map(mapIdentityFieldChange),
      };
    case 'add-primary-key':
      return {
        kind: 'add-primary-key',
        table: mapTableIdentity(step.table),
        primaryKey: mapPrimaryKey(step.primaryKey),
      };
    case 'drop-primary-key':
      return {
        kind: 'drop-primary-key',
        table: mapTableIdentity(step.table),
        primaryKey: mapPrimaryKey(step.primaryKey),
      };
    case 'add-foreign-key':
      return {
        kind: 'add-foreign-key',
        table: mapTableIdentity(step.table),
        foreignKey: mapForeignKey(step.foreignKey),
      };
    case 'drop-foreign-key':
      return {
        kind: 'drop-foreign-key',
        table: mapTableIdentity(step.table),
        foreignKey: mapForeignKey(step.foreignKey),
      };
    case 'add-unique-constraint':
      return {
        kind: 'add-unique-constraint',
        table: mapTableIdentity(step.table),
        uniqueConstraint: mapUniqueConstraint(step.uniqueConstraint),
      };
    case 'drop-unique-constraint':
      return {
        kind: 'drop-unique-constraint',
        table: mapTableIdentity(step.table),
        uniqueConstraint: mapUniqueConstraint(step.uniqueConstraint),
      };
    case 'add-check-constraint':
      return {
        kind: 'add-check-constraint',
        table: mapTableIdentity(step.table),
        checkConstraint: mapCheckConstraint(step.checkConstraint),
      };
    case 'drop-check-constraint':
      return {
        kind: 'drop-check-constraint',
        table: mapTableIdentity(step.table),
        checkConstraint: mapCheckConstraint(step.checkConstraint),
      };
    case 'create-index':
      return {
        kind: 'create-index',
        owner: mapIndexOwner(step.owner),
        index: mapIndex(step.index),
      };
    case 'drop-index':
      return { kind: 'drop-index', owner: mapIndexOwner(step.owner), index: mapIndex(step.index) };
    case 'create-index-concurrently':
      return {
        kind: 'create-index-concurrently',
        owner: mapIndexOwner(step.owner),
        index: mapIndex(step.index),
      };
    case 'drop-index-concurrently':
      return {
        kind: 'drop-index-concurrently',
        owner: mapIndexOwner(step.owner),
        index: mapIndex(step.index),
      };
    case 'create-sequence':
      return { kind: 'create-sequence', sequence: mapSequence(step.sequence) };
    case 'drop-sequence':
      return { kind: 'drop-sequence', sequence: mapSequenceIdentity(step.sequence) };
    case 'alter-sequence':
      return {
        kind: 'alter-sequence',
        sequence: mapSequenceIdentity(step.sequence),
        fields: step.fields.map(mapSequenceFieldChange),
      };
    case 'create-extension':
      return { kind: 'create-extension', extension: mapExtension(step.extension) };
    case 'alter-extension':
      return {
        kind: 'alter-extension',
        extension: mapExtensionIdentity(step.extension),
        fields: step.fields.map(mapExtensionFieldChange),
      };
    case 'drop-extension':
      return { kind: 'drop-extension', extension: mapExtensionIdentity(step.extension) };
    case 'create-view':
      return { kind: 'create-view', view: mapView(step.view) };
    case 'drop-view':
      return {
        kind: 'drop-view',
        view: mapViewIdentity(step.view),
        materialized: step.materialized,
      };
    case 'replace-view':
      return { kind: 'replace-view', view: mapView(step.view) };
    case 'comment':
      return {
        kind: 'comment',
        target: mapCommentTarget(step.target),
        ...(step.text === undefined ? {} : { text: step.text }),
      };
    default:
      return assertNever(step, 'Step');
  }
}

function mapHazard(hazard: Hazard): object {
  const entity = mapHazardEntity(hazard.entity);
  switch (hazard.kind) {
    case 'increment-zero':
      return {
        kind: 'increment-zero',
        step: hazard.step,
        entity,
        increment: hazard.increment,
      };
    case 'cache-nonpositive':
      return { kind: 'cache-nonpositive', step: hazard.step, entity, cache: hazard.cache };
    case 'bounds-inverted':
      return {
        kind: 'bounds-inverted',
        step: hazard.step,
        entity,
        minValue: hazard.minValue,
        maxValue: hazard.maxValue,
      };
    case 'start-out-of-bounds':
      return {
        kind: 'start-out-of-bounds',
        step: hazard.step,
        entity,
        start: hazard.start,
        minValue: hazard.minValue,
        maxValue: hazard.maxValue,
      };
    case 'bound-out-of-type-range':
      return {
        kind: 'bound-out-of-type-range',
        step: hazard.step,
        entity,
        dataType: hazard.dataType,
        field: hazard.field,
        value: hazard.value,
      };
    case 'bound-tightened':
      return {
        kind: 'bound-tightened',
        step: hazard.step,
        entity,
        field: hazard.field,
        before: hazard.before,
        after: hazard.after,
      };
    case 'table-rewrite':
      return {
        kind: 'table-rewrite',
        step: hazard.step,
        entity,
        ...(hazard.persistence === undefined ? {} : { persistence: hazard.persistence }),
      };
    default:
      return assertNever(hazard, 'Hazard');
  }
}

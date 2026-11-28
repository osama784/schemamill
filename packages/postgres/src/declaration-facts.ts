import { assertNever } from '@schemamill/core';
import type {
  CheckConstraint,
  Column,
  ColumnCompression,
  ForeignKey,
  Model,
  Plan,
  Step,
  Table,
  TableIdentity,
} from '@schemamill/core';

import { synthesizedCheckConstraintName, synthesizedForeignKeyName } from './names.ts';

/** The first PostgreSQL major that stores a named not-null fact in `pg_constraint`. */
export const NOT_NULL_DECLARATION_MIN_MAJOR = 18;

/** The first PostgreSQL major that accepts an explicit column compression method. */
export const COMPRESSION_DECLARATION_MIN_MAJOR = 14;

/**
 * The capability a declaration needs, and the PostgreSQL major that first accepts it. `floor` is
 * carried on every fact so the renderer's refusal message names the capability and the floor from
 * one source, and so hazard analysis can consume the same facts later.
 */
export type DeclarationForm =
  | 'named-not-null'
  | 'named-not-null-drop'
  | 'not-null-comment'
  | 'not-enforced'
  | 'explicit-compression';

interface DeclarationFactBase {
  /** Where the fact came from: the target model or a plan step. */
  readonly origin: 'model' | 'step';
  /** The plan index: `-1` for a model-carried fact. Emitter-local facts also use `-1`. */
  readonly step: number;
  /** The schema-qualified table the declaration belongs to. */
  readonly table: TableIdentity;
  /** The first PostgreSQL major that can express the form. */
  readonly floor: number;
}

/** One version-sensitive declaration, with the payload its refusal message needs. */
export type DeclarationFact = DeclarationFactBase &
  (
    | { readonly form: 'named-not-null'; readonly column: string }
    | { readonly form: 'named-not-null-drop'; readonly column: string }
    | { readonly form: 'not-null-comment'; readonly column: string }
    | { readonly form: 'not-enforced'; readonly constraint: string }
    | {
        readonly form: 'explicit-compression';
        readonly column: string;
        readonly method: ColumnCompression;
      }
  );

/** Options for {@link collectDeclarationFacts}. */
export interface DeclarationFactOptions {
  /**
   * The target model. When supplied, its carried declarations are collected even when the plan
   * does not touch their table — the issue's goal is model-carried, not emitted-only. Absent, only
   * the plan's step-backed facts are collected, which keeps existing library callers unchanged.
   */
  readonly targetModel?: Model;
}

/**
 * The pure collector behind the declaration gate (and, later, declaration hazards).
 *
 * It reads only the plan and the optional target model; it renders no SQL and consults no catalog.
 * Facts are returned in a deterministic order: model-carried facts first in model order — tables,
 * then each table's columns in source order, then its check constraints, then its foreign keys —
 * followed by step-backed facts in plan order and in the order each step's payload is emitted.
 * A caller that refuses the first fact below its floor therefore reports the same offender on
 * every run, and (model order, step index, fact order) is the pinned precedence.
 *
 * The collected forms are:
 * - a named `NOT NULL` fact (floor 18), which on PostgreSQL 13–17 either loses its inline name or
 *   is rejected outright in the table-constraint form;
 * - a named `DROP NOT NULL` (floor 18), whose `DROP CONSTRAINT` cannot resolve a `pg_constraint`
 *   row below 18;
 * - a `COMMENT ON CONSTRAINT` targeting a not-null fact (floor 18), for the same reason;
 * - `NOT ENFORCED` on a check or foreign key (floor 18), which is a syntax error below 18;
 * - an explicit `COMPRESSION` method (floor 14), which is a syntax error on 13. Inline `STORAGE`
 *   is a *named residual* and is deliberately absent: the renderer never emits it, and the
 *   `ALTER … SET STORAGE` it does emit is valid on 13–18. Synthesized resets are not declarations
 *   either; the renderer's existing reset gates own them and their separate messages.
 *
 * A fact's `origin` distinguishes model-carried from step-backed facts, and `step` keeps the plan
 * position for consumers that need it. Facts created by an emitter for its own defensive check
 * carry `origin: 'step'` and `step: -1`; they are never merged into this collector's output.
 */
export function collectDeclarationFacts(
  plan: Plan,
  options?: DeclarationFactOptions,
): readonly DeclarationFact[] {
  const facts: DeclarationFact[] = [];
  if (options?.targetModel !== undefined) {
    for (const table of options.targetModel.tables) {
      collectTableFacts(facts, table, 'model', -1);
    }
  }
  for (const [step, planStep] of plan.steps.entries()) {
    collectStepFacts(facts, step, planStep);
  }
  return facts;
}

/**
 * The model-carried facts of one table: columns first (not-null name, then compression), then
 * check constraints, then foreign keys. This is also the order `create-table` emits them.
 */
function collectTableFacts(
  facts: DeclarationFact[],
  table: Table,
  origin: DeclarationFact['origin'],
  step: number,
): void {
  for (const column of table.columns) collectColumnFacts(facts, table, column, origin, step);
  for (const check of table.checkConstraints) collectCheckFact(facts, table, check, origin, step);
  for (const foreignKey of table.foreignKeys) {
    collectForeignKeyFact(facts, table, foreignKey, origin, step);
  }
}

/** A column's named not-null fact and its explicit compression method, when stated. */
function collectColumnFacts(
  facts: DeclarationFact[],
  table: TableIdentity,
  column: Column,
  origin: DeclarationFact['origin'],
  step: number,
): void {
  if (column.notNull && column.notNullName !== undefined) {
    facts.push({
      form: 'named-not-null',
      origin,
      step,
      table,
      column: column.name,
      floor: NOT_NULL_DECLARATION_MIN_MAJOR,
    });
  }
  if (column.compression !== undefined) {
    facts.push({
      form: 'explicit-compression',
      origin,
      step,
      table,
      column: column.name,
      method: column.compression,
      floor: COMPRESSION_DECLARATION_MIN_MAJOR,
    });
  }
}

/** A check constraint's `NOT ENFORCED`, resolving an unnamed constraint as the renderer does. */
function collectCheckFact(
  facts: DeclarationFact[],
  table: TableIdentity,
  check: CheckConstraint,
  origin: DeclarationFact['origin'],
  step: number,
): void {
  if (check.enforcement !== 'not-enforced') return;
  facts.push({
    form: 'not-enforced',
    origin,
    step,
    table,
    constraint: check.name ?? synthesizedCheckConstraintName(table, check),
    floor: NOT_NULL_DECLARATION_MIN_MAJOR,
  });
}

/** A foreign key's `NOT ENFORCED`, resolving an unnamed key as the renderer does. */
function collectForeignKeyFact(
  facts: DeclarationFact[],
  table: TableIdentity,
  foreignKey: ForeignKey,
  origin: DeclarationFact['origin'],
  step: number,
): void {
  if (foreignKey.enforcement !== 'not-enforced') return;
  facts.push({
    form: 'not-enforced',
    origin,
    step,
    table,
    constraint: foreignKey.name ?? synthesizedForeignKeyName(table, foreignKey),
    floor: NOT_NULL_DECLARATION_MIN_MAJOR,
  });
}

/** Every declaration a single step carries, in emission order. */
function collectStepFacts(facts: DeclarationFact[], step: number, planStep: Step): void {
  switch (planStep.kind) {
    case 'create-table':
      collectTableFacts(facts, planStep.table, 'step', step);
      break;
    case 'add-column':
      collectColumnFacts(facts, planStep.table, planStep.column, 'step', step);
      break;
    case 'add-not-null':
      if (planStep.name !== undefined) {
        facts.push({
          form: 'named-not-null',
          origin: 'step',
          step,
          table: planStep.table,
          column: planStep.column,
          floor: NOT_NULL_DECLARATION_MIN_MAJOR,
        });
      }
      break;
    case 'drop-not-null':
      if (planStep.name !== undefined) {
        facts.push({
          form: 'named-not-null-drop',
          origin: 'step',
          step,
          table: planStep.table,
          column: planStep.column,
          floor: NOT_NULL_DECLARATION_MIN_MAJOR,
        });
      }
      break;
    case 'comment':
      if (planStep.target.kind === 'not-null') {
        facts.push({
          form: 'not-null-comment',
          origin: 'step',
          step,
          table: planStep.target.table,
          column: planStep.target.column.name,
          floor: NOT_NULL_DECLARATION_MIN_MAJOR,
        });
      }
      break;
    case 'add-check-constraint':
      collectCheckFact(facts, planStep.table, planStep.checkConstraint, 'step', step);
      break;
    case 'add-foreign-key':
      collectForeignKeyFact(facts, planStep.table, planStep.foreignKey, 'step', step);
      break;
    case 'alter-column': {
      // The merged `TYPE` statement restates what it resets, so the carrier's explicit method is
      // the declaration there; without a merge, each standalone compression field states its own.
      // `renderAlterColumn` ignores `attributes` unless a type or collation field merges, so the
      // carrier is a declaration only in that case — never for a not-null/default-only step.
      const merged = planStep.fields.some(
        (field) => field.field === 'type' || field.field === 'collation',
      );
      const carrier = merged ? planStep.attributes?.compression : undefined;
      if (carrier !== undefined) {
        facts.push({
          form: 'explicit-compression',
          origin: 'step',
          step,
          table: planStep.table,
          column: planStep.name,
          method: carrier,
          floor: COMPRESSION_DECLARATION_MIN_MAJOR,
        });
      }
      for (const field of planStep.fields) {
        if (field.field !== 'compression' || field.after === undefined) continue;
        facts.push({
          form: 'explicit-compression',
          origin: 'step',
          step,
          table: planStep.table,
          column: planStep.name,
          method: field.after,
          floor: COMPRESSION_DECLARATION_MIN_MAJOR,
        });
      }
      break;
    }
    case 'create-schema':
    case 'drop-table':
    case 'drop-column':
    case 'alter-persistence':
    case 'add-identity':
    case 'drop-identity':
    case 'alter-identity':
    case 'drop-primary-key':
    case 'drop-foreign-key':
    case 'drop-unique-constraint':
    case 'drop-check-constraint':
    case 'add-exclusion-constraint':
    case 'drop-exclusion-constraint':
    case 'add-primary-key':
    case 'add-unique-constraint':
    case 'create-index':
    case 'create-index-concurrently':
    case 'drop-index':
    case 'drop-index-concurrently':
    case 'create-sequence':
    case 'drop-sequence':
    case 'alter-sequence':
    case 'create-extension':
    case 'alter-extension':
    case 'drop-extension':
    case 'create-view':
    case 'drop-view':
    case 'replace-view':
    case 'alter-owner':
    case 'grant':
    case 'revoke':
    case 'alter-default-privileges':
      break;
    default:
      assertNever(planStep, 'declaration-facts step');
  }
}

import { assertNever } from '@schemamill/core';
import type { Index, IndexOwner, Plan, Table, TableIdentity } from '@schemamill/core';

import {
  synthesizedCheckConstraintName,
  synthesizedExclusionConstraintName,
  synthesizedForeignKeyName,
  synthesizedIndexName,
  synthesizedPrimaryKeyName,
  synthesizedUniqueConstraintName,
  truncateIdentifier,
} from './names.ts';

/**
 * The pure claim collector behind the render guard (and, later, refusal hazards).
 *
 * PostgreSQL keeps two different namespaces. An index is a relation: its name is unique
 * **within a schema**, regardless of which table or materialized view owns it. A constraint
 * name is unique **within a table**, regardless of its kind — a check twin can collide with a
 * unique twin's name. Cross-namespace coincidences are legal, so the two scopes are never
 * merged: one plan step may claim a name in each, and the guard keys them separately.
 *
 * The collector is a pure function of the `Plan`: it neither renders SQL nor reads a catalog.
 * Every claim carries its step index, the scope, the schema, and the *stored* form of the name —
 * an explicit identifier clipped by `truncateIdentifier`, an unnamed one predicted by the
 * conventional formula in `names.ts`. Clipping the explicit form is what lets the guard see a
 * collision the server would see at apply time; rendering still emits an explicit name as
 * written (the over-63-byte divergence is a named residual).
 *
 * The full claimant inventory is:
 * - all four index step kinds, for table and materialized-view owners;
 * - every add/drop constraint step, including named `add-not-null`/`drop-not-null`;
 * - the backing index of a PK/unique/exclusion add or drop, named exactly as the drop paths
 *   in `render.ts` resolve it — the constraint's own name;
 * - create-table's inline primary key, in both namespaces, and its columns' inline
 *   `notNullName` in the constraint namespace;
 * - add-column's inline `notNullName` in the constraint namespace.
 *
 * An unnamed not-null step claims nothing here: before PostgreSQL 18 an unnamed not-null fact
 * has no `pg_constraint` row. Its version-aware occupancy belongs to a later workstream.
 * `drop-table` and `drop-column` release names from a baseline rather than adding claims.
 *
 * No object is claimed twice through separate steps: each step contributes at most one claim
 * per object per namespace. When two different objects do resolve to one key, the guard reports
 * the collision once — the first pair, in plan order — rather than one refusal per step.
 *
 * `polarity` is part of each key so a legitimate drop-and-recreate of one name still coexists.
 */

/** Which side of the migration a claim belongs to. */
export type NameClaimPolarity = 'create' | 'drop';

/** The constraint shape a claim came from, for refusal descriptions. */
export type ConstraintClaimDetail =
  | { readonly kind: 'primary-key'; readonly columns: readonly string[] }
  | { readonly kind: 'foreign-key'; readonly columns: readonly string[] }
  | { readonly kind: 'unique'; readonly columns: readonly string[] }
  | { readonly kind: 'check'; readonly expression: string }
  | { readonly kind: 'exclusion'; readonly elements: string }
  | { readonly kind: 'not-null'; readonly column: string };

interface ClaimBase {
  /** The stored/server-form name the claim occupies. */
  readonly name: string;
  readonly polarity: NameClaimPolarity;
  readonly step: number;
  /** The as-written name when the model stated one, for refusal descriptions. */
  readonly originalName?: string;
  /** True when the name was predicted by a conventional formula. */
  readonly synthesized: boolean;
}

/** A claim on the schema-wide index namespace. */
export interface IndexNameClaim extends ClaimBase {
  readonly scope: 'index';
  readonly schema: string;
  /** The table or materialized view whose schema owns the index. */
  readonly relation: TableIdentity;
  /** Present for a standalone index step; absent when this is a constraint's backing index. */
  readonly index?: Index;
  /** Present when a constraint's backing index claims the name. */
  readonly detail?: ConstraintClaimDetail;
}

/** A claim on the table-scoped constraint namespace. */
export interface ConstraintNameClaim extends ClaimBase {
  readonly scope: 'constraint';
  readonly schema: string;
  /** The table name; the guard's key also uses the schema. */
  readonly table: string;
  /** The full identity, for refusal descriptions. */
  readonly tableIdentity: TableIdentity;
  readonly detail: ConstraintClaimDetail;
}

/** One structured name claim. */
export type NameClaim = IndexNameClaim | ConstraintNameClaim;

/**
 * The guard/hazard collision key: `[schema, name, polarity]` for an index,
 * `[schema, table, name, polarity]` for a constraint. The scope is part of the key so an
 * index and a constraint of one name never report against each other.
 */
export function nameClaimKey(claim: NameClaim): string {
  return claim.scope === 'index'
    ? JSON.stringify(['index', claim.schema, claim.name, claim.polarity])
    : JSON.stringify(['constraint', claim.schema, claim.table, claim.name, claim.polarity]);
}

/** The result of resolving an explicit-or-unnamed name into its server form. */
interface ResolvedName {
  readonly name: string;
  readonly synthesized: boolean;
  readonly originalName?: string;
}

/** Explicit names are stored clipped; unnamed names are the conventional prediction. */
function resolveName(explicit: string | undefined, synthesize: () => string): ResolvedName {
  return explicit === undefined
    ? { name: synthesize(), synthesized: true }
    : { name: truncateIdentifier(explicit), synthesized: false, originalName: explicit };
}

/** The server form of a name the model stated explicitly. */
function statedName(explicit: string): ResolvedName {
  return { name: truncateIdentifier(explicit), synthesized: false, originalName: explicit };
}

/** All name claims the plan makes, in plan order, with at most one per object per namespace. */
export function collectNameClaims(plan: Plan): readonly NameClaim[] {
  const claims: NameClaim[] = [];
  for (const [index, step] of plan.steps.entries()) {
    switch (step.kind) {
      case 'create-index':
      case 'create-index-concurrently':
      case 'drop-index':
      case 'drop-index-concurrently': {
        const relation = relationOf(step.owner);
        const resolved = resolveName(step.index.name, () =>
          synthesizedIndexName(relation, step.index),
        );
        claims.push({
          scope: 'index',
          schema: relation.schema,
          relation,
          index: step.index,
          step: index,
          polarity:
            step.kind === 'create-index' || step.kind === 'create-index-concurrently'
              ? 'create'
              : 'drop',
          ...resolved,
        });
        break;
      }
      case 'add-primary-key':
      case 'drop-primary-key': {
        const polarity = step.kind === 'add-primary-key' ? 'create' : 'drop';
        const resolved = resolveName(step.primaryKey.name, () =>
          synthesizedPrimaryKeyName(step.table),
        );
        const detail: ConstraintClaimDetail = {
          kind: 'primary-key',
          columns: step.primaryKey.columns,
        };
        pushConstraint(claims, step.table, detail, index, polarity, resolved);
        // A primary key's backing index carries the constraint's name.
        pushBackingIndex(claims, step.table, detail, index, polarity, resolved);
        break;
      }
      case 'add-foreign-key':
      case 'drop-foreign-key': {
        const resolved = resolveName(step.foreignKey.name, () =>
          synthesizedForeignKeyName(step.table, step.foreignKey),
        );
        pushConstraint(
          claims,
          step.table,
          { kind: 'foreign-key', columns: step.foreignKey.columns },
          index,
          step.kind === 'add-foreign-key' ? 'create' : 'drop',
          resolved,
        );
        break;
      }
      case 'add-unique-constraint':
      case 'drop-unique-constraint': {
        const polarity = step.kind === 'add-unique-constraint' ? 'create' : 'drop';
        const resolved = resolveName(step.uniqueConstraint.name, () =>
          synthesizedUniqueConstraintName(step.table, step.uniqueConstraint),
        );
        const detail: ConstraintClaimDetail = {
          kind: 'unique',
          columns: step.uniqueConstraint.columns,
        };
        pushConstraint(claims, step.table, detail, index, polarity, resolved);
        pushBackingIndex(claims, step.table, detail, index, polarity, resolved);
        break;
      }
      case 'add-check-constraint':
      case 'drop-check-constraint': {
        const resolved = resolveName(step.checkConstraint.name, () =>
          synthesizedCheckConstraintName(step.table, step.checkConstraint),
        );
        pushConstraint(
          claims,
          step.table,
          { kind: 'check', expression: step.checkConstraint.expression },
          index,
          step.kind === 'add-check-constraint' ? 'create' : 'drop',
          resolved,
        );
        break;
      }
      case 'add-exclusion-constraint':
      case 'drop-exclusion-constraint': {
        const polarity = step.kind === 'add-exclusion-constraint' ? 'create' : 'drop';
        const resolved = resolveName(step.exclusionConstraint.name, () =>
          synthesizedExclusionConstraintName(step.table, step.exclusionConstraint),
        );
        const detail: ConstraintClaimDetail = {
          kind: 'exclusion',
          elements: step.exclusionConstraint.elements,
        };
        pushConstraint(claims, step.table, detail, index, polarity, resolved);
        pushBackingIndex(claims, step.table, detail, index, polarity, resolved);
        break;
      }
      case 'add-not-null':
      case 'drop-not-null': {
        // An unnamed not-null fact has no constraint row before PostgreSQL 18; version-aware
        // occupancy for it is a later workstream. A stated name is an explicit constraint.
        if (step.name === undefined) break;
        pushConstraint(
          claims,
          step.table,
          { kind: 'not-null', column: step.column },
          index,
          step.kind === 'add-not-null' ? 'create' : 'drop',
          statedName(step.name),
        );
        break;
      }
      case 'create-table': {
        const table: Table = step.table;
        if (table.primaryKey !== undefined) {
          const resolved = resolveName(table.primaryKey.name, () =>
            synthesizedPrimaryKeyName(table),
          );
          const detail: ConstraintClaimDetail = {
            kind: 'primary-key',
            columns: table.primaryKey.columns,
          };
          pushConstraint(claims, table, detail, index, 'create', resolved);
          pushBackingIndex(claims, table, detail, index, 'create', resolved);
        }
        for (const column of table.columns) {
          // `renderColumn` states an inline constraint only when the column is not null.
          if (column.notNull && column.notNullName !== undefined) {
            pushConstraint(
              claims,
              table,
              { kind: 'not-null', column: column.name },
              index,
              'create',
              statedName(column.notNullName),
            );
          }
        }
        break;
      }
      case 'add-column': {
        // `renderColumn` states an inline constraint only when the column is not null.
        if (step.column.notNull && step.column.notNullName !== undefined) {
          pushConstraint(
            claims,
            step.table,
            { kind: 'not-null', column: step.column.name },
            index,
            'create',
            statedName(step.column.notNullName),
          );
        }
        break;
      }
      case 'create-schema':
      case 'drop-table':
      case 'drop-column':
      case 'alter-column':
      case 'alter-persistence':
      case 'add-identity':
      case 'drop-identity':
      case 'alter-identity':
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
      case 'comment':
        break;
      default:
        assertNever(step, 'name-claims step');
    }
  }
  return claims;
}

/** The relation an index step owns: a table or a materialized view. */
function relationOf(owner: IndexOwner): TableIdentity {
  return owner.kind === 'table' ? owner.table : owner.view;
}

/** Pushes one constraint claim. */
function pushConstraint(
  claims: NameClaim[],
  table: TableIdentity,
  detail: ConstraintClaimDetail,
  step: number,
  polarity: NameClaimPolarity,
  resolved: ResolvedName,
): void {
  claims.push({
    scope: 'constraint',
    schema: table.schema,
    table: table.name,
    tableIdentity: table,
    detail,
    step,
    polarity,
    ...resolved,
  });
}

/** Pushes the backing-index claim of a PK/unique/exclusion constraint. */
function pushBackingIndex(
  claims: NameClaim[],
  table: TableIdentity,
  detail: ConstraintClaimDetail,
  step: number,
  polarity: NameClaimPolarity,
  resolved: ResolvedName,
): void {
  claims.push({
    scope: 'index',
    schema: table.schema,
    relation: table,
    detail,
    step,
    polarity,
    ...resolved,
  });
}

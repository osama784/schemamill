import { assertNever } from '@schemamill/core';
import type { Index, IndexOwner, Model, Plan, Table, TableIdentity } from '@schemamill/core';

import {
  expressionColumnIdentifiers,
  pg18NotNullName,
  synthesizedCheckConstraintName,
  synthesizedExclusionConstraintName,
  synthesizedForeignKeyName,
  synthesizedIndexName,
  synthesizedPrimaryKeyName,
  synthesizedUniqueConstraintName,
  truncateIdentifier,
} from './names.ts';

/** The first PostgreSQL major that stores an unnamed not-null fact in `pg_constraint`. */
const PG18_NOT_NULL_MIN_MAJOR = 18;

/**
 * The target context a collector reads. Absent means the oldest supported major: no version-
 * sensitive claim is made, which keeps every 3-argument caller byte-identical.
 */
export interface NameClaimOptions {
  readonly targetVersion?: number;
}

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
 * - create-table's inline primary key, in both namespaces, and its columns' inline not-null
 *   facts (a stated `notNullName`, or a PG18 synthesized name) in the constraint namespace;
 * - add-column's inline not-null fact, the same way.
 *
 * An unnamed not-null step claims nothing before PostgreSQL 18, where the fact has no
 * `pg_constraint` row. At 18 or newer it claims the table-scoped name `ChooseConstraintName`
 * materializes — `<table>_<column>_not_null` — through {@link pg18NotNullName}; a collision
 * suffix such as `not_null1` stays a named residual. `drop-table` and `drop-column` release
 * names from a baseline rather than adding claims.
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
  /** True for a claim describing an object already materialized in a baseline model. */
  readonly baseline?: true;
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

/**
 * The part of a claim's key that survives polarity: `[schema, name]` for an index and
 * `[schema, table, name]` for a constraint. A baseline object occupies this identity; a plan's
 * drop claim for the same identity releases it, and a create claim for it then collides.
 */
export function nameClaimIdentity(claim: NameClaim): string {
  return claim.scope === 'index'
    ? JSON.stringify(['index', claim.schema, claim.name])
    : JSON.stringify(['constraint', claim.schema, claim.table, claim.name]);
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

/**
 * The server form of an unnamed not-null fact, or `undefined` below PostgreSQL 18 where the
 * server stores no constraint row and no name is occupied. The relation name is unqualified:
 * the helper takes the table's name, not its identity, just as `ChooseConstraintName` takes the
 * relation name and the namespace separately.
 */
function unnamedNotNullName(
  table: string,
  column: string,
  options?: NameClaimOptions,
): ResolvedName | undefined {
  if ((options?.targetVersion ?? 0) < PG18_NOT_NULL_MIN_MAJOR) return undefined;
  return { name: pg18NotNullName(table, column), synthesized: true };
}

/** An inline not-null fact: stated when named, otherwise PG18's synthesized name when it has one. */
function notNullColumnName(
  table: string,
  column: string,
  explicit: string | undefined,
  options?: NameClaimOptions,
): ResolvedName | undefined {
  return explicit === undefined ? unnamedNotNullName(table, column, options) : statedName(explicit);
}

/** All name claims the plan makes, in plan order, with at most one per object per namespace. */
export function collectNameClaims(plan: Plan, options?: NameClaimOptions): readonly NameClaim[] {
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
        pushIndexClaim(
          claims,
          relation,
          step.index,
          index,
          step.kind === 'create-index' || step.kind === 'create-index-concurrently'
            ? 'create'
            : 'drop',
          resolved,
        );
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
        const resolved =
          step.name === undefined
            ? unnamedNotNullName(step.table.name, step.column, options)
            : statedName(step.name);
        if (resolved === undefined) break;
        pushConstraint(
          claims,
          step.table,
          { kind: 'not-null', column: step.column },
          index,
          step.kind === 'add-not-null' ? 'create' : 'drop',
          resolved,
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
          const resolved = column.notNull
            ? notNullColumnName(table.name, column.name, column.notNullName, options)
            : undefined;
          if (resolved !== undefined) {
            pushConstraint(
              claims,
              table,
              { kind: 'not-null', column: column.name },
              index,
              'create',
              resolved,
            );
          }
        }
        break;
      }
      case 'add-column': {
        // `renderColumn` states an inline constraint only when the column is not null.
        const resolved = step.column.notNull
          ? notNullColumnName(step.table.name, step.column.name, step.column.notNullName, options)
          : undefined;
        if (resolved !== undefined) {
          pushConstraint(
            claims,
            step.table,
            { kind: 'not-null', column: step.column.name },
            index,
            'create',
            resolved,
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
  baseline?: true,
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
    ...(baseline === undefined ? {} : { baseline }),
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
  baseline?: true,
): void {
  claims.push({
    scope: 'index',
    schema: table.schema,
    relation: table,
    detail,
    step,
    polarity,
    ...resolved,
    ...(baseline === undefined ? {} : { baseline }),
  });
}

/** Pushes one standalone-index claim, on a table or a materialized view. */
function pushIndexClaim(
  claims: NameClaim[],
  relation: TableIdentity,
  index: Index,
  step: number,
  polarity: NameClaimPolarity,
  resolved: ResolvedName,
  baseline?: true,
): void {
  claims.push({
    scope: 'index',
    schema: relation.schema,
    relation,
    index,
    step,
    polarity,
    ...resolved,
    ...(baseline === undefined ? {} : { baseline }),
  });
}

/**
 * The names a baseline model has already materialized, in the same two namespaces and the same
 * server form as the plan claims: an explicit name clipped to 63 bytes, an unnamed one predicted
 * by the conventional formula. A baseline object occupies its identity as if it were a create;
 * the guard checks plan creates against these claims, never baseline against baseline (the
 * baseline is an existing, valid schema). At PostgreSQL 18 or newer an unnamed not-null column
 * also occupies the name the server materialized, so a later plan cannot claim it.
 */
export function collectBaselineClaims(
  baseline: Model,
  options?: NameClaimOptions,
): readonly NameClaim[] {
  const claims: NameClaim[] = [];
  for (const table of baseline.tables) collectTableClaims(claims, table, options);
  for (const view of baseline.views) {
    if (!view.materialized || view.indexes === undefined) continue;
    for (const index of view.indexes) {
      pushIndexClaim(
        claims,
        view,
        index,
        -1,
        'create',
        resolveName(index.name, () => synthesizedIndexName(view, index)),
        true,
      );
    }
  }
  return claims;
}

/** Every named object one baseline table materializes, in both guard namespaces. */
function collectTableClaims(claims: NameClaim[], table: Table, options?: NameClaimOptions): void {
  if (table.primaryKey !== undefined) {
    const resolved = resolveName(table.primaryKey.name, () => synthesizedPrimaryKeyName(table));
    const detail: ConstraintClaimDetail = {
      kind: 'primary-key',
      columns: table.primaryKey.columns,
    };
    pushConstraint(claims, table, detail, -1, 'create', resolved, true);
    pushBackingIndex(claims, table, detail, -1, 'create', resolved, true);
  }
  for (const foreignKey of table.foreignKeys) {
    pushConstraint(
      claims,
      table,
      { kind: 'foreign-key', columns: foreignKey.columns },
      -1,
      'create',
      resolveName(foreignKey.name, () => synthesizedForeignKeyName(table, foreignKey)),
      true,
    );
  }
  for (const unique of table.uniqueConstraints) {
    const resolved = resolveName(unique.name, () => synthesizedUniqueConstraintName(table, unique));
    const detail: ConstraintClaimDetail = { kind: 'unique', columns: unique.columns };
    pushConstraint(claims, table, detail, -1, 'create', resolved, true);
    pushBackingIndex(claims, table, detail, -1, 'create', resolved, true);
  }
  for (const check of table.checkConstraints) {
    pushConstraint(
      claims,
      table,
      { kind: 'check', expression: check.expression },
      -1,
      'create',
      resolveName(check.name, () => synthesizedCheckConstraintName(table, check)),
      true,
    );
  }
  for (const exclusion of table.exclusionConstraints ?? []) {
    const resolved = resolveName(exclusion.name, () =>
      synthesizedExclusionConstraintName(table, exclusion),
    );
    const detail: ConstraintClaimDetail = {
      kind: 'exclusion',
      elements: exclusion.elements,
    };
    pushConstraint(claims, table, detail, -1, 'create', resolved, true);
    pushBackingIndex(claims, table, detail, -1, 'create', resolved, true);
  }
  for (const index of table.indexes) {
    pushIndexClaim(
      claims,
      table,
      index,
      -1,
      'create',
      resolveName(index.name, () => synthesizedIndexName(table, index)),
      true,
    );
  }
  for (const column of table.columns) {
    // The baseline's unnamed not-null has a pg_constraint row only at PostgreSQL 18 or newer.
    const resolved = column.notNull
      ? notNullColumnName(table.name, column.name, column.notNullName, options)
      : undefined;
    if (resolved !== undefined) {
      pushConstraint(
        claims,
        table,
        { kind: 'not-null', column: column.name },
        -1,
        'create',
        resolved,
        true,
      );
    }
  }
}

/**
 * The baseline identities the plan frees. A drop-polarity claim releases the same identity in
 * either namespace, so a drop-then-recreate of one name is not refused. A `drop-table` releases
 * every name its baseline table materialized; a `drop-column` releases the baseline constraints
 * and indexes that involve that column, since PostgreSQL drops them with it — including a
 * PostgreSQL 18 unnamed not-null's synthesized constraint name. A check or exclusion constraint
 * and an index expression element involve the column when the same lexical scan `names.ts` uses
 * for conventional names reads the column out of the opaque text.
 */
export function releasedBaselineKeys(
  plan: Plan,
  baseline: Model,
  options?: NameClaimOptions,
): ReadonlySet<string> {
  const released = new Set<string>();
  for (const claim of collectNameClaims(plan, options)) {
    if (claim.polarity === 'drop') released.add(nameClaimIdentity(claim));
  }
  const tables = new Map<string, Table>();
  for (const table of baseline.tables) tables.set(tableKey(table), table);
  for (const step of plan.steps) {
    if (step.kind !== 'drop-table' && step.kind !== 'drop-column') continue;
    const table = tables.get(tableKey(step.table));
    if (table === undefined) continue;
    const claims: NameClaim[] = [];
    collectTableClaims(claims, table, options);
    for (const claim of claims) {
      if (step.kind === 'drop-table' || involvesColumn(claim, step.column.name)) {
        released.add(nameClaimIdentity(claim));
      }
    }
  }
  return released;
}

/** The schema-qualified identity used to find a baseline table for a drop step. */
function tableKey(table: TableIdentity): string {
  return JSON.stringify([table.schema, table.name]);
}

/** Whether a baseline claim belongs to a column PostgreSQL drops with the table's column. */
function involvesColumn(claim: NameClaim, column: string): boolean {
  if (claim.scope === 'constraint') return detailInvolvesColumn(claim.detail, column);
  // A constraint's backing index is tied to the column through the constraint's payload.
  if (claim.detail !== undefined) return detailInvolvesColumn(claim.detail, column);
  return (
    (claim.index?.columns.some((element) => indexElementInvolvesColumn(element, column)) ??
      false) ||
    (claim.index?.include?.includes(column) ?? false)
  );
}

/** Whether an index element is the column itself or an expression that reads it. */
function indexElementInvolvesColumn(element: Index['columns'][number], column: string): boolean {
  return typeof element === 'string'
    ? element === column
    : expressionColumnIdentifiers(element.expression).has(column);
}

/** Whether a constraint's payload is structurally tied to the dropped column. */
function detailInvolvesColumn(detail: ConstraintClaimDetail, column: string): boolean {
  switch (detail.kind) {
    case 'not-null':
      return detail.column === column;
    case 'check':
      return expressionColumnIdentifiers(detail.expression).has(column);
    case 'exclusion':
      return expressionColumnIdentifiers(detail.elements).has(column);
    case 'primary-key':
    case 'foreign-key':
    case 'unique':
      return detail.columns.includes(column);
    default:
      assertNever(detail, 'name-claims column involvement');
  }
}

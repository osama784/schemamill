import { diff } from './diff.ts';
import type { ColumnFieldChange } from './diff.ts';
import type { Column, ForeignKey, Model, PrimaryKey, Table, TableIdentity } from './model.ts';

/**
 * The migration plan: what to change, in the order that works.
 *
 * `plan` runs the diff between a baseline model and a target model, expands every change into
 * executable steps, and reorders them so the dependencies the model can express are respected:
 * referencing tables before the tables they reference, and constraints before the primary keys
 * and columns they depend on. It is the change engine's ordering pass: the plan carries every
 * payload a renderer needs, and hazards and transaction grouping are later work.
 *
 * A step is one of nine kinds. A table addition becomes a create-table step carrying the
 * table's columns and primary key as they are, plus one add-foreign-key step per foreign key —
 * the create-table payload is always free of foreign keys, so constraints attach only once
 * every referenced table exists. A table removal becomes a drop-table step. A changed table is
 * mapped member by member: a removed column becomes drop-column, an added column add-column, a
 * changed column alter-column carrying only its differing fields in the fixed order `type`,
 * `notNull`, `default`; a removed, added, or changed primary key becomes a drop-primary-key
 * and/or add-primary-key step; and a removed, added, or changed foreign key becomes a
 * drop-foreign-key and/or add-foreign-key step. A changed primary key or foreign key
 * decomposes into its drop half and its add half.
 *
 * The final sequence is the concatenation of nine phases, in this exact order:
 *
 * 1. drop-foreign-key — the diff-derived drops, then the steps synthesized for primary-key
 *    changes and the cycle-breaking drops described below;
 * 2. drop-table — dependency-ordered among themselves, see below. Removed tables go before the
 *    primary-key and column drops, so a constraint a removed table still holds on a kept
 *    table's primary key or column is gone with that table before the primary key or column is
 *    dropped;
 * 3. drop-primary-key — after the tables that may reference it are gone and the foreign keys
 *    that survive it are set aside, and before the columns it covers are dropped;
 * 4. drop-column;
 * 5. create-table;
 * 6. add-column;
 * 7. alter-column;
 * 8. add-primary-key — after its columns exist;
 * 9. add-foreign-key — last, once both the table and the referenced table exist, with the
 *    synthesized primary-key dependents after the diff-derived adds.
 *
 * Within a phase, steps keep the relative order the diff produced: table changes in identity
 * order, and inside a changed table the diff's documented member order. A table addition
 * contributes its foreign-key steps to phase 9 in the added table's canonical foreign-key
 * order. The steps synthesized for primary-key changes are ordered as described below, and
 * the cycle-breaking drop-foreign-key steps close phase 1.
 *
 * A surviving foreign key can depend on a primary key that changes. Dropping a key while a
 * live foreign key still references it fails, whatever engine runs the plan, so the ordering
 * pass synthesizes the missing halves. For every primary-key drop on a kept table T, each
 * baseline foreign key on a table that survives whose resolved referenced columns are exactly
 * T's dropped primary-key columns — an empty `referencedColumns` resolves to T's baseline
 * primary key — and whose payload the target still carries unchanged (same owning table, same
 * identity, equal fields) gets a drop-foreign-key step with the baseline payload in phase 1
 * and an add-foreign-key step with the target payload in phase 9. The diff's own drops and
 * adds are never duplicated: only the occurrences the diff's identical-pair cancellation
 * leaves in place are synthesized, so a foreign key the diff removes or replaces needs nothing
 * here, and a removed table's constraints are already gone when phase 2 finishes. The
 * synthesized drops follow the diff-derived drops and precede the cycle-breaking drops; the
 * synthesized adds follow the diff-derived adds. Primary-key drops are walked in diff order,
 * and for each drop its dependents come in owning-table identity order, then in canonical
 * foreign-key order.
 *
 * Phase 2 is dependency-ordered. When a removed table references another removed table, the
 * referencing table must be dropped first, or the referenced table's constraint would still
 * be in the way. The order is a deterministic Kahn's algorithm:
 *
 * - A remaining removed table is ready when no other remaining removed table references it.
 *   Among ready tables, the one with the smallest identity wins: schema, then name, plain
 *   JavaScript string comparison, which is the order the diff reports identities in. A
 *   foreign key a table holds to itself never blocks it; dropping the table drops the key too.
 * - When no table is ready and tables remain, the remainder holds at least one reference
 *   cycle. The smallest-identity remaining table T is scheduled next, but first one
 *   drop-foreign-key step is emitted for every foreign key on another remaining removed table
 *   that references T. Those steps are ordered by the referencing table's identity, and within
 *   one table by its canonical foreign-key order. A self-reference never needs one: it goes
 *   away with the table. After them T has no incoming reference left from a remaining table,
 *   so its drop is legal, and the algorithm continues with the tables that remain.
 *
 * The algorithm never depends on the order either model's table or foreign-key arrays arrive
 * in: the diff is order-insensitive, and the ordering rules above are total. Structurally
 * equal models in any insertion order therefore produce deep-equal plans.
 *
 * The plan assumes well-formed models: foreign keys point at tables the model contains, key
 * columns exist, and a table's columns are unique by name. It validates nothing; import and
 * introspection are where well-formedness comes from. Every step carries an independent copy
 * of the payloads it embeds, so mutating a plan never affects the caller's models, and `plan`
 * never mutates its inputs.
 */

/** A migration plan: the ordered steps that move a baseline model to its target. */
export interface Plan {
  /** Every step, in execution order. */
  readonly steps: readonly Step[];
}

/** One planned action. */
export type Step =
  /** The target has a table the baseline does not; a copy without its foreign keys. */
  | { kind: 'create-table'; table: Table }
  /** The baseline has a table the target does not. */
  | { kind: 'drop-table'; table: TableIdentity }
  /** The target has a column the baseline does not. */
  | { kind: 'add-column'; table: TableIdentity; column: Column }
  /** The baseline has a column the target does not. */
  | { kind: 'drop-column'; table: TableIdentity; column: Column }
  /** A column both sides have with differing fields, in the fixed order `type`, `notNull`, `default`. */
  | {
      kind: 'alter-column';
      table: TableIdentity;
      name: string;
      fields: readonly ColumnFieldChange[];
    }
  /** The target has a primary key the baseline does not. */
  | { kind: 'add-primary-key'; table: TableIdentity; primaryKey: PrimaryKey }
  /** The baseline has a primary key the target does not. */
  | { kind: 'drop-primary-key'; table: TableIdentity; primaryKey: PrimaryKey }
  /** The target has a foreign key the baseline does not. */
  | { kind: 'add-foreign-key'; table: TableIdentity; foreignKey: ForeignKey }
  /** The baseline has a foreign key the target does not. */
  | { kind: 'drop-foreign-key'; table: TableIdentity; foreignKey: ForeignKey };

/**
 * The steps from `baseline` to `target`, in dependency-correct order. Returned payloads are
 * independent copies: mutating them never affects the caller's models, and neither input is
 * mutated.
 */
export function plan(baseline: Model, target: Model): Plan {
  const changes = diff(baseline, target);

  const foreignKeyDrops: Step[] = [];
  const primaryKeyDrops: Step[] = [];
  const columnDrops: Step[] = [];
  const removedTables: RemovedTable[] = [];
  const tableCreates: Step[] = [];
  const columnAdds: Step[] = [];
  const columnAlters: Step[] = [];
  const primaryKeyAdds: Step[] = [];
  const foreignKeyAdds: Step[] = [];

  for (const change of changes) {
    switch (change.kind) {
      case 'table-removed': {
        removedTables.push({
          identity: copyIdentity(change.table),
          table: copyTable(change.table),
        });
        break;
      }
      case 'table-added': {
        tableCreates.push({
          kind: 'create-table',
          table: copyTableWithoutForeignKeys(change.table),
        });
        for (const foreignKey of change.table.foreignKeys) {
          foreignKeyAdds.push({
            kind: 'add-foreign-key',
            table: copyIdentity(change.table),
            foreignKey: copyForeignKey(foreignKey),
          });
        }
        break;
      }
      case 'table-changed': {
        for (const tableChange of change.changes) {
          switch (tableChange.kind) {
            case 'column-removed': {
              columnDrops.push({
                kind: 'drop-column',
                table: copyIdentity(change.table),
                column: copyColumn(tableChange.column),
              });
              break;
            }
            case 'column-added': {
              columnAdds.push({
                kind: 'add-column',
                table: copyIdentity(change.table),
                column: copyColumn(tableChange.column),
              });
              break;
            }
            case 'column-changed': {
              columnAlters.push({
                kind: 'alter-column',
                table: copyIdentity(change.table),
                name: tableChange.name,
                fields: tableChange.fields.map(copyFieldChange),
              });
              break;
            }
            case 'primary-key-removed': {
              primaryKeyDrops.push({
                kind: 'drop-primary-key',
                table: copyIdentity(change.table),
                primaryKey: copyPrimaryKey(tableChange.primaryKey),
              });
              break;
            }
            case 'primary-key-added': {
              primaryKeyAdds.push({
                kind: 'add-primary-key',
                table: copyIdentity(change.table),
                primaryKey: copyPrimaryKey(tableChange.primaryKey),
              });
              break;
            }
            case 'primary-key-changed': {
              primaryKeyDrops.push({
                kind: 'drop-primary-key',
                table: copyIdentity(change.table),
                primaryKey: copyPrimaryKey(tableChange.before),
              });
              primaryKeyAdds.push({
                kind: 'add-primary-key',
                table: copyIdentity(change.table),
                primaryKey: copyPrimaryKey(tableChange.after),
              });
              break;
            }
            case 'foreign-key-removed': {
              foreignKeyDrops.push({
                kind: 'drop-foreign-key',
                table: copyIdentity(change.table),
                foreignKey: copyForeignKey(tableChange.foreignKey),
              });
              break;
            }
            case 'foreign-key-added': {
              foreignKeyAdds.push({
                kind: 'add-foreign-key',
                table: copyIdentity(change.table),
                foreignKey: copyForeignKey(tableChange.foreignKey),
              });
              break;
            }
            case 'foreign-key-changed': {
              foreignKeyDrops.push({
                kind: 'drop-foreign-key',
                table: copyIdentity(change.table),
                foreignKey: copyForeignKey(tableChange.before),
              });
              foreignKeyAdds.push({
                kind: 'add-foreign-key',
                table: copyIdentity(change.table),
                foreignKey: copyForeignKey(tableChange.after),
              });
              break;
            }
          }
        }
        break;
      }
    }
  }

  const { drops: tableDrops, breaks } = orderTableDrops(removedTables);
  const { drops: dependentKeyDrops, adds: dependentKeyAdds } = dependentForeignKeySteps(
    baseline,
    target,
    primaryKeyDrops,
  );

  return {
    steps: [
      ...foreignKeyDrops,
      ...dependentKeyDrops,
      ...breaks,
      ...tableDrops,
      ...primaryKeyDrops,
      ...columnDrops,
      ...tableCreates,
      ...columnAdds,
      ...columnAlters,
      ...primaryKeyAdds,
      ...foreignKeyAdds,
      ...dependentKeyAdds,
    ],
  };
}

/** A removed table, held with its canonical payload while phase 2 orders the drops. */
interface RemovedTable {
  readonly identity: TableIdentity;
  readonly table: Table;
}

/**
 * Phase 2: orders the removed tables' drops so a table is dropped only once no remaining
 * removed table references it, breaking reference cycles with explicit drop-foreign-key
 * steps aimed at the table about to be dropped. Returns the drops in execution order and the
 * cycle-breaking steps in discovery order.
 */
function orderTableDrops(removed: readonly RemovedTable[]): { drops: Step[]; breaks: Step[] } {
  const drops: Step[] = [];
  const breaks: Step[] = [];
  const remaining = [...removed];

  while (remaining.length > 0) {
    let next = smallestReady(remaining);
    if (next === undefined) {
      next = smallestIdentity(remaining);
      for (const other of byIdentity(remaining)) {
        if (other === next) continue;
        for (const foreignKey of other.table.foreignKeys) {
          if (!sameIdentity(foreignKey.referencedTable, next.identity)) continue;
          breaks.push({
            kind: 'drop-foreign-key',
            table: copyIdentity(other.identity),
            foreignKey: copyForeignKey(foreignKey),
          });
        }
      }
    }
    remaining.splice(remaining.indexOf(next), 1);
    drops.push({ kind: 'drop-table', table: copyIdentity(next.identity) });
  }

  return { drops, breaks };
}

/** A copy of `remaining` sorted by identity, leaving the caller's array untouched. */
function byIdentity(remaining: readonly RemovedTable[]): RemovedTable[] {
  return [...remaining].sort((left, right) => compareIdentities(left.identity, right.identity));
}

/** The ready remaining table with the smallest identity, or `undefined` when none is ready. */
function smallestReady(remaining: readonly RemovedTable[]): RemovedTable | undefined {
  let ready: RemovedTable | undefined;
  for (const candidate of remaining) {
    if (isReferenced(candidate, remaining)) continue;
    if (ready === undefined || compareIdentities(candidate.identity, ready.identity) < 0) {
      ready = candidate;
    }
  }
  return ready;
}

/** The remaining table with the smallest identity; the caller guarantees a non-empty list. */
function smallestIdentity(remaining: readonly RemovedTable[]): RemovedTable {
  let smallest = remaining[0]!;
  for (const candidate of remaining) {
    if (compareIdentities(candidate.identity, smallest.identity) < 0) smallest = candidate;
  }
  return smallest;
}

/** Whether any other remaining table holds a foreign key referencing `candidate`. */
function isReferenced(candidate: RemovedTable, remaining: readonly RemovedTable[]): boolean {
  return remaining.some(
    (table) => table !== candidate && referencesIdentity(table.table, candidate.identity),
  );
}

/** Whether `table` holds a foreign key referencing `identity`. */
function referencesIdentity(table: Table, identity: TableIdentity): boolean {
  return table.foreignKeys.some((foreignKey) => sameIdentity(foreignKey.referencedTable, identity));
}

/** Whether both identities name the same table. */
function sameIdentity(left: TableIdentity, right: TableIdentity): boolean {
  return left.schema === right.schema && left.name === right.name;
}

function compareIdentities(left: TableIdentity, right: TableIdentity): number {
  return compareStrings(left.schema, right.schema) || compareStrings(left.name, right.name);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** A copy of `identity`, independent of the caller's model. */
function copyIdentity(identity: TableIdentity): TableIdentity {
  return { schema: identity.schema, name: identity.name };
}

/** A copy of `column`, independent of the caller's model. */
function copyColumn(column: Column): Column {
  return { ...column };
}

/** A copy of `primaryKey`, independent of the caller's model. */
function copyPrimaryKey(primaryKey: PrimaryKey): PrimaryKey {
  return { ...primaryKey, columns: [...primaryKey.columns] };
}

/** A copy of `foreignKey`, independent of the caller's model. */
function copyForeignKey(foreignKey: ForeignKey): ForeignKey {
  return {
    ...foreignKey,
    columns: [...foreignKey.columns],
    referencedTable: copyIdentity(foreignKey.referencedTable),
    referencedColumns: [...foreignKey.referencedColumns],
  };
}

/** A copy of one column field change, independent of the diff's payload. */
function copyFieldChange(field: ColumnFieldChange): ColumnFieldChange {
  return { ...field };
}

/** A copy of `table`, independent of the caller's model. */
function copyTable(table: Table): Table {
  return {
    ...copyTableWithoutForeignKeys(table),
    foreignKeys: table.foreignKeys.map(copyForeignKey),
  };
}

/** A copy of `table`, independent of the caller's model, without its foreign keys. */
function copyTableWithoutForeignKeys(table: Table): Table {
  return {
    schema: table.schema,
    name: table.name,
    columns: table.columns.map(copyColumn),
    ...(table.primaryKey === undefined ? {} : { primaryKey: copyPrimaryKey(table.primaryKey) }),
    foreignKeys: [],
  };
}

/**
 * The foreign-key steps synthesized for the primary-key drops: for every drop, the baseline
 * foreign keys on surviving tables that resolve to the dropped key's columns and that the
 * target still carries unchanged are set aside with a phase-1 drop and restored with a
 * phase-9 add. Returns the drops and adds in matching discovery order: primary-key drops in
 * diff order, dependents per drop in owning-table identity order and canonical foreign-key
 * order.
 */
function dependentForeignKeySteps(
  baseline: Model,
  target: Model,
  primaryKeyDrops: readonly Step[],
): { drops: Step[]; adds: Step[] } {
  const drops: Step[] = [];
  const adds: Step[] = [];
  const targetTables = new Map(target.tables.map((table) => [keyOf(table), table]));
  const owners = [...baseline.tables].sort(compareIdentities);

  for (const step of primaryKeyDrops) {
    if (step.kind !== 'drop-primary-key') continue;
    const dropped = new Set(step.primaryKey.columns);

    for (const owner of owners) {
      const targetOwner = targetTables.get(keyOf(owner));
      if (targetOwner === undefined) continue; // Removed tables are gone before phase 3.

      const baselineCounts = countForeignKeys(owner.foreignKeys);
      const targetCounts = countForeignKeys(targetOwner.foreignKeys);
      const handled = new Set<string>();

      for (const foreignKey of sortForeignKeys(owner.foreignKeys)) {
        if (!sameIdentity(foreignKey.referencedTable, step.table)) continue;
        const resolved =
          foreignKey.referencedColumns.length > 0
            ? foreignKey.referencedColumns
            : step.primaryKey.columns;
        if (!sameColumnSet(resolved, dropped)) continue;

        const key = foreignKeyKey(foreignKey);
        if (handled.has(key)) continue;
        handled.add(key);

        // The diff cancels structurally identical pairs first: what both sides still hold is
        // exactly what survives unchanged, and what only the baseline holds is the diff's.
        const count = Math.min(baselineCounts.get(key) ?? 0, targetCounts.get(key) ?? 0);
        if (count === 0) continue;
        const restored = targetOwner.foreignKeys.find(
          (candidate) => foreignKeyKey(candidate) === key,
        );
        if (restored === undefined) continue;
        for (let occurrence = 0; occurrence < count; occurrence += 1) {
          drops.push({
            kind: 'drop-foreign-key',
            table: copyIdentity(owner),
            foreignKey: copyForeignKey(foreignKey),
          });
          adds.push({
            kind: 'add-foreign-key',
            table: copyIdentity(owner),
            foreignKey: copyForeignKey(restored),
          });
        }
      }
    }
  }

  return { drops, adds };
}

/** The map key of a table identity; JSON keeps any characters unambiguous. */
function keyOf(identity: TableIdentity): string {
  return JSON.stringify([identity.schema, identity.name]);
}

/** A structural key for a foreign key, comparing every field including absent ones. */
function foreignKeyKey(foreignKey: ForeignKey): string {
  return JSON.stringify([
    foreignKey.name ?? null,
    foreignKey.columns,
    foreignKey.referencedTable.schema,
    foreignKey.referencedTable.name,
    foreignKey.referencedColumns,
    foreignKey.onUpdate ?? null,
    foreignKey.onDelete ?? null,
  ]);
}

/** How many times each structural foreign-key key occurs in `foreignKeys`. */
function countForeignKeys(foreignKeys: readonly ForeignKey[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const foreignKey of foreignKeys) {
    const key = foreignKeyKey(foreignKey);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** A copy of `foreignKeys` in the model's canonical order, leaving the caller's array alone. */
function sortForeignKeys(foreignKeys: readonly ForeignKey[]): ForeignKey[] {
  return [...foreignKeys].sort(compareForeignKeys);
}

/** The model's documented foreign-key order, extended to break remaining ties totally. */
function compareForeignKeys(left: ForeignKey, right: ForeignKey): number {
  return (
    compareStringArrays(left.columns, right.columns) ||
    compareStrings(left.referencedTable.schema, right.referencedTable.schema) ||
    compareStrings(left.referencedTable.name, right.referencedTable.name) ||
    compareOptionalStrings(left.name, right.name) ||
    compareStringArrays(left.referencedColumns, right.referencedColumns) ||
    compareOptionalStrings(left.onUpdate, right.onUpdate) ||
    compareOptionalStrings(left.onDelete, right.onDelete)
  );
}

/** Whether `values` and `expected` hold exactly the same strings. */
function sameColumnSet(values: readonly string[], expected: ReadonlySet<string>): boolean {
  return values.length === expected.size && values.every((value) => expected.has(value));
}

function compareStringArrays(left: readonly string[], right: readonly string[]): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const comparison = compareStrings(left[index]!, right[index]!);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

/** Orders optional strings by presence first — absent before present — then by value. */
function compareOptionalStrings(left: string | undefined, right: string | undefined): number {
  if (left === undefined) return right === undefined ? 0 : -1;
  if (right === undefined) return 1;
  return compareStrings(left, right);
}

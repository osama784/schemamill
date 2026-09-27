import { diff } from './diff.ts';
import type { ColumnFieldChange } from './diff.ts';
import type { Column, ForeignKey, Model, PrimaryKey, Table, TableIdentity } from './model.ts';

/**
 * The migration plan: what to change, in the order that works.
 *
 * `plan` runs the diff between a baseline model and a target model, expands every change into
 * executable steps, and reorders them so no step depends on one that comes later. It is the
 * change engine's ordering pass: the plan carries every payload a renderer needs, and hazards
 * and transaction grouping are later work.
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
 * 1. drop-foreign-key — a constraint never outlives the table or column it relies on;
 * 2. drop-primary-key — before the columns it covers are dropped;
 * 3. drop-column;
 * 4. drop-table — dependency-ordered among themselves, see below;
 * 5. create-table;
 * 6. add-column;
 * 7. alter-column;
 * 8. add-primary-key — after its columns exist;
 * 9. add-foreign-key — last, once both the table and the referenced table exist.
 *
 * Within a phase, steps keep the relative order the diff produced: table changes in identity
 * order, and inside a changed table the diff's documented member order. A table addition
 * contributes its foreign-key steps to phase 9 in the added table's canonical foreign-key
 * order.
 *
 * Phase 4 is dependency-ordered. When a removed table references another removed table, the
 * referencing table must be dropped first, or the referenced table's constraint would still be
 * in the way. The order is a deterministic Kahn's algorithm:
 *
 * - A remaining removed table is ready when no other remaining removed table references it.
 *   Among ready tables, the one with the smallest identity wins: schema, then name, plain
 *   JavaScript string comparison, which is the order the diff reports identities in. A foreign
 *   key a table holds to itself never blocks it; dropping the table drops the key too.
 * - When no table is ready and tables remain, the remainder holds at least one reference
 *   cycle. The smallest-identity remaining table is scheduled next, but first one
 *   drop-foreign-key step is emitted for each of its foreign keys that still points at a
 *   remaining removed table, in the table's canonical foreign-key order. Those steps are
 *   appended to phase 1 after its diff-derived drops, in discovery order.
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

  return {
    steps: [
      ...foreignKeyDrops,
      ...breaks,
      ...primaryKeyDrops,
      ...columnDrops,
      ...tableDrops,
      ...tableCreates,
      ...columnAdds,
      ...columnAlters,
      ...primaryKeyAdds,
      ...foreignKeyAdds,
    ],
  };
}

/** A removed table, held with its canonical payload while phase 4 orders the drops. */
interface RemovedTable {
  readonly identity: TableIdentity;
  readonly table: Table;
}

/**
 * Phase 4: orders the removed tables' drops so a table is dropped only once no remaining
 * removed table references it, breaking reference cycles with explicit drop-foreign-key
 * steps. Returns the drops in execution order and the cycle-breaking steps in discovery
 * order.
 */
function orderTableDrops(removed: readonly RemovedTable[]): { drops: Step[]; breaks: Step[] } {
  const drops: Step[] = [];
  const breaks: Step[] = [];
  const remaining = [...removed];

  while (remaining.length > 0) {
    let next = smallestReady(remaining);
    if (next === undefined) {
      next = smallestIdentity(remaining);
      for (const foreignKey of next.table.foreignKeys) {
        if (sameIdentity(foreignKey.referencedTable, next.identity)) continue;
        if (remaining.some((table) => sameIdentity(table.identity, foreignKey.referencedTable))) {
          breaks.push({
            kind: 'drop-foreign-key',
            table: copyIdentity(next.table),
            foreignKey: copyForeignKey(foreignKey),
          });
        }
      }
    }
    remaining.splice(remaining.indexOf(next), 1);
    drops.push({ kind: 'drop-table', table: copyIdentity(next.table) });
  }

  return { drops, breaks };
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

import { diff } from './diff.ts';
import type { ColumnFieldChange, IdentityFieldChange, SequenceFieldChange } from './diff.ts';
import type { Identity } from './identity.ts';
import type {
  CheckConstraint,
  Column,
  ForeignKey,
  Index,
  Model,
  PrimaryKey,
  Sequence,
  SequenceIdentity,
  SequenceOwner,
  Table,
  TableIdentity,
  UniqueConstraint,
} from './model.ts';

/**
 * The migration plan: what to change, in the order that works.
 *
 * `plan` runs the diff between a baseline model and a target model, expands every change into
 * executable steps, and reorders them so the dependencies the model can express are respected:
 * sequences before the tables that own them, referencing tables before the tables they
 * reference, and constraints before the primary keys and columns they depend on. It is the
 * change engine's ordering pass: the plan carries every payload a renderer needs and partitions
 * its steps into transaction groups, telling a renderer what applies as one unit; hazards are a
 * separate analysis.
 *
 * A step is one of twenty-three kinds. A table addition becomes a create-table step carrying
 * the table's columns and primary key as they are, plus one add-foreign-key step per foreign
 * key, one add-unique-constraint step per unique constraint, one add-check-constraint step per
 * check constraint, and one create-index step per index — the create-table payload is always
 * free of foreign keys, unique constraints, check constraints, and indexes, so each attaches
 * with its own step and constraints attach only once every referenced table exists. A table
 * removal becomes a drop-table step. A changed table is mapped member by member: a removed
 * column becomes drop-column, an added column add-column, a changed column alter-column
 * carrying only its differing fields in the fixed order `type`, `notNull`, `default`, plus,
 * when the column's identity differs, identity steps — an identity addition becomes an
 * add-identity step carrying the target descriptor, a removal a drop-identity, a change an
 * alter-identity carrying only its differing fields, and a stated sequence-name mismatch a
 * drop-identity and an add-identity (a recreation); a removed, added, or changed primary key
 * becomes a drop-primary-key and/or add-primary-key step; a removed, added, or changed foreign
 * key becomes a drop-foreign-key and/or add-foreign-key step; a removed, added, or changed
 * unique constraint becomes a drop-unique-constraint and/or add-unique-constraint step; a
 * removed, added, or changed check constraint becomes a drop-check-constraint and/or
 * add-check-constraint step; and a removed, added, or changed index becomes a drop-index and/or
 * create-index step. A changed primary key, foreign key, unique constraint, check constraint,
 * or index decomposes into its drop half and its add half.
 *
 * The concurrent index kinds are the plan's only non-transactional steps. A create step is
 * `create-index-concurrently` exactly when the target index states `concurrently: true`; a
 * drop step is `drop-index-concurrently` exactly when the baseline index does. The flag never
 * reaches the diff's equality, so a flag-only difference produces no step at all.
 *
 * Identity is never inlined into create-table or add-column: an added table or column whose
 * column carries an identity contributes its own add-identity step, and a column-changed entry
 * with an empty `fields` list (an identity-only change) contributes no alter-column step. No
 * step carries an empty change list.
 *
 * A sequence addition becomes a create-sequence step carrying the sequence's effective options
 * but never its ownership, plus, when the target owns the sequence, an attach step in the
 * ownership phase. A removed sequence becomes a drop-sequence step unless the plan also
 * removes the table or column that owned it: PostgreSQL drops an owned sequence together with
 * its owner, so an explicit drop is suppressed — but only then. A changed sequence maps field
 * by field: an ownership change becomes an ownership alter-sequence step in one of the two
 * ownership phases, and every other changed field becomes an option alter-sequence step,
 * carrying only the fields that differ.
 *
 * The final sequence is the concatenation of eight global phases, in this exact order:
 *
 * 1. drop-identity — every removed identity whose column survives, in the diff's column and
 *    table order. It runs before everything else: it must precede the `DROP NOT NULL` /
 *    `SET DEFAULT` the table phases put on the same column, and it frees the default sequence
 *    name for the replacement sequence the identity→serial conversion creates in phase 2 (or
 *    for the replacement identity's sequence added in phase 8);
 * 2. create-sequence — one per added sequence, in sequence identity order;
 * 3. ownership detaches — an ownership alter-sequence step for every kept sequence whose
 *    baseline owner table or column the plan removes and whose ownership the target changes.
 *    The detach (`OWNED BY NONE`) must run before the owner's drop, or the drop would cascade
 *    the sequence away;
 * 4. table operations — the fifteen table phases listed below, in their exact order;
 * 5. ownership attaches/re-owns — an ownership alter-sequence step for every kept sequence
 *    whose target ownership differs from its baseline one and whose baseline owner is not
 *    removed in phase 3: a new owner after a phase-3 detach, a new owner over a surviving
 *    baseline one, or a detach when the target drops ownership but keeps the owner;
 * 6. sequence option alters — one alter-sequence step per changed sequence, carrying its
 *    non-ownership field changes in the diff's fixed order, so each step can be applied in one
 *    statement without passing through an invalid intermediate state;
 * 7. drop-sequence — every removed sequence whose owner the plan does not remove, in sequence
 *    identity order. Drops come after the table phases, so a column `DROP DEFAULT` has already
 *    released the sequence by the time its drop runs; a surviving default that still
 *    references a dropped sequence is a broken target and fails at apply;
 * 8. add-identity, then alter-identity — the identity additions and option alters, in the
 *    diff's column and table order, adds before alters. They run last because `ADD GENERATED`
 *    manufactures a fresh sequence: by then the table phases have produced the column, its
 *    `SET NOT NULL`, and its `DROP DEFAULT`, and phases 1 and 7 have freed the sequence names
 *    the added identities replace. This placement alone makes both conversions compositions of
 *    ordinary steps: serial→identity is a phase-4 `DROP DEFAULT`, a phase-7 sequence drop, and
 *    a phase-8 add-identity; identity→serial is a phase-1 drop-identity, a phase-2
 *    create-sequence, and a phase-4 `SET DEFAULT`.
 *
 * A `drop-identity` needs no drop-suppression: an identity reaches the plan as its own removal
 * only when its column survives — a removed column or table carries its identity away in that
 * drop — so every collected drop-identity names an owner that still exists.
 *
 * The table phases inside phase 4 are numbered as before (and keep their documented semantics):
 *
 * 1. drop-foreign-key — the diff-derived drops, then the steps synthesized for primary-key
 *    changes and the cycle-breaking drops described below;
 * 2. drop-index — the diff-derived drops, before the table and column drops that would take
 *    their columns away;
 * 3. drop-check-constraint — likewise, before the table and column drops;
 * 4. drop-unique-constraint — likewise, before the table and column drops;
 * 5. drop-table — dependency-ordered among themselves, see below. Removed tables go before the
 *    primary-key and column drops, so a constraint a removed table still holds on a kept
 *    table's primary key or column is gone with that table before the primary key or column is
 *    dropped;
 * 6. drop-primary-key — after the tables that may reference it are gone and the foreign keys
 *    that survive it are set aside, and before the columns it covers are dropped;
 * 7. drop-column;
 * 8. create-table;
 * 9. add-column;
 * 10. alter-column;
 * 11. add-primary-key — after its columns exist;
 * 12. add-unique-constraint — after its columns exist;
 * 13. add-check-constraint — after its columns exist;
 * 14. create-index — after its columns exist; the concurrent variant stands alone;
 * 15. add-foreign-key — last, once both the table and the referenced table exist, with the
 *     synthesized primary-key dependents after the diff-derived adds.
 *
 * Within a phase, steps keep the relative order the diff produced: table and sequence changes
 * in identity order, and inside a changed table the diff's documented member order. A table
 * addition contributes its unique-constraint, check-constraint, and index steps to table phases
 * 12–14 and its foreign-key steps to table phase 15, each in the added table's canonical order.
 * The steps synthesized for primary-key changes are ordered as described below, and the
 * cycle-breaking drop-foreign-key steps close table phase 1.
 *
 * A surviving foreign key can depend on a primary key that changes. Dropping a key while a
 * live foreign key still references it fails, whatever engine runs the plan, so the ordering
 * pass synthesizes the missing halves. For every primary-key drop on a kept table T, each
 * baseline foreign key on a table that survives whose resolved referenced columns are exactly
 * T's dropped primary-key columns — an empty `referencedColumns` resolves to T's baseline
 * primary key — and whose payload the target still carries unchanged (same owning table, same
 * identity, equal fields) gets a drop-foreign-key step with the baseline payload in table
 * phase 1 and an add-foreign-key step with the target payload in table phase 15. The diff's own
 * drops and adds are never duplicated: only the occurrences the diff's identical-pair
 * cancellation leaves in place are synthesized, so a foreign key the diff removes or replaces
 * needs nothing here, and a removed table's constraints are already gone when table phase 5
 * finishes. The synthesized drops follow the diff-derived drops and precede the cycle-breaking
 * drops; the synthesized adds follow the diff-derived adds. Primary-key drops are walked in
 * diff order, and for each drop its dependents come in owning-table identity order, then in
 * canonical foreign-key order.
 *
 * Table phase 5 is dependency-ordered. When a removed table references another removed table, the
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
 * columns exist, a table's columns are unique by name, and a sequence's `ownedBy` names a
 * table and column the model contains. It validates nothing; import and introspection are
 * where well-formedness comes from. Every step carries an independent copy of the payloads it
 * embeds, so mutating a plan never affects the caller's models, and `plan` never mutates its
 * inputs.
 */

/**
 * A migration plan: the ordered steps that move a baseline model to its target, partitioned
 * into transaction groups.
 */
export interface Plan {
  /** Every step, in execution order. */
  readonly steps: readonly Step[];

  /**
   * The transaction partition of `steps`: non-empty half-open ranges that tile
   * `[0, steps.length)` in order, with `transactional: false` marking a standalone group that
   * applies outside a transaction. Empty when the plan has no steps.
   */
  readonly groups: readonly TransactionGroup[];
}

/** A run of consecutive plan steps that applies as one unit: `[start, end)` indices into `Plan.steps`. */
export interface TransactionGroup {
  readonly start: number;
  readonly end: number;
  /** `false` means the group applies outside a transaction (no wrapper). */
  readonly transactional: boolean;
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
  /** The target has an identity on a column the baseline does not; the full effective descriptor. */
  | { kind: 'add-identity'; table: TableIdentity; name: string; identity: Identity }
  /** The baseline has an identity on a column the target does not. */
  | { kind: 'drop-identity'; table: TableIdentity; name: string }
  /** An identity both sides have with differing options, in the diff's fixed field order. */
  | {
      kind: 'alter-identity';
      table: TableIdentity;
      name: string;
      fields: readonly IdentityFieldChange[];
    }
  /** The target has a primary key the baseline does not. */
  | { kind: 'add-primary-key'; table: TableIdentity; primaryKey: PrimaryKey }
  /** The baseline has a primary key the target does not. */
  | { kind: 'drop-primary-key'; table: TableIdentity; primaryKey: PrimaryKey }
  /** The target has a foreign key the baseline does not. */
  | { kind: 'add-foreign-key'; table: TableIdentity; foreignKey: ForeignKey }
  /** The baseline has a foreign key the target does not. */
  | { kind: 'drop-foreign-key'; table: TableIdentity; foreignKey: ForeignKey }
  /** The target has a unique constraint the baseline does not. */
  | { kind: 'add-unique-constraint'; table: TableIdentity; uniqueConstraint: UniqueConstraint }
  /** The baseline has a unique constraint the target does not. */
  | { kind: 'drop-unique-constraint'; table: TableIdentity; uniqueConstraint: UniqueConstraint }
  /** The target has a check constraint the baseline does not. */
  | { kind: 'add-check-constraint'; table: TableIdentity; checkConstraint: CheckConstraint }
  /** The baseline has a check constraint the target does not. */
  | { kind: 'drop-check-constraint'; table: TableIdentity; checkConstraint: CheckConstraint }
  /** The target has a standalone index the baseline does not. */
  | { kind: 'create-index'; table: TableIdentity; index: Index }
  /** The baseline has a standalone index the target does not. */
  | { kind: 'drop-index'; table: TableIdentity; index: Index }
  /** Like `create-index`, applied `CONCURRENTLY`, outside a transaction. */
  | { kind: 'create-index-concurrently'; table: TableIdentity; index: Index }
  /** Like `drop-index`, applied `CONCURRENTLY`, outside a transaction. */
  | { kind: 'drop-index-concurrently'; table: TableIdentity; index: Index }
  /** The target has a sequence the baseline does not; a copy without its ownership. */
  | { kind: 'create-sequence'; sequence: Sequence }
  /** The baseline has a sequence the target does not. */
  | { kind: 'drop-sequence'; sequence: SequenceIdentity }
  /** A sequence both sides have with differing fields, in the diff's fixed field order. */
  | {
      kind: 'alter-sequence';
      sequence: SequenceIdentity;
      fields: readonly SequenceFieldChange[];
    };

/**
 * Whether each step kind may run inside a transaction. Every kind but the two concurrent index
 * kinds is transactional; the `Record` is compile-time exhaustive over `Step['kind']`, so a
 * future kind must be classified before the package compiles. A `false` kind makes `groupSteps`
 * stand its step alone, outside any wrapper.
 */
export const TRANSACTIONAL: Record<Step['kind'], boolean> = {
  'create-table': true,
  'drop-table': true,
  'add-column': true,
  'drop-column': true,
  'alter-column': true,
  'add-identity': true,
  'drop-identity': true,
  'alter-identity': true,
  'add-primary-key': true,
  'drop-primary-key': true,
  'add-foreign-key': true,
  'drop-foreign-key': true,
  'add-unique-constraint': true,
  'drop-unique-constraint': true,
  'add-check-constraint': true,
  'drop-check-constraint': true,
  'create-index': true,
  'drop-index': true,
  'create-index-concurrently': false,
  'drop-index-concurrently': false,
  'create-sequence': true,
  'drop-sequence': true,
  'alter-sequence': true,
};

/**
 * Partitions `steps` into transaction groups: consecutive steps `isTransactional` classifies as
 * transactional coalesce into one group; a step it classifies as non-transactional becomes a
 * group of its own, even beside another non-transactional step. Groups are non-empty and tile
 * `[0, steps.length)` in order; an empty step list yields no groups. `plan` uses the step-kind
 * classification above; the predicate parameter is a seam that lets tests exercise the
 * standalone path.
 */
export function groupSteps(
  steps: readonly Step[],
  isTransactional: (step: Step) => boolean = (step) => TRANSACTIONAL[step.kind],
): readonly TransactionGroup[] {
  const groups: TransactionGroup[] = [];
  let open: { start: number; transactional: boolean } | undefined;
  for (let index = 0; index < steps.length; index += 1) {
    const transactional = isTransactional(steps[index]!);
    if (open !== undefined && open.transactional && transactional) continue;
    if (open !== undefined) {
      groups.push({ start: open.start, end: index, transactional: open.transactional });
    }
    open = { start: index, transactional };
  }
  if (open !== undefined) {
    groups.push({ start: open.start, end: steps.length, transactional: open.transactional });
  }
  return groups;
}

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
  const uniqueConstraintDrops: Step[] = [];
  const uniqueConstraintAdds: Step[] = [];
  const checkConstraintDrops: Step[] = [];
  const checkConstraintAdds: Step[] = [];
  const indexDrops: Step[] = [];
  const indexCreates: Step[] = [];
  const identityDrops: Step[] = [];
  const identityAdds: Step[] = [];
  const identityAlters: Step[] = [];
  const sequenceCreates: Step[] = [];
  const optionAlters: Step[] = [];
  const ownershipChanges: SequenceOwnershipChange[] = [];
  const removedSequences: RemovedSequence[] = [];
  const removedTableKeys = new Set<string>();
  const removedColumnKeys = new Set<string>();

  for (const change of changes) {
    switch (change.kind) {
      case 'table-removed': {
        removedTables.push({
          identity: copyIdentity(change.table),
          table: copyTable(change.table),
        });
        removedTableKeys.add(keyOf(change.table));
        break;
      }
      case 'table-added': {
        tableCreates.push({
          kind: 'create-table',
          table: copyTableForCreate(change.table),
        });
        for (const foreignKey of change.table.foreignKeys) {
          foreignKeyAdds.push({
            kind: 'add-foreign-key',
            table: copyIdentity(change.table),
            foreignKey: copyForeignKey(foreignKey),
          });
        }
        for (const uniqueConstraint of change.table.uniqueConstraints) {
          uniqueConstraintAdds.push({
            kind: 'add-unique-constraint',
            table: copyIdentity(change.table),
            uniqueConstraint: copyUniqueConstraint(uniqueConstraint),
          });
        }
        for (const checkConstraint of change.table.checkConstraints) {
          checkConstraintAdds.push({
            kind: 'add-check-constraint',
            table: copyIdentity(change.table),
            checkConstraint: copyCheckConstraint(checkConstraint),
          });
        }
        for (const index of change.table.indexes) {
          indexCreates.push(indexCreateStep(copyIdentity(change.table), index));
        }
        for (const column of change.table.columns) {
          if (column.identity === undefined) continue;
          identityAdds.push({
            kind: 'add-identity',
            table: copyIdentity(change.table),
            name: column.name,
            identity: copyColumnIdentity(column.identity),
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
              removedColumnKeys.add(columnKey(change.table, tableChange.column.name));
              break;
            }
            case 'column-added': {
              columnAdds.push({
                kind: 'add-column',
                table: copyIdentity(change.table),
                column: copyColumn(tableChange.column),
              });
              if (tableChange.column.identity !== undefined) {
                identityAdds.push({
                  kind: 'add-identity',
                  table: copyIdentity(change.table),
                  name: tableChange.column.name,
                  identity: copyColumnIdentity(tableChange.column.identity),
                });
              }
              break;
            }
            case 'column-changed': {
              if (tableChange.fields.length > 0) {
                columnAlters.push({
                  kind: 'alter-column',
                  table: copyIdentity(change.table),
                  name: tableChange.name,
                  fields: tableChange.fields.map(copyFieldChange),
                });
              }
              const identityChange = tableChange.identity;
              if (identityChange !== undefined) {
                switch (identityChange.kind) {
                  case 'added':
                    identityAdds.push({
                      kind: 'add-identity',
                      table: copyIdentity(change.table),
                      name: tableChange.name,
                      identity: copyColumnIdentity(identityChange.identity),
                    });
                    break;
                  case 'removed':
                    identityDrops.push({
                      kind: 'drop-identity',
                      table: copyIdentity(change.table),
                      name: tableChange.name,
                    });
                    break;
                  case 'recreated':
                    identityDrops.push({
                      kind: 'drop-identity',
                      table: copyIdentity(change.table),
                      name: tableChange.name,
                    });
                    identityAdds.push({
                      kind: 'add-identity',
                      table: copyIdentity(change.table),
                      name: tableChange.name,
                      identity: copyColumnIdentity(identityChange.identity),
                    });
                    break;
                  case 'changed':
                    if (identityChange.fields.length > 0) {
                      identityAlters.push({
                        kind: 'alter-identity',
                        table: copyIdentity(change.table),
                        name: tableChange.name,
                        fields: identityChange.fields.map(copyIdentityFieldChange),
                      });
                    }
                    break;
                }
              }
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
            case 'unique-constraint-removed': {
              uniqueConstraintDrops.push({
                kind: 'drop-unique-constraint',
                table: copyIdentity(change.table),
                uniqueConstraint: copyUniqueConstraint(tableChange.uniqueConstraint),
              });
              break;
            }
            case 'unique-constraint-added': {
              uniqueConstraintAdds.push({
                kind: 'add-unique-constraint',
                table: copyIdentity(change.table),
                uniqueConstraint: copyUniqueConstraint(tableChange.uniqueConstraint),
              });
              break;
            }
            case 'unique-constraint-changed': {
              uniqueConstraintDrops.push({
                kind: 'drop-unique-constraint',
                table: copyIdentity(change.table),
                uniqueConstraint: copyUniqueConstraint(tableChange.before),
              });
              uniqueConstraintAdds.push({
                kind: 'add-unique-constraint',
                table: copyIdentity(change.table),
                uniqueConstraint: copyUniqueConstraint(tableChange.after),
              });
              break;
            }
            case 'check-constraint-removed': {
              checkConstraintDrops.push({
                kind: 'drop-check-constraint',
                table: copyIdentity(change.table),
                checkConstraint: copyCheckConstraint(tableChange.checkConstraint),
              });
              break;
            }
            case 'check-constraint-added': {
              checkConstraintAdds.push({
                kind: 'add-check-constraint',
                table: copyIdentity(change.table),
                checkConstraint: copyCheckConstraint(tableChange.checkConstraint),
              });
              break;
            }
            case 'check-constraint-changed': {
              checkConstraintDrops.push({
                kind: 'drop-check-constraint',
                table: copyIdentity(change.table),
                checkConstraint: copyCheckConstraint(tableChange.before),
              });
              checkConstraintAdds.push({
                kind: 'add-check-constraint',
                table: copyIdentity(change.table),
                checkConstraint: copyCheckConstraint(tableChange.after),
              });
              break;
            }
            case 'index-removed': {
              indexDrops.push(indexDropStep(copyIdentity(change.table), tableChange.index));
              break;
            }
            case 'index-added': {
              indexCreates.push(indexCreateStep(copyIdentity(change.table), tableChange.index));
              break;
            }
            case 'index-changed': {
              indexDrops.push(indexDropStep(copyIdentity(change.table), tableChange.before));
              indexCreates.push(indexCreateStep(copyIdentity(change.table), tableChange.after));
              break;
            }
          }
        }
        break;
      }
      case 'sequence-added': {
        sequenceCreates.push({
          kind: 'create-sequence',
          sequence: copySequenceWithoutOwner(change.sequence),
        });
        if (change.sequence.ownedBy !== undefined) {
          ownershipChanges.push({
            sequence: copySequenceIdentity(change.sequence),
            after: copyOwner(change.sequence.ownedBy),
          });
        }
        break;
      }
      case 'sequence-removed': {
        removedSequences.push({
          identity: copySequenceIdentity(change.sequence),
          ...(change.sequence.ownedBy === undefined
            ? {}
            : { ownedBy: copyOwner(change.sequence.ownedBy) }),
        });
        break;
      }
      case 'sequence-changed': {
        const identity = copySequenceIdentity(change.sequence);
        const ownership = change.changes.filter((field) => field.field === 'ownedBy');
        const options = change.changes.filter((field) => field.field !== 'ownedBy');
        if (options.length > 0) {
          optionAlters.push({
            kind: 'alter-sequence',
            sequence: identity,
            fields: options.map(copySequenceFieldChange),
          });
        }
        for (const field of ownership) {
          if (field.field !== 'ownedBy') continue;
          ownershipChanges.push({
            sequence: copySequenceIdentity(identity),
            ...(field.before === undefined ? {} : { before: copyOwner(field.before) }),
            ...(field.after === undefined ? {} : { after: copyOwner(field.after) }),
          });
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

  const columnRemoved = (table: TableIdentity, column: string): boolean =>
    removedTableKeys.has(keyOf(table)) || removedColumnKeys.has(columnKey(table, column));

  const ownerRemoved = (owner: SequenceOwner): boolean => columnRemoved(owner.table, owner.column);

  const ownershipDetaches: Step[] = [];
  const ownershipAttaches: Step[] = [];
  for (const change of ownershipChanges) {
    if (change.before !== undefined && ownerRemoved(change.before)) {
      ownershipDetaches.push({
        kind: 'alter-sequence',
        sequence: change.sequence,
        fields: [{ field: 'ownedBy', before: change.before }],
      });
      if (change.after !== undefined) {
        ownershipAttaches.push({
          kind: 'alter-sequence',
          sequence: copySequenceIdentity(change.sequence),
          fields: [{ field: 'ownedBy', before: change.before, after: change.after }],
        });
      }
    } else {
      ownershipAttaches.push({
        kind: 'alter-sequence',
        sequence: change.sequence,
        fields: [
          {
            field: 'ownedBy',
            ...(change.before === undefined ? {} : { before: change.before }),
            ...(change.after === undefined ? {} : { after: change.after }),
          },
        ],
      });
    }
  }

  const sequenceDrops: Step[] = [];
  for (const removed of removedSequences) {
    if (removed.ownedBy !== undefined && ownerRemoved(removed.ownedBy)) continue;
    sequenceDrops.push({ kind: 'drop-sequence', sequence: removed.identity });
  }

  const steps: Step[] = [
    ...identityDrops,
    ...sequenceCreates,
    ...ownershipDetaches,
    ...foreignKeyDrops,
    ...dependentKeyDrops,
    ...breaks,
    ...indexDrops,
    ...checkConstraintDrops,
    ...uniqueConstraintDrops,
    ...tableDrops,
    ...primaryKeyDrops,
    ...columnDrops,
    ...tableCreates,
    ...columnAdds,
    ...columnAlters,
    ...primaryKeyAdds,
    ...uniqueConstraintAdds,
    ...checkConstraintAdds,
    ...indexCreates,
    ...foreignKeyAdds,
    ...dependentKeyAdds,
    ...ownershipAttaches,
    ...optionAlters,
    ...sequenceDrops,
    ...identityAdds,
    ...identityAlters,
  ];

  return { steps, groups: groupSteps(steps) };
}

/** A changed sequence's ownership, held until the plan knows which owners it removes. */
interface SequenceOwnershipChange {
  readonly sequence: SequenceIdentity;
  readonly before?: SequenceOwner;
  readonly after?: SequenceOwner;
}

/** A removed sequence, held until the plan knows whether its owner's drop cascades it. */
interface RemovedSequence {
  readonly identity: SequenceIdentity;
  readonly ownedBy?: SequenceOwner;
}

/** A removed table, held with its canonical payload while table phase 5 orders the drops. */
interface RemovedTable {
  readonly identity: TableIdentity;
  readonly table: Table;
}

/**
 * Phase 5: orders the removed tables' drops so a table is dropped only once no remaining
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

/** A copy of `column`, independent of the caller's model, nested identity included. */
function copyColumn(column: Column): Column {
  return {
    ...column,
    ...(column.identity === undefined ? {} : { identity: copyColumnIdentity(column.identity) }),
  };
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

/** A copy of `uniqueConstraint`, independent of the caller's model. */
function copyUniqueConstraint(uniqueConstraint: UniqueConstraint): UniqueConstraint {
  return { ...uniqueConstraint, columns: [...uniqueConstraint.columns] };
}

/** A copy of `checkConstraint`, independent of the caller's model. */
function copyCheckConstraint(checkConstraint: CheckConstraint): CheckConstraint {
  return { ...checkConstraint };
}

/** A copy of `index`, independent of the caller's model. */
function copyIndex(index: Index): Index {
  return { ...index, columns: [...index.columns] };
}

/** The create step for `index`: concurrent exactly when the index states `concurrently`. */
function indexCreateStep(table: TableIdentity, index: Index): Step {
  return {
    kind: index.concurrently === true ? 'create-index-concurrently' : 'create-index',
    table,
    index: copyIndex(index),
  };
}

/** The drop step for `index`: concurrent exactly when the index states `concurrently`. */
function indexDropStep(table: TableIdentity, index: Index): Step {
  return {
    kind: index.concurrently === true ? 'drop-index-concurrently' : 'drop-index',
    table,
    index: copyIndex(index),
  };
}

/** A copy of one column field change, independent of the diff's payload. */
function copyFieldChange(field: ColumnFieldChange): ColumnFieldChange {
  return { ...field };
}

/** A copy of one identity field change, independent of the diff's payload. */
function copyIdentityFieldChange(field: IdentityFieldChange): IdentityFieldChange {
  return { ...field };
}

/** A copy of a column's identity descriptor, independent of the caller's model. */
function copyColumnIdentity(identity: Identity): Identity {
  return {
    ...identity,
    ...(identity.sequenceName === undefined
      ? {}
      : {
          sequenceName: {
            schema: identity.sequenceName.schema,
            name: identity.sequenceName.name,
          },
        }),
  };
}

/** A copy of one sequence field change, independent of the diff's payload. */
function copySequenceFieldChange(field: SequenceFieldChange): SequenceFieldChange {
  if (field.field !== 'ownedBy') return { ...field };
  return {
    field: 'ownedBy',
    ...(field.before === undefined ? {} : { before: copyOwner(field.before) }),
    ...(field.after === undefined ? {} : { after: copyOwner(field.after) }),
  };
}

/** A copy of `identity`, independent of the caller's model. */
function copySequenceIdentity(identity: SequenceIdentity): SequenceIdentity {
  return { schema: identity.schema, name: identity.name };
}

/** A copy of `owner`, independent of the caller's model. */
function copyOwner(owner: SequenceOwner): SequenceOwner {
  return { table: copyIdentity(owner.table), column: owner.column };
}

/** A copy of `sequence`, independent of the caller's model, without its owner. */
function copySequenceWithoutOwner(sequence: Sequence): Sequence {
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
  };
}

/** A copy of `table`, independent of the caller's model. */
function copyTable(table: Table): Table {
  return {
    ...copyTableForCreate(table),
    foreignKeys: table.foreignKeys.map(copyForeignKey),
    uniqueConstraints: table.uniqueConstraints.map(copyUniqueConstraint),
    checkConstraints: table.checkConstraints.map(copyCheckConstraint),
    indexes: table.indexes.map(copyIndex),
  };
}

/**
 * A copy of `table` for a create-table step: columns and primary key as they are, and empty
 * foreign keys, unique constraints, check constraints, and indexes, each of which attaches with
 * its own step.
 */
function copyTableForCreate(table: Table): Table {
  return {
    schema: table.schema,
    name: table.name,
    columns: table.columns.map(copyColumn),
    ...(table.primaryKey === undefined ? {} : { primaryKey: copyPrimaryKey(table.primaryKey) }),
    foreignKeys: [],
    uniqueConstraints: [],
    checkConstraints: [],
    indexes: [],
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
      if (targetOwner === undefined) continue; // Removed tables are gone before table phase 6.

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

/** The map key of a table and column pair; JSON and a NUL keep any characters unambiguous. */
function columnKey(table: TableIdentity, column: string): string {
  return `${keyOf(table)}\u0000${column}`;
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

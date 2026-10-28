import { diff } from './diff.ts';
import type {
  Change,
  ColumnFieldChange,
  IdentityFieldChange,
  SequenceFieldChange,
} from './diff.ts';
import type { Identity } from './identity.ts';
import type {
  CheckConstraint,
  Column,
  ColumnAttributes,
  ForeignKey,
  Index,
  Model,
  PrimaryKey,
  Sequence,
  SequenceIdentity,
  SequenceOwner,
  Table,
  TableIdentity,
  TablePersistence,
  UniqueConstraint,
  View,
  ViewIdentity,
} from './model.ts';

/**
 * The migration plan: what to change, in the order that works.
 *
 * `plan` runs the diff between a baseline model and a target model, expands every change into
 * executable steps, and reorders them so the dependencies the model can express are respected:
 * sequences before the tables that own them, referencing tables before the tables they
 * reference, constraints before the primary keys and columns they depend on, view drops before
 * the table drops they could block, and view creates after the table work they may read. It is
 * the change engine's ordering pass: the plan carries every payload a renderer needs and
 * partitions its steps into transaction groups, telling a renderer what applies as one unit;
 * hazards are a separate analysis.
 *
 * A step is one of thirty kinds. A table addition becomes a create-table step carrying
 * the table's columns and primary key as they are, plus one add-foreign-key step per foreign
 * key, one add-unique-constraint step per unique constraint, one add-check-constraint step per
 * check constraint, and one create-index step per index — the create-table payload is always
 * free of foreign keys, unique constraints, check constraints, and indexes, so each attaches
 * with its own step and constraints attach only once every referenced table exists. A table
 * removal becomes a drop-table step. A changed table is mapped member by member: a removed
 * column becomes drop-column, an added column add-column, a changed column alter-column
 * carrying only its differing fields in the fixed order `type`, `notNull`, `notNullName`,
 * `default`, `collation`, `storage`, `compression`, and, when any of `type`, `collation`,
 * `storage`, or `compression` differs, the target-side `attributes` carrier the renderer
 * restates from — except that a `notNullName` difference is name-involved: the plan consumes
 * the `notNull` and `notNullName` fields into a drop-not-null and/or add-not-null step (a drop
 * when the baseline column is NOT NULL, an add when the target is) and keeps only the
 * remaining fields in an alter-column; a changed persistence becomes an alter-persistence
 * step carrying the target state; plus, when the column's identity differs, identity steps:
 * an identity addition becomes an add-identity step carrying the target descriptor, a
 * removal a drop-identity, a change an alter-identity carrying only its differing fields, and
 * a stated sequence-name mismatch a drop-identity and an add-identity (a recreation); a
 * removed, added, or changed primary key becomes a drop-primary-key and/or add-primary-key
 * step; a removed, added, or changed foreign key becomes a drop-foreign-key and/or
 * add-foreign-key step; a removed, added, or changed unique constraint becomes a
 * drop-unique-constraint and/or add-unique-constraint step; a removed, added, or changed check
 * constraint becomes a drop-check-constraint and/or add-check-constraint step; and a removed,
 * added, or changed index becomes a drop-index and/or create-index step. A changed primary key,
 * foreign key, unique constraint, check constraint, or index decomposes into its drop half and
 * its add half.
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
 * A view addition becomes a create-view step carrying the view as stored; a view removal
 * becomes a drop-view step carrying the baseline identity and whether it was materialized. A
 * changed plain view becomes a replace-view step carrying the target view: `CREATE OR REPLACE
 * VIEW` keeps grants, ownership, and dependent views, but PostgreSQL requires compatible output
 * columns. A changed materialized view, or any change between plain and materialized, becomes a
 * drop-view and a create-view; a materialized view cannot be replaced, and the recreate states
 * `WITH NO DATA`. View steps carry no column or table payloads.
 *
 * A comment addition, change, or removal becomes a comment step carrying a `CommentTarget` and
 * the target's text, absent text meaning `COMMENT … IS NULL`. The target's copied nodes never
 * carry their own `comment`: the step's `text` is the single source of the rendered value. A
 * node a structural change recreates (an index, a primary key, a constraint, or a view) gets a
 * comment step right after its create when the target node states a comment, because the drop
 * took the old one away; the plan then keeps one step per target, first occurrence wins.
 *
 * The final sequence is the concatenation of eleven global phases, in this exact order:
 *
 * 1. drop-identity — every removed identity whose column survives, in the diff's column and
 *    table order. It runs before everything else: it must precede the `DROP NOT NULL` /
 *    `SET DEFAULT` the table phases put on the same column, and it frees the default sequence
 *    name for the replacement sequence the identity→serial conversion creates in phase 2 (or
 *    for the replacement identity's sequence added in phase 10);
 * 2. create-sequence — one per added sequence, in sequence identity order;
 * 3. ownership detaches — an ownership alter-sequence step for every kept sequence whose
 *    baseline owner table or column the plan removes and whose ownership the target changes.
 *    The detach (`OWNED BY NONE`) must run before the owner's drop, or the drop would cascade
 *    the sequence away;
 * 4. drop-view — every removed view and the drop half of every rewritten one, in view identity
 *    order. View drops precede the table phases so a removed view cannot block a table or
 *    column drop; a dependency between views is not modeled, so a dependent view may still
 *    fail the drop at apply;
 * 5. table operations — the eighteen table phases listed below, in their exact order;
 * 6. create-view, then replace-view — every added view and the create half of every rewritten
 *    one, then the changed plain views, each bucket in view identity order. Views come after
 *    every table phase so a view can reference a newly created table or column; a kept view
 *    whose definition references a dropped object still fails at apply;
 * 7. ownership attaches/re-owns — an ownership alter-sequence step for every kept sequence
 *    whose target ownership differs from its baseline one and whose baseline owner is not
 *    removed in phase 3: a new owner after a phase-3 detach, a new owner over a surviving
 *    baseline one, or a detach when the target drops ownership but keeps the owner;
 * 8. sequence option alters — one alter-sequence step per changed sequence, carrying its
 *    non-ownership field changes in the diff's fixed order, so each step can be applied in one
 *    statement without passing through an invalid intermediate state;
 * 9. drop-sequence — every removed sequence whose owner the plan does not remove, in sequence
 *    identity order. Drops come after the table phases, so a column `DROP DEFAULT` has already
 *    released the sequence by the time its drop runs; a surviving default that still
 *    references a dropped sequence is a broken target and fails at apply;
 * 10. add-identity, then alter-identity — the identity additions and option alters, in the
 *    diff's column and table order, adds before alters. They run last because `ADD GENERATED`
 *    manufactures a fresh sequence: by then the table phases have produced the column, its
 *    `SET NOT NULL`, and its `DROP DEFAULT`, and phases 1 and 9 have freed the sequence names
 *    the added identities replace. This placement alone makes both conversions compositions of
 *    ordinary steps: serial→identity is a phase-5 `DROP DEFAULT`, a phase-9 sequence drop, and
 *    a phase-10 add-identity; identity→serial is a phase-1 drop-identity, a phase-2
 *    create-sequence, and a phase-5 `SET DEFAULT`;
 * 11. comment — every comment addition, change, and removal, in target identity order, last
 *    because every commented object exists by then (tables, columns, constraints, and indexes
 *    from phase 5, views from phase 6, sequences from phases 2 and 8, identities from phase
 *    10) and comments never affect structure.
 *
 * A `drop-identity` needs no drop-suppression: an identity reaches the plan as its own removal
 * only when its column survives — a removed column or table carries its identity away in that
 * drop — so every collected drop-identity names an owner that still exists.
 *
 * The table phases inside phase 5 are numbered as before (and keep their documented semantics):
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
 * 10. drop-not-null — the name-involved not-null drops, before the column alterations they
 *     bracket. Each carries the name the baseline column's not-null constraint had, or no
 *     name when it was unnamed;
 * 11. alter-column — after the not-null drops and before the not-null adds, so a
 *     name-involved change never rides an alter-column;
 * 12. add-not-null — the name-involved not-null adds, after the column alterations. Each
 *     carries the target constraint's name, or no name when the target's not-null fact is
 *     unnamed;
 * 13. alter-persistence — the target-side persistence changes, after the column work and
 *     before the keys: each carries the target's persistence, or nothing for `SET LOGGED`;
 * 14. add-primary-key — after its columns exist;
 * 15. add-unique-constraint — after its columns exist;
 * 16. add-check-constraint — after its columns exist;
 * 17. create-index — after its columns exist; the concurrent variant stands alone;
 * 18. add-foreign-key — last, once both the table and the referenced table exist, with the
 *     synthesized primary-key dependents after the diff-derived adds.
 *
 * Within a phase, steps keep the relative order the diff produced: table and sequence changes
 * in identity order, and inside a changed table the diff's documented member order. A table
 * addition contributes its unique-constraint, check-constraint, and index steps to table phases
 * 15–17 and its foreign-key steps to table phase 18, each in the added table's canonical order.
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
 * phase 1 and an add-foreign-key step with the target payload in table phase 18. The diff's own
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

/**
 * The entity a `comment` step (or a `comment-changed` change) names: one variant per
 * `COMMENT ON` object form the model carries. Each carries the node or identity the renderer
 * needs, never the comment text itself — the step's `text` is the single source of the rendered
 * value, and a copied target's nodes carry no `comment` of their own. The constraint and index
 * variants carry the whole node because an unnamed node's server name is synthesized at render
 * time, and `view` carries `materialized` because the rendered keyword differs and a
 * `ViewIdentity` alone does not say which kind it names.
 */
export type CommentTarget =
  | { readonly kind: 'table'; readonly table: TableIdentity }
  | { readonly kind: 'column'; readonly table: TableIdentity; readonly column: string }
  | { readonly kind: 'sequence'; readonly sequence: SequenceIdentity }
  | { readonly kind: 'view'; readonly view: ViewIdentity; readonly materialized: boolean }
  | { readonly kind: 'index'; readonly table: TableIdentity; readonly index: Index }
  | { readonly kind: 'primary-key'; readonly table: TableIdentity; readonly primaryKey: PrimaryKey }
  | {
      readonly kind: 'unique-constraint';
      readonly table: TableIdentity;
      readonly uniqueConstraint: UniqueConstraint;
    }
  | {
      readonly kind: 'check-constraint';
      readonly table: TableIdentity;
      readonly checkConstraint: CheckConstraint;
    }
  | {
      readonly kind: 'foreign-key';
      readonly table: TableIdentity;
      readonly foreignKey: ForeignKey;
    };

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
  /**
   * A column both sides have with differing fields, in the fixed order `type`, `notNull`,
   * `notNullName`, `default`, `collation`, `storage`, `compression`. A name-involved change
   * (a differing `notNullName`) consumes both not-null fields into
   * `drop-not-null`/`add-not-null` steps and leaves only the other fields here. The
   * `attributes` carrier is the target side, present exactly when the diff reports one of
   * `type`, `collation`, `storage`, or `compression`.
   */
  | {
      kind: 'alter-column';
      table: TableIdentity;
      name: string;
      fields: readonly ColumnFieldChange[];
      attributes?: ColumnAttributes;
    }
  /**
   * The baseline has a not-null fact on a column the target does not keep: a named
   * `drop-not-null` drops the constraint by name, an unnamed one drops the column's not-null.
   */
  | { kind: 'drop-not-null'; table: TableIdentity; column: string; name?: string }
  /**
   * The target has a not-null fact on a column the baseline does not: a named `add-not-null`
   * adds the named constraint, an unnamed one sets the column's not-null.
   */
  | { kind: 'add-not-null'; table: TableIdentity; column: string; name?: string }
  /**
   * The target's table persistence: `unlogged` sets `SET UNLOGGED`, and an absent persistence
   * states the `LOGGED` default (`SET LOGGED`).
   */
  | { kind: 'alter-persistence'; table: TableIdentity; persistence?: TablePersistence }
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
    }
  /** The target has a view the baseline does not; `materialized` decides the rendered keyword. */
  | { kind: 'create-view'; view: View }
  /**
   * The baseline has a view the target does not, or the drop half of a rewritten one;
   * `materialized` decides the rendered keyword.
   */
  | { kind: 'drop-view'; view: ViewIdentity; materialized: boolean }
  /**
   * A plain view both sides have with a differing definition or check option:
   * `CREATE OR REPLACE VIEW`. Never materialized: a materialized view is dropped and created.
   */
  | { kind: 'replace-view'; view: View }
  /**
   * The target's comment on `target`, or the comment's removal when `text` is absent
   * (`COMMENT … IS NULL`). `text` is the single source of the rendered value: the copied
   * target's nodes carry no `comment` of their own.
   */
  | { kind: 'comment'; target: CommentTarget; text?: string };

/**
 * The exhaustiveness guard for a union `switch`: every `switch` that must understand each member
 * ends its `default` clause here, so a member with no case fails to typecheck. It throws with
 * `context` and the offending `kind` or `field` when one is present, else the whole value.
 */
export function assertNever(value: never, context: string): never {
  const { kind, field } = value as { kind?: unknown; field?: unknown };
  const detail =
    typeof kind === 'string' ? kind : typeof field === 'string' ? field : String(value);
  throw new Error(`Unhandled ${context}: ${detail}`);
}

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
  'drop-not-null': true,
  'add-not-null': true,
  'alter-persistence': true,
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
  'create-view': true,
  'drop-view': true,
  'replace-view': true,
  comment: true,
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

  const application = emptyChangeApplication();
  for (const change of changes) applyChange(application, change);

  const { drops: tableDrops, breaks } = orderTableDrops(application.removedTables);
  const { drops: dependentKeyDrops, adds: dependentKeyAdds } = dependentForeignKeySteps(
    baseline,
    target,
    application.primaryKeyDrops,
  );

  // The seventh recreate site: a diff-equal foreign key is dropped and re-added when its
  // table's primary key changes, so a comment on it must be asserted again after the add.
  // Primary-key drops were walked in diff order, and each add carries the target payload.
  for (const step of dependentKeyAdds) {
    if (step.kind !== 'add-foreign-key') continue;
    pushRecreateComment(
      application,
      { kind: 'foreign-key', table: step.table, foreignKey: step.foreignKey },
      step.foreignKey.comment,
    );
  }

  const columnRemoved = (table: TableIdentity, column: string): boolean =>
    application.removedTableKeys.has(keyOf(table)) ||
    application.removedColumnKeys.has(columnKey(table, column));

  const ownerRemoved = (owner: SequenceOwner): boolean => columnRemoved(owner.table, owner.column);

  const ownershipDetaches: Step[] = [];
  const ownershipAttaches: Step[] = [];
  for (const change of application.ownershipChanges) {
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
  for (const removed of application.removedSequences) {
    if (removed.ownedBy !== undefined && ownerRemoved(removed.ownedBy)) continue;
    sequenceDrops.push({ kind: 'drop-sequence', sequence: removed.identity });
  }

  const steps: Step[] = [
    ...application.identityDrops,
    ...application.sequenceCreates,
    ...ownershipDetaches,
    ...application.viewDrops,
    ...application.foreignKeyDrops,
    ...dependentKeyDrops,
    ...breaks,
    ...application.indexDrops,
    ...application.checkConstraintDrops,
    ...application.uniqueConstraintDrops,
    ...tableDrops,
    ...application.primaryKeyDrops,
    ...application.columnDrops,
    ...application.tableCreates,
    ...application.columnAdds,
    ...application.notNullDrops,
    ...application.columnAlters,
    ...application.notNullAdds,
    ...application.persistenceAlters,
    ...application.primaryKeyAdds,
    ...application.uniqueConstraintAdds,
    ...application.checkConstraintAdds,
    ...application.indexCreates,
    ...application.foreignKeyAdds,
    ...dependentKeyAdds,
    ...application.viewCreates,
    ...application.viewReplaces,
    ...ownershipAttaches,
    ...application.optionAlters,
    ...sequenceDrops,
    ...application.identityAdds,
    ...application.identityAlters,
    ...commentPhase(application.comments),
  ];

  return { steps, groups: groupSteps(steps) };
}

/**
 * The buckets `plan` writes while expanding every `Change` into steps: the write side of the
 * change application pass, exposed with `emptyChangeApplication` and `applyChange` as an
 * internal test seam. `plan` builds one application, applies the whole diff through
 * `applyChange`, then reads the buckets in the post-loop to order, suppress, and phase the
 * steps. Not package API: the barrel never re-exports the values, and this seam validates
 * nothing — `diff` never emits a kind or field outside the unions below, so unknown values
 * here are fabricated detectors, not pipeline input. #50 extends this seam.
 */
export interface ChangeApplication {
  readonly foreignKeyDrops: Step[];
  readonly primaryKeyDrops: Step[];
  readonly columnDrops: Step[];
  /** Removed tables, held with their payload until table phase 5 orders the drops. */
  readonly removedTables: RemovedTable[];
  readonly tableCreates: Step[];
  readonly columnAdds: Step[];
  /** The name-involved not-null drops, bracketing the column alterations. */
  readonly notNullDrops: Step[];
  readonly columnAlters: Step[];
  /** The name-involved not-null adds, bracketing the column alterations. */
  readonly notNullAdds: Step[];
  /** The persistence alters, after the not-null adds and before the primary-key adds. */
  readonly persistenceAlters: Step[];
  readonly primaryKeyAdds: Step[];
  readonly foreignKeyAdds: Step[];
  readonly uniqueConstraintDrops: Step[];
  readonly uniqueConstraintAdds: Step[];
  readonly checkConstraintDrops: Step[];
  readonly checkConstraintAdds: Step[];
  readonly indexDrops: Step[];
  readonly indexCreates: Step[];
  readonly identityDrops: Step[];
  readonly identityAdds: Step[];
  readonly identityAlters: Step[];
  readonly sequenceCreates: Step[];
  readonly optionAlters: Step[];
  /** Removed views and the drop half of rewritten ones, before the table phases. */
  readonly viewDrops: Step[];
  /** Added views and the create half of rewritten ones, after the table phases. */
  readonly viewCreates: Step[];
  /** Changed plain views, applied with `CREATE OR REPLACE VIEW` after the table phases. */
  readonly viewReplaces: Step[];
  /**
   * Every comment step: the diff's `comment-changed` changes and the recreate re-assertions
   * alike. `plan` keeps this bucket out of every other one, so the terminal phase owns every
   * comment statement.
   */
  readonly comments: Step[];
  /** A changed sequence's ownership, held until the plan knows which owners it removes. */
  readonly ownershipChanges: SequenceOwnershipChange[];
  /** A removed sequence, held until the plan knows whether its owner's drop cascades it. */
  readonly removedSequences: RemovedSequence[];
  /** The removed tables' keys, for the post-loop owner-removal test. */
  readonly removedTableKeys: Set<string>;
  /** The removed columns' keys, for the post-loop owner-removal test. */
  readonly removedColumnKeys: Set<string>;
}

/**
 * A fresh `ChangeApplication` with independent arrays and sets, so separate applications never
 * share bucket state. Internal test seam, see `ChangeApplication`.
 */
export function emptyChangeApplication(): ChangeApplication {
  return {
    foreignKeyDrops: [],
    primaryKeyDrops: [],
    columnDrops: [],
    removedTables: [],
    tableCreates: [],
    columnAdds: [],
    notNullDrops: [],
    columnAlters: [],
    notNullAdds: [],
    persistenceAlters: [],
    primaryKeyAdds: [],
    foreignKeyAdds: [],
    uniqueConstraintDrops: [],
    uniqueConstraintAdds: [],
    checkConstraintDrops: [],
    checkConstraintAdds: [],
    indexDrops: [],
    indexCreates: [],
    identityDrops: [],
    identityAdds: [],
    identityAlters: [],
    sequenceCreates: [],
    optionAlters: [],
    viewDrops: [],
    viewCreates: [],
    viewReplaces: [],
    comments: [],
    ownershipChanges: [],
    removedSequences: [],
    removedTableKeys: new Set<string>(),
    removedColumnKeys: new Set<string>(),
  };
}

/**
 * Applies one `Change` to `application`: it writes exactly the buckets `plan` reads after the
 * loop, with the same copies and in the same order. Internal test seam, see
 * `ChangeApplication`.
 */
export function applyChange(application: ChangeApplication, change: Change): void {
  switch (change.kind) {
    case 'table-removed': {
      application.removedTables.push({
        identity: copyIdentity(change.table),
        table: copyTable(change.table),
      });
      application.removedTableKeys.add(keyOf(change.table));
      break;
    }
    case 'table-added': {
      application.tableCreates.push({
        kind: 'create-table',
        table: copyTableForCreate(change.table),
      });
      for (const foreignKey of change.table.foreignKeys) {
        application.foreignKeyAdds.push({
          kind: 'add-foreign-key',
          table: copyIdentity(change.table),
          foreignKey: copyForeignKey(foreignKey),
        });
      }
      for (const uniqueConstraint of change.table.uniqueConstraints) {
        application.uniqueConstraintAdds.push({
          kind: 'add-unique-constraint',
          table: copyIdentity(change.table),
          uniqueConstraint: copyUniqueConstraint(uniqueConstraint),
        });
      }
      for (const checkConstraint of change.table.checkConstraints) {
        application.checkConstraintAdds.push({
          kind: 'add-check-constraint',
          table: copyIdentity(change.table),
          checkConstraint: copyCheckConstraint(checkConstraint),
        });
      }
      for (const index of change.table.indexes) {
        application.indexCreates.push(indexCreateStep(copyIdentity(change.table), index));
      }
      for (const column of change.table.columns) {
        if (column.identity === undefined) continue;
        application.identityAdds.push({
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
            application.columnDrops.push({
              kind: 'drop-column',
              table: copyIdentity(change.table),
              column: copyColumn(tableChange.column),
            });
            application.removedColumnKeys.add(columnKey(change.table, tableChange.column.name));
            break;
          }
          case 'column-added': {
            application.columnAdds.push({
              kind: 'add-column',
              table: copyIdentity(change.table),
              column: copyColumn(tableChange.column),
            });
            if (tableChange.column.identity !== undefined) {
              application.identityAdds.push({
                kind: 'add-identity',
                table: copyIdentity(change.table),
                name: tableChange.column.name,
                identity: copyColumnIdentity(tableChange.column.identity),
              });
            }
            break;
          }
          case 'column-changed': {
            const nameInvolved = tableChange.fields.some((field) => field.field === 'notNullName');
            const remaining: ColumnFieldChange[] = [];
            if (nameInvolved) {
              // A name-involved change consumes both not-null fields: the names ride the new
              // steps, and the not-null facts default to true when the `notNull` field is
              // absent (a name-only change leaves the column's nullability alone).
              let beforeNotNull = true;
              let afterNotNull = true;
              let beforeName: string | undefined;
              let afterName: string | undefined;
              for (const field of tableChange.fields) {
                if (field.field === 'notNullName') {
                  beforeName = field.before;
                  afterName = field.after;
                } else if (field.field === 'notNull') {
                  beforeNotNull = field.before;
                  afterNotNull = field.after;
                } else {
                  remaining.push(field);
                }
              }
              if (beforeNotNull) {
                application.notNullDrops.push({
                  kind: 'drop-not-null',
                  table: copyIdentity(change.table),
                  column: tableChange.name,
                  ...(beforeName === undefined ? {} : { name: beforeName }),
                });
              }
              if (afterNotNull) {
                application.notNullAdds.push({
                  kind: 'add-not-null',
                  table: copyIdentity(change.table),
                  column: tableChange.name,
                  ...(afterName === undefined ? {} : { name: afterName }),
                });
              }
            } else {
              remaining.push(...tableChange.fields);
            }
            if (remaining.length > 0) {
              application.columnAlters.push({
                kind: 'alter-column',
                table: copyIdentity(change.table),
                name: tableChange.name,
                fields: remaining.map(copyFieldChange),
                ...(tableChange.attributes === undefined
                  ? {}
                  : { attributes: copyStepPayload(tableChange.attributes) }),
              });
            }
            const identityChange = tableChange.identity;
            if (identityChange !== undefined) {
              switch (identityChange.kind) {
                case 'added':
                  application.identityAdds.push({
                    kind: 'add-identity',
                    table: copyIdentity(change.table),
                    name: tableChange.name,
                    identity: copyColumnIdentity(identityChange.identity),
                  });
                  break;
                case 'removed':
                  application.identityDrops.push({
                    kind: 'drop-identity',
                    table: copyIdentity(change.table),
                    name: tableChange.name,
                  });
                  break;
                case 'recreated':
                  application.identityDrops.push({
                    kind: 'drop-identity',
                    table: copyIdentity(change.table),
                    name: tableChange.name,
                  });
                  application.identityAdds.push({
                    kind: 'add-identity',
                    table: copyIdentity(change.table),
                    name: tableChange.name,
                    identity: copyColumnIdentity(identityChange.identity),
                  });
                  break;
                case 'changed':
                  if (identityChange.fields.length > 0) {
                    application.identityAlters.push({
                      kind: 'alter-identity',
                      table: copyIdentity(change.table),
                      name: tableChange.name,
                      fields: identityChange.fields.map(copyIdentityFieldChange),
                    });
                  }
                  break;
                default:
                  assertNever(identityChange, 'identity change kind');
              }
            }
            break;
          }
          case 'primary-key-removed': {
            application.primaryKeyDrops.push({
              kind: 'drop-primary-key',
              table: copyIdentity(change.table),
              primaryKey: copyPrimaryKey(tableChange.primaryKey),
            });
            break;
          }
          case 'primary-key-added': {
            application.primaryKeyAdds.push({
              kind: 'add-primary-key',
              table: copyIdentity(change.table),
              primaryKey: copyPrimaryKey(tableChange.primaryKey),
            });
            break;
          }
          case 'primary-key-changed': {
            application.primaryKeyDrops.push({
              kind: 'drop-primary-key',
              table: copyIdentity(change.table),
              primaryKey: copyPrimaryKey(tableChange.before),
            });
            application.primaryKeyAdds.push({
              kind: 'add-primary-key',
              table: copyIdentity(change.table),
              primaryKey: copyPrimaryKey(tableChange.after),
            });
            pushRecreateComment(
              application,
              {
                kind: 'primary-key',
                table: change.table,
                primaryKey: tableChange.after,
              },
              tableChange.after.comment,
            );
            break;
          }
          case 'foreign-key-removed': {
            application.foreignKeyDrops.push({
              kind: 'drop-foreign-key',
              table: copyIdentity(change.table),
              foreignKey: copyForeignKey(tableChange.foreignKey),
            });
            break;
          }
          case 'foreign-key-added': {
            application.foreignKeyAdds.push({
              kind: 'add-foreign-key',
              table: copyIdentity(change.table),
              foreignKey: copyForeignKey(tableChange.foreignKey),
            });
            break;
          }
          case 'foreign-key-changed': {
            application.foreignKeyDrops.push({
              kind: 'drop-foreign-key',
              table: copyIdentity(change.table),
              foreignKey: copyForeignKey(tableChange.before),
            });
            application.foreignKeyAdds.push({
              kind: 'add-foreign-key',
              table: copyIdentity(change.table),
              foreignKey: copyForeignKey(tableChange.after),
            });
            pushRecreateComment(
              application,
              { kind: 'foreign-key', table: change.table, foreignKey: tableChange.after },
              tableChange.after.comment,
            );
            break;
          }
          case 'unique-constraint-removed': {
            application.uniqueConstraintDrops.push({
              kind: 'drop-unique-constraint',
              table: copyIdentity(change.table),
              uniqueConstraint: copyUniqueConstraint(tableChange.uniqueConstraint),
            });
            break;
          }
          case 'unique-constraint-added': {
            application.uniqueConstraintAdds.push({
              kind: 'add-unique-constraint',
              table: copyIdentity(change.table),
              uniqueConstraint: copyUniqueConstraint(tableChange.uniqueConstraint),
            });
            break;
          }
          case 'unique-constraint-changed': {
            application.uniqueConstraintDrops.push({
              kind: 'drop-unique-constraint',
              table: copyIdentity(change.table),
              uniqueConstraint: copyUniqueConstraint(tableChange.before),
            });
            application.uniqueConstraintAdds.push({
              kind: 'add-unique-constraint',
              table: copyIdentity(change.table),
              uniqueConstraint: copyUniqueConstraint(tableChange.after),
            });
            pushRecreateComment(
              application,
              {
                kind: 'unique-constraint',
                table: change.table,
                uniqueConstraint: tableChange.after,
              },
              tableChange.after.comment,
            );
            break;
          }
          case 'check-constraint-removed': {
            application.checkConstraintDrops.push({
              kind: 'drop-check-constraint',
              table: copyIdentity(change.table),
              checkConstraint: copyCheckConstraint(tableChange.checkConstraint),
            });
            break;
          }
          case 'check-constraint-added': {
            application.checkConstraintAdds.push({
              kind: 'add-check-constraint',
              table: copyIdentity(change.table),
              checkConstraint: copyCheckConstraint(tableChange.checkConstraint),
            });
            break;
          }
          case 'check-constraint-changed': {
            application.checkConstraintDrops.push({
              kind: 'drop-check-constraint',
              table: copyIdentity(change.table),
              checkConstraint: copyCheckConstraint(tableChange.before),
            });
            application.checkConstraintAdds.push({
              kind: 'add-check-constraint',
              table: copyIdentity(change.table),
              checkConstraint: copyCheckConstraint(tableChange.after),
            });
            pushRecreateComment(
              application,
              {
                kind: 'check-constraint',
                table: change.table,
                checkConstraint: tableChange.after,
              },
              tableChange.after.comment,
            );
            break;
          }
          case 'index-removed': {
            application.indexDrops.push(
              indexDropStep(copyIdentity(change.table), tableChange.index),
            );
            break;
          }
          case 'index-added': {
            application.indexCreates.push(
              indexCreateStep(copyIdentity(change.table), tableChange.index),
            );
            break;
          }
          case 'index-changed': {
            application.indexDrops.push(
              indexDropStep(copyIdentity(change.table), tableChange.before),
            );
            application.indexCreates.push(
              indexCreateStep(copyIdentity(change.table), tableChange.after),
            );
            pushRecreateComment(
              application,
              { kind: 'index', table: change.table, index: tableChange.after },
              tableChange.after.comment,
            );
            break;
          }
          case 'persistence-changed': {
            application.persistenceAlters.push({
              kind: 'alter-persistence',
              table: copyIdentity(change.table),
              ...(tableChange.after === undefined ? {} : { persistence: tableChange.after }),
            });
            break;
          }
          default:
            assertNever(tableChange, 'table change kind');
        }
      }
      break;
    }
    case 'sequence-added': {
      application.sequenceCreates.push({
        kind: 'create-sequence',
        sequence: copySequenceWithoutOwner(change.sequence),
      });
      if (change.sequence.ownedBy !== undefined) {
        application.ownershipChanges.push({
          sequence: copySequenceIdentity(change.sequence),
          after: copyOwner(change.sequence.ownedBy),
        });
      }
      break;
    }
    case 'sequence-removed': {
      application.removedSequences.push({
        identity: copySequenceIdentity(change.sequence),
        ...(change.sequence.ownedBy === undefined
          ? {}
          : { ownedBy: copyOwner(change.sequence.ownedBy) }),
      });
      break;
    }
    case 'sequence-changed': {
      const identity = copySequenceIdentity(change.sequence);
      const options: SequenceFieldChange[] = [];
      for (const field of change.changes) {
        switch (field.field) {
          case 'ownedBy':
            application.ownershipChanges.push({
              sequence: copySequenceIdentity(identity),
              ...(field.before === undefined ? {} : { before: copyOwner(field.before) }),
              ...(field.after === undefined ? {} : { after: copyOwner(field.after) }),
            });
            break;
          case 'dataType':
          case 'increment':
          case 'minValue':
          case 'maxValue':
          case 'start':
          case 'cache':
          case 'cycle':
            options.push(copyStepPayload(field));
            break;
          default:
            assertNever(field, 'sequence field');
        }
      }
      if (options.length > 0) {
        application.optionAlters.push({
          kind: 'alter-sequence',
          sequence: identity,
          fields: options,
        });
      }
      break;
    }
    case 'view-added': {
      application.viewCreates.push({ kind: 'create-view', view: copyView(change.view) });
      break;
    }
    case 'view-removed': {
      application.viewDrops.push({
        kind: 'drop-view',
        view: copyViewIdentity(change.view),
        materialized: change.view.materialized,
      });
      break;
    }
    case 'view-changed': {
      // A plain view's definition or check-option change is an in-place replace: it keeps
      // grants, ownership, and dependent views. A materialized view cannot be replaced, and a
      // kind change is a different object, so both become a drop and a create — which leaves
      // the recreated matview unpopulated and discards its indexes and dependents (named
      // residual, ADR 0019).
      if (change.before.materialized === false && change.after.materialized === false) {
        application.viewReplaces.push({ kind: 'replace-view', view: copyView(change.after) });
      } else {
        application.viewDrops.push({
          kind: 'drop-view',
          view: copyViewIdentity(change.before),
          materialized: change.before.materialized,
        });
        application.viewCreates.push({ kind: 'create-view', view: copyView(change.after) });
        pushRecreateComment(
          application,
          {
            kind: 'view',
            view: change.after,
            materialized: change.after.materialized,
          },
          change.after.comment,
        );
      }
      break;
    }
    case 'comment-changed': {
      application.comments.push(commentStep(change.target, change.after));
      break;
    }
    default:
      assertNever(change, 'change kind');
  }
}

/** A copy of `view`, independent of the diff's change. */
function copyView(view: View): View {
  return { ...view };
}

/** A copy of a view identity, independent of the diff's change. */
function copyViewIdentity(identity: ViewIdentity): ViewIdentity {
  return { schema: identity.schema, name: identity.name };
}

/** A changed sequence's ownership, held until the plan knows which owners it removes. */
export interface SequenceOwnershipChange {
  readonly sequence: SequenceIdentity;
  readonly before?: SequenceOwner;
  readonly after?: SequenceOwner;
}

/** A removed sequence, held until the plan knows whether its owner's drop cascades it. */
export interface RemovedSequence {
  readonly identity: SequenceIdentity;
  readonly ownedBy?: SequenceOwner;
}

/** A removed table, held with its canonical payload while table phase 5 orders the drops. */
export interface RemovedTable {
  readonly identity: TableIdentity;
  readonly table: Table;
}

/**
 * Table phase 5: orders the removed tables' drops so a table is dropped only once no remaining
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

/**
 * A deep copy of a step-embedded payload, independent of the diff's `Change`. `structuredClone`
 * preserves the payload's shape — undefined-valued keys and key order included — and throws
 * loudly on a non-cloneable value (payloads are plain data). Every payload that reaches a step
 * through a whole-object copy goes through here, so a future nested field cannot alias the
 * diff's change.
 */
function copyStepPayload<T>(value: T): T {
  return structuredClone(value);
}

/** A copy of `checkConstraint`, independent of the caller's model. */
function copyCheckConstraint(checkConstraint: CheckConstraint): CheckConstraint {
  return copyStepPayload(checkConstraint);
}

/** A copy of `index`, independent of the caller's model. */
function copyIndex(index: Index): Index {
  return copyStepPayload(index);
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

/** A writable view of a model payload, for the one place a copy is stripped. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * The `comment` step for `target`: the target is copied without any carried node's `comment`,
 * and `text` — absent for a removal — is the single source of the rendered value.
 */
function commentStep(target: CommentTarget, text: string | undefined): Step {
  return {
    kind: 'comment',
    target: copyCommentTarget(target),
    ...(text === undefined ? {} : { text }),
  };
}

/**
 * Re-asserts `comment` after a recreate, when the target node states one: the drop half took the
 * old comment away. A target the diff also reports as `comment-changed` is deduped by the
 * terminal phase, and both steps carry the target node's text, so one step survives.
 */
function pushRecreateComment(
  application: ChangeApplication,
  target: CommentTarget,
  comment: string | undefined,
): void {
  if (comment === undefined) return;
  application.comments.push(commentStep(target, comment));
}

/**
 * A deep copy of `target` with every carried node stripped of its `comment`: a step's `text` is
 * the single source of the rendered value, so a stale node field can never diverge from it.
 */
function copyCommentTarget(target: CommentTarget): CommentTarget {
  switch (target.kind) {
    case 'table':
      return { kind: 'table', table: copyIdentity(target.table) };
    case 'column':
      return { kind: 'column', table: copyIdentity(target.table), column: target.column };
    case 'sequence':
      return { kind: 'sequence', sequence: copySequenceIdentity(target.sequence) };
    case 'view':
      return {
        kind: 'view',
        view: copyViewIdentity(target.view),
        materialized: target.materialized,
      };
    case 'index': {
      const index: Mutable<Index> = copyIndex(target.index);
      delete index.comment;
      return { kind: 'index', table: copyIdentity(target.table), index };
    }
    case 'primary-key': {
      const primaryKey: Mutable<PrimaryKey> = copyPrimaryKey(target.primaryKey);
      delete primaryKey.comment;
      return { kind: 'primary-key', table: copyIdentity(target.table), primaryKey };
    }
    case 'unique-constraint': {
      const uniqueConstraint: Mutable<UniqueConstraint> = copyUniqueConstraint(
        target.uniqueConstraint,
      );
      delete uniqueConstraint.comment;
      return { kind: 'unique-constraint', table: copyIdentity(target.table), uniqueConstraint };
    }
    case 'check-constraint': {
      const checkConstraint: Mutable<CheckConstraint> = copyCheckConstraint(target.checkConstraint);
      delete checkConstraint.comment;
      return { kind: 'check-constraint', table: copyIdentity(target.table), checkConstraint };
    }
    case 'foreign-key': {
      const foreignKey: Mutable<ForeignKey> = copyForeignKey(target.foreignKey);
      delete foreignKey.comment;
      return { kind: 'foreign-key', table: copyIdentity(target.table), foreignKey };
    }
  }
}

/**
 * The identity key of a comment target: the schema-qualified relation identity, the target
 * kind, then the member's name or identity — a column's name, a constraint's columns or
 * expression, a foreign key's referencing columns and referenced table, or an index's name
 * (an unnamed index by its structure). It deliberately ignores `comment` and every other text
 * value, so the diff's change and a recreate re-assertion for the same target agree on one key.
 * Targets that share the model's identity share a key: the terminal phase keeps the first step
 * and the server applies the last write, the documented last-wins behavior.
 */
function commentTargetKey(target: CommentTarget): string {
  switch (target.kind) {
    case 'table':
      return JSON.stringify([target.table.schema, target.table.name, 'table', '']);
    case 'column':
      return JSON.stringify([target.table.schema, target.table.name, 'column', target.column]);
    case 'sequence':
      return JSON.stringify([target.sequence.schema, target.sequence.name, 'sequence', '']);
    case 'view':
      return JSON.stringify([target.view.schema, target.view.name, 'view', '']);
    case 'index':
      return JSON.stringify([
        target.table.schema,
        target.table.name,
        'index',
        target.index.name ?? [null, target.index.unique, target.index.columns],
      ]);
    case 'primary-key':
      return JSON.stringify([
        target.table.schema,
        target.table.name,
        'primary-key',
        target.primaryKey.columns,
      ]);
    case 'unique-constraint':
      return JSON.stringify([
        target.table.schema,
        target.table.name,
        'unique-constraint',
        target.uniqueConstraint.columns,
      ]);
    case 'check-constraint':
      return JSON.stringify([
        target.table.schema,
        target.table.name,
        'check-constraint',
        target.checkConstraint.expression,
      ]);
    case 'foreign-key':
      return JSON.stringify([
        target.table.schema,
        target.table.name,
        'foreign-key',
        [
          target.foreignKey.columns,
          target.foreignKey.referencedTable.schema,
          target.foreignKey.referencedTable.name,
        ],
      ]);
  }
}

/**
 * The terminal comment phase: the bucket sorted by target identity, one step per target. A
 * target appears twice only when the diff also emitted a change for a node a structural change
 * recreates; both steps carry the target node's text, so keeping the first is sound.
 */
function commentPhase(steps: readonly Step[]): Step[] {
  const comments = steps.filter(
    (step): step is Extract<Step, { kind: 'comment' }> => step.kind === 'comment',
  );
  comments.sort((left, right) =>
    compareStrings(commentTargetKey(left.target), commentTargetKey(right.target)),
  );
  const seen = new Set<string>();
  const kept: Step[] = [];
  for (const step of comments) {
    const key = commentTargetKey(step.target);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(step);
  }
  return kept;
}

/** A copy of one column field change, independent of the diff's payload. */
function copyFieldChange(field: ColumnFieldChange): ColumnFieldChange {
  return copyStepPayload(field);
}

/** A copy of one identity field change, independent of the diff's payload. */
function copyIdentityFieldChange(field: IdentityFieldChange): IdentityFieldChange {
  return copyStepPayload(field);
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
    ...(sequence.comment === undefined ? {} : { comment: sequence.comment }),
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
    ...(table.persistence === undefined ? {} : { persistence: table.persistence }),
    ...(table.comment === undefined ? {} : { comment: table.comment }),
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
 * phase-18 add. Returns the drops and adds in matching discovery order: primary-key drops in
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
    foreignKey.enforcement ?? null,
    foreignKey.deferrable ?? null,
    foreignKey.initiallyDeferred ?? null,
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

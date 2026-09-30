import { canonicalIntType } from './identity.ts';
import type { Identity, IdentityGeneration } from './identity.ts';
import type {
  Column,
  ForeignKey,
  Model,
  PrimaryKey,
  Sequence,
  SequenceDataType,
  SequenceIdentity,
  SequenceOwner,
  Table,
  TableIdentity,
} from './model.ts';
import { effectiveSequence, sequenceTypeChange } from './sequence.ts';

/**
 * The diff: what changed between a baseline model and a target model.
 *
 * `diff` compares two models and reports one change per added, removed, or changed table,
 * column, primary key, foreign key, or sequence. It never guesses a rename: a table or column
 * under a new name is a removal and an addition, a primary key with a different column list is
 * a primary-key change, and a foreign key pointing at a different table is a removal and an
 * addition.
 *
 * Identity is the model's identity. A table is its schema and name; a column is its name
 * within its table; a table has at most one primary key, compared by its name and its column
 * list; two foreign keys belong together when their referencing columns (order-sensitive) and
 * their referenced table are the same, and any other difference — name, referenced columns,
 * actions — reads as a change to that pair; a sequence is its schema and name, like a table.
 *
 * Text is compared exactly as stored. Core never normalizes or lexes SQL: import
 * whitespace-normalizes at the boundary, so even a difference in whitespace is a change.
 * Names are case-sensitive. Sequence options are the exception: they compare on effective
 * values, so an omitted option and its explicit default are the same value, and a sequence
 * that only restates its defaults is not a change (`sequence.ts` holds the rules). A sequence
 * whose `dataType` differs is additionally compared against the engine's `AS` conversion: a
 * bound equal to the old type's bound becomes the new type's bound, so the conversion is
 * applied first and `minValue`/`maxValue` are reported against its result.
 *
 * A column's identity — its `GENERATED … AS IDENTITY` descriptor — is a column property, not
 * a sequence entity, and compares as the `identity` part of the column's change, alongside
 * the scalar fields `type`, `notNull`, and `default`. One identity against a column without
 * one is an addition or a removal carrying that descriptor; two identities compare as a
 * change with only their differing options, in the fixed order `generated`, `increment`,
 * `minValue`, `maxValue`, `start`, `cache`, `cycle`. The sequence name is deliberately not an
 * option: it compares only when both sides state one, a stated mismatch is a recreation
 * carrying the target descriptor (the plan drops the baseline identity and adds the target's),
 * and a name absent on either side is a don't-care. When the column's type change crosses
 * canonical integer types (`canonicalIntType`), the identity's `minValue`/`maxValue` compare
 * against the bounds the engine's `AS` conversion would leave, exactly like a sequence's, so
 * the conversion never churns a bound and any bound it would move is restated.
 *
 * A column is identified by name alone: the ordinal position of an existing column is not
 * part of the diff. The model stores `columns` in source order for fidelity, and column
 * entries are reported in the stored order of the side they come from, but a pure reorder of
 * existing columns is not a change, the change vocabulary has no positional change, and an
 * added column carries no position.
 *
 * The result is deterministic and never depends on the order arrays arrive in:
 *
 * 1. Table identities are merge-walked over the union of both models, sorted by schema, then
 *    name (plain JavaScript string comparison, not locale collation). A baseline-only
 *    identity is a removal, a target-only identity an addition, and an identity present in
 *    both is compared; when nothing differs, it produces no entry. An added or removed table
 *    is reported as a canonical copy of the table whose foreign keys are in the model's
 *    foreign-key order, so the caller's array order never leaks into the result.
 * 2. A changed table reports its members in this exact order: columns removed (baseline
 *    column order), columns added (target column order), columns changed (target column
 *    order, with only the scalar fields that differ, in the fixed order `type`, `notNull`,
 *    `default`, plus the column's identity change when it has one); then at most one
 *    primary-key addition, removal, or change; then foreign keys
 *    removed, added, and changed, each sorted in the model's foreign-key order (referencing
 *    columns element-wise, referenced table schema then name, then name, absent first — an
 *    absent name sorts before any present one, including the empty string, which remains a
 *    distinct, later entry). Changed pairs are ordered by their baseline foreign key in that
 *    order, then by their target foreign key the same way.
 * 3. Columns are never sorted: column entries keep the stored source order of the side they
 *    come from, as point 2 describes, and no entry states a column's position. A table with no
 *    reported changes is therefore not necessarily structurally identical to its counterpart:
 *    the two may store their columns in different orders.
 * 4. Sequence identities are merge-walked the same way, after every table change, and reported
 *    as a group in identity order: a baseline-only identity is `sequence-removed`, a target-only
 *    identity `sequence-added`, and a shared identity is compared on effective option values.
 *    A changed sequence reports only the fields that differ, in the fixed order `dataType`,
 *    `increment`, `minValue`, `maxValue`, `start`, `cache`, `cycle`, `ownedBy`; with a
 *    `dataType` change, `minValue`/`maxValue` compare the bounds the engine's `AS` conversion
 *    would leave, so a bound that only differs from the target after the conversion is still
 *    reported.
 *
 * Duplicate foreign-key identities — several constraints with the same referencing columns
 * and referenced table — pair structurally identical foreign keys first, then pair the rest
 * after sorting each side by referenced columns (element-wise), then by name, `onUpdate`, and
 * `onDelete`, each presence-aware: absent sorts first, then present values compare as strings,
 * so an absent name precedes the empty string, which remains a distinct, later entry.
 * Leftovers are reported as removals and additions. Structurally equal models therefore
 * produce identical output no matter how their arrays were built.
 *
 * Returned payloads are independent copies: mutating a payload never affects the caller's
 * models, and `diff` never mutates its inputs.
 */

/** One difference at the table level: a table added, removed, or changed. */
export type Change =
  /** The target has a table the baseline does not. */
  | { kind: 'table-added'; table: Table }
  /** The baseline has a table the target does not. */
  | { kind: 'table-removed'; table: Table }
  /** Both sides have the table, and at least one of its members differs. */
  | { kind: 'table-changed'; table: TableIdentity; changes: readonly TableChange[] }
  /** The target has a sequence the baseline does not. */
  | { kind: 'sequence-added'; sequence: Sequence }
  /** The baseline has a sequence the target does not. */
  | { kind: 'sequence-removed'; sequence: Sequence }
  /** Both sides have the sequence, and at least one of its options differs. */
  | {
      kind: 'sequence-changed';
      sequence: SequenceIdentity;
      changes: readonly SequenceFieldChange[];
    };

/** One difference within a changed table. */
export type TableChange =
  /** A column only the target has. */
  | { kind: 'column-added'; column: Column }
  /** A column only the baseline has. */
  | { kind: 'column-removed'; column: Column }
  /**
   * A column both sides have with differing fields: the scalar fields, plus the identity
   * difference when the column's identity differs.
   */
  | {
      kind: 'column-changed';
      name: string;
      fields: readonly ColumnFieldChange[];
      identity?: IdentityChange;
    }
  /** The target has a primary key the baseline does not. */
  | { kind: 'primary-key-added'; primaryKey: PrimaryKey }
  /** The baseline has a primary key the target does not. */
  | { kind: 'primary-key-removed'; primaryKey: PrimaryKey }
  /** Both sides have a primary key, and its name or column list differs. */
  | { kind: 'primary-key-changed'; before: PrimaryKey; after: PrimaryKey }
  /** A foreign key only the target has. */
  | { kind: 'foreign-key-added'; foreignKey: ForeignKey }
  /** A foreign key only the baseline has. */
  | { kind: 'foreign-key-removed'; foreignKey: ForeignKey }
  /** A matched foreign key pair with any difference. */
  | { kind: 'foreign-key-changed'; before: ForeignKey; after: ForeignKey };

/**
 * One differing scalar field of a changed column; only fields that differ are reported, in
 * the fixed order `type`, `notNull`, `default`. A `default` change omits the side that has no
 * `DEFAULT`. A column's identity is not a scalar field: it travels as the `identity` part of
 * the `column-changed` entry.
 */
export type ColumnFieldChange =
  | { field: 'type'; before: string; after: string }
  | { field: 'notNull'; before: boolean; after: boolean }
  | { field: 'default'; before?: string; after?: string };

/**
 * One differing option of a changed identity; only options that differ are reported, in the
 * fixed order `generated`, `increment`, `minValue`, `maxValue`, `start`, `cache`, `cycle`.
 * The sequence name is never a field: it compares only when both sides state one, and a
 * stated mismatch recreates the identity. A `minValue`/`maxValue` change reports the value in
 * effect after the column's integer-type change — the engine rewrites a bound equal to the
 * old type's bound to the new type's — as `before`, flagged `converted` when the conversion
 * is what produced it, so a bound the target restores after that conversion is still reported
 * and never reads as an as-written baseline value.
 */
export type IdentityFieldChange =
  | { field: 'generated'; before: IdentityGeneration; after: IdentityGeneration }
  | { field: 'increment'; before: string; after: string }
  | { field: 'minValue'; before: string; after: string; converted?: boolean }
  | { field: 'maxValue'; before: string; after: string; converted?: boolean }
  | { field: 'start'; before: string; after: string }
  | { field: 'cache'; before: string; after: string }
  | { field: 'cycle'; before: boolean; after: boolean };

/**
 * One column's identity difference. `added` and `removed` carry the one descriptor; a
 * `recreated` carries the target descriptor when both sides state sequence names that differ,
 * and the plan replaces the whole identity; `changed` carries only the differing options.
 */
export type IdentityChange =
  | { kind: 'added'; identity: Identity }
  | { kind: 'removed'; identity: Identity }
  | { kind: 'recreated'; identity: Identity }
  | { kind: 'changed'; fields: readonly IdentityFieldChange[] };

/**
 * One differing option of a changed sequence; only fields that differ are reported, in the
 * fixed order `dataType`, `increment`, `minValue`, `maxValue`, `start`, `cache`, `cycle`,
 * `ownedBy`. A `minValue`/`maxValue` change reports the value in effect after the step's
 * `dataType` change — the engine rewrites a bound equal to the old type's bound to the new
 * type's — as `before`, flagged `converted` when the conversion is what produced it, so a
 * bound the target restores after that conversion is still reported and never reads as an
 * as-written baseline value. An `ownedBy` change omits the side that has no owner.
 */
export type SequenceFieldChange =
  | { field: 'dataType'; before: SequenceDataType; after: SequenceDataType }
  | { field: 'increment'; before: string; after: string }
  | { field: 'minValue'; before: string; after: string; converted?: boolean }
  | { field: 'maxValue'; before: string; after: string; converted?: boolean }
  | { field: 'start'; before: string; after: string }
  | { field: 'cache'; before: string; after: string }
  | { field: 'cycle'; before: boolean; after: boolean }
  | { field: 'ownedBy'; before?: SequenceOwner; after?: SequenceOwner };

/**
 * The changes from `baseline` to `target`, in the module's deterministic order. Returned
 * payloads are independent copies: mutating them never affects the caller's models, and
 * neither input is mutated.
 */
export function diff(baseline: Model, target: Model): readonly Change[] {
  const baselineTables = [...baseline.tables].sort(compareTables);
  const targetTables = [...target.tables].sort(compareTables);

  const changes: Change[] = [];
  let baselineIndex = 0;
  let targetIndex = 0;

  while (baselineIndex < baselineTables.length && targetIndex < targetTables.length) {
    const baselineTable = baselineTables[baselineIndex]!;
    const targetTable = targetTables[targetIndex]!;
    const comparison = compareTables(baselineTable, targetTable);
    if (comparison < 0) {
      changes.push({ kind: 'table-removed', table: copyTable(baselineTable) });
      baselineIndex += 1;
    } else if (comparison > 0) {
      changes.push({ kind: 'table-added', table: copyTable(targetTable) });
      targetIndex += 1;
    } else {
      const tableChanges = diffTable(baselineTable, targetTable);
      if (tableChanges.length > 0) {
        changes.push({
          kind: 'table-changed',
          table: { schema: baselineTable.schema, name: baselineTable.name },
          changes: tableChanges,
        });
      }
      baselineIndex += 1;
      targetIndex += 1;
    }
  }

  for (; baselineIndex < baselineTables.length; baselineIndex += 1) {
    changes.push({ kind: 'table-removed', table: copyTable(baselineTables[baselineIndex]!) });
  }
  for (; targetIndex < targetTables.length; targetIndex += 1) {
    changes.push({ kind: 'table-added', table: copyTable(targetTables[targetIndex]!) });
  }

  return [...changes, ...diffSequences(baseline, target)];
}

/**
 * The sequence group of the diff, in identity order. Sequences compare on effective option
 * values: both sides normalize through `effectiveSequence`, so an omitted option and its
 * explicit default are not a change, and reported payloads are effective sequences.
 */
function diffSequences(baseline: Model, target: Model): readonly Change[] {
  const baselineSequences = [...baseline.sequences].sort(compareSequences).map(effectiveSequence);
  const targetSequences = [...target.sequences].sort(compareSequences).map(effectiveSequence);

  const changes: Change[] = [];
  let baselineIndex = 0;
  let targetIndex = 0;

  while (baselineIndex < baselineSequences.length && targetIndex < targetSequences.length) {
    const baselineSequence = baselineSequences[baselineIndex]!;
    const targetSequence = targetSequences[targetIndex]!;
    const comparison = compareSequences(baselineSequence, targetSequence);
    if (comparison < 0) {
      changes.push({ kind: 'sequence-removed', sequence: copySequence(baselineSequence) });
      baselineIndex += 1;
    } else if (comparison > 0) {
      changes.push({ kind: 'sequence-added', sequence: copySequence(targetSequence) });
      targetIndex += 1;
    } else {
      const fields = diffSequenceFields(baselineSequence, targetSequence);
      if (fields.length > 0) {
        changes.push({
          kind: 'sequence-changed',
          sequence: { schema: baselineSequence.schema, name: baselineSequence.name },
          changes: fields,
        });
      }
      baselineIndex += 1;
      targetIndex += 1;
    }
  }

  for (; baselineIndex < baselineSequences.length; baselineIndex += 1) {
    changes.push({
      kind: 'sequence-removed',
      sequence: copySequence(baselineSequences[baselineIndex]!),
    });
  }
  for (; targetIndex < targetSequences.length; targetIndex += 1) {
    changes.push({ kind: 'sequence-added', sequence: copySequence(targetSequences[targetIndex]!) });
  }

  return changes;
}

function diffSequenceFields(baseline: Sequence, target: Sequence): SequenceFieldChange[] {
  const fields: SequenceFieldChange[] = [];
  const dataTypeChanged = baseline.dataType !== target.dataType;
  if (dataTypeChanged) {
    fields.push({ field: 'dataType', before: baseline.dataType, after: target.dataType });
  }
  if (baseline.increment !== target.increment) {
    fields.push({ field: 'increment', before: baseline.increment, after: target.increment });
  }
  // With a data type change, the bounds the step lands on without explicit clauses are the
  // ones the engine's `AS` conversion leaves, not the baseline's: a bound equal to the old
  // type's bound becomes the new type's. Compare against those so the plan restates a bound
  // the conversion would otherwise move, and flag a rewritten bound as converted so no output
  // presents it as the as-written baseline value.
  const converted = dataTypeChanged
    ? sequenceTypeChange(baseline.dataType, baseline.minValue, baseline.maxValue, target.dataType)
    : {
        minValue: baseline.minValue,
        maxValue: baseline.maxValue,
        resetMin: false,
        resetMax: false,
      };
  if (converted.minValue !== target.minValue) {
    fields.push({
      field: 'minValue',
      before: converted.minValue,
      after: target.minValue,
      ...(converted.resetMin ? { converted: true } : {}),
    });
  }
  if (converted.maxValue !== target.maxValue) {
    fields.push({
      field: 'maxValue',
      before: converted.maxValue,
      after: target.maxValue,
      ...(converted.resetMax ? { converted: true } : {}),
    });
  }
  if (baseline.start !== target.start) {
    fields.push({ field: 'start', before: baseline.start, after: target.start });
  }
  if (baseline.cache !== target.cache) {
    fields.push({ field: 'cache', before: baseline.cache, after: target.cache });
  }
  if (baseline.cycle !== target.cycle) {
    fields.push({ field: 'cycle', before: baseline.cycle, after: target.cycle });
  }
  if (!sameOwner(baseline.ownedBy, target.ownedBy)) {
    fields.push({
      field: 'ownedBy',
      ...(baseline.ownedBy === undefined ? {} : { before: copyOwner(baseline.ownedBy) }),
      ...(target.ownedBy === undefined ? {} : { after: copyOwner(target.ownedBy) }),
    });
  }
  return fields;
}

/** Whether two optional owners name the same table and column. */
function sameOwner(left: SequenceOwner | undefined, right: SequenceOwner | undefined): boolean {
  if (left === undefined) return right === undefined;
  if (right === undefined) return false;
  return sameIdentity(left.table, right.table) && left.column === right.column;
}

/** Whether both identities name the same table. */
function sameIdentity(left: TableIdentity, right: TableIdentity): boolean {
  return left.schema === right.schema && left.name === right.name;
}

/** A copy of `column`, independent of the caller's model, nested identity included. */
function copyColumn(column: Column): Column {
  return {
    ...column,
    ...(column.identity === undefined ? {} : { identity: copyIdentity(column.identity) }),
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
    referencedTable: { ...foreignKey.referencedTable },
    referencedColumns: [...foreignKey.referencedColumns],
  };
}

/** A copy of `owner`, independent of the caller's model. */
function copyOwner(owner: SequenceOwner): SequenceOwner {
  return { table: { ...owner.table }, column: owner.column };
}

/** A copy of `sequence`, independent of the caller's model. */
function copySequence(sequence: Sequence): Sequence {
  return {
    ...sequence,
    ...(sequence.ownedBy === undefined ? {} : { ownedBy: copyOwner(sequence.ownedBy) }),
  };
}

/**
 * A copy of `table`, independent of the caller's model, whose foreign keys are in canonical
 * order: the model's foreign-key order, ties on it broken by the duplicate-pairing order.
 * Added and removed tables are reported this way, so the caller's `foreignKeys` array order
 * cannot leak into the result.
 */
function copyTable(table: Table): Table {
  return {
    ...table,
    columns: table.columns.map(copyColumn),
    ...(table.primaryKey === undefined ? {} : { primaryKey: copyPrimaryKey(table.primaryKey) }),
    foreignKeys: [...table.foreignKeys].sort(compareForeignKeysCanonically).map(copyForeignKey),
  };
}

/** One matched foreign-key pair, remembered with both sides for a change entry. */
interface ForeignKeyPair {
  readonly before: ForeignKey;
  readonly after: ForeignKey;
}

function diffTable(baseline: Table, target: Table): TableChange[] {
  const changes = diffColumns(baseline.columns, target.columns);
  const primaryKey = diffPrimaryKey(baseline.primaryKey, target.primaryKey);
  if (primaryKey !== undefined) changes.push(primaryKey);
  changes.push(...diffForeignKeys(baseline.foreignKeys, target.foreignKeys));
  return changes;
}

function diffColumns(baseline: readonly Column[], target: readonly Column[]): TableChange[] {
  const changes: TableChange[] = [];
  const baselineColumns = indexColumns(baseline);
  const targetColumns = indexColumns(target);

  for (const column of baseline) {
    if (!targetColumns.has(column.name)) {
      changes.push({ kind: 'column-removed', column: copyColumn(column) });
    }
  }
  for (const column of target) {
    if (!baselineColumns.has(column.name)) {
      changes.push({ kind: 'column-added', column: copyColumn(column) });
    }
  }
  for (const column of target) {
    const before = baselineColumns.get(column.name);
    if (before === undefined) continue;
    const fields = diffColumnFields(before, column);
    const identity = diffIdentity(before, column);
    if (fields.length > 0 || identity !== undefined) {
      changes.push({
        kind: 'column-changed',
        name: column.name,
        fields,
        ...(identity === undefined ? {} : { identity }),
      });
    }
  }

  return changes;
}

function diffColumnFields(baseline: Column, target: Column): ColumnFieldChange[] {
  const fields: ColumnFieldChange[] = [];
  if (baseline.type !== target.type) {
    fields.push({ field: 'type', before: baseline.type, after: target.type });
  }
  if (baseline.notNull !== target.notNull) {
    fields.push({ field: 'notNull', before: baseline.notNull, after: target.notNull });
  }
  if (baseline.default !== target.default) {
    fields.push({
      field: 'default',
      ...(baseline.default === undefined ? {} : { before: baseline.default }),
      ...(target.default === undefined ? {} : { after: target.default }),
    });
  }
  return fields;
}

/**
 * The identity difference of a pair of columns, or `undefined` when the identities compare
 * equal. The sequence name compares only when both sides state one: a stated mismatch is a
 * recreation, and a name absent on either side is a don't-care.
 */
function diffIdentity(baseline: Column, target: Column): IdentityChange | undefined {
  const before = baseline.identity;
  const after = target.identity;
  if (before === undefined) {
    return after === undefined ? undefined : { kind: 'added', identity: copyIdentity(after) };
  }
  if (after === undefined) {
    return { kind: 'removed', identity: copyIdentity(before) };
  }
  if (!sameIdentityName(before.sequenceName, after.sequenceName)) {
    return { kind: 'recreated', identity: copyIdentity(after) };
  }
  const fields = diffIdentityFields(baseline.type, target.type, before, after);
  return fields.length === 0 ? undefined : { kind: 'changed', fields };
}

/**
 * The differing options of two identities, in the fixed order `generated`, `increment`,
 * `minValue`, `maxValue`, `start`, `cache`, `cycle`. When the column's type change crosses
 * canonical integer types, the bounds compare against the ones the engine's `AS` conversion
 * would leave, and a rewritten bound is flagged `converted`.
 */
function diffIdentityFields(
  baselineType: string,
  targetType: string,
  baseline: Identity,
  target: Identity,
): IdentityFieldChange[] {
  const fields: IdentityFieldChange[] = [];
  if (baseline.generated !== target.generated) {
    fields.push({ field: 'generated', before: baseline.generated, after: target.generated });
  }
  if (baseline.increment !== target.increment) {
    fields.push({ field: 'increment', before: baseline.increment, after: target.increment });
  }
  const baselineIntType = canonicalIntType(baselineType);
  const targetIntType = canonicalIntType(targetType);
  const converted =
    baselineIntType !== undefined &&
    targetIntType !== undefined &&
    baselineIntType !== targetIntType
      ? sequenceTypeChange(baselineIntType, baseline.minValue, baseline.maxValue, targetIntType)
      : {
          minValue: baseline.minValue,
          maxValue: baseline.maxValue,
          resetMin: false,
          resetMax: false,
        };
  if (converted.minValue !== target.minValue) {
    fields.push({
      field: 'minValue',
      before: converted.minValue,
      after: target.minValue,
      ...(converted.resetMin ? { converted: true } : {}),
    });
  }
  if (converted.maxValue !== target.maxValue) {
    fields.push({
      field: 'maxValue',
      before: converted.maxValue,
      after: target.maxValue,
      ...(converted.resetMax ? { converted: true } : {}),
    });
  }
  if (baseline.start !== target.start) {
    fields.push({ field: 'start', before: baseline.start, after: target.start });
  }
  if (baseline.cache !== target.cache) {
    fields.push({ field: 'cache', before: baseline.cache, after: target.cache });
  }
  if (baseline.cycle !== target.cycle) {
    fields.push({ field: 'cycle', before: baseline.cycle, after: target.cycle });
  }
  return fields;
}

/**
 * Whether two optional identity sequence names state the same name. A side that states none
 * is a don't-care: only two stated names can differ.
 */
function sameIdentityName(
  left: SequenceIdentity | undefined,
  right: SequenceIdentity | undefined,
): boolean {
  if (left === undefined || right === undefined) return true;
  return left.schema === right.schema && left.name === right.name;
}

/**
 * A copy of `identity`, independent of the caller's model. The descriptor is never mutated,
 * so only the optional nested sequence name needs its own copy.
 */
function copyIdentity(identity: Identity): Identity {
  return {
    ...identity,
    ...(identity.sequenceName === undefined ? {} : { sequenceName: { ...identity.sequenceName } }),
  };
}

function diffPrimaryKey(
  baseline: PrimaryKey | undefined,
  target: PrimaryKey | undefined,
): TableChange | undefined {
  if (baseline === undefined) {
    return target === undefined
      ? undefined
      : { kind: 'primary-key-added', primaryKey: copyPrimaryKey(target) };
  }
  if (target === undefined) {
    return { kind: 'primary-key-removed', primaryKey: copyPrimaryKey(baseline) };
  }
  if (baseline.name === target.name && sameStrings(baseline.columns, target.columns)) {
    return undefined;
  }
  return {
    kind: 'primary-key-changed',
    before: copyPrimaryKey(baseline),
    after: copyPrimaryKey(target),
  };
}

function diffForeignKeys(
  baseline: readonly ForeignKey[],
  target: readonly ForeignKey[],
): TableChange[] {
  const baselineGroups = groupForeignKeys(baseline);
  const targetGroups = groupForeignKeys(target);

  const removed: ForeignKey[] = [];
  const added: ForeignKey[] = [];
  const changed: ForeignKeyPair[] = [];

  const identities = new Set([...baselineGroups.keys(), ...targetGroups.keys()]);
  for (const identity of identities) {
    const remainingBaseline = [...(baselineGroups.get(identity) ?? [])];
    const remainingTarget: ForeignKey[] = [];

    // Structurally identical foreign keys cancel; only the rest is paired by order.
    for (const after of targetGroups.get(identity) ?? []) {
      const match = remainingBaseline.findIndex((before) => foreignKeysEqual(before, after));
      if (match === -1) remainingTarget.push(after);
      else remainingBaseline.splice(match, 1);
    }

    // What remains pairs positionally, ordered so the caller's array order never decides.
    remainingBaseline.sort(compareForeignKeyPairing);
    remainingTarget.sort(compareForeignKeyPairing);
    const paired = Math.min(remainingBaseline.length, remainingTarget.length);
    for (let index = 0; index < paired; index += 1) {
      changed.push({ before: remainingBaseline[index]!, after: remainingTarget[index]! });
    }
    removed.push(...remainingBaseline.slice(paired));
    added.push(...remainingTarget.slice(paired));
  }

  removed.sort(compareForeignKeys);
  added.sort(compareForeignKeys);
  changed.sort(compareForeignKeyChanges);

  return [
    ...removed.map((foreignKey): TableChange => ({
      kind: 'foreign-key-removed',
      foreignKey: copyForeignKey(foreignKey),
    })),
    ...added.map((foreignKey): TableChange => ({
      kind: 'foreign-key-added',
      foreignKey: copyForeignKey(foreignKey),
    })),
    ...changed.map((pair): TableChange => ({
      kind: 'foreign-key-changed',
      before: copyForeignKey(pair.before),
      after: copyForeignKey(pair.after),
    })),
  ];
}

function indexColumns(columns: readonly Column[]): Map<string, Column> {
  const index = new Map<string, Column>();
  for (const column of columns) index.set(column.name, column);
  return index;
}

function groupForeignKeys(foreignKeys: readonly ForeignKey[]): Map<string, ForeignKey[]> {
  const groups = new Map<string, ForeignKey[]>();
  for (const foreignKey of [...foreignKeys].sort(compareForeignKeys)) {
    const identity = foreignKeyIdentity(foreignKey);
    const group = groups.get(identity);
    if (group === undefined) groups.set(identity, [foreignKey]);
    else group.push(foreignKey);
  }
  return groups;
}

/**
 * The matching key of a foreign key: its referencing columns and referenced table. JSON
 * encoding keeps names — which may contain any character — unambiguous across the parts.
 */
function foreignKeyIdentity(foreignKey: ForeignKey): string {
  return JSON.stringify([
    foreignKey.columns,
    foreignKey.referencedTable.schema,
    foreignKey.referencedTable.name,
  ]);
}

function foreignKeysEqual(left: ForeignKey, right: ForeignKey): boolean {
  return (
    left.name === right.name &&
    sameStrings(left.columns, right.columns) &&
    left.referencedTable.schema === right.referencedTable.schema &&
    left.referencedTable.name === right.referencedTable.name &&
    sameStrings(left.referencedColumns, right.referencedColumns) &&
    left.onUpdate === right.onUpdate &&
    left.onDelete === right.onDelete
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareTables(left: TableIdentity, right: TableIdentity): number {
  return compareStrings(left.schema, right.schema) || compareStrings(left.name, right.name);
}

function compareSequences(left: SequenceIdentity, right: SequenceIdentity): number {
  return compareStrings(left.schema, right.schema) || compareStrings(left.name, right.name);
}

function compareForeignKeys(left: ForeignKey, right: ForeignKey): number {
  return (
    compareStringArrays(left.columns, right.columns) ||
    compareStrings(left.referencedTable.schema, right.referencedTable.schema) ||
    compareStrings(left.referencedTable.name, right.referencedTable.name) ||
    compareOptionalStrings(left.name, right.name)
  );
}

/**
 * The canonical order of a copied `foreignKeys` array: the model's foreign-key order, ties on
 * it — foreign keys differing only in referenced columns or actions — broken by the
 * duplicate-pairing order. Both comparators are shared with the rest of the module.
 */
function compareForeignKeysCanonically(left: ForeignKey, right: ForeignKey): number {
  return compareForeignKeys(left, right) || compareForeignKeyPairing(left, right);
}

/**
 * The pairing order for unmatched duplicates: referenced columns element-wise, then `name`,
 * `onUpdate`, and `onDelete`, each ordered by presence — absent first — and then by value.
 * Structurally identical foreign keys have already cancelled, so this full chain decides
 * which remaining baseline foreign key pairs with which remaining target foreign key.
 */
function compareForeignKeyPairing(left: ForeignKey, right: ForeignKey): number {
  return (
    compareStringArrays(left.referencedColumns, right.referencedColumns) ||
    compareOptionalStrings(left.name, right.name) ||
    compareOptionalStrings(left.onUpdate, right.onUpdate) ||
    compareOptionalStrings(left.onDelete, right.onDelete)
  );
}

/**
 * Orders changed pairs by their baseline foreign key in the model's foreign-key order, then
 * by their target foreign key the same way, so each pair has one deterministic position even
 * when its two sides would order differently.
 */
function compareForeignKeyChanges(left: ForeignKeyPair, right: ForeignKeyPair): number {
  return (
    compareForeignKeys(left.before, right.before) || compareForeignKeys(left.after, right.after)
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Orders optional strings by presence first — absent before present — then by value, so
 * `undefined` sorts before every string, including `''`.
 */
function compareOptionalStrings(left: string | undefined, right: string | undefined): number {
  if (left === undefined) return right === undefined ? 0 : -1;
  if (right === undefined) return 1;
  return compareStrings(left, right);
}

function compareStringArrays(left: readonly string[], right: readonly string[]): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const comparison = compareStrings(left[index]!, right[index]!);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

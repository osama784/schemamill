import type { Column, ForeignKey, Model, PrimaryKey, Table, TableIdentity } from './model.ts';

/**
 * The diff: what changed between a baseline model and a target model.
 *
 * `diff` compares two models and reports one change per added, removed, or changed table,
 * column, primary key, or foreign key. It never guesses a rename: a table or column under a
 * new name is a removal and an addition, a primary key with a different column list is a
 * primary-key change, and a foreign key pointing at a different table is a removal and an
 * addition.
 *
 * Identity is the model's identity. A table is its schema and name; a column is its name
 * within its table; a table has at most one primary key, compared by its name and its column
 * list; two foreign keys belong together when their referencing columns (order-sensitive) and
 * their referenced table are the same, and any other difference — name, referenced columns,
 * actions — reads as a change to that pair.
 *
 * Text is compared exactly as stored. Core never normalizes or lexes SQL: import
 * whitespace-normalizes at the boundary, so even a difference in whitespace is a change.
 * Names are case-sensitive.
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
 *    order, with only the fields that differ, in the fixed order `type`, `notNull`,
 *    `default`); then at most one primary-key addition, removal, or change; then foreign keys
 *    removed, added, and changed, each sorted in the model's foreign-key order (referencing
 *    columns element-wise, referenced table schema then name, then `name ?? ''`). Changed
 *    pairs are ordered by their baseline foreign key in that order, then by their target
 *    foreign key the same way.
 * 3. Columns are never sorted: column entries keep the stored source order of the side they
 *    come from, as point 2 describes, and no entry states a column's position.
 *
 * Duplicate foreign-key identities — several constraints with the same referencing columns
 * and referenced table — pair structurally identical foreign keys first, then pair the rest
 * after sorting each side by referenced columns (element-wise), `name ?? ''`, `onUpdate ?? ''`,
 * then `onDelete ?? ''`; leftovers are reported as removals and additions. Structurally equal
 * models therefore produce identical output no matter how their arrays were built.
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
  | { kind: 'table-changed'; table: TableIdentity; changes: readonly TableChange[] };

/** One difference within a changed table. */
export type TableChange =
  /** A column only the target has. */
  | { kind: 'column-added'; column: Column }
  /** A column only the baseline has. */
  | { kind: 'column-removed'; column: Column }
  /** A column both sides have with differing fields. */
  | { kind: 'column-changed'; name: string; fields: readonly ColumnFieldChange[] }
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
 * One differing field of a changed column; only fields that differ are reported. A
 * `default` change omits the side that has no `DEFAULT`.
 */
export type ColumnFieldChange =
  | { field: 'type'; before: string; after: string }
  | { field: 'notNull'; before: boolean; after: boolean }
  | { field: 'default'; before?: string; after?: string };

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

  return changes;
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
    referencedTable: { ...foreignKey.referencedTable },
    referencedColumns: [...foreignKey.referencedColumns],
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
    if (fields.length > 0) changes.push({ kind: 'column-changed', name: column.name, fields });
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

function compareForeignKeys(left: ForeignKey, right: ForeignKey): number {
  return (
    compareStringArrays(left.columns, right.columns) ||
    compareStrings(left.referencedTable.schema, right.referencedTable.schema) ||
    compareStrings(left.referencedTable.name, right.referencedTable.name) ||
    compareStrings(left.name ?? '', right.name ?? '')
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
 * The pairing order for unmatched duplicates: referenced columns element-wise, then
 * `name ?? ''`, then `onUpdate ?? ''`, then `onDelete ?? ''`. Structurally identical foreign
 * keys have already cancelled, so this full chain decides which remaining baseline foreign
 * key pairs with which remaining target foreign key.
 */
function compareForeignKeyPairing(left: ForeignKey, right: ForeignKey): number {
  return (
    compareStringArrays(left.referencedColumns, right.referencedColumns) ||
    compareStrings(left.name ?? '', right.name ?? '') ||
    compareStrings(left.onUpdate ?? '', right.onUpdate ?? '') ||
    compareStrings(left.onDelete ?? '', right.onDelete ?? '')
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

function compareStringArrays(left: readonly string[], right: readonly string[]): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const comparison = compareStrings(left[index]!, right[index]!);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

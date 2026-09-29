import assert from 'node:assert/strict';
import { test } from 'node:test';

import { plan } from './index.ts';
import type {
  Column,
  ForeignKey,
  Model,
  PrimaryKey,
  Sequence,
  SequenceOwner,
  Table,
  TableIdentity,
} from './model.ts';
import type { Step } from './plan.ts';

/**
 * Tests for the migration plan: the six global phases with the nine table phases at their
 * center, dependency-ordered table drops, cycle breaking, primary-key changes that set
 * surviving foreign keys aside, sequence ownership detaches and drop suppression, determinism,
 * and a dependency-invariant simulator run over hand-built cases and seeded pseudo-random model
 * pairs. Builders keep the fixtures small; expected values are complete steps, asserted with
 * `deepStrictEqual`.
 */

/** A table identity: `public` unless another schema is given. */
const identity = (name: string, schema = 'public'): TableIdentity => ({ schema, name });

/** A column named `name`: `text` and nullable unless overridden. */
const column = (name: string, fields: Partial<Omit<Column, 'name'>> = {}): Column => ({
  name,
  type: 'text',
  notNull: false,
  ...fields,
});

interface TableParts {
  schema?: string;
  columns?: readonly Column[];
  primaryKey?: PrimaryKey;
  foreignKeys?: readonly ForeignKey[];
}

/** A table with the given identity: empty unless parts are supplied. */
const table = (name: string, parts: TableParts = {}): Table => ({
  schema: parts.schema ?? 'public',
  name,
  columns: parts.columns ?? [],
  ...(parts.primaryKey === undefined ? {} : { primaryKey: parts.primaryKey }),
  foreignKeys: parts.foreignKeys ?? [],
});

/** A table with an `integer` primary key column `id` and the given extra members. */
const idTable = (
  name: string,
  columns: readonly Column[] = [],
  foreignKeys: readonly ForeignKey[] = [],
): Table =>
  table(name, {
    columns: [column('id', { type: 'integer', notNull: true }), ...columns],
    primaryKey: { name: `${name}_pkey`, columns: ['id'] },
    foreignKeys,
  });

/** A foreign key on `columns`: unnamed with no referenced columns unless overridden. */
const foreignKey = (
  columns: readonly string[],
  referencedTable: TableIdentity,
  rest: Partial<Omit<ForeignKey, 'columns' | 'referencedTable'>> = {},
): ForeignKey => ({
  columns,
  referencedTable,
  referencedColumns: [],
  ...rest,
});

/** A named foreign key on `columnName` referencing the `id` column of table `to`. */
const idForeignKey = (from: string, columnName: string, to: string): ForeignKey =>
  foreignKey([columnName], identity(to), {
    name: `${from}_${columnName}_fkey`,
    referencedColumns: ['id'],
  });

/** A model of the given tables. */
const model = (...tables: Table[]): Model => ({ tables, sequences: [] });

/** A sequence named `name`: bigint ascending defaults unless overridden. */
const sequence = (
  name: string,
  fields: Partial<Omit<Sequence, 'schema' | 'name'>> = {},
  schema = 'public',
): Sequence => ({
  schema,
  name,
  dataType: 'bigint',
  increment: '1',
  minValue: '1',
  maxValue: '9223372036854775807',
  start: '1',
  cache: '1',
  cycle: false,
  ...fields,
});

/** An owner of table `table`'s column `column`, `public` unless a schema is given. */
const owner = (table: string, column: string, schema = 'public'): SequenceOwner => ({
  table: { schema, name: table },
  column,
});

/** A copy of `value` without its `ownedBy`, the shape `create-sequence` steps carry. */
const unowned = (value: Sequence): Sequence => ({
  schema: value.schema,
  name: value.name,
  dataType: value.dataType,
  increment: value.increment,
  minValue: value.minValue,
  maxValue: value.maxValue,
  start: value.start,
  cache: value.cache,
  cycle: value.cycle,
});

/** A model of the given sequences, with no tables unless they are supplied. */
const sequenceModel = (sequences: readonly Sequence[], ...tables: Table[]): Model => ({
  tables,
  sequences,
});

/** Asserts that planning `baseline` to `target` yields exactly `expected`. */
const assertPlan = (baseline: Model, target: Model, expected: readonly Step[]): void => {
  assert.deepStrictEqual(plan(baseline, target), { steps: expected });
};

/** Freezes `value` and every object and array nested inside it. */
const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
};

/**
 * The dependency-invariant simulator. It replays a plan against the baseline's live tables,
 * columns, primary keys, and foreign keys and fails when a step would be illegal there:
 *
 * - a `drop-table` fails while another live table holds a live foreign key referencing it;
 * - a `drop-primary-key` fails while a live foreign key references one of the key's columns;
 * - a `drop-column` fails while a live foreign key uses the column or references it.
 *
 * Add and alter steps update the simulated state, so the end state is compared with the target
 * table by table and constraint by constraint. Every removed table must be dropped exactly
 * once and every added table created exactly once.
 */

/** The mutable shape of a model payload: the model types are readonly, the state is not. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** A live table in the simulated state: columns by name, plus its constraints. */
interface SimulatedTable {
  readonly columns: Map<string, Mutable<Column>>;
  primaryKey: Mutable<PrimaryKey> | undefined;
  readonly foreignKeys: Mutable<ForeignKey>[];
}

/** The simulated database state: live tables by JSON-encoded identity. */
interface SimulatedState {
  readonly tables: Map<string, SimulatedTable>;
}

/** The map key of a table identity; JSON keeps any characters unambiguous. */
const keyOf = (identity: TableIdentity): string => JSON.stringify([identity.schema, identity.name]);

/** Whether both identities name the same table. */
const sameIdentity = (left: TableIdentity, right: TableIdentity): boolean =>
  left.schema === right.schema && left.name === right.name;

/** A copy of `primaryKey`, independent of the caller's model. */
const copyPrimaryKey = (primaryKey: PrimaryKey): Mutable<PrimaryKey> => ({
  ...primaryKey,
  columns: [...primaryKey.columns],
});

/** A copy of `foreignKey`, independent of the caller's model. */
const copyForeignKey = (foreignKey: ForeignKey): Mutable<ForeignKey> => ({
  ...foreignKey,
  columns: [...foreignKey.columns],
  referencedTable: { ...foreignKey.referencedTable },
  referencedColumns: [...foreignKey.referencedColumns],
});

/** A structural key for a foreign key, comparing every field including absent ones. */
const foreignKeyKey = (foreignKey: ForeignKey): string =>
  JSON.stringify([
    foreignKey.name ?? null,
    foreignKey.columns,
    foreignKey.referencedTable.schema,
    foreignKey.referencedTable.name,
    foreignKey.referencedColumns,
    foreignKey.onUpdate ?? null,
    foreignKey.onDelete ?? null,
  ]);

/** The simulated state of `model`. */
const stateOf = (model: Model): SimulatedState => {
  const tables = new Map<string, SimulatedTable>();
  for (const source of model.tables) {
    tables.set(keyOf(source), {
      columns: new Map(source.columns.map((entry) => [entry.name, { ...entry }])),
      primaryKey: source.primaryKey === undefined ? undefined : copyPrimaryKey(source.primaryKey),
      foreignKeys: source.foreignKeys.map(copyForeignKey),
    });
  }
  return { tables };
};

/**
 * The columns a live foreign key references: its own list, or the referenced table's live
 * primary key when the source omitted them.
 */
const referencedColumnsOf = (foreignKey: ForeignKey, state: SimulatedState): readonly string[] => {
  if (foreignKey.referencedColumns.length > 0) return foreignKey.referencedColumns;
  return state.tables.get(keyOf(foreignKey.referencedTable))?.primaryKey?.columns ?? [];
};

/** Applies one step to `state`, failing the test when the step is illegal there. */
const applyStep = (state: SimulatedState, step: Step): void => {
  switch (step.kind) {
    case 'create-table': {
      const key = keyOf(step.table);
      assert.equal(state.tables.has(key), false, `create-table of live table ${key}`);
      state.tables.set(key, {
        columns: new Map(step.table.columns.map((entry) => [entry.name, { ...entry }])),
        primaryKey:
          step.table.primaryKey === undefined ? undefined : copyPrimaryKey(step.table.primaryKey),
        foreignKeys: [],
      });
      return;
    }
    case 'drop-table': {
      const key = keyOf(step.table);
      assert.ok(state.tables.has(key), `drop-table of missing table ${key}`);
      for (const [otherKey, other] of state.tables) {
        if (otherKey === key) continue;
        for (const foreignKey of other.foreignKeys) {
          assert.ok(
            !sameIdentity(foreignKey.referencedTable, step.table),
            `drop-table ${key} while live ${foreignKeyKey(foreignKey)} on ${otherKey} references it`,
          );
        }
      }
      state.tables.delete(key);
      return;
    }
    case 'drop-foreign-key': {
      const key = keyOf(step.table);
      const table = state.tables.get(key);
      assert.ok(table !== undefined, `drop-foreign-key on missing table ${key}`);
      const index = table.foreignKeys.findIndex(
        (candidate) => foreignKeyKey(candidate) === foreignKeyKey(step.foreignKey),
      );
      assert.notEqual(
        index,
        -1,
        `drop-foreign-key of missing ${foreignKeyKey(step.foreignKey)} on ${key}`,
      );
      table.foreignKeys.splice(index, 1);
      return;
    }
    case 'drop-primary-key': {
      const key = keyOf(step.table);
      const table = state.tables.get(key);
      assert.ok(table !== undefined, `drop-primary-key on missing table ${key}`);
      assert.deepStrictEqual(
        table.primaryKey,
        step.primaryKey,
        `drop-primary-key on ${key} that does not carry that primary key`,
      );
      for (const [otherKey, other] of state.tables) {
        for (const foreignKey of other.foreignKeys) {
          if (!sameIdentity(foreignKey.referencedTable, step.table)) continue;
          const referenced = referencedColumnsOf(foreignKey, state);
          for (const column of step.primaryKey.columns) {
            assert.ok(
              !referenced.includes(column),
              `drop-primary-key on ${key} while live ${foreignKeyKey(foreignKey)} on ${otherKey} references it`,
            );
          }
        }
      }
      table.primaryKey = undefined;
      return;
    }
    case 'drop-column': {
      const key = keyOf(step.table);
      const table = state.tables.get(key);
      assert.ok(table !== undefined, `drop-column on missing table ${key}`);
      assert.ok(
        table.columns.has(step.column.name),
        `drop-column of missing ${step.column.name} on ${key}`,
      );
      for (const [otherKey, other] of state.tables) {
        for (const foreignKey of other.foreignKeys) {
          const uses = otherKey === key && foreignKey.columns.includes(step.column.name);
          const references =
            sameIdentity(foreignKey.referencedTable, step.table) &&
            referencedColumnsOf(foreignKey, state).includes(step.column.name);
          assert.ok(
            !uses && !references,
            `drop-column ${step.column.name} on ${key} while live ${foreignKeyKey(foreignKey)} on ${otherKey} depends on it`,
          );
        }
      }
      table.columns.delete(step.column.name);
      return;
    }
    case 'add-column': {
      const key = keyOf(step.table);
      const table = state.tables.get(key);
      assert.ok(table !== undefined, `add-column on missing table ${key}`);
      assert.equal(
        table.columns.has(step.column.name),
        false,
        `add-column of live ${step.column.name} on ${key}`,
      );
      table.columns.set(step.column.name, { ...step.column });
      return;
    }
    case 'alter-column': {
      const key = keyOf(step.table);
      const table = state.tables.get(key);
      assert.ok(table !== undefined, `alter-column on missing table ${key}`);
      const altered = table.columns.get(step.name);
      assert.ok(altered !== undefined, `alter-column of missing ${step.name} on ${key}`);
      for (const field of step.fields) {
        switch (field.field) {
          case 'type':
            altered.type = field.after;
            break;
          case 'notNull':
            altered.notNull = field.after;
            break;
          case 'default':
            if (field.after === undefined) delete altered.default;
            else altered.default = field.after;
            break;
        }
      }
      return;
    }
    case 'add-primary-key': {
      const key = keyOf(step.table);
      const table = state.tables.get(key);
      assert.ok(table !== undefined, `add-primary-key on missing table ${key}`);
      assert.equal(
        table.primaryKey,
        undefined,
        `add-primary-key on ${key} that already carries one`,
      );
      table.primaryKey = copyPrimaryKey(step.primaryKey);
      return;
    }
    case 'add-foreign-key': {
      const key = keyOf(step.table);
      const table = state.tables.get(key);
      assert.ok(table !== undefined, `add-foreign-key on missing table ${key}`);
      const referencedKey = keyOf(step.foreignKey.referencedTable);
      const referenced = state.tables.get(referencedKey);
      assert.ok(
        referenced !== undefined,
        `add-foreign-key on ${key} referencing missing table ${referencedKey}`,
      );
      const referencedColumns =
        step.foreignKey.referencedColumns.length > 0
          ? step.foreignKey.referencedColumns
          : (referenced.primaryKey?.columns ?? []);
      for (const name of referencedColumns) {
        assert.ok(
          referenced.columns.has(name),
          `add-foreign-key on ${key} referencing missing column ${name} on ${referencedKey}`,
        );
      }
      table.foreignKeys.push(copyForeignKey(step.foreignKey));
      return;
    }
  }
};

/** Asserts the simulated state and the target model hold the same tables and constraints. */
const assertSameState = (state: SimulatedState, target: Model): void => {
  assert.deepStrictEqual(
    [...state.tables.keys()].sort(),
    target.tables.map(keyOf).sort(),
    'the plan must leave exactly the target tables',
  );
  for (const expected of target.tables) {
    const key = keyOf(expected);
    const actual = state.tables.get(key);
    assert.ok(actual !== undefined, `missing target table ${key}`);
    assert.deepStrictEqual(
      [...actual.columns.keys()].sort(),
      expected.columns.map((entry) => entry.name).sort(),
      `columns of ${key}`,
    );
    for (const entry of expected.columns) {
      assert.deepStrictEqual(
        actual.columns.get(entry.name),
        entry,
        `column ${entry.name} of ${key}`,
      );
    }
    assert.deepStrictEqual(actual.primaryKey, expected.primaryKey, `primary key of ${key}`);
    assert.deepStrictEqual(
      actual.foreignKeys.map(foreignKeyKey).sort(),
      expected.foreignKeys.map(foreignKeyKey).sort(),
      `foreign keys of ${key}`,
    );
  }
};

/** Plans `baseline` to `target` and runs the whole plan through the simulator. */
const simulate = (baseline: Model, target: Model): void => {
  const { steps } = plan(baseline, target);
  const state = stateOf(baseline);
  const baselineKeys = new Set(baseline.tables.map(keyOf));
  const targetKeys = new Set(target.tables.map(keyOf));
  const dropped = new Map<string, number>();
  const created = new Map<string, number>();

  for (const step of steps) {
    applyStep(state, step);
    if (step.kind === 'drop-table') {
      const key = keyOf(step.table);
      dropped.set(key, (dropped.get(key) ?? 0) + 1);
    }
    if (step.kind === 'create-table') {
      const key = keyOf(step.table);
      created.set(key, (created.get(key) ?? 0) + 1);
    }
  }

  for (const removed of baseline.tables) {
    const key = keyOf(removed);
    if (targetKeys.has(key)) continue;
    assert.equal(dropped.get(key) ?? 0, 1, `removed table ${key} must be dropped exactly once`);
  }
  for (const added of target.tables) {
    const key = keyOf(added);
    if (baselineKeys.has(key)) continue;
    assert.equal(created.get(key) ?? 0, 1, `added table ${key} must be created exactly once`);
  }

  assertSameState(state, target);
};

/**
 * A deterministic pseudo-random source: a 32-bit linear congruential generator with the
 * Numerical Recipes constants. `pick` and `chance` derive from the same fixed sequence.
 */
interface Random {
  readonly next: () => number;
  readonly pick: <T>(values: readonly T[]) => T;
  readonly chance: (probability: number) => boolean;
}

/** The seeded generator. */
const randomOf = (seed: number): Random => {
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  return {
    next,
    pick: <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!,
    chance: (probability: number): boolean => next() < probability,
  };
};

/** A mutable table while `generatePair` assembles one side of a random pair. */
interface GeneratedTable {
  readonly name: string;
  readonly columns: Mutable<Column>[];
  primaryKey: Mutable<PrimaryKey> | undefined;
  readonly foreignKeys: Mutable<ForeignKey>[];
}

/** A fresh `prefix`-numbered column name for `table`. */
const freshColumnName = (table: GeneratedTable, prefix: string): string => {
  let index = 0;
  while (table.columns.some((entry) => entry.name === `${prefix}${index}`)) index += 1;
  return `${prefix}${index}`;
};

/**
 * Renames or reorders one generated target primary key. The column set stays the same, so the
 * foreign keys that resolve to it stay well-formed, and the planner has to set them aside
 * while the key is replaced.
 */
const mutatePrimaryKey = (table: GeneratedTable, random: Random): void => {
  const primaryKey = table.primaryKey;
  if (primaryKey === undefined) return;
  const columns =
    primaryKey.columns.length > 1 && random.chance(0.5)
      ? [...primaryKey.columns].reverse()
      : [...primaryKey.columns];
  table.primaryKey = {
    ...(random.chance(0.5) ? {} : { name: `${table.name}_pkey_v2` }),
    columns,
  };
};

/**
 * Mutates one generated target table: drops, renames, or reorders a primary key; drops, adds,
 * or alters a text column; and drops or changes a foreign key. A primary key is only added
 * when the baseline table had none, and a rename or reorder keeps its column set, so every
 * generated target stays well-formed. Foreign-key targets are always a present table's
 * `integer` primary-key columns, so the pair stays well-formed too.
 */
const mutateTable = (
  table: GeneratedTable,
  startedWithPrimaryKey: boolean,
  random: Random,
  textTypes: readonly string[],
): void => {
  if (table.primaryKey !== undefined && random.chance(0.3)) {
    table.primaryKey = undefined;
  } else if (table.primaryKey !== undefined && random.chance(0.35)) {
    mutatePrimaryKey(table, random);
  } else if (!startedWithPrimaryKey && random.chance(0.3)) {
    table.primaryKey = { columns: ['id'] };
  }
  const extras = table.columns.filter((entry) => entry.name.startsWith('e'));
  if (extras.length > 0 && random.chance(0.4)) {
    table.columns.splice(table.columns.indexOf(random.pick(extras)), 1);
  }
  if (random.chance(0.4)) {
    table.columns.push(
      column(freshColumnName(table, 'e'), {
        type: random.pick(textTypes),
        notNull: random.chance(0.3),
        ...(random.chance(0.3) ? { default: "'x'" } : {}),
      }),
    );
  }
  const alterable = table.columns.filter((entry) => entry.name.startsWith('e'));
  if (alterable.length > 0 && random.chance(0.4)) {
    const altered = random.pick(alterable);
    altered.notNull = !altered.notNull;
    if (random.chance(0.5)) altered.type = random.pick(textTypes);
    if (random.chance(0.5)) {
      if (altered.default === undefined) altered.default = "'x'";
      else delete altered.default;
    }
  }
  if (table.foreignKeys.length > 0 && random.chance(0.4)) {
    table.foreignKeys.splice(Math.floor(random.next() * table.foreignKeys.length), 1);
  }
  if (table.foreignKeys.length > 0 && random.chance(0.3)) {
    const changed = random.pick(table.foreignKeys);
    if (random.chance(0.5)) changed.name = `${changed.name ?? 'unnamed'}_changed`;
    else changed.onDelete = changed.onDelete === undefined ? 'CASCADE' : undefined;
  }
};

/**
 * One well-formed pseudo-random pair: 2–6 baseline tables, every foreign key pointing at a
 * present table's `integer` primary-key columns (single-column or composite), a target built
 * from kept, removed, changed, and added tables, and target foreign keys that never reference
 * a removed table or a dropped primary key. Table order is shuffled so the planner sees
 * arbitrary insertion orders.
 */
const generatePair = (random: Random): { baseline: Model; target: Model } => {
  const textTypes = ['text', 'character varying(12)', 'character varying(24)'];
  const tableCount = 2 + Math.floor(random.next() * 5);
  const names = Array.from({ length: tableCount }, (_, index) => `t${index}`);
  const hasPrimaryKey = new Map(names.map((name) => [name, random.chance(0.8)]));
  const primaryKeyColumns = new Map(
    names.map((name) => [
      name,
      hasPrimaryKey.get(name) === true && random.chance(0.35) ? ['id', 'k2'] : ['id'],
    ]),
  );
  const keyed = names.filter((name) => hasPrimaryKey.get(name) === true);

  const baselineTables = names.map((name): Table => {
    const keyColumns = primaryKeyColumns.get(name)!;
    const columns: Column[] = [column('id', { type: 'integer', notNull: true })];
    if (keyColumns.length > 1) columns.push(column('k2', { type: 'integer', notNull: true }));
    const extras = Math.floor(random.next() * 3);
    for (let index = 0; index < extras; index += 1) {
      columns.push(
        column(`e${index}`, {
          type: random.pick(textTypes),
          notNull: random.chance(0.3),
          ...(random.chance(0.3) ? { default: "'x'" } : {}),
        }),
      );
    }
    const foreignKeys: ForeignKey[] = [];
    const keyCount = keyed.length === 0 ? 0 : Math.floor(random.next() * 3);
    for (let index = 0; index < keyCount; index += 1) {
      const referenced = random.pick(keyed);
      const referencedKey = primaryKeyColumns.get(referenced)!;
      const omitReferencedColumns = random.chance(0.25);
      const referencing = referencedKey.map((_, position) => {
        const columnName = `f${index}_${position}`;
        columns.push(column(columnName, { type: 'integer' }));
        return columnName;
      });
      foreignKeys.push(
        foreignKey(referencing, identity(referenced), {
          referencedColumns: omitReferencedColumns
            ? []
            : random.chance(0.5)
              ? [...referencedKey].reverse()
              : [...referencedKey],
          ...(random.chance(0.4) ? { name: `${name}_f${index}_fkey` } : {}),
          ...(random.chance(0.3) ? { onDelete: 'CASCADE' as const } : {}),
        }),
      );
    }
    return table(name, {
      columns,
      ...(hasPrimaryKey.get(name) === true
        ? { primaryKey: { name: `${name}_pkey`, columns: [...keyColumns] } }
        : {}),
      foreignKeys,
    });
  });

  const target = new Map<string, GeneratedTable>();
  for (const source of baselineTables) {
    if (random.chance(0.25)) continue;
    const generated: GeneratedTable = {
      name: source.name,
      columns: source.columns.map((entry) => ({ ...entry })),
      primaryKey: source.primaryKey === undefined ? undefined : copyPrimaryKey(source.primaryKey),
      foreignKeys: source.foreignKeys.map(copyForeignKey),
    };
    if (random.chance(0.55))
      mutateTable(generated, hasPrimaryKey.get(source.name) === true, random, textTypes);
    target.set(source.name, generated);
  }

  for (let index = 0; index < 2 && random.chance(0.3); index += 1) {
    const name = `u${index}`;
    const columns: Column[] = [column('id', { type: 'integer', notNull: true })];
    if (random.chance(0.5)) columns.push(column('e0', { type: random.pick(textTypes) }));
    const composite = random.chance(0.3);
    if (composite) columns.push(column('k2', { type: 'integer', notNull: true }));
    target.set(name, {
      name,
      columns,
      primaryKey: { name: `${name}_pkey`, columns: composite ? ['id', 'k2'] : ['id'] },
      foreignKeys: [],
    });
  }

  // Keep the target well-formed: a foreign key survives only when its referenced table is
  // present with a live primary key and its referencing columns still exist.
  for (const generated of target.values()) {
    const surviving = generated.foreignKeys.filter((key) => {
      const referenced = target.get(key.referencedTable.name);
      if (key.referencedTable.schema !== 'public' || referenced === undefined) return false;
      if (referenced.primaryKey === undefined) return false;
      const referencedColumns =
        key.referencedColumns.length > 0 ? key.referencedColumns : referenced.primaryKey.columns;
      if (
        !referencedColumns.every((name) =>
          referenced.columns.some((column) => column.name === name),
        )
      ) {
        return false;
      }
      return key.columns.every((name) => generated.columns.some((column) => column.name === name));
    });
    generated.foreignKeys.length = 0;
    generated.foreignKeys.push(...surviving);
  }

  // Some target tables gain a fresh foreign key to a table that has a target primary key.
  const candidates = [...target.values()].filter((generated) => generated.primaryKey !== undefined);
  for (const generated of target.values()) {
    if (candidates.length === 0 || !random.chance(0.25)) continue;
    const referenced = random.pick(candidates);
    const referencedKey = referenced.primaryKey!;
    const referencing = referencedKey.columns.map(() => {
      const columnName = freshColumnName(generated, 'h');
      generated.columns.push(column(columnName, { type: 'integer' }));
      return columnName;
    });
    generated.foreignKeys.push(
      foreignKey(referencing, identity(referenced.name), {
        referencedColumns: random.chance(0.3) ? [] : [...referencedKey.columns],
        ...(random.chance(0.5) ? { name: `${generated.name}_${referencing.join('_')}_fkey` } : {}),
      }),
    );
  }

  const shuffle = <T>(values: readonly T[]): T[] => {
    const copy = [...values];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(random.next() * (index + 1));
      const held = copy[index]!;
      copy[index] = copy[swap]!;
      copy[swap] = held;
    }
    return copy;
  };

  const toTable = (generated: GeneratedTable): Table =>
    table(generated.name, {
      columns: generated.columns,
      ...(generated.primaryKey === undefined ? {} : { primaryKey: generated.primaryKey }),
      foreignKeys: generated.foreignKeys,
    });

  return {
    baseline: model(...shuffle(baselineTables)),
    target: model(...shuffle([...target.values()].map(toTable))),
  };
};

test('identical models produce an empty plan', () => {
  const profiles = table('profiles', {
    columns: [column('id', { type: 'bigint', notNull: true })],
    primaryKey: { name: 'profiles_pkey', columns: ['id'] },
  });
  const users = table('users', {
    columns: [
      column('id', { type: 'bigint', notNull: true }),
      column('profile_id', { type: 'bigint' }),
    ],
    primaryKey: { name: 'users_pkey', columns: ['id'] },
    foreignKeys: [
      foreignKey(['profile_id'], identity('profiles'), {
        name: 'users_profile_id_fkey',
        referencedColumns: ['id'],
      }),
    ],
  });

  assertPlan(model(profiles, users), model(profiles, users), []);
});

test('an added table becomes a create-table step and trailing foreign-key steps', () => {
  const users = table('users', {
    columns: [column('id', { type: 'bigint', notNull: true })],
    primaryKey: { name: 'users_pkey', columns: ['id'] },
  });
  const ordersForeignKey = foreignKey(['user_id'], identity('users'), {
    name: 'orders_user_id_fkey',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  });
  const orders = table('orders', {
    columns: [
      column('id', { type: 'bigint', notNull: true }),
      column('user_id', { type: 'bigint' }),
    ],
    primaryKey: { columns: ['id'] },
    foreignKeys: [ordersForeignKey],
  });

  assertPlan(model(), model(orders, users), [
    {
      kind: 'create-table',
      table: {
        schema: 'public',
        name: 'orders',
        columns: [
          column('id', { type: 'bigint', notNull: true }),
          column('user_id', { type: 'bigint' }),
        ],
        primaryKey: { columns: ['id'] },
        foreignKeys: [],
      },
    },
    {
      kind: 'create-table',
      table: {
        schema: 'public',
        name: 'users',
        columns: [column('id', { type: 'bigint', notNull: true })],
        primaryKey: { name: 'users_pkey', columns: ['id'] },
        foreignKeys: [],
      },
    },
    { kind: 'add-foreign-key', table: identity('orders'), foreignKey: ordersForeignKey },
  ]);
});

test('a removed foreign key drops before the table it references', () => {
  const key = foreignKey(['user_id'], identity('users'), {
    name: 'orders_user_id_fkey',
    referencedColumns: ['id'],
  });
  const orders = table('orders', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('user_id', { type: 'integer' }),
    ],
    foreignKeys: [key],
  });
  const users = table('users', {
    columns: [column('id', { type: 'integer', notNull: true })],
    primaryKey: { name: 'users_pkey', columns: ['id'] },
  });
  const baseline = model(orders, users);
  const target = model(
    table('orders', {
      columns: [
        column('id', { type: 'integer', notNull: true }),
        column('user_id', { type: 'integer' }),
      ],
    }),
  );

  assertPlan(baseline, target, [
    { kind: 'drop-foreign-key', table: identity('orders'), foreignKey: key },
    { kind: 'drop-table', table: identity('users') },
  ]);
  simulate(baseline, target);
});

test('a removed reference chain drops dependents before the tables they reference', () => {
  const parent = idTable('a_parent');
  const middle = idTable(
    'm_middle',
    [column('parent_id', { type: 'integer' })],
    [idForeignKey('m_middle', 'parent_id', 'a_parent')],
  );
  const child = idTable(
    'z_child',
    [column('middle_id', { type: 'integer' })],
    [idForeignKey('z_child', 'middle_id', 'm_middle')],
  );
  const baseline = model(parent, middle, child);

  // The diff reports a_parent, m_middle, z_child; dependencies reverse that.
  assertPlan(baseline, model(), [
    { kind: 'drop-table', table: identity('z_child') },
    { kind: 'drop-table', table: identity('m_middle') },
    { kind: 'drop-table', table: identity('a_parent') },
  ]);
  simulate(baseline, model());
});

test('a removed reference cycle cuts incoming references before dropping', () => {
  const aForeignKey = idForeignKey('a', 'b_id', 'b');
  const bForeignKey = idForeignKey('b', 'a_id', 'a');
  const a = idTable('a', [column('b_id', { type: 'integer' })], [aForeignKey]);
  const b = idTable('b', [column('a_id', { type: 'integer' })], [bForeignKey]);
  const expected: readonly Step[] = [
    { kind: 'drop-foreign-key', table: identity('b'), foreignKey: bForeignKey },
    { kind: 'drop-table', table: identity('a') },
    { kind: 'drop-table', table: identity('b') },
  ];

  assertPlan(model(a, b), model(), expected);
  assertPlan(model(b, a), model(), expected);
  simulate(model(a, b), model());
  simulate(model(b, a), model());
});

test('a three-table reference cycle cuts incoming references in identity order', () => {
  const a = idTable('a', [column('b_id', { type: 'integer' })], [idForeignKey('a', 'b_id', 'b')]);
  const b = idTable('b', [column('c_id', { type: 'integer' })], [idForeignKey('b', 'c_id', 'c')]);
  const c = idTable('c', [column('a_id', { type: 'integer' })], [idForeignKey('c', 'a_id', 'a')]);
  const baseline = model(a, b, c);

  assertPlan(baseline, model(), [
    { kind: 'drop-foreign-key', table: identity('c'), foreignKey: c.foreignKeys[0]! },
    { kind: 'drop-table', table: identity('a') },
    { kind: 'drop-table', table: identity('b') },
    { kind: 'drop-table', table: identity('c') },
  ]);
  simulate(baseline, model());
});

test('two disjoint removed cycles each cut their own incoming references', () => {
  const a = idTable('a', [column('b_id', { type: 'integer' })], [idForeignKey('a', 'b_id', 'b')]);
  const b = idTable('b', [column('a_id', { type: 'integer' })], [idForeignKey('b', 'a_id', 'a')]);
  const c = idTable('c', [column('d_id', { type: 'integer' })], [idForeignKey('c', 'd_id', 'd')]);
  const d = idTable('d', [column('c_id', { type: 'integer' })], [idForeignKey('d', 'c_id', 'c')]);
  const baseline = model(a, b, c, d);

  assertPlan(baseline, model(), [
    { kind: 'drop-foreign-key', table: identity('b'), foreignKey: b.foreignKeys[0]! },
    { kind: 'drop-foreign-key', table: identity('d'), foreignKey: d.foreignKeys[0]! },
    { kind: 'drop-table', table: identity('a') },
    { kind: 'drop-table', table: identity('b') },
    { kind: 'drop-table', table: identity('c') },
    { kind: 'drop-table', table: identity('d') },
  ]);
  simulate(baseline, model());
});

test('a removed cycle plus an outside dependent drops the dependent first', () => {
  const a = idTable('a', [column('b_id', { type: 'integer' })], [idForeignKey('a', 'b_id', 'b')]);
  const b = idTable('b', [column('a_id', { type: 'integer' })], [idForeignKey('b', 'a_id', 'a')]);
  const c = idTable('c', [column('a_id', { type: 'integer' })], [idForeignKey('c', 'a_id', 'a')]);
  const baseline = model(a, b, c);

  assertPlan(baseline, model(), [
    { kind: 'drop-foreign-key', table: identity('b'), foreignKey: b.foreignKeys[0]! },
    { kind: 'drop-table', table: identity('c') },
    { kind: 'drop-table', table: identity('a') },
    { kind: 'drop-table', table: identity('b') },
  ]);
  simulate(baseline, model());
});

test('a self-loop never blocks its table and never needs a cut', () => {
  const s = idTable(
    's',
    [column('parent_id', { type: 'integer' })],
    [idForeignKey('s', 'parent_id', 's')],
  );
  const a = idTable('a', [column('b_id', { type: 'integer' })], [idForeignKey('a', 'b_id', 'b')]);
  const b = idTable('b', [column('a_id', { type: 'integer' })], [idForeignKey('b', 'a_id', 'a')]);
  const baseline = model(a, b, s);

  assertPlan(baseline, model(), [
    { kind: 'drop-foreign-key', table: identity('b'), foreignKey: b.foreignKeys[0]! },
    { kind: 'drop-table', table: identity('s') },
    { kind: 'drop-table', table: identity('a') },
    { kind: 'drop-table', table: identity('b') },
  ]);
  simulate(baseline, model());
});

test('the smallest table referenced by two others cuts every incoming key in order', () => {
  const a = idTable('a');
  const bToA = idForeignKey('b', 'a_id', 'a');
  const bToC = idForeignKey('b', 'c_id', 'c');
  const b = idTable(
    'b',
    [column('a_id', { type: 'integer' }), column('c_id', { type: 'integer' })],
    [bToA, bToC],
  );
  const cToA2 = idForeignKey('c', 'a2_id', 'a');
  const cToA = idForeignKey('c', 'a_id', 'a');
  const cToB = idForeignKey('c', 'b_id', 'b');
  const c = idTable(
    'c',
    [
      column('b_id', { type: 'integer' }),
      column('a2_id', { type: 'integer' }),
      column('a_id', { type: 'integer' }),
    ],
    [cToB, cToA2, cToA],
  );
  const baseline = model(c, a, b);

  assertPlan(baseline, model(), [
    { kind: 'drop-foreign-key', table: identity('b'), foreignKey: bToA },
    { kind: 'drop-foreign-key', table: identity('c'), foreignKey: cToA2 },
    { kind: 'drop-foreign-key', table: identity('c'), foreignKey: cToA },
    { kind: 'drop-foreign-key', table: identity('c'), foreignKey: cToB },
    { kind: 'drop-table', table: identity('a') },
    { kind: 'drop-table', table: identity('b') },
    { kind: 'drop-table', table: identity('c') },
  ]);
  simulate(baseline, model());
});

test('a removed table referencing a kept primary key drops before the key does', () => {
  const t = table('t', {
    columns: [column('id', { type: 'integer', notNull: true })],
    primaryKey: { name: 't_pkey', columns: ['id'] },
  });
  const x = idTable('x', [column('t_id', { type: 'integer' })], [idForeignKey('x', 't_id', 't')]);
  const baseline = model(t, x);
  const target = model(table('t', { columns: [column('id', { type: 'integer', notNull: true })] }));

  assertPlan(baseline, target, [
    { kind: 'drop-table', table: identity('x') },
    {
      kind: 'drop-primary-key',
      table: identity('t'),
      primaryKey: { name: 't_pkey', columns: ['id'] },
    },
  ]);
  simulate(baseline, target);
});

test('a removed table referencing a kept column drops before the column does', () => {
  const tKey = foreignKey(['c'], identity('t'), { name: 'x_c_fkey', referencedColumns: ['c'] });
  const t = table('t', {
    columns: [column('c', { type: 'integer', notNull: true }), column('d', { type: 'integer' })],
    primaryKey: { name: 't_pkey', columns: ['c'] },
  });
  const x = table('x', {
    columns: [column('id', { type: 'integer', notNull: true }), column('c', { type: 'integer' })],
    primaryKey: { name: 'x_pkey', columns: ['id'] },
    foreignKeys: [tKey],
  });
  const baseline = model(t, x);
  const target = model(
    table('t', {
      columns: [column('d', { type: 'integer', notNull: true })],
      primaryKey: { name: 't_d_pkey', columns: ['d'] },
    }),
  );

  assertPlan(baseline, target, [
    { kind: 'drop-table', table: identity('x') },
    {
      kind: 'drop-primary-key',
      table: identity('t'),
      primaryKey: { name: 't_pkey', columns: ['c'] },
    },
    {
      kind: 'drop-column',
      table: identity('t'),
      column: column('c', { type: 'integer', notNull: true }),
    },
    {
      kind: 'alter-column',
      table: identity('t'),
      name: 'd',
      fields: [{ field: 'notNull', before: false, after: true }],
    },
    {
      kind: 'add-primary-key',
      table: identity('t'),
      primaryKey: { name: 't_d_pkey', columns: ['d'] },
    },
  ]);
  simulate(baseline, target);
});

test('a renamed primary key sets aside the foreign keys that reference it', () => {
  const key = foreignKey(['c_id'], identity('c'), {
    name: 'e_c_id_fkey',
    referencedColumns: ['id'],
  });
  const c = table('c', {
    columns: [column('id', { type: 'integer', notNull: true })],
    primaryKey: { name: 'c_pkey', columns: ['id'] },
  });
  const e = table('e', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('c_id', { type: 'integer' }),
    ],
    primaryKey: { name: 'e_pkey', columns: ['id'] },
    foreignKeys: [key],
  });
  const baseline = model(c, e);
  const target = model({ ...c, primaryKey: { name: 'c_pkey_v2', columns: ['id'] } }, e);

  assertPlan(baseline, target, [
    { kind: 'drop-foreign-key', table: identity('e'), foreignKey: key },
    {
      kind: 'drop-primary-key',
      table: identity('c'),
      primaryKey: { name: 'c_pkey', columns: ['id'] },
    },
    {
      kind: 'add-primary-key',
      table: identity('c'),
      primaryKey: { name: 'c_pkey_v2', columns: ['id'] },
    },
    { kind: 'add-foreign-key', table: identity('e'), foreignKey: key },
  ]);
  simulate(baseline, target);
});

test('a reordered composite primary key sets aside a composite foreign key', () => {
  const key = foreignKey(['pa', 'pb'], identity('p'), {
    name: 'q_p_fkey',
    referencedColumns: ['a', 'b'],
  });
  const p = table('p', {
    columns: [
      column('a', { type: 'integer', notNull: true }),
      column('b', { type: 'integer', notNull: true }),
    ],
    primaryKey: { name: 'p_pkey', columns: ['a', 'b'] },
  });
  const q = table('q', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('pa', { type: 'integer' }),
      column('pb', { type: 'integer' }),
    ],
    primaryKey: { name: 'q_pkey', columns: ['id'] },
    foreignKeys: [key],
  });
  const baseline = model(p, q);
  const target = model({ ...p, primaryKey: { name: 'p_pkey_v2', columns: ['b', 'a'] } }, q);

  assertPlan(baseline, target, [
    { kind: 'drop-foreign-key', table: identity('q'), foreignKey: key },
    {
      kind: 'drop-primary-key',
      table: identity('p'),
      primaryKey: { name: 'p_pkey', columns: ['a', 'b'] },
    },
    {
      kind: 'add-primary-key',
      table: identity('p'),
      primaryKey: { name: 'p_pkey_v2', columns: ['b', 'a'] },
    },
    { kind: 'add-foreign-key', table: identity('q'), foreignKey: key },
  ]);
  simulate(baseline, target);
});

test('a renamed primary key sets aside a foreign key that omits its referenced columns', () => {
  const key = foreignKey(['c_id'], identity('c'), { name: 'e_c_id_fkey' });
  const c = table('c', {
    columns: [column('id', { type: 'integer', notNull: true })],
    primaryKey: { name: 'c_pkey', columns: ['id'] },
  });
  const e = table('e', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('c_id', { type: 'integer' }),
    ],
    primaryKey: { name: 'e_pkey', columns: ['id'] },
    foreignKeys: [key],
  });
  const baseline = model(c, e);
  const target = model({ ...c, primaryKey: { name: 'c_pkey_v2', columns: ['id'] } }, e);

  assertPlan(baseline, target, [
    { kind: 'drop-foreign-key', table: identity('e'), foreignKey: key },
    {
      kind: 'drop-primary-key',
      table: identity('c'),
      primaryKey: { name: 'c_pkey', columns: ['id'] },
    },
    {
      kind: 'add-primary-key',
      table: identity('c'),
      primaryKey: { name: 'c_pkey_v2', columns: ['id'] },
    },
    { kind: 'add-foreign-key', table: identity('e'), foreignKey: key },
  ]);
  simulate(baseline, target);
});

test('primary-key dependents are set aside in identity order, including a self-reference', () => {
  const aBKey = foreignKey(['b_id'], identity('c'), {
    name: 'a_b_id_fkey',
    referencedColumns: ['id'],
  });
  const aAKey = foreignKey(['a_id'], identity('c'), {
    name: 'a_a_id_fkey',
    referencedColumns: ['id'],
  });
  const cKey = foreignKey(['parent_id'], identity('c'), {
    name: 'c_parent_id_fkey',
    referencedColumns: ['id'],
  });
  const zKey = foreignKey(['c_id'], identity('c'), {
    name: 'z_c_id_fkey',
    referencedColumns: ['id'],
  });
  const c = table('c', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('parent_id', { type: 'integer' }),
    ],
    primaryKey: { name: 'c_pkey', columns: ['id'] },
    foreignKeys: [cKey],
  });
  const a = table('a', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('b_id', { type: 'integer' }),
      column('a_id', { type: 'integer' }),
    ],
    primaryKey: { name: 'a_pkey', columns: ['id'] },
    foreignKeys: [aBKey, aAKey],
  });
  const z = table('z', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('c_id', { type: 'integer' }),
    ],
    primaryKey: { name: 'z_pkey', columns: ['id'] },
    foreignKeys: [zKey],
  });
  const baseline = model(z, c, a);
  const target = model({ ...c, primaryKey: { name: 'c_pkey_v2', columns: ['id'] } }, z, a);

  assertPlan(baseline, target, [
    { kind: 'drop-foreign-key', table: identity('a'), foreignKey: aAKey },
    { kind: 'drop-foreign-key', table: identity('a'), foreignKey: aBKey },
    { kind: 'drop-foreign-key', table: identity('c'), foreignKey: cKey },
    { kind: 'drop-foreign-key', table: identity('z'), foreignKey: zKey },
    {
      kind: 'drop-primary-key',
      table: identity('c'),
      primaryKey: { name: 'c_pkey', columns: ['id'] },
    },
    {
      kind: 'add-primary-key',
      table: identity('c'),
      primaryKey: { name: 'c_pkey_v2', columns: ['id'] },
    },
    { kind: 'add-foreign-key', table: identity('a'), foreignKey: aAKey },
    { kind: 'add-foreign-key', table: identity('a'), foreignKey: aBKey },
    { kind: 'add-foreign-key', table: identity('c'), foreignKey: cKey },
    { kind: 'add-foreign-key', table: identity('z'), foreignKey: zKey },
  ]);
  simulate(baseline, target);
});

test('a removed table referencing a renamed primary key needs no sets-aside pair', () => {
  const key = foreignKey(['c_id'], identity('c'), {
    name: 'x_c_id_fkey',
    referencedColumns: ['id'],
  });
  const c = table('c', {
    columns: [column('id', { type: 'integer', notNull: true })],
    primaryKey: { name: 'c_pkey', columns: ['id'] },
  });
  const x = table('x', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('c_id', { type: 'integer' }),
    ],
    primaryKey: { name: 'x_pkey', columns: ['id'] },
    foreignKeys: [key],
  });
  const baseline = model(c, x);
  const target = model({ ...c, primaryKey: { name: 'c_pkey_v2', columns: ['id'] } });

  assertPlan(baseline, target, [
    { kind: 'drop-table', table: identity('x') },
    {
      kind: 'drop-primary-key',
      table: identity('c'),
      primaryKey: { name: 'c_pkey', columns: ['id'] },
    },
    {
      kind: 'add-primary-key',
      table: identity('c'),
      primaryKey: { name: 'c_pkey_v2', columns: ['id'] },
    },
  ]);
  simulate(baseline, target);
});

test('the diff replaces a foreign key under a primary-key change without a duplicate', () => {
  const before = foreignKey(['c_id'], identity('c'), {
    name: 'e_c_id_fkey',
    referencedColumns: ['id'],
  });
  const after = foreignKey(['c_id'], identity('c'), {
    name: 'e_c_id_fkey',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  });
  const c = table('c', {
    columns: [column('id', { type: 'integer', notNull: true })],
    primaryKey: { name: 'c_pkey', columns: ['id'] },
  });
  const e = table('e', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('c_id', { type: 'integer' }),
    ],
    primaryKey: { name: 'e_pkey', columns: ['id'] },
    foreignKeys: [before],
  });
  const cTarget = { ...c, primaryKey: { name: 'c_pkey_v2', columns: ['id'] } };
  const eTarget = table('e', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('c_id', { type: 'integer' }),
    ],
    primaryKey: { name: 'e_pkey', columns: ['id'] },
    foreignKeys: [after],
  });
  const baseline = model(c, e);
  const target = model(cTarget, eTarget);

  assertPlan(baseline, target, [
    { kind: 'drop-foreign-key', table: identity('e'), foreignKey: before },
    {
      kind: 'drop-primary-key',
      table: identity('c'),
      primaryKey: { name: 'c_pkey', columns: ['id'] },
    },
    {
      kind: 'add-primary-key',
      table: identity('c'),
      primaryKey: { name: 'c_pkey_v2', columns: ['id'] },
    },
    { kind: 'add-foreign-key', table: identity('e'), foreignKey: after },
  ]);
  simulate(baseline, target);
});

test('a removed primary key drops before the column it covers', () => {
  const baseline = model(
    table('t', { columns: [column('id')], primaryKey: { name: 't_pkey', columns: ['id'] } }),
  );
  const target = model(table('t'));

  assertPlan(baseline, target, [
    {
      kind: 'drop-primary-key',
      table: identity('t'),
      primaryKey: { name: 't_pkey', columns: ['id'] },
    },
    { kind: 'drop-column', table: identity('t'), column: column('id') },
  ]);
});

test('a primary-key change splits into a drop before column work and an add after it', () => {
  const baseline = model(
    table('t', {
      columns: [column('a'), column('b')],
      primaryKey: { name: 't_pkey', columns: ['a'] },
    }),
  );
  const target = model(
    table('t', {
      columns: [column('b'), column('c')],
      primaryKey: { columns: ['c'] },
    }),
  );

  assertPlan(baseline, target, [
    {
      kind: 'drop-primary-key',
      table: identity('t'),
      primaryKey: { name: 't_pkey', columns: ['a'] },
    },
    { kind: 'drop-column', table: identity('t'), column: column('a') },
    { kind: 'add-column', table: identity('t'), column: column('c') },
    { kind: 'add-primary-key', table: identity('t'), primaryKey: { columns: ['c'] } },
  ]);
});

test('a changed foreign key drops in phase 1 and adds in phase 9, around column work', () => {
  const parent = identity('parent');
  const before = foreignKey(['parent_id'], parent, {
    name: 't_parent_id_fkey',
    referencedColumns: ['id'],
  });
  const after = foreignKey(['parent_id'], parent, {
    name: 't_parent_id_fkey',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  });
  const parentTable = table('parent', {
    columns: [column('id', { type: 'integer', notNull: true })],
    primaryKey: { name: 'parent_pkey', columns: ['id'] },
  });
  const baseline = model(
    parentTable,
    table('t', {
      columns: [column('parent_id', { type: 'integer' })],
      foreignKeys: [before],
    }),
  );
  const target = model(
    parentTable,
    table('t', {
      columns: [column('parent_id', { type: 'integer' }), column('label')],
      foreignKeys: [after],
    }),
  );

  assertPlan(baseline, target, [
    { kind: 'drop-foreign-key', table: identity('t'), foreignKey: before },
    { kind: 'add-column', table: identity('t'), column: column('label') },
    { kind: 'add-foreign-key', table: identity('t'), foreignKey: after },
  ]);
});

test('column payloads keep their exact contents', () => {
  const baseline = model(table('t', { columns: [column('a')] }));
  const target = model(
    table('t', {
      columns: [
        column('a', { type: 'character varying(12)', notNull: true, default: "'x'" }),
        column('b', { type: 'numeric(12,2)', notNull: false, default: '0' }),
      ],
    }),
  );

  assertPlan(baseline, target, [
    {
      kind: 'add-column',
      table: identity('t'),
      column: { name: 'b', type: 'numeric(12,2)', notNull: false, default: '0' },
    },
    {
      kind: 'alter-column',
      table: identity('t'),
      name: 'a',
      fields: [
        { field: 'type', before: 'text', after: 'character varying(12)' },
        { field: 'notNull', before: false, after: true },
        { field: 'default', after: "'x'" },
      ],
    },
  ]);
});

test('a mixed migration pins the exact step sequence across all nine phases', () => {
  const audit = table('audit', { columns: [column('id')] });
  const legacy = table('legacy', {
    columns: [column('id', { type: 'integer', notNull: true })],
    primaryKey: { name: 'legacy_pkey', columns: ['id'] },
  });
  const legacyNotes = table('legacy_notes', {
    columns: [column('id'), column('legacy_id', { type: 'integer' })],
    foreignKeys: [
      foreignKey(['legacy_id'], identity('legacy'), {
        name: 'legacy_notes_legacy_id_fkey',
        referencedColumns: ['id'],
      }),
    ],
  });
  const groups = table('groups', {
    columns: [column('id', { type: 'integer', notNull: true })],
    primaryKey: { name: 'groups_pkey', columns: ['id'] },
  });
  const ordersForeignKey = foreignKey(['legacy_id'], identity('legacy'), {
    name: 'orders_legacy_id_fkey',
    referencedColumns: ['id'],
  });
  const orders = table('orders', {
    columns: [column('id'), column('legacy_id', { type: 'integer' })],
    foreignKeys: [ordersForeignKey],
  });
  const obsoleteForeignKey = foreignKey(['obsolete'], identity('legacy'), {
    name: 'users_obsolete_fkey',
    referencedColumns: ['id'],
  });
  const groupForeignKeyBefore = foreignKey(['group_id'], identity('groups'), {
    name: 'users_group_id_fkey',
    referencedColumns: ['id'],
  });
  const groupForeignKeyAfter = foreignKey(['group_id'], identity('groups'), {
    name: 'users_group_id_fkey',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  });
  const users = table('users', {
    columns: [
      column('id'),
      column('name', { type: 'character varying(12)' }),
      column('obsolete', { type: 'integer' }),
      column('group_id', { type: 'integer' }),
    ],
    primaryKey: { name: 'users_pkey', columns: ['id'] },
    foreignKeys: [obsoleteForeignKey, groupForeignKeyBefore],
  });

  const ordersTarget = table('orders', {
    columns: [column('id'), column('legacy_id', { type: 'integer' })],
  });
  const sessionsForeignKey = foreignKey(['user_id'], identity('users'), {
    name: 'sessions_user_id_fkey',
    referencedColumns: ['id'],
  });
  const sessions = table('sessions', {
    columns: [column('id'), column('user_id')],
    primaryKey: { name: 'sessions_pkey', columns: ['id'] },
    foreignKeys: [sessionsForeignKey],
  });
  const usersTarget = table('users', {
    columns: [
      column('id'),
      column('name'),
      column('group_id', { type: 'integer' }),
      column('email'),
    ],
    primaryKey: { columns: ['id'] },
    foreignKeys: [groupForeignKeyAfter],
  });
  const baseline = model(audit, legacy, legacyNotes, groups, orders, users);
  const target = model(groups, ordersTarget, sessions, usersTarget);

  assertPlan(baseline, target, [
    { kind: 'drop-foreign-key', table: identity('orders'), foreignKey: ordersForeignKey },
    { kind: 'drop-foreign-key', table: identity('users'), foreignKey: obsoleteForeignKey },
    { kind: 'drop-foreign-key', table: identity('users'), foreignKey: groupForeignKeyBefore },
    { kind: 'drop-table', table: identity('audit') },
    { kind: 'drop-table', table: identity('legacy_notes') },
    { kind: 'drop-table', table: identity('legacy') },
    {
      kind: 'drop-primary-key',
      table: identity('users'),
      primaryKey: { name: 'users_pkey', columns: ['id'] },
    },
    {
      kind: 'drop-column',
      table: identity('users'),
      column: column('obsolete', { type: 'integer' }),
    },
    {
      kind: 'create-table',
      table: {
        schema: 'public',
        name: 'sessions',
        columns: [column('id'), column('user_id')],
        primaryKey: { name: 'sessions_pkey', columns: ['id'] },
        foreignKeys: [],
      },
    },
    { kind: 'add-column', table: identity('users'), column: column('email') },
    {
      kind: 'alter-column',
      table: identity('users'),
      name: 'name',
      fields: [{ field: 'type', before: 'character varying(12)', after: 'text' }],
    },
    {
      kind: 'add-primary-key',
      table: identity('users'),
      primaryKey: { columns: ['id'] },
    },
    {
      kind: 'add-foreign-key',
      table: identity('sessions'),
      foreignKey: sessionsForeignKey,
    },
    {
      kind: 'add-foreign-key',
      table: identity('users'),
      foreignKey: groupForeignKeyAfter,
    },
  ]);
  simulate(baseline, target);
});

test('structurally equal models in any insertion order produce deep-equal plans', () => {
  const groups = table('groups', {
    columns: [column('id')],
    primaryKey: { name: 'groups_pkey', columns: ['id'] },
  });
  const legacy = table('legacy', {
    columns: [column('id')],
    primaryKey: { name: 'legacy_pkey', columns: ['id'] },
  });
  const legacyNotes = table('legacy_notes', {
    columns: [column('id'), column('legacy_id')],
    foreignKeys: [foreignKey(['legacy_id'], identity('legacy'), { referencedColumns: ['id'] })],
  });
  const legacyKey = foreignKey(['legacy_id'], identity('legacy'), { referencedColumns: ['id'] });
  const groupKey = foreignKey(['group_id'], identity('groups'), { referencedColumns: ['id'] });
  const orders = (foreignKeys: readonly ForeignKey[]) =>
    table('orders', {
      columns: [column('id'), column('legacy_id'), column('group_id')],
      foreignKeys,
    });
  const aKey = foreignKey(['b_id'], identity('b'), { referencedColumns: ['id'] });
  const bKey = foreignKey(['a_id'], identity('a'), { referencedColumns: ['id'] });
  const a = table('a', {
    columns: [column('id'), column('b_id')],
    primaryKey: { name: 'a_pkey', columns: ['id'] },
    foreignKeys: [aKey],
  });
  const b = table('b', {
    columns: [column('id'), column('a_id')],
    primaryKey: { name: 'b_pkey', columns: ['id'] },
    foreignKeys: [bKey],
  });

  const firstBaseline = model(orders([legacyKey, groupKey]), a, b, legacy, legacyNotes, groups);
  const secondBaseline = model(groups, legacyNotes, legacy, b, orders([groupKey, legacyKey]), a);
  const firstTarget = model(orders([groupKey]), groups);
  const secondTarget = model(groups, orders([groupKey]));

  assert.deepStrictEqual(plan(firstBaseline, firstTarget), plan(secondBaseline, secondTarget));
  simulate(firstBaseline, firstTarget);
  simulate(secondBaseline, secondTarget);
});

test('a deep-frozen model can be planned, and steps carry independent copies', () => {
  const removed = table('u', {
    columns: [column('id', { type: 'integer', notNull: true })],
    primaryKey: { name: 'u_pkey', columns: ['id'] },
  });
  const selfKey = foreignKey(['a'], identity('t'), {
    name: 't_a_fkey',
    referencedColumns: ['id'],
  });
  const added = column('b', { type: 'integer', notNull: true, default: '1' });
  const tBaseline = table('t', {
    columns: [column('a', { type: 'integer' }), column('id', { type: 'integer', notNull: true })],
    primaryKey: { name: 't_pkey', columns: ['id'] },
    foreignKeys: [selfKey],
  });
  const tTarget = table('t', {
    columns: [
      column('a', { type: 'integer' }),
      column('id', { type: 'integer', notNull: true }),
      added,
    ],
    primaryKey: { name: 't_pkey', columns: ['id'] },
  });
  const baseline = deepFreeze(model(tBaseline, removed));
  const target = deepFreeze(model(tTarget));

  const { steps } = plan(baseline, target);
  assert.deepStrictEqual(steps, [
    { kind: 'drop-foreign-key', table: identity('t'), foreignKey: selfKey },
    { kind: 'drop-table', table: identity('u') },
    { kind: 'add-column', table: identity('t'), column: added },
  ]);
  simulate(baseline, target);

  const [dropKey, dropTable, addColumn] = steps;
  assert.equal(dropKey?.kind, 'drop-foreign-key');
  if (dropKey?.kind === 'drop-foreign-key') {
    assert.notEqual(dropKey.foreignKey, selfKey);
    assert.notEqual(dropKey.foreignKey.columns, selfKey.columns);
    assert.notEqual(dropKey.foreignKey.referencedTable, selfKey.referencedTable);
    assert.notEqual(dropKey.foreignKey.referencedColumns, selfKey.referencedColumns);
  }
  assert.equal(dropTable?.kind, 'drop-table');
  if (dropTable?.kind === 'drop-table') assert.notEqual(dropTable.table, removed);
  assert.equal(addColumn?.kind, 'add-column');
  if (addColumn?.kind === 'add-column') assert.notEqual(addColumn.column, added);
});

test('seeded pseudo-random model pairs keep every ordering invariant', () => {
  const random = randomOf(0x5eed5eed);
  let drops = 0;
  let creates = 0;
  let cuts = 0;
  let keyChanges = 0;
  let setAsides = 0;
  for (let round = 0; round < 500; round += 1) {
    const { baseline, target } = generatePair(random);
    try {
      simulate(baseline, target);
    } catch (error) {
      throw new Error(
        `round ${round} failed: ${(error as Error).message}\n${JSON.stringify({ baseline, target })}`,
        { cause: error },
      );
    }
    const targetKeys = new Set(target.tables.map(keyOf));
    const surviving = new Map(
      target.tables.map((table) => [keyOf(table), new Set(table.foreignKeys.map(foreignKeyKey))]),
    );
    const { steps } = plan(baseline, target);
    if (steps.some((step) => step.kind === 'drop-table')) drops += 1;
    if (steps.some((step) => step.kind === 'create-table')) creates += 1;
    if (steps.some((step) => step.kind === 'drop-primary-key')) keyChanges += 1;
    if (
      steps.some(
        (step) =>
          step.kind === 'drop-foreign-key' &&
          surviving.get(keyOf(step.table))?.has(foreignKeyKey(step.foreignKey)) === true,
      )
    ) {
      setAsides += 1;
    }
    if (
      steps.some((step) => step.kind === 'drop-foreign-key' && !targetKeys.has(keyOf(step.table)))
    ) {
      cuts += 1;
    }
  }
  assert.ok(drops > 0, 'the generated pairs must include removed tables');
  assert.ok(creates > 0, 'the generated pairs must include added tables');
  assert.ok(cuts > 0, 'the generated pairs must include removed reference cycles');
  assert.ok(keyChanges > 0, 'the generated pairs must include primary-key changes');
  assert.ok(
    setAsides > 0,
    'the generated pairs must include primary-key changes with surviving foreign keys',
  );
});

test('a new owned sequence is created before its table and attached after it', () => {
  const fresh = table('fresh', { columns: [column('id', { type: 'bigint', notNull: true })] });
  const owned = sequence('fresh_id_seq', { ownedBy: owner('fresh', 'id') });
  const standalone = sequence('standalone');

  // Phase 1 creates both sequences (identity order), phase 3 the table, phase 4 the ownership.
  assertPlan(model(), sequenceModel([standalone, owned], fresh), [
    { kind: 'create-sequence', sequence: unowned(owned) },
    { kind: 'create-sequence', sequence: standalone },
    { kind: 'create-table', table: fresh },
    {
      kind: 'alter-sequence',
      sequence: identity('fresh_id_seq'),
      fields: [{ field: 'ownedBy', after: owner('fresh', 'id') }],
    },
  ]);
});

test('a kept sequence detaches before its removed owner table and re-owns after', () => {
  const oldOwner = table('old_owner', {
    columns: [column('id', { type: 'bigint', notNull: true })],
  });
  const newOwner = table('new_owner', {
    columns: [column('id', { type: 'bigint', notNull: true })],
  });

  assertPlan(
    sequenceModel(
      [sequence('moved_seq', { ownedBy: owner('old_owner', 'id') })],
      oldOwner,
      newOwner,
    ),
    sequenceModel([sequence('moved_seq', { ownedBy: owner('new_owner', 'id') })], newOwner),
    [
      {
        kind: 'alter-sequence',
        sequence: identity('moved_seq'),
        fields: [{ field: 'ownedBy', before: owner('old_owner', 'id') }],
      },
      { kind: 'drop-table', table: identity('old_owner') },
      {
        kind: 'alter-sequence',
        sequence: identity('moved_seq'),
        fields: [
          {
            field: 'ownedBy',
            before: owner('old_owner', 'id'),
            after: owner('new_owner', 'id'),
          },
        ],
      },
    ],
  );
});

test('a kept sequence detaches before its removed owner column', () => {
  const baselineTable = table('t', {
    columns: [column('id', { type: 'bigint', notNull: true }), column('x', { type: 'bigint' })],
  });
  const targetTable = table('t', { columns: [column('x', { type: 'bigint' })] });

  assertPlan(
    sequenceModel([sequence('s', { ownedBy: owner('t', 'id') })], baselineTable),
    sequenceModel([sequence('s')], targetTable),
    [
      {
        kind: 'alter-sequence',
        sequence: identity('s'),
        fields: [{ field: 'ownedBy', before: owner('t', 'id') }],
      },
      {
        kind: 'drop-column',
        table: identity('t'),
        column: column('id', { type: 'bigint', notNull: true }),
      },
    ],
  );
});

test('a removed sequence cascades with its removed owner table and is not dropped explicitly', () => {
  const goneOwner = table('gone_owner', {
    columns: [column('id', { type: 'bigint', notNull: true })],
  });

  assertPlan(
    sequenceModel([sequence('cascaded_seq', { ownedBy: owner('gone_owner', 'id') })], goneOwner),
    model(),
    [{ kind: 'drop-table', table: identity('gone_owner') }],
  );
});

test('a removed sequence cascades with its removed owner column and is not dropped explicitly', () => {
  const baselineTable = table('t', {
    columns: [column('id', { type: 'bigint', notNull: true }), column('x', { type: 'bigint' })],
  });
  const targetTable = table('t', { columns: [column('x', { type: 'bigint' })] });

  assertPlan(
    sequenceModel([sequence('cascaded_seq', { ownedBy: owner('t', 'id') })], baselineTable),
    sequenceModel([], targetTable),
    [
      {
        kind: 'drop-column',
        table: identity('t'),
        column: column('id', { type: 'bigint', notNull: true }),
      },
    ],
  );
});

test('a removed sequence whose owner survives is dropped explicitly, in identity order', () => {
  const surviving = table('t', { columns: [column('id', { type: 'bigint', notNull: true })] });

  assertPlan(
    sequenceModel(
      [sequence('s', { ownedBy: owner('t', 'id') }), sequence('u', { ownedBy: owner('t', 'id') })],
      surviving,
    ),
    model(surviving),
    [
      { kind: 'drop-sequence', sequence: identity('s') },
      { kind: 'drop-sequence', sequence: identity('u') },
    ],
  );
});

test('ownership attaches, then option alters, then sequence drops', () => {
  const t = table('t', {
    columns: [column('id', { type: 'bigint', notNull: true }), column('x', { type: 'bigint' })],
  });

  assertPlan(
    sequenceModel(
      [
        sequence('s1', { ownedBy: owner('t', 'id') }),
        sequence('s2'),
        sequence('s3', { ownedBy: owner('t', 'id') }),
      ],
      t,
    ),
    sequenceModel([sequence('s1', { increment: '5', ownedBy: owner('t', 'x') })], t),
    [
      {
        kind: 'alter-sequence',
        sequence: identity('s1'),
        fields: [{ field: 'ownedBy', before: owner('t', 'id'), after: owner('t', 'x') }],
      },
      {
        kind: 'alter-sequence',
        sequence: identity('s1'),
        fields: [{ field: 'increment', before: '1', after: '5' }],
      },
      { kind: 'drop-sequence', sequence: identity('s2') },
      { kind: 'drop-sequence', sequence: identity('s3') },
    ],
  );
});

test('structurally equal models with sequences in any insertion order plan identically', () => {
  const t = table('t', { columns: [column('id', { type: 'bigint', notNull: true })] });
  const baselineSequences = [sequence('kept', { ownedBy: owner('t', 'id') }), sequence('dropped')];
  const targetSequences = [sequence('kept', { increment: '3', ownedBy: owner('t', 'id') })];

  const forward = plan(sequenceModel(baselineSequences, t), sequenceModel(targetSequences, t));
  const reversed = plan(
    sequenceModel([...baselineSequences].reverse(), t),
    sequenceModel(targetSequences, t),
  );

  assert.deepStrictEqual(reversed, forward);
  assert.deepStrictEqual(
    forward.steps.map((step) => step.kind),
    ['alter-sequence', 'drop-sequence'],
  );
});

test('a deep-frozen model with sequences can be planned, and steps are independent copies', () => {
  const t = table('t', { columns: [column('id', { type: 'bigint', notNull: true })] });
  const source = sequence('s', { ownedBy: owner('t', 'id') });
  const baseline = deepFreeze(sequenceModel([source], t));
  const target = deepFreeze(model(t));

  const { steps } = plan(baseline, target);
  const drop = steps.find((step) => step.kind === 'drop-sequence');
  assert.ok(drop !== undefined, 'the removed sequence is dropped');
  assert.notEqual(drop.sequence, source);
});

test('a deep-frozen model with a changed sequence can be planned without mutation', () => {
  const t = table('t', { columns: [column('id', { type: 'bigint', notNull: true })] });
  const baseline = deepFreeze(sequenceModel([sequence('s', { ownedBy: owner('t', 'id') })], t));
  const target = deepFreeze(sequenceModel([sequence('s', { ownedBy: owner('t', 'other') })], t));

  const { steps } = plan(baseline, target);
  assert.deepStrictEqual(steps, [
    {
      kind: 'alter-sequence',
      sequence: identity('s'),
      fields: [{ field: 'ownedBy', before: owner('t', 'id'), after: owner('t', 'other') }],
    },
  ]);
});

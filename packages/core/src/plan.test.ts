import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canonicalIntType,
  effectiveIdentity,
  effectiveSequence,
  plan,
  sequenceTypeBounds,
  sequenceTypeChange,
} from './index.ts';
import type { Identity, IdentityInput } from './identity.ts';
import type {
  Change,
  ColumnFieldChange,
  IdentityChange,
  IdentityFieldChange,
  SequenceFieldChange,
  TableChange,
} from './diff.ts';
import type { SequenceOptions } from './sequence.ts';
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
import type { ChangeApplication, Step, TransactionGroup } from './plan.ts';
import {
  applyChange,
  assertNever,
  emptyChangeApplication,
  groupSteps,
  TRANSACTIONAL,
} from './plan.ts';

/**
 * Tests for the migration plan: the eight global phases with the fifteen table phases at their
 * center, dependency-ordered table drops, cycle breaking, primary-key changes that set
 * surviving foreign keys aside, sequence ownership detaches and drop suppression, identity
 * drops, additions, alters and conversions, transaction grouping, determinism, and a
 * dependency-invariant simulator run over hand-built cases and seeded pseudo-random model
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
  uniqueConstraints?: readonly UniqueConstraint[];
  checkConstraints?: readonly CheckConstraint[];
  indexes?: readonly Index[];
}

/** A table with the given identity: empty unless parts are supplied. */
const table = (name: string, parts: TableParts = {}): Table => ({
  schema: parts.schema ?? 'public',
  name,
  columns: parts.columns ?? [],
  ...(parts.primaryKey === undefined ? {} : { primaryKey: parts.primaryKey }),
  foreignKeys: parts.foreignKeys ?? [],
  uniqueConstraints: parts.uniqueConstraints ?? [],
  checkConstraints: parts.checkConstraints ?? [],
  indexes: parts.indexes ?? [],
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

/** A unique constraint on `columns`: unnamed unless overridden. */
const uniqueConstraint = (
  columns: readonly string[],
  rest: Partial<Omit<UniqueConstraint, 'columns'>> = {},
): UniqueConstraint => ({ columns, ...rest });

/** A check constraint on `expression`: unnamed unless overridden. */
const checkConstraint = (
  expression: string,
  rest: Partial<Omit<CheckConstraint, 'expression'>> = {},
): CheckConstraint => ({ expression, ...rest });

/** A non-unique index on `columns`: unnamed unless overridden. */
const index = (columns: readonly string[], rest: Partial<Omit<Index, 'columns'>> = {}): Index => ({
  unique: false,
  columns,
  ...rest,
});

/** A model of the given tables. */
const model = (...tables: Table[]): Model => ({ tables, sequences: [] });

/**
 * A sequence named `name`: ascending defaults in range for its data type unless overridden. The
 * default maximum follows `dataType`, so an `integer` sequence gets the integer maximum.
 */
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
  maxValue: sequenceTypeBounds(fields.dataType ?? 'bigint').maxValue,
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

/** An effective identity for an `integer` column, `GENERATED ALWAYS` unless overridden. */
const identityColumn = (fields: Partial<IdentityInput> = {}): Identity =>
  effectiveIdentity('integer', { generated: 'always', ...fields });

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

/**
 * Asserts that planning `baseline` to `target` yields exactly `expected`, in one transactional
 * group: every kind the tests that use this helper plan is transactional, and a plan of
 * `expected.length` steps is a single group. Plans that carry a concurrent index kind assert
 * their steps and groups directly instead.
 */
const assertPlan = (baseline: Model, target: Model, expected: readonly Step[]): void => {
  assert.deepStrictEqual(plan(baseline, target), {
    steps: expected,
    groups: expected.length === 0 ? [] : [{ start: 0, end: expected.length, transactional: true }],
  });
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
 * - a `drop-column` fails while a live foreign key uses the column or references it;
 * - an identity step must name a live column: `drop-identity` and `alter-identity` require a
 *   live identity, `add-identity` installs the step's descriptor, and `alter-identity` applies
 *   its field changes.
 * - a sequence step must name a live sequence: `create-sequence` requires it absent and
 *   ownerless, `drop-sequence` requires it present, and `alter-sequence` applies its field
 *   changes, checking a detach against the step's `before` owner and an attach target against
 *   a live table and column.
 * - `drop-table` and `drop-column` drop every live sequence still owned by the removed owner,
 *   mirroring the engine's ownership cascade.
 *
 * Add and alter steps update the simulated state, so the end state is compared with the target
 * table by table, constraint by constraint, and sequence by sequence. Every removed table must
 * be dropped exactly once, every added table created exactly once, and every added or removed
 * sequence created or dropped exactly once unless the owner's removal cascades it.
 */

/** The mutable shape of a model payload: the model types are readonly, the state is not. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** A live table in the simulated state: columns by name, plus its constraints. */
interface SimulatedTable {
  readonly columns: Map<string, Mutable<Column>>;
  primaryKey: Mutable<PrimaryKey> | undefined;
  readonly foreignKeys: Mutable<ForeignKey>[];
  readonly uniqueConstraints: Mutable<UniqueConstraint>[];
  readonly checkConstraints: Mutable<CheckConstraint>[];
  readonly indexes: Mutable<Index>[];
}

/** The simulated database state: live tables by JSON-encoded identity, plus sequences. */
interface SimulatedState {
  readonly tables: Map<string, SimulatedTable>;
  readonly sequences: Map<string, Mutable<Sequence>>;
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

/** A copy of `uniqueConstraint`, independent of the caller's payload. */
const copyUniqueConstraint = (uniqueConstraint: UniqueConstraint): Mutable<UniqueConstraint> => ({
  ...uniqueConstraint,
  columns: [...uniqueConstraint.columns],
});

/** A copy of `checkConstraint`, independent of the caller's payload. */
const copyCheckConstraint = (checkConstraint: CheckConstraint): Mutable<CheckConstraint> => ({
  ...checkConstraint,
});

/** A copy of `entry`, independent of the caller's payload. */
const copyIndex = (entry: Index): Mutable<Index> => ({
  ...entry,
  columns: [...entry.columns],
});

/** A copy of an identity descriptor, independent of the caller's payload. */
const copyIdentityDescriptor = (identity: Identity): Identity => ({
  ...identity,
  ...(identity.sequenceName === undefined ? {} : { sequenceName: { ...identity.sequenceName } }),
});

/** A copy of `sequence`, independent of the caller's payload, including its owner. */
const copySequenceState = (sequence: Sequence): Mutable<Sequence> => ({
  ...sequence,
  ...(sequence.ownedBy === undefined
    ? {}
    : { ownedBy: { table: { ...sequence.ownedBy.table }, column: sequence.ownedBy.column } }),
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

/** A structural key for a unique constraint, comparing name and columns. */
const uniqueConstraintKey = (uniqueConstraint: UniqueConstraint): string =>
  JSON.stringify([uniqueConstraint.name ?? null, uniqueConstraint.columns]);

/** A structural key for a check constraint, comparing name and expression. */
const checkConstraintKey = (checkConstraint: CheckConstraint): string =>
  JSON.stringify([checkConstraint.name ?? null, checkConstraint.expression]);

/** A structural key for an index; `concurrently` is apply metadata and excluded. */
const indexKey = (entry: Index): string =>
  JSON.stringify([entry.name ?? null, entry.unique, entry.columns]);

/** The simulated state of `model`. */
const stateOf = (model: Model): SimulatedState => {
  const tables = new Map<string, SimulatedTable>();
  for (const source of model.tables) {
    tables.set(keyOf(source), {
      columns: new Map(source.columns.map((entry) => [entry.name, { ...entry }])),
      primaryKey: source.primaryKey === undefined ? undefined : copyPrimaryKey(source.primaryKey),
      foreignKeys: source.foreignKeys.map(copyForeignKey),
      uniqueConstraints: source.uniqueConstraints.map(copyUniqueConstraint),
      checkConstraints: source.checkConstraints.map(copyCheckConstraint),
      indexes: source.indexes.map(copyIndex),
    });
  }
  const sequences = new Map<string, Mutable<Sequence>>();
  for (const source of model.sequences) sequences.set(keyOf(source), copySequenceState(source));
  return { tables, sequences };
};

/**
 * The columns a live foreign key references: its own list, or the referenced table's live
 * primary key when the source omitted them.
 */
const referencedColumnsOf = (foreignKey: ForeignKey, state: SimulatedState): readonly string[] => {
  if (foreignKey.referencedColumns.length > 0) return foreignKey.referencedColumns;
  return state.tables.get(keyOf(foreignKey.referencedTable))?.primaryKey?.columns ?? [];
};

/**
 * Applies one identity field change to `identity`, returning the altered descriptor; the model
 * type is readonly, so every clause produces a fresh object.
 */
const applyIdentityField = (identity: Identity, field: IdentityFieldChange): Identity => {
  switch (field.field) {
    case 'generated':
      return { ...identity, generated: field.after };
    case 'increment':
      return { ...identity, increment: field.after };
    case 'minValue':
      return { ...identity, minValue: field.after };
    case 'maxValue':
      return { ...identity, maxValue: field.after };
    case 'start':
      return { ...identity, start: field.after };
    case 'cache':
      return { ...identity, cache: field.after };
    case 'cycle':
      return { ...identity, cycle: field.after };
    default:
      return assertNever(field, 'identity field');
  }
};

/**
 * Drops every live sequence the engine's ownership cascade would drop with the removed owner:
 * `predicate` selects the live owners a removed table or column covered.
 */
const cascadeOwnedSequences = (
  state: SimulatedState,
  predicate: (ownedBy: SequenceOwner) => boolean,
): void => {
  for (const [key, sequence] of state.sequences) {
    if (sequence.ownedBy !== undefined && predicate(sequence.ownedBy)) state.sequences.delete(key);
  }
};

/**
 * Applies one emitted `ownedBy` field change to `sequence`: a detach (no `after`) requires the
 * live owner to deep-equal the step's `before`; an attach or re-own requires the live owner to
 * be absent or deep-equal `before`, and its target table and column to be live.
 */
const applySequenceOwner = (
  state: SimulatedState,
  sequence: Mutable<Sequence>,
  field: { readonly before?: SequenceOwner; readonly after?: SequenceOwner },
  key: string,
): void => {
  if (field.after === undefined) {
    assert.deepStrictEqual(
      sequence.ownedBy,
      field.before,
      `alter-sequence on ${key} must detach its live owner`,
    );
    delete sequence.ownedBy;
    return;
  }
  if (sequence.ownedBy !== undefined) {
    assert.deepStrictEqual(
      sequence.ownedBy,
      field.before,
      `alter-sequence on ${key} must start from its live owner`,
    );
  }
  const ownerTable = state.tables.get(keyOf(field.after.table));
  assert.ok(
    ownerTable !== undefined && ownerTable.columns.has(field.after.column),
    `alter-sequence on ${key} must own live column ${field.after.column}`,
  );
  sequence.ownedBy = {
    table: { schema: field.after.table.schema, name: field.after.table.name },
    column: field.after.column,
  };
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
        uniqueConstraints: [],
        checkConstraints: [],
        indexes: [],
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
      cascadeOwnedSequences(state, (ownedBy) => sameIdentity(ownedBy.table, step.table));
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
      cascadeOwnedSequences(
        state,
        (ownedBy) => sameIdentity(ownedBy.table, step.table) && ownedBy.column === step.column.name,
      );
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
          default:
            // `case 'default':` above is the column field named 'default'; this `default:` is
            // the exhaustiveness guard and neither shadows the other.
            assertNever(field, 'column field');
        }
      }
      return;
    }
    case 'add-identity': {
      const key = keyOf(step.table);
      const table = state.tables.get(key);
      assert.ok(table !== undefined, `add-identity on missing table ${key}`);
      const altered = table.columns.get(step.name);
      assert.ok(altered !== undefined, `add-identity on missing ${step.name} on ${key}`);
      altered.identity = copyIdentityDescriptor(step.identity);
      return;
    }
    case 'drop-identity': {
      const key = keyOf(step.table);
      const table = state.tables.get(key);
      assert.ok(table !== undefined, `drop-identity on missing table ${key}`);
      const altered = table.columns.get(step.name);
      assert.ok(altered !== undefined, `drop-identity on missing ${step.name} on ${key}`);
      assert.ok(
        altered.identity !== undefined,
        `drop-identity on identity-less ${step.name} on ${key}`,
      );
      delete altered.identity;
      return;
    }
    case 'alter-identity': {
      const key = keyOf(step.table);
      const table = state.tables.get(key);
      assert.ok(table !== undefined, `alter-identity on missing table ${key}`);
      const altered = table.columns.get(step.name);
      assert.ok(altered !== undefined, `alter-identity on missing ${step.name} on ${key}`);
      let identity = altered.identity;
      assert.ok(identity !== undefined, `alter-identity on identity-less ${step.name} on ${key}`);
      for (const field of step.fields) identity = applyIdentityField(identity, field);
      altered.identity = identity;
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
    case 'add-unique-constraint': {
      const key = keyOf(step.table);
      const table = state.tables.get(key);
      assert.ok(table !== undefined, `add-unique-constraint on missing table ${key}`);
      for (const name of step.uniqueConstraint.columns) {
        assert.ok(
          table.columns.has(name),
          `add-unique-constraint on ${key} covering missing column ${name}`,
        );
      }
      const constraintKey = uniqueConstraintKey(step.uniqueConstraint);
      assert.ok(
        !table.uniqueConstraints.some((entry) => uniqueConstraintKey(entry) === constraintKey),
        `add-unique-constraint of live ${constraintKey} on ${key}`,
      );
      table.uniqueConstraints.push(copyUniqueConstraint(step.uniqueConstraint));
      return;
    }
    case 'drop-unique-constraint': {
      const key = keyOf(step.table);
      const table = state.tables.get(key);
      assert.ok(table !== undefined, `drop-unique-constraint on missing table ${key}`);
      const found = table.uniqueConstraints.findIndex(
        (entry) => uniqueConstraintKey(entry) === uniqueConstraintKey(step.uniqueConstraint),
      );
      assert.notEqual(
        found,
        -1,
        `drop-unique-constraint of missing ${uniqueConstraintKey(step.uniqueConstraint)} on ${key}`,
      );
      table.uniqueConstraints.splice(found, 1);
      return;
    }
    case 'add-check-constraint': {
      const key = keyOf(step.table);
      const table = state.tables.get(key);
      assert.ok(table !== undefined, `add-check-constraint on missing table ${key}`);
      const constraintKey = checkConstraintKey(step.checkConstraint);
      assert.ok(
        !table.checkConstraints.some((entry) => checkConstraintKey(entry) === constraintKey),
        `add-check-constraint of live ${constraintKey} on ${key}`,
      );
      table.checkConstraints.push(copyCheckConstraint(step.checkConstraint));
      return;
    }
    case 'drop-check-constraint': {
      const key = keyOf(step.table);
      const table = state.tables.get(key);
      assert.ok(table !== undefined, `drop-check-constraint on missing table ${key}`);
      const found = table.checkConstraints.findIndex(
        (entry) => checkConstraintKey(entry) === checkConstraintKey(step.checkConstraint),
      );
      assert.notEqual(
        found,
        -1,
        `drop-check-constraint of missing ${checkConstraintKey(step.checkConstraint)} on ${key}`,
      );
      table.checkConstraints.splice(found, 1);
      return;
    }
    case 'create-index':
    case 'create-index-concurrently': {
      const key = keyOf(step.table);
      const table = state.tables.get(key);
      assert.ok(table !== undefined, `${step.kind} on missing table ${key}`);
      for (const name of step.index.columns) {
        assert.ok(
          table.columns.has(name),
          `${step.kind} on ${key} covering missing column ${name}`,
        );
      }
      const entryKey = indexKey(step.index);
      assert.ok(
        !table.indexes.some((entry) => indexKey(entry) === entryKey),
        `${step.kind} of live ${entryKey} on ${key}`,
      );
      table.indexes.push(copyIndex(step.index));
      return;
    }
    case 'drop-index':
    case 'drop-index-concurrently': {
      const key = keyOf(step.table);
      const table = state.tables.get(key);
      assert.ok(table !== undefined, `${step.kind} on missing table ${key}`);
      const found = table.indexes.findIndex((entry) => indexKey(entry) === indexKey(step.index));
      assert.notEqual(found, -1, `${step.kind} of missing ${indexKey(step.index)} on ${key}`);
      table.indexes.splice(found, 1);
      return;
    }
    case 'create-sequence': {
      const key = keyOf(step.sequence);
      assert.equal(state.sequences.has(key), false, `create-sequence of live ${key}`);
      assert.equal(
        step.sequence.ownedBy,
        undefined,
        `create-sequence ${key} must carry an ownerless payload`,
      );
      state.sequences.set(key, copySequenceState(step.sequence));
      return;
    }
    case 'drop-sequence': {
      const key = keyOf(step.sequence);
      assert.ok(state.sequences.has(key), `drop-sequence of missing ${key}`);
      state.sequences.delete(key);
      return;
    }
    case 'alter-sequence': {
      const key = keyOf(step.sequence);
      const altered = state.sequences.get(key);
      assert.ok(altered !== undefined, `alter-sequence on missing ${key}`);
      for (const field of step.fields) {
        switch (field.field) {
          case 'ownedBy':
            applySequenceOwner(state, altered, field, key);
            break;
          case 'dataType': {
            // The engine's `AS` change rewrites a bound equal to the old type's bound to the
            // new type's before the step's explicit option clauses land, so a plan may omit a
            // bound the conversion moves.
            const converted = sequenceTypeChange(
              altered.dataType,
              altered.minValue,
              altered.maxValue,
              field.after,
            );
            altered.dataType = field.after;
            if (converted.resetMin) altered.minValue = converted.minValue;
            if (converted.resetMax) altered.maxValue = converted.maxValue;
            break;
          }
          case 'increment':
            altered.increment = field.after;
            break;
          case 'minValue':
            altered.minValue = field.after;
            break;
          case 'maxValue':
            altered.maxValue = field.after;
            break;
          case 'start':
            altered.start = field.after;
            break;
          case 'cache':
            altered.cache = field.after;
            break;
          case 'cycle':
            altered.cycle = field.after;
            break;
          default:
            assertNever(field, 'sequence field');
        }
      }
      return;
    }
    default:
      // Exhaustiveness guard: deleting a case or this clause must fail typecheck/tests (#36).
      assertNever(step, 'step kind');
  }
};

/** Asserts the simulated state and the target model hold the same tables, members, and sequences. */
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
    assert.deepStrictEqual(
      actual.uniqueConstraints.map(uniqueConstraintKey).sort(),
      expected.uniqueConstraints.map(uniqueConstraintKey).sort(),
      `unique constraints of ${key}`,
    );
    assert.deepStrictEqual(
      actual.checkConstraints.map(checkConstraintKey).sort(),
      expected.checkConstraints.map(checkConstraintKey).sort(),
      `check constraints of ${key}`,
    );
    assert.deepStrictEqual(
      actual.indexes.map(indexKey).sort(),
      expected.indexes.map(indexKey).sort(),
      `indexes of ${key}`,
    );
  }
  assert.deepStrictEqual(
    [...state.sequences.keys()].sort(),
    target.sequences.map(keyOf).sort(),
    'the plan must leave exactly the target sequences',
  );
  for (const expected of target.sequences) {
    assert.deepStrictEqual(
      state.sequences.get(keyOf(expected)),
      expected,
      `sequence ${keyOf(expected)}`,
    );
  }
};

/** Plans `baseline` to `target` and runs the whole plan through the simulator. */
const simulate = (baseline: Model, target: Model): void => {
  const { steps } = plan(baseline, target);
  const state = stateOf(baseline);
  const baselineKeys = new Set(baseline.tables.map(keyOf));
  const targetKeys = new Set(target.tables.map(keyOf));
  const baselineSequenceKeys = new Set(baseline.sequences.map(keyOf));
  const targetSequenceKeys = new Set(target.sequences.map(keyOf));
  const targetTables = new Map(target.tables.map((table) => [keyOf(table), table]));
  const dropped = new Map<string, number>();
  const created = new Map<string, number>();
  const sequenceDrops = new Map<string, number>();
  const sequenceCreates = new Map<string, number>();

  /** Whether the plan removes `ownedBy`'s table or column: the drop-suppression rule. */
  const ownerRemoved = (ownedBy: SequenceOwner): boolean => {
    const targetTable = targetTables.get(keyOf(ownedBy.table));
    if (targetTable === undefined) return true;
    return !targetTable.columns.some((column) => column.name === ownedBy.column);
  };

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
    if (step.kind === 'drop-sequence') {
      const key = keyOf(step.sequence);
      sequenceDrops.set(key, (sequenceDrops.get(key) ?? 0) + 1);
    }
    if (step.kind === 'create-sequence') {
      const key = keyOf(step.sequence);
      sequenceCreates.set(key, (sequenceCreates.get(key) ?? 0) + 1);
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

  for (const removed of baseline.sequences) {
    const key = keyOf(removed);
    if (targetSequenceKeys.has(key)) continue;
    // A sequence the plan removes is dropped explicitly unless its owner's removal cascades it.
    if (removed.ownedBy !== undefined && ownerRemoved(removed.ownedBy)) continue;
    assert.equal(
      sequenceDrops.get(key) ?? 0,
      1,
      `removed sequence ${key} must be dropped exactly once`,
    );
  }
  for (const added of target.sequences) {
    const key = keyOf(added);
    if (baselineSequenceKeys.has(key)) continue;
    assert.equal(
      sequenceCreates.get(key) ?? 0,
      1,
      `added sequence ${key} must be created exactly once`,
    );
  }
  for (const key of sequenceDrops.keys()) {
    assert.ok(
      baselineSequenceKeys.has(key) && !targetSequenceKeys.has(key),
      `drop-sequence for neither removed nor kept sequence ${key}`,
    );
  }
  for (const key of sequenceCreates.keys()) {
    assert.ok(
      !baselineSequenceKeys.has(key) && targetSequenceKeys.has(key),
      `create-sequence for neither added nor kept sequence ${key}`,
    );
  }

  assertSameState(state, target);
};

/** Whether the plan drops and re-adds one column's identity: the recreation path. */
const recreatesIdentity = (steps: readonly Step[]): boolean => {
  const dropped = new Set<string>();
  for (const step of steps) {
    if (step.kind === 'drop-identity') {
      dropped.add(`${keyOf(step.table)}:${step.name}`);
    } else if (step.kind === 'add-identity' && dropped.has(`${keyOf(step.table)}:${step.name}`)) {
      return true;
    }
  }
  return false;
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
  readonly uniqueConstraints: Mutable<UniqueConstraint>[];
  readonly checkConstraints: Mutable<CheckConstraint>[];
  readonly indexes: Mutable<Index>[];
}

/** A fresh `prefix`-numbered column name for `table`. */
const freshColumnName = (table: GeneratedTable, prefix: string): string => {
  let index = 0;
  while (table.columns.some((entry) => entry.name === `${prefix}${index}`)) index += 1;
  return `${prefix}${index}`;
};

/** Canonical identity option variations; `{}` resolves to the engine-default descriptor. */
const identityVariations: readonly Partial<IdentityInput>[] = [
  {},
  { generated: 'by default' },
  { increment: '2' },
  { cache: '10' },
  { cycle: true },
];

/** A fresh canonical identity for `tableName`'s `columnName`, sometimes with a stated name. */
const generateIdentity = (tableName: string, columnName: string, random: Random): Identity =>
  identityColumn({
    ...random.pick(identityVariations),
    ...(random.chance(0.6)
      ? { sequenceName: { schema: 'public', name: `${tableName}_${columnName}_seq` } }
      : {}),
  });

/** 1–2 names picked from `columns` without replacement, in pick order. */
const pickColumnNames = (columns: readonly Column[], random: Random): string[] => {
  const pool = columns.map((entry) => entry.name);
  const count = pool.length > 1 && random.chance(0.35) ? 2 : 1;
  const picked: string[] = [];
  for (let index = 0; index < count; index += 1) {
    picked.push(pool.splice(Math.floor(random.next() * pool.length), 1)[0]!);
  }
  return picked;
};

/** One fresh ordered column list for `columns` whose identity is not in `taken`. */
const freshUniqueColumns = (
  columns: readonly Column[],
  taken: ReadonlySet<string>,
  random: Random,
): string[] | undefined => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const picked = pickColumnNames(columns, random);
    if (!taken.has(JSON.stringify(picked))) return picked;
  }
  return undefined;
};

/** 0–2 unique constraints on live `columns` with distinct ordered-column identities. */
const generateUniqueConstraints = (
  tableName: string,
  columns: readonly Column[],
  random: Random,
): Mutable<UniqueConstraint>[] => {
  const constraints: Mutable<UniqueConstraint>[] = [];
  const taken = new Set<string>();
  const count = Math.floor(random.next() * 3);
  for (let index = 0; index < count; index += 1) {
    const picked = freshUniqueColumns(columns, taken, random);
    if (picked === undefined) continue;
    taken.add(JSON.stringify(picked));
    constraints.push({
      columns: picked,
      ...(random.chance(0.5) ? {} : { name: `${tableName}_uq${index}` }),
    });
  }
  return constraints;
};

/** Simple opaque check expressions; generation and mutation step through them to stay distinct. */
const checkExpressions: readonly string[] = ['1 = 1', "'' <> 'x'", '2 > 1', "length('abc') > 0"];

/** 0–2 check constraints with distinct expression identities. */
const generateCheckConstraints = (
  tableName: string,
  random: Random,
): Mutable<CheckConstraint>[] => {
  const constraints: Mutable<CheckConstraint>[] = [];
  const count = Math.floor(random.next() * 3);
  const offset = Math.floor(random.next() * checkExpressions.length);
  for (let index = 0; index < count; index += 1) {
    constraints.push({
      expression: checkExpressions[(offset + index) % checkExpressions.length]!,
      ...(random.chance(0.5) ? {} : { name: `${tableName}_ck${index}` }),
    });
  }
  return constraints;
};

/** 0–2 indexes on live `columns`: named `ix0…`, at most one unnamed, some concurrent. */
const generateIndexes = (columns: readonly Column[], random: Random): Mutable<Index>[] => {
  const indexes: Mutable<Index>[] = [];
  const count = Math.floor(random.next() * 3);
  let unnamed = false;
  for (let index = 0; index < count; index += 1) {
    const name = unnamed || !random.chance(0.6) ? `ix${index}` : undefined;
    if (name === undefined) unnamed = true;
    indexes.push({
      ...(name === undefined ? {} : { name }),
      unique: random.chance(0.4),
      columns: pickColumnNames(columns, random),
      ...(random.chance(0.35) ? { concurrently: true } : {}),
    });
  }
  return indexes;
};

/** A fresh `ix`-numbered name for `table`'s indexes. */
const freshIndexName = (table: GeneratedTable): string => {
  let index = 0;
  while (table.indexes.some((entry) => entry.name === `ix${index}`)) index += 1;
  return `ix${index}`;
};

/**
 * A changed canonical identity for `identity`: exactly one option flips and a stated sequence
 * name survives, so the diff reports a field change, never a recreation.
 */
const alterIdentity = (identity: Identity, random: Random): Identity => {
  const flips: readonly Partial<IdentityInput>[] = [
    { generated: identity.generated === 'always' ? 'by default' : 'always' },
    { increment: identity.increment === '1' ? '2' : '1' },
    { cache: identity.cache === '1' ? '10' : '1' },
    { cycle: !identity.cycle },
  ];
  return identityColumn({
    ...random.pick(flips),
    ...(identity.sequenceName === undefined ? {} : { sequenceName: { ...identity.sequenceName } }),
  });
};

/** A restated identity for the recreation path, or `undefined` when `identity` states no name. */
const recreateIdentity = (identity: Identity, random: Random): Identity | undefined => {
  const stated = identity.sequenceName;
  if (stated === undefined) return undefined;
  return identityColumn({
    ...random.pick(identityVariations),
    sequenceName: { schema: stated.schema, name: `${stated.name}_v2` },
  });
};

/**
 * Drops members that fail `valid` or whose identity key repeats an earlier member's, in place.
 * The keys mirror the diff's matching identities: unique constraints by ordered columns, check
 * constraints by expression, indexes by name with absence distinct.
 */
const retainDistinct = <T>(
  members: T[],
  valid: (member: T) => boolean,
  identityOf: (member: T) => string,
): void => {
  const seen = new Set<string>();
  const kept = members.filter((member) => {
    if (!valid(member)) return false;
    const key = identityOf(member);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  members.length = 0;
  members.push(...kept);
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
 * or alters a text column; drops, adds, or changes unique and check constraints and indexes;
 * drops, adds, alters, or recreates an identity; and drops or changes a foreign key. A primary
 * key is only added when the baseline table had none, and a rename or reorder keeps its column
 * set, so every generated target stays well-formed. An added identity only ever lands on an
 * integer column that never carried one, and an alter or recreation preserves the baseline's
 * sequence-name shape, so the untouched simulator's full-descriptor comparison holds.
 * Foreign-key targets are always a present table's `integer` primary-key columns, so the pair
 * stays well-formed too.
 */
const mutateTable = (
  table: GeneratedTable,
  startedWithPrimaryKey: boolean,
  random: Random,
  textTypes: readonly string[],
): void => {
  const identityBearing = new Set(
    table.columns.filter((entry) => entry.identity !== undefined).map((entry) => entry.name),
  );
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
    if (random.chance(0.5)) {
      const type = random.pick(textTypes);
      if (altered.identity !== undefined && canonicalIntType(type) === undefined) {
        delete altered.identity;
      }
      altered.type = type;
    }
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

  // Identity: drop, alter, or recreate one; add one to an integer column that never had any.
  const identities = table.columns.filter((entry) => entry.identity !== undefined);
  if (identities.length > 0 && random.chance(0.55)) {
    const mutated = random.pick(identities);
    const action = random.next();
    if (action < 0.3) {
      delete mutated.identity;
    } else if (action < 0.8) {
      mutated.identity = alterIdentity(mutated.identity!, random);
    } else {
      mutated.identity =
        recreateIdentity(mutated.identity!, random) ?? alterIdentity(mutated.identity!, random);
    }
  }
  const identityless = table.columns.filter(
    (entry) =>
      entry.identity === undefined &&
      !identityBearing.has(entry.name) &&
      canonicalIntType(entry.type) !== undefined,
  );
  if (identityless.length > 0 && random.chance(0.3)) {
    const added = random.pick(identityless);
    added.identity = generateIdentity(table.name, added.name, random);
  }

  // Unique constraints: drop, change columns or name, or add one with a fresh identity.
  if (table.uniqueConstraints.length > 0 && random.chance(0.35)) {
    table.uniqueConstraints.splice(Math.floor(random.next() * table.uniqueConstraints.length), 1);
  }
  if (table.uniqueConstraints.length > 0 && random.chance(0.3)) {
    const changed = random.pick(table.uniqueConstraints);
    if (random.chance(0.5)) {
      changed.name = `${changed.name ?? 'unnamed'}_changed`;
    } else {
      const taken = new Set(table.uniqueConstraints.map((entry) => JSON.stringify(entry.columns)));
      const picked = freshUniqueColumns(table.columns, taken, random);
      if (picked !== undefined) changed.columns = picked;
    }
  }
  if (table.uniqueConstraints.length < 2 && random.chance(0.3)) {
    const taken = new Set(table.uniqueConstraints.map((entry) => JSON.stringify(entry.columns)));
    const picked = freshUniqueColumns(table.columns, taken, random);
    if (picked !== undefined) {
      table.uniqueConstraints.push({
        columns: picked,
        ...(random.chance(0.5) ? {} : { name: `${table.name}_uq_new` }),
      });
    }
  }

  // Check constraints: drop, change expression or name, or add one with a fresh expression.
  if (table.checkConstraints.length > 0 && random.chance(0.35)) {
    table.checkConstraints.splice(Math.floor(random.next() * table.checkConstraints.length), 1);
  }
  if (table.checkConstraints.length > 0 && random.chance(0.3)) {
    const changed = random.pick(table.checkConstraints);
    if (random.chance(0.5)) {
      changed.name = `${changed.name ?? 'unnamed'}_changed`;
    } else {
      const taken = new Set(table.checkConstraints.map((entry) => entry.expression));
      const fresh = checkExpressions.find((expression) => !taken.has(expression));
      if (fresh !== undefined) changed.expression = fresh;
    }
  }
  if (table.checkConstraints.length < 2 && random.chance(0.3)) {
    const taken = new Set(table.checkConstraints.map((entry) => entry.expression));
    const fresh = checkExpressions.find((expression) => !taken.has(expression));
    if (fresh !== undefined) {
      table.checkConstraints.push({
        expression: fresh,
        ...(random.chance(0.5) ? {} : { name: `${table.name}_ck_new` }),
      });
    }
  }

  // Indexes: drop, change columns or uniqueness (toggling `concurrently` only alongside that
  // structural change), or add one with a fresh name and some concurrency.
  if (table.indexes.length > 0 && random.chance(0.35)) {
    table.indexes.splice(Math.floor(random.next() * table.indexes.length), 1);
  }
  if (table.indexes.length > 0 && random.chance(0.35)) {
    const changed = random.pick(table.indexes);
    if (random.chance(0.5)) {
      changed.unique = !changed.unique;
      if (random.chance(0.4)) {
        changed.concurrently = changed.concurrently === true ? undefined : true;
      }
    } else {
      const previous = JSON.stringify(changed.columns);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const picked = pickColumnNames(table.columns, random);
        if (JSON.stringify(picked) === previous) continue;
        changed.columns = picked;
        if (random.chance(0.4)) {
          changed.concurrently = changed.concurrently === true ? undefined : true;
        }
        break;
      }
    }
  }
  if (table.indexes.length < 2 && random.chance(0.3)) {
    const hasUnnamed = table.indexes.some((entry) => entry.name === undefined);
    const name = !hasUnnamed && random.chance(0.3) ? undefined : freshIndexName(table);
    table.indexes.push({
      ...(name === undefined ? {} : { name }),
      unique: random.chance(0.4),
      columns: pickColumnNames(table.columns, random),
      ...(random.chance(0.4) ? { concurrently: true } : {}),
    });
  }
};

/** Canonical sequence option variations; every pick resolves through `effectiveSequence`. */
const sequenceVariations: readonly SequenceOptions[] = [
  {},
  { dataType: 'integer' },
  { dataType: 'smallint' },
  { increment: '2' },
  { increment: '-1' },
  { cache: '10' },
  { cycle: true },
  { start: '5' },
  { dataType: 'integer', increment: '2' },
  { dataType: 'smallint', increment: '-1' },
  { dataType: 'integer', maxValue: '1000' },
  { minValue: '2', start: '5' },
];

/** A canonical `public` sequence named `name`, with a random option variation and owner. */
const generateSequence = (
  name: string,
  ownedBy: SequenceOwner | undefined,
  random: Random,
): Mutable<Sequence> =>
  effectiveSequence({
    schema: 'public',
    name,
    ...random.pick(sequenceVariations),
    ...(ownedBy === undefined ? {} : { ownedBy }),
  });

/** Every owner a generated table can supply: one per `public` table column. */
const sequenceOwnerCandidates = (
  tables: readonly {
    readonly name: string;
    readonly columns: readonly { readonly name: string }[];
  }[],
): SequenceOwner[] =>
  tables.flatMap((table) => table.columns.map((column) => owner(table.name, column.name)));

/**
 * The pair's sequences: a pool of two identities, each independently present on each side with
 * a canonical option variation and an optional owner. A baseline sequence sometimes owns a
 * column the target removes, so a kept sequence has to detach and a removed one cascades; a
 * target owner always names a live target column.
 */
const generateSequences = (
  baselineTables: readonly Table[],
  target: ReadonlyMap<string, GeneratedTable>,
  random: Random,
): { baseline: Mutable<Sequence>[]; target: Mutable<Sequence>[] } => {
  const baselineOwners = sequenceOwnerCandidates(baselineTables);
  const targetOwners = sequenceOwnerCandidates([...target.values()]);
  const removedOwners: SequenceOwner[] = [];
  for (const source of baselineTables) {
    const kept = target.get(source.name);
    if (kept === undefined) {
      removedOwners.push(...source.columns.map((column) => owner(source.name, column.name)));
      continue;
    }
    const liveColumns = new Set(kept.columns.map((column) => column.name));
    for (const column of source.columns) {
      if (!liveColumns.has(column.name)) removedOwners.push(owner(source.name, column.name));
    }
  }

  const pickOwner = (
    candidates: readonly SequenceOwner[],
    probability: number,
  ): SequenceOwner | undefined =>
    candidates.length > 0 && random.chance(probability) ? random.pick(candidates) : undefined;

  const baseline: Mutable<Sequence>[] = [];
  const targetSequences: Mutable<Sequence>[] = [];
  for (const name of ['sq0', 'sq1']) {
    if (random.chance(0.75)) {
      // A removed owner forces a detach (kept sequence) or a cascade (removed sequence);
      // otherwise the owner is usually one that survives the pair.
      const removed = pickOwner(removedOwners, 0.6);
      baseline.push(generateSequence(name, removed ?? pickOwner(baselineOwners, 0.6), random));
    }
    if (random.chance(0.75)) {
      targetSequences.push(generateSequence(name, pickOwner(targetOwners, 0.6), random));
    }
  }
  return { baseline, target: targetSequences };
};

/**
 * Re-validates every sequence owner against `tables`: an owner naming a table or column the
 * side lacks is re-owned on a live column, or dropped when the side has no columns at all.
 */
const revalidateSequenceOwners = (
  sequences: readonly Mutable<Sequence>[],
  tables: readonly {
    readonly name: string;
    readonly columns: readonly { readonly name: string }[];
  }[],
  random: Random,
): void => {
  const candidates = sequenceOwnerCandidates(tables);
  for (const sequence of sequences) {
    const ownedBy = sequence.ownedBy;
    if (ownedBy === undefined) continue;
    const ownerTable = tables.find((table) => table.name === ownedBy.table.name);
    if (ownerTable?.columns.some((column) => column.name === ownedBy.column) === true) continue;
    const replacement = candidates.length === 0 ? undefined : random.pick(candidates);
    if (replacement === undefined) delete sequence.ownedBy;
    else sequence.ownedBy = { table: { ...replacement.table }, column: replacement.column };
  }
};

/**
 * One well-formed pseudo-random pair: 2–6 baseline tables carrying unique and check
 * constraints, indexes, and occasional identity columns; every foreign key pointing at a
 * present table's `integer` primary-key columns (single-column or composite), a target built
 * from kept, removed, changed, and added tables, target foreign keys that never reference
 * a removed table or a dropped primary key, and 0–2 sequences per side with canonical options
 * and owners (kept, changed, dropped, added, attached, detached, transferred, and cascaded).
 * Constraints and indexes on the target reference only live columns. Table order is shuffled
 * so the planner sees arbitrary insertion orders.
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
    const identityColumnName = random.chance(0.4) ? random.pick(keyColumns) : undefined;
    const columns: Column[] = keyColumns.map((columnName) =>
      column(columnName, {
        type: 'integer',
        notNull: true,
        ...(columnName === identityColumnName
          ? { identity: generateIdentity(name, columnName, random) }
          : {}),
      }),
    );
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
      uniqueConstraints: generateUniqueConstraints(name, columns, random),
      checkConstraints: generateCheckConstraints(name, random),
      indexes: generateIndexes(columns, random),
    });
  });

  const target = new Map<string, GeneratedTable>();
  for (const source of baselineTables) {
    if (random.chance(0.25)) continue;
    const generated: GeneratedTable = {
      name: source.name,
      columns: source.columns.map((entry) => ({
        ...entry,
        ...(entry.identity === undefined
          ? {}
          : { identity: copyIdentityDescriptor(entry.identity) }),
      })),
      primaryKey: source.primaryKey === undefined ? undefined : copyPrimaryKey(source.primaryKey),
      foreignKeys: source.foreignKeys.map(copyForeignKey),
      uniqueConstraints: source.uniqueConstraints.map(copyUniqueConstraint),
      checkConstraints: source.checkConstraints.map(copyCheckConstraint),
      indexes: source.indexes.map(copyIndex),
    };
    if (random.chance(0.55))
      mutateTable(generated, hasPrimaryKey.get(source.name) === true, random, textTypes);
    target.set(source.name, generated);
  }

  for (let index = 0; index < 2 && random.chance(0.3); index += 1) {
    const name = `u${index}`;
    const columns: Column[] = [
      column('id', {
        type: 'integer',
        notNull: true,
        ...(random.chance(0.4) ? { identity: generateIdentity(name, 'id', random) } : {}),
      }),
    ];
    if (random.chance(0.5)) columns.push(column('e0', { type: random.pick(textTypes) }));
    const composite = random.chance(0.3);
    if (composite) columns.push(column('k2', { type: 'integer', notNull: true }));
    target.set(name, {
      name,
      columns,
      primaryKey: { name: `${name}_pkey`, columns: composite ? ['id', 'k2'] : ['id'] },
      foreignKeys: [],
      uniqueConstraints: generateUniqueConstraints(name, columns, random),
      checkConstraints: generateCheckConstraints(name, random),
      indexes: generateIndexes(columns, random),
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

  // Final well-formedness sweep, mirroring the foreign-key filter: constraints and indexes
  // reference only live columns and keep distinct matching identities (at most one unnamed
  // index), and identities stay on integer-family columns.
  for (const generated of target.values()) {
    const columnNames = new Set(generated.columns.map((entry) => entry.name));
    retainDistinct(
      generated.uniqueConstraints,
      (constraint) => constraint.columns.every((name) => columnNames.has(name)),
      (constraint) => JSON.stringify(constraint.columns),
    );
    retainDistinct(
      generated.checkConstraints,
      () => true,
      (constraint) => JSON.stringify(constraint.expression),
    );
    retainDistinct(
      generated.indexes,
      (member) => member.columns.every((name) => columnNames.has(name)),
      (member) => JSON.stringify([member.name]),
    );
    for (const entry of generated.columns) {
      if (entry.identity !== undefined && canonicalIntType(entry.type) === undefined) {
        delete entry.identity;
      }
    }
  }

  // Sequences: 0–2 canonical sequences per side, with owners re-validated against each side.
  const { baseline: baselineSequences, target: targetSequences } = generateSequences(
    baselineTables,
    target,
    random,
  );
  revalidateSequenceOwners(baselineSequences, baselineTables, random);
  revalidateSequenceOwners(targetSequences, [...target.values()], random);

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
      uniqueConstraints: generated.uniqueConstraints,
      checkConstraints: generated.checkConstraints,
      indexes: generated.indexes,
    });

  return {
    baseline: {
      tables: shuffle(baselineTables),
      sequences: baselineSequences,
    },
    target: {
      tables: shuffle([...target.values()].map(toTable)),
      sequences: targetSequences,
    },
  };
};

test('transaction groups coalesce consecutive transactional steps and isolate the rest', () => {
  const steps: readonly Step[] = [
    { kind: 'create-table', table: table('a') },
    { kind: 'create-table', table: table('b') },
    { kind: 'drop-table', table: identity('c') },
    { kind: 'create-table', table: table('d') },
  ];

  assert.deepStrictEqual(
    groupSteps(steps, (step) => step.kind !== 'drop-table'),
    [
      { start: 0, end: 2, transactional: true },
      { start: 2, end: 3, transactional: false },
      { start: 3, end: 4, transactional: true },
    ],
  );
});

test('transaction groups are non-empty and tile the step list in order', () => {
  const steps: readonly Step[] = [
    { kind: 'drop-table', table: identity('a') },
    { kind: 'create-table', table: table('b') },
    { kind: 'add-column', table: identity('b'), column: column('x') },
    { kind: 'drop-table', table: identity('c') },
    { kind: 'drop-table', table: identity('d') },
    { kind: 'create-table', table: table('e') },
  ];
  const groups: readonly TransactionGroup[] = groupSteps(
    steps,
    (step) => step.kind !== 'drop-table',
  );

  assert.deepStrictEqual(groups, [
    { start: 0, end: 1, transactional: false },
    { start: 1, end: 3, transactional: true },
    { start: 3, end: 4, transactional: false },
    { start: 4, end: 5, transactional: false },
    { start: 5, end: 6, transactional: true },
  ]);

  let cursor = 0;
  for (const group of groups) {
    assert.equal(group.start, cursor, 'each group must start where the previous one ended');
    assert.ok(group.end > group.start, 'every group must be non-empty');
    cursor = group.end;
  }
  assert.equal(cursor, steps.length, 'the groups must cover every step');
});

test('an all-transactional step list is one group', () => {
  const steps: readonly Step[] = [
    { kind: 'create-table', table: table('a') },
    { kind: 'drop-table', table: identity('b') },
    { kind: 'create-table', table: table('c') },
  ];

  assert.deepStrictEqual(groupSteps(steps), [{ start: 0, end: 3, transactional: true }]);
});

test('a classification with no transactional step makes one group per step', () => {
  const steps: readonly Step[] = [
    { kind: 'create-table', table: table('a') },
    { kind: 'drop-table', table: identity('b') },
    { kind: 'create-table', table: table('c') },
  ];

  assert.deepStrictEqual(
    groupSteps(steps, () => false),
    [
      { start: 0, end: 1, transactional: false },
      { start: 1, end: 2, transactional: false },
      { start: 2, end: 3, transactional: false },
    ],
  );
});

test('an empty step list has no transaction groups', () => {
  assert.deepStrictEqual(groupSteps([]), []);
  assert.deepStrictEqual(
    groupSteps([], () => false),
    [],
  );
});

test('every current step kind is classified, and only the concurrent kinds stand alone', () => {
  const kinds: readonly Step['kind'][] = [
    'create-table',
    'drop-table',
    'add-column',
    'drop-column',
    'alter-column',
    'add-identity',
    'drop-identity',
    'alter-identity',
    'add-primary-key',
    'drop-primary-key',
    'add-foreign-key',
    'drop-foreign-key',
    'add-unique-constraint',
    'drop-unique-constraint',
    'add-check-constraint',
    'drop-check-constraint',
    'create-index',
    'drop-index',
    'create-index-concurrently',
    'drop-index-concurrently',
    'create-sequence',
    'drop-sequence',
    'alter-sequence',
  ];

  assert.equal(kinds.length, 23);
  assert.deepStrictEqual(Object.keys(TRANSACTIONAL).sort(), [...kinds].sort());
  for (const kind of kinds) {
    const standalone = kind === 'create-index-concurrently' || kind === 'drop-index-concurrently';
    assert.equal(TRANSACTIONAL[kind], !standalone, kind);
  }
});

test('an unknown step kind is rejected by the exhaustiveness guard', () => {
  const state = stateOf(model());

  assert.throws(
    () => applyStep(state, { kind: 'frobnicate' } as unknown as Step),
    /Unhandled step kind: frobnicate/,
  );
});

test('an unknown identity field is rejected by the exhaustiveness guard', () => {
  assert.throws(
    () =>
      applyIdentityField(identityColumn(), {
        field: 'frobnicate',
      } as unknown as IdentityFieldChange),
    /Unhandled identity field: frobnicate/,
  );
});

test('an unknown column field is rejected by the exhaustiveness guard', () => {
  const state = stateOf(model(table('t', { columns: [column('id')] })));

  assert.throws(
    () =>
      applyStep(state, {
        kind: 'alter-column',
        table: identity('t'),
        name: 'id',
        fields: [{ field: 'frobnicate' }],
      } as unknown as Step),
    /Unhandled column field: frobnicate/,
  );
});

test('an unknown sequence field is rejected by the exhaustiveness guard', () => {
  const state = stateOf(sequenceModel([sequence('sq')]));

  assert.throws(
    () =>
      applyStep(state, {
        kind: 'alter-sequence',
        sequence: { schema: 'public', name: 'sq' },
        fields: [{ field: 'frobnicate' }],
      } as unknown as Step),
    /Unhandled sequence field: frobnicate/,
  );
});

test('plan partitions a mixed migration into one transactional group', () => {
  const baseline = model(
    table('kept', { columns: [column('id'), column('extra')] }),
    table('gone', { columns: [column('id')] }),
  );
  const target = model(
    table('kept', {
      columns: [column('id'), column('extra', { type: 'numeric(12,2)', notNull: true })],
    }),
    table('fresh', { columns: [column('id')] }),
  );

  const { steps, groups } = plan(baseline, target);
  assert.ok(steps.length > 1, 'the mixed migration must carry more than one step');
  assert.deepStrictEqual(groups, [{ start: 0, end: steps.length, transactional: true }]);

  const empty = plan(model(), model());
  assert.deepStrictEqual(empty, { steps: [], groups: [] });
});

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
        uniqueConstraints: [],
        checkConstraints: [],
        indexes: [],
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
        uniqueConstraints: [],
        checkConstraints: [],
        indexes: [],
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

test('a changed foreign key drops in phase 1 and adds in phase 15, around column work', () => {
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

test('column payloads in steps carry an independent identity', () => {
  const sourceIdentity = () => identityColumn({ sequenceName: identity('t_id_seq') });
  const gone = column('gone', { type: 'integer', notNull: true, identity: sourceIdentity() });
  const fresh = column('fresh', { type: 'integer', notNull: true, identity: sourceIdentity() });
  const freshTableColumn = column('id', {
    type: 'integer',
    notNull: true,
    identity: sourceIdentity(),
  });

  const baseline = model(table('t', { columns: [gone] }));
  const target = model(
    table('t', { columns: [fresh] }),
    table('u', { columns: [freshTableColumn] }),
  );

  const { steps } = plan(baseline, target);
  const dropColumn = steps.find((step) => step.kind === 'drop-column');
  const addColumn = steps.find((step) => step.kind === 'add-column');
  const createTable = steps.find((step) => step.kind === 'create-table');

  const cases: (readonly [Identity, Identity])[] = [];
  assert.equal(dropColumn?.kind, 'drop-column');
  if (dropColumn?.kind === 'drop-column') cases.push([dropColumn.column.identity!, gone.identity!]);
  assert.equal(addColumn?.kind, 'add-column');
  if (addColumn?.kind === 'add-column') cases.push([addColumn.column.identity!, fresh.identity!]);
  assert.equal(createTable?.kind, 'create-table');
  if (createTable?.kind === 'create-table') {
    cases.push([createTable.table.columns[0]!.identity!, freshTableColumn.identity!]);
  }
  assert.equal(cases.length, 3);

  for (const [payload, source] of cases) {
    // Distinct objects at every level, in both directions.
    assert.notEqual(payload, source);
    assert.notEqual(payload.sequenceName, source.sequenceName);

    (payload as Mutable<Identity>).increment = '9';
    (payload.sequenceName as Mutable<SequenceIdentity>).name = 'payload';
    assert.equal(source.increment, '1');
    assert.equal(source.sequenceName?.name, 't_id_seq');

    (source as Mutable<Identity>).increment = '7';
    (source.sequenceName as Mutable<SequenceIdentity>).name = 'model';
    assert.equal(payload.increment, '9');
    assert.equal(payload.sequenceName?.name, 'payload');
  }
});

test('a mixed migration pins the exact step sequence across the nine original table phases', () => {
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
        uniqueConstraints: [],
        checkConstraints: [],
        indexes: [],
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

test('an added table attaches its constraints and indexes in phase order', () => {
  const unique = uniqueConstraint(['email'], { name: 'users_email_key' });
  const check = checkConstraint('length(email) > 0', { name: 'users_email_check' });
  const entry = index(['email'], { name: 'users_email_idx' });
  const columns = [column('email')];
  const users = table('users', {
    columns,
    uniqueConstraints: [unique],
    checkConstraints: [check],
    indexes: [entry],
  });

  assertPlan(model(), model(users), [
    {
      kind: 'create-table',
      table: {
        schema: 'public',
        name: 'users',
        columns,
        foreignKeys: [],
        uniqueConstraints: [],
        checkConstraints: [],
        indexes: [],
      },
    },
    { kind: 'add-unique-constraint', table: identity('users'), uniqueConstraint: unique },
    { kind: 'add-check-constraint', table: identity('users'), checkConstraint: check },
    { kind: 'create-index', table: identity('users'), index: entry },
  ]);
  simulate(model(), model(users));
});

test('a removed table carries its constraints and indexes away without member drops', () => {
  const columns = [column('a'), column('b')];
  const gone = table('gone', {
    columns,
    uniqueConstraints: [uniqueConstraint(['a'], { name: 'gone_a_key' })],
    checkConstraints: [checkConstraint('a > 0', { name: 'gone_a_check' })],
    indexes: [index(['b'], { name: 'gone_b_idx' })],
  });

  // The table drop cascades its members, so the plan emits exactly one step: per-member drops
  // would fail after the table is gone.
  assertPlan(model(gone), model(), [{ kind: 'drop-table', table: identity('gone') }]);
  simulate(model(gone), model());
});

test('a unique constraint add, change, or drop becomes its own step', () => {
  const columns = [column('email')];
  const without = table('users', { columns });
  const unnamed = table('users', { columns, uniqueConstraints: [uniqueConstraint(['email'])] });
  const named = table('users', {
    columns,
    uniqueConstraints: [uniqueConstraint(['email'], { name: 'users_email_key' })],
  });

  assertPlan(model(without), model(unnamed), [
    {
      kind: 'add-unique-constraint',
      table: identity('users'),
      uniqueConstraint: uniqueConstraint(['email']),
    },
  ]);
  assertPlan(model(named), model(without), [
    {
      kind: 'drop-unique-constraint',
      table: identity('users'),
      uniqueConstraint: uniqueConstraint(['email'], { name: 'users_email_key' }),
    },
  ]);
  assertPlan(model(unnamed), model(named), [
    {
      kind: 'drop-unique-constraint',
      table: identity('users'),
      uniqueConstraint: uniqueConstraint(['email']),
    },
    {
      kind: 'add-unique-constraint',
      table: identity('users'),
      uniqueConstraint: uniqueConstraint(['email'], { name: 'users_email_key' }),
    },
  ]);
  simulate(model(unnamed), model(named));
});

test('a check constraint add, change, or drop becomes its own step', () => {
  const columns = [column('price')];
  const without = table('orders', { columns });
  const strict = table('orders', { columns, checkConstraints: [checkConstraint('price > 0')] });
  const loose = table('orders', {
    columns,
    checkConstraints: [checkConstraint('price >= 0', { name: 'orders_price_check' })],
  });

  assertPlan(model(without), model(strict), [
    {
      kind: 'add-check-constraint',
      table: identity('orders'),
      checkConstraint: checkConstraint('price > 0'),
    },
  ]);
  assertPlan(model(loose), model(without), [
    {
      kind: 'drop-check-constraint',
      table: identity('orders'),
      checkConstraint: checkConstraint('price >= 0', { name: 'orders_price_check' }),
    },
  ]);
  // A changed expression is a removal and an addition, never a rename.
  assertPlan(model(strict), model(loose), [
    {
      kind: 'drop-check-constraint',
      table: identity('orders'),
      checkConstraint: checkConstraint('price > 0'),
    },
    {
      kind: 'add-check-constraint',
      table: identity('orders'),
      checkConstraint: checkConstraint('price >= 0', { name: 'orders_price_check' }),
    },
  ]);
  simulate(model(strict), model(loose));
});

test('an index add or drop becomes its own step', () => {
  const columns = [column('email')];
  const entry = index(['email'], { name: 'users_email_idx', unique: true });
  const without = table('users', { columns });
  const withIndex = table('users', { columns, indexes: [entry] });

  assertPlan(model(without), model(withIndex), [
    { kind: 'create-index', table: identity('users'), index: entry },
  ]);
  assertPlan(model(withIndex), model(without), [
    { kind: 'drop-index', table: identity('users'), index: entry },
  ]);
  simulate(model(without), model(withIndex));
  simulate(model(withIndex), model(without));
});

test('a changed index decomposes into a drop and a create', () => {
  const columns = [column('a'), column('b')];
  const before = index(['a'], { name: 't_idx' });
  const after = index(['a', 'b'], { name: 't_idx', unique: true });
  const baseline = table('t', { columns, indexes: [before] });
  const target = table('t', { columns, indexes: [after] });

  assertPlan(model(baseline), model(target), [
    { kind: 'drop-index', table: identity('t'), index: before },
    { kind: 'create-index', table: identity('t'), index: after },
  ]);
  simulate(model(baseline), model(target));
});

test('an added concurrent index stands alone after the transactional steps', () => {
  const columns = [column('email')];
  const entry = index(['email'], { name: 'users_email_idx', concurrently: true });
  const users = table('users', { columns, indexes: [entry] });

  const { steps, groups } = plan(model(), model(users));
  assert.deepStrictEqual(steps, [
    {
      kind: 'create-table',
      table: {
        schema: 'public',
        name: 'users',
        columns,
        foreignKeys: [],
        uniqueConstraints: [],
        checkConstraints: [],
        indexes: [],
      },
    },
    { kind: 'create-index-concurrently', table: identity('users'), index: entry },
  ]);
  assert.deepStrictEqual(groups, [
    { start: 0, end: 1, transactional: true },
    { start: 1, end: 2, transactional: false },
  ]);
  simulate(model(), model(users));
});

test('a dropped concurrent index is a standalone step', () => {
  const columns = [column('email')];
  const entry = index(['email'], { name: 'users_email_idx', concurrently: true });
  const users = table('users', { columns, indexes: [entry] });

  const { steps, groups } = plan(model(users), model(table('users', { columns })));
  assert.deepStrictEqual(steps, [
    { kind: 'drop-index-concurrently', table: identity('users'), index: entry },
  ]);
  assert.deepStrictEqual(groups, [{ start: 0, end: 1, transactional: false }]);
  simulate(model(users), model(table('users', { columns })));
});

test('a changed index takes each flag from its own side', () => {
  const columns = [column('a'), column('b')];
  const source = index(['a'], { name: 't_idx' });
  const sourceConcurrent = index(['a'], { name: 't_idx', concurrently: true });
  const target = index(['a', 'b'], { name: 't_idx' });
  const targetConcurrent = index(['a', 'b'], { name: 't_idx', concurrently: true });
  const lazySource = table('t', { columns, indexes: [source] });
  const concurrentSource = table('t', { columns, indexes: [sourceConcurrent] });
  const lazyTarget = table('t', { columns, indexes: [target] });
  const concurrentTarget = table('t', { columns, indexes: [targetConcurrent] });

  // The baseline's flag drives the drop; the target's flag drives the create.
  const escalating = plan(model(lazySource), model(concurrentTarget));
  assert.deepStrictEqual(escalating.steps, [
    { kind: 'drop-index', table: identity('t'), index: source },
    { kind: 'create-index-concurrently', table: identity('t'), index: targetConcurrent },
  ]);
  assert.deepStrictEqual(escalating.groups, [
    { start: 0, end: 1, transactional: true },
    { start: 1, end: 2, transactional: false },
  ]);

  const settling = plan(model(concurrentSource), model(lazyTarget));
  assert.deepStrictEqual(settling.steps, [
    { kind: 'drop-index-concurrently', table: identity('t'), index: sourceConcurrent },
    { kind: 'create-index', table: identity('t'), index: target },
  ]);
  assert.deepStrictEqual(settling.groups, [
    { start: 0, end: 1, transactional: false },
    { start: 1, end: 2, transactional: true },
  ]);
  simulate(model(concurrentSource), model(lazyTarget));
});

test('an index flag-only difference produces no plan', () => {
  const columns = [column('a')];
  const lazy = table('t', { columns, indexes: [index(['a'], { name: 't_idx' })] });
  const concurrent = table('t', {
    columns,
    indexes: [index(['a'], { name: 't_idx', concurrently: true })],
  });

  assertPlan(model(lazy), model(concurrent), []);
  assertPlan(model(concurrent), model(lazy), []);
});

test('a mixed migration pins the exact step sequence across all fifteen table phases', () => {
  const parent = table('parent', {
    columns: [column('id', { type: 'integer', notNull: true })],
    primaryKey: { name: 'parent_pkey', columns: ['id'] },
  });

  const goneForeignKey = foreignKey(['parent_id'], identity('parent'), {
    name: 'gone_parent_id_fkey',
    referencedColumns: ['id'],
  });
  const gone = table('gone', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('parent_id', { type: 'integer' }),
    ],
    primaryKey: { name: 'gone_pkey', columns: ['id'] },
    foreignKeys: [goneForeignKey],
  });

  const obsoleteKey = uniqueConstraint(['obsolete'], { name: 'kept_obsolete_key' });
  const obsoleteCheck = checkConstraint('obsolete > 0', { name: 'kept_obsolete_check' });
  const obsoleteIndex = index(['obsolete'], { name: 'kept_obsolete_idx' });
  const obsoleteForeignKey = foreignKey(['obsolete'], identity('parent'), {
    name: 'kept_obsolete_fkey',
    referencedColumns: ['id'],
  });
  const keptBefore = table('kept', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('obsolete', { type: 'integer' }),
      column('note'),
      column('target_id', { type: 'integer' }),
    ],
    primaryKey: { name: 'kept_pkey', columns: ['id'] },
    foreignKeys: [obsoleteForeignKey],
    uniqueConstraints: [obsoleteKey],
    checkConstraints: [obsoleteCheck],
    indexes: [obsoleteIndex],
  });

  const liveForeignKey = foreignKey(['target_id'], identity('parent'), {
    name: 'kept_target_id_fkey',
    referencedColumns: ['id'],
  });
  const liveKey = uniqueConstraint(['target_id'], { name: 'kept_target_id_key' });
  const liveCheck = checkConstraint('target_id > 0', { name: 'kept_target_id_check' });
  const liveIndex = index(['target_id'], { name: 'kept_target_id_idx' });
  const keptAfter = table('kept', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('note', { type: 'character varying(12)' }),
      column('target_id', { type: 'integer' }),
      column('fresh', { type: 'integer' }),
    ],
    primaryKey: { name: 'kept_pkey', columns: ['id', 'fresh'] },
    foreignKeys: [liveForeignKey],
    uniqueConstraints: [liveKey],
    checkConstraints: [liveCheck],
    indexes: [liveIndex],
  });

  const freshForeignKey = foreignKey(['parent_id'], identity('parent'), {
    name: 'fresh_parent_id_fkey',
    referencedColumns: ['id'],
  });
  const freshKey = uniqueConstraint(['id'], { name: 'fresh_id_key' });
  const freshCheck = checkConstraint('id > 0', { name: 'fresh_id_check' });
  const freshIndex = index(['parent_id'], { name: 'fresh_parent_id_idx' });
  const fresh = table('fresh', {
    columns: [
      column('id', { type: 'integer', notNull: true }),
      column('parent_id', { type: 'integer' }),
    ],
    primaryKey: { name: 'fresh_pkey', columns: ['id'] },
    foreignKeys: [freshForeignKey],
    uniqueConstraints: [freshKey],
    checkConstraints: [freshCheck],
    indexes: [freshIndex],
  });

  const baseline = model(keptBefore, gone, parent);
  const target = model(keptAfter, fresh, parent);

  assertPlan(baseline, target, [
    // Phase 1: drop-foreign-key.
    { kind: 'drop-foreign-key', table: identity('kept'), foreignKey: obsoleteForeignKey },
    // Phase 2: drop-index.
    { kind: 'drop-index', table: identity('kept'), index: obsoleteIndex },
    // Phase 3: drop-check-constraint.
    { kind: 'drop-check-constraint', table: identity('kept'), checkConstraint: obsoleteCheck },
    // Phase 4: drop-unique-constraint.
    { kind: 'drop-unique-constraint', table: identity('kept'), uniqueConstraint: obsoleteKey },
    // Phase 5: drop-table.
    { kind: 'drop-table', table: identity('gone') },
    // Phase 6: drop-primary-key.
    {
      kind: 'drop-primary-key',
      table: identity('kept'),
      primaryKey: { name: 'kept_pkey', columns: ['id'] },
    },
    // Phase 7: drop-column.
    {
      kind: 'drop-column',
      table: identity('kept'),
      column: column('obsolete', { type: 'integer' }),
    },
    // Phase 8: create-table.
    {
      kind: 'create-table',
      table: {
        schema: 'public',
        name: 'fresh',
        columns: [
          column('id', { type: 'integer', notNull: true }),
          column('parent_id', { type: 'integer' }),
        ],
        primaryKey: { name: 'fresh_pkey', columns: ['id'] },
        foreignKeys: [],
        uniqueConstraints: [],
        checkConstraints: [],
        indexes: [],
      },
    },
    // Phase 9: add-column.
    { kind: 'add-column', table: identity('kept'), column: column('fresh', { type: 'integer' }) },
    // Phase 10: alter-column.
    {
      kind: 'alter-column',
      table: identity('kept'),
      name: 'note',
      fields: [{ field: 'type', before: 'text', after: 'character varying(12)' }],
    },
    // Phase 11: add-primary-key.
    {
      kind: 'add-primary-key',
      table: identity('kept'),
      primaryKey: { name: 'kept_pkey', columns: ['id', 'fresh'] },
    },
    // Phase 12: add-unique-constraint, in diff order (fresh before kept).
    { kind: 'add-unique-constraint', table: identity('fresh'), uniqueConstraint: freshKey },
    { kind: 'add-unique-constraint', table: identity('kept'), uniqueConstraint: liveKey },
    // Phase 13: add-check-constraint.
    { kind: 'add-check-constraint', table: identity('fresh'), checkConstraint: freshCheck },
    { kind: 'add-check-constraint', table: identity('kept'), checkConstraint: liveCheck },
    // Phase 14: create-index.
    { kind: 'create-index', table: identity('fresh'), index: freshIndex },
    { kind: 'create-index', table: identity('kept'), index: liveIndex },
    // Phase 15: add-foreign-key.
    { kind: 'add-foreign-key', table: identity('fresh'), foreignKey: freshForeignKey },
    { kind: 'add-foreign-key', table: identity('kept'), foreignKey: liveForeignKey },
  ]);
  simulate(baseline, target);
});

test('a deep-frozen model with constraints and indexes can be planned, and steps carry copies', () => {
  const sourceUnique = uniqueConstraint(['email'], { name: 'users_email_key' });
  const sourceCheck = checkConstraint('length(email) > 0', { name: 'users_email_check' });
  const sourceIndex = index(['email'], { name: 'users_email_idx' });
  const baseline = deepFreeze(model(table('users', { columns: [column('email')] })));
  const target = deepFreeze(
    model(
      table('users', {
        columns: [column('email')],
        uniqueConstraints: [sourceUnique],
        checkConstraints: [sourceCheck],
        indexes: [sourceIndex],
      }),
    ),
  );

  const { steps } = plan(baseline, target);
  assert.deepStrictEqual(steps, [
    { kind: 'add-unique-constraint', table: identity('users'), uniqueConstraint: sourceUnique },
    { kind: 'add-check-constraint', table: identity('users'), checkConstraint: sourceCheck },
    { kind: 'create-index', table: identity('users'), index: sourceIndex },
  ]);

  const uniqueStep = steps[0];
  if (uniqueStep?.kind !== 'add-unique-constraint') throw new Error('expected a unique add');
  assert.notEqual(uniqueStep.uniqueConstraint, sourceUnique);
  assert.notEqual(uniqueStep.uniqueConstraint.columns, sourceUnique.columns);

  const checkStep = steps[1];
  if (checkStep?.kind !== 'add-check-constraint') throw new Error('expected a check add');
  assert.notEqual(checkStep.checkConstraint, sourceCheck);

  const indexStep = steps[2];
  if (indexStep?.kind !== 'create-index') throw new Error('expected an index create');
  assert.notEqual(indexStep.index, sourceIndex);
  assert.notEqual(indexStep.index.columns, sourceIndex.columns);
});

test('an identity added to a kept column becomes one trailing add-identity step', () => {
  const baseline = model(
    table('t', { columns: [column('id', { type: 'integer', notNull: true })] }),
  );
  const added = identityColumn({ sequenceName: identity('t_id_seq') });
  const target = model(
    table('t', { columns: [column('id', { type: 'integer', notNull: true, identity: added })] }),
  );

  assertPlan(baseline, target, [
    { kind: 'add-identity', table: identity('t'), name: 'id', identity: added },
  ]);
  simulate(baseline, target);
});

test('an identity add runs after the table phases set the column NOT NULL', () => {
  const baseline = model(table('t', { columns: [column('id', { type: 'integer' })] }));
  const target = model(
    table('t', {
      columns: [column('id', { type: 'integer', notNull: true, identity: identityColumn() })],
    }),
  );

  assertPlan(baseline, target, [
    {
      kind: 'alter-column',
      table: identity('t'),
      name: 'id',
      fields: [{ field: 'notNull', before: false, after: true }],
    },
    { kind: 'add-identity', table: identity('t'), name: 'id', identity: identityColumn() },
  ]);
  simulate(baseline, target);
});

test('a removed identity precedes DROP NOT NULL and SET DEFAULT on its column', () => {
  const serialDefault = "nextval('t_id_seq'::regclass)";
  const baseline = model(
    table('t', {
      columns: [column('id', { type: 'integer', notNull: true, identity: identityColumn() })],
    }),
  );
  const target = {
    tables: [
      table('t', {
        columns: [column('id', { type: 'integer', default: serialDefault })],
      }),
    ],
    sequences: [sequence('t_id_seq', { dataType: 'integer' })],
  };

  assertPlan(baseline, target, [
    { kind: 'drop-identity', table: identity('t'), name: 'id' },
    { kind: 'create-sequence', sequence: sequence('t_id_seq', { dataType: 'integer' }) },
    {
      kind: 'alter-column',
      table: identity('t'),
      name: 'id',
      fields: [
        { field: 'notNull', before: true, after: false },
        { field: 'default', after: serialDefault },
      ],
    },
  ]);
  simulate(baseline, target);
});

test('an added identity column adds the column plain and its identity last', () => {
  const added = column('id', { type: 'integer', notNull: true, identity: identityColumn() });
  const target = model(table('t', { columns: [added] }));

  assertPlan(model(table('t')), target, [
    { kind: 'add-column', table: identity('t'), column: added },
    { kind: 'add-identity', table: identity('t'), name: 'id', identity: identityColumn() },
  ]);
  simulate(model(table('t')), target);
});

test("an added table's identity columns add after the table, one step each", () => {
  const target = table('t', {
    columns: [
      column('id', {
        type: 'integer',
        notNull: true,
        identity: identityColumn({ sequenceName: identity('t_id_seq') }),
      }),
      column('label'),
      column('n', {
        type: 'integer',
        notNull: true,
        identity: identityColumn({ generated: 'by default' }),
      }),
    ],
  });

  assertPlan(model(), model(target), [
    { kind: 'create-table', table: { ...target, foreignKeys: [] } },
    {
      kind: 'add-identity',
      table: identity('t'),
      name: 'id',
      identity: identityColumn({ sequenceName: identity('t_id_seq') }),
    },
    {
      kind: 'add-identity',
      table: identity('t'),
      name: 'n',
      identity: identityColumn({ generated: 'by default' }),
    },
  ]);
  simulate(model(), model(target));
});

test('a removed identity drops in the first phase, before the rest of the plan', () => {
  const baseline = model(
    table('t', {
      columns: [
        column('id', {
          type: 'integer',
          notNull: true,
          identity: identityColumn({ sequenceName: identity('t_id_seq') }),
        }),
      ],
    }),
  );
  const target = model(
    table('t', { columns: [column('id', { type: 'integer', notNull: true })] }),
    table('u', { columns: [column('x')] }),
  );

  assertPlan(baseline, target, [
    { kind: 'drop-identity', table: identity('t'), name: 'id' },
    {
      kind: 'create-table',
      table: {
        schema: 'public',
        name: 'u',
        columns: [column('x')],
        foreignKeys: [],
        uniqueConstraints: [],
        checkConstraints: [],
        indexes: [],
      },
    },
  ]);
  simulate(baseline, target);
});

test('a removed identity table or column needs no drop-identity step', () => {
  const removed = identityColumn({ sequenceName: identity('removed_seq') });
  const baseline = model(
    table('t', { columns: [column('id', { type: 'integer', notNull: true, identity: removed })] }),
    table('u', {
      columns: [
        column('id', { type: 'integer', notNull: true }),
        column('gone', { type: 'integer', notNull: true, identity: removed }),
      ],
    }),
  );
  const target = model(table('u', { columns: [column('id', { type: 'integer', notNull: true })] }));

  // The plan removes t wholesale and u.gone; PostgreSQL drops each identity sequence with its
  // owner, so neither column contributes a drop-identity — there is no drop to suppress,
  // because the identity never reaches the plan as its own removal.
  assertPlan(baseline, target, [
    { kind: 'drop-table', table: identity('t') },
    {
      kind: 'drop-column',
      table: identity('u'),
      column: column('gone', { type: 'integer', notNull: true, identity: removed }),
    },
  ]);
  simulate(baseline, target);
});

test('a stated sequence-name mismatch drops first and adds the target identity last', () => {
  const baseline = model(
    table('t', {
      columns: [
        column('id', {
          type: 'integer',
          notNull: true,
          identity: identityColumn({ sequenceName: identity('old_seq') }),
        }),
      ],
    }),
  );
  const target = model(
    table('t', {
      columns: [
        column('id', {
          type: 'integer',
          notNull: true,
          identity: identityColumn({ sequenceName: identity('new_seq') }),
        }),
      ],
    }),
  );

  assertPlan(baseline, target, [
    { kind: 'drop-identity', table: identity('t'), name: 'id' },
    {
      kind: 'add-identity',
      table: identity('t'),
      name: 'id',
      identity: identityColumn({ sequenceName: identity('new_seq') }),
    },
  ]);
  simulate(baseline, target);
});

test('an identity option change becomes one alter-identity carrying every changed field', () => {
  const baseline = model(
    table('t', {
      columns: [column('id', { type: 'integer', notNull: true, identity: identityColumn() })],
    }),
  );
  const target = model(
    table('t', {
      columns: [
        column('id', {
          type: 'integer',
          notNull: true,
          identity: identityColumn({
            generated: 'by default',
            increment: '5',
            minValue: '2',
            maxValue: '100',
            start: '3',
            cache: '4',
            cycle: true,
          }),
        }),
      ],
    }),
  );

  assertPlan(baseline, target, [
    {
      kind: 'alter-identity',
      table: identity('t'),
      name: 'id',
      fields: [
        { field: 'generated', before: 'always', after: 'by default' },
        { field: 'increment', before: '1', after: '5' },
        { field: 'minValue', before: '1', after: '2' },
        { field: 'maxValue', before: '2147483647', after: '100' },
        { field: 'start', before: '1', after: '3' },
        { field: 'cache', before: '1', after: '4' },
        { field: 'cycle', before: false, after: true },
      ],
    },
  ]);
  simulate(baseline, target);
});

test('an identity-only column change emits no alter-column step', () => {
  const baseline = model(
    table('t', {
      columns: [column('id', { type: 'integer', notNull: true, identity: identityColumn() })],
    }),
  );
  const target = model(
    table('t', {
      columns: [
        column('id', {
          type: 'integer',
          notNull: true,
          identity: identityColumn({ generated: 'by default' }),
        }),
      ],
    }),
  );

  const { steps } = plan(baseline, target);
  assert.deepStrictEqual(steps, [
    {
      kind: 'alter-identity',
      table: identity('t'),
      name: 'id',
      fields: [{ field: 'generated', before: 'always', after: 'by default' }],
    },
  ]);
  assert.equal(
    steps.some((step) => step.kind === 'alter-column'),
    false,
  );
  simulate(baseline, target);
});

test('serial to identity drops the default, drops the sequence, then adds the identity', () => {
  const serialDefault = "nextval('t_id_seq'::regclass)";
  const baseline = {
    tables: [
      table('t', {
        columns: [column('id', { type: 'integer', notNull: true, default: serialDefault })],
      }),
    ],
    sequences: [sequence('t_id_seq', { dataType: 'integer', ownedBy: owner('t', 'id') })],
  };
  const target = model(
    table('t', {
      columns: [
        column('id', {
          type: 'integer',
          notNull: true,
          identity: identityColumn({ sequenceName: identity('t_id_seq') }),
        }),
      ],
    }),
  );

  assertPlan(baseline, target, [
    {
      kind: 'alter-column',
      table: identity('t'),
      name: 'id',
      fields: [{ field: 'default', before: serialDefault }],
    },
    { kind: 'drop-sequence', sequence: identity('t_id_seq') },
    {
      kind: 'add-identity',
      table: identity('t'),
      name: 'id',
      identity: identityColumn({ sequenceName: identity('t_id_seq') }),
    },
  ]);
  simulate(baseline, target);
});

test('identity to serial drops the identity, creates the sequence, then sets the default', () => {
  const serialDefault = "nextval('t_id_seq'::regclass)";
  const baseline = model(
    table('t', {
      columns: [
        column('id', {
          type: 'integer',
          notNull: true,
          identity: identityColumn({ sequenceName: identity('t_id_seq') }),
        }),
      ],
    }),
  );
  const target = {
    tables: [
      table('t', {
        columns: [column('id', { type: 'integer', notNull: true, default: serialDefault })],
      }),
    ],
    sequences: [sequence('t_id_seq', { dataType: 'integer' })],
  };

  assertPlan(baseline, target, [
    { kind: 'drop-identity', table: identity('t'), name: 'id' },
    { kind: 'create-sequence', sequence: sequence('t_id_seq', { dataType: 'integer' }) },
    {
      kind: 'alter-column',
      table: identity('t'),
      name: 'id',
      fields: [{ field: 'default', after: serialDefault }],
    },
  ]);
  simulate(baseline, target);
});

test('identity steps pin the exact phase order across a mixed migration', () => {
  const bSerialDefault = "nextval('b_serial_id_seq'::regclass)";
  const fSerialDefault = "nextval('f_serial_id_seq'::regclass)";
  const baseline = sequenceModel(
    [
      sequence('b_serial_id_seq', { dataType: 'integer', ownedBy: owner('b_serial', 'id') }),
      sequence('gone_seq', { dataType: 'integer' }),
    ],
    table('a_keep', {
      columns: [
        column('id', { type: 'integer', notNull: true, identity: identityColumn() }),
        column('name'),
      ],
    }),
    table('b_serial', {
      columns: [column('id', { type: 'integer', notNull: true, default: bSerialDefault })],
    }),
    table('c_ident', {
      columns: [
        column('id', {
          type: 'integer',
          notNull: true,
          identity: identityColumn({ sequenceName: identity('old_seq') }),
        }),
      ],
    }),
    table('d_alter', {
      columns: [column('id', { type: 'integer', notNull: true, identity: identityColumn() })],
    }),
    table('f_serial', {
      columns: [column('id', { type: 'integer', notNull: true, identity: identityColumn() })],
    }),
  );
  const target = sequenceModel(
    [sequence('f_serial_id_seq', { dataType: 'integer', ownedBy: owner('f_serial', 'id') })],
    table('a_keep', {
      columns: [
        column('id', { type: 'integer', notNull: true }),
        column('name'),
        column('extra', { type: 'integer', notNull: true, identity: identityColumn() }),
      ],
    }),
    table('b_serial', {
      columns: [
        column('id', {
          type: 'integer',
          notNull: true,
          identity: identityColumn({ sequenceName: identity('b_serial_id_seq') }),
        }),
      ],
    }),
    table('c_ident', {
      columns: [
        column('id', {
          type: 'integer',
          notNull: true,
          identity: identityColumn({ sequenceName: identity('new_seq') }),
        }),
      ],
    }),
    table('d_alter', {
      columns: [
        column('id', {
          type: 'integer',
          notNull: true,
          identity: identityColumn({ generated: 'by default' }),
        }),
      ],
    }),
    table('e_new', {
      columns: [column('id', { type: 'integer', notNull: true, identity: identityColumn() })],
    }),
    table('f_serial', {
      columns: [column('id', { type: 'integer', notNull: true, default: fSerialDefault })],
    }),
  );

  assertPlan(baseline, target, [
    // Phase 1: identity drops, in diff order.
    { kind: 'drop-identity', table: identity('a_keep'), name: 'id' },
    { kind: 'drop-identity', table: identity('c_ident'), name: 'id' },
    { kind: 'drop-identity', table: identity('f_serial'), name: 'id' },
    // Phase 2: the conversion's replacement sequence, name-freed by the phase-1 drops.
    {
      kind: 'create-sequence',
      sequence: sequence('f_serial_id_seq', { dataType: 'integer' }),
    },
    // Phase 4: the table phases.
    {
      kind: 'create-table',
      table: {
        schema: 'public',
        name: 'e_new',
        columns: [column('id', { type: 'integer', notNull: true, identity: identityColumn() })],
        foreignKeys: [],
        uniqueConstraints: [],
        checkConstraints: [],
        indexes: [],
      },
    },
    {
      kind: 'add-column',
      table: identity('a_keep'),
      column: column('extra', { type: 'integer', notNull: true, identity: identityColumn() }),
    },
    {
      kind: 'alter-column',
      table: identity('b_serial'),
      name: 'id',
      fields: [{ field: 'default', before: bSerialDefault }],
    },
    {
      kind: 'alter-column',
      table: identity('f_serial'),
      name: 'id',
      fields: [{ field: 'default', after: fSerialDefault }],
    },
    // Phase 5: the replacement sequence's ownership.
    {
      kind: 'alter-sequence',
      sequence: identity('f_serial_id_seq'),
      fields: [{ field: 'ownedBy', after: owner('f_serial', 'id') }],
    },
    // Phase 7: sequence drops, after the table phases released them.
    { kind: 'drop-sequence', sequence: identity('b_serial_id_seq') },
    { kind: 'drop-sequence', sequence: identity('gone_seq') },
    // Phase 8: identity additions, then alters.
    {
      kind: 'add-identity',
      table: identity('a_keep'),
      name: 'extra',
      identity: identityColumn(),
    },
    {
      kind: 'add-identity',
      table: identity('b_serial'),
      name: 'id',
      identity: identityColumn({ sequenceName: identity('b_serial_id_seq') }),
    },
    {
      kind: 'add-identity',
      table: identity('c_ident'),
      name: 'id',
      identity: identityColumn({ sequenceName: identity('new_seq') }),
    },
    { kind: 'add-identity', table: identity('e_new'), name: 'id', identity: identityColumn() },
    {
      kind: 'alter-identity',
      table: identity('d_alter'),
      name: 'id',
      fields: [{ field: 'generated', before: 'always', after: 'by default' }],
    },
  ]);
  simulate(baseline, target);
});

test('a deep-frozen model with identities can be planned, and identity steps carry copies', () => {
  const before = identityColumn({ sequenceName: identity('old_seq') });
  const after = identityColumn({ generated: 'by default', sequenceName: identity('new_seq') });
  const baseline = deepFreeze(
    model(
      table('t', {
        columns: [column('id', { type: 'integer', notNull: true, identity: before }), column('x')],
      }),
    ),
  );
  const target = deepFreeze(
    model(
      table('t', {
        columns: [column('id', { type: 'integer', notNull: true, identity: after }), column('x')],
      }),
    ),
  );

  const { steps } = plan(baseline, target);
  assert.deepStrictEqual(steps, [
    { kind: 'drop-identity', table: identity('t'), name: 'id' },
    { kind: 'add-identity', table: identity('t'), name: 'id', identity: after },
  ]);
  simulate(baseline, target);

  const [drop, add] = steps;
  assert.equal(drop?.kind, 'drop-identity');
  assert.equal(add?.kind, 'add-identity');
  if (drop?.kind === 'drop-identity') assert.notEqual(drop.table, baseline.tables[0]);
  if (add?.kind === 'add-identity') {
    assert.notEqual(add.identity, after);
    assert.notEqual(add.identity.sequenceName, after.sequenceName);
  }
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
  let uniqueAdds = 0;
  let uniqueDrops = 0;
  let checkAdds = 0;
  let checkDrops = 0;
  let indexCreates = 0;
  let indexDrops = 0;
  let concurrentIndexCreates = 0;
  let concurrentIndexDrops = 0;
  let identityAdds = 0;
  let identityDrops = 0;
  let identityAlters = 0;
  let recreations = 0;
  let sequenceCreates = 0;
  let sequenceDrops = 0;
  let sequenceAlters = 0;
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
    for (const step of steps) {
      if (
        step.kind === 'create-index' ||
        step.kind === 'create-index-concurrently' ||
        step.kind === 'drop-index' ||
        step.kind === 'drop-index-concurrently'
      ) {
        const concurrent =
          step.kind === 'create-index-concurrently' || step.kind === 'drop-index-concurrently';
        assert.equal(
          step.index.concurrently === true,
          concurrent,
          `round ${round}: ${step.kind} must ${concurrent ? '' : 'not '}carry the concurrent flag`,
        );
      }
    }
    if (recreatesIdentity(steps)) recreations += 1;
    if (steps.some((step) => step.kind === 'create-sequence')) sequenceCreates += 1;
    if (steps.some((step) => step.kind === 'drop-sequence')) sequenceDrops += 1;
    if (steps.some((step) => step.kind === 'alter-sequence')) sequenceAlters += 1;
    if (steps.some((step) => step.kind === 'drop-table')) drops += 1;
    if (steps.some((step) => step.kind === 'create-table')) creates += 1;
    if (steps.some((step) => step.kind === 'drop-primary-key')) keyChanges += 1;
    if (steps.some((step) => step.kind === 'add-unique-constraint')) uniqueAdds += 1;
    if (steps.some((step) => step.kind === 'drop-unique-constraint')) uniqueDrops += 1;
    if (steps.some((step) => step.kind === 'add-check-constraint')) checkAdds += 1;
    if (steps.some((step) => step.kind === 'drop-check-constraint')) checkDrops += 1;
    if (steps.some((step) => step.kind === 'create-index')) indexCreates += 1;
    if (steps.some((step) => step.kind === 'drop-index')) indexDrops += 1;
    if (steps.some((step) => step.kind === 'create-index-concurrently'))
      concurrentIndexCreates += 1;
    if (steps.some((step) => step.kind === 'drop-index-concurrently')) concurrentIndexDrops += 1;
    if (steps.some((step) => step.kind === 'add-identity')) identityAdds += 1;
    if (steps.some((step) => step.kind === 'drop-identity')) identityDrops += 1;
    if (steps.some((step) => step.kind === 'alter-identity')) identityAlters += 1;
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
  assert.ok(uniqueAdds > 0, 'the generated pairs must include added unique constraints');
  assert.ok(uniqueDrops > 0, 'the generated pairs must include removed unique constraints');
  assert.ok(checkAdds > 0, 'the generated pairs must include added check constraints');
  assert.ok(checkDrops > 0, 'the generated pairs must include removed check constraints');
  assert.ok(indexCreates > 0, 'the generated pairs must include created indexes');
  assert.ok(indexDrops > 0, 'the generated pairs must include dropped indexes');
  assert.ok(
    concurrentIndexCreates >= 3,
    'the generated pairs must include concurrent index creates',
  );
  assert.ok(concurrentIndexDrops >= 3, 'the generated pairs must include concurrent index drops');
  assert.ok(identityAdds > 0, 'the generated pairs must include added identities');
  assert.ok(identityDrops > 0, 'the generated pairs must include dropped identities');
  assert.ok(identityAlters > 0, 'the generated pairs must include altered identities');
  assert.ok(recreations > 0, 'the generated pairs must include recreated identities');
  assert.ok(sequenceCreates > 0, 'the generated pairs must include created sequences');
  assert.ok(sequenceDrops > 0, 'the generated pairs must include dropped sequences');
  assert.ok(sequenceAlters > 0, 'the generated pairs must include altered sequences');
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

test('a data type change keeps a bound the AS conversion would move explicit', () => {
  // The exact repro shape: both sides state the integer maximum, but the engine converts the
  // baseline's integer maximum on `AS bigint`, so the plan restates the target's maximum.
  const baseline = sequenceModel([sequence('s', { dataType: 'integer', maxValue: '2147483647' })]);
  const target = sequenceModel([sequence('s', { maxValue: '2147483647' })]);

  assertPlan(baseline, target, [
    {
      kind: 'alter-sequence',
      sequence: identity('s'),
      fields: [
        { field: 'dataType', before: 'integer', after: 'bigint' },
        { field: 'maxValue', before: '9223372036854775807', after: '2147483647', converted: true },
      ],
    },
  ]);
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

/**
 * The `applyChange` seam: the write half of `plan`'s change application, pinned branch by
 * branch. Every case runs through `applyChange(emptyChangeApplication(), change)` and asserts
 * exactly which buckets are written and what they carry. This is seam coverage, not pipeline
 * validation: `diff` never emits a kind outside its unions, so the fabricated-kind tests are
 * deletion detectors for the exhaustiveness guards, and #50 extends these per-branch
 * expectations.
 */

/** Applies one change through the seam and returns the application it wrote. */
const applyIsolated = (change: Change): ChangeApplication => {
  const application = emptyChangeApplication();
  applyChange(application, change);
  return application;
};

/**
 * Asserts that `change` applied to a fresh application writes exactly the buckets named in
 * `expected`, leaving every other bucket empty. Sets are compared as insertion-ordered arrays.
 */
const assertBuckets = (
  name: string,
  change: Change,
  expected: Partial<Record<keyof ChangeApplication, unknown>>,
): void => {
  const application = applyIsolated(change);
  for (const bucket of Object.keys(application) as (keyof ChangeApplication)[]) {
    const value = application[bucket];
    const actual = value instanceof Set ? [...value] : value;
    assert.deepStrictEqual(actual, expected[bucket] ?? [], `${name}: ${String(bucket)}`);
  }
};

/** A `table-changed` outer change on table `t` carrying the given sub-change. */
const tableChanged = (change: TableChange): Change => ({
  kind: 'table-changed',
  table: identity('t'),
  changes: [change],
});

/** A `column-changed` for column `id` with an empty field list and the given identity change. */
const columnIdentityChanged = (identity: IdentityChange): Change =>
  tableChanged({ kind: 'column-changed', name: 'id', fields: [], identity });

/** A `sequence-changed` for sequence `s` carrying the given field changes. */
const sequenceChanged = (changes: readonly SequenceFieldChange[]): Change => ({
  kind: 'sequence-changed',
  sequence: identity('s'),
  changes,
});

/** The map key of a table and column pair, mirroring `plan.ts`. */
const columnKey = (table: TableIdentity, column: string): string =>
  `${keyOf(table)}\u0000${column}`;

/** A change case for `applyChange` isolation: its exact expected bucket contents. */
interface BucketCase {
  readonly name: string;
  readonly change: Change;
  readonly buckets: Partial<Record<keyof ChangeApplication, unknown>>;
}

test('emptyChangeApplication returns fresh independent buckets', () => {
  const first = emptyChangeApplication();
  const second = emptyChangeApplication();

  first.foreignKeyDrops.push({ kind: 'drop-table', table: identity('x') });
  first.removedTableKeys.add(keyOf(identity('x')));

  assert.notEqual(first.foreignKeyDrops, second.foreignKeyDrops);
  assert.notEqual(first.removedTableKeys, second.removedTableKeys);
  assert.deepStrictEqual(second.foreignKeyDrops, []);
  assert.equal(second.removedTableKeys.size, 0);
});

test('applyChange writes each outer change kind into its buckets', () => {
  const id = column('id', { type: 'integer', notNull: true });
  const addedIdentity = column('seq', { type: 'integer', identity: identityColumn() });
  const addedForeignKey = foreignKey(['id'], identity('other'), { name: 'fresh_id_fkey' });
  const addedUnique = uniqueConstraint(['id'], { name: 'fresh_id_key' });
  const addedCheck = checkConstraint('id > 0', { name: 'fresh_id_check' });
  const addedIndex = index(['id'], { name: 'fresh_ix' });
  const added = table('fresh', {
    columns: [id, addedIdentity],
    primaryKey: { name: 'fresh_pkey', columns: ['id'] },
    foreignKeys: [addedForeignKey],
    uniqueConstraints: [addedUnique],
    checkConstraints: [addedCheck],
    indexes: [addedIndex],
  });
  const removed = table('gone', { columns: [column('id', { type: 'integer', notNull: true })] });
  const owned = sequence('s', { ownedBy: owner('t', 'id') });

  const cases: readonly BucketCase[] = [
    {
      name: 'table-added',
      change: { kind: 'table-added', table: added },
      buckets: {
        tableCreates: [
          {
            kind: 'create-table',
            table: table('fresh', {
              columns: [id, addedIdentity],
              primaryKey: { name: 'fresh_pkey', columns: ['id'] },
            }),
          },
        ],
        foreignKeyAdds: [
          { kind: 'add-foreign-key', table: identity('fresh'), foreignKey: addedForeignKey },
        ],
        uniqueConstraintAdds: [
          {
            kind: 'add-unique-constraint',
            table: identity('fresh'),
            uniqueConstraint: addedUnique,
          },
        ],
        checkConstraintAdds: [
          { kind: 'add-check-constraint', table: identity('fresh'), checkConstraint: addedCheck },
        ],
        indexCreates: [{ kind: 'create-index', table: identity('fresh'), index: addedIndex }],
        identityAdds: [
          {
            kind: 'add-identity',
            table: identity('fresh'),
            name: 'seq',
            identity: identityColumn(),
          },
        ],
      },
    },
    {
      name: 'table-removed',
      change: { kind: 'table-removed', table: removed },
      buckets: {
        removedTables: [{ identity: identity('gone'), table: removed }],
        removedTableKeys: [keyOf(identity('gone'))],
      },
    },
    {
      name: 'table-changed',
      change: tableChanged({ kind: 'column-added', column: column('c', { type: 'integer' }) }),
      buckets: {
        columnAdds: [
          { kind: 'add-column', table: identity('t'), column: column('c', { type: 'integer' }) },
        ],
      },
    },
    {
      name: 'sequence-added (owned)',
      change: { kind: 'sequence-added', sequence: owned },
      buckets: {
        sequenceCreates: [{ kind: 'create-sequence', sequence: unowned(owned) }],
        ownershipChanges: [{ sequence: identity('s'), after: owner('t', 'id') }],
      },
    },
    {
      name: 'sequence-removed (owned)',
      change: { kind: 'sequence-removed', sequence: owned },
      buckets: {
        removedSequences: [{ identity: identity('s'), ownedBy: owner('t', 'id') }],
      },
    },
    {
      name: 'sequence-changed (options)',
      change: sequenceChanged([{ field: 'increment', before: '1', after: '5' }]),
      buckets: {
        optionAlters: [
          {
            kind: 'alter-sequence',
            sequence: identity('s'),
            fields: [{ field: 'increment', before: '1', after: '5' }],
          },
        ],
      },
    },
  ];

  for (const { name, change, buckets } of cases) assertBuckets(name, change, buckets);
});

test('applyChange writes each table change kind into its buckets', () => {
  const beforePrimaryKey: PrimaryKey = { name: 't_pkey', columns: ['id'] };
  const afterPrimaryKey: PrimaryKey = { name: 't_pkey_2', columns: ['id', 'x'] };
  const beforeForeignKey = foreignKey(['a'], identity('other'), { name: 't_a_fkey' });
  const afterForeignKey = foreignKey(['b'], identity('other'), { name: 't_b_fkey' });
  const beforeUnique = uniqueConstraint(['a'], { name: 't_a_key' });
  const afterUnique = uniqueConstraint(['b'], { name: 't_b_key' });
  const beforeCheck = checkConstraint('a > 0', { name: 't_a_check' });
  const afterCheck = checkConstraint('b > 0', { name: 't_b_check' });
  const beforeIndex = index(['a'], { name: 't_a_ix' });
  const afterIndex = index(['b'], { name: 't_b_ix' });
  const removedColumn = column('gone', { type: 'integer' });
  const addedColumn = column('fresh', { type: 'integer' });

  const cases: readonly BucketCase[] = [
    {
      name: 'column-added',
      change: tableChanged({ kind: 'column-added', column: addedColumn }),
      buckets: {
        columnAdds: [{ kind: 'add-column', table: identity('t'), column: addedColumn }],
      },
    },
    {
      name: 'column-removed',
      change: tableChanged({ kind: 'column-removed', column: removedColumn }),
      buckets: {
        columnDrops: [{ kind: 'drop-column', table: identity('t'), column: removedColumn }],
        removedColumnKeys: [columnKey(identity('t'), 'gone')],
      },
    },
    {
      name: 'column-changed',
      change: tableChanged({
        kind: 'column-changed',
        name: 'c',
        fields: [{ field: 'default', before: '1', after: '2' }],
      }),
      buckets: {
        columnAlters: [
          {
            kind: 'alter-column',
            table: identity('t'),
            name: 'c',
            fields: [{ field: 'default', before: '1', after: '2' }],
          },
        ],
      },
    },
    {
      name: 'primary-key-added',
      change: tableChanged({ kind: 'primary-key-added', primaryKey: afterPrimaryKey }),
      buckets: {
        primaryKeyAdds: [
          { kind: 'add-primary-key', table: identity('t'), primaryKey: afterPrimaryKey },
        ],
      },
    },
    {
      name: 'primary-key-removed',
      change: tableChanged({ kind: 'primary-key-removed', primaryKey: beforePrimaryKey }),
      buckets: {
        primaryKeyDrops: [
          { kind: 'drop-primary-key', table: identity('t'), primaryKey: beforePrimaryKey },
        ],
      },
    },
    {
      name: 'primary-key-changed',
      change: tableChanged({
        kind: 'primary-key-changed',
        before: beforePrimaryKey,
        after: afterPrimaryKey,
      }),
      buckets: {
        primaryKeyDrops: [
          { kind: 'drop-primary-key', table: identity('t'), primaryKey: beforePrimaryKey },
        ],
        primaryKeyAdds: [
          { kind: 'add-primary-key', table: identity('t'), primaryKey: afterPrimaryKey },
        ],
      },
    },
    {
      name: 'foreign-key-added',
      change: tableChanged({ kind: 'foreign-key-added', foreignKey: afterForeignKey }),
      buckets: {
        foreignKeyAdds: [
          { kind: 'add-foreign-key', table: identity('t'), foreignKey: afterForeignKey },
        ],
      },
    },
    {
      name: 'foreign-key-removed',
      change: tableChanged({ kind: 'foreign-key-removed', foreignKey: beforeForeignKey }),
      buckets: {
        foreignKeyDrops: [
          { kind: 'drop-foreign-key', table: identity('t'), foreignKey: beforeForeignKey },
        ],
      },
    },
    {
      name: 'foreign-key-changed',
      change: tableChanged({
        kind: 'foreign-key-changed',
        before: beforeForeignKey,
        after: afterForeignKey,
      }),
      buckets: {
        foreignKeyDrops: [
          { kind: 'drop-foreign-key', table: identity('t'), foreignKey: beforeForeignKey },
        ],
        foreignKeyAdds: [
          { kind: 'add-foreign-key', table: identity('t'), foreignKey: afterForeignKey },
        ],
      },
    },
    {
      name: 'unique-constraint-added',
      change: tableChanged({ kind: 'unique-constraint-added', uniqueConstraint: afterUnique }),
      buckets: {
        uniqueConstraintAdds: [
          { kind: 'add-unique-constraint', table: identity('t'), uniqueConstraint: afterUnique },
        ],
      },
    },
    {
      name: 'unique-constraint-removed',
      change: tableChanged({ kind: 'unique-constraint-removed', uniqueConstraint: beforeUnique }),
      buckets: {
        uniqueConstraintDrops: [
          { kind: 'drop-unique-constraint', table: identity('t'), uniqueConstraint: beforeUnique },
        ],
      },
    },
    {
      name: 'unique-constraint-changed',
      change: tableChanged({
        kind: 'unique-constraint-changed',
        before: beforeUnique,
        after: afterUnique,
      }),
      buckets: {
        uniqueConstraintDrops: [
          { kind: 'drop-unique-constraint', table: identity('t'), uniqueConstraint: beforeUnique },
        ],
        uniqueConstraintAdds: [
          { kind: 'add-unique-constraint', table: identity('t'), uniqueConstraint: afterUnique },
        ],
      },
    },
    {
      name: 'check-constraint-added',
      change: tableChanged({ kind: 'check-constraint-added', checkConstraint: afterCheck }),
      buckets: {
        checkConstraintAdds: [
          { kind: 'add-check-constraint', table: identity('t'), checkConstraint: afterCheck },
        ],
      },
    },
    {
      name: 'check-constraint-removed',
      change: tableChanged({ kind: 'check-constraint-removed', checkConstraint: beforeCheck }),
      buckets: {
        checkConstraintDrops: [
          { kind: 'drop-check-constraint', table: identity('t'), checkConstraint: beforeCheck },
        ],
      },
    },
    {
      name: 'check-constraint-changed',
      change: tableChanged({
        kind: 'check-constraint-changed',
        before: beforeCheck,
        after: afterCheck,
      }),
      buckets: {
        checkConstraintDrops: [
          { kind: 'drop-check-constraint', table: identity('t'), checkConstraint: beforeCheck },
        ],
        checkConstraintAdds: [
          { kind: 'add-check-constraint', table: identity('t'), checkConstraint: afterCheck },
        ],
      },
    },
    {
      name: 'index-added',
      change: tableChanged({ kind: 'index-added', index: afterIndex }),
      buckets: {
        indexCreates: [{ kind: 'create-index', table: identity('t'), index: afterIndex }],
      },
    },
    {
      name: 'index-removed',
      change: tableChanged({ kind: 'index-removed', index: beforeIndex }),
      buckets: {
        indexDrops: [{ kind: 'drop-index', table: identity('t'), index: beforeIndex }],
      },
    },
    {
      name: 'index-changed',
      change: tableChanged({ kind: 'index-changed', before: beforeIndex, after: afterIndex }),
      buckets: {
        indexDrops: [{ kind: 'drop-index', table: identity('t'), index: beforeIndex }],
        indexCreates: [{ kind: 'create-index', table: identity('t'), index: afterIndex }],
      },
    },
  ];

  for (const { name, change, buckets } of cases) assertBuckets(name, change, buckets);
});

test('applyChange writes each identity change kind through column-changed', () => {
  const descriptor = identityColumn();

  const cases: readonly BucketCase[] = [
    {
      name: 'identity-added',
      change: columnIdentityChanged({ kind: 'added', identity: descriptor }),
      buckets: {
        identityAdds: [
          { kind: 'add-identity', table: identity('t'), name: 'id', identity: descriptor },
        ],
      },
    },
    {
      name: 'identity-removed',
      change: columnIdentityChanged({ kind: 'removed', identity: descriptor }),
      buckets: {
        identityDrops: [{ kind: 'drop-identity', table: identity('t'), name: 'id' }],
      },
    },
    {
      name: 'identity-recreated',
      change: columnIdentityChanged({ kind: 'recreated', identity: descriptor }),
      buckets: {
        identityDrops: [{ kind: 'drop-identity', table: identity('t'), name: 'id' }],
        identityAdds: [
          { kind: 'add-identity', table: identity('t'), name: 'id', identity: descriptor },
        ],
      },
    },
    {
      name: 'identity-changed',
      change: columnIdentityChanged({
        kind: 'changed',
        fields: [{ field: 'increment', before: '1', after: '2' }],
      }),
      buckets: {
        identityAlters: [
          {
            kind: 'alter-identity',
            table: identity('t'),
            name: 'id',
            fields: [{ field: 'increment', before: '1', after: '2' }],
          },
        ],
      },
    },
  ];

  for (const { name, change, buckets } of cases) assertBuckets(name, change, buckets);
});

test('applyChange splits a changed sequence into option and ownership buckets', () => {
  const cases: readonly BucketCase[] = [
    {
      name: 'options only',
      change: sequenceChanged([
        { field: 'dataType', before: 'integer', after: 'bigint' },
        { field: 'increment', before: '1', after: '5' },
      ]),
      buckets: {
        optionAlters: [
          {
            kind: 'alter-sequence',
            sequence: identity('s'),
            fields: [
              { field: 'dataType', before: 'integer', after: 'bigint' },
              { field: 'increment', before: '1', after: '5' },
            ],
          },
        ],
      },
    },
    {
      name: 'ownership only',
      change: sequenceChanged([
        { field: 'ownedBy', before: owner('t', 'id'), after: owner('t', 'x') },
      ]),
      buckets: {
        ownershipChanges: [
          { sequence: identity('s'), before: owner('t', 'id'), after: owner('t', 'x') },
        ],
      },
    },
    {
      name: 'mixed',
      change: sequenceChanged([
        { field: 'ownedBy', before: owner('t', 'id') },
        { field: 'maxValue', before: '10', after: '20' },
        { field: 'ownedBy', after: owner('u', 'id') },
      ]),
      buckets: {
        ownershipChanges: [
          { sequence: identity('s'), before: owner('t', 'id') },
          { sequence: identity('s'), after: owner('u', 'id') },
        ],
        optionAlters: [
          {
            kind: 'alter-sequence',
            sequence: identity('s'),
            fields: [{ field: 'maxValue', before: '10', after: '20' }],
          },
        ],
      },
    },
    {
      name: 'no fields',
      change: sequenceChanged([]),
      buckets: {},
    },
  ];

  for (const { name, change, buckets } of cases) assertBuckets(name, change, buckets);
});

/**
 * Payload-aliasing guards: a step payload must not share nested objects with the `Change` it
 * came from, even fields the current payload types do not declare. Each case fabricates a
 * nested `nested` field on the input, applies the change through the seam, mutates the nested
 * object through the produced step payload, and asserts the input never moved. These pin the
 * bare spreads converted to `copyStepPayload` deep copies.
 */

/** One aliasing case: how to build the change around the fabricated object and where to find it. */
interface AliasCase {
  readonly name: string;
  readonly build: (nested: { deep: string }) => Change;
  readonly payload: (application: ChangeApplication) => Record<string, unknown>;
}

/** The embedded payload of the only step in `steps`, cast for the aliasing probe. */
const onlyPayload = (steps: readonly Step[], key: string): Record<string, unknown> => {
  assert.equal(steps.length, 1, `expected exactly one step, got ${steps.length}`);
  return (steps[0] as unknown as Record<string, Record<string, unknown>>)[key]!;
};

/** The only field change of the only step in `steps`, cast for the aliasing probe. */
const onlyFieldPayload = (steps: readonly Step[]): Record<string, unknown> => {
  assert.equal(steps.length, 1, `expected exactly one step, got ${steps.length}`);
  const fields = (steps[0] as unknown as { fields: readonly Record<string, unknown>[] }).fields;
  assert.equal(fields.length, 1, `expected exactly one field, got ${fields.length}`);
  return fields[0]!;
};

const aliasCases: readonly AliasCase[] = [
  {
    name: 'index create',
    build: (nested) =>
      tableChanged({
        kind: 'index-added',
        index: { ...index(['a']), nested } as unknown as Index,
      }),
    payload: (application) => onlyPayload(application.indexCreates, 'index'),
  },
  {
    name: 'index drop',
    build: (nested) =>
      tableChanged({
        kind: 'index-removed',
        index: { ...index(['a']), nested } as unknown as Index,
      }),
    payload: (application) => onlyPayload(application.indexDrops, 'index'),
  },
  {
    name: 'check constraint',
    build: (nested) =>
      tableChanged({
        kind: 'check-constraint-added',
        checkConstraint: {
          ...checkConstraint('a > 0'),
          nested,
        } as unknown as CheckConstraint,
      }),
    payload: (application) => onlyPayload(application.checkConstraintAdds, 'checkConstraint'),
  },
  {
    name: 'column field change',
    build: (nested) =>
      tableChanged({
        kind: 'column-changed',
        name: 'c',
        fields: [
          { field: 'notNull', before: false, after: true, nested } as unknown as ColumnFieldChange,
        ],
      }),
    payload: (application) => onlyFieldPayload(application.columnAlters),
  },
  {
    name: 'column identity field change',
    build: (nested) =>
      tableChanged({
        kind: 'column-changed',
        name: 'c',
        fields: [],
        identity: {
          kind: 'changed',
          fields: [
            {
              field: 'increment',
              before: '1',
              after: '2',
              nested,
            } as unknown as IdentityFieldChange,
          ],
        },
      }),
    payload: (application) => onlyFieldPayload(application.identityAlters),
  },
  {
    name: 'sequence option',
    build: (nested) =>
      sequenceChanged([
        { field: 'increment', before: '1', after: '2', nested } as unknown as SequenceFieldChange,
      ]),
    payload: (application) => onlyFieldPayload(application.optionAlters),
  },
];

for (const { name, build, payload } of aliasCases) {
  test(`a step payload deep-copies a fabricated nested field: ${name}`, () => {
    const nested = { deep: 'original' };
    const application = applyIsolated(build(nested));
    const produced = payload(application);

    (produced['nested'] as { deep: string }).deep = 'mutated';
    assert.equal(
      nested.deep,
      'original',
      'mutating the produced step payload must not mutate the input change',
    );
  });
}

// Deletion detectors, not pipeline validation: `diff` never emits an unknown kind, so these
// pin the guards that make every future union member a compile error, and the seam contract
// #50 extends with property coverage.

test('a fabricated outer change kind is rejected by the application guard', () => {
  assert.throws(
    () => applyChange(emptyChangeApplication(), { kind: 'frobnicate' } as unknown as Change),
    /Unhandled change kind: frobnicate/,
  );
});

test('a fabricated table change kind is rejected by the application guard', () => {
  assert.throws(
    () =>
      applyChange(
        emptyChangeApplication(),
        tableChanged({ kind: 'frobnicate' } as unknown as TableChange),
      ),
    /Unhandled table change kind: frobnicate/,
  );
});

test('a fabricated identity change kind is rejected by the application guard', () => {
  assert.throws(
    () =>
      applyChange(
        emptyChangeApplication(),
        columnIdentityChanged({ kind: 'frobnicate' } as unknown as IdentityChange),
      ),
    /Unhandled identity change kind: frobnicate/,
  );
});

test('a fabricated sequence field is rejected by the application guard', () => {
  assert.throws(
    () =>
      applyChange(
        emptyChangeApplication(),
        sequenceChanged([{ field: 'frobnicate' } as unknown as SequenceFieldChange]),
      ),
    /Unhandled sequence field: frobnicate/,
  );
});

import type { Identity } from './identity.ts';

/**
 * The canonical model payload shapes.
 *
 * The model represents a database schema and is engine-general: nothing here is
 * PostgreSQL-specific. The column text fields (`type`, `default`) are stored as written,
 * whitespace-normalized, and opaque to the model — `int` and `integer` stay distinct.
 * Referential actions use SQL's canonical spelling instead.
 *
 * Identity:
 * - A table is identified by its schema and its name together, e.g. `public.users`.
 * - A column is identified by its name within its table.
 * - A primary key or foreign key is identified by the columns it covers; a constraint
 *   `name` travels with it when the source has one but is not part of its identity.
 * - A sequence is identified by its schema and its name together, like a table.
 *
 * Ordering — deterministic, so two models of the same schema compare structurally:
 * - `tables` are sorted by schema, then name (JavaScript string comparison).
 * - `columns` keep source order: ordinal position is part of a table's shape.
 * - `primaryKey.columns` and `foreignKey.columns` keep the constraint's column order.
 * - `foreignKeys` are sorted by referencing columns (element-wise lexicographic), then
 *   referenced table (schema, then name), then constraint name (`name ?? ''`, so unnamed
 *   first).
 * - `sequences` are sorted by schema, then name (JavaScript string comparison).
 *
 * `GENERATED … AS IDENTITY` is a column property, not a sequence entity: an identity column
 * carries its effective descriptor on the column (`Column.identity`) and never among
 * `Model.sequences`.
 *
 * This module declares shapes only; it holds no behavior.
 */

/** Identifies a table in the model: the schema-qualified name, e.g. `public.users`. */
export interface TableIdentity {
  /** The namespace that qualifies the table, e.g. `public`. */
  readonly schema: string;
  /** The table's name, as written without quoting. */
  readonly name: string;
}

/** The canonical model: the whole schema, as tables and sequences. */
export interface Model {
  /** Every imported table, in the model's deterministic order. */
  readonly tables: readonly Table[];
  /** Every imported sequence, in the model's deterministic order. */
  readonly sequences: readonly Sequence[];
}

/** A table and its imported structure. */
export interface Table extends TableIdentity {
  /** Columns in source order; ordinal position matters. */
  readonly columns: readonly Column[];
  /** The table's primary key, when it has one (PostgreSQL allows at most one). */
  readonly primaryKey?: PrimaryKey;
  /** Foreign keys declared on the table, in the model's deterministic order. */
  readonly foreignKeys: readonly ForeignKey[];
}

/** A column of a table. */
export interface Column {
  /** The column's name, as written without quoting. */
  readonly name: string;
  /** The type as written, whitespace-normalized; opaque to the model (`int` ≠ `integer`). */
  readonly type: string;
  /** Whether the column is declared `NOT NULL`. */
  readonly notNull: boolean;
  /** The `DEFAULT` expression as written, whitespace-normalized; opaque to the model. */
  readonly default?: string;
  /**
   * The column's identity descriptor when it is declared `GENERATED … AS IDENTITY`, in
   * effective values (normalization lives in `identity.ts`); absent when it is not.
   */
  readonly identity?: Identity;
}

/** A table's primary key. */
export interface PrimaryKey {
  /** Constraint name as written, when the source names it. */
  readonly name?: string;
  /** Key columns, in the constraint's order. */
  readonly columns: readonly string[];
}

/** A foreign key constraint: columns on this table pointing at columns of another table. */
export interface ForeignKey {
  /** Constraint name as written, when the source names it. */
  readonly name?: string;
  /** Referencing columns, in the constraint's order. */
  readonly columns: readonly string[];
  /** The referenced table, schema-qualified. */
  readonly referencedTable: TableIdentity;
  /** Referenced columns, in the constraint's order; empty when the source omits them. */
  readonly referencedColumns: readonly string[];
  /** The `ON UPDATE` action when the source states a non-default one. */
  readonly onUpdate?: ReferentialAction;
  /** The `ON DELETE` action when the source states a non-default one. */
  readonly onDelete?: ReferentialAction;
}

/**
 * A non-default referential action, in SQL's canonical spelling. `NO ACTION` is the default,
 * so it is represented by an absent action and is not a member here. Dialect-specific
 * extensions, such as a set of columns with `SET NULL` / `SET DEFAULT`, are outside the
 * model; importers report them as dropped.
 */
export type ReferentialAction = 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT';

/** Identifies a sequence in the model: the schema-qualified name, e.g. `public.users_id_seq`. */
export interface SequenceIdentity {
  /** The namespace that qualifies the sequence, e.g. `public`. */
  readonly schema: string;
  /** The sequence's name, as written without quoting. */
  readonly name: string;
}

/** The data type of a sequence; PostgreSQL allows exactly these three. */
export type SequenceDataType = 'smallint' | 'integer' | 'bigint';

/** The table and column a sequence is owned by. */
export interface SequenceOwner {
  /** The owning table, schema-qualified. */
  readonly table: TableIdentity;
  /** The owning column's name, as written without quoting. */
  readonly column: string;
}

/**
 * A sequence and its effective options. Every numeric option is an exact 64-bit integer in
 * canonical decimal form — an optional minus followed by digits, no leading zeros — never a
 * JavaScript `number`: the type bounds exceed `Number.MAX_SAFE_INTEGER`. The values are the
 * effective ones PostgreSQL would use, so an option the source omitted and the same option
 * stated explicitly are the same value here (normalization lives in `sequence.ts`).
 *
 * `ownedBy` is the sequence's optional ownership: when present, PostgreSQL drops the sequence
 * together with the owning table or column. Absent means unowned.
 */
export interface Sequence extends SequenceIdentity {
  /** The sequence's data type; `bigint` when the source omits `AS`. */
  readonly dataType: SequenceDataType;
  /** The `INCREMENT BY` step, an exact integer. */
  readonly increment: string;
  /** The `MINVALUE`, an exact integer. */
  readonly minValue: string;
  /** The `MAXVALUE`, an exact integer. */
  readonly maxValue: string;
  /** The `START WITH` value, an exact integer. */
  readonly start: string;
  /** The `CACHE` size, an exact positive integer. */
  readonly cache: string;
  /** Whether the sequence wraps with `CYCLE`. */
  readonly cycle: boolean;
  /** The owning table and column, when the sequence is owned. */
  readonly ownedBy?: SequenceOwner;
}

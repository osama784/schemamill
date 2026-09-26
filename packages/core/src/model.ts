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
 *
 * Ordering — deterministic, so two models of the same schema compare structurally:
 * - `tables` are sorted by schema, then name (JavaScript string comparison).
 * - `columns` keep source order: ordinal position is part of a table's shape.
 * - `primaryKey.columns` and `foreignKey.columns` keep the constraint's column order.
 * - `foreignKeys` are sorted by referencing columns (element-wise lexicographic), then
 *   referenced table (schema, then name), then constraint name (`name ?? ''`, so unnamed
 *   first).
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

/** The canonical model: the whole schema, as tables. */
export interface Model {
  /** Every imported table, in the model's deterministic order. */
  readonly tables: readonly Table[];
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

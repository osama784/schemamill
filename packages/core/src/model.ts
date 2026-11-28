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
 * - A primary key or unique constraint is identified by the columns it covers, a check
 *   constraint by its expression, an exclusion constraint by its canonical element text, and a
 *   foreign key by its referencing columns and the table it references; a constraint `name`
 *   travels with it when the source has one but is not part of its identity. An index is
 *   identified by its name.
 * - A sequence is identified by its schema and its name together, like a table.
 * - A view is identified by its schema and its name together, like a table. A view and a
 *   materialized view share one namespace, so the `materialized` discriminator is part of the
 *   entity's shape, not of its identity.
 * - An extension is identified by its name alone: extension names are database-unique and are
 *   never schema-qualified. Its install schema is an attribute, not part of identity.
 *
 * Ordering — deterministic, so two models of the same schema compare structurally:
 * - `tables` are sorted by schema, then name (JavaScript string comparison).
 * - `columns` keep source order: ordinal position is part of a table's shape.
 * - `primaryKey.columns`, `uniqueConstraint.columns`, `index.columns`, and `foreignKey.columns`
 *   keep the constraint's or index's authored order; an index's elements may be expressions.
 * - `foreignKeys` are sorted by referencing columns (element-wise lexicographic), then
 *   referenced table (schema, then name), then constraint name (`name ?? ''`, so unnamed
 *   first).
 * - `uniqueConstraints` are sorted by their columns (element-wise lexicographic), then
 *   constraint name (`name ?? ''`, so unnamed first).
 * - `checkConstraints` are sorted by expression, then constraint name (`name ?? ''`, so
 *   unnamed first).
 * - `exclusionConstraints` are sorted by their canonical element text, then constraint name
 *   (`name ?? ''`, so unnamed first).
 * - `indexes` are sorted by name (`name ?? ''`, so unnamed first).
 * - `sequences` are sorted by schema, then name (JavaScript string comparison).
 * - `views` are sorted by schema, then name (JavaScript string comparison).
 * - `extensions` are sorted by name (JavaScript string comparison); the schema is not part of
 *   the order.
 * - `privileges` are sorted by grantee, privilege list, columns, then grant option; `ALL` is a
 *   distinct marker that sorts before an explicit list and is never expanded into one.
 * - `defaultPrivileges` are sorted by roles, schemas, object type, then revoke before grant
 *   within one scope, so a scope's REVOKE renders before its GRANT.
 *
 * `Index.concurrently` is apply metadata, not structure: it is excluded from structural
 * identity and equality, and only steers how a create or drop is applied — the target index's
 * flag drives a create, the baseline index's flag drives a drop.
 *
 * Constraint attributes travel with the constraint without being identity: a foreign key or
 * check constraint carries `enforcement` when the source declares `NOT VALID` or `NOT ENFORCED`
 * (absent means valid and enforced), a primary key, unique constraint, or foreign key carries
 * `deferrable`/`initiallyDeferred` when the source declares `DEFERRABLE`/`INITIALLY DEFERRED`
 * (absent means the immediate default), and a column carries `notNullName` when PostgreSQL 18
 * names its not-null constraint (only meaningful with `notNull: true`).
 *
 * Column attributes and table persistence are explicit-only. A column carries `collation`
 * (opaque, whitespace-normalized text as written — a qualified or quoted name is not a column
 * name, so it is never identity), `storage`, or `compression` only when the source states the
 * attribute; absent means the type's default or no explicit method. A column's
 * `statisticsTarget` is an integer 0–10000 stated explicitly by the source; absent means the
 * server default. `0` is a stated target meaning no statistics and is distinct from absence,
 * and `-1` is never stored. A table carries
 * `persistence` only when it is `UNLOGGED`; absent means `LOGGED`, PostgreSQL's default.
 * `ColumnAttributes` is the target-side carrier a `column-changed` entry and its `alter-column`
 * step use to restate a column's render-relevant values.
 *
 * `GENERATED … AS IDENTITY` is a column property, not a sequence entity: an identity column
 * carries its effective descriptor on the column (`Column.identity`) and never among
 * `Model.sequences`.
 *
 * `View.definition` is the SQL body after `AS`, whitespace-normalized and opaque to the model,
 * exactly like a check expression or a default: core never parses or reconstructs it. A view's
 * `checkOption` is explicit-only; absent means the view accepts rows without a check option.
 * The check option never travels on a materialized view.
 *
 * This module declares shapes only; it holds no behavior.
 */

/**
 * One privilege assignment on a table or sequence. `grantee` is an opaque role name carried as
 * written, or the literal `PUBLIC`; roles are not modeled objects and are never resolved here.
 * `privileges` is either the marker `ALL`, meaning the source omitted the privilege list, or an
 * explicit list kept as written: the marker is never expanded and an explicit list is never
 * collapsed into it, because which privileges `ALL` carries depends on server version, object
 * type, and column level. `columns` narrows column-level privileges; `grantOption` records
 * `WITH GRANT OPTION`. There is no grantor: non-owner grantors stay named import skips.
 */
export interface Grant {
  /** The grantee's opaque role name, or the literal `PUBLIC`. */
  readonly grantee: string;
  /** `ALL` when the source omitted the list, otherwise the explicit privilege names. */
  readonly privileges: readonly string[] | 'ALL';
  /** Column names for a column-level grant; absent means the whole object. */
  readonly columns?: readonly string[];
  /** Whether the grant carries `WITH GRANT OPTION`. */
  readonly grantOption?: boolean;
}

/**
 * One `ALTER DEFAULT PRIVILEGES` scope. `roles` names the roles whose future objects the
 * statement affects (absent means the current role), `schemas` limits it to one or more schemas
 * (absent means every schema), and `kind` records GRANT or REVOKE. Repeated statements in the
 * same scope merge their grants; a per-schema scope never cancels a global one.
 */
export interface DefaultPrivilege {
  /** The roles the default applies to; absent means the current role. */
  readonly roles?: readonly string[];
  /** The schemas the default applies to; absent means every schema. */
  readonly schemas?: readonly string[];
  /** Whether the default affects future tables or future sequences. */
  readonly objectType: 'table' | 'sequence';
  /** GRANT or REVOKE; both are modeled and REVOKE renders first within a scope. */
  readonly kind: 'grant' | 'revoke';
  /** The assignments in this statement, in canonical order. */
  readonly grants: readonly Grant[];
}

/** Identifies a table in the model: the schema-qualified name, e.g. `public.users`. */
export interface TableIdentity {
  /** The namespace that qualifies the table, e.g. `public`. */
  readonly schema: string;
  /** The table's name, as written without quoting. */
  readonly name: string;
}

/** The canonical model: the whole schema, as tables, sequences, views, and extensions. */
export interface Model {
  /** Every imported table, in the model's deterministic order. */
  readonly tables: readonly Table[];
  /** Every imported sequence, in the model's deterministic order. */
  readonly sequences: readonly Sequence[];
  /** Every imported view and materialized view, in the model's deterministic order. */
  readonly views: readonly View[];
  /** Every imported extension, in the model's deterministic order. */
  readonly extensions: readonly Extension[];
  /**
   * Cluster-wide default privileges for future tables and sequences, in canonical order; absent
   * means the source declared none. Default privileges are not part of any entity's identity.
   */
  readonly defaultPrivileges?: readonly DefaultPrivilege[];
}

/** A table and its imported structure. */
export interface Table extends TableIdentity {
  /** Columns in source order; ordinal position matters. */
  readonly columns: readonly Column[];
  /** The table's primary key, when it has one (PostgreSQL allows at most one). */
  readonly primaryKey?: PrimaryKey;
  /** Foreign keys declared on the table, in the model's deterministic order. */
  readonly foreignKeys: readonly ForeignKey[];
  /** Unique constraints declared on the table, in the model's deterministic order. */
  readonly uniqueConstraints: readonly UniqueConstraint[];
  /** Check constraints declared on the table, in the model's deterministic order. */
  readonly checkConstraints: readonly CheckConstraint[];
  /** Exclusion constraints declared on the table, in the model's deterministic order. */
  readonly exclusionConstraints?: readonly ExclusionConstraint[];
  /** Standalone indexes on the table, in the model's deterministic order. */
  readonly indexes: readonly Index[];
  /**
   * The table's persistence when it is not `LOGGED`, PostgreSQL's default; absent means
   * `LOGGED`. Temporary persistence is not modeled and stays flagged by import and introspection.
   */
  readonly persistence?: TablePersistence;
  /** The table's role-level object owner, an opaque role name; absent means unstated. */
  readonly owner?: string;
  /** The table's object privileges, in canonical order; absent means unstated. */
  readonly privileges?: readonly Grant[];
  /**
   * The table's PostgreSQL comment, stored verbatim; absent means none. An empty string is not a
   * comment (`COMMENT … IS ''` removes it), text is never whitespace-normalized, and no NUL.
   */
  readonly comment?: string;
}

/**
 * A table's persistence when it is not the default: `unlogged` means the source declares
 * `UNLOGGED`. Absent means `LOGGED`.
 */
export type TablePersistence = 'unlogged';

/** A column's explicit storage method, in PostgreSQL's words (`pg_attribute.attstorage`). */
export type ColumnStorage = 'plain' | 'external' | 'extended' | 'main';

/** A column's explicit compression method, in PostgreSQL's words (`pg_attribute.attcompression`). */
export type ColumnCompression = 'pglz' | 'lz4';

/** A column of a table. */
export interface Column {
  /** The column's name, as written without quoting. */
  readonly name: string;
  /** The type as written, whitespace-normalized; opaque to the model (`int` ≠ `integer`). */
  readonly type: string;
  /** Whether the column is declared `NOT NULL`. */
  readonly notNull: boolean;
  /**
   * The name of the column's not-null constraint when the source names it (PostgreSQL 18);
   * meaningful only with `notNull: true`. Absent means the not-null fact is unnamed or the
   * column is nullable.
   */
  readonly notNullName?: string;
  /**
   * The comment on the column's not-null constraint (PostgreSQL 18), stored verbatim; absent
   * means none. Valid whenever `notNull: true` — it is NOT gated on `notNullName`: a generated
   * name is stripped at import, so the primary case has no name. An empty string is not a
   * comment, text is never whitespace-normalized, and no NUL. This is not `COMMENT ON COLUMN`
   * (that is `comment`) and does not make the not-null fact an entity.
   */
  readonly notNullComment?: string;
  /** The `DEFAULT` expression as written, whitespace-normalized; opaque to the model. */
  readonly default?: string;
  /**
   * The column's identity descriptor when it is declared `GENERATED … AS IDENTITY`, in
   * effective values (normalization lives in `identity.ts`); absent when it is not.
   */
  readonly identity?: Identity;
  /**
   * The `COLLATE` name as written, whitespace-normalized; opaque to the model. Absent means
   * the type's default collation. A qualified or quoted name is not a column name, so the
   * collation is attribute text, never identity.
   */
  readonly collation?: string;
  /**
   * The column's explicit storage method; absent means the type's default. An explicit method
   * equal to the type's default is stored as stated — the model is explicit-only, not
   * normalized against the type.
   */
  readonly storage?: ColumnStorage;
  /** The column's explicit compression method; absent means the type's default. */
  readonly compression?: ColumnCompression;
  /**
   * The column's PostgreSQL statistics target, an integer 0–10000 inclusive. Only a target the
   * source states is stored; absent means the server default. `0` means no statistics and is
   * distinct from absence, and `-1` is never stored.
   */
  readonly statisticsTarget?: number;
  /**
   * The column's PostgreSQL comment, stored verbatim; absent means none. An empty string is not
   * a comment (`COMMENT … IS ''` removes it), text is never whitespace-normalized, and no NUL.
   */
  readonly comment?: string;
}

/**
 * The target column's render-relevant values, carried by a `column-changed` entry and its
 * `alter-column` step whenever `type`, `collation`, `storage`, `compression`, or
 * `statisticsTarget` differs: a merged `TYPE` statement must restate an unchanged explicit
 * collation, and it resets storage and compression to the type's defaults. The type is always
 * stated; the attributes are present exactly when the target states them.
 */
export interface ColumnAttributes {
  /** The type as written, whitespace-normalized; opaque to the model. */
  readonly type: string;
  /** The `COLLATE` name as written; absent means the type's default collation. */
  readonly collation?: string;
  /** The explicit storage method; absent means the type's default. */
  readonly storage?: ColumnStorage;
  /** The explicit compression method; absent means the type's default. */
  readonly compression?: ColumnCompression;
  /** The target's statistics target, an integer 0–10000; absent means the server default. */
  readonly statisticsTarget?: number;
}

/**
 * A constraint's enforcement when it is not the default, as PostgreSQL names it: `not-valid`
 * means declared `NOT VALID` — existing rows are unchecked, new rows are — and `not-enforced`
 * means declared `NOT ENFORCED`, which PostgreSQL reports as `NOT VALID` too but never
 * enforces. Absent means the constraint is valid and enforced, the default.
 */
export type ConstraintEnforcement = 'not-valid' | 'not-enforced';

/** A table's primary key. */
export interface PrimaryKey {
  /** Constraint name as written, when the source names it. */
  readonly name?: string;
  /** Key columns, in the constraint's order. */
  readonly columns: readonly string[];
  /** Whether the constraint is declared `DEFERRABLE`; absent means `NOT DEFERRABLE`. */
  readonly deferrable?: boolean;
  /**
   * Whether the constraint is declared `INITIALLY DEFERRED`; implies `deferrable`, and absent
   * means `INITIALLY IMMEDIATE`.
   */
  readonly initiallyDeferred?: boolean;
  /**
   * The primary key's PostgreSQL comment, stored verbatim; absent means none. An empty string is
   * not a comment (`COMMENT … IS ''` removes it), text is never whitespace-normalized, and no NUL.
   */
  readonly comment?: string;
}

/** A unique constraint: the listed columns must be unique together. */
export interface UniqueConstraint {
  /** Constraint name as written, when the source names it. */
  readonly name?: string;
  /** Key columns, in the constraint's order. */
  readonly columns: readonly string[];
  /** Whether the constraint is declared `DEFERRABLE`; absent means `NOT DEFERRABLE`. */
  readonly deferrable?: boolean;
  /**
   * Whether the constraint is declared `INITIALLY DEFERRED`; implies `deferrable`, and absent
   * means `INITIALLY IMMEDIATE`.
   */
  readonly initiallyDeferred?: boolean;
  /**
   * The unique constraint's PostgreSQL comment, stored verbatim; absent means none. An empty
   * string is not a comment (`COMMENT … IS ''` removes it), text is never whitespace-normalized,
   * and no NUL.
   */
  readonly comment?: string;
}

/** A check constraint: every row must satisfy the expression. */
export interface CheckConstraint {
  /** Constraint name as written, when the source names it. */
  readonly name?: string;
  /** The check expression as written, whitespace-normalized; opaque to the model. */
  readonly expression: string;
  /** The constraint's enforcement when not the default; absent means valid and enforced. */
  readonly enforcement?: ConstraintEnforcement;
  /**
   * The check constraint's PostgreSQL comment, stored verbatim; absent means none. An empty
   * string is not a comment (`COMMENT … IS ''` removes it), text is never whitespace-normalized,
   * and no NUL.
   */
  readonly comment?: string;
}

/**
 * An exclusion constraint: the listed expressions and operators must not compare equal for any
 * two rows. Operator, operator-class, and collation text stays inside the opaque `elements`
 * text, which is whitespace-normalized by the importing parser and never reconstructed by core.
 * `accessMethod` is explicit-only: absence means PostgreSQL's `gist` default.
 */
export interface ExclusionConstraint {
  /** Constraint name as written, when the source names it. */
  readonly name?: string;
  /** The exclusion elements as canonical, whitespace-normalized text, in authored order. */
  readonly elements: string;
  /**
   * The access method, as written, when the source states one; absent means PostgreSQL's
   * `gist` default.
   */
  readonly accessMethod?: string;
  /** The exclusion's `WHERE` clause; absent means the constraint applies to every row. */
  readonly where?: string;
  /** Whether the constraint is declared `DEFERRABLE`; absent means `NOT DEFERRABLE`. */
  readonly deferrable?: boolean;
  /**
   * Whether the constraint is declared `INITIALLY DEFERRED`; implies `deferrable`, and absent
   * means `INITIALLY IMMEDIATE`.
   */
  readonly initiallyDeferred?: boolean;
  /**
   * The exclusion constraint's PostgreSQL comment, stored verbatim; absent means none. An empty
   * string is not a comment (`COMMENT … IS ''` removes it), text is never whitespace-normalized,
   * and no NUL.
   */
  readonly comment?: string;
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
  /** The constraint's enforcement when not the default; absent means valid and enforced. */
  readonly enforcement?: ConstraintEnforcement;
  /** Whether the constraint is declared `DEFERRABLE`; absent means `NOT DEFERRABLE`. */
  readonly deferrable?: boolean;
  /**
   * Whether the constraint is declared `INITIALLY DEFERRED`; implies `deferrable`, and absent
   * means `INITIALLY IMMEDIATE`.
   */
  readonly initiallyDeferred?: boolean;
  /**
   * The foreign key's PostgreSQL comment, stored verbatim; absent means none. An empty string is
   * not a comment (`COMMENT … IS ''` removes it), text is never whitespace-normalized, and no NUL.
   */
  readonly comment?: string;
}

/**
 * One ordered element of an index's key list: a plain string names a column; the tagged object
 * carries an expression as written, whitespace-normalized and opaque to the model — operator,
 * operator-class, and collation text stay inside it, never becoming separate fields. The two
 * shapes are distinct: a column named `{"expression":"x"}` is not that expression.
 */
export type IndexElement = string | { readonly expression: string };

/**
 * A standalone index: an access path on the table's ordered key elements, not backing a
 * constraint. A named index is identified by its name; an unnamed index by its structure —
 * `unique`, its ordered key elements, and its `INCLUDE` columns and partial `where` clause —
 * with a missing name itself distinct in a diff. A unique constraint is never modeled as, or
 * accompanied by, an index.
 *
 * `where` is the partial index's clause, not a check constraint's predicate: the model keeps it
 * as whitespace-normalized, opaque text. `include` holds the `INCLUDE` columns after the keys.
 * `concurrently` stays apply metadata, excluded from structural identity and equality.
 */
export interface Index {
  /** Index name as written, when the source names it. */
  readonly name?: string;
  /** Whether the index is declared `UNIQUE`. */
  readonly unique: boolean;
  /** Indexed columns and expressions, in the index's authored order. */
  readonly columns: readonly IndexElement[];
  /** `INCLUDE` columns, in the index's authored order; absent means no `INCLUDE` clause. */
  readonly include?: readonly string[];
  /** The partial index's `WHERE` clause; absent means the index is not partial. */
  readonly where?: string;
  /**
   * Whether a create or drop applies `CONCURRENTLY`; apply metadata, not structure, excluded
   * from identity and equality. The target's flag drives a create, the baseline's drives a
   * drop.
   */
  readonly concurrently?: boolean;
  /**
   * The index's PostgreSQL comment, stored verbatim; absent means none. An empty string is not
   * a comment (`COMMENT … IS ''` removes it), text is never whitespace-normalized, and no NUL.
   */
  readonly comment?: string;
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
  /** The sequence's role-level object owner, an opaque role name; absent means unstated. */
  readonly owner?: string;
  /** The sequence's object privileges, in canonical order; absent means unstated. */
  readonly privileges?: readonly Grant[];
  /**
   * The sequence's PostgreSQL comment, stored verbatim; absent means none. An empty string is
   * not a comment (`COMMENT … IS ''` removes it), text is never whitespace-normalized, and no NUL.
   */
  readonly comment?: string;
}

/** Identifies a view in the model: the schema-qualified name, e.g. `public.active_users`. */
export interface ViewIdentity {
  /** The namespace that qualifies the view, e.g. `public`. */
  readonly schema: string;
  /** The view's name, as written without quoting. */
  readonly name: string;
}

/**
 * A view's check option: `local` checks only the view's own `WHERE` clause, `cascaded` also
 * checks the views it reads through. Absent means no `WITH CHECK OPTION`.
 */
export type ViewCheckOption = 'local' | 'cascaded';

/**
 * One output column of a view or materialized view, in the order PostgreSQL reports it
 * (`attnum`). `type` is the canonical `format_type` text the catalog stores; importers that cannot
 * resolve a type write `''` to mean "unknown", which never drives the compatibility decision.
 */
export interface ViewOutputColumn {
  /** The output column's name, as PostgreSQL names it. */
  readonly name: string;
  /** The canonical `format_type` text, or `''` when the type is unknown. */
  readonly type: string;
}

/**
 * One relation a view reads, recorded as a plan-time dependency fact. The required `kind`
 * discriminates a view from every other relation, so a table or sequence dependency can never be
 * mistaken for an unmodeled view. Absent from `View.dependsOn` means no facts were recorded.
 */
export interface ViewDependency extends ViewIdentity {
  /** Whether the referenced relation is a view (`v`/`m`) or any other relation. */
  readonly kind: 'view' | 'relation';
}

/**
 * A view or materialized view and its definition. One array holds both kinds and one identity
 * names either, so a view and a materialized view never coexist under one name; `materialized`
 * is the discriminator that decides how a migration recreates it.
 */
export interface View extends ViewIdentity {
  /** Whether the view is materialized (`CREATE MATERIALIZED VIEW`). */
  readonly materialized: boolean;
  /**
   * The SQL body after `AS` — the statement terminator and any trailing `WITH … CHECK OPTION`
   * or `WITH [NO] DATA` clause stripped, whitespace-normalized. Opaque to the model, like a
   * check expression or a default: core never parses it.
   */
  readonly definition: string;
  /**
   * The view's output columns in `attnum` order, each carrying a name and a canonical type.
   * Absent means unknown: a side without verifiable columns never drives the preflight decision.
   */
  readonly columns?: readonly ViewOutputColumn[];
  /**
   * The relations this view reads, as dependency facts for plan-time ordering. `view` members
   * order drops/creates and gate the typed refusal; `relation` members are recorded for fidelity
   * but never refuse. Absent means no facts were recorded.
   */
  readonly dependsOn?: readonly ViewDependency[];
  /**
   * Standalone indexes on a materialized view, in source order; absent means none. Matviews
   * only: an ordinary view cannot own an index. An empty array normalizes to absence in a
   * workspace file, and every reader treats absence as no indexes.
   */
  readonly indexes?: readonly Index[];
  /**
   * The view's check option when it declares one; absent means none. Views only: a
   * materialized view cannot carry one.
   */
  readonly checkOption?: ViewCheckOption;
  /**
   * The view's PostgreSQL comment, stored verbatim; absent means none. An empty string is not a
   * comment (`COMMENT … IS ''` removes it), text is never whitespace-normalized, and no NUL.
   */
  readonly comment?: string;
}

/**
 * The relation an index belongs to: a table or a materialized view. The discriminant travels
 * with index changes and steps so the same `Index` shape and the same step kinds serve both
 * families; an ordinary view cannot own an index.
 */
export type IndexOwner =
  | { readonly kind: 'table'; readonly table: TableIdentity }
  | { readonly kind: 'materialized-view'; readonly view: ViewIdentity };

/**
 * Identifies an extension in the model: its name. Extension names are database-unique and are
 * never schema-qualified, so the name alone is identity.
 */
export interface ExtensionIdentity {
  /** The extension's name, as written without quoting and never schema-qualified. */
  readonly name: string;
}

/**
 * A PostgreSQL extension and the schema it is installed in.
 *
 * `schema` is the install schema the source states (`WITH SCHEMA`) and is required: every
 * extension has one, and the importer never invents it. The schema is a mutable attribute,
 * not part of identity — moving an extension is an `ALTER EXTENSION … SET SCHEMA`.
 */
export interface Extension extends ExtensionIdentity {
  /** The schema the extension is installed in, e.g. `public`. */
  readonly schema: string;
  /**
   * The extension's PostgreSQL comment, stored verbatim; absent means none. An empty string is
   * not a comment (`COMMENT … IS ''` removes it), text is never whitespace-normalized, and no
   * NUL.
   */
  readonly comment?: string;
}

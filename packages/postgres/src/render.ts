import type {
  Column,
  ColumnFieldChange,
  ForeignKey,
  Plan,
  PrimaryKey,
  SqlRenderer,
  Step,
  Table,
  TableIdentity,
} from '@schemamill/core';

/**
 * Migration SQL rendering: a migration plan → the migration SQL that moves one schema toward
 * another.
 *
 * `renderSql` is a pure function of the plan — the plan carries every payload the SQL needs,
 * and the same plan always renders the same text. One statement per line, terminated with a
 * semicolon, and a single trailing newline at the end of the output; an empty plan renders as
 * the empty string. `create-table` is the one multi-line statement: its columns go one per
 * line, indented four spaces, and its primary key, when present, is the trailing line. A table
 * with neither columns nor a primary key renders on one line as `CREATE TABLE <q> ();`.
 *
 * Every table reference is schema-qualified: `<schema>.<name>`. An identifier — table, column,
 * or constraint name — is emitted bare only when it is a lowercase, unquoted-identifier shape
 * (`/^[a-z_][a-z0-9_$]*$/`) and not a reserved key word; otherwise it is double-quoted, with
 * embedded quotes doubled. `RESERVED_KEYWORDS` holds the words that rule covers. Column types
 * and DEFAULT expressions are emitted exactly as the model stores them: core never lexes or
 * normalizes SQL, so rendering never rewrites a type or an expression.
 *
 * A constraint drop must name its constraint, but the model permits unnamed constraints.
 * Rendering then synthesizes PostgreSQL's conventional name — `<table>_pkey` for a primary
 * key, `<table>_<column>_…_fkey` for a foreign key. This is best-effort: PostgreSQL appends
 * numbered suffixes on name collisions, which cannot be known offline, and pg_dump output
 * always carries real constraint names, so unnamed constraints are the unusual case.
 *
 * Hazards and transaction grouping are later work: this module emits no comments and no
 * BEGIN/COMMIT. `sqlRenderer` binds `renderSql` to core's `SqlRenderer` seam.
 */

/**
 * The PostgreSQL key words that cannot stand as a table, column, or constraint name without
 * double quotes: every word classed `reserved` or `reserved (can be function or type name)`
 * in PostgreSQL 18's keyword table, the two categories the parser does not accept where a
 * name is expected. Conservative on purpose — `user` and `left`, for instance, are quoted
 * even where some context might take them bare — and fixed, so rendering never varies with a
 * server version.
 */
export const RESERVED_KEYWORDS: ReadonlySet<string> = new Set([
  'all',
  'analyse',
  'analyze',
  'and',
  'any',
  'array',
  'as',
  'asc',
  'asymmetric',
  'authorization',
  'binary',
  'both',
  'case',
  'cast',
  'check',
  'collate',
  'collation',
  'column',
  'concurrently',
  'constraint',
  'create',
  'cross',
  'current_catalog',
  'current_date',
  'current_role',
  'current_schema',
  'current_time',
  'current_timestamp',
  'current_user',
  'default',
  'deferrable',
  'desc',
  'distinct',
  'do',
  'else',
  'end',
  'except',
  'false',
  'fetch',
  'for',
  'foreign',
  'freeze',
  'from',
  'full',
  'grant',
  'group',
  'having',
  'ilike',
  'in',
  'initially',
  'inner',
  'intersect',
  'into',
  'is',
  'isnull',
  'join',
  'lateral',
  'leading',
  'left',
  'like',
  'limit',
  'localtime',
  'localtimestamp',
  'natural',
  'not',
  'notnull',
  'null',
  'offset',
  'on',
  'only',
  'or',
  'order',
  'outer',
  'overlaps',
  'placing',
  'primary',
  'references',
  'returning',
  'right',
  'select',
  'session_user',
  'similar',
  'some',
  'symmetric',
  'system_user',
  'table',
  'tablesample',
  'then',
  'to',
  'trailing',
  'true',
  'union',
  'unique',
  'user',
  'using',
  'variadic',
  'verbose',
  'when',
  'where',
  'window',
  'with',
]);

/** The shape of an identifier PostgreSQL accepts without double quotes. */
const BARE_IDENTIFIER = /^[a-z_][a-z0-9_$]*$/;

/** The migration SQL for `plan`, deterministic. */
export function renderSql(plan: Plan): string {
  if (plan.steps.length === 0) return '';
  return `${plan.steps.map((step) => renderStep(step)).join('\n')}\n`;
}

/** Binds `renderSql` to the `SqlRenderer` seam. */
export const sqlRenderer: SqlRenderer<Plan> = { render: renderSql };

/** Quotes `identifier` unless PostgreSQL accepts it bare. */
export function quoteIdentifier(identifier: string): string {
  if (BARE_IDENTIFIER.test(identifier) && !RESERVED_KEYWORDS.has(identifier)) return identifier;
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** One plan step as one or more statements, without a trailing newline. */
function renderStep(step: Step): string {
  switch (step.kind) {
    case 'create-table':
      return renderCreateTable(step.table);
    case 'drop-table':
      return `DROP TABLE ${renderTable(step.table)};`;
    case 'add-column':
      return `ALTER TABLE ${renderTable(step.table)} ADD COLUMN ${renderColumn(step.column)};`;
    case 'drop-column':
      return `ALTER TABLE ${renderTable(step.table)} DROP COLUMN ${quoteIdentifier(
        step.column.name,
      )};`;
    case 'alter-column':
      return step.fields
        .map((field) => renderColumnAlteration(step.table, step.name, field))
        .join('\n');
    case 'add-primary-key':
      return `ALTER TABLE ${renderTable(step.table)} ADD ${renderPrimaryKey(step.primaryKey)};`;
    case 'drop-primary-key':
      return `ALTER TABLE ${renderTable(step.table)} DROP CONSTRAINT ${quoteIdentifier(
        step.primaryKey.name ?? `${step.table.name}_pkey`,
      )};`;
    case 'add-foreign-key':
      return `ALTER TABLE ${renderTable(step.table)} ADD ${renderForeignKey(step.foreignKey)};`;
    case 'drop-foreign-key':
      return `ALTER TABLE ${renderTable(step.table)} DROP CONSTRAINT ${quoteIdentifier(
        step.foreignKey.name ?? synthesizedForeignKeyName(step.table, step.foreignKey),
      )};`;
  }
}

/** `CREATE TABLE` for `table`, one column per line and the primary key trailing. */
function renderCreateTable(table: Table): string {
  const lines = table.columns.map((column) => `    ${renderColumn(column)}`);
  if (table.primaryKey !== undefined) lines.push(`    ${renderPrimaryKey(table.primaryKey)}`);
  if (lines.length === 0) return `CREATE TABLE ${renderTable(table)} ();`;

  const body = lines
    .map((line, index) => (index === lines.length - 1 ? line : `${line},`))
    .join('\n');
  return `CREATE TABLE ${renderTable(table)} (\n${body}\n);`;
}

/** One column definition: name, type, and the `NOT NULL` / `DEFAULT` clauses it carries. */
function renderColumn(column: Column): string {
  const notNull = column.notNull ? ' NOT NULL' : '';
  const fallback = column.default === undefined ? '' : ` DEFAULT ${column.default}`;
  return `${quoteIdentifier(column.name)} ${column.type}${notNull}${fallback}`;
}

/** A primary-key constraint clause, with its name when it has one. */
function renderPrimaryKey(primaryKey: PrimaryKey): string {
  const name =
    primaryKey.name === undefined ? '' : `CONSTRAINT ${quoteIdentifier(primaryKey.name)} `;
  const columns = primaryKey.columns.map((column) => quoteIdentifier(column)).join(', ');
  return `${name}PRIMARY KEY (${columns})`;
}

/** A foreign-key constraint clause, with its name, referenced columns, and actions. */
function renderForeignKey(foreignKey: ForeignKey): string {
  const name =
    foreignKey.name === undefined ? '' : `CONSTRAINT ${quoteIdentifier(foreignKey.name)} `;
  const columns = foreignKey.columns.map((column) => quoteIdentifier(column)).join(', ');
  const referenced =
    foreignKey.referencedColumns.length === 0
      ? ''
      : `(${foreignKey.referencedColumns.map((column) => quoteIdentifier(column)).join(', ')})`;
  return `${name}FOREIGN KEY (${columns}) REFERENCES ${renderTable(
    foreignKey.referencedTable,
  )}${referenced}${renderReferentialActions(foreignKey)}`;
}

/** The stated `ON UPDATE` / `ON DELETE` actions, in that order; each is optional. */
function renderReferentialActions(foreignKey: ForeignKey): string {
  const onUpdate = foreignKey.onUpdate === undefined ? '' : ` ON UPDATE ${foreignKey.onUpdate}`;
  const onDelete = foreignKey.onDelete === undefined ? '' : ` ON DELETE ${foreignKey.onDelete}`;
  return `${onUpdate}${onDelete}`;
}

/** PostgreSQL's conventional foreign-key name for an unnamed constraint. */
function synthesizedForeignKeyName(table: TableIdentity, foreignKey: ForeignKey): string {
  return `${table.name}${foreignKey.columns.map((column) => `_${column}`).join('')}_fkey`;
}

/** One `ALTER COLUMN` statement for one differing field. */
function renderColumnAlteration(
  table: TableIdentity,
  name: string,
  field: ColumnFieldChange,
): string {
  const statement = `ALTER TABLE ${renderTable(table)} ALTER COLUMN ${quoteIdentifier(name)}`;
  switch (field.field) {
    case 'type':
      return `${statement} TYPE ${field.after};`;
    case 'notNull':
      return `${statement} ${field.after ? 'SET' : 'DROP'} NOT NULL;`;
    case 'default':
      return field.after === undefined
        ? `${statement} DROP DEFAULT;`
        : `${statement} SET DEFAULT ${field.after};`;
  }
}

/** A schema-qualified table reference: `<schema>.<name>`, each part quoted as needed. */
function renderTable(identity: TableIdentity): string {
  return `${quoteIdentifier(identity.schema)}.${quoteIdentifier(identity.name)}`;
}

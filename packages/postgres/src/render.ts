import type {
  CheckConstraint,
  Column,
  ColumnFieldChange,
  ConstraintEnforcement,
  ForeignKey,
  Identity,
  IdentityFieldChange,
  Index,
  Plan,
  PrimaryKey,
  Sequence,
  SequenceFieldChange,
  SequenceIdentity,
  SqlRenderer,
  Step,
  Table,
  TableIdentity,
  UniqueConstraint,
} from '@schemamill/core';

import {
  synthesizedCheckConstraintName,
  synthesizedForeignKeyName,
  synthesizedIndexName,
  synthesizedPrimaryKeyName,
  synthesizedUniqueConstraintName,
} from './names.ts';

/**
 * Migration SQL rendering: a migration plan → the migration SQL that moves one schema toward
 * another.
 *
 * `renderSql` is a pure function of the plan — the plan carries every payload the SQL needs,
 * and the same plan always renders the same text. One statement per line, terminated with a
 * semicolon, and a single trailing newline at the end of the output; an empty plan renders as
 * the empty string. The plan's groups must partition its steps — non-empty half-open ranges
 * that tile `[0, steps.length)` in order, with no groups when there are no steps; `plan()`
 * guarantees this contract, and a malformed partition throws before any SQL is rendered,
 * naming the violated invariant and the offending indices. A plan that renders two index
 * statements of one polarity on one table under one name is refused with `RenderRefusalError`
 * before anything renders: the second create could not claim the name, and the second drop
 * would already be gone. A drop and a create of one name are different statements —
 * `index-changed` decomposes that way — and render. `renderSql` walks the plan's
 * transaction groups in order: a transactional group is wrapped in `BEGIN;` and `COMMIT;`, and
 * a standalone group renders its statements bare. A plan with more than one group separates
 * them with one blank line; single-group output is unchanged. `create-table` is the one
 * multi-line statement: its columns go one per line, indented four spaces, and its primary
 * key, when present, is the trailing line. A table with neither columns nor a primary key
 * renders on one line as `CREATE TABLE <q> ();`.
 *
 * `create-sequence` renders the canonical full-explicit form — `AS`, `INCREMENT BY`,
 * `MINVALUE`, `MAXVALUE`, `START WITH`, `CACHE`, and `CYCLE`/`NO CYCLE` — with the plan's
 * effective values, so re-importing the rendered SQL reproduces the same sequence.
 * `alter-sequence` renders one `ALTER SEQUENCE` statement carrying one clause per changed
 * field: the engine validates a sequence's bounds as a whole, so separate statements could
 * fail on an intermediate state that the final one satisfies. An ownership change renders
 * `OWNED BY <table>.<column>` or `OWNED BY NONE`; `drop-sequence` renders `DROP SEQUENCE`.
 *
 * `add-identity` renders one full-explicit `ALTER TABLE … ADD GENERATED … AS IDENTITY`
 * statement whose option order mirrors `create-sequence` minus `AS` — the type comes from the
 * column — with `SEQUENCE NAME` only when the descriptor carries one. `alter-identity` renders
 * one statement carrying one `SET …` clause per changed field, in the diff's field order, and
 * never `AS` or a sequence name; as with `alter-sequence`, the engine validates the option set
 * as a whole. `drop-identity` renders `DROP IDENTITY`. A column's identity never renders
 * inline in `create-table` or `add-column`: the plan adds it with its own step.
 *
 * `add-unique-constraint` renders `ALTER TABLE … ADD [CONSTRAINT name] UNIQUE (cols)`,
 * `add-check-constraint` renders `… ADD [CONSTRAINT name] CHECK (expr)` with the expression
 * exactly as the model stores it, and `create-index` renders
 * `CREATE [UNIQUE] INDEX [name] ON schema.table USING btree (cols)`, omitting the name when
 * the model has none, mirroring primary-key and foreign-key rendering. The concurrent index
 * kinds render the same statements with `CONCURRENTLY`; the plan stands them in standalone
 * groups, so they render bare.
 *
 * Constraint attributes render after every other clause of their constraint, in PostgreSQL's
 * order: `DEFERRABLE`, `INITIALLY DEFERRED`, then the enforcement state — `NOT VALID` for
 * `not-valid`, `NOT ENFORCED` for `not-enforced`. `INITIALLY DEFERRED` implies deferrable, so a
 * stated `initiallyDeferred` emits both words; `false` and absent render nothing, `NOT
 * DEFERRABLE` and valid-and-enforced being the defaults. A not-null fact with a name renders
 * PostgreSQL 18's inline `CONSTRAINT <name> NOT NULL` in place of the plain `NOT NULL`, in both
 * `CREATE TABLE` and `ADD COLUMN`; nothing negotiates the server version — the renderer states
 * the attributes the model carries.
 *
 * Every table and sequence reference is schema-qualified: `<schema>.<name>`. An identifier —
 * table, sequence, column, constraint, or index name — is emitted bare only when it is a
 * lowercase, unquoted-identifier shape (`/^[a-z_][a-z0-9_$]*$/`) and not a reserved key word;
 * otherwise it is double-quoted, with embedded quotes doubled. `RESERVED_KEYWORDS` holds the
 * words that rule covers. Column types and DEFAULT expressions are emitted exactly as the model
 * stores them: core never lexes or normalizes SQL, so rendering never rewrites a type or an
 * expression. Sequence option values are emitted exactly as the model stores them: canonical
 * decimal strings, never JavaScript numbers, so 64-bit values render exactly.
 *
 * A constraint drop must name its constraint, but the model permits unnamed constraints.
 * Rendering then synthesizes PostgreSQL's conventional name — `<table>_pkey` for a primary
 * key, `<table>_<column>_…_fkey` for a foreign key, `<table>_<column>_…_key` for a unique
 * constraint, and `<table>_<column>_check` for a check constraint whose expression references
 * one column (`<table>_check` otherwise) — and `<table>_<column>_…_idx` for an unnamed index
 * drop. Index drops are schema-qualified (`DROP INDEX <schema>.<name>`): a bare index name
 * resolves through `search_path`, while `CREATE INDEX` places the index in its table's schema.
 * This is best-effort: PostgreSQL appends numbered suffixes on name collisions, which
 * cannot be known offline, and pg_dump output always carries real constraint names, so
 * unnamed constraints are the unusual case.
 *
 * This module emits no comments. `sqlRenderer` binds `renderSql` to core's `SqlRenderer` seam.
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

/**
 * Thrown by `renderSql` when a plan cannot render soundly: two index statements of one polarity
 * on one table resolve to the same name. Callers that report the refusal instead of crashing —
 * the CLI — catch exactly this class.
 */
export class RenderRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderRefusalError';
  }
}

/**
 * The migration SQL for `plan`, deterministic. `plan.groups` must tile `[0, plan.steps.length)`;
 * a malformed partition throws before anything renders, and so does a plan whose index
 * statements of one table and polarity would share a name.
 */
export function renderSql(plan: Plan): string {
  assertGroupsTileSteps(plan);
  assertIndexNamesUnique(plan);
  if (plan.steps.length === 0) return '';
  const groups: string[] = [];
  for (const group of plan.groups) {
    const lines: string[] = [];
    if (group.transactional) lines.push('BEGIN;');
    for (let index = group.start; index < group.end; index += 1) {
      lines.push(renderStep(plan.steps[index]!));
    }
    if (group.transactional) lines.push('COMMIT;');
    groups.push(lines.join('\n'));
  }
  return `${groups.join('\n\n')}\n`;
}

/**
 * Rejects a malformed partition: `plan.groups` must be non-empty half-open ranges that tile
 * `[0, plan.steps.length)` in order, and an empty step list must carry no groups. `plan()`
 * guarantees this; a violation throws naming the invariant and the offending indices.
 */
function assertGroupsTileSteps(plan: Plan): void {
  const stepCount = plan.steps.length;
  if (stepCount === 0) {
    if (plan.groups.length > 0) {
      const spans = plan.groups.map((group) => `[${group.start}, ${group.end})`).join(', ');
      throw new Error(
        `plan.groups must be empty when plan.steps is empty, but found groups ${spans}`,
      );
    }
    return;
  }
  if (plan.groups.length === 0) {
    throw new Error(`plan.groups must tile [0, ${stepCount}) in order, but found no groups`);
  }
  let expected = 0;
  for (let index = 0; index < plan.groups.length; index += 1) {
    const group = plan.groups[index]!;
    if (group.start !== expected) {
      throw new Error(
        `plan.groups must tile [0, ${stepCount}) in order, but group ${index} starts at ${group.start}, expected ${expected}`,
      );
    }
    if (group.end <= group.start) {
      throw new Error(
        `plan.groups must be non-empty, but group ${index} spans [${group.start}, ${group.end})`,
      );
    }
    expected = group.end;
  }
  if (expected !== stepCount) {
    throw new Error(`plan.groups must tile [0, ${stepCount}), but the groups end at ${expected}`);
  }
}

/**
 * Refuses a plan that renders two index statements of one polarity on one table under one
 * resolved name — explicit for a named index, PostgreSQL's conventional name for an unnamed
 * one. Two creates would collide at apply time, and two drops would drop one name twice, so
 * the SQL cannot satisfy the plan; explicit-vs-explicit duplicates are refused too. A drop and
 * a create of one name are different statements — `index-changed` decomposes that way — and
 * render. Only same-table groups are considered: a named index's uniqueness spans its schema,
 * which the plan does not model.
 */
function assertIndexNamesUnique(plan: Plan): void {
  const claimed = new Map<string, IndexStatement>();
  for (const step of plan.steps) {
    const statement = indexStatement(step);
    if (statement === undefined) continue;
    const { table, index, polarity } = statement;
    const name = index.name ?? synthesizedIndexName(table, index);
    const key = JSON.stringify([table.schema, table.name, polarity, name]);
    const previous = claimed.get(key);
    if (previous !== undefined) {
      throw new RenderRefusalError(
        `refusing to render: index ${polarity} on ${renderTable(table)} would share the name ` +
          `${JSON.stringify(name)}: ${describeIndex(previous.index)} and ${describeIndex(index)}`,
      );
    }
    claimed.set(key, statement);
  }
}

/** One index statement's table, index, and polarity, for the duplicate-name guard. */
interface IndexStatement {
  readonly table: TableIdentity;
  readonly index: Index;
  readonly polarity: 'creates' | 'drops';
}

/** The index payload of an index step, or `undefined` for every other kind. */
function indexStatement(step: Step): IndexStatement | undefined {
  switch (step.kind) {
    case 'create-index':
    case 'create-index-concurrently':
      return { table: step.table, index: step.index, polarity: 'creates' };
    case 'drop-index':
    case 'drop-index-concurrently':
      return { table: step.table, index: step.index, polarity: 'drops' };
    case 'create-table':
    case 'drop-table':
    case 'add-column':
    case 'drop-column':
    case 'alter-column':
    case 'drop-not-null':
    case 'add-not-null':
    case 'add-identity':
    case 'drop-identity':
    case 'alter-identity':
    case 'add-primary-key':
    case 'drop-primary-key':
    case 'add-foreign-key':
    case 'drop-foreign-key':
    case 'add-unique-constraint':
    case 'drop-unique-constraint':
    case 'add-check-constraint':
    case 'drop-check-constraint':
    case 'create-sequence':
    case 'drop-sequence':
    case 'alter-sequence':
    default:
      return undefined;
  }
}

/** A refusal-message fragment naming one index by its columns and, when stated, its name. */
function describeIndex(index: Index): string {
  const columns = index.columns.map((column) => quoteIdentifier(column)).join(', ');
  return index.name === undefined
    ? `an unnamed index on (${columns})`
    : `an index named ${JSON.stringify(index.name)} on (${columns})`;
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
    case 'drop-not-null':
      return step.name === undefined
        ? `ALTER TABLE ${renderTable(step.table)} ALTER COLUMN ${quoteIdentifier(
            step.column,
          )} DROP NOT NULL;`
        : `ALTER TABLE ${renderTable(step.table)} DROP CONSTRAINT ${quoteIdentifier(step.name)};`;
    case 'add-not-null':
      return step.name === undefined
        ? `ALTER TABLE ${renderTable(step.table)} ALTER COLUMN ${quoteIdentifier(
            step.column,
          )} SET NOT NULL;`
        : `ALTER TABLE ${renderTable(step.table)} ADD CONSTRAINT ${quoteIdentifier(
            step.name,
          )} NOT NULL ${quoteIdentifier(step.column)};`;
    case 'add-identity':
      return renderAddIdentity(step.table, step.name, step.identity);
    case 'drop-identity':
      return renderDropIdentity(step.table, step.name);
    case 'alter-identity':
      return renderAlterIdentity(step.table, step.name, step.fields);
    case 'add-primary-key':
      return `ALTER TABLE ${renderTable(step.table)} ADD ${renderPrimaryKey(step.primaryKey)};`;
    case 'drop-primary-key':
      return `ALTER TABLE ${renderTable(step.table)} DROP CONSTRAINT ${quoteIdentifier(
        step.primaryKey.name ?? synthesizedPrimaryKeyName(step.table),
      )};`;
    case 'add-foreign-key':
      return `ALTER TABLE ${renderTable(step.table)} ADD ${renderForeignKey(step.foreignKey)};`;
    case 'drop-foreign-key':
      return `ALTER TABLE ${renderTable(step.table)} DROP CONSTRAINT ${quoteIdentifier(
        step.foreignKey.name ?? synthesizedForeignKeyName(step.table, step.foreignKey),
      )};`;
    case 'add-unique-constraint':
      return `ALTER TABLE ${renderTable(step.table)} ADD ${renderUniqueConstraint(
        step.uniqueConstraint,
      )};`;
    case 'drop-unique-constraint':
      return `ALTER TABLE ${renderTable(step.table)} DROP CONSTRAINT ${quoteIdentifier(
        step.uniqueConstraint.name ??
          synthesizedUniqueConstraintName(step.table, step.uniqueConstraint),
      )};`;
    case 'add-check-constraint':
      return `ALTER TABLE ${renderTable(step.table)} ADD ${renderCheckConstraint(
        step.checkConstraint,
      )};`;
    case 'drop-check-constraint':
      return `ALTER TABLE ${renderTable(step.table)} DROP CONSTRAINT ${quoteIdentifier(
        step.checkConstraint.name ??
          synthesizedCheckConstraintName(step.table, step.checkConstraint),
      )};`;
    case 'create-index':
      return renderCreateIndex(step.table, step.index, false);
    case 'create-index-concurrently':
      return renderCreateIndex(step.table, step.index, true);
    case 'drop-index':
      return renderDropIndex(step.table, step.index, false);
    case 'drop-index-concurrently':
      return renderDropIndex(step.table, step.index, true);
    case 'create-sequence':
      return renderCreateSequence(step.sequence);
    case 'drop-sequence':
      return `DROP SEQUENCE ${renderSequence(step.sequence)};`;
    case 'alter-sequence':
      return renderAlterSequence(step.sequence, step.fields);
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

/**
 * One column definition: name, type, and the `NOT NULL` / `DEFAULT` clauses it carries. A
 * not-null fact the model names renders PostgreSQL 18's inline `CONSTRAINT <name> NOT NULL`;
 * without a name it stays the plain `NOT NULL`. An identity descriptor renders nothing here:
 * the plan adds it with its own step.
 */
function renderColumn(column: Column): string {
  const notNull =
    column.notNull && column.notNullName !== undefined
      ? ` CONSTRAINT ${quoteIdentifier(column.notNullName)} NOT NULL`
      : column.notNull
        ? ' NOT NULL'
        : '';
  const fallback = column.default === undefined ? '' : ` DEFAULT ${column.default}`;
  return `${quoteIdentifier(column.name)} ${column.type}${notNull}${fallback}`;
}

/** A primary-key constraint clause, with its name and attributes when it has them. */
function renderPrimaryKey(primaryKey: PrimaryKey): string {
  const name =
    primaryKey.name === undefined ? '' : `CONSTRAINT ${quoteIdentifier(primaryKey.name)} `;
  const columns = primaryKey.columns.map((column) => quoteIdentifier(column)).join(', ');
  return `${name}PRIMARY KEY (${columns})${renderDeferrability(primaryKey)}`;
}

/** A foreign-key constraint clause, with its name, referenced columns, actions, and attributes. */
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
  )}${referenced}${renderReferentialActions(foreignKey)}${renderDeferrability(
    foreignKey,
  )}${renderEnforcement(foreignKey.enforcement)}`;
}

/**
 * The deferrability clause of a constraint: `DEFERRABLE` and `INITIALLY DEFERRED`, in that
 * order and after every other clause. `INITIALLY DEFERRED` implies `DEFERRABLE`, so a stated
 * `initiallyDeferred` emits both words; `false` and absent render nothing, `NOT DEFERRABLE`
 * being PostgreSQL's default. Shared by the primary-key, unique, and foreign-key clauses.
 */
function renderDeferrability(constraint: {
  readonly deferrable?: boolean;
  readonly initiallyDeferred?: boolean;
}): string {
  const deferrable = constraint.deferrable === true || constraint.initiallyDeferred === true;
  const initiallyDeferred = constraint.initiallyDeferred === true;
  return `${deferrable ? ' DEFERRABLE' : ''}${initiallyDeferred ? ' INITIALLY DEFERRED' : ''}`;
}

/**
 * The `NOT VALID` / `NOT ENFORCED` tail of a constraint; absent means valid and enforced, the
 * default. PostgreSQL reports a `NOT ENFORCED` constraint as `NOT VALID` too, but the model
 * keeps the two states apart, and the renderer states the declaration the model carries.
 */
function renderEnforcement(enforcement: ConstraintEnforcement | undefined): string {
  switch (enforcement) {
    case undefined:
      return '';
    case 'not-valid':
      return ' NOT VALID';
    case 'not-enforced':
      return ' NOT ENFORCED';
  }
}

/** The stated `ON UPDATE` / `ON DELETE` actions, in that order; each is optional. */
function renderReferentialActions(foreignKey: ForeignKey): string {
  const onUpdate = foreignKey.onUpdate === undefined ? '' : ` ON UPDATE ${foreignKey.onUpdate}`;
  const onDelete = foreignKey.onDelete === undefined ? '' : ` ON DELETE ${foreignKey.onDelete}`;
  return `${onUpdate}${onDelete}`;
}

/** A unique-constraint clause, with its name and attributes when it has them. */
function renderUniqueConstraint(uniqueConstraint: UniqueConstraint): string {
  const name =
    uniqueConstraint.name === undefined
      ? ''
      : `CONSTRAINT ${quoteIdentifier(uniqueConstraint.name)} `;
  const columns = uniqueConstraint.columns.map((column) => quoteIdentifier(column)).join(', ');
  return `${name}UNIQUE (${columns})${renderDeferrability(uniqueConstraint)}`;
}

/**
 * A check-constraint clause, with its name when it has one and its enforcement tail; the
 * expression is opaque text.
 */
function renderCheckConstraint(checkConstraint: CheckConstraint): string {
  const name =
    checkConstraint.name === undefined
      ? ''
      : `CONSTRAINT ${quoteIdentifier(checkConstraint.name)} `;
  return `${name}CHECK (${checkConstraint.expression})${renderEnforcement(
    checkConstraint.enforcement,
  )}`;
}

/** `CREATE [UNIQUE] INDEX [CONCURRENTLY] [name] ON <table> USING btree (cols)`. */
function renderCreateIndex(table: TableIdentity, index: Index, concurrently: boolean): string {
  const unique = index.unique ? 'UNIQUE ' : '';
  const concurrent = concurrently ? 'CONCURRENTLY ' : '';
  const name = index.name === undefined ? '' : `${quoteIdentifier(index.name)} `;
  const columns = index.columns.map((column) => quoteIdentifier(column)).join(', ');
  return `CREATE ${unique}INDEX ${concurrent}${name}ON ${renderTable(
    table,
  )} USING btree (${columns});`;
}

/**
 * `DROP INDEX [CONCURRENTLY] <schema>.<name>`, synthesizing the conventional name when
 * absent. Unlike `CREATE INDEX`, whose name lands in the table's schema, a `DROP INDEX` with
 * a bare name resolves through `search_path`, so the index must be qualified with the schema
 * of the table it belongs to.
 */
function renderDropIndex(table: TableIdentity, index: Index, concurrently: boolean): string {
  const concurrent = concurrently ? 'CONCURRENTLY ' : '';
  const name = index.name ?? synthesizedIndexName(table, index);
  return `DROP INDEX ${concurrent}${quoteIdentifier(table.schema)}.${quoteIdentifier(name)};`;
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
    case 'notNullName':
      // The plan consumes a name-involved change into drop-not-null/add-not-null steps, so a
      // name never reaches an alter-column; reaching here means the plan is malformed.
      throw new Error(
        `alter-column on ${renderTable(table)}.${quoteIdentifier(name)} must not carry a not-null name`,
      );
    case 'default':
      return field.after === undefined
        ? `${statement} DROP DEFAULT;`
        : `${statement} SET DEFAULT ${field.after};`;
  }
}

/**
 * One full-explicit `ADD GENERATED … AS IDENTITY` statement, every effective option stated in
 * `create-sequence`'s field order minus `AS`; `SEQUENCE NAME` only when modeled.
 */
function renderAddIdentity(table: TableIdentity, name: string, identity: Identity): string {
  const generated = identity.generated === 'always' ? 'ALWAYS' : 'BY DEFAULT';
  const clauses = [
    ...(identity.sequenceName === undefined
      ? []
      : [`SEQUENCE NAME ${renderSequence(identity.sequenceName)}`]),
    `INCREMENT BY ${identity.increment}`,
    `MINVALUE ${identity.minValue}`,
    `MAXVALUE ${identity.maxValue}`,
    `START WITH ${identity.start}`,
    `CACHE ${identity.cache}`,
    identity.cycle ? 'CYCLE' : 'NO CYCLE',
  ];
  return (
    `ALTER TABLE ${renderTable(table)} ALTER COLUMN ${quoteIdentifier(name)}` +
    ` ADD GENERATED ${generated} AS IDENTITY ( ${clauses.join(' ')} );`
  );
}

/** `DROP IDENTITY` for a column the plan keeps. */
function renderDropIdentity(table: TableIdentity, name: string): string {
  return `ALTER TABLE ${renderTable(table)} ALTER COLUMN ${quoteIdentifier(name)} DROP IDENTITY;`;
}

/** One `ALTER … SET` statement carrying one clause per changed identity field, in field order. */
function renderAlterIdentity(
  table: TableIdentity,
  name: string,
  fields: readonly IdentityFieldChange[],
): string {
  const clauses = fields.map(renderIdentityAlteration).join(' ');
  return `ALTER TABLE ${renderTable(table)} ALTER COLUMN ${quoteIdentifier(name)} ${clauses};`;
}

/** One differing identity field as its `SET` clause; never `AS` and never a sequence name. */
function renderIdentityAlteration(field: IdentityFieldChange): string {
  switch (field.field) {
    case 'generated':
      return field.after === 'always' ? 'SET GENERATED ALWAYS' : 'SET GENERATED BY DEFAULT';
    case 'increment':
      return `SET INCREMENT BY ${field.after}`;
    case 'minValue':
      return `SET MINVALUE ${field.after}`;
    case 'maxValue':
      return `SET MAXVALUE ${field.after}`;
    case 'start':
      return `SET START WITH ${field.after}`;
    case 'cache':
      return `SET CACHE ${field.after}`;
    case 'cycle':
      return field.after ? 'SET CYCLE' : 'SET NO CYCLE';
  }
}

/** A schema-qualified table reference: `<schema>.<name>`, each part quoted as needed. */
function renderTable(identity: TableIdentity): string {
  return `${quoteIdentifier(identity.schema)}.${quoteIdentifier(identity.name)}`;
}

/** A schema-qualified sequence reference, quoted exactly like a table reference. */
function renderSequence(identity: SequenceIdentity): string {
  return renderTable(identity);
}

/** `CREATE SEQUENCE` in canonical full-explicit form, every effective option stated. */
function renderCreateSequence(sequence: Sequence): string {
  const cycle = sequence.cycle ? 'CYCLE' : 'NO CYCLE';
  return (
    `CREATE SEQUENCE ${renderSequence(sequence)} AS ${sequence.dataType}` +
    ` INCREMENT BY ${sequence.increment} MINVALUE ${sequence.minValue}` +
    ` MAXVALUE ${sequence.maxValue} START WITH ${sequence.start}` +
    ` CACHE ${sequence.cache} ${cycle};`
  );
}

/** One `ALTER SEQUENCE` statement carrying one clause per changed field, in field order. */
function renderAlterSequence(
  sequence: SequenceIdentity,
  fields: readonly SequenceFieldChange[],
): string {
  const clauses = fields.map(renderSequenceAlteration).join(' ');
  return `ALTER SEQUENCE ${renderSequence(sequence)} ${clauses};`;
}

/** One differing sequence field as its `ALTER SEQUENCE` clause; reverts state the default. */
function renderSequenceAlteration(field: SequenceFieldChange): string {
  switch (field.field) {
    case 'dataType':
      return `AS ${field.after}`;
    case 'increment':
      return `INCREMENT BY ${field.after}`;
    case 'minValue':
      return `MINVALUE ${field.after}`;
    case 'maxValue':
      return `MAXVALUE ${field.after}`;
    case 'start':
      return `START WITH ${field.after}`;
    case 'cache':
      return `CACHE ${field.after}`;
    case 'cycle':
      return field.after ? 'CYCLE' : 'NO CYCLE';
    case 'ownedBy':
      return field.after === undefined
        ? 'OWNED BY NONE'
        : `OWNED BY ${renderTable(field.after.table)}.${quoteIdentifier(field.after.column)}`;
  }
}

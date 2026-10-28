import type {
  CheckConstraint,
  Column,
  ColumnAttributes,
  ColumnCompression,
  ColumnFieldChange,
  ColumnStorage,
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
  View,
} from '@schemamill/core';

import {
  synthesizedCheckConstraintName,
  synthesizedForeignKeyName,
  synthesizedIndexName,
  synthesizedPrimaryKeyName,
  synthesizedUniqueConstraintName,
  truncateIdentifier,
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
 * statements of one polarity on one table under one server-form name is refused with
 * `RenderRefusalError` before anything renders: the second create could not claim the name,
 * and the second drop would already be gone. A drop and a create of one name are different
 * statements — `index-changed` decomposes that way — and render. `renderSql` walks the plan's
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
 * `create-view` renders `CREATE [MATERIALIZED] VIEW <qname> AS <definition>` and
 * `replace-view` renders `CREATE OR REPLACE VIEW <qname> AS <definition>`; a plain view's
 * check option, when it has one, appends `WITH LOCAL CHECK OPTION` or `WITH CASCADED CHECK
 * OPTION`, and a materialized view always appends `WITH NO DATA` because its populated state
 * is not modeled. `drop-view` renders `DROP VIEW` or `DROP MATERIALIZED VIEW` from the step's
 * `materialized` flag. The definition is emitted exactly as stored, on one line; the renderer
 * never re-deparses it. A materialized `replace-view` is a hand-built-plan error and refuses
 * with `RenderRefusalError` rather than render SQL PostgreSQL would reject.
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
 * Column attributes render in PostgreSQL's grammar order. `renderColumn` states an explicit
 * collation inline, after the type and before the constraints: `name type COLLATE <collation>
 * [NOT NULL] [DEFAULT <x>]`. Inline `STORAGE` and `COMPRESSION` qualifiers are never rendered —
 * both are recent grammar — so a created or added column's explicit storage and compression
 * follow its statement as post-data `ALTER TABLE ONLY` statements, storage before compression,
 * each statement only when the column states it. `CREATE UNLOGGED TABLE` states an `unlogged`
 * table's persistence, and an `alter-persistence` step states the target persistence as
 * `ALTER TABLE <t> SET UNLOGGED;` or the absent `LOGGED` default as `SET LOGGED;`.
 *
 * An `alter-column` step renders its statements in a fixed order: the merged `TYPE` statement
 * when the type or the collation differs, the per-field not-null and default statements, then
 * `SET STORAGE`, then `SET COMPRESSION`. The merged statement is exactly one
 * `ALTER TABLE <t> ALTER COLUMN <c> TYPE <target.type>[ COLLATE <target.collation>];`, both
 * halves read from the step's target `attributes` carrier — a type change on a collated column
 * restates the unchanged collation, and a collation removal renders the bare target type —
 * because PostgreSQL rejects two `TYPE` clauses for one change. A `TYPE` statement resets the
 * column's storage and compression to the type's defaults, so the carrier's explicit values
 * are restated after it; a standalone storage or compression change states its `SET` statement
 * alone, `SET STORAGE DEFAULT` and `SET COMPRESSION default` restoring an absent target. Every
 * `SET STORAGE`/`SET COMPRESSION` statement — create tail, add tail, post-`TYPE` restatement,
 * or standalone — carries the dump's post-data `ONLY` form; only the merged `TYPE` statement
 * stays bare. A plan that reaches the renderer malformed — a `type` or `collation` field whose
 * step carries no `attributes` carrier, or any attribute field reaching the per-field renderer
 * — throws rather than render a guess.
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
 * drop. The synthesis mirrors the server's own naming, `makeObjectName` and the column
 * addition loop, including the 63-byte identifier limit: a name longer than 63 bytes renders
 * in the form PostgreSQL would have stored (see `names.ts`). An explicit name renders exactly
 * as the model stores it, even longer than 63 bytes; PostgreSQL clips such a name at parse
 * time, so the statement still resolves the stored name — a documented residual, not a fix.
 * Index drops are schema-qualified (`DROP INDEX <schema>.<name>`): a bare index name
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
 * server-form name — an explicit name clipped by PostgreSQL's 63-byte identifier limit, the
 * conventional prediction for an unnamed one. Two creates would collide at apply time, and
 * two drops would drop one name twice, so the SQL cannot satisfy the plan;
 * explicit-vs-explicit duplicates are refused too. A drop and a create of one name are
 * different statements — `index-changed` decomposes that way — and render. Only same-table
 * groups are considered: a named index's uniqueness spans its schema, which the plan does not
 * model. A refusal whose unnamed claimant predicted a longer, untruncated name shows that
 * prediction beside the claimant, so a truncation collapse is visible.
 */
function assertIndexNamesUnique(plan: Plan): void {
  const claimed = new Map<string, IndexStatement>();
  for (const step of plan.steps) {
    const statement = indexStatement(step);
    if (statement === undefined) continue;
    const { table, index, polarity } = statement;
    const name = serverIndexName(table, index);
    const key = JSON.stringify([table.schema, table.name, polarity, name]);
    const previous = claimed.get(key);
    if (previous !== undefined) {
      throw new RenderRefusalError(
        `refusing to render: index ${polarity} on ${renderTable(table)} would share the name ` +
          `${JSON.stringify(name)}: ${describeIndex(previous.table, previous.index, name)} and ` +
          `${describeIndex(table, index, name)}`,
      );
    }
    claimed.set(key, statement);
  }
}

/**
 * The server form of an index statement's name: an explicit name clipped by PostgreSQL's
 * 63-byte identifier limit, an unnamed one predicted by the conventional-name mirror.
 */
function serverIndexName(table: TableIdentity, index: Index): string {
  return index.name === undefined
    ? synthesizedIndexName(table, index)
    : truncateIdentifier(index.name);
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
    case 'alter-persistence':
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
    case 'create-view':
    case 'drop-view':
    case 'replace-view':
    case 'comment':
    default:
      return undefined;
  }
}

/**
 * A refusal-message fragment naming one index by its columns and, when stated, its name. When
 * an unnamed index's conventional prediction was truncated to the shared server-form name,
 * the fragment also shows the untruncated prediction, so the reader can see why two
 * structurally different indexes collapsed onto one name; a stated name is already displayed,
 * so it needs no repetition.
 */
function describeIndex(table: TableIdentity, index: Index, serverName: string): string {
  const columns = index.columns.map((column) => quoteIdentifier(column)).join(', ');
  if (index.name !== undefined) {
    return `an index named ${JSON.stringify(index.name)} on (${columns})`;
  }
  const description = `an unnamed index on (${columns})`;
  const prediction = untruncatedIndexName(table, index);
  return prediction === serverName
    ? description
    : `${description} (predicting ${JSON.stringify(prediction)})`;
}

/**
 * The name an unnamed index's conventional formula assembles before PostgreSQL's 63-byte
 * truncation — what the refusal message shows when the server form hides the prediction. It
 * is the raw table name, each raw column, and the `idx` label joined by underscores, with no
 * clipping at all.
 */
function untruncatedIndexName(table: TableIdentity, index: Index): string {
  return `${table.name}${index.columns.map((column) => `_${column}`).join('')}_idx`;
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
      return renderAddColumn(step.table, step.column);
    case 'drop-column':
      return `ALTER TABLE ${renderTable(step.table)} DROP COLUMN ${quoteIdentifier(
        step.column.name,
      )};`;
    case 'alter-column':
      return renderAlterColumn(step.table, step.name, step.fields, step.attributes);
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
    case 'alter-persistence':
      return step.persistence === undefined
        ? `ALTER TABLE ${renderTable(step.table)} SET LOGGED;`
        : `ALTER TABLE ${renderTable(step.table)} SET UNLOGGED;`;
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
    case 'create-view':
      return renderView(step.view, false);
    case 'replace-view':
      return renderView(step.view, true);
    case 'drop-view':
      return step.materialized
        ? `DROP MATERIALIZED VIEW ${renderTable(step.view)};`
        : `DROP VIEW ${renderTable(step.view)};`;
    case 'comment':
      // The `COMMENT ON` renderer lands with the comment SQL workstream (#87); refusing loudly
      // keeps a comment-carrying plan from rendering SQL that silently drops the statement.
      throw new Error('comment steps are not rendered yet');
  }
}

/**
 * `CREATE [UNLOGGED] TABLE` for `table`, one column per line and the primary key trailing.
 * An explicit storage or compression cannot render inline in the create statement, so each
 * such column's post-data `ALTER TABLE ONLY` statements follow it, storage before compression,
 * in column order. An `unlogged` table states `UNLOGGED`.
 */
function renderCreateTable(table: Table): string {
  const persistence = table.persistence === 'unlogged' ? 'UNLOGGED ' : '';
  const lines = table.columns.map((column) => `    ${renderColumn(column)}`);
  if (table.primaryKey !== undefined) lines.push(`    ${renderPrimaryKey(table.primaryKey)}`);
  if (lines.length === 0) return `CREATE ${persistence}TABLE ${renderTable(table)} ();`;

  const body = lines
    .map((line, index) => (index === lines.length - 1 ? line : `${line},`))
    .join('\n');
  const statements = [`CREATE ${persistence}TABLE ${renderTable(table)} (\n${body}\n);`];
  for (const column of table.columns) {
    statements.push(...renderColumnAttributeStatements(table, column));
  }
  return statements.join('\n');
}

/**
 * One added column: the `ADD COLUMN` statement and, for explicit attributes, the post-data
 * `ALTER TABLE ONLY` statements that state them, storage before compression.
 */
function renderAddColumn(table: TableIdentity, column: Column): string {
  const statements = [`ALTER TABLE ${renderTable(table)} ADD COLUMN ${renderColumn(column)};`];
  statements.push(...renderColumnAttributeStatements(table, column));
  return statements.join('\n');
}

/**
 * One column definition: name, type, and the `COLLATE` / `NOT NULL` / `DEFAULT` clauses it
 * carries, in PostgreSQL's grammar order. An explicit collation follows the type; a not-null
 * fact the model names renders PostgreSQL 18's inline `CONSTRAINT <name> NOT NULL`, and
 * without a name it stays the plain `NOT NULL`. An identity descriptor renders nothing here:
 * the plan adds it with its own step. Storage and compression never render inline.
 */
function renderColumn(column: Column): string {
  const collation = column.collation === undefined ? '' : ` COLLATE ${column.collation}`;
  const notNull =
    column.notNull && column.notNullName !== undefined
      ? ` CONSTRAINT ${quoteIdentifier(column.notNullName)} NOT NULL`
      : column.notNull
        ? ' NOT NULL'
        : '';
  const fallback = column.default === undefined ? '' : ` DEFAULT ${column.default}`;
  return `${quoteIdentifier(column.name)} ${column.type}${collation}${notNull}${fallback}`;
}

/**
 * The post-data statements a created or added column's explicit storage and compression need:
 * `ALTER TABLE ONLY … ALTER COLUMN … SET STORAGE …` and `… SET COMPRESSION …`, in that order,
 * each only when the column states it. Inline `STORAGE`/`COMPRESSION` qualifiers are never
 * rendered; `ONLY` matches the dump's post-data form, and inheritance is out of scope.
 */
function renderColumnAttributeStatements(table: TableIdentity, column: Column): string[] {
  const statements: string[] = [];
  if (column.storage !== undefined) {
    statements.push(renderSetStorage(table, column.name, column.storage));
  }
  if (column.compression !== undefined) {
    statements.push(renderSetCompression(table, column.name, column.compression));
  }
  return statements;
}

/**
 * One `SET STORAGE` statement for a column: the explicit method in PostgreSQL's upper-case
 * word, or `DEFAULT` when the target states none (the storage removal). Every form — the
 * `CREATE TABLE`/`ADD COLUMN` tail, the post-`TYPE` restatement, and the standalone change —
 * carries the dump's post-data `ONLY` form; inheritance is out of scope.
 */
function renderSetStorage(
  table: TableIdentity,
  name: string,
  storage: ColumnStorage | undefined,
): string {
  const target = storage === undefined ? 'DEFAULT' : storage.toUpperCase();
  return `ALTER TABLE ONLY ${renderTable(table)} ALTER COLUMN ${quoteIdentifier(name)} SET STORAGE ${target};`;
}

/**
 * One `SET COMPRESSION` statement for a column: the explicit method, or `default` when the
 * target states none (the compression removal). Every form — the `CREATE TABLE`/`ADD COLUMN`
 * tail, the post-`TYPE` restatement, and the standalone change — carries the dump's post-data
 * `ONLY` form; inheritance is out of scope.
 */
function renderSetCompression(
  table: TableIdentity,
  name: string,
  compression: ColumnCompression | undefined,
): string {
  const target = compression === undefined ? 'default' : compression;
  return `ALTER TABLE ONLY ${renderTable(table)} ALTER COLUMN ${quoteIdentifier(name)} SET COMPRESSION ${target};`;
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

/**
 * One `alter-column` step as its statements, joined `\n`, in the step's fixed order: the
 * merged `TYPE` statement when the type or the collation differs, the per-field not-null and
 * default statements, then `SET STORAGE`, then `SET COMPRESSION`. The merged statement reads
 * both halves from the step's target `attributes` carrier and states the target collation only
 * when it has one; a `TYPE` statement resets storage and compression to the type's defaults,
 * so the carrier's explicit values are restated after it. With no type or collation change, a
 * storage or compression field states its own `SET` statement, the absent target restoring the
 * default. Every `SET` statement carries the dump's post-data `ONLY` form; only the merged
 * `TYPE` statement stays bare. A `type` or `collation` field without its carrier is a
 * malformed plan and throws.
 */
function renderAlterColumn(
  table: TableIdentity,
  name: string,
  fields: readonly ColumnFieldChange[],
  attributes: ColumnAttributes | undefined,
): string {
  const statement = `ALTER TABLE ${renderTable(table)} ALTER COLUMN ${quoteIdentifier(name)}`;
  const merged = fields.some((field) => field.field === 'type' || field.field === 'collation');
  const carrier = merged ? requiredAttributes(table, name, attributes) : undefined;
  const statements: string[] = [];
  if (carrier !== undefined) {
    const collation = carrier.collation === undefined ? '' : ` COLLATE ${carrier.collation}`;
    statements.push(`${statement} TYPE ${carrier.type}${collation};`);
  }
  for (const field of fields) {
    if (field.field === 'notNull' || field.field === 'default') {
      statements.push(renderColumnAlteration(table, name, field));
    }
  }
  if (carrier !== undefined) {
    // The TYPE statement's reset matches a target that states no value, so only the explicit
    // ones restate.
    if (carrier.storage !== undefined) {
      statements.push(renderSetStorage(table, name, carrier.storage));
    }
    if (carrier.compression !== undefined) {
      statements.push(renderSetCompression(table, name, carrier.compression));
    }
  } else {
    for (const field of fields) {
      if (field.field === 'storage') {
        statements.push(renderSetStorage(table, name, field.after));
      } else if (field.field === 'compression') {
        statements.push(renderSetCompression(table, name, field.after));
      }
    }
  }
  return statements.join('\n');
}

/**
 * The step's target `attributes` carrier, or a malformed-plan error: a `type` or `collation`
 * field drives the merged `TYPE` statement whose type and collation both come from the
 * carrier, so a step without one cannot render the change it carries.
 */
function requiredAttributes(
  table: TableIdentity,
  name: string,
  attributes: ColumnAttributes | undefined,
): ColumnAttributes {
  if (attributes === undefined) {
    throw new Error(
      `alter-column on ${renderTable(table)}.${quoteIdentifier(name)} must carry the target attributes of a type or collation change`,
    );
  }
  return attributes;
}

/**
 * One per-field `ALTER COLUMN` statement for a differing not-null or default value; every
 * other field belongs to the merged `TYPE` builder or the storage/compression statements, so
 * reaching here means the plan is malformed.
 */
function renderColumnAlteration(
  table: TableIdentity,
  name: string,
  field: ColumnFieldChange,
): string {
  const statement = `ALTER TABLE ${renderTable(table)} ALTER COLUMN ${quoteIdentifier(name)}`;
  switch (field.field) {
    case 'notNull':
      return `${statement} ${field.after ? 'SET' : 'DROP'} NOT NULL;`;
    case 'notNullName':
      // The plan consumes a name-involved change into drop-not-null/add-not-null steps, so a
      // name never reaches an alter-column; reaching here means the plan is malformed.
      throw new Error(
        `alter-column on ${renderTable(table)}.${quoteIdentifier(name)} must not carry a not-null name`,
      );
    case 'type':
    case 'collation':
    case 'storage':
    case 'compression':
      // The merged TYPE builder and the storage/compression statements own these fields — a
      // TYPE statement restates the target collation and the SET statements state storage and
      // compression — so they never reach the per-field renderer; reaching here means the
      // plan is malformed.
      throw new Error(
        `alter-column on ${renderTable(table)}.${quoteIdentifier(name)} must not carry a ${field.field} change`,
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

/**
 * `CREATE [OR REPLACE] [MATERIALIZED] VIEW <qname> AS <definition>[ WITH … CHECK OPTION]`, a
 * materialized view always ending in `WITH NO DATA`. The definition is emitted exactly as
 * stored. A `replace-view` step that carries a materialized view cannot render soundly —
 * PostgreSQL has no `CREATE OR REPLACE MATERIALIZED VIEW` — so the hand-built plan is refused.
 */
function renderView(view: View, replace: boolean): string {
  if (replace && view.materialized) {
    throw new RenderRefusalError(
      `refusing to render: replace-view on ${renderTable(view)} cannot replace a materialized view`,
    );
  }
  const kind = view.materialized ? 'MATERIALIZED VIEW' : 'VIEW';
  const replacement = replace ? 'OR REPLACE ' : '';
  const checkOption =
    view.checkOption === undefined
      ? ''
      : ` WITH ${view.checkOption === 'local' ? 'LOCAL' : 'CASCADED'} CHECK OPTION`;
  const data = view.materialized ? ' WITH NO DATA' : '';
  return `CREATE ${replacement}${kind} ${renderTable(view)} AS ${view.definition}${checkOption}${data};`;
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

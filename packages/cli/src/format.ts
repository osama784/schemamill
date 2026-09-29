import type {
  Change,
  Column,
  ColumnFieldChange,
  ForeignKey,
  Plan,
  PrimaryKey,
  Step,
  Table,
  TableChange,
  TableIdentity,
} from '@schemamill/core';

/**
 * Human-readable rendering of a diff and a migration plan for the terminal.
 *
 * The functions here are pure and deterministic: the same payload always renders the same
 * text, with no I/O, no dates, and no environment reads. Model values are emitted exactly as
 * stored — names unquoted, `type` and `default` text untouched, no colour and no TTY
 * detection — and `(none)` stands in for a field a payload omits.
 *
 * A diff renders as one block per change, blank-line separated: `+`, `-`, or `~` then
 * `table <schema>.<name>`, followed by four-space-indented member lines. A plan renders as a
 * numbered header and one line per step; a step's kind label is padded to the longest label
 * in the plan so the details align, and a step's details expose every payload field it
 * carries. SQL is not rendered here: the `plan` command appends `renderSql`'s output.
 */

/** The whole diff as `compare` prints it: `No changes.` or one block per change, in order. */
export function formatChanges(changes: readonly Change[]): string {
  if (changes.length === 0) return 'No changes.\n';
  return `${changes.map(formatChange).join('\n\n')}\n`;
}

/** The whole plan as `plan` prints it, before the migration SQL. */
export function formatPlan(plan: Plan): string {
  if (plan.steps.length === 0) return 'No changes.\n';

  const count = plan.steps.length;
  const numberWidth = String(count).length;
  const kindWidth = plan.steps.reduce((width, step) => Math.max(width, step.kind.length), 0);
  const lines = [`${count} ${count === 1 ? 'step' : 'steps'}:`];
  plan.steps.forEach((step, index) => {
    const number = String(index + 1).padStart(numberWidth);
    lines.push(` ${number}. ${step.kind.padEnd(kindWidth)}  ${formatStep(step)}`);
  });
  return `${lines.join('\n')}\n`;
}

/** One table-level change: the signed table line and its indented member lines. */
function formatChange(change: Change): string {
  switch (change.kind) {
    case 'table-added':
      return formatTable('+', change.table);
    case 'table-removed':
      return formatTable('-', change.table);
    case 'table-changed': {
      const lines = [`~ table ${formatIdentity(change.table)}`];
      for (const tableChange of change.changes) {
        lines.push(`    ${formatTableChange(tableChange)}`);
      }
      return lines.join('\n');
    }
  }
}

/** A table line and its members: columns in stored order, then primary key, then foreign keys. */
function formatTable(sign: string, table: Table): string {
  const lines = [`${sign} table ${formatIdentity(table)}`];
  for (const column of table.columns) lines.push(`    ${formatColumn(column)}`);
  if (table.primaryKey !== undefined) lines.push(`    ${formatPrimaryKey(table.primaryKey)}`);
  for (const foreignKey of table.foreignKeys) lines.push(`    ${formatForeignKey(foreignKey)}`);
  return lines.join('\n');
}

/** One member change inside a changed table, in the diff's change vocabulary. */
function formatTableChange(change: TableChange): string {
  switch (change.kind) {
    case 'column-added':
      return `+ column ${formatColumn(change.column)}`;
    case 'column-removed':
      return `- column ${formatColumn(change.column)}`;
    case 'column-changed':
      return `~ column ${change.name}: ${formatColumnFields(change.fields)}`;
    case 'primary-key-added':
      return `+ ${formatPrimaryKey(change.primaryKey)}`;
    case 'primary-key-removed':
      return `- ${formatPrimaryKey(change.primaryKey)}`;
    case 'primary-key-changed':
      return `~ primary key ${formatPrimaryKeySide(change.before)} → ${formatPrimaryKeySide(
        change.after,
      )}`;
    case 'foreign-key-added':
      return `+ ${formatForeignKey(change.foreignKey)}`;
    case 'foreign-key-removed':
      return `- ${formatForeignKey(change.foreignKey)}`;
    case 'foreign-key-changed':
      return `~ foreign key (${change.before.columns.join(', ')}) → ${formatIdentity(
        change.before.referencedTable,
      )}: ${formatForeignKeyChanges(change.before, change.after)}`;
  }
}

/** One step's details: every payload field the step carries, in the step kind's order. */
function formatStep(step: Step): string {
  switch (step.kind) {
    case 'create-table':
    case 'drop-table':
      return formatIdentity(step.table);
    case 'add-column':
    case 'drop-column':
      return `${formatIdentity(step.table)}.${formatColumn(step.column)}`;
    case 'alter-column':
      return `${formatIdentity(step.table)}.${step.name}: ${formatColumnFields(step.fields)}`;
    case 'add-primary-key':
    case 'drop-primary-key':
      return `${formatIdentity(step.table)}: ${formatPrimaryKey(step.primaryKey)}`;
    case 'add-foreign-key':
    case 'drop-foreign-key':
      return `${formatIdentity(step.table)}: ${formatForeignKey(step.foreignKey)}`;
  }
}

/** `schema.name`, exactly as stored; no SQL quoting. */
function formatIdentity(identity: TableIdentity): string {
  return `${identity.schema}.${identity.name}`;
}

/** A column as `<name> <type>` plus ` NOT NULL` and ` DEFAULT <default>` when it carries them. */
function formatColumn(column: Column): string {
  const nameAndType = [column.name, column.type].filter((part) => part !== '').join(' ');
  const clauses: string[] = [];
  if (column.notNull) clauses.push('NOT NULL');
  if (column.default !== undefined && column.default !== '') {
    clauses.push(`DEFAULT ${column.default}`);
  }
  return [nameAndType, ...clauses].join(' ');
}

/** `<name> (<cols>)` when named, `(<cols>)` otherwise; how a changed pair prints one side. */
function formatPrimaryKeySide(primaryKey: PrimaryKey): string {
  const name = primaryKey.name === undefined ? '' : `${primaryKey.name} `;
  return `${name}(${primaryKey.columns.join(', ')})`;
}

/** A primary-key constraint line, named when the payload names it. */
function formatPrimaryKey(primaryKey: PrimaryKey): string {
  return `primary key ${formatPrimaryKeySide(primaryKey)}`;
}

/** A foreign-key constraint line: name, referencing columns, target, referenced columns, actions. */
function formatForeignKey(foreignKey: ForeignKey): string {
  const name = foreignKey.name === undefined ? '' : `${foreignKey.name} `;
  const columns = foreignKey.columns.join(', ');
  const referencedColumns =
    foreignKey.referencedColumns.length === 0
      ? ''
      : ` (${foreignKey.referencedColumns.join(', ')})`;
  let text = `foreign key ${name}(${columns}) → ${formatIdentity(
    foreignKey.referencedTable,
  )}${referencedColumns}`;
  if (foreignKey.onUpdate !== undefined) text += ` on update ${foreignKey.onUpdate}`;
  if (foreignKey.onDelete !== undefined) text += ` on delete ${foreignKey.onDelete}`;
  return text;
}

/** A changed column's differing fields, in the diff's order, joined `, `. */
function formatColumnFields(fields: readonly ColumnFieldChange[]): string {
  return fields.map(formatColumnField).join(', ');
}

/** One column field change; `default` names the absent side `(none)`. */
function formatColumnField(field: ColumnFieldChange): string {
  switch (field.field) {
    case 'type':
      return `type ${field.before} → ${field.after}`;
    case 'notNull':
      return `not null ${String(field.before)} → ${String(field.after)}`;
    case 'default':
      return `default ${formatOptional(field.before)} → ${formatOptional(field.after)}`;
  }
}

/**
 * A changed foreign-key pair's differing fields — name, referenced columns, `ON UPDATE`,
 * `ON DELETE`, in that order, joined `, `. The pairing identity (referencing columns →
 * referenced table) anchors the line and is never repeated here.
 */
function formatForeignKeyChanges(before: ForeignKey, after: ForeignKey): string {
  const fields: string[] = [];
  if (before.name !== after.name) {
    fields.push(`name ${formatOptional(before.name)} → ${formatOptional(after.name)}`);
  }
  if (!sameStrings(before.referencedColumns, after.referencedColumns)) {
    fields.push(
      `referenced columns (${before.referencedColumns.join(
        ', ',
      )}) → (${after.referencedColumns.join(', ')})`,
    );
  }
  if (before.onUpdate !== after.onUpdate) {
    fields.push(`on update ${formatOptional(before.onUpdate)} → ${formatOptional(after.onUpdate)}`);
  }
  if (before.onDelete !== after.onDelete) {
    fields.push(`on delete ${formatOptional(before.onDelete)} → ${formatOptional(after.onDelete)}`);
  }
  return fields.join(', ');
}

/** The value when present, `(none)` when the payload omits it. */
function formatOptional(value: string | undefined): string {
  return value === undefined ? '(none)' : value;
}

/** Whether two column-name arrays hold exactly the same names in the same order. */
function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

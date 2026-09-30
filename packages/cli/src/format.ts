import type {
  Change,
  Column,
  ColumnFieldChange,
  ForeignKey,
  IdentityChange,
  IdentityFieldChange,
  IdentityGeneration,
  Plan,
  PrimaryKey,
  Sequence,
  SequenceFieldChange,
  SequenceOwner,
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
 * stored — names unquoted, `type` and `default` text untouched, sequence option values as
 * their exact decimal strings, no colour and no TTY detection — and `(none)` stands in for a
 * field a payload omits. A bound the engine's type conversion produced prints as its exact
 * decimal string with a `(converted)` mark, because the diff reports the value in effect
 * after the conversion, not the as-written baseline value.
 *
 * A diff renders as one block per change, blank-line separated: `+`, `-`, or `~` then
 * `table <schema>.<name>`, followed by four-space-indented member lines; a changed column
 * carries its scalar fields on the `~ column` line and one `identity:` sub-line per identity
 * change after it; sequences render the same way after the table changes, as
 * `sequence <schema>.<name>` with one option per line. A plan renders as a numbered header
 * and one line per step; a step's kind label is padded to the longest label in the plan so
 * the details align, and a step's details expose every payload field it carries. SQL is not
 * rendered here: the `plan` command appends `renderSql`'s output.
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
    case 'sequence-added':
      return formatSequence('+', change.sequence);
    case 'sequence-removed':
      return formatSequence('-', change.sequence);
    case 'sequence-changed': {
      const lines = [`~ sequence ${formatIdentity(change.sequence)}`];
      for (const field of change.changes) {
        lines.push(`    ${formatSequenceField(field)}`);
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
      return formatColumnChange(change.name, change.fields, change.identity);
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
    case 'create-sequence':
    case 'drop-sequence':
      return formatIdentity(step.sequence);
    case 'alter-sequence':
      return `${formatIdentity(step.sequence)}: ${step.fields.map(formatSequenceField).join(', ')}`;
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

/** A sequence line and its options: the signed identity, then every option one per line. */
function formatSequence(sign: string, sequence: Sequence): string {
  const lines = [`${sign} sequence ${formatIdentity(sequence)}`];
  lines.push(`    data type ${sequence.dataType}`);
  lines.push(`    increment ${sequence.increment}`);
  lines.push(`    min value ${sequence.minValue}`);
  lines.push(`    max value ${sequence.maxValue}`);
  lines.push(`    start ${sequence.start}`);
  lines.push(`    cache ${sequence.cache}`);
  lines.push(`    cycle ${String(sequence.cycle)}`);
  if (sequence.ownedBy !== undefined) lines.push(`    owned by ${formatOwner(sequence.ownedBy)}`);
  return lines.join('\n');
}

/** One changed sequence option, in the diff's fixed order; an absent owner prints `(none)`. */
function formatSequenceField(field: SequenceFieldChange): string {
  switch (field.field) {
    case 'dataType':
      return `data type ${field.before} → ${field.after}`;
    case 'increment':
      return `increment ${field.before} → ${field.after}`;
    case 'minValue':
      return `min value ${formatBoundChange(field.before, field.after, field.converted)}`;
    case 'maxValue':
      return `max value ${formatBoundChange(field.before, field.after, field.converted)}`;
    case 'start':
      return `start ${field.before} → ${field.after}`;
    case 'cache':
      return `cache ${field.before} → ${field.after}`;
    case 'cycle':
      return `cycle ${String(field.before)} → ${String(field.after)}`;
    case 'ownedBy':
      return `owned by ${formatOptionalOwner(field.before)} → ${formatOptionalOwner(field.after)}`;
  }
}

/**
 * A `minValue`/`maxValue` change; `(converted)` marks a `before` value the engine's type
 * conversion produced rather than one the baseline stated, so the line never presents a
 * converted value as the as-written baseline.
 */
function formatBoundChange(before: string, after: string, converted?: boolean): string {
  return `${before}${converted === true ? ' (converted)' : ''} → ${after}`;
}

/** A sequence owner as `<schema>.<table>.<column>`, names unquoted. */
function formatOwner(owner: SequenceOwner): string {
  return `${formatIdentity(owner.table)}.${owner.column}`;
}

/** An optional sequence owner: the owner, or `(none)`. */
function formatOptionalOwner(owner: SequenceOwner | undefined): string {
  return owner === undefined ? '(none)' : formatOwner(owner);
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
 * A changed column: the scalar fields on the `~ column` line, then one `identity:` sub-line
 * per identity change. A column whose only change is its identity carries the first identity
 * line on the column line instead, so no line dangles after a colon.
 */
function formatColumnChange(
  name: string,
  fields: readonly ColumnFieldChange[],
  identity: IdentityChange | undefined,
): string {
  const identityLines = identity === undefined ? [] : formatIdentityChange(identity);
  if (fields.length > 0) {
    return [
      `~ column ${name}: ${formatColumnFields(fields)}`,
      ...identityLines.map(indentSubLine),
    ].join('\n');
  }
  const [first, ...rest] = identityLines;
  return [`~ column ${name}: ${first ?? ''}`, ...rest.map(indentSubLine)].join('\n');
}

/** Indents an identity sub-line to sit under the column line it belongs to. */
function indentSubLine(line: string): string {
  return `        ${line}`;
}

/**
 * One identity difference as its `identity:`-prefixed lines: a marker for an addition,
 * removal, or recreation, and one line per differing option in the diff's fixed order.
 */
function formatIdentityChange(change: IdentityChange): string[] {
  switch (change.kind) {
    case 'added':
    case 'removed':
    case 'recreated':
      return [`identity: ${change.kind}`];
    case 'changed':
      return change.fields.map((field) => `identity: ${formatIdentityField(field)}`);
  }
}

/** One changed identity option; `generated` prints SQL's spelling of the mode. */
function formatIdentityField(field: IdentityFieldChange): string {
  switch (field.field) {
    case 'generated':
      return `GENERATED ${formatGeneration(field.before)} → ${formatGeneration(field.after)}`;
    case 'increment':
      return `increment ${field.before} → ${field.after}`;
    case 'minValue':
      return `min value ${formatBoundChange(field.before, field.after, field.converted)}`;
    case 'maxValue':
      return `max value ${formatBoundChange(field.before, field.after, field.converted)}`;
    case 'start':
      return `start ${field.before} → ${field.after}`;
    case 'cache':
      return `cache ${field.before} → ${field.after}`;
    case 'cycle':
      return `cycle ${String(field.before)} → ${String(field.after)}`;
  }
}

/** The SQL spelling of a generation mode, which the model stores in words. */
function formatGeneration(generation: IdentityGeneration): string {
  return generation === 'always' ? 'ALWAYS' : 'BY DEFAULT';
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

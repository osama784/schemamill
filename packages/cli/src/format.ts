import type {
  Change,
  CheckConstraint,
  Column,
  ColumnFieldChange,
  ForeignKey,
  Hazard,
  HazardEntity,
  IdentityChange,
  IdentityFieldChange,
  IdentityGeneration,
  Index,
  Plan,
  PrimaryKey,
  Sequence,
  SequenceFieldChange,
  SequenceOwner,
  Step,
  Table,
  TableChange,
  TableIdentity,
  UniqueConstraint,
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
 * and one line per step: a plan that is a single transactional group covering every step
 * reads `N steps in one transaction:` (singular `1 step in one transaction:`); a plan whose
 * only group is non-transactional reads `N steps outside a transaction:`; a multi-group plan
 * reads `N steps in M groups:` with a `group k of M:` or `group k of M (standalone):` section
 * per group, its steps indented four spaces and numbered continuously; and an empty plan
 * reads `No changes.`. A step's kind label is padded to the longest label in the plan so
 * the details align, and a step's details expose every payload field it carries. A hazards
 * block renders as a `Hazards:` header and one two-space-indented
 * `step <n> <kind> <entity>: <clause>` line per hazard, numbered by the step it belongs to, in
 * the payload's order; the entity names the sequence (`schema.name`) or the identity column
 * (`schema.table.column`) the hazard belongs to, and each clause states the failure PostgreSQL
 * would hit at apply. SQL is not rendered here: the `plan` command prints the plan, then the
 * hazards block when the analysis finds any, then `renderSql`'s output, blank-line separated.
 */

/** The whole diff as `compare` prints it: `No changes.` or one block per change, in order. */
export function formatChanges(changes: readonly Change[]): string {
  if (changes.length === 0) return 'No changes.\n';
  return `${changes.map(formatChange).join('\n\n')}\n`;
}

/**
 * The whole plan as `plan` prints it, before the migration SQL: the numbered header, then one
 * line per step. A plan that is a single group names the group's transaction scope in the
 * header — `in one transaction` for a transactional group, `outside a transaction` otherwise;
 * a multi-group plan names the group count and opens one section per group.
 */
export function formatPlan(plan: Plan): string {
  if (plan.steps.length === 0) return 'No changes.\n';

  const count = plan.steps.length;
  const numberWidth = String(count).length;
  const kindWidth = plan.steps.reduce((width, step) => Math.max(width, step.kind.length), 0);
  const noun = `${count} ${count === 1 ? 'step' : 'steps'}`;
  const groupCount = plan.groups.length;
  const [group] = plan.groups;

  if (groupCount === 0) {
    // A step list with no groups is malformed; the plain header invents no transaction.
    const lines = [`${noun}:`];
    plan.steps.forEach((step, index) => {
      lines.push(formatStepLine(step, index + 1, numberWidth, kindWidth, ' '));
    });
    return `${lines.join('\n')}\n`;
  }

  if (group !== undefined && groupCount === 1) {
    const scope = group.transactional ? 'in one transaction' : 'outside a transaction';
    const lines = [`${noun} ${scope}:`];
    plan.steps.forEach((step, index) => {
      lines.push(formatStepLine(step, index + 1, numberWidth, kindWidth, ' '));
    });
    return `${lines.join('\n')}\n`;
  }

  const lines = [`${noun} in ${groupCount} groups:`];
  plan.groups.forEach((group, index) => {
    const standalone = group.transactional ? '' : ' (standalone)';
    lines.push(`  group ${index + 1} of ${groupCount}${standalone}:`);
    for (let stepIndex = group.start; stepIndex < group.end; stepIndex += 1) {
      lines.push(
        formatStepLine(plan.steps[stepIndex]!, stepIndex + 1, numberWidth, kindWidth, '    '),
      );
    }
  });
  return `${lines.join('\n')}\n`;
}

/** One numbered step line, indented for its context; kinds align across the whole plan. */
function formatStepLine(
  step: Step,
  number: number,
  numberWidth: number,
  kindWidth: number,
  indent: string,
): string {
  const label = String(number).padStart(numberWidth);
  return `${indent}${label}. ${step.kind.padEnd(kindWidth)}  ${formatStep(step)}`;
}

/**
 * The whole hazards block as `plan` prints it, when the analysis finds any: the `Hazards:`
 * header and one two-space-indented `step <n> <kind> <entity>: <clause>` line per hazard,
 * numbered by the hazard's step and naming the entity it belongs to, in the payload's order.
 * An empty array renders the header alone; `plan` skips the block instead.
 */
export function formatHazards(hazards: readonly Hazard[]): string {
  const lines = ['Hazards:'];
  for (const hazard of hazards) {
    lines.push(
      `  step ${hazard.step + 1} ${hazard.kind} ${formatEntity(hazard.entity)}: ${formatHazard(hazard)}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** The hazard entity's label: `schema.name` for a sequence, `schema.table.column` for a column. */
function formatEntity(entity: HazardEntity): string {
  switch (entity.kind) {
    case 'sequence':
      return formatIdentity(entity.sequence);
    case 'identity-column':
      return `${formatIdentity(entity.table)}.${entity.column}`;
  }
}

/** One hazard's clause: the definite failure PostgreSQL hits at apply, or the conditional one. */
function formatHazard(hazard: Hazard): string {
  switch (hazard.kind) {
    case 'increment-zero':
      return `INCREMENT ${hazard.increment} — PostgreSQL rejects this at apply (INCREMENT must not be zero).`;
    case 'cache-nonpositive':
      return `CACHE ${hazard.cache} — PostgreSQL rejects this at apply (CACHE (${hazard.cache}) must be greater than zero).`;
    case 'bounds-inverted':
      return `MINVALUE ${hazard.minValue} must be less than MAXVALUE ${hazard.maxValue} — PostgreSQL rejects this at apply.`;
    case 'start-out-of-bounds':
      return BigInt(hazard.start) < BigInt(hazard.minValue)
        ? `START ${hazard.start} is less than MINVALUE ${hazard.minValue} — PostgreSQL rejects this at apply.`
        : `START ${hazard.start} is greater than MAXVALUE ${hazard.maxValue} — PostgreSQL rejects this at apply.`;
    case 'bound-out-of-type-range':
      return `${formatBoundField(hazard.field)} ${hazard.value} is out of range for sequence data type ${hazard.dataType} — PostgreSQL rejects this at apply.`;
    case 'bound-tightened':
      return `${formatBoundField(hazard.field, true)} ${hazard.before} → ${hazard.after} — may fail at apply; PostgreSQL cross-checks the sequence's current value against the tightened bound, and sequence state is not modeled.`;
  }
}

/** A bound's keyword: `MINVALUE`/`MAXVALUE` in SQL's spelling, or the diff's prose spelling. */
function formatBoundField(field: 'min' | 'max', prose = false): string {
  if (prose) return field === 'min' ? 'min value' : 'max value';
  return field === 'min' ? 'MINVALUE' : 'MAXVALUE';
}

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

/**
 * A table line and its members: columns in stored order, then primary key, foreign keys,
 * unique constraints, check constraints, and indexes, each in the model's order.
 */
function formatTable(sign: string, table: Table): string {
  const lines = [`${sign} table ${formatIdentity(table)}`];
  for (const column of table.columns) lines.push(`    ${formatColumn(column)}`);
  if (table.primaryKey !== undefined) lines.push(`    ${formatPrimaryKey(table.primaryKey)}`);
  for (const foreignKey of table.foreignKeys) lines.push(`    ${formatForeignKey(foreignKey)}`);
  for (const uniqueConstraint of table.uniqueConstraints) {
    lines.push(`    ${formatUniqueConstraint(uniqueConstraint)}`);
  }
  for (const checkConstraint of table.checkConstraints) {
    lines.push(`    ${formatCheckConstraint(checkConstraint)}`);
  }
  for (const index of table.indexes) lines.push(`    ${formatIndex(index)}`);
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
    case 'unique-constraint-added':
      return `+ ${formatUniqueConstraint(change.uniqueConstraint)}`;
    case 'unique-constraint-removed':
      return `- ${formatUniqueConstraint(change.uniqueConstraint)}`;
    case 'unique-constraint-changed':
      return `~ unique constraint (${change.before.columns.join(
        ', ',
      )}): name ${formatOptional(change.before.name)} → ${formatOptional(change.after.name)}`;
    case 'check-constraint-added':
      return `+ ${formatCheckConstraint(change.checkConstraint)}`;
    case 'check-constraint-removed':
      return `- ${formatCheckConstraint(change.checkConstraint)}`;
    case 'check-constraint-changed':
      return `~ check constraint (${change.before.expression}): name ${formatOptional(
        change.before.name,
      )} → ${formatOptional(change.after.name)}`;
    case 'index-added':
      return `+ ${formatIndex(change.index)}`;
    case 'index-removed':
      return `- ${formatIndex(change.index)}`;
    case 'index-changed':
      return `~ index ${formatOptional(change.before.name)}: ${formatIndexChanges(
        change.before,
        change.after,
      )}`;
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
    case 'drop-not-null':
    case 'add-not-null':
      return step.name === undefined
        ? `${formatIdentity(step.table)}.${step.column}`
        : `${formatIdentity(step.table)}.${step.column} (${step.name})`;
    case 'add-identity':
    case 'drop-identity':
      return `${formatIdentity(step.table)}.${step.name}`;
    case 'alter-identity':
      return `${formatIdentity(step.table)}.${step.name}: ${step.fields
        .map(formatIdentityField)
        .join(', ')}`;
    case 'add-primary-key':
    case 'drop-primary-key':
      return `${formatIdentity(step.table)}: ${formatPrimaryKey(step.primaryKey)}`;
    case 'add-foreign-key':
    case 'drop-foreign-key':
      return `${formatIdentity(step.table)}: ${formatForeignKey(step.foreignKey)}`;
    case 'add-unique-constraint':
    case 'drop-unique-constraint':
      return `${formatIdentity(step.table)}: ${formatUniqueConstraint(step.uniqueConstraint)}`;
    case 'add-check-constraint':
    case 'drop-check-constraint':
      return `${formatIdentity(step.table)}: ${formatCheckConstraint(step.checkConstraint)}`;
    case 'create-index':
    case 'drop-index':
    case 'create-index-concurrently':
    case 'drop-index-concurrently':
      return `${formatIdentity(step.table)}: ${formatIndex(step.index)}`;
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

/**
 * A column as `<name> <type>` plus ` NOT NULL`, ` DEFAULT <default>`, and, when it carries one,
 * a compact `identity: GENERATED …` clause naming the generation mode. The identity descriptor's
 * sequence name and options are not spelled out here; a changed column's identity options get
 * their own `identity:` sub-lines.
 */
function formatColumn(column: Column): string {
  const nameAndType = [column.name, column.type].filter((part) => part !== '').join(' ');
  const clauses: string[] = [];
  if (column.notNull) clauses.push('NOT NULL');
  if (column.default !== undefined && column.default !== '') {
    clauses.push(`DEFAULT ${column.default}`);
  }
  if (column.identity !== undefined) {
    clauses.push(`identity: GENERATED ${formatGeneration(column.identity.generated)}`);
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

/** A unique-constraint line: its name when the payload names it, then its ordered columns. */
function formatUniqueConstraint(uniqueConstraint: UniqueConstraint): string {
  const name = uniqueConstraint.name === undefined ? '' : `${uniqueConstraint.name} `;
  return `unique constraint ${name}(${uniqueConstraint.columns.join(', ')})`;
}

/** A check-constraint line: its name when the payload names it, then its opaque expression. */
function formatCheckConstraint(checkConstraint: CheckConstraint): string {
  const name = checkConstraint.name === undefined ? '' : `${checkConstraint.name} `;
  return `check constraint ${name}CHECK (${checkConstraint.expression})`;
}

/** An index line: `unique` when it is, its name when present, then its ordered columns. */
function formatIndex(index: Index): string {
  const unique = index.unique ? 'unique ' : '';
  const name = index.name === undefined ? '' : `${index.name} `;
  return `${unique}index ${name}(${index.columns.join(', ')})`;
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

/** One column field change; `default` and `notNullName` name the absent side `(none)`. */
function formatColumnField(field: ColumnFieldChange): string {
  switch (field.field) {
    case 'type':
      return `type ${field.before} → ${field.after}`;
    case 'notNull':
      return `not null ${String(field.before)} → ${String(field.after)}`;
    case 'notNullName':
      return `not null name ${formatOptional(field.before)} → ${formatOptional(field.after)}`;
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

/**
 * A changed index pair's differing fields — `unique`, then `columns`, in that order, joined
 * `, `. The pairing identity (the name) anchors the line and is never repeated here;
 * `concurrently` is apply metadata and never a difference.
 */
function formatIndexChanges(before: Index, after: Index): string {
  const fields: string[] = [];
  if (before.unique !== after.unique) {
    fields.push(`unique ${String(before.unique)} → ${String(after.unique)}`);
  }
  if (!sameStrings(before.columns, after.columns)) {
    fields.push(`columns (${before.columns.join(', ')}) → (${after.columns.join(', ')})`);
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

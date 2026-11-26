import type {
  CheckConstraint,
  Column,
  Extension,
  ForeignKey,
  Identity,
  Index,
  Model,
  PrimaryKey,
  Sequence,
  Table,
  TableIdentity,
  UniqueConstraint,
  View,
} from '@schemamill/core';
import { serializeIndexElement } from '@schemamill/core';

/**
 * The deterministic Markdown projection of the canonical model (brief v4, D1–D3).
 *
 * This module is pure: it imports only model types, reads no clock, filesystem, locale or
 * environment, and leaves every stream to the command layer. The renderer sorts every collection
 * itself because the workspace reader preserves file order for nested arrays; columns are the one
 * exception, since their source order is part of a table's shape. Every heading is followed by
 * exactly one blank line, consecutive bullets are contiguous, nested bullets are indented two
 * spaces, and the result ends in exactly one LF.
 */

type Comparator<T> = (left: T, right: T) => number;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareBooleans(left: boolean, right: boolean): number {
  return Number(left) - Number(right);
}

function compareOptional<T>(
  left: T | undefined,
  right: T | undefined,
  compare: Comparator<T>,
): number {
  if (left === undefined) return right === undefined ? 0 : -1;
  if (right === undefined) return 1;
  return compare(left, right);
}

function compareArrays<T>(left: readonly T[], right: readonly T[], compare: Comparator<T>): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index++) {
    const result = compare(left[index]!, right[index]!);
    if (result !== 0) return result;
  }
  return left.length - right.length;
}

function chain<T>(...comparators: ReadonlyArray<Comparator<T>>): Comparator<T> {
  return (left, right) => {
    for (const compare of comparators) {
      const result = compare(left, right);
      if (result !== 0) return result;
    }
    return 0;
  };
}

/** Total order: the pinned keys, then a plain string comparison of the serialized entry. */
function sorted<T>(items: readonly T[], compare: Comparator<T>): T[] {
  return [...items].sort(
    (left, right) =>
      compare(left, right) || compareStrings(JSON.stringify(left), JSON.stringify(right)),
  );
}

const compareIdentity = chain<TableIdentity>(
  (left, right) => compareStrings(left.schema, right.schema),
  (left, right) => compareStrings(left.name, right.name),
);

const compareIndexes = chain<Index>(
  (left, right) => compareOptional(left.name, right.name, compareStrings),
  (left, right) => compareBooleans(left.unique, right.unique),
  (left, right) =>
    compareArrays(left.columns, right.columns, (before, after) =>
      compareStrings(serializeIndexElement(before), serializeIndexElement(after)),
    ),
  (left, right) => compareArrays(left.include ?? [], right.include ?? [], compareStrings),
  (left, right) => compareOptional(left.where, right.where, compareStrings),
);

const compareUniqueConstraints = chain<UniqueConstraint>(
  (left, right) => compareArrays(left.columns, right.columns, compareStrings),
  (left, right) => compareOptional(left.name, right.name, compareStrings),
);

const compareCheckConstraints = chain<CheckConstraint>(
  (left, right) => compareStrings(left.expression, right.expression),
  (left, right) => compareOptional(left.name, right.name, compareStrings),
);

const compareForeignKeys = chain<ForeignKey>(
  (left, right) => compareArrays(left.columns, right.columns, compareStrings),
  (left, right) => compareStrings(left.referencedTable.schema, right.referencedTable.schema),
  (left, right) => compareStrings(left.referencedTable.name, right.referencedTable.name),
  (left, right) => compareOptional(left.name, right.name, compareStrings),
  (left, right) => compareArrays(left.referencedColumns, right.referencedColumns, compareStrings),
  (left, right) => compareOptional(left.onUpdate, right.onUpdate, compareStrings),
  (left, right) => compareOptional(left.onDelete, right.onDelete, compareStrings),
  (left, right) => compareOptional(left.deferrable, right.deferrable, compareBooleans),
  (left, right) => compareOptional(left.enforcement, right.enforcement, compareStrings),
  (left, right) => compareOptional(left.comment, right.comment, compareStrings),
);

/** Collects lines while keeping a blank after each heading and between adjacent entities. */
class MarkdownBuilder {
  private readonly lines: string[] = [];

  heading(level: number, text: string): void {
    if (this.lines.length > 0 && this.lines[this.lines.length - 1] !== '') this.lines.push('');
    this.lines.push(`${'#'.repeat(level)} ${text}`);
    this.lines.push('');
  }

  bullet(text: string, depth = 0): void {
    this.lines.push(`${'  '.repeat(depth)}- ${text}`);
  }

  finish(): string {
    while (this.lines.length > 0 && this.lines[this.lines.length - 1] === '') this.lines.pop();
    return `${this.lines.join('\n')}\n`;
  }
}

type Formattable = string | number | boolean | readonly string[] | undefined;

/** `(none)` is never fenced; booleans spell yes/no; strings and string arrays use code spans. */
function fmt(value: Formattable): string {
  if (value === undefined) return '(none)';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return codeSpan(value);
  return value.length === 0 ? '(none)' : `(${value.map(codeSpan).join(', ')})`;
}

function qualified(schema: string, name: string): string {
  return codeSpan(`${schema}.${name}`);
}

/** CRLF and lone CR fold to LF, then every LF becomes `<br>` so a value stays on one line. */
function escapeText(value: string): string {
  const joined = value.replace(/\r\n?/g, '\n').replace(/\n/g, '<br>');
  let escaped = '';
  for (let index = 0; index < joined.length; index++) {
    const code = joined.charCodeAt(index);
    if (code === 0x09) escaped += '\\t';
    else if (code === 0x7c) escaped += '\\|';
    else if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      escaped += `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
    } else escaped += joined[index]!;
  }
  return escaped;
}

/** GFM code spans: fence = 1 + longest backtick run, with padding next to a leading/trailing tick. */
function codeSpan(value: string): string {
  let longest = 0;
  let run = 0;
  for (const character of value) {
    if (character === '`') {
      run += 1;
      longest = Math.max(longest, run);
    } else run = 0;
  }
  const fence = '`'.repeat(longest + 1);
  const padding = value.startsWith('`') || value.endsWith('`') ? ' ' : '';
  return `${fence}${padding}${escapeText(value)}${padding}${fence}`;
}

function renderColumn(out: MarkdownBuilder, column: Column): void {
  out.bullet(
    `Column ${codeSpan(column.name)}: type ${fmt(column.type)}, ` +
      `${column.notNull ? 'not null' : 'nullable'}, default ${fmt(column.default)}, ` +
      `collation ${fmt(column.collation)}, storage ${fmt(column.storage)}, ` +
      `compression ${fmt(column.compression)}, statistics target ${fmt(column.statisticsTarget)}, ` +
      `comment ${fmt(column.comment)}, not-null comment ${fmt(column.notNullComment)}`,
  );
  if (column.notNullName !== undefined) {
    out.bullet(`Not-null constraint name: ${fmt(column.notNullName)}`, 1);
  }
  if (column.identity !== undefined) out.bullet(`Identity: ${renderIdentity(column.identity)}`, 1);
}

function renderIdentity(identity: Identity): string {
  const sequence =
    identity.sequenceName === undefined
      ? '(none)'
      : qualified(identity.sequenceName.schema, identity.sequenceName.name);
  return (
    `generation ${fmt(identity.generated)}, sequence ${sequence}, ` +
    `increment ${fmt(identity.increment)}, min ${fmt(identity.minValue)}, ` +
    `max ${fmt(identity.maxValue)}, start ${fmt(identity.start)}, ` +
    `cache ${fmt(identity.cache)}, cycle ${fmt(identity.cycle)}`
  );
}

function renderPrimaryKey(key: PrimaryKey): string {
  return (
    `name: ${fmt(key.name)}, columns: ${fmt(key.columns)}, ` +
    `deferrable: ${fmt(key.deferrable)}, initially deferred: ${fmt(key.initiallyDeferred)}, ` +
    `comment: ${fmt(key.comment)}`
  );
}

function renderForeignKey(foreignKey: ForeignKey): string {
  return (
    `name: ${fmt(foreignKey.name)}, columns: ${fmt(foreignKey.columns)}, ` +
    `referenced table: ${qualified(foreignKey.referencedTable.schema, foreignKey.referencedTable.name)}, ` +
    `referenced columns: ${fmt(foreignKey.referencedColumns)}, ` +
    `on update: ${fmt(foreignKey.onUpdate)}, on delete: ${fmt(foreignKey.onDelete)}, ` +
    `enforcement: ${fmt(foreignKey.enforcement)}, deferrable: ${fmt(foreignKey.deferrable)}, ` +
    `initially deferred: ${fmt(foreignKey.initiallyDeferred)}, comment: ${fmt(foreignKey.comment)}`
  );
}

function renderIndex(index: Index): string {
  const elements = index.columns.map((element) =>
    typeof element === 'string' ? element : `expression ${element.expression}`,
  );
  const clauses = index.include === undefined ? '' : `, include: ${fmt(index.include)}`;
  const where = index.where === undefined ? '' : `, where: ${fmt(index.where)}`;
  return (
    `name: ${fmt(index.name)}, unique: ${fmt(index.unique)}, columns: ${fmt(elements)}, ` +
    `concurrently: ${fmt(index.concurrently)}, comment: ${fmt(index.comment)}${clauses}${where}`
  );
}

function renderIndexes(out: MarkdownBuilder, indexes: readonly Index[]): void {
  if (indexes.length === 0) return;
  out.heading(4, 'Indexes');
  for (const index of sorted(indexes, compareIndexes)) out.bullet(renderIndex(index));
}

function renderTable(out: MarkdownBuilder, table: Table): void {
  out.heading(3, `Table ${qualified(table.schema, table.name)}`);
  if (table.comment !== undefined) out.bullet(`Comment: ${fmt(table.comment)}`);
  if (table.persistence !== undefined) out.bullet(`Persistence: ${fmt(table.persistence)}`);

  if (table.columns.length > 0) {
    out.heading(4, 'Columns');
    for (const column of table.columns) renderColumn(out, column);
  }
  if (table.primaryKey !== undefined) {
    out.heading(4, 'Primary key');
    out.bullet(renderPrimaryKey(table.primaryKey));
  }
  if (table.uniqueConstraints.length > 0) {
    out.heading(4, 'Unique constraints');
    for (const unique of sorted(table.uniqueConstraints, compareUniqueConstraints)) {
      out.bullet(renderPrimaryKey(unique));
    }
  }
  if (table.checkConstraints.length > 0) {
    out.heading(4, 'Check constraints');
    for (const check of sorted(table.checkConstraints, compareCheckConstraints)) {
      out.bullet(
        `name: ${fmt(check.name)}, expression: ${fmt(check.expression)}, ` +
          `enforcement: ${fmt(check.enforcement)}, comment: ${fmt(check.comment)}`,
      );
    }
  }
  if (table.exclusionConstraints !== undefined && table.exclusionConstraints.length > 0) {
    out.heading(4, 'Exclusion constraints');
    for (const exclusion of table.exclusionConstraints) {
      out.bullet(
        `name: ${fmt(exclusion.name)}, elements: ${fmt(exclusion.elements)}, ` +
          `access method: ${fmt(exclusion.accessMethod ?? 'gist')}, where: ${fmt(exclusion.where)}, ` +
          `deferrable: ${fmt(exclusion.deferrable)}, initially deferred: ${fmt(
            exclusion.initiallyDeferred,
          )}, comment: ${fmt(exclusion.comment)}`,
      );
    }
  }
  if (table.foreignKeys.length > 0) {
    out.heading(4, 'Foreign keys');
    for (const foreignKey of sorted(table.foreignKeys, compareForeignKeys)) {
      out.bullet(renderForeignKey(foreignKey));
    }
  }
  renderIndexes(out, table.indexes);
}

function renderSequence(out: MarkdownBuilder, sequence: Sequence): void {
  out.heading(3, `Sequence ${qualified(sequence.schema, sequence.name)}`);
  out.bullet(`data type: ${fmt(sequence.dataType)}`);
  out.bullet(`increment: ${fmt(sequence.increment)}`);
  out.bullet(`min: ${fmt(sequence.minValue)}`);
  out.bullet(`max: ${fmt(sequence.maxValue)}`);
  out.bullet(`start: ${fmt(sequence.start)}`);
  out.bullet(`cache: ${fmt(sequence.cache)}`);
  out.bullet(`cycle: ${fmt(sequence.cycle)}`);
  if (sequence.ownedBy !== undefined) {
    const owner = sequence.ownedBy;
    out.bullet(
      `owned by: ${codeSpan(`${owner.table.schema}.${owner.table.name}.${owner.column}`)}`,
    );
  }
  if (sequence.comment !== undefined) out.bullet(`comment: ${fmt(sequence.comment)}`);
}

function renderView(out: MarkdownBuilder, view: View): void {
  out.heading(
    3,
    `${view.materialized ? 'Materialized view' : 'View'} ${qualified(view.schema, view.name)}`,
  );
  out.bullet(`definition: ${fmt(view.definition)}`);
  if (view.checkOption !== undefined) out.bullet(`check option: ${fmt(view.checkOption)}`);
  if (view.comment !== undefined) out.bullet(`comment: ${fmt(view.comment)}`);
  if (view.materialized && view.indexes !== undefined) renderIndexes(out, view.indexes);
}

function renderExtension(out: MarkdownBuilder, extension: Extension): void {
  out.heading(3, `Extension ${codeSpan(extension.name)}`);
  out.bullet(`schema: ${fmt(extension.schema)}`);
  if (extension.comment !== undefined) out.bullet(`comment: ${fmt(extension.comment)}`);
}

/** Renders one deterministic Markdown document for `model`, with one final LF. */
export function renderMarkdown(model: Model): string {
  const out = new MarkdownBuilder();
  out.heading(1, 'Schema');

  const tables = sorted(model.tables, compareIdentity);
  const sequences = sorted(model.sequences, compareIdentity);
  const views = sorted(model.views, compareIdentity);
  const extensions = sorted(model.extensions, (left, right) =>
    compareStrings(left.name, right.name),
  );

  if (tables.length > 0) {
    out.heading(2, 'Tables');
    for (const table of tables) renderTable(out, table);
  }
  if (sequences.length > 0) {
    out.heading(2, 'Sequences');
    for (const sequence of sequences) renderSequence(out, sequence);
  }
  if (views.length > 0) {
    out.heading(2, 'Views');
    for (const view of views) renderView(out, view);
  }
  if (extensions.length > 0) {
    out.heading(2, 'Extensions');
    for (const extension of extensions) renderExtension(out, extension);
  }

  return out.finish();
}

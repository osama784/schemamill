import type {
  CheckConstraint,
  ForeignKey,
  Index,
  TableIdentity,
  UniqueConstraint,
} from '@schemamill/core';

/**
 * PostgreSQL's conventional names, the single prediction source shared by both directions of
 * the round trip: `render.ts` uses the formulas to name an unnamed constraint or index in a
 * drop, and `import.ts` uses them to recognize a server-generated name on a declaration the
 * model made unnamed and canonicalize it back to unnamed.
 *
 * The prediction is deliberately best-effort. PostgreSQL truncates identifiers at 63 bytes and
 * appends collision suffixes (`_idx1`, `_key1`, …) through `makeObjectName`, and neither is
 * predictable offline, so such names stay named and still read as remove + add. The check
 * formula is lexical rather than parse-based, so an expression it misreads keeps its server
 * name — the fail-safe direction.
 */

/** PostgreSQL's conventional index name for an unnamed index. */
export function synthesizedIndexName(table: TableIdentity, index: Index): string {
  return `${table.name}${index.columns.map((column) => `_${column}`).join('')}_idx`;
}

/** PostgreSQL's conventional primary-key name for an unnamed primary key. */
export function synthesizedPrimaryKeyName(table: TableIdentity): string {
  return `${table.name}_pkey`;
}

/** PostgreSQL's conventional foreign-key name for an unnamed constraint. */
export function synthesizedForeignKeyName(table: TableIdentity, foreignKey: ForeignKey): string {
  return `${table.name}${foreignKey.columns.map((column) => `_${column}`).join('')}_fkey`;
}

/** PostgreSQL's conventional unique-constraint name for an unnamed constraint. */
export function synthesizedUniqueConstraintName(
  table: TableIdentity,
  uniqueConstraint: UniqueConstraint,
): string {
  return `${table.name}${uniqueConstraint.columns.map((column) => `_${column}`).join('')}_key`;
}

/**
 * PostgreSQL's conventional check-constraint name for an unnamed constraint: the single
 * column the expression references when it references exactly one, the table alone otherwise.
 */
export function synthesizedCheckConstraintName(
  table: TableIdentity,
  checkConstraint: CheckConstraint,
): string {
  const column = checkExpressionColumn(checkConstraint.expression);
  return column === undefined ? `${table.name}_check` : `${table.name}_${column}_check`;
}

/**
 * The words a check expression can carry that are never a column reference, for the
 * best-effort conventional-name scan. Function-like words (`COALESCE`, `NULLIF`, …) are
 * already excluded by their call parentheses.
 */
const CHECK_KEYWORDS: ReadonlySet<string> = new Set([
  'all',
  'and',
  'any',
  'array',
  'as',
  'between',
  'case',
  'cast',
  'collate',
  'current_catalog',
  'current_date',
  'current_role',
  'current_schema',
  'current_time',
  'current_timestamp',
  'current_user',
  'default',
  'distinct',
  'else',
  'end',
  'escape',
  'exists',
  'false',
  'from',
  'ilike',
  'in',
  'interval',
  'is',
  'isnull',
  'like',
  'localtime',
  'localtimestamp',
  'not',
  'notnull',
  'null',
  'or',
  'overlaps',
  'row',
  'session_user',
  'similar',
  'some',
  'then',
  'to',
  'true',
  'unknown',
  'user',
  'when',
]);

/** The shape of an identifier's first character and its continuation. */
const IDENTIFIER_START = /[A-Za-z_\u0080-\uffff]/;
const IDENTIFIER_CONTINUATION = /[A-Za-z0-9_$\u0080-\uffff]/;

/** Matches a dollar-quote delimiter, mirroring the importer's scanner. */
const DOLLAR_QUOTE = /\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/y;

/**
 * The column a check expression references, when it references exactly one, for PostgreSQL's
 * conventional constraint name. The scan is lexical and best-effort: it counts bare and quoted
 * identifiers that are not function names, type names after `::`, `CAST` aliases, or key
 * words. `undefined` when the expression references zero or several columns.
 */
function checkExpressionColumn(expression: string): string | undefined {
  const columns = new Set<string>();
  let index = 0;
  while (index < expression.length) {
    const character = expression[index]!;

    if (character === "'") {
      index = quotedSpanEnd(expression, index);
      continue;
    }
    if (character === '$') {
      const end = dollarQuotedEnd(expression, index);
      if (end !== null) {
        index = end;
        continue;
      }
    }
    if (character === '"') {
      const end = quotedSpanEnd(expression, index);
      if (isColumnReference(expression, index, end)) {
        columns.add(expression.slice(index + 1, end - 1).replaceAll('""', '"'));
      }
      index = end;
      continue;
    }
    if (IDENTIFIER_START.test(character)) {
      let end = index + 1;
      while (end < expression.length && IDENTIFIER_CONTINUATION.test(expression[end]!)) end += 1;
      const word = expression.slice(index, end);
      if (isColumnReference(expression, index, end) && !CHECK_KEYWORDS.has(word.toLowerCase())) {
        columns.add(word);
      }
      index = end;
      continue;
    }
    index += 1;
  }
  return columns.size === 1 ? [...columns][0] : undefined;
}

/** Whether the identifier spanning `[start, end)` reads as a column reference. */
function isColumnReference(text: string, start: number, end: number): boolean {
  return !isFunctionName(text, end) && !isCastType(text, start) && !isCastAlias(text, start);
}

/** Whether the token ending at `end` is a function name: the next non-space character is `(`. */
function isFunctionName(text: string, end: number): boolean {
  let index = end;
  while (index < text.length && isWhitespace(text[index]!)) index += 1;
  return text[index] === '(';
}

/** Whether the token starting at `start` is a type name: it follows `::`. */
function isCastType(text: string, start: number): boolean {
  let index = start - 1;
  while (index >= 0 && isWhitespace(text[index]!)) index -= 1;
  return index >= 1 && text[index] === ':' && text[index - 1] === ':';
}

/** Whether the token starting at `start` is a `CAST` alias: it follows the word `AS`. */
function isCastAlias(text: string, start: number): boolean {
  let index = start - 1;
  while (index >= 0 && isWhitespace(text[index]!)) index -= 1;
  if (index < 0) return false;
  const end = index + 1;
  while (index >= 0 && IDENTIFIER_CONTINUATION.test(text[index]!)) index -= 1;
  return text.slice(index + 1, end).toLowerCase() === 'as';
}

/** Index just past the quoted span starting at `index` (a `'` or `"`), or the end of text. */
function quotedSpanEnd(text: string, index: number): number {
  const quote = text[index];
  let cursor = index + 1;
  while (cursor < text.length) {
    const character = text[cursor]!;
    if (character === quote) {
      if (text[cursor + 1] === quote) {
        cursor += 2;
        continue;
      }
      return cursor + 1;
    }
    cursor += 1;
  }
  return text.length;
}

/** Index just past a dollar-quoted span starting at `index`, or `null` when none starts there. */
function dollarQuotedEnd(text: string, index: number): number | null {
  DOLLAR_QUOTE.lastIndex = index;
  const delimiter = DOLLAR_QUOTE.exec(text)?.[0] ?? null;
  if (delimiter === null) return null;
  const close = text.indexOf(delimiter, index + delimiter.length);
  return close === -1 ? text.length : close + delimiter.length;
}

function isWhitespace(character: string): boolean {
  return /\s/.test(character);
}

import type {
  CheckConstraint,
  ExclusionConstraint,
  ForeignKey,
  Index,
  TableIdentity,
  UniqueConstraint,
} from '@schemamill/core';

/**
 * PostgreSQL's conventional names, the single prediction source shared by both directions of
 * the round trip: `render.ts` uses the formulas to name an unnamed constraint or index in a
 * drop and to see name collapses in its guard, and `import.ts` uses them to recognize a
 * server-generated name on a declaration the model made unnamed and canonicalize it back to
 * unnamed. The not-null formula is import-only: rendering never synthesizes a not-null name,
 * so it serves canonicalization alone.
 *
 * The prediction mirrors the server's own naming — `makeObjectName` and the column addition
 * loop — faithfully, including PostgreSQL's 63-byte identifier limit: an explicit identifier
 * is clipped to its server form by `truncateIdentifier`, and a generated name is assembled
 * exactly as `makeObjectName` assembles it, so a name longer than 63 bytes predicts the name
 * PostgreSQL would store rather than an over-long one. The PostgreSQL 18 not-null helper below
 * mirrors `ChooseConstraintName` for the name the server materializes when it stores an unnamed
 * not-null constraint; import canonicalization keeps using the conventional formula here.
 * The mirror assumes a UTF-8 database:
 * `pg_mbcliplen` clips at character boundaries of the database encoding, and this module
 * clips at UTF-8 boundaries; any other encoding is a named residual.
 *
 * Collision suffixes (`_idx1`, `_key1`, …) stay unpredictable offline: `ChooseRelationName`
 * and `ChooseConstraintName` re-run the formula with a numbered label until the name is free
 * in the catalog, which is not knowable from the model. Such names stay named and still read
 * as remove + add. The check formula is lexical rather than parse-based, so an expression it
 * misreads keeps its server name — the fail-safe direction.
 */

/** PostgreSQL's `NAMEDATALEN`: a stored identifier holds at most 63 bytes plus the NUL. */
const NAMEDATALEN = 64;

/** PostgreSQL's identifier byte limit: `NAMEDATALEN - 1`. */
const IDENTIFIER_BYTE_LIMIT = NAMEDATALEN - 1;

/** The UTF-8 byte length of one Unicode code point. */
function utf8ByteLength(character: string): number {
  const codePoint = character.codePointAt(0)!;
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/** `text`'s length in UTF-8 bytes. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (const character of text) bytes += utf8ByteLength(character);
  return bytes;
}

/**
 * The longest prefix of `text` that is at most `limit` UTF-8 bytes long, never splitting a
 * character — the mirror of `pg_mbcliplen` under a UTF-8 database.
 */
function clipToBytes(text: string, limit: number): string {
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const width = utf8ByteLength(character);
    if (bytes + width > limit) break;
    bytes += width;
    end += character.length;
  }
  return text.slice(0, end);
}

/**
 * The server form of an explicit identifier: unchanged at 63 bytes or fewer, otherwise the
 * longest prefix of at most 63 UTF-8 bytes that never splits a character — the mirror of
 * `truncate_identifier` and `pg_mbcliplen` under a UTF-8 database, and idempotent. PostgreSQL
 * clips an explicit identifier when it parses the statement, so a longer name would be stored
 * as a different name than the statement reads; callers that must reason about the stored name
 * — the render guard — compare through this form.
 */
export function truncateIdentifier(name: string): string {
  return clipToBytes(name, IDENTIFIER_BYTE_LIMIT);
}

/**
 * PostgreSQL's `makeObjectName`: `name1`, then `name2` when given, then `label`, the parts
 * separated by underscores, truncated so the whole fits PostgreSQL's 63-byte identifier
 * limit. The longer of the two name parts shrinks byte by byte until both fit (a tie shrinks
 * `name2`), then each part is clipped at a character boundary; the label is never truncated.
 * Both inputs are first clipped by `truncateIdentifier`, because PostgreSQL passes stored
 * names — already at most 63 bytes — into the function.
 */
export function makeObjectName(name1: string, name2: string | null, label: string): string {
  const first = truncateIdentifier(name1);
  const second = name2 === null ? null : truncateIdentifier(name2);
  const overhead = (second === null ? 0 : 1) + utf8Length(label) + 1;
  const available = IDENTIFIER_BYTE_LIMIT - overhead;

  let firstBytes = utf8Length(first);
  let secondBytes = second === null ? 0 : utf8Length(second);
  while (firstBytes + secondBytes > available) {
    if (firstBytes > secondBytes) firstBytes -= 1;
    else secondBytes -= 1;
  }

  const clippedFirst = clipToBytes(first, firstBytes);
  const clippedSecond = second === null ? null : clipToBytes(second, secondBytes);
  return `${clippedFirst}${clippedSecond === null ? '' : `_${clippedSecond}`}_${label}`;
}

/**
 * The column-name part of a generated name, mirroring `ChooseIndexNameAddition` and
 * `ChooseForeignKeyConstraintNameAddition`: each name appended after an underscore separator,
 * each name pre-clipped to 63 bytes, stopping after the part that brings the running byte
 * length to 64 or more. The result may exceed 63 bytes; `makeObjectName` shrinks it into the
 * final name.
 */
export function chooseNameAddition(names: readonly string[]): string {
  let addition = '';
  for (const name of names) {
    if (utf8Length(addition) > 0) addition += '_';
    addition += truncateIdentifier(name);
    if (utf8Length(addition) >= NAMEDATALEN) break;
  }
  return addition;
}

/**
 * The labels `ChooseIndexColumnNames` feeds `ChooseIndexNameAddition`: a plain column names
 * itself, a function call contributes its last (unquoted) function identifier, `nullif` keeps its
 * own label, and every other expression is `expr`. `INCLUDE` columns follow the keys and `WHERE`
 * contributes nothing. Duplicates get numeric suffixes over the whole list, and each label is
 * clipped so the base plus its suffix fits 63 bytes — the mirror of the server's truncation.
 */
export function indexElementNames(index: Index): string[] {
  const labels: string[] = [];
  for (const element of index.columns) {
    labels.push(typeof element === 'string' ? element : expressionElementLabel(element.expression));
  }
  if (index.include !== undefined) labels.push(...index.include);

  const used = new Set<string>();
  return labels.map((label) => {
    let name: string;
    for (let counter = 0; ; counter += 1) {
      const suffix = counter === 0 ? '' : String(counter);
      name = `${clipToBytes(label, IDENTIFIER_BYTE_LIMIT - utf8Length(suffix))}${suffix}`;
      if (!used.has(name)) break;
    }
    used.add(name);
    return name;
  });
}

/** The best-effort label an opaque expression contributes to a generated index name. */
function expressionElementLabel(expression: string): string {
  let text = expression.trim();
  // Parentheses around the whole expression do not change its parse tree for the server.
  while (text.length > 1 && text.startsWith('(')) {
    const close = matchingCloseParen(text, 0);
    if (close < 0 || skipWhitespace(text, close + 1) !== text.length) break;
    text = text.slice(1, close).trim();
  }

  let cursor = 0;
  let last: string;
  for (;;) {
    cursor = skipWhitespace(text, cursor);
    const token = readIdentifier(text, cursor);
    if (token === undefined) return 'expr';
    last = token.value;
    cursor = skipWhitespace(text, token.end);
    if (text[cursor] === '(') {
      const close = matchingCloseParen(text, cursor);
      if (close < 0 || skipWhitespace(text, close + 1) !== text.length) return 'expr';
      return last.toLowerCase() === 'nullif' ? 'nullif' : last;
    }
    if (text[cursor] !== '.') return 'expr';
    cursor += 1;
  }
}

/** A quoted or bare identifier at `start`, unquoted, with the index just past it. */
function readIdentifier(
  text: string,
  start: number,
): { readonly value: string; readonly end: number } | undefined {
  if (text[start] === '"') {
    let value = '';
    let cursor = start + 1;
    while (cursor < text.length) {
      if (text[cursor] === '"') {
        if (text[cursor + 1] === '"') {
          value += '"';
          cursor += 2;
          continue;
        }
        return { value, end: cursor + 1 };
      }
      value += text[cursor]!;
      cursor += 1;
    }
    return undefined;
  }
  const first = text[start];
  if (first === undefined || !IDENTIFIER_START.test(first)) return undefined;
  let end = start + 1;
  while (end < text.length && IDENTIFIER_CONTINUATION.test(text[end]!)) end += 1;
  return { value: text.slice(start, end), end };
}

/** The index of the `)` closing the `(` at `open`, skipping quoted spans and comments. */
function matchingCloseParen(text: string, open: number): number {
  let depth = 0;
  let cursor = open;
  while (cursor < text.length) {
    const character = text[cursor]!;
    if (character === "'" || character === '"') {
      cursor = quotedSpanEnd(text, cursor);
      continue;
    }
    if (character === '$') {
      const end = dollarQuotedEnd(text, cursor);
      if (end !== null) {
        cursor = end;
        continue;
      }
    }
    if (character === '-' && text[cursor + 1] === '-') {
      while (cursor < text.length && text[cursor] !== '\n') cursor += 1;
      continue;
    }
    if (character === '/' && text[cursor + 1] === '*') {
      const end = text.indexOf('*/', cursor + 2);
      cursor = end === -1 ? text.length : end + 2;
      continue;
    }
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) return cursor;
    }
    cursor += 1;
  }
  return -1;
}

/** Index just past the whitespace at `from`. */
function skipWhitespace(text: string, from: number): number {
  let cursor = from;
  while (cursor < text.length && isWhitespace(text[cursor]!)) cursor += 1;
  return cursor;
}

/**
 * PostgreSQL's conventional constraint name for an unnamed exclusion constraint: the table
 * name, the element-name mirror the index formula uses, and the `_excl` label. Operator and
 * operator-class text after `WITH` never participates, just as a partial `WHERE` never does for
 * an index. Like the other mirrors this is a canonicalization and render-guard prediction only;
 * collision suffixes stay offline-unpredictable and such constraints remain named.
 */
export function synthesizedExclusionConstraintName(
  table: TableIdentity,
  exclusionConstraint: ExclusionConstraint,
): string {
  return makeObjectName(
    table.name,
    chooseNameAddition(exclusionElementNames(exclusionConstraint.elements)),
    'excl',
  );
}

/**
 * The labels an exclusion element list contributes to a generated name. Each element's text is
 * cut before its `WITH` operator, then the same best-effort mirror as an index element is used:
 * a bare column names itself, a function call contributes its function identifier, and anything
 * else becomes `expr`. Duplicates get numeric suffixes over the whole list.
 */
function exclusionElementNames(elements: string): string[] {
  const labels: string[] = [];
  for (const element of splitExclusionElements(elements)) {
    const beforeWith = element.replace(/\s+WITH\b[\s\S]*$/i, '').trim();
    labels.push(
      /^[A-Za-z_\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*$/.test(beforeWith)
        ? beforeWith
        : expressionElementLabel(beforeWith),
    );
  }

  const used = new Set<string>();
  return labels.map((label) => {
    let name: string;
    for (let counter = 0; ; counter += 1) {
      const suffix = counter === 0 ? '' : String(counter);
      name = `${clipToBytes(label, IDENTIFIER_BYTE_LIMIT - utf8Length(suffix))}${suffix}`;
      if (!used.has(name)) break;
    }
    used.add(name);
    return name;
  });
}

/** Splits an exclusion element list on commas outside quotes and parentheses. */
function splitExclusionElements(elements: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let index = 0;
  while (index < elements.length) {
    const character = elements[index]!;
    if (character === "'" || character === '"') {
      index = quotedSpanEnd(elements, index);
      continue;
    }
    if (character === '$') {
      const end = dollarQuotedEnd(elements, index);
      if (end !== null) {
        index = end;
        continue;
      }
    }
    if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    else if (character === ',' && depth === 0) {
      parts.push(elements.slice(start, index));
      start = index + 1;
    }
    index += 1;
  }
  parts.push(elements.slice(start));
  return parts;
}

/** PostgreSQL's conventional index name for an unnamed index. */
export function synthesizedIndexName(table: TableIdentity, index: Index): string {
  return makeObjectName(table.name, chooseNameAddition(indexElementNames(index)), 'idx');
}

/** PostgreSQL's conventional primary-key name for an unnamed primary key. */
export function synthesizedPrimaryKeyName(table: TableIdentity): string {
  return makeObjectName(table.name, null, 'pkey');
}

/** PostgreSQL's conventional foreign-key name for an unnamed constraint. */
export function synthesizedForeignKeyName(table: TableIdentity, foreignKey: ForeignKey): string {
  return makeObjectName(table.name, chooseNameAddition(foreignKey.columns), 'fkey');
}

/** PostgreSQL's conventional unique-constraint name for an unnamed constraint. */
export function synthesizedUniqueConstraintName(
  table: TableIdentity,
  uniqueConstraint: UniqueConstraint,
): string {
  return makeObjectName(table.name, chooseNameAddition(uniqueConstraint.columns), 'key');
}

/**
 * PostgreSQL's conventional not-null-constraint name for an unnamed constraint: the relation
 * name — never schema-qualified — joined with the column and `_not_null`. Import-only, unlike
 * the other formulas: rendering never synthesizes a not-null name, because an unnamed
 * not-null fact renders as plain `NOT NULL`.
 */
export function synthesizedNotNullName(table: string, column: string): string {
  return makeObjectName(table, column, 'not_null');
}

/**
 * PostgreSQL 18's `ChooseConstraintName` for an unnamed not-null fact the server stores in
 * `pg_constraint`: the unqualified relation name, the column name, and the `not_null` label.
 * Both name parts arrive as stored identifiers (at most 63 bytes each) and share the 53 bytes
 * left after the two separators and the eight-byte label; the longer part shrinks first, a tie
 * shrinks the column, each part clips at a UTF-8 character boundary, and the label is never
 * truncated. This is the name an occupancy guard must reserve at target 18 or newer — before 18
 * an unnamed not-null has no constraint row and claims nothing. Collision suffixes
 * (`not_null1`, …) depend on the catalog's current names and stay offline-unpredictable, so a
 * suffixed name remains named in the model instead of being synthesized here.
 */
export function pg18NotNullName(table: string, column: string): string {
  const label = 'not_null';
  const first = truncateIdentifier(table);
  const second = truncateIdentifier(column);
  const available = IDENTIFIER_BYTE_LIMIT - utf8Length(label) - 2;
  let firstBytes = utf8Length(first);
  let secondBytes = utf8Length(second);
  while (firstBytes + secondBytes > available) {
    if (firstBytes > secondBytes) firstBytes -= 1;
    else secondBytes -= 1;
  }
  return `${clipToBytes(first, firstBytes)}_${clipToBytes(second, secondBytes)}_${label}`;
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
  return makeObjectName(table.name, column ?? null, 'check');
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
 * The distinct bare and quoted identifiers in an opaque expression that read as column
 * references. The scan is lexical and best-effort: it skips string and dollar-quoted text,
 * function names, cast types after `::`, `CAST` aliases, and key words. The conventional-name
 * prediction and baseline release share this rule so they agree on what an expression mentions.
 */
export function expressionColumnIdentifiers(expression: string): ReadonlySet<string> {
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
  return columns;
}

/**
 * The column a check expression references, when it references exactly one, for PostgreSQL's
 * conventional constraint name. `undefined` when the expression references zero or several
 * columns — that ambiguity is the best-effort scan's fail-safe, unchanged by the shared helper.
 */
function checkExpressionColumn(expression: string): string | undefined {
  const columns = expressionColumnIdentifiers(expression);
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

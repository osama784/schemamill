/**
 * Per-statement parse leg for a preprocessed dump.
 *
 * `parseDump` feeds every slice from `preprocessDump` through libpg-query one statement at a
 * time, in order, isolating failures: one unparseable statement never sinks the rest of the
 * dump. Each slice is expected to parse to exactly one statement; a slice that yields zero or
 * several statements is reported as a failure with the message
 * `expected one statement, parsed N` instead of passing extra statements downstream. Several
 * statements can only occur when the splitter's lexical approximation merges text that
 * PostgreSQL lexes separately, e.g. a `U&'…'` literal with a custom `UESCAPE`.
 *
 * Failure positions are absolute positions in the original dump text. When libpg-query exposes
 * an error cursor it is a 0-based Unicode code point offset into the parsed slice (PostgreSQL's
 * `cursorpos` is multibyte-aware), so it is converted to a UTF-16 offset before the absolute
 * position is computed; errors without usable cursor details carry only the statement position.
 *
 * This module is internal to the package and intentionally not re-exported from `index.ts`.
 */

import { hasSqlDetails, parse, type ParseResult } from 'libpg-query';

import {
  preprocessDump,
  type Position,
  type PreprocessDiagnostic,
  type StatementSlice,
} from './preprocess.ts';

/** A slice that could not be turned into exactly one parsed statement. */
export interface ParseFailure {
  /** Absolute position of the failing statement's first character. */
  readonly position: Position;
  /** libpg-query's error message, or the one-statement guard's message. */
  readonly message: string;
  /** Absolute error cursor position, when libpg-query reported a usable one. */
  readonly cursor?: Position;
}

/** One slice that parsed to exactly one statement. */
export interface ParsedStatement {
  readonly sql: string;
  readonly start: Position;
  readonly end: Position;
  readonly result: ParseResult;
}

export interface ParseDumpResult {
  readonly statements: readonly ParsedStatement[];
  readonly failures: readonly ParseFailure[];
  /** Constructs stripped or consumed by the preprocessor, surfaced unchanged. */
  readonly diagnostics: readonly PreprocessDiagnostic[];
}

/**
 * Parses every statement slice of `text`, sequentially and independently. Never rejects for
 * malformed SQL: statement-level errors land in `failures` and the next slice is still parsed.
 */
export async function parseDump(text: string): Promise<ParseDumpResult> {
  const preprocessed = preprocessDump(text);
  const statements: ParsedStatement[] = [];
  const failures: ParseFailure[] = [];

  for (const slice of preprocessed.statements) {
    try {
      const result = await parse(slice.sql);
      const countFailure = statementCountFailure(slice, result.stmts?.length ?? 0);
      if (countFailure === null) {
        statements.push({ sql: slice.sql, start: slice.start, end: slice.end, result });
      } else {
        failures.push(countFailure);
      }
    } catch (error) {
      failures.push(parseErrorFailure(text, slice, error));
    }
  }

  return { statements, failures, diagnostics: preprocessed.diagnostics };
}

/**
 * Guards the one-slice-one-statement invariant. Zero statements happens only for inputs the
 * preprocessor would not normally slice; several happen only when the splitter merged statements
 * PostgreSQL lexes apart. Either way the slice is reported, not silently passed through.
 */
function statementCountFailure(slice: StatementSlice, statementCount: number): ParseFailure | null {
  if (statementCount === 1) return null;
  return {
    position: slice.start,
    message: `expected one statement, parsed ${statementCount}`,
  };
}

/** Converts a thrown libpg-query error into a failure anchored at the statement. */
function parseErrorFailure(text: string, slice: StatementSlice, error: unknown): ParseFailure {
  const message = error instanceof Error ? error.message : 'unknown parse error';
  const cursor = errorCursor(text, slice, error);
  return cursor === undefined
    ? { position: slice.start, message }
    : { position: slice.start, message, cursor };
}

/**
 * Maps libpg-query's error cursor onto the dump. PostgreSQL reports `cursorpos` as a 1-based
 * character position; the wrapper exposes it 0-based, counted in Unicode code points, so it is
 * first converted to an offset into the UTF-16 slice.
 */
function errorCursor(text: string, slice: StatementSlice, error: unknown): Position | undefined {
  if (!hasSqlDetails(error)) return undefined;
  const cursorPosition = error.sqlDetails?.cursorPosition;
  if (cursorPosition === undefined || !Number.isInteger(cursorPosition) || cursorPosition < 0) {
    return undefined;
  }
  const offsetInSlice = codePointOffsetToUtf16(slice.sql, cursorPosition);
  if (offsetInSlice === null) return undefined;
  return positionAt(text, slice.start.offset + offsetInSlice);
}

/** UTF-16 index of the `codePointOffset`-th code point in `text`, or `null` past its end. */
function codePointOffsetToUtf16(text: string, codePointOffset: number): number | null {
  let utf16 = 0;
  let remaining = codePointOffset;
  while (remaining > 0) {
    if (utf16 >= text.length) return null;
    utf16 += (text.codePointAt(utf16) ?? 0) > 0xffff ? 2 : 1;
    remaining -= 1;
  }
  return utf16;
}

/**
 * Position of `offset` in `text`. Mirrors the preprocessor's line-break rules: `\r\n` is one
 * break, and an offset on the `\n` of a pair still resolves to the line the pair ends.
 */
function positionAt(text: string, offset: number): Position {
  let line = 1;
  let lineStart = 0;
  let index = 0;

  while (index <= text.length) {
    if (index === offset) return { offset, line, column: offset - lineStart + 1 };
    if (index === text.length) break;

    const character = text[index]!;
    if (character === '\n') {
      index += 1;
      line += 1;
      lineStart = index;
      continue;
    }
    if (character === '\r') {
      index += 1;
      if (text[index] === '\n') {
        if (index === offset) return { offset, line, column: offset - lineStart + 1 };
        index += 1;
      }
      line += 1;
      lineStart = index;
      continue;
    }
    index += 1;
  }

  return { offset, line, column: offset - lineStart + 1 };
}

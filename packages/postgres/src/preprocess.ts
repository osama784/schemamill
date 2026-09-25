/**
 * Text-level preprocessor for raw `pg_dump` output.
 *
 * The importer pipeline feeds a dump file here before parsing. This module is deliberately
 * parser-free: it recognizes PostgreSQL lexical structure (single-quoted strings, quoted
 * identifiers, both comment forms, dollar-quoted bodies) and psql-level constructs (`\meta`
 * command lines and `COPY … FROM stdin` data blocks), producing ordered statement slices with
 * source positions and diagnostics.
 *
 * Contract:
 * - `StatementSlice.sql` is the statement substring trimmed of surrounding whitespace and
 *   *including* its terminating semicolon; a trailing statement without a semicolon is emitted
 *   as-is. Leading comments stay in the slice because comment banners are part of the span.
 * - Positions are 1-based line/column and 0-based UTF-16 offsets. `StatementSlice.end` is
 *   exclusive: `text.slice(start.offset, end.offset) === sql`.
 * - `\r\n` counts as one line break; a lone `\r` is also treated as a line break.
 * - A `COPY … FROM stdin;` statement is consumed together with its data lines (through the
 *   terminating `\.` line) and reported as a `copy` diagnostic instead of a slice. A
 *   `COPY … TO stdout;` statement has no inline data and is emitted as an ordinary slice.
 * - Whitespace- and comment-only segments produce neither a slice nor a diagnostic.
 *
 * This module is internal to the package and intentionally not re-exported from `index.ts`,
 * whose exports are the dialect seam; the dump importer will import it directly.
 */

/** A position in the dump text. 1-based line and column; 0-based UTF-16 offset. */
export interface Position {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

/** One SQL statement ready for parsing. `sql` includes the terminating semicolon when present. */
export interface StatementSlice {
  readonly sql: string;
  readonly start: Position;
  readonly end: Position;
}

/** A construct removed from the statement stream, reported inline at its source position. */
export interface PreprocessDiagnostic {
  readonly kind: 'psql-meta-command' | 'copy';
  /** e.g. `\restrict` or `COPY public.users` (best-effort relation name). */
  readonly name: string;
  /** Where the stripped or consumed construct begins. */
  readonly position: Position;
  /** Public-safe, factual description. */
  readonly message: string;
}

export interface PreprocessResult {
  readonly statements: readonly StatementSlice[];
  readonly diagnostics: readonly PreprocessDiagnostic[];
}

type ScanMode = 'sql' | 'single' | 'double' | 'line-comment' | 'block-comment' | 'dollar';

interface RawSlice {
  readonly startOffset: number;
  readonly sql: string;
}

interface RawDiagnostic {
  readonly kind: PreprocessDiagnostic['kind'];
  readonly name: string;
  readonly offset: number;
  readonly message: string;
}

interface RawScan {
  readonly slices: readonly RawSlice[];
  readonly diagnostics: readonly RawDiagnostic[];
}

interface CopyDataConsumption {
  readonly endOffset: number;
  readonly dataLines: number;
  readonly terminated: boolean;
}

/**
 * Matches `$$` and `$tag$` delimiters. The tag needs an identifier start, so `$1`, `$2`, …
 * (positional parameters) cannot match.
 */
const DOLLAR_QUOTE = /\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/y;

const META_COMMAND = /^\\[^\s]*/;

/** A relation-form COPY statement, i.e. not `COPY (query) TO …`. */
const COPY_RELATION = /^COPY\s+(?!\()/i;

const COPY_FROM_STDIN = /\bFROM\s+stdin\b/i;

const IDENTIFIER = '(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)';

const COPY_TARGET = new RegExp(`^COPY\\s+(${IDENTIFIER}(?:\\s*\\.\\s*${IDENTIFIER})?)`, 'i');

function isWhitespace(character: string): boolean {
  return (
    character === ' ' ||
    character === '\t' ||
    character === '\n' ||
    character === '\r' ||
    character === '\f' ||
    character === '\v'
  );
}

function matchDollarQuoteDelimiter(text: string, index: number): string | null {
  DOLLAR_QUOTE.lastIndex = index;
  return DOLLAR_QUOTE.exec(text)?.[0] ?? null;
}

/**
 * `E'…'` / `e'…'` and `U&'…'` honor backslash escapes; a plain `'…'` does not. The prefix is
 * read from the characters immediately before the opening quote.
 */
function hasEscapePrefix(text: string, quoteIndex: number): boolean {
  const beforeQuote = text[quoteIndex - 1];
  if (beforeQuote === 'E' || beforeQuote === 'e') return true;
  if (beforeQuote !== '&') return false;
  const beforeAmpersand = text[quoteIndex - 2];
  return beforeAmpersand === 'U' || beforeAmpersand === 'u';
}

/** True when only spaces and tabs precede `index` on its line. */
function startsLine(text: string, index: number): boolean {
  let lineStart = index;
  while (lineStart > 0 && text[lineStart - 1] !== '\n' && text[lineStart - 1] !== '\r') {
    lineStart -= 1;
  }
  for (let cursor = lineStart; cursor < index; cursor += 1) {
    const character = text[cursor];
    if (character !== ' ' && character !== '\t') return false;
  }
  return true;
}

function metaCommandName(text: string, index: number): string {
  return META_COMMAND.exec(text.slice(index))?.[0] ?? '\\';
}

/** Index of the first line break at or after `from`, or the end of the text. */
function findLineEnd(text: string, from: number): number {
  let index = from;
  while (index < text.length && text[index] !== '\n' && text[index] !== '\r') index += 1;
  return index;
}

/** Index just past the line break starting at `index`, or `index` when there is none. */
function skipLineBreak(text: string, index: number): number {
  if (text[index] === '\n') return index + 1;
  if (text[index] === '\r') return text[index + 1] === '\n' ? index + 2 : index + 1;
  return index;
}

/** Skips whitespace, `--` comments, and nested block comments. */
function skipTrivia(text: string, from: number, to: number): number {
  let index = from;
  while (index < to) {
    const character = text[index];
    if (character === undefined) break;
    if (isWhitespace(character)) {
      index += 1;
      continue;
    }
    if (character === '-' && text[index + 1] === '-') {
      index += 2;
      while (index < to && text[index] !== '\n' && text[index] !== '\r') index += 1;
      continue;
    }
    if (character === '/' && text[index + 1] === '*') {
      let depth = 1;
      index += 2;
      while (index < to && depth > 0) {
        if (text[index] === '/' && text[index + 1] === '*') {
          depth += 1;
          index += 2;
        } else if (text[index] === '*' && text[index + 1] === '/') {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      continue;
    }
    break;
  }
  return index;
}

function isCopyFromStdin(statement: string): boolean {
  return COPY_RELATION.test(statement) && COPY_FROM_STDIN.test(statement);
}

function copyConstructName(statement: string): string {
  const target = COPY_TARGET.exec(statement)?.[1];
  return target === undefined ? 'COPY' : `COPY ${target}`;
}

/**
 * Consumes the data lines that follow a `COPY … FROM stdin;` statement, starting at `from`
 * (just past the semicolon). Only a line that is exactly `\.` after trailing spaces and tabs
 * terminates the block; `\\.` and other lookalikes are data.
 */
function consumeCopyData(text: string, from: number): CopyDataConsumption {
  // The remainder of the COPY statement's own line is never data.
  let index = skipLineBreak(text, findLineEnd(text, from));
  let dataLines = 0;

  while (index < text.length) {
    const lineEnd = findLineEnd(text, index);
    const line = text.slice(index, lineEnd).replace(/[ \t]+$/, '');
    if (line === '\\.') {
      return { endOffset: skipLineBreak(text, lineEnd), dataLines, terminated: true };
    }
    dataLines += 1;
    index = skipLineBreak(text, lineEnd);
  }

  return { endOffset: text.length, dataLines, terminated: false };
}

/**
 * Single pass over the dump text. Offsets are the only output; line/column positions are
 * computed afterwards in one pass so the scanner stays free of position bookkeeping.
 */
function scanDump(text: string): RawScan {
  const slices: RawSlice[] = [];
  const diagnostics: RawDiagnostic[] = [];

  let mode: ScanMode = 'sql';
  let blockCommentDepth = 0;
  let dollarDelimiter = '';
  let singleQuotedEscapes = false;

  let index = 0;
  let segmentStart = 0;
  let segmentHasSqlContent = false;

  const closeStatement = (endOffset: number): void => {
    if (segmentHasSqlContent) {
      const raw = text.slice(segmentStart, endOffset);
      const sql = raw.trim();
      if (sql.length > 0) {
        const startOffset = segmentStart + (raw.length - raw.trimStart().length);
        const headOffset = skipTrivia(text, startOffset, endOffset);
        const head = text.slice(headOffset, endOffset).trim();
        if (isCopyFromStdin(head)) {
          const consumption = consumeCopyData(text, endOffset);
          const lineWord = consumption.dataLines === 1 ? 'line' : 'lines';
          diagnostics.push({
            kind: 'copy',
            name: copyConstructName(head),
            offset: headOffset,
            message: consumption.terminated
              ? `consumed ${consumption.dataLines} data ${lineWord} through the terminating \\. line`
              : `unterminated COPY data block at end of input after ${consumption.dataLines} data ${lineWord}`,
          });
          index = consumption.endOffset;
        } else {
          slices.push({ startOffset, sql });
          index = endOffset;
        }
      } else {
        index = endOffset;
      }
    } else {
      index = endOffset;
    }
    segmentStart = index;
    segmentHasSqlContent = false;
  };

  while (index < text.length) {
    const character = text[index]!;

    switch (mode) {
      case 'line-comment': {
        index += 1;
        if (character === '\n' || character === '\r') mode = 'sql';
        continue;
      }
      case 'block-comment': {
        if (character === '/' && text[index + 1] === '*') {
          blockCommentDepth += 1;
          index += 2;
        } else if (character === '*' && text[index + 1] === '/') {
          blockCommentDepth -= 1;
          index += 2;
          if (blockCommentDepth === 0) mode = 'sql';
        } else {
          index += 1;
        }
        continue;
      }
      case 'single': {
        if (singleQuotedEscapes && character === '\\') {
          index += 2;
          continue;
        }
        if (character === "'") {
          if (text[index + 1] === "'") {
            index += 2;
            continue;
          }
          mode = 'sql';
        }
        index += 1;
        continue;
      }
      case 'double': {
        if (character === '"') {
          if (text[index + 1] === '"') {
            index += 2;
            continue;
          }
          mode = 'sql';
        }
        index += 1;
        continue;
      }
      case 'dollar': {
        if (text.startsWith(dollarDelimiter, index)) {
          index += dollarDelimiter.length;
          mode = 'sql';
        } else {
          index += 1;
        }
        continue;
      }
      case 'sql':
        break;
    }

    // SQL context: split on top-level semicolons, strip meta-commands, isolate COPY blocks.
    if (character === ';') {
      closeStatement(index + 1);
      continue;
    }

    if (character === '\\' && !segmentHasSqlContent && startsLine(text, index)) {
      const name = metaCommandName(text, index);
      diagnostics.push({
        kind: 'psql-meta-command',
        name,
        offset: index,
        message: 'stripped the psql meta-command line',
      });
      index = findLineEnd(text, index);
      segmentStart = index;
      segmentHasSqlContent = false;
      continue;
    }

    if (character === '-' && text[index + 1] === '-') {
      mode = 'line-comment';
      index += 2;
      continue;
    }

    if (character === '/' && text[index + 1] === '*') {
      mode = 'block-comment';
      blockCommentDepth = 1;
      index += 2;
      continue;
    }

    if (character === "'") {
      singleQuotedEscapes = hasEscapePrefix(text, index);
      mode = 'single';
      segmentHasSqlContent = true;
      index += 1;
      continue;
    }

    if (character === '"') {
      mode = 'double';
      segmentHasSqlContent = true;
      index += 1;
      continue;
    }

    if (character === '$') {
      const delimiter = matchDollarQuoteDelimiter(text, index);
      if (delimiter !== null) {
        dollarDelimiter = delimiter;
        mode = 'dollar';
        segmentHasSqlContent = true;
        index += delimiter.length;
        continue;
      }
      segmentHasSqlContent = true;
      index += 1;
      continue;
    }

    if (!isWhitespace(character)) segmentHasSqlContent = true;
    index += 1;
  }

  // A trailing statement may legitimately omit its terminating semicolon.
  closeStatement(text.length);

  return { slices, diagnostics };
}

/**
 * Maps a set of offsets to positions with one forward pass over the text. `\r\n` advances the
 * line once; an offset pointing at the `\n` of a `\r\n` pair still resolves to the line the
 * pair ends.
 */
function computePositions(text: string, offsets: readonly number[]): ReadonlyMap<number, Position> {
  const wanted = [...new Set(offsets)].sort((left, right) => left - right);
  const positions = new Map<number, Position>();

  let wantedIndex = 0;
  let index = 0;
  let line = 1;
  let lineStart = 0;

  const record = (): void => {
    while (wantedIndex < wanted.length && wanted[wantedIndex] === index) {
      positions.set(index, { offset: index, line, column: index - lineStart + 1 });
      wantedIndex += 1;
    }
  };

  while (index <= text.length) {
    record();
    if (wantedIndex === wanted.length || index === text.length) break;

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
        record();
        index += 1;
      }
      line += 1;
      lineStart = index;
      continue;
    }
    index += 1;
  }

  return positions;
}

function requirePosition(positions: ReadonlyMap<number, Position>, offset: number): Position {
  const position = positions.get(offset);
  if (position === undefined) {
    throw new Error(`internal error: no position recorded for offset ${offset}`);
  }
  return position;
}

/** Splits raw `pg_dump`-style text into parseable statements, stripping psql-level constructs. */
export function preprocessDump(text: string): PreprocessResult {
  const scan = scanDump(text);

  const offsets: number[] = [];
  for (const slice of scan.slices) {
    offsets.push(slice.startOffset, slice.startOffset + slice.sql.length);
  }
  for (const diagnostic of scan.diagnostics) {
    offsets.push(diagnostic.offset);
  }
  const positions = computePositions(text, offsets);

  return {
    statements: scan.slices.map((slice) => ({
      sql: slice.sql,
      start: requirePosition(positions, slice.startOffset),
      end: requirePosition(positions, slice.startOffset + slice.sql.length),
    })),
    diagnostics: scan.diagnostics.map((diagnostic) => ({
      kind: diagnostic.kind,
      name: diagnostic.name,
      position: requirePosition(positions, diagnostic.offset),
      message: diagnostic.message,
    })),
  };
}

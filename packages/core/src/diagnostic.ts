/**
 * Import diagnostics: what an import skipped, flagged, or failed to read.
 *
 * Every finding is named (skip-and-name): a `skip` names the statement or object that was
 * not imported, a `flag` names the imported object that lost something, and an `error`
 * reports a parse failure. Codes are stable machine labels; human wording lives in
 * `message`; `position`, when present, points at the source text.
 *
 * This module declares shapes only; it holds no behavior.
 */

/**
 * A position in a source text. Offsets count 0-based UTF-16 code units (JavaScript string
 * indices); line and column are 1-based, and a CRLF pair counts as one line break.
 */
export interface SourcePosition {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

/**
 * Stable machine-readable codes for skipped findings:
 * - `unsupported-statement` — the statement's kind is outside the imported subset;
 * - `psql-meta-command` — a psql meta-command line was stripped;
 * - `copy-data` — a `COPY … FROM stdin` statement and its data block were consumed.
 */
export type SkipDiagnosticCode = 'unsupported-statement' | 'psql-meta-command' | 'copy-data';

/**
 * Stable machine-readable codes for flagged findings:
 * - `unsupported-attribute` — part of an imported object was dropped from the model.
 */
export type FlagDiagnosticCode = 'unsupported-attribute';

/**
 * Stable machine-readable codes for error findings:
 * - `parse-failure` — the statement could not be parsed, so nothing was imported from it.
 */
export type ErrorDiagnosticCode = 'parse-failure';

/** Every diagnostic code; each belongs to exactly one diagnostic kind. */
export type DiagnosticCode = SkipDiagnosticCode | FlagDiagnosticCode | ErrorDiagnosticCode;

interface DiagnosticBase {
  /** Human-readable, factual description. */
  readonly message: string;
  /** Where the finding starts in the source text, when the source locates it. */
  readonly position?: SourcePosition;
}

/** A whole statement or object was not imported; `object` names it. */
export interface SkipDiagnostic extends DiagnosticBase {
  readonly kind: 'skip';
  readonly code: SkipDiagnosticCode;
  /** The skipped statement or object, named as the source names it, e.g. `public.users`. */
  readonly object: string;
}

/** An object was imported, but part of it was dropped; `object` names it. */
export interface FlagDiagnostic extends DiagnosticBase {
  readonly kind: 'flag';
  readonly code: FlagDiagnosticCode;
  /** The imported object that lost something, e.g. `public.users`. */
  readonly object: string;
}

/** A statement could not be parsed; the failure is reported, never thrown. */
export interface ErrorDiagnostic extends DiagnosticBase {
  readonly kind: 'error';
  readonly code: ErrorDiagnosticCode;
}

/** One import finding. `kind` distinguishes skip, flag, and error. */
export type Diagnostic = SkipDiagnostic | FlagDiagnostic | ErrorDiagnostic;
